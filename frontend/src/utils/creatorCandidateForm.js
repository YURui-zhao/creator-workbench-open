// 候选达人表单回填映射（纯函数）
//
// 用途：打开「编辑资料」/「更新星图 ID」时，把当前 candidate 的已有资料映射为表单初值。
// 规则：
//   · 只做 null/undefined -> ''（表单表现），绝不改写已有非空值
//   · xingtu_id 始终按字符串处理（绝不 Number / parseInt，保留大整数与前导 0）
//   · 不接受、也不输出 legacy xingtu_url（前台已不再编辑该字段）

export function buildCandidateEditValues(candidate = {}) {
  const source = candidate && typeof candidate === 'object' ? candidate : {}
  return {
    name: source.name ?? '',
    creator_type: source.creator_type ?? '',
    profile_url: source.profile_url ?? '',
    xingtu_id: source.xingtu_id ?? '',
    description: source.description ?? ''
  }
}

export function buildXingtuIdFormValues(candidate = {}) {
  const source = candidate && typeof candidate === 'object' ? candidate : {}
  return { xingtu_id: source.xingtu_id ?? '' }
}

// 把「编辑资料」回填到表单实例：先清掉旧草稿 / 校验错误，再写入当前 candidate 的真实资料。
// 必须在 Modal 真正打开完成（Form 已挂载）后调用（afterOpenChange），否则赋值会被丢弃。
export function applyCandidateEditValues(form, candidate) {
  const values = buildCandidateEditValues(candidate)
  if (form && typeof form.resetFields === 'function') form.resetFields()
  if (form && typeof form.setFieldsValue === 'function') form.setFieldsValue(values)
  return values
}

// 同上，用于「更新星图 ID」轻量 Modal
export function applyXingtuIdFormValues(form, candidate) {
  const values = buildXingtuIdFormValues(candidate)
  if (form && typeof form.resetFields === 'function') form.resetFields()
  if (form && typeof form.setFieldsValue === 'function') form.setFieldsValue(values)
  return values
}
