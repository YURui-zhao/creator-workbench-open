/**
 * 复投雷达主表「行内展示」纯函数（V3-alpha.3 信息架构）
 *
 * 只做展示层格式化：不重算任何业务指标（median / trend / CPM / work_priority 全部来自后端）。
 * 语义约束：
 *   · 0 是真实数值，不能当空值；只有 null / undefined 才表示「没有可用数据」
 *   · 没有 snapshot → 尚未更新；有 snapshot 但缺 observed_at → 观察日期未知（绝不用 created_at 冒充）
 *   · 「有效 CPM 样本」只作为历史 CPM 的辅助解释（X/Y 次可计算），不表达「其他投放无效」
 */

import { formatCpm, formatPlays } from './format.js'
import { formatPrice } from './pricingDisplay.js'
import { TREND_LABELS, formatObservedAtHint } from './recentPerformanceSave.js'

// 趋势箭头（仅视觉提示，语义仍由 trend_label 决定）
export const TREND_ARROWS = {
  up: '↑',
  down: '↓',
  stable: '→',
  insufficient: ''
}

/** 趋势箭头；未知 / 样本不足 → 空字符串 */
export function getTrendArrow(trendLabel) {
  return TREND_ARROWS[trendLabel] ?? ''
}

/**
 * 主表「近期表现」单元格内容（不产生假数据）
 * @returns {{
 *   hasSnapshot: boolean,
 *   isInsufficient: boolean,
 *   playText: string,        // 近期播放核心值（中位播放）文案，无可用值时为 ''
 *   arrow: string,           // 轻量趋势箭头
 *   trendText: string,       // 趋势文字（上升 / 基本稳定 / 下降 / 样本不足）
 *   observedHint: string,    // 数据截至 MM-DD / 观察日期未知 / ''（无快照）
 *   statusText: string       // 无快照或样本不足时的状态文案（否则 ''）
 * }}
 */
export function buildRecentPerformanceCell(snapshot) {
  if (!snapshot) {
    return {
      hasSnapshot: false,
      isInsufficient: false,
      playText: '',
      arrow: '',
      trendText: '',
      observedHint: '',
      statusText: '尚未更新'
    }
  }
  const statsOk =
    snapshot.stats_status === 'ok' &&
    snapshot.median_play !== null &&
    snapshot.median_play !== undefined
  return {
    hasSnapshot: true,
    isInsufficient: !statsOk,
    playText: statsOk ? formatPlays(snapshot.median_play) : '',
    arrow: statsOk ? getTrendArrow(snapshot.trend_label) : '',
    trendText: statsOk ? TREND_LABELS[snapshot.trend_label] || '样本不足' : '样本不足',
    observedHint: formatObservedAtHint(snapshot),
    statusText: statsOk ? '' : '样本不足'
  }
}

/**
 * 历史 CPM 单元格的辅助解释行：`2/3 次可计算 · 2/2 达标`
 * - 有效样本 0 次时只说明「0/N 次可计算」（不显示 0/0 达标，避免误导）
 * - 全部可计算时省略「次可计算」部分，只显示「X/X 达标」？——不省略，保持口径一致
 * 0 是真实数值：passCount / validCpmCount 为 0 时照常显示。
 */
export function formatCpmCoverageLine({ recordCount, validCpmCount, passCount } = {}) {
  const records = Number.isFinite(Number(recordCount)) ? Number(recordCount) : 0
  const valid = Number.isFinite(Number(validCpmCount)) ? Number(validCpmCount) : 0
  const pass = Number.isFinite(Number(passCount)) ? Number(passCount) : 0
  if (valid <= 0) return `0/${records} 次可计算`
  return `${valid}/${records} 次可计算 · ${pass}/${valid} 达标`
}

/** 历史 CPM 主值：仅 null / undefined 显示占位（0 照常显示） */
export function formatMedianCpmValue(medianCpm) {
  if (medianCpm === null || medianCpm === undefined) return ''
  return formatCpm(medianCpm)
}

/**
 * Alpha.3-02：最近一次真实投放记录的实际合作价（last_actual_cost）
 * - 0 是真实记录值 → ¥0（绝不显示成缺失）
 * - null / undefined / 非有限值 → 暂无
 * 只做展示：字段来自后端 creator_records.total_cost，与星图价 / 报价 / 谈成价 / 目标价无关。
 */
export function formatLastActualCostValue(lastActualCost) {
  if (lastActualCost === null || lastActualCost === undefined) return '暂无'
  const num = Number(lastActualCost)
  if (!Number.isFinite(num)) return '暂无'
  return formatPrice(num)
}

/** 「最近合作」单元格第三行文案：上次合作 ¥11,000 / 上次合作 ¥0 / 上次合作价暂无 */
export function formatLastActualCostLabel(lastActualCost) {
  const value = formatLastActualCostValue(lastActualCost)
  return value === '暂无' ? '上次合作价暂无' : `上次合作 ${value}`
}

/**
 * Alpha.3-03：分组折叠状态（纯前端视图状态）
 * - 默认全部展开：空对象 = 没有任何分组被折叠
 * - 只影响「是否渲染该组表格内容」，不参与筛选 / 计数 / 排序
 * - 不写 DB、不写 localStorage / sessionStorage，刷新后回到全部展开
 */
export const DEFAULT_COLLAPSED_GROUPS = {}

export function isGroupCollapsed(collapsedGroups, groupKey) {
  return Boolean(collapsedGroups?.[groupKey])
}

/** 切换单个分组（返回新对象，不改写入参；其它分组的折叠状态保持不变） */
export function toggleGroupCollapsed(collapsedGroups, groupKey) {
  const current = collapsedGroups && typeof collapsedGroups === 'object' ? collapsedGroups : {}
  return { ...current, [groupKey]: !isGroupCollapsed(current, groupKey) }
}
