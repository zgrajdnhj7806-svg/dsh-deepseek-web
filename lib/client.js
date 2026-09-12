/**
 * dsh-deepseek-web —— 浏览器半边（DSH 设置 → 「DeepSeek 网页版」分区）。
 *
 * 产物形态是 DSH 客户端要求的 **classic script + lazy-CJS 工厂**：
 * 顶层不能出现 import/export，React 由 shell 作为平台种子提供。
 *
 * 这一半只做界面：所有读写都通过宿主半区的同源路由
 * `/_dsh/deepseek-web/*`，token/cookie 永远不经过浏览器状态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-web',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const ROUTE = '/_dsh/deepseek-web'
    const SECTION_ID = 'deepseek-web'
    const STYLE_ID = 'dsh-deepseek-web-style'

    const CSS = [
      '.dsw-root{display:flex;flex-direction:column;gap:18px;padding:4px 2px 24px;font-size:13px;line-height:1.6}',
      '.dsw-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
      '.dsw-title{font-size:14px;font-weight:600;margin:0}',
      '.dsw-hint{opacity:.72;font-size:12px;margin:0}',
      '.dsw-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.dsw-field{display:flex;flex-direction:column;gap:4px;min-width:220px;flex:1}',
      '.dsw-field>label{font-size:12px;opacity:.8}',
      '.dsw-input{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit}',
      '.dsw-btn{padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:inherit;font:inherit;cursor:pointer}',
      '.dsw-btn[disabled]{opacity:.5;cursor:default}',
      '.dsw-btn.primary{background:var(--dsw-alias-state-business-primary,#3b6cf6);border-color:transparent;color:#fff}',
      '.dsw-badge{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35))}',
      '.dsw-badge.ok{color:#1a9d5a;border-color:rgba(26,157,90,.5)}',
      '.dsw-badge.bad{color:#e05252;border-color:rgba(224,82,82,.5)}',
      '.dsw-note{margin:0;font-size:12px;padding:8px 10px;border-radius:8px;white-space:pre-wrap;word-break:break-word}',
      '.dsw-note.ok{background:rgba(26,157,90,.12)}',
      '.dsw-note.error{background:rgba(224,82,82,.14)}',
      '.dsw-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:12px}',
      '.dsw-kv dt{opacity:.7}.dsw-kv dd{margin:0;word-break:break-all}',
      '.dsw-switch{display:flex;align-items:center;gap:6px;font-size:12px}',
      '.dsw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}',
    ].join('\n')

    /** 只在第一次挂载时注入样式。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** 同源调用宿主路由，统一解信封。 */
    async function call(action, body, method) {
      const init = { method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin' }
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      const response = await fetch(ROUTE + '/' + action, init)
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        throw new Error('接口返回了非 JSON 内容（HTTP ' + response.status + '）')
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const message = payload && payload.error ? payload.error.message : 'HTTP ' + response.status
        throw new Error(message)
      }
      return payload.value
    }

    /** 设置页分区组件。 */
    function Section() {
      const [status, setStatus] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [token, setToken] = React.useState('')
      const [cookie, setCookie] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [note, setNote] = React.useState(null)

      const refresh = React.useCallback(async () => {
        const next = await call('status')
        setStatus(next)
        return next
      }, [])

      React.useEffect(() => {
        let alive = true
        refresh().catch((error) => {
          if (alive) setNote({ kind: 'error', text: '读取状态失败：' + error.message })
        })
        return () => { alive = false }
      }, [refresh])

      // 一键登录期间轮询状态。
      React.useEffect(() => {
        if (status === null || status.loginState !== 'running') return undefined
        const timer = setInterval(() => { refresh().catch(() => {}) }, 2000)
        return () => clearInterval(timer)
      }, [status, refresh])

      // 首次拿到设置后建立草稿。
      React.useEffect(() => {
        if (status !== null && draft === null && status.settings !== undefined) setDraft({ ...status.settings })
      }, [status, draft])

      /** 统一包一层动作：处理 busy / note / 刷新。 */
      const run = async (key, action, okText) => {
        setBusy(key)
        setNote(null)
        try {
          const message = await action()
          await refresh()
          setNote({ kind: 'ok', text: typeof message === 'string' ? message : okText })
        } catch (error) {
          setNote({ kind: 'error', text: error.message })
        } finally {
          setBusy('')
        }
      }

      if (status === null) {
        return h('div', { className: 'dsw-root' }, h('p', { className: 'dsw-hint' }, '正在读取 DeepSeek 网页版状态…'))
      }

      const loggedIn = status.loggedIn === true
      const running = status.loginState === 'running'
      const settings = (draft !== null ? draft : status.settings) || {}

      const setField = (key, value) => setDraft({ ...settings, [key]: value })
      const setBool = (key) => (event) => setField(key, event.target.checked)

      const statusCard = h('section', { className: 'dsw-card' }, [
        h('div', { key: 'head', className: 'dsw-row' }, [
          h('h3', { key: 'title', className: 'dsw-title' }, '登录状态'),
          h('span', { key: 'badge', className: 'dsw-badge ' + (loggedIn ? 'ok' : 'bad') }, loggedIn ? '已登录' : '未登录'),
          running ? h('span', { key: 'run', className: 'dsw-badge' }, '等待浏览器登录…') : null,
        ]),
        h('dl', { key: 'kv', className: 'dsw-kv' }, [
          h('dt', { key: 'tk' }, 'token'), h('dd', { key: 'tv' }, loggedIn ? status.tokenPreview : '（未保存）'),
          h('dt', { key: 'ck' }, 'cookie'), h('dd', { key: 'cv' }, status.cookieConfigured ? '已保存' : '（无，可选）'),
          h('dt', { key: 'sc' }, '存放位置'), h('dd', { key: 'sv' }, status.source === 'credentials-service'
            ? 'DSH 凭据服务 .credentials.yaml（0600）'
            : status.source === 'plugin-file' ? status.dataDir + '\\credentials.json' : status.source === 'legacy-file' ? status.legacyPath + '（只读导入，点上方「从 credentials.json 导入」可转为正式保存）' : '尚未保存'),
          h('dt', { key: 'ws' }, 'PoW WASM'), h('dd', { key: 'wv' }, status.wasmOk ? '就绪' : ('缺失：' + status.wasmMessage)),
        ]),
        running && status.loginProgress ? h('p', { key: 'prog', className: 'dsw-hint' }, status.loginProgress) : null,
        h('div', { key: 'actions', className: 'dsw-row' }, [
          h('button', {
            key: 'browser', type: 'button', className: 'dsw-btn primary',
            disabled: busy !== '' || running || settings.autoLogin === false,
            onClick: () => run('browser', async () => {
              const result = await call('login', { mode: 'browser' })
              return result.message || '已打开浏览器，请在其中完成 DeepSeek 登录'
            }, '已打开浏览器'),
          }, running ? '等待登录…' : '一键登录（打开 Edge）'),
          h('button', {
            key: 'import', type: 'button', className: 'dsw-btn', disabled: busy !== '' || !status.legacyAvailable,
            onClick: () => run('import', async () => {
              const result = await call('login', { mode: 'import' })
              return result.message
            }, '已导入'),
          }, '从 credentials.json 导入'),
          h('button', {
            key: 'test', type: 'button', className: 'dsw-btn', disabled: busy !== '' || !loggedIn,
            onClick: () => run('test', async () => {
              const result = await call('test', {})
              return '连通成功，网页端回复：' + result.answer
            }, '连通成功'),
          }, busy === 'test' ? '测试中…' : '测试连接'),
          h('button', {
            key: 'logout', type: 'button', className: 'dsw-btn', disabled: busy !== '' || !loggedIn,
            onClick: () => run('logout', async () => {
              await call('logout', {})
              return '已清除登录态'
            }, '已清除'),
          }, '退出登录'),
        ]),
        h('p', { key: 'tip', className: 'dsw-hint' },
          '一键登录会拉起 Edge（独立 profile），登录一次即可长期复用；'
          + '也可以直接从浏览器 DevTools 的 /api/v0/chat/completion 请求头里复制 Authorization: Bearer 后面的 token。'),
      ])

      const manualCard = h('section', { className: 'dsw-card' }, [
        h('h3', { key: 't', className: 'dsw-title' }, '手工粘贴登录态'),
        h('div', { key: 'f', className: 'dsw-grid' }, [
          h('div', { key: 'token', className: 'dsw-field' }, [
            h('label', { key: 'l', htmlFor: 'dsw-token' }, 'token（必填）'),
            h('input', {
              key: 'i', id: 'dsw-token', className: 'dsw-input', type: 'password', autoComplete: 'off',
              value: token, placeholder: loggedIn ? '已保存，留空表示不修改' : '粘贴 Bearer token',
              onChange: (event) => setToken(event.target.value),
            }),
          ]),
          h('div', { key: 'cookie', className: 'dsw-field' }, [
            h('label', { key: 'l', htmlFor: 'dsw-cookie' }, 'cookie（可选，提升成功率）'),
            h('input', {
              key: 'i', id: 'dsw-cookie', className: 'dsw-input', type: 'password', autoComplete: 'off',
              value: cookie, placeholder: '可留空',
              onChange: (event) => setCookie(event.target.value),
            }),
          ]),
        ]),
        h('div', { key: 'a', className: 'dsw-row' },
          h('button', {
            type: 'button', className: 'dsw-btn', disabled: busy !== '' || token.trim() === '',
            onClick: () => run('manual', async () => {
              const result = await call('login', { mode: 'manual', token: token, cookie: cookie })
              setToken('')
              setCookie('')
              return result.message
            }, '已保存'),
          }, busy === 'manual' ? '保存中…' : '保存登录态')),
      ])

      const settingsCard = h('section', { className: 'dsw-card' }, [
        h('h3', { key: 't', className: 'dsw-title' }, '插件设置'),
        h('div', { key: 'g', className: 'dsw-grid' }, [
          h('div', { key: 'thinking', className: 'dsw-field' },
            h('label', { className: 'dsw-switch' }, [
              h('input', { key: 'i', type: 'checkbox', checked: settings.defaultThinking === true, onChange: setBool('defaultThinking') }),
              h('span', { key: 's' }, '默认开启深度思考'),
            ])),
          h('div', { key: 'search', className: 'dsw-field' },
            h('label', { className: 'dsw-switch' }, [
              h('input', { key: 'i', type: 'checkbox', checked: settings.defaultSearch === true, onChange: setBool('defaultSearch') }),
              h('span', { key: 's' }, '默认开启联网搜索'),
            ])),
          h('div', { key: 'auto', className: 'dsw-field' },
            h('label', { className: 'dsw-switch' }, [
              h('input', { key: 'i', type: 'checkbox', checked: settings.autoLogin !== false, onChange: setBool('autoLogin') }),
              h('span', { key: 's' }, '允许一键登录拉起浏览器'),
            ])),
          h('div', { key: 'enabled', className: 'dsw-field' },
            h('label', { className: 'dsw-switch' }, [
              h('input', { key: 'i', type: 'checkbox', checked: settings.enabled !== false, onChange: setBool('enabled') }),
              h('span', { key: 's' }, '启用工具与技能'),
            ])),
          h('div', { key: 'maxLines', className: 'dsw-field' }, [
            h('label', { key: 'l' }, '单次分析最大行数'),
            h('input', {
              key: 'i', className: 'dsw-input', type: 'number', min: 1, value: settings.maxLines === undefined ? '' : settings.maxLines,
              onChange: (event) => setField('maxLines', Number(event.target.value)),
            }),
          ]),
          h('div', { key: 'timeout', className: 'dsw-field' }, [
            h('label', { key: 'l' }, '单次请求超时（毫秒）'),
            h('input', {
              key: 'i', className: 'dsw-input', type: 'number', min: 5000, step: 1000,
              value: settings.timeoutMs === undefined ? '' : settings.timeoutMs,
              onChange: (event) => setField('timeoutMs', Number(event.target.value)),
            }),
          ]),
          h('div', { key: 'browser', className: 'dsw-field' }, [
            h('label', { key: 'l' }, '浏览器路径（留空自动探测）'),
            h('input', {
              key: 'i', className: 'dsw-input', type: 'text',
              value: settings.browserPath || '', placeholder: status.browserPath || '未找到 Edge/Chrome',
              onChange: (event) => setField('browserPath', event.target.value),
            }),
          ]),
          h('div', { key: 'creds', className: 'dsw-field' }, [
            h('label', { key: 'l' }, '待导入的 credentials.json 路径'),
            h('input', {
              key: 'i', className: 'dsw-input', type: 'text',
              value: settings.credentialsPath || '', placeholder: status.legacyPath,
              onChange: (event) => setField('credentialsPath', event.target.value),
            }),
          ]),
        ]),
        h('div', { key: 'a', className: 'dsw-row' },
          h('button', {
            type: 'button', className: 'dsw-btn primary', disabled: busy !== '',
            onClick: () => run('save', async () => {
              await call('settings', { patch: {
                enabled: settings.enabled !== false,
                autoLogin: settings.autoLogin !== false,
                defaultThinking: settings.defaultThinking === true,
                defaultSearch: settings.defaultSearch === true,
                maxLines: Number(settings.maxLines) || 400,
                timeoutMs: Number(settings.timeoutMs) || 180000,
                browserPath: settings.browserPath || '',
                credentialsPath: settings.credentialsPath || '',
              } })
              return '设置已保存'
            }, '设置已保存'),
          }, busy === 'save' ? '保存中…' : '保存设置')),
      ])

      return h('div', { className: 'dsw-root' }, [
        note !== null ? h('p', { key: 'note', className: 'dsw-note ' + note.kind }, note.text) : null,
        statusCard,
        manualCard,
        settingsCard,
        h('p', { key: 'foot', className: 'dsw-hint' },
          '工具：deepseek_web_ask / deepseek_web_analyze_lines（从第 xx 行看到 xx 行分析）/ deepseek_web_status；'
          + '技能：deepseek-web。仅用于个人学习与自动化，请遵守 DeepSeek 服务条款。'),
      ])
    }

    /** 客户端插件入口。 */
    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: 45,
        label: () => 'DeepSeek 网页版',
        inject: () => ({}),
      }, Section))
    }

    return { apply: apply, inject: ['slots'] }
  },
})
