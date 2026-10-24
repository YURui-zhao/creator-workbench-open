#!/usr/bin/env node
/**
 * 播放口径核心（Batch 1）单元测试
 *
 * 运行方式：node tests/play_metrics.test.js
 * 特性：不启动服务、不打开浏览器、不写数据库；直接调用 backend/routes/records.js 导出的纯函数
 *
 * 已冻结的产品口径：
 *   first_play       = 7日累计播放量（发布约 7 天时的累计值，不是「首周新增」）
 *   second_week_play = 最新累计播放量（最近一次更新时的累计总播放，不限于第 2 周）
 *   total_play       = Σ有效最新累计播放（不再是 first + second）
 *   最新CPM          = 有 latest 记录的花费 ÷ 这些记录的 latest 总和 × 1000
 *   7日CPM           = first>0 记录的花费 ÷ 这些记录的 first 总和 × 1000
 *   累计爆款 = latest >= 阈值（主爆款）；7日爆款 = first >= 阈值
 */
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')

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

async function main() {
  const recordsModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/records.js')).href
  )
  const { summarizePlayRecords, computePlayMetrics, HOT_PLAY_THRESHOLD } = recordsModule

  check(
    '已导出播放口径核心函数（computePlayMetrics / summarizePlayRecords）',
    typeof computePlayMetrics === 'function' && typeof summarizePlayRecords === 'function'
  )
  check('爆款阈值沿用 100000（本轮不改）', HOT_PLAY_THRESHOLD === 100000)

  console.log('\n===== CASE 1：cost 1000 / first 10000 / latest 20000 =====')
  const c1 = summarizePlayRecords([
    { total_cost: 1000, first_play: 10000, second_week_play: 20000, nickname: 'A' }
  ])
  check('total_play = 20000（不是 first + second = 30000）', c1.total_play === 20000, `total_play=${c1.total_play}`)
  check('latest_play_total = 20000 / first_play_total = 10000', c1.latest_play_total === 20000 && c1.first_play_total === 10000)
  check('7日后新增 = 10000', c1.post_7d_growth_total === 10000, `growth=${c1.post_7d_growth_total}`)
  check('最新平均CPM = 50', c1.avg_cpm === 50, `avg_cpm=${c1.avg_cpm}`)
  check('7日平均CPM = 100', c1.cpm_7d === 100, `cpm_7d=${c1.cpm_7d}`)
  check('样本数：first 1 / latest 1', c1.first_sample_count === 1 && c1.latest_sample_count === 1)
  check('总花费 / 投放次数正常', c1.total_cost === 1000 && c1.record_count === 1 && c1.creator_count === 1)
  check('爆款：7日 false / 累计 false', c1.hit_7d_count === 0 && c1.hit_latest_count === 0)

  console.log('\n===== CASE 2：first 有值、latest 为空（待更新）=====')
  const c2 = summarizePlayRecords([
    { total_cost: 1000, first_play: 10000, second_week_play: null, nickname: 'B' }
  ])
  check('总花费仍包含 1000', c2.total_cost === 1000, `cost=${c2.total_cost}`)
  check('投放次数 +1（不因 latest 缺失而减少）', c2.record_count === 1)
  check('7日累计 +10000', c2.first_play_total === 10000)
  check('latest_play_total 不增加（= 0）', c2.latest_play_total === 0)
  check('latest 样本数 = 0（累计爆款率分母不含该记录）', c2.latest_sample_count === 0)
  check('最新平均CPM = null（分子不含该记录花费）', c2.avg_cpm === null, `avg_cpm=${c2.avg_cpm}`)
  check('累计爆款率 = null（无最新累计样本）', c2.hit_rate_latest === null)
  check('7日CPM = 100（first > 0 样本）', c2.cpm_7d === 100)
  check('7日爆款率分母含该记录 → 0%', c2.hit_rate_7d === 0)
  check('latest 待更新数 = 1', c2.latest_pending_count === 1)
  check('7日后新增不计入（保持 0）', c2.post_7d_growth_total === 0)

  console.log('\n===== CASE 3：first 0 / latest 50000 =====')
  const c3 = summarizePlayRecords([{ total_cost: 1000, first_play: 0, second_week_play: 50000 }])
  check('7日CPM = null（不返回 Infinity / 0）', c3.cpm_7d === null, `cpm_7d=${c3.cpm_7d}`)
  check('最新CPM = 20', c3.avg_cpm === 20, `avg_cpm=${c3.avg_cpm}`)
  check('7日后新增 = 50000', c3.post_7d_growth_total === 50000)
  check('7日爆款 = false', c3.hit_7d_count === 0)
  check('total_play = 50000', c3.total_play === 50000)
  check('7日CPM 样本（first>0）为 0，但 first 有效样本为 1', c3.first_positive_sample_count === 0 && c3.first_sample_count === 1)

  console.log('\n===== CASE 4（边界修正）：latest < first 判定异常，完全排除 latest 指标 =====')
  const c4 = summarizePlayRecords([{ total_cost: 1000, first_play: 120000, second_week_play: 80000 }])
  check('anomaly_count = 1', c4.anomaly_count === 1)
  check('latest_sample_count = 0', c4.latest_sample_count === 0)
  check('latest_play_total = 0 / total_play = 0', c4.latest_play_total === 0 && c4.total_play === 0)
  check('avg_cpm = null（异常记录 cost 不进分子）', c4.avg_cpm === null, `avg_cpm=${c4.avg_cpm}`)
  check('hit_latest_count = 0 / hit_rate_latest = null', c4.hit_latest_count === 0 && c4.hit_rate_latest === null)
  check('post_7d_growth_total 不出现负数（= 0）', c4.post_7d_growth_total === 0, `growth=${c4.post_7d_growth_total}`)
  check('latest_pending_count = 0（异常不算「待更新」）', c4.latest_pending_count === 0)
  check(
    '不依赖 latest 的指标照常：总花费 / 投放次数 / 7日累计',
    c4.total_cost === 1000 && c4.record_count === 1 && c4.first_play_total === 120000
  )
  check('7日CPM = 1000 / 120000 × 1000 = 8.33', c4.cpm_7d === Number(((1000 / 120000) * 1000).toFixed(2)), `cpm_7d=${c4.cpm_7d}`)
  check('7日爆款 = true / 7日爆款率 = 100%', c4.hit_7d_count === 1 && c4.hit_rate_7d === 100)
  check('无 NaN / Infinity', !Number.isNaN(c4.cpm_7d) && c4.avg_cpm === null)

  console.log('\n===== CASE 12（边界修正）：正常 + 异常混合，异常不得污染最新CPM =====')
  const c12 = summarizePlayRecords([
    { total_cost: 1000, first_play: 10000, second_week_play: 20000 },
    { total_cost: 9000, first_play: 120000, second_week_play: 80000 }
  ])
  check('最新平均CPM = 1000 / 20000 × 1000 = 50（不是 10000/20000 = 500）', c12.avg_cpm === 50, `avg_cpm=${c12.avg_cpm}`)
  check('latest_play_total = 20000（异常 latest 不进分母）', c12.latest_play_total === 20000)
  check('latest_sample_count = 1（异常不计入样本）', c12.latest_sample_count === 1)
  check('anomaly_count = 1 / latest_pending_count = 0', c12.anomaly_count === 1 && c12.latest_pending_count === 0)
  check('total_cost = 10000（异常记录花费仍计入总花费）', c12.total_cost === 10000)
  check(
    '7日CPM 分子含两条记录花费 = 10000 / 130000 × 1000 ≈ 76.92',
    c12.cpm_7d === Number(((10000 / 130000) * 1000).toFixed(2)),
    `cpm_7d=${c12.cpm_7d}`
  )
  check('7日爆款数 = 1（仅 first 12 万那条 >= 阈值）', c12.hit_7d_count === 1)
  check('累计爆款数 = 0（唯一有效 latest 20000 < 阈值）', c12.hit_latest_count === 0)

  console.log('\n===== CASE 5（重点）：最新平均CPM 分子必须与分母同一样本 =====')
  const c5 = summarizePlayRecords([
    { total_cost: 1000, first_play: 10000, second_week_play: 20000, nickname: 'A' },
    { total_cost: 9000, first_play: 50000, second_week_play: null, nickname: 'B' }
  ])
  check('最新平均CPM = 50（不是 10000 / 20000 = 500）', c5.avg_cpm === 50, `avg_cpm=${c5.avg_cpm}`)
  check('total_cost = 10000（两条记录花费都计入）', c5.total_cost === 10000)
  check('total_play = 20000（只有 A 有 latest）', c5.total_play === 20000)
  check('7日CPM = 10000 / 60000 × 1000 = 166.67', c5.cpm_7d === Number(((10000 / 60000) * 1000).toFixed(2)), `cpm_7d=${c5.cpm_7d}`)
  check('latest 待更新数 = 1', c5.latest_pending_count === 1)

  console.log('\n===== CASE 6：累计爆款率分母 = 有 latest 的有效记录数 =====')
  const c6 = summarizePlayRecords([
    { total_cost: 100, first_play: 1000, second_week_play: 150000 },
    { total_cost: 100, first_play: 1000, second_week_play: 50000 },
    { total_cost: 100, first_play: 1000, second_week_play: null }
  ])
  check('累计爆款数 = 1', c6.hit_latest_count === 1)
  check('累计爆款率 = 50%（不是 1/3 = 33.3%）', c6.hit_rate_latest === 50, `rate=${c6.hit_rate_latest}`)
  check('兼容字段 hit_count / hit_rate = 累计爆款 / 累计爆款率', c6.hit_count === 1 && c6.hit_rate === 50)

  console.log('\n===== CASE 7：7日爆款 ≠ 累计爆款 =====')
  const c7 = summarizePlayRecords([{ total_cost: 1000, first_play: 80000, second_week_play: 150000 }])
  check('7日爆款 = false', c7.hit_7d_count === 0)
  check('累计爆款 = true', c7.hit_latest_count === 1)
  check('7日爆款率 = 0%', c7.hit_rate_7d === 0)
  check('累计爆款率 = 100%', c7.hit_rate_latest === 100)

  console.log('\n===== CASE 8（补充修正）：first=0 的记录花费必须进入 7日CPM 分子 =====')
  const c8 = summarizePlayRecords([
    { total_cost: 1000, first_play: 10000, second_week_play: 20000 },
    { total_cost: 1000, first_play: 0, second_week_play: 5000 }
  ])
  check('7日CPM = 2000 / 10000 × 1000 = 200（不是 100）', c8.cpm_7d === 200, `cpm_7d=${c8.cpm_7d}`)
  check('7日CPM 样本数 = 2（含 first=0 的记录）', c8.first_sample_count === 2)
  check('first>0 样本数 = 1（仅统计参考，不再决定分子）', c8.first_positive_sample_count === 1)
  check('7日累计总播放仍 = 10000', c8.first_play_total === 10000)
  check('最新平均CPM = 2000 / 25000 × 1000 = 80（不受 first=0 影响）', c8.avg_cpm === 80, `avg_cpm=${c8.avg_cpm}`)

  console.log('\n===== CASE 9（补充修正）：latest=0 的记录花费必须进入最新CPM 分子 =====')
  // 注意：latest=0 只有不违反「latest >= first」时才是有效观察值（如 first=0 或 first 缺失）
  const c9 = summarizePlayRecords([
    { total_cost: 1000, first_play: 10000, second_week_play: 20000 },
    { total_cost: 1000, first_play: 0, second_week_play: 0 }
  ])
  check('最新平均CPM = 2000 / 20000 × 1000 = 100', c9.avg_cpm === 100, `avg_cpm=${c9.avg_cpm}`)
  check('latest 样本数 = 2（latest=0 是有效观察值）', c9.latest_sample_count === 2)
  check('最新累计总播放 = 20000', c9.latest_play_total === 20000)
  check('latest 待更新数 = 0（latest=0 不算待更新）', c9.latest_pending_count === 0)
  check('异常计数 = 0（first=0 / latest=0 不构成异常）', c9.anomaly_count === 0)

  const c9b = summarizePlayRecords([{ total_cost: 1000, first_play: 10000, second_week_play: 0 }])
  check(
    'first=10000 / latest=0 属于异常（0 < first）：不计入 latest 指标',
    c9b.anomaly_count === 1 && c9b.latest_sample_count === 0 && c9b.avg_cpm === null && c9b.latest_pending_count === 0,
    `anomaly=${c9b.anomaly_count} samples=${c9b.latest_sample_count} avg_cpm=${c9b.avg_cpm}`
  )

  const c10 = summarizePlayRecords([{ total_cost: 1000, first_play: 100, second_week_play: 0 }])
  check('全部 latest=0 时最新平均CPM = null（不返回 0 / Infinity）', c10.avg_cpm === null)
  const c11 = summarizePlayRecords([{ total_cost: 1000, first_play: 0, second_week_play: 0 }])
  check('全部 first=0 时 7日CPM = null（Σfirst = 0）', c11.cpm_7d === null, `cpm_7d=${c11.cpm_7d}`)

  console.log('\n===== 附加：null / undefined / 空串 / 0 的区分 =====')
  const cz = summarizePlayRecords([
    { total_cost: '1000', first_play: '', second_week_play: undefined },
    { total_cost: null, first_play: null, second_week_play: 0 }
  ])
  check('空串 / undefined 视为「未填写」', cz.first_sample_count === 0 && cz.latest_play_total === 0)
  check('0 视为真实值（latest = 0 计入样本）', cz.latest_sample_count === 1)
  check('latest 全为 0 时最新CPM = null（不返回 0 / Infinity）', cz.avg_cpm === null && cz.cpm_7d === null)
  check('无 NaN', !Number.isNaN(cz.avg_cpm) && !Number.isNaN(cz.hit_rate_latest))

  const cm = computePlayMetrics({ total_cost: 1000, first_play: 10000, second_week_play: 20000 })
  check(
    'computePlayMetrics 单条结果正确',
    cm.cost === 1000 && cm.first === 10000 && cm.latest === 20000 && cm.post7dGrowth === 10000 && cm.latestAnomaly === false
  )

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
})
