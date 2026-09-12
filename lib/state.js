/**
 * 登录凭据的存取。
 *
 * 三级来源，优先级从高到低：
 *   1. DSH 凭据服务 `ctx.credentials` 的 `deepseek-web/login` 记录
 *      → 存在 `$DSH_HOME/.credentials.yaml`（目录 0700 / 文件 0600）；
 *   2. 插件自己的回退文件 `$DSH_HOME/cache/dsh-deepseek-web/credentials.json`
 *      （没有凭据服务、或凭据服务写入被拒时使用，同样 0600）；
 *   3. 只读导入：原 python 项目的 `credentials.json`（用于首次迁移）。
 *
 * token/cookie 永远不写进 settings.yaml，也不出现在任何发往浏览器的响应里
 * （对外只给 `tokenPreview` 与布尔状态）。
 *
 * @module dsh-deepseek-web/state
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { CREDENTIAL_KEY } from './config.js'

/** 插件在 DSH_HOME 下的数据目录（相对 DSH_HOME）。 */
export const DATA_SUBDIR = join('cache', 'dsh-deepseek-web')

/**
 * 解析 DSH_HOME：显式配置 > 环境变量 > `~/.dsh`。
 * @param {string} [configured]
 */
export function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return resolve(env.trim())
  return join(homedir(), '.dsh')
}

/** 插件数据目录的绝对路径。 */
export function pluginDataDir(dshHome) {
  return join(resolveDshHome(dshHome), DATA_SUBDIR)
}

/** 把 token 变成可以安全展示的摘要。 */
export function previewToken(token) {
  if (typeof token !== 'string' || token === '') return ''
  return token.length <= 12 ? '****' : `${token.slice(0, 6)}…${token.slice(-4)}`
}

/** 读写凭据：DSH 凭据服务优先，插件文件兜底。 */
export class CredentialStore {
  /**
   * @param {{ctx: any, pluginRoot: string, config: () => any}} options
   */
  constructor({ ctx, pluginRoot, config }) {
    this.ctx = ctx
    this.pluginRoot = pluginRoot
    this.readConfig = config
    /**
     * 由插件在 `ctx.inject(['credentials'], …)` 里填入；服务不存在时保持 undefined，
     * 走插件自己的 0600 回退文件。
     * @type {any}
     */
    this.credentials = undefined
    /** @type {{token?: string, cookie?: string, source?: string} | undefined} */
    this.cached = undefined
  }

  /** 回退凭据文件路径。 */
  get filePath() {
    return join(pluginDataDir(this.readConfig().dshHome), 'credentials.json')
  }

  /** 原 python 项目的 credentials.json（迁移导入用）。 */
  get legacyPath() {
    const configured = this.readConfig().credentialsPath
    if (configured !== '') return isAbsolute(configured) ? configured : resolve(configured)
    return resolve(this.pluginRoot, '..', 'credentials.json')
  }

  /** 凭据服务可用吗。 */
  get hasService() {
    return this.credentials !== undefined && typeof this.credentials.readRecord === 'function'
  }

  /** 从 DSH 凭据服务读取。 */
  async #readService() {
    if (!this.hasService) return undefined
    try {
      const record = await this.credentials.readRecord(CREDENTIAL_KEY)
      const payload = record?.payload
      if (record?.kind === 'grant' && typeof payload?.token === 'string' && payload.token !== '') {
        return { token: payload.token, cookie: typeof payload.cookie === 'string' ? payload.cookie : '' }
      }
    } catch (error) {
      this.ctx?.logger?.warn?.('deepseek-web: 读取凭据记录失败：%s', error.message)
    }
    return undefined
  }

  /** 写入 DSH 凭据服务；返回是否成功。 */
  async #writeService(token, cookie) {
    if (!this.hasService || typeof this.credentials.modifyRecord !== 'function') return false
    try {
      await this.credentials.modifyRecord(CREDENTIAL_KEY, async () => ({
        kind: 'grant',
        payload: { token, cookie },
      }))
      return true
    } catch (error) {
      this.ctx?.logger?.warn?.('deepseek-web: 写入凭据记录失败（改用插件文件）：%s', error.message)
      return false
    }
  }

  /** 读取并校验一个凭据文件。 */
  async #readCredentialsFile(path, label) {
    if (!existsSync(path)) return undefined
    try {
      const json = JSON.parse(await readFile(path, 'utf8'))
      if (typeof json?.token === 'string' && json.token !== '') {
        return { token: json.token, cookie: typeof json.cookie === 'string' ? json.cookie : '' }
      }
    } catch (error) {
      this.ctx?.logger?.warn?.('deepseek-web: %s 无法解析：%s', label, error.message)
    }
    return undefined
  }

  /** 从插件文件读取。 */
  #readFile() {
    return this.#readCredentialsFile(this.filePath, '凭据回退文件')
  }

  /** 从原 python 项目的 credentials.json 读取（只读导入源）。 */
  #readLegacy() {
    return this.#readCredentialsFile(this.legacyPath, 'legacy credentials.json')
  }

  /** 写插件文件（0600）。 */
  async #writeFile(token, cookie) {
    const path = this.filePath
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify({ token, cookie }, null, 2), { encoding: 'utf8', mode: 0o600 })
    await chmod(path, 0o600).catch(() => {})
  }

  /**
   * 取当前凭据。
   * @param {{refresh?: boolean}} [options]
   * @returns {Promise<{token?: string, cookie?: string, source?: string}>}
   */
  async load(options = {}) {
    if (!options.refresh && this.cached !== undefined) return this.cached
    const service = await this.#readService()
    if (service !== undefined) {
      this.cached = { ...service, source: 'credentials-service' }
      return this.cached
    }
    const file = await this.#readFile()
    if (file !== undefined) {
      this.cached = { ...file, source: 'plugin-file' }
      return this.cached
    }
    // 首次使用：原来 python 项目的 credentials.json 直接可用，省掉一次手工迁移。
    const legacy = await this.#readLegacy()
    if (legacy !== undefined) {
      this.cached = { ...legacy, source: 'legacy-file' }
      return this.cached
    }
    this.cached = { source: 'none' }
    return this.cached
  }

  /** 保存登录态（同时更新缓存）。 */
  async save(token, cookie = '') {
    const stored = await this.#writeService(token, cookie)
    await this.#writeFile(token, cookie)
    this.cached = { token, cookie, source: stored ? 'credentials-service' : 'plugin-file' }
    return this.cached
  }

  /** 清除登录态。 */
  async clear() {
    if (this.hasService && typeof this.credentials.deleteRecord === 'function') {
      await this.credentials.deleteRecord(CREDENTIAL_KEY).catch(() => {})
    }
    const path = this.filePath
    if (existsSync(path)) await writeFile(path, JSON.stringify({ token: '', cookie: '' }, null, 2), 'utf8').catch(() => {})
    this.cached = { source: 'none' }
  }

  /** 从原 python 项目导入（只在当前没有任何登录态时启用）。 */
  async importLegacy() {
    const path = this.legacyPath
    if (!existsSync(path)) {
      return { ok: false, message: `没有找到可导入的凭据文件：${path}` }
    }
    const parsed = await this.#readLegacy()
    if (parsed === undefined) {
      return { ok: false, message: `${path} 无法解析，或里面没有 token 字段` }
    }
    await this.save(parsed.token, parsed.cookie)
    return { ok: true, message: `已从 ${path} 导入登录态` }
  }

  /** 对外状态摘要（绝不包含 token/cookie 明文）。 */
  async status() {
    const credentials = await this.load()
    const config = this.readConfig()
    return {
      loggedIn: typeof credentials.token === 'string' && credentials.token !== '',
      tokenPreview: previewToken(credentials.token),
      cookieConfigured: typeof credentials.cookie === 'string' && credentials.cookie !== '',
      source: credentials.source ?? 'none',
      credentialKey: CREDENTIAL_KEY,
      dataDir: pluginDataDir(config.dshHome),
      legacyPath: this.legacyPath,
      legacyAvailable: existsSync(this.legacyPath),
      credentialsService: this.hasService,
    }
  }
}
