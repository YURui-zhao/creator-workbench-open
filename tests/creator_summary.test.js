#!/usr/bin/env node
/**
 * 达人汇总增强回归测试（Batch 6A-2：与用户真实库解耦）
 *
 * 运行方式：node tests/creator_summary.test.js
 * 隔离方式：通过 WORKBENCH_DB_PATH 指向临时数据库，测试自行 seed 固定数据集，
 *          结束后删除临时库；用户真实库有 0 / 50 / 500 条都不会影响本测试结果。
 * 覆盖：结构 / 统计口径 / keyword / minCampaigns / 排序 / 分组 / 达人对比 / 导出
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')

// —— 隔离数据库：必须在 import backend/db.js 之前设置
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-summary-test-'))
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

/**
 * 自建固定数据集（不依赖任何真实业务数据）
 * - 达人甲（数码）：2 次投放，含 first=0 的合法记录
 * - 达人乙（数码）：1 次投放，7日爆款 + 累计爆款
 * - 达人丙（历史类）：1 次投放，累计播放量待更新（latest = null）
 * - 达人丁（历史类）：1 次投放，异常记录（latest < first）
 * - 达人戊（美妆）：3 次投放，其中 1 条累计爆款
 */
const SEED = [
  // [time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play]
  ['2026-W33', '达人甲', '数码', 1000, '2026-08-18', 10000, 20000],
  ['2026-W34', '达人甲', '数码', 2000, '2026-08-25', 0, 5000],
  ['2026-W33', '达人乙', '数码', 5000, '2026-08-19', 150000, 260000],
  ['2026-W34', '达人丙', '历史类', 3000, '2026-08-26', 80000, null],
  ['2026-W33', '达人丁', '历史类', 4000, '2026-08-20', 120000, 90000],
  ['2026-W33', '达人戊', '美妆', 100, '2026-08-17', 1000, 50000],
  ['2026-W34', '达人戊', '美妆', 100, '2026-08-24', 1000, 150000],
  ['2026-W35', '达人戊', '美妆', 100, '2026-09-01', 1000, 50000]
]

async function main() {
  const recordsModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/records.js')).href
  )
  const db = (await import(pathToFileURL(path.join(REPO_ROOT, 'backend/db.js')).href)).default
  const layer = recordsModule.default.stack.find(
    (item) => item.route && item.route.path === '/creator-summary' && item.route.methods.get
  )
  const handler = layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
  const routeHandler = (routePath) => recordsModule.default.stack.find(
    (item) => item.route && item.route.path === routePath && item.route.methods.get
  )?.route?.stack?.at(-1)?.handle
  const weekStatsHandler = routeHandler('/week-stats')
  const listHandler = routeHandler('/')
  const exportHandler = routeHandler('/export')
  check('creator-summary handler 可用', typeof handler === 'function')
  check('周汇总、记录列表、导出 handler 可用',
    [weekStatsHandler, listHandler, exportHandler].every((item) => typeof item === 'function'))

  // 写入固定数据集（隔离库，不影响用户真实库）
  const insert = db.prepare(
    `INSERT INTO creator_records
       (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  db.transaction(() => {
    for (const row of SEED) insert.run(...row)
  })()
  const seededCount = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
  check('隔离库 seed 完成（8 条）', seededCount === SEED.length, `seeded=${seededCount}`)

  const callRoute = async (route, query) => {
    const res = {
      statusCode: 200,
      payload: null,
      body: null,
      status(code) {
        this.statusCode = code
        return this
      },
      json(body) {
        this.payload = body
        return this
      },
      setHeader() {
        return this
      },
      send(body) {
        this.body = body
        return this
      }
    }
    await route({ query }, res)
    return { status: res.statusCode, data: res.payload?.data, msg: res.payload?.msg, body: res.body }
  }
  const call = (query) => callRoute(handler, query)

  console.log('===== 1. 默认行为（不传新参数，保持原有结构）=====')
  const base = await call({})
  check('默认返回 200', base.status === 200)
  check(
    '原有字段全部保留',
    ['caliber', 'groupByType', 'range', 'filters', 'groups', 'total_summary'].every(
      (key) => key in base.data
    ),
    JSON.stringify(Object.keys(base.data))
  )
  check(
    'total_summary 原有字段保留',
    ['creator_count', 'total_campaigns', 'total_cost', 'total_play', 'avg_cpm'].every(
      (key) => key in base.data.total_summary
    ),
    JSON.stringify(Object.keys(base.data.total_summary))
  )
  const firstCreator = base.data.creators[0]
  check(
    '达人字段含原有 + 新增三列',
    [
      'nickname',
      'creator_type',
      'total_campaigns',
      'total_cost',
      'total_play',
      'avg_cpm',
      'hit_count',
      'avg_play',
      'repeat_count'
    ].every((key) => key in firstCreator),
    JSON.stringify(Object.keys(firstCreator))
  )
  check(
    '默认排序 = 总花费降序',
    base.data.sort.sortBy === 'total_cost' && base.data.sort.sortOrder === 'desc'
  )
  const costs = base.data.creators.map((item) => item.total_cost)
  check(
    '默认排序结果确实降序',
    costs.every((value, i) => i === 0 || costs[i - 1] >= value),
    JSON.stringify(costs)
  )

  console.log('\n===== 2. 统计字段计算正确性（V2 口径）=====')
  const byName = Object.fromEntries(base.data.creators.map((item) => [item.nickname, item]))
  const jia = byName['达人甲']
  const yi = byName['达人乙']
  const bing = byName['达人丙']
  const ding = byName['达人丁']
  const wu = byName['达人戊']

  check(
    '达人数量 / 投放次数正确（5 位达人 / 8 次投放）',
    base.data.creators.length === 5 && base.data.total_summary.total_campaigns === 8,
    `creators=${base.data.creators.length} campaigns=${base.data.total_summary.total_campaigns}`
  )
  check(
    '总播放 = Σ有效累计播放（不含待更新与异常）',
    base.data.total_summary.total_play === 25000 + 260000 + 100000 + 150000 &&
      base.data.total_summary.total_play === base.data.total_summary.latest_play_total,
    `total_play=${base.data.total_summary.total_play}`
  )
  check(
    '口径回归保护：总播放 = Σ最新累计，且不等于 first + latest',
    base.data.total_summary.total_play !==
      base.data.total_summary.first_play_total + base.data.total_summary.latest_play_total,
    `total_play=${base.data.total_summary.total_play} first=${base.data.total_summary.first_play_total} latest=${base.data.total_summary.latest_play_total}`
  )
  check(
    '异常记录（latest < first）不计入累计播放聚合',
    ding.total_play === 0 && ding.avg_cpm === null && ding.latest_sample_count === 0,
    JSON.stringify({ play: ding.total_play, cpm: ding.avg_cpm, samples: ding.latest_sample_count })
  )
  check(
    '待更新记录（latest = null）保留花费与 7日播放，但不产生累计样本',
    bing.total_cost === 3000 && bing.first_play_sum === 80000 && bing.latest_sample_count === 0,
    JSON.stringify({ cost: bing.total_cost, first: bing.first_play_sum })
  )
  check(
    '后续新增播放量 = Σ(累计 − 7日)（仅有效样本）',
    jia.post_7d_growth_total === 15000 && // (20000-10000) + (5000-0)
      yi.post_7d_growth_total === 110000 &&
      wu.post_7d_growth_total === 247000,
    JSON.stringify([jia.post_7d_growth_total, yi.post_7d_growth_total, wu.post_7d_growth_total])
  )
  check(
    '爆款数（累计 ≥ 10 万）：达人乙 1 / 达人戊 1',
    yi.hit_latest_count === 1 && wu.hit_latest_count === 1 && jia.hit_latest_count === 0
  )
  check(
    '7日爆款数（7日 ≥ 10 万）：达人乙 1 / 达人丁 1',
    yi.hit_7d_count === 1 && ding.hit_7d_count === 1 && wu.hit_7d_count === 0
  )
  check(
    '累计爆款率 = 累计爆款数 ÷ 有效累计样本数（达人戊 1/3 = 33.3）',
    wu.hit_rate_latest === 33.3 && yi.hit_rate_latest === 100,
    `wu=${wu.hit_rate_latest} yi=${yi.hit_rate_latest}`
  )
  check(
    '最新平均CPM = 有有效 latest 记录的花费 ÷ latest 总和 × 1000',
    yi.avg_cpm === Number(((5000 / 260000) * 1000).toFixed(2)) &&
      wu.avg_cpm === Number(((300 / 250000) * 1000).toFixed(2)),
    `yi=${yi.avg_cpm} wu=${wu.avg_cpm}`
  )
  check(
    '7日平均CPM = 全部有效 first 记录的花费 ÷ Σfirst × 1000（含 first=0）',
    jia.cpm_7d === Number(((3000 / 10000) * 1000).toFixed(2)),
    `jia=${jia.cpm_7d}`
  )
  check(
    'avg_play = 有效累计播放 ÷ 有效样本数（保留 1 位小数）',
    yi.avg_play === Number((260000 / 1).toFixed(1)) &&
      wu.avg_play === Number((250000 / 3).toFixed(1)),
    `yi=${yi.avg_play} wu=${wu.avg_play}`
  )
  check(
    'repeat_count = 投放次数 - 1',
    jia.repeat_count === 1 && wu.repeat_count === 2 && yi.repeat_count === 0
  )

  const summary = base.data.total_summary
  const expectedHits = base.data.creators.reduce((sum, item) => sum + item.hit_latest_count, 0)
  check(
    'total_summary.total_hits = 各达人累计爆款数之和',
    summary.total_hits === expectedHits,
    `hits=${expectedHits}`
  )
  check(
    'total_summary.hit_rate = 累计爆款数 / 有效累计样本数 × 100（1 位小数）',
    summary.hit_rate === Number(((expectedHits / summary.latest_sample_count) * 100).toFixed(1)),
    `hit_rate=${summary.hit_rate} (hits=${expectedHits}, samples=${summary.latest_sample_count})`
  )
  check(
    'total_summary 新增口径字段齐全',
    [
      'latest_play_total',
      'first_play_total',
      'post_7d_growth_total',
      'avg_cpm',
      'cpm_7d',
      'hit_7d_count',
      'hit_latest_count',
      'hit_rate_7d',
      'hit_rate_latest',
      'latest_sample_count',
      'latest_pending_count'
    ].every((key) => key in summary),
    JSON.stringify(Object.keys(summary))
  )
  check(
    '7日爆款率 / 累计爆款率分别按各自样本计算',
    summary.hit_rate_7d === Number(((summary.hit_7d_count / summary.first_sample_count) * 100).toFixed(1)) &&
      summary.hit_rate_latest ===
        Number(((summary.hit_latest_count / summary.latest_sample_count) * 100).toFixed(1))
  )
  check(
    '总汇总 7日平均CPM 分子含 first=0 的记录花费',
    summary.cpm_7d === Number(((summary.total_cost / summary.first_play_total) * 1000).toFixed(2)),
    `cpm_7d=${summary.cpm_7d}`
  )
  check(
    '异常计数正确（anomaly = 1），且真实「待更新」= record − 样本 − 异常 = 1',
    summary.anomaly_count === 1 &&
      summary.record_count - summary.latest_sample_count - summary.anomaly_count === 1,
    `anomaly=${summary.anomaly_count} samples=${summary.latest_sample_count}`
  )
  check(
    // 达人级口径：pending = record − sample − anomaly（异常不算待更新）
    '达人级「待更新 / 异常」都不产生有效样本（达人丙 null、达人丁 异常 → sample = 0）',
    bing.latest_sample_count === 0 && ding.latest_sample_count === 0
  )
  check(
    'total_summary.latest_pending_count = record − sample − anomaly（异常不算待更新，= 1）',
    summary.latest_pending_count === 1 &&
      summary.latest_pending_count === summary.record_count - summary.latest_sample_count - summary.anomaly_count &&
      summary.latest_pending_count === base.data.creators.reduce((sum, item) => sum + item.latest_pending_count, 0),
    `pending=${summary.latest_pending_count}`
  )

  console.log('\n===== 3. keyword 模糊搜索 =====')
  const kw = await call({ keyword: '达人乙' })
  check(
    'keyword 命中单个达人',
    kw.status === 200 && kw.data.creators.length === 1 && kw.data.creators[0].nickname === '达人乙',
    JSON.stringify(kw.data.creators.map((c) => c.nickname))
  )
  const kwEmpty = await call({ keyword: '' })
  check('keyword 空串返回全部（与默认一致）', kwEmpty.data.creators.length === base.data.creators.length)
  const kwMiss = await call({ keyword: '__不存在的达人__' })
  check(
    'keyword 无匹配返回空列表',
    kwMiss.status === 200 &&
      kwMiss.data.creators.length === 0 &&
      kwMiss.data.total_summary.creator_count === 0
  )
  const kwLike = await call({ keyword: '_' })
  check('keyword 通配符被转义（_ 不当通配匹配）', kwLike.status === 200 && kwLike.data.creators.length === 0, `命中 ${kwLike.data.creators.length} 条`)
  const kwLong = await call({ keyword: 'x'.repeat(51) })
  check('keyword 超过 50 返回 400', kwLong.status === 400 && kwLong.msg.includes('50'), kwLong.msg)

  console.log('\n===== 4. minCampaigns 最小投放次数 =====')
  const min2 = await call({ minCampaigns: '2' })
  check(
    'minCampaigns=2 只保留投放次数 >= 2 的达人（达人甲 / 达人戊）',
    min2.status === 200 &&
      min2.data.creators.every((item) => item.total_campaigns >= 2) &&
      min2.data.creators.length === 2,
    JSON.stringify(min2.data.creators.map((c) => c.nickname))
  )
  const min1 = await call({ minCampaigns: '1' })
  check('minCampaigns=1 与不限等价', min1.data.creators.length === base.data.creators.length)
  const minBad = await call({ minCampaigns: '0' })
  check('minCampaigns=0 返回 400', minBad.status === 400, minBad.msg)
  const minBad2 = await call({ minCampaigns: 'abc' })
  check('minCampaigns 非整数返回 400', minBad2.status === 400, minBad2.msg)

  console.log('\n===== 5. 新增排序字段 =====')
  const sortCases = [
    ['hit_count', 'desc'],
    ['hit_count', 'asc'],
    ['avg_play', 'asc'],
    ['repeat_count', 'desc'],
    ['avg_cpm', 'asc']
  ]
  for (const [sortBy, sortOrder] of sortCases) {
    const res = await call({ sortBy, sortOrder })
    const values = res.data.creators
      .map((item) => item[sortBy])
      .filter((value) => value !== null && value !== undefined)
    const sorted = values.every((value, i) => {
      if (i === 0) return true
      return sortOrder === 'asc' ? values[i - 1] <= value : values[i - 1] >= value
    })
    check(`排序 ${sortBy} ${sortOrder} 生效`, res.status === 200 && sorted, JSON.stringify(values.slice(0, 5)))
  }
  const badSortBy = await call({ sortBy: 'nickname' })
  check('非法 sortBy 返回 400', badSortBy.status === 400 && badSortBy.msg.includes('sortBy'), badSortBy.msg)
  const badOrder = await call({ sortOrder: 'up' })
  check('非法 sortOrder 返回 400', badOrder.status === 400 && badOrder.msg.includes('sortOrder'), badOrder.msg)

  console.log('\n===== 6. 与分组/口径联动 =====')
  const grouped = await call({ creatorTypes: ['历史类'], sortBy: 'hit_count', sortOrder: 'desc' })
  check(
    '博主类型筛选 + 排序联动正常',
    grouped.data.groups.length === 1 && grouped.data.groups[0].creator_type === '历史类',
    `groups=${grouped.data.groups.length}`
  )
  const campaign = await call({ caliber: 'campaign' })
  const occurrence = await call({ caliber: 'occurrence' })
  check(
    'creator-summary 默认与显式 campaign 返回一致',
    campaign.status === 200 && JSON.stringify(campaign.data) === JSON.stringify(base.data)
  )
  check(
    'creator-summary 显式 occurrence 返回 400',
    occurrence.status === 400 && occurrence.msg.includes('按发生周暂未开放'),
    occurrence.msg
  )
  const weekDefault = await callRoute(weekStatsHandler, { weekCode: '2026-W33' })
  const weekCampaign = await callRoute(weekStatsHandler, { weekCode: '2026-W33', caliber: 'campaign' })
  const weekOccurrence = await callRoute(weekStatsHandler, { weekCode: '2026-W33', caliber: 'occurrence' })
  check(
    'week-stats 默认与显式 campaign 返回一致',
    weekDefault.status === 200 && weekCampaign.status === 200 &&
      JSON.stringify(weekDefault.data) === JSON.stringify(weekCampaign.data)
  )
  check(
    'week-stats 显式 occurrence 返回 400',
    weekOccurrence.status === 400 && weekOccurrence.msg.includes('按发生周暂未开放'),
    weekOccurrence.msg
  )
  const exportDefault = await callRoute(exportHandler, { type: 'creator-summary' })
  const exportCampaign = await callRoute(exportHandler, { type: 'creator-summary', caliber: 'campaign' })
  const exportOccurrence = await callRoute(exportHandler, { type: 'creator-summary', caliber: 'occurrence' })
  check(
    'creator-summary 导出默认与 campaign 仍返回 Excel',
    exportDefault.status === 200 && exportCampaign.status === 200 &&
      Buffer.isBuffer(exportDefault.body) && Buffer.isBuffer(exportCampaign.body)
  )
  check(
    'creator-summary 导出显式 occurrence 返回 400',
    exportOccurrence.status === 400 && exportOccurrence.msg.includes('按发生周暂未开放'),
    exportOccurrence.msg
  )

  console.log('\n===== 7. 达人对比边界（2 / 5 / 1 / 6 位）=====')
  const compareModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/creatorCompare.js')).href
  )
  const { canCompareCreators, buildCompareRows } = compareModule
  check('勾选 1 位 → 不可对比并提示', canCompareCreators(1).ok === false && canCompareCreators(1).reason.includes('至少'))
  check('勾选 2 位 → 可对比', canCompareCreators(2).ok === true)
  check('勾选 5 位 → 可对比', canCompareCreators(5).ok === true)
  check('勾选 6 位 → 不可对比并提示', canCompareCreators(6).ok === false && canCompareCreators(6).reason.includes('最多'))
  const allCreators = base.data.creators
  // Phase 5：对比身份 = creator_id（legacy fixture 无 creator_id → 退化为名称键，规则同一份）
  const identityKeyOf = (item) =>
    item.creator_id === null || item.creator_id === undefined
      ? `name:${item.nickname}`
      : `id:${item.creator_id}`
  const picked = allCreators.slice(0, 5)
  const pick5 = picked.map(identityKeyOf)
  const compareRows = buildCompareRows(allCreators, pick5)
  check(
    '对比数据按总花费降序',
    compareRows.every((item, i) => i === 0 || compareRows[i - 1].total_cost >= item.total_cost),
    JSON.stringify(compareRows.map((r) => r.total_cost))
  )
  check(
    '对比只包含所选达人',
    compareRows.length === 5 && compareRows.every((item) => pick5.includes(identityKeyOf(item)))
  )

  console.log('\n===== 8. 导出内容与页面一致（含新增三列）=====')
  const excelModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/excel.js')).href
  )
  const xlsx = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/node_modules/xlsx/xlsx.mjs')).href
  )
  const outFile = path.join(TMP_DIR, '__creator_summary_test.xlsx')
  const exported = excelModule.exportCreatorStatsToExcel(compareRows.slice(0, 3), {
    fileName: outFile,
    sheetName: '达人明细'
  })
  const workbook = xlsx.read(fs.readFileSync(outFile), { type: 'buffer' })
  const sheetRows = xlsx.utils.sheet_to_json(workbook.Sheets['达人明细'], { defval: '' })
  check('导出行数与所选达人一致', exported === 3 && sheetRows.length === 3, `exported=${exported} rows=${sheetRows.length}`)
  check(
    '导出表头为 V2 术语（累计播放量 / 平均播放量 / 爆款数 / 爆款率 / 复投次数 + 7日辅助列）',
    [
      '达人昵称',
      '达人类型',
      '投放次数',
      '总花费',
      '累计播放量',
      '平均播放量',
      '平均CPM',
      '爆款数',
      '爆款率',
      '复投次数',
      '7日播放量',
      '后续新增播放量',
      '7日CPM',
      '7日爆款数',
      '7日爆款率'
    ].every((key) => key in sheetRows[0]),
    Object.keys(sheetRows[0]).join('|')
  )
  check(
    '导出数值与接口一致（累计播放量 / 爆款数 / 平均CPM）',
    String(sheetRows[0]['达人昵称']) === compareRows[0].nickname &&
      Number(sheetRows[0]['累计播放量']) ===
        Number(compareRows[0].latest_play_total ?? compareRows[0].total_play ?? 0) &&
      Number(sheetRows[0]['7日播放量']) ===
        Number(compareRows[0].first_play_sum ?? compareRows[0].first_play_total ?? 0) &&
      Number(sheetRows[0]['爆款数']) ===
        Number(compareRows[0].hit_latest_count ?? compareRows[0].hit_count ?? 0) &&
      Number(sheetRows[0]['平均CPM']) === Number(Number(compareRows[0].avg_cpm).toFixed(2)),
    JSON.stringify(sheetRows[0])
  )

  console.log('\n===== 9. G3：total_summary 最新累计待更新边界 =====')
  const pendingFixtures = [
    {
      label: '有效 + 空值 + 异常',
      keyword: 'G3-mixed',
      rows: [[100, 200], [100, null], [200, 100]],
      expected: { record_count: 3, latest_sample_count: 1, anomaly_count: 1, latest_pending_count: 1 }
    },
    {
      label: '只有异常，没有待更新',
      keyword: 'G3-anomaly',
      rows: [[100, 200], [200, 100]],
      expected: { record_count: 2, latest_sample_count: 1, anomaly_count: 1, latest_pending_count: 0 }
    },
    {
      label: '全部 latest 为空',
      keyword: 'G3-empty',
      rows: [[100, null], [100, null], [100, null]],
      expected: { record_count: 3, latest_sample_count: 0, anomaly_count: 0, latest_pending_count: 3 }
    }
  ]
  for (const fixture of pendingFixtures) {
    db.transaction(() => {
      fixture.rows.forEach(([first, latest], index) => {
        insert.run('2026-W34', `${fixture.keyword}-${index + 1}`, 'G3', 10, '2026-08-26', first, latest)
      })
    })()
    const result = await call({ keyword: fixture.keyword })
    const actual = result.data?.total_summary
    check(
      `total_summary：${fixture.label}`,
      result.status === 200 &&
        result.data.creators.length === fixture.rows.length &&
        Object.entries(fixture.expected).every(([field, value]) => actual[field] === value),
      JSON.stringify({
        record_count: actual?.record_count,
        latest_sample_count: actual?.latest_sample_count,
        anomaly_count: actual?.anomaly_count,
        latest_pending_count: actual?.latest_pending_count
      })
    )
  }

  console.log('\n===== 10. G3：分类精确匹配与原始成本精度 =====')
  insert.run('2026-W34', 'G3-type-exact', '数码', 10, '2026-08-26', 100, 200)
  insert.run('2026-W34', 'G3-type-prefix', '数码测评', 10, '2026-08-26', 100, 200)
  const exactType = await callRoute(listHandler, { creatorType: '数码', keyword: 'G3-type', page: 1, pageSize: 10 })
  check(
    'Records creator_type=数码 只返回精确分类',
    exactType.status === 200 && exactType.data?.total === 1 &&
      exactType.data.list[0]?.nickname === 'G3-type-exact',
    JSON.stringify(exactType.data?.list?.map((item) => item.creator_type))
  )

  const precisionNames = ['G3-precision-1', 'G3-precision-2', 'G3-precision-3']
  for (const name of precisionNames) {
    insert.run('2026-W34', name, 'G3-precision', 1.234, '2026-08-26', 100, 200)
  }
  const preciseCreators = await call({ keyword: 'G3-precision' })
  const preciseDashboard = await callRoute(weekStatsHandler, {
    startWeek: '2026-W34', endWeek: '2026-W34', nicknames: precisionNames.join(',')
  })
  const expectedPrecision = { total_cost: 3.7, avg_cpm: 6.17, cpm_7d: 12.34 }
  const matchesPrecision = (summary) => Object.entries(expectedPrecision).every(
    ([key, value]) => summary?.[key] === value
  )
  check(
    '三位达人原始成本汇总：3.70 / 6.17 / 12.34',
    preciseCreators.status === 200 && preciseCreators.data.creators.length === 3 &&
      matchesPrecision(preciseCreators.data.total_summary),
    JSON.stringify(preciseCreators.data?.total_summary)
  )
  check(
    'CreatorSummary 总汇总与 Dashboard 周汇总一致',
    preciseDashboard.status === 200 && matchesPrecision(preciseDashboard.data?.total_summary) &&
      Object.keys(expectedPrecision).every((key) =>
        preciseCreators.data.total_summary[key] === preciseDashboard.data.total_summary[key]),
    JSON.stringify(preciseDashboard.data?.total_summary)
  )
  check(
    'CreatorSummary 分类组也只在汇总结果处舍入',
    preciseCreators.data.groups.length === 1 && matchesPrecision(preciseCreators.data.groups[0]),
    JSON.stringify(preciseCreators.data?.groups?.[0] && {
      total_cost: preciseCreators.data.groups[0].total_cost,
      avg_cpm: preciseCreators.data.groups[0].avg_cpm,
      cpm_7d: preciseCreators.data.groups[0].cpm_7d
    })
  )
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    process.exitCode = 1
  })
  .finally(() => {
    // 清理隔离数据库（含 WAL / SHM），用户真实库始终未被触碰
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
