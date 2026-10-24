#!/usr/bin/env node
/**
 * 候选达人身份层（V3-alpha.3 Playbook Phase 1）回归测试
 *
 * 运行方式：node tests/creator_candidates.test.js
 * 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
 * 网络：拦截 http/https/net/tls/fetch —— Phase 1 不调用 AI、不访问外部网络。
 *
 * 覆盖：creator_candidates schema / name 不唯一、候选 snapshot 保存（candidate_id 归属、creator 由服务端决定）、
 *      同名候选 latest 不串数据、历史达人 snapshot API 行为不变、candidate 不进入 Repurchase Radar、
 *      归档保留历史 snapshot、旧快照 candidate_id 为 NULL 可读。
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

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-candidates-'))
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
    [http, 'request'],
    [http, 'get'],
    [https, 'request'],
    [https, 'get'],
    [net, 'connect'],
    [net, 'createConnection'],
    [net.Socket.prototype, 'connect'],
    [tls, 'connect']
  ]
  const originals = replacements.map(([target, method]) => [target, method, target[method]])
  for (const [target, method] of replacements) {
    target[method] = () => {
      blocked.push(method)
      throw new Error('Phase 1 test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('Phase 1 test forbids network requests')
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

const play = (raw_text, extra = {}) => ({
  raw_text,
  excluded: false,
  source_image_index: 1,
  position_index: 1,
  ...extra
})

const OBSERVED_AT = '2026-09-29'

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const candidates = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorCandidates.js')).href
    )
    const snapshots = await import(
      pathToFileURL(path.join(root, 'backend/routes/recentSnapshots.js')).href
    )
    const records = await import(pathToFileURL(path.join(root, 'backend/routes/records.js')).href)
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

    const candidateRouter = candidates.default
    const snapshotRouter = snapshots.default
    const findHandler = (router, routePath, method) => {
      const layer = router.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const callRoute = async (handler, { body = {}, query = {}, params = {} } = {}) => {
      const res = response()
      await handler({ body, query, params, headers: {} }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    const createCandidate = findHandler(candidateRouter, '/', 'post')
    const listCandidates = findHandler(candidateRouter, '/', 'get')
    const detailCandidate = findHandler(candidateRouter, '/:id', 'get')
    const patchCandidate = findHandler(candidateRouter, '/:id', 'patch')
    const saveCandidateSnapshot = findHandler(candidateRouter, '/:id/recent-snapshots', 'post')
    const candidateLatest = findHandler(candidateRouter, '/:id/recent-snapshots/latest', 'get')
    const historyPost = findHandler(snapshotRouter, '/', 'post')
    const historyLatest = findHandler(snapshotRouter, '/latest', 'get')
    const radarHandler = findHandler(records.default, '/repurchase-radar', 'get')

    console.log('===== 1. schema =====')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name)
    check('新增 creator_candidates 表', tables.includes('creator_candidates'), JSON.stringify(tables))
    const candidateColumns = db.prepare('PRAGMA table_info(creator_candidates)').all()
    const candidateColumnMap = Object.fromEntries(candidateColumns.map((c) => [c.name, c]))
    check(
      'creator_candidates 字段齐全',
      ['id', 'name', 'creator_type', 'profile_url', 'description', 'status', 'created_at', 'updated_at'].every(
        (name) => name in candidateColumnMap
      ),
      JSON.stringify(Object.keys(candidateColumnMap))
    )
    check('每列都显式声明类型', candidateColumns.every((c) => c.type && c.type.trim()))
    check(
      'Phase 2.1 新增 xingtu_url / distilled_description（均 TEXT 可空）',
      candidateColumnMap.xingtu_url?.type === 'TEXT' &&
        candidateColumnMap.distilled_description?.type === 'TEXT' &&
        candidateColumnMap.xingtu_url.notnull === 0 &&
        candidateColumnMap.distilled_description.notnull === 0
    )
    check(
      'Phase 2.2 新增 xingtu_id（TEXT 可空，保留 legacy xingtu_url）',
      candidateColumnMap.xingtu_id?.type === 'TEXT' &&
        candidateColumnMap.xingtu_id.notnull === 0 &&
        candidateColumnMap.xingtu_url?.type === 'TEXT'
    )
    const nameUnique = candidateColumns.find((c) => c.name === 'name').pk
    check('name 不是主键（稳定身份是 id）', nameUnique === 0)
    const candidateIndexes = db.prepare('PRAGMA index_list(creator_candidates)').all()
    check(
      'name 上没有 UNIQUE 约束（允许重名）',
      candidateIndexes.every((i) => i.unique !== 1),
      JSON.stringify(candidateIndexes.map((i) => i.name))
    )
    const snapshotColumns = db.prepare('PRAGMA table_info(creator_recent_snapshots)').all()
    check(
      'creator_recent_snapshots 新增 candidate_id 列',
      snapshotColumns.some((c) => c.name === 'candidate_id'),
      JSON.stringify(snapshotColumns.map((c) => c.name))
    )
    check(
      'candidate_id 显式声明类型',
      snapshotColumns.find((c) => c.name === 'candidate_id')?.type === 'INTEGER'
    )
    const snapshotIndexes = db.prepare('PRAGMA index_list(creator_recent_snapshots)').all().map((i) => i.name)
    check('存在 candidate_id 索引', snapshotIndexes.includes('idx_recent_snapshots_candidate'), JSON.stringify(snapshotIndexes))

    console.log('\n===== 2. 创建候选（name 不唯一）=====')
    const c1 = await callRoute(createCandidate, {
      body: { name: '新达人甲', creator_type: '美妆', profile_url: 'https://example.com/a', description: '测试候选' }
    })
    check('创建候选返回 200', c1.status === 200 && Boolean(c1.data?.id), JSON.stringify(c1.msg))
    check('默认 status=active', c1.data?.status === 'active', String(c1.data?.status))
    check('可选字段被 trim（\n 测试候选 → 测试候选）', c1.data?.description === '测试候选')
    const c1dup = await callRoute(createCandidate, { body: { name: '新达人甲' } })
    check('同名候选可再次创建（不同 id）', c1dup.status === 200 && c1dup.data.id !== c1.data.id, `${c1.data?.id} vs ${c1dup.data?.id}`)
    check('空 name → 400', (await callRoute(createCandidate, { body: { name: '   ' } })).status === 400)
    check('非法 status → 400', (await callRoute(createCandidate, { body: { name: 'x', status: 'converted' } })).status === 400)
    check('name 超长 → 400', (await callRoute(createCandidate, { body: { name: 'x'.repeat(101) } })).status === 400)

    const list = await callRoute(listCandidates, { query: {} })
    check('列表返回全部候选', list.status === 200 && list.data.candidates.length === 2, String(list.data?.candidates?.length))
    const detail = await callRoute(detailCandidate, { params: { id: String(c1.data.id) } })
    check('详情返回对应候选', detail.status === 200 && detail.data.name === '新达人甲')
    check('不存在的候选详情 → 404', (await callRoute(detailCandidate, { params: { id: '99999' } })).status === 404)
    const patched = await callRoute(patchCandidate, { params: { id: String(c1.data.id) }, body: { creator_type: '数码' } })
    check('PATCH 更新字段', patched.status === 200 && patched.data.creator_type === '数码')
    check('PATCH 空 body → 400', (await callRoute(patchCandidate, { params: { id: String(c1.data.id) }, body: {} })).status === 400)

    console.log('\n===== 3. 候选快照：服务端决定 creator / 落 candidate_id =====')
    check(
      '候选不在 creator_records（未投放）',
      db.prepare('SELECT COUNT(*) AS n FROM creator_records WHERE nickname = ?').get('新达人甲').n === 0
    )
    const recordsBefore = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
    const candSave = await callRoute(saveCandidateSnapshot, {
      params: { id: String(c1.data.id) },
      body: {
        // 恶意：前端提交伪造 creator，服务端必须忽略并用 candidate.name
        creator: '伪造名称',
        recognized_creator_name_raw: '新达人甲',
        xingtu_price_raw: '¥5,000',
        observed_at: OBSERVED_AT,
        plays: [play('5.2万'), play('4.8万'), play('6.1万'), play('5.5万'), play('1万'), play('9000')]
      }
    })
    check('无历史候选仍可保存快照', candSave.status === 200 && Boolean(candSave.data?.id), JSON.stringify(candSave.msg))
    check('candidate_id 正确落库', candSave.data?.candidate_id === c1.data.id, String(candSave.data?.candidate_id))
    check('creator 由服务端 candidate.name 决定（忽略前端伪造）', candSave.data?.creator === '新达人甲', String(candSave.data?.creator))
    check('未写入 creator_records', db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n === recordsBefore)
    check('observed_at / 星图价语义保留', candSave.data?.observed_at === OBSERVED_AT && candSave.data?.xingtu_price === 5000, JSON.stringify({ o: candSave.data?.observed_at, p: candSave.data?.xingtu_price }))
    check('候选不存在 → 404', (await callRoute(saveCandidateSnapshot, { params: { id: '99999' }, body: { observed_at: OBSERVED_AT, plays: [play('1万')] } })).status === 404)
    check('候选快照仍要求 observed_at', (await callRoute(saveCandidateSnapshot, { params: { id: String(c1.data.id) }, body: { plays: [play('1万')] } })).status === 400)

    console.log('\n===== 4. 同名候选不互相串数据 =====')
    const sameName2 = await callRoute(saveCandidateSnapshot, {
      params: { id: String(c1dup.data.id) },
      body: { observed_at: OBSERVED_AT, plays: [play('30万'), play('31万'), play('32万'), play('33万'), play('34万'), play('35万')] }
    })
    check('同名第二候选保存成功', sameName2.status === 200 && sameName2.data.candidate_id === c1dup.data.id)
    const latest1 = await callRoute(candidateLatest, { params: { id: String(c1.data.id) } })
    const latest2 = await callRoute(candidateLatest, { params: { id: String(c1dup.data.id) } })
    check(
      '同名候选 latest 各自取自己的快照（不串）',
      latest1.data?.snapshot?.id === candSave.data.id && latest2.data?.snapshot?.id === sameName2.data.id,
      `${latest1.data?.snapshot?.id} / ${latest2.data?.snapshot?.id}`
    )
    check('不一致的中位数（证明未串数据）', latest1.data?.snapshot?.median_play !== latest2.data?.snapshot?.median_play)

    console.log('\n===== 5. 历史达人 snapshot API 行为不变 =====')
    db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES ('2026-W33', '历史达人', '数码', 1800, '2026-08-18', 20000, 100000)`
    ).run()
    const histOk = await callRoute(historyPost, {
      body: { creator: '历史达人', recognized_creator_name_raw: '历史达人', observed_at: OBSERVED_AT, plays: [play('2万'), play('3万')] }
    })
    check('历史达人（有 record）仍可保存', histOk.status === 200, JSON.stringify(histOk.msg))
    check('历史达人快照 candidate_id 为 NULL', histOk.data?.candidate_id === null, String(histOk.data?.candidate_id))
    check(
      '历史达人未在 creator_records 的达人仍被拒绝（行为不变）',
      (await callRoute(historyPost, { body: { creator: '未投放达人', observed_at: OBSERVED_AT, plays: [play('1万')] } })).status === 400
    )
    const histLatest = await callRoute(historyLatest, { query: { creator: '历史达人' } })
    check('历史 latest 正常返回', histLatest.status === 200 && histLatest.data.snapshot?.id === histOk.data.id)

    console.log('\n===== 6. 同名：candidate 快照不污染历史 latest / Radar =====')
    db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES ('2026-W34', '重名达人', '生活', 900, '2026-08-25', 15000, 40000)`
    ).run()
    const histSame = await callRoute(historyPost, {
      body: { creator: '重名达人', recognized_creator_name_raw: '重名达人', observed_at: OBSERVED_AT, plays: [play('1.5万'), play('1.6万'), play('1.7万'), play('1.8万'), play('1.9万'), play('2万')] }
    })
    const candidateSame = await callRoute(createCandidate, { body: { name: '重名达人' } })
    const candSameSave = await callRoute(saveCandidateSnapshot, {
      params: { id: String(candidateSame.data.id) },
      body: { observed_at: OBSERVED_AT, plays: [play('99万'), play('98万')] }
    })
    const histSameLatest = await callRoute(historyLatest, { query: { creator: '重名达人' } })
    check(
      '历史 latest 只返回历史快照（不返回同名候选快照）',
      histSameLatest.data?.snapshot?.id === histSame.data.id && histSameLatest.data?.snapshot?.id !== candSameSave.data.id,
      `${histSameLatest.data?.snapshot?.id}`
    )
    const candSameLatest = await callRoute(candidateLatest, { params: { id: String(candidateSame.data.id) } })
    check('候选 latest 只返回候选快照', candSameLatest.data?.snapshot?.id === candSameSave.data.id)

    const radar = await callRoute(radarHandler, { query: {} })
    const radarCreators = (radar.data?.groups || []).flatMap((g) => g.creators || []).map((c) => c.creator)
    check('新候选（未投放）不出现在雷达', !radarCreators.includes('新达人甲'), JSON.stringify(radarCreators))
    const radarSame = (radar.data?.groups || []).flatMap((g) => g.creators || []).find((c) => c.creator === '重名达人')
    check(
      'Radar 上同名达人的 recent_snapshot 不来自候选（未污染）',
      radarSame && (radarSame.recent_snapshot === null || radarSame.recent_snapshot.id === histSame.data.id),
      JSON.stringify(radarSame?.recent_snapshot?.id ?? null)
    )

    console.log('\n===== 7. 归档保留历史事实 =====')
    const arch = await callRoute(patchCandidate, { params: { id: String(c1.data.id) }, body: { status: 'archived' } })
    check('归档成功（status=archived）', arch.status === 200 && arch.data.status === 'archived')
    check(
      '归档后历史 snapshot 仍保留',
      db.prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots WHERE candidate_id = ?').get(c1.data.id).n === 1
    )
    const archivedLatest = await callRoute(candidateLatest, { params: { id: String(c1.data.id) } })
    check('归档候选仍可读取其最新快照', archivedLatest.status === 200 && archivedLatest.data.snapshot?.id === candSave.data.id)
    const activeOnly = await callRoute(listCandidates, { query: { status: 'active' } })
    check('status=active 过滤生效', activeOnly.data.candidates.every((c) => c.status === 'active'))

    console.log('\n===== 8. 旧快照（candidate_id=NULL）可读 =====')
    const nullRows = db
      .prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots WHERE candidate_id IS NULL')
      .get().n
    check('历史快照 candidate_id 全部为 NULL', nullRows >= 2, String(nullRows))
    const histPublic = await callRoute(historyLatest, { query: { creator: '历史达人' } })
    check('旧快照（NULL）可正常读取', histPublic.data?.snapshot?.candidate_id === null && histPublic.data?.snapshot?.id === histOk.data.id)

    console.log('\n===== 9. 生命周期：改名后身份稳定（依赖 candidate_id，而非名称）=====')
    const renameCand = await callRoute(createCandidate, { body: { name: '旧达人名' } })
    const renameId = renameCand.data.id
    const snapA = await callRoute(saveCandidateSnapshot, {
      params: { id: String(renameId) },
      body: { observed_at: OBSERVED_AT, plays: [play('1.1万'), play('1.2万')] }
    })
    check('snapshot A 创建：creator=旧达人名', snapA.status === 200 && snapA.data.creator === '旧达人名' && snapA.data.candidate_id === renameId)
    const snapARowBefore = db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(snapA.data.id)
    const renamed = await callRoute(patchCandidate, { params: { id: String(renameId) }, body: { name: '新达人名' } })
    check('PATCH 改名成功', renamed.status === 200 && renamed.data.name === '新达人名')
    const latestAfterRename = await callRoute(candidateLatest, { params: { id: String(renameId) } })
    check(
      '改名后 latest 仍能找到 snapshot A（不断链）',
      latestAfterRename.data?.snapshot?.id === snapA.data.id,
      String(latestAfterRename.data?.snapshot?.id)
    )
    check(
      'snapshot A.creator 保持「旧达人名」（创建时名称快照，不回填 / 不 UPDATE）',
      latestAfterRename.data?.snapshot?.creator === '旧达人名',
      String(latestAfterRename.data?.snapshot?.creator)
    )
    const snapB = await callRoute(saveCandidateSnapshot, {
      params: { id: String(renameId) },
      body: { observed_at: '2026-09-30', plays: [play('9万'), play('10万'), play('11万'), play('12万'), play('13万'), play('14万')] }
    })
    check('snapshot B：candidate_id 仍为 X', snapB.data?.candidate_id === renameId, String(snapB.data?.candidate_id))
    check('snapshot B：creator 由服务端写成「新达人名」', snapB.data?.creator === '新达人名', String(snapB.data?.creator))
    const latestAfterB = await callRoute(candidateLatest, { params: { id: String(renameId) } })
    check('latest 正确返回 snapshot B（更新的 observed_at / created_at）', latestAfterB.data?.snapshot?.id === snapB.data.id, String(latestAfterB.data?.snapshot?.id))
    const snapARowAfter = db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(snapA.data.id)
    check(
      'snapshot A 业务字段 byte-for-byte 未变（不改写历史）',
      JSON.stringify(snapARowAfter) === JSON.stringify(snapARowBefore),
      JSON.stringify({ before: snapARowBefore.median_play, after: snapARowAfter.median_play })
    )
    check(
      '改名不按名称误连：不存在名为「旧达人名」的候选 / 新 latest 只认 candidate_id',
      db.prepare('SELECT COUNT(*) AS n FROM creator_candidates WHERE name = ?').get('旧达人名').n === 0
    )

    console.log('\n===== 10. 生命周期：archived 冻结写入（保留历史）=====')
    const archCand = await callRoute(createCandidate, { body: { name: '归档达人' } })
    const archId = archCand.data.id
    const archSnap = await callRoute(saveCandidateSnapshot, {
      params: { id: String(archId) },
      body: { observed_at: OBSERVED_AT, plays: [play('2万'), play('2.5万')] }
    })
    check('active 时可保存', archSnap.status === 200)
    await callRoute(patchCandidate, { params: { id: String(archId) }, body: { status: 'archived' } })
    const archDetail = await callRoute(detailCandidate, { params: { id: String(archId) } })
    check('archived：detail 仍可读取', archDetail.status === 200 && archDetail.data.status === 'archived')
    const archLatest = await callRoute(candidateLatest, { params: { id: String(archId) } })
    check('archived：latest 仍可读取（历史不隐藏）', archLatest.status === 200 && archLatest.data.snapshot?.id === archSnap.data.id)
    const archBlocked = await callRoute(saveCandidateSnapshot, {
      params: { id: String(archId) },
      body: { observed_at: '2026-09-30', plays: [play('3万')] }
    })
    check(
      'archived：新增 snapshot 被拒绝（4xx，提示需恢复 active）',
      archBlocked.status >= 400 && archBlocked.status < 500 && /归档|active/.test(String(archBlocked.msg)),
      `${archBlocked.status} ${archBlocked.msg}`
    )
    check(
      'archived：拒绝时未写入任何新快照',
      db.prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots WHERE candidate_id = ?').get(archId).n === 1
    )
    await callRoute(patchCandidate, { params: { id: String(archId) }, body: { status: 'active' } })
    const reactivated = await callRoute(saveCandidateSnapshot, {
      params: { id: String(archId) },
      body: { observed_at: '2026-09-30', plays: [play('3万'), play('3.1万')] }
    })
    check('恢复 active 后可继续新增 snapshot', reactivated.status === 200 && reactivated.data.candidate_id === archId)
    check(
      '恢复后历史仍保留（两条共存）',
      db.prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots WHERE candidate_id = ?').get(archId).n === 2
    )

    console.log('\n===== 11. Phase 2.1：xingtu_url 与 distilled_description =====')
    const withXingtu = await callRoute(createCandidate, {
      body: { name: '星图达人', profile_url: 'https://www.douyin.com/user/abc', xingtu_url: 'https://www.xingtu.cn/creator/xyz' }
    })
    check('合法 xingtu_url 可保存', withXingtu.status === 200 && withXingtu.data.xingtu_url === 'https://www.xingtu.cn/creator/xyz', String(withXingtu.data?.xingtu_url))
    check('profile_url 与 xingtu_url 独立', withXingtu.data.profile_url === 'https://www.douyin.com/user/abc' && withXingtu.data.xingtu_url !== withXingtu.data.profile_url)
    const noXingtu = await callRoute(createCandidate, { body: { name: '无星图达人', xingtu_url: null } })
    check('xingtu_url 可为 null', noXingtu.status === 200 && noXingtu.data.xingtu_url === null)
    const emptyXingtu = await callRoute(createCandidate, { body: { name: '空星图达人', xingtu_url: '   ' } })
    check('空字符串 -> null', emptyXingtu.status === 200 && emptyXingtu.data.xingtu_url === null)
    check('非 http/https（ftp）被拒', (await callRoute(createCandidate, { body: { name: 'x', xingtu_url: 'ftp://a.com' } })).status === 400)
    check('非 URL 文本被拒', (await callRoute(createCandidate, { body: { name: 'x', xingtu_url: 'just-text' } })).status === 400)
    const patchXingtu = await callRoute(patchCandidate, { params: { id: String(noXingtu.data.id) }, body: { xingtu_url: 'https://www.xingtu.cn/a' } })
    check('PATCH 可设置 xingtu_url', patchXingtu.status === 200 && patchXingtu.data.xingtu_url === 'https://www.xingtu.cn/a')
    check('PATCH 非法 xingtu_url 被拒', (await callRoute(patchCandidate, { params: { id: String(noXingtu.data.id) }, body: { xingtu_url: 'bad' } })).status === 400)
    // profile_url 是既有字段，本轮不改其校验语义（仍为自由文本）；只有 xingtu_url 增加 http/https 校验
    check('profile_url 校验保持不变（自由文本，不强制 URL）', (await callRoute(patchCandidate, { params: { id: String(noXingtu.data.id) }, body: { profile_url: '某主页说明' } })).status === 200)

    // 旧 candidate（无新字段）仍可读 —— 新建时不传新字段时两者均为 null
    const legacyLike = await callRoute(createCandidate, { body: { name: '旧结构达人' } })
    check('未提供新字段时 xingtu_url / distilled_description 均为 null', legacyLike.data.xingtu_url === null && legacyLike.data.distilled_description === null)

    // distilled_description：只有显式 PATCH 才写入；人工备注变化自动清空过期派生文本
    const dCand = await callRoute(createCandidate, { body: { name: '蒸馏达人', description: '备注A' } })
    const dId = dCand.data.id
    check('AI 输出不会自动写库（新建后 distilled_description=null）', dCand.data.distilled_description === null)
    const savedDistill = await callRoute(patchCandidate, { params: { id: String(dId) }, body: { distilled_description: 'AI整理A' } })
    check('用户保存后 distilled_description 才持久化', savedDistill.status === 200 && savedDistill.data.distilled_description === 'AI整理A')
    const sameDesc = await callRoute(patchCandidate, { params: { id: String(dId) }, body: { description: '备注A' } })
    check('description 未变化：不无意义清空 distilled_description', sameDesc.data.distilled_description === 'AI整理A', JSON.stringify(sameDesc.data?.distilled_description))
    const changedDesc = await callRoute(patchCandidate, { params: { id: String(dId) }, body: { description: '备注B' } })
    check('修改 description：旧 distilled_description 自动清空', changedDesc.data.description === '备注B' && changedDesc.data.distilled_description === null, JSON.stringify({ d: changedDesc.data?.description, dd: changedDesc.data?.distilled_description }))
    check('清除只清派生文本，不删除 candidate', db.prepare('SELECT COUNT(*) AS n FROM creator_candidates WHERE id = ?').get(dId).n === 1)
    const changeWithNew = await callRoute(createCandidate, { body: { name: '连带更新达人', description: 'A' } })
    await callRoute(patchCandidate, { params: { id: String(changeWithNew.data.id) }, body: { distilled_description: 'AI(A)' } })
    const changeAndProvide = await callRoute(patchCandidate, { params: { id: String(changeWithNew.data.id) }, body: { description: 'B', distilled_description: 'AI(B)' } })
    check('description 变化且同请求提供新蒸馏：保留新值', changeAndProvide.data.description === 'B' && changeAndProvide.data.distilled_description === 'AI(B)')
    check('旧 candidate 无新字段仍可正常读取', (await callRoute(detailCandidate, { params: { id: String(legacyLike.data.id) } })).status === 200)

    // 资料维护：只改 name / 链接不得让 AI 整理失效（AI 蒸馏只以 description 为输入）
    const keepCand = await callRoute(createCandidate, {
      body: { name: '保留蒸馏达人', description: '备注X', profile_url: 'https://a.com/p', xingtu_url: 'https://a.com/x' }
    })
    await callRoute(patchCandidate, { params: { id: String(keepCand.data.id) }, body: { distilled_description: 'AI(X)' } })
    const nameOnly = await callRoute(patchCandidate, { params: { id: String(keepCand.data.id) }, body: { name: '保留蒸馏达人2' } })
    check('只改 name 不清空 distilled_description', nameOnly.data.name === '保留蒸馏达人2' && nameOnly.data.distilled_description === 'AI(X)')
    const xingtuOnly = await callRoute(patchCandidate, { params: { id: String(keepCand.data.id) }, body: { xingtu_url: 'https://a.com/x2' } })
    check('只改 xingtu_url 不清空 distilled_description', xingtuOnly.data.xingtu_url === 'https://a.com/x2' && xingtuOnly.data.distilled_description === 'AI(X)')
    const profileOnly = await callRoute(patchCandidate, { params: { id: String(keepCand.data.id) }, body: { profile_url: 'https://a.com/p2' } })
    check('只改 profile_url 不清空 distilled_description', profileOnly.data.distilled_description === 'AI(X)')
    check('只改链接：profile_url / xingtu_url 仍独立', profileOnly.data.profile_url === 'https://a.com/p2' && profileOnly.data.xingtu_url === 'https://a.com/x2')
    check('编辑资料：candidate_id 不变', profileOnly.data.id === keepCand.data.id)
    const typeOnly = await callRoute(patchCandidate, { params: { id: String(keepCand.data.id) }, body: { creator_type: '科普' } })
    check('只改 creator_type 不清空 distilled_description', typeOnly.data.creator_type === '科普' && typeOnly.data.distilled_description === 'AI(X)')

    // Phase 2.2：星图 ID（字符串，正式字段；与 profile_url / legacy xingtu_url 独立）
    const idCand = await callRoute(createCandidate, {
      body: { name: '星图ID达人', description: '备注I', profile_url: 'https://a.com/p', xingtu_url: 'https://a.com/legacy', xingtu_id: '007123456' }
    })
    check('xingtu_id 原样保存（字符串）', idCand.status === 200 && idCand.data.xingtu_id === '007123456', String(idCand.data?.xingtu_id))
    check('前导 0 不丢失', idCand.data.xingtu_id === '007123456' && typeof idCand.data.xingtu_id === 'string')
    check('xingtu_id 与 profile_url 独立', idCand.data.profile_url === 'https://a.com/p' && idCand.data.xingtu_id !== idCand.data.profile_url)
    check('xingtu_id 与 legacy xingtu_url 独立', idCand.data.xingtu_url === 'https://a.com/legacy' && idCand.data.xingtu_id === '007123456')
    check('xingtu_id 可为 null（新建不传）', (await callRoute(createCandidate, { body: { name: '无ID达人' } })).data.xingtu_id === null)
    check('空字符串 -> null', (await callRoute(createCandidate, { body: { name: '空ID达人', xingtu_id: '   ' } })).data.xingtu_id === null)
    check('xingtu_id 超长 -> 400', (await callRoute(createCandidate, { body: { name: 'x', xingtu_id: 'a'.repeat(101) } })).status === 400)
    await callRoute(patchCandidate, { params: { id: String(idCand.data.id) }, body: { distilled_description: 'AI(I)' } })
    const idUpdated = await callRoute(patchCandidate, { params: { id: String(idCand.data.id) }, body: { xingtu_id: '999888' } })
    check('PATCH xingtu_id 可更新', idUpdated.status === 200 && idUpdated.data.xingtu_id === '999888')
    check('修改 xingtu_id 不清空 distilled_description', idUpdated.data.distilled_description === 'AI(I)')
    const idCleared = await callRoute(patchCandidate, { params: { id: String(idCand.data.id) }, body: { xingtu_id: '' } })
    check('PATCH xingtu_id 空串 -> null', idCleared.data.xingtu_id === null)
    check('清空 xingtu_id 不影响 legacy xingtu_url', idCleared.data.xingtu_url === 'https://a.com/legacy')
    check('legacy xingtu_url 不自动解析为 xingtu_id', idCleared.data.xingtu_url === 'https://a.com/legacy' && idCleared.data.xingtu_id === null)
    check('xingtu_id 不接受非字符串 / 非数字（对象）', (await callRoute(patchCandidate, { params: { id: String(idCand.data.id) }, body: { xingtu_id: { a: 1 } } })).status === 400)

    // 大 ID / 前导 0 round-trip：GET detail 必须逐字符一致；只改 xingtu_id 不动其它字段
    const BIG_ID = '7663552982146875442'
    const LEAD_ZERO_ID = '001234567890'
    const bigCand = await callRoute(createCandidate, {
      body: { name: '大ID达人', description: '备注B', profile_url: 'https://p.example', xingtu_id: BIG_ID }
    })
    await callRoute(patchCandidate, { params: { id: String(bigCand.data.id) }, body: { distilled_description: 'AI(B)' } })
    const snapForBig = await callRoute(saveCandidateSnapshot, {
      params: { id: String(bigCand.data.id) },
      body: { observed_at: OBSERVED_AT, plays: [play('1万'), play('2万')] }
    })
    const bigPatched = await callRoute(patchCandidate, { params: { id: String(bigCand.data.id) }, body: { xingtu_id: BIG_ID } })
    const bigDetail = await callRoute(detailCandidate, { params: { id: String(bigCand.data.id) } })
    check('大 ID round-trip 逐字符一致（PATCH + GET detail）', bigPatched.data.xingtu_id === BIG_ID && bigDetail.data.xingtu_id === BIG_ID, String(bigDetail.data?.xingtu_id))
    check('大 ID 仍为字符串类型（未被数字化）', typeof bigDetail.data.xingtu_id === 'string')
    const leadPatched = await callRoute(patchCandidate, { params: { id: String(bigCand.data.id) }, body: { xingtu_id: LEAD_ZERO_ID } })
    const leadDetail = await callRoute(detailCandidate, { params: { id: String(bigCand.data.id) } })
    check('前导 0 round-trip 保留', leadPatched.data.xingtu_id === LEAD_ZERO_ID && leadDetail.data.xingtu_id === LEAD_ZERO_ID, String(leadDetail.data?.xingtu_id))
    check('只改 xingtu_id：name / profile_url / description 不变', leadPatched.data.name === '大ID达人' && leadPatched.data.profile_url === 'https://p.example' && leadPatched.data.description === '备注B')
    check('只改 xingtu_id：candidate_id 不变', leadPatched.data.id === bigCand.data.id)
    check('只改 xingtu_id：不清空 distilled_description', leadPatched.data.distilled_description === 'AI(B)')
    check('只改 xingtu_id：snapshot 不受影响', db.prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots WHERE candidate_id = ?').get(bigCand.data.id).n === 1 && db.prepare('SELECT creator FROM creator_recent_snapshots WHERE id = ?').get(snapForBig.data.id).creator === '大ID达人')

    // 源码级：xingtu_id 读取器只做 String()，绝不 Number / parseInt（避免大整数精度丢失）
    const candRouteSrc = fs.readFileSync(path.join(root, 'backend/routes/creatorCandidates.js'), 'utf8')
    const idReaderSrc = candRouteSrc.slice(
      candRouteSrc.indexOf('function readOptionalXingtuId'),
      candRouteSrc.indexOf('function findCandidateRow')
    )
    check('xingtu_id 读取器使用 String(value)', /String\(value\)/.test(idReaderSrc))
    check('xingtu_id 读取器无 Number / parseInt / 一元加号', !/Number\(|parseInt\(|unary|\+\s*value/.test(idReaderSrc))
    check('schema 中 xingtu_id 为 TEXT（非 INTEGER）', /xingtu_id TEXT/.test(fs.readFileSync(path.join(root, 'backend/db.js'), 'utf8')))

    // 改名语义：candidate_id 稳定 / 旧 snapshot 保留旧名 / 新 snapshot 用新名 / latest 仍按 id
    const renameCand2 = await callRoute(createCandidate, { body: { name: '改名前', description: '备注R' } })
    await callRoute(patchCandidate, { params: { id: String(renameCand2.data.id) }, body: { distilled_description: 'AI(R)' } })
    const oldSnap = await callRoute(saveCandidateSnapshot, {
      params: { id: String(renameCand2.data.id) },
      body: { observed_at: OBSERVED_AT, plays: [play('1万'), play('2万')] }
    })
    const renamed2 = await callRoute(patchCandidate, { params: { id: String(renameCand2.data.id) }, body: { name: '改名后' } })
    check('改名：candidate_id 不变', renamed2.data.id === renameCand2.data.id)
    check('改名：不清空 distilled_description', renamed2.data.distilled_description === 'AI(R)')
    check('改名：旧 snapshot.creator 保留旧名（不 UPDATE）', db.prepare('SELECT creator FROM creator_recent_snapshots WHERE id = ?').get(oldSnap.data.id).creator === '改名前')
    const newSnap = await callRoute(saveCandidateSnapshot, {
      params: { id: String(renameCand2.data.id) },
      body: { observed_at: '2026-09-30', plays: [play('3万'), play('4万')] }
    })
    check('改名：新增 snapshot 由服务端写入新 name', newSnap.data.creator === '改名后' && newSnap.data.candidate_id === renameCand2.data.id)
    const renamedLatest = await callRoute(candidateLatest, { params: { id: String(renameCand2.data.id) } })
    check('改名：latest 仍按 candidate_id 查询', renamedLatest.data.snapshot?.id === newSnap.data.id)
    check('编辑资料不影响 Radar（候选不进 creator_records）', db.prepare('SELECT COUNT(*) AS n FROM creator_records WHERE nickname = ?').get('改名后').n === 0)

    console.log('\n===== 12. 安全边界 =====')
    check('未发生任何外部网络请求', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))
    const routeSource = fs.readFileSync(path.join(root, 'backend/routes/creatorCandidates.js'), 'utf8')
    check('Phase 1 路由不引用任何 AI 服务', !/deepseek|callProviderVision|extract-creator-screenshot/i.test(routeSource))
    check(
      'Phase 1 注册的候选路由集合',
      candidateRouter.stack
        .filter((l) => l.route)
        .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
        .sort()
        .join(' | ') ===
        'GET / | GET /:id | GET /:id/decisions | GET /:id/price-reference | GET /:id/recent-snapshots/latest | PATCH /:id | POST / | POST /:id/decisions | POST /:id/post-quote-decisions | POST /:id/recent-snapshots | POST /:id/work-state',
      candidateRouter.stack
        .filter((l) => l.route)
        .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
        .join(' | ')
    )
    check(
      '历史 recent-snapshots 路由集合未变（仍只有 GET /latest | POST /）',
      snapshotRouter.stack
        .filter((l) => l.route)
        .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
        .sort()
        .join(' | ') === 'GET /latest | POST /'
    )
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
