import request from '../utils/request.js'

/**
 * 获取指定年份全年自然周列表（默认业务年份 2026），按时间倒序（最新周在最上面）
 * @param {number} [year]
 */
export function getYearCycles(year) {
  return request.get('/cycles/list', { params: { year } })
}

// ---------- 兜底：接口失败时生成最近 N 周（与后端周规则一致：每年第一周从第一个周一开始） ----------
function firstMondayOfYear(year) {
  const firstDay = new Date(year, 0, 1)
  return new Date(year, 0, 1 + ((8 - firstDay.getDay()) % 7))
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function formatMonthDay(date) {
  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`
}

/**
 * 生成「最近 N 周」选项（降级用），按时间倒序
 * @param {number} [count] 周数，默认 8
 * @param {Date} [now] 基准时间，默认当前时间
 */
export function generateRecentWeekOptions(count = 8, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  // 当前日期所在周的周一
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() || 7) - 1))

  const options = []
  for (let i = 0; i < count; i += 1) {
    const start = new Date(monday)
    start.setDate(monday.getDate() - i * 7)

    // 计算该周属于哪一年第几周（早于当年第一周的归属上一年）
    let year = start.getFullYear()
    let firstMonday = firstMondayOfYear(year)
    if (start < firstMonday) {
      year -= 1
      firstMonday = firstMondayOfYear(year)
    }
    const week = Math.floor((start - firstMonday) / 86400000 / 7) + 1

    const end = new Date(start)
    end.setDate(start.getDate() + 6)
    options.push({
      weekCode: `${year}-W${pad2(week)}`,
      startDate: formatDate(start),
      endDate: formatDate(end),
      label: `${formatMonthDay(start)}-${formatMonthDay(end)}`
    })
  }
  return options
}
