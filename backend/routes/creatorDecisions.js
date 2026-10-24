import { Router } from 'express'
import db from '../db.js'
import { buildRepurchaseRadar } from './records.js'
import { parsePriceText } from '../utils/screenshotValues.js'
import { computeCreatorPricing } from '../utils/creatorPricing.js'
import { assessCurrentQuote } from '../utils/currentQuoteAssessment.js'
import { loadOutcomeSummaries } from './creatorDecisionOutcomes.js'
import { loadNegotiationCaseSummaries } from './creatorNegotiationCases.js'
import { recordCalibrationCorrection, listCalibrationCorrections } from './creatorCalibrationAudit.js'
import { isValidDateOnly, todayLocalDateOnly } from '../utils/businessDate.js'
import { PRICING_VERSION, TARGET_CPM } from '../utils/creatorBusinessRules.js'
// Creator Identity V1 Phase 4：legacy 决策补归属锚（显式 creator_id 优先 / strict 唯一才自动归属）
import {
  creatorIdentityErrorData,
  describeCreatorsByIds,
  identitySchemaReady,
  identityTableHasColumn,
  resolveCreatorIdFromText,
  validateExplicitCreatorId
} from '../utils/creatorIdentity.js'

const router = Router()

export const DECISION_STAGES = ['contact', 'post_quote']
export const CONTACT_DECISIONS = ['contact_now', 'observe', 'skip_for_now']
export const POST_QUOTE_DECISIONS = ['repurchase', 'small_test', 'negotiate', 'pause']
// Phase 4B：候选达人判断阶段（独立 workflow context，不改动上面三个既有 enum）
export const CANDIDATE_REVIEW_STAGE = 'candidate_review'
export const CANDIDATE_REVIEW_DECISIONS = ['contact', 'observe', 'hold']
// Phase 4D：candidate 的 post_quote 阶段（candidate 第一次投放，用 proceed 取代语义错误的 repurchase）
export const CANDIDATE_POST_QUOTE_DECISIONS = ['proceed', 'small_test', 'negotiate', 'pause']
export const IP_JUDGEMENTS = ['strong', 'medium', 'weak', 'unknown']
export const SYSTEM_CONTEXT_VERSION = 'decision-context-v1'
// Phase 4B：候选 decision 的版本标识（不冒充旧 creator-pricing-v1 / decision-context-v1）
export const CANDIDATE_REVIEW_PRICING_VERSION = 'creator-playbook-pricing-v0.1'
export const CANDIDATE_REVIEW_SYSTEM_CONTEXT_VERSION = 'candidate-review-v0.1'
// Phase 4D：候选报价阶段决策的版本标识
export const CANDIDATE_POST_QUOTE_PRICING_VERSION = 'creator-playbook-postquote-v0.1'
export const CANDIDATE_POST_QUOTE_SYSTEM_CONTEXT_VERSION = 'candidate-postquote-v0.1'
export const MAX_NOTE_LENGTH = 500
export const MAX_QUOTE_RAW_LENGTH = 60

export const HUMAN_DECISION_LABELS = {
  contact_now: '开始建联',
  observe: '继续观察',
  skip_for_now: '暂不联系',
  repurchase: '复投',
  small_test: '小额测试',
  negotiate: '继续议价',
  pause: '暂缓',
  // Phase 4B：candidate_review 的三个决定（与旧 contact_now / skip_for_now 语义不同）
  contact: '继续联系',
  hold: '暂不推进',
  // Phase 4D：candidate post_quote 的「直接推进」（旧历史达人仍用 repurchase）
  proceed: '直接推进'
}

export const IP_JUDGEMENT_LABELS = {
  strong: '明显',
  medium: '一般',
  weak: '较弱',
  unknown: '未判断'
}

function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, message) {
  res.status(code).json({ code, data: null, msg: message })
}

const findCreatorRecord = (creator) =>
  db.prepare('SELECT nickname FROM creator_records WHERE nickname = ? LIMIT 1').get(creator)

/**
 * Decision 业务时间统一排序（Real Data Calibration V1 唯一口径）：
 *   COALESCE(decided_at, date(created_at)) DESC, id DESC
 * 只有 legacy NULL decided_at 才 fallback 到录入日期；id 永远是稳定 tie-break。
 * 禁止任何消费点直接用 created_at 判断业务先后。
 */
export const DECISION_BUSINESS_ORDER_SQL =
  'ORDER BY COALESCE(decided_at, date(created_at)) DESC, id DESC'

const DECISION_SUMMARY_COLUMNS =
  'id, creator, decided_at, created_at, voided_at, decision_stage, current_quote, ip_judgement, human_decision, pricing_version, target_cpm'

/**
 * 决策轻量 summary（雷达 Popover 用，不含 evidence JSON）
 * @param {Object} row
 * @param {Object|null} [outcome] P5 关联的真实投放结果轻量事实（无关联为 null）
 */
export function toDecisionSummary(row, outcome = null) {
  if (!row) return null
  return {
    id: row.id,
    decided_at: row.decided_at ?? null,
    created_at: row.created_at,
    voided_at: row.voided_at ?? null,
    decision_stage: row.decision_stage,
    current_quote: row.current_quote ?? null,
    ip_judgement: row.ip_judgement ?? null,
    human_decision: row.human_decision,
    human_decision_label: HUMAN_DECISION_LABELS[row.human_decision] || row.human_decision,
    pricing_version: row.pricing_version,
    // P5：只读展示「是否已关联投放结果 / CPM30 状态」，不参与 P1 分组与排序
    outcome: outcome ?? null
  }
}

/**
 * 批量读取多个达人的最新决策 summary（单条 SQL，radar 一次请求即可展示，无 N+1）
 * @param {string[]} creatorList
 * @returns {Map<string, Object>} creator -> summary
 */
export function loadLatestDecisionSummaries(creatorList = []) {
  const creators = [
    ...new Set(
      (Array.isArray(creatorList) ? creatorList : [])
        .map((item) => String(item ?? '').trim())
        .filter(Boolean)
    )
  ]
  const map = new Map()
  if (!creators.length) return map
  const placeholders = creators.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT ${DECISION_SUMMARY_COLUMNS}
       FROM creator_decisions
       WHERE creator IN (${placeholders})
         AND voided_at IS NULL
       ${DECISION_BUSINESS_ORDER_SQL}`
    )
    .all(...creators)
  // 每位达人只保留最近一条决策，再一次性批量补齐 outcome（单条 JOIN SQL，无 N+1）
  const latestByCreator = new Map()
  for (const row of rows) {
    if (!latestByCreator.has(row.creator)) latestByCreator.set(row.creator, row)
  }
  const latestRows = [...latestByCreator.values()]
  const outcomeMap = loadOutcomeSummaries(latestRows)
  for (const row of latestRows) {
    map.set(row.creator, toDecisionSummary(row, outcomeMap.get(row.id) || null))
  }
  return map
}

/**
 * Creator Identity V1 Phase 5：按 creator_id 批量读取最近一次决策 summary（单条 SQL，无 N+1）。
 * 与 loadLatestDecisionSummaries 同一序列化 / outcome 补齐逻辑，只把关联键换成归属锚 creator_id。
 * @param {number[]} creatorIds
 * @returns {Map<number, Object>} creator_id -> summary
 */
export function loadLatestDecisionSummariesByCreatorId(creatorIds = []) {
  const ids = [
    ...new Set(
      (Array.isArray(creatorIds) ? creatorIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  ]
  const map = new Map()
  if (!ids.length) return map
  if (!identitySchemaReady(db) || !identityTableHasColumn(db, 'creator_decisions', 'creator_id')) {
    return map
  }
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT ${DECISION_SUMMARY_COLUMNS}, creator_id
       FROM creator_decisions
       WHERE creator_id IN (${placeholders})
         AND voided_at IS NULL
       ${DECISION_BUSINESS_ORDER_SQL}`
    )
    .all(...ids)
  // 每位 Creator 只保留最近一条决策，再一次性批量补齐 outcome
  const latestByCreator = new Map()
  for (const row of rows) {
    const id = Number(row.creator_id)
    if (!latestByCreator.has(id)) latestByCreator.set(id, row)
  }
  const latestRows = [...latestByCreator.values()]
  const outcomeMap = loadOutcomeSummaries(latestRows)
  for (const [id, row] of latestByCreator.entries()) {
    map.set(id, toDecisionSummary(row, outcomeMap.get(row.id) || null))
  }
  return map
}

const findSnapshotRow = (snapshotId) =>
  db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(snapshotId)

/**
 * 固化「当时的历史证据」：复用 P1 完全相同的纯函数与字段定义（不复制任何 P1 逻辑）。
 * 只读取该达人的投放记录 → buildRepurchaseRadar → 取该达人条目。
 */
export function buildHistoricalEvidence(creator, { referenceDate = null } = {}) {
  const rows = db
    .prepare(
      `SELECT time_cycle, nickname, creator_type, total_cost, first_play, second_week_play, publish_date
       FROM creator_records
       WHERE nickname = ?
       ORDER BY time_cycle ASC, id ASC`
    )
    .all(creator)
  if (!rows.length) return null
  const radar = buildRepurchaseRadar(rows, { referenceDate })
  const entry = radar.groups.flatMap((group) => group.creators).find((item) => item.creator === creator)
  if (!entry) return null
  return {
    record_count: entry.record_count,
    valid_cpm_count: entry.valid_cpm_count,
    pass_count: entry.pass_count,
    fail_count: entry.fail_count,
    historical_status: entry.historical_status,
    historical_status_label: entry.historical_status_label,
    median_cpm: entry.median_cpm,
    recent_risk: entry.recent_risk,
    last_collaboration_date: entry.last_collaboration_date,
    days_since_last_collaboration: entry.days_since_last_collaboration,
    target_cpm: entry ? TARGET_CPM : null
  }
}

/** 固化近期证据：完全来自该 snapshot 行，不重新计算 P2B 统计 */
export function buildRecentEvidence(snapshotRow) {
  if (!snapshotRow) return null
  return {
    snapshot_id: snapshotRow.id,
    stats_version: snapshotRow.stats_version,
    created_at: snapshotRow.created_at,
    // Alpha.2：数据观察日期同样作为事实冻结进证据（旧快照为 null）
    observed_at: snapshotRow.observed_at ?? null,
    valid_count: snapshotRow.valid_count,
    median_play: snapshotRow.median_play ?? null,
    p25_play: snapshotRow.p25_play ?? null,
    p75_play: snapshotRow.p75_play ?? null,
    trend_label: snapshotRow.trend_label ?? null,
    xingtu_price: snapshotRow.xingtu_price ?? null
  }
}

/** snapshot 的 P3 星图 pricing（同一套 P3 函数） */
export function buildXingtuPricing(snapshotRow) {
  if (!snapshotRow) return null
  return computeCreatorPricing({
    stats_status: snapshotRow.stats_status,
    median_play: snapshotRow.median_play,
    p25_play: snapshotRow.p25_play,
    p75_play: snapshotRow.p75_play,
    xingtu_price: snapshotRow.xingtu_price ?? null
  })
}

/**
 * 实际报价评估：只做「事实折扣 + 与 CPM30 的差额 + 状态」，
 * 不再把 current_quote 当成新的折扣基准重新跑 P3 谈价区间。
 */
export function buildCurrentQuoteAssessment(snapshotRow, currentQuote) {
  const xingtuPricing = buildXingtuPricing(snapshotRow)
  return assessCurrentQuote({
    currentQuote,
    xingtuPrice: snapshotRow?.xingtu_price ?? null,
    targetPrice: xingtuPricing?.target_price ?? null,
    referenceHigh: xingtuPricing?.reference_high ?? null
  })
}

const toOptionalText = (value, maxLength, field, errors) => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    errors.push(`${field} 必须是字符串`)
    return null
  }
  const text = value.trim()
  if (text === '') return null
  if (text.length > maxLength) {
    errors.push(`${field} 长度不能超过 ${maxLength}`)
    return null
  }
  return text
}

/**
 * 校验决策请求：只接受「人的输入」，authoritative 证据一律由后端重建
 * @returns {{ok: true, value: Object} | {ok: false, message: string}}
 */
export function validateDecisionPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: '请求体必须是对象' }
  }
  const errors = []

  const creator = typeof body.creator === 'string' ? body.creator.trim() : ''
  if (!creator) return { ok: false, message: 'creator 不能为空' }
  if (creator.length > 100) return { ok: false, message: 'creator 长度不能超过 100' }

  const decisionStage = String(body.decision_stage ?? '').trim()
  if (!DECISION_STAGES.includes(decisionStage)) {
    return { ok: false, message: `decision_stage 必须为：${DECISION_STAGES.join(' / ')}` }
  }

  const ipJudgementRaw = body.ip_judgement === null || body.ip_judgement === undefined
    ? 'unknown'
    : String(body.ip_judgement).trim()
  if (!IP_JUDGEMENTS.includes(ipJudgementRaw)) {
    return { ok: false, message: `ip_judgement 必须为：${IP_JUDGEMENTS.join(' / ')}` }
  }

  const humanDecision = String(body.human_decision ?? '').trim()
  const allowedDecisions =
    decisionStage === 'contact' ? CONTACT_DECISIONS : POST_QUOTE_DECISIONS
  if (!allowedDecisions.includes(humanDecision)) {
    return {
      ok: false,
      message: `${decisionStage} 阶段的 human_decision 必须为：${allowedDecisions.join(' / ')}`
    }
  }

  const decisionNote = toOptionalText(body.decision_note, MAX_NOTE_LENGTH, 'decision_note', errors)
  const currentQuoteRaw = toOptionalText(
    body.current_quote_raw,
    MAX_QUOTE_RAW_LENGTH,
    'current_quote_raw',
    errors
  )
  if (errors.length) return { ok: false, message: errors[0] }

  let snapshotId = null
  if (body.snapshot_id !== null && body.snapshot_id !== undefined && body.snapshot_id !== '') {
    const num = Number(body.snapshot_id)
    if (!Number.isInteger(num) || num <= 0) {
      return { ok: false, message: 'snapshot_id 必须是正整数' }
    }
    snapshotId = num
  }

  // contact 阶段不允许带入实际报价（避免把商务报价混进联系前决策）
  if (decisionStage === 'contact' && currentQuoteRaw !== null) {
    return { ok: false, message: 'contact 阶段不允许填写实际报价' }
  }
  if (decisionStage === 'post_quote') {
    if (snapshotId === null) {
      return { ok: false, message: 'post_quote 阶段必须提供 snapshot_id（需要近期表现作为价格判断基础）' }
    }
    if (currentQuoteRaw === null) {
      return { ok: false, message: 'post_quote 阶段必须填写实际报价（current_quote_raw）' }
    }
  }

  // Real Data Calibration V1：业务决策日期（decided_at）
  //   · 未提供 → 默认「今天」（正常录入；created_at 仍单独记录真实录入时间）
  //   · 提供 → 必须是合法 YYYY-MM-DD，且不得晚于今天（历史补录填真实过去日期）
  //   · 旧决策保持 NULL，绝不自动回填 created_at
  const rawDecidedAt = body.decided_at === null || body.decided_at === undefined ? '' : String(body.decided_at).trim()
  const decidedAt = rawDecidedAt === '' ? todayLocalDateOnly() : rawDecidedAt
  if (!isValidDateOnly(decidedAt)) {
    return { ok: false, message: '业务决策日期（decided_at）必须是真实存在的日期，格式为 YYYY-MM-DD' }
  }
  if (decidedAt > todayLocalDateOnly()) {
    return { ok: false, message: '业务决策日期（decided_at）不能晚于今天' }
  }

  return {
    ok: true,
    value: {
      creator,
      decisionStage,
      snapshotId,
      currentQuoteRaw,
      ipJudgement: ipJudgementRaw,
      humanDecision,
      decisionNote,
      decidedAt
    }
  }
}

/**
 * 数据库行 -> 对外 decision（evidence 为创建时固化的 JSON）
 * @param {Object} row
 * @param {Object|null} [outcome] P5 关联的真实投放结果（live 事实；无关联为 null）
 * @param {Object|null} [negotiationCase] A4 谈价结果（append-only 事实；无记录为 null）
 */
export function toPublicDecision(row, outcome = null, negotiationCase = null) {
  if (!row) return null
  const parseJson = (text) => {
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  return {
    id: row.id,
    creator: row.creator,
    // Phase 4B：候选达人稳定身份（旧历史达人决策为 null）
    candidate_id: row.candidate_id ?? null,
    decision_stage: row.decision_stage,
    snapshot_id: row.snapshot_id ?? null,
    current_quote_raw: row.current_quote_raw ?? null,
    current_quote: row.current_quote ?? null,
    ip_judgement: row.ip_judgement ?? null,
    human_decision: row.human_decision,
    human_decision_label: HUMAN_DECISION_LABELS[row.human_decision] || row.human_decision,
    decision_note: row.decision_note ?? null,
    historical_evidence: parseJson(row.historical_evidence_json),
    recent_evidence: parseJson(row.recent_evidence_json),
    pricing_evidence: parseJson(row.pricing_evidence_json),
    target_cpm: row.target_cpm,
    pricing_version: row.pricing_version,
    system_context_version: row.system_context_version,
    // Real Data Calibration V1：业务决策日期与录入时间严格分开（legacy 旧行 decided_at = NULL）
    decided_at: row.decided_at ?? null,
    created_at: row.created_at,
    // VOID（不 hard delete）：作废后不参与 latest / 业务排序，但仍可在历史中查看
    voided_at: row.voided_at ?? null,
    void_reason: row.void_reason ?? null,
    // P5：真实投放结果（live，不固化）；evidence 仍为创建时的 frozen 快照
    outcome: outcome ?? null,
    // A4：谈价结果（append-only，创建时冻结当时的谈判上下文）
    negotiation_case: negotiationCase ?? null
  }
}

/** 创建时的公共前置校验：creator 存在；snapshot 存在且属于该 creator */
function resolveContext(value) {
  if (!findCreatorRecord(value.creator)) {
    return { ok: false, message: `达人「${value.creator}」不存在于当前投放记录中` }
  }
  let snapshotRow = null
  if (value.snapshotId !== null) {
    snapshotRow = findSnapshotRow(value.snapshotId)
    if (!snapshotRow) {
      return { ok: false, message: `近期表现快照 #${value.snapshotId} 不存在` }
    }
    if (snapshotRow.creator !== value.creator) {
      return {
        ok: false,
        message: `快照 #${value.snapshotId} 属于「${snapshotRow.creator}」，不能绑定给「${value.creator}」`
      }
    }
  }
  return { ok: true, snapshotRow }
}

/**
 * POST /api/creator-decisions/preview（只读、无写库、无 AI）
 * 展示星图 pricing + 实际报价评估（折扣锚定星图刊例价，前端不复制公式）
 */
router.post('/preview', (req, res) => {
  const body = req.body && !Array.isArray(req.body) ? req.body : {}
  const creator = String(body.creator ?? '').trim()
  if (!creator) return fail(res, 400, 'creator 不能为空')
  const snapshotId = Number(body.snapshot_id)
  if (!Number.isInteger(snapshotId) || snapshotId <= 0) {
    return fail(res, 400, 'snapshot_id 必须是正整数')
  }
  const context = resolveContext({ creator, snapshotId })
  if (!context.ok) return fail(res, 400, context.message)

  const parsed = parsePriceText(body.current_quote_raw)
  if (parsed.value === null) {
    return fail(res, 400, '实际报价无法确定性解析，请按「¥2400 / 2400元 / 2,400」等形式填写')
  }

  ok(res, {
    creator,
    snapshot_id: snapshotId,
    current_quote_raw: parsed.raw_text,
    current_quote: parsed.value,
    xingtu_price: context.snapshotRow.xingtu_price ?? null,
    xingtu_pricing: buildXingtuPricing(context.snapshotRow),
    current_quote_assessment: buildCurrentQuoteAssessment(context.snapshotRow, parsed.value)
  })
})

/**
 * POST /api/creator-decisions
 * append-only 创建决策：证据 / target_cpm / pricing_version 全部由后端重建并固化
 */
router.post('/', (req, res) => {
  const validated = validateDecisionPayload(req.body)
  if (!validated.ok) return fail(res, 400, validated.message)
  const value = validated.value

  const context = resolveContext(value)
  if (!context.ok) return fail(res, 400, context.message)
  const { snapshotRow } = context

  const historicalEvidence = buildHistoricalEvidence(value.creator)
  if (!historicalEvidence) {
    return fail(res, 400, `达人「${value.creator}」缺少可用于决策的历史投放记录`)
  }

  let currentQuote = null
  let pricingEvidence = null
  if (value.decisionStage === 'post_quote') {
    const parsed = parsePriceText(value.currentQuoteRaw)
    if (parsed.value === null) {
      return fail(res, 400, '实际报价无法确定性解析，请按「¥2400 / 2400元 / 2,400」等形式填写')
    }
    currentQuote = parsed.value
    pricingEvidence = {
      xingtu_pricing: buildXingtuPricing(snapshotRow),
      current_quote_assessment: buildCurrentQuoteAssessment(snapshotRow, currentQuote)
    }
  } else {
    // contact：只固化当时星图 pricing（无 snapshot 时为 null）
    pricingEvidence = {
      xingtu_pricing: buildXingtuPricing(snapshotRow),
      current_quote_assessment: null
    }
  }

  // Creator Identity Phase 4：legacy 决策（Radar 入口）归属锚
  //   显式 creator_id 优先；否则 strict alias 唯一才自动归属；N → 409（歧义不猜）；0 → 不临时造人（NULL）
  const decisionBody = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  let creatorId = null
  const decisionIdentityWritable =
    identitySchemaReady(db) && identityTableHasColumn(db, 'creator_decisions', 'creator_id')
  if (decisionIdentityWritable) {
    const explicitProvided =
      decisionBody.creator_id !== undefined &&
      decisionBody.creator_id !== null &&
      String(decisionBody.creator_id).trim() !== ''
    if (explicitProvided) {
      const explicit = validateExplicitCreatorId(db, decisionBody.creator_id)
      if (!explicit.ok) {
        // 稳定机器可读契约：reason = invalid_id / not_found / merged / schema_missing
        return res.status(400).json({
          code: 400,
          data: creatorIdentityErrorData(explicit.reason, {
            creator_id: explicit.creatorId ?? null
          }),
          msg: explicit.error
        })
      }
      creatorId = explicit.creatorId
    } else {
      const resolved = resolveCreatorIdFromText(db, value.creator)
      if (resolved.reason === 'ambiguous') {
        // 身份歧义：绝不 take first match，也不落库；返回 matches 供显式选择 creator_id
        return res.status(409).json({
          code: 409,
          data: creatorIdentityErrorData('ambiguous', {
            creator_text: value.creator,
            normalized: resolved.normalized,
            matches: describeCreatorsByIds(db, resolved.creatorIds)
          }),
          msg: `达人名称「${value.creator}」对应多个 Creator（身份歧义），请先明确归属（传 creator_id）后再创建决策`
        })
      }
      creatorId = resolved.creatorId
    }
  }

  const decisionColumns = [
    'creator',
    'decision_stage',
    'snapshot_id',
    'current_quote_raw',
    'current_quote',
    'ip_judgement',
    'human_decision',
    'decision_note',
    'historical_evidence_json',
    'recent_evidence_json',
    'pricing_evidence_json',
    'target_cpm',
    'pricing_version',
    'system_context_version',
    'decided_at'
  ]
  const decisionValues = [
    value.creator,
    value.decisionStage,
    value.snapshotId,
    value.currentQuoteRaw,
    currentQuote,
    value.ipJudgement,
    value.humanDecision,
    value.decisionNote,
    JSON.stringify(historicalEvidence),
    snapshotRow ? JSON.stringify(buildRecentEvidence(snapshotRow)) : null,
    pricingEvidence ? JSON.stringify(pricingEvidence) : null,
    TARGET_CPM,
    PRICING_VERSION,
    SYSTEM_CONTEXT_VERSION,
    value.decidedAt
  ]
  if (decisionIdentityWritable) {
    decisionColumns.push('creator_id')
    decisionValues.push(creatorId)
  }

  const info = db
    .prepare(
      `INSERT INTO creator_decisions (${decisionColumns.join(', ')})
       VALUES (${decisionColumns.map(() => '?').join(', ')})`
    )
    .run(...decisionValues)

  const saved = db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(info.lastInsertRowid)
  // 新创建的决策必然还没有 outcome 关联（append-only，关联是后续独立动作）
  ok(res, toPublicDecision(saved, null))
})

/**
 * GET /api/creator-decisions?creator=...
 * 业务时间倒序（COALESCE(decided_at, date(created_at)) DESC, id DESC），固定返回创建时固化的证据；
 * P5：附带 outcome（live 事实，单条 SQL 批量加载，避免 N+1）
 * Real Data Calibration V1：历史包含已作废决策（voided_at 非空），由前端标记「已作废」；
 * latest / 业务排序的排除由 loadLatestDecisionSummaries* 负责。
 */
router.get('/', (req, res) => {
  const creator = String(req.query?.creator ?? '').trim()
  // Creator Identity V1 Phase 5：可选 creator_id（归属锚）——提供时优先按身份关联，
  // 同名不同人绝不串决策历史；未提供时保持原有 creator 文本查询（legacy 兼容）。
  const rawCreatorId = req.query?.creator_id
  let creatorId = null
  if (rawCreatorId !== undefined && rawCreatorId !== null && String(rawCreatorId).trim() !== '') {
    const parsed = Number(rawCreatorId)
    if (!Number.isInteger(parsed) || parsed <= 0) return fail(res, 400, 'creator_id 必须是正整数')
    creatorId = parsed
  }
  if (!creator && creatorId === null) return fail(res, 400, 'creator 不能为空')
  if (creator.length > 100) return fail(res, 400, 'creator 长度不能超过 100')
  const identityUsable =
    creatorId !== null &&
    identitySchemaReady(db) &&
    identityTableHasColumn(db, 'creator_decisions', 'creator_id')
  const rows = identityUsable
    ? db
        .prepare(
          `SELECT * FROM creator_decisions
           WHERE creator_id = ?
           ${DECISION_BUSINESS_ORDER_SQL}`
        )
        .all(creatorId)
    : db
        .prepare(
          `SELECT * FROM creator_decisions
           WHERE creator = ?
           ${DECISION_BUSINESS_ORDER_SQL}`
        )
        .all(creator)
  const outcomeMap = loadOutcomeSummaries(rows)
  // A4：同一次请求附带谈价结果（单条 SQL，避免前端 N+1）
  const negotiationMap = loadNegotiationCaseSummaries(rows)
  ok(res, {
    creator: creator || null,
    creator_id: identityUsable ? creatorId : null,
    decisions: rows.map((row) =>
      toPublicDecision(row, outcomeMap.get(row.id) || null, negotiationMap.get(row.id) || null)
    )
  })
})

// ---------- Real Data Calibration V1：业务日期纠正 / 决策作废（append-only 审计） ----------

function parseDecisionId(value) {
  const num = Number(value)
  return Number.isInteger(num) && num > 0 ? num : null
}

const findDecisionById = (id) => db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(id)

/** 纠正原因：人工必填，去空白，最长 500（与 decision_note 同一上限） */
function readCalibrationReason(value, errors) {
  const reason = toOptionalText(value, MAX_NOTE_LENGTH, 'reason', errors)
  if (!errors.length && !reason) errors.push('reason 必填')
  return reason
}

/**
 * PATCH /api/creator-decisions/:id/date
 * body: { decided_at, reason }
 * 只纠正业务日期（decided_at）：
 *   · created_at / creator_id / decision_id / 证据 / 关联一律不改
 *   · 每次纠正追加 before / after / reason 审计，不得无痕覆盖
 *   · 已作废决策不允许再纠正
 */
router.patch('/:id/date', (req, res) => {
  const id = parseDecisionId(req.params.id)
  if (id === null) return fail(res, 400, '非法的决策 ID')
  const decision = findDecisionById(id)
  if (!decision) return fail(res, 404, `决策 #${id} 不存在`)
  if (decision.voided_at) return fail(res, 409, '该决策已作废，不能纠正业务日期')

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const rawDate = body.decided_at === null || body.decided_at === undefined ? '' : String(body.decided_at).trim()
  if (!isValidDateOnly(rawDate)) {
    return fail(res, 400, 'decided_at 必须是真实存在的日期，格式为 YYYY-MM-DD')
  }
  if (rawDate > todayLocalDateOnly()) {
    return fail(res, 400, 'decided_at 不能晚于今天')
  }
  const errors = []
  const reason = readCalibrationReason(body.reason, errors)
  if (errors.length) return fail(res, 400, errors[0])
  const before = decision.decided_at ?? null
  if (before === rawDate) return fail(res, 400, '业务日期未变化，无需纠正')

  try {
    db.transaction(() => {
      recordCalibrationCorrection({
        targetType: 'decision',
        targetId: id,
        action: 'correct_date',
        field: 'decided_at',
        beforeValue: before,
        afterValue: rawDate,
        reason
      })
      db.prepare('UPDATE creator_decisions SET decided_at = ? WHERE id = ?').run(rawDate, id)
    })()
  } catch (error) {
    return fail(res, 400, error?.message || '业务日期纠正失败')
  }

  ok(res, {
    decision: toPublicDecision(findDecisionById(id)),
    corrections: listCalibrationCorrections('decision', id)
  })
})

/**
 * POST /api/creator-decisions/:id/void
 * body: { reason }
 * VOID（不 hard delete）：
 *   · 原 decision row / creator_id / evidence 保留
 *   · negotiation case / outcome / record 全部保留（绝不级联删除下游事实）
 *   · 作废后不参与 latest decision 与业务排序；历史中仍可查看并标记「已作废」
 */
router.post('/:id/void', (req, res) => {
  const id = parseDecisionId(req.params.id)
  if (id === null) return fail(res, 400, '非法的决策 ID')
  const decision = findDecisionById(id)
  if (!decision) return fail(res, 404, `决策 #${id} 不存在`)
  if (decision.voided_at) return fail(res, 409, '该决策已作废，不能重复作废')

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const errors = []
  const reason = readCalibrationReason(body.reason, errors)
  if (errors.length) return fail(res, 400, errors[0])

  db.transaction(() => {
    recordCalibrationCorrection({
      targetType: 'decision',
      targetId: id,
      action: 'void',
      field: null,
      beforeValue: null,
      afterValue: 'voided',
      reason
    })
    db.prepare('UPDATE creator_decisions SET voided_at = CURRENT_TIMESTAMP, void_reason = ? WHERE id = ?').run(
      reason,
      id
    )
  })()

  ok(res, {
    decision: toPublicDecision(findDecisionById(id)),
    corrections: listCalibrationCorrections('decision', id)
  })
})

/** GET /api/creator-decisions/:id/corrections（只读审计：该决策的全部日期纠正 / 作废记录） */
router.get('/:id/corrections', (req, res) => {
  const id = parseDecisionId(req.params.id)
  if (id === null) return fail(res, 400, '非法的决策 ID')
  const decision = findDecisionById(id)
  if (!decision) return fail(res, 404, `决策 #${id} 不存在`)
  ok(res, {
    decision_id: id,
    corrections: listCalibrationCorrections('decision', id)
  })
})

export default router
