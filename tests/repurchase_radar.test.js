#!/usr/bin/env node
/**
 * 复投雷达（V3-alpha P1）回归测试
 *
 * 运行方式：node tests/repurchase_radar.test.js
 * 隔离方式：通过 WORKBENCH_DB_PATH 指向临时数据库（必须先于 import backend/db.js 设置），
 *          测试自行 seed 固定数据集，结束后删除临时库；用户真实库（backend/workbench.db）不被触碰。
 * 特性：不启动服务、不访问网络、不调用 AI；直接驱动只读 route handler。
 *
 * 覆盖：单次达标判定 / 有效样本语义（null、0、latest<first 异常）/ 历史状态规则 /
 *      中位数（奇数与偶数）/ 最近 2 次失准风险 / 分组与确定性排序 / 只读与日期参数边界。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')

// —— 隔离数据库：必须在 import backend/db.js 之前设置
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'repurchase-radar-'))
process.env.WORKBENCH_DB_PATH = path.join(TMP_DIR, 'isolated.db')
// 允许测试注入 current_date（生产环境该参数会被忽略）
process.env.WORKBENCH_TEST_MODE = '1'

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

const REFERENCE_DATE = '2026-09-28'

/**
 * 固定数据集（全部为「累计播放量 = 100000」的整数 CPM 场景，便于手算断言）
 * [time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play]
 */
const SEED = [
  // 雷达甲：3 次 18 / 27 / 46 → passed 2/3；另验证同昵称不同类型时取首条类型（数码）
  ['2026-W33', '雷达甲', '数码', 1800, '2026-08-18', 20000, 100000],
  ['2026-W34', '雷达甲', '美妆', 2700, '2026-08-25', 20000, 100000],
  ['2026-W35', '雷达甲', '美妆', 4600, '2026-09-01', 20000, 100000],
  // 雷达乙：5 次 22 / 26 / 29 / 41 / 48 → passed 3/5（最近 2 次均 > 30 → 风险提示）
  ['2026-W33', '雷达乙', '财经类', 2200, '2026-08-10', 20000, 100000],
  ['2026-W34', '雷达乙', '财经类', 2600, '2026-08-17', 20000, 100000],
  ['2026-W35', '雷达乙', '财经类', 2900, '2026-08-24', 20000, 100000],
  ['2026-W36', '雷达乙', '财经类', 4100, '2026-08-31', 20000, 100000],
  ['2026-W37', '雷达乙', '财经类', 4800, '2026-09-07', 20000, 100000],
  // 雷达丙：4 次 19 / 25 / 38 / 45 → mixed 2/2（偶数样本中位数 = 32）
  ['2026-W33', '雷达丙', '历史类', 1900, '2026-08-11', 20000, 100000],
  ['2026-W34', '雷达丙', '历史类', 2500, '2026-08-18', 20000, 100000],
  ['2026-W35', '雷达丙', '历史类', 3800, '2026-08-25', 20000, 100000],
  ['2026-W36', '雷达丙', '历史类', 4500, '2026-09-01', 20000, 100000],
  // 雷达丁：3 次 22 / 41 / 55 → failed 1/2（最近 2 次均 > 30）
  ['2026-W33', '雷达丁', '数码', 2200, '2026-08-12', 20000, 100000],
  ['2026-W34', '雷达丁', '数码', 4100, '2026-08-19', 20000, 100000],
  ['2026-W35', '雷达丁', '数码', 5500, '2026-08-26', 20000, 100000],
  // 雷达戊：仅 1 次 CPM 24 → insufficient（唯一一次达标也不算历史通过）
  ['2026-W33', '雷达戊', '个人成长类', 2400, '2026-08-13', 20000, 100000],
  // 雷达己：1 条 latest=null（未观察，不得当作 0）+ 1 条 CPM 20 → 有效样本 1 → insufficient
  ['2026-W33', '雷达己', '科普类', 5000, '2026-08-20', 10000, null],
  ['2026-W34', '雷达己', '科普类', 2000, '2026-08-27', 20000, 100000],
  // 雷达庚：1 条 latest=0（真实观测但 CPM 无定义）+ 1 条 CPM 25 → 有效样本 1 → insufficient
  ['2026-W33', '雷达庚', '科普类', 3000, '2026-08-21', 0, 0],
  ['2026-W34', '雷达庚', '科普类', 1000, '2026-08-28', 0, 40000],
  // 雷达辛：latest < first（异常）→ 不进入有效 CPM 判断，也不计入未达标
  ['2026-W33', '雷达辛', '历史类', 5000, '2026-08-22', 120000, 90000],
  // 雷达壬：5 次 10 / 12 / 14 / 40 / 50 → passed 3/2，但最近 2 次均 > 30（风险提示不得篡改历史状态）
  ['2026-W33', '雷达壬', '财经类', 1000, '2026-08-05', 20000, 100000],
  ['2026-W34', '雷达壬', '财经类', 1200, '2026-08-12', 20000, 100000],
  ['2026-W35', '雷达壬', '财经类', 1400, '2026-08-19', 20000, 100000],
  ['2026-W36', '雷达壬', '财经类', 4000, '2026-08-26', 20000, 100000],
  ['2026-W37', '雷达壬', '财经类', 5000, '2026-09-02', 20000, 100000],
  // 边界达人：CPM 30.00（达标边界，含等号）+ 30.01（未达标）→ mixed 1/1
  ['2026-W34', '边界达人', '数码', 3000, '2026-08-15', 20000, 100000],
  ['2026-W35', '边界达人', '数码', 3001, '2026-08-29', 20000, 100000],
  // 排序验证：中位数 25 但最近合作更久的排序丙 应排在 中位数 25 且最近合作的排序甲 之前
  ['2026-W33', '排序乙', '数码', 1800, '2026-09-05', 20000, 100000],
  ['2026-W34', '排序乙', '数码', 2200, '2026-09-05', 20000, 100000],
  ['2026-W32', '排序丙', '数码', 2300, '2026-08-01', 20000, 100000],
  ['2026-W33', '排序丙', '数码', 2700, '2026-08-01', 20000, 100000],
  ['2026-W35', '排序甲', '数码', 2400, '2026-09-03', 20000, 100000],
  ['2026-W36', '排序甲', '数码', 2600, '2026-09-03', 20000, 100000],
  // 无发布日期达人：不影响 CPM 判定，但「最近合作日期 / 距今天数」为 null
  ['2026-W34', '无日期达人', '美妆', 2000, null, 20000, 100000],
  ['2026-W35', '无日期达人', '美妆', 2500, null, 20000, 100000],
  // ---------- 精度边界（raw CPM 判定 / raw 中位数）----------
  // 精度甲：raw CPM 30.004（展示 round2 = 30.00）→ 必须 fail（旧实现会误判达标）
  ['2026-W35', '精度甲', '数码', 3000.4, '2026-08-30', 20000, 100000],
  ['2026-W36', '精度甲', '数码', 3000.4, '2026-09-06', 20000, 100000],
  // 精度乙：raw CPM 29.999（展示 round2 = 30.00）→ 必须 pass
  ['2026-W35', '精度乙', '数码', 2999.9, '2026-08-30', 20000, 100000],
  ['2026-W36', '精度乙', '数码', 2999.9, '2026-09-06', 20000, 100000],
  // 精度丙：raw 10.0000 与 10.0103 → raw 中位数 10.00515 → 10.01（逐条 round2 再取中位数会得到 10.00）
  ['2026-W35', '精度丙', '美妆', 1000, '2026-08-30', 20000, 100000],
  ['2026-W36', '精度丙', '美妆', 1001.03, '2026-09-06', 20000, 100000],
  // 精度丁：最近 2 次 raw CPM 均为 30.004（展示 30.00）→ recent_risk 必须为 true（用展示值判断会漏报）
  ['2026-W34', '精度丁', '历史类', 1000, '2026-08-19', 20000, 100000],
  ['2026-W35', '精度丁', '历史类', 3000.4, '2026-08-26', 20000, 100000],
  ['2026-W36', '精度丁', '历史类', 3000.4, '2026-09-02', 20000, 100000],
  // ---------- 排序精度：raw 中位数不同、展示值相同 ----------
  // 排序精度A：raw 中位数 20.004（展示 20.00），但距上次合作更久
  ['2026-W35', '排序精度A', '数码', 2000.4, '2026-08-01', 20000, 100000],
  ['2026-W36', '排序精度A', '数码', 2000.4, '2026-08-01', 20000, 100000],
  // 排序精度B：raw 中位数 20.001（展示同样是 20.00），距上次合作更近 → 仍必须排在 A 之前
  ['2026-W35', '排序精度B', '数码', 2000.1, '2026-09-05', 20000, 100000],
  ['2026-W36', '排序精度B', '数码', 2000.1, '2026-09-05', 20000, 100000]
]

function localToday() {
  const now = new Date()
  const pad = (num) => String(num).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function main() {
  const recordsModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/records.js')).href
  )
  const db = (await import(pathToFileURL(path.join(REPO_ROOT, 'backend/db.js')).href)).default

  const layer = recordsModule.default.stack.find(
    (item) => item.route && item.route.path === '/repurchase-radar' && item.route.methods.get
  )
  const handler = layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
  const radarRoute = recordsModule.default.stack.find(
    (item) => item.route && item.route.path === '/repurchase-radar'
  )
  check('repurchase-radar GET handler 可用', typeof handler === 'function')
  check(
    'repurchase-radar 只注册 GET（没有写接口）',
    Boolean(radarRoute) && Object.keys(radarRoute.route.methods).join(',') === 'get',
    radarRoute ? Object.keys(radarRoute.route.methods).join(',') : 'route missing'
  )

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
  check(`隔离库 seed 完成（${SEED.length} 条）`, seededCount === SEED.length, `seeded=${seededCount}`)

  const callRoute = async (route, query) => {
    const res = {
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
      setHeader() {
        return this
      },
      send() {}
    }
    await route({ query }, res)
    return { status: res.statusCode, data: res.payload?.data, msg: res.payload?.msg }
  }
  const call = (query = {}) => callRoute(handler, query)
  const byCreator = (group) => Object.fromEntries(group.map((item) => [item.creator, item]))

  console.log('\n===== 1. 结构 / 只读 / 日期参数 =====')
  const base = await call({ current_date: REFERENCE_DATE })
  check('当前目标 CPM = 30', base.data.target_cpm === 30, String(base.data.target_cpm))
  check('使用注入的参考日期（仅测试模式）', base.data.reference_date === REFERENCE_DATE)
  check(
    '返回三个分组且顺序为 优先关注 / 需要观察 / 暂不优先',
    base.data.groups.map((group) => `${group.key}:${group.label}`).join('|') ===
      'priority:优先关注|watch:需要观察|low_priority:暂不优先',
    JSON.stringify(base.data.groups.map((group) => group.key))
  )
  check(
    '汇总字段齐全',
    [
      'creator_count',
      'record_count',
      'valid_cpm_count',
      'priority_count',
      'watch_count',
      'low_priority_count'
    ].every((key) => key in base.data.summary),
    JSON.stringify(base.data.summary)
  )
  check(
    '分组数量与汇总一致',
    base.data.summary.priority_count === base.data.groups[0].count &&
      base.data.summary.watch_count === base.data.groups[1].count &&
      base.data.summary.low_priority_count === base.data.groups[2].count
  )
  check('总达人数 = 20', base.data.summary.creator_count === 20, String(base.data.summary.creator_count))
  check('总历史合作次数 = 49', base.data.summary.record_count === 49, String(base.data.summary.record_count))
  check('总有效 CPM 样本 = 46', base.data.summary.valid_cpm_count === 46, String(base.data.summary.valid_cpm_count))
  check(
    '分组数量 = 11 / 6 / 3',
    base.data.summary.priority_count === 11 &&
      base.data.summary.watch_count === 6 &&
      base.data.summary.low_priority_count === 3,
    `${base.data.summary.priority_count}/${base.data.summary.watch_count}/${base.data.summary.low_priority_count}`
  )
  const rawJson = JSON.stringify(base.data)
  check('响应中不含 NaN / Infinity', !/NaN|Infinity/.test(rawJson))
  check(
    'API 不暴露 raw 中位数（medianCpmRaw / cpmRaw 均为内部字段）',
    !rawJson.includes('medianCpmRaw') && !rawJson.includes('cpmRaw')
  )
  check(
    '每次合作都只统计在所属达人下（记录数守恒）',
    base.data.groups.reduce(
      (sum, group) => sum + group.creators.reduce((acc, item) => acc + item.record_count, 0),
      0
    ) === SEED.length
  )
  check(
    '每条达人数据字段齐全',
    base.data.groups.every((group) =>
      group.creators.every((item) =>
        [
          'creator',
          'creator_type',
          'record_count',
          'valid_cpm_count',
          'pass_count',
          'fail_count',
          'historical_status',
          'historical_status_label',
          'work_priority',
          'work_priority_reason',
          'work_priority_label',
          'single_sample_cpm',
          'median_cpm',
          'last_collaboration_date',
          'days_since_last_collaboration',
          'recent_risk'
        ].every((key) => key in item)
      )
    )
  )

  const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
  await call({ current_date: REFERENCE_DATE })
  const afterCount = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
  check('接口只读：调用前后 creator_records 记录数不变', beforeCount === afterCount, `${beforeCount} -> ${afterCount}`)
  check(
    '接口只读：未写入批次日志（import_batches 仍为 0）',
    db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n === 0
  )

  const priority = base.data.groups[0].creators
  const watch = base.data.groups[1].creators
  const lowPriority = base.data.groups[2].creators
  const inPriority = byCreator(priority)
  const inWatch = byCreator(watch)
  const inLow = byCreator(lowPriority)

  console.log('\n===== 2. 单次达标与历史状态规则（3 次 18 / 27 / 46 → passed 2/3）=====')
  const jia = inPriority['雷达甲']
  check('雷达甲 历史合作 = 3', jia?.record_count === 3, String(jia?.record_count))
  check('雷达甲 有效 CPM 样本 = 3', jia?.valid_cpm_count === 3, String(jia?.valid_cpm_count))
  check('雷达甲 达标 2 / 未达标 1', jia?.pass_count === 2 && jia?.fail_count === 1)
  check('雷达甲 historical_status = passed', jia?.historical_status === 'passed', jia?.historical_status)
  check('雷达甲 中位数 = 27（奇数样本）', jia?.median_cpm === 27, String(jia?.median_cpm))
  check(
    '雷达甲 同昵称不同类型时取首条类型（数码）',
    jia?.creator_type === '数码',
    jia?.creator_type
  )

  console.log('\n===== 3. 5 次 22 / 26 / 29 / 41 / 48 → passed 3/5 =====')
  const yi = inPriority['雷达乙']
  check('雷达乙 达标 3 / 未达标 2', yi?.pass_count === 3 && yi?.fail_count === 2)
  check('雷达乙 historical_status = passed', yi?.historical_status === 'passed', yi?.historical_status)
  check('雷达乙 中位数 = 29', yi?.median_cpm === 29, String(yi?.median_cpm))

  console.log('\n===== 4. 4 次 19 / 25 / 38 / 45 → mixed（平局不是平均值决胜）=====')
  const bing = inWatch['雷达丙']
  check('雷达丙 达标 2 / 未达标 2', bing?.pass_count === 2 && bing?.fail_count === 2)
  check('雷达丙 historical_status = mixed', bing?.historical_status === 'mixed', bing?.historical_status)
  check(
    '雷达丙 中位数 = 31.5（偶数样本取中间两项 25 / 38 的平均）',
    bing?.median_cpm === 31.5,
    String(bing?.median_cpm)
  )

  console.log('\n===== 5. 3 次 22 / 41 / 55 → failed =====')
  const ding = inLow['雷达丁']
  check('雷达丁 达标 1 / 未达标 2', ding?.pass_count === 1 && ding?.fail_count === 2)
  check('雷达丁 historical_status = failed', ding?.historical_status === 'failed', ding?.historical_status)
  check('雷达丁 位于「暂不优先」分组', Boolean(ding) && !inPriority['雷达丁'] && !inWatch['雷达丁'])

  console.log('\n===== 6. 仅 1 次 CPM 24 → insufficient（不得进入 passed）=====')
  const wu = inWatch['雷达戊']
  check('雷达戊 有效样本 = 1', wu?.valid_cpm_count === 1, String(wu?.valid_cpm_count))
  check('雷达戊 达标次数仍记录为 1', wu?.pass_count === 1, String(wu?.pass_count))
  check('雷达戊 historical_status = insufficient', wu?.historical_status === 'insufficient', wu?.historical_status)
  check('雷达戊 不在「优先关注」分组', !inPriority['雷达戊'])

  console.log('\n===== 7. latest = null → 不进入有效 CPM 分母 =====')
  const ji = inWatch['雷达己']
  check('雷达己 历史合作 = 2（未观察记录仍计入合作次数）', ji?.record_count === 2, String(ji?.record_count))
  check('雷达己 有效 CPM 样本 = 1（null 不算 0）', ji?.valid_cpm_count === 1, String(ji?.valid_cpm_count))
  check('雷达己 historical_status = insufficient', ji?.historical_status === 'insufficient', ji?.historical_status)

  console.log('\n===== 8. latest = 0 保持 V2 语义（真实观测但 CPM 无定义）=====')
  const geng = inWatch['雷达庚']
  check('雷达庚 历史合作 = 2', geng?.record_count === 2, String(geng?.record_count))
  check('雷达庚 有效 CPM 样本 = 1（latest=0 不参与 CPM）', geng?.valid_cpm_count === 1, String(geng?.valid_cpm_count))
  check('雷达庚 中位数 = 25（仅真实有效样本）', geng?.median_cpm === 25, String(geng?.median_cpm))
  check(
    '雷达庚 未被误判为「未达标」',
    geng?.fail_count === 0 && geng?.pass_count === 1,
    `pass=${geng?.pass_count} fail=${geng?.fail_count}`
  )

  console.log('\n===== 9. latest < first 异常 → 不进入累计 CPM 判断 =====')
  const xin = inWatch['雷达辛']
  check('雷达辛 历史合作 = 1', xin?.record_count === 1, String(xin?.record_count))
  check('雷达辛 有效 CPM 样本 = 0', xin?.valid_cpm_count === 0, String(xin?.valid_cpm_count))
  check('雷达辛 不计入达标也不计入未达标', xin?.pass_count === 0 && xin?.fail_count === 0)
  check('雷达辛 中位数为 null（不是 0）', xin?.median_cpm === null, String(xin?.median_cpm))
  check('雷达辛 historical_status = insufficient', xin?.historical_status === 'insufficient', xin?.historical_status)

  console.log('\n===== 10. 达标边界（CPM = 30 达标，30.01 未达标）=====')
  const boundary = inWatch['边界达人']
  check(
    '边界达人 达标 1（30.00 含等号）/ 未达标 1',
    boundary?.pass_count === 1 && boundary?.fail_count === 1,
    `pass=${boundary?.pass_count} fail=${boundary?.fail_count}`
  )
  check('边界达人 historical_status = mixed', boundary?.historical_status === 'mixed', boundary?.historical_status)

  console.log('\n===== 11. 最近 2 次均未达标 → recent_risk（不得篡改历史状态）=====')
  check('雷达乙 recent_risk = true', yi?.recent_risk === true)
  check('雷达乙 历史状态仍为 passed', yi?.historical_status === 'passed', yi?.historical_status)
  check('雷达乙 风险文案存在', yi?.recent_risk_text === '最近2次合作均未达到 CPM 30', yi?.recent_risk_text)
  const ren = inPriority['雷达壬']
  check('雷达壬 达标 3 / 未达标 2', ren?.pass_count === 3 && ren?.fail_count === 2)
  check('雷达壬 最近 2 次失准 → recent_risk = true', ren?.recent_risk === true)
  check('雷达壬 历史状态仍为 passed（风险提示不改资格）', ren?.historical_status === 'passed', ren?.historical_status)
  check('雷达甲 最近 2 次含达标 → recent_risk = false', jia?.recent_risk === false)
  check('雷达丁 最近 2 次均失准 → recent_risk = true', ding?.recent_risk === true)
  check('雷达戊 样本不足 → recent_risk = false', wu?.recent_risk === false)

  console.log('\n===== 12. 分组排序（中位 CPM 升序 → 距上次合作更久优先）=====')
  const medians = priority.map((item) => item.median_cpm)
  check(
    '「优先关注」中位 CPM 升序（null 排最后）',
    medians.every((value, i) => {
      if (i === 0) return true
      const prev = medians[i - 1]
      if (prev === null || prev === undefined) return value === null || value === undefined
      if (value === null || value === undefined) return true
      return prev <= value
    }),
    JSON.stringify(medians)
  )
  const indexOfPriority = (name) => priority.findIndex((item) => item.creator === name)
  check(
    '中位数更低者优先（排序乙 20 < 排序丙/排序甲 25）',
    indexOfPriority('排序乙') >= 0 &&
      indexOfPriority('排序乙') < indexOfPriority('排序丙') &&
      indexOfPriority('排序乙') < indexOfPriority('排序甲'),
    `乙=${indexOfPriority('排序乙')} 丙=${indexOfPriority('排序丙')} 甲=${indexOfPriority('排序甲')}`
  )
  check(
    '中位数相同则距上次合作更久者优先（排序丙 08-01 早于 排序甲 09-03）',
    indexOfPriority('排序丙') < indexOfPriority('排序甲'),
    `丙=${indexOfPriority('排序丙')} 甲=${indexOfPriority('排序甲')}`
  )
  const sameMedianPair = [inPriority['排序丙'], inPriority['排序甲']]
  check(
    '排序依据可复现（中位数相同、距今更久更大）',
    sameMedianPair[0]?.median_cpm === sameMedianPair[1]?.median_cpm &&
      sameMedianPair[0]?.days_since_last_collaboration >
        sameMedianPair[1]?.days_since_last_collaboration
  )
  const secondCall = await call({ current_date: REFERENCE_DATE })
  check(
    '两次调用顺序完全一致（稳定排序）',
    JSON.stringify(secondCall.data.groups) === JSON.stringify(base.data.groups)
  )
  // Alpha.2 B1 起，「需要观察」内先按工作优先级（高注意力优先），同层才有证据的（mixed）先于证据不足
  check(
    '「需要观察」内先按 work_priority 排序，同层 mixed 先于 insufficient',
    (() => {
      const rank = (value) => ({ high_attention: 0, medium_attention: 1, normal_attention: 2 })[value] ?? 3
      const ranks = watch.map((item) => rank(item.work_priority))
      const sortedByPriority = ranks.every((value, i) => i === 0 || ranks[i - 1] <= value)
      const sameRankStatuses = watch.map((item) => `${rank(item.work_priority)}:${item.historical_status}`)
      // 同一优先级层内：mixed 必须排在 insufficient 之前
      const firstInsufficientNormal = sameRankStatuses.indexOf('2:insufficient')
      const lastMixedNormal = sameRankStatuses.lastIndexOf('2:mixed')
      return sortedByPriority && (firstInsufficientNormal === -1 || lastMixedNormal < firstInsufficientNormal)
    })(),
    JSON.stringify(watch.map((item) => `${item.creator}:${item.work_priority}:${item.historical_status}`))
  )

  console.log('\n===== 12c. 排序精度：raw 中位数不同但展示值相同 =====')
  const sortA = inPriority['排序精度A']
  const sortB = inPriority['排序精度B']
  check(
    '排序精度A 展示 20.00（raw 中位数 20.004）',
    sortA?.median_cpm === 20,
    String(sortA?.median_cpm)
  )
  check(
    '排序精度B 展示 20.00（raw 中位数 20.001）',
    sortB?.median_cpm === 20,
    String(sortB?.median_cpm)
  )
  check(
    '两者展示值完全相同（旧实现会把它们视为并列）',
    sortA?.median_cpm === sortB?.median_cpm,
    `${sortA?.median_cpm} / ${sortB?.median_cpm}`
  )
  check(
    '排序精度A 距上次合作确实更久',
    sortA?.days_since_last_collaboration > sortB?.days_since_last_collaboration,
    `${sortA?.days_since_last_collaboration} 天 vs ${sortB?.days_since_last_collaboration} 天`
  )
  check(
    'raw 中位数更低的 排序精度B 排在 排序精度A 之前（不受距今天数影响）',
    indexOfPriority('排序精度B') < indexOfPriority('排序精度A'),
    `B=${indexOfPriority('排序精度B')} A=${indexOfPriority('排序精度A')}`
  )
  const priorityOrderNames = priority.map((item) => item.creator)
  check(
    '排序精度B 与 排序精度A 相邻且 B 在前（两者之间没有其他达人插队）',
    Math.abs(indexOfPriority('排序精度B') - indexOfPriority('排序精度A')) === 1 &&
      priorityOrderNames[indexOfPriority('排序精度B') + 1] === '排序精度A',
    JSON.stringify(priorityOrderNames.slice(0, 6))
  )
  check(
    'raw 中位数完全相同时才按距上次合作降序（排序丙 23/27 与 排序甲 24/26 raw 中位数均为 25）',
    inPriority['排序丙']?.median_cpm === inPriority['排序甲']?.median_cpm &&
      indexOfPriority('排序丙') < indexOfPriority('排序甲') &&
      inPriority['排序丙']?.days_since_last_collaboration >
        inPriority['排序甲']?.days_since_last_collaboration,
    `丙=${indexOfPriority('排序丙')} 甲=${indexOfPriority('排序甲')}`
  )

  console.log('\n===== 12b. 精度边界：raw CPM 判定 / raw 中位数（禁止先 round2）=====')
  const round2 = (value) => Number(value.toFixed(2))

  // 1) raw CPM 30.004：展示会被 round2 成 30.00，但必须判 fail
  const raw30004 = recordsModule.computeRecordLatestCpm({
    total_cost: 3000.4,
    first_play: 20000,
    second_week_play: 100000
  })
  check(
    'helper 返回 raw CPM（30.004 未被 round2）',
    raw30004 > 30 && raw30004 !== 30,
    String(raw30004)
  )
  check('raw 30.004 的展示值确为 30.00', Number(raw30004.toFixed(2)) === 30, raw30004.toFixed(2))
  const jingJia = inLow['精度甲']
  check(
    '精度甲（2 次 raw 30.004）→ 0 达标 / 2 未达标（禁止被展示值误判为达标）',
    jingJia?.pass_count === 0 && jingJia?.fail_count === 2,
    `pass=${jingJia?.pass_count} fail=${jingJia?.fail_count}`
  )
  check('精度甲 historical_status = failed', jingJia?.historical_status === 'failed', jingJia?.historical_status)
  check(
    '精度甲 median_cpm 输出仍是 30（页面展示 30.00）',
    jingJia?.median_cpm === 30,
    String(jingJia?.median_cpm)
  )

  // 2) raw CPM 29.999：展示同样 30.00，但必须判 pass
  const raw29999 = recordsModule.computeRecordLatestCpm({
    total_cost: 2999.9,
    first_play: 20000,
    second_week_play: 100000
  })
  check('helper 返回 raw CPM（29.999 未被 round2）', raw29999 < 30, String(raw29999))
  check('raw 29.999 的展示值确为 30.00', Number(raw29999.toFixed(2)) === 30, raw29999.toFixed(2))
  const jingYi = inPriority['精度乙']
  check(
    '精度乙（2 次 raw 29.999）→ 2 达标 / 0 未达标',
    jingYi?.pass_count === 2 && jingYi?.fail_count === 0,
    `pass=${jingYi?.pass_count} fail=${jingYi?.fail_count}`
  )
  check('精度乙 historical_status = passed', jingYi?.historical_status === 'passed', jingYi?.historical_status)
  check(
    '精度甲 / 精度乙 展示值同为 30 但判定相反（证明判定基于 raw）',
    jingJia?.median_cpm === 30 &&
      jingYi?.median_cpm === 30 &&
      jingJia?.historical_status === 'failed' &&
      jingYi?.historical_status === 'passed'
  )

  // 3) 中位数：raw 中位数后 round2 ≠（先逐条 round2 再取中位数）
  const rawLow = (1000 / 100000) * 1000 // 10.0000
  const rawHigh = (1001.03 / 100000) * 1000 // 10.0103
  const medianRawThenRound = round2((rawLow + rawHigh) / 2) // 10.00515 → 10.01
  const medianOfRounded = round2((round2(rawLow) + round2(rawHigh)) / 2) // (10.00 + 10.01)/2 → 10.00
  check(
    '构造案例确实能区分两种中位数算法',
    medianRawThenRound !== medianOfRounded,
    `raw 中位数后 round2=${medianRawThenRound}　逐条 round2 后中位数=${medianOfRounded}`
  )
  const jingBing = inPriority['精度丙']
  check(
    '精度丙 median_cpm 采用 raw 中位数后 round2（10.01），不是 10.00',
    jingBing?.median_cpm === medianRawThenRound && jingBing?.median_cpm === 10.01,
    `median_cpm=${jingBing?.median_cpm}`
  )

  // 4) recent_risk 同样基于 raw CPM
  const jingDing = inLow['精度丁']
  check(
    '精度丁 达标 1 / 未达标 2（首条 raw 10.00 达标）',
    jingDing?.pass_count === 1 && jingDing?.fail_count === 2,
    `pass=${jingDing?.pass_count} fail=${jingDing?.fail_count}`
  )
  check(
    '精度丁 最近 2 次 raw 均 > 30（展示 30.00）→ recent_risk = true',
    jingDing?.recent_risk === true
  )
  check(
    '（防回归）raw 30.004 与展示值 30.00 的判定方向确实相反',
    raw30004 > 30 && round2(raw30004) <= 30,
    `raw=${raw30004} 展示=${round2(raw30004)}`
  )

  console.log('\n===== 13. 日期语义（publish_date / 距今天数 / 时区安全）=====')
  check(
    '雷达甲 最近合作日期 = 2026-09-01',
    jia?.last_collaboration_date === '2026-09-01',
    jia?.last_collaboration_date
  )
  check(
    '雷达甲 距上次合作 = 27 天（参考日 2026-09-28）',
    jia?.days_since_last_collaboration === 27,
    String(jia?.days_since_last_collaboration)
  )
  const noDate = inPriority['无日期达人']
  check('无 publish_date 达人：最近合作日期为 null', noDate?.last_collaboration_date === null)
  check('无 publish_date 达人：距今天数为 null', noDate?.days_since_last_collaboration === null)
  check(
    '无 publish_date 达人：CPM 判定不受影响（passed）',
    noDate?.historical_status === 'passed' && noDate?.median_cpm === 22.5,
    `${noDate?.historical_status}/${noDate?.median_cpm}`
  )
  const invalidDate = await call({ current_date: '2026-13-45' })
  check('测试模式下非法 current_date → 400', invalidDate.status === 400, String(invalidDate.status))

  delete process.env.WORKBENCH_TEST_MODE
  const productionCall = await call({ current_date: '2026-01-01' })
  check(
    '非测试模式：current_date 被忽略，使用服务端本地日期',
    productionCall.data.reference_date === localToday(),
    `${productionCall.data.reference_date} / today=${localToday()}`
  )
  process.env.WORKBENCH_TEST_MODE = '1'

  console.log('\n===== 14. 空数据边界 =====')
  db.prepare('DELETE FROM creator_records').run()
  const empty = await call({ current_date: REFERENCE_DATE })
  check(
    '空库：三个分组均为空且计数为 0',
    empty.data.groups.every((group) => group.count === 0 && group.creators.length === 0) &&
      empty.data.summary.creator_count === 0 &&
      empty.data.summary.record_count === 0
  )

  console.log('\n===== 15. Alpha.2：主表「数据观察日期」展示语义 =====')
  const saveLib = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/recentPerformanceSave.js')).href
  )
  const { formatObservedAtHint } = saveLib
  check('已导出主表日期展示纯函数', typeof formatObservedAtHint === 'function')
  check(
    '有快照 + observed_at=2026-09-29 → 「数据截至 09-29」（只取月日）',
    formatObservedAtHint({ observed_at: '2026-09-29' }) === '数据截至 09-29',
    formatObservedAtHint({ observed_at: '2026-09-29' })
  )
  check(
    '有快照但 observed_at=null → 「观察日期未知」（旧 Alpha.1 快照）',
    formatObservedAtHint({ observed_at: null }) === '观察日期未知' &&
      formatObservedAtHint({ observed_at: '' }) === '观察日期未知' &&
      formatObservedAtHint({ observed_at: undefined }) === '观察日期未知'
  )
  check(
    '没有快照 → 空字符串（保持「尚未更新」，不追加观察日期）',
    formatObservedAtHint(null) === '' && formatObservedAtHint(undefined) === '',
    JSON.stringify(formatObservedAtHint(null))
  )
  check(
    '不可解析的 observed_at 不猜日期 → 「观察日期未知」',
    formatObservedAtHint({ observed_at: '2026/09/29' }) === '观察日期未知' &&
      formatObservedAtHint({ observed_at: '2026-9-29' }) === '观察日期未知'
  )
  check(
    '日期不做时区换算（01-01 不会因 UTC 变成 12-31）',
    formatObservedAtHint({ observed_at: '2026-01-01' }) === '数据截至 01-01'
  )
  const saveUtilSource = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/utils/recentPerformanceSave.js'),
    'utf8'
  )
  const hintFnSource = saveUtilSource.slice(saveUtilSource.indexOf('export function formatObservedAtHint'))
  check(
    '展示函数不使用 Date / toISOString（避免 ±1 天）',
    !/new Date\(|toISOString\(|getTimezoneOffset/.test(hintFnSource.slice(0, 600))
  )
  const radarPageSource = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/pages/RepurchaseRadar/index.jsx'),
    'utf8'
  )
  check(
    '雷达主表渲染该提示（Alpha.3 起改由「近期表现」独立列接入，语义未变）',
    /buildRecentPerformanceCell\(record\.recent_snapshot\)/.test(radarPageSource) &&
      /\{cell\.observedHint && <div style=\{SECONDARY_TEXT_STYLE\}>\{cell\.observedHint\}<\/div>\}/.test(radarPageSource) &&
      /formatObservedAtHint\(snapshot\)/.test(
        fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/utils/radarRowDisplay.js'), 'utf8')
      )
  )
  check(
    'Alpha.3 第一屏列结构：8 列（近期表现独立成列 + Alpha.3-04 商单/日常列），列宽常量随之更新',
    /const RADAR_TABLE_WIDTH = 934/.test(radarPageSource) &&
      (radarPageSource.match(/title: '/g) || []).length === 8,
    `columnTitles=${(radarPageSource.match(/title: '/g) || []).length}`
  )

  console.log('\n===== 16. Alpha.2 B1：工作优先级（只分配注意力，不改变历史证据结论）=====')
  db.prepare('DELETE FROM creator_records').run()
  // 单样本阈值边界全部覆盖（累计播放量统一 100000，便于手算：CPM = cost / 100）
  const B1_SEED = [
    // 单样本 CPM 8 → high_attention
    ['2026-W33', '优先级甲', '数码', 800, '2026-08-10', 20000, 100000],
    // 单样本 CPM 10（含等号）→ high_attention
    ['2026-W33', '优先级乙', '数码', 1000, '2026-08-10', 20000, 100000],
    // 单样本 raw 10.0001（展示 round2 = 10）→ 必须按 raw 判为 medium_attention
    ['2026-W34', '优先级丙', '数码', 1000.01, '2026-08-17', 20000, 100000],
    // 单样本 CPM 20（含等号）→ medium_attention
    ['2026-W35', '优先级丁', '数码', 2000, '2026-08-24', 20000, 100000],
    // 单样本 raw 20.0001（展示 round2 = 20）→ 必须按 raw 判为 normal_attention
    ['2026-W36', '优先级戊', '数码', 2000.01, '2026-08-31', 20000, 100000],
    // 单样本 CPM 99.99 → normal_attention
    ['2026-W37', '优先级己', '数码', 9999, '2026-09-07', 20000, 100000],
    // 单样本 CPM 100（含等号）→ low_priority（移入「暂不优先」）
    ['2026-W38', '优先级庚', '数码', 10000, '2026-09-14', 20000, 100000],
    // 单样本 CPM 150 → low_priority
    ['2026-W39', '优先级辛', '数码', 15000, '2026-09-21', 20000, 100000],
    // 没有有效样本（累计播放量未填）→ normal_attention，仍留在「需要观察」
    ['2026-W39', '优先级壬', '数码', 5000, '2026-09-21', 20000, null],
    // 多样本 passed（15 / 25）→ high_attention，但仍按原 P1 多数规则判定
    ['2026-W37', '多样本甲', '美妆', 1500, '2026-08-10', 20000, 100000],
    ['2026-W38', '多样本甲', '美妆', 2500, '2026-08-17', 20000, 100000],
    // 多样本 mixed（10 / 50）→ normal_attention
    ['2026-W37', '多样本乙', '美妆', 1000, '2026-08-10', 20000, 100000],
    ['2026-W38', '多样本乙', '美妆', 5000, '2026-08-17', 20000, 100000],
    // 多样本 failed（40 / 50 / 60）→ low_priority，无单样本标记
    ['2026-W37', '多样本丙', '美妆', 4000, '2026-08-10', 20000, 100000],
    ['2026-W38', '多样本丙', '美妆', 5000, '2026-08-17', 20000, 100000],
    ['2026-W39', '多样本丙', '美妆', 6000, '2026-08-24', 20000, 100000]
  ]
  db.transaction(() => {
    for (const row of B1_SEED) insert.run(...row)
  })()
  const b1 = await call({ current_date: REFERENCE_DATE })
  const b1Priority = byCreator(b1.data.groups[0].creators)
  const b1Watch = byCreator(b1.data.groups[1].creators)
  const b1Low = byCreator(b1.data.groups[2].creators)

  check(
    'B1-1 单样本 CPM 8 → evidence 仍 insufficient，但 work_priority = high_attention（留在需要观察）',
    b1Watch['优先级甲']?.historical_status === 'insufficient' &&
      b1Watch['优先级甲']?.work_priority === 'high_attention' &&
      b1Watch['优先级甲']?.work_priority_reason === 'single_sample_cpm_le_10' &&
      b1Watch['优先级甲']?.work_priority_label === '单次表现突出' &&
      b1Watch['优先级甲']?.single_sample_cpm === 8 &&
      !b1Priority['优先级甲'] &&
      !b1Low['优先级甲']
  )
  check(
    'B1-2 单样本 CPM = 10（含等号）→ high_attention',
    b1Watch['优先级乙']?.work_priority === 'high_attention' &&
      b1Watch['优先级乙']?.single_sample_cpm === 10
  )
  check(
    'B1-3 单样本 raw 10.0001（展示 10）→ medium_attention（raw 判定，不是展示值）',
    b1Watch['优先级丙']?.work_priority === 'medium_attention' &&
      b1Watch['优先级丙']?.work_priority_reason === 'single_sample_cpm_le_20' &&
      b1Watch['优先级丙']?.single_sample_cpm === 10 &&
      b1Watch['优先级丙']?.work_priority_label === '优先补数据'
  )
  check(
    'B1-4 单样本 CPM = 20（含等号）→ medium_attention',
    b1Watch['优先级丁']?.work_priority === 'medium_attention'
  )
  check(
    'B1-5 单样本 raw 20.0001（展示 20）→ normal_attention',
    b1Watch['优先级戊']?.work_priority === 'normal_attention' &&
      b1Watch['优先级戊']?.work_priority_reason === 'single_sample_cpm_normal' &&
      b1Watch['优先级戊']?.work_priority_label === null
  )
  check(
    'B1-6 单样本 CPM 99.99 → normal_attention（无标记）',
    b1Watch['优先级己']?.work_priority === 'normal_attention' &&
      b1Watch['优先级己']?.work_priority_label === null
  )
  check(
    'B1-7 单样本 CPM = 100 → low_priority，移入「暂不优先」，evidence 仍是 insufficient',
    b1Low['优先级庚']?.work_priority === 'low_priority' &&
      b1Low['优先级庚']?.work_priority_reason === 'single_sample_cpm_ge_100' &&
      b1Low['优先级庚']?.work_priority_label === '单次合作明显低效' &&
      b1Low['优先级庚']?.historical_status === 'insufficient' &&
      !b1Watch['优先级庚'] &&
      !b1Priority['优先级庚']
  )
  check(
    'B1-8 单样本 CPM 150 → 同样进入「暂不优先」',
    b1Low['优先级辛']?.work_priority === 'low_priority' && !b1Watch['优先级辛']
  )
  check(
    'B1-9 无有效样本 → insufficient + normal_attention（不做正负判断），仍在需要观察',
    b1Watch['优先级壬']?.valid_cpm_count === 0 &&
      b1Watch['优先级壬']?.historical_status === 'insufficient' &&
      b1Watch['优先级壬']?.work_priority === 'normal_attention' &&
      b1Watch['优先级壬']?.work_priority_reason === 'no_valid_sample' &&
      b1Watch['优先级壬']?.single_sample_cpm === null
  )
  check(
    'B1-10 多样本 passed（15 / 25）→ 原 P1 结论不变 + high_attention',
    b1Priority['多样本甲']?.historical_status === 'passed' &&
      b1Priority['多样本甲']?.pass_count === 2 &&
      b1Priority['多样本甲']?.work_priority === 'high_attention' &&
      b1Priority['多样本甲']?.work_priority_reason === 'multi_sample_passed' &&
      b1Priority['多样本甲']?.work_priority_label === null &&
      b1Priority['多样本甲']?.single_sample_cpm === null
  )
  check(
    'B1-11 多样本 mixed（10 / 50）→ 原结论不变（mixed）+ normal_attention',
    b1Watch['多样本乙']?.historical_status === 'mixed' &&
      b1Watch['多样本乙']?.pass_count === 1 &&
      b1Watch['多样本乙']?.fail_count === 1 &&
      b1Watch['多样本乙']?.work_priority === 'normal_attention' &&
      b1Watch['多样本乙']?.work_priority_reason === 'multi_sample_mixed'
  )
  check(
    'B1-12 多样本 failed（40 / 50 / 60）→ 原结论不变（failed）+ low_priority，无单样本标记',
    b1Low['多样本丙']?.historical_status === 'failed' &&
      b1Low['多样本丙']?.pass_count === 0 &&
      b1Low['多样本丙']?.fail_count === 3 &&
      b1Low['多样本丙']?.work_priority === 'low_priority' &&
      b1Low['多样本丙']?.work_priority_reason === 'multi_sample_failed' &&
      b1Low['多样本丙']?.work_priority_label === null
  )
  check(
    'B1-13 单样本高 / 中 / 普通不会改变「优先关注」资格（证据不足一律不进 priority）',
    b1Priority['优先级甲'] === undefined &&
      b1Priority['优先级乙'] === undefined &&
      b1Priority['优先级丙'] === undefined &&
      b1Priority['优先级丁'] === undefined
  )
  check(
    'B1-14 分组归属：需要观察 = insufficient(非低效) + mixed；暂不优先 = failed + 单样本低效',
    b1.data.groups[0].count === 1 &&
      b1.data.groups[1].count === 8 &&
      b1.data.groups[2].count === 3 &&
      b1.data.summary.watch_count === 8 &&
      b1.data.summary.low_priority_count === 3,
    `${b1.data.groups[0].count}/${b1.data.groups[1].count}/${b1.data.groups[2].count}`
  )
  check(
    'B1-15 「需要观察」内 work_priority 顺序 high → medium → normal',
    (() => {
      const rank = (value) => ({ high_attention: 0, medium_attention: 1, normal_attention: 2 })[value] ?? 3
      const ranks = b1.data.groups[1].creators.map((item) => rank(item.work_priority))
      return ranks.every((value, i) => i === 0 || ranks[i - 1] <= value)
    })(),
    JSON.stringify(b1.data.groups[1].creators.map((item) => `${item.creator}:${item.work_priority}`))
  )
  check(
    'B1-16 同层（normal）内单样本按 raw 单次 CPM 升序（20.0001 → 99.99 → 无样本排最后）',
    (() => {
      const names = b1.data.groups[1].creators.map((item) => item.creator)
      const idx = (name) => names.indexOf(name)
      return idx('优先级戊') < idx('优先级己') && idx('优先级己') < idx('优先级壬')
    })(),
    JSON.stringify(b1.data.groups[1].creators.map((item) => item.creator))
  )
  check(
    'B1-17 work_priority 枚举与排序说明冻结在 API（前端不重新推导）',
    b1.data.groups.every((group) =>
      group.creators.every((item) =>
        ['high_attention', 'medium_attention', 'normal_attention', 'low_priority'].includes(item.work_priority)
      )
    ) && /work_priority\(high→medium→normal\)/.test(b1.data.sort.watch)
  )
  check(
    'B1-18 纯函数 computeWorkPriority 边界可直接验证（10 / 20 / 100 含等号）',
    recordsModule.computeWorkPriority({ validCount: 1, status: 'insufficient', singleSampleCpmRaw: 10 }).work_priority === 'high_attention' &&
      recordsModule.computeWorkPriority({ validCount: 1, status: 'insufficient', singleSampleCpmRaw: 10.0000001 }).work_priority === 'medium_attention' &&
      recordsModule.computeWorkPriority({ validCount: 1, status: 'insufficient', singleSampleCpmRaw: 20 }).work_priority === 'medium_attention' &&
      recordsModule.computeWorkPriority({ validCount: 1, status: 'insufficient', singleSampleCpmRaw: 20.0000001 }).work_priority === 'normal_attention' &&
      recordsModule.computeWorkPriority({ validCount: 1, status: 'insufficient', singleSampleCpmRaw: 99.999 }).work_priority === 'normal_attention' &&
      recordsModule.computeWorkPriority({ validCount: 1, status: 'insufficient', singleSampleCpmRaw: 100 }).work_priority === 'low_priority'
  )
  check(
    'B1-19 工作优先级不影响历史证据字段（insufficient 的数量与单次 CPM 无关）',
    b1.data.groups[1].creators.concat(b1.data.groups[2].creators)
      .filter((item) => item.valid_cpm_count < 2)
      .every((item) => item.historical_status === 'insufficient')
  )
  check(
    'B1-20 雷达仍只读 / 无 AI / 无网络（响应无非有限数值）',
    !/NaN|Infinity/.test(JSON.stringify(b1.data)) &&
      db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n === B1_SEED.length &&
      !/fetch\(|axios|deepseek|callProviderVision/i.test(
        fs.readFileSync(path.join(REPO_ROOT, 'backend/routes/records.js'), 'utf8').split("/repurchase-radar'")[1]?.slice(0, 1200) || ''
      )
  )

  console.log('\n===== 17. Alpha.2 B2：雷达检索（前端纯视图过滤）=====')
  const filterLib = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/radarFilters.js')).href
  )
  const radarGroupsBefore = JSON.stringify(b1.data.groups)
  const allCreatorsB1 = b1.data.groups.flatMap((group) => group.creators)
  const filterOver = (filters) => filterLib.filterRadarGroups(b1.data.groups, filters)
  const radarPageB2 = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/pages/RepurchaseRadar/index.jsx'),
    'utf8'
  )
  const filterSource = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/utils/radarFilters.js'),
    'utf8'
  )
  // 只检查可执行代码，注释里出现业务词（historical_status / CPM）不算重算
  const filterCode = filterSource
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n')

  check(
    'B2-1 空搜索 / 全部筛选 → 达人全量（12 位，等于 API summary.creator_count）',
    (() => {
      const { groups, visibleCount } = filterOver({})
      return (
        visibleCount === allCreatorsB1.length &&
        visibleCount === b1.data.summary.creator_count &&
        groups.length === 3
      )
    })(),
    String(filterOver({}).visibleCount)
  )
  check(
    'B2-2 中文 substring「优先级」→ 命中该前缀达人；「样」类匹配按原字符串包含',
    (() => {
      const { visibleCount } = filterOver({ keyword: '优先级' })
      const names = filterOver({ keyword: '优先级' }).groups.flatMap((g) => g.creators.map((c) => c.creator))
      return visibleCount === 9 && names.every((name) => name.includes('优先级')) && filterLib.matchesKeyword('样板达人08', '样')
    })(),
    JSON.stringify(filterOver({ keyword: '优先级' }).groups.flatMap((g) => g.creators.map((c) => c.creator)))
  )
  check(
    'B2-3 英文大小写不敏感 + 首尾空格忽略',
    filterLib.matchesKeyword('B1突出达人', 'b1') &&
      filterLib.matchesKeyword('B1突出达人', '  B1  ') &&
      !filterLib.matchesKeyword('B1突出达人', 'b2') &&
      filterLib.normalizeKeyword('  AbC ') === 'abc' &&
      filterLib.normalizeKeyword(null) === ''
  )
  check(
    'B2-4 group=watch → 只剩需要观察组（且组内顺序不变）',
    (() => {
      const { groups, visibleCount } = filterOver({ groupKey: 'watch' })
      const originalWatch = b1.data.groups[1].creators.map((item) => item.creator)
      return (
        groups.length === 1 &&
        groups[0].key === 'watch' &&
        visibleCount === b1.data.groups[1].count &&
        JSON.stringify(groups[0].creators.map((item) => item.creator)) === JSON.stringify(originalWatch)
      )
    })()
  )
  check(
    'B2-5 group=low_priority → 只剩暂不优先组',
    (() => {
      const { groups, visibleCount } = filterOver({ groupKey: 'low_priority' })
      return groups.length === 1 && groups[0].key === 'low_priority' && visibleCount === b1.data.groups[2].count
    })()
  )
  check(
    'B2-6 work_priority=high_attention → 只保留后端标记为高注意力的达人（前端不重算阈值）',
    (() => {
      const { groups, visibleCount } = filterOver({ workPriority: 'high_attention' })
      const kept = groups.flatMap((g) => g.creators)
      return (
        visibleCount === 3 &&
        kept.every((item) => item.work_priority === 'high_attention') &&
        JSON.stringify(kept.map((item) => item.creator)) ===
          JSON.stringify(['多样本甲', '优先级甲', '优先级乙'])
      )
    })(),
    JSON.stringify(filterOver({ workPriority: 'high_attention' }).groups.flatMap((g) => g.creators.map((c) => c.creator)))
  )
  check(
    'B2-6b 筛选器文案表达「等级」而不是某一 reason（高注意力 / 中注意力 / 普通 / 低优先）',
    JSON.stringify(filterLib.WORK_PRIORITY_FILTER_OPTIONS) ===
      JSON.stringify([
        { value: 'all', label: '全部优先级' },
        { value: 'high_attention', label: '高注意力' },
        { value: 'medium_attention', label: '中注意力' },
        { value: 'normal_attention', label: '普通' },
        { value: 'low_priority', label: '低优先' }
      ]) &&
      // 行内具体原因文案必须保持独立，不被筛选器复用（只看可执行代码，注释说明不算）
      !filterCode.includes('单次表现突出') &&
      !filterCode.includes('优先补数据') &&
      !filterCode.includes('单次合作明显低效') &&
      !filterLib.WORK_PRIORITY_FILTER_OPTIONS.some((option) => /单次|优先补数据|明显低效/.test(option.label))
  )
  check(
    'B2-6c 全部分组 + 高注意力 → 同时包含多样本 passed 与单样本 high_attention',
    (() => {
      const kept = filterOver({ workPriority: 'high_attention' }).groups.flatMap((g) => g.creators)
      const passedHigh = kept.filter((item) => item.historical_status === 'passed')
      const singleSampleHigh = kept.filter((item) => item.valid_cpm_count === 1)
      return (
        passedHigh.length === 1 &&
        passedHigh[0].creator === '多样本甲' &&
        passedHigh[0].work_priority_reason === 'multi_sample_passed' &&
        singleSampleHigh.length === 2 &&
        singleSampleHigh.every((item) => item.work_priority_reason === 'single_sample_cpm_le_10')
      )
    })(),
    JSON.stringify(filterOver({ workPriority: 'high_attention' }).groups.flatMap((g) => g.creators.map((c) => `${c.creator}:${c.work_priority_reason}`)))
  )
  check(
    'B2-6d 需要观察 + 高注意力 → 不含 priority 组的多样本 passed；优先关注 + 高注意力 → 正常出现',
    (() => {
      const watchOnly = filterOver({ groupKey: 'watch', workPriority: 'high_attention' })
      const watchKept = watchOnly.groups.flatMap((g) => g.creators)
      const priorityOnly = filterOver({ groupKey: 'priority', workPriority: 'high_attention' })
      const priorityKept = priorityOnly.groups.flatMap((g) => g.creators)
      return (
        watchOnly.groups.length === 1 &&
        watchOnly.groups[0].key === 'watch' &&
        watchKept.length === 2 &&
        watchKept.every((item) => item.historical_status === 'insufficient') &&
        !watchKept.some((item) => item.creator === '多样本甲') &&
        priorityOnly.groups.length === 1 &&
        priorityKept.length === 1 &&
        priorityKept[0].creator === '多样本甲' &&
        priorityKept[0].work_priority === 'high_attention'
      )
    })(),
    JSON.stringify({
      watch: filterOver({ groupKey: 'watch', workPriority: 'high_attention' }).groups.flatMap((g) => g.creators.map((c) => c.creator)),
      priority: filterOver({ groupKey: 'priority', workPriority: 'high_attention' }).groups.flatMap((g) => g.creators.map((c) => c.creator))
    })
  )
  check(
    'B2-7 group + work_priority 组合（AND）',
    (() => {
      const { groups, visibleCount } = filterOver({ groupKey: 'low_priority', workPriority: 'high_attention' })
      return groups.length === 1 && visibleCount === 0 && groups[0].creators.length === 0
    })()
  )
  check(
    'B2-8 keyword + group + priority 三者组合（AND）',
    (() => {
      const { groups, visibleCount } = filterOver({
        keyword: '优先级',
        groupKey: 'watch',
        workPriority: 'high_attention'
      })
      const kept = groups.flatMap((g) => g.creators).map((item) => item.creator)
      return visibleCount === 2 && JSON.stringify(kept) === JSON.stringify(['优先级甲', '优先级乙'])
    })(),
    JSON.stringify(filterOver({ keyword: '优先级', groupKey: 'watch', workPriority: 'high_attention' }).groups.flatMap((g) => g.creators.map((c) => c.creator)))
  )
  check(
    'B2-9 过滤只缩小范围：保留原分组相对顺序（需要观察组 B1 排序不被打乱）',
    (() => {
      const { groups } = filterOver({ groupKey: 'watch', workPriority: 'normal_attention' })
      const kept = groups[0].creators.map((item) => item.creator)
      const original = b1.data.groups[1].creators
        .filter((item) => item.work_priority === 'normal_attention')
        .map((item) => item.creator)
      return JSON.stringify(kept) === JSON.stringify(original)
    })()
  )
  check(
    'B2-10 空结果（不存在的名字）→ 0 且不报错',
    (() => {
      const { groups, visibleCount } = filterOver({ keyword: '不存在的达人甲乙丙' })
      return visibleCount === 0 && groups.length === 3 && groups.every((group) => group.creators.length === 0)
    })()
  )
  check(
    'B2-11 过滤不修改原始数据（group.count / creators 不被就地改写）',
    JSON.stringify(b1.data.groups) === radarGroupsBefore &&
      filterOver({ keyword: '优先级' }).groups[1].count === b1.data.groups[1].count
  )
  check(
    'B2-12 matched_count 反映命中数，count 仍是全量（清空后恢复全部）',
    (() => {
      const filtered = filterOver({ keyword: '优先级' })
      const cleared = filterOver({ ...filterLib.EMPTY_RADAR_FILTERS })
      return (
        filtered.groups[1].matched_count === 7 &&
        filtered.groups[1].count === 8 &&
        cleared.visibleCount === allCreatorsB1.length &&
        !filterLib.isRadarFilterActive(filterLib.EMPTY_RADAR_FILTERS) &&
        filterLib.isRadarFilterActive({ keyword: '样' }) &&
        filterLib.isRadarFilterActive({ groupKey: 'watch' }) &&
        filterLib.isRadarFilterActive({ workPriority: 'low_priority' })
      )
    })(),
    JSON.stringify({
      matched: filterOver({ keyword: '优先级' }).groups[1].matched_count,
      total: filterOver({ keyword: '优先级' }).groups[1].count
    })
  )
  check(
    'B2-13 显示数量 = 命中数 / API 总达人数量（12 位达人）',
    filterOver({ keyword: '优先级' }).visibleCount === 9 &&
      b1.data.summary.creator_count === 12 &&
      allCreatorsB1.length === 12
  )
  check(
    'B2-14 前端不重算 CPM / work_priority（无阈值常量、无 1000 换算、无状态推导）',
    !/\b(10|20|100)\b/.test(filterCode) &&
      !/\/\s*1000/.test(filterCode) &&
      !/historical_status|median|CPM|cpm|pass_count|fail_count/.test(filterCode) &&
      /item\?\.work_priority === workPriority/.test(filterCode)
  )
  check(
    'B2-15 检索状态是纯视图状态：无写库 / 无网络 / 无 AI；雷达接口本身仍只读',
    !/fetch\(|axios|localStorage|sessionStorage|deepseek/i.test(filterSource) &&
      /const \[filters, setFilters\] = useState\(EMPTY_RADAR_FILTERS\)/.test(radarPageB2) &&
      /filterRadarGroups\(radar\?\.groups \|\| \[\], filters\)/.test(radarPageB2) &&
      /const RADAR_TABLE_WIDTH = \d+/.test(radarPageB2) &&
      db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n === B1_SEED.length &&
      db.prepare('SELECT COUNT(*) AS n FROM creator_negotiation_cases').get().n === 0
  )
  check(
    'B2-16 页面接入检索控件（搜索 / 分组 / 优先级 / 清空筛选 / 结果数量）',
    /placeholder="搜索达人名称"/.test(radarPageB2) &&
      /options=\{RADAR_GROUP_OPTIONS\}/.test(radarPageB2) &&
      /options=\{WORK_PRIORITY_FILTER_OPTIONS\}/.test(radarPageB2) &&
      /清空筛选/.test(radarPageB2) &&
      /显示 \{formatInteger\(visibleCount\)\} \/ \{formatInteger\(totalCount\)\} 位达人/.test(radarPageB2)
  )

  console.log('\n===== 18. Alpha.3 信息架构：近期表现独立列 / 历史 CPM 合并辅助行 =====')
  const rowLib = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/radarRowDisplay.js')).href
  )
  const radarPageA3 = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/pages/RepurchaseRadar/index.jsx'),
    'utf8'
  )

  // ---- 近期表现单元格语义 ----
  const cellNoSnapshot = rowLib.buildRecentPerformanceCell(null)
  check(
    'C1 没有 snapshot → 只显示「尚未更新」（不显示观察日期未知）',
    cellNoSnapshot.hasSnapshot === false &&
      cellNoSnapshot.statusText === '尚未更新' &&
      cellNoSnapshot.observedHint === '' &&
      cellNoSnapshot.playText === ''
  )
  const cellUp = rowLib.buildRecentPerformanceCell({
    stats_status: 'ok',
    median_play: 53000,
    trend_label: 'up',
    observed_at: '2026-09-29'
  })
  check(
    'C2 有 snapshot → 播放值 5.3万 + 箭头 ↑ + 趋势「上升」+ 数据截至 09-29',
    cellUp.hasSnapshot === true &&
      cellUp.isInsufficient === false &&
      cellUp.playText === '5.3万' &&
      cellUp.arrow === '↑' &&
      cellUp.trendText === '上升' &&
      cellUp.observedHint === '数据截至 09-29',
    JSON.stringify(cellUp)
  )
  check(
    'C3 旧快照 observed_at 为 null → 「观察日期未知」（不用 created_at 冒充）',
    rowLib.buildRecentPerformanceCell({
      stats_status: 'ok',
      median_play: 50000,
      trend_label: 'stable',
      observed_at: null,
      created_at: '2026-09-29 08:07:54'
    }).observedHint === '观察日期未知'
  )
  check(
    'C4 snapshot 存在但样本不足 → 主文案「样本不足」，不伪造播放值',
    (() => {
      const cell = rowLib.buildRecentPerformanceCell({ stats_status: 'insufficient', median_play: null, trend_label: 'insufficient', observed_at: '2026-09-29' })
      return cell.hasSnapshot === true && cell.isInsufficient === true && cell.playText === '' && cell.statusText === '样本不足' && cell.observedHint === '数据截至 09-29'
    })()
  )
  check(
    'C5 趋势箭头：up ↑ / down ↓ / stable → / insufficient 空（文字仍由 trend_label 决定）',
    rowLib.getTrendArrow('up') === '↑' &&
      rowLib.getTrendArrow('down') === '↓' &&
      rowLib.getTrendArrow('stable') === '→' &&
      rowLib.getTrendArrow('insufficient') === '' &&
      rowLib.getTrendArrow(undefined) === ''
  )

  // ---- 历史 CPM 主值 + 辅助解释行 ----
  check(
    'C6 历史 CPM 辅助行 =「X/Y 次可计算 · X/Y 达标」（有效样本不再单独占列）',
    rowLib.formatCpmCoverageLine({ recordCount: 3, validCpmCount: 2, passCount: 2 }) === '2/3 次可计算 · 2/2 达标' &&
      rowLib.formatCpmCoverageLine({ recordCount: 5, validCpmCount: 5, passCount: 3 }) === '5/5 次可计算 · 3/5 达标'
  )
  check(
    'C7 0 是真实数值：0 次可计算 / 0 达标 照常显示（不表达「其他投放无效」）',
    rowLib.formatCpmCoverageLine({ recordCount: 3, validCpmCount: 0, passCount: 0 }) === '0/3 次可计算' &&
      rowLib.formatCpmCoverageLine({ recordCount: 1, validCpmCount: 1, passCount: 0 }) === '1/1 次可计算 · 0/1 达标'
  )
  check(
    'C8 历史 CPM 主值：median=0 → "0.0"（不是空值）；null → 空（页面显示占位 -）',
    rowLib.formatMedianCpmValue(0) === '0.0' &&
      rowLib.formatMedianCpmValue(18.6) === '18.6' &&
      rowLib.formatMedianCpmValue(null) === '' &&
      rowLib.formatMedianCpmValue(undefined) === ''
  )

  // ---- 页面结构契约 ----
  check(
    'C9 第一屏列：达人 / 近期表现 / 历史投放 / 历史CPM / 最近合作 / 历史状态 / 风险提示',
    /title: '达人',/.test(radarPageA3) &&
      /title: '近期表现',/.test(radarPageA3) &&
      /title: '历史投放',/.test(radarPageA3) &&
      /title: '历史CPM',/.test(radarPageA3) &&
      /title: '最近合作 \/ 距今',/.test(radarPageA3) &&
      /title: '历史状态',/.test(radarPageA3) &&
      /title: '风险提示',/.test(radarPageA3) &&
      !/title: '有效CPM样本'/.test(radarPageA3) &&
      !/title: 'CPM达标次数'/.test(radarPageA3) &&
      !/title: '历史CPM中位数'/.test(radarPageA3) &&
      !/title: '达人类型'/.test(radarPageA3)
  )
  check(
    'C10 达人类型 / 有效样本 / 达标次数 / 目标价 仍被渲染（降级而非删除）',
    /record\.creator_type \|\| '未分类'/.test(radarPageA3) &&
      /formatCpmCoverageLine\(\{[\s\S]{0,120}validCpmCount: record\.valid_cpm_count/.test(radarPageA3) &&
      /passCount: record\.pass_count/.test(radarPageA3) &&
      /目标价 \{formatPrice\(targetPrice\)\}/.test(radarPageA3) &&
      /工作优先级只影响关注顺序，不改变历史表现结论/.test(radarPageA3)
  )
  check(
    'C10b 判定规则说明已简化为用户口径（不再展示 V2 冻结口径等开发术语）',
    /message="判定规则"/.test(radarPageA3) &&
      !/判定规则（V2 已冻结口径/.test(radarPageA3) &&
      /是否继续合作，还需要结合近期表现和人工判断/.test(radarPageA3)
  )
  check(
    'C11 操作入口未重构：页面仍把「更新近期表现 / 记录决策」回调接到既有组件（Alpha.3-05 起入口在工作区）',
      /onOpenAssistant=\{openAssistant\}/.test(radarPageA3) &&
      /onOpenDecision=\{openDecision\}/.test(radarPageA3) &&
      // Phase 5：回调附带 creator_id（归属锚），同名不同人绝不串数据
      /const openAssistant = \(creatorName, mode = 'update', creatorId = null\) => \{/.test(radarPageA3) &&
      /const openDecision = \(creatorItem, view = 'record'\) => \{/.test(radarPageA3)
  )
  check(
    'C12 未触碰后端：radar 页面与展示工具都不含业务阈值 / 计算（只做展示格式化）',
    !/\/\s*1000/.test(fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/utils/radarRowDisplay.js'), 'utf8')) &&
      !/cpm\s*[<>=]|pass_count\s*[<>=]|median\s*[<>=]/.test(radarPageA3)
  )

  console.log('\n===== 19. Alpha.3-02：最近一次实际合作价 last_actual_cost =====')
  db.prepare('DELETE FROM creator_records').run()
  const PRICE_SEED = [
    // 价甲：3 次合作，最近一次（09-20）cost 11000 → 不是平均 5000，不是合计 15000
    ['2026-W36', '价甲', '数码', 2000, '2026-09-05', 20000, 100000],
    ['2026-W37', '价甲', '数码', 2000, '2026-09-12', 20000, 100000],
    ['2026-W38', '价甲', '数码', 11000, '2026-09-20', 20000, 100000],
    // 价乙：最近一次 cost = 0（真实 0，不得当成缺失）
    ['2026-W36', '价乙', '数码', 3000, '2026-09-01', 20000, 100000],
    ['2026-W38', '价乙', '数码', 0, '2026-09-20', 20000, 100000],
    // 价丙：最近一次 cost = NULL（缺失，不得当成 0）
    ['2026-W36', '价丙', '数码', 2500, '2026-09-02', 20000, 100000],
    ['2026-W38', '价丙', '数码', null, '2026-09-21', 20000, 100000],
    // 价丁：同一天两条记录 → id DESC 取后插入的那条（cost 7777）
    ['2026-W38', '价丁', '数码', 1111, '2026-09-19', 20000, 100000],
    ['2026-W38', '价丁', '数码', 7777, '2026-09-19', 20000, 100000],
    // 价戊：更早的一条更贵（9000），仍必须取最近一次（1000）
    ['2026-W36', '价戊', '数码', 9000, '2026-09-03', 20000, 100000],
    ['2026-W38', '价戊', '数码', 1000, '2026-09-22', 20000, 100000],
    // 价己：完全没有 publish_date → 不构成「最近合作」，cost 也不得被挑出来
    ['2026-W38', '价己', '数码', 5000, null, 20000, 100000]
  ]
  db.transaction(() => {
    for (const row of PRICE_SEED) insert.run(...row)
  })()
  const priced = await call({ current_date: REFERENCE_DATE })
  const pricedFlat = priced.data.groups.flatMap((group) => group.creators)
  const priceOf = (name) => pricedFlat.find((item) => item.creator === name)
  const latestRecordOf = (name) =>
    db
      .prepare(
        `SELECT id, total_cost, publish_date FROM creator_records
         WHERE nickname = ? AND publish_date IS NOT NULL
         ORDER BY publish_date DESC, id DESC LIMIT 1`
      )
      .get(name)

  check(
    'D1 最近合作 cost > 0 → last_actual_cost = 该次真实成本（11000，不是平均/合计）',
    priceOf('价甲')?.last_actual_cost === 11000 &&
      priceOf('价甲')?.last_collaboration_date === '2026-09-20' &&
      latestRecordOf('价甲').total_cost === 11000,
    JSON.stringify({ cost: priceOf('价甲')?.last_actual_cost, date: priceOf('价甲')?.last_collaboration_date })
  )
  check(
    'D2 cost = 0 → 保留 0（真实值，不是缺失）',
    priceOf('价乙')?.last_actual_cost === 0 && priceOf('价乙')?.last_actual_cost !== null
  )
  check(
    'D3 cost = NULL → 保持 null（不得回填成 0）',
    priceOf('价丙')?.last_actual_cost === null &&
      priceOf('价丙')?.last_collaboration_date === '2026-09-21'
  )
  check(
    'D4 同一天多条记录 → id DESC 确定性取最近一条（7777 而非 1111）',
    priceOf('价丁')?.last_actual_cost === 7777 &&
      priceOf('价丁')?.last_collaboration_date === '2026-09-19' &&
      latestRecordOf('价丁').id ===
        db.prepare("SELECT MAX(id) AS id FROM creator_records WHERE nickname = '价丁'").get().id
  )
  check('D5 更早记录更贵也必须取最近一次（1000 而非 9000）', priceOf('价戊')?.last_actual_cost === 1000)
  check(
    'D6 没有任何 publish_date → 最近合作为 null，cost 也不挑无日期记录（保持 null）',
    priceOf('价己')?.last_collaboration_date === null && priceOf('价己')?.last_actual_cost === null
  )
  check(
    'D7 last_collaboration_date 与 last_actual_cost 来自同一条 creator_record（逐达人比对 DB）',
    ['价甲', '价乙', '价丙', '价丁', '价戊'].every((name) => {
      const item = priceOf(name)
      const row = latestRecordOf(name)
      const expectedCost =
        row.total_cost === null || row.total_cost === undefined ? null : Number(row.total_cost)
      return item.last_collaboration_date === row.publish_date && item.last_actual_cost === expectedCost
    })
  )
  check(
    'D8 只新增一个只读字段：不参与排序 / 分组（sort 说明与分组规则未变，组内仍按既有中位数升序）',
    !/last_actual_cost/.test(priced.data.sort.priority) &&
      !/last_actual_cost/.test(priced.data.sort.watch) &&
      !/last_actual_cost/.test(priced.data.sort.low_priority) &&
      priced.data.groups.length === 3 &&
      priced.data.summary.creator_count === 6 &&
      priced.data.summary.record_count === PRICE_SEED.length &&
      priced.data.groups.every((group) =>
        group.creators.every((item, i, list) => {
          if (i === 0) return true
          const prev = list[i - 1]
          const prevNull = prev.median_cpm === null
          const curNull = item.median_cpm === null
          if (prevNull) return curNull
          if (curNull) return true
          return prev.median_cpm <= item.median_cpm
        })
      ),
    JSON.stringify(priced.data.groups.map((g) => `${g.key}:${g.count}`))
  )
  check(
    'D9 金额展示：0 → ¥0；null → 暂无（绝不把 null 显示成 ¥0）',
    rowLib.formatLastActualCostValue(11000) === '¥11,000' &&
      rowLib.formatLastActualCostValue(0) === '¥0' &&
      rowLib.formatLastActualCostValue(null) === '暂无' &&
      rowLib.formatLastActualCostValue(undefined) === '暂无' &&
      rowLib.formatLastActualCostLabel(11000) === '上次合作 ¥11,000' &&
      rowLib.formatLastActualCostLabel(0) === '上次合作 ¥0' &&
      rowLib.formatLastActualCostLabel(null) === '上次合作价暂无'
  )
  check(
    'D10 前端接线：最近合作单元格第三行 + 工作区「历史表现」块（不新增与价格无关的列）',
    /\{formatLastActualCostLabel\(record\.last_actual_cost\)\}/.test(radarPageA3) &&
      /上次实际合作价/.test(
        fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/utils/workspaceSummary.js'), 'utf8')
      ) &&
      /formatLastActualCostValue\(creatorItem\.last_actual_cost\)/.test(
        fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/utils/workspaceSummary.js'), 'utf8')
      ) &&
      // Alpha.3-04 另外新增了「商单 / 日常」列，这里只校验价格没有新增独立列
      !/title: '上次合作'/.test(radarPageA3) &&
      !/title: '实际合作价'/.test(radarPageA3)
  )
  check(
    'D11 实际合作价只来自 creator_records.total_cost（前端展示层不引用 negotiated / 报价 / 目标价）',
    !/negotiated_price|current_quote|target_price/.test(
      fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/utils/radarRowDisplay.js'), 'utf8')
    ) &&
      /last_actual_cost: entry\.lastActualCost/.test(
        fs.readFileSync(path.join(REPO_ROOT, 'backend/routes/records.js'), 'utf8')
      )
  )
  check(
    'D12 无 schema 变更 / 隔离库运行（creator_records 列结构未变，行数 = seed 数）',
    process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir()) &&
      JSON.stringify(db.prepare('PRAGMA table_info(creator_records)').all().map((c) => c.name)) ===
        JSON.stringify(['id', 'time_cycle', 'nickname', 'homepage', 'creator_type', 'content_link', 'total_cost', 'publish_date', 'video_link', 'first_play', 'second_week_play', 'created_at']) &&
      db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n === PRICE_SEED.length
  )

  console.log('\n===== 20. Alpha.3-03：分组折叠 / 展开（纯前端视图状态）=====')
  const radarPageCollapse = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/pages/RepurchaseRadar/index.jsx'),
    'utf8'
  )

  check(
    'E1 默认状态：空对象 = 三个分组全部展开（不替用户隐藏信息）',
    JSON.stringify(rowLib.DEFAULT_COLLAPSED_GROUPS) === '{}' &&
      rowLib.isGroupCollapsed(rowLib.DEFAULT_COLLAPSED_GROUPS, 'priority') === false &&
      rowLib.isGroupCollapsed(rowLib.DEFAULT_COLLAPSED_GROUPS, 'watch') === false &&
      rowLib.isGroupCollapsed(rowLib.DEFAULT_COLLAPSED_GROUPS, 'low_priority') === false &&
      /const \[collapsedGroups, setCollapsedGroups\] = useState\(DEFAULT_COLLAPSED_GROUPS\)/.test(radarPageCollapse)
  )
  check(
    'E2 三个分组可独立折叠：折叠 A 不影响 B / C',
    (() => {
      const afterWatch = rowLib.toggleGroupCollapsed(rowLib.DEFAULT_COLLAPSED_GROUPS, 'watch')
      return (
        rowLib.isGroupCollapsed(afterWatch, 'watch') === true &&
        rowLib.isGroupCollapsed(afterWatch, 'priority') === false &&
        rowLib.isGroupCollapsed(afterWatch, 'low_priority') === false &&
        // 再折叠另一个分组：两个折叠状态并存，互不覆盖
        rowLib.isGroupCollapsed(rowLib.toggleGroupCollapsed(afterWatch, 'low_priority'), 'low_priority') === true &&
        rowLib.isGroupCollapsed(rowLib.toggleGroupCollapsed(afterWatch, 'low_priority'), 'watch') === true &&
        rowLib.isGroupCollapsed(rowLib.toggleGroupCollapsed(afterWatch, 'low_priority'), 'priority') === false
      )
    })()
  )
  check(
    'E3 再点一次恢复展开；切换返回新对象（不改写入参）',
    (() => {
      const base = rowLib.DEFAULT_COLLAPSED_GROUPS
      const once = rowLib.toggleGroupCollapsed(base, 'watch')
      const twice = rowLib.toggleGroupCollapsed(once, 'watch')
      return (
        rowLib.isGroupCollapsed(twice, 'watch') === false &&
        JSON.stringify(twice) === JSON.stringify({ watch: false }) &&
        JSON.stringify(base) === '{}' &&
        once !== base
      )
    })()
  )
  check(
    'E4 折叠只影响渲染：标题 / 数量 / 说明始终在标题栏，表格内容才被隐藏',
    // 标题栏组件仍渲染 分组名 + 数量 Tag + 说明文案
    /<Typography.Text strong>\{group.label\}<\/Typography.Text>/.test(radarPageCollapse) &&
      /位达人`\}/.test(radarPageCollapse) &&
      /GROUP_HINTS\[group\.key\]/.test(radarPageCollapse) &&
      // 数量仍取筛选后的 matched_count / 全量 count（未新增计数逻辑）
      /formatInteger\(group\.matched_count\)/.test(radarPageCollapse) &&
      /formatInteger\(group\.count\)/.test(radarPageCollapse) &&
      // 折叠时跳过表格渲染 + body 收起
      /collapsed\s*\?\s*null\s*:/.test(radarPageCollapse) &&
      /body: collapsed \? \{ display: 'none' \} : undefined/.test(radarPageCollapse) &&
      // 箭头随状态切换
      /collapsed \? <CaretRightOutlined \/> : <CaretDownOutlined \/>/.test(radarPageCollapse)
  )
  check(
    'E5 折叠状态是纯组件内状态：不写库 / 不用 localStorage / 不新增 API 调用',
    !/localStorage|sessionStorage|indexedDB/.test(radarPageCollapse) &&
      (radarPageCollapse.match(/setCollapsedGroups/g) || []).length === 2 && // 一处 useState + 一处 onToggle
      (radarPageCollapse.match(/getRepurchaseRadar\(/g) || []).length === 1 && // 仍只有 loadRadar
      !/collapsedGroups/.test(
        radarPageCollapse.slice(
          radarPageCollapse.indexOf('const loadRadar'),
          radarPageCollapse.indexOf('const summary = radar?.summary')
        )
      )
  )
  check(
    'E6 折叠与搜索 / 筛选解耦：filtered rows、计数、排序仍全部来自 filterRadarGroups',
    /filterRadarGroups\(radar\?\.groups \|\| \[\], filters\)/.test(radarPageCollapse) &&
      /\{visibleGroups\.map\(\(group\) => \{/.test(radarPageCollapse) &&
      // 折叠状态只在「标题栏点击」时被修改，筛选 / 清空筛选不触碰它
      /onToggle=\{\(\) => setCollapsedGroups\(\(prev\) => toggleGroupCollapsed\(prev, group\.key\)\)\}/.test(radarPageCollapse) &&
      (radarPageCollapse.match(/setCollapsedGroups/g) || []).length === 2 &&
      !/useEffect\([\s\S]{0,200}setCollapsedGroups/.test(radarPageCollapse)
  )
  check(
    'E7 折叠不触碰业务字段（页面仍只读后端下发的 historical_status / work_priority / CPM / 快照）',
    /dataIndex: 'historical_status'/.test(radarPageCollapse) &&
      /dataIndex: 'median_cpm'/.test(radarPageCollapse) &&
      /record\.work_priority_label/.test(radarPageCollapse) &&
      /record\.recent_snapshot/.test(radarPageCollapse) &&
      /record\.last_actual_cost/.test(radarPageCollapse) &&
      !/collapsedGroups\s*[^,)]*=\s*(?!=)/.test(radarPageCollapse)
  )

  console.log('\n===== 21. Alpha.3-04：商单 / 日常 展示语义 =====')
  const contentTypeLib = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/contentType.js')).href
  )
  const statsLib = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/utils/recentPerformanceStats.js')).href
  )
  const radarPageCT = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/pages/RepurchaseRadar/index.jsx'),
    'utf8'
  )

  // ---- 21.1 展示语义（纯函数）----
  const typedSnapshotLike = {
    sponsored_count: 3,
    sponsored_median_play: 38000,
    organic_count: 10,
    organic_median_play: 61000,
    unknown_count: 0
  }
  const typedCell = contentTypeLib.buildContentTypeCell(typedSnapshotLike)
  check(
    'F1 >=3 条商单 → 「商单中位 3.8万 · 3条」+「日常中位 6.1万 · 10条」（商单优先，明确写中位）',
    typedCell.hasTypeData === true &&
      typedCell.sponsored.text === '3.8万' &&
      typedCell.sponsored.count === 3 &&
      typedCell.organic.text === '6.1万' &&
      typedCell.organic.count === 10 &&
      contentTypeLib.getSponsoredSampleTier(3) === 'sufficient' &&
      JSON.stringify(contentTypeLib.buildContentPerformanceLines(typedSnapshotLike).lines) ===
        JSON.stringify([
          { text: '商单中位 3.8万 · 3条', primary: true },
          { text: '日常中位 6.1万 · 10条', primary: false }
        ])
  )
  check(
    'F2 1–2 条商单 → 真实商单中位 + 「商单样本较少」（不包装成稳定水平）',
    contentTypeLib.getSponsoredSampleTier(1) === 'insufficient' &&
      contentTypeLib.getSponsoredSampleTier(2) === 'insufficient' &&
      JSON.stringify(
        contentTypeLib.buildContentPerformanceLines({
          sponsored_count: 1,
          sponsored_median_play: 42000,
          organic_count: 8,
          organic_median_play: 81000,
          unknown_count: 0
        }).lines
      ) ===
        JSON.stringify([
          { text: '商单中位 4.2万 · 1条', primary: true },
          { text: '商单样本较少', primary: false },
          { text: '日常中位 8.1万 · 8条', primary: false }
        ])
  )
  check(
    'F3 0 条商单 + 有日常 → 「暂无商单数据」+「日常中位 8.1万 · 9条」',
    contentTypeLib.getSponsoredSampleTier(0) === 'none' &&
      JSON.stringify(
        contentTypeLib.buildContentPerformanceLines({
          sponsored_count: 0,
          sponsored_median_play: null,
          organic_count: 9,
          organic_median_play: 81000,
          unknown_count: 0
        }).lines
      ) ===
        JSON.stringify([
          { text: '暂无商单数据', primary: true },
          // 近期表现语义审计：0 条商单必须显式表达「暂无商单样本」（不得被下游当成「充足」）
          { text: '暂无商单样本', primary: false },
          { text: '日常中位 8.1万 · 9条', primary: false }
        ])
  )
  check(
    'F4 商单 / 日常都未确认但有播放数据 → 「X条内容待分类」+「商单 / 日常尚未确认」',
    contentTypeLib.buildContentTypeCell({
      sponsored_count: 0,
      sponsored_median_play: null,
      organic_count: 0,
      organic_median_play: null,
      unknown_count: 15
    }).hasTypeData === false &&
      JSON.stringify(
        contentTypeLib.buildContentPerformanceLines({
          sponsored_count: 0,
          sponsored_median_play: null,
          organic_count: 0,
          organic_median_play: null,
          unknown_count: 9
        })
      ) ===
        JSON.stringify({
          state: 'unknown-only',
          unknownCount: 9,
          lines: [
            { text: '9条内容待分类', primary: true },
            { text: '商单 / 日常尚未确认', primary: false }
          ]
        }) &&
      // 不再出现「类型未识别」这种只说状态的文案
      !/类型未识别/.test(
        fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/utils/contentType.js'), 'utf8')
      )
  )
  check(
    'F4b 无 snapshot → 占位；有快照但无可用样本 → 也占位（都不伪造文案）',
    contentTypeLib.buildContentPerformanceLines(null).state === 'no-snapshot' &&
      contentTypeLib.buildContentPerformanceLines({}).state === 'no-sample' &&
      contentTypeLib.buildContentPerformanceLines({
        sponsored_count: 0,
        organic_count: 0,
        unknown_count: 0
      }).lines.length === 0 &&
      /if \(!snapshot\) return PLACEHOLDER/.test(
        fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/pages/RepurchaseRadar/index.jsx'), 'utf8')
      )
  )
  check(
    'F5 Popover 内容构成：商单 / 日常 / 未识别 三行如实展示（未识别不给中位数）',
    JSON.stringify(
      contentTypeLib.buildContentBreakdownRows({
        sponsored_count: 5,
        sponsored_median_play: 38000,
        organic_count: 10,
        organic_median_play: 61000,
        unknown_count: 2
      })
    ) ===
      JSON.stringify([
        { label: '商单', value: '5 条，中位 3.8万' },
        { label: '日常', value: '10 条，中位 6.1万' },
        { label: '未识别', value: '2 条' }
      ])
  )
  check(
    'F6 非法 / 缺失类型归一为 unknown（前后端同一 allowlist 口径）',
    contentTypeLib.normalizeContentType('sponsored') === 'sponsored' &&
      contentTypeLib.normalizeContentType('ORGANIC') === 'organic' &&
      contentTypeLib.normalizeContentType('red') === 'unknown' &&
      contentTypeLib.normalizeContentType('蓝色') === 'unknown' &&
      contentTypeLib.normalizeContentType(null) === 'unknown' &&
      statsLib.normalizeContentType('blue') === 'unknown' &&
      statsLib.normalizeContentType(undefined) === 'unknown'
  )
  check(
    'F7 不存在加权综合分 / 商单评分（工具只做分组计数与格式化）',
    !/score|weight|blended|composite/i.test(
      fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/utils/contentType.js'), 'utf8')
    ) &&
      !/商单.*\*\s*0\.|0\.\d+\s*\*\s*商单/.test(radarPageCT)
  )

  // ---- 21.2 Radar API：内容类型统计随 latest snapshot 下发（旧快照 → 全部 unknown）----
  db.prepare('DELETE FROM creator_recent_snapshots').run()
  db.prepare('DELETE FROM creator_records').run()
  const CT_CREATOR = '商单达人'
  const CT_LEGACY = '旧快照达人'
  insert.run('2026-W38', CT_CREATOR, '数码', 3000, '2026-09-20', 20000, 100000)
  insert.run('2026-W38', CT_LEGACY, '数码', 4000, '2026-09-20', 20000, 100000)

  const typedPlayValues = [40000, 50000, 60000, 20000, 30000, 40000]
  const typedPlayTypes = ['sponsored', 'sponsored', 'sponsored', 'organic', 'organic', 'organic']
  const typedPlays = typedPlayValues.map((value, index) => ({
    raw_text: String(value),
    normalized_play: value,
    needs_review: false,
    excluded: false,
    content_type: typedPlayTypes[index],
    source_image_index: 1,
    position_index: index + 1
  }))
  const insertSnapshot = (creator, plays, observedAt) => {
    const values = plays.map((play) => play.normalized_play)
    const s = statsLib.computeRecentPerformanceStats(values)
    return Number(
      db
        .prepare(
          `INSERT INTO creator_recent_snapshots (
             creator, source_type, plays_json, recognized_count, valid_count, excluded_count,
             unresolved_count, analysis_count, median_play, p25_play, p75_play,
             recent_median_play, prior_median_play, trend_ratio, trend_label,
             stats_status, stats_version, created_at, observed_at
           ) VALUES (?, 'screenshot', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-29 10:00:00', ?)`
        )
        .run(
          creator,
          JSON.stringify(plays),
          plays.length,
          s.valid_count,
          s.analysis_count,
          s.median_play,
          s.p25_play,
          s.p75_play,
          s.recent_median_play,
          s.prior_median_play,
          s.trend_ratio,
          s.trend_label,
          s.stats_status,
          statsLib.STATS_VERSION,
          observedAt
        ).lastInsertRowid
    )
  }
  insertSnapshot(CT_CREATOR, typedPlays, '2026-09-29')
  // 旧格式快照（条目没有 content_type）
  insertSnapshot(
    CT_LEGACY,
    typedPlayValues.map((value, index) => ({
      raw_text: String(value),
      normalized_play: value,
      needs_review: false,
      excluded: false,
      source_image_index: 1,
      position_index: index + 1
    })),
    '2026-09-29'
  )

  const radarTyped = await call({ current_date: REFERENCE_DATE })
  const radarFlat = radarTyped.data.groups.flatMap((group) => group.creators)
  const typedCreatorItem = radarFlat.find((item) => item.creator === CT_CREATOR)
  const legacyCreatorItem = radarFlat.find((item) => item.creator === CT_LEGACY)
  check(
    'F8 Radar latest snapshot 携带五个内容类型字段（商单 3 条中位 5万 / 日常 3 条中位 3万）',
    typedCreatorItem?.recent_snapshot?.sponsored_count === 3 &&
      typedCreatorItem?.recent_snapshot?.sponsored_median_play === 50000 &&
      typedCreatorItem?.recent_snapshot?.organic_count === 3 &&
      typedCreatorItem?.recent_snapshot?.organic_median_play === 30000 &&
      typedCreatorItem?.recent_snapshot?.unknown_count === 0,
    JSON.stringify(typedCreatorItem?.recent_snapshot ?? null)
  )
  check(
    'F9 旧快照在 Radar 上全部落入 unknown（不回填、不猜测）',
    legacyCreatorItem?.recent_snapshot?.unknown_count === 6 &&
      legacyCreatorItem?.recent_snapshot?.sponsored_count === 0 &&
      legacyCreatorItem?.recent_snapshot?.organic_count === 0 &&
      legacyCreatorItem?.recent_snapshot?.sponsored_median_play === null &&
      legacyCreatorItem?.recent_snapshot?.organic_median_play === null
  )
  check(
    'F10 新增字段不影响既有业务判断（historical_status / work_priority / 排序说明 / last_actual_cost 均不变）',
    // 两位达人都只有 1 条历史投放记录（CPM 30 / 40）→ insufficient + normal_attention：
    // 内容类型只影响「近期表现」的展示拆分，完全不影响历史证据与工作优先级
    typedCreatorItem?.historical_status === 'insufficient' &&
      typedCreatorItem?.work_priority === 'normal_attention' &&
      legacyCreatorItem?.historical_status === 'insufficient' &&
      legacyCreatorItem?.work_priority === 'normal_attention' &&
      typedCreatorItem?.last_actual_cost === 3000 &&
      legacyCreatorItem?.last_actual_cost === 4000 &&
      !/商单|sponsored|organic/.test(JSON.stringify(radarTyped.data.sort)) &&
      !/sponsored|organic/.test(radarTyped.data.groups.map((group) => group.key).join(',')),
    JSON.stringify({
      typed: [typedCreatorItem?.historical_status, typedCreatorItem?.work_priority],
      legacy: [legacyCreatorItem?.historical_status, legacyCreatorItem?.work_priority]
    })
  )
  check(
    'F11 第一屏「近期内容表现」列 + 工作区内容块 + 轻量「补充分类」入口（近期表现列保留）',
    /title: '近期内容表现'/.test(radarPageCT) &&
      /title: '近期表现'/.test(radarPageCT) &&
      /buildContentPerformanceLines\(snapshot\)/.test(radarPageCT) &&
      // Alpha.3-05：内容构成挪进达人判断工作区（同一文案工具，不重复实现）
      /近期内容表现/.test(
        fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/components/CreatorWorkspaceDrawer.jsx'), 'utf8')
      ) &&
      /buildContentBlock/.test(
        fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/utils/workspaceSummary.js'), 'utf8')
      ) &&
      // 「补充分类」复用现有入口，不新增编辑器 / API
      /补充分类/.test(radarPageCT) &&
      // Phase 5：补充分类入口同时携带 creator_id
      /onOpenAssistant\?\.\(record\.creator, 'classify_existing', record\.creator_id\)/.test(radarPageCT) &&
      // 文案集中在 useContentType 工具里（页面不自己拼中位/条数）
      /商单中位/.test(fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/utils/contentType.js'), 'utf8')) &&
      !/商单中位/.test(radarPageCT) &&
      // 只用后端下发的字段，前端不重算商单中位数
      !/sponsored_median_play[\s\S]{0,60}[/*+-]/.test(radarPageCT)
  )

  console.log('\n===== 22. Alpha.3-05：达人判断工作区（大 Drawer）=====')
  const workspaceLib = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/workspaceSummary.js')).href
  )
  const radarPageWs = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/pages/RepurchaseRadar/index.jsx'),
    'utf8'
  )
  const workspaceSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/components/CreatorWorkspaceDrawer.jsx'),
    'utf8'
  )

  check(
    'W1 Drawer 宽度约 70%–75%（1440 → 1080），最大不超过 1280',
    workspaceLib.WORKSPACE_WIDTH_RATIO >= 0.7 &&
      workspaceLib.WORKSPACE_WIDTH_RATIO <= 0.75 &&
      workspaceLib.computeWorkspaceWidth(1440) === 1080 &&
      workspaceLib.computeWorkspaceWidth(1280) === 960 &&
      workspaceLib.computeWorkspaceWidth(2000) === workspaceLib.WORKSPACE_MAX_WIDTH,
    JSON.stringify({
      ratio: workspaceLib.WORKSPACE_WIDTH_RATIO,
      w1440: workspaceLib.computeWorkspaceWidth(1440)
    })
  )
  check(
    'W2 窄屏降级为接近全宽（1024 仍 75%；900 以下退化为全宽）',
    workspaceLib.computeWorkspaceWidth(1024) === 768 &&
      workspaceLib.computeWorkspaceWidth(900) === 675 &&
      workspaceLib.computeWorkspaceWidth(800) === 800 &&
      workspaceLib.computeWorkspaceWidth(375) === 375
  )
  check(
    'W3 页面不再有 Popover：达人昵称点击改为打开工作区',
    !/from 'antd'[\s\S]{0,400}Popover/.test(radarPageWs) &&
      !/<Popover/.test(radarPageWs) &&
      // Phase 5：点击打开工作区时传入整行（携带 creator_id），不再按名称解析
      /onClick=\{\(\) => onOpenWorkspace\?\.\(record\)\}/.test(radarPageWs) &&
      /const openWorkspace = \(creatorItem\) => \{/.test(radarPageWs) &&
      /setWorkspaceKey\(radarRowKey\(creatorItem, undefined, identityMode\)\)/.test(radarPageWs)
  )
  check(
    'W4 工作区绑定当前达人，并从最新 Radar 结果解析（保存后可自动刷新）',
    // Phase 5：工作区按身份键从最新 Radar 结果解析（同名不同人绝不串数据）
    /const workspaceItem = workspaceKey/.test(radarPageWs) &&
      /radarRowKey\(item, undefined, identityMode\) === workspaceKey/.test(radarPageWs) &&
      /<CreatorWorkspaceDrawer/.test(radarPageWs) &&
      /open=\{Boolean\(workspaceItem\)\}/.test(radarPageWs) &&
      /creatorItem=\{workspaceItem\}/.test(radarPageWs) &&
      /onOpenAssistant=\{openAssistant\}/.test(radarPageWs) &&
      /onOpenDecision=\{openDecision\}/.test(radarPageWs)
  )
  check(
    'W5 关闭工作区只清空工作区状态（不动搜索 / 筛选 / 折叠）',
    /onClose=\{\(\) => setWorkspaceKey\(null\)\}/.test(radarPageWs) &&
      (radarPageWs.match(/setCollapsedGroups/g) || []).length === 2 &&
      (radarPageWs.match(/setFilters\(EMPTY_RADAR_FILTERS\)/g) || []).length === 1
  )

  // ---- 信息映射（用真实 API 下发的 item 验证）----
  const liveItem = pricedFlat.find((item) => item.creator === '价甲') || radarFlat[0]
  const workspaceHistory = workspaceLib.buildHistoryBlock(liveItem)
  const historyValue = (label) => workspaceHistory.find((row) => row.label === label)?.value
  check(
    'W6 历史表现块：历史投放次数 / 历史CPM中位 / 达标情况 / 最近合作 / 上次实际合作价 全部正确',
    historyValue('历史投放') === `${liveItem.record_count} 次` &&
      // 与 Radar 主表同一格式：CPM 保留 1 位小数
      historyValue('历史CPM中位') ===
        (liveItem.median_cpm === null ? '-' : Number(liveItem.median_cpm).toFixed(1)) &&
      historyValue('达标情况') === `${liveItem.pass_count}/${liveItem.valid_cpm_count} 达标` &&
      historyValue('最近合作') === liveItem.last_collaboration_date &&
      historyValue('上次实际合作价') ===
        (liveItem.last_actual_cost === null ? '暂无' : `¥${Number(liveItem.last_actual_cost).toLocaleString('zh-CN')}`),
    JSON.stringify(workspaceHistory)
  )
  const typedWsItem = radarFlat.find((item) => item.creator === CT_CREATOR)
  const workspaceRecent = workspaceLib.buildRecentBlock(typedWsItem)
  const recentValue = (label) => workspaceRecent.rows.find((row) => row.label === label)?.value
  check(
    'W7 近期表现块：整体近期中位播放 / trend / 数据截至（口径与 Radar 列一致）',
    recentValue('近期中位播放') === '4.0万' &&
      recentValue('趋势') === '样本不足' &&
      recentValue('数据截至') === typedWsItem.recent_snapshot.observed_at &&
      recentValue('有效样本') === `${typedWsItem.recent_snapshot.valid_count} 条`,
    JSON.stringify(workspaceRecent.rows)
  )
  const workspaceContent = workspaceLib.buildContentBlock(typedWsItem)
  check(
    'W8 近期内容表现块：商单 / 日常中位与条数、样本语义、待分类计数',
    workspaceContent.rows.find((row) => row.label === '商单')?.value === '5.0万 · 3条' &&
      workspaceContent.rows.find((row) => row.label === '日常')?.value === '3.0万 · 3条' &&
      workspaceContent.rows.find((row) => row.label === '样本')?.value === '商单样本充足' &&
      workspaceContent.rows.find((row) => row.label === '待分类')?.value === '0 条',
    JSON.stringify(workspaceContent.rows)
  )
  check(
    'W8b 旧快照 / 未分类：工作区显示「尚未确认」+「N 条待分类」（不是空表）',
    (() => {
      const legacyItem = radarFlat.find((item) => item.creator === CT_LEGACY)
      const block = workspaceLib.buildContentBlock(legacyItem)
      return (
        block.rows.find((row) => row.label === '商单')?.value === '尚未确认' &&
        block.rows.find((row) => row.label === '待分类')?.value === '6 条'
      )
    })()
  )
  const workspacePrice = workspaceLib.buildPriceBlock(typedWsItem)
  const priceValue = (label) => workspacePrice.find((row) => row.label === label)?.value
  check(
    'W9 价格块：星图价 / 当前报价 / CPM30目标价 / 参考区间 全部复用既有字段',
    priceValue('星图刊例价') === '暂无' &&
      priceValue('当前报价') === '暂无' &&
      priceValue('CPM30目标价') === '¥1,200' &&
      priceValue('参考区间') === '¥1,125～¥1,275',
    JSON.stringify(workspacePrice)
  )
  check(
    'W10 最近决策块：无决策 → 轻量空状态「还没有记录决策」（不是错误态）',
    workspaceLib.buildRecentDecisionBlock({}).empty === true &&
      workspaceLib.buildRecentDecisionBlock({}).emptyText === '还没有记录决策' &&
      /还没有记录决策/.test(workspaceSrc) === false // 文案来自工具，组件只渲染
  )
  check(
    'W11 最近决策块：有决策 → 阶段 / 我的决定 / 实际报价 / 决策日期 / 录入于 / 投放结果',
    (() => {
      const block = workspaceLib.buildRecentDecisionBlock({
        recent_decision: {
          decided_at: '2026-09-30',
          created_at: '2026-09-30 10:44:43',
          decision_stage: 'post_quote',
          human_decision: 'repurchase',
          human_decision_label: '复投',
          current_quote: 3000,
          outcome: { target_cpm_status: 'met' }
        }
      })
      const value = (label) => block.rows.find((row) => row.label === label)?.value
      return (
        block.empty === false &&
        value('阶段') === '已拿到报价' &&
        value('我的决定') === '复投' &&
        value('实际报价') === '¥3,000' &&
        value('决策日期') === '2026-09-30' &&
        value('录入于') === '2026-09-30 10:44' &&
        value('投放结果') === '已关联投放结果 · CPM30已达标'
      )
    })()
  )
  check(
    'W12 工作区结构：4 个摘要块 + 价格判断 + 最近决策 + 主操作 footer（复用既有组件）',
    /title="达人判断工作区"/.test(workspaceSrc) === false &&
      /<Drawer/.test(workspaceSrc) &&
      /buildHistoryBlock/.test(workspaceSrc) &&
      /buildRecentBlock/.test(workspaceSrc) &&
      /buildContentBlock/.test(workspaceSrc) &&
      /buildPriceBlock/.test(workspaceSrc) &&
      /buildRecentDecisionBlock/.test(workspaceSrc) &&
      /buildCorePriceRows\(snapshot\.pricing\)/.test(workspaceSrc) &&
      /buildNegotiationReferenceRows\(snapshot\?\.pricing\)/.test(workspaceSrc) &&
      /buildPriceConclusion\(snapshot\?\.pricing\)/.test(workspaceSrc) &&
      /更新近期表现/.test(workspaceSrc) &&
      /记录决策/.test(workspaceSrc) &&
      /查看决策记录/.test(workspaceSrc) &&
      // 不复制业务逻辑、不新增请求
      !/\/\s*1000|axios|fetch\(|from '\.\.\/api\//.test(workspaceSrc)
  )
  check(
    'W13 Radar 主表未变：8 列 / 排序 / 分组 / 筛选 / 折叠 逻辑原样',
    (radarPageWs.match(/title: '/g) || []).length === 8 &&
      /title: '近期表现'/.test(radarPageWs) &&
      /title: '近期内容表现'/.test(radarPageWs) &&
      /title: '历史投放'/.test(radarPageWs) &&
      /title: '历史CPM'/.test(radarPageWs) &&
      /title: '最近合作 \/ 距今'/.test(radarPageWs) &&
      /title: '历史状态'/.test(radarPageWs) &&
      /title: '风险提示'/.test(radarPageWs) &&
      /filterRadarGroups\(radar\?\.groups \|\| \[\], filters\)/.test(radarPageWs) &&
      (radarPageWs.match(/getRepurchaseRadar\(/g) || []).length === 1
  )

  console.log('\n===== 23. Alpha.3-05A：价格判断区去重与收敛 =====')
  const pricingLib = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/utils/creatorPricing.js')).href
  )
  const workspaceSrcPrice = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/components/CreatorWorkspaceDrawer.jsx'),
    'utf8'
  )
  const workspaceUtilSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/utils/workspaceSummary.js'),
    'utf8'
  )
  // 用模拟场景构造 pricing：星图 ¥20,000 + 中位播放 122.1万（虚构示例，不对应任何真实快照）
  const samplePricing = pricingLib.computeCreatorPricing({
    stats_status: 'ok',
    median_play: 1221000,
    p25_play: 900000,
    p75_play: 1600000,
    xingtu_price: 20000
  })
  const coreRows = workspaceLib.buildCorePriceRows(samplePricing)
  const negotiationRows = workspaceLib.buildNegotiationReferenceRows(samplePricing)
  const conclusion = workspaceLib.buildPriceConclusion(samplePricing)

  check(
    'X1 左侧只平铺 3 条核心价格事实（CPM30目标价 / 参考区间 / 星图刊例价）',
    coreRows.map((row) => row.label).join(',') === 'CPM30目标价,CPM30参考区间,星图刊例价' &&
      coreRows[0].value === `¥${Number(samplePricing.target_price).toLocaleString('zh-CN')}` &&
      coreRows[1].value ===
        `¥${Number(samplePricing.reference_low).toLocaleString('zh-CN')}～¥${Number(samplePricing.reference_high).toLocaleString('zh-CN')}` &&
      coreRows[2].value === '¥20,000',
    JSON.stringify(coreRows)
  )
  check(
    'X2 默认不再平铺「进入参考区间」「CPM30目标」两条结论型行',
    !coreRows.some((row) => row.label === '进入参考区间' || row.label === 'CPM30目标') &&
      // 业务能力未删除：底层 buildPricingRows 仍产出这两行，只是不再默认展示
      (() => {
        const pricingSrc = fs.readFileSync(
          path.join(REPO_ROOT, 'frontend/src/utils/pricingDisplay.js'),
          'utf8'
        )
        return (
          /label: '进入参考区间'/.test(pricingSrc) &&
          /label: 'CPM30目标'/.test(pricingSrc) &&
          /value: formatEntryDiscount\(pricing\)/.test(pricingSrc) &&
          /value: formatTargetDiscount\(pricing\)/.test(pricingSrc)
        )
      })()
  )
  check(
    'X3 谈价参考默认收起：折叠状态初始为 false，且未展开时不渲染这两行',
    /const \[showNegotiationReference, setShowNegotiationReference\] = useState\(false\)/.test(
      workspaceSrcPrice
    ) &&
      /showNegotiationReference && \(/.test(workspaceSrcPrice) &&
      /展开谈价参考/.test(workspaceSrcPrice) &&
      /收起谈价参考/.test(workspaceSrcPrice)
  )
  check(
    'X4 展开后显示「可谈折扣区间 2～7折」+「对应价格区间」，复用既有结果不重算',
    negotiationRows.length === 2 &&
      negotiationRows[0].label === '可谈折扣区间' &&
      negotiationRows[0].value === '2～7折' &&
      negotiationRows[1].label === '对应价格区间' &&
      negotiationRows[1].value ===
        `¥${Number(samplePricing.negotiation_min_price).toLocaleString('zh-CN')}～¥${Number(samplePricing.negotiation_max_price).toLocaleString('zh-CN')}`,
    JSON.stringify(negotiationRows)
  )
  check(
    'X5 价格结论只有一条，且直接来自后端 pricing_status_label（前端不重算）',
    conclusion.text === samplePricing.pricing_status_label &&
      conclusion.status === samplePricing.pricing_status &&
      /buildPriceConclusion\(snapshot\?\.pricing\)/.test(workspaceSrcPrice) &&
      // 组件里只出现一次结论渲染
      (workspaceSrcPrice.match(/\{conclusion\.text\}/g) || []).length === 1 &&
      // 不再出现「进入参考区间 / CPM30目标」这类二次判断文案渲染
      !/进入参考区间|CPM30目标</.test(workspaceSrcPrice)
  )
  check(
    'X6 去掉重复提示：不再有「完整价格核算…在『记录决策』内」这类说明文字',
    !/完整价格核算/.test(workspaceSrcPrice) &&
      !/在「记录决策」内/.test(workspaceSrcPrice) &&
      // 入口由 Drawer 底部主按钮承担（仍在）
      /记录决策/.test(workspaceSrcPrice)
  )
  check(
    'X7 无星图价（quote_missing）保持既有 unavailable 语义：无谈价参考行、结论用后端文案',
    (() => {
      const noPrice = pricingLib.computeCreatorPricing({
        stats_status: 'ok',
        median_play: 1221000,
        p25_play: 900000,
        p75_play: 1600000,
        xingtu_price: null
      })
      const core = workspaceLib.buildCorePriceRows(noPrice)
      return (
        noPrice.pricing_status === 'quote_missing' &&
        core[2].value === '暂无' &&
        workspaceLib.buildNegotiationReferenceRows(noPrice).length === 0 &&
        workspaceLib.buildPriceConclusion(noPrice).text === noPrice.pricing_status_label
      )
    })()
  )
  check(
    'X8 样本不足（stats_insufficient）时不伪造区间，结论仍来自后端',
    (() => {
      const insufficient = pricingLib.computeCreatorPricing({
        stats_status: 'insufficient',
        median_play: null,
        p25_play: null,
        p75_play: null,
        xingtu_price: 20000
      })
      return (
        workspaceLib.buildCorePriceRows(insufficient).length === 2 &&
        workspaceLib.buildNegotiationReferenceRows(insufficient).length === 0 &&
        workspaceLib.buildPriceConclusion(insufficient).text === insufficient.pricing_status_label
      )
    })()
  )
  check(
    'X9 未修改 pricing 计算逻辑：buildPricingRows 与 creatorPricing 均未改动（仅新增展示筛选）',
    /export function buildPricingRows/.test(
      fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/utils/pricingDisplay.js'), 'utf8')
    ) &&
      !/pricing_status\s*=/.test(workspaceUtilSrc) &&
      !/target_price\s*[*/+-]|reference_high\s*[*/+-]/.test(workspaceUtilSrc) &&
      !/computeCreatorPricing/.test(workspaceUtilSrc)
  )
  check(
    'X10 折叠状态是纯组件内状态：无 localStorage / 无 API / 无 schema 变更',
    !/localStorage|sessionStorage|indexedDB/.test(workspaceSrcPrice) &&
      !/axios|fetch\(|from '\.\.\/api\//.test(workspaceSrcPrice) &&
      // Playbook Phase 1 新增 candidate_id（快照表 24 列）；creator_records 保持 12 列不变
      db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().length === 24 &&
      db.prepare('PRAGMA table_info(creator_records)').all().length === 12
  )

  console.log('\n===== 24. Alpha.3-04B：补充分类入口与模式（classify_existing）=====')
  const assistantSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/components/RecentPerformanceAssistantModal.jsx'),
    'utf8'
  )
  const draftLibSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/utils/recentPerformanceDraft.js'),
    'utf8'
  )
  const radarPageClassify = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/pages/RepurchaseRadar/index.jsx'),
    'utf8'
  )
  // 取出 classify 分支 JSX，逐项核对「只显示什么 / 不显示什么」
  const classifyStart = assistantSrc.indexOf('{isClassifyMode ? (')
  const classifyEnd = assistantSrc.indexOf(') : (\n      <Space direction="vertical" size="middle"')
  const classifyBlock = assistantSrc.slice(classifyStart, classifyEnd)

  check(
    'Y1 复用同一个助手组件：新增 mode 参数与 classify_existing 分支（未新建第二套 Modal）',
    /mode = 'update'/.test(assistantSrc) &&
      /const isClassifyMode = mode === 'classify_existing'/.test(assistantSrc) &&
      classifyStart > 0 &&
      classifyEnd > classifyStart &&
      // 全项目只有一个近期表现助手组件文件
      fs
        .readdirSync(path.join(REPO_ROOT, 'frontend/src/components'))
        .filter((name) => /RecentPerformance/i.test(name)).length === 1
  )
  check(
    'Y2 预加载已有快照：读 latest snapshot → buildDraftFromSnapshot（无新增 API）',
    // Phase 5：latest 读取携带归属锚 creator_id（同名不同人绝不串数据），仍无新增 http 调用
    /getLatestRecentSnapshot\(targetCreator, effectiveCreatorId\)/.test(assistantSrc) &&
      /const nextDraft = buildDraftFromSnapshot\(snapshot\)/.test(assistantSrc) &&
      /export function buildDraftFromSnapshot\(snapshot\)/.test(draftLibSrc) &&
      // 复用既有 latest 接口，没有新增 http 调用
      (assistantSrc.match(/getLatestRecentSnapshot\(/g) || []).length === 1
  )
  check(
    'Y3 找不到快照时轻量报错并退出该模式，且不会创建空快照',
    /setClassifyError\('未找到可补充分类的近期快照'\)/.test(assistantSrc) &&
      /!snapshot \|\| !Array.isArray\(snapshot\.plays\) \|\| snapshot\.plays\.length === 0/.test(
        assistantSrc
      ) &&
      /disabled=\{!draft \|\| \(draft\?\.plays\?\.length \?\? 0\) === 0 \|\| Boolean\(classifyError\)\}/.test(
        assistantSrc
      )
  )
  check(
    'Y4 补充分类模式只渲染只读播放量 + 内容类型下拉（无上传 / 无 AI / 无手工录入 / 无星图价输入 / 无日期选择器）',
    /· 补充内容分类/.test(assistantSrc) &&
      /正在补充已有快照的内容分类/.test(classifyBlock) &&
      /formatInteger\(play\.normalized_play\)/.test(classifyBlock) &&
      /updatePlayContentType\(draft, play\.id, value\)/.test(classifyBlock) &&
      /保存分类/.test(classifyBlock) &&
      // 观察日期只读展示（继承自原快照，且明确标注不可修改）
      /数据观察日期：/.test(classifyBlock) &&
      /继承自原快照，不可修改/.test(classifyBlock) &&
      !/inputRef|开始 AI 识别|entryMode === 'screenshot'|entryMode === 'manual'|handleStartRecognition/.test(
        classifyBlock
      ) &&
      !/<DatePicker|updatePriceRawText/.test(classifyBlock) &&
      !/排除该条|恢复该条/.test(classifyBlock) &&
      !/manualText|splitManualPlayLines/.test(classifyBlock)
  )
  check(
    'Y5 补充分类模式不探测 / 不调用 AI（AI 状态 effect 直接跳过）',
    /if \(isClassifyMode\) return/.test(assistantSrc) &&
      !/extractCreatorScreenshot/.test(classifyBlock) &&
      // AI 调用点仍然只有一个（普通更新模式里）
      (assistantSrc.match(/extractCreatorScreenshot\(/g) || []).length === 1
  )
  check(
    'Y6 保存分类走 append-only：只替换 content_type，observed_at 继承旧快照',
    /const handleClassifySave = async \(\) => \{/.test(assistantSrc) &&
      // Playbook Phase 1 起 payload 先组装再按历史 / 候选分支提交；历史分支仍走既有 saveRecentSnapshot
      /buildSnapshotPayload\(draft, \{/.test(assistantSrc) &&
      /identityConfirmed: true/.test(assistantSrc) &&
      /observedAt: isValidDateOnly\(draft\.observed_at\) \? draft\.observed_at : ''/.test(assistantSrc) &&
      /await saveRecentSnapshot\(payload\)/.test(assistantSrc) &&
      // 没有 UPDATE 旧快照的任何前端写法
      !/UPDATE creator_recent_snapshots|updateRecentSnapshot/.test(assistantSrc)
  )
  check(
    'Y7 Radar 入口条件：有快照且 unknown_count > 0 才出现「补充分类」，点击进入 classify 模式',
    /if \(!snapshot\) return PLACEHOLDER/.test(radarPageClassify) &&
      /cell\.unknownCount > 0 && \(/.test(radarPageClassify) &&
      // Phase 5：入口同时携带归属锚 creator_id
      /onOpenAssistant\?\.\(record\.creator, 'classify_existing', record\.creator_id\)/.test(
        radarPageClassify
      ) &&
      /const openAssistant = \(creatorName, mode = 'update', creatorId = null\)/.test(
        radarPageClassify
      ) &&
      /mode=\{assistantMode\}/.test(radarPageClassify)
  )
  check(
    'Y8 普通「更新近期表现」入口不受影响（仍为默认 update 模式 / 全能力）',
    /onOpenAssistant\?\.\(value\)\)/u.test(radarPageClassify) === false &&
      /onClick=\{\(\) => openAssistant\(null\)\}/.test(radarPageClassify) &&
      /onOpenAssistant=\{openAssistant\}/.test(radarPageClassify) &&
      // classify 模式复用同一套保存链（buildSnapshotPayload → saveRecentSnapshot）
      /buildSnapshotPayload\(draft, \{/.test(assistantSrc) &&
      // 普通模式的能力标记仍在（上传 / AI / 手工 / 观察日期 / 星图价 / 排除）
      /entryMode === 'screenshot'/.test(assistantSrc) &&
      /entryMode === 'manual'/.test(assistantSrc) &&
      /开始 AI 识别/.test(assistantSrc) &&
      /togglePlayExcluded\(draft, play\.id\)/.test(assistantSrc) &&
      /数据观察日期/.test(assistantSrc) &&
      /星图刊例价/.test(assistantSrc)
  )
  check(
    'Y9 未新增 API / schema：路由仍只有 POST / 与 GET /latest，两表列数未变',
    // 历史 recent-snapshots 路由集合不变（候选路由在独立 router）；快照表 24 列（Playbook Phase 1 新增 candidate_id）、
    // 投放记录表 12 列，latest 详情仍走既有 GET /latest
    JSON.stringify(
      (await import(pathToFileURL(path.join(REPO_ROOT, 'backend/routes/recentSnapshots.js')).href))
        .default.stack.filter((layer) => layer.route)
        .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`)
        .sort()
    ) === JSON.stringify(['GET /latest', 'POST /']) &&
      db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().length === 24 &&
      db.prepare('PRAGMA table_info(creator_records)').all().length === 12 &&
      JSON.stringify(
        db
          .prepare('PRAGMA table_info(creator_recent_snapshots)')
          .all()
          .map((column) => column.name)
      ).includes('plays_json')
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
