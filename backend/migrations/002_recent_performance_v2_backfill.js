/**
 * Recent Performance V2 backfill（一次性数据修正工具）
 *
 * 背景（Phase audit 顺序 bug）：
 *   v1 把「最旧 5 条」当成 recent 计算趋势派生字段 —— 方向与真实录入顺序（从旧到新）相反。
 *   v2 修正：recent = 数组末尾 5 条（最新），prior = 其余更早样本。
 *
 * 本工具只把 v1 snapshot 的 4 个趋势派生字段升级为 v2 重算值，并把 stats_version 置为 v2：
 *   trend_label / trend_ratio / recent_median_play / prior_median_play / stats_version
 *
 * 禁止修改：id / creator / creator_id / candidate_id / observed_at / plays_json /
 *            median_play / p25_play / p75_play / analysis_count / 各计数（事实与其它口径字段）。
 *
 * 用法：
 *   node backend/migrations/002_recent_performance_v2_backfill.js --db <path>            # DRY RUN（默认）
 *   node backend/migrations/002_recent_performance_v2_backfill.js --db <path> --commit   # 单事务 APPLY
 *
 * 安全：
 *   · 默认 dry-run，绝不写库
 *   · commit 模式使用 BEGIN IMMEDIATE 单事务，逐行 expected-before 校验；
 *     任何一行与计划时的 before 不一致 → 整体 ROLLBACK（all-or-nothing）
 *   · plays_json 等 fact 字段不参与 UPDATE
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { computeRecentPerformanceStats, STATS_VERSION } from '../utils/recentPerformanceStats.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DB_PATH = path.resolve(__dirname, '..', 'workbench.db')
const V1_VERSION = 'recent-performance-v1'

function parseArgs(argv) {
  const args = { db: DEFAULT_DB_PATH, mode: 'dry-run' }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--db') args.db = argv[++i]
    else if (token.startsWith('--db=')) args.db = token.slice(5)
    else if (token === '--commit') args.mode = 'commit'
  }
  return args
}

export function canonicalDbPath(dbPath) {
  try {
    return fs.realpathSync(path.resolve(String(dbPath)))
  } catch {
    return path.resolve(String(dbPath))
  }
}

/** 从 plays_json 按 v2 冻结口径确定性重算 4 个趋势派生字段（不触碰其它口径） */
export function recomputeTrendFields(playsJson) {
  const raw = JSON.parse(playsJson)
  const validPlaysInOrder = (Array.isArray(raw) ? raw : [])
    .filter((play) => play?.excluded !== true)
    .map((play) => play?.normalized_play)
    .filter((value) => Number.isFinite(value) && value >= 0)
  const stats = computeRecentPerformanceStats(validPlaysInOrder)
  return {
    recent_median_play: stats.recent_median_play,
    prior_median_play: stats.prior_median_play,
    trend_ratio: stats.trend_ratio,
    trend_label: stats.trend_label
  }
}

/**
 * 生成 backfill 计划（只读）。
 * 只处理 stats_version = recent-performance-v1 且 valid_count >= 8 的 snapshot
 *（< 8 的 v1 行 trend 本来就是 insufficient / null，方向无意义，保持原样即可）。
 */
export function planRecentPerformanceV2Backfill(db) {
  const rows = db
    .prepare(
      `SELECT id, creator, valid_count, plays_json,
              stats_version, trend_label, trend_ratio, recent_median_play, prior_median_play
       FROM creator_recent_snapshots
       WHERE stats_version = ?
       ORDER BY id ASC`
    )
    .all(V1_VERSION)
  const plans = []
  const skipped = []
  for (const row of rows) {
    if (Number(row.valid_count ?? 0) < 8) {
      skipped.push({ id: row.id, creator: row.creator, reason: `valid_count=${row.valid_count} < 8（趋势无方向意义）` })
      continue
    }
    let recomputed
    try {
      recomputed = recomputeTrendFields(row.plays_json)
    } catch (error) {
      skipped.push({ id: row.id, creator: row.creator, reason: `plays_json 解析失败：${error?.message || error}` })
      continue
    }
    plans.push({
      id: Number(row.id),
      creator: row.creator,
      before: {
        stats_version: row.stats_version,
        trend_label: row.trend_label,
        trend_ratio: row.trend_ratio,
        recent_median_play: row.recent_median_play,
        prior_median_play: row.prior_median_play
      },
      after: { stats_version: STATS_VERSION, ...recomputed }
    })
  }
  const labelChanged = plans.filter((plan) => plan.before.trend_label !== plan.after.trend_label).length
  const numericOnly = plans.filter(
    (plan) =>
      plan.before.trend_label === plan.after.trend_label &&
      (plan.before.trend_ratio !== plan.after.trend_ratio ||
        plan.before.recent_median_play !== plan.after.recent_median_play ||
        plan.before.prior_median_play !== plan.after.prior_median_play)
  ).length
  return { plans, skipped, summary: { total: plans.length, labelChanged, numericOnly, unchanged: plans.length - labelChanged - numericOnly, skipped: skipped.length } }
}

function printDryRun(plan) {
  console.log('')
  console.log('=== Recent Performance V2 backfill plan（DRY RUN，未写库）===')
  for (const item of plan.plans) {
    const labelChanged = item.before.trend_label !== item.after.trend_label
    console.log(
      `#${item.id} ${item.creator} | ${labelChanged ? 'LABEL' : 'NUMERIC'} | ` +
        `label ${item.before.trend_label} → ${item.after.trend_label} | ` +
        `ratio ${item.before.trend_ratio} → ${item.after.trend_ratio} | ` +
        `recent ${item.before.recent_median_play} → ${item.after.recent_median_play} | ` +
        `prior ${item.before.prior_median_play} → ${item.after.prior_median_play} | ` +
        `stats_version ${item.before.stats_version} → ${item.after.stats_version}`
    )
  }
  for (const item of plan.skipped) {
    console.log(`SKIP #${item.id} ${item.creator} | ${item.reason}`)
  }
  console.log(
    `summary: total=${plan.summary.total} label_changed=${plan.summary.labelChanged} ` +
      `numeric_only=${plan.summary.numericOnly} unchanged=${plan.summary.unchanged} skipped=${plan.summary.skipped}`
  )
}

/**
 * 单事务 apply：逐行 expected-before 校验，任何不一致 → 整体 ROLLBACK（all-or-nothing）。
 * 只 UPDATE 5 个派生字段；plays_json 等事实字段不参与。
 */
export function applyRecentPerformanceV2Backfill(db, plan) {
  const verifyRow = db.prepare(
    `SELECT stats_version, trend_label, trend_ratio, recent_median_play, prior_median_play
     FROM creator_recent_snapshots WHERE id = ?`
  )
  const updateRow = db.prepare(
    `UPDATE creator_recent_snapshots
     SET stats_version = ?, trend_label = ?, trend_ratio = ?, recent_median_play = ?, prior_median_play = ?
     WHERE id = ?`
  )
  let updated = 0
  // BEGIN IMMEDIATE：单事务 all-or-nothing（任何 expected-before 冲突 → 整体 ROLLBACK）
  const applyAll = db.transaction(() => {
    for (const item of plan.plans) {
      const current = verifyRow.get(item.id)
      if (!current) throw new Error(`snapshot #${item.id} 已不存在：expected-before 冲突，整体回滚`)
      const mismatch = ['stats_version', 'trend_label', 'trend_ratio', 'recent_median_play', 'prior_median_play'].find(
        (field) => current[field] !== item.before[field]
      )
      if (mismatch) {
        throw new Error(
          `snapshot #${item.id} 的 ${mismatch} 与 expected-before 不一致（当前=${JSON.stringify(current[mismatch])} 期望=${JSON.stringify(item.before[mismatch])}）：整体回滚`
        )
      }
      updateRow.run(
        item.after.stats_version,
        item.after.trend_label,
        item.after.trend_ratio,
        item.after.recent_median_play,
        item.after.prior_median_play,
        item.id
      )
      updated += 1
    }
  })
  applyAll.immediate()
  return { updated }
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = canonicalDbPath(args.db)
  if (!fs.existsSync(dbPath)) {
    console.error(`数据库不存在：${dbPath}`)
    process.exitCode = 1
    return
  }
  const db = new Database(dbPath, { readonly: args.mode !== 'commit' })
  const plan = planRecentPerformanceV2Backfill(db)
  printDryRun(plan)
  if (args.mode !== 'commit') {
    console.log('BACKFILL_RESULT: DRY_RUN（未写库）')
    db.close()
    return
  }
  if (plan.summary.total === 0) {
    console.log('BACKFILL_RESULT: NOTHING_TO_DO')
    db.close()
    return
  }
  const { updated } = applyRecentPerformanceV2Backfill(db, plan)
  console.log(`BACKFILL_RESULT: APPLIED rows=${updated}`)
  db.close()
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isEntryPoint) main()

export { DEFAULT_DB_PATH, V1_VERSION }
