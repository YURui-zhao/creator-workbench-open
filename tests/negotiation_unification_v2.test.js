#!/usr/bin/env node
/**
 * Negotiation Experience Unification V0.2
 *
 * 运行方式：node tests/negotiation_unification_v2.test.js
 * 隔离方式：WORKBENCH_DB_PATH 指向临时库（必须先于 import backend/db.js 设置）；真实库只读。
 *
 * 目标：Historical Backfill 与 Candidate Live Flow 收敛到同一个 negotiation case 领域模型，
 * 并让「已存在的 candidate」也能进入谈价经验入口（不是只对新建达人生效）。
 *
 * 覆盖：
 *   · existing candidates retrofit：proceed / pause / observe / contact-only / 有星图 snapshot
 *   · live capture：negotiate / proceed / small_test / pause 可记录；candidate_review 不可（不伪造报价阶段）
 *   · 无 decision / 无 quote → 不伪造 decision、不伪造 quote
 *   · AI context reuse：最小必要文本 + sources + 绝不生成价格字段 + 不自动保存
 *   · 同一 candidate/decision 的 case 不重复创建；source_type=live / historical 语义保持
 *   · existing candidate 数据与 record/outcome 不被改写
 *   · 共享谈价经验表单（源码级）
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'neg-unification-v2-'))
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

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.payload = body
      return this
    },
    setHeader() {},
    send() {}
  }
}

function getHandler(router, routePath, method = 'post') {
  const layer = router.stack.find(
    (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
  )
  if (!layer) return null
  return layer.route.stack[layer.route.stack.length - 1].handle
}

async function main() {
  const negotiationModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/creatorNegotiationCases.js')).href
  )
  const aiModule = await import(pathToFileURL(path.join(REPO_ROOT, 'backend/routes/ai.js')).href)
  const db = (await import(pathToFileURL(path.join(REPO_ROOT, 'backend/db.js')).href)).default
  const utils = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/utils/negotiationCase.js')).href
  )

  const postLive = getHandler(negotiationModule.default, '/', 'post')
  const postHistorical = getHandler(negotiationModule.default, '/historical-backfill', 'post')
  const getCases = getHandler(negotiationModule.default, '/', 'get')
  const postHarvest = getHandler(aiModule.default, '/harvest-negotiation-experience', 'post')

  const call = (handler, req) => {
    const res = createRes()
    handler(req, res)
    return res
  }
  const callLive = (body) => call(postLive, { body })
  const callGet = (query) => call(getCases, { query })

  const countCases = () => db.prepare('SELECT COUNT(*) AS n FROM creator_negotiation_cases').get().n
  const countDecisions = () => db.prepare('SELECT COUNT(*) AS n FROM creator_decisions').get().n
  const countRecords = () => db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
  const countOutcomes = () => db.prepare('SELECT COUNT(*) AS n FROM creator_decision_outcomes').get().n

  // ---------- fixtures：现有 5 类 candidate（对应真实 5 个 creator_candidates 形态） ----------
  const insertCandidate = db.prepare(
    `INSERT INTO creator_candidates (name, creator_type, profile_url, description, status, created_at, updated_at, distilled_description, xingtu_id)
     VALUES (@name, @creator_type, @profile_url, @description, 'active', '2026-10-03 10:10:04', '2026-10-03 10:10:04', @distilled_description, @xingtu_id)`
  )
  const mkCandidate = (over = {}) =>
    Number(
      insertCandidate.run({
        name: '候选A',
        creator_type: '科普',
        profile_url: 'https://v.douyin.com/aaaa/',
        description: '',
        distilled_description: null,
        xingtu_id: null,
        ...over
      }).lastInsertRowid
    )

  const insertSnapshot = db.prepare(
    `INSERT INTO creator_recent_snapshots
       (creator, candidate_id, source_type, xingtu_price, plays_json, recognized_count, valid_count,
        excluded_count, unresolved_count, analysis_count, median_play, p25_play, p75_play,
        trend_label, stats_status, stats_version, created_at, observed_at)
     VALUES (@creator, @candidate_id, 'screenshot', @xingtu_price, '[]', 15, 15, 0, 0, 15,
             50000, 20000, 90000, 'stable', 'ok', 'recent-stats-v1', '2026-10-09 06:56:27', '2026-10-09')`
  )
  const mkSnapshot = (creator, candidateId, xingtuPrice = null) =>
    Number(
      insertSnapshot.run({ creator, candidate_id: candidateId, xingtu_price: xingtuPrice })
        .lastInsertRowid
    )

  const insertDecision = db.prepare(
    `INSERT INTO creator_decisions
       (creator, candidate_id, decision_stage, snapshot_id, current_quote, human_decision, decision_note,
        historical_evidence_json, target_cpm, pricing_version, created_at)
     VALUES (@creator, @candidate_id, @decision_stage, @snapshot_id, @current_quote, @human_decision, @decision_note,
             '{}', 30, @pricing_version, @created_at)`
  )
  const mkDecision = (over = {}) =>
    Number(
      insertDecision.run({
        creator: '候选A',
        candidate_id: null,
        decision_stage: 'post_quote',
        snapshot_id: null,
        current_quote: null,
        human_decision: 'proceed',
        decision_note: null,
        pricing_version: 'creator-playbook-postquote-v0.1',
        created_at: '2026-10-09 07:53:56',
        ...over
      }).lastInsertRowid
    )

  // 1) proceed candidate（样板达人09真实形态：current_quote=4500，note 含「从5000砍价到4500」）
  const candProceed = mkCandidate({
    name: '样板达人09',
    creator_type: '科普',
    description: '有自己的话题点，价格比较实惠',
    distilled_description: '人工备注认为该达人价格相对实惠',
    xingtu_id: '7663552982146875442'
  })
  const snapProceed = mkSnapshot('样板达人09', candProceed, null)
  const decProceed = mkDecision({
    creator: '样板达人09',
    candidate_id: candProceed,
    snapshot_id: snapProceed,
    current_quote: 4500,
    human_decision: 'proceed',
    decision_note: '从5000砍价到4500，不急回复，如果超过些预算需求，可以慢慢磨价格'
  })
  // 2) pause candidate
  const candPause = mkCandidate({ name: '样板达人16', creator_type: '个人成长' })
  const decPause = mkDecision({
    creator: '样板达人16',
    candidate_id: candPause,
    current_quote: 2000,
    human_decision: 'pause',
    decision_note: '达人反馈起码1000多，现在能合作的都是2000'
  })
  // 3) observe-only candidate（candidate_review / observe）
  const candObserve = mkCandidate({ name: '样板达人17.', creator_type: '个人成长' })
  const decObserve = mkDecision({
    creator: '样板达人17.',
    candidate_id: candObserve,
    decision_stage: 'candidate_review',
    human_decision: 'observe',
    pricing_version: 'candidate-review-v0.1'
  })
  // 4) contact-only candidate（candidate_review / contact）
  const candContact = mkCandidate({ name: '样板达人18', creator_type: '历史类' })
  const decContact = mkDecision({
    creator: '样板达人18',
    candidate_id: candContact,
    decision_stage: 'candidate_review',
    human_decision: 'contact',
    pricing_version: 'candidate-review-v0.1'
  })
  // 5) candidate with xingtu snapshot（袁叔说历史形态）
  const candXingtu = mkCandidate({ name: '袁叔说历史', creator_type: '历史类' })
  const snapXingtu = mkSnapshot('袁叔说历史', candXingtu, 3000)
  const decXingtu = mkDecision({
    creator: '袁叔说历史',
    candidate_id: candXingtu,
    snapshot_id: snapXingtu,
    current_quote: 1000,
    human_decision: 'small_test',
    decision_note: '之前同事合作报价1200，砍价到1000'
  })

  const candidateBefore = db.prepare('SELECT * FROM creator_candidates WHERE id = ?').get(candProceed)
  const decisionsBefore = countDecisions()
  const recordsBefore = countRecords()
  const outcomesBefore = countOutcomes()

  // ================= 1. live eligibility（Unification V0.2） =================
  console.log('\n===== 1. candidate live 记录资格 =====')
  check(
    'V0.2 允许 negotiate / proceed / small_test / pause',
    JSON.stringify(utils.NEGOTIATION_CANDIDATE_LIVE_DECISIONS) ===
      JSON.stringify(['negotiate', 'proceed', 'small_test', 'pause'])
  )
  const liveProceed = callLive({
    decision_id: decProceed,
    negotiated_price: 4500,
    negotiated_at: '2026-10-03',
    // P0：记录已发生谈价 → 谈前报价必须人工填写（不能把 decision.current_quote=4500 当谈前价）
    current_quote_snapshot: 5000,
    source_note: '从5000砍价到4500，不急回复',
    reason_tags: ['budget_limited'],
    reason_note: '预算有限',
    strategy_note: '以预算与后续合作为依据继续谈'
  })
  check(
    'proceed candidate 可记录已发生谈价（source_type=live / record_id=null）',
    liveProceed.statusCode === 200 &&
      liveProceed.payload?.data?.source_type === 'live' &&
      liveProceed.payload?.data?.record_id === null &&
      liveProceed.payload?.data?.decision_id === decProceed
  )
  const livePause = callLive({
    decision_id: decPause,
    negotiated_price: 1800,
    negotiated_at: '2026-10-09',
    current_quote_snapshot: 2200
  })
  check('pause candidate 可记录已发生谈价（不代表推进）', livePause.statusCode === 200)
  const liveSmallTest = callLive({
    decision_id: decXingtu,
    negotiated_price: 1000,
    negotiated_at: '2026-10-09',
    current_quote_snapshot: 1200
  })
  check('small_test candidate 可记录已发生谈价', liveSmallTest.statusCode === 200)
  const liveObserve = callLive({
    decision_id: decObserve,
    negotiated_price: 1000,
    negotiated_at: '2026-10-09'
  })
  check(
    'observe（candidate_review）不可挂谈价案例（不伪造报价阶段）',
    liveObserve.statusCode === 400 && /已拿到报价/.test(liveObserve.payload?.msg || '')
  )
  const liveContact = callLive({
    decision_id: decContact,
    negotiated_price: 1000,
    negotiated_at: '2026-10-09'
  })
  check(
    'contact-only（candidate_review）不可挂谈价案例',
    liveContact.statusCode === 400
  )

  // ================= 2. 无 decision / 无 quote：不伪造 =================
  console.log('\n===== 2. 不伪造 decision / quote =====')
  const noDecision = callLive({ negotiated_price: 1500, negotiated_at: '2026-10-09' })
  check('无 decision_id → 400（不自动创建 decision）', noDecision.statusCode === 400)
  check('未新增任何 decision', countDecisions() === decisionsBefore)

  // ================= 3. 价格事实边界 =================
  console.log('\n===== 3. 价格事实边界 =====')
  const proceedCase = liveProceed.payload.data
  // P0 回归：4500 是谈后报价（decision.current_quote），谈前报价由人确认为 5000
  check(
    'P0-1：proceed 记录已发生谈价 → 谈前报价 5000 / 谈后 4500 / quote_change_rate = -0.10',
    proceedCase.current_quote_snapshot === 5000 &&
      proceedCase.negotiated_price === 4500 &&
      proceedCase.outcome.quote_change_rate === -0.1 &&
      proceedCase.outcome.quote_drop_direction === 'drop'
  )
  check(
    'P0-2：decision.current_quote 仍是 4500（决策事实不被改写）',
    db.prepare('SELECT current_quote FROM creator_decisions WHERE id = ?').get(decProceed)
      .current_quote === 4500
  )
  check(
    'P0-3：不会被自动推断成 4500 → 4500（quote_change_rate 不是 0）',
    proceedCase.outcome.quote_change_rate !== 0
  )
  // 备注里的「5000砍到4500」只是文本，不参与结构化价格（谈前 5000 来自用户输入）
  check(
    'P0-4：谈前报价来自人工输入，不从 decision_note 解析（备注数字与输入不同 → 以输入为准）',
    (() => {
      const decide = mkDecision({
        creator: '不解析备注',
        candidate_id: mkCandidate({ name: '不解析备注' }),
        current_quote: 4500,
        human_decision: 'proceed',
        decision_note: '5000砍到4500'
      })
      const res = callLive({
        decision_id: decide,
        negotiated_price: 4500,
        negotiated_at: '2026-10-09',
        // 人工确认的谈前价是 6000（备注里写的是 5000）→ 保存的必须是 6000
        current_quote_snapshot: 6000
      })
      return res.statusCode === 200 && res.payload.data.current_quote_snapshot === 6000
    })()
  )
  // 缺少谈前报价的 retrofit → 400
  const missingPreQuote = callLive({
    decision_id: decProceed,
    negotiated_price: 4300,
    negotiated_at: '2026-10-04'
  })
  check(
    'P0-5：retrofit 缺少谈前报价 → 400（且已存在案例时先命中 409）',
    missingPreQuote.statusCode === 409 || missingPreQuote.statusCode === 400
  )
  check(
    'P0-6：negotiate 原流程仍自动冻结 decision.current_quote（不要求重复输入）',
    (() => {
      const decide = mkDecision({
        creator: '原生谈价',
        candidate_id: mkCandidate({ name: '原生谈价' }),
        current_quote: 5000,
        human_decision: 'negotiate'
      })
      const res = callLive({
        decision_id: decide,
        negotiated_price: 4200,
        negotiated_at: '2026-10-09'
      })
      return (
        res.statusCode === 200 &&
        res.payload.data.current_quote_snapshot === 5000 &&
        res.payload.data.negotiated_price === 4200
      )
    })()
  )
  const xingtuCase = liveSmallTest.payload.data
  check(
    '有星图 snapshot：星图刊例由后端冻结（3000），谈前报价来自人工输入（1200）',
    xingtuCase.xingtu_price_snapshot === 3000 &&
      xingtuCase.current_quote_snapshot === 1200 &&
      xingtuCase.outcome.xingtu_discount_ratio === Number((1000 / 3000).toFixed(4))
  )
  // 前端不能伪造星图刊例（后端只从 snapshot 冻结）；谈前报价必须与人工输入一致
  const forged = callLive({
    decision_id: decPause,
    negotiated_price: 1900,
    negotiated_at: '2026-10-09',
    xingtu_price_snapshot: 99999
  })
  check(
    '前端提交的 xingtu 上下文不会被写入（已存在案例 → 409，不重复创建）',
    forged.statusCode === 409
  )
  check(
    'P0-7：pause / small_test retrofit 同样要求人工谈前报价',
    livePause.payload.data.current_quote_snapshot === 2200 &&
      xingtuCase.current_quote_snapshot === 1200
  )

  // ================= 4. AI context reuse =================
  console.log('\n===== 4. AI context reuse =====')
  let captured = null
  const fakeCall = async (systemPrompt, userText) => {
    captured = { systemPrompt, userText }
    return JSON.stringify({
      reason_tags: ['sponsored_below_organic', 'made_up_tag'],
      reason_note: '人工备注提到商单播放低于日常',
      strategy_note: '人工备注显示以商单播放低于日常作为压价依据。'
    })
  }
  const casesBeforeAi = countCases()
  const harvest = await aiModule.harvestNegotiationExperience(
    {
      sourceNote: '他说预算有限，最后答应4500',
      candidateDescription: '有自己的话题点，价格比较实惠',
      distilledDescription: '人工备注认为价格相对实惠',
      decisionNote: '从5000砍价到4500，不急回复'
    },
    fakeCall,
    {}
  )
  check(
    'AI 输入只包含真实存在的人工文本（最小必要；description 存在时不含 distilled）',
    captured.userText.includes('【本次谈价原始备注】他说预算有限，最后答应4500') &&
      captured.userText.includes('【达人人工备注】有自己的话题点，价格比较实惠') &&
      captured.userText.includes('【相关决策备注】从5000砍价到4500，不急回复') &&
      !captured.userText.includes('人工备注认为价格相对实惠')
  )
  check(
    'AI 不发送 record / 其它 candidate / 其它 case',
    !/creator_records/.test(captured.userText) &&
      !/negotiation_cases/.test(captured.userText) &&
      !/样板达人16|样板达人18/.test(captured.userText)
  )
  check(
    'AI 输出非法 tag 被过滤，且不包含任何价格字段',
    JSON.stringify(harvest.reason_tags) === JSON.stringify(['sponsored_below_organic']) &&
      !('xingtu_price_snapshot' in harvest) &&
      !('current_quote_snapshot' in harvest) &&
      !('negotiated_price' in harvest) &&
      !('negotiated_at' in harvest)
  )
  check(
    'AI 返回 sources（只含真实来源；description 存在时不重复计入 distilled）',
    JSON.stringify(harvest.sources) ===
      JSON.stringify(['source_note', 'candidate_description', 'decision_note'])
  )
  check('AI 整理不写库（不自动保存）', countCases() === casesBeforeAi)
  // P1：不再强制 source_note —— 只要存在任一人工来源即可整理
  check(
    'P1-1：source_note 为空但 candidate description 存在 → 可整理（eligibility = true）',
    aiModule.hasNegotiationHarvestSource({ candidateDescription: '达人有话题点' }) === true &&
      JSON.stringify(aiModule.listNegotiationHarvestSources({ candidateDescription: '达人有话题点' })) ===
        JSON.stringify(['candidate_description'])
  )
  let capturedOnlyDescription = null
  const harvestOnlyDescription = await aiModule.harvestNegotiationExperience(
    { candidateDescription: '达人有话题点，价格实惠' },
    async (system, user) => {
      capturedOnlyDescription = user
      return JSON.stringify({ reason_tags: ['budget_limited'], reason_note: 'note', strategy_note: null })
    },
    {}
  )
  check(
    'P1-2：纯 description 输入即可整理（发送内容只含该人工备注）',
    capturedOnlyDescription.includes('【达人人工备注】达人有话题点，价格实惠') &&
      harvestOnlyDescription.reason_tags.length === 1
  )
  check(
    'P1-3：source_note 为空但 decision_note 存在 → 可整理',
    aiModule.hasNegotiationHarvestSource({ decisionNote: '从5000砍价到4500' }) === true &&
      JSON.stringify(aiModule.listNegotiationHarvestSources({ decisionNote: 'x' })) ===
        JSON.stringify(['decision_note'])
  )
  check(
    'P1-4：所有人工来源为空 → 拒绝（distilled 是 AI 派生，不算人工来源）',
    aiModule.hasNegotiationHarvestSource({ distilledDescription: 'AI 早前整理' }) === false
  )
  const emptyHarvest = call(postHarvest, { body: {} })
  check(
    'P1-5：AI 路由在所有人工来源为空时返回 400（明确提示无人工内容）',
    emptyHarvest.statusCode === 400 && /人工内容/.test(emptyHarvest.payload?.msg || '')
  )
  const distilledOnly = call(postHarvest, { body: { distilled_description: 'AI 早前整理' } })
  check('P1-6：仅 distilled 也不可通过（仍需至少一项人工来源）', distilledOnly.statusCode === 400)

  // 五、distilled 与 description 同源去重
  check(
    'P1-7：description + distilled 同时存在 → 不重复发送同源内容（sources 不含 distilled）',
    JSON.stringify(
      aiModule.listNegotiationHarvestSources({
        candidateDescription: '人工备注',
        distilledDescription: 'AI 整理'
      })
    ) === JSON.stringify(['candidate_description'])
  )
  let capturedDedup = null
  await aiModule.harvestNegotiationExperience(
    {
      sourceNote: '本次谈价',
      candidateDescription: '人工备注内容',
      distilledDescription: 'AI 整理内容'
    },
    async (system, user) => {
      capturedDedup = user
      return JSON.stringify({ reason_tags: [], reason_note: 'x', strategy_note: null })
    },
    {}
  )
  check(
    'P1-8：去重后的输入不含 distilled 文本',
    capturedDedup.includes('【达人人工备注】人工备注内容') && !capturedDedup.includes('AI 整理内容')
  )
  check(
    'P1-9：description 缺失时 distilled 作为辅助来源（标注为 AI 派生）',
    JSON.stringify(aiModule.listNegotiationHarvestSources({ distilledDescription: 'AI 整理内容' })) ===
      JSON.stringify(['distilled_description']) &&
      /达人备注 AI 整理/.test(
        aiModule.buildNegotiationHarvestUserText({ distilledDescription: 'AI 整理内容' })
      )
  )
  const tooLong = call(postHarvest, {
    body: { source_note: 'x', decision_note: 'y'.repeat(2001) }
  })
  check('AI 路由对超长上下文返回 400', tooLong.statusCode === 400)

  // ================= 5. append-only / 不重复 =================
  console.log('\n===== 5. append-only / 唯一性 =====')
  const duplicate = callLive({
    decision_id: decProceed,
    negotiated_price: 4400,
    negotiated_at: '2026-10-04'
  })
  check('同一 decision 重复记录 → 409（不静默覆盖）', duplicate.statusCode === 409)
  const byDecision = callGet({ decision_id: String(decProceed) })
  check(
    'live case 可按 decision_id 读取，且 source_type=live',
    byDecision.payload.data.cases.length === 1 &&
      byDecision.payload.data.cases[0].source_type === 'live'
  )

  // ================= 6. historical_backfill 语义保持 =================
  console.log('\n===== 6. historical_backfill 保持 =====')
  const recordId = Number(
    db
      .prepare(
        `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
         VALUES ('2026-W39', '样板达人09', '科普类', 4725, '2026-09-29', 23619, 714300)`
      )
      .run().lastInsertRowid
  )
  const hist = call(postHistorical, {
    body: {
      record_id: recordId,
      negotiated_price: 4500,
      negotiated_at: '2026-06-15',
      current_quote_snapshot: 5000,
      source_note: '历史回填原始备注'
    }
  })
  check(
    'historical_backfill 仍走 record_id 锚点（decision_id = null）',
    hist.statusCode === 200 &&
      hist.payload?.data?.source_type === 'historical_backfill' &&
      hist.payload?.data?.record_id === recordId &&
      hist.payload?.data?.decision_id === null
  )
  check(
    'historical 与 live 共用同一张表（两种 source_type 同时存在）',
    (() => {
      const rows = db
        .prepare("SELECT source_type, COUNT(*) AS n FROM creator_negotiation_cases GROUP BY source_type")
        .all()
      const map = Object.fromEntries(rows.map((r) => [r.source_type, r.n]))
      // live：proceed / pause / small_test / negotiate(P0-6) / 不解析备注(P0-4)
      return map.live === 5 && map.historical_backfill === 1 && countCases() === map.live + 1
    })()
  )

  // ================= 7. 不改写既有数据 =================
  console.log('\n===== 7. 不改写既有数据 =====')
  const candidateAfter = db.prepare('SELECT * FROM creator_candidates WHERE id = ?').get(candProceed)
  check(
    'candidate 资料（description / distilled_description / name）未被覆盖',
    candidateAfter.description === candidateBefore.description &&
      candidateAfter.distilled_description === candidateBefore.distilled_description &&
      candidateAfter.name === candidateBefore.name
  )
  // decisionsBefore 之后只新增了测试显式创建的 fixture decision（P0-4 不解析备注 / P0-6 negotiate）
  check('未自动新增 decision（只允许测试显式创建）', countDecisions() === decisionsBefore + 2)
  check('未新增 creator_record', countRecords() === recordsBefore + 1) // +1 为 historical fixture
  check('未新增 outcome', countOutcomes() === outcomesBefore)
  check(
    'negotiated_price 未回填 record.total_cost',
    db.prepare('SELECT total_cost FROM creator_records WHERE id = ?').get(recordId).total_cost === 4725
  )

  // ================= 8. 共享表单 / 入口（源码级） =================
  console.log('\n===== 8. 共享表单与入口（源码级） =====')
  const sharedForm = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/components/NegotiationExperienceForm.jsx'),
    'utf8'
  )
  const histModal = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/components/HistoricalNegotiationCaseModal.jsx'),
    'utf8'
  )
  const candModal = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/components/CandidateNegotiationExperienceModal.jsx'),
    'utf8'
  )
  const playbookPage = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/pages/CreatorPlaybook/index.jsx'),
    'utf8'
  )
  check(
    '共享谈价经验组件被 historical 与 candidate 同时复用（不复制两套 JSX）',
    /<NegotiationExperienceForm/.test(histModal) && /<NegotiationExperienceForm/.test(candModal)
  )
  check(
    '共享组件覆盖统一经验结构（原始说明 / 原因标签 / 补充说明 / 依据过程）',
    /谈价原始说明/.test(sharedForm) &&
      /谈价原因 \/ 背景/.test(sharedForm) &&
      /补充说明/.test(sharedForm) &&
      /谈价依据 \/ 过程/.test(sharedForm)
  )
  check(
    'candidate 模式仍隐藏 history_performance_plain（candidate_playbook）',
    /mode="candidate_playbook"/.test(candModal) && /getNegotiationReasonTagsForMode\(mode\)/.test(sharedForm)
  )
  check(
    '既有 candidate 也有稳定入口（无 case → 记录本次谈价 / 有 case → 查看本次谈价记录）',
    /记录本次谈价/.test(playbookPage) && /查看本次谈价记录/.test(playbookPage)
  )
  check(
    '没有报价阶段时不伪造（提示先补充报价阶段事实）',
    /当前没有报价阶段记录/.test(playbookPage) && /当前没有报价阶段记录/.test(candModal)
  )
  check(
    'pause 有明确状态提示（不代表继续推进）',
    /该达人当前决策为暂不推进/.test(candModal) && /不代表继续推进/.test(candModal)
  )
  check(
    '已有 case 只读查看，不直接覆盖（V0.2 append-only）',
    /该谈价案例已保存。V0.2 暂不直接覆盖历史记录。/.test(candModal)
  )
  check(
    'AI 建议应用文案明确「尚未保存」语义',
    /AI整理建议（尚未保存）/.test(sharedForm) && /应用到表单不会写入系统/.test(sharedForm)
  )
  check(
    '共享组件不包含任何价格输入（价格由人填写 / 后端冻结）',
    !/negotiated_price/.test(sharedForm) &&
      !/xingtu_price_snapshot/.test(sharedForm) &&
      !/current_quote_snapshot/.test(sharedForm)
  )

  // ================= 8b. 文案澄清：达人资料画像 ≠ 本次谈价记录 =================
  console.log('\n===== 8b. 画像 / 谈价 文案澄清（源码级） =====')
  const profileFiles = {
    'CreatorPlaybook/index.jsx': playbookPage,
    'CandidateNegotiationExperienceModal.jsx': candModal,
    'HistoricalNegotiationCaseModal.jsx': histModal,
    'NegotiationExperienceForm.jsx': sharedForm
  }
  check(
    '1：相关页面不再出现容易混淆的「AI整理备注」',
    Object.values(profileFiles).every((src) => !src.includes('AI整理备注'))
  )
  check(
    '2：Profile 文案明确「达人资料画像」',
    playbookPage.includes('达人资料画像') &&
      playbookPage.includes('记录这个达人的长期特征、内容风格、价格感知和合作观察。') &&
      playbookPage.includes('人工观察') &&
      playbookPage.includes('AI整理达人资料') &&
      playbookPage.includes('AI整理后的达人画像（仅供参考）')
  )
  check(
    '2b：Profile 区不出现谈价经验相关文案（与谈价记录分开）',
    !/达人资料画像[\s\S]{0,400}谈价经验/.test(playbookPage)
  )
  check(
    '3：Negotiation 文案明确「本次谈价记录」',
    playbookPage.includes('本次谈价记录') &&
      playbookPage.includes('记录这一次具体谈价的价格变化、原因和过程，可用于后续复盘。') &&
      playbookPage.includes('记录本次谈价') &&
      playbookPage.includes('查看本次谈价记录')
  )
  check(
    '3b：谈价 Modal 文案（标题 / 原始说明 / AI按钮 / 最终保存）',
    candModal.includes('`记录本次谈价 · ${creatorName}`') &&
      sharedForm.includes('谈价原始说明') &&
      sharedForm.includes('可粘贴当时聊天摘要、人工记录或有证据的回忆。') &&
      sharedForm.includes('AI整理谈价经验') &&
      candModal.includes('保存本次谈价记录')
  )
  check(
    '3c：谈价结构未变（原因/背景 · 补充说明 · 依据/过程）',
    sharedForm.includes('谈价原因 / 背景') &&
      sharedForm.includes('补充说明') &&
      sharedForm.includes('谈价依据 / 过程')
  )
  check(
    '4：数据字段绑定未变（画像 = description/distilled_description；谈价 = source_note 等）',
    /name="description"/.test(playbookPage) &&
      /distilled_description/.test(playbookPage) &&
      /source_note: experience\.sourceNote/.test(histModal) &&
      /source_note: experience\.sourceNote/.test(candModal)
  )

  // ================= 9. Semantic Duplicate：跨来源互斥（V0.2 P0） =================
  console.log('\n===== 9. 跨来源去重（live ↔ historical_backfill） =====')
  const outcomeModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/creatorDecisionOutcomes.js')).href
  )
  const postOutcome = getHandler(outcomeModule.default, '/:id/outcome', 'post')
  check('outcome 关联 handler 可用', typeof postOutcome === 'function')

  const insertRecord = db.prepare(
    `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
     VALUES ('2026-W39', @nickname, '科普类', 4725, '2026-09-29', 23619, 714300)`
  )
  const linkOutcome = (decisionId, recordId) =>
    Number(
      db
        .prepare(
          `INSERT INTO creator_decision_outcomes (decision_id, record_id, linked_at) VALUES (?, ?, '2026-10-09 07:23:27')`
        )
        .run(decisionId, recordId).lastInsertRowid
    )

  // --- 真实回归：样板达人09（decision → outcome → record，且 record 已补录历史谈价） ---
  const guaiCandidate = mkCandidate({ name: '样板达人09', creator_type: '科普' })
  const guaiDecision = mkDecision({
    creator: '样板达人09',
    candidate_id: guaiCandidate,
    current_quote: 4500,
    human_decision: 'proceed',
    decision_note: '从5000砍价到4500，不急回复'
  })
  const guaiRecord = Number(insertRecord.run({ nickname: '样板达人09' }).lastInsertRowid)
  linkOutcome(guaiDecision, guaiRecord)
  const guaiHistorical = call(postHistorical, {
    body: {
      record_id: guaiRecord,
      negotiated_price: 4500,
      negotiated_at: '2026-10-09',
      current_quote_snapshot: 5000,
      xingtu_price_snapshot: 10000,
      source_note: '历史补录：5000 → 4500'
    }
  })
  check(
    '前置：历史补录成功（record 锚点 / decision_id=null）',
    guaiHistorical.statusCode === 200 &&
      guaiHistorical.payload.data.source_type === 'historical_backfill' &&
      guaiHistorical.payload.data.record_id === guaiRecord
  )
  const historicalSnapshot = JSON.stringify(
    db.prepare('SELECT * FROM creator_negotiation_cases WHERE id = ?').get(guaiHistorical.payload.data.id)
  )
  const decisionSnapshot = JSON.stringify(
    db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(guaiDecision)
  )
  const recordSnapshot = JSON.stringify(
    db.prepare('SELECT * FROM creator_records WHERE id = ?').get(guaiRecord)
  )
  const outcomeCountBefore = countOutcomes()

  // 1 / 12：outcome-linked historical case 阻止 live create；且不修改任何既有数据
  const blockedLive = callLive({
    decision_id: guaiDecision,
    negotiated_price: 4500,
    negotiated_at: '2026-10-09',
    current_quote_snapshot: 5000
  })
  check(
    '1：该决策经 outcome 关联的记录已有历史补录 → live create 409（文案指向已有案例）',
    blockedLive.statusCode === 409 &&
      /已补录历史谈价/.test(blockedLive.payload?.msg || '') &&
      /查看已有谈价案例/.test(blockedLive.payload?.msg || '')
  )
  check(
    '11/12：没有自动 merge / 转换 / UPDATE（historical case、decision、record 逐字节不变）',
    JSON.stringify(
      db.prepare('SELECT * FROM creator_negotiation_cases WHERE id = ?').get(guaiHistorical.payload.data.id)
    ) === historicalSnapshot &&
      JSON.stringify(db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(guaiDecision)) ===
        decisionSnapshot &&
      JSON.stringify(db.prepare('SELECT * FROM creator_records WHERE id = ?').get(guaiRecord)) ===
        recordSnapshot &&
      db.prepare("SELECT COUNT(*) AS n FROM creator_negotiation_cases WHERE source_type = 'live' AND decision_id = ?").get(guaiDecision).n === 0
  )

  // 2 / 3：candidate workspace 识别跨来源已有案例（源码级）
  check(
    '2：candidate workspace 通过 outcome 关联记录识别历史补录案例',
    /getNegotiationCasesByRecord\(linkedOutcomeRecordId\)/.test(playbookPage) &&
      /item\.source_type === 'historical_backfill'/.test(playbookPage) &&
      /const existingNegotiationExperience = latestNegotiationCase \|\| linkedHistoricalCase \|\| null/.test(playbookPage) &&
      /canRecordNegotiationExperience && !existingNegotiationExperience/.test(playbookPage)
  )
  check(
    '3：已有历史补录时显示「查看本次谈价记录」（不再显示记录入口），并标注来源',
    /本次谈价记录 · 来源：历史补录/.test(playbookPage) &&
      // 历史补录区块内提供只读查看入口（位于该区块之后）
      playbookPage
        .slice(playbookPage.indexOf('linkedHistoricalCase && ('))
        .includes('查看本次谈价记录') &&
      /existingCase=\{existingNegotiationExperience\}/.test(playbookPage) &&
      /来源：历史补录/.test(candModal)
  )

  // 4：live case 阻止同一真实投放的 historical backfill（反方向）
  const liveFirstCandidate = mkCandidate({ name: '反方向达人' })
  const liveFirstDecision = mkDecision({
    creator: '反方向达人',
    candidate_id: liveFirstCandidate,
    current_quote: 2000,
    human_decision: 'proceed'
  })
  const liveFirstRecord = Number(insertRecord.run({ nickname: '反方向达人' }).lastInsertRowid)
  linkOutcome(liveFirstDecision, liveFirstRecord)
  const liveFirstCase = callLive({
    decision_id: liveFirstDecision,
    negotiated_price: 1800,
    negotiated_at: '2026-10-09',
    current_quote_snapshot: 2000
  })
  check('前置：live case 创建成功（此时该 record 尚无历史补录）', liveFirstCase.statusCode === 200)
  const blockedBackfill = call(postHistorical, {
    body: {
      record_id: liveFirstRecord,
      negotiated_price: 1800,
      negotiated_at: '2026-10-09',
      current_quote_snapshot: 2000
    }
  })
  check(
    '4：该投放已存在实时谈价案例 → historical backfill 409',
    blockedBackfill.statusCode === 409 && /已存在实时谈价案例/.test(blockedBackfill.payload?.msg || '')
  )

  // 5：不相关的 historical case 不误伤
  const unrelatedRecord = Number(insertRecord.run({ nickname: '无关达人' }).lastInsertRowid)
  const unrelatedHistorical = call(postHistorical, {
    body: {
      record_id: unrelatedRecord,
      negotiated_price: 900,
      negotiated_at: '2026-10-09',
      current_quote_snapshot: 1000
    }
  })
  const stillWorks = callLive({
    decision_id: decProceed,
    negotiated_price: 4400,
    negotiated_at: '2026-10-05',
    current_quote_snapshot: 5000
  })
  check(
    '5：不相关记录的历史补录不影响其它决策（该 decision 已存在 case → 409 仍按 append-only 返回）',
    unrelatedHistorical.statusCode === 200 && stillWorks.statusCode === 409
  )

  // 6：没有 outcome 时不做任何名称猜测
  const noOutcomeCandidate = mkCandidate({ name: '无关联达人' })
  const noOutcomeDecision = mkDecision({
    creator: '无关联达人',
    candidate_id: noOutcomeCandidate,
    current_quote: 1500,
    human_decision: 'proceed'
  })
  const noOutcomeRecord = Number(insertRecord.run({ nickname: '无关联达人' }).lastInsertRowid)
  const noOutcomeHistorical = call(postHistorical, {
    body: { record_id: noOutcomeRecord, negotiated_price: 1400, negotiated_at: '2026-10-09', current_quote_snapshot: 1500 }
  })
  const noOutcomeLive = callLive({
    decision_id: noOutcomeDecision,
    negotiated_price: 1400,
    negotiated_at: '2026-10-09',
    current_quote_snapshot: 1500
  })
  check(
    '6：没有 outcome 关联时不做名称猜测（同名/同达人都不会互相阻塞）',
    noOutcomeHistorical.statusCode === 200 && noOutcomeLive.statusCode === 200
  )

  // 7：同名 creator 不串（所有阻塞都基于 decision_id / record_id，不基于名称）
  const sameNameA = mkCandidate({ name: '同名达人' })
  const sameNameB = mkCandidate({ name: '同名达人' })
  const sameNameDecisionB = mkDecision({
    creator: '同名达人',
    candidate_id: sameNameB,
    current_quote: 1200,
    human_decision: 'proceed'
  })
  const sameNameLiveB = callLive({
    decision_id: sameNameDecisionB,
    negotiated_price: 1100,
    negotiated_at: '2026-10-09',
    current_quote_snapshot: 1200
  })
  check(
    '7：同名 creator 不串（B 可记录，A 的判定不受名称影响）',
    sameNameA !== sameNameB && sameNameLiveB.statusCode === 200
  )

  // 8：样板达人18类正常 proceed retrofit 不受影响
  const geilimiao = mkCandidate({ name: '样板达人18', creator_type: '历史类' })
  const geilimiaoDecision = mkDecision({
    creator: '样板达人18',
    candidate_id: geilimiao,
    current_quote: 2500,
    human_decision: 'proceed',
    decision_note: '原本 2000，现在 2500-3000'
  })
  const geilimiaoLive = callLive({
    decision_id: geilimiaoDecision,
    negotiated_price: 2500,
    negotiated_at: '2026-10-09',
    current_quote_snapshot: 3000,
    source_note: '谈后 2500'
  })
  check(
    '8：样板达人18类正常 proceed retrofit 仍可记录（无 outcome / 无历史补录）',
    geilimiaoLive.statusCode === 200 &&
      geilimiaoLive.payload.data.current_quote_snapshot === 3000 &&
      geilimiaoLive.payload.data.negotiated_price === 2500
  )

  // 9：原 live negotiate 正常
  const negotiateDecision2 = mkDecision({
    creator: '原生谈价2',
    candidate_id: mkCandidate({ name: '原生谈价2' }),
    current_quote: 5000,
    human_decision: 'negotiate'
  })
  const negotiateLive2 = callLive({
    decision_id: negotiateDecision2,
    negotiated_price: 4300,
    negotiated_at: '2026-10-09'
  })
  check(
    '9：原 live negotiate 正常（谈前报价仍自动冻结）',
    negotiateLive2.statusCode === 200 && negotiateLive2.payload.data.current_quote_snapshot === 5000
  )

  // 5（§五）：outcome linking 边界 —— 先各自存在两种来源的 case，再尝试关联 → 409
  const linkGuardCandidate = mkCandidate({ name: '关联边界达人' })
  const linkGuardDecision = mkDecision({
    creator: '关联边界达人',
    candidate_id: linkGuardCandidate,
    current_quote: 2000,
    human_decision: 'proceed'
  })
  const linkGuardRecord = Number(insertRecord.run({ nickname: '关联边界达人' }).lastInsertRowid)
  const linkGuardLive = callLive({
    decision_id: linkGuardDecision,
    negotiated_price: 1800,
    negotiated_at: '2026-10-09',
    current_quote_snapshot: 2000
  })
  const linkGuardHistorical = call(postHistorical, {
    body: {
      record_id: linkGuardRecord,
      negotiated_price: 1800,
      negotiated_at: '2026-10-09',
      current_quote_snapshot: 2000
    }
  })
  const linkAttempt = call(postOutcome, {
    params: { id: String(linkGuardDecision) },
    body: { record_id: linkGuardRecord, timing_confirmed: true }
  })
  check(
    '§五：live case 与 record 的历史补录同时存在时，outcome 关联 → 409（不静默合并）',
    linkGuardLive.statusCode === 200 &&
      linkGuardHistorical.statusCode === 200 &&
      linkAttempt.statusCode === 409 &&
      /不会自动合并/.test(linkAttempt.payload?.msg || '')
  )
  check(
    '§五：关联被拒绝后两条 case 都保留（不自动删除任何一个）',
    db.prepare("SELECT COUNT(*) AS n FROM creator_negotiation_cases WHERE decision_id = ? AND source_type = 'live'").get(linkGuardDecision).n === 1 &&
      db.prepare("SELECT COUNT(*) AS n FROM creator_negotiation_cases WHERE record_id = ? AND source_type = 'historical_backfill'").get(linkGuardRecord).n === 1 &&
      // 只新增了「反方向达人」那一条 outcome（关联边界这条被 409 拒绝）
      countOutcomes() === outcomeCountBefore + 1
  )
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
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true })
    } catch {
      /* 忽略清理失败 */
    }
    process.exitCode = failCount > 0 ? 1 : 0
  })
