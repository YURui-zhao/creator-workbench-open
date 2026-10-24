import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyRecordEditsSchema } from './migrations/003_record_edits.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 默认使用 backend/workbench.db；允许通过环境变量指向其它数据库文件（仅用于测试隔离）
const dbPath = process.env.WORKBENCH_DB_PATH
  ? path.resolve(process.env.WORKBENCH_DB_PATH)
  : path.join(__dirname, 'workbench.db')

// 首次运行自动创建数据库文件与数据表
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS creator_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time_cycle TEXT,
    nickname TEXT,
    homepage TEXT,
    creator_type TEXT,
    content_link TEXT,
    total_cost REAL,
    publish_date TEXT,
    video_link TEXT,
    first_play INTEGER,
    second_week_play INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- 常用筛选字段建立索引，提升分页/筛选查询性能
  CREATE INDEX IF NOT EXISTS idx_records_time_cycle ON creator_records(time_cycle);
  CREATE INDEX IF NOT EXISTS idx_records_creator_type ON creator_records(creator_type);
  CREATE INDEX IF NOT EXISTS idx_records_publish_date ON creator_records(publish_date);
  CREATE INDEX IF NOT EXISTS idx_records_nickname ON creator_records(nickname);

  -- 兼容工作台前端旧接口
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    progress INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  -- 导入批次日志（只做导入历史记录，不参与业务计算，不改动 creator_records）
  CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT,
    total_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    skip_count INTEGER DEFAULT 0,
    duplicate_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 批次 <-> 投放记录 关联（用于「按批次筛选投放记录」，不改动 creator_records 表结构）
  CREATE TABLE IF NOT EXISTS import_batch_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    record_id INTEGER NOT NULL
  );

  -- 批次明细（失败/跳过/重复/成功 的行级记录，用于导入历史详情展示）
  CREATE TABLE IF NOT EXISTS import_batch_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    row_index INTEGER,
    status TEXT,
    reason TEXT
  );

  -- Import 对已有投放记录的字段级更新审计（Existing Record Update V0.1）
  -- 说明：
  --   · 与新建记录分开：只记录「哪个批次、哪条记录、哪个字段、更新前/后」，
  --     不复制 creator_records 的其它业务数据（creator_records 仍是事实来源）
  --   · 无 FK，保持本库既有风格
  --   · before/after 用 JSON 表达，保留 0 与 NULL 的区别（0 = 已观察真实 0，NULL = 未观察）
  --   · 本阶段 field_name 实际只有 second_week_play
  CREATE TABLE IF NOT EXISTS import_batch_record_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    record_id INTEGER NOT NULL,
    field_name TEXT NOT NULL,
    before_value_json TEXT,
    after_value_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(batch_id, record_id, field_name)
  );

  CREATE INDEX IF NOT EXISTS idx_import_batches_created_at ON import_batches(created_at);
  CREATE INDEX IF NOT EXISTS idx_import_batch_records_batch ON import_batch_records(batch_id);
  CREATE INDEX IF NOT EXISTS idx_import_batch_items_batch ON import_batch_items(batch_id);
  CREATE INDEX IF NOT EXISTS idx_import_batch_updates_batch ON import_batch_record_updates(batch_id);
  CREATE INDEX IF NOT EXISTS idx_import_batch_updates_record ON import_batch_record_updates(record_id);

  -- V3-alpha P2B：达人近期表现快照（append-only，只保存人工确认后的结构化数据）
  -- 说明：
  --   · 不保存原截图 / base64 / 图片路径 / API Key / provider 原始响应 / prompt 全文
  --   · 只允许新增，不提供覆盖更新（历史快照需要可追溯「当时看到的近期状态」）
  --   · plays_json 保留每条人工确认后的 raw_text / normalized_play / excluded / source_image_index / position_index / needs_review
  --   · stats_version 记录当时采用的统计口径（去极值规则 / quantile 算法 / trend 阈值）
  CREATE TABLE IF NOT EXISTS creator_recent_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator TEXT NOT NULL,
    -- V3-alpha.3 Playbook Phase 1：候选达人稳定身份（candidate_id = creator_candidates.id）
    -- NULL = 历史达人快照（身份沿用 creator 名称）；新候选人快照才写入 candidate_id。
    candidate_id INTEGER,
    recognized_creator_name_raw TEXT,
    source_type TEXT NOT NULL DEFAULT 'screenshot',
    xingtu_price_raw TEXT,
    xingtu_price REAL,
    plays_json TEXT NOT NULL,
    recognized_count INTEGER NOT NULL DEFAULT 0,
    valid_count INTEGER NOT NULL DEFAULT 0,
    excluded_count INTEGER NOT NULL DEFAULT 0,
    unresolved_count INTEGER NOT NULL DEFAULT 0,
    analysis_count INTEGER NOT NULL DEFAULT 0,
    median_play REAL,
    p25_play REAL,
    p75_play REAL,
    recent_median_play REAL,
    prior_median_play REAL,
    trend_ratio REAL,
    -- 每一列都显式声明类型，不依赖「逗号前共享类型」写法：
    -- 否则 SQLite 会把未声明类型的列当成无类型（NUMERIC 亲和性）列，schema 容易悄悄退化
    trend_label TEXT NOT NULL,
    stats_status TEXT NOT NULL,
    stats_version TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    -- V3-alpha.2 Sprint A1：业务观察日期（这批播放量 / 星图价是哪天看到的）
    -- 语义与 created_at（何时保存进系统）永久分开；格式固定 YYYY-MM-DD；旧数据保持 NULL
    observed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_recent_snapshots_creator_created
    ON creator_recent_snapshots(creator, created_at);

  -- V3-alpha P4：决策记录（append-only，固化「当时看到了什么」）
  -- 说明：
  --   · 证据（historical / recent / pricing）、target_cpm、pricing_version 在创建时固化，
  --     未来数据变化不得回写或重算旧记录
  --   · 只记录人的决定；不保存截图 / base64 / API Key / provider 原始响应 / AI prompt
  --   · current_quote（实际商务报价）与 snapshot.xingtu_price（星图刊例价）永久分开
  CREATE TABLE IF NOT EXISTS creator_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator TEXT NOT NULL,
    -- Phase 4B：候选达人稳定身份（NULL = 旧历史达人决策）；不声明 FK，保持全库现有风格
    candidate_id INTEGER,
    decision_stage TEXT NOT NULL,
    snapshot_id INTEGER,
    current_quote_raw TEXT,
    current_quote REAL,
    ip_judgement TEXT,
    human_decision TEXT NOT NULL,
    decision_note TEXT,
    historical_evidence_json TEXT NOT NULL,
    recent_evidence_json TEXT,
    pricing_evidence_json TEXT,
    target_cpm REAL NOT NULL,
    pricing_version TEXT NOT NULL,
    system_context_version TEXT NOT NULL DEFAULT 'decision-context-v1',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_creator_decisions_creator_created
    ON creator_decisions(creator, created_at);

  -- V3-alpha P5：决策 ↔ 真实投放结果 的关联（只保存关联关系，不改写 creator_decisions）
  -- 说明：
  --   · creator_decisions 是「当时的决策快照」，因此绝不 UPDATE 旧 decision 去挂 outcome
  --   · 本表只保存 decision_id ↔ record_id 映射；花费 / 播放 / CPM / 发布日期等一律实时取自
  --     creator_records（Outcome result = live，Decision evidence = frozen）
  --   · P5-alpha：一条 decision 最多关联一个 record，一条 record 最多关联一个 decision
  --     （UNIQUE 约束是并发下的最终保护，不做 many-to-many）
  CREATE TABLE IF NOT EXISTS creator_decision_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id INTEGER NOT NULL,
    record_id INTEGER NOT NULL,
    linked_at TEXT DEFAULT CURRENT_TIMESTAMP,
    -- Phase 4E：冻结「当时为什么允许建立关联」的 linking 事件上下文（identity / timing 人工确认证据）
    -- 只记录关联事件本身；花费 / 播放 / CPM 等结果事实仍实时取自 creator_records
    link_evidence_json TEXT,
    UNIQUE(decision_id),
    UNIQUE(record_id)
  );

  CREATE INDEX IF NOT EXISTS idx_decision_outcomes_decision
    ON creator_decision_outcomes(decision_id);
  CREATE INDEX IF NOT EXISTS idx_decision_outcomes_record
    ON creator_decision_outcomes(record_id);

  -- V3-alpha.2 A4：谈判结果沉淀（append-only，冻结「当时」的谈判上下文）
  -- 说明：
  --   · negotiated_price（最终谈成价）与 xingtu_price（星图刊例价）、current_quote（达人报价）、
  --     actual_cost（真实投放花费，来自 creator_records / Outcome）永久分开，互不同步
  --   · 创建时把当时看到的星图价 / 当前报价 / CPM30 目标价 / 参考区间各冻结一份快照，
  --     之后 snapshot / record 更新都不会改写旧案例
  --   · 一个 decision 最多一个谈判案例（UNIQUE(decision_id)）；decision_id 允许为空以便未来扩展
  CREATE TABLE IF NOT EXISTS creator_negotiation_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator TEXT NOT NULL,
    decision_id INTEGER,
    snapshot_id INTEGER,
    xingtu_price_snapshot REAL,
    current_quote_snapshot REAL,
    negotiated_price REAL NOT NULL,
    negotiated_at TEXT NOT NULL,
    reason_tags_json TEXT NOT NULL DEFAULT '[]',
    reason_note TEXT,
    strategy_note TEXT,
    target_cpm REAL,
    target_price_snapshot REAL,
    reference_low_snapshot REAL,
    reference_high_snapshot REAL,
    -- Historical Negotiation Backfill V0.1：
    --   source_type = live（既有实时谈价工作流）| historical_backfill（历史真实案例回填）
    --   record_id = 历史回填的稳定身份（live 保持 NULL，仍走 decision_id → outcome/record）
    --   source_note = 人工维护的历史谈价原始备注（经验蒸馏的人工 source of truth）
    source_type TEXT NOT NULL DEFAULT 'live',
    record_id INTEGER,
    source_note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(decision_id)
  );

  CREATE INDEX IF NOT EXISTS idx_negotiation_cases_creator_created
    ON creator_negotiation_cases(creator, created_at);

  -- V3-alpha.3 Playbook Phase 1：候选达人身份层（最小实现，不引入完整 creator master）
  -- 说明：
  --   · 稳定身份是 id，不是 name —— 因此 name 故意不设 UNIQUE（允许重名 / 改名）
  --   · status 仅 active / archived；V0.1 不做 converted（转化由后续 decision → outcome → record 闭环处理）
  --   · 不调用 AI、不自动创建 creator_record、不参与 Repurchase Radar（Radar 只读 creator_records）
  CREATE TABLE IF NOT EXISTS creator_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    creator_type TEXT,
    profile_url TEXT,
    -- Phase 2.1：星图商单页链接，与 profile_url（达人内容主页）永久分开，不复用字段
    -- Phase 2.2 起前台不再新增 / 编辑；保留为 legacy compatibility field（不 DROP、不解析）
    xingtu_url TEXT,
    -- Phase 2.2：星图平台达人 ID / 业务查询标识（字符串存储，不做 URL 解析）
    xingtu_id TEXT,
    description TEXT,
    -- Phase 2.1：基于 description 生成的 AI 整理文本（人工备注仍是唯一事实来源）
    distilled_description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_creator_candidates_status
    ON creator_candidates(status);
`)

// V3-alpha.2 Sprint A1：为既有数据库安全补充 observed_at（数据观察日期）
// 说明：
//   · 只在列不存在时 ALTER TABLE，不覆盖任何已有快照
//   · 绝不把 created_at 伪装成 observed_at —— 保存日期不一定等于真实观察日期，
//     旧快照保持 NULL，由 UI 显示「观察日期未知」
const snapshotColumns = db
  .prepare('PRAGMA table_info(creator_recent_snapshots)')
  .all()
  .map((column) => column.name)
if (!snapshotColumns.includes('observed_at')) {
  db.exec('ALTER TABLE creator_recent_snapshots ADD COLUMN observed_at TEXT')
  console.log('[db] 已为 creator_recent_snapshots 添加 observed_at 列（历史快照保持 NULL）')
}

// V3-alpha.3 Playbook Phase 1：为既有数据库安全补充 candidate_id（候选达人稳定身份）
// 说明：
//   · 只在列不存在时 ALTER TABLE，不覆盖任何已有快照
//   · 旧快照（历史达人）保持 NULL，继续按 creator 名称归属；不自动回填任何 candidate
//   · 索引必须在补列之后创建（老库此刻才有该列）
if (!snapshotColumns.includes('candidate_id')) {
  db.exec('ALTER TABLE creator_recent_snapshots ADD COLUMN candidate_id INTEGER')
  console.log('[db] 已为 creator_recent_snapshots 添加 candidate_id 列（历史快照保持 NULL）')
}
db.exec(
  'CREATE INDEX IF NOT EXISTS idx_recent_snapshots_candidate ON creator_recent_snapshots(candidate_id, created_at)'
)

// Phase 2.1：为既有 creator_candidates 安全补充 xingtu_url / distilled_description
// 说明：
//   · 只在列不存在时 ALTER TABLE，不覆盖任何已有候选
//   · 旧候选保持 NULL，由 UI 显示为空 / 不显示入口
const candidateColumns = db
  .prepare('PRAGMA table_info(creator_candidates)')
  .all()
  .map((column) => column.name)
if (!candidateColumns.includes('xingtu_url')) {
  db.exec('ALTER TABLE creator_candidates ADD COLUMN xingtu_url TEXT')
  console.log('[db] 已为 creator_candidates 添加 xingtu_url 列（旧候选保持 NULL）')
}
if (!candidateColumns.includes('distilled_description')) {
  db.exec('ALTER TABLE creator_candidates ADD COLUMN distilled_description TEXT')
  console.log('[db] 已为 creator_candidates 添加 distilled_description 列（旧候选保持 NULL）')
}
// Phase 2.2：正式字段「星图 ID」；xingtu_url 保留为 legacy（不 DROP、不迁移、不解析）
if (!candidateColumns.includes('xingtu_id')) {
  db.exec('ALTER TABLE creator_candidates ADD COLUMN xingtu_id TEXT')
  console.log('[db] 已为 creator_candidates 添加 xingtu_id 列（旧候选保持 NULL）')
}

// Phase 4B：为既有 creator_decisions 安全补充 candidate_id（候选达人稳定身份）
// 说明：
//   · 只在列不存在时 ALTER TABLE，不修改任何旧决策行（旧行 candidate_id 保持 NULL）
//   · 索引必须在补列之后创建（老库此刻才有该列）
const decisionColumns = db
  .prepare('PRAGMA table_info(creator_decisions)')
  .all()
  .map((column) => column.name)
if (!decisionColumns.includes('candidate_id')) {
  db.exec('ALTER TABLE creator_decisions ADD COLUMN candidate_id INTEGER')
  console.log('[db] 已为 creator_decisions 添加 candidate_id 列（旧决策保持 NULL）')
}
db.exec(
  'CREATE INDEX IF NOT EXISTS idx_creator_decisions_candidate_created ON creator_decisions(candidate_id, created_at)'
)

// Phase 4E：为既有 creator_decision_outcomes 安全补充 link_evidence_json（旧关联保持 NULL）
// 说明：只在列不存在时 ALTER TABLE；不修改任何旧 outcome 行；无 FK，保持全库风格。
const outcomeColumns = db
  .prepare('PRAGMA table_info(creator_decision_outcomes)')
  .all()
  .map((column) => column.name)
if (!outcomeColumns.includes('link_evidence_json')) {
  db.exec('ALTER TABLE creator_decision_outcomes ADD COLUMN link_evidence_json TEXT')
  console.log('[db] 已为 creator_decision_outcomes 添加 link_evidence_json 列（旧关联保持 NULL）')
}

// Historical Negotiation Backfill V0.1：为既有 creator_negotiation_cases 安全补充三个列
// 说明：
//   · 只在列不存在时 ALTER TABLE，不修改 / 不迁移任何旧 case（旧行 source_type = 'live'）
//   · live case 不写 record_id（保持 NULL）；历史回填 case 必须写 record_id
//   · 索引必须在补列之后创建（老库此刻才有这些列）
const negotiationCaseColumns = db
  .prepare('PRAGMA table_info(creator_negotiation_cases)')
  .all()
  .map((column) => column.name)
if (!negotiationCaseColumns.includes('source_type')) {
  db.exec("ALTER TABLE creator_negotiation_cases ADD COLUMN source_type TEXT NOT NULL DEFAULT 'live'")
  console.log('[db] 已为 creator_negotiation_cases 添加 source_type 列（旧 case 保持 live）')
}
if (!negotiationCaseColumns.includes('record_id')) {
  db.exec('ALTER TABLE creator_negotiation_cases ADD COLUMN record_id INTEGER')
  console.log('[db] 已为 creator_negotiation_cases 添加 record_id 列（旧 case 保持 NULL）')
}
if (!negotiationCaseColumns.includes('source_note')) {
  db.exec('ALTER TABLE creator_negotiation_cases ADD COLUMN source_note TEXT')
  console.log('[db] 已为 creator_negotiation_cases 添加 source_note 列（旧 case 保持 NULL）')
}
// 同一投放记录最多一条 historical_backfill（partial unique index，只约束历史回填，不影响 live）
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_negotiation_cases_hist_record
   ON creator_negotiation_cases(record_id)
   WHERE source_type = 'historical_backfill' AND record_id IS NOT NULL`
)

// Real Data Calibration V1：决策业务时间 / 作废标记 / 校正审计（全部 additive，不改写任何旧行）
// 说明：
//   · decided_at = 真实做出该业务决策的日期（YYYY-MM-DD，可空）。
//     旧 24 条决策保持 NULL，绝不自动回填 created_at（那会把录入时间伪装成业务时间）。
//   · created_at 语义不变 = SYSTEM RECORD TIME（何时录入系统）。
//   · voided_at / void_reason = 作废标记（VOID，不 hard delete；下游 record / outcome / case 全部保留）。
//   · creator_calibration_corrections 只服务本轮允许的两个字段（决策日期 / 谈价日期）与决策作废，
//     不是通用「任意表任意字段」编辑框架。
const decisionCalibrationColumns = db
  .prepare('PRAGMA table_info(creator_decisions)')
  .all()
  .map((column) => column.name)
if (!decisionCalibrationColumns.includes('decided_at')) {
  db.exec('ALTER TABLE creator_decisions ADD COLUMN decided_at TEXT')
  console.log('[db] 已为 creator_decisions 添加 decided_at 列（旧决策保持 NULL，等待人工补录业务日期）')
}
if (!decisionCalibrationColumns.includes('voided_at')) {
  db.exec('ALTER TABLE creator_decisions ADD COLUMN voided_at TEXT')
  console.log('[db] 已为 creator_decisions 添加 voided_at 列（旧决策均未作废）')
}
if (!decisionCalibrationColumns.includes('void_reason')) {
  db.exec('ALTER TABLE creator_decisions ADD COLUMN void_reason TEXT')
  console.log('[db] 已为 creator_decisions 添加 void_reason 列')
}
db.exec(`
  CREATE TABLE IF NOT EXISTS creator_calibration_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 只允许本轮两类目标：决策 / 谈价案例（不是万能编辑框架）
    target_type TEXT NOT NULL CHECK (target_type IN ('decision', 'negotiation_case')),
    target_id INTEGER NOT NULL,
    -- correct_date = 业务日期纠正；void = 决策作废（不作废谈价案例，本轮不开放）
    action TEXT NOT NULL CHECK (action IN ('correct_date', 'void')),
    field TEXT,
    before_value TEXT,
    after_value TEXT,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_calibration_corrections_target
    ON creator_calibration_corrections(target_type, target_id, id);
`)
// 业务时间排序索引用的表达式与统一 ORDER BY 完全一致（legacy NULL decided_at 才 fallback created_at）
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_creator_decisions_business_time
   ON creator_decisions(COALESCE(decided_at, date(created_at)) DESC, id DESC)`
)

// 首次启动写入示例项目（前端工作台展示用）
const projectCount = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n
if (projectCount === 0) {
  const insert = db.prepare(
    'INSERT INTO projects (name, owner, status, progress) VALUES (?, ?, ?, ?)'
  )
  const seedAll = db.transaction(() => {
    for (const row of [
      ['React 18 学习路线', '张三', 'done', 100],
      ['Vite 工程化配置', '李四', 'doing', 60],
      ['SQLite 数据建模', '王五', 'todo', 0]
    ]) {
      insert.run(...row)
    }
  })
  seedAll()
  console.log('[db] 已写入示例项目数据')
}

console.log(`[db] 数据库初始化完成: ${dbPath}`)

// Record Edit History V1：creator_record_edits 表由显式 migration（migrations/003_record_edits.js）
// 在真实库上创建——绝不在普通启动流程里隐式修改真实库。
// 这里仅在「隔离测试 / 临时库」模式（显式设置 WORKBENCH_DB_PATH）下同步建表，供测试套件使用。
if (process.env.WORKBENCH_DB_PATH) {
  applyRecordEditsSchema(db)
}

export default db
