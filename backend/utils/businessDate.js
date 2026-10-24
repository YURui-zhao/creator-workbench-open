/**
 * 业务日期工具（Real Data Calibration V1）
 *
 * 冻结语义：
 *   · business date（decided_at / negotiated_at / observed_at）= 真实业务发生日期，格式 YYYY-MM-DD
 *   · system record time（created_at）= 录入时间，永远不伪装成业务日期
 * 本模块只做确定性日期解析 / 本地今天计算，不读库、不做任何业务判断。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 严格校验 YYYY-MM-DD（含真实日历校验，2026-02-30 一类必须拒绝） */
export function isValidDateOnly(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!DATE_RE.test(text)) return false
  const [year, month, day] = text.split('-').map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day))
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  )
}

/** 服务器本地今天（YYYY-MM-DD）；仅用于「新建记录未显式提供业务日期」的默认值 */
export function todayLocalDateOnly() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
