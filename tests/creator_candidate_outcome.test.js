#!/usr/bin/env node
// Creator Decision Playbook V0.1 - Phase 4E candidate outcome linking + audit evidence 回归测试
//
// 运行方式：node tests/creator_candidate_outcome.test.js
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
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-outcome-'))
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
      throw new Error('outcome audit test forbids network requests')
    }
  }
  try {
    const outcomes = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorDecisionOutcomes.js')).href
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
    const postOutcome = findHandler(outcomes.default, '/:id/outcome', 'post')
    const outcomeCandidates = findHandler(outcomes.default, '/:id/outcome-candidates', 'get')

    // schema
    check('creator_decision_outcomes 新增 link_evidence_json', db.prepare('PRAGMA table_info(creator_decision_outcomes)').all().some((c) => c.name === 'link_evidence_json'))

    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES ('2026-W40', ?, '科普', ?, ?, ?, ?)`
    )
    const addRecord = (nickname, cost, publishDate, first, latest) =>
      Number(insertRecord.run(nickname, cost, publishDate, first, latest).lastInsertRowid)

    const recLegacy = addRecord('旧达人', 2000, '2026-10-05', 30000, 50000)
    const recA = addRecord('候选甲', 1500, '2026-10-05', 40000, 60000)
    const recAMismatch = addRecord('别的名字', 1200, '2026-10-05', 30000, 50000)
    const recATiming = addRecord('别的名字', 900, '2020-01-01', 30000, 45000)
    const recAmbiguous = addRecord('同名候选', 800, '2026-10-05', 20000, 40000)
    const recAmbiguousTiming = addRecord('同名候选', 700, '2020-01-01', 20000, 40000)
    const recIdle = addRecord('无人区', 100, '2026-10-05', 10000, 20000)
    // 每个 decision 需要独立的 record（UNIQUE(record_id)）
    const recIdentityUnneeded = addRecord('候选甲', 1400, '2026-10-05', 40000, 60000)
    const recTimingUnneeded = addRecord('候选甲', 1400, '2026-10-05', 40000, 60000)
    const recTimingInPool = addRecord('候选甲', 1300, '2020-01-01', 40000, 60000) // 同属候选甲，但发布日期早于决策

    const insertCandidate = db.prepare("INSERT INTO creator_candidates (name, creator_type, status) VALUES (?, '科普', 'active')")
    const candA = Number(insertCandidate.run('候选甲').lastInsertRowid)
    const candAmb1 = Number(insertCandidate.run('同名候选').lastInsertRowid)
    const candAmb2 = Number(insertCandidate.run('同名候选').lastInsertRowid)

    const insertDecision = db.prepare(
      `INSERT INTO creator_decisions
         (creator, candidate_id, decision_stage, human_decision, historical_evidence_json, target_cpm, pricing_version, system_context_version, created_at, decided_at)
       VALUES (?, ?, ?, ?, '{"has_prior_collaboration":false}', 30, 'creator-playbook-postquote-v0.1', 'candidate-postquote-v0.1', ?, ?)`
    )
    const mkDecision = (creator, candidateId, stage, decision, createdAt) =>
      Number(insertDecision.run(creator, candidateId, stage, decision, createdAt, createdAt.slice(0, 10)).lastInsertRowid)
    const AT = '2026-10-03 12:00:00'

    const decLegacy = mkDecision('旧达人', null, 'post_quote', 'repurchase', AT)
    const decA = mkDecision('候选甲', candA, 'post_quote', 'proceed', AT)
    const decAMismatch = mkDecision('候选甲', candA, 'post_quote', 'proceed', AT)
    const decATiming = mkDecision('候选甲', candA, 'post_quote', 'proceed', AT)
    const decAOverrideUnneeded = mkDecision('候选甲', candA, 'post_quote', 'proceed', AT)
    const decATimingUnneeded = mkDecision('候选甲', candA, 'post_quote', 'proceed', AT)
    const decAmbiguity = mkDecision('同名候选', candAmb1, 'post_quote', 'proceed', AT)
    const decAmbBoth = mkDecision('同名候选', candAmb2, 'post_quote', 'small_test', AT)
    const decIdle = mkDecision('无人区', null, 'post_quote', 'repurchase', AT) // 供旧 outcome（无 evidence）读取

    const evidenceOf = (decisionId) => {
      const row = db.prepare('SELECT link_evidence_json FROM creator_decision_outcomes WHERE decision_id = ?').get(decisionId)
      return row ? JSON.parse(row.link_evidence_json) : null
    }

    console.log('===== 1. identity evidence =====')
    const legacy = await callRoute(postOutcome, { params: { id: String(decLegacy) }, body: { record_id: recLegacy } })
    check('legacy exact name -> legacy_exact_name / override=false', legacy.status === 200 && evidenceOf(decLegacy).identity.mode === 'legacy_exact_name' && evidenceOf(decLegacy).identity.override_used === false, JSON.stringify(evidenceOf(decLegacy)?.identity))
    const exact = await callRoute(postOutcome, { params: { id: String(decA) }, body: { record_id: recA } })
    check('candidate current name exact -> candidate_current_name / override=false', exact.status === 200 && evidenceOf(decA).identity.mode === 'candidate_current_name' && evidenceOf(decA).identity.override_used === false)
    const mismatch = await callRoute(postOutcome, { params: { id: String(decAMismatch) }, body: { record_id: recAMismatch, identity_confirmed: true } })
    check('candidate mismatch + confirmed -> candidate_identity_override / override=true', mismatch.status === 200 && evidenceOf(decAMismatch).identity.mode === 'candidate_identity_override' && evidenceOf(decAMismatch).identity.override_used === true)
    check('mismatch evidence 记录 name_match=false / confirmation_required=true', evidenceOf(decAMismatch).identity.name_match === false && evidenceOf(decAMismatch).identity.confirmation_required === true && evidenceOf(decAMismatch).identity.confirmation_provided === true)
    const amb = await callRoute(postOutcome, { params: { id: String(decAmbiguity) }, body: { record_id: recAmbiguous, identity_confirmed: true } })
    check('同名歧义 + confirmed -> override=true + candidate_name_ambiguous=true', amb.status === 200 && evidenceOf(decAmbiguity).identity.override_used === true && evidenceOf(decAmbiguity).identity.candidate_name_ambiguous === true && evidenceOf(decAmbiguity).identity.name_match === true)
    const unneeded = await callRoute(postOutcome, { params: { id: String(decAOverrideUnneeded) }, body: { record_id: recIdentityUnneeded, identity_confirmed: true } })
    check(
      '本来无需确认但传 identity_confirmed=true -> provided=true 但 override_used=false',
      unneeded.status === 200 &&
        evidenceOf(decAOverrideUnneeded).identity.confirmation_required === false &&
        evidenceOf(decAOverrideUnneeded).identity.confirmation_provided === true &&
        evidenceOf(decAOverrideUnneeded).identity.override_used === false,
      JSON.stringify(evidenceOf(decAOverrideUnneeded)?.identity)
    )

    console.log('\n===== 2. timing evidence =====')
    const timingUnneeded = await callRoute(postOutcome, { params: { id: String(decATimingUnneeded) }, body: { record_id: recTimingUnneeded, timing_confirmed: true } })
    check(
      'timing 本不需要 + 传 true -> provided=true / override_used=false',
      timingUnneeded.status === 200 &&
        evidenceOf(decATimingUnneeded).timing.confirmation_required === false &&
        evidenceOf(decATimingUnneeded).timing.confirmation_provided === true &&
        evidenceOf(decATimingUnneeded).timing.override_used === false,
      JSON.stringify(evidenceOf(decATimingUnneeded)?.timing)
    )
    const timingNeeded = await callRoute(postOutcome, { params: { id: String(decATiming) }, body: { record_id: recATiming, identity_confirmed: true, timing_confirmed: true } })
    check('timing 需要 + confirmed -> override_used=true', timingNeeded.status === 200 && evidenceOf(decATiming).timing.override_used === true && evidenceOf(decATiming).timing.confirmation_required === true)
    const both = await callRoute(postOutcome, { params: { id: String(decAmbBoth) }, body: { record_id: recAmbiguousTiming, identity_confirmed: true, timing_confirmed: true } })
    check('identity+timing 都发生 -> 两套 evidence 分别正确', both.status === 200 && evidenceOf(decAmbBoth).identity.override_used === true && evidenceOf(decAmbBoth).timing.override_used === true)

    console.log('\n===== 3. 旧 outcome / public response =====')
    // 旧 outcome（无 evidence）：直接插入一条 raw 行，验证可正常读取且 link_evidence = null
    const legacyLinkId = Number(
      db.prepare('INSERT INTO creator_decision_outcomes (decision_id, record_id) VALUES (?, ?)').run(decIdle, recIdle).lastInsertRowid
    )
    const legacyGet = findHandler(
      (await import(pathToFileURL(path.join(root, 'backend/routes/creatorDecisions.js')).href)).default,
      '/',
      'get'
    )
    const legacyList = await callRoute(legacyGet, { query: { creator: '无人区' } })
    const legacyOutcome = legacyList.data?.decisions?.[0]?.outcome || null
    check('旧 outcome（link_evidence_json = NULL）正常读取', legacyOutcome?.link_id === legacyLinkId && legacyOutcome?.link_evidence === null, JSON.stringify(legacyOutcome))
    check('public response 返回 parsed link_evidence（非 raw string）', typeof legacyOutcome?.link_evidence !== 'string')
    const candidateListHandler = findHandler(
      (await import(pathToFileURL(path.join(root, 'backend/routes/creatorCandidates.js')).href)).default,
      '/:id/decisions',
      'get'
    )
    const candList = await callRoute(candidateListHandler, { params: { id: String(candA) } })
    const linkedOutcome = candList.data?.decisions?.find((d) => d.id === decA)?.outcome || null
    check('candidate GET decisions 附带 parsed link_evidence', typeof linkedOutcome?.link_evidence === 'object' && linkedOutcome?.link_evidence?.version === 'outcome-link-v0.1')
    check('link evidence identity 冻结候选人名与记录名', linkedOutcome?.link_evidence?.identity?.candidate_name_at_link === '候选甲' && linkedOutcome?.link_evidence?.identity?.record_nickname === '候选甲')

    console.log('\n===== 4. outcome-candidates 预检查 metadata（只提示，不授权） =====')
    const precheck = await callRoute(outcomeCandidates, { params: { id: String(decAmbiguity) } })
    const ambRecord = (precheck.data?.candidates || []).find((c) => c.record_id === recAmbiguous)
    check('同名歧义记录 -> requires_identity_confirmation + reason=ambiguous_name', ambRecord?.requires_identity_confirmation === true && ambRecord?.identity_reason === 'ambiguous_name')
    check('timing 预检查字段存在', ambRecord && 'requires_timing_confirmation' in ambRecord && 'timing_reason' in ambRecord)
    const timingPrecheck = await callRoute(outcomeCandidates, { params: { id: String(decATiming) } })
    const timingRecord = (timingPrecheck.data?.candidates || []).find((c) => c.record_id === recTimingInPool)
    check('timing 需要时 -> requires_timing_confirmation + reason=publish_before_decision', timingRecord?.requires_timing_confirmation === true && timingRecord?.timing_reason === 'publish_before_decision')
    check('未发生任何外部网络请求', blocked.length === 0, JSON.stringify(blocked))
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
