/**
 * Creator Identity V1 Phase 2 —— Work State 只读派生（服务端唯一权威入口）
 *
 * 冻结规则（PHASE2 §5 / §7）：
 *   · 新表 candidate_work_state_events **存在时** → 只读新表（唯一 source of truth）
 *   · 新表**不存在时**（测试 fixture / 老环境）→ 从 legacy creator_decisions(candidate_review) 派生
 *   · 两张表**绝不混合**后取最新（否则 Phase 3 写路径切换后会出现双重权威）
 *   · 「最新事件」定义：ORDER BY created_at DESC, id DESC LIMIT 1
 *     （created_at 相同时必须用 id 做稳定 tie-break，不能只 MAX(created_at)）
 *   · 无事件 → 默认 advancing（仅返回层派生，绝不因此 INSERT 假事件）
 *   · post_quote 永不参与；candidate.status 永不参与
 *
 * 本模块只读：不 INSERT / UPDATE / DELETE。
 */
import { WORK_STATE_STATES, workStateFromLegacy } from './creatorIdentity.js'

export const WORK_STATE_TABLE = 'candidate_work_state_events'
export const DEFAULT_WORK_STATE = 'advancing'
/** Work State 来源（便于调用方/测试观测「以哪张表为权威」） */
export const WORK_STATE_SOURCE = { EVENTS: 'events', LEGACY: 'legacy', DEFAULT: 'default' }

/** 表是否存在 */
export function hasTable(db, table) {
  return Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  )
}

/** 列是否存在（老 fixture 可能还没有 additive 列） */
export function hasColumn(db, table, column) {
  if (!hasTable(db, table)) return false
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

/**
 * 当前权威来源：新表存在 → events；否则 → legacy。
 * 注意：只看「表是否存在」，不把两张表混起来再取最新。
 */
export function workStateMode(db) {
  return hasTable(db, WORK_STATE_TABLE) ? WORK_STATE_SOURCE.EVENTS : WORK_STATE_SOURCE.LEGACY
}

/**
 * 供组合查询复用的 CTE 片段：`latest_ws AS ( candidate_id, state, legacy_state, note, created_at )`
 * 行数为「每个 candidate 恰好一行」→ 组合进主查询后仍是单条 SQL（无 N+1）。
 */
export function latestWorkStateCte(mode) {
  if (mode === WORK_STATE_SOURCE.EVENTS) {
    return `latest_ws AS (
      SELECT candidate_id, state, legacy_state, note, created_at FROM (
        SELECT candidate_id, state, legacy_state, note, created_at,
               ROW_NUMBER() OVER (PARTITION BY candidate_id ORDER BY created_at DESC, id DESC) AS rn
        FROM ${WORK_STATE_TABLE}
      ) WHERE rn = 1
    )`
  }
  // legacy：只认 candidate_review（post_quote 绝不参与）
  return `latest_ws AS (
    SELECT candidate_id, legacy_state, note, created_at FROM (
      SELECT candidate_id, human_decision AS legacy_state, decision_note AS note, created_at,
             ROW_NUMBER() OVER (PARTITION BY candidate_id ORDER BY created_at DESC, id DESC) AS rn
      FROM creator_decisions
      WHERE decision_stage = 'candidate_review' AND candidate_id IS NOT NULL
    ) WHERE rn = 1
  )`
}

/** 单条「最新事件行」→ 归一化（非法 state / 无法映射的 legacy 值 → null = 视为无事件） */
export function normalizeLatestRow(row, mode) {
  if (!row) return null
  if (mode === WORK_STATE_SOURCE.EVENTS) {
    const state = String(row.state ?? '')
    if (!WORK_STATE_STATES.includes(state)) return null
    return {
      state,
      legacy_state: row.legacy_state ?? null,
      note: row.note ?? null,
      created_at: row.created_at ?? null,
      source: WORK_STATE_SOURCE.EVENTS
    }
  }
  const legacyState = String(row.legacy_state ?? '')
  const mapped = workStateFromLegacy(legacyState)
  if (!mapped) return null
  return {
    state: mapped,
    legacy_state: legacyState,
    note: row.note ?? null,
    created_at: row.created_at ?? null,
    source: WORK_STATE_SOURCE.LEGACY
  }
}

/** 无事件时的产品默认：进入达人拓展即代表有主动推进意图（仅返回层派生） */
export function defaultWorkState() {
  return {
    state: DEFAULT_WORK_STATE,
    legacy_state: null,
    note: null,
    created_at: null,
    source: WORK_STATE_SOURCE.DEFAULT
  }
}

/** 最终对外 Work State（永不返回 null） */
export function resolveWorkState(latestRow, mode) {
  return normalizeLatestRow(latestRow, mode) ?? defaultWorkState()
}

/**
 * 批量读取「每个 candidate 的最新 Work State」——固定 1 条 SQL（不随候选数量增长）。
 * @returns {Map<number, {state,legacy_state,note,created_at,source}>}
 */
export function loadLatestWorkStates(db, mode = workStateMode(db)) {
  const rows = db
    .prepare(`WITH ${latestWorkStateCte(mode)} SELECT * FROM latest_ws`)
    .all()
  const map = new Map()
  for (const row of rows) {
    const normalized = normalizeLatestRow(row, mode)
    if (!normalized) continue
    map.set(Number(row.candidate_id), normalized)
  }
  return map
}

/**
 * 单个 candidate 的 Work State 历史（append-only 全量；默认最新 → 最旧）。
 * 契约稳定：ORDER BY created_at DESC, id DESC（created_at 相同时 id 稳定 tie-break）。
 */
export function loadWorkStateHistory(db, candidateId, mode = workStateMode(db)) {
  const id = Number(candidateId)
  if (!Number.isInteger(id) || id <= 0) return []
  if (mode === WORK_STATE_SOURCE.EVENTS) {
    return db
      .prepare(
        `SELECT id, state, legacy_state, note, created_at
         FROM ${WORK_STATE_TABLE}
         WHERE candidate_id = ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(id)
      .map((row) => ({
        id: row.id,
        state: row.state,
        note: row.note ?? null,
        created_at: row.created_at ?? null,
        legacy_state: row.legacy_state ?? null
      }))
  }
  return db
    .prepare(
      `SELECT id, human_decision AS legacy_state, decision_note AS note, created_at
       FROM creator_decisions
       WHERE decision_stage = 'candidate_review' AND candidate_id = ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(id)
    .map((row) => ({
      id: row.id,
      state: workStateFromLegacy(row.legacy_state),
      note: row.note ?? null,
      created_at: row.created_at ?? null,
      legacy_state: row.legacy_state ?? null
    }))
}

/** 最近的 Work State 事件时间（用于 work_state_updated_at） */
export function workStateUpdatedAt(resolved) {
  return resolved?.created_at ?? null
}
