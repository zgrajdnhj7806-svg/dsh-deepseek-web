#!/usr/bin/env node
/**
 * dsh-deepseek-web 的独立命令行：不依赖 DSH 也能验证登录、提问与行区间分析。
 *
 * 用法：
 *   node bin/dsweb.mjs --check
 *   node bin/dsweb.mjs --prompt "用一句话解释 TCP 三次握手"
 *   node bin/dsweb.mjs --file lib/pow.js --lines 30-60 --instruction "检查内存安全"
 *
 * 凭据来源优先级：--token > --credentials 文件 > 环境变量 DS_TOKEN。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekWebClient, Conversation } from '../lib/client-core.js'
import { buildLineAnalysisPrompt, readLineRange } from '../lib/analyze.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')

/** 极简参数解析：--key value 与 --flag。 */
function parseArgs(argv) {
  const out = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      out._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      index += 1
    }
  }
  return out
}

function loadCredentials(path) {
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'))
    return { token: json.token, cookie: json.cookie ?? '' }
  } catch {
    return { token: undefined, cookie: '' }
  }
}

const args = parseArgs(process.argv.slice(2))
const credentialsPath = args.credentials ?? resolve(PLUGIN_ROOT, '..', 'credentials.json')
const fromFile = loadCredentials(credentialsPath)
const token = (typeof args.token === 'string' ? args.token : undefined) ?? process.env.DS_TOKEN ?? fromFile.token
const cookie = (typeof args.cookie === 'string' ? args.cookie : undefined) ?? fromFile.cookie ?? ''
const wasmPath = args.wasm ?? resolve(PLUGIN_ROOT, 'assets', 'sha3_wasm_bg.wasm')

if (typeof token !== 'string' || token === '') {
  console.error('缺少 token：请传 --token、设置 DS_TOKEN，或准备 ' + credentialsPath)
  process.exit(2)
}

const client = new DeepSeekWebClient({ token, cookie, wasmPath, timeoutMs: 180_000 })
console.log('[dsweb] token=' + client.tokenPreview + '  wasm=' + wasmPath)

if (args.check === true) {
  const status = await client.checkLogin()
  console.log('[dsweb] ' + status.message)
  process.exit(status.ok ? 0 : 1)
}

const conversation = new Conversation(client, await client.createSession())

if (typeof args.file === 'string') {
  const match = String(args.lines ?? '').match(/^(\d+)\s*[-–~:]\s*(\d+)$/)
  const range = await readLineRange(
    resolve(args.file),
    match ? Number(match[1]) : 1,
    match ? Number(match[2]) : undefined,
  )
  const prompt = buildLineAnalysisPrompt(range, { instruction: typeof args.instruction === 'string' ? args.instruction : '' })
  const started = Date.now()
  const result = await conversation.send(prompt, { thinking: args.thinking === true, search: args.search === true })
  console.log(`[dsweb] 已分析 ${range.path} 第 ${range.startLine}-${range.endLine} 行，用时 ${Date.now() - started}ms`)
  console.log(result.content)
} else if (typeof args.prompt === 'string') {
  const result = await conversation.send(args.prompt, { thinking: args.thinking === true, search: args.search === true })
  if (result.reasoning !== '') console.log('[思考过程]\n' + result.reasoning + '\n')
  console.log(result.content)
} else {
  console.error('请给出 --check、--prompt 或 --file/--lines')
  process.exit(2)
}
