#!/usr/bin/env node
// Creator Identity V1 Phase 3 —— Work State 前端契约（数据源 = 服务端 candidate.work_state）
//
// 运行方式：node tests/creator_work_state.test.js
// 特性：纯前端源码 / 纯函数测试，不启动服务、不写库、不访问网络。
//
// Phase 3 起：
//   · Work State 唯一来源 = 服务端 candidate.work_state（advancing | observing | paused）
//   · 前端不再从 creator_decisions(candidate_review) 派生，也不再逐 candidate 拉 decisions
//   · 服务端派生（最新 event / 无事件默认 advancing / legacy 兼容）由后端测试覆盖：
//       tests/candidate_work_state_read.test.js、tests/candidate_work_state_write.test.js、
//       tests/creator_candidate_decisions.test.js
// 本文件覆盖：UI 词表与标签映射、缺失/非法值降级、三盒筛选互斥、计数、名称搜索、
//            IA 文案与折叠区、已关联合作记录（只取 outcome）、以及「不再 N+1 / 不再派生」的源码守卫。

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

async function main() {
  const util = await import(
    pathToFileURL(path.join(root, 'frontend/src/utils/creatorWorkState.js')).href
  )
  const utilSrc = fs.readFileSync(path.join(root, 'frontend/src/utils/creatorWorkState.js'), 'utf8')
  const utilCode = utilSrc
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  const page = fs.readFileSync(path.join(root, 'frontend/src/pages/CreatorPlaybook/index.jsx'), 'utf8')
  const pageCode = page
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')

  console.log('===== 1. UI 词表：服务端 state → 中文标签 =====')
  check('三个 state 词表 = advancing / observing / paused',
    JSON.stringify(util.WORK_STATE_VALUES) === JSON.stringify(['advancing', 'observing', 'paused']))
  check('advancing → 推进中', util.WORK_STATE_LABELS.advancing === '推进中')
  check('observing → 观察中', util.WORK_STATE_LABELS.observing === '观察中')
  check('paused → 暂缓池', util.WORK_STATE_LABELS.paused === '暂缓池')
  check('按钮顺序固定：推进中 / 观察中 / 暂缓池',
    JSON.stringify(util.WORK_STATE_OPTIONS.map((o) => o.label)) === JSON.stringify(['推进中', '观察中', '暂缓池']))
  check('默认 state = advancing（无值兼容）', util.DEFAULT_WORK_STATE === 'advancing')
  check('Tag 颜色覆盖三个 state', Object.keys(util.WORK_STATE_TAG_COLORS).sort().join() === 'advancing,observing,paused')
  check('筛选入口 = 全部 + 三盒', JSON.stringify(util.WORK_STATE_FILTER_OPTIONS.map((o) => o.value)) === JSON.stringify(['all', 'advancing', 'observing', 'paused']))

  console.log('\n===== 2. workStateOf：直接消费服务端值 =====')
  check('advancing', util.workStateOf({ work_state: 'advancing' }).label === '推进中')
  check('observing', util.workStateOf({ work_state: 'observing' }).label === '观察中')
  check('paused', util.workStateOf({ work_state: 'paused' }).label === '暂缓池')
  check('缺失 work_state → 默认 advancing', util.workStateOf({ id: 1 }).value === 'advancing')
  check('非法值（legacy contact）→ 默认 advancing（不映射旧值）', util.workStateOf({ work_state: 'contact' }).value === 'advancing')
  check('null candidate → 默认 advancing', util.workStateOf(null).value === 'advancing')
  check('workStateValueOf 与 workStateOf 一致',
    ['advancing', 'observing', 'paused', undefined, 'x'].every((raw) => {
      const candidate = { work_state: raw }
      return util.workStateOf(candidate).value === util.workStateValueOf(candidate)
    }))

  console.log('\n===== 3. 三个工作盒筛选互斥 + 计数 =====')
  const pool = [
    { id: 1, name: '甲', work_state: 'advancing' },
    { id: 2, name: '乙', work_state: 'observing' },
    { id: 3, name: '丙', work_state: 'paused' },
    { id: 4, name: '丁' } // 无 work_state → 默认 advancing
  ]
  const byState = (state) => util.filterCandidates({ candidates: pool, workState: state }).map((c) => c.id)
  check('推进中盒 = id 1,4（含默认值）', byState('advancing').join() === '1,4')
  check('观察中盒 = id 2', byState('observing').join() === '2')
  check('暂缓池盒 = id 3', byState('paused').join() === '3')
  check('三盒互斥且并集 = 全部', new Set([...byState('advancing'), ...byState('observing'), ...byState('paused')]).size === pool.length)
  const counts = util.summarizeWorkStates(pool)
  check('计数 = {all:4, advancing:2, observing:1, paused:1}',
    counts.all === 4 && counts.advancing === 2 && counts.observing === 1 && counts.paused === 1, JSON.stringify(counts))
  check('「全部」不做状态过滤（保持输入顺序）',
    util.filterCandidates({ candidates: pool, workState: 'all' }).map((c) => c.id).join() === '1,2,3,4')

  console.log('\n===== 4. 名称 substring 搜索（大小写不敏感）+ 与盒子叠加 =====')
  const searchPool = [
    { id: 1, name: 'Papi酱', work_state: 'advancing' },
    { id: 2, name: 'papi小号', work_state: 'observing' },
    { id: 3, name: '李佳琦', work_state: 'paused' }
  ]
  check('substring 命中（大小写不敏感）',
    util.filterCandidates({ candidates: searchPool, keyword: 'PAPI' }).map((c) => c.id).join() === '1,2')
  check('中文 substring 命中', util.filterCandidates({ candidates: searchPool, keyword: '佳琦' }).map((c) => c.id).join() === '3')
  check('无命中 → 空列表', util.filterCandidates({ candidates: searchPool, keyword: '不存在' }).length === 0)
  check('搜索 + 工作盒叠加（AND）',
    util.filterCandidates({ candidates: searchPool, keyword: 'papi', workState: 'observing' }).map((c) => c.id).join() === '2')
  check('空关键词只 trim（全量）', util.filterCandidates({ candidates: searchPool, keyword: '   ' }).length === 3)

  console.log('\n===== 5. 源码守卫：不再 N+1 / 不再派生 / 改走新写入 API =====')
  check('页面直接消费候选行上的 work_state（列表 + 选中）',
    /workStateOf\(item\)/.test(pageCode) && /workStateOf\(selected\)/.test(pageCode))
  check('页面不再 Promise.all 逐 candidate 拉 decisions（N+1 已消除）',
    !/Promise\.all/.test(pageCode) && !/listCandidateDecisions\(item\.id\)/.test(pageCode))
  check('页面用 createCandidateWorkState 写状态（新 endpoint）',
    /createCandidateWorkState\(selected\.id,/.test(pageCode))
  check('页面不再创建 candidate_review decision',
    !/createCandidateDecision\(/.test(pageCode) && !/human_decision: pendingDecision/.test(pageCode))
  check('状态备注来自服务端 work_state_note',
    /work_state_note/.test(pageCode) && /currentWorkState\.note/.test(pageCode))
  check('状态时间来自服务端 work_state_updated_at', /work_state_updated_at/.test(pageCode))
  check('历史改写自服务端 work_state_history（不再读 candidate_review 决策）',
    /work_state_history/.test(pageCode) && /workStateHistory/.test(pageCode) && !/reviewDecisions/.test(pageCode))
  check('报价 CTA 层级跟随服务端 Work State（不再读 legacy candidate_review）',
    /const reviewContactConfirmed = currentWorkState\.value === 'advancing'/.test(pageCode))
  check('util 不再包含 decisions 派生逻辑（代码层，注释说明不算）',
    !/deriveWorkState|candidate_review|human_decision|latestCandidateReviewDecision/.test(utilCode))
  check('util 不再导出旧派生 helper（deriveWorkState / latestCandidateReviewDecision）',
    typeof util.deriveWorkState === 'undefined' && typeof util.latestCandidateReviewDecision === 'undefined')
  check('util 仍是纯函数（无网络 / 无 AI / 无时间）',
    !/fetch\(|axios|Date\.now|Math\.random|deepseek/i.test(utilSrc))
  check('util 保留「已关联合作记录」的 outcome 过滤（与 Work State 无关）',
    typeof util.buildLinkedCollaborationRecords === 'function' &&
      /outcome/.test(utilSrc) &&
      util.buildLinkedCollaborationRecords([{ id: 1, outcome: { record_id: 9 } }, { id: 2, outcome: null }]).length === 1)

  console.log('\n===== 6. IA 保持第一轮结构（本轮不做视觉重构） =====')
  check('一级区块：达人资料画像 / 近期数据 / 当前合作 / 已关联合作记录',
    page.includes('达人资料画像') && page.includes('近期数据') && page.includes('当前合作') && page.includes('已关联合作记录（'))
  check('当前处理状态栏保留（当前处理 + 三按钮 + 状态备注）',
    page.includes('当前处理') && page.includes('状态备注：') && /WORK_STATE_OPTIONS\.map/.test(page))
  check('三个状态按钮标签为 推进中 / 观察中 / 暂缓池', page.includes('推进中') && page.includes('观察中') && page.includes('暂缓池'))
  check('当前合作 / 已关联合作记录仍可独立折叠',
    /activeKey=\{cooperationKeys\}/.test(page) && /activeKey=\{linkedRecordKeys\}/.test(page))
  check('「AI整理达人资料」文案保留（画像语义未变）', page.includes('AI整理达人资料') && !page.includes('AI整理备注'))
  check('已关联合作记录空态文案未变', page.includes('暂无已关联的历史合作记录'))
  check('谈价 / 报价 / outcome 区块未被本轮改动（仍在页面中）',
    page.includes('本次谈价记录') && page.includes('记录当前报价') && page.includes('关联实际投放记录'))

  console.log('\n===== 7. 状态历史 UI =====')
  check('历史入口文案为「查看历史记录」（不再是「查看历史决定」）',
    /查看历史记录（/.test(page) && !/查看历史决定/.test(page))
  check('历史列表展示 state 标签 + 时间 + note（不展示 legacy_state）',
    /WORK_STATE_LABELS\[item\.state\]/.test(page) && /item\.note/.test(page) && !/item\.legacy_state/.test(pageCode))
  check('历史只在多于 1 条时出现入口', /workStateHistory\.length > 1/.test(pageCode))
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    failCount += 1
    failures.push(`执行异常：${error?.message || error}`)
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
