#!/usr/bin/env node
/**
 * 导入批次管理：删除历史 / 撤销导入（Batch 6C）
 *
 * 运行方式：node tests/import_batch_management.test.js
 * 隔离方式：通过 WORKBENCH_DB_PATH 指向临时数据库（必须先于 import backend/db.js 设置），
 *          测试自行造批次与记录，结束后删除临时库；用户真实库完全不受影响。
 *
 * 覆盖：
 *   CASE 1  仍有关联记录时删除历史 → 409，records / batch / items / mappings 全部不变
 *   CASE 2  撤销导入 → 记录删除、mappings 清理、batch 与 items 保留、success_count 不变
 *   CASE 3  撤销 batch A 不影响 batch B 与手工创建的记录
 *   CASE 4  成功 2 条中有 1 条已被手动删除 → 撤销只删剩余 1 条，不报错，mappings 归 0
 *   CASE 5  第二次撤销 → 不 500，明确提示「没有可撤销的投放记录」
 *   CASE 6  mappings = 0 时删除历史 → batch / items 删除，records 不变
 *   CASE 7  批次不存在 → 撤销 / 删除历史 均 404
 *   CASE 8  普通单条删除记录 → mapping 清理原逻辑仍正常
 *   CASE 9  批量删除记录 → mapping 清理原逻辑仍正常
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')

// 隔离数据库：必须在使用任何 backend 模块之前设置环境变量
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'import-batch-mgmt-'))
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

const makeRow = (nickname, index) => ({
  time_cycle: '2026-W33',
  nickname,
  creator_type: '测试类型',
  total_cost: 100 + index,
  publish_date: '2026-08-20',
  first_play: 1000 + index,
  second_week_play: 2000 + index
})

async function main() {
  const recordsModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/records.js')).href
  )
  const importModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/importBatches.js')).href
  )
  const db = (await import(pathToFileURL(path.join(REPO_ROOT, 'backend/db.js')).href)).default

  const postBatchImport = getHandler(recordsModule.default, '/batch', 'post')
  const deleteRecord = getHandler(recordsModule.default, '/:id', 'delete')
  const postBatchDelete = getHandler(recordsModule.default, '/batch-delete', 'post')
  const getBatches = getHandler(importModule.default, '/batches', 'get')
  const getBatchDetail = getHandler(importModule.default, '/batches/:id', 'get')
  const postRollback = getHandler(importModule.default, '/batches/:id/rollback', 'post')
  const deleteHistory = getHandler(importModule.default, '/batches/:id', 'delete')

  check(
    '批次管理 handler 可用（rollback / delete history）',
    typeof postRollback === 'function' && typeof deleteHistory === 'function'
  )
  check(
    '原有用例所需 handler 可用（batch 导入 / 单条删除 / 批量删除 / 列表 / 详情）',
    typeof postBatchImport === 'function' &&
      typeof deleteRecord === 'function' &&
      typeof postBatchDelete === 'function' &&
      typeof getBatches === 'function' &&
      typeof getBatchDetail === 'function'
  )

  // 造数据：批次 A（2 条）、批次 B（2 条）、1 条手工记录
  const importBatch = async (fileName, count, itemCount = 1) => {
    const res = createRes()
    await postBatchImport(
      {
        body: {
          rows: Array.from({ length: count }, (_, i) => makeRow(`${fileName}#${i}`, i)),
          batch: {
            fileName,
            totalCount: count,
            failCount: 0,
            skipCount: 0,
            duplicateCount: 0,
            items: Array.from({ length: itemCount }, (_, i) => ({
              rowIndex: 10 + i,
              status: 'fail',
              reason: '时间周期不能为空'
            }))
          }
        }
      },
      res
    )
    return res.payload?.data
  }

  const batchA = await importBatch('__批次A.xlsx', 2, 2)
  const batchB = await importBatch('__批次B.xlsx', 2, 1)
  const manualInsert = db
    .prepare(
      "INSERT INTO creator_records (time_cycle, nickname, total_cost, publish_date) VALUES ('2026-W33', '__手工记录', 50, '2026-08-20')"
    )
    .run()
  const manualId = manualInsert.lastInsertRowid

  const countRecords = () => db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
  const countMappings = (batchId) =>
    db.prepare('SELECT COUNT(*) AS n FROM import_batch_records WHERE batch_id = ?').get(batchId).n
  const countItems = (batchId) =>
    db.prepare('SELECT COUNT(*) AS n FROM import_batch_items WHERE batch_id = ?').get(batchId).n
  const hasBatch = (batchId) =>
    db.prepare('SELECT COUNT(*) AS n FROM import_batches WHERE id = ?').get(batchId).n === 1
  const recordExists = (id) =>
    db.prepare('SELECT COUNT(*) AS n FROM creator_records WHERE id = ?').get(id).n === 1

  check(
    '前置数据就绪：A=2、B=2、手工=1，映射与行级日志齐全',
    batchA.count === 2 &&
      batchB.count === 2 &&
      countRecords() === 5 &&
      countMappings(batchA.batchId) === 2 &&
      countItems(batchA.batchId) === 2 &&
      countMappings(batchB.batchId) === 2 &&
      countItems(batchB.batchId) === 1,
    `records=${countRecords()}`
  )

  // 列表返回当前关联记录数（record_count），与 success_count 区分
  const listRes = createRes()
  await getBatches({ query: {} }, listRes)
  const listRowA = listRes.payload?.data?.list?.find((item) => item.id === batchA.batchId)
  check(
    '批次列表返回当前关联记录数 record_count（与 success_count 是两个概念）',
    listRowA?.record_count === 2 && listRowA?.success_count === 2,
    JSON.stringify(listRowA)
  )

  console.log('\n===== CASE 1：仍有关联记录时删除历史 → 409，且一切不变 =====')
  const beforeA = {
    records: countRecords(),
    mappings: countMappings(batchA.batchId),
    items: countItems(batchA.batchId),
    success: db.prepare('SELECT success_count AS n FROM import_batches WHERE id = ?').get(batchA.batchId).n
  }
  const delBlocked = createRes()
  await deleteHistory({ params: { id: String(batchA.batchId) } }, delBlocked)
  check(
    'CASE 1a：DELETE 历史 → 409 且给出明确提示',
    delBlocked.statusCode === 409 &&
      String(delBlocked.payload?.msg).includes('仍有关联投放记录，请先撤销导入'),
    `${delBlocked.statusCode} ${delBlocked.payload?.msg}`
  )
  check(
    'CASE 1b：被拒绝后 records / mappings / items / batch / success_count 全部不变',
    countRecords() === beforeA.records &&
      countMappings(batchA.batchId) === beforeA.mappings &&
      countItems(batchA.batchId) === beforeA.items &&
      hasBatch(batchA.batchId) &&
      db.prepare('SELECT success_count AS n FROM import_batches WHERE id = ?').get(batchA.batchId).n ===
        beforeA.success
  )

  console.log('\n===== CASE 2：撤销导入 batch A =====')
  const rollbackRes = createRes()
  await postRollback({ params: { id: String(batchA.batchId) } }, rollbackRes)
  check(
    'CASE 2a：撤销返回 200，deletedCount = 2',
    rollbackRes.statusCode === 200 && rollbackRes.payload?.data?.deletedCount === 2,
    JSON.stringify(rollbackRes.payload?.data)
  )
  check(
    'CASE 2b：A 的 2 条记录被删除、mappings 清理干净',
    !recordExists(batchA.ids[0]) &&
      !recordExists(batchA.ids[1]) &&
      countMappings(batchA.batchId) === 0,
    `mappings=${countMappings(batchA.batchId)}`
  )
  check(
    'CASE 2c：batch 与行级明细（items）保留，success_count 仍是历史值 2',
    hasBatch(batchA.batchId) &&
      countItems(batchA.batchId) === 2 &&
      db.prepare('SELECT success_count AS n FROM import_batches WHERE id = ?').get(batchA.batchId).n === 2
  )

  console.log('\n===== CASE 3：撤销 A 不得影响 B 与手工记录 =====')
  check(
    'CASE 3：B 的 2 条记录与 1 条手工记录都还在',
    batchB.ids.every((id) => recordExists(id)) &&
      recordExists(manualId) &&
      countMappings(batchB.batchId) === 2,
    `records=${countRecords()}`
  )

  console.log('\n===== CASE 4：部分记录已被手动删除时撤销 =====')
  const delOne = createRes()
  await deleteRecord({ params: { id: String(batchB.ids[0]) } }, delOne)
  const afterManualDelete = countMappings(batchB.batchId)
  const rollbackB = createRes()
  await postRollback({ params: { id: String(batchB.batchId) } }, rollbackB)
  check(
    'CASE 4a：手动删掉 1 条后映射只剩 1（原逻辑仍生效）',
    delOne.statusCode === 200 && afterManualDelete === 1,
    `mappings=${afterManualDelete}`
  )
  check(
    'CASE 4b：撤销只删当前仍存在的 1 条，不报错，mappings 归 0',
    rollbackB.statusCode === 200 &&
      rollbackB.payload?.data?.deletedCount === 1 &&
      countMappings(batchB.batchId) === 0 &&
      !recordExists(batchB.ids[1]),
    JSON.stringify(rollbackB.payload?.data)
  )
  check(
    'CASE 4c：历史 success_count 仍为 2（不因记录减少而改写）',
    db.prepare('SELECT success_count AS n FROM import_batches WHERE id = ?').get(batchB.batchId).n === 2
  )
  check(
    'CASE 4d：手工记录始终未被波及',
    recordExists(manualId) && countRecords() === 1
  )

  console.log('\n===== CASE 5：第二次撤销 =====')
  const rollbackAgain = createRes()
  await postRollback({ params: { id: String(batchB.batchId) } }, rollbackAgain)
  check(
    'CASE 5：不 500，返回 200 + deletedCount 0 + 友好提示',
    rollbackAgain.statusCode === 200 &&
      rollbackAgain.payload?.data?.deletedCount === 0 &&
      String(rollbackAgain.payload?.data?.message).includes('没有可撤销的投放记录'),
    `${rollbackAgain.statusCode} ${JSON.stringify(rollbackAgain.payload?.data)}`
  )

  console.log('\n===== CASE 6：mappings = 0 时删除历史 =====')
  const recordsBeforeDeleteHistory = countRecords()
  const delHistoryA = createRes()
  await deleteHistory({ params: { id: String(batchA.batchId) } }, delHistoryA)
  check(
    'CASE 6a：删除历史成功（batch 与 items 一并删除）',
    delHistoryA.statusCode === 200 &&
      !hasBatch(batchA.batchId) &&
      countItems(batchA.batchId) === 0 &&
      countMappings(batchA.batchId) === 0,
    JSON.stringify(delHistoryA.payload?.data)
  )
  check(
    'CASE 6b：删除历史绝不删除任何投放记录',
    countRecords() === recordsBeforeDeleteHistory && recordExists(manualId),
    `records=${countRecords()}`
  )

  console.log('\n===== CASE 7：不存在的批次 =====')
  const rollback404 = createRes()
  await postRollback({ params: { id: '999999' } }, rollback404)
  const delete404 = createRes()
  await deleteHistory({ params: { id: '999999' } }, delete404)
  check(
    'CASE 7：撤销 / 删除历史 均返回 404',
    rollback404.statusCode === 404 && delete404.statusCode === 404,
    `${rollback404.statusCode}/${delete404.statusCode}`
  )

  console.log('\n===== CASE 8 / 9：普通删除的 mapping 清理未退化 =====')
  const batchC = await importBatch('__批次C.xlsx', 2, 1)
  const delSingle = createRes()
  await deleteRecord({ params: { id: String(batchC.ids[0]) } }, delSingle)
  check(
    'CASE 8：单条删除记录 → mapping 同步清理，且批次日志保留',
    delSingle.statusCode === 200 &&
      db.prepare('SELECT COUNT(*) AS n FROM import_batch_records WHERE record_id = ?').get(batchC.ids[0]).n === 0 &&
      countMappings(batchC.batchId) === 1 &&
      hasBatch(batchC.batchId),
    `mappings=${countMappings(batchC.batchId)}`
  )
  const delBatchRes = createRes()
  await postBatchDelete({ body: { ids: [batchC.ids[1]] } }, delBatchRes)
  check(
    'CASE 9：批量删除记录 → mapping 同步清理，且批次日志保留',
    delBatchRes.payload?.data?.success === 1 &&
      countMappings(batchC.batchId) === 0 &&
      hasBatch(batchC.batchId) &&
      countItems(batchC.batchId) === 1
  )
  const delHistoryC = createRes()
  await deleteHistory({ params: { id: String(batchC.batchId) } }, delHistoryC)
  check(
    'CASE 9b：清理后删除历史成功（收尾，不再残留测试批次）',
    delHistoryC.statusCode === 200 && !hasBatch(batchC.batchId)
  )

  console.log('\n===== 无孤儿 mapping（record / batch 两侧）=====')
  check(
    '不存在指向已删除记录的孤儿 mapping',
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM import_batch_records m
         LEFT JOIN creator_records r ON r.id = m.record_id WHERE r.id IS NULL`
      )
      .get().n === 0
  )
  check(
    '不存在指向已删除批次的孤儿 mapping',
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM import_batch_records m
         LEFT JOIN import_batches b ON b.id = m.batch_id WHERE b.id IS NULL`
      )
      .get().n === 0
  )
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    process.exitCode = 1
  })
  .finally(() => {
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true })
    } catch {
      // 清理失败不影响测试结论
    }
    const total = passCount + failCount
    const rate = total ? ((passCount / total) * 100).toFixed(1) : '0.0'
    console.log('\n================ 测试汇总 ================')
    console.log(`用例总数：${total}　通过：${passCount}　失败：${failCount}　通过率：${rate}%`)
    if (failCount > 0) {
      console.log('\n失败用例：')
      failures.forEach((item) => console.log(`  - ${item}`))
    }
    process.exitCode = failCount > 0 ? 1 : 0
  })
