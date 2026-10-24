import request from '../utils/request.js'

/**
 * 导入历史（批次）接口
 * 后端统一返回 { code: 200, data, msg: 'success' }
 */

/**
 * 分页查询导入批次（按导入时间倒序）
 * @param {{ page?: number, pageSize?: number, startDate?: string, endDate?: string }} params
 */
export function getImportBatches(params) {
  return request.get('/import/batches', { params })
}

/**
 * 查询单个批次详情（批次统计 + 行级明细 + 对应投放记录）
 * @param {number|string} id 批次 ID
 */
export function getImportBatchDetail(id) {
  return request.get(`/import/batches/${id}`)
}

/**
 * 【撤销导入】删除该批次当前仍关联的投放记录（后端事务内完成），保留导入历史与行级日志
 * 返回：{ code, data: { batchId, deletedCount, clearedMappingCount, recordCount, message }, msg }
 * deletedCount = 0 表示该批次当前没有可撤销的投放记录（不是错误）
 * @param {number|string} id 批次 ID
 */
export function rollbackImportBatch(id) {
  return request.post(`/import/batches/${id}/rollback`)
}

/**
 * 【删除历史】只删除导入日志（批次 + 行级明细 + 残留映射），不会删除任何投放记录
 * 该批次仍有关联投放记录时后端返回 409 拒绝
 * @param {number|string} id 批次 ID
 */
export function deleteImportBatchHistory(id) {
  return request.delete(`/import/batches/${id}`)
}
