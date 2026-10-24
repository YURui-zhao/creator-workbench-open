import { Router } from 'express'
import {
  callDeepSeek,
  callProviderVision,
  DeepSeekError,
  getVisionModel,
  isProviderConfigured,
  resolveProvider
} from '../services/deepseek.js'
import {
  normalizeWeekCode,
  parseTimeCycleToWeekCode,
  weekToDateRange
} from '../utils/dateCycle.js'
import { parsePlayText, parsePriceText } from '../utils/screenshotValues.js'
import { normalizeContentType } from '../utils/recentPerformanceStats.js'
import { NEGOTIATION_REASON_TAG_VALUES } from '../utils/negotiationCase.js'

const router = Router()

function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, msg) {
  res.status(code).json({ code, data: null, msg })
}

/** 从请求头读取 AI 调用参数（前端配置优先，缺省由服务层兜底） */
function aiOptions(req) {
  return {
    provider: req.headers['x-ai-provider'],
    model: req.headers['x-ai-model'],
    apiKey: req.headers['x-ai-api-key']
  }
}

// ---------- 时间周期标准化（AI 兜底） ----------
const NORMALIZE_CACHE_MAX = 500
// 会话内缓存：原始值 -> 周码（含 null），避免相同值重复调用 AI
const normalizeCache = new Map()

/**
 * 本地二次校验：格式 ^YYYY-Wxx$，且对应区间必须是周一起始、完整 7 天、周一起始日在当年
 * @param {string} code AI 返回的候选周码
 * @returns {string|null} 合法则返回规范周码，否则 null（不直接使用）
 */
export function validateWeekCodeLocal(code) {
  const normalized = normalizeWeekCode(code)
  if (!normalized) return null
  const [yearText, weekText] = normalized.split('-W')
  try {
    const { start, end } = weekToDateRange(Number(weekText), Number(yearText))
    const startDate = new Date(`${start}T00:00:00`)
    const endDate = new Date(`${end}T00:00:00`)
    if (startDate.getDay() !== 1) return null // 起始必须是周一
    if (Math.round((endDate - startDate) / 86400000) !== 6) return null // 必须完整 7 天
    if (startDate.getFullYear() !== Number(yearText)) return null // 周一须落在当年
    return normalized
  } catch {
    return null
  }
}

/**
 * 组装时间周期归一化提示词
 * 统一输出 MM/DD-MM/DD（对齐系统自然周）；无法识别必须返回 "ERROR:具体原因"
 */
export function buildNormalizePrompt(values, year = new Date().getFullYear()) {
  return `
你是日期周期归一化助手。当前系统年份：${year}。
用户会给出一个「时间周期原始值」的 JSON 数组，请把每个值识别为它所属自然周，并统一输出 MM/DD-MM/DD 格式的完整周区间（如 08/17-08/23）。

规则（必须严格遵守）：
1. 输出格式：只输出 MM/DD-MM/DD（月/日-月/日，补零两位，如 08/17-08/23）。禁止输出周数（如 W33）、禁止输出年份、禁止输出其他格式。
2. 对齐系统自然周：系统每周从周一开始、周日结束。输入里的任意一个日期（含区间起始日），先判断它落在哪个自然周，再输出该完整自然周的周一~周日区间。例如输入 8-13（周四）→ 输出该周 08/10-08/16。
3. 年份缺失时按当前系统年份 ${year} 推断；跨年周（如 12月29日-1月4日）按真实日期处理。
4. 可识别写法（不限于此，业务里真实存在）：
   · 周数类：W33、w33、第33周、33周、2026年第33周、2026-W33
   · 区间类：8‑13~8‑19、8.13-8.19、8/13-8/19、8月13-19日、8月13日-8月19日、8月13日至19日、0813-0819、8-13-8-19、2026-08-13~2026-08-19、2026年8月13日至8月19日
   · 单日期类：2026-08-13、8月13日、08/13（取该日期所在自然周）
5. 无法确定唯一自然周时（区间不是完整自然周但可对齐的请按规则 2 对齐；完全无法解析、信息不足、日期非法、乱码等），该值必须返回字符串 "ERROR:具体原因"（中文，说明清楚原因），严禁编造日期。
6. 必须为每一个输入值输出一个键，键与原值完全一致，不得遗漏、不得新增键。

只输出一个严格 JSON 对象，不要输出任何多余文字、解释或 Markdown 代码块。输出格式示例：
{"W33":"08/17-08/23","8‑13~8‑19":"08/10-08/16","待定":"ERROR:无法解析该时间周期写法，请核对是否包含有效日期"}
`
}

/**
 * 用 AI 返回的映射生成本地二次校验后的结果
 * @param {string[]} values 去重后的原始值
 * @param {Object} aiMap AI 返回的 { 原始值: "MM/DD-MM/DD" | "YYYY-Wxx" | "ERROR:原因" | null }
 * @returns {Array<{ value: string, weekCode: string|null, error: string|null }>}
 */
export function applyAiNormalizeResults(values, aiMap = {}) {
  return values.map((value) => {
    const candidate = aiMap?.[value]
    const text = typeof candidate === 'string' ? candidate.trim() : ''
    if (!text) {
      return { value, weekCode: null, error: 'AI 未返回识别结果' }
    }
    // AI 显式失败：原样透传原因，供前端完整展示
    const errorMatch = /^ERROR\s*[:：]\s*(.+)$/i.exec(text)
    if (errorMatch) {
      return { value, weekCode: null, error: errorMatch[1].trim() || 'AI 无法识别该时间周期' }
    }
    // 兼容 AI 输出标准周码的情况
    const byCode = validateWeekCodeLocal(text)
    if (byCode) return { value, weekCode: byCode, error: null }
    // 规格要求的 MM/DD-MM/DD 输出：本地二次校验（必须周一起始、完整 7 天）
    const byLabel = parseTimeCycleToWeekCode(text)
    if (byLabel) return { value, weekCode: byLabel, error: null }
    return {
      value,
      weekCode: null,
      error: `AI 输出的内容不是合法自然周：${text}`
    }
  })
}

// 基础判定规则（始终生效）
const BASE_PROMPT = `
你是一名专业的数据质检专家，负责审核达人投放记录。用户会发送一个 JSON 数组，数组元素是投放记录对象，字段说明：
- time_cycle: 时间周期，如 "2024-W30"
- nickname: 达人昵称
- creator_type: 博主类型（如 美妆/科技/美食/穿搭/数码/生活/知识/职场/其他）
- homepage: 达人主页链接
- content_link: 植入内容链接
- video_link: 视频发布链接
- total_cost: 总花费（元，数字）
- publish_date: 发布日期，YYYY-MM-DD
- first_play: 7日播放量（整数，内容发布约 7 天时记录的累计播放量）
- second_week_play: 累计播放量（整数，最近一次更新时的累计播放量；这只是历史字段名，绝不代表「第二周新增播放量」）
- cpm_quote: CPM报价（可选字段，存在时才参与判定）
- rowIndex: Excel 行号（输入记录里原样携带，输出必须原样返回，禁止改写为数组下标）

请对【每一条记录】逐字段判定，并【只输出一个严格 JSON 对象】，不要输出任何多余文字、解释或 Markdown 代码块。输出格式：
{"records":[{"rowIndex":2,"pass":true,"level":"info","issues":[],"suggestions":[],"warnings":[],"errors":[],"corrected":null}]}

结构化问题项（warnings / errors 数组的元素）必须是对象，四个字段缺一不可：
{"rowIndex":2,"field":"second_week_play","reason":"累计播放量小于7日播放量，数据自相矛盾","suggestion":"核对原始数据后修正累计播放量，或先清空累计播放量标记为待更新"}
- rowIndex：该问题所属的 Excel 行号（与输入记录一致）
- field：涉及的字段名（如 time_cycle/nickname/total_cost/publish_date/first_play/second_week_play/creator_type/homepage/content_link/video_link）；无法定位具体字段时用 "record"
- reason：问题原因（中文，说明「哪里不对、为什么不合理」，不要只写「数据异常」）
- suggestion：可执行的优化/修正建议（中文，说明「怎么改」）

基础判定规则：
1. 必填字段：time_cycle、nickname、total_cost、publish_date 任一为空 → pass=false，level=error；first_play（7日播放量）与 second_week_play（累计播放量）均为可选，为空表示「未采集 / 待更新」，不得因二者为空判错
2. 格式判定：homepage/content_link/video_link 必须是合法 URL（http/https）；publish_date 必须是 YYYY-MM-DD；time_cycle 应形如 2024-W30
3. 数值合理性：total_cost 必填且为非负数字（0 是合法真实值，不得判为错误、不得要求大于 0）；first_play、second_week_play 为非负整数（0 是真实观察值，与「空值 = 未采集/待更新」严格区分）；若存在 cpm_quote，应在 5-200 合理区间
4. 业务逻辑：实际CPM（按累计播放量）= total_cost / second_week_play * 1000；7日CPM（按7日播放量）= total_cost / first_play * 1000（分母为空或 0 时不计算）；当 7日播放量与累计播放量同时有值时，累计播放量必须 ≥ 7日播放量，若「累计播放量 < 7日播放量」则该记录数据自相矛盾，必须标记 error；若记录含 cpm_quote 且实际CPM与报价偏差超过 ±30% → 标记异常；若不含 cpm_quote，实际CPM 超出 5-200 合理区间 → 标记 warning
5. 数据质量：明显录入错误或异常值（如昵称含乱码、链接含空格、播放量/金额异常巨大或为负数）→ 标记 warning 或 error

输出要求：
- rowIndex 必须与输入记录的 Excel 行号完全一致（输入里带的是 rowIndex，禁止用数组下标代替），每条输入记录都必须出现在 records 数组中，不得遗漏、不得新增
- pass: 存在 error 级问题时为 false，否则为 true
- level: 取该记录最高问题等级：无问题 info，仅建议/告警 warning，有必须修正的错误 error
- 警告（warning）与错误（error）的判定标准：
  · 警告 = 数据可以入库，但存在业务风险或可疑点（播放量异常、CPM 明显偏离合理区间、花费与播放量不匹配、博主类型与平台不匹配等）
  · 错误 = 数据不可入库（必填字段非法/缺失、时间周期或日期格式非法、数值为负、逻辑自相矛盾等）
- warnings：warning 级结构化问题数组，元素必须是 {rowIndex, field, reason, suggestion}
- errors：error 级结构化问题数组，元素必须是 {rowIndex, field, reason, suggestion}
- 常见警告必须给出明确建议（禁止模糊表述），参考：
  · 累计播放量为空 → 建议「补充最近一次累计播放量后再评估（未采集期间可保持留空，表示待更新）」
  · 累计播放量 < 7日播放量 → 标记 error，建议「核对原始数据，累计播放量不应小于7日播放量」
  · CPM 偏离合理区间（<5 或 >200）→ 建议「核对总花费与播放量口径，确认是否为异常投放」
  · 花费高但播放量低 → 建议「复核投放效果，考虑减少同类型达人投放」
  · 播放量异常巨大 → 建议「核对数据来源，确认是否存在刷量或统计口径错误」
- issues: 问题描述数组（中文，按字段说明；与 warnings/errors 的 reason 保持一致，可为空数组）
- suggestions: 修正建议数组（中文，可操作；与 warnings/errors 的 suggestion 保持一致，可为空数组）
- corrected: 仅提供供用户核对的候选建议值（如去除首尾空格、链接补全 https://），不代表记录已被修改；无法确定时填 null，不得编造数值。发布日期、投放档期归属和系统自然周不得在 corrected 中改写，只能在 suggestions 提醒用户核对
- issues、suggestions、warnings、errors 为空时输出空数组
`

// 智能补全能力（始终开启）
const COMPLETION_PROMPT = `
智能建议能力（corrected 只是供用户核对的候选值，不会自动写入；无法确定时不得编造）：
- 根据达人昵称自动推测博主类型 creator_type（如昵称含「美妆/护肤」→美妆，含「美食/探店」→美食，含「穿搭/时尚」→穿搭，含「数码/测评」→数码，无法确定时不填）
- 根据链接自动提取平台信息，写入 corrected.platform（平台名称，如 抖音/小红书/B站/快手/微博/视频号/其他）
- 日期格式或投放档期有疑问时，在 suggestions 中提醒用户核对原始数据；不要给出 corrected.publish_date 或 corrected.time_cycle，标准自然周由本地程序根据真实发布日期计算
- 数值格式建议（total_cost、first_play、second_week_play 等）：遇到「/」「-」「--」「无」「空」「暂无」「N/A」等占位写法时建议用户核对是否缺失；遇到「1.2万」「1万」「1,234」「￥1000」「1000元」等写法时可在 corrected 中给出候选标准数值（12000 / 10000 / 1234 / 1000 / 1000），但不得把推测值当作已确认事实；无法解析时在 suggestions 中提示
`

// 可选判定规则库（key 为前端勾选项）
const RULE_LIBRARY = {
  creator_type_cpm: {
    label: '达人类型CPM匹配判定',
    prompt: `
6. 达人类型CPM匹配判定：结合达人类型与平台判断CPM合理性。例如美妆类达人CPM不应超过50，穿搭/生活类一般不超过30；若CPM超限，在 issues 中标注「该达人CPM过高」，并在 suggestions 中给出「建议后续不再投放该达人」，level 标记为 warning 或 error。
`
  },
  time_cycle_format: {
    label: '时间周期格式判定',
    prompt: `
7. 时间周期格式判定：time_cycle 必须符合 YYYY-Wxx 格式（如 2024-W30），不合法时标记 error，并在 suggestions 中提示用户核对；不得自行改写标准自然周。
`
  },
  duplicate_check: {
    label: '重复数据判定',
    prompt: `
8. 重复数据判定：相同 nickname + 相同 publish_date 视为重复记录；同一组重复记录只保留第一条，后续重复记录标记 error，并在 suggestions 中建议删除/跳过该行。
`
  },
  magnitude_check: {
    label: '数据量级合理性判定',
    prompt: `
9. 数据量级判定：结合播放量与总花费判断商业逻辑是否合理（如花费高但播放量极低、播放量异常巨大且花费极低等），不合理时标记 warning/error 并说明原因。
`
  },
  platform_link_match: {
    label: '链接平台与博主类型匹配判定',
    prompt: `
10. 链接平台判定：从 homepage/content_link/video_link 的 URL 自动识别平台（抖音 douyin.com、小红书 xiaohongshu.com、B站 bilibili.com、快手 kuaishou.com、微博 weibo.com、视频号 channels.weixin.qq.com 等），识别结果写入 corrected.platform（平台名称）；并判断平台与博主类型是否匹配（如美妆通常投放小红书/抖音，数码通常投放B站/抖音），不匹配时标记 warning。
`
  }
}

/**
 * 根据启用的规则动态构建系统提示词
 * @param {string[]} rules 规则标识（RULE_LIBRARY 的 key）或自然语言自定义规则
 */
export function buildSystemPrompt(rules = []) {
  const parts = [BASE_PROMPT, COMPLETION_PROMPT]
  const customRules = []
  for (const rule of rules) {
    if (typeof rule !== 'string' || !rule.trim()) continue
    const key = rule.trim()
    if (RULE_LIBRARY[key]) {
      parts.push(RULE_LIBRARY[key].prompt)
    } else {
      customRules.push(`- ${key}`)
    }
  }
  if (customRules.length) {
    parts.push(
      `\n自定义判定条件（用户补充，优先级最高，必须逐条遵守）：\n${customRules.join('\n')}`
    )
  }
  return parts.join('\n')
}

/**
 * 解析 DeepSeek 返回内容为 JSON（兼容 Markdown 代码块包裹与多余空白）
 */
export function parseAiResult(content) {
  const text = String(content ?? '').trim()
  const candidates = [text, text.replace(/```(?:json)?/gi, '').trim()]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate)
    } catch {
      // 继续尝试下一个候选
    }
  }
  // 提取最外层 JSON 对象/数组
  const match = text.match(/[\[{][\s\S]*[\]}]/)
  if (match) {
    try {
      return JSON.parse(match[0])
    } catch {
      // 兜底失败
    }
  }
  throw new DeepSeekError('DeepSeek 返回内容不是合法 JSON')
}

/**
 * 归一化 AI 判定结果，保证每条记录结构稳定
 * 兼容两种返回：结构化 {rowIndex, field, reason, suggestion} 的 warnings/errors 数组，
 * 以及旧版自由文本 issues/suggestions 数组（向下兼容，不破坏原有解析）
 */
export function normalizeResult(parsed) {
  const list = Array.isArray(parsed) ? parsed : parsed?.records
  if (!Array.isArray(list)) {
    throw new DeepSeekError('DeepSeek 返回结构缺少 records 数组')
  }
  return list.map((item) => ({
    // 行号：优先 rowIndex（Excel 真实行号），兼容旧字段 index；无法解析时置 null（前端显示「未知行」）
    rowIndex: normalizeRowIndex(item),
    index: normalizeRowIndex(item),
    pass: Boolean(item?.pass),
    level: normalizeLevel(item),
    issues: Array.isArray(item?.issues) ? item.issues : [],
    suggestions: Array.isArray(item?.suggestions) ? item.suggestions : [],
    warnings: normalizeIssueList(item?.warnings),
    errors: normalizeIssueList(item?.errors),
    corrected: item?.corrected && typeof item.corrected === 'object' ? item.corrected : null
  }))
}

/** 行号解析：rowIndex 优先，其次 index；非数字返回 null */
function normalizeRowIndex(item) {
  const raw = item?.rowIndex ?? item?.index
  if (raw === undefined || raw === null || raw === '') return null
  const num = Number(raw)
  return Number.isFinite(num) ? num : null
}

/** 等级解析：未返回合法等级时，按 errors/warnings 推导，避免全部退化为 warning */
function normalizeLevel(item) {
  if (['info', 'warning', 'error'].includes(item?.level)) return item.level
  if (Array.isArray(item?.errors) && item.errors.length > 0) return 'error'
  if (Array.isArray(item?.warnings) && item.warnings.length > 0) return 'warning'
  return 'warning'
}

/**
 * 结构化问题项归一化：元素必须是对象且带 reason，缺失字段用兜底值填充；
 * 兼容 AI 直接返回字符串数组的情况（转成只带 reason 的项）
 */
function normalizeIssueList(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((entry) => {
      if (entry === null || entry === undefined) return null
      if (typeof entry === 'string') {
        const reason = entry.trim()
        return reason ? { field: 'record', reason, suggestion: '' } : null
      }
      if (typeof entry !== 'object') return null
      const reason = String(entry.reason ?? entry.issue ?? entry.message ?? '').trim()
      const suggestion = String(
        entry.suggestion ?? entry.suggest ?? entry.advice ?? ''
      ).trim()
      const field = String(entry.field ?? entry.column ?? 'record').trim() || 'record'
      const rowIndex = normalizeRowIndex(entry)
      if (!reason && !suggestion) return null
      return { field, reason, suggestion, rowIndex }
    })
    .filter(Boolean)
}

/**
 * 智能校验：按启用规则构建提示词并调用 DeepSeek（可注入 callFn 便于测试）
 */

// ---------- 字段映射建议（Batch 6A）----------
// AI 只允许在这些目标字段中选择，不得自创数据库字段
export const MAPPING_TARGET_FIELDS = [
  'time_cycle',
  'nickname',
  'creator_type',
  'homepage',
  'content_link',
  'video_link',
  'total_cost',
  'publish_date',
  'first_play',
  'second_week_play',
  'IGNORE',
  'UNKNOWN'
]

/**
 * 构建「字段映射建议」提示词：只发送表头名与前几个非空样例值，不发送整表数据
 * @param {Array<{ header: string, samples?: string[] }>} columns
 */
export function buildFieldMappingPrompt(columns = []) {
  const list = Array.isArray(columns) ? columns : []
  const rendered = list
    .map((item, index) => {
      const samples = (Array.isArray(item?.samples) ? item.samples : [])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .slice(0, 5)
      return `${index + 1}. 原始表头「${String(item?.header ?? '').trim()}」${
        samples.length ? `；样例值：${samples.join(' / ')}` : '；样例值：（该列无非空数据）'
      }`
    })
    .join('\n')

  return `
你是一名数据导入字段映射助手。用户会给出若干「Excel 原始表头 + 该列前几个非空样例值」，
请判断每个原始表头最可能对应系统中的哪个字段。

只允许从以下目标字段中选择，不得自创字段名：
- time_cycle：时间周期，如 2026-W33 或 08/13-08/19
- nickname：达人昵称
- creator_type：达人类型（博主类型）
- homepage：达人主页链接
- content_link：植入内容链接
- video_link：视频发布链接
- total_cost：总花费（元）
- publish_date：发布日期，YYYY-MM-DD
- first_play：7日播放量（内容发布约 7 天时记录的累计播放量）
- second_week_play：累计播放量（最近一次更新时的累计播放量）
- IGNORE：与上述字段无关、系统不导入的列（如报价、CPM、备注等）
- UNKNOWN：确实无法判断

重要语义（不得混淆）：
- first_play 是「7日播放量」，不是「首周新增播放量」
- second_week_play 只是历史字段名，含义是「累计播放量」，不是「第二周新增播放量」
- 「播放量（新）」这类写法应理解为累计播放量，「播放量（首发）」「播放量（7日）」应理解为 7日播放量

待识别字段：
${rendered}

只输出一个严格 JSON 对象，不要输出任何多余文字、解释或 Markdown 代码块。输出格式：
{"mappings":[{"source_header":"播放量（首发）","suggested_field":"first_play","confidence":"high","reason":"简要中文理由"}]}
- source_header 必须与输入原始表头完全一致
- suggested_field 必须取自上面的白名单（大写 IGNORE / UNKNOWN 照写）
- confidence 只能是 high / medium / low
- 每条输入表头都必须出现在 mappings 中，不得遗漏、不得新增
`
}

/**
 * 归一化 AI 返回的字段映射建议：目标字段必须落在白名单内，否则视为 UNKNOWN
 * @param {any} parsed AI 返回内容解析结果
 * @param {Array<{ header: string }>} columns 本次提交的列（保证输出结构稳定）
 */
export function normalizeFieldSuggestions(parsed, columns = []) {
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.mappings)
      ? parsed.mappings
      : Array.isArray(parsed?.suggestions)
        ? parsed.suggestions
        : []
  const byHeader = new Map()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const header = String(item.source_header ?? item.header ?? item.column ?? '').trim()
    if (!header) continue
    const rawField = String(item.suggested_field ?? item.field ?? item.mapping ?? '').trim()
    const confidenceText = String(item.confidence ?? '').trim().toLowerCase()
    byHeader.set(header, {
      source_header: header,
      suggested_field: MAPPING_TARGET_FIELDS.includes(rawField) ? rawField : 'UNKNOWN',
      confidence: ['high', 'medium', 'low'].includes(confidenceText) ? confidenceText : 'low',
      reason: String(item.reason ?? '').trim()
    })
  }
  return (Array.isArray(columns) ? columns : []).map(
    (column) =>
      byHeader.get(column.header) || {
        source_header: column.header,
        suggested_field: 'UNKNOWN',
        confidence: 'low',
        reason: 'AI 未返回该字段的识别结果'
      }
  )
}

/**
 * 智能校验：只向 Provider 发送提示词实际使用的业务字段。
 */
export const AI_VALIDATION_FIELDS = [
  'rowIndex', 'time_cycle', 'nickname', 'creator_type', 'homepage', 'content_link',
  'video_link', 'total_cost', 'publish_date', 'first_play', 'second_week_play', 'cpm_quote'
]

export function projectValidationRecords(records) {
  return records.map((record) => Object.fromEntries(
    AI_VALIDATION_FIELDS.filter((field) => record?.[field] !== undefined)
      .map((field) => [field, record[field]])
  ))
}

export async function validateRecords(records, callFn = callDeepSeek, rules = [], options = {}) {
  const content = await callFn(buildSystemPrompt(rules), JSON.stringify(projectValidationRecords(records)), options)
  return normalizeResult(parseAiResult(content))
}

/**
 * GET /api/ai/status
 * 仅报告后端环境变量是否配置；无需接收或返回页面用户 Key。
 */
router.get('/status', (req, res) => {
  const providerInfo = resolveProvider(req.headers['x-ai-provider'])
  const available = isProviderConfigured(providerInfo.key)
  const visionModel = getVisionModel(providerInfo.key)
  ok(res, {
    available,
    keySource: available ? 'environment' : 'none',
    provider: providerInfo.key,
    providerLabel: providerInfo.label,
    model: req.headers['x-ai-model'] || providerInfo.model,
    // P2A：对外只报告后端固定的图片识别模型（不可由 x-ai-model 覆盖）
    visionModel,
    visionAvailable: Boolean(visionModel),
    msg: available
      ? '本地环境已配置'
      : `后端环境未配置 ${providerInfo.label} API Key`
  })
})

/**
 * POST /api/ai/validate-records
 * 入参：{ records: Array, rules?: Array<string> }
 * rules 元素可以是规则库标识（如 creator_type_cpm）或自然语言自定义条件
 */
/**
 * POST /api/ai/normalize-time-cycles
 * 入参：{ values: string[] }（最多 50 个，自动去重）
 * 出参：{ code, data: [{ value, weekCode }], msg }
 * 本地规则无法识别的值由 AI 兜底识别；AI 结果经本地二次校验，校验不过置为 null
 */
router.post('/normalize-time-cycles', async (req, res) => {
  const rawValues = req.body?.values
  if (!Array.isArray(rawValues)) {
    return fail(res, 400, 'values 必须是非空数组')
  }
  const values = [...new Set(rawValues.map((v) => String(v ?? '').trim()).filter(Boolean))]
  if (values.length === 0) {
    return fail(res, 400, 'values 不能为空')
  }
  if (values.length > 50) {
    return fail(res, 400, '单次最多支持 50 个时间周期值')
  }

  const year = new Date().getFullYear()
  // 命中会话缓存的直接复用，避免相同原始值重复调用 AI
  const pendingValues = values.filter((value) => !normalizeCache.has(value))
  if (pendingValues.length === 0) {
    return ok(
      res,
      values.map((value) => ({
        value,
        weekCode: normalizeCache.get(value) ?? null,
        error: null
      }))
    )
  }

  try {
    // 服务商/密钥读取与 AI 校验一致：请求头优先，环境变量兜底（缺失时由 callDeepSeek 抛 400）
    const content = await callDeepSeek(
      buildNormalizePrompt(pendingValues, year),
      JSON.stringify(pendingValues),
      aiOptions(req)
    )
    const parsed = parseAiResult(content)
    const aiMap = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    const pendingResults = applyAiNormalizeResults(pendingValues, aiMap)
    const pendingMap = new Map(pendingResults.map((item) => [item.value, item]))

    for (const item of pendingResults) {
      // 仅缓存识别成功的结果；未识别的值不缓存，保证每次都能拿到具体失败原因
      if (item.weekCode && normalizeCache.size < NORMALIZE_CACHE_MAX) {
        normalizeCache.set(item.value, item.weekCode)
      }
    }

    ok(
      res,
      values.map((value) => {
        const cached = normalizeCache.get(value)
        if (cached) return { value, weekCode: cached, error: null }
        const item = pendingMap.get(value)
        return {
          value,
          weekCode: item ? item.weekCode : null,
          error: item ? item.error : 'AI 未返回该时间周期的识别结果'
        }
      })
    )
  } catch (err) {
    if (err instanceof DeepSeekError || err.isDeepSeekError) {
      return fail(res, err.status || 502, err.message)
    }
    console.error('[ai] 时间周期识别异常')
    return fail(res, 500, 'AI 时间周期识别服务异常，请稍后重试')
  }
})

/**
 * POST /api/ai/suggest-field-mappings
 * 入参：{ columns: [{ header: string, samples?: string[] }] }（最多 30 列，每列最多 5 个样例值）
 * 出参：{ code, data: [{ source_header, suggested_field, confidence, reason }], msg }
 * 说明：仅用于「未识别表头」的映射建议；AI 只能从白名单中选择字段，
 *      且结果必须由用户在导入弹窗确认后才生效，不会直接决定入库字段。
 * 不发送整表数据，不记录任何密钥信息。
 */
router.post('/suggest-field-mappings', async (req, res) => {
  const body = req.body && !Array.isArray(req.body) ? req.body : {}
  const rawColumns = Array.isArray(body.columns) ? body.columns : []
  if (rawColumns.length === 0) {
    return fail(res, 400, 'columns 必须是非空数组')
  }
  if (rawColumns.length > 30) {
    return fail(res, 400, '单次最多支持 30 个未识别字段')
  }

  const columns = rawColumns
    .map((item) => ({
      header: String(item?.header ?? '').trim().slice(0, 100),
      samples: (Array.isArray(item?.samples) ? item.samples : [])
        .map((value) => String(value ?? '').trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 5)
    }))
    .filter((item) => item.header)
  if (columns.length === 0) {
    return fail(res, 400, 'columns 中的原始表头不能为空')
  }

  try {
    // 服务商 / 密钥读取与智能校验一致：请求头优先，环境变量兜底（缺失时由 callDeepSeek 抛 400）
    const content = await callDeepSeek(
      buildFieldMappingPrompt(columns),
      JSON.stringify(columns),
      aiOptions(req)
    )
    ok(res, { suggestions: normalizeFieldSuggestions(parseAiResult(content), columns) })
  } catch (err) {
    if (err instanceof DeepSeekError || err.isDeepSeekError) {
      return fail(res, err.status || 502, err.message)
    }
    console.error('[ai] 字段映射识别异常')
    return fail(res, 500, 'AI 字段识别服务异常，请稍后重试')
  }
})

router.post('/validate-records', async (req, res) => {
  const { records, rules } = req.body || {}
  if (!Array.isArray(records)) {
    return fail(res, 400, 'records 必须是非空数组')
  }
  if (records.length === 0) {
    return fail(res, 400, 'records 不能为空')
  }
  if (records.length > 1000) {
    return fail(res, 400, '单次智能校验最多支持 1000 条记录')
  }
  if (
    rules !== undefined &&
    (!Array.isArray(rules) || rules.some((rule) => typeof rule !== 'string'))
  ) {
    return fail(res, 400, 'rules 必须是由规则标识或自然语言描述组成的字符串数组')
  }

  try {
    // 页面配置的服务商/模型/Key 优先，其次环境变量兜底；接口地址固定。
    const result = await validateRecords(records, callDeepSeek, rules || [], aiOptions(req))
    ok(res, result)
  } catch (err) {
    if (err instanceof DeepSeekError || err.isDeepSeekError) {
      return fail(res, err.status || 502, err.message)
    }
    console.error('[ai] 智能校验异常')
    return fail(res, 500, 'AI 校验服务异常，请稍后重试')
  }
})

// ============================================================
// 近期表现助手（V3-alpha P2A）：截图 -> 可见事实
// ------------------------------------------------------------
// 边界（必须保持）：
//   - 只在用户显式点击后调用；不自动上传、不重试
//   - 图片只在内存中处理：不落盘、不入库、不写日志、不回显 base64
//   - 模型固定取后端预设 visionModel（x-ai-model 不得覆盖），endpoint 固定官方地址
//   - AI 只输出「看见什么」的 raw_text；数字换算由 backend/utils/screenshotValues.js 完成
//   - AI 返回非法 JSON / 结构不符 → 直接识别失败，不做任何猜测式修复
// ============================================================

export const MAX_SCREENSHOT_COUNT = 3
// 单图 base64 解码后上限 1.5MB；总数上限 3.2MB（与前端压缩目标一致，确保请求体落在 5mb JSON limit 内）
export const MAX_SCREENSHOT_BYTES = 1572864
export const MAX_SCREENSHOT_TOTAL_BYTES = 3355400
// 单张截图最多采纳的作品条目（防止模型异常返回超长数组；截断会显式告知前端）
export const MAX_RECOGNIZED_PLAYS = 60
export const ALLOWED_SCREENSHOT_MIMES = ['image/png', 'image/jpeg', 'image/webp']

const SCREENSHOT_MIME_ALIASES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  'image/jpg': 'image/jpeg'
}

/** 归一化图片 MIME（仅允许 png / jpg / jpeg / webp），非法返回 null */
export function normalizeScreenshotMime(raw) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (!text) return null
  const mime = SCREENSHOT_MIME_ALIASES[text] || text
  return ALLOWED_SCREENSHOT_MIMES.includes(mime) ? mime : null
}

/** 去掉可能存在的 data URL 前缀（前端正常只发纯 base64，这里做防御式兼容） */
export function stripBase64Prefix(value) {
  return String(value ?? '').trim().replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
}

/**
 * base64 解码并返回真实字节数（不信任前端声明的体积）
 * 非法 base64 返回 null
 */
export function decodeScreenshotBase64(base64) {
  const text = stripBase64Prefix(base64)
  if (!text) return null
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null
  const buffer = Buffer.from(text, 'base64')
  // 反向校验：非法字符被 Buffer 静默丢弃时会不一致
  if (buffer.length === 0 || buffer.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) {
    return null
  }
  return buffer.length
}

/**
 * 校验并归一化请求里的图片数组
 * @returns {{ ok: true, images: Array<{mime: string, base64: string, bytes: number}> } | { ok: false, message: string }}
 */
export function validateScreenshotPayload(rawImages) {
  if (!Array.isArray(rawImages) || rawImages.length === 0) {
    return { ok: false, message: '请至少选择 1 张截图' }
  }
  if (rawImages.length > MAX_SCREENSHOT_COUNT) {
    return { ok: false, message: `单次最多识别 ${MAX_SCREENSHOT_COUNT} 张截图` }
  }

  const images = []
  let totalBytes = 0
  for (let index = 0; index < rawImages.length; index += 1) {
    const item = rawImages[index] || {}
    const mime = normalizeScreenshotMime(item.mime)
    if (!mime) {
      return {
        ok: false,
        message: `第 ${index + 1} 张截图格式不支持（仅支持 png / jpg / jpeg / webp）`
      }
    }
    const base64 = stripBase64Prefix(item.base64)
    const bytes = decodeScreenshotBase64(base64)
    if (bytes === null) {
      return { ok: false, message: `第 ${index + 1} 张截图内容不是合法图片数据` }
    }
    if (bytes > MAX_SCREENSHOT_BYTES) {
      return {
        ok: false,
        message: `第 ${index + 1} 张截图超过单图上限（1.5MB），请压缩后重试`
      }
    }
    totalBytes += bytes
    if (totalBytes > MAX_SCREENSHOT_TOTAL_BYTES) {
      return { ok: false, message: '截图总体积超过上限（3.2MB），请减少张数或压缩后重试' }
    }
    images.push({ mime, base64, bytes })
  }
  return { ok: true, images }
}

/** P2A 系统提示词：只允许输出可见事实，禁止换算、禁止猜测、禁止去重、禁止补足 */
export function buildScreenshotSystemPrompt() {
  return `
你是截图信息提取助手，服务于「达人投放工作台」。用户会按顺序提供 1~3 张达人主页 / 星图截图（第 1 张即 source_image_index=1）。

你只负责「看见什么」，不负责任何计算、估价、判断或补全。

必须遵守：
1. 只输出一个严格 JSON 对象，不要输出任何解释、Markdown 代码块或多余文字。
2. 输出结构固定为：
{"creator_name_raw": string|null, "xingtu_price_raw": string|null, "plays": [{"source_image_index": number, "position_index": number, "raw_text": string, "content_type": "sponsored"|"organic"|"unknown"}], "warnings": [string]}
3. raw_text 必须逐字保留截图上的原始写法（例如 "5.2万"、"1.3w"、"12K"），绝对不要换算成数字，也不要补充单位或格式化。
4. 不允许猜测：看不清、被遮挡、无法确定的字段输出 null，并在 warnings 里说明。
5. 提取前先判断每张截图的版式，再按对应方向输出 plays（source_image_index 为该条目所在截图的编号，第 1 张为 1）：
   A. 横向时间轴柱状图（多根竖直柱体从左至右排列，星图作品播放量图通常是这种）：
      - 先看图例确认颜色含义。
      - 时间方向固定：从左到右 = 旧作品 → 新作品。
      - 从最左侧柱体开始逐柱输出；最左柱 position_index=1，向右依次递增，最右柱是最后一条。
      - 每根柱体对应一条 plays：raw_text 取该柱体上方（或旁侧）的数值标签原文，content_type 只依据该柱体自身的填充颜色。
      - 蓝色柱体 → "organic"（个人视频 / 日常）；粉红色柱体 → "sponsored"（星图视频 / 商单）。
      - 柱体高度、数值大小、文字颜色不代表内容类型；禁止按播放量、柱体高度或颜色对柱体重新排序、分组或倒序。
      - 图例、均值虚线、火焰图标等只是辅助元素，不是作品，不要为它们输出条目。
      - 可参考横轴确认时间方向，但不要推测或输出任何日期。
   B. 纵向作品列表（一行一个作品）：
      - 按从上到下的视觉顺序逐行输出，第一行 position_index=1。
      - content_type 依据该行可见的颜色标识判断，无法确认 → "unknown"。
   C. 无法确定版式时：按看到的可见顺序保守提取，并在 warnings 里说明版式不确定。
   所有版式共同禁止：跨图片去重（多张截图可能包含同一作品，也要分别保留）、为凑数量补足条目（识别到多少就输出多少）、擅自倒序、擅自修改条目的来源截图归属。
6. content_type 只依据可见颜色判断，不依据标题、文案、语义、播放量高低：
   - 横向柱状图：只看柱体填充颜色 —— 蓝色柱体 → "organic"；粉红色柱体 → "sponsored"。红色火焰图标、红色均值虚线不是商单证据，不要据此分类。
   - 纵向列表：看行内颜色标识 —— 蓝色标识 → "organic"；红色 / 粉红色标识 → "sponsored"。
   - 任何版式：柱体高度、数值大小、文字颜色都不代表内容类型；禁止根据标题文案、字数、语气等语义线索猜测是否为广告；禁止为了凑成二选一而强行分类；颜色标识不存在、看不清或无法可靠判断 → "unknown"，无法确认时必须返回 "unknown"。
7. 不要输出发布日期、播放时间、点赞数、粉丝数等本次没有要求的内容；不要推测任何日期。
8. 如果整张截图都无法识别出有效信息，输出空的 plays 数组并在 warnings 中说明。

输出示例：
{"creator_name_raw":"Gary","xingtu_price_raw":"¥3,000","plays":[{"source_image_index":1,"position_index":1,"raw_text":"5.2万","content_type":"sponsored"},{"source_image_index":1,"position_index":2,"raw_text":"12K","content_type":"unknown"}],"warnings":[]}
`
}

/** P2A 用户指令（只描述任务，不含任何图片正文） */
export function buildScreenshotUserText(imageCount) {
  return `共 ${imageCount} 张截图，按顺序编号为 1~${imageCount}。请先判断每张截图的版式：横向时间轴柱状图（从左到右 = 旧作品 → 新作品，最左柱为第 1 条）或纵向作品列表（从上到下读取），再按对应方向提取：达人昵称（creator_name_raw）、星图刊例价（xingtu_price_raw）、以及每张截图里可见的作品播放量（plays）。`
}

/** 从 AI 返回文本中解析出结构化「可见事实」，非法 JSON / 结构不符直接抛错，不做猜测修复 */
export function parseCreatorScreenshotResult(content) {
  let parsed
  try {
    parsed = parseAiResult(content)
  } catch {
    throw new DeepSeekError('AI 返回内容不是合法 JSON，识别失败（不会自动猜测补全），请重试或改用手工填写', 502)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DeepSeekError('AI 返回结构不符合要求，识别失败（不会自动猜测补全）', 502)
  }
  if (!Array.isArray(parsed.plays)) {
    throw new DeepSeekError('AI 返回结构缺少 plays 数组，识别失败（不会自动猜测补全）', 502)
  }

  const toRawText = (value) => {
    if (value === null || value === undefined) return null
    const text = String(value).trim()
    return text === '' ? null : text
  }
  const toPositiveIndex = (value) => {
    const num = Number(value)
    return Number.isInteger(num) && num > 0 ? num : null
  }

  const priceRaw = toRawText(parsed.xingtu_price_raw)
  const price = parsePriceText(priceRaw)

  const rawPlays = parsed.plays.slice(0, MAX_RECOGNIZED_PLAYS)
  const plays = rawPlays.map((item, index) => {
    const rawText = toRawText(item?.raw_text)
    const normalized = parsePlayText(rawText)
    return {
      source_image_index: toPositiveIndex(item?.source_image_index),
      // position_index 缺失时回退为「返回顺序」，只用于展示排序，不代表 AI 推断出的真实发布时间
      position_index: toPositiveIndex(item?.position_index) ?? index + 1,
      raw_text: normalized.raw_text,
      normalized_play: normalized.value,
      needs_review: normalized.needs_review,
      reason: normalized.reason,
      // Alpha.3-04：内容类型只按可见颜色标识识别；AI 未给出 / 给了非法值 / 颜色不明确 → unknown
      content_type: normalizeContentType(item?.content_type)
    }
  })

  const warnings = (Array.isArray(parsed.warnings) ? parsed.warnings : [])
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 20)
  if (parsed.plays.length > MAX_RECOGNIZED_PLAYS) {
    warnings.push(`AI 返回的作品条目超过 ${MAX_RECOGNIZED_PLAYS} 条，已截断，请人工核对`)
  }

  // Screenshot V1：结果安全检查（只警告、不纠序）。
  // 设计边界：position_index 允许不连续（允许漏识别）；绝不用索引自动颠倒 / 重排 plays 数组；
  // 结构校验无法证明视觉上的时间顺序与“柱体颜色↔播放量”绑定，这两点保留人工核对。
  const layoutWarnings = []
  const positionsByImage = new Map()
  plays.forEach((play, index) => {
    if (play.source_image_index === null) {
      layoutWarnings.push(`第 ${index + 1} 条作品缺少来源截图编号（source_image_index），请人工核对归属`)
      return
    }
    if (!positionsByImage.has(play.source_image_index)) {
      positionsByImage.set(play.source_image_index, [])
    }
    positionsByImage.get(play.source_image_index).push(play.position_index)
  })
  for (const [imageIndex, positions] of [...positionsByImage.entries()].sort((a, b) => a[0] - b[0])) {
    const seen = new Set()
    for (const position of positions) {
      if (seen.has(position)) {
        layoutWarnings.push(`图 ${imageIndex} 中 position_index=${position} 重复出现，可能存在漏识别或重复识别，请人工核对`)
      }
      seen.add(position)
    }
    const maxPosition = positions.length ? Math.max(...positions) : 0
    if (positions.length > 0 && maxPosition > positions.length * 2 && maxPosition > 10) {
      layoutWarnings.push(`图 ${imageIndex} 的 position_index 最大值 ${maxPosition} 明显大于条目数 ${positions.length}，可能存在漏识别，请人工核对顺序`)
    }
  }
  const imageIndexes = [...positionsByImage.keys()].sort((a, b) => a - b)
  for (let i = 1; i < imageIndexes.length; i += 1) {
    if (imageIndexes[i] - imageIndexes[i - 1] > 1) {
      layoutWarnings.push(`来源截图编号从 ${imageIndexes[i - 1]} 跳到 ${imageIndexes[i]}，可能缺少中间截图或识别异常，请人工核对`)
    }
  }
  for (const warning of [...new Set(layoutWarnings)]) {
    warnings.push(warning)
  }
  if (warnings.length > 30) {
    warnings.length = 30
  }

  return {
    creator_name_raw: toRawText(parsed.creator_name_raw),
    xingtu_price_raw: priceRaw,
    xingtu_price: price.value,
    xingtu_price_needs_review: price.needs_review,
    xingtu_price_reason: price.reason,
    plays,
    warnings,
    recognized_count: plays.length,
    truncated: parsed.plays.length > MAX_RECOGNIZED_PLAYS
  }
}

/**
 * 执行截图识别（可注入 callFn，便于测试完全离线）
 * @param {Array<{mime: string, base64: string}>} images 已经过校验的图片
 * @param {Function} [callFn] 默认 callProviderVision
 * @param {{ provider?: string, apiKey?: string }} [options]
 */
export async function extractCreatorScreenshot(images, callFn = callProviderVision, options = {}) {
  const provider = resolveProvider(options.provider).key
  const content = await callFn({
    systemPrompt: buildScreenshotSystemPrompt(),
    userText: buildScreenshotUserText(images.length),
    images,
    provider,
    apiKey: options.apiKey
  })
  const result = parseCreatorScreenshotResult(content)
  return {
    provider,
    // 对外只报告真正使用的固定 vision 模型；x-ai-model 不会影响它
    model: getVisionModel(provider),
    ...result
  }
}

/**
 * POST /api/ai/extract-creator-screenshot
 * 入参：{ images: [{ mime, base64 }] }（1~3 张，png/jpg/jpeg/webp）
 * 出参：AI 只返回可见事实（raw_text）+ 确定性换算结果；不落盘、不入库、不记录图片正文
 */
router.post('/extract-creator-screenshot', async (req, res) => {
  const body = req.body && !Array.isArray(req.body) ? req.body : {}
  const validated = validateScreenshotPayload(body.images)
  if (!validated.ok) return fail(res, 400, validated.message)

  const provider = resolveProvider(req.headers['x-ai-provider']).key
  if (!getVisionModel(provider)) {
    return fail(
      res,
      400,
      `${resolveProvider(provider).label} 暂未开放图片识别（P2A 仅支持 DeepSeek Vision），请在右上角「AI配置」中切换到 DeepSeek`
    )
  }

  try {
    // 注意：这里不传 x-ai-model —— 图片识别模型固定由后端预设提供
    const result = await extractCreatorScreenshot(validated.images, callProviderVision, {
      provider,
      apiKey: req.headers['x-ai-api-key']
    })
    ok(res, result)
  } catch (err) {
    if (err instanceof DeepSeekError || err.isDeepSeekError) {
      return fail(res, err.status || 502, err.message)
    }
    console.error('[ai] 截图识别异常')
    return fail(res, 500, 'AI 截图识别服务异常，请稍后重试')
  }
})

// ---------- Phase 2.1：人工备注 AI 整理（只整理用户提供的备注，不添加任何外部事实） ----------
const MAX_CREATOR_NOTE_LENGTH = 2000

// 固定任务 prompt：前端不能传入任意 system prompt（路由只读取 description）
export function buildDistillSystemPrompt() {
  return `
你是「达人投放工作台」的备注整理助手。用户会提供一段自己写的达人人人工备注。

你唯一的任务：把这段人工备注整理成简洁的结构化要点。

必须遵守：
1. 只允许基于用户提供的备注内容整理，禁止添加任何外部事实、常识推断或你没被告知的信息。
2. 人工备注是「用户的观察 / 判断」，不是系统已验证的事实。整理时必须保留来源限定，例如：
   - 原文「商单保证50w」→ 整理为「人工备注认为商单播放约 50 万」
   - 原文「平时百万播放」→ 整理为「人工观察认为日常通常在百万量级」
   - 原文「价格很便宜」→ 整理为「人工备注判断价格相对实惠」
   绝对不要改写成「商单播放 50 万」「稳定百万播放」「价格具有优势」等确定性事实。
3. 不做任何「值得投 / 不值得投」的判断，不输出推荐分。
4. 输出 2~5 个简短要点，围绕：达人定位 / 内容特点、人工备注中的播放表现、人工备注中的商业合作 / 价格信息、需要后续数据验证的部分。
5. 只输出一个严格 JSON 对象，不要输出解释、Markdown 代码块或多余文字：
{"points": ["要点1", "要点2"]}
`
}

// 只把 description 作为用户输入发送（数据最小化）
export function buildDistillUserText(description) {
  return String(description ?? '')
}

// 解析 AI 返回：只接受 { points: string[] }；非法结构直接抛错，不做猜测修复
export function parseDistillResult(content) {
  let parsed
  try {
    parsed = parseAiResult(content)
  } catch {
    throw new DeepSeekError('AI 返回内容不是合法 JSON，备注整理失败，请重试', 502)
  }
  const rawPoints = Array.isArray(parsed?.points)
    ? parsed.points
    : typeof parsed?.points === 'string'
      ? [parsed.points]
      : []
  const points = rawPoints
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 5)
  if (!points.length) {
    throw new DeepSeekError('AI 未返回可用的整理要点，请重试', 502)
  }
  return { points, text: points.join('\n') }
}

/**
 * 整理人工备注（可注入 callFn，便于测试完全离线）
 * @param {string} description 用户人工备注（唯一输入）
 * @param {Function} [callFn] 默认 callDeepSeek
 * @param {{ provider?: string, model?: string, apiKey?: string }} [options]
 */
export async function distillCreatorNote(description, callFn = callDeepSeek, options = {}) {
  const content = await callFn(buildDistillSystemPrompt(), buildDistillUserText(description), options)
  return parseDistillResult(content)
}

/**
 * POST /api/ai/distill-creator-note
 * 入参：{ description: string }（只发送这一段人工备注，数据最小化）
 * 出参：{ points: string[], text: string }（AI 整理文本，不是系统验证事实）
 * 说明：固定任务 prompt；不发送 creator_records / 近期播放 / Decision / 其他达人数据；
 *      AI 不可用时返回明确错误，但不影响 candidate 数据。
 */
router.post('/distill-creator-note', async (req, res) => {
  const body = req.body && !Array.isArray(req.body) ? req.body : {}
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  if (!description) return fail(res, 400, 'description 不能为空')
  if (description.length > MAX_CREATOR_NOTE_LENGTH) {
    return fail(res, 400, `人工备注长度不能超过 ${MAX_CREATOR_NOTE_LENGTH}`)
  }
  try {
    const result = await distillCreatorNote(description, callDeepSeek, aiOptions(req))
    ok(res, result)
  } catch (err) {
    if (err instanceof DeepSeekError || err.isDeepSeekError) {
      return fail(res, err.status || 502, err.message)
    }
    console.error('[ai] 备注整理异常')
    return fail(res, 500, 'AI 备注整理服务异常，请稍后重试')
  }
})

// ---------- Historical Negotiation Backfill V0.1：AI 整理谈价经验（建议，不落库） ----------
const MAX_NEGOTIATION_SOURCE_NOTE_LENGTH = 2000
const MAX_NEGOTIATION_NOTE_LENGTH_AI = 500

// 固定任务 prompt：前端不能传入任意 system prompt（路由只读取 source_note）
export function buildNegotiationHarvestSystemPrompt() {
  return `
你是「达人投放工作台」的谈价经验整理助手。用户会提供一段自己写的历史谈价原始备注（source_note）。

你唯一的任务：把这段人工备注整理成「建议的原因标签 + 补充说明 + 谈价依据 / 过程」。

必须遵守：
1. 只允许基于用户提供的 source_note 整理，禁止添加任何外部事实、常识推断或你没被告知的信息。
2. 绝不创造价格事实：不得推断 / 编造 xingtu_price、current_quote、negotiated_price，
   也不要把备注里的价格当成系统事实（可以原样转述，但要保留「人工备注」的来源限定）。
3. 不做任何「这个策略有效 / 不有效」的判断，不输出推荐折扣、不给出建议价格。
4. reason_tags 只能从下面这个固定 allowlist 中选择（不能创造新标签，不确定就不要选）：
   history_performance_plain, budget_limited, long_term_cooperation, batch_cooperation,
   creator_price_cut, schedule_factor, other, sponsored_below_organic, sponsored_sample_low,
   playback_volatile, quote_above_playbook_range, quote_above_history_reference
5. 输出必须是「建议」口吻并保留来源限定，例如：
   source「我觉得他商单明显比日常差，所以压价」
   → reason_tags: ["sponsored_below_organic"]
   → strategy_note: "人工备注显示谈价时以商单播放低于日常作为压价依据。"
   绝对不要写成「该达人商单表现较差，因此应该压价。」
6. 只输出一个严格 JSON 对象，不要输出解释、Markdown 代码块或多余文字：
{"reason_tags": ["..."], "reason_note": "...", "strategy_note": "..."}
`
}

/**
 * 组装 AI 输入（数据最小化）
 *   · 必填：本次谈价原始备注 source_note
 *   · 可选（仅当真实存在时才发送）：候选人人工备注 / 人工备注整理 / 相关决策备注
 *   · 绝不发送 record 明细、其它达人、其它 negotiation case、outcome 或整库
 * 兼容旧调用：传入字符串时等价于只发送 source_note。
 */
export function buildNegotiationHarvestUserText(input) {
  if (typeof input === 'string') return input
  const parts = []
  const push = (label, value) => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text) parts.push(`【${label}】${text}`)
  }
  push('本次谈价原始备注', input?.sourceNote)
  push('达人人工备注', input?.candidateDescription)
  // distilled_description 是 AI 派生内容，不是人工 source of truth：
  // 人工 description 存在时不再发送它，避免同一信息重复加权。
  const hasDescription =
    typeof input?.candidateDescription === 'string' && input.candidateDescription.trim() !== ''
  if (!hasDescription) {
    push('达人备注 AI 整理（AI 派生内容，非人工原始备注）', input?.distilledDescription)
  }
  push('相关决策备注', input?.decisionNote)
  return parts.join('\n')
}

/**
 * 记录本次实际发送给 AI 的来源（UI 只展示真实存在的来源）
 *   · 人工 description 存在时不再包含 distilled_description（同源去重）
 *   · distilled_description 只作为辅助来源，且 UI 标注为「达人备注AI整理」
 */
export function listNegotiationHarvestSources(input) {
  if (typeof input === 'string') return input.trim() ? ['source_note'] : []
  const sources = []
  const has = (value) => typeof value === 'string' && value.trim() !== ''
  if (has(input?.sourceNote)) sources.push('source_note')
  if (has(input?.candidateDescription)) sources.push('candidate_description')
  if (!has(input?.candidateDescription) && has(input?.distilledDescription)) {
    sources.push('distilled_description')
  }
  if (has(input?.decisionNote)) sources.push('decision_note')
  return sources
}

/**
 * AI 整理是否具备可整理的人工内容（Context Reuse V0.2）
 *   · 人工来源：谈价原始备注 / 达人人工备注 / 决策备注 —— 任一存在即可，不强制 source_note
 *   · distilled_description 是 AI 派生内容，不算人工来源（不能单独作为整理依据）
 */
export function hasNegotiationHarvestSource(input) {
  if (typeof input === 'string') return input.trim() !== ''
  const has = (value) => typeof value === 'string' && value.trim() !== ''
  return (
    has(input?.sourceNote) || has(input?.candidateDescription) || has(input?.decisionNote)
  )
}

export const NEGOTIATION_HARVEST_EMPTY_MSG =
  '没有可整理的人工内容：谈价原始备注 / 达人人工备注 / 决策备注至少填写一项'

/**
 * 解析 AI 返回：只接受 { reason_tags, reason_note, strategy_note }
 *   · reason_tags 只保留 allowlist 内的值（非法 tag 直接过滤，不猜测、不修复）
 *   · reason_note / strategy_note 只做 trim + 截断长度
 */
export function parseNegotiationHarvestResult(content) {
  let parsed
  try {
    parsed = parseAiResult(content)
  } catch {
    throw new DeepSeekError('AI 返回内容不是合法 JSON，谈价经验整理失败，请重试', 502)
  }
  const rawTags = Array.isArray(parsed?.reason_tags)
    ? parsed.reason_tags
    : typeof parsed?.reason_tags === 'string'
      ? [parsed.reason_tags]
      : []
  const reasonTags = [
    ...new Set(
      rawTags
        .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
        .filter((tag) => NEGOTIATION_REASON_TAG_VALUES.includes(tag))
    )
  ]
  const toNote = (value) => {
    if (typeof value !== 'string') return null
    const text = value.trim()
    return text ? text.slice(0, MAX_NEGOTIATION_NOTE_LENGTH_AI) : null
  }
  const reasonNote = toNote(parsed?.reason_note)
  const strategyNote = toNote(parsed?.strategy_note)
  if (!reasonTags.length && !reasonNote && !strategyNote) {
    throw new DeepSeekError('AI 未返回可用的谈价经验整理结果，请重试', 502)
  }
  return { reason_tags: reasonTags, reason_note: reasonNote, strategy_note: strategyNote }
}

/**
 * 整理谈价经验（可注入 callFn，便于测试完全离线）
 * @param {string|{sourceNote: string, candidateDescription?: string, distilledDescription?: string, decisionNote?: string}} input
 *        本次谈价原始备注（必填）+ 真实存在的最小上下文
 * @param {Function} [callFn] 默认 callDeepSeek
 * @param {{ provider?: string, model?: string, apiKey?: string }} [options]
 */
export async function harvestNegotiationExperience(
  input,
  callFn = callDeepSeek,
  options = {}
) {
  const content = await callFn(
    buildNegotiationHarvestSystemPrompt(),
    buildNegotiationHarvestUserText(input),
    options
  )
  // AI 输出仍然只有 reason_tags / reason_note / strategy_note（绝不产生价格事实）；
  // sources 只用于 UI 展示「参考来源」。
  return { ...parseNegotiationHarvestResult(content), sources: listNegotiationHarvestSources(input) }
}

/**
 * POST /api/ai/harvest-negotiation-experience
 * 入参：{ source_note: string }（只发送这一段人工备注，数据最小化）
 * 出参：{ reason_tags: string[], reason_note: string|null, strategy_note: string|null }
 * 说明：固定任务 prompt；只返回**建议**，绝不写库；AI 不可用时历史回填仍可人工填写保存。
 */
router.post('/harvest-negotiation-experience', async (req, res) => {
  const body = req.body && !Array.isArray(req.body) ? req.body : {}
  const sourceNote = typeof body.source_note === 'string' ? body.source_note.trim() : ''
  if (sourceNote.length > MAX_NEGOTIATION_SOURCE_NOTE_LENGTH) {
    return fail(res, 400, `历史谈价原始备注长度不能超过 ${MAX_NEGOTIATION_SOURCE_NOTE_LENGTH}`)
  }
  const readOptional = (value, label) => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text.length > MAX_NEGOTIATION_SOURCE_NOTE_LENGTH) {
      return { error: `${label}长度不能超过 ${MAX_NEGOTIATION_SOURCE_NOTE_LENGTH}` }
    }
    return { text }
  }
  const candidateDescription = readOptional(body.candidate_description, '达人人工备注')
  const distilledDescription = readOptional(body.distilled_description, '达人备注整理')
  const decisionNote = readOptional(body.decision_note, '决策备注')
  const optionalError =
    candidateDescription.error || distilledDescription.error || decisionNote.error
  if (optionalError) return fail(res, 400, optionalError)
  // Context Reuse V0.2：不强制 source_note —— 只要存在任一人工来源即可整理；
  // 全部为空（distilled 是 AI 派生，不算）才拒绝。
  if (
    !hasNegotiationHarvestSource({
      sourceNote,
      candidateDescription: candidateDescription.text,
      decisionNote: decisionNote.text
    })
  ) {
    return fail(res, 400, NEGOTIATION_HARVEST_EMPTY_MSG)
  }
  try {
    // 只发送真实存在的最小上下文（candidate 备注 / 备注整理 / 相关决策备注）
    const result = await harvestNegotiationExperience(
      {
        sourceNote,
        candidateDescription: candidateDescription.text,
        distilledDescription: distilledDescription.text,
        decisionNote: decisionNote.text
      },
      callDeepSeek,
      aiOptions(req)
    )
    ok(res, result)
  } catch (err) {
    if (err instanceof DeepSeekError || err.isDeepSeekError) {
      return fail(res, err.status || 502, err.message)
    }
    console.error('[ai] 谈价经验整理异常')
    return fail(res, 500, 'AI 谈价经验整理服务异常，请稍后重试')
  }
})

export default router
