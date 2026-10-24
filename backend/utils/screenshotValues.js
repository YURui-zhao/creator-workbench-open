/**
 * 截图文字 -> 数值 的确定性解析（后端权威实现，V3-alpha P2A）
 *
 * 原则：
 * - AI 只负责「看见什么」（raw_text）；数字换算一律由本模块完成，绝不用 LLM 的换算结果
 * - 解析失败不猜：value = null + needs_review = true，并保留 raw_text 供人工确认
 * - 支持单位：亿 / 万 / w / W / k / K（价格额外支持 ¥ 前缀与「元」后缀）
 *
 * 前端镜像：frontend/src/utils/screenshotValues.js（规则必须一致，由 parity 测试守护）
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

/** 全角转半角 + 去空白（仅做字符级归一化，不做任何数值推断） */
function toSearchableText(raw) {
  const text = String(raw ?? '')
  return text
    .replace(/[０-９．，：ＫＷ]/g, (char) => FULL_WIDTH_MAP[char] || char)
    .replace(/[\s\u00a0]/g, '')
}

/** 保留给用户看的原始文本（仅去首尾空白；空字符串 / 非字符串 → null） */
export function normalizeRawText(raw) {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim()
  return text === '' ? null : text
}

/** 解析失败 / 空值的统一返回结构 */
function unresolved(rawText, reason) {
  return { raw_text: rawText, value: null, needs_review: true, reason }
}

/**
 * 播放量文本 -> 整数播放量（纯确定性）
 * 5.2万 -> 52000　1万 -> 10000　8600 -> 8600　1.3w -> 13000　12K -> 12000　1.2亿 -> 120000000
 */
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

/**
 * 星图刊例价文本 -> 金额数字（纯确定性）
 * ¥3,000 -> 3000　3000元 -> 3000　3,000 -> 3000　1.5万 -> 15000
 */
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
