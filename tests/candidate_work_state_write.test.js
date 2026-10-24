#!/usr/bin/env node
// Creator Identity V1 Phase 3 —— Work State 写入契约测试（temp DB only）
//
// 运行方式：node tests/candidate_work_state_write.test.js
// 隔离：os.tmpdir() 下的临时库；先建 fixture，执行 Phase 1 migration（commit），再做写行为验证。
// 网络：拦截 http/https/net/tls/fetch。
//
// 覆盖（PHASE3 §10 / §11）：
//   A advancing→observing 新增 1 event 且旧 event 保留   B observing→paused 新增事件
//   C 同状态连续两次 → 两条 event（append-only，不 silent dedupe）   D note 保留
//   E 非法 state → 400    F candidate 不存在 → 404
//   G 写 Work State 后 creator_decisions 总数 / candidate_review 数不变   H post_quote 数不变
//   I 新 event 成为 latest（list 与 detail 同源）   J created_at 相同用 id 决胜
//   + legacy candidate_review endpoint：只写 events、绝不写 creator_decisions，映射 contact/observe/hold
//   + 响应契约（work_state_event / candidate / deprecated）

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-work-state-write-'))
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
  const targets = [
    [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'], [tls, 'connect']
  ]
  const originals = targets.map(([target, method]) => [target, method, target[method]])
  for (const [target, method] of targets) {
    target[method] = () => {
      blocked.push(method)
      throw new Error('candidate work state write test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('candidate work state write test forbids network requests')
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

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const db = (await import(pathToFileURL(path.join(REPO_ROOT, 'backend/db.js')).href)).default
    const candidatesModule = await import(
      pathToFileURL(path.join(REPO_ROOT, 'backend/routes/creatorCandidates.js')).href
    )
    const migration = await import(
      pathToFileURL(path.join(REPO_ROOT, 'backend/migrations/001_creator_identity.js')).href
    )
    const findHandler = (routePath, method) => {
      const layer = candidatesModule.default.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const callRoute = async (handler, { body = {}, query = {}, params = {} } = {}) => {
      const res = response()
      await handler({ body, query, params, headers: {} }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }
    const postWorkState = findHandler('/:id/work-state', 'post')
    const postLegacyDecision = findHandler('/:id/decisions', 'post')
    const listCandidates = findHandler('/', 'get')
    const getCandidate = findHandler('/:id', 'get')

    // ---------- fixture ----------
    db.prepare(
      "INSERT INTO creator_candidates (id, name, creator_type, status, created_at, updated_at) VALUES (1, '写入甲', '科普类', 'active', '2026-09-01 00:00:00', '2026-09-01 00:00:00')"
    ).run()
    db.prepare(
      "INSERT INTO creator_candidates (id, name, creator_type, status, created_at, updated_at) VALUES (2, '归档乙', '历史类', 'archived', '2026-09-01 00:00:00', '2026-09-01 00:00:00')"
    ).run()
    const insertDecision = db.prepare(
      `INSERT INTO creator_decisions (id, creator, candidate_id, decision_stage, human_decision, decision_note,
                                      historical_evidence_json, target_cpm, pricing_version,
                                      system_context_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', 30, 'v', 'v', ?)`
    )
    insertDecision.run(1, '写入甲', 1, 'candidate_review', 'contact', 'legacy-1', '2026-09-02 00:00:00')
    insertDecision.run(2, '写入甲', 1, 'post_quote', 'proceed', 'post-1', '2026-09-03 00:00:00')
    insertDecision.run(3, '归档乙', 2, 'post_quote', 'pause', 'post-2', '2026-09-04 00:00:00')

    const migrated = migration.runMigration(db, { mode: 'commit' })
    check('Phase 1 migration（临时库）成功，work_state_events 基线 = 1', migrated.ok === true && db.prepare('SELECT COUNT(*) n FROM candidate_work_state_events').get().n === 1)

    const counts = () => ({
      decisions: db.prepare('SELECT COUNT(*) n FROM creator_decisions').get().n,
      review: db.prepare("SELECT COUNT(*) n FROM creator_decisions WHERE decision_stage='candidate_review'").get().n,
      postQuote: db.prepare("SELECT COUNT(*) n FROM creator_decisions WHERE decision_stage='post_quote'").get().n,
      events: db.prepare('SELECT COUNT(*) n FROM candidate_work_state_events').get().n
    })
    const before = counts()

    console.log('===== A. advancing → observing：新增 1 event，旧 event 保留 =====')
    const a1 = await callRoute(postWorkState, { params: { id: '1' }, body: { state: 'advancing', note: '先推进' } })
    check('POST /work-state 200', a1.status === 200, JSON.stringify(a1.msg))
    check('返回 work_state_event（id/candidate_id/state/note/created_at）',
      a1.data?.work_state_event?.state === 'advancing' &&
        a1.data.work_state_event.candidate_id === 1 &&
        a1.data.work_state_event.note === '先推进' &&
        Boolean(a1.data.work_state_event.created_at) &&
        Number.isInteger(a1.data.work_state_event.id))
    check('返回 candidate（与 list/detail 同 contract）',
      a1.data?.candidate?.id === 1 && a1.data.candidate.work_state === 'advancing' && a1.data.candidate.work_state_source === 'events')
    const a2 = await callRoute(postWorkState, { params: { id: '1' }, body: { state: 'observing', note: '先观察' } })
    // before.events = 1（migration 从 legacy contact 回填的 advancing）；a1 + a2 各 +1
    check('advancing → observing 各新增 1 条 event（两次写入共 +2）', counts().events === before.events + 2, String(counts().events))
    check('迁移回填的旧 event 未被 UPDATE（legacy_state=contact 仍原样存在）',
      db.prepare("SELECT COUNT(*) n FROM candidate_work_state_events WHERE candidate_id=1 AND legacy_state='contact'").get().n === 1)
    check('新 event 成为 latest（响应与 list 一致）',
      a2.data.candidate.work_state === 'observing' &&
        (await callRoute(listCandidates, {})).data.candidates.find((c) => c.id === 1).work_state === 'observing')

    console.log('\n===== B. observing → paused =====')
    const b = await callRoute(postWorkState, { params: { id: '1' }, body: { state: 'paused' } })
    check('新增 event 且状态 = paused', b.status === 200 && b.data.candidate.work_state === 'paused' && counts().events === before.events + 3)
    check('note 缺省为 null（可选字段）', b.data.work_state_event.note === null)

    console.log('\n===== C. 同一状态连续两次 → 两条 event（不 silent dedupe） =====')
    const c1 = await callRoute(postWorkState, { params: { id: '1' }, body: { state: 'paused', note: '第一次暂缓' } })
    const c2 = await callRoute(postWorkState, { params: { id: '1' }, body: { state: 'paused', note: '第二次暂缓' } })
    check('两次都 200 且各自返回不同 event id', c1.status === 200 && c2.status === 200 && c1.data.work_state_event.id !== c2.data.work_state_event.id)
    check('events +2（append-only，不去重）', counts().events === before.events + 5, String(counts().events))
    check('两条 paused 都能读到（note 不同）',
      db.prepare("SELECT COUNT(*) n FROM candidate_work_state_events WHERE candidate_id=1 AND state='paused'").get().n === 3)

    console.log('\n===== D. note 保留 =====')
    const noteRow = db.prepare('SELECT note FROM candidate_work_state_events WHERE id = ?').get(c2.data.work_state_event.id)
    check('note 原样保存（含中文）', noteRow.note === '第二次暂缓')
    check('detail 的 work_state_note 与最新 event 一致',
      (await callRoute(getCandidate, { params: { id: '1' } })).data.work_state_note === '第二次暂缓')

    console.log('\n===== E. 非法 state → 400 =====')
    check('state=contact（legacy 值）被拒绝', (await callRoute(postWorkState, { params: { id: '1' }, body: { state: 'contact' } })).status === 400)
    check('state 缺失被拒绝', (await callRoute(postWorkState, { params: { id: '1' }, body: {} })).status === 400)
    check('state=random 被拒绝', (await callRoute(postWorkState, { params: { id: '1' }, body: { state: 'random' } })).status === 400)
    check('非法 state 未产生 event', counts().events === before.events + 5)
    check('note 超长 → 400', (await callRoute(postWorkState, { params: { id: '1' }, body: { state: 'paused', note: 'x'.repeat(501) } })).status === 400)

    console.log('\n===== F. candidate 不存在 → 404 =====')
    check('不存在 candidate → 404', (await callRoute(postWorkState, { params: { id: '9999' }, body: { state: 'paused' } })).status === 404)
    check('非法 id → 404（不 500）', (await callRoute(postWorkState, { params: { id: 'abc' }, body: { state: 'paused' } })).status === 404)

    console.log('\n===== G/H. 写 Work State 绝不影响 creator_decisions =====')
    const after = counts()
    check('creator_decisions 总数不变', after.decisions === before.decisions, `${before.decisions} → ${after.decisions}`)
    check('candidate_review 行数不变（Phase 3 后不再新增）', after.review === before.review, `${before.review} → ${after.review}`)
    check('post_quote 行数不变', after.postQuote === before.postQuote, `${before.postQuote} → ${after.postQuote}`)
    check('work state event 不含 pricing / evidence / snapshot 字段',
      !db.prepare('PRAGMA table_info(candidate_work_state_events)').all().some((col) => /pricing|evidence|snapshot|target_cpm/.test(col.name)))

    console.log('\n===== I/J. latest 语义（list 与 detail 同源；created_at 相同用 id 决胜） =====')
    db.prepare(
      "INSERT INTO candidate_work_state_events (candidate_id, state, legacy_state, note, created_at) VALUES (2, 'paused', NULL, 'ts-low', '2026-09-20 00:00:00')"
    ).run()
    const higherId = db.prepare(
      "INSERT INTO candidate_work_state_events (candidate_id, state, legacy_state, note, created_at) VALUES (2, 'advancing', NULL, 'ts-high', '2026-09-20 00:00:00')"
    ).run().lastInsertRowid
    const jList = (await callRoute(listCandidates, {})).data.candidates.find((c) => c.id === 2)
    const jDetail = (await callRoute(getCandidate, { params: { id: '2' } })).data
    check('created_at 相同 → id 更大的 event 胜出（advancing）', jList.work_state === 'advancing' && jList.work_state_note === 'ts-high', `id=${higherId}`)
    check('detail 与 list 完全同源', jDetail.work_state === jList.work_state && jDetail.work_state_note === jList.work_state_note)
    check('archived candidate 也能写 / 读 Work State（status 不参与）',
      jList.status === 'archived' && jList.work_state === 'advancing')
    const jHistory = jDetail.work_state_history
    check('history 最新 → 最旧且含两条同刻事件（id DESC tie-break）',
      jHistory.length === 2 && jHistory[0].note === 'ts-high' && jHistory[1].note === 'ts-low')

    console.log('\n===== legacy candidate_review endpoint：只写 events，绝不写 creator_decisions =====')
    const legacyBefore = counts()
    const legacyCases = [['contact', 'advancing'], ['observe', 'observing'], ['hold', 'paused']]
    for (const [human, expected] of legacyCases) {
      const res = await callRoute(postLegacyDecision, { params: { id: '1' }, body: { human_decision: human, decision_note: `legacy-${human}` } })
      check(`legacy ${human} → ${expected}（200 + deprecated 标记）`,
        res.status === 200 && res.data.work_state === expected && res.data.deprecated === true && res.data.work_state_event.state === expected)
      check(`legacy ${human} 的响应保留旧字段形状（human_decision / decision_note / decision_stage）`,
        res.data.human_decision === human && res.data.decision_note === `legacy-${human}` && res.data.decision_stage === 'candidate_review')
      check(`legacy ${human} 的 evidence 字段一律 null（Phase 3 后不再产生）`,
        res.data.snapshot_id === null && res.data.pricing_evidence === null && res.data.recent_evidence === null && res.data.target_cpm === null)
    }
    const legacyAfter = counts()
    check('legacy 路径只增加 events（+3）', legacyAfter.events === legacyBefore.events + 3, `${legacyBefore.events} → ${legacyAfter.events}`)
    check('legacy 路径新增 creator_decisions = 0', legacyAfter.decisions === legacyBefore.decisions, `${legacyBefore.decisions} → ${legacyAfter.decisions}`)
    check('legacy 路径新增 candidate_review = 0', legacyAfter.review === legacyBefore.review, `${legacyBefore.review} → ${legacyAfter.review}`)
    check('legacy 写入记录了 legacy_state（技术审计）',
      db.prepare("SELECT COUNT(*) n FROM candidate_work_state_events WHERE legacy_state IN ('contact','observe','hold')").get().n === 3 + 1)
    check('legacy 非法值仍 400', (await callRoute(postLegacyDecision, { params: { id: '1' }, body: { human_decision: 'repurchase' } })).status === 400)
    check('legacy 写后 creator_decisions 仍只有 Phase 1 的 3 行', db.prepare('SELECT COUNT(*) n FROM creator_decisions').get().n === 3)
    check('未发生任何 HTTP 请求', networkGuard.blocked.length === 0)
  } finally {
    networkGuard.restore()
  }
}

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
