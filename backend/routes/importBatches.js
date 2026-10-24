import { Router } from 'express'
import db from '../db.js'
// Creator Identity V1 Phase 4：rollback 时安全清理「自动 import 生成且已完全孤立」的空壳 Creator
import { cleanupOrphanAutoCreatedCreators } from '../utils/creatorIdentity.js'
// Record Edit History V1.1：撤销删除也要留痕（fail-closed，与删除同事务）
import {
  assertCreatorRecordEditsReady,
  insertRecordEditEvent,
  newRecordEditGroupId,
  recordBusinessSnapshot,
  RECORD_EDIT_ROW_FIELD
} from '../utils/recordEditAudit.js'

const router = Router()
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** creator_records 是否已有归属列（Phase 1 migration 之前的老库 → false，保持旧 rollback 行为） */
function hasRecordCreatorColumn() {
  try {
    return db
      .prepare('PRAGMA table_info(creator_records)')
      .all()
      .some((column) => column.name === 'creator_id')
  } catch {
    return false
  }
}

// ---------- 统一响应格式 { code, data, msg }（与现有接口一致） ----------
function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, msg) {
  res.status(code).json({ code, data: null, msg })
}

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

const BATCH_COLUMNS = [
  'id',
  'file_name',
  'total_count',
  'success_count',
  'fail_count',
  'skip_count',
  'duplicate_count',
  'created_at'
]
// record_count = 该批次「当前仍关联」的投放记录数（与 success_count 语义不同：
// success_count 是导入当时成功写入的条数，record_count 会随记录被删除而减少）
const BATCH_SELECT = `SELECT ${BATCH_COLUMNS.join(', ')},
  (SELECT COUNT(*) FROM import_batch_records br WHERE br.batch_id = import_batches.id) AS record_count
  ,(SELECT COUNT(*) FROM import_batch_record_updates bu WHERE bu.batch_id = import_batches.id) AS update_count
  FROM import_batches`

// 「删除历史」被拒绝时的统一提示（批次仍有关联投放记录）
const HISTORY_DELETE_BLOCKED_MSG =
  '该批次仍有关联投放记录，请先撤销导入；如需保留投放数据，请手动删除对应记录后再删除历史。'
// 「撤销导入」在无可撤销记录时的友好提示
const ROLLBACK_EMPTY_MSG = '该批次当前没有可撤销的投放记录。'

// 撤销更新时的乐观并发冲突提示（导入后又发生了新的更新，不能覆盖后续事实）
function updateRollbackConflictMessage(recordId, after, current) {
  return `撤销冲突：记录 #${recordId} 的累计播放量在本次导入后又被修改（本批次更新为 ${after}，当前 ${current}）。为避免覆盖后续事实，已取消本次撤销。`
}

const UPDATE_FIELD_LABEL = { second_week_play: '累计播放量' }

// 读取 JSON 数字（保留 null / 0 的区别）；非法返回 null
function parseJsonNumber(raw) {
  if (raw === null || raw === undefined) return null
  try {
    const value = JSON.parse(raw)
    if (value === null) return null
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  } catch {
    return null
  }
}

/**
 * GET /api/import/batches
 * 分页查询导入批次（按导入时间倒序）
 * 查询参数：page、pageSize、startDate、endDate（按创建日期筛选，YYYY-MM-DD）
 */
router.get('/batches', (req, res) => {
  const page = Number(req.query.page)
  const pageSize = Number(req.query.pageSize)
  const validPage = Number.isInteger(page) && page > 0
  const validSize = Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100

  if (req.query.page !== undefined && !validPage) {
    return fail(res, 400, 'page 必须为正整数')
  }
  if (req.query.pageSize !== undefined && !validSize) {
    return fail(res, 400, 'pageSize 必须为 1-100 的整数')
  }

  const { startDate, endDate } = req.query
  if (startDate && !DATE_RE.test(String(startDate))) {
    return fail(res, 400, 'startDate 格式必须为 YYYY-MM-DD')
  }
  if (endDate && !DATE_RE.test(String(endDate))) {
    return fail(res, 400, 'endDate 格式必须为 YYYY-MM-DD')
  }
  if (startDate && endDate && String(startDate) > String(endDate)) {
    return fail(res, 400, 'startDate 不能晚于 endDate')
  }

  const finalPage = validPage ? page : 1
  const finalSize = validSize ? pageSize : 10

  const conditions = []
  const params = []
  if (startDate) {
    conditions.push('date(created_at) >= date(?)')
    params.push(String(startDate))
  }
  if (endDate) {
    conditions.push('date(created_at) <= date(?)')
    params.push(String(endDate))
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''

  const total = db.prepare(`SELECT COUNT(*) AS n FROM import_batches${where}`).get(...params).n
  const list = db
    .prepare(`${BATCH_SELECT}${where} ORDER BY datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, finalSize, (finalPage - 1) * finalSize)

  ok(res, { list, total })
})

/**
 * GET /api/import/batches/:id
 * 批次详情：批次统计 + 行级明细（失败/跳过/重复/成功）+ 该批次导入的投放记录（前 50 条）
 */
router.get('/batches/:id', (req, res) => {
  const id = parseId(req.params.id)
  if (!id) return fail(res, 400, 'id 必须为正整数')

  const batch = db.prepare(`${BATCH_SELECT} WHERE id = ?`).get(id)
  if (!batch) return fail(res, 404, '导入批次不存在')

  const items = db
    .prepare(
      `SELECT id, row_index, status, reason
       FROM import_batch_items
       WHERE batch_id = ?
       ORDER BY row_index ASC, id ASC`
    )
    .all(id)

  const records = db
    .prepare(
      `SELECT r.id, r.time_cycle, r.nickname, r.creator_type, r.homepage, r.content_link,
              r.video_link, r.total_cost, r.publish_date, r.first_play, r.second_week_play
       FROM creator_records r
       JOIN import_batch_records br ON br.record_id = r.id
       WHERE br.batch_id = ?
       ORDER BY r.id ASC
       LIMIT 50`
    )
    .all(id)

  const recordCount = db
    .prepare('SELECT COUNT(*) AS n FROM import_batch_records WHERE batch_id = ?')
    .get(id).n

  // Existing Record Update V0.1：本批次对已有记录做过的字段级更新（审计）
  const updates = db
    .prepare(
      `SELECT id, record_id, field_name, before_value_json, after_value_json, created_at
       FROM import_batch_record_updates
       WHERE batch_id = ?
       ORDER BY record_id ASC, id ASC`
    )
    .all(id)
    .map((row) => ({
      ...row,
      field_label: UPDATE_FIELD_LABEL[row.field_name] || row.field_name,
      before_value: parseJsonNumber(row.before_value_json),
      after_value: parseJsonNumber(row.after_value_json)
    }))

  const summary = items.reduce(
    (acc, item) => {
      const key = String(item.status || '').toLowerCase()
      if (Object.prototype.hasOwnProperty.call(acc, key)) acc[key] += 1
      return acc
    },
    { success: 0, fail: 0, skip: 0, duplicate: 0, updated: 0 }
  )
  // 行列明细里没有 updated 行时，用审计表兜底（保证「更新 M」始终可展示）
  if (summary.updated === 0) summary.updated = updates.length

  ok(res, {
    batch,
    items,
    records,
    updates,
    record_count: recordCount,
    update_count: updates.length,
    item_summary: summary
  })
})

/**
 * POST /api/import/batches/:id/rollback
 * 【撤销导入】：删除该批次当前仍关联的投放记录（只按 import_batch_records 精确关联，绝不按昵称/周期/文件名模糊匹配）。
 * 事务内完成：删除记录 → 清理该批次的 mapping。
 * 保留 import_batches（当时成功/失败多少条仍是历史事实）与 import_batch_items（行级审计原因）。
 * 记录已被手动删除的情况：只删除当前仍存在的记录，不因数量少于 success_count 而失败。
 */
router.post('/batches/:id/rollback', (req, res) => {
  const id = parseId(req.params.id)
  if (!id) return fail(res, 400, 'id 必须为正整数')

  const batch = db.prepare(`${BATCH_SELECT} WHERE id = ?`).get(id)
  if (!batch) return fail(res, 404, '导入批次不存在')

  // Record Edit History V1.1：撤销会物理删除投放记录 → 审计表缺失时整体拒绝（fail-closed）
  try {
    assertCreatorRecordEditsReady(db)
  } catch (error) {
    return fail(res, 500, error.message)
  }
  const rollbackGroupId = newRecordEditGroupId()

  const selectPlay = db.prepare('SELECT id, second_week_play FROM creator_records WHERE id = ?')
  const updatePlay = db.prepare('UPDATE creator_records SET second_week_play = ? WHERE id = ?')
  const conflict = (message) => {
    const error = new Error(message)
    error.statusCode = 409
    throw error
  }

  let result
  try {
    result = db.transaction((batchId) => {
      // ① 先撤销字段级更新（只有当「当前值 == 本批次写入的 after」时才允许恢复 after → before）
      const audits = db
        .prepare(
          `SELECT record_id, field_name, before_value_json, after_value_json
           FROM import_batch_record_updates WHERE batch_id = ? ORDER BY id ASC`
        )
        .all(batchId)
      let revertedUpdateCount = 0
      let skippedUpdateCount = 0
      for (const audit of audits) {
        if (audit.field_name !== 'second_week_play') continue
        const record = selectPlay.get(audit.record_id)
        // 记录已被手动删除：无法恢复，跳过（与旧行为一致，不因数量不符而失败）
        if (!record) {
          skippedUpdateCount += 1
          continue
        }
        const current =
          record.second_week_play === null || record.second_week_play === undefined
            ? null
            : Number(record.second_week_play)
        const before = parseJsonNumber(audit.before_value_json)
        const after = parseJsonNumber(audit.after_value_json)
        if (current === after) {
          updatePlay.run(before, audit.record_id)
          revertedUpdateCount += 1
        } else if (current === before) {
          // 已经恢复过（幂等）：不重复写，也不当作冲突
          skippedUpdateCount += 1
        } else {
          conflict(updateRollbackConflictMessage(audit.record_id, after, current))
        }
      }

      // ② 删除该批次当前仍关联的新增记录（旧逻辑保持不变）
      const mappings = db
        .prepare('SELECT record_id FROM import_batch_records WHERE batch_id = ?')
        .all(batchId)
      const removeRecord = db.prepare('DELETE FROM creator_records WHERE id = ?')
      // 删除前先记下这些记录当前的归属锚（rollback 后用于判断是否留下空壳 Creator）
      const owners = new Map()
      if (hasRecordCreatorColumn()) {
        const selectOwner = db.prepare('SELECT creator_id FROM creator_records WHERE id = ?')
        for (const mapping of mappings) {
          const owner = selectOwner.get(mapping.record_id)
          if (owner && owner.creator_id !== null && owner.creator_id !== undefined) {
            owners.set(Number(mapping.record_id), Number(owner.creator_id))
          }
        }
      }
      let deletedCount = 0
      for (const mapping of mappings) {
        // 删除前读取最终业务行（含导入后的人工更新），删除成功即写入整行快照（同事务，失败整体回滚）
        const beforeRow = db.prepare('SELECT * FROM creator_records WHERE id = ?').get(mapping.record_id)
        const info = removeRecord.run(mapping.record_id)
        if (info.changes > 0) {
          deletedCount += 1
          insertRecordEditEvent(db, {
            recordId: mapping.record_id,
            action: 'delete',
            source: 'import_rollback',
            groupId: rollbackGroupId,
            field: RECORD_EDIT_ROW_FIELD,
            beforeValueJson: JSON.stringify(recordBusinessSnapshot(beforeRow)),
            afterValueJson: null
          })
        }
      }
      // ③ Creator Identity Phase 4：只有「自动 import 新建 + 现已完全孤立」的空壳才清理。
      //    任一其它事实 / 人工身份资产存在 → 保留（宁可留下空壳，也绝不误删身份）。
      const cleaned = cleanupOrphanAutoCreatedCreators(db, [...owners.values()])
      const clearedMappingCount = db
        .prepare('DELETE FROM import_batch_records WHERE batch_id = ?')
        .run(batchId).changes
      const itemsKept = db
        .prepare('SELECT COUNT(*) AS n FROM import_batch_items WHERE batch_id = ?')
        .get(batchId).n
      return {
        scannedMappingCount: mappings.length,
        deletedCount,
        revertedUpdateCount,
        skippedUpdateCount,
        clearedMappingCount,
        itemsKept,
        removedCreatorCount: cleaned.removedCreatorIds.length,
        removedAliasCount: cleaned.removedAliasIds.length
      }
    })(id)
  } catch (error) {
    if (error && error.statusCode) return fail(res, error.statusCode, error.message)
    throw error
  }

  ok(res, {
    batchId: id,
    deletedCount: result.deletedCount,
    revertedUpdateCount: result.revertedUpdateCount,
    skippedUpdateCount: result.skippedUpdateCount,
    clearedMappingCount: result.clearedMappingCount,
    scannedMappingCount: result.scannedMappingCount,
    itemsKept: result.itemsKept,
    removedCreatorCount: result.removedCreatorCount,
    removedAliasCount: result.removedAliasCount,
    recordCount: 0,
    message:
      result.deletedCount > 0 || result.revertedUpdateCount > 0
        ? `已撤销导入：删除 ${result.deletedCount} 条投放记录，恢复 ${result.revertedUpdateCount} 条已有记录的累计播放量`
        : ROLLBACK_EMPTY_MSG
  })
})

/**
 * DELETE /api/import/batches/:id
 * 【删除历史】：只删除导入日志（批次 + 行级明细 + 残留 mapping），绝不删除 creator_records。
 * 若该批次仍有关联投放记录 → 409 拒绝（否则用户将失去按批次精确撤销的能力）。
 */
router.delete('/batches/:id', (req, res) => {
  const id = parseId(req.params.id)
  if (!id) return fail(res, 400, 'id 必须为正整数')

  const batch = db.prepare(`${BATCH_SELECT} WHERE id = ?`).get(id)
  if (!batch) return fail(res, 404, '导入批次不存在')

  const mappingCount = db
    .prepare('SELECT COUNT(*) AS n FROM import_batch_records WHERE batch_id = ?')
    .get(id).n
  if (mappingCount > 0) return fail(res, 409, HISTORY_DELETE_BLOCKED_MSG)

  const result = db.transaction((batchId) => ({
    deletedItems: db.prepare('DELETE FROM import_batch_items WHERE batch_id = ?').run(batchId).changes,
    deletedUpdates: db
      .prepare('DELETE FROM import_batch_record_updates WHERE batch_id = ?')
      .run(batchId).changes,
    deletedMappings: db
      .prepare('DELETE FROM import_batch_records WHERE batch_id = ?')
      .run(batchId).changes,
    deletedBatches: db.prepare('DELETE FROM import_batches WHERE id = ?').run(batchId).changes
  }))(id)

  ok(res, { batchId: id, ...result })
})

export default router
