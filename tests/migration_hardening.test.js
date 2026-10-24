#!/usr/bin/env node
/**
 * Migration 003 安全加固回归（全部隔离临时库，零真实库写入）
 *
 * 覆盖：WAL 逻辑快照（主文件 SHA 不变但 WAL 有更新 → 备份包含最新已提交值）、
 * 指纹绑定备份文件内容（错误 SHA / 截断 SHA / 与源库无关的空库均被拒绝）、
 * 备份创建失败即停止、建表+索引原子事务（索引失败整体回滚）、幂等重跑。
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const migrationUrl = pathToFileURL(path.join(root, 'backend/migrations/003_record_edits.js')).href
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mig003-hardening-'))

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

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
}

async function main() {
  const mig = await import(migrationUrl)
  // better-sqlite3 安装在 backend 下（根目录无该依赖）
  const backendRequire = createRequire(path.join(root, 'backend/package.json'))
  const Database = backendRequire('better-sqlite3')

  console.log('\n===== 1. WAL 逻辑快照 =====')
  const walDbPath = path.join(TMP, 'wal.db')
  const walDb = new Database(walDbPath)
  walDb.pragma('journal_mode = WAL')
  walDb.exec('CREATE TABLE business_data (id INTEGER PRIMARY KEY, value TEXT)')
  walDb.prepare("INSERT INTO business_data (value) VALUES ('v1')").run()
  walDb.pragma('wal_checkpoint(TRUNCATE)')
  const mainShaBefore = sha256File(walDbPath)
  // 连接保持打开：新写入只进 WAL，主文件字节不变（正是真实库当前状态）
  walDb.prepare("INSERT INTO business_data (value) VALUES ('v2-in-wal')").run()
  const mainShaAfter = sha256File(walDbPath)
  check('WAL 写入后主文件 SHA 不变（SHA 盲区场景成立）', mainShaAfter === mainShaBefore)

  const backupPath = path.join(TMP, 'private', 'wal-snapshot.db')
  const meta = await mig.createLogicalBackup(walDbPath, backupPath)
  check('snapshot 成功生成备份', fs.existsSync(backupPath) && fs.existsSync(`${backupPath}.meta.json`))
  check('备份权限 0600', (fs.statSync(backupPath).mode & 0o777) === 0o600)
  check('备份目录权限 0700', (fs.statSync(path.dirname(backupPath)).mode & 0o777) === 0o700)
  check('meta 记录的 backup_sha256 与文件实际 SHA 一致',
    meta.backup_sha256 === sha256File(backupPath))
  const backupConn = new Database(backupPath, { readonly: true })
  const walValue = backupConn.prepare("SELECT value FROM business_data WHERE value = 'v2-in-wal'").get()
  check('备份包含 WAL 中最新已提交值（非主文件复制）', Boolean(walValue))
  backupConn.close()
  check('备份后源库主文件字节仍未变（只读备份，不 checkpoint）',
    sha256File(walDbPath) === mainShaBefore)

  console.log('\n===== 2. 指纹校验 =====')
  let threw = null
  try {
    mig.verifyCommitPrerequisites({ sourcePath: walDbPath, backupPath, expectedSha: 'a'.repeat(64) })
  } catch (error) { threw = error }
  check('错误期望指纹被拒绝', threw !== null && /指纹不匹配/.test(threw.message))
  threw = null
  try {
    mig.verifyCommitPrerequisites({ sourcePath: walDbPath, backupPath, expectedSha: meta.backup_sha256.slice(0, 12) })
  } catch (error) { threw = error }
  check('截断 SHA 被明确拒绝', threw !== null && /64 位十六进制/.test(threw.message))

  // 与源库无关的空库：指纹匹配（对它自己）但逻辑状态不一致 → 拒绝
  const emptyDbPath = path.join(TMP, 'empty.db')
  const emptyDb = new Database(emptyDbPath)
  emptyDb.close()
  threw = null
  try {
    mig.verifyCommitPrerequisites({
      sourcePath: walDbPath, backupPath: emptyDbPath, expectedSha: sha256File(emptyDbPath)
    })
  } catch (error) { threw = error }
  check('与源库无关的空备份被逻辑一致性校验拒绝',
    threw !== null && /逻辑状态与备份不一致|表行数不一致|没有此表|no such table/i.test(threw.message), threw && threw.message.split('\n')[0])

  // 正确指纹 + 备份与源库一致 → 通过
  const okReport = mig.verifyCommitPrerequisites({
    sourcePath: walDbPath, backupPath, expectedSha: meta.backup_sha256
  })
  check('正确指纹 + 逻辑一致 → 校验通过', okReport.backupSha === meta.backup_sha256)

  console.log('\n===== 3. 备份失败即停止 =====')
  threw = null
  try {
    await mig.createLogicalBackup(walDbPath, backupPath)
  } catch (error) { threw = error }
  check('拒绝覆盖已有备份文件', threw !== null && /拒绝覆盖/.test(threw.message))
  threw = null
  try {
    await mig.createLogicalBackup(walDbPath, path.join(root, 'backend', 'must-not-exist-backup.db'))
  } catch (error) { threw = error }
  check('拒绝仓库内备份路径', threw !== null && /仓库外/.test(threw.message))
  check('仓库内未残留备份文件', !fs.existsSync(path.join(root, 'backend', 'must-not-exist-backup.db')))

  console.log('\n===== 4. 原子迁移 =====')
  const migDbPath = path.join(TMP, 'mig.db')
  const migDb = new Database(migDbPath)
  migDb.exec('CREATE TABLE legacy_data (id INTEGER PRIMARY KEY, note TEXT)')
  migDb.prepare("INSERT INTO legacy_data (note) VALUES ('keep-me')").run()
  mig.migrateRecordEdits(migDb)
  check('建表 + 索引成功', tableExists(migDb, 'creator_record_edits') &&
    migDb.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_creator_record_edits_record'").get())
  const repeat = mig.migrateRecordEdits(migDb)
  check('重复执行安全（幂等）', repeat.created === false)

  // 索引创建失败 → 整个事务回滚，不留半完成 schema
  const failDbPath = path.join(TMP, 'fail.db')
  const failDb = new Database(failDbPath)
  failDb.exec('CREATE TABLE legacy_data (id INTEGER PRIMARY KEY, note TEXT)')
  failDb.prepare("INSERT INTO legacy_data (note) VALUES ('keep-me')").run()
  failDb.exec('CREATE VIEW idx_creator_record_edits_record AS SELECT 1')  // 占用索引名 → CREATE INDEX 失败
  threw = null
  try { mig.migrateRecordEdits(failDb) } catch (error) { threw = error }
  check('索引创建失败抛错', threw !== null)
  check('失败后无半完成 schema（表被回滚）', !tableExists(failDb, 'creator_record_edits'))
  check('既有业务数据不受影响', failDb.prepare('SELECT note FROM legacy_data').get().note === 'keep-me')
  failDb.exec('DROP VIEW idx_creator_record_edits_record')
  mig.migrateRecordEdits(failDb)
  check('清除冲突后重跑成功', tableExists(failDb, 'creator_record_edits'))
  failDb.close()

  console.log('\n===== 5. CLI 冒烟 =====')
  const cliDry = spawnSync(process.execPath, [
    path.join(root, 'backend/migrations/003_record_edits.js'), '--dry-run', '--db', migDbPath
  ], { encoding: 'utf8' })
  check('CLI dry-run 退出码 0 且报告已存在', cliDry.status === 0 && /已存在/.test(cliDry.stdout))
  const cliSnap = spawnSync(process.execPath, [
    path.join(root, 'backend/migrations/003_record_edits.js'), 'snapshot', '--db', walDbPath, '--out', path.join(TMP, 'private2', 'cli.db')
  ], { encoding: 'utf8' })
  check('CLI snapshot 退出码 0 并输出指纹', cliSnap.status === 0 && /backup_sha256 = [0-9a-f]{64}/.test(cliSnap.stdout))

  // 资源清理
  walDb.close()
  migDb.close()
  check('临时目录均在系统临时区（真实库未参与）', TMP.startsWith(os.tmpdir()))

  console.log(`\n================ 测试汇总 ================`)
  console.log(`用例总数：${passCount + failCount}　通过：${passCount}　失败：${failCount}`)
  if (failCount > 0) {
    console.log('失败用例：')
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('测试异常：', error)
  process.exit(1)
})
