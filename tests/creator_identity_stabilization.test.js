#!/usr/bin/env node
// Creator Identity V1 — Phase 4 Stabilization Gate（temp DB only）
//
// 运行方式：node tests/creator_identity_stabilization.test.js
// 目的：验证 Phase 4 报告中的不变量真的由代码保证，而不是「看起来包了 transaction」。
//
// 覆盖：
//   §2/§13 Profile Authority：所有写路径后 creator 权威 == candidate mirror（6 字段逐字段）
//   §3       Failure Atomicity：真实故障注入（SQLite trigger RAISE）证明两端一起回滚
//   §4       Description Invalidation：真实变化才失效；未变化不得清空已整理结果
//   §5       Partial Update：未提交字段必须保持原值；null 才是主动清空
//   §8       Explicit Creator ID：A/B/C/D/E 五种情形
//   §10      Ambiguity Contract：稳定机器可读 reason（不靠中文文案）
//   §11      Strict Resolution：样板达人17 vs 样板达人17.（NFKC/trim/折叠/case fold；绝不去标点）
//   §12/§14  Event Identity Guards + Hidden Writers（源码级扫描）

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')
const BACKEND_DIR = path.join(REPO_ROOT, 'backend')
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-identity-stabilization-'))
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
      throw new Error('creator identity stabilization test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('creator identity stabilization test forbids network requests')
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

const PROFILE_FIELDS = [
  'description',
  'distilled_description',
  'creator_type',
  'profile_url',
  'xingtu_id',
  'xingtu_url'
]

/** 源码扫描：某个目录下所有 .js 的文本 */
function sourceFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const db = (await import(pathToFileURL(path.join(BACKEND_DIR, 'db.js')).href)).default
    const migration = await import(
      pathToFileURL(path.join(BACKEND_DIR, 'migrations/001_creator_identity.js')).href
    )
    const identity = await import(
      pathToFileURL(path.join(BACKEND_DIR, 'utils/creatorIdentity.js')).href
    )
    const recordsMod = await import(pathToFileURL(path.join(BACKEND_DIR, 'routes/records.js')).href)
    const candidatesMod = await import(
      pathToFileURL(path.join(BACKEND_DIR, 'routes/creatorCandidates.js')).href
    )
    const decisionsMod = await import(
      pathToFileURL(path.join(BACKEND_DIR, 'routes/creatorDecisions.js')).href
    )

    const createRecord = routeHandler(recordsMod, '/', 'post')
    const createCandidate = routeHandler(candidatesMod, '/', 'post')
    const patchCandidate = routeHandler(candidatesMod, '/:id', 'patch')
    const createLegacyDecision = routeHandler(decisionsMod, '/', 'post')

    const call = async (handler, { body = {}, query = {}, params = {} } = {}) => {
      const res = response()
      try {
        await handler({ body, query, params, headers: {} }, res)
      } catch (error) {
        // 未捕获异常 = 已中止，没有任何响应；调用方按「未写入」断言
        return { status: 0, threw: true, error: String(error?.message || error), body: null, data: null }
      }
      return { status: res.statusCode, threw: false, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    const q1 = (sql, ...p) => db.prepare(sql).get(...p)
    const creatorOf = (id) => q1('SELECT * FROM creators WHERE id = ?', id)
    const candidateOf = (id) => q1('SELECT * FROM creator_candidates WHERE id = ?', id)
    const decisionsCount = () => q1('SELECT COUNT(*) AS n FROM creator_decisions').n

    /** candidate mirror 与 Creator 权威逐字段比较 */
    const mirrorDiff = (candidateId) => {
      const cand = candidateOf(candidateId)
      const creator = creatorOf(cand.creator_id)
      const diffs = []
      for (const field of PROFILE_FIELDS) {
        const a = cand[field] === undefined ? null : cand[field]
        const b = creator ? (creator[field] === undefined ? null : creator[field]) : '<missing creator>'
        if (a !== b) diffs.push(`${field}: candidate=${JSON.stringify(a)} creator=${JSON.stringify(b)}`)
      }
      return diffs
    }

    // ---------- fixture：身份层（空库） ----------
    const migrated = migration.runMigration(db, { mode: 'commit' })
    check('Phase 1 migration（临时库）成功', migrated.ok === true && q1('SELECT COUNT(*) AS n FROM creators').n === 0)

    console.log('\n===== §2/§13 Profile Authority：创建设置 profile =====')
    const cand = await call(createCandidate, {
      body: {
        name: '权威甲',
        creator_type: '科普类',
        description: '人工备注A',
        distilled_description: '整理A',
        profile_url: 'https://example.com/a',
        xingtu_id: 'XT-1',
        xingtu_url: 'https://xingtu.example.com/a'
      }
    })
    const candId = cand.data.id
    const candCreatorId = candidateOf(candId).creator_id
    check('创建 candidate 时自动建立 Creator 归属锚', cand.status === 200 && Number.isInteger(candCreatorId))
    check(
      '创建后 6 项 profile 权威 == mirror（无 drift）',
      mirrorDiff(candId).length === 0,
      JSON.stringify(mirrorDiff(candId))
    )
    check(
      'Creator 权威真的拿到了 profile（不是只写了 mirror）',
      creatorOf(candCreatorId).description === '人工备注A' &&
        creatorOf(candCreatorId).distilled_description === '整理A' &&
        creatorOf(candCreatorId).creator_type === '科普类' &&
        creatorOf(candCreatorId).profile_url === 'https://example.com/a' &&
        creatorOf(candCreatorId).xingtu_id === 'XT-1' &&
        creatorOf(candCreatorId).xingtu_url === 'https://xingtu.example.com/a'
    )

    console.log('\n===== §5 Partial Update：未提交字段不得被清空 =====')
    const beforePartial = creatorOf(candCreatorId)
    const onlyType = await call(patchCandidate, {
      params: { id: String(candId) },
      body: { creator_type: '历史类' }
    })
    const afterType = creatorOf(candCreatorId)
    check(
      '只改 creator_type → 其余 5 个字段原值不变（undefined = 不修改）',
      onlyType.status === 200 &&
        afterType.creator_type === '历史类' &&
        afterType.description === beforePartial.description &&
        afterType.distilled_description === beforePartial.distilled_description &&
        afterType.profile_url === beforePartial.profile_url &&
        afterType.xingtu_id === beforePartial.xingtu_id &&
        afterType.xingtu_url === beforePartial.xingtu_url
    )
    check('只改 creator_type 后 mirror 仍一致', mirrorDiff(candId).length === 0, JSON.stringify(mirrorDiff(candId)))

    await call(patchCandidate, { params: { id: String(candId) }, body: { profile_url: 'https://example.com/b' } })
    check(
      '只改 profile_url → 其它字段不变且 mirror 一致',
      creatorOf(candCreatorId).profile_url === 'https://example.com/b' &&
        creatorOf(candCreatorId).xingtu_id === 'XT-1' &&
        candidateOf(candId).profile_url === 'https://example.com/b' &&
        mirrorDiff(candId).length === 0
    )
    await call(patchCandidate, { params: { id: String(candId) }, body: { xingtu_id: 'XT-2' } })
    check(
      '只改 xingtu_id → 其它字段不变且 mirror 一致',
      creatorOf(candCreatorId).xingtu_id === 'XT-2' &&
        creatorOf(candCreatorId).profile_url === 'https://example.com/b' &&
        mirrorDiff(candId).length === 0
    )
    const nullClear = await call(patchCandidate, {
      params: { id: String(candId) },
      body: { xingtu_url: null }
    })
    check(
      'null = 主动清空（只清这一个字段）',
      nullClear.status === 200 &&
        creatorOf(candCreatorId).xingtu_url === null &&
        creatorOf(candCreatorId).xingtu_id === 'XT-2' &&
        candidateOf(candId).xingtu_url === null &&
        mirrorDiff(candId).length === 0
    )

    console.log('\n===== §4 Description Invalidation =====')
    // 恢复一个稳定的 distilled，验证「未变化不清空」
    await call(patchCandidate, {
      params: { id: String(candId) },
      body: { description: '备注B', distilled_description: '整理B' }
    })
    const sameDesc = await call(patchCandidate, {
      params: { id: String(candId) },
      body: { description: '备注B' }
    })
    check(
      'description 未真实变化 → 不得清空已整理结果（两边都保留）',
      sameDesc.status === 200 &&
        creatorOf(candCreatorId).distilled_description === '整理B' &&
        candidateOf(candId).distilled_description === '整理B' &&
        mirrorDiff(candId).length === 0
    )
    const changedDesc = await call(patchCandidate, {
      params: { id: String(candId) },
      body: { description: '备注C' }
    })
    check(
      'description 真实变化且未提供新整理 → 两边 distilled 同时失效',
      changedDesc.status === 200 &&
        creatorOf(candCreatorId).distilled_description === null &&
        candidateOf(candId).distilled_description === null &&
        mirrorDiff(candId).length === 0
    )
    await call(patchCandidate, {
      params: { id: String(candId) },
      body: { description: '备注D', distilled_description: '整理D' }
    })
    check(
      'description 变化 + 同时提供新整理 → 两边都写新整理（不误清空）',
      creatorOf(candCreatorId).distilled_description === '整理D' &&
        candidateOf(candId).distilled_description === '整理D' &&
        mirrorDiff(candId).length === 0
    )

    console.log('\n===== §13 candidate.name 不覆盖 creators.canonical_name =====')
    const canonicalBefore = creatorOf(candCreatorId).canonical_name
    const rename = await call(patchCandidate, {
      params: { id: String(candId) },
      body: { name: '展示名改了' }
    })
    check(
      'candidate.name 是 workflow 展示，不覆盖 canonical_name',
      rename.status === 200 &&
        candidateOf(candId).name === '展示名改了' &&
        creatorOf(candCreatorId).canonical_name === canonicalBefore
    )

    console.log('\n===== §1 Explicit Workflow Creation：不得反向修改已有 Creator Profile =====')
    // fixture：一个拥有完整权威 profile 的 Creator（用 implicit 创建初始化，再归档以便继续开新 workflow）
    const seed = await call(createCandidate, {
      body: {
        name: '权威达人',
        description: 'authoritative',
        creator_type: '历史',
        profile_url: 'creator-url',
        xingtu_id: 'creator-id',
        xingtu_url: 'https://xingtu.example.com/creator',
        distilled_description: 'creator-distilled'
      }
    })
    const AUTH = candidateOf(seed.data.id).creator_id
    await call(patchCandidate, { params: { id: String(seed.data.id) }, body: { status: 'archived' } })
    const authBefore = creatorOf(AUTH)
    const authSnapshot = () => {
      const c = creatorOf(AUTH)
      return PROFILE_FIELDS.map((f) => `${f}=${JSON.stringify(c[f] ?? null)}`).join('|')
    }
    const authAtStart = authSnapshot()
    check(
      'fixture：Creator 权威 profile 已完整（6 字段非空）',
      PROFILE_FIELDS.every((f) => (authBefore[f] ?? null) !== null),
      authAtStart
    )

    // Case A：不传 profile → Creator 完全不变，mirror == Creator
    const caseAThen = await call(createCandidate, {
      body: { name: 'A 新 workflow', creator_id: AUTH }
    })
    check(
      'Case A：explicit creator_id + 不传 profile → Creator 完全不变，mirror == Creator',
      caseAThen.status === 200 &&
        authSnapshot() === authAtStart &&
        mirrorDiff(caseAThen.data.id).length === 0 &&
        candidateOf(caseAThen.data.id).description === 'authoritative'
    )
    check('Case A：无被忽略字段时不额外返回 ignored_profile_fields', caseAThen.body?.ignored_profile_fields === undefined)
    await call(patchCandidate, { params: { id: String(caseAThen.data.id) }, body: { status: 'archived' } })

    // Case B：description = "" → 不得清空 Creator 权威
    const caseBThen = await call(createCandidate, {
      body: { name: 'B 新 workflow', creator_id: AUTH, description: '' }
    })
    check(
      'Case B：explicit + description="" → Creator 不得被清空（与 PATCH 的清空语义区分：这是创建 workflow）',
      caseBThen.status === 200 &&
        creatorOf(AUTH).description === 'authoritative' &&
        authSnapshot() === authAtStart &&
        mirrorDiff(caseBThen.data.id).length === 0
    )
    await call(patchCandidate, { params: { id: String(caseBThen.data.id) }, body: { status: 'archived' } })

    // Case C：stale candidate value → 不得覆盖 Creator
    const caseCThen = await call(createCandidate, {
      body: { name: 'C 新 workflow', creator_id: AUTH, description: 'stale candidate value' }
    })
    check(
      'Case C：explicit + stale description → Creator 权威不被覆盖，mirror 仍等于权威',
      caseCThen.status === 200 &&
        creatorOf(AUTH).description === 'authoritative' &&
        candidateOf(caseCThen.data.id).description === 'authoritative' &&
        mirrorDiff(caseCThen.data.id).length === 0
    )
    check(
      'Case C：被忽略字段上报（description）',
      (caseCThen.body?.ignored_profile_fields || []).includes('description')
    )
    await call(patchCandidate, { params: { id: String(caseCThen.data.id) }, body: { status: 'archived' } })

    // Case D：四个 profile 字段全部给出不同值 → Creator 一律不被改写
    const caseDThen = await call(createCandidate, {
      body: {
        name: 'D 新 workflow',
        creator_id: AUTH,
        creator_type: '完全不同的类型',
        profile_url: 'different-url',
        xingtu_id: 'different-id',
        xingtu_url: 'https://xingtu.example.com/different'
      }
    })
    check(
      'Case D：explicit + creator_type/profile_url/xingtu_id/xingtu_url 全不同 → Creator 一个字段都没被改写',
      caseDThen.status === 200 &&
        authSnapshot() === authAtStart &&
        mirrorDiff(caseDThen.data.id).length === 0 &&
        candidateOf(caseDThen.data.id).creator_type === '历史' &&
        candidateOf(caseDThen.data.id).xingtu_id === 'creator-id'
    )
    check(
      'Case D：四个冲突字段全部上报为 ignored',
      ['creator_type', 'profile_url', 'xingtu_id', 'xingtu_url'].every((f) =>
        (caseDThen.body?.ignored_profile_fields || []).includes(f)
      )
    )
    await call(patchCandidate, { params: { id: String(caseDThen.data.id) }, body: { status: 'archived' } })

    // Case E：candidate 创建失败 → Creator 完全不变
    db.exec(
      `CREATE TRIGGER inject_explicit_cand_fail BEFORE INSERT ON creator_candidates
       WHEN NEW.name = '__INJECT_CAND_FAIL__'
       BEGIN SELECT RAISE(ABORT, 'injected explicit candidate failure'); END`
    )
    const caseEThen = await call(createCandidate, {
      body: { name: '__INJECT_CAND_FAIL__', creator_id: AUTH, description: 'should-not-land' }
    })
    check(
      'Case E：创建 workflow 失败 → Creator 完全不变（含 profile 与 updated_at 语义）',
      caseEThen.status !== 200 &&
        authSnapshot() === authAtStart &&
        q1("SELECT COUNT(*) AS n FROM creator_candidates WHERE name = '__INJECT_CAND_FAIL__'").n === 0
    )
    db.exec('DROP TRIGGER inject_explicit_cand_fail')

    // Case F：implicit（无 creator_id）仍以 request profile 初始化**新生** Creator
    const caseFThen = await call(createCandidate, {
      body: { name: 'F 全新人物', description: 'F-desc', creator_type: 'F-type' }
    })
    const FID = candidateOf(caseFThen.data.id).creator_id
    check(
      'Case F：implicit 创建 → request profile 初始化新 Creator + mirror 一致（新人物语义保留）',
      caseFThen.status === 200 &&
        creatorOf(FID).description === 'F-desc' &&
        creatorOf(FID).creator_type === 'F-type' &&
        candidateOf(caseFThen.data.id).description === 'F-desc' &&
        mirrorDiff(caseFThen.data.id).length === 0
    )
    check('Case F：implicit 路径不产生 ignored_profile_fields', caseFThen.body?.ignored_profile_fields === undefined)

    // Case G：契约边界（merged / missing / active duplicate）→ 保持上一轮契约且不改 Creator
    const mergedForG = db
      .prepare("INSERT INTO creators (canonical_name, identity_status, merged_into_creator_id) VALUES ('G墓碑','merged',?)")
      .run(AUTH).lastInsertRowid
    const gMerged = await call(createCandidate, { body: { name: 'G1', creator_id: mergedForG, description: 'x' } })
    const gMissing = await call(createCandidate, { body: { name: 'G2', creator_id: 888888, description: 'x' } })
    const gActive = await call(createCandidate, { body: { name: 'G3 占位 workflow', creator_id: AUTH } })
    const gDup = await call(createCandidate, { body: { name: 'G4 重复 workflow', creator_id: AUTH, description: 'x' } })
    check(
      'Case G：merged → 400 reason=merged；missing → 400 reason=not_found；active duplicate → 409',
      gMerged.status === 400 &&
        gMerged.data?.creator_identity?.reason === 'merged' &&
        gMissing.status === 400 &&
        gMissing.data?.creator_identity?.reason === 'not_found' &&
        gActive.status === 200 &&
        gDup.status === 409
    )
    check(
      'Case G：三种边界都不修改 Creator（仍是开始时那 6 个权威值）',
      authSnapshot() === authAtStart && creatorOf(AUTH).description === 'authoritative'
    )
    await call(patchCandidate, { params: { id: String(gActive.data.id) }, body: { status: 'archived' } })

    console.log('\n===== §2b Authority Guard：归属锚不可写时必须拒绝（不产生单边写入） =====')
    // merged 墓碑：FK 拦不住，必须由应用层拒绝（绝不把 profile 写到墓碑上）
    const tombstoneTarget = q1("SELECT id FROM creators WHERE canonical_name = '权威甲'").id
    const tombstone = db
      .prepare("INSERT INTO creators (canonical_name, identity_status, merged_into_creator_id) VALUES ('墓碑甲','merged',?)")
      .run(tombstoneTarget).lastInsertRowid
    const tombCand = db
      .prepare("INSERT INTO creator_candidates (name, status, creator_id) VALUES ('墓碑候选','active',?)")
      .run(tombstone).lastInsertRowid
    db.prepare("INSERT INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, '墓碑候选', '墓碑候选', 'seed')").run(tombstone)
    const tombPatch = await call(patchCandidate, {
      params: { id: String(tombCand) },
      body: { description: '写入墓碑应被拒绝' }
    })
    check(
      '归属锚指向 merged 墓碑 → 409 + 稳定 reason=merged，且一笔都没写',
      tombPatch.status === 409 &&
        tombPatch.data?.creator_identity?.reason === 'merged' &&
        creatorOf(tombstone).description === null &&
        candidateOf(tombCand).description === null
    )

    // 悬空归属锚：FK 正常情况下不可构造，这里临时关闭 FK 造出病态行，验证守卫仍拦截
    db.pragma('foreign_keys = OFF')
    const danglingCand = db
      .prepare("INSERT INTO creator_candidates (name, status, creator_id) VALUES ('悬空候选','active',999999)")
      .run().lastInsertRowid
    db.pragma('foreign_keys = ON')
    const danglingPatch = await call(patchCandidate, {
      params: { id: String(danglingCand) },
      body: { description: '写入悬空归属应被拒绝' }
    })
    check(
      '归属锚指向不存在的 Creator → 409 + 稳定 reason=not_found，candidate 也未写入',
      danglingPatch.status === 409 &&
        danglingPatch.data?.creator_identity?.reason === 'not_found' &&
        candidateOf(danglingCand).description === null
    )
    check(
      '被拒绝时数据库确实处于 foreign_keys=ON（守卫不是靠关闭 FK 生效）',
      db.pragma('foreign_keys', { simple: true }) === 1
    )

    console.log('\n===== §3 Failure Atomicity（真实故障注入，不是「看起来有事务」） =====')
    // Case A：Creator 权威写入失败（candidate mirror 已先写）→ 整体回滚
    const beforeA = {
      creatorDesc: creatorOf(candCreatorId).description,
      candDesc: candidateOf(candId).description
    }
    db.exec(
      `CREATE TRIGGER inject_creator_update_fail BEFORE UPDATE ON creators
       WHEN NEW.description = '__INJECT_CREATOR_FAIL__'
       BEGIN SELECT RAISE(ABORT, 'injected creator update failure'); END`
    )
    const caseA = await call(patchCandidate, {
      params: { id: String(candId) },
      body: { description: '__INJECT_CREATOR_FAIL__' }
    })
    check(
      'Case A：Creator 写入失败 → candidate mirror 也回滚（两张表都是 before state）',
      caseA.status !== 200 &&
        creatorOf(candCreatorId).description === beforeA.creatorDesc &&
        candidateOf(candId).description === beforeA.candDesc,
      `status=${caseA.status} threw=${caseA.threw}`
    )

    // 对照实验：同样的两步写入「不包 transaction」时会出现单边成功。
    // 证明 (1) 注入的 trigger 真的生效，(2) 上面的回滚是事务带来的，而不是碰巧没写进去。
    let controlThrew = false
    try {
      db.prepare('UPDATE creator_candidates SET description = ? WHERE id = ?').run('__CONTROL_ONE_SIDED__', candId)
      db.prepare('UPDATE creators SET description = ? WHERE id = ?').run('__INJECT_CREATOR_FAIL__', candCreatorId)
    } catch {
      controlThrew = true
    }
    check(
      '对照实验：无事务时确实出现单边写入（注入有效，事务是真正的保护）',
      controlThrew === true &&
        candidateOf(candId).description === '__CONTROL_ONE_SIDED__' &&
        creatorOf(candCreatorId).description === beforeA.creatorDesc
    )
    // 复原对照组造成的单边状态（仅临时库）
    db.prepare('UPDATE creator_candidates SET description = ? WHERE id = ?').run(beforeA.candDesc, candId)
    db.exec('DROP TRIGGER inject_creator_update_fail')
    check(
      '对照组复原 + 触发失败后整体仍是 0 drift',
      candidateOf(candId).description === beforeA.candDesc && mirrorDiff(candId).length === 0
    )

    // Case B：implicit 创建时 candidate 写入失败 → 同一事务里刚建的 provisional Creator 必须一起回滚
    // （显式复用路径已不写 Creator，因此用 implicit 路径验证「Creator + candidate 原子」）
    const creatorsBeforeB = q1('SELECT COUNT(*) AS n FROM creators').n
    db.exec(
      `CREATE TRIGGER inject_candidate_insert_fail BEFORE INSERT ON creator_candidates
       WHEN NEW.description = '__INJECT_MIRROR_FAIL__'
       BEGIN SELECT RAISE(ABORT, 'injected candidate insert failure'); END`
    )
    const caseB = await call(createCandidate, {
      body: { name: '注入候选', description: '__INJECT_MIRROR_FAIL__' }
    })
    check(
      'Case B：candidate 写入失败 → 同事务新建的 provisional Creator 一起回滚（不留孤儿 Creator）',
      caseB.status !== 200 &&
        q1('SELECT COUNT(*) AS n FROM creators').n === creatorsBeforeB &&
        q1("SELECT COUNT(*) AS n FROM creators WHERE canonical_name = '注入候选'").n === 0 &&
        q1("SELECT COUNT(*) AS n FROM creator_aliases WHERE alias_normalized = '注入候选'").n === 0,
      `status=${caseB.status} threw=${caseB.threw}`
    )
    db.exec('DROP TRIGGER inject_candidate_insert_fail')

    // Case C：AI 整理结果保存中途失败 → 两边不出现单边 distilled
    const beforeC = {
      creatorDD: creatorOf(candCreatorId).distilled_description,
      candDD: candidateOf(candId).distilled_description
    }
    db.exec(
      `CREATE TRIGGER inject_distill_fail BEFORE UPDATE ON creators
       WHEN NEW.distilled_description = '__INJECT_DD_FAIL__'
       BEGIN SELECT RAISE(ABORT, 'injected distilled failure'); END`
    )
    const caseC = await call(patchCandidate, {
      params: { id: String(candId) },
      body: { distilled_description: '__INJECT_DD_FAIL__' }
    })
    check(
      'Case C：AI 整理保存失败 → Creator / candidate 都不出现单边 distilled_description',
      caseC.status !== 200 &&
        creatorOf(candCreatorId).distilled_description === beforeC.creatorDD &&
        candidateOf(candId).distilled_description === beforeC.candDD &&
        mirrorDiff(candId).length === 0
    )
    db.exec('DROP TRIGGER inject_distill_fail')
    check(
      '注入失败后仍是 0 drift（事务没有留下半写状态）',
      mirrorDiff(candId).length === 0,
      JSON.stringify(mirrorDiff(candId))
    )

    console.log('\n===== §8 Legacy Decision Identity Contract =====')
    // fixture：两个同名 Creator「小王」+ 一个「李四」+ 一个「张三」
    const twinA = db.prepare("INSERT INTO creators (canonical_name, identity_status) VALUES ('小王','provisional')").run().lastInsertRowid
    const twinB = db.prepare("INSERT INTO creators (canonical_name, identity_status) VALUES ('小王','provisional')").run().lastInsertRowid
    for (const id of [twinA, twinB]) {
      db.prepare("INSERT INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, '小王', '小王', 'seed')").run(id)
    }
    const liSiRecord = await call(createRecord, { body: recordRow('李四') })
    const liSiCreator = q1('SELECT creator_id FROM creator_records WHERE id = ?', liSiRecord.data.id).creator_id
    await call(createRecord, { body: recordRow('张三') })
    const zhangSanCreator = q1("SELECT id FROM creators WHERE canonical_name = '张三'").id
    // 「小王」也必须先有真实投放记录才可能进入 legacy decision（该入口先校验记录存在 + 历史证据）
    await call(createRecord, { body: recordRow('小王') })

    const beforeA2 = decisionsCount()
    const ambiguousNoId = await call(createLegacyDecision, {
      body: { creator: '小王', decision_stage: 'contact', human_decision: 'contact_now' }
    })
    check(
      'A：同名歧义 + 未传 creator_id → 409，且 decision 不落库',
      ambiguousNoId.status === 409 && decisionsCount() === beforeA2,
      `status=${ambiguousNoId.status}`
    )
    check(
      'A：绝不 take first match（409 而非静默选一个）',
      ambiguousNoId.data?.creator_identity?.reason === 'ambiguous'
    )

    const withId = await call(createLegacyDecision, {
      body: { creator: '小王', creator_id: twinB, decision_stage: 'contact', human_decision: 'contact_now' }
    })
    const withIdRow = withId.status === 200 ? q1('SELECT * FROM creator_decisions WHERE id = ?', withId.data.id) : null
    check(
      'B：显式 creator_id → 成功且归属 #B（creator text 仍是 frozen snapshot）',
      withId.status === 200 && withIdRow.creator_id === twinB && withIdRow.creator === '小王'
    )
    check('B：不再因为 creator text 同名歧义而失败', withId.status === 200)

    const notFound = await call(createLegacyDecision, {
      body: { creator: '李四', creator_id: 999999, decision_stage: 'contact', human_decision: 'contact_now' }
    })
    const beforeC2 = decisionsCount()
    check(
      'C：creator_id 指向不存在 Creator → 4xx 且不写库',
      notFound.status >= 400 && notFound.status < 500 && decisionsCount() === beforeC2,
      `status=${notFound.status}`
    )
    check(
      'C：稳定 reason = not_found',
      notFound.data?.creator_identity?.reason === 'not_found'
    )

    const mergedCreator = db
      .prepare("INSERT INTO creators (canonical_name, identity_status, merged_into_creator_id) VALUES ('合并墓碑','merged',?)")
      .run(liSiCreator).lastInsertRowid
    const merged = await call(createLegacyDecision, {
      body: { creator: '李四', creator_id: mergedCreator, decision_stage: 'contact', human_decision: 'contact_now' }
    })
    check(
      'D：creator_id 指向 merged 墓碑 → 拒绝且不写库（不偷偷 rematch）',
      merged.status >= 400 &&
        merged.status < 500 &&
        decisionsCount() === beforeC2 &&
        merged.data?.creator_identity?.reason === 'merged'
    )

    const mismatch = await call(createLegacyDecision, {
      body: { creator: '李四', creator_id: zhangSanCreator, decision_stage: 'contact', human_decision: 'contact_now' }
    })
    const mismatchRow =
      mismatch.status === 200 ? q1('SELECT * FROM creator_decisions WHERE id = ?', mismatch.data.id) : null
    check(
      'E：creator_id 与 creator text 不一致 → creator_id 是 ownership authority，text 保持 frozen（不 rematch / 不 overwrite）',
      mismatch.status === 200 &&
        mismatchRow.creator_id === zhangSanCreator &&
        mismatchRow.creator === '李四' &&
        !mismatch.data?.creator_identity
    )

    console.log('\n===== §9 Zero-Match Policy（KEEP_NULL） =====')
    // 历史遗留数据：记录存在但没有任何 Creator alias（Phase 1 之前的行 / 人工写入）
    db.prepare(
      "INSERT INTO creator_records (time_cycle, nickname, total_cost, first_play, second_week_play) VALUES ('2026-W36','零匹配达人',1000,100,200)"
    ).run()
    const creatorsBeforeZero = q1('SELECT COUNT(*) AS n FROM creators').n
    const zeroMatch = await call(createLegacyDecision, {
      body: { creator: '零匹配达人', decision_stage: 'contact', human_decision: 'contact_now' }
    })
    const zeroRow = zeroMatch.status === 200 ? q1('SELECT * FROM creator_decisions WHERE id = ?', zeroMatch.data.id) : null
    check(
      '0 match → decision 正常落库，creator_id = NULL（不临时造人、不 fuzzy 归属）',
      zeroMatch.status === 200 && zeroRow.creator_id === null && zeroRow.creator === '零匹配达人'
    )
    check(
      '0 match 不新增 Creator（事件身份由 decision_id 锚定，不阻塞业务事实）',
      q1('SELECT COUNT(*) AS n FROM creators').n === creatorsBeforeZero
    )
    check('0 match 不是错误（不返回 4xx）', zeroMatch.status === 200 && !zeroMatch.data?.creator_identity)

    console.log('\n===== §10 Ambiguity Contract（稳定机器可读） =====')
    check(
      '409 body 保持既有 { code(numbers), data, msg } 形状',
      ambiguousNoId.body?.code === 409 &&
        typeof ambiguousNoId.body?.msg === 'string' &&
        ambiguousNoId.body.msg.length > 0
    )
    const matches = ambiguousNoId.data?.creator_identity?.matches
    check(
      'data.creator_identity 给出全部候选 Creator（供显式选择）',
      Array.isArray(matches) &&
        matches.length === 2 &&
        matches.map((m) => m.id).sort((a, b) => a - b).join(',') === [twinA, twinB].sort((a, b) => a - b).join(',') &&
        matches.every((m) => typeof m.canonical_name === 'string' && typeof m.identity_status === 'string')
    )
    check(
      'top-level code 仍是数字（未用字符串 code 破坏既有契约）',
      typeof ambiguousNoId.body.code === 'number'
    )

    console.log('\n===== §11 Strict Resolution（样板达人17 vs 样板达人17.） =====')
    const shenA = db.prepare("INSERT INTO creators (canonical_name, identity_status) VALUES ('样板达人17','provisional')").run().lastInsertRowid
    const shenB = db.prepare("INSERT INTO creators (canonical_name, identity_status) VALUES ('样板达人17.','provisional')").run().lastInsertRowid
    db.prepare("INSERT INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, '样板达人17', '样板达人17', 'seed')").run(shenA)
    db.prepare("INSERT INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, '样板达人17.', '样板达人17.', 'seed')").run(shenB)
    const resolve = (name) => identity.resolveCreatorByStrictAlias(db, name)
    check('严格解析：样板达人17 → 只有 A（不串到 B）', resolve('样板达人17').creatorIds.join(',') === String(shenA))
    check('严格解析：样板达人17. → 只有 B（不串到 A）', resolve('样板达人17.').creatorIds.join(',') === String(shenB))
    check('严格解析：首尾空白被 trim（ 样板达人17  → A）', resolve(' 样板达人17  ').creatorIds.join(',') === String(shenA))
    check('严格解析：NFKC + case fold（ALICE / alice 同一 alias）', (() => {
      const x = db.prepare("INSERT INTO creators (canonical_name, identity_status) VALUES ('ALICE','provisional')").run().lastInsertRowid
      db.prepare("INSERT INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, 'ALICE', 'alice', 'seed')").run(x)
      return identity.normalizeAliasStrict('ＡＬＩＣＥ') === 'alice' && resolve('alice').creatorIds.join(',') === String(x)
    })())
    check('严格解析：连续空白折叠为单空格（你 好 == 你  好）', identity.normalizeAliasStrict('你   好') === '你 好')
    check('严格解析：绝不因去标点而串号（样板达人17。 不匹配 A/B）', resolve('样板达人17。').count === 0)
    check('严格解析：绝不 fuzzy（样板达人17 不匹配 样板达人17.，也不做相似度）', resolve('样板达人17').count === 1 && resolve('样板达人17.').count === 1)

    const shenRecordA = await call(createRecord, { body: recordRow('样板达人17') })
    const shenRecordB = await call(createRecord, { body: recordRow('样板达人17.') })
    check(
      'record 写入路径沿用同一严格解析（A→A，B→B）',
      q1('SELECT creator_id FROM creator_records WHERE id = ?', shenRecordA.data.id).creator_id === shenA &&
        q1('SELECT creator_id FROM creator_records WHERE id = ?', shenRecordB.data.id).creator_id === shenB
    )

    console.log('\n===== §12 Event Identity Guards =====')
    const eventTables = ['creator_records', 'creator_decisions', 'creator_negotiation_cases', 'creator_recent_snapshots']
    const badIndexes = db
      .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'")
      .all()
      .filter((row) => row.sql && /UNIQUE\s*\(\s*creator_id\s*\)/i.test(row.sql) && eventTables.includes(row.tbl_name))
    check('事件表没有单列 UNIQUE(creator_id)', badIndexes.length === 0, JSON.stringify(badIndexes.map((r) => r.name)))
    check(
      'creator_decision_outcomes 未被加 creator_id 列（outcome 身份不变）',
      !db.prepare('PRAGMA table_info(creator_decision_outcomes)').all().some((c) => c.name === 'creator_id')
    )
    check(
      'candidate_work_state_events 不含 creator_id',
      !db.prepare('PRAGMA table_info(candidate_work_state_events)').all().some((c) => c.name === 'creator_id')
    )

    console.log('\n===== §14 Hidden Writers（源码级扫描） =====')
    const backendSources = sourceFiles(BACKEND_DIR).filter((f) => !f.includes(path.join('backend', 'migrations')))
    const read = (f) => fs.readFileSync(f, 'utf8')
    const rel = (f) => path.relative(REPO_ROOT, f)
    // 源码守卫必须只看「代码」，不看注释：否则一句说明文字就能让守卫误报 / 漏报
    const stripComments = (src) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w])\/\/[^\n]*/g, '$1')

    const creatorsUpdateWriters = backendSources.filter((f) => /UPDATE\s+creators\s+SET/i.test(read(f))).map(rel)
    check(
      'UPDATE creators SET 只出现在 creatorCandidates.js（唯一权威写入口）',
      creatorsUpdateWriters.length === 1 && creatorsUpdateWriters[0].endsWith('routes/creatorCandidates.js'),
      JSON.stringify(creatorsUpdateWriters)
    )
    // 源码级守卫（§6）：Creator 权威写入只允许存在于 PATCH 路径。
    // 若未来有人在 candidate 创建路径重新引入 Creator 写入，这里会立刻变红。
    const candidateRaw = read(path.join(BACKEND_DIR, 'routes/creatorCandidates.js'))
    const candidateSource = stripComments(candidateRaw)
    const creatorUpdateStatements = candidateSource.match(/UPDATE\s+creators\s+SET/g) || []
    check(
      '源码级守卫：creatorCandidates.js 中 UPDATE creators SET 恰好 1 处（PATCH 权威路径）',
      creatorUpdateStatements.length === 1,
      `count=${creatorUpdateStatements.length}`
    )
    // 定位用「原始源码」（区间工具在注释行上），再对切片去注释
    const createStart = candidateRaw.indexOf("router.post('/',")
    const createEnd = candidateRaw.indexOf('GET /api/creator-candidates?status=')
    const createHandlerSource = createStart >= 0 && createEnd > createStart
      ? stripComments(candidateRaw.slice(createStart, createEnd))
      : ''
    // 切片必须真的包含 create handler（否则空切片会让下面的断言“假通过”）
    check(
      '源码级守卫：已正确定位 candidate 创建 handler 源码区间',
      createHandlerSource.includes('explicitProvided') &&
        createHandlerSource.includes('createProvisionalCreator(') &&
        createHandlerSource.includes('INSERT INTO creator_candidates')
    )
    check(
      '源码级守卫：candidate 创建 handler 内不出现任何 Creator 写入语句（UPDATE / 裸 INSERT）',
      !/UPDATE\s+creators\s+SET/i.test(createHandlerSource) &&
        !/INSERT\s+INTO\s+creators/i.test(createHandlerSource)
    )
    const candidatesUpdateWriters = backendSources
      .filter((f) => /UPDATE\s+creator_candidates\s+SET/i.test(read(f)))
      .map(rel)
    check(
      'UPDATE creator_candidates SET 只出现在 creatorCandidates.js',
      candidatesUpdateWriters.length === 1 && candidatesUpdateWriters[0].endsWith('routes/creatorCandidates.js'),
      JSON.stringify(candidatesUpdateWriters)
    )
    const decisionInserters = backendSources.filter((f) => /INSERT INTO creator_decisions/i.test(read(f))).map(rel)
    check(
      'INSERT INTO creator_decisions 只有 2 个受控入口（candidate post_quote / legacy Radar）',
      decisionInserters.length === 2 &&
        decisionInserters.every((f) => /creatorCandidates\.js$|creatorDecisions\.js$/.test(f)),
      JSON.stringify(decisionInserters)
    )
    const aiSource = read(path.join(BACKEND_DIR, 'routes/ai.js'))
    check(
      'ai.js 不写库（AI 整理只返回建议，落库必须走权威 PATCH 路径）',
      !/INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/.test(aiSource)
    )
    const profileWriters = backendSources.filter((f) =>
      /(distilled_description|profile_url|xingtu_id|xingtu_url|canonical_name|identity_status)\s*=\s*\?/.test(read(f))
    ).map(rel)
    check(
      'profile 字段赋值语句只出现在权威写入模块（creatorCandidates / creatorIdentity）',
      profileWriters.every((f) => /creatorCandidates\.js$|creatorIdentity\.js$/.test(f)),
      JSON.stringify(profileWriters)
    )
    check('全部测试未发生网络请求', networkGuard.blocked.length === 0)
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
