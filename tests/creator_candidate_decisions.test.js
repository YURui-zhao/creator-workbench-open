#!/usr/bin/env node
// Creator Identity V1 Phase 3 —— candidate「当前处理」写入回归测试
//
// 运行方式：node tests/creator_candidate_decisions.test.js
// 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
// 网络：拦截 http/https/net/tls/fetch —— 本能力纯确定性，不调用 AI、不访问网络。
//
// 【Phase 3 语义变更（本文件的重点）】
//   · candidate_review decision 已废弃：POST /api/creator-candidates/:id/decisions
//     不再写入 creator_decisions，而是翻译成 candidate_work_state_events：
//       contact → advancing / observe → observing / hold → paused
//   · Work State 读契约见 tests/candidate_work_state_read.test.js
//   · Work State 写契约（POST /:id/work-state、append-only、非法值、note）见
//     tests/candidate_work_state_write.test.js
//   · 本文件覆盖：Phase 1 之前的安全降级（503）、legacy endpoint 兼容形状、enum/伪造防护、
//     append-only + latest 排序、candidate 改名 / 同名隔离、旧 /api/creator-decisions 流程不变、无 AI / 无网络

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-work-state-legacy-'))
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
      blocked.push(method)
      throw new Error('candidate work state legacy test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('candidate work state legacy test forbids network requests')
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

const play = (value, type = 'sponsored', index = 1) => ({
  raw_text: String(value),
  excluded: false,
  content_type: type,
  source_image_index: 1,
  position_index: index
})

const OBSERVED_AT = '2026-10-03'

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const candidates = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorCandidates.js')).href
    )
    const decisions = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorDecisions.js')).href
    )
    const snapshots = await import(
      pathToFileURL(path.join(root, 'backend/routes/recentSnapshots.js')).href
    )
    const migration = await import(
      pathToFileURL(path.join(root, 'backend/migrations/001_creator_identity.js')).href
    )
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

    const candidateRouter = candidates.default
    const decisionRouter = decisions.default
    const findHandler = (router, routePath, method) => {
      const layer = router.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const callRoute = async (handler, { body = {}, query = {}, params = {}, headers = {} } = {}) => {
      const res = response()
      await handler({ body, query, params, headers }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    const createCandidate = findHandler(candidateRouter, '/', 'post')
    const patchCandidate = findHandler(candidateRouter, '/:id', 'patch')
    const saveCandidateSnapshot = findHandler(candidateRouter, '/:id/recent-snapshots', 'post')
    const listCandidateDecisions = findHandler(candidateRouter, '/:id/decisions', 'get')
    const createCandidateDecision = findHandler(candidateRouter, '/:id/decisions', 'post')
    const createWorkState = findHandler(candidateRouter, '/:id/work-state', 'post')
    const legacyCreateDecision = findHandler(decisionRouter, '/', 'post')
    const legacyListDecisions = findHandler(decisionRouter, '/', 'get')
    const legacyLatestSnapshot = findHandler(snapshots.default, '/latest', 'get')

    // ---------- 历史投放池 ----------
    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES ('2026-W40', ?, ?, ?, '2026-08-20', ?, ?)`
    )
    const addRecord = (nickname, type, cost, first, sw) =>
      Number(insertRecord.run(nickname, type, cost, first, sw).lastInsertRowid)
    addRecord('历史甲', '科普', 1500, 50000, 50000)
    addRecord('历史乙', '历史类', 1080, 54000, 54000)
    addRecord('旧达人', '科普', 1000, 30000, 30000) // 供旧 contact/post_quote 回归

    // ---------- candidates ----------
    const mkCand = async (name, type, plays, xingtuRaw) => {
      const c = await callRoute(createCandidate, { body: { name, creator_type: type } })
      if (plays) {
        await callRoute(saveCandidateSnapshot, {
          params: { id: String(c.data.id) },
          body: { observed_at: OBSERVED_AT, xingtu_price_raw: xingtuRaw ?? null, plays }
        })
      }
      return c.data
    }
    const candA = await mkCand('同名达人', '科普', [
      play(50000, 'sponsored', 1), play(51000, 'sponsored', 2), play(53000, 'sponsored', 3), play(54000, 'sponsored', 4),
      play(80000, 'organic', 5), play(90000, 'organic', 6), play(12000, 'unknown', 7)
    ], '¥5,000')
    const candB = await mkCand('同名达人', '科普', [play(99999, 'sponsored', 1)], '¥3,000')
    const candNoSnap = await mkCand('无快照达人', '科普', null, null)

    const snapshotIdOf = (candidateId) =>
      db.prepare('SELECT id FROM creator_recent_snapshots WHERE candidate_id = ?').get(candidateId)?.id ?? null
    const decisionsCount = () => db.prepare('SELECT COUNT(*) AS n FROM creator_decisions').get().n
    const reviewCount = () => db.prepare("SELECT COUNT(*) AS n FROM creator_decisions WHERE decision_stage='candidate_review'").get().n
    const eventsCount = () => db.prepare('SELECT COUNT(*) AS n FROM candidate_work_state_events').get().n

    console.log('===== 1. Phase 1 之前：Work State 写入安全降级（绝不落 legacy decisions）=====')
    check('events 表尚不存在（fixture 为 Phase 1 之前形状）',
      !db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name='candidate_work_state_events'").get())
    const decisionsBefore = decisionsCount()
    const preWorkState = await callRoute(createWorkState, { params: { id: String(candA.id) }, body: { state: 'paused' } })
    check('POST /work-state → 503（明确提示先执行 migration，不 500）',
      preWorkState.status === 503 && /migration/.test(String(preWorkState.msg)))
    const preLegacy = await callRoute(createCandidateDecision, { params: { id: String(candA.id) }, body: { human_decision: 'hold' } })
    check('legacy POST /decisions 同样 503（不再写 creator_decisions）',
      preLegacy.status === 503 && decisionsCount() === decisionsBefore)

    console.log('\n===== 2. 执行 Phase 1 migration（临时库）→ Work State 写入就绪 =====')
    const migrated = migration.runMigration(db, { mode: 'commit' })
    check('migration commit 成功', migrated.ok === true)
    check('events 表已建立', eventsCount() === 0)
    check('candidate 归属 creator（additive）',
      Number.isInteger(db.prepare('SELECT creator_id FROM creator_candidates WHERE id = ?').get(candA.id).creator_id))

    console.log('\n===== 3. legacy endpoint 兼容 shim：contact / observe / hold =====')
    const beforeLegacy = { decisions: decisionsCount(), review: reviewCount(), events: eventsCount() }
    const mapCases = [['contact', 'advancing'], ['observe', 'observing'], ['hold', 'paused']]
    for (const [human, expected] of mapCases) {
      const res = await callRoute(createCandidateDecision, {
        params: { id: String(candB.id) },
        body: { human_decision: human, decision_note: `note-${human}` }
      })
      check(`legacy ${human} → ${expected}`, res.status === 200 && res.data.work_state === expected && res.data.work_state_event?.state === expected)
      check(`legacy ${human} 响应保留旧形状（decision_stage / human_decision / label / note）`,
        res.data.decision_stage === 'candidate_review' &&
          res.data.human_decision === human &&
          res.data.human_decision_label === decisions.HUMAN_DECISION_LABELS[human] &&
          res.data.decision_note === `note-${human}`)
      check(`legacy ${human} 标记 deprecated 且指向新 endpoint`,
        res.data.deprecated === true && /work-state/.test(String(res.data.deprecated_message)))
      check(`legacy ${human} 不再产生 evidence / pricing / snapshot`,
        res.data.snapshot_id === null && res.data.recent_evidence === null &&
          res.data.pricing_evidence === null && res.data.target_cpm === null &&
          res.data.pricing_version === null && res.data.historical_evidence === null)
    }
    check('legacy 写入只增加 events（+3）', eventsCount() === beforeLegacy.events + 3)
    check('legacy 写入不新增 creator_decisions', decisionsCount() === beforeLegacy.decisions)
    check('legacy 写入不新增 candidate_review', reviewCount() === beforeLegacy.review)
    check('legacy 原值记录在 legacy_state（技术审计）',
      db.prepare("SELECT COUNT(*) AS n FROM candidate_work_state_events WHERE legacy_state IN ('contact','observe','hold')").get().n === 3)
    check('legacy_state 与 state 映射一致',
      db.prepare("SELECT COUNT(*) AS n FROM candidate_work_state_events WHERE legacy_state='observe' AND state='observing'").get().n === 1)
    check('无 snapshot 的 candidate 也能记录 Work State（不再要求近期表现）',
      (await callRoute(createWorkState, { params: { id: String(candNoSnap.id) }, body: { state: 'observing', note: 'n' } })).status === 200)
    check('有 snapshot 也不产生 evidence（Work State 与 snapshot 无关）',
      !db.prepare('PRAGMA table_info(candidate_work_state_events)').all().some((col) => /snapshot|evidence|pricing/.test(col.name)))

    console.log('\n===== 4. 前端不能伪造 identity / stage / state =====')
    const forged = await callRoute(createCandidateDecision, {
      params: { id: String(candA.id) },
      body: {
        human_decision: 'contact',
        candidate_id: 999,
        creator: '伪造名称',
        decision_stage: 'post_quote',
        state: 'paused',
        legacy_state: 'hold'
      }
    })
    check('伪造 candidate_id 被忽略（用路径 candidate）', forged.data?.candidate_id === candA.id)
    check('伪造 creator 被忽略（服务端用 candidate.name）', forged.data?.creator === '同名达人')
    check('伪造 decision_stage 被忽略', forged.data?.decision_stage === 'candidate_review')
    check('伪造 state 被忽略（沿用 human_decision 映射）',
      forged.data?.work_state === 'advancing' && forged.data?.work_state_event?.state === 'advancing')
    check('伪造 legacy_state 被忽略（记录真实映射来源）',
      db.prepare('SELECT legacy_state FROM candidate_work_state_events WHERE id = ?').get(forged.data.work_state_event.id).legacy_state === 'contact')

    console.log('\n===== 5. enum 不变 + 非法值 / 404 =====')
    check('只接受 contact / observe / hold', JSON.stringify(decisions.CANDIDATE_REVIEW_DECISIONS) === JSON.stringify(['contact', 'observe', 'hold']))
    for (const bad of ['contact_now', 'skip_for_now', 'repurchase', 'pause', 'advancing', '']) {
      const r = await callRoute(createCandidateDecision, { params: { id: String(candA.id) }, body: { human_decision: bad } })
      check(`拒绝非法 human_decision「${bad}」`, r.status === 400)
    }
    check('缺少 human_decision -> 400', (await callRoute(createCandidateDecision, { params: { id: String(candA.id) }, body: {} })).status === 400)
    check('旧 DECISION_STAGES 不变', JSON.stringify(decisions.DECISION_STAGES) === JSON.stringify(['contact', 'post_quote']))
    check('旧 CONTACT_DECISIONS / POST_QUOTE_DECISIONS 不变',
      JSON.stringify(decisions.CONTACT_DECISIONS) === JSON.stringify(['contact_now', 'observe', 'skip_for_now']) &&
        JSON.stringify(decisions.POST_QUOTE_DECISIONS) === JSON.stringify(['repurchase', 'small_test', 'negotiate', 'pause']))
    check('旧 label 未被覆盖',
      decisions.HUMAN_DECISION_LABELS.contact_now === '开始建联' &&
        decisions.HUMAN_DECISION_LABELS.skip_for_now === '暂不联系' &&
        decisions.HUMAN_DECISION_LABELS.pause === '暂缓' &&
        decisions.HUMAN_DECISION_LABELS.contact === '继续联系' &&
        decisions.HUMAN_DECISION_LABELS.hold === '暂不推进')
    check('旧 POST 不接受 candidate_review stage',
      (await callRoute(legacyCreateDecision, { body: { creator: '旧达人', decision_stage: 'candidate_review', human_decision: 'contact' } })).status === 400)
    check('候选不存在 -> 404', (await callRoute(createCandidateDecision, { params: { id: '99999' }, body: { human_decision: 'hold' } })).status === 404)
    check('candidate 列表接口不再返回 legacy decisions 作为 Work State（字段仍 additive）',
      (await callRoute(findHandler(candidateRouter, '/', 'get'), {})).data.candidates.every((item) => WORK_STATES.includes(item.work_state)))

    console.log('\n===== 6. append-only + latest 排序（新表） =====')
    const beforeAppend = eventsCount()
    const e1 = await callRoute(createWorkState, { params: { id: String(candA.id) }, body: { state: 'observing', note: '第一次' } })
    const e2 = await callRoute(createWorkState, { params: { id: String(candA.id) }, body: { state: 'advancing', note: '第二次' } })
    check('两次写入产生两条不同 event（不 UPDATE）', eventsCount() === beforeAppend + 2 && e1.data.work_state_event.id !== e2.data.work_state_event.id)
    check('新 event 成为 latest', e2.data.candidate.work_state === 'advancing' && e2.data.candidate.work_state_note === '第二次')
    const detailA = await callRoute(findHandler(candidateRouter, '/:id', 'get'), { params: { id: String(candA.id) } })
    // candA 到此刻共 3 条 event：§4 伪造防护写入的 legacy contact + §6 的 e1/e2
    check('detail.history 最新 → 最旧（append-only 全量保留）',
      detailA.data.work_state_history.length === 3 &&
        detailA.data.work_state_history[0].note === '第二次' &&
        detailA.data.work_state_history[1].note === '第一次')
    check('GET /:id/decisions 只返回真实业务决策（candidate_review 不再出现）',
      (await callRoute(listCandidateDecisions, { params: { id: String(candA.id) } })).data.decisions.every((row) => row.decision_stage !== 'candidate_review'))

    console.log('\n===== 7. candidate 改名不断链 =====')
    const beforeRename = await callRoute(findHandler(candidateRouter, '/:id', 'get'), { params: { id: String(candA.id) } })
    await callRoute(patchCandidate, { params: { id: String(candA.id) }, body: { name: '改名后达人' } })
    const afterRename = await callRoute(findHandler(candidateRouter, '/:id', 'get'), { params: { id: String(candA.id) } })
    check('改名后 Work State 与历史不变（events 只按 candidate_id 关联）',
      afterRename.data.work_state === beforeRename.data.work_state &&
        afterRename.data.work_state_history.length === beforeRename.data.work_state_history.length)
    const renamedWrite = await callRoute(createWorkState, { params: { id: String(candA.id) }, body: { state: 'paused' } })
    check('改名后仍可写（candidate_id 稳定）', renamedWrite.status === 200 && renamedWrite.data.candidate.work_state === 'paused')
    check('events 表没有 creator 文本列（不复制名称）',
      !db.prepare('PRAGMA table_info(candidate_work_state_events)').all().some((col) => /creator|name/.test(col.name)))

    console.log('\n===== 8. 同名 candidate 不串 =====')
    const detailB = await callRoute(findHandler(candidateRouter, '/:id', 'get'), { params: { id: String(candB.id) } })
    const listA = await callRoute(findHandler(candidateRouter, '/', 'get'), {})
    const rowA = listA.data.candidates.find((item) => item.id === candA.id)
    const rowB = listA.data.candidates.find((item) => item.id === candB.id)
    // A：§4 伪造(1) + §6 e1/e2(2) + §7 改名后写入(1) = 4 ；B：§3 legacy contact/observe/hold = 3
    const eventsOf = (candidateId) =>
      Number(db.prepare('SELECT COUNT(*) AS n FROM candidate_work_state_events WHERE candidate_id = ?').get(candidateId).n)
    check('A / B 的 event 各自独立（A=4, B=3）', eventsOf(candA.id) === 4 && eventsOf(candB.id) === 3, `A=${eventsOf(candA.id)} B=${eventsOf(candB.id)}`)
    check('B 的 history 全量保留 3 条', detailB.data.work_state_history.length === 3)
    check('同名候选各自状态独立', rowA.work_state === 'paused' && rowB.work_state === 'paused')
    check('events 全部挂在存在的 candidate 上',
      db.prepare('SELECT COUNT(*) AS n FROM candidate_work_state_events e WHERE NOT EXISTS (SELECT 1 FROM creator_candidates c WHERE c.id = e.candidate_id)').get().n === 0)
    check('snapshot 关联未被 Work State 影响（A 仍有自己的 snapshot）', snapshotIdOf(candA.id) !== null && snapshotIdOf(candB.id) !== null)

    console.log('\n===== 9. 无推荐 / 无 AI / 旧 Decision 流程兼容 =====')
    check('response 不含 should_invest / recommendation_score / similarity',
      !/should_invest|recommendation_score|similarity|recommended_price/.test(JSON.stringify(e2.body)))
    const routeSource = fs.readFileSync(path.join(root, 'backend/routes/creatorCandidates.js'), 'utf8')
    check('candidate Work State 写入不引用 AI 服务', !/deepseek|callProviderVision|extract-creator-screenshot/i.test(routeSource))
    const histSnap = await callRoute(
      findHandler(snapshots.default, '/', 'post'),
      { body: { creator: '旧达人', recognized_creator_name_raw: '旧达人', observed_at: OBSERVED_AT, plays: [play(30000, 'sponsored', 1)] } }
    )
    const legacyDecision = await callRoute(legacyCreateDecision, {
      body: { creator: '旧达人', decision_stage: 'contact', human_decision: 'contact_now', ip_judgement: 'strong' }
    })
    check('旧 contact decision 仍可创建（历史达人流程未变）', legacyDecision.status === 200, JSON.stringify(legacyDecision.msg))
    check('旧 decision.candidate_id = null', legacyDecision.data?.candidate_id === null)
    const legacyList = await callRoute(legacyListDecisions, { query: { creator: '旧达人' } })
    check('旧 GET /api/creator-decisions 行为不变', legacyList.status === 200 && legacyList.data.decisions.some((x) => x.id === legacyDecision.data.id))
    check('legacy latest snapshot 行为不变', (await callRoute(legacyLatestSnapshot, { query: { creator: '旧达人' } })).data.snapshot?.id === histSnap.data.id)

    console.log('\n===== 10. Phase 3 硬要求：candidate_review 不再增长 =====')
    check('本轮所有写入后 candidate_review 行数 = 迁移前（0 条新增）', reviewCount() === beforeLegacy.review, String(reviewCount()))
    check('creator_decisions 仅由旧历史达人流程增加（candidate 侧 0 新增）', decisionsCount() === beforeLegacy.decisions + 1, String(decisionsCount()))
    check('未发生任何外部网络请求', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))
  } finally {
    networkGuard.restore()
  }
}

// 与后端 WORK_STATE_STATES 同步的本地常量（避免测试直接依赖内部模块导出）
const WORK_STATES = ['advancing', 'observing', 'paused']

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    failCount += 1
    failures.push(`执行异常：${error?.message || error}`)
    process.exitCode = 1
  })
  .finally(() => {
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true })
    } catch {
      /* ignore */
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
