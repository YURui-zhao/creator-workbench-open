import request from '../utils/request.js'

/**
 * 候选达人身份层接口（V3-alpha.3 Playbook Phase 1）
 * 后端统一返回 { code, data, msg }
 *
 * 边界：候选 latest 严格按 candidate_id 查询，不会因为名称与历史达人重合而串数据。
 */

/** 候选达人列表；可选 status = 'active' | 'archived' */
export function listCreatorCandidates(params = {}) {
  return request.get('/creator-candidates', { params })
}

/** 新建候选达人：{ name, creator_type?, profile_url?, description? } */
export function createCreatorCandidate(payload) {
  return request.post('/creator-candidates', payload)
}

/** 候选达人详情 */
export function getCreatorCandidate(id) {
  return request.get(`/creator-candidates/${id}`)
}

/** 更新候选达人基本信息（含 status=archived 归档） */
export function updateCreatorCandidate(id, payload) {
  return request.patch(`/creator-candidates/${id}`, payload)
}

/**
 * 候选达人保存近期表现快照（append-only）
 * 入参只发 raw 事实；creator 由服务端取自 candidate.name，candidate_id 由服务端落库。
 */
export function saveCandidateRecentSnapshot(candidateId, payload) {
  return request.post(`/creator-candidates/${candidateId}/recent-snapshots`, payload, { timeout: 20000 })
}

/** 候选达人最新快照（按 candidate_id 查）；无快照时后端返回 { candidate_id, creator, snapshot: null } */
export function getCandidateLatestSnapshot(candidateId) {
  return request.get(`/creator-candidates/${candidateId}/recent-snapshots/latest`)
}

/**
 * 历史价格参考（Phase 3B，只读）：后端按 candidate_id 取 latest snapshot 派生 target，
 * 前端不提交 target；返回 { available, reason_code?, target, pool?, summary?, cases? }。
 */
export function getCandidatePriceReference(candidateId) {
  return request.get(`/creator-candidates/${candidateId}/price-reference`)
}

/**
 * Work State 写入（Phase 3 唯一写入路径，append-only）
 * 只提交 { state: 'advancing'|'observing'|'paused', note? }；candidate_id / created_at 由服务端决定。
 * 返回 { work_state_event, candidate }：candidate 与 list/detail 同一 contract，可直接用于更新本地状态。
 */
export function createCandidateWorkState(candidateId, payload) {
  return request.post(`/creator-candidates/${candidateId}/work-state`, payload)
}

/**
 * @deprecated Phase 3 起 candidate_review decision 已废弃（服务端只做 legacy 翻译，不再写 creator_decisions）。
 * 请使用 createCandidateWorkState。保留此 helper 仅为兼容旧调用方。
 */
export function createCandidateDecision(candidateId, payload) {
  return request.post(`/creator-candidates/${candidateId}/decisions`, payload)
}

/** 候选达人的 append-only 决定历史（created_at DESC, id DESC） */
export function listCandidateDecisions(candidateId) {
  return request.get(`/creator-candidates/${candidateId}/decisions`)
}

/**
 * candidate 报价阶段人工决定（Phase 4D，append-only）
 * 只提交 { current_quote_raw, human_decision, decision_note? }；
 * creator / candidate_id / decision_stage / snapshot_id / evidence 由服务端决定。
 */
export function createCandidatePostQuoteDecision(candidateId, payload) {
  return request.post(`/creator-candidates/${candidateId}/post-quote-decisions`, payload)
}
