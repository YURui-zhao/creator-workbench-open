/**
 * 展示格式化工具
 * 全局统一规则：
 *   - 金额：保留 2 位小数 + 千分位（单位元由展示处补充）
 *   - 播放量：>= 10000 显示 x.x万（1 位小数），否则显示原始整数
 *   - CPM：保留 1 位小数，无播放量（null）显示 -
 */

// 空值判定：null / undefined / 空字符串按「无数据」处理（0 仍按真实数字展示）
function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

// 金额：保留 2 位小数 + 千分位分隔（如 12345.6 -> 12,345.60）
export function formatMoney(value, fallback = '-') {
  if (isBlank(value)) return fallback
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// 播放量：>= 1 万自动格式化为 x.x万（保留 1 位小数），例如 82000 -> 8.2万、150000 -> 15.0万
export function formatPlays(value, fallback = '-') {
  if (isBlank(value)) return fallback
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  if (num >= 10000) return `${(num / 10000).toFixed(1)}万`
  return String(num)
}

// CPM：保留 1 位小数（无播放量时调用方传 null，显示 -）
export function formatCpm(value, fallback = '-') {
  if (isBlank(value)) return fallback
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return num.toFixed(1)
}

// 整数（达人数量、记录数等）
export function formatInteger(value, fallback = '-') {
  if (isBlank(value)) return fallback
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return String(Math.round(num))
}
