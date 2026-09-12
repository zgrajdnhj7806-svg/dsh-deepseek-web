/**
 * 「一键登录」：拉起本机 Edge，用 CDP 读取 chat.deepseek.com 的登录态。
 *
 * 等价于项目里 python 版 auth_auto.py 的做法（Playwright + 持久化 profile），
 * 但这里只用 Node 内置能力实现，不需要 Python / Playwright：
 *   • `--remote-debugging-port=0` 让 Edge 自己挑端口，端口号写在
 *     `<user-data-dir>/DevToolsActivePort` 的第一行；
 *   • 用全局 WebSocket 连 CDP（Node 22 自带），Runtime.evaluate 读
 *     `localStorage.userToken`，Network.getCookies 读 cookie；
 *   • 登录态存在专用的 user-data-dir 里，下次直接复用，不用反复登录。
 *
 * @module dsh-deepseek-web/login
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const SITE = 'https://chat.deepseek.com/'

/** 常见的 Edge 安装位置。 */
export const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]

/** 找一个可用的 Chromium 系浏览器。 */
export function findBrowser(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return existsSync(explicit.trim()) ? explicit.trim() : undefined
  }
  return EDGE_CANDIDATES.find((candidate) => existsSync(candidate))
}

/** 登录流程失败。 */
export class LoginError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'LoginError'
  }
}

/** 极简 CDP 连接：id 对应 Promise + 可选 sessionId（flatten 模式）。 */
class Cdp {
  #socket
  #nextId = 1
  #pending = new Map()

  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl)
    const cdp = new Cdp(socket)
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = (event) => { cleanup(); reject(new LoginError(`CDP 连接失败：${event?.message ?? 'unknown'}`)) }
      const cleanup = () => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
      }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
    })
    return cdp
  }

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (message.id === undefined) return
      const entry = this.#pending.get(message.id)
      if (entry === undefined) return
      this.#pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new LoginError(`CDP ${entry.method} 失败：${message.error.message}`))
      else entry.resolve(message.result)
    })
  }

  /** 发一条 CDP 命令。 */
  send(method, params = {}, sessionId) {
    const id = this.#nextId++
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      this.#socket.send(JSON.stringify(payload))
    })
  }

  close() {
    try {
      this.#socket.close()
    } catch {
      /* 忽略 */
    }
  }
}

/** 等待文件出现并返回其内容（Edge 启动后会写 DevToolsActivePort）。 */
async function waitForDevToolsPort(profileDir, deadline) {
  const file = join(profileDir, 'DevToolsActivePort')
  for (;;) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim()
      const port = Number.parseInt(text.split(/\r?\n/)[0] ?? '', 10)
      if (Number.isFinite(port) && port > 0) return port
    }
    if (Date.now() > deadline) throw new LoginError('浏览器没有在预期时间内开启调试端口')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * 读出一个仍在监听的调试端口，没有则返回 undefined。
 *
 * 同一个 user-data-dir 上如果已经有浏览器实例在跑，再启动一次只会把 URL
 * 转发给旧实例（不会重写 DevToolsActivePort），所以必须先探测复用。
 */
async function probeExistingPort(profileDir) {
  try {
    const text = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8').trim()
    const port = Number.parseInt(text.split(/\r?\n/)[0] ?? '', 10)
    if (!Number.isFinite(port) || port <= 0) return undefined
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return undefined
    await response.json()
    return port
  } catch {
    return undefined
  }
}

/** 在页面里读取 userToken（真实 JWT 是 localStorage.userToken.value）。 */
const READ_TOKEN_EXPRESSION =
  "(() => { try { const raw = localStorage.getItem('userToken');"
  + ' if (!raw) return null; const parsed = JSON.parse(raw);'
  + " return (parsed && parsed.value) ? parsed.value : null; } catch (e) { return null; } })()"

/**
 * 拉起浏览器让用户登录，然后抓取 token 与 cookie。
 *
 * @param {{browserPath?: string, profileDir: string, timeoutMs?: number, headless?: boolean,
 *   onProgress?: (message: string) => void}} options
 * @returns {Promise<{token: string, cookie: string, profileDir: string}>}
 */
export async function captureTokenViaBrowser(options) {
  const { timeoutMs = 5 * 60_000, headless = false, onProgress } = options
  // Edge 会把相对的 --user-data-dir 解析到自己的目录，必须绝对化。
  const profileDir = isAbsolute(options.profileDir) ? options.profileDir : resolve(options.profileDir)
  const report = typeof onProgress === 'function' ? onProgress : () => {}
  const browserPath = findBrowser(options.browserPath)
  if (browserPath === undefined) {
    throw new LoginError('找不到 Edge/Chrome，请在设置里手动填写浏览器路径，或直接粘贴 token')
  }
  await mkdir(profileDir, { recursive: true })

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    SITE,
  ]
  if (headless) args.unshift('--headless=new')

  const deadline = Date.now() + timeoutMs
  let child
  let cdp
  let browserSession
  try {
    let port = await probeExistingPort(profileDir)
    if (port === undefined) {
      report(`正在启动浏览器：${browserPath}`)
      child = spawn(browserPath, args, { stdio: 'ignore', windowsHide: false })
      port = await waitForDevToolsPort(profileDir, Math.min(deadline, Date.now() + 30_000))
    } else {
      report('复用上一次已经打开的登录窗口。')
    }
    const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`)
    const version = await versionResponse.json()
    cdp = await Cdp.connect(version.webSocketDebuggerUrl)

    // 找到 chat.deepseek.com 的页面目标，没有就自己开一个。
    let targetId
    const { targetInfos } = await cdp.send('Target.getTargets')
    const page = targetInfos?.find((info) => info.type === 'page' && String(info.url).includes('chat.deepseek.com'))
    if (page !== undefined) targetId = page.targetId
    else {
      const created = await cdp.send('Target.createTarget', { url: SITE })
      targetId = created.targetId
    }
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const sessionId = attached.sessionId
    browserSession = sessionId

    report('请在打开的浏览器窗口里完成 DeepSeek 登录（含验证码/2FA），登录成功后会自动继续。')
    for (;;) {
      const evaluated = await cdp.send(
        'Runtime.evaluate',
        { expression: READ_TOKEN_EXPRESSION, returnByValue: true },
        sessionId,
      )
      const token = evaluated?.result?.value
      if (typeof token === 'string' && token !== '') {
        const cookies = await cdp.send(
          'Network.getCookies',
          { urls: ['https://chat.deepseek.com'] },
          sessionId,
        ).catch(() => ({ cookies: [] }))
        const cookie = (cookies.cookies ?? [])
          .map((item) => `${item.name}=${item.value}`)
          .join('; ')
        report('已自动获取 token 与 cookie。')
        return { token, cookie, profileDir }
      }
      if (Date.now() > deadline) throw new LoginError('等待登录超时，请重试或手动粘贴 token')
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  } finally {
    // 关闭浏览器：先走 CDP 优雅关闭，再兜底 kill。
    try {
      if (cdp !== undefined) {
        await cdp.send('Browser.close').catch(() => {})
        cdp.close()
      }
    } catch {
      /* 忽略 */
    }
    void browserSession
    // Windows 上 child.kill() 只结束启动器进程，Chromium 的子进程会留下来占住
    // user-data-dir；必须整棵树结束（taskkill /T）。
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const pid = child.pid
      setTimeout(() => {
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
          else child.kill('SIGKILL')
        } catch {
          /* 忽略 */
        }
      }, 1500)
    }
  }
}