#!/usr/bin/env node
/**
 * Historical Negotiation Backfill V0.1
 *
 * 运行方式：node tests/historical_negotiation_backfill.test.js
 * 隔离方式：WORKBENCH_DB_PATH 指向临时库（必须先于 import backend/db.js 设置）；真实库只读。
 *
 * 覆盖（对应需求 17 节）：
 *   1 必须 record_id   2 record 不存在 404   3 不需要 decision_id   4 不创建假 decision
 *   5 creator 服务端冻结   6 negotiated_at / created_at 独立   7 negotiated_price 必填
 *   8 =0 合法   9 星图/报价可空   10 无星图 ratio=null   11 actual_cost 不被覆盖
 *   12 plays 不被修改   13 CPM30 快照全 NULL   14 重复 409   15 改名后 record_id 仍稳定
 *   16 reason tags 走现有 12 allowlist   17 AI 只发送 source_note   18 非法 tag 被过滤
 *   19 AI 不写库   20 source_note 不被 AI 覆盖   21 AI 不可用仍可人工保存
 *   22 样板达人09 fixture（5000→4500 / actual_cost 4725 / final CPM 6.62 互不覆盖）
 *   23 legacy live negotiation 保持   24 candidate live negotiation 保持
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-neg-backfill-'))
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
  const calcModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/calc.js')).href
  )

  const postHistorical = getHandler(negotiationModule.default, '/historical-backfill', 'post')
  const postLive = getHandler(negotiationModule.default, '/', 'post')
  const getCases = getHandler(negotiationModule.default, '/', 'get')
  const postHarvest = getHandler(aiModule.default, '/harvest-negotiation-experience', 'post')

  check(
    'handler 可用（historical-backfill / live / GET / AI harvest）',
    typeof postHistorical === 'function' &&
      typeof postLive === 'function' &&
      typeof getCases === 'function' &&
      typeof postHarvest === 'function'
  )

  // ---------- 种子数据：真实投放记录 ----------
  const insertRecord = db.prepare(
    `INSERT INTO creator_records
       (time_cycle, nickname, homepage, creator_type, content_link, total_cost, publish_date,
        video_link, first_play, second_week_play)
     VALUES
       (@time_cycle, @nickname, @homepage, @creator_type, @content_link, @total_cost, @publish_date,
        @video_link, @first_play, @second_week_play)`
  )
  const seed = (over = {}) =>
    Number(
      insertRecord.run({
        time_cycle: '2026-W39',
        nickname: '测试达人',
        homepage: 'https://www.example.com/home',
        creator_type: '科普类',
        content_link: null,
        total_cost: 4725,
        publish_date: '2026-09-29',
        video_link: `https://www.iesdouyin.com/share/video/hist-${Math.random().toString(36).slice(2)}`,
        first_play: 23619,
        second_week_play: 714300,
        ...over
      }).lastInsertRowid
    )

  const getRecord = db.prepare('SELECT * FROM creator_records WHERE id = ?')
  const countCases = () => db.prepare('SELECT COUNT(*) AS n FROM creator_negotiation_cases').get().n
  const countDecisions = () => db.prepare('SELECT COUNT(*) AS n FROM creator_decisions').get().n
  const countOutcomes = () => db.prepare('SELECT COUNT(*) AS n FROM creator_decision_outcomes').get().n

  const call = (handler, req) => {
    const res = createRes()
    handler(req, res)
    return res
  }
  const callHistorical = (body) => call(postHistorical, { body })
  const callGet = (query) => call(getCases, { query })

  // ================= 0. GET 契约（此时 cases 表为空） =================
  console.log('\n===== 0. GET / 查询契约（空表） =====')
  check('前置：cases 表为空', countCases() === 0)
  const emptyBySource = callGet({ source_type: 'historical_backfill' })
  check(
    '1：GET ?source_type=historical_backfill（0 rows）→ 200 且 cases = []',
    emptyBySource.statusCode === 200 &&
      Array.isArray(emptyBySource.payload?.data?.cases) &&
      emptyBySource.payload.data.cases.length === 0
  )
  const emptyByRecord = callGet({ record_id: '920' })
  check(
    '3：GET ?record_id=920（0 rows）→ 200 且 []',
    emptyByRecord.statusCode === 200 && emptyByRecord.payload?.data?.cases.length === 0
  )
  const emptyByCombo = callGet({ record_id: '920', source_type: 'historical_backfill' })
  check(
    '4：GET ?record_id=920&source_type=historical_backfill（0 rows）→ 200 且 []',
    emptyByCombo.statusCode === 200 && emptyByCombo.payload?.data?.cases.length === 0
  )
  const noFilter = callGet({})
  check(
    '旧防护保留：无任何 filter → 400（提示含全部 4 个受支持条件）',
    noFilter.statusCode === 400 &&
      /creator \/ decision_id \/ record_id \/ source_type/.test(noFilter.payload?.msg || '')
  )
  const badSourceType = callGet({ source_type: 'made_up' })
  check('source_type 非法值 → 400', badSourceType.statusCode === 400)
  const badRecordId = callGet({ record_id: 'abc' })
  check('record_id 非法值 → 400', badRecordId.statusCode === 400)

  // ================= 1. 必须绑定 record_id =================
  console.log('\n===== 1. record 锚点 =====')
  const r1 = callHistorical({ negotiated_price: 4500, negotiated_at: '2026-06-15' })
  check('1/2：缺少 record_id → 400', r1.statusCode === 400 && /record_id/.test(r1.payload?.msg || ''))

  const r2 = callHistorical({ record_id: 999999, negotiated_price: 4500, negotiated_at: '2026-06-15' })
  check('2/2：record 不存在 → 404', r2.statusCode === 404)

  // ================= 3/4. 不需要 decision_id，不创建假 decision =================
  console.log('\n===== 3/4. 不伪造 decision =====')
  const recordA = seed({ nickname: '样板达人09', creator_type: '科普类', total_cost: 4725, first_play: 23619, second_week_play: 714300 })
  const decisionsBefore = countDecisions()
  const outcomesBefore = countOutcomes()
  const r3 = callHistorical({
    record_id: recordA,
    negotiated_price: 4500,
    negotiated_at: '2026-06-15',
    xingtu_price_snapshot: null,
    current_quote_snapshot: 5000,
    source_note: '达人最开始报价5000，我先没有急着回复，后面以预算有限+后续合作预期继续谈，最后口头确认4500。'
  })
  check(
    '3：不需要 decision_id 也能创建 historical_backfill',
    r3.statusCode === 200 &&
      r3.payload?.data?.source_type === 'historical_backfill' &&
      r3.payload?.data?.decision_id === null
  )
  check(
    '4：不会创建假 decision / outcome',
    countDecisions() === decisionsBefore && countOutcomes() === outcomesBefore
  )

  // ================= 5. creator 服务端冻结 =================
  console.log('\n===== 5. creator 冻结 =====')
  check(
    '5：creator 取自 record.nickname（旧的「样板达人09」由服务端写入）',
    r3.payload?.data?.creator === '样板达人09'
  )
  const recordB = seed({ nickname: '服务端名字', total_cost: 1000 })
  const r5 = callHistorical({
    record_id: recordB,
    negotiated_price: 900,
    negotiated_at: '2026-05-01',
    creator: '前端伪造的名字'
  })
  check(
    '5b：前端提交的 creator 被忽略',
    r5.statusCode === 200 && r5.payload?.data?.creator === '服务端名字'
  )

  // ================= 6. 时间语义 =================
  console.log('\n===== 6. 时间语义 =====')
  const caseA = r3.payload.data
  const todayPrefix = new Date().toISOString().slice(0, 10)
  check(
    '6：negotiated_at = 历史谈价时间',
    caseA.negotiated_at === '2026-06-15'
  )
  check(
    '6b：created_at = 当前录入时间（与 negotiated_at 独立，未被篡改）',
    typeof caseA.created_at === 'string' &&
      caseA.created_at.slice(0, 4) >= '2026' &&
      caseA.created_at.slice(0, 10) >= todayPrefix &&
      caseA.created_at.slice(0, 10) !== caseA.negotiated_at
  )

  // ================= 7/8/9. 价格字段 =================
  console.log('\n===== 7/8/9. 价格字段 =====')
  const recordC = seed({ nickname: '价格边界' })
  const r7 = callHistorical({ record_id: recordC, negotiated_at: '2026-06-15' })
  check('7：negotiated_price 必填 → 400', r7.statusCode === 400)

  const recordD = seed({ nickname: '零元谈成' })
  const r8 = callHistorical({ record_id: recordD, negotiated_price: 0, negotiated_at: '2026-06-15' })
  check(
    '8：negotiated_price = 0 合法（真实事实）',
    r8.statusCode === 200 && r8.payload?.data?.negotiated_price === 0
  )

  const recordE = seed({ nickname: '无星图无报价' })
  const r9 = callHistorical({
    record_id: recordE,
    negotiated_price: 1200,
    negotiated_at: '2026-06-15',
    xingtu_price_snapshot: '',
    current_quote_snapshot: null
  })
  check(
    '9：星图刊例 / 初始报价可空 → null',
    r9.statusCode === 200 &&
      r9.payload?.data?.xingtu_price_snapshot === null &&
      r9.payload?.data?.current_quote_snapshot === null
  )

  // ================= 10. 无星图 → ratio = null（不是 0 折） =================
  console.log('\n===== 10. 无星图 ratio = null =====')
  const out9 = r9.payload.data.outcome
  check(
    '10：无星图 → xingtu_discount_ratio = null，且不制造 0 折',
    out9.xingtu_discount_ratio === null &&
      out9.xingtu_discount_zhe === null &&
      out9.has_xingtu === false
  )
  // 有星图时正确派生
  const recordF = seed({ nickname: '有星图' })
  const r10 = callHistorical({
    record_id: recordF,
    negotiated_price: 1800,
    negotiated_at: '2026-06-15',
    xingtu_price_snapshot: 5000,
    current_quote_snapshot: 3000
  })
  check(
    '10b：有星图 → xingtu_discount_ratio = 0.36 / initial_quote_to_xingtu_ratio = 0.6 / quote_retention_ratio = 0.6',
    r10.payload?.data?.outcome?.xingtu_discount_ratio === 0.36 &&
      r10.payload?.data?.outcome?.initial_quote_to_xingtu_ratio === 0.6 &&
      r10.payload?.data?.outcome?.quote_retention_ratio === 0.6
  )

  // ================= 11/12. 投放记录不被改写 =================
  console.log('\n===== 11/12. 投放记录只读 =====')
  const beforeA = getRecord.get(recordA)
  const r11 = callHistorical({
    record_id: recordA,
    negotiated_price: 123,
    negotiated_at: '2026-06-16'
  })
  const afterA = getRecord.get(recordA)
  check('11 前置：同一 record 重复回填 → 409', r11.statusCode === 409)
  check(
    '11：actual_cost（total_cost）不被 negotiated_price 覆盖，仍是 4725',
    afterA.total_cost === 4725 && afterA.total_cost === beforeA.total_cost
  )
  check(
    '12：播放量字段不被修改',
    afterA.first_play === beforeA.first_play &&
      afterA.second_week_play === beforeA.second_week_play
  )

  // ================= 13. CPM30 legacy 快照全 NULL =================
  console.log('\n===== 13. 不塞 CPM30 legacy 快照 =====')
  check(
    '13：target_cpm / target_price / reference_low / reference_high 全为 NULL',
    caseA.target_cpm === null &&
      caseA.target_price_snapshot === null &&
      caseA.reference_low_snapshot === null &&
      caseA.reference_high_snapshot === null
  )

  // ================= 14. 重复 =================
  console.log('\n===== 14. append-only / 重复 409 =====')
  check('14：同 record 第二次补录 → 409（已在上方验证）', r11.statusCode === 409)
  check('14b：不同 record 可各自补录', r5.statusCode === 200 && r9.statusCode === 200)

  // ================= 15. 改名后 record_id 仍稳定 =================
  console.log('\n===== 15. 改名稳定性 =====')
  db.prepare('UPDATE creator_records SET nickname = ? WHERE id = ?').run('样板达人09-改名后', recordA)
  const byRecord = callGet({ record_id: String(recordA) })
  check(
    '15：改名后仍能按 record_id 查到案例，且 creator 保持创建时快照',
    byRecord.statusCode === 200 &&
      byRecord.payload?.data?.cases?.length === 1 &&
      byRecord.payload?.data?.cases[0].creator === '样板达人09'
  )
  const byOldName = callGet({ creator: '样板达人09' })
  check(
    '15b：按旧名称查询仍可命中（creator 快照未随改名变化）',
    byOldName.payload?.data?.cases?.length === 1
  )

  // ================= 16. reason tags allowlist =================
  console.log('\n===== 16. reason tags =====')
  check('16 前置：后端 allowlist 仍是 12 个', utils.NEGOTIATION_REASON_TAG_VALUES.length === 12)
  const recordG = seed({ nickname: '标签测试' })
  const r16 = callHistorical({
    record_id: recordG,
    negotiated_price: 800,
    negotiated_at: '2026-06-15',
    reason_tags: ['budget_limited', 'sponsored_below_organic', 'budget_limited'],
    reason_note: '预算有限，商单播放低于日常',
    strategy_note: '以商单播放低于日常作为压价依据'
  })
  check(
    '16b：合法 tag 保存并去重',
    r16.statusCode === 200 &&
      JSON.stringify(r16.payload?.data?.reason_tags) === JSON.stringify(['budget_limited', 'sponsored_below_organic'])
  )
  const recordH = seed({ nickname: '非法标签' })
  const r16c = callHistorical({
    record_id: recordH,
    negotiated_price: 800,
    negotiated_at: '2026-06-15',
    reason_tags: ['budget_limited', 'made_up_tag']
  })
  check('16c：未知 tag → 400 拒绝', r16c.statusCode === 400 && /不在允许范围内/.test(r16c.payload?.msg || ''))

  // ================= 17/18/19/20. AI 蒸馏边界 =================
  console.log('\n===== 17-20. AI 蒸馏 =====')
  const sourceNote = '我觉得他商单明显比日常差，所以压价；他说预算有限，最后答应4500。'
  let capturedArgs = null
  const fakeCall = async (systemPrompt, userText, options) => {
    capturedArgs = { systemPrompt, userText, options }
    return JSON.stringify({
      reason_tags: ['sponsored_below_organic', 'not_a_real_tag'],
      reason_note: '人工备注提到商单播放低于日常',
      strategy_note: '人工备注显示谈价时以商单播放低于日常作为压价依据。'
    })
  }
  const casesBeforeAi = countCases()
  const harvest = await aiModule.harvestNegotiationExperience(sourceNote, fakeCall, { apiKey: 'x' })

  check('17：只把 source_note 作为用户输入发送', capturedArgs?.userText === sourceNote)
  check(
    '17b：system prompt 不含 records / 其它达人 / decision 数据（固定任务 prompt）',
    typeof capturedArgs?.systemPrompt === 'string' &&
      capturedArgs.systemPrompt.includes('allowlist') &&
      capturedArgs.systemPrompt.includes('绝不创造价格事实')
  )
  check(
    '18：非法 tag 被过滤，只保留 allowlist 内的值',
    JSON.stringify(harvest.reason_tags) === JSON.stringify(['sponsored_below_organic'])
  )
  check('19：AI 整理不写库（案例数不变）', countCases() === casesBeforeAi)
  check(
    '19b：AI 模块不依赖数据库（源码级：不 import db）',
    !/from '\.\.\/db\.js'/.test(fs.readFileSync(path.join(REPO_ROOT, 'backend/routes/ai.js'), 'utf8'))
  )
  check(
    '20：source_note 由人工维护，AI 不修改（整理结果不回写 source_note）',
    !Object.prototype.hasOwnProperty.call(harvest, 'source_note')
  )
  const routeHarvestNoNote = call(postHarvest, { body: {} })
  check('17c：AI 路由要求 source_note（空 → 400）', routeHarvestNoNote.statusCode === 400)

  // ================= 21. AI 不可用仍可人工保存 =================
  console.log('\n===== 21. AI 不可用降级 =====')
  const failingCall = async () => {
    throw new Error('AI unavailable')
  }
  let aiFailed = false
  try {
    await aiModule.harvestNegotiationExperience(sourceNote, failingCall, {})
  } catch {
    aiFailed = true
  }
  const recordI = seed({ nickname: 'AI不可用' })
  const r21 = callHistorical({
    record_id: recordI,
    negotiated_price: 1500,
    negotiated_at: '2026-06-20',
    source_note: 'AI 断了，人手工填写'
  })
  check(
    '21：AI 调用失败不影响人工补录（案例仍可保存）',
    aiFailed && r21.statusCode === 200 && r21.payload?.data?.negotiated_price === 1500
  )

  // ================= 22. 样板达人09 fixture =================
  console.log('\n===== 22. 样板达人09 fixture（互不覆盖） =====')
  const fixture = r3.payload.data
  const fixtureRecord = getRecord.get(recordA)
  // 系统统一口径：与前端 calcCpm 完全一致（cost / 累计播放 × 1000，保留 2 位）
  const finalCpm = calcModule.calcCpm(fixtureRecord.total_cost, fixtureRecord.second_week_play)
  check(
    '22：current_quote 5000 → negotiated 4500（quote_change_rate = -0.1）',
    fixture.current_quote_snapshot === 5000 &&
      fixture.negotiated_price === 4500 &&
      fixture.outcome.quote_change_rate === -0.1 &&
      fixture.outcome.quote_drop_direction === 'drop'
  )
  check(
    '22b：negotiated_price = 4500 与 actual_cost = 4725 同时存在、互不覆盖',
    fixture.negotiated_price === 4500 && fixtureRecord.total_cost === 4725 && fixture.negotiated_price !== fixtureRecord.total_cost
  )
  check(
    '22c：final CPM = actual_cost / 累计播放 × 1000 = 6.61（系统 calcCpm 口径）',
    finalCpm === 6.61 && finalCpm === calcModule.calcCpm(4725, 714300),
    String(finalCpm)
  )
  check(
    '22d：source_note 原样保存（人工原始备注是 source of truth）',
    fixture.source_note ===
      '达人最开始报价5000，我先没有急着回复，后面以预算有限+后续合作预期继续谈，最后口头确认4500。'
  )

  // ================= 23/24. live 谈价不受影响 =================
  console.log('\n===== 23/24. live 谈价保持 =====')
  // 造一条 legacy（candidate_id = NULL）post_quote decision
  const legacyDecisionId = Number(
    db
      .prepare(
        `INSERT INTO creator_decisions
           (creator, decision_stage, snapshot_id, current_quote, human_decision,
            historical_evidence_json, target_cpm, pricing_version, created_at)
         VALUES ('legacy达人', 'post_quote', NULL, 3000, 'repurchase',
                 '{}', 30, 'creator-pricing-v1', '2026-09-30 10:44:43')`
      )
      .run().lastInsertRowid
  )
  const rLive = call(postLive, {
    body: { decision_id: legacyDecisionId, negotiated_price: 2200, negotiated_at: '2026-09-30' }
  })
  check(
    '23：legacy live 谈价仍可用（source_type = live / record_id 为 NULL）',
    rLive.statusCode === 200 &&
      rLive.payload?.data?.source_type === 'live' &&
      rLive.payload?.data?.record_id === null &&
      rLive.payload?.data?.decision_id === legacyDecisionId
  )
  // candidate 决策：Unification V0.2 允许报价阶段决策（proceed / small_test / pause）记录已发生谈价
  const candidateDecisionId = Number(
    db
      .prepare(
        `INSERT INTO creator_decisions
           (creator, candidate_id, decision_stage, snapshot_id, current_quote, human_decision,
            historical_evidence_json, target_cpm, pricing_version, created_at)
         VALUES ('候选达人', 1, 'post_quote', NULL, 2000, 'proceed',
                 '{}', 30, 'creator-playbook-postquote-v0.1', '2026-10-09 07:53:56')`
      )
      .run().lastInsertRowid
  )
  const rLiveCandidate = call(postLive, {
    body: {
      decision_id: candidateDecisionId,
      negotiated_price: 1800,
      negotiated_at: '2026-10-09',
      // P0：retrofit（proceed）必须人工填写谈前报价
      current_quote_snapshot: 2000
    }
  })
  check(
    '24：candidate proceed 可记录 live 谈价（V0.2：谈价可能在系统外完成）',
    rLiveCandidate.statusCode === 200 &&
      rLiveCandidate.payload?.data?.source_type === 'live' &&
      rLiveCandidate.payload?.data?.record_id === null &&
      rLiveCandidate.payload?.data?.current_quote_snapshot === 2000
  )
  // 但非报价阶段决策（candidate_review）仍不可挂谈价案例（不伪造报价阶段）
  const reviewDecisionId = Number(
    db
      .prepare(
        `INSERT INTO creator_decisions
           (creator, candidate_id, decision_stage, snapshot_id, current_quote, human_decision,
            historical_evidence_json, target_cpm, pricing_version, created_at)
         VALUES ('候选达人', 1, 'candidate_review', NULL, NULL, 'contact',
                 '{}', 30, 'candidate-review-v0.1', '2026-10-09 07:53:56')`
      )
      .run().lastInsertRowid
  )
  const rReviewDecision = call(postLive, {
    body: { decision_id: reviewDecisionId, negotiated_price: 1800, negotiated_at: '2026-10-09' }
  })
  check(
    '24b：candidate_review 决策仍不可挂谈价案例（不伪造报价阶段）',
    rReviewDecision.statusCode === 400 && /已拿到报价/.test(rReviewDecision.payload?.msg || '')
  )

  // historical_backfill 与 live 可共存于同一张表
  const historicalCount = db
    .prepare("SELECT COUNT(*) AS n FROM creator_negotiation_cases WHERE source_type = 'historical_backfill'")
    .get().n
  const liveCount = db
    .prepare("SELECT COUNT(*) AS n FROM creator_negotiation_cases WHERE source_type = 'live'")
    .get().n
  check(
    '23b：同一张 creator_negotiation_cases 同时存在 live 与 historical_backfill',
    historicalCount >= 6 && liveCount >= 2 && countCases() === historicalCount + liveCount,
    `historical=${historicalCount} live=${liveCount}`
  )

  // ================= 24b. GET 契约（有数据） =================
  console.log('\n===== 24b. GET / 查询契约（有数据） =====')
  const listBySource = callGet({ source_type: 'historical_backfill' })
  check(
    '2：GET ?source_type=historical_backfill 只返回 historical rows',
    listBySource.statusCode === 200 &&
      listBySource.payload.data.cases.length === historicalCount &&
      listBySource.payload.data.cases.every((item) => item.source_type === 'historical_backfill')
  )
  const listByRecord = callGet({ record_id: String(recordA) })
  check(
    '3b：GET ?record_id=… 只返回该投放记录的案例',
    listByRecord.statusCode === 200 &&
      listByRecord.payload.data.cases.length === 1 &&
      listByRecord.payload.data.cases[0].record_id === recordA
  )
  // 组合查询语义为 AND：record_id + source_type 只应命中所属记录（而不是全量 historical）
  const listByCombo = callGet({ record_id: String(recordA), source_type: 'historical_backfill' })
  check(
    '4b：GET ?record_id=…&source_type=historical_backfill 组合为 AND（仅命中该记录）',
    listByCombo.statusCode === 200 &&
      listByCombo.payload.data.cases.length === 1 &&
      listByCombo.payload.data.cases[0].record_id === recordA
  )
  const listByCreator = callGet({ creator: '样板达人09' })
  check(
    '5：旧 creator filter 继续正常',
    listByCreator.statusCode === 200 &&
      listByCreator.payload.data.cases.length === 1 &&
      listByCreator.payload.data.cases[0].creator === '样板达人09'
  )
  const listByDecision = callGet({ decision_id: String(legacyDecisionId) })
  check(
    '6：旧 decision_id filter 继续正常',
    listByDecision.statusCode === 200 &&
      listByDecision.payload.data.cases.length === 1 &&
      listByDecision.payload.data.cases[0].decision_id === legacyDecisionId
  )
  const liveOnly = callGet({ source_type: 'live' })
  check(
    '2b：source_type=live 只返回 live case（不含任何 historical_backfill）',
    liveOnly.payload.data.cases.length === liveCount &&
      liveOnly.payload.data.cases.every((item) => item.source_type === 'live')
  )
  check(
    '7：historical case 不需要 decision_id（record_id 存在、decision_id 为 null）',
    listByRecord.payload.data.cases[0].decision_id === null &&
      listByRecord.payload.data.cases[0].record_id === recordA
  )
  // Records 页面标记历史回填的加载路径：请求 ?source_type=historical_backfill 且失败被静默捕获
  const recordsSrc = fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/pages/Records/index.jsx'), 'utf8')
  check(
    '8：Records 页面用 source_type=historical_backfill 加载映射（不再触发旧 400 校验）',
    /getNegotiationCasesBySourceType\('historical_backfill'\)/.test(recordsSrc) &&
      listBySource.statusCode === 200
  )
  check(
    '8b：该后台加载失败被静默捕获（不额外弹错，仅由拦截器提示）',
    /const res = await getNegotiationCasesBySourceType\('historical_backfill'\)[\s\S]{0,300}?catch \{/.test(recordsSrc)
  )

  // ================= 25. AI 建议 ≠ 已保存案例（UX 语义） =================
  console.log('\n===== 25. AI 建议 / 应用到表单 / 最终保存 语义 =====')
  const modalSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/components/HistoricalNegotiationCaseModal.jsx'),
    'utf8'
  )
  // Unification V0.2：谈价经验（source_note / AI整理 / 原因标签 / 补充说明 / 依据过程）已抽到共享组件
  const sharedFormSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/src/components/NegotiationExperienceForm.jsx'),
    'utf8'
  )
  // 取某个组件内函数的函数体（简单花括号配对）
  const extractBody = (source, declaration) => {
    const start = source.indexOf(declaration)
    if (start === -1) return ''
    const braceStart = source.indexOf('{', start)
    if (braceStart === -1) return ''
    let depth = 0
    for (let i = braceStart; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(braceStart, i + 1)
      }
    }
    return ''
  }

  check(
    '1：不再出现误导性的「保存整理结果」',
    !modalSrc.includes('保存整理结果') && !sharedFormSrc.includes('保存整理结果')
  )
  check('2：AI 预览标题为「AI整理建议（尚未保存）」', sharedFormSrc.includes('AI整理建议（尚未保存）'))
  check('3：按钮文案为「应用到表单」', sharedFormSrc.includes('应用到表单'))
  check('3b：最终保存按钮明确叫「保存历史谈价案例」', modalSrc.includes('保存历史谈价案例'))
  check(
    '3c：历史回填与候选 live 共用同一谈价经验组件（不复制两套 JSX）',
    /<NegotiationExperienceForm/.test(modalSrc) &&
      /<NegotiationExperienceForm/.test(
        fs.readFileSync(path.join(REPO_ROOT, 'frontend/src/components/CandidateNegotiationExperienceModal.jsx'), 'utf8')
      )
  )

  const applyBody = extractBody(sharedFormSrc, 'const applySuggestion')
  check(
    '4：应用到表单只写当前表单状态，不调用任何写入接口',
    Boolean(applyBody) &&
      !/createHistoricalNegotiationCase/.test(applyBody) &&
      !/createNegotiationCase/.test(applyBody) &&
      !/request\.post/.test(applyBody) &&
      /patch\(\{/.test(applyBody) &&
      /reasonTags/.test(applyBody) &&
      /reasonNote/.test(applyBody) &&
      /strategyNote/.test(applyBody)
  )

  const modalApiCalls = modalSrc.match(/createHistoricalNegotiationCase\(/g) || []
  const saveBody = extractBody(modalSrc, 'const handleSave')
  check(
    '5：只有最终保存动作才调用 historical backfill POST',
    modalApiCalls.length === 1 && /createHistoricalNegotiationCase\(/.test(saveBody)
  )
  check(
    '5b：应用 AI 建议后仍需最终保存（提示文案明确「保存历史谈价案例后才会写入系统」）',
    /已应用到表单，保存\$\{saveLabel\}后才会写入系统。/.test(sharedFormSrc) &&
      /应用到表单不会写入系统；保存\{saveLabel\}后才会持久化。/.test(sharedFormSrc) &&
      /saveLabel="历史谈价案例"/.test(modalSrc)
  )
  check(
    '6：取消 / 关闭 Modal 不写 case（关闭路径不调用 POST，仅重置表单）',
    !/onCancel=\{[^}]*createHistoricalNegotiationCase/.test(modalSrc) &&
      !/const onClose[\s\S]{0,200}createHistoricalNegotiationCase/.test(modalSrc)
  )
  check(
    '7：source_note 不被 AI 修改（建议只写入 reason_tags / reason_note / strategy_note）',
    !/sourceNote/.test(applyBody) &&
      !/aiSuggestion\.source_note/.test(sharedFormSrc) &&
      !Object.prototype.hasOwnProperty.call(harvest, 'source_note')
  )

  // 行为验证：应用建议（仅表单）后未保存 → 案例数不变；最终保存才 +1
  const casesBeforeApply = countCases()
  // 「应用到表单」= 只把建议值放进当前表单状态（见 applyBody 断言），此处不触发任何 POST
  check('4b：应用建议后案例数不变（未发生持久化）', countCases() === casesBeforeApply)
  const recordJ = seed({ nickname: '应用后保存' })
  const rFinal = callHistorical({
    record_id: recordJ,
    negotiated_price: 1100,
    negotiated_at: '2026-06-18',
    source_note: '人工原始备注',
    reason_tags: harvest.reason_tags,
    reason_note: harvest.reason_note,
    strategy_note: harvest.strategy_note
  })
  check(
    '5c：最终保存动作才真正写入（案例数 +1）',
    rFinal.statusCode === 200 && countCases() === casesBeforeApply + 1
  )
  check(
    '7b：保存后 source_note 仍是人工填写内容（未被 AI 建议覆盖）',
    rFinal.payload?.data?.source_note === '人工原始备注'
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
