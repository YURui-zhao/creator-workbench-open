/**
 * 谈价试算器（V3-alpha P4，前端纯函数）
 *
 * 目的：让用户在【2～7 折】谈价区间内自行 what-if 试算，而不是系统只给一个固定答案。
 *
 * 边界：
 *   · 只是非持久化预览：不写 DB、不调 AI、不发网络请求、不影响「我的决定」
 *   · 只用后端已经返回的 xingtu_price / median_play / target_price / reference_high 做展示计算；
 *     保存 decision 时的 authoritative evidence 仍由后端重新生成
 *   · 折扣区间始终锚定星图刊例价，与实际报价无关
 */

export const SIMULATOR_MIN_RATE = 0.2
export const SIMULATOR_MAX_RATE = 0.7
export const SIMULATOR_DEFAULT_RATE = 0.7 // 默认区间内价格最高的一档，由用户自行向下探索
export const SIMULATOR_STEP_RATE = 0.01 // 0.1 折

// 统一的「恰好相等」比较容差：与后端 creatorPricing 的 epsilon 语义一致。
// 只用于边界稳定判定，不参与任何数值输出；判定一律基于 raw 值，不做 round 后再比较。
// 例如 xingtu=3000 / rate=0.55 → 3000*0.55 = 1650.0000000000002，
// 裸 <= 1650 会误判为「高于参考区间」，加上 epsilon 后稳定判为 within_reference_range。
export const COMPARE_EPSILON = 1e-6

export const SIMULATOR_STATUS = {
  atOrBelowTarget: 'at_or_below_target',
  withinReferenceRange: 'within_reference_range',
  aboveReferenceRange: 'above_reference_range'
}

export const SIMULATOR_STATUS_LABELS = {
  [SIMULATOR_STATUS.atOrBelowTarget]: '已达到或优于 CPM30目标价',
  [SIMULATOR_STATUS.withinReferenceRange]: '已进入 CPM30参考区间',
  [SIMULATOR_STATUS.aboveReferenceRange]: '仍高于 CPM30参考区间'
}

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const lte = (a, b) => a <= b + COMPARE_EPSILON

/** 把任意输入夹到 [2折, 7折]，并归一到 0.1 折步长 */
export function clampSimulatorRate(rate) {
  // 空值 / 非法值一律回落到默认 7折（不静默变成 2折，避免误导）
  if (rate === null || rate === undefined || rate === '') return SIMULATOR_DEFAULT_RATE
  const num = Number(rate)
  if (!Number.isFinite(num)) return SIMULATOR_DEFAULT_RATE
  const clamped = Math.min(SIMULATOR_MAX_RATE, Math.max(SIMULATOR_MIN_RATE, num))
  return Number(clamped.toFixed(2))
}

/** 折数展示：整数 7折 / 一位小数 5.8折 */
export function formatSimulatorZhe(rate) {
  const zhe = Number((clampSimulatorRate(rate) * 10).toFixed(1))
  return Number.isInteger(zhe) ? `${zhe}折` : `${zhe.toFixed(1)}折`
}

/**
 * 试算：按 selected_rate 计算价格、对应 CPM 与相对 CPM30 的状态
 * @param {{xingtuPrice: number|null, medianPlay: number|null, targetPrice: number|null,
 *          referenceHigh: number|null, rate?: number}} input
 */
export function simulateNegotiation({
  xingtuPrice,
  medianPlay,
  targetPrice,
  referenceHigh,
  rate = SIMULATOR_DEFAULT_RATE
} = {}) {
  const selectedRate = clampSimulatorRate(rate)
  const base = {
    available: false,
    unavailable_reason: null,
    unavailable_label: null,
    rate: selectedRate,
    zhe: Number((selectedRate * 10).toFixed(1)),
    zhe_label: formatSimulatorZhe(selectedRate),
    price: null,
    cpm: null,
    status: null,
    status_label: null
  }

  // 近期样本不足：不伪造 CPM 试算
  if (!isFiniteNumber(targetPrice) || !isFiniteNumber(referenceHigh)) {
    return {
      ...base,
      unavailable_reason: 'stats_insufficient',
      unavailable_label: '近期有效样本不足，暂无法进行 CPM 试算。'
    }
  }
  // 无星图刊例价（null 或 0）：无法按折扣区间试算
  if (!isFiniteNumber(xingtuPrice) || xingtuPrice <= 0) {
    return {
      ...base,
      unavailable_reason: 'quote_missing',
      unavailable_label: '暂无可用星图刊例价，无法按折扣区间进行试算。'
    }
  }

  const price = xingtuPrice * selectedRate
  const cpm = isFiniteNumber(medianPlay) && medianPlay > 0 ? (price / medianPlay) * 1000 : null

  // raw 价格 + 统一 epsilon 比较：恰好等于边界时不得因二进制浮点误差被判成「高于」
  let status = SIMULATOR_STATUS.aboveReferenceRange
  if (lte(price, targetPrice)) status = SIMULATOR_STATUS.atOrBelowTarget
  else if (lte(price, referenceHigh)) status = SIMULATOR_STATUS.withinReferenceRange

  return {
    ...base,
    available: true,
    price: Number(price.toFixed(2)),
    cpm: cpm === null ? null : Number(cpm.toFixed(1)),
    status,
    status_label: SIMULATOR_STATUS_LABELS[status]
  }
}
