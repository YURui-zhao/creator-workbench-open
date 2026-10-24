/**
 * 截图文字 -> 数值 的确定性解析（前端镜像，V3-alpha P2A）
 *
 * 权威实现：backend/utils/screenshotValues.js（规则完全一致，由 tests/screenshot_extract.test.js
 * 的 parity 用例守护）。前端保留同一份纯函数，是为了让用户在确认页手动修改 raw_text 时
 * 能立即用同一套确定性规则重新换算，而不是重新请求 AI。
 *
 * 原则：解析失败不猜 —— value = null + needs_review = true，并保留 raw_text 供人工确认。
 */

const UNIT_MULTIPLIERS = {
  亿: 1e8,
  万: 1e4,
  w: 1e4,
  W: 1e4,
  k: 1e3,
  K: 1e3
}

const FULL_WIDTH_MAP = {
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  '．': '.', '，': ',', '：': ':', 'Ｋ': 'K', 'Ｗ': 'W'
}

function toSearchableText(raw) {
  const text = String(raw ?? '')
  return text
    .replace(/[０-９．，：ＫＷ]/g, (char) => FULL_WIDTH_MAP[char] || char)
    .replace(/[\s\u00a0]/g, '')
}

export function normalizeRawText(raw) {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim()
  return text === '' ? null : text
}

function unresolved(rawText, reason) {
  return { raw_text: rawText, value: null, needs_review: true, reason }
}

/** 播放量文本 -> 整数播放量：5.2万 -> 52000、8600 -> 8600、1.3w -> 13000、12K -> 12000 */
export function parsePlayText(raw) {
  const rawText = normalizeRawText(raw)
  if (rawText === null) return unresolved(null, 'AI 未识别到播放量内容')

  const text = toSearchableText(rawText).replace(/,/g, '')
  const match = /^([0-9]+(?:\.[0-9]+)?)(亿|万|w|W|k|K)?$/.exec(text)
  if (!match) {
    return unresolved(rawText, '无法确定性解析该播放量写法，请人工确认')
  }
  const base = Number(match[1])
  const unit = match[2]
  const multiplier = unit ? UNIT_MULTIPLIERS[unit] : 1
  const value = base * multiplier
  if (!Number.isFinite(value) || value < 0) {
    return unresolved(rawText, '播放量数值不合法，请人工确认')
  }
  return { raw_text: rawText, value: Math.round(value), needs_review: false, reason: null }
}

/** 星图刊例价文本 -> 金额：¥3,000 -> 3000、3000元 -> 3000、1.5万 -> 15000 */
export function parsePriceText(raw) {
  const rawText = normalizeRawText(raw)
  if (rawText === null) return unresolved(null, 'AI 未识别到星图刊例价内容')

  const text = toSearchableText(rawText).replace(/,/g, '')
  const match = /^(?:[¥￥])?([0-9]+(?:\.[0-9]+)?)(亿|万)?(?:元)?$/.exec(text)
  if (!match) {
    return unresolved(rawText, '无法确定性解析该价格写法，请人工确认')
  }
  const base = Number(match[1])
  const unit = match[2]
  const multiplier = unit ? UNIT_MULTIPLIERS[unit] : 1
  const value = base * multiplier
  if (!Number.isFinite(value) || value < 0) {
    return unresolved(rawText, '价格数值不合法，请人工确认')
  }
  return { raw_text: rawText, value: Math.round(value * 100) / 100, needs_review: false, reason: null }
}
