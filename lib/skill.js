/**
 * 运行时技能：把「怎么用网页端模型」这件事交给模型自己判断。
 *
 * source 用 'runtime'（进程内贡献，rank 250）：不需要往磁盘放 SKILL.md，
 * 插件挂载即可出现在模型的技能目录里。
 *
 * @module dsh-deepseek-web/skill
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 技能名（kebab-case，模型的技能目录里显示这个名字）。 */
export const SKILL_NAME = 'deepseek-web'

/** 技能资源目录（SKILL.md 里引用的文件都相对于它）。 */
export const SKILL_RESOURCE_BASE = fileURLToPath(new URL('../assets/skill/', import.meta.url))

/** 技能正文。 */
export const SKILL_CONTENT = readFileSync(new URL('../assets/skill/SKILL.md', import.meta.url), 'utf8')

/** 交给 ctx.skills.register 的描述符。 */
export const DEEPSEEK_WEB_SKILL = {
  name: SKILL_NAME,
  description:
    '用登录好的 DeepSeek 网页版（chat.deepseek.com）回答或分析：把问题、代码片段、文件行区间发给网页端模型，'
    + '拿回它的回答。支持「从第 xx 行看到 xx 行分析」、深度思考、联网搜索与多轮上下文，'
    + '也可以用来要一份与本地模型不同的第二意见。当用户点名「DeepSeek 网页版 / 官网模型 / R1 深度思考」，'
    + '或需要用行号精确定位一段代码做分析时使用。',
  whenToUse:
    '需要 DeepSeek 网页端模型本身作答、需要对某个文件的第 xx–xx 行做行号级分析、'
    + '需要深度思考或联网搜索的第二意见、或用户明确要求「用网页版」时使用。',
  source: 'runtime',
  resourceBase: { kind: 'directory', path: SKILL_RESOURCE_BASE },
  content: SKILL_CONTENT,
}
