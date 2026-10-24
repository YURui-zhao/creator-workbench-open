/**
 * 达人对比工具（纯函数，便于单测）
 * 规则：至少 2 位、最多 5 位达人可对比
 */

export const COMPARE_MIN = 2
export const COMPARE_MAX = 5

/**
 * 是否满足对比条件
 * @param {number} count 已勾选达人数
 * @returns {{ ok: boolean, reason: string }} ok=false 时 reason 为提示文案
 */
export function canCompareCreators(count) {
  const total = Number(count) || 0
  if (total < COMPARE_MIN) {
    return { ok: false, reason: `请至少选择 ${COMPARE_MIN} 位达人进行对比` }
  }
  if (total > COMPARE_MAX) {
    return { ok: false, reason: `最多支持对比 ${COMPARE_MAX} 位达人，请减少选择` }
  }
  return { ok: true, reason: '' }
}

/**
 * 构造对比数据：按勾选顺序取达人，最终按总花费降序排列
 * @param {Array<Object>} creators 全量达人统计（接口返回）
 * @param {string[]} selectedNames 勾选的达人昵称
 * @returns {Array<Object>} 对比用行数据
 */
/**
 * Creator Identity V1 Phase 5：Creator 行身份键。
 * 冻结规则（P5 Integration §2）：
 *   · creator_id 存在            → `id:<creator_id>`（唯一身份，同名不同人绝不合并）
 *   · identityMode 且无 creator_id → `invalid:<index>`（**契约破坏**：新 schema 下不该发生；
 *     用稳定无效键，绝不静默把 canonical_name/nickname 当身份，两个同名行也绝不合并）
 *   · 非 identityMode 且无 creator_id → `name:<显示名>`（老 schema：根本没有 creator_id 能力，旧行为）
 * @param {Object} item 行数据
 * @param {number} [index] 行在 dataSource 中的下标（仅 invalid 分支用于区分多行）
 * @param {boolean} [identityMode] 后端是否处于身份模式
 */
export const creatorIdentityKey = (item, index, identityMode = false) => {
  if (item?.creator_id !== null && item?.creator_id !== undefined) return `id:${item.creator_id}`
  const displayName = item?.canonical_name || item?.nickname || ''
  if (identityMode) return `invalid:${Number.isInteger(index) ? index : 'x'}:${displayName}`
  return `name:${displayName}`
}

/** 显示名：Creator 权威名优先（identity 模式），nickname 仅为兼容别名 */
export const creatorDisplayName = (item) => item?.canonical_name || item?.nickname || '未命名达人'

/**
 * 构造对比数据：按勾选顺序取达人，最终按总花费降序排列。
 * identity 模式下缺少 creator_id 的行一律跳过（见 creatorIdentityKey 的 invalid 分支），
 * 绝不允许两个同名行因名称键相同而被合并成一条对比数据。
 * @param {Array<Object>} creators 全量达人统计（接口返回）
 * @param {string[]} selectedKeys 勾选的行身份键
 * @param {boolean} [identityMode] 后端是否处于身份模式
 * @returns {Array<Object>} 对比用行数据
 */
export function buildCompareRows(creators = [], selectedKeys = [], identityMode = false) {
  const keySet = new Set(selectedKeys)
  return (Array.isArray(creators) ? creators : [])
    .filter((item) => {
      // identity 模式：无归属锚的行不参与对比（绝不把同名 Creator 合并）
      if (identityMode && (item?.creator_id === null || item?.creator_id === undefined)) return false
      return keySet.has(creatorIdentityKey(item, undefined, identityMode))
    })
    .map((item, index) => ({ ...item, __index: index }))
    .sort((a, b) => b.total_cost - a.total_cost || a.__index - b.__index)
    .map(({ __index, ...rest }) => rest)
}
