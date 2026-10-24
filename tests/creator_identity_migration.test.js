#!/usr/bin/env node
// Creator Identity V1 —— migration 001 集成回归测试（临时库 only；绝不触碰真实库）
//
// 运行方式：node tests/creator_identity_migration.test.js
// 隔离：每次都在 os.tmpdir() 下新建 fixture 库，结束时删除。
// 覆盖：dry-run 必须 ROLLBACK、commit（test-only）后的 schema / seed / 归属 / profile / work state、
//       业务事实逐行不变（含 0 vs NULL）、active candidate 唯一约束、幂等、禁止 UNIQUE(creator_id)。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')
const Database = require(path.join(REPO_ROOT, 'backend', 'node_modules', 'better-sqlite3'))

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

let tmpRoot = ''
let fixtureSeq = 0

const SCHEMA = `
CREATE TABLE creator_records (
  id INTEGER PRIMARY KEY, time_cycle TEXT, nickname TEXT, homepage TEXT, creator_type TEXT,
  content_link TEXT, total_cost REAL, publish_date TEXT, video_link TEXT,
  first_play INTEGER, second_week_play INTEGER, created_at TEXT DEFAULT '2026-09-01 00:00:00'
);
CREATE TABLE creator_candidates (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, creator_type TEXT, profile_url TEXT, xingtu_url TEXT,
  xingtu_id TEXT, description TEXT, distilled_description TEXT,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT DEFAULT '2026-09-01 00:00:00',
  updated_at TEXT DEFAULT '2026-09-01 00:00:00'
);
CREATE TABLE creator_recent_snapshots (
  id INTEGER PRIMARY KEY, creator TEXT NOT NULL, candidate_id INTEGER, observed_at TEXT,
  median_play REAL, stats_status TEXT, created_at TEXT DEFAULT '2026-09-01 00:00:00'
);
CREATE TABLE creator_decisions (
  id INTEGER PRIMARY KEY, creator TEXT NOT NULL, decision_stage TEXT NOT NULL, snapshot_id INTEGER,
  current_quote REAL, human_decision TEXT NOT NULL, decision_note TEXT,
  historical_evidence_json TEXT NOT NULL, recent_evidence_json TEXT, pricing_evidence_json TEXT,
  target_cpm REAL NOT NULL, pricing_version TEXT NOT NULL, system_context_version TEXT NOT NULL,
  created_at TEXT DEFAULT '2026-09-01 00:00:00', candidate_id INTEGER
);
CREATE TABLE creator_decision_outcomes (
  id INTEGER PRIMARY KEY, decision_id INTEGER NOT NULL, record_id INTEGER NOT NULL,
  linked_at TEXT, link_evidence_json TEXT, UNIQUE(decision_id), UNIQUE(record_id)
);
CREATE TABLE creator_negotiation_cases (
  id INTEGER PRIMARY KEY, creator TEXT NOT NULL, decision_id INTEGER, record_id INTEGER,
  source_type TEXT NOT NULL DEFAULT 'live', current_quote_snapshot REAL, xingtu_price_snapshot REAL,
  negotiated_price REAL NOT NULL, negotiated_at TEXT NOT NULL, reason_tags_json TEXT NOT NULL DEFAULT '[]',
  source_note TEXT, created_at TEXT DEFAULT '2026-09-01 00:00:00',
  UNIQUE(decision_id)
);
CREATE UNIQUE INDEX idx_negotiation_cases_hist_record
  ON creator_negotiation_cases(record_id)
  WHERE source_type = 'historical_backfill' AND record_id IS NOT NULL;
CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY, file_name TEXT, total_count INTEGER DEFAULT 0, success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0, skip_count INTEGER DEFAULT 0, duplicate_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT '2026-09-01 00:00:00'
);
CREATE TABLE import_batch_items (
  id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, row_index INTEGER, status TEXT, reason TEXT
);
CREATE TABLE import_batch_records (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, record_id INTEGER NOT NULL);
CREATE TABLE import_batch_record_updates (
  id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, record_id INTEGER NOT NULL, field_name TEXT NOT NULL,
  before_value_json TEXT, after_value_json TEXT, created_at TEXT DEFAULT '2026-09-01 00:00:00',
  UNIQUE(batch_id, record_id, field_name)
);
CREATE TABLE projects (
  id INTEGER PRIMARY KEY, name TEXT, owner TEXT, status TEXT, progress INTEGER,
  created_at TEXT DEFAULT '2026-09-01 00:00:00'
);
`

/**
 * 合成 fixture：形状刻意对齐真实库（多轮 nickname / 同名候选 / 尾点 / 0 与 NULL / legacy decision /
 * live + historical case / outcome 桥 / candidate_review 重复值 / post_quote 不参与 Work State）。
 */
function createFixture() {
  fixtureSeq += 1
  const dbPath = path.join(tmpRoot, `fixture-${fixtureSeq}.db`)
  const db = new Database(dbPath)
  db.exec(SCHEMA)

  const record = db.prepare(
    `INSERT INTO creator_records (id, time_cycle, nickname, homepage, creator_type, content_link, total_cost,
                                  publish_date, video_link, first_play, second_week_play, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  record.run(1, '2026-W32', '多轮甲', 'https://v.douyin.com/aaa/', '科普类', 'c1', 1000, '2026-08-10', 'https://v.douyin.com/v1/', 100, 200, '2026-09-01 00:00:00')
  record.run(2, '2026-W33', '多轮甲', 'https://v.douyin.com/bbb/', '科普类', 'c2', 2000, '2026-08-17', 'https://v.douyin.com/v2/', 150, 250, '2026-09-01 00:00:00')
  record.run(3, '2026-W32', '多轮乙', 'https://v.douyin.com/ccc/', '历史类', 'c3', 0, '2026-08-11', 'https://v.douyin.com/v3/', 0, null, '2026-09-01 00:00:00')
  record.run(4, '2026-W32', '单轮丙', 'https://v.douyin.com/ddd/', '历史类', 'c4', 3000, '2026-08-12', 'https://v.douyin.com/v4/', 300, 400, '2026-09-01 00:00:00')
  record.run(5, '2026-W32', '不同类丁', 'https://v.douyin.com/eee/', '科普类', 'c5', 500, '2026-08-13', 'https://v.douyin.com/v5/', 500, 600, '2026-09-01 00:00:00')
  record.run(6, '2026-W33', '不同类丁', 'https://v.douyin.com/fff/', '历史类', 'c6', 600, '2026-08-20', 'https://v.douyin.com/v6/', 600, 700, '2026-09-01 00:00:00')
  record.run(7, '2026-W36', '同人戊', 'https://v.douyin.com/ggg/', '个人成长类', 'c7', 4000, '2026-09-01', 'https://v.douyin.com/v7/', 700, 800, '2026-09-01 00:00:00')
  record.run(8, '2026-W36', '带尾点己.', 'https://v.douyin.com/hhh/', '科普类', 'c8', 800, '2026-09-02', 'https://v.douyin.com/v8/', 900, 1000, '2026-09-01 00:00:00')

  const candidate = db.prepare(
    `INSERT INTO creator_candidates (id, name, creator_type, profile_url, xingtu_url, xingtu_id, description,
                                     distilled_description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  candidate.run(1, '同人戊', '个人成长类', 'https://v.douyin.com/cand1/', null, 'xt-1', 'D1', 'X1', 'active', '2026-09-02 00:00:00', '2026-09-02 00:00:00')
  candidate.run(2, '新人庚', '科普类', 'https://v.douyin.com/cand2/', null, 'xt-2', null, 'ORPHAN-DISTILL', 'active', '2026-09-03 00:00:00', '2026-09-03 00:00:00')
  candidate.run(3, '单轮丙', '历史类', 'https://v.douyin.com/cand3/', null, 'xt-3', 'D3', null, 'active', '2026-09-03 00:00:00', '2026-09-03 00:00:00')
  candidate.run(4, '重名辛', '科普类', 'https://v.douyin.com/cand4/', null, 'xt-4', 'D4', null, 'archived', '2026-09-04 00:00:00', '2026-09-04 00:00:00')
  candidate.run(5, '重名辛', '科普类', 'https://v.douyin.com/cand5/', null, 'xt-5', 'D5', null, 'active', '2026-09-05 00:00:00', '2026-09-05 00:00:00')

  const snapshot = db.prepare(
    `INSERT INTO creator_recent_snapshots (id, creator, candidate_id, observed_at, median_play, stats_status, created_at)
     VALUES (?, ?, ?, ?, ?, 'ok', '2026-09-01 00:00:00')`
  )
  snapshot.run(100, '多轮甲', null, '2026-08-20', 200000)
  snapshot.run(101, '未知达人', null, '2026-08-21', 50000)
  snapshot.run(102, '同人戊', null, '2026-09-01', 300000)
  snapshot.run(103, '同人戊', 1, '2026-09-02', 310000)
  snapshot.run(104, '同人戊', 1, '2026-09-03', 320000)

  const decision = db.prepare(
    `INSERT INTO creator_decisions (id, creator, decision_stage, snapshot_id, current_quote, human_decision,
                                    decision_note, historical_evidence_json, recent_evidence_json,
                                    pricing_evidence_json, target_cpm, pricing_version,
                                    system_context_version, created_at, candidate_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 30, 'pricing-v1', 'ctx-v1', ?, ?)`
  )
  const hist = (tag) => `{"tag":"${tag}","has_prior_collaboration":false}`
  decision.run(20, '同人戊', 'post_quote', 102, 4500, 'proceed', null, hist('d20'), '{"r":1}', '{"p":1}', '2026-09-05 00:00:00', 1)
  decision.run(21, '多轮甲', 'post_quote', 100, 3000, 'repurchase', null, hist('d21'), '{"r":2}', '{"p":2}', '2026-09-06 00:00:00', null)
  decision.run(22, '新人庚', 'candidate_review', null, null, 'contact', 'n1', hist('d22'), '{"r":3}', '{"p":3}', '2026-09-07 00:00:00', 2)
  decision.run(23, '新人庚', 'candidate_review', null, null, 'observe', 'n2', hist('d23'), '{"r":4}', '{"p":4}', '2026-09-08 00:00:00', 2)
  decision.run(24, '新人庚', 'candidate_review', null, null, 'observe', 'n3', hist('d24'), '{"r":5}', '{"p":5}', '2026-09-09 00:00:00', 2)
  decision.run(25, '单轮丙', 'candidate_review', null, null, 'hold', 'n4', hist('d25'), '{"r":6}', '{"p":6}', '2026-09-10 00:00:00', 3)
  decision.run(26, '新人庚', 'post_quote', null, 2000, 'pause', 'n5', hist('d26'), '{"r":7}', '{"p":7}', '2026-09-11 00:00:00', 2)
  decision.run(27, '未知达人', 'post_quote', null, 1000, 'repurchase', null, hist('d27'), '{"r":8}', '{"p":8}', '2026-09-12 00:00:00', null)

  const kase = db.prepare(
    `INSERT INTO creator_negotiation_cases (id, creator, decision_id, record_id, source_type,
                                            current_quote_snapshot, negotiated_price, negotiated_at,
                                            reason_tags_json, source_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`
  )
  kase.run(30, '同人戊', 20, null, 'live', 5000, 4500, '2026-09-05', 'live-note')
  kase.run(31, '同人戊', null, 7, 'historical_backfill', 5000, 4200, '2026-09-01', 'hist-note')

  db.prepare('INSERT INTO creator_decision_outcomes (id, decision_id, record_id, linked_at, link_evidence_json) VALUES (?, ?, ?, ?, ?)').run(
    40,
    20,
    7,
    '2026-09-06 00:00:00',
    '{"version":"outcome-link-v0.1","identity":{"name_match":true}}'
  )
  db.prepare('INSERT INTO import_batches (id, file_name, total_count, success_count) VALUES (1, \'f.xlsx\', 8, 8)').run()
  const item = db.prepare('INSERT INTO import_batch_items (id, batch_id, row_index, status, reason) VALUES (?, 1, ?, ?, ?)')
  item.run(1, 1, 'success', null)
  item.run(2, 2, 'duplicate', '与已有记录完全重复（同一视频链接，事实一致）')
  for (let id = 1; id <= 8; id += 1) {
    db.prepare('INSERT INTO import_batch_records (id, batch_id, record_id) VALUES (?, 1, ?)').run(id, id)
  }
  db.prepare('INSERT INTO projects (id, name, owner, status, progress) VALUES (1, \'demo\', \'\', \'todo\', 0)').run()
  return { db, dbPath }
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

function counts(db, tables) {
  const out = {}
  for (const table of tables) out[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  return out
}

const BUSINESS_TABLES = [
  'creator_records',
  'creator_candidates',
  'creator_recent_snapshots',
  'creator_decisions',
  'creator_decision_outcomes',
  'creator_negotiation_cases',
  'import_batches',
  'import_batch_items',
  'import_batch_records',
  'import_batch_record_updates',
  'projects'
]

async function main() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-identity-migration-'))
  const identity = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/utils/creatorIdentity.js')).href
  )
  const migration = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/migrations/001_creator_identity.js')).href
  )

  console.log('===== 1. dry-run：必须完整 ROLLBACK（schema / 数据都不变）=====')
  {
    const { db } = createFixture()
    const beforeHash = migration.snapshotBusinessData(db)
    const beforeCounts = counts(db, BUSINESS_TABLES)
    const report = migration.runMigration(db, { mode: 'dry-run' })
    const afterHash = migration.snapshotBusinessData(db)
    check('dry-run 内部 reconciled 无业务事实差异', report.diffs.length === 0, JSON.stringify(report.diffs))
    check('dry-run 报告 ok=true', report.ok === true)
    check('dry-run 后 creators 表不存在（已回滚）', !tableExists(db, 'creators'))
    check('dry-run 后 _migrations 表不存在（已回滚）', !tableExists(db, '_migrations'))
    check('dry-run 后 candidate_work_state_events 表不存在', !tableExists(db, 'candidate_work_state_events'))
    check(
      'dry-run 后 creator_id / creator_link_source 列不存在',
      columnsOf(db, 'creator_records').filter((c) => c === 'creator_id' || c === 'creator_link_source').length === 0 &&
        columnsOf(db, 'creator_decisions').filter((c) => c === 'creator_id').length === 0
    )
    check('dry-run 后 partial unique index 不存在', !db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='index' AND name='idx_creator_candidates_active_per_creator'").get())
    check('dry-run 后业务表行数不变', JSON.stringify(counts(db, BUSINESS_TABLES)) === JSON.stringify(beforeCounts))
    check('dry-run 后业务事实 hash 不变', JSON.stringify(migration.snapshotBusinessData(db)) === JSON.stringify(beforeHash))
    db.close()
  }

  console.log('\n===== 2. commit（test-only 临时库）：schema 与 seed =====')
  const fixture = createFixture()
  const db = fixture.db
  const beforeCommitHash = migration.snapshotBusinessData(db)
  const report = migration.runMigration(db, { mode: 'commit' })
  check('commit 报告 ok=true', report.ok === true, JSON.stringify({ diffs: report.diffs, violations: report.violations }))
  check('creators = 6 historical seed + 4 candidate-only = 10', report.actual.creators === 10, String(report.actual.creators))
  check('aliases = 10（每 creator 初始 1 条）', report.actual.aliases === 10, String(report.actual.aliases))
  check('records 8/8 全部归属', report.actual.records_attributed === 8 && report.actual.records_unattributed === 0)
  check(
    'records by source = {outcome_link:1, seed_grouping:7}',
    JSON.stringify(report.actual.records_by_source) === JSON.stringify([{ source: 'outcome_link', n: 1 }, { source: 'seed_grouping', n: 7 }]),
    JSON.stringify(report.actual.records_by_source)
  )
  check('candidates 5/5 全部归属', report.actual.candidates_attributed === 5 && report.actual.candidates_unattributed === 0)
  check('snapshots 4/5 归属（未知达人不猜）', report.actual.snapshots_attributed === 4 && report.actual.snapshots_unattributed === 1)
  check('decisions 7/8 归属（legacy 未知达人 不猜）', report.actual.decisions_attributed === 7 && report.actual.decisions_unattributed === 1)
  check('cases 2/2 归属（live→decision / historical→record）', report.actual.cases_attributed === 2)
  check('outcomes 1（未改动）', report.actual.outcomes === 1)
  check('merges = 0（本轮不做合并）', report.actual.merges === 0)
  check('ambiguous alias groups = 2（单轮丙 / 重名辛 各 2 个 creator）', report.actual.ambiguous_alias_groups === 2, String(report.actual.ambiguous_alias_groups))
  check('unresolved attributions = 2（snapshot101 + legacy decision27）', report.actual.unresolved_attributions === 2)
  check('identity review items = 3（快照未解析 / legacy 未解析 / 候选名撞历史）', report.expected.identity_review_items === 3)
  check('seed creators 一律 provisional（绝不自动 confirmed）', db.prepare("SELECT COUNT(*) AS n FROM creators WHERE identity_status <> 'provisional'").get().n === 0)
  check('frozen baseline 对合成库不适用（N/A）', migration.checkFrozenBaseline({ records: [], candidates: [] }, report.expected).applicable === false)

  console.log('\n===== 3. 归属正确性（强证据 vs 不猜）=====')
  {
    const creatorOfRecord = (id) => db.prepare('SELECT creator_id FROM creator_records WHERE id = ?').get(id)?.creator_id
    const creatorOfCandidate = (id) => db.prepare('SELECT creator_id FROM creator_candidates WHERE id = ?').get(id)?.creator_id
    const creatorOfDecision = (id) => db.prepare('SELECT creator_id FROM creator_decisions WHERE id = ?').get(id)?.creator_id
    const creatorOfSnapshot = (id) => db.prepare('SELECT creator_id FROM creator_recent_snapshots WHERE id = ?').get(id)?.creator_id
    check('多轮同名（多轮甲 2 轮）收敛到同一 creator', creatorOfRecord(1) === creatorOfRecord(2) && creatorOfRecord(1) !== null)
    check('outcome 桥：candidate1 与 record7 归属同一 creator', creatorOfCandidate(1) === creatorOfRecord(7) && creatorOfCandidate(1) !== null)
    check('record7 的 link_source 升级为 outcome_link', db.prepare('SELECT creator_link_source AS s FROM creator_records WHERE id = 7').get().s === 'outcome_link')
    check('其它 record 为 seed_grouping', db.prepare('SELECT creator_link_source AS s FROM creator_records WHERE id = 1').get().s === 'seed_grouping')
    check(
      '候选名与历史名相同但无 outcome → 不自动并入（独立 provisional）',
      creatorOfCandidate(3) !== creatorOfRecord(4) && creatorOfCandidate(3) !== null
    )
    check('历史 snapshot 通过 strict alias 唯一解析', creatorOfSnapshot(100) === creatorOfRecord(1) && creatorOfSnapshot(102) === creatorOfRecord(7))
    check('无法 strict 解析的 snapshot → NULL（不猜）', creatorOfSnapshot(101) === null)
    check('candidate 采集的 snapshot → candidate.creator_id', creatorOfSnapshot(103) === creatorOfCandidate(1) && creatorOfSnapshot(104) === creatorOfCandidate(1))
    check('legacy decision 通过 strict 唯一别名归属', creatorOfDecision(21) === creatorOfRecord(1) && creatorOfDecision(21) !== null)
    check('legacy decision 名字无法解析 → NULL（不猜）', creatorOfDecision(27) === null)
    check('candidate decision → candidate.creator_id', creatorOfDecision(20) === creatorOfCandidate(1) && creatorOfDecision(22) === creatorOfCandidate(2))
    const liveCase = db.prepare('SELECT creator_id FROM creator_negotiation_cases WHERE id = 30').get().creator_id
    const histCase = db.prepare('SELECT creator_id FROM creator_negotiation_cases WHERE id = 31').get().creator_id
    check('live case 归属 = decision.creator_id', liveCase === creatorOfDecision(20) && liveCase !== null)
    check('historical case 归属 = record.creator_id', histCase === creatorOfRecord(7) && histCase !== null)
    check('candidate 文本 / record nickname 未被改写', db.prepare('SELECT nickname FROM creator_records WHERE id = 8').get().nickname === '带尾点己.')
    check('尾点不会被 strict 归一化吞掉（alias 保留原样）', db.prepare("SELECT alias FROM creator_aliases WHERE alias_normalized = '带尾点己.'").get()?.alias === '带尾点己.')
  }

  console.log('\n===== 4. Profile ownership 回填 =====')
  {
    const profile = db.prepare('SELECT canonical_name, creator_type, description, distilled_description, profile_url, xingtu_id FROM creators WHERE id = ?')
    const linkedCreatorId = db.prepare('SELECT creator_id AS id FROM creator_candidates WHERE id = 1').get().id
    const linked = profile.get(linkedCreatorId)
    check('candidate 画像迁到 Creator（description / distilled / profile_url / xingtu_id）',
      linked.description === 'D1' && linked.distilled_description === 'X1' && linked.profile_url === 'https://v.douyin.com/cand1/' && linked.xingtu_id === 'xt-1')
    const orphanCreatorId = db.prepare('SELECT creator_id AS id FROM creator_candidates WHERE id = 2').get().id
    const orphan = profile.get(orphanCreatorId)
    check('description 为空 → distilled 必须失效为 NULL（不留孤儿派生）', orphan.description === null && orphan.distilled_description === null)
    check('candidate creator_type 作为 current profile', orphan.creator_type === '科普类')
    const historicalOnly = db.prepare("SELECT * FROM creators WHERE canonical_name = '多轮甲'").get()
    check('纯历史 Creator 不伪造 profile（description / profile_url 为 NULL）', historicalOnly.description === null && historicalOnly.profile_url === null && historicalOnly.xingtu_id === null)
    check('纯历史 Creator 类型一致时填 creator_type', historicalOnly.creator_type === '科普类')
    const inconsistent = db.prepare("SELECT creator_type FROM creators WHERE canonical_name = '不同类丁'").get()
    check('records 类型不一致 → creator_type = NULL（不挑一条）', inconsistent.creator_type === null)
  }

  console.log('\n===== 5. Work State 迁移（旧行保留，新表 append-only）=====')
  {
    const events = db.prepare('SELECT candidate_id, state, legacy_state, note, created_at FROM candidate_work_state_events ORDER BY id').all()
    check('legacy candidate_review 5→? 本 fixture 为 4 条 → 4 条 event', events.length === 4, String(events.length))
    check('contact → advancing', events[0].state === 'advancing' && events[0].legacy_state === 'contact')
    check('observe → observing（重复值保留两条，不去重）', events[1].state === 'observing' && events[2].state === 'observing')
    check('hold → paused', events[3].state === 'paused' && events[3].legacy_state === 'hold')
    check('note / candidate_id / created_at 保持', events[0].note === 'n1' && events[0].candidate_id === 2 && events[0].created_at === '2026-09-07 00:00:00')
    check('latest event 决定当前状态（candidate2 = observing）',
      db.prepare('SELECT state FROM candidate_work_state_events WHERE candidate_id = 2 ORDER BY created_at DESC, id DESC LIMIT 1').get().state === 'observing')
    check('post_quote 永不进入 work_state_events',
      db.prepare("SELECT COUNT(*) AS n FROM candidate_work_state_events WHERE candidate_id = 2").get().n === 3 &&
        !db.prepare("SELECT 1 AS ok FROM candidate_work_state_events WHERE legacy_state = 'pause'").get())
    const eventColumns = columnsOf(db, 'candidate_work_state_events')
    check('新表无 pricing / evidence / snapshot 字段', !eventColumns.some((c) => /pricing|evidence|snapshot|target_cpm/.test(c)), JSON.stringify(eventColumns))
    check('新表字段 = id/candidate_id/state/legacy_state/note/created_at（不冗余 creator_id）',
      JSON.stringify(eventColumns) === JSON.stringify(['id', 'candidate_id', 'state', 'legacy_state', 'note', 'created_at']))
    check('旧 candidate_review 行一条都没删 / 没改',
      db.prepare("SELECT COUNT(*) AS n FROM creator_decisions WHERE decision_stage = 'candidate_review'").get().n === 4 &&
        db.prepare("SELECT human_decision FROM creator_decisions WHERE id = 24").get().human_decision === 'observe')
    check('work_state mapping diff = 0', report.actual.work_state_mapping_diff === 0)
  }

  console.log('\n===== 6. 业务事实不变量（逐行，含 0 vs NULL）=====')
  {
    const afterCommitHash = migration.snapshotBusinessData(db)
    check('迁移前后业务事实 hash 完全一致', JSON.stringify(beforeCommitHash) === JSON.stringify(afterCommitHash))
    check('migration 内部 diffBusinessData = 0', report.diffs.length === 0)
    const rec3 = db.prepare('SELECT total_cost, first_play, second_week_play FROM creator_records WHERE id = 3').get()
    check('0 语义保持（total_cost=0 仍为 0，不是 NULL）', rec3.total_cost === 0 && rec3.first_play === 0)
    check('NULL 语义保持（second_week_play 仍为 NULL）', rec3.second_week_play === null)
    check('decision evidence JSON 逐字节不变',
      db.prepare('SELECT historical_evidence_json AS h FROM creator_decisions WHERE id = 20').get().h === '{"tag":"d20","has_prior_collaboration":false}' &&
        db.prepare('SELECT pricing_evidence_json AS p FROM creator_decisions WHERE id = 27').get().p === '{"p":8}')
    check('negotiation case 业务字段逐字节不变',
      db.prepare('SELECT negotiated_price, source_note, reason_tags_json FROM creator_negotiation_cases WHERE id = 31').get().negotiated_price === 4200 &&
        db.prepare('SELECT source_note FROM creator_negotiation_cases WHERE id = 31').get().source_note === 'hist-note')
    check('outcome 表逐字节不变',
      db.prepare('SELECT decision_id, record_id FROM creator_decision_outcomes WHERE id = 40').get().record_id === 7 &&
        db.prepare('SELECT link_evidence_json AS e FROM creator_decision_outcomes WHERE id = 40').get().e === '{"version":"outcome-link-v0.1","identity":{"name_match":true}}')
    check('import audit 不变', counts(db, ['import_batches', 'import_batch_items', 'import_batch_records']).import_batch_items === 2)
    check('未新增 identity_ambiguous import status', !db.prepare("SELECT 1 AS ok FROM import_batch_items WHERE status = 'identity_ambiguous'").get())
  }

  console.log('\n===== 7. 禁止 UNIQUE(creator_id)（事件身份不得被降级）=====')
  check('assertForbiddenConstraints = 0', migration.assertForbiddenConstraints(db).length === 0)
  const caseUniqueIndexes = db
    .prepare('PRAGMA index_list(creator_negotiation_cases)')
    .all()
    .filter((row) => row.unique === 1)
    .map((row) => db.prepare(`PRAGMA index_info(${row.name})`).all().map((c) => c.name))
  check(
    'negotiation_cases 仍按 decision_id 唯一（事件身份不变）',
    caseUniqueIndexes.some((cols) => cols.length === 1 && cols[0] === 'decision_id')
  )
  check(
    '未新增任何 UNIQUE(creator_id)',
    !caseUniqueIndexes.some((cols) => cols.length === 1 && cols[0] === 'creator_id')
  )
  check('同一 creator 可以有多条 negotiation case / record（无单列唯一约束）',
    !db.prepare('PRAGMA index_list(creator_negotiation_cases)').all().some((row) => {
      if (row.unique !== 1) return false
      const cols = db.prepare(`PRAGMA index_info(${row.name})`).all().map((c) => c.name)
      return cols.length === 1 && cols[0] === 'creator_id'
    })
  )

  console.log('\n===== 8. Active Candidate 唯一性（partial unique index + 应用层前置检查）=====')
  {
    // 每个子用例使用独立的 fixture，避免互相污染
    const load = () => {
      const fresh = createFixture()
      const result = migration.runMigration(fresh.db, { mode: 'commit' })
      if (!result.ok) throw new Error('fixture migration failed')
      return fresh.db
    }
    const constraintName = 'idx_creator_candidates_active_per_creator'
    {
      const c = load()
      const creatorA = c.prepare('SELECT creator_id AS id FROM creator_candidates WHERE id = 1').get().id
      let rejected = false
      try {
        c.prepare("UPDATE creator_candidates SET creator_id = ?, status = 'active' WHERE id = 2").run(creatorA)
      } catch (error) {
        rejected = /UNIQUE|constraint/i.test(String(error?.message))
      }
      check('两个 active candidate 同一 creator → DB 拒绝', rejected)
      c.close()
    }
    {
      const c = load()
      const creatorA = c.prepare('SELECT creator_id AS id FROM creator_candidates WHERE id = 1').get().id
      let ok = true
      try {
        c.prepare("UPDATE creator_candidates SET creator_id = ?, status = 'archived' WHERE id = 4").run(creatorA)
        c.prepare("UPDATE creator_candidates SET creator_id = ?, status = 'archived' WHERE id = 5").run(creatorA)
      } catch {
        ok = false
      }
      check('archived + 多个 archived 不参与唯一约束 → 成功', ok)
      c.close()
    }
    {
      const c = load()
      const creatorA = c.prepare('SELECT creator_id AS id FROM creator_candidates WHERE id = 1').get().id
      c.prepare("UPDATE creator_candidates SET creator_id = ?, status = 'archived' WHERE id = 4").run(creatorA)
      let ok = true
      try {
        c.prepare("UPDATE creator_candidates SET status = 'active' WHERE id = 4").run()
      } catch {
        ok = false
      }
      check('重开 archived 而该 creator 已有 active → 被拒绝（预期行为）', ok === false)
      c.close()
    }
    {
      const c = load()
      check('不同 creator 各自 active → 成功', c.prepare("SELECT COUNT(*) AS n FROM creator_candidates WHERE status = 'active'").get().n === 4)
      const nullCreator = c.prepare("INSERT INTO creator_candidates (id, name, status, creator_id) VALUES (99, '过渡甲', 'active', NULL)").run()
      const nullCreator2 = c.prepare("INSERT INTO creator_candidates (id, name, status, creator_id) VALUES (98, '过渡乙', 'active', NULL)").run()
      check('creator_id NULL 的迁移过渡行互不冲突', nullCreator.changes === 1 && nullCreator2.changes === 1)
      check('partial index 存在且仅作用于 active', Boolean(c.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='index' AND name = ?").get(constraintName)))
      c.close()
    }
  }

  console.log('\n===== 9. 幂等（commit 二次执行 = no-op）=====')
  {
    const second = migration.runMigration(db, { mode: 'commit' })
    check('第二次执行识别为 alreadyApplied', second.alreadyApplied === true)
    check('creators / aliases 数量不变', db.prepare('SELECT COUNT(*) AS n FROM creators').get().n === 10 && db.prepare('SELECT COUNT(*) AS n FROM creator_aliases').get().n === 10)
    check('work_state events 不重复', db.prepare('SELECT COUNT(*) AS n FROM candidate_work_state_events').get().n === 4)
    check('_migrations 仅一行', db.prepare('SELECT COUNT(*) AS n FROM _migrations').get().n === 1)
    const aliasIdempotent = db.prepare('INSERT OR IGNORE INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?)').run(
      db.prepare('SELECT creator_id AS id FROM creator_candidates WHERE id = 2').get().id,
      'A',
      identity.normalizeAliasStrict('A'),
      'manual'
    )
    check('同 creator 重复 alias → 幂等（changes=0）', aliasIdempotent.changes === 0 || db.prepare("SELECT COUNT(*) AS n FROM creator_aliases WHERE alias_normalized = 'a'").get().n >= 1)
  }

  db.close()

  console.log('\n===== 10. 真实库 commit 授权护栏（A–E，非交互，真实库不受影响）=====')
  {
    const makeBackup = async (fixture, name) => {
      const backupPath = path.join(tmpRoot, name)
      await fixture.db.backup(backupPath)
      return backupPath
    }
    const authOf = (over = {}) => {
      const fixture = over.fixture ?? createFixture()
      return { fixture, ...over }
    }

    // 基线：source == backup，sha 正确，路径一致 → PASS
    {
      const fixture = createFixture()
      const backupPath = await makeBackup(fixture, 'backup-ok.db')
      const auth = migration.authorizeRealDbCommit({
        sourcePath: fixture.dbPath,
        realDbPath: fixture.dbPath, // 测试用「假真实库」避免触碰真实库
        backupPath,
        expectedSourceSha: migration.computeDbStateFingerprint(fixture.dbPath).fingerprint
      })
      check('A–E 全部满足 → 授权通过', auth.ok === true, JSON.stringify(auth.errors))
      check('授权报告包含 5 项检查（A/B/C/D/E）', auth.checks.length === 5 && auth.checks.every((c) => c.pass))
      check('授权检查不修改源库（无 creators 表）', !tableExists(fixture.db, 'creators'))
      fixture.db.close()
    }

    // A：缺 backup-path
    {
      const fixture = createFixture()
      const auth = migration.authorizeRealDbCommit({
        sourcePath: fixture.dbPath,
        realDbPath: fixture.dbPath,
        backupPath: null,
        expectedSourceSha: migration.computeDbStateFingerprint(fixture.dbPath).fingerprint
      })
      check('缺 --backup-path → hard fail（A）', auth.ok === false && auth.checks.find((c) => c.id === 'A').pass === false)
      fixture.db.close()
    }

    // A：backup 不存在
    {
      const fixture = createFixture()
      const auth = migration.authorizeRealDbCommit({
        sourcePath: fixture.dbPath,
        realDbPath: fixture.dbPath,
        backupPath: path.join(tmpRoot, 'not-there.db'),
        expectedSourceSha: migration.computeDbStateFingerprint(fixture.dbPath).fingerprint
      })
      check('--backup-path 指向不存在的文件 → hard fail', auth.ok === false)
      fixture.db.close()
    }

    // D：sha 缺失 / 不匹配
    {
      const fixture = createFixture()
      const backupPath = await makeBackup(fixture, 'backup-d.db')
      const missingSha = migration.authorizeRealDbCommit({ sourcePath: fixture.dbPath, realDbPath: fixture.dbPath, backupPath, expectedSourceSha: null })
      const wrongSha = migration.authorizeRealDbCommit({ sourcePath: fixture.dbPath, realDbPath: fixture.dbPath, backupPath, expectedSourceSha: 'a'.repeat(64) })
      check('缺 --expected-source-sha → hard fail（D）', missingSha.ok === false && missingSha.checks.find((c) => c.id === 'D').pass === false)
      check('sha 不匹配 → hard fail（D）', wrongSha.ok === false)
      fixture.db.close()
    }

    // E：路径不是真实库
    {
      const fixture = createFixture()
      const backupPath = await makeBackup(fixture, 'backup-e.db')
      const auth = migration.authorizeRealDbCommit({
        sourcePath: fixture.dbPath,
        realDbPath: path.join(tmpRoot, 'some-other.db'),
        backupPath,
        expectedSourceSha: migration.computeDbStateFingerprint(fixture.dbPath).fingerprint
      })
      check('db path 不等于真实库 → hard fail（E）', auth.ok === false && auth.checks.find((c) => c.id === 'E').pass === false)
      fixture.db.close()
    }

    // B：备份损坏
    {
      const fixture = createFixture()
      const brokenPath = path.join(tmpRoot, 'backup-broken.db')
      fs.writeFileSync(brokenPath, Buffer.from('this is not a sqlite database'.repeat(10)))
      const auth = migration.authorizeRealDbCommit({
        sourcePath: fixture.dbPath,
        realDbPath: fixture.dbPath,
        backupPath: brokenPath,
        expectedSourceSha: migration.computeDbStateFingerprint(fixture.dbPath).fingerprint
      })
      check('备份损坏（integrity 无法通过）→ hard fail（B）', auth.ok === false && auth.checks.find((c) => c.id === 'B').pass === false)
      fixture.db.close()
    }

    // C：备份与源库业务逻辑不一致
    {
      const fixture = createFixture()
      const backupPath = await makeBackup(fixture, 'backup-drift.db')
      const backupDb = new Database(backupPath)
      backupDb.prepare('DELETE FROM creator_records WHERE id = 1').run()
      backupDb.close()
      const auth = migration.authorizeRealDbCommit({
        sourcePath: fixture.dbPath,
        realDbPath: fixture.dbPath,
        backupPath,
        expectedSourceSha: migration.computeDbStateFingerprint(fixture.dbPath).fingerprint
      })
      check('备份缺少业务行（logical hash 不一致）→ hard fail（C）', auth.ok === false && auth.checks.find((c) => c.id === 'C').pass === false)
      fixture.db.close()
    }

    // Phase audit §17：WAL 场景下「主文件 sha 不变」不能证明逻辑库未变化
    {
      const fixture = createFixture()
      // 与真实库一致：WAL 模式（否则写入走 rollback journal，不会产生 -wal 文件）
      fixture.db.pragma('journal_mode = WAL')
      // 在 fixture 上提交一条业务写入（WAL 承载，未 checkpoint）——与真实用户操作同构
      fixture.db
        .prepare(
          "INSERT INTO creator_records (time_cycle, nickname, total_cost, first_play, second_week_play) VALUES ('2026-W40','wal写入',1000,100,200)"
        )
        .run()
      const mainSha = migration.computeFileSha256(fixture.dbPath)
      const state = migration.computeDbStateFingerprint(fixture.dbPath)
      const backupPath = await makeBackup(fixture, 'backup-wal.db')
      const staleShaAuth = migration.authorizeRealDbCommit({
        sourcePath: fixture.dbPath,
        realDbPath: fixture.dbPath,
        backupPath,
        expectedSourceSha: mainSha
      })
      const freshAuth = migration.authorizeRealDbCommit({
        sourcePath: fixture.dbPath,
        realDbPath: fixture.dbPath,
        backupPath,
        expectedSourceSha: state.fingerprint
      })
      check(
        '§17 WAL 已承载写入：主文件 sha ≠ 逻辑状态指纹（旧假设会漏判）',
        state.mainSha === mainSha && state.walBytes > 0 && state.fingerprint !== mainSha,
        `main=${state.mainSha.slice(0, 12)}… fp=${state.fingerprint.slice(0, 12)}… wal=${state.walBytes}B`
      )
      check(
        '§17 仅用主文件 sha 作为 expected → 授权拒绝（D 项不再被 WAL 欺骗）',
        staleShaAuth.ok === false && staleShaAuth.checks.find((c) => c.id === 'D').pass === false
      )
      check(
        '§17 用逻辑状态指纹作为 expected → 授权通过（正确契约）',
        freshAuth.ok === true && freshAuth.sourceState?.walBytes > 0
      )
      check(
        '§17 授权结果暴露完整 DB 状态（main sha / WAL bytes / WAL sha）',
        Boolean(freshAuth.sourceState?.mainSha) &&
          Number.isInteger(freshAuth.sourceState?.walBytes) &&
          typeof freshAuth.sourceState?.walSha === 'string'
      )
      fixture.db.close()
    }

    // 真实库路径：CLI 层默认拒绝 + 完整 flag 才放行（不实际执行）
    let cliBlockedWithoutFlag = false
    try {
      migration.guardDbPath(migration.REAL_DB_PATH, 'commit')
    } catch {
      cliBlockedWithoutFlag = true
    }
    check('真实库 commit 缺少 --allow-real-db → 拒绝', cliBlockedWithoutFlag)
    check('真实库 sha256 可读取（授权 D 项的数据源）', /^[0-9a-f]{64}$/.test(migration.computeFileSha256(migration.REAL_DB_PATH)))
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
    if (tmpRoot) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
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
