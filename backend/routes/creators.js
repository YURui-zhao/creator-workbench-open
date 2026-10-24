/**
 * Creator Identity V1 Phase 2 —— Creator 只读接口（GET only）
 *
 * 定位：把 Phase 1 建立的 Creator 身份层（creators / creator_aliases）暴露成稳定的只读视图。
 * 边界（本轮刻意克制）：
 *   · 只有 GET /api/creators 与 GET /api/creators/:id —— 不实现 merge / alias 写入 / 复投 / collaboration 聚合
 *   · 不聚合 records 详情、不做 UI 数据拼装（只给计数与 active candidate 指向）
 *   · 只读：本文件不包含任何 INSERT / UPDATE / DELETE
 *   · nickname / candidate.name 等 legacy 字段与逻辑一律不动
 *
 * Work State：通过 Creator → active Candidate → latest candidate_work_state_event 派生，
 * 绝不在 Creator 上存状态（creator 表没有 state 列，也不引入）。
 */
import { Router } from 'express'
import db from '../db.js'
import {
  DEFAULT_WORK_STATE,
  hasColumn,
  hasTable,
  resolveWorkState,
  workStateMode
} from '../utils/creatorWorkStateRead.js'

const router = Router()

const NAME_MAX = 100
const KEYWORD_MAX = 100

// 只读公开字段白名单（顺带避免把任何未来内部列泄漏出去）
const CREATOR_COLUMNS = [
  'id',
  'canonical_name',
  'creator_type',
  'identity_status',
  'description',
  'distilled_description',
  'profile_url',
  'xingtu_id',
  'xingtu_url',
  'merged_into_creator_id',
  'created_at',
  'updated_at'
]

function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, msg) {
  res.status(code).json({ code, data: null, msg })
}

function parseId(raw) {
  const num = Number(raw)
  return Number.isInteger(num) && num > 0 ? num : null
}

/** LIKE 通配符转义（配合 ESCAPE '\'）——只做严格 substring，绝不做 fuzzy / 拼音 / 相似度 */
function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function toPublicCreator(row, aliasCount = 0) {
  if (!row) return null
  const creator = {}
  for (const column of CREATOR_COLUMNS) creator[column] = row[column] ?? null
  creator.alias_count = Number(aliasCount ?? 0)
  return creator
}

const SCHEMA_MISSING_MESSAGE =
  'Creator 身份层尚未初始化（creators 表不存在）：请先执行 Creator Identity Phase 1 migration。'

/**
 * GET /api/creators
 * query: keyword?（canonical_name / alias 严格 substring）、include_merged=1（默认排除墓碑）
 *
 * 列表刻意只返回基础资料 + alias_count（不返回 aliases 数组，避免长文本/多行放大列表响应）。
 */
router.get('/', (req, res) => {
  if (!hasTable(db, 'creators')) {
    return ok(res, { creators: [], total: 0, keyword: null, include_merged: false, schema_ready: false, message: SCHEMA_MISSING_MESSAGE })
  }

  const rawKeyword = req.query?.keyword
  const keyword = typeof rawKeyword === 'string' ? rawKeyword.trim() : ''
  if (keyword.length > KEYWORD_MAX) return fail(res, 400, `keyword 长度不能超过 ${KEYWORD_MAX}`)
  const includeMerged = ['1', 'true', 'yes'].includes(String(req.query?.include_merged ?? '').toLowerCase())

  const conditions = []
  const params = []
  if (!includeMerged) conditions.push("c.identity_status <> 'merged'")
  if (keyword) {
    const like = `%${escapeLike(keyword)}%`
    conditions.push(
      `(c.canonical_name LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM creator_aliases a
          WHERE a.creator_id = c.id
            AND (a.alias LIKE ? ESCAPE '\\' OR a.alias_normalized LIKE ? ESCAPE '\\')
        ))`
    )
    params.push(like, like, like)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM creator_aliases a WHERE a.creator_id = c.id) AS alias_count
       FROM creators c
       ${where}
       ORDER BY c.canonical_name COLLATE NOCASE ASC, c.id ASC`
    )
    .all(...params)

  ok(res, {
    creators: rows.map((row) => toPublicCreator(row, row.alias_count)),
    total: rows.length,
    keyword: keyword || null,
    include_merged: includeMerged,
    schema_ready: true
  })
})

/**
 * GET /api/creators/:id
 * 返回：基础资料 + aliases + attribution 计数 + latest_known_work_state（active candidate 派生）
 * 不聚合 records 明细（本轮只给计数，避免把工作台数据塞进身份层接口）。
 */
router.get('/:id', (req, res) => {
  if (!hasTable(db, 'creators')) {
    return fail(res, 503, SCHEMA_MISSING_MESSAGE)
  }
  const id = parseId(req.params.id)
  if (id === null) return fail(res, 400, '非法的 Creator ID')

  const row = db.prepare('SELECT * FROM creators WHERE id = ?').get(id)
  if (!row) return fail(res, 404, `Creator #${id} 不存在`)

  const aliases = db
    .prepare(
      `SELECT id, alias, alias_normalized, source, created_at
       FROM creator_aliases WHERE creator_id = ?
       ORDER BY id ASC`
    )
    .all(id)

  // attribution 计数：仅在 additive 列存在时统计（老 fixture 可能还没有 creator_id）
  const recordsCount = hasColumn(db, 'creator_records', 'creator_id')
    ? Number(db.prepare('SELECT COUNT(*) AS n FROM creator_records WHERE creator_id = ?').get(id).n)
    : 0
  const candidateRows = hasColumn(db, 'creator_candidates', 'creator_id')
    ? db.prepare('SELECT id, name, status FROM creator_candidates WHERE creator_id = ? ORDER BY id ASC').all(id)
    : []
  const activeCandidate = candidateRows.filter((item) => item.status === 'active').pop() ?? null

  let latestKnownWorkState = null
  if (activeCandidate) {
    const mode = workStateMode(db)
    const latestRow =
      mode === 'events'
        ? db
            .prepare(
              `SELECT state, legacy_state, note, created_at
               FROM candidate_work_state_events WHERE candidate_id = ?
               ORDER BY created_at DESC, id DESC LIMIT 1`
            )
            .get(activeCandidate.id)
        : db
            .prepare(
              `SELECT human_decision AS legacy_state, decision_note AS note, created_at
               FROM creator_decisions
               WHERE decision_stage = 'candidate_review' AND candidate_id = ?
               ORDER BY created_at DESC, id DESC LIMIT 1`
            )
            .get(activeCandidate.id)
    const resolved = resolveWorkState(latestRow, mode)
    latestKnownWorkState = {
      candidate_id: activeCandidate.id,
      state: resolved.state,
      note: resolved.note,
      updated_at: resolved.created_at,
      legacy_state: resolved.legacy_state,
      source: resolved.source
    }
  }

  ok(res, {
    creator: { ...toPublicCreator(row, aliases.length), aliases },
    attribution: {
      records_count: recordsCount,
      candidate_workflows_count: candidateRows.length,
      active_candidate_id: activeCandidate?.id ?? null,
      active_candidate_name: activeCandidate?.name ?? null
    },
    latest_known_work_state: latestKnownWorkState,
    default_work_state: DEFAULT_WORK_STATE,
    schema_ready: true
  })
})

export default router
