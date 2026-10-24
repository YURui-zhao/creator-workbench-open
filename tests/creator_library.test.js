#!/usr/bin/env node
// Creator Identity V1 Phase 5 —— Creator Library（原达人汇总）前端 / 契约专项测试
//
// 运行方式：node tests/creator_library.test.js
// 隔离：os.tmpdir() 临时库；先执行 Phase 1 migration（commit），再验证 Library identity 契约。
//
// 覆盖（P5 §24 / §16 / §17 / §15 / §5 / §6 / §9）：
//   Backend contract: Library 总数 = Creator 数（而非 distinct nickname）；zero-history 行存在
//                    zero-history 指标 null / 0 语义；日期范围不删除 Creator；显式 minCampaigns 才隐藏
//                    same-name 不同 Creator 两行互不串数据；NULL creator_id 记录不形成 Creator
//   Records:          列表携带 creator_id（前端按归属锚下钻的必需数据）
//   Frontend source:  rowKey / selection / compare / detail 全部使用 creator_id；nickname 只做显示与 frozen fact
//   Frontend utils:   buildCompareRows 按 creator_id 选中（同名两人可同时对比）；导出显示名取 canonical_name

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-library-test-'))
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
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    }
  }
}

async function main() {
  const db = (await import(pathToFileURL(path.join(REPO_ROOT, 'backend/db.js')).href)).default
  const migration = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/migrations/001_creator_identity.js')).href
  )
  const recordsModule = await import(pathToFileURL(path.join(REPO_ROOT, 'backend/routes/records.js')).href)
  const compareModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/creatorCompare.js')).href
  )
  const excelModule = await import(pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/excel.js')).href)
  const snapshotsModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/recentSnapshots.js')).href
  )

  const handlerOf = (routePath, method = 'get') =>
    recordsModule.default.stack.find(
      (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
    )?.route?.stack?.at(-1)?.handle
  const summaryHandler = handlerOf('/creator-summary')
  const listHandler = handlerOf('/')
  const exportHandler = handlerOf('/export')
  const radarHandler = handlerOf('/repurchase-radar')
  // 注意：快照 handler 必须从 recentSnapshots 路由解析（records.js 的 POST / 是「新增投放记录」）
  const snapshotCreateHandler = snapshotsModule.default.stack.find(
    (item) => item.route && item.route.path === '/' && item.route.methods?.post
  )?.route?.stack?.at(-1)?.handle
  const snapshotLatestHandler = snapshotsModule.default.stack.find(
    (item) => item.route && item.route.path === '/latest' && item.route.methods?.get
  )?.route?.stack?.at(-1)?.handle
  check(
    'snapshot handlers 来自 recentSnapshots 路由（避免误拿 records 新增接口）',
    typeof snapshotCreateHandler === 'function' && typeof snapshotLatestHandler === 'function'
  )

  const call = async (handler, { body = {}, query = {} } = {}) => {
    const res = response()
    await handler({ body, query, params: {}, headers: {} }, res)
    return { status: res.statusCode, body: res.body, data: res.body?.data }
  }
  const q1 = (sql, ...p) => db.prepare(sql).get(...p)

  // ---------- fixture：身份层（先建 schema，再造数据） ----------
  const migrated = migration.runMigration(db, { mode: 'commit' })
  check('Phase 1 migration（临时库）成功', migrated.ok === true)

  // 同名不同人：两个 canonical_name 都叫「小王」
  const insertCreator = db.prepare(
    "INSERT INTO creators (canonical_name, creator_type, identity_status) VALUES (?, ?, 'provisional')"
  )
  const insertAlias = db.prepare(
    'INSERT INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?)'
  )
  const wangA = insertCreator.run('小王', '数码').lastInsertRowid
  const wangB = insertCreator.run('小王', '数码').lastInsertRowid
  const zeroHistoryCreator = insertCreator.run('零历史达人', '美妆').lastInsertRowid
  for (const id of [wangA, wangB, zeroHistoryCreator]) {
    const name = db.prepare('SELECT canonical_name FROM creators WHERE id = ?').get(id).canonical_name
    insertAlias.run(id, name, name, 'seed')
  }

  // 记录：小王A 2 条 / 小王B 1 条 / 1 条未归属（creator_id = NULL）
  const insertRecord = db.prepare(
    `INSERT INTO creator_records
       (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play, creator_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  insertRecord.run('2026-W33', '小王', '数码', 1000, '2026-08-18', 10000, 20000, wangA)
  insertRecord.run('2026-W34', '小王', '数码', 2000, '2026-08-25', 0, 5000, wangA)
  insertRecord.run('2026-W35', '小王', '数码', 4000, '2026-09-01', 20000, 400000, wangB)
  insertRecord.run('2026-W36', '未知来源', '数码', 999, '2026-09-08', 1000, 2000, null)
  // 同名 NULL 归属记录：绝不能被 nickname fallback 吸进小王A / 小王B
  insertRecord.run('2026-W37', '小王', '数码', 111, '2026-09-15', 500, 800, null)
  insertRecord.run('2026-W37', '小王', '数码', 222, '2026-09-15', 500, 900, null)

  console.log('\n===== A. Library 契约（identity 模式） =====')
  const base = await call(summaryHandler)
  const creators = base.data.creators || []
  check('Library 总数 = Creator 数（76 语义：Creator 是身份来源，不是 distinct nickname）', creators.length === 3, `rows=${creators.length}`)
  check('每一行都携带 creator_id（行身份）', creators.every((row) => Number.isInteger(row.creator_id) && row.creator_id > 0))
  check('每一行都携带 canonical_name（显示名）', creators.every((row) => typeof row.canonical_name === 'string'))
  check('identity_mode = true', base.data.identity_mode === true)

  const byId = new Map(creators.map((row) => [row.creator_id, row]))
  const wangARow = byId.get(wangA)
  const wangBRow = byId.get(wangB)
  const zeroRow = byId.get(zeroHistoryCreator)

  console.log('\n===== B. same-name 不同 Creator：两行互不串数据 =====')
  check(
    '两个「小王」是两行（不同 creator_id，不按显示名合并）',
    Number.isInteger(wangARow) === false &&
      Boolean(wangARow) &&
      Boolean(wangBRow) &&
      wangARow.creator_id !== wangBRow.creator_id &&
      wangARow.canonical_name === '小王' &&
      wangBRow.canonical_name === '小王'
  )
  check(
    '指标完全分开：小王A 2 次 / 小王B 1 次',
    wangARow.total_campaigns === 2 && wangBRow.total_campaigns === 1,
    `A=${wangARow.total_campaigns} B=${wangBRow.total_campaigns}`
  )
  check(
    '花费 / 播放互不串（A 3000/25000，B 4000/400000）',
    wangARow.total_cost === 3000 &&
      wangARow.latest_play_total === 25000 &&
      wangBRow.total_cost === 4000 &&
      wangBRow.latest_play_total === 400000
  )

  console.log('\n===== C. zero-history Creator =====')
  check('zero-history Creator 出现在 Library 中', Boolean(zeroRow) && zeroRow.creator_id === zeroHistoryCreator)
  check('投放次数 / 复投次数 = 0（冻结 contract）', zeroRow.total_campaigns === 0 && zeroRow.repeat_count === 0)
  check('总花费 / 累计播放 / 爆款数 = 0（空集求和语义）', zeroRow.total_cost === 0 && zeroRow.latest_play_total === 0 && zeroRow.hit_latest_count === 0)
  check(
    '平均播放 / 平均CPM / 爆款率 = null（无观察值 ≠ 0）',
    zeroRow.avg_play === null && zeroRow.avg_cpm === null && zeroRow.hit_rate_latest === null && zeroRow.cpm_7d === null
  )

  console.log('\n===== D. 日期范围只影响 metrics，不删除 Creator =====')
  // W35：小王B 有记录；小王A / 零历史达人没有 —— 同一范围同时覆盖「有 / 无记录」两种 Creator
  const ranged = await call(summaryHandler, { query: { startWeek: '2026-W35', endWeek: '2026-W36' } })
  const rangedCreators = ranged.data.creators || []
  check(
    '范围内无记录的 Creator 仍在 Library（小王A / 零历史达人），有记录的也在（小王B）',
    rangedCreators.some((row) => row.creator_id === wangA) &&
      rangedCreators.some((row) => row.creator_id === zeroHistoryCreator) &&
      rangedCreators.some((row) => row.creator_id === wangB),
    `rows=${rangedCreators.length}`
  )
  check(
    '范围内无记录 → total_campaigns = 0 / 指标 null（不是被过滤掉）',
    byIdOf(rangedCreators, wangA).total_campaigns === 0 && byIdOf(rangedCreators, wangA).avg_cpm === null
  )
  check(
    '范围内有记录的 Creator 指标正常（小王B 1 次 / 平均CPM 非空）',
    byIdOf(rangedCreators, wangB).total_campaigns === 1 && byIdOf(rangedCreators, wangB).avg_cpm !== null
  )

  const minTwo = await call(summaryHandler, { query: { minCampaigns: 2 } })
  check(
    '只有显式 minCampaigns 才会隐藏 zero-history / 低频 Creator',
    minTwo.data.creators.every((row) => row.total_campaigns >= 2) &&
      !minTwo.data.creators.some((row) => row.creator_id === zeroHistoryCreator),
    `rows=${minTwo.data.creators.length}`
  )

  console.log('\n===== E. NULL creator_id：绝不形成 Creator =====')
  check(
    '未归属记录（含两条同名）计入 unattributed_record_count（事实保留，但不进入任何 Creator）',
    base.data.unattributed_record_count === 3,
    String(base.data.unattributed_record_count)
  )
  check(
    '不存在「未知来源」这样的假 Creator 行',
    !creators.some((row) => row.canonical_name === '未知来源')
  )
  check(
    '未归属记录的花费不进入任何 Creator / 总汇总（3000+4000=7000，NULL 记录的 111/222 不计入）',
    base.data.total_summary.total_cost === 7000 &&
      base.data.total_summary.total_campaigns === 3 &&
      base.data.total_summary.creator_count === 3
  )

  console.log('\n===== F. Records 列表携带 creator_id（前端下钻数据源） =====')
  const listRes = await call(listHandler, { query: { page: 1, pageSize: 50 } })
  const listRows = listRes.data?.records || listRes.data?.list || []
  check('记录行包含 creator_id（含 NULL 归属）', listRows.length === 6 && listRows.every((row) => 'creator_id' in row))
  check(
    '未归属记录的 creator_id = NULL（事实正常存在，3 条：1 未知来源 + 2 条同名）',
    listRows.filter((row) => row.creator_id === null).length === 3
  )

  console.log('\n===== G. 前端工具：对比 / 导出身份 =====')
  const { buildCompareRows, canCompareCreators } = compareModule
  check('canCompareCreators 契约不变（2~5 位）', canCompareCreators(1).ok === false && canCompareCreators(2).ok === true)
  const keys = [wangA, wangB].map((id) => `id:${id}`)
  const compareRows = buildCompareRows(creators, keys)
  check(
    '对比按 creator_id 选中：两个同名 Creator 可同时进入对比（不互相覆盖）',
    compareRows.length === 2 &&
      compareRows.map((row) => row.creator_id).sort((a, b) => a - b).join(',') ===
        [wangA, wangB].sort((a, b) => a - b).join(',')
  )
  check(
    '未选中的 zero-history Creator 不进入对比',
    !compareRows.some((row) => row.creator_id === zeroHistoryCreator)
  )

  const outFile = path.join(TMP_DIR, '__library_export.xlsx')
  const exported = excelModule.exportCreatorStatsToExcel(creators, { fileName: outFile, sheetName: '达人明细' })
  check('导出行数 = Library 行数', exported === creators.length, `exported=${exported}`)
  const XLSX = await import(pathToFileURL(path.join(REPO_ROOT, 'frontend/node_modules/xlsx/xlsx.mjs')).href)
  const workbook = XLSX.read(fs.readFileSync(outFile), { type: 'buffer' })
  const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets['达人明细'], { defval: '' })
  check(
    '导出显示名 = canonical_name（identity 模式下两个「小王」都能正确导出）',
    sheetRows.filter((row) => row['达人昵称'] === '小王').length === 2
  )
  check(
    '导出 zero-history 行：次数 0 / 播放 0 / 平均播放为空（不是 0）',
    sheetRows.some(
      (row) =>
        row['达人昵称'] === '零历史达人' &&
        Number(row['投放次数']) === 0 &&
        Number(row['累计播放量']) === 0 &&
        row['平均播放量'] === ''
    )
  )

  console.log('\n===== H. 前端源码契约（CreatorSummary / 共享工具） =====')
  const pageSrc = fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/pages/CreatorSummary/index.jsx'), 'utf8')
  const compareSrc = fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/utils/creatorCompare.js'), 'utf8')
  check(
    'rowKey 使用 creator_id（不再 rowKey="nickname"）',
    /rowKey=\{creatorRowKey\}/.test(pageSrc) && !/rowKey="nickname"/.test(pageSrc)
  )
  check(
    '下钻按 creator_id 过滤（不再按昵称文本匹配）',
    /row\.creator_id !== creator\.creator_id/.test(pageSrc)
  )
  check(
    'selection / compare 使用同一 identity key',
    /selectedRowKeys: compareKeys/.test(pageSrc) && /rowKey=\{creatorRowKey\}/.test(pageSrc)
  )
  check(
    'zero-history 详情：明确「暂无历史投放记录」，不报错、不伪造表现',
    /暂无历史投放记录/.test(pageSrc)
  )
  check(
    '共享 compare 工具按 creator_id 匹配（不再 nameSet.has(item.nickname)）',
    /creatorIdentityKey/.test(compareSrc) && !/nameSet\.has\(item\.nickname\)/.test(compareSrc)
  )
  check(
    'nickname 仅保留显示 / frozen 语义（达人明细表仍展示记录里的 frozen nickname）',
    /dataIndex: 'nickname'/.test(pageSrc) && /title: '达人昵称'/.test(pageSrc)
  )

  console.log('\n===== I. Radar E2E：same-name / zero-history / NULL 归属 =====')
  const radarPageSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/pages/RepurchaseRadar/index.jsx'),
    'utf8'
  )
  const radarRes = await call(radarHandler)
  const radarRows = (radarRes.data.groups || []).flatMap((group) =>
    group.creators.map((item) => ({ ...item, __group: group.key }))
  )
  check(
    'Radar 只包含有真实记录的 Creator（2 个），zero-history 不进入',
    radarRes.data.summary.creator_count === 2 &&
      radarRows.every((row) => Number.isInteger(row.creator_id) && row.creator_id > 0) &&
      !radarRows.some((row) => row.creator_id === zeroHistoryCreator),
    `count=${radarRes.data.summary.creator_count}`
  )
  const radarWangA = radarRows.find((row) => row.creator_id === wangA)
  const radarWangB = radarRows.find((row) => row.creator_id === wangB)
  check(
    'Radar：同名两个「小王」是两行（creator_id 不同、显示名相同、不按名称合并）',
    Boolean(radarWangA) && Boolean(radarWangB) && radarWangA.creator_id !== radarWangB.creator_id &&
      radarWangA.creator === '小王' && radarWangB.creator === '小王'
  )
  check(
    'Radar：NULL creator_id 记录不形成 group（未归属 3 条全部排除）',
    radarRes.data.unattributed_record_count === 3 && radarRes.data.summary.record_count === 3
  )
  check(
    'Radar 分组合计 = Creator 总数（不重复计数）',
    (radarRes.data.groups || []).reduce((sum, group) => sum + group.count, 0) ===
      radarRes.data.summary.creator_count
  )
  check(
    'Radar：workspace / decision 的身份键来自 creator_id（前端 plumbing 源码锁定）',
    radarPageSrc.includes('radarRowKey(item, index, identityMode)') &&
      radarPageSrc.includes('radarRowKey(item, undefined, identityMode) === workspaceKey')
  )

  console.log('\n===== J. Snapshot 归属（同名两个「小王」互不串） =====')
  const snapBody = (creatorId) => ({
    creator: '小王',
    creator_id: creatorId,
    plays: [{ raw_text: '1.2w', excluded: false, content_type: 'sponsored' }],
    observed_at: '2026-09-10',
    xingtu_price_raw: '2000'
  })
  const snapA = await call(snapshotCreateHandler, { body: snapBody(wangA) })
  const snapB = await call(snapshotCreateHandler, { body: snapBody(wangB) })
  check(
    '同名两个 Creator 各自保存快照成功（显式 creator_id）',
    snapA.status === 200 && snapB.status === 200,
    `${snapA.status}/${snapB.status}`
  )
  check(
    '快照分别归属各自的 creator_id（不按名称合并）',
    q1('SELECT creator_id FROM creator_recent_snapshots WHERE id = ?', snapA.data.id).creator_id === wangA &&
      q1('SELECT creator_id FROM creator_recent_snapshots WHERE id = ?', snapB.data.id).creator_id === wangB
  )
  const latestA = await call(snapshotLatestHandler, { query: { creator: '小王', creator_id: wangA } })
  const latestB = await call(snapshotLatestHandler, { query: { creator: '小王', creator_id: wangB } })
  check(
    'latest 按 creator_id 读取：A 读到 A 的快照，B 读到 B 的快照',
    latestA.data?.creator_id === wangA &&
      latestB.data?.creator_id === wangB &&
      latestA.data?.snapshot?.id === snapA.data.id &&
      latestB.data?.snapshot?.id === snapB.data.id
  )

  console.log('\n===== K. Identity fallback safety（NEW / OLD schema 分支锁定） =====')
  const { creatorIdentityKey, buildCompareRows: compareRowsFn } = compareModule
  const idRow = { creator_id: wangA, canonical_name: '小王', nickname: '小王' }
  const legacyRowA = { nickname: '小王' }
  const legacyRowB = { nickname: '小王' }
  check(
    'NEW schema + 有 creator_id → 永远用 id 键（同名不同 id 键不同）',
    creatorIdentityKey(idRow, 0, true) === `id:${wangA}` &&
      creatorIdentityKey({ ...idRow, creator_id: wangB }, 1, true) === `id:${wangB}`
  )
  check(
    'NEW schema + 行缺 creator_id → 稳定 invalid 键（绝不静默用名称当身份）',
    creatorIdentityKey({ canonical_name: '小王' }, 0, true) === 'invalid:0:小王' &&
      creatorIdentityKey({ canonical_name: '小王' }, 1, true) === 'invalid:1:小王'
  )
  const noIdRows = [
    { canonical_name: '小王', nickname: '小王' },
    { canonical_name: '小王', nickname: '小王' }
  ]
  check(
    'NEW schema + 两个同名行都缺 creator_id → invalid 键互不相同（绝不合并成一行）',
    creatorIdentityKey(noIdRows[0], 0, true) !== creatorIdentityKey(noIdRows[1], 1, true)
  )
  check(
    'identity 模式：缺 creator_id 的行不参与对比（buildCompareRows 跳过，不可能被同名合并）',
    compareRowsFn(noIdRows, ['invalid:0:小王', 'invalid:1:小王'], true).length === 0
  )
  check(
    'OLD schema（无 identity capability）→ 名称键（旧行为保留，测试 fixture 兼容）',
    creatorIdentityKey(legacyRowA, 0, false) === 'name:小王' &&
      creatorIdentityKey(legacyRowB, 1, false) === 'name:小王'
  )
  check(
    'OLD schema：同名两行选择同一名称键 → 仍返回两行（行数据不丢，与 P5 前一致）',
    compareRowsFn([legacyRowA, legacyRowB], ['name:小王'], false).length === 2
  )

  console.log('\n===== L. Radar action identity（前端源码锁定） =====')
  const decisionDrawerSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/components/CreatorDecisionDrawer.jsx'),
    'utf8'
  )
  const decisionsApiSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/api/creatorDecisions.js'),
    'utf8'
  )
  const assistantSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/components/RecentPerformanceAssistantModal.jsx'),
    'utf8'
  )
  check(
    'Radar decision 写入显式携带 creator_id（不再依赖名称解析 / ZERO_MATCH fallback）',
    /creator_id: creatorId \?\? null/.test(decisionDrawerSrc) &&
      /getCreatorDecisions\(creator, creatorId\)/.test(decisionDrawerSrc) &&
      /params\.creator_id = creatorId/.test(decisionsApiSrc)
  )
  check(
    'Recent snapshot 读写优先 creator_id（读 latest / 写 payload 都带归属锚）',
    /getLatestRecentSnapshot\(targetCreator, effectiveCreatorId\)/.test(assistantSrc) &&
      /payload\.creator_id = effectiveCreatorId/.test(assistantSrc)
  )

  console.log('\n===== M. Invalid Creator ID contract（identity 模式契约破坏行） =====')
  // 排序交换：两行缺 creator_id 的同名行在 dataSource 中顺序互换
  const swapped = [noIdRows[1], noIdRows[0]]
  check(
    '排序交换后：invalid 键随行走且互不相同（不产生稳定身份，也不互相继承）',
    creatorIdentityKey(noIdRows[0], 0, true) === 'invalid:0:小王' &&
      creatorIdentityKey(noIdRows[1], 1, true) === 'invalid:1:小王' &&
      creatorIdentityKey(swapped[0], 0, true) === 'invalid:0:小王' &&
      creatorIdentityKey(swapped[1], 1, true) === 'invalid:1:小王' &&
      // 任何 invalid 键都不可能等于合法 id 键（绝不冒充正常 Creator ownership）
      !String(creatorIdentityKey(noIdRows[0], 0, true)).startsWith('id:') &&
      !String(creatorIdentityKey(swapped[0], 0, true)).startsWith('id:')
  )
  check(
    '排序交换前后：buildCompareRows 在 identity 模式下始终拒绝缺 creator_id 的行',
    compareRowsFn(noIdRows, ['invalid:0:小王', 'invalid:1:小王'], true).length === 0 &&
      compareRowsFn(swapped, ['invalid:0:小王', 'invalid:1:小王'], true).length === 0
  )
  check(
    'invalid 键绝不等于名称键（不会因同名被当成正常 Creator）',
    creatorIdentityKey(noIdRows[0], 0, true) !== creatorIdentityKey(legacyRowA, 0, false)
  )

  console.log('\n===== N. zero-history 复投语义（前端源码锁定） =====')
  const summaryPageSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/pages/CreatorSummary/index.jsx'),
    'utf8'
  )
  check(
    '复投次数列：zero-history（total_campaigns=0）显示 0，不显示「首次」',
    /Number\(record\?\.total_campaigns \?\? 0\) === 0\) return formatInteger\(0\)/.test(summaryPageSrc)
  )
  check('既有「首次」语义保留（有 ≥1 条记录且 0 次复投）', (summaryPageSrc.match(/首次/g) || []).length >= 2)
  check(
    'identity 模式下：selection 禁选缺 creator_id 的行 + 下钻拒绝（不 fallback name）',
    /getCheckboxProps: \(record\) => \(\{/.test(summaryPageSrc) &&
      /identityMode &&\s*\(record\.creator_id === null \|\| record\.creator_id === undefined\)/.test(
        summaryPageSrc
      ) &&
      /if \(identityMode && \(creator\.creator_id === null \|\| creator\.creator_id === undefined\)\) return/.test(
        summaryPageSrc
      )
  )
  check(
    'Radar：identity 模式下缺 creator_id 的行拒绝进入工作区（不 fallback）',
    /if \(identityMode && \(creatorItem\.creator_id === null \|\| creatorItem\.creator_id === undefined\)\) \{/.test(
      fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/pages/RepurchaseRadar/index.jsx'), 'utf8')
    )
  )
}

function byIdOf(rows, id) {
  return rows.find((row) => row.creator_id === id)
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    failCount += 1
    failures.push(`执行异常：${error?.message || error}`)
  })
  .finally(() => {
    console.log(`\n===== 结果：成功 ${passCount} / 失败 ${failCount} =====`)
    if (failures.length) {
      console.log('失败项：')
      for (const item of failures) console.log(`  - ${item}`)
    }
    process.exitCode = failCount === 0 ? 0 : 1
  })
