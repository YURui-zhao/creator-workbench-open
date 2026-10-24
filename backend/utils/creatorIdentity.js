/**
 * Creator Identity V1 —— 纯函数层（deterministic：无时间、无随机、无网络、无 AI、不写库）
 *
 * 冻结边界（来自 Creator Domain V1 Design Revision）：
 *   · Creator = 长期现实达人主实体；Candidate = 某一次拓展 workflow；Record = 一次真实投放事实；
 *     Decision = 真正业务判断；Work State = workflow 注意力状态；Negotiation Case = 某一次谈价事件。
 *   · creator_id 是「归属锚」，绝不替代 decision_id / record_id 这些事件身份。
 *
 * Alias 严格规则（绝不放宽）：
 *   自动归属 normalization 只允许：Unicode NFKC → trim → 连续空白折叠为单个空格 → case fold。
 *   绝不允许：去尾部句点 / 去标点 / 拼音 / 编辑距离 / fuzzy match。
 *   loose（去标点等）只允许出现在 identity-review 的 suggestion 里，绝不据此自动赋 creator_id。
 *
 * Resolver 契约：
 *   0 match → 可以创建 provisional Creator
 *   1 match → 可以自动归属
 *   N match → creator_id = NULL（不猜）→ 进入 identity review
 */

// ---------- Creator 归属来源（可审计） ----------
export const CREATOR_LINK_SOURCES = ['seed_grouping', 'alias_exact', 'outcome_link', 'manual']

/** 归属来源是否合法（NULL 表示「尚未归属」，合法） */
export function isCreatorLinkSource(value) {
  if (value === null || value === undefined) return true
  return CREATOR_LINK_SOURCES.includes(String(value))
}

// ---------- Work State（workflow 注意力状态；已从 creator_decisions 拆出） ----------
export const WORK_STATE_STATES = ['advancing', 'observing', 'paused']

// legacy candidate_review decision → workflow 状态
export const LEGACY_WORK_STATE_MAP = {
  contact: 'advancing',
  observe: 'observing',
  hold: 'paused'
}

// 反向映射（API 兼容：旧客户端仍收到 contact/observe/hold）
export const WORK_STATE_TO_LEGACY = {
  advancing: 'contact',
  observing: 'observe',
  paused: 'hold'
}

/** legacy candidate_review 值 → workflow state；非法值返回 null（不猜） */
export function workStateFromLegacy(value) {
  const key = value === null || value === undefined ? '' : String(value).trim()
  return Object.prototype.hasOwnProperty.call(LEGACY_WORK_STATE_MAP, key)
    ? LEGACY_WORK_STATE_MAP[key]
    : null
}

/** workflow state → legacy 值（仅供旧 API 回映射） */
export function legacyFromWorkState(state) {
  const key = state === null || state === undefined ? '' : String(state).trim()
  return Object.prototype.hasOwnProperty.call(WORK_STATE_TO_LEGACY, key)
    ? WORK_STATE_TO_LEGACY[key]
    : null
}

// ---------- Alias normalization（strict） ----------
/**
 * strict 别名归一化（纯函数，确定性）。
 *   NFKC → trim → 连续空白折叠为单个空格 → toLowerCase()
 * 明确不做：去尾部句点、去标点、拼音、编辑距离、模糊匹配。
 * @returns {string} 归一化结果（空 / 缺失 → ''）
 */
export function normalizeAliasStrict(value) {
  if (value === null || value === undefined) return ''
  const text = String(value).normalize('NFKC').trim().replace(/\s+/g, ' ')
  return text.toLowerCase()
}

/**
 * loose key（**仅供 identity-review suggestion**，绝不用于自动归属）。
 * 去掉空白与常见标点后再比较，用于「看起来可能是同一个人」的提示。
 */
export function looseSuggestionKey(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,;:!?'"`~()（）[\]【】{}<>、。，；：！？“”‘’·・\-_/\\|]/g, '')
}

// ---------- Historical seed grouping ----------
// 说明：SEED GROUPING ≠ 身份确认。
//   creator_records 按 nickname 聚合是当前产品（CreatorSummary / RepurchaseRadar）长期使用的口径，
//   因此可以作为「播种分组」；但由此产生的 Creator 一律 provisional，绝不自动 confirmed。
export const SEED_NAMELESS_LABEL = '未命名达人'

/** 播种分组键：与既有产品口径一致（String(nickname).trim() || '未命名达人'） */
export function seedGroupKey(nickname) {
  const text = nickname === null || nickname === undefined ? '' : String(nickname).trim()
  return text || SEED_NAMELESS_LABEL
}

/** 同一 nickname 的多条 records：只有全部非空类型一致时才作为 current creator_type，否则 null（不猜） */
export function pickCreatorTypeFromRecords(recordRows = []) {
  const types = new Set()
  for (const row of Array.isArray(recordRows) ? recordRows : []) {
    const value = row?.creator_type === null || row?.creator_type === undefined ? '' : String(row.creator_type).trim()
    if (value) types.add(value)
  }
  return types.size === 1 ? [...types][0] : null
}

/**
 * 把 creator_records 聚成 seed groups（纯函数；保持输入出现顺序以确定性输出）。
 * @param {Array<{id:number,nickname:string,creator_type?:string}>} recordRows
 * @returns {Array<{key:string,label:string,normalized:string,recordIds:number[],creatorType:string|null}>}
 */
export function buildSeedGroups(recordRows = []) {
  const groups = new Map()
  for (const row of Array.isArray(recordRows) ? recordRows : []) {
    if (!row || row.id === null || row.id === undefined) continue
    const label = seedGroupKey(row.nickname)
    if (!groups.has(label)) {
      groups.set(label, {
        key: `seed:${label}`,
        label,
        normalized: normalizeAliasStrict(label),
        recordIds: [],
        rows: []
      })
    }
    const group = groups.get(label)
    group.recordIds.push(Number(row.id))
    group.rows.push(row)
  }
  return [...groups.values()].map((group) => ({
    key: group.key,
    label: group.label,
    normalized: group.normalized,
    recordIds: group.recordIds,
    creatorType: pickCreatorTypeFromRecords(group.rows)
  }))
}

// ---------- Alias resolver（纯函数版本：调用方提供 alias 行） ----------
/**
 * 按 strict 归一化在 alias 行集合里解析 creator。
 * @param {Array<{creator_id:number,alias:string,alias_normalized:string}>} aliasRows
 * @param {string} rawAlias
 * @returns {{ normalized:string, count:number, creatorIds:number[] }}
 */
export function resolveAliasFromEntries(aliasRows = [], rawAlias) {
  const normalized = normalizeAliasStrict(rawAlias)
  if (!normalized) return { normalized, count: 0, creatorIds: [] }
  const creatorIds = new Set()
  for (const row of Array.isArray(aliasRows) ? aliasRows : []) {
    if (!row) continue
    if (String(row.alias_normalized ?? '') !== normalized) continue
    const id = Number(row.creator_id)
    if (Number.isInteger(id)) creatorIds.add(id)
  }
  const ids = [...creatorIds].sort((a, b) => a - b)
  return { normalized, count: ids.length, creatorIds: ids }
}

// ---------- 归属决策（纯函数） ----------
/**
 * 单条「事实」的 creator 归属决策。
 * 绝不 fuzzy：只有 strict 0/1/N 三态。
 * @returns {{ creatorKey: string|null, reason: 'unique_alias'|'none'|'ambiguous', normalized: string }}
 */
export function decideAttribution({ aliasRows = [], rawName = '', creatorKeyByCreatorId = {} } = {}) {
  const resolved = resolveAliasFromEntries(aliasRows, rawName)
  // creatorKeyByCreatorId 允许传 Map（迁移计划）或普通对象（调用方自便）
  const keyOf = (id) =>
    creatorKeyByCreatorId instanceof Map
      ? creatorKeyByCreatorId.get(id) ?? null
      : creatorKeyByCreatorId?.[id] ?? null
  if (resolved.count === 1) {
    return {
      creatorKey: keyOf(resolved.creatorIds[0]),
      reason: 'unique_alias',
      normalized: resolved.normalized
    }
  }
  if (resolved.count > 1) return { creatorKey: null, reason: 'ambiguous', normalized: resolved.normalized }
  return { creatorKey: null, reason: 'none', normalized: resolved.normalized }
}

// ---------- 归属来源升级 ----------
// seed_grouping 只是播种口径；已有明确 outcome 身份证据时可升级为 outcome_link。
const LINK_SOURCE_RANK = { seed_grouping: 1, alias_exact: 2, outcome_link: 3, manual: 4 }

/** 取更强（可审计性更高）的归属来源；null/未知视为最低 */
export function strongerLinkSource(a, b) {
  const left = LINK_SOURCE_RANK[a] ?? 0
  const right = LINK_SOURCE_RANK[b] ?? 0
  if (left === 0 && right === 0) return null
  return left >= right ? a : b
}

// ============================================================
// Phase 4 —— DB-aware 归属工具（写入路径唯一身份解析入口）
//
// 冻结边界（PHASE4 §2）：
//   · 只有 strict alias（NFKC / trim / 连续空白折叠 / case fold）可以自动归属。
//   · 绝不 fuzzy —— 不导拼音、不算编辑距离、不去标点。
//   · 所有函数接受 `db` 作为参数（本模块不 import db.js，避免循环依赖 / 便于测试）。
//   · 身份层 schema 不存在（Phase 1 migration 之前的老环境 / 老 fixture）时优雅降级：
//     解析一律返回 0 match，写入方按「没有身份层」的旧契约继续跑。
// ============================================================

/** 表是否存在（只读 introspection） */
export function identityTableExists(db, table) {
  try {
    return Boolean(
      db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    )
  } catch {
    return false
  }
}

/** 列是否存在（只读 introspection） */
export function identityTableHasColumn(db, table, column) {
  if (!identityTableExists(db, table)) return false
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((row) => row.name === column)
  } catch {
    return false
  }
}

/** 身份层 schema 是否就绪：creators + creator_aliases 都必须存在 */
export function identitySchemaReady(db) {
  return identityTableExists(db, 'creators') && identityTableExists(db, 'creator_aliases')
}

/** 某张业务表是否已经具备 creator_id 归属列（additive 列） */
export function hasCreatorColumn(db, table) {
  return identitySchemaReady(db) && identityTableHasColumn(db, table, 'creator_id')
}

/**
 * strict 别名解析（DB 版本）。merged 墓碑 Creator 自动指向合并目标后去重。
 * @returns {{ normalized: string, count: number, creatorIds: number[] }}
 */
export function resolveCreatorByStrictAlias(db, rawName) {
  const normalized = normalizeAliasStrict(rawName)
  if (!normalized || !identitySchemaReady(db)) return { normalized, count: 0, creatorIds: [] }
  const rows = db
    .prepare(
      `SELECT a.creator_id AS creator_id,
              c.identity_status AS identity_status,
              c.merged_into_creator_id AS merged_into_creator_id
       FROM creator_aliases a JOIN creators c ON c.id = a.creator_id
       WHERE a.alias_normalized = ?`
    )
    .all(normalized)
  const ids = new Set()
  for (const row of rows) {
    // merged 墓碑：归属必须落到 target，绝不把事实挂到墓碑上
    const target =
      row.identity_status === 'merged' &&
      row.merged_into_creator_id !== null &&
      row.merged_into_creator_id !== undefined
        ? Number(row.merged_into_creator_id)
        : Number(row.creator_id)
    if (Number.isInteger(target) && target > 0) ids.add(target)
  }
  const creatorIds = [...ids].sort((a, b) => a - b)
  return { normalized, count: creatorIds.length, creatorIds }
}

/**
 * 创建一个 provisional Creator + strict alias。
 * 绝不自动 confirmed；identity_status 固定 provisional。
 * @returns {{ id:number, canonical_name:string, identity_status:string, alias_created:boolean, alias_normalized:string }}
 */
export function createProvisionalCreator(
  db,
  { name, creatorType = null, aliasSource = 'import', profile = {} } = {}
) {
  const canonicalName = name === null || name === undefined ? '' : String(name).trim()
  const info = db
    .prepare(
      `INSERT INTO creators (
         canonical_name, creator_type, identity_status,
         description, distilled_description, profile_url, xingtu_id, xingtu_url
       ) VALUES (?, ?, 'provisional', ?, ?, ?, ?, ?)`
    )
    .run(
      canonicalName,
      creatorType === null || creatorType === undefined ? null : String(creatorType),
      profile.description ?? null,
      profile.distilled_description ?? null,
      profile.profile_url ?? null,
      profile.xingtu_id ?? null,
      profile.xingtu_url ?? null
    )
  const creatorId = Number(info.lastInsertRowid)
  const normalized = normalizeAliasStrict(canonicalName)
  let aliasCreated = false
  if (normalized) {
    aliasCreated =
      db
        .prepare(
          `INSERT OR IGNORE INTO creator_aliases (creator_id, alias, alias_normalized, source)
           VALUES (?, ?, ?, ?)`
        )
        .run(creatorId, canonicalName, normalized, aliasSource).changes > 0
  }
  return {
    id: creatorId,
    canonical_name: canonicalName,
    identity_status: 'provisional',
    alias_created: aliasCreated,
    alias_normalized: normalized
  }
}

/**
 * 新 record 的归属决策（strict 0/1/N 三态，绝不 fuzzy）。
 *   0 match → 建 provisional Creator + alias（source = aliasSource）；link_source = 'alias_exact'
 *   1 match → 复用已有 Creator；link_source = 'alias_exact'
 *   N match → creator_id = NULL / link_source = NULL（不猜；事实写入照常成功）
 * @returns {{ creatorId:number|null, creatorLinkSource:string|null, reason:'unique_alias'|'none'|'ambiguous', created:boolean, normalized:string }}
 */
export function resolveOrCreateCreatorForRecord(
  db,
  { nickname, creatorType = null, aliasSource = 'import' } = {}
) {
  const resolved = resolveCreatorByStrictAlias(db, nickname)
  if (resolved.count === 1) {
    return {
      creatorId: resolved.creatorIds[0],
      creatorLinkSource: 'alias_exact',
      reason: 'unique_alias',
      created: false,
      normalized: resolved.normalized
    }
  }
  if (resolved.count > 1) {
    return {
      creatorId: null,
      creatorLinkSource: null,
      reason: 'ambiguous',
      created: false,
      normalized: resolved.normalized
    }
  }
  const creator = createProvisionalCreator(db, { name: nickname, creatorType, aliasSource })
  return {
    creatorId: creator.id,
    creatorLinkSource: 'alias_exact',
    reason: 'none',
    created: true,
    creator,
    normalized: resolved.normalized
  }
}

/**
 * 只读归属：从文本名称解析 creator_id（绝不创建）。
 * 用于 snapshot / legacy decision 这类「已有别的稳定锚，只是补一个归属」的场景。
 * `reason` 是稳定机器可读取值（unique_alias / none / ambiguous）；
 * 调用方据此构造稳定 identity 契约，绝不靠中文文案判断。
 */
export function resolveCreatorIdFromText(db, rawName) {
  const resolved = resolveCreatorByStrictAlias(db, rawName)
  if (resolved.count === 1) {
    return {
      creatorId: resolved.creatorIds[0],
      reason: 'unique_alias',
      normalized: resolved.normalized,
      creatorIds: resolved.creatorIds
    }
  }
  if (resolved.count > 1) {
    return {
      creatorId: null,
      reason: 'ambiguous',
      normalized: resolved.normalized,
      creatorIds: resolved.creatorIds
    }
  }
  return { creatorId: null, reason: 'none', normalized: resolved.normalized, creatorIds: [] }
}

/**
 * 显式 creator_id 校验：正整数 + 存在 + 非 merged 墓碑。
 * 失败时返回稳定 `reason`（schema_missing / invalid_id / not_found / merged），
 * 供各写路径构造一致的 identity 错误契约（PHASE4 稳定化 §8 / §10）。
 */
export function validateExplicitCreatorId(db, rawId) {
  if (!identitySchemaReady(db)) {
    return { ok: false, reason: 'schema_missing', error: '身份层尚未初始化（无 creators 表）' }
  }
  const id = Number(rawId)
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, reason: 'invalid_id', error: 'creator_id 必须是正整数' }
  }
  const row = db.prepare('SELECT id, canonical_name, identity_status FROM creators WHERE id = ?').get(id)
  if (!row) return { ok: false, reason: 'not_found', creatorId: id, error: `creator_id=${id} 不存在` }
  if (row.identity_status === 'merged') {
    return {
      ok: false,
      reason: 'merged',
      creatorId: id,
      creator: row,
      error: `Creator #${id} 已合并，不能作为归属锚`
    }
  }
  return { ok: true, creatorId: id, creator: row }
}

/**
 * 统一 identity 失败契约（稳定机器可读）。
 * 保持项目既有 `{ code, data, msg }` 形状：structured 信息放在 `data`，
 * 与 outcome 关联使用的 `data.requires_identity_confirmation` 属同一套做法。
 * @param {string} reason ambiguous | not_found | merged | invalid_id | schema_missing
 * @param {Object} [extra]
 */
export function creatorIdentityErrorData(reason, extra = {}) {
  return { creator_identity: { reason, ...extra } }
}

/** strict alias 命中多个 Creator 时的候选列表（仅返回对外可见的基础字段） */
export function describeCreatorsByIds(db, creatorIds = []) {
  const ids = (Array.isArray(creatorIds) ? creatorIds : []).filter(
    (id) => Number.isInteger(Number(id)) && Number(id) > 0
  )
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(', ')
  return db
    .prepare(
      `SELECT id, canonical_name, identity_status FROM creators WHERE id IN (${placeholders}) ORDER BY id ASC`
    )
    .all(...ids.map(Number))
}

/** 归属锚只读访问：candidate / decision / record 行 → creator_id（永不替代事件身份） */
export function creatorForCandidate(_db, row) {
  const id = Number(row?.creator_id)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function creatorForDecision(_db, row) {
  const id = Number(row?.creator_id)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function creatorForRecord(_db, row) {
  const id = Number(row?.creator_id)
  return Number.isInteger(id) && id > 0 ? id : null
}

// ---------- Import rollback：孤立自动 seed 清理 ----------
// 自动 import 新建别名的来源标记（人工 / 播种别名绝不删）
export const AUTO_IMPORT_ALIAS_SOURCE = 'import'

// 会引用 creator 的事实表（任一存在 → 不是孤立空壳）
const CREATOR_FACT_TABLES = [
  'creator_records',
  'creator_candidates',
  'creator_recent_snapshots',
  'creator_decisions',
  'creator_negotiation_cases'
]

/**
 * 该 Creator 是否是「自动 import 生成、且已经完全孤立」的空壳？
 * 条件全部满足才返回 true（任一不满足 → 保守保留）：
 *   · identity_status = provisional
 *   · 无任何 record / candidate / snapshot / decision / negotiation case
 *   · 无 merge 关系（任一方向）
 *   · 至少一条 alias，且全部 alias.source === 'import'（无人工身份资产）
 */
export function isOrphanAutoImportedCreator(db, creatorId) {
  if (!identitySchemaReady(db)) return false
  const id = Number(creatorId)
  if (!Number.isInteger(id) || id <= 0) return false
  const creator = db.prepare('SELECT id, identity_status FROM creators WHERE id = ?').get(id)
  if (!creator || creator.identity_status !== 'provisional') return false
  for (const table of CREATOR_FACT_TABLES) {
    if (!identityTableHasColumn(db, table, 'creator_id')) continue
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE creator_id = ?`).get(id).n
    if (Number(n) > 0) return false
  }
  if (identityTableExists(db, 'creator_merges')) {
    const merged = db
      .prepare(
        'SELECT COUNT(*) AS n FROM creator_merges WHERE source_creator_id = ? OR target_creator_id = ?'
      )
      .get(id, id).n
    if (Number(merged) > 0) return false
  }
  const aliases = db.prepare('SELECT id, source FROM creator_aliases WHERE creator_id = ?').all(id)
  if (!aliases.length) return false
  if (aliases.some((alias) => String(alias.source ?? '') !== AUTO_IMPORT_ALIAS_SOURCE)) return false
  return true
}

/**
 * 清理「自动 import 生成、rollback 后完全孤立」的空壳 Creator + 其 alias。
 * 无法百分百确认是孤立自动 seed → 保留（绝不误删）。
 * 只读判断 + 精确 DELETE；调用方负责放进事务。
 * @returns {{ removedCreatorIds:number[], removedAliasIds:number[] }}
 */
export function cleanupOrphanAutoCreatedCreators(db, creatorIds = []) {
  const removedCreatorIds = []
  const removedAliasIds = []
  if (!identitySchemaReady(db)) return { removedCreatorIds, removedAliasIds }
  const ids = [...new Set((Array.isArray(creatorIds) ? creatorIds : []).map(Number))]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b)
  for (const id of ids) {
    if (!isOrphanAutoImportedCreator(db, id)) continue
    const aliasIds = db
      .prepare('SELECT id FROM creator_aliases WHERE creator_id = ?')
      .all(id)
      .map((row) => Number(row.id))
    db.prepare('DELETE FROM creator_aliases WHERE creator_id = ?').run(id)
    db.prepare('DELETE FROM creators WHERE id = ?').run(id)
    removedCreatorIds.push(id)
    removedAliasIds.push(...aliasIds)
  }
  return { removedCreatorIds, removedAliasIds }
}
