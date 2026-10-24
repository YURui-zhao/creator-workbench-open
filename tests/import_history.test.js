#!/usr/bin/env node
/**
 * 导入历史（批次日志）回归测试
 *
 * 运行方式：node tests/import_history.test.js
 * 特性：不启动服务、不打开浏览器；直接在内存里驱动 Express 路由 handler（假 req/res）
 * 隔离方式：通过 WORKBENCH_DB_PATH 指向临时数据库（必须先于 import backend/db.js 设置），
 *          单独运行或全量运行都不会连接真实 backend/workbench.db，结束后删除临时库。
 *
 * 说明：测试会真实写入 3 个自测批次与其投放记录，并在 finally 中完整清理，
 *      最后断言 creator_records 与 import_batches 恢复测试前状态。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')

// 隔离数据库：必须在使用任何 backend 模块（backend/db.js）之前设置
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'import-history-'))
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

async function main() {
  const recordsModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/records.js')).href
  )
  const importModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/importBatches.js')).href
  )
  const db = (await import(pathToFileURL(path.join(REPO_ROOT, 'backend/db.js')).href)).default

  const postBatchImport = getHandler(recordsModule.default, '/batch', 'post')
  const getRecords = getHandler(recordsModule.default, '/', 'get')
  const getBatches = getHandler(importModule.default, '/batches', 'get')
  const getBatchDetail = getHandler(importModule.default, '/batches/:id', 'get')

  check('导入接口 handler 可用', typeof postBatchImport === 'function')
  check('投放记录列表 handler 可用', typeof getRecords === 'function')
  check('批次列表 handler 可用', typeof getBatches === 'function')
  check('批次详情 handler 可用', typeof getBatchDetail === 'function')

  // 基线（用于最后断言数据未受影响）
  const baselineRecords = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
  const baselineBatches = db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n
  console.log(`\n基线：creator_records=${baselineRecords} 条，import_batches=${baselineBatches} 条\n`)

  const createdBatchIds = []
  const createdRecordIds = []

  const makeRow = (name, week = '2026-W33') => ({
    time_cycle: week,
    nickname: name,
    creator_type: '自测类型',
    total_cost: 100,
    publish_date: '2026-08-18',
    first_play: 1000,
    second_week_play: 2000
  })

  try {
    console.log('===== 1. 模拟导入 3 批测试数据，验证批次记录写入 =====')
    const batchPlans = [
      {
        fileName: '__自测批次1.xlsx',
        rows: [makeRow('批次1达人A'), makeRow('批次1达人B')],
        batch: {
          fileName: '__自测批次1.xlsx',
          totalCount: 5,
          failCount: 2,
          skipCount: 1,
          duplicateCount: 0,
          items: [
            { rowIndex: 3, status: 'fail', reason: '总花费必须为非负数字' },
            { rowIndex: 4, status: 'fail', reason: '时间周期不能为空' },
            { rowIndex: 5, status: 'skip', reason: '空白行自动跳过' }
          ]
        }
      },
      {
        fileName: '__自测批次2.xlsx',
        rows: [makeRow('批次2达人A')],
        batch: {
          fileName: '__自测批次2.xlsx',
          totalCount: 3,
          failCount: 1,
          skipCount: 0,
          duplicateCount: 1,
          items: [
            { rowIndex: 2, status: 'duplicate', reason: '与已有记录重复' },
            { rowIndex: 3, status: 'fail', reason: 'AI识别失败：无法解析该时间周期写法' }
          ]
        }
      },
      {
        fileName: '__自测批次3.xlsx',
        rows: [makeRow('批次3达人A'), makeRow('批次3达人B'), makeRow('批次3达人C')],
        batch: { fileName: '__自测批次3.xlsx', totalCount: 3, failCount: 0, skipCount: 0, duplicateCount: 0, items: [] }
      }
    ]

    for (const [index, plan] of batchPlans.entries()) {
      const res = createRes()
      await postBatchImport({ body: { rows: plan.rows, batch: plan.batch } }, res)
      const data = res.payload?.data || {}
      check(
        `第 ${index + 1} 批导入成功并返回批次 ID`,
        res.statusCode === 200 && data.count === plan.rows.length && Number.isSafeInteger(data.batchId),
        JSON.stringify(data)
      )
      createdBatchIds.push(data.batchId)
      createdRecordIds.push(...(data.ids || []))
    }

    const batchRows = createdBatchIds.map((id) =>
      db.prepare('SELECT * FROM import_batches WHERE id = ?').get(id)
    )
    check('批次日志写入 3 条', batchRows.length === 3 && batchRows.every(Boolean))
    check(
      '批次1 统计正确（成功2/失败2/跳过1/重复0/总数5）',
      batchRows[0].success_count === 2 &&
        batchRows[0].fail_count === 2 &&
        batchRows[0].skip_count === 1 &&
        batchRows[0].duplicate_count === 0 &&
        batchRows[0].total_count === 5,
      JSON.stringify(batchRows[0])
    )
    check(
      '批次2 统计正确（成功1/失败1/重复1）',
      batchRows[1].success_count === 1 &&
        batchRows[1].fail_count === 1 &&
        batchRows[1].duplicate_count === 1,
      JSON.stringify(batchRows[1])
    )
    check(
      '文件名与创建时间已记录',
      batchRows[2].file_name === '__自测批次3.xlsx' && Boolean(batchRows[2].created_at),
      `${batchRows[2].file_name} @ ${batchRows[2].created_at}`
    )
    const itemCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM import_batch_items WHERE batch_id IN (${createdBatchIds.map(() => '?').join(',')})`
      )
      .get(...createdBatchIds).n
    check('行级明细写入正确（3+2+0=5 条）', itemCount === 5, `items=${itemCount}`)
    const mappingCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM import_batch_records WHERE batch_id IN (${createdBatchIds.map(() => '?').join(',')})`
      )
      .get(...createdBatchIds).n
    check('批次-记录关联写入正确（2+1+3=6 条）', mappingCount === 6, `mappings=${mappingCount}`)

    console.log('\n===== 2. 批次列表：分页 + 时间范围筛选 =====')
    const listRes = createRes()
    await getBatches({ query: { page: 1, pageSize: 2 } }, listRes)
    const listData = listRes.payload?.data || {}
    check(
      '分页返回 2 条且 total >= 3',
      listRes.statusCode === 200 && listData.list?.length === 2 && listData.total >= 3,
      `list=${listData.list?.length} total=${listData.total}`
    )
    check(
      '按创建时间倒序（最新批次在最前）',
      listData.list?.[0]?.id === createdBatchIds[2] && listData.list?.[1]?.id === createdBatchIds[1],
      JSON.stringify(listData.list?.map((item) => item.id))
    )
    const page2Res = createRes()
    await getBatches({ query: { page: 2, pageSize: 2 } }, page2Res)
    check(
      '第 2 页返回第 3 条批次',
      page2Res.payload?.data?.list?.some((item) => item.id === createdBatchIds[0]),
      JSON.stringify(page2Res.payload?.data?.list?.map((item) => item.id))
    )
    const today = new Date().toISOString().slice(0, 10)
    const rangeRes = createRes()
    await getBatches({ query: { page: 1, pageSize: 10, startDate: today, endDate: today } }, rangeRes)
    check(
      '时间范围筛选（今天）能命中自测批次',
      (rangeRes.payload?.data?.list || []).filter((item) => createdBatchIds.includes(item.id)).length === 3,
      `命中 ${(rangeRes.payload?.data?.list || []).filter((i) => createdBatchIds.includes(i.id)).length} 条`
    )
    const emptyRangeRes = createRes()
    await getBatches({ query: { page: 1, pageSize: 10, startDate: '1999-01-01', endDate: '1999-01-02' } }, emptyRangeRes)
    check('时间范围无数据时返回空列表', emptyRangeRes.payload?.data?.list?.length === 0)
    const badRangeRes = createRes()
    await getBatches({ query: { startDate: '2026/01/01' } }, badRangeRes)
    check('非法日期参数返回 400', badRangeRes.statusCode === 400, badRangeRes.payload?.msg)
    const badPageRes = createRes()
    await getBatches({ query: { page: 0 } }, badPageRes)
    check('非法分页参数返回 400', badPageRes.statusCode === 400, badPageRes.payload?.msg)

    console.log('\n===== 3. 批次详情 + 按批次筛选投放记录 =====')
    const detailRes = createRes()
    await getBatchDetail({ params: { id: String(createdBatchIds[0]) } }, detailRes)
    const detail = detailRes.payload?.data || {}
    check(
      '批次详情返回统计与 3 条行级明细',
      detail.batch?.id === createdBatchIds[0] && detail.items?.length === 3,
      `items=${detail.items?.length}`
    )
    check('详情包含该批次的 2 条投放记录', detail.record_count === 2 && detail.records?.length === 2)
    check(
      '行级明细含失败/跳过状态与原因',
      detail.items?.some((item) => item.status === 'fail' && item.reason) &&
        detail.items?.some((item) => item.status === 'skip'),
      JSON.stringify(detail.items?.map((item) => `${item.row_index}:${item.status}`))
    )

    const filterRes = createRes()
    await getRecords({ query: { batch_id: String(createdBatchIds[0]), page: 1, pageSize: 10 } }, filterRes)
    const filtered = filterRes.payload?.data || {}
    check(
      '按批次筛选投放记录：仅返回该批次 2 条',
      filtered.total === 2 && filtered.list?.every((row) => row.nickname.startsWith('批次1达人')),
      `total=${filtered.total}`
    )
    const filterCamelRes = createRes()
    await getRecords({ query: { batchId: String(createdBatchIds[2]), page: 1, pageSize: 10 } }, filterCamelRes)
    check(
      'batchId 驼峰参数同样生效（3 条）',
      filterCamelRes.payload?.data?.total === 3,
      `total=${filterCamelRes.payload?.data?.total}`
    )
    const badFilterRes = createRes()
    await getRecords({ query: { batch_id: 'abc' } }, badFilterRes)
    check('非法 batch_id 返回 400', badFilterRes.statusCode === 400, badFilterRes.payload?.msg)
    const notFoundRes = createRes()
    await getBatchDetail({ params: { id: '99999999' } }, notFoundRes)
    check('不存在的批次返回 404', notFoundRes.statusCode === 404, notFoundRes.payload?.msg)
    const badIdRes = createRes()
    await getBatchDetail({ params: { id: 'abc' } }, badIdRes)
    check('非法批次 ID 返回 400', badIdRes.statusCode === 400, badIdRes.payload?.msg)

    console.log('\n===== 4. 原有导入流程兼容（数组请求体，不写批次日志）=====')
    const legacyRes = createRes()
    await postBatchImport({ body: [makeRow('兼容测试达人')] }, legacyRes)
    const legacyData = legacyRes.payload?.data || {}
    check(
      '旧调用方式仍返回 { count } 且不写批次',
      legacyRes.statusCode === 200 && legacyData.count === 1 && legacyData.batchId === null,
      JSON.stringify(legacyData)
    )
    createdRecordIds.push(...(legacyData.ids || []))
  } finally {
    console.log('\n===== 5. 清理自测数据 =====')
    const cleanup = db.transaction(() => {
      for (const batchId of createdBatchIds) {
        db.prepare('DELETE FROM import_batch_records WHERE batch_id = ?').run(batchId)
        db.prepare('DELETE FROM import_batch_items WHERE batch_id = ?').run(batchId)
        db.prepare('DELETE FROM import_batches WHERE id = ?').run(batchId)
      }
      for (const recordId of createdRecordIds) {
        db.prepare('DELETE FROM creator_records WHERE id = ?').run(recordId)
      }
    })
    cleanup()
    const finalRecords = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
    const finalBatches = db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n
    check(
      `creator_records 恢复基线（${baselineRecords} 条）`,
      finalRecords === baselineRecords,
      `当前 ${finalRecords} 条`
    )
    check(
      `import_batches 恢复基线（${baselineBatches} 条）`,
      finalBatches === baselineBatches,
      `当前 ${finalBatches} 条`
    )
  }

  const total = passCount + failCount
  const rate = total ? ((passCount / total) * 100).toFixed(1) : '0.0'
  console.log('\n================ 测试汇总 ================')
  console.log(`用例总数：${total}　通过：${passCount}　失败：${failCount}　通过率：${rate}%`)
  if (failCount > 0) {
    console.log('\n失败用例：')
    failures.forEach((item) => console.log(` - ${item}`))
  }
  process.exitCode = failCount > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('测试执行异常：', error)
  process.exitCode = 1
}).finally(() => {
  // 清理隔离数据库（含 WAL / SHM），真实库始终未被触碰
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    // 清理失败不影响测试结论
  }
})
