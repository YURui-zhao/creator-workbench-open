/**
 * 近期表现统计口径（V3-alpha P2B，纯函数）
 *
 * 三层信息严格区分：
 *   1) 原始识别 / 人工确认结果  -> plays_json（raw_text 等）
 *   2) 最终有效样本            -> valid（excluded=false 且 normalized_play !== null 且 >= 0）
 *   3) 后端统计结果            -> median / p25 / p75 / trend（本模块；同样落库，便于追溯）
 *
 * 冻结口径（stats_version 记录当时的算法，未来改口径不得回写旧快照）：
 *   · 典型区间：valid_count >= 5 时，先去掉 1 个最高、1 个最低观测，再在剩余样本上取 median / P25 / P75
 *   · 趋势：valid_count >= 8 时，最新 5 条为 recent，其余更早的为 prior；ratio = recent/prior - 1
 *   · 阈值：ratio >= +20% → up；<= -20% → down；其余 → stable
 *   · 内部按原始精度计算，只在最终输出 round（播放量取整）
 */

/**
 * 近期表现统计口径版本：
 *   · v1（历史）：recent/prior 切片方向错误（把最旧 5 条当 recent）
 *   · v2（当前冻结）：录入顺序 = 从旧到新（时间向下推进），最新样本在数组末尾；
 *     validCount >= 8 时 recent = 最后 5 条、prior = 其余更早样本；
 *     ratio = median(recent)/median(prior) − 1（±20% 阈值）。
 *     median_play / p25 / p75 / analysis 等其它口径与 v1 完全一致。
 * v1 落库的 trend 派生字段由一次性 backfill 修正（不修改 plays_json 等事实）。
 */
export const STATS_VERSION = 'recent-performance-v2'
// ±20% 阈值唯一来源（不在别处散落 magic number）
export const TREND_THRESHOLD_PERCENT = 20
export const TREND_THRESHOLD = TREND_THRESHOLD_PERCENT / 100
export const RECENT_GROUP_SIZE = 5
export const MIN_VALID_FOR_STATS = 5
export const MIN_VALID_FOR_TREND = 8
export const MAX_PLAYS_PER_SNAPSHOT = 60

// Alpha.3-04：内容类型（商单 / 日常 / 未识别）
// 业务语义与实际投放价格无关：只用于把近期表现拆成两个流量池，不做加权、不做综合分。
export const CONTENT_TYPES = {
  sponsored: 'sponsored', // 商单 / 广告合作（截图中的红色标识）
  organic: 'organic', // 日常 / 普通内容（截图中的蓝色标识）
  unknown: 'unknown' // 未识别 / 无法确认（含全部旧快照）
}

/** 归一化内容类型：只接受 allowlist，其余（含 null / 非法值 / 旧数据）一律 unknown */
export function normalizeContentType(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === CONTENT_TYPES.sponsored) return CONTENT_TYPES.sponsored
  if (text === CONTENT_TYPES.organic) return CONTENT_TYPES.organic
  return CONTENT_TYPES.unknown
}

export const TREND_LABELS = {
  up: '上升',
  stable: '基本稳定',
  down: '下降',
  insufficient: '样本不足'
}

/**
 * 确定性 quantile（linear interpolation，与 numpy/线性插值定义一致）
 * position = (n - 1) * p；lower = floor(position)；upper = ceil(position)
 * lower === upper 时取 sorted[lower]，否则线性插值
 * @param {number[]} sortedAsc 升序数组
 * @param {number} p 0~1
 */
export function quantile(sortedAsc, p) {
  const list = Array.isArray(sortedAsc) ? sortedAsc : []
  const n = list.length
  if (n === 0) return null
  if (n === 1) return list[0]
  const position = (n - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return list[lower]
  return list[lower] + (list[upper] - list[lower]) * (position - lower)
}

/** 中位数（偶数取中间两项平均；内部不做提前 round） */
export function medianOf(values) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value))
  if (!list.length) return null
  const sorted = [...list].sort((a, b) => a - b)
  return quantile(sorted, 0.5)
}

/**
 * 算术平均（有效播放均值；无有效样本返回 null）
 * 与前端 Rule Engine 的 mean 口径一致：全部「有效播放」的算术平均，不提前去极值。
 */
export function meanOf(values) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value))
  if (!list.length) return null
  return list.reduce((sum, value) => sum + value, 0) / list.length
}

/** 最终输出统一取整（播放量展示为整数；内部计算不受影响） */
function roundPlay(value) {
  return value === null || value === undefined ? null : Math.round(value)
}

/**
 * 「典型表现」中位数（与现有整体统计完全同一逻辑，供整体与内容类型分组共用）：
 *   · 样本 >= MIN_VALID_FOR_STATS(5)：去掉 1 个最高、1 个最低观测后取中位数（现有冻结口径）
 *   · 样本不足：直接对全部有效样本取中位数（现有整体口径在 <5 时返回 null，由调用方决定是否展示）
 * 只做分组统计复用，不引入第二套算法。
 * @param {number[]} values
 * @param {{ allowSmallSample?: boolean }} [options] allowSmallSample=true 时 <5 也返回中位数（内容类型分组用）
 */
export function typicalMedianOf(values = [], { allowSmallSample = false } = {}) {
  const valid = (Array.isArray(values) ? values : []).filter(
    (value) => Number.isFinite(value) && value >= 0
  )
  if (!valid.length) return null
  if (valid.length >= MIN_VALID_FOR_STATS) {
    const sorted = [...valid].sort((a, b) => a - b)
    // 只移除一个最高观测与一个最低观测（即使存在重复值）
    const analysis = sorted.slice(1, sorted.length - 1)
    return roundPlay(quantile(analysis, 0.5))
  }
  if (!allowSmallSample) return null
  return roundPlay(medianOf(valid))
}

/**
 * Alpha.3-04：内容类型分组统计（只分组，不做加权 / 综合分）
 * - 有效样本口径与整体一致：excluded=false、normalized_play 为有限数字且 >= 0
 * - unknown 不计入 sponsored / organic；旧快照（无 content_type）全部落入 unknown
 * - 中位数复用上方 typicalMedianOf（>=5 去极值，<5 直接中位数；0 是真实值）
 * @param {Array<{normalized_play: number|null, excluded: boolean, content_type?: string}>} plays
 */
export function computeContentTypeBreakdown(plays = []) {
  const groups = { sponsored: [], organic: [], unknown: [] }
  for (const play of Array.isArray(plays) ? plays : []) {
    if (!play || play.excluded === true) continue
    const value = play.normalized_play
    if (!Number.isFinite(value) || value < 0) continue
    groups[normalizeContentType(play.content_type)].push(value)
  }
  return {
    sponsored_count: groups.sponsored.length,
    sponsored_median_play: typicalMedianOf(groups.sponsored, { allowSmallSample: true }),
    organic_count: groups.organic.length,
    organic_median_play: typicalMedianOf(groups.organic, { allowSmallSample: true }),
    unknown_count: groups.unknown.length
  }
}

/**
 * 由「有效且按人工录入顺序（从旧到新，时间向下推进）排列」的播放量数组计算统计结果
 * @param {number[]} validPlaysInOrder
 * @returns {{
 *   valid_count: number, analysis_count: number,
 *   median_play: number|null, p25_play: number|null, p75_play: number|null,
 *   recent_median_play: number|null, prior_median_play: number|null,
 *   trend_ratio: number|null, trend_label: 'up'|'stable'|'down'|'insufficient',
 *   stats_status: 'ok'|'insufficient'
 * }}
 */
export function computeRecentPerformanceStats(validPlaysInOrder = []) {
  const valid = (Array.isArray(validPlaysInOrder) ? validPlaysInOrder : []).filter(
    (value) => Number.isFinite(value) && value >= 0
  )
  const validCount = valid.length

  // ---------- 典型表现：去最高最低各 1 个 ----------
  const canComputeTypical = validCount >= MIN_VALID_FOR_STATS
  const sorted = [...valid].sort((a, b) => a - b)
  // 只移除一个最高观测与一个最低观测（即使存在重复值）
  const analysis = canComputeTypical ? sorted.slice(1, sorted.length - 1) : []
  const analysisCount = analysis.length

  const stats = {
    valid_count: validCount,
    analysis_count: analysisCount,
    // 与内容类型分组统计共用同一「典型表现中位数」逻辑（>=5 去极值；行为与改动前完全一致）
    median_play: typicalMedianOf(valid),
    p25_play: canComputeTypical ? roundPlay(quantile(analysis, 0.25)) : null,
    p75_play: canComputeTypical ? roundPlay(quantile(analysis, 0.75)) : null,
    recent_median_play: null,
    prior_median_play: null,
    trend_ratio: null,
    trend_label: 'insufficient',
    stats_status: canComputeTypical ? 'ok' : 'insufficient'
  }

  // ---------- 近期趋势：使用全部有效样本的录入顺序（不做去极值、不重排） ----------
  // Phase audit 顺序契约（用户确认）：录入顺序 = 从旧到新（时间向下推进），最新样本在数组末尾。
  // 因此 recent = 「最后 5 条」（最新），prior = 「其余更早的」；绝不 slice(0, 5)。
  if (validCount < MIN_VALID_FOR_TREND) return stats

  const recentValues = valid.slice(-RECENT_GROUP_SIZE)
  const priorValues = valid.slice(0, valid.length - RECENT_GROUP_SIZE)
  const recentMedian = medianOf(recentValues)
  const priorMedian = medianOf(priorValues)
  stats.recent_median_play = roundPlay(recentMedian)
  stats.prior_median_play = roundPlay(priorMedian)

  if (priorMedian === 0) {
    // 不除以 0：prior 为 0 时只比较是否增长
    stats.trend_ratio = null
    stats.trend_label = recentMedian > 0 ? 'up' : 'stable'
    return stats
  }

  const ratio = recentMedian / priorMedian - 1
  stats.trend_ratio = Number(ratio.toFixed(4))
  // 阈值判定用「放大 100 倍的整数比较」，避免浮点除法在边界上误判：
  // 例如 12000/10000-1 === 0.19999999999999996，直接与 0.2 比较会判成 stable。
  // 只有 trend_ratio（展示/记录用）保留带误差的除法结果。
  const recentScaled = recentMedian * 100
  if (recentScaled >= priorMedian * (100 + TREND_THRESHOLD_PERCENT)) stats.trend_label = 'up'
  else if (recentScaled <= priorMedian * (100 - TREND_THRESHOLD_PERCENT)) stats.trend_label = 'down'
  else stats.trend_label = 'stable'
  return stats
}
