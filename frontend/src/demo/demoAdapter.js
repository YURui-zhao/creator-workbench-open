/**
 * DEMO_MODE axios 适配层：在浏览器内存中模拟后端接口。
 * 不发起任何网络请求，不访问任何真实后端 / 数据库。
 * 数据全部虚构（见 demoData.js），编辑等操作仅作用于内存，刷新即恢复。
 */
import {
  store, CREATORS, WEEK_INFOS, buildRadar, recordCpm, decisionSummaryFor, pricingForSnapshot
} from './demoData.js'

const ok = (data) => ({ code: 200, data, msg: 'success' })
const fail = (code, msg) => ({ code, data: null, msg })

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fullUrl(config) {
  const path = String(config.url || '')
  return path.startsWith('/api') ? path.slice(4) : path
}

function parseParams(config) {
  const params = config.params || {}
  const fromUrl = {}
  const query = fullUrl(config).split('?')[1]
  if (query) {
    for (const pair of new URLSearchParams(query)) fromUrl[pair[0]] = pair[1]
  }
  return { ...fromUrl, ...params }
}

function parseBody(config) {
  if (typeof config.data !== 'string') return config.data || {}
  try { return JSON.parse(config.data) } catch { return {} }
}

const paginate = (list, params) => {
  const page = Math.max(1, Number(params.page) || 1)
  const size = Math.max(1, Number(params.pageSize) || 10)
  return { list: list.slice((page - 1) * size, page * size), total: list.length }
}

// —— 投放记录列表（筛选 / 分页，口径与后端一致：publish_date 倒序） ——
function recordsList(params) {
  let rows = [...store.records].sort((a, b) => {
    if (a.publish_date !== b.publish_date) return a.publish_date < b.publish_date ? 1 : -1
    return b.id - a.id
  })
  if (params.nickname) rows = rows.filter((r) => r.nickname.includes(String(params.nickname).trim()))
  if (params.creatorType) rows = rows.filter((r) => r.creator_type === params.creatorType)
  if (params.timeCycle) rows = rows.filter((r) => r.time_cycle === params.timeCycle)
  if (params.batchId) rows = rows.filter((r) => store.batchRecords.some((m) => m.batch_id === Number(params.batchId) && m.record_id === r.id))
  if (params.startDate) rows = rows.filter((r) => r.publish_date >= params.startDate)
  if (params.endDate) rows = rows.filter((r) => r.publish_date <= params.endDate)
  const { list, total } = paginate(rows, params)
  return ok({ list: list.map(withCpm), total })
}

function withCpm(row) {
  const cpm = recordCpm(row)
  return { ...row, cpm: cpm === null ? null : Number(cpm.toFixed(1)), growth: playGrowth(row) }
}

function playGrowth(row) {
  const first = Number(row.first_play)
  const latest = Number(row.second_week_play)
  if (!Number.isFinite(first) || !Number.isFinite(latest)) return null
  return latest - first
}

// —— 周统计（campaign 口径按投放周聚合；字段与后端 serializeBucket 对齐） ——
function weekBucket(weekCode, rows) {
  const plays = rows.map((r) => Number(r.second_week_play)).filter(Number.isFinite)
  const cpms = rows.map(recordCpm).filter((v) => v !== null)
  const totalCost = rows.reduce((sum, r) => sum + (Number(r.total_cost) || 0), 0)
  const totalPlay = plays.reduce((sum, v) => sum + v, 0)
  const firstTotal = rows.reduce((sum, r) => sum + (Number(r.first_play) || 0), 0)
  const info = WEEK_INFOS[weekCode]
  const cpm = totalPlay > 0 ? (totalCost / totalPlay) * 1000 : null
  const hitCount = cpms.filter((v) => v <= 30).length
  const playByCreator = new Map()
  for (const row of rows) {
    playByCreator.set(row.nickname, (playByCreator.get(row.nickname) || 0) + (Number(row.second_week_play) || 0))
  }
  return {
    weekCode,
    startDate: info?.startDate ?? null,
    endDate: info?.endDate ?? null,
    label: info?.label ?? weekCode,
    second_week_play_total: totalPlay,
    second_play_total: totalPlay,
    latest_play_total: totalPlay,
    first_play_total: firstTotal,
    post_7d_growth_total: rows.reduce((sum, r) => sum + (playGrowth(r) || 0), 0),
    total_cost: round(totalCost),
    creator_count: new Set(rows.map((r) => r.creator_id ?? r.nickname)).size,
    record_count: rows.length,
    creators: [...playByCreator.entries()].map(([nickname, play]) => ({ nickname, play })),
    avg_cpm: round(cpm),
    cpm_7d: round(cpms.length ? cpms.reduce((s, v) => s + v, 0) / cpms.length : null),
    hit_7d_count: cpms.filter((v) => v <= 30).length,
    hit_latest_count: hitCount,
    hit_count: hitCount,
    hit_rate_7d: cpms.length ? round(hitCount / cpms.length) : null,
    hit_rate_latest: cpms.length ? round(hitCount / cpms.length) : null,
    hit_rate: cpms.length ? round(hitCount / cpms.length) : null,
    first_sample_count: rows.filter((r) => Number.isFinite(Number(r.first_play))).length,
    first_positive_sample_count: rows.filter((r) => Number(r.first_play) > 0).length,
    latest_sample_count: plays.length,
    latest_pending_count: rows.filter((r) => !Number.isFinite(Number(r.second_week_play))).length,
    anomaly_count: 0
  }
}

const round = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : null)

function weekStats(params) {
  const byWeek = new Map()
  for (const row of store.records) {
    const code = params.caliber === 'occurrence'
      ? weekOfPublishDate(row.publish_date)
      : row.time_cycle
    if (!code) continue
    if (!byWeek.has(code)) byWeek.set(code, [])
    byWeek.get(code).push(row)
  }
  if (params.weekCode) {
    const bucket = byWeek.get(params.weekCode)
    // 与后端一致：单周分支直接返回 bucket 本身（无数据时返回零值结构）
    return ok(bucket ? weekBucket(params.weekCode, bucket) : {
      weekCode: params.weekCode,
      caliber: params.caliber || 'campaign',
      total_play: 0,
      latest_play_total: 0,
      first_play_total: 0,
      second_week_play_total: 0,
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
    })
  }
  const weeks = [...byWeek.entries()]
    .map(([code, rows]) => weekBucket(code, rows))
    .sort((a, b) => (a.weekCode < b.weekCode ? 1 : -1))
  const inRange = params.startWeek
    ? weeks.filter((w) => w.weekCode >= params.startWeek && (!params.endWeek || w.weekCode <= params.endWeek))
    : weeks
  const total = rangeSummary(inRange)
  return ok({
    caliber: params.caliber || 'campaign',
    weeks: inRange,
    earliestWeek: weeks.length ? weeks[weeks.length - 1].weekCode : null,
    latestWeek: weeks.length ? weeks[0].weekCode : null,
    total_summary: total
  })
}

function rangeSummary(weeks) {
  const allRows = []
  for (const w of weeks) {
    const rows = store.records.filter((r) => (paramsKey(r) ? true : true) && matchWeekRow(w.weekCode, r))
    allRows.push(...rows)
  }
  const bucket = weekBucket('汇总', allRows)
  const { weekCode, startDate, endDate, label, ...summary } = bucket
  return summary
}

const paramsKey = () => false

function matchWeekRow(weekCode, row) {
  return (row.time_cycle === weekCode) || weekOfPublishDate(row.publish_date) === weekCode
}

function weekOfPublishDate(dateText) {
  if (!dateText) return null
  for (const [code, info] of Object.entries(WEEK_INFOS)) {
    if (dateText >= info.startDate && dateText <= info.endDate) return code
  }
  return null
}

// —— 达人汇总（CreatorSummary 页） ——
function creatorSummary(params) {
  const caliber = params.caliber || 'campaign'
  const keyword = params.keyword ? String(params.keyword).trim() : ''
  const byCreator = new Map()
  for (const row of store.records) {
    if (keyword && !row.nickname.includes(keyword)) continue
    if (params.creatorTypes && params.creatorTypes !== row.creator_type && String(params.creatorTypes) !== '') continue
    const key = row.creator_id ?? row.nickname
    if (!byCreator.has(key)) {
      byCreator.set(key, { creator_id: row.creator_id, creator: row.nickname, creator_type: row.creator_type || '未分类', rows: [] })
    }
    byCreator.get(key).rows.push(row)
  }
  const creators = [...byCreator.values()].map(({ creator_id, creator, creator_type, rows }) => {
    const totalCost = rows.reduce((s, r) => s + (Number(r.total_cost) || 0), 0)
    const totalPlay = rows.reduce((s, r) => s + (Number(r.second_week_play) || 0), 0)
    const cpms = rows.map(recordCpm).filter((v) => v !== null)
    const hit = cpms.filter((v) => v <= 30).length
    return {
      creator_id,
      creator,
      creator_type,
      record_count: rows.length,
      total_campaigns: rows.length,
      total_cost: round(totalCost),
      total_play: totalPlay,
      avg_cpm: round(totalPlay > 0 ? (totalCost / totalPlay) * 1000 : null),
      cpm_7d: round(cpms.length ? cpms.reduce((s, v) => s + v, 0) / cpms.length : null),
      hit_count: hit,
      hit_rate: cpms.length ? round(hit / cpms.length) : null,
      first_play_total: rows.reduce((s, r) => s + (Number(r.first_play) || 0), 0),
      latest_play_total: totalPlay,
      post_7d_growth_total: rows.reduce((s, r) => s + (playGrowth(r) || 0), 0)
    }
  }).sort((a, b) => b.total_cost - a.total_cost)
  const groups = params.groupByType === 'false'
    ? [{ creator_type: '全部达人', creators, total_cost: sumField(creators, 'total_cost'), total_play: sumField(creators, 'total_play') }]
    : [...new Set(creators.map((c) => c.creator_type))].map((type) => {
        const list = creators.filter((c) => c.creator_type === type)
        return { creator_type: type, creators: list, total_cost: sumField(list, 'total_cost'), total_play: sumField(list, 'total_play') }
      })
  return ok({
    caliber,
    groupByType: params.groupByType !== 'false',
    range: { earliestWeek: '2026-W38', latestWeek: '2026-W43' },
    filters: { creatorTypes: null, keyword, minCampaigns: null },
    sort: { sortBy: 'total_cost', sortOrder: 'desc' },
    groups,
    creators,
    total_summary: {
      creator_count: creators.length,
      record_count: creators.reduce((s, c) => s + c.record_count, 0),
      total_cost: sumField(creators, 'total_cost'),
      total_play: sumField(creators, 'total_play'),
      total_campaigns: creators.reduce((s, c) => s + c.total_campaigns, 0),
      post_7d_growth_total: sumField(creators, 'post_7d_growth_total')
    },
    identity_mode: true,
    unattributed_record_count: 0
  })
}

const sumField = (list, field) => round(list.reduce((s, item) => s + (Number(item[field]) || 0), 0))

// —— 路由表 ——
export async function demoRequest(config) {
  await delay(120)
  const method = String(config.method || 'get').toLowerCase()
  const path = fullUrl(config).split('?')[0].replace(/\/+$/, '') || '/'
  const params = parseParams(config)
  const body = parseBody(config)
  const notFound = () => Promise.resolve(response(config, fail(404, '演示模式：接口不存在')))

  // ---- 通用 ----
  if (path === '/health') return response(config, ok({ status: 'ok', db: 'demo', time: new Date().toISOString(), port: 0, demo: true }))
  if (path === '/ai/status') return response(config, ok({ configured: false, provider: null, model: null, demo: true }))

  // ---- 投放记录 ----
  if (path === '/records' && method === 'get') return response(config, recordsList(params))
  if (path === '/records' && method === 'post') {
    const id = Math.max(0, ...store.records.map((r) => r.id)) + 1
    const row = { ...body, id, creator_type: body.creator_type || creatorTypeOf(body.nickname), creator_id: creatorIdOf(body.nickname), created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') }
    store.records.push(row)
    return response(config, ok(withCpm(row)))
  }
  if (path === '/records/time-cycles') return response(config, ok([...new Set(store.records.map((r) => r.time_cycle))].sort().reverse()))
  if (path === '/records/cycles') {
    const list = [...new Set(store.records.map((r) => r.time_cycle))].map((code) => WEEK_INFOS[code]).filter(Boolean).sort((a, b) => (a.weekCode < b.weekCode ? 1 : -1))
    return response(config, ok(list))
  }
  if (path === '/records/filters') {
    const countBy = (field) => {
      const map = new Map()
      for (const row of store.records) {
        const value = String(row[field] || '').trim()
        if (value) map.set(value, (map.get(value) || 0) + 1)
      }
      return [...map.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN'))
    }
    return response(config, ok({ creatorTypes: countBy('creator_type'), nicknames: countBy('nickname'), weekRange: { earliestWeek: '2026-W38', latestWeek: '2026-W43' } }))
  }
  if (path === '/records/week-stats') return response(config, weekStats(params))
  if (path === '/records/repurchase-radar') return response(config, ok(buildRadar(params.current_date)))
  if (path === '/records/creator-summary') return response(config, creatorSummary(params))
  if (path === '/records/batch-update') {
    const field = body.field
    const value = body.value
    let success = 0
    for (const id of body.ids || []) {
      const row = store.records.find((r) => r.id === Number(id))
      if (!row) continue
      const before = row[field]
      if (before !== value) {
        recordEdit(row.id, field, before, value, 'manual_batch', body.ids.join(','))
        row[field] = value
      }
      success += 1
    }
    return response(config, ok({ successCount: success, failCount: 0, failList: [], success, failed: 0, errors: [] }))
  }
  if (path === '/records/batch-delete') {
    let success = 0
    for (const id of body.ids || []) {
      const idx = store.records.findIndex((r) => r.id === Number(id))
      if (idx >= 0) { recordEdit(Number(id), '__row__', store.records[idx], null, 'batch_delete', body.ids.join(','), true); store.records.splice(idx, 1); success += 1 }
    }
    return response(config, ok({ success, failed: 0, errors: [] }))
  }

  const recordMatch = path.match(/^\/records\/(\d+)$/)
  if (recordMatch && method === 'put') {
    const row = store.records.find((r) => r.id === Number(recordMatch[1]))
    if (!row) return response(config, fail(404, '记录不存在'))
    for (const [field, value] of Object.entries(body)) {
      if (JSON.stringify(row[field]) !== JSON.stringify(value)) {
        recordEdit(row.id, field, row[field], value, 'manual_single', null)
        row[field] = value
      }
    }
    return response(config, ok(withCpm(row)))
  }
  if (recordMatch && method === 'delete') {
    const idx = store.records.findIndex((r) => r.id === Number(recordMatch[1]))
    if (idx < 0) return response(config, fail(404, '记录不存在'))
    recordEdit(store.records[idx].id, '__row__', store.records[idx], null, 'manual_delete', null, true)
    store.records.splice(idx, 1)
    return response(config, ok({ id: Number(recordMatch[1]) }))
  }
  const editsMatch = path.match(/^\/records\/(\d+)\/edits$/)
  if (editsMatch) {
    const id = Number(editsMatch[1])
    const edits = store.edits.filter((e) => e.record_id === id).slice().reverse()
    return response(config, ok({ record_id: id, record_exists: store.records.some((r) => r.id === id), available: true, edits }))
  }

  // ---- 达人库 / 汇总 ----
  if (path === '/creators') {
    const keyword = params.keyword ? String(params.keyword).trim() : ''
    const list = CREATORS.filter((c) => !keyword || c.canonical_name.includes(keyword))
    return response(config, ok({ creators: list, total: list.length, keyword: keyword || null, include_merged: false }))
  }
  const creatorsMatch = path.match(/^\/creators\/(\d+)$/)
  if (creatorsMatch) {
    const creator = CREATORS.find((c) => c.id === Number(creatorsMatch[1]))
    return creator ? response(config, ok(creator)) : response(config, fail(404, '达人不存在'))
  }

  // ---- 达人拓展 ----
  if (path === '/creator-candidates' && method === 'get') {
    const status = params.status || ''
    const list = candidatesStore()
    const filtered = status ? list.filter((c) => c.status === status) : list
    return response(config, ok({ candidates: filtered }))
  }
  if (path === '/creator-candidates' && method === 'post') {
    return response(config, fail(400, '演示模式：新增候选达人暂不可用，请在完整部署版使用'))
  }
  const candidateMatch = path.match(/^\/creator-candidates\/(\d+)$/)
  if (candidateMatch) {
    const candidate = candidatesStore().find((c) => c.id === Number(candidateMatch[1]))
    return candidate ? response(config, ok(candidate)) : response(config, fail(404, '候选达人不存在'))
  }
  const latestMatch = path.match(/^\/creator-candidates\/(\d+)\/recent-snapshots\/latest$/)
  if (latestMatch) {
    const candidate = candidatesStore().find((c) => c.id === Number(latestMatch[1]))
    const snap = store.snapshots.find((s) => s.candidate_id === Number(latestMatch[1]))
    if (!candidate) return response(config, fail(404, '候选达人不存在'))
    return response(config, ok({ snapshot: snap ? { ...snap, pricing: pricingForSnapshot(snap) } : null, candidate }))
  }
  const priceMatch = path.match(/^\/creator-candidates\/(\d+)\/price-reference$/)
  if (priceMatch) {
    const candidate = candidatesStore().find((c) => c.id === Number(priceMatch[1]))
    if (!candidate) return response(config, fail(404, '候选达人不存在'))
    const snap = store.snapshots.find((s) => s.candidate_id === Number(priceMatch[1]))
    const cases = store.cases.filter((c) => c.creator === candidate.name)
    return response(config, ok({
      candidate,
      snapshot: snap ? { ...snap, pricing: pricingForSnapshot(snap) } : null,
      historical_cases: cases,
      demo: true
    }))
  }
  const candDecisions = path.match(/^\/creator-candidates\/(\d+)\/decisions$/)
  if (candDecisions && method === 'get') {
    const candidate = candidatesStore().find((c) => c.id === Number(candDecisions[1]))
    const list = store.decisions.filter((d) => d.candidate_id === Number(candDecisions[1]))
    return response(config, ok({ creator: candidate?.name ?? null, creator_id: Number(candDecisions[1]), decisions: list }))
  }

  // ---- 决策 / 谈价 ----
  if (path === '/creator-decisions' && method === 'get') {
    if (params.creator_id) {
      const list = store.decisions.filter((d) => d.candidate_id === Number(params.creator_id))
      return response(config, ok({ creator: null, creator_id: Number(params.creator_id), decisions: list }))
    }
    if (params.creator) {
      const list = store.decisions.filter((d) => d.creator === params.creator)
      return response(config, ok({ creator: params.creator, creator_id: null, decisions: list }))
    }
    return response(config, fail(400, 'creator 不能为空'))
  }
  if (path === '/creator-decisions' && method === 'post') {
    return response(config, fail(400, '演示模式：新建决策暂不可用，请在完整部署版使用'))
  }
  const decisionsWithSuffix = path.match(/^\/creator-decisions\/(\d+)\/(void|outcome-candidates|outcome)$/)
  if (decisionsWithSuffix) {
    return response(config, fail(400, '演示模式：该决策操作暂不可用，请在完整部署版使用'))
  }
  if (path === '/creator-negotiation-cases' && method === 'get') {
    if (params.source_type) return response(config, ok({ cases: store.cases.filter((c) => c.source_type === params.source_type) }))
    if (params.record_id) return response(config, ok({ cases: store.cases.filter((c) => c.record_id === Number(params.record_id)) }))
    if (params.creator) return response(config, ok({ cases: store.cases.filter((c) => c.creator === params.creator) }))
    if (params.decision_id) return response(config, ok({ cases: [] }))
    return response(config, fail(400, 'creator / decision_id / record_id / source_type 至少提供一个'))
  }
  if (path === '/creator-negotiation-cases' && method === 'post') {
    return response(config, fail(400, '演示模式：新建谈价记录暂不可用，请在完整部署版使用'))
  }
  if (path === '/creator-negotiation-cases/historical-backfill') {
    return response(config, fail(400, '演示模式：历史补录暂不可用，请在完整部署版使用'))
  }

  // ---- 导入历史 ----
  if (path === '/import/batches') {
    const { list, total } = paginate([...store.batches].sort((a, b) => b.id - a.id), params)
    return response(config, ok({ list, total }))
  }
  const batchMatch = path.match(/^\/import\/batches\/(\d+)$/)
  if (batchMatch && method === 'get') {
    const batch = store.batches.find((b) => b.id === Number(batchMatch[1]))
    if (!batch) return response(config, fail(404, '导入批次不存在'))
    const records = store.batchRecords.filter((m) => m.batch_id === batch.id).map((m) => store.records.find((r) => r.id === m.record_id)).filter(Boolean)
    return response(config, ok({
      batch, records: records.map(withCpm), record_count: records.length, update_count: 0, updates: [],
      item_summary: { success: batch.success_count, fail: batch.fail_count, skip: batch.skip_count, duplicate: batch.duplicate_count }
    }))
  }
  const batchRollback = path.match(/^\/import\/batches\/(\d+)\/rollback$/)
  if (batchRollback) return response(config, fail(400, '演示模式：批次撤销暂不可用，请在完整部署版使用'))
  const batchDelete = path.match(/^\/import\/batches\/(\d+)$/)
  if (batchDelete && method === 'delete') {
    store.batches = store.batches.filter((b) => b.id !== Number(batchDelete[1]))
    return response(config, ok({ id: Number(batchDelete[1]) }))
  }

  // ---- 近期表现 / AI ----
  if (path === '/recent-snapshots/latest') {
    const snap = params.creator ? store.snapshots.find((s) => s.creator === params.creator) : null
    return response(config, ok({ snapshot: snap ? { ...snap, pricing: pricingForSnapshot(snap) } : null }))
  }
  if (path === '/recent-snapshots' && method === 'post') {
    return response(config, fail(400, '演示模式：截图识别暂不可用（不调用 AI 服务），请在完整部署版使用'))
  }
  if (path.startsWith('/ai/')) {
    return response(config, fail(400, '演示模式：AI 功能不可用（不调用外部 AI 服务）'))
  }

  return notFound()
}

let candidatesCache = null
function candidatesStore() {
  if (!candidatesCache) candidatesCache = store.candidates
  return candidatesCache
}

function recordEdit(recordId, field, before, after, source, groupId, isRow = false) {
  store.edits.push({
    id: store.edits.length + 1,
    record_id: recordId,
    action: isRow ? 'delete' : 'update',
    source,
    group_id: groupId,
    field_name: field,
    before_value: isRow ? before : before,
    after_value: after,
    created_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
  })
}

const creatorTypeOf = (nickname) => CREATORS.find((c) => c.canonical_name === nickname)?.creator_type || '未分类'
const creatorIdOf = (nickname) => CREATORS.find((c) => c.canonical_name === nickname)?.id ?? null

function response(config, body) {
  return Promise.resolve({ data: body, status: 200, statusText: 'OK', headers: {}, config })
}
