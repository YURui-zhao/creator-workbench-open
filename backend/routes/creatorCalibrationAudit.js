import db from '../db.js'

/**
 * Real Data Calibration V1 —— 校正审计（append-only）
 *
 * 边界（刻意收敛，不做通用编辑框架）：
 *   · target_type 只允许 'decision' | 'negotiation_case'
 *   · action 只允许 'correct_date' | 'void'
 *   · 本轮允许纠正的字段只有 creator_decisions.decided_at 与 creator_negotiation_cases.negotiated_at
 *   · 绝不允许通过本机制修改 creator_id / decision_id / record_id / decision type /
 *     current_quote / actual_cost / pricing evidence / link evidence
 *
 * 每次纠正都会追加一行 before / after / reason，历史不可被无痕覆盖。
 */

export const CALIBRATION_TARGET_TYPES = ['decision', 'negotiation_case']
export const CALIBRATION_ACTIONS = ['correct_date', 'void']
// 本轮开放纠正的字段（白名单；其它字段一律拒绝）
export const CALIBRATION_CORRECTABLE_FIELDS = {
  decision: ['decided_at'],
  negotiation_case: ['negotiated_at']
}

/**
 * 追加一条校正审计记录（不修改业务行本身；业务行的 UPDATE 由调用方在同一事务内完成）
 * @returns {{ id: number }} 新审计行 id
 */
export function recordCalibrationCorrection({
  targetType,
  targetId,
  action,
  field = null,
  beforeValue = null,
  afterValue = null,
  reason
}) {
  if (!CALIBRATION_TARGET_TYPES.includes(targetType)) {
    throw new Error(`不支持的校正目标类型：${targetType}`)
  }
  if (!CALIBRATION_ACTIONS.includes(action)) {
    throw new Error(`不支持的校正动作：${action}`)
  }
  if (action === 'correct_date') {
    const allowed = CALIBRATION_CORRECTABLE_FIELDS[targetType] || []
    if (!allowed.includes(field)) {
      throw new Error(`${targetType} 不允许纠正字段：${field}`)
    }
  }
  const info = db
    .prepare(
      `INSERT INTO creator_calibration_corrections
        (target_type, target_id, action, field, before_value, after_value, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(targetType, targetId, action, field, beforeValue, afterValue, reason)
  return { id: Number(info.lastInsertRowid) }
}

/** 只读列出某个目标的全部校正审计（含 void），最新在前 */
export function listCalibrationCorrections(targetType, targetId) {
  if (!CALIBRATION_TARGET_TYPES.includes(targetType)) {
    throw new Error(`不支持的校正目标类型：${targetType}`)
  }
  return db
    .prepare(
      `SELECT id, target_type, target_id, action, field, before_value, after_value, reason, created_at
       FROM creator_calibration_corrections
       WHERE target_type = ? AND target_id = ?
       ORDER BY id DESC`
    )
    .all(targetType, targetId)
}
