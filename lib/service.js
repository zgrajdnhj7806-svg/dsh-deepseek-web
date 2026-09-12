/**
 * 插件业务层：把「配置 + 登录凭据 + 网页端客户端 + 会话池」缝在一起，
 * 供工具层（tools.js）与设置页（web.js）共用。
 *
 * @module dsh-deepseek-web/service
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Conversation, ConversationPool, DeepSeekWebClient, DeepSeekWebError } from './client-core.js'
import { buildLineAnalysisPrompt, readLineRange } from './analyze.js'
import { captureTokenViaBrowser, findBrowser, LoginError } from './login.js'
import { CredentialStore, previewToken } from './state.js'

/** 登录态缺失时的统一错误。 */
export class NotLoggedInError extends DeepSeekWebError {
  constructor(message = '尚未登录 DeepSeek 网页版：请在 DSH 设置 → DeepSeek 网页版 里完成登录') {
    super(message, { kind: 'auth' })
    this.name = 'NotLoggedInError'
  }
}

/** 业务服务。 */
export class DeepSeekWebService {
  /**
   * @param {{ctx: any, pluginRoot: string, config: () => any}} options
   */
  constructor({ ctx, pluginRoot, config }) {
    this.ctx = ctx
    this.pluginRoot = pluginRoot
    this.readConfig = config
    this.store = new CredentialStore({ ctx, pluginRoot, config })
    /** @type {DeepSeekWebClient | undefined} */
    this.activeClient = undefined
    /** @type {ConversationPool | undefined} */
    this.activePool = undefined
    /** 最近一次一键登录的进度文本（设置页轮询展示）。 */
    this.loginProgress = ''
    /** 一键登录状态：idle | running | done | error。 */
    this.loginState = 'idle'
  }

  /** 当前生效配置。 */
  get config() {
    return this.readConfig()
  }

  /** PoW WASM 的绝对路径。 */
  wasmPath() {
    const configured = this.config.wasmPath
    const path = configured === '' ? join(this.pluginRoot, 'assets', 'sha3_wasm_bg.wasm') : configured
    // 支持 .wasm 或同路径 .wasm.b64（PowSolver 里会做 base64 解码）。
    if (!existsSync(path) && !existsSync(`${path}.b64`)) {
      throw new DeepSeekWebError(`找不到 PoW WASM 文件：${path}（请在设置里修正 wasmPath）`, { kind: 'pow' })
    }
    return path
  }

  /**
   * 取得可用的网页端客户端；没有登录态就抛 {@link NotLoggedInError}。
   * token 变化时自动重建客户端。
   */
  async client() {
    const credentials = await this.store.load()
    if (typeof credentials.token !== 'string' || credentials.token === '') throw new NotLoggedInError()
    const current = this.activeClient
    if (current !== undefined && current.token === credentials.token && current.cookie === (credentials.cookie ?? '')) {
      return current
    }
    this.activeClient = new DeepSeekWebClient({
      token: credentials.token,
      cookie: credentials.cookie ?? '',
      wasmPath: this.wasmPath(),
      timeoutMs: this.config.timeoutMs,
    })
    // 客户端换了，旧会话池里的会话 id 仍然有效，但为避免混淆直接重置。
    this.activePool = undefined
    return this.activeClient
  }

  /** 会话池（按 key 复用网页端会话，保留多轮上下文）。 */
  async pool() {
    const client = await this.client()
    if (this.activePool === undefined || this.activePool.client !== client) {
      this.activePool = new ConversationPool(client, { limit: this.config.conversationsPerSession })
    }
    return this.activePool
  }

  /**
   * 取一个会话。key 建议用「DSH 会话 id + 标签」，同一次 DSH 对话里
   * 多次调用会落到同一个网页端会话，模型自然拥有多轮上下文。
   */
  async conversation(key, options = {}) {
    const pool = await this.pool()
    return pool.acquire(key, options)
  }

  /**
   * 问一句。
   * @param {string} prompt
   * @param {{key?: string, thinking?: boolean, search?: boolean, fresh?: boolean, system?: string}} [options]
   */
  async ask(prompt, options = {}) {
    const config = this.config
    const thinking = options.thinking ?? config.defaultThinking
    const search = options.search ?? config.defaultSearch
    const conversation = await this.conversation(options.key ?? 'default', { fresh: options.fresh === true })
    const text = options.system === undefined || options.system.trim() === ''
      ? prompt
      : `${options.system.trim()}\n\n${prompt}`
    const result = await conversation.send(text, { thinking, search })
    return { ...result, sessionId: conversation.sessionId, thinking, search }
  }

  /**
   * 读文件的行区间，交给网页端模型分析。
   *
   * 这就是「从第 xx 行看到 xx 行分析」的实现。
   */
  async analyzeLines(options) {
    const config = this.config
    const range = await readLineRange(options.path, options.startLine, options.endLine, {
      maxChars: options.maxChars ?? config.maxChars,
    })
    if (range.endLine - range.startLine + 1 > config.maxLines && options.allowLarge !== true) {
      throw new DeepSeekWebError(
        `区间有 ${range.endLine - range.startLine + 1} 行，超过 maxLines=${config.maxLines}；`
        + '请缩小 start_line/end_line，或在设置里调大 maxLines',
        { kind: 'protocol' },
      )
    }
    const prompt = buildLineAnalysisPrompt(range, {
      instruction: options.instruction,
      focus: options.focus,
      extra: options.extra,
    })
    const result = await this.ask(prompt, {
      key: options.key ?? `lines:${range.path}`,
      thinking: options.thinking,
      search: options.search,
      fresh: options.fresh,
    })
    return { ...result, range }
  }

  /** 设置页要展示的状态。 */
  async status() {
    const storeStatus = await this.store.status()
    const wasmPath = (() => {
      try {
        return { ok: true, path: this.wasmPath() }
      } catch (error) {
        return { ok: false, path: '', message: error.message }
      }
    })()
    return {
      ...storeStatus,
      wasmOk: wasmPath.ok,
      wasmPath: wasmPath.path,
      wasmMessage: wasmPath.ok ? '' : wasmPath.message,
      browserPath: findBrowser(this.config.browserPath) ?? '',
      autoLogin: this.config.autoLogin,
      loginState: this.loginState,
      loginProgress: this.loginProgress,
      routePrefix: '/_dsh/deepseek-web',
    }
  }

  /** 校验登录态（顺带返回账号 id）。 */
  async checkLogin() {
    try {
      const client = await this.client()
      return await client.checkLogin()
    } catch (error) {
      return { ok: false, message: error.message }
    }
  }

  /**
   * 后台启动一键登录，立即返回。
   *
   * 登录要等用户在浏览器里操作，可能几分钟；占着一个 HTTP 请求不合适，
   * 所以这里开后台任务，设置页轮询 status 看 loginState / loginProgress。
   */
  startBrowserLogin(options = {}) {
    if (this.loginState === 'running') return { started: false, message: '已经在等待浏览器登录' }
    this.loginState = 'running'
    this.loginProgress = '正在启动浏览器…'
    this.loginTask = this.loginViaBrowser(options)
      .then((result) => {
        this.loginState = 'done'
        this.loginProgress = result.message
      })
      .catch((error) => {
        this.loginState = 'error'
        this.loginProgress = error?.message ?? String(error)
      })
    return { started: true, message: this.loginProgress }
  }

  /** 把 token/cookie 存起来（手工粘贴路径）。 */
  async saveManual(token, cookie = '') {
    const trimmed = (token ?? '').trim()
    if (trimmed === '') throw new DeepSeekWebError('token 不能为空', { kind: 'auth' })
    const saved = await this.store.save(trimmed, (cookie ?? '').trim())
    this.activeClient = undefined
    this.activePool = undefined
    this.loginState = 'done'
    this.loginProgress = `已保存手工填写的登录态（${previewToken(trimmed)}）`
    return saved
  }

  /** 清除登录态。 */
  async logout() {
    await this.store.clear()
    this.activeClient = undefined
    this.activePool = undefined
    this.loginState = 'idle'
    this.loginProgress = '已清除登录态'
  }

  /** 从原 python 项目的 credentials.json 导入。 */
  async importLegacy() {
    const result = await this.store.importLegacy()
    this.loginState = result.ok ? 'done' : 'error'
    this.loginProgress = result.message
    if (result.ok) {
      this.activeClient = undefined
      this.activePool = undefined
    }
    return result
  }

  /**
   * 一键登录：拉起本机浏览器，等用户登录后抓取 token/cookie。
   * @param {{timeoutMs?: number, headless?: boolean}} [options]
   */
  async loginViaBrowser(options = {}) {
    if (!this.config.autoLogin) {
      throw new LoginError('设置里关闭了「允许一键登录」，请打开或改为手工粘贴 token')
    }
    const profileDir = join(this.store.filePath, '..', 'browser_profile')
    try {
      const result = await captureTokenViaBrowser({
        browserPath: this.config.browserPath,
        profileDir,
        timeoutMs: options.timeoutMs ?? this.config.loginTimeoutMs,
        headless: options.headless === true,
        onProgress: (message) => {
          this.loginProgress = message
          this.ctx?.logger?.info?.('deepseek-web 登录：%s', message)
        },
      })
      await this.store.save(result.token, result.cookie)
      this.activeClient = undefined
      this.activePool = undefined
      this.loginProgress = '登录成功，已保存 token 与 cookie'
      return { ok: true, message: this.loginProgress, tokenPreview: previewToken(result.token) }
    } finally {
      setTimeout(() => {
        this.loginProgress = ''
      }, 30_000)
    }
  }
}
