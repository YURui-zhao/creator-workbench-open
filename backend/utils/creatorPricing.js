/**
 * CPM30 价格判断层（V3-alpha P3，纯函数）
 *
 * 只消费 P2B 的 latest snapshot 统计结果（median / p25 / p75 / xingtu_price / stats_status），
 * 不重新读截图、不调用 AI、不重新实现近期统计。
 *
 * 定义：
 *   target_price      = median_play * TARGET_CPM / 1000
 *   reference_low     = p25_play    * TARGET_CPM / 1000
 *   reference_high    = p75_play    * TARGET_CPM / 1000
 *   regular_70_price  = xingtu_price * 0.7      （常规折扣参考）
 *   min_20_price      = xingtu_price * 0.2      （业务经验最低参考边界，不是硬下限）
 *   entry_discount    = reference_high / xingtu_price   （谈到多少折才「进入」参考区间）
 *   target_discount   = target_price   / xingtu_price   （目标成交折扣）
 *
 * 边界一律用 raw 值 + 统一 epsilon 比较，避免二进制浮点误判（P2B 的 ±20% 教训）。
 * 对外金额 round2、折扣 rate 保留 4 位、折数（rate*10）保留 2 位，展示层再格式化。
 */

import {
  NEGOTIATION_DISCOUNT_MAX,
  NEGOTIATION_DISCOUNT_MIN,
  PRICING_VERSION,
  TARGET_CPM
} from './creatorBusinessRules.js'

// 统一比较容差（元）：只用于「恰好相等」的边界稳定判定，不参与任何数值输出
export const COMPARE_EPSILON = 1e-6

export const PRICING_STATUS = {
  insufficient: 'stats_insufficient',
  quoteMissing: 'quote_missing',
  quoteZero: 'quote_zero',
  atOrBelowTarget: 'at_or_below_target',
  withinReferenceRange: 'within_reference_range',
  // 以下三个状态以「2～7折可谈区间」表述，不再暗示「7折是固定策略」
  negotiationMaxEntersRange: 'negotiation_max_enters_range',
  deeperNegotiationWithinRange: 'deeper_negotiation_within_range',
  belowNegotiationMinNeeded: 'below_negotiation_min_needed'
}

export const PRICING_STATUS_LABELS = {
  [PRICING_STATUS.insufficient]: '近期有效样本不足，暂无法计算 CPM30目标价',
  // A3：星图刊例价是可选事实，没有它只影响「星图锚定的折扣」，不影响目标价/参考区间
  [PRICING_STATUS.quoteMissing]: '暂无星图刊例价，暂不计算星图折扣',
  [PRICING_STATUS.quoteZero]: '星图价为0，当前价格低于CPM30目标价',
  [PRICING_STATUS.atOrBelowTarget]: '当前刊例价已不高于 CPM30目标价',
  [PRICING_STATUS.withinReferenceRange]: '当前刊例价高于目标价，但仍处于 CPM30参考区间内',
  [PRICING_STATUS.negotiationMaxEntersRange]: '在当前2～7折谈价区间内，7折已可进入 CPM30参考区间。',
  [PRICING_STATUS.deeperNegotiationWithinRange]: '需要在2～7折谈价区间内继续向下议价，才能进入 CPM30参考区间。',
  [PRICING_STATUS.belowNegotiationMinNeeded]: '即使谈至2折，仍高于 CPM30参考区间上限。'
}

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const round2 = (value) => (isFiniteNumber(value) ? Number(value.toFixed(2)) : null)
const round4 = (value) => (isFiniteNumber(value) ? Number(value.toFixed(4)) : null)
const toZhe = (rate) => (isFiniteNumber(rate) ? Number((rate * 10).toFixed(2)) : null)

/** a <= b（含统一 epsilon）；用于所有「恰好等于」的边界 */
const isLte = (a, b) => a <= b + COMPARE_EPSILON
/** a > b（含统一 epsilon）；与 isLte 严格互补 */
const isGt = (a, b) => a > b + COMPARE_EPSILON

/**
 * 计算 CPM30 价格判断结果
 * @param {{stats_status?: string, median_play?: number|null, p25_play?: number|null,
 *          p75_play?: number|null, xingtu_price?: number|null}} input latest snapshot 的统计字段
 *
 * 注意：本函数**只以星图刊例价（xingtu_price）为折扣锚点**。
 * P4 的实际报价（current_quote）是事实记录，不再跑完整 pricing，见 backend/utils/currentQuoteAssessment.js。
 */
export function computeCreatorPricing(input = {}) {
  const statsStatus = input?.stats_status
  const medianPlay = input?.median_play
  const p25Play = input?.p25_play
  const p75Play = input?.p75_play
  const xingtuPrice = input?.xingtu_price

  const result = {
    pricing_version: PRICING_VERSION,
    target_cpm: TARGET_CPM,
    target_price: null,
    reference_low: null,
    reference_high: null,
    xingtu_price: isFiniteNumber(xingtuPrice) ? xingtuPrice : null,
    // 可谈折扣区间（2～7折）对应的价格边界（锚定星图刊例价）
    negotiation_max_price: null,
    negotiation_min_price: null,
    entry_discount_rate: null,
    entry_discount_zhe: null,
    target_discount_rate: null,
    target_discount_zhe: null,
    pricing_status: PRICING_STATUS.insufficient,
    pricing_status_label: PRICING_STATUS_LABELS[PRICING_STATUS.insufficient],
    needs_negotiation: false,
    target_discount_below_negotiation_min: false,
    quote_at_or_below_target: false,
    quote_at_or_below_reference_high: false
  }

  // ---------- 1. 近期统计是否可用于核算 ----------
  const statsUsable =
    statsStatus === 'ok' && isFiniteNumber(medianPlay) && isFiniteNumber(p25Play) && isFiniteNumber(p75Play)
  if (!statsUsable) {
    return result // target / range / discount 全部保持 null，不强行用少量样本估算
  }

  // raw 值参与全部判断；只有输出时才 round
  const rawTargetPrice = (medianPlay * TARGET_CPM) / 1000
  const rawReferenceLow = (p25Play * TARGET_CPM) / 1000
  const rawReferenceHigh = (p75Play * TARGET_CPM) / 1000
  result.target_price = round2(rawTargetPrice)
  result.reference_low = round2(rawReferenceLow)
  result.reference_high = round2(rawReferenceHigh)

  // ---------- 2. 星图刊例价缺失 → 仍展示目标价与区间，但不做折扣比较 ----------
  if (!isFiniteNumber(xingtuPrice)) {
    result.pricing_status = PRICING_STATUS.quoteMissing
    result.pricing_status_label = PRICING_STATUS_LABELS[PRICING_STATUS.quoteMissing]
    return result
  }

  const quote = xingtuPrice
  const negotiationMaxPrice = quote * NEGOTIATION_DISCOUNT_MAX
  const negotiationMinPrice = quote * NEGOTIATION_DISCOUNT_MIN
  result.negotiation_max_price = round2(negotiationMaxPrice)
  result.negotiation_min_price = round2(negotiationMinPrice)

  // ---------- 3. 星图价为 0：不除零 ----------
  if (quote === 0) {
    result.pricing_status = PRICING_STATUS.quoteZero
    result.pricing_status_label = PRICING_STATUS_LABELS[PRICING_STATUS.quoteZero]
    result.quote_at_or_below_target = true
    result.quote_at_or_below_reference_high = true
    return result
  }

  // 折扣（raw）：entry = 进入参考区间所需折扣；target = 目标成交折扣
  const rawEntryRate = rawReferenceHigh / quote
  const rawTargetRate = rawTargetPrice / quote
  result.entry_discount_rate = round4(rawEntryRate)
  result.entry_discount_zhe = toZhe(rawEntryRate)
  result.target_discount_rate = round4(rawTargetRate)
  result.target_discount_zhe = toZhe(rawTargetRate)

  result.quote_at_or_below_target = isLte(quote, rawTargetPrice)
  result.quote_at_or_below_reference_high = isLte(quote, rawReferenceHigh)
  result.target_discount_below_negotiation_min = isGt(NEGOTIATION_DISCOUNT_MIN, rawTargetRate)

  // ---------- 4. 价格状态（只看价格，不判断达人是否值得合作） ----------
  let status
  if (isLte(quote, rawTargetPrice)) {
    status = PRICING_STATUS.atOrBelowTarget
  } else if (isLte(quote, rawReferenceHigh)) {
    status = PRICING_STATUS.withinReferenceRange
  } else if (isLte(negotiationMaxPrice, rawReferenceHigh)) {
    status = PRICING_STATUS.negotiationMaxEntersRange
  } else if (isLte(negotiationMinPrice, rawReferenceHigh)) {
    status = PRICING_STATUS.deeperNegotiationWithinRange
  } else {
    status = PRICING_STATUS.belowNegotiationMinNeeded
  }
  result.pricing_status = status
  result.pricing_status_label = PRICING_STATUS_LABELS[status]
  result.needs_negotiation = isGt(quote, rawReferenceHigh)
  return result
}
