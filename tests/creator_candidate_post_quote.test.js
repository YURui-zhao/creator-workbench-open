#!/usr/bin/env node
// Creator Decision Playbook V0.1 - Phase 4D candidate post_quote decision 回归测试
//
// 运行方式：node tests/creator_candidate_post_quote.test.js
// 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
// 网络：拦截 http/https/net/tls —— 本能力纯确定性，不调用 AI、不访问网络。

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-postquote-'))
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

const play = (value, type = 'sponsored', index = 1) => ({
  raw_text: String(value),
  excluded: false,
  content_type: type,
  source_image_index: 1,
  position_index: index
})

async function main() {
  const blocked = []
  for (const [t, m] of [[http, 'request'], [https, 'request'], [net, 'connect'], [tls, 'connect']]) {
    t[m] = () => {
      blocked.push(m)
      throw new Error('post-quote test forbids network requests')
    }
  }
  try {
    const candidates = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorCandidates.js')).href
    )
    const decisions = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorDecisions.js')).href
    )
    const outcomeUtil = await import(
      pathToFileURL(path.join(root, 'backend/utils/creatorDecisionOutcome.js')).href
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

    const createCandidate = findHandler(candidates.default, '/', 'post')
    const saveSnapshot = findHandler(candidates.default, '/:id/recent-snapshots', 'post')
    const createReviewDecision = findHandler(candidates.default, '/:id/decisions', 'post')
    const createPostQuote = findHandler(candidates.default, '/:id/post-quote-decisions', 'post')
    const listDecisions = findHandler(candidates.default, '/:id/decisions', 'get')
    const legacyCreateDecision = findHandler(decisions.default, '/', 'post')

    // ---------- 历史价格池 ----------
    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES ('2026-W40', ?, '科普', ?, '2026-08-20', ?, ?)`
    )
    ;[['历史甲', 1500, 50000, 50000], ['历史乙', 1080, 54000, 54000], ['历史丙', 0, 48000, 48000],
      ['历史丁', 2100, 60000, 60000], ['历史戊', 900, 45000, 45000], ['旧达人', 1000, 30000, 30000]]
      .forEach(([n, c, f, s]) => insertRecord.run(n, c, f, s))

    const mkCand = async (name, plays, xingtuRaw, observedAt = '2026-10-03') => {
      const c = await callRoute(createCandidate, { body: { name, creator_type: '科普' } })
      if (plays) {
        await callRoute(saveSnapshot, {
          params: { id: String(c.data.id) },
          body: { observed_at: observedAt, xingtu_price_raw: xingtuRaw ?? null, plays }
        })
      }
      return c.data
    }

    const candMain = await mkCand('报价候选', [
      play(50000, 'sponsored', 1), play(51000, 'sponsored', 2), play(53000, 'sponsored', 3), play(54000, 'sponsored', 4),
      play(80000, 'organic', 5)
    ], '¥3,000')
    const candNoSnap = await mkCand('无快照报价', null, null)
    const candZero = await mkCand('零商单', [play(80000, 'organic', 1), play(90000, 'organic', 2)], '¥1,000')
    const candXingtuZero = await mkCand('星图零价', [play(20000, 'sponsored', 1)], '0')
    const candNoXingtu = await mkCand('无星图价', [play(20000, 'sponsored', 1)], null)
    const candLatest = await mkCand('最新快照', [play(10000, 'sponsored', 1)], null, '2026-10-01')
    await callRoute(saveSnapshot, {
      params: { id: String(candLatest.id) },
      body: { observed_at: '2026-10-02', plays: [play(20000, 'sponsored', 1)] }
    })
    const latestSnapshotId = db
      .prepare('SELECT id FROM creator_recent_snapshots WHERE candidate_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1')
      .get(candLatest.id).id

    console.log('===== 1. 启用条件 / 报价校验 =====')
    const noSnap = await callRoute(createPostQuote, { params: { id: String(candNoSnap.id) }, body: { current_quote_raw: '3000', human_decision: 'proceed' } })
    check('无 snapshot -> 拒绝（请先录入近期表现）', noSnap.status === 400 && /请先录入近期表现，再记录报价阶段决策/.test(String(noSnap.msg)), noSnap.msg)
    check('current_quote 缺失 -> 拒绝', (await callRoute(createPostQuote, { params: { id: String(candMain.id) }, body: { human_decision: 'proceed' } })).status === 400)
    check('current_quote 空串 -> 拒绝', (await callRoute(createPostQuote, { params: { id: String(candMain.id) }, body: { current_quote_raw: '   ', human_decision: 'proceed' } })).status === 400)
    check('负报价 -> 拒绝', (await callRoute(createPostQuote, { params: { id: String(candMain.id) }, body: { current_quote_raw: '-100', human_decision: 'proceed' } })).status === 400)
    check('非法文本 -> 拒绝', (await callRoute(createPostQuote, { params: { id: String(candMain.id) }, body: { current_quote_raw: '面议', human_decision: 'proceed' } })).status === 400)
    const zeroQuote = await callRoute(createPostQuote, { params: { id: String(candMain.id) }, body: { current_quote_raw: '0', human_decision: 'pause' } })
    check('current_quote=0 合法保存', zeroQuote.status === 200 && zeroQuote.data?.current_quote === 0 && zeroQuote.data?.current_quote_raw === '0')
    check('不存在的 candidate -> 404', (await callRoute(createPostQuote, { params: { id: '99999' }, body: { current_quote_raw: '1', human_decision: 'proceed' } })).status === 404)

    console.log('\n===== 2. candidate post_quote enum =====')
    check('candidate post_quote 允许 proceed/small_test/negotiate/pause', JSON.stringify(decisions.CANDIDATE_POST_QUOTE_DECISIONS) === JSON.stringify(['proceed', 'small_test', 'negotiate', 'pause']))
    for (const ok of ['proceed', 'small_test', 'negotiate', 'pause']) {
      const r = await callRoute(createPostQuote, { params: { id: String(candMain.id) }, body: { current_quote_raw: '100', human_decision: ok } })
      check(`允许 ${ok}`, r.status === 200 && r.data?.decision_stage === 'post_quote')
    }
    for (const bad of ['repurchase', 'contact', 'observe', 'hold', '']) {
      const r = await callRoute(createPostQuote, { params: { id: String(candMain.id) }, body: { current_quote_raw: '100', human_decision: bad } })
      check(`拒绝 ${bad || '(空)'}`, r.status === 400)
    }
    check('旧 POST_QUOTE_DECISIONS 不变', JSON.stringify(decisions.POST_QUOTE_DECISIONS) === JSON.stringify(['repurchase', 'small_test', 'negotiate', 'pause']))
    check('旧历史达人仍不接受 proceed', (await callRoute(legacyCreateDecision, { body: { creator: '旧达人', decision_stage: 'post_quote', human_decision: 'proceed' } })).status === 400)
    check('proceed label = 直接推进', decisions.HUMAN_DECISION_LABELS.proceed === '直接推进')

    console.log('\n===== 3. 服务端决定 identity / snapshot =====')
    const forged = await callRoute(createPostQuote, {
      params: { id: String(candMain.id) },
      body: { current_quote_raw: '900', human_decision: 'proceed', candidate_id: 999, creator: '伪造', decision_stage: 'candidate_review', snapshot_id: 99999 }
    })
    check('伪造 candidate_id / creator / stage / snapshot_id 被忽略', forged.data?.candidate_id === candMain.id && forged.data?.creator === '报价候选' && forged.data?.decision_stage === 'post_quote' && forged.data?.snapshot_id !== 99999)
    const latestDecision = await callRoute(createPostQuote, { params: { id: String(candLatest.id) }, body: { current_quote_raw: '100', human_decision: 'pause' } })
    check('snapshot 按 candidate_id 自动取 latest', latestDecision.data?.snapshot_id === latestSnapshotId, String(latestDecision.data?.snapshot_id))
    check('pricing_version / system_context_version 新版本', latestDecision.data?.pricing_version === 'creator-playbook-postquote-v0.1' && latestDecision.data?.system_context_version === 'candidate-postquote-v0.1')
    check('target_cpm 仍为共享 30（旧风险体系兼容）', latestDecision.data?.target_cpm === 30)
    check('historical_evidence = has_prior_collaboration:false', JSON.stringify(latestDecision.data?.historical_evidence) === JSON.stringify({ has_prior_collaboration: false }))

    console.log('\n===== 4. 报价 / 星图 / 估价事实 =====')
    const pe = forged.data?.pricing_evidence || {}
    check('current_quote_raw 与 current_quote 都冻结（"900" -> 900）', forged.data?.current_quote_raw === '900' && forged.data?.current_quote === 900)
    check('xingtu_price 与 current_quote 分开', pe.xingtu_price === 3000 && pe.current_quote === 900)
    check('sponsored 事实冻结（4 条 / 中位 52000）', forged.data?.recent_evidence?.sponsored_count === 4 && forged.data?.recent_evidence?.sponsored_median_play === 52000)
    check('Playbook estimate = 780 / 1040（confidence normal）', pe.playbook_estimate?.estimate_low === 780 && pe.playbook_estimate?.estimate_high === 1040 && pe.playbook_estimate?.confidence === 'normal')
    check('报价位置 within_playbook_range（900 落在 780-1040）', pe.current_quote_assessment?.position === 'within_playbook_range')
    check('报价位置 above_playbook_range（1200）', (await callRoute(createPostQuote, { params: { id: String(candMain.id) }, body: { current_quote_raw: '1200', human_decision: 'negotiate' } })).data?.pricing_evidence?.current_quote_assessment?.position === 'above_playbook_range')
    check('报价位置 below_playbook_range（500）', (await callRoute(createPostQuote, { params: { id: String(candMain.id) }, body: { current_quote_raw: '500', human_decision: 'pause' } })).data?.pricing_evidence?.current_quote_assessment?.position === 'below_playbook_range')
    check('sponsored=0 + organic>0 -> organic_proxy 代理估价（报价 500 低于区间）', (await callRoute(createPostQuote, { params: { id: String(candZero.id) }, body: { current_quote_raw: '500', human_decision: 'pause' } })).data?.pricing_evidence?.current_quote_assessment?.position === 'below_playbook_range')
    check('sponsored=0 时 estimate 明确标记 organic_proxy（不伪装成商单证据）', (() => { const e = db.prepare("SELECT pricing_evidence_json FROM creator_decisions WHERE candidate_id = ? AND decision_stage = 'post_quote'").all(candZero.id).map((r) => JSON.parse(r.pricing_evidence_json)); return e.every((x) => x.playbook_estimate.estimate_low === 1275 && x.playbook_estimate.estimate_high === 1700 && x.playbook_estimate.baseline_source === 'organic_proxy' && x.playbook_estimate.baseline_play === 85000 && x.playbook_estimate.confidence === 'low_proxy' && x.playbook_estimate.sponsored_median_play === null) })())
    check('quote ratio 正确（1200 / 3000 = 0.4）', (() => { const row = db.prepare("SELECT pricing_evidence_json FROM creator_decisions WHERE candidate_id = ? AND current_quote = 1200").get(candMain.id); return JSON.parse(row.pricing_evidence_json).quote_to_xingtu_ratio === 0.4 })())
    const zeroXingtu = await callRoute(createPostQuote, { params: { id: String(candXingtuZero.id) }, body: { current_quote_raw: '500', human_decision: 'pause' } })
    check('xingtu_price=0 -> ratio = null（不除 0）', zeroXingtu.data?.pricing_evidence?.quote_to_xingtu_ratio === null)
    const noXingtu = await callRoute(createPostQuote, { params: { id: String(candNoXingtu.id) }, body: { current_quote_raw: '500', human_decision: 'pause' } })
    check('xingtu_price=null -> ratio = null', noXingtu.data?.pricing_evidence?.quote_to_xingtu_ratio === null)
    check('historical price reference record_ids 被冻结（5 条）', Array.isArray(pe.historical_price_reference?.selected_record_ids) && pe.historical_price_reference.selected_record_ids.length === 5)

    console.log('\n===== 5. append-only 报价历史 =====')
    const before = db.prepare("SELECT COUNT(*) AS n FROM creator_decisions WHERE candidate_id = ? AND decision_stage = 'post_quote'").get(candLatest.id).n
    const q1 = await callRoute(createPostQuote, { params: { id: String(candLatest.id) }, body: { current_quote_raw: '3000', human_decision: 'negotiate', decision_note: '首次报价' } })
    const q2 = await callRoute(createPostQuote, { params: { id: String(candLatest.id) }, body: { current_quote_raw: '1800', human_decision: 'proceed', decision_note: '对方降到1800' } })
    const list = await callRoute(listDecisions, { params: { id: String(candLatest.id) } })
    check('3000/negotiate -> 1800/proceed 生成两行（不 UPDATE）', q1.data?.id !== q2.data?.id && db.prepare("SELECT COUNT(*) AS n FROM creator_decisions WHERE candidate_id = ? AND decision_stage = 'post_quote'").get(candLatest.id).n === before + 2)
    check('两行都保留（append-only）', list.data.decisions.some((x) => x.id === q1.data.id) && list.data.decisions.some((x) => x.id === q2.data.id))

    console.log('\n===== 6. outcome eligibility =====')
    const eligible = (stage, human, candidateId) =>
      outcomeUtil.isDecisionEligibleForOutcome({ decision_stage: stage, human_decision: human, candidate_id: candidateId }).eligible
    check('candidate post_quote/proceed -> eligible', eligible('post_quote', 'proceed', 1) === true)
    check('candidate post_quote/small_test -> eligible', eligible('post_quote', 'small_test', 1) === true)
    check('candidate post_quote/negotiate -> not eligible', eligible('post_quote', 'negotiate', 1) === false)
    check('candidate post_quote/pause -> not eligible', eligible('post_quote', 'pause', 1) === false)
    check('candidate_review/contact -> 仍 not eligible', eligible('candidate_review', 'contact', 1) === false)
    check('legacy post_quote/repurchase -> eligible（不变）', eligible('post_quote', 'repurchase', null) === true)
    check('legacy post_quote/small_test -> eligible（不变）', eligible('post_quote', 'small_test', null) === true)
    check('legacy 不接受 proceed', eligible('post_quote', 'proceed', null) === false)
    check('candidate 不接受 repurchase', eligible('post_quote', 'repurchase', 1) === false)

    console.log('\n===== 7. 兼容 / 无推荐字段 =====')
    check('response 无 recommendation_score / should_invest', !/recommendation_score|should_invest|recommended_price|similarity/.test(JSON.stringify(forged.body)))
    const reviewStillWorks = await callRoute(createReviewDecision, { params: { id: String(candMain.id) }, body: { human_decision: 'contact' } })
    // Phase 3：candidate_review 不再写入 creator_decisions。
    // 本 fixture 未执行 Phase 1 migration（无 candidate_work_state_events）→ 服务端明确 503 降级；
    // 迁移后的库则会写入 work state event（deprecated shim）。两种情况都绝不再新增 decision 行。
    check(
      'Phase 3：candidate_review 不再写入 creator_decisions（未迁移库 → 503 明确降级）',
      reviewStillWorks.status === 503 ||
        (reviewStillWorks.status === 200 && reviewStillWorks.data?.deprecated === true),
      `status=${reviewStillWorks.status}`
    )
    const all = await callRoute(listDecisions, { params: { id: String(candMain.id) } })
    check(
      'GET /:id/decisions 只返回真实业务决策（post_quote；candidate_review 不再进入该表）',
      all.data.decisions.length >= 1 && all.data.decisions.every((x) => x.decision_stage === 'post_quote')
    )
    check('creator_decisions 中 candidate_review 行数为 0',
      db.prepare("SELECT COUNT(*) AS n FROM creator_decisions WHERE candidate_id = ? AND decision_stage = 'candidate_review'").get(candMain.id).n === 0)
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
