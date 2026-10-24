import request from '../utils/request.js'

/**
 * 谈判结果沉淀接口（V3-alpha.2 A4）
 * 前端只提交「人的输入」：decision_id / 最终谈成价 / 谈成日期 / 原因标签 / 备注。
 * 星图价、达人报价、CPM30 目标价、参考区间一律由后端根据当时的 decision / snapshot 重新读取并冻结。
 */

/** 创建一条 append-only 谈价结果（同一 decision 只能有一条） */
export function createNegotiationCase(payload) {
  return request.post('/creator-negotiation-cases', payload, { timeout: 20000 })
}

/** 查询某位达人的谈价结果（时间倒序） */
export function getNegotiationCasesByCreator(creator) {
  return request.get('/creator-negotiation-cases', { params: { creator } })
}

/** 查询某个决策的谈价结果 */
export function getNegotiationCaseByDecision(decisionId) {
  return request.get('/creator-negotiation-cases', { params: { decision_id: decisionId } })
}

/**
 * Historical Negotiation Backfill V0.1：把「过去真实发生过、且已有真实 creator_record 的谈价案例」回填。
 * 前端只提交：record_id / 价格事实（历史星图刊例、历史初始报价、谈后价）/ 谈价日期 / 原因标签 / 备注 / source_note。
 * creator 由后端用 record.nickname 冻结；decision_id / snapshot_id / CPM30 快照一律不接受前端提交。
 */
export function createHistoricalNegotiationCase(payload) {
  return request.post('/creator-negotiation-cases/historical-backfill', payload, { timeout: 20000 })
}

/** 查询某条投放记录的历史谈价回填（用于「已补录谈价」状态与只读查看） */
export function getNegotiationCasesByRecord(recordId) {
  return request.get('/creator-negotiation-cases', { params: { record_id: recordId } })
}

/** 只读列出全部历史回填案例（Records 页面标记「已补录谈价」，最多 500 条） */
export function getNegotiationCasesBySourceType(sourceType = 'historical_backfill') {
  return request.get('/creator-negotiation-cases', { params: { source_type: sourceType } })
}

/**
 * Real Data Calibration V1：纠正谈成日期（append-only 审计；只改 negotiated_at）
 */
export function correctNegotiationCaseDate(caseId, { negotiatedAt, reason }) {
  return request.patch(`/creator-negotiation-cases/${caseId}/date`, {
    negotiated_at: negotiatedAt,
    reason
  })
}
