#!/usr/bin/env node
// Creator Identity V1 Phase 2 —— Creator 只读接口契约测试
//
// 运行方式：node tests/creator_read_side.test.js
// 隔离：os.tmpdir() 下的临时库；先建 fixture（records + candidates + outcome 桥），
//       再执行 Phase 1 migration（commit）生成 creators / creator_aliases，然后只读校验接口。
// 网络：拦截 http/https/net/tls/fetch。
//
// 覆盖：list 基础资料 + alias_count（不含 aliases 数组）/ keyword 严格 substring（无 fuzzy/拼音）/
//       merged 墓碑默认排除 / canonical_name 可重名 / detail（aliases + attribution + latest_known_work_state）/
//       404 / 400 / schema_ready / 非 merged 计数 / 只读（不写库）

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-read-side-'))
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
      throw new Error('creator read side test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('creator read side test forbids network requests')
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
    const callRoute = async (handler, { query = {}, params = {} } = {}) => {
      const res = response()
      await handler({ body: {}, query, params, headers: {} }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }
    const listCreators = findHandler(creatorsModule.default, '/', 'get')
    const getCreator = findHandler(creatorsModule.default, '/:id', 'get')

    // ---------- fixture：3 个 nickname seed（含一个多轮）+ 2 个 candidate（1 个 outcome 关联）----------
    const insertRecord = db.prepare(
      `INSERT INTO creator_records (id, time_cycle, nickname, homepage, creator_type, content_link,
                                    total_cost, publish_date, video_link, first_play, second_week_play)
       VALUES (?, ?, ?, 'https://v.douyin.com/x/', ?, 'c', ?, ?, ?, ?, ?)`
    )
    insertRecord.run(1, '2026-W32', '多轮甲', '科普类', 1000, '2026-08-10', 'https://v.douyin.com/r1/', 100, 200)
    insertRecord.run(2, '2026-W33', '多轮甲', '科普类', 2000, '2026-08-17', 'https://v.douyin.com/r2/', 150, 250)
    insertRecord.run(3, '2026-W32', '单轮乙', '历史类', 3000, '2026-08-12', 'https://v.douyin.com/r3/', 300, 400)
    insertRecord.run(4, '2026-W36', '同人丙', '个人成长类', 4000, '2026-09-01', 'https://v.douyin.com/r4/', 500, 600)

    const insertCandidate = db.prepare(
      "INSERT INTO creator_candidates (id, name, creator_type, status, created_at, updated_at) VALUES (?, ?, '个人成长类', ?, '2026-09-02 00:00:00', '2026-09-02 00:00:00')"
    )
    insertCandidate.run(1, '同人丙', 'active')
    insertCandidate.run(2, '新人丁', 'active')

    const insertDecision = db.prepare(
      `INSERT INTO creator_decisions (id, creator, candidate_id, decision_stage, human_decision, decision_note,
                                      historical_evidence_json, target_cpm, pricing_version,
                                      system_context_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', 30, 'v', 'v', ?)`
    )
    insertDecision.run(1, '同人丙', 1, 'post_quote', 'proceed', null, '2026-09-03 00:00:00')
    insertDecision.run(2, '同人丙', 1, 'candidate_review', 'observe', '先看下一条数据', '2026-09-04 00:00:00')
    insertDecision.run(3, '新人丁', 2, 'candidate_review', 'contact', '本周推进', '2026-09-05 00:00:00')
    // outcome 桥：decision#1 ↔ 同人丙 的真实投放记录（record#4），这是唯一允许的强身份证据
    db.prepare('INSERT INTO creator_decision_outcomes (id, decision_id, record_id, linked_at, link_evidence_json) VALUES (1, 1, 4, \'2026-09-06 00:00:00\', \'{"version":"outcome-link-v0.1"}\')').run()

    console.log('===== 1. Phase 1 migration（临时库）→ creators / aliases 就绪 =====')
    const migrated = migration.runMigration(db, { mode: 'commit' })
    check('migration commit ok', migrated.ok === true, JSON.stringify({ diffs: migrated.diffs, violations: migrated.violations }))
    check('creators = 3 seed + 1 candidate-only = 4', migrated.actual.creators === 4, String(migrated.actual.creators))
    check('aliases = 4', migrated.actual.aliases === 4, String(migrated.actual.aliases))
    check('outcome 强证据：candidate#1 归入 historical creator（不新建重复 Creator）',
      db.prepare('SELECT creator_id FROM creator_candidates WHERE id = 1').get().creator_id ===
        db.prepare('SELECT creator_id FROM creator_records WHERE id = 4').get().creator_id)

    console.log('\n===== 2. GET /api/creators（list）=====')
    const list = await callRoute(listCreators, {})
    check('HTTP 200 且 schema_ready=true', list.status === 200 && list.data.schema_ready === true)
    check('total = 4（默认排除 merged，本 fixture 无 merged）', list.data.total === 4, String(list.data.total))
    const keys = ['id', 'canonical_name', 'creator_type', 'identity_status', 'description', 'distilled_description', 'profile_url', 'xingtu_id', 'xingtu_url', 'created_at', 'updated_at', 'alias_count']
    check('每项包含约定基础资料字段', list.data.creators.every((item) => keys.every((key) => key in item)))
    check('list 刻意不返回 aliases 数组（只给 alias_count）', list.data.creators.every((item) => !('aliases' in item)))
    check('alias_count = 1（每个 creator 初始 1 条 alias）', list.data.creators.every((item) => item.alias_count === 1))
    check('identity_status 全部 provisional（seed 不自动确认）', list.data.creators.every((item) => item.identity_status === 'provisional'))
    check('默认排序稳定（canonical_name NOCASE, id）', JSON.stringify(list.data.creators.map((c) => c.canonical_name)) === JSON.stringify([...list.data.creators.map((c) => c.canonical_name)].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0)))

    console.log('\n===== 3. keyword 严格 substring（绝不 fuzzy / 拼音）=====')
    const kwName = await callRoute(listCreators, { query: { keyword: '多轮' } })
    check('canonical_name 子串命中', kwName.data.total === 1 && kwName.data.creators[0].canonical_name === '多轮甲')
    const kwCand = await callRoute(listCreators, { query: { keyword: '新人' } })
    check('候选带入的 creator 也可被 name 命中', kwCand.data.total === 1 && kwCand.data.creators[0].canonical_name === '新人丁')
    check('无拼音匹配（xiaowang 不命中中文名）', (await callRoute(listCreators, { query: { keyword: 'duolun' } })).data.total === 0)
    check('严格子串：带空格的关键词不命中', (await callRoute(listCreators, { query: { keyword: '多轮 甲' } })).data.total === 0)
    check('LIKE 通配符被转义（% 不匹配所有人）', (await callRoute(listCreators, { query: { keyword: '%' } })).data.total === 0)
    check('关键词为空 → 全量', (await callRoute(listCreators, { query: { keyword: '   ' } })).data.total === 4)
    // alias 子串（新增一条人工 alias 后应能命中）
    const creatorId = list.data.creators.find((c) => c.canonical_name === '单轮乙').id
    db.prepare('INSERT INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?)').run(creatorId, '别名别名', '别名别名', 'manual')
    const kwAlias = await callRoute(listCreators, { query: { keyword: '别名' } })
    check('alias 子串命中（走 creator_aliases）', kwAlias.data.total === 1 && kwAlias.data.creators[0].id === creatorId)
    check('alias_count 随新增 alias 更新', kwAlias.data.creators[0].alias_count === 2)

    console.log('\n===== 4. merged 墓碑默认排除 + canonical_name 可重名 =====')
    const targetId = list.data.creators.find((c) => c.canonical_name === '新人丁').id
    db.prepare("UPDATE creators SET identity_status='merged', merged_into_creator_id=? WHERE id=?").run(creatorId, targetId)
    const afterMerge = await callRoute(listCreators, {})
    check('默认 list 排除 merged 墓碑', afterMerge.data.total === 3 && !afterMerge.data.creators.some((c) => c.id === targetId))
    const withMerged = await callRoute(listCreators, { query: { include_merged: '1' } })
    check('include_merged=1 时包含墓碑', withMerged.data.total === 4 && withMerged.data.creators.some((c) => c.id === targetId))
    check('墓碑仍带 merged_into_creator_id（便于 follow）', withMerged.data.creators.find((c) => c.id === targetId).merged_into_creator_id === creatorId)
    // 同名两个 creator（产品允许）
    db.prepare("INSERT INTO creators (id, canonical_name, creator_type, identity_status) VALUES (900, '同名重名', '科普类', 'provisional')").run()
    db.prepare("INSERT INTO creators (id, canonical_name, creator_type, identity_status) VALUES (901, '同名重名', '历史类', 'provisional')").run()
    const dup = await callRoute(listCreators, { query: { keyword: '同名重名' } })
    check('canonical_name 允许重名（两个都返回）', dup.data.total === 2 && new Set(dup.data.creators.map((c) => c.id)).size === 2)

    console.log('\n===== 5. GET /api/creators/:id（detail）=====')
    const multiId = list.data.creators.find((c) => c.canonical_name === '多轮甲').id
    const detailMulti = await callRoute(getCreator, { params: { id: String(multiId) } })
    check('detail 200 + aliases 数组（仅 detail 返回）', detailMulti.status === 200 && Array.isArray(detailMulti.data.creator.aliases) && detailMulti.data.creator.aliases.length === 1)
    check('alias 项字段完整', ['id', 'alias', 'alias_normalized', 'source', 'created_at'].every((key) => key in detailMulti.data.creator.aliases[0]))
    check('多轮达人 records_count = 2（同一 nickname 2 轮）', detailMulti.data.attribution.records_count === 2)
    check('无 candidate 的 creator：candidate_workflows_count=0 / active_candidate_id=null / latest_known_work_state=null',
      detailMulti.data.attribution.candidate_workflows_count === 0 &&
        detailMulti.data.attribution.active_candidate_id === null &&
        detailMulti.data.latest_known_work_state === null)

    const sameId = db.prepare("SELECT id FROM creators WHERE canonical_name = '同人丙'").get().id
    const detailLinked = await callRoute(getCreator, { params: { id: String(sameId) } })
    check('关联 candidate 的 creator：candidate_workflows_count=1 且 active_candidate_id=1',
      detailLinked.data.attribution.candidate_workflows_count === 1 && detailLinked.data.attribution.active_candidate_id === 1)
    check('records_count = 1（outcome 桥指向的 historical record）', detailLinked.data.attribution.records_count === 1)
    check('latest_known_work_state 由 active candidate 派生（observing / source=events）',
      detailLinked.data.latest_known_work_state?.state === 'observing' &&
        detailLinked.data.latest_known_work_state?.source === 'events' &&
        detailLinked.data.latest_known_work_state?.candidate_id === 1)
    check('latest_known_work_state 不落在 Creator 表上（creators 无 state 列）',
      !db.prepare('PRAGMA table_info(creators)').all().some((c) => /state/.test(c.name)))

    console.log('\n===== 6. 错误契约 + 只读安全 =====')
    check('detail 404（不存在）', (await callRoute(getCreator, { params: { id: '99999' } })).status === 404)
    check('detail 400（非法 id）', (await callRoute(getCreator, { params: { id: 'abc' } })).status === 400)
    check('keyword 超长 → 400', (await callRoute(listCreators, { query: { keyword: 'x'.repeat(101) } })).status === 400)
    const before = db.prepare('SELECT COUNT(*) n FROM creators').get().n
    await callRoute(listCreators, { query: { keyword: '多轮' } })
    await callRoute(getCreator, { params: { id: String(multiId) } })
    check('读接口零写入（creators 行数不变）', db.prepare('SELECT COUNT(*) n FROM creators').get().n === before)
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
