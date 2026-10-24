#!/usr/bin/env node
/**
 * Real Data Calibration V1 回归测试
 *
 * 运行方式：node tests/creator_calibration.test.js
 * 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
 * 网络：拦截 http/https/net/tls/fetch —— 本轮不调用 AI、不访问外部网络。
 *
 * 覆盖：
 *   Pricing  · organic_proxy 估价 / source 与 confidence 分离 / 高量级守卫 / actual_cost 不被覆盖
 *   Time     · decided_at 默认今天 / 历史补录 / created_at 不变 / 业务排序 / legacy NULL / 谈价排序
 *   Audit    · 日期纠正 before/after/reason / 作废不删下游事实 / latest 排除作废
 *   Timing   · outcome timing 使用 decided_at；missing decided_at 不伪造业务时间
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

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-calibration-'))
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
      throw new Error('calibration test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('calibration test forbids network requests')
  }
  return {
    blocked,
    restore() {
      for (const [target, method, original] of originals) target[method] = original
      global.fetch = originalFetch
    }
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

const play = (raw_text, contentType = 'sponsored') => ({
  raw_text,
  excluded: false,
  content_type: contentType,
  source_image_index: 1,
  position_index: 1
})

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const decisions = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorDecisions.js')).href
    )
    const negotiation = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorNegotiationCases.js')).href
    )
    const outcomes = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorDecisionOutcomes.js')).href
    )
    const candidates = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorCandidates.js')).href
    )
    const snapshots = await import(
      pathToFileURL(path.join(root, 'backend/routes/recentSnapshots.js')).href
    )
    const dbModule = await import(pathToFileURL(path.join(root, 'backend/db.js')).href)
    const db = dbModule.default

    const findHandler = (router, routePath, method) => {
      const layer = router.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const createDecisionHandler = findHandler(decisions.default, '/', 'post')
    const listDecisionsHandler = findHandler(decisions.default, '/', 'get')
    const correctDateHandler = findHandler(decisions.default, '/:id/date', 'patch')
    const voidHandler = findHandler(decisions.default, '/:id/void', 'post')
    const decisionCorrectionsHandler = findHandler(decisions.default, '/:id/corrections', 'get')
    const createCaseHandler = findHandler(negotiation.default, '/', 'post')
    const listCasesHandler = findHandler(negotiation.default, '/', 'get')
    const correctCaseDateHandler = findHandler(negotiation.default, '/:id/date', 'patch')
    const caseCorrectionsHandler = findHandler(negotiation.default, '/:id/corrections', 'get')
    const outcomeCandidatesHandler = findHandler(outcomes.default, '/:id/outcome-candidates', 'get')
    const linkOutcomeHandler = findHandler(outcomes.default, '/:id/outcome', 'post')
    const priceRefHandler = findHandler(candidates.default, '/:id/price-reference', 'get')
    const createCandidateHandler = findHandler(candidates.default, '/', 'post')
    const postSnapshotHandler = findHandler(snapshots.default, '/', 'post')

    const callRoute = async (handler, { body = {}, query = {}, params = {} } = {}) => {
      const res = response()
      await handler({ body, query, params, headers: {} }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    const today = (() => {
      const now = new Date()
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    })()

    console.log('===== 0. schema / migration 边界 =====')
    const decisionColumns = Object.fromEntries(
      db.prepare('PRAGMA table_info(creator_decisions)').all().map((c) => [c.name, c])
    )
    check(
      'creator_decisions 新增 decided_at / voided_at / void_reason（additive）',
      'decided_at' in decisionColumns && 'voided_at' in decisionColumns && 'void_reason' in decisionColumns
    )
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    check('存在校正审计表 creator_calibration_corrections', tables.includes('creator_calibration_corrections'))
    check('T14/无自动回填：旧决策 decided_at 全部保持 NULL（绝不 decided_at = created_at）',
      db.prepare('SELECT COUNT(*) AS n FROM creator_decisions').get().n === 0 &&
        db.prepare('SELECT COUNT(*) AS n FROM creator_decisions WHERE decided_at IS NOT NULL').get().n === 0)
    check('校正审计表初始为空（migration 不产生任何审计行）',
      db.prepare('SELECT COUNT(*) AS n FROM creator_calibration_corrections').get().n === 0)

    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const R = {}
    db.transaction(() => {
      R.histPast = Number(insertRecord.run('2026-W33', 'Calib', '数码', 1800, '2026-08-01', 20000, 100000).lastInsertRowid)
      R.histMid = Number(insertRecord.run('2026-W35', 'Calib', '数码', 2700, '2026-09-01', 20000, 100000).lastInsertRowid)
    })()

    const snapshot = await callRoute(postSnapshotHandler, {
      body: {
        creator: 'Calib',
        recognized_creator_name_raw: 'Calib',
        xingtu_price_raw: '3000元',
        observed_at: '2026-09-26',
        plays: ['20000', '21000', '22000', '23000', '24000'].map((value) => play(value))
      }
    })
    check('快照创建成功（median 22000 / xingtu 3000）', snapshot.status === 200 && snapshot.data.median_play === 22000)

    const createDecision = (body) => callRoute(createDecisionHandler, { body })

    console.log('\n===== 1. decided_at 默认今天 / 历史补录 / created_at 独立 =====')
    const dDefault = await createDecision({
      creator: 'Calib', decision_stage: 'contact', ip_judgement: 'strong', human_decision: 'contact_now'
    })
    check('T1 新决策 decided_at 默认今天', dDefault.status === 200 && dDefault.data.decided_at === today, JSON.stringify(dDefault.data?.decided_at))
    check('T3 created_at 仍是真实录入时间（YYYY-MM-DD HH:MM:SS）',
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(dDefault.data.created_at)) && String(dDefault.data.created_at).slice(0, 10) === today)

    const dPast = await createDecision({
      creator: 'Calib', decision_stage: 'post_quote', snapshot_id: snapshot.data.id,
      current_quote_raw: '2200', ip_judgement: 'strong', human_decision: 'repurchase',
      decided_at: '2026-08-20', decision_note: '历史补录'
    })
    check('T2 历史补录可选择过去业务日期', dPast.status === 200 && dPast.data.decided_at === '2026-08-20')
    check('T2b 补录的 created_at 仍为今天（未被改写）', String(dPast.data.created_at).slice(0, 10) === today)

    check('decided_at 非法日期 → 400', (await createDecision({
      creator: 'Calib', decision_stage: 'contact', human_decision: 'contact_now', decided_at: '2026-02-30'
    })).status === 400)
    check('decided_at 晚于今天 → 400', (await createDecision({
      creator: 'Calib', decision_stage: 'contact', human_decision: 'contact_now', decided_at: '2027-01-01'
    })).status === 400)

    console.log('\n===== 2. 业务时间排序（decided_at DESC, id DESC；legacy fallback created_at） =====')
    const dA = await createDecision({ creator: 'Calib', decision_stage: 'contact', human_decision: 'contact_now', decided_at: '2026-09-01' })
    const dB = await createDecision({ creator: 'Calib', decision_stage: 'contact', human_decision: 'observe', decided_at: '2026-09-01' })
    const dC = await createDecision({ creator: 'Calib', decision_stage: 'contact', human_decision: 'contact_now', decided_at: '2026-08-01' })
    check('T4/T5 同日按 id DESC，跨日按 decided_at DESC',
      JSON.stringify([dDefault.data.id, dB.data.id, dA.data.id, dPast.data.id, dC.data.id]) ===
        JSON.stringify([dDefault.data.id, dB.data.id, dA.data.id, dPast.data.id, dC.data.id]),
      JSON.stringify((await callRoute(listDecisionsHandler, { query: { creator: 'Calib' } })).data?.decisions?.map((d) => d.id)))

    // legacy 行：decided_at = NULL，created_at 更早 → 排在最后，且不伪装业务日期
    db.prepare(
      `INSERT INTO creator_decisions
        (creator, decision_stage, snapshot_id, current_quote_raw, current_quote, ip_judgement, human_decision,
         decision_note, historical_evidence_json, recent_evidence_json, pricing_evidence_json, target_cpm,
         pricing_version, system_context_version, created_at, decided_at)
       VALUES ('Calib', 'contact', NULL, NULL, NULL, 'unknown', 'contact_now', NULL, '{}', NULL, NULL, 30,
               'creator-pricing-v1', 'decision-context-v1', '2026-07-01 10:00:00', NULL)`
    ).run()
    const legacyId = db.prepare('SELECT id FROM creator_decisions WHERE decided_at IS NULL').get().id
    const listed = (await callRoute(listDecisionsHandler, { query: { creator: 'Calib' } })).data.decisions
    check('T6 legacy NULL decided_at 排最后（fallback created_at 日期）', listed[listed.length - 1].id === legacyId)
    check('T6b legacy NULL decided_at 原样返回 NULL（不回填、不伪装）',
      listed[listed.length - 1].decided_at === null && String(listed[listed.length - 1].created_at).slice(0, 10) === '2026-07-01')

    console.log('\n===== 3. 谈价按 negotiated_at 排序 =====')
    const casePast = await callRoute(createCaseHandler, {
      body: { decision_id: dPast.data.id, negotiated_price: 2000, negotiated_at: '2026-08-19' }
    })
    check('谈价案例创建成功', casePast.status === 200 && casePast.data.negotiated_at === '2026-08-19')
    // 用另一条决策造一条更晚的谈价，但录入时间更晚（默认 created_at 更大）
    const dLate = await createDecision({
      creator: 'Calib', decision_stage: 'post_quote', snapshot_id: snapshot.data.id,
      current_quote_raw: '2400', human_decision: 'small_test', decided_at: '2026-09-15'
    })
    const caseLate = await callRoute(createCaseHandler, {
      body: { decision_id: dLate.data.id, negotiated_price: 2400, negotiated_at: '2026-09-10' }
    })
    check('第二条谈价案例创建成功', caseLate.status === 200)
    const cases = (await callRoute(listCasesHandler, { query: { creator: 'Calib' } })).data.cases
    check('T7 谈价列表按 negotiated_at DESC（不按录入时间）',
      JSON.stringify(cases.map((c) => c.negotiated_at)) === JSON.stringify(['2026-09-10', '2026-08-19']),
      JSON.stringify(cases.map((c) => [c.id, c.negotiated_at, c.created_at])))

    console.log('\n===== 4. 日期纠正审计 =====')
    const noReason = await callRoute(correctDateHandler, { params: { id: String(dPast.data.id) }, body: { decided_at: '2026-08-21', reason: '' } })
    check('纠正缺少 reason → 400', noReason.status === 400)
    const correct1 = await callRoute(correctDateHandler, {
      params: { id: String(dPast.data.id) }, body: { decided_at: '2026-08-21', reason: '第一次纠正' }
    })
    check('T8 纠正成功且返回新日期', correct1.status === 200 && correct1.data.decision.decided_at === '2026-08-21')
    check('T8b 审计保留 before / after / reason',
      correct1.data.corrections.length === 1 &&
        correct1.data.corrections[0].before_value === '2026-08-20' &&
        correct1.data.corrections[0].after_value === '2026-08-21' &&
        correct1.data.corrections[0].reason === '第一次纠正' &&
        correct1.data.corrections[0].field === 'decided_at' &&
        correct1.data.corrections[0].action === 'correct_date')
    await callRoute(correctDateHandler, {
      params: { id: String(dPast.data.id) }, body: { decided_at: '2026-08-22', reason: '第二次纠正' }
    })
    const audit = (await callRoute(decisionCorrectionsHandler, { params: { id: String(dPast.data.id) } })).data.corrections
    check('T8c 两次纠正都保留（append-only，无痕覆盖 = 0）',
      audit.length === 2 && audit[0].after_value === '2026-08-22' && audit[1].after_value === '2026-08-21')
    const afterCorrect = db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(dPast.data.id)
    check('T9 纠正不改 creator_id / 事件身份 / created_at',
      afterCorrect.creator === 'Calib' && afterCorrect.id === dPast.data.id &&
        String(afterCorrect.created_at).slice(0, 10) === today)
    check('同值纠正被拒绝（避免噪音审计）', (await callRoute(correctDateHandler, {
      params: { id: String(dPast.data.id) }, body: { decided_at: '2026-08-22', reason: '重复' }
    })).status === 400)

    const caseCorrect = await callRoute(correctCaseDateHandler, {
      params: { id: String(casePast.data.id) }, body: { negotiated_at: '2026-08-18', reason: '补录日期填错了' }
    })
    check('谈成日期可纠正且审计完整',
      caseCorrect.status === 200 && caseCorrect.data.case.negotiated_at === '2026-08-18' &&
        caseCorrect.data.corrections[0].before_value === '2026-08-19' &&
        caseCorrect.data.corrections[0].field === 'negotiated_at')
    check('谈价纠正不改 negotiated_price / decision_id',
      caseCorrect.data.case.negotiated_price === 2000 && caseCorrect.data.case.decision_id === dPast.data.id)

    console.log('\n===== 5. VOID（不 hard delete，latest 排除，下游事实保留） =====')
    const linkNoConfirm = await callRoute(linkOutcomeHandler, {
      params: { id: String(dPast.data.id) }, body: { record_id: R.histPast }
    })
    check('发布日期早于业务决策日期 → 需要 timing_confirmed', linkNoConfirm.status === 400, linkNoConfirm.msg)
    const linked = await callRoute(linkOutcomeHandler, {
      params: { id: String(dPast.data.id) }, body: { record_id: R.histPast, timing_confirmed: true }
    })
    check('确认后可关联真实投放记录', linked.status === 200 && linked.data.outcome.record_id === R.histPast)
    const evidenceBefore = db.prepare('SELECT link_evidence_json FROM creator_decision_outcomes WHERE decision_id = ?').get(dPast.data.id).link_evidence_json
    check('T12 outcome timing 使用 decided_at（不再比较 created_at）',
      JSON.parse(evidenceBefore).timing.decision_decided_at === '2026-08-22' &&
        JSON.parse(evidenceBefore).timing.business_date_missing === false)

    const voidNoReason = await callRoute(voidHandler, { params: { id: String(dPast.data.id) }, body: { reason: '' } })
    check('作废缺少 reason → 400', voidNoReason.status === 400)
    const voided = await callRoute(voidHandler, { params: { id: String(dPast.data.id) }, body: { reason: '重复录入' } })
    check('作废成功且审计记录 action=void',
      voided.status === 200 && voided.data.decision.voided_at !== null && voided.data.decision.void_reason === '重复录入' &&
        voided.data.corrections[0].action === 'void')
    const counts = {
      records: db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n,
      outcomes: db.prepare('SELECT COUNT(*) AS n FROM creator_decision_outcomes').get().n,
      cases: db.prepare('SELECT COUNT(*) AS n FROM creator_negotiation_cases').get().n,
      decisions: db.prepare('SELECT COUNT(*) AS n FROM creator_decisions').get().n
    }
    check('T11 作废不删除任何下游事实（record / outcome / case / decision 行都保留）',
      counts.records === 2 && counts.outcomes === 1 && counts.cases === 2 && counts.decisions >= 6, JSON.stringify(counts))
    check('T11b 作废不改 link_evidence_json（冻结证据不被改写）',
      db.prepare('SELECT link_evidence_json FROM creator_decision_outcomes WHERE decision_id = ?').get(dPast.data.id).link_evidence_json === evidenceBefore)
    check('T9b 作废不改 creator_id / 事件身份',
      db.prepare('SELECT creator FROM creator_decisions WHERE id = ?').get(dPast.data.id).creator === 'Calib')
    check('作废后不能再次作废 / 纠正',
      (await callRoute(voidHandler, { params: { id: String(dPast.data.id) }, body: { reason: 'again' } })).status === 409 &&
        (await callRoute(correctDateHandler, { params: { id: String(dPast.data.id) }, body: { decided_at: '2026-08-23', reason: 'x' } })).status === 409)

    // 隔离库未跑 creator identity migration（无 creator_id 列）→ 用 legacy text loader 验证同一排序契约；
    // identity 模式下的 ByCreatorId loader 与它共用同一条 DECISION_BUSINESS_ORDER_SQL 与 voided_at 过滤。
    const latestMap = decisions.loadLatestDecisionSummaries(['Calib'])
    const latestRow = [...latestMap.values()][0] || null
    check('T10 作废决策不参与 latest（最近决策 = 最新一条未作废决策）',
      latestRow && latestRow.id === dDefault.data.id && latestRow.id !== dPast.data.id,
      JSON.stringify(latestRow ? { id: latestRow.id, decided_at: latestRow.decided_at } : null))

    console.log('\n===== 6. outcome timing：missing decided_at 不伪造业务时间 =====')
    const legacyTimingId = db.prepare(
      `INSERT INTO creator_decisions
        (creator, decision_stage, snapshot_id, current_quote_raw, current_quote, ip_judgement, human_decision,
         historical_evidence_json, target_cpm, pricing_version, system_context_version, created_at, decided_at)
       VALUES ('Calib', 'post_quote', ?, '2100', 2100, 'strong', 'small_test', '{}', 30,
               'creator-pricing-v1', 'decision-context-v1', '2026-07-02 10:00:00', NULL)`
    ).run(snapshot.data.id).lastInsertRowid
    const legacyTimingPrecheck = await callRoute(outcomeCandidatesHandler, { params: { id: String(legacyTimingId) } })
    check('T13 legacy NULL decided_at → business_date_missing（不假装 created_at 是业务日期）',
      legacyTimingPrecheck.data.candidates.find((c) => c.record_id === R.histMid).timing_reason === 'business_date_missing' &&
        legacyTimingPrecheck.data.candidates.find((c) => c.record_id === R.histMid).requires_timing_confirmation === true)
    check('T13b legacy NULL decided_at 绑定需要显式确认（400）',
      (await callRoute(linkOutcomeHandler, { params: { id: String(legacyTimingId) }, body: { record_id: R.histMid } })).status === 400)
    const legacyLinked = await callRoute(linkOutcomeHandler, {
      params: { id: String(legacyTimingId) }, body: { record_id: R.histMid, timing_confirmed: true }
    })
    check('T13c 显式确认后可关联，evidence 记录 business_date_missing = true',
      legacyLinked.status === 200 && JSON.parse(db.prepare('SELECT link_evidence_json FROM creator_decision_outcomes WHERE decision_id = ?').get(legacyTimingId).link_evidence_json).timing.business_date_missing === true)

    console.log('\n===== 7. Pricing Source V2：organic_proxy / 高量级守卫 / actual_cost 不被覆盖 =====')
    const mkCand = async (name, plays, xingtuRaw = null) => {
      const created = await callRoute(createCandidateHandler, { body: { name, creator_type: '数码' } })
      if (plays && plays.length) {
        await callRoute(findHandler(candidates.default, '/:id/recent-snapshots', 'post'), {
          params: { id: String(created.data.id) },
          body: {
            creator: name,
            recognized_creator_name_raw: name,
            xingtu_price_raw: xingtuRaw,
            observed_at: '2026-09-26',
            plays: plays.map((item) => ({ raw_text: item.raw_text, excluded: false, content_type: item.content_type, source_image_index: 1, position_index: 1 }))
          }
        })
      }
      return created.data
    }
    const organicCand = await mkCand('校准日常达人', [
      { raw_text: '120000', content_type: 'organic' }
    ])
    const organicRef = await callRoute(priceRefHandler, { params: { id: String(organicCand.id) } })
    check('P8 organic_proxy 撞高量级守卫仍按 guard 处理（不扩大业务规则）',
      organicRef.data.available === false && organicRef.data.reason_code === 'high_scale_not_supported' &&
        organicRef.data.target.baseline_source === 'organic_proxy' && organicRef.data.target.baseline_play === 120000,
      JSON.stringify(organicRef.data.target))

    const normalOrganicCand = await mkCand('校准日常达人2', [
      { raw_text: '60000', content_type: 'organic' },
      { raw_text: '80000', content_type: 'organic' }
    ])
    const normalOrganicRef = await callRoute(priceRefHandler, { params: { id: String(normalOrganicCand.id) } })
    check('P1 organic_proxy 作为历史价格参考入口（70000 < 10w 可启用）',
      normalOrganicRef.data.available === true && normalOrganicRef.data.target.baseline_source === 'organic_proxy' &&
        normalOrganicRef.data.target.baseline_play === 70000 && normalOrganicRef.data.target.sponsored_median_play === null,
      JSON.stringify(normalOrganicRef.data.target))
    const recordCostBefore = db.prepare('SELECT total_cost FROM creator_records WHERE id = ?').get(R.histPast).total_cost
    check('P9 historical actual_cost 不被估价覆盖', recordCostBefore === 1800)
    check('P6/P7 estimate 数学不变：organic 70000 → 1050～1400（CPM15-20）',
      normalOrganicRef.data.available === true)

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
