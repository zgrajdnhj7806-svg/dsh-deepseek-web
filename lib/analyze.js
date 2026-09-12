/**
 * 行区间抽取 + 代码分析提示词组装。
 *
 * 这是「从第 xx 行看到 xx 行分析」这条需求的实现核心：把文件的一个行区间
 * 抽出来（带行号、按字符预算截断），包成给 DeepSeek 网页端模型的分析请求。
 *
 * @module dsh-deepseek-web/analyze
 */
import { readFile } from 'node:fs/promises'

/** 单次请求附带的代码文本上限（字符）。 */
export const DEFAULT_MAX_CHARS = 60_000

/** 行区间读取失败。 */
export class LineRangeError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'LineRangeError'
  }
}

/**
 * 读取文件的指定行区间。
 *
 * @param {string} filePath - 文件路径。
 * @param {number} startLine - 起始行（1 基，含）。
 * @param {number} [endLine] - 结束行（1 基，含）；省略时读到文件末尾。
 * @param {{maxChars?: number, withLineNumbers?: boolean}} [options]
 * @returns {Promise<{path: string, startLine: number, endLine: number, totalLines: number,
 *   text: string, numbered: string, chars: number, truncated: boolean}>}
 */
export async function readLineRange(filePath, startLine, endLine, options = {}) {
  const { maxChars = DEFAULT_MAX_CHARS, withLineNumbers = true } = options
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    throw new LineRangeError(`无法读取文件 ${filePath}：${error.message}`, { cause: error })
  }
  const lines = raw.split(/\r?\n/)
  // 末尾换行会切出一个空串，统计总行数时忽略它。
  const totalLines = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new LineRangeError(`start_line 必须是 >= 1 的整数，收到 ${startLine}`)
  }
  if (totalLines === 0) {
    throw new LineRangeError(`文件 ${filePath} 是空的`)
  }
  const from = Math.min(startLine, totalLines)
  const to = endLine === undefined || endLine === null ? totalLines : Math.min(Math.max(endLine, from), totalLines)
  const slice = lines.slice(from - 1, to)
  const width = String(to).length
  let body = withLineNumbers
    ? slice.map((line, index) => `${String(from + index).padStart(width, ' ')}| ${line}`).join('\n')
    : slice.join('\n')
  let truncated = false
  if (body.length > maxChars) {
    truncated = true
    body = `${body.slice(0, maxChars)}\n…[已截断：区间过长，仅保留前 ${maxChars} 个字符]`
  }
  return {
    path: filePath,
    startLine: from,
    endLine: to,
    totalLines,
    text: slice.join('\n'),
    numbered: body,
    chars: body.length,
    truncated,
  }
}

/** 根据扩展名猜一个语言标签，仅用于提示词可读性。 */
export function guessLanguage(filePath) {
  const ext = (filePath.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase()
  const table = {
    js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript',
    jsx: 'JavaScript', py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java',
    c: 'C', h: 'C', cpp: 'C++', hpp: 'C++', cs: 'C#', php: 'PHP', sh: 'Shell', ps1: 'PowerShell',
    sql: 'SQL', json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML', md: 'Markdown', html: 'HTML',
    css: 'CSS', vue: 'Vue', lua: 'Lua', kt: 'Kotlin', swift: 'Swift',
  }
  return table[ext] ?? ''
}

/**
 * 组装「分析某个文件行区间」的提示词。
 *
 * @param {{path: string, startLine: number, endLine: number, totalLines: number, numbered: string,
 *   truncated: boolean}} range
 * @param {{instruction?: string, focus?: string, extra?: string}} [options]
 * @returns {string}
 */
export function buildLineAnalysisPrompt(range, options = {}) {
  const language = guessLanguage(range.path)
  const instruction = (options.instruction ?? '').trim()
  const focus = (options.focus ?? '').trim()
  const parts = []
  parts.push(
    `请分析文件 \`${range.path}\` 的第 ${range.startLine}–${range.endLine} 行`
    + `（该文件共 ${range.totalLines} 行）${language === '' ? '' : `，语言：${language}`}。`,
  )
  parts.push('代码（行号 | 内容）：')
  parts.push('```' + (language === '' ? '' : language.toLowerCase()))
  parts.push(range.numbered)
  parts.push('```')
  if (range.truncated) parts.push('注意：上面只给出了区间的前一部分（已截断），结论请基于可见内容。')
  parts.push('请按以下要求输出：')
  parts.push('1. 这段代码的职责与关键流程；')
  parts.push('2. 它依赖的外部接口、数据结构与副作用（读写文件/网络/全局状态）；')
  parts.push('3. 潜在问题：边界条件、错误处理、资源释放、并发与性能；')
  parts.push('4. 如需改动，给出具体建议并标注对应行号。')
  if (focus !== '') parts.push(`额外关注点：${focus}`)
  if (instruction !== '') parts.push(`本次任务的特别要求（优先满足）：${instruction}`)
  if (options.extra !== undefined && options.extra.trim() !== '') {
    parts.push('补充材料：')
    parts.push(options.extra)
  }
  parts.push('请用中文回答，直接给结论，不要复述整段代码。')
  return parts.join('\n')
}