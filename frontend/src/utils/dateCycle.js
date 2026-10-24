/**
 * 前端时间周期工具（与后端 backend/utils/dateCycle.js 规则一致）
 * 周规则：每周周一~周日；每年第 1 周从当年第一个周一开始
 */

function pad2(value) {
  return String(value).padStart(2, '0')
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim())
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function formatMonthDay(date) {
  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`
}

// 每年第 1 周从当年第一个周一开始
function firstMondayOfYear(year) {
  const firstDay = new Date(year, 0, 1)
  const offset = (8 - firstDay.getDay()) % 7
  return new Date(year, 0, 1 + offset)
}

// 返回 date 所在自然周的周一
function getMonday(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  d.setDate(d.getDate() - ((d.getDay() || 7) - 1))
  return d
}

/**
 * 任意日期 -> 所属自然周的周码（跨年自动归属上一年）
 * @param {Date|string} date 日期对象或 YYYY-MM-DD 字符串
 * @param {number} [year=2026] 参考年份（默认业务年份 2026；跨年时按周一所在年自动归属，保证正确）
 * @returns {string|null} 如 2026-W32
 */
export function dateToWeekCode(date, year = 2026) {
  const d = date instanceof Date ? date : parseDate(date)
  if (!d || Number.isNaN(d.getTime())) return null
  const monday = getMonday(d)
  const refYear = Number(year) || monday.getFullYear()
  // 跨年时按周一所在年归属（如 2026-01-02 属于 2025-W52）
  const weekYear = monday.getFullYear() !== refYear ? monday.getFullYear() : refYear
  const firstMonday = firstMondayOfYear(weekYear)
  let week = Math.floor((monday - firstMonday) / 86400000 / 7) + 1
  if (week < 1) {
    // 兜底：归属上一年最后一个自然周
    const prevYear = weekYear - 1
    const prevFirstMonday = firstMondayOfYear(prevYear)
    week = Math.floor((monday - prevFirstMonday) / 86400000 / 7) + 1
    return `${prevYear}-W${pad2(week)}`
  }
  return `${weekYear}-W${pad2(week)}`
}

/**
 * 周码 -> 起止日期
 * @param {string} weekCode 如 2026-W32
 * @returns {{ startDate: string, endDate: string } | null}
 */
export function getWeekDateRange(weekCode) {
  const match = /^(\d{4})-W(\d{1,2})$/i.exec(String(weekCode ?? '').trim())
  if (!match) return null
  const year = Number(match[1])
  const week = Number(match[2])
  if (week < 1 || week > 53) return null
  const firstMonday = firstMondayOfYear(year)
  const start = new Date(firstMonday)
  start.setDate(firstMonday.getDate() + (week - 1) * 7)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  return { startDate: formatDate(start), endDate: formatDate(end) }
}

/**
 * 周码 -> 起止日期（与 getWeekDateRange 等价，按需求命名）
 * @param {string} weekCode 如 2026-W32
 * @returns {{ startDate: string, endDate: string } | null}
 */
export function weekCodeToDateRange(weekCode) {
  return getWeekDateRange(weekCode)
}

/**
 * 将任意起止日期对齐到完整自然周：
 * 起始 = 开始日期所在周的周一，结束 = 结束日期所在周的周日；
 * 只传一天（end 为空）时返回当天所在完整周
 * @param {string} startDate YYYY-MM-DD
 * @param {string} [endDate] YYYY-MM-DD
 * @returns {{ startDate: string, endDate: string, weekCode: string } | null}
 */
export function alignDateToWeek(startDate, endDate) {
  let start = parseDate(startDate)
  let end = endDate ? parseDate(endDate) : null
  if (!start) return null
  if (end && start > end) {
    // 起止颠倒时自动交换
    const tmp = start
    start = end
    end = tmp
  }
  const weekStart = getMonday(start)
  const weekEnd = getMonday(end || start)
  weekEnd.setDate(weekEnd.getDate() + 6)
  return {
    startDate: formatDate(weekStart),
    endDate: formatDate(weekEnd),
    weekCode: dateToWeekCode(start)
  }
}

/**
 * 起止日期 -> 前端展示标签（MM/DD-MM/DD，如 08/10-08/16）
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @returns {string}
 */
export function formatWeekLabel(startDate, endDate) {
  const start = parseDate(startDate)
  const end = parseDate(endDate)
  if (!start || !end) return ''
  return `${formatMonthDay(start)}-${formatMonthDay(end)}`
}

/**
 * 日期范围 -> 周码（以起始日所在自然周为准；非法输入返回 null）
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @returns {string|null} 如 2026-W32
 */
export function dateRangeToWeek(startDate, endDate) {
  const start = parseDate(startDate)
  const end = parseDate(endDate)
  if (!start || !end || start > end) return null
  return dateToWeekCode(start)
}

/**
 * 周码 -> 月日标签（如 2026-W32 -> 08/10-08/16）
 */
export function weekCodeToLabel(weekCode) {
  const range = getWeekDateRange(weekCode)
  if (!range) return String(weekCode ?? '')
  return `${range.startDate.slice(5).replace('-', '/')}-${range.endDate.slice(5).replace('-', '/')}`
}

/**
 * 月日区间 -> 周码（需为周一~周日的完整自然周；年份默认当前年）
 * @returns {string} 周码；无法识别时原样返回
 */
export function labelToWeekCode(label, year = new Date().getFullYear()) {
  const text = String(label ?? '').trim()
  if (!text) return text
  // 无法识别时保持原有契约：原样返回（由校验层给出格式错误提示）
  return parseTimeCycleToWeekCode(text, year) || text
}

// ---------- 时间周期智能解析（本地规则优先，严格返回周码或 null） ----------
const RANGE_SEP_RE = /\s*(?:~|～|至|到)\s*/
// 仅匹配「月日 - 月日」形式的短横线区间：8.17-8.23、8/17-8/23、8月17日-8月23日
const COMPACT_RANGE_RE =
  /^(\d{1,2})[./月](\d{1,2})日?\s*[-–—]\s*(\d{1,2})[./月](\d{1,2})日?$/
const WEEK_CODE_RE = /^(\d{4})-W(\d{1,2})$/i
// 同月区间简写：8月13-19日、8月13日-19日、2026年8月13日至19日
const SAME_MONTH_RANGE_RE =
  /^(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*[-~至到]\s*(\d{1,2})\s*日?$/
// 紧凑数字区间：0813-0819、0813~0819
const COMPACT_DIGIT_RANGE_RE = /^(\d{2})(\d{2})\s*[-~至到]\s*(\d{2})(\d{2})$/
// 四段短横线：8-13-8-19（月-日-月-日）
const FOUR_GROUP_RANGE_RE = /^(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})$/

/**
 * 原始文本归一化：兼容业务里常见的全角数字、各类破折号（含 U+2011 非断行连字符）、波浪线
 * 例：8‑13~8‑19（含非断行连字符）→ 8-13~8-19
 */
function normalizeTimeCycleText(raw) {
  return String(raw ?? '')
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[‐‑‒–—−－━]/g, '-')
    .replace(/[～〜≈]/g, '~')
    .replace(/\s+/g, ' ')
    .trim()
}

// 校验周码对应的周一是否落在该年份内（如 2026 年没有第 53 周）
function isValidWeekOfYear(year, week) {
  if (!Number.isInteger(week) || week < 1 || week > 53) return false
  const firstMonday = firstMondayOfYear(year)
  const monday = new Date(firstMonday)
  monday.setDate(firstMonday.getDate() + (week - 1) * 7)
  return monday.getFullYear() === year
}

function buildWeekCode(year, week) {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) return null
  if (!isValidWeekOfYear(year, week)) return null
  return `${year}-W${pad2(week)}`
}

// 由年/月/日构造合法日期（拒绝 2 月 30 日等非法日期）
function toValidDate(year, month, day) {
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return date
}

// 解析单个日期片段：2026-08-17 / 2026/8/17 / 2026.8.17 / 2026年8月17日 / 8月17日 / 8/17 / 8.17 / 8-17
function parseDateToken(token) {
  const text = String(token ?? '').trim()
  if (!text) return null
  let match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text)
  if (match) {
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  }
  // 月日简写：额外兼容 8-17 这类短横线写法（如 8-13~8-19）
  match = /^(\d{1,2})[月/.\-](\d{1,2})日?$/.exec(text)
  if (match) {
    return { year: null, month: Number(match[1]), day: Number(match[2]) }
  }
  return null
}

/**
 * 从文本中提取起止日期（不校验是否完整自然周），供解析失败时给出具体原因
 * @returns {{ startDate: Date, endDate: Date }|null}
 */
function detectDateRange(text, baseYear) {
  const build = (startToken, endToken) => {
    const start = parseDateToken(startToken)
    const end = parseDateToken(endToken)
    if (!start || !end) return null
    const startDate = toValidDate(start.year ?? baseYear, start.month, start.day)
    if (!startDate) return null
    let endDate = toValidDate(end.year ?? start.year ?? baseYear, end.month, end.day)
    if (endDate && endDate < startDate) {
      endDate = toValidDate((end.year ?? start.year ?? baseYear) + 1, end.month, end.day)
    }
    return endDate ? { startDate, endDate } : null
  }

  const sameMonth = SAME_MONTH_RANGE_RE.exec(text)
  if (sameMonth) {
    const year = sameMonth[1] ? Number(sameMonth[1]) : baseYear
    return build(`${year}-${sameMonth[2]}-${sameMonth[3]}`, `${year}-${sameMonth[2]}-${sameMonth[4]}`)
  }
  const digits = COMPACT_DIGIT_RANGE_RE.exec(text)
  if (digits) return build(`${digits[1]}/${digits[2]}`, `${digits[3]}/${digits[4]}`)
  const four = FOUR_GROUP_RANGE_RE.exec(text)
  if (four) return build(`${four[1]}/${four[2]}`, `${four[3]}/${four[4]}`)
  const parts = text.split(RANGE_SEP_RE)
  if (parts.length === 2) return build(parts[0], parts[1])
  const compact = COMPACT_RANGE_RE.exec(text)
  if (compact) {
    return build(`${compact[1]}/${compact[2]}`, `${compact[3]}/${compact[4]}`)
  }
  return null
}

// 起止日期 -> 周码（要求周一为起始、完整 7 天；不满足返回 null）
function weekCodeFromDateRange(startToken, endToken, baseYear) {
  const start = parseDateToken(startToken)
  const end = parseDateToken(endToken)
  if (!start || !end) return null
  const startYear = start.year ?? baseYear
  const startDate = toValidDate(startYear, start.month, start.day)
  if (!startDate) return null
  let endDate = toValidDate(end.year ?? startYear, end.month, end.day)
  if (!endDate) return null
  if (endDate < startDate) {
    // 跨年区间（如 12/29-01/04）：结束日期归属下一年
    endDate = toValidDate((end.year ?? startYear) + 1, end.month, end.day)
  }
  if (!endDate) return null
  if (startDate.getDay() !== 1) return null // 起始日必须是周一
  if (Math.round((endDate - startDate) / 86400000) !== 6) return null // 必须完整 7 天
  return dateToWeekCode(startDate)
}

/**
 * 智能解析时间周期：本地规则优先，严格返回标准周码或 null（不做强制转换）
 * 支持：2026-W33 / W33 / w33 / 第33周 / 33周 / 2026年第33周 /
 *      8.13-8.19 / 8-13~8-19（含非断行连字符 8‑13~8‑19）/ 8/13-8/19 /
 *      8月13日-8月19日 / 8月13-19日 / 0813-0819 / 8-13-8-19 /
 *      2026-08-17~2026-08-23 / 2026-08-17至2026-08-23 / 2026年8月17日至8月23日 /
 *      单日期 2026-08-17、8月17日
 * @param {string} raw 原始值
 * @param {number} [year] 年份缺失时的默认年份（默认当前系统年份）
 * @returns {string|null} 如 2026-W33；无法识别或不满足自然周规则时返回 null
 */
export function parseTimeCycleToWeekCode(raw, year = new Date().getFullYear()) {
  const text = normalizeTimeCycleText(raw)
  if (!text) return null
  const baseYear = Number(year) || new Date().getFullYear()

  // 1) 标准周码 2026-W33 / 2026-w3
  const codeMatch = WEEK_CODE_RE.exec(text)
  if (codeMatch) return buildWeekCode(Number(codeMatch[1]), Number(codeMatch[2]))

  // 2) 周数简写：2026年第33周 / 2026年33周 / 2026W33
  const withYear = /^(\d{4})\s*年?\s*(?:第)?\s*[Ww]?(\d{1,2})\s*周$/.exec(text)
  if (withYear) return buildWeekCode(Number(withYear[1]), Number(withYear[2]))

  // 3) 周数简写（无年份）：W33 / w33 / 第33周 / 33周
  const weekOnly = /^(?:第)?\s*[Ww]?(\d{1,2})\s*周?$/.exec(text)
  if (weekOnly && /[Ww第周]/.test(text)) {
    return buildWeekCode(baseYear, Number(weekOnly[1]))
  }

  // 4) 同月区间简写：8月13-19日 / 8月13日-19日 / 2026年8月13日至19日
  const sameMonth = SAME_MONTH_RANGE_RE.exec(text)
  if (sameMonth) {
    const yearText = sameMonth[1] ? sameMonth[1] : String(baseYear)
    return weekCodeFromDateRange(
      `${yearText}-${sameMonth[2]}-${sameMonth[3]}`,
      `${yearText}-${sameMonth[2]}-${sameMonth[4]}`,
      baseYear
    )
  }

  // 5) 紧凑数字区间：0813-0819、0813~0819
  const compactDigits = COMPACT_DIGIT_RANGE_RE.exec(text)
  if (compactDigits) {
    return weekCodeFromDateRange(
      `${Number(compactDigits[1])}/${Number(compactDigits[2])}`,
      `${Number(compactDigits[3])}/${Number(compactDigits[4])}`,
      baseYear
    )
  }

  // 6) 四段短横线：8-13-8-19（月-日-月-日）
  const fourGroups = FOUR_GROUP_RANGE_RE.exec(text)
  if (fourGroups) {
    return weekCodeFromDateRange(
      `${Number(fourGroups[1])}/${Number(fourGroups[2])}`,
      `${Number(fourGroups[3])}/${Number(fourGroups[4])}`,
      baseYear
    )
  }

  // 7) 区间（~ 至 到 分隔）
  const parts = text.split(RANGE_SEP_RE)
  if (parts.length === 2) {
    return weekCodeFromDateRange(parts[0], parts[1], baseYear)
  }

  // 8) 区间（短横线分隔的月日形式）
  const compact = COMPACT_RANGE_RE.exec(text)
  if (compact) {
    return weekCodeFromDateRange(
      `${compact[1]}/${compact[2]}`,
      `${compact[3]}/${compact[4]}`,
      baseYear
    )
  }

  // 9) 单日期：取该日期所在自然周的完整区间
  const single = parseDateToken(text)
  if (single) {
    const date = toValidDate(single.year ?? baseYear, single.month, single.day)
    return date ? dateToWeekCode(date) : null
  }

  return null
}

/**
 * 解析失败原因说明（不抛错，供前端提示使用）
 * @param {string} raw 原始值
 * @param {number} [year] 年份缺失时的默认年份
 * @returns {{ weekCode: string|null, reason: string }} 成功时 reason 为空字符串
 */
export function explainTimeCycle(raw, year = new Date().getFullYear()) {
  const text = normalizeTimeCycleText(raw)
  if (!text) return { weekCode: null, reason: '时间周期为空' }

  const weekCode = parseTimeCycleToWeekCode(text, year)
  if (weekCode) return { weekCode, reason: '' }

  const baseYear = Number(year) || new Date().getFullYear()
  // 能识别出「两个日期」但不是完整自然周 → 给出针对性原因
  const range = detectDateRange(text, baseYear)
  if (range) {
    const startText = `${range.startDate.getFullYear()}-${pad2(range.startDate.getMonth() + 1)}-${pad2(
      range.startDate.getDate()
    )}`
    if (range.startDate.getDay() !== 1) {
      return {
        weekCode: null,
        reason: `起始日期 ${startText} 不是周一，需按完整自然周填写（周一~周日）`
      }
    }
    const days = Math.round((range.endDate - range.startDate) / 86400000) + 1
    if (days !== 7) {
      return {
        weekCode: null,
        reason: `所选区间为 ${days} 天，不是完整自然周（需 7 天且周一到周日）`
      }
    }
  }

  // 标准周码但周数不合法：2026-W53、2026-W99
  const codeMatch = /^(\d{4})\s*-\s*[Ww]\s*(\d{1,2})$/.exec(text)
  if (codeMatch) {
    return {
      weekCode: null,
      reason: `周数非法：${codeMatch[1]} 年不存在第 ${Number(codeMatch[2])} 个自然周`
    }
  }
  // 周数写法（W33 / 第33周）：年份或周数越界
  if (/[Ww第周]/.test(text) && /^(?:第)?\s*[Ww]?\d{1,2}\s*周?$/.test(text)) {
    return { weekCode: null, reason: '周数写法无法确定有效年份，或该年份不存在此周（如 53 周）' }
  }
  // 明显非法日期（如 2 月 30 日、2/30）
  const monthTokens = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g) || []
  for (const token of monthTokens) {
    const parts = /(\d{1,2})\s*月\s*(\d{1,2})/.exec(token)
    if (parts && !toValidDate(baseYear, Number(parts[1]), Number(parts[2]))) {
      return {
        weekCode: null,
        reason: `日期非法：${Number(parts[1])} 月 ${Number(parts[2])} 日不存在`
      }
    }
  }
  if (/^\d/.test(text)) {
    return {
      weekCode: null,
      reason:
        '日期或周数无法解析，请核对写法（支持 YYYY-Wxx、MM/DD-MM/DD、8月17-23日 等完整自然周）'
    }
  }
  return {
    weekCode: null,
    reason: '无法识别的时间周期写法，请按 YYYY-Wxx 或 MM/DD-MM/DD 填写完整自然周'
  }
}

/**
 * 时间周期归一化：支持周码或月日区间，优先匹配后端周期数据（Excel 导入用）
 */
export function normalizeTimeCycleValue(value, cycles = []) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (/^\d{4}-W\d{1,2}$/i.test(text)) return text
  const found = cycles.find((item) => item.label === text || item.weekCode === text)
  if (found) return found.weekCode
  return labelToWeekCode(text)
}

/**
 * 上一周的周码（跨年/跨月正确，格式 YYYY-Wxx）
 * @param {string} weekCode 如 2026-W33
 * @returns {string|null}
 */
export function getPrevWeek(weekCode) {
  const range = weekCodeToDateRange(weekCode)
  if (!range) return null
  const prevDate = new Date(`${range.startDate}T00:00:00`)
  prevDate.setDate(prevDate.getDate() - 7)
  return dateToWeekCode(prevDate)
}

/**
 * 下一周的周码（跨年/跨月正确，格式 YYYY-Wxx）
 * @param {string} weekCode 如 2026-W33
 * @returns {string|null}
 */
export function getNextWeek(weekCode) {
  const range = weekCodeToDateRange(weekCode)
  if (!range) return null
  const nextDate = new Date(`${range.startDate}T00:00:00`)
  nextDate.setDate(nextDate.getDate() + 7)
  return dateToWeekCode(nextDate)
}
