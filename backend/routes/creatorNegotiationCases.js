import { Router } from 'express'
import db from '../db.js'
import { parsePriceText } from '../utils/screenshotValues.js'
import { computeCreatorPricing } from '../utils/creatorPricing.js'
import {
  MAX_NEGOTIATION_NOTE_LENGTH,
  MAX_SOURCE_NOTE_LENGTH,
  NEGOTIATION_CANDIDATE_LIVE_DECISIONS,
  NEGOTIATION_REASON_TAG_VALUES,
  NEGOTIATION_SOURCE_TYPES,
  isValidDateOnly,
  toPublicNegotiationCase
} from '../utils/negotiationCase.js'
// Creator Identity V1 Phase 4：谈价案例只从强事件锚（decision_id / record_id）继承归属锚
import { identitySchemaReady, identityTableHasColumn } from '../utils/creatorIdentity.js'
import { recordCalibrationCorrection, listCalibrationCorrections } from './creatorCalibrationAudit.js'
import { todayLocalDateOnly } from '../utils/businessDate.js'

/**
 * 谈判结果沉淀（V3-alpha.2 A4）
 *
 * 设计原则：
 *   · append-only：只新增，不改写 creator_decisions / creator_recent_snapshots
 *   · 谈判上下文（星图价 / 当前报价 / CPM30 目标价 / 参考区间）在创建时由后端读取并冻结，
 *     前端提交的这些字段一律忽略（禁止伪造历史上下文）
 *   · negotiated_price 与 actual_cost / current_quote / xingtu_price 永久分开，互不同步
 *   · 无 AI、无外部网络
 */
const router = Router()

function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, message) {
  res.status(code).json({ code, data: null, msg: message })
}

const findDecision = (id) => db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(id)
const findSnapshot = (id) => db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(id)
const findCaseByDecision = (decisionId) =>
  db.prepare('SELECT * FROM creator_negotiation_cases WHERE decision_id = ?').get(decisionId)
const findRecord = (id) => db.prepare('SELECT * FROM creator_records WHERE id = ?').get(id)
const findHistoricalCaseByRecord = (recordId) =>
  db
    .prepare(
      `SELECT * FROM creator_negotiation_cases
       WHERE record_id = ? AND source_type = 'historical_backfill'`
    )
    .get(recordId)
/**
 * Semantic Duplicate V0.2：同一次真实谈价不能被两种来源各记一次
 *   live（decision_id）与 historical_backfill（record_id）经 outcome 关联后指向同一次现实事件，
 *   因此跨来源必须互斥 —— 绝不自动复制 / 转换 source_type / UPDATE 已有 case。
 */
const findOutcomeLinkByDecision = (decisionId) =>
  db.prepare('SELECT * FROM creator_decision_outcomes WHERE decision_id = ?').get(decisionId)
const findOutcomeLinkByRecord = (recordId) =>
  db.prepare('SELECT * FROM creator_decision_outcomes WHERE record_id = ?').get(recordId)
const findLiveCaseByDecision = (decisionId) =>
  db
    .prepare(
      `SELECT * FROM creator_negotiation_cases
       WHERE decision_id = ? AND source_type = 'live'`
    )
    .get(decisionId)

/**
 * 批量加载若干 decision 的谈判案例（单条 SQL，决策列表展示用，避免 N+1）
 * @param {Array<{id: number}>} decisionRows
 * @returns {Map<number, Object>} decision_id -> 对外案例对象
 */
export function loadNegotiationCaseSummaries(decisionRows = []) {
  const map = new Map()
  const ids = (Array.isArray(decisionRows) ? decisionRows : [])
    .map((row) => row?.id)
    .filter((id) => Number.isInteger(id) && id > 0)
  if (!ids.length) return map
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT * FROM creator_negotiation_cases WHERE decision_id IN (${placeholders})`
    )
    .all(...ids)
  for (const row of rows) map.set(row.decision_id, toPublicNegotiationCase(row))
  return map
}

/** 谈成价：接受数字，也接受「¥2,200 / 2200元 / 2,400」这类文本（复用确定性价格 parser） */
function parseNegotiatedPrice(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  if (typeof value === 'string') {
    const parsed = parsePriceText(value)
    return parsed.value !== null && parsed.value >= 0 ? parsed.value : null
  }
  return null
}

/** 可选价格（星图刊例 / 初始报价）：空值 → null；非法文本 / 负数 → 报错 */
function parseOptionalPrice(value, label) {
  if (value === null || value === undefined) return { value: null }
  if (typeof value === 'string' && value.trim() === '') return { value: null }
  const parsed = parseNegotiatedPrice(value)
  if (parsed === null) return { error: `${label}必须是非负数字或「¥2,200」这类可解析文本` }
  return { value: parsed }
}

/**
 * 收集「人的输入」并做确定性校验（live 与 historical_backfill 共用）
 * @returns {{ error?: string, negotiatedPrice?: number, negotiatedAt?: string, reasonTags?: string[],
 *             reasonNote?: string|null, strategyNote?: string|null, sourceNote?: string|null,
 *             xingtuPriceSnapshot?: number|null, currentQuoteSnapshot?: number|null }}
 */
function collectCaseFields(body, { withHistoricalFields = false } = {}) {
  const negotiatedPrice = parseNegotiatedPrice(body.negotiated_price)
  if (negotiatedPrice === null) {
    return {
      error: '最终谈成价（negotiated_price）必填，且必须是非负数字或「¥2,200」这类可解析文本'
    }
  }

  const negotiatedAt = typeof body.negotiated_at === 'string' ? body.negotiated_at.trim() : ''
  if (!negotiatedAt) return { error: '谈成日期（negotiated_at）不能为空' }
  if (!isValidDateOnly(negotiatedAt)) {
    return { error: '谈成日期（negotiated_at）必须是真实存在的日期，格式为 YYYY-MM-DD' }
  }

  const rawTags = body.reason_tags === undefined || body.reason_tags === null ? [] : body.reason_tags
  if (!Array.isArray(rawTags)) return { error: 'reason_tags 必须是数组' }
  const reasonTags = [...new Set(rawTags.map((tag) => String(tag ?? '').trim()).filter(Boolean))]
  const unknownTag = reasonTags.find((tag) => !NEGOTIATION_REASON_TAG_VALUES.includes(tag))
  if (unknownTag) return { error: `谈价原因标签「${unknownTag}」不在允许范围内` }

  const reasonNote =
    body.reason_note === null || body.reason_note === undefined ? null : String(body.reason_note).trim()
  const strategyNote =
    body.strategy_note === null || body.strategy_note === undefined ? null : String(body.strategy_note).trim()
  for (const [field, value] of [['reason_note', reasonNote], ['strategy_note', strategyNote]]) {
    if (value && value.length > MAX_NEGOTIATION_NOTE_LENGTH) {
      return { error: `${field} 长度不能超过 ${MAX_NEGOTIATION_NOTE_LENGTH}` }
    }
  }

  const result = { negotiatedPrice, negotiatedAt, reasonTags, reasonNote, strategyNote }

  // source_note：live 与 historical_backfill 共用的「人工谈价原始说明」（人工维护的 source of truth）
  const sourceNote =
    body.source_note === null || body.source_note === undefined
      ? null
      : String(body.source_note).trim()
  if (sourceNote && sourceNote.length > MAX_SOURCE_NOTE_LENGTH) {
    return { error: `谈价原始备注（source_note）长度不能超过 ${MAX_SOURCE_NOTE_LENGTH}` }
  }
  result.sourceNote = sourceNote || null

  if (withHistoricalFields) {
    // 历史回填：星图刊例 / 初始报价都是「用户确认过的历史价格事实」，可空但不可伪造
    const xingtu = parseOptionalPrice(body.xingtu_price_snapshot, '历史星图刊例价（xingtu_price_snapshot）')
    if (xingtu.error) return { error: xingtu.error }
    const quote = parseOptionalPrice(body.current_quote_snapshot, '历史初始报价（current_quote_snapshot）')
    if (quote.error) return { error: quote.error }
    result.xingtuPriceSnapshot = xingtu.value
    result.currentQuoteSnapshot = quote.value
  }

  return result
}

/**
 * POST /api/creator-negotiation-cases
 * body: { decision_id, negotiated_price, negotiated_at, reason_tags?, reason_note?, strategy_note? }
 */
router.post('/', (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}

  const decisionId = Number(body.decision_id)
  if (!Number.isInteger(decisionId) || decisionId <= 0) {
    return fail(res, 400, 'decision_id 必须是正整数')
  }
  const decision = findDecision(decisionId)
  if (!decision) return fail(res, 404, `决策 #${decisionId} 不存在`)
  if (decision.decision_stage !== 'post_quote') {
    return fail(res, 400, '只有「已拿到报价」阶段的决策才能记录谈价结果')
  }
  // Phase 4F-B → Unification V0.2：candidate 只有「报价阶段」决策才能挂谈价事实，
  //   但不再强制必须是 negotiate —— 谈价常常在系统外完成（谈完价才回来记录），
  //   因此允许 negotiate / proceed / small_test / pause；candidate_review（contact / observe 等）
  //   永远不能挂谈价案例（不伪造报价阶段）。
  // 说明：legacy（candidate_id = NULL）保持既有宽松行为（只校验 stage），不收紧旧契约，
  //      也兼容 historically「post_quote + repurchase/small_test 也记录谈价」的旧用法。
  const isCandidateDecision = decision.candidate_id !== null && decision.candidate_id !== undefined
  if (isCandidateDecision && !NEGOTIATION_CANDIDATE_LIVE_DECISIONS.includes(decision.human_decision)) {
    return fail(
      res,
      400,
      '候选达人只有报价阶段决策（继续议价 / 直接推进 / 小额测试 / 暂缓）才能记录谈价事实'
    )
  }

  const fields = collectCaseFields(body)
  if (fields.error) return fail(res, 400, fields.error)
  const { negotiatedPrice, negotiatedAt, reasonTags, reasonNote, strategyNote } = fields

  if (findCaseByDecision(decisionId)) {
    return fail(res, 409, `决策 #${decisionId} 已经有谈价结果，不能重复记录`)
  }

  // Semantic Duplicate V0.2（跨来源去重）：
  //   该决策若已通过 outcome 关联到真实投放记录，且该记录已补录历史谈价，
  //   则同一次真实谈价会变成两条 case（live + historical_backfill）→ 拒绝，不自动复制 / 转换。
  const outcomeLinkForDecision = findOutcomeLinkByDecision(decisionId)
  if (outcomeLinkForDecision && findHistoricalCaseByRecord(outcomeLinkForDecision.record_id)) {
    return fail(
      res,
      409,
      `该次真实投放（记录 #${outcomeLinkForDecision.record_id}）已补录历史谈价，请查看已有谈价案例。`
    )
  }

  // ---- 冻结「当时」的谈判上下文（全部由后端重新读取，忽略前端提交的同名字段）----
  const snapshotRow = decision.snapshot_id ? findSnapshot(decision.snapshot_id) : null
  const snapshotPricing = snapshotRow
    ? computeCreatorPricing({
        stats_status: snapshotRow.stats_status,
        median_play: snapshotRow.median_play,
        p25_play: snapshotRow.p25_play,
        p75_play: snapshotRow.p75_play,
        xingtu_price: snapshotRow.xingtu_price ?? null
      })
    : null
  const xingtuPriceSnapshot = snapshotRow?.xingtu_price ?? null
  // ---- 谈前报价（current_quote_snapshot）语义 ----
  //   A. 原生 negotiate flow（post_quote/negotiate）：decision.current_quote 就是「谈价开始前的真实报价」→ 服务端冻结
  //   B. 「记录已发生谈价」retrofit flow（candidate 的 post_quote/proceed|small_test|pause）：
  //      谈价发生在系统之外，回到系统时 decision.current_quote 可能**已经是谈后报价**，
  //      因此绝不能自动当成谈前报价 —— 必须由人工明确填写，后端只做确定性校验（不做任何文本解析）。
  //   legacy（candidate_id = NULL）保持原有行为（冻结 decision.current_quote），不破坏旧契约。
  const isRetrofitCapture = isCandidateDecision && decision.human_decision !== 'negotiate'
  let currentQuoteSnapshot = decision.current_quote ?? null
  if (isRetrofitCapture) {
    const preQuote = parseOptionalPrice(
      body.current_quote_snapshot,
      '谈前报价（current_quote_snapshot）'
    )
    if (preQuote.error) return fail(res, 400, preQuote.error)
    if (preQuote.value === null) {
      return fail(res, 400, '记录已发生谈价时必须人工填写谈前报价（current_quote_snapshot）')
    }
    currentQuoteSnapshot = preQuote.value
  }
  const targetPriceSnapshot = snapshotPricing?.target_price ?? null
  const referenceLowSnapshot = snapshotPricing?.reference_low ?? null
  const referenceHighSnapshot = snapshotPricing?.reference_high ?? null
  const targetCpm = decision.target_cpm ?? null

  let saved
  try {
    // Creator Identity Phase 4：live case 的归属锚 = decision_id → decision.creator_id（绝不按 creator 文本匹配）
    const caseColumns = [
      'creator',
      'decision_id',
      'snapshot_id',
      'xingtu_price_snapshot',
      'current_quote_snapshot',
      'negotiated_price',
      'negotiated_at',
      'reason_tags_json',
      'reason_note',
      'strategy_note',
      'target_cpm',
      'target_price_snapshot',
      'reference_low_snapshot',
      'reference_high_snapshot',
      'source_type',
      'record_id',
      'source_note'
    ]
    const caseValues = [
      decision.creator,
      decisionId,
      decision.snapshot_id ?? null,
      xingtuPriceSnapshot,
      currentQuoteSnapshot,
      negotiatedPrice,
      negotiatedAt,
      JSON.stringify(reasonTags),
      reasonNote || null,
      strategyNote || null,
      targetCpm,
      targetPriceSnapshot,
      referenceLowSnapshot,
      referenceHighSnapshot,
      'live',
      null,
      fields.sourceNote
    ]
    // 归属锚：decision.creator_id 为 NULL 时保持 NULL（事实仍由 decision_id 锚定，绝不阻塞谈价事实）
    if (identitySchemaReady(db) && identityTableHasColumn(db, 'creator_negotiation_cases', 'creator_id')) {
      caseColumns.push('creator_id')
      caseValues.push(decision.creator_id ?? null)
    }
    const info = db
      .prepare(
        `INSERT INTO creator_negotiation_cases (${caseColumns.join(', ')})
         VALUES (${caseColumns.map(() => '?').join(', ')})`
      )
      .run(...caseValues)
    saved = db.prepare('SELECT * FROM creator_negotiation_cases WHERE id = ?').get(info.lastInsertRowid)
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) {
      return fail(res, 409, `决策 #${decisionId} 已经有谈价结果，不能重复记录`)
    }
    throw error
  }
  ok(res, toPublicNegotiationCase(saved))
})

/**
 * POST /api/creator-negotiation-cases/historical-backfill
 * Historical Negotiation Backfill V0.1：
 *   把「过去真实发生过、且已经有真实 creator_record 的谈价案例」安全回填。
 *
 * 关键边界：
 *   · 稳定身份是 record_id（不是 creator 名称），不依赖 decision_id
 *   · **绝不创建假的 decision / outcome**（历史没有发生过的系统流程不会被制造出来）
 *   · creator = record.nickname 的服务端快照（改名后仍通过 record_id 追溯）
 *   · negotiated_at = 当时真实谈价时间；created_at = 现在录入时间（不篡改）
 *   · historical_backfill 不写 CPM30 legacy 快照（target_cpm / target_price / reference_* 全为 NULL）
 *   · negotiated_price 与 creator_record.total_cost 永久分开，绝不互相同步
 *   · append-only：同一条 record 最多一条 historical_backfill（重复 → 409）
 *
 * body: { record_id, negotiated_price, negotiated_at,
 *         xingtu_price_snapshot?, current_quote_snapshot?, source_note?,
 *         reason_tags?, reason_note?, strategy_note? }
 */
router.post('/historical-backfill', (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}

  const recordId = Number(body.record_id)
  if (!Number.isInteger(recordId) || recordId <= 0) {
    return fail(res, 400, 'record_id 必须是正整数（历史回填必须绑定真实投放记录）')
  }
  const record = findRecord(recordId)
  if (!record) return fail(res, 404, `投放记录 #${recordId} 不存在`)

  const fields = collectCaseFields(body, { withHistoricalFields: true })
  if (fields.error) return fail(res, 400, fields.error)

  if (findHistoricalCaseByRecord(recordId)) {
    return fail(res, 409, `投放记录 #${recordId} 已经补录过历史谈价，不能重复补录`)
  }

  // Semantic Duplicate V0.2（反方向）：该投放记录若已通过 outcome 关联到某个决策，
  // 且该决策已有 live 谈价案例，则同一次投放已被实时流程记录 → 拒绝重复补录。
  const outcomeLinkForRecord = findOutcomeLinkByRecord(recordId)
  if (outcomeLinkForRecord && findLiveCaseByDecision(outcomeLinkForRecord.decision_id)) {
    return fail(res, 409, '该次投放已存在实时谈价案例，无需重复补录。')
  }

  let saved
  try {
    // Creator Identity Phase 4：historical_backfill 的归属锚 = record_id → record.creator_id（绝不按 creator 文本匹配）
    const caseColumns = [
      'creator',
      'decision_id',
      'snapshot_id',
      'xingtu_price_snapshot',
      'current_quote_snapshot',
      'negotiated_price',
      'negotiated_at',
      'reason_tags_json',
      'reason_note',
      'strategy_note',
      'target_cpm',
      'target_price_snapshot',
      'reference_low_snapshot',
      'reference_high_snapshot',
      'source_type',
      'record_id',
      'source_note'
    ]
    const caseValues = [
      // creator 使用 record.nickname 的服务端快照（前端提交的同名字段一律忽略）
      record.nickname ?? null,
      null,
      null,
      fields.xingtuPriceSnapshot,
      fields.currentQuoteSnapshot,
      fields.negotiatedPrice,
      fields.negotiatedAt,
      JSON.stringify(fields.reasonTags),
      fields.reasonNote || null,
      fields.strategyNote || null,
      // Historical Backfill V0.1：不用今天的系统规则反推历史当时不存在的 pricing evidence
      null,
      null,
      null,
      null,
      'historical_backfill',
      recordId,
      fields.sourceNote
    ]
    // 归属锚：record.creator_id 为 NULL 时保持 NULL（事实仍由 record_id 锚定，绝不阻塞历史补录）
    if (identitySchemaReady(db) && identityTableHasColumn(db, 'creator_negotiation_cases', 'creator_id')) {
      caseColumns.push('creator_id')
      caseValues.push(record.creator_id ?? null)
    }
    const info = db
      .prepare(
        `INSERT INTO creator_negotiation_cases (${caseColumns.join(', ')})
         VALUES (${caseColumns.map(() => '?').join(', ')})`
      )
      .run(...caseValues)
    saved = db.prepare('SELECT * FROM creator_negotiation_cases WHERE id = ?').get(info.lastInsertRowid)
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) {
      return fail(res, 409, `投放记录 #${recordId} 已经补录过历史谈价，不能重复补录`)
    }
    throw error
  }
  ok(res, toPublicNegotiationCase(saved))
})

/**
 * GET /api/creator-negotiation-cases?creator=... 或 ?decision_id=... 或 ?record_id=...
 *   或 ?source_type=historical_backfill（只读列出历史回填，供 Records 页面标记「已补录谈价」）
 *
 * 契约：
 *   · 支持 4 个查询条件：creator / decision_id / record_id / source_type
 *   · 多个条件可组合，语义为 AND（例如 ?record_id=920&source_type=historical_backfill）
 *   · 仍然要求「至少提供一个受支持的查询条件」（保留旧防护，不做无条件全量开放）
 *   · 业务时间倒序（negotiated_at DESC, id DESC）；created_at 仅作录入审计，不用于判断业务先后。
 *     仅 source_type 全量列举时上限 500 条
 */
router.get('/', (req, res) => {
  const creator = String(req.query?.creator ?? '').trim()
  const decisionIdRaw = req.query?.decision_id
  const recordIdRaw = req.query?.record_id
  const sourceTypeRaw = String(req.query?.source_type ?? '').trim()

  const conditions = []
  const params = []
  // source_type（live / historical_backfill）
  if (sourceTypeRaw) {
    if (!NEGOTIATION_SOURCE_TYPES.includes(sourceTypeRaw)) {
      return fail(res, 400, 'source_type 只能是 live 或 historical_backfill')
    }
    conditions.push('source_type = ?')
    params.push(sourceTypeRaw)
  }
  // record_id（historical_backfill 的稳定 anchor；不需要 decision_id）
  if (recordIdRaw !== undefined && recordIdRaw !== '') {
    const recordId = Number(recordIdRaw)
    if (!Number.isInteger(recordId) || recordId <= 0) {
      return fail(res, 400, 'record_id 必须是正整数')
    }
    conditions.push('record_id = ?')
    params.push(recordId)
  }
  // decision_id（live 渠道）
  if (decisionIdRaw !== undefined && decisionIdRaw !== '') {
    const decisionId = Number(decisionIdRaw)
    if (!Number.isInteger(decisionId) || decisionId <= 0) {
      return fail(res, 400, 'decision_id 必须是正整数')
    }
    conditions.push('decision_id = ?')
    params.push(decisionId)
  }
  // creator（创建时名称快照）
  if (creator) {
    conditions.push('creator = ?')
    params.push(creator)
  }

  // 旧防护保留：至少提供一个受支持的查询条件（不无条件全量开放）
  if (!conditions.length) {
    return fail(res, 400, 'creator / decision_id / record_id / source_type 至少提供一个')
  }

  // 仅按 source_type 全量列举时限制条数；其余（creator / record_id / decision_id）沿用原有不加 limit 的行为
  const isBulkList = conditions.length === 1 && conditions[0].startsWith('source_type')
  const rows = db
    .prepare(
      `SELECT * FROM creator_negotiation_cases
       WHERE ${conditions.join(' AND ')}
       ORDER BY negotiated_at DESC, id DESC${isBulkList ? ' LIMIT 500' : ''}`
    )
    .all(...params)
  ok(res, { creator: creator || null, cases: rows.map(toPublicNegotiationCase) })
})

// ---------- Real Data Calibration V1：谈成日期纠正（append-only 审计，不改其它字段） ----------

function parseCaseId(value) {
  const num = Number(value)
  return Number.isInteger(num) && num > 0 ? num : null
}

const findCaseById = (id) => db.prepare('SELECT * FROM creator_negotiation_cases WHERE id = ?').get(id)

/**
 * PATCH /api/creator-negotiation-cases/:id/date
 * body: { negotiated_at, reason }
 * 只纠正业务日期（negotiated_at）：
 *   · negotiated_price / xingtu_price_snapshot / current_quote_snapshot / creator_id / record_id / decision_id 一律不改
 *   · 每次纠正追加 before / after / reason 审计，不得无痕覆盖
 */
router.patch('/:id/date', (req, res) => {
  const id = parseCaseId(req.params.id)
  if (id === null) return fail(res, 400, '非法的谈价案例 ID')
  const existing = findCaseById(id)
  if (!existing) return fail(res, 404, `谈价案例 #${id} 不存在`)

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const rawDate = body.negotiated_at === null || body.negotiated_at === undefined ? '' : String(body.negotiated_at).trim()
  if (!isValidDateOnly(rawDate)) {
    return fail(res, 400, 'negotiated_at 必须是真实存在的日期，格式为 YYYY-MM-DD')
  }
  if (rawDate > todayLocalDateOnly()) {
    return fail(res, 400, 'negotiated_at 不能晚于今天')
  }
  const reasonRaw = body.reason === null || body.reason === undefined ? '' : String(body.reason).trim()
  if (!reasonRaw) return fail(res, 400, '必须填写纠正原因（reason）')
  if (reasonRaw.length > MAX_NEGOTIATION_NOTE_LENGTH) {
    return fail(res, 400, `纠正原因（reason）长度不能超过 ${MAX_NEGOTIATION_NOTE_LENGTH}`)
  }
  if ((existing.negotiated_at ?? null) === rawDate) {
    return fail(res, 400, '谈成日期未变化，无需纠正')
  }

  const before = existing.negotiated_at ?? null
  db.transaction(() => {
    recordCalibrationCorrection({
      targetType: 'negotiation_case',
      targetId: id,
      action: 'correct_date',
      field: 'negotiated_at',
      beforeValue: before,
      afterValue: rawDate,
      reason: reasonRaw
    })
    db.prepare('UPDATE creator_negotiation_cases SET negotiated_at = ? WHERE id = ?').run(rawDate, id)
  })()

  ok(res, {
    case: toPublicNegotiationCase(findCaseById(id)),
    corrections: listCalibrationCorrections('negotiation_case', id)
  })
})

/** GET /api/creator-negotiation-cases/:id/corrections（只读审计：该谈价案例的全部日期纠正记录） */
router.get('/:id/corrections', (req, res) => {
  const id = parseCaseId(req.params.id)
  if (id === null) return fail(res, 400, '非法的谈价案例 ID')
  const existing = findCaseById(id)
  if (!existing) return fail(res, 404, `谈价案例 #${id} 不存在`)
  ok(res, {
    case_id: id,
    corrections: listCalibrationCorrections('negotiation_case', id)
  })
})

export default router
