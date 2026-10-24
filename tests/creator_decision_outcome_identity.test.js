#!/usr/bin/env node
// Creator Decision Playbook V0.1 - Phase 4C candidate-aware outcome identity 回归测试
//
// 运行方式：node tests/creator_decision_outcome_identity.test.js
// 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
// 网络：拦截 http/https/net/tls/fetch —— 本能力纯确定性，不调用 AI、不访问网络。
//
// 覆盖：evaluateOutcomeIdentity 纯函数（旧达人 / candidate / 改名 / 跨名称人工确认 / 无 fuzzy），
//       以及 outcome POST/GET 路由的 candidate-aware 身份接入、identity 与 timing 两个独立确认、
//       UNIQUE 约束、不改写 decision / record / candidate、candidate_id 可追溯。

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-identity-'))
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
  const replacements = [
    [http, 'request'], [https, 'request'], [net, 'connect'], [tls, 'connect']
  ]
  const originals = replacements.map(([t, m]) => [t, m, t[m]])
  for (const [t, m] of replacements) {
    t[m] = () => {
      blocked.push(m)
      throw new Error('identity test forbids network requests')
    }
  }

  try {
    const outcomes = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorDecisionOutcomes.js')).href
    )
    const identityUtil = await import(
      pathToFileURL(path.join(root, 'backend/utils/creatorDecisionOutcome.js')).href
    )
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default
    const { evaluateOutcomeIdentity } = identityUtil

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

    const evalIdentity = (args) => evaluateOutcomeIdentity(args)

    console.log('===== 1. 纯函数：旧达人路径 =====')
    check('legacy 名称相同 -> pass', (() => { const r = evalIdentity({ candidateId: null, frozenCreator: '旧达人', recordNickname: '旧达人', recordId: 1 }); return r.ok === true && r.mode === 'legacy_exact_name' })())
    check('legacy 名称不同 + 未确认 -> reject（400）', (() => { const r = evalIdentity({ candidateId: null, frozenCreator: '旧达人', recordNickname: '别的', recordId: 1, identityConfirmed: false }); return r.ok === false && r.code === 400 && !r.requiresIdentityConfirmation })())
    check('legacy 名称不同 + identityConfirmed=true -> 仍 reject（flag 对旧达人无效）', (() => { const r = evalIdentity({ candidateId: null, frozenCreator: '旧达人', recordNickname: '别的', recordId: 1, identityConfirmed: true }); return r.ok === false && r.code === 400 })())

    console.log('\n===== 2. 纯函数：candidate 路径 =====')
    check('candidate 当前名一致 -> pass', (() => { const r = evalIdentity({ candidateId: 1, candidateName: '新名', frozenCreator: '旧名', recordNickname: '新名', recordId: 2 }); return r.ok === true && r.mode === 'candidate_current_name' })())
    check('candidate 改名：frozen 旧名 / 当前新名 / record 新名 -> pass（不要求匹配 frozen）', (() => { const r = evalIdentity({ candidateId: 1, candidateName: '新名', frozenCreator: '旧名', recordNickname: '新名', recordId: 2 }); return r.ok === true })())
    check('candidate 名称不同 + 未确认 -> 409 + requiresIdentityConfirmation', (() => { const r = evalIdentity({ candidateId: 1, candidateName: '新名', frozenCreator: '旧名', recordNickname: '别的名字', recordId: 3, identityConfirmed: false }); return r.ok === false && r.code === 409 && r.requiresIdentityConfirmation === true })())
    check('candidate 名称不同 + identityConfirmed=true -> pass', (() => { const r = evalIdentity({ candidateId: 1, candidateName: '新名', frozenCreator: '旧名', recordNickname: '别的名字', recordId: 3, identityConfirmed: true }); return r.ok === true && r.requiresIdentityConfirmation === true })())
    check('不做 fuzzy / 大小写归并（ABC != abc）', evalIdentity({ candidateId: 1, candidateName: 'abc', frozenCreator: 'x', recordNickname: 'ABC', recordId: 4, identityConfirmed: false }).ok === false)
    check('仅裁剪首尾空白（" abc " 视为 abc）', evalIdentity({ candidateId: 1, candidateName: 'abc', frozenCreator: 'x', recordNickname: ' abc ', recordId: 4 }).ok === true)

    console.log('\n===== 2b. 纯函数：同名歧义（candidateNameAmbiguous） =====')
    check('名称唯一 + 一致 -> 直接 pass（不要求确认）', evalIdentity({ candidateId: 1, candidateName: '同名达人', frozenCreator: 'x', recordNickname: '同名达人', recordId: 5, candidateNameAmbiguous: false }).ok === true)
    check('名称重复 + 一致 -> 409（不能静默通过）', (() => { const r = evalIdentity({ candidateId: 1, candidateName: '同名达人', frozenCreator: 'x', recordNickname: '同名达人', recordId: 5, candidateNameAmbiguous: true }); return r.ok === false && r.code === 409 && r.requiresIdentityConfirmation === true && r.ambiguousName === true })())
    check('名称重复 + 一致 + identityConfirmed=true -> pass', (() => { const r = evalIdentity({ candidateId: 1, candidateName: '同名达人', frozenCreator: 'x', recordNickname: '同名达人', recordId: 5, candidateNameAmbiguous: true, identityConfirmed: true }); return r.ok === true })())
    check('旧达人忽略 candidateNameAmbiguous（仍按名称严格判定）', (() => { const r = evalIdentity({ candidateId: null, frozenCreator: '旧达人', recordNickname: '旧达人', recordId: 5, candidateNameAmbiguous: true }); return r.ok === true && r.mode === 'legacy_exact_name' })())

    // ---------- 路由集成（临时库） ----------
    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES ('2026-W40', ?, '科普', 1000, ?, 30000, 30000)`
    )
    const addRecord = (nickname, publishDate) =>
      Number(insertRecord.run(nickname, publishDate).lastInsertRowid)
    const recOld = addRecord('旧达人', '2026-10-05')
    const recOther = addRecord('其他达人', '2026-10-05')
    const recSame = addRecord('同名候选', '2026-10-05')
    const recUnique = addRecord('唯一候选', '2026-10-05')
    const recNew = addRecord('新名字', '2026-10-05')
    const recOldName = addRecord('旧候选名', '2026-10-05')
    const recElse = addRecord('别的名字', '2026-10-05')
    const recTimingSame = addRecord('新名字', '2020-01-01') // 发布日期早于 decision.created_at
    const recTimingElse = addRecord('别的名字', '2020-01-01')

    const insertCandidate = db.prepare(
      "INSERT INTO creator_candidates (name, creator_type, status) VALUES (?, '科普', 'active')"
    )
    const candA = Number(insertCandidate.run('同名候选').lastInsertRowid)
    const candB = Number(insertCandidate.run('同名候选').lastInsertRowid)
    const candU = Number(insertCandidate.run('唯一候选').lastInsertRowid)
    const candR = Number(insertCandidate.run('旧候选名').lastInsertRowid)

    const insertDecision = db.prepare(
      `INSERT INTO creator_decisions
         (creator, candidate_id, decision_stage, human_decision, historical_evidence_json, target_cpm, pricing_version, system_context_version, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const mkDecision = (creator, candidateId, stage, decision, createdAt) =>
      Number(
        insertDecision.run(
          creator, candidateId, stage, decision, JSON.stringify({ has_prior_collaboration: false }), 30, 'creator-playbook-pricing-v0.1', 'candidate-review-v0.1', createdAt, createdAt.slice(0, 10)
        ).lastInsertRowid
      )
    const DECISION_AT = '2026-10-03 12:00:00'
    const decLegacy = mkDecision('旧达人', null, 'post_quote', 'repurchase', DECISION_AT)
    // Phase 4D：candidate 的 post_quote 合法决策集为 proceed / small_test（repurchase 属旧历史达人）
    const decA = mkDecision('同名候选', candA, 'post_quote', 'proceed', DECISION_AT)
    const decB = mkDecision('同名候选', candB, 'post_quote', 'proceed', DECISION_AT)
    const decR = mkDecision('旧候选名', candR, 'post_quote', 'proceed', DECISION_AT)
    const decCandidateReview = mkDecision('同名候选', candA, 'candidate_review', 'contact', DECISION_AT)

    console.log('\n===== 3. 路由：eligibility 不放宽 =====')
    const reviewLink = await callRoute(postOutcome, { params: { id: String(decCandidateReview) }, body: { record_id: recSame } })
    check('candidate_review/contact 仍不可 link outcome（400 未进入实际投放阶段）', reviewLink.status === 400 && /未进入实际投放阶段/.test(String(reviewLink.msg)), reviewLink.msg)

    console.log('\n===== 4. 路由：旧达人路径（完全不变） =====')
    const legacyOk = await callRoute(postOutcome, { params: { id: String(decLegacy) }, body: { record_id: recOld } })
    check('旧达人 名称相同 -> link 成功', legacyOk.status === 200 && legacyOk.data?.outcome?.record_id === recOld)
    const legacyMismatch = await callRoute(postOutcome, { params: { id: String(decLegacy) }, body: { record_id: recOther, identity_confirmed: true } })
    check('旧达人 名称不同 -> 400（identity_confirmed 无法绕过）', legacyMismatch.status === 400 && !legacyMismatch.data?.requires_identity_confirmation)

    console.log('\n===== 5. 路由：candidate 身份 =====')
    // 名称唯一 + nickname 相同 -> 直接通过（无需人工确认）
    const decUnique = mkDecision('唯一候选', candU, 'post_quote', 'small_test', DECISION_AT)
    const uniqueOk = await callRoute(postOutcome, { params: { id: String(decUnique) }, body: { record_id: recUnique } })
    check('candidate 名称唯一 + nickname 相同 -> identity 直接通过（无需确认）', uniqueOk.status === 200 && uniqueOk.data?.outcome?.record_id === recUnique)

    // 同名候选歧义：名称一致也不能静默通过
    const decNew = mkDecision('同名候选', candA, 'post_quote', 'small_test', DECISION_AT)
    const ambiguousNoConfirm = await callRoute(postOutcome, { params: { id: String(decNew) }, body: { record_id: recSame } })
    check('同名 candidate + nickname 相同 -> 409 + requires_identity_confirmation', ambiguousNoConfirm.status === 409 && ambiguousNoConfirm.data?.requires_identity_confirmation === true, ambiguousNoConfirm.msg)
    const ambiguousConfirmed = await callRoute(postOutcome, { params: { id: String(decNew) }, body: { record_id: recSame, identity_confirmed: true } })
    check('同名歧义 + identity_confirmed=true -> identity 通过', ambiguousConfirmed.status === 200 && ambiguousConfirmed.data?.outcome?.record_id === recSame)
    // 另一个同名 candidate（B）同样不能被自动归属：名称一致也必须显式确认
    // （identity 校验在 UNIQUE 检查之前，因此这里返回的是歧义标记而非 409 重复关联）
    const decBAmbig = mkDecision('同名候选', candB, 'post_quote', 'proceed', DECISION_AT)
    const bAmbig = await callRoute(postOutcome, { params: { id: String(decBAmbig) }, body: { record_id: recSame } })
    check('同名 candidate B 不自动归属（409 + 需人工确认）', bAmbig.status === 409 && bAmbig.data?.requires_identity_confirmation === true)

    // 改名场景：candidate 当前 name = 新名字；decision.creator = 旧候选名；record = 新名字
    db.prepare('UPDATE creator_candidates SET name = ? WHERE id = ?').run('新名字', candR)
    const renameLink = await callRoute(postOutcome, { params: { id: String(decR) }, body: { record_id: recNew } })
    check('candidate 改名后（frozen 旧名 / record 新名）-> identity 通过', renameLink.status === 200 && renameLink.data?.outcome?.record_id === recNew)

    const candMismatchDec = mkDecision('旧候选名', candR, 'post_quote', 'proceed', DECISION_AT)
    const mismatchNoConfirm = await callRoute(postOutcome, { params: { id: String(candMismatchDec) }, body: { record_id: recElse } })
    check('candidate 名称不同 + 未确认 -> 409 + requires_identity_confirmation', mismatchNoConfirm.status === 409 && mismatchNoConfirm.data?.requires_identity_confirmation === true)
    const mismatchConfirmed = await callRoute(postOutcome, { params: { id: String(candMismatchDec) }, body: { record_id: recElse, identity_confirmed: true } })
    check('candidate 名称不同 + identity_confirmed=true -> identity 通过', mismatchConfirmed.status === 200 && mismatchConfirmed.data?.outcome?.record_id === recElse)

    console.log('\n===== 6. identity / timing 两个独立确认 =====')
    const decTiming = mkDecision('旧候选名', candR, 'post_quote', 'proceed', DECISION_AT)
    const timingOnly = await callRoute(postOutcome, { params: { id: String(decTiming) }, body: { record_id: recTimingSame } })
    check('仅 timing 问题：identity 通过但需 timing_confirmed', timingOnly.status === 400 && /timing_confirmed/.test(String(timingOnly.msg)))
    const decBoth = mkDecision('旧候选名', candR, 'post_quote', 'proceed', DECISION_AT)
    const bothIdentityOnly = await callRoute(postOutcome, { params: { id: String(decBoth) }, body: { record_id: recTimingElse, identity_confirmed: true } })
    check('identity+timing 同时需要：只 identity=true -> 仍失败', bothIdentityOnly.status === 400 && /timing_confirmed/.test(String(bothIdentityOnly.msg)))
    const bothTimingOnly = await callRoute(postOutcome, { params: { id: String(decBoth) }, body: { record_id: recTimingElse, timing_confirmed: true } })
    check('identity+timing 同时需要：只 timing=true -> 仍失败（409）', bothTimingOnly.status === 409 && bothTimingOnly.data?.requires_identity_confirmation === true)
    const bothConfirmed = await callRoute(postOutcome, { params: { id: String(decBoth) }, body: { record_id: recTimingElse, identity_confirmed: true, timing_confirmed: true } })
    check('identity+timing 都确认 -> 成功', bothConfirmed.status === 200 && bothConfirmed.data?.outcome?.record_id === recTimingElse)

    console.log('\n===== 7. UNIQUE / 不改写事实 =====')
    const beforeDecision = JSON.stringify(db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(decNew))
    const beforeRecord = JSON.stringify(db.prepare('SELECT * FROM creator_records WHERE id = ?').get(recSame))
    const beforeCandidate = JSON.stringify(db.prepare('SELECT * FROM creator_candidates WHERE id = ?').get(candA))
    const dupDecision = await callRoute(postOutcome, { params: { id: String(decNew) }, body: { record_id: recNew } })
    check('UNIQUE(decision_id)：同一 decision 再次关联 -> 409', dupDecision.status === 409)
    const decOtherForRec = mkDecision('同名候选', candB, 'post_quote', 'proceed', DECISION_AT)
    const dupRecord = await callRoute(postOutcome, { params: { id: String(decOtherForRec) }, body: { record_id: recSame } })
    check('UNIQUE(record_id)：同一 record 关联第二个 decision -> 409', dupRecord.status === 409)
    check('不 UPDATE creator_decisions', JSON.stringify(db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(decNew)) === beforeDecision)
    check('不 UPDATE creator_records', JSON.stringify(db.prepare('SELECT * FROM creator_records WHERE id = ?').get(recSame)) === beforeRecord)
    check('不自动改 candidate.name', JSON.stringify(db.prepare('SELECT * FROM creator_candidates WHERE id = ?').get(candA)) === beforeCandidate)

    console.log('\n===== 8. 追溯 / 同名不串 / pool 查询 =====')
    const traceRow = db
      .prepare(
        `SELECT d.candidate_id AS cid FROM creator_decision_outcomes o
         JOIN creator_decisions d ON d.id = o.decision_id WHERE o.decision_id = ?`
      )
      .get(decNew)
    check('outcome -> decision_id -> decision.candidate_id 可追溯', traceRow?.cid === candA)
    const traceRowB = db
      .prepare(
        `SELECT d.candidate_id AS cid FROM creator_decision_outcomes o
         JOIN creator_decisions d ON d.id = o.decision_id WHERE o.decision_id = ?`
      )
      .get(candMismatchDec)
    check('同名 candidate 的 linkage 各归其主（B 场景追溯到 candR）', traceRowB?.cid === candR && traceRowB.cid !== candA)
    const poolR = await callRoute(outcomeCandidates, { params: { id: String(decR) } })
    const poolRNicks = (poolR.data?.candidates || []).map((c) => c.creator)
    check('改名后 outcome-candidates 同时发现「当前名」与「frozen 名」记录', poolRNicks.includes('新名字') && poolRNicks.includes('旧候选名'), JSON.stringify(poolRNicks))
    const poolRIds = (poolR.data?.candidates || []).map((c) => c.record_id)
    check('record id 去重稳定（无重复）', new Set(poolRIds).size === poolRIds.length)
    const srcOf = (nick) => (poolR.data?.candidates || []).find((c) => c.creator === nick)?.identity_name_source
    check('metadata 区分 current / frozen', srcOf('新名字') === 'current' && srcOf('旧候选名') === 'frozen')
    check('metadata 不表示已确认身份（仅来源说明）', !/confirmed|verified|same_creator/i.test(JSON.stringify(poolR.data?.candidates?.[0] || {})))
    // current === frozen -> 只查一次，不重复
    const decSameName = mkDecision('同名候选', candA, 'post_quote', 'proceed', DECISION_AT)
    const poolSame = await callRoute(outcomeCandidates, { params: { id: String(decSameName) } })
    const sameIds = (poolSame.data?.candidates || []).map((c) => c.record_id)
    check('current === frozen 时不重复返回记录', new Set(sameIds).size === sameIds.length && sameIds.every((id) => id === recSame))
    check('current === frozen -> metadata = both', (poolSame.data?.candidates || []).every((c) => c.identity_name_source === 'both'))
    // 旧达人 pool 行为不变（无 metadata 字段，且只含自己的记录）
    const poolLegacy = await callRoute(outcomeCandidates, { params: { id: String(decLegacy) } })
    check('旧达人 pool 行为不变（只含旧达人记录、无 metadata 字段）', poolLegacy.data?.candidates?.every((c) => c.creator === '旧达人' && !('identity_name_source' in c)))
    // 出现在 pool 中并不绕过 POST identity guard
    const decFromPool = mkDecision('旧候选名', candR, 'post_quote', 'proceed', DECISION_AT)
    const fromPool = await callRoute(postOutcome, { params: { id: String(decFromPool) }, body: { record_id: recOldName } })
    check('出现在候选池中仍不绕过身份 guard（frozen-only 名称 -> 409）', fromPool.status === 409 && fromPool.data?.requires_identity_confirmation === true)
    check('未发生任何外部网络请求', blocked.length === 0, JSON.stringify(blocked))
    check('隔离库位于临时目录（未触碰真实 workbench.db）', process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir()))
  } finally {
    for (const [t, m, orig] of originals) t[m] = orig
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
      // 清理失败不影响测试结论
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
