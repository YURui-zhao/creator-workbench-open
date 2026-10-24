#!/usr/bin/env node
// Creator Decision Playbook V0.1 - Phase 4F-B candidate negotiation recording 回归测试
//
// 运行方式：node tests/creator_candidate_negotiation.test.js
// 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-negotiation-'))
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

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
}

async function main() {
  const blocked = []
  for (const [t, m] of [[http, 'request'], [https, 'request'], [net, 'connect'], [tls, 'connect']]) {
    t[m] = () => {
      blocked.push(m)
      throw new Error('negotiation test forbids network requests')
    }
  }
  try {
    const neg = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorNegotiationCases.js')).href
    )
    const negUtil = await import(
      pathToFileURL(path.join(root, 'backend/utils/negotiationCase.js')).href
    )
    const display = await import(
      pathToFileURL(path.join(root, 'frontend/src/utils/negotiationCaseDisplay.js')).href
    )
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

    const findHandler = (router, routePath, method) => {
      const layer = router.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const callRoute = async (handler, { body = {}, query = {}, params = {} } = {}) => {
      const res = response()
      await handler({ body, query, params, headers: {} }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }
    const postCase = findHandler(neg.default, '/', 'post')

    const insertCandidate = db.prepare("INSERT INTO creator_candidates (name, creator_type, status) VALUES (?, '科普', 'active')")
    const candA = Number(insertCandidate.run('谈价候选').lastInsertRowid)
    const candAmb1 = Number(insertCandidate.run('同名谈价候选').lastInsertRowid)
    const candAmb2 = Number(insertCandidate.run('同名谈价候选').lastInsertRowid)

    // candidate latest snapshot（提供星图刊例价，供 case 冻结 xingtu_price_snapshot）
    const snapshotId = Number(
      db
        .prepare(
          `INSERT INTO creator_recent_snapshots
             (creator, candidate_id, source_type, xingtu_price_raw, xingtu_price, plays_json,
              trend_label, stats_status, stats_version, observed_at, median_play)
           VALUES ('谈价候选', ?, 'screenshot', '¥5000', 5000, '[]', 'insufficient', 'insufficient', 'recent-performance-v1', '2026-10-03', 52000)`
        )
        .run(candA).lastInsertRowid
    )

    const insertDecision = db.prepare(
      `INSERT INTO creator_decisions
         (creator, candidate_id, decision_stage, human_decision, snapshot_id, current_quote_raw, current_quote,
          historical_evidence_json, pricing_evidence_json, target_cpm, pricing_version, system_context_version, created_at)
       VALUES (?, ?, 'post_quote', ?, ?, ?, ?, '{"has_prior_collaboration":false}', ?, 30, 'creator-playbook-postquote-v0.1', 'candidate-postquote-v0.1', '2026-10-03 12:00:00')`
    )
    const mkDecision = (creator, candidateId, human, quote) =>
      Number(
        insertDecision.run(
          creator, candidateId, human, candidateId === null ? null : snapshotId,
          quote === null ? null : String(quote), quote,
          JSON.stringify({
            playbook_estimate: { cpm_low: 15, cpm_high: 20, sponsored_median_play: 52000, estimate_low: 780, estimate_high: 1040, confidence: 'normal' },
            xingtu_price: 5000,
            high_amount_risk: false,
            historical_price_reference: { available: true, reason_code: null, target_play: 52000, selected_case_count: 3, summary: { cost_median: 1575, cost_min: 1050, cost_max: 3150, final_cpm_median: 24.65 }, selected_record_ids: [1, 2, 3] },
            current_quote: quote
          })
        ).lastInsertRowid
      )

    const decNegotiate = mkDecision('谈价候选', candA, 'negotiate', 3000)
    const decProceed = mkDecision('谈价候选', candA, 'proceed', 3000)
    const decSmallTest = mkDecision('谈价候选', candA, 'small_test', 3000)
    const decPause = mkDecision('谈价候选', candA, 'pause', 3000)
    const decZeroQuote = mkDecision('谈价候选', candA, 'negotiate', 0)
    const decAmbNeg = mkDecision('同名谈价候选', candAmb1, 'negotiate', 3000)
    // legacy（candidate_id = NULL）：旧契约保持宽松（只校验 stage）
    const legacyRepurchase = mkDecision('旧达人', null, 'repurchase', 3000)

    const caseBody = (decisionId, over = {}) => ({
      decision_id: decisionId,
      negotiated_price: '2200',
      negotiated_at: '2026-10-03',
      reason_tags: [],
      ...over
    })

    console.log('===== 1. candidate eligibility =====')
    check('candidate post_quote/negotiate 可创建 case', (await callRoute(postCase, { body: caseBody(decNegotiate) })).status === 200)
    // Negotiation Unification V0.2：谈价常常在系统外完成（谈完才回来记录），
    // 因此 candidate 的报价阶段决策（proceed / small_test / pause）也可记录已发生谈价事实。
    // P0：retrofit flow（proceed / small_test / pause）必须人工填写「谈前报价」，
    //     不能把 decision.current_quote（可能已是谈后价）自动当成谈前报价。
    check(
      'candidate proceed 可创建（V0.2 允许已发生谈价）',
      (await callRoute(postCase, { body: caseBody(decProceed, { current_quote_snapshot: 6000 }) })).status === 200
    )
    check(
      'retrofit 缺少谈前报价 → 400（P0）',
      (await callRoute(postCase, { body: caseBody(decSmallTest) })).status === 400
    )
    check(
      'candidate small_test 可创建（V0.2，带人工谈前报价）',
      (await callRoute(postCase, { body: caseBody(decSmallTest, { current_quote_snapshot: 2500 }) })).status === 200
    )
    check(
      'candidate pause 可创建（V0.2：记录已发生谈价事实，不代表推进）',
      (await callRoute(postCase, { body: caseBody(decPause, { current_quote_snapshot: 3500 }) })).status === 200
    )
    check('legacy（candidate_id=NULL）行为不变（post_quote/repurchase 仍可）', (await callRoute(postCase, { body: caseBody(legacyRepurchase) })).status === 200)

    console.log('\n===== 2. negotiated price =====')
    check('negotiated_price 必填', (await callRoute(postCase, { body: caseBody(decZeroQuote, { negotiated_price: '' }) })).status === 400)
    const zero = await callRoute(postCase, { body: caseBody(decZeroQuote, { negotiated_price: '0' }) })
    check('negotiated_price=0 合法（真实事实）', zero.status === 200 && zero.data?.negotiated_price === 0)
    const decIncrease = mkDecision('谈价候选', candA, 'negotiate', 1500)
    const increase = await callRoute(postCase, { body: caseBody(decIncrease, { negotiated_price: '1800' }) })
    check('negotiated_price > current_quote 合法（如实记录）', increase.status === 200 && increase.data?.negotiated_price === 1800)
    check('价格上涨时 quote_change_rate > 0（不是负降幅）', increase.data?.outcome?.quote_change_rate > 0, String(increase.data?.outcome?.quote_change_rate))

    console.log('\n===== 3. 派生比率（read-time，不落库） =====')
    const caseRows = db.prepare('SELECT * FROM creator_negotiation_cases WHERE decision_id = ?').get(decNegotiate)
    check('不落库 ratio 列（schema 无 xingtu_discount_ratio）', !('xingtu_discount_ratio' in caseRows))
    const d = (await callRoute(postCase, { body: caseBody(mkDecision('谈价候选', candA, 'negotiate', 3000)) })).data
    check('xingtu_discount_ratio 正确（2200/5000=0.44）', d?.outcome?.xingtu_discount_ratio === 0.44 && d?.outcome?.xingtu_discount_zhe === 4.4)
    check('initial_quote_to_xingtu_ratio 正确（3000/5000=0.6）', d?.outcome?.initial_quote_to_xingtu_ratio === 0.6)
    check('quote_retention_ratio 正确（2200/3000=0.7333）', d?.outcome?.quote_retention_ratio === 0.7333)
    check('quote_change_rate 下降（(2200-3000)/3000=-0.2667）', d?.outcome?.quote_change_rate === -0.2667)
    check('旧字段 quote_drop_rate 保留（0.2667）', d?.outcome?.quote_drop_rate === 0.2667)
    const flat = (await callRoute(postCase, { body: caseBody(mkDecision('谈价候选', candA, 'negotiate', 2000), { negotiated_price: '2000' }) })).data
    check('quote_change_rate 不变 = 0', flat?.outcome?.quote_change_rate === 0)
    check('current_quote=0 不计算比例', zero.data?.outcome?.quote_retention_ratio === null && zero.data?.outcome?.quote_change_rate === null && zero.data?.outcome?.initial_quote_to_xingtu_ratio === null)
    check('无星图价 -> xingtu_discount_ratio=null（不伪造折扣）', (() => { const r = negUtil.computeNegotiationOutcome({ negotiatedPrice: 1800, xingtuPriceSnapshot: null, currentQuoteSnapshot: 3000 }); return r.xingtu_discount_ratio === null && r.has_xingtu === false && r.quote_change_rate === -0.4 })())
    check('无星图价仍可创建 case（不要求 xingtu_price）', (await callRoute(postCase, { body: caseBody(mkDecision('谈价候选', candA, 'negotiate', 3000)) })).status === 200)

    console.log('\n===== 4. reason tags =====')
    check('新增 5 个 tag 全部合法', (await callRoute(postCase, { body: caseBody(mkDecision('谈价候选', candA, 'negotiate', 3000), { reason_tags: ['sponsored_below_organic', 'sponsored_sample_low', 'playback_volatile', 'quote_above_playbook_range', 'quote_above_history_reference'] }) })).status === 200)
    check('旧 tags 仍全部合法', (await callRoute(postCase, { body: caseBody(mkDecision('谈价候选', candA, 'negotiate', 3000), { reason_tags: ['history_performance_plain', 'budget_limited', 'long_term_cooperation', 'batch_cooperation', 'creator_price_cut', 'schedule_factor', 'other'] }) })).status === 200)
    check('未知 tag 仍被拒绝', (await callRoute(postCase, { body: caseBody(mkDecision('谈价候选', candA, 'negotiate', 3000), { reason_tags: ['not_a_tag'] }) })).status === 400)
    check('前后端 tag allowlist 一致（12 个）', JSON.stringify(display.NEGOTIATION_REASON_TAGS.map((t) => t.value)) === JSON.stringify(negUtil.NEGOTIATION_REASON_TAG_VALUES) && negUtil.NEGOTIATION_REASON_TAGS.length === 12)
    check('新 tag label 正确', display.NEGOTIATION_REASON_TAG_LABELS.sponsored_below_organic === '商单播放低于日常' && display.NEGOTIATION_REASON_TAG_LABELS.quote_above_playbook_range === '报价高于经验估价')
    check('后端 12 个 allowlist 不变', negUtil.NEGOTIATION_REASON_TAG_VALUES.length === 12 && negUtil.NEGOTIATION_REASON_TAG_VALUES.includes('history_performance_plain'))

    console.log('\n===== 4b. candidate / legacy 模式标签可见性 =====')
    const candTags = display.getNegotiationReasonTagsForMode('candidate_playbook')
    const legacyTags = display.getNegotiationReasonTagsForMode('legacy')
    check('candidate 模式隐藏 history_performance_plain', !candTags.some((t) => t.value === 'history_performance_plain') && candTags.length === 11)
    check('candidate 模式保留 long_term_cooperation 与新增 tags', candTags.some((t) => t.value === 'long_term_cooperation') && candTags.some((t) => t.value === 'quote_above_history_reference'))
    check('legacy 模式仍显示全部 12 个（含 history_performance_plain）', legacyTags.length === 12 && legacyTags.some((t) => t.value === 'history_performance_plain'))
    const modalSrc = fs.readFileSync(path.join(root, 'frontend/src/components/NegotiationCaseModal.jsx'), 'utf8')
    check('candidate 模式标题为「谈价原因 / 背景」（legacy 保留原文案）', /isCandidateMode \? '谈价原因 \/ 背景（可多选，可留空）' : '为什么能谈下来（可多选，可留空）'/.test(modalSrc))
    check('Modal 使用模式过滤后的 tag 列表', /getNegotiationReasonTagsForMode\(mode\)\.map/.test(modalSrc))
    check('reason_note / strategy_note 语义未改', /补充说明（可选）/.test(modalSrc) && /谈价依据 \/ 过程备注（可选）/.test(modalSrc))

    console.log('\n===== 5. 唯一性 / 追溯 / 改名 / 同名 =====')
    check('同一 decision 重复 case -> 409', (await callRoute(postCase, { body: caseBody(decNegotiate) })).status === 409)
    const trace = db.prepare('SELECT d.candidate_id AS cid FROM creator_negotiation_cases c JOIN creator_decisions d ON d.id = c.decision_id WHERE c.decision_id = ?').get(decNegotiate)
    check('decision_id -> candidate_id 可追溯', trace?.cid === candA)
    check('case.creator 为创建时名称快照', db.prepare('SELECT creator FROM creator_negotiation_cases WHERE decision_id = ?').get(decNegotiate).creator === '谈价候选')
    // 改名后仍按 decision_id 读取（不改写旧 case）
    db.prepare('UPDATE creator_candidates SET name = ? WHERE id = ?').run('改名后候选', candA)
    const afterRename = db.prepare('SELECT creator FROM creator_negotiation_cases WHERE decision_id = ?').get(decNegotiate)
    check('改名后 case 记录不变（仍为旧名快照）', afterRename.creator === '谈价候选')
    const amb = await callRoute(postCase, { body: caseBody(decAmbNeg, { negotiated_price: '2000' }) })
    check('同名 candidate 各自按 decision_id 记录（不串）', amb.status === 200 && db.prepare('SELECT creator FROM creator_negotiation_cases WHERE decision_id = ?').get(decAmbNeg).creator === '同名谈价候选')

    console.log('\n===== 6. 不自动产生副作用 =====')
    const decExtra = mkDecision('改名后候选', candA, 'negotiate', 2500)
    const beforeCaseCreate = db.prepare('SELECT COUNT(*) AS n FROM creator_decisions').get().n
    await callRoute(postCase, { body: caseBody(decExtra) })
    check('创建 case 不新增 / 不改写 decision', db.prepare('SELECT COUNT(*) AS n FROM creator_decisions').get().n === beforeCaseCreate)
    check('创建 case 不写 creator_records', db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n === 0)
    check('创建 case 不写 outcome', db.prepare('SELECT COUNT(*) AS n FROM creator_decision_outcomes').get().n === 0)
    check('negotiated_price 绝不回填 actual_cost（无 record）', db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n === 0)

    console.log('\n===== 7. CreatorPlaybook UI（源码级） =====')
    const page = fs.readFileSync(path.join(root, 'frontend/src/pages/CreatorPlaybook/index.jsx'), 'utf8')
    // Negotiation Unification V0.2：candidate 谈价统一走共享谈价经验表单（同一领域模型），
    // 旧的 NegotiationCaseModal 仅保留给 legacy Radar 决策抽屉。
    check('引入统一谈价经验 Modal', /<CandidateNegotiationExperienceModal/.test(page))
    // Semantic Duplicate V0.2：已有谈价经验（live case 或 outcome-linked 历史补录）时不再提供记录入口
    check(
      '最新 post_quote 可记录本次谈价（无任何已有谈价记录时）',
      /canRecordNegotiationExperience && !existingNegotiationExperience/.test(page) &&
        /记录本次谈价/.test(page)
    )
    check(
      'V0.2 允许 negotiate / proceed / small_test / pause（不再只限 negotiate）',
      /const negotiationCapturableDecisions = \['negotiate', 'proceed', 'small_test', 'pause'\]/.test(page) &&
        /negotiationCapturableDecisions\.includes\(latestPostQuoteDecision\.human_decision\)/.test(page)
    )
    check('谈价结果展示事实：初始报价 / 谈后价格 / 星图刊例 / 折扣', /初始报价：/.test(page) && /谈后价格：/.test(page) && /谈后价约为星图/.test(page))
    check('下降显示下降 X%（不出现负降幅）', /下降 \$\{\(Math\.abs\(latestNegotiationCase\.outcome\.quote_change_rate\) \* 100\)\.toFixed\(1\)\}%/.test(page) && /上升 \$\{\(latestNegotiationCase\.outcome\.quote_change_rate \* 100\)\.toFixed\(1\)\}%/.test(page))
    check('无星图价显示「暂无」', /星图刊例：[\s\S]{0,300}'暂无'/.test(page))
    check('「以谈后价继续判断」预填 negotiated_price', /以谈后价继续判断/.test(page) && /openPostQuote\(String\(latestNegotiationCase\.negotiated_price\)\)/.test(page))
    check('报价 Modal 不默认选中 human_decision（openPostQuote 重置为 null）', /setPostQuoteDecision\(null\)/.test(page))
    check(
      'candidate 谈价不留 CPM30 体系（统一 Modal 走 Playbook / 决策上下文）',
      /<CandidateNegotiationExperienceModal/.test(page) &&
        !/CPM30目标价/.test(page) &&
        !/<NegotiationCaseModal/.test(page)
    )
    check('未发生任何外部网络请求', blocked.length === 0, JSON.stringify(blocked))
    check('隔离库位于临时目录', process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir()))
  } finally {
    /* no-op */
  }
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    process.exitCode = 1
  })
  .finally(() => {
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
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
