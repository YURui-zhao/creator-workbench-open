#!/usr/bin/env node
/**
 * Excel 导入：V2 表头兼容 + 播放量校验测试（Batch 4A）
 *
 * 运行方式：node tests/excel_import_headers.test.js
 * 特性：不启动服务、不打开浏览器、不写数据库；直接驱动 frontend/src/utils/excel.js 的解析函数
 *
 * 覆盖：
 *   CASE 1~3  三套表头（V2 正式 / 历史 / 过渡）解析出完全相同的数据结构
 *   CASE 4    7日播放量=0 且 累计播放量>0 → 合法
 *   CASE 5    累计播放量为空 → 合法，保持未更新（不是 0）
 *   CASE 6    累计播放量 < 7日播放量 → 非法，该行不可导入
 *   CASE 7    7日播放量为空、累计播放量有值 → 合法
 *   CASE 8    播放量为负数 → 非法
 *   CASE 9    空白播放量不得被转换为 0
 */
const path = require('node:path')
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

// 三套播放量表头（其余列沿用当前已支持的列名）
const HEADER_SETS = {
  正式表头: { first: '7日播放量', latest: '累计播放量' },
  历史表头: { first: '首发播放量', latest: '次周播放量' },
  过渡表头: { first: '7日累计播放量', latest: '最新累计播放量' }
}

function makeFileWithHeaders(headers, rows) {
  const aoa = [headers, ...rows]
  const worksheet = XLSX.utils.aoa_to_sheet(aoa)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
  // excel.js 只使用 file.name 与 file.arrayBuffer()
  return { name: 'header-case.xlsx', arrayBuffer: async () => buffer }
}

function makeExcelFile({ first, latest }, rows) {
  return makeFileWithHeaders(
    ['时间周期', '达人昵称', '博主类型', '总花费', '发布日期', first, latest],
    rows
  )
}

const baseRow = (firstPlay, latestPlay) => [
  '2026-W33',
  '测试达人',
  '美妆',
  1000,
  '2026-08-20',
  firstPlay,
  latestPlay
]

async function main() {
  const excelModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/excel.js')).href
  )
  const {
    parseRecordsExcel,
    applyTimeCycleMapping,
    findPlayRangeError,
    PLAY_RANGE_ERROR,
    HEADER_MAP
  } = excelModule

  check('解析函数可用', typeof parseRecordsExcel === 'function' && typeof findPlayRangeError === 'function')
  check('跨字段错误文案正确', PLAY_RANGE_ERROR === '累计播放量不能小于7日播放量，请检查数据是否录入正确')

  console.log('\n===== 表头 alias（纯加法，非播放量部分）=====')
  check('达人类型 → creator_type', HEADER_MAP['达人类型'] === 'creator_type')
  check('总花费(元) → total_cost', HEADER_MAP['总花费(元)'] === 'total_cost')
  check('视频链接 → video_link', HEADER_MAP['视频链接'] === 'video_link')
  check('植入链接 → content_link', HEADER_MAP['植入链接'] === 'content_link')
  check(
    '旧名称全部保留（博主类型/总花费/视频发布链接/植入内容链接）',
    HEADER_MAP['博主类型'] === 'creator_type' &&
      HEADER_MAP['总花费'] === 'total_cost' &&
      HEADER_MAP['视频发布链接'] === 'video_link' &&
      HEADER_MAP['植入内容链接'] === 'content_link'
  )
  check(
    'video_link 与 content_link 未混为同一字段',
    HEADER_MAP['视频链接'] !== HEADER_MAP['植入链接']
  )

  console.log('\n===== CASE 1~3：三套表头解析结果必须完全一致 =====')
  const parsed = {}
  for (const [label, headers] of Object.entries(HEADER_SETS)) {
    const file = makeExcelFile(headers, [baseRow(10000, 20000)])
    const result = await parseRecordsExcel(file)
    parsed[label] = result
    const row = result.validRows[0]
    check(
      `${label}（${headers.first} / ${headers.latest}）→ first_play=10000, second_week_play=20000`,
      result.validRows.length === 1 &&
        row?.first_play === 10000 &&
        row?.second_week_play === 20000 &&
        result.failedRows.length === 0,
      JSON.stringify(row)
    )
  }
  check(
    '三套表头得到的数据结构完全相同',
    JSON.stringify(parsed['正式表头'].validRows[0]) === JSON.stringify(parsed['历史表头'].validRows[0]) &&
      JSON.stringify(parsed['正式表头'].validRows[0]) === JSON.stringify(parsed['过渡表头'].validRows[0]),
    JSON.stringify(parsed['正式表头'].validRows[0])
  )
  check(
    '三套表头都被识别为同一组数据库字段',
    ['正式表头', '历史表头', '过渡表头'].every((key) =>
      ['first_play', 'second_week_play'].every((field) => parsed[key].mappedFields.includes(field))
    )
  )

  const official = HEADER_SETS['正式表头']
  const parseRow = async (firstPlay, latestPlay) => {
    const file = makeExcelFile(official, [baseRow(firstPlay, latestPlay)])
    return parseRecordsExcel(file)
  }

  console.log('\n===== CASE 4：7日播放量=0、累计播放量=25600（合法）=====')
  const c4 = await parseRow(0, 25600)
  check(
    '合法且 0 是真实观察值',
    c4.validRows.length === 1 && c4.validRows[0].first_play === 0 && c4.validRows[0].second_week_play === 25600,
    JSON.stringify(c4.validRows[0])
  )

  console.log('\n===== CASE 5：累计播放量为空（合法，保持未更新）=====')
  const c5 = await parseRow(10000, '')
  check(
    '合法，second_week_play 保持未更新（不是 0）',
    c5.validRows.length === 1 &&
      c5.validRows[0].first_play === 10000 &&
      c5.validRows[0].second_week_play === undefined,
    JSON.stringify(c5.validRows[0])
  )

  console.log('\n===== CASE 6：累计播放量 < 7日播放量（非法，阻止导入）=====')
  const c6 = await parseRow(10000, 5000)
  check(
    '该行进入失败列表且原因为跨字段校验',
    c6.validRows.length === 0 &&
      c6.failedRows.length === 1 &&
      c6.failedRows[0].reason.includes(PLAY_RANGE_ERROR),
    JSON.stringify(c6.failedRows[0])
  )
  check(
    '错误定位到 second_week_play 字段',
    c6.failedRows[0]?.cellErrors?.some((item) => item.field === 'second_week_play')
  )
  const remapped = applyTimeCycleMapping(c6, {})
  check(
    '应用时间周期映射后仍然判为失败（不会静默入库）',
    remapped.validRows.length === 0 && remapped.failedRows.length === 1
  )

  console.log('\n===== CASE 7：7日播放量为空、累计播放量=5000（合法）=====')
  const c7 = await parseRow('', 5000)
  check(
    '合法，first_play 保持未填写',
    c7.validRows.length === 1 &&
      c7.validRows[0].first_play === undefined &&
      c7.validRows[0].second_week_play === 5000,
    JSON.stringify(c7.validRows[0])
  )

  console.log('\n===== CASE 8：播放量为负数（非法）=====')
  const c8a = await parseRow(-100, 200)
  check(
    '7日播放量为负数 → 非法',
    c8a.validRows.length === 0 &&
      c8a.failedRows[0]?.reason.includes('7日播放量必须为非负整数'),
    JSON.stringify(c8a.failedRows[0])
  )
  const c8b = await parseRow(100, -5)
  check(
    '累计播放量为负数 → 非法',
    c8b.validRows.length === 0 &&
      c8b.failedRows[0]?.reason.includes('累计播放量必须为非负整数'),
    JSON.stringify(c8b.failedRows[0])
  )

  console.log('\n===== CASE 9：空白播放量不得被转换为 0 =====')
  const c9 = await parseRow('', '')
  check(
    '两列都为空 → 均为未填写（undefined），不是 0',
    c9.validRows.length === 1 &&
      c9.validRows[0].first_play === undefined &&
      c9.validRows[0].second_week_play === undefined,
    JSON.stringify(c9.validRows[0])
  )
  const c9b = await parseRow('暂无', '空')
  check(
    '占位写法（暂无 / 空）也按未填写处理',
    c9b.validRows.length === 1 &&
      c9b.validRows[0].first_play === undefined &&
      c9b.validRows[0].second_week_play === undefined,
    JSON.stringify(c9b.validRows[0])
  )
  const c9c = await parseRow('abc', 100)
  check(
    '非法字符串给出明确错误（不静默置空）',
    c9c.validRows.length === 0 && c9c.failedRows[0]?.reason.includes('7日播放量必须为非负整数'),
    JSON.stringify(c9c.failedRows[0])
  )

  console.log('\n===== 补充：数字写法兼容 =====')
  const c10 = await parseRow('1.2万', 20000)
  check(
    '1.2万 → 12000（沿用既有 x.x万 解析，不报错）',
    c10.validRows.length === 1 && c10.validRows[0].first_play === 12000,
    JSON.stringify(c10.validRows[0])
  )

  console.log('\n===== 正式整行表头（V2 官方字段名）=====')
  const officialHeaders = [
    '时间周期',
    '达人昵称',
    '达人类型',
    '总花费(元)',
    '7日播放量',
    '累计播放量',
    '发布日期',
    '视频链接'
  ]
  const officialFile = makeFileWithHeaders(officialHeaders, [
    [
      '2026-W33',
      '正式表头达人',
      '美妆种草',
      1234.5,
      10000,
      20000,
      '2026-08-20',
      'https://v.douyin.com/official-case/'
    ]
  ])
  const officialResult = await parseRecordsExcel(officialFile)
  check(
    '正式表头整行：有效行 = 1、失败行 = 0、missingFields 为空',
    officialResult.validRows.length === 1 &&
      officialResult.failedRows.length === 0 &&
      officialResult.missingFields.length === 0,
    `valid=${officialResult.validRows.length} failed=${officialResult.failedRows.length} missing=${JSON.stringify(
      officialResult.missingFields
    )}`
  )
  const officialRow = officialResult.validRows[0] || {}
  check('达人类型 → creator_type 正确保留', officialRow.creator_type === '美妆种草', officialRow.creator_type)
  check('总花费(元) → total_cost 正确解析', officialRow.total_cost === 1234.5, String(officialRow.total_cost))
  check(
    'video_link 正确保留（未被当作 content_link）',
    officialRow.video_link === 'https://v.douyin.com/official-case/' &&
      officialRow.content_link === undefined,
    `video_link=${officialRow.video_link} content_link=${officialRow.content_link}`
  )
  check(
    '播放量字段正确解析（first_play=10000 / second_week_play=20000）',
    officialRow.first_play === 10000 && officialRow.second_week_play === 20000
  )
  check(
    '正式表头不再出现 missingFields=[total_cost]',
    !officialResult.missingFields.includes('total_cost')
  )

  console.log('\n===== 当前导出表头（EXPORT_COLUMNS / 后端 EXPORT_HEADERS）可被重新导入 =====')
  const exportHeaders = [
    '时间周期',
    '达人昵称',
    '博主类型',
    '达人主页',
    '植入链接',
    '视频链接',
    '总花费(元)',
    'CPM数据',
    '首发播放量',
    '次周播放量',
    '发布日期'
  ]
  const exportFile = makeFileWithHeaders(exportHeaders, [
    [
      '2026-W33',
      '导出回导致人',
      '数码测评',
      'https://www.douyin.com/user/export-case',
      'https://www.zhihu.com/question/1/answer/2',
      'https://v.douyin.com/export-case/',
      5678,
      '99.99',
      30000,
      80000,
      '2026-08-21'
    ]
  ])
  const exportResult = await parseRecordsExcel(exportFile)
  const exportRow = exportResult.validRows[0] || {}
  check(
    '导出表头整行：有效行 = 1、失败行 = 0（总花费(元) / 植入链接 已被识别）',
    exportResult.validRows.length === 1 &&
      exportResult.failedRows.length === 0 &&
      !exportResult.missingFields.includes('total_cost'),
    `valid=${exportResult.validRows.length} failed=${exportResult.failedRows.length} missing=${JSON.stringify(
      exportResult.missingFields
    )}`
  )
  check('总花费(元) → total_cost', exportRow.total_cost === 5678, String(exportRow.total_cost))
  check(
    '植入链接 → content_link（与 video_link 分开）',
    exportRow.content_link === 'https://www.zhihu.com/question/1/answer/2' &&
      exportRow.video_link === 'https://v.douyin.com/export-case/',
    `content_link=${exportRow.content_link} video_link=${exportRow.video_link}`
  )
  check(
    '导出的历史播放量列名（首发播放量 / 次周播放量）仍映射到 first_play / second_week_play',
    exportRow.first_play === 30000 && exportRow.second_week_play === 80000
  )
  check(
    'CPM数据 列不会被当作导入字段（系统自行计算，不参与导入）',
    exportResult.mappedFields.includes('cpm') === false
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
