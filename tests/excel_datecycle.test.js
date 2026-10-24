#!/usr/bin/env node
/**
 * Excel 导入「时间周期」回归测试
 *
 * 运行方式：node tests/excel_datecycle.test.js
 * 特性：不连数据库、不启动服务、不发起真实 AI 请求
 *   - 本地解析：直接调用 frontend/src/utils/dateCycle.js
 *   - AI 结果解析 / 缓存：内存态驱动 backend/routes/ai.js 的路由 handler（用假 axios adapter 拦截外部请求）
 */
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')
const requireFromBackend = createRequire(path.join(REPO_ROOT, 'backend', 'package.json'))

let passCount = 0
let failCount = 0
const failures = []

function check(group, label, cond, extra = '') {
  if (cond) {
    passCount += 1
    console.log(`PASS  [${group}] ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    failCount += 1
    failures.push(`[${group}] ${label}${extra ? `  ${extra}` : ''}`)
    console.log(`FAIL  [${group}] ${label}${extra ? `  ${extra}` : ''}`)
  }
}

function section(title) {
  console.log(`\n===== ${title} =====`)
}

// 极简 res 模拟：满足路由内 ok()/fail() 的调用（res.json / res.status）
function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.payload = body
      return this
    },
    setHeader() {},
    send() {}
  }
}

async function main() {
  const dateCycle = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/dateCycle.js')).href
  )
  const { parseTimeCycleToWeekCode, explainTimeCycle } = dateCycle

  // 2026 自然周基准：W32=08/10-08/16、W33=08/17-08/23、W35=08/31-09/06、W52=12/28-2027/01/03
  section('1. 本地解析正向用例（含本次新增容错格式）')
  const positiveCases = [
    ['8\u201117~8\u201123', '2026-W33', '非断行连字符(U+2011)+波浪线'],
    ['8.17-8.23', '2026-W33', '点号区间'],
    ['0817-0823', '2026-W33', 'MMDD-MMDD'],
    ['8月17-23日', '2026-W33', '同月简写'],
    ['２０２６-０８-１７～２０２６-０８-２３', '2026-W33', '全角数字+全角波浪线'],
    ['第33周', '2026-W33', '中文周数'],
    ['W33', '2026-W33', '周数简写'],
    ['2026-W33', '2026-W33', '标准周码'],
    ['8/17-8/23', '2026-W33', '斜杠区间'],
    ['8/31-9/6', '2026-W35', '跨月区间'],
    ['12/28-1/3', '2026-W52', '跨年区间'],
    // 原有能力回归
    ['8-17~8-23', '2026-W33', '短横线+波浪线'],
    ['8-17-8-23', '2026-W33', '四段短横线'],
    ['8月17日-23日', '2026-W33', '同月简写（带日）'],
    ['2026年8月17日至23日', '2026-W33', '带年份同月简写'],
    ['2026-08-17~2026-08-23', '2026-W33', 'ISO 波浪线'],
    ['2026-08-17至2026-08-23', '2026-W33', 'ISO 至'],
    ['2026-08-17', '2026-W33', '单日期（周一）'],
    ['2026-08-19', '2026-W33', '单日期（周三，取所在周）']
  ]
  for (const [input, expected, label] of positiveCases) {
    const got = parseTimeCycleToWeekCode(input)
    check('本地解析', `${label}：${JSON.stringify(input)} -> ${expected}`, got === expected, got === expected ? '' : `实际 ${got}`)
  }

  section('2. 本地解析反向用例（应拒绝且给出具体原因）')
  const negativeCases = [
    ['8-18~8-22', '非完整自然周（周三~周日）', '不是周一'],
    ['乱码文本XYZ', '乱码无效文本', '无法识别'],
    ['', '空串', '为空'],
    ['2026-W99', '周数越界', '周数非法'],
    ['2026-W53', '该年份无第 53 周', '周数非法'],
    ['2月30日-3月5日', '非法日期', '日期非法']
  ]
  for (const [input, label, reasonKeyword] of negativeCases) {
    const got = parseTimeCycleToWeekCode(input)
    const { reason } = explainTimeCycle(input)
    check('本地反向', `${label}：${JSON.stringify(input)} 被拒绝`, got === null, got === null ? '' : `实际 ${got}`)
    check('本地反向', `${label}：返回具体失败原因`, Boolean(reason) && reason.includes(reasonKeyword), reason)
  }

  section('3. AI 结果解析用例（applyAiNormalizeResults）')
  // 注意：必须在导入后端 AI 模块之前替换 axios adapter
  // （backend/services/deepseek.js 在模块加载时就 axios.create()，之后改 defaults 不会再生效）
  // 另：axios 的 CJS 入口（require）与 ESM 入口（import）是两个不同实例，
  // deepseek.js 用的是 `import axios from 'axios'`（ESM 入口），因此这里必须替换 ESM 实例
  const axiosPkgDir = path.dirname(requireFromBackend.resolve('axios/package.json'))
  const axios = (await import(pathToFileURL(path.join(axiosPkgDir, 'index.js')).href)).default
  const originalAdapter = axios.defaults.adapter
  let aiCallCount = 0
  let lastPrompt = ''
  axios.defaults.adapter = async (config) => {
    aiCallCount += 1
    const payload = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
    lastPrompt = payload?.messages?.[0]?.content || ''
    const values = JSON.parse(payload?.messages?.[1]?.content || '[]')
    const map = {}
    for (const value of values) {
      map[value] = value === 'W33' ? '08/17-08/23' : 'ERROR:无法解析该时间周期写法，请核对是否包含有效日期'
    }
    return {
      data: {
        choices: [{ message: { role: 'assistant', content: JSON.stringify(map) } }],
        usage: {}
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config
    }
  }

  let aiModule
  try {
    aiModule = await import(pathToFileURL(path.join(REPO_ROOT, 'backend/routes/ai.js')).href)
  } catch (error) {
    axios.defaults.adapter = originalAdapter
    throw error
  }
  const { applyAiNormalizeResults, buildNormalizePrompt } = aiModule

  const standard = applyAiNormalizeResults(['W33'], { W33: '08/17-08/23' })[0]
  check('AI结果', '标准输出 MM/DD-MM/DD -> 周码', standard.weekCode === '2026-W33' && standard.error === null, JSON.stringify(standard))

  const codeOutput = applyAiNormalizeResults(['W33'], { W33: '2026-W33' })[0]
  check('AI结果', '兼容 AI 直接输出周码', codeOutput.weekCode === '2026-W33' && codeOutput.error === null)

  const alignedOutput = applyAiNormalizeResults(['8-13~8-19'], { '8-13~8-19': '08/10-08/16' })[0]
  check('AI结果', 'AI 对齐到所在自然周（08/10-08/16 -> W32）', alignedOutput.weekCode === '2026-W32', JSON.stringify(alignedOutput))

  const errorOutput = applyAiNormalizeResults(['8-18~8-22'], {
    '8-18~8-22': 'ERROR:输入日期不属于完整自然周，请核对时间周期'
  })[0]
  check(
    'AI结果',
    'ERROR 前缀原因原样透传',
    errorOutput.weekCode === null && errorOutput.error === '输入日期不属于完整自然周，请核对时间周期',
    JSON.stringify(errorOutput)
  )

  const errorCn = applyAiNormalizeResults(['x'], { x: 'ERROR：中文冒号原因' })[0]
  check('AI结果', 'ERROR：中文冒号同样支持', errorCn.error === '中文冒号原因')

  const illegalRange = applyAiNormalizeResults(['坏输出'], { 坏输出: '08/17-08/17' })[0]
  check(
    'AI结果',
    '非法输出（非完整自然周）被拦截',
    illegalRange.weekCode === null && illegalRange.error.startsWith('AI 输出的内容不是合法自然周'),
    JSON.stringify(illegalRange)
  )

  const illegalCode = applyAiNormalizeResults(['坏周码'], { 坏周码: '2026-W99' })[0]
  check('AI结果', '非法周码输出被拦截', illegalCode.weekCode === null && Boolean(illegalCode.error), JSON.stringify(illegalCode))

  const missing = applyAiNormalizeResults(['未返回'], {})[0]
  check('AI结果', 'AI 未返回该键时给出提示', missing.weekCode === null && missing.error === 'AI 未返回识别结果')

  const blank = applyAiNormalizeResults(['空值'], { 空值: '   ' })[0]
  check('AI结果', '空字符串视为未返回', blank.error === 'AI 未返回识别结果')

  const prompt = buildNormalizePrompt(['W33'], 2026)
  check(
    'AI提示词',
    '要求 MM/DD-MM/DD 输出 + ERROR 契约 + 自然周对齐',
    prompt.includes('只输出 MM/DD-MM/DD') &&
      prompt.includes('ERROR:具体原因') &&
      prompt.includes('落在哪个自然周')
  )
  check(
    'AI提示词',
    '覆盖本次业务样例（8‑13~8‑19 / 8.13-8.19 / 8月13-19日 / 0813-0819）',
    ['8\u201113~8\u201119', '8.13-8.19', '8月13-19日', '0813-0819'].every((s) => prompt.includes(s))
  )

  section('4. 缓存逻辑（内存态驱动真实路由 handler，不启服务）')
  const router = aiModule.default
  const layer = router.stack.find((item) => item.route && item.route.path === '/normalize-time-cycles')
  check('缓存', '路由 /normalize-time-cycles 已注册', Boolean(layer))
  const handler = layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
  check('缓存', '可获取到 handler（内存态调用）', typeof handler === 'function')

  try {
    const headers = { 'x-ai-api-key': 'sk-sandbox-test-1234567890' }
    const res1 = createRes()
    await handler({ headers, body: { values: ['W33', '乱码X'] } }, res1)
    const firstCall = aiCallCount
    check('缓存', '首次调用触发 1 次 AI 请求', firstCall === 1, `aiCallCount=${firstCall}`)
    const firstData = res1.payload?.data || []
    const firstOk = firstData.find((item) => item.value === 'W33')
    const firstErr = firstData.find((item) => item.value === '乱码X')
    check('缓存', '首次：成功值返回周码', firstOk?.weekCode === '2026-W33' && firstOk?.error === null, JSON.stringify(firstOk))
    check('缓存', '首次：失败值返回 ERROR 原因', firstErr?.weekCode === null && String(firstErr?.error).includes('无法解析'), JSON.stringify(firstErr))

    const res2 = createRes()
    await handler({ headers, body: { values: ['W33', '乱码X'] } }, res2)
    const totalCalls = aiCallCount
    check('缓存', '二次调用：成功值命中缓存不再请求 AI（仅失败值重试）', totalCalls === firstCall + 1, `aiCallCount=${totalCalls}`)
    const secondData = res2.payload?.data || []
    const secondOk = secondData.find((item) => item.value === 'W33')
    const secondErr = secondData.find((item) => item.value === '乱码X')
    check('缓存', '二次：缓存命中值仍返回正确周码且 error 为空', secondOk?.weekCode === '2026-W33' && secondOk?.error === null, JSON.stringify(secondOk))
    check('缓存', '二次：失败值仍返回完整失败原因（未被缓存吞掉）', String(secondErr?.error).includes('无法解析'), JSON.stringify(secondErr))

    const res3 = createRes()
    await handler({ headers, body: { values: ['W33'] } }, res3)
    check('缓存', '全部命中缓存时不请求 AI', aiCallCount === totalCalls, `aiCallCount=${aiCallCount}`)

    check('缓存', '调用 AI 时使用归一化提示词', lastPrompt.includes('归一化助手') && lastPrompt.includes('只输出 MM/DD-MM/DD'))
  } finally {
    axios.defaults.adapter = originalAdapter
  }

  const total = passCount + failCount
  const rate = total ? ((passCount / total) * 100).toFixed(1) : '0.0'
  console.log(`\n================ 测试汇总 ================`)
  console.log(`用例总数：${total}　通过：${passCount}　失败：${failCount}　通过率：${rate}%`)
  if (failCount > 0) {
    console.log('\n失败用例：')
    failures.forEach((item) => console.log(` - ${item}`))
  }
  process.exitCode = failCount > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('测试执行异常：', error)
  process.exitCode = 1
})
