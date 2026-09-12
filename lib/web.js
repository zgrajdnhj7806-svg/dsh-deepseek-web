/**
 * 宿主侧的 HTTP 路由：设置页（浏览器半边）通过同源 fetch 调这些接口。
 *
 * 约定照抄官方风格：
 *   • 路由挂在 `/_dsh/deepseek-web/<action>`（prefix 路由，占用独立命名空间）；
 *   • 响应统一信封 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`；
 *   • webServer 本身**不做任何鉴权**，所以这里自己做同源围栏
 *     （拒绝跨站，比对 Origin 与 Host），这是防 DNS-rebinding / CSRF，不是身份认证。
 *
 * @module dsh-deepseek-web/web
 */
import { ROUTE_PREFIX } from './config.js'

/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024

/** 允许通过设置页写入的字段（全部非密）。 */
const WRITABLE_SETTINGS = new Set([
  'enabled', 'autoLogin', 'browserPath', 'loginTimeoutMs', 'credentialsPath',
  'wasmPath', 'defaultThinking', 'defaultSearch', 'timeoutMs', 'maxLines', 'maxChars',
  'conversationsPerSession',
])

/** 写一个 JSON 响应。 */
function writeJson(res, status, payload) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.byteLength),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  })
  res.end(bytes)
}

const ok = (res, value) => writeJson(res, 200, { ok: true, value })
const fail = (res, status, code, message) => writeJson(res, status, { ok: false, error: { code, message } })

/**
 * 同源围栏：浏览器自动带的 Host / Origin / Sec-Fetch-Site 足以挡住跨站调用。
 */
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return site === 'same-origin' || site === 'same-site' || site === 'none'
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/** 读 JSON 请求体（带字节上限）。 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new RangeError('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** 只保留允许写入的字段。 */
function pickSettings(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('patch 必须是对象')
  }
  const out = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!WRITABLE_SETTINGS.has(key)) throw new TypeError(`不允许从界面修改的设置项：${key}`)
    out[key] = value
  }
  if (Object.keys(out).length === 0) throw new TypeError('patch 是空的')
  return out
}

/**
 * 挂载路由。
 *
 * @param {any} ctx 宿主插件上下文
 * @param {import('./service.js').DeepSeekWebService} service
 * @param {{get: () => any, update: (patch: object) => Promise<void>}} settingsScope
 */
export function installRoutes(ctx, service, settingsScope) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (!sameOrigin(req)) {
          fail(res, 403, 'forbidden', '只接受同源请求')
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\//, '').replace(/\/$/, '')
        const method = (req.method ?? 'GET').toUpperCase()

        try {
          if (action === 'status' && method === 'GET') {
            ok(res, { ...(await service.status()), settings: settingsScope.get() })
            return
          }
          if (action === 'login' && method === 'POST') {
            const body = await readJson(req)
            const mode = body.mode ?? 'browser'
            if (mode === 'browser') {
              ok(res, service.startBrowserLogin({ timeoutMs: body.timeoutMs }))
              return
            }
            if (mode === 'manual') {
              await service.saveManual(body.token, body.cookie)
              ok(res, { started: false, message: service.loginProgress })
              return
            }
            if (mode === 'import') {
              const result = await service.importLegacy()
              ok(res, { started: false, message: result.message })
              return
            }
            fail(res, 400, 'bad-request', `未知的登录方式：${mode}`)
            return
          }
          if (action === 'logout' && method === 'POST') {
            await service.logout()
            ok(res, { message: service.loginProgress })
            return
          }
          if (action === 'test' && method === 'POST') {
            const body = await readJson(req)
            const prompt = typeof body.prompt === 'string' && body.prompt.trim() !== ''
              ? body.prompt.trim()
              : '只回复两个字：可用'
            const result = await service.ask(prompt, { key: 'settings-test', fresh: true, thinking: false, search: false })
            ok(res, { answer: result.content, sessionId: result.sessionId })
            return
          }
          if (action === 'settings' && method === 'POST') {
            const body = await readJson(req)
            const patch = pickSettings(body.patch)
            await settingsScope.update(patch)
            ok(res, { settings: settingsScope.get() })
            return
          }
          fail(res, 404, 'not-found', `未知接口：${method} ${action}`)
        } catch (error) {
          if (error instanceof RangeError) {
            fail(res, 413, 'too-large', error.message)
            return
          }
          if (error instanceof SyntaxError || error instanceof TypeError) {
            fail(res, 400, 'bad-request', error.message)
            return
          }
          webCtx.logger?.warn?.('deepseek-web: 接口 %s 失败：%s', action, error?.message ?? error)
          fail(res, 500, 'server-error', error?.message ?? String(error))
        }
      },
    }), 'dsh-deepseek-web: HTTP routes')
  })
}
