/**
 * 决策 ↔ 真实投放结果 关联（V3-alpha P5，纯函数）
 *
 * 核心原则：
 *   · Decision evidence = frozen（creator_decisions 一旦写入永不回写）
 *   · Outcome result    = live（花费 / 播放 / CPM 一律实时取自 creator_records）
 * 因此本模块只产出「基于当前 creator_record 的实时事实」，不复制、不固化任何结果数值。
 *
 * 播放 / CPM 口径严格复用 V2（backend/routes/records.js）：
 *   first_play       = 7日累计播放量
 *   second_week_play = 最新累计播放量（latest_play）
 *   subsequent_play  = latest - first（仅 latest 有效且 latest >= first 时）
 *   first_cpm        = cost / first  × 1000
 *   latest_cpm       = cost / latest × 1000
 *   latest = null → 待更新（pending）；latest = 0 → 真实观测 0；latest < first → 异常
 *
 * 不写库、不调用 AI、不访问外部网络。P5 只做事实描述，不做决策评价。
 */

import { computePlayMetrics, computeRecordFirstCpm, computeRecordLatestCpm } from '../routes/records.js'
import { TARGET_CPM } from './creatorBusinessRules.js'

// 只有「已拿到报价 且 决定实际投放」的决策才允许关联真实投放结果
export const OUTCOME_ELIGIBLE_STAGES = ['post_quote']
// 旧历史达人（candidate_id = NULL）：保持原样，不接受 candidate 专用的 proceed
export const OUTCOME_ELIGIBLE_DECISIONS = ['repurchase', 'small_test']
// Phase 4D：candidate（candidate_id 非空）第一次投放，用 proceed 取代语义错误的 repurchase
export const CANDIDATE_OUTCOME_ELIGIBLE_DECISIONS = ['proceed', 'small_test']

// latest 观测状态（事实，不含评价）
export const LATEST_STATUS = {
  pending: 'pending', // 累计播放未更新
  anomaly: 'anomaly', // latest < first，异常历史数据
  observed: 'observed' // 已填写（含 0）
}

export const LATEST_STATUS_LABELS = {
  [LATEST_STATUS.pending]: '待更新',
  [LATEST_STATUS.anomaly]: '异常',
  [LATEST_STATUS.observed]: '已更新'
}

// 累计 CPM 相对 TARGET_CPM 的事实状态（不是「决策是否成功」）
export const TARGET_CPM_STATUS = {
  pending: 'pending',
  anomaly: 'anomaly',
  zeroPlay: 'zero_play',
  met: 'met',
  notMet: 'not_met'
}

export const TARGET_CPM_STATUS_LABELS = {
  [TARGET_CPM_STATUS.pending]: '待更新',
  [TARGET_CPM_STATUS.anomaly]: '异常',
  [TARGET_CPM_STATUS.zeroPlay]: '累计播放为0，无法计算CPM',
  [TARGET_CPM_STATUS.met]: '已达标',
  [TARGET_CPM_STATUS.notMet]: '未达标'
}

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const round2 = (value) => (isFiniteNumber(value) ? Number(value.toFixed(2)) : null)

/** 判断一条 decision 是否具备关联 outcome 的资格（事实判定，不做任何业务评价） */
export function isDecisionEligibleForOutcome(decision) {
  if (!decision) return { eligible: false, reason: '决策记录不存在' }
  if (!OUTCOME_ELIGIBLE_STAGES.includes(decision.decision_stage)) {
    return { eligible: false, reason: '该决策未进入实际投放阶段' }
  }
  // 合法决策集按身份来源区分：旧历史达人 / candidate（candidate_review 仍全部不 eligible）
  const isCandidateDecision = decision.candidate_id !== null && decision.candidate_id !== undefined
  const allowed = isCandidateDecision
    ? CANDIDATE_OUTCOME_ELIGIBLE_DECISIONS
    : OUTCOME_ELIGIBLE_DECISIONS
  if (!allowed.includes(decision.human_decision)) {
    return { eligible: false, reason: '该决策未进入实际投放阶段' }
  }
  return { eligible: true, reason: null }
}

/**
 * Phase 4C：决策 ↔ 投放记录 的身份校验（纯函数）
 *
 * 两条路径严格分开：
 *   · 旧历史达人（candidateId = null）：沿用 record.nickname === frozenCreator；
 *     identity_confirmed 对其「完全无效」，不能成为绕过名称校验的万能开关。
 *   · candidate decision（candidateId 非空）：按「candidate 当前 name」校验（改名后仍可关联）；
 *     若 record.nickname !== candidate 当前 name，默认拒绝，只有显式 identity_confirmed 才放行。
 *
 * 注意：这是「人工身份确认」，不是系统自动判断同一达人；frozen decision.creator 可能是旧名字，绝不作为依据。
 * @returns {{ ok: boolean, mode: 'legacy'|'candidate', code?: number, message?: string, requiresIdentityConfirmation?: boolean }}
 */
export function evaluateOutcomeIdentity({
  candidateId = null,
  candidateName = null,
  frozenCreator = '',
  recordNickname = '',
  recordId = null,
  identityConfirmed = false,
  // 由调用方（route）查询后传入：当前 candidate.name 在 creator_candidates 中是否对应多个 candidate_id。
  // 纯函数自身绝不查 DB；名称重复时「名称相同」不足以证明归属，必须显式人工确认。
  candidateNameAmbiguous = false
} = {}) {
  const recordName = String(recordNickname ?? '').trim()
  const isCandidateDecision = candidateId !== null && candidateId !== undefined

  if (!isCandidateDecision) {
    if (recordName !== frozenCreator) {
      return {
        ok: false,
        code: 400,
        mode: 'legacy_exact_name',
        nameMatch: false,
        candidateNameAmbiguous: false,
        requiresIdentityConfirmation: false,
        overrideUsed: false,
        message: `投放记录 #${recordId} 属于「${recordName || '未命名'}」，不能关联给达人「${frozenCreator}」的决策`
      }
    }
    return {
      ok: true,
      mode: 'legacy_exact_name',
      nameMatch: true,
      candidateNameAmbiguous: false,
      requiresIdentityConfirmation: false,
      overrideUsed: false
    }
  }

  const currentName = String(candidateName ?? '').trim()
  const nameMatches = recordName === currentName
  // 名称唯一且一致 → 直接通过；名称重复（存在多个同名候选）时即使一致也不能静默通过
  if (nameMatches && candidateNameAmbiguous !== true) {
    return {
      ok: true,
      mode: 'candidate_current_name',
      nameMatch: true,
      candidateNameAmbiguous: false,
      requiresIdentityConfirmation: false,
      overrideUsed: false
    }
  }
  if (identityConfirmed !== true) {
    return {
      ok: false,
      code: 409,
      mode: 'candidate_identity_override',
      nameMatch: nameMatches,
      candidateNameAmbiguous: candidateNameAmbiguous === true,
      requiresIdentityConfirmation: true,
      overrideUsed: false,
      ambiguousName: nameMatches,
      message: nameMatches
        ? '存在多个同名候选达人，仅凭名称无法确认该投放记录的身份归属。如确认该记录属于当前候选达人，请显式确认后再关联。'
        : '投放记录中的达人名称与当前候选达人名称不同。如果确认这是同一达人，请显式确认身份后再关联。'
    }
  }
  return {
    ok: true,
    mode: 'candidate_identity_override',
    nameMatch: nameMatches,
    candidateNameAmbiguous: candidateNameAmbiguous === true,
    requiresIdentityConfirmation: true,
    overrideUsed: true
  }
}

/** Outcome linking 证据版本（Phase 4E） */
export const OUTCOME_LINK_EVIDENCE_VERSION = 'outcome-link-v0.1'

/**
 * Phase 4E / Real Data Calibration V1：timing 确认评估（纯函数）
 *   · comparison base = decision.decided_at（真实业务决策日期）
 *   · confirmation_required：发布日期早于业务决策日期
 *   · decided_at 缺失（legacy 旧行）→ business_date_missing = true，且 confirmation_required = true：
 *     绝不把 created_at（系统录入时间）伪装成可靠业务时间去生成 timing 证据。
 *   · override_used = required && provided（只有「本来需要 + 用户显式确认」才算人工 override）
 */
export function evaluateOutcomeTiming({
  publishDate = null,
  decisionDecidedAt = null,
  decisionCreatedAt = null,
  timingConfirmed = false
} = {}) {
  const businessDateMissing = !dateOnlyOf(decisionDecidedAt)
  const confirmationRequired =
    businessDateMissing || computeTimingWarning(publishDate, decisionDecidedAt) === true
  const confirmationProvided = timingConfirmed === true
  return {
    confirmationRequired,
    confirmationProvided,
    overrideUsed: confirmationRequired && confirmationProvided,
    businessDateMissing,
    decisionDecidedAt: decisionDecidedAt ?? null,
    decisionCreatedAt: decisionCreatedAt ?? null,
    recordPublishDate: publishDate ?? null
  }
}

/**
 * Phase 4E：冻结一次 outcome linking 事件的完整上下文
 * 只记录「为什么允许关联」（身份 / 时间的人工确认证据），不复制 creator_record 的业务结果事实。
 * confirmation_provided 记录「请求是否显式传了 true」；override_used 只在「本来必须确认 + 已确认」时为 true，
 * 避免「本来名称一致却误传 identity_confirmed=true」被记成人工 override 的假历史。
 */
export function buildOutcomeLinkEvidence({
  candidateId = null,
  frozenDecisionCreator = '',
  candidateNameAtLink = null,
  recordNickname = '',
  identity = {},
  identityConfirmationProvided = false,
  timing = {},
  timingConfirmationProvided = false
} = {}) {
  return {
    version: OUTCOME_LINK_EVIDENCE_VERSION,
    identity: {
      candidate_id: candidateId ?? null,
      frozen_decision_creator: frozenDecisionCreator ?? null,
      candidate_name_at_link: candidateNameAtLink ?? null,
      record_nickname: recordNickname ?? null,
      candidate_name_ambiguous: identity.candidateNameAmbiguous === true,
      name_match: identity.nameMatch === true,
      confirmation_required: identity.requiresIdentityConfirmation === true,
      confirmation_provided: identityConfirmationProvided === true,
      override_used: identity.overrideUsed === true,
      mode: identity.mode ?? null
    },
    timing: {
      decision_decided_at: timing.decisionDecidedAt ?? null,
      decision_created_at: timing.decisionCreatedAt ?? null,
      business_date_missing: timing.businessDateMissing === true,
      record_publish_date: timing.recordPublishDate ?? null,
      confirmation_required: timing.confirmationRequired === true,
      confirmation_provided: timingConfirmationProvided === true,
      override_used: timing.overrideUsed === true
    }
  }
}

/** 解析 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DD' 的日期部分 */
export function dateOnlyOf(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : null
}

/**
 * 时间提示：投放记录发布日期「明显早于」业务决策日期时提示确认（不自动禁止）。
 * 只做日期粒度比较，避免用 timestamp 误判同一天。
 * 注意：本函数只比较业务日期；created_at（录入时间）绝不作为比较基准。
 */
export function computeTimingWarning(publishDate, decisionDecidedAt) {
  const publish = dateOnlyOf(publishDate)
  const decided = dateOnlyOf(decisionDecidedAt)
  if (!publish || !decided) return false
  return publish < decided
}

/**
 * 单条 creator_record 的播放 / CPM 事实（实时计算，复用 V2 口径）
 * @param {Object} row creator_records 行
 */
export function buildRecordPlayFacts(row = {}) {
  const metrics = computePlayMetrics(row)
  const firstCpmRaw = computeRecordFirstCpm(row)
  const latestCpmRaw = computeRecordLatestCpm(row)

  let latestStatus = LATEST_STATUS.pending
  if (metrics.latestAnomaly) latestStatus = LATEST_STATUS.anomaly
  else if (metrics.hasLatest) latestStatus = LATEST_STATUS.observed

  return {
    total_cost: isFiniteNumber(metrics.cost) ? metrics.cost : null,
    first_play: metrics.hasFirst ? metrics.first : null,
    latest_play: metrics.hasLatest ? metrics.latest : null,
    subsequent_play: metrics.post7dGrowth,
    first_cpm: round2(firstCpmRaw),
    latest_cpm: round2(latestCpmRaw),
    latest_status: latestStatus,
    latest_status_label: LATEST_STATUS_LABELS[latestStatus]
  }
}

/**
 * 累计 CPM 相对目标值的事实状态
 * @param {Object} row creator_records 行
 * @param {number} targetCpm 目标 CPM（默认取 decision 固化的 target_cpm）
 */
export function computeTargetCpmStatus(row = {}, targetCpm = TARGET_CPM) {
  const metrics = computePlayMetrics(row)
  if (!metrics.hasLatest) return TARGET_CPM_STATUS.pending
  if (metrics.latestAnomaly) return TARGET_CPM_STATUS.anomaly
  const cpmRaw = computeRecordLatestCpm(row)
  if (cpmRaw === null) return TARGET_CPM_STATUS.zeroPlay
  return cpmRaw <= targetCpm ? TARGET_CPM_STATUS.met : TARGET_CPM_STATUS.notMet
}

/**
 * 对外 outcome summary：link 关系 + 实时 record 事实
 * @param {Object|null} linkRow creator_decision_outcomes 行
 * @param {Object|null} recordRow creator_records 行（关联的投放记录）
 * @param {{targetCpm?: number}} [options]
 */
export function buildOutcomeSummary(linkRow, recordRow, { targetCpm = TARGET_CPM } = {}) {
  if (!linkRow || !recordRow) return null
  const facts = buildRecordPlayFacts(recordRow)
  const status = computeTargetCpmStatus(recordRow, targetCpm)
  return {
    link_id: linkRow.id,
    linked_at: linkRow.linked_at ?? null,
    record_id: recordRow.id,
    creator: recordRow.nickname ?? null,
    publish_date: recordRow.publish_date ?? null,
    creator_type: recordRow.creator_type ?? null,
    total_cost: facts.total_cost,
    first_play: facts.first_play,
    latest_play: facts.latest_play,
    subsequent_play: facts.subsequent_play,
    first_cpm: facts.first_cpm,
    latest_cpm: facts.latest_cpm,
    latest_status: facts.latest_status,
    latest_status_label: facts.latest_status_label,
    target_cpm: targetCpm,
    target_cpm_status: status,
    target_cpm_status_label: TARGET_CPM_STATUS_LABELS[status],
    // Phase 4E：linking 事件证据（已解析；旧关联为 null）。绝不把 raw JSON string 暴露给前端。
    link_evidence: parseLinkEvidence(linkRow.link_evidence_json)
  }
}

/** 解析 outcome linking 证据（非法 / 缺失 -> null） */
function parseLinkEvidence(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 候选投放记录（只含同一达人，按 publish_date DESC / id DESC；不返回其他达人的记录）
 * @param {Array<Object>} recordRows 该达人的全部 creator_records
 * @param {{ decisionDecidedAt?: string|null, decisionCreatedAt?: string|null, linkMap?: Map<number, number> }} [options]
 *        linkMap: record_id -> decision_id（已建立的关联，用于标记 already_linked）
 */
export function buildOutcomeCandidates(
  recordRows = [],
  { decisionDecidedAt = null, decisionCreatedAt = null, linkMap = new Map() } = {}
) {
  return [...recordRows]
    .sort((left, right) => {
      const leftDate = String(left?.publish_date ?? '')
      const rightDate = String(right?.publish_date ?? '')
      if (leftDate !== rightDate) return leftDate < rightDate ? 1 : -1
      return Number(right?.id ?? 0) - Number(left?.id ?? 0)
    })
    .map((row) => {
      const facts = buildRecordPlayFacts(row)
      const linkedDecisionId = linkMap.get(row.id) ?? null
      return {
        record_id: row.id,
        creator: row.nickname ?? null,
        creator_type: row.creator_type ?? null,
        publish_date: row.publish_date ?? null,
        total_cost: facts.total_cost,
        first_play: facts.first_play,
        latest_play: facts.latest_play,
        first_cpm: facts.first_cpm,
        latest_cpm: facts.latest_cpm,
        latest_status: facts.latest_status,
        latest_status_label: facts.latest_status_label,
        already_linked: linkedDecisionId !== null,
        linked_decision_id: linkedDecisionId,
        timing_warning:
          !dateOnlyOf(decisionDecidedAt) || computeTimingWarning(row.publish_date, decisionDecidedAt)
      }
    })
}
