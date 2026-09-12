/**
 * DeepSeek 网页端（chat.deepseek.com）客户端核心 —— 纯 Node 实现。
 *
 * 复刻浏览器真实请求：
 *   • 每次 /api/v0/chat/completion 之前先取 PoW 挑战并计算 x-ds-pow-response；
 *   • SSE 是 JSON-Patch 风格：整块 v.response.fragments + 裸 {"v":"token"} 增量
 *     + p/o/v 补丁，FINISHED 是状态哨兵需要过滤；
 *   • 首条消息省略 parent_message_id，之后用流里给出的 response_message_id 当父消息。
 *
 * 本模块不依赖 DSH，可单独用 `node bin/dsweb.mjs` 测试。
 *
 * @module dsh-deepseek-web/client-core
 */
import { getSolver } from './pow.js'

/** 网页端站点根。 */
export const BASE = 'https://chat.deepseek.com'
/** v0 版 API 前缀。 */
export const API = BASE + '/api/v0'
/** 与浏览器一致的 UA（网页端会校验 x-client-* 头，UA 保持一致最稳）。 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'

/** 与浏览器一致的静态请求头。 */
export const STATIC_HEADERS = {
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'content-type': 'application/json',
  origin: BASE,
  referer: BASE + '/',
  'user-agent': USER_AGENT,
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-locale': 'zh_CN',
  'x-client-platform': 'web',
  'x-client-timezone-offset': '28800',
  'x-client-version': '2.3.0',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
}

/** 客户端错误，带可判定的 kind，便于上层给出可操作的提示。 */
export class DeepSeekWebError extends Error {
  /**
   * @param {string} message
   * @param {{kind?: 'auth'|'pow'|'network'|'protocol'|'server', status?: number, cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DeepSeekWebError'
    this.kind = options.kind ?? 'server'
    this.status = options.status
  }
}

/** 从各种嵌套形状里取出挑战对象。 */
function pickChallenge(json) {
  const data = json?.data ?? {}
  const node = data?.biz_data ?? data
  return node?.challenge ?? node
}

/** 在嵌套结构里找第一个字符串型 id（会话创建接口的返回形状不稳定）。 */
function deepFindId(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindId(item)
      if (found) return found
    }
    return undefined
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'id' && typeof item === 'string') return item
      const found = deepFindId(item)
      if (found) return found
    }
  }
  return undefined
}

/** 把上游错误体压成一句话。 */
function describeBody(text) {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return ''
  try {
    const json = JSON.parse(trimmed)
    const message = json?.error?.message ?? json?.msg ?? json?.message ?? json?.data?.biz_msg
    if (typeof message === 'string' && message !== '') return message
  } catch {
    /* 非 JSON，直接用原文 */
  }
  return trimmed.slice(0, 300)
}

/**
 * 一个 DeepSeek 网页端会话客户端。
 *
 * @example
 * const client = new DeepSeekWebClient({ token, cookie, wasmPath })
 * const sessionId = await client.createSession()
 * const { content } = await client.ask(sessionId, '你好')
 */
export class DeepSeekWebClient {
  /**
   * @param {{token: string, cookie?: string, wasmPath: string, timeoutMs?: number}} options
   */
  constructor({ token, cookie = '', wasmPath, timeoutMs = 180_000 }) {
    if (typeof token !== 'string' || token.trim() === '') {
      throw new DeepSeekWebError('缺少 DeepSeek 网页端 token（请在设置里登录或粘贴）', { kind: 'auth' })
    }
    this.token = token.trim()
    this.cookie = (cookie ?? '').trim()
    this.wasmPath = wasmPath
    this.timeoutMs = timeoutMs
    /** 最近一次流式回复给出的 response_message_id（下一轮的 parent）。 */
    this.lastResponseId = undefined
  }

  /** token 摘要，用于界面展示（永不回显完整 token）。 */
  get tokenPreview() {
    const token = this.token
    return token.length <= 12 ? '****' : `${token.slice(0, 6)}…${token.slice(-4)}`
  }

  /** 组装请求头。 */
  #headers(extra = {}) {
    const headers = { ...STATIC_HEADERS, authorization: `Bearer ${this.token}`, ...extra }
    if (this.cookie !== '') headers.cookie = this.cookie
    return headers
  }

  /**
   * 发一个 JSON 请求并返回解析后的响应体。
   * @param {string} path
   * @param {{method?: string, body?: unknown, headers?: Record<string,string>, accept?: string}} options
   */
  async #request(path, options = {}) {
    const { method = 'POST', body, headers = {}, accept } = options
    const url = path.startsWith('http') ? path : API + path
    let response
    try {
      response = await fetch(url, {
        method,
        headers: this.#headers(accept === undefined ? headers : { ...headers, accept }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? `请求超时（${this.timeoutMs}ms）` : error.message
      throw new DeepSeekWebError(`请求 ${path} 失败：${reason}`, { kind: 'network', cause: error })
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const detail = describeBody(text)
      const kind = response.status === 401 || response.status === 403 ? 'auth' : 'server'
      const hint = kind === 'auth' ? '（token 可能已过期，请在 DSH 设置里重新登录 DeepSeek 网页版）' : ''
      throw new DeepSeekWebError(
        `${path} 返回 HTTP ${response.status}${detail === '' ? '' : `：${detail}`}${hint}`,
        { kind, status: response.status },
      )
    }
    const text = await response.text()
    if (text.trim() === '') return {}
    try {
      return JSON.parse(text)
    } catch (error) {
      const hint = text.trimStart().startsWith('<')
        ? '（返回的是网页 HTML，说明该接口路径已失效或登录态被当成游客）'
        : ''
      throw new DeepSeekWebError(`${path} 返回了非 JSON 响应${hint}：${text.slice(0, 200)}`, { kind: 'protocol', cause: error })
    }
  }

  /** 取一次 PoW 挑战并算出 `x-ds-pow-response` 头。 */
  async createPowHeader() {
    const json = await this.#request('/chat/create_pow_challenge', {
      body: { target_path: '/api/v0/chat/completion' },
    })
    const challenge = pickChallenge(json)
    if (challenge?.challenge === undefined) {
      throw new DeepSeekWebError('取 PoW 挑战失败：响应里没有 challenge 字段', { kind: 'protocol' })
    }
    try {
      return getSolver(this.wasmPath).makeHeader(challenge)
    } catch (error) {
      throw new DeepSeekWebError(error.message, { kind: 'pow', cause: error })
    }
  }

  /**
   * 读取当前登录用户。
   *
   * 注意：旧的 `/chat_session/list` 已下线（现在返回 SPA 的 HTML），
   * 校验登录态改用 `GET /api/v0/users/current`。
   */
  async currentUser() {
    const json = await this.#request('/users/current', { method: 'GET' })
    return json?.data?.biz_data ?? json?.data ?? json
  }

  /**
   * 校验登录态：能读到用户资料即视为 token 有效。
   * @returns {Promise<{ok: boolean, userId?: string, message: string}>}
   */
  async checkLogin() {
    try {
      const user = await this.currentUser()
      const userId = typeof user?.id === 'string' ? user.id : undefined
      return { ok: true, userId, message: `登录有效（账号 ${userId ?? '未知'}）` }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  }

  /** 新建会话，返回会话 id。 */
  async createSession(title = '') {
    const json = await this.#request('/chat_session/create', { body: { title } })
    const id =
      json?.data?.biz_data?.chat_session?.id
      ?? json?.data?.chat_session?.id
      ?? json?.data?.id
      ?? deepFindId(json)
    if (typeof id !== 'string' || id === '') {
      throw new DeepSeekWebError('新建会话失败：响应里找不到会话 id', { kind: 'protocol' })
    }
    return id
  }

  /** 拉取会话历史消息数组。 */
  async historyMessages(sessionId) {
    const json = await this.#request(`/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`, { method: 'GET' })
    const data = json?.data
    if (data !== null && typeof data === 'object' && Array.isArray(data.messages)) return data.messages
    return Array.isArray(json?.messages) ? json.messages : []
  }

  /** 历史里最后一条 assistant 消息的整数 id（parent 兜底）。 */
  async lastAssistantId(sessionId, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const messages = await this.historyMessages(sessionId)
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'assistant') return messages[index]?.id
      }
    }
    return undefined
  }

  /**
   * 发送一条消息并流式产出增量。
   *
   * @param {string} sessionId
   * @param {string} prompt
   * @param {{parentMessageId?: number|string, thinking?: boolean, search?: boolean}} [options]
   * @yields {['content'|'reasoning', string]}
   */
  async *streamMessage(sessionId, prompt, options = {}) {
    const { parentMessageId = 0, thinking = false, search = false } = options
    const body = {
      chat_session_id: sessionId,
      prompt,
      ref_size: 8,
      ref_file_ids: [],
      thinking_enabled: Boolean(thinking),
      search_enabled: Boolean(search),
      need_depth_search: false,
      language: 'zh-CN',
    }
    const parent = Number.parseInt(String(parentMessageId ?? 0), 10)
    if (Number.isFinite(parent) && parent > 0) body.parent_message_id = parent

    let response
    try {
      response = await fetch(API + '/chat/completion', {
        method: 'POST',
        headers: this.#headers({
          accept: 'text/event-stream',
          'x-ds-pow-response': await this.createPowHeader(),
        }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      if (error instanceof DeepSeekWebError) throw error
      const reason = error?.name === 'TimeoutError' ? `请求超时（${this.timeoutMs}ms）` : error.message
      throw new DeepSeekWebError(`发送消息失败：${reason}`, { kind: 'network', cause: error })
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const detail = describeBody(text)
      const kind = response.status === 401 || response.status === 403 ? 'auth' : 'server'
      throw new DeepSeekWebError(
        `chat/completion 返回 HTTP ${response.status}${detail === '' ? '' : `：${detail}`}`,
        { kind, status: response.status },
      )
    }
    if (response.body === null) {
      throw new DeepSeekWebError('chat/completion 没有返回流式响应体', { kind: 'protocol' })
    }

    // ── SSE 解析 ──────────────────────────────────────────────────────────
    //
    // 真实帧结构（抓包确认）：
    //   1) {"request_message_id":1,"response_message_id":2}      本轮消息 id
    //   2) {"v":{"response":{…,"fragments":[{id:2,type:"THINK",content:"前缀"}]}}}
    //      整块快照：fragments 里每个片段的 content 是**前缀**，后续增量接着往后拼；
    //   3) {"p":"response/fragments/-1/content","o":"APPEND","v":"片"}   增量（-1=当前片段）
    //   4) {"v":"段"}                                              裸增量 token，同样属于当前片段
    //   5) {"p":"response/fragments","o":"APPEND","v":[{id:3,"type":"RESPONSE",content:"堆"}]}
    //      **新片段诞生** —— 思考切正文就是靠这一帧，之前的内容归 THINK，之后的归 RESPONSE
    //   6) {"p":"response","o":"BATCH",…} / {"p":"response/status","o":"SET","v":"FINISHED"}
    //
    // 频道判定必须靠片段 type：只看增量本身无法区分思考与正文（早期实现就是在这里把
    // 思考当成正文吐给模型的）。
    const decoder = new TextDecoder()
    let buffer = ''
    /** @type {Map<string, string>} 片段 id → 类型 */
    const fragmentTypes = new Map()
    /** 当前正在追加的片段 id。 */
    let currentId
    const contentParts = []
    const reasoningParts = []
    let yielded = false

    /** 记录一个片段，并把它的初始 content 发出去（它是前缀，不是重复内容）。 */
    const registerFragment = (fragment) => {
      if (fragment === null || typeof fragment !== 'object') return []
      const id = String(fragment.id)
      const type = typeof fragment.type === 'string' ? fragment.type : 'RESPONSE'
      fragmentTypes.set(id, type)
      currentId = id
      const out = []
      if (typeof fragment.content === 'string' && fragment.content !== '') {
        out.push([type === 'THINK' ? 'reasoning' : 'content', fragment.content])
      }
      return out
    }

    /** 某个片段的频道；id 为 -1 或未知时退回「当前片段」的类型。 */
    const channelOf = (id) => {
      const type = fragmentTypes.get(String(id)) ?? fragmentTypes.get(String(currentId))
      return type === 'THINK' ? 'reasoning' : 'content'
    }

    /** 处理一行 SSE，返回该行产生的增量列表。 */
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return []
      const raw = line.slice(5).trim()
      if (raw === '' || raw === '[DONE]') return []
      let obj
      try {
        obj = JSON.parse(raw)
      } catch {
        return []
      }
      const out = []
      if (typeof obj.response_message_id !== 'undefined' && typeof obj.request_message_id !== 'undefined') {
        this.lastResponseId = obj.response_message_id
      }
      const patchPath = typeof obj.p === 'string' ? obj.p : undefined
      // BATCH：把内部的片段类补丁展开处理，其它字段（用量、状态）忽略。
      if (patchPath === 'response' && Array.isArray(obj.v)) {
        for (const entry of obj.v) {
          if (entry !== null && typeof entry === 'object' && typeof entry.p === 'string'
            && entry.p.startsWith('response/fragments')) {
            out.push(...handleLine('data: ' + JSON.stringify(entry)))
          }
        }
        return out
      }
      // 新片段：{"p":"response/fragments","v":[{...}]}
      if (patchPath === 'response/fragments' && Array.isArray(obj.v)) {
        for (const fragment of obj.v) out.push(...registerFragment(fragment))
        return out
      }
      // 片段字段补丁：{"p":"response/fragments/<id>/<field>","v":…}
      if (patchPath !== undefined && patchPath.startsWith('response/fragments/')) {
        const segments = patchPath.split('/')
        const id = segments[2] ?? '-1'
        const field = segments[3] ?? ''
        if (field === 'content' && typeof obj.v === 'string') {
          if (id !== '-1') currentId = id
          out.push([channelOf(id), obj.v])
        }
        return out
      }
      const value = obj.v
      // 整块快照：{"v":{"response":{…fragments…}}}
      if (value !== null && typeof value === 'object' && value.response !== undefined) {
        const inner = value.response
        if (inner.message_id !== undefined) this.lastResponseId = inner.message_id
        for (const fragment of inner.fragments ?? []) out.push(...registerFragment(fragment))
        return out
      }
      // 裸增量 token：属于当前片段（FINISHED 是状态哨兵）。
      if (typeof value === 'string' && value !== 'FINISHED') {
        out.push([channelOf(currentId), value])
      }
      return out
    }

    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          for (const [kind, text] of handleLine(line)) {
            if (text === '') continue
            if (kind === 'content') contentParts.push(text)
            else reasoningParts.push(text)
            yielded = true
            yield [kind, text]
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    // 兜底：内容以整块形式一次性到达时可能一条增量都没有。
    if (!yielded) {
      if (contentParts.length > 0) yield ['content', contentParts.join('')]
      if (reasoningParts.length > 0) yield ['reasoning', reasoningParts.join('')]
    }
  }

  /**
   * 发送一条消息并收集完整回复。
   * @returns {Promise<{content: string, reasoning: string, responseMessageId: number|undefined}>}
   */
  async ask(sessionId, prompt, options = {}) {
    const content = []
    const reasoning = []
    const onDelta = options.onDelta
    for await (const [kind, text] of this.streamMessage(sessionId, prompt, options)) {
      if (kind === 'content') content.push(text)
      else reasoning.push(text)
      if (typeof onDelta === 'function') onDelta(kind, text)
    }
    let finalContent = content.join('')
    let finalReasoning = reasoning.join('')
    // 流里没拿到正文（少见：正文整块落在历史里而没走增量）时，回历史里捞一次。
    if (finalContent.trim() === '') {
      const salvaged = await this.#salvageFromHistory(sessionId)
      if (salvaged !== undefined) {
        finalContent = salvaged.content
        finalReasoning = finalReasoning === '' ? salvaged.reasoning : finalReasoning
      }
    }
    return {
      content: finalContent,
      reasoning: finalReasoning,
      responseMessageId: toIntId(this.lastResponseId),
    }
  }

  /**
   * 从历史里取最后一条 assistant 消息，按片段类型拆成正文与思考。
   * 历史是最终态、增量流是过程态，两边结构一致（THINK / RESPONSE 片段）。
   * @returns {Promise<{content: string, reasoning: string} | undefined>}
   */
  async #salvageFromHistory(sessionId, attempts = 3, delayMs = 600) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const messages = await this.historyMessages(sessionId)
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          if (message?.role !== 'assistant') continue
          const fragments = message.fragments ?? []
          const content = fragments.filter((f) => f?.type !== 'THINK').map((f) => String(f?.content ?? '')).join('')
          const reasoning = fragments.filter((f) => f?.type === 'THINK').map((f) => String(f?.content ?? '')).join('')
          if (content !== '') return { content, reasoning }
          break
        }
      } catch {
        /* 历史不可用就放弃兜底 */
      }
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    return undefined
  }
}

/** 把任意 id 表示转成整数（网页端 parent_message_id 需要整数）。 */
export function toIntId(value) {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0
  const text = String(value)
  return /^\d+$/.test(text) ? Number.parseInt(text, 10) : 0
}

/**
 * 一条多轮对话：自动维护 parent_message_id。
 */
export class Conversation {
  /**
   * @param {DeepSeekWebClient} client
   * @param {string} sessionId
   */
  constructor(client, sessionId) {
    this.client = client
    this.sessionId = sessionId
    this.parentMessageId = 0
  }

  /**
   * 发一条消息并推进 parent 指针。
   * @returns {Promise<{content: string, reasoning: string}>}
   */
  async send(prompt, options = {}) {
    const result = await this.client.ask(this.sessionId, prompt, {
      ...options,
      parentMessageId: this.parentMessageId,
    })
    let next = toIntId(this.client.lastResponseId)
    if (next === 0) next = toIntId(await this.client.lastAssistantId(this.sessionId))
    this.parentMessageId = next
    return result
  }
}

/**
 * 按 key 复用网页端会话的多轮对话池。
 *
 * DSH 侧用「DSH 会话 id + 可选标签」当 key，这样同一次对话里的多次工具调用
 * 会落到同一个 DeepSeek 网页端会话，模型自然拥有多轮上下文。
 */
export class ConversationPool {
  /**
   * @param {DeepSeekWebClient} client
   * @param {{limit?: number}} [options]
   */
  constructor(client, options = {}) {
    this.client = client
    this.limit = options.limit ?? 16
    /** @type {Map<string, {conversation: Conversation, usedAt: number}>} */
    this.entries = new Map()
  }

  /** 取得（必要时新建）某个 key 的会话。 */
  async acquire(key, options = {}) {
    if (options.fresh === true) await this.drop(key)
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      existing.usedAt = Date.now()
      return existing.conversation
    }
    const sessionId = await this.client.createSession()
    const conversation = new Conversation(this.client, sessionId)
    this.entries.set(key, { conversation, usedAt: Date.now() })
    this.evict()
    return conversation
  }

  /** 丢弃某个 key 的会话（下次会新建）。 */
  async drop(key) {
    this.entries.delete(key)
  }

  /** 只保留最近使用的若干个会话。 */
  evict() {
    if (this.entries.size <= this.limit) return
    const ordered = [...this.entries.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [key] of ordered.slice(0, this.entries.size - this.limit)) this.entries.delete(key)
  }

  /** 当前池中的会话摘要。 */
  describe() {
    return [...this.entries.entries()].map(([key, entry]) => ({
      key,
      sessionId: entry.conversation.sessionId,
      parentMessageId: entry.conversation.parentMessageId,
      usedAt: entry.usedAt,
    }))
  }
}
