#!/usr/bin/env node
// 近期表现 / 近期内容表现 语义审计（P1–P5 Stabilization Audit 衍生专项）
//
// 运行方式：node tests/recent_performance_semantics.test.js（纯函数，无 DB / 无网络）
//
// 锁定：
//   §1 趋势定义：最新 5 条（数组末尾）中位 vs 其余中位（人工录入顺序 = 从旧到新；130.4w = 最新）
//   §2 商单样本充分性：0 条商单 → 「暂无商单样本」（绝不显示「商单样本充足」）
//   §3 趋势由「最近 5 条中至少 3 条的水平」决定（中位数），不是均值被单个极值拉高
//   「单次表现突出」来自 Radar 历史 CPM 单样本，与快照 trend 是两套算法 / 两个数据源

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')
// 本测试只用纯函数，但 backend/routes/records.js 会 import db.js —— 必须指向临时库，
// 保证绝不打开真实业务库（即使只读 / 幂等 init 也不应该发生在真实库上）。
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-performance-semantics-'))
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

// 样板达人11 真实快照 #18 的 15 条有效播放（存储顺序 = 人工录入顺序，从旧到新；130.4w = 最新）
const REAL_PLAYS_IN_ORDER = [
  77000, 37000, 52000, 135000, 55000,
  85000, 153000, 52000, 75000, 41000,
  22000, 187000, 59000, 145000, 1304000
]

async function main() {
  const statsModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/utils/recentPerformanceStats.js')).href
  )
  const contentTypeModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/contentType.js')).href
  )
  const workspaceModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/workspaceSummary.js')).href
  )
  const recordsModule = await import(pathToFileURL(path.join(REPO_ROOT, 'backend/routes/records.js')).href)
  const { computeRecentPerformanceStats } = statsModule
  const { buildContentPerformanceLines, getSponsoredSampleTier } = contentTypeModule
  const { buildContentBlock } = workspaceModule
  const { computeWorkPriority } = recordsModule

  console.log('\n===== A. 趋势算法：真实 15 条复算 =====')
  const stats = computeRecentPerformanceStats(REAL_PLAYS_IN_ORDER)
  check('近期中位播放 = 7.5万（去 1 高 1 低后 13 条的中位）', stats.median_play === 75000, String(stats.median_play))
  check('analysis_count = 13（15 − 1 最高 − 1 最低）', stats.analysis_count === 13)
  check('recent 5 = 最后 5 条 = 2.2w/18.7w/5.9w/14.5w/130.4w → 中位 14.5万', stats.recent_median_play === 145000, String(stats.recent_median_play))
  check('prior 10 = 前 10 条 → 中位 6.5万（5.5w/7.5w 的平均）', stats.prior_median_play === 65000, String(stats.prior_median_play))
  check('trend_ratio ≈ +1.2308（14.5/6.5 − 1 ≈ +123.08%）', stats.trend_ratio === Number((145000 / 65000 - 1).toFixed(4)), String(stats.trend_ratio))
  check('trend_label = up（+123.08% ≥ +20%）', stats.trend_label === 'up')
  check('stats_status = ok（15 ≥ 5）', stats.stats_status === 'ok')

  console.log('\n===== B. 130.4w 是否参与 / 是否能单独翻转方向 =====')
  check('130.4w = 最新一条（数组末位，对应 2026-10-09），参与 recent 组', REAL_PLAYS_IN_ORDER[14] === 1304000)
  const withoutOutlier = computeRecentPerformanceStats(REAL_PLAYS_IN_ORDER.slice(0, 14))
  check(
    '移除 130.4w（最新一条）：recent 中位 14.5万 → 5.9万、prior 7.5万 → 方向翻转为 down（−21.33%）',
    withoutOutlier.recent_median_play === 59000 &&
      withoutOutlier.prior_median_play === 75000 &&
      withoutOutlier.trend_label === 'down'
  )
  // 冻结定义本身对顺序敏感：若 130.4w 位于最新 5 条内，中位会被拉高 → up（这是定义，不是实现错误）
  const outlierRecent = computeRecentPerformanceStats([
    1304000, 77000, 37000, 52000, 135000,
    55000, 85000, 153000, 52000, 75000,
    41000, 22000, 187000, 59000, 145000
  ])
  check(
    '定义敏感性（文档化）：130.4w 落在 prior（最旧）→ down（−22.37%）：极值位置决定方向',
    outlierRecent.recent_median_play === 59000 &&
      outlierRecent.prior_median_play === 76000 &&
      outlierRecent.trend_label === 'down' &&
      outlierRecent.trend_ratio === Number((59000 / 76000 - 1).toFixed(4)),
    `recent=${outlierRecent.recent_median_play} ratio=${outlierRecent.trend_ratio} label=${outlierRecent.trend_label}`
  )
  check(
    '产品语义成立：中位定义下趋势由「最近 5 条中至少 3 条的水平」决定，不是均值被单个极值拉高',
    Number.isInteger(outlierRecent.analysis_count)
  )
  check(
    '均值对照：全 15 条 mean ≈ 16.53万（被 130.4w 严重拉高）vs 中位 7.5万 —— 中位是正确选择',
    Math.round(REAL_PLAYS_IN_ORDER.reduce((sum, value) => sum + value, 0) / 15) === 165267
  )
  check(
    '真实个案的 up 由 recent 组 3 条 ≥10w 播放共同支撑（18.7w / 14.5w / 130.4w），不是单点伪象',
    REAL_PLAYS_IN_ORDER.slice(-5).filter((value) => value >= 100000).length === 3
  )

  console.log('\n===== C. 「单次表现突出」与 trend 是两套算法 / 两个数据源 =====')
  const priority = computeWorkPriority({ validCount: 1, status: 'insufficient', singleSampleCpmRaw: 0.6 })
  check(
    'Radar 优先级来自历史 CPM 单样本（0.6 ≤ 10 → 单次表现突出）',
    priority.work_priority === 'high_attention' && priority.work_priority_reason === 'single_sample_cpm_le_10'
  )
  check(
    'trend 来自快照播放（与历史 CPM 无关）：同一达人 trend=up 而 优先级=单次表现突出 可同时成立',
    stats.trend_label === 'up' && priority.work_priority_reason === 'single_sample_cpm_le_10'
  )

  console.log('\n===== D. 商单样本充分性（0 / 1–2 / ≥3 分档） =====')
  check('0 条商单 → tier none', getSponsoredSampleTier(0) === 'none')
  check('1–2 条商单 → tier insufficient', getSponsoredSampleTier(1) === 'insufficient' && getSponsoredSampleTier(2) === 'insufficient')
  check('≥3 条商单 → tier sufficient', getSponsoredSampleTier(3) === 'sufficient' && getSponsoredSampleTier(15) === 'sufficient')

  const zeroSponsoredCell = buildContentPerformanceLines({
    sponsored_count: 0,
    sponsored_median_play: null,
    organic_count: 15,
    organic_median_play: 75000,
    unknown_count: 0
  })
  check(
    'Radar 单元格：0 条商单 → 「暂无商单数据」+「暂无商单样本」（不再缺席提示）',
    JSON.stringify(zeroSponsoredCell.lines) ===
      JSON.stringify([
        { text: '暂无商单数据', primary: true },
        { text: '暂无商单样本', primary: false },
        { text: '日常中位 7.5万 · 15条', primary: false }
      ]),
    JSON.stringify(zeroSponsoredCell.lines)
  )

  console.log('\n===== E. 工作区「样本」行：不得显示「商单样本充足」当商单为 0 =====')
  const makeItem = (sponsoredCount, sponsoredMedian) => ({
    recent_snapshot: {
      median_play: 75000,
      trend_label: 'down',
      trend_ratio: -0.3125,
      observed_at: '2026-10-10',
      valid_count: 15,
      sponsored_count: sponsoredCount,
      sponsored_median_play: sponsoredMedian,
      organic_count: 15,
      organic_median_play: 75000,
      unknown_count: 0,
      xingtu_price: null,
      pricing: null
    },
    recent_decision: null
  })
  const zeroBlock = buildContentBlock(makeItem(0, null))
  check(
    '0 条商单 → 样本 = 「暂无商单样本」（真实个案：样板达人11）',
    zeroBlock.rows.find((row) => row.label === '样本')?.value === '暂无商单样本',
    JSON.stringify(zeroBlock.rows)
  )
  check(
    '0 条商单 → 商单行 = 「暂无商单数据」（矛盾消除）',
    zeroBlock.rows.find((row) => row.label === '商单')?.value === '暂无商单数据'
  )
  const fewBlock = buildContentBlock(makeItem(2, 42000))
  check(
    '2 条商单 → 样本 = 「商单样本较少」（不变）',
    fewBlock.rows.find((row) => row.label === '样本')?.value === '商单样本较少'
  )
  const enoughBlock = buildContentBlock(makeItem(3, 50000))
  check(
    '≥3 条商单 → 样本 = 「商单样本充足」（只有此时才允许「充足」）',
    enoughBlock.rows.find((row) => row.label === '样本')?.value === '商单样本充足'
  )
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
