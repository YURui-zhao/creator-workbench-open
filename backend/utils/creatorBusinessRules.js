/**
 * 达人业务规则常量（V3-alpha P3）
 *
 * 唯一来源：P1（复投雷达达标判定）与 P3（价格判断）必须共用同一个 TARGET_CPM，
 * 不允许出现第二个可漂移的 30。本模块只做常量提取，不含任何逻辑。
 */

// 目标 CPM：单次合作累计 CPM <= 该值视为达标（P1），也是 P3 目标价的换算基准
export const TARGET_CPM = 30

// 可谈折扣区间（锚定星图刊例价）：
//   · 2折 ~ 7折 是允许用户探索的谈价区间边界，不是「固定策略」也不是硬下限
//   · 7折是区间内价格最高的一档，2折是区间内价格最低的一档
export const NEGOTIATION_DISCOUNT_MIN = 0.2
export const NEGOTIATION_DISCOUNT_MAX = 0.7

/** @deprecated 旧命名语义不准确（易被理解为「常规策略」），仅保留兼容，请使用 NEGOTIATION_DISCOUNT_MAX */
export const REGULAR_XINGTU_DISCOUNT_RATE = NEGOTIATION_DISCOUNT_MAX
/** @deprecated 旧命名语义不准确（易被理解为「最低报价策略」），仅保留兼容，请使用 NEGOTIATION_DISCOUNT_MIN */
export const MIN_REFERENCE_DISCOUNT_RATE = NEGOTIATION_DISCOUNT_MIN

// 价格规则版本：口径变化时必须升级，便于未来决策记录追溯当时依据
export const PRICING_VERSION = 'creator-pricing-v1'
