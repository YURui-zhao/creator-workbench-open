/**
 * 谈判案例（V3-alpha.2 A4，纯函数）
 *
 * 价格语义永久分开（绝不互相覆盖）：
 *   xingtu_price     星图刊例价（来自 recent snapshot，可能为空）
 *   current_quote    达人/商务当前报价（来自 P4 Decision，可能为空）
 *   negotiated_price 最终谈成价（由用户明确确认；本模块唯一的新增事实）
 *   actual_cost      真实投放花费（来自 creator_records / Outcome，与谈成价互不同步）
 *
 * 本模块只做确定性计算，不评价谈判质量、不评分、不调用 AI。
 * 边界比较沿用 P3/P4 的统一步长（COMPARE_EPSILON），只用 raw 值判断，最后才 round。
 */

import { COMPARE_EPSILON } from './creatorPricing.js'

// 谈价原因标签（第一版固定 allowlist，由用户选择，AI 不参与打标签）
export const NEGOTIATION_REASON_TAGS = [
  { value: 'history_performance_plain', label: '历史投放效果一般' },
  { value: 'budget_limited', label: '预算有限' },
  { value: 'long_term_cooperation', label: '长期合作 / 复投预期' },
  { value: 'batch_cooperation', label: '批量合作' },
  { value: 'creator_price_cut', label: '达人主动让价' },
  { value: 'schedule_factor', label: '档期因素' },
  { value: 'other', label: '其他' },
  // Phase 4F-B：结合 Playbook 真实业务经验补充的谈价原因（全部由用户勾选，系统不自动预选）
  { value: 'sponsored_below_organic', label: '商单播放低于日常' },
  { value: 'sponsored_sample_low', label: '商单样本较少' },
  { value: 'playback_volatile', label: '播放波动较大' },
  { value: 'quote_above_playbook_range', label: '报价高于经验估价' },
  { value: 'quote_above_history_reference', label: '报价高于历史同量级案例' }
]

export const NEGOTIATION_REASON_TAG_VALUES = NEGOTIATION_REASON_TAGS.map((tag) => tag.value)

export const NEGOTIATION_REASON_TAG_LABELS = Object.fromEntries(
  NEGOTIATION_REASON_TAGS.map((tag) => [tag.value, tag.label])
)

export const MAX_NEGOTIATION_NOTE_LENGTH = 500

// Historical Negotiation Backfill V0.1
//   source_type = live（实时谈价工作流，走 decision_id）
//               | historical_backfill（历史真实案例回填，走 record_id）
export const NEGOTIATION_SOURCE_TYPES = ['live', 'historical_backfill']
// 历史谈价原始备注：人工维护的 source of truth（比 reason/strategy note 承载更多原始上下文）
export const MAX_SOURCE_NOTE_LENGTH = 2000

// Negotiation Unification V0.2：
//   live 谈价事实允许挂在「报价阶段（post_quote）」的哪些人工决定上。
//   真实使用中谈价常常发生在系统之外（谈完才回到系统记录），因此不再强制必须是 negotiate：
//     negotiate   继续议价（原始流程）
//     proceed     直接推进（谈完价后直接记录已发生谈价）
//     small_test  小额测试
//     pause       暂缓（谈过价但最终暂停 —— 记录的是已发生的谈价事实）
//   注意：这里只约束「候选达人」决策；legacy（candidate_id = NULL）保持既有宽松行为。
//   candidate_review / contact / observe 等非报价阶段决策永远不能挂谈价案例（不伪造报价阶段）。
export const NEGOTIATION_CANDIDATE_LIVE_DECISIONS = ['negotiate', 'proceed', 'small_test', 'pause']

// 业务日期校验唯一实现（Real Data Calibration V1 起抽到 businessDate.js，避免第二套日期规则）
export { isValidDateOnly } from './businessDate.js'

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const round2 = (value) => (isFiniteNumber(value) ? Number(value.toFixed(2)) : null)
const round4 = (value) => (isFiniteNumber(value) ? Number(value.toFixed(4)) : null)
const toZhe = (rate) => (isFiniteNumber(rate) ? Number((rate * 10).toFixed(2)) : null)
const isLte = (a, b) => a <= b + COMPARE_EPSILON
const isGt = (a, b) => a > b + COMPARE_EPSILON

/** 谈价结果相对各起始价格的事实（只描述事实，不做评价） */
export function computeNegotiationOutcome({
  negotiatedPrice,
  xingtuPriceSnapshot = null,
  currentQuoteSnapshot = null,
  targetPriceSnapshot = null,
  referenceLowSnapshot = null,
  referenceHighSnapshot = null
} = {}) {
  const result = {
    negotiated_price: isFiniteNumber(negotiatedPrice) ? negotiatedPrice : null,
    has_xingtu: false,
    // has_quote：是否存在「报价事实」——current_quote = 0 也是明确记录到的报价事实
    has_quote: false,
    // quote_drop_computable：能否用报价作为基准做百分比比较（报价 > 0 才行，0 不能做分母）
    quote_drop_computable: false,
    // 相对星图刊例价（只在有星图价时可用；没有就是没有，绝不显示 0 折）
    negotiated_vs_xingtu_rate: null,
    negotiated_vs_xingtu_zhe: null,
    // Phase 4F-B：read-time 派生比率（不落库；命名用于未来 Negotiation Reference 复用）
    xingtu_discount_ratio: null,
    xingtu_discount_zhe: null,
    quote_retention_ratio: null,
    quote_change_rate: null,
    initial_quote_to_xingtu_ratio: null,
    // 相对达人报价的变化（可能为降价，也可能为加价）
    quote_drop_amount: null,
    quote_drop_rate: null,
    quote_drop_direction: null, // 'drop' | 'increase' | 'flat'
    // 与 CPM30 目标价 / 参考区间的事实对照
    vs_target_amount: null,
    vs_target_status: null, // 'at_or_below_target' | 'above_target'
    within_reference_range: null
  }
  if (!isFiniteNumber(negotiatedPrice)) return result

  if (isFiniteNumber(xingtuPriceSnapshot) && xingtuPriceSnapshot > 0) {
    const rate = negotiatedPrice / xingtuPriceSnapshot
    result.has_xingtu = true
    result.negotiated_vs_xingtu_rate = round4(rate)
    result.negotiated_vs_xingtu_zhe = toZhe(rate)
    // 同一事实的「可迁移经验」命名（未来跨量级只传比率，不传绝对价格）
    result.xingtu_discount_ratio = round4(rate)
    result.xingtu_discount_zhe = toZhe(rate)
  }

  // 报价为 0 是「真实记录到的 0 元报价」，不等于「没有报价」：
  //   · has_quote → true（事实存在，UI 显示「达人报价 ¥0」而不是「暂无」）
  //   · 但 0 不能作为百分比基准，因此不计算 quote_drop_*（绝不产生 Infinity / NaN）
  if (isFiniteNumber(currentQuoteSnapshot)) {
    result.has_quote = true
    if (currentQuoteSnapshot > 0) {
      // 当前报价 → 星图刊例（比值事实；报价为 0 时不做比例，避免无意义/误导的 0 折）
      if (isFiniteNumber(xingtuPriceSnapshot) && xingtuPriceSnapshot > 0) {
        result.initial_quote_to_xingtu_ratio = round4(currentQuoteSnapshot / xingtuPriceSnapshot)
      }
      const drop = currentQuoteSnapshot - negotiatedPrice
      result.quote_drop_computable = true
      result.quote_drop_amount = round2(drop)
      result.quote_drop_rate = round4(drop / currentQuoteSnapshot)
      result.quote_drop_direction = isGt(drop, 0) ? 'drop' : isGt(-drop, 0) ? 'increase' : 'flat'
      // 保留率与变化率（变化率带符号：<0 下降 / =0 不变 / >0 上升；绝不出现"下降 -X%"）
      result.quote_retention_ratio = round4(negotiatedPrice / currentQuoteSnapshot)
      result.quote_change_rate = round4((negotiatedPrice - currentQuoteSnapshot) / currentQuoteSnapshot)
    }
  }

  if (isFiniteNumber(targetPriceSnapshot)) {
    result.vs_target_amount = round2(negotiatedPrice - targetPriceSnapshot)
    result.vs_target_status = isLte(negotiatedPrice, targetPriceSnapshot)
      ? 'at_or_below_target'
      : 'above_target'
  }
  if (isFiniteNumber(referenceHighSnapshot)) {
    result.within_reference_range = isLte(negotiatedPrice, referenceHighSnapshot)
  }
  return result
}

/** 把数据库行转成对外案例对象（含确定性派生结果与标签文案） */
export function toPublicNegotiationCase(row) {
  if (!row) return null
  let reasonTags = []
  try {
    const parsed = JSON.parse(row.reason_tags_json)
    reasonTags = Array.isArray(parsed) ? parsed.filter((tag) => NEGOTIATION_REASON_TAG_VALUES.includes(tag)) : []
  } catch {
    reasonTags = []
  }
  return {
    id: row.id,
    creator: row.creator,
    decision_id: row.decision_id ?? null,
    snapshot_id: row.snapshot_id ?? null,
    // Historical Negotiation Backfill V0.1：来源与稳定身份
    source_type: row.source_type || 'live',
    record_id: row.record_id ?? null,
    source_note: row.source_note ?? null,
    xingtu_price_snapshot: row.xingtu_price_snapshot ?? null,
    current_quote_snapshot: row.current_quote_snapshot ?? null,
    negotiated_price: row.negotiated_price,
    negotiated_at: row.negotiated_at,
    reason_tags: reasonTags,
    reason_tag_labels: reasonTags.map((tag) => NEGOTIATION_REASON_TAG_LABELS[tag]),
    reason_note: row.reason_note ?? null,
    strategy_note: row.strategy_note ?? null,
    target_cpm: row.target_cpm ?? null,
    target_price_snapshot: row.target_price_snapshot ?? null,
    reference_low_snapshot: row.reference_low_snapshot ?? null,
    reference_high_snapshot: row.reference_high_snapshot ?? null,
    created_at: row.created_at,
    outcome: computeNegotiationOutcome({
      negotiatedPrice: row.negotiated_price,
      xingtuPriceSnapshot: row.xingtu_price_snapshot,
      currentQuoteSnapshot: row.current_quote_snapshot,
      targetPriceSnapshot: row.target_price_snapshot,
      referenceLowSnapshot: row.reference_low_snapshot,
      referenceHighSnapshot: row.reference_high_snapshot
    })
  }
}
