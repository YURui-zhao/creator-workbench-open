#!/usr/bin/env node
/**
 * 决策记录层（V3-alpha P4）回归测试
 *
 * 运行方式：node tests/creator_decisions.test.js
 * 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
 * 网络：拦截 http/https/net/tls/fetch —— P4 不调用 AI、不访问外部网络。
 *
 * 重点：decision 是历史快照 —— 创建后即使新增 record / snapshot 也不得改变已固化证据。
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

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-decisions-'))
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
      throw new Error('P4 test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('P4 test forbids network requests')
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
    const decisions = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorDecisions.js')).href
    )
    const snapshots = await import(
      pathToFileURL(path.join(root, 'backend/routes/recentSnapshots.js')).href
    )
    const records = await import(pathToFileURL(path.join(root, 'backend/routes/records.js')).href)
    const rules = await import(
      pathToFileURL(path.join(root, 'backend/utils/creatorBusinessRules.js')).href
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
    const previewHandler = findHandler(decisions.default, '/preview', 'post')
    const postSnapshotHandler = findHandler(snapshots.default, '/', 'post')
    const radarHandler = findHandler(records.default, '/repurchase-radar', 'get')

    const callRoute = async (handler, { body = {}, query = {}, headers = {} } = {}) => {
      const res = response()
      await handler({ body, query, headers }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    console.log('===== 0. 表结构 / 前置数据 =====')
    const columns = db.prepare('PRAGMA table_info(creator_decisions)').all()
    const columnMap = Object.fromEntries(columns.map((c) => [c.name, c]))
    check(
      'creator_decisions 字段齐全',
      ['id', 'creator', 'decision_stage', 'snapshot_id', 'current_quote_raw', 'current_quote',
        'ip_judgement', 'human_decision', 'decision_note', 'historical_evidence_json',
        'recent_evidence_json', 'pricing_evidence_json', 'target_cpm', 'pricing_version',
        'system_context_version', 'created_at'].every((name) => name in columnMap),
      JSON.stringify(Object.keys(columnMap))
    )
    check('每一列都显式声明类型（无共享类型写法）', columns.every((c) => c.type && c.type.trim()))
    check(
      '存在 (creator, created_at) 索引',
      db.prepare('PRAGMA index_list(creator_decisions)').all().map((i) => i.name).includes('idx_creator_decisions_creator_created')
    )
    const v2Tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
    check(
      'V2 表与 P2B 表都未被改动',
      ['creator_records', 'creator_recent_snapshots', 'import_batches', 'import_batch_records', 'import_batch_items', 'projects'].every((t) => v2Tables.includes(t)),
      JSON.stringify(v2Tables)
    )
    const snapshotColumnsBefore = db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => `${c.name}:${c.type}`)

    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    db.transaction(() => {
      insertRecord.run('2026-W33', 'Gary', '数码', 1800, '2026-08-18', 20000, 100000)
      insertRecord.run('2026-W34', 'Gary', '数码', 2700, '2026-08-25', 20000, 100000)
      insertRecord.run('2026-W35', 'Gary', '数码', 4600, '2026-09-01', 20000, 100000)
      insertRecord.run('2026-W35', 'Alice', '美妆', 2000, '2026-09-02', 20000, 100000)
    })()

    const snapshotPayload = (creator, priceRaw, plays) => ({
      creator,
      recognized_creator_name_raw: creator,
      xingtu_price_raw: priceRaw,
      // Alpha.2：数据观察日期必填
      observed_at: '2026-09-26',
      plays: plays.map(play)
    })
    const garySnapshot = await callRoute(postSnapshotHandler, {
      body: snapshotPayload('Gary', '3000元', ['39000', '40000', '42000', '43000', '50000', '52000', '55000', '61000', '62000', '64000', '65000'])
    })
    check('Gary 快照创建成功（median 52000 / xingtu 3000）', garySnapshot.status === 200 && garySnapshot.data.median_play === 52000 && garySnapshot.data.xingtu_price === 3000)

    console.log('\n===== 1. contact 决策 =====')
    const contactNoSnapshot = await callRoute(createHandler, {
      body: { creator: 'Alice', decision_stage: 'contact', ip_judgement: 'strong', human_decision: 'contact_now', decision_note: '内容有强人设' }
    })
    check('contact 可无 snapshot 保存', contactNoSnapshot.status === 200 && contactNoSnapshot.data.snapshot_id === null, JSON.stringify(contactNoSnapshot.msg))
    check('contact 记录 recent/pricing evidence 为 null', contactNoSnapshot.data.recent_evidence === null && contactNoSnapshot.data.pricing_evidence.xingtu_pricing === null)
    check('contact human_decision = contact_now（开始建联）', contactNoSnapshot.data.human_decision === 'contact_now' && contactNoSnapshot.data.human_decision_label === '开始建联')
    const contactWithQuote = await callRoute(createHandler, {
      body: { creator: 'Alice', decision_stage: 'contact', human_decision: 'observe', current_quote_raw: '2400' }
    })
    check('contact 不允许携带实际报价 → 400', contactWithQuote.status === 400 && /不允许填写实际报价/.test(contactWithQuote.msg), contactWithQuote.msg)
    check(
      'contact human_decision 枚举校验',
      (await callRoute(createHandler, { body: { creator: 'Alice', decision_stage: 'contact', human_decision: 'repurchase' } })).status === 400
    )
    check(
      'ip_judgement 枚举校验',
      (await callRoute(createHandler, { body: { creator: 'Alice', decision_stage: 'contact', human_decision: 'observe', ip_judgement: 'super' } })).status === 400
    )

    console.log('\n===== 2. post_quote 决策（含报价重算）=====')
    const postNoSnapshot = await callRoute(createHandler, {
      body: { creator: 'Gary', decision_stage: 'post_quote', current_quote_raw: '2400', human_decision: 'negotiate' }
    })
    check('post_quote 缺少 snapshot_id → 400', postNoSnapshot.status === 400 && /必须提供 snapshot_id/.test(postNoSnapshot.msg), postNoSnapshot.msg)
    const postNoQuote = await callRoute(createHandler, {
      body: { creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id, human_decision: 'negotiate' }
    })
    check('post_quote 缺少实际报价 → 400', postNoQuote.status === 400 && /必须填写实际报价/.test(postNoQuote.msg), postNoQuote.msg)
    const snapshotMismatch = await callRoute(createHandler, {
      body: { creator: 'Alice', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id, current_quote_raw: '2400', human_decision: 'negotiate' }
    })
    check('snapshot.creator 与 creator 不一致 → 400', snapshotMismatch.status === 400 && /不能绑定给/.test(snapshotMismatch.msg), snapshotMismatch.msg)
    check(
      'creator 不存在 → 400',
      (await callRoute(createHandler, { body: { creator: '不存在的达人', decision_stage: 'contact', human_decision: 'observe' } })).status === 400
    )
    check(
      'snapshot 不存在 → 400',
      (await callRoute(createHandler, { body: { creator: 'Gary', decision_stage: 'post_quote', snapshot_id: 99999, current_quote_raw: '2400', human_decision: 'negotiate' } })).status === 400
    )
    check(
      'post_quote human_decision 枚举校验',
      (await callRoute(createHandler, { body: { creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id, current_quote_raw: '2400', human_decision: 'contact_now' } })).status === 400
    )

    console.log('\n===== 3. 实际报价解析 / 校验 =====')
    const previewOf = (raw, creator = 'Gary', snapshotId = garySnapshot.data.id) =>
      callRoute(previewHandler, { body: { creator, snapshot_id: snapshotId, current_quote_raw: raw } })
    for (const [raw, expected] of [['¥2400', 2400], ['2400元', 2400], ['2,400', 2400], ['0', 0]]) {
      const preview = await previewOf(raw)
      check(`报价解析 ${raw} → ${expected}`, preview.status === 200 && preview.data.current_quote === expected, `${preview.status}/${preview.data?.current_quote}`)
    }
    check('负数报价被拒绝', (await previewOf('-100')).status === 400)
    check('非法报价被拒绝', (await previewOf('面议吧')).status === 400)
    check('报价 0 是合法值（不是缺失）', (await previewOf('0')).data.current_quote === 0)
    const preview2400 = (await previewOf('2400')).data
    check(
      'preview 不再包含 current_quote_pricing（实际报价不是新的折扣基准）',
      preview2400.current_quote_pricing === undefined && preview2400.current_quote_assessment !== undefined
    )
    check(
      'preview 星图 pricing 仍基于星图价（deeper_negotiation_within_range）',
      preview2400.xingtu_pricing.pricing_status === 'deeper_negotiation_within_range',
      preview2400.xingtu_pricing.pricing_status
    )
    check('actual_vs_xingtu_zhe = 2400/3000 = 8折', preview2400.current_quote_assessment.actual_vs_xingtu_zhe === 8, String(preview2400.current_quote_assessment.actual_vs_xingtu_zhe))
    check(
      '8折高于 2～7折可谈区间 → above_range',
      preview2400.current_quote_assessment.negotiation_range_status === 'above_range' &&
        /高于设定的2～7折谈价区间上限/.test(preview2400.current_quote_assessment.negotiation_range_status_label),
      preview2400.current_quote_assessment.negotiation_range_status_label
    )
    check(
      '实际报价仍高于 CPM30参考区间 → above_reference_range',
      preview2400.current_quote_assessment.current_quote_status === 'above_reference_range'
    )
    check(
      '差额：距参考区间 ¥570、距目标价 ¥840（无负值）',
      preview2400.current_quote_assessment.gap_to_reference_high === 570 &&
        preview2400.current_quote_assessment.gap_to_target === 840,
      JSON.stringify({ high: preview2400.current_quote_assessment.gap_to_reference_high, target: preview2400.current_quote_assessment.gap_to_target })
    )
    const preview1800 = (await previewOf('1800')).data.current_quote_assessment
    check(
      'actual 1800（6折）→ within_range 且处于 CPM30参考区间内',
      preview1800.actual_vs_xingtu_zhe === 6 &&
        preview1800.negotiation_range_status === 'within_range' &&
        preview1800.current_quote_status === 'within_reference_range' &&
        preview1800.gap_to_reference_high === 0,
      JSON.stringify(preview1800)
    )
    const preview1560 = (await previewOf('1560')).data.current_quote_assessment
    check(
      'actual 1560（5.2折）→ within_range 且已达到目标价',
      preview1560.actual_vs_xingtu_zhe === 5.2 &&
        preview1560.negotiation_range_status === 'within_range' &&
        preview1560.current_quote_status === 'at_or_below_target' &&
        preview1560.gap_to_target === 0,
      JSON.stringify(preview1560)
    )
    const previewZero = (await previewOf('0')).data.current_quote_assessment
    check('actual 0 → quote_zero 且折扣区间为 below_range', previewZero.current_quote_status === 'quote_zero' && previewZero.negotiation_range_status === 'below_range', JSON.stringify(previewZero))

    console.log('\n===== 4. 保存 / append-only / 证据固化 =====')
    const decision1 = await callRoute(createHandler, {
      body: {
        creator: 'Gary', decision_stage: 'post_quote', snapshot_id: garySnapshot.data.id,
        current_quote_raw: '¥2400', ip_judgement: 'strong', human_decision: 'negotiate', decision_note: '商单融入自然',
        // 前端伪造 authoritative 字段，必须被忽略
        target_cpm: 999, pricing_version: 'evil', historical_evidence: { median_cpm: -1 },
        pricing_evidence: { fake: true }, current_quote: 1
      }
    })
    check('post_quote 保存成功', decision1.status === 200, JSON.stringify(decision1.msg))
    check('current_quote 由后端解析（¥2400 → 2400）', decision1.data.current_quote === 2400 && decision1.data.current_quote_raw === '¥2400')
    check('伪造的 target_cpm / pricing_version 被忽略', decision1.data.target_cpm === 30 && decision1.data.pricing_version === 'creator-pricing-v1')
    check('伪造的 evidence 被忽略（historical 由后端重建）', decision1.data.historical_evidence.median_cpm === 27 && decision1.data.pricing_evidence.fake === undefined)
    check('historical evidence 固化 P1 字段', decision1.data.historical_evidence.record_count === 3 && decision1.data.historical_evidence.valid_cpm_count === 3 && decision1.data.historical_evidence.pass_count === 2 && decision1.data.historical_evidence.fail_count === 1 && decision1.data.historical_evidence.historical_status === 'passed', JSON.stringify(decision1.data.historical_evidence))
    check('recent evidence 固化 P2B 字段', decision1.data.recent_evidence.snapshot_id === garySnapshot.data.id && decision1.data.recent_evidence.median_play === 52000 && decision1.data.recent_evidence.xingtu_price === 3000)
    check(
      'pricing evidence = { xingtu_pricing, current_quote_assessment }（无 current_quote_pricing）',
      decision1.data.pricing_evidence.xingtu_pricing.pricing_status === 'deeper_negotiation_within_range' &&
        decision1.data.pricing_evidence.current_quote_assessment !== undefined &&
        decision1.data.pricing_evidence.current_quote_pricing === undefined
    )
    check(
      'actual_vs_xingtu / 差额 / 状态固化',
      decision1.data.pricing_evidence.current_quote_assessment.actual_vs_xingtu_rate === 0.8 &&
        decision1.data.pricing_evidence.current_quote_assessment.actual_vs_xingtu_zhe === 8 &&
        decision1.data.pricing_evidence.current_quote_assessment.gap_to_reference_high === 570 &&
        decision1.data.pricing_evidence.current_quote_assessment.gap_to_target === 840 &&
        decision1.data.pricing_evidence.current_quote_assessment.current_quote_status === 'above_reference_range'
    )
    check('ip_judgement / human_decision / note 保存', decision1.data.ip_judgement === 'strong' && decision1.data.human_decision === 'negotiate' && decision1.data.decision_note === '商单融入自然')
    check('system_context_version 保存', decision1.data.system_context_version === 'decision-context-v1')

    const decision2 = await callRoute(createHandler, {
      body: { creator: 'Gary', decision_stage: 'contact', snapshot_id: garySnapshot.data.id, human_decision: 'contact_now' }
    })
    check('append-only：同达人两次保存是两条', decision2.status === 200 && decision2.data.id !== decision1.data.id)
    check('快照行数不变（decision 不写入 snapshot 表）', db.prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots WHERE creator = ?').get('Gary').n === 1)

    console.log('\n===== 5. 星图价缺失 / 报价重算不依赖星图价 =====')
    const aliceSnapshot = await callRoute(postSnapshotHandler, {
      body: snapshotPayload('Alice', '面议', ['39000', '40000', '42000', '43000', '50000', '52000', '55000', '61000', '62000', '64000', '65000'])
    })
    const noXingtuPreview = await callRoute(previewHandler, {
      body: { creator: 'Alice', snapshot_id: aliceSnapshot.data.id, current_quote_raw: '2400' }
    })
    check(
      '星图价缺失时 actual_vs_xingtu 为 null（折扣区间 unavailable）',
      noXingtuPreview.status === 200 &&
        noXingtuPreview.data.current_quote_assessment.actual_vs_xingtu_rate === null &&
        noXingtuPreview.data.current_quote_assessment.actual_vs_xingtu_zhe === null
    )
    check(
      '星图价缺失时 CPM30 评估仍正常（仅折扣区间不可用）',
      noXingtuPreview.data.xingtu_pricing.target_price === 1560 &&
        noXingtuPreview.data.current_quote_assessment.actual_vs_xingtu_zhe === null &&
        noXingtuPreview.data.current_quote_assessment.negotiation_range_status === 'unavailable' &&
        noXingtuPreview.data.current_quote_assessment.current_quote_status === 'above_reference_range',
      JSON.stringify(noXingtuPreview.data.current_quote_assessment)
    )
    const aliceDecision = await callRoute(createHandler, {
      body: { creator: 'Alice', decision_stage: 'post_quote', snapshot_id: aliceSnapshot.data.id, current_quote_raw: '1500', ip_judgement: 'medium', human_decision: 'small_test' }
    })
    check('星图价缺失仍可保存 post_quote', aliceDecision.status === 200 && aliceDecision.data.pricing_evidence.current_quote_assessment.actual_vs_xingtu_zhe === null)
    check(
      'actual quote <= target → 无需继续为了 CPM30 议价（但仍由人决定）',
      aliceDecision.data.pricing_evidence.current_quote_assessment.current_quote_status === 'at_or_below_target' &&
        aliceDecision.data.pricing_evidence.current_quote_assessment.gap_to_target === 0 &&
        aliceDecision.data.human_decision === 'small_test'
    )
    check('current_quote 不覆盖 snapshot.xingtu_price', db.prepare('SELECT xingtu_price FROM creator_recent_snapshots WHERE id = ?').get(aliceSnapshot.data.id).xingtu_price === null)

    console.log('\n===== 6. 不可漂移：后续数据不改变旧 decision =====')
    const before = (await callRoute(listHandler, { query: { creator: 'Gary' } })).data.decisions
    const frozen = JSON.stringify(before)
    // 新增 creator_record（会改变 Gary 的历史 CPM 证据与 P1 分组）
    insertRecord.run('2026-W36', 'Gary', '数码', 2000, '2026-09-08', 20000, 100000)
    // 新增 snapshot（会改变 recent evidence / pricing）
    await callRoute(postSnapshotHandler, {
      body: snapshotPayload('Gary', '5000元', ['10000', '20000', '30000', '40000', '50000', '60000', '70000', '80000', '90000', '100000', '110000'])
    })
    const after = (await callRoute(listHandler, { query: { creator: 'Gary' } })).data.decisions
    check('新增 record / snapshot 后旧 decision 完全不变（historical/recent/pricing/target_cpm/version）', JSON.stringify(after) === frozen)
    check('旧 decision 的 historical evidence 仍是创建时的 3 次 / passed', after.find((d) => d.id === decision1.data.id).historical_evidence.record_count === 3 && after.find((d) => d.id === decision1.data.id).historical_evidence.historical_status === 'passed')
    check(
      '旧 decision 的 pricing 仍是创建时的值（含 assessment 状态与差额）',
      after.find((d) => d.id === decision1.data.id).pricing_evidence.xingtu_pricing.pricing_status === 'deeper_negotiation_within_range' &&
        after.find((d) => d.id === decision1.data.id).pricing_evidence.current_quote_assessment.gap_to_target === 840
    )

    console.log('\n===== 7. 列表 / 隔离 / 无副作用 =====')
    const garyList = await callRoute(listHandler, { query: { creator: 'Gary' } })
    check('GET 时间倒序（最新在前）', garyList.data.decisions[0].id === decision2.data.id, JSON.stringify(garyList.data.decisions.map((d) => d.id)))
    check('GET 按 creator 隔离', garyList.data.decisions.every((d) => d.creator === 'Gary') && (await callRoute(listHandler, { query: { creator: 'Alice' } })).data.decisions.every((d) => d.creator === 'Alice'))
    check('GET 缺少 creator → 400', (await callRoute(listHandler, { query: {} })).status === 400)
    const decisionCountBefore = db.prepare('SELECT COUNT(*) AS n FROM creator_decisions').get().n
    await previewOf('2000')
    check('preview 不写库', db.prepare('SELECT COUNT(*) AS n FROM creator_decisions').get().n === decisionCountBefore)
    check(
      'preview 与最终保存的 assessment 完全一致',
      JSON.stringify((await previewOf('2400')).data.current_quote_assessment) ===
        JSON.stringify(decision1.data.pricing_evidence.current_quote_assessment)
    )

    console.log('\n===== 8. 与 P1 / P2 / P3 相互独立 =====')
    const stripVolatile = (item) => {
      // recent_snapshot / recent_decision 是 P2B/P4 的附加展示字段，不属于 P1 判断结果
      const { recent_snapshot: _s, recent_decision: _d, ...rest } = item
      return rest
    }
    const radarBeforeDecision = await callRoute(radarHandler, { query: {} })
    await callRoute(createHandler, {
      body: { creator: 'Gary', decision_stage: 'contact', human_decision: 'observe', ip_judgement: 'weak' }
    })
    const radarAfterDecision = await callRoute(radarHandler, { query: {} })
    check(
      'decision 创建前后 P1 group/order 完全一致',
      JSON.stringify(radarBeforeDecision.data.groups.map((g) => ({ key: g.key, creators: g.creators.map((c) => c.creator) }))) ===
        JSON.stringify(radarAfterDecision.data.groups.map((g) => ({ key: g.key, creators: g.creators.map((c) => c.creator) })))
    )
    check(
      'decision 创建前后 P1 字段完全一致',
      JSON.stringify(radarBeforeDecision.data.groups.flatMap((g) => g.creators).map(stripVolatile)) ===
        JSON.stringify(radarAfterDecision.data.groups.flatMap((g) => g.creators).map(stripVolatile))
    )
    const snapshotRowAfter = db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(garySnapshot.data.id)
    check(
      'decision 创建前后 P2B 快照统计完全一致',
      snapshotRowAfter.median_play === 52000 && snapshotRowAfter.p25_play === 43000 && snapshotRowAfter.p75_play === 61000 && snapshotRowAfter.valid_count === 11
    )
    check(
      'decision 创建前后 P3 latest pricing 完全一致',
      (await callRoute(radarHandler, { query: {} })).data.groups.flatMap((g) => g.creators).find((c) => c.creator === 'Gary').recent_snapshot.pricing.pricing_version === 'creator-pricing-v1'
    )
    check('creator_records 未被 decision 修改', db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n === 5)
    check(
      'radar 携带最近决策 summary（不额外请求）',
      radarAfterDecision.data.groups.flatMap((g) => g.creators).find((c) => c.creator === 'Gary')?.recent_decision?.human_decision === 'observe' &&
        radarAfterDecision.data.groups.flatMap((g) => g.creators).find((c) => c.creator === 'Alice')?.recent_decision?.decision_stage === 'post_quote'
    )
    const originalPrepare = db.prepare.bind(db)
    let prepareCount = 0
    db.prepare = (sql) => { prepareCount += 1; return originalPrepare(sql) }
    await callRoute(radarHandler, { query: {} })
    db.prepare = originalPrepare
    check('radar 合并 pricing + decision 后仍为少量 SQL', prepareCount <= 5, `prepare=${prepareCount}`)

    console.log('\n===== 9. 安全与只读实现 =====')
    const routeSource = fs.readFileSync(path.join(root, 'backend/routes/creatorDecisions.js'), 'utf8')
    check('P4 路由不引用 AI / 网络能力', !/deepseek|axios|fetch\(|callProviderVision|extract-creator-screenshot/i.test(routeSource))
    check(
      'P4 只注册 POST / 、POST /preview、GET /（Real Data Calibration V1 新增日期纠正 / 作废 / 审计查询）',
      decisions.default.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort().join(' | ') === 'GET / | GET /:id/corrections | PATCH /:id/date | POST / | POST /:id/void | POST /preview',
      decisions.default.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).join(' | ')
    )
    const decisionRowsText = JSON.stringify(db.prepare('SELECT * FROM creator_decisions').all())
    check('不保存 base64 / key / provider 原始响应', !/base64|apiKey|api_key|sk-|provider_response|data:image/i.test(decisionRowsText))
    check('决策记录不含截图内容', !/blob:|\.png|\.jpg/.test(decisionRowsText))
    check('snapshot 表结构未被 P4 修改', JSON.stringify(db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => `${c.name}:${c.type}`)) === JSON.stringify(snapshotColumnsBefore))
    check('未发生任何外部网络请求', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))
    check('隔离库位于临时目录（未触碰真实 workbench.db）', process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir()))
    check('target_cpm 使用共享规则常量', rules.TARGET_CPM === 30 && decision1.data.target_cpm === rules.TARGET_CPM)
  } finally {
    networkGuard.restore()
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
