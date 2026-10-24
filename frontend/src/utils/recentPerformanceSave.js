/**
 * 近期表现快照 · 保存流程纯函数（V3-alpha P2B）
 *
 * 职责：
 * - 达人身份保护：只有识别昵称与当前雷达达人一致时才不要求额外确认
 * - 组装保存 payload：只发送 raw 事实（不含任何前端算出的统计值），统计一律由后端重算
 * - 展示文案：趋势中文标签、典型区间、雷达行内状态
 *
 * 注意：统计口径（去极值 / quantile / ±20% 阈值）全部在后端
 * （backend/utils/recentPerformanceStats.js），前端不重复实现。
 */

import { normalizeRawText } from './screenshotValues.js'
import { formatPlays } from './format.js'
import { normalizeContentType } from './contentType.js'

// 与后端 trend_label 一一对应（仅展示用）
export const TREND_LABELS = {
  up: '上升',
  stable: '稳定',
  down: '下降',
  insufficient: '样本不足'
}

export const TREND_LABELS_FULL = {
  up: '上升',
  stable: '基本稳定',
  down: '下降',
  insufficient: '样本不足'
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 本地年月日 → YYYY-MM-DD。
 * 刻意不使用 new Date().toISOString().slice(0, 10)：toISOString 走 UTC，
 * 在东八区凌晨会得到「昨天」，导致数据观察日期凭空少一天。
 */
export function todayLocalDateOnly(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 严格校验 YYYY-MM-DD（含真实日历校验，2026-02-30 一类不算有效） */
export function isValidDateOnly(value) {
  const text = String(value ?? '').trim()
  if (!DATE_ONLY_RE.test(text)) return false
  const [year, month, day] = text.split('-').map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day))
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  )
}

/** 名称比较用的轻量归一化（与后端 normalizeCreatorNameForCompare 一致） */
export function normalizeCreatorNameForCompare(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, '')
}

/** 识别昵称与目标达人是否一致（不做 fuzzy / AI 身份匹配） */
export function isCreatorNameMatched(creator, recognizedNameRaw) {
  const recognized = String(recognizedNameRaw ?? '').trim()
  if (!recognized) return true
  return normalizeCreatorNameForCompare(creator) === normalizeCreatorNameForCompare(recognized)
}

/** 是否需要「我确认本次快照保存到当前达人」二次确认 */
export function needsIdentityConfirmation(creator, recognizedNameRaw) {
  // 尚未选择目标达人时不提示「不一致」——此时由「必须选择达人」这条规则负责拦截
  if (!String(creator ?? '').trim()) return false
  return !isCreatorNameMatched(creator, recognizedNameRaw)
}

/**
 * 组装保存 payload：只包含人工确认后的 raw 事实
 * 明确不发送 normalized_play / median / p25 / p75 等派生值（后端会重新解析与计算）
 */
export function buildSnapshotPayload(
  draft,
  { creator, identityConfirmed = false, observedAt = '' } = {}
) {
  return {
    creator: String(creator ?? '').trim(),
    // Alpha.2：数据观察日期由用户明确确认（不是 AI 推断，也不从截图猜）
    observed_at: String(observedAt ?? '').trim(),
    recognized_creator_name_raw: normalizeRawText(draft?.creator_name),
    identity_confirmed: Boolean(identityConfirmed),
    xingtu_price_raw: normalizeRawText(draft?.xingtu_price_raw),
    plays: (draft?.plays || []).map((play) => ({
      raw_text: normalizeRawText(play.raw_text),
      excluded: Boolean(play.excluded),
      // Alpha.3-04：内容类型随条目提交（后端仍会重新归一化，非法值一律 unknown）
      content_type: normalizeContentType(play.content_type),
      source_image_index: Number.isInteger(play.source_image_index) ? play.source_image_index : null,
      position_index: Number.isInteger(play.position_index) ? play.position_index : null
    }))
  }
}

/** 趋势比例展示（+18.5% / -22.0%）；无比例时返回空字符串 */
export function formatTrendRatio(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return ''
  const percent = Number(ratio) * 100
  const sign = percent > 0 ? '+' : ''
  return `${sign}${percent.toFixed(1)}%`
}

/** 典型区间文案：4.3万～6.1万 */
export function formatPlayRange(p25, p75) {
  if (p25 === null || p25 === undefined || p75 === null || p75 === undefined) return ''
  return `${formatPlays(p25)}～${formatPlays(p75)}`
}

/**
 * 雷达行内「近期表现」状态文案（不显示假数据）
 * 无快照 → 尚未更新；样本不足 → 样本不足；否则 → 中位 X · 趋势
 */
export function formatSnapshotStatusText(snapshot) {
  if (!snapshot) return '尚未更新'
  if (
    snapshot.stats_status !== 'ok' ||
    snapshot.median_play === null ||
    snapshot.median_play === undefined
  ) {
    return '样本不足'
  }
  const trend = TREND_LABELS[snapshot.trend_label] || ''
  return `${formatPlays(snapshot.median_play)}${trend ? ` · ${trend}` : ''}`
}

/**
 * 雷达主表行内「数据观察日期」提示（Alpha.2 Sprint A1）
 * - 有快照且有 observed_at → 数据截至 MM-DD
 * - 有快照但 observed_at 为空/不可解析 → 观察日期未知（旧 Alpha.1 快照；绝不用 created_at 冒充）
 * - 没有快照 → 空字符串（保持「尚未更新」，不追加观察日期）
 * observed_at 是 date-only 字符串，直接按字符串取月日，不使用 Date / toISOString（避免时区 ±1 天）。
 */
export function formatObservedAtHint(snapshot) {
  if (!snapshot) return ''
  const observed = String(snapshot.observed_at ?? '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(observed)
  if (!match) return '观察日期未知'
  return `数据截至 ${match[2]}-${match[3]}`
}

/**
 * 达人身份核对三态（Alpha.2 Sprint A2）
 * snapshot owner 永远来自雷达传入的 currentCreator；AI 识别昵称只用于「有没有传错截图」。
 * - matched  ：识别昵称与当前达人一致 → 不需确认，不阻塞
 * - unknown  ：AI 未识别到昵称（或尚未确定当前达人）→ 不是 mismatch，不需确认，不阻塞
 * - mismatch ：识别到不同昵称 → 真正的身份风险，必须由用户显式确认
 */
export const IDENTITY_STATUS = {
  matched: 'matched',
  unknown: 'unknown',
  mismatch: 'mismatch'
}

export function getIdentityCheckState({ currentCreator, recognizedCreatorName } = {}) {
  const current = String(currentCreator ?? '').trim()
  const recognized = String(recognizedCreatorName ?? '').trim()
  if (!recognized || !current) {
    return { status: IDENTITY_STATUS.unknown, requiresConfirmation: false, recognizedName: recognized }
  }
  if (isCreatorNameMatched(current, recognized)) {
    return { status: IDENTITY_STATUS.matched, requiresConfirmation: false, recognizedName: recognized }
  }
  return { status: IDENTITY_STATUS.mismatch, requiresConfirmation: true, recognizedName: recognized }
}

/** 星图刊例价字段状态（只保留一个状态文案，避免同一含义出现两次） */
export const PRICE_FIELD_STATUS = {
  identified: 'identified', // AI 识别成功且未被人工改动
  confirmed: 'confirmed', // 用户手工修改过
  missing: 'missing', // 未识别 / 未填写
  invalid: 'invalid' // 有原文但确定性解析不了
}

export const PRICE_FIELD_STATUS_LABELS = {
  identified: '已识别',
  confirmed: '已确认',
  missing: '暂无', // A3：星图刊例价是可选事实，缺失是合法状态，不是「待补充的错误」
  invalid: '请检查'
}

export function getPriceFieldStatus({ rawText, price, needsReview = false, manuallyEdited = false } = {}) {
  const text = String(rawText ?? '').trim()
  if (!text) return PRICE_FIELD_STATUS.missing
  if (needsReview || price === null || price === undefined) return PRICE_FIELD_STATUS.invalid
  return manuallyEdited ? PRICE_FIELD_STATUS.confirmed : PRICE_FIELD_STATUS.identified
}

/**
 * 「需要确认 X 项」计数（Alpha.2 Sprint A3）：
 * 只统计真正需要用户处理的事项 —— 无法解析的播放量条目（每条 1 项）、
 * 以及 AI 识别昵称与当前达人不一致（1 项）。
 * 星图刊例价是可选事实字段，缺失不再计入（A2 曾计入，A3 起取消）。
 * 解释性说明（均值线、参考线、日期轴、昵称未识别等）不计入。
 */
export function countRequiredConfirmations({
  unresolvedCount = 0,
  identityStatus = IDENTITY_STATUS.matched
} = {}) {
  let count = 0
  const unresolved = Number(unresolvedCount)
  if (Number.isFinite(unresolved) && unresolved > 0) count += Math.floor(unresolved)
  if (identityStatus === IDENTITY_STATUS.mismatch) count += 1
  return count
}

/**
 * 保存闸门（纯函数，便于测试）：只有「已确认 + 已绑定达人 + 需要时已完成名称确认 +
 * 没有正在保存 + 当前草稿尚未保存过」时才允许提交。
 * 已保存过的同一份草稿会被锁定，避免重复点击产生重复快照；
 * 用户修改草稿后（会重置 confirmed / savedSnapshot）可再次确认并保存。
 */
export function canSaveSnapshot({
  confirmed = false,
  creator = '',
  identityNeedsConfirm = false,
  identityConfirmed = false,
  saving = false,
  savedSnapshot = null
} = {}) {
  if (!confirmed) return false
  if (!String(creator ?? '').trim()) return false
  if (identityNeedsConfirm && !identityConfirmed) return false
  if (saving) return false
  if (savedSnapshot) return false
  return true
}
