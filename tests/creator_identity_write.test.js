#!/usr/bin/env node
// Creator Identity V1 Phase 4 —— 写入路径身份一致性契约测试（temp DB only）
//
// 运行方式：node tests/creator_identity_write.test.js
// 隔离：os.tmpdir() 下的临时库；先执行 Phase 1 migration（commit），再用真实 route handler 做写行为验证。
// 网络：拦截 http/https/net/tls/fetch。
//
// 覆盖（PHASE4 §3–§15）：
//   Record:      alias 0 → 新建 provisional Creator；1 → 复用；N → 事实照常成功但 creator_id = NULL
//   批量导入:    同名复用 / duplicate 不新建 Creator / update-only 不重归属
//   PUT:         nickname 改名不重归属
//   Rollback:    孤立自动 seed 清理；有其它事实 / candidate / 人工 alias → 保留
//   Candidate:   无 creator_id → 新建 provisional（同名也不 auto merge）；显式 → 复用；同 Creator 多 active → 409
//   Profile:     creators.* 为权威，candidate 为同事务 mirror（含 distilled invalidation）
//   Snapshot:    candidate 继承；historical strict 唯一归属；歧义不猜
//   Decision:    candidate post_quote 继承；legacy strict 唯一归属；歧义 409
//   Negotiation: live 从 decision 继承；historical 从 record 继承；anchor 为 NULL 时不阻塞
//   Schema guard: 事件表不得出现单列 UNIQUE(creator_id)；outcomes 不得被加列

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-identity-write-'))
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
    [http, 'request'],
    [http, 'get'],
    [https, 'request'],
    [https, 'get'],
    [net, 'connect'],
    [net, 'createConnection'],
    [net.Socket.prototype, 'connect'],
    [tls, 'connect']
  ]
  const originals = targets.map(([target, method]) => [target, method, target[method]])
  for (const [target, method] of targets) {
    target[method] = () => {
      blocked.push(method)
      throw new Error('creator identity write test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('creator identity write test forbids network requests')
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
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    }
  }
}

function routeHandler(mod, routePath, method) {
  const layer = mod.default.stack.find(
    (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
  )
  return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
}

function recordRow(nickname, extra = {}) {
  return {
    time_cycle: '2026-W36',
    nickname,
    total_cost: 1000,
    first_play: 100,
    second_week_play: 200,
    ...extra
  }
}

function snapshotBody(creator, extra = {}) {
  return {
    creator,
    plays: [{ raw_text: '1.5w', excluded: false, content_type: 'sponsored' }],
    observed_at: '2026-09-01',
    xingtu_price_raw: '3000',
    ...extra
  }
}

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const dbModule = await import(pathToFileURL(path.join(REPO_ROOT, 'backend/db.js')).href)
    const db = dbModule.default
    const migration = await import(
      pathToFileURL(path.join(REPO_ROOT, 'backend/migrations/001_creator_identity.js')).href
    )
    const recordsMod = await import(pathToFileURL(path.join(REPO_ROOT, 'backend/routes/records.js')).href)
    const candidatesMod = await import(
      pathToFileURL(path.join(REPO_ROOT, 'backend/routes/creatorCandidates.js')).href
    )
    const snapshotsMod = await import(
      pathToFileURL(path.join(REPO_ROOT, 'backend/routes/recentSnapshots.js')).href
    )
    const decisionsMod = await import(
      pathToFileURL(path.join(REPO_ROOT, 'backend/routes/creatorDecisions.js')).href
    )
    const negotiationMod = await import(
      pathToFileURL(path.join(REPO_ROOT, 'backend/routes/creatorNegotiationCases.js')).href
    )
    const importMod = await import(
      pathToFileURL(path.join(REPO_ROOT, 'backend/routes/importBatches.js')).href
    )

    // ---------- route handlers ----------
    const createRecord = routeHandler(recordsMod, '/', 'post')
    const batchRecords = routeHandler(recordsMod, '/batch', 'post')
    const updateRecord = routeHandler(recordsMod, '/:id', 'put')
    const createCandidate = routeHandler(candidatesMod, '/', 'post')
    const patchCandidate = routeHandler(candidatesMod, '/:id', 'patch')
    const candidateSnapshot = routeHandler(candidatesMod, '/:id/recent-snapshots', 'post')
    const candidatePostQuote = routeHandler(candidatesMod, '/:id/post-quote-decisions', 'post')
    const createHistoricalSnapshot = routeHandler(snapshotsMod, '/', 'post')
    const createLegacyDecision = routeHandler(decisionsMod, '/', 'post')
    const createLiveCase = routeHandler(negotiationMod, '/', 'post')
    const createHistoricalCase = routeHandler(negotiationMod, '/historical-backfill', 'post')
    const rollbackBatch = routeHandler(importMod, '/batches/:id/rollback', 'post')

    const call = async (handler, { body = {}, query = {}, params = {} } = {}) => {
      const res = response()
      await handler({ body, query, params, headers: {} }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    const q1 = (sql, ...params) => db.prepare(sql).get(...params)
    const qn = (sql, ...params) => db.prepare(sql).get(...params).n
    const creatorsCount = () => qn('SELECT COUNT(*) AS n FROM creators')
    const aliasesCount = () => qn('SELECT COUNT(*) AS n FROM creator_aliases')
    const candidateCount = () => qn('SELECT COUNT(*) AS n FROM creator_candidates')
    const recordById = (id) => q1('SELECT * FROM creator_records WHERE id = ?', id)

    // ---------- fixture：先建身份层（空库 → 0 seed） ----------
    const migrated = migration.runMigration(db, { mode: 'commit' })
    check(
      'Phase 1 migration（临时库，空库）成功且 creators = 0',
      migrated.ok === true && creatorsCount() === 0,
      `creators=${creatorsCount()}`
    )

    console.log('\n===== 1. 单条 record 归属（strict 0 / 1 / N） =====')
    const r1 = await call(createRecord, { body: recordRow('归属甲') })
    check('POST /api/records 200', r1.status === 200, r1.msg)
    const rec1 = recordById(r1.data.id)
    check('record.creator_link_source = alias_exact', rec1.creator_link_source === 'alias_exact')
    check('record.creator_id 指向新建 Creator', Number.isInteger(rec1.creator_id) && rec1.creator_id > 0)
    check('creators +1 / aliases +1', creatorsCount() === 1 && aliasesCount() === 1)
    check(
      '自动建的是 provisional Creator，alias source = import',
      q1('SELECT identity_status, canonical_name FROM creators WHERE id = ?', rec1.creator_id).identity_status ===
        'provisional' &&
        q1('SELECT source, alias_normalized FROM creator_aliases WHERE creator_id = ?', rec1.creator_id).source ===
          'import'
    )

    const r2 = await call(createRecord, { body: recordRow('归属甲') })
    const rec2 = recordById(r2.data.id)
    check('同 nickname 第二条复用同一 Creator（不新建）', rec2.creator_id === rec1.creator_id && creatorsCount() === 1)

    const aliceA = await call(createRecord, { body: recordRow('Alice') })
    const aliceB = await call(createRecord, { body: recordRow('  ALICE  ') })
    check(
      'strict normalization：大小写 / 首尾空白归一 → 同一 Creator',
      recordById(aliceA.data.id).creator_id === recordById(aliceB.data.id).creator_id
    )
    const aliceDot = await call(createRecord, { body: recordRow('Alice.') })
    check(
      '尾部句点差异 → 不自动归属同一个人（strict 不去标点）',
      recordById(aliceDot.data.id).creator_id !== recordById(aliceA.data.id).creator_id
    )

    // N match：两个 Creator 共用同一 strict alias
    const twin1 = db.prepare("INSERT INTO creators (canonical_name, identity_status) VALUES ('双胞胎', 'provisional')").run().lastInsertRowid
    const twin2 = db.prepare("INSERT INTO creators (canonical_name, identity_status) VALUES ('双胞胎', 'provisional')").run().lastInsertRowid
    db.prepare("INSERT INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, '双胞胎', '双胞胎', 'seed')").run(twin1)
    db.prepare("INSERT INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, '双胞胎', '双胞胎', 'seed')").run(twin2)
    const creatorsBeforeTwin = creatorsCount()
    const twinRecord = await call(createRecord, { body: recordRow('双胞胎') })
    const twinRow = recordById(twinRecord.data.id)
    check(
      'alias N match → record 仍成功写入，但 creator_id / link_source 均为 NULL（不猜、不拒绝）',
      twinRecord.status === 200 && twinRow.creator_id === null && twinRow.creator_link_source === null
    )
    check('alias N match 不会新建 Creator', creatorsCount() === creatorsBeforeTwin)

    console.log('\n===== 2. 批量导入（Excel import） =====')
    const creatorsBeforeBatch = creatorsCount()
    const batchRes = await call(batchRecords, {
      body: [recordRow('批量甲'), recordRow('批量乙'), recordRow('批量甲')]
    })
    check('POST /batch 200 且写入 3 条', batchRes.status === 200 && batchRes.data.count === 3)
    check('同名两行复用同一 Creator（本批只新增 2 个 Creator）', creatorsCount() === creatorsBeforeBatch + 2)
    const batchJiaId = batchRes.data.ids[0]
    const batchJiaCreator = recordById(batchJiaId).creator_id
    check(
      '同一批内同名行 creator_id 相同',
      recordById(batchRes.data.ids[2]).creator_id === batchJiaCreator && batchJiaCreator !== null
    )

    const updateOnly = await call(batchRecords, {
      body: { rows: [], updates: [{ record_id: batchJiaId, expected_before: 200, desired_after: 300 }] }
    })
    check(
      'update-only 导入：只更新 second_week_play，creator_id 完全不变（绝不重归属）',
      updateOnly.status === 200 &&
        updateOnly.data.updatedCount === 1 &&
        recordById(batchJiaId).second_week_play === 300 &&
        recordById(batchJiaId).creator_id === batchJiaCreator
    )
    const creatorsBeforeDup = creatorsCount()
    await call(batchRecords, { body: [recordRow('批量甲')] })
    check('重复导入已有 nickname 不新建 Creator', creatorsCount() === creatorsBeforeDup)

    console.log('\n===== 3. PUT 改名不重归属 =====')
    const renameRes = await call(createRecord, { body: recordRow('改名前') })
    const renameOwner = recordById(renameRes.data.id).creator_id
    const creatorsBeforeRename = creatorsCount()
    const putRes = await call(updateRecord, { params: { id: String(renameRes.data.id) }, body: { nickname: '改名后' } })
    check(
      'PUT nickname 改名后 creator_id 保持原值（nickname 只是 frozen 展示标签）',
      putRes.status === 200 &&
        recordById(renameRes.data.id).nickname === '改名后' &&
        recordById(renameRes.data.id).creator_id === renameOwner &&
        creatorsCount() === creatorsBeforeRename
    )

    console.log('\n===== 4. Import rollback 空壳清理 =====')
    const rollbackBatchWithRecord = async (nickname, fileName) => {
      const res = await call(batchRecords, {
        body: { rows: [recordRow(nickname)], batch: { fileName, totalCount: 1 } }
      })
      return { batchId: res.data.batchId, recordId: res.data.ids[0], creatorId: recordById(res.data.ids[0]).creator_id }
    }

    // A. 完全孤立 → 清理
    const caseA = await rollbackBatchWithRecord('回滚甲', 'a.xlsx')
    const rollbackA = await call(rollbackBatch, { params: { id: String(caseA.batchId) } })
    check(
      'A：孤立自动 seed → rollback 后 record 删除 + Creator / alias 一并清理',
      rollbackA.status === 200 &&
        rollbackA.data.deletedCount === 1 &&
        rollbackA.data.removedCreatorCount === 1 &&
        !q1('SELECT id FROM creators WHERE id = ?', caseA.creatorId) &&
        qn('SELECT COUNT(*) AS n FROM creator_aliases WHERE creator_id = ?', caseA.creatorId) === 0
    )

    // B. 还有其它 record → 保留
    const caseB = await rollbackBatchWithRecord('回滚乙', 'b.xlsx')
    await call(createRecord, { body: recordRow('回滚乙') })
    const rollbackB = await call(rollbackBatch, { params: { id: String(caseB.batchId) } })
    check(
      'B：Creator 还有其它 record → rollback 只删 batch 记录，Creator 保留',
      rollbackB.data.deletedCount === 1 &&
        rollbackB.data.removedCreatorCount === 0 &&
        Boolean(q1('SELECT id FROM creators WHERE id = ?', caseB.creatorId)) &&
        qn('SELECT COUNT(*) AS n FROM creator_records WHERE creator_id = ?', caseB.creatorId) === 1
    )

    // C. 有 candidate → 保留
    const caseC = await rollbackBatchWithRecord('回滚丙', 'c.xlsx')
    await call(createCandidate, { body: { name: '回滚丙', creator_id: caseC.creatorId } })
    const rollbackC = await call(rollbackBatch, { params: { id: String(caseC.batchId) } })
    check(
      'C：Creator 有 candidate workflow → rollback 不删 Creator',
      rollbackC.data.removedCreatorCount === 0 && Boolean(q1('SELECT id FROM creators WHERE id = ?', caseC.creatorId))
    )

    // D. 有人工 alias → 保留
    const caseD = await rollbackBatchWithRecord('回滚丁', 'd.xlsx')
    db.prepare("INSERT INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, '回滚丁人工别名', '回滚丁人工别名', 'manual')").run(caseD.creatorId)
    const rollbackD = await call(rollbackBatch, { params: { id: String(caseD.batchId) } })
    check(
      'D：Creator 带人工身份资产（manual alias）→ rollback 不删 Creator',
      rollbackD.data.removedCreatorCount === 0 && Boolean(q1('SELECT id FROM creators WHERE id = ?', caseD.creatorId))
    )

    console.log('\n===== 5. Candidate 创建 =====')
    const creatorsBeforeImplicit = creatorsCount()
    const implicit = await call(createCandidate, { body: { name: '拓展甲', creator_type: '科普类' } })
    const implicitRow = q1('SELECT * FROM creator_candidates WHERE id = ?', implicit.data.id)
    check(
      '无 creator_id → 新建 provisional Creator + alias(source=candidate) 并挂到 candidate',
      implicit.status === 200 &&
        Number.isInteger(implicitRow.creator_id) &&
        creatorsCount() === creatorsBeforeImplicit + 1 &&
        q1('SELECT source FROM creator_aliases WHERE creator_id = ?', implicitRow.creator_id).source === 'candidate'
    )
    check(
      '隐式创建的 Creator 是 provisional（绝不自动 confirmed）',
      q1('SELECT identity_status FROM creators WHERE id = ?', implicitRow.creator_id).identity_status === 'provisional'
    )

    // 同名历史 Creator 存在时，隐式 candidate 绝不 auto merge
    const historicalRecord = await call(createRecord, { body: recordRow('历史同名') })
    const historicalCreator = recordById(historicalRecord.data.id).creator_id
    const aliasesOfHistorical = qn('SELECT COUNT(*) AS n FROM creator_aliases WHERE creator_id = ?', historicalCreator)
    const creatorsBeforeSameName = creatorsCount()
    const sameName = await call(createCandidate, { body: { name: '历史同名' } })
    const sameNameRow = q1('SELECT * FROM creator_candidates WHERE id = ?', sameName.data.id)
    check(
      'candidate.name == historical alias 不构成身份确认 → 新建独立 Creator（不 auto merge）',
      sameNameRow.creator_id !== historicalCreator &&
        creatorsCount() === creatorsBeforeSameName + 1 &&
        qn('SELECT COUNT(*) AS n FROM creator_aliases WHERE creator_id = ?', historicalCreator) === aliasesOfHistorical
    )

    // 显式 creator_id → 复用
    const creatorsBeforeExplicit = creatorsCount()
    const explicit = await call(createCandidate, { body: { name: '任意展示名', creator_id: historicalCreator } })
    check(
      '显式 creator_id → 复用已有 Creator（不新建）',
      explicit.status === 200 &&
        q1('SELECT creator_id FROM creator_candidates WHERE id = ?', explicit.data.id).creator_id ===
          historicalCreator &&
        creatorsCount() === creatorsBeforeExplicit
    )
    const conflict = await call(createCandidate, { body: { name: '再来一个', creator_id: historicalCreator } })
    check('同 Creator 已有 active candidate → 409（DB partial unique 的友好前置校验）', conflict.status === 409, conflict.msg)
    await call(patchCandidate, { params: { id: String(explicit.data.id) }, body: { status: 'archived' } })
    const afterArchive = await call(createCandidate, { body: { name: '归档后新建', creator_id: historicalCreator } })
    check('archived 旧 candidate + 新 active → 允许（archived 不参与唯一约束）', afterArchive.status === 200)

    console.log('\n===== 6. Creator Profile 权威（candidate 仅为 mirror） =====')
    const profCandidateRow = q1('SELECT * FROM creator_candidates WHERE id = ?', implicit.data.id)
    const profCreatorId = profCandidateRow.creator_id
    const patch1 = await call(patchCandidate, {
      params: { id: String(implicit.data.id) },
      body: { description: '人工备注1' }
    })
    check(
      '编辑 description → creators.description 权威更新，candidate mirror 同值',
      patch1.status === 200 &&
        q1('SELECT description FROM creators WHERE id = ?', profCreatorId).description === '人工备注1' &&
        q1('SELECT description FROM creator_candidates WHERE id = ?', implicit.data.id).description === '人工备注1'
    )
    await call(patchCandidate, { params: { id: String(implicit.data.id) }, body: { distilled_description: '整理1' } })
    check(
      'AI 整理落库 → creators.distilled_description 权威写入 + mirror 一致',
      q1('SELECT distilled_description FROM creators WHERE id = ?', profCreatorId).distilled_description === '整理1' &&
        q1('SELECT distilled_description FROM creator_candidates WHERE id = ?', implicit.data.id).distilled_description === '整理1'
    )
    await call(patchCandidate, { params: { id: String(implicit.data.id) }, body: { description: '人工备注2' } })
    check(
      'description 改变且未提供新整理 → Creator 与 candidate 的 distilled 同时失效为 NULL',
      q1('SELECT description, distilled_description FROM creators WHERE id = ?', profCreatorId)
        .distilled_description === null &&
        q1('SELECT distilled_description FROM creator_candidates WHERE id = ?', implicit.data.id)
          .distilled_description === null
    )
    const nameChange = await call(patchCandidate, {
      params: { id: String(implicit.data.id) },
      body: { name: '显示名改了' }
    })
    check(
      'candidate.name 属于 workflow 展示，不覆盖 Creator 权威名（改名 ≠ 身份变更）',
      nameChange.status === 200 &&
        q1('SELECT canonical_name FROM creators WHERE id = ?', profCreatorId).canonical_name === '拓展甲' &&
        q1('SELECT name FROM creator_candidates WHERE id = ?', implicit.data.id).name === '显示名改了'
    )
    // 用一个还没有 active candidate 的 Creator 验证「显式创建时 profile 写入权威」
    const profileRecord = await call(createRecord, { body: recordRow('简介甲') })
    const profileCreator = recordById(profileRecord.data.id).creator_id
    const explicitProfile = await call(createCandidate, {
      body: { name: '带简介', creator_id: profileCreator, description: '作者简介X' }
    })
    check(
      '显式 creator_id 创建 workflow 不修改 Creator Profile（description 保持权威值）+ mirror 与权威一致',
      explicitProfile.status === 200 &&
        q1('SELECT description FROM creators WHERE id = ?', profileCreator).description === null &&
        q1('SELECT description FROM creator_candidates WHERE id = ?', explicitProfile.data.id).description === null
    )
    check(
      '被忽略的 profile 字段在响应中显式上报（不静默丢弃请求值）',
      Array.isArray(explicitProfile.body?.ignored_profile_fields) &&
        explicitProfile.body.ignored_profile_fields.includes('description')
    )

    console.log('\n===== 7. Recent Snapshot 归属 =====')
    const snapCandidateId = sameName.data.id
    const snapCandidateCreator = q1('SELECT creator_id FROM creator_candidates WHERE id = ?', snapCandidateId).creator_id
    const candidateSnap = await call(candidateSnapshot, {
      params: { id: String(snapCandidateId) },
      body: snapshotBody('ignored-by-server')
    })
    check(
      'candidate 快照继承 candidate.creator_id',
      candidateSnap.status === 200 &&
        Number.isInteger(candidateSnap.data.id) &&
        q1('SELECT creator_id FROM creator_recent_snapshots WHERE id = ?', candidateSnap.data.id).creator_id ===
          snapCandidateCreator
    )

    const histSnapRecord = await call(createRecord, { body: recordRow('快照甲') })
    const histSnapCreator = recordById(histSnapRecord.data.id).creator_id
    const histSnapRes = await call(createHistoricalSnapshot, { body: snapshotBody('快照甲') })
    check(
      'historical 快照：strict alias 唯一 → 自动归属',
      histSnapRes.status === 200 &&
        q1('SELECT creator_id FROM creator_recent_snapshots WHERE id = ?', histSnapRes.data.id).creator_id ===
          histSnapCreator
    )
    const snapTwin1 = db.prepare("INSERT INTO creators (canonical_name, identity_status) VALUES ('快照双', 'provisional')").run().lastInsertRowid
    const snapTwin2 = db.prepare("INSERT INTO creators (canonical_name, identity_status) VALUES ('快照双', 'provisional')").run().lastInsertRowid
    db.prepare("INSERT INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, '快照双', '快照双', 'seed')").run(snapTwin1)
    db.prepare("INSERT INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, '快照双', '快照双', 'seed')").run(snapTwin2)
    const ambiguousRecord = await call(createRecord, { body: recordRow('快照双') })
    check('歧义 nickname 的 record 仍成功（creator_id = NULL）', ambiguousRecord.status === 200)
    const ambiguousSnap = await call(createHistoricalSnapshot, { body: snapshotBody('快照双') })
    check(
      'historical 快照歧义 → 快照仍写入，creator_id = NULL（不猜）',
      ambiguousSnap.status === 200 &&
        q1('SELECT creator_id FROM creator_recent_snapshots WHERE id = ?', ambiguousSnap.data.id).creator_id === null
    )
    const explicitSnap = await call(createHistoricalSnapshot, {
      body: snapshotBody('快照甲', { creator_id: histSnapCreator })
    })
    check(
      'historical 快照显式 creator_id → 直接采用',
      q1('SELECT creator_id FROM creator_recent_snapshots WHERE id = ?', explicitSnap.data.id).creator_id ===
        histSnapCreator
    )

    console.log('\n===== 8. Decision 归属 =====')
    const postQuote = await call(candidatePostQuote, {
      params: { id: String(snapCandidateId) },
      body: { human_decision: 'proceed', current_quote_raw: '2400' }
    })
    const postQuoteRow = postQuote.status === 200 ? q1('SELECT * FROM creator_decisions WHERE id = ?', postQuote.data.id) : null
    check(
      'candidate post_quote decision 继承 candidate.creator_id',
      postQuote.status === 200 &&
        postQuoteRow.creator_id === snapCandidateCreator &&
        postQuoteRow.creator_id !== null &&
        postQuoteRow.candidate_id === snapCandidateId
    )
    check(
      'decision evidence / target_cpm / pricing_version 语义不变',
      postQuoteRow !== null &&
        postQuoteRow.target_cpm === 30 &&
        postQuoteRow.pricing_version === 'creator-playbook-postquote-v0.1' &&
        typeof postQuoteRow.pricing_evidence_json === 'string' &&
        postQuoteRow.pricing_evidence_json.length > 2
    )

    const legacyDecision = await call(createLegacyDecision, {
      body: { creator: '快照甲', decision_stage: 'contact', human_decision: 'contact_now' }
    })
    const legacyRow = legacyDecision.status === 200 ? q1('SELECT * FROM creator_decisions WHERE id = ?', legacyDecision.data.id) : null
    check(
      'legacy decision（Radar 入口）strict alias 唯一 → 自动归属；creator 文本冻结保留',
      legacyDecision.status === 200 && legacyRow.creator_id === histSnapCreator && legacyRow.creator === '快照甲'
    )
    const ambiguousDecision = await call(createLegacyDecision, {
      body: { creator: '快照双', decision_stage: 'contact', human_decision: 'contact_now' }
    })
    check('legacy decision 身份歧义（N match）→ 409，不猜', ambiguousDecision.status === 409, ambiguousDecision.msg)

    console.log('\n===== 9. Negotiation Case 归属 =====')
    // retrofit flow（谈价在系统外完成）：proceed 类 decision 必须人工填写谈前报价
    const liveCase = await call(createLiveCase, {
      body: {
        decision_id: postQuote.data.id,
        negotiated_price: 2000,
        negotiated_at: '2026-09-05',
        current_quote_snapshot: 2400
      }
    })
    check(
      'live case 从 decision_id → decision.creator_id 继承（不按 creator 文本匹配）',
      liveCase.status === 200 &&
        q1('SELECT creator_id, source_type, decision_id FROM creator_negotiation_cases WHERE id = ?', liveCase.data.id)
          .creator_id === snapCandidateCreator &&
        q1('SELECT source_type FROM creator_negotiation_cases WHERE id = ?', liveCase.data.id).source_type === 'live'
    )
    const liveDup = await call(createLiveCase, {
      body: {
        decision_id: postQuote.data.id,
        negotiated_price: 2100,
        negotiated_at: '2026-09-05',
        current_quote_snapshot: 2400
      }
    })
    check('live case 去重逻辑不变（同一 decision 再次记录 → 409）', liveDup.status === 409)

    const histCase = await call(createHistoricalCase, {
      body: { record_id: histSnapRecord.data.id, negotiated_price: 1800, negotiated_at: '2026-09-06' }
    })
    check(
      'historical_backfill 从 record_id → record.creator_id 继承',
      histCase.status === 200 &&
        q1('SELECT creator_id, source_type, record_id FROM creator_negotiation_cases WHERE id = ?', histCase.data.id)
          .creator_id === histSnapCreator &&
        q1('SELECT source_type FROM creator_negotiation_cases WHERE id = ?', histCase.data.id).source_type ===
          'historical_backfill'
    )
    const ambiguousCase = await call(createHistoricalCase, {
      body: { record_id: ambiguousRecord.data.id, negotiated_price: 1700, negotiated_at: '2026-09-07' }
    })
    check(
      'anchor 的 creator_id 为 NULL → case 仍写入，creator_id = NULL（绝不阻塞真实谈价事件）',
      ambiguousCase.status === 200 &&
        q1('SELECT creator_id FROM creator_negotiation_cases WHERE id = ?', ambiguousCase.data.id).creator_id === null
    )

    console.log('\n===== 10. Schema guard（事件身份不被 creator_id 替代） =====')
    const eventTables = [
      'creator_records',
      'creator_decisions',
      'creator_negotiation_cases',
      'creator_recent_snapshots'
    ]
    const uniqueCreatorIndexes = db
      .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'")
      .all()
      .filter(
        (row) =>
          row.sql &&
          /UNIQUE\s*\(\s*creator_id\s*\)/i.test(row.sql) &&
          eventTables.includes(row.tbl_name)
      )
    check('事件表不存在单列 UNIQUE(creator_id)', uniqueCreatorIndexes.length === 0, JSON.stringify(uniqueCreatorIndexes.map((r) => r.name)))
    check(
      'creator_decision_outcomes 未被加列（outcome 身份不变）',
      !db
        .prepare('PRAGMA table_info(creator_decision_outcomes)')
        .all()
        .some((column) => column.name === 'creator_id')
    )
    check(
      'candidate_work_state_events 不含 creator_id / pricing / evidence',
      !db
        .prepare('PRAGMA table_info(candidate_work_state_events)')
        .all()
        .some((column) => /creator_id|pricing|evidence|target_cpm/.test(column.name))
    )
    check('全部写入测试未发生网络请求', networkGuard.blocked.length === 0)
  } finally {
    networkGuard.restore()
  }
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    failCount += 1
    failures.push(`执行异常：${error?.message || error}`)
  })
  .finally(() => {
    console.log(`\n===== 结果：成功 ${passCount} / 失败 ${failCount} =====`)
    if (failures.length) {
      console.log('失败项：')
      for (const item of failures) console.log(`  - ${item}`)
    }
    process.exitCode = failCount === 0 ? 0 : 1
  })
