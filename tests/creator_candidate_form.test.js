#!/usr/bin/env node
// 候选达人表单回填映射 单元测试（纯函数）
//
// 运行方式：node tests/creator_candidate_form.test.js
// 特性：纯函数，不启动服务、不写数据库、不访问网络。
//
// 覆盖：编辑资料回填（含 null -> ''）、切换候选不串数据、xingtu_id 大整数 / 前导 0 原样保留、
//       不接受 legacy xingtu_url、星图 ID Modal 预填。
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

let passCount = 0
let failCount = 0
const failures = []

function check(label, cond, extra = '') {
  if (cond) {
    passCount += 1
    console.log(`PASS  ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    failCount += 1
    failures.push(`${label}${extra ? `  ${extra}` : ''}`)
    console.log(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}

async function main() {
  const mod = await import(
    pathToFileURL(path.join(root, 'frontend/src/utils/creatorCandidateForm.js')).href
  )
  const { buildCandidateEditValues, buildXingtuIdFormValues, applyCandidateEditValues, applyXingtuIdFormValues } = mod

  // 最小 Form 假实现：记录 resetFields / setFieldsValue 调用顺序，并支持 getFieldsValue
  const createFakeForm = () => ({
    values: {},
    calls: [],
    resetFields() {
      this.calls.push('reset')
      this.values = {}
      return this
    },
    setFieldsValue(next) {
      this.calls.push('set')
      this.values = { ...this.values, ...next }
      return this
    },
    getFieldsValue() {
      return this.values
    }
  })

  console.log('===== 1. 编辑资料回填 =====')
  const full = {
    id: 1,
    name: '样板达人09',
    creator_type: '科普',
    profile_url: 'https://v.douyin.com/tySIwmdgDL8/',
    xingtu_url: 'https://www.xingtu.cn/legacy',
    xingtu_id: '7663552982146875442',
    description: '有自己的话题点'
  }
  const values = buildCandidateEditValues(full)
  check('回填 name', values.name === '样板达人09')
  check('回填 creator_type', values.creator_type === '科普')
  check('回填 profile_url', values.profile_url === 'https://v.douyin.com/tySIwmdgDL8/')
  check('回填 xingtu_id', values.xingtu_id === '7663552982146875442')
  check('回填 description', values.description === '有自己的话题点')
  check('不回填 legacy xingtu_url', !('xingtu_url' in values))
  check('只输出 5 个字段', JSON.stringify(Object.keys(values).sort()) === JSON.stringify(['creator_type', 'description', 'name', 'profile_url', 'xingtu_id'].sort()))

  console.log('\n===== 2. null / 缺失 -> 空字符串（不覆盖已有非空值） =====')
  const blank = buildCandidateEditValues({ id: 2, name: '无资料', creator_type: null, profile_url: null, xingtu_id: null, description: null })
  check('null -> 空字符串', blank.creator_type === '' && blank.profile_url === '' && blank.xingtu_id === '' && blank.description === '')
  check('缺失字段 -> 空字符串', JSON.stringify(buildCandidateEditValues({})) === JSON.stringify({ name: '', creator_type: '', profile_url: '', xingtu_id: '', description: '' }))
  check('已有非空值不被覆盖', buildCandidateEditValues(full).description === '有自己的话题点')
  check('非对象输入安全降级', JSON.stringify(buildCandidateEditValues(null)) === JSON.stringify({ name: '', creator_type: '', profile_url: '', xingtu_id: '', description: '' }))

  console.log('\n===== 3. 切换候选不串数据 =====')
  const a = buildCandidateEditValues({ id: 1, name: 'A', creator_type: '美妆', profile_url: 'https://a', xingtu_id: '111', description: 'noteA' })
  const b = buildCandidateEditValues({ id: 2, name: 'B', creator_type: '数码', profile_url: 'https://b', xingtu_id: '222', description: 'noteB' })
  check('A / B 各自独立', a.name === 'A' && b.name === 'B' && a.xingtu_id === '111' && b.xingtu_id === '222')
  check('B 不残留 A 的值', b.description === 'noteB' && b.creator_type === '数码')

  console.log('\n===== 4. xingtu_id 大 ID / 前导 0 原样（字符串） =====')
  check('大整数 ID 原样保留', buildCandidateEditValues({ xingtu_id: '7663552982146875442' }).xingtu_id === '7663552982146875442')
  check('前导 0 保留', buildCandidateEditValues({ xingtu_id: '001234567890' }).xingtu_id === '001234567890')
  check('字符串 "0" 不被当作空值', buildCandidateEditValues({ xingtu_id: '0' }).xingtu_id === '0')
  check('类型仍是字符串', typeof buildCandidateEditValues({ xingtu_id: '7663552982146875442' }).xingtu_id === 'string')

  console.log('\n===== 5. 星图 ID Modal 预填 =====')
  check('预填当前 xingtu_id', buildXingtuIdFormValues({ xingtu_id: '7663552982146875442' }).xingtu_id === '7663552982146875442')
  check('无 ID -> 空字符串', buildXingtuIdFormValues({ xingtu_id: null }).xingtu_id === '')
  check('只输出 xingtu_id 一个字段', JSON.stringify(Object.keys(buildXingtuIdFormValues({}))) === JSON.stringify(['xingtu_id']))

  console.log('\n===== 6. Modal 打开完成后回填（真实值验证） =====')
  const sample = {
    id: 1,
    name: '样板达人09',
    creator_type: '科普',
    profile_url: 'https://example.com/a',
    xingtu_id: '7663552982146875442',
    description: '人工备注内容'
  }
  const fake = createFakeForm()
  applyCandidateEditValues(fake, sample)
  check(
    'getFieldsValue 得到完全相同的 5 项',
    JSON.stringify(fake.getFieldsValue()) === JSON.stringify({
      name: '样板达人09',
      creator_type: '科普',
      profile_url: 'https://example.com/a',
      xingtu_id: '7663552982146875442',
      description: '人工备注内容'
    }),
    JSON.stringify(fake.getFieldsValue())
  )
  check('回填前先 resetFields（清旧草稿 / 校验错误）', JSON.stringify(fake.calls) === JSON.stringify(['reset', 'set']))

  // A -> 关闭 -> B -> 打开：必须是 B，不串 A
  const A = { id: 1, name: 'A', creator_type: '美妆', profile_url: 'https://a', xingtu_id: '111', description: 'noteA' }
  const B = { id: 2, name: 'B', creator_type: '数码', profile_url: 'https://b', xingtu_id: '222', description: 'noteB' }
  const fake2 = createFakeForm()
  applyCandidateEditValues(fake2, A)
  applyCandidateEditValues(fake2, B) // 等价于关闭 A 后打开 B
  check('A → B：回填为 B，不残留 A', fake2.getFieldsValue().name === 'B' && fake2.getFieldsValue().xingtu_id === '222' && fake2.getFieldsValue().description === 'noteB')

  // 打开 -> 手工改但取消 -> 再打开：恢复库中的 A，而不是未保存草稿
  const fake3 = createFakeForm()
  applyCandidateEditValues(fake3, A)
  fake3.setFieldsValue({ name: '未保存草稿', xingtu_id: '999' }) // 用户改了但点了取消
  applyCandidateEditValues(fake3, A) // 再次打开
  check('取消后再次打开恢复数据库中的 A', fake3.getFieldsValue().name === 'A' && fake3.getFieldsValue().xingtu_id === '111')

  // 星图 ID Modal 预填（同一生命周期）
  const fakeX = createFakeForm()
  applyXingtuIdFormValues(fakeX, sample)
  check('星图 ID Modal 打开后预填当前 ID', fakeX.getFieldsValue().xingtu_id === '7663552982146875442')
  check('星图 ID 预填同样先 reset 再 set', JSON.stringify(fakeX.calls) === JSON.stringify(['reset', 'set']))
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    process.exitCode = 1
  })
  .finally(() => {
    const total = passCount + failCount
    const rate = total ? ((passCount / total) * 100).toFixed(1) : '0.0'
    console.log('\n================ 测试汇总 ================')
    console.log(`用例总数：${total}　通过：${passCount}　失败：${failCount}　通过率：${rate}%`)
    if (failCount > 0) {
      console.log('\n失败用例：')
      failures.forEach((item) => console.log(`  - ${item}`))
    }
    process.exitCode = failCount > 0 ? 1 : 0
  })
