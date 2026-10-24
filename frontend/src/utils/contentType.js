/**
 * 内容类型（Alpha.3-04）：商单 / 日常 / 未识别（纯展示与归一化，无业务加权）
 *
 * 业务语义：红色标识 = 商单，蓝色标识 = 日常，无法确认 = 未识别。
 * 颜色只是 AI 判断依据，持久化字段始终是 sponsored / organic / unknown。
 * 不做加权、不做综合分、不用日常数据冒充商单表现。
 */

import { formatPlays } from './format.js'

export const CONTENT_TYPES = {
  sponsored: 'sponsored',
  organic: 'organic',
  unknown: 'unknown'
}

export const CONTENT_TYPE_LABELS = {
  sponsored: '商单',
  organic: '日常',
  unknown: '未识别'
}

/** 逐条编辑下拉选项（顺序：商单 → 日常 → 未识别） */
export const CONTENT_TYPE_OPTIONS = [
  { value: CONTENT_TYPES.sponsored, label: CONTENT_TYPE_LABELS.sponsored },
  { value: CONTENT_TYPES.organic, label: CONTENT_TYPE_LABELS.organic },
  { value: CONTENT_TYPES.unknown, label: CONTENT_TYPE_LABELS.unknown }
]

/** 归一化：只接受 allowlist，其余（含 null / 非法值 / 旧数据）一律 unknown */
export function normalizeContentType(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === CONTENT_TYPES.sponsored) return CONTENT_TYPES.sponsored
  if (text === CONTENT_TYPES.organic) return CONTENT_TYPES.organic
  return CONTENT_TYPES.unknown
}

/**
 * Radar「商单 / 日常」单元格内容（只做展示，不参与任何业务判断）
 * @returns {{ hasTypeData: boolean, sponsored: object|null, organic: object|null, unknownCount: number }}
 */
export function buildContentTypeCell(snapshot) {
  const sponsoredCount = Number(snapshot?.sponsored_count ?? 0)
  const organicCount = Number(snapshot?.organic_count ?? 0)
  const unknownCount = Number(snapshot?.unknown_count ?? 0)
  const hasTypeData = sponsoredCount > 0 || organicCount > 0
  const build = (count, median) =>
    count > 0 ? { count, median_play: median ?? null, text: formatPlays(median) } : null
  return {
    hasTypeData,
    sponsored: build(sponsoredCount, snapshot?.sponsored_median_play),
    organic: build(organicCount, snapshot?.organic_median_play),
    unknownCount
  }
}

/**
 * 商单样本语义（第一版，仅展示层）：
 *   0 条 → 暂无商单数据（日常表现作为参考）
 *   1–2 条 → 展示真实商单中位数 + 「商单样本较少」
 *   >= 3 条 → 商单中位数作为主要参考
 * 不修改 historical_status / work_priority，不产生评分。
 */
export function getSponsoredSampleTier(sponsoredCount) {
  const count = Number(sponsoredCount ?? 0)
  if (count <= 0) return 'none'
  if (count < 3) return 'insufficient'
  return 'sufficient'
}

/**
 * Alpha.3-04A：Radar「近期内容表现」单元格文案（只有展示状态，不含业务判断）
 *
 * 状态：
 *   no-snapshot   : 没有近期快照 → 页面显示占位
 *   typed         : 有商单或日常样本 → 商单中位 / 日常中位（明确「中位」，不是平均/最新/总播放）
 *   unknown-only  : 有播放数据但商单/日常都还没确认 → X条内容待分类 + 商单 / 日常尚未确认
 *   no-sample     : 有快照但没有可用样本 → 页面显示占位
 *
 * @returns {{ state: string, unknownCount: number, lines: Array<{text: string, primary: boolean}> }}
 */
export function buildContentPerformanceLines(snapshot) {
  if (!snapshot) return { state: 'no-snapshot', unknownCount: 0, lines: [] }
  const cell = buildContentTypeCell(snapshot)
  const sponsoredCount = cell.sponsored?.count ?? 0
  const organicCount = cell.organic?.count ?? 0
  const unknownCount = Number(snapshot?.unknown_count ?? 0)

  if (!cell.hasTypeData) {
    if (unknownCount > 0) {
      return {
        state: 'unknown-only',
        unknownCount,
        lines: [
          { text: `${unknownCount}条内容待分类`, primary: true },
          { text: '商单 / 日常尚未确认', primary: false }
        ]
      }
    }
    return { state: 'no-sample', unknownCount, lines: [] }
  }

  const lines = [
    {
      text:
        sponsoredCount > 0
          ? `商单中位 ${cell.sponsored.text} · ${sponsoredCount}条`
          : '暂无商单数据',
      primary: true
    }
  ]
  // 近期表现语义审计：样本充分性必须如实表达 ——
  //   0 条商单 → 「暂无商单样本」（既不是「较少」，更不能被下游推导成「充足」）
  //   1–2 条商单 → 「商单样本较少」
  //   >= 3 条商单 → 不出提示（充足语义由分档决定，不由「是否出现提示行」反推）
  const sponsoredTier = getSponsoredSampleTier(sponsoredCount)
  if (sponsoredTier === 'none') {
    lines.push({ text: '暂无商单样本', primary: false })
  } else if (sponsoredTier === 'insufficient') {
    lines.push({ text: '商单样本较少', primary: false })
  }
  if (organicCount > 0) {
    lines.push({ text: `日常中位 ${cell.organic.text} · ${organicCount}条`, primary: false })
  }
  return { state: 'typed', unknownCount, lines }
}

/** Popover「内容构成」行（未识别也如实展示） */
export function buildContentBreakdownRows(snapshot) {
  const sponsoredCount = Number(snapshot?.sponsored_count ?? 0)
  const organicCount = Number(snapshot?.organic_count ?? 0)
  const unknownCount = Number(snapshot?.unknown_count ?? 0)
  const line = (count, median) =>
    median === null || median === undefined
      ? `${count} 条`
      : `${count} 条，中位 ${formatPlays(median)}`
  return [
    { label: '商单', value: line(sponsoredCount, snapshot?.sponsored_median_play) },
    { label: '日常', value: line(organicCount, snapshot?.organic_median_play) },
    { label: '未识别', value: line(unknownCount, null) }
  ]
}
