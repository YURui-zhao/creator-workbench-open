import * as XLSX from 'xlsx'
import dayjs from 'dayjs'
import { calcCpm } from './calc.js'
import {
  dateToWeekCode,
  normalizeTimeCycleValue,
  parseTimeCycleToWeekCode,
  weekCodeToDateRange,
  weekCodeToLabel
} from './dateCycle.js'

// 时间周期格式换算统一收敛到 dateCycle.js（规则与后端一致），此处复用并保留对外导出
export { labelToWeekCode, normalizeTimeCycleValue, weekCodeToLabel } from './dateCycle.js'

// Excel 列名（中文）-> 数据库字段
// V2 正式表头：达人类型 / 总花费(元) / 7日播放量 / 累计播放量 / 视频链接
// 兼容历史表头：博主类型 / 总花费 / 首发播放量 / 次周播放量 / 视频发布链接 / 植入内容链接
// 兼容当前导出表头：植入链接 / 视频链接 / 总花费(元)
// 过渡表头：7日累计播放量 / 最新累计播放量
// 注意：second_week_play 只是历史数据库字段名，V2 业务含义是「累计播放量」（不是次周新增）
export const HEADER_MAP = {
  时间周期: 'time_cycle',
  达人昵称: 'nickname',
  达人主页: 'homepage',
  // 博主类型（旧名）与 达人类型（V2 正式名）指向同一字段
  博主类型: 'creator_type',
  达人类型: 'creator_type',
  // 植入内容链接（旧名）/ 植入链接（当前导出列名）
  植入内容链接: 'content_link',
  植入链接: 'content_link',
  // 总花费（旧名）/ 总花费(元)（V2 正式名 & 当前导出列名）
  总花费: 'total_cost',
  '总花费(元)': 'total_cost',
  发布日期: 'publish_date',
  // 视频发布链接（旧名）/ 视频链接（V2 正式名 & 当前导出列名）
  视频发布链接: 'video_link',
  视频链接: 'video_link',
  // 7日播放量 -> first_play
  '7日播放量': 'first_play',
  '7日累计播放量': 'first_play',
  首发播放量: 'first_play',
  // 累计播放量 -> second_week_play
  累计播放量: 'second_week_play',
  最新累计播放量: 'second_week_play',
  次周播放量: 'second_week_play'
}

export const FIELD_LABELS = {
  time_cycle: '时间周期',
  nickname: '达人昵称',
  homepage: '达人主页',
  creator_type: '达人类型',
  content_link: '植入链接',
  total_cost: '总花费',
  publish_date: '发布日期',
  video_link: '视频链接',
  first_play: '7日播放量',
  second_week_play: '累计播放量'
}

// 字段校验规则（与后端 / 新增表单保持一致）
const FIELD_RULES = {
  time_cycle: { required: true, type: 'time_cycle', max: 20 },
  nickname: { required: true, type: 'string', max: 100 },
  homepage: { type: 'url', max: 500 },
  creator_type: { type: 'string', max: 50 },
  content_link: { type: 'url', max: 500 },
  total_cost: { required: true, type: 'number' },
  publish_date: { required: true, type: 'date' },
  video_link: { type: 'url', max: 500 },
  first_play: { type: 'int' },
  second_week_play: { type: 'int' }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATE_FUZZY_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/

// ---------- 字段映射（Batch 6A：未知表头不得静默丢失）----------

/** 「忽略此列」的哨兵值（用户显式选择，或系统计算列自动忽略） */
export const IGNORE_FIELD = 'IGNORE'

/** 允许作为导入目标字段的白名单（也是映射下拉的顺序） */
export const IMPORT_FIELD_WHITELIST = [
  'time_cycle',
  'nickname',
  'creator_type',
  'homepage',
  'content_link',
  'video_link',
  'total_cost',
  'publish_date',
  'first_play',
  'second_week_play'
]

/** 字段映射下拉选项（含「忽略此列」） */
export const MAPPING_FIELD_OPTIONS = [
  { value: 'time_cycle', label: '时间周期' },
  { value: 'nickname', label: '达人昵称' },
  { value: 'creator_type', label: '达人类型' },
  { value: 'homepage', label: '达人主页' },
  { value: 'content_link', label: '植入链接' },
  { value: 'video_link', label: '视频链接' },
  { value: 'total_cost', label: '总花费' },
  { value: 'publish_date', label: '发布日期' },
  { value: 'first_play', label: '7日播放量' },
  { value: 'second_week_play', label: '累计播放量' },
  { value: IGNORE_FIELD, label: '忽略此列' }
]

// 系统计算列：导出文件自带、重新导入时天然忽略（属于「已知列」，不是未知字段）
const SYSTEM_IGNORED_HEADER_KEYS = new Set([
  'cpm',
  'cpm数据',
  '后续新增播放量',
  '7日后新增播放量'
])

// 归一化表头用于关键词匹配：去空格、全角括号转半角、小写
function normalizeHeaderKey(text) {
  return String(text ?? '')
    .trim()
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function isPlaceholderHeader(header) {
  return /^__EMPTY(_\d+)?$/i.test(String(header ?? '').trim())
}

/**
 * 本地确定性「字段建议」：仅根据表头关键词给出建议，绝不直接当作正式映射。
 * 结果只用于「建议映射」列，用户确认后才生效。
 * @param {string} header 原始表头
 * @returns {{ field: string, confidence: 'high'|'medium'|'low', reason: string }|null}
 */
export function suggestFieldForHeader(header) {
  const key = normalizeHeaderKey(header)
  if (!key) return null
  const has = (...words) => words.some((word) => key.includes(word))

  // 报价 / CPM / 单价：不是本系统字段，明确不给出映射建议（交由用户选择忽略）
  if (has('cpm', '报价', '单价')) return null

  // 播放量：先看限定词，避免「播放量（新）」被泛匹配成 7日播放量
  if (has('播放量', '播放数', '播放')) {
    if (has('7日', '七日', '首发', '首周', '第一周')) {
      return { field: 'first_play', confidence: 'high', reason: '表头含「首发 / 7日」，对应 7日播放量' }
    }
    if (has('累计', '最新', '次周', '第二周', '当前')) {
      return {
        field: 'second_week_play',
        confidence: 'high',
        reason: '表头含「累计 / 最新」，对应累计播放量'
      }
    }
    if (has('新')) {
      return {
        field: 'second_week_play',
        confidence: 'medium',
        reason: '表头含「新」，疑似最新累计播放量，请确认'
      }
    }
    return { field: '', confidence: 'low', reason: '仅含「播放」，无法区分 7日 / 累计播放量，请手动选择' }
  }

  // 链接类（先判断植入 / 视频，避免与「达人主页」混淆）
  if (has('植入')) return { field: 'content_link', confidence: 'high', reason: '表头含「植入」' }
  if (has('视频')) return { field: 'video_link', confidence: 'high', reason: '表头含「视频」链接' }
  if (has('主页', '首页')) return { field: 'homepage', confidence: 'high', reason: '表头含「主页」' }

  // 日期 / 周期
  if (has('时间周期', '周期', '周次', '投放周')) {
    return { field: 'time_cycle', confidence: 'high', reason: '表头含「周期 / 周」' }
  }
  if (has('日期', '发布时间', '发布日')) {
    return { field: 'publish_date', confidence: 'high', reason: '表头含「日期」' }
  }

  // 昵称 / 类型 / 花费
  if (has('昵称', '达人名', '博主名', '账号名', '达人')) {
    return { field: 'nickname', confidence: 'high', reason: '表头含「昵称 / 达人」' }
  }
  if (has('类型', '品类', '分类')) {
    return { field: 'creator_type', confidence: 'high', reason: '表头含「类型」' }
  }
  if (has('花费', '费用', '金额', '成本', '预算', '支出')) {
    return { field: 'total_cost', confidence: 'high', reason: '表头含「花费 / 金额」' }
  }
  return null
}

/**
 * 表头分类：内置映射 / 系统计算列 / 未识别
 * overrides 为「用户或 AI 显式指定」的映射（header -> 字段名 | IGNORE）
 * @returns {Array<{ header: string, field: string|null, status: 'mapped'|'ignored'|'system'|'unknown', source: string }>}
 */
export function classifyHeaders(headers, overrides = {}) {
  const list = Array.isArray(headers) ? headers : []
  const hasOverride = (header) => Object.prototype.hasOwnProperty.call(overrides, header)

  return list.map((header) => {
    const name = String(header ?? '')
    if (hasOverride(header)) {
      const target = overrides[header]
      if (target && IMPORT_FIELD_WHITELIST.includes(target)) {
        return { header: name, field: target, status: 'mapped', source: 'manual' }
      }
      // 显式忽略（IGNORE）或非法目标值：都按「用户已知情地忽略」处理，不再当作未知字段
      return { header: name, field: null, status: 'ignored', source: 'manual' }
    }
    const builtin = HEADER_MAP[name] || (FIELD_RULES[name] ? name : null)
    if (builtin) return { header: name, field: builtin, status: 'mapped', source: 'builtin' }
    if (SYSTEM_IGNORED_HEADER_KEYS.has(normalizeHeaderKey(name))) {
      return { header: name, field: null, status: 'system', source: 'system' }
    }
    return { header: name, field: null, status: 'unknown', source: 'unknown' }
  })
}

/**
 * 目标字段冲突检测：同一目标字段不允许有两个来源列（本轮不做字段合并）
 * @param {Array<{ header: string, target?: string, field?: string }>} mappings
 * @returns {Array<{ field: string, headers: string[] }>}
 */
export function detectMappingConflicts(mappings = []) {
  const byField = new Map()
  for (const item of Array.isArray(mappings) ? mappings : []) {
    const field = item?.target || item?.field
    if (!field || field === IGNORE_FIELD) continue
    if (!byField.has(field)) byField.set(field, [])
    byField.get(field).push(String(item.header ?? ''))
  }
  const conflicts = []
  for (const [field, headers] of byField) {
    if (headers.length > 1) conflicts.push({ field, headers })
  }
  return conflicts
}

/**
 * 构造「字段映射确认」面板初始数据
 * 规则：未识别字段一律默认「未选择」——即使系统 / AI 给出了建议，也**不会**自动选中；
 *      用户必须主动选择映射字段或「忽略此列」后才能继续导入。
 * @param {Object} result parseRecordsExcel 的解析结果
 * @returns {{ items: Array, loading: boolean, error: string, notice: string }|null}
 */
export function buildHeaderMappingReview(result) {
  const unknown = Array.isArray(result?.unknownHeaders) ? result.unknownHeaders : []
  if (!unknown.length) return null
  const suggestionMap = new Map(
    (result.headerSuggestions || []).map((item) => [item.header, item])
  )
  const samples = result.headerSamples || {}
  return {
    loading: false,
    error: '',
    notice: '',
    items: unknown.map((header) => {
      const suggestion = suggestionMap.get(header)
      return {
        header,
        samples: Array.isArray(samples[header]) ? samples[header] : [],
        // 未选择：建议不等于用户确认
        target: '',
        suggestion: suggestion?.field || '',
        confidence: suggestion?.confidence || '',
        reason: suggestion?.reason || '未能自动识别，请选择对应字段或选择「忽略此列」',
        source: suggestion?.field ? 'local' : 'none'
      }
    })
  }
}

/**
 * 是否所有未识别字段都已被用户明确选择（映射字段 或 忽略此列）
 */
export function isMappingReviewComplete(items = []) {
  return (Array.isArray(items) ? items : []).every((item) => Boolean(item?.target))
}

// 每列前 N 个非空样例值（供未知字段建议与 AI 参考）
function buildHeaderSamples(rawRows, headers, limit = 5) {
  const samples = new Map()
  for (const header of headers) {
    const values = []
    for (const row of rawRows) {
      const value = row?.[header]
      const text = value === undefined || value === null ? '' : String(value).trim()
      if (!text) continue
      if (values.includes(text)) continue
      values.push(text)
      if (values.length >= limit) break
    }
    samples.set(header, values)
  }
  return samples
}

// 重复表头行：整行与表头同名（≥2 列命中）→ 视为表头重复，跳过而不作为业务数据
function isRepeatedHeaderRow(raw, fieldByHeader) {
  let hits = 0
  for (const header of fieldByHeader.keys()) {
    const value = raw?.[header]
    if (value === undefined || value === null) continue
    if (String(value).trim() === String(header).trim()) hits += 1
    if (hits >= 2) return true
  }
  return false
}

// 合并单元格内换行分隔符（兼容 \n、\r\n、\r）
const NEWLINE_RE = /\r\n|\r|\n/
// 数值字段的「无数据」占位写法：必填按 0、非必填按 null（不报错）
const EMPTY_NUMBER_TOKENS = new Set([
  '',
  '/',
  '-',
  '--',
  '—',
  '——',
  '无',
  '空',
  '暂无',
  'n/a',
  'na',
  'null',
  'none'
])

function isEmptyNumberToken(value) {
  return EMPTY_NUMBER_TOKENS.has(String(value ?? '').trim().toLowerCase())
}

export const PLAY_RANGE_ERROR = '累计播放量不能小于7日播放量，请检查数据是否录入正确'

/**
 * 播放量跨字段校验（V2 规则）
 * 「7日播放量(first_play)」与「累计播放量(second_week_play)」同时有值时：
 * 累计播放量不得小于 7日播放量。
 * - 累计播放量为空 = 待更新，合法
 * - 7日播放量为空 = 未填写，合法
 * - 7日播放量 = 0 且 累计播放量 > 0 = 合法
 * @param {Object} row 已归一化的行数据
 * @returns {{ field: string, reason: string }|null}
 */
export function findPlayRangeError(row = {}) {
  const firstRaw = row.first_play
  const latestRaw = row.second_week_play
  if (firstRaw === undefined || firstRaw === null || firstRaw === '') return null
  if (latestRaw === undefined || latestRaw === null || latestRaw === '') return null
  const first = Number(firstRaw)
  const latest = Number(latestRaw)
  if (!Number.isFinite(first) || !Number.isFinite(latest)) return null
  if (latest < first) return { field: 'second_week_play', reason: PLAY_RANGE_ERROR }
  return null
}

// ---------- Record Identity（one content/video = one creator_record） ----------
//
// 身份只由「视频内容链接」决定：normalizeRecordIdentityLink(video_link) 相同 => 同一条 record。
// mutable business facts（花费 / 7日播放 / 累计播放 / 类型 / 主页 / 发布日期）**不参与身份判断**，
// 它们只在「身份已经相同」之后用于比较事实是否变化（精确重复 / 无新增信息 / 有变化）。
//
// 历史实现的错误：把 10 个字段（含 second_week_play 等可变事实）整体作为指纹，
// 导致「累计播放量更新」被误判成新记录（2026-10 的 1008.xlsx：11 条误判）。
export const IDENTITY_UNCERTAIN = 'identity_uncertain'
export const IDENTITY_FIELD = 'video_link'

// 事实字段：仅用于同 identity 之后的差异比较，绝不用于判断「是不是同一条记录」
export const RECORD_FACT_FIELDS = [
  'creator_type',
  'homepage',
  'content_link',
  'total_cost',
  'publish_date',
  'first_play',
  'second_week_play'
]

export const RECORD_FACT_LABELS = {
  creator_type: '达人类型',
  homepage: '达人主页',
  content_link: '植入内容链接',
  total_cost: '总花费',
  publish_date: '发布日期',
  first_play: '7日播放量',
  second_week_play: '累计播放量'
}

/**
 * 记录身份链接归一化（纯函数，确定性；不做短链展开 / 不做 AI / 不做 fuzzy）
 *   · trim、去 query、去 fragment、去 trailing slash
 *   · hostname 去 www.、去端口、小写；scheme（http/https/协议相对）不影响身份
 *   · 空 / 缺失 => ''（调用方据此判为 identity_uncertain，不得自动判重复或新增）
 */
export function normalizeRecordIdentityLink(url) {
  if (url === null || url === undefined) return ''
  const raw = String(url).trim()
  if (!raw) return ''
  const withoutHash = raw.split('#')[0]
  const withoutQuery = withoutHash.split('?')[0]
  const withoutScheme = withoutQuery.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  const hostAndPath = withoutScheme.replace(/^\/\//, '')
  const slashIndex = hostAndPath.indexOf('/')
  const hostPart = slashIndex === -1 ? hostAndPath : hostAndPath.slice(0, slashIndex)
  const pathPart = slashIndex === -1 ? '' : hostAndPath.slice(slashIndex)
  const host = hostPart.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '')
  const path = pathPart.replace(/\/+$/, '')
  return `${host}${path}`
}

/** 事实值归一化：数字与数字字符串等价；0 是真实值；空字符串/null/undefined 表示「未提供」 */
function normalizeFactValue(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? value : ''
  const text = String(value).trim()
  if (text === '') return ''
  const num = Number(text)
  return Number.isFinite(num) ? num : text
}

/**
 * 字段级差异（事实比较，不使用「整行覆盖」思维）
 * change_type：
 *   · incoming_missing —— Excel 未提供该事实（含 DB 有值 / DB 为 0），**绝不视作需要覆盖**
 *   · new_information  —— DB 空、Excel 提供了值（真正的新事实）
 *   · changed_value    —— 两边都有值且不同（真正的事实变化）
 */
export function buildRecordFieldDiff(existingRow = {}, incomingRow = {}) {
  const diffs = []
  for (const field of RECORD_FACT_FIELDS) {
    const existing = normalizeFactValue(existingRow?.[field])
    const incoming = normalizeFactValue(incomingRow?.[field])
    let changeType = null
    if (incoming === '') changeType = 'incoming_missing'
    else if (existing === '') changeType = 'new_information'
    else if (String(existing) !== String(incoming)) changeType = 'changed_value'
    if (changeType) {
      diffs.push({
        field,
        label: RECORD_FACT_LABELS[field] || field,
        existing_value: existingRow?.[field] ?? null,
        incoming_value: incomingRow?.[field] ?? null,
        change_type: changeType
      })
    }
  }
  return diffs
}

/** 只有「真正的新事实」才允许进入 existing_changed（incoming_missing 永远不算变化） */
function hasUpdatableChange(diffs) {
  return diffs.some((diff) => diff.change_type !== 'incoming_missing')
}

/**
 * 导入分类（替换 10 字段 fingerprint dedupe）
 * @returns {{ newRecords: Array, exactDuplicates: Array, existingNoop: Array, existingChanged: Array, identityUncertain: Array }}
 *   每项形如 { row, existingRow?, diffs?, reason }
 */
export function classifyImportRows(rows = [], existingRows = []) {
  const byIdentity = new Map()
  const ambiguousIdentities = new Set()
  for (const record of existingRows) {
    const key = normalizeRecordIdentityLink(record?.[IDENTITY_FIELD])
    if (!key) continue
    if (byIdentity.has(key)) ambiguousIdentities.add(key)
    else byIdentity.set(key, record)
  }

  const result = {
    newRecords: [],
    exactDuplicates: [],
    existingNoop: [],
    existingChanged: [],
    identityUncertain: []
  }
  const seenIncoming = new Map()

  for (const row of Array.isArray(rows) ? rows : []) {
    const key = normalizeRecordIdentityLink(row?.[IDENTITY_FIELD])
    if (!key) {
      result.identityUncertain.push({ row, reason: '缺少可用于判定记录身份的视频链接，需人工确认' })
      continue
    }
    if (seenIncoming.has(key)) {
      // 文件内部重复：与本次已出现的第一条比较（不重复导入）
      const first = seenIncoming.get(key)
      const diffs = buildRecordFieldDiff(first, row)
      if (diffs.length === 0) {
        result.exactDuplicates.push({ row, existingRow: first, diffs, reason: '文件内重复（同一视频链接，事实一致）' })
      } else {
        result.existingChanged.push({ row, existingRow: first, diffs, reason: '文件内重复（同一视频链接，事实不同）' })
      }
      continue
    }
    seenIncoming.set(key, row)

    if (ambiguousIdentities.has(key)) {
      result.identityUncertain.push({ row, reason: '该视频链接在库中对应多条记录，无法确定身份' })
      continue
    }
    const existing = byIdentity.get(key)
    if (!existing) {
      result.newRecords.push({ row })
      continue
    }
    const diffs = buildRecordFieldDiff(existing, row)
    if (hasUpdatableChange(diffs)) {
      result.existingChanged.push({ row, existingRow: existing, diffs, reason: '同一条记录，但出现新的事实变化' })
    } else if (diffs.length === 0) {
      result.exactDuplicates.push({ row, existingRow: existing, diffs, reason: '与已有记录完全重复（同一视频链接，事实一致）' })
    } else {
      result.existingNoop.push({ row, existingRow: existing, diffs, reason: '与已有记录同一条，Excel 未提供更强的新信息' })
    }
  }
  return result
}

/**
 * Preview 可用性判定（**与「可新增导入」严格区分**）
 *
 * update-only / 全重复文件仍然包含「可处理、可审查」的业务行，必须允许进入 Preview 查看分类结果，
 * 否则用户会被 Step 2 的「文件中没有有效数据」误拦。
 *
 * 只有「完全没有业务行」（例如整份文件都是空行 / 解析失败）才判定为无有效数据。
 *
 * @param {Object} params
 * @param {Object} [params.classification] classifyImportRows 的结果；缺省（拉取已有记录失败）时退化为解析行数
 * @param {number} [params.parsedValidCount] 未分类时解析得到的有效行数
 * @param {number} [params.failedCount] 本地校验失败行数
 * @param {number} [params.confirmationCount] 需人工确认行数
 * @returns {boolean}
 */
export function isPreviewEligible({
  classification = null,
  parsedValidCount = 0,
  failedCount = 0,
  confirmationCount = 0
} = {}) {
  const newCount = classification ? classification.newRecords.length : parsedValidCount
  const existingCount = classification
    ? classification.exactDuplicates.length +
      classification.existingNoop.length +
      classification.existingChanged.length +
      classification.identityUncertain.length
    : 0
  return newCount + existingCount + failedCount + confirmationCount > 0
}

// ---------- Existing Record Update V0.1（安全更新已有记录） ----------
//
// 范围极窄：**只允许** second_week_play（累计播放量）且只允许安全增长。
// 其它字段（total_cost / first_play / publish_date / creator_type / homepage / content_link）
// 以及累计播放量下降，一律进入 manual_review，绝不自动覆盖。
export const UPDATE_FIELD = 'second_week_play'

/**
 * 判定一条 existing_changed 是否属于「可安全更新」
 * safe_update 条件（全部满足）：
 *   1. identity 已通过 normalized video_link 唯一匹配（进入 existingChanged 即保证）
 *   2. incoming second_week_play 是有限数字
 *   3. incoming second_week_play >= 0
 *   4. existing second_week_play 为 null/缺失，或 incoming > existing（只允许增长）
 *   5. 若 effective first_play 是有效观测值：incoming >= first_play
 *      （effective first_play = Excel 提供时用 Excel 值，否则沿用 DB 已有值）
 *   6. 除 incoming_missing 外，不存在其它 effective changed/new_information 字段
 *
 * @returns {{ safe: boolean, reason: string, field: string, before: number|null, after: number|null }}
 */
export function evaluateImportUpdate(item = {}) {
  const existingRow = item.existingRow || {}
  const incomingRow = item.row || {}
  const diffs = Array.isArray(item.diffs) ? item.diffs : []
  const base = { field: UPDATE_FIELD, before: null, after: null }

  // 条件 6：除累计播放量外还有其它真实变化 → 人工处理
  const effective = diffs.filter((diff) => diff.change_type !== 'incoming_missing')
  const otherChanges = effective.filter((diff) => diff.field !== UPDATE_FIELD)
  if (otherChanges.length > 0) {
    return {
      ...base,
      safe: false,
      reason: `除累计播放量外还存在其它字段变化（${otherChanges
        .map((diff) => RECORD_FACT_LABELS[diff.field] || diff.field)
        .join('、')}），需人工处理`
    }
  }

  const playDiff = effective.find((diff) => diff.field === UPDATE_FIELD)
  if (!playDiff) {
    return { ...base, safe: false, reason: '未检测到可安全更新的累计播放量变化，需人工处理' }
  }

  const after = normalizeFactValue(incomingRow[UPDATE_FIELD])
  const beforeRaw = normalizeFactValue(existingRow[UPDATE_FIELD])
  const before = beforeRaw === '' ? null : beforeRaw
  // 条件 2 / 3：必须是有限数字且 >= 0
  if (after === '' || typeof after !== 'number' || !Number.isFinite(after) || after < 0) {
    return { ...base, before, safe: false, reason: '累计播放量不是有效的非负数字，需人工处理' }
  }
  // 条件 4：只允许增长（DB 为 null 时允许首次写入）
  if (before !== null && !(after > before)) {
    return {
      ...base,
      before,
      after,
      safe: false,
      reason: '累计播放量未增长（不自动下调 / 不覆盖），需人工处理'
    }
  }
  // 条件 5：更新后不得小于 7 日播放量（effective first_play）
  const incomingFirst = normalizeFactValue(incomingRow.first_play)
  const existingFirst = normalizeFactValue(existingRow.first_play)
  const effectiveFirst = incomingFirst !== '' ? incomingFirst : existingFirst
  if (effectiveFirst !== '' && typeof effectiveFirst === 'number' && Number.isFinite(effectiveFirst)) {
    if (after < effectiveFirst) {
      return {
        ...base,
        before,
        after,
        safe: false,
        reason: '累计播放量小于7日播放量，需人工处理'
      }
    }
  }
  return { safe: true, reason: '仅累计播放量安全增长', field: UPDATE_FIELD, before, after }
}

/**
 * 把 existing_changed 拆成「可安全更新」与「需人工处理」
 * @returns {{ safeUpdates: Array, manualReview: Array }}
 */
export function splitExistingChanges(existingChanged = []) {
  const safeUpdates = []
  const manualReview = []
  for (const item of Array.isArray(existingChanged) ? existingChanged : []) {
    const verdict = evaluateImportUpdate(item)
    if (verdict.safe) safeUpdates.push({ ...item, update: verdict })
    else manualReview.push({ ...item, update: verdict })
  }
  return { safeUpdates, manualReview }
}

/**
 * 由 safeUpdates 生成后端的更新意图（前端只提交 record_id / expected_before / desired_after；
 * 绝不提交任意 field_name —— V0.1 后端固定更新 second_week_play）
 */
export function buildUpdateIntents(safeUpdates = []) {
  return (Array.isArray(safeUpdates) ? safeUpdates : [])
    .filter((item) => item?.existingRow?.id && item?.update?.safe)
    .map((item) => ({
      record_id: item.existingRow.id,
      expected_before: item.update.before,
      desired_after: item.update.after
    }))
}

// ---------- 日期与单元格归一化 ----------
function excelSerialToDate(serial) {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000
  const date = new Date(ms)
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function normalizeDate(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (DATE_RE.test(text)) return text
  // 兼容 2024/7/22、2024.7.22 等写法
  const fuzzy = text.match(DATE_FUZZY_RE)
  if (fuzzy) {
    return `${fuzzy[1]}-${fuzzy[2].padStart(2, '0')}-${fuzzy[3].padStart(2, '0')}`
  }
  // 兼容 Excel 日期序列号（如 45536）
  const num = Number(text)
  if (Number.isFinite(num) && num >= 20000 && num <= 60000) {
    return excelSerialToDate(num)
  }
  return text
}

// ---------- 发布时间 -> 标准投放周（time_cycle 的唯一事实来源）----------
// 语义（已冻结）：time_cycle = 发布日期所属的标准自然周（周一 ~ 周日）
// 纯确定性日期计算，绝不交给 AI 推理，也不做字符串硬算。

// 源业务周期（Excel 原分组）与发布日期不匹配时的提示文案。
// 注意：sourceTimeCycle 是「业务/考核分组区间」，不要求周一起始、不要求 7 天，
// 因此它天然可能不等于 canonical 自然周 —— 这本身不是问题，不得报警。
// 只有「发布日期实际落在源区间之外」才是数据质量问题。
export const SOURCE_RANGE_ERROR = '不在源时间周期'
export const SOURCE_CONFLICT_MESSAGE = '发布时间不在当前投放档期内，请确认业务归属。'

// 源业务区间文本：M/D、M.D、M月D日 等写法，分隔符支持 - ~ ～ 至 到
const BUSINESS_RANGE_RE =
  /^(\d{1,2})[./月](\d{1,2})日?[-–—~～至到](\d{1,2})[./月](\d{1,2})日?$/

function pad2(value) {
  return String(value).padStart(2, '0')
}

function buildValidDate(year, month, day) {
  const date = new Date(year, month - 1, day)
  // 拒绝 2 月 30 日这类溢出后被自动进位的写法
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return date
}

function toDateText(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 解析 Excel 原业务/考核分组周期（sourceTimeCycle）为日期区间。
 * - 不要求周一起始、不要求恰好 7 天（如 09/01-09/08、09/03-09/09 都是合法业务区间）
 * - 年份按 referenceDate（通常是发布日期）就近推断，跨月 / 跨年正确
 * - 完全不使用 parseTimeCycleToWeekCode（该方法只接受标准自然周）
 * @param {string} text 原始文本
 * @param {string|Date} [referenceDate] 参考日期（发布日期），用于年份推断
 * @returns {{ startDate: string, endDate: string }|null}
 */
export function parseBusinessDateRange(text, referenceDate) {
  const raw = String(text ?? '').replace(/\s+/g, '')
  if (!raw) return null

  // 显式周码写法（2026-W35）：按标准自然周展开
  const weekMatch = /^(\d{4})-W(\d{1,2})$/i.exec(raw)
  if (weekMatch) {
    const range = weekCodeToDateRange(`${weekMatch[1]}-W${weekMatch[2]}`)
    return range ? { startDate: range.startDate, endDate: range.endDate } : null
  }

  const match = BUSINESS_RANGE_RE.exec(raw)
  if (!match) return null
  const [, m1, d1, m2, d2] = match
  const ref = referenceDate instanceof Date ? referenceDate : new Date(`${String(referenceDate ?? '').trim()}T00:00:00`)
  const refValid = !Number.isNaN(ref.getTime())
  const refText = refValid ? toDateText(ref) : ''

  // 候选区间：参考年 / 参考年±1，取「包含参考日期」的那个；都不包含时取参考年
  const candidates = []
  const baseYear = refValid ? ref.getFullYear() : new Date().getFullYear()
  for (const year of [baseYear, baseYear - 1, baseYear + 1]) {
    const start = buildValidDate(year, Number(m1), Number(d1))
    if (!start) continue
    let end = buildValidDate(year, Number(m2), Number(d2))
    if (!end) continue
    // 跨年（如 12/28-01/03）：结束日期早于开始日期时，视为次年
    if (end.getTime() < start.getTime()) {
      end = buildValidDate(year + 1, Number(m2), Number(d2))
      if (!end) continue
    }
    candidates.push({ startDate: toDateText(start), endDate: toDateText(end) })
  }
  if (!candidates.length) return null
  if (!refValid || !refText) return candidates[0]

  const containing = candidates.find(
    (item) => refText >= item.startDate && refText <= item.endDate
  )
  if (containing) return containing
  // 没有包含参考日期的候选：返回与参考日期距离最近的那个（用于给出「不在区间内」的判断）
  const distance = (item) => {
    if (refText < item.startDate) return new Date(`${item.startDate}T00:00:00`) - ref
    if (refText > item.endDate) return ref - new Date(`${item.endDate}T00:00:00`)
    return 0
  }
  return candidates.slice().sort((a, b) => distance(a) - distance(b))[0]
}

/**
 * 源业务区间一致性检查：发布日期是否落在 Excel 原业务周期内。
 * - sourceTimeCycle 缺失 / 不是可解析的日期范围 → 无法检查，返回 null（不报错）
 * - 落在区间内 → null（合法，不产生任何警告）
 * - 落在区间外 → 返回错误文案（数据质量异常）
 * @param {Object} row 解析行（需含 publish_date 与 sourceTimeCycleRaw/sourceTimeCycle）
 * @returns {{ reason: string, range: Object }|null}
 */
export function checkSourceTimeCycleRange(row = {}) {
  const sourceText = String(row.sourceTimeCycleRaw || row.sourceTimeCycle || '').trim()
  const publishDate = typeof row.publish_date === 'string' ? row.publish_date.trim() : ''
  if (!sourceText || !publishDate) return null
  const range = parseBusinessDateRange(sourceText, publishDate)
  if (!range) return null
  if (publishDate >= range.startDate && publishDate <= range.endDate) return null
  return {
    // 文案按业务要求明确给出「发布日期 / 源周期」，便于在预览与失败明细中追溯
    reason: `发布日期 ${publishDate} ${SOURCE_RANGE_ERROR} ${sourceText} 内，请检查原始数据。`,
    range
  }
}

/**
 * 发布日期 -> 标准周码（YYYY-Wxx，周一为每周第一天）
 * @param {string|Date} date 发布日期（YYYY-MM-DD / Date）
 * @returns {string|null} 标准周码；日期非法或为空时返回 null
 */
export function publishDateToWeekCode(date) {
  const text = date instanceof Date ? '' : String(date ?? '').trim()
  const parsed = date instanceof Date ? date : new Date(`${text}T00:00:00`)
  if (!parsed || Number.isNaN(parsed.getTime())) return null
  // 以该日期所属年份作为跨年归属基准（周一所在年优先，年末/年初都正确）
  return dateToWeekCode(parsed, parsed.getFullYear())
}

/**
 * 发布日期 -> 标准周区间标签（08/31-09/06）
 * @param {string|Date} date 发布日期
 * @returns {string|null}
 */
export function publishDateToTimeCycle(date) {
  const weekCode = publishDateToWeekCode(date)
  return weekCode ? weekCodeToLabel(weekCode) : null
}

// ---------- 单元格清洗与校验 ----------
// 数值解析：去掉货币符号/千分位/空格/「元」后缀，并支持「1.2万」「1万」「1.5亿」写法
function parseQuantity(value) {
  const text = String(value).trim()
  const compact = text.replace(/[,\s，￥¥$€£]/g, '').replace(/元$/, '')
  const unit = /^([\d.]+)(万|亿)$/.exec(compact)
  if (unit) {
    const num = parseFloat(unit[1]) * (unit[2] === '亿' ? 100000000 : 10000)
    return Number.isFinite(num) ? num : null
  }
  const num = Number(compact)
  return Number.isFinite(num) ? num : null
}

// 金额：支持货币符号、千分位与中文数量级写法
function parseNumber(value) {
  return parseQuantity(value)
}

// 播放量：支持千分位与「x.x万」写法，必须是整数
function parseIntCell(value) {
  const num = parseQuantity(value)
  return num !== null && Number.isInteger(num) ? num : null
}

// 链接：校验 http/https，无协议但像域名时自动补全 https://
function normalizeUrl(value) {
  const text = String(value).trim()
  if (/^https?:\/\//i.test(text)) return text
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/i.test(text)) {
    return `https://${text}`
  }
  return null
}

/**
 * 单元格级判定：按所属列规则清洗并校验，返回该列需要的数据或错误原因
 * @returns {{ value: any, error: string|null }}
 */
function normalizeCellValue(field, value) {
  const spec = FIELD_RULES[field]
  const label = FIELD_LABELS[field] || field
  const empty = value === undefined || value === null || String(value).trim() === ''

  if (spec.required && empty) return { value, error: `${label}不能为空` }
  if (empty) return { value: undefined, error: null }

  if (spec.type === 'time_cycle') {
    const text = String(value).trim().replace(/^(\d{4})-w/i, '$1-W')
    if (text.length > spec.max) return { value, error: `${label}长度不能超过 ${spec.max}` }
    if (!/^\d{4}-W\d{1,2}$/.test(text)) {
      return {
        value,
        error: `${label}格式不正确，需为 YYYY-Wxx 或 MM/DD-MM/DD 格式，且必须是周一到周日的完整自然周`
      }
    }
    return { value: text, error: null }
  }

  if (spec.type === 'url') {
    const url = normalizeUrl(value)
    if (url === null) return { value, error: `${label}必须是有效链接（http/https）` }
    if (url.length > spec.max) return { value, error: `${label}长度不能超过 ${spec.max}` }
    return { value: url, error: null }
  }

  if (spec.type === 'number' || spec.type === 'int') {
    // 总花费业务写法：'免费' = 0（仅 total_cost 生效；不泛化成「所有文字 → 0」）
    if (field === 'total_cost') {
      const text = String(value).trim()
      if (text === '免费') return { value: 0, error: null }
    }
    // 占位写法（/ - -- 无 空 暂无 等）：必填字段按 0，非必填字段按 null（不报错）
    if (isEmptyNumberToken(value)) {
      return spec.required ? { value: 0, error: null } : { value: undefined, error: null }
    }
    const isInt = spec.type === 'int'
    const num = isInt ? parseIntCell(value) : parseNumber(value)
    const intError = `${label}必须为非负整数（支持 1.2万 / 1,234 写法）`
    const numberError = `${label}必须为非负数字（自动识别货币符号/千分位）`
    // 播放量（非负整数）显式校验：负数、非法写法都报错，不能静默置空
    if (num === null) {
      if (isInt) return { value, error: intError }
      if (!spec.required) return { value: undefined, error: null }
      return { value, error: numberError }
    }
    if (num < 0) {
      return { value, error: isInt ? intError : numberError }
    }
    return { value: num, error: null }
  }

  if (spec.type === 'date') {
    const text = String(value).trim()
    if (!DATE_RE.test(text)) return { value, error: `${label}格式必须为 YYYY-MM-DD` }
    return { value: text, error: null }
  }

  if (spec.type === 'string') {
    const text = String(value).trim()
    if (text.length > spec.max) return { value, error: `${label}长度不能超过 ${spec.max}` }
    return { value: text, error: null }
  }

  return { value, error: null }
}

/**
 * 展开合并单元格：把每个合并区域左上角的值回填到该区域覆盖的所有行
 * （sheet_to_json 默认只读取合并区域的左上角单元格，其余覆盖行为空）
 * @param {Object} sheet 工作表对象
 * @param {Array<Object>} rawRows 按 Excel 物理行号排列的原始数据行（包含空白行）
 * @param {number} firstDataRow 第一条数据行的 SheetJS 零基行号
 */
function expandMergedCells(sheet, rawRows, firstDataRow) {
  const merges = sheet['!merges']
  if (!Array.isArray(merges) || merges.length === 0) return

  // 表头行（第 1 行）：列号 -> 表头名
  const headerRow = (XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] || []).map((cell) =>
    cell === undefined || cell === null ? '' : String(cell).trim()
  )

  for (const merge of merges) {
    const { s, e } = merge
    const headerName = headerRow[s.c]
    if (!headerName) continue // 无法映射列名的合并区域跳过

    const cell = sheet[XLSX.utils.encode_cell({ r: s.r, c: s.c })]
    if (!cell || cell.v === undefined || cell.v === null) continue
    const rawValue = cell.w !== undefined ? cell.w : cell.v
    const text = String(rawValue)

    // 场景一：合并单元格内换行多值（视觉上每行一个值）
    // 按换行拆分 -> 去空行 -> 去首尾空格，依次填充到合并区域每一行：
    // 值不足时剩余行留空（不强行补值），值超出时只取前 N 个（不溢出）
    if (NEWLINE_RE.test(text)) {
      const values = text
        .split(NEWLINE_RE)
        .map((item) => item.trim())
        .filter((item) => item !== '')
      const totalRows = e.r - s.r + 1
      for (let i = 0; i < totalRows; i += 1) {
        const row = rawRows[s.r + i - firstDataRow]
        if (!row) continue
        row[headerName] = i < values.length ? values[i] : undefined
      }
      continue
    }

    // 场景二：合并单元格单值，回填到该区域覆盖的所有行（跳过左上角首行，其本身已有值）
    for (let r = s.r + 1; r <= e.r; r += 1) {
      const row = rawRows[r - firstDataRow]
      if (row) row[headerName] = rawValue
    }
  }
}

/**
 * 解析 Excel 文件并完成字段映射与行级校验
 * @param {File} file 上传的 .xlsx / .xls 文件
 * @param {Array<Object>} [cycles] 后端周期选项（用于月日区间自动识别为周码）
 * @param {{ overrides?: Object }} [options] overrides：用户 / AI 显式指定的字段映射
 *        （header -> 字段名 | IGNORE_FIELD；未列出的表头仍走内置映射）
 * @returns {Promise<{
 *   fileName: string,
 *   headers: string[],
 *   mappedFields: string[],
 *   missingFields: string[],
 *   recognizedHeaders: string[],
 *   unknownHeaders: string[],
 *   ignoredHeaders: string[],
 *   headerMappings: Array<Object>,
 *   headerSuggestions: Array<Object>,
 *   headerSamples: Object,
 *   previewRows: Array<Object>,
 *   validRows: Array<Object>,
 *   failedRows: Array<{ rowIndex: number, reason: string }>
 * }>}
 */
export async function parseRecordsExcel(file, cycles = [], options = {}) {
  const overrides =
    options && typeof options.overrides === 'object' && options.overrides !== null
      ? options.overrides
      : {}
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const sheetRange = XLSX.utils.decode_range(sheet['!ref'] || 'A1')
  const firstDataRow = sheetRange.s.r + 1
  const parsedRows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  // sheet_to_json 默认省略完全空白的行；按 __rowNum__ 恢复物理行序，
  // 以免合并区域回填、周期继承与报错行号被压缩后的数组下标带偏。
  const rowsBySheetRow = new Map(parsedRows.map((row) => [row.__rowNum__, row]))
  const rawRows = Array.from(
    { length: Math.max(0, sheetRange.e.r - firstDataRow + 1) },
    (_, index) => rowsBySheetRow.get(firstDataRow + index) || {}
  )
  // 合并单元格展开补值：确保覆盖行都能读到完整值（如合并的时间周期列）
  expandMergedCells(sheet, rawRows, firstDataRow)

  // 原始表头（保持首次出现顺序、去重）
  const headers = []
  const seen = new Set()
  for (const row of rawRows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        headers.push(key)
      }
    }
  }

  // 每列样例值（未知字段建议 / AI 识别参考）
  const sampleMap = buildHeaderSamples(rawRows, headers)
  // 表头分类：内置映射 / 手工映射 / 系统计算列 / 未识别
  const classified = classifyHeaders(headers, overrides)
  // 未识别的「无表头空列」（__EMPTY）没有任何列名与数据，直接不算「未识别字段」，避免无效打扰
  const unknownHeaders = classified
    .filter((item) => item.status === 'unknown')
    .filter((item) => !isPlaceholderHeader(item.header) || (sampleMap.get(item.header) || []).length > 0)
    .map((item) => item.header)
  const recognizedHeaders = classified.filter((item) => item.field).map((item) => item.header)
  const ignoredHeaders = classified.filter((item) => item.status === 'ignored').map((item) => item.header)
  const systemIgnoredHeaders = classified.filter((item) => item.status === 'system').map((item) => item.header)

  // 列 -> 目标字段（仅已映射的列参与行解析；未映射 / 忽略的列不会读写任何字段）
  const fieldByHeader = new Map(
    classified.filter((item) => item.field).map((item) => [item.header, item.field])
  )

  // 未知字段的本地确定性建议（只作「建议」，用户确认后才生效）
  const headerSuggestions = unknownHeaders
    .map((header) => {
      const suggestion = suggestFieldForHeader(header)
      if (!suggestion) return null
      return { header, field: suggestion.field, confidence: suggestion.confidence, reason: suggestion.reason }
    })
    .filter(Boolean)

  const suggestionMap = new Map(headerSuggestions.map((item) => [item.header, item]))
  const headerMappings = classified.map((item) => {
    const suggestion = suggestionMap.get(item.header) || null
    return {
      header: item.header,
      field: item.field,
      status: item.status,
      source: item.source,
      suggestion: suggestion ? suggestion.field : '',
      confidence: suggestion ? suggestion.confidence : '',
      reason: suggestion ? suggestion.reason : ''
    }
  })

  // 已匹配到的数据库字段（表头 -> 字段名，去重）
  const mappedFields = headers
    .map((h) => fieldByHeader.get(h))
    .filter(Boolean)
  const missingFields = Object.keys(FIELD_RULES).filter(
    (f) => FIELD_RULES[f].required && !mappedFields.includes(f)
  )

  const mappedRows = []
  const validRows = []
  const failedRows = []
  const confirmationRows = []
  // 自动跳过的空白行（整行无有效值，不进入校验与报错列表）
  const blankRowIndexes = []
  // 重复表头行（整行与表头同名）：跳过，不继承时间周期、不作为业务数据
  const headerRowIndexes = []
  // 本地规则无法识别的时间周期原始值（去重，供 AI 兜底识别）
  const unrecognizedCycles = new Set()
  // 发布日期不在 Excel 原业务周期内的行：单列为需确认，不自动入库。
  const sourceRangeViolations = []
  // 非合并空周期的兜底继承，仅在同一段连续业务行内生效。
  let carriedCycle = ''

  rawRows.forEach((raw, index) => {
    const rowIndex = firstDataRow + index + 1

    // 重复表头行：整行与表头同名 → 跳过（既不继承周期，也不参与校验 / 入库）
    if (isRepeatedHeaderRow(raw, fieldByHeader)) {
      headerRowIndexes.push(rowIndex)
      carriedCycle = ''
      return
    }

    const mapped = { rowIndex }
    let hasValue = false
    // Excel 自带的「时间周期」列：只作为来源信息（sourceTimeCycle），不再是最终事实来源
    let sourceCycleRaw = ''

    for (const header of headers) {
      const field = fieldByHeader.get(header)
      if (!field) continue
      let value = raw[header]
      // 纯空白（空格/制表符）也视为空，避免空白行误报必填错误
      if (value !== undefined && String(value).trim() !== '') hasValue = true
      if (field === 'publish_date') value = normalizeDate(value)
      if (field === 'time_cycle') {
        sourceCycleRaw = value === undefined || value === null ? '' : String(value).trim()
        // 合并单元格之外的空周期：继承上方最近一条有效业务行的周期（不修改原始 Excel）
        if (!sourceCycleRaw && carriedCycle) {
          value = carriedCycle
          sourceCycleRaw = carriedCycle
        }
        value = normalizeTimeCycleValue(value, cycles)
        // 注意：这里的中间结果只用于「来源信息 / 无发布日期时的兜底」，
        // 是否进入 AI 识别面板在下面按「有没有可用的发布日期」决定
      }
      mapped[field] = value === undefined || value === '' ? undefined : value
    }

    if (!hasValue) {
      // 物理空白行是业务分组边界，不能把上组周期带到下一组。
      blankRowIndexes.push(rowIndex)
      carriedCycle = ''
      return
    }

    if (sourceCycleRaw) carriedCycle = sourceCycleRaw

    // ---------- 时间周期归属（发布日前优先，确定性计算）----------
    // canonicalCycle：发布日期所属标准周（唯一事实来源）
    const sourceWeekCode = mapped.time_cycle || '' // 标准化后的来源/继承周期（可能为空）
    const canonicalCycle = mapped.publish_date ? publishDateToWeekCode(mapped.publish_date) : null
    // 记录来源信息（仅解析过程使用，不写数据库）
    mapped.sourceTimeCycle = sourceWeekCode || undefined
    mapped.sourceTimeCycleRaw = sourceCycleRaw || undefined
    // 源业务周期一致性检查的结果（业务归属待确认，不修改发布日期）
    let sourceRangeError = null

    if (canonicalCycle) {
      // 发布日期存在且合法 → 最终周期一律由发布日期推导（与源分组是否相同无关，不做「不一致」警告）
      mapped.time_cycle = canonicalCycle
      // 数据质量检查：发布日期必须落在 Excel 原业务周期内（业务区间不要求周一起始 / 不要求 7 天）
      const sourceCheck = checkSourceTimeCycleRange(mapped)
      if (sourceCheck) {
        sourceRangeError = sourceCheck.reason
        mapped.sourceCycleConflictOrigin = true
        sourceRangeViolations.push({
          rowIndex,
          nickname: mapped.nickname,
          publishDate: mapped.publish_date,
          sourceTimeCycle: sourceCycleRaw,
          timeCycle: canonicalCycle,
          timeCycleLabel: weekCodeToLabel(canonicalCycle),
          range: sourceCheck.range
        })
      }
    } else {
      // 无可用发布日期：只能依赖来源周期；无法确定时进入人工 / AI 识别面板
      mapped.time_cycle = sourceWeekCode || undefined
      // 源周期存在但本地无法确定（非标准周码、也不是完整自然周）→ 收集原始值交人工 / AI 确认
      if (sourceCycleRaw && parseTimeCycleToWeekCode(sourceCycleRaw) === null) {
        unrecognizedCycles.add(sourceCycleRaw)
      }
      // 源周期与发布日期都拿不到 → 保留原样，由必填校验给出「时间周期不能为空」，不做猜测
    }

    // 逐行逐列判定：每个单元格按所属列规则清洗与校验
    const cellErrors = []
    for (const field of Object.keys(FIELD_RULES)) {
      const { value, error } = normalizeCellValue(field, mapped[field])
      mapped[field] = value
      if (error) cellErrors.push({ field, reason: error })
    }
    // 跨字段校验：累计播放量不得小于 7日播放量（V2 规则）
    const playRangeError = findPlayRangeError(mapped)
    if (playRangeError) cellErrors.push(playRangeError)
    if (cellErrors.length) {
      failedRows.push({
        rowIndex,
        cellErrors,
        reason: cellErrors.map((e) => e.reason).join('；')
      })
    } else if (sourceRangeError) {
      confirmationRows.push({ rowIndex, reason: SOURCE_CONFLICT_MESSAGE })
    } else {
      validRows.push(mapped)
    }
    mappedRows.push({ ...mapped, cellErrors })
  })

  return {
    fileName: file.name,
    headers,
    mappedFields,
    missingFields,
    // 字段识别结果（Batch 6A）：未识别字段必须显式暴露，不能静默丢弃
    recognizedHeaders,
    unknownHeaders,
    ignoredHeaders,
    systemIgnoredHeaders,
    headerMappings,
    headerSuggestions,
    headerSamples: Object.fromEntries(sampleMap),
    previewRows: mappedRows.slice(0, 5),
    allRows: mappedRows,
    validRows,
    failedRows,
    confirmationRows,
    blankRows: blankRowIndexes.length,
    blankRowIndexes,
    repeatedHeaderRows: headerRowIndexes.length,
    headerRowIndexes,
    sourceRangeViolations,
    sourceRangeViolationRows: sourceRangeViolations.length,
    unrecognizedTimeCycles: [...unrecognizedCycles]
  }
}

/**
 * AI 修正值兜底清洗（用户点「一键修正」时使用）：
 * 数值字段统一转为标准数字（兼容 1.2万 / 1,234 / ￥1000 / 1000元 等写法），
 * 时间周期统一转为标准周码；无法解析的字段直接丢弃，避免脏值入库
 * @param {Object} corrected AI 返回的 corrected 对象
 * @returns {Object} 可直接合并进导入行的清洗结果
 */
export function sanitizeCorrectedFields(corrected = {}) {
  const clean = {}
  if (!corrected || typeof corrected !== 'object') return clean

  for (const [key, value] of Object.entries(corrected)) {
    // 时间周期：AI 修正值必须能转成标准周码，否则丢弃（不写入脏值）
    if (key === 'time_cycle') {
      const code = parseTimeCycleToWeekCode(value)
      if (code) clean.time_cycle = code
      continue
    }

    const spec = FIELD_RULES[key]
    // 非本地校验字段（如 platform）原样保留，由后端忽略未知字段
    if (!spec) {
      if (value !== undefined && value !== null && String(value).trim() !== '') clean[key] = value
      continue
    }

    if (spec.type === 'number' || spec.type === 'int') {
      if (isEmptyNumberToken(value) || value === null) {
        clean[key] = spec.required ? 0 : null
        continue
      }
      const num = spec.type === 'int' ? parseIntCell(value) : parseNumber(value)
      if (num !== null && num >= 0) clean[key] = num
      continue
    }

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      clean[key] = value
    }
  }
  return clean
}

/**
 * 应用时间周期映射并重新校验：把识别结果（原始值 -> 标准周码）映射回全部导入数据，
 * 再走一遍本地单元格校验（幂等），供导入流程“确认应用”后继续原有校验流程
 * @param {Object} result parseRecordsExcel 的解析结果
 * @param {Object} mapping { [原始值]: '2026-W33' | null }，null 表示跳过该值对应行
 * @returns {Object} 新的解析结果
 */
export function applyTimeCycleMapping(result, mapping = {}) {
  const rows = Array.isArray(result?.allRows) ? result.allRows : []
  const mappedRows = []
  const validRows = []
  const failedRows = []
  const confirmationRows = []
  const sourceRangeViolations = []

  for (const row of rows) {
    const next = { rowIndex: row.rowIndex }
    for (const field of Object.keys(FIELD_RULES)) {
      next[field] = row[field]
    }
    // 保留解析期的来源信息（不属于入库字段）
    if (row.sourceTimeCycle) next.sourceTimeCycle = row.sourceTimeCycle
    if (row.sourceTimeCycleRaw) next.sourceTimeCycleRaw = row.sourceTimeCycleRaw
    if (row.manualCorrection) next.manualCorrection = true
    if (row.manualCorrectionFields) next.manualCorrectionFields = row.manualCorrectionFields
    if (row.aiSuggestionAdopted) next.aiSuggestionAdopted = true
    if (row.sourceCycleConflictOrigin) next.sourceCycleConflictOrigin = true
    if (row.sourceCycleConfirmed) next.sourceCycleConfirmed = true

    // 发布日期优先：有有效发布日期时，识别面板的结果不得覆盖标准周归属
    const canonicalCycle = next.publish_date ? publishDateToWeekCode(next.publish_date) : null
    let sourceRangeError = null
    if (canonicalCycle) {
      next.time_cycle = canonicalCycle
      const sourceCheck = checkSourceTimeCycleRange(next)
      if (sourceCheck) {
        sourceRangeError = sourceCheck.reason
        next.sourceCycleConflictOrigin = true
        sourceRangeViolations.push({
          rowIndex: next.rowIndex,
          nickname: next.nickname,
          publishDate: next.publish_date,
          sourceTimeCycle: next.sourceTimeCycleRaw || next.sourceTimeCycle,
          timeCycle: canonicalCycle,
          timeCycleLabel: weekCodeToLabel(canonicalCycle),
          range: sourceCheck.range
        })
      }
    } else if (
      // 无发布日期：应用识别结果（命中原始值则替换；null/空 表示跳过该值）
      typeof next.time_cycle === 'string' &&
      Object.prototype.hasOwnProperty.call(mapping, next.time_cycle)
    ) {
      next.time_cycle = mapping[next.time_cycle] || undefined
    }

    // 映射后重新做一遍本地校验（保证最终入库仍是标准 YYYY-Wxx）
    const cellErrors = []
    for (const field of Object.keys(FIELD_RULES)) {
      const { value, error } = normalizeCellValue(field, next[field])
      next[field] = value
      if (error) cellErrors.push({ field, reason: error })
    }
    // 跨字段校验：累计播放量不得小于 7日播放量（V2 规则）
    const playRangeError = findPlayRangeError(next)
    if (playRangeError) cellErrors.push(playRangeError)
    if (cellErrors.length) {
      failedRows.push({
        rowIndex: next.rowIndex,
        cellErrors,
        reason: cellErrors.map((e) => e.reason).join('；')
      })
    } else if (sourceRangeError && !next.sourceCycleConfirmed) {
      confirmationRows.push({ rowIndex: next.rowIndex, reason: SOURCE_CONFLICT_MESSAGE })
    } else {
      validRows.push(next)
    }
    mappedRows.push({ ...next, cellErrors })
  }

  return {
    ...result,
    validRows,
    failedRows,
    confirmationRows,
    previewRows: mappedRows.slice(0, 5),
    allRows: mappedRows,
    sourceRangeViolations,
    sourceRangeViolationRows: sourceRangeViolations.length,
    unrecognizedTimeCycles: []
  }
}

/** 确认源档期归属；只改变本次会话的状态，保持发布日期和 canonical 周不变。 */
export function confirmSourceTimeCycleConflict(result, rowIndex) {
  if (!result?.confirmationRows?.some((item) => item.rowIndex === rowIndex)) return result
  const original = result.allRows?.find((row) => row.rowIndex === rowIndex)
  if (!original || original.cellErrors?.length || !checkSourceTimeCycleRange(original)) return result
  const { cellErrors, ...confirmed } = original
  confirmed.sourceCycleConfirmed = true
  const allRows = result.allRows.map((row) =>
    row.rowIndex === rowIndex ? { ...row, sourceCycleConfirmed: true } : row
  )
  return {
    ...result,
    allRows,
    previewRows: allRows.slice(0, 5),
    validRows: [...result.validRows, confirmed].sort((a, b) => a.rowIndex - b.rowIndex),
    confirmationRows: result.confirmationRows.filter((item) => item.rowIndex !== rowIndex)
  }
}

/**
 * 只修正本次导入会话中的单条记录；复用时间周期映射后的整套本地重校验。
 * rowIndex 与原 Excel 保持一致，time_cycle 不接受人工输入。
 */
export function applyManualImportCorrection(result, rowIndex, changes = {}, cycles = [], options = {}) {
  const original = result?.allRows?.find((row) => row.rowIndex === rowIndex)
  if (!original || (!options.allowValidRow && !original.cellErrors?.length &&
      !result.confirmationRows?.some((row) => row.rowIndex === rowIndex))) return result

  const next = { ...original }
  const changedFields = new Set(original.manualCorrectionFields || [])
  for (const field of Object.keys(FIELD_RULES)) {
    if (field === 'time_cycle' ||
        (field === 'publish_date' && original.sourceCycleConflictOrigin) ||
        !Object.prototype.hasOwnProperty.call(changes, field)) continue
    const value = changes[field] ?? ''
    if (String(original[field] ?? '') !== String(value)) changedFields.add(field)
    next[field] = field === 'publish_date' ? normalizeDate(value) : value
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'sourceTimeCycleRaw')) {
    const source = String(changes.sourceTimeCycleRaw ?? '').trim()
    const sourceChanged = String(original.sourceTimeCycleRaw ?? '') !== source
    if (sourceChanged) changedFields.add('sourceTimeCycleRaw')
    next.sourceTimeCycleRaw = source || undefined
    next.sourceTimeCycle = source ? normalizeTimeCycleValue(source, cycles) : undefined
    // 无发布日期时仍按源周期兜底；有发布日期时由本地重校验重新计算自然周。
    next.time_cycle = next.sourceTimeCycle
    // 原档期的人工确认不能沿用到修改后的另一档期。
    if (sourceChanged) next.sourceCycleConfirmed = false
  }

  if (changedFields.size) {
    next.manualCorrection = true
    next.manualCorrectionFields = [...changedFields]
    if (options.aiSuggestionAdopted) next.aiSuggestionAdopted = true
  }

  const revalidated = applyTimeCycleMapping(
    { ...result, allRows: result.allRows.map((row) => (row.rowIndex === rowIndex ? next : row)) },
    {}
  )
  // 对源周期错误做人工修正时，不能清空或填入不可解析文本来绕过原区间校验。
  const hadSourceRangeError = original.sourceCycleConflictOrigin || original.cellErrors?.some((error) =>
    String(error.reason).includes(SOURCE_RANGE_ERROR)
  )
  if (!hadSourceRangeError && !changedFields.has('sourceTimeCycleRaw')) return revalidated
  const sourceText = String(next.sourceTimeCycleRaw || '').trim()
  if (sourceText && parseBusinessDateRange(sourceText, next.publish_date)) return revalidated

  const reason = sourceText
    ? '源时间周期无法识别，请填写有效的日期区间或标准周码。'
    : '源时间周期不能为空，不能清空后跳过源数据校验。'
  const currentFailure = revalidated.failedRows.find((item) => item.rowIndex === rowIndex)
  const cellErrors = [...(currentFailure?.cellErrors || []), { field: 'time_cycle', reason }]
  const failedRow = { rowIndex, cellErrors, reason: cellErrors.map((item) => item.reason).join('；') }
  const allRows = revalidated.allRows.map((row) =>
    row.rowIndex === rowIndex ? { ...row, cellErrors } : row
  )
  return {
    ...revalidated,
    allRows,
    previewRows: allRows.slice(0, 5),
    validRows: revalidated.validRows.filter((row) => row.rowIndex !== rowIndex),
    failedRows: [
      ...revalidated.failedRows.filter((item) => item.rowIndex !== rowIndex),
      failedRow
    ].sort((a, b) => a.rowIndex - b.rowIndex)
  }
}

// ---------- 导出 ----------
// V2 单条播放口径（与 Records 页面 / 导入校验保持一致）：
// latest 未填写 或 异常（latest < first）→ null；0 是有效真实值
function recordLatestPlay(row = {}) {
  const latestRaw = row?.second_week_play
  if (latestRaw === undefined || latestRaw === null || latestRaw === '') return null
  const latest = Number(latestRaw)
  if (!Number.isFinite(latest)) return null
  const firstRaw = row?.first_play
  if (firstRaw !== undefined && firstRaw !== null && firstRaw !== '') {
    const first = Number(firstRaw)
    if (Number.isFinite(first) && latest < first) return null
  }
  return latest
}

// 后续新增播放量 = 累计播放量 − 7日播放量（仅两者都有值且 latest >= first 时有值）
function recordPost7dGrowth(row = {}) {
  const latest = recordLatestPlay(row)
  const firstRaw = row?.first_play
  if (latest === null || firstRaw === undefined || firstRaw === null || firstRaw === '') return null
  const first = Number(firstRaw)
  if (!Number.isFinite(first)) return null
  return latest - first
}

// 空值（null / undefined / ''）导出为空单元格；0 必须是数字 0
function toOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return ''
  const num = Number(value)
  return Number.isFinite(num) ? num : ''
}

const EXPORT_COLUMNS = [
  ['时间周期', 'time_cycle'],
  ['达人昵称', 'nickname'],
  ['达人类型', 'creator_type'],
  ['达人主页', 'homepage'],
  ['植入链接', 'content_link'],
  ['视频链接', 'video_link'],
  ['总花费(元)', 'total_cost'],
  ['CPM', 'cpm'],
  ['7日播放量', 'first_play'],
  ['累计播放量', 'second_week_play'],
  // 计算列（导入时可忽略）
  ['后续新增播放量', 'post7dGrowth'],
  ['发布日期', 'publish_date']
]

// 展示宽度：中文等宽字符按 2 计
function displayWidth(text) {
  let width = 0
  for (const ch of String(text ?? '')) {
    width += ch.charCodeAt(0) > 255 ? 2 : 1
  }
  return width
}

// 列宽自适应（按内容最长值 + 留白）
function applyColumnWidths(worksheet, rows) {
  if (!rows.length) return
  const headers = Object.keys(rows[0])
  worksheet['!cols'] = headers.map((header) => {
    let maxLen = displayWidth(header)
    for (const row of rows) {
      maxLen = Math.max(maxLen, displayWidth(row[header]))
    }
    return { wch: Math.min(maxLen + 2, 60) }
  })
}

/**
 * 导出投放记录为 Excel（含表格全部显示列 + CPM数据）
 * @param {Array<Object>} rows 后端字段对象数组
 * @param {string} fileName 文件名
 */
export function exportRecordsToExcel(rows, fileName) {
  const data = rows.map((row) => {
    // V2：CPM 使用最新累计口径；latest 未更新 / 异常 / ≤0 → 空
    const latest = recordLatestPlay(row)
    const cpm = latest === null ? null : calcCpm(row.total_cost, latest)
    const growth = recordPost7dGrowth(row)
    const item = {}
    for (const [zhHeader, field] of EXPORT_COLUMNS) {
      let value = row[field]
      if (field === 'time_cycle') {
        // 导出：时间周期显示为月日区间（08/13-08/19）
        value = weekCodeToLabel(value)
      } else if (field === 'total_cost') {
        value = value === undefined || value === null || value === '' ? '' : Number(value).toFixed(2)
      } else if (field === 'cpm') {
        // 计算列：无有效累计播放时导出为空（不是 0，也不是 -）
        value = cpm === null ? '' : Number(cpm.toFixed(2))
      } else if (field === 'post7dGrowth') {
        value = growth === null ? '' : growth
      } else if (field === 'first_play' || field === 'second_week_play') {
        // 0 必须导出为数字 0；空值导出空单元格
        value = toOptionalNumber(value)
      }
      item[zhHeader] = value === undefined || value === null ? '' : value
    }
    return item
  })

  const worksheet = XLSX.utils.json_to_sheet(data)
  applyColumnWidths(worksheet, data)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, '投放记录')
  XLSX.writeFile(workbook, fileName)
}

/**
 * 生成导出文件名：达人投放记录_YYYY-MM-DD.xlsx
 */
export function buildExportFileName() {
  return `达人投放记录_${dayjs().format('YYYY-MM-DD')}.xlsx`
}

// ---------- 达人汇总 / 达人对比 导出 ----------

/**
 * 生成达人汇总导出文件名：达人汇总明细_YYYY-MM-DD.xlsx
 */
export function buildCreatorSummaryFileName() {
  return `达人汇总明细_${dayjs().format('YYYY-MM-DD')}.xlsx`
}

/**
 * 生成达人对比导出文件名：达人对比_YYYY-MM-DD.xlsx
 */
export function buildCreatorCompareFileName() {
  return `达人对比_${dayjs().format('YYYY-MM-DD')}.xlsx`
}

/**
 * 导出达人维度统计（达人汇总明细 / 达人对比共用）
 * 列：博主类型、达人昵称、投放次数、总花费(元)、总播放、平均CPM、爆款数、平均单条播放、复投次数
 * @param {Array<Object>} creators 达人统计数组
 * @param {{ fileName?: string, sheetName?: string }} [options]
 * @returns {number} 导出行数
 */
export function exportCreatorStatsToExcel(creators = [], options = {}) {
  const list = Array.isArray(creators) ? creators : []
  const fileName = options.fileName || buildCreatorSummaryFileName()
  const sheetName = options.sheetName || '达人汇总'
  // V2 术语与列顺序：核心指标在前，7日辅助指标在后
  // 数值全部直接取后端聚合字段，导出层不做任何重算
  const CREATOR_EXPORT_HEADERS = [
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
    value === null || value === undefined ? '' : Number((Number(value) || 0).toFixed(2))
  const rateCell = (value) => (value === null || value === undefined ? '' : `${value}%`)
  const data = list.map((item) => ({
    // Phase 5：显示名取 Creator 权威名（identity 模式）；nickname 仅为兼容别名
    达人昵称: item.canonical_name || item.nickname || '未命名达人',
    达人类型: item.creator_type || '未分类',
    投放次数: Number(item.total_campaigns) || 0,
    总花费: (Number(item.total_cost) || 0).toFixed(2),
    // 累计播放量 = Σ有效最新累计播放（后端字段优先，兼容旧字段名 total_play）
    累计播放量: Number(item.latest_play_total ?? item.total_play ?? 0),
    平均播放量: toOptionalNumber(item.avg_play),
    平均CPM: cpmCell(item.avg_cpm),
    爆款数: Number(item.hit_latest_count ?? item.hit_count ?? 0),
    爆款率: rateCell(item.hit_rate_latest),
    复投次数: Number(item.repeat_count) || 0,
    // 达人级字段名为 first_play_sum（summary 层才叫 first_play_total），两者都兼容
    '7日播放量': Number(item.first_play_sum ?? item.first_play_total ?? 0),
    后续新增播放量: Number(item.post_7d_growth_total ?? 0),
    '7日CPM': cpmCell(item.cpm_7d),
    '7日爆款数': Number(item.hit_7d_count ?? 0),
    '7日爆款率': rateCell(item.hit_rate_7d)
  }))
  const sheetRows = data.length
    ? data
    : [
        Object.fromEntries(
          CREATOR_EXPORT_HEADERS.map((key, index) => [
            key,
            index === CREATOR_EXPORT_HEADERS.length - 1 ? '暂无数据' : ''
          ])
        )
      ]

  const worksheet = XLSX.utils.json_to_sheet(sheetRows, { header: CREATOR_EXPORT_HEADERS })
  applyColumnWidths(worksheet, sheetRows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)
  XLSX.writeFile(workbook, fileName)
  return data.length
}

// ---------- 导入失败明细导出 ----------
// 明细列：行号 / 错误字段 / 原始值 / 错误原因 / AI识别备注
const FAILED_DETAIL_COLUMNS = ['行号', '错误字段', '原始值', '错误原因', 'AI识别备注']

/**
 * 生成失败明细文件名：导入失败明细_YYYY-MM-DD.xlsx
 */
export function buildFailedRowsFileName() {
  return `导入失败明细_${dayjs().format('YYYY-MM-DD')}.xlsx`
}

/**
 * 失败行 -> 明细数据行（一个单元格错误一行，便于逐条排查）
 * @param {Array<Object>} failedRows 解析结果中的失败行（含 cellErrors / reason）
 * @param {Array<Object>} rows 全部解析行（用于回填「原始值」，可选）
 * @param {Object} [options] 附加信息
 * @param {Object} [options.aiNotes] AI 识别备注：{ [rowIndex]: string } 或 { [原始值]: string }
 * @returns {Array<Object>} 明细数据（列：行号、错误字段、原始值、错误原因、AI识别备注）
 */
export function buildFailedDetailRows(failedRows = [], rows = [], options = {}) {
  const rowMap = new Map(
    (Array.isArray(rows) ? rows : []).map((row) => [row.rowIndex, row])
  )
  const aiNotes = options.aiNotes && typeof options.aiNotes === 'object' ? options.aiNotes : {}
  const detailRows = []

  for (const item of Array.isArray(failedRows) ? failedRows : []) {
    const row = rowMap.get(item.rowIndex)
    const errors =
      Array.isArray(item.cellErrors) && item.cellErrors.length > 0
        ? item.cellErrors
        : [{ field: '', reason: item.reason || '无效数据' }]

    for (const error of errors) {
      const field = error.field || ''
      const raw = row && field ? row[field] : undefined
      // AI 识别备注：优先按行号取，其次按原始单元格内容取
      const rawText =
        raw === undefined || raw === null || String(raw).trim() === '' ? '' : String(raw)
      const aiNote = aiNotes[item.rowIndex] || (rawText ? aiNotes[rawText] : '') || ''
      detailRows.push({
        行号: item.rowIndex,
        错误字段: FIELD_LABELS[field] || field || '-',
        原始值: rawText === '' ? '（空）' : rawText,
        错误原因: error.reason || item.reason || '无效数据',
        AI识别备注: aiNote
      })
    }
  }
  return detailRows
}

/**
 * 导出导入失败明细为 Excel（行号 / 错误字段 / 原始值 / 错误原因）
 * @param {Array<Object>} failedRows 失败行（含 cellErrors / reason），或已整理好的明细行
 * @param {string} [fileName] 文件名，默认「导入失败明细_YYYY-MM-DD.xlsx」
 * @param {Array<Object>} [rows] 全部解析行，用于回填原始值（失败行已是明细时可不传）
 * @param {Object} [options] 附加信息（aiNotes：AI 识别备注，按行号或原始值索引）
 */
export function exportFailedRowsToExcel(
  failedRows = [],
  fileName = buildFailedRowsFileName(),
  rows = [],
  options = {}
) {
  const source = Array.isArray(failedRows) ? failedRows : []
  const isDetail = source.every(
    (item) => item && Object.prototype.hasOwnProperty.call(item, '错误原因')
  )
  const data = isDetail ? source : buildFailedDetailRows(source, rows, options)
  const sheetRows = data.length
    ? data
    : [{ 行号: '', 错误字段: '', 原始值: '', 错误原因: '无失败数据', AI识别备注: '' }]

  const worksheet = XLSX.utils.json_to_sheet(sheetRows, { header: FAILED_DETAIL_COLUMNS })
  applyColumnWidths(worksheet, sheetRows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, '失败明细')
  XLSX.writeFile(workbook, fileName)
  return data.length
}
