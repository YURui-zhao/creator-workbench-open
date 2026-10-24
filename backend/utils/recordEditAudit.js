/**
 * Record Edit History V1 —— 投放记录编辑留痕（纯辅助层）
 *
 * 设计边界（与 docs/audits/2026-10-24-round3-toast-and-edit-audit.md §7-§8 一致）：
 *   · creator_record_edits 为 append-only 审计表：业务更新与审计事件必须写在同一事务，
 *     审计写入失败 → 整体回滚（fail-closed：审计表缺失时拒绝编辑，绝不静默绕过）
 *   · 按字段记录 before/after，值一律 JSON 编码（null / 0 / 字符串 / 数字的区别被保留）
 *   · 来源由后端确定，不接受客户端填写
 *   · 删除事件在删除前写入整行业务快照（仅 creator_records 业务列），行永久保留
 *   · 导入域的累计播放量更新仍由 import_batch_record_updates 记账，本表不双写
 */

// 参与留痕的业务列（creator_records 的可编辑业务字段；不含 creator_id / created_at 等系统列）
export const RECORD_EDIT_FIELDS = [
  'time_cycle',
  'nickname',
  'creator_type',
  'homepage',
  'content_link',
  'video_link',
  'total_cost',
  'first_play',
  'second_week_play',
  'publish_date'
]

export const RECORD_EDIT_SOURCES = {
  manual_single: 'manual_single',
  manual_batch: 'manual_batch',
  manual_delete: 'manual_delete',
  batch_delete: 'batch_delete',
  import_rollback: 'import_rollback',
  legacy_import_update: 'legacy_import_update'
}

export const RECORD_EDIT_ROW_FIELD = '__row__'

/** 审计表是否已初始化（真实库需先执行 migrations/003_record_edits.js） */
export function creatorRecordEditsReady(db) {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'creator_record_edits'"
      )
      .get()
  )
}

/** fail-closed：审计表缺失时抛出明确错误，由调用方转为 500（绝不静默绕过审计） */
export function assertCreatorRecordEditsReady(db) {
  if (!creatorRecordEditsReady(db)) {
    throw new Error(
      '编辑历史审计表未初始化（缺少 creator_record_edits 表）：' +
        '请先执行 node backend/migrations/003_record_edits.js --commit --db <数据库路径> 后重试'
    )
  }
}

/** 值统一 JSON 编码：null / 0 / 字符串 / 数字的区别被完整保留 */
export function encodeEditValue(value) {
  return value === null || value === undefined ? null : JSON.stringify(value)
}

/**
 * 对比 before 行与 after 行（仅限留痕字段），返回真实变化列表。
 * afterRow 未提供的字段视为保持原值 → 不会产生事件。
 */
export function recordFieldChanges(beforeRow = {}, afterRow = {}) {
  const changes = []
  for (const field of RECORD_EDIT_FIELDS) {
    const before = beforeRow && field in beforeRow ? beforeRow[field] : null
    const after = afterRow && field in afterRow ? afterRow[field] : before
    const beforeJson = encodeEditValue(before)
    const afterJson = encodeEditValue(after)
    if (beforeJson !== afterJson) {
      changes.push({ field, before, after, beforeJson, afterJson })
    }
  }
  return changes
}

/** 在调用方事务内追加一条审计事件（本函数不开启事务） */
export function insertRecordEditEvent(
  db,
  { recordId, action, source, groupId = null, field, beforeValueJson = null, afterValueJson = null }
) {
  if (action !== 'update' && action !== 'delete') {
    throw new Error(`非法的编辑事件动作：${action}`)
  }
  if (!Object.values(RECORD_EDIT_SOURCES).includes(source)) {
    throw new Error(`非法的编辑事件来源：${source}`)
  }
  db.prepare(
    `INSERT INTO creator_record_edits
      (record_id, action, source, group_id, field_name, before_value_json, after_value_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(recordId, action, source, groupId, field, beforeValueJson, afterValueJson)
}

/** 批量操作共享的 group_id（同一次事务内的事件归组） */
export function newRecordEditGroupId() {
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 删除前整行业务快照（仅业务列；不含系统列） */
export function recordBusinessSnapshot(row = {}) {
  const snapshot = {}
  for (const field of RECORD_EDIT_FIELDS) {
    snapshot[field] = row && field in row ? row[field] : null
  }
  return snapshot
}
