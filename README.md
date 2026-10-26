# 达人投放工作台（creator-workbench）

一个本地运行的单机全栈应用：管理达人投放记录、沉淀达人近期内容表现与商务判断过程，并基于真实成交数据回答「这个达人该不该复投、该出多少钱」。

## 在线体验

**👉 [点击打开在线演示：creator-workbench-demo](https://creator-workbench-demo.cf-pages-upload.workers.dev)**

- Demo 使用**完全虚构的演示数据**（「样板达人」系列），可体验数据看板、投放管理、复投雷达、达人拓展、达人库、导入历史六个主要业务页面
- 编辑等操作仅作用于浏览器内存，刷新后恢复初始演示数据；AI 截图识别与文件导入在演示模式下不可用
- 部分中国大陆网络可能需要代理才能访问该演示地址

- GitHub（本公开仓库）：https://github.com/YURui-zhao/creator-workbench-open
- 当前版本：`v1.0.0`（tag `v1.0.0`）

## 一、项目介绍

当前版本（v1.0.0）围绕六个一级页面组织达人投放的完整工作流：

| 页面 | 能力 |
| --- | --- |
| 数据看板 | 投放效果周度聚合：累计播放、总花费、平均 CPM、达人数、7 日播放、后续新增、爆款分布 |
| 达人库 | 长期达人档案（Creator 身份 + 别名），零历史达人也保留；同名不同人不合并 |
| 复投雷达 | 只收录有真实历史投放的达人，按历史 CPM 证据分组排序，叠加最新近期表现与最近决策 |
| 达人拓展 | 新达人候选工作流：AI 截图识别 → 人工确认 → 估价 → 决策 → 谈价 |
| 投放记录 | 投放事实台账：新增 / 编辑 / 批量操作 / 导入导出 / 历史补录谈价 |
| 导入历史 | 导入批次审计：成功 / 失败明细、回滚、批次删除 |

支撑能力：AI 星图截图识别（播放量 + 商单/日常分类）、近期表现统计（中位 / P25/P75 / 趋势）、价格参考（CPM15-20 估价与历史成交案例）、决策记录与实际投放结果关联（Outcome）、业务日期纠正与作废的完整审计留痕、Creator 身份归属与别名搜索。

系统不生成「综合投放评分」，所有估价与分组只是可解释的证据，是否合作由人工决定并留痕。

## 二、技术架构与运行方式

### 目录结构

```
frontend/   React 18 + Vite 5 + Ant Design 5 + axios + echarts + xlsx
backend/    Node.js 18+ + Express 4 + better-sqlite3（SQLite 单文件库 workbench.db）
tests/      50 个独立 Node 回归测试脚本
start.py    一键启动脚本（自动探测 Node 运行时）
docs/       审计与知识文档
```

### 端口与代理

- 前端 Vite 开发服务器：`5173`；后端 Express：`3001`（仅绑定 `127.0.0.1`）
- 前端通过 Vite 代理把 `/api` 请求转发到 `http://localhost:3001`（无路径改写，后端收到带 `/api` 前缀的路径）

### 启动

```bash
npm run install:all   # 首次安装依赖（等价于根目录 + frontend + backend 三处 npm install）
npm run dev           # 同时启动前后端（Ctrl+C 停止）
npm run server        # 只启动后端（backend 目录下 node server.js）
npm run client        # 只启动前端
python3 start.py      # 一键启动（自动探测 Node，含便携运行时）
```

访问地址：前端 `http://localhost:5173/`，健康检查 `http://localhost:3001/api/health`。

### 数据库初始化与 Migration（首次安装必读）

首次启动后端会在 `backend/workbench.db` 自动创建基础 schema（空白库可直接使用投放记录 / 导入 / 看板）。
**Creator Identity 与编辑历史依赖显式 migration**；未执行 003 时，手动编辑与删除会 fail-closed 拒绝（防止无痕修改）。
新装环境推荐「临时副本迁移」流程（无需真实库授权参数）：

```bash
# 1) 启动一次后端生成空库，然后 Ctrl+C 停止（确认无 -wal / -shm 残留）
# 2) 把空库复制为临时副本
cp backend/workbench.db /tmp/workbench-init.db

# 3) 在临时副本上执行 migration（幂等，可重复运行）
node backend/migrations/001_creator_identity.js --commit --db /tmp/workbench-init.db   # Creator Identity（决策 / 达人拓展需要）
node backend/migrations/003_record_edits.js --commit --db /tmp/workbench-init.db       # 编辑历史审计表

# 4) 确认后端已停止、无 -wal / -shm 残留后，用迁移好的副本覆盖空库
cp /tmp/workbench-init.db backend/workbench.db
# 5) 重新启动后端
```

所有 migration 默认 dry-run（去掉 `--commit` 即可预检），不会回填或修改业务数据。
002（近期表现 V2 回填）仅用于已有历史数据的旧库升级，新装环境无需执行。
对已有数据的真实库执行 migration 的完整安全流程（备份 + 指纹授权），参见 `backend/migrations/` 各脚本头注释。

### 关于重启与进程生命周期（重要）

- **后端不是热重载**：修改 `backend/` 下任何代码（包括 AI Prompt）后，必须停止旧进程并重新 `node server.js` / `npm run server`，否则运行的仍是旧代码
- 判断「运行的代码是不是最新」的可靠方法：对比进程启动时间与源码文件修改时间（`ls -l backend/routes/ai.js`、`ps -o lstart= -p <PID>`）
- 通过 AI 工具会话 / 脚本后台拉起的 Node 进程，可能在会话结束时被连带回收（`nohup` 不保证存活）。长期使用请在自己的终端里启动
- 排查端口占用时先 `lsof -i :3001` 确认进程确属本项目的 `node server.js`，再决定是否结束该进程；不要未确认就 `kill -9`

### AI Key 配置

1. DeepSeek 开放平台 https://platform.deepseek.com 创建 `sk-` 开头的 Key
2. 两种方式任选：`backend/.env` 写 `DEEPSEEK_API_KEY=sk-...` 后重启后端；或在前端「右上角 AI 配置」填入（保存在浏览器 **sessionStorage**，关闭浏览器会话即失效，不写入 localStorage）
3. 验证：`curl http://localhost:3001/api/ai/status`

Key 不会进入数据库或 Git；后端日志输出前会做脱敏处理（见 `backend/services/deepseek.js`）。

## 三、播放量字段语义

| 数据库字段 | 业务含义 | 说明 |
| --- | --- | --- |
| `first_play` | **7 日播放量** | 内容发布约 7 天时的累计播放量 |
| `second_week_play` | **累计播放量** | 最近一次更新时的累计播放量，可继续更新 |

> `second_week_play` 只是历史技术字段名，**不是「第二周新增播放量」**。字段名保留仅为兼容历史数据与历史 Excel。

## 四、复投雷达判定规则（正式业务口径）

> 代码来源：`backend/routes/records.js`（`buildRepurchaseRadar` / `computeWorkPriority` / `computeRecordLatestCpm`）；阈值来源 `backend/utils/creatorBusinessRules.js`（`TARGET_CPM = 30`）。测试：`tests/repurchase_radar.test.js`（220 用例）。

### 4.1 单次合作达标

```
累计 CPM（raw）= total_cost ÷ second_week_play × 1000
raw CPM ≤ 30  → 达标（pass）
raw CPM > 30  → 未达标（fail）
```

达标判断使用**未四舍五入的 raw CPM**，对外展示的 `median_cpm` 才保留 2 位小数——避免「30.004 被先舍入成 30.00 后误判达标」的边界失真。

### 4.2 有效 CPM 样本

一条记录计入「有效 CPM 样本」，当且仅当：

1. 累计播放量已填写且 **> 0**（未填写 = 待更新；0 = 真实观测但 CPM 无定义，均不算有效样本）
2. 未出现「累计播放量 < 7日播放量」异常（异常记录的原始数值保留、界面标红，但不进入 CPM 相关指标）

不满足条件的记录**仍计入历史合作次数**（record_count）与总花费，只是不进入 CPM 分母。

### 4.3 历史表现状态（不用平均值决胜、无综合评分）

| 有效样本数 | 判定 |
| --- | --- |
| 0 或 1 | **证据不足**（insufficient）。唯一一次达标也**不算**历史通过 |
| ≥ 2 | pass_count > fail_count → **历史通过**；pass_count = fail_count → **表现分化**；pass_count < fail_count → **暂不优先** |

例：2 次有效样本 CPM 28、45 → 1胜1负 → 表现分化；3 次 28、25、45 → 2胜1负 → 历史通过；3 次 40、50、45 → 0胜3负 → 暂不优先。

### 4.4 分组

| 分组 | 包含的历史状态 |
| --- | --- |
| 优先关注 | 历史通过 |
| 需要观察 | 表现分化、证据不足（例外见 4.5） |
| 暂不优先 | 暂不优先状态；以及「单样本明显低效」的证据不足达人 |

### 4.5 工作优先级（只影响「先看谁」，不改变历史状态）

| 场景 | 规则（raw CPM） | 标记 |
| --- | --- | --- |
| 有效样本 = 1 | CPM ≤ 10 | 高关注「单次表现突出」 |
| 有效样本 = 1 | 10 < CPM ≤ 20 | 「优先补数据」 |
| 有效样本 = 1 | 20 < CPM < 100 | 普通（无标记） |
| 有效样本 = 1 | CPM ≥ 100 | 低优先「单次合作明显低效」（该达人从需要观察移入暂不优先，历史结论仍为证据不足） |
| 有效样本 = 0 | 无可用样本 | 普通 |
| 有效样本 ≥ 2 | 跟随历史状态：通过 → 高 / 分化 → 普通 / 暂不优先 → 低 | — |

边界含关系：`≤10` 含 10；`10<CPM≤20` 含 20；`20<CPM<100` 不含 100；`≥100` 含 100。全部基于 raw CPM 判定。

例：单次有效 CPM = 10 → 高关注「单次表现突出」；10.5 → 「优先补数据」；99 → 普通；100 → 移入暂不优先。

### 4.6 风险信号与最近合作

- **风险**：按发布日期排序的最近 2 次有效累计 CPM 均 > 30 → 标记风险（不改变历史状态）
- **最近合作**：全部记录的 `MAX(publish_date)`，同日多条取 id 更大的一条；「上次实际合作价」取同一条记录的 `total_cost`（0 是真实值；空表示暂无）

### 4.7 排序与身份

- 组内排序：历史 CPM 中位（raw）升序 → 距上次合作天数降序 → 名称升序；「需要观察」先按工作优先级（高→中→普通），再 mixed 优先于 insufficient
- 身份：identity 模式下按 `creator_id` 分组，同名不同人绝不合并；`creator_id` 为 NULL 的记录不进入任何分组，单独以 `unattributed_record_count` 展示
- 不生成任何综合投放评分；是否继续合作结合近期表现与人工判断

## 五、近期表现统计口径（Recent Performance V2）

> 代码来源：`backend/utils/recentPerformanceStats.js`（`STATS_VERSION = 'recent-performance-v2'`）。测试：`tests/recent_performance_semantics.test.js`。

- **数据结构**：一次快照 = 一批人工确认的作品播放量（`plays_json`），录入顺序 = **从旧到新**（最新作品在数组末尾）
- **有效作品**：`excluded=false` 且解析出的播放量为非负数字；**0 是真实观测**；无法解析的记为待核对（unresolved），不计入统计
- **内容分类**：sponsored（商单）/ organic（日常）/ unknown（未识别），只依据柱体或行内可见颜色；非法值一律归 unknown
- **典型表现**：有效样本 ≥ 5 时去掉 1 个最高、1 个最低后取中位数与 P25/P75；< 5 时整体中位为空（`stats_status = insufficient`）
- **趋势**：有效样本 ≥ 8 时，**最后 5 条 = 近期（最新）**，其余为 prior；ratio = median(recent)/median(prior) − 1；≥ +20% 上升、≤ −20% 下降、其余基本稳定（阈值比较用整数缩放，避免浮点边界误判）
- **版本管理**：派生字段带 `stats_version`；口径变化只影响新快照，历史 `plays_json` 等事实永不被静默改写（v1→v2 曾通过显式 backfill 一次性迁移派生字段）

## 六、AI 星图截图识别

> 代码来源：`backend/routes/ai.js`（Prompt 与解析）、`frontend/src/utils/screenshotImage.js`（压缩）、`frontend/src/utils/recentPerformanceDraft.js`（草稿）。

- **流程**：上传 1–3 张截图（png/jpg/webp，长边 ≤2000px，PNG 优先无损压缩）→ DeepSeek Vision 识别 → **用户逐条确认播放量、商单/日常、排除项** → 保存为 append-only 快照。AI 只负责「看见什么」，所有数值由后端重新解析确认，不信任前端派生值
- **版式与顺序**：横向时间轴柱状图（星图播放量图）从**左到右 = 旧→新**，最左柱为第 1 条；纵向作品列表从上到下；工作台统一按旧→新展示，最新在最后
- **颜色规则**：横向柱状图只看**柱体填充颜色**——粉红色柱体 = 商单、蓝色柱体 = 日常；纵向列表按行内颜色标识。红色火焰图标、红色均值虚线不是商单证据；柱体高度、数值大小、文字颜色不代表内容类型
- **允许单色**：全部作品同为蓝色（全日常）或同为粉红（全商单）都是合法输出，不要求两种颜色同时出现
- **失败与不确定**：看不清 → unknown；JSON 非法 → 502 不猜测修复；识别失败可切手工录入（结构相同，默认未识别由用户逐条选择）
- **约束**：AI 原始响应与图片**不落盘、不持久化日志**，排查识别问题需在浏览器 Network → Response 中查看；模型输出存在随机性，离线 fixture 测试通过不代表 100% 识别准确；整体反向但索引自洽的输出目前无法自动发现，需人工核对

## 七、达人拓展、价格与决策

### 估价（两套独立体系，不混用）

| 体系 | 公式 | 场景 |
| --- | --- | --- |
| CPM 15–20（Playbook） | 估价 = 基准播放 × 15..20 ÷ 1000 | **新达人**谈判锚点（无历史成交时） |
| CPM 30（历史体系） | 目标价 = 整体中位 × 30 ÷ 1000；参考区间 = P25..P75 × 30 ÷ 1000 | 复投雷达 / 历史达标判定 |

- **基准来源与置信度分离**：商单样本 ≥ 1 → 用商单中位（≥3 条 confidence=normal，1–2 条 low）；商单 = 0 且日常 > 0 → **日常中位代理估价**（low_proxy，明确标注非商单证据）；两者皆无 → 不估价
- **历史成交参考**：以基准播放为目标，从全部投放记录中取累计播放最接近的 ≤5 个真实案例（剔除待更新 / 异常 / 无花费 / ≥10万高量级），只展示事实（成交价、final CPM），≥3 个案例才给区间
- **四种价格永久分开**：星图刊例价（截图）、实际报价（达人给出）、最终谈成价（谈判结果）、实际合作成本（投放记录）——互不覆盖

### 决策、谈价与结果

- **决策**（`creator_decisions`，append-only）：阶段（联系前 / 报价后）+ 人工决定 + 当时证据冻结（历史 / 近期 / 价格三份 JSON，不随未来数据变化）
- **谈价**（`creator_negotiation_cases`，append-only）：谈成价 + 谈成日期 + 原因；与决策 1:1；历史谈价可按投放记录补录（`historical_backfill`）
- **结果关联**（`creator_decision_outcomes`，1:1）：决策 ↔ 真实投放记录；花费 / 播放 / CPM 实时取自投放记录，决策证据保持冻结
- **业务日期**：决策有 `decided_at`（真实决策日期）、谈价有 `negotiated_at`；与录入时间 `created_at` 永久分开；列表按业务日期排序
- **纠错**：日期纠正与作废（VOID）走 `creator_calibration_corrections` 审计表（before/after/reason）；作废不删除决策与任何下游事实；不属于本机制的修改一律不允许

## 八、数据安全与审计

- SQLite 单文件库 `backend/workbench.db` + WAL；健康检查含数据库连通性；停止服务请正常 Ctrl+C（有优雅关闭处理）
- `workbench.db` / WAL / SHM / `.env` / 日志均已被 `.gitignore` 排除，不会进入 Git
- Creator 身份（`creators` + 别名）：事件表（决策 / 谈价 / 快照 / 记录）通过 `creator_id` 归属；同名不同人允许并存；歧义归属不自动合并（0 match → 临时身份、1 match → 自动、N match → 不猜）
- 历史快照 append-only；决策 / 谈价证据创建即冻结；日期纠正与作废全部留审计；作废不删除任何下游事实
- 后端仅绑定 `127.0.0.1`，前端仅允许本地跨域；AI Key 走 sessionStorage 或 `.env`，日志脱敏

---

## 九、Excel 导入导出

点击「导入Excel」上传 `.xlsx` / `.xls`（单次 ≤1000 条），列顺序不限，兼容英文列名。

### 正式表头（推荐）

| Excel 列名 | 字段 | 必填 | 说明 |
| --- | --- | --- | --- |
| 时间周期 | time_cycle | 是 | 如 `2026-W33`，也支持 `08/10-08/16` 区间写法 |
| 达人昵称 | nickname | 是 | 文本 |
| 达人类型 | creator_type | 否 | 文本 |
| 达人主页 | homepage | 否 | 链接 |
| 植入链接 | content_link | 否 | 链接 |
| 视频链接 | video_link | 否 | 链接 |
| 总花费(元) | total_cost | 是 | 数字，**0 合法** |
| 7日播放量 | first_play | 否 | 非负整数 |
| 累计播放量 | second_week_play | 否 | 非负整数（可留空 = 待更新） |
| 发布日期 | publish_date | 是 | `YYYY-MM-DD` |

### 历史表头兼容

| 旧列名 | 映射 |
| --- | --- |
| 博主类型、达人类型 | creator_type |
| 首发播放量、7日累计播放量 | first_play |
| 次周播放量、最新累计播放量 | second_week_play |
| 视频发布链接、植入内容链接 | video_link、content_link |

### 导入规则

- 累计播放量可留空（待更新）；**累计 < 7日播放量的行被拒绝**（提示具体行号与原因）
- 总花费必填，0 合法；金额自动去货币符号与千分位；播放量支持 `8.2万` 写法；日期兼容 `2024/7/22`、`2024.7.22` 与 Excel 序列号
- 自动去重：多字段组合指纹，与库中已有或文件内重复的行标记跳过
- 上传先预览校验（显示行号与原因），确认后仅导入通过校验的行

### 导出（前端本地生成，不上传服务器）

- 投放明细：`达人投放记录_YYYY-MM-DD.xlsx`（CPM / 后续新增为计算列，重新导入会被忽略）
- 达人汇总：`达人汇总明细_YYYY-MM-DD.xlsx`；对比：`达人对比_YYYY-MM-DD.xlsx`
- 导入失败明细：`导入失败明细_YYYY-MM-DD.xlsx`

## 十、时间周期规则

- 存储统一 `YYYY-Wxx`（如 `2026-W33`）；周从周一到周日；第 1 周从当年第一个周一开始
- 默认业务年份 2026，可 `BUSINESS_YEAR=2027 npm run server` 覆盖
- 计算统一在后端 `backend/utils/dateCycle.js`；`/api/records/cycles` 返回 weekCode / 起止日期 / 区间文案
- Excel 支持月日区间自动识别为周码；导出时间周期为月日区间格式

## 十一、测试

```bash
node tests/<name>.test.js        # 逐个运行（共 50 个套件，见 tests/ 目录）
```

- 隔离方式：`WORKBENCH_DB_PATH` 指向临时数据库，并拦截全部网络请求（不调用真实 AI、不触碰真实 workbench.db）
- 任意用例失败 → 进程非零退出（不静默截断）
- `tests/screenshot_extract.test.js` 需要绑定本地端口，请在非沙箱 / 本机终端运行
- 关键套件：`repurchase_radar`（220 用例）、`creator_library`、`creator_identity*`、`creator_calibration`、`screenshot_golden_sample`、`recent_performance_semantics`、`historical_negotiation_backfill` 等

前端构建：`cd frontend && npm run build`

## 十二、后端接口一览

统一响应：`{ code: 200, data, msg: 'success' }`；按前缀分组的主要能力：

| 前缀 | 能力 |
| --- | --- |
| `/api/records` | 投放记录 CRUD、批量导入 / 更新 / 删除、周统计、达人汇总、复投雷达、筛选元数据、导出 |
| `/api/cycles` | 时间周期选项 |
| `/api/import/batches` | 导入批次列表 / 详情 / 回滚 / 删除 |
| `/api/recent-snapshots` | 近期表现快照保存与最新查询 |
| `/api/creator-candidates` | 候选达人 CRUD、近期快照、价格参考、Work State、决策列表与报价阶段决策 |
| `/api/creator-decisions` | 决策创建 / 历史 / 报价预览、结果关联（outcome）、业务日期纠正、作废、审计查询 |
| `/api/creator-negotiation-cases` | 谈价案例（live / 历史补录）、谈价日期纠正、审计查询 |
| `/api/creators` | Creator 列表与详情（身份层，只读） |
| `/api/ai` | 服务状态、导入校验、表头映射、截图识别、画像整理、谈价经验整理 |
| `/api/health` | 健康检查 |

> `/api/projects`、`/api/stats` 为脚手架遗留接口，当前前端页面未使用。

## 十三、常见问题排查

### 端口被占用

```bash
lsof -i :3001   # 先确认占用进程确属本项目的 node server.js
kill <PID>      # 确认后再结束；不要对未确认的进程使用 kill -9
```

也可换端口启动后端：`PORT=3002 npm run server`（需同步修改 `frontend/vite.config.js` 代理目标）。

### 依赖安装失败

- `npm config get registry` 查看源；可切换 `https://registry.npmmirror.com`
- better-sqlite3 为预编译二进制；失败多为 Node 版本过旧或网络受限，升级 Node 18+ 重试

### 页面提示「后端未连接 / Request failed with status code 500」

- 先访问 `http://localhost:3001/api/health`：能返回 ok 说明后端正常（问题在前端代理或网络）；不能返回说明后端未启动或已退出
- 前端右上角有连通性状态标签；两个服务需同时运行（`npm run dev`）

### 修改后端代码后页面行为没变

后端**不是热重载**：修改 `backend/` 代码后必须重启 `node server.js`。可用「进程启动时间 vs 源码修改时间」确认运行版本。

### 浏览器页面空白

确认访问的是 `http://localhost:5173`（Vite 开发服务器），不要直接打开 `index.html`；强制刷新（Cmd+Shift+R）。

## 十四、当前已知限制

1. **「按发生周」口径未开放**：缺少逐周播放快照，看板固定使用「按投放周」口径
2. **`video_link` 无服务端唯一约束**：去重仅在 Excel 导入时按多字段指纹完成
3. **`second_week_play` 为历史字段名**：语义已是「累计播放量」，仅为兼容保留
4. **后端聚合拉取筛选窗口内全量数据**：当前数据量可接受，数据量显著增加后需优化
5. **AI 原始响应与截图不持久化**：识别问题排查依赖浏览器 Network 面板；响应文本不落盘
6. **AI 识别存在模型随机性**：离线 fixture 通过不代表 100% 准确；「整体反向但索引自洽」的输出目前无法自动检测，需人工核对
7. **手工编辑留痕需要执行 003 migration 后生效**：代码已实现 `creator_record_edits` 审计表（PUT / 批量修改 / 删除快照 / 只读历史接口），但真实库尚未执行 `node backend/migrations/003_record_edits.js --commit --db backend/workbench.db`；未建表时编辑会 fail-closed 拒绝（防止静默无痕修改），导入批次更新仍由 `import_batch_record_updates` 独立记账
8. **通过 AI 工具会话后台拉起的后端进程可能随会话结束被回收**：长期使用请在自己的终端启动

## 十五、Git 提交与同步约定

- 真实数据库 / WAL / `.env` / 日志均被 `.gitignore` 排除，禁止提交
- 提交前运行相关测试 + `cd frontend && npm run build` + `git diff --check`
- 提交信息用小写祈使句（如 `fix: ...` / `feat: ...` / `docs: ...`）；推送使用 `git push origin v3-alpha3`，禁止 force push
