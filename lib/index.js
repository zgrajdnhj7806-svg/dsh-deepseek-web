/**
 * dsh-deepseek-web —— 把登录好的 DeepSeek 网页版（chat.deepseek.com）接进 DSH。
 *
 * 一个插件包同时提供三样东西：
 *   1. **模型工具**：`deepseek_web_ask` / `deepseek_web_analyze_lines` / `deepseek_web_status`；
 *   2. **运行时技能** `deepseek-web`：告诉模型什么时候该用行区间分析；
 *   3. **设置页登录面板**（客户端半区 lib/client.js + 这里登记的设置命名空间）。
 *
 * 实现要点：PoW 用 Node 内置 WebAssembly 直接跑官方 `sha3_wasm_bg.wasm`，
 * 登录态从「一键登录浏览器 / 手工粘贴 / 导入原 credentials.json」三条路进来，
 * 存进 DSH 凭据服务（`$DSH_HOME/.credentials.yaml`，0600），不写进 settings.yaml。
 *
 * @module dsh-deepseek-web
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config as PluginConfig, NS, PLUGIN_ID, resolveConfig } from './config.js'
import { DeepSeekWebService } from './service.js'
import { DEEPSEEK_WEB_SKILL } from './skill.js'
import { createTools } from './tools.js'
import { installRoutes } from './web.js'

/** 插件名（cordis 行名，也是客户端 bundle 的 id）。 */
export const name = 'dsh-deepseek-web'

/** 配置 schema（同时作为设置命名空间的 schema）。 */
export const Config = PluginConfig

/** 必需服务：设置、工具注册表、技能目录。（凭据服务与 web 路由按可选注入处理。） */
export const inject = ['settings', 'tools', 'skills']

/** 插件目录的绝对路径。 */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 插件入口。
 * @param {any} ctx
 * @param {Partial<ReturnType<typeof resolveConfig>>} [config]
 */
export function apply(ctx, config = {}) {
  /** @type {any} */
  let settingsScope
  const service = new DeepSeekWebService({
    ctx,
    pluginRoot: PLUGIN_ROOT,
    config: () => resolveConfig(settingsScope === undefined ? config : settingsScope.get()),
  })

  // 凭据服务是可选依赖：没有它就用插件自己的 0600 回退文件。
  ctx.inject(['credentials'], (credentialCtx) => {
    service.store.credentials = credentialCtx.credentials
  })

  settingsScope = ctx.settings.register(NS, PluginConfig, {
    base: config,
    applies: 'live',
    validate: (value) => {
      resolveConfig(value)
    },
  })

  /** 已注册能力的 disposer（开关切换时整体重挂）。 */
  let capabilityDisposers = []
  const dropCapabilities = () => {
    for (const dispose of capabilityDisposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        ctx.logger?.warn?.('deepseek-web: 注销能力失败：%s', error?.message ?? error)
      }
    }
    capabilityDisposers = []
  }

  /** 按当前设置挂载/卸载工具与技能。 */
  const syncCapabilities = () => {
    const settings = resolveConfig(settingsScope.get())
    if (!settings.enabled) {
      dropCapabilities()
      ctx.logger?.info?.('deepseek-web: 已在设置里停用，工具与技能均未注册')
      return
    }
    if (capabilityDisposers.length > 0) return
    for (const tool of createTools(service)) {
      capabilityDisposers.push(ctx.tools.register(tool))
    }
    capabilityDisposers.push(ctx.skills.register(DEEPSEEK_WEB_SKILL))
    ctx.logger?.info?.(
      'deepseek-web: 已注册 3 个工具与技能 %s（数据目录 %s）',
      DEEPSEEK_WEB_SKILL.name,
      service.store.filePath,
    )
  }

  installRoutes(ctx, service, {
    get: () => resolveConfig(settingsScope.get()),
    update: (patch) => settingsScope.update(patch),
  })

  const unwatch = settingsScope.watch(() => {
    dropCapabilities()
    syncCapabilities()
  })

  syncCapabilities()

  return () => {
    unwatch?.()
    dropCapabilities()
  }
}