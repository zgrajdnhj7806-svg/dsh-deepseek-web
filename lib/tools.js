/**
 * 模型可调用的工具。
 *
 * 约定（按 DSH 的 defineTool 契约）：
 *   • parameters 用**逐属性的 `required: true`**，不写 JSON-Schema 的 required 数组；
 *   • 对象节点必须显式声明 `additionalProperties`；
 *   • output.render 是纯函数，只负责把规范值投影成模型可读文本；
 *   • execute 开头调用 `exec.signal.throwIfAborted()`。
 *
 * @module dsh-deepseek-web/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/** 纯文本投影辅助。 */
function textRender(fn) {
  return (_args, value) => [{ type: 'text', text: fn(value) }]
}

/** 把失败信息补成可操作的提示。 */
function describeFailure(error) {
  const message = error?.message ?? String(error)
  if (error?.kind === 'auth') {
    return `${message}\n（打开 DSH 设置 → DeepSeek 网页版 → 完成登录后重试）`
  }
  return message
}

/** 由调用方 agent 的会话 id 生成网页端会话 key。 */
function conversationKey(exec, label) {
  const sessionId = exec?.agent?.session?.id ?? 'anonymous'
  return `${sessionId}::${label ?? 'default'}`
}

/**
 * 构造全部工具定义。
 * @param {import('./service.js').DeepSeekWebService} service
 */
export function createTools(service) {
  const askTool = defineTool({
    name: 'deepseek_web_ask',
    description:
      'Ask the logged-in DeepSeek Web (chat.deepseek.com) account a question and get its answer. '
      + 'This is a SECOND model reached over the web UI, not the local DSH model: use it when the user explicitly asks for '
      + '"DeepSeek 网页版"/"官网模型" answers, wants a second opinion, or wants a DeepSeek-R1 style reasoning pass. '
      + 'Supports 深度思考 (thinking) and 联网搜索 (search). Multi-turn context is kept per DSH conversation unless fresh=true. '
      + 'Slow (typically 5–60s) and serialized — prefer the normal DSH model for routine work.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The question or instruction to send.' },
      thinking: { type: 'boolean', description: 'Enable DeepSeek 深度思考 (R1-style reasoning). Defaults to the plugin setting.' },
      search: { type: 'boolean', description: 'Enable 联网搜索 (web search grounding). Defaults to the plugin setting.' },
      fresh: { type: 'boolean', description: 'Start a brand-new DeepSeek web conversation instead of continuing this one.' },
      label: { type: 'string', description: 'Conversation label; different labels keep separate DeepSeek web conversations.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', required: true, description: 'The DeepSeek web reply text.' },
          reasoning: { type: 'string', required: true, description: 'The 思考过程 text, empty when thinking was off.' },
          sessionId: { type: 'string', required: true, description: 'DeepSeek web conversation id used for this turn.' },
          thinking: { type: 'boolean', required: true, description: 'Whether 深度思考 was on.' },
          search: { type: 'boolean', required: true, description: 'Whether 联网搜索 was on.' },
        },
      },
      render: textRender((value) => {
        const head = `DeepSeek 网页版回复（会话 ${value.sessionId}${value.thinking ? '，深度思考' : ''}${value.search ? '，联网搜索' : ''}）：`
        return value.reasoning === '' ? `${head}\n${value.answer}` : `${head}\n${value.answer}\n\n【思考过程】\n${value.reasoning}`
      }),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      try {
        const result = await service.ask(args.prompt, {
          key: conversationKey(exec, args.label),
          thinking: args.thinking,
          search: args.search,
          fresh: args.fresh,
        })
        return {
          answer: result.content,
          reasoning: result.reasoning,
          sessionId: result.sessionId,
          thinking: result.thinking,
          search: result.search,
        }
      } catch (error) {
        throw new Error(describeFailure(error), { cause: error })
      }
    },
  })

  const analyzeTool = defineTool({
    name: 'deepseek_web_analyze_lines',
    description:
      'Read lines START–END of a file and have the DeepSeek Web account analyze exactly that range. '
      + 'Use it for "从第 xx 行看到 xx 行分析" requests, for reviewing a specific function/hunk with a second model, '
      + 'or when the user wants the 网页版 model to comment on a code excerpt. The excerpt is sent with line numbers, '
      + 'so the answer can cite concrete line numbers. Large ranges are refused — split them.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the file to read.' },
      start_line: { type: 'integer', required: true, description: 'First line to include (1-based, inclusive).' },
      end_line: { type: 'integer', description: 'Last line to include (1-based, inclusive). Omit to read to the end of the file.' },
      instruction: { type: 'string', description: 'Extra requirement for this analysis (takes priority, e.g. "只关注并发安全").' },
      focus: { type: 'string', description: 'Aspect to pay extra attention to (e.g. "错误处理", "性能").' },
      thinking: { type: 'boolean', description: 'Enable 深度思考 for a deeper review.' },
      fresh: { type: 'boolean', description: 'Do not reuse this conversation\'s DeepSeek web context.' },
      label: { type: 'string', description: 'Conversation label; different labels keep separate DeepSeek web conversations.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', required: true, description: 'The analysis text.' },
          reasoning: { type: 'string', required: true, description: 'The 思考过程 text, empty when thinking was off.' },
          path: { type: 'string', required: true, description: 'The file that was analyzed.' },
          startLine: { type: 'integer', required: true, description: 'First line actually sent.' },
          endLine: { type: 'integer', required: true, description: 'Last line actually sent.' },
          totalLines: { type: 'integer', required: true, description: 'Total line count of the file.' },
          truncated: { type: 'boolean', required: true, description: 'Whether the excerpt was cut by the character budget.' },
          sessionId: { type: 'string', required: true, description: 'DeepSeek web conversation id used for this turn.' },
        },
      },
      render: textRender((value) => {
        const head = `DeepSeek 网页版对 ${value.path} 第 ${value.startLine}–${value.endLine} 行（共 ${value.totalLines} 行）的分析`
          + `${value.truncated ? '（区间已按字符上限截断）' : ''}：`
        return `${head}\n${value.answer}`
      }),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      try {
        const result = await service.analyzeLines({
          path: args.path,
          startLine: args.start_line,
          endLine: args.end_line,
          instruction: args.instruction,
          focus: args.focus,
          thinking: args.thinking,
          fresh: args.fresh,
          key: conversationKey(exec, args.label ?? 'lines'),
        })
        return {
          answer: result.content,
          reasoning: result.reasoning,
          path: result.range.path,
          startLine: result.range.startLine,
          endLine: result.range.endLine,
          totalLines: result.range.totalLines,
          truncated: result.range.truncated,
          sessionId: result.sessionId,
        }
      } catch (error) {
        throw new Error(describeFailure(error), { cause: error })
      }
    },
  })

  const statusTool = defineTool({
    name: 'deepseek_web_status',
    description:
      'Check the DeepSeek Web plugin login state (whether a token is stored, which account, which storage backend). '
      + 'Call it before deepseek_web_ask / deepseek_web_analyze_lines when the user may not be logged in, '
      + 'or to tell the user exactly where to log in when a call failed with an auth error.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          loggedIn: { type: 'boolean', required: true, description: 'Whether a token is stored.' },
          tokenPreview: { type: 'string', required: true, description: 'Masked token preview.' },
          source: { type: 'string', required: true, description: 'Where the credentials came from.' },
          message: { type: 'string', required: true, description: 'Human-readable summary.' },
          dataDir: { type: 'string', required: true, description: 'Plugin data directory holding the fallback credential file.' },
          legacyAvailable: { type: 'boolean', required: true, description: 'Whether the legacy python credentials.json can be imported.' },
          userId: { type: 'string', required: true, description: 'DeepSeek account id when the token was verified, empty otherwise.' },
        },
      },
      render: textRender((value) => value.message),
    },
    execute: async (_args, exec) => {
      exec.signal.throwIfAborted()
      const status = await service.status()
      if (!status.loggedIn) {
        return {
          loggedIn: false,
          tokenPreview: '',
          source: status.source,
          message:
            '尚未登录 DeepSeek 网页版。请在 DSH 设置 → DeepSeek 网页版 中点击「一键登录（打开 Edge）」，'
            + `或粘贴浏览器里的 token；也可以从 ${status.legacyPath} 导入。`,
          dataDir: status.dataDir,
          legacyAvailable: status.legacyAvailable,
          userId: '',
        }
      }
      const check = await service.checkLogin()
      return {
        loggedIn: true,
        tokenPreview: status.tokenPreview,
        source: status.source,
        message: check.ok
          ? `已登录 DeepSeek 网页版（${status.tokenPreview}，凭据来源：${status.source}）`
          : `已保存 token（${status.tokenPreview}）但校验失败：${check.message}`,
        dataDir: status.dataDir,
        legacyAvailable: status.legacyAvailable,
        userId: check.userId ?? '',
      }
    },
  })

  return [askTool, analyzeTool, statusTool]
}
