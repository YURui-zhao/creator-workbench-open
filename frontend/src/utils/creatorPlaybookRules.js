import { formatPlays } from './format.js'

// Creator Decision Playbook V0.1 - Rule Engine（纯函数，deterministic）
//
// 定位：把已冻结的 Playbook 业务经验实现成独立、可测试、可解释的规则。
//   · 相同输入 -> 相同输出（无时间、无随机、无网络、无 AI）
//   · 只读取已确定性计算好的 snapshot 事实；不调用 AI、不写库、不改 schema
//   · 输出的是「可解释的判断维度」，不是评分：
//       没有 overall_score / recommendation_score / should_invest
//   · NULL / 0 严格区分：0 是真实观测，null 才是缺失
//
// 与现有系统的关系（互不覆盖）：
//   · TARGET_CPM = 30 属于历史表现 / 风险体系（backend/utils/creatorBusinessRules.js）
//   · 本模块的 CPM15-20 是新达人「估价锚点」，独立命名、独立维度
//
// 稳定性只用真实播放的 mean / median 判断，刻意不使用标准差 / 变异系数 / P25 / P75。

// 估价锚点 CPM（新达人），与历史体系 TARGET_CPM=30 完全独立
export const PLAYBOOK_ESTIMATE_CPM_LOW = 15
export const PLAYBOOK_ESTIMATE_CPM_HIGH = 20
// 播放量级阈值：中位 >= 10w 视为高量级
export const PLAYBOOK_SCALE_THRESHOLD = 100000
// 稳定性阈值：|mean-median| / median <= 20% 视为稳定
export const PLAYBOOK_STABILITY_THRESHOLD = 0.2
// 浮点边界容差：播放量是整数，真实最小增量远大于该容差，仅用于消除 IEEE 误差
const STABILITY_EPSILON = 1e-9
// 万元高金额风险阈值（严格大于）
export const PLAYBOOK_HIGH_AMOUNT_THRESHOLD = 10000
// 强商单账号阈值
export const PLAYBOOK_STRONG_SPONSORED_MIN = 3
// 有效样本统计的最小样本数（与后端 recentPerformanceStats 一致，仅用于提示）
export const PLAYBOOK_MIN_VALID_FOR_STATS = 5

export const SCALE_LABELS = { base: '基础量级', high: '高量级', unknown: '量级未知' }
export const DENSITY_LABELS = { weak: '弱商单账号', strong: '强商单账号' }
export const STABILITY_LABELS = { stable: '播放较稳定', volatile: '波动较大', unknown: '稳定性未知' }
// 只代表「均值与中位都站在 10w 以上」，并不代表偏差 <= 20%（稳定性是独立维度）
export const HIGH_PLAY_SIGNAL_LABEL = '整体高播放'

/**
 * Pricing Source V2：估价置信文案（source 与 confidence 分离）
 *   normal    = sponsored >= 3（星图样本相对充分）
 *   low       = sponsored 1–2（星图样本较少，但仍给估价）
 *   low_proxy = sponsored = 0 且 organic > 0（日常代理估价）
 *   none      = 没有任何可用于估价的有效样本
 */
export const ESTIMATE_CONFIDENCE_LABELS = {
  normal: '星图样本相对充分',
  low: '较低 · 星图样本较少',
  low_proxy: '较低 · 无星图样本',
  none: '暂无估价'
}

// 有限数字或 null（0 保留为 0；null/undefined/NaN/Infinity/非数字 -> null）
function toFiniteOrNull(value) {
  if (value === null || value === undefined) return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

// 有效播放样本：未排除 且 normalized_play 为有限数字且 >= 0（与后端 valid 口径一致）
function validPlayValues(plays) {
  return (Array.isArray(plays) ? plays : [])
    .filter((play) => play && play.excluded !== true)
    .map((play) => play.normalized_play)
    .filter((value) => Number.isFinite(value) && value >= 0)
}

// 整体平均播放（确定性派生）
// 说明：用全部「有效播放」的算术平均（不提前去极值），因为稳定性判断的语义正是
//       「平均是否被少量高 / 低播放内容拉动」，故保留离群内容的真实影响。
// @returns {number|null} 无有效样本 -> null
export function computeMeanPlay(plays) {
  const values = validPlayValues(plays)
  if (!values.length) return null
  const sum = values.reduce((acc, value) => acc + value, 0)
  return sum / values.length
}

// 规则 1：播放量级（以整体中位为准）
function buildScale(medianPlay) {
  if (medianPlay === null) return { code: 'unknown', label: SCALE_LABELS.unknown }
  return medianPlay >= PLAYBOOK_SCALE_THRESHOLD
    ? { code: 'high', label: SCALE_LABELS.high }
    : { code: 'base', label: SCALE_LABELS.base }
}

// 规则 2：商单密度（只按 sponsored_count）
function buildCommercialDensity(sponsoredCount, organicCount, unknownCount) {
  const strong = sponsoredCount >= PLAYBOOK_STRONG_SPONSORED_MIN
  return {
    code: strong ? 'strong' : 'weak',
    label: strong ? DENSITY_LABELS.strong : DENSITY_LABELS.weak,
    sponsoredCount,
    organicCount,
    unknownCount
  }
}

// 规则 3：播放稳定性（mean vs median，只做确定性比较）
function buildStability(meanPlay, medianPlay) {
  if (medianPlay === null || medianPlay <= 0 || meanPlay === null) {
    return {
      code: 'unknown',
      label: STABILITY_LABELS.unknown,
      deviationRatio: null,
      explanation: '平均播放或中位播放不足，暂不判断稳定性。'
    }
  }
  const deviationRatio = Math.abs(meanPlay - medianPlay) / medianPlay
  const isStable = deviationRatio <= PLAYBOOK_STABILITY_THRESHOLD + STABILITY_EPSILON
  if (isStable) {
    return {
      code: 'stable',
      label: STABILITY_LABELS.stable,
      deviationRatio,
      explanation: '平均播放与中位播放接近，近期表现相对稳定。'
    }
  }
  return {
    code: 'volatile',
    label: STABILITY_LABELS.volatile,
    deviationRatio,
    explanation:
      meanPlay > medianPlay
        ? '平均播放明显高于中位，近期表现可能受到少量高播放内容拉动，估价优先参考中位。'
        : '近期存在低播放内容拖低平均表现，整体波动较大。'
  }
}

// 规则 4：整体高播放（独立维度，不与稳定性互相覆盖；判断条件不变）
function buildHighPlaySignal(meanPlay, medianPlay) {
  const active =
    meanPlay !== null && medianPlay !== null &&
    meanPlay >= PLAYBOOK_SCALE_THRESHOLD && medianPlay >= PLAYBOOK_SCALE_THRESHOLD
  return { active, label: HIGH_PLAY_SIGNAL_LABEL }
}

// 规则 5：商单优先 / 日常辅助（不生成任何加权综合量）
function buildPerformanceBasis(sponsoredCount, organicCount) {
  if (sponsoredCount >= PLAYBOOK_STRONG_SPONSORED_MIN) {
    return {
      code: 'sponsored_primary',
      confidence: 'normal',
      explanation: '商单样本充足，以商单中位作为主要估价依据，日常数据作为背景。'
    }
  }
  if (sponsoredCount >= 1) {
    return {
      code: 'sponsored_with_organic_support',
      confidence: 'low',
      explanation: '商单仍为第一参考，但商单样本较少，结合日常中位辅助判断。'
    }
  }
  if (organicCount > 0) {
    return {
      code: 'organic_only_low_confidence',
      confidence: 'low_proxy',
      explanation: '暂无商单样本，以日常中位作为代理估价基准（低置信），不能视为商单证据。'
    }
  }
  return {
    code: 'insufficient_classification',
    confidence: 'none',
    explanation: '缺少可用于商单判断的内容分类，暂不形成商单估价。'
  }
}

// 规则 6：CPM15-20 基础估价（不使用日常数据替代商单估价）
// 弱样本（1-2 条）说明：只陈述真实事实（条数 + 商单中位），日常中位仅在有效时作为辅助提示，
// 绝不参与价格计算，也不在缺失时伪造。
function buildWeakSponsoredExplanation(sponsoredCount, sponsoredMedianPlay, organicMedianPlay) {
  let text = `商单样本仅${sponsoredCount}条，当前估价基于商单中位${formatPlays(sponsoredMedianPlay)}`
  if (organicMedianPlay !== null && organicMedianPlay !== undefined) {
    text += `；日常中位${formatPlays(organicMedianPlay)}仅辅助判断，不直接参与商单估价。`
  } else {
    text += '。'
  }
  return text
}

/**
 * Pricing Source V2（冻结规则）：
 *   1) sponsored_count >= 1        → baseline_source = sponsored      / baseline = 商单中位
 *   2) sponsored = 0 && organic>0  → baseline_source = organic_proxy  / baseline = 日常中位
 *   3) 两者都不可用                → baseline_source = none           / 不估价
 * CPM15–20 数学公式不变：baseline_play × 15..20 / 1000；绝不混合两类样本求中位数。
 */
function buildEstimate({ sponsoredCount, sponsoredMedianPlay, organicCount, organicMedianPlay }) {
  if (sponsoredCount >= 1 && sponsoredMedianPlay !== null) {
    return {
      low: (sponsoredMedianPlay * PLAYBOOK_ESTIMATE_CPM_LOW) / 1000,
      high: (sponsoredMedianPlay * PLAYBOOK_ESTIMATE_CPM_HIGH) / 1000,
      cpmLow: PLAYBOOK_ESTIMATE_CPM_LOW,
      cpmHigh: PLAYBOOK_ESTIMATE_CPM_HIGH,
      confidence: sponsoredCount >= PLAYBOOK_STRONG_SPONSORED_MIN ? 'normal' : 'low',
      baselineSource: 'sponsored',
      baselinePlay: sponsoredMedianPlay,
      baselineLabel: `星图中位 ${formatPlays(sponsoredMedianPlay)} · ${sponsoredCount}条`,
      organicReferenceMedian: organicMedianPlay,
      explanation:
        sponsoredCount >= PLAYBOOK_STRONG_SPONSORED_MIN
          ? '以商单中位作为基础估价锚点（CPM 15-20）。'
          : buildWeakSponsoredExplanation(sponsoredCount, sponsoredMedianPlay, organicMedianPlay)
    }
  }
  if (sponsoredCount === 0 && organicCount > 0 && organicMedianPlay !== null && organicMedianPlay !== undefined) {
    return {
      low: (organicMedianPlay * PLAYBOOK_ESTIMATE_CPM_LOW) / 1000,
      high: (organicMedianPlay * PLAYBOOK_ESTIMATE_CPM_HIGH) / 1000,
      cpmLow: PLAYBOOK_ESTIMATE_CPM_LOW,
      cpmHigh: PLAYBOOK_ESTIMATE_CPM_HIGH,
      confidence: 'low_proxy',
      baselineSource: 'organic_proxy',
      baselinePlay: organicMedianPlay,
      baselineLabel: `日常中位 ${formatPlays(organicMedianPlay)} · ${organicCount}条`,
      organicReferenceMedian: organicMedianPlay,
      explanation: '基于日常内容量级估算，商单表现可能存在偏差。'
    }
  }
  return {
    low: null,
    high: null,
    cpmLow: PLAYBOOK_ESTIMATE_CPM_LOW,
    cpmHigh: PLAYBOOK_ESTIMATE_CPM_HIGH,
    confidence: 'none',
    baselineSource: 'none',
    baselinePlay: null,
    baselineLabel: null,
    organicReferenceMedian: organicMedianPlay,
    explanation: '暂无可用于估价的内容样本。'
  }
}

// 规则 7：万元高金额风险（risk flag，不是禁止 / 拒绝 / 评分）
function buildRisk(xingtuPrice) {
  const highAmount = xingtuPrice !== null && xingtuPrice > PLAYBOOK_HIGH_AMOUNT_THRESHOLD
  return {
    highAmount,
    explanation: highAmount
      ? '当前刊例已进入万元以上高金额区间，建议结合近期稳定性、商单表现和后续历史案例人工确认。'
      : null
  }
}

// 统一入口：把一条近期表现 snapshot 转成可解释的判断维度
// @param {Object} snapshot 公开 snapshot（含 plays / median_play / 内容分类统计 / xingtu_price 等）
export function buildCreatorPlaybookAssessment(snapshot = {}) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {}
  const plays = Array.isArray(source.plays) ? source.plays : []

  const medianPlay = toFiniteOrNull(source.median_play)
  // 优先使用已保存的 mean_play；缺失时从 plays 确定性派生（不新增 DB 字段）
  const meanPlay = toFiniteOrNull(source.mean_play) ?? computeMeanPlay(plays)
  const sponsoredMedianPlay = toFiniteOrNull(source.sponsored_median_play)
  const organicMedianPlay = toFiniteOrNull(source.organic_median_play)
  const sponsoredCount = Number(source.sponsored_count ?? 0) || 0
  const organicCount = Number(source.organic_count ?? 0) || 0
  const unknownCount = Number(source.unknown_count ?? 0) || 0
  const xingtuPrice = toFiniteOrNull(source.xingtu_price)

  return {
    metrics: {
      meanPlay,
      medianPlay,
      sponsoredMedianPlay,
      organicMedianPlay,
      sponsoredCount,
      organicCount,
      unknownCount
    },
    scale: buildScale(medianPlay),
    commercialDensity: buildCommercialDensity(sponsoredCount, organicCount, unknownCount),
    stability: buildStability(meanPlay, medianPlay),
    highPlaySignal: buildHighPlaySignal(meanPlay, medianPlay),
    performanceBasis: buildPerformanceBasis(sponsoredCount, organicCount),
    estimate: buildEstimate({
      sponsoredCount,
      sponsoredMedianPlay,
      organicCount,
      organicMedianPlay
    }),
    risk: buildRisk(xingtuPrice)
  }
}
