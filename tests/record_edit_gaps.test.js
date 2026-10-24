#!/usr/bin/env node
/**
 * Record Edit History V1.1 缺口补齐回归（隔离临时库，零真实写入）
 *
 * 覆盖：导入撤销删除快照（含导入后人工更新的最终值）、撤销 fail-closed、
 * 撤销审计失败整体回滚、无批次元数据导入更新补留痕、带元数据不重复记账、
 * 旧路径 fail-closed。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'record-edit-gaps-'))
process.env.WORKBENCH_DB_PATH = path.join(TMP_DIR, 'isolated.db')

let passCount = 0
let failCount = 0
const failures = []

function check(label, cond, extra = '') {
  if (cond) {
    passCount += 1
    console.log(`PASS  ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    failCount += 1
    failures.push(`${label}${extra ? `  ${extra}` : ''}`)
    console.log(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
}

async function main() {
  const records = await import(pathToFileURL(path.join(root, 'backend/routes/records.js')).href)
  const importBatches = await import(pathToFileURL(path.join(root, 'backend/routes/importBatches.js')).href)
  const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

  const findHandler = (router, routePath, method) => {
    const layer = router.stack.find(
      (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
    )
    return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
  }
  const putHandler = findHandler(records.default, '/:id', 'put')
  const batchImportHandler = findHandler(records.default, '/batch', 'post')
  const rollbackHandler = findHandler(importBatches.default, '/batches/:id/rollback', 'post')
  const callRoute = async (handler, { body = {}, params = {} } = {}) => {
    const res = response()
    await handler({ body, params, headers: {} }, res)
    return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
  }
  // 同步 rethrow（Express 由错误中间件兜底 500）在直接调用时表现为异常 → 视为 500
  const callRouteAllowThrow = async (handler, options) => {
    try {
      return await callRoute(handler, options)
    } catch (error) {
      return { status: 500, msg: error.message, data: null, body: null }
    }
  }
  const totalEvents = () => db.prepare('SELECT COUNT(*) AS n FROM creator_record_edits').get().n
  const insertRecord = db.prepare(
    `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, first_play, second_week_play, publish_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const insertBatch = db.prepare(
    `INSERT INTO import_batches (file_name, total_count, success_count) VALUES (?, ?, ?)`
  )
  const insertMapping = db.prepare('INSERT INTO import_batch_records (batch_id, record_id) VALUES (?, ?)')

  console.log('\n===== A. 导入撤销删除快照 =====')
  const recA = Number(insertRecord.run('2026-W33', '撤销甲', '数码', 5000, 20000, 30000, '2026-08-19').lastInsertRowid)
  const batchA = Number(insertBatch.run('gap-test.xlsx', 1, 1).lastInsertRowid)
  insertMapping.run(batchA, recA)
  // 导入后人工更新（走 PUT，产生 manual_single 事件）→ 撤销删除前快照必须含最终值
  const putRes = await callRoute(putHandler, { params: { id: String(recA) }, body: { total_cost: 8888 } })
  check('前置：导入后人工 PUT 更新成功', putRes.status === 200)
  const eventsBeforeRollback = totalEvents()
  const rb = await callRoute(rollbackHandler, { params: { id: String(batchA) } })
  check('撤销成功', rb.status === 200 && rb.data.deletedCount === 1, JSON.stringify(rb.data || rb.msg))
  const recAGone = db.prepare('SELECT COUNT(*) AS n FROM creator_records WHERE id = ?').get(recA).n === 0
  const delEvents = db.prepare(
    "SELECT * FROM creator_record_edits WHERE record_id = ? AND action = 'delete' AND source = 'import_rollback'"
  ).all(recA)
  check('撤销删除写入 import_rollback 快照事件',
    recAGone && delEvents.length === 1 && delEvents[0].field_name === '__row__' && delEvents[0].group_id)
  const snapshot = JSON.parse(delEvents[0].before_value_json)
  check('快照包含删除前最终业务值（人工更新后的 total_cost=8888）', snapshot.total_cost === 8888 && snapshot.nickname === '撤销甲')
  check('撤销批次日志保留（既有语义不变）',
    db.prepare('SELECT COUNT(*) AS n FROM import_batches WHERE id = ?').get(batchA).n === 1)

  console.log('\n===== B. 撤销 fail-closed / 审计失败回滚 =====')
  const recB = Number(insertRecord.run('2026-W34', '撤销乙', '美妆', 3000, 10000, 20000, '2026-08-26').lastInsertRowid)
  const batchB = Number(insertBatch.run('gap-test2.xlsx', 1, 1).lastInsertRowid)
  insertMapping.run(batchB, recB)
  db.exec('DROP TABLE creator_record_edits')
  const rbFail = await callRoute(rollbackHandler, { params: { id: String(batchB) } })
  check('审计表缺失 → 撤销被拒绝（fail-closed）', rbFail.status === 500 && /creator_record_edits/.test(String(rbFail.msg)))
  check('拒绝后记录与映射完整保留',
    db.prepare('SELECT COUNT(*) AS n FROM creator_records WHERE id = ?').get(recB).n === 1 &&
      db.prepare('SELECT COUNT(*) AS n FROM import_batch_records WHERE batch_id = ?').get(batchB).n === 1)

  // 审计写入失败 → 整体回滚：用缺 default 的 NOT NULL 附加列让 INSERT 失败
  db.exec(`CREATE TABLE creator_record_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, record_id INTEGER NOT NULL,
    action TEXT NOT NULL, source TEXT NOT NULL, group_id TEXT, field_name TEXT NOT NULL,
    before_value_json TEXT, after_value_json TEXT, force_fail TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  const rbAuditFail = await callRouteAllowThrow(rollbackHandler, { params: { id: String(batchB) } })
  check('审计写入失败 → 撤销整体回滚（500）', rbAuditFail.status === 500)
  check('回滚后记录与映射未被删除',
    db.prepare('SELECT COUNT(*) AS n FROM creator_records WHERE id = ?').get(recB).n === 1 &&
      db.prepare('SELECT COUNT(*) AS n FROM import_batch_records WHERE batch_id = ?').get(batchB).n === 1)
  db.exec('DROP TABLE creator_record_edits')

  console.log('\n===== C. 无批次元数据的旧导入更新路径 =====')
  // 恢复正式 schema（migrateRecordEdits 等价：建表 + 索引）
  const mig = await import(pathToFileURL(path.join(root, 'backend/migrations/003_record_edits.js')).href)
  mig.migrateRecordEdits(db)
  check('正式 schema 恢复', db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creator_record_edits'").get())

  const recC = Number(insertRecord.run('2026-W35', '旧路径丙', '数码', 800, 20000, 100000, '2026-09-02').lastInsertRowid)
  const editsBefore = totalEvents()
  const legacyImport = await callRoute(batchImportHandler, {
    body: {
      rows: [],
      updates: [{ record_id: recC, expected_before: 100000, desired_after: 150000 }]
    }
  })
  check('无 batch 元数据的导入更新成功', legacyImport.status === 200 && legacyImport.data.updatedCount === 1,
    JSON.stringify({ status: legacyImport.status, msg: legacyImport.msg, data: legacyImport.data }))
  check('业务值已更新', db.prepare('SELECT second_week_play FROM creator_records WHERE id = ?').get(recC).second_week_play === 150000)
  const legacyEvents = db.prepare(
    "SELECT * FROM creator_record_edits WHERE record_id = ? AND source = 'legacy_import_update'"
  ).all(recC)
  check('旧路径更新补写 legacy_import_update 审计',
    legacyEvents.length === 1 && legacyEvents[0].field_name === 'second_week_play' &&
      JSON.parse(legacyEvents[0].before_value_json) === 100000 &&
      JSON.parse(legacyEvents[0].after_value_json) === 150000)
  check('旧路径不写 import_batch_record_updates（batchId=null）',
    db.prepare('SELECT COUNT(*) AS n FROM import_batch_record_updates').get().n === 0)

  // 带批次元数据 → 仍走既有 import_batch_record_updates，不双写
  const editsBeforeMeta = totalEvents()
  const metaImport = await callRoute(batchImportHandler, {
    body: {
      rows: [],
      updates: [{ record_id: recC, expected_before: 150000, desired_after: 180000 }],
      batch: { fileName: 'meta-import.xlsx', totalCount: 1 }
    }
  })
  check('带元数据导入更新成功', metaImport.status === 200 && metaImport.data.batchId !== null,
    JSON.stringify(metaImport.data))
  check('带元数据更新写入 import_batch_record_updates（既有机制）',
    db.prepare('SELECT COUNT(*) AS n FROM import_batch_record_updates').get().n === 1)
  check('带元数据更新不重复写 creator_record_edits', totalEvents() === editsBeforeMeta)

  console.log('\n===== D. 旧路径 fail-closed =====')
  db.exec('DROP TABLE creator_record_edits')
  const recBefore = db.prepare('SELECT second_week_play FROM creator_records WHERE id = ?').get(recC).second_week_play
  const closedImport = await callRoute(batchImportHandler, {
    body: { rows: [], updates: [{ record_id: recC, expected_before: 180000, desired_after: 190000 }] }
  })
  check('审计表缺失 → 旧路径更新被拒绝（fail-closed）', closedImport.status === 500 && /creator_record_edits/.test(String(closedImport.msg)))
  check('拒绝后业务值未变化', db.prepare('SELECT second_week_play FROM creator_records WHERE id = ?').get(recC).second_week_play === recBefore)
  mig.migrateRecordEdits(db)

  check('隔离库位于临时目录', TMP_DIR.startsWith(os.tmpdir()))
  console.log(`\n================ 测试汇总 ================`)
  console.log(`用例总数：${passCount + failCount}　通过：${passCount}　失败：${failCount}`)
  if (failCount > 0) {
    console.log('失败用例：')
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('测试异常：', error)
  process.exit(1)
})
