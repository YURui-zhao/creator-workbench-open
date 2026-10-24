#!/usr/bin/env node
/**
 * 近期表现助手（V3-alpha P2A）回归测试
 *
 * 运行方式：node tests/screenshot_extract.test.js
 * 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），测试结束删除。
 * 网络：拦截 http/https/net/tls/fetch，并注入 axios 假 adapter；绝不触达真实 Provider。
 *
 * 覆盖：显式触发、并发保护、类型/数量/体积校验、确定性数字换算（前后端 parity）、
 *      不猜造/不补足、人工修改覆盖、排除/恢复统计、多图顺序、Key/base64 不外泄、只读与安全边界。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const frontend = path.join(root, 'frontend/src')
const requireFromBackend = createRequire(path.join(root, 'backend/package.json'))

// —— 隔离数据库：必须在 import backend/db.js 之前设置
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-extract-'))
process.env.WORKBENCH_DB_PATH = path.join(TMP_DIR, 'isolated.db')

const fakeKey = 'test-only-vision-key-987654321'
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
      blocked.push(`${method}`)
      throw new Error('P2A test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('P2A test forbids network requests')
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
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
}

function section(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0 && to > from, `UI section missing: ${start}`)
  return source.slice(from, to)
}

const tinyImage = (bytes = 2048) => Buffer.alloc(bytes, 7).toString('base64')

async function main() {
  const networkGuard = forbidNetwork()
  try {
    // 先装好假 adapter，再导入服务与路由（与 Security 测试同一套路）
    const axiosDir = path.dirname(requireFromBackend.resolve('axios/package.json'))
    const axios = (await import(pathToFileURL(path.join(axiosDir, 'index.js')).href)).default
    const oldAdapter = axios.defaults.adapter
    const oldMkdir = fs.mkdirSync
    const oldAppend = fs.appendFile

    const calls = []
    const logs = []
    let adapterMode = 'ok'
    let adapterContent = '{}'
    let redirectTarget = 'https://evil.example/collect'

    const ai = await import(pathToFileURL(path.join(root, 'backend/routes/ai.js')).href)
    const service = await import(pathToFileURL(path.join(root, 'backend/services/deepseek.js')).href)
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default
    const backendValues = await import(
      pathToFileURL(path.join(root, 'backend/utils/screenshotValues.js')).href
    )
    const frontendValues = await import(
      pathToFileURL(path.join(frontend, 'utils/screenshotValues.js')).href
    )
    const draftLib = await import(
      pathToFileURL(path.join(frontend, 'utils/recentPerformanceDraft.js')).href
    )
    const imageLib = await import(pathToFileURL(path.join(frontend, 'utils/screenshotImage.js')).href)
    const modalSource = fs.readFileSync(
      path.join(frontend, 'components/RecentPerformanceAssistantModal.jsx'),
      'utf8'
    )
    // Alpha.2 A2：payload 组装（observed_at）所在模块的源码，用于契约断言
    const saveLibSourceForA2 = fs.readFileSync(
      path.join(frontend, 'utils/recentPerformanceSave.js'),
      'utf8'
    )

    const route = ai.default.stack.find(
      (layer) => layer.route?.path === '/extract-creator-screenshot'
    )
    const handler = route?.route?.stack?.[route.route.stack.length - 1]?.handle
    const callRoute = async (body, headers = {}) => {
      const res = response()
      await handler({ body, headers }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    fs.mkdirSync = () => undefined
    fs.appendFile = (_file, entry, callback) => { logs.push(String(entry)); callback?.() }
    axios.defaults.adapter = async (config) => {
      calls.push(config)
      if (adapterMode === 'fail') {
        throw { response: { status: 400, data: { error: { message: `bad ${fakeKey} ${tinyImage(64)}` } } } }
      }
      if (adapterMode === 'redirect') {
        // 模拟真实传输层契约：非 2xx 由 validateStatus 判定为失败（axios 内置 http adapter 的行为）
        const status = 302
        const okStatus = config.validateStatus
          ? config.validateStatus(status)
          : status >= 200 && status < 300
        if (!okStatus) {
          throw Object.assign(new Error('Request failed with status code 302'), {
            isAxiosError: true,
            config,
            response: {
              status,
              statusText: 'Found',
              headers: { location: redirectTarget },
              data: `<html>redirecting to ${redirectTarget} ${fakeKey}</html>`,
              config
            }
          })
        }
      }
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        data: { choices: [{ message: { content: adapterContent } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      }
    }

    console.log('===== 1. 路由与显式触发（不点击不请求）=====')
    check('extract-creator-screenshot 只注册 POST', Boolean(route) && Object.keys(route.route.methods).join(',') === 'post')
    check(
      '前端只有一处调用 extractCreatorScreenshot（唯一触发点）',
      (modalSource.match(/extractCreatorScreenshot\(/g) || []).length === 1
    )
    check('触发点绑定在「开始 AI 识别」按钮上', /onClick=\{handleStartRecognition\}/.test(modalSource))
    check(
      '选择/拖拽/粘贴图片的流程里没有 AI 调用',
      !section(modalSource, 'const addFiles =', 'const removeImage =').includes('extractCreatorScreenshot(')
    )
    check('粘贴处理只处理图片文件，不调用 AI', /handlePaste[\s\S]*?addFiles\(files\)/.test(modalSource))
    check('识别进行中禁止重复点击（in-flight 锁）', /if \(aiInFlightRef\.current \|\| aiLoading\) return/.test(modalSource))
    check(
      '锁在请求前落地（并发点击只会产生 1 次请求）',
      modalSource.indexOf('aiInFlightRef.current = true') <
        modalSource.indexOf('await extractCreatorScreenshot(')
    )
    check('失败后可「重新识别」', /重新识别/.test(modalSource) && /handleStartRecognition/.test(modalSource))
    check('未配置 AI 时给出提示而不是自动调用', /未检测到可用的 AI 配置/.test(modalSource))

    console.log('\n===== 2. 显式点击后恰好 1 次请求（走真实 service + 假 adapter）=====')
    calls.length = 0
    adapterContent = JSON.stringify({
      creator_name_raw: 'Gary',
      xingtu_price_raw: '¥3,000',
      plays: [
        { source_image_index: 1, position_index: 1, raw_text: '4.8万' },
        { source_image_index: 2, position_index: 1, raw_text: '12K' }
      ],
      warnings: []
    })
    const okCall = await callRoute(
      { images: [{ mime: 'image/png', base64: tinyImage() }, { mime: 'image/jpeg', base64: tinyImage() }] },
      { 'x-ai-provider': 'deepseek', 'x-ai-api-key': fakeKey }
    )
    check('识别成功返回 200', okCall.status === 200, JSON.stringify(okCall.msg))
    check('恰好产生 1 次 Provider 请求', calls.length === 1, `calls=${calls.length}`)
    check('返回结构含 raw 事实与确定性换算结果', okCall.data?.plays?.[0]?.raw_text === '4.8万' && okCall.data?.plays?.[0]?.normalized_play === 48000)
    check('多图保留 source_image_index', okCall.data?.plays?.[1]?.source_image_index === 2)
    check('返回报告固定 vision 模型', okCall.data?.model === 'deepseek-flash', String(okCall.data?.model))

    console.log('\n===== 3. 图片校验（后端独立校验，不信任前端）=====')
    const noImage = await callRoute({ images: [] }, { 'x-ai-provider': 'deepseek', 'x-ai-api-key': fakeKey })
    check('0 张 → 400', noImage.status === 400 && /至少选择 1 张/.test(noImage.msg), noImage.msg)
    const tooMany = await callRoute(
      { images: Array.from({ length: 4 }, () => ({ mime: 'image/png', base64: tinyImage() })) },
      { 'x-ai-provider': 'deepseek', 'x-ai-api-key': fakeKey }
    )
    check('4 张 → 400 超数量', tooMany.status === 400 && /最多识别 3 张/.test(tooMany.msg), tooMany.msg)
    const badMime = await callRoute(
      { images: [{ mime: 'image/gif', base64: tinyImage() }] },
      { 'x-ai-provider': 'deepseek', 'x-ai-api-key': fakeKey }
    )
    check('gif → 400 不支持类型', badMime.status === 400 && /格式不支持/.test(badMime.msg), badMime.msg)
    const badBase64 = await callRoute(
      { images: [{ mime: 'image/png', base64: 'not-base64!!!' }] },
      { 'x-ai-provider': 'deepseek', 'x-ai-api-key': fakeKey }
    )
    check('非法 base64 → 400', badBase64.status === 400 && /不是合法图片数据/.test(badBase64.msg), badBase64.msg)
    const oversize = await callRoute(
      { images: [{ mime: 'image/png', base64: Buffer.alloc(1572865, 3).toString('base64') }] },
      { 'x-ai-provider': 'deepseek', 'x-ai-api-key': fakeKey }
    )
    check('单图超过 1.5MB → 400', oversize.status === 400 && /单图上限/.test(oversize.msg), oversize.msg)
    const totalOversize = await callRoute(
      { images: Array.from({ length: 3 }, () => ({ mime: 'image/png', base64: Buffer.alloc(1300000, 5).toString('base64') })) },
      { 'x-ai-provider': 'deepseek', 'x-ai-api-key': fakeKey }
    )
    check('总体积超过 3.2MB → 400', totalOversize.status === 400 && /总体积超过上限/.test(totalOversize.msg), totalOversize.msg)
    check('被拒绝的请求不会触达 Provider', calls.length === 1, `calls=${calls.length}`)

    check('前端：不支持类型被拒绝', imageLib.validateImageFile({ name: 'a.gif', type: 'image/gif', size: 10 }).ok === false)
    check('前端：合法类型通过', imageLib.validateImageFile({ name: 'a.png', type: 'image/png', size: 10 }).ok === true)
    check('前端：超数量被拒绝', imageLib.validateSelection(2, 2).ok === false)
    check('前端：总发送体积超限被拒绝', imageLib.validateTotalBytes(3355401).ok === false)
    check('前端：长边缩放只缩小不放大', JSON.stringify(imageLib.scaleSize(4000, 1000)) === JSON.stringify({ width: 2000, height: 500, scale: 0.5 }) && imageLib.scaleSize(800, 600).scale === 1)
    check(
      '前端：压缩序列 PNG 优先保真、逐级降级到 JPEG',
      imageLib.buildCompressionAttempts('image/png')[0].type === 'image/png' &&
        imageLib.buildCompressionAttempts('image/jpeg')[0].type === 'image/jpeg' &&
        imageLib.buildCompressionAttempts('image/png').length >= 4
    )

    console.log('\n===== 4. 确定性数字换算（前后端 parity）=====')
    const playCases = [
      ['5.2万', 52000], ['1万', 10000], ['8600', 8600], ['1.3w', 13000], ['1.3W', 13000],
      ['12k', 12000], ['12K', 12000], ['1.2亿', 120000000], ['0', 0], [' 5.2 万 ', 52000],
      ['1,234', 1234], ['５.２万', 52000]
    ]
    for (const [raw, expected] of playCases) {
      const be = backendValues.parsePlayText(raw)
      const fe = frontendValues.parsePlayText(raw)
      check(`播放量 ${raw} -> ${expected}`, be.value === expected && fe.value === expected, `${be.value}/${fe.value}`)
      check(`播放量 ${raw} 前后端一致`, JSON.stringify(be) === JSON.stringify(fe))
    }
    const priceCases = [['¥3,000', 3000], ['3000元', 3000], ['3,000', 3000], ['￥3000', 3000], ['3000', 3000], ['¥ 3,000.50', 3000.5]]
    for (const [raw, expected] of priceCases) {
      const be = backendValues.parsePriceText(raw)
      const fe = frontendValues.parsePriceText(raw)
      check(`价格 ${raw} -> ${expected}`, be.value === expected && fe.value === expected, `${be.value}/${fe.value}`)
      check(`价格 ${raw} 前后端一致`, JSON.stringify(be) === JSON.stringify(fe))
    }
    const unresolvable = ['约五万', '5.2万次', '暂无数据', '', null]
    for (const raw of unresolvable) {
      const be = backendValues.parsePlayText(raw)
      const fe = frontendValues.parsePlayText(raw)
      check(
        `解析失败 ${JSON.stringify(raw)} -> null + needs_review`,
        be.value === null && be.needs_review === true && fe.value === null && fe.needs_review === true
      )
    }

    console.log('\n===== 5. AI 只给事实：不猜造、不补足、保留原顺序 =====')
    const nullResult = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: null,
      xingtu_price_raw: null,
      plays: [
        { source_image_index: 1, position_index: 1, raw_text: null },
        { source_image_index: 1, position_index: 2, raw_text: '看不清' }
      ],
      warnings: ['第 2 条播放量被遮挡']
    }))
    check('AI 返回 null → 不猜造（保持 null + needs_review）', nullResult.creator_name_raw === null && nullResult.xingtu_price === null && nullResult.plays.every((play) => play.normalized_play === null && play.needs_review))
    check('warnings 原样保留', nullResult.warnings.includes('第 2 条播放量被遮挡'))
    const shortResult = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: '达人甲', xingtu_price_raw: '3000',
      plays: [{ source_image_index: 1, position_index: 1, raw_text: '1万' }], warnings: []
    }))
    check('AI 只返回 1 条时系统不补足', shortResult.plays.length === 1 && shortResult.recognized_count === 1)
    const multiImage = ai.parseCreatorScreenshotResult(JSON.stringify({
      creator_name_raw: '达人乙', xingtu_price_raw: '3000',
      plays: [
        { source_image_index: 1, position_index: 1, raw_text: '1万' },
        { source_image_index: 3, position_index: 2, raw_text: '2万' }
      ], warnings: []
    }))
    check('多图 source_image_index 原样保留（不重排、不去重）', multiImage.plays[0].source_image_index === 1 && multiImage.plays[1].source_image_index === 3)
    const draftFromResult = draftLib.buildDraftFromExtraction(multiImage)
    check('草稿保留图片来源与顺序', draftFromResult.plays[1].source_image_index === 3 && draftFromResult.plays[1].position_index === 2)
    check('草稿不补足 15 条', draftFromResult.plays.length === 2)

    console.log('\n===== 5b. Alpha.3-04：AI 输出 content_type（只按可见颜色标识）=====')
    const systemPrompt = ai.buildScreenshotSystemPrompt()
    check(
      'G1 提示词要求逐条输出 content_type，并明确红 → sponsored / 蓝 → organic',
      /content_type/.test(systemPrompt) &&
        /红色标识/.test(systemPrompt) &&
        /"sponsored"/.test(systemPrompt) &&
        /蓝色标识/.test(systemPrompt) &&
        /"organic"/.test(systemPrompt)
    )
    check(
      'G2 提示词禁止按文案语义猜广告、禁止硬凑二选一，无法确认必须 unknown',
      /禁止根据标题文案/.test(systemPrompt) &&
        /强行分类/.test(systemPrompt) &&
        /"unknown"/.test(systemPrompt) &&
        /无法确认时必须返回 "unknown"/.test(systemPrompt)
    )
    const typedResult = ai.parseCreatorScreenshotResult(
      JSON.stringify({
        creator_name_raw: '达人丙',
        xingtu_price_raw: '3000',
        plays: [
          { source_image_index: 1, position_index: 1, raw_text: '5.2万', content_type: 'sponsored' },
          { source_image_index: 1, position_index: 2, raw_text: '8.1万', content_type: 'organic' },
          { source_image_index: 1, position_index: 3, raw_text: '3.4万', content_type: 'unknown' },
          { source_image_index: 1, position_index: 4, raw_text: '4.4万', content_type: 'SPONSORED' },
          { source_image_index: 1, position_index: 5, raw_text: '6.6万', content_type: 'red' },
          { source_image_index: 1, position_index: 6, raw_text: '7.7万' },
          { source_image_index: 1, position_index: 7, raw_text: '8.8万', content_type: 1 }
        ],
        warnings: []
      })
    )
    check(
      'G3 AI 输出归一化：合法值保留、大小写不敏感、red / 缺失 / 数字 → unknown',
      typedResult.plays.map((play) => play.content_type).join(',') ===
        'sponsored,organic,unknown,sponsored,unknown,unknown,unknown',
      JSON.stringify(typedResult.plays.map((play) => play.content_type))
    )
    check(
      'G4 内容类型不影响播放量解析结果（数值与 needs_review 口径不变）',
      typedResult.plays.map((play) => play.normalized_play).join(',') ===
        '52000,81000,34000,44000,66000,77000,88000' &&
        typedResult.plays.every((play) => play.needs_review === false)
    )
    const typedDraftFromAi = draftLib.buildDraftFromExtraction(typedResult)
    check(
      'G5 草稿逐条继承 AI 类型（人工可改）',
      typedDraftFromAi.plays.map((play) => play.content_type).join(',') ===
        'sponsored,organic,unknown,sponsored,unknown,unknown,unknown'
    )

    console.log('\n===== 6. 人工确认：修改 / 排除 / 恢复 =====')
    let draft = draftLib.buildDraftFromExtraction({
      provider: 'deepseek', model: 'deepseek-flash',
      creator_name_raw: 'Gary', xingtu_price_raw: '¥3,000',
      plays: [
        { source_image_index: 1, position_index: 1, raw_text: '4.8万' },
        { source_image_index: 1, position_index: 2, raw_text: '5.2万' },
        { source_image_index: 1, position_index: 3, raw_text: '51万' }
      ],
      warnings: []
    })
    check('初始换算正确', draft.plays.map((play) => play.normalized_play).join(',') === '48000,52000,510000')
    draft = draftLib.updatePlayRawText(draft, 'play-2', '6万')
    check('人工修改覆盖 AI 识别值（并按确定性规则重算）', draft.plays[1].raw_text === '6万' && draft.plays[1].normalized_play === 60000)
    draft = draftLib.updatePriceRawText(draft, '2800元')
    check('人工修改星图价覆盖 AI 值', draft.xingtu_price === 2800 && draft.xingtu_price_raw === '2800元')
    draft = draftLib.togglePlayExcluded(draft, 'play-2')
    let summary = draftLib.summarizeDraft(draft)
    check('排除一条后有效数量正确', summary.identified_count === 3 && summary.excluded_count === 1 && summary.valid_count === 2, JSON.stringify(summary))
    draft = draftLib.togglePlayExcluded(draft, 'play-2')
    summary = draftLib.summarizeDraft(draft)
    check('恢复后有效数量正确', summary.excluded_count === 0 && summary.valid_count === 3, JSON.stringify(summary))
    draft = draftLib.togglePlayExcluded(draft, 'play-1')
    const confirmed = draftLib.buildConfirmedDraft(draft)
    check(
      '确认草稿结构正确（含排除标记与来源顺序）',
      confirmed.plays.length === 3 &&
        confirmed.plays[0].excluded === true &&
        confirmed.plays[0].source_image_index === 1 &&
        confirmed.summary.valid_count === 2 &&
        confirmed.xingtu_price === 2800
    )
    check('确认草稿不包含任何数据库字段/估值字段', !('id' in confirmed) && !('cpm_target' in confirmed) && !('discount' in confirmed))

    console.log('\n===== 7. 安全边界：模型固定、endpoint 固定、Key/base64 不外泄 =====')
    calls.length = 0
    logs.length = 0
    adapterContent = JSON.stringify({ creator_name_raw: 'Gary', xingtu_price_raw: '3000', plays: [], warnings: [] })
    await callRoute(
      { images: [{ mime: 'image/png', base64: tinyImage() }] },
      {
        'x-ai-provider': 'deepseek',
        'x-ai-api-key': fakeKey,
        'x-ai-model': 'evil-custom-model',
        'x-ai-base-url': 'https://untrusted.example'
      }
    )
    const visionCall = calls[0]
    // axios 在进入 adapter 前已把 data 序列化成字符串，这里还原成请求体
    const visionPayload = typeof visionCall.data === 'string' ? JSON.parse(visionCall.data) : visionCall.data
    check('endpoint 固定为 DeepSeek 官方地址', visionCall.url === 'https://api.deepseek.com/v1/chat/completions', visionCall.url)
    check('x-ai-model 不能覆盖 vision 模型', visionPayload.model === 'deepseek-flash', String(visionPayload.model))
    check(
      '图片以 content parts 发送（data URL 内联）',
      Array.isArray(visionPayload.messages[1].content) &&
        visionPayload.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,')
    )
    check('请求体未出现 x-ai-base-url 目标地址', !JSON.stringify(visionPayload).includes('untrusted.example'))
    check('日志不包含 Key / base64', !logs.join('').includes(fakeKey) && !logs.join('').includes(tinyImage()))

    adapterMode = 'fail'
    logs.length = 0
    const failed = await callRoute(
      { images: [{ mime: 'image/png', base64: tinyImage() }] },
      { 'x-ai-provider': 'deepseek', 'x-ai-api-key': fakeKey }
    )
    adapterMode = 'ok'
    check('Provider 失败 → 前端拿到友好错误', failed.status === 502 && typeof failed.msg === 'string' && failed.msg.length > 0)
    check('错误信息不回显 Key / 图片正文', !String(failed.msg).includes(fakeKey) && !String(failed.msg).includes(tinyImage()))
    const failureLogs = logs.join('')
    check(
      '日志同样脱敏（Provider 回显的 Key 与 base64 片段均被剥离）',
      !failureLogs.includes(fakeKey) &&
        !failureLogs.includes(tinyImage().slice(0, 40)) &&
        failureLogs.includes('[REDACTED_BASE64]'),
      failureLogs.slice(0, 200)
    )

    const zhipuCall = await callRoute(
      { images: [{ mime: 'image/png', base64: tinyImage() }] },
      { 'x-ai-provider': 'zhipu', 'x-ai-api-key': fakeKey }
    )
    check('智谱（P2A 未开放 Vision）→ 400 明确提示', zhipuCall.status === 400 && /暂未开放图片识别/.test(zhipuCall.msg), zhipuCall.msg)
    check('服务层 vision 模型只来自预设', service.getVisionModel('deepseek') === 'deepseek-flash' && service.getVisionModel('zhipu') === null)
    check('拒绝任意 provider（未知服务商回退 DeepSeek，不新增 endpoint）', service.resolveProvider('evil-provider').key === 'deepseek')

    const statusHandler = ai.default.stack.find((layer) => layer.route?.path === '/status')?.route.stack[0].handle
    const statusRes = response()
    statusHandler({ headers: { 'x-ai-provider': 'deepseek', 'x-ai-model': 'evil-model' } }, statusRes)
    check('/status 报告固定 vision 模型', statusRes.body.data.visionModel === 'deepseek-flash' && statusRes.body.data.visionAvailable === true)

    console.log('\n===== 8. 非法 JSON / 只读 / 不落库 =====')
    adapterContent = '这不是 JSON'
    const badJson = await callRoute(
      { images: [{ mime: 'image/png', base64: tinyImage() }] },
      { 'x-ai-provider': 'deepseek', 'x-ai-api-key': fakeKey }
    )
    check('非法 JSON → 明确识别失败（不猜测修复）', badJson.status === 502 && /识别失败/.test(badJson.msg), badJson.msg)
    adapterContent = JSON.stringify({ creator_name_raw: 'x' })
    const badShape = await callRoute(
      { images: [{ mime: 'image/png', base64: tinyImage() }] },
      { 'x-ai-provider': 'deepseek', 'x-ai-api-key': fakeKey }
    )
    check('结构不符（缺 plays）→ 明确失败', badShape.status === 502 && /plays/.test(badShape.msg), badShape.msg)

    const recordsBefore = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
    const batchesBefore = db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n
    adapterContent = JSON.stringify({ creator_name_raw: 'Gary', xingtu_price_raw: '3000', plays: [{ source_image_index: 1, position_index: 1, raw_text: '5.2万' }], warnings: [] })
    await callRoute(
      { images: [{ mime: 'image/webp', base64: tinyImage() }] },
      { 'x-ai-provider': 'deepseek', 'x-ai-api-key': fakeKey }
    )
    check(
      '本轮不写库（creator_records / import_batches 不变）',
      db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n === recordsBefore &&
        db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n === batchesBefore
    )
    check('隔离库路径位于临时目录（未触碰真实 workbench.db）', process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir()))

    const rawPlaysCap = ai.parseCreatorScreenshotResult(
      JSON.stringify({
        creator_name_raw: 'Gary', xingtu_price_raw: '3000',
        plays: Array.from({ length: ai.MAX_RECOGNIZED_PLAYS + 5 }, (_, index) => ({
          source_image_index: 1, position_index: index + 1, raw_text: '1万'
        })),
        warnings: []
      })
    )
    check('异常超长 plays 被截断且显式告警', rawPlaysCap.plays.length === ai.MAX_RECOGNIZED_PLAYS && rawPlaysCap.truncated === true && rawPlaysCap.warnings.length === 1)

    console.log('\n===== 9. Alpha.2 A2：人工确认页 UI 收敛（源码契约）=====')
    check(
      'A2-15 已删除「达人昵称」可编辑输入框（含 updateCreatorName 调用）',
      !/请核对达人昵称/.test(modalSource) &&
        !/updateCreatorName/.test(modalSource) &&
        !/达人昵称<\/Typography\.Text>/.test(modalSource)
    )
    check(
      'A2-16 顶部改为静态「正在更新：」+ 数据观察日期，不再让用户重选达人',
      /正在更新：/.test(modalSource) &&
        modalSource.indexOf('正在更新：') < modalSource.indexOf('>数据观察日期</Typography.Text>') &&
        !/本次快照所属达人（雷达达人）/.test(modalSource)
    )
    check(
      'A2-17 身份三态接入：一致=短暂提示 / 未识别=轻提示 / 不一致=黄色风险 + 显式确认',
      /IDENTITY_STATUS\.matched/.test(modalSource) &&
        /identityFlash/.test(modalSource) &&
        /identityState\.status === IDENTITY_STATUS\.mismatch/.test(modalSource) &&
        /未识别到达人昵称，请自行确认截图/.test(modalSource) &&
        /我确认截图无误，仍保存到/.test(modalSource)
    )
    check(
      'A2-18 「已核对」是短暂提示（定时清除），不是永久正文',
      /const timer = setTimeout\(\(\) => setIdentityFlash\(false\), 4000\)/.test(modalSource) &&
        /clearTimeout\(timer\)/.test(modalSource)
    )
    check(
      'A2-19 AI 详情默认折叠，可展开查看原 warnings',
      /const \[warningsExpanded, setWarningsExpanded\] = useState\(false\)/.test(modalSource) &&
        /查看识别详情/.test(modalSource) &&
        /收起识别详情/.test(modalSource) &&
        /warningsExpanded &&[\s\S]{0,200}draft\.warnings\.map/.test(modalSource)
    )
    check(
      'A2-20 待确认项计数只由「无法解析播放量 / 身份不一致」决定（A3 起星图价不计入）',
      /countRequiredConfirmations\(\{/.test(modalSource) &&
        !/priceNeedsConfirmation,/.test(modalSource) &&
        /unresolvedCount: summary\?\.unresolved_count \?\? 0,/.test(modalSource) &&
        /identityStatus: identityState\.status/.test(modalSource) &&
        /需要确认 \$\{requiredConfirmations\} 项/.test(modalSource)
    )
    check(
      'A2-21 没有确认项时不显示黄色 Alert（改为轻量「识别结果已可检查」）',
      /requiredConfirmations > 0 \?/.test(modalSource) && /识别结果已可检查/.test(modalSource)
    )
    check(
      'A2-22 星图刊例价只保留一个字段 + 一个状态文案（不再重复「需人工确认」）',
      /星图刊例价（选填）<\/Typography\.Text>/.test(modalSource) &&
        /PRICE_FIELD_STATUS_LABELS\[priceFieldStatus\]/.test(modalSource) &&
        (modalSource.match(/PRICE_FIELD_STATUS_LABELS\[priceFieldStatus\]/g) || []).length === 1 &&
        !/draft\.xingtu_price === null \? '需人工确认'/.test(modalSource) &&
        !/xingtu_price_needs_review && \(/.test(modalSource)
    )
    check(
      'A3 星图价输入框文案为「可不填」（可选事实，不伪装成已识别）',
      /可不填，例如 ¥3,000/.test(modalSource)
    )
    check(
      'A2-24 snapshot owner 仍是雷达达人（payload creator = boundCreator）',
      /buildSnapshotPayload\(draft, \{[\s\S]{0,140}creator: boundCreator/.test(modalSource) &&
        !/creator: draft\.creator_name/.test(modalSource)
    )
    check(
      'A2-25 保持 A1：payload 仍携带 observed_at',
      /observedAt\n?\s*\}\)/.test(modalSource) && /observed_at: String\(observedAt/.test(saveLibSourceForA2)
    )

    console.log('\n===== 10. Alpha.2 A3：手工录入入口（源码契约）=====')
    check(
      'A3-1 两个入口主动可见（上传截图识别 / 手工录入），不需要先失败一次 AI',
      /<Radio\.Button value="screenshot">上传截图识别<\/Radio\.Button>/.test(modalSource) &&
        /<Radio\.Button value="manual">手工录入<\/Radio\.Button>/.test(modalSource) &&
        /近期作品数据/.test(modalSource)
    )
    check(
      'A3-2 手工录入面板存在（多行输入 + 解析按钮）',
      /Input\.TextArea/.test(modalSource) &&
        /解析并进入确认/.test(modalSource) &&
        /handleParseManualPlays/.test(modalSource)
    )
    check(
      'A3-3 手工录入复用既有确定性 parser（不新增第二套解析）',
      /buildDraftFromManualPlays\(/.test(modalSource) &&
        /splitManualPlayLines\(/.test(modalSource) &&
        !/parsePlayText\(/.test(modalSource)
    )
    check(
      'A3-4 手工录入明确「从旧到新」时间顺序与数量建议（Phase audit 冻结契约）',
      /从旧到新/.test(modalSource) &&
        /至少 5 条才能计算中位播放与典型区间/.test(modalSource) &&
        /不强制凑满 15 条/.test(modalSource)
    )
    check(
      'A3-5 手工模式不渲染截图上传区与「发送范围」（不向 AI 发送任何内容）',
      /entryMode === 'screenshot' && \([\s\S]{0,80}发送范围/.test(modalSource) &&
        /entryMode === 'screenshot' && \([\s\S]{0,2000}上传后不会自动发送/.test(modalSource) &&
        /entryMode === 'manual' && \(/.test(modalSource)
    )
    check(
      'A3-6 手工模式不显示「未识别到达人昵称」提示（身份不适用，不是 mismatch）',
      /identityUnknown && entryMode === 'screenshot'/.test(modalSource)
    )
    check(
      'A3-7 AI 仍是唯一显式触发（手工录入不调用识别接口）',
      (modalSource.match(/extractCreatorScreenshot\(/g) || []).length === 1 &&
        !/handleParseManualPlays[\s\S]{0,400}extractCreatorScreenshot\(/.test(modalSource)
    )
    check(
      'A3-8 手工与截图汇入同一条保存链（同一个 buildSnapshotPayload + 同一个保存接口）',
      // Alpha.3-04B 起多了一个「补充分类」保存入口，但它同样复用 buildSnapshotPayload → saveRecentSnapshot，
      // 不存在第二套保存链（不新增 API、不新增 payload 组装方式）。
      (modalSource.match(/buildSnapshotPayload\(/g) || []).length === 2 &&
        /onClick=\{handleSave\}/.test(modalSource) &&
        /onClick=\{handleClassifySave\}/.test(modalSource) &&
        // 两个入口都只经过同一个 saveRecentSnapshot（无第二套保存渠道）
        (modalSource.match(/saveRecentSnapshot\(/g) || []).length === 2
    )

    console.log('\n===== 11. 网络重定向边界（3xx 绝不跟随）=====')
    // A. Provider 返回 302 + Location: https://evil.example/collect
    calls.length = 0
    logs.length = 0
    adapterMode = 'redirect'
    const redirected = await callRoute(
      { images: [{ mime: 'image/png', base64: tinyImage() }] },
      { 'x-ai-provider': 'deepseek', 'x-ai-api-key': fakeKey }
    )
    adapterMode = 'ok'
    const redirectBody = JSON.stringify(redirected.body)
    const redirectLogs = logs.join('')
    check('302 → 统一安全失败（502）', redirected.status === 502, String(redirected.status))
    check(
      '失败信息明确说明「拒绝跟随重定向」',
      /拒绝跟随/.test(String(redirected.msg)) && /重定向/.test(String(redirected.msg)),
      String(redirected.msg)
    )
    check(
      '响应不含 evil.example / Location / Key / base64',
      !redirectBody.includes('evil.example') &&
        !redirectBody.includes('location') &&
        !redirectBody.includes(fakeKey) &&
        !redirectBody.includes(tinyImage().slice(0, 24))
    )
    check('日志同样不含 evil.example / Location / Key / base64', !redirectLogs.includes('evil.example') && !redirectLogs.includes('location') && !redirectLogs.includes(fakeKey) && !redirectLogs.includes(tinyImage().slice(0, 24)), redirectLogs.slice(0, 180))
    check(
      '实际请求只发生在原始固定 endpoint（未向 evil.example 发出任何请求）',
      calls.length === 1 && calls[0].url === 'https://api.deepseek.com/v1/chat/completions' && !JSON.stringify(calls.map((call) => call.url)).includes('evil.example')
    )

    // B. 请求配置必须显式携带 maxRedirects: 0（Vision 与文本共用同一发送函数）
    calls.length = 0
    adapterContent = JSON.stringify({ creator_name_raw: null, xingtu_price_raw: null, plays: [], warnings: [] })
    await callRoute(
      { images: [{ mime: 'image/png', base64: tinyImage() }] },
      { 'x-ai-provider': 'deepseek', 'x-ai-api-key': fakeKey }
    )
    check('Vision 请求配置 maxRedirects === 0', calls[0]?.maxRedirects === 0, String(calls[0]?.maxRedirects))
    calls.length = 0
    await service.callDeepSeek('system', 'user', { provider: 'deepseek', apiKey: fakeKey })
    check('文本 AI 请求同样 maxRedirects === 0（共享 sendChatCompletion）', calls[0]?.maxRedirects === 0, String(calls[0]?.maxRedirects))
    const axiosAdapterSource = fs.readFileSync(
      path.join(path.dirname(requireFromBackend.resolve('axios/package.json')), 'lib/adapters/http.js'),
      'utf8'
    )
    check(
      '已安装的 axios 传输层确实实现了 maxRedirects === 0（改用原生 http/https，不经 follow-redirects）',
      /maxRedirects === 0/.test(axiosAdapterSource) && /isNativeTransport = true/.test(axiosAdapterSource)
    )

    axios.defaults.adapter = oldAdapter
    fs.mkdirSync = oldMkdir
    fs.appendFile = oldAppend
    check('测试期间从未触达真实网络', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))

    // C. 真实传输层行为验证：仅在 127.0.0.1 自建服务上验证「maxRedirects: 0 不跟随」
    networkGuard.restore()
    const hits = { origin: 0, collector: 0 }
    const collector = http.createServer((req, res) => {
      hits.collector += 1
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('collected')
    })
    await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve))
    const collectorPort = collector.address().port
    const origin = http.createServer((req, res) => {
      hits.origin += 1
      res.writeHead(302, { Location: `http://127.0.0.1:${collectorPort}/collect` })
      res.end()
    })
    await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))
    const originPort = origin.address().port

    try {
      // C1：与生产同配置（maxRedirects: 0）→ 不跟随
      let blockedStatus = null
      await axios
        .get(`http://127.0.0.1:${originPort}/redirect`, { maxRedirects: 0 })
        .catch((error) => { blockedStatus = error?.response?.status ?? null })
      check('maxRedirects: 0 → 真实传输层不跟随重定向（collector 命中 0 次）', hits.collector === 0 && blockedStatus === 302, `origin=${hits.origin} collector=${hits.collector} status=${blockedStatus}`)

      // C2：对照实验（默认 maxRedirects）→ 会跟随，证明该测试确实能检测到「跟随」行为
      await axios
        .get(`http://127.0.0.1:${originPort}/redirect`)
        .catch(() => null)
      check('对照实验：默认配置确实会跟随（collector 命中 1 次，证明用例有效）', hits.collector === 1 && hits.origin === 2, `origin=${hits.origin} collector=${hits.collector}`)
    } finally {
      await new Promise((resolve) => origin.close(resolve))
      await new Promise((resolve) => collector.close(resolve))
    }
  } finally {
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
