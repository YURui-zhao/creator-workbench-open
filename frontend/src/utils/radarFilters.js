/**
 * 复投雷达检索（V3-alpha.2 B2，纯函数，只做视图过滤）
 *
 * 原则：
 *   · 只缩小可见范围，绝不重算业务规则：不重新计算 CPM / 中位数 / historical_status / work_priority
 *   · 过滤后保持后端给出的原有相对顺序（Array.filter 不改变顺序）
 *   · 不写数据库、不调用网络 / AI
 *   · 原始分组数量（group.count 与 summary）始终代表全量数据，不被过滤改写
 */

/** 大组选项：直接使用后端已有的 group key，不在前端推导 historical_status */
export const RADAR_GROUP_OPTIONS = [
  { value: 'all', label: '全部分组' },
  { value: 'priority', label: '优先关注' },
  { value: 'watch', label: '需要观察' },
  { value: 'low_priority', label: '暂不优先' }
]

/**
 * 工作优先级选项：直接使用后端 work_priority 枚举，前端不重算 10 / 20 / 100。
 * 选项文案只表达「优先级等级」（work_priority），不表达具体原因（work_priority_reason）——
 * 例如 high_attention 既可能是「单样本 CPM ≤ 10」，也可能是「多样本历史通过」，
 * 因此这里不能写成「单次表现突出」这类 reason 文案；行内 Tag 才表达具体原因。
 */
export const WORK_PRIORITY_FILTER_OPTIONS = [
  { value: 'all', label: '全部优先级' },
  { value: 'high_attention', label: '高注意力' },
  { value: 'medium_attention', label: '中注意力' },
  { value: 'normal_attention', label: '普通' },
  { value: 'low_priority', label: '低优先' }
]

export const EMPTY_RADAR_FILTERS = { keyword: '', groupKey: 'all', workPriority: 'all' }

/** 关键词归一化：去首尾空格 + 小写（中文按原字符串匹配，不做任何转换） */
export function normalizeKeyword(value) {
  return String(value ?? '').trim().toLowerCase()
}

/** 达人名称包含匹配（大小写不敏感；空关键词视为不过滤） */
export function matchesKeyword(creator, keyword) {
  const needle = normalizeKeyword(keyword)
  if (!needle) return true
  return String(creator ?? '').toLowerCase().includes(needle)
}

/** 是否处于「有筛选」状态（用于显示清空按钮与结果数量） */
export function isRadarFilterActive({ keyword = '', groupKey = 'all', workPriority = 'all' } = {}) {
  return normalizeKeyword(keyword) !== '' || groupKey !== 'all' || workPriority !== 'all'
}

/**
 * 组合过滤（AND）：大组 → 关键词 → 工作优先级
 * @param {Array<{key: string, label: string, count: number, creators: Array}>} groups 后端返回的 groups
 * @param {{ keyword?: string, groupKey?: string, workPriority?: string }} filters
 * @returns {{ groups: Array, visibleCount: number }} 过滤后的分组（保留原顺序）与可见达人总数
 */
export function filterRadarGroups(groups = [], { keyword = '', groupKey = 'all', workPriority = 'all' } = {}) {
  const list = Array.isArray(groups) ? groups : []
  let visibleCount = 0
  const filtered = list
    .filter((group) => groupKey === 'all' || group?.key === groupKey)
    .map((group) => {
      const creators = (Array.isArray(group?.creators) ? group.creators : []).filter(
        (item) =>
          matchesKeyword(item?.creator, keyword) &&
          (workPriority === 'all' || item?.work_priority === workPriority)
      )
      visibleCount += creators.length
      return {
        ...group,
        creators,
        // count 保持后端原始分组数量（全量口径）；matched_count 才是过滤后数量
        matched_count: creators.length
      }
    })
  return { groups: filtered, visibleCount }
}
