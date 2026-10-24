/**
 * 近期表现助手 · 识别结果草稿（V3-alpha P2A，纯函数）
 *
 * 职责：
 * - 把 AI 返回的「可见事实」转成可人工编辑的草稿（数值一律由确定性解析器换算）
 * - 人工修改 raw_text 时用同一套解析规则即时重算（不重新请求 AI）
 * - 排除 / 恢复条目的状态与统计
 * - P2A 只产出前端 confirmed draft：不写库、不估价、不给复投建议
 */

import { parsePlayText, parsePriceText, normalizeRawText } from './screenshotValues.js'
import { CONTENT_TYPES, normalizeContentType } from './contentType.js'

export const MAX_DRAFT_PLAYS = 60

const toRawText = normalizeRawText

/**
 * AI 识别结果 -> 草稿
 * 只保留 AI 真正返回的条目：不补足 15 条、不猜日期、不跨图去重
 */
export function buildDraftFromExtraction(data = {}) {
  const rawPlays = Array.isArray(data?.plays) ? data.plays.slice(0, MAX_DRAFT_PLAYS) : []
  const plays = rawPlays.map((item, index) => {
    const rawText = toRawText(item?.raw_text)
    const parsed = parsePlayText(rawText)
    return {
      id: `play-${index + 1}`,
      raw_text: parsed.raw_text,
      normalized_play: parsed.value,
      needs_review: parsed.needs_review,
      reason: parsed.reason,
      excluded: false,
      // Alpha.3-04：AI 只按可见颜色标识给出商单 / 日常，无法确认即 unknown
      content_type: normalizeContentType(item?.content_type),
      source_image_index: Number.isInteger(item?.source_image_index) ? item.source_image_index : null,
      position_index: Number.isInteger(item?.position_index) ? item.position_index : index + 1
    }
  })

  const priceRaw = toRawText(data?.xingtu_price_raw)
  const price = parsePriceText(priceRaw)

  return {
    provider: data?.provider || null,
    model: data?.model || null,
    creator_name: toRawText(data?.creator_name_raw) || '',
    xingtu_price_raw: price.raw_text || '',
    xingtu_price: price.value,
    xingtu_price_needs_review: price.needs_review,
    xingtu_price_reason: price.reason,
    plays,
    warnings: (Array.isArray(data?.warnings) ? data.warnings : []).filter(
      (item) => typeof item === 'string' && item.trim()
    )
  }
}

export function updateCreatorName(draft, value) {
  return { ...draft, creator_name: String(value ?? '') }
}

/**
 * 手工录入（Alpha.2 Sprint A3）：把用户粘贴/输入的多行文本拆成播放量原文列表。
 * 支持换行、中文逗号、英文逗号、分号、制表符分隔；不排序、不去重、不猜日期。
 * 顺序 = 用户输入顺序（Phase audit 冻结契约：从旧到新，时间向下推进；最新一条在最后）。
 */
export function splitManualPlayLines(text) {
  return String(text ?? '')
    .split(/[\n\r,，;；\t]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * 手工录入 → 与 AI 识别完全相同的草稿结构（不新增第二套解析逻辑）。
 * - 每条复用 parsePlayText（确定性解析，无法解析的保留 raw_text + needs_review）
 * - position_index 按用户输入顺序生成（从旧到新），不按数值大小排序
 * - 手工模式没有 AI 识别昵称：creator_name 置空（身份核对为 unknown，不阻塞）
 * - 星图价仍可选：可在确认区填写，缺省为 null（合法）
 */
export function buildDraftFromManualPlays(rawLines = [], { priceRaw = '' } = {}) {
  const lines = (Array.isArray(rawLines) ? rawLines : splitManualPlayLines(rawLines))
    .map((item) => toRawText(item))
    .filter((item) => item !== null && item !== '')
    .slice(0, MAX_DRAFT_PLAYS)

  const plays = lines.map((rawText, index) => {
    const parsed = parsePlayText(rawText)
    return {
      id: `play-${index + 1}`,
      raw_text: parsed.raw_text,
      normalized_play: parsed.value,
      needs_review: parsed.needs_review,
      reason: parsed.reason,
      excluded: false,
      // 手工录入没有 AI 颜色判断：默认未识别，由用户在逐条列表里选择
      content_type: CONTENT_TYPES.unknown,
      source_image_index: null,
      position_index: index + 1
    }
  })

  const price = parsePriceText(toRawText(priceRaw))

  return {
    provider: null,
    model: null,
    creator_name: '',
    xingtu_price_raw: price.raw_text || '',
    xingtu_price: price.value,
    xingtu_price_needs_review: price.needs_review,
    xingtu_price_reason: price.reason,
    plays,
    warnings: []
  }
}

/**
 * Alpha.3-04B「补充分类」：把已保存的 latest snapshot 还原成草稿
 *
 * 关键约束（系统已经知道的事实，不要求用户重新输入）：
 *   · 播放量原文 / 归一化值 / 排除标记 / needs_review / 顺序 全部原样继承
 *   · observed_at、星图价原文 一并继承（补分类不是一次新的观察）
 *   · 第一版只允许用户修改 content_type（商单 / 日常 / 未识别）
 * 数据来源：GET /api/recent-snapshots/latest 返回的 public snapshot（无需新增 API）
 */
export function buildDraftFromSnapshot(snapshot) {
  const rawPlays = Array.isArray(snapshot?.plays) ? snapshot.plays.slice(0, MAX_DRAFT_PLAYS) : []
  const plays = rawPlays.map((item, index) => {
    const value = item?.normalized_play
    return {
      id: `play-${index + 1}`,
      raw_text: toRawText(item?.raw_text) ?? '',
      normalized_play: Number.isFinite(Number(value)) && value !== null ? Number(value) : null,
      needs_review: item?.needs_review === true,
      reason: null,
      excluded: item?.excluded === true,
      content_type: normalizeContentType(item?.content_type),
      source_image_index: Number.isInteger(item?.source_image_index) ? item.source_image_index : null,
      position_index: Number.isInteger(item?.position_index) ? item.position_index : index + 1
    }
  })
  const priceRaw = toRawText(snapshot?.xingtu_price_raw) || ''
  const price = parsePriceText(priceRaw)
  return {
    mode: 'classify_existing',
    source_snapshot_id: snapshot?.id ?? null,
    // 观察日期继承旧快照（绝不改成今天）
    observed_at: snapshot?.observed_at ?? null,
    provider: null,
    model: null,
    creator_name: toRawText(snapshot?.recognized_creator_name_raw) || '',
    xingtu_price_raw: priceRaw,
    xingtu_price: snapshot?.xingtu_price ?? price.value,
    xingtu_price_needs_review: price.needs_review,
    xingtu_price_reason: price.reason,
    plays,
    warnings: []
  }
}

/** 人工修改星图刊例价原文 -> 立即按确定性规则重新换算 */
export function updatePriceRawText(draft, rawText) {
  const text = String(rawText ?? '')
  const parsed = parsePriceText(text)
  return {
    ...draft,
    xingtu_price_raw: text,
    xingtu_price: parsed.value,
    xingtu_price_needs_review: parsed.needs_review,
    xingtu_price_reason: parsed.reason
  }
}

/** 人工修改某条播放量原文 -> 只重算该条 */
export function updatePlayRawText(draft, playId, rawText) {
  const text = String(rawText ?? '')
  return {
    ...draft,
    plays: draft.plays.map((play) => {
      if (play.id !== playId) return play
      const parsed = parsePlayText(text)
      return {
        ...play,
        raw_text: text,
        normalized_play: parsed.value,
        needs_review: parsed.needs_review,
        reason: parsed.reason
      }
    })
  }
}

/** 排除 / 恢复某条（不需要用户填写理由） */
export function togglePlayExcluded(draft, playId) {
  return {
    ...draft,
    plays: draft.plays.map((play) =>
      play.id === playId ? { ...play, excluded: !play.excluded } : play
    )
  }
}

/**
 * Alpha.3-04：人工修改单条内容类型（商单 / 日常 / 未识别）
 * 只改这一条的 content_type：不重新识别、不重新请求 AI、不影响播放量与其他条目。
 * 非法值一律归一为 unknown。
 */
export function updatePlayContentType(draft, playId, contentType) {
  const normalized = normalizeContentType(contentType)
  return {
    ...draft,
    plays: draft.plays.map((play) =>
      play.id === playId ? { ...play, content_type: normalized } : play
    )
  }
}

export function setPlayExcluded(draft, playId, excluded) {
  return {
    ...draft,
    plays: draft.plays.map((play) => (play.id === playId ? { ...play, excluded: Boolean(excluded) } : play))
  }
}

/** 汇总：识别作品 / 有效作品 / 排除 / 星图价 */
export function summarizeDraft(draft) {
  const plays = Array.isArray(draft?.plays) ? draft.plays : []
  const excludedCount = plays.filter((play) => play.excluded).length
  // 与后端「有效样本」定义保持一致：未排除 且 可确定性解析（normalized_play !== null）
  const unresolvedCount = plays.filter(
    (play) => !play.excluded && (play.normalized_play === null || play.normalized_play === undefined)
  ).length
  // Alpha.3-04：内容类型计数（仅按有效样本计数，供保存前确认，与后端统计口径一致）
  const validPlays = plays.filter(
    (play) => !play.excluded && Number.isFinite(play.normalized_play) && play.normalized_play >= 0
  )
  const contentCounts = { sponsored: 0, organic: 0, unknown: 0 }
  for (const play of validPlays) {
    contentCounts[normalizeContentType(play.content_type)] += 1
  }
  return {
    identified_count: plays.length,
    excluded_count: excludedCount,
    unresolved_count: unresolvedCount,
    valid_count: plays.length - excludedCount - unresolvedCount,
    needs_review_count: plays.filter((play) => play.needs_review && !play.excluded).length,
    xingtu_price: draft?.xingtu_price ?? null,
    content_type_counts: contentCounts
  }
}

/**
 * 确认后的草稿（P2A 终点）：只在前端存在，不写数据库
 * 保留 raw_text / 归一化值 / 排除标记 / 图片来源顺序，供后续 Phase 使用
 */
export function buildConfirmedDraft(draft) {
  return {
    creator_name: String(draft?.creator_name ?? '').trim(),
    xingtu_price: draft?.xingtu_price ?? null,
    xingtu_price_raw: draft?.xingtu_price_raw ?? '',
    provider: draft?.provider || null,
    model: draft?.model || null,
    plays: (draft?.plays || []).map((play) => ({
      raw_text: play.raw_text,
      normalized_play: play.normalized_play,
      excluded: Boolean(play.excluded),
      needs_review: Boolean(play.needs_review),
      source_image_index: play.source_image_index,
      position_index: play.position_index
    })),
    summary: summarizeDraft(draft)
  }
}
