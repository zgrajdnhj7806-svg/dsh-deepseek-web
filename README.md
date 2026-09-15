# dsh-deepseek-web

把**你自己账号的 DeepSeek 网页版**（chat.deepseek.com）接进 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的插件：

模型可以直接调用网页端提问 / **按行区间（第 xx 行到 xx 行）分析文件**，DSH 设置页里带一个一键登录面板，免 API Key、免客户端回环。

> 纯 Node 实现：PoW 用 Node 内置 WebAssembly 跑官方 `sha3_wasm_bg.wasm`，登录用 Edge/CDP 自动抓取，零 Python/Playwright 依赖。

## 特性

| 类型 | 名字 | 说明 |
|---|---|---|
| 模型工具 | `deepseek_web_analyze_lines` | 读文件第 `start_line`–`end_line` 行，交给网页端模型分析；提示词带行号，回答可引用行号 |
| 模型工具 | `deepseek_web_ask` | 直接提问；支持深度思考 / 联网搜索 / 新会话 / 多轮 |
| 模型工具 | `deepseek_web_status` | 登录状态、token 摘要、凭据来源、账号 id |
| 运行时技能 | `deepseek-web` | 告诉模型什么时候该用网页端模型、怎么用行区间分析 |
| 设置分区 | 设置 → **DeepSeek 网页版** | 登录状态 + 一键登录 / 导入 / 手工粘贴 / 测试 / 退出 + 插件设置 |

三个工具都是**串行**的：DeepSeek 免费账号同一时刻只允许一路流式请求。

## ⚠️ 账号安全（务必先读）

本项目直接调用**你本人账号**的 DeepSeek 网页版（chat.deepseek.com），行为与你在浏览器里手动提问完全一样。请务必遵守：

1. **只支持单线程，不支持并发/并行提问**。插件刻意把所有调用做成**全串行**：
   三个工具共用同一条流式通道，同一时刻只会有一个网页端请求在线。请**不要**自行并发调用、
   「多开」多个实例，或绕过插件并行发请求——免费账号同一时刻只允许一路流式，并发必失败。
2. **不高频轰炸**。请保持接近真人提问的节奏（一次一问、串行推进）。高频、批量、自动化轰炸
   会触发 DeepSeek 的风控，可能导致账号被限流、临时冻结甚至封禁，**后果由使用者自负**。
3. **仅限个人学习与自动化**。请遵守 DeepSeek 服务条款，不要用于违反条款的任何用途；
   发给网页端的内容会离开本机，敏感代码与凭据不要发送。

> 一句话：**当单线程用，别当 API 用。**

## 环境要求

- Node.js **>= 20**（DeepSeek 官方推荐 >= 22.19 或 >= 24）
- 已安装并初始化 dsh（`npm install -g @deepseek-ai/dsh`，[官方快速开始](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)）

## 一条命令安装

**Windows（PowerShell）**

```powershell
irm https://raw.githubusercontent.com/zgrajdnhj7806-svg/dsh-deepseek-web/main/scripts/install.ps1 | iex
```

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/zgrajdnhj7806-svg/dsh-deepseek-web/main/scripts/install.sh | bash
```

脚本会做两件事：

1. `dsh plugin --profile web add github:zgrajdnhj7806-svg/dsh-deepseek-web`（把插件作为依赖装进 web profile）；
2. 把 `dsh-deepseek-web` 追加到 profile 的 `dsh.profile.bundles` 列表（dsh 按层栈加载插件的那一步）。

装完**重启 dsh** 即生效：

```bash
dsh web
```

### 手动安装（等价步骤，不想跑脚本时用）

```bash
dsh plugin --profile web add github:zgrajdnhj7806-svg/dsh-deepseek-web
# 编辑 ~/.dsh/profiles/web/package.json：在 dsh.profile.bundles 数组里追加 "dsh-deepseek-web"
```

## 另一个形态：`v1.0/`（MCP 服务版）

`v1.0/` 是同一套网页端协议的另一份**独立实现**：一个纯 stdio 的 MCP 服务器，不依赖 dsh 的插件体系，
任何支持 MCP 的客户端都能接入；只想把它当「网页端模型代理」用时选这个。

**环境要求**：Node.js **>= 18**（PoW 用 Node 内置 WebAssembly 直跑官方 `sha3_wasm_bg.wasm`，依旧零 Python / 零代理）

```bash
cd v1.0
npm install        # 只装 @modelcontextprotocol/sdk
```

> 请**保留仓库目录结构**：`v1.0/src/pow.mjs` 在本目录找不到 wasm 时会向上找 `assets/sha3_wasm_bg.wasm[.b64]`。
> 只把 `v1.0/` 单独拷走的话，要么连 `assets/` 一起拷，要么把 `sha3_wasm_bg.wasm`（或 `.wasm.b64`）放进 `v1.0/src/`。

**注册**：把 [v1.0/cordis.patch.yml](v1.0/cordis.patch.yml) 里的 `- insert:` 段合并进
`<DSH_HOME>/profiles/web/cordis.patch.yml` 的顶层数组，并把 `args` 里的 `<本目录>` 换成 `v1.0/` 的绝对路径：

```yaml
- insert:
    - id: mcp-deepseek-web
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: deepseek-web
        command: node
        args:
          - '<v1.0 绝对路径>/src/index.mjs'
        env:
          DEEPSEEK_WEB_TOKEN: '<网页端 userToken>'
          DEEPSEEK_WEB_COOKIE: '<网页端 cookie>'
          # DWH_ROOT: '<项目根绝对路径>'
          # DEEPSEEK_WEB_CREDENTIALS: '<credentials.json 绝对路径>'
```

**环境变量（`env` 段）**

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_WEB_TOKEN` | 是* | 网页端 userToken（F12 → `/api/v0/chat/completion` → `Authorization: Bearer` 后面的值） |
| `DEEPSEEK_WEB_COOKIE` | 否 | 同一次请求的 `Cookie` |
| `DEEPSEEK_WEB_CREDENTIALS` | 否 | 指向 `{ "token": …, "cookie": … }` 的 JSON 文件 |
| `DWH_ROOTS` | 否 | `fs_*` 工具的允许根目录，逗号 / 分号分隔可配多个 |
| `DWH_ROOT` | 否 | 单个默认根目录；与 `DWH_ROOTS` 都没有时用用户主目录 |

> *凭据取用优先级：`DEEPSEEK_WEB_TOKEN` 环境变量 → `DEEPSEEK_WEB_CREDENTIALS` 指向的文件 → `v1.0/credentials.json`。

**自带 8 个工具**

| 工具 | 说明 |
|---|---|
| `web_analyze_range` | 把内容交给网页端模型分析：给 `file` + `start_line`/`end_line` 读文件区间，或直接给 `code`；支持 `summary`/`analyze`/`explain`/`critique`/`implement`、多轮 `conversation_id`、`search=true` 联网、`save_result` 存档 |
| `critique_workspace` | 对工作区做对抗式审查（挑刺 / 找漏洞） |
| `deep_simulate` | 「进程模拟推演 + 挑刺」一键工作流：目录树 → `fs_grep` 取证 → 三阶段推演（执行过程 / 可能走向 / 挑刺），支持 `syntax_notes` 提交语法陷阱 |
| `fs_list` | 列目录（限定在允许根内，防越界） |
| `fs_read` | 读文件（同上） |
| `fs_grep` | 内容检索（同上） |
| `web_conversation_list` | 列出当前会话池里的网页端对话 |
| `web_conversation_clear` | 按 `conversation_id` 删单条，或 `all=true` 清空会话池 |

**直接跑（调试用）**

```bash
node v1.0/src/index.mjs        # 按 MCP stdio 协议收发，ready 行打到 stderr
```

> 「⚠️ 账号安全」对 `v1.0/` 同样适用：**单线程、全串行，不要并发调用，不要高频轰炸**。

## 登录（三条路，从省事到兜底）

1. **一键登录（打开 Edge）** —— 设置页按钮。插件拉起本机 Edge（独立 profile，存在 `$DSH_HOME/cache/dsh-deepseek-web/browser_profile`），你在窗口里登录一次，插件用 CDP 读 `localStorage.userToken` 与 cookie 并保存，之后长期免登录。
2. **从 credentials.json 导入** —— 兼容其他工具导出的登录缓存（`{ "token": …, "cookie": … }`）；放到插件同级的 `credentials.json`，首次使用会自动**只读**迁移。
3. **手工粘贴 token** —— 浏览器 F12 → 网络 → `/api/v0/chat/completion` 请求头，复制 `Authorization: Bearer` 后面的值。

登录态默认写进 **DSH 凭据服务**（`$DSH_HOME/.credentials.yaml`，目录 0700 / 文件 0600，记录键 `deepseek-web/login`）；凭据服务不可用时回退到 `$DSH_HOME/cache/dsh-deepseek-web/credentials.json`（0600）。**token/cookie 不会写进 settings.yaml，也不会出现在任何发往浏览器的响应里**（界面只显示摘要）。

## 设置项（`settings.yaml` 的 `deepseek-web` 段）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 关掉后不注册工具与技能（设置页仍可用，方便修好再开） |
| `autoLogin` | true | 是否允许一键登录拉起浏览器 |
| `browserPath` | '' | Edge/Chrome 路径，留空自动探测 |
| `loginTimeoutMs` | 300000 | 等待用户完成登录的最长时间 |
| `credentialsPath` | '' | 待导入的 credentials.json；留空用插件同级的 `../credentials.json` |
| `wasmPath` | '' | PoW WASM 路径（支持 `.wasm` 或同路径 `.wasm.b64`），留空用插件内置 |
| `defaultThinking` / `defaultSearch` | false | `deepseek_web_ask` 的默认开关 |
| `timeoutMs` | 180000 | 单次网页端请求超时 |
| `maxLines` | 400 | 行区间分析一次最多多少行（超了直接拒绝，避免把整文件塞进去） |
| `maxChars` | 60000 | 行区间分析一次最多多少字符 |
| `conversationsPerSession` | 4 | 每个 DSH 会话最多缓存多少个网页端会话 |

## 自测与独立 CLI

插件带一个脱离 DSH 的独立 CLI `bin/dsweb.mjs`，以及宿主侧集成自测：

```bash
node _selftest.mjs            # 12 项：注册、凭据、路由围栏、真实行区间分析
node bin/dsweb.mjs --check
node bin/dsweb.mjs --file lib/pow.js --lines 30-52 --instruction "只关注内存安全"
```

## 文件结构

```
dsh-deepseek-web/
├── lib/
│   ├── index.js       插件入口：设置命名空间 + 工具 + 技能 + 路由
│   ├── config.js      schemastery 配置 schema 与默认值
│   ├── service.js     业务层（配置 + 凭据 + 客户端 + 会话池）
│   ├── tools.js       三个模型工具（defineTool）
│   ├── skill.js       运行时技能描述符
│   ├── web.js         宿主 HTTP 路由（同源围栏 + ok/error 信封）
│   ├── client.js      浏览器半边（设置分区，classic script 工厂）
│   ├── client-core.js DeepSeek 网页端客户端（PoW + SSE + 多轮）
│   ├── pow.js         Node 版 WASM PoW 解题器（.wasm / .wasm.b64 均可）
│   ├── analyze.js     行区间抽取 + 分析提示词组装
│   ├── login.js       Edge + CDP 一键登录
│   └── state.js       凭据存取（凭据服务 / 0600 文件 / 只读导入）
├── assets/sha3_wasm_bg.wasm.b64  官方 PoW 模块的 base64 文本（运行时自动解码）
├── assets/skill/SKILL.md         技能正文
├── bin/dsweb.mjs                 独立 CLI（--check / --prompt / --file --lines）
├── cordis.patch.yml              bundle patch 行
├── scripts/                      install.sh / install.ps1 一键安装
└── v1.0/                         独立的 MCP 服务版（package.json + src/index.mjs + src/pow.mjs + cordis.patch.yml）
```

## 已知限制

- **账号安全**：网页端账号同一时刻只允许一路流式，插件全串行、单线程；请勿并发调用或高频轰炸（详见上方「⚠️ 账号安全」）。
- token 会过期（几天到几周），过期后 `deepseek_web_status` / 报错信息会提示重新登录。
- 只有一层技能目录 / 行区间上限 `maxLines`，超限直接拒绝而不是截断——拆小区间更准。
- 一键登录会**弹出**一个可见浏览器窗口（这是设计如此：需要你手动过验证码/2FA）。
- 仅用于个人学习与自动化，请遵守 DeepSeek 服务条款；发给网页端的内容会离开本机。

## 许可

MIT © 2026 zgrajdnhj7806-svg

`assets/sha3_wasm_bg.wasm.b64` 是 chat.deepseek.com 网页端公开资源（DeepSeekHashV1 PoW 模块）的 base64 文本，版权归 DeepSeek 所有，仅随本插件分发用于协议兼容，请勿用于违反条款的用途。
