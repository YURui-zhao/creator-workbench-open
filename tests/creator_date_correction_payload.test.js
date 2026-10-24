#!/usr/bin/env node
/**
 * Decision / Negotiation 日期纠正 — 前端请求体回归测试
 *
 * 背景：调用方曾用 snake_case 传参，helper 解构 camelCase 导致 decided_at/negotiated_at
 * 变成 undefined，JSON 序列化后请求体只剩 reason，后端 400。
 *
 * 本测试在 Node HTTP 层拦截真实 axios 请求（不发任何网络请求），
 * 验证「最终序列化后的 HTTP Request Payload」，并对三条调用路径的组件源码做形状断言。
 *
 * 运行方式：node tests/creator_date_correction_payload.test.js（无 DB、无后端依赖）
 */
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const events = require('node:events')
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

// ---------- HTTP 捕获层：替换 http/https.request，不建立任何真实连接 ----------
const capturedRequests = []
const originalHttpRequest = http.request
const originalHttpsRequest = https.request

function installCapture() {
  const capture = (method, options, cb) => {
    const entry = {
      method: String(options.method || 'GET').toUpperCase(),
      path: String(options.path || ''),
      bodyChunks: []
    }
    capturedRequests.push(entry)
    const req = new events.EventEmitter()
    // axios / follow-redirects 会监听 'socket' 并调用
    // socket.setTimeout / setNoDelay / removeListener 等（destroyOnTimeout 路径）
    req.socket = new events.EventEmitter()
    req.socket = Object.assign(req.socket, {
      remoteAddress: '127.0.0.1',
      remotePort: 3001,
      setTimeout: () => {},
      setNoDelay: () => {},
      setKeepAlive: () => {},
      destroy: () => {}
    })
    req.setNoDelay = () => {}
    req.setKeepAlive = () => {}
    req.setTimeout = () => {}
    req.destroy = () => {}
    req.abort = () => {}
    req.cork = () => {}
    req.uncork = () => {}
    req.write = (chunk) => {
      if (chunk) entry.bodyChunks.push(String(chunk))
      return true
    }
    req.end = (chunk) => {
      if (chunk) entry.bodyChunks.push(String(chunk))
      setImmediate(() => {
        const res = new events.EventEmitter()
        res.statusCode = 200
        res.statusMessage = 'OK'
        res.headers = { 'content-type': 'application/json' }
        res.rawHeaders = []
        res.resume = () => {}
        res.pause = () => {}
        res.setEncoding = () => {}
        req.emit('response', res)
        setImmediate(() => {
          res.emit('data', Buffer.from(JSON.stringify({ code: 200, data: null, msg: 'success' })))
          res.emit('end')
        })
      })
    }
    if (typeof cb === 'function') req.on('response', cb)
    return req
  }
  http.request = function (optionsOrUrl, callbackOrOptions, maybeCallback) {
    const options = typeof optionsOrUrl === 'string' || optionsOrUrl instanceof URL
      ? { ...require('node:url').parse(String(optionsOrUrl)) }
      : { ...optionsOrUrl }
    const cb = typeof callbackOrOptions === 'function' ? callbackOrOptions : maybeCallback
    return capture(options.method, options, cb)
  }
  https.request = http.request
}

function uninstallCapture() {
  http.request = originalHttpRequest
  https.request = originalHttpsRequest
}

async function main() {
  installCapture()
  try {
    const requestModule = await import(
      pathToFileURL(path.join(root, 'frontend/src/utils/request.js')).href
    )
    // axios node adapter 需要绝对 URL；真实链路 = baseURL '/api' + Vite 代理（无 rewrite）转发到 3001，
    // 因此后端收到的是 /api 前缀路径，这里用 <host>/api 完全等价复现
    requestModule.default.defaults.baseURL = 'http://127.0.0.1:3001/api'

    const decisionsApi = await import(
      pathToFileURL(path.join(root, 'frontend/src/api/creatorDecisions.js')).href
    )
    const negotiationApi = await import(
      pathToFileURL(path.join(root, 'frontend/src/api/creatorNegotiationCases.js')).href
    )

    console.log('===== 1. 决策日期纠正：最终 HTTP payload =====')
    const before = capturedRequests.length
    await decisionsApi.correctDecisionDate(24, {
      decidedAt: '2026-08-18',
      reason: '这条决策是8月份，补录'
    })
    const decisionReqs = capturedRequests.slice(before)
    check('只触发一次 PATCH（无重复/附带请求）', decisionReqs.length === 1, `captured=${decisionReqs.length}`)
    const decisionReq = decisionReqs[0] || { bodyChunks: [] }
    check('method = PATCH', decisionReq.method === 'PATCH', decisionReq.method)
    check('path = /api/creator-decisions/24/date', decisionReq.path === '/api/creator-decisions/24/date', decisionReq.path)
    const decisionBodyRaw = decisionReq.bodyChunks.join('')
    check('请求体不是 undefined / 空日期', decisionBodyRaw.includes('undefined') === false && decisionBodyRaw.includes('"decided_at":"2026-08-18"'), decisionBodyRaw)
    let decisionBody = {}
    try { decisionBody = JSON.parse(decisionBodyRaw) } catch { /* 交给后续断言失败 */ }
    check('decided_at = 2026-08-18', decisionBody.decided_at === '2026-08-18', decisionBodyRaw)
    check('reason 非空字符串', typeof decisionBody.reason === 'string' && decisionBody.reason.trim() !== '', decisionBodyRaw)
    check('payload 不含多余字段（只有 decided_at / reason）',
      Object.keys(decisionBody).sort().join(',') === 'decided_at,reason', decisionBodyRaw)

    console.log('\n===== 2. 谈价日期纠正（决策抽屉路径）：最终 HTTP payload =====')
    const before2 = capturedRequests.length
    await negotiationApi.correctNegotiationCaseDate(13, {
      negotiatedAt: '2026-08-18',
      reason: '谈价日期应为8月'
    })
    const negotiationReqs = capturedRequests.slice(before2)
    check('只触发一次 PATCH', negotiationReqs.length === 1, `captured=${negotiationReqs.length}`)
    const negotiationReq = negotiationReqs[0] || { bodyChunks: [] }
    check('method = PATCH', negotiationReq.method === 'PATCH', negotiationReq.method)
    check('path = /api/creator-negotiation-cases/13/date', negotiationReq.path === '/api/creator-negotiation-cases/13/date', negotiationReq.path)
    const negotiationBodyRaw = negotiationReq.bodyChunks.join('')
    let negotiationBody = {}
    try { negotiationBody = JSON.parse(negotiationBodyRaw) } catch { /* 交给后续断言失败 */ }
    check('negotiated_at = 2026-08-18（不是 undefined）', negotiationBody.negotiated_at === '2026-08-18', negotiationBodyRaw)
    check('reason 非空字符串', typeof negotiationBody.reason === 'string' && negotiationBody.reason.trim() !== '', negotiationBodyRaw)

    console.log('\n===== 3. 谈价日期纠正（Records 历史补录路径）：最终 HTTP payload =====')
    const before3 = capturedRequests.length
    await negotiationApi.correctNegotiationCaseDate(7, {
      negotiatedAt: '2026-09-20',
      reason: '补录日期填错了'
    })
    const historicalReqs = capturedRequests.slice(before3)
    check('只触发一次 PATCH', historicalReqs.length === 1, `captured=${historicalReqs.length}`)
    const historicalBodyRaw = (historicalReqs[0] || { bodyChunks: [] }).bodyChunks.join('')
    let historicalBody = {}
    try { historicalBody = JSON.parse(historicalBodyRaw) } catch { /* 交给后续断言失败 */ }
    check('negotiated_at = 2026-09-20（不是 undefined）', historicalBody.negotiated_at === '2026-09-20', historicalBodyRaw)
    check('reason 非空字符串', typeof historicalBody.reason === 'string' && historicalBody.reason.trim() !== '', historicalBodyRaw)

    console.log('\n===== 4. 三条调用路径的组件源码形状（防止再次传错键名）=====')
    const drawerSrc = fs.readFileSync(path.join(root, 'frontend/src/components/CreatorDecisionDrawer.jsx'), 'utf8')
    const historicalSrc = fs.readFileSync(path.join(root, 'frontend/src/components/HistoricalNegotiationCaseModal.jsx'), 'utf8')

    check('调用点1：决策日期传 decidedAt（camelCase）', drawerSrc.includes('decidedAt: dateCorrectValue') && !drawerSrc.includes('decided_at: dateCorrectValue'))
    check('调用点2：谈价日期（抽屉）传 negotiatedAt', drawerSrc.includes('negotiatedAt: negotiationDateValue') && !drawerSrc.includes('negotiated_at: negotiationDateValue'))
    check('调用点3：谈价日期（历史补录）传 negotiatedAt', historicalSrc.includes('negotiatedAt: dateCorrectValue') && !historicalSrc.includes('negotiated_at: dateCorrectValue'))

    const sliceBetween = (src, startMark, endMark) => {
      const start = src.indexOf(startMark)
      const end = start >= 0 ? src.indexOf(endMark, start) : -1
      return start >= 0 && end > start ? src.slice(start, end) : ''
    }

    const correctDateFn = sliceBetween(drawerSrc, 'const handleCorrectDate = async () => {', 'const canVoid')
    check('校验失败不发送请求（canCorrectDate 前置短路）',
      correctDateFn.includes('if (!canCorrectDate) return') &&
        correctDateFn.indexOf('if (!canCorrectDate) return') < correctDateFn.indexOf('correctDecisionDate'))
    check('保存失败保留用户输入（catch 不清空日期/原因）',
      correctDateFn.includes('} catch {') &&
        !correctDateFn.slice(correctDateFn.indexOf('} catch {')).includes('setDateCorrectValue') &&
        !correctDateFn.slice(correctDateFn.indexOf('} catch {')).includes('setDateCorrectReason'))
    check('同一失败请求仅弹一次（组件 catch 不重复 toast，由拦截器统一弹出）',
      !correctDateFn.includes('message.error('))
    check('保存成功刷新决策记录（loadHistory + onSaved）',
      correctDateFn.includes('await loadHistory()') && correctDateFn.includes('onSaved?.'))
    check('按钮防重复提交（loading + disabled）',
      drawerSrc.includes('disabled={!canCorrectDate}') && drawerSrc.includes('loading={dateCorrectSaving}') &&
        drawerSrc.includes('disabled={!canCorrectNegotiationDate}') && drawerSrc.includes('loading={negotiationDateSaving}'))

    const correctNegFn = sliceBetween(drawerSrc, 'const handleCorrectNegotiationDate = async () => {', 'const renderFacts')
    check('谈价纠正：校验失败不发送请求', correctNegFn.includes('if (!canCorrectNegotiationDate) return'))
    check('谈价纠正：保存失败保留输入', !correctNegFn.slice(correctNegFn.indexOf('} catch {')).includes('setNegotiationDateValue') && !correctNegFn.slice(correctNegFn.indexOf('} catch {')).includes('setNegotiationDateReason'))
    check('谈价纠正：同一失败请求仅弹一次（catch 不重复 toast）', !correctNegFn.includes('message.error('))
    check('谈价纠正：保存成功刷新记录', correctNegFn.includes('await loadHistory()') && correctNegFn.includes('onSaved?.'))

    const histCorrectFn = sliceBetween(historicalSrc, 'const canCorrectDate = isValidDateOnly', '保存纠正')
    check('历史补录纠正：校验失败不发送请求', histCorrectFn.includes('if (!canCorrectDate) return'))
    const histCatchBlock = histCorrectFn.slice(histCorrectFn.indexOf('} catch {'), histCorrectFn.indexOf('} finally {'))
    check('历史补录纠正：保存失败保留输入（catch 不清空输入）',
      !histCatchBlock.includes('message.error') &&
        !histCatchBlock.includes('setDateCorrectValue') &&
        !histCatchBlock.includes('setDateCorrectReason'))
    check('历史补录纠正：保存成功回传记录并关闭（onSaved / onClose）', histCorrectFn.includes('onSaved?.') && histCorrectFn.includes('onClose?.()'))
    const requestSrc = fs.readFileSync(path.join(root, 'frontend/src/utils/request.js'), 'utf8')
    check('request.js 错误拦截器是唯一 toast 来源（全局仅一处 message.error）',
      (requestSrc.match(/message\.error\(/g) || []).length === 1 && requestSrc.includes('return Promise.reject(error)'))

    check('helper 仍负责 camelCase → snake_case 转换（未改后端契约）',
      fs.readFileSync(path.join(root, 'frontend/src/api/creatorDecisions.js'), 'utf8').includes('{ decidedAt, reason }') &&
        fs.readFileSync(path.join(root, 'frontend/src/api/creatorNegotiationCases.js'), 'utf8').includes('{ negotiatedAt, reason }'))
  } finally {
    uninstallCapture()
  }

  console.log(`\n================ 测试汇总 ================`)
  console.log(`用例总数：${passCount + failCount}　通过：${passCount}　失败：${failCount}　通过率：${((passCount / (passCount + failCount)) * 100).toFixed(1)}%`)
  if (failCount > 0) {
    console.log('\n失败用例：')
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('测试执行异常：', error)
  process.exitCode = 1
})
