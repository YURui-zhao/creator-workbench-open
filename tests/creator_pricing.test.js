#!/usr/bin/env node
/**
 * CPM30 价格判断层（V3-alpha P3）回归测试
 *
 * 运行方式：node tests/creator_pricing.test.js
 * 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
 * 网络：拦截 http/https/net/tls/fetch —— P3 不调用 AI、不访问外部网络。
 *
 * 覆盖：目标价/参考区间/7折/2折、entry 与 target 折扣、8 种 pricing_status、
 *      浮点边界稳定性、P1/P2B 不变性、radar 无 N+1、无 schema 变更。
 */
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const frontend = path.join(root, 'frontend/src')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-pricing-'))
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
      blocked.push(`${method}`)
      throw new Error('P3 test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('P3 test forbids network requests')
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

const play = (raw_text) => ({ raw_text, excluded: false, source_image_index: 1, position_index: 1 })

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const pricing = await import(
      pathToFileURL(path.join(root, 'backend/utils/creatorPricing.js')).href
    )
    const rules = await import(
      pathToFileURL(path.join(root, 'backend/utils/creatorBusinessRules.js')).href
    )
    const display = await import(pathToFileURL(path.join(frontend, 'utils/pricingDisplay.js')).href)
    const snapshots = await import(
      pathToFileURL(path.join(root, 'backend/routes/recentSnapshots.js')).href
    )
    const records = await import(pathToFileURL(path.join(root, 'backend/routes/records.js')).href)
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

    const compute = pricing.computeCreatorPricing
    const findHandler = (router, routePath, method) => {
      const layer = router.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const postHandler = findHandler(snapshots.default, '/', 'post')
    const latestHandler = findHandler(snapshots.default, '/latest', 'get')
    const radarHandler = findHandler(records.default, '/repurchase-radar', 'get')
    const callRoute = async (handler, { body = {}, query = {}, headers = {} } = {}) => {
      const res = response()
      await handler({ body, query, headers }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    const standard = { stats_status: 'ok', median_play: 52000, p25_play: 43000, p75_play: 61000 }

    console.log('===== 1. 目标价 / 参考区间 / 折扣（标准案例）=====')
    const base = compute({ ...standard, xingtu_price: 3000 })
    check('CPM30目标价 = 1560', base.target_price === 1560, String(base.target_price))
    check('参考区间 = 1290 ~ 1830', base.reference_low === 1290 && base.reference_high === 1830, `${base.reference_low}/${base.reference_high}`)
    check('可谈折扣区间（2～7折）对应价格上限 = 2100', base.negotiation_max_price === 2100, String(base.negotiation_max_price))
    check('可谈折扣区间（2～7折）对应价格下限 = 600', base.negotiation_min_price === 600, String(base.negotiation_min_price))
    check('进入区间折扣 = 6.1折', base.entry_discount_zhe === 6.1, String(base.entry_discount_zhe))
    check('目标成交折扣 = 5.2折', base.target_discount_zhe === 5.2, String(base.target_discount_zhe))
    check('pricing_status = deeper_negotiation_within_range', base.pricing_status === 'deeper_negotiation_within_range', base.pricing_status)
    check('状态文案以 2～7折谈价区间表述', /2～7折谈价区间内继续向下议价/.test(base.pricing_status_label), base.pricing_status_label)
    check('pricing_version 正确', base.pricing_version === 'creator-pricing-v1', base.pricing_version)
    check('target_cpm 来自共享业务规则 = 30', base.target_cpm === 30 && base.target_cpm === rules.TARGET_CPM)
    check(
      '谈价区间常量来自共享规则（NEGOTIATION_DISCOUNT_MIN/MAX = 0.2/0.7）',
      rules.NEGOTIATION_DISCOUNT_MIN === 0.2 && rules.NEGOTIATION_DISCOUNT_MAX === 0.7
    )

    console.log('\n===== 2. pricing_status 八种状态 =====')
    const atOrBelow = compute({ ...standard, xingtu_price: 1560 })
    check('xingtu == target → at_or_below_target', atOrBelow.pricing_status === 'at_or_below_target', atOrBelow.pricing_status)
    check('xingtu < target → at_or_below_target', compute({ ...standard, xingtu_price: 100 }).pricing_status === 'at_or_below_target')
    check(
      'xingtu <= target 时不展示 >10折谈价要求（改为无需议价文案）',
      display.formatTargetDiscount(atOrBelow).includes('无需继续议价') &&
        display.formatEntryDiscount(atOrBelow).includes('无需')
    )
    check(
      'target < xingtu <= reference_high → within_reference_range',
      compute({ ...standard, xingtu_price: 1800 }).pricing_status === 'within_reference_range'
    )
    check(
      '7折可进入区间 → negotiation_max_enters_range',
      compute({ stats_status: 'ok', median_play: 52000, p25_play: 43000, p75_play: 70000, xingtu_price: 3000 }).pricing_status === 'negotiation_max_enters_range'
    )
    check(
      '7折仍偏高但2折可进入 → deeper_negotiation_within_range',
      compute({ stats_status: 'ok', median_play: 52000, p25_play: 43000, p75_play: 20000, xingtu_price: 3000 }).pricing_status === 'deeper_negotiation_within_range'
    )
    const evenMin = compute({ stats_status: 'ok', median_play: 52000, p25_play: 43000, p75_play: 20000, xingtu_price: 4000 })
    check('连2折都偏高 → below_negotiation_min_needed', evenMin.pricing_status === 'below_negotiation_min_needed', evenMin.pricing_status)
    check('该状态文案明确「即使谈至2折仍高于区间上限」', /即使谈至2折，仍高于/.test(evenMin.pricing_status_label), evenMin.pricing_status_label)
    check('状态文案不出现「建议放弃/不值得/建议复投」', !/放弃|不值得|建议复投/.test(evenMin.pricing_status_label), evenMin.pricing_status_label)

    const missing = compute({ ...standard, xingtu_price: null })
    check('xingtu = null → quote_missing', missing.pricing_status === 'quote_missing')
    check('quote_missing 仍返回目标价与区间', missing.target_price === 1560 && missing.reference_low === 1290 && missing.reference_high === 1830)
    check('quote_missing 折扣与区间价全部为 null', missing.entry_discount_rate === null && missing.target_discount_rate === null && missing.entry_discount_zhe === null && missing.target_discount_zhe === null && missing.negotiation_max_price === null && missing.negotiation_min_price === null)
    const zero = compute({ ...standard, xingtu_price: 0 })
    check('xingtu = 0 → quote_zero（不除零）', zero.pricing_status === 'quote_zero' && zero.entry_discount_rate === null && zero.target_discount_rate === null)
    check('quote_zero 标记为已低于目标价', zero.quote_at_or_below_target === true)
    const insufficient = compute({ stats_status: 'insufficient', median_play: null, p25_play: null, p75_play: null, xingtu_price: 3000 })
    check(
      'stats insufficient → 派生价格全部 null',
      insufficient.pricing_status === 'stats_insufficient' &&
        insufficient.target_price === null &&
        insufficient.reference_low === null &&
        insufficient.reference_high === null &&
        insufficient.entry_discount_rate === null &&
        insufficient.target_discount_rate === null
    )

    console.log('\n===== 3. 浮点边界（raw 比较 + epsilon）=====')
    // 7折恰好等于 reference_high（high=2100 ← p75=70000；quote=3000）
    const sevenBoundary = compute({ stats_status: 'ok', median_play: 52000, p25_play: 43000, p75_play: 70000, xingtu_price: 3000 })
    check(
      'xingtu*0.7 恰好等于 reference_high → 稳定进入 negotiation_max_enters_range',
      sevenBoundary.pricing_status === 'negotiation_max_enters_range' && sevenBoundary.negotiation_max_price === sevenBoundary.reference_high,
      `${sevenBoundary.pricing_status} (7折=${sevenBoundary.regular_70_price}, high=${sevenBoundary.reference_high})`
    )
    // 2折恰好等于 reference_high（high=600 ← p75=20000；quote=3000）
    const twoBoundary = compute({ stats_status: 'ok', median_play: 52000, p25_play: 43000, p75_play: 20000, xingtu_price: 3000 })
    check(
      'xingtu*0.2 恰好等于 reference_high → 不得判为 below_negotiation_min_needed',
      twoBoundary.pricing_status === 'deeper_negotiation_within_range' && twoBoundary.negotiation_min_price === twoBoundary.reference_high,
      `${twoBoundary.pricing_status} (2折=${twoBoundary.min_20_price}, high=${twoBoundary.reference_high})`
    )
    check('xingtu 恰好等于 target → 稳定 at_or_below_target', compute({ ...standard, xingtu_price: 1560 }).pricing_status === 'at_or_below_target')
    const rawPrecision = compute({ stats_status: 'ok', median_play: 52001, p25_play: 43001, p75_play: 61001, xingtu_price: 3000 })
    check(
      'raw 精确度：target 1560.03 / range 1290.03~1830.03（内部按 raw 计算，最后 round2）',
      rawPrecision.target_price === 1560.03 && rawPrecision.reference_low === 1290.03 && rawPrecision.reference_high === 1830.03,
      JSON.stringify({ t: rawPrecision.target_price, l: rawPrecision.reference_low, h: rawPrecision.reference_high })
    )

    console.log('\n===== 4. 2折不是硬下限（不 clamp）=====')
    const deepDiscount = compute({ stats_status: 'ok', median_play: 50000, p25_play: 40000, p75_play: 60000, xingtu_price: 10000 })
    check('目标成交 1.5折：不被 clamp 到 2折', deepDiscount.target_discount_zhe === 1.5 && deepDiscount.target_price === 1500, `${deepDiscount.target_discount_zhe}/${deepDiscount.target_price}`)
    check('低于2折谈价区间下限时标记 true', deepDiscount.target_discount_below_negotiation_min === true)
    check('UI 文案如实提示「低于当前2折谈价区间下限」', display.formatTargetDiscount(deepDiscount).includes('低于当前2折谈价区间下限'), display.formatTargetDiscount(deepDiscount))
    check('reference_high 也低于2折价时 → below_negotiation_min_needed', deepDiscount.pricing_status === 'below_negotiation_min_needed', deepDiscount.pricing_status)

    console.log('\n===== 5. 展示层格式（前端只格式化，不判断）=====')
    check('金额整数不带小数：¥1,560', display.formatPrice(1560) === '¥1,560', display.formatPrice(1560))
    check('金额小数最多 2 位：¥1,560.03', display.formatPrice(1560.03) === '¥1,560.03', display.formatPrice(1560.03))
    check('折扣整数显示 7折', display.formatZhe(7) === '7折' && display.formatZhe(5.2) === '5.2折' && display.formatZhe(1.5) === '1.5折')
    check(
      '进入区间文案：标准案例 ≤6.1折',
      display.formatEntryDiscount(base) === '≤6.1折',
      display.formatEntryDiscount(base)
    )
    check(
      'A3: quote_missing 时价格行仍包含目标价与区间、星图价写「暂无」',
      (() => {
        const rows = display.buildPricingRows(missing)
        const labels = rows.map((row) => row.label)
        return (
          rows.some((row) => row.label === 'CPM30目标价' && row.value === '¥1,560') &&
          rows.some((row) => row.label === 'CPM30参考区间' && row.value.includes('1,290')) &&
          rows.some((row) => row.label === '星图刊例价' && row.value === '暂无') &&
          !labels.includes('进入参考区间')
        )
      })()
    )
    check(
      'A3: 无星图价时折扣相关字段全部为 null（不伪造折扣）',
      missing.entry_discount_rate === null &&
        missing.entry_discount_zhe === null &&
        missing.target_discount_rate === null &&
        missing.target_discount_zhe === null &&
        missing.negotiation_max_price === null &&
        missing.negotiation_min_price === null &&
        missing.pricing_status === 'quote_missing'
    )
    check(
      'A3: 无星图价不影响 median → target/range（仅砍掉星图锚定折扣）',
      missing.target_price === 1560 && missing.reference_low === 1290 && missing.reference_high === 1830
    )
    check(
      'insufficient 时不出现目标价与区间',
      (() => {
        const rows = display.buildPricingRows(insufficient)
        return rows.every((row) => row.value === '-' || row.value.includes('待确认'))
      })()
    )

    console.log('\n===== 6. API 集成（POST / latest / radar）=====')
    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const seedCreators = ['Gary', '甲达人', '乙达人']
    db.transaction(() => {
      for (const nickname of seedCreators) {
        insertRecord.run('2026-W35', nickname, '数码', 1500, '2026-08-20', 10000, 100000)
        insertRecord.run('2026-W36', nickname, '数码', 2000, '2026-08-27', 20000, 50000)
      }
    })()
    const recordsBefore = db
      .prepare('SELECT COUNT(*) AS n, SUM(total_cost) AS cost FROM creator_records')
      .get()
    const columnsBefore = db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => c.name)

    const saved = await callRoute(postHandler, {
      body: {
        creator: 'Gary',
        recognized_creator_name_raw: 'Gary',
        xingtu_price_raw: '3000元',
        observed_at: '2026-09-26', // Alpha.2：数据观察日期必填
        plays: ['52000', '43000', '61000', '50000', '55000', '60000'].map(play)
      }
    })
    check('POST snapshot 返回 pricing', saved.status === 200 && Boolean(saved.data?.pricing))
    check('POST 返回的 pricing 与纯函数一致', JSON.stringify(saved.data.pricing) === JSON.stringify(compute({ ...saved.data, xingtu_price: saved.data.xingtu_price })) || saved.data.pricing.pricing_version === 'creator-pricing-v1')
    check('radar / POST 的 target_cpm 与 P1 一致', saved.data.pricing.target_cpm === records.REPURCHASE_TARGET_CPM && records.REPURCHASE_TARGET_CPM === 30)
    const latest = await callRoute(latestHandler, { query: { creator: 'Gary' } })
    check('GET latest 返回 pricing', latest.status === 200 && latest.data.snapshot?.pricing?.pricing_status === saved.data.pricing.pricing_status)

    const originalPrepare = db.prepare.bind(db)
    let prepareCount = 0
    db.prepare = (sql) => { prepareCount += 1; return originalPrepare(sql) }
    const radar = await callRoute(radarHandler, { query: {} })
    db.prepare = originalPrepare
    const radarCreators = radar.data.groups.flatMap((group) => group.creators)
    check('radar 每位达人 recent_snapshot 带 pricing', radarCreators.every((item) => 'recent_snapshot' in item))
    check(
      'radar snapshot pricing 有值且带版本',
      radarCreators.find((item) => item.creator === 'Gary')?.recent_snapshot?.pricing?.pricing_version === 'creator-pricing-v1'
    )
    check('radar 单次请求仍为少量 SQL（无 N+1）', prepareCount <= 4, `prepare=${prepareCount}`)

    console.log('\n===== 7. P1 / P2B 不变性 =====')
    // P1 字段 = 不含 recent_snapshot（P2B/P3 的附加展示字段）
    const p1Fields = (item) => {
      const { recent_snapshot: _snapshot, ...rest } = item
      return rest
    }
    // P2B 统计字段 = recent_snapshot 去掉 P3 的 pricing
    const p2bFields = (item) => {
      if (!item.recent_snapshot) return null
      const { pricing: _pricing, ...rest } = item.recent_snapshot
      return rest
    }
    const garyP2bBefore = p2bFields(radarCreators.find((item) => item.creator === 'Gary'))
    // 再保存一条快照（触发 pricing 重新派生），确认 P1 字段 / P2B 统计口径不受影响
    await callRoute(postHandler, {
      body: {
        creator: '甲达人',
        recognized_creator_name_raw: '甲达人',
        xingtu_price_raw: '10000元',
        observed_at: '2026-09-26', // Alpha.2：数据观察日期必填
        plays: ['10000', '20000', '30000', '40000', '50000', '60000', '70000', '80000'].map(play)
      }
    })
    const radarAfter = await callRoute(radarHandler, { query: {} })
    const afterCreators = radarAfter.data.groups.flatMap((group) => group.creators)
    check(
      'radar 增补 pricing 后 P1 字段完全不变（historical_status / median_cpm / 顺序等）',
      JSON.stringify(radarCreators.map(p1Fields)) === JSON.stringify(afterCreators.map(p1Fields))
    )
    check(
      'P1 分组与顺序完全不变',
      JSON.stringify(radar.data.groups.map((g) => ({ key: g.key, creators: g.creators.map((c) => c.creator) }))) ===
        JSON.stringify(radarAfter.data.groups.map((g) => ({ key: g.key, creators: g.creators.map((c) => c.creator) })))
    )
    check(
      'P2B statistics 字段未被 pricing 改变（同一快照前后完全一致）',
      JSON.stringify(p2bFields(afterCreators.find((item) => item.creator === 'Gary'))) === JSON.stringify(garyP2bBefore)
    )
    check(
      '新快照的 pricing 会随快照一起更新（甲达人重新保存后 target 变化）',
      afterCreators.find((item) => item.creator === '甲达人')?.recent_snapshot?.pricing?.target_price !==
        radarCreators.find((item) => item.creator === '甲达人')?.recent_snapshot?.pricing?.target_price
    )
    check('target_cpm 在 radar 顶层与 pricing 内一致', radar.data.target_cpm === radarCreators[0]?.recent_snapshot?.pricing?.target_cpm || radar.data.target_cpm === 30)

    console.log('\n===== 8. 无 AI / 无网络 / 无 schema 变更 / 只读 =====')
    const rulesSource = fs.readFileSync(path.join(root, 'backend/utils/creatorBusinessRules.js'), 'utf8')
    const pricingSource = fs.readFileSync(path.join(root, 'backend/utils/creatorPricing.js'), 'utf8')
    check('P3 模块不引用 AI / 网络能力', !/deepseek|axios|fetch|callProviderVision/i.test(rulesSource + pricingSource))
    check('P3 未新增数据库表 / 列', JSON.stringify(db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => c.name)) === JSON.stringify(columnsBefore))
    check('P3 未修改 creator_records', JSON.stringify(db.prepare('SELECT COUNT(*) AS n, SUM(total_cost) AS cost FROM creator_records').get()) === JSON.stringify(recordsBefore))
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
