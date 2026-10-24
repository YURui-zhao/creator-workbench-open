import config from '../config.js'

const DAY_MS = 86400000

/**
 * 时间周期工具：周数与日期范围互转
 * 周规则：每周从周一到周日；每年第 1 周从当年第一个周一开始
 * 所有时间计算统一在后端处理，前端只负责展示
 */

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim())
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// 返回 date 所在自然周的周一
function getMonday(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const day = d.getDay() || 7 // 周一=1 ... 周日=7
  d.setDate(d.getDate() - (day - 1))
  return d
}

// 业务规则：每年第 1 周从当年第一个周一开始
function firstMondayOfYear(year) {
  const firstDay = new Date(year, 0, 1)
  const offset = (8 - firstDay.getDay()) % 7
  return new Date(year, 0, 1 + offset)
}

/**
 * 周数 -> 起止日期
 * @param {number|string} weekNum 周数（如 32）
 * @param {number|string} [year] 年份，默认取配置的业务年份（config.businessYear）
 * @returns {{ start: string, end: string }} start/end 均为 YYYY-MM-DD
 */
export function weekToDateRange(weekNum, year = config.businessYear) {
  const week = Number(weekNum)
  const y = Number(year)
  if (!Number.isInteger(week) || week < 1 || week > 53) {
    throw new Error(`非法的周数: ${weekNum}（应为 1-53）`)
  }
  if (!Number.isInteger(y) || y < 1970 || y > 9999) {
    throw new Error(`非法的年份: ${year}`)
  }
  const firstMonday = firstMondayOfYear(y)
  const start = new Date(firstMonday)
  start.setDate(firstMonday.getDate() + (week - 1) * 7)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  return { start: formatDate(start), end: formatDate(end) }
}

/**
 * 任意日期 -> 所属自然周的周码（周一为每周第一天；跨年按周一所在年归属）
 * 与前端 frontend/src/utils/dateCycle.js 的 dateToWeekCode 保持完全一致的 Monday-Sunday 定义：
 * 前端负责导入时推导 time_cycle，后端负责写入校验，两边必须同源同结果。
 * @param {Date|string} date 日期对象或 YYYY-MM-DD 字符串
 * @param {number} [year] 参考年份（缺省取该日期所在年）
 * @returns {string|null} 如 2026-W32
 */
export function dateToWeekCode(date, year) {
  const d = date instanceof Date ? date : parseDate(date)
  if (!d || Number.isNaN(d.getTime())) return null
  const monday = getMonday(d)
  const refYear = Number(year) || monday.getFullYear()
  const weekYear = monday.getFullYear() !== refYear ? monday.getFullYear() : refYear
  const firstMonday = firstMondayOfYear(weekYear)
  let week = Math.floor((monday - firstMonday) / DAY_MS / 7) + 1
  if (week < 1) {
    // 兜底：归属上一年最后一个自然周
    const prevYear = weekYear - 1
    const prevFirstMonday = firstMondayOfYear(prevYear)
    week = Math.floor((monday - prevFirstMonday) / DAY_MS / 7) + 1
    return `${prevYear}-W${String(week).padStart(2, '0')}`
  }
  return `${weekYear}-W${String(week).padStart(2, '0')}`
}

/**
 * 日期范围 -> 周数（以起始日所在自然周为准，跨年自动归属）
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @returns {{ weekCode: string, weekNum: number, year: number }}
 */
export function dateRangeToWeek(startDate, endDate) {
  const start = parseDate(startDate)
  const end = parseDate(endDate)
  if (!start || !end) {
    throw new Error('日期格式必须为 YYYY-MM-DD')
  }
  if (start > end) {
    throw new Error('startDate 不能晚于 endDate')
  }

  const monday = getMonday(start)
  let year = monday.getFullYear()
  let firstMonday = firstMondayOfYear(year)
  if (monday < firstMonday) {
    // 早于当年第一周：归属上一年最后一个自然周
    year -= 1
    firstMonday = firstMondayOfYear(year)
  }
  const diffDays = Math.round((monday - firstMonday) / DAY_MS)
  const weekNum = Math.floor(diffDays / 7) + 1
  return {
    weekCode: `${year}-W${String(weekNum).padStart(2, '0')}`,
    weekNum,
    year
  }
}

/**
 * 规范化周码：2026-W5 -> 2026-W05；格式非法返回 null
 * @param {string} value
 */
export function normalizeWeekCode(value) {
  const match = /^(\d{4})-W(\d{1,2})$/i.exec(String(value ?? '').trim())
  if (!match) return null
  const week = Number(match[2])
  if (week < 1 || week > 53) return null
  return `${match[1]}-W${String(week).padStart(2, '0')}`
}

/**
 * 根据周码生成周期信息：weekCode / startDate / endDate / label
 * label 形如 08/10-08/16
 */
export function getCycleInfo(weekCode) {
  const normalized = normalizeWeekCode(weekCode)
  if (!normalized) return null
  const [year, week] = normalized.split('-W')
  const { start, end } = weekToDateRange(week, year)
  const label = `${start.slice(5).replace('-', '/')}-${end.slice(5).replace('-', '/')}`
  return { weekCode: normalized, startDate: start, endDate: end, label }
}

/**
 * 根据周码返回该周的起止日期
 * @param {string} weekCode 如 2026-W32
 * @returns {{ startDate: string, endDate: string } | null}
 */
export function getWeekDateRange(weekCode) {
  const info = getCycleInfo(weekCode)
  if (!info) return null
  return { startDate: info.startDate, endDate: info.endDate }
}

/**
 * 生成指定年份的全年自然周列表（升序生成）
 * 规则：每周周一~周日；每年第 1 周从当年第一个周一开始；
 * 生成到「周一起始日仍在当年内」的最后一周为止（2026 为 52 周，含 53 周的年份跨年自动处理）
 * @param {number|string} [year] 年份，默认取配置的业务年份
 * @returns {Array<{ weekCode: string, startDate: string, endDate: string, label: string }>}
 */
export function generateYearWeeks(year = config.businessYear) {
  const y = Number(year)
  if (!Number.isInteger(y) || y < 1970 || y > 9999) {
    throw new Error(`非法的年份: ${year}`)
  }
  const weeks = []
  let week = 1
  while (week <= 53) {
    const { start, end } = weekToDateRange(week, y)
    // 周一起始日已超出当年 12/31，说明属于下一年，停止生成
    if (new Date(`${start}T00:00:00`) > new Date(y, 11, 31)) break
    weeks.push({
      weekCode: `${y}-W${String(week).padStart(2, '0')}`,
      startDate: start,
      endDate: end,
      label: `${start.slice(5).replace('-', '/')}-${end.slice(5).replace('-', '/')}`
    })
    week += 1
  }
  return weeks
}

/**
 * 下一周的周码（跨年/跨月自动正确处理，格式 YYYY-Wxx）
 * @param {string} weekCode 如 2026-W33
 * @returns {string|null}
 */
export function getNextWeek(weekCode) {
  const range = getWeekDateRange(weekCode)
  if (!range) return null
  const nextDate = new Date(`${range.startDate}T00:00:00`)
  nextDate.setDate(nextDate.getDate() + 7)
  const nextDateText = formatDate(nextDate)
  return dateRangeToWeek(nextDateText, nextDateText).weekCode
}

/**
 * 上一周的周码（跨年/跨月自动正确处理，格式 YYYY-Wxx）
 * @param {string} weekCode 如 2026-W01
 * @returns {string|null}
 */
export function getPrevWeek(weekCode) {
  const range = getWeekDateRange(weekCode)
  if (!range) return null
  const prevDate = new Date(`${range.startDate}T00:00:00`)
  prevDate.setDate(prevDate.getDate() - 7)
  const prevDateText = formatDate(prevDate)
  return dateRangeToWeek(prevDateText, prevDateText).weekCode
}

// ---------- 时间周期智能解析（与前端 src/utils/dateCycle.js 规则保持一致） ----------
const WEEK_CODE_RE = /^(\d{4})-W(\d{1,2})$/i
// 区间分隔符：~ ～ 至 到
const RANGE_SEP_RE = /\s*(?:~|～|至|到)\s*/
// 仅匹配「月日 - 月日」形式：8.17-8.23、8/17-8/23、8月17日-8月23日
const COMPACT_RANGE_RE =
  /^(\d{1,2})[./月](\d{1,2})日?\s*[-–—]\s*(\d{1,2})[./月](\d{1,2})日?$/

// 周码是否合法（周一必须落在该年份内，如 2026 年没有第 53 周）
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
  return `${year}-W${String(week).padStart(2, '0')}`
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

// 解析单个日期片段：2026-08-17 / 2026/8/17 / 2026年8月17日 / 8月17日 / 8/17 / 8.17
function parseDateToken(token) {
  const text = String(token ?? '').trim()
  if (!text) return null
  let match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text)
  if (match) {
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  }
  match = /^(\d{1,2})[月/.](\d{1,2})日?$/.exec(text)
  if (match) {
    return { year: null, month: Number(match[1]), day: Number(match[2]) }
  }
  return null
}

// 起止日期 -> 周码（要求周一为起始、完整 7 天；不满足返回 null）
function weekCodeFromDateRange(startToken, endToken, baseYear) {
  const start = parseDateToken(startToken)
  const end = parseDateToken(endToken)
  if (!start || !end) return null
  const startDate = toValidDate(start.year ?? baseYear, start.month, start.day)
  if (!startDate) return null
  let endDate = toValidDate(end.year ?? start.year ?? baseYear, end.month, end.day)
  if (!endDate) return null
  if (endDate < startDate) {
    // 跨年区间（如 12/29-01/04）：结束日期归属下一年
    endDate = toValidDate((end.year ?? start.year ?? baseYear) + 1, end.month, end.day)
  }
  if (!endDate) return null
  if (startDate.getDay() !== 1) return null // 起始必须是周一
  if (Math.round((endDate - startDate) / DAY_MS) !== 6) return null // 必须完整 7 天
  return dateRangeToWeek(formatDate(startDate), formatDate(endDate)).weekCode
}

/**
 * 时间周期智能解析：本地规则优先，严格返回标准周码或 null
 * 支持：2026-W33 / W33 / 第33周 / 33周 / 2026年第33周 /
 *      8.17-8.23 / 8/17-8/23 / 8月17日-8月23日 / 2026-08-17~2026-08-23 /
 *      2026-08-17至2026-08-23 / 单日期 2026-08-17、8月17日
 * @param {string} raw 原始值
 * @param {number} [year] 年份缺失时的默认年份（默认系统当前年份）
 * @returns {string|null} 如 2026-W33；无法识别或不是完整自然周时返回 null
 */
export function parseTimeCycleToWeekCode(raw, year = new Date().getFullYear()) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const baseYear = Number(year) || new Date().getFullYear()

  // 1) 标准周码 2026-W33 / 2026-w3
  const codeMatch = WEEK_CODE_RE.exec(text)
  if (codeMatch) return buildWeekCode(Number(codeMatch[1]), Number(codeMatch[2]))

  // 2) 周数简写（带年份）：2026年第33周 / 2026年33周 / 2026W33
  const withYear = /^(\d{4})\s*年?\s*(?:第)?\s*[Ww]?(\d{1,2})\s*周$/.exec(text)
  if (withYear) return buildWeekCode(Number(withYear[1]), Number(withYear[2]))

  // 3) 周数简写（无年份）：W33 / w33 / 第33周 / 33周
  const weekOnly = /^(?:第)?\s*[Ww]?(\d{1,2})\s*周?$/.exec(text)
  if (weekOnly && /[Ww第周]/.test(text)) {
    return buildWeekCode(baseYear, Number(weekOnly[1]))
  }

  // 4) 区间（~ ～ 至 到 分隔）
  const parts = text.split(RANGE_SEP_RE)
  if (parts.length === 2) {
    return weekCodeFromDateRange(parts[0], parts[1], baseYear)
  }

  // 5) 区间（短横线分隔的月日形式）
  const compact = COMPACT_RANGE_RE.exec(text)
  if (compact) {
    return weekCodeFromDateRange(
      `${compact[1]}/${compact[2]}`,
      `${compact[3]}/${compact[4]}`,
      baseYear
    )
  }

  // 6) 单日期：取该日期所在自然周的完整区间
  const single = parseDateToken(text)
  if (single) {
    const date = toValidDate(single.year ?? baseYear, single.month, single.day)
    if (!date) return null
    return dateRangeToWeek(formatDate(date), formatDate(date)).weekCode
  }

  return null
}
