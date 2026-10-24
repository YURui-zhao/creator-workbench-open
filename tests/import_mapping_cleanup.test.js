#!/usr/bin/env node
/**
 * 导入批次映射清理测试（Batch 4B-2）
 *
 * 运行方式：node tests/import_mapping_cleanup.test.js
 * 特性：不启动服务、不打开浏览器；直接在内存里驱动 Express 路由 handler（假 req/res）
 * 隔离方式：通过 WORKBENCH_DB_PATH 指向临时数据库（必须先于 import backend/db.js 设置），
 *          单独运行或全量运行都不会连接真实 backend/workbench.db，结束后删除临时库。
 *
 * 说明：测试会真实写入 1 个自测批次 + 2 条投放记录，并在 finally 中完整清理，
 *      最后断言 creator_records / import_batches 恢复测试前状态。
 *
 * 覆盖：
 *   CASE 1  删除普通投放记录后，对应 import_batch_records 映射不残留（单条删除 + 批量删除）
 *   CASE 2  批次级写接口只有「撤销导入 / 删除历史」两个（Batch 6C 新增），且删除记录不会删除批次日志
 *   CASE 3  全库不存在孤儿 mapping（record 已删 / batch 已删）
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')

// 隔离数据库：必须在使用任何 backend 模块（backend/db.js）之前设置
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'import-mapping-cleanup-'))
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

function getHandler(router, routePath, method) {
  const layer = router.stack.find(
    (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
  )
  if (!layer) return null
  return layer.route.stack[layer.route.stack.length - 1].handle
}

const makeRow = (name) => ({
  time_cycle: '2026-W33',
  nickname: name,
  creator_type: '自测类型',
  total_cost: 100,
  publish_date: '2026-08-18',
  first_play: 1000,
  second_week_play: 2000
})

async function main() {
  const recordsModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/records.js')).href
  )
  const importModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/importBatches.js')).href
  )
  const db = (await import(pathToFileURL(path.join(REPO_ROOT, 'backend/db.js')).href)).default

  const recordsRouter = recordsModule.default
  const importRouter = importModule.default
  const postBatchImport = getHandler(recordsRouter, '/batch', 'post')
  const deleteRecord = getHandler(recordsRouter, '/:id', 'delete')
  const batchDelete = getHandler(recordsRouter, '/batch-delete', 'post')
  const getBatchDetail = getHandler(importRouter, '/batches/:id', 'get')

  check('导入 handler 可用（POST /records/batch）', typeof postBatchImport === 'function')
  check('单条删除 handler 可用（DELETE /records/:id）', typeof deleteRecord === 'function')
  check('批量删除 handler 可用（POST /records/batch-delete）', typeof batchDelete === 'function')
  check('批次详情 handler 可用（GET /import/batches/:id）', typeof getBatchDetail === 'function')

  console.log('\n===== CASE 2：批次级写接口清单（Batch 6C 新增两个动作）=====')
  // Batch 6C 起：批次级写操作只有「撤销导入」（POST /batches/:id/rollback）
  // 与「删除历史」（DELETE /batches/:id），且都必须保留 mapping 清理后的完整性
  const batchWriteRoutes = importRouter.stack
    .filter((item) => item.route && (item.route.methods?.delete || item.route.methods?.patch || item.route.methods?.post))
    .map((item) => `${Object.keys(item.route.methods)[0].toUpperCase()} ${item.route.path}`)
    .sort()
  check(
    'importBatches 只有「撤销导入 / 删除历史」两个写接口（无其它未预期写接口）',
    batchWriteRoutes.length === 2 &&
      batchWriteRoutes.includes('POST /batches/:id/rollback') &&
      batchWriteRoutes.includes('DELETE /batches/:id'),
    JSON.stringify(batchWriteRoutes)
  )
  const recordsDeleteIds = recordsRouter.stack
    .filter((item) => item.route && item.route.methods?.delete)
    .map((item) => item.route.path)
  check(
    '投放记录侧仍然只有 DELETE /records/:id 一个删除接口',
    recordsDeleteIds.includes('/:id') && recordsDeleteIds.length === 1,
    JSON.stringify(recordsDeleteIds)
  )

  const countOrphanByRecord = () =>
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM import_batch_records m
         LEFT JOIN creator_records r ON r.id = m.record_id
         WHERE r.id IS NULL`
      )
      .get().n
  const countOrphanByBatch = () =>
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM import_batch_records m
         LEFT JOIN import_batches b ON b.id = m.batch_id
         WHERE b.id IS NULL`
      )
      .get().n
  const countMappingOfRecord = (recordId) =>
    db.prepare('SELECT COUNT(*) AS n FROM import_batch_records WHERE record_id = ?').get(recordId).n

  console.log('\n===== 基线（测试前）=====')
  const baselineRecords = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
  const baselineBatches = db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n
  const baselineMappings = db.prepare('SELECT COUNT(*) AS n FROM import_batch_records').get().n
  console.log(
    `  creator_records=${baselineRecords}　import_batches=${baselineBatches}　import_batch_records=${baselineMappings}`
  )
  check('测试前不存在孤儿 mapping（record 侧）', countOrphanByRecord() === 0)
  check('测试前不存在孤儿 mapping（batch 侧）', countOrphanByBatch() === 0)

  const createdRecordIds = []
  let createdBatchId = null

  try {
    console.log('\n===== CASE 1a：单条删除记录后，映射不残留 =====')
    const importRes = createRes()
    await postBatchImport(
      {
        body: {
          rows: [makeRow('清理测试达人A'), makeRow('清理测试达人B')],
          batch: {
            fileName: '__清理测试批次.xlsx',
            totalCount: 2,
            failCount: 0,
            skipCount: 0,
            duplicateCount: 0,
            items: []
          }
        }
      },
      importRes
    )
    const importData = importRes.payload?.data || {}
    createdBatchId = importData.batchId
    createdRecordIds.push(...(importData.ids || []))
    check(
      '自测批次导入成功并写入 2 条记录 + 2 条映射',
      importRes.statusCode === 200 &&
        importData.count === 2 &&
        Number.isSafeInteger(createdBatchId) &&
        createdRecordIds.length === 2 &&
        db
          .prepare('SELECT COUNT(*) AS n FROM import_batch_records WHERE batch_id = ?')
          .get(createdBatchId).n === 2,
      JSON.stringify(importData)
    )

    const [firstRecordId, secondRecordId] = createdRecordIds
    const deleteRes = createRes()
    await deleteRecord({ params: { id: String(firstRecordId) } }, deleteRes)
    check('单条删除记录返回 200', deleteRes.statusCode === 200, JSON.stringify(deleteRes.payload))
    check(
      '删除记录后：该记录的 import mapping 不残留',
      countMappingOfRecord(firstRecordId) === 0,
      `mapping=${countMappingOfRecord(firstRecordId)}`
    )
    check(
      '另一条记录的映射仍在（未误删）',
      countMappingOfRecord(secondRecordId) === 1,
      `mapping=${countMappingOfRecord(secondRecordId)}`
    )
    check(
      '批次日志本身未被删除（删除记录 ≠ 撤销导入）',
      db.prepare('SELECT COUNT(*) AS n FROM import_batches WHERE id = ?').get(createdBatchId).n === 1
    )
    const detailRes = createRes()
    await getBatchDetail({ params: { id: String(createdBatchId) } }, detailRes)
    check(
      '批次详情 record_count 与映射数一致（1 条，不再是 2 条）',
      detailRes.payload?.data?.record_count === 1,
      String(detailRes.payload?.data?.record_count)
    )

    console.log('\n===== CASE 1b：批量删除记录后，映射不残留 =====')
    const batchDeleteRes = createRes()
    await batchDelete({ body: { ids: [secondRecordId] } }, batchDeleteRes)
    check(
      '批量删除成功 1 条',
      batchDeleteRes.payload?.data?.success === 1,
      JSON.stringify(batchDeleteRes.payload?.data)
    )
    check(
      '批量删除后：该记录的 import mapping 也不残留',
      countMappingOfRecord(secondRecordId) === 0,
      `mapping=${countMappingOfRecord(secondRecordId)}`
    )

    console.log('\n===== CASE 3：不存在孤儿 mapping =====')
    check('孤儿 mapping（record 已删）= 0', countOrphanByRecord() === 0, `count=${countOrphanByRecord()}`)
    check('孤儿 mapping（batch 已删）= 0', countOrphanByBatch() === 0, `count=${countOrphanByBatch()}`)
  } finally {
    console.log('\n===== 清理自测数据 =====')
    const cleanup = db.transaction(() => {
      if (createdBatchId) {
        db.prepare('DELETE FROM import_batch_records WHERE batch_id = ?').run(createdBatchId)
        db.prepare('DELETE FROM import_batch_items WHERE batch_id = ?').run(createdBatchId)
        db.prepare('DELETE FROM import_batches WHERE id = ?').run(createdBatchId)
      }
      for (const recordId of createdRecordIds) {
        db.prepare('DELETE FROM creator_records WHERE id = ?').run(recordId)
      }
    })
    cleanup()
    check(
      `creator_records 恢复基线（${baselineRecords} 条）`,
      db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n === baselineRecords
    )
    check(
      `import_batches 恢复基线（${baselineBatches} 条）`,
      db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n === baselineBatches
    )
    check(
      `import_batch_records 恢复基线（${baselineMappings} 条）`,
      db.prepare('SELECT COUNT(*) AS n FROM import_batch_records').get().n === baselineMappings
    )
  }

  const total = passCount + failCount
  const rate = total ? ((passCount / total) * 100).toFixed(1) : '0.0'
  console.log('\n================ 测试汇总 ================')
  console.log(`用例总数：${total}　通过：${passCount}　失败：${failCount}　通过率：${rate}%`)
  if (failures.length) {
    console.log('\n失败用例：')
    failures.forEach((item) => console.log(`  - ${item}`))
  }
  process.exitCode = failCount ? 1 : 0
}

main().catch((err) => {
  console.error('测试执行异常：', err)
  process.exitCode = 1
}).finally(() => {
  // 清理隔离数据库（含 WAL / SHM），真实库始终未被触碰
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    // 清理失败不影响测试结论
  }
})
