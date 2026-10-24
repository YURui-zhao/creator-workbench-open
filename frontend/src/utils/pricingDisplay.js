/**
 * 价格判断结果的「展示层」格式化（V3-alpha P3）
 *
 * 重要：本模块不做任何价格计算与状态判断 ——
 * 目标价 / 参考区间 / 折扣 / pricing_status 全部由后端
 * backend/utils/creatorPricing.js 确定性给出，前端只负责展示。
 */

// 与后端 creatorBusinessRules.js 保持一致的谈价区间边界（仅用于展示判断，不参与任何价格计算）
const NEGOTIATION_DISCOUNT_MIN = 0.2
const NEGOTIATION_DISCOUNT_MAX = 0.7

/** 金额：整数不带小数，有小数最多 2 位；null → '-' */
export function formatPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-'
  const num = Number(value)
  const isInteger = Math.abs(num - Math.round(num)) < 1e-9
  return `¥${num.toLocaleString('zh-CN', {
    minimumFractionDigits: isInteger ? 0 : 2,
    maximumFractionDigits: 2
  })}`
}

/** 折扣（rate*10 的结果）：整数显示 7折，否则 5.2折；null → '-' */
export function formatZhe(zhe) {
  if (zhe === null || zhe === undefined || !Number.isFinite(Number(zhe))) return '-'
  const num = Number(zhe)
  const isInteger = Math.abs(num - Math.round(num)) < 1e-9
  return `${isInteger ? Math.round(num) : num.toFixed(1)}折`
}

/**
 * 进入参考区间的展示文案：
 * - 刊例价本就不高于参考区间上限 → 明确说明无需为进入区间议价（不显示 >10折）
 * - 进入区间所需折扣高于 7 折 → 说明「7折已可进入」（不谈 >7折的要求）
 * - 进入区间所需折扣低于 2 折 → 明确「即使谈至2折仍高于区间上限」，不做 clamp
 * - 落在 2～7 折区间内 → 显示「≤X折」
 */
export function formatEntryDiscount(pricing) {
  if (!pricing) return '-'
  if (pricing.quote_at_or_below_reference_high) {
    return '当前刊例价已不高于参考区间上限，无需为了进入区间继续议价'
  }
  if (pricing.entry_discount_zhe === null || pricing.entry_discount_zhe === undefined) return '-'
  if (Number(pricing.entry_discount_rate) > NEGOTIATION_DISCOUNT_MAX) {
    return '按当前可谈区间上限7折，已可进入 CPM30参考区间'
  }
  if (Number(pricing.entry_discount_rate) < NEGOTIATION_DISCOUNT_MIN) {
    return '即使谈至2折，仍高于 CPM30参考区间上限'
  }
  return `≤${formatZhe(pricing.entry_discount_zhe)}`
}

/**
 * 目标成交折扣展示文案：
 * - 刊例价已不高于目标价 → 无需继续议价
 * - 目标折扣高于 7 折 → 说明按 7 折已达到/低于目标价
 * - 目标折扣低于 2 折 → 如实保留原始目标并提示低于谈价区间下限，不做 clamp
 * - 否则显示「≈X折」
 */
export function formatTargetDiscount(pricing) {
  if (!pricing) return '-'
  if (pricing.quote_at_or_below_target) {
    return '当前刊例价已不高于 CPM30目标价，无需继续议价'
  }
  if (pricing.target_discount_zhe === null || pricing.target_discount_zhe === undefined) return '-'
  if (Number(pricing.target_discount_rate) > NEGOTIATION_DISCOUNT_MAX) {
    return '按7折已经达到/低于 CPM30目标价'
  }
  const base = `≈${formatZhe(pricing.target_discount_zhe)}`
  return pricing.target_discount_below_negotiation_min
    ? `${base}（低于当前2折谈价区间下限）`
    : base
}

/** 可谈折扣区间（2～7折）对应价格区间文案：¥600～¥2,100 */
export function formatNegotiationRange(pricing) {
  if (!pricing) return '-'
  if (
    pricing.negotiation_min_price === null ||
    pricing.negotiation_min_price === undefined ||
    pricing.negotiation_max_price === null ||
    pricing.negotiation_max_price === undefined
  ) {
    return '-'
  }
  return `${formatPrice(pricing.negotiation_min_price)}～${formatPrice(pricing.negotiation_max_price)}`
}

/** Popover「价格核算」行（纯展示映射，不含计算） */
export function buildPricingRows(pricing) {
  if (!pricing) return []
  const rows = [
    { label: 'CPM30目标价', value: formatPrice(pricing.target_price) },
    {
      label: 'CPM30参考区间',
      value:
        pricing.reference_low === null || pricing.reference_high === null
          ? '-'
          : `${formatPrice(pricing.reference_low)}～${formatPrice(pricing.reference_high)}`
    }
  ]
  if (pricing.pricing_status === 'stats_insufficient') return rows
  rows.push({
    label: '星图刊例价',
    value:
      pricing.xingtu_price === null || pricing.xingtu_price === undefined
        ? '暂无'
        : formatPrice(pricing.xingtu_price)
  })
  if (pricing.pricing_status !== 'quote_missing') {
    rows.push({ label: '可谈折扣区间', value: '2～7折' })
    rows.push({ label: '对应价格区间', value: formatNegotiationRange(pricing) })
    rows.push({ label: '进入参考区间', value: formatEntryDiscount(pricing) })
    rows.push({ label: 'CPM30目标', value: formatTargetDiscount(pricing) })
  }
  return rows
}
