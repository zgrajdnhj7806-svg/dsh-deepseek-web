/**
 * DeepSeek 网页端 PoW（工作量证明）解题器 —— 纯 Node 实现。
 *
 * 与项目里 python 版 pow_solver.py 等价，但用 Node 内置的 WebAssembly
 * 直接实例化官方 `sha3_wasm_bg.wasm`，因此 **不需要 wasmtime / Python**。
 *
 * 流程：
 *   1. POST /api/v0/chat/create_pow_challenge 拿到 challenge
 *   2. 用 WASM 暴力算出 answer
 *   3. 组装 {algorithm,challenge,salt,answer,signature,target_path} 并 base64
 *
 * 关键约定（踩坑记录）：
 *   • 前缀必须是 `salt + "_" + expire_at + "_"`，结尾的下划线不能少；
 *   • `wasm_solve` 把结果写进 retptr：+0 为 i32 状态，+8 为 f64 答案；
 *     状态 0 表示无解/失败，非 0 才是成功。
 *
 * @module dsh-deepseek-web/pow
 */
import { readFileSync } from 'node:fs'

/** 官方 WASM 文件名（DeepSeekHashV1）。 */
export const WASM_FILE_NAME = 'sha3_wasm_bg.wasm'

/** PoW 求解失败（挑战过期或 WASM 异常）。 */
export class PowError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'PowError'
  }
}

/**
 * 加载一个 WASM 解题器实例。
 *
 * WASM 模块没有任何 import，可以直接用空 imports 实例化。
 * 实例内部持有可增长的内存，因此每次读取都要重新取 `memory.buffer`。
 */
export class PowSolver {
  #memory
  #solve
  #malloc
  #stack

  /**
   * @param {string} wasmPath - `sha3_wasm_bg.wasm` 的绝对路径。
   * 找不到 `.wasm` 时自动尝试同路径的 `.wasm.b64`（base64 文本，便于在
   * 只能传输文本的仓库/渠道里分发官方 WASM）。
   */
  constructor(wasmPath) {
    let bytes
    try {
      bytes = readFileSync(wasmPath)
    } catch {
      try {
        const text = readFileSync(`${wasmPath}.b64`, 'utf8')
        bytes = Buffer.from(text.replace(/\s+/g, ''), 'base64')
      } catch (error) {
        throw new PowError(`无法读取 PoW WASM：${wasmPath}（${error.message}）`, { cause: error })
      }
    }
    let exports
    try {
      const module = new WebAssembly.Module(bytes)
      exports = new WebAssembly.Instance(module, {}).exports
    } catch (error) {
      throw new PowError(`PoW WASM 实例化失败：${error.message}`, { cause: error })
    }
    for (const key of ['memory', 'wasm_solve', '__wbindgen_export_0', '__wbindgen_add_to_stack_pointer']) {
      if (exports[key] === undefined) {
        throw new PowError(`PoW WASM 缺少导出 ${key}，文件可能不是官方版本`)
      }
    }
    this.#memory = exports.memory
    this.#solve = exports.wasm_solve
    this.#malloc = exports.__wbindgen_export_0
    this.#stack = exports.__wbindgen_add_to_stack_pointer
  }

  /** 把 UTF-8 字符串写进 WASM 线性内存，返回 [指针, 字节长度]。 */
  #write(text) {
    const data = Buffer.from(text, 'utf8')
    const ptr = this.#malloc(data.length, 1)
    // malloc 可能触发内存增长，buffer 必须重新获取。
    new Uint8Array(this.#memory.buffer).set(data, ptr)
    return [ptr, data.length]
  }

  /**
   * 求解一次挑战。
   * @returns {number|null} 整数答案；null 表示无解（通常挑战已过期）。
   */
  solve(challenge, prefix, difficulty) {
    const retptr = this.#stack(-16)
    try {
      const [challengePtr, challengeLen] = this.#write(challenge)
      const [prefixPtr, prefixLen] = this.#write(prefix)
      this.#solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)
      const view = new DataView(this.#memory.buffer)
      const status = view.getInt32(retptr, true)
      if (status === 0) return null
      return Math.trunc(view.getFloat64(retptr + 8, true))
    } finally {
      this.#stack(16)
    }
  }

  /**
   * 把挑战对象解成可直接放进 `x-ds-pow-response` 头的 base64 值。
   * @param {Record<string, unknown>} challenge - create_pow_challenge 返回的挑战体。
   */
  makeHeader(challenge) {
    const prefix = `${challenge.salt}_${challenge.expire_at}_`
    const answer = this.solve(challenge.challenge, prefix, challenge.difficulty)
    if (answer === null) {
      throw new PowError('PoW 未解出答案（挑战可能已过期）')
    }
    const payload = {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path,
    }
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  }
}

/** 按 wasm 路径缓存解题器：WASM 编译一次即可反复使用。 */
const cache = new Map()

/**
 * 取得（并缓存）一个解题器实例。
 * @param {string} wasmPath
 * @returns {PowSolver}
 */
export function getSolver(wasmPath) {
  let solver = cache.get(wasmPath)
  if (solver === undefined) {
    solver = new PowSolver(wasmPath)
    cache.set(wasmPath, solver)
  }
  return solver
}