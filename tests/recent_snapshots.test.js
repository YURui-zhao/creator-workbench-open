#!/usr/bin/env node
/**
 * 近期表现快照（V3-alpha P2B）回归测试
 *
 * 运行方式：node tests/recent_snapshots.test.js
 * 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
 * 网络：拦截 http/https/net/tls/fetch —— P2B 不调用 AI、不访问外部网络。
 *
 * 覆盖：schema/migration、append-only、creator 归属与身份确认、raw->valid->analysis 三层、
 *      median/P25/P75 插值、去极值、trend 阈值与边界、plays_json 可还原、radar 批量合并（无 N+1）、
 *      P1 规则不变、只读 creator_records、敏感字段不入库。
 */
const assert = require('node:assert/strict')
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

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-snapshots-'))
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
      throw new Error('P2B test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('P2B test forbids network requests')
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

const play = (raw_text, extra = {}) => ({
  raw_text,
  excluded: false,
  source_image_index: 1,
  position_index: 1,
  ...extra
})

// Alpha.2：observed_at 必填。默认观察日期仅用于「与 observed_at 语义无关」的既有用例；
// observed_at 专项语义在最后新增的小节中单独覆盖。
const DEFAULT_OBSERVED_AT = '2026-09-29'

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const snapshots = await import(
      pathToFileURL(path.join(root, 'backend/routes/recentSnapshots.js')).href
    )
    const stats = await import(
      pathToFileURL(path.join(root, 'backend/utils/recentPerformanceStats.js')).href
    )
    const records = await import(pathToFileURL(path.join(root, 'backend/routes/records.js')).href)
    const decisions = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorDecisions.js')).href
    )
    const saveLib = await import(
      pathToFileURL(path.join(frontend, 'utils/recentPerformanceSave.js')).href
    )
    const draftLib = await import(
      pathToFileURL(path.join(frontend, 'utils/recentPerformanceDraft.js')).href
    )
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

    const snapshotRouter = snapshots.default
    const findHandler = (router, routePath, method) => {
      const layer = router.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const postHandler = findHandler(snapshotRouter, '/', 'post')
    const latestHandler = findHandler(snapshotRouter, '/latest', 'get')
    const radarHandler = findHandler(records.default, '/repurchase-radar', 'get')
    const createDecisionHandler = findHandler(decisions.default, '/', 'post')

    const callRoute = async (handler, { body = {}, query = {}, headers = {} } = {}) => {
      const res = response()
      await handler({ body, query, headers }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }
    // 对象 payload 自动带上 observed_at（Alpha.2 起必填）；数组等非法 body 原样透传，
    // 以便「请求体不是对象 → 400」这类既有断言仍然走原路径。
    const save = (payload, headers) => {
      const body =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? { observed_at: DEFAULT_OBSERVED_AT, ...payload }
          : payload
      return callRoute(postHandler, { body, headers })
    }
    const latest = (creator) => callRoute(latestHandler, { query: { creator } })
    const radar = () => callRoute(radarHandler, { query: {} })

    console.log('===== 1. 表结构 / migration 行为 =====')
    const columns = db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => c.name)
    const expectedColumns = [
      'id', 'creator', 'recognized_creator_name_raw', 'source_type', 'xingtu_price_raw',
      'xingtu_price', 'plays_json', 'recognized_count', 'valid_count', 'excluded_count',
      'unresolved_count', 'analysis_count', 'median_play', 'p25_play', 'p75_play',
      'recent_median_play', 'prior_median_play', 'trend_ratio', 'trend_label',
      'stats_status', 'stats_version', 'created_at', 'observed_at'
    ]
    check('creator_recent_snapshots 列齐全', expectedColumns.every((name) => columns.includes(name)), JSON.stringify(columns))
    // DDL 类型回归守卫：每列必须显式声明类型，禁止「逗号前共享类型」写法导致无类型列
    const columnTypes = Object.fromEntries(
      db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => [c.name, c.type])
    )
    check(
      'count 列类型均为 INTEGER',
      ['recognized_count', 'valid_count', 'excluded_count', 'unresolved_count', 'analysis_count'].every(
        (name) => columnTypes[name] === 'INTEGER'
      ),
      JSON.stringify(columnTypes)
    )
    check(
      '典型统计列类型均为 REAL',
      ['median_play', 'p25_play', 'p75_play'].every((name) => columnTypes[name] === 'REAL')
    )
    check(
      '趋势统计列类型均为 REAL',
      ['recent_median_play', 'prior_median_play', 'trend_ratio'].every(
        (name) => columnTypes[name] === 'REAL'
      )
    )
    check(
      '状态列类型均为 TEXT',
      ['trend_label', 'stats_status', 'stats_version', 'observed_at'].every((name) => columnTypes[name] === 'TEXT')
    )
    check(
      '没有任何列缺失类型声明',
      Object.values(columnTypes).every((type) => typeof type === 'string' && type.trim() !== ''),
      JSON.stringify(columnTypes)
    )
    const notNull = Object.fromEntries(
      db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => [c.name, c.notnull])
    )
    check(
      'count / 状态列 NOT NULL（统计列保持可空以便 insufficient）',
      ['recognized_count', 'valid_count', 'excluded_count', 'unresolved_count', 'analysis_count', 'trend_label', 'stats_status', 'stats_version'].every(
        (name) => notNull[name] === 1
      ) &&
        ['median_play', 'p25_play', 'p75_play', 'recent_median_play', 'prior_median_play', 'trend_ratio'].every(
          (name) => notNull[name] === 0
        ),
      JSON.stringify(notNull)
    )
    const indexes = db.prepare('PRAGMA index_list(creator_recent_snapshots)').all().map((i) => i.name)
    check('存在 creator + created_at 查询索引', indexes.includes('idx_recent_snapshots_creator_created'), JSON.stringify(indexes))
    check('新表初始为空（无可选手动保存）', db.prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots').get().n === 0)
    const v2Tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name)
    check(
      'V2 表未被删除/重命名',
      ['creator_records', 'import_batches', 'import_batch_records', 'import_batch_items', 'projects'].every((name) => v2Tables.includes(name)),
      JSON.stringify(v2Tables)
    )
    check(
      'creator_records 列未变化',
      ['id', 'time_cycle', 'nickname', 'creator_type', 'total_cost', 'publish_date', 'first_play', 'second_week_play'].every((name) =>
        db.prepare('PRAGMA table_info(creator_records)').all().map((c) => c.name).includes(name)
      )
    )

    // 历史投放记录（radar 与 creator 归属校验都依赖它）
    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const seedCreators = ['Gary', '甲达人', '乙达人', '丙达人', '丁达人', '戊达人']
    db.transaction(() => {
      for (const [index, nickname] of seedCreators.entries()) {
        insertRecord.run(`2026-W3${3 + (index % 2)}`, nickname, '数码', 1000 + index, '2026-08-20', 10000, 100000)
        insertRecord.run(`2026-W3${4 + (index % 2)}`, nickname, '数码', 2000 + index, '2026-08-27', 20000, 50000)
      }
    })()
    const recordsBefore = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
    const recordsChecksumBefore = db
      .prepare('SELECT COUNT(*) AS n, SUM(total_cost) AS cost, SUM(second_week_play) AS plays FROM creator_records')
      .get()

    console.log('\n===== 2. 保存 / append-only / latest =====')
    const first = await save({
      creator: 'Gary',
      recognized_creator_name_raw: 'Gary',
      xingtu_price_raw: '¥3,000',
      plays: [play('5.2万'), play('4.8万'), play('6.1万'), play('5.5万'), play('1万'), play('9000')]
    })
    check('首次保存返回 200', first.status === 200, JSON.stringify(first.msg))
    check('返回完整 public snapshot', Boolean(first.data?.id) && first.data.creator === 'Gary' && Array.isArray(first.data.plays))
    check('stats_version 正确保存', first.data?.stats_version === 'recent-performance-v2', String(first.data?.stats_version))
    check('source_type 固定 screenshot', first.data?.source_type === 'screenshot')

    const second = await save({
      creator: 'Gary',
      recognized_creator_name_raw: 'Gary',
      xingtu_price_raw: '3000元',
      plays: [play('6万'), play('7万'), play('8万'), play('9万'), play('10万'), play('11万')]
    })
    check('同达人第二次保存新增一条（append-only，不覆盖）', second.status === 200 && second.data.id !== first.data.id, `${first.data?.id} -> ${second.data?.id}`)
    check(
      '两条快照都存在且内容独立',
      db.prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots WHERE creator = ?').get('Gary').n === 2 &&
        first.data.median_play !== second.data.median_play
    )
    const garyLatest = await latest('Gary')
    check('GET latest 返回真正最新的一条', garyLatest.status === 200 && garyLatest.data.snapshot?.id === second.data.id, `latest=${garyLatest.data?.snapshot?.id}`)
    check('无法达人的 latest 返回 null（不是错误）', (await latest('甲达人')).data?.snapshot === null)
    check('latest 缺少 creator → 400', (await latest('')).status === 400)

    console.log('\n===== 3. 后端重新解析（不信任前端派生值）=====')
    const tampered = await save({
      creator: '甲达人',
      recognized_creator_name_raw: '甲达人',
      xingtu_price_raw: '面议',
      plays: [
        { raw_text: '5.2万', normalized_play: 999999, excluded: false, source_image_index: 1, position_index: 1 },
        { raw_text: '3万', normalized_play: 1, excluded: false, source_image_index: 1, position_index: 2 },
        { raw_text: '4万', normalized_play: 2, excluded: false, source_image_index: 1, position_index: 3 },
        { raw_text: '5万', normalized_play: 3, excluded: false, source_image_index: 1, position_index: 4 },
        { raw_text: '6万', normalized_play: 4, excluded: false, source_image_index: 1, position_index: 5 },
        { raw_text: '7万', normalized_play: 5, excluded: false, source_image_index: 1, position_index: 6 }
      ],
      median_play: 1,
      p25_play: 1,
      p75_play: 1,
      valid_count: 999,
      stats_version: 'evil-version',
      base64: 'AAAABBBB',
      apiKey: 'sk-should-not-be-stored',
      provider_response: { raw: 'x' }
    })
    check('含伪造派生值的请求仍以 raw_text 为准', tampered.data?.plays?.[0]?.normalized_play === 52000, String(tampered.data?.plays?.[0]?.normalized_play))
    check('伪造的 valid_count / stats_version 被忽略', tampered.data?.valid_count === 6 && tampered.data?.stats_version === 'recent-performance-v2', `${tampered.data?.valid_count}/${tampered.data?.stats_version}`)
    const storedRow = db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(tampered.data.id)
    const storedText = JSON.stringify(storedRow)
    check('base64 / apiKey / provider_response 均未入库', !storedText.includes('AAAABBBB') && !storedText.includes('sk-should-not-be-stored') && !storedText.includes('provider_response'))
    check('响应中同样不含敏感字段', !JSON.stringify(tampered.body).includes('sk-should-not-be-stored') && !JSON.stringify(tampered.body).includes('AAAABBBB'))
    check('无法解析的星图价仍可保存（价格 null）', tampered.status === 200 && tampered.data.xingtu_price === null && tampered.data.xingtu_price_raw === '面议')

    console.log('\n===== 4. raw -> valid -> analysis 三层 =====')
    const mixed = await save({
      creator: '乙达人',
      recognized_creator_name_raw: '乙达人',
      xingtu_price_raw: '¥1000',
      plays: [
        play('0'), // 0 是真实观测，必须有效
        play('1万'),
        play('2万'),
        play('3万', { excluded: true }), // 排除：不进入有效样本
        play('看不清'), // 未排除但解析失败 -> unresolved
        { raw_text: null, excluded: false, source_image_index: 1, position_index: 6 }
      ]
    })
    check('recognized_count = 全部行数', mixed.data?.recognized_count === 6, String(mixed.data?.recognized_count))
    check('excluded_count = 排除数', mixed.data?.excluded_count === 1, String(mixed.data?.excluded_count))
    check('unresolved_count = 未排除但无法解析', mixed.data?.unresolved_count === 2, String(mixed.data?.unresolved_count))
    check('valid_count 只含未排除且可解析（0 也算有效）', mixed.data?.valid_count === 3, String(mixed.data?.valid_count))
    check('valid_count < 5 → stats_status=insufficient 且统计值为 null', mixed.data?.stats_status === 'insufficient' && mixed.data?.median_play === null && mixed.data?.p25_play === null && mixed.data?.p75_play === null && mixed.data?.analysis_count === 0)
    check('样本不足仍允许保存（不阻止写库）', mixed.status === 200)

    console.log('\n===== 5. 典型统计：去极值 / median / P25-P75 =====')
    const fifteenRaw = ['1万', '2万', '3万', '4万', '5万', '6万', '7万', '8万', '9万', '10万', '11万', '12万', '13万', '14万', '15万']
    const fifteen = await save({ creator: '丙达人', recognized_creator_name_raw: '丙达人', plays: fifteenRaw.map((text, index) => play(text, { position_index: index + 1 })) })
    check('15 条有效 → 去最高最低 → analysis_count = 13', fifteen.data?.valid_count === 15 && fifteen.data?.analysis_count === 13, `${fifteen.data?.valid_count}/${fifteen.data?.analysis_count}`)
    // 去极值后 analysis = [2万..14万]（13 条）：median 取第 7 个 = 8万；
    // P25 position = (13-1)*0.25 = 3 → 第 4 个 = 5万；P75 position = 12*0.75 = 9 → 第 10 个 = 11万
    check('15 条 1万~15万：median=8万、P25=5万、P75=11万', fifteen.data?.median_play === 80000 && fifteen.data?.p25_play === 50000 && fifteen.data?.p75_play === 110000, JSON.stringify({ m: fifteen.data?.median_play, p25: fifteen.data?.p25_play, p75: fifteen.data?.p75_play }))
    const medianEven = stats.computeRecentPerformanceStats([10000, 20000, 30000, 40000, 50000, 60000])
    check('偶数样本 median 取中间两项平均（3.5万）', medianEven.median_play === 35000, String(medianEven.median_play))
    const medianOdd = stats.computeRecentPerformanceStats([10000, 20000, 30000, 40000, 50000, 60000, 70000])
    check('奇数样本 median 取中间值（4万）', medianOdd.median_play === 40000, String(medianOdd.median_play))
    const interpolated = stats.computeRecentPerformanceStats([10000, 20000, 30000, 40000, 50000, 60000])
    // 去极值后 [2万,3万,4万,5万]；P25 position=(4-1)*0.25=0.75 → 2万+0.75×1万 = 2.75万；
    // P75 position=3*0.75=2.25 → 4万+0.25×1万 = 4.25万（线性插值）
    check('P25/P75 采用 linear interpolation（2.75万 / 4.25万）', interpolated.p25_play === 27500 && interpolated.p75_play === 42500, JSON.stringify({ p25: interpolated.p25_play, p75: interpolated.p75_play }))
    const duplicated = stats.computeRecentPerformanceStats([10000, 10000, 10000, 10000, 10000, 10000, 10000])
    check('重复极值只各移除一个观测（7 → 5）', duplicated.analysis_count === 5, String(duplicated.analysis_count))
    const duplicatedEdge = stats.computeRecentPerformanceStats([10000, 10000, 10000, 10000, 10000, 20000, 20000, 20000, 20000, 20000])
    check('重复最高最低各只移除一个（10 → 8）', duplicatedEdge.analysis_count === 8, String(duplicatedEdge.analysis_count))

    console.log('\n===== 6. 趋势算法（±20% 常量 / 边界 / 不除零 / 不提前 round）=====')
    // Phase audit 顺序契约：录入顺序 = 从旧到新 → recent 组在数组末尾
    const trendCase = (recent, prior) => stats.computeRecentPerformanceStats([...prior, ...recent])
    check('valid < 8 → trend insufficient 且无统计值', trendCase([1, 2, 3, 4, 5], [6, 7]).trend_label === 'insufficient' && trendCase([1, 2, 3, 4, 5], [6, 7]).recent_median_play === null)
    check('阈值常量集中在后端（TREND_THRESHOLD_PERCENT = 20）', stats.TREND_THRESHOLD_PERCENT === 20 && stats.TREND_THRESHOLD === 0.2)
    check('+20% 边界 → up', trendCase([12000, 12000, 12000, 12000, 12000], [10000, 10000, 10000]).trend_label === 'up')
    check('-20% 边界 → down', trendCase([8000, 8000, 8000, 8000, 8000], [10000, 10000, 10000]).trend_label === 'down')
    check('介于 ±20% → stable', trendCase([11000, 11000, 11000, 11000, 11000], [10000, 10000, 10000]).trend_label === 'stable')
    const zeroPrior = trendCase([5000, 5000, 5000, 5000, 5000], [0, 0, 0])
    check('prior median = 0 且 recent > 0 → up（不除零）', zeroPrior.trend_label === 'up' && zeroPrior.trend_ratio === null, JSON.stringify(zeroPrior.trend_ratio))
    const zeroBoth = trendCase([0, 0, 0, 0, 0], [0, 0, 0])
    check('prior = 0 且 recent = 0 → stable', zeroBoth.trend_label === 'stable')
    const rawPrecision = trendCase([121000, 121000, 121000, 121000, 121000], [100000, 100000, 100000, 101000, 101000, 101000])
    check(
      'trend 使用 raw median（prior 中位数 100500 不做提前 round）',
      rawPrecision.prior_median_play === 100500 && rawPrecision.trend_ratio === 0.204 && rawPrecision.trend_label === 'up',
      JSON.stringify({ prior: rawPrecision.prior_median_play, ratio: rawPrecision.trend_ratio, label: rawPrecision.trend_label })
    )
    const recentNewest = trendCase([90000, 90000, 90000, 90000, 90000], [10000, 10000, 10000])
    check('recent 组 = 确认顺序里最新 5 条', recentNewest.recent_median_play === 90000 && recentNewest.prior_median_play === 10000)

    console.log('\n===== 7. plays_json 可完整还原 / 顺序保留 =====')
    const roundtrip = await save({
      creator: '丁达人',
      recognized_creator_name_raw: '丁达人',
      plays: [
        play('5.2万', { source_image_index: 1, position_index: 1 }),
        play('看不清', { source_image_index: 2, position_index: 1 }),
        play('3万', { source_image_index: 2, position_index: 2, excluded: true })
      ]
    })
    const restored = (await latest('丁达人')).data.snapshot
    check(
      'plays_json 还原 raw_text / normalized / excluded / 图片顺序 / needs_review',
      restored.plays.length === 3 &&
        restored.plays[0].raw_text === '5.2万' &&
        restored.plays[0].normalized_play === 52000 &&
        restored.plays[0].needs_review === false &&
        restored.plays[0].source_image_index === 1 &&
        restored.plays[0].position_index === 1 &&
        restored.plays[1].normalized_play === null &&
        restored.plays[1].needs_review === true &&
        restored.plays[1].source_image_index === 2 &&
        restored.plays[2].excluded === true
    )
    check('latest 返回与写入同一 id', restored.id === roundtrip.data.id)

    console.log('\n===== 8. 校验 / 身份保护 / 只读 =====')
    check('creator 不存在于历史记录 → 400', (await save({ creator: '不存在的达人', plays: [play('1万')] })).status === 400)
    check('creator 为空 → 400', (await save({ creator: '   ', plays: [play('1万')] })).status === 400)
    check('creator 超长 → 400', (await save({ creator: 'x'.repeat(101), plays: [play('1万')] })).status === 400)
    check('plays 非数组 → 400', (await save({ creator: 'Gary', plays: 'nope' })).status === 400)
    check('plays 为空 → 400', (await save({ creator: 'Gary', plays: [] })).status === 400)
    check('plays 超过 60 条 → 400', (await save({ creator: 'Gary', plays: Array.from({ length: 61 }, () => play('1万')) })).status === 400)
    check('excluded 非布尔 → 400', (await save({ creator: 'Gary', plays: [play('1万', { excluded: 'yes' })] })).status === 400)
    check('source_image_index 非正整数 → 400', (await save({ creator: 'Gary', plays: [play('1万', { source_image_index: -1 })] })).status === 400)
    check('raw_text 超长 → 400', (await save({ creator: 'Gary', plays: [play('1'.repeat(61))] })).status === 400)
    check('请求体不是对象 → 400', (await save(['nope'])).status === 400)

    const mismatch = await save({
      creator: 'Gary',
      recognized_creator_name_raw: '样板达人10',
      plays: [play('1万')]
    })
    check('识别昵称与当前达人不一致且未确认 → 400 且提示不一致', mismatch.status === 400 && /不一致/.test(mismatch.msg), mismatch.msg)
    const mismatchConfirmed = await save({
      creator: 'Gary',
      recognized_creator_name_raw: '样板达人10',
      identity_confirmed: true,
      plays: [play('1万')]
    })
    check('显式确认后允许保存（creator 仍为雷达达人）', mismatchConfirmed.status === 200 && mismatchConfirmed.data.creator === 'Gary' && mismatchConfirmed.data.recognized_creator_name_raw === '样板达人10')
    check('前端：名称一致不要求确认', saveLib.needsIdentityConfirmation('Gary', 'Gary') === false && saveLib.needsIdentityConfirmation('Gary', ' gary ') === false)
    check('前端：名称不一致要求确认', saveLib.needsIdentityConfirmation('Gary', '样板达人10') === true)
    check('前端：未识别昵称不触发不一致确认', saveLib.needsIdentityConfirmation('Gary', null) === false)
    check('前端：尚未选择目标达人时不显示不一致警告', saveLib.needsIdentityConfirmation('', 'Gary') === false)
    check('前端：选择目标达人后才提示不一致', saveLib.needsIdentityConfirmation('样板达人11', 'Gary') === true)
    const payload = saveLib.buildSnapshotPayload(
      { creator_name: 'Gary', xingtu_price_raw: '¥3000', plays: [{ raw_text: '5.2万', normalized_play: 52000, excluded: true, source_image_index: 2, position_index: 3 }] },
      { creator: 'Gary', identityConfirmed: false, observedAt: '2026-09-25' }
    )
    check('前端 payload 不含任何派生统计值', !('normalized_play' in payload.plays[0]) && !('median_play' in payload) && !('valid_count' in payload), JSON.stringify(payload))
    check('前端 payload 保留 raw 事实', payload.plays[0].raw_text === '5.2万' && payload.plays[0].excluded === true && payload.plays[0].source_image_index === 2)
    check('前端 payload 携带数据观察日期', payload.observed_at === '2026-09-25', JSON.stringify(payload.observed_at))
    // Alpha.2：本地日期（不能用 UTC，否则东八区凌晨会少一天）
    check(
      '本地日期生成：东八区凌晨 00:30 仍是当天（不使用 toISOString）',
      saveLib.todayLocalDateOnly(new Date(2026, 8, 29, 0, 30)) === '2026-09-29' &&
        new Date(2026, 8, 29, 0, 30).toISOString().slice(0, 10) === '2026-09-28'
    )
    check(
      '前端日期校验与后端一致（2026-02-30 / 2026-9-29 / 空 均无效）',
      saveLib.isValidDateOnly('2026-09-29') === true &&
        saveLib.isValidDateOnly('2026-02-30') === false &&
        saveLib.isValidDateOnly('2026-9-29') === false &&
        saveLib.isValidDateOnly('') === false
    )
    check('前端状态文案：无快照 → 尚未更新', saveLib.formatSnapshotStatusText(null) === '尚未更新')
    check('前端状态文案：样本不足', saveLib.formatSnapshotStatusText({ stats_status: 'insufficient', median_play: null }) === '样本不足')
    check('前端状态文案：中位 + 趋势', saveLib.formatSnapshotStatusText({ stats_status: 'ok', median_play: 52000, trend_label: 'stable' }) === '5.2万 · 稳定')
    const gate = saveLib.canSaveSnapshot
    check('保存闸门：全部条件满足才可提交', gate({ confirmed: true, creator: 'Gary', identityNeedsConfirm: false, identityConfirmed: false, saving: false, savedSnapshot: null }) === true)
    check('保存闸门：未确认识别结果 → 禁止提交', gate({ confirmed: false, creator: 'Gary' }) === false)
    check('保存闸门：未绑定达人 → 禁止提交', gate({ confirmed: true, creator: '' }) === false)
    check('保存闸门：名称不一致未勾选确认 → 禁止提交', gate({ confirmed: true, creator: 'Gary', identityNeedsConfirm: true, identityConfirmed: false }) === false)
    check('保存闸门：正在保存 → 禁止重复提交', gate({ confirmed: true, creator: 'Gary', saving: true }) === false)
    check('保存闸门：同一份草稿已保存过 → 禁止再次提交', gate({ confirmed: true, creator: 'Gary', savedSnapshot: { id: 1 } }) === false)

    const recordsAfter = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
    const recordsChecksumAfter = db
      .prepare('SELECT COUNT(*) AS n, SUM(total_cost) AS cost, SUM(second_week_play) AS plays FROM creator_records')
      .get()
    check('creator_records 未被修改（行数与内容校验）', recordsAfter === recordsBefore && JSON.stringify(recordsChecksumAfter) === JSON.stringify(recordsChecksumBefore), `${recordsBefore} -> ${recordsAfter}`)
    check(
      'import 相关 V2 数据未被触碰',
      db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n === 0 &&
        db.prepare('SELECT COUNT(*) AS n FROM import_batch_records').get().n === 0
    )

    console.log('\n===== 9. radar 批量合并 latest snapshot（无 N+1）+ P1 不变 =====')
    const radarBefore = await radar()
    const flatten = (data) => data.groups.flatMap((group) => group.creators.map((item) => ({ ...item })))
    const p1Fields = (item) => {
      const { recent_snapshot, ...rest } = item
      return rest
    }
    const beforeCreators = flatten(radarBefore.data)
    check('radar 每位达人都带 recent_snapshot 字段', beforeCreators.every((item) => 'recent_snapshot' in item))
    check('未保存快照的达人 recent_snapshot 为 null', beforeCreators.find((item) => item.creator === '戊达人')?.recent_snapshot === null)
    check(
      '已保存快照的达人带轻量 summary',
      (() => {
        const gary = beforeCreators.find((item) => item.creator === 'Gary')?.recent_snapshot
        return Boolean(gary) && ['id', 'created_at', 'valid_count', 'median_play', 'p25_play', 'p75_play', 'trend_label', 'xingtu_price', 'stats_status'].every((key) => key in gary) && !('plays' in gary)
      })()
    )
    const originalPrepare = db.prepare.bind(db)
    let prepareCount = 0
    db.prepare = (sql) => { prepareCount += 1; return originalPrepare(sql) }
    const radarAfter = await radar()
    db.prepare = originalPrepare
    check('radar 单次请求只执行少量 SQL（无 N+1）', prepareCount <= 4 && radarAfter.data.groups.flatMap((g) => g.creators).length === beforeCreators.length, `prepare=${prepareCount}, creators=${beforeCreators.length}`)

    await save({
      creator: '戊达人',
      recognized_creator_name_raw: '戊达人',
      xingtu_price_raw: '2000',
      plays: ['1万', '2万', '3万', '4万', '5万', '6万', '7万', '8万'].map((text) => play(text))
    })
    const radarWithSnapshot = await radar()
    const afterCreators = flatten(radarWithSnapshot.data)
    check(
      '写入新 snapshot 后 P1 字段与顺序完全不变',
      JSON.stringify(beforeCreators.map(p1Fields)) === JSON.stringify(afterCreators.map(p1Fields))
    )
    check(
      'P1 分组顺序与成员不变',
      JSON.stringify(radarBefore.data.groups.map((group) => ({ key: group.key, count: group.count, creators: group.creators.map((item) => item.creator) }))) ===
        JSON.stringify(radarWithSnapshot.data.groups.map((group) => ({ key: group.key, count: group.count, creators: group.creators.map((item) => item.creator) })))
    )
    check(
      '新存储的快照出现在对应达人的 cell summary 上',
      flatten(radarWithSnapshot.data).find((item) => item.creator === '戊达人')?.recent_snapshot?.valid_count === 8
    )

    console.log('\n===== 10. Alpha.2：observed_at（数据观察日期）与 latest 新语义 =====')
    const eightPlays = () => ['1万', '2万', '3万', '4万', '5万', '6万', '7万', '8万'].map((text) => play(text))
    const pinCreatedAt = (id, createdAt) =>
      db.prepare('UPDATE creator_recent_snapshots SET created_at = ? WHERE id = ?').run(createdAt, id)
    // 本节使用全新达人，避免与前序小节已保存的快照相互干扰（语义断言必须确定）
    const OBS_A = '观测达人甲'
    const OBS_B = '观测达人乙'
    const OBS_C = '观测达人丙'
    const OBS_D = '观测达人丁'
    const OBS_E = '观测达人戊'
    const OBS_F = '观测达人己'
    const OBS_G = '观测达人庚' // 本节刻意不保存任何快照（用于 radar「无快照 → null」断言）
    const seedObsCreator = (nickname) =>
      insertRecord.run('2026-W36', nickname, '数码', 1000, '2026-09-05', 10000, 50000)
    db.transaction(() => {
      for (const nickname of [OBS_A, OBS_B, OBS_C, OBS_D, OBS_E, OBS_F, OBS_G]) seedObsCreator(nickname)
    })()
    // 雷达 P1 基线：在「本节达人已入库、但尚未保存任何快照」时采集，
    // 因此 observed_at 相关的所有写入都不得改变任何达人的 P1 字段与顺序
    const radarBaselineBeforeObs = await radar()
    const baselineCreators = new Set(
      radarBaselineBeforeObs.data.groups.flatMap((group) => group.creators.map((item) => item.creator))
    )
    const baselineP1 = radarBaselineBeforeObs.data.groups
      .flatMap((group) => group.creators)
      .map((item) => {
        const { recent_snapshot, recent_decision, ...rest } = item
        return rest
      })

    check(
      'schema：observed_at 为 TEXT 且可空（旧快照保持 NULL，不伪装 created_at）',
      columnTypes.observed_at === 'TEXT' && notNull.observed_at === 0,
      `${columnTypes.observed_at}/${notNull.observed_at}`
    )

    const obsSaved = await save({
      creator: OBS_A,
      recognized_creator_name_raw: OBS_A,
      xingtu_price_raw: '3000',
      observed_at: '2026-09-26',
      plays: eightPlays()
    })
    check(
      '新快照保存并返回 observed_at（created_at 语义不变，仍为保存时间）',
      obsSaved.status === 200 &&
        obsSaved.data.observed_at === '2026-09-26' &&
        typeof obsSaved.data.created_at === 'string' &&
        obsSaved.data.created_at.slice(0, 4) === '2026',
      JSON.stringify({ observed_at: obsSaved.data?.observed_at, created_at: obsSaved.data?.created_at })
    )
    check(
      'GET /latest 返回 observed_at',
      (await latest(OBS_A)).data.snapshot.id === obsSaved.data.id &&
        (await latest(OBS_A)).data.snapshot.observed_at === '2026-09-26'
    )

    const missingObserved = await callRoute(postHandler, { body: { creator: OBS_A, plays: [play('1万')] } })
    check(
      '缺少 observed_at → 400（Alpha.2 起必填）',
      missingObserved.status === 400 && /观察日期/.test(missingObserved.msg),
      missingObserved.msg
    )
    for (const bad of ['2026/09/26', '20260926', '2026-9-26', '2026-02-30', '2026-13-01', 'today', 20260926, true]) {
      const res = await callRoute(postHandler, {
        body: { creator: OBS_A, observed_at: bad, plays: [play('1万')] }
      })
      check(`非法 observed_at（${JSON.stringify(bad)}）→ 400`, res.status === 400, res.msg)
    }
    check(
      'observed_at 空白字符串 → 400',
      (await callRoute(postHandler, { body: { creator: OBS_A, observed_at: '   ', plays: [play('1万')] } })).status === 400
    )
    check(
      '闰年真实日期 2028-02-29 允许保存',
      (await save({ creator: OBS_F, observed_at: '2028-02-29', plays: eightPlays() })).status === 200
    )

    // ---- 关键场景：补录旧截图不得让「最近表现」倒退 ----
    const snapA = await save({ creator: OBS_B, observed_at: '2026-09-29', plays: eightPlays() })
    pinCreatedAt(snapA.data.id, '2026-09-29 08:00:00')
    const snapB = await save({ creator: OBS_B, observed_at: '2026-09-25', plays: eightPlays() })
    pinCreatedAt(snapB.data.id, '2026-09-30 08:00:00') // B 保存得更晚
    check(
      '补录旧观察日期（B 保存更晚）→ latest 仍为 observed 09-29 的 A',
      (await latest(OBS_B)).data.snapshot.id === snapA.data.id,
      JSON.stringify({ latest: (await latest(OBS_B)).data.snapshot?.observed_at })
    )
    const snapC = await save({ creator: OBS_B, observed_at: '2026-10-01', plays: eightPlays() })
    pinCreatedAt(snapC.data.id, '2026-10-01 08:00:00')
    check('出现更新的 observed_at → latest 切换为 C', (await latest(OBS_B)).data.snapshot.id === snapC.data.id)

    // ---- 同一 observed_at：created_at DESC, id DESC ----
    const same1 = await save({ creator: OBS_C, observed_at: '2026-10-05', plays: eightPlays() })
    pinCreatedAt(same1.data.id, '2026-10-05 07:00:00')
    const same2 = await save({ creator: OBS_C, observed_at: '2026-10-05', plays: eightPlays() })
    pinCreatedAt(same2.data.id, '2026-10-05 09:00:00')
    check(
      '同一 observed_at → created_at 更晚者优先',
      (await latest(OBS_C)).data.snapshot.id === same2.data.id
    )
    const same3 = await save({ creator: OBS_C, observed_at: '2026-10-05', plays: eightPlays() })
    pinCreatedAt(same3.data.id, '2026-10-05 09:00:00') // 同 created_at，id 更大
    check('同一 observed_at + 同一 created_at → id 更大者优先', (await latest(OBS_C)).data.snapshot.id === same3.data.id)

    // ---- 旧数据（observed_at NULL）不得覆盖明确观察日期 ----
    const insertLegacySnapshot = (creator, createdAt, median) =>
      Number(
        db
          .prepare(
            `INSERT INTO creator_recent_snapshots (
               creator, source_type, plays_json, recognized_count, valid_count, excluded_count,
               unresolved_count, analysis_count, median_play, p25_play, p75_play,
               trend_label, stats_status, stats_version, created_at, observed_at
             ) VALUES (?, 'screenshot', ?, 8, 8, 0, 0, 8, ?, ?, ?, 'stable', 'ok', ?, ?, NULL)`
          )
          .run(creator, JSON.stringify([]), median, median, median, 'recent-performance-v2', createdAt)
          .lastInsertRowid
      )
    const legacyLater = insertLegacySnapshot(OBS_D, '2026-10-08 08:00:00', 60000)
    const observedOlder = await save({ creator: OBS_D, observed_at: '2026-09-20', plays: eightPlays() })
    pinCreatedAt(observedOlder.data.id, '2026-09-20 08:00:00')
    check(
      '旧快照 observed_at=NULL（保存更晚）不覆盖已有明确观察日期的快照',
      (await latest(OBS_D)).data.snapshot.id === observedOlder.data.id,
      JSON.stringify({ latestId: (await latest(OBS_D)).data.snapshot?.id, legacyId: legacyLater })
    )
    const legacyOnlyA = insertLegacySnapshot(OBS_E, '2026-09-10 08:00:00', 30000)
    const legacyOnlyB = insertLegacySnapshot(OBS_E, '2026-09-11 08:00:00', 40000)
    check(
      '全部 observed_at=NULL 的达人 → 保留 created_at/id fallback（取保存更晚者）',
      (await latest(OBS_E)).data.snapshot.id === legacyOnlyB && legacyOnlyB !== legacyOnlyA
    )

    // ---- radar 使用同一 latest 语义，且不改变 P1 ----
    const radarAfterObserved = await radar()
    const creatorSnapshot = (data, creator) =>
      data.groups.flatMap((group) => group.creators).find((item) => item.creator === creator)?.recent_snapshot
    check(
      'radar 合并的是 latest observed snapshot（观测达人乙 = C / observed 10-01）',
      creatorSnapshot(radarAfterObserved.data, OBS_B)?.id === snapC.data.id &&
        creatorSnapshot(radarAfterObserved.data, OBS_B)?.observed_at === '2026-10-01'
    )
    check(
      'radar summary 携带 observed_at（无快照达人仍为 null）',
      'observed_at' in creatorSnapshot(radarAfterObserved.data, OBS_B) &&
        creatorSnapshot(radarAfterObserved.data, OBS_G) === null
    )
    check(
      'radar 的 P1 字段与 observed_at 无关（既有达人与本节插入新达人前的基线完全一致）',
      JSON.stringify(
        radarAfterObserved.data.groups
          .flatMap((g) => g.creators)
          .filter((item) => baselineCreators.has(item.creator))
          .map((item) => {
            const { recent_snapshot, recent_decision, ...rest } = item
            return rest
          })
      ) === JSON.stringify(baselineP1)
    )

    // ---- Decision evidence 冻结 observed_at ----
    const decisionRes = await callRoute(createDecisionHandler, {
      body: {
        creator: OBS_A,
        decision_stage: 'contact',
        snapshot_id: obsSaved.data.id,
        ip_judgement: 'strong',
        human_decision: 'contact_now'
      }
    })
    check(
      'Decision evidence 冻结 observed_at',
      decisionRes.status === 200 && decisionRes.data.recent_evidence.observed_at === '2026-09-26',
      JSON.stringify(decisionRes.data?.recent_evidence)
    )
    check(
      '旧快照（observed_at=NULL）冻结进证据时为 null，不回填 created_at',
      (() => {
        const row = db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(legacyLater)
        return decisions.buildRecentEvidence(row).observed_at === null
      })()
    )

    // ---- 无漂移：observed_at 不参与统计 / 价格 / V2 指标 ----
    const statsSame = ['median_play', 'p25_play', 'p75_play', 'trend_label', 'trend_ratio', 'valid_count', 'analysis_count'].every(
      (key) => snapA.data[key] === snapB.data[key]
    )
    check('observed_at 不改变统计口径（同样本不同 observed_at → median/P25/P75/trend 完全一致）', statsSame)
    check(
      'observed_at 不改变 creatorPricing（同星图价 → 同一套目标价 / 参考区间 / 价格状态）',
      JSON.stringify(snapA.data.pricing) === JSON.stringify(snapB.data.pricing) &&
        snapA.data.pricing.pricing_version === 'creator-pricing-v1'
    )

    console.log('\n===== 11. Alpha.2 A2：身份三态 / 待确认项 / 星图价字段状态 =====')
    const identityOf = saveLib.getIdentityCheckState
    check(
      'A2-1 AI 未识别昵称（null）→ unknown，且不需要确认',
      identityOf({ currentCreator: '样板达人08', recognizedCreatorName: null }).status === 'unknown' &&
        identityOf({ currentCreator: '样板达人08', recognizedCreatorName: null }).requiresConfirmation === false
    )
    check(
      'A2-2 AI 未识别昵称（空串）→ unknown，且不需要确认',
      identityOf({ currentCreator: '样板达人08', recognizedCreatorName: '' }).status === 'unknown' &&
        identityOf({ currentCreator: '样板达人08', recognizedCreatorName: '   ' }).requiresConfirmation === false
    )
    check(
      'A2-3 昵称一致 → matched，不阻塞也不需要确认',
      identityOf({ currentCreator: '样板达人08', recognizedCreatorName: '样板达人08' }).status === 'matched' &&
        identityOf({ currentCreator: '样板达人08', recognizedCreatorName: ' 样板达人08 ' }).requiresConfirmation === false
    )
    check(
      'A2-4 昵称不一致 → mismatch，必须显式确认',
      identityOf({ currentCreator: '样板达人08', recognizedCreatorName: 'Gary' }).status === 'mismatch' &&
        identityOf({ currentCreator: '样板达人08', recognizedCreatorName: 'Gary' }).requiresConfirmation === true &&
        identityOf({ currentCreator: '样板达人08', recognizedCreatorName: 'Gary' }).recognizedName === 'Gary'
    )
    check(
      'A2-5 尚未确定当前达人时不误报不一致（unknown，不阻塞）',
      identityOf({ currentCreator: '', recognizedCreatorName: 'Gary' }).status === 'unknown' &&
        identityOf({ currentCreator: '', recognizedCreatorName: 'Gary' }).requiresConfirmation === false
    )

    const countOf = saveLib.countRequiredConfirmations
    check(
      'A2-6 昵称未识别不计入待确认项',
      countOf({ priceNeedsConfirmation: false, unresolvedCount: 0, identityStatus: 'unknown' }) === 0
    )
    check(
      'A2-7 昵称不一致 +1',
      countOf({ priceNeedsConfirmation: false, unresolvedCount: 0, identityStatus: 'mismatch' }) === 1
    )
    check(
      'A3 起：星图价缺失 / 解析失败都不计入待确认项（可选事实字段）',
      countOf({ priceNeedsConfirmation: true, unresolvedCount: 0, identityStatus: 'matched' }) === 0 &&
        countOf({ unresolvedCount: 0, identityStatus: 'matched' }) === 0
    )
    check(
      'A2-9 无法解析的播放量每条 +1',
      countOf({ priceNeedsConfirmation: false, unresolvedCount: 3, identityStatus: 'matched' }) === 3 &&
        countOf({ unresolvedCount: 2, identityStatus: 'mismatch' }) === 3
    )
    check(
      'A2-10 解释性说明（无这些字段）不增加计数',
      countOf({ unresolvedCount: 'nope', priceNeedsConfirmation: false, identityStatus: 'matched' }) === 0 &&
        countOf() === 0
    )

    const priceStatusOf = saveLib.getPriceFieldStatus
    check(
      'A2-11 星图价字段四态：已识别 / 已确认 / 暂无 / 请检查',
      priceStatusOf({ rawText: '4100', price: 4100, needsReview: false, manuallyEdited: false }) === 'identified' &&
        priceStatusOf({ rawText: '4100', price: 4100, needsReview: false, manuallyEdited: true }) === 'confirmed' &&
        priceStatusOf({ rawText: '', price: null, needsReview: false }) === 'missing' &&
        priceStatusOf({ rawText: '面议', price: null, needsReview: true }) === 'invalid'
    )
    check(
      'A2-12 状态文案唯一来源（已识别 / 已确认 / 暂无 / 请检查）',
      saveLib.PRICE_FIELD_STATUS_LABELS.identified === '已识别' &&
        saveLib.PRICE_FIELD_STATUS_LABELS.confirmed === '已确认' &&
        saveLib.PRICE_FIELD_STATUS_LABELS.missing === '暂无' &&
        saveLib.PRICE_FIELD_STATUS_LABELS.invalid === '请检查'
    )

    // snapshot owner 永远是雷达达人：AI 识别成别的昵称也不能改变 owner
    const mismatchPayload = saveLib.buildSnapshotPayload(
      { creator_name: 'Gary', xingtu_price_raw: '¥4100', plays: [{ raw_text: '5.2万' }] },
      { creator: '样板达人08', identityConfirmed: true, observedAt: '2026-09-29' }
    )
    check(
      'A2-13 AI 昵称 ≠ 当前达人时，payload 的 creator 仍是当前达人（AI 不能改 owner）',
      mismatchPayload.creator === '样板达人08' &&
        mismatchPayload.recognized_creator_name_raw === 'Gary' &&
        mismatchPayload.observed_at === '2026-09-29'
    )
    check(
      'A2-14 A1 observed_at 未回退（仍随 payload 提交）',
      saveLib.buildSnapshotPayload({ creator_name: '样板达人08', plays: [] }, { creator: '样板达人08', observedAt: '2026-09-25' }).observed_at === '2026-09-25'
    )

    console.log('\n===== 12. Alpha.2 A3：星图价可选 + 手工录入播放量 =====')
    // A3 用例使用独立达人，避免与前序小节的快照相互干扰
    db.transaction(() => {
      for (const nickname of ['A3无价达人', 'A3清空价达人', 'A3四条达人', 'A3八条达人', 'A3对照达人']) {
        insertRecord.run('2026-W36', nickname, '数码', 1200, '2026-09-05', 10000, 50000)
      }
    })()
    // ---- 星图价可选：无价仍可保存，且不进入「需要确认」----
    const noPriceSnapshot = await save({
      creator: 'A3无价达人',
      observed_at: '2026-09-29',
      plays: ['5.2万', '4.8万', '3.9万', '6.1万', '12000', '8.3w', '4.1万', '5.5万'].map((text) => play(text))
    })
    check(
      'A3-1 无星图价 → snapshot 仍可保存（xingtu_price = null）',
      noPriceSnapshot.status === 200 && noPriceSnapshot.data.xingtu_price === null && noPriceSnapshot.data.median_play === 50000,
      JSON.stringify({ status: noPriceSnapshot.status, price: noPriceSnapshot.data?.xingtu_price, median: noPriceSnapshot.data?.median_play })
    )
    check(
      'A3-2 无星图价时 pricing 为 quote_missing，但目标价 / 参考区间照常计算',
      noPriceSnapshot.data.pricing.pricing_status === 'quote_missing' &&
        noPriceSnapshot.data.pricing.target_price === 1500 &&
        noPriceSnapshot.data.pricing.reference_low === 1282.5 &&
        noPriceSnapshot.data.pricing.reference_high === 1627.5,
      JSON.stringify({
        target: noPriceSnapshot.data.pricing.target_price,
        low: noPriceSnapshot.data.pricing.reference_low,
        high: noPriceSnapshot.data.pricing.reference_high
      })
    )
    check(
      'A3-3 无星图价：折扣相关字段全部不可用（不伪造 1 折 / 5 折）',
      ['entry_discount_rate', 'entry_discount_zhe', 'target_discount_rate', 'target_discount_zhe', 'negotiation_max_price', 'negotiation_min_price'].every(
        (key) => noPriceSnapshot.data.pricing[key] === null
      )
    )
    check(
      'A3-4 quote_missing 文案为「暂无星图刊例价，暂不计算星图折扣」',
      /暂无星图刊例价/.test(noPriceSnapshot.data.pricing.pricing_status_label) &&
        /暂不计算星图折扣/.test(noPriceSnapshot.data.pricing.pricing_status_label),
      noPriceSnapshot.data.pricing.pricing_status_label
    )
    const priceCleared = await save({
      creator: 'A3清空价达人',
      observed_at: '2026-09-29',
      xingtu_price_raw: '面议',
      plays: ['5.2万', '4.8万', '3.9万', '6.1万', '12000', '8.3w', '4.1万', '5.5万'].map((text) => play(text))
    })
    check('A3-5 有原文但解析不了 → 仍可保存（价格 null，状态请检查）', priceCleared.status === 200 && priceCleared.data.xingtu_price === null)

    // ---- 手工录入：复用同一套 parser，顺序 = 输入顺序 ----
    const { splitManualPlayLines, buildDraftFromManualPlays } = draftLib
    check('A3-6 导出手工录入相关纯函数', typeof splitManualPlayLines === 'function' && typeof buildDraftFromManualPlays === 'function')
    check(
      'A3-7 换行 / 中文逗号 / 英文逗号 / 分号混合输入都能拆分',
      JSON.stringify(splitManualPlayLines('5.2万\n4.8万，3.9万, 6.1万；12000')) ===
        JSON.stringify(['5.2万', '4.8万', '3.9万', '6.1万', '12000'])
    )
    const manualDraft = buildDraftFromManualPlays(splitManualPlayLines('5.2万\n4.8万\n39000\n8.3w\n面议'))
    check(
      'A3-8 手工录入复用确定性 parser（5.2万→52000 / 4.8万→48000 / 39000 / 8.3w→83000）',
      manualDraft.plays[0].normalized_play === 52000 &&
        manualDraft.plays[1].normalized_play === 48000 &&
        manualDraft.plays[2].normalized_play === 39000 &&
        manualDraft.plays[3].normalized_play === 83000
    )
    check(
      'A3-9 顺序保持输入顺序（newest→oldest），position_index 按输入生成，不排序',
      manualDraft.plays.map((play) => play.position_index).join(',') === '1,2,3,4,5' &&
        manualDraft.plays[0].raw_text === '5.2万' &&
        manualDraft.plays[4].raw_text === '面议'
    )
    check(
      'A3-10 无法解析的条目保留为 unresolved（需人工处理，不丢弃）',
      manualDraft.plays[4].normalized_play === null && manualDraft.plays[4].needs_review === true
    )
    check(
      'A3-11 手工草稿结构与会话链一致（无 AI 昵称 / 价格可选 / 无 warnings）',
      manualDraft.creator_name === '' &&
        manualDraft.xingtu_price === null &&
        manualDraft.xingtu_price_raw === '' &&
        Array.isArray(manualDraft.warnings) &&
        manualDraft.warnings.length === 0 &&
        manualDraft.plays.every((play) => play.source_image_index === null)
    )
    check(
      'A3-12 手工模式身份态为 unknown（不阻塞、不出现 mismatch）',
      saveLib.getIdentityCheckState({ currentCreator: '样板达人08', recognizedCreatorName: manualDraft.creator_name }).status === 'unknown' &&
        saveLib.getIdentityCheckState({ currentCreator: '样板达人08', recognizedCreatorName: manualDraft.creator_name }).requiresConfirmation === false
    )
    check(
      'A3-13 手工录入不触发 AI / 网络（模块不引用 AI 能力）',
      !/extractCreatorScreenshot|axios|fetch\(|deepseek/i.test(
        fs.readFileSync(path.join(frontend, 'utils/recentPerformanceDraft.js'), 'utf8')
      )
    )

    // ---- 与 AI 路径共用同一条保存链：统计完全一致 ----
    const manualFour = ['5.2万', '4.8万', '3.9万', '6.1万']
    const manualFourDraft = buildDraftFromManualPlays(manualFour)
    const manualFourStats = stats.computeRecentPerformanceStats(
      manualFourDraft.plays.filter((play) => play.normalized_play !== null).map((play) => play.normalized_play)
    )
    check(
      'A3-14 手工输入 < 5 条 → stats insufficient（但仍可保存，不禁止）',
      manualFourStats.stats_status === 'insufficient' &&
        manualFourStats.median_play === null &&
        (await save({
          creator: 'A3四条达人',
          observed_at: '2026-09-29',
          plays: manualFour.map((text) => play(text))
        })).status === 200
    )
    const manualEight = ['5.2万', '4.8万', '3.9万', '6.1万', '12000', '8.3w', '4.1万', '5.5万']
    const manualEightSave = await save({
      creator: 'A3八条达人',
      observed_at: '2026-09-29',
      plays: manualEight.map((text) => play(text))
    })
    const aiPathSave = await save({
      creator: 'A3对照达人',
      observed_at: '2026-09-29',
      xingtu_price_raw: '4100',
      plays: manualEight.map((text) => play(text))
    })
    check(
      'A3-15 手工路径与 AI 路径的统计完全一致（median / P25 / P75 / trend / valid_count / analysis_count）',
      ['median_play', 'p25_play', 'p75_play', 'trend_label', 'trend_ratio', 'valid_count', 'analysis_count', 'stats_status'].every(
        (key) => manualEightSave.data[key] === aiPathSave.data[key]
      ),
      JSON.stringify({ manual: [manualEightSave.data.median_play, manualEightSave.data.trend_label], ai: [aiPathSave.data.median_play, aiPathSave.data.trend_label] })
    )
    check(
      'A3-16 ≥8 条时趋势可计算（与现有算法一致：recent/prior 中位数）',
      manualEightSave.data.trend_label === 'stable' &&
        // Phase audit 顺序契约：录入从旧到新 → recent = 最后 5 条（55000），prior = 前 3 条（48000）
        manualEightSave.data.recent_median_play === 55000 &&
        manualEightSave.data.prior_median_play === 48000,
      JSON.stringify({ trend: manualEightSave.data.trend_label, recent: manualEightSave.data.recent_median_play, prior: manualEightSave.data.prior_median_play })
    )

    // ---- P4：无星图价 + current_quote 仍可评估报价 ----
    const noPriceDecision = await callRoute(createDecisionHandler, {
      body: {
        creator: 'A3无价达人',
        decision_stage: 'post_quote',
        snapshot_id: noPriceSnapshot.data.id,
        current_quote_raw: '3000',
        human_decision: 'negotiate'
      }
    })
    const assessment = noPriceDecision.data?.pricing_evidence?.current_quote_assessment
    check(
      'A3-17 无星图价 + 达人报价 3000：仍算 current_quote_status / gap_to_target / gap_to_reference_high',
      noPriceDecision.status === 200 &&
        assessment.current_quote === 3000 &&
        assessment.current_quote_status === 'above_reference_range' &&
        assessment.gap_to_reference_high === 1372.5 &&
        assessment.gap_to_target === 1500,
      JSON.stringify(assessment)
    )
    check(
      'A3-18 无星图价：星图折扣 / 2～7折区间一律 unavailable（不显示虚假折扣）',
      assessment.actual_vs_xingtu_rate === null &&
        assessment.actual_vs_xingtu_zhe === null &&
        assessment.negotiation_range_status === 'unavailable' &&
        /无法判断实际报价对应的折扣区间/.test(assessment.negotiation_range_status_label),
      JSON.stringify({ rate: assessment.actual_vs_xingtu_rate, range: assessment.negotiation_range_status })
    )

    console.log('\n===== 14. Alpha.3-04：内容类型（商单 / 日常 / 未识别）=====')
    // ---- 14.1 旧格式 plays_json（条目没有 content_type）直接插库，模拟历史快照 ----
    const legacyValues = [58000, 62000, 61000, 55000, 47000, 52000, 70000, 45000]
    const legacyPlaysV1 = legacyValues.map((value, index) => ({
      raw_text: String(value),
      normalized_play: value,
      needs_review: false,
      excluded: false,
      source_image_index: 1,
      position_index: index + 1
    }))
    const legacyStats = stats.computeRecentPerformanceStats(legacyValues)
    const LEGACY_TYPED_CREATOR = '内容类型旧达人'
    insertRecord.run('2026-W33', LEGACY_TYPED_CREATOR, '历史类', 3000, '2026-08-21', 20000, 100000)
    const legacyTypedId = Number(
      db
        .prepare(
          `INSERT INTO creator_recent_snapshots (
             creator, source_type, plays_json, recognized_count, valid_count, excluded_count,
             unresolved_count, analysis_count, median_play, p25_play, p75_play,
             recent_median_play, prior_median_play, trend_ratio, trend_label,
             stats_status, stats_version, created_at, observed_at
           ) VALUES (?, 'screenshot', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-28 09:00:00', '2026-09-28')`
        )
        .run(
          LEGACY_TYPED_CREATOR,
          JSON.stringify(legacyPlaysV1),
          legacyPlaysV1.length,
          legacyStats.valid_count,
          legacyStats.analysis_count,
          legacyStats.median_play,
          legacyStats.p25_play,
          legacyStats.p75_play,
          legacyStats.recent_median_play,
          legacyStats.prior_median_play,
          legacyStats.trend_ratio,
          legacyStats.trend_label,
          legacyStats.stats_status,
          stats.STATS_VERSION
        ).lastInsertRowid
    )
    const legacyTypedRow = db
      .prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?')
      .get(legacyTypedId)
    const legacyPublic = snapshots.toPublicSnapshot(legacyTypedRow)
    const legacySummary = snapshots.toSnapshotSummary(legacyTypedRow)
    check(
      'A1 旧快照（无内容类型）仍能正常读取，条目不丢失',
      legacyPublic.plays.length === legacyValues.length &&
        legacyPublic.valid_count === legacyValues.length &&
        legacyPublic.plays.every((play) => play.normalized_play !== undefined)
    )
    check(
      'A2 旧快照整体统计不变（median / P25 / P75 / trend 与既有统计函数完全一致）',
      legacyPublic.median_play === legacyStats.median_play &&
        legacyPublic.p25_play === legacyStats.p25_play &&
        legacyPublic.p75_play === legacyStats.p75_play &&
        legacyPublic.trend_label === legacyStats.trend_label &&
        legacyPublic.trend_ratio === legacyStats.trend_ratio &&
        legacyStats.stats_status === 'ok',
      JSON.stringify({ median: legacyPublic.median_play, trend: legacyPublic.trend_label })
    )
    check(
      'A3 旧快照内容类型一律 unknown（sponsored/organic 均为 0），且不回填、不回写数据库',
      legacyPublic.plays.every((play) => play.content_type === 'unknown') &&
        legacyPublic.sponsored_count === 0 &&
        legacyPublic.organic_count === 0 &&
        legacyPublic.unknown_count === legacyValues.length &&
        legacyPublic.sponsored_median_play === null &&
        legacyPublic.organic_median_play === null &&
        db.prepare('SELECT plays_json FROM creator_recent_snapshots WHERE id = ?').get(legacyTypedId)
          .plays_json === JSON.stringify(legacyPlaysV1)
    )
    check(
      'A4 Radar / latest summary 对旧快照给出「类型未识别」语义（unknown_count = 有效样本数）',
      legacySummary.unknown_count === legacyValues.length &&
        legacySummary.sponsored_count === 0 &&
        legacySummary.organic_count === 0 &&
        legacySummary.median_play === legacyStats.median_play
    )

    // ---- 14.2 新快照：商单 / 日常 / 未识别 保存 + 读取 + 分组统计 ----
    const typedValues = {
      sponsored: [60000, 50000, 40000],
      organic: [20000, 30000, 40000],
      unknown: [90000, 95000]
    }
    const typedSave = await save({
      creator: 'Gary',
      recognized_creator_name_raw: 'Gary',
      plays: [
        { raw_text: '6万', content_type: 'sponsored' },
        { raw_text: '5万', content_type: 'sponsored' },
        { raw_text: '4万', content_type: 'sponsored' },
        { raw_text: '2万', content_type: 'organic' },
        { raw_text: '3万', content_type: 'organic' },
        { raw_text: '4万', content_type: 'organic' },
        { raw_text: '9万', content_type: null },
        { raw_text: '95000', content_type: 'red' }
      ]
    })
    check(
      'B5/B6/B7 商单 / 日常 / 未识别 均可保存并原样读回（非法值归一为 unknown）',
      typedSave.status === 200 &&
        typedSave.data.plays.map((play) => play.content_type).join(',') ===
          'sponsored,sponsored,sponsored,organic,organic,organic,unknown,unknown',
      JSON.stringify(typedSave.data?.plays?.map((play) => play.content_type))
    )
    check(
      'B8 AI / 前端传来的非法内容类型（red、null、数字）不会写入库，一律 unknown',
      (() => {
        const stored = JSON.parse(
          db.prepare('SELECT plays_json FROM creator_recent_snapshots WHERE id = ?').get(typedSave.data.id)
            .plays_json
        )
        return (
          stored[6].content_type === 'unknown' &&
          stored[7].content_type === 'unknown' &&
          stored.every((play) => ['sponsored', 'organic', 'unknown'].includes(play.content_type))
        )
      })()
    )
    check(
      'C11–C15 分组统计正确（商单 3 条中位 5万 / 日常 3 条中位 3万 / 未识别 2 条）',
      typedSave.data.sponsored_count === 3 &&
        typedSave.data.sponsored_median_play === 50000 &&
        typedSave.data.organic_count === 3 &&
        typedSave.data.organic_median_play === 30000 &&
        typedSave.data.unknown_count === 2,
      JSON.stringify({
        s: [typedSave.data.sponsored_count, typedSave.data.sponsored_median_play],
        o: [typedSave.data.organic_count, typedSave.data.organic_median_play],
        u: typedSave.data.unknown_count
      })
    )
    check(
      'C16 unknown 不计入商单 / 日常（三个分组之和 = 有效样本数）',
      typedSave.data.sponsored_count + typedSave.data.organic_count + typedSave.data.unknown_count ===
        typedSave.data.valid_count
    )
    check(
      'C17 整体统计仍包含全部有效样本（含 unknown），与改动前口径一致',
      typedSave.data.valid_count === 8 &&
        typedSave.data.median_play ===
          stats.computeRecentPerformanceStats([
            ...typedValues.sponsored,
            ...typedValues.organic,
            ...typedValues.unknown
          ]).median_play
    )
    check(
      'C18 内容类型中位数复用现有 median 逻辑（与整体典型表现同一函数；>=5 去极值不影响中位数，<5 直接中位数）',
      // 默认（与整体统计同口径）：< 5 条不产出典型值
      stats.typicalMedianOf([10000, 20000]) === null &&
        // 内容类型分组允许小样本：1–2 条直接取中位数
        stats.typicalMedianOf([10000, 20000], { allowSmallSample: true }) === 15000 &&
        stats.typicalMedianOf([42000], { allowSmallSample: true }) === 42000 &&
        // >= 5 与整体口径一致（去极值；中位数本身与不去极值相同）
        stats.typicalMedianOf([1000, 20000, 30000, 40000, 50000, 60000, 70000, 80000]) === 45000 &&
        [1, 2, 3, 4, 5, 6, 7, 8].every((size) => {
          const values = Array.from({ length: size }, (_, i) => 10000 + i * 5000)
          return (
            stats.typicalMedianOf(values, { allowSmallSample: true }) === stats.medianOf(values) &&
            (size < 5 || stats.typicalMedianOf(values) === stats.medianOf(values))
          )
        })
    )
    const typedSnapshotSummary = snapshots.toSnapshotSummary(
      db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(typedSave.data.id)
    )
    check(
      'C19 Radar summary 同样携带五个内容类型统计字段',
      typedSnapshotSummary.sponsored_count === 3 &&
        typedSnapshotSummary.sponsored_median_play === 50000 &&
        typedSnapshotSummary.organic_count === 3 &&
        typedSnapshotSummary.organic_median_play === 30000 &&
        typedSnapshotSummary.unknown_count === 2
    )
    check(
      'C20 不存在加权综合分 / 综合商单评分（只有分组计数与各自中位数）',
      !Object.keys(typedSave.data).some((key) => /score|weight|blended|composite/i.test(key)) &&
        !Object.keys(typedSnapshotSummary).some((key) => /score|weight|blended|composite/i.test(key))
    )

    // ---- 14.3 人工校准（前端草稿层：不重新识别、不重新调用 AI） ----
    const typedDraft = draftLib.buildDraftFromExtraction({
      plays: [
        { source_image_index: 1, position_index: 1, raw_text: '5.2万', content_type: 'sponsored' },
        { source_image_index: 1, position_index: 2, raw_text: '8.1万', content_type: 'organic' },
        { source_image_index: 1, position_index: 3, raw_text: '3.4万', content_type: 'blue' }
      ]
    })
    check(
      'B8/D 前端草稿：AI 非法类型归一为 unknown，合法类型保留',
      typedDraft.plays.map((play) => play.content_type).join(',') === 'sponsored,organic,unknown'
    )
    const manualTypedDraft = draftLib.buildDraftFromManualPlays(['5万', '4万'])
    check(
      '手工录入：默认全部未识别，可逐条选择类型（不影响播放量解析）',
      manualTypedDraft.plays.every((play) => play.content_type === 'unknown') &&
        manualTypedDraft.plays.map((play) => play.normalized_play).join(',') === '50000,40000'
    )
    const editedDraft = draftLib.updatePlayContentType(typedDraft, typedDraft.plays[0].id, 'organic')
    check(
      'B9/B10 人工把商单改成日常：只改这一条，其他条目与播放量不变（不需要重新识别）',
      editedDraft.plays[0].content_type === 'organic' &&
        editedDraft.plays[0].normalized_play === 52000 &&
        editedDraft.plays[1].content_type === 'organic' &&
        editedDraft.plays[2].content_type === 'unknown' &&
        typedDraft.plays[0].content_type === 'sponsored' &&
        !/extractCreatorScreenshot|axios|fetch\(/.test(
          fs.readFileSync(path.join(frontend, 'utils/recentPerformanceDraft.js'), 'utf8')
        )
    )
    check(
      '保存 payload 携带逐条 content_type，且草稿摘要按有效样本计数',
      (() => {
        const payload = saveLib.buildSnapshotPayload(editedDraft, {
          creator: 'Gary',
          observedAt: '2026-09-28'
        })
        const summary = draftLib.summarizeDraft(editedDraft)
        return (
          payload.plays.map((play) => play.content_type).join(',') === 'organic,organic,unknown' &&
          summary.content_type_counts.sponsored === 0 &&
          summary.content_type_counts.organic === 2 &&
          summary.content_type_counts.unknown === 1
        )
      })()
    )
    check(
      '人工改类型不产生网络请求（全程 0 次外部调用）',
      networkGuard.blocked.length === 0,
      JSON.stringify(networkGuard.blocked)
    )

    console.log('\n===== 15. Alpha.3-04A：人工校准 → 保存 → Radar 闭环 =====')
    // 造一个「最新快照全部未分类」的达人，模拟用户看到「X条内容待分类」
    const LOOP_CREATOR = '闭环达人'
    insertRecord.run('2026-W38', LOOP_CREATOR, '数码', 3000, '2026-09-15', 20000, 100000)
    const legacyLoopValues = [30000, 40000, 50000, 60000, 70000, 80000]
    const legacyLoopPlays = legacyLoopValues.map((value, index) => ({
      raw_text: String(value),
      normalized_play: value,
      needs_review: false,
      excluded: false,
      source_image_index: 1,
      position_index: index + 1
    }))
    const legacyLoopStats = stats.computeRecentPerformanceStats(legacyLoopValues)
    const legacyLoopId = Number(
      db
        .prepare(
          `INSERT INTO creator_recent_snapshots (
             creator, source_type, plays_json, recognized_count, valid_count, excluded_count,
             unresolved_count, analysis_count, median_play, p25_play, p75_play,
             recent_median_play, prior_median_play, trend_ratio, trend_label,
             stats_status, stats_version, created_at, observed_at
           ) VALUES (?, 'screenshot', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-28 09:00:00', '2026-09-28')`
        )
        .run(
          LOOP_CREATOR,
          JSON.stringify(legacyLoopPlays),
          legacyLoopPlays.length,
          legacyLoopStats.valid_count,
          legacyLoopStats.analysis_count,
          legacyLoopStats.median_play,
          legacyLoopStats.p25_play,
          legacyLoopStats.p75_play,
          legacyLoopStats.recent_median_play,
          legacyLoopStats.prior_median_play,
          legacyLoopStats.trend_ratio,
          legacyLoopStats.trend_label,
          legacyLoopStats.stats_status,
          stats.STATS_VERSION
        ).lastInsertRowid
    )
    const legacyLoopRowBefore = db
      .prepare('SELECT plays_json FROM creator_recent_snapshots WHERE id = ?')
      .get(legacyLoopId).plays_json
    const radarBeforeLoop = await radar()
    const loopBefore = radarBeforeLoop.data.groups
      .flatMap((group) => group.creators)
      .find((item) => item.creator === LOOP_CREATOR)?.recent_snapshot
    check(
      'H1 保存前：Radar latest = 未分类快照（sponsored/organic 为 0，unknown = 有效样本数）',
      loopBefore?.id === legacyLoopId &&
        loopBefore.sponsored_count === 0 &&
        loopBefore.organic_count === 0 &&
        loopBefore.unknown_count === legacyLoopValues.length
    )

    // ---- 模拟用户在「更新近期表现」里逐条校准内容类型 ----
    const loopDraft0 = draftLib.buildDraftFromManualPlays(legacyLoopValues.map(String))
    check(
      'H2 草稿初始全部未识别（手工录入没有颜色依据，不猜）',
      loopDraft0.plays.every((play) => play.content_type === 'unknown')
    )
    let loopDraft = loopDraft0
    // 后 3 条 → 商单（6万 / 7万 / 8万 → 中位 7万）
    loopDraft = draftLib.updatePlayContentType(loopDraft, loopDraft.plays[3].id, 'sponsored')
    loopDraft = draftLib.updatePlayContentType(loopDraft, loopDraft.plays[4].id, 'sponsored')
    loopDraft = draftLib.updatePlayContentType(loopDraft, loopDraft.plays[5].id, 'sponsored')
    // 前 3 条 → 日常（3万 / 4万 / 5万 → 中位 4万）；其中一条刻意改两次，验证保存的是最新状态
    loopDraft = draftLib.updatePlayContentType(loopDraft, loopDraft.plays[0].id, 'sponsored')
    loopDraft = draftLib.updatePlayContentType(loopDraft, loopDraft.plays[0].id, 'organic')
    loopDraft = draftLib.updatePlayContentType(loopDraft, loopDraft.plays[1].id, 'organic')
    loopDraft = draftLib.updatePlayContentType(loopDraft, loopDraft.plays[2].id, 'organic')
    const loopPayload = saveLib.buildSnapshotPayload(loopDraft, {
      creator: LOOP_CREATOR,
      observedAt: '2026-09-30'
    })
    check(
      'H3 payload 携带的是草稿最新状态（改两次的那条以最后一次为准）',
      loopPayload.plays.map((play) => play.content_type).join(',') ===
        'organic,organic,organic,sponsored,sponsored,sponsored',
      JSON.stringify(loopPayload.plays.map((play) => play.content_type))
    )

    const loopSaved = await save(loopPayload)
    check(
      'H4 保存成功，返回的统计与 payload 类型一致（商单 3 条中位 7万 / 日常 3 条中位 4万）',
      loopSaved.status === 200 &&
        loopSaved.data.sponsored_count === 3 &&
        loopSaved.data.sponsored_median_play === 70000 &&
        loopSaved.data.organic_count === 3 &&
        loopSaved.data.organic_median_play === 40000 &&
        loopSaved.data.unknown_count === 0,
      JSON.stringify({
        s: [loopSaved.data?.sponsored_count, loopSaved.data?.sponsored_median_play],
        o: [loopSaved.data?.organic_count, loopSaved.data?.organic_median_play]
      })
    )
    check(
      'H5 payload 伪造的派生值不会覆盖后端重算结果（只认 raw_text + content_type）',
      (() => {
        const stored = JSON.parse(
          db.prepare('SELECT plays_json FROM creator_recent_snapshots WHERE id = ?').get(loopSaved.data.id)
            .plays_json
        )
        return (
          stored.map((play) => play.content_type).join(',') ===
            'organic,organic,organic,sponsored,sponsored,sponsored' &&
          stored.every((play) => play.normalized_play !== null)
        )
      })()
    )
    const loopLatest = await latest(LOOP_CREATOR)
    check(
      'H6 latest snapshot 选中新保存的快照（旧未分类快照不覆盖新快照）',
      loopLatest.data.snapshot.id === loopSaved.data.id &&
        loopLatest.data.snapshot.sponsored_count === 3 &&
        loopLatest.data.snapshot.organic_count === 3
    )
    const radarAfterLoop = await radar()
    const loopAfter = radarAfterLoop.data.groups
      .flatMap((group) => group.creators)
      .find((item) => item.creator === LOOP_CREATOR)?.recent_snapshot
    check(
      'H7 Radar 刷新后展示新快照的分类统计（不再是「待分类」）',
      loopAfter?.id === loopSaved.data.id &&
        loopAfter.sponsored_count === 3 &&
        loopAfter.sponsored_median_play === 70000 &&
        loopAfter.organic_count === 3 &&
        loopAfter.organic_median_play === 40000 &&
        loopAfter.unknown_count === 0
    )
    check(
      'H8 旧快照未被修改、未被回填（plays_json 与保存前逐字节一致，仍可读取）',
      db.prepare('SELECT plays_json FROM creator_recent_snapshots WHERE id = ?').get(legacyLoopId)
        .plays_json === legacyLoopRowBefore &&
        snapshots.toPublicSnapshot(
          db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(legacyLoopId)
        ).unknown_count === legacyLoopValues.length
    )
    check(
      'H9 整体 median / trend 口径不变（新快照仍按全部有效样本计算）',
      loopSaved.data.valid_count === legacyLoopValues.length &&
        loopSaved.data.median_play ===
          stats.computeRecentPerformanceStats(legacyLoopValues).median_play &&
        loopSaved.data.trend_label === 'insufficient' // 6 条 < 8，trend 仍为 insufficient
    )
    check(
      'H10 前端保存后会重新拉取 Radar（使用最新 API 结果，不靠前端伪造计数）',
      /onSaved=\{\(\) => \{[\s\S]{0,200}loadRadar\(\)/.test(
        fs.readFileSync(path.join(frontend, 'pages/RepurchaseRadar/index.jsx'), 'utf8')
      ) &&
        !/sponsored_count\s*[:=]\s*\d/.test(
          fs.readFileSync(path.join(frontend, 'utils/contentType.js'), 'utf8')
        )
    )

    console.log('\n===== 16. Alpha.3-04B：补充分类（classify_existing）闭环 =====')
    const CLASSIFY_CREATOR = '分类闭环达人'
    insertRecord.run('2026-W38', CLASSIFY_CREATOR, '数码', 5000, '2026-09-12', 20000, 100000)
    // 旧快照：全部未分类（模拟 Radar 上的「N条内容待分类」），含 1 条 unresolved + 1 条 excluded
    const classifyPlays = [
      { raw_text: '40000', normalized_play: 40000, needs_review: false, excluded: false, source_image_index: 1, position_index: 1 },
      { raw_text: '50000', normalized_play: 50000, needs_review: false, excluded: false, source_image_index: 1, position_index: 2 },
      { raw_text: '60000', normalized_play: 60000, needs_review: false, excluded: false, source_image_index: 1, position_index: 3 },
      { raw_text: '20000', normalized_play: 20000, needs_review: false, excluded: false, source_image_index: 1, position_index: 4 },
      { raw_text: '30000', normalized_play: 30000, needs_review: false, excluded: false, source_image_index: 1, position_index: 5 },
      { raw_text: '面议', normalized_play: null, needs_review: true, excluded: false, source_image_index: 1, position_index: 6 },
      { raw_text: '70000', normalized_play: 70000, needs_review: false, excluded: true, source_image_index: 1, position_index: 7 }
    ]
    const classifyValues = [40000, 50000, 60000, 20000, 30000]
    const classifyStats = stats.computeRecentPerformanceStats(classifyValues)
    const classifyOldId = Number(
      db
        .prepare(
          `INSERT INTO creator_recent_snapshots (
             creator, source_type, plays_json, recognized_count, valid_count, excluded_count,
             unresolved_count, analysis_count, median_play, p25_play, p75_play,
             recent_median_play, prior_median_play, trend_ratio, trend_label,
             stats_status, stats_version, created_at, observed_at
           ) VALUES (?, 'screenshot', ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-28 09:00:00', '2026-09-28')`
        )
        .run(
          CLASSIFY_CREATOR,
          JSON.stringify(classifyPlays),
          classifyPlays.length,
          classifyStats.valid_count,
          classifyStats.analysis_count,
          classifyStats.median_play,
          classifyStats.p25_play,
          classifyStats.p75_play,
          classifyStats.recent_median_play,
          classifyStats.prior_median_play,
          classifyStats.trend_ratio,
          classifyStats.trend_label,
          classifyStats.stats_status,
          stats.STATS_VERSION
        ).lastInsertRowid
    )
    const classifyOldPlaysJson = db
      .prepare('SELECT plays_json FROM creator_recent_snapshots WHERE id = ?')
      .get(classifyOldId).plays_json

    // ---- 1) 入口读取 latest snapshot（现有 GET /latest 已足够，无需新增 API）----
    const classifyLatest = await latest(CLASSIFY_CREATOR)
    const classifySnapshot = classifyLatest.data.snapshot
    check(
      'I1 补充分类入口可读到 latest snapshot 的完整已有事实（plays / raw_text / normalized / excluded / needs_review / observed_at / 星图价原文）',
      classifyLatest.status === 200 &&
        classifySnapshot.id === classifyOldId &&
        classifySnapshot.plays.length === classifyPlays.length &&
        classifySnapshot.plays.every((play) => play.content_type === 'unknown') &&
        classifySnapshot.observed_at === '2026-09-28' &&
        'xingtu_price_raw' in classifySnapshot &&
        classifySnapshot.plays[5].normalized_play === null &&
        classifySnapshot.plays[6].excluded === true
    )

    // ---- 2) 预加载草稿：只改 content_type ----
    const classifyDraft0 = draftLib.buildDraftFromSnapshot(classifySnapshot)
    check(
      'I2 草稿继承全部已有事实（顺序 / raw_text / normalized_play / excluded / needs_review / observed_at）',
      classifyDraft0.mode === 'classify_existing' &&
        classifyDraft0.source_snapshot_id === classifyOldId &&
        classifyDraft0.observed_at === '2026-09-28' &&
        classifyDraft0.plays.length === classifyPlays.length &&
        JSON.stringify(classifyDraft0.plays.map((play) => play.raw_text)) ===
          JSON.stringify(classifyPlays.map((play) => play.raw_text)) &&
        JSON.stringify(classifyDraft0.plays.map((play) => play.normalized_play)) ===
          JSON.stringify(classifyPlays.map((play) => play.normalized_play)) &&
        classifyDraft0.plays[6].excluded === true &&
        classifyDraft0.plays[5].needs_review === true &&
        classifyDraft0.plays.every((play) => play.content_type === 'unknown')
    )
    let classifyDraft = classifyDraft0
    for (const index of [0, 1, 2]) {
      classifyDraft = draftLib.updatePlayContentType(
        classifyDraft,
        classifyDraft.plays[index].id,
        'sponsored'
      )
    }
    for (const index of [3, 4]) {
      classifyDraft = draftLib.updatePlayContentType(
        classifyDraft,
        classifyDraft.plays[index].id,
        'organic'
      )
    }
    const classifyPayload = saveLib.buildSnapshotPayload(classifyDraft, {
      creator: CLASSIFY_CREATOR,
      identityConfirmed: true,
      observedAt: classifyDraft.observed_at
    })
    check(
      'I3 保存 payload 只改了 content_type：播放量与顺序完全一致，observed_at 继承旧快照',
      classifyPayload.observed_at === '2026-09-28' &&
        classifyPayload.creator === CLASSIFY_CREATOR &&
        classifyPayload.identity_confirmed === true &&
        classifyPayload.plays.length === classifyPlays.length &&
        JSON.stringify(classifyPayload.plays.map((play) => play.raw_text)) ===
          JSON.stringify(classifyPlays.map((play) => play.raw_text)) &&
        JSON.stringify(classifyPayload.plays.map((play) => play.excluded)) ===
          JSON.stringify(classifyPlays.map((play) => play.excluded)) &&
        JSON.stringify(classifyPayload.plays.map((play) => play.content_type)) ===
          JSON.stringify(['sponsored', 'sponsored', 'sponsored', 'organic', 'organic', 'unknown', 'unknown'])
    )

    // ---- 3) append-only 保存 ----
    const classifySaved = await save(classifyPayload)
    const classifyNewRow = db
      .prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?')
      .get(classifySaved.data.id)
    const classifyNewPlays = JSON.parse(classifyNewRow.plays_json)
    check(
      'I4 保存创建了 NEW snapshot（旧 snapshot id 不变、内容一字未改）',
      classifySaved.status === 200 &&
        classifySaved.data.id !== classifyOldId &&
        db.prepare('SELECT plays_json FROM creator_recent_snapshots WHERE id = ?').get(classifyOldId)
          .plays_json === classifyOldPlaysJson &&
        db.prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots WHERE creator = ?').get(CLASSIFY_CREATOR).n === 2
    )
    check(
      'I5 新快照的播放事实与旧快照逐条一致（raw_text / normalized_play / excluded / needs_review / 顺序）',
      classifyNewPlays.length === classifyPlays.length &&
        classifyNewPlays.every((play, index) => {
          const old = classifyPlays[index]
          return (
            play.raw_text === old.raw_text &&
            play.normalized_play === old.normalized_play &&
            play.excluded === old.excluded &&
            play.needs_review === old.needs_review &&
            play.source_image_index === old.source_image_index &&
            play.position_index === old.position_index
          )
        }) &&
        JSON.stringify(classifyNewPlays.map((play) => play.content_type)) ===
          JSON.stringify(['sponsored', 'sponsored', 'sponsored', 'organic', 'organic', 'unknown', 'unknown'])
    )
    check(
      'I6 observed_at 继承旧快照（不是今天），created_at 为新记录时间',
      classifyNewRow.observed_at === '2026-09-28' &&
        classifyNewRow.observed_at ===
          db.prepare('SELECT observed_at FROM creator_recent_snapshots WHERE id = ?').get(classifyOldId).observed_at &&
        classifyNewRow.created_at !==
          db.prepare('SELECT created_at FROM creator_recent_snapshots WHERE id = ?').get(classifyOldId).created_at &&
        String(classifyNewRow.created_at) >= '2026-09-28 09:00:00'
    )
    check(
      'I7 整体统计不漂移（median / P25 / P75 / trend 与新快照相同口径，逐字段一致）',
      classifyNewRow.valid_count === classifyStats.valid_count &&
        classifyNewRow.median_play === classifyStats.median_play &&
        classifyNewRow.p25_play === classifyStats.p25_play &&
        classifyNewRow.p75_play === classifyStats.p75_play &&
        classifyNewRow.trend_label === classifyStats.trend_label &&
        classifyNewRow.median_play ===
          db.prepare('SELECT median_play FROM creator_recent_snapshots WHERE id = ?').get(classifyOldId).median_play
    )
    check(
      'I8 内容分类统计立即生效（商单 3 条中位 5万 / 日常 2 条中位 2.5万；余下 2 条是 excluded / unresolved，不计入任何分组）',
      classifySaved.data.sponsored_count === 3 &&
        classifySaved.data.sponsored_median_play === 50000 &&
        classifySaved.data.organic_count === 2 &&
        classifySaved.data.organic_median_play === 25000 &&
        classifySaved.data.unknown_count === 0 &&
        classifySaved.data.sponsored_count +
          classifySaved.data.organic_count +
          classifySaved.data.unknown_count ===
          classifySaved.data.valid_count
    )

    // ---- 4) latest 与 Radar 立即更新 ----
    const classifyLatestAfter = await latest(CLASSIFY_CREATOR)
    const radarClassifyAfter = await radar()
    const radarClassifyItem = radarClassifyAfter.data.groups
      .flatMap((group) => group.creators)
      .find((item) => item.creator === CLASSIFY_CREATOR)
    check(
      'I9 latest 选中新快照（同一 observed_at 下 created_at / id 更晚者优先，规则未改）',
      classifyLatestAfter.data.snapshot.id === classifySaved.data.id &&
        classifyLatestAfter.data.snapshot.sponsored_count === 3 &&
        classifyLatestAfter.data.snapshot.organic_count === 2
    )
    check(
      'I10 Radar / Creator Workspace 立即拿到新分类（不再是「待分类」）',
      radarClassifyItem?.recent_snapshot?.id === classifySaved.data.id &&
        radarClassifyItem.recent_snapshot.sponsored_count === 3 &&
        radarClassifyItem.recent_snapshot.sponsored_median_play === 50000 &&
        radarClassifyItem.recent_snapshot.organic_count === 2 &&
        radarClassifyItem.recent_snapshot.organic_median_play === 25000 &&
        radarClassifyItem.recent_snapshot.unknown_count === 0 &&
        radarClassifyItem.recent_snapshot.median_play === classifyStats.median_play
    )
    check(
      'I11 补充分类全程 0 次 AI / 外部网络调用（只读 latest + 保存快照）',
      networkGuard.blocked.length === 0,
      JSON.stringify(networkGuard.blocked)
    )

    console.log('\n===== 13. 无 AI / 无网络 / 只读实现 =====')
    const routeSource = fs.readFileSync(path.join(root, 'backend/routes/recentSnapshots.js'), 'utf8')
    check('P2B 路由不引用任何 AI 服务', !/deepseek|callProviderVision|extract-creator-screenshot/i.test(routeSource))
    check('P2B 路由只注册 POST / 与 GET /latest', snapshotRouter.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort().join(' | ') === 'GET /latest | POST /', snapshotRouter.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).join(' | '))
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
