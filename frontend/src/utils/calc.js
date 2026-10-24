/**
 * CPM 计算工具
 */

/**
 * 计算 CPM：总花费 / 播放量 * 1000（按次周播放量判定）
 * @param {number|string} totalCost 总花费（元）
 * @param {number|string} plays 播放量（次周播放量）
 * @returns {number|null} 保留 2 位小数的 CPM；播放量无效或为 0 时返回 null（界面显示 -）
 */
export function calcCpm(totalCost, plays) {
  const cost = Number(totalCost)
  const p = Number(plays)
  if (!Number.isFinite(cost) || !Number.isFinite(p) || p <= 0) return null
  return Number(((cost / p) * 1000).toFixed(2))
}
