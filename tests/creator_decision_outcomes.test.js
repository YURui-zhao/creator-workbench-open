#!/usr/bin/env node
/**
 * 决策 ↔ 真实投放结果关联（V3-alpha P5）回归测试
 *
 * 运行方式：node tests/creator_decision_outcomes.test.js
 * 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
 * 网络：拦截 http/https/net/tls/fetch —— P5 不调用 AI、不访问外部网络。
 *
 * 重点（P5 最重要的设计验证）：
 *   · Decision evidence = frozen：创建后新增 / 更新投放记录不得改变旧 decision 证据
 *   · Outcome result    = live：outcome 的花费 / 播放 / CPM 必须实时反映 creator_records 当前值
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

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-outcomes-'))
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
      throw new Error('P5 test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('P5 test forbids network requests')
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

const play = (raw_text) => ({ raw_text, excluded: false, source_image_index: 1, position_index: 1 })

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const outcomes = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorDecisionOutcomes.js')).href
    )
    const decisions = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorDecisions.js')).href
    )
    const snapshots = await import(
      pathToFileURL(path.join(root, 'backend/routes/recentSnapshots.js')).href
    )
    const records = await import(pathToFileURL(path.join(root, 'backend/routes/records.js')).href)
    const outcomeUtils = await import(
      pathToFileURL(path.join(root, 'backend/utils/creatorDecisionOutcome.js')).href
    )
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

    const findHandler = (router, routePath, method) => {
      const layer = router.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const createHandler = findHandler(decisions.default, '/', 'post')
    const listHandler = findHandler(decisions.default, '/', 'get')
    const candidatesHandler = findHandler(outcomes.default, '/:id/outcome-candidates', 'get')
    const linkHandler = findHandler(outcomes.default, '/:id/outcome', 'post')
    const unlinkHandler = findHandler(outcomes.default, '/:id/outcome', 'delete')
    const postSnapshotHandler = findHandler(snapshots.default, '/', 'post')
    const radarHandler = findHandler(records.default, '/repurchase-radar', 'get')

    const callRoute = async (handler, { body = {}, query = {}, params = {}, headers = {} } = {}) => {
      const res = response()
      await handler({ body, query, params, headers }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    /** 只取 P1 / P2 / P3 的事实字段，用于「关联前后不回退」比较（不含 P4/P5 展示字段） */
    const radarFacts = (radar) => JSON.stringify(
      radar.data.groups.flatMap((group) => group.creators).map((creator) => ({
        creator: creator.creator,
        creator_type: creator.creator_type,
        record_count: creator.record_count,
        valid_cpm_count: creator.valid_cpm_count,
        pass_count: creator.pass_count,
        fail_count: creator.fail_count,
        historical_status: creator.historical_status,
        median_cpm: creator.median_cpm,
        recent_risk: creator.recent_risk,
        last_collaboration_date: creator.last_collaboration_date,
        snapshot: creator.recent_snapshot
      }))
    )
    const groupOrder = (radar) => JSON.stringify(
      radar.data.groups.map((group) => ({ key: group.key, creators: group.creators.map((c) => c.creator) }))
    )

    console.log('===== 0. 表结构 / 隔离 / 固定数据 =====')
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
    check('新增 creator_decision_outcomes 表', tables.includes('creator_decision_outcomes'), JSON.stringify(tables))
    const outcomeColumns = db.prepare('PRAGMA table_info(creator_decision_outcomes)').all()
    const outcomeColumnMap = Object.fromEntries(outcomeColumns.map((c) => [c.name, c]))
    check(
      'outcome 表字段齐全',
      ['id', 'decision_id', 'record_id', 'linked_at'].every((name) => name in outcomeColumnMap),
      JSON.stringify(Object.keys(outcomeColumnMap))
    )
    check('每一列都显式声明类型', outcomeColumns.every((c) => c.type && c.type.trim()))
    const outcomeIndexes = db.prepare('PRAGMA index_list(creator_decision_outcomes)').all()
    const uniqueIndexes = outcomeIndexes.filter((i) => i.unique === 1)
    const indexColumns = (name) => db.prepare(`PRAGMA index_info(${name})`).all().map((c) => c.name).join(',')
    check(
      'decision_id / record_id 都有 UNIQUE 约束',
      uniqueIndexes.some((i) => indexColumns(i.name) === 'decision_id') &&
        uniqueIndexes.some((i) => indexColumns(i.name) === 'record_id'),
      JSON.stringify(outcomeIndexes)
    )
    check(
      '存在 decision / record 两条索引',
      ['idx_decision_outcomes_decision', 'idx_decision_outcomes_record'].every((name) =>
        outcomeIndexes.map((i) => i.name).includes(name)
      ),
      JSON.stringify(outcomeIndexes.map((i) => i.name))
    )
    const recordsColumnsBefore = JSON.stringify(db.prepare('PRAGMA table_info(creator_records)').all().map((c) => `${c.name}:${c.type}`))
    const decisionsColumnsBefore = JSON.stringify(db.prepare('PRAGMA table_info(creator_decisions)').all().map((c) => `${c.name}:${c.type}`))
    const snapshotColumnsBefore = JSON.stringify(db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => `${c.name}:${c.type}`))

    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const R = {}
    db.transaction(() => {
      // Gary：历史 3 条（CPM 18 / 27 / 46）+ 未来 1 条 + 待更新 / 零播放 / 异常各 1 条
      R.garyHist1 = Number(insertRecord.run('2026-W33', 'Gary', '数码', 1800, '2026-08-18', 20000, 100000).lastInsertRowid)
      R.garyHist2 = Number(insertRecord.run('2026-W34', 'Gary', '数码', 2700, '2026-08-25', 20000, 100000).lastInsertRowid)
      R.garyHist3 = Number(insertRecord.run('2026-W35', 'Gary', '数码', 4600, '2026-09-01', 20000, 100000).lastInsertRowid)
      R.garyFuture = Number(insertRecord.run('2026-W41', 'Gary', '数码', 1800, '2026-10-06', 72000, 98000).lastInsertRowid)
      R.garyPending = Number(insertRecord.run('2026-W41', 'Gary', '数码', 2000, '2026-10-07', 30000, null).lastInsertRowid)
      R.garyZero = Number(insertRecord.run('2026-W41', 'Gary', '数码', 2000, '2026-10-08', 0, 0).lastInsertRowid)
      R.garyAnomaly = Number(insertRecord.run('2026-W41', 'Gary', '数码', 2000, '2026-10-09', 50000, 30000).lastInsertRowid)
      // Alice：用于 creator 不一致 / 候选只含同一达人
      R.alice1 = Number(insertRecord.run('2026-W35', 'Alice', '美妆', 2000, '2026-09-02', 20000, 100000).lastInsertRowid)
    })()

    const garySnapshot = await callRoute(postSnapshotHandler, {
      body: {
        creator: 'Gary',
        recognized_creator_name_raw: 'Gary',
        xingtu_price_raw: '3000元',
        observed_at: '2026-09-26', // Alpha.2：数据观察日期必填
        plays: ['39000', '40000', '42000', '43000', '50000', '52000', '55000', '61000', '62000', '64000', '65000'].map(play)
      }
    })
    check('Gary 快照创建成功（median 52000 / xingtu 3000）', garySnapshot.status === 200 && garySnapshot.data.median_play === 52000)

    /** 创建一条决策并固定 created_at / decided_at，使 timing 判断不依赖运行日期 */
    const makeDecision = async (body, createdAt = '2026-09-29 10:00:00', decidedAt = '2026-09-29') => {
      const res = await callRoute(createHandler, { body: { ...body, decided_at: decidedAt } })
      if (res.status !== 200) return res
      db.prepare('UPDATE creator_decisions SET created_at = ?, decided_at = ? WHERE id = ?').run(createdAt, decidedAt, res.data.id)
      res.data.created_at = createdAt
      res.data.decided_at = decidedAt
      return res
    }

    const repurchaseDecision = await makeDecision({
      creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id,
      current_quote_raw: '2400', ip_judgement: 'strong', human_decision: 'repurchase', decision_note: '商单融入自然'
    })
    const smallTestDecision = await makeDecision({
      creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id,
      current_quote_raw: '1800', ip_judgement: 'medium', human_decision: 'small_test'
    })
    const negotiateDecision = await makeDecision({
      creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id,
      current_quote_raw: '2600', ip_judgement: 'weak', human_decision: 'negotiate'
    })
    const pauseDecision = await makeDecision({
      creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id,
      current_quote_raw: '2800', ip_judgement: 'unknown', human_decision: 'pause'
    })
    const aliceContactDecision = await makeDecision({
      creator: 'Alice', decision_stage: 'contact', ip_judgement: 'strong', human_decision: 'contact_now'
    })
    const aliceRepurchaseDecision = await makeDecision({
      creator: 'Alice', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id,
      current_quote_raw: '1500', human_decision: 'repurchase'
    })
    check(
      '前置决策创建成功',
      [repurchaseDecision, smallTestDecision, negotiateDecision, pauseDecision, aliceContactDecision].every((r) => r.status === 200),
      JSON.stringify([repurchaseDecision.status, smallTestDecision.status, negotiateDecision.status, pauseDecision.status])
    )
    check('Alice 的 post_quote 因快照属于 Gary → 400', aliceRepurchaseDecision.status === 400)

    const linkBody = (recordId, extra = {}) => ({ record_id: recordId, ...extra })

    console.log('\n===== 1. eligibility（只有 post_quote + repurchase/small_test 可关联）=====')
    check(
      'contact 决策不能关联 → 400',
      (await callRoute(linkHandler, { params: { id: aliceContactDecision.data.id }, body: linkBody(R.alice1) })).status === 400
    )
    check(
      'negotiate 不能关联 → 400',
      (await callRoute(linkHandler, { params: { id: negotiateDecision.data.id }, body: linkBody(R.garyFuture) })).status === 400
    )
    check(
      'pause 不能关联 → 400',
      (await callRoute(linkHandler, { params: { id: pauseDecision.data.id }, body: linkBody(R.garyFuture) })).status === 400
    )
    check(
      '不可关联时明确提示「未进入实际投放阶段」',
      (await callRoute(linkHandler, { params: { id: negotiateDecision.data.id }, body: linkBody(R.garyFuture) })).msg.includes('未进入实际投放阶段')
    )
    check(
      'repurchase 可关联（未来记录，无需 timing 确认）',
      (await callRoute(linkHandler, { params: { id: repurchaseDecision.data.id }, body: linkBody(R.garyFuture) })).status === 200
    )
    check(
      'small_test 可关联',
      (await callRoute(linkHandler, { params: { id: smallTestDecision.data.id }, body: linkBody(R.garyHist1, { timing_confirmed: true }) })).status === 200
    )

    console.log('\n===== 2. 校验：decision / record / creator =====')
    check('decision 不存在 → 404', (await callRoute(linkHandler, { params: { id: 99999 }, body: linkBody(R.garyFuture) })).status === 404)
    check('record 不存在 → 404', (await callRoute(linkHandler, { params: { id: repurchaseDecision.data.id }, body: linkBody(99999) })).status === 404)
    check('record_id 非法 → 400', (await callRoute(linkHandler, { params: { id: repurchaseDecision.data.id }, body: linkBody('abc') })).status === 400)
    const mismatch = await callRoute(linkHandler, { params: { id: repurchaseDecision.data.id }, body: linkBody(R.alice1) })
    check('creator 不一致 → 400（不能把 Alice 的记录绑给 Gary 的决策）', mismatch.status === 400 && /不能关联给达人/.test(mismatch.msg), mismatch.msg)

    console.log('\n===== 3. 唯一性 / 并发保护 =====')
    const secondRepurchase = await makeDecision({
      creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id,
      current_quote_raw: '1900', human_decision: 'repurchase'
    })
    check(
      '同一 decision 不能绑第二条 record → 409',
      (await callRoute(linkHandler, { params: { id: repurchaseDecision.data.id }, body: linkBody(R.garyHist2, { timing_confirmed: true }) })).status === 409
    )
    check(
      '同一 record 不能绑第二个 decision → 409',
      (await callRoute(linkHandler, { params: { id: secondRepurchase.data.id }, body: linkBody(R.garyFuture) })).status === 409
    )
    let uniqueThrew = false
    try {
      db.prepare('INSERT INTO creator_decision_outcomes (decision_id, record_id) VALUES (?, ?)').run(
        repurchaseDecision.data.id, R.garyHist3
      )
    } catch {
      uniqueThrew = true
    }
    check('数据库 UNIQUE 是并发下的最终保护（重复插入抛错）', uniqueThrew)
    check(
      '未产生双关联（outcome 行数 = 成功关联数）',
      db.prepare('SELECT COUNT(*) AS n FROM creator_decision_outcomes').get().n === 2,
      String(db.prepare('SELECT COUNT(*) AS n FROM creator_decision_outcomes').get().n)
    )

    console.log('\n===== 4. timing warning =====')
    const timingProbe = await makeDecision({
      creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id,
      current_quote_raw: '2000', human_decision: 'repurchase'
    })
    const timingCandidates = (await callRoute(candidatesHandler, { params: { id: timingProbe.data.id } })).data.candidates
    check(
      '发布日期早于决策 → timing_warning = true（历史记录）',
      timingCandidates.find((c) => c.record_id === R.garyHist2).timing_warning === true
    )
    check(
      '发布日期晚于决策 → timing_warning = false（未来记录无需确认）',
      timingCandidates.find((c) => c.record_id === R.garyPending).timing_warning === false
    )
    const warnNoConfirm = await callRoute(linkHandler, { params: { id: timingProbe.data.id }, body: linkBody(R.garyHist2) })
    check('timing warning 未确认不能绑定 → 400', warnNoConfirm.status === 400 && /timing_confirmed/.test(warnNoConfirm.msg), warnNoConfirm.msg)
    const warnConfirmed = await callRoute(linkHandler, {
      params: { id: timingProbe.data.id },
      body: linkBody(R.garyHist2, { timing_confirmed: true })
    })
    check('timing 明确确认后可以绑定', warnConfirmed.status === 200 && warnConfirmed.data.outcome.record_id === R.garyHist2)

    console.log('\n===== 5. 候选记录 =====')
    const candidateDecision = await makeDecision({
      creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id,
      current_quote_raw: '2100', human_decision: 'repurchase'
    })
    const candidateRes = await callRoute(candidatesHandler, { params: { id: candidateDecision.data.id } })
    const candidateList = candidateRes.data.candidates
    check('候选只返回同一 creator', candidateList.length > 0 && candidateList.every((c) => c.creator === 'Gary'))
    check(
      '候选按 publish_date DESC 排序',
      JSON.stringify(candidateList.map((c) => c.publish_date)) ===
        JSON.stringify([...candidateList.map((c) => c.publish_date)].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))),
      JSON.stringify(candidateList.map((c) => c.publish_date))
    )
    check(
      'candidate already_linked / linked_decision_id 正确',
      candidateList.find((c) => c.record_id === R.garyFuture).already_linked === true &&
        candidateList.find((c) => c.record_id === R.garyFuture).linked_decision_id === repurchaseDecision.data.id &&
        candidateList.find((c) => c.record_id === R.garyHist1).already_linked === true &&
        candidateList.find((c) => c.record_id === R.garyPending).already_linked === false
    )
    check(
      '候选 CPM 由后端复用 V2 口径（4600/20000×1000 = 230、4600/100000×1000 = 46）',
      candidateList.find((c) => c.record_id === R.garyHist3).first_cpm === 230 &&
        candidateList.find((c) => c.record_id === R.garyHist3).latest_cpm === 46
    )
    check(
      '不可关联的决策候选仍标记 eligible=false',
      (await callRoute(candidatesHandler, { params: { id: negotiateDecision.data.id } })).data.eligible === false
    )

    console.log('\n===== 6. outcome metrics 复用 V2 口径 =====')
    const pendingDecision = await makeDecision({
      creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id,
      current_quote_raw: '2200', human_decision: 'repurchase'
    })
    const pendingLink = await callRoute(linkHandler, { params: { id: pendingDecision.data.id }, body: linkBody(R.garyPending) })
    check(
      'latest=null → pending，latest_play 为 null（不当作 0）',
      pendingLink.data.outcome.latest_play === null &&
        pendingLink.data.outcome.latest_status === 'pending' &&
        pendingLink.data.outcome.target_cpm_status === 'pending' &&
        pendingLink.data.outcome.latest_cpm === null
    )
    check('latest=null → 7日CPM 仍然可用（2000/30000×1000 = 66.67）', pendingLink.data.outcome.first_cpm === 66.67)

    const zeroDecision = await makeDecision({
      creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id,
      current_quote_raw: '2300', human_decision: 'repurchase'
    })
    const zeroLink = await callRoute(linkHandler, { params: { id: zeroDecision.data.id }, body: linkBody(R.garyZero) })
    check(
      'latest=0 保持真实 0 语义（不是 null / pending）',
      zeroLink.data.outcome.latest_play === 0 &&
        zeroLink.data.outcome.latest_status === 'observed' &&
        zeroLink.data.outcome.target_cpm_status === 'zero_play',
      JSON.stringify(zeroLink.data.outcome)
    )

    const anomalyDecision = await makeDecision({
      creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id,
      current_quote_raw: '2350', human_decision: 'repurchase'
    })
    const anomalyLink = await callRoute(linkHandler, { params: { id: anomalyDecision.data.id }, body: linkBody(R.garyAnomaly) })
    check(
      'latest<first → anomaly（不计入累计 CPM / 后续新增）',
      anomalyLink.data.outcome.latest_status === 'anomaly' &&
        anomalyLink.data.outcome.target_cpm_status === 'anomaly' &&
        anomalyLink.data.outcome.latest_cpm === null &&
        anomalyLink.data.outcome.subsequent_play === null,
      JSON.stringify(anomalyLink.data.outcome)
    )

    // 这一条同时覆盖：CPM>30 → not_met，以及伪造 payload 被忽略
    const notMetDecision = await makeDecision({
      creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id,
      current_quote_raw: '2450', human_decision: 'small_test'
    })
    const notMetLink = await callRoute(linkHandler, {
      params: { id: notMetDecision.data.id },
      body: {
        record_id: R.garyHist3, timing_confirmed: true,
        // 前端伪造 authoritative 派生字段，必须被忽略
        total_cost: 1, first_play: 1, second_week_play: 1, latest_cpm: 0, target_cpm_status: 'met', target_cpm: 999
      }
    })
    check(
      'CPM>30 → not_met（4600/100000×1000 = 46）',
      notMetLink.data.outcome.latest_cpm === 46 && notMetLink.data.outcome.target_cpm_status === 'not_met' && notMetLink.data.outcome.target_cpm === 30
    )
    check(
      'link payload 伪造的 cost / play / cpm / status 全部被忽略',
      notMetLink.data.outcome.total_cost === 4600 &&
        notMetLink.data.outcome.latest_play === 100000 &&
        notMetLink.data.outcome.first_cpm === 230
    )
    const metOutcome = (await callRoute(listHandler, { query: { creator: 'Gary' } })).data.decisions
      .find((d) => d.id === smallTestDecision.data.id).outcome
    check(
      'CPM<=30 → met（1800/100000×1000 = 18），且决策列表携带 outcome',
      metOutcome.latest_cpm === 18 && metOutcome.target_cpm_status === 'met' && metOutcome.record_id === R.garyHist1
    )

    console.log('\n===== 7. live outcome / frozen decision =====')
    const frozenBefore = db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(repurchaseDecision.data.id)
    const outcomeBefore = (await callRoute(listHandler, { query: { creator: 'Gary' } })).data.decisions
      .find((d) => d.id === repurchaseDecision.data.id).outcome
    db.prepare('UPDATE creator_records SET second_week_play = ? WHERE id = ?').run(150000, R.garyFuture)
    const frozenAfter = db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(repurchaseDecision.data.id)
    const decisionAfter = (await callRoute(listHandler, { query: { creator: 'Gary' } })).data.decisions
      .find((d) => d.id === repurchaseDecision.data.id)
    check(
      'Decision 固化证据完全不变（frozen：historical / recent / pricing / target_cpm / pricing_version）',
      JSON.stringify(frozenBefore) === JSON.stringify(frozenAfter) &&
        JSON.stringify(decisionAfter.historical_evidence) === JSON.stringify(repurchaseDecision.data.historical_evidence) &&
        JSON.stringify(decisionAfter.recent_evidence) === JSON.stringify(repurchaseDecision.data.recent_evidence) &&
        JSON.stringify(decisionAfter.pricing_evidence) === JSON.stringify(repurchaseDecision.data.pricing_evidence) &&
        decisionAfter.target_cpm === 30 &&
        decisionAfter.pricing_version === 'creator-pricing-v1'
    )
    check(
      'Outcome 实时反映最新 record（live：98000 → 150000）',
      outcomeBefore.latest_play === 98000 && outcomeBefore.latest_cpm === 18.37 &&
        decisionAfter.outcome.latest_play === 150000 && decisionAfter.outcome.latest_cpm === 12 &&
        decisionAfter.outcome.target_cpm_status === 'met',
      JSON.stringify({ before: outcomeBefore.latest_play, after: decisionAfter.outcome.latest_play })
    )
    check(
      '新增 record 不改变旧 decision（append-only evidence）',
      (() => {
        db.prepare(
          `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
           VALUES ('2026-W42', 'Gary', '数码', 900, '2026-10-13', 10000, 20000)`
        ).run()
        const after = db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(repurchaseDecision.data.id)
        return JSON.stringify(after) === JSON.stringify(frozenBefore)
      })()
    )

    console.log('\n===== 8. 解除关联 =====')
    const recordBeforeUnlink = db.prepare('SELECT * FROM creator_records WHERE id = ?').get(R.garyHist3)
    const decisionBeforeUnlink = db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(notMetDecision.data.id)
    const unlinked = await callRoute(unlinkHandler, { params: { id: notMetDecision.data.id } })
    check('解除关联成功', unlinked.status === 200 && unlinked.data.outcome === null && unlinked.data.unlinked_record_id === R.garyHist3)
    check(
      '只删除 mapping（decision / creator_record 逐字段不变）',
      db.prepare('SELECT COUNT(*) AS n FROM creator_decision_outcomes WHERE decision_id = ?').get(notMetDecision.data.id).n === 0 &&
        JSON.stringify(db.prepare('SELECT * FROM creator_records WHERE id = ?').get(R.garyHist3)) === JSON.stringify(recordBeforeUnlink) &&
        JSON.stringify(db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(notMetDecision.data.id)) === JSON.stringify(decisionBeforeUnlink)
    )
    check(
      '解除后 GET 的 outcome 变回 null',
      (await callRoute(listHandler, { query: { creator: 'Gary' } })).data.decisions.find((d) => d.id === notMetDecision.data.id).outcome === null
    )
    check('不存在关联时解除 → 404（友好提示）', (await callRoute(unlinkHandler, { params: { id: notMetDecision.data.id } })).status === 404)
    check(
      '解除后可以重新正确关联',
      (await callRoute(linkHandler, { params: { id: notMetDecision.data.id }, body: linkBody(R.garyHist3, { timing_confirmed: true }) })).status === 200
    )

    console.log('\n===== 9. P1 / P2 / P3 / P4 不回退 =====')
    const radarBeforeToggle = await callRoute(radarHandler, { query: {} })
    await callRoute(unlinkHandler, { params: { id: notMetDecision.data.id } })
    const radarAfterUnlink = await callRoute(radarHandler, { query: {} })
    await callRoute(linkHandler, { params: { id: notMetDecision.data.id }, body: linkBody(R.garyHist3, { timing_confirmed: true }) })
    const radarAfterRelink = await callRoute(radarHandler, { query: {} })
    check('解除关联前后 P1 事实（分组/排序/中位数/风险）完全一致', groupOrder(radarBeforeToggle) === groupOrder(radarAfterUnlink) && radarFacts(radarBeforeToggle) === radarFacts(radarAfterUnlink))
    check('重新关联前后 P1 事实完全一致', groupOrder(radarBeforeToggle) === groupOrder(radarAfterRelink) && radarFacts(radarBeforeToggle) === radarFacts(radarAfterRelink))
    check(
      'P2 snapshot / P3 pricing 在关联操作前后完全一致',
      JSON.stringify(radarAfterUnlink.data.groups.flatMap((g) => g.creators).map((c) => c.recent_snapshot)) ===
        JSON.stringify(radarAfterRelink.data.groups.flatMap((g) => g.creators).map((c) => c.recent_snapshot))
    )
    check(
      '雷达携带 outcome 轻量状态（只读展示，不改 P1）',
      radarAfterRelink.data.groups.flatMap((g) => g.creators).find((c) => c.creator === 'Gary').recent_decision.outcome.target_cpm_status === 'not_met'
    )
    check(
      'creator_records / creator_decisions / snapshot 表结构未被 P5 修改',
      JSON.stringify(db.prepare('PRAGMA table_info(creator_records)').all().map((c) => `${c.name}:${c.type}`)) === recordsColumnsBefore &&
        JSON.stringify(db.prepare('PRAGMA table_info(creator_decisions)').all().map((c) => `${c.name}:${c.type}`)) === decisionsColumnsBefore &&
        JSON.stringify(db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => `${c.name}:${c.type}`)) === snapshotColumnsBefore
    )
    const originalPrepare = db.prepare.bind(db)
    let prepareCount = 0
    db.prepare = (sql) => { prepareCount += 1; return originalPrepare(sql) }
    await callRoute(radarHandler, { query: {} })
    db.prepare = originalPrepare
    check('radar 合并 pricing + decision + outcome 后仍为少量 SQL', prepareCount <= 6, `prepare=${prepareCount}`)
    // 纯函数层校验：P1 目标值仍与 P3/P5 共用同一个 30
    check(
      'TARGET_CPM 唯一来源（P1 = outcome = 30）',
      records.REPURCHASE_TARGET_CPM === 30 && outcomeUtils.TARGET_CPM_STATUS.met === 'met'
    )

    console.log('\n===== 10. 安全与只读 =====')
    const outcomeRowsText = JSON.stringify(db.prepare('SELECT * FROM creator_decision_outcomes').all())
    check('outcome 表不含 base64 / key / provider 数据', !/base64|apiKey|api_key|sk-|provider_response|data:image/i.test(outcomeRowsText))
    const routeSource = fs.readFileSync(path.join(root, 'backend/routes/creatorDecisionOutcomes.js'), 'utf8')
    check('P5 路由不引用 AI / 网络能力', !/deepseek|axios|fetch\(|callProviderVision|extract-creator-screenshot/i.test(routeSource))
    check(
      'P5 只注册 GET /:id/outcome-candidates、POST /:id/outcome、DELETE /:id/outcome',
      outcomes.default.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort().join(' | ') ===
        'DELETE /:id/outcome | GET /:id/outcome-candidates | POST /:id/outcome',
      outcomes.default.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).join(' | ')
    )
    check(
      'P4 router 既有路由未被 P5 改动',
      decisions.default.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort().join(' | ') ===
        'GET / | GET /:id/corrections | PATCH /:id/date | POST / | POST /:id/void | POST /preview'
    )
    const linkCounts = db.prepare('SELECT COUNT(DISTINCT decision_id) AS d, COUNT(DISTINCT record_id) AS r, COUNT(*) AS n FROM creator_decision_outcomes').get()
    check('outcome 始终满足 1:1（distinct decision = distinct record = 行数）', linkCounts.n === linkCounts.d && linkCounts.n === linkCounts.r, JSON.stringify(linkCounts))
    check('未发生任何外部网络请求', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))
    check('隔离库位于临时目录（未触碰真实 workbench.db）', process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir()))

    console.log(`\n================ 测试汇总 ================`)
    console.log(`用例总数：${passCount + failCount}　通过：${passCount}　失败：${failCount}　通过率：${((passCount / (passCount + failCount)) * 100).toFixed(1)}%`)
    if (failCount > 0) {
      console.log('\n失败用例：')
      for (const item of failures) console.log(`- ${item}`)
    }
  } finally {
    networkGuard.restore()
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  }
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
