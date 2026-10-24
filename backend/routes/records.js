import { Router } from 'express'
import db from '../db.js'
import {
  dateToWeekCode,
  getCycleInfo,
  getNextWeek,
  getPrevWeek,
  getWeekDateRange,
  normalizeWeekCode,
  parseTimeCycleToWeekCode
} from '../utils/dateCycle.js'
import { buildXlsx } from '../utils/xlsx.js'
import {
  loadLatestDecisionSummaries,
  loadLatestDecisionSummariesByCreatorId
} from './creatorDecisions.js'
import {
  loadLatestSnapshotSummaries,
  loadLatestSnapshotSummariesByCreatorId
} from './recentSnapshots.js'
import { TARGET_CPM } from '../utils/creatorBusinessRules.js'
// Record Edit History V1：编辑留痕（append-only，与业务更新同事务）
import {
  assertCreatorRecordEditsReady,
  creatorRecordEditsReady,
  insertRecordEditEvent,
  newRecordEditGroupId,
  recordBusinessSnapshot,
  recordFieldChanges,
  RECORD_EDIT_ROW_FIELD
} from '../utils/recordEditAudit.js'
// Creator Identity V1 Phase 4：新 record 必须继承 / 建立 creator_id 归属锚
import {
  identitySchemaReady,
  identityTableHasColumn,
  resolveOrCreateCreatorForRecord
} from '../utils/creatorIdentity.js'

const router = Router()

// ============================================================
// Creator Identity V1 Phase 5：达人库 / 复投雷达的「身份层」判定
// ------------------------------------------------------------
// · 生产（Phase 1 migration 之后）：Creator 是身份来源，creator_id 是唯一身份键
// · 老 fixture（无 creators 表 / 无 creator_id 列）：自动降级为 nickname 模式，
//   既有接口契约与既有测试语义完全不变（不重写历史 fixture）
// · 绝不出现「新表存在却因为方便仍优先 nickname」的情况
// ============================================================
function creatorIdentityReady() {
  return identitySchemaReady(db) && identityTableHasColumn(db, 'creator_records', 'creator_id')
}

/** 聚合行的身份键：identity 模式用 creator_id，legacy 模式退回 nickname */
function summaryRowKey(item) {
  return item?.creator_id === null || item?.creator_id === undefined
    ? item?.nickname
    : item.creator_id
}

/**
 * 达人库身份来源：creators（默认排除 merged 墓碑）。
 * 类型筛选作用于 Creator 当前类型；关键词匹配 canonical_name / alias（只做 substring，
 * 不 fuzzy / 不拼音 / 不相似度）。alias 只是搜索入口，命中后仍返回同一个 Creator。
 */
function loadLibraryCreators({ creatorTypes = [], keyword = '' } = {}) {
  const conditions = ["c.identity_status != 'merged'"]
  const params = []
  if (creatorTypes.length) {
    conditions.push(`c.creator_type IN (${creatorTypes.map(() => '?').join(', ')})`)
    params.push(...creatorTypes)
  }
  const keywordText = String(keyword || '').trim()
  if (keywordText) {
    const like = `%${escapeLike(keywordText)}%`
    conditions.push(
      `(c.canonical_name LIKE ? ESCAPE '\\' OR EXISTS (
         SELECT 1 FROM creator_aliases a
         WHERE a.creator_id = c.id AND a.alias LIKE ? ESCAPE '\\'
       ))`
    )
    params.push(like, like)
  }
  return db
    .prepare(
      `SELECT c.id AS creator_id, c.canonical_name, c.creator_type, c.identity_status
       FROM creators c
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.id ASC`
    )
    .all(...params)
}

// 字段白名单：仅允许写入以下列，杜绝 SQL 注入
const FIELDS = {
  time_cycle: { type: 'string', max: 20, required: true },
  nickname: { type: 'string', max: 100, required: true },
  homepage: { type: 'string', max: 500 },
  creator_type: { type: 'string', max: 50 },
  content_link: { type: 'string', max: 500 },
  // 总花费与 Excel 导入 / 前端表单保持一致：必填，但 0 是合法真实值
  total_cost: { type: 'number', min: 0, required: true },
  publish_date: { type: 'date' },
  video_link: { type: 'string', max: 500 },
  first_play: { type: 'int', min: 0 },
  second_week_play: { type: 'int', min: 0 }
}

const COLUMNS = Object.keys(FIELDS)
// 输出列（不含已废弃的 cpm_quote）
const SELECT_COLUMNS = [
  'id',
  'time_cycle',
  'nickname',
  'homepage',
  'creator_type',
  'content_link',
  'total_cost',
  'publish_date',
  'video_link',
  'first_play',
  'second_week_play',
  'created_at'
]
/**
 * Creator Identity V1 Phase 5：归属锚 creator_id 随记录一起返回（additive），
 * 让前端可以按 creator_id 下钻（绝不按昵称文本匹配）。
 * 老 fixture 没有该列时自动退回原列集合，响应形状与原来完全一致。
 */
function recordSelectSql() {
  const columns = identityTableHasColumn(db, 'creator_records', 'creator_id')
    ? [...SELECT_COLUMNS, 'creator_id']
    : SELECT_COLUMNS
  return `SELECT ${columns.join(', ')} FROM creator_records`
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ---------- 统一响应格式 { code, data, msg } ----------
function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, msg) {
  res.status(code).json({ code, data: null, msg })
}

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

// ---------- 播放量字段（V2 业务口径）----------
// first_play = 7日播放量；second_week_play = 累计播放量
const PLAY_FIELD_LABELS = {
  first_play: '7日播放量',
  second_week_play: '累计播放量'
}
// 交叉校验统一文案（与前端表单 / Excel 导入保持一致）
const PLAY_RANGE_ERROR = '累计播放量不能小于7日播放量，请检查数据是否录入正确'

// 必填字段的用户可见中文名（仅用于「不能为空」提示，不参与数值校验文案）
const REQUIRED_FIELD_LABELS = {
  total_cost: '总花费'
}

/**
 * 字段是否「明确提供」：
 * - partial（PUT）：请求体里存在该 key 即视为提供（null / '' / 0 都是明确提供的值）
 * - 非 partial（POST / batch）：undefined 视为未提供
 * 使用 hasOwnProperty 而不是真假判断，避免把数字 0 当成「没传」
 */
function isFieldProvided(body, field, partial) {
  if (partial) return Object.prototype.hasOwnProperty.call(body, field)
  return body[field] !== undefined
}

// 明确清空：null / 空字符串（数字 0 属于真实值，不算清空）
function isExplicitEmpty(value) {
  if (value === null) return true
  return typeof value === 'string' && value.trim() === ''
}

/**
 * 播放量交叉校验（V2 规则）：两者都有值时，累计播放量不得小于 7日播放量
 * 0 是有效观察值，缺失（null/空）不参与校验
 * @returns {string|null} 错误文案或 null
 */
function checkPlayRange(row = {}) {
  const first = toOptionalPlayNumber(row.first_play)
  const latest = toOptionalPlayNumber(row.second_week_play)
  if (first === null || latest === null) return null
  return latest < first ? PLAY_RANGE_ERROR : null
}

// 时间周期口径（V2）：time_cycle = 发布日期所属的标准自然周（周一 ~ 周日）
const CYCLE_DATE_ERROR = '时间周期与发布日期所属周不一致，请按发布日期修正时间周期'

/**
 * 时间周期 与 发布日期 的确定性一致性校验：
 * 两者都有有效值时，发布日期必须落在 time_cycle 对应的周一~周日区间内。
 * - 任一为空 → 不校验（发布日期为空时周期允许人工指定）
 * - time_cycle 不是合法周码（无法解析区间）→ 不在此处判错，交由既有格式校验
 * @returns {string|null} 错误文案或 null
 */
function checkPublishCycleConsistency(row = {}) {
  const publishDate = typeof row.publish_date === 'string' ? row.publish_date.trim() : ''
  const timeCycle = typeof row.time_cycle === 'string' ? row.time_cycle.trim() : ''
  if (!publishDate || !timeCycle) return null
  const normalizedCycle = normalizeWeekCode(timeCycle)
  // 与前端 publishDateToWeekCode 同源：由发布日期推导 canonical 自然周（周一 ~ 周日）
  const expectedCycle = dateToWeekCode(publishDate)
  if (!normalizedCycle || !expectedCycle) return null
  if (normalizedCycle === expectedCycle) return null
  const range = getWeekDateRange(expectedCycle)
  const label = range ? `${range.startDate} ~ ${range.endDate}` : expectedCycle
  // 提示里给出「正确的那一周」，不是用户传入的那一周，避免误导
  return `${CYCLE_DATE_ERROR}（发布日期 ${publishDate} 属于 ${expectedCycle}，即 ${label}）`
}

// ---------- 参数校验 ----------
function validate(data, { partial = false } = {}) {
  const errors = []
  const clean = {}

  for (const [field, spec] of Object.entries(FIELDS)) {
    const value = data[field]
    const provided = isFieldProvided(data, field, partial)
    const label = REQUIRED_FIELD_LABELS[field] || PLAY_FIELD_LABELS[field] || field

    // 未提供 / 明确传空（null、空字符串）
    if (!provided || isExplicitEmpty(value)) {
      if (spec.required) {
        // 必填字段：PUT 未提供 → 保持旧值；只要传了空值（或 POST 缺字段）→ 拒绝
        // 有中文名的必填字段（总花费）与前端 Excel 导入保持同一文案「总花费不能为空」；
        // 其余字段沿用既有「字段名 不能为空」形式，避免改变现有提示。
        const emptyMsg = REQUIRED_FIELD_LABELS[field] ? `${label}不能为空` : `${label} 不能为空`
        if (partial ? provided : true) errors.push(emptyMsg)
        continue
      }
      // 可空字段：POST 未提供或传空 → 写 NULL；PUT 明确传空 → 写 NULL（未提供则不动）
      if (!partial || provided) clean[field] = null
      continue
    }

    if (spec.type === 'string') {
      const text = String(value).trim()
      if (text.length > spec.max) {
        errors.push(`${field} 长度不能超过 ${spec.max}`)
        continue
      }
      clean[field] = text
    } else if (spec.type === 'number' || spec.type === 'int') {
      const num = Number(value)
      if (
        !Number.isFinite(num) ||
        (spec.type === 'int' && !Number.isInteger(num)) ||
        num < spec.min
      ) {
        errors.push(
          PLAY_FIELD_LABELS[field]
            ? `${label}必须为非负整数`
            : `${field} 必须为${spec.type === 'int' ? '整数' : '数字'}且不小于 ${spec.min}`
        )
        continue
      }
      clean[field] = num
    } else if (spec.type === 'date') {
      const text = String(value)
      if (!DATE_RE.test(text)) {
        errors.push(`${field} 格式必须为 YYYY-MM-DD`)
        continue
      }
      clean[field] = text
    }
  }

  return { clean, errors }
}

// 完整行：缺失字段补 null，统一插入列顺序
function toRow(clean) {
  const row = {}
  for (const field of COLUMNS) {
    row[field] = clean[field] === undefined ? null : clean[field]
  }
  return row
}

const INSERT_SQL = `INSERT INTO creator_records (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(
  () => '?'
).join(', ')})`

// Creator Identity V1 Phase 4：带归属锚的 INSERT（只在身份层 schema + additive 列都存在时使用）
const IDENTITY_INSERT_COLUMNS = [...COLUMNS, 'creator_id', 'creator_link_source']
const IDENTITY_INSERT_SQL = `INSERT INTO creator_records (${IDENTITY_INSERT_COLUMNS.join(
  ', '
)}) VALUES (${IDENTITY_INSERT_COLUMNS.map(() => '?').join(', ')})`

/**
 * 本库是否具备 record 身份归属写入条件（老 fixture / migration 之前的库 → false，自动降级为旧契约）。
 * 归属规则（冻结）：strict alias 0 match → 建 provisional Creator；1 → 复用；N → creator_id = NULL（不猜）。
 */
function recordIdentityWritable() {
  return (
    identitySchemaReady(db) &&
    identityTableHasColumn(db, 'creator_records', 'creator_id') &&
    identityTableHasColumn(db, 'creator_records', 'creator_link_source')
  )
}

/**
 * 写入一条 record（含归属锚），单事务：
 * 归属解析 + 可能的 provisional Creator 创建 + record INSERT 必须原子。
 * 身份歧义（N match）不阻塞事实写入，只把 creator_id / creator_link_source 留为 NULL。
 * @returns {number} 新 record id
 */
const insertRecordWithIdentity = db.transaction((dataRow) => {
  const attribution = resolveOrCreateCreatorForRecord(db, {
    nickname: dataRow.nickname,
    creatorType: dataRow.creator_type
  })
  const info = db
    .prepare(IDENTITY_INSERT_SQL)
    .run(
      ...COLUMNS.map((col) => dataRow[col]),
      attribution.creatorId,
      attribution.creatorLinkSource
    )
  return Number(info.lastInsertRowid)
})

// 删除投放记录时同步清理导入批次映射（import_batch_records 只做「批次 ↔ 记录」关联）
// 目的：避免记录删除后残留指向不存在 record_id 的孤儿 mapping，让批次详情统计与记录列表保持一致
const DELETE_RECORD_MAPPING_SQL = 'DELETE FROM import_batch_records WHERE record_id = ?'

function escapeLike(text) {
  // 转义 LIKE 通配符，配合 ESCAPE '\' 使用
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

// 找出周日期范围与 [cycleStart, cycleEnd] 有重叠（含边界）的周码
// 支持只传一端：cycleStart（周结束日 >= 开始日）或 cycleEnd（周开始日 <= 结束日）
function getOverlappingWeekCodes(cycleStart, cycleEnd) {
  const rows = db
    .prepare(
      `SELECT DISTINCT time_cycle
       FROM creator_records
       WHERE time_cycle IS NOT NULL AND time_cycle != ''`
    )
    .all()
  const codes = []
  for (const row of rows) {
    const info = getCycleInfo(row.time_cycle)
    if (!info) continue
    // 重叠条件：周起止日期与所选范围存在交集（含边界日期）
    const startOk = cycleStart ? info.endDate >= cycleStart : true
    const endOk = cycleEnd ? info.startDate <= cycleEnd : true
    if (startOk && endOk) {
      codes.push(info.weekCode)
    }
  }
  return codes
}

// ---------- 1. 分页查询（支持多条件组合筛选） ----------
router.get('/', (req, res) => {
  const page = Number(req.query.page)
  const pageSize = Number(req.query.pageSize)
  const validPage = Number.isInteger(page) && page > 0
  const validSize = Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100

  if (req.query.page !== undefined && !validPage) {
    return fail(res, 400, 'page 必须为正整数')
  }
  if (req.query.pageSize !== undefined && !validSize) {
    return fail(res, 400, 'pageSize 必须为 1-100 的整数')
  }

  const finalPage = validPage ? page : 1
  const finalSize = validSize ? pageSize : 10

  const conditions = []
  const params = []
  const {
    timeCycle,
    weekCode: rawWeekCode,
    creatorType,
    keyword,
    date,
    startDate,
    endDate,
    cycleStart,
    cycleEnd,
    publishDate,
    batch_id: rawBatchId,
    batchId: rawBatchIdCamel
  } = req.query

  // 按周码筛选：兼容 weekCode（新）与 timeCycle（旧），内部自动归一化零填充
  const weekCode = normalizeWeekCode(rawWeekCode || timeCycle)
  if (rawWeekCode || timeCycle) {
    if (!weekCode) {
      return fail(res, 400, '时间周期格式必须为 YYYY-Wxx')
    }
    conditions.push('time_cycle = ?')
    params.push(weekCode)
  }
  // 按周日期范围筛选：time_cycle 对应周的起止日期与所选范围有重叠（含边界）
  // 支持只传 cycleStart 或只传 cycleEnd
  if (cycleStart || cycleEnd) {
    if (cycleStart && !DATE_RE.test(String(cycleStart))) {
      return fail(res, 400, 'cycleStart 格式必须为 YYYY-MM-DD')
    }
    if (cycleEnd && !DATE_RE.test(String(cycleEnd))) {
      return fail(res, 400, 'cycleEnd 格式必须为 YYYY-MM-DD')
    }
    if (cycleStart && cycleEnd && String(cycleStart) > String(cycleEnd)) {
      return fail(res, 400, 'cycleStart 不能晚于 cycleEnd')
    }
    const overlappingCodes = getOverlappingWeekCodes(
      cycleStart ? String(cycleStart) : null,
      cycleEnd ? String(cycleEnd) : null
    )
    if (overlappingCodes.length === 0) {
      // 没有任何周与所选范围重叠，直接返回空结果
      return ok(res, { list: [], total: 0 })
    }
    const placeholders = overlappingCodes.map(() => '?').join(', ')
    conditions.push(`time_cycle IN (${placeholders})`)
    params.push(...overlappingCodes)
  }
  if (creatorType) {
    conditions.push('creator_type = ?')
    params.push(String(creatorType))
  }
  // 按导入批次筛选：仅返回该批次导入的投放记录（关联表来自导入日志，未改 creator_records 表结构）
  const batchIdParam = rawBatchId !== undefined && rawBatchId !== '' ? rawBatchId : rawBatchIdCamel
  if (batchIdParam !== undefined && batchIdParam !== '') {
    const batchId = parseId(batchIdParam)
    if (!batchId) return fail(res, 400, 'batch_id 必须为正整数')
    conditions.push('id IN (SELECT record_id FROM import_batch_records WHERE batch_id = ?)')
    params.push(batchId)
  }
  if (keyword) {
    conditions.push("nickname LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(String(keyword))}%`)
  }
  // 发布日期精确筛选（前端筛选区使用；兼容历史 date 参数）
  const publishDateValue = publishDate || date
  if (publishDateValue) {
    if (!DATE_RE.test(String(publishDateValue))) {
      return fail(res, 400, 'publishDate 格式必须为 YYYY-MM-DD')
    }
    conditions.push('publish_date = ?')
    params.push(String(publishDateValue))
  }
  // 日期区间筛选（历史兼容参数）
  if (startDate) {
    if (!DATE_RE.test(String(startDate))) {
      return fail(res, 400, 'startDate 格式必须为 YYYY-MM-DD')
    }
    conditions.push('publish_date >= ?')
    params.push(String(startDate))
  }
  if (endDate) {
    if (!DATE_RE.test(String(endDate))) {
      return fail(res, 400, 'endDate 格式必须为 YYYY-MM-DD')
    }
    conditions.push('publish_date <= ?')
    params.push(String(endDate))
  }
  if (startDate && endDate && String(startDate) > String(endDate)) {
    return fail(res, 400, 'startDate 不能晚于 endDate')
  }

  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) AS n FROM creator_records${where}`).get(...params).n
  const list = db
    .prepare(`${recordSelectSql()}${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, finalSize, (finalPage - 1) * finalSize)

  ok(res, { list, total })
})

// 时间周期选项（去重，用于前端筛选下拉）
router.get('/time-cycles', (req, res) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT time_cycle
       FROM creator_records
       WHERE time_cycle IS NOT NULL AND time_cycle != ''
       ORDER BY time_cycle DESC`
    )
    .all()
  ok(res, rows.map((row) => row.time_cycle))
})

// 时间周期选项（含起止日期与展示标签，时间计算统一在后端）
router.get('/cycles', (req, res) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT time_cycle
       FROM creator_records
       WHERE time_cycle IS NOT NULL AND time_cycle != ''`
    )
    .all()
  const list = rows
    .map((row) => getCycleInfo(row.time_cycle))
    .filter(Boolean)
    .sort((a, b) => (a.weekCode < b.weekCode ? 1 : -1))
  ok(res, list)
})

// ---------- 周度聚合辅助（单周 / 周范围共用，口径逻辑完全一致） ----------
// 逗号分隔的多值参数（creatorTypes / nicknames），空值返回空数组表示不筛选
function parseCsvParam(raw) {
  return String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

// 组装「维度筛选 + 周码范围」的 WHERE 条件（记录级筛选，与列表筛选口径一致）
function buildRecordFilter({
  startWeek,
  endWeek,
  creatorTypes = [],
  nicknames = [],
  keyword = ''
} = {}) {
  const conditions = []
  const params = []
  if (startWeek) {
    conditions.push('time_cycle >= ?')
    params.push(startWeek)
  }
  if (endWeek) {
    conditions.push('time_cycle <= ?')
    params.push(endWeek)
  }
  if (creatorTypes.length) {
    conditions.push(`creator_type IN (${creatorTypes.map(() => '?').join(', ')})`)
    params.push(...creatorTypes)
  }
  if (nicknames.length) {
    conditions.push(`nickname IN (${nicknames.map(() => '?').join(', ')})`)
    params.push(...nicknames)
  }
  // 达人昵称模糊搜索（可选新增参数；不传时行为与原来完全一致）
  const keywordText = String(keyword || '').trim()
  if (keywordText) {
    conditions.push("nickname LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(keywordText)}%`)
  }
  return { where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', params }
}

// 聚合所需字段（周度聚合只用到这几列）
// Phase 5：withCreatorId 时额外取出 creator_id（达人库按 Creator 聚合的必需身份列）
function queryAggregateRows(filters = {}, { withCreatorId = false } = {}) {
  const { where, params } = buildRecordFilter(filters)
  return db
    .prepare(
      `SELECT time_cycle, nickname, creator_type, total_cost, first_play, second_week_play${
        withCreatorId ? ', creator_id' : ''
      }
       FROM creator_records${where}`
    )
    .all(...params)
}

/**
 * 雷达明细行：附带 Creator 身份（canonical_name）。
 * 排序必须与 queryDetailRows 完全一致（雷达的 equal-date tie-break 依赖行序）。
 */
function queryRadarRows() {
  return db
    .prepare(
      `SELECT r.id, r.time_cycle, r.nickname, r.creator_type, r.homepage, r.content_link, r.video_link,
              r.total_cost, r.first_play, r.second_week_play, r.publish_date,
              r.creator_id, c.canonical_name
       FROM creator_records r
       LEFT JOIN creators c ON c.id = r.creator_id
       WHERE r.creator_id IS NOT NULL
       ORDER BY r.time_cycle ASC, r.id ASC`
    )
    .all()
}

// 明细导出所需字段（与前端导出列一致）
function queryDetailRows(filters = {}) {
  const { where, params } = buildRecordFilter(filters)
  return db
    .prepare(
      `SELECT id, time_cycle, nickname, creator_type, homepage, content_link, video_link,
              total_cost, first_play, second_week_play, publish_date
       FROM creator_records${where}
       ORDER BY time_cycle ASC, id ASC`
    )
    .all(...params)
}

/**
 * 按周聚合播放量/花费：同时产出投放周（campaign）与发生周（occurrence）两套口径
 * @param {Array<Object>} rows 投放记录（已按筛选条件过滤）
 * @returns {{ campaignMap: Map, occurrenceMap: Map }}
 */
// ---------- 播放口径核心（产品已冻结的新定义；纯函数，便于单测） ----------
//   first_play       = 7日累计播放量（内容发布约 7 天时的累计值，不是「首周新增」）
//   second_week_play = 最新累计播放量（最近一次更新时的累计总播放，不限于第 2 周）
//   latest_play      = second_week_play
//   post_7d_growth   = second_week_play - first_play（仅当 latest 有值且 latest >= first）
//   latest_cpm       = cost / latest_play × 1000（主 CPM）
//   cpm_7d           = cost / first_play  × 1000（first 无有效值时返回 null）
// 注意：total_play 不再是 first_play + second_week_play —— 两个字段都是累计值，相加会重复计数。
export const HOT_PLAY_THRESHOLD = 100000 // 爆款阈值（沿用现有系统阈值，本轮不改）

// null / undefined / '' 表示「未填写/待更新」；0 是真实记录值。两者不可混为一谈。
function toOptionalPlayNumber(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * Alpha.3-02：creator_records.total_cost → 实际合作价（严格空值语义）
 * - null / undefined / '' → null（缺失 → 展示「上次合作价暂无」）
 * - 0 是真实记录值，原样保留（展示 ¥0）
 * 注意：CPM / 爆款等既有口径仍走 computePlayMetrics 的 `Number(total_cost) || 0`，本函数不影响它。
 */
function toActualCostNumber(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function round2(value) {
  return Number(value.toFixed(2))
}

function round1(value) {
  return Number(value.toFixed(1))
}

/**
 * 解析单条记录的播放口径
 * @param {Object} row 记录（含 total_cost / first_play / second_week_play）
 */
export function computePlayMetrics(row = {}) {
  const cost = Number(row.total_cost) || 0
  const first = toOptionalPlayNumber(row.first_play)
  const latest = toOptionalPlayNumber(row.second_week_play)
  const hasFirst = first !== null
  const hasLatest = latest !== null
  // latest < first 属于异常历史数据：不产生负增长，只计入 anomaly
  const latestAnomaly = hasFirst && hasLatest && latest < first
  const post7dGrowth = hasFirst && hasLatest && !latestAnomaly ? latest - first : null
  return {
    cost,
    first,
    latest,
    hasFirst,
    hasLatest,
    firstPositive: hasFirst && first > 0,
    post7dGrowth,
    latestAnomaly
  }
}

/** 播放口径累计器（周 / 范围 / 达人三级共用） */
export function createPlayAccumulator() {
  return {
    total_cost: 0, // 全部记录花费
    record_count: 0, // 全部记录数（真实投放次数，不因 latest 缺失而减少）
    creatorSet: new Set(),
    creatorPlay: new Map(), // 达人 -> Σ有效 latest（播放占比图使用最新累计口径）
    first_play_total: 0, // Σ 7日累计
    latest_play_total: 0, // Σ 有效 latest
    post_7d_growth_total: 0, // Σ 有效(latest - first)
    first_sample_count: 0, // 有有效 first（含 0）的记录数 → 7日爆款率分母 / 7日CPM 样本
    first_positive_sample_count: 0, // first > 0 的记录数（仅统计参考，不参与分子口径）
    // 有效 latest 样本：latest 已填写 **且 latest >= first**（latest < first 视为异常、不可信，不计入）
    latest_sample_count: 0,
    // 7日CPM 分子：只要 first_play 是「已填写」的有效观察值（含 0）就计入其花费
    // （0 是真实表现，不是缺失；缺失 = null/undefined/空字符串，其花费不进分子）
    first_valid_cost: 0,
    latest_valid_cost: 0, // 有有效 latest 的记录花费 → 最新平均CPM 分子
    hit_7d_count: 0, // 7日爆款：first >= 阈值
    hit_latest_count: 0, // 累计爆款：latest >= 阈值（仅有效 latest 样本）
    anomaly_count: 0 // latest < first 的异常记录数（不参与任何 latest 指标）
  }
}

/** 把一条记录的播放口径累加进累计器 */
export function accumulatePlay(acc, metrics, nickname = '') {
  const name = String(nickname || '').trim()
  acc.total_cost += metrics.cost
  acc.record_count += 1
  if (name) acc.creatorSet.add(name)

  if (metrics.hasFirst) {
    acc.first_play_total += metrics.first
    acc.first_sample_count += 1
    // first_play 已填写（含 0）即视为有效观察值：其花费进入 7日CPM 分子
    acc.first_valid_cost += metrics.cost
    if (metrics.first > 0) acc.first_positive_sample_count += 1
    if (metrics.first >= HOT_PLAY_THRESHOLD) acc.hit_7d_count += 1
  }

  // latest 只有「已填写且 latest >= first」才算有效观察值。
  // latest < first 判定为异常、不可信：不参与 total_play / avg_cpm / 累计爆款 / 7日后新增 / 播放占比，
  // 但仍然参与 total_cost / 投放次数 / 达人数 / 7日累计 / 7日CPM / 7日爆款等不依赖 latest 的指标。
  const latestUsable = metrics.hasLatest && !metrics.latestAnomaly
  if (latestUsable) {
    acc.latest_play_total += metrics.latest
    acc.latest_sample_count += 1
    acc.latest_valid_cost += metrics.cost
    if (metrics.latest >= HOT_PLAY_THRESHOLD) acc.hit_latest_count += 1
    if (name && metrics.latest > 0) {
      acc.creatorPlay.set(name, (acc.creatorPlay.get(name) || 0) + metrics.latest)
    }
  }

  if (metrics.post7dGrowth !== null) acc.post_7d_growth_total += metrics.post7dGrowth
  if (metrics.latestAnomaly) acc.anomaly_count += 1
  return acc
}

/**
 * 累计器 → 对外汇总字段
 * - total_play 采用「最新累计播放量」口径（Σ有效 latest）
 * - 分子只统计与分母同一样本的记录花费，避免把「最新累计待更新」记录的花费算进 CPM
 * - 无有效样本时 CPM / 爆款率返回 null，绝不返回 0 / NaN / Infinity
 */
export function finalizePlayAccumulator(acc) {
  const avgCpm =
    acc.latest_play_total > 0 ? round2((acc.latest_valid_cost / acc.latest_play_total) * 1000) : null
  // 7日CPM：分母 = Σ所有「已填写」first_play（含 0）；分子 = 这些记录的花费（含 first=0 的记录）
  // Σfirst = 0（全部观察值都是 0）时返回 null，不返回 Infinity / 0
  const cpm7d =
    acc.first_play_total > 0 ? round2((acc.first_valid_cost / acc.first_play_total) * 1000) : null
  const hitRateLatest =
    acc.latest_sample_count > 0
      ? round1((acc.hit_latest_count / acc.latest_sample_count) * 100)
      : null
  const hitRate7d =
    acc.first_sample_count > 0 ? round1((acc.hit_7d_count / acc.first_sample_count) * 100) : null

  return {
    total_cost: round2(acc.total_cost),
    record_count: acc.record_count,
    creator_count: acc.creatorSet.size,
    total_play: acc.latest_play_total,
    latest_play_total: acc.latest_play_total,
    first_play_total: acc.first_play_total,
    post_7d_growth_total: acc.post_7d_growth_total,
    avg_cpm: avgCpm,
    cpm_7d: cpm7d,
    hit_7d_count: acc.hit_7d_count,
    hit_latest_count: acc.hit_latest_count,
    // 兼容旧字段：hit_count / hit_rate 暂时等于「累计爆款 / 累计爆款率」（主爆款）
    hit_count: acc.hit_latest_count,
    hit_rate_latest: hitRateLatest,
    hit_rate_7d: hitRate7d,
    hit_rate: hitRateLatest,
    first_sample_count: acc.first_sample_count,
    first_positive_sample_count: acc.first_positive_sample_count,
    latest_sample_count: acc.latest_sample_count,
    // 最新累计「待更新」投放数（null / undefined / 空字符串）；
    // 异常记录（latest < first）单独计入 anomaly_count，不算「待更新」
    latest_pending_count: acc.record_count - acc.latest_sample_count - acc.anomaly_count,
    anomaly_count: acc.anomaly_count
  }
}

/** 一组记录的播放口径汇总（纯函数，供单测与聚合复用） */
export function summarizePlayRecords(rows = []) {
  const acc = createPlayAccumulator()
  for (const row of rows) {
    accumulatePlay(acc, computePlayMetrics(row), row?.nickname)
  }
  return finalizePlayAccumulator(acc)
}

/**
 * 按周聚合播放量/花费，同时产出两套口径：
 * - campaign（投放周，主口径）：按新定义聚合，latest 归投放周
 * - occurrence（发生周）：**保持旧的迁移实现**（把 second_week_play 当作「下一周新增」）
 *
 * TODO(occurrence): 现有 occurrence 建立在「second_week_play = 下一周新增播放」的旧假设上，
 * 与新产品定义（second_week_play = 最新累计播放量）不兼容；当前库里只有「7日累计 + 最新累计」
 * 两个快照，没有周级 snapshot，无法还原每周新增。本轮不重构 occurrence、不发明替代算法，
 * 待后续 snapshot Batch 处理；同时保证 campaign 新逻辑不再依赖 first + second。
 *
 * @param {Array<Object>} rows 投放记录（已按筛选条件过滤）
 * @returns {{ campaignMap: Map, occurrenceMap: Map }}
 */
function aggregateWeekly(rows) {

  // campaign（投放周，主口径）：新定义累计器（latest 归投放周）
  const createCampaignBucket = (weekCode) => ({ weekCode, play: createPlayAccumulator() })
  // occurrence（发生周）：旧口径结构，保持原实现（TODO(occurrence)：待 snapshot Batch 重构）
  const createLegacyBucket = (weekCode) => ({
    weekCode,
    total_play: 0,
    first_play_total: 0,
    second_week_play_total: 0,
    total_cost: 0,
    record_count: 0,
    creators: new Map(),
    creatorSet: new Set()
  })
  const campaignMap = new Map()
  const occurrenceMap = new Map()
  const getCampaignBucket = (weekCode) => {
    if (!campaignMap.has(weekCode)) campaignMap.set(weekCode, createCampaignBucket(weekCode))
    return campaignMap.get(weekCode)
  }
  const getLegacyBucket = (weekCode) => {
    if (!occurrenceMap.has(weekCode)) occurrenceMap.set(weekCode, createLegacyBucket(weekCode))
    return occurrenceMap.get(weekCode)
  }

  for (const row of rows) {
    const weekCode = normalizeWeekCode(row.time_cycle)
    if (!weekCode) continue

    const nickname = String(row.nickname || '').trim()

    // 投放周口径（新定义）：latest（最新累计播放）归投放周；不再使用 first + second
    const campaign = getCampaignBucket(weekCode)
    accumulatePlay(campaign.play, computePlayMetrics(row), nickname)

    // ---- 以下为 occurrence 旧口径（TODO(occurrence)：与新产品定义不兼容，待 snapshot Batch 重构）----
    const cost = Number(row.total_cost) || 0
    const firstPlay = Number(row.first_play) || 0
    const secondPlay = Number(row.second_week_play) || 0

    // 发生周口径：首发归投放周；次周播放量归投放周的下一周（空值/0 不产生事件；跨年自动正确）
    const occurrence = getLegacyBucket(weekCode)
    occurrence.total_cost += cost
    occurrence.record_count += 1
    if (nickname) occurrence.creatorSet.add(nickname)
    occurrence.first_play_total += firstPlay
    occurrence.total_play += firstPlay
    if (nickname && firstPlay > 0) {
      occurrence.creators.set(nickname, (occurrence.creators.get(nickname) || 0) + firstPlay)
    }

    if (secondPlay > 0) {
      const nextWeekCode = getNextWeek(weekCode)
      if (nextWeekCode) {
        const nextBucket = getLegacyBucket(nextWeekCode)
        nextBucket.second_week_play_total += secondPlay
        nextBucket.total_play += secondPlay
        if (nickname) {
          nextBucket.creators.set(
            nickname,
            (nextBucket.creators.get(nickname) || 0) + secondPlay
          )
        }
      }
    }
  }

  return { campaignMap, occurrenceMap }
}

// 周度结果序列化（额外提供 week_code 别名，便于 BI 侧使用）
// - campaign：新口径字段（total_play = Σ有效最新累计播放）
// - occurrence：旧字段保持不变，新口径字段显式返回 null（TODO(occurrence)）
function serializeBucket(bucket, caliber) {
  if (caliber === 'campaign') {
    const summary = finalizePlayAccumulator(bucket.play)
    return {
      weekCode: bucket.weekCode,
      week_code: bucket.weekCode,
      caliber,
      ...summary,
      // 兼容旧字段命名：second_week_play_total / second_play_total = Σ最新累计播放
      second_week_play_total: summary.latest_play_total,
      second_play_total: summary.latest_play_total,
      creators: [...bucket.play.creatorPlay.entries()]
        .map(([nickname, play]) => ({ nickname, play }))
        .sort((a, b) => b.play - a.play)
    }
  }

  return {
    weekCode: bucket.weekCode,
    week_code: bucket.weekCode,
    caliber,
    total_play: bucket.total_play,
    first_play_total: bucket.first_play_total,
    second_week_play_total: bucket.second_week_play_total,
    // 兼容需求字段命名：second_play_total 与 second_week_play_total 同值
    second_play_total: bucket.second_week_play_total,
    total_cost: Number(bucket.total_cost.toFixed(2)),
    creator_count: bucket.creatorSet.size,
    record_count: bucket.record_count,
    creators: [...bucket.creators.entries()]
      .map(([nickname, play]) => ({ nickname, play }))
      .sort((a, b) => b.play - a.play),
    // 新口径字段在 occurrence 下暂不可用（TODO(occurrence)）：显式 null，避免被当成 0
    latest_play_total: null,
    post_7d_growth_total: null,
    avg_cpm: null,
    cpm_7d: null,
    hit_7d_count: null,
    hit_latest_count: null,
    hit_count: null,
    hit_rate_7d: null,
    hit_rate_latest: null,
    hit_rate: null,
    first_sample_count: null,
    first_positive_sample_count: null,
    latest_sample_count: null,
    latest_pending_count: null,
    anomaly_count: null
  }
}

// 空周结构（无数据周补零，保证趋势图连续）
function emptyBucket(weekCode, caliber = 'campaign') {
  if (caliber === 'campaign') {
    return { weekCode, play: createPlayAccumulator() }
  }
  return {
    weekCode,
    total_play: 0,
    first_play_total: 0,
    second_week_play_total: 0,
    total_cost: 0,
    record_count: 0,
    creators: new Map(),
    creatorSet: new Set()
  }
}

// 周码区间展开（升序、含空周；最多 300 周，防止异常参数造成超大循环）
function expandWeekRange(startWeek, endWeek) {
  const list = []
  let current = normalizeWeekCode(startWeek)
  const end = normalizeWeekCode(endWeek)
  if (!current || !end || current > end) return list
  while (current && current <= end && list.length < 300) {
    list.push(current)
    current = getNextWeek(current)
  }
  return list
}

// ---------- 周度播放量聚合（V2 仅开放 campaign 投放周） ----------
router.get('/week-stats', (req, res) => {
  const rawWeekCode = req.query.weekCode
  const caliber = String(req.query.caliber || 'campaign').trim().toLowerCase()
  if (!['campaign', 'occurrence'].includes(caliber)) {
    return fail(res, 400, 'caliber 必须为 campaign 或 occurrence')
  }
  if (caliber === 'occurrence') return fail(res, 400, '按发生周暂未开放')
  let targetWeekCode = null
  if (rawWeekCode !== undefined && rawWeekCode !== '') {
    targetWeekCode = normalizeWeekCode(rawWeekCode)
    if (!targetWeekCode) {
      return fail(res, 400, 'weekCode 格式必须为 YYYY-Wxx')
    }
  }

  // 新增可选筛选参数（不传时与原有行为完全一致）
  const creatorTypes = parseCsvParam(req.query.creatorTypes)
  const nicknames = parseCsvParam(req.query.nicknames)
  const rawStartWeek = req.query.startWeek
  const rawEndWeek = req.query.endWeek
  const hasRange =
    (rawStartWeek !== undefined && rawStartWeek !== '') ||
    (rawEndWeek !== undefined && rawEndWeek !== '')

  // ---------- 原有单周 / 全量列表分支（向下兼容，逻辑与修改前一致） ----------
  if (!hasRange) {
    const rows = queryAggregateRows({ creatorTypes, nicknames })
    const { campaignMap, occurrenceMap } = aggregateWeekly(rows)
    const activeMap = caliber === 'campaign' ? campaignMap : occurrenceMap

    // 指定周：返回该周统计（无数据返回零值结构，便于前端展示）
    if (targetWeekCode) {
      const bucket = activeMap.get(targetWeekCode)
      return ok(
        res,
        bucket
          ? serializeBucket(bucket, caliber)
          : {
              weekCode: targetWeekCode,
              week_code: targetWeekCode,
              caliber,
              total_play: 0,
              latest_play_total: 0,
              first_play_total: 0,
              second_week_play_total: 0,
              second_play_total: 0,
              post_7d_growth_total: 0,
              total_cost: 0,
              creator_count: 0,
              record_count: 0,
              creators: [],
              avg_cpm: null,
              cpm_7d: null,
              hit_7d_count: 0,
              hit_latest_count: 0,
              hit_count: 0,
              hit_rate_7d: null,
              hit_rate_latest: null,
              hit_rate: null,
              first_sample_count: 0,
              first_positive_sample_count: 0,
              latest_sample_count: 0,
              latest_pending_count: 0,
              anomaly_count: 0
            }
      )
    }

    const weeks = [...activeMap.values()]
      .map((bucket) => serializeBucket(bucket, caliber))
      .sort((a, b) => (a.weekCode < b.weekCode ? 1 : -1))
    return ok(res, {
      caliber,
      weeks,
      earliestWeek: weeks.length ? weeks[weeks.length - 1].weekCode : null,
      latestWeek: weeks.length ? weeks[0].weekCode : null
    })
  }

  // ---------- 周范围分支（BI 趋势：按周升序返回 + 范围汇总） ----------
  const startWeek = rawStartWeek ? normalizeWeekCode(rawStartWeek) : null
  const endWeek = rawEndWeek ? normalizeWeekCode(rawEndWeek) : null
  if (rawStartWeek && !startWeek) return fail(res, 400, 'startWeek 格式必须为 YYYY-Wxx')
  if (rawEndWeek && !endWeek) return fail(res, 400, 'endWeek 格式必须为 YYYY-Wxx')
  if (startWeek && endWeek && startWeek > endWeek) {
    return fail(res, 400, 'startWeek 不能晚于 endWeek')
  }

  // 发生周口径：起始周的前一周也要参与聚合（它的「次周播放量」发生在起始周）
  const baseStartWeek =
    caliber === 'occurrence' && startWeek ? getPrevWeek(startWeek) : startWeek
  const rows = queryAggregateRows({
    startWeek: baseStartWeek,
    endWeek,
    creatorTypes,
    nicknames
  })
  const { campaignMap, occurrenceMap } = aggregateWeekly(rows)
  const activeMap = caliber === 'campaign' ? campaignMap : occurrenceMap

  const allCodes = [...activeMap.keys()].sort()
  const rangeStart = startWeek || allCodes[0] || null
  const rangeEnd = endWeek || allCodes[allCodes.length - 1] || null
  const weekCodes = rangeStart && rangeEnd ? expandWeekRange(rangeStart, rangeEnd) : []

  // 空数据周补零，保证趋势图连续无断点
  const weeks = weekCodes.map((code) => {
    const bucket = activeMap.get(code)
    return serializeBucket(bucket || emptyBucket(code, caliber), caliber)
  })

  // 范围汇总：花费/达人/记录数按投放周统计（落在所选周范围内的记录）
  const inRangeRecords = rows.filter((row) => {
    const code = normalizeWeekCode(row.time_cycle)
    if (!code) return false
    if (rangeStart && code < rangeStart) return false
    if (rangeEnd && code > rangeEnd) return false
    return true
  })

  let totalSummary
  if (caliber === 'campaign') {
    // 新口径：total_play = Σ有效最新累计播放；CPM 分子只统计与分母同一样本记录的花费
    const summary = summarizePlayRecords(inRangeRecords)
    totalSummary = {
      startWeek: rangeStart,
      endWeek: rangeEnd,
      weekCount: weeks.length,
      ...summary,
      // 兼容旧字段命名：second_play_total = Σ最新累计播放
      second_play_total: summary.latest_play_total
    }
  } else {
    // TODO(occurrence): 保持旧实现（second_week_play 视为下一周新增），与新产品定义不兼容，
    // 待 snapshot Batch 重构；新口径字段在 occurrence 下显式返回 null，避免被当成 0。
    const rangeCreatorSet = new Set()
    let summaryCost = 0
    for (const row of inRangeRecords) {
      summaryCost += Number(row.total_cost) || 0
      const nickname = String(row.nickname || '').trim()
      if (nickname) rangeCreatorSet.add(nickname)
    }
    const totalPlay = weeks.reduce((sum, week) => sum + week.total_play, 0)
    totalSummary = {
      startWeek: rangeStart,
      endWeek: rangeEnd,
      weekCount: weeks.length,
      total_play: totalPlay,
      first_play_total: weeks.reduce((sum, week) => sum + week.first_play_total, 0),
      second_play_total: weeks.reduce((sum, week) => sum + week.second_play_total, 0),
      total_cost: Number(summaryCost.toFixed(2)),
      avg_cpm: totalPlay > 0 ? Number(((summaryCost / totalPlay) * 1000).toFixed(2)) : null,
      creator_count: rangeCreatorSet.size,
      record_count: inRangeRecords.length,
      latest_play_total: null,
      post_7d_growth_total: null,
      cpm_7d: null,
      hit_7d_count: null,
      hit_latest_count: null,
      hit_count: null,
      hit_rate_7d: null,
      hit_rate_latest: null,
      hit_rate: null,
      first_sample_count: null,
      latest_sample_count: null
    }
  }

  return ok(res, {
    caliber,
    range: { startWeek: rangeStart, endWeek: rangeEnd },
    weeks,
    total_summary: totalSummary,
    filters: { creatorTypes, nicknames }
  })
})

// 数据覆盖的周范围（发生周口径包含「有次周播放量的下一周」，与筛选元数据一致）
function resolveDataWeekRange(caliber = 'campaign') {
  const rows = db
    .prepare(
      `SELECT time_cycle, second_week_play
       FROM creator_records`
    )
    .all()
  let earliest = null
  let latest = null
  for (const row of rows) {
    const code = normalizeWeekCode(row.time_cycle)
    if (!code) continue
    if (!earliest || code < earliest) earliest = code
    if (!latest || code > latest) latest = code
  }
  if (caliber === 'occurrence') {
    for (const row of rows) {
      const code = normalizeWeekCode(row.time_cycle)
      if (!code || (Number(row.second_week_play) || 0) <= 0) continue
      const nextCode = getNextWeek(code)
      if (nextCode && (!latest || nextCode > latest)) latest = nextCode
    }
  }
  return { earliestWeek: earliest, latestWeek: latest }
}

/**
 * 达人维度汇总（按昵称横向聚合，口径与看板一致）
 * - 总花费 / 投放次数：按投放周统计（记录归属周落在筛选范围内）
 * - 播放量：campaign = 范围内记录的首发+次周；occurrence = 范围内记录的首发 + 落到范围内的上一周投放的次周
 */
// 爆款阈值统一定义在文件上方的「播放口径核心」处（7日爆款 = first_play >= 阈值；累计爆款 = second_week_play >= 阈值）
// 达人汇总可排序字段（白名单，避免注入）
const CREATOR_SORT_FIELDS = [
  'total_cost',
  'total_play',
  'total_campaigns',
  'avg_cpm',
  'hit_count',
  'avg_play',
  'repeat_count',
  'first_play_sum',
  'second_play_sum',
  // 新口径字段（Batch 1 新增）
  'latest_play_total',
  'post_7d_growth_total',
  'cpm_7d',
  'hit_7d_count',
  'hit_latest_count',
  'hit_rate_7d',
  'hit_rate_latest',
  'latest_sample_count',
  'latest_pending_count'
]

/**
 * 达人维度汇总统一入口
 * - campaign（投放周，主口径）：新定义（second_week_play = 最新累计播放量）
 * - occurrence：保持旧实现（TODO(occurrence)：与新产品定义不兼容，待 snapshot Batch 重构）
 */
function buildCreatorSummary(options = {}) {
  const caliber = String(options?.caliber || 'campaign').trim().toLowerCase()
  if (caliber === 'occurrence') return buildCreatorSummaryLegacyOccurrence(options)
  return buildCreatorSummaryLatest(options)
}

/**
 * 达人维度汇总（新口径 / campaign 投放周）
 * - 每条记录：latest（最新累计播放）归投放周；total_play = Σ有效 latest（不再用 first + second）
 * - 最新平均CPM = 有 latest 记录的花费 ÷ 这些记录的 latest 总和 × 1000
 * - 7日平均CPM = first>0 记录的花费 ÷ 这些记录 first 总和 × 1000
 * - 累计爆款 = latest >= 阈值（主爆款）；7日爆款 = first >= 阈值
 * - total_campaigns / total_cost 统计范围内全部记录，不因 latest 缺失而减少
 */
function buildCreatorSummaryLatest({
  startWeek,
  endWeek,
  creatorTypes = [],
  keyword = '',
  minCampaigns = 0,
  sortBy = 'total_cost',
  sortOrder = 'desc'
} = {}) {
  // ---------- 身份模式 ----------
  // identity：达人库 = creators（含 zero-history Creator），metrics 由 creator_id 的 records 聚合
  // legacy：保持原有 nickname 聚合（老 fixture / 未迁移库）
  const identityMode = creatorIdentityReady()
  const libraryCreators = identityMode ? loadLibraryCreators({ creatorTypes, keyword }) : null
  // identity 模式下类型 / 关键词作用于 Creator（不是记录），因此记录只按周范围取
  const rows = identityMode
    ? queryAggregateRows({ startWeek, endWeek }, { withCreatorId: true })
    : queryAggregateRows({ startWeek, endWeek, creatorTypes, keyword })

  const creatorMap = new Map()
  let unattributedRecordCount = 0
  const createEntry = ({ key, creatorId = null, displayName, creatorType }) => {
    if (!creatorMap.has(key)) {
      creatorMap.set(key, {
        key,
        creator_id: creatorId,
        nickname: displayName,
        creator_type: creatorType,
        acc: createPlayAccumulator()
      })
    }
    const entry = creatorMap.get(key)
    // 同一身份出现多个类型时，保留首个非空类型
    if (!entry.creator_type && creatorType) entry.creator_type = creatorType
    return entry
  }

  if (identityMode) {
    // Creator 是身份来源：没有历史投放的 Creator 也必须出现在达人库（zero-history）
    for (const creator of libraryCreators) {
      createEntry({
        key: creator.creator_id,
        creatorId: creator.creator_id,
        displayName: String(creator.canonical_name || '').trim() || '未命名达人',
        creatorType: String(creator.creator_type || '').trim() || '未分类'
      })
    }
  }

  for (const row of rows) {
    const code = normalizeWeekCode(row.time_cycle)
    if (!code) continue
    if (startWeek && code < startWeek) continue
    if (endWeek && code > endWeek) continue
    if (identityMode) {
      // 归属锚为 NULL 的记录绝不聚合成任何 Creator（更不形成「未知达人」超级行）
      const creatorId = row.creator_id === null || row.creator_id === undefined ? null : Number(row.creator_id)
      if (creatorId === null) {
        unattributedRecordCount += 1
        continue
      }
      const entry = creatorMap.get(creatorId)
      // 被 Creator 类型 / 关键词过滤掉的身份：其记录不进入任何被返回的行
      if (!entry) continue
      accumulatePlay(entry.acc, computePlayMetrics(row), entry.nickname || '未命名达人')
      continue
    }
    const nickname = String(row.nickname || '').trim() || '未命名达人'
    const creatorType = String(row.creator_type || '').trim() || '未分类'
    const entry = createEntry({ key: nickname, displayName: nickname, creatorType })
    accumulatePlay(entry.acc, computePlayMetrics(row), nickname)
  }

  const serializeCreator = (entry) => {
    const summary = finalizePlayAccumulator(entry.acc)
    return {
      // identity 模式下 creator_id 是行身份；legacy 模式不携带该字段
      ...(entry.creator_id === null || entry.creator_id === undefined
        ? {}
        : { creator_id: entry.creator_id }),
      // canonical_name（identity 模式 = Creator 权威名）；nickname 保留为兼容别名（同一显示名）
      ...(entry.creator_id === null || entry.creator_id === undefined
        ? {}
        : { canonical_name: entry.nickname }),
      nickname: entry.nickname,
      creator_type: entry.creator_type,
      total_campaigns: summary.record_count,
      total_cost: summary.total_cost,
      // 主口径：总播放 = Σ有效最新累计播放（字段名保持兼容，语义已更新）
      total_play: summary.total_play,
      latest_play_total: summary.latest_play_total,
      // 兼容旧字段名：first_play_sum = Σ7日累计；second_play_sum = Σ最新累计
      first_play_sum: summary.first_play_total,
      second_play_sum: summary.latest_play_total,
      post_7d_growth_total: summary.post_7d_growth_total,
      avg_cpm: summary.avg_cpm,
      cpm_7d: summary.cpm_7d,
      hit_count: summary.hit_count,
      hit_7d_count: summary.hit_7d_count,
      hit_latest_count: summary.hit_latest_count,
      hit_rate_7d: summary.hit_rate_7d,
      hit_rate_latest: summary.hit_rate_latest,
      first_sample_count: summary.first_sample_count,
      latest_sample_count: summary.latest_sample_count,
      latest_pending_count: summary.latest_pending_count,
      anomaly_count: summary.anomaly_count,
      // 平均单条播放：按「已更新最新累计」的样本平均
      // （旧定义除以全部投放次数，会把「最新累计待更新」的记录当成 0 拉低均值）
      avg_play:
        summary.latest_sample_count > 0
          ? round1(summary.latest_play_total / summary.latest_sample_count)
          : null,
      repeat_count: summary.record_count > 0 ? summary.record_count - 1 : 0,
      // 供分组聚合精确计算组级 CPM 使用（分子必须与分母同一样本）
      latest_valid_cost: round2(entry.acc.latest_valid_cost),
      first_valid_cost: round2(entry.acc.first_valid_cost)
    }
  }

  const minCampaignsValue = Number(minCampaigns) > 0 ? Math.floor(Number(minCampaigns)) : 0
  const sortField = CREATOR_SORT_FIELDS.includes(sortBy) ? sortBy : 'total_cost'
  const sortDirection = String(sortOrder).toLowerCase() === 'asc' ? 'asc' : 'desc'

  const creators = [...creatorMap.values()]
    .map(serializeCreator)
    // 最小投放次数过滤（默认不限）
    .filter((item) => item.total_campaigns >= minCampaignsValue)
    .sort((a, b) => {
      const left = a[sortField]
      const right = b[sortField]
      // 空值（如无有效 latest 时的 avg_cpm / cpm_7d / 爆款率）始终排在最后
      const leftNull = left === null || left === undefined
      const rightNull = right === null || right === undefined
      if (leftNull && rightNull) return 0
      if (leftNull) return 1
      if (rightNull) return -1
      if (left === right) {
        return b.total_cost - a.total_cost || b.total_play - a.total_play
      }
      return sortDirection === 'asc' ? left - right : right - left
    })

  // 原始累计器按「身份键」索引（identity = creator_id，legacy = nickname），
  // 供分组聚合取到未经序列化的分子/分母（组级 CPM 必须同一样本）
  const rawAccByKey = new Map(
    creators.map((item) => {
      const key = summaryRowKey(item)
      return [key, creatorMap.get(key).acc]
    })
  )
  const rawAccs = [...rawAccByKey.values()]
  const rawTotalCost = rawAccs.reduce((sum, acc) => sum + acc.total_cost, 0)
  const rawLatestValidCost = rawAccs.reduce((sum, acc) => sum + acc.latest_valid_cost, 0)
  const rawFirstValidCost = rawAccs.reduce((sum, acc) => sum + acc.first_valid_cost, 0)

  // 总汇总：与达人明细同一套口径（成本/次数按全部记录，播放/CPM/爆款按有效样本）
  const totalSummary = {
    creator_count: creators.length,
    record_count: creators.reduce((sum, item) => sum + item.total_campaigns, 0),
    total_cost: round2(rawTotalCost),
    first_play_total: creators.reduce((sum, item) => sum + item.first_play_sum, 0),
    latest_play_total: creators.reduce((sum, item) => sum + item.latest_play_total, 0),
    post_7d_growth_total: creators.reduce((sum, item) => sum + item.post_7d_growth_total, 0),
    first_sample_count: creators.reduce((sum, item) => sum + item.first_sample_count, 0),
    latest_sample_count: creators.reduce((sum, item) => sum + item.latest_sample_count, 0),
    hit_7d_count: creators.reduce((sum, item) => sum + item.hit_7d_count, 0),
    hit_latest_count: creators.reduce((sum, item) => sum + item.hit_latest_count, 0),
    anomaly_count: creators.reduce((sum, item) => sum + item.anomaly_count, 0),
    latest_valid_cost: round2(rawLatestValidCost),
    first_valid_cost: round2(rawFirstValidCost)
  }
  totalSummary.total_play = totalSummary.latest_play_total
  totalSummary.total_campaigns = totalSummary.record_count
  // 兼容旧字段名
  totalSummary.first_play_sum = totalSummary.first_play_total
  totalSummary.second_play_sum = totalSummary.latest_play_total
  totalSummary.avg_cpm =
    totalSummary.latest_play_total > 0
      ? round2((rawLatestValidCost / totalSummary.latest_play_total) * 1000)
      : null
  totalSummary.cpm_7d =
    totalSummary.first_play_total > 0
      ? round2((rawFirstValidCost / totalSummary.first_play_total) * 1000)
      : null
  totalSummary.hit_count = totalSummary.hit_latest_count
  totalSummary.total_hits = totalSummary.hit_latest_count
  totalSummary.hit_rate_latest =
    totalSummary.latest_sample_count > 0
      ? round1((totalSummary.hit_latest_count / totalSummary.latest_sample_count) * 100)
      : null
  totalSummary.hit_rate_7d =
    totalSummary.first_sample_count > 0
      ? round1((totalSummary.hit_7d_count / totalSummary.first_sample_count) * 100)
      : null
  totalSummary.hit_rate = totalSummary.hit_rate_latest
  totalSummary.latest_pending_count =
    totalSummary.record_count - totalSummary.latest_sample_count - totalSummary.anomaly_count

  return {
    range: { startWeek: startWeek || null, endWeek: endWeek || null },
    creatorTypes,
    keyword,
    minCampaigns: minCampaignsValue,
    identity_mode: identityMode,
    // 未归属（creator_id = NULL）的真实记录数：事实仍在投放记录里，但不进入任何 Creator 指标
    unattributed_record_count: unattributedRecordCount,
    sort: { sortBy: sortField, sortOrder: sortDirection },
    creators,
    total_summary: totalSummary,
    rawAccByKey
  }
}

/**
 * 达人维度汇总（旧实现 / occurrence 发生周）
 * TODO(occurrence): 该实现把 second_week_play 当作「下一周新增播放」并跨周搬移，
 * 与新产品定义（second_week_play = 最新累计播放量）不兼容；本轮保留以维持既有接口可用性，
 * 待后续 snapshot Batch 重构（不发明替代算法）。
 */
function buildCreatorSummaryLegacyOccurrence({
  startWeek,
  endWeek,
  caliber = 'occurrence',
  creatorTypes = [],
  keyword = '',
  minCampaigns = 0,
  sortBy = 'total_cost',
  sortOrder = 'desc'
} = {}) {
  const dataRange = resolveDataWeekRange(caliber)
  const rangeStart = startWeek || dataRange.earliestWeek
  const rangeEnd = endWeek || dataRange.latestWeek

  // 发生周口径：起始周的前一周记录，其次周播放发生在范围内，需要一并取出
  const baseStartWeek =
    caliber === 'occurrence' && rangeStart ? getPrevWeek(rangeStart) : rangeStart
  const rows = queryAggregateRows({
    startWeek: baseStartWeek,
    endWeek: rangeEnd,
    creatorTypes,
    keyword
  })

  const creatorMap = new Map()
  const getCreator = (nickname, creatorType) => {
    if (!creatorMap.has(nickname)) {
      creatorMap.set(nickname, {
        nickname,
        creator_type: creatorType,
        total_campaigns: 0,
        total_cost: 0,
        first_play_sum: 0,
        second_play_sum: 0,
        total_play: 0,
        // 爆款数（范围内首发播放量 >= 10 万的记录条数）
        hit_count: 0
      })
    }
    const agg = creatorMap.get(nickname)
    // 同一昵称出现多个类型时，保留出现次数更多的类型（此处按首个非空类型记录）
    if (!agg.creator_type && creatorType) agg.creator_type = creatorType
    return agg
  }

  for (const row of rows) {
    const code = normalizeWeekCode(row.time_cycle)
    if (!code) continue
    const nickname = String(row.nickname || '').trim() || '未命名达人'
    const creatorType = String(row.creator_type || '').trim() || '未分类'
    const inRange = (!rangeStart || code >= rangeStart) && (!rangeEnd || code <= rangeEnd)
    const nextCode = getNextWeek(code)
    const nextInRange =
      caliber === 'occurrence' &&
      nextCode &&
      (!rangeStart || nextCode >= rangeStart) &&
      (!rangeEnd || nextCode <= rangeEnd)
    if (!inRange && !nextInRange) continue

    const cost = Number(row.total_cost) || 0
    const firstPlay = Number(row.first_play) || 0
    const secondPlay = Number(row.second_week_play) || 0
    const agg = getCreator(nickname, creatorType)

    if (inRange) {
      agg.total_campaigns += 1
      agg.total_cost += cost
      agg.first_play_sum += firstPlay
      // 爆款按投放周首发播放量判定（与看板口径一致，不随口径切换）
      if (firstPlay >= HOT_PLAY_THRESHOLD) agg.hit_count += 1
      if (caliber === 'campaign') {
        agg.second_play_sum += secondPlay
        agg.total_play += firstPlay + secondPlay
      } else {
        agg.total_play += firstPlay
      }
    }
    // 发生周口径：次周播放量归属投放周的下一周
    if (nextInRange && secondPlay > 0) {
      agg.second_play_sum += secondPlay
      agg.total_play += secondPlay
    }
  }

  const serializeCreator = (agg) => ({
    nickname: agg.nickname,
    creator_type: agg.creator_type,
    total_campaigns: agg.total_campaigns,
    total_cost: Number(agg.total_cost.toFixed(2)),
    first_play_sum: agg.first_play_sum,
    second_play_sum: agg.second_play_sum,
    total_play: agg.total_play,
    avg_cpm: agg.total_play > 0 ? Number(((agg.total_cost / agg.total_play) * 1000).toFixed(2)) : null,
    // 新增：爆款数 / 平均单条播放（保留 1 位小数）/ 复投次数（0 表示首次投放）
    hit_count: agg.hit_count,
    avg_play:
      agg.total_campaigns > 0
        ? Number((agg.total_play / agg.total_campaigns).toFixed(1))
        : null,
    repeat_count: agg.total_campaigns > 0 ? agg.total_campaigns - 1 : 0
  })

  const minCampaignsValue = Number(minCampaigns) > 0 ? Math.floor(Number(minCampaigns)) : 0
  const sortField = CREATOR_SORT_FIELDS.includes(sortBy) ? sortBy : 'total_cost'
  const sortDirection = String(sortOrder).toLowerCase() === 'asc' ? 'asc' : 'desc'

  const creators = [...creatorMap.values()]
    .map(serializeCreator)
    // 最小投放次数过滤（默认不限）
    .filter((item) => item.total_campaigns >= minCampaignsValue)
    .sort((a, b) => {
      const left = a[sortField]
      const right = b[sortField]
      // 空值（如无播放时的 avg_cpm/avg_play）始终排在最后
      const leftNull = left === null || left === undefined
      const rightNull = right === null || right === undefined
      if (leftNull && rightNull) return 0
      if (leftNull) return 1
      if (rightNull) return -1
      if (left === right) {
        // 同值时按总花费、总播放兜底排序，保证结果稳定
        return b.total_cost - a.total_cost || b.total_play - a.total_play
      }
      return sortDirection === 'asc' ? left - right : right - left
    })

  const totalSummary = {
    creator_count: creators.length,
    total_campaigns: creators.reduce((sum, item) => sum + item.total_campaigns, 0),
    total_cost: Number(creators.reduce((sum, item) => sum + item.total_cost, 0).toFixed(2)),
    first_play_sum: creators.reduce((sum, item) => sum + item.first_play_sum, 0),
    second_play_sum: creators.reduce((sum, item) => sum + item.second_play_sum, 0),
    total_play: creators.reduce((sum, item) => sum + item.total_play, 0),
    // 新增：爆款总数 / 爆款率（爆款总数 ÷ 记录总数 × 100，1 位小数）
    total_hits: creators.reduce((sum, item) => sum + item.hit_count, 0),
    record_count: creators.reduce((sum, item) => sum + item.total_campaigns, 0)
  }
  totalSummary.avg_cpm =
    totalSummary.total_play > 0
      ? Number(((totalSummary.total_cost / totalSummary.total_play) * 1000).toFixed(2))
      : null
  totalSummary.hit_rate =
    totalSummary.record_count > 0
      ? Number(((totalSummary.total_hits / totalSummary.record_count) * 100).toFixed(1))
      : null

  return {
    range: { startWeek: rangeStart, endWeek: rangeEnd },
    creatorTypes,
    keyword,
    minCampaigns: minCampaignsValue,
    sort: { sortBy: sortField, sortOrder: sortDirection },
    creators,
    total_summary: totalSummary
  }
}

/**
 * 博主类型分组汇总：与达人明细 / 总汇总使用同一套口径
 * - campaign：总播放 = Σ有效最新累计播放；最新平均CPM 的分子只含同一样本记录的花费
 * - occurrence：保持旧实现（TODO(occurrence)：待 snapshot Batch 重构）
 */
function buildGroupSummary(creatorType, list, caliber = 'campaign', rawAccByKey = null) {
  // 身份键：identity 模式取 creator_id，legacy 模式取 nickname（与聚合层同一口径）
  const rawCost = (item, field) => rawAccByKey?.get(summaryRowKey(item))?.[field] ?? item[field] ?? 0
  const totalCost = round2(list.reduce((sum, item) => sum + rawCost(item, 'total_cost'), 0))
  const totalCampaigns = list.reduce((sum, item) => sum + item.total_campaigns, 0)

  if (caliber !== 'campaign') {
    const totalPlay = list.reduce((sum, item) => sum + item.total_play, 0)
    return {
      creator_type: creatorType,
      creator_count: list.length,
      total_campaigns: totalCampaigns,
      total_cost: totalCost,
      first_play_sum: list.reduce((sum, item) => sum + item.first_play_sum, 0),
      second_play_sum: list.reduce((sum, item) => sum + item.second_play_sum, 0),
      total_play: totalPlay,
      avg_cpm: totalPlay > 0 ? round2((totalCost / totalPlay) * 1000) : null,
      total_hits: list.reduce((sum, item) => sum + item.hit_count, 0),
      creators: list
    }
  }

  const latestPlayTotal = list.reduce((sum, item) => sum + item.latest_play_total, 0)
  const firstPlayTotal = list.reduce((sum, item) => sum + item.first_play_sum, 0)
  const latestValidCost = list.reduce((sum, item) => sum + rawCost(item, 'latest_valid_cost'), 0)
  const firstValidCost = list.reduce((sum, item) => sum + rawCost(item, 'first_valid_cost'), 0)
  const latestSampleCount = list.reduce((sum, item) => sum + item.latest_sample_count, 0)
  const firstSampleCount = list.reduce((sum, item) => sum + item.first_sample_count, 0)
  const hitLatestCount = list.reduce((sum, item) => sum + item.hit_latest_count, 0)
  const hit7dCount = list.reduce((sum, item) => sum + item.hit_7d_count, 0)

  return {
    creator_type: creatorType,
    creator_count: list.length,
    total_campaigns: totalCampaigns,
    total_cost: totalCost,
    first_play_sum: firstPlayTotal,
    second_play_sum: latestPlayTotal,
    total_play: latestPlayTotal,
    latest_play_total: latestPlayTotal,
    post_7d_growth_total: list.reduce((sum, item) => sum + item.post_7d_growth_total, 0),
    avg_cpm: latestPlayTotal > 0 ? round2((latestValidCost / latestPlayTotal) * 1000) : null,
    cpm_7d: firstPlayTotal > 0 ? round2((firstValidCost / firstPlayTotal) * 1000) : null,
    hit_count: hitLatestCount,
    total_hits: hitLatestCount,
    hit_latest_count: hitLatestCount,
    hit_7d_count: hit7dCount,
    hit_rate_latest:
      latestSampleCount > 0 ? round1((hitLatestCount / latestSampleCount) * 100) : null,
    hit_rate_7d: firstSampleCount > 0 ? round1((hit7dCount / firstSampleCount) * 100) : null,
    latest_sample_count: latestSampleCount,
    first_sample_count: firstSampleCount,
    creators: list
  }
}

// ---------- 达人维度汇总接口（按博主类型分组，支持周范围/类型筛选/口径） ----------
router.get('/creator-summary', (req, res) => {
  const caliber = String(req.query.caliber || 'campaign').trim().toLowerCase()
  if (!['campaign', 'occurrence'].includes(caliber)) {
    return fail(res, 400, 'caliber 必须为 campaign 或 occurrence')
  }
  if (caliber === 'occurrence') return fail(res, 400, '按发生周暂未开放')
  const rawStartWeek = req.query.startWeek
  const rawEndWeek = req.query.endWeek
  const startWeek = rawStartWeek ? normalizeWeekCode(rawStartWeek) : null
  const endWeek = rawEndWeek ? normalizeWeekCode(rawEndWeek) : null
  if (rawStartWeek && !startWeek) return fail(res, 400, 'startWeek 格式必须为 YYYY-Wxx')
  if (rawEndWeek && !endWeek) return fail(res, 400, 'endWeek 格式必须为 YYYY-Wxx')
  if (startWeek && endWeek && startWeek > endWeek) {
    return fail(res, 400, 'startWeek 不能晚于 endWeek')
  }
  const creatorTypes = parseCsvParam(req.query.creatorTypes)
  // groupByType=false 时合并为一个「全部达人」分组，前端渲染逻辑保持统一
  const groupByType = String(req.query.groupByType ?? 'true').toLowerCase() !== 'false'

  // 新增可选参数校验（不传时行为与原来完全一致）
  const rawKeyword = req.query.keyword
  const keyword = rawKeyword === undefined ? '' : String(rawKeyword).trim()
  if (keyword.length > 50) {
    return fail(res, 400, 'keyword 长度不能超过 50')
  }
  const rawMinCampaigns = req.query.minCampaigns
  let minCampaigns = 0
  if (rawMinCampaigns !== undefined && rawMinCampaigns !== '') {
    const parsed = Number(rawMinCampaigns)
    if (!Number.isInteger(parsed) || parsed < 1) {
      return fail(res, 400, 'minCampaigns 必须为不小于 1 的整数')
    }
    minCampaigns = parsed
  }
  const rawSortBy = req.query.sortBy
  const sortBy = rawSortBy === undefined || rawSortBy === '' ? 'total_cost' : String(rawSortBy).trim()
  if (!CREATOR_SORT_FIELDS.includes(sortBy)) {
    return fail(res, 400, `sortBy 必须为：${CREATOR_SORT_FIELDS.join(' / ')}`)
  }
  const rawSortOrder = req.query.sortOrder
  const sortOrder =
    rawSortOrder === undefined || rawSortOrder === ''
      ? 'desc'
      : String(rawSortOrder).trim().toLowerCase()
  if (!['asc', 'desc'].includes(sortOrder)) {
    return fail(res, 400, 'sortOrder 必须为 asc 或 desc')
  }

  const summary = buildCreatorSummary({
    startWeek,
    endWeek,
    caliber,
    creatorTypes,
    keyword,
    minCampaigns,
    sortBy,
    sortOrder
  })

  let groups = []
  if (groupByType) {
    const typeMap = new Map()
    for (const creator of summary.creators) {
      const type = creator.creator_type || '未分类'
      if (!typeMap.has(type)) typeMap.set(type, [])
      typeMap.get(type).push(creator)
    }
    groups = [...typeMap.entries()]
      .map(([creatorType, list]) => buildGroupSummary(creatorType, list, caliber, summary.rawAccByKey))
      .sort((a, b) => b.total_cost - a.total_cost || b.total_play - a.total_play)
  } else {
    groups = [buildGroupSummary('全部达人', summary.creators, caliber, summary.rawAccByKey)]
  }

  ok(res, {
    caliber,
    groupByType,
    range: summary.range,
    filters: { creatorTypes, keyword: summary.keyword, minCampaigns: summary.minCampaigns },
    sort: summary.sort,
    groups,
    // 扁平达人列表（分组数据的全集，便于前端做对比/导出，避免再遍历 groups）
    creators: summary.creators,
    total_summary: summary.total_summary,
    // 身份模式标记 + 未归属记录数（未归属记录不进入任何 Creator 指标，但必须可见）
    identity_mode: summary.identity_mode === true,
    unattributed_record_count: summary.unattributed_record_count ?? 0
  })
})

// ============================================================
// 复投雷达（V3-alpha P1，只读）
// ------------------------------------------------------------
// 只复用 V2 已冻结的口径，不新增指标定义：
//   - 单条「累计 CPM」= total_cost / 累计播放量(second_week_play) × 1000
//   - 有效样本语义 = computePlayMetrics 的 hasLatest && !latestAnomaly，且 latest > 0
//     （latest 未填写 = 未观察；latest < first = 异常；latest = 0 是真实观测但 CPM 无定义）
//   - 达人身份：按 nickname 单键聚合（与 CreatorSummary 一致，不做 creator master）
// 不写库、不调用 AI、不访问外部网络。
// ============================================================

// 目标 CPM：单次合作累计 CPM <= 目标值视为达标。
// P3 起统一取共享业务规则模块的 TARGET_CPM（唯一来源，避免 P1 / P3 两份 30 漂移）；
// P1 的历史判断行为完全不变，仍然只使用这一个值。
export const REPURCHASE_TARGET_CPM = TARGET_CPM

// 历史状态（明确业务规则，不用平均值决胜、不用综合评分）
const RADAR_STATUS = {
  passed: 'passed', // 有效样本 >= 2 且 pass_count > fail_count
  mixed: 'mixed', // 有效样本 >= 2 且 pass_count === fail_count
  failed: 'failed', // 有效样本 >= 2 且 pass_count < fail_count
  insufficient: 'insufficient' // 有效样本 0 或 1（唯一一次达标也不算历史通过）
}

const RADAR_STATUS_LABELS = {
  passed: '历史通过',
  mixed: '表现分化',
  failed: '暂不优先',
  insufficient: '证据不足'
}

// 分组顺序：优先关注 / 需要观察 / 暂不优先
const RADAR_GROUPS = [
  { key: 'priority', label: '优先关注', statuses: [RADAR_STATUS.passed] },
  { key: 'watch', label: '需要观察', statuses: [RADAR_STATUS.mixed, RADAR_STATUS.insufficient] },
  { key: 'low_priority', label: '暂不优先', statuses: [RADAR_STATUS.failed] }
]

// ---------- Alpha.2 B1：工作优先级（注意力分配）----------
// 只回答「今天先花时间看谁」，**不改变任何历史证据结论**：
// 单样本达标 / 失准仍然是 historical_status = insufficient，只是注意力优先级不同。
// 阈值本轮固定（后续按真实使用再调整），用 raw CPM 判断，不用展示值。
const WORK_PRIORITY = {
  high: 'high_attention', // 单次有效 CPM <= 10
  medium: 'medium_attention', // 10 < 单次有效 CPM <= 20
  normal: 'normal_attention', // 20 < 单次有效 CPM < 100（或没有可用样本 / 多样本 mixed）
  low: 'low_priority' // 单次有效 CPM >= 100，或多样本 failed
}

export const WORK_PRIORITY_THRESHOLDS = { high: 10, medium: 20, low: 100 }

// work_priority_reason → 行内轻量标记文案（无标记时为 null；前端只渲染后端给出的文案）
const WORK_PRIORITY_REASON_LABELS = {
  single_sample_cpm_le_10: '单次表现突出',
  single_sample_cpm_le_20: '优先补数据',
  single_sample_cpm_normal: null,
  single_sample_cpm_ge_100: '单次合作明显低效',
  no_valid_sample: null,
  multi_sample_passed: null,
  multi_sample_mixed: null,
  multi_sample_failed: null
}

/**
 * 工作优先级（纯函数，便于单测）
 * - validCount = 1：用唯一一次有效累计 CPM 的 raw 值分层（<=10 / <=20 / <100 / >=100）
 * - validCount = 0：没有可用样本 → normal（不做正负判断）
 * - validCount >= 2：直接跟随原 P1 证据结论（passed → high / mixed → normal / failed → low），
 *   不引入任何新的多数规则
 * @param {{ validCount: number, status: string, singleSampleCpmRaw: number|null }} params
 */
export function computeWorkPriority({ validCount = 0, status = RADAR_STATUS.insufficient, singleSampleCpmRaw = null } = {}) {
  if (validCount === 1 && singleSampleCpmRaw !== null && Number.isFinite(singleSampleCpmRaw)) {
    if (singleSampleCpmRaw <= WORK_PRIORITY_THRESHOLDS.high) {
      return { work_priority: WORK_PRIORITY.high, work_priority_reason: 'single_sample_cpm_le_10' }
    }
    if (singleSampleCpmRaw <= WORK_PRIORITY_THRESHOLDS.medium) {
      return { work_priority: WORK_PRIORITY.medium, work_priority_reason: 'single_sample_cpm_le_20' }
    }
    if (singleSampleCpmRaw < WORK_PRIORITY_THRESHOLDS.low) {
      return { work_priority: WORK_PRIORITY.normal, work_priority_reason: 'single_sample_cpm_normal' }
    }
    return { work_priority: WORK_PRIORITY.low, work_priority_reason: 'single_sample_cpm_ge_100' }
  }
  if (validCount === 0) {
    return { work_priority: WORK_PRIORITY.normal, work_priority_reason: 'no_valid_sample' }
  }
  if (status === RADAR_STATUS.passed) {
    return { work_priority: WORK_PRIORITY.high, work_priority_reason: 'multi_sample_passed' }
  }
  if (status === RADAR_STATUS.failed) {
    return { work_priority: WORK_PRIORITY.low, work_priority_reason: 'multi_sample_failed' }
  }
  return { work_priority: WORK_PRIORITY.normal, work_priority_reason: 'multi_sample_mixed' }
}

/** 单样本「明显低效」是否应离开「需要观察」进入「暂不优先」（历史证据结论不变） */
const isLowPrioritySingleSample = (item) =>
  item.historical_status === RADAR_STATUS.insufficient && item.work_priority === WORK_PRIORITY.low

/** 严格解析 YYYY-MM-DD（含真实日期校验），非法返回 null */
function toDateOnly(value) {
  const text = String(value ?? '').trim()
  if (!DATE_RE.test(text)) return null
  const [year, month, day] = text.split('-').map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null
  }
  return text
}

/** 服务端本地「今天」（YYYY-MM-DD），用于计算距上次合作天数 */
function todayDateOnly(now = new Date()) {
  const pad = (num) => String(num).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 两个 YYYY-MM-DD 之间的整天数（按 UTC 归一化，避免时区 / 夏令时导致 ±1 天） */
function diffDays(fromDate, toDate) {
  const toUtc = (text) => {
    const [year, month, day] = text.split('-').map(Number)
    return Date.UTC(year, month - 1, day)
  }
  return Math.round((toUtc(toDate) - toUtc(fromDate)) / 86400000)
}

/**
 * 中位数（原始精度）：奇数取中间值，偶数取中间两项平均。
 * 不做任何逐条四舍五入 —— 达标判断与中位数必须基于 raw CPM，
 * 只在最终 API 输出 median_cpm 时 round2。
 */
function medianOfRaw(values = []) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 单条记录的「累计 CPM」原始值（与前端 calcCpm / recordLatestPlay 同口径；无有效样本返回 null）
 * - 返回未四舍五入的 raw CPM：达标判断（<= 目标值）与中位数一律基于 raw 值，
 *   避免「先 round2 再判断」造成 30.004 被误判为达标这类边界失真
 * - latest 未填写 / latest < first（异常）/ latest <= 0 → null（不是有效 CPM 样本）
 */
export function computeRecordLatestCpm(row = {}) {
  const metrics = computePlayMetrics(row)
  if (!metrics.hasLatest || metrics.latestAnomaly) return null
  if (!(metrics.latest > 0)) return null
  return (metrics.cost / metrics.latest) * 1000
}

/**
 * 单条记录的「7日 CPM」原始值（V2 冻结口径：cost / first_play × 1000）
 * - 与 computeRecordLatestCpm 完全对称：同样先走 computePlayMetrics，不新增第二套播放口径
 * - first 未填写（null/''）→ null；first = 0 是真实观测但分母为 0、CPM 无定义 → null
 * - 不负责四舍五入；展示层再按 1 位小数格式化
 */
export function computeRecordFirstCpm(row = {}) {
  const metrics = computePlayMetrics(row)
  if (!metrics.hasFirst) return null
  if (!(metrics.first > 0)) return null
  return (metrics.cost / metrics.first) * 1000
}

/**
 * 复投雷达（纯函数，便于单测）：按 nickname 聚合 → 单次达标判定 → 历史状态 → 中位数 → 分组排序
 * @param {Array<Object>} rows creator_records 行（含 id / nickname / creator_type / total_cost / first_play / second_week_play / publish_date）
 * @param {{ referenceDate?: string }} [options] referenceDate 仅测试注入（YYYY-MM-DD），默认服务端本地今天
 *
 * Alpha.3-02：新增只读聚合字段 last_actual_cost —— 「最近一次真实投放记录」的 total_cost。
 *   · 「最近一次」沿用既有最近合作定义（MAX(publish_date)），同一天多条记录时按 id DESC 取确定性的一条；
 *     两者取自同一条 creator_record，绝不使用星图价 / 报价 / 谈成价 / 目标价回填，也不做同日求和。
 *   · 0 是真实值（显示 ¥0）；null / 空字符串代表缺失（显示「上次合作价暂无」）。
 */
export function buildRepurchaseRadar(rows = [], { referenceDate = null } = {}) {
  const reference = toDateOnly(referenceDate) || todayDateOnly()
  const creatorMap = new Map()
  let rowIndex = 0

  for (const row of rows) {
    const nickname = String(row?.nickname || '').trim() || '未命名达人'
    const creatorType = String(row?.creator_type || '').trim() || '未分类'
    // Creator Identity V1 Phase 5：有 creator_id 时以 creator_id 为分组键（同名不同人绝不合并）；
    // 没有 creator_id（历史证据冻结路径 / 老 fixture）时退回 nickname 分组，行为与原来完全一致。
    const rawCreatorId = row?.creator_id
    const creatorId =
      rawCreatorId === null || rawCreatorId === undefined || !Number.isInteger(Number(rawCreatorId))
        ? null
        : Number(rawCreatorId)
    const key = creatorId === null ? `name:${nickname}` : `id:${creatorId}`
    // 展示名：identity join 提供 canonical_name 时用它（权威显示名）；否则退回 frozen nickname
    const displayName = String(row?.canonical_name ?? '').trim() || nickname
    if (!creatorMap.has(key)) {
      creatorMap.set(key, {
        creator_id: creatorId,
        creator: displayName,
        // 与 CreatorSummary 一致：保留首条记录的类型，空则「未分类」
        creator_type: creatorType,
        record_count: 0,
        samples: [],
        lastDate: null,
        // Alpha.3-02：最近一次真实投放记录的 id 与 total_cost（内部聚合状态，只对外输出 cost）
        lastRecordId: null,
        lastActualCost: null
      })
    }
    const entry = creatorMap.get(key)
    entry.record_count += 1

    // 最近合作日期：合作新近度取该达人全部记录的 MAX(publish_date)，与 CPM 有效性无关。
    // Alpha.3-02：同日多条记录时用 id DESC 做确定性 tie-break，并同步记录该条记录的 total_cost，
    // 保证 last_collaboration_date 与 last_actual_cost 始终来自同一条 creator_record。
    const publishDate = toDateOnly(row?.publish_date)
    if (publishDate) {
      const rowId = Number.isInteger(Number(row?.id)) ? Number(row.id) : null
      const isNewerDate = !entry.lastDate || publishDate > entry.lastDate
      const isNewerSameDate =
        publishDate === entry.lastDate && rowId !== null && entry.lastRecordId !== null && rowId > entry.lastRecordId
      if (isNewerDate || isNewerSameDate) {
        entry.lastDate = publishDate
        if (rowId !== null) entry.lastRecordId = rowId
        entry.lastActualCost = toActualCostNumber(row?.total_cost)
      }
    }

    // 保存 raw CPM（不预先 round2）：达标判断 / 中位数 / 最近风险统一使用原始精度
    const cpmRaw = computeRecordLatestCpm(row)
    if (cpmRaw !== null) {
      entry.samples.push({ cpmRaw, publishDate, index: rowIndex })
    }
    rowIndex += 1
  }

  const creators = [...creatorMap.values()].map((entry) => {
    const validCount = entry.samples.length
    // 达标判断使用 raw CPM：raw <= 目标值 => 达标；raw > 目标值 => 未达标
    const passCount = entry.samples.filter((sample) => sample.cpmRaw <= REPURCHASE_TARGET_CPM).length
    const failCount = validCount - passCount

    let status = RADAR_STATUS.insufficient
    if (validCount >= 2) {
      if (passCount > failCount) status = RADAR_STATUS.passed
      else if (passCount === failCount) status = RADAR_STATUS.mixed
      else status = RADAR_STATUS.failed
    }

    // 最近连续 2 次「有效累计 CPM」都 > 目标值 → 风险提示（不改变历史状态）
    const recent = [...entry.samples].sort((a, b) => {
      const left = a.publishDate || ''
      const right = b.publishDate || ''
      if (left !== right) return left < right ? 1 : -1
      return b.index - a.index
    })
    const recentRisk =
      recent.length >= 2 &&
      recent[0].cpmRaw > REPURCHASE_TARGET_CPM &&
      recent[1].cpmRaw > REPURCHASE_TARGET_CPM

    const daysSince =
      entry.lastDate === null ? null : Math.max(0, diffDays(entry.lastDate, reference))

    // 中位数用 raw CPM 求，只在对外输出时 round2（展示保留 2 位小数）
    const medianRaw = medianOfRaw(entry.samples.map((sample) => sample.cpmRaw))

    // Alpha.2 B1：注意力优先级（不影响上面任何历史证据字段）
    const singleSampleCpmRaw = validCount === 1 ? entry.samples[0].cpmRaw : null
    const { work_priority: workPriority, work_priority_reason: workPriorityReason } = computeWorkPriority({
      validCount,
      status,
      singleSampleCpmRaw
    })

    return {
      // Phase 5：Creator 身份（identity 模式下有值；legacy/证据路径为 null）
      creator_id: entry.creator_id,
      creator: entry.creator,
      creator_type: entry.creator_type,
      record_count: entry.record_count,
      valid_cpm_count: validCount,
      pass_count: passCount,
      fail_count: failCount,
      historical_status: status,
      historical_status_label: RADAR_STATUS_LABELS[status],
      // 对外字段：注意力优先级由后端统一计算，前端不重新推导业务规则
      work_priority: workPriority,
      work_priority_reason: workPriorityReason,
      work_priority_label: WORK_PRIORITY_REASON_LABELS[workPriorityReason] ?? null,
      // 仅单样本有值（raw 单次累计 CPM 的展示值），多样本为 null
      single_sample_cpm: singleSampleCpmRaw === null ? null : round2(singleSampleCpmRaw),
      // 对外字段：中位数按 2 位小数展示
      median_cpm: medianRaw === null ? null : round2(medianRaw),
      // 内部字段（不对外输出）：排序必须用 raw 中位数，避免展示值相同被误判为并列
      medianCpmRaw: medianRaw,
      last_collaboration_date: entry.lastDate,
      days_since_last_collaboration: daysSince,
      // Alpha.3-02：最近一次真实投放记录的实际合作价（与 last_collaboration_date 同一条记录）
      // 0 是真实值；null 表示该条记录未填写花费（前端显示「上次合作价暂无」）
      last_actual_cost: entry.lastActualCost,
      recent_risk: recentRisk,
      recent_risk_text: recentRisk ? '最近2次合作均未达到 CPM 30' : null
    }
  })

  // 确定性排序（无加权评分）：中位 CPM 升序（无中位数排最后）→ 距上次合作更久优先 → 名称兜底
  const compareNullableAsc = (left, right) => {
    const leftNull = left === null || left === undefined
    const rightNull = right === null || right === undefined
    if (leftNull && rightNull) return 0
    if (leftNull) return 1
    if (rightNull) return -1
    return left - right
  }
  const compareDaysDesc = (left, right) => {
    const leftNull = left === null || left === undefined
    const rightNull = right === null || right === undefined
    if (leftNull && rightNull) return 0
    if (leftNull) return 1
    if (rightNull) return -1
    return right - left
  }
  const watchStatusRank = (status) => (status === RADAR_STATUS.mixed ? 0 : 1)
  // 「需要观察」内的工作优先级顺序：高注意力 → 中注意力 → 普通
  const workPriorityRank = (value) => {
    if (value === WORK_PRIORITY.high) return 0
    if (value === WORK_PRIORITY.medium) return 1
    if (value === WORK_PRIORITY.normal) return 2
    return 3
  }
  const compareCreators = (a, b) => {
    // 第一优先：raw 中位数升序（只有 raw 真正相等才进入第二条件）
    const byMedian = compareNullableAsc(a.medianCpmRaw, b.medianCpmRaw)
    if (byMedian !== 0) return byMedian
    const byDays = compareDaysDesc(
      a.days_since_last_collaboration,
      b.days_since_last_collaboration
    )
    if (byDays !== 0) return byDays
    if (a.creator === b.creator) return 0
    return a.creator < b.creator ? -1 : 1
  }

  // 对外只返回展示字段，内部排序字段 medianCpmRaw 不暴露给前端
  const toPublicCreator = ({ medianCpmRaw, ...publicFields }) => publicFields

  // 分组归属：历史状态仍是第一依据；只有「单样本明显低效」会从需要观察移到暂不优先
  const matchesGroup = (item, group) => {
    if (group.key === 'priority') return item.historical_status === RADAR_STATUS.passed
    if (group.key === 'watch') {
      return (
        item.historical_status === RADAR_STATUS.mixed ||
        (item.historical_status === RADAR_STATUS.insufficient && !isLowPrioritySingleSample(item))
      )
    }
    return item.historical_status === RADAR_STATUS.failed || isLowPrioritySingleSample(item)
  }

  const groups = RADAR_GROUPS.map((group) => {
    const list = creators.filter((item) => matchesGroup(item, group))
    list.sort((a, b) => {
      // 「需要观察」内先按工作优先级（高注意力优先），同层再有证据的（mixed）先于证据不足（insufficient）
      if (group.key === 'watch') {
        const byPriority = workPriorityRank(a.work_priority) - workPriorityRank(b.work_priority)
        if (byPriority !== 0) return byPriority
        const byStatus = watchStatusRank(a.historical_status) - watchStatusRank(b.historical_status)
        if (byStatus !== 0) return byStatus
      }
      return compareCreators(a, b)
    })
    return {
      key: group.key,
      label: group.label,
      count: list.length,
      creators: list.map(toPublicCreator)
    }
  })

  return {
    target_cpm: REPURCHASE_TARGET_CPM,
    reference_date: reference,
    // 排序规则说明（前端只做展示，不重新计算业务规则）
    sort: {
      priority:
        '历史CPM中位数(raw) 升序 → days_since_last_collaboration 降序 → creator 名称升序',
      watch:
        'work_priority(high→medium→normal) → mixed 优先于 insufficient → 历史CPM中位数(raw) 升序 → days_since_last_collaboration 降序 → creator 名称升序',
      low_priority:
        '历史CPM中位数(raw) 升序 → days_since_last_collaboration 降序 → creator 名称升序（含「单样本明显低效」的 insufficient 达人）'
    },
    groups,
    summary: {
      creator_count: creators.length,
      record_count: creators.reduce((sum, item) => sum + item.record_count, 0),
      valid_cpm_count: creators.reduce((sum, item) => sum + item.valid_cpm_count, 0),
      priority_count: groups[0].count,
      watch_count: groups[1].count,
      low_priority_count: groups[2].count
    }
  }
}

/**
 * 复投雷达（只读接口）
 * - 不写库、不调用 AI、不访问外部网络
 * - current_date 参数仅在测试模式（WORKBENCH_TEST_MODE=1）下生效，用于固定日期断言；
 *   生产环境始终使用服务端本地日期，避免客户端左右业务判定
 */
router.get('/repurchase-radar', (req, res) => {
  let referenceDate = null
  const rawReference = req.query.current_date
  if (rawReference !== undefined && rawReference !== '') {
    const text = String(rawReference).trim()
    if (process.env.WORKBENCH_TEST_MODE === '1') {
      if (!toDateOnly(text)) return fail(res, 400, 'current_date 格式必须为 YYYY-MM-DD')
      referenceDate = text
    }
    // 非测试模式：忽略该参数，生产始终以服务端本地当前日期为准
  }
  // Creator Identity V1 Phase 5：identity 模式下按 creator_id 分组（radar 只包含有真实记录的 Creator）；
  // 未归属（creator_id = NULL）的记录绝不形成 group。legacy 模式保持原 nickname 行为。
  const identityMode = creatorIdentityReady()
  const rows = identityMode ? queryRadarRows() : queryDetailRows()
  const radar = buildRepurchaseRadar(rows, { referenceDate })

  // P2B：合并每位达人的「最新近期表现快照」轻量 summary。
  // 单条 SQL 批量查询（不做 N+1）；只增加展示字段，
  // 不参与 historical_status / 分组 / median_cpm / 排序，P1 规则保持不变。
  // Phase 5：identity 模式下按 creator_id 关联（同名不同人绝不串数据）
  const creatorItems = radar.groups.flatMap((group) => group.creators)
  const useIdentityLookup = identityMode && creatorItems.every((item) => item.creator_id !== null)
  const snapshotMap = useIdentityLookup
    ? loadLatestSnapshotSummariesByCreatorId(creatorItems.map((item) => item.creator_id))
    : loadLatestSnapshotSummaries(creatorItems.map((item) => item.creator))
  // P4：同样以单条 SQL 批量带上「最近一次决策」轻量 summary（只读展示，不参与 P1 规则）
  const decisionMap = useIdentityLookup
    ? loadLatestDecisionSummariesByCreatorId(creatorItems.map((item) => item.creator_id))
    : loadLatestDecisionSummaries(creatorItems.map((item) => item.creator))
  const lookupKey = (item) => (useIdentityLookup ? item.creator_id : item.creator)
  for (const group of radar.groups) {
    group.creators = group.creators.map((creator) => ({
      ...creator,
      recent_snapshot: snapshotMap.get(lookupKey(creator)) || null,
      recent_decision: decisionMap.get(lookupKey(creator)) || null
    }))
  }

  // 未归属记录数（不进入任何 Creator 分组，但必须可见，避免事实被静默吞掉）
  const unattributedRecordCount = identityMode
    ? db.prepare('SELECT COUNT(*) AS n FROM creator_records WHERE creator_id IS NULL').get().n
    : 0
  return ok(res, { ...radar, identity_mode: identityMode, unattributed_record_count: unattributedRecordCount })
})

// ---------- 筛选元数据（博主类型 / 达人昵称 / 数据周范围，供 BI 筛选面板初始化） ----------
router.get('/filters', (req, res) => {
  const rows = db
    .prepare(
      `SELECT time_cycle, nickname, creator_type, second_week_play
       FROM creator_records`
    )
    .all()

  const typeCount = new Map()
  const nicknameCount = new Map()
  let earliestWeek = null
  let latestWeek = null

  for (const row of rows) {
    const type = String(row.creator_type || '').trim()
    if (type) typeCount.set(type, (typeCount.get(type) || 0) + 1)
    const nickname = String(row.nickname || '').trim()
    if (nickname) nicknameCount.set(nickname, (nicknameCount.get(nickname) || 0) + 1)

    const code = normalizeWeekCode(row.time_cycle)
    if (!code) continue
    if (!earliestWeek || code < earliestWeek) earliestWeek = code
    if (!latestWeek || code > latestWeek) latestWeek = code
    // 发生周口径：最晚周扩展到「有次周播放量的下一周」
    if ((Number(row.second_week_play) || 0) > 0) {
      const nextCode = getNextWeek(code)
      if (nextCode && (!latestWeek || nextCode > latestWeek)) latestWeek = nextCode
    }
  }

  // 按出现次数降序（次数相同按名称排序，保证结果稳定）
  const toSortedList = (map) =>
    [...map.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN'))

  ok(res, {
    creatorTypes: toSortedList(typeCount),
    nicknames: toSortedList(nicknameCount),
    weekRange: { earliestWeek, latestWeek }
  })
})

// ---------- 明细导出（复用后端 xlsx 工具，筛选参数与周度聚合保持一致） ----------
// 记录明细导出表头（V2 术语，与前端 utils/excel.js 的 EXPORT_COLUMNS 保持一致）
const EXPORT_HEADERS = [
  '时间周期',
  '达人昵称',
  '达人类型',
  '达人主页',
  '植入链接',
  '视频链接',
  '总花费(元)',
  'CPM',
  '7日播放量',
  '累计播放量',
  '后续新增播放量',
  '发布日期'
]

router.get('/export', (req, res) => {
  const rawStartWeek = req.query.startWeek
  const rawEndWeek = req.query.endWeek
  const creatorTypes = parseCsvParam(req.query.creatorTypes)
  const nicknames = parseCsvParam(req.query.nicknames)
  const exportType = String(req.query.type || '').trim().toLowerCase()

  const startWeek = rawStartWeek ? normalizeWeekCode(rawStartWeek) : null
  const endWeek = rawEndWeek ? normalizeWeekCode(rawEndWeek) : null
  if (rawStartWeek && !startWeek) return fail(res, 400, 'startWeek 格式必须为 YYYY-Wxx')
  if (rawEndWeek && !endWeek) return fail(res, 400, 'endWeek 格式必须为 YYYY-Wxx')
  if (startWeek && endWeek && startWeek > endWeek) {
    return fail(res, 400, 'startWeek 不能晚于 endWeek')
  }

  // 达人维度汇总导出：博主类型 / 达人昵称 / 投放次数 / 总花费 / 总播放 / 平均CPM
  if (exportType === 'creator-summary') {
    // 默认主口径 = campaign（投放周），与 creator-summary / week-stats 保持一致
    const caliber = String(req.query.caliber || 'campaign').trim().toLowerCase()
    if (!['campaign', 'occurrence'].includes(caliber)) {
      return fail(res, 400, 'caliber 必须为 campaign 或 occurrence')
    }
    if (caliber === 'occurrence') return fail(res, 400, '按发生周暂未开放')
    // 兼容新增筛选参数（keyword / minCampaigns），并按页面当前排序导出
    const exportKeyword = String(req.query.keyword || '').trim().slice(0, 50)
    const exportMinCampaigns = Number(req.query.minCampaigns) > 0 ? Math.floor(Number(req.query.minCampaigns)) : 0
    const exportSortBy = CREATOR_SORT_FIELDS.includes(String(req.query.sortBy || ''))
      ? String(req.query.sortBy)
      : 'total_cost'
    const exportSortOrder = String(req.query.sortOrder || '').toLowerCase() === 'asc' ? 'asc' : 'desc'
    const summary = buildCreatorSummary({
      startWeek,
      endWeek,
      caliber,
      creatorTypes,
      keyword: exportKeyword,
      minCampaigns: exportMinCampaigns,
      sortBy: exportSortBy,
      sortOrder: exportSortOrder
    })
    // 达人汇总导出（V2 术语，与前端 exportCreatorStatsToExcel 列名/口径保持一致）
    const summaryHeaders = [
      '达人昵称',
      '达人类型',
      '投放次数',
      '总花费',
      '累计播放量',
      '平均播放量',
      '平均CPM',
      '爆款数',
      '爆款率',
      '复投次数',
      '7日播放量',
      '后续新增播放量',
      '7日CPM',
      '7日爆款数',
      '7日爆款率'
    ]
    const cpmCell = (value) =>
      value === null || value === undefined ? '' : Number(Number(value).toFixed(2))
    const rateCell = (value) => (value === null || value === undefined ? '' : `${value}%`)
    const emptyCell = (value) => (value === null || value === undefined ? '' : value)
    const summaryRows = summary.creators.map((item) => [
      item.nickname,
      item.creator_type || '未分类',
      item.total_campaigns,
      item.total_cost.toFixed(2),
      item.latest_play_total ?? item.total_play ?? 0,
      emptyCell(item.avg_play),
      cpmCell(item.avg_cpm),
      item.hit_latest_count ?? item.hit_count ?? 0,
      rateCell(item.hit_rate_latest),
      item.repeat_count,
      // 达人级字段名为 first_play_sum（summary 层才叫 first_play_total），两者都兼容
      item.first_play_sum ?? item.first_play_total ?? 0,
      item.post_7d_growth_total ?? 0,
      cpmCell(item.cpm_7d),
      item.hit_7d_count ?? 0,
      rateCell(item.hit_rate_7d)
    ])
    const summaryContent = buildXlsx('达人汇总', summaryHeaders, summaryRows)
    const summaryFileName = `达人汇总_${startWeek || summary.range.startWeek || '全部'}_${
      endWeek || summary.range.endWeek || '全部'
    }.xlsx`
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="creator-summary.xlsx"; filename*=UTF-8''${encodeURIComponent(summaryFileName)}`
    )
    return res.send(summaryContent)
  }

  const rows = queryDetailRows({ startWeek, endWeek, creatorTypes, nicknames })

  const data = rows.map((row) => {
    const info = getCycleInfo(row.time_cycle)
    // V2 单条口径：latest 未填写 / 异常（latest < first）→ 不参与 CPM 与后续新增
    const metrics = computePlayMetrics(row)
    const cost = metrics.cost
    const cpm =
      metrics.hasLatest && !metrics.latestAnomaly && metrics.latest > 0
        ? Number(((cost / metrics.latest) * 1000).toFixed(2))
        : ''
    return [
      info ? info.label : row.time_cycle,
      row.nickname || '',
      row.creator_type || '',
      row.homepage || '',
      row.content_link || '',
      row.video_link || '',
      cost.toFixed(2),
      cpm,
      // 0 是真实观察值：保留 0；未填写导出空单元格
      metrics.hasFirst ? metrics.first : '',
      // 异常数据仍导出原始累计播放量（不静默丢值），CPM / 后续新增为空
      metrics.hasLatest ? metrics.latest : '',
      metrics.post7dGrowth !== null ? metrics.post7dGrowth : '',
      row.publish_date || ''
    ]
  })

  const content = buildXlsx('投放明细', EXPORT_HEADERS, data)
  const fileName = `投放明细_${startWeek || '全部'}_${endWeek || '全部'}.xlsx`
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="records.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`
  )
  res.send(content)
})

/**
 * 写入导入批次日志（仅记录导入结果，不参与业务计算）
 * 注意：以实际入库条数作为 success_count，避免客户端统计与真实入库不一致
 * @param {Object|null} meta 前端传入的批次元数据 { fileName, totalCount, failCount, skipCount, duplicateCount, items }
 * @param {number} successCount 实际入库条数
 * @param {number[]} insertedIds 本次入库的记录 ID
 * @returns {number|null} 批次 ID（无元数据时返回 null，不写日志）
 */
// Existing Record Update V0.1：导入阶段允许更新的字段（后端固定，不接受前端传 field_name）
const IMPORT_UPDATE_FIELD = 'second_week_play'
// 乐观并发冲突文案（preview 之后该记录的累计播放量又变了）
const UPDATE_CONCURRENCY_MSG = '记录在预览后已发生变化，请刷新导入预览后重新确认。'

// 把「未观察 / 空」统一成 null；数字（含数字字符串）保持数值；其余为非法
function toNullableNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : NaN
}

/**
 * 解析并做「形状」校验导入更新意图（权威校验在事务内重新执行）
 * 入参：updates: [{ record_id, expected_before, desired_after }]
 * 注意：前端不提交 field_name —— V0.1 后端固定更新 second_week_play。
 * @returns {{ intents?: Array, error?: string }}
 */
function parseImportUpdateIntents(raw) {
  if (!Array.isArray(raw)) return { error: 'updates 必须是数组' }
  if (raw.length > 1000) return { error: '单次批量导入的更新不能超过 1000 条' }
  const intents = []
  const seen = new Set()
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] && typeof raw[i] === 'object' ? raw[i] : {}
    const recordId = Number(item.record_id)
    if (!Number.isSafeInteger(recordId) || recordId <= 0) {
      return { error: `第 ${i + 1} 条更新缺少合法的 record_id` }
    }
    if (seen.has(recordId)) return { error: '同一条记录不能在本次导入中重复更新' }
    seen.add(recordId)
    const expectedBefore = toNullableNumber(item.expected_before)
    if (Number.isNaN(expectedBefore) || (expectedBefore !== null && expectedBefore < 0)) {
      return { error: `第 ${i + 1} 条更新的 expected_before 非法` }
    }
    const desiredAfter = toNullableNumber(item.desired_after)
    if (desiredAfter === null || Number.isNaN(desiredAfter) || desiredAfter < 0) {
      return { error: `第 ${i + 1} 条更新的 desired_after 必须为 >= 0 的数字` }
    }
    intents.push({ recordId, expectedBefore, desiredAfter })
  }
  return { intents }
}

/**
 * 写入导入批次日志 + 更新审计（在调用方的事务内执行，保证与 INSERT/UPDATE 原子）
 * 注意：以实际入库条数作为 success_count，避免客户端统计与真实入库不一致
 * @param {Object|null} meta 前端传入的批次元数据
 * @param {number} successCount 实际新增入库条数
 * @param {number[]} insertedIds 本次新增入库的记录 ID
 * @param {Array} updateIntents 本次更新的意图 [{ recordId, expectedBefore, desiredAfter }]
 * @returns {number|null} 批次 ID（无元数据时返回 null，不写日志）
 */
function writeImportBatch(meta, successCount, insertedIds = [], updateIntents = []) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const toCount = (value) => {
    const num = Number(value)
    return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0
  }
  const fileName = String(meta.fileName || '').trim().slice(0, 255)
  const failCount = toCount(meta.failCount)
  const skipCount = toCount(meta.skipCount)
  const duplicateCount = toCount(meta.duplicateCount)
  const success = toCount(successCount)
  const totalCount = Number.isFinite(Number(meta.totalCount))
    ? toCount(meta.totalCount)
    : success + failCount + skipCount + duplicateCount

  const insertBatch = db.prepare(
    `INSERT INTO import_batches
       (file_name, total_count, success_count, fail_count, skip_count, duplicate_count)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const insertMapping = db.prepare(
    'INSERT INTO import_batch_records (batch_id, record_id) VALUES (?, ?)'
  )
  const insertItem = db.prepare(
    'INSERT INTO import_batch_items (batch_id, row_index, status, reason) VALUES (?, ?, ?, ?)'
  )
  const insertUpdate = db.prepare(
    `INSERT INTO import_batch_record_updates
       (batch_id, record_id, field_name, before_value_json, after_value_json)
     VALUES (?, ?, ?, ?, ?)`
  )
  // updated = 真实完成的已有记录更新（与 duplicate 区分，不再把 update 伪装成 duplicate）
  const ALLOWED_STATUS = ['success', 'fail', 'skip', 'duplicate', 'updated']
  // 行级明细上限，避免超大文件写入过多日志
  const items = Array.isArray(meta.items) ? meta.items.slice(0, 2000) : []

  const info = insertBatch.run(fileName, totalCount, success, failCount, skipCount, duplicateCount)
  const batchId = Number(info.lastInsertRowid)
  for (const recordId of insertedIds) {
    if (Number.isSafeInteger(recordId) && recordId > 0) insertMapping.run(batchId, recordId)
  }
  for (const item of items) {
    const status = String(item?.status || '').toLowerCase()
    const rowIndex = Number(item?.rowIndex)
    insertItem.run(
      batchId,
      Number.isFinite(rowIndex) ? rowIndex : null,
      ALLOWED_STATUS.includes(status) ? status : 'fail',
      String(item?.reason ?? '').slice(0, 500)
    )
  }
  // 更新审计：before/after 用 JSON 保留 null 与 0 的区别
  for (const intent of updateIntents) {
    insertUpdate.run(
      batchId,
      intent.recordId,
      IMPORT_UPDATE_FIELD,
      JSON.stringify(intent.expectedBefore),
      JSON.stringify(intent.desiredAfter)
    )
  }
  return batchId
}

// ---------- 6. 批量导入（必须先于 /:id 注册） ----------
router.post('/batch', (req, res) => {
  // 兼容两种请求体：数组（原有调用）与 { rows, batch, updates }（带导入批次元数据 / 已有记录更新）
  const isWrapped = Boolean(req.body) && !Array.isArray(req.body) && Array.isArray(req.body.rows)
  const list = Array.isArray(req.body) ? req.body : isWrapped ? req.body.rows : null
  if (!Array.isArray(list)) {
    return fail(res, 400, '请求体必须是数组，或 { rows: 数组 }')
  }
  // 更新意图只随包装体提交；V0.1 后端固定更新 second_week_play，前端不传 field_name
  const updatesRaw = isWrapped && req.body.updates !== undefined ? req.body.updates : []
  if (updatesRaw !== null && !Array.isArray(updatesRaw)) {
    return fail(res, 400, 'updates 必须是数组')
  }
  const { intents: updateIntents, error: updateError } = parseImportUpdateIntents(updatesRaw || [])
  if (updateError) {
    return fail(res, 400, updateError)
  }
  // Record Edit History V1.1：无批次元数据的旧调用方更新已有记录时，
  // 不走 import_batch_record_updates → 必须补写 creator_record_edits（fail-closed，不留无痕更新）
  const hasImportMeta = Boolean(
    req.body && typeof req.body.batch === 'object' && req.body.batch !== null && !Array.isArray(req.body.batch)
  )
  let legacyGroupId = null
  if (!hasImportMeta && updateIntents.length > 0) {
    try {
      assertCreatorRecordEditsReady(db)
      legacyGroupId = newRecordEditGroupId()
    } catch (error) {
      return fail(res, 500, error.message)
    }
  }
  // 既没有新增也没有更新：保持旧行为（不写批次、不报错）
  if (list.length === 0 && updateIntents.length === 0) {
    return ok(res, { count: 0, ids: [], batchId: null, updatedCount: 0, updatedIds: [] })
  }
  if (list.length > 1000) {
    return fail(res, 400, '单次批量导入不能超过 1000 条')
  }

  const rows = []
  for (let i = 0; i < list.length; i++) {
    const { clean, errors } = validate(list[i] || {})
    if (errors.length) {
      return fail(res, 400, `第 ${i + 1} 条数据校验失败：${errors.join('；')}`)
    }
    // 每行写库前执行同一套播放量交叉校验（客户端可能绕过 Excel 导入弹窗直接调用 API）
    const playError = checkPlayRange(clean)
    if (playError) {
      return fail(res, 400, `第 ${i + 1} 条数据校验失败：${playError}`)
    }
    // 时间周期必须与发布日期所属标准周一致（防止绕过前端写入错配周期）
    const cycleError = checkPublishCycleConsistency(clean)
    if (cycleError) {
      return fail(res, 400, `第 ${i + 1} 条数据校验失败：${cycleError}`)
    }
    rows.push(toRow(clean))
  }

  // 单事务：新增 INSERT + 批次日志 + 更新审计 + 已有记录 UPDATE
  // 任一步失败（含乐观并发冲突）→ 整个批次回滚，绝不 partial success
  const insert = db.prepare(INSERT_SQL)
  // 归属锚写入条件在本批次内固定（schema 不会在事务中变化）
  const identityWritable = recordIdentityWritable()
  // 老 fixture 没有 creator_id 列 → 绝不 prepare 带该列的 SQL（否则直接 SQLITE_ERROR）
  const insertWithIdentity = identityWritable ? db.prepare(IDENTITY_INSERT_SQL) : null
  const selectRecord = db.prepare(
    'SELECT id, first_play, second_week_play FROM creator_records WHERE id = ?'
  )
  const updatePlay = db.prepare('UPDATE creator_records SET second_week_play = ? WHERE id = ?')

  const conflict = (statusCode, message) => {
    const error = new Error(message)
    error.statusCode = statusCode
    throw error
  }

  const runAll = db.transaction((items, intents) => {
    const insertedIds = []
    for (const item of items) {
      // Creator Identity Phase 4：逐行做 strict 归属（0 → 新建 provisional Creator；1 → 复用；N → NULL，不猜）
      // 同一批次内同名行会彼此复用（前一行建好的 Creator 会被后一行解析到）
      let info
      if (identityWritable) {
        const attribution = resolveOrCreateCreatorForRecord(db, {
          nickname: item.nickname,
          creatorType: item.creator_type
        })
        info = insertWithIdentity.run(
          ...COLUMNS.map((col) => item[col]),
          attribution.creatorId,
          attribution.creatorLinkSource
        )
      } else {
        info = insert.run(...COLUMNS.map((col) => item[col]))
      }
      insertedIds.push(Number(info.lastInsertRowid))
    }

    // 先完成所有权威校验并通过后才写入（任一步失败 → 整个事务回滚）
    const updatedIds = []
    for (const intent of intents) {
      // 1. 查记录（权威读取，不接受前端提交的 field_name / 其它字段）
      const record = selectRecord.get(intent.recordId)
      if (!record) {
        conflict(409, `记录 #${intent.recordId} 不存在，无法更新（${UPDATE_CONCURRENCY_MSG}）`)
      }
      // 2. 乐观并发：当前值必须等于 preview 时的期望值
      const currentRaw = record.second_week_play
      const current =
        currentRaw === null || currentRaw === undefined ? null : Number(currentRaw)
      if (current !== intent.expectedBefore) {
        conflict(409, UPDATE_CONCURRENCY_MSG)
      }
      // 3. desired_after 合法（>= 0）
      if (!Number.isFinite(intent.desiredAfter) || intent.desiredAfter < 0) {
        conflict(400, '累计播放量必须为 >= 0 的数字')
      }
      // 4. 业务规则：累计播放量只允许「安全增长」（后端独立复核，绝不只依赖前端 evaluateImportUpdate）
      //    · current 为 null → 允许首次写入（>= 0 已在步骤 3 校验）
      //    · current 为有限数 → desired_after 必须严格大于 current（下降 / 持平一律拒绝，走人工处理）
      if (current !== null && intent.desiredAfter <= current) {
        conflict(400, '累计播放量更新必须高于当前值；下降或持平请人工处理。')
      }
      // 5. 若 first_play 是有效观测值：更新后的累计播放量不得小于 7 日播放量
      const firstRaw = record.first_play
      const first = firstRaw === null || firstRaw === undefined ? null : Number(firstRaw)
      if (first !== null && Number.isFinite(first) && intent.desiredAfter < first) {
        conflict(400, PLAY_RANGE_ERROR)
      }
      // 6. 审计（before/after JSON，保留 null 与 0）+ 7. 更新
      if (!hasImportMeta) {
        // 旧调用方路径：creator_record_edits 记账（与业务更新同一事务）
        insertRecordEditEvent(db, {
          recordId: intent.recordId,
          action: 'update',
          source: 'legacy_import_update',
          groupId: legacyGroupId,
          field: 'second_week_play',
          beforeValueJson: JSON.stringify(current),
          afterValueJson: JSON.stringify(intent.desiredAfter)
        })
      }
      updatePlay.run(intent.desiredAfter, intent.recordId)
      updatedIds.push(intent.recordId)
    }

    // 校验与更新全部通过后，再写批次日志 + 更新审计（无元数据时 batchId = null，旧调用方行为保持不变）
    const batchId = isWrapped
      ? writeImportBatch(req.body.batch, items.length, insertedIds, intents)
      : null

    return { insertedIds, updatedIds, batchId }
  })

  let result
  try {
    result = runAll(rows, updateIntents)
  } catch (error) {
    if (error && error.statusCode) return fail(res, error.statusCode, error.message)
    throw error
  }

  ok(res, {
    count: result.insertedIds.length,
    ids: result.insertedIds,
    batchId: result.batchId,
    updatedCount: result.updatedIds.length,
    updatedIds: result.updatedIds
  })
})

// ---------- 批量操作（批量修改 / 批量删除，必须先于 /:id 注册） ----------
// 单次批量操作上限（与批量导入保持一致）
const BATCH_LIMIT = 1000
// 允许批量修改的字段白名单（冻结，仅业务字段可批量修改，避免拼接出任意列）
const BATCH_UPDATE_FIELDS = Object.freeze({
  time_cycle: '时间周期',
  creator_type: '博主类型'
})
// 数据库原生 / 敏感字段：禁止批量修改，命中时返回针对性提示
const BATCH_UPDATE_DENY_FIELDS = Object.freeze([
  'id',
  'created_at',
  'nickname',
  'homepage',
  'content_link',
  'video_link',
  'total_cost',
  'publish_date',
  'first_play',
  'second_week_play'
])
// 允许字段的提示文案（用于非法 field 的报错信息）
const BATCH_UPDATE_ALLOWED_HINT = Object.keys(BATCH_UPDATE_FIELDS)
  .map((key) => `${key}（${BATCH_UPDATE_FIELDS[key]}）`)
  .join('、')

// 解析 id 数组：必须为非空正整数数组，自动去重
function parseBatchIds(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'ids 必须是非空数组' }
  }
  if (raw.length > BATCH_LIMIT) {
    return { error: `单次最多处理 ${BATCH_LIMIT} 条记录` }
  }
  const ids = []
  for (const item of raw) {
    const id = Number(item)
    if (!Number.isSafeInteger(id) || id <= 0) {
      return { error: 'ids 必须为正整数数组' }
    }
    ids.push(id)
  }
  return { ids: [...new Set(ids)] }
}

/**
 * POST /api/records/batch-update
 * 入参：{ ids: number[], field: 'time_cycle'|'creator_type', value: string }
 * 出参：{ successCount, failCount, failList: [{ id, reason }] }
 *      （同时保留 success / failed / errors 兼容字段，供现有前端读取）
 * 逐条更新：不存在的记录计入失败，其余照常更新（失败不影响成功记录）
 */
router.post('/batch-update', (req, res) => {
  const body = req.body && !Array.isArray(req.body) ? req.body : {}
  const { ids, error: idsError } = parseBatchIds(body.ids)
  if (idsError) return fail(res, 400, idsError)

  // 字段白名单校验：仅允许业务字段批量修改，禁止数据库原生 / 敏感字段
  if (typeof body.field !== 'string' || body.field.trim() === '') {
    return fail(res, 400, `field 必须为字符串，仅支持批量修改：${BATCH_UPDATE_ALLOWED_HINT}`)
  }
  const field = body.field.trim()
  if (!Object.prototype.hasOwnProperty.call(BATCH_UPDATE_FIELDS, field)) {
    return fail(
      res,
      400,
      BATCH_UPDATE_DENY_FIELDS.includes(field)
        ? `field 不允许批量修改数据库原生/敏感字段「${field}」，仅支持：${BATCH_UPDATE_ALLOWED_HINT}`
        : `field 非法，仅支持批量修改：${BATCH_UPDATE_ALLOWED_HINT}`
    )
  }

  const rawValue = body.value
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return fail(res, 400, `${BATCH_UPDATE_FIELDS[field]}不能为空`)
  }

  // 时间周期：与导入解析一致，先走标准周码解析（支持 YYYY-Wxx / 第33周 / 08/17-08/23 等）
  let value = String(rawValue).trim()
  if (field === 'time_cycle') {
    const parsed = parseTimeCycleToWeekCode(value)
    if (!parsed) {
      return fail(
        res,
        400,
        '时间周期格式不正确，需为 YYYY-Wxx 或 MM/DD-MM/DD 等完整自然周写法（周一到周日）'
      )
    }
    value = parsed
  }

  // 复用现有字段校验规则（长度 / 格式），保证与单条新增、编辑完全一致
  const { clean, errors: fieldErrors } = validate({ [field]: value }, { partial: true })
  if (fieldErrors.length) return fail(res, 400, fieldErrors.join('；'))
  const nextValue = clean[field]

  const errors = []
  let success = 0
  // 字段名来自白名单，值走占位符参数化查询
  const update = db.prepare(`UPDATE creator_records SET ${field} = ? WHERE id = ?`)
  // time_cycle 批量修改需要逐条读取「最终状态」：与 POST / PUT / batch 使用同一套发布日期归属规则
  const selectCycleState = db.prepare(
    'SELECT publish_date, time_cycle FROM creator_records WHERE id = ?'
  )
  const runAll = db.transaction((idList) => {
    for (const id of idList) {
      if (field === 'time_cycle') {
        const current = selectCycleState.get(id)
        if (!current) {
          errors.push({ id, reason: '记录不存在或已被删除' })
          continue
        }
        const cycleError = checkPublishCycleConsistency({ ...current, time_cycle: nextValue })
        if (cycleError) {
          // 单条拒绝，不写入错误周期；不影响其它合法记录
          errors.push({ id, reason: cycleError })
          continue
        }
      }
      const beforeRow = db.prepare('SELECT * FROM creator_records WHERE id = ?').get(id)
      const info = update.run(nextValue, id)
      if (info.changes > 0) {
        success += 1
        // Record Edit History V1：真实变化才写审计（无变化不伪造变更事件）
        const changes = recordFieldChanges(beforeRow, { ...beforeRow, [field]: nextValue })
        for (const change of changes) {
          insertRecordEditEvent(db, {
            recordId: id,
            action: 'update',
            source: 'manual_batch',
            groupId,
            field: change.field,
            beforeValueJson: change.beforeJson,
            afterValueJson: change.afterJson
          })
        }
      } else {
        errors.push({ id, reason: '记录不存在或已被删除' })
      }
    }
  })
  // Record Edit History V1：审计表缺失时拒绝批量修改（fail-closed，不静默绕过）
  const groupId = newRecordEditGroupId()
  try {
    assertCreatorRecordEditsReady(db)
    runAll(ids)
  } catch (error) {
    return fail(res, 500, error.message || '批量修改留痕写入失败，已整体回滚')
  }

  // 执行反馈：新版结构 successCount / failCount / failList；
  // 同时保留 success / failed / errors 兼容字段（现有投放管理页按旧字段读取，避免破坏）
  ok(res, {
    successCount: success,
    failCount: errors.length,
    failList: errors,
    success,
    failed: errors.length,
    errors
  })
})

/**
 * POST /api/records/batch-delete
 * 入参：{ ids: number[] }
 * 出参：{ success, failed, errors: [{ id, reason }] }
 * 与单条删除逻辑一致（物理删除），删除后看板/汇总自动同步
 */
router.post('/batch-delete', (req, res) => {
  const body = req.body && !Array.isArray(req.body) ? req.body : {}
  const { ids, error: idsError } = parseBatchIds(body.ids)
  if (idsError) return fail(res, 400, idsError)

  const errors = []
  let success = 0
  // Record Edit History V1：审计表缺失时拒绝批量删除（fail-closed）
  try {
    assertCreatorRecordEditsReady(db)
  } catch (error) {
    return fail(res, 500, error.message)
  }
  const groupId = newRecordEditGroupId()
  const remove = db.prepare('DELETE FROM creator_records WHERE id = ?')
  const removeMapping = db.prepare(DELETE_RECORD_MAPPING_SQL)
  const runAll = db.transaction((idList) => {
    for (const id of idList) {
      const beforeRow = db.prepare('SELECT * FROM creator_records WHERE id = ?').get(id)
      const info = remove.run(id)
      if (info.changes > 0) {
        success += 1
        // 删除前整行业务快照（record_id 保留，记录行已物理删除后仍可追溯）
        insertRecordEditEvent(db, {
          recordId: id,
          action: 'delete',
          source: 'batch_delete',
          groupId,
          field: RECORD_EDIT_ROW_FIELD,
          beforeValueJson: JSON.stringify(recordBusinessSnapshot(beforeRow)),
          afterValueJson: null
        })
        // 同步清理批次映射，避免删除后留下孤儿 mapping
        removeMapping.run(id)
      } else {
        errors.push({ id, reason: '记录不存在或已被删除' })
      }
    }
  })
  runAll(ids)

  ok(res, { success, failed: errors.length, errors })
})

// ---------- 3. 新增单条 ----------
router.post('/', (req, res) => {
  const body = Array.isArray(req.body) ? {} : req.body || {}
  const { clean, errors } = validate(body)
  if (errors.length) {
    return fail(res, 400, errors.join('；'))
  }
  // V2 播放量交叉校验（后端独立校验，不依赖前端表单）
  const playError = checkPlayRange(clean)
  if (playError) {
    return fail(res, 400, playError)
  }
  // 时间周期必须与发布日期所属标准周一致（后端独立校验）
  const cycleError = checkPublishCycleConsistency(clean)
  if (cycleError) {
    return fail(res, 400, cycleError)
  }

  const row = toRow(clean)
  // Creator Identity Phase 4：新 record 必须带上归属锚（身份歧义不阻塞事实写入）
  const recordId = recordIdentityWritable()
    ? insertRecordWithIdentity(row)
    : Number(db.prepare(INSERT_SQL).run(...COLUMNS.map((col) => row[col])).lastInsertRowid)
  const created = db
    .prepare(`${recordSelectSql()} WHERE id = ?`)
    .get(recordId)
  ok(res, created)
})

// ---------- 2. 查询单条详情 ----------
router.get('/:id', (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) {
    return fail(res, 400, '非法的记录 ID')
  }
  const row = db.prepare(`${recordSelectSql()} WHERE id = ?`).get(id)
  if (!row) {
    return fail(res, 404, '记录不存在')
  }
  ok(res, row)
})

// ---------- 4. 更新记录 ----------
router.put('/:id', (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) {
    return fail(res, 400, '非法的记录 ID')
  }

  // 读取完整原记录：PUT 需要基于「更新后的最终状态」做交叉校验
  const exists = db.prepare(`${recordSelectSql()} WHERE id = ?`).get(id)
  if (!exists) {
    return fail(res, 404, '记录不存在')
  }

  const body = Array.isArray(req.body) ? {} : req.body || {}
  // partial：只更新请求里明确提供的字段；null / 空字符串 = 明确清空（写 NULL）；0 = 真实值
  const { clean, errors } = validate(body, { partial: true })
  if (errors.length) {
    return fail(res, 400, errors.join('；'))
  }

  // 关键：合并请求值与旧值，对最终记录做播放量交叉校验
  // （例如只传 first_play=30000 而库里 second_week_play=20000 → 最终不合法，必须拒绝）
  const finalRecord = { ...exists, ...clean }
  const playError = checkPlayRange(finalRecord)
  if (playError) {
    return fail(res, 400, playError)
  }
  // 时间周期 与 发布日期 的一致性同样基于「更新后的最终状态」校验
  const cycleError = checkPublishCycleConsistency(finalRecord)
  if (cycleError) {
    return fail(res, 400, cycleError)
  }

  const keys = Object.keys(clean)
  if (keys.length > 0) {
    // Record Edit History V1：仅真实变化的字段产生审计事件；业务更新与审计同事务（fail-closed）
    const changes = recordFieldChanges(exists, { ...exists, ...clean })
    if (changes.length > 0) {
      try {
        assertCreatorRecordEditsReady(db)
        db.transaction(() => {
          for (const change of changes) {
            insertRecordEditEvent(db, {
              recordId: id,
              action: 'update',
              source: 'manual_single',
              groupId: null,
              field: change.field,
              beforeValueJson: change.beforeJson,
              afterValueJson: change.afterJson
            })
          }
          const sets = keys.map((key) => `${key} = ?`).join(', ')
          db.prepare(`UPDATE creator_records SET ${sets} WHERE id = ?`).run(
            ...keys.map((key) => clean[key]),
            id
          )
        })()
      } catch (error) {
        return fail(res, 500, error.message || '编辑留痕写入失败，更新已回滚')
      }
    }
  }
  ok(res, db.prepare(`${recordSelectSql()} WHERE id = ?`).get(id))
})

// ---------- 5. 删除记录 ----------
router.delete('/:id', (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) {
    return fail(res, 400, '非法的记录 ID')
  }
  // Record Edit History V1：审计表缺失时拒绝删除（fail-closed，不静默绕过审计）
  try {
    assertCreatorRecordEditsReady(db)
  } catch (error) {
    return fail(res, 500, error.message)
  }
  // 删除记录 + 同步清理其导入批次映射（同一事务，避免孤儿 mapping）
  const deleted = db.transaction((recordId) => {
    // 删除前先取整行业务快照（写入删除审计，供事后追溯）
    const beforeRow = db.prepare('SELECT * FROM creator_records WHERE id = ?').get(recordId)
    if (!beforeRow) return 0
    const info = db.prepare('DELETE FROM creator_records WHERE id = ?').run(recordId)
    if (info.changes === 0) return 0
    insertRecordEditEvent(db, {
      recordId,
      action: 'delete',
      source: 'manual_delete',
      groupId: null,
      field: RECORD_EDIT_ROW_FIELD,
      beforeValueJson: JSON.stringify(recordBusinessSnapshot(beforeRow)),
      afterValueJson: null
    })
    db.prepare(DELETE_RECORD_MAPPING_SQL).run(recordId)
    return info.changes
  })(id)
  if (deleted === 0) {
    return fail(res, 404, '记录不存在')
  }
  ok(res, { id })
})

// ---------- 6. 编辑历史查询（Record Edit History V1，只读） ----------
router.get('/:id/edits', (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) {
    return fail(res, 400, '非法的记录 ID')
  }
  // 只读接口：按事件 id 倒序稳定展示；审计表未初始化时如实返回 available=false（不写库、不报错）
  const available = creatorRecordEditsReady(db)
  const record = db.prepare('SELECT id FROM creator_records WHERE id = ?').get(id)
  let edits = []
  if (available) {
    const rows = db
      .prepare(
        `SELECT id, action, source, group_id, field_name, before_value_json, after_value_json, created_at
         FROM creator_record_edits
         WHERE record_id = ?
         ORDER BY id DESC
         LIMIT 500`
      )
      .all(id)
    const parseJsonSafe = (text) => {
      if (text === null || text === undefined) return null
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
    edits = rows.map((row) => ({
      id: row.id,
      action: row.action,
      source: row.source,
      group_id: row.group_id,
      field_name: row.field_name,
      before_value: parseJsonSafe(row.before_value_json),
      after_value: parseJsonSafe(row.after_value_json),
      created_at: row.created_at
    }))
  }
  ok(res, {
    record_id: id,
    // 记录行可能已被删除：审计事件仍按 record_id 保留并可查
    record_exists: Boolean(record),
    available,
    edits
  })
})

export default router
