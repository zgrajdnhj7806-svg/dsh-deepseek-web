/**
 * 宿主半区集成自测：用假的 cordis ctx 跑通 apply()，验证
 *   • 工具 / 技能 / 设置命名空间 / HTTP 路由都注册上了；
 *   • 真实登录态能从原 credentials.json 导入；
 *   • deepseek_web_analyze_lines 能真的把「第 xx–xx 行」发给网页端并拿回分析；
 *   • 路由的同源围栏与错误信封生效。
 *
 * 用法：node _selftest.mjs
 */
import { resolve } from 'node:path'
import { apply, Config } from './lib/index.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === '' ? '' : '  → ' + detail))
}

// ---------- 假的 cordis ctx ----------
const tools = []
const skills = []
const routes = []
const effects = []
let scope
const logger = {
  info: (f, ...a) => console.log('  [info] ' + f, ...a.map(x => typeof x === 'string' ? x : JSON.stringify(x))),
  warn: (f, ...a) => console.log('  [warn] ' + f, ...a),
  error: (f, ...a) => console.log('  [error] ' + f, ...a),
}
const credentialsService = {
  records: new Map(),
  async readRecord(key) { return this.records.get(key) },
  async modifyRecord(key, fn) { const next = await fn(this.records.get(key)); this.records.set(key, next); return next },
  async deleteRecord(key) { this.records.delete(key) },
}
const webServer = { register: (route) => { routes.push(route); return () => {} } }
const settings = {
  register(ns, schema, options) {
    let user = {}
    const value = () => ({ ...schema(options?.base ?? {}), ...user })
    scope = {
      ns, get: value, update: async (patch) => { user = { ...user, ...patch } }, replace: async (next) => { user = next },
      watch: () => () => {},
    }
    return scope
  },
}
const baseCtx = {
  logger,
  settings,
  tools: { register: (tool) => { tools.push(tool); return () => {} } },
  skills: { register: (skill) => { skills.push(skill); return () => {} } },
  webServer,
  credentials: credentialsService,
  inject: (deps, cb) => {
    const extra = {}
    for (const dep of deps) extra[dep] = baseCtx[dep]
    cb({ ...baseCtx, ...extra, effect: (fn) => { const d = fn(); effects.push(d); return () => {} } })
  },
}

// ---------- A. 挂载 ----------
apply(baseCtx, { credentialsPath: resolve('..', 'credentials.json') })
check('注册了 3 个模型工具', tools.length === 3, tools.map(t => t.name).join(', '))
check('工具名符合预期', ['deepseek_web_ask', 'deepseek_web_analyze_lines', 'deepseek_web_status']
  .every(n => tools.some(t => t.name === n)))
check('注册了运行时技能 deepseek-web', skills.length === 1 && skills[0].name === 'deepseek-web', skills[0]?.source)
check('设置了设置命名空间', scope?.ns === 'deepseek-web')
check('注册了 HTTP 路由', routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/_dsh/deepseek-web')

// ---------- B. 登录态导入 ----------
const statusTool = tools.find(t => t.name === 'deepseek_web_status')
const exec = { signal: new AbortController().signal, agent: { session: { id: 'selftest' } } }
const importStatus = await statusTool.execute({}, exec)
check('从 credentials.json 读到登录态', importStatus.loggedIn === true, importStatus.message.slice(0, 90))

// ---------- C. HTTP 路由 ----------
function makeRes() {
  const chunks = []
  return {
    statusCode: 0, headers: {},
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    end(buf) { if (buf !== undefined) chunks.push(Buffer.from(buf)) },
    text() { return Buffer.concat(chunks).toString('utf8') },
  }
}
function makeReq(method, url, headers = {}, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method, url, headers,
    async *[Symbol.asyncIterator]() { if (payload !== '') yield Buffer.from(payload, 'utf8') },
  }
}
const handler = routes[0].handler
const sameOrigin = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }

const resStatus = makeRes()
await handler(makeReq('GET', '/_dsh/deepseek-web/status', sameOrigin), resStatus)
const statusBody = JSON.parse(resStatus.text())
check('GET status 返回 ok 信封', resStatus.statusCode === 200 && statusBody.ok === true,
  'loggedIn=' + statusBody.value?.loggedIn + ' wasmOk=' + statusBody.value?.wasmOk)
check('status 不回传 token 明文', /[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}/.test(JSON.stringify(statusBody)) === false)

const resCross = makeRes()
await handler(makeReq('GET', '/_dsh/deepseek-web/status', { ...sameOrigin, 'sec-fetch-site': 'cross-site' }), resCross)
check('跨站请求被 403 拒绝', resCross.statusCode === 403)

const resBad = makeRes()
await handler(makeReq('POST', '/_dsh/deepseek-web/settings', sameOrigin, { patch: { token: 'x' } }), resBad)
check('拒绝写入未知/敏感设置项', resBad.statusCode === 400, JSON.parse(resBad.text()).error?.message)

const resGood = makeRes()
await handler(makeReq('POST', '/_dsh/deepseek-web/settings', sameOrigin, { patch: { defaultThinking: true, maxLines: 123 } }), resGood)
const goodBody = JSON.parse(resGood.text())
check('可写入允许的设置项', resGood.statusCode === 200 && goodBody.value.settings.maxLines === 123)

// ---------- D. 真实行区间分析 ----------
const analyzeTool = tools.find(t => t.name === 'deepseek_web_analyze_lines')
const started = Date.now()
try {
  const analysis = await analyzeTool.execute({
    path: resolve('lib', 'pow.js'), start_line: 30, end_line: 52,
    instruction: '只指出与 WASM 内存安全相关的点，最多 5 条',
  }, exec)
  check('deepseek_web_analyze_lines 真实调用成功', typeof analysis.answer === 'string' && analysis.answer.length > 50,
    `${analysis.path.split('\\').pop()} 第 ${analysis.startLine}-${analysis.endLine}/${analysis.totalLines} 行，${Date.now() - started}ms`)
  console.log('\n--- 网页端对该区间的分析（节选）---\n' + analysis.answer.slice(0, 500) + '\n--- 结束 ---\n')
} catch (error) {
  check('deepseek_web_analyze_lines 真实调用成功', false, error.message)
}

const failed = results.filter(r => !r.ok)
console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length === 0 ? 0 : 1)
