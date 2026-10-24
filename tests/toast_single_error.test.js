#!/usr/bin/env node
/**
 * 重复 Toast 修复回归测试（Round 3 / 3A）
 *
 * 背景：request.js 响应拦截器统一弹出错误 toast；部分组件 catch 内又调用
 * message.error，导致同一次失败请求弹两次。本轮修复了 4 处确认重复：
 *   - CreatorDecisionDrawer 作废（catch 只复位 loading，弹窗保留输入）
 *   - CreatorDecisionDrawer 解除关联（Modal.confirm onOk：移除重复 toast 并保留
 *     异常抛出，失败时确认框保持打开）
 *   - ImportHistory 撤销导入 / 删除导入历史（移除重复 toast，保留 throw err）
 *
 * 测试分两层：
 *   1. HTTP 功能层：http 桩捕获真实 axios 请求（400 / 500 / 网络失败各一次请求、
 *      一次拒绝）。toast 渲染本身依赖浏览器 DOM，无法在 Node 断言；单次提示
 *      的不变量由第 2 层源码断言锁定（request.js 唯一 message.error + 各 catch 零重复）。
 *   2. 源码形状层：修复后的 catch 形状、保留的本地校验 toast、成功 toast、
 *      Modal.confirm 的 throw err 行为。
 */
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const events = require('node:events')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
process.env.WORKBENCH_DB_PATH = path.join(os.tmpdir(), `toast-single-${Date.now()}.db`)

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

// ---------- HTTP 桩：可切换响应模式，绝不建立真实连接 ----------
const captured = []
let mode = 'ok400' // ok400 | ok500 | networkFail
const originalHttpRequest = http.request
const originalHttpsRequest = https.request

function fakeRespond(req, statusCode, body) {
  setImmediate(() => {
    const res = new events.EventEmitter()
    res.statusCode = statusCode
    res.statusMessage = String(statusCode)
    res.headers = { 'content-type': 'application/json' }
    res.rawHeaders = ['content-type', 'application/json']
    res.resume = () => {}
    res.pause = () => {}
    res.setEncoding = () => {}
    req.emit('response', res)
    setImmediate(() => {
      res.emit('data', Buffer.from(body))
      res.emit('end')
    })
  })
}

function installStub() {
  const handle = (options, cb) => {
    captured.push({ method: String(options.method || 'GET').toUpperCase(), path: String(options.path || '') })
    const req = new events.EventEmitter()
    req.socket = Object.assign(new events.EventEmitter(), {
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
    req.write = () => true
    req.end = () => {
      setImmediate(() => {
        if (mode === 'networkFail') {
          const err = new Error('connect ECONNREFUSED 127.0.0.1:3001')
          err.code = 'ECONNREFUSED'
          req.emit('error', err)
          return
        }
        if (mode === 'ok500') fakeRespond(req, 500, JSON.stringify({ code: 500, data: null, msg: '服务器内部错误' }))
        else fakeRespond(req, 400, JSON.stringify({ code: 400, data: null, msg: '业务校验失败' }))
      })
    }
    if (typeof cb === 'function') req.on('response', cb)
    return req
  }
  http.request = (options, cb) => handle(typeof options === 'string' ? require('node:url').parse(options) : options, cb)
  https.request = http.request
}

function uninstallStub() {
  http.request = originalHttpRequest
  https.request = originalHttpsRequest
}

async function main() {
  installStub()
  try {
    const requestModule = await import(
      pathToFileURL(path.join(root, 'frontend/src/utils/request.js')).href
    )
    const request = requestModule.default
    // axios node adapter 需要绝对 URL；/api 前缀与真实 Vite 代理链路一致
    request.defaults.baseURL = 'http://127.0.0.1:3001/api'
    // toast 渲染依赖浏览器 DOM（antd message），这里移除响应拦截器以隔离 HTTP 行为；
    // 拦截器的单次 toast 不变量由下方源码断言锁定
    request.interceptors.response.clear()

    const decisionsApi = await import(
      pathToFileURL(path.join(root, 'frontend/src/api/creatorDecisions.js')).href
    )

    console.log('===== 1. 单次 HTTP 错误 → 单次请求、单次拒绝 =====')
    let count = captured.length
    let rejected = null
    try {
      await decisionsApi.correctDecisionDate(23, { decidedAt: '2026-08-18', reason: '400 场景' })
    } catch (error) {
      rejected = error
    }
    check('HTTP 400 → 恰好一次请求', captured.length - count === 1)
    check('HTTP 400 → 恰好一次拒绝（含后端 msg，不吞异常）',
      rejected && rejected.response && rejected.response.status === 400 && rejected.response.data.msg === '业务校验失败',
      JSON.stringify(rejected && rejected.response && rejected.response.data))

    count = captured.length
    rejected = null
    mode = 'ok500'
    try {
      await decisionsApi.voidDecision(23, { reason: '500 场景' })
    } catch (error) {
      rejected = error
    }
    check('HTTP 500 → 恰好一次请求、一次拒绝（status=500）',
      captured.length - count === 1 && rejected && rejected.response && rejected.response.status === 500)

    count = captured.length
    rejected = null
    mode = 'networkFail'
    try {
      await decisionsApi.voidDecision(23, { reason: '网络失败场景' })
    } catch (error) {
      rejected = error
    }
    check('网络失败 → 恰好一次请求、一次拒绝（无 response，不产生第二请求）',
      captured.length - count === 1 && rejected && rejected.response === undefined && rejected.code === 'ECONNREFUSED')
    mode = 'ok400'

    console.log('\n===== 2. 源码形状：唯一 toast 来源 + 修复点零重复 =====')
    const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
    const requestSrc = read('frontend/src/utils/request.js')
    const drawerSrc = read('frontend/src/components/CreatorDecisionDrawer.jsx')
    const importHistorySrc = read('frontend/src/pages/ImportHistory/index.jsx')
    const excelSrc = read('frontend/src/components/ExcelImportModal.jsx')
    const recordsSrc = read('frontend/src/pages/Records/index.jsx')
    const playbookSrc = read('frontend/src/pages/CreatorPlaybook/index.jsx')

    check('request.js 错误拦截器是唯一 toast 调用点（全局仅一处 message.error）',
      (requestSrc.match(/message\.error\(/g) || []).length === 1 &&
        requestSrc.includes('return Promise.reject(error)'))

    check('修复点1：作废 catch 不再重复 toast（保留输入与 loading 复位）',
      drawerSrc.includes('作废弹窗保留用户输入') &&
        !drawerSrc.includes('作废失败，请稍后重试') &&
        drawerSrc.includes('setVoidSaving(false)'))
    check('修复点2：解除关联保留异常抛出（Modal.confirm 失败不关闭）且不重复 toast',
      drawerSrc.includes('throw error') &&
        !drawerSrc.includes('message.error(getErrorMessage(error))') &&
        drawerSrc.includes('message.success(\'已解除关联\')'))
    check('修复点3：撤销导入保留 throw err 且不重复 toast',
      importHistorySrc.includes('继续抛出让确认框保持打开') &&
        importHistorySrc.includes('throw err') &&
        !importHistorySrc.includes('撤销导入失败，请稍后重试'))
    check('修复点4：删除导入历史保留 throw err 且不重复 toast',
      importHistorySrc.includes('throw err') &&
        !importHistorySrc.includes('删除导入历史失败，请稍后重试'))

    console.log('\n===== 3. 语义保留：本地校验 / 成功 / 警告 toast 未被误删 =====')
    check('文件解析失败（非 HTTP 本地错误）仍提示',
      (excelSrc.match(/文件解析失败：/g) || []).length === 2)
    check('导入前本地校验未通过仍提示（非 HTTP）',
      excelSrc.includes("message.error('导入前本地校验未通过，请重新检查记录')"))
    check('时间周期解析失败仍提示（非 HTTP）',
      recordsSrc.includes('时间周期解析失败，请选择完整自然周（周一至周日）'))
    check('剪贴板复制失败仍提示（非 HTTP）',
      playbookSrc.includes('复制失败，请手动复制星图 ID'))
    check('成功 / 警告语义未被误删',
      drawerSrc.includes("message.success('该决策已作废（历史与关联事实保留）')") &&
        drawerSrc.includes("message.success('已解除关联')") &&
        importHistorySrc.includes('已撤销导入，删除') &&
        importHistorySrc.includes("message.warning('该批次仍有关联投放记录，请先撤销导入。')"))
    check('不影响既有日期纠正双 toast 修复（组件内零 message.error 保持）',
      !drawerSrc.includes('message.error('))

    check('隔离库位于临时目录（未触碰真实 workbench.db）',
      process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir()))
  } finally {
    uninstallStub()
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
