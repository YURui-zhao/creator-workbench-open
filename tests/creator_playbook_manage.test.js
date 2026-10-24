#!/usr/bin/env node
// Creator Playbook 资料维护 UX 回归测试（源码级 + 契约级）
//
// 运行方式：node tests/creator_playbook_manage.test.js
// 特性：纯静态检查 + 前端源码契约检查，不启动服务、不打开浏览器、不写数据库、不访问网络。
//
// 覆盖：星图商单页就地更新 / 编辑资料入口、复用现有 PATCH（不新增重复 API）、
//       取消不写库、只改资料不清空 AI 整理、各保存动作恰好一次成功反馈。
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

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

function main() {
  const pagePath = path.join(root, 'frontend/src/pages/CreatorPlaybook/index.jsx')
  const apiPath = path.join(root, 'frontend/src/api/creatorCandidates.js')
  const page = fs.readFileSync(pagePath, 'utf8')
  const api = fs.readFileSync(apiPath, 'utf8')

  console.log('===== 1. 星图 ID 就地更新 =====')
  check('详情区显示「星图 ID」', /label="星图 ID"/.test(page))
  check('不再提供「查看星图」跳转', !/查看星图/.test(page))
  check('前台不再出现 xingtu_url', !/xingtu_url/.test(page))
  check('已有 ID 时显示「复制 / 更新 ID」', /复制/.test(page) && /更新 ID/.test(page))
  check('无 ID 时显示「补充 ID」', /补充 ID/.test(page))
  check('星图 Modal 标题随状态区分', /更新星图 ID/.test(page) && /补充星图 ID/.test(page))
  const xingtuModal = page.slice(
    page.indexOf('{/* 星图 ID 就地更新'),
    page.indexOf('{/* 编辑资料（复用同一 PATCH')
  )
  check('星图 Modal 是轻量单字段表单', (xingtuModal.match(/<Form\.Item/g) || []).length === 1, String((xingtuModal.match(/<Form\.Item/g) || []).length))
  check('星图 Modal 只提交 xingtu_id（用冻结的 editingCandidate.id）', /updateCreatorCandidate\(editingCandidate\.id, \{ xingtu_id:/.test(page))
  check('星图 Modal 字段为 xingtu_id', /name="xingtu_id"/.test(xingtuModal))

  console.log('\n===== 2. 编辑资料 =====')
  check('顶部存在「编辑资料」次级入口', /编辑资料/.test(page) && /<Button type="link" size="small" onClick=\{openEdit\}>/.test(page))
  const editModal = page.slice(page.indexOf('{/* 编辑资料（复用同一 PATCH'))
  check('编辑资料可改 name / creator_type / profile_url / xingtu_id / description', ['name="name"', 'name="creator_type"', 'name="profile_url"', 'name="xingtu_id"', 'name="description"']
    .every((field) => editModal.includes(field)))
  check('编辑资料不再编辑 xingtu_url', !/name="xingtu_url"/.test(editModal) && !/xingtu_url/.test(editModal))
  check('编辑资料不出现 candidate_id / created_at / AI整理 字段', !/name="candidate_id"|name="created_at"|name="distilled_description"/.test(editModal))
  check('「录入近期表现」仍是主 CTA（type="primary"）', /<Button type="primary" onClick=\{\(\) => setAssistantOpen\(true\)\}>/.test(page))
  check('「编辑资料」是次级按钮（type="link"）', /<Button type="link" size="small" onClick=\{openEdit\}>/.test(page))

  console.log('\n===== 3. 复用现有 PATCH（不新增重复 API） =====')
  const apiExports = [...api.matchAll(/export function (\w+)/g)].map((m) => m[1]).sort()
  check(
    '候选 API 模块未新增重复接口',
    JSON.stringify(apiExports) === JSON.stringify([
      'createCandidateDecision', 'createCandidatePostQuoteDecision', 'createCandidateWorkState',
      'createCreatorCandidate', 'getCandidateLatestSnapshot', 'getCandidatePriceReference',
      'getCreatorCandidate', 'listCandidateDecisions', 'listCreatorCandidates',
      'saveCandidateRecentSnapshot', 'updateCreatorCandidate'
    ].sort()),
    JSON.stringify(apiExports)
  )
  check('页面复用 updateCreatorCandidate（PATCH）', /updateCreatorCandidate\(/.test(page))
  check('页面未直接使用 axios / 未新增路由', !/axios|request\.(patch|post)\(/.test(page))
  const updateCalls = (page.match(/updateCreatorCandidate\(/g) || []).length
  check('仅在三处保存动作里调用 PATCH', updateCalls === 3, String(updateCalls))

  console.log('\n===== 4. 取消不写库 =====')
  const onCancelBlocks = [...page.matchAll(/onCancel=\{\(\) => \{([\s\S]*?)\}\}/g)].map((m) => m[1])
  check('存在两个块状 onCancel（星图 / 编辑资料）', onCancelBlocks.length >= 2, String(onCancelBlocks.length))
  check('onCancel 不触发任何写库请求', onCancelBlocks.every((block) => !/updateCreatorCandidate|createCreatorCandidate|axios/.test(block)))

  console.log('\n===== 4b. 编辑资料回填（BUG 1 修复） =====')
  check('页面引入回填纯函数', /applyCandidateEditValues/.test(page) && /applyXingtuIdFormValues/.test(page))
  check(
    '编辑资料在 afterOpenChange(open=true) 回填（Modal 真正打开、Form 已挂载）',
    /afterOpenChange=\{\(open\) => \{[\s\S]{0,200}?if \(!open\) return[\s\S]{0,200}?applyCandidateEditValues\(editForm, editingCandidate\)/.test(page)
  )
  check(
    '星图 ID Modal 同样在 afterOpenChange 回填',
    /afterOpenChange=\{\(open\) => \{[\s\S]{0,200}?if \(!open\) return[\s\S]{0,200}?applyXingtuIdFormValues\(xingtuForm, editingCandidate\)/.test(page)
  )
  check('回填使用冻结的 editingCandidate，而非依赖 selected', /const \[editingCandidate, setEditingCandidate\] = useState\(null\)/.test(page) && /setEditingCandidate\(selected\)/.test(page))
  check('openEdit / openXingtuEdit 只设置 editingCandidate + open，不再 setFieldsValue', /const openEdit = \(\) => \{\s*setEditingCandidate\(selected\)\s*setEditOpen\(true\)\s*\}/.test(page) && /const openXingtuEdit = \(\) => \{\s*setEditingCandidate\(selected\)\s*setXingtuEditOpen\(true\)\s*\}/.test(page))
  check('不用 setTimeout / requestAnimationFrame workaround', !/setTimeout|requestAnimationFrame/.test(page))
  check('保存 / 取消后清空 editingCandidate', (page.match(/setEditingCandidate\(null\)/g) || []).length >= 4)
  check('编辑资料 Form.Item name 为 snake_case 5 项', ['name="name"', 'name="creator_type"', 'name="profile_url"', 'name="xingtu_id"', 'name="description"'].every((f) => page.includes(f)))

  console.log('\n===== 4c. 单次失败最多一个错误提示 + 防重复提交 =====')
  check('页面不再重复调用请求级 message.error（避免与拦截器叠两条）', !/message\.error\(getErrorMessage/.test(page))
  check('仅保留复制失败的本地错误提示', (page.match(/message\.error\(/g) || []).length === 1)
  for (const guard of ['if (savingEdit) return', 'if (savingXingtu) return', 'if (savingDistill) return', 'if (creating) return', 'if (distilling) return']) {
    check(`提交前有重入保护：${guard}`, page.includes(guard))
  }
  check('三个 Modal 均用 confirmLoading 阻止重复点击', (page.match(/confirmLoading=\{/g) || []).length >= 3)
  check('保存动作的 confirmLoading 绑定 saving 状态', /confirmLoading=\{savingEdit\}/.test(page) && /confirmLoading=\{savingXingtu\}/.test(page))

  console.log('\n===== 5. 提示 / 语义 =====')
  const successCount = (page.match(/message\.success\(/g) || []).length
  check('每个动作各一次成功提示（创建 / AI整理 / 星图ID / 复制 / 资料 / 决定 / 报价决定 / 关联投放）', successCount === 8, String(successCount))
  check('复制使用 clipboard API，失败时明确报错（不静默假成功）', /navigator\.clipboard\.writeText/.test(page) && /复制失败/.test(page))
  check('编辑资料保存成功后刷新候选（loadCandidates）', /await updateCreatorCandidate\(editingCandidate\.id, \{[\s\S]{0,300}?await loadCandidates\(\)/.test(page))
  check('编辑资料保存后清空未保存的 AI 预览', /setDistillPreview\(null\)[\s\S]{0,80}?await loadCandidates\(\)/.test(page))

  console.log('\n===== 6. 既有能力未被破坏 =====')
  check('仍复用 RecentPerformanceAssistantModal（候选模式）', /<RecentPerformanceAssistantModal/.test(page) && /candidateId=\{selected\?\.id \?\? null\}/.test(page))
  check('仍复用 Rule Engine（页面不重算规则）', /buildCreatorPlaybookAssessment\(snapshot\)/.test(page))
  check('AI 整理仍标注为派生（AI整理）', /AI整理/.test(page))

  console.log('\n===== 7. 历史价格参考（Phase 3B） =====')
  check('页面调用 getCandidatePriceReference（只读 API）', /getCandidatePriceReference\(candidateId\)/.test(page))
  check('新增「历史价格参考」区域且与 CPM15-20 并列', /历史价格参考/.test(page) && /CPM15-20 基础估价/.test(page))
  check('文案明确「不代表推荐价格」', /仅展示历史事实，不代表推荐价格/.test(page))
  check('前端不再二次排序（直接使用后端 cases 顺序）', /dataSource=\{cases\}/.test(page) && !/cases\.sort\(|\.sort\(\(a, b\) => a\.play_distance/.test(page))
  check('同类型仅作 Tag 提示', /item\.same_creator_type && <Tag>同类型<\/Tag>/.test(page))
  check('无相似度展示（不渲染相似度文案 / 分数）', !/similarity|相似度[：:]|相似度\s*\{/.test(page) && !/item\.similarity/.test(page))
  check('空态文案齐全（无商单 / 高量级 / 无案例）', /暂无商单样本，暂不生成历史价格参考/.test(page) && /V0.1 暂不生成历史价格参考/.test(page) && /暂无符合当前口径的历史价格案例/.test(page))

  console.log('\n===== 8. 文案单一来源（copy patch） =====')
  check('页面不出现旧文案「稳定高播放」', !/稳定高播放/.test(page))
  check('高播放标签只消费 Rule Engine（assessment.highPlaySignal.label）', /assessment\.highPlaySignal\.label/.test(page))
  check('估价说明只消费 Rule Engine（页面不自行拼装商单/日常文案）', /assessment\.estimate\.explanation/.test(page) && !/商单样本仅/.test(page))

  console.log('\n===== 9. 当前处理 / Work State（Phase 3：写入 candidate_work_state_events） =====')
  check(
    '页面用 work-state 写入 API（不再创建 candidate_review decision）',
    /createCandidateWorkState\(selected\.id,/.test(page) && !/createCandidateDecision\(selected\.id,/.test(page)
  )
  check('页面仍按需读取 decisions（当前合作 / 已关联合作记录用，不用于 Work State）',
    /listCandidateDecisions\(candidateId\)/.test(page))
  // Work State 三选一：服务端 state advancing / observing / paused → 推进中 / 观察中 / 暂缓池
  check(
    '三个工作状态按钮（推进中 / 观察中 / 暂缓池）',
    /推进中/.test(page) && /观察中/.test(page) && /暂缓池/.test(page) && /WORK_STATE_OPTIONS\.map/.test(page)
  )
  check(
    '三个状态按钮只消费服务端 Work State（不在页面本地派生 candidate_review）',
    /currentWorkState\.value === option\.value/.test(page) &&
      /workStateOf\(selected\)/.test(page) &&
      !/deriveWorkState|CANDIDATE_REVIEW_OPTIONS/.test(page)
  )
  check('无默认选中（pendingDecision 初始为 null，且按钮由点击显式发起）', /useState\(null\)[\s\S]{0,40}pendingDecision|const \[pendingDecision, setPendingDecision\] = useState\(null\)/.test(page) && /onClick=\{\(\) => openDecision\(option\)\}/.test(page))
  check('轻量确认 Modal：你选择 / 状态备注 / 记录决定', /你选择：/.test(page) && /决策备注（可选）/.test(page) && /okText="记录决定"/.test(page))
  check('状态备注展示服务端 work_state_note', /状态备注：/.test(page) && /work_state_note/.test(page) && /currentWorkState\.note/.test(page))
  check('多条历史可折叠查看（来自服务端 work_state_history）',
    /查看历史记录（/.test(page) && /historyExpanded/.test(page) && /workStateHistory\.slice\(1\)/.test(page))
  check('决定文案单一来源（消费 human_decision_label，不本地映射）', /human_decision_label/.test(page) && !/contact:\s*'继续联系'/.test(page))
  check('页面不做推荐 / 不自动选择 / 不出现评分字段', !/shouldInvest|recommendation_score|推荐决定|建议选择/.test(page))

  console.log('\n===== 10. 报价阶段（Phase 4D） =====')
  check('页面调用 candidate post-quote API', /createCandidatePostQuoteDecision\(selected\.id,/.test(page))
  check('继续联系后主 CTA「记录当前报价」', /reviewContactConfirmed \? \(/.test(page) && /记录当前报价/.test(page))
  check('无 contact 时保留次级入口「已有报价，直接记录」', /已有报价，直接记录/.test(page))
  check('四个报价决策（直接推进 / 小额测试 / 继续议价 / 暂缓）无默认选中', /直接推进/.test(page) && /小额测试/.test(page) && /继续议价/.test(page) && /暂缓/.test(page) && /useState\(null\)[\s\S]{0,60}postQuoteDecision|const \[postQuoteDecision, setPostQuoteDecision\] = useState\(null\)/.test(page))
  check('报价 Modal：当前报价 + 决策 + 备注', /当前报价/.test(page) && /决策（请主动选择）/.test(page) && /okText="记录报价决策"/.test(page))
  check('保存后展示最近报价阶段事实', /最近报价阶段/.test(page) && /报价位置：/.test(page) && /折/.test(page))
  check('报价位置文案为事实描述', /低于经验区间/.test(page) && /位于经验区间/.test(page) && /高于经验区间/.test(page))
  check('不自动弹窗（默认 false）', /const \[postQuoteOpen, setPostQuoteOpen\] = useState\(false\)/.test(page))

  console.log('\n===== 11. 实际投放结果（Phase 4E） =====')
  check('引入 outcome API（复用既有接口）', /getDecisionOutcomeCandidates\(/.test(page) && /linkDecisionOutcome\(/.test(page))
  check('只以「最新 post_quote」判定 eligible（不越过更晚的 pause；已作废决策被排除）', /const latestPostQuoteDecision = activeDecisions\.find\(\(item\) => item\.decision_stage === 'post_quote'\) \|\| null/.test(page) && /const activeDecisions = useMemo\(\(\) => decisions\.filter\(\(item\) => !item\.voided_at\), \[decisions\]\)/.test(page) && /latestPostQuoteEligible/.test(page) && /\['proceed', 'small_test'\]\.includes\(latestPostQuoteDecision\.human_decision\)/.test(page))
  check('状态 A 空态文案', /尚未进入可关联实际投放结果的阶段/.test(page))
  check('状态 B CTA「关联实际投放记录」', /关联实际投放记录/.test(page))
  check('状态 C 展示达人 / 发布日期 / 成本 / 7日 / 累计 / 最终 CPM / 关联时间', /达人：/.test(page) && /实际合作成本/.test(page) && /7日播放/.test(page) && /累计播放/.test(page) && /最终 CPM/.test(page) && /关联时间：/.test(page))
  check('override Tag：人工确认身份关联 / 人工确认发布时间关系', /人工确认身份关联/.test(page) && /人工确认发布时间关系/.test(page))
  check('无候选记录空态 + 刷新', /暂未找到可关联的真实投放记录/.test(page) && /请先在投放记录中录入或导入实际合作结果/.test(page) && /onClick=\{openOutcome\}>\s*刷新/.test(page))
  check('identity 确认 checkbox + 两种原因文案', /我确认这条投放记录属于当前候选达人/.test(page) && /存在多个同名候选达人，仅凭名称无法确认身份归属/.test(page) && /投放记录名称：/.test(page))
  check('timing 确认 checkbox + 业务日期展示（两个独立 checkbox）', /我确认该发布时间与当前决策的时间关系无误/.test(page) && /决策日期：/.test(page) && (page.match(/<Checkbox/g) || []).length >= 2)
  check('POST 只发送 record_id + 两个确认 flag', /linkDecisionOutcome\(latestPostQuoteDecision\.id, \{\s*recordId: selectedOutcomeCandidate\.record_id,\s*identityConfirmed: outcomeIdentityConfirmed,\s*timingConfirmed: outcomeTimingConfirmed\s*\}\)/.test(page))
  check('未提交 candidate / creator / evidence', !/linkDecisionOutcome\([\s\S]{0,200}candidate_id|linkDecisionOutcome\([\s\S]{0,200}link_evidence/.test(page))
  check('需要确认但未勾选 -> 阻止提交', /requires_identity_confirmation && !outcomeIdentityConfirmed/.test(page) && /requires_timing_confirmation && !outcomeTimingConfirmed/.test(page))
  check('成功后刷新 decisions', /已关联实际投放[\s\S]{0,120}await loadDecisions\(selected\.id\)/.test(page))
  check('关联 Modal 使用 confirmLoading 防重复提交', /confirmLoading=\{savingOutcome\}/.test(page))
}

main()

const total = passCount + failCount
const rate = total ? ((passCount / total) * 100).toFixed(1) : '0.0'
console.log('\n================ 测试汇总 ================')
console.log(`用例总数：${total}　通过：${passCount}　失败：${failCount}　通过率：${rate}%`)
if (failCount > 0) {
  console.log('\n失败用例：')
  failures.forEach((item) => console.log(`  - ${item}`))
}
process.exitCode = failCount > 0 ? 1 : 0
