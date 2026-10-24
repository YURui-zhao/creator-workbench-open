import request from '../utils/request.js'

/**
 * 决策记录接口（V3-alpha P4）
 * 后端统一返回 { code, data, msg }
 *
 * 注意：前端只提交「人的输入」（阶段 / IP 判断 / 人的决定 / 备注 / 实际报价原文），
 * 历史证据、近期证据、价格证据、target_cpm、pricing_version 全部由后端重建并固化。
 */

/** 创建一条 append-only 决策记录 */
export function createCreatorDecision(payload) {
  return request.post('/creator-decisions', payload, { timeout: 20000 })
}

/**
 * 查询某位达人的决策历史（时间倒序）
 * Creator Identity V1 Phase 5：提供 creatorId 时按归属锚查询（同名不同人绝不串历史）；
 * 未提供时保持原有 creator 文本查询（legacy 兼容）。
 */
export function getCreatorDecisions(creator, creatorId = null) {
  const params = { creator }
  if (creatorId !== null && creatorId !== undefined) params.creator_id = creatorId
  return request.get('/creator-decisions', { params })
}

/** 只读预览：用实际报价重跑 P3 规则（不写库、无 AI） */
export function previewCreatorDecisionQuote({ creator, snapshotId, currentQuoteRaw }) {
  return request.post(
    '/creator-decisions/preview',
    { creator, snapshot_id: snapshotId, current_quote_raw: currentQuoteRaw },
    { timeout: 20000 }
  )
}

/**
 * Real Data Calibration V1：纠正业务决策日期（append-only 审计；只改 decided_at）
 */
export function correctDecisionDate(decisionId, { decidedAt, reason }) {
  return request.patch(`/creator-decisions/${decisionId}/date`, {
    decided_at: decidedAt,
    reason
  })
}

/**
 * Real Data Calibration V1：作废决策（VOID，不删除决策行 / 归属 / 谈价 / 投放事实）
 */
export function voidDecision(decisionId, { reason }) {
  return request.post(`/creator-decisions/${decisionId}/void`, { reason })
}

/**
 * P5：取该决策可关联的真实投放记录候选（只含同一达人，按发布日期倒序）
 * 候选里的花费 / 播放 / CPM 全部由后端复用 V2 口径生成，前端不重新计算。
 */
export function getDecisionOutcomeCandidates(decisionId) {
  return request.get(`/creator-decisions/${decisionId}/outcome-candidates`)
}

/**
 * P5：把一条真实投放记录关联到决策（只提交关联关系 + 人工确认 flag，不提交任何派生指标）
 * Phase 4E：candidate 跨名称 / 同名歧义需要 identity_confirmed；link evidence 全部由后端冻结。
 */
export function linkDecisionOutcome(
  decisionId,
  { recordId, timingConfirmed = false, identityConfirmed = false }
) {
  return request.post(
    `/creator-decisions/${decisionId}/outcome`,
    {
      record_id: recordId,
      timing_confirmed: timingConfirmed === true,
      identity_confirmed: identityConfirmed === true
    },
    { timeout: 20000 }
  )
}

/** P5：解除关联（只删除 mapping，不删除任何投放数据或决策记录） */
export function unlinkDecisionOutcome(decisionId) {
  return request.delete(`/creator-decisions/${decisionId}/outcome`)
}
