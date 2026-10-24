#!/usr/bin/env node
// Recent Performance V2 backfill 工具契约测试（temp DB only）
//
// 运行方式：node tests/recent_performance_v2_backfill.test.js
//
// 锁定：
//   stats_version v2 / 录入顺序 OLD → NEW / latest 5 = 数组末尾
//   real 15-item fixture = up（+123.08%）
//   dry-run 不写库 / commit 单事务 all-or-nothing / expected-before 冲突整体回滚
//   plays_json / observed_at / 行数 / 事实字段不变

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-performance-v2-'))
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

// 样板达人11真实 15 条（从旧到新；130.4w = 最新）
const REAL_15 = [
  77000, 37000, 52000, 135000, 55000,
  85000, 153000, 52000, 75000, 41000,
  22000, 187000, 59000, 145000, 1304000
]

function seedSnapshot(db, id, creator, plays, { statsVersion = 'recent-performance-v1' } = {}) {
  const stats = (() => {
    // 用 v1 的（错误）方向生成落库值，模拟真实存量
    const valid = plays
    const recent = valid.slice(0, 5)
    const prior = valid.slice(5)
    const medianOf = (a) => {
      const s = [...a].sort((x, y) => x - y)
      const n = s.length
      return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
    }
    const rm = medianOf(recent)
    const pm = medianOf(prior)
    const ratio = pm === 0 ? null : Number((rm / pm - 1).toFixed(4))
    const label = ratio === null ? 'insufficient' : ratio >= 0.2 ? 'up' : ratio <= -0.2 ? 'down' : 'stable'
    return { rm, pm, ratio, label }
  })()
  db.prepare(
    `INSERT INTO creator_recent_snapshots
       (id, creator, plays_json, valid_count, analysis_count,
        recent_median_play, prior_median_play, trend_ratio, trend_label,
        stats_status, stats_version, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, '2026-10-10')`
  ).run(
    id,
    creator,
    JSON.stringify(plays.map((value, index) => ({
      raw_text: `${value / 10000}w`,
      normalized_play: value,
      excluded: false,
      content_type: 'organic',
      position_index: index + 1
    }))),
    plays.length,
    Math.max(0, plays.length - 2),
    stats.rm,
    stats.pm,
    stats.ratio,
    stats.label,
    statsVersion
  )
}

async function main() {
  const db = (await import(pathToFileURL(path.join(REPO_ROOT, 'backend/db.js')).href)).default
  const statsModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/utils/recentPerformanceStats.js')).href
  )
  const backfillModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/migrations/002_recent_performance_v2_backfill.js')).href
  )
  const { STATS_VERSION } = statsModule
  const { planRecentPerformanceV2Backfill, applyRecentPerformanceV2Backfill } = backfillModule
  const rowOf = (id) => db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(id)
  const playsJsonOf = (id) => rowOf(id).plays_json

  console.log('\n===== A. V2 契约常量 =====')
  check('STATS_VERSION = recent-performance-v2', STATS_VERSION === 'recent-performance-v2', STATS_VERSION)
  const v2Stats = statsModule.computeRecentPerformanceStats(REAL_15)
  check(
    'OLD → NEW：latest 5 = 数组末尾 → real 15-item fixture trend = up（+123.08%）',
    v2Stats.recent_median_play === 145000 &&
      v2Stats.prior_median_play === 65000 &&
      v2Stats.trend_ratio === 1.2308 &&
      v2Stats.trend_label === 'up'
  )
  check('median/p25/p75 等其它冻结口径不变（median_play = 7.5万）', v2Stats.median_play === 75000)

  console.log('\n===== B. fixture + dry-run 不写库 =====')
  // 两个 v1 snapshot：#1 = 真实 15 条（down→up）；#2 = 9 条（<8 以下不参与方向，但 9 ≥ 8 → 参与）；#3 = 6 条（<8 skip）
  seedSnapshot(db, 1, '样板达人11', REAL_15)
  seedSnapshot(db, 2, '九条达人', [10000, 10000, 10000, 10000, 10000, 50000, 50000, 50000, 50000])
  seedSnapshot(db, 3, '六条达人', [10000, 10000, 10000, 10000, 10000, 50000])
  const SNAPSHOTS_SQL =
    'SELECT id, creator, candidate_id, stats_version, trend_label, trend_ratio, recent_median_play, prior_median_play, median_play, p25_play, p75_play, analysis_count, valid_count, plays_json, observed_at FROM creator_recent_snapshots ORDER BY id'
  const beforeAll = db.prepare(SNAPSHOTS_SQL).all()

  const dryPlan = planRecentPerformanceV2Backfill(db)
  check('dry-run 计划包含 2 行（#3 valid_count=6 → skip）', dryPlan.summary.total === 2 && dryPlan.summary.skipped === 1)
  check('#1 样板达人11：down → up（label 变化）', dryPlan.plans.some((p) => p.id === 1 && p.before.trend_label === 'down' && p.after.trend_label === 'up'))
  const afterDryAll = db.prepare(SNAPSHOTS_SQL).all()
  check('dry-run 零写入（所有字段与计划前逐行一致）', JSON.stringify(beforeAll) === JSON.stringify(afterDryAll))

  console.log('\n===== C. apply：单事务 v1 → v2 =====')
  const applyResult = applyRecentPerformanceV2Backfill(db, dryPlan)
  check('apply 更新 2 行', applyResult.updated === 2)
  check(
    '被计划的两行 stats_version = v2；被 skip 的行（valid_count < 8）保持 v1（不扩大写入范围）',
    rowOf(1).stats_version === 'recent-performance-v2' &&
      rowOf(2).stats_version === 'recent-performance-v2' &&
      rowOf(3).stats_version === 'recent-performance-v1'
  )
  const row1 = rowOf(1)
  check(
    '#1 样板达人11：trend = up / ratio ≈ +123.08% / recent 14.5万 / prior 6.5万',
    row1.trend_label === 'up' && row1.trend_ratio === 1.2308 && row1.recent_median_play === 145000 && row1.prior_median_play === 65000
  )
  check(
    '#2 九条达人：latest 5 = 数组末尾（v2 方向），label 按重算值',
    row2Check(row2())
  )
  function row2Check(row) {
    const plays = [10000, 10000, 10000, 10000, 10000, 50000, 50000, 50000, 50000]
    const stats = statsModule.computeRecentPerformanceStats(plays)
    return row.trend_label === stats.trend_label && row.trend_ratio === stats.trend_ratio && row.recent_median_play === stats.recent_median_play
  }
  function row2() {
    return db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = 2').get()
  }

  console.log('\n===== D. 事实字段零改动 =====')
  check('plays_json 逐字节不变', playsJsonOf(1) === beforeAll.find((r) => r.id === 1).plays_json)
  check('observed_at 不变', rowOf(1).observed_at === beforeAll.find((r) => r.id === 1).observed_at)
  check(
    'median_play / p25 / p75 / analysis_count / valid_count / creator / candidate_id 全部不变',
    ['median_play', 'p25_play', 'p75_play', 'analysis_count', 'valid_count', 'creator', 'candidate_id'].every(
      (field) => rowOf(1)[field] === beforeAll.find((r) => r.id === 1)[field]
    )
  )
  check('snapshot 行数不变（无 INSERT / DELETE）', db.prepare('SELECT COUNT(*) n FROM creator_recent_snapshots').get().n === 3)

  console.log('\n===== E. expected-before 冲突 → all-or-nothing 回滚 =====')
  // 新增两个 v1 行：apply 前人为改掉其中一行的一个字段 → 整体回滚，两行都不更新
  seedSnapshot(db, 4, '冲突甲', REAL_15)
  seedSnapshot(db, 5, '冲突乙', [10000, 10000, 10000, 10000, 10000, 50000, 50000, 50000, 50000])
  const conflictPlan = planRecentPerformanceV2Backfill(db)
  check('冲突计划包含 2 行', conflictPlan.summary.total === 2)
  // 在事务外模拟「dry-run 与 apply 之间用户又写了数据」：改掉 #4 的 trend_label
  db.prepare("UPDATE creator_recent_snapshots SET trend_label = 'stable' WHERE id = ?").run(conflictPlan.plans[0].id)
  let conflictThrown = false
  try {
    applyRecentPerformanceV2Backfill(db, conflictPlan)
  } catch (error) {
    conflictThrown = true
    check('冲突信息指明字段与 snapshot id', /#4/.test(String(error?.message)) && /trend_label/.test(String(error?.message)))
  }
  check(
    'expected-before 冲突 → 整体回滚：两行都保持 v1 原值（all-or-nothing）',
    conflictThrown &&
      rowOf(4).stats_version === 'recent-performance-v1' &&
      rowOf(5).stats_version === 'recent-performance-v1' &&
      rowOf(4).trend_label === 'stable'
  )
  check('回滚后行数不变（无部分写入）', db.prepare('SELECT COUNT(*) n FROM creator_recent_snapshots').get().n === 5)
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
