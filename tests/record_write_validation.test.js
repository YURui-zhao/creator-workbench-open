#!/usr/bin/env node
/**
 * 投放记录写入校验测试（Batch 5A）
 *
 * 运行方式：node tests/record_write_validation.test.js
 * 特性：不启动服务、不打开浏览器；直接在内存里驱动 Express 路由 handler（假 req/res）
 * 隔离方式：通过 WORKBENCH_DB_PATH 指向临时数据库（必须先于 import backend/db.js 设置），
 *          单独运行或全量运行都不会连接真实 backend/workbench.db，结束后删除临时库。
 *
 * 说明：测试会真实写入自测记录，并在 finally 中完整清理，
 *      最后断言 creator_records 恢复测试前基线（不污染真实 12 条数据）。
 *
 * 覆盖：POST 单条、PUT 部分更新（最终状态交叉校验 / 未传 vs null vs 0）、batch 批量。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')
// 隔离数据库：必须在使用任何 backend 模块（backend/db.js）之前设置
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'record-write-validation-'))
process.env.WORKBENCH_DB_PATH = path.join(TMP_DIR, 'isolated.db')

const PLAY_RANGE_ERROR = '累计播放量不能小于7日播放量，请检查数据是否录入正确'

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

async function main() {
  const recordsModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/records.js')).href
  )
  const db = (await import(pathToFileURL(path.join(REPO_ROOT, 'backend/db.js')).href)).default
  const router = recordsModule.default

  const postCreate = getHandler(router, '/', 'post')
  const putRecord = getHandler(router, '/:id', 'put')
  const postBatch = getHandler(router, '/batch', 'post')
  const postBatchUpdate = getHandler(router, '/batch-update', 'post')
  check(
    '写接口 handler 可用（POST / PUT / batch / batch-update）',
    typeof postCreate === 'function' &&
      typeof putRecord === 'function' &&
      typeof postBatch === 'function' &&
      typeof postBatchUpdate === 'function'
  )

  const baselineCount = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
  console.log(`\n基线：creator_records = ${baselineCount} 条`)
  const createdIds = []

  let seq = 0
  const uniqueNickname = () => `__写入校验达人${Date.now()}_${(seq += 1)}`
  const basePayload = (overrides = {}) => ({
    time_cycle: '2026-W33',
    nickname: uniqueNickname(),
    creator_type: '自测类型',
    total_cost: 1000,
    publish_date: '2026-08-20',
    ...overrides
  })
  const getRow = (id) =>
    db
      .prepare(
        `SELECT id, nickname, homepage, content_link, video_link, total_cost,
                publish_date, first_play, second_week_play
         FROM creator_records WHERE id = ?`
      )
      .get(id)

  const create = async (overrides) => {
    const res = createRes()
    await postCreate({ body: basePayload(overrides) }, res)
    const row = res.payload?.data
    if (row?.id) createdIds.push(row.id)
    return { status: res.statusCode, row, msg: res.payload?.msg }
  }
  const put = async (id, body) => {
    const res = createRes()
    await putRecord({ params: { id: String(id) }, body }, res)
    return { status: res.statusCode, data: res.payload?.data, msg: res.payload?.msg }
  }
  const batchUpdate = async (ids, field, value) => {
    const res = createRes()
    await postBatchUpdate({ body: { ids, field, value } }, res)
    return { status: res.statusCode, data: res.payload?.data, msg: res.payload?.msg }
  }

  try {
    console.log('\n===== POST 单条创建 =====')
    const p1 = await create({ first_play: 10000, second_week_play: 20000 })
    check(
      'CASE 1：10000 / 20000 → 成功且写入正确',
      p1.status === 200 && p1.row?.first_play === 10000 && p1.row?.second_week_play === 20000,
      JSON.stringify(p1.row)
    )
    const p2 = await create({ first_play: 0, second_week_play: 25600 })
    check(
      'CASE 2：0 / 25600 → 成功（0 是真实值，不是缺失）',
      p2.status === 200 && p2.row?.first_play === 0 && p2.row?.second_week_play === 25600,
      JSON.stringify(p2.row)
    )
    const p3 = await create({ first_play: 0, second_week_play: 0 })
    check(
      'CASE 3：0 / 0 → 成功',
      p3.status === 200 && p3.row?.first_play === 0 && p3.row?.second_week_play === 0,
      JSON.stringify(p3.row)
    )
    const p4 = await create({ first_play: 10000, second_week_play: null })
    check(
      'CASE 4：10000 / null → 成功且累计播放量为 NULL',
      p4.status === 200 && p4.row?.first_play === 10000 && p4.row?.second_week_play === null,
      JSON.stringify(p4.row)
    )
    const p5 = await create({ first_play: null, second_week_play: 5000 })
    check(
      'CASE 5：null / 5000 → 成功且 7日播放量为 NULL',
      p5.status === 200 && p5.row?.first_play === null && p5.row?.second_week_play === 5000,
      JSON.stringify(p5.row)
    )
    const p6 = await create({ first_play: 10000, second_week_play: 5000 })
    check(
      'CASE 6：10000 / 5000 → 4xx 拒绝 + 统一文案',
      p6.status === 400 && p6.msg === PLAY_RANGE_ERROR,
      `${p6.status} ${p6.msg}`
    )
    const p7a = await create({ first_play: -1, second_week_play: 100 })
    check(
      'CASE 7a：7日播放量负数 → 4xx 拒绝 + 明确原因',
      p7a.status === 400 && String(p7a.msg).includes('7日播放量必须为非负整数'),
      `${p7a.status} ${p7a.msg}`
    )
    const p7b = await create({ first_play: 100, second_week_play: -5 })
    check(
      'CASE 7b：累计播放量负数 → 4xx 拒绝 + 明确原因',
      p7b.status === 400 && String(p7b.msg).includes('累计播放量必须为非负整数'),
      `${p7b.status} ${p7b.msg}`
    )
    check(
      '非法请求都没有写库（仅 CASE 1~5 成功）',
      createdIds.length === 5,
      `created=${createdIds.length}`
    )

    console.log('\n===== PUT 部分更新（基于最终状态校验）=====')
    const recA = await create({ first_play: 10000, second_week_play: 20000 })
    const idA = recA.row.id

    const u8 = await put(idA, { first_play: 30000 })
    check(
      'CASE 8：只传 first=30000（库里 latest=20000）→ 拒绝',
      u8.status === 400 && u8.msg === PLAY_RANGE_ERROR,
      `${u8.status} ${u8.msg}`
    )
    check(
      'CASE 8 补充：拒绝后数据库未被修改',
      getRow(idA).first_play === 10000 && getRow(idA).second_week_play === 20000
    )

    const u9 = await put(idA, { second_week_play: 30000 })
    check(
      'CASE 9：只把 latest 改为 30000 → 成功',
      u9.status === 200 && getRow(idA).second_week_play === 30000 && getRow(idA).first_play === 10000,
      JSON.stringify(getRow(idA))
    )

    const u10 = await put(idA, { second_week_play: null })
    check(
      'CASE 10：latest 数字 → null → 成功且真实写 NULL（不回退到 first）',
      u10.status === 200 && getRow(idA).second_week_play === null && getRow(idA).first_play === 10000,
      JSON.stringify(getRow(idA))
    )

    const u11 = await put(idA, { first_play: null })
    check(
      'CASE 11：first 数字 → null → 成功且真实写 NULL',
      u11.status === 200 && getRow(idA).first_play === null && getRow(idA).second_week_play === null,
      JSON.stringify(getRow(idA))
    )

    const u12 = await put(idA, { first_play: 0 })
    check(
      'CASE 12：first=0 → 真实写 0（不被当成未传）',
      u12.status === 200 && getRow(idA).first_play === 0,
      JSON.stringify(getRow(idA))
    )

    const u13a = await put(idA, { second_week_play: 0 })
    check(
      'CASE 13a：first=0 / latest=0 → 合法且写 0',
      u13a.status === 200 && getRow(idA).second_week_play === 0,
      JSON.stringify(getRow(idA))
    )
    const u13b = await put(idA, { first_play: 10000, second_week_play: 0 })
    check(
      'CASE 13b：first=10000 / latest=0 → 拒绝（0 不能被当成未传 / 忽略）',
      u13b.status === 400 && u13b.msg === PLAY_RANGE_ERROR,
      `${u13b.status} ${u13b.msg}`
    )

    const before14 = getRow(idA)
    const u14 = await put(idA, {})
    check(
      'CASE 14：空请求体 → 保持旧值不变',
      u14.status === 200 &&
        getRow(idA).first_play === before14.first_play &&
        getRow(idA).second_week_play === before14.second_week_play &&
        getRow(idA).nickname === before14.nickname,
      JSON.stringify(getRow(idA))
    )

    const recC = await create({
      first_play: 100,
      second_week_play: 200,
      homepage: 'https://www.douyin.com/user/before-clear',
      content_link: 'https://www.zhihu.com/question/1/answer/2',
      video_link: 'https://v.douyin.com/before-clear/'
    })
    const u15 = await put(recC.row.id, { video_link: null })
    check(
      'CASE 15a：video_link=null → 真实写 NULL',
      u15.status === 200 && getRow(recC.row.id).video_link === null,
      JSON.stringify(getRow(recC.row.id))
    )
    const u15b = await put(recC.row.id, { homepage: '', content_link: null })
    check(
      'CASE 15b：homepage=""（空串）与 content_link=null 都能清空为 NULL',
      u15b.status === 200 &&
        getRow(recC.row.id).homepage === null &&
        getRow(recC.row.id).content_link === null,
      JSON.stringify(getRow(recC.row.id))
    )

    const uExtra1 = await put(recC.row.id, { nickname: null })
    const uExtra2 = await put(recC.row.id, { nickname: '' })
    check(
      '必填字段保护：nickname=null / nickname="" 都被拒绝且未被清空',
      uExtra1.status === 400 &&
        uExtra2.status === 400 &&
        getRow(recC.row.id).nickname === recC.row.nickname,
      `${uExtra1.status}/${uExtra2.status} nickname=${getRow(recC.row.id).nickname}`
    )

    const recD = await create({ first_play: 100, second_week_play: 200, total_cost: 0 })
    const uTotalCost = await put(recD.row.id, { total_cost: 0 })
    check(
      'total_cost = 0 不被误判为「没传」（写入真实 0）',
      uTotalCost.status === 200 && getRow(recD.row.id).total_cost === 0,
      JSON.stringify(getRow(recD.row.id))
    )

    console.log('\n===== total_cost 必填规则（与 Excel 导入 / 前端表单一致）=====')
    const postRaw = async (body) => {
      const res = createRes()
      await postCreate({ body }, res)
      const row = res.payload?.data
      if (row?.id) createdIds.push(row.id)
      return { status: res.statusCode, row, msg: res.payload?.msg }
    }
    const COST_EMPTY_MSG = '总花费不能为空'

    const costMissing = await postRaw({ time_cycle: '2026-W33', nickname: uniqueNickname() })
    check(
      'COST-1：POST 缺 total_cost → 400「总花费不能为空」',
      costMissing.status === 400 && String(costMissing.msg).includes(COST_EMPTY_MSG),
      `${costMissing.status} ${costMissing.msg}`
    )

    const costNull = await postRaw({
      time_cycle: '2026-W33',
      nickname: uniqueNickname(),
      total_cost: null
    })
    check(
      'COST-2：POST total_cost=null → 400',
      costNull.status === 400 && String(costNull.msg).includes(COST_EMPTY_MSG),
      `${costNull.status} ${costNull.msg}`
    )

    const costEmpty = await postRaw({
      time_cycle: '2026-W33',
      nickname: uniqueNickname(),
      total_cost: ''
    })
    check(
      'COST-2b：POST total_cost="" → 400',
      costEmpty.status === 400 && String(costEmpty.msg).includes(COST_EMPTY_MSG),
      `${costEmpty.status} ${costEmpty.msg}`
    )

    const costZero = await postRaw({
      time_cycle: '2026-W33',
      nickname: uniqueNickname(),
      total_cost: 0
    })
    check(
      'COST-3：POST total_cost=0 → 成功且数据库真实保存 0',
      costZero.status === 200 && getRow(costZero.row?.id)?.total_cost === 0,
      JSON.stringify(getRow(costZero.row?.id))
    )

    // PUT：以刚创建的 total_cost=0 记录作为「最终状态」对象
    const costRecordId = costZero.row.id
    const putNoCost = await put(costRecordId, { creator_type: '只改类型不传花费' })
    check(
      'COST-4：PUT 不传 total_cost → 成功且原值保持 0',
      putNoCost.status === 200 && getRow(costRecordId).total_cost === 0,
      JSON.stringify(getRow(costRecordId))
    )

    const putCostNull = await put(costRecordId, { total_cost: null })
    check(
      'COST-5：PUT total_cost=null → 400 且原值保持 0',
      putCostNull.status === 400 &&
        String(putCostNull.msg).includes(COST_EMPTY_MSG) &&
        getRow(costRecordId).total_cost === 0,
      `${putCostNull.status} ${putCostNull.msg}`
    )

    const putCostEmpty = await put(costRecordId, { total_cost: '' })
    check(
      'COST-6：PUT total_cost="" → 400 且原值保持 0',
      putCostEmpty.status === 400 &&
        String(putCostEmpty.msg).includes(COST_EMPTY_MSG) &&
        getRow(costRecordId).total_cost === 0,
      `${putCostEmpty.status} ${putCostEmpty.msg}`
    )

    const recCost = await create({ total_cost: 5000 })
    const putCostZero = await put(recCost.row.id, { total_cost: 0 })
    check(
      'COST-7：PUT total_cost=0 → 成功且数据库真实保存 0',
      putCostZero.status === 200 && getRow(recCost.row.id).total_cost === 0,
      JSON.stringify(getRow(recCost.row.id))
    )

    console.log('\n===== 时间周期 与 发布日期 一致性（Batch 6A-2 后端保护）=====')
    const cycleOf = (id) =>
      db.prepare('SELECT time_cycle FROM creator_records WHERE id = ?').get(id)?.time_cycle
    const CYCLE_DATE_MSG = '时间周期与发布日期所属周不一致'

    const postCycleMismatch = await postRaw({
      time_cycle: '2026-W34',
      nickname: uniqueNickname(),
      total_cost: 1000,
      publish_date: '2026-09-03'
    })
    check(
      'CYCLE-1：POST 周期与发布日期不一致 → 400（不依赖前端即可拦截）',
      postCycleMismatch.status === 400 && String(postCycleMismatch.msg).includes(CYCLE_DATE_MSG),
      `${postCycleMismatch.status} ${postCycleMismatch.msg}`
    )
    check(
      'CYCLE-1b：拒绝提示给出「正确的周」= 2026-W35（08/31 ~ 09/06），不再误导为 08/24-08/30',
      String(postCycleMismatch.msg).includes('2026-W35') &&
        String(postCycleMismatch.msg).includes('2026-08-31 ~ 2026-09-06') &&
        !String(postCycleMismatch.msg).includes('2026-08-24'),
      postCycleMismatch.msg
    )

    const postCycleMatch = await postRaw({
      time_cycle: '2026-W35',
      nickname: uniqueNickname(),
      total_cost: 1000,
      publish_date: '2026-09-03'
    })
    check(
      'CYCLE-2：POST 周期 = 发布日期所属标准周 → 成功',
      postCycleMatch.status === 200 && cycleOf(postCycleMatch.row?.id) === '2026-W35',
      `${postCycleMatch.status} ${cycleOf(postCycleMatch.row?.id)}`
    )

    const cycleRecordId = postCycleMatch.row.id
    const putDateMismatch = await put(cycleRecordId, { publish_date: '2026-09-08' })
    check(
      'CYCLE-3：PUT 只改发布日期（最终状态冲突）→ 400 且原值不变',
      putDateMismatch.status === 400 && cycleOf(cycleRecordId) === '2026-W35',
      `${putDateMismatch.status} ${cycleOf(cycleRecordId)}`
    )

    const putCycleMismatch = await put(cycleRecordId, { time_cycle: '2026-W34' })
    check(
      'CYCLE-4：PUT 只改周期为不匹配的周 → 400 且原值不变',
      putCycleMismatch.status === 400 && cycleOf(cycleRecordId) === '2026-W35',
      `${putCycleMismatch.status} ${cycleOf(cycleRecordId)}`
    )

    const putBothMatch = await put(cycleRecordId, {
      publish_date: '2026-09-08',
      time_cycle: '2026-W36'
    })
    check(
      'CYCLE-5：PUT 同时改日期与周期且一致 → 成功',
      putBothMatch.status === 200 && cycleOf(cycleRecordId) === '2026-W36',
      `${putBothMatch.status} ${cycleOf(cycleRecordId)}`
    )

    const putNoDate = await put(cycleRecordId, { publish_date: null })
    const putManualCycle = await put(cycleRecordId, { time_cycle: '2026-W20' })
    check(
      'CYCLE-6：发布日期为空时周期允许人工指定（不做日期归属校验）',
      putNoDate.status === 200 &&
        putManualCycle.status === 200 &&
        cycleOf(cycleRecordId) === '2026-W20',
      `${putNoDate.status}/${putManualCycle.status} ${cycleOf(cycleRecordId)}`
    )

    // ---- batch-update 批量改周期：必须逐条按最终状态满足日期归属（堵住绕过口）----
    const cycleBatchRecord = await postRaw({
      time_cycle: '2026-W35',
      nickname: uniqueNickname(),
      total_cost: 1000,
      publish_date: '2026-09-03'
    })
    const cycleBatchId = cycleBatchRecord.row.id
    const buMismatch = await batchUpdate([cycleBatchId], 'time_cycle', '08/24-08/30')
    check(
      'CYCLE-BU-1：batch-update 把 09/03 的记录改成 08/24-08/30 → 拒绝，且不写入错误周期',
      buMismatch.status === 200 &&
        buMismatch.data?.successCount === 0 &&
        buMismatch.data?.failCount === 1 &&
        String(buMismatch.data?.failList?.[0]?.reason).includes(CYCLE_DATE_MSG) &&
        cycleOf(cycleBatchId) === '2026-W35',
      `${buMismatch.status} ${JSON.stringify(buMismatch.data)} cycle=${cycleOf(cycleBatchId)}`
    )
    const buMatch = await batchUpdate([cycleBatchId], 'time_cycle', '08/31-09/06')
    check(
      'CYCLE-BU-2：batch-update 改成 08/31-09/06（= 09/03 的标准周）→ 成功',
      buMatch.status === 200 &&
        buMatch.data?.successCount === 1 &&
        buMatch.data?.failCount === 0 &&
        cycleOf(cycleBatchId) === '2026-W35',
      `${buMatch.status} ${JSON.stringify(buMatch.data)} cycle=${cycleOf(cycleBatchId)}`
    )
    // 无发布日期的记录不受日期归属限制（仍可人工指定周期）
    const buNoDate = await batchUpdate([cycleRecordId], 'time_cycle', '2026-W34')
    check(
      'CYCLE-BU-3：无发布日期的记录仍可批量改周期（不做日期归属校验）',
      buNoDate.status === 200 &&
        buNoDate.data?.successCount === 1 &&
        cycleOf(cycleRecordId) === '2026-W34',
      `${buNoDate.status} ${JSON.stringify(buNoDate.data)} cycle=${cycleOf(cycleRecordId)}`
    )

    const countBeforeCycleBatch = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
    const batchCycleRes = createRes()
    await postBatch(
      { body: [basePayload({ time_cycle: '2026-W34', publish_date: '2026-09-03' })] },
      batchCycleRes
    )
    check(
      'CYCLE-BATCH：batch 行周期错配 → 400 + 行号，且不写库',
      batchCycleRes.statusCode === 400 &&
        String(batchCycleRes.payload?.msg).includes('第 1 条数据校验失败') &&
        String(batchCycleRes.payload?.msg).includes(CYCLE_DATE_MSG) &&
        db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n === countBeforeCycleBatch,
      `${batchCycleRes.statusCode} ${batchCycleRes.payload?.msg}`
    )

    console.log('\n===== BATCH 批量导入 =====')
    const countBeforeBatch = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
    const batchBadRes = createRes()
    await postBatch(
      { body: [basePayload({ first_play: 10000, second_week_play: 5000 })] },
      batchBadRes
    )
    check(
      'CASE 16：batch 非法行（10000 / 5000）→ 4xx + 行号 + 统一文案，且不写库',
      batchBadRes.statusCode === 400 &&
        String(batchBadRes.payload?.msg).includes('第 1 条数据校验失败') &&
        String(batchBadRes.payload?.msg).includes(PLAY_RANGE_ERROR) &&
        db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n === countBeforeBatch,
      `${batchBadRes.statusCode} ${batchBadRes.payload?.msg}`
    )

    const batchMixedRes = createRes()
    await postBatch(
      {
        body: [
          basePayload({ first_play: 10000, second_week_play: null }),
          basePayload({ first_play: 0, second_week_play: 25600 })
        ]
      },
      batchMixedRes
    )
    const mixedIds = batchMixedRes.payload?.data?.ids || []
    createdIds.push(...mixedIds)
    check(
      'CASE 17/18：batch 合法行（10000/null、0/25600）写入成功',
      batchMixedRes.statusCode === 200 && mixedIds.length === 2,
      JSON.stringify(batchMixedRes.payload?.data)
    )
    const batchRow17 = getRow(mixedIds[0])
    const batchRow18 = getRow(mixedIds[1])
    check(
      'CASE 17：10000 / NULL 正确入库（latest 保持 NULL）',
      batchRow17?.first_play === 10000 && batchRow17?.second_week_play === null,
      JSON.stringify(batchRow17)
    )
    check(
      'CASE 18：0 / 25600 两个值都正确保存',
      batchRow18?.first_play === 0 && batchRow18?.second_week_play === 25600,
      JSON.stringify(batchRow18)
    )

    const countBeforeCostBatch = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
    const batchNoCostRes = createRes()
    await postBatch({ body: [{ time_cycle: '2026-W33', nickname: uniqueNickname() }] }, batchNoCostRes)
    check(
      'COST-BATCH-1：batch 行缺 total_cost → 400「总花费不能为空」且不写库',
      batchNoCostRes.statusCode === 400 &&
        String(batchNoCostRes.payload?.msg).includes(COST_EMPTY_MSG) &&
        db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n === countBeforeCostBatch,
      `${batchNoCostRes.statusCode} ${batchNoCostRes.payload?.msg}`
    )

    const batchCostZeroRes = createRes()
    await postBatch(
      { body: [basePayload({ total_cost: 0, first_play: 0, second_week_play: 25600 })] },
      batchCostZeroRes
    )
    const costZeroIds = batchCostZeroRes.payload?.data?.ids || []
    createdIds.push(...costZeroIds)
    check(
      'COST-BATCH-2：batch 行 total_cost=0 → 合法写入（真实 0）',
      batchCostZeroRes.statusCode === 200 &&
        costZeroIds.length === 1 &&
        getRow(costZeroIds[0])?.total_cost === 0,
      JSON.stringify(getRow(costZeroIds[0]))
    )
  } finally {
    console.log('\n===== 清理自测数据 =====')
    const cleanup = db.transaction(() => {
      for (const id of createdIds) {
        db.prepare('DELETE FROM creator_records WHERE id = ?').run(id)
      }
    })
    cleanup()
    const finalCount = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
    check(
      `creator_records 恢复基线（${baselineCount} 条）`,
      finalCount === baselineCount,
      `当前 ${finalCount} 条`
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
