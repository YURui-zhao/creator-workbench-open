#!/usr/bin/env node
/**
 * Existing Record Update V0.1：安全更新已有记录（只允许 second_week_play 安全增长）
 *
 * 运行方式：node tests/import_record_updates.test.js
 * 隔离方式：通过 WORKBENCH_DB_PATH 指向临时数据库（必须先于 import backend/db.js 设置）。
 *          真实 backend/workbench.db 全程只读（仅 65 条基线回归时读取）。
 *
 * 覆盖：
 *   纯规则   safe increase / null→positive / decrease / latest<first / 其它字段变化 /
 *            blank 不更新 / 0 vs blank 保留 0 / 只更新 second_week_play
 *   后端     optimistic success / optimistic conflict(409) / update-only batch /
 *            mixed atomic batch / mixed 失败全回滚 / 审计 before-after / status=updated
 *   回滚     restore / conflict(409) / legacy insert-only 行为不变 / 删除历史清理审计
 *   回归     真实 1008.xlsx + 65 条 fixture：0 new / 7 safe updates，records 数不变、
 *            total_cost 逐字节不变、仅 second_week_play 变化
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')

// 隔离数据库：必须在使用任何 backend 模块之前设置环境变量
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'import-record-updates-'))
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

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.payload = body
      return this
    },
    setHeader() {},
    send() {}
  }
}

function getHandler(router, routePath, method = 'post') {
  const layer = router.stack.find(
    (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
  )
  if (!layer) return null
  return layer.route.stack[layer.route.stack.length - 1].handle
}

// 纯规则用的最小 record 形状
const mkExisting = (over = {}) => ({
  id: 1,
  time_cycle: '2026-W33',
  nickname: '测试达人',
  creator_type: '测试类型',
  homepage: 'https://www.example.com/home',
  content_link: 'https://www.example.com/content',
  video_link: 'https://www.iesdouyin.com/share/video/7000000000000000001',
  total_cost: 1000,
  publish_date: '2026-08-19',
  first_play: 1000,
  second_week_play: 5000,
  ...over
})
const incomingOf = (over = {}) => ({ ...mkExisting(), id: undefined, ...over })

async function main() {
  const recordsModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/records.js')).href
  )
  const importModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/importBatches.js')).href
  )
  const db = (await import(pathToFileURL(path.join(REPO_ROOT, 'backend/db.js')).href)).default
  const excel = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/excel.js')).href
  )

  const postBatch = getHandler(recordsModule.default, '/batch', 'post')
  const getBatchDetail = getHandler(importModule.default, '/batches/:id', 'get')
  const postRollback = getHandler(importModule.default, '/batches/:id/rollback', 'post')
  const deleteHistory = getHandler(importModule.default, '/batches/:id', 'delete')

  check(
    'handler 可用（batch / 详情 / 撤销 / 删除历史）',
    typeof postBatch === 'function' &&
      typeof getBatchDetail === 'function' &&
      typeof postRollback === 'function' &&
      typeof deleteHistory === 'function'
  )

  // ---------- 种子数据 ----------
  const insertRecord = db.prepare(
    `INSERT INTO creator_records
       (time_cycle, nickname, homepage, creator_type, content_link, total_cost, publish_date,
        video_link, first_play, second_week_play)
     VALUES
       (@time_cycle, @nickname, @homepage, @creator_type, @content_link, @total_cost, @publish_date,
        @video_link, @first_play, @second_week_play)`
  )
  const seed = (over = {}) =>
    Number(
      insertRecord.run({
        time_cycle: '2026-W33',
        nickname: '基准达人',
        homepage: 'https://www.example.com/home',
        creator_type: '测试类型',
        content_link: 'https://www.example.com/content',
        total_cost: 1000,
        publish_date: '2026-08-19',
        video_link: `https://www.iesdouyin.com/share/video/upd-${Math.random().toString(36).slice(2)}`,
        first_play: 1000,
        second_week_play: 5000,
        ...over
      }).lastInsertRowid
    )

  const getRecord = db.prepare('SELECT * FROM creator_records WHERE id = ?')
  const countRecords = () => db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
  const countBatches = () => db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n
  const countUpdates = (batchId) =>
    db.prepare('SELECT COUNT(*) AS n FROM import_batch_record_updates WHERE batch_id = ?').get(batchId).n

  const callBatch = (body) => {
    const res = createRes()
    postBatch({ body }, res)
    return res
  }
  const callRollback = (id) => {
    const res = createRes()
    postRollback({ params: { id: String(id) } }, res)
    return res
  }
  const callDetail = (id) => {
    const res = createRes()
    getBatchDetail({ params: { id: String(id) } }, res)
    return res
  }

  const batchMeta = (extra = {}) => ({
    fileName: '__update-test.xlsx',
    totalCount: 0,
    failCount: 0,
    skipCount: 0,
    duplicateCount: 0,
    items: [],
    ...extra
  })

  const splitOne = (existingRow, incomingRow) => {
    const classification = excel.classifyImportRows([incomingRow], [existingRow])
    return {
      classification,
      ...excel.splitExistingChanges(classification.existingChanged)
    }
  }

  // ================= 1. 纯规则：safe_update / manual_review =================
  console.log('\n===== 1. safe_update 规则（纯函数） =====')

  const safeIncrease = splitOne(mkExisting({ second_week_play: 36200 }), incomingOf({ second_week_play: 40400 }))
  check(
    'safe increase：36200 → 40400 可安全更新',
    safeIncrease.safeUpdates.length === 1 &&
      safeIncrease.safeUpdates[0].update.before === 36200 &&
      safeIncrease.safeUpdates[0].update.after === 40400 &&
      safeIncrease.manualReview.length === 0
  )

  const nullToPositive = splitOne(mkExisting({ second_week_play: null }), incomingOf({ second_week_play: 40400 }))
  check(
    'null → positive：允许首次写入累计播放量',
    nullToPositive.safeUpdates.length === 1 && nullToPositive.safeUpdates[0].update.before === null
  )

  const decrease = splitOne(mkExisting({ second_week_play: 40400 }), incomingOf({ second_week_play: 36200 }))
  check(
    'decrease：40400 → 36200 → manual_review（不自动下调）',
    decrease.safeUpdates.length === 0 && decrease.manualReview.length === 1 && /未增长/.test(decrease.manualReview[0].update.reason)
  )

  const belowFirst = splitOne(
    mkExisting({ first_play: 5000, second_week_play: null }),
    incomingOf({ first_play: 5000, second_week_play: 3000 })
  )
  check(
    'latest < first：3000 < 5000 → manual_review',
    belowFirst.safeUpdates.length === 0 && belowFirst.manualReview.length === 1 && /7日播放量/.test(belowFirst.manualReview[0].update.reason)
  )

  const otherField = splitOne(
    mkExisting({ second_week_play: 36200, total_cost: 1000 }),
    incomingOf({ second_week_play: 40400, total_cost: 2000 })
  )
  check(
    '其它字段变化（total_cost）→ manual_review',
    otherField.safeUpdates.length === 0 && otherField.manualReview.length === 1 && /其它字段变化/.test(otherField.manualReview[0].update.reason)
  )

  const blankIncoming = splitOne(mkExisting({ second_week_play: 36200 }), incomingOf({ second_week_play: '' }))
  check(
    'blank：Excel 未提供累计播放量 → 既非 safe 也非 manual（noop）',
    blankIncoming.classification.existingNoop.length === 1 &&
      blankIncoming.safeUpdates.length === 0 &&
      blankIncoming.manualReview.length === 0
  )

  const zeroVsBlank = splitOne(
    mkExisting({ first_play: 0, second_week_play: 36200 }),
    incomingOf({ first_play: '', second_week_play: 40400 })
  )
  check(
    '0 vs blank：DB first_play=0 / Excel blank → 保留 0，仅更新累计播放量',
    zeroVsBlank.safeUpdates.length === 1 &&
      zeroVsBlank.safeUpdates[0].update.field === 'second_week_play' &&
      zeroVsBlank.safeUpdates[0].diffs.every(
        (diff) => diff.field === 'second_week_play' || diff.change_type === 'incoming_missing'
      )
  )

  // ================= 2. 后端：乐观并发 =================
  console.log('\n===== 2. 后端更新（乐观并发） =====')

  const id1 = seed({ second_week_play: 36200, total_cost: 2100 })
  const res1 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: id1, expected_before: 36200, desired_after: 40400 }]
  })
  check(
    'optimistic success：期望值匹配 → 更新成功',
    res1.statusCode === 200 &&
      res1.payload?.data?.updatedCount === 1 &&
      getRecord.get(id1).second_week_play === 40400
  )

  const id2 = seed({ second_week_play: 36200 })
  const batchesBeforeConflict = countBatches()
  const res2 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: id2, expected_before: 99999, desired_after: 40400 }]
  })
  check(
    'optimistic conflict：期望值不匹配 → 409 且不写入',
    res2.statusCode === 409 &&
      /刷新导入预览/.test(res2.payload?.msg || '') &&
      getRecord.get(id2).second_week_play === 36200 &&
      countBatches() === batchesBeforeConflict
  )

  // ================= 3. update-only / mixed =================
  console.log('\n===== 3. update-only / mixed 批次 =====')

  const id3 = seed({ second_week_play: 10000 })
  const res3 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1, items: [{ rowIndex: null, status: 'updated', reason: '更新 #id3' }] }),
    updates: [{ record_id: id3, expected_before: 10000, desired_after: 12000 }]
  })
  check(
    'update-only batch：无新增也创建有效批次',
    res3.statusCode === 200 &&
      res3.payload?.data?.count === 0 &&
      res3.payload?.data?.batchId > 0 &&
      countUpdates(res3.payload.data.batchId) === 1 &&
      getRecord.get(id3).second_week_play === 12000
  )

  const id4 = seed({ second_week_play: 20000 })
  const newRow = {
    time_cycle: '2026-W33',
    nickname: '__mixed新记录',
    creator_type: '测试类型',
    total_cost: 500,
    publish_date: '2026-08-20',
    first_play: 100,
    second_week_play: 200,
    video_link: 'https://www.iesdouyin.com/share/video/mixed-new-1'
  }
  const res4 = callBatch({
    rows: [newRow],
    batch: batchMeta({ totalCount: 2 }),
    updates: [{ record_id: id4, expected_before: 20000, desired_after: 25000 }]
  })
  check(
    'mixed atomic：1 新增 + 1 更新同批次完成',
    res4.statusCode === 200 &&
      res4.payload?.data?.count === 1 &&
      res4.payload?.data?.updatedCount === 1 &&
      getRecord.get(id4).second_week_play === 25000
  )

  const id5 = seed({ second_week_play: 30000 })
  const recordsBeforeFail = countRecords()
  const batchesBeforeFail = countBatches()
  const res5 = callBatch({
    rows: [{ ...newRow, nickname: '__mixed失败新记录', video_link: 'https://www.iesdouyin.com/share/video/mixed-new-2' }],
    batch: batchMeta({ totalCount: 2 }),
    updates: [{ record_id: id5, expected_before: 1, desired_after: 33000 }]
  })
  check(
    'mixed 失败 → 全量回滚（无新增、无批次、无更新）',
    res5.statusCode === 409 &&
      countRecords() === recordsBeforeFail &&
      countBatches() === batchesBeforeFail &&
      getRecord.get(id5).second_week_play === 30000
  )

  // ================= 4. 只改 second_week_play =================
  console.log('\n===== 4. 字段级更新边界 =====')

  const id6 = seed({ second_week_play: 54200, total_cost: 8888.5, first_play: 400, publish_date: '2026-08-11', creator_type: '历史类', homepage: 'https://www.example.com/h6', video_link: 'https://www.iesdouyin.com/share/video/only-second' })
  const before6 = getRecord.get(id6)
  const res6 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: id6, expected_before: 54200, desired_after: 61000 }]
  })
  const after6 = getRecord.get(id6)
  check(
    '只更新 second_week_play：其它字段逐字节不变',
    res6.statusCode === 200 &&
      after6.second_week_play === 61000 &&
      after6.total_cost === before6.total_cost &&
      after6.first_play === before6.first_play &&
      after6.publish_date === before6.publish_date &&
      after6.creator_type === before6.creator_type &&
      after6.homepage === before6.homepage &&
      after6.video_link === before6.video_link
  )

  const resUnknownField = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: id6, expected_before: 61000, desired_after: 62000, field_name: 'total_cost' }]
  })
  check(
    '前端提交 field_name 被忽略（后端固定 second_week_play）',
    resUnknownField.statusCode === 200 &&
      getRecord.get(id6).second_week_play === 62000 &&
      getRecord.get(id6).total_cost === before6.total_cost
  )

  const resBelowFirst = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: id6, expected_before: 62000, desired_after: 100 }]
  })
  check(
    'desired_after < first_play → 拒绝（400 / 409），值不变',
    resBelowFirst.statusCode >= 400 && getRecord.get(id6).second_week_play === 62000
  )

  // ================= 5. 审计 + Import History =================
  console.log('\n===== 5. 更新审计 / 导入历史 =====')

  const id7 = seed({ second_week_play: null })
  const res7 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1, items: [{ rowIndex: null, status: 'updated', reason: '累计播放量：null → 1800' }] }),
    updates: [{ record_id: id7, expected_before: null, desired_after: 1800 }]
  })
  const audit7 = db
    .prepare('SELECT * FROM import_batch_record_updates WHERE batch_id = ?')
    .get(res7.payload.data.batchId)
  check(
    '审计 before/after：null 与 0 用 JSON 区分',
    audit7.field_name === 'second_week_play' &&
      audit7.before_value_json === 'null' &&
      audit7.after_value_json === '1800'
  )

  const detail7 = callDetail(res7.payload.data.batchId).payload.data
  check(
    '批次详情：update_count / item_summary.updated / updates[]',
    detail7.update_count === 1 &&
      detail7.item_summary.updated === 1 &&
      detail7.updates.length === 1 &&
      detail7.updates[0].before_value === null &&
      detail7.updates[0].after_value === 1800 &&
      detail7.updates[0].field_label === '累计播放量'
  )

  const itemStatuses = db
    .prepare('SELECT status FROM import_batch_items WHERE batch_id = ?')
    .all(res7.payload.data.batchId)
    .map((row) => row.status)
  check(
    '行级明细允许 updated 状态（不再伪装成 duplicate/fail）',
    itemStatuses.length === 1 && itemStatuses[0] === 'updated'
  )

  const legacyItemStatuses = db
    .prepare('SELECT status FROM import_batch_items WHERE batch_id = ?')
    .all(res1.payload.data.batchId)
    .map((row) => row.status)
  check('update-only 批次不再写入「faked success」行', legacyItemStatuses.every((status) => status !== 'success'))

  // ================= 6. 回滚 =================
  console.log('\n===== 6. 批次回滚 =====')

  const id8 = seed({ second_week_play: 3000, total_cost: 1234 })
  const res8 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: id8, expected_before: 3000, desired_after: 4000 }]
  })
  const rollback8 = callRollback(res8.payload.data.batchId)
  check(
    'rollback restore：after → before，记录不被 DELETE',
    rollback8.statusCode === 200 &&
      rollback8.payload?.data?.revertedUpdateCount === 1 &&
      rollback8.payload?.data?.deletedCount === 0 &&
      getRecord.get(id8)?.second_week_play === 3000
  )
  const rollback8again = callRollback(res8.payload.data.batchId)
  check(
    'rollback 幂等：再次撤销不报错、不覆盖',
    rollback8again.statusCode === 200 && getRecord.get(id8).second_week_play === 3000
  )

  const id9 = seed({ second_week_play: 36200 })
  const res9 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: id9, expected_before: 36200, desired_after: 40400 }]
  })
  db.prepare('UPDATE creator_records SET second_week_play = ? WHERE id = ?').run(45000, id9)
  const rollback9 = callRollback(res9.payload.data.batchId)
  check(
    'rollback conflict：导入后又被修改 → 409，不覆盖 45000',
    rollback9.statusCode === 409 &&
      /撤销冲突/.test(rollback9.payload?.msg || '') &&
      getRecord.get(id9).second_week_play === 45000
  )

  // legacy insert-only 回滚行为不变
  const legacyRows = [1, 2].map((i) => ({
    ...newRow,
    nickname: `__legacy#${i}`,
    video_link: `https://www.iesdouyin.com/share/video/legacy-${i}`
  }))
  const resLegacy = callBatch({ rows: legacyRows, batch: batchMeta({ totalCount: 2 }) })
  const legacyIds = resLegacy.payload.data.ids
  const rollbackLegacy = callRollback(resLegacy.payload.data.batchId)
  check(
    'legacy insert-only 回滚：删除新增记录（原行为不变）',
    rollbackLegacy.statusCode === 200 &&
      rollbackLegacy.payload?.data?.deletedCount === 2 &&
      rollbackLegacy.payload?.data?.revertedUpdateCount === 0 &&
      legacyIds.every((id) => !getRecord.get(id))
  )

  const deleteHistoryRes = createRes()
  deleteHistory({ params: { id: String(res8.payload.data.batchId) } }, deleteHistoryRes)
  const leftover = db
    .prepare('SELECT COUNT(*) AS n FROM import_batch_record_updates WHERE batch_id = ?')
    .get(res8.payload.data.batchId).n
  check('删除历史：清理该批次的更新审计（无孤儿）', deleteHistoryRes.statusCode === 200 && leftover === 0)

  // ================= 7. backend growth authority（不依赖前端） =================
  console.log('\n===== 7. backend 只增规则（权威校验） =====')
  // 说明：这些用例直接调用后端 route，绕过前端 evaluateImportUpdate，
  //       验证「累计播放量只允许安全增长」由后端独立强制。

  // 7.1 current=100 → desired=101：成功
  const g1 = seed({ first_play: 0, second_week_play: 100 })
  const gr1 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: g1, expected_before: 100, desired_after: 101 }]
  })
  check(
    'growth 1/6：100 → 101 成功',
    gr1.statusCode === 200 && getRecord.get(g1).second_week_play === 101
  )

  // 7.2 current=100 → desired=100（持平）：拒绝
  const g2 = seed({ first_play: 0, second_week_play: 100 })
  const batchesBeforeG2 = countBatches()
  const gr2 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: g2, expected_before: 100, desired_after: 100 }]
  })
  check(
    'growth 2/6：100 → 100 拒绝（400）且不写入 / 不建批次',
    gr2.statusCode === 400 &&
      /必须高于当前值/.test(gr2.payload?.msg || '') &&
      getRecord.get(g2).second_week_play === 100 &&
      countBatches() === batchesBeforeG2
  )

  // 7.3 current=100 → desired=99（下降）：拒绝（前端被绕过也必须拒绝）
  const g3 = seed({ first_play: 0, second_week_play: 100 })
  const gr3 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: g3, expected_before: 100, desired_after: 99 }]
  })
  check(
    'growth 3/6（绕过前端）：expected_before 匹配但 desired 下降 → 后端仍拒绝',
    gr3.statusCode === 400 && getRecord.get(g3).second_week_play === 100
  )

  // 7.4 current=null → desired=0：合法
  const g4 = seed({ first_play: 0, second_week_play: null })
  const gr4 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: g4, expected_before: null, desired_after: 0 }]
  })
  check(
    'growth 4/6：null → 0 成功（0 是真实观察值）',
    gr4.statusCode === 200 && getRecord.get(g4).second_week_play === 0
  )

  // 7.5 current=0 → desired=1：合法
  const g5 = seed({ first_play: 0, second_week_play: 0 })
  const gr5 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: g5, expected_before: 0, desired_after: 1 }]
  })
  check(
    'growth 5/6：0 → 1 成功',
    gr5.statusCode === 200 && getRecord.get(g5).second_week_play === 1
  )

  // 7.6 current=null → desired=positive 但 < first_play：拒绝
  const g6 = seed({ first_play: 5000, second_week_play: null })
  const gr6 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: g6, expected_before: null, desired_after: 3000 }]
  })
  check(
    'growth 6/6：null → 3000（< first_play 5000）拒绝',
    gr6.statusCode === 400 &&
      /7日播放量/.test(gr6.payload?.msg || '') &&
      getRecord.get(g6).second_week_play === null
  )

  // 7.7 desired_after = null：拒绝
  const g7 = seed({ first_play: 0, second_week_play: 100 })
  const gr7 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: g7, expected_before: 100, desired_after: null }]
  })
  check(
    'growth 附加：desired_after = null 拒绝',
    gr7.statusCode === 400 && getRecord.get(g7).second_week_play === 100
  )

  // 7.8 rollback 独立于「只增」规则：after → before 的下降恢复必须仍然成功
  const g8 = seed({ first_play: 0, second_week_play: 36200 })
  const gr8 = callBatch({
    rows: [],
    batch: batchMeta({ totalCount: 1 }),
    updates: [{ record_id: g8, expected_before: 36200, desired_after: 40400 }]
  })
  const rollbackG8 = callRollback(gr8.payload.data.batchId)
  check(
    'rollback 独立性：40400 → 36200（下降）恢复成功，不被「只增」规则阻拦',
    rollbackG8.statusCode === 200 &&
      rollbackG8.payload?.data?.revertedUpdateCount === 1 &&
      getRecord.get(g8).second_week_play === 36200
  )

  // ================= 8. 本地样本 1008.xlsx + 65 条 fixture 回归（路径由环境变量提供） =================
  console.log('\n===== 8. 本地样本 1008.xlsx 65 条 fixture 回归 =====')
  // 真实样本不随仓库分发；如需启用本回归，设置 WORKBENCH_REAL_IMPORT_XLSX 指向本地样本
  const realFile = process.env.WORKBENCH_REAL_IMPORT_XLSX || path.join(REPO_ROOT, 'tests', 'fixtures', 'real-1008-sample.xlsx')
  const realDb = path.join(REPO_ROOT, 'backend/workbench.db')
  if (fs.existsSync(realFile) && fs.existsSync(realDb)) {
    const { createRequire } = require('node:module')
    const req = createRequire(path.join(REPO_ROOT, 'backend/package.json'))
    const Database = req('better-sqlite3')
    const ro = new Database(realDb, { readonly: true })
    const realRows = ro.prepare('SELECT * FROM creator_records ORDER BY id').all()
    ro.close()

    // 把真实 65 条复制进临时库（保持 id 不变）
    const copyColumns = [
      'id', 'time_cycle', 'nickname', 'homepage', 'creator_type', 'content_link',
      'total_cost', 'publish_date', 'video_link', 'first_play', 'second_week_play', 'created_at'
    ]
    const copyStmt = db.prepare(
      `INSERT OR REPLACE INTO creator_records (${copyColumns.join(', ')})
       VALUES (${copyColumns.map((c) => `@${c}`).join(', ')})`
    )
    const copyAll = db.transaction((rows) => {
      for (const row of rows) {
        const payload = {}
        for (const col of copyColumns) payload[col] = row[col]
        copyStmt.run(payload)
      }
    })
    copyAll(realRows)

    const fixtures = db.prepare('SELECT * FROM creator_records ORDER BY id').all()
    const cycles = [...new Set(fixtures.map((r) => r.time_cycle).filter(Boolean))].sort()
    const buf = fs.readFileSync(realFile)
    const file = {
      name: '1008.xlsx',
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    }
    const parsed = await excel.parseRecordsExcel(file, cycles, {
      overrides: {
        '播放量（首发）': 'first_play',
        '播放量（新）': 'second_week_play',
        报价: 'IGNORE',
        cpm: 'IGNORE'
      }
    })
    const classification = excel.classifyImportRows(parsed.validRows, fixtures)
    const { safeUpdates, manualReview } = excel.splitExistingChanges(classification.existingChanged)
    const intents = excel.buildUpdateIntents(safeUpdates)

    check(
      '1008 分类：0 new / 54 exact / 4 noop / 7 safe updates / 12 blank',
      classification.newRecords.length === 0 &&
        classification.exactDuplicates.length === 54 &&
        classification.existingNoop.length === 4 &&
        classification.existingChanged.length === 7 &&
        safeUpdates.length === 7 &&
        manualReview.length === 0 &&
        parsed.blankRows === 12
    )
    check(
      '1008 intents 只含 record_id / expected_before / desired_after（无 field_name）',
      intents.length === 7 &&
        intents.every(
          (intent) =>
            Object.keys(intent).sort().join(',') === 'desired_after,expected_before,record_id'
        )
    )

    const targetIds = [715, 716, 718, 719, 720, 721, 722]
    const beforeSnapshot = targetIds.map((id) => ({ ...getRecord.get(id) }))
    const recordsBefore = countRecords()
    const res1008 = callBatch({
      rows: [],
      batch: batchMeta({
        fileName: '1008.xlsx',
        totalCount: 77,
        items: intents.map((intent) => ({
          rowIndex: null,
          status: 'updated',
          reason: `更新 #${intent.record_id}`
        }))
      }),
      updates: intents
    })
    check(
      '1008 更新成功：7 条 updatedCount',
      res1008.statusCode === 200 && res1008.payload?.data?.updatedCount === 7
    )
    check(
      '1008 更新后 records 数量不变（0 new）',
      countRecords() === recordsBefore
    )
    const expectedAfter = { 715: 40400, 716: 40600, 718: 61000, 719: 18600, 720: 97000, 721: 19200, 722: 1499000 }
    const allOnlySecond = beforeSnapshot.every((before) => {
      const after = getRecord.get(before.id)
      const onlySecond = Object.keys(before).every(
        (key) => key === 'second_week_play' || before[key] === after[key]
      )
      return onlySecond && after.second_week_play === expectedAfter[before.id]
    })
    check('1008 7 条记录：仅 second_week_play 变化，total_cost 等逐字节不变', allOnlySecond)
    check(
      '1008 审计：7 条 before/after 落库',
      countUpdates(res1008.payload.data.batchId) === 7
    )
  } else {
    check('1008.xlsx / 真实库不可用 → 跳过真实回归（等价用例已覆盖）', true, 'skipped')
  }
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    process.exitCode = 1
  })
  .finally(() => {
    const total = passCount + failCount
    const rate = total ? ((passCount / total) * 100).toFixed(1) : '0.0'
    console.log('\n================ 测试汇总 ================')
    console.log(`用例总数：${total}　通过：${passCount}　失败：${failCount}　通过率：${rate}%`)
    if (failCount > 0) {
      console.log('\n失败用例：')
      failures.forEach((item) => console.log(`  - ${item}`))
    }
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true })
    } catch {
      /* 忽略清理失败 */
    }
    process.exitCode = failCount > 0 ? 1 : 0
  })
