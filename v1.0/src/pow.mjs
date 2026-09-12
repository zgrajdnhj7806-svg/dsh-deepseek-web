// pow.mjs · DeepSeek 网页端 PoW 解题器（纯 Node，运行官方 sha3_wasm_bg.wasm，无需 wasmtime/Python）
//
// 官方 wasm 导出：
//   memory, wasm_deepseek_hash_v1, wasm_solve,
//   __wbindgen_add_to_stack_pointer, __wbindgen_export_0(malloc),
//   __wbindgen_export_1, __wbindgen_export_2
// 无外部导入，可直接 WebAssembly.instantiate(bytes, {})。
//
// wasm_solve(retptr, challenge_ptr, challenge_len, prefix_ptr, prefix_len, difficulty:f64)
//   结果写在 retptr：i32 status @+0（!=0 成功），f64 answer(整数) @+8

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// wasm 本体查找顺序：本目录二进制 → 本目录 .b64 文本 → 仓库共享资产 assets/（两种形式）
// 官方 wasm 只有 26KB，二进制与 base64 文本效力相同；都没找到则明确报错，不静默降级。
const WASM_CANDIDATES = [
  path.join(__dirname, "sha3_wasm_bg.wasm"),
  path.join(__dirname, "sha3_wasm_bg.wasm.b64"),
  path.join(__dirname, "..", "..", "assets", "sha3_wasm_bg.wasm"),
  path.join(__dirname, "..", "..", "assets", "sha3_wasm_bg.wasm.b64"),
];

function loadWasmBytes() {
  for (const p of WASM_CANDIDATES) {
    if (!existsSync(p)) continue;
    const raw = readFileSync(p);
    if (p.endsWith(".b64")) return Buffer.from(raw.toString("utf-8").replace(/\s+/g, ""), "base64");
    return raw;
  }
  throw new Error("未找到 sha3_wasm_bg.wasm（可放在 " + __dirname + "、仓库 assets/ 下，或提供同目录 .b64 文本）");
}

let _inst = null;
async function getInstance() {
  if (_inst) return _inst;
  const bytes = loadWasmBytes();
  const res = await WebAssembly.instantiate(bytes, {});
  _inst = res.instance || res;
  return _inst;
}

/**
 * 根据网页端下发的 challenge 对象，算出 x-ds-pow-response（base64 JSON）。
 * @param {object} ch 服务端 challenge：{algorithm,challenge,salt,expire_at,difficulty,signature,target_path}
 * @returns {Promise<string>} base64 头
 */
export async function makePowHeader(ch) {
  const inst = await getInstance();
  const ex = inst.exports;
  const mem = ex.memory;
  const malloc = ex.__wbindgen_export_0;
  const addStack = ex.__wbindgen_add_to_stack_pointer;
  const solve = ex.wasm_solve;

  const challengeStr = String(ch.challenge ?? "");
  const prefix = `${ch.salt}_${ch.expire_at}_`;
  const difficulty = Number(ch.difficulty ?? 1);

  const retptr = addStack(-16);
  // 每次 malloc 都可能让 wasm 内存增长（旧 ArrayBuffer 被分离），因此写入前必须取最新 buffer
  const cBuf = Buffer.from(challengeStr, "utf-8");
  const cp = malloc(cBuf.length, 1);
  new Uint8Array(ex.memory.buffer).set(cBuf, cp);
  const pBuf = Buffer.from(prefix, "utf-8");
  const pp = malloc(pBuf.length, 1);
  new Uint8Array(ex.memory.buffer).set(pBuf, pp);

  solve(retptr, cp, cBuf.length, pp, pBuf.length, difficulty);

  // 内存可能在 solve 中增长，重新取最新 buffer
  const dv = new DataView(ex.memory.buffer);
  const status = dv.getInt32(retptr, true);
  const answer = dv.getFloat64(retptr + 8, true);
  addStack(16);

  if (!status) throw new Error("PoW 未解出答案（challenge 可能已过期，或 salt/expire_at 格式不符）");
  const payload = {
    algorithm: ch.algorithm,
    challenge: ch.challenge,
    salt: ch.salt,
    answer: Math.round(answer),
    signature: ch.signature,
    target_path: ch.target_path,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
