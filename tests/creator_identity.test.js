#!/usr/bin/env node
// Creator Identity V1 —— 纯函数 / strict alias / Work State 映射 回归测试
//
// 运行方式：node tests/creator_identity.test.js
// 特性：不启动服务、不写真实库、不访问网络、不调用 AI。
// 覆盖：normalizeAliasStrict（只允许 NFKC/trim/空白折叠/case fold）、resolver 0/1/N、
//       绝不 fuzzy / 拼音 / 编辑距离 / 去尾部句点、Work State legacy 映射、
//       seed grouping、link_source 升级、迁移脚本真实库护栏。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')

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

async function main() {
  const identity = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/utils/creatorIdentity.js')).href
  )
  const migration = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/migrations/001_creator_identity.js')).href
  )
  const identitySource = fs.readFileSync(
    path.join(REPO_ROOT, 'backend/utils/creatorIdentity.js'),
    'utf8'
  )

  console.log('===== 1. strict normalization（只允许 NFKC / trim / 空白折叠 / case fold）=====')
  check('NFKC：全角字母数字折叠为半角', identity.normalizeAliasStrict('ＢＯＳＳ１２３') === 'boss123')
  check('trim：首尾空白去除', identity.normalizeAliasStrict('  小王  ') === '小王')
  check('连续空白折叠为单个空格（不删除内部空格）', identity.normalizeAliasStrict('你好   样板达人04') === '你好 样板达人04')
  check('全角空格同样折叠', identity.normalizeAliasStrict('你好\u3000\u3000样板达人04') === '你好 样板达人04')
  check('case fold：拉丁大小写归一', identity.normalizeAliasStrict('Papi酱') === identity.normalizeAliasStrict('papi酱'))
  check('空 / null / undefined → 空串', identity.normalizeAliasStrict('') === '' && identity.normalizeAliasStrict(null) === '' && identity.normalizeAliasStrict(undefined) === '')
  check('确定性：同样输入多次调用结果一致', identity.normalizeAliasStrict('Ａ B') === identity.normalizeAliasStrict('Ａ B'))

  console.log('\n===== 2. strict 明确不做的事（绝不自动并人）=====')
  check('尾部句点差异：A ≠ A.（strict 不认同一 alias）', identity.normalizeAliasStrict('A') !== identity.normalizeAliasStrict('A.'))
  check('真实样本：样板达人17. 归一化后仍带尾点', identity.normalizeAliasStrict('样板达人17.') === '样板达人17.')
  check('标点差异不自动等价：小王≠小王！', identity.normalizeAliasStrict('小王') !== identity.normalizeAliasStrict('小王！'))
  check('不做拼音：小王 ≠ xiaowang', identity.normalizeAliasStrict('小王') !== identity.normalizeAliasStrict('xiaowang'))
  check('不做编辑距离：ABC ≠ ABD', identity.normalizeAliasStrict('ABC') !== identity.normalizeAliasStrict('ABD'))
  check('loose key 只用于 suggestion（A 与 A. 在 loose 下相同）', identity.looseSuggestionKey('A') === identity.looseSuggestionKey('A.'))
  check('loose key 不等于 strict（两者语义分离）', identity.looseSuggestionKey('A.') !== identity.normalizeAliasStrict('A.'))
  check(
    '模块内不存在 fuzzy / 拼音 / 编辑距离实现',
    !/levenshtein|jaro|similarity\s*\(|pinyin|editDistance/i.test(identitySource)
  )

  console.log('\n===== 3. Alias resolver：0 / 1 / N =====')
  const aliasRows = [
    { creator_id: 101, alias: '小王', alias_normalized: identity.normalizeAliasStrict('小王') },
    { creator_id: 207, alias: '小王', alias_normalized: identity.normalizeAliasStrict('小王') },
    { creator_id: 305, alias: 'A', alias_normalized: identity.normalizeAliasStrict('A') },
    { creator_id: 305, alias: 'A ', alias_normalized: identity.normalizeAliasStrict('A') } // 同 creator 重复 alias
  ]
  const n = identity.resolveAliasFromEntries(aliasRows, '小王')
  check('同名不同人 → N=2', n.count === 2 && JSON.stringify(n.creatorIds) === JSON.stringify([101, 207]))
  const one = identity.resolveAliasFromEntries(aliasRows, ' a ')
  check('同 creator 重复 alias → 仍然 1（id 去重）', one.count === 1 && one.creatorIds[0] === 305)
  check('未命中 → 0', identity.resolveAliasFromEntries(aliasRows, '查无此人').count === 0)
  check('空 alias → 0（不匹配任何 creator）', identity.resolveAliasFromEntries(aliasRows, '   ').count === 0)
  const decN = identity.decideAttribution({ aliasRows, rawName: '小王', creatorKeyByCreatorId: new Map([[101, 'c101'], [207, 'c207']]) })
  check('N 命中 → 不归属（creatorKey=null, reason=ambiguous）', decN.creatorKey === null && decN.reason === 'ambiguous')
  const dec1Map = identity.decideAttribution({ aliasRows, rawName: 'A', creatorKeyByCreatorId: new Map([[305, 'c305']]) })
  const dec1Obj = identity.decideAttribution({ aliasRows, rawName: 'A', creatorKeyByCreatorId: { 305: 'c305' } })
  check('1 命中 → 归属（Map 与普通对象两种入参都支持）', dec1Map.creatorKey === 'c305' && dec1Obj.creatorKey === 'c305')

  console.log('\n===== 4. Work State legacy 映射 =====')
  check('contact → advancing', identity.workStateFromLegacy('contact') === 'advancing')
  check('observe → observing', identity.workStateFromLegacy('observe') === 'observing')
  check('hold → paused', identity.workStateFromLegacy('hold') === 'paused')
  check('未知值 → null（不猜）', identity.workStateFromLegacy('promote') === null && identity.workStateFromLegacy(null) === null)
  check('反向映射（API 兼容）', identity.legacyFromWorkState('advancing') === 'contact' && identity.legacyFromWorkState('paused') === 'hold')
  check('state 词表冻结为 advancing/observing/paused', JSON.stringify(identity.WORK_STATE_STATES) === JSON.stringify(['advancing', 'observing', 'paused']))

  console.log('\n===== 5. Historical seed grouping（SEED GROUPING ≠ 身份确认）=====')
  const groups = identity.buildSeedGroups([
    { id: 1, nickname: '样板达人01', creator_type: '个人成长类' },
    { id: 2, nickname: '样板达人01', creator_type: '个人成长类' },
    { id: 3, nickname: '样板达人01', creator_type: '个人成长类' },
    { id: 4, nickname: ' 样板达人08 ', creator_type: '历史类' },
    { id: 5, nickname: '样板达人08', creator_type: '历史类' },
    { id: 6, nickname: '类型不一致', creator_type: '科普类' },
    { id: 7, nickname: '类型不一致', creator_type: '历史类' },
    { id: 8, nickname: '   ', creator_type: '科普类' }
  ])
  const byLabel = new Map(groups.map((g) => [g.label, g]))
  check('同 nickname 多轮 → 1 个 seed group（样板达人01 3 轮）', byLabel.get('样板达人01')?.recordIds.length === 3)
  check('分组键 trim（前后空白不影响身份）', byLabel.has('样板达人08') && byLabel.get('样板达人08').recordIds.length === 2)
  check('全部轮次类型一致 → creator_type 可用', byLabel.get('样板达人01').creatorType === '个人成长类')
  check('类型不一致 → creator_type = null（不挑一条猜）', byLabel.get('类型不一致').creatorType === null)
  check('空 nickname → 未命名达人（与既有产品口径一致）', byLabel.has('未命名达人'))
  check('seed key 前缀稳定', byLabel.get('样板达人01').key === 'seed:样板达人01')

  console.log('\n===== 6. link source（可审计的归属来源）=====')
  check('合法来源集合', JSON.stringify(identity.CREATOR_LINK_SOURCES) === JSON.stringify(['seed_grouping', 'alias_exact', 'outcome_link', 'manual']))
  check('NULL 合法（尚未归属）', identity.isCreatorLinkSource(null) === true)
  check('未知来源非法', identity.isCreatorLinkSource('guessed') === false)
  check(
    'outcome_link 强于 seed_grouping（可升级）',
    identity.strongerLinkSource('seed_grouping', 'outcome_link') === 'outcome_link' &&
      identity.strongerLinkSource('outcome_link', 'seed_grouping') === 'outcome_link'
  )
  check('manual 最强', identity.strongerLinkSource('outcome_link', 'manual') === 'manual')
  check('两边都未知 → null', identity.strongerLinkSource(null, 'nope') === null)

  console.log('\n===== 7. 迁移脚本护栏（不得在真实库执行）=====')
  let realRejected = false
  try {
    migration.guardDbPath(migration.REAL_DB_PATH, 'dry-run')
  } catch {
    realRejected = true
  }
  check('dry-run 也拒绝真实库路径', realRejected)
  let commitRejected = false
  try {
    migration.guardDbPath(path.join(REPO_ROOT, 'backend', 'some-other.db'), 'commit')
  } catch {
    commitRejected = true
  }
  check('--commit 拒绝非临时库路径', commitRejected)
  const tmpPath = path.join(os.tmpdir(), 'creator-identity-guard', 'workbench.db')
  check('--commit 允许临时库路径', migration.guardDbPath(tmpPath, 'commit').endsWith('workbench.db'))
  // 回归：不存在的临时路径（无法 realpath）也必须被接受；仓库内路径必须被拒绝
  const nonExistentTemp = path.join(os.tmpdir(), 'creator-identity-guard-not-created', 'x.db')
  check('--commit 允许“尚未创建”的临时库路径（realpath 不可用也不能误拒）',
    migration.guardDbPath(nonExistentTemp, 'commit').endsWith('x.db'))
  check('isUnderTempRoot：临时路径 true / 仓库路径 false',
    migration.isUnderTempRoot(nonExistentTemp) === true &&
      migration.isUnderTempRoot(path.join(REPO_ROOT, 'backend', 'workbench.db')) === false)
  check('REAL_DB_PATH 指向 backend/workbench.db', migration.REAL_DB_PATH === path.join(REPO_ROOT, 'backend', 'workbench.db'))
  check(
    'canonicalDbPath 与 REAL_DB_PATH 等价（symlink 安全）',
    migration.canonicalDbPath('backend/workbench.db') === migration.canonicalDbPath(migration.REAL_DB_PATH)
  )
  check(
    'isRealDbPath 识别真实库与副本',
    migration.isRealDbPath(migration.REAL_DB_PATH) === true && migration.isRealDbPath(tmpPath) === false
  )
  check(
    '真实库 commit：显式 allow-real-db 才放行（默认仍拒绝）',
    migration.guardDbPath(migration.REAL_DB_PATH, 'commit', { allowRealDb: true }) ===
      migration.canonicalDbPath(migration.REAL_DB_PATH)
  )
  let realDryRunRejected = false
  try {
    migration.guardDbPath(migration.REAL_DB_PATH, 'dry-run', { allowRealDb: true })
  } catch {
    realDryRunRejected = true
  }
  check('allow-real-db 不能用于 dry-run（dry-run 永远用副本）', realDryRunRejected)
  check(
    '迁移脚本不导入任何网络 / AI 模块',
    !/axios|fetch\(|deepseek|callProvider/i.test(
      fs.readFileSync(path.join(REPO_ROOT, 'backend/migrations/001_creator_identity.js'), 'utf8')
    )
  )
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    // 关键：异常必须计入失败，否则 main() 中途抛错会被打印成「失败：0 / 通过率 100%」而静默截断
    failCount += 1
    failures.push(`执行异常：${error?.message || error}`)
    process.exitCode = 1
  })
  .finally(() => {
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
