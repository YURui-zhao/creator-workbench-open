import { Router } from 'express'
import db from '../db.js'
import { toPublicDecision } from './creatorDecisions.js'
import {
  buildOutcomeCandidates,
  buildOutcomeLinkEvidence,
  buildOutcomeSummary,
  computeTimingWarning,
  evaluateOutcomeIdentity,
  evaluateOutcomeTiming,
  isDecisionEligibleForOutcome
} from '../utils/creatorDecisionOutcome.js'
import { TARGET_CPM } from '../utils/creatorBusinessRules.js'

/**
 * 决策 ↔ 真实投放结果 关联（V3-alpha P5）
 *
 * 本 router 挂载在与 P4 相同的 `/api/creator-decisions` 前缀下（见 backend/server.js），
 * 只新增三个子路径，不修改 P4 router 的任何既有路由：
 *   GET    /api/creator-decisions/:id/outcome-candidates
 *   POST   /api/creator-decisions/:id/outcome
 *   DELETE /api/creator-decisions/:id/outcome
 *
 * 安全边界：
 *   · 只写 creator_decision_outcomes（关联关系），绝不 UPDATE creator_decisions / creator_records
 *   · 花费 / 播放 / CPM / target 状态一律由后端从 creator_records 实时生成，忽略前端提交的任何派生字段
 *   · 无 AI、无外部网络、无 base64 / Key / provider 数据
 */
const router = Router()

function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, message) {
  res.status(code).json({ code, data: null, msg: message })
}

function parseId(value) {
  const num = Number(value)
  return Number.isInteger(num) && num > 0 ? num : null
}

const findDecision = (id) => db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(id)
const findRecord = (id) => db.prepare('SELECT * FROM creator_records WHERE id = ?').get(id)
const findLinkByDecision = (decisionId) =>
  db.prepare('SELECT * FROM creator_decision_outcomes WHERE decision_id = ?').get(decisionId)
const findLinkByRecord = (recordId) =>
  db.prepare('SELECT * FROM creator_decision_outcomes WHERE record_id = ?').get(recordId)
const findCandidate = (id) =>
  db.prepare('SELECT id, name FROM creator_candidates WHERE id = ?').get(id)
// 同名候选达人数量（>1 表示「名称」不足以唯一确定身份）
const countCandidatesWithName = (name) =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM creator_candidates WHERE name = ?').get(name)?.n ?? 0)

/**
 * Phase 4C：用于匹配投放记录的身份名称
 *   · candidate decision（candidate_id 非空）→ candidate 的「当前」name（改名后仍能匹配新名字的记录）
 *   · 旧历史达人 → 冻结的 decision.creator
 * 找不到 candidate 时回退到 decision.creator（只影响候选池展示，写入仍由 evaluateOutcomeIdentity 严格校验）。
 */
function identityNameForDecision(decision) {
  if (decision?.candidate_id === null || decision?.candidate_id === undefined) {
    return String(decision?.creator ?? '').trim()
  }
  const candidate = findCandidate(decision.candidate_id)
  return String(candidate?.name ?? decision.creator ?? '').trim()
}

/**
 * Phase 4C：outcome 候选记录的「发现名称」集合
 *   · 旧达人：只有 frozen decision.creator（行为完全不变）
 *   · candidate：current candidate.name（primary）+ frozen decision.creator；两者相同则只查一次
 * 只用于「能被用户看到」，绝不等于身份授权（最终仍由 evaluateOutcomeIdentity 判定）。
 */
function discoveryNamesForDecision(decision) {
  const isCandidateDecision = decision?.candidate_id !== null && decision?.candidate_id !== undefined
  const primary = identityNameForDecision(decision)
  const frozen = String(decision?.creator ?? '').trim()
  const names =
    isCandidateDecision && frozen && frozen !== primary ? [primary, frozen] : [primary]
  return {
    names: names.filter(Boolean),
    currentName: isCandidateDecision ? primary || null : null,
    frozenName: frozen
  }
}

/** 按多个名称批量查询投放记录（IN + 同一排序；单名称时与旧查询等价） */
function listCreatorRecordsByNames(names = []) {
  const unique = [...new Set(names.map((name) => String(name ?? '').trim()).filter(Boolean))]
  if (!unique.length) return []
  // 单名称（旧达人 / current === frozen）：完全沿用既有查询，保证旧行为字节不变
  if (unique.length === 1) return listCreatorRecords(unique[0])
  const placeholders = unique.map(() => '?').join(', ')
  return db
    .prepare(
      `SELECT id, nickname, creator_type, total_cost, publish_date, first_play, second_week_play
       FROM creator_records
       WHERE nickname IN (${placeholders})
       ORDER BY publish_date DESC, id DESC`
    )
    .all(...unique)
}

/** 该达人全部投放记录（候选池只含同一 creator，不返回其他达人的记录） */
const listCreatorRecords = (creator) =>
  db
    .prepare(
      `SELECT id, nickname, creator_type, total_cost, publish_date, first_play, second_week_play
       FROM creator_records
       WHERE nickname = ?
       ORDER BY publish_date DESC, id DESC`
    )
    .all(creator)

/** record_id -> decision_id（用于标记 already_linked） */
function loadRecordLinkMap(recordIds = []) {
  const ids = [...new Set(recordIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
  const map = new Map()
  if (!ids.length) return map
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT record_id, decision_id FROM creator_decision_outcomes WHERE record_id IN (${placeholders})`
    )
    .all(...ids)
  for (const row of rows) map.set(row.record_id, row.decision_id)
  return map
}

/**
 * 批量加载若干 decision 的 outcome summary（单条 SQL，避免雷达 / 决策列表 N+1）
 * outcome 的花费 / 播放 / CPM 实时取自 creator_records；decision 证据不受影响。
 * @param {Array<{id: number, target_cpm?: number}>} decisionRows
 * @returns {Map<number, Object>} decision_id -> outcome summary
 */
export function loadOutcomeSummaries(decisionRows = []) {
  const map = new Map()
  const decisions = (Array.isArray(decisionRows) ? decisionRows : []).filter((row) => row && row.id)
  if (!decisions.length) return map
  const targetByDecision = new Map(
    decisions.map((row) => [row.id, Number.isFinite(Number(row.target_cpm)) ? Number(row.target_cpm) : TARGET_CPM])
  )
  const ids = decisions.map((row) => row.id)
  const placeholders = ids.map(() => '?').join(', ')
  // 单条 SQL 直接 JOIN 关联表与投放记录：避免 N+1，也不把结果复制进 link 表
  const rows = db
    .prepare(
      `SELECT o.id AS link_id, o.decision_id AS link_decision_id, o.record_id AS link_record_id,
              o.linked_at AS link_linked_at, o.link_evidence_json AS link_evidence_json,
              r.id AS record_id, r.nickname, r.creator_type, r.total_cost, r.publish_date,
              r.first_play, r.second_week_play
       FROM creator_decision_outcomes o
       JOIN creator_records r ON r.id = o.record_id
       WHERE o.decision_id IN (${placeholders})`
    )
    .all(...ids)
  for (const row of rows) {
    const summary = buildOutcomeSummary(
      {
        id: row.link_id,
        decision_id: row.link_decision_id,
        record_id: row.link_record_id,
        linked_at: row.link_linked_at,
        link_evidence_json: row.link_evidence_json
      },
      { ...row, id: row.record_id },
      { targetCpm: targetByDecision.get(row.link_decision_id) ?? TARGET_CPM }
    )
    if (summary) map.set(row.link_decision_id, summary)
  }
  return map
}

/** 单条 decision 的 outcome summary（无关联返回 null） */
export function loadOutcomeSummaryForDecision(decisionRow) {
  if (!decisionRow || !decisionRow.id) return null
  const link = findLinkByDecision(decisionRow.id)
  if (!link) return null
  const record = findRecord(link.record_id)
  return buildOutcomeSummary(link, record, { targetCpm: decisionRow.target_cpm ?? TARGET_CPM })
}

/**
 * GET /api/creator-decisions/:id/outcome-candidates
 * 返回该 decision 所属达人的真实投放记录（按发布日期倒序），供人工选择关联。
 */
router.get('/:id/outcome-candidates', (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) return fail(res, 400, '非法的决策 ID')
  const decision = findDecision(id)
  if (!decision) return fail(res, 404, `决策 #${id} 不存在`)

  const eligibility = isDecisionEligibleForOutcome(decision)
  // Phase 4C：candidate 决策同时发现「当前 name」与「创建时 frozen name」两组记录（跨名称确认路径可见）；
  // 旧达人仍只查冻结的 decision.creator（discoveryNamesForDecision 内部保证）。
  const discovery = discoveryNamesForDecision(decision)
  const records = listCreatorRecordsByNames(discovery.names)
  const linkMap = loadRecordLinkMap(records.map((row) => row.id))
  const candidates = buildOutcomeCandidates(records, {
    decisionCreatedAt: decision.created_at,
    decisionDecidedAt: decision.decided_at ?? null,
    linkMap
  })
  // Phase 4E：为每条记录附加只读「预检查」元数据，帮助 UI 提前提示需要哪些人工确认。
  // 注意：这只是 UI 提示，最终 authorization 仍由 POST outcome 重新完整校验，绝不因为 GET 通过而跳过。
  const isCandidateDecision = decision.candidate_id !== null && decision.candidate_id !== undefined
  const candidateRow = isCandidateDecision ? findCandidate(decision.candidate_id) : null
  const currentCandidateName = candidateRow?.name ?? null
  const precheckAmbiguous =
    isCandidateDecision && currentCandidateName ? countCandidatesWithName(currentCandidateName) > 1 : false
  const candidatesWithPrecheck = candidates.map((item) => {
    const recordRow = records.find((row) => row.id === item.record_id)
    const identityPrecheck = evaluateOutcomeIdentity({
      candidateId: decision.candidate_id,
      candidateName: currentCandidateName,
      frozenCreator: String(decision.creator ?? ''),
      recordNickname: recordRow?.nickname ?? '',
      recordId: item.record_id,
      identityConfirmed: false,
      candidateNameAmbiguous: precheckAmbiguous
    })
    const timingPrecheck = evaluateOutcomeTiming({
      publishDate: recordRow?.publish_date,
      decisionDecidedAt: decision.decided_at ?? null,
      decisionCreatedAt: decision.created_at,
      timingConfirmed: false
    })
    return {
      ...item,
      requires_identity_confirmation: identityPrecheck.ok === false,
      identity_reason:
        identityPrecheck.ok === false
          ? identityPrecheck.nameMatch
            ? 'ambiguous_name'
            : 'name_mismatch'
          : null,
      requires_timing_confirmation: timingPrecheck.confirmationRequired === true,
      timing_reason: !timingPrecheck.confirmationRequired
        ? null
        : timingPrecheck.businessDateMissing === true
          ? 'business_date_missing'
          : 'publish_before_decision'
    }
  })
  // 仅对 candidate 决策附加可解释 metadata（旧达人响应保持原样）；
  // 这只是「记录从哪个名称被发现」，绝不表示身份已确认。
  const enrichedCandidates =
    discovery.currentName === null
      ? candidatesWithPrecheck
      : candidatesWithPrecheck.map((item) => {
          const matchesCurrent = item.creator === discovery.currentName
          const matchesFrozen = item.creator === discovery.frozenName
          const source =
            matchesCurrent && matchesFrozen ? 'both' : matchesCurrent ? 'current' : 'frozen'
          return { ...item, identity_name_source: source }
        })
  ok(res, {
    decision_id: decision.id,
    creator: decision.creator,
    eligible: eligibility.eligible,
    eligibility_reason: eligibility.reason,
    candidates: enrichedCandidates
  })
})

/**
 * POST /api/creator-decisions/:id/outcome
 * body: { record_id, timing_confirmed? }
 * 只接受关联关系；花费 / 播放 / CPM / target 状态全部由后端实时生成。
 */
router.post('/:id/outcome', (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) return fail(res, 400, '非法的决策 ID')
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const recordId = parseId(body.record_id)
  if (recordId === null) return fail(res, 400, 'record_id 必须是正整数')

  const decision = findDecision(id)
  if (!decision) return fail(res, 404, `决策 #${id} 不存在`)

  const eligibility = isDecisionEligibleForOutcome(decision)
  if (!eligibility.eligible) return fail(res, 400, eligibility.reason)

  const record = findRecord(recordId)
  if (!record) return fail(res, 404, `投放记录 #${recordId} 不存在`)

  // Phase 4C：身份校验统一走 evaluateOutcomeIdentity（旧达人 / candidate 两条路径严格分开）
  //   · 旧达人（candidate_id=NULL）：仍要求 record.nickname === decision.creator，
  //     identity_confirmed 对其完全无效（不能成为绕过所有名称校验的万能开关）
  //   · candidate（candidate_id 非空）：按 candidate「当前」name 校验（改名后仍可关联），
  //     名称不同时默认 409，只有显式 identity_confirmed=true 才放行
  const isCandidateDecision = decision.candidate_id !== null && decision.candidate_id !== undefined
  let candidateName = null
  let candidateNameAmbiguous = false
  if (isCandidateDecision) {
    const candidate = findCandidate(decision.candidate_id)
    if (!candidate) {
      return fail(res, 400, `决策 #${id} 关联的候选达人 #${decision.candidate_id} 不存在`)
    }
    candidateName = candidate.name
    // 同名候选达人（>1）：名称一致也不足以证明归属，必须显式确认
    candidateNameAmbiguous = countCandidatesWithName(candidateName) > 1
  }
  const identity = evaluateOutcomeIdentity({
    candidateId: decision.candidate_id,
    candidateName,
    frozenCreator: String(decision.creator ?? ''),
    recordNickname: record.nickname,
    recordId,
    identityConfirmed: body.identity_confirmed === true,
    candidateNameAmbiguous
  })
  if (!identity.ok) {
    // candidate 跨名称：附带结构化标记，供前端做「人工身份确认」交互（不是自动判断同一达人）
    if (identity.requiresIdentityConfirmation) {
      return res.status(identity.code).json({
        code: identity.code,
        data: { requires_identity_confirmation: true },
        msg: identity.message
      })
    }
    return fail(res, identity.code, identity.message)
  }

  // Phase 4E：timing 评估（与既有规则完全一致；identity / timing 永久独立）
  const timing = evaluateOutcomeTiming({
    publishDate: record.publish_date,
    decisionDecidedAt: decision.decided_at ?? null,
    decisionCreatedAt: decision.created_at,
    timingConfirmed: body.timing_confirmed === true
  })
  const identityConfirmationProvided = body.identity_confirmed === true
  const timingConfirmationProvided = body.timing_confirmed === true

  const existingForDecision = findLinkByDecision(id)
  if (existingForDecision) {
    return fail(res, 409, `决策 #${id} 已关联投放记录 #${existingForDecision.record_id}，请先解除关联`)
  }
  const existingForRecord = findLinkByRecord(recordId)
  if (existingForRecord) {
    return fail(res, 409, `投放记录 #${recordId} 已关联决策 #${existingForRecord.decision_id}，不能重复关联`)
  }

  // Semantic Duplicate V0.2：同一真实事件不能被两种来源的谈价案例共同指向。
  //   该决策已有 live case，且该投放记录已有 historical_backfill case
  //   → 关联会把它俩连成同一次现实事件（Single Source of Truth 冲突）→ 409，绝不自动合并 / 删除。
  const liveCaseForDecision = db
    .prepare(
      `SELECT id FROM creator_negotiation_cases
       WHERE decision_id = ? AND source_type = 'live'`
    )
    .get(id)
  const historicalCaseForRecord = db
    .prepare(
      `SELECT id FROM creator_negotiation_cases
       WHERE record_id = ? AND source_type = 'historical_backfill'`
    )
    .get(recordId)
  if (liveCaseForDecision && historicalCaseForRecord) {
    return fail(
      res,
      409,
      '该决策已有实时谈价案例，且该投放记录已有历史补录谈价案例；两者指向同一次真实谈价，请先确认保留哪一个来源（系统不会自动合并）。'
    )
  }

  if (timing.confirmationRequired && !timing.confirmationProvided) {
    return fail(
      res,
      400,
      '该投放记录的发布日期早于本次决策记录，请确认是否关联正确（需 timing_confirmed=true）'
    )
  }

  // 冻结「为什么允许这条关联」——与 outcome 插入在同一事务中，二者要么都成功、要么都不写
  const linkEvidence = buildOutcomeLinkEvidence({
    candidateId: decision.candidate_id ?? null,
    frozenDecisionCreator: String(decision.creator ?? ''),
    candidateNameAtLink: candidateName,
    recordNickname: record.nickname ?? null,
    identity,
    identityConfirmationProvided,
    timing,
    timingConfirmationProvided
  })

  // 校验 + INSERT 放在同一事务，避免检查后状态变化；UNIQUE 约束是并发下的最终保护。
  let link
  try {
    link = db.transaction(() => {
      if (findLinkByDecision(id)) {
        const error = new Error('decision-already-linked')
        error.code = 'DECISION_LINKED'
        throw error
      }
      if (findLinkByRecord(recordId)) {
        const error = new Error('record-already-linked')
        error.code = 'RECORD_LINKED'
        throw error
      }
      const info = db
        .prepare(
          'INSERT INTO creator_decision_outcomes (decision_id, record_id, link_evidence_json) VALUES (?, ?, ?)'
        )
        .run(id, recordId, JSON.stringify(linkEvidence))
      return db.prepare('SELECT * FROM creator_decision_outcomes WHERE id = ?').get(info.lastInsertRowid)
    })()
  } catch (error) {
    if (error?.code === 'DECISION_LINKED' || error?.code === 'RECORD_LINKED') {
      return fail(res, 409, '该决策或该投放记录已被关联，请刷新后重试')
    }
    if (String(error?.message || '').includes('UNIQUE')) {
      return fail(res, 409, '该决策或该投放记录已被关联，请刷新后重试')
    }
    throw error
  }

  const freshDecision = findDecision(id)
  ok(res, {
    decision: toPublicDecision(freshDecision, loadOutcomeSummaryForDecision(freshDecision)),
    outcome: loadOutcomeSummaryForDecision(freshDecision)
  })
})

/**
 * DELETE /api/creator-decisions/:id/outcome
 * 只删除 creator_decision_outcomes 中的一条映射；不触碰 creator_decisions / creator_records。
 */
router.delete('/:id/outcome', (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) return fail(res, 400, '非法的决策 ID')
  const decision = findDecision(id)
  if (!decision) return fail(res, 404, `决策 #${id} 不存在`)
  const link = findLinkByDecision(id)
  if (!link) return fail(res, 404, `决策 #${id} 尚未关联投放结果`)

  db.prepare('DELETE FROM creator_decision_outcomes WHERE id = ?').run(link.id)

  const freshDecision = findDecision(id)
  ok(res, {
    decision: toPublicDecision(freshDecision, null),
    outcome: null,
    unlinked_record_id: link.record_id
  })
})

export default router
