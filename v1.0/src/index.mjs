#!/usr/bin/env node
/**
 * deepseek-web-mcp · DSH 插件（模型技能）· 纯 Node 实现
 *
 * 把 DeepSeek 网页端直接包装成 DSH 可调用的 MCP 工具，模型可用它分析任意代码
 * 文件指定行范围（第 start_line 至 end_line 行），内容经网页端 DeepSeek 返回分析。
 *
 * 完全在 DSH / Node 运行时内运行：PoW 用官方 sha3_wasm_bg.wasm（Node 的 WebAssembly 直接跑，
 * 不需要 wasmtime / Python），对话走 Node 原生 fetch + SSE 解析。不依赖任何外部进程或 HTTP 代理。
 *
 * 登录（DeepSeek 账号）凭据来源（按优先级）：
 *   1) 环境变量 DEEPSEEK_WEB_TOKEN / DEEPSEEK_WEB_COOKIE
 *   2) DEEPSEEK_WEB_CREDENTIALS 指向的 JSON 文件，或本包根目录的 credentials.json
 *
 * 注册方式（profiles/web/cordis.patch.yml）：
 *   - id: mcp-deepseek-web
 *     name: '@deepseek-ai/dsh-mcp-client'
 *     config:
 *       transport: stdio
 *       serverName: deepseek-web
 *       command: node
 *       args: ['<本目录>/src/index.mjs']
 *       env:
 *         DEEPSEEK_WEB_TOKEN: '<网页端 userToken>'
 *         DEEPSEEK_WEB_COOKIE: '<网页端 cookie>'
 *
 * 暴露工具（名称稳定）：
 *   - web_analyze_range  读取文件行范围/直接喂内容，提交网页端做分析/总结/解释/挑刺(critique)/补全实现(implement)
 *                         增强：search(联网搜索) / save_result(存档markdown) / apply 支持 target_create(新建) + backup(写前备份)
 *   - fs_list            列出工作目录结构（挑刺机制第一步：先知道项目全貌）
 *   - fs_read            读取项目内任意文件/行范围（把真实代码读出来当证据）
 *   - fs_grep            递归搜索符号（确认某符号是否真有消费者/被修改/衰减，消除跨文件假阳性）
 *   - critique_workspace 一键有证据的挑刺：自动 fs_grep→读证据→网页端 critique（手动三步的封装）
 *   - web_conversation_list  列出活跃对话（对话ID/模型/更新时间/预览）
 *   - web_conversation_clear  删除对话（单条 by conversation_id，或 all:true 清空）
 *   所有 fs_* 工具限定在 ROOT（env DWH_ROOT 或用户主目录）内，防越界。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

import { makePowHeader } from "./pow.mjs";

// ---------- 多轮对话会话存储（内存 + 本地 JSON 持久化，跨 DSH 重启可续） ----------
const __dirname = dirname(fileURLToPath(import.meta.url));
const CONV_FILE = join(__dirname, "conversations.json");
const MAX_CONV = 100;
let conversations = new Map();

function loadConversations() {
  try {
    if (!existsSync(CONV_FILE)) return;
    const arr = JSON.parse(readFileSync(CONV_FILE, "utf-8"));
    if (Array.isArray(arr)) for (const c of arr) if (c && c.id) conversations.set(c.id, c);
  } catch {}
}
function saveConversations() {
  try {
    let arr = [...conversations.values()];
    if (arr.length > MAX_CONV) {
      arr = arr.sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, MAX_CONV);
      conversations = new Map(arr.map((c) => [c.id, c]));
    }
    writeFileSync(CONV_FILE, JSON.stringify(arr), "utf-8");
  } catch {}
}
loadConversations();

const SERVER_NAME = "deepseek-web";
const SERVER_VERSION = "1.0.0";

const BASE = "https://chat.deepseek.com";
const API = BASE + "/api/v0";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0";

const STATIC_HEADERS = {
  accept: "*/*",
  "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "content-type": "application/json",
  origin: BASE,
  referer: BASE + "/",
  "user-agent": UA,
  "x-client-bundle-id": "com.deepseek.chat",
  "x-client-locale": "zh_CN",
  "x-client-platform": "web",
  "x-client-timezone-offset": "28800",
  "x-client-version": "2.3.0",
};

// ---------- 凭据解析 ----------
// 优先级：环境变量 → DEEPSEEK_WEB_CREDENTIALS 指向的 JSON → 本包根目录的 credentials.json
const CRED_FILE = (process.env.DEEPSEEK_WEB_CREDENTIALS || "").trim() || join(__dirname, "..", "credentials.json");

function getTokenCookie() {
  let token = (process.env.DEEPSEEK_WEB_TOKEN || "").trim();
  let cookie = (process.env.DEEPSEEK_WEB_COOKIE || "").trim();
  if (token) return { token, cookie };
  try {
    const d = JSON.parse(readFileSync(CRED_FILE, "utf-8"));
    if (d.token) return { token: String(d.token), cookie: String(d.cookie || "") };
  } catch {}
  return { token: "", cookie: "" };
}

function authHeaders(token, cookie) {
  const h = { ...STATIC_HEADERS, Authorization: `Bearer ${token}` };
  if (cookie) h["Cookie"] = cookie;
  return h;
}

// 在嵌套结构里找第一个字符串类型 id
function deepFindId(d) {
  if (typeof d === "string") return d;
  if (Array.isArray(d)) {
    for (const v of d) {
      const r = deepFindId(v);
      if (r) return r;
    }
    return null;
  }
  if (d && typeof d === "object") {
    if (typeof d.id === "string") return d.id;
    for (const k of Object.keys(d)) {
      const r = deepFindId(d[k]);
      if (r) return r;
    }
  }
  return null;
}

async function jsonPost(url, token, cookie, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: authHeaders(token, cookie),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`POST ${url} -> ${r.status}: ${txt.slice(0, 300)}`);
  }
  return r.json();
}

async function createPowChallenge(token, cookie) {
  const j = await jsonPost(API + "/chat/create_pow_challenge", token, cookie, {
    target_path: "/api/v0/chat/completion",
  });
  let node = j?.data ?? {};
  node = node?.biz_data ?? node;
  return node?.challenge ?? node;
}

async function createSession(token, cookie) {
  const j = await jsonPost(API + "/chat_session/create", token, cookie, { title: "dsh-web" });
  return deepFindId(j) || j;
}

/** 流式发消息并解析 SSE，返回 {content, reasoning, respId}。 */
async function streamMessage(token, cookie, sessionId, prompt, parentId, powHeader, thinking, searchEnabled) {
  const headers = authHeaders(token, cookie);
  headers["x-ds-pow-response"] = powHeader;
  headers["accept"] = "text/event-stream";
  const payload = {
    chat_session_id: sessionId,
    prompt,
    ref_size: 8,
    ref_file_ids: [],
    thinking_enabled: !!thinking,
    search_enabled: !!searchEnabled,
    need_depth_search: false,
    language: "zh-CN",
  };
  const pid = parseInt(parentId || 0, 10);
  if (pid > 0) payload.parent_message_id = pid;

  const resp = await fetch(API + "/chat/completion", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`POST /chat/completion -> ${resp.status}: ${txt.slice(0, 300)}`);
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const contentParts = [];
  const reasoningParts = [];
  let respId = null;
  let reqId = null;

  const handleObj = (obj) => {
    if (typeof obj !== "object" || obj === null) return;
    if ("response_message_id" in obj && "request_message_id" in obj) {
      reqId = obj.request_message_id;
      respId = obj.response_message_id;
    }
    const v = obj.v;
    if (typeof v === "object" && v && typeof v.response === "object") {
      const r = v.response;
      if (r.message_id) respId = r.message_id;
      for (const frag of r.fragments || []) {
        const fc = frag.content;
        if (fc == null) continue;
        if (frag.type === "THINK") reasoningParts.push(fc);
        else contentParts.push(fc);
      }
      return;
    }
    if (typeof v === "string" && v !== "FINISHED") {
      contentParts.push(v);
      return;
    }
    const p = obj.p;
    const o = obj.o;
    const val = obj.v;
    if (p && o && val != null && p.startsWith("response/fragments/")) {
      const parts = p.split("/");
      const field = parts[3] || "";
      if (field === "content") contentParts.push(val);
      else if (field === "thinking_content") reasoningParts.push(val);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line || line.startsWith("event:")) continue;
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (raw === "[DONE]") continue;
      try {
        handleObj(JSON.parse(raw));
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
  }
  if (buf.trim()) {
    const line = buf.trim();
    if (line.startsWith("data:")) {
      const raw = line.slice(5).trim();
      if (raw && raw !== "[DONE]") {
        try { handleObj(JSON.parse(raw)); } catch {}
      }
    }
  }

  return { content: contentParts.join(""), reasoning: reasoningParts.join(""), respId };
}

let _chain = Promise.resolve();
function serialize(fn) {
  const r = _chain.then(() => fn());
  _chain = r.catch(() => {});
  return r;
}

/** 发一条消息。conv 为空则新建会话；否则在该会话内续聊（用 conv.parentId 作 parent）。返回 {text, reasoning, respId, sessionId}。 */
async function askDeepSeek(prompt, model, conv, searchEnabled) {
  const { token, cookie } = getTokenCookie();
  if (!token) {
    throw new Error(
      "缺少 DeepSeek 网页端 token：请通过环境变量 DEEPSEEK_WEB_TOKEN 提供（可选 DEEPSEEK_WEB_COOKIE），" +
      "或在插件根目录放置 credentials.json（内含 token 与 cookie 两个字段），" +
      "也可用 DEEPSEEK_WEB_CREDENTIALS 指向该文件；token/cookie 可从已登录 chat.deepseek.com 的浏览器请求里复制"
    );
  }
  const thinking = ["reasoner", "r1", "think"].some((k) => String(model || "").toLowerCase().includes(k));
  let sessionId;
  let parentId = 0;
  if (conv && conv.sessionId) {
    sessionId = conv.sessionId;
    parentId = parseInt(conv.parentId || 0, 10);
  } else {
    const sid = await createSession(token, cookie);
    sessionId = deepFindId(sid) || sid;
  }
  const ch = await createPowChallenge(token, cookie);
  const powHeader = await makePowHeader(ch);
  const { content, reasoning, respId } = await streamMessage(token, cookie, sessionId, prompt, parentId, powHeader, thinking, searchEnabled);
  return { text: content || "", reasoning: reasoning || "", respId, sessionId };
}

const TOOLS = [
  {
    name: "web_analyze_range",
    description:
      "将一段代码 / 文本作为上下文提交给 DeepSeek 网页端做分析 / 审查 / 解释，返回网页端的回答。" +
      "两种内容来源二选一：①给 file + start_line + end_line 读取本地文件指定行范围；" +
      "②给 code 直接传入任意内容（代码需求 / 设计说明 / 伪代码 / 粘贴片段 / 网络搜寻结果 / 日志等）。" +
      "支持 mode=summary（直接总结）/ analyze（深度解析）/ explain（逐段解释）/ critique（挑刺对抗测验）；也可给 question 指定具体问题；" +
      "调用方可把检索到的资料、伪代码或需求直接喂给本工具，让网页端模型基于这些内容思考。" +
      "完全在 DSH / Node 内运行：直接驱动本地网页端（复用 DSH 设置里的 DeepSeek 账号登录），不依赖 Python 或独立 HTTP 代理。" +
      "支持多轮对话：首次调用省略 conversation_id 即开新对话；续聊时把上一次返回的「对话ID」原样回传为 conversation_id，" +
      "网页端会带着之前上下文回答；传 restart=true 则重开对话。是否带上下文由调用方按场景决定。" +
      "增强项：可传 search=true 让网页端联网搜索实时资料；可传 save_result=相对ROOT的路径 把分析存档为 markdown；" +
      "mode=implement 补全的实现可由调用方显式 apply=true 写入文件（支持替换区间 / 追加 / 新建 target_create / 写前备份 backup）。",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "直接提供的待分析内容（调用方喂给网页端模型的材料）：代码需求 / 设计说明 / 伪代码 / 粘贴的代码片段 / 网络搜寻结果 / 日志片段等。" +
            "提供 code 时忽略 file/start_line/end_line，直接用本段内容做分析（可配合 question 指定具体要问什么）。",
        },
        context: {
          type: "string",
          description:
            "调用方已通过 fs_read / fs_grep 从项目真实读出的「参考上下文」（消费者 / 赋值处 / 衰减链 / 相关实现等）。" +
            "工具会作为「真实存在的代码（已本地核实）」单独标注并附在主语之前，网页端据此作答、不再凭空质疑其存在。" +
            "这是「挑刺」机制消除跨文件假阳性的关键：把证据喂进来，网页端就不必猜。可与 context_files 并用。",
        },
        context_files: {
          type: "array",
          description:
            "要作为参考上下文附带读取的文件清单（每项 {path, start_line?, end_line?}，path 相对 ROOT）。" +
            "工具自动读取并标注为「真实证据」。用于挑刺时一键把相关文件拉进来，配合 mode:critique 做有证据的审查。",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "文件路径（相对 ROOT，例如 WorkBuddy/.../entity.lua）" },
              start_line: { type: "integer", description: "起始行（含）；省略则读整个文件" },
              end_line: { type: "integer", description: "结束行（含）；仅与 start_line 同时给时生效" },
            },
            required: ["path"],
          },
        },
        file: { type: "string", description: "要分析的代码文件绝对路径，例如 C:/project/foo.lua。与 code 二选一（code 优先）；都不给则报错。" },
        start_line: { type: "integer", description: "起始行号（1-based，含）；仅在使用 file 时生效" },
        end_line: { type: "integer", description: "结束行号（1-based，含）；仅在使用 file 时生效" },
        mode: {
          type: "string",
          enum: ["summary", "analyze", "explain", "implement", "critique"],
          description:
            "分析模式：summary=直接总结（职责/关键逻辑/对外依赖，精炼结论优先）；" +
            "analyze=深度解析（潜在问题/边界情况/改进点）；explain=逐段解释执行流程；" +
            "implement=把伪代码/理想描述补全为完整可运行实现（回复里用 ``` 代码块给出最终实现 + 关键改动点）；" +
            "critique=挑刺/红队对抗审查（逐条列缺陷+触发条件+严重度(高/中/低)+修复方向，并给出 3–6 道测验题考校方案是否经得起推敲）。留空且有 question 时按 question 走。",
          default: "summary",
        },
        apply: {
          type: "boolean",
          description:
            "是否把实现写入文件（实装）。必须经调用模型显式置 true 才写，工具绝不会自动写盘——这就是「模型批准实装」。" +
            "为 true 时需给 target_file；要写的代码优先取 apply_code，否则取上一次对话（conversation_id）网页端回复里最后一个 ``` 代码块。",
          default: false,
        },
        apply_code: {
          type: "string",
          description: "要写入文件的精确代码；apply=true 时若提供则直接写它（模型把审查过的代码原样交回，最明确）。省略则从 conversation_id 上次回复抽取最后的代码块。",
        },
        target_file: {
          type: "string",
          description: "实装目标文件路径（apply=true 时必填）。",
        },
        target_start: {
          type: "integer",
          description: "实装写入的起始行（1-based，含）；与 target_end 同时给则替换该区间。",
        },
        target_end: {
          type: "integer",
          description: "实装写入的结束行（1-based，含）；与 target_start 同时给则替换该区间。",
        },
        target_append: {
          type: "boolean",
          description: "true=把代码追加到 target_file 末尾（而非替换区间/覆盖）。与 target_start/target_end 二选一。",
          default: false,
        },
        target_create: {
          type: "boolean",
          description: "true=允许把代码写入一个【尚不存在】的新文件（新建文件，整文件内容即代码块）。与 target_start/target_end/target_append 互斥；不给则 target_file 不存在时报错。",
          default: false,
        },
        backup: {
          type: "boolean",
          description: "true=实装写盘前自动把 target_file 备份为 `<原名>.bak.<时间戳>`（同目录），防止误写不可回滚。默认 false（工具本身不自动备份，依赖调用方自行用版本控制）。",
          default: false,
        },
        question: {
          type: "string",
          description: "针对这段代码要问的具体问题；留空则按 mode 的默认指令（summary 直接总结 / analyze 深度审查 / explain 解释流程）",
        },
        model: {
          type: "string",
          description: "deepseek-chat(普通) 或 deepseek-reasoner(深度思考)",
          default: "deepseek-chat",
        },
        conversation_id: {
          type: "string",
          description: "继续已有对话时，原样回传上一次返回文本末尾的「对话ID」。省略则开新对话。",
        },
        restart: {
          type: "boolean",
          description: "true=强制开新对话（忽略 conversation_id），即「重开对话」。",
          default: false,
        },
        search: {
          type: "boolean",
          description: "true=开启 DeepSeek 网页端联网搜索（web search），让网页端基于实时网络资料回答（适合查 API 用法 / 官方文档 / 最新事实）。默认 false（仅用模型自身知识）。",
          default: false,
        },
        save_result: {
          type: "string",
          description: "把本次返回的完整分析存档到 ROOT 内的 markdown 文件（路径相对 ROOT，例如 WorkBuddy/.../analysis_001.md）。工具会写入「# 标题\\n\\n<分析正文>\\n」并附对话ID，便于留档复盘。越界路径被拒。",
        },
      },
      required: [],
    },
  },
  {
    name: "fs_list",
    description:
      "列出工作目录（或指定子目录）下的文件与文件夹，返回名称、类型(dir/file)、字节大小、文件行数。" +
      "这是「挑刺」机制的第一步：让模型先知道项目完整结构，再决定看哪些文件。path 为相对 ROOT 的路径，省略则列 ROOT 根。" +
      "默认跳过 node_modules/.git/.workbuddy/dist/build 等噪声目录。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "要列出的目录（相对 ROOT，例如 WorkBuddy/2026-08-20-16-27-02）。省略则列根目录。" },
      },
      required: [],
    },
  },
  {
    name: "fs_read",
    description:
      "读取工作目录内任意文件的完整内容，或指定行范围（start_line/end_line，1-based 含）。" +
      "用于「挑刺」时把相关实现 / 消费者 / 赋值处真实读出来，作为证据交给网页端模型，从根上消除跨文件假阳性。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对 ROOT，例如 WorkBuddy/.../entity.lua）" },
        start_line: { type: "integer", description: "起始行（含）；省略则读整个文件" },
        end_line: { type: "integer", description: "结束行（含）；仅与 start_line 同时给时生效" },
      },
      required: ["path"],
    },
  },
  {
    name: "fs_grep",
    description:
      "在整个工作目录（或指定子目录）递归搜索正则 pattern，返回匹配的文件:行号:内容片段。" +
      "「挑刺」机制的关键：用于确认某符号是否真有消费者 / 被修改 / 衰减——把命中结果作为真实证据喂给网页端，" +
      "避免它凭空断言「无消费者 / 未被使用 / 永不衰减」。跳过 node_modules/.git/.workbuddy，单文件超 2MB 跳过。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则（大小写不敏感），例如 activeInference|data\\.epsilon" },
        path: { type: "string", description: "搜索起点目录（相对 ROOT）；省略则搜整个工作目录" },
        glob: { type: "string", description: "文件名过滤，例如 *.lua" },
        max_results: { type: "integer", description: "最大返回条数（默认 60，上限 300）" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "critique_workspace",
    description:
      "一键「有证据的挑刺」：自动探查工作目录、把目标符号/主题的真实代码读出来当证据，再交给 DeepSeek 网页端做 critique。" +
      "内部自动执行：①fs_grep(target) 搜出所有命中；②对前 max_evidence 个命中各读取 ±window 行上下文作为 context_files 证据；" +
      "③调用网页端 critique 指令（逐条缺陷+触发条件+严重度+修复方向，并出 3–6 道测验题），证据已附上，网页端不再凭空误判「无消费者/未被使用」。" +
      "这是「挑刺机制」工作流的一键封装：不必手动 fs_grep→fs_read→拼 context_files。target 为要审查的正则符号/主题；" +
      "可给 prompt 指定具体审查侧重。返回证据收集摘要 + 网页端挑刺结果（含对话ID，可续聊把答案喂回让网页端评分）。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "要审查的符号 / 正则（例如 activeInference、data\\.epsilon、NPC_Shoot）。工具会搜它的所有定义/调用/消费处作为证据。" },
        path: { type: "string", description: "搜索起点目录（相对 ROOT）；省略则搜整个工作目录" },
        glob: { type: "string", description: "文件名过滤，例如 *.lua" },
        max_evidence: { type: "integer", description: "最多读取多少个命中处作为证据（默认 8，上限 20）", default: 8 },
        window: { type: "integer", description: "每个命中处上下各读多少行上下文（默认 15，即 ±15 行）", default: 15 },
        prompt: { type: "string", description: "针对该符号/主题的具体审查侧重（例如「重点看线程安全与帧率影响」）；省略则做全面挑刺" },
        model: { type: "string", description: "deepseek-chat(普通) 或 deepseek-reasoner(深度思考)", default: "deepseek-reasoner" },
      },
      required: ["target"],
    },
  },
  {
    name: "web_conversation_list",
    description:
      "列出当前活跃的网页端对话（由 web_analyze_range / critique_workspace 创建的会话池，最多保留 100 个）。" +
      "返回每条的对话ID、模型、最近更新时间(ISO)、最近一次回复预览，便于挑选要续聊(回传 conversation_id)或清理的会话。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "web_conversation_clear",
    description:
      "删除网页端对话。给 conversation_id 删除单条；给 all=true 清空全部（仅清内存会话池，不删远端网页端会话）。" +
      "用于清理会话池、释放「对话ID」命名空间，或丢弃已无用的分析上下文。",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "要删除的对话ID；与 all 二选一" },
        all: { type: "boolean", description: "true=清空全部对话", default: false },
      },
      required: [],
    },
  },
];

/** 从网页端回复里抽取最后一个 ``` 代码块（作为「要实装的纯代码」）。 */
function extractImplCode(text) {
  const blocks = [...String(text || "").matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  if (!blocks.length) return "";
  let body = blocks[blocks.length - 1][1];
  if (body.endsWith("\n")) body = body.slice(0, -1);
  if (body.startsWith("\n")) body = body.slice(1);
  return body;
}

/** 移除文本中所有 ``` 代码块，返回剩余文字（用于把「说明（废话）」从「代码」中分离出来）。 */
function stripCodeBlocks(text) {
  return String(text || "").replace(/```[^\n]*\n[\s\S]*?```/g, "");
}

/** critique（挑刺 / 红队对抗测验）模式的固定指令，web_analyze_range 与 critique_workspace 共用。 */
const CRITIQUE_INSTRUCTION =
  "请扮演一位严苛的评审 / 红队审查员，对这段内容做「挑刺」式对抗审查：\n" +
  "①逐条列出潜在缺陷、隐藏假设、边界与最坏情况、逻辑矛盾、可维护性/安全/性能隐患、与已知事实的冲突；\n" +
  "②每条严格按「问题 → 触发条件 → 后果严重度(高/中/低) → 修复方向」四段给出；\n" +
  "③最后给出一组「测验题」：3–6 个尖锐追问，用来考校该方案是否经得起推敲——题目必须命中真实漏洞或可证伪点，不要出表面问题；\n" +
  "④依赖「其它文件是否存在某符号/状态」的判断，按上下文范围警告标注「⚠需跨文件核实」，严禁凭空断言「不存在/未被使用」。";

/** 无参考上下文时附在主语前的「上下文范围警告」，web_analyze_range / critique_workspace 共用。 */
const NO_CTX_WARNING =
  "【上下文范围警告】你只看到了下面这段内容，看不到本项目其它文件。因此：\n" +
  "①只对可见内容做确定性判断；\n" +
  "②任何依赖「其它文件是否消费/调用/定义了某符号」或「某变量/状态是否在其他地方被修改/衰减/重置」的结论，" +
  "必须明确标注「⚠需跨文件核实」，严禁直接断言「无消费者/未被使用/永不衰减/从未被读取」等存在性结论；\n" +
  "③空指针、越界、竞态、边界、执行顺序等仅依赖可见代码的判断可给确定结论。\n\n";

/**
 * 把 context_files（自动读取）与 context（调用方直喂）拼成「已核实证据」块。
 * 有该块时不输出旧的【上下文范围警告】，网页端据此作答、不再凭空质疑存在性。
 * 返回空串表示无任何参考上下文。
 */
function buildContextBlock(contextFiles, context) {
  const ctxParts = [];
  if (context && String(context).trim()) ctxParts.push(String(context).trim());
  if (Array.isArray(contextFiles)) {
    for (const cf of contextFiles) {
      if (cf && cf.path) {
        try {
          const cr = readAny(
            cf.path,
            cf.start_line != null ? parseInt(cf.start_line, 10) : null,
            cf.end_line != null ? parseInt(cf.end_line, 10) : null
          );
          const lbl = cr.start ? (cf.path + " 第 " + cr.start + "–" + cr.end + " 行") : cf.path;
          ctxParts.push("【文件 " + lbl + "】\n```\n" + cr.content + "\n```");
        } catch (e) {
          ctxParts.push("【文件 " + cf.path + " 读取失败：" + String((e && e.message) || e) + "】");
        }
      }
    }
  }
  if (!ctxParts.length) return "";
  return (
    "【项目其它文件检索所得的参考上下文 —— 以下均为真实存在的代码（已由本地文件读取核实），请据此回答，不要再质疑其是否存在；" +
    "仅对未出现在此处的符号，才适用下方的上下文范围警告】\n\n" + ctxParts.join("\n\n") + "\n\n"
  );
}

function readRange(file, startLine, endLine) {
  const text = readFileSync(file, "utf-8");
  const lines = text.split(/\n/);
  const s = Math.max(1, startLine | 0);
  const e = Math.min(lines.length, endLine | 0);
  return { code: lines.slice(s - 1, e).join("\n"), actuallyEnd: e, total: lines.length };
}

// —— 工作目录访问（技能「挑刺」机制：模型可探查项目、读文件、搜符号，把真实证据交给网页端）——
// 允许访问的根目录：env DWH_ROOT 或默认用户主目录。所有路径必须落在该根内（防越界）。
const ROOT = (process.env.DWH_ROOT && process.env.DWH_ROOT.trim()) || os.homedir();
const SKIP_DIRS = new Set(["node_modules", ".git", ".workbuddy", "dist", "build", ".cache", "node_modules/.cache"]);
const MAX_FILE_BYTES = 2_000_000;

function resolveSafe(p) {
  const abs = resolve(ROOT, p || "");
  const rel = relative(ROOT, abs);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error("路径越界（超出允许根目录 " + ROOT + "）：" + p);
  }
  return abs;
}

function listDir(relPath) {
  const abs = resolveSafe(relPath || "");
  const st = statSync(abs);
  if (!st.isDirectory()) throw new Error("不是目录：" + relPath);
  const names = readdirSync(abs).sort((a, b) => a.localeCompare(b));
  const entries = [];
  for (const name of names) {
    const full = join(abs, name);
    let info;
    try { info = statSync(full); } catch { continue; }
    const isDir = info.isDirectory();
    let lines = null;
    if (!isDir) {
      try { lines = readFileSync(full, "utf-8").split("\n").length; } catch { lines = null; }
    }
    entries.push({ name, type: isDir ? "dir" : "file", size: info.size, lines });
  }
  return { path: abs, root: ROOT, entries };
}

function readAny(relPath, startLine, endLine) {
  const abs = resolveSafe(relPath);
  const text = readFileSync(abs, "utf-8");
  const lines = text.split("\n");
  if (startLine == null) {
    return { path: abs, total: lines.length, content: text };
  }
  const s = Math.max(1, startLine | 0);
  const e = Math.min(lines.length, endLine | 0);
  return { path: abs, start: s, end: e, total: lines.length, content: lines.slice(s - 1, e).join("\n") };
}

function grepProject(pattern, relPath, glob, maxResults) {
  const re = new RegExp(pattern, "i");
  const globRe = glob ? new RegExp("^" + String(glob).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i") : null;
  const base = resolveSafe(relPath || "");
  const cap = Math.max(1, Math.min(maxResults || 60, 300));
  const results = [];
  const walk = (dir) => {
    if (results.length >= cap) return;
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (results.length >= cap) return;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(full);
      } else {
        if (globRe && !globRe.test(name)) continue;
        if (st.size > MAX_FILE_BYTES) continue;
        let text;
        try { text = readFileSync(full, "utf-8"); } catch { continue; }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= cap) break;
          if (re.test(lines[i])) {
            results.push({ file: relative(ROOT, full), line: i + 1, text: lines[i].trim().slice(0, 400) });
          }
        }
      }
    }
  };
  walk(base);
  return { pattern, root: ROOT, count: results.length, results };
}

async function main() {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ ...t })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      if (name === "web_analyze_range") {
        const a = args || {};

        // —— 实装分支：模型显式批准后才写盘（apply=true 才进这里）——
        if (a.apply === true || String(a.apply || "").toLowerCase() === "true") {
          if (!a.target_file) throw new Error("apply=true 时必须给 target_file");
          let codeToWrite = (a.apply_code && String(a.apply_code).trim() !== "") ? String(a.apply_code) : "";
          if (!codeToWrite) {
            if (!a.conversation_id || !conversations.has(a.conversation_id)) {
              throw new Error("未给 apply_code，且缺少有效的 conversation_id（无法从先前回复抽取代码）；请二选一提供");
            }
            codeToWrite = extractImplCode(conversations.get(a.conversation_id).lastText || "");
            if (!codeToWrite) throw new Error("从上一次对话回复中未找到 ``` 代码块，请用 apply_code 明确提供要写入的代码");
          }
          const create = a.target_create === true || String(a.target_create || "").toLowerCase() === "true";
          const doBackup = a.backup === true || String(a.backup || "").toLowerCase() === "true";
          if (!existsSync(a.target_file)) {
            if (!create) throw new Error("target_file 不存在：" + a.target_file + "（若要新建文件，请加 target_create:true）");
            // 新建文件：整文件内容即代码块
            const abs = resolveSafe(a.target_file);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, codeToWrite, "utf-8");
            return {
              content: [{
                type: "text",
                text:
                  "✔ 已新建文件（经模型批准）：" + abs + "\n" +
                  "写入 " + codeToWrite.split("\n").length + " 行\n" +
                  "预览（前 6 行）：\n```\n" + codeToWrite.split("\n").slice(0, 6).join("\n") + "\n```",
              }],
            };
          }
          // 已存在：可选写前备份
          let backupNote = "";
          if (doBackup) {
            const bak = a.target_file + ".bak." + Date.now();
            copyFileSync(a.target_file, bak);
            backupNote = "（已备份原文件到 " + bak + "）\n";
          }
          const srcLines = readFileSync(a.target_file, "utf-8").split(/\n/);
          const ts = parseInt(a.target_start, 10), te = parseInt(a.target_end, 10);
          const append = a.target_append === true || String(a.target_append || "").toLowerCase() === "true";
          let newLines, rangeLabel;
          if (ts >= 1 && te >= ts) {
            if (te > srcLines.length) throw new Error("target_end(" + te + ") 超出文件总行数(" + srcLines.length + ")");
            newLines = [...srcLines.slice(0, ts - 1), codeToWrite, ...srcLines.slice(te)];
            rangeLabel = "替换第 " + ts + "–" + te + " 行（原 " + (te - ts + 1) + " 行 → 新 " + codeToWrite.split("\n").length + " 行）";
          } else if (append) {
            newLines = [...srcLines, codeToWrite];
            rangeLabel = "追加到末尾（原 " + srcLines.length + " 行）";
          } else {
            throw new Error("apply 写入需指明落点：给 target_start+target_end 替换区间，或 target_append=true 追加；不允许静默整体覆盖已有文件");
          }
          writeFileSync(a.target_file, newLines.join("\n"), "utf-8");
          return {
            content: [{
              type: "text",
              text:
                "✔ 已实装（经模型批准）：" + a.target_file + "\n" +
                backupNote +
                "操作：" + rangeLabel + "\n" +
                "写入代码（前 6 行预览）：\n```\n" + codeToWrite.split("\n").slice(0, 6).join("\n") + "\n```\n" +
                "（如需回滚：已备份则恢复 .bak 文件，否则请用版本控制或手动还原）",
            }],
          };
        }

        let code, srcLabel, actuallyEnd = 0, total = 0;
        if (a.code != null && String(a.code).trim() !== "") {
          // 调用方直接喂内容（代码需求 / 伪代码 / 网络搜寻结果 / 粘贴片段等）
          code = String(a.code);
          srcLabel = "来源：调用方直接提供的内容（code 参数）";
        } else {
          if (!a.file) throw new Error("缺少 file 或 code 参数（二者至少给一个；给了 code 则忽略 file）");
          const s = parseInt(a.start_line, 10);
          const e = parseInt(a.end_line, 10);
          if (!(s >= 1) || !(e >= s)) throw new Error("start_line / end_line 非法（需 1-based 且 end>=start）");
          const r = readRange(a.file, s, e);
          code = r.code; actuallyEnd = r.actuallyEnd; total = r.total;
          if (!code.trim()) throw new Error("指定行范围为空（文件共 " + total + " 行）");
          srcLabel = "文件：" + a.file + "\n行范围：第 " + s + "–" + actuallyEnd + " 行（共 " + total + " 行）";
        }
        const q = (a.question && String(a.question).trim()) || "";
        const mode = (a.mode && ["summary", "analyze", "explain", "implement", "critique"].includes(a.mode)) ? a.mode : "summary";
        let instruction;
        if (q) {
          instruction = q;
        } else if (mode === "analyze") {
          instruction = "请对这段代码做深度解析：指出它的职责、潜在问题（含空指针/越界/竞态/边界）、边界情况与可改进点，并给出具体修改建议。";
        } else if (mode === "explain") {
          instruction = "请逐段解释这段代码的执行流程与关键语句含义，按代码顺序说明每一步在做什么。";
        } else if (mode === "implement") {
          instruction = "请把下面这段伪代码 / 理想描述补全为完整、可直接落地的实现代码。\n" +
            "【输出格式硬性要求，必须严格遵守】\n" +
            "①整段回复里只允许出现【唯一一个】``` 代码块；\n" +
            "②该代码块内【只含可执行代码，不要写任何注释（包括 -- 注释与行内注释）】；所有解释、改动点、风险、⚠需跨文件核实 一律放在代码块【之外】用自然语言段落书写；\n" +
            "③所有解释、关键改动点、风险、⚠需跨文件核实 等说明文字，一律放在那个 ``` 代码块【之外】，用自然语言段落书写；\n" +
            "④代码块包裹的就是「将写入文件的纯实现」，不得夹带任何废话。\n" +
            "请先给出 ``` 代码块（完整实现），再在块外用一段写改动点 / 风险 / 仍需本地核实之处。";
        } else if (mode === "critique") {
          instruction = CRITIQUE_INSTRUCTION;
        } else {
          instruction = "请直接总结这段代码的：①核心职责 ②关键逻辑/算法 ③依赖与对外影响（调用了什么、改变了什么状态）。精炼、结论优先，不要发散。";
        }
        // 参考上下文（来自项目真实文件，作为已核实证据，从根上消除跨文件假阳性）
        const contextBlock = buildContextBlock(a.context_files, a.context);
        const prompt =
          "你是一名资深代码审查与解释助手，擅长 Lua / GMod Lua / 通用编程语言。用简体中文回答，结论优先，并给出具体修改建议。\n" +
          (contextBlock ? contextBlock : NO_CTX_WARNING) +
          srcLabel + "\n\n```\n" + code + "\n```\n\n" + instruction;

        // 多轮对话：定位/新建会话（模型按场景决定是否带上下文）
        const restart = a.restart === true || String(a.restart || "").toLowerCase() === "true";
        let conv = (!restart && a.conversation_id && conversations.has(a.conversation_id))
          ? conversations.get(a.conversation_id) : null;
        const requestedModel = a.model || "deepseek-chat";
        const effectiveModel = conv ? (conv.model || requestedModel) : requestedModel;

        const searchEnabled = a.search === true || String(a.search || "").toLowerCase() === "true";
        const runTurn = () => serialize(() => askDeepSeek(prompt, effectiveModel, conv, searchEnabled));
        let res;
        try {
          res = await runTurn();
        } catch (err) {
          // 续聊会话可能已失效（token 轮换 / 服务端过期）→ 开新会话重试一次
          if (conv) { conv = null; res = await runTurn(); }
          else throw err;
        }

        // 持久化会话
        if (!conv) {
          const newId = randomUUID();
          conv = { id: newId, sessionId: res.sessionId, parentId: String(res.respId || 0), model: effectiveModel, updated: Date.now(), lastText: res.text || "" };
          conversations.set(newId, conv);
        } else {
          conv.parentId = String(res.respId || 0);
          conv.sessionId = res.sessionId;
          conv.updated = Date.now();
          conv.lastText = res.text || "";
        }
        saveConversations();

        let out;
        if (mode === "implement") {
          // 把「纯代码」与「说明（废话）」分离展示，便于模型审批、避免废话被写进文件
          const implCode = extractImplCode(res.text || "");
          const implProse = stripCodeBlocks(res.text || "").trim();
          out = "";
          if (res.reasoning && effectiveModel.includes("reasoner")) {
            out += "【思考过程】\n" + res.reasoning + "\n\n";
          }
          out +=
            "【将写入文件的代码（apply 时只写这一段；如与你想写的不一致，用 apply_code 交回审查过的版本）】\n```\n" +
            (implCode || "（网页端未返回代码块，请用 apply_code 明确提供要写入的代码）") +
            "\n```\n\n" +
            "【说明（不写入文件）】\n" + (implProse || "（无）");
        } else {
          out = res.text || "";
          if (res.reasoning && effectiveModel.includes("reasoner")) {
            out = "【思考过程】\n" + res.reasoning + "\n\n【回复】\n" + out;
          }
        }
        out += "\n\n— — —\n对话ID（继续追问请原样回传此 ID；开新话题则省略或传 restart:true）：" + conv.id;
        if (a.save_result && String(a.save_result).trim()) {
          try {
            const sp = resolveSafe(String(a.save_result).trim());
            writeFileSync(sp, "# DeepSeek 网页端分析存档\n\n" + out + "\n", "utf-8");
            out = "（已存至 " + sp + "）\n\n" + out;
          } catch (e) {
            out = "（save_result 写入失败：" + String((e && e.message) || e) + "）\n\n" + out;
          }
        }
        return { content: [{ type: "text", text: out }] };
      } else if (name === "fs_list") {
        const a = args || {};
        const info = listDir(a.path);
        let txt = "目录：" + info.path + "（根：" + info.root + "）\n共 " + info.entries.length + " 项：\n";
        for (const e of info.entries) {
          if (e.type === "dir") txt += "  [DIR]  " + e.name + "\n";
          else txt += "  [FILE] " + e.name + "  (" + e.size + " B, " + (e.lines ?? "?") + " 行)\n";
        }
        return { content: [{ type: "text", text: txt }] };
      } else if (name === "fs_read") {
        const a = args || {};
        if (!a.path) throw new Error("缺少 path");
        const r = readAny(a.path, a.start_line != null ? parseInt(a.start_line, 10) : null, a.end_line != null ? parseInt(a.end_line, 10) : null);
        let txt = "文件：" + r.path + "（共 " + r.total + " 行）\n";
        if (r.start) txt += "行范围：第 " + r.start + "–" + r.end + " 行\n";
        txt += "\n```\n" + r.content + "\n```";
        return { content: [{ type: "text", text: txt }] };
      } else if (name === "fs_grep") {
        const a = args || {};
        if (!a.pattern) throw new Error("缺少 pattern");
        const r = grepProject(String(a.pattern), a.path, a.glob, a.max_results != null ? parseInt(a.max_results, 10) : null);
        let txt = "正则：" + r.pattern + "（根：" + r.root + "）命中 " + r.count + " 条：\n";
        for (const m of r.results) txt += "  " + m.file + ":" + m.line + "  " + m.text + "\n";
        return { content: [{ type: "text", text: txt }] };
      } else if (name === "critique_workspace") {
        // 一键有证据的挑刺：自动 grep → 读证据 → critique
        const a = args || {};
        if (!a.target) throw new Error("缺少 target（要审查的符号 / 正则）");
        const win = Math.max(1, Math.min(parseInt(a.window, 10) || 15, 100));
        const maxEv = Math.max(1, Math.min(parseInt(a.max_evidence, 10) || 8, 20));
        const grepped = grepProject(String(a.target), a.path, a.glob, Math.max(maxEv * 4, 40));
        const ctxFiles = [];
        for (const m of grepped.results) {
          if (ctxFiles.length >= maxEv) break;
          const r = readAny(m.file, Math.max(1, m.line - win), m.line + win);
          ctxFiles.push({ path: m.file, start_line: r.start, end_line: r.end });
        }
        const contextBlock = buildContextBlock(ctxFiles, null);
        const code = "【审查对象（符号 / 主题）】" + a.target +
          (a.prompt && String(a.prompt).trim() ? ("\n【具体审查侧重】" + String(a.prompt).trim()) : "");
        const srcLabel = "审查对象：" + a.target;
        const prompt =
          "你是一名资深代码审查与解释助手，擅长 Lua / GMod Lua / 通用编程语言。用简体中文回答，结论优先，并给出具体修改建议。\n" +
          (contextBlock ? contextBlock : NO_CTX_WARNING) +
          srcLabel + "\n\n```\n" + code + "\n```\n\n" + CRITIQUE_INSTRUCTION;
        const requestedModel = a.model || "deepseek-reasoner";
        let res;
        try {
          res = await serialize(() => askDeepSeek(prompt, requestedModel, null, false));
        } catch (err) {
          // 首轮失败（会话失效 / token 轮换）开新会话重试一次
          res = await serialize(() => askDeepSeek(prompt, requestedModel, null, false));
        }
        const newId = randomUUID();
        const conv = { id: newId, sessionId: res.sessionId, parentId: String(res.respId || 0), model: requestedModel, updated: Date.now(), lastText: res.text || "" };
        conversations.set(newId, conv);
        saveConversations();
        let out = "【证据收集摘要】grep `" + a.target + "` 命中 " + grepped.count + " 条，本次取前 " + ctxFiles.length + " 处作为已核实证据：\n";
        for (const c of ctxFiles) out += "  • " + c.path + " 第 " + c.start_line + "–" + c.end_line + " 行\n";
        if (!ctxFiles.length) out += "  （未命中任何文件——将仅基于符号名做挑刺，跨文件结论请务必以本地检索为准）\n";
        out += "\n— — —\n";
        if (res.reasoning && requestedModel.includes("reasoner")) out += "【思考过程】\n" + res.reasoning + "\n\n【挑刺结果】\n";
        out += res.text || "";
        out += "\n\n— — —\n对话ID（把答案喂回此 ID 让网页端评分，或继续追问）：" + conv.id;
        return { content: [{ type: "text", text: out }] };
      } else if (name === "web_conversation_list") {
        const arr = [...conversations.values()].sort((x, y) => (y.updated || 0) - (x.updated || 0));
        if (!arr.length) return { content: [{ type: "text", text: "（当前没有活跃对话）" }] };
        let txt = "活跃对话 " + arr.length + " 个（最多保留 100）：\n";
        for (const c of arr) {
          const preview = String(c.lastText || "").replace(/\s+/g, " ").slice(0, 90);
          txt += "  • " + c.id + "  [" + (c.model || "?") + "]  " + new Date(c.updated || 0).toISOString() + "\n    " + preview + "\n";
        }
        return { content: [{ type: "text", text: txt }] };
      } else if (name === "web_conversation_clear") {
        const a = args || {};
        const all = a.all === true || String(a.all || "").toLowerCase() === "true";
        if (all) {
          const n = conversations.size;
          conversations.clear();
          saveConversations();
          return { content: [{ type: "text", text: "已清空全部 " + n + " 个对话。" }] };
        }
        if (!a.conversation_id) throw new Error("需给 conversation_id（删除单条）或 all:true（清空全部）");
        if (!conversations.has(a.conversation_id)) throw new Error("对话ID不存在：" + a.conversation_id);
        conversations.delete(a.conversation_id);
        saveConversations();
        return { content: [{ type: "text", text: "已删除对话：" + a.conversation_id }] };
      }
      return { content: [{ type: "text", text: "未知工具: " + name }], isError: true };
    } catch (err) {
      const msg = String((err && err.message) || err);
      return { content: [{ type: "text", text: msg }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[deepseek-web-mcp] ready · " + TOOLS.length + " tools · v" + SERVER_VERSION + " · 纯 Node 直连网页端(无 Python/代理)");
}

main().catch((e) => {
  console.error("[deepseek-web-mcp] fatal:", e);
  process.exit(1);
});
