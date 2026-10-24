/**
 * 实际报价评估（V3-alpha P4，纯函数）
 *
 * 业务口径（最终版）：
 *   · current_quote 是「人拿到的事实」，**不是新的折扣基准**
 *     —— 绝不再用 current_quote × 0.7 / × 0.2 重新算一套谈价区间
 *   · 2～7折谈价区间始终锚定 star: snapshot.xingtu_price（星图刊例价）
 *   · 这里只做两件事：
 *       1) 事实折扣：实际报价约为星图的几折（含超出 2～7 折范围时如实显示）
 *       2) 与 CPM30 目标价 / 参考区间上限的差额（gap）
 *
 * 边界比较沿用 P3 的统一步长（COMPARE_EPSILON），只用 raw 值判断、最后才 round。
 */

import {
  NEGOTIATION_DISCOUNT_MAX,
  NEGOTIATION_DISCOUNT_MIN
} from './creatorBusinessRules.js'
import { COMPARE_EPSILON } from './creatorPricing.js'

export const NEGOTIATION_RANGE_STATUS = {
  aboveRange: 'above_range',
  withinRange: 'within_range',
  belowRange: 'below_range',
  unavailable: 'unavailable'
}

export const NEGOTIATION_RANGE_LABELS = {
  [NEGOTIATION_RANGE_STATUS.aboveRange]: '当前实际报价高于设定的2～7折谈价区间上限。',
  [NEGOTIATION_RANGE_STATUS.withinRange]: '当前实际报价位于设定的2～7折谈价区间内。',
  [NEGOTIATION_RANGE_STATUS.belowRange]: '当前实际报价低于设定的2折谈价区间下限。',
  [NEGOTIATION_RANGE_STATUS.unavailable]: '星图刊例价不可用，无法判断实际报价对应的折扣区间。'
}

export const CURRENT_QUOTE_STATUS = {
  quoteZero: 'quote_zero',
  atOrBelowTarget: 'at_or_below_target',
  withinReferenceRange: 'within_reference_range',
  aboveReferenceRange: 'above_reference_range'
}

export const CURRENT_QUOTE_STATUS_LABELS = {
  [CURRENT_QUOTE_STATUS.quoteZero]: '实际报价为0，已低于 CPM30目标价。',
  [CURRENT_QUOTE_STATUS.atOrBelowTarget]: '实际报价已不高于 CPM30目标价。',
  [CURRENT_QUOTE_STATUS.withinReferenceRange]: '实际报价高于目标价，但仍处于 CPM30参考区间内。',
  [CURRENT_QUOTE_STATUS.aboveReferenceRange]: '实际报价仍高于 CPM30参考区间上限。'
}

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const round2 = (value) => (isFiniteNumber(value) ? Number(value.toFixed(2)) : null)
const round4 = (value) => (isFiniteNumber(value) ? Number(value.toFixed(4)) : null)
const toZhe = (rate) => (isFiniteNumber(rate) ? Number((rate * 10).toFixed(2)) : null)
const isLte = (a, b) => a <= b + COMPARE_EPSILON
const isGt = (a, b) => a > b + COMPARE_EPSILON
const gap = (a, b) => (isFiniteNumber(a) && isFiniteNumber(b) && isGt(a, b) ? round2(a - b) : 0)

/**
 * @param {Object} input
 * @param {number} input.currentQuote 实际报价（已由确定性 parser 解析）
 * @param {number|null} input.xingtuPrice snapshot 的星图刊例价
 * @param {number|null} input.targetPrice CPM30 目标价（来自 xingtu_pricing）
 * @param {number|null} input.referenceHigh CPM30 参考区间上限
 */
export function assessCurrentQuote({ currentQuote, xingtuPrice, targetPrice, referenceHigh } = {}) {
  const assessment = {
    current_quote: isFiniteNumber(currentQuote) ? currentQuote : null,
    actual_vs_xingtu_rate: null,
    actual_vs_xingtu_zhe: null,
    negotiation_range_status: NEGOTIATION_RANGE_STATUS.unavailable,
    negotiation_range_status_label: NEGOTIATION_RANGE_LABELS[NEGOTIATION_RANGE_STATUS.unavailable],
    gap_to_reference_high: 0,
    gap_to_target: 0,
    current_quote_status: null,
    current_quote_status_label: null
  }
  if (!isFiniteNumber(currentQuote)) return assessment

  // ---------- 1) 事实折扣（锚定星图刊例价） ----------
  if (isFiniteNumber(xingtuPrice) && xingtuPrice > 0) {
    const rate = currentQuote / xingtuPrice
    assessment.actual_vs_xingtu_rate = round4(rate)
    assessment.actual_vs_xingtu_zhe = toZhe(rate)
    if (isGt(rate, NEGOTIATION_DISCOUNT_MAX)) {
      assessment.negotiation_range_status = NEGOTIATION_RANGE_STATUS.aboveRange
    } else if (rate < NEGOTIATION_DISCOUNT_MIN - COMPARE_EPSILON) {
      // 低于 2 折下限（恰好等于 2 折仍算区间内）
      assessment.negotiation_range_status = NEGOTIATION_RANGE_STATUS.belowRange
    } else {
      assessment.negotiation_range_status = NEGOTIATION_RANGE_STATUS.withinRange
    }
    assessment.negotiation_range_status_label =
      NEGOTIATION_RANGE_LABELS[assessment.negotiation_range_status]
  }

  // ---------- 2) 与 CPM30 的差额（已低于时不显示负值） ----------
  assessment.gap_to_reference_high = gap(currentQuote, referenceHigh)
  assessment.gap_to_target = gap(currentQuote, targetPrice)

  // ---------- 3) 相对 CPM30 的实际报价状态 ----------
  if (currentQuote === 0) {
    assessment.current_quote_status = CURRENT_QUOTE_STATUS.quoteZero
  } else if (isFiniteNumber(targetPrice) && isLte(currentQuote, targetPrice)) {
    assessment.current_quote_status = CURRENT_QUOTE_STATUS.atOrBelowTarget
  } else if (isFiniteNumber(referenceHigh) && isLte(currentQuote, referenceHigh)) {
    assessment.current_quote_status = CURRENT_QUOTE_STATUS.withinReferenceRange
  } else if (isFiniteNumber(referenceHigh)) {
    assessment.current_quote_status = CURRENT_QUOTE_STATUS.aboveReferenceRange
  }
  assessment.current_quote_status_label = assessment.current_quote_status
    ? CURRENT_QUOTE_STATUS_LABELS[assessment.current_quote_status]
    : null
  return assessment
}
