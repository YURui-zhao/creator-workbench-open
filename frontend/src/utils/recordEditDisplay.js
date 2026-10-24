/**
 * Record Edit History V1 —— 编辑历史的展示层纯函数（不请求、不排序数据源、不修改审计）
 *
 * 语义：
 *   · null / undefined / 空字符串 → 「未填写」（缺失）
 *   · 0 → 显示 0（真实观测值，不与缺失混淆）
 *   · 其余按字符串原样展示（保留数字与字符串的区别，不做换算）
 */

export const RECORD_EDIT_FIELD_LABELS = {
  __row__: '整条记录',
  time_cycle: '时间周期',
  nickname: '达人昵称',
  creator_type: '达人类型',
  homepage: '达人主页',
  content_link: '植入链接',
  video_link: '视频链接',
  total_cost: '总花费（元）',
  first_play: '7日播放量',
  second_week_play: '累计播放量',
  publish_date: '发布日期'
}

export const RECORD_EDIT_SOURCE_LABELS = {
  manual_single: '手工编辑',
  manual_batch: '批量修改',
  manual_delete: '删除记录',
  batch_delete: '批量删除',
  import_rollback: '导入撤销删除',
  legacy_import_update: '旧版导入更新'
}

export const RECORD_EDIT_ACTION_LABELS = {
  update: '修改',
  delete: '删除'
}

/** 值展示：null / 空字符串 → 未填写；0 → 0；其余原样字符串化 */
export function formatRecordEditValue(value) {
  if (value === null || value === undefined) return '未填写'
  if (typeof value === 'string' && value.trim() === '') return '未填写'
  return String(value)
}

export function recordEditFieldLabel(fieldName) {
  return RECORD_EDIT_FIELD_LABELS[fieldName] || fieldName
}

export function recordEditSourceLabel(source) {
  return RECORD_EDIT_SOURCE_LABELS[source] || source
}

export function recordEditActionLabel(action) {
  return RECORD_EDIT_ACTION_LABELS[action] || action
}

/**
 * 把审计事件展开成展示行：
 *   · update 事件 → 一行（字段 / 前 / 后）
 *   · delete 事件 → 按删除快照逐字段展开（after 一律为「已删除」语义，由调用方渲染）
 * 输入顺序保持后端返回的事件顺序（id 倒序 = 最新在前）。
 */
export function buildRecordEditRows(edits = []) {
  const rows = []
  for (const edit of Array.isArray(edits) ? edits : []) {
    const when = String(edit.created_at || '').slice(0, 19)
    const source = recordEditSourceLabel(edit.source)
    if (edit.action === 'delete') {
      const snapshot =
        edit.before_value && typeof edit.before_value === 'object' ? edit.before_value : {}
      for (const [field, before] of Object.entries(snapshot)) {
        rows.push({
          key: `${edit.id}-${field}`,
          when,
          source,
          action: '删除',
          field: recordEditFieldLabel(field),
          before: formatRecordEditValue(before),
          after: '—'
        })
      }
      continue
    }
    rows.push({
      key: `${edit.id}-${edit.field_name}`,
      when,
      source,
      action: recordEditActionLabel(edit.action) || edit.action,
      field: recordEditFieldLabel(edit.field_name),
      before: formatRecordEditValue(edit.before_value),
      after: formatRecordEditValue(edit.after_value)
    })
  }
  return rows
}
