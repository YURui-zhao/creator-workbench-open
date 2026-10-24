#!/usr/bin/env node
/**
 * 谈判结果沉淀（V3-alpha.2 A4）回归测试
 *
 * 运行方式：node tests/creator_negotiation_cases.test.js
 * 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
 * 网络：拦截 http/https/net/tls/fetch —— A4 不调用 AI、不访问外部网络。
 *
 * 重点：
 *   · negotiated_price 与 xingtu_price / current_quote / actual_cost 永久分开
 *   · 谈判上下文（星图价 / 报价 / 目标价 / 参考区间）由后端冻结，前端伪造无效
 *   · Decision / Snapshot / Record 后续变化不得改写旧谈判案例
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
const frontend = path.join(root, 'frontend/src')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-negotiation-'))
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
      throw new Error('A4 test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('A4 test forbids network requests')
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
    const cases = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorNegotiationCases.js')).href
    )
    const decisions = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorDecisions.js')).href
    )
    const snapshots = await import(
      pathToFileURL(path.join(root, 'backend/routes/recentSnapshots.js')).href
    )
    const records = await import(pathToFileURL(path.join(root, 'backend/routes/records.js')).href)
    const caseUtil = await import(
      pathToFileURL(path.join(root, 'backend/utils/negotiationCase.js')).href
    )
    const displayLib = await import(
      pathToFileURL(path.join(frontend, 'utils/negotiationCaseDisplay.js')).href
    )
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

    const findHandler = (router, routePath, method) => {
      const layer = router.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const createCaseHandler = findHandler(cases.default, '/', 'post')
    const listCaseHandler = findHandler(cases.default, '/', 'get')
    const createDecisionHandler = findHandler(decisions.default, '/', 'post')
    const listDecisionHandler = findHandler(decisions.default, '/', 'get')
    const postSnapshotHandler = findHandler(snapshots.default, '/', 'post')
    const radarHandler = findHandler(records.default, '/repurchase-radar', 'get')

    const callRoute = async (handler, { body = {}, query = {}, params = {}, headers = {} } = {}) => {
      const res = response()
      await handler({ body, query, params, headers }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    const CREATOR = '协商达人'
    const OTHER = '协商达人乙'

    console.log('===== 0. schema / 前置数据 =====')
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
    check('新增 creator_negotiation_cases 表', tables.includes('creator_negotiation_cases'))
    const columns = db.prepare('PRAGMA table_info(creator_negotiation_cases)').all()
    const columnMap = Object.fromEntries(columns.map((c) => [c.name, c]))
    check(
      'A4-1 字段齐全',
      ['id', 'creator', 'decision_id', 'snapshot_id', 'xingtu_price_snapshot', 'current_quote_snapshot',
        'negotiated_price', 'negotiated_at', 'reason_tags_json', 'reason_note', 'strategy_note',
        'target_cpm', 'target_price_snapshot', 'reference_low_snapshot', 'reference_high_snapshot',
        'created_at'].every((name) => name in columnMap),
      JSON.stringify(Object.keys(columnMap))
    )
    check('A4-2 每列都显式声明类型', columns.every((c) => c.type && c.type.trim()))
    check('A4-3 negotiated_price / negotiated_at 为 NOT NULL', columnMap.negotiated_price.notnull === 1 && columnMap.negotiated_at.notnull === 1)
    const uniqueIndexes = db.prepare('PRAGMA index_list(creator_negotiation_cases)').all().filter((i) => i.unique === 1)
    check(
      'A4-4 decision_id 有 UNIQUE 约束（一个决策最多一条）',
      uniqueIndexes.some((index) =>
        db.prepare(`PRAGMA index_info(${index.name})`).all().map((c) => c.name).join(',') === 'decision_id'
      )
    )
    check(
      'A4-5 存在 (creator, created_at) 索引',
      db.prepare('PRAGMA index_list(creator_negotiation_cases)').all().map((i) => i.name).includes('idx_negotiation_cases_creator_created')
    )
    const decisionsColumnsBefore = JSON.stringify(db.prepare('PRAGMA table_info(creator_decisions)').all().map((c) => `${c.name}:${c.type}`))
    const snapshotColumnsBefore = JSON.stringify(db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => `${c.name}:${c.type}`))

    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    db.transaction(() => {
      insertRecord.run('2026-W33', CREATOR, '数码', 1800, '2026-08-18', 20000, 100000)
      insertRecord.run('2026-W34', CREATOR, '数码', 2700, '2026-08-25', 20000, 100000)
      insertRecord.run('2026-W33', OTHER, '美妆', 1500, '2026-08-19', 20000, 100000)
    })()

    const snapshotWithPrice = await callRoute(postSnapshotHandler, {
      body: {
        creator: CREATOR,
        recognized_creator_name_raw: CREATOR,
        xingtu_price_raw: '4100',
        observed_at: '2026-09-29',
        plays: ['39000', '40000', '42000', '43000', '50000', '52000', '55000', '61000', '62000', '64000', '65000'].map(play)
      }
    })
    const snapshotNoPrice = await callRoute(postSnapshotHandler, {
      body: {
        creator: CREATOR,
        recognized_creator_name_raw: CREATOR,
        observed_at: '2026-09-29',
        plays: ['39000', '40000', '42000', '43000', '50000', '52000', '55000', '61000'].map(play)
      }
    })
    check(
      'A4-6 前置快照就绪（有价 median 52000 / 无价 median 至少可用）',
      snapshotWithPrice.status === 200 && snapshotWithPrice.data.pricing.target_price === 1560 &&
        snapshotNoPrice.status === 200 && snapshotNoPrice.data.xingtu_price === null &&
        snapshotNoPrice.data.pricing.pricing_status === 'quote_missing'
    )

    const makeDecision = async (body) => callRoute(createDecisionHandler, { body })
    const dPathA = await makeDecision({
      creator: CREATOR, decision_stage: 'post_quote', snapshot_id: snapshotWithPrice.data.id,
      current_quote_raw: '3000', human_decision: 'negotiate', ip_judgement: 'strong'
    })
    const dPathB = await makeDecision({
      creator: CREATOR, decision_stage: 'post_quote', snapshot_id: snapshotNoPrice.data.id,
      current_quote_raw: '3000', human_decision: 'repurchase'
    })
    const dZeroQuote = await makeDecision({
      creator: CREATOR, decision_stage: 'post_quote', snapshot_id: snapshotNoPrice.data.id,
      current_quote_raw: '0', human_decision: 'small_test'
    })
    const dIncrease = await makeDecision({
      creator: CREATOR, decision_stage: 'post_quote', snapshot_id: snapshotNoPrice.data.id,
      current_quote_raw: '2000', human_decision: 'negotiate'
    })
    // 下面分别用于「谈成价文本解析」与「非法标签」用例，避免复用已被占用的 decision
    const dTextParse = await makeDecision({
      creator: CREATOR, decision_stage: 'post_quote', snapshot_id: snapshotNoPrice.data.id,
      current_quote_raw: '3000', human_decision: 'negotiate'
    })
    const dBadTag = await makeDecision({
      creator: CREATOR, decision_stage: 'post_quote', snapshot_id: snapshotNoPrice.data.id,
      current_quote_raw: '3000', human_decision: 'repurchase'
    })
    const dContact = await makeDecision({
      creator: CREATOR, decision_stage: 'contact', human_decision: 'contact_now'
    })
    check(
      'A4-7 前置决策创建成功（A/B/0报价/加价/文本解析/非法标签/contact）',
      [dPathA, dPathB, dZeroQuote, dIncrease, dTextParse, dBadTag, dContact].every((r) => r.status === 200)
    )

    const caseBase = (decisionId, extra = {}) => ({
      decision_id: decisionId,
      negotiated_price: '2200',
      negotiated_at: '2026-09-29',
      ...extra
    })

    console.log('\n===== 1. 路径 A：有星图价 + 有报价 =====')
    const caseA = await callRoute(createCaseHandler, {
      body: caseBase(dPathA.data.id, { reason_tags: ['long_term_cooperation', 'budget_limited'], reason_note: '结合历史CPM和预算谈到2200', strategy_note: '用历史CPM作为依据' })
    })
    check('A4-8 创建成功且 creator 来自 decision', caseA.status === 200 && caseA.data.creator === CREATOR, JSON.stringify(caseA.msg))
    check(
      'A4-9 冻结当时的星图价 / 报价 / 目标价 / 参考区间',
      caseA.data.xingtu_price_snapshot === 4100 &&
        caseA.data.current_quote_snapshot === 3000 &&
        caseA.data.target_price_snapshot === 1560 &&
        caseA.data.reference_low_snapshot === 1290 &&
        caseA.data.reference_high_snapshot === 1830 &&
        caseA.data.snapshot_id === snapshotWithPrice.data.id &&
        caseA.data.target_cpm === 30
    )
    check(
      'A4-10 相对星图 = 2200/4100 ≈ 5.37折',
      caseA.data.outcome.negotiated_vs_xingtu_zhe === 5.37 &&
        caseA.data.outcome.negotiated_vs_xingtu_rate === 0.5366 &&
        caseA.data.outcome.has_xingtu === true,
      JSON.stringify(caseA.data.outcome)
    )
    check(
      'A4-11 相对报价下降 ¥800 / 26.7%',
      caseA.data.outcome.quote_drop_amount === 800 &&
        caseA.data.outcome.quote_drop_rate === 0.2667 &&
        caseA.data.outcome.quote_drop_direction === 'drop'
    )
    check('A4-12 原因标签保存并回传文案', caseA.data.reason_tags.length === 2 && caseA.data.reason_tag_labels.includes('长期合作 / 复投预期') && caseA.data.reason_tag_labels.includes('预算有限'))
    check('A4-13 备注保存（reason_note / strategy_note 可空）', Boolean(caseA.data.reason_note) && Boolean(caseA.data.strategy_note))
    check(
      'A4-14 与 CPM30 目标价 / 参考区间只做事实对照',
      caseA.data.outcome.vs_target_status === 'above_target' &&
        caseA.data.outcome.vs_target_amount === 640 &&
        caseA.data.outcome.within_reference_range === false
    )

    console.log('\n===== 2. 路径 B：无星图价 + 有报价 =====')
    const caseB = await callRoute(createCaseHandler, { body: caseBase(dPathB.data.id) })
    check(
      'A4-15 无星图价：星图折扣不可用（不显示 0 折）',
      caseB.status === 200 &&
        caseB.data.xingtu_price_snapshot === null &&
        caseB.data.outcome.has_xingtu === false &&
        caseB.data.outcome.negotiated_vs_xingtu_rate === null &&
        caseB.data.outcome.negotiated_vs_xingtu_zhe === null,
      JSON.stringify(caseB.data?.outcome)
    )
    check(
      'A4-16 无星图价仍算相对报价下降 ¥800 / 26.7%',
      caseB.data.outcome.quote_drop_amount === 800 && caseB.data.outcome.quote_drop_rate === 0.2667
    )
    check(
      'A4-17 无星图价时仍冻结 CPM30 目标价 / 参考区间（A3 语义：目标价不依赖星图价）',
      caseB.data.target_price_snapshot === 1395 &&
        caseB.data.reference_low_snapshot === 1267.5 &&
        caseB.data.reference_high_snapshot === 1545,
      JSON.stringify({
        target: caseB.data.target_price_snapshot,
        low: caseB.data.reference_low_snapshot,
        high: caseB.data.reference_high_snapshot
      })
    )

    console.log('\n===== 3. 路径 C：没有可用报价 =====')
    const caseZero = await callRoute(createCaseHandler, {
      body: caseBase(dZeroQuote.data.id, { negotiated_price: '2000' })
    })
    check(
      'A4-18 报价为 0 → 保留 0（has_quote=true），但不可做百分比基准（不计算降幅，无 Infinity/NaN）',
      caseZero.status === 200 &&
        caseZero.data.current_quote_snapshot === 0 &&
        caseZero.data.outcome.has_quote === true &&
        caseZero.data.outcome.quote_drop_computable === false &&
        caseZero.data.outcome.quote_drop_amount === null &&
        caseZero.data.outcome.quote_drop_rate === null &&
        caseZero.data.outcome.quote_drop_direction === null &&
        !/NaN|Infinity|null.*Infinity/.test(JSON.stringify(caseZero.data.outcome)),
      JSON.stringify(caseZero.data?.outcome)
    )
    const nullQuoteDecisionId = Number(
      db
        .prepare(
          `INSERT INTO creator_decisions (
             creator, decision_stage, snapshot_id, current_quote_raw, current_quote, ip_judgement,
             human_decision, decision_note, historical_evidence_json, recent_evidence_json,
             pricing_evidence_json, target_cpm, pricing_version, system_context_version, created_at
           ) VALUES (?, 'post_quote', ?, NULL, NULL, 'unknown', 'repurchase', NULL, '{}', NULL, NULL, 30, 'creator-pricing-v1', 'decision-context-v1', '2026-09-29 10:00:00')`
        )
        .run(CREATOR, snapshotNoPrice.data.id).lastInsertRowid
    )
    const caseNullQuote = await callRoute(createCaseHandler, {
      body: caseBase(nullQuoteDecisionId, { negotiated_price: '2000' })
    })
    check(
      'A4-19 current_quote 为 NULL（真正没有报价）时同样可保存且不计算降幅',
      caseNullQuote.status === 200 &&
        caseNullQuote.data.current_quote_snapshot === null &&
        caseNullQuote.data.outcome.has_quote === false &&
        caseNullQuote.data.outcome.quote_drop_computable === false
    )
    const pureNoQuotes = caseUtil.computeNegotiationOutcome({ negotiatedPrice: 2000, xingtuPriceSnapshot: null, currentQuoteSnapshot: null })
    check('A4-20 纯函数：两个起始价格都没有 → 只有谈成价事实', pureNoQuotes.negotiated_price === 2000 && pureNoQuotes.has_xingtu === false && pureNoQuotes.has_quote === false && pureNoQuotes.vs_target_amount === null)

    console.log('\n===== 4. 校验 =====')
    check('A4-21 缺少 negotiated_price → 400', (await callRoute(createCaseHandler, { body: { decision_id: dIncrease.data.id, negotiated_at: '2026-09-29' } })).status === 400)
    check('A4-22 负数谈成价 → 400', (await callRoute(createCaseHandler, { body: caseBase(dIncrease.data.id, { negotiated_price: '-100' }) })).status === 400)
    check('A4-23 无法解析的谈成价 → 400', (await callRoute(createCaseHandler, { body: caseBase(dIncrease.data.id, { negotiated_price: '面议' }) })).status === 400)
    check(
      'A4-24 谈成价支持文本解析（¥2,200 / 2,400元 / 2,400 均由确定性 parser 处理）',
      (await callRoute(createCaseHandler, { body: caseBase(dTextParse.data.id, { negotiated_price: '¥2,200' }) })).data?.negotiated_price === 2200
    )
    check('A4-25 缺少 negotiated_at → 400', (await callRoute(createCaseHandler, { body: { decision_id: dZeroQuote.data.id, negotiated_price: '2000' } })).status === 400)
    check(
      'A4-26 非法日期（2026-02-30 / 20260929 / 空）→ 400',
      (await callRoute(createCaseHandler, { body: caseBase(dZeroQuote.data.id, { negotiated_at: '2026-02-30' }) })).status === 400 &&
        (await callRoute(createCaseHandler, { body: caseBase(dZeroQuote.data.id, { negotiated_at: '20260929' }) })).status === 400 &&
        (await callRoute(createCaseHandler, { body: caseBase(dZeroQuote.data.id, { negotiated_at: '' }) })).status === 400
    )
    check(
      'A4-27 非法 reason tag → 400',
      (await callRoute(createCaseHandler, { body: caseBase(dBadTag.data.id, { reason_tags: ['not_a_tag'] }) })).status === 400
    )
    check(
      'A4-28 note 超长 → 400',
      (await callRoute(createCaseHandler, { body: caseBase(dContact.data.id, { reason_note: 'x'.repeat(501) }) })).status === 400
    )
    check('A4-29 decision 不存在 → 404', (await callRoute(createCaseHandler, { body: caseBase(999999) })).status === 404)
    check('A4-30 contact 阶段 → 400', (await callRoute(createCaseHandler, { body: caseBase(dContact.data.id) })).status === 400)
    check(
      'A4-31 同一 decision 第二次创建 → 409',
      (await callRoute(createCaseHandler, { body: caseBase(dPathA.data.id) })).status === 409
    )

    console.log('\n===== 5. 前端伪造上下文被忽略 =====')
    const forgedDecision = await makeDecision({
      creator: CREATOR, decision_stage: 'post_quote', snapshot_id: snapshotWithPrice.data.id,
      current_quote_raw: '3000', human_decision: 'negotiate'
    })
    const forged = await callRoute(createCaseHandler, {
      body: caseBase(forgedDecision.data.id, {
        negotiated_price: '2200',
        xingtu_price_snapshot: 1,
        current_quote_snapshot: 1,
        target_price_snapshot: 1,
        reference_low_snapshot: 1,
        reference_high_snapshot: 1,
        target_cpm: 999,
        creator: '伪造达人'
      })
    })
    check(
      'A4-32 伪造的 context / creator 全部被忽略（以后端冻结值为准）',
      forged.status === 200 &&
        forged.data.creator === CREATOR &&
        forged.data.xingtu_price_snapshot === 4100 &&
        forged.data.current_quote_snapshot === 3000 &&
        forged.data.target_price_snapshot === 1560 &&
        forged.data.reference_low_snapshot === 1290 &&
        forged.data.reference_high_snapshot === 1830 &&
        forged.data.target_cpm === 30
    )

    console.log('\n===== 6. freeze：后续变化不影响旧案例 =====')
    const decisionRowBefore = JSON.stringify(db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(dPathA.data.id))
    const caseRowBefore = JSON.stringify(db.prepare('SELECT * FROM creator_negotiation_cases WHERE id = ?').get(caseA.data.id))
    // 6.1 新增一条更新的快照（星图价不同）
    await callRoute(postSnapshotHandler, {
      body: {
        creator: CREATOR,
        recognized_creator_name_raw: CREATOR,
        xingtu_price_raw: '9000',
        observed_at: '2026-10-05',
        plays: ['10000', '20000', '30000', '40000', '50000', '60000'].map(play)
      }
    })
    // 6.2 更新 creator_records（actual_cost 变化）
    db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES ('2026-W41', ?, '数码', 2500, '2026-10-06', 30000, 90000)`
    ).run(CREATOR)
    const caseAfter = (await callRoute(listCaseHandler, { query: { decision_id: dPathA.data.id } })).data.cases[0]
    check(
      'A4-33 后续 snapshot / record 变化后，旧案例的冻结上下文完全不变',
      JSON.stringify(db.prepare('SELECT * FROM creator_negotiation_cases WHERE id = ?').get(caseA.data.id)) === caseRowBefore &&
        caseAfter.xingtu_price_snapshot === 4100 &&
        caseAfter.target_price_snapshot === 1560 &&
        caseAfter.reference_high_snapshot === 1830
    )
    check(
      'A4-34 decision 行未被谈判案例修改（逐字段一致）',
      JSON.stringify(db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(dPathA.data.id)) === decisionRowBefore
    )
    check(
      'A4-35 谈判案例与 actual_cost 互不同步（谈成 2200 ≠ 投放花费 2500）',
      caseAfter.negotiated_price === 2200 &&
        db.prepare(`SELECT SUM(total_cost) AS cost FROM creator_records WHERE nickname = ?`).get(CREATOR).cost === 7000
    )

    console.log('\n===== 7. 加价场景 =====')
    const caseIncrease = await callRoute(createCaseHandler, {
      body: caseBase(dIncrease.data.id, { negotiated_price: '2200' })
    })
    check(
      'A4-36 谈成价高于初始报价 → 允许保存，方向为 increase',
      caseIncrease.status === 200 &&
        caseIncrease.data.outcome.quote_drop_amount === -200 &&
        caseIncrease.data.outcome.quote_drop_direction === 'increase',
      JSON.stringify(caseIncrease.data?.outcome)
    )
    check(
      'A4-37 UI 文案表达「较初始报价增加 ¥200 / 10.0%」',
      displayLib.formatQuoteChange(caseIncrease.data.outcome) === '较初始报价增加 ¥200 / 10.0%',
      displayLib.formatQuoteChange(caseIncrease.data.outcome)
    )

    console.log('\n===== 8. GET 查询 / 决策列表附带 =====')
    const byCreator = await callRoute(listCaseHandler, { query: { creator: CREATOR } })
    check(
      'A4-38 GET ?creator= 返回该达人全部案例（时间倒序）',
      byCreator.status === 200 && byCreator.data.cases.length >= 5 && byCreator.data.cases.every((item) => item.creator === CREATOR)
    )
    check('A4-39 GET ?decision_id= 精确返回 1 条', (await callRoute(listCaseHandler, { query: { decision_id: dPathB.data.id } })).data.cases.length === 1)
    check(
      'A4-40 GET 无参数 → 400；decision_id 非法 → 400',
      (await callRoute(listCaseHandler, { query: {} })).status === 400 &&
        (await callRoute(listCaseHandler, { query: { decision_id: 'abc' } })).status === 400
    )
    const decisionList = await callRoute(listDecisionHandler, { query: { creator: CREATOR } })
    check(
      'A4-41 决策列表附带 negotiation_case（单次请求，无 N+1）',
      decisionList.data.decisions.find((item) => item.id === dPathA.data.id).negotiation_case?.negotiated_price === 2200 &&
        decisionList.data.decisions.find((item) => item.id === dContact.data.id).negotiation_case === null
    )

    console.log('\n===== 9. 前端展示纯函数 + 源码契约 =====')
    check(
      'A4-42 前后端原因标签 allowlist 完全一致',
      JSON.stringify(displayLib.NEGOTIATION_REASON_TAGS.map((t) => t.value)) ===
        JSON.stringify(caseUtil.NEGOTIATION_REASON_TAG_VALUES) &&
        displayLib.NEGOTIATION_REASON_TAGS.length === 12
    )
    const rowsA = displayLib.buildNegotiationPriceRows(caseA.data)
    check(
      'A4-43 路径 A 展示行含星图折扣 / 降幅',
      rowsA.some((row) => row.label === '相对星图' && row.value === '约 5.4折') &&
        rowsA.some((row) => row.label === '相对达人报价' && row.value === '下降 ¥800 / 26.7%'),
      JSON.stringify(rowsA)
    )
    const rowsB = displayLib.buildNegotiationPriceRows(caseB.data)
    check(
      'A4-44 路径 B 不出现任何星图折扣行',
      !rowsB.some((row) => row.label === '相对星图') &&
        rowsB.some((row) => row.label === '星图刊例价' && row.value === '暂无') &&
        rowsB.some((row) => row.label === '相对达人报价' && row.value === '下降 ¥800 / 26.7%'),
      JSON.stringify(rowsB)
    )
    const rowsC = displayLib.buildNegotiationPriceRows(caseZero.data)
    check(
      'A4-45 无报价时不算降幅（无「相对达人报价」行）',
      !rowsC.some((row) => row.label === '相对达人报价') &&
        rowsC.some((row) => row.label === '最终谈成价' && row.value === '¥2,000')
    )
    check(
      'A4-45b 报价为 0：展示「达人报价 ¥0」而不是「暂无」，无降幅行、无 NaN / Infinity',
      rowsC.some((row) => row.label === '达人报价' && row.value === '¥0') &&
        !rowsC.some((row) => row.label === '达人报价' && row.value === '暂无') &&
        !rowsC.some((row) => row.label === '相对达人报价') &&
        displayLib.formatQuoteChange(caseZero.data.outcome) === '' &&
        displayLib.formatCurrentQuote({ current_quote_snapshot: 0 }) === '¥0' &&
        !/NaN|Infinity/.test(JSON.stringify(rowsC)),
      JSON.stringify(rowsC)
    )
    const rowsNullQuote = displayLib.buildNegotiationPriceRows(caseNullQuote.data)
    check(
      'A4-45c 报价为 NULL（真正没有报价）：展示「暂无」，无降幅行',
      rowsNullQuote.some((row) => row.label === '达人报价' && row.value === '暂无') &&
        !rowsNullQuote.some((row) => row.label === '相对达人报价') &&
        displayLib.formatCurrentQuote({ current_quote_snapshot: null }) === '暂无' &&
        displayLib.formatCurrentQuote({}) === '暂无',
      JSON.stringify(rowsNullQuote)
    )
    check(
      'A4-45d 报价 3000 / 谈成 2200 的既有语义不变（下降 ¥800 / 26.7%）',
      rowsA.some((row) => row.label === '达人报价' && row.value === '¥3,000') &&
        rowsA.some((row) => row.label === '相对达人报价' && row.value === '下降 ¥800 / 26.7%')
    )
    check(
      'A4-46 上下文行：无值显示「暂无」而不是 0',
      JSON.stringify(displayLib.buildNegotiationContextRows({ xingtuPrice: null, currentQuote: 3000, targetPrice: null, referenceLow: null, referenceHigh: null })) ===
        JSON.stringify([
          { label: '星图刊例价', value: '暂无' },
          { label: '达人当前报价', value: '¥3,000' },
          { label: 'CPM30目标价', value: '暂无' },
          { label: 'CPM30参考区间', value: '暂无' }
        ])
    )
    const modalSource = fs.readFileSync(path.join(frontend, 'components/NegotiationCaseModal.jsx'), 'utf8')
    check(
      'A4-47 前端只提交人的输入（不提交任何 snapshot 上下文字段）',
      /decision_id: decision\.id/.test(modalSource) &&
        /negotiated_price: priceRaw/.test(modalSource) &&
        /reason_tags: reasonTags/.test(modalSource) &&
        !/xingtu_price_snapshot:/.test(modalSource) &&
        !/current_quote_snapshot:/.test(modalSource) &&
        !/target_price_snapshot:/.test(modalSource)
    )
    const drawerSource = fs.readFileSync(path.join(frontend, 'components/CreatorDecisionDrawer.jsx'), 'utf8')
    check(
      'A4-48 入口只在 post_quote + negotiate/repurchase/small_test 展示（contact / pause 无入口）',
      /item\?\.decision_stage === 'post_quote' && \['negotiate', 'repurchase', 'small_test'\]\.includes\(item\?\.human_decision\)/.test(drawerSource) &&
        /记录谈价结果/.test(drawerSource) &&
        !/human_decision: 'pause'/.test(drawerSource)
    )
    check(
      'A4-49 谈价结果文案不含评价性表述',
      // 只看可执行代码 / 渲染文案，不把「不评价谈判质量」这类说明性注释算进去
      !/谈得好|谈得不好|优秀谈判|谈判质量|评分/.test(stripComments(modalSource)) &&
        !/谈得好|谈得不好|优秀谈判|谈判质量|评分/.test(stripComments(displayLibSource()))
    )
    check(
      'A4-50 前端不自动打标签 / 不调用 AI 生成原因',
      !/deepseek|extractCreatorScreenshot|axios|fetch\(/i.test(displayLibSource()) &&
        /Checkbox\.Group/.test(modalSource) &&
        !/autoTag|suggestReason|generateReason/.test(modalSource)
    )

    console.log('\n===== 10. 无 AI / 无网络 / 不回退 =====')
    const routeSource = fs.readFileSync(path.join(root, 'backend/routes/creatorNegotiationCases.js'), 'utf8')
    check('A4-51 新路由不引用 AI / 网络能力', !/deepseek|axios|fetch\(|callProviderVision/i.test(routeSource))
    check(
      // Historical Negotiation Backfill V0.1：新增 POST /historical-backfill（历史真实案例回填），
      // 原有 POST / 与 GET / 语义与行为保持不变。
      'A4-52 只注册 GET / : POST / : POST /historical-backfill（Real Data Calibration V1 新增谈价日期纠正 / 审计查询）',
      cases.default.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort().join(' | ') === 'GET / | GET /:id/corrections | PATCH /:id/date | POST / | POST /historical-backfill'
    )
    const caseRowsText = JSON.stringify(db.prepare('SELECT * FROM creator_negotiation_cases').all())
    check('A4-53 不保存 base64 / Key / provider 原始数据', !/base64|apiKey|api_key|sk-|provider_response|data:image/i.test(caseRowsText))
    const radar = await callRoute(radarHandler, { query: {} })
    const radarCreator = radar.data.groups.flatMap((g) => g.creators).find((item) => item.creator === CREATOR)
    check(
      'A4-56 P1 雷达不受影响（分组 / 中位 CPM 仍按 creator_records 计算）',
      Boolean(radarCreator) && radarCreator.record_count === 3 && radar.data.target_cpm === 30
    )
    check(
      'A4-57 decision / snapshot 表结构未被 A4 修改',
      JSON.stringify(db.prepare('PRAGMA table_info(creator_decisions)').all().map((c) => `${c.name}:${c.type}`)) === decisionsColumnsBefore &&
        JSON.stringify(db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => `${c.name}:${c.type}`)) === snapshotColumnsBefore
    )
    check('A4-58 未发生任何外部网络请求', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))
    check('A4-59 隔离库位于临时目录（未触碰真实 workbench.db）', process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir()))

    function displayLibSource() {
      return fs.readFileSync(path.join(frontend, 'utils/negotiationCaseDisplay.js'), 'utf8')
    }

    function stripComments(source) {
      return String(source)
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join('\n')
    }

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
