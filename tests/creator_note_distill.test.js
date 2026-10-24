#!/usr/bin/env node
// Creator Decision Playbook V0.1 - Phase 2.1 人工备注 AI 整理 + 星图链接 回归测试
//
// 运行方式：node tests/creator_note_distill.test.js
// 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
// 网络：拦截 http/https/net/tls/fetch —— 测试全程离线（AI 调用用注入的假函数）。

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-note-distill-'))
process.env.WORKBENCH_DB_PATH = path.join(TMP_DIR, 'isolated.db')

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

function forbidNetwork() {
  const blocked = []
  const replacements = [
    [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'], [tls, 'connect']
  ]
  const originals = replacements.map(([target, method]) => [target, method, target[method]])
  for (const [target, method] of replacements) {
    target[method] = () => {
      blocked.push(method)
      throw new Error('distill test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('distill test forbids network requests')
  }
  return {
    blocked,
    restore() {
      for (const [target, method, original] of originals) target[method] = original
      global.fetch = originalFetch
    }
  }
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    }
  }
}

async function main() {
  const networkGuard = forbidNetwork()
  const savedEnv = { deepseek: process.env.DEEPSEEK_API_KEY, zhipu: process.env.ZHIPU_API_KEY }
  try {
    const ai = await import(pathToFileURL(path.join(root, 'backend/routes/ai.js')).href)
    const candidates = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorCandidates.js')).href
    )
    const rules = await import(
      pathToFileURL(path.join(root, 'frontend/src/utils/creatorPlaybookRules.js')).href
    )
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

    const aiRouter = ai.default
    const candidateRouter = candidates.default
    const findHandler = (router, routePath, method) => {
      const layer = router.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const callRoute = async (handler, { body = {}, query = {}, params = {}, headers = {} } = {}) => {
      const res = response()
      await handler({ body, query, params, headers }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    const distillRoute = findHandler(aiRouter, '/distill-creator-note', 'post')
    const createCandidate = findHandler(candidateRouter, '/', 'post')
    const saveCandidateSnapshot = findHandler(candidateRouter, '/:id/recent-snapshots', 'post')

    console.log('===== 1. distillCreatorNote：只发送 description + 固定 system prompt =====')
    const fixedPrompt = ai.buildDistillSystemPrompt()
    check('system prompt 是固定常量（无入参插值）', typeof fixedPrompt === 'string' && fixedPrompt.length > 0 && fixedPrompt === ai.buildDistillSystemPrompt())
    let spy = null
    const fakeCall = (systemPrompt, userContent, options) => {
      spy = { systemPrompt, userContent, options }
      return Promise.resolve(JSON.stringify({ points: ['人工备注认为商单播放约 50 万', '人工备注判断价格相对实惠'] }))
    }
    const distilled = await ai.distillCreatorNote('商单保证50w，价格很便宜', fakeCall, { provider: 'deepseek', model: 'any', apiKey: 'k' })
    check('用户输入只包含 description（无其它业务数据）', spy.userContent === '商单保证50w，价格很便宜', JSON.stringify(spy.userContent))
    check('system prompt 始终取固定值（不接受任意 system prompt）', spy.systemPrompt === fixedPrompt)
    check('返回 points + text', distilled.points.length === 2 && distilled.text === distilled.points.join('\n'))
    check('AI 整理保留来源限定（不升级为确定事实）', /人工备注/.test(distilled.text))

    console.log('\n===== 2. parseDistillResult 边界 =====')
    check('解析合法 JSON', ai.parseDistillResult('{"points":["a","b"]}').points.length === 2)
    check('兼容 Markdown 代码块', ai.parseDistillResult('```json\n{"points":["a"]}\n```').points.length === 1)
    check('最多保留 5 个要点', ai.parseDistillResult(JSON.stringify({ points: ['1', '2', '3', '4', '5', '6', '7'] })).points.length === 5)
    check('过滤空要点', ai.parseDistillResult('{"points":["a","","  ","b"]}').points.length === 2)
    let threwNonJson = false
    try { ai.parseDistillResult('not json at all') } catch { threwNonJson = true }
    check('非 JSON 抛错（不猜测修复）', threwNonJson)
    let threwEmpty = false
    try { ai.parseDistillResult('{"points":[]}') } catch { threwEmpty = true }
    check('空要点抛错', threwEmpty)

    console.log('\n===== 3. 路由校验与 AI 不可用 =====')
    check('缺少 description -> 400', (await callRoute(distillRoute, { body: {} })).status === 400)
    check('description 为空串 -> 400', (await callRoute(distillRoute, { body: { description: '   ' } })).status === 400)
    check('description 超长 -> 400', (await callRoute(distillRoute, { body: { description: 'x'.repeat(2001) } })).status === 400)

    // 模拟 AI 未连接：清掉环境变量，且不带用户 Key
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.ZHIPU_API_KEY
    const aiUnavailable = await callRoute(distillRoute, { body: { description: '任意备注' } })
    check('AI 未连接 -> 明确 4xx 错误（不是 500）', aiUnavailable.status === 400, `${aiUnavailable.status} ${aiUnavailable.msg}`)
    check('AI 未连接错误提示包含 API Key 指引', /API Key/.test(String(aiUnavailable.msg)))

    console.log('\n===== 4. AI 未连接时其它能力全部正常（非 blocker） =====')
    const cand = await callRoute(createCandidate, { body: { name: '离线候选', description: '人工备注原文' } })
    check('AI 未连接仍可创建 candidate', cand.status === 200 && Boolean(cand.data?.id))
    const snap = await callRoute(saveCandidateSnapshot, {
      params: { id: String(cand.data.id) },
      body: { observed_at: '2026-09-29', plays: [{ raw_text: '5万', excluded: false, position_index: 1 }, { raw_text: '6万', excluded: false, position_index: 2 }] }
    })
    check('AI 未连接仍可保存 candidate snapshot', snap.status === 200)
    const assessment = rules.buildCreatorPlaybookAssessment({ median_play: 55000, plays: [{ normalized_play: 55000, excluded: false }] })
    check('AI 未连接 Rule Engine 仍正常', assessment.scale.code === 'base' && assessment.metrics.medianPlay === 55000)

    console.log('\n===== 5. AI 结果不自动写库 / 失败不污染 candidate =====')
    const beforeRow = db.prepare('SELECT * FROM creator_candidates WHERE id = ?').get(cand.data.id)
    // AI 失败后 candidate 数据不变
    await callRoute(distillRoute, { body: { description: '人工备注原文' } })
    const afterFailRow = db.prepare('SELECT * FROM creator_candidates WHERE id = ?').get(cand.data.id)
    check('AI 失败：description 不丢失', afterFailRow.description === '人工备注原文')
    check('AI 失败：candidate 行完全未变', JSON.stringify(afterFailRow) === JSON.stringify(beforeRow))
    // 成功整理（离线注入）也不会自动写库
    await ai.distillCreatorNote('人工备注原文', fakeCall, { provider: 'deepseek' })
    const afterDistillRow = db.prepare('SELECT * FROM creator_candidates WHERE id = ?').get(cand.data.id)
    check('AI 输出不会自动写 candidate（distilled_description 仍为 null）', afterDistillRow.distilled_description === null)

    console.log('\n===== 6. 数据边界（源码级） =====')
    const aiSource = fs.readFileSync(path.join(root, 'backend/routes/ai.js'), 'utf8')
    const routeSource = aiSource.slice(aiSource.indexOf('router.post(\'/distill-creator-note\''))
    check(
      'distill 路由不访问数据库（无 db.prepare / SQL / db 模块）',
      !/db\.prepare|better-sqlite3|from '\.\.\/db\.js'|INSERT\s+INTO|SELECT[\s\S]{0,40}FROM/i.test(routeSource)
    )
    check('distill 不接受任意 system prompt（不读取 body.system*）', !/body\.system|system_prompt|systemPrompt\s*[:=]\s*body/i.test(routeSource))
    check('ai.js 未引入数据库模块', !/from '\.\.\/db\.js'/.test(aiSource))
    check('未发生任何外部网络请求', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))
    check('隔离库位于临时目录（未触碰真实 workbench.db）', process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir()))
  } finally {
    if (savedEnv.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = savedEnv.deepseek
    if (savedEnv.zhipu === undefined) delete process.env.ZHIPU_API_KEY
    else process.env.ZHIPU_API_KEY = savedEnv.zhipu
    networkGuard.restore()
  }
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    process.exitCode = 1
  })
  .finally(() => {
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true })
    } catch {
      // 清理失败不影响测试结论
    }
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
