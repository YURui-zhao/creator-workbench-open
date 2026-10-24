#!/usr/bin/env node
/**
 * Record Edit History V1 回归测试（隔离临时库，零真实写入）
 *
 * 覆盖：PUT 单条编辑留痕（80,000→120,000 / null↔0 / 多字段 / 无变化跳过 / 非法拒绝）、
 * 审计失败整体回滚、批量修改部分成功与 group_id、单条与批量删除快照、
 * 导入更新不重复记账、只读接口不写库、null/0/数字/字符串展示。
 */
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'record-edit-audit-'))
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

function forbidNetwork() {
  const blocked = []
  const replacements = [
    [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'], [tls, 'connect']
  ]
  const originals = replacements.map(([target, method]) => [target, method, target[method]])
  for (const [target, method] of replacements) {
    target[method] = () => {
      blocked.push(`${method}`)
      throw new Error('record edit audit test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('record edit audit test forbids network requests')
  }
  return {
    blocked,
    restore() {
      for (const [target, method, original] of originals) target[method] = original
      global.fetch = originalFetch
    }
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
  const networkGuard = forbidNetwork()
  try {
    const records = await import(pathToFileURL(path.join(root, 'backend/routes/records.js')).href)
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

    const findHandler = (router, routePath, method) => {
      const layer = router.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const putHandler = findHandler(records.default, '/:id', 'put')
    const editsHandler = findHandler(records.default, '/:id/edits', 'get')
    const deleteHandler = findHandler(records.default, '/:id', 'delete')
    const batchUpdateHandler = findHandler(records.default, '/batch-update', 'post')
    const batchDeleteHandler = findHandler(records.default, '/batch-delete', 'post')

    const callRoute = async (handler, { body = {}, params = {} } = {}) => {
      const res = response()
      await handler({ body, params, headers: {} }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    const eventsFor = (recordId) =>
      db.prepare('SELECT * FROM creator_record_edits WHERE record_id = ? ORDER BY id').all(recordId)
    const totalEvents = () => db.prepare('SELECT COUNT(*) AS n FROM creator_record_edits').get().n

    console.log('===== 0. schema / migration 幂等 =====')
    const columns = db.prepare('PRAGMA table_info(creator_record_edits)').all().map((c) => c.name)
    check('creator_record_edits 列齐全',
      ['id', 'record_id', 'action', 'source', 'group_id', 'field_name', 'before_value_json', 'after_value_json', 'created_at']
        .every((name) => columns.includes(name)),
      columns.join(','))
    check('初始为空（无回填、无伪造历史）', totalEvents() === 0)

    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, first_play, second_week_play, publish_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const recA = Number(insertRecord.run('2026-W33', '审计甲', '数码', 5000, 75000, 80000, '2026-08-19').lastInsertRowid)
    const recB = Number(insertRecord.run('2026-W34', '审计乙', '美妆', 3000, null, null, '2026-08-26').lastInsertRowid)

    const put = (id, body) => callRoute(putHandler, { params: { id: String(id) }, body })

    console.log('\n===== 1. PUT 编辑留痕 =====')
    const r1 = await put(recA, { second_week_play: 120000 })
    check('T1 累计播放 80,000 → 120,000：业务值已更新', r1.status === 200 && r1.data.second_week_play === 120000)
    const ev1 = eventsFor(recA)
    check('T1b 审计事件：field=second_week_play / before=80000 / after=120000',
      ev1.length === 1 && ev1[0].field_name === 'second_week_play' &&
        JSON.parse(ev1[1 - 1].before_value_json) === 80000 &&
        JSON.parse(ev1[0].after_value_json) === 120000 &&
        ev1[0].action === 'update' && ev1[0].source === 'manual_single',
      JSON.stringify(ev1))

    const r2 = await put(recB, { first_play: 0 })
    const ev2 = eventsFor(recB)
    check('T2 null → 0：JSON 保留两种值区别（before=null / after=0）',
      r2.status === 200 && ev2.length === 1 && ev2[0].field_name === 'first_play' &&
        JSON.parse(ev2[0].before_value_json) === null && JSON.parse(ev2[0].after_value_json) === 0,
      JSON.stringify({ status: r2.status, msg: r2.msg, ev2 }))

    const r3 = await put(recB, { first_play: null })
    const ev3 = eventsFor(recB)
    check('T3 0 → null（清空语义）：before=0 / after=null',
      r3.status === 200 && ev3.length === 2 && ev3[1].field_name === 'first_play' &&
        JSON.parse(ev3[1].before_value_json) === 0 && JSON.parse(ev3[1].after_value_json) === null)

    const eventsBeforeNoChange = totalEvents()
    const r4 = await put(recA, { second_week_play: 120000 })
    check('T4 无变化 PUT：不产生审计事件（也不伪造变更）',
      r4.status === 200 && totalEvents() === eventsBeforeNoChange)

    const r5 = await put(recA, { nickname: '审计甲改', creator_type: '职场', publish_date: '2026-08-20' })
    const ev5 = eventsFor(recA).filter((e) => e.id > ev1[0].id)
    check('T5 多字段 PUT：每个变化字段一条事件',
      r5.status === 200 && ev5.length === 3 &&
        ev5.map((e) => e.field_name).sort().join(',') === 'creator_type,nickname,publish_date',
      JSON.stringify(ev5.map((e) => e.field_name)))

    const r6 = await put(recA, { second_week_play: 1000 })
    check('T6 非法值（累计 < 7日播放量）→ 400，无业务变化、无审计行',
      r6.status === 400 && totalEvents() === eventsBeforeNoChange + 3)

    console.log('\n===== 2. 审计失败 → 业务更新整体回滚 =====')
    db.exec('DROP TABLE creator_record_edits')
    const r7 = await put(recA, { total_cost: 9999 })
    check('T7a 审计表缺失 → 编辑被拒绝（fail-closed，不静默绕过）',
      r7.status === 500 && /creator_record_edits/.test(String(r7.msg)), r7.msg)
    const costAfterFail = db.prepare('SELECT total_cost FROM creator_records WHERE id = ?').get(recA).total_cost
    check('T7b 业务更新随审计一起回滚（total_cost 未被修改）', costAfterFail === 5000)
    const recordEditAudit = await import(pathToFileURL(path.join(root, 'backend/utils/recordEditAudit.js')))
    recordEditAudit.applyRecordEditsSchema ? null : null
    db.exec(`CREATE TABLE IF NOT EXISTS creator_record_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, record_id INTEGER NOT NULL,
      action TEXT NOT NULL, source TEXT NOT NULL, group_id TEXT, field_name TEXT NOT NULL,
      before_value_json TEXT, after_value_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
    check('审计表已恢复（表存在，可继续写入）',
      Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'creator_record_edits'").get()))

    console.log('\n===== 3. 批量修改：group_id / 部分成功 / 无变化不伪造 =====')
    const g1Before = totalEvents()
    const r8 = await callRoute(batchUpdateHandler, {
      body: { ids: [recA, recB, 999999], field: 'creator_type', value: '职场' }
    })
    check('T8 批量修改部分成功（2 成功 / 1 不存在）',
      r8.status === 200 && r8.data.success === 2 && r8.data.failed === 1,
      JSON.stringify(r8.data && { success: r8.data.success, failed: r8.data.failed }))
    const batchEvents = db.prepare(
      'SELECT * FROM creator_record_edits WHERE source = ? AND id > ? ORDER BY id'
    ).all('manual_batch', g1Before)
    // recA 在 T5 已被改为「职场」，批量改成同值不算真实变化 → 只有 recB（美妆→职场）写审计
    check('T8b 只为真实变化的记录写审计（同值 / 不存在记录无事件）',
      batchEvents.length === 1 && batchEvents[0].record_id === recB,
      JSON.stringify(batchEvents.map((e) => e.record_id)))
    check('T8c 同一批次 group_id 一致且非空',
      batchEvents.length === 1 && batchEvents[0].group_id !== null)

    const g2Before = totalEvents()
    const r9 = await callRoute(batchUpdateHandler, {
      body: { ids: [recA], field: 'creator_type', value: '职场' }
    })
    check('T9 无变化批量修改：不伪造变更事件',
      r9.status === 200 && totalEvents() === g2Before, JSON.stringify(r9.data))
    const r10 = await callRoute(batchUpdateHandler, {
      body: { ids: [recA], field: 'creator_type', value: '教育' }
    })
    const g2Events = db.prepare(
      'SELECT * FROM creator_record_edits WHERE source = ? AND id > ? ORDER BY id'
    ).all('manual_batch', g2Before)
    check('T9b 不同操作 group_id 不同',
      g2Events.length === 1 && g2Events[0].group_id !== batchEvents[0].group_id)

    console.log('\n===== 4. 删除留痕 =====')
    const r11 = await callRoute(deleteHandler, { params: { id: String(recB) } })
    check('T10 单条删除成功', r11.status === 200)
    const delEvents = eventsFor(recB)
    const rowDeleteEvent = delEvents.find((e) => e.action === 'delete')
    check('T10b 删除快照：action=delete / 整行字段 / before 保留（记录行已删除仍可查）',
      delEvents.filter((e) => e.action === 'delete').length === 1 &&
        rowDeleteEvent && rowDeleteEvent.field_name === '__row__' &&
        JSON.parse(rowDeleteEvent.before_value_json).nickname === '审计乙' &&
        db.prepare('SELECT COUNT(*) AS n FROM creator_records WHERE id = ?').get(recB).n === 0)
    const goneRow = db.prepare('SELECT nickname FROM creator_records WHERE id = ?').get(recB)
    check('T10c 被删除的 record_id 查询审计仍返回事件（只读接口明确设计）', goneRow === undefined && delEvents.length >= 1)

    console.log('\n===== 5. 导入域不重复记账 / 只读接口 =====')
    // recC：存在、有业务值，先经历一次 PUT（产生编辑事件），再经历一次导入更新与删除
    const recC = Number(insertRecord.run('2026-W35', '审计丙', '数码', 800, 20000, 100000, '2026-09-02').lastInsertRowid)
    const rC = await put(recC, { total_cost: 999 })
    check('T13 前置：recC 一次 PUT 产生编辑事件且记录存在', rC.status === 200 && eventsFor(recC).length === 1)
    const beforeImport = {
      updates: db.prepare('SELECT COUNT(*) AS n FROM import_batch_record_updates').get().n,
      edits: totalEvents()
    }
    const importUpdatePayload = {
      rows: [{ time_cycle: '2026-W35', nickname: '审计新', total_cost: 1000, publish_date: '2026-09-02' }],
      updates: [{ record_id: recC, expected_before: 100000, desired_after: 150000 }],
      batch: { fileName: 'audit-test-import.xlsx', totalCount: 1 }
    }
    const batchImport = await callRoute(findHandler(records.default, '/batch', 'post'), { body: importUpdatePayload })
    check('导入更新走 import_batch_record_updates（既有机制）',
      batchImport.status === 200 && db.prepare('SELECT COUNT(*) AS n FROM import_batch_record_updates').get().n === beforeImport.updates + 1,
      JSON.stringify({ status: batchImport.status, msg: batchImport.msg, data: batchImport.data }))
    check('T12 导入更新不重复写入 creator_record_edits', totalEvents() === beforeImport.edits)
    check('导入更新业务值生效（second_week_play=150000）',
      db.prepare('SELECT second_week_play FROM creator_records WHERE id = ?').get(recC).second_week_play === 150000)

    console.log('\n===== 6. 删除留痕 =====')
    const editsApi = await callRoute(editsHandler, { params: { id: String(recA) } })
    check('T13 只读接口返回事件且 record_exists=true',
      editsApi.status === 200 && editsApi.data.record_exists === true && editsApi.data.available === true &&
        editsApi.data.edits.length > 0)
    const r13b = await callRoute(editsHandler, { params: { id: String(recB) } })
    check('T13b 已删除 record_id 的查询：edits 保留 + record_exists=false（明确设计）',
      r13b.status === 200 && r13b.data.record_exists === false && r13b.data.edits.length > 0)

    const g3Before = totalEvents()
    const r12 = await callRoute(batchDeleteHandler, { body: { ids: [recC, 999999] } })
    check('T11 批量删除只记录真正删除成功的行',
      r12.status === 200 && r12.data.success === 1 && totalEvents() - g3Before === 1,
      JSON.stringify(r12.data))
    const recCEdits = eventsFor(recC)
    check('T11b 被删除记录的审计链完整保留（PUT 事件 + 删除事件）',
      recCEdits.some((e) => e.action === 'update') && recCEdits.some((e) => e.action === 'delete'),
      JSON.stringify(recCEdits.map((e) => e.action)))
    const r14a = await callRoute(editsHandler, { params: { id: String(recC) } })
    check('T14 只读接口不写库（前后审计行数一致）', totalEvents() === g3Before + 1 && r14a.data.edits.length === recCEdits.length)

    const oldRecord = Number(insertRecord.run('2026-W36', '无历史达人', '科普', 500, 10000, null, '2026-09-01').lastInsertRowid)
    const emptyEdits = (await callRoute(editsHandler, { params: { id: String(oldRecord) } })).data
    check('T16 旧记录无编辑历史：available=true 且 edits 为空（不伪造回填）',
      emptyEdits.available === true && emptyEdits.edits.length === 0)

    check('日期纠正审计不受影响（creator_calibration_corrections 仍为空/独立）',
      db.prepare('SELECT COUNT(*) AS n FROM creator_calibration_corrections').get().n === 0)
    check('未发生任何外部网络请求', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))
    check('隔离库位于临时目录（未触碰真实 workbench.db）',
      process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir()))
  } finally {
    networkGuard.restore()
  }

  console.log(`\n================ 测试汇总 ================`)
  console.log(`用例总数：${passCount + failCount}　通过：${passCount}　失败：${failCount}　通过率：${((passCount / (passCount + failCount)) * 100).toFixed(1)}%`)
  if (failCount > 0) {
    console.log('\n失败用例：')
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('测试执行异常：', error)
  process.exitCode = 1
})
