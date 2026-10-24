#!/usr/bin/env node
/**
 * 星图截图识别 V1 — Golden Sample 回归测试（离线 fixture，不调用任何 AI API / 网络 / 真实 DB）
 *
 * 标准答案（用户人工核对）：15 条作品，旧 → 新；
 * 商单 3 条在第 7、11、15 位；第 1 条 48.1万；第 15 条 15.4万。
 *
 * 覆盖：
 *   1. Golden Sample 正确输入：parse / 草稿 / payload / 后端归一化 / 内容类型 / 趋势兼容
 *   2. 纵向作品列表、多张截图、缺失 position_index、重复 position_index、
 *      部分播放量未识别、非法 content_type、索引跳号、索引明显异常
 *   3. 已知限制：模型反向输出但索引自洽时，结构校验无法自动发现（如实断言，不制造虚假通过）
 */
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-golden-'))
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

function forbidNetwork() {
  const blocked = []
  const replacements = [
    [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'], [tls, 'connect']
  ]
  const originals = replacements.map(([target, method]) => [target, method, target[method]])
  for (const [target, method] of replacements) {
    target[method] = () => {
      blocked.push(`${method}`)
      throw new Error('golden sample test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('golden sample test forbids network requests')
  }
  return {
    blocked,
    restore() {
      for (const [target, method, original] of originals) target[method] = original
      global.fetch = originalFetch
    }
  }
}

const GOLDEN_VALUES = [
  481000, 362000, 334000, 199000, 771000, 181000, 306000, 223000,
  261000, 439000, 371000, 236000, 574000, 151000, 154000
]
const GOLDEN_TYPES = [
  'organic', 'organic', 'organic', 'organic', 'organic', 'organic', 'sponsored',
  'organic', 'organic', 'organic', 'sponsored', 'organic', 'organic', 'organic', 'sponsored'
]
const GOLDEN_PLAYS = GOLDEN_VALUES.map((value, index) => ({
  source_image_index: 1,
  position_index: index + 1,
  raw_text: `${value / 10000}万`,
  content_type: GOLDEN_TYPES[index]
}))

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const ai = await import(pathToFileURL(path.join(root, 'backend/routes/ai.js')).href)
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default
    const snapshots = await import(pathToFileURL(path.join(root, 'backend/routes/recentSnapshots.js')).href)
    const stats = await import(pathToFileURL(path.join(root, 'backend/utils/recentPerformanceStats.js')).href)
    const draftLib = await import(pathToFileURL(path.join(root, 'frontend/src/utils/recentPerformanceDraft.js')).href)
    const saveLib = await import(pathToFileURL(path.join(root, 'frontend/src/utils/recentPerformanceSave.js')).href)

    console.log('===== 1. Golden Sample：AI 正确输入 → 解析 =====')
    const parsed = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: 'GoldenSample',
      xingtu_price_raw: null,
      plays: GOLDEN_PLAYS,
      warnings: []
    }))
    check('作品数量 = 15', parsed.recognized_count === 15 && parsed.plays.length === 15)
    check('顺序保持：第 1 条 = 48.1万 / 第 15 条 = 15.4万（旧 → 新）',
      parsed.plays[0].raw_text === '48.1万' && parsed.plays[14].raw_text === '15.4万' &&
        parsed.plays.every((item, index) => item.position_index === index + 1),
      JSON.stringify([parsed.plays[0].raw_text, parsed.plays[14].raw_text]))
    const sponsoredPositions = parsed.plays
      .map((item, index) => (item.content_type === 'sponsored' ? index + 1 : null))
      .filter(Boolean)
    const organicCount = parsed.plays.filter((item) => item.content_type === 'organic').length
    const unknownCount = parsed.plays.filter((item) => item.content_type === 'unknown').length
    check('商单 3 条且位置 = 7、11、15', sponsoredPositions.join(',') === '7,11,15', sponsoredPositions.join(','))
    check('日常 12 条 / 未识别 0 条', organicCount === 12 && unknownCount === 0)
    check('正确输入不产生结构警告', parsed.warnings.length === 0, JSON.stringify(parsed.warnings))

    console.log('\n===== 2. Golden Sample：草稿 → 保存 payload → 后端归一化 → 趋势 =====')
    const draft = draftLib.buildDraftFromExtraction(parsed)
    check('草稿顺序保持（旧 → 新）', draft.plays[0].raw_text === '48.1万' && draft.plays[14].raw_text === '15.4万')
    check('草稿内容类型保持（第 7 条 = sponsored）', draft.plays[6].content_type === 'sponsored')
    const payload = saveLib.buildSnapshotPayload(draft, { creator: 'GoldenSample', observedAt: '2026-10-20' })
    check('保存 payload 顺序保持且携带类型 / 位置',
      payload.plays.length === 15 && payload.plays[0].raw_text === '48.1万' &&
        payload.plays[6].content_type === 'sponsored' && payload.plays[14].position_index === 15)

    const normalized = snapshots.normalizeSnapshotPlays(payload.plays)
    check('后端归一化：顺序原样保留（旧 → 新）',
      JSON.stringify(normalized.validPlaysInOrder) === JSON.stringify(GOLDEN_VALUES))
    check('后端归一化：15 条有效 / 0 未解析 / 0 排除',
      normalized.valid_count === 15 && normalized.unresolved_count === 0 && normalized.excluded_count === 0)
    const breakdown = stats.computeContentTypeBreakdown(normalized.plays)
    check('内容类型分组：商单 3 / 日常 12 / 未识别 0',
      breakdown.sponsored_count === 3 && breakdown.organic_count === 12 && breakdown.unknown_count === 0)
    const statsResult = stats.computeRecentPerformanceStats(normalized.validPlaysInOrder)
    check('Recent Performance V2 兼容：trend = down / ratio = -0.2625（尾 5 条 = 最新）',
      statsResult.trend_label === 'down' && statsResult.trend_ratio === -0.2625,
      JSON.stringify({ trend: statsResult.trend_label, ratio: statsResult.trend_ratio }))
    check('Recent Performance V2 兼容：recent_median = 23.6万 / prior_median = 32万',
      statsResult.recent_median_play === 236000 && statsResult.prior_median_play === 320000)

    console.log('\n===== 3. 纵向作品列表 / 多张截图 =====')
    const listParsed = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: 'ListCreator', xingtu_price_raw: null,
      plays: [
        { source_image_index: 1, position_index: 1, raw_text: '1.2万', content_type: 'organic' },
        { source_image_index: 1, position_index: 2, raw_text: '8000', content_type: 'unknown' },
        { source_image_index: 1, position_index: 3, raw_text: '3.4万', content_type: 'sponsored' }
      ],
      warnings: []
    }))
    check('纵向列表：按从上到下顺序保持，类型保留',
      listParsed.plays.map((p) => p.raw_text).join(',') === '1.2万,8000,3.4万' &&
        listParsed.plays[1].content_type === 'unknown')

    const multiParsed = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: 'MultiCreator', xingtu_price_raw: null,
      plays: [
        { source_image_index: 1, position_index: 1, raw_text: '2万', content_type: 'organic' },
        { source_image_index: 1, position_index: 2, raw_text: '3万', content_type: 'organic' },
        { source_image_index: 1, position_index: 3, raw_text: '4万', content_type: 'sponsored' },
        { source_image_index: 2, position_index: 1, raw_text: '5万', content_type: 'organic' },
        { source_image_index: 2, position_index: 2, raw_text: '6万', content_type: 'organic' }
      ],
      warnings: []
    }))
    check('多张截图：来源归属与顺序保持，无跳号警告',
      multiParsed.plays[0].source_image_index === 1 && multiParsed.plays[3].source_image_index === 2 &&
        multiParsed.warnings.every((w) => !w.includes('跳到')),
      JSON.stringify(multiParsed.warnings))

    console.log('\n===== 4. 缺失 / 重复 / 异常索引 / 未识别 / 非法类型 =====')
    const missingPos = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: 'X', xingtu_price_raw: null,
      plays: [
        { source_image_index: 1, raw_text: '1万', content_type: 'organic' },
        { source_image_index: 1, raw_text: '2万', content_type: 'organic' }
      ],
      warnings: []
    }))
    check('缺失 position_index：回退为返回顺序（不崩溃、不纠序）',
      missingPos.plays[0].position_index === 1 && missingPos.plays[1].position_index === 2)

    const dupPos = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: 'X', xingtu_price_raw: null,
      plays: [
        { source_image_index: 1, position_index: 1, raw_text: '1万', content_type: 'organic' },
        { source_image_index: 1, position_index: 2, raw_text: '2万', content_type: 'organic' },
        { source_image_index: 1, position_index: 2, raw_text: '3万', content_type: 'organic' }
      ],
      warnings: []
    }))
    check('同一图重复 position_index → 产生人工核对警告',
      dupPos.warnings.some((w) => w.includes('重复出现')), JSON.stringify(dupPos.warnings))

    const abnormalPos = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: 'X', xingtu_price_raw: null,
      plays: [1, 2, 3, 4, 30].map((position) => ({
        source_image_index: 1, position_index: position, raw_text: `${position}万`, content_type: 'organic'
      })),
      warnings: []
    }))
    check('索引明显异常（5 条却出现 position 30）→ 产生警告，且不自动重排',
      abnormalPos.warnings.some((w) => w.includes('明显大于')) &&
        abnormalPos.plays[4].position_index === 30 && abnormalPos.plays[4].raw_text === '30万',
      JSON.stringify(abnormalPos.warnings))

    const imageSkip = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: 'X', xingtu_price_raw: null,
      plays: [
        { source_image_index: 1, position_index: 1, raw_text: '1万', content_type: 'organic' },
        { source_image_index: 3, position_index: 1, raw_text: '2万', content_type: 'organic' }
      ],
      warnings: []
    }))
    check('source_image_index 跳号（1→3）→ 产生警告', imageSkip.warnings.some((w) => w.includes('跳到')))

    const partial = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: 'X', xingtu_price_raw: null,
      plays: [
        { source_image_index: 1, position_index: 1, raw_text: '1万', content_type: 'organic' },
        { source_image_index: 1, position_index: 2, raw_text: null, content_type: 'unknown' }
      ],
      warnings: []
    }))
    check('部分播放量未识别：保留 null 并标记 needs_review，不猜测补全',
      partial.plays[1].raw_text === null && partial.plays[1].normalized_play === null &&
        partial.plays[1].needs_review === true)
    const partialNormalized = snapshots.normalizeSnapshotPlays(partial.plays)
    check('部分播放量未识别：unresolved = 1 / valid = 1（不计入趋势样本）',
      partialNormalized.unresolved_count === 1 && partialNormalized.valid_count === 1)

    const illegalType = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: 'X', xingtu_price_raw: null,
      plays: [{ source_image_index: 1, position_index: 1, raw_text: '1万', content_type: 'promo' }],
      warnings: []
    }))
    check('非法 content_type 降级为 unknown', illegalType.plays[0].content_type === 'unknown')

    console.log('\n===== 4b. 单色柱状图场景（全蓝 / 全粉红，均为离线 fixture，非真实视觉实测）=====')
    // 业务规则：允许全部作品为同一类型 —— 没有商单 ≠ 未识别；不要求两种颜色同时出现
    const allBlueValues = [95000, 210000, 581000, 44000, 88000, 132000, 76000, 240000, 61000, 98000, 175000, 52000, 121000, 67000, 110000]
    const allBlue = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: 'AllBlue', xingtu_price_raw: null,
      plays: allBlueValues.map((value, index) => ({
        source_image_index: 1, position_index: index + 1,
        raw_text: `${value / 10000}万`, content_type: 'organic'
      })),
      warnings: []
    }))
    check('全蓝 15 条 → 15 organic / 0 sponsored / 0 unknown（全同色是合法输出）',
      allBlue.recognized_count === 15 &&
        allBlue.plays.every((item) => item.content_type === 'organic'))
    check('全蓝顺序不反转：位置 1..15 递增，首条 9.5万 / 末条 11万',
      allBlue.plays.every((item, index) => item.position_index === index + 1) &&
        allBlue.plays[0].raw_text === '9.5万' && allBlue.plays[14].raw_text === '11万')
    check('全蓝不产生结构警告', allBlue.warnings.length === 0, JSON.stringify(allBlue.warnings))

    const allPink = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: 'AllPink', xingtu_price_raw: null,
      plays: allBlueValues.map((value, index) => ({
        source_image_index: 1, position_index: index + 1,
        raw_text: `${value / 10000}万`, content_type: 'sponsored'
      })),
      warnings: []
    }))
    check('全粉红 15 条 → 15 sponsored / 0 organic / 0 unknown',
      allPink.recognized_count === 15 &&
        allPink.plays.every((item) => item.content_type === 'sponsored'))
    check('全粉红顺序不反转（位置 1..15 递增）',
      allPink.plays.every((item, index) => item.position_index === index + 1))

    // 已知混淆点：粉红色火焰图标叠加在蓝色柱体上 —— 柱体填充颜色才是分类依据
    const flameOnBlue = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: 'FlameCase', xingtu_price_raw: null,
      plays: [
        { source_image_index: 1, position_index: 1, raw_text: '5万', content_type: 'organic' },
        { source_image_index: 1, position_index: 2, raw_text: '58.1万', content_type: 'organic' },
        { source_image_index: 1, position_index: 3, raw_text: '2.3万', content_type: 'organic' },
        { source_image_index: 1, position_index: 4, raw_text: '4.1万', content_type: 'organic' },
        { source_image_index: 1, position_index: 5, raw_text: '3.6万', content_type: 'organic' },
        { source_image_index: 1, position_index: 6, raw_text: '6.8万', content_type: 'organic' },
        { source_image_index: 1, position_index: 7, raw_text: '2.9万', content_type: 'organic' },
        { source_image_index: 1, position_index: 8, raw_text: '4.4万', content_type: 'organic' }
      ],
      warnings: []
    }))
    check('蓝色柱体 + 粉红火焰图标 → 保持 organic（解析层不改写类型）',
      flameOnBlue.plays.every((item) => item.content_type === 'organic'))
    const flameOnBlueStats = stats.computeRecentPerformanceStats(
      snapshots.normalizeSnapshotPlays(flameOnBlue.plays).validPlaysInOrder
    )
    check('单色场景趋势计算兼容（顺序未反转）',
      flameOnBlueStats.stats_status === 'ok' && flameOnBlueStats.trend_label !== 'insufficient')

    console.log('\n===== 5. 已知限制（如实断言，不制造虚假通过）=====')
    const reversed = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: 'X', xingtu_price_raw: null,
      plays: [
        { source_image_index: 1, position_index: 3, raw_text: '3万', content_type: 'organic' },
        { source_image_index: 1, position_index: 2, raw_text: '2万', content_type: 'organic' },
        { source_image_index: 1, position_index: 1, raw_text: '1万', content_type: 'organic' }
      ],
      warnings: []
    }))
    check('已知限制：模型反向输出且索引自洽（1/2/3 连续）时，结构校验无法自动发现，需人工/视觉核对',
      reversed.plays[0].raw_text === '3万' && reversed.warnings.length === 0,
      JSON.stringify(reversed.warnings))

    check('未发生任何外部网络请求', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))
    check('隔离库位于临时目录（未触碰真实 workbench.db）', process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir()))
  } finally {
    networkGuard.restore()
  }

  console.log(`\n================ 测试汇总 ================`)
  console.log(`用例总数：${passCount + failCount}　通过：${passCount}　失败：${failCount}　通过率：${((passCount / (passCount + failCount)) * 100).toFixed(1)}%`)
  if (failCount > 0) {
    console.log('\n失败用例：')
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('测试执行异常：', error)
  process.exitCode = 1
})
