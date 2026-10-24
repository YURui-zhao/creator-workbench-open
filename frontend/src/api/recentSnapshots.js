import request from '../utils/request.js'

/**
 * 近期表现快照接口（V3-alpha P2B）
 * 后端统一返回 { code, data, msg }
 */

/**
 * 保存一条 append-only 快照
 * 入参只发 raw 事实（creator / recognized_creator_name_raw / identity_confirmed /
 * xingtu_price_raw / plays[{ raw_text, excluded, source_image_index, position_index }]）；
 * median / p25 / p75 / trend 等派生值一律由后端重新计算。
 */
export function saveRecentSnapshot(payload) {
  return request.post('/recent-snapshots', payload, { timeout: 20000 })
}

/** 取某位达人最新快照；无快照时后端返回 { creator, snapshot: null } */
export function getLatestRecentSnapshot(creator, creatorId = null) {
  // Creator Identity V1 Phase 5：有归属锚时按 creator_id 取（同名不同人不串数据）
  const params = { creator }
  if (creatorId !== null && creatorId !== undefined) params.creator_id = creatorId
  return request.get('/recent-snapshots/latest', { params })
}
