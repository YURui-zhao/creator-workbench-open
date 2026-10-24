/**
 * 达人判断工作区（Alpha.3-05）：布局与信息映射的纯函数
 *
 * 只做「取数 → 文案」的映射，不重算任何业务指标：
 *   历史投放 / 历史 CPM / 达标情况 / 最近合作 / 上次实际合作价
 *   近期中位播放 / trend / 数据截至
 *   商单中位 / 日常中位 / 待分类
 *   星图价 / 当前报价 / CPM30 目标价 / 参考区间
 * 全部字段来自 Radar API 已下发的 creator item（不新增 API、不新增 schema）。
 */

import { formatCpm, formatInteger, formatPlays } from './format.js'
import { buildPricingRows, formatPrice } from './pricingDisplay.js'
import { buildContentPerformanceLines, getSponsoredSampleTier } from './contentType.js'
import { formatLastActualCostValue, formatMedianCpmValue } from './radarRowDisplay.js'
import { TREND_LABELS_FULL } from './recentPerformanceSave.js'

// 桌面端 Drawer 宽度：约 75% 页面宽度，并限制最大宽度；窄屏退化为接近全宽
export const WORKSPACE_WIDTH_RATIO = 0.75
export const WORKSPACE_MAX_WIDTH = 1280
export const WORKSPACE_NARROW_BREAKPOINT = 900

/**
 * @param {number} viewportWidth 当前窗口宽度（px）
 * @returns {number} Drawer 宽度（px），窄屏返回接近全宽
 */
export function computeWorkspaceWidth(viewportWidth) {
  const width = Number(viewportWidth)
  if (!Number.isFinite(width) || width <= 0) return WORKSPACE_MAX_WIDTH
  if (width < WORKSPACE_NARROW_BREAKPOINT) return width
  return Math.min(Math.round(width * WORKSPACE_WIDTH_RATIO), WORKSPACE_MAX_WIDTH)
}

const row = (label, value) => ({ label, value })
const PLACEHOLDER = '-'

/** 区域 A「历史表现」：真实历史投放事实（含上次实际合作价，与最近合作同一条记录） */
export function buildHistoryBlock(creatorItem = {}) {
  const hasMedian = creatorItem.median_cpm !== null && creatorItem.median_cpm !== undefined
  const validCount = Number(creatorItem.valid_cpm_count ?? 0)
  const passCount = Number(creatorItem.pass_count ?? 0)
  return [
    row('历史投放', `${formatInteger(creatorItem.record_count ?? 0)} 次`),
    row('历史CPM中位', hasMedian ? formatCpm(creatorItem.median_cpm) : PLACEHOLDER),
    row('达标情况', validCount > 0 ? `${passCount}/${validCount} 达标` : '暂无可计算样本'),
    row('最近合作', creatorItem.last_collaboration_date || PLACEHOLDER),
    row('上次实际合作价', formatLastActualCostValue(creatorItem.last_actual_cost))
  ]
}

/** 区域 A「近期表现」：整体近期中位播放 / trend / 数据截至（口径与 Radar 列一致） */
export function buildRecentBlock(creatorItem = {}) {
  const snapshot = creatorItem.recent_snapshot
  if (!snapshot) return { empty: true, rows: [row('近期表现', '尚未更新')] }
  const hasMedian = snapshot.median_play !== null && snapshot.median_play !== undefined
  const observed = String(snapshot.observed_at ?? '').trim()
  return {
    empty: false,
    rows: [
      row('近期中位播放', hasMedian ? formatPlays(snapshot.median_play) : '样本不足'),
      row('趋势', TREND_LABELS_FULL[snapshot.trend_label] || '样本不足'),
      row('数据截至', /^\d{4}-\d{2}-\d{2}$/.test(observed) ? observed : '观察日期未知'),
      row('有效样本', `${formatInteger(snapshot.valid_count ?? 0)} 条`)
    ]
  }
}

/** 区域 A「近期内容表现」：商单 / 日常 / 待分类（复用 Radar 同一文案与统计字段） */
export function buildContentBlock(creatorItem = {}) {
  const snapshot = creatorItem.recent_snapshot
  if (!snapshot) return { empty: true, rows: [row('近期内容', '尚未更新')] }
  const cell = buildContentPerformanceLines(snapshot)
  if (cell.lines.length === 0) return { empty: true, rows: [row('近期内容', '暂无可计算样本')] }
  if (cell.state === 'unknown-only') {
    return {
      empty: false,
      rows: [row('商单', '尚未确认'), row('日常', '尚未确认'), row('待分类', `${cell.unknownCount} 条`)]
    }
  }
  const sponsoredLine = cell.lines.find((line) => line.text.startsWith('商单中位'))
  const organicLine = cell.lines.find((line) => line.text.startsWith('日常中位'))
  // 近期表现语义审计：样本充分性直接来自商单样本分档（0 → 暂无 / 1–2 → 较少 / ≥3 → 充足），
  // 不再由「是否出现提示行」反推 —— 0 条商单时旧逻辑会错误显示「商单样本充足」。
  const sponsoredTier = getSponsoredSampleTier(snapshot?.sponsored_count)
  const sampleText =
    sponsoredTier === 'none'
      ? '暂无商单样本'
      : sponsoredTier === 'insufficient'
        ? '商单样本较少'
        : '商单样本充足'
  return {
    empty: false,
    rows: [
      row('商单', sponsoredLine ? sponsoredLine.text.replace('商单中位 ', '') : '暂无商单数据'),
      row('日常', organicLine ? organicLine.text.replace('日常中位 ', '') : '暂无'),
      row('样本', sampleText),
      row('待分类', `${cell.unknownCount} 条`)
    ]
  }
}

/** 区域 A「价格」：星图价 / 当前报价 / CPM30 目标价 / 参考区间（全部来自既有字段） */
export function buildPriceBlock(creatorItem = {}) {
  const snapshot = creatorItem.recent_snapshot
  const pricing = snapshot?.pricing || null
  const quote = creatorItem.recent_decision?.current_quote
  const rangeReady =
    pricing && pricing.reference_low !== null && pricing.reference_high !== null
  return [
    row('星图刊例价', snapshot?.xingtu_price === null || snapshot?.xingtu_price === undefined ? '暂无' : formatPrice(snapshot.xingtu_price)),
    row('当前报价', quote === null || quote === undefined ? '暂无' : formatPrice(quote)),
    row('CPM30目标价', pricing && pricing.target_price !== null ? formatPrice(pricing.target_price) : '暂无'),
    row('参考区间', rangeReady ? `${formatPrice(pricing.reference_low)}～${formatPrice(pricing.reference_high)}` : '暂无')
  ]
}

/** 区域 C「最近决策」：没有决策时返回空状态文案（不是错误态） */
export function buildRecentDecisionBlock(creatorItem = {}) {
  const decision = creatorItem.recent_decision
  if (!decision) {
    return { empty: true, rows: [], emptyText: '还没有记录决策' }
  }
  const outcome = decision.outcome
  const outcomeText = outcome
    ? `已关联投放结果 · CPM30${outcome.target_cpm_status === 'met' ? '已达标' : outcome.target_cpm_status === 'not_met' ? '未达标' : '待更新'}`
    : '尚未关联投放结果'
  return {
    empty: false,
    emptyText: '',
    rows: [
      row('阶段', decision.decision_stage === 'post_quote' ? '已拿到报价' : '联系阶段'),
      row('我的决定', decision.human_decision_label || decision.human_decision || PLACEHOLDER),
      row('实际报价', decision.current_quote === null || decision.current_quote === undefined ? '未填写' : formatPrice(decision.current_quote)),
      // Real Data Calibration V1：主时间 = 业务决策日期；created_at 只作为录入时间展示（绝不冒充决策日期）
      row('决策日期', decision.decided_at || '业务日期未补'),
      row('录入于', String(decision.created_at || '').slice(0, 16) || PLACEHOLDER),
      row('投放结果', outcomeText)
    ]
  }
}

/** 顶部头信息（名称 / 类型 / 已有标签，不再重复计算状态） */
export function buildWorkspaceHeader(creatorItem = {}) {
  return {
    creator: creatorItem.creator || '',
    creator_type: creatorItem.creator_type || '未分类',
    statusLabel: creatorItem.historical_status_label || '',
    statusValue: creatorItem.historical_status || '',
    workPriorityLabel: creatorItem.work_priority_label || null
  }
}

// ---------- Alpha.3-05A：价格区信息收敛（纯展示筛选，不改任何业务判断）----------

// 默认平铺的「核心价格事实」（只做筛选，数据仍来自 buildPricingRows）
export const CORE_PRICE_ROW_LABELS = ['CPM30目标价', 'CPM30参考区间', '星图刊例价']
// 按需展开的「谈价参考」（2～7 折区间与对应价格；无星图价时现有逻辑本就不产生这两行）
export const NEGOTIATION_REFERENCE_ROW_LABELS = ['可谈折扣区间', '对应价格区间']

/** 核心价格事实：CPM30目标价 / CPM30参考区间 / 星图刊例价 */
export function buildCorePriceRows(pricing) {
  return buildPricingRows(pricing).filter((row) => CORE_PRICE_ROW_LABELS.includes(row.label))
}

/** 谈价参考（默认收起）：可谈折扣区间 + 对应价格区间；不可用时返回空数组（不伪造） */
export function buildNegotiationReferenceRows(pricing) {
  return buildPricingRows(pricing).filter((row) => NEGOTIATION_REFERENCE_ROW_LABELS.includes(row.label))
}

/**
 * 唯一的一条价格结论：直接复用后端 pricing_status_label（唯一来源），前端不重算
 * 例：「当前刊例价已不高于 CPM30目标价」/「暂无星图刊例价，暂不计算星图折扣」/「近期有效样本不足…」
 */
export function buildPriceConclusion(pricing) {
  if (!pricing) return { text: '暂无可用的价格判断', status: null }
  return {
    text: pricing.pricing_status_label || '暂无可用的价格判断',
    status: pricing.pricing_status ?? null
  }
}
