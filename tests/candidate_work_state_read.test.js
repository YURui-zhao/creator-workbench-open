#!/usr/bin/env node
// Creator Identity V1 Phase 2 —— Candidate 服务端 Work State 只读契约测试
//
// 运行方式：node tests/candidate_work_state_read.test.js
// 隔离：os.tmpdir() 下的临时库（由 backend/db.js 建出 Phase 1 之前的 schema），结束时删除。
// 网络：拦截 http/https/net/tls/fetch（纯确定性）。
//
// 覆盖：
//   · Phase A（新表不存在）→ legacy candidate_review fallback：contact/observe/hold 映射
//   · Phase B（执行 Phase 1 migration 后）→ 新表为唯一权威；legacy 行被彻底忽略
//   · 无事件默认 advancing；最新事件决定状态；created_at 相同用 id tie-break
//   · post_quote 永不参与；candidate.status 不参与；archived 不影响 Work State
//   · history append-only + 最新→最旧契约
//   · candidate list SQL 次数与候选数量无关（无 N+1）
//   · 原 candidate 字段全部保留（additive only）

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-work-state-read-'))
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
      throw new Error('candidate work state read test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('candidate work state read test forbids network requests')
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
    const creatorsModule = await import(
      pathToFileURL(path.join(REPO_ROOT, 'backend/routes/creators.js')).href
    )
    const migration = await import(
      pathToFileURL(path.join(REPO_ROOT, 'backend/migrations/001_creator_identity.js')).href
    )

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
    const listCandidates = findHandler(candidatesModule.default, '/', 'get')
    const getCandidate = findHandler(candidatesModule.default, '/:id', 'get')
    const listCreators = findHandler(creatorsModule.default, '/', 'get')

    // ---------- fixture（Phase 1 之前形状：无 creators / 无 work_state 表）----------
    const insertCandidate = db.prepare(
      "INSERT INTO creator_candidates (id, name, creator_type, status, created_at, updated_at) VALUES (?, ?, '科普类', ?, '2026-09-01 00:00:00', '2026-09-01 00:00:00')"
    )
    insertCandidate.run(1, '无事件甲', 'active')
    insertCandidate.run(2, '观察乙', 'active')
    insertCandidate.run(3, '暂缓丙', 'active')
    insertCandidate.run(4, '推进丁', 'active')
    insertCandidate.run(5, '同刻戊', 'active')
    insertCandidate.run(6, '报价己', 'active')
    insertCandidate.run(7, '归档庚', 'archived')

    const insertDecision = db.prepare(
      `INSERT INTO creator_decisions (id, creator, candidate_id, decision_stage, human_decision, decision_note,
                                      historical_evidence_json, target_cpm, pricing_version,
                                      system_context_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', 30, 'v', 'v', ?)`
    )
    // legacy candidate_review（Phase A 权威；Phase B 将变成非权威）
    insertDecision.run(1, '观察乙', 2, 'candidate_review', 'observe', 'legacy-observe', '2026-09-02 00:00:00')
    insertDecision.run(2, '暂缓丙', 3, 'candidate_review', 'hold', 'legacy-hold', '2026-09-03 00:00:00')
    insertDecision.run(3, '推进丁', 4, 'candidate_review', 'contact', 'legacy-contact', '2026-09-04 00:00:00')
    // created_at 完全相同 → 必须用 id DESC 决定最新
    insertDecision.run(4, '同刻戊', 5, 'candidate_review', 'hold', 'same-ts-hold', '2026-09-05 00:00:00')
    insertDecision.run(5, '同刻戊', 5, 'candidate_review', 'contact', 'same-ts-contact', '2026-09-05 00:00:00')
    // post_quote：永不参与 Work State
    insertDecision.run(6, '报价己', 6, 'post_quote', 'proceed', 'post-quote-only', '2026-09-06 00:00:00')
    // archived 也有状态
    insertDecision.run(7, '归档庚', 7, 'candidate_review', 'hold', 'archived-hold', '2026-09-07 00:00:00')

    const stateOf = (data, id) => data.candidates.find((item) => item.id === id)

    console.log('===== 1. Phase A：新表不存在 → legacy fallback =====')
    check('新表不存在（fixture 为 Phase 1 之前形状）', !db.prepare("SELECT 1 ok FROM sqlite_master WHERE name='candidate_work_state_events'").get())
    const listA = await callRoute(listCandidates, { query: {} })
    check('legacy fallback 生效（work_state_source=legacy）', stateOf(listA.data, 2).work_state_source === 'legacy')
    check('无事件 → 默认 advancing（source=default）', stateOf(listA.data, 1).work_state === 'advancing' && stateOf(listA.data, 1).work_state_source === 'default')
    check('legacy observe → observing', stateOf(listA.data, 2).work_state === 'observing')
    check('legacy hold → paused', stateOf(listA.data, 3).work_state === 'paused')
    check('legacy contact → advancing', stateOf(listA.data, 4).work_state === 'advancing')
    check(
      'created_at 相同 → id DESC tie-break（取 id=5 的 contact → advancing）',
      stateOf(listA.data, 5).work_state === 'advancing' && stateOf(listA.data, 5).work_state_note === 'same-ts-contact'
    )
    check('post_quote 不参与 → 默认 advancing', stateOf(listA.data, 6).work_state === 'advancing' && stateOf(listA.data, 6).work_state_note === null)
    check('archived 不影响 Work State（仍为 paused）', stateOf(listA.data, 7).work_state === 'paused' && stateOf(listA.data, 7).status === 'archived')
    check('默认值不写库（无事件 candidate 仍 0 行 decisions）', db.prepare('SELECT COUNT(*) n FROM creator_decisions WHERE candidate_id = 1').get().n === 0)

    console.log('\n===== 2. 原 candidate 字段全部保留（additive only） =====')
    const legacyKeys = ['id', 'name', 'creator_type', 'profile_url', 'xingtu_url', 'xingtu_id', 'description', 'distilled_description', 'status', 'created_at', 'updated_at']
    check('原 11 个字段一个不少', legacyKeys.every((key) => key in stateOf(listA.data, 1)))
    check('candidate.name 仍是 legacy display（未被 canonical_name 取代）', stateOf(listA.data, 2).name === '观察乙')
    check('新增字段为 additive', ['creator_id', 'creator', 'work_state', 'work_state_note', 'work_state_updated_at', 'work_state_source'].every((key) => key in stateOf(listA.data, 1)))
    check('Phase A 下 creator_id 为 null（列不存在 → 未伪造）', stateOf(listA.data, 1).creator_id === null)

    console.log('\n===== 3. Phase A：Creators 读接口在缺表时安全降级 =====')
    const creatorsA = await callRoute(listCreators, { query: {} })
    check('creators list 返回 schema_ready=false 且为空（不 500）',
      creatorsA.status === 200 && creatorsA.data.schema_ready === false && creatorsA.data.total === 0)

    console.log('\n===== 4. Phase B：执行 Phase 1 migration（临时库）→ 新表成为唯一权威 =====')
    const migrated = migration.runMigration(db, { mode: 'commit' })
    check('migration commit 成功（reconciliation ok）', migrated.ok === true, JSON.stringify({ diffs: migrated.diffs, violations: migrated.violations }))
    // fixture 的 legacy candidate_review = 6 条（decision 1/2/3/4/5/7；decision 6 是 post_quote）
    check('work_state 事件已回填（6 条 legacy candidate_review → 6 events）', db.prepare('SELECT COUNT(*) n FROM candidate_work_state_events').get().n === 6)

    // 关键：写入一条与 legacy 冲突的 legacy candidate_review，它必须被彻底忽略
    insertDecision.run(8, '推进丁', 4, 'candidate_review', 'hold', 'legacy-trap', '2026-10-01 00:00:00')
    insertDecision.run(9, '报价己', 6, 'post_quote', 'pause', 'post-quote-trap', '2026-10-02 00:00:00')

    const listB = await callRoute(listCandidates, { query: {} })
    check('新表存在 → 所有状态来源为 events', listB.data.candidates.every((item) => ['events', 'default'].includes(item.work_state_source)))
    check(
      'legacy 中的新 candidate_review 被忽略（推进丁 仍按新表 = advancing）',
      stateOf(listB.data, 4).work_state === 'advancing' && stateOf(listB.data, 4).work_state_note === 'legacy-contact'
    )
    check('新表存在时 work_state_source 不再是 legacy', listB.data.candidates.every((item) => item.work_state_source !== 'legacy'))
    check('post_quote 仍不参与（报价己 = 默认 advancing）', stateOf(listB.data, 6).work_state === 'advancing' && stateOf(listB.data, 6).work_state_source === 'default')
    check('Phase A / Phase B 的最终状态分布一致', JSON.stringify(listA.data.candidates.map((c) => [c.id, c.work_state]).sort()) === JSON.stringify(listB.data.candidates.map((c) => [c.id, c.work_state]).sort()))

    console.log('\n===== 5. Candidate detail：work_state_history 契约（最新 → 最旧） =====')
    const detail5 = await callRoute(getCandidate, { params: { id: '5' } })
    check('detail 返回 work_state_history 数组', Array.isArray(detail5.data.work_state_history))
    check('history 长度 = 2（append-only 未去重）', detail5.data.work_state_history.length === 2)
    check(
      'history 顺序最新 → 最旧（同 created_at 用 id DESC）',
      detail5.data.work_state_history[0].legacy_state === 'contact' && detail5.data.work_state_history[1].legacy_state === 'hold'
    )
    check('history 项含 id/state/note/created_at/legacy_state', ['id', 'state', 'note', 'created_at', 'legacy_state'].every((key) => key in detail5.data.work_state_history[0]))
    check('detail 的 work_state 与 history[0] 一致', detail5.data.work_state === detail5.data.work_state_history[0].state)
    const detail1 = await callRoute(getCandidate, { params: { id: '1' } })
    check('无事件 candidate detail：默认 advancing + 空 history', detail1.data.work_state === 'advancing' && detail1.data.work_state_history.length === 0 && detail1.data.work_state_source === 'default')
    check('detail 404', (await callRoute(getCandidate, { params: { id: '99999' } })).status === 404)

    console.log('\n===== 6. N+1 审计：SQL 次数与候选数量无关 =====')
    // 说明：better-sqlite3 的 Database.prototype.prepare 是 getter（惰性绑定），
    // 直接赋值会被静默忽略 → 必须用 defineProperty 覆盖，结束后 delete 回到 prototype。
    const countSql = async (fn) => {
      const counter = { n: 0 }
      const original = db.prepare.bind(db)
      Object.defineProperty(db, 'prepare', {
        configurable: true,
        writable: true,
        value: (sql) => {
          counter.n += 1
          return original(sql)
        }
      })
      try {
        return { ...(await fn()), count: counter.n }
      } finally {
        delete db.prepare
      }
    }
    const five = await countSql(async () => {
      const res = await callRoute(listCandidates, { query: {} })
      return { candidates: res.data.candidates.length }
    })
    const bigCount = 500
    const insertMany = db.prepare(
      "INSERT INTO creator_candidates (id, name, creator_type, status, created_at, updated_at) VALUES (?, ?, '科普类', 'active', '2026-09-09 00:00:00', '2026-09-09 00:00:00')"
    )
    for (let i = 0; i < bigCount; i += 1) insertMany.run(1000 + i, `压测达人${i}`)
    const big = await countSql(async () => {
      const res = await callRoute(listCandidates, { query: {} })
      return { candidates: res.data.candidates.length }
    })
    check(`候选 ${five.candidates} 个时 SQL=${five.count}，${big.candidates} 个时 SQL=${big.count}（固定次数，无 N+1）`, five.count === big.count, `${five.count} vs ${big.count}`)
    check('list 不发起任何 HTTP 请求（前端不再需要逐 candidate 拉 decisions）', networkGuard.blocked.length === 0)
    console.log(`      → query audit: N=${five.candidates}: ${five.count} SQL | N=${big.candidates}: ${big.count} SQL（O(1)）`)

    console.log('\n===== 7. status 过滤 + 未知 status 仍拒绝 =====')
    const archivedOnly = await callRoute(listCandidates, { query: { status: 'archived' } })
    check('status=archived 过滤仍工作且带 Work State', archivedOnly.data.candidates.length === 1 && archivedOnly.data.candidates[0].work_state === 'paused')
    check('非法 status → 400（契约未变）', (await callRoute(listCandidates, { query: { status: 'merged' } })).status === 400)
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
