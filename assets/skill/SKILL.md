# DeepSeek 网页版（deepseek-web）

这个技能把 DSH 接到**你自己账号的 DeepSeek 网页版**（chat.deepseek.com）上。
它不是本地模型：每次调用都是真实的一次网页端对话，走 PoW 挑战 + SSE 流式，
所以**慢**（通常 5–60 秒）且同一时刻只能有一路流。

## 什么时候用它

- 用户明确说「用 DeepSeek 网页版 / 官网 / 网页端模型」。
- 用户要求「从第 xx 行看到 xx 行分析」，需要**带行号**的精确定位结论。
- 需要**第二意见**：本地模型已给出方案，想让另一个模型独立复核对错。
- 需要网页端特有的能力：深度思考（R1 风格推理）、联网搜索。

不要用它做常规工作：普通任务直接用 DSH 自己的模型更快也更省。

## 三个工具

| 工具 | 用途 |
|---|---|
| `deepseek_web_analyze_lines` | 读文件第 `start_line`–`end_line` 行并让网页端模型分析（首选，行号感知） |
| `deepseek_web_ask` | 直接问一个问题（可开深度思考 / 联网搜索 / 新会话） |
| `deepseek_web_status` | 看登录状态、凭据来源、token 摘要、账号 id |

## 行区间分析怎么用

```
deepseek_web_analyze_lines({
  path: "C:/proj/src/server.js",
  start_line: 120,
  end_line: 180,
  focus: "错误处理与并发",
  instruction: "只列问题和行号，不要重写代码"
})
```

要点：

1. **先读文件确认行号**：`end_line` 省略时读到文件末尾；区间行数上限由设置 `maxLines` 控制（默认 400）。
2. **一次只分析一个区间**。区间太长会被拒绝，拆成多次调用比一次塞进去更准。
3. `instruction` 会作为「本次任务的特别要求（优先满足）」原样追加，适合收窄输出。
4. 返回里带 `startLine`/`endLine`/`totalLines`，可以核对到底分析了哪些行。
5. 想复现同一段上下文，给同一个 `label`：同一 label 复用同一个网页端会话（多轮）。

## 多轮与隔离

每次调用默认落在**本 DSH 会话 + label** 对应的那个网页端会话里，所以追问是连续的；
换 `label` 或传 `fresh: true` 就会开新会话，避免上下文串味。

## 失败时怎么办

- 报「尚未登录」或 token 过期：让用户在 **DSH 设置 → DeepSeek 网页版** 里点
  「一键登录（打开 Edge）」，或粘贴浏览器里的 token；也可以从原 python 项目的
  `credentials.json` 导入。
- 报 PoW/WASM 错误：插件内置的 `sha3_wasm_bg.wasm` 缺失或 `wasmPath` 配置有误。
- 报区间超限：拆小区间，或在设置里调大 `maxLines` / `maxChars`。

## 边界

- 只用于个人学习与自动化，遵守 DeepSeek 服务条款，不要高频轰炸。
- 网页端账号同一时刻只允许一路流式请求，工具调用是**串行**的；不要并发发起多个。
- 发给网页端的内容会离开本机，敏感代码/凭据不要发。