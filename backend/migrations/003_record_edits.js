#!/usr/bin/env node
/**
 * 003_record_edits — 投放记录编辑历史审计表（独立正式 migration，含安全加固 V2）
 *
 * 用途：
 *   为「投放记录编辑留痕」提供 append-only 审计表 creator_record_edits。
 *   手工编辑（PUT）、批量修改、单条/批量删除、导入撤销删除、旧版导入更新的
 *   真实变化都记录到该表；带批次元数据的导入更新仍由 import_batch_record_updates
 *   记账（不双写）。
 *
 * 三种模式：
 *
 *   1) dry-run（默认，不改任何库）：
 *        node backend/migrations/003_record_edits.js --dry-run --db <路径>
 *
 *   2) snapshot（只读生成迁移前逻辑快照）：
 *        node backend/migrations/003_record_edits.js snapshot --db <源库> --out <备份.db>
 *      · 使用 SQLite Online Backup API（better-sqlite3 db.backup()），
 *        备份内容 = 主库 + WAL 全部有效提交状态（不是复制 .db 主文件）
 *      · 源库以 readonly 连接读取，不 checkpoint、不截断 WAL
 *      · 备份必须写到 Git 仓库外的私有目录；拒绝覆盖已有文件；0600/0700 权限
 *      · 生成 <备份>.meta.json（同样 0600）：backup_sha256 / logical_digest / 各表行数
 *      · 终端打印 backup_sha256 —— 用户独立确认（shasum -a 256）并固定为迁移授权指纹
 *
 *   3) commit（正式建表）：
 *      临时库：  node backend/migrations/003_record_edits.js --commit --db <临时库>
 *      真实库：  node backend/migrations/003_record_edits.js --commit --db backend/workbench.db \
 *                 --allow-real-db --backup-path <snapshot 生成的备份.db> \
 *                 --expected-source-sha <snapshot 打印的完整 SHA-256>
 *      · 指纹绑定「备份文件完整内容」，由用户在 snapshot 后独立固定，迁移时逐字节比对
 *        —— 同一次执行里不存在「自己算 SHA 再自己验证自己」的自我背书
 *      · 校验备份 integrity / 逻辑 digest / 各表行数，且源库逻辑 digest 双读一致
 *        （验证窗口内无并发写入）并与备份一致（快照后源库未变化，WAL 状态已含在快照内）
 *      · 建表 + 索引在同一事务内；任一步失败整体回滚，不留半完成 schema
 *      · 幂等：表已存在则报告 already-applied，不重复创建、不删除旧表、不回填
 *
 * 私有数据边界：
 *   备份写到仓库外（用户自选私有目录），文件权限 0600、目录权限 0700；
 *   仓库内 .gitignore 另有 *.db / *.db-wal 兜底。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'

export const MIGRATION_NAME = '003_record_edits'

export const CREATOR_RECORD_EDITS_DDL = `
  CREATE TABLE IF NOT EXISTS creator_record_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('update', 'delete')),
    source TEXT NOT NULL CHECK (source IN (
      'manual_single', 'manual_batch', 'manual_delete', 'batch_delete',
      'import_rollback', 'legacy_import_update'
    )),
    group_id TEXT,
    field_name TEXT NOT NULL,
    before_value_json TEXT,
    after_value_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`

const CREATOR_RECORD_EDITS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_creator_record_edits_record
    ON creator_record_edits(record_id, id);
`

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REAL_DB_PATH = path.resolve(__dirname, '..', 'workbench.db')
const REPO_ROOT = path.resolve(__dirname, '..')

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function integrityOk(db) {
  return db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok'
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

/**
 * 逻辑状态摘要：覆盖全部用户表（schema + 全部行内容，按稳定顺序序列化）。
 * 两个数据库 digest 相同 ⇔ 表结构、行数、每一行的值完全一致。
 * WAL 逻辑状态通过数据库连接读取（含未 checkpoint 的已提交数据）。
 */
export function computeLogicalDigest(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name)
  const hash = crypto.createHash('sha256')
  const stats = {}
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((c) => c.name)
    const rows = db.prepare(`SELECT * FROM ${quoteIdent(table)} ORDER BY rowid`).all()
    stats[table] = { columns, rows: rows.length }
    hash.update(`${table}|${columns.join(',')}|${rows.length}\n`)
    for (const row of rows) {
      const keys = Object.keys(row).sort()
      hash.update(keys.map((k) => `${k}=${JSON.stringify(row[k])}`).join('&') + '\n')
    }
  }
  return { digest: hash.digest('hex'), tables: stats }
}

/**
 * 生成迁移前一致性逻辑快照（只读操作，不修改源库任何业务字节）。
 * 返回 meta（含 backup_sha256 —— 用户应独立复核并固定该指纹）。
 */
export async function createLogicalBackup(sourcePath, outPath) {
  const resolvedSource = path.resolve(sourcePath)
  const resolvedOut = path.resolve(outPath)
  if (resolvedOut === REPO_ROOT || resolvedOut.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`备份必须写到 Git 仓库外的私有目录，拒绝仓库内路径：${resolvedOut}`)
  }
  if (fs.existsSync(resolvedOut)) {
    throw new Error(`备份文件已存在，拒绝覆盖：${resolvedOut}`)
  }
  const metaPath = `${resolvedOut}.meta.json`
  if (fs.existsSync(metaPath)) {
    throw new Error(`备份元数据已存在，拒绝覆盖：${metaPath}`)
  }
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true })
  fs.chmodSync(path.dirname(resolvedOut), 0o700)

  const source = new Database(resolvedSource, { readonly: true })
  let backupConn = null
  try {
    if (!integrityOk(source)) {
      throw new Error('源库 integrity_check 未通过，终止备份')
    }
    // Online Backup API：读取主库 + WAL 全部有效提交状态（非主文件复制）
    await source.backup(resolvedOut)
    fs.chmodSync(resolvedOut, 0o600)

    backupConn = new Database(resolvedOut, { readonly: true })
    if (!integrityOk(backupConn)) {
      throw new Error('备份 integrity_check 未通过，备份无效')
    }
    const backupState = computeLogicalDigest(backupConn)
    const sourceConn = new Database(resolvedSource, { readonly: true })
    let sourceState
    try {
      sourceState = computeLogicalDigest(sourceConn)
    } finally {
      sourceConn.close()
    }
    if (sourceState.digest !== backupState.digest) {
      throw new Error('备份逻辑状态与源库不一致（可能缺少 WAL 有效提交状态），备份无效')
    }
    const backupSha256 = sha256File(resolvedOut)
    const meta = {
      version: 2,
      created_at: new Date().toISOString(),
      source: resolvedSource,
      backup_file: resolvedOut,
      backup_sha256: backupSha256,
      logical_digest: backupState.digest,
      tables: backupState.tables
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 })
    return meta
  } catch (error) {
    if (backupConn) {
      try { backupConn.close() } catch { /* 忽略关闭异常 */ }
      backupConn = null
    }
    // 失败清理：不留无效备份与元数据
    try { fs.rmSync(resolvedOut, { force: true }) } catch { /* 尽力清理 */ }
    try { fs.rmSync(metaPath, { force: true }) } catch { /* 尽力清理 */ }
    throw error
  } finally {
    if (backupConn) backupConn.close()
    source.close()
  }
}

/**
 * commit 前置校验：
 *   · expectedSha 必须是完整 64 位十六进制（拒绝截断）
 *   · 指纹 = 备份文件完整内容的 SHA-256（用户在 snapshot 后独立固定）
 *   · 备份 integrity / 逻辑 digest / 各表行数
 *   · 源库 integrity；逻辑 digest 双读一致（验证窗口内无并发写入）
 *   · 源库当前逻辑状态与备份一致（快照后源库未变化）
 */
export function verifyCommitPrerequisites({ sourcePath, backupPath, expectedSha }) {
  if (typeof expectedSha !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedSha.trim())) {
    throw new Error(
      'expected-source-sha 必须是完整 64 位十六进制 SHA-256（不接受截断值）；' +
        '请使用 snapshot 命令输出的 backup_sha256'
    )
  }
  if (!fs.existsSync(backupPath)) {
    throw new Error(`备份文件不存在：${backupPath}`)
  }
  const backupSha = sha256File(backupPath)
  if (backupSha !== expectedSha.trim().toLowerCase()) {
    throw new Error(
      `期望指纹不匹配：expected=${expectedSha.trim().toLowerCase()} actual=${backupSha}\n` +
        `指纹绑定备份文件完整内容：${path.resolve(backupPath)}\n` +
        '请确认使用的是 snapshot 命令生成且经你独立复核（shasum -a 256）的备份。'
    )
  }
  const backup = new Database(backupPath, { readonly: true })
  try {
    if (!integrityOk(backup)) {
      throw new Error('备份 integrity_check 未通过，终止迁移')
    }
    const backupState = computeLogicalDigest(backup)
    const source = new Database(sourcePath, { readonly: true })
    let sourceState
    try {
      if (!integrityOk(source)) {
        throw new Error('源库 integrity_check 未通过，终止迁移')
      }
      const first = computeLogicalDigest(source)
      const second = computeLogicalDigest(source)
      if (first.digest !== second.digest) {
        throw new Error(
          '源库在验证期间发生了写入：请优雅停止业务写入（含后端进程）后，' +
            '重新生成快照并重新确认指纹'
        )
      }
      sourceState = first
    } finally {
      source.close()
    }
    if (sourceState.digest !== backupState.digest) {
      throw new Error(
        '源库当前逻辑状态与备份不一致：自快照以来源库已发生变化（含 WAL 新提交），\n' +
          '旧授权不可继续使用。请重新 snapshot 并重新确认指纹。'
      )
    }
    for (const [table, info] of Object.entries(backupState.tables)) {
      const sourceInfo = sourceState.tables[table]
      if (!sourceInfo || sourceInfo.rows !== info.rows) {
        throw new Error(`备份与源库表行数不一致：${table}`)
      }
    }
    return {
      backupSha,
      logicalDigest: backupState.digest,
      tables: backupState.tables,
      includesWal: true
    }
  } finally {
    backup.close()
  }
}

/** 在给定连接上应用 schema（幂等：表已存在则跳过）；返回 { created } */
export function applyRecordEditsSchema(db) {
  const existed = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'creator_record_edits'"
    )
    .get()
  if (existed) return { created: false }
  db.exec(CREATOR_RECORD_EDITS_DDL)
  db.exec(CREATOR_RECORD_EDITS_INDEX_DDL)
  return { created: true }
}

/**
 * 正式建表：CREATE TABLE 与 CREATE INDEX 在同一事务内。
 * 任一步失败整体回滚，不留半完成 schema。
 */
export function migrateRecordEdits(db) {
  const run = db.transaction(() => applyRecordEditsSchema(db))
  return run()
}

function parseArgs(argv) {
  const args = {
    command: null, dryRun: true, commit: false, db: null, out: null,
    allowRealDb: false, backupPath: null, expectedSourceSha: null
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === 'snapshot') args.command = 'snapshot'
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--commit') { args.commit = true; args.dryRun = false }
    else if (arg === '--db') args.db = argv[++i] || null
    else if (arg === '--out') args.out = argv[++i] || null
    else if (arg === '--allow-real-db') args.allowRealDb = true
    else if (arg === '--backup-path') args.backupPath = argv[++i] || null
    else if (arg === '--expected-source-sha') args.expectedSourceSha = argv[++i] || null
    else { console.error(`[003] 未知参数：${arg}`); process.exit(1) }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.command === 'snapshot') {
    if (!args.db || !args.out) {
      console.error('[003] snapshot 需要 --db <源库> --out <备份.db>（备份须在仓库外私有目录）')
      process.exit(1)
    }
    if (!fs.existsSync(args.db)) {
      console.error(`[003] 源库不存在：${args.db}`)
      process.exit(1)
    }
    try {
      const meta = await createLogicalBackup(args.db, args.out)
      console.log('[003] 一致性逻辑快照已生成（含 WAL 有效提交状态）：')
      console.log(`  备份文件：${meta.backup_file}（0600）`)
      console.log(`  元数据：  ${meta.backup_file}.meta.json（0600）`)
      console.log(`  backup_sha256 = ${meta.backup_sha256}`)
      console.log('  请独立复核：shasum -a 256 <备份文件>，并将该值作为 --expected-source-sha 固定下来。')
      const tableSummary = Object.entries(meta.tables)
        .map(([name, info]) => `${name}=${info.rows}`)
        .join(' ')
      console.log(`  逻辑快照表行数：${tableSummary}`)
    } catch (error) {
      console.error('[003] 快照失败：', error.message)
      process.exit(1)
    }
    return
  }

  if (!args.db) {
    console.error('[003] 必须通过 --db 指定数据库路径')
    process.exit(1)
  }
  if (!fs.existsSync(args.db)) {
    console.error(`[003] 数据库不存在：${args.db}`)
    process.exit(1)
  }

  const targetRealPath = path.resolve(args.db)
  const isRealDb = targetRealPath === REAL_DB_PATH
  if (isRealDb && !args.allowRealDb) {
    console.error('[003] 拒绝操作真实库：默认只允许临时副本。确认后请提供 --allow-real-db --backup-path --expected-source-sha')
    process.exit(1)
  }

  if (args.commit && isRealDb) {
    if (!args.backupPath || !args.expectedSourceSha) {
      console.error('[003] 真实库 commit 必须提供 --backup-path 与 --expected-source-sha（来自 snapshot）')
      process.exit(1)
    }
    let report
    try {
      report = verifyCommitPrerequisites({
        sourcePath: args.db,
        backupPath: args.backupPath,
        expectedSha: args.expectedSourceSha
      })
    } catch (error) {
      console.error('[003] 迁移前置校验未通过，已停止：', error.message)
      process.exit(1)
    }
    console.log(`[003] 备份指纹校验通过：${report.backupSha}`)
    console.log(`[003] 逻辑状态一致（含 WAL，共 ${Object.keys(report.tables).length} 张表）`)

    const db = new Database(args.db)
    try {
      migrateRecordEdits(db)
      const count = db.prepare('SELECT COUNT(*) AS n FROM creator_record_edits').get().n
      console.log(`[003] 已创建 creator_record_edits（当前审计事件 ${count} 条，不做任何回填）`)
      console.log('[003] integrity:', integrityOk(db))
    } finally {
      db.close()
    }
    return
  }

  const db = new Database(args.db)
  try {
    if (!integrityOk(db)) {
      console.error('[003] 数据库 integrity_check 未通过，终止迁移')
      process.exit(1)
    }

    const already = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'creator_record_edits'")
      .get()
    if (already) {
      console.log('[003] creator_record_edits 已存在，无需重复迁移')
      return
    }

    if (args.commit) {
      // 临时库 commit：同样原子（建表 + 索引同事务）
      migrateRecordEdits(db)
      const count = db.prepare('SELECT COUNT(*) AS n FROM creator_record_edits').get().n
      console.log(`[003] 已在指定库创建 creator_record_edits（审计事件 ${count} 条）`)
      console.log('[003] integrity:', integrityOk(db))
    } else {
      // dry-run：BEGIN → apply → 校验 → ROLLBACK（库不变）
      db.exec('BEGIN')
      try {
        applyRecordEditsSchema(db)
        const columns = db.prepare('PRAGMA table_info(creator_record_edits)').all().map((c) => c.name)
        console.log('[003] dry-run 通过，将创建列：', columns.join(', '))
      } finally {
        db.exec('ROLLBACK')
      }
      console.log('[003] dry-run 完成：数据库未发生任何变更')
    }
  } finally {
    db.close()
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isEntryPoint) {
  main().catch((error) => {
    console.error('[003] 迁移异常：', error)
    process.exit(1)
  })
}
