#!/usr/bin/env node
// Excel Import Identity Fix（Phase 1）回归测试
//
// 运行方式：node tests/excel_import_identity.test.js
// 特性：纯函数 + 解析器测试；不写数据库；不访问网络。
//   · record identity = normalizeRecordIdentityLink(video_link)（mutable facts 不参与身份）
//   · 同 identity 后再比较 facts：exact_duplicate / existing_noop / existing_changed
//   · 无 video_link => identity_uncertain（不自动 duplicate / 不自动 new）

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

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

const VIDEO_A = 'https://www.iesdouyin.com/share/video/7675554155213264241'
const VIDEO_B = 'https://www.iesdouyin.com/share/video/7677849506699824447'

const mkExisting = (over = {}) => ({
  id: 687,
  time_cycle: '2026-W33',
  nickname: '样板达人15',
  creator_type: '历史类',
  homepage: 'https://v.douyin.com/aaa/',
  content_link: 'https://www.zhihu.com/question/1/answer/2',
  video_link: VIDEO_A,
  total_cost: 2100,
  publish_date: '2026-08-19',
  first_play: 0,
  second_week_play: 36200,
  ...over
})

const mkIncoming = (over = {}) => ({ ...mkExisting(), id: undefined, ...over })

async function main() {
  const excel = await import(pathToFileURL(path.join(root, 'frontend/src/utils/excel.js')).href)
  const { normalizeRecordIdentityLink, buildRecordFieldDiff, classifyImportRows, isPreviewEligible } = excel

  console.log('===== 1. normalizeRecordIdentityLink =====')
  check('trim + host 小写 + 去 www.', normalizeRecordIdentityLink('  https://WWW.IESdouyin.com/a/b/  ') === 'iesdouyin.com/a/b')
  check('query 不同 -> 同一 identity', normalizeRecordIdentityLink(VIDEO_A + '?from=share') === normalizeRecordIdentityLink(VIDEO_A))
  check('fragment 不同 -> 同一 identity', normalizeRecordIdentityLink(VIDEO_A + '#x') === normalizeRecordIdentityLink(VIDEO_A))
  check('scheme 不同 -> 同一 identity', normalizeRecordIdentityLink('http://iesdouyin.com/a/b') === normalizeRecordIdentityLink('https://iesdouyin.com/a/b'))
  check('协议相对 -> 同一 identity', normalizeRecordIdentityLink('//iesdouyin.com/a/b') === normalizeRecordIdentityLink('https://iesdouyin.com/a/b'))
  check('trailing slash 不同 -> 同一 identity', normalizeRecordIdentityLink('https://iesdouyin.com/a/b/') === normalizeRecordIdentityLink('https://iesdouyin.com/a/b'))
  check('端口不影响 identity', normalizeRecordIdentityLink('https://iesdouyin.com:443/a/b') === normalizeRecordIdentityLink('https://iesdouyin.com/a/b'))
  check('不同链接 -> 不同 identity', normalizeRecordIdentityLink(VIDEO_A) !== normalizeRecordIdentityLink(VIDEO_B))
  check('空 / null -> 空字符串', normalizeRecordIdentityLink('') === '' && normalizeRecordIdentityLink(null) === '')
  check('不做短链展开 / 不做 fuzzy', normalizeRecordIdentityLink('https://v.douyin.com/ABC/') === 'v.douyin.com/ABC')

  console.log('\n===== 2. 身份相同 + facts 比较 =====')
  const existingA = mkExisting()
  const exact = classifyImportRows([mkIncoming()], [existingA])
  check('CASE 1：事实完全相同 -> exact_duplicate', exact.exactDuplicates.length === 1 && exact.newRecords.length === 0 && exact.existingChanged.length === 0)

  const noopRow = mkIncoming({ first_play: '' })
  const noop = classifyImportRows([noopRow], [existingA])
  check('CASE 2：DB first_play=0 / incoming 空 -> existing_noop（不是 changed）', noop.existingNoop.length === 1 && noop.existingChanged.length === 0 && noop.newRecords.length === 0)
  const noopDiff = buildRecordFieldDiff(existingA, noopRow).find((d) => d.field === 'first_play')
  check('CASE 2b：该差异 change_type = incoming_missing（绝不覆盖 0）', noopDiff?.change_type === 'incoming_missing' && noopDiff.existing_value === 0)

  const changedRow = mkIncoming({ second_week_play: 40400 })
  const changed = classifyImportRows([changedRow], [existingA])
  check('CASE 3：36200 -> 40400 -> existing_changed', changed.existingChanged.length === 1 && changed.existingChanged[0].diffs[0].field === 'second_week_play' && changed.existingChanged[0].diffs[0].change_type === 'changed_value')

  const swMissing = mkIncoming({ second_week_play: null })
  const swMissingResult = classifyImportRows([swMissing], [existingA])
  check('CASE 4：36200 -> 空 -> no-op（不能覆盖）', swMissingResult.existingNoop.length === 1 && swMissingResult.existingChanged.length === 0)

  const multi = mkIncoming({ second_week_play: 40400, total_cost: 2500, creator_type: '科普' })
  const multiResult = classifyImportRows([multi], [existingA])
  check('CASE 5：多字段变化 -> 字段级 diff', multiResult.existingChanged.length === 1 && multiResult.existingChanged[0].diffs.length === 3)
  check('CASE 5b：diff 含 existing/incoming 值与 change_type', multiResult.existingChanged[0].diffs.every((d) => 'field' in d && 'existing_value' in d && 'incoming_value' in d && 'change_type' in d))

  console.log('\n===== 3. 身份归一化判等（query / scheme / trailing slash） =====')
  const q = classifyImportRows([mkIncoming({ video_link: VIDEO_A + '?utm=1' })], [existingA])
  check('CASE 6：query 不同 -> 同一条记录（exact_duplicate）', q.exactDuplicates.length === 1 && q.newRecords.length === 0)
  const s = classifyImportRows([mkIncoming({ video_link: VIDEO_A.replace('https://', 'http://') })], [existingA])
  check('CASE 7：scheme 不同 -> 同一条记录', s.exactDuplicates.length === 1)
  const t = classifyImportRows([mkIncoming({ video_link: VIDEO_A + '/' })], [existingA])
  check('CASE 8：trailing slash 不同 -> 同一条记录', t.exactDuplicates.length === 1)
  const n = classifyImportRows([mkIncoming({ video_link: VIDEO_B })], [existingA])
  check('CASE 9：不同 video_link -> new_record', n.newRecords.length === 1 && n.exactDuplicates.length === 0)

  console.log('\n===== 4. 无链接 / 同名多视频 =====')
  const noLink = classifyImportRows([mkIncoming({ video_link: '' })], [existingA])
  check('CASE 10：video_link 缺失 -> identity_uncertain（不 duplicate / 不 new）', noLink.identityUncertain.length === 1 && noLink.newRecords.length === 0 && noLink.exactDuplicates.length === 0)
  const sameNameTwoVideos = classifyImportRows(
    [mkIncoming({ id: undefined, video_link: VIDEO_A + 'X' }), mkIncoming({ id: undefined, video_link: VIDEO_A + 'Y' })],
    []
  )
  check('CASE 11：同 nickname 不同 video -> 两条 new', sameNameTwoVideos.newRecords.length === 2)
  const sameDayTwoVideos = classifyImportRows(
    [mkIncoming({ id: undefined, video_link: VIDEO_A + 'P', publish_date: '2026-08-19' }), mkIncoming({ id: undefined, video_link: VIDEO_A + 'Q', publish_date: '2026-08-19' })],
    []
  )
  check('CASE 12：同 nickname 同日不同 video -> 两条 new', sameDayTwoVideos.newRecords.length === 2)

  console.log('\n===== 5. 等价 fixture 回归（31 exact / 4 noop / 7 changed / 23 new / 12 blank） =====')
  const baseVideo = (n) => `https://www.iesdouyin.com/share/video/900000000000000${String(n).padStart(4, '0')}`
  const fixtureExisting = []
  const fixtureRows = []
  // 31 exact
  for (let i = 1; i <= 31; i += 1) {
    const rec = mkExisting({ id: 1000 + i, video_link: baseVideo(i), nickname: `exact-${i}`, first_play: 10000 + i, second_week_play: 50000 + i })
    fixtureExisting.push(rec)
    fixtureRows.push({ ...rec, id: undefined })
  }
  // 4 noop：DB first_play=0，Excel 空
  for (let i = 32; i <= 35; i += 1) {
    const rec = mkExisting({ id: 1000 + i, video_link: baseVideo(i), nickname: `noop-${i}`, first_play: 0, second_week_play: 50000 + i })
    fixtureExisting.push(rec)
    fixtureRows.push({ ...rec, id: undefined, first_play: '' })
  }
  // 7 changed：累计播放上修
  for (let i = 36; i <= 42; i += 1) {
    const rec = mkExisting({ id: 1000 + i, video_link: baseVideo(i), nickname: `changed-${i}`, first_play: 1000, second_week_play: 36200 })
    fixtureExisting.push(rec)
    fixtureRows.push({ ...rec, id: undefined, second_week_play: 40400 })
  }
  // 23 new
  for (let i = 43; i <= 65; i += 1) {
    fixtureRows.push(mkExisting({ id: undefined, video_link: baseVideo(i), nickname: `new-${i}` }))
  }
  const fixture = classifyImportRows(fixtureRows, fixtureExisting)
  check('fixture：31 exact_duplicate', fixture.exactDuplicates.length === 31, String(fixture.exactDuplicates.length))
  check('fixture：4 existing_noop', fixture.existingNoop.length === 4, String(fixture.existingNoop.length))
  check('fixture：7 existing_changed', fixture.existingChanged.length === 7, String(fixture.existingChanged.length))
  check('fixture：23 new_record', fixture.newRecords.length === 23, String(fixture.newRecords.length))
  check('fixture：0 identity_uncertain', fixture.identityUncertain.length === 0)
  check('fixture：无任何行既 new 又 duplicate', fixture.newRecords.length + fixture.exactDuplicates.length + fixture.existingNoop.length + fixture.existingChanged.length === 65)
  check('fixture：changed 的 diff 只含真实变化（incoming_missing 不算）', fixture.existingChanged.every((item) => item.diffs.some((d) => d.change_type === 'changed_value')))

  console.log('\n===== 6. 本地样本 1008.xlsx 回归（存在时校验，路径由环境变量提供） =====')
  // 真实样本不随仓库分发；如需启用本回归，设置 WORKBENCH_REAL_IMPORT_XLSX 指向本地样本
  const realFile = process.env.WORKBENCH_REAL_IMPORT_XLSX || path.join(root, 'tests', 'fixtures', 'real-1008-sample.xlsx')
  const realDb = path.join(root, 'backend/workbench.db')
  if (fs.existsSync(realFile) && fs.existsSync(realDb)) {
    const { createRequire } = require('node:module')
    const req = createRequire(path.join(root, 'backend/package.json'))
    const Database = req('better-sqlite3')
    const db = new Database(realDb, { readonly: true })
    const existing = db.prepare('SELECT * FROM creator_records ORDER BY id').all()
    const cycles = [...new Set(existing.map((r) => r.time_cycle).filter(Boolean))].sort()
    const buf = fs.readFileSync(realFile)
    const file = { name: '1008.xlsx', arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
    const parsed = await excel.parseRecordsExcel(file, cycles, {
      overrides: {
        '播放量（首发）': 'first_play',
        '播放量（新）': 'second_week_play',
        报价: 'IGNORE',
        cpm: 'IGNORE'
      }
    })
    const real = classifyImportRows(parsed.validRows, existing)
    // 冻结回归（DB 已由 42 条增长到 65 条：此前 23 条真正的新记录已成功导入，
    //   因此本次重传同一文件时它们全部变为 exact_duplicate，new_record 归零）
    const businessCount = parsed.validRows.length
    check('1008：完全重复 = 54（原 31 精确重复 + 已导入的 23 条）', real.exactDuplicates.length === 54, String(real.exactDuplicates.length))
    check('1008：4 existing_noop（687/688/689/690）', real.existingNoop.length === 4 && real.existingNoop.every((x) => [687, 688, 689, 690].includes(x.existingRow.id)), JSON.stringify(real.existingNoop.map((x) => x.existingRow.id)))
    check('1008：7 existing_changed（715/716/718/719/720/721/722）', real.existingChanged.length === 7 && real.existingChanged.every((x) => [715, 716, 718, 719, 720, 721, 722].includes(x.existingRow.id)), JSON.stringify(real.existingChanged.map((x) => x.existingRow.id)))
    check('1008：715 的 first_play 差异为 incoming_missing（不算更新）', (() => {
      const rec715 = real.existingChanged.find((x) => x.existingRow.id === 715)
      const fp = rec715?.diffs.find((d) => d.field === 'first_play')
      return fp?.change_type === 'incoming_missing' && rec715.diffs.some((d) => d.field === 'second_week_play' && d.change_type === 'changed_value')
    })())
    check('1008：0 new_record（重传时无新增）', real.newRecords.length === 0, String(real.newRecords.length))
    check('1008：12 blank', parsed.blankRows === 12, String(parsed.blankRows))
    check('1008：0 identity_uncertain', real.identityUncertain.length === 0)
    check('1008：分类总数守恒（new+exact+noop+changed == 65 业务行）',
      real.newRecords.length + real.exactDuplicates.length + real.existingNoop.length + real.existingChanged.length === businessCount &&
      businessCount === 65,
      `business=${businessCount}`)
    check('1008：update-only（0 new）仍可进入 Preview', isPreviewEligible({ classification: real, failedCount: parsed.failedRows.length }) === true)
    db.close()
  } else {
    check('1008.xlsx / 真实库不可用 -> 跳过真实回归（等价 fixture 已覆盖）', true, 'skipped')
  }

  console.log('\n===== 7. import payload 只包含 new_record（源码级） =====')
  const modalSrc = fs.readFileSync(path.join(root, 'frontend/src/components/ExcelImportModal.jsx'), 'utf8')
  check('导入列表来自 newRecords', /result\.validRows = classification\.newRecords\.map\(\(item\) => item\.row\)/.test(modalSrc))
  check('excluded（exact/noop/changed/uncertain）不进 validRows / 不进 POST', /excludedRowsRef\.current = \[/.test(modalSrc) && /const excludedImportRows = useMemo/.test(modalSrc))
  check('不再使用 10 字段 fingerprint dedupe', !/dedupeImportRows|identityFingerprint/.test(modalSrc))
  check('预览区分新记录 / 可安全更新 / 需人工处理 / 无新增信息 / 完全重复',
    /新记录（可导入）/.test(modalSrc) && /可安全更新/.test(modalSrc) && /需人工处理/.test(modalSrc) &&
      /已有记录无新增信息/.test(modalSrc) && /完全重复/.test(modalSrc))
  check(
    '已有记录更新拆分为「可安全更新 / 需人工处理」，且无整行覆盖入口',
    /可安全更新已有记录（\$\{updatePlan\.safeUpdates\.length\}）/.test(modalSrc) &&
      /条已有记录变化需人工处理（不自动写入）/.test(modalSrc) &&
      !/一键更新|更新旧记录|批量更新|覆盖已有记录|整行覆盖/.test(modalSrc)
  )
  check(
    '预览仍保留 跳过 / 需确认 / 失败 统计卡片',
    /title="跳过"/.test(modalSrc) && /title="需确认"/.test(modalSrc) && /title="失败"/.test(modalSrc)
  )
  check(
    '批次行级状态只用后端允许的 success/fail/skip/duplicate/updated（不写入 changed/noop）',
    !/status: 'changed'/.test(modalSrc) && !/status: 'noop'/.test(modalSrc) &&
      /status:\s*[\s\S]{0,120}?identity_uncertain[\s\S]{0,80}?'skip'/.test(modalSrc) &&
      /status: 'updated'/.test(modalSrc)
  )

  console.log('\n===== 8. Preview 可用性 gate（update-only / 全重复文件不得被 Step 2 拦死） =====')
  // 用纯函数 isPreviewEligible 覆盖 gate 语义（Preview 可用性 ≠ 可新增导入）
  const classifyFor = (incoming, existingRows) => classifyImportRows(incoming, existingRows)

  // 场景 1：0 new + 7 changed -> 必须可进入 Preview
  const existingChangedSet = []
  const incomingChangedSet = []
  for (let i = 0; i < 7; i += 1) {
    const rec = mkExisting({ id: 500 + i, video_link: `https://iesdouyin.com/share/video/chg${i}`, second_week_play: 10000 })
    existingChangedSet.push(rec)
    incomingChangedSet.push({ ...rec, id: undefined, second_week_play: 20000 })
  }
  const c1 = classifyFor(incomingChangedSet, existingChangedSet)
  check('场景1：0 new + 7 changed -> canPreview=true', c1.newRecords.length === 0 && c1.existingChanged.length === 7 && isPreviewEligible({ classification: c1 }) === true)

  // 场景 2：0 new + 0 changed + 全重复 -> 仍可进入 Preview（展示「未发现新记录或可更新数据」）
  const c2 = classifyFor(
    [0, 1, 2].map((i) => mkExisting({ id: undefined, video_link: `https://iesdouyin.com/share/video/dup${i}` })),
    [0, 1, 2].map((i) => mkExisting({ id: 700 + i, video_link: `https://iesdouyin.com/share/video/dup${i}` }))
  )
  check('场景2：0 new + 0 changed + 3 重复 -> canPreview=true（非「无有效数据」）',
    c2.newRecords.length === 0 && c2.existingChanged.length === 0 && c2.exactDuplicates.length === 3 && isPreviewEligible({ classification: c2 }) === true)

  // 场景 3：0 new + identity_uncertain -> 可进入 Preview 做人工确认
  const c3 = classifyFor([mkExisting({ id: undefined, video_link: '' })], [mkExisting()])
  check('场景3：0 new + identity_uncertain -> canPreview=true',
    c3.newRecords.length === 0 && c3.identityUncertain.length === 1 && isPreviewEligible({ classification: c3 }) === true)

  // 场景 4：23 new + 7 changed -> 混合模式仍可进入 Preview
  const mixedExisting = [...existingChangedSet]
  const mixedIncoming = [
    ...incomingChangedSet,
    ...Array.from({ length: 23 }, (_, i) => mkExisting({ id: undefined, video_link: `https://iesdouyin.com/share/video/new${i}` }))
  ]
  const c4 = classifyFor(mixedIncoming, mixedExisting)
  check('场景4：23 new + 7 changed -> canPreview=true（原混合路径不受影响）',
    c4.newRecords.length === 23 && c4.existingChanged.length === 7 && isPreviewEligible({ classification: c4 }) === true)

  // 场景 5：完全没有业务行 -> 才判定「文件中没有有效数据」
  const c5 = classifyFor([], [])
  check('场景5：0 业务行 -> canPreview=false（唯一「无有效数据」情形）',
    isPreviewEligible({ classification: c5, failedCount: 0, confirmationCount: 0 }) === false)
  check('场景5b：parse 失败行 / 需确认行也算业务行 -> canPreview=true',
    isPreviewEligible({ classification: null, parsedValidCount: 0, failedCount: 1 }) === true &&
      isPreviewEligible({ classification: null, parsedValidCount: 0, confirmationCount: 2 }) === true)
  check('场景5c：拉取已有记录失败（无 classification）时按解析行数判定',
    isPreviewEligible({ classification: null, parsedValidCount: 23 }) === true &&
      isPreviewEligible({ classification: null, parsedValidCount: 0 }) === false)

  console.log('\n===== 9. update-only 语义（源码级） =====')
  check('gate 使用 isPreviewEligible（不再用 !validRows.length 判「无有效数据」）',
    /!isPreviewEligible\(\{/.test(modalSrc) && !/if \(!result\.validRows\.length && !result\.failedRows\.length/.test(modalSrc))
  check('无新记录时主操作不是「确认导入（0 条）」',
    /const hasNewRecords = importableRows\.length > 0/.test(modalSrc) &&
      /`更新已有记录（\$\{safeUpdateCount\} 条）`/.test(modalSrc) &&
      /'当前无新记录可导入'/.test(modalSrc) &&
      !/确认导入（0 条）/.test(modalSrc))
  check('update-only 不会 POST 空新增批次（handleConfirm 提前返回 + 按钮禁用）',
    /if \(!importableRows\.length && !updateIntents\.length\) return/.test(modalSrc) &&
      /const confirmDisabled = importing \|\| \(!hasNewRecords && updateIntents\.length === 0\)/.test(modalSrc))
  check('Preview 展示准确的「无新记录 / 未发现新记录或可更新数据」状态',
    /未发现新记录或可更新数据。/.test(modalSrc) &&
      /当前无新记录可导入；可安全更新 \$\{safeUpdateCount\} 条已有记录/.test(modalSrc))
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    process.exitCode = 1
  })
  .finally(() => {
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
