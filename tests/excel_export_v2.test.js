#!/usr/bin/env node
/**
 * Excel 导出：V2 术语与口径测试（Batch 4B-1）
 *
 * 运行方式：node tests/excel_export_v2.test.js
 * 特性：不启动服务、不打开浏览器、不写数据库（仅在 outputs/ 生成临时 xlsx，测试后删除）
 *
 * 覆盖：
 *   CASE 1~5  记录明细导出的 7日播放量 / 累计播放量 / 后续新增播放量 / CPM 取值规则
 *   导出→导入回环：新导出文件可被 Batch 4A 的导入器正确识别
 *   达人汇总导出：V2 列名与取值
 */
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')

const REPO_ROOT = path.resolve(__dirname, '..')
const requireFromFrontend = createRequire(path.join(REPO_ROOT, 'frontend', 'package.json'))
const XLSX = requireFromFrontend('xlsx')

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

const baseRecord = (overrides = {}) => ({
  id: 1,
  time_cycle: '2026-W33',
  nickname: '导出测试达人',
  creator_type: '美妆种草',
  homepage: 'https://www.douyin.com/user/export-case',
  content_link: 'https://www.zhihu.com/question/1/answer/2',
  video_link: 'https://v.douyin.com/export-case/',
  total_cost: 1000,
  first_play: 10000,
  second_week_play: 20000,
  publish_date: '2026-08-20',
  ...overrides
})

async function main() {
  const excelModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/excel.js')).href
  )
  const { exportRecordsToExcel, exportCreatorStatsToExcel, parseRecordsExcel } = excelModule

  const outDir = path.join(REPO_ROOT, 'outputs')
  fs.mkdirSync(outDir, { recursive: true })
  const recordFile = path.join(outDir, '__export_v2_records.xlsx')
  const creatorFile = path.join(outDir, '__export_v2_creators.xlsx')

  const exportRecord = (row) => {
    exportRecordsToExcel([row], recordFile)
    const buffer = fs.readFileSync(recordFile)
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const sheetRows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
    return { row: sheetRows[0] || {}, buffer }
  }

  console.log('===== 记录明细导出列名（V2）=====')
  const headerRow = exportRecord(baseRecord()).row
  const expectedHeaders = [
    '时间周期',
    '达人昵称',
    '达人类型',
    '达人主页',
    '植入链接',
    '视频链接',
    '总花费(元)',
    'CPM',
    '7日播放量',
    '累计播放量',
    '后续新增播放量',
    '发布日期'
  ]
  check(
    '导出列名与顺序为 V2 术语',
    JSON.stringify(Object.keys(headerRow)) === JSON.stringify(expectedHeaders),
    Object.keys(headerRow).join('|')
  )
  check('不再出现旧列名（首发播放量 / 次周播放量 / CPM数据 / 博主类型）',
    ['首发播放量', '次周播放量', 'CPM数据', '博主类型'].every((key) => !(key in headerRow)))

  console.log('\n===== CASE 1：first=10000 / latest=20000 / cost=1000 =====')
  const c1 = exportRecord(baseRecord()).row
  check('7日播放量 = 10000', Number(c1['7日播放量']) === 10000, String(c1['7日播放量']))
  check('累计播放量 = 20000', Number(c1['累计播放量']) === 20000, String(c1['累计播放量']))
  check('后续新增播放量 = 10000', Number(c1['后续新增播放量']) === 10000, String(c1['后续新增播放量']))
  check('CPM = 50', Number(c1['CPM']) === 50, String(c1['CPM']))

  console.log('\n===== CASE 2：first=0 / latest=25600 / cost=2100 =====')
  const c2 = exportRecord(
    baseRecord({ first_play: 0, second_week_play: 25600, total_cost: 2100 })
  ).row
  check('7日播放量 = 0（数字 0，不是空）', c2['7日播放量'] === 0, JSON.stringify(c2['7日播放量']))
  check('累计播放量 = 25600', Number(c2['累计播放量']) === 25600, String(c2['累计播放量']))
  check('后续新增播放量 = 25600', Number(c2['后续新增播放量']) === 25600, String(c2['后续新增播放量']))
  check('CPM 正常（2100 / 25600 × 1000 ≈ 82.03）', Number(c2['CPM']) === 82.03, String(c2['CPM']))

  console.log('\n===== CASE 3：first=10000 / latest 为空 =====')
  const c3 = exportRecord(baseRecord({ second_week_play: null })).row
  check('7日播放量 = 10000', Number(c3['7日播放量']) === 10000, String(c3['7日播放量']))
  check('累计播放量为空', c3['累计播放量'] === '', JSON.stringify(c3['累计播放量']))
  check('后续新增播放量为空', c3['后续新增播放量'] === '', JSON.stringify(c3['后续新增播放量']))
  check('CPM 为空', c3['CPM'] === '', JSON.stringify(c3['CPM']))

  console.log('\n===== CASE 4：first=10000 / latest=5000（异常数据）=====')
  const c4 = exportRecord(baseRecord({ first_play: 10000, second_week_play: 5000 })).row
  check('7日播放量 = 10000', Number(c4['7日播放量']) === 10000, String(c4['7日播放量']))
  check('累计播放量保留原始值 5000', Number(c4['累计播放量']) === 5000, String(c4['累计播放量']))
  check('后续新增播放量为空（不输出负数）', c4['后续新增播放量'] === '', JSON.stringify(c4['后续新增播放量']))
  check('CPM 为空', c4['CPM'] === '', JSON.stringify(c4['CPM']))

  console.log('\n===== CASE 5：first=0 / latest=0 =====')
  const c5 = exportRecord(baseRecord({ first_play: 0, second_week_play: 0 })).row
  check('7日播放量 真实导出 0', c5['7日播放量'] === 0, JSON.stringify(c5['7日播放量']))
  check('累计播放量 真实导出 0', c5['累计播放量'] === 0, JSON.stringify(c5['累计播放量']))
  check('后续新增播放量 = 0', Number(c5['后续新增播放量']) === 0, String(c5['后续新增播放量']))
  check('CPM 为空（latest ≤ 0）', c5['CPM'] === '', JSON.stringify(c5['CPM']))

  console.log('\n===== 导出 → 再导入（回环）=====')
  const roundtrip = exportRecord(baseRecord())
  const arrayBuffer = roundtrip.buffer.buffer.slice(
    roundtrip.buffer.byteOffset,
    roundtrip.buffer.byteOffset + roundtrip.buffer.byteLength
  )
  const imported = await parseRecordsExcel({
    name: 'export-roundtrip.xlsx',
    arrayBuffer: async () => arrayBuffer
  })
  const importedRow = imported.validRows[0] || {}
  check(
    '新导出文件可被导入器解析：有效行 1 / 失败行 0',
    imported.validRows.length === 1 && imported.failedRows.length === 0,
    `valid=${imported.validRows.length} failed=${imported.failedRows.length}`
  )
  check(
    '回环恢复：nickname / creator_type / total_cost',
    importedRow.nickname === '导出测试达人' &&
      importedRow.creator_type === '美妆种草' &&
      Number(importedRow.total_cost) === 1000,
    JSON.stringify(importedRow)
  )
  check(
    '回环恢复：first_play / second_week_play',
    importedRow.first_play === 10000 && importedRow.second_week_play === 20000,
    `first=${importedRow.first_play} latest=${importedRow.second_week_play}`
  )
  check(
    '回环恢复：content_link / video_link / publish_date',
    importedRow.content_link === 'https://www.zhihu.com/question/1/answer/2' &&
      importedRow.video_link === 'https://v.douyin.com/export-case/' &&
      importedRow.publish_date === '2026-08-20',
    JSON.stringify({
      content_link: importedRow.content_link,
      video_link: importedRow.video_link,
      publish_date: importedRow.publish_date
    })
  )
  check(
    '计算列（CPM / 后续新增播放量）被导入器忽略，不报错',
    importedRow.cpm === undefined &&
      importedRow.post7dGrowth === undefined &&
      imported.failedRows.length === 0
  )

  console.log('\n===== 达人汇总导出（V2 术语）=====')
  const creatorRows = [
    {
      nickname: '汇总达人A',
      creator_type: '美妆种草',
      total_campaigns: 2,
      total_cost: 30000,
      latest_play_total: 400000,
      avg_play: 200000,
      avg_cpm: 75,
      hit_latest_count: 1,
      hit_rate_latest: 50,
      repeat_count: 1,
      first_play_total: 150000,
      post_7d_growth_total: 250000,
      cpm_7d: 200,
      hit_7d_count: 1,
      hit_rate_7d: 50
    },
    {
      nickname: '汇总达人B',
      creator_type: '数码测评',
      total_campaigns: 1,
      total_cost: 1000,
      latest_play_total: null,
      avg_play: null,
      avg_cpm: null,
      hit_latest_count: 0,
      hit_rate_latest: null,
      repeat_count: 0,
      first_play_total: 5000,
      post_7d_growth_total: 0,
      cpm_7d: null,
      hit_7d_count: 0,
      hit_rate_7d: null
    }
  ]
  const exportedCount = exportCreatorStatsToExcel(creatorRows, {
    fileName: creatorFile,
    sheetName: '达人汇总'
  })
  const creatorWorkbook = XLSX.read(fs.readFileSync(creatorFile), { type: 'buffer' })
  const creatorSheetRows = XLSX.utils.sheet_to_json(creatorWorkbook.Sheets['达人汇总'], { defval: '' })
  const creatorHeaders = Object.keys(creatorSheetRows[0] || {})
  check(
    '达人汇总导出列名为 V2 术语',
    JSON.stringify(creatorHeaders) ===
      JSON.stringify([
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
      ]),
    creatorHeaders.join('|')
  )
  check('导出行数正确', exportedCount === 2 && creatorSheetRows.length === 2)
  const firstCreatorRow = creatorSheetRows[0]
  check(
    'A 行数值正确（累计播放量 / 平均播放量 / 平均CPM / 爆款数 / 爆款率）',
    Number(firstCreatorRow['累计播放量']) === 400000 &&
      Number(firstCreatorRow['平均播放量']) === 200000 &&
      Number(firstCreatorRow['平均CPM']) === 75 &&
      Number(firstCreatorRow['爆款数']) === 1 &&
      firstCreatorRow['爆款率'] === '50%',
    JSON.stringify(firstCreatorRow)
  )
  check(
    'A 行 7日辅助列正确（7日播放量 / 后续新增播放量 / 7日CPM / 7日爆款数 / 7日爆款率）',
    Number(firstCreatorRow['7日播放量']) === 150000 &&
      Number(firstCreatorRow['后续新增播放量']) === 250000 &&
      Number(firstCreatorRow['7日CPM']) === 200 &&
      Number(firstCreatorRow['7日爆款数']) === 1 &&
      firstCreatorRow['7日爆款率'] === '50%',
    JSON.stringify(firstCreatorRow)
  )
  const secondCreatorRow = creatorSheetRows[1]
  check(
    'B 行空值导出为空单元格（累计播放量 / 平均播放量 / 平均CPM / 爆款率）',
    secondCreatorRow['累计播放量'] === 0 &&
      secondCreatorRow['平均播放量'] === '' &&
      secondCreatorRow['平均CPM'] === '' &&
      secondCreatorRow['爆款率'] === '',
    JSON.stringify(secondCreatorRow)
  )

  fs.unlinkSync(recordFile)
  fs.unlinkSync(creatorFile)

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
