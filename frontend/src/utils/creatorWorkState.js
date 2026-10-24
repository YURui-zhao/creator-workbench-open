// Creator Work State（达人拓展）—— 纯 UI 映射 / 过滤 / 计数
//
// Phase 3 起数据源变化（重要）：
//   · Work State **唯一来源** = 服务端 `candidate.work_state`（advancing | observing | paused）
//     服务端派生规则：candidate_work_state_events 最新一条（created_at DESC, id DESC）；
//     无事件 → 默认 advancing（返回层派生，不写库）。
//   · 前端**不再**从 creator_decisions(candidate_review) 派生 Work State，
//     也不再逐 candidate 拉 decisions（旧 contact/observe/hold → 服务端 legacy 兼容层负责）。
//
// 本模块仍是纯函数：无时间 / 无随机 / 无网络 / 无 AI / 不写库。
// 语义边界不变：
//   Work State ≠ Collaboration Stage Decision
//   post_quote（proceed / small_test / negotiate / pause）永不参与 Work State；
//   candidate.status（active / archived）永不参与 Work State。

// 服务端 state（workflow-neutral）→ UI 标签
export const WORK_STATE_VALUES = ['advancing', 'observing', 'paused']

export const WORK_STATE_LABELS = {
  advancing: '推进中',
  observing: '观察中',
  paused: '暂缓池'
}

export const WORK_STATE_OPTIONS = [
  { value: 'advancing', label: WORK_STATE_LABELS.advancing },
  { value: 'observing', label: WORK_STATE_LABELS.observing },
  { value: 'paused', label: WORK_STATE_LABELS.paused }
]

// 列表 Tag 颜色（弱化视觉噪音）
export const WORK_STATE_TAG_COLORS = { advancing: 'blue', observing: 'gold', paused: 'default' }

// 服务端保证一定返回 work_state；缺失时（老响应/异常数据）按产品默认 advancing
export const DEFAULT_WORK_STATE = 'advancing'

// 列表筛选：全部 + 三个工作盒子（单选，互斥）
export const WORK_STATE_FILTER_ALL = 'all'
export const WORK_STATE_FILTER_OPTIONS = [
  { value: WORK_STATE_FILTER_ALL, label: '全部' },
  ...WORK_STATE_OPTIONS
]

const toText = (value) => (value === null || value === undefined ? '' : String(value))

/** 单个 candidate 的 Work State 原始值（服务端值优先；非法/缺失 → 默认 advancing） */
export function workStateValueOf(candidate) {
  const raw = toText(candidate?.work_state)
  return WORK_STATE_VALUES.includes(raw) ? raw : DEFAULT_WORK_STATE
}

/** 单个 candidate 的 Work State（{ value, label }） */
export function workStateOf(candidate) {
  const value = workStateValueOf(candidate)
  return { value, label: WORK_STATE_LABELS[value] }
}

/**
 * 列表过滤：名称 substring（大小写不敏感） + 三个工作盒子（单选互斥）。
 * 保持输入顺序；不排序、不改写 candidate，也不做任何昵称合并 / 猜测。
 */
export function filterCandidates({ candidates = [], keyword = '', workState = WORK_STATE_FILTER_ALL } = {}) {
  const needle = toText(keyword).trim().toLowerCase()
  const list = Array.isArray(candidates) ? candidates : []
  return list.filter((item) => {
    if (!item) return false
    if (needle && !toText(item.name).toLowerCase().includes(needle)) return false
    if (workState === WORK_STATE_FILTER_ALL || workState === '' || workState === null || workState === undefined) {
      return true
    }
    if (!WORK_STATE_VALUES.includes(workState)) return true
    return workStateValueOf(item) === workState
  })
}

/** 四个筛选入口的数量（全部 = 输入条数）；只用于按钮计数，不改变筛选语义 */
export function summarizeWorkStates(candidates = []) {
  const counts = { [WORK_STATE_FILTER_ALL]: 0, advancing: 0, observing: 0, paused: 0 }
  for (const item of Array.isArray(candidates) ? candidates : []) {
    if (!item) continue
    counts[WORK_STATE_FILTER_ALL] += 1
    counts[workStateValueOf(item)] += 1
  }
  return counts
}

/**
 * 已关联合作记录：只使用「outcome 显式关联」的 decision，每轮独立展示。
 * 与 Work State 无关（属当前合作区块），因此仍从 decisions 读取。
 */
export function buildLinkedCollaborationRecords(decisions = []) {
  const rows = Array.isArray(decisions) ? decisions : []
  return rows
    .filter((item) => item && item.outcome && (item.outcome.record_id ?? item.outcome.record?.id))
    .map((item) => ({
      decision: item,
      record: item.outcome.record ?? item.outcome
    }))
}
