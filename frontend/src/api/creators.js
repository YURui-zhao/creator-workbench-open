import request from '../utils/request.js'

/**
 * Creator Identity V1 Phase 2 —— Creator 只读接口（前端调用能力）
 *
 * 状态：**Phase 3 才接线**。本轮只提供 API helper，不改任何页面的读路径：
 *   · CreatorPlaybook 仍走 legacy candidate_review 派生 Work State
 *   · CreatorSummary / RepurchaseRadar 仍按 nickname 聚合
 *
 * 契约（后端 backend/routes/creators.js）：
 *   listCreators({ keyword?, include_merged? }) →
 *     { creators: [{ id, canonical_name, creator_type, identity_status, description,
 *                    distilled_description, profile_url, xingtu_id, xingtu_url,
 *                    created_at, updated_at, alias_count }], total, keyword, include_merged, schema_ready }
 *   getCreator(id) →
 *     { creator: { ...基础资料, aliases: [...] },
 *       attribution: { records_count, candidate_workflows_count, active_candidate_id, active_candidate_name },
 *       latest_known_work_state: { candidate_id, state, note, updated_at, legacy_state, source } | null,
 *       schema_ready }
 *
 * keyword 只做严格 substring（canonical_name / alias），不做 fuzzy / 拼音 / 相似度。
 * identity_status='merged' 的墓碑 Creator 默认不返回（需显式 include_merged）。
 */
export function listCreators(params = {}) {
  return request.get('/creators', { params })
}

/** Creator 详情（含 aliases 与 attribution 计数；Work State 只由 active candidate 派生） */
export function getCreator(id) {
  return request.get(`/creators/${id}`)
}
