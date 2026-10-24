#!/usr/bin/env node
// 只使用内存存储与 axios 假 adapter；网络传输层默认拒绝，绝不请求真实 Provider。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const requireFromBackend = createRequire(path.join(root, 'backend/package.json'))
const aiConfigUrl = pathToFileURL(path.join(root, 'frontend/src/utils/aiConfig.js')).href
const serviceUrl = pathToFileURL(path.join(root, 'backend/services/deepseek.js')).href
const routerUrl = pathToFileURL(path.join(root, 'backend/routes/ai.js')).href
const fakeKey = 'test-only-secret-key-123456789'

// 即使 Axios mock 因入口变化失效，任何 HTTP/TLS/fetch 请求也会立即在本进程失败。
function forbidNetwork() {
  const blocked = []
  const replacements = [
    [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'],
    [tls, 'connect']
  ]
  const originals = replacements.map(([target, method]) => [target, method, target[method]])
  for (const [target, method] of replacements) {
    target[method] = () => {
      blocked.push(method)
      throw new Error('AI lifecycle test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('AI lifecycle test forbids network requests')
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

async function main() {
  const values = new Map()
  const sessionValues = new Map()
  global.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  }
  global.sessionStorage = {
    getItem: (key) => sessionValues.get(key) ?? null,
    setItem: (key, value) => sessionValues.set(key, String(value)),
    removeItem: (key) => sessionValues.delete(key)
  }

  // 旧版完整 Key 必须被丢弃，仅保留 Provider/Model。
  values.set('ai_config', JSON.stringify({
    provider: 'deepseek', model: 'deepseek-chat', apiKey: fakeKey,
    baseUrl: 'https://untrusted.example'
  }))
  const browserConfig = await import(`${aiConfigUrl}?first`)
  assert.equal(browserConfig.getAiConfig().apiKey, '')
  assert.deepEqual(JSON.parse(values.get('ai_config')), {
    provider: 'deepseek', model: 'deepseek-chat'
  })

  // Key 只进入 sessionStorage；同一浏览器会话刷新后仍可恢复。
  browserConfig.saveAiConfig({ provider: 'deepseek', model: 'deepseek-chat', apiKey: fakeKey })
  assert.equal(browserConfig.getAiConfig().apiKey, fakeKey)
  assert.equal(values.get('ai_config').includes(fakeKey), false)
  assert.deepEqual(JSON.parse(sessionValues.get('ai_session_key')), {
    provider: 'deepseek', apiKey: fakeKey
  })
  const afterReload = await import(`${aiConfigUrl}?reload`)
  assert.equal(afterReload.getAiConfig().apiKey, fakeKey)

  // UI 切换服务商时先调用 clearAiSessionKey，不能把旧 Key 带到另一个 Provider。
  browserConfig.clearAiSessionKey()
  assert.equal(sessionValues.has('ai_session_key'), false)
  assert.equal(afterReload.getAiConfig().apiKey, '')
  afterReload.saveAiConfig({ provider: 'zhipu', model: 'glm-4-flash', apiKey: fakeKey })
  assert.equal(afterReload.getAiConfig().apiKey, fakeKey)
  assert.equal(JSON.parse(sessionValues.get('ai_session_key')).provider, 'zhipu')

  // 断开既要清掉会话 Key，也要再次擦除可能由旧版写入 localStorage 的敏感字段。
  values.set('ai_config', JSON.stringify({
    provider: 'zhipu', model: 'glm-4-flash', apiKey: fakeKey, baseUrl: 'https://untrusted.example'
  }))
  afterReload.clearAiConfig()
  assert.equal(afterReload.getAiConfig().apiKey, '')
  assert.equal(sessionValues.has('ai_session_key'), false)
  assert.deepEqual(JSON.parse(values.get('ai_config')), {
    provider: 'zhipu', model: 'glm-4-flash'
  })

  // 新浏览器会话只有相同 localStorage，没有 sessionStorage，Key 不会被恢复。
  global.sessionStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined
  }
  const newSession = await import(`${aiConfigUrl}?new-session`)
  assert.equal(newSession.getAiConfig().apiKey, '')
  global.sessionStorage = {
    getItem: (key) => sessionValues.get(key) ?? null,
    setItem: (key, value) => sessionValues.set(key, String(value)),
    removeItem: (key) => sessionValues.delete(key)
  }
  console.log('PASS 旧 Key 迁移、sessionStorage 保存、刷新恢复、Provider 切换、断开与新会话')

  // backend/services/deepseek.js 使用 Axios 的 ESM 入口，需拦截同一个实例。
  const axiosDir = path.dirname(requireFromBackend.resolve('axios/package.json'))
  const axios = (await import(pathToFileURL(path.join(axiosDir, 'index.js')).href)).default
  const oldAdapter = axios.defaults.adapter
  const oldMkdir = fs.mkdirSync
  const oldAppend = fs.appendFile
  const oldDeepseekUrl = process.env.DEEPSEEK_API_URL
  const oldZhipuUrl = process.env.ZHIPU_API_URL
  const calls = []
  const logs = []
  try {
    // 假 adapter 捕获真正交给 axios 的目标地址及 Header，绝不连接外网。
    fs.mkdirSync = () => undefined
    fs.appendFile = (_file, entry, callback) => { logs.push(entry); callback?.() }
    process.env.DEEPSEEK_API_URL = 'https://untrusted.example'
    process.env.ZHIPU_API_URL = 'https://untrusted.example'
    axios.defaults.adapter = async (config) => {
      calls.push(config)
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        data: { choices: [{ message: { content: '{}' } }] }
      }
    }
    // 先装好假 adapter 再导入服务，避免模块初始化时复制原始网络 adapter。
    const service = await import(serviceUrl)
    await service.callDeepSeek('system', 'user', {
      provider: 'deepseek', apiKey: fakeKey, baseUrl: 'https://untrusted.example', model: 'custom-model'
    })
    await service.callDeepSeek('system', 'user', {
      provider: 'zhipu', apiKey: fakeKey, baseUrl: 'https://untrusted.example'
    })
    assert.deepEqual(calls.map((call) => call.url), [
      'https://api.deepseek.com/v1/chat/completions',
      'https://open.bigmodel.cn/api/paas/v4/chat/completions'
    ])
    assert.equal(calls[0].headers.Authorization, `Bearer ${fakeKey}`)
    assert.equal(logs.join('').includes(fakeKey), false)

    // 上游错误即使意外包含 Key，也不能回显在错误或后端日志里。
    axios.defaults.adapter = async () => {
      throw { response: { status: 400, data: { error: { message: `invalid ${fakeKey}` } } } }
    }
    await assert.rejects(
      service.callDeepSeek('system', 'user', { provider: 'deepseek', apiKey: fakeKey }),
      (error) => !error.message.includes(fakeKey)
    )
    assert.equal(logs.join('').includes(fakeKey), false)
    console.log('PASS 固定官方 endpoint、请求覆盖被忽略、Key 不进入 URL/日志/错误')
  } finally {
    axios.defaults.adapter = oldAdapter
    fs.mkdirSync = oldMkdir
    fs.appendFile = oldAppend
    if (oldDeepseekUrl === undefined) delete process.env.DEEPSEEK_API_URL
    else process.env.DEEPSEEK_API_URL = oldDeepseekUrl
    if (oldZhipuUrl === undefined) delete process.env.ZHIPU_API_URL
    else process.env.ZHIPU_API_URL = oldZhipuUrl
  }

  const router = (await import(routerUrl)).default
  const statusHandler = router.stack.find((layer) => layer.route?.path === '/status')?.route.stack[0].handle
  assert.equal(typeof statusHandler, 'function')
  const oldEnvKey = process.env.DEEPSEEK_API_KEY
  try {
    delete process.env.DEEPSEEK_API_KEY
    const withoutEnv = response()
    statusHandler({ headers: {
      'x-ai-provider': 'deepseek',
      'x-ai-api-key': fakeKey,
      'x-ai-base-url': 'https://untrusted.example'
    } }, withoutEnv)
    assert.equal(withoutEnv.body.data.available, false)
    assert.equal(withoutEnv.body.data.keySource, 'none')
    assert.equal(JSON.stringify(withoutEnv.body).includes(fakeKey), false)
    assert.equal(JSON.stringify(withoutEnv.body).includes('untrusted.example'), false)

    process.env.DEEPSEEK_API_KEY = fakeKey
    const withEnv = response()
    statusHandler({ headers: { 'x-ai-provider': 'deepseek' } }, withEnv)
    assert.equal(withEnv.body.data.available, true)
    assert.equal(withEnv.body.data.keySource, 'environment')
    assert.equal(JSON.stringify(withEnv.body).includes(fakeKey), false)
    console.log('PASS status 不依赖/回显用户 Key，仅报告后端环境变量')
  } finally {
    if (oldEnvKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = oldEnvKey
  }
}

const networkGuard = forbidNetwork()
main().then(() => {
  assert.equal(networkGuard.blocked.length, 0, '测试曾尝试访问真实网络')
  console.log('PASS 测试网络传输层未被触发')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  networkGuard.restore()
})
