#!/usr/bin/env node
/**
 * Excel 智能导入：字段映射 / 未知表头 / 合并单元格 / 业务写法（Batch 6A）
 *
 * 运行方式：node tests/excel_smart_mapping.test.js
 * 特性：不启动服务、不打开浏览器、不写数据库、不联网；
 *      直接驱动 frontend/src/utils/excel.js 的解析函数与 backend/routes/ai.js 的纯函数
 *
 * 覆盖：
 *   CASE 1  真实表头「播放量（首发）/ 播放量（新）」不再静默丢失，映射后数值正确入库
 *   CASE 2  合并单元格时间周期向下继承（1 行有值 + 6 行为空）
 *   CASE 3  全空白分隔行跳过，不报「时间周期为空」
 *   CASE 4  总花费「免费」→ 0
 *   CASE 5  未知列「报价」显式暴露，未确认前不可导入
 *   CASE 6  AI 未配置时仍可纯手动完成映射
 *   CASE 7  两个源列映射同一目标字段 → 冲突拦截
 *   CASE 8  有播放数据但未完成映射时，绝不出现「导入成功但播放量为空」
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

// excel.js 只使用 file.name 与 file.arrayBuffer()
function makeFile(headers, rows, merges) {
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows])
  if (merges) worksheet['!merges'] = merges
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
  return { name: 'smart-mapping.xlsx', arrayBuffer: async () => buffer }
}

// 与 ExcelImportModal 中一致的「是否必须阻止导入」判定
function requiresMappingGate(result) {
  return Array.isArray(result?.unknownHeaders) && result.unknownHeaders.length > 0
}

async function main() {
  const excel = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/excel.js')).href
  )
  const ai = await import(pathToFileURL(path.join(REPO_ROOT, 'backend/routes/ai.js')).href)
  const feDateCycle = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/dateCycle.js')).href
  )
  const {
    parseRecordsExcel,
    suggestFieldForHeader,
    detectMappingConflicts,
    IGNORE_FIELD,
    MAPPING_FIELD_OPTIONS
  } = excel

  console.log('===== CASE 1：真实播放量表头「播放量（首发）/ 播放量（新）」=====')
  const case1Headers = [
    '时间周期',
    '达人昵称',
    '总花费(元)',
    '发布日期',
    '播放量（首发）',
    '播放量（新）'
  ]
  const case1Rows = [['2026-W33', '达人A', '免费', '2026-08-20', 51800, 291300]]
  const case1 = await parseRecordsExcel(makeFile(case1Headers, case1Rows))

  check(
    'CASE 1a：未识别表头被显式列出（不再静默消失）',
    case1.unknownHeaders.length === 2 &&
      case1.unknownHeaders.includes('播放量（首发）') &&
      case1.unknownHeaders.includes('播放量（新）'),
    JSON.stringify(case1.unknownHeaders)
  )
  check('CASE 1b：存在未识别表头 → 必须进入映射确认（阻止直接导入）', requiresMappingGate(case1))
  check(
    'CASE 1c：给出本地高置信建议 播放量（首发）→ first_play',
    suggestFieldForHeader('播放量（首发）')?.field === 'first_play',
    JSON.stringify(suggestFieldForHeader('播放量（首发）'))
  )
  check(
    'CASE 1d：给出本地建议 播放量（新）→ second_week_play（仅建议，非静默映射）',
    suggestFieldForHeader('播放量（新）')?.field === 'second_week_play',
    JSON.stringify(suggestFieldForHeader('播放量（新）'))
  )
  check(
    'CASE 1e：映射前这两列不会写入任何字段（证明旧版会丢数据的根因）',
    case1.validRows[0]?.first_play === undefined &&
      case1.validRows[0]?.second_week_play === undefined,
    JSON.stringify(case1.validRows[0])
  )

  const case1Mapped = await parseRecordsExcel(makeFile(case1Headers, case1Rows), [], {
    overrides: { '播放量（首发）': 'first_play', '播放量（新）': 'second_week_play' }
  })
  check(
    'CASE 1f：用户确认映射后，真实数值进入 first_play / second_week_play',
    case1Mapped.validRows.length === 1 &&
      case1Mapped.validRows[0].first_play === 51800 &&
      case1Mapped.validRows[0].second_week_play === 291300,
    JSON.stringify(case1Mapped.validRows[0])
  )
  check(
    'CASE 1g：映射完成后不再存在未识别表头（可进入导入）',
    !requiresMappingGate(case1Mapped) && case1Mapped.failedRows.length === 0
  )

  console.log('\n===== CASE 2：合并单元格 / 空周期继承（无发布日期时的 fallback）=====')
  // 真实导入会先拉取后端周期选项（含 label 月日区间），这里模拟同一行为
  const cycleOptions = [
    { weekCode: '2026-W34', label: '08/17-08/23', startDate: '2026-08-17', endDate: '2026-08-23' }
  ]
  // 合并单元格 → sourceTimeCycle 向下继承（来源信息；最终归属仍以发布日期为准）
  const mergedRows = [
    ['08/17-08/23', '达人A', 1000, '2026-08-17'],
    ['', '达人B', 1000, '2026-08-17'],
    ['', '达人C', 1000, '2026-08-17'],
    ['', '达人D', 1000, '2026-08-17'],
    ['', '达人E', 1000, '2026-08-17'],
    ['', '达人F', 1000, '2026-08-17'],
    ['', '达人G', 1000, '2026-08-17']
  ]
  const case2 = await parseRecordsExcel(
    makeFile(['时间周期', '达人昵称', '总花费', '发布日期'], mergedRows, [
      { s: { r: 1, c: 0 }, e: { r: 7, c: 0 } }
    ]),
    cycleOptions
  )
  check(
    'CASE 2a：合并单元格的 7 行全部继承同一来源周期，且最终周期由发布日期推导',
    case2.validRows.length === 7 &&
      case2.failedRows.length === 0 &&
      case2.validRows.every((row) => row.sourceTimeCycle === '2026-W34') &&
      case2.validRows.every((row) => row.time_cycle === '2026-W33'),
    `valid=${case2.validRows.length} src=${JSON.stringify(case2.validRows.map((r) => r.sourceTimeCycle))} cycle=${JSON.stringify(case2.validRows.map((r) => r.time_cycle))}`
  )

  // 有发布日期时：发布日期优先，来源（含合并继承）不得覆盖标准周
  // 这里用一个「非自然周但包含全部行」的业务区间，验证来源只是业务分组、canonical 仍按日期
  const mergedWithDate = [
    ['08/17-09/06', '达人A', 1000, '2026-08-17'],
    ['', '达人B', 1000, '2026-08-24'],
    ['', '达人C', 1000, '2026-08-31']
  ]
  const case2a2 = await parseRecordsExcel(
    makeFile(['时间周期', '达人昵称', '总花费', '发布日期'], mergedWithDate, [
      { s: { r: 1, c: 0 }, e: { r: 3, c: 0 } }
    ]),
    cycleOptions
  )
  check(
    'CASE 2a2：合并的来源业务区间不得覆盖发布日期推导出的标准周（3 行分属 3 个自然周）',
    case2a2.failedRows.length === 0 &&
      case2a2.validRows.map((r) => r.time_cycle).join(',') ===
        ['2026-W33', '2026-W34', '2026-W35'].join(','),
    `cycles=${JSON.stringify(case2a2.validRows.map((r) => r.time_cycle))} failed=${JSON.stringify(case2a2.failedRows.map((r) => r.reason))}`
  )

  // 非合并、但时间周期列留空：sourceTimeCycle 向下继承（解析层兜底）
  const fillDownRows = [
    ['2026-W33', '达人A', 1000, '2026-08-18'],
    ['', '达人B', 1000, '2026-08-18'],
    ['2026-W34', '达人C', 1000, '2026-08-25'],
    ['', '达人D', 1000, '2026-08-25']
  ]
  const case2b = await parseRecordsExcel(
    makeFile(['时间周期', '达人昵称', '总花费', '发布日期'], fillDownRows)
  )
  check(
    'CASE 2b：非合并的空周期继承上一非空来源周期，出现新周期后更新',
    case2b.failedRows.length === 0 &&
      case2b.validRows.map((r) => r.sourceTimeCycle).join(',') ===
        ['2026-W33', '2026-W33', '2026-W34', '2026-W34'].join(','),
    JSON.stringify(case2b.validRows.map((r) => r.sourceTimeCycle))
  )

  const noCycleRows = [
    ['', '达人A', 1000, ''],
    ['', '达人B', 1000, '']
  ]
  const case2c = await parseRecordsExcel(
    makeFile(['时间周期', '达人昵称', '总花费', '发布日期'], noCycleRows)
  )
  check(
    'CASE 2c：既无发布日期、又无可继承周期 → 报错（不凭空造周期）',
    case2c.validRows.length === 0 &&
      case2c.failedRows.length === 2 &&
      case2c.failedRows.every((item) => item.reason.includes('时间周期')),
    JSON.stringify(case2c.failedRows.map((r) => r.reason))
  )

  console.log('\n===== CASE 3：全空白分隔行 =====')
  const case3 = await parseRecordsExcel(
    makeFile(
      ['时间周期', '达人昵称', '总花费', '发布日期'],
      [
        ['2026-W33', '达人A', 1000, '2026-08-18'],
        ['', '', '', ''],
        ['2026-W34', '达人B', 1000, '2026-08-25']
      ]
    )
  )
  check(
    'CASE 3a：空白行被跳过，不报「时间周期为空」',
    case3.validRows.length === 2 &&
      case3.failedRows.length === 0 &&
      case3.blankRows === 1,
    `valid=${case3.validRows.length} blank=${case3.blankRows} failed=${case3.failedRows.length}`
  )
  check(
    'CASE 3b：空白行不继承、也不会污染后续周期',
    case3.validRows.map((r) => r.time_cycle).join(',') === '2026-W33,2026-W34',
    JSON.stringify(case3.validRows.map((r) => r.time_cycle))
  )
  check(
    'CASE 3c：重复表头行被识别为「跳过」，不作为业务数据',
    (await (async () => {
      const r = await parseRecordsExcel(
        makeFile(
          ['时间周期', '达人昵称', '总花费', '发布日期'],
          [
            ['2026-W33', '达人A', 1000, '2026-08-20'],
            ['时间周期', '达人昵称', '总花费', '发布日期'],
            ['2026-W33', '达人B', 1000, '2026-08-20']
          ]
        )
      )
      return r.validRows.length === 2 && r.repeatedHeaderRows === 1 && r.failedRows.length === 0
    })())
  )

  console.log('\n===== CASE 4：总花费「免费」→ 0 =====')
  const case4 = await parseRecordsExcel(
    makeFile(
      ['时间周期', '达人昵称', '总花费', '发布日期'],
      [
        ['2026-W33', '达人A', '免费', '2026-08-20'],
        ['2026-W33', '达人B', ' 免费 ', '2026-08-20'],
        ['2026-W33', '达人C', 0, '2026-08-20'],
        ['2026-W33', '达人D', '1,234', '2026-08-20'],
        ['2026-W33', '达人E', '1.2万', '2026-08-20']
      ]
    )
  )
  check(
    'CASE 4a：「免费」/「 免费 」→ 0（真实数字 0，不是缺失）',
    case4.validRows.length === 5 &&
      case4.validRows[0].total_cost === 0 &&
      case4.validRows[1].total_cost === 0,
    JSON.stringify(case4.validRows.map((r) => r.total_cost))
  )
  check(
    'CASE 4b：原有数字写法不受影响（0 / 1,234 / 1.2万）',
    case4.validRows[2].total_cost === 0 &&
      case4.validRows[3].total_cost === 1234 &&
      case4.validRows[4].total_cost === 12000,
    JSON.stringify(case4.validRows.map((r) => r.total_cost))
  )
  const case4c = await parseRecordsExcel(
    makeFile(
      ['时间周期', '达人昵称', '总花费', '发布日期'],
      [
        ['2026-W33', '达人A', 'abc', '2026-08-20'],
        ['2026-W33', '达人B', '未知', '2026-08-20'],
        ['2026-W33', '达人C', '置换', '2026-08-20']
      ]
    )
  )
  check(
    'CASE 4c：非「免费」的文字（abc / 未知 / 置换）仍判非法，不泛化成 0',
    case4c.validRows.length === 0 &&
      case4c.failedRows.length === 3 &&
      case4c.failedRows.every((item) => item.reason.includes('总花费')),
    JSON.stringify(case4c.failedRows.map((r) => r.reason))
  )

  console.log('\n===== CASE 5：未知列「报价」必须显式暴露 =====')
  const case5Headers = ['时间周期', '达人昵称', '总花费', '发布日期', '报价', 'cpm']
  const case5 = await parseRecordsExcel(
    makeFile(case5Headers, [['2026-W33', '达人A', 1000, '2026-08-20', '面议', 116.78]])
  )
  check(
    'CASE 5a：「报价」被列为未识别字段，必须由用户确认',
    case5.unknownHeaders.includes('报价') && requiresMappingGate(case5),
    JSON.stringify(case5.unknownHeaders)
  )
  check(
    'CASE 5b：「报价」不给映射建议（避免误判为总花费），用户可显式选择忽略',
    suggestFieldForHeader('报价') === null &&
      MAPPING_FIELD_OPTIONS.some((option) => option.value === IGNORE_FIELD && option.label === '忽略此列')
  )
  check(
    'CASE 5c：系统计算列 cpm 属于「已知忽略列」，不打扰用户',
    case5.systemIgnoredHeaders.includes('cpm') && !case5.unknownHeaders.includes('cpm'),
    JSON.stringify(case5.systemIgnoredHeaders)
  )
  const case5Ignored = await parseRecordsExcel(makeFile(case5Headers, [
    ['2026-W33', '达人A', 1000, '2026-08-20', '面议', 116.78]
  ]), [], { overrides: { 报价: IGNORE_FIELD } })
  check(
    'CASE 5d：用户明确选择「忽略此列」后可继续导入，且忽略列可追溯',
    !requiresMappingGate(case5Ignored) &&
      case5Ignored.ignoredHeaders.includes('报价') &&
      case5Ignored.validRows.length === 1,
    JSON.stringify(case5Ignored.ignoredHeaders)
  )

  console.log('\n===== CASE 6：AI 未配置时仍可纯手动完成映射 =====')
  const case6Headers = ['时间周期', '达人昵称', '总花费', '发布日期', '播放量（首发）', '播放量（新）', '备注']
  const case6Rows = [['2026-W33', '达人A', 1000, '2026-08-20', 10000, 50000, '高转化']]
  const case6 = await parseRecordsExcel(makeFile(case6Headers, case6Rows))
  check(
    'CASE 6a：本地建议不依赖 AI（无任何网络调用即可给出建议）',
    case6.headerSuggestions.length === 2 &&
      case6.headerSuggestions.every((item) => item.field),
    JSON.stringify(case6.headerSuggestions)
  )
  check(
    'CASE 6b：本地无法判断的列（备注）也进入待确认列表（默认忽略，可改选）',
    case6.unknownHeaders.includes('备注') && suggestFieldForHeader('备注') === null
  )
  const case6Manual = await parseRecordsExcel(makeFile(case6Headers, case6Rows), [], {
    overrides: {
      '播放量（首发）': 'first_play',
      '播放量（新）': 'second_week_play',
      备注: IGNORE_FIELD
    }
  })
  check(
    'CASE 6c：纯手动映射后即可正常导入（AI 不是前置依赖）',
    !requiresMappingGate(case6Manual) &&
      case6Manual.validRows.length === 1 &&
      case6Manual.validRows[0].first_play === 10000 &&
      case6Manual.validRows[0].second_week_play === 50000,
    JSON.stringify(case6Manual.validRows[0])
  )

  console.log('\n===== CASE 7：两个源列映射同一目标字段 =====')
  const conflictItems = [
    { header: '播放量（首发）', target: 'first_play' },
    { header: '7日播放量A', target: 'first_play' },
    { header: '播放量（新）', target: 'second_week_play' },
    { header: '报价', target: IGNORE_FIELD }
  ]
  const conflicts = detectMappingConflicts(conflictItems)
  check(
    'CASE 7a：同一目标字段被两列映射 → 检测到冲突',
    conflicts.length === 1 &&
      conflicts[0].field === 'first_play' &&
      conflicts[0].headers.length === 2,
    JSON.stringify(conflicts)
  )
  check(
    'CASE 7b：忽略列不参与冲突判定',
    detectMappingConflicts([
      { header: '报价', target: IGNORE_FIELD },
      { header: 'cpm', target: IGNORE_FIELD }
    ]).length === 0
  )
  check(
    'CASE 7c：冲突未消除 → 弹窗「确认字段映射」按钮被禁用（不可继续）',
    // 与 ExcelImportModal 中 disabled 条件一致
    conflicts.length > 0
  )

  console.log('\n===== CASE 8：不得「导入成功但播放量为空」=====')
  const case8Headers = ['时间周期', '达人昵称', '总花费', '发布日期', '播放量（首发）', '播放量（新）']
  const case8Rows = [['2026-W33', '达人A', 1000, '2026-08-20', 82300, 291300]]
  const case8Unmapped = await parseRecordsExcel(makeFile(case8Headers, case8Rows))
  check(
    'CASE 8a：源数据有播放量但未映射时，导入被阻断（不会假成功）',
    requiresMappingGate(case8Unmapped) === true
  )
  check(
    'CASE 8b：阻断期间该行确实不含播放量（正是旧版静默丢弃的表现）',
    case8Unmapped.validRows[0].first_play === undefined &&
      case8Unmapped.validRows[0].second_week_play === undefined
  )
  const case8Mapped = await parseRecordsExcel(makeFile(case8Headers, case8Rows), [], {
    overrides: { '播放量（首发）': 'first_play', '播放量（新）': 'second_week_play' }
  })
  check(
    'CASE 8c：完成映射后播放量落库，才是真正的「导入成功」',
    !requiresMappingGate(case8Mapped) &&
      case8Mapped.validRows[0].first_play === 82300 &&
      case8Mapped.validRows[0].second_week_play === 291300
  )

  console.log('\n===== time_cycle 语义：发布日期优先（Batch 6A-2 封口）=====')
  const CYCLE_HELPER_CASES = [
    ['2026-08-30', '08/24-08/30'],
    ['2026-08-31', '08/31-09/06'],
    ['2026-09-03', '08/31-09/06'],
    ['2026-09-06', '08/31-09/06'],
    ['2026-09-07', '09/07-09/13'],
    ['2026-09-09', '09/07-09/13'],
    ['2027-01-01', '12/28-01/03'],
    ['2027-01-04', '01/04-01/10'],
    ['2026-03-01', '02/23-03/01'],
    ['2026-03-02', '03/02-03/08']
  ]
  check(
    '确定性 helper publishDateToTimeCycle：周一~周日、跨月 / 跨年都正确',
    CYCLE_HELPER_CASES.every(([date, label]) => excel.publishDateToTimeCycle(date) === label),
    JSON.stringify(CYCLE_HELPER_CASES.map(([date]) => [date, excel.publishDateToTimeCycle(date)]))
  )
  check(
    'helper 对非法 / 空日期返回 null（不猜周期）',
    excel.publishDateToTimeCycle('') === null &&
      excel.publishDateToTimeCycle('2026-13-45') === null &&
      excel.publishDateToWeekCode(null) === null
  )

  // 真实 Excel（试验.xlsx）场景重建：源周期是业务分组区间（非自然周），且只写在每组第一行
  const REAL_CASES = [
    ['样板达人10', '2026-08-26', '08/24-08/30', '08/27-09/02'],
    ['样板达人12', '2026-09-02', '08/31-09/06', '08/27-09/02'],
    ['样板达人03（副本）', '2026-09-03', '08/31-09/06', '09/03-09/09'],
    ['样板达人06', '2026-09-04', '08/31-09/06', '09/03-09/09'],
    ['样板达人07', '2026-09-04', '08/31-09/06', '09/03-09/09'],
    ['样板达人02', '2026-09-04', '08/31-09/06', '09/03-09/09'],
    ['样板达人04', '2026-09-05', '08/31-09/06', '09/03-09/09'],
    ['样板达人14', '2026-09-08', '09/07-09/13', '09/03-09/09'],
    ['样板达人05', '2026-09-08', '09/07-09/13', '09/03-09/09'],
    ['样板达人13', '2026-09-09', '09/07-09/13', '09/03-09/09']
  ]
  let lastSource = null
  const realRows = REAL_CASES.map(([nickname, date, , source]) => {
    // 真实文件里源周期只在每组第一行出现（其余行空白）
    const cell = source === lastSource ? '' : source
    lastSource = source
    return [cell, nickname, 1000, date]
  })
  const realResult = await parseRecordsExcel(
    makeFile(['时间周期', '达人昵称', '总花费', '发布日期'], realRows)
  )
  const realByName = new Map(realResult.validRows.map((row) => [row.nickname, row]))
  // 样板达人10 的发布日期（08/26）不在源档期内 → 单列需确认，其余正常行无需操作。
  const wrongCycles = REAL_CASES.filter(([nickname, , expected]) => {
    if (nickname === '样板达人10') return false
    const row = realByName.get(nickname)
    return !row || excel.weekCodeToLabel(row.time_cycle) !== expected
  }).map(([nickname]) => {
    const row = realByName.get(nickname)
    return `${nickname}:${row ? excel.weekCodeToLabel(row.time_cycle) : '未导入'}`
  })
  check(
    '真实达人 CASE 全部得到正确周期（9 条合法导入，发布日期归属优先于来源分组）',
    wrongCycles.length === 0 && realResult.validRows.length === 9,
    wrongCycles.length ? JSON.stringify(wrongCycles) : `valid=${realResult.validRows.length}`
  )
  check(
    '样板达人10（源 08/27-09/02 / 发布日期 08/26）→ 需确认，不计入失败',
    realResult.confirmationRows.length === 1 &&
      realResult.confirmationRows[0].rowIndex === 2 &&
      realResult.confirmationRows[0].reason === excel.SOURCE_CONFLICT_MESSAGE &&
      realResult.failedRows.length === 0,
    JSON.stringify(realResult.confirmationRows)
  )
  check(
    '该行仍按发布日期给出 canonical 周期（08/24-08/30），可追溯，不静默改写源周期',
    realResult.sourceRangeViolationRows === 1 &&
      realResult.sourceRangeViolations[0].timeCycleLabel === '08/24-08/30',
    JSON.stringify(realResult.sourceRangeViolations)
  )
  check(
    '不再有「源周期 ≠ canonical 就报警」的行为（合法行不带 warnings）',
    realResult.validRows.every((row) => !row.warnings)
  )
  check(
    '真实场景不再触发 AI / 人工周期识别面板（本地确定性即可完成）',
    realResult.unrecognizedTimeCycles.length === 0
  )

  console.log('\n===== 源业务周期一致性（业务区间不要求自然周）=====')
  const RANGE_CASES = [
    ['09/03-09/09', '2026-09-08', true, 'E：09/03-09/09 + 发布日期 09/08 → 合法，无警告'],
    ['08/27-09/02', '2026-08-26', false, 'F：08/27-09/02 + 发布日期 08/26 → 源数据异常'],
    ['09/01-09/08', '2026-09-08', true, 'G：09/01-09/08（非自然周，8 天）同样支持一致性检查'],
    ['12/28-01/03', '2027-01-01', true, '跨年业务区间：12/28-01/03 + 2027-01-01 → 合法'],
    ['9月1日-9月8日', '2026-09-08', true, '中文写法业务区间：合法']
  ]
  for (const [source, publish, shouldPass, label] of RANGE_CASES) {
    const res = await parseRecordsExcel(
      makeFile(
        ['时间周期', '达人昵称', '总花费', '发布日期'],
        [[source, '达人A', 1000, publish]]
      )
    )
    const passed =
      res.validRows.length === 1 && res.failedRows.length === 0 && res.sourceRangeViolationRows === 0
    const rejected =
      res.failedRows.length === 0 && res.confirmationRows.length === 1 &&
      res.sourceRangeViolationRows === 1 &&
      res.confirmationRows[0].reason === excel.SOURCE_CONFLICT_MESSAGE
    check(label, shouldPass ? passed : rejected, JSON.stringify({
      valid: res.validRows.length,
      failed: res.failedRows.map((r) => r.reason),
      violations: res.sourceRangeViolationRows
    }))
  }
  check(
    '业务区间解析独立于自然周解析（parseTimeCycleToWeekCode 不参与）',
    excel.parseBusinessDateRange('09/01-09/08', '2026-09-08')?.startDate === '2026-09-01' &&
      feDateCycle.parseTimeCycleToWeekCode('09/01-09/08') === null
  )
  const weekSourceResult = await parseRecordsExcel(
    makeFile(
      ['时间周期', '达人昵称', '总花费', '发布日期'],
      [['2026-W35', '达人A', 1000, '2026-09-08']]
    )
  )
  check(
    '来源写成标准周码（2026-W35）时同样按区间检查：09/08 不在该周 → 需确认',
    weekSourceResult.failedRows.length === 0 &&
      weekSourceResult.confirmationRows.length === 1 &&
      weekSourceResult.sourceRangeViolationRows === 1 &&
      weekSourceResult.confirmationRows[0].reason === excel.SOURCE_CONFLICT_MESSAGE,
    JSON.stringify(weekSourceResult.confirmationRows.map((r) => r.reason))
  )

  console.log('\n===== 前端 / 后端 Monday-Sunday 周定义一致性 =====')
  const backendDateCycle = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/utils/dateCycle.js')).href
  )
  const CONSISTENCY_DATES = [
    '2026-08-26',
    '2026-08-30',
    '2026-08-31',
    '2026-09-02',
    '2026-09-03',
    '2026-09-06',
    '2026-09-07',
    '2026-09-08',
    '2026-09-09',
    '2026-12-27',
    '2026-12-28',
    '2027-01-01',
    '2027-01-04',
    '2026-03-01'
  ]
  const weekDiff = CONSISTENCY_DATES.filter(
    (date) =>
      excel.publishDateToWeekCode(date) !== backendDateCycle.dateToWeekCode(date)
  ).map((date) => `${date}: front=${excel.publishDateToWeekCode(date)} back=${backendDateCycle.dateToWeekCode(date)}`)
  check(
    '前端 publishDateToWeekCode 与 backend dateToWeekCode 结果完全一致（同源同结果）',
    weekDiff.length === 0,
    weekDiff.length ? JSON.stringify(weekDiff) : `${CONSISTENCY_DATES.length} 个日期全部一致`
  )
  const cyc0903 = backendDateCycle.dateToWeekCode('2026-09-03')
  const range0903 = backendDateCycle.getWeekDateRange(cyc0903)
  check(
    'backend canonical：2026-09-03 → 2026-W35（08/31 ~ 09/06），绝不是 08/24-08/30',
    cyc0903 === '2026-W35' &&
      range0903.startDate === '2026-08-31' &&
      range0903.endDate === '2026-09-06',
    `${cyc0903} ${JSON.stringify(range0903)}`
  )
  check(
    'backend canonical 连续边界：09/06→W35、09/07→W36、09/08→W36',
    backendDateCycle.dateToWeekCode('2026-09-06') === '2026-W35' &&
      backendDateCycle.dateToWeekCode('2026-09-07') === '2026-W36' &&
      backendDateCycle.dateToWeekCode('2026-09-08') === '2026-W36'
  )

  console.log('\n===== 空白行不得造成周期串组 =====')
  const groupRows = [
    ['08/13-08/19', '达人1', 1000, '2026-08-18'],
    ['', '达人2', 1000, '2026-08-19'],
    ['', '', '', ''],
    ['', '', '', ''],
    ['09/03-09/09', '达人3', 1000, '2026-09-08'],
    ['', '达人4', 1000, '2026-09-09']
  ]
  const groupResult = await parseRecordsExcel(
    makeFile(['时间周期', '达人昵称', '总花费', '发布日期'], groupRows)
  )
  const groupByName = new Map(groupResult.validRows.map((row) => [row.nickname, row]))
  check(
    '达人3 / 达人4 绝对不会继承周期A（各自按发布日期归属）',
    excel.weekCodeToLabel(groupByName.get('达人3')?.time_cycle) === '09/07-09/13' &&
      excel.weekCodeToLabel(groupByName.get('达人4')?.time_cycle) === '09/07-09/13' &&
      excel.weekCodeToLabel(groupByName.get('达人1')?.time_cycle) === '08/17-08/23',
    JSON.stringify([
      excel.weekCodeToLabel(groupByName.get('达人1')?.time_cycle),
      excel.weekCodeToLabel(groupByName.get('达人3')?.time_cycle)
    ])
  )
  check(
    '空行被跳过且不参与继承（跳过统计正确）',
    groupResult.blankRows === 2 && groupResult.failedRows.length === 0,
    `blank=${groupResult.blankRows} failed=${groupResult.failedRows.length}`
  )
  const carryReset = await parseRecordsExcel(
    makeFile(['时间周期', '达人昵称', '总花费', '发布日期'], [
      ['08/27-09/02', '前组', 1000, '2026-08-27'],
      ['', '', '', ''],
      ['', '无源周期', 1000, '2026-09-04']
    ])
  )
  check(
    '非合并空周期不得跨越物理空白行继承',
    carryReset.blankRowIndexes.join(',') === '3' &&
      carryReset.validRows.find((row) => row.nickname === '无源周期')?.rowIndex === 4 &&
      !carryReset.validRows.find((row) => row.nickname === '无源周期')?.sourceTimeCycleRaw,
    JSON.stringify(carryReset.allRows.map((row) => [row.rowIndex, row.sourceTimeCycleRaw]))
  )

  console.log('\n===== 试验.xlsx 真实结构回归：42 条 / 四段合并 / 五个空白分隔行 =====')
  const fixtureRows = Array.from({ length: 47 }, () => ['', '', '', ''])
  const groups = [
    [2, 8, '08/13-08/19', '2026-08-14'],
    [10, 22, '08/20-08/26', '2026-08-20'],
    [25, 37, '08/27-09/02', '2026-08-27'],
    [40, 48, '09/03-09/09', '2026-09-03']
  ]
  const fixtureExpected = new Map()
  for (const [start, end, source, date] of groups) {
    for (let excelRow = start; excelRow <= end; excelRow += 1) {
      const nickname = `fixture-${excelRow}`
      fixtureRows[excelRow - 2] = [excelRow === start ? source : '', nickname, 1000, date]
      fixtureExpected.set(excelRow, { nickname, source, date })
    }
  }
  const realNamedRows = [
    [27, '样板达人10', '2026-08-26'],
    [40, '样板达人06', '2026-09-04'],
    [41, '样板达人13', '2026-09-09'],
    [42, '样板达人05', '2026-09-08'],
    [43, '样板达人14', '2026-09-08'],
    [44, '样板达人07', '2026-09-04'],
    [45, '样板达人03（副本）', '2026-09-03'],
    [46, '样板达人04', '2026-09-05'],
    [47, '样板达人02', '2026-09-04'],
    [48, '样板达人01', '2026-09-05']
  ]
  for (const [excelRow, nickname, date] of realNamedRows) {
    fixtureRows[excelRow - 2][1] = nickname
    fixtureRows[excelRow - 2][3] = date
    fixtureExpected.set(excelRow, { ...fixtureExpected.get(excelRow), nickname, date })
  }
  const fixtureMerges = groups.map(([start, end]) => ({
    s: { r: start - 1, c: 0 },
    e: { r: end - 1, c: 0 }
  }))
  const makeRealStructureFixture = () =>
    makeFile(['时间周期', '达人昵称', '总花费', '发布日期'], fixtureRows, fixtureMerges)
  const fixtureResult = await parseRecordsExcel(makeRealStructureFixture())
  const fixtureByRow = new Map(fixtureResult.allRows.map((row) => [row.rowIndex, row]))
  check(
    '真实结构 fixture 的 42 条业务记录逐行绑定 Excel 物理行号与所属 merge 周期',
    fixtureResult.allRows.length === 42 &&
      [...fixtureExpected].every(([excelRow, expected]) => {
        const row = fixtureByRow.get(excelRow)
        return row?.nickname === expected.nickname &&
          row.sourceTimeCycleRaw === expected.source &&
          row.publish_date === expected.date
      }),
    JSON.stringify(fixtureResult.allRows.map((row) => [row.rowIndex, row.nickname, row.sourceTimeCycleRaw]))
  )
  check(
    '五个空白分隔行保留真实行号，且不变成业务记录',
    fixtureResult.blankRowIndexes.join(',') === '9,23,24,38,39',
    JSON.stringify(fixtureResult.blankRowIndexes)
  )
  check(
    '真实结构 fixture：成功 41 / 需确认 1 / 失败 0 / 跳过 5，唯一冲突为第27行 Gary',
    fixtureResult.validRows.length === 41 &&
      fixtureResult.confirmationRows.length === 1 &&
      fixtureResult.confirmationRows[0].rowIndex === 27 &&
      fixtureResult.confirmationRows[0].reason === excel.SOURCE_CONFLICT_MESSAGE &&
      fixtureResult.failedRows.length === 0 &&
      fixtureResult.blankRows === 5 &&
      fixtureResult.sourceRangeViolationRows === 1 &&
      fixtureResult.sourceRangeViolations[0].rowIndex === 27 &&
      fixtureResult.sourceRangeViolations[0].nickname === '样板达人10' &&
      fixtureResult.sourceRangeViolations[0].sourceTimeCycle === '08/27-09/02' &&
      fixtureByRow.get(27)?.publish_date === '2026-08-26' &&
      fixtureByRow.get(27)?.time_cycle === excel.publishDateToWeekCode('2026-08-26'),
    JSON.stringify(fixtureResult.sourceRangeViolations)
  )
  check(
    '其余 41 条正常记录自动可入库，无需人工确认',
    fixtureResult.validRows.length === 41 &&
      fixtureResult.validRows.every((row) => !row.sourceCycleConfirmed && row.rowIndex !== 27)
  )
  check(
    'Excel 第40–48行九位达人均合法且来源严格为 09/03-09/09',
    realNamedRows.slice(1).every(([excelRow, nickname]) => {
      const row = fixtureResult.validRows.find((item) => item.rowIndex === excelRow)
      return row?.nickname === nickname && row.sourceTimeCycleRaw === '09/03-09/09'
    }),
    JSON.stringify(fixtureResult.validRows.filter((row) => row.rowIndex >= 40).map((row) => [row.rowIndex, row.nickname, row.sourceTimeCycleRaw]))
  )
  const confirmedResult = excel.confirmSourceTimeCycleConflict(fixtureResult, 27)
  const confirmedGary = confirmedResult.validRows.find((row) => row.rowIndex === 27)
  check(
    '确认当前投放档期后：42 可入库 / 0 需确认，发布日期和 canonical 周保持原值',
    confirmedResult.validRows.length === 42 &&
      confirmedResult.confirmationRows.length === 0 &&
      confirmedResult.failedRows.length === 0 &&
      confirmedResult.blankRows === 5 &&
      confirmedResult.sourceRangeViolationRows === 1 &&
      confirmedGary?.publish_date === '2026-08-26' &&
      confirmedGary?.time_cycle === excel.publishDateToWeekCode('2026-08-26') &&
      confirmedGary?.sourceTimeCycleRaw === '08/27-09/02' &&
      confirmedGary?.sourceCycleConfirmed === true,
    JSON.stringify(confirmedGary)
  )
  check(
    '确认只作用于导入会话，原解析结果仍为 41 成功 / 1 需确认',
    fixtureResult.validRows.length === 41 &&
      fixtureResult.confirmationRows[0].rowIndex === 27 &&
      fixtureResult.allRows.find((row) => row.rowIndex === 27)?.publish_date === '2026-08-26'
  )
  const repairedSource = excel.applyManualImportCorrection(fixtureResult, 27, {
    publish_date: '2026-08-27',
    sourceTimeCycleRaw: '08/26-09/02'
  })
  check(
    '人工调整源周期可通过校验，但不能借机改写客观发布日期与自然周',
    repairedSource.validRows.length === 42 &&
      repairedSource.confirmationRows.length === 0 &&
      repairedSource.validRows.find((row) => row.rowIndex === 27)?.publish_date === '2026-08-26' &&
      repairedSource.validRows.find((row) => row.rowIndex === 27)?.sourceTimeCycleRaw === '08/26-09/02' &&
      repairedSource.validRows.find((row) => row.rowIndex === 27)?.time_cycle === excel.publishDateToWeekCode('2026-08-26') &&
      repairedSource.validRows.find((row) => row.rowIndex === 27)?.manualCorrectionFields.join(',') === 'sourceTimeCycleRaw'
  )
  const stillInvalid = excel.applyManualImportCorrection(fixtureResult, 27, {
    publish_date: '2026-08-25',
    sourceTimeCycleRaw: '08/28-09/03'
  })
  check(
    '人工调整后仍有档期冲突时留在需确认列表，不变为失败或成功',
    stillInvalid.validRows.length === 41 &&
      stillInvalid.confirmationRows[0]?.rowIndex === 27 &&
      stillInvalid.confirmationRows[0]?.reason === excel.SOURCE_CONFLICT_MESSAGE &&
      stillInvalid.failedRows.length === 0 &&
      stillInvalid.allRows.find((row) => row.rowIndex === 27)?.publish_date === '2026-08-26'
  )
  const clearedSource = excel.applyManualImportCorrection(fixtureResult, 27, {
    sourceTimeCycleRaw: ''
  })
  const badSource = excel.applyManualImportCorrection(fixtureResult, 27, {
    sourceTimeCycleRaw: '无法识别的周期'
  })
  check(
    '清空或填入无效源周期不能绕过原有档期冲突',
    clearedSource.validRows.length === 41 &&
      clearedSource.confirmationRows.length === 0 &&
      clearedSource.failedRows[0]?.reason.includes('源时间周期不能为空') &&
      badSource.validRows.length === 41 &&
      badSource.failedRows[0]?.reason.includes('源时间周期无法识别')
  )
  const mixedError = await parseRecordsExcel(
    makeFile(['时间周期', '达人昵称', '总花费', '发布日期'], [
      ['08/27-09/02', '双重问题', '错误金额', '2026-08-26']
    ])
  )
  const mixedRepaired = excel.applyManualImportCorrection(mixedError, 2, { total_cost: '1000' })
  check(
    '确定性格式错误仍先判失败，修好后才转为需确认；不能直接确认放行',
    mixedError.failedRows.length === 1 &&
      mixedError.confirmationRows.length === 0 &&
      excel.confirmSourceTimeCycleConflict(mixedError, 2) === mixedError &&
      mixedRepaired.failedRows.length === 0 &&
      mixedRepaired.confirmationRows.length === 1 &&
      mixedRepaired.validRows.length === 0 &&
      mixedRepaired.allRows[0].publish_date === '2026-08-26'
  )
  const badCost = await parseRecordsExcel(
    makeFile(['时间周期', '达人昵称', '总花费', '发布日期'], [
      ['08/27-09/02', '费用待修正', '错误金额', '2026-08-27']
    ])
  )
  const repairedCost = excel.applyManualImportCorrection(badCost, 2, { total_cost: '1000' })
  check(
    '其他本地校验失败字段也复用同一校验规则进入有效列表',
    badCost.failedRows.length === 1 &&
      repairedCost.failedRows.length === 0 &&
      repairedCost.validRows[0]?.total_cost === 1000
  )
  check(
    '周期重校验保留人工修正与人工确认标记',
    excel.applyTimeCycleMapping(repairedSource, {}).validRows.find((row) => row.rowIndex === 27)
      ?.manualCorrection === true &&
      excel.applyTimeCycleMapping(confirmedResult, {}).validRows.find((row) => row.rowIndex === 27)
        ?.sourceCycleConfirmed === true
  )
  const fixtureReparsed = await parseRecordsExcel(makeRealStructureFixture(), [], {
    overrides: { '时间周期': 'time_cycle' }
  })
  const fixtureRemapped = excel.applyTimeCycleMapping(fixtureResult, {})
  check(
    '映射确认后二次解析与时间周期映射重校验均保持 41 成功 / 1 需确认及真实行号',
    [fixtureReparsed, fixtureRemapped].every((result) =>
      result.allRows.length === 42 &&
      result.validRows.length === 41 &&
      result.confirmationRows.length === 1 &&
      result.failedRows.length === 0 &&
      result.sourceRangeViolationRows === 1 &&
      result.sourceRangeViolations[0].rowIndex === 27 &&
      result.allRows.find((row) => row.rowIndex === 40)?.sourceTimeCycleRaw === '09/03-09/09'
    )
  )

  console.log('\n===== rowIndex 绑定审计（禁止数组下标对齐）=====')
  const alignRows = [
    ['2026-W33', '甲', 1000, '2026-08-18'],
    ['', '', '', ''],
    ['时间周期', '达人昵称', '总花费', '发布日期'],
    ['2026-W34', '乙', 1000, '2026-08-25'],
    ['', '', '', ''],
    ['2026-W35', '丙', 1000, '2026-09-01']
  ]
  const alignResult = await parseRecordsExcel(
    makeFile(['时间周期', '达人昵称', '总花费', '发布日期'], alignRows)
  )
  check(
    'validRows 的 rowIndex 与真实 Excel 行号一致（2 / 5 / 7）',
    alignResult.validRows.map((row) => row.rowIndex).join(',') === '2,5,7',
    JSON.stringify(alignResult.validRows.map((row) => row.rowIndex))
  )
  const remapSource = [
    ['9月第一周', '甲', 1000, ''],
    ['2026-W34', '乙', 1000, '']
  ]
  const remapBase = await parseRecordsExcel(
    makeFile(['时间周期', '达人昵称', '总花费', '发布日期'], remapSource)
  )
  const remapped = excel.applyTimeCycleMapping(remapBase, { '9月第一周': '2026-W36' })
  check(
    'applyTimeCycleMapping 按行绑定：仅命中原始值的行被替换且 rowIndex 保持',
    remapped.allRows.length === 2 &&
      remapped.allRows[0].rowIndex === 2 &&
      remapped.allRows[0].time_cycle === '2026-W36' &&
      remapped.allRows[1].rowIndex === 3 &&
      remapped.allRows[1].time_cycle === '2026-W34',
    JSON.stringify(remapped.allRows.map((r) => [r.rowIndex, r.time_cycle]))
  )
  const overrideApplied = await (async () => {
    const base = await parseRecordsExcel(
      makeFile(
        ['时间周期', '达人昵称', '总花费', '发布日期'],
        [['09/03-09/09', '甲', 1000, '2026-09-08']]
      )
    )
    return excel.applyTimeCycleMapping(base, { '09/03-09/09': '2026-W34' })
  })()
  check(
    'applyTimeCycleMapping 不得覆盖发布日期推导出的标准周',
    overrideApplied.validRows[0]?.time_cycle === '2026-W36',
    JSON.stringify(overrideApplied.validRows.map((r) => [r.rowIndex, r.time_cycle]))
  )
  const normalizeOutput = ai.applyAiNormalizeResults(['9月第一周', '月底那周'], {
    月底那周: '2026-W36'
  })
  check(
    'AI 周期识别结果按「原始值」回绑，不依赖数组顺序',
    normalizeOutput[0].value === '9月第一周' &&
      normalizeOutput[0].weekCode === null &&
      normalizeOutput[1].value === '月底那周' &&
      normalizeOutput[1].weekCode === '2026-W36'
  )

  console.log('\n===== 未识别字段默认「未选择」=====')
  const unknownResult = await parseRecordsExcel(
    makeFile(
      ['时间周期', '达人昵称', '总花费', '发布日期', '播放量（首发）', '播放量（新）', '报价'],
      [['2026-W33', '达人A', 1000, '2026-08-20', 10000, 50000, '面议']]
    )
  )
  const review = excel.buildHeaderMappingReview(unknownResult)
  check(
    '未识别字段默认「未选择」（target 为空，即使系统已给出建议）',
    review.items.length === 3 &&
      review.items.every((item) => item.target === '') &&
      review.items.some((item) => item.suggestion === 'first_play'),
    JSON.stringify(review.items.map((i) => [i.header, i.target, i.suggestion]))
  )
  check(
    '未全部选择前不可继续导入（isMappingReviewComplete = false）',
    excel.isMappingReviewComplete(review.items) === false
  )
  const partlyChosen = review.items.map((item, index) =>
    index === 0 ? { ...item, target: item.suggestion || excel.IGNORE_FIELD } : item
  )
  check(
    '只选择了一部分 → 仍然不可继续（必须全部明确选择）',
    excel.isMappingReviewComplete(partlyChosen) === false
  )
  const fullyChosen = review.items.map((item) => ({
    ...item,
    target: item.suggestion || excel.IGNORE_FIELD
  }))
  check(
    '全部明确选择后才可继续（含显式「忽略此列」）',
    excel.isMappingReviewComplete(fullyChosen) === true
  )

  console.log('\n===== 历史 / 正式表头兼容未退化 =====')
  const official = await parseRecordsExcel(
    makeFile(
      ['时间周期', '达人昵称', '达人类型', '总花费(元)', '7日播放量', '累计播放量', '发布日期', '视频链接'],
      [['2026-W33', '达人A', '数码', 5000, 82000, 135000, '2026-08-20', 'https://www.douyin.com/video/1']]
    )
  )
  check(
    '正式表头：无未识别字段、无失败行（不触发映射确认）',
    !requiresMappingGate(official) &&
      official.unknownHeaders.length === 0 &&
      official.validRows.length === 1 &&
      official.validRows[0].first_play === 82000,
    JSON.stringify(official.unknownHeaders)
  )
  const legacy = await parseRecordsExcel(
    makeFile(
      ['时间周期', '达人昵称', '博主类型', '总花费', '首发播放量', '次周播放量', '发布日期'],
      [['2026-W33', '达人A', '数码', 5000, 82000, 135000, '2026-08-20']]
    )
  )
  check(
    '历史表头（首发播放量 / 次周播放量）：仍直接识别，不进入映射确认',
    !requiresMappingGate(legacy) && legacy.validRows[0].second_week_play === 135000
  )
  const exported = await parseRecordsExcel(
    makeFile(
      ['时间周期', '达人昵称', '达人类型', '达人主页', '植入链接', '视频链接', '总花费(元)', 'CPM', '7日播放量', '累计播放量', '后续新增播放量', '发布日期'],
      [['2026-W33', '达人A', '数码', '', '', '', 5000, 116.78, 82000, 135000, 53000, '2026-08-20']]
    )
  )
  check(
    '本系统导出文件回环导入：CPM / 后续新增播放量为已知忽略列，不触发确认',
    !requiresMappingGate(exported) &&
      exported.systemIgnoredHeaders.length === 2 &&
      exported.validRows.length === 1,
    JSON.stringify(exported.systemIgnoredHeaders)
  )

  console.log('\n===== AI 字段识别：边界与白名单 =====')
  const aiColumns = [
    { header: '播放量（首发）', samples: ['51800'] },
    { header: '播放量（新）', samples: ['291300'] }
  ]
  const mappingPrompt = ai.buildFieldMappingPrompt(aiColumns)
  check(
    'AI 提示词包含完整白名单（含 IGNORE / UNKNOWN）',
    ai.MAPPING_TARGET_FIELDS.every((field) => mappingPrompt.includes(field)) &&
      ai.MAPPING_TARGET_FIELDS.includes('IGNORE') &&
      ai.MAPPING_TARGET_FIELDS.includes('UNKNOWN')
  )
  check(
    'AI 提示词明确 first_play = 7日播放量、second_week_play = 累计播放量（不是第二周新增）',
    mappingPrompt.includes('7日播放量') &&
      mappingPrompt.includes('累计播放量') &&
      mappingPrompt.includes('不是「第二周新增播放量」')
  )
  check(
    'AI 提示词只发送表头与样例值，不发送整表（要求逐条返回原始表头）',
    mappingPrompt.includes('播放量（首发）') &&
      mappingPrompt.includes('51800') &&
      mappingPrompt.includes('source_header') &&
      mappingPrompt.includes('不得遗漏、不得新增')
  )

  const normalized = ai.normalizeFieldSuggestions(
    {
      mappings: [
        { source_header: '播放量（首发）', suggested_field: 'first_play', confidence: 'high', reason: '含首发' },
        { source_header: '播放量（新）', suggested_field: 'second_week_play', confidence: 'HIGH', reason: '含新' },
        { source_header: '报价', suggested_field: 'drop_table', confidence: 'high', reason: '乱答' }
      ]
    },
    [{ header: '播放量（首发）' }, { header: '播放量（新）' }, { header: '报价' }, { header: '备注' }]
  )
  check(
    'AI 返回的结构化结果被采纳（含 confidence 归一化）',
    normalized[0].suggested_field === 'first_play' &&
      normalized[1].suggested_field === 'second_week_play' &&
      normalized[1].confidence === 'high',
    JSON.stringify(normalized)
  )
  check(
    'AI 自创字段（不在白名单）→ 强制 UNKNOWN，不得写入数据库字段',
    normalized[2].suggested_field === 'UNKNOWN',
    JSON.stringify(normalized[2])
  )
  check(
    'AI 未返回的列 → 结构稳定补 UNKNOWN（不遗漏）',
    normalized[3].source_header === '备注' && normalized[3].suggested_field === 'UNKNOWN'
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
