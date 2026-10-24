#!/usr/bin/env node
// Creator Decision Playbook V0.1 - Phase 3B 历史价格参考（Price Reference）回归测试
//
// 运行方式：node tests/creator_price_reference.test.js
// 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
// 网络：拦截 http/https/net/tls/fetch —— 本能力纯确定性计算，不调用 AI、不访问网络。

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'price-reference-'))
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
      throw new Error('price reference test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('price reference test forbids network requests')
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

const play = (value, type = 'sponsored', index = 1) => ({
  raw_text: String(value),
  excluded: false,
  content_type: type,
  source_image_index: 1,
  position_index: index
})

const OBSERVED_AT = '2026-10-03'

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const candidates = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorCandidates.js')).href
    )
    const snapshots = await import(
      pathToFileURL(path.join(root, 'backend/routes/recentSnapshots.js')).href
    )
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

    const candidateRouter = candidates.default
    const snapshotRouter = snapshots.default
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

    const createCandidate = findHandler(candidateRouter, '/', 'post')
    const saveCandidateSnapshot = findHandler(candidateRouter, '/:id/recent-snapshots', 'post')
    const priceRef = findHandler(candidateRouter, '/:id/price-reference', 'get')
    const historyPost = findHandler(snapshotRouter, '/', 'post')
    const historyLatest = findHandler(snapshotRouter, '/latest', 'get')

    // ---------- 固定历史投放池（temp DB）----------
    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES ('2026-W40', ?, ?, ?, '2026-08-20', ?, ?)`
    )
    const addRecord = (nickname, type, cost, first, sw) =>
      Number(insertRecord.run(nickname, type, cost, first, sw).lastInsertRowid)

    const idB = addRecord('案例B', '科普', 1080, 30000, 54000) // dist 2000, cpm 20（若误用 first 则为 36）
    const idC = addRecord('案例C', '历史类', 1500, 50000, 50000) // dist 2000
    const idD = addRecord('案例D', '个人成长类', 0, 48000, 48000) // dist 4000, cost=0
    const idE = addRecord('案例E', '个人成长类', 2100, 60000, 60000) // dist 8000
    const idA = addRecord('案例A', '个人成长类', 1500, 30000, 30000) // dist 22000
    const idH = addRecord('案例H', '历史类', 2000, null, 20000) // dist 32000（first 未观察，非 anomaly）
    const idI = addRecord('案例I', '科普', 500, 10000, 10000) // dist 42000
    const idF = addRecord('案例F', '科普', 1000, 99999, 99999) // dist 47999（同类型但很远）
    // 以下均应被排除
    addRecord('案例G', '科普', 2000, 100000, 100000) // >=10w
    addRecord('案例J', '科普', 100, 1000, null) // latest NULL
    addRecord('案例K', '科普', 100, 0, 0) // latest = 0
    addRecord('案例L', '科普', 900, 60000, 50000) // anomaly（latest < first）
    addRecord('案例M', '科普', null, 55000, 55000) // cost NULL
    addRecord('历史达人', '科普', 1000, 30000, 30000) // 供 legacy snapshot 回归用

    // ---------- candidates ----------
    const mkCand = async (name, type, plays) => {
      const c = await callRoute(createCandidate, { body: { name, creator_type: type } })
      if (plays) {
        await callRoute(saveCandidateSnapshot, {
          params: { id: String(c.data.id) },
          body: { observed_at: OBSERVED_AT, plays }
        })
      }
      return c.data
    }
    const candBase = await mkCand('目标达人', '科普', [
      play(50000, 'sponsored', 1), play(51000, 'sponsored', 2), play(53000, 'sponsored', 3), play(54000, 'sponsored', 4)
    ]) // sponsored median = 52000
    const candSameName = await mkCand('目标达人', '科普', [play(99999, 'sponsored', 1)]) // 同名，不同 id
    const candNoSponsored = await mkCand('无商单达人', '科普', [play(80000, 'organic', 1), play(90000, 'organic', 2)])
    const candHighScale = await mkCand('高量级达人', '科普', [play(100000, 'sponsored', 1)])
    const candNoSnapshot = await mkCand('无快照达人', '科普', null)

    console.log('===== 1. 启用条件 / 空态 =====')
    const noSnap = await callRoute(priceRef, { params: { id: String(candNoSnapshot.id) } })
    check('无 snapshot -> unavailable(no_snapshot)', noSnap.data?.available === false && noSnap.data?.reason_code === 'no_snapshot')
    const noSponsored = await callRoute(priceRef, { params: { id: String(candNoSponsored.id) } })
    check('sponsored=0 + organic>0 -> organic_proxy 代理基准（可启用）', noSponsored.data?.available === true && noSponsored.data?.target?.baseline_source === 'organic_proxy' && noSponsored.data?.target?.baseline_play === 85000, JSON.stringify(noSponsored.data?.target))
    check('organic_proxy 不伪造商单样本（sponsored_median 保持 NULL）', noSponsored.data?.target?.sponsored_median_play === null && noSponsored.data?.target?.sponsored_count === 0)
    const oneSponsored = await callRoute(priceRef, { params: { id: String(candSameName.id) } })
    check('sponsored_count=1 -> 可启用', oneSponsored.data?.available === true)
    check('target=99999 -> 启用基础池', oneSponsored.data?.target?.sponsored_median_play === 99999 && oneSponsored.data?.available === true)
    const high = await callRoute(priceRef, { params: { id: String(candHighScale.id) } })
    check('target=100000 -> high_scale_not_supported', high.data?.available === false && high.data?.reason_code === 'high_scale_not_supported')
    check('不存在的 candidate -> 404', (await callRoute(priceRef, { params: { id: '99999' } })).status === 404)

    console.log('\n===== 2. 历史池筛选 / 排序 / 数量 =====')
    const ref = await callRoute(priceRef, { params: { id: String(candBase.id) } })
    check('基础 target 为 52000', ref.data?.target?.sponsored_median_play === 52000, String(ref.data?.target?.sponsored_median_play))
    // 9 = 案例A/B/C/D/E/F/H/I（案例H first=NULL 不算 anomaly）+ 历史达人（seed 内同样合法）
    check('eligible_case_count = 9（NULL / 0 / anomaly / cost NULL / >=10w 均排除）', ref.data?.pool?.eligible_case_count === 9, String(ref.data?.pool?.eligible_case_count))
    check('最多返回 5 条', ref.data?.pool?.selected_case_count === 5 && ref.data?.cases?.length === 5)
    const order = (ref.data?.cases || []).map((c) => c.creator)
    check('按 abs(play distance) 升序', JSON.stringify(order) === JSON.stringify(['案例B', '案例C', '案例D', '案例E', '案例A']), JSON.stringify(order))
    check('distance 相同时按 record id 稳定排序（B 先于 C）', ref.data?.cases?.[0]?.creator === '案例B' && ref.data?.cases?.[1]?.creator === '案例C' && idB < idC)
    check('creator_type 不参与排序（同类型的案例F 未被提前）', !order.includes('案例F'))
    check('sw NULL 的案例J 被排除', !(ref.data?.cases || []).some((c) => c.creator === '案例J'))
    check('sw=0 的案例K 被排除', !(ref.data?.cases || []).some((c) => c.creator === '案例K'))
    check('anomaly 案例L 被排除', !(ref.data?.cases || []).some((c) => c.creator === '案例L'))
    check('cost NULL 的案例M 被排除', !(ref.data?.cases || []).some((c) => c.creator === '案例M'))
    check('>=10w 的案例G 被排除（不在基础池）', !(ref.data?.cases || []).some((c) => c.creator === '案例G'))

    console.log('\n===== 3. final CPM 语义 / cost=0 =====')
    const caseB = (ref.data?.cases || []).find((c) => c.creator === '案例B')
    check('final_cpm 使用 second_week_play（案例B = 1080/54000*1000 = 20）', caseB?.final_cpm === 20, String(caseB?.final_cpm))
    check('final_cpm 不是用 first_play 计算（否则为 36）', caseB?.final_cpm !== 36)
    const caseD = (ref.data?.cases || []).find((c) => c.creator === '案例D')
    check('total_cost=0 是合法案例且 final_cpm=0', caseD?.actual_cost === 0 && caseD?.final_cpm === 0)
    // first_play 未观察（NULL）不算 anomaly：以 target=20000 命中案例H（仅该项能距离 0）
    const cand20k = await mkCand('目标20000', '科普', [play(20000, 'sponsored', 1)])
    const ref20k = await callRoute(priceRef, { params: { id: String(cand20k.id) } })
    check('first_play=NULL 不算 anomaly 且可入池（target=20000 命中案例H）', ref20k.data?.cases?.[0]?.creator === '案例H' && ref20k.data?.cases?.[0]?.play_distance === 0, JSON.stringify(ref20k.data?.cases?.[0]))

    console.log('\n===== 4. summary（基于选中案例，非全池） =====')
    check('>=3 案例 -> summary 存在', Boolean(ref.data?.summary))
    check('cost_median 基于选中案例（=1500，非全池 1290）', ref.data?.summary?.cost_median === 1500, String(ref.data?.summary?.cost_median))
    check('cost_min / cost_max 正确（0 / 2100）', ref.data?.summary?.cost_min === 0 && ref.data?.summary?.cost_max === 2100)
    check('final_cpm_median 基于选中案例（=30）', ref.data?.summary?.final_cpm_median === 30, String(ref.data?.summary?.final_cpm_median))
    check('insufficient_for_range=false', ref.data?.insufficient_for_range === false)
    check('same_creator_type 是 boolean 元数据', ref.data?.cases?.every((c) => typeof c.same_creator_type === 'boolean'))
    check('same_creator_type 仅标注、不影响排序（案例B=true, 案例C=false）', (ref.data?.cases.find((c) => c.creator === '案例B')?.same_creator_type === true) && (ref.data?.cases.find((c) => c.creator === '案例C')?.same_creator_type === false))

    console.log('\n===== 5. 同名 candidate 不串 + 前端不可伪造 target =====')
    check('同名 candidate 各自按 candidate_id 取 snapshot（52000 vs 99999）', ref.data?.target?.sponsored_median_play === 52000 && oneSponsored.data?.target?.sponsored_median_play === 99999)
    const forged = await callRoute(priceRef, { params: { id: String(candBase.id) }, body: { target_play: 1 }, query: { target_play: 1 } })
    check('忽略前端提交的 target_play（仍取 52000）', forged.data?.target?.sponsored_median_play === 52000)

    console.log('\n===== 6. 不足 3 条 -> 不给区间 =====')
    // 仅保留 2 条 eligible（案例B / 案例C），其余删除
    db.prepare('DELETE FROM creator_records WHERE id NOT IN (?, ?)').run(idB, idC)
    const few = await callRoute(priceRef, { params: { id: String(candBase.id) } })
    check('<3 案例 -> summary = null', few.data?.summary === null)
    check('<3 案例 -> insufficient_for_range = true', few.data?.insufficient_for_range === true)
    check('<3 案例 -> 仍展示个案（2 条）', few.data?.pool?.selected_case_count === 2 && few.data?.pool?.eligible_case_count === 2)
    // eligible = 0 的空态
    db.prepare('DELETE FROM creator_records').run()
    const zero = await callRoute(priceRef, { params: { id: String(candBase.id) } })
    check('eligible = 0 -> available=true 且 cases 为空（前端显示"暂无符合口径案例"）', zero.data?.available === true && zero.data?.pool?.eligible_case_count === 0 && zero.data?.cases?.length === 0)

    console.log('\n===== 7. 不影响既有语义 / 无推荐字段 =====')
    check('response 不含 recommendation_score / recommended_price / should_invest', !JSON.stringify(ref.body).match(/recommendation_score|recommended_price|should_invest|similarity/i))
    const serialized = JSON.stringify(ref.data)
    check('response 不含相似度字段', !/similarity|score/i.test(serialized))
    // legacy 历史快照 / Radar 不受影响（price-reference 是纯只读）
    db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES ('2026-W41', '历史达人', '科普', 1000, '2026-08-25', 30000, 30000)`
    ).run()
    const histSave = await callRoute(historyPost, {
      body: { creator: '历史达人', recognized_creator_name_raw: '历史达人', observed_at: OBSERVED_AT, plays: [play(30000, 'sponsored', 1)] }
    })
    check('历史达人仍可保存 legacy snapshot（candidate_id NULL）', histSave.status === 200 && histSave.data?.candidate_id === null)
    const histLatest = await callRoute(historyLatest, { query: { creator: '历史达人' } })
    check('legacy latest 行为不变', histLatest.data?.snapshot?.id === histSave.data.id)
    const routeSet = candidateRouter.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort().join(' | ')
    check('候选路由集合新增 price-reference（只读 GET）', routeSet === 'GET / | GET /:id | GET /:id/decisions | GET /:id/price-reference | GET /:id/recent-snapshots/latest | PATCH /:id | POST / | POST /:id/decisions | POST /:id/post-quote-decisions | POST /:id/recent-snapshots | POST /:id/work-state', routeSet)
    check('未发生任何外部网络请求', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))
    check('隔离库位于临时目录（未触碰真实 workbench.db）', process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir()))
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
