/**
 * DEMO_MODE 演示数据（全部虚构，无任何真实达人 / 报价 / 投放记录）
 *
 * 设计：
 *   · 数据集与指标全部在本模块内用「已冻结的业务口径」实时计算
 *     （CPM = 总花费 ÷ 累计播放量 × 1000；CPM30 目标价 = 中位播放 × 30 ÷ 1000；
 *       复投雷达分组 = 历史通过 / 表现分化 / 暂不优先 / 证据不足）
 *   · 所有名字均为「样板达人XX」系列虚构名；所有金额 / 播放量均为演示值
 *   · store 为浏览器内存态：编辑 / 刷新后恢复初始演示数据
 */

export const DEMO_TARGET_CPM = 30

// 2026 周一始（W40 = 10/05-10/11，与产品业务口径一致）
const WEEK_STARTS = {
  '2026-W38': '2026-09-21',
  '2026-W39': '2026-09-28',
  '2026-W40': '2026-10-05',
  '2026-W41': '2026-10-12',
  '2026-W42': '2026-10-19',
  '2026-W43': '2026-10-26'
}

function weekEnd(code) {
  const start = new Date(`${WEEK_STARTS[code]}T00:00:00`)
  start.setDate(start.getDate() + 6)
  return start.toISOString().slice(0, 10)
}

export const WEEK_INFOS = Object.fromEntries(
  Object.entries(WEEK_STARTS).map(([code, start]) => {
    const end = weekEnd(code)
    return [code, {
      weekCode: code,
      startDate: start,
      endDate: end,
      label: `${start.slice(5).replace('-', '/')}-${end.slice(5).replace('-', '/')}`
    }]
  })
)

export const CREATORS = [
  { id: 1, canonical_name: '样板达人01', creator_type: '科普类', identity_status: 'active' },
  { id: 2, canonical_name: '样板达人02', creator_type: '科普类', identity_status: 'active' },
  { id: 3, canonical_name: '样板达人03', creator_type: '历史类', identity_status: 'active' },
  { id: 4, canonical_name: '样板达人04', creator_type: '剧情类', identity_status: 'active' },
  { id: 5, canonical_name: '样板达人05', creator_type: '科普类', identity_status: 'active' },
  { id: 6, canonical_name: '样板达人06', creator_type: '历史类', identity_status: 'active' },
  { id: 7, canonical_name: '样板达人07', creator_type: '剧情类', identity_status: 'active' },
  { id: 8, canonical_name: '样板达人08', creator_type: '美食类', identity_status: 'active' }
]

const creatorType = (name) => CREATORS.find((c) => c.canonical_name === name)?.creator_type || '未分类'
const creatorId = (name) => CREATORS.find((c) => c.canonical_name === name)?.id ?? null

function record(id, timeCycle, nickname, totalCost, firstPlay, secondPlay, publishDate, createdAt) {
  return {
    id,
    time_cycle: timeCycle,
    nickname,
    creator_type: creatorType(nickname),
    homepage: null,
    content_link: null,
    video_link: null,
    total_cost: totalCost,
    first_play: firstPlay,
    second_week_play: secondPlay,
    publish_date: publishDate,
    created_at: createdAt,
    creator_id: creatorId(nickname),
    creator_link_source: 'demo_seed'
  }
}

// 演示投放记录：CPM 从「优秀（≈8）」到「明显低效（≈110）」全覆盖
export const INITIAL_RECORDS = [
  record(1, '2026-W38', '样板达人01', 1200, 22000, 150000, '2026-09-22', '2026-09-29 10:00:00'),
  record(2, '2026-W38', '样板达人03', 900, 18000, 118000, '2026-09-24', '2026-09-29 10:05:00'),
  record(3, '2026-W38', '样板达人08', 600, 9000, 42000, '2026-09-25', '2026-09-29 10:10:00'),
  record(4, '2026-W39', '样板达人01', 1500, 26000, 182000, '2026-09-29', '2026-10-06 09:30:00'),
  record(5, '2026-W39', '样板达人02', 2100, 30000, 68000, '2026-09-30', '2026-10-06 09:35:00'),
  record(6, '2026-W39', '样板达人03', 1000, 20000, 132000, '2026-10-02', '2026-10-06 09:40:00'),
  record(7, '2026-W39', '样板达人04', 2800, 26000, 61000, '2026-10-01', '2026-10-06 09:45:00'),
  record(8, '2026-W40', '样板达人01', 1600, 30000, 205000, '2026-10-06', '2026-10-13 09:20:00'),
  record(9, '2026-W40', '样板达人02', 2200, 28000, 71000, '2026-10-07', '2026-10-13 09:25:00'),
  record(10, '2026-W40', '样板达人05', 800, 15000, 96000, '2026-10-08', '2026-10-13 09:30:00'),
  record(11, '2026-W40', '样板达人06', 5000, 40000, 46000, '2026-10-09', '2026-10-13 09:35:00'),
  record(12, '2026-W40', '样板达人07', 3000, 24000, 58000, '2026-10-10', '2026-10-13 09:40:00'),
  record(13, '2026-W41', '样板达人01', 1700, 32000, 226000, '2026-10-13', '2026-10-20 09:10:00'),
  record(14, '2026-W41', '样板达人03', 1100, 21000, 140000, '2026-10-15', '2026-10-20 09:15:00'),
  record(15, '2026-W41', '样板达人05', 900, 16000, 104000, '2026-10-16', '2026-10-20 09:20:00'),
  record(16, '2026-W41', '样板达人06', 5200, 42000, 49000, '2026-10-14', '2026-10-20 09:25:00'),
  record(17, '2026-W42', '样板达人01', 1800, 34000, 240000, '2026-10-20', '2026-10-24 09:00:00'),
  record(18, '2026-W42', '样板达人02', 2300, 31000, 76000, '2026-10-21', '2026-10-24 09:05:00'),
  record(19, '2026-W42', '样板达人03', 1200, 23000, 152000, '2026-10-22', '2026-10-24 09:10:00'),
  record(20, '2026-W42', '样板达人05', 1000, 17000, 112000, '2026-10-23', '2026-10-24 09:15:00'),
  record(21, '2026-W43', '样板达人06', 5500, 45000, 51000, '2026-10-27', '2026-10-28 09:00:00'),
  record(22, '2026-W43', '样板达人07', 3200, 25000, 26000, '2026-10-28', '2026-10-28 09:05:00')
]

// —— 指标计算（口径与后端一致：CPM = cost / latestPlay × 1000）——
export function recordCpm(row) {
  const cost = Number(row.total_cost)
  const play = Number(row.second_week_play)
  if (!Number.isFinite(cost) || !Number.isFinite(play) || play <= 0) return null
  return (cost / play) * 1000
}

const round2 = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : null)

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

// —— 复投雷达（按已冻结口径实时计算） ——
export function buildRadar(referenceDate) {
  const reference = referenceDate || new Date().toISOString().slice(0, 10)
  const byCreator = new Map()
  for (const row of store.records) {
    const key = row.creator_id ?? `name:${row.nickname}`
    if (!byCreator.has(key)) {
      byCreator.set(key, {
        creator_id: row.creator_id,
        creator: row.nickname,
        creator_type: row.creator_type || '未分类',
        samples: [],
        record_count: 0,
        lastDate: null,
        lastActualCost: null,
        lastRecordId: null
      })
    }
    const entry = byCreator.get(key)
    entry.record_count += 1
    const cpm = recordCpm(row)
    if (cpm !== null) entry.samples.push({ cpmRaw: cpm, publishDate: row.publish_date })
    if (row.publish_date && (!entry.lastDate || row.publish_date >= entry.lastDate)) {
      if (!entry.lastDate || row.publish_date > entry.lastDate || row.id >= (entry.lastRecordId || 0)) {
        entry.lastDate = row.publish_date
        entry.lastActualCost = row.total_cost
        entry.lastRecordId = row.id
      }
    }
  }

  const items = [...byCreator.values()].map((entry) => {
    const validCount = entry.samples.length
    const passCount = entry.samples.filter((s) => s.cpmRaw <= DEMO_TARGET_CPM).length
    const failCount = validCount - passCount
    let status = 'insufficient'
    if (validCount >= 2) {
      status = passCount > failCount ? 'passed' : passCount === failCount ? 'mixed' : 'failed'
    }
    const recent = [...entry.samples].sort((a, b) => (a.publishDate < b.publishDate ? 1 : -1))
    const recentRisk = recent.length >= 2 && recent[0].cpmRaw > DEMO_TARGET_CPM && recent[1].cpmRaw > DEMO_TARGET_CPM
    const daysSince = entry.lastDate
      ? Math.max(0, Math.round((new Date(reference) - new Date(entry.lastDate)) / 86400000))
      : null
    const medianRaw = median(entry.samples.map((s) => s.cpmRaw))
    const single = validCount === 1 ? entry.samples[0].cpmRaw : null
    let workPriority = 'normal_attention'
    let workPriorityReason = 'no_valid_sample'
    if (single !== null) {
      if (single <= 10) { workPriority = 'high_attention'; workPriorityReason = 'single_sample_cpm_le_10' }
      else if (single <= 20) { workPriority = 'medium_attention'; workPriorityReason = 'single_sample_cpm_le_20' }
      else if (single >= 100) { workPriority = 'low_priority'; workPriorityReason = 'single_sample_cpm_ge_100' }
      else workPriorityReason = 'single_sample_cpm_normal'
    } else if (validCount >= 2) {
      workPriorityReason = status === 'passed' ? 'multi_sample_passed' : status === 'mixed' ? 'multi_sample_mixed' : 'multi_sample_failed'
      if (status === 'failed') workPriority = 'low_priority'
    }
    const labels = {
      passed: '历史通过', mixed: '表现分化', failed: '暂不优先', insufficient: '证据不足'
    }
    const priorityLabels = {
      single_sample_cpm_le_10: '单次表现突出',
      single_sample_cpm_le_20: '优先补数据',
      single_sample_cpm_ge_100: '单次合作明显低效'
    }
    return {
      creator_id: entry.creator_id,
      creator: entry.creator,
      creator_type: entry.creator_type,
      record_count: entry.record_count,
      valid_cpm_count: validCount,
      pass_count: passCount,
      fail_count: failCount,
      historical_status: status,
      historical_status_label: labels[status],
      work_priority: workPriority,
      work_priority_reason: workPriorityReason,
      work_priority_label: priorityLabels[workPriorityReason] ?? null,
      single_sample_cpm: single === null ? null : round2(single),
      median_cpm: medianRaw === null ? null : round2(medianRaw),
      medianCpmRaw: medianRaw,
      last_collaboration_date: entry.lastDate,
      days_since_last_collaboration: daysSince,
      last_actual_cost: entry.lastActualCost,
      recent_risk: recentRisk,
      recent_risk_text: recentRisk ? '最近2次合作均未达到 CPM 30' : null,
      recent_snapshot: snapshotSummaryFor(entry.creator),
      recent_decision: decisionSummaryFor(entry.creator)
    }
  })

  const matches = (item, key) => {
    if (key === 'priority') return item.historical_status === 'passed'
    if (key === 'watch') {
      return item.historical_status === 'mixed' ||
        (item.historical_status === 'insufficient' && !(item.single_sample_cpm !== null && item.single_sample_cpm >= 100))
    }
    return item.historical_status === 'failed' ||
      (item.historical_status === 'insufficient' && item.single_sample_cpm !== null && item.single_sample_cpm >= 100)
  }
  const groupDefs = [
    { key: 'priority', label: '优先关注' },
    { key: 'watch', label: '需要观察' },
    { key: 'low_priority', label: '暂不优先' }
  ]
  const groups = groupDefs.map(({ key, label }) => {
    const list = items.filter((item) => matches(item, key))
    list.sort((a, b) => {
      const av = a.medianCpmRaw ?? Infinity
      const bv = b.medianCpmRaw ?? Infinity
      return av - bv || (b.days_since_last_collaboration ?? 0) - (a.days_since_last_collaboration ?? 0) ||
        a.creator.localeCompare(b.creator, 'zh-Hans-CN')
    })
    return {
      key, label, count: list.length,
      creators: list.map(({ medianCpmRaw, ...publicFields }) => publicFields)
    }
  })
  return {
    target_cpm: DEMO_TARGET_CPM,
    reference_date: reference,
    sort: {
      priority: '历史CPM中位数(raw) 升序 → days_since_last_collaboration 降序 → creator 名称升序',
      watch: 'work_priority(high→medium→normal) → mixed 优先于 insufficient → 历史CPM中位数(raw) 升序 → days_since_last_collaboration 降序 → creator 名称升序',
      low_priority: '历史CPM中位数(raw) 升序 → days_since_last_collaboration 降序 → creator 名称升序（含「单样本明显低效」的 insufficient 达人）'
    },
    groups,
    summary: {
      creator_count: items.length,
      record_count: items.reduce((sum, i) => sum + i.record_count, 0),
      valid_cpm_count: items.reduce((sum, i) => sum + i.valid_cpm_count, 0),
      priority_count: groups[0].count,
      watch_count: groups[1].count,
      low_priority_count: groups[2].count
    },
    identity_mode: true,
    unattributed_record_count: 0
  }
}

// —— 近期表现快照（虚构：为 3 位达人提供完整统计 + CPM30 价格判断） ——
const SNAPSHOT_SEEDS = [
  { id: 1, creator: '样板达人01', candidate_id: 1, plays: [218000, 186000, 232000, 205000], xingtuPrice: 9000, observedAt: '2026-10-22' },
  { id: 2, creator: '样板达人02', candidate_id: 2, plays: [74000, 66000, 81000, 70000], xingtuPrice: 5000, observedAt: '2026-10-22' },
  { id: 3, creator: '样板达人03', candidate_id: 3, plays: [138000, 125000, 152000, 141000], xingtuPrice: 6000, observedAt: '2026-10-22' }
]

function snapshotPayload(seed, id) {
  const plays = seed.plays
  const stats = {
    id,
    created_at: `${seed.observedAt} 10:00:00`,
    valid_count: plays.length,
    analysis_count: plays.length,
    median_play: Math.round(median(plays)),
    p25_play: Math.round(percentile(plays, 0.25)),
    p75_play: Math.round(percentile(plays, 0.75)),
    recent_median_play: Math.round(median(plays.slice(-2))),
    prior_median_play: Math.round(median(plays.slice(0, -2))),
    trend_ratio: plays.length >= 4 ? round2(median(plays.slice(-2)) / median(plays.slice(0, -2))) : null,
    trend_label: '平稳',
    xingtu_price: seed.xingtuPrice,
    stats_status: 'ok',
    stats_version: 2,
    sponsored_count: 2,
    organic_count: plays.length - 2,
    unknown_count: 0,
    observed_at: seed.observedAt
  }
  const target = round2((stats.median_play * DEMO_TARGET_CPM) / 1000)
  const refLow = round2((stats.p25_play * DEMO_TARGET_CPM) / 1000)
  const refHigh = round2((stats.p75_play * DEMO_TARGET_CPM) / 1000)
  stats.pricing = {
    pricing_version: 3,
    target_cpm: DEMO_TARGET_CPM,
    target_price: target,
    reference_low: refLow,
    reference_high: refHigh,
    xingtu_price: seed.xingtuPrice,
    negotiation_max_price: round2(seed.xingtuPrice * 0.7),
    negotiation_min_price: round2(seed.xingtuPrice * 0.2),
    entry_discount_rate: round2(refHigh / seed.xingtuPrice),
    entry_discount_zhe: Math.round((refHigh / seed.xingtuPrice) * 1000) / 100,
    target_discount_rate: round2(target / seed.xingtuPrice),
    target_discount_zhe: Math.round((target / seed.xingtuPrice) * 1000) / 100,
    pricing_status: 'negotiation_max_enters_range',
    pricing_status_label: '在当前2～7折谈价区间内，7折已可进入 CPM30参考区间。',
    needs_negotiation: true,
    target_discount_below_negotiation_min: false,
    quote_at_or_below_target: false,
    quote_at_or_below_reference_high: true
  }
  return stats
}

export const INITIAL_SNAPSHOTS = SNAPSHOT_SEEDS.map((seed, i) => ({
  ...snapshotPayload(seed, seed.id),
  creator: seed.creator,
  candidate_id: seed.candidate_id,
  plays_json: JSON.stringify(
    seed.plays.map((play, idx) => ({ play: Math.round(play / 10000 * 10) / 10, content_type: idx % 4 === 3 ? 'sponsored' : 'organic', position_index: idx + 1 }))
  ),
  _seed: seed
}))

function snapshotSummaryFor(creatorName) {
  const snap = store.snapshots.find((s) => s.creator === creatorName)
  if (!snap) return null
  const { plays_json, _seed, creator, candidate_id, ...summary } = snap
  return summary
}

// —— 候选达人（达人拓展页） ——
export const INITIAL_CANDIDATES = [
  { id: 1, name: '样板达人01', creator_type: '科普类', profile_url: null, xingtu_url: null, xingtu_id: null, description: '演示候选：知识科普赛道，历史合作表现稳定', distilled_description: null, status: 'active', created_at: '2026-09-20 09:00:00', updated_at: '2026-10-20 09:00:00', creator_id: 1, creator: { id: 1, canonical_name: '样板达人01', identity_status: 'active' }, work_state: 'working', work_state_note: '复投观察中', work_state_updated_at: '2026-10-20 09:00:00', work_state_source: 'events' },
  { id: 2, name: '样板达人02', creator_type: '科普类', profile_url: null, xingtu_url: null, xingtu_id: null, description: '演示候选：CPM 偏高，需谈价后评估', distilled_description: null, status: 'active', created_at: '2026-09-21 09:00:00', updated_at: '2026-10-21 09:00:00', creator_id: 2, creator: { id: 2, canonical_name: '样板达人02', identity_status: 'active' }, work_state: 'observing', work_state_note: null, work_state_updated_at: '2026-10-21 09:00:00', work_state_source: 'events' },
  { id: 3, name: '样板达人03', creator_type: '历史类', profile_url: null, xingtu_url: null, xingtu_id: null, description: '演示候选：多次复投，历史通过', distilled_description: null, status: 'active', created_at: '2026-09-22 09:00:00', updated_at: '2026-10-22 09:00:00', creator_id: 3, creator: { id: 3, canonical_name: '样板达人03', identity_status: 'active' }, work_state: 'working', work_state_note: null, work_state_updated_at: '2026-10-22 09:00:00', work_state_source: 'events' },
  { id: 4, name: '样板达人05', creator_type: '科普类', profile_url: null, xingtu_url: null, xingtu_id: null, description: '演示候选：单次合作，单次表现突出', distilled_description: null, status: 'active', created_at: '2026-10-08 09:00:00', updated_at: '2026-10-20 09:00:00', creator_id: 5, creator: { id: 5, canonical_name: '样板达人05', identity_status: 'active' }, work_state: 'todo', work_state_note: null, work_state_updated_at: null, work_state_source: 'default' },
  { id: 5, name: '样板达人06', creator_type: '历史类', profile_url: null, xingtu_url: null, xingtu_id: null, description: '演示候选：连续未达标，暂不优先', distilled_description: null, status: 'paused', created_at: '2026-09-25 09:00:00', updated_at: '2026-10-23 09:00:00', creator_id: 6, creator: { id: 6, canonical_name: '样板达人06', identity_status: 'active' }, work_state: 'low_priority', work_state_note: null, work_state_updated_at: '2026-10-23 09:00:00', work_state_source: 'events' },
  { id: 6, name: '样板达人07', creator_type: '剧情类', profile_url: null, xingtu_url: null, xingtu_id: null, description: '演示候选：新观察对象', distilled_description: null, status: 'active', created_at: '2026-10-12 09:00:00', updated_at: '2026-10-24 09:00:00', creator_id: 7, creator: { id: 7, canonical_name: '样板达人07', identity_status: 'active' }, work_state: 'todo', work_state_note: null, work_state_updated_at: null, work_state_source: 'default' }
]

// —— 决策 / Outcome / 谈价（虚构） ——
export const INITIAL_DECISIONS = [
  {
    id: 1, creator: '样板达人01', candidate_id: 1, decision_stage: 'repurchase', snapshot_id: 1,
    current_quote_raw: 9000, current_quote: 9000, ip_judgement: '内容质量稳定，粉丝画像匹配',
    human_decision: 'reuse', human_decision_label: '复投', decision_note: '历史通过，继续合作',
    historical_evidence: { record_count: 3, pass_count: 3, median_cpm: 8.24 },
    recent_evidence: { median_play: 210250, trend_label: '平稳' },
    pricing_evidence: { target_price: 6307.5, reference_low: 5175, reference_high: 7350 },
    target_cpm: 30, pricing_version: 3, system_context_version: 'demo',
    decided_at: '2026-10-22', created_at: '2026-10-22 10:00:00',
    voided_at: null, void_reason: null,
    outcome: { id: 1, record_id: 17, actual_cost: 1800, actual_play: 240000, linked_at: '2026-10-24 09:00:00' },
    negotiation_case: { id: 1, negotiated_price: 6300, source_type: 'live' }
  },
  {
    id: 2, creator: '样板达人02', candidate_id: 2, decision_stage: 'repurchase', snapshot_id: 2,
    current_quote_raw: 5000, current_quote: 5000, ip_judgement: 'CPM 偏高，建议议价',
    human_decision: 'observe', human_decision_label: '观察', decision_note: '等待下一次数据',
    historical_evidence: { record_count: 3, pass_count: 0, median_cpm: 30.6 },
    recent_evidence: { median_play: 72000, trend_label: '平稳' },
    pricing_evidence: { target_price: 2160, reference_low: 1800, reference_high: 2550 },
    target_cpm: 30, pricing_version: 3, system_context_version: 'demo',
    decided_at: '2026-10-22', created_at: '2026-10-22 10:05:00',
    voided_at: null, void_reason: null,
    outcome: null, negotiation_case: null
  },
  {
    id: 3, creator: '样板达人03', candidate_id: 3, decision_stage: 'repurchase', snapshot_id: 3,
    current_quote_raw: 6000, current_quote: 6000, ip_judgement: '历史通过，价格合理',
    human_decision: 'reuse', human_decision_label: '复投', decision_note: '继续复投',
    historical_evidence: { record_count: 4, pass_count: 4, median_cpm: 8.1 },
    recent_evidence: { median_play: 141000, trend_label: '平稳' },
    pricing_evidence: { target_price: 4230, reference_low: 3525, reference_high: 4950 },
    target_cpm: 30, pricing_version: 3, system_context_version: 'demo',
    decided_at: '2026-10-22', created_at: '2026-10-22 10:10:00',
    voided_at: null, void_reason: null,
    outcome: { id: 2, record_id: 19, actual_cost: 1200, actual_play: 152000, linked_at: '2026-10-24 09:10:00' },
    negotiation_case: { id: 2, negotiated_price: 4200, source_type: 'live' }
  },
  {
    id: 4, creator: '样板达人06', candidate_id: 5, decision_stage: 'repurchase', snapshot_id: null,
    current_quote_raw: 8000, current_quote: 8000, ip_judgement: '连续未达标',
    human_decision: 'pause', human_decision_label: '暂不优先', decision_note: 'CPM 连续超标，暂停合作',
    historical_evidence: { record_count: 3, pass_count: 0, median_cpm: 111.4 },
    recent_evidence: null,
    pricing_evidence: null,
    target_cpm: 30, pricing_version: 3, system_context_version: 'demo',
    decided_at: '2026-10-23', created_at: '2026-10-23 10:00:00',
    voided_at: null, void_reason: null,
    outcome: null, negotiation_case: null
  }
]

export const INITIAL_NEGOTIATION_CASES = [
  { id: 1, creator: '样板达人01', record_id: 17, source_type: 'live', xingtu_price: 9000, quoted_price: 7000, negotiated_price: 6300, status: 'accepted', note: '7折进入参考区间', created_at: '2026-10-22 11:00:00' },
  { id: 2, creator: '样板达人03', record_id: 19, source_type: 'live', xingtu_price: 6000, quoted_price: 4800, negotiated_price: 4200, status: 'accepted', note: null, created_at: '2026-10-22 11:10:00' },
  { id: 3, creator: '样板达人05', record_id: 20, source_type: 'historical_backfill', xingtu_price: 4500, quoted_price: 3600, negotiated_price: 3200, status: 'accepted', note: '历史补录', created_at: '2026-10-23 09:00:00' }
]

// —— 导入批次（虚构） ——
export const INITIAL_BATCHES = [
  { id: 1, file_name: '演示-9月投放导入.xlsx', total_count: 12, success_count: 10, fail_count: 1, skip_count: 1, duplicate_count: 0, created_at: '2026-09-29 10:00:00' },
  { id: 2, file_name: '演示-10月投放导入.xlsx', total_count: 10, success_count: 10, fail_count: 0, skip_count: 0, duplicate_count: 0, created_at: '2026-10-13 09:20:00' }
]

// —— 内存 store（刷新页面即恢复初始演示数据） ——
export const store = {
  records: [],
  edits: [],
  candidates: [],
  batches: [],
  batchRecords: [],
  decisions: [],
  cases: [],
  snapshots: [],
  reset() {
    this.records = INITIAL_RECORDS.map((row) => ({ ...row }))
    this.edits = []
    this.candidates = INITIAL_CANDIDATES.map((c) => ({ ...c, creator: c.creator ? { ...c.creator } : null }))
    this.batches = INITIAL_BATCHES.map((b) => ({ ...b }))
    this.batchRecords = INITIAL_RECORDS.slice(0, 10).map((row, i) => ({ batch_id: i < 4 ? 1 : 2, record_id: row.id }))
    this.decisions = INITIAL_DECISIONS.map((d) => ({ ...d, outcome: d.outcome ? { ...d.outcome } : null }))
    this.cases = INITIAL_NEGOTIATION_CASES.map((c) => ({ ...c }))
    this.snapshots = INITIAL_SNAPSHOTS.map((s) => ({ ...s }))
  }
}
store.reset()

// —— 决策 summary（雷达页轻量展示） ——
export function decisionSummaryFor(creatorName) {
  const decision = [...store.decisions]
    .filter((d) => d.creator === creatorName && !d.voided_at)
    .sort((a, b) => (b.decided_at || '').localeCompare(a.decided_at || ''))[0]
  if (!decision) return null
  return {
    id: decision.id,
    decision_stage: decision.decision_stage,
    human_decision: decision.human_decision,
    human_decision_label: decision.human_decision_label,
    decided_at: decision.decided_at,
    outcome: decision.outcome
  }
}

// —— CPM30 价格判断（与后端公式一致，供 price-reference 使用） ——
export function pricingForSnapshot(stats) {
  return stats?.pricing ?? null
}
