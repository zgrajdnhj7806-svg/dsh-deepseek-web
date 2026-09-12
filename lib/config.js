/**
 * 插件配置：DSH 设置命名空间 `deepseek-web` 的 schema 与默认值。
 *
 * 这里只放**非密**配置。token/cookie 属于登录凭据，走
 * `@deepseek-ai/dsh-credentials`（`$DSH_HOME/.credentials.yaml`，0600），
 * 或者插件自己的 0600 回退文件，绝不进 settings.yaml。
 *
 * @module dsh-deepseek-web/config
 */
import z from '@deepseek-ai/schemastery'

/** 设置命名空间（只允许小写与连字符，会作为 settings.yaml 的顶层键）。 */
export const NS = 'deepseek-web'

/** 插件 id：同时用作 cordis 行 id 与 HTTP 路由前缀。 */
export const PLUGIN_ID = 'deepseek-web'

/** HTTP 路由前缀。 */
export const ROUTE_PREFIX = '/_dsh/deepseek-web'

/** 凭据记录键：`<owner>/<id>`，两段都必须匹配 /^[a-z][a-z0-9-]*$/。 */
export const CREDENTIAL_KEY = 'deepseek-web/login'

/** 单次请求附带代码文本的默认上限（字符）。 */
export const DEFAULT_MAX_CHARS = 60_000

/** 单次分析允许的最大行数。 */
export const DEFAULT_MAX_LINES = 400

/** 设置 schema。 */
export const Config = z.object({
  /** 总开关：关掉后不注册任何工具（设置页仍可用，便于修好再打开）。 */
  enabled: z.boolean().default(true),
  /** 允许「一键登录」拉起本机浏览器抓取登录态。 */
  autoLogin: z.boolean().default(true),
  /** 浏览器可执行文件路径；留空自动探测 Edge / Chrome。 */
  browserPath: z.string().default(''),
  /** 等待用户在浏览器里完成登录的最长时间（毫秒）。 */
  loginTimeoutMs: z.number().min(10_000).max(30 * 60_000).default(5 * 60_000),
  /**
   * 兼容导入用的 `credentials.json` 路径（原 python 项目的登录缓存）。
   * 留空则使用插件目录同级的 `../credentials.json`。
   */
  credentialsPath: z.string().default(''),
  /** PoW WASM 路径；留空用插件内置的 assets/sha3_wasm_bg.wasm。 */
  wasmPath: z.string().default(''),
  /** 默认是否开启「深度思考」。 */
  defaultThinking: z.boolean().default(false),
  /** 默认是否开启「联网搜索」。 */
  defaultSearch: z.boolean().default(false),
  /** 单次网页端请求超时（毫秒）。 */
  timeoutMs: z.number().min(5_000).max(30 * 60_000).default(180_000),
  /** 行区间分析一次最多读取多少行。 */
  maxLines: z.number().min(1).max(20_000).default(DEFAULT_MAX_LINES),
  /** 行区间分析一次最多附带多少字符。 */
  maxChars: z.number().min(1_000).max(2_000_000).default(DEFAULT_MAX_CHARS),
  /** 每个 DSH 会话最多缓存多少个网页端会话。 */
  conversationsPerSession: z.number().min(1).max(64).default(4),
})

/**
 * 把 loader 校验后的配置补齐成确定的形状（直接调用方绕过 loader 时也安全）。
 * @param {Partial<z.infer<typeof Config>>} [config]
 */
export function resolveConfig(config = {}) {
  return {
    enabled: config.enabled ?? true,
    autoLogin: config.autoLogin ?? true,
    browserPath: (config.browserPath ?? '').trim(),
    loginTimeoutMs: config.loginTimeoutMs ?? 5 * 60_000,
    credentialsPath: (config.credentialsPath ?? '').trim(),
    wasmPath: (config.wasmPath ?? '').trim(),
    defaultThinking: config.defaultThinking ?? false,
    defaultSearch: config.defaultSearch ?? false,
    timeoutMs: config.timeoutMs ?? 180_000,
    maxLines: config.maxLines ?? DEFAULT_MAX_LINES,
    maxChars: config.maxChars ?? DEFAULT_MAX_CHARS,
    conversationsPerSession: config.conversationsPerSession ?? 4,
  }
}