import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  List,
  Modal,
  DatePicker,
  Row,
  Segmented,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd'
import { PlusOutlined, ReloadOutlined, SearchOutlined, UserAddOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  createCandidatePostQuoteDecision,
  createCandidateWorkState,
  createCreatorCandidate,
  getCandidateLatestSnapshot,
  getCandidatePriceReference,
  getCreatorCandidate,
  listCandidateDecisions,
  listCreatorCandidates,
  updateCreatorCandidate
} from '../../api/creatorCandidates'
import { distillCreatorNote, getAiStatus } from '../../api/ai'
import { getAiConfig } from '../../utils/aiConfig.js'
import { getErrorMessage } from '../../utils/request'
import {
  getDecisionOutcomeCandidates,
  linkDecisionOutcome
} from '../../api/creatorDecisions'
import { formatInteger, formatPlays } from '../../utils/format'
import { isValidDateOnly, todayLocalDateOnly, TREND_LABELS_FULL } from '../../utils/recentPerformanceSave.js'
import {
  buildCreatorPlaybookAssessment,
  ESTIMATE_CONFIDENCE_LABELS
} from '../../utils/creatorPlaybookRules.js'
import {
  applyCandidateEditValues,
  applyXingtuIdFormValues
} from '../../utils/creatorCandidateForm.js'
// 达人拓展：Work State 直接消费服务端 candidate.work_state（Phase 3 起不再由 decisions 派生）
import {
  WORK_STATE_FILTER_ALL,
  WORK_STATE_FILTER_OPTIONS,
  WORK_STATE_LABELS,
  WORK_STATE_OPTIONS,
  WORK_STATE_TAG_COLORS,
  buildLinkedCollaborationRecords,
  filterCandidates,
  summarizeWorkStates,
  workStateOf
} from '../../utils/creatorWorkState.js'
import RecentPerformanceAssistantModal from '../../components/RecentPerformanceAssistantModal'
// Negotiation Unification V0.2：candidate 谈价经验统一走共享表单 + live case 领域模型
import CandidateNegotiationExperienceModal from '../../components/CandidateNegotiationExperienceModal'
import { getNegotiationCasesByRecord } from '../../api/creatorNegotiationCases'
import { NEGOTIATION_REASON_TAG_LABELS } from '../../utils/negotiationCaseDisplay.js'

const PLACEHOLDER = '-'

const formatPrice = (value) =>
  value === null || value === undefined ? null : `¥${Number(value).toLocaleString('zh-CN')}`

const renderMedian = (value) =>
  value === null || value === undefined ? PLACEHOLDER : formatPlays(value)

const STABILITY_TAG_COLORS = { stable: 'green', volatile: 'orange', unknown: 'default' }

// 只做展示格式化：估价区间由 rule engine 给出，页面不重算
const renderEstimateRange = (estimate) =>
  estimate.low === null || estimate.high === null
    ? '暂无（无可用样本）'
    : `${formatPrice(estimate.low)} ～ ${formatPrice(estimate.high)}`

// Phase 3B：历史价格参考空态文案（与后端 reason_code 一一对应）
const PRICE_REF_MESSAGES = {
  no_snapshot: '先录入近期表现后，才能生成历史价格参考。',
  no_estimable_sample: '暂无商单样本，也没有可用的日常样本，暂不生成历史价格参考。',
  no_sponsored_sample: '暂无商单样本，暂不生成历史价格参考。日常播放仅作为辅助，不直接换算商单价格。',
  high_scale_not_supported: '当前属于高量级达人。现有高量级历史样本较少，V0.1 暂不生成历史价格参考。'
}

// 当前处理（Work State）三选一由 utils/creatorWorkState.js 统一提供：
//   contact → 推进中 / observe → 观察中 / hold → 暂缓池
// 只有用户显式点击三个状态按钮时，才会新增一条 candidate_review decision（append-only）。

// 达人资料画像的观察提示：只是 guidance，不是必填表单，也不新增任何 DB 字段
const PROFILE_GUIDANCE =
  '观察提示（仅作参考，不必逐条填写）：主要内容类型？· 人设 / 表达风格？· 视频偏长还是偏短？· 商单与日常差异？· 粉丝互动情况？· 明显记忆点？· 优势 / 风险？'

// Phase 4D：candidate 报价阶段（candidate 第一次投放，用「直接推进」而非「复投」）
const CANDIDATE_POST_QUOTE_OPTIONS = [
  { value: 'proceed', label: '直接推进' },
  { value: 'small_test', label: '小额测试' },
  { value: 'negotiate', label: '继续议价' },
  { value: 'pause', label: '暂缓' }
]

// 报价相对 Playbook 经验区间的位置（纯事实描述）
const QUOTE_POSITION_LABELS = {
  below_playbook_range: '低于经验区间',
  within_playbook_range: '位于经验区间',
  above_playbook_range: '高于经验区间',
  unavailable: '经验区间不可用'
}

// 历史价格参考渲染（严格使用后端返回顺序，前端不再排序；不显示相似度）
function renderPriceReference(priceRef, loading) {
  if (loading) return <Typography.Text type="secondary">加载历史价格参考…</Typography.Text>
  if (!priceRef) return <Typography.Text type="secondary">-</Typography.Text>
  if (!priceRef.available) {
    return (
      <Typography.Text type="secondary">
        {PRICE_REF_MESSAGES[priceRef.reason_code] || priceRef.message || '暂不生成历史价格参考。'}
      </Typography.Text>
    )
  }
  const cases = Array.isArray(priceRef.cases) ? priceRef.cases : []
  if (cases.length === 0) {
    return <Typography.Text type="secondary">暂无符合当前口径的历史价格案例。</Typography.Text>
  }
  const summary = priceRef.summary
  return (
    <Space direction="vertical" size={8} style={{ display: 'flex' }}>
      <Row gutter={[12, 12]}>
        <Col xs={12} sm={8} lg={6}>
          <Statistic
            title={priceRef.target?.baseline_source === 'organic_proxy' ? '日常中位目标（代理）' : '商单中位目标'}
            value={formatPlays(priceRef.target?.baseline_play ?? priceRef.target?.sponsored_median_play)}
          />
        </Col>
        {summary && (
          <>
            <Col xs={12} sm={8} lg={6}>
              <Statistic title="历史案例成交中位" value={formatPrice(summary.cost_median) ?? '-'} />
            </Col>
            <Col xs={12} sm={8} lg={6}>
              <Statistic
                title="案例成交范围"
                value={`${formatPrice(summary.cost_min) ?? '-'} – ${formatPrice(summary.cost_max) ?? '-'}`}
              />
            </Col>
            <Col xs={12} sm={8} lg={6}>
              <Statistic title="案例最终 CPM 中位" value={summary.final_cpm_median ?? '-'} />
            </Col>
          </>
        )}
      </Row>
      {!summary && (
        <Typography.Text type="secondary">
          历史可参考案例较少，仅展示个案，不形成价格区间。
        </Typography.Text>
      )}
      <List
        size="small"
        dataSource={cases}
        renderItem={(item) => (
          <List.Item style={{ paddingLeft: 0, paddingRight: 0 }}>
            <Space direction="vertical" size={2} style={{ display: 'flex' }}>
              <Space size={6} wrap>
                <Typography.Text strong>{item.creator}</Typography.Text>
                <Typography.Text type="secondary">{item.creator_type || '未分类'}</Typography.Text>
                {item.same_creator_type && <Tag>同类型</Tag>}
              </Space>
              <Typography.Text type="secondary">
                累计播放 {formatPlays(item.cumulative_play)} · 实际合作 {formatPrice(item.actual_cost) ?? '-'} · 最终 CPM{' '}
                {item.final_cpm ?? '-'}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                与当前商单中位相差 {formatPlays(item.play_distance)}
              </Typography.Text>
            </Space>
          </List.Item>
        )}
      />
    </Space>
  )
}

/**
 * 达人拓展（V3-alpha.3 Playbook Phase 1；原「新达人判断」）
 *
 * 本阶段只做两件事：
 *   1) 建立候选达人稳定身份（creator_candidates）
 *   2) 复用 RecentPerformanceAssistantModal 保存 / 读取候选达人的近期表现 snapshot
 *
 * 明确不做：Playbook 规则计算、价格案例、谈价案例、Decision、相似达人、推荐结论。
 */
export default function CreatorPlaybook() {
  const [candidates, setCandidates] = useState([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  // A. 列表顶部：名称 substring 搜索 + 三个工作盒子筛选（单选，互斥）
  const [searchKeyword, setSearchKeyword] = useState('')
  const [workStateFilter, setWorkStateFilter] = useState(WORK_STATE_FILTER_ALL)
  // Phase 3：Work State 直接来自服务端 candidate.work_state（列表接口一次返回，无 N+1）；
  // 这里只保存「当前处理」的 append-only 历史（work_state_history，来自 candidate detail）。
  const [workStateHistory, setWorkStateHistory] = useState([])
  // 当前合作 / 已关联合作记录：两个独立的折叠区块（当前合作默认展开，合作记录默认折叠）
  const [cooperationKeys, setCooperationKeys] = useState(['cooperation'])
  const [linkedRecordKeys, setLinkedRecordKeys] = useState([])
  const [snapshot, setSnapshot] = useState(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  // Phase 3B：历史价格参考（只读，后端按 candidate_id 派生 target）
  const [priceRef, setPriceRef] = useState(null)
  const [priceRefLoading, setPriceRefLoading] = useState(false)
  // Phase 4B：人工决定（append-only）
  const [decisions, setDecisions] = useState([])
  const [decisionsLoading, setDecisionsLoading] = useState(false)
  const [pendingDecision, setPendingDecision] = useState(null)
  const [decisionNote, setDecisionNote] = useState('')
  const [savingDecision, setSavingDecision] = useState(false)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  // Phase 4D：报价阶段决策（不自动弹出；无默认选中）
  const [postQuoteOpen, setPostQuoteOpen] = useState(false)
  const [postQuoteAmount, setPostQuoteAmount] = useState('')
  const [postQuoteDecision, setPostQuoteDecision] = useState(null)
  const [postQuoteNote, setPostQuoteNote] = useState('')
  // Real Data Calibration V1：业务决策日期（默认今天；历史补录可显式选择真实日期）
  const [postQuoteDecidedAt, setPostQuoteDecidedAt] = useState(() => todayLocalDateOnly())
  const [savingPostQuote, setSavingPostQuote] = useState(false)
  // Phase 4E：实际投放结果关联
  const [outcomeOpen, setOutcomeOpen] = useState(false)
  const [outcomeCandidates, setOutcomeCandidates] = useState([])
  const [outcomeLoading, setOutcomeLoading] = useState(false)
  const [outcomeError, setOutcomeError] = useState('')
  const [selectedOutcomeRecordId, setSelectedOutcomeRecordId] = useState(null)
  const [outcomeIdentityConfirmed, setOutcomeIdentityConfirmed] = useState(false)
  const [outcomeTimingConfirmed, setOutcomeTimingConfirmed] = useState(false)
  const [savingOutcome, setSavingOutcome] = useState(false)
  // Phase 4F-B：谈价结果（复用现有 NegotiationCaseModal）
  const [negotiationOpen, setNegotiationOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  // AI 是否可用（仅控制「AI整理达人资料」按钮；不影响 candidate / snapshot 等其它能力）
  const [aiReady, setAiReady] = useState(false)
  // AI 整理达人资料：预览态（不自动写库）
  const [distilling, setDistilling] = useState(false)
  const [distillPreview, setDistillPreview] = useState(null)
  const [savingDistill, setSavingDistill] = useState(false)
  // 资料维护：星图 ID 就地更新 / 编辑资料（都复用同一 PATCH，不新增 API）
  const [xingtuEditOpen, setXingtuEditOpen] = useState(false)
  const [savingXingtu, setSavingXingtu] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)
  // 冻结「正在编辑的 candidate」：回填只认这个对象，不受列表刷新 / selected 变化影响
  const [editingCandidate, setEditingCandidate] = useState(null)
  const [form] = Form.useForm()
  const [xingtuForm] = Form.useForm()
  const [editForm] = Form.useForm()

  const loadCandidates = useCallback(async () => {
    setListLoading(true)
    setListError('')
    try {
      const res = await listCreatorCandidates()
      const list = res?.data?.candidates || []
      setCandidates(list)
      setSelectedId((current) => {
        if (current && list.some((item) => item.id === current)) return current
        return list.length ? list[0].id : null
      })
    } catch (error) {
      setCandidates([])
      setListError(getErrorMessage(error))
    } finally {
      setListLoading(false)
    }
  }, [])

  useEffect(() => {
    loadCandidates()
  }, [loadCandidates])

  // 选中候选后按 candidate_id 读取其最新快照（绝不按名称匹配）
  const loadSnapshot = useCallback(async (candidateId) => {
    if (!candidateId) {
      setSnapshot(null)
      return
    }
    setSnapshotLoading(true)
    try {
      const res = await getCandidateLatestSnapshot(candidateId)
      setSnapshot(res?.data?.snapshot || null)
    } catch {
      setSnapshot(null)
    } finally {
      setSnapshotLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSnapshot(selectedId)
  }, [selectedId, loadSnapshot])

  // 历史价格参考：随选中候选变化重新拉取（只读；后端自行派生 target，前端不提交）
  const loadPriceReference = useCallback(async (candidateId) => {
    if (!candidateId) {
      setPriceRef(null)
      return
    }
    setPriceRefLoading(true)
    try {
      const res = await getCandidatePriceReference(candidateId)
      setPriceRef(res?.data || null)
    } catch {
      setPriceRef(null)
    } finally {
      setPriceRefLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPriceReference(selectedId)
  }, [selectedId, loadPriceReference])

  // 人工决定：随选中候选变化重新拉取 append-only 历史（按 candidate_id）
  const loadDecisions = useCallback(async (candidateId) => {
    if (!candidateId) {
      setDecisions([])
      return []
    }
    setDecisionsLoading(true)
    try {
      const res = await listCandidateDecisions(candidateId)
      const list = res?.data?.decisions || []
      setDecisions(list)
      return list
    } catch {
      setDecisions([])
      return []
    } finally {
      setDecisionsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDecisions(selectedId)
  }, [selectedId, loadDecisions])

  // Phase 3：列表的工作盒子筛选 / 计数 / Tag 直接用候选行上的 work_state（服务端派生）。
  // 这里只按 candidate_id 读取「当前处理」历史（work_state_history），不再为 Work State 拉 decisions。
  const loadWorkStateHistory = useCallback(async (candidateId) => {
    if (!candidateId) {
      setWorkStateHistory([])
      return
    }
    try {
      const res = await getCreatorCandidate(candidateId)
      setWorkStateHistory(res?.data?.work_state_history || [])
    } catch {
      // 历史读取失败不影响当前状态展示（当前状态来自列表接口的 work_state）
      setWorkStateHistory([])
    }
  }, [])

  useEffect(() => {
    loadWorkStateHistory(selectedId)
  }, [selectedId, loadWorkStateHistory])

  // 切换候选时收起历史 / 清空待提交的决定
  useEffect(() => {
    setHistoryExpanded(false)
    setPendingDecision(null)
    setDecisionNote('')
    setPostQuoteOpen(false)
    setPostQuoteAmount('')
    setPostQuoteDecision(null)
    setPostQuoteNote('')
    setOutcomeOpen(false)
    setOutcomeCandidates([])
    setSelectedOutcomeRecordId(null)
    setOutcomeIdentityConfirmed(false)
    setOutcomeTimingConfirmed(false)
    // 区块折叠状态回归默认：当前合作展开、已关联合作记录折叠
    setCooperationKeys(['cooperation'])
    setLinkedRecordKeys([])
  }, [selectedId])

  // AI 可用性：会话 Key（本地）或后端环境变量任一可用即可；查询失败不影响页面其它能力
  useEffect(() => {
    let active = true
    if (Boolean(getAiConfig()?.apiKey)) {
      setAiReady(true)
      return undefined
    }
    getAiStatus()
      .then((res) => {
        if (active) setAiReady(Boolean(res?.data?.available))
      })
      .catch(() => {
        if (active) setAiReady(false)
      })
    return () => {
      active = false
    }
  }, [selectedId])

  // 切换候选时清空未保存的 AI 整理预览
  useEffect(() => {
    setDistillPreview(null)
  }, [selectedId])

  const selected = candidates.find((item) => item.id === selectedId) || null
  // A. 列表视图：名称 substring 搜索 + 三个工作盒子筛选（纯函数，保持后端返回顺序）
  const visibleCandidates = useMemo(
    () =>
      filterCandidates({
        candidates,
        keyword: searchKeyword,
        workState: workStateFilter
      }),
    [candidates, searchKeyword, workStateFilter]
  )
  const workStateCounts = useMemo(() => summarizeWorkStates(candidates), [candidates])

  const handleCreate = async () => {
    if (creating) return
    let values
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setCreating(true)
    try {
      const res = await createCreatorCandidate({
        name: values.name,
        creator_type: values.creator_type || null,
        profile_url: values.profile_url || null,
        xingtu_id: values.xingtu_id || null,
        description: values.description || null
      })
      const created = res?.data
      message.success('候选达人已创建')
      setCreateOpen(false)
      form.resetFields()
      await loadCandidates()
      if (created?.id) setSelectedId(created.id)
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setCreating(false)
    }
  }

  // 只整理已有的人工观察（只在用户显式点击时调用；AI 失败不影响 candidate 数据）
  const handleDistill = async () => {
    if (!selected) return
    const note = String(selected.description ?? '').trim()
    if (!note) return
    if (distilling) return
    setDistilling(true)
    setDistillPreview(null)
    try {
      const res = await distillCreatorNote(note)
      setDistillPreview(res?.data || null)
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setDistilling(false)
    }
  }

  // 用户明确点击「保存整理结果」后才写库（distilled_description 是派生字段）
  const handleSaveDistill = async () => {
    if (!selected || !distillPreview?.text) return
    if (savingDistill) return
    setSavingDistill(true)
    try {
      await updateCreatorCandidate(selected.id, { distilled_description: distillPreview.text })
      message.success('已保存 AI 整理结果')
      setDistillPreview(null)
      await loadCandidates()
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setSavingDistill(false)
    }
  }

  // 星图 ID 就地更新（只 PATCH xingtu_id；不动 candidate_id / snapshot / description / AI整理）
  const openXingtuEdit = () => {
    setEditingCandidate(selected)
    setXingtuEditOpen(true)
  }

  const handleSaveXingtu = async () => {
    if (!editingCandidate) return
    if (savingXingtu) return
    let values
    try {
      values = await xingtuForm.validateFields()
    } catch {
      return
    }
    setSavingXingtu(true)
    try {
      await updateCreatorCandidate(editingCandidate.id, { xingtu_id: values.xingtu_id || null })
      message.success('星图 ID 已更新')
      setXingtuEditOpen(false)
      setEditingCandidate(null)
      await loadCandidates()
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setSavingXingtu(false)
    }
  }

  // 复制星图 ID（clipboard API 失败时明确报错，绝不静默假成功）
  const handleCopyXingtuId = async () => {
    const text = String(selected?.xingtu_id ?? '').trim()
    if (!text) return
    try {
      if (!navigator?.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(text)
      message.success('星图 ID 已复制')
    } catch {
      message.error('复制失败，请手动复制星图 ID')
    }
  }

  // 编辑资料（复用同一 PATCH；description 变化时后端会自动清空过期 AI 整理）
  const openEdit = () => {
    setEditingCandidate(selected)
    setEditOpen(true)
  }

  const handleSaveEdit = async () => {
    if (!editingCandidate) return
    if (savingEdit) return
    let values
    try {
      values = await editForm.validateFields()
    } catch {
      return
    }
    setSavingEdit(true)
    try {
      await updateCreatorCandidate(editingCandidate.id, {
        name: values.name,
        creator_type: values.creator_type || null,
        profile_url: values.profile_url || null,
        xingtu_id: values.xingtu_id || null,
        description: values.description || null
      })
      message.success('资料已更新')
      setEditOpen(false)
      setEditingCandidate(null)
      // 备注若变化，后端已清空过期 AI 整理；同时丢弃未保存的 AI 预览，避免展示过期结果
      setDistillPreview(null)
      await loadCandidates()
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setSavingEdit(false)
    }
  }

  // 人工决定：必须由用户点击某个按钮显式发起（无默认选中、无系统推荐）
  const openDecision = (option) => {
    setPendingDecision(option)
    setDecisionNote('')
  }

  const handleSaveDecision = async () => {
    if (!selected || !pendingDecision || savingDecision) return
    setSavingDecision(true)
    try {
      // Phase 3：写入 candidate_work_state_events（不再创建 candidate_review decision）
      const res = await createCandidateWorkState(selected.id, {
        state: pendingDecision.value,
        note: decisionNote.trim() ? decisionNote.trim() : null
      })
      const updated = res?.data?.candidate
      const event = res?.data?.work_state_event
      message.success('当前处理已更新')
      setPendingDecision(null)
      setDecisionNote('')
      // 不做乐观更新：仅在服务端返回后更新本地状态，保证 UI 与 DB event 一致
      if (updated) {
        setCandidates((prev) => prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)))
      }
      if (event) {
        // append-only：新事件插到最前（与 detail 契约「最新 → 最旧」一致），不重拉 decisions
        setWorkStateHistory((prev) => [event, ...prev.filter((item) => item.id !== event.id)])
      }
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setSavingDecision(false)
    }
  }

  const observedLabel = (() => {
    if (!snapshot) return PLACEHOLDER
    const observed = String(snapshot.observed_at ?? '').trim()
    return /^\d{4}-\d{2}-\d{2}$/.test(observed) ? observed : '观察日期未知'
  })()
  // 量化判断全部由纯函数规则引擎给出（页面只负责展示，不重复计算业务规则）
  const assessment = snapshot ? buildCreatorPlaybookAssessment(snapshot) : null
  // B. 当前处理（Work State）：直接消费服务端值（candidate_work_state_events 最新一条；无事件 → advancing）
  const currentWorkState = useMemo(() => {
    const base = workStateOf(selected)
    return {
      value: base.value,
      label: base.label,
      note: selected?.work_state_note ?? null,
      updatedAt: selected?.work_state_updated_at ?? null,
      source: selected?.work_state_source ?? null
    }
  }, [selected])
  // F. 已关联合作记录：只使用 outcome 显式关联的投放记录（不按昵称猜、不自动连接历史 record）
  // Real Data Calibration V1：已作废决策不参与「最近决策」与已关联合作记录（历史中仍可查看）
  const activeDecisions = useMemo(() => decisions.filter((item) => !item.voided_at), [decisions])
  const linkedCollaborationRecords = useMemo(
    () => buildLinkedCollaborationRecords(activeDecisions),
    [activeDecisions]
  )
  const latestPostQuoteDecision = activeDecisions.find((item) => item.decision_stage === 'post_quote') || null
  // Phase 3：报价 CTA 的主/次层级跟随当前处理状态（服务端 Work State），不再读 legacy candidate_review
  const reviewContactConfirmed = currentWorkState.value === 'advancing'
  // Phase 4E：只以「最新 post_quote」为当前状态（不越过更晚的 negotiate / pause 去找早期 proceed）
  const latestPostQuoteEligible =
    Boolean(latestPostQuoteDecision) &&
    ['proceed', 'small_test'].includes(latestPostQuoteDecision.human_decision)
  const currentOutcome = latestPostQuoteDecision?.outcome || null
  // Unification V0.2：谈价经验不再要求必须是 negotiate（proceed / small_test / pause 也可记录已发生谈价），
  // 但仍只挂在真实存在的报价阶段决策上（不伪造 post_quote）
  const negotiationCapturableDecisions = ['negotiate', 'proceed', 'small_test', 'pause']
  const canRecordNegotiationExperience =
    Boolean(latestPostQuoteDecision) &&
    negotiationCapturableDecisions.includes(latestPostQuoteDecision.human_decision)
  const latestNegotiationCase = latestPostQuoteDecision?.negotiation_case || null
  // Semantic Duplicate V0.2：同一真实事件已由 outcome 关联的投放记录补录了历史谈价时，
  // candidate workspace 直接复用该 historical case（只读查看），不再提供 live 记录入口。
  const [linkedHistoricalCase, setLinkedHistoricalCase] = useState(null)
  const linkedOutcomeRecordId = currentOutcome?.record_id ?? null
  useEffect(() => {
    let active = true
    if (!linkedOutcomeRecordId) {
      setLinkedHistoricalCase(null)
      return undefined
    }
    getNegotiationCasesByRecord(linkedOutcomeRecordId)
      .then((res) => {
        if (!active) return
        const historical = (res?.data?.cases || []).find(
          (item) => item.source_type === 'historical_backfill'
        )
        setLinkedHistoricalCase(historical || null)
      })
      .catch(() => active && setLinkedHistoricalCase(null))
    return () => {
      active = false
    }
  }, [linkedOutcomeRecordId])
  // 已有谈价经验（live 或 outcome-linked 历史补录）→ 只读查看；否则才允许记录已发生谈价
  const existingNegotiationExperience = latestNegotiationCase || linkedHistoricalCase || null

  // 报价阶段：必须由用户主动点击后打开，无默认选中
  const openPostQuote = (prefillAmount) => {
    // 只有显式传入字符串才预填（点击事件对象不会被当成金额）
    setPostQuoteAmount(typeof prefillAmount === 'string' ? prefillAmount : '')
    setPostQuoteDecision(null)
    setPostQuoteNote('')
    setPostQuoteOpen(true)
  }

  const handleSavePostQuote = async () => {
    if (!selected || !postQuoteDecision || savingPostQuote) return
    if (!postQuoteAmount.trim()) {
      message.warning('请填写当前报价')
      return
    }
    if (!isValidDateOnly(postQuoteDecidedAt)) {
      message.warning('请填写真实的业务决策日期（YYYY-MM-DD）')
      return
    }
    setSavingPostQuote(true)
    try {
      await createCandidatePostQuoteDecision(selected.id, {
        current_quote_raw: postQuoteAmount.trim(),
        human_decision: postQuoteDecision.value,
        decision_note: postQuoteNote.trim() ? postQuoteNote.trim() : null,
        decided_at: postQuoteDecidedAt
      })
      message.success('报价阶段决策已记录')
      setPostQuoteOpen(false)
      await loadDecisions(selected.id)
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setSavingPostQuote(false)
    }
  }

  // Phase 4E：关联真实投放记录（候选列表来自既有 outcome-candidates 接口，前端不自己查 records）
  const selectedOutcomeCandidate =
    outcomeCandidates.find((item) => item.record_id === selectedOutcomeRecordId) || null

  const openOutcome = async () => {
    if (!latestPostQuoteDecision) return
    setOutcomeOpen(true)
    setOutcomeCandidates([])
    setSelectedOutcomeRecordId(null)
    setOutcomeIdentityConfirmed(false)
    setOutcomeTimingConfirmed(false)
    setOutcomeError('')
    setOutcomeLoading(true)
    try {
      const res = await getDecisionOutcomeCandidates(latestPostQuoteDecision.id)
      setOutcomeCandidates(res?.data?.candidates || [])
    } catch (error) {
      setOutcomeError(getErrorMessage(error))
    } finally {
      setOutcomeLoading(false)
    }
  }

  const handleLinkOutcome = async () => {
    if (!latestPostQuoteDecision || !selectedOutcomeCandidate || savingOutcome) return
    if (selectedOutcomeCandidate.requires_identity_confirmation && !outcomeIdentityConfirmed) {
      message.warning('请先确认这条投放记录属于当前候选达人')
      return
    }
    if (selectedOutcomeCandidate.requires_timing_confirmation && !outcomeTimingConfirmed) {
      message.warning('请先确认发布时间与当前决策的时间关系')
      return
    }
    setSavingOutcome(true)
    try {
      // 只提交 record_id + 两个人工确认 flag；candidate / decision / evidence 由后端决定
      await linkDecisionOutcome(latestPostQuoteDecision.id, {
        recordId: selectedOutcomeCandidate.record_id,
        identityConfirmed: outcomeIdentityConfirmed,
        timingConfirmed: outcomeTimingConfirmed
      })
      message.success('已关联实际投放')
      setOutcomeOpen(false)
      await loadDecisions(selected.id)
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setSavingOutcome(false)
    }
  }

  return (
    <div>
      <Card>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12
          }}
        >
          <Space direction="vertical" size={4}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              达人拓展
            </Typography.Title>
            <Typography.Text type="secondary">
              当前正在筛选 / 推进的达人：维护资料画像与近期数据，记录当前合作事实与已关联合作记录。
            </Typography.Text>
          </Space>
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={loadCandidates} loading={listLoading}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建候选达人
            </Button>
          </Space>
        </div>
        {listError && (
          <Typography.Text type="danger" style={{ display: 'block', marginTop: 12 }}>
            {listError}
          </Typography.Text>
        )}
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {/* A. 候选达人列表 */}
        <Col xs={24} lg={8}>
          <Card size="small" title={`候选达人（${candidates.length}）`}>
            <Space direction="vertical" size={10} style={{ display: 'flex' }}>
              {/* A1. 名称 substring 搜索（不做高级筛选） */}
              <Input
                allowClear
                size="small"
                value={searchKeyword}
                onChange={(event) => setSearchKeyword(event.target.value)}
                placeholder="搜索达人名称"
                prefix={<SearchOutlined style={{ color: 'rgba(0,0,0,0.35)' }} />}
              />
              {/* A2. 三个工作盒子筛选（互斥单选；由最新 candidate_review 派生） */}
              <Segmented
                size="small"
                block
                value={workStateFilter}
                onChange={setWorkStateFilter}
                options={WORK_STATE_FILTER_OPTIONS.map((option) => ({
                  value: option.value,
                  label: `${option.label} ${workStateCounts[option.value] ?? 0}`
                }))}
              />
              {candidates.length === 0 && !listLoading ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有候选达人，先新建一个"
                />
              ) : visibleCandidates.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="当前筛选条件下没有达人"
                />
              ) : (
                <List
                  loading={listLoading}
                  dataSource={visibleCandidates}
                  renderItem={(item) => (
                    <List.Item
                      style={{
                        cursor: 'pointer',
                        background: item.id === selectedId ? 'rgba(22, 119, 255, 0.06)' : undefined,
                        borderRadius: 4,
                        paddingLeft: 8,
                        paddingRight: 8
                      }}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <List.Item.Meta
                        title={
                          <Space size={6} wrap>
                            <Typography.Text strong>{item.name}</Typography.Text>
                            {item.status === 'archived' && <Tag>已归档</Tag>}
                            <Tag color={WORK_STATE_TAG_COLORS[workStateOf(item).value]}>
                              {workStateOf(item).label}
                            </Tag>
                          </Space>
                        }
                        description={item.creator_type || '未分类'}
                      />
                    </List.Item>
                  )}
                />
              )}
            </Space>
          </Card>
        </Col>

        {/* C + D. 选中候选的基本信息 + 近期表现 */}
        <Col xs={24} lg={16}>
          {!selected ? (
            <Card size="small">
              <Empty
                image={<UserAddOutlined style={{ fontSize: 40, color: 'rgba(0,0,0,0.25)' }} />}
                description="选择左侧候选达人，或新建一个候选"
              />
            </Card>
          ) : (
            <div>
              {/* 达人名称 + 主操作（一级信息：这是谁 / 要不要继续处理） */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  flexWrap: 'wrap',
                  gap: 12
                }}
              >
                <Space size={8} wrap align="center">
                  <Typography.Title level={4} style={{ margin: 0 }}>
                    {selected.name}
                  </Typography.Title>
                  <Typography.Text type="secondary">{selected.creator_type || '未分类'}</Typography.Text>
                  {selected.status === 'archived' && <Tag>已归档</Tag>}
                  {/* 次级操作：编辑资料（不抢「录入近期表现」的主 CTA 层级） */}
                  <Button type="link" size="small" onClick={openEdit}>
                    编辑资料
                  </Button>
                </Space>
                <Button type="primary" onClick={() => setAssistantOpen(true)}>
                  录入近期表现
                </Button>
              </div>

              {/* B. 轻量当前工作状态栏：只由最新 candidate_review 派生（不折叠、不套 Card） */}
              <div
                style={{
                  marginTop: 12,
                  padding: '10px 12px',
                  background: 'rgba(0,0,0,0.02)',
                  borderRadius: 6
                }}
              >
                <Space size={8} wrap align="center">
                  <Typography.Text strong>当前处理</Typography.Text>
                  {WORK_STATE_OPTIONS.map((option) => (
                    <Button
                      key={option.value}
                      size="small"
                      type={currentWorkState.value === option.value ? 'primary' : 'default'}
                      onClick={() => openDecision(option)}
                    >
                      {option.label}
                    </Button>
                  ))}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    只由最新一条当前处理记录派生；本轮谈价结果不会自动改变工作状态
                  </Typography.Text>
                  {(savingDecision || decisionsLoading) && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {savingDecision ? '保存中…' : '同步中…'}
                    </Typography.Text>
                  )}
                </Space>
                <div style={{ marginTop: 6 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    状态备注：
                  </Typography.Text>
                  {currentWorkState.note ? (
                    <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{currentWorkState.note}</Typography.Text>
                  ) : (
                    <Typography.Text type="secondary">暂无状态备注</Typography.Text>
                  )}
                  {currentWorkState.updatedAt && (
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                      {String(currentWorkState.updatedAt).slice(0, 16)}
                    </Typography.Text>
                  )}
                </div>
                {/* 当前处理历史（Phase 3：来自服务端 work_state_history，最新 → 最旧；legacy_state 仅技术审计不展示） */}
                {workStateHistory.length > 1 && (
                  <div style={{ marginTop: 6 }}>
                    <a style={{ fontSize: 12 }} onClick={() => setHistoryExpanded((value) => !value)}>
                      {historyExpanded ? '收起历史记录' : `查看历史记录（${workStateHistory.length - 1}）`}
                    </a>
                    {historyExpanded && (
                      <List
                        size="small"
                        dataSource={workStateHistory.slice(1)}
                        renderItem={(item) => (
                          <List.Item style={{ paddingLeft: 0, paddingRight: 0 }}>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {String(item.created_at || '').slice(0, 16)} ·{' '}
                              {WORK_STATE_LABELS[item.state] || item.state}
                              {item.note ? ` · ${item.note}` : ''}
                            </Typography.Text>
                          </List.Item>
                        )}
                      />
                    )}
                  </div>
                )}
              </div>

              <Divider style={{ margin: '16px 0 12px' }} />

              {/* 基础信息：身份 / 归档事实（不属于任何一个业务区块） */}
              <Descriptions size="small" column={2} style={{ marginBottom: 8 }}>
                <Descriptions.Item label="主页链接">
                  {selected.profile_url ? (
                    <a href={selected.profile_url} target="_blank" rel="noopener noreferrer">
                      查看主页
                    </a>
                  ) : (
                    PLACEHOLDER
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="星图 ID">
                  <Space size={4} wrap>
                    {selected.xingtu_id ? (
                      <Typography.Text>{selected.xingtu_id}</Typography.Text>
                    ) : (
                      <Typography.Text type="secondary">{PLACEHOLDER}</Typography.Text>
                    )}
                    {selected.xingtu_id && (
                      <Button type="link" size="small" onClick={handleCopyXingtuId}>
                        复制
                      </Button>
                    )}
                    <Button type="link" size="small" onClick={openXingtuEdit}>
                      {selected.xingtu_id ? '更新 ID' : '补充 ID'}
                    </Button>
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label="创建时间">
                  {String(selected.created_at || '').slice(0, 16) || PLACEHOLDER}
                </Descriptions.Item>
                <Descriptions.Item label="最近观察日期">{observedLabel}</Descriptions.Item>
              </Descriptions>

              <Divider style={{ margin: '16px 0 12px' }} />

              {/* 一级：达人资料画像（常驻展开）
                 语义：这个达人长期是什么样；人工观察是 source of truth（AI 只整理，绝不覆盖）。 */}
              <div>
                <Typography.Text strong style={{ fontSize: 15 }}>达人资料画像</Typography.Text>
                <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 8 }}>
                  记录这个达人的长期特征、内容风格、价格感知和合作观察。这里只描述长期画像，不放本轮谈价结果。
                </Typography.Paragraph>
                <Space size={8} wrap align="center">
                  <Typography.Text strong>人工观察</Typography.Text>
                  {Boolean(String(selected.description ?? '').trim()) && (
                    <Tooltip title={aiReady ? '' : '连接 AI 后可整理达人资料'}>
                      <Button
                        size="small"
                        disabled={!aiReady}
                        loading={distilling}
                        onClick={handleDistill}
                      >
                        AI整理达人资料
                      </Button>
                    </Tooltip>
                  )}
                </Space>
                <Typography.Paragraph style={{ marginTop: 6, marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                  {selected.description || PLACEHOLDER}
                </Typography.Paragraph>
                {/* 观察提示：只是 guidance，不是必填表单，也不新增 DB 字段 */}
                <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
                  {PROFILE_GUIDANCE}
                </Typography.Text>
              </div>

              {/* AI 整理预览（未保存）：明确与人工观察区分，不自动写库 */}
              {distillPreview && (
                <div style={{ marginTop: 10, padding: 8, background: 'rgba(0,0,0,0.02)', borderRadius: 4 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    AI整理达人资料（仅供参考）· 预览，未保存
                  </Typography.Text>
                  <ul style={{ margin: '4px 0 8px', paddingLeft: 20 }}>
                    {distillPreview.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                  <Space size={8}>
                    <Button size="small" type="primary" loading={savingDistill} onClick={handleSaveDistill}>
                      保存达人资料整理结果
                    </Button>
                    <Button size="small" onClick={() => setDistillPreview(null)}>
                      放弃
                    </Button>
                  </Space>
                </div>
              )}

              {/* 已保存的 AI 整理结果（派生文本，与人工观察分开展示） */}
              {selected.distilled_description && (
                <div style={{ marginTop: 10 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    AI整理后的达人画像（仅供参考）
                  </Typography.Text>
                  <Typography.Paragraph style={{ marginTop: 4, marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                    {selected.distilled_description}
                  </Typography.Paragraph>
                </div>
              )}

              <Divider style={{ margin: '16px 0 12px' }} />

              {/* 一级：近期数据（常驻展开；原样复用既有 recent performance UI，不重写） */}
              <div>
                <Typography.Text strong style={{ fontSize: 15 }}>
                  近期数据
                </Typography.Text>
                <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
                  来自最近一次录入的近期表现快照
                </Typography.Text>
                <div style={{ marginTop: 8 }}>
              {snapshotLoading ? (
                <Typography.Text type="secondary">加载近期表现…</Typography.Text>
              ) : !snapshot ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="尚未录入近期表现，点击右上角「录入近期表现」"
                />
              ) : (
                <Space direction="vertical" size={16} style={{ display: 'flex' }}>
                  {/* 核心指标：直接来自 snapshot 的事实（不重算） */}
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      核心指标
                    </Typography.Text>
                    <Row gutter={[12, 12]} style={{ marginTop: 8 }}>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic title="整体中位播放" value={renderMedian(snapshot.median_play)} />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic title="整体平均播放" value={renderMedian(assessment.metrics.meanPlay)} />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic
                          title="P25 / P75"
                          value={`${renderMedian(snapshot.p25_play)} / ${renderMedian(snapshot.p75_play)}`}
                        />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic
                          title="趋势"
                          value={TREND_LABELS_FULL[snapshot.trend_label] || '样本不足'}
                        />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic title="有效内容数" value={formatInteger(snapshot.valid_count ?? 0)} />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic
                          title="商单中位 / 条数"
                          value={`${renderMedian(snapshot.sponsored_median_play)} / ${formatInteger(snapshot.sponsored_count ?? 0)}`}
                        />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic
                          title="日常中位 / 条数"
                          value={`${renderMedian(snapshot.organic_median_play)} / ${formatInteger(snapshot.organic_count ?? 0)}`}
                        />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic title="未识别条数" value={formatInteger(snapshot.unknown_count ?? 0)} />
                      </Col>
                    </Row>
                  </div>

                  <Divider style={{ margin: '4px 0' }} />

                  {/* 第二层：量化判断（可解释维度，人工决定是否投放） */}
                  <div>
                    <Space size={8} wrap align="baseline">
                      <Typography.Text strong>量化判断</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        仅量化呈现，是否投放由人工决定
                      </Typography.Text>
                    </Space>
                    <Space size={8} wrap style={{ display: 'flex', marginTop: 8 }}>
                      <Tag>{assessment.scale.label}</Tag>
                      <Tag>{assessment.commercialDensity.label}</Tag>
                      <Tag color={STABILITY_TAG_COLORS[assessment.stability.code]}>
                        {assessment.stability.label}
                      </Tag>
                      {assessment.highPlaySignal.active && (
                        <Tag color="gold">{assessment.highPlaySignal.label}</Tag>
                      )}
                    </Space>
                    <Space direction="vertical" size={2} style={{ display: 'flex', marginTop: 8 }}>
                      <Typography.Text type="secondary">{assessment.stability.explanation}</Typography.Text>
                      <Typography.Text type="secondary">
                        估价依据：{assessment.estimate.baselineLabel || assessment.performanceBasis.explanation}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {assessment.performanceBasis.explanation}
                      </Typography.Text>
                    </Space>
                  </div>

                  <Divider style={{ margin: '4px 0' }} />

                  {/* 第三层：价格分寸（CPM15-20 估价锚点 + 万元风险） */}
                  <div>
                    <Typography.Text strong>价格分寸</Typography.Text>
                    <Row gutter={[12, 12]} style={{ marginTop: 8 }}>
                      <Col xs={24} sm={12} lg={8}>
                        <Statistic title="CPM15-20 基础估价" value={renderEstimateRange(assessment.estimate)} />
                      </Col>
                      <Col xs={24} sm={12} lg={8}>
                        <Statistic
                          title="估价置信"
                          value={ESTIMATE_CONFIDENCE_LABELS[assessment.estimate.confidence] || PLACEHOLDER}
                        />
                      </Col>
                      <Col xs={24} sm={12} lg={8}>
                        <Statistic title="星图刊例价" value={formatPrice(snapshot.xingtu_price) ?? '暂无'} />
                      </Col>
                    </Row>
                    <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                      {assessment.estimate.explanation}
                    </Typography.Text>
                    {assessment.risk.highAmount && (
                      <Alert
                        type="warning"
                        showIcon
                        style={{ marginTop: 8 }}
                        message="万元以上高金额"
                        description={assessment.risk.explanation}
                      />
                    )}
                  </div>
                </Space>
              )}
                </div>
              </div>

              <Divider style={{ margin: '16px 0 12px' }} />

              {/* 一级：当前合作（可独立折叠）：价格与参考 / 本轮谈价 / 本轮结果
                  底层仍是不同事实，但前端属于同一个 Business Context。
                  MOVE, DON'T REWRITE：下面是既有事实块的搬运，不重写底层语义。 */}
              <Collapse
                ghost
                activeKey={cooperationKeys}
                onChange={(keys) => setCooperationKeys(Array.isArray(keys) ? keys : [keys])}
                items={[
                  {
                    key: 'cooperation',
                    label: (
                      <Space size={8} wrap>
                        <Typography.Text strong style={{ fontSize: 15 }}>
                          当前合作
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          价格与参考 · 本轮谈价 · 本轮结果
                        </Typography.Text>
                      </Space>
                    ),
                    children: (
                      <Space direction="vertical" size={14} style={{ display: 'flex' }}>
                        {/* 二级：价格与参考（当前报价 + 历史价格参考，全部是既有事实展示） */}
                        <div>
                          <Typography.Text strong>价格与参考</Typography.Text>

                          {/* Phase 4D：报价阶段（继续联系后的自然 next step；同时保留直接记录入口，不制造流程死锁） */}
                          <div style={{ marginTop: 8 }}>
                            <Space size={8} wrap align="center">
                              {reviewContactConfirmed ? (
                                <Button type="primary" ghost onClick={openPostQuote}>
                                  记录当前报价
                                </Button>
                              ) : (
                                <Button onClick={openPostQuote}>已有报价，直接记录</Button>
                              )}
                              {!snapshot && (
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  需先录入近期表现
                                </Typography.Text>
                              )}
                            </Space>

                            {latestPostQuoteDecision && (
                              <div style={{ marginTop: 10 }}>
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  最近报价阶段
                                </Typography.Text>
                                <Space direction="vertical" size={2} style={{ display: 'flex', marginTop: 4 }}>
                                  <Typography.Text>
                                    当前报价：{formatPrice(latestPostQuoteDecision.current_quote) ?? '-'}
                                    {latestPostQuoteDecision.pricing_evidence?.xingtu_price !== null &&
                                    latestPostQuoteDecision.pricing_evidence?.xingtu_price !== undefined
                                      ? ` · 星图刊例：${formatPrice(latestPostQuoteDecision.pricing_evidence.xingtu_price)}`
                                      : ''}
                                    {typeof latestPostQuoteDecision.pricing_evidence?.quote_to_xingtu_ratio === 'number'
                                      ? ` · 当前报价约 ${(latestPostQuoteDecision.pricing_evidence.quote_to_xingtu_ratio * 10).toFixed(1)} 折`
                                      : ''}
                                  </Typography.Text>
                                  {latestPostQuoteDecision.pricing_evidence?.playbook_estimate && (
                                    <Typography.Text type="secondary">
                                      Playbook 估价：
                                      {renderEstimateRange({
                                        low: latestPostQuoteDecision.pricing_evidence.playbook_estimate.estimate_low,
                                        high: latestPostQuoteDecision.pricing_evidence.playbook_estimate.estimate_high
                                      })}
                                      {' · 报价位置：'}
                                      {QUOTE_POSITION_LABELS[
                                        latestPostQuoteDecision.pricing_evidence.current_quote_assessment?.position
                                      ] || '-'}
                                    </Typography.Text>
                                  )}
                                  <Typography.Text type="secondary">
                                    人工决定：
                                    {latestPostQuoteDecision.human_decision_label || latestPostQuoteDecision.human_decision} ·{' '}
                                    {latestPostQuoteDecision.decided_at || '业务日期未补'}
                                  </Typography.Text>
                                  {latestPostQuoteDecision.decision_note && (
                                    <Typography.Text type="secondary">
                                      备注：{latestPostQuoteDecision.decision_note}
                                    </Typography.Text>
                                  )}
                                </Space>
                              </div>
                            )}
                          </div>

                          {/* Phase 3B：历史价格参考（只读历史事实，与 CPM15-20 经验估价并列，不融合成"建议价"） */}
                          <div style={{ marginTop: 10 }}>
                            <Typography.Text strong>历史价格参考</Typography.Text>
                            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                              基于过去真实投放记录，按商单播放量接近度检索。仅展示历史事实，不代表推荐价格。
                            </Typography.Text>
                            <div style={{ marginTop: 8 }}>{renderPriceReference(priceRef, priceRefLoading)}</div>
                          </div>
                        </div>
                        {/* /价格与参考 */}

                        <Divider style={{ margin: '4px 0' }} />

                        {/* 二级：本轮谈价（事件级事实；AI整理谈价经验只针对这一次真实谈价） */}
                        <div>
                          <Typography.Text strong>本轮谈价</Typography.Text>

                          {/* Unification V0.2：本次谈价记录（negotiate / proceed / small_test / pause 都可记录） */}
                          <div style={{ marginTop: 8 }}>
                            <Typography.Text strong>本次谈价记录</Typography.Text>
                            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                              记录这一次具体谈价的价格变化、原因和过程，可用于后续复盘。
                            </Typography.Text>
                            {canRecordNegotiationExperience && !existingNegotiationExperience && (
                              <Button size="small" style={{ marginTop: 6 }} onClick={() => setNegotiationOpen(true)}>
                                记录本次谈价
                              </Button>
                            )}
                          </div>
                          {latestNegotiationCase && (
                            <div style={{ marginTop: 6, borderTop: '1px dashed #f0f0f0', paddingTop: 6 }}>
                              <Typography.Text style={{ display: 'block' }}>
                                初始报价：{formatPrice(latestNegotiationCase.current_quote_snapshot) ?? '暂无'}
                              </Typography.Text>
                              <Typography.Text style={{ display: 'block' }}>
                                谈后价格：{formatPrice(latestNegotiationCase.negotiated_price) ?? '-'}
                              </Typography.Text>
                              <Typography.Text type="secondary" style={{ display: 'block' }}>
                                星图刊例：
                                {latestNegotiationCase.xingtu_price_snapshot === null ||
                                latestNegotiationCase.xingtu_price_snapshot === undefined
                                  ? '暂无'
                                  : `${formatPrice(latestNegotiationCase.xingtu_price_snapshot)} · 谈后价约为星图 ${
                                      latestNegotiationCase.outcome?.xingtu_discount_zhe ?? '-'
                                    }折 · 初始报价约为星图 ${
                                      latestNegotiationCase.outcome?.initial_quote_to_xingtu_ratio !== null &&
                                      latestNegotiationCase.outcome?.initial_quote_to_xingtu_ratio !== undefined
                                        ? (latestNegotiationCase.outcome.initial_quote_to_xingtu_ratio * 10).toFixed(1)
                                        : '-'
                                    }折`}
                              </Typography.Text>
                              <Typography.Text type="secondary" style={{ display: 'block' }}>
                                相对初始报价：
                                {latestNegotiationCase.outcome?.quote_change_rate === null ||
                                latestNegotiationCase.outcome?.quote_change_rate === undefined
                                  ? '无法计算（初始报价为 0 / 暂无）'
                                  : latestNegotiationCase.outcome.quote_change_rate < 0
                                    ? `下降 ${(Math.abs(latestNegotiationCase.outcome.quote_change_rate) * 100).toFixed(1)}%`
                                    : latestNegotiationCase.outcome.quote_change_rate > 0
                                      ? `上升 ${(latestNegotiationCase.outcome.quote_change_rate * 100).toFixed(1)}%`
                                      : '无变化'}
                              </Typography.Text>
                              {(latestNegotiationCase.reason_tag_labels || []).length > 0 && (
                                <Typography.Text type="secondary" style={{ display: 'block' }}>
                                  原因：{latestNegotiationCase.reason_tag_labels.join(' · ')}
                                </Typography.Text>
                              )}
                              {latestNegotiationCase.reason_note && (
                                <Typography.Text type="secondary" style={{ display: 'block' }}>
                                  补充说明：{latestNegotiationCase.reason_note}
                                </Typography.Text>
                              )}
                              {latestNegotiationCase.strategy_note && (
                                <Typography.Text type="secondary" style={{ display: 'block' }}>
                                  谈价依据 / 过程：{latestNegotiationCase.strategy_note}
                                </Typography.Text>
                              )}
                              <Button
                                size="small"
                                style={{ marginTop: 6 }}
                                onClick={() => openPostQuote(String(latestNegotiationCase.negotiated_price))}
                              >
                                以谈后价继续判断
                              </Button>
                              <Button
                                size="small"
                                style={{ marginTop: 6, marginLeft: 8 }}
                                onClick={() => setNegotiationOpen(true)}
                              >
                                查看本次谈价记录
                              </Button>
                            </div>
                          )}
                          {/* Semantic Duplicate V0.2：该次真实投放已补录历史谈价 → 只读查看，不再提供 live 记录入口 */}
                          {!latestNegotiationCase && linkedHistoricalCase && (
                            <div style={{ marginTop: 6, borderTop: '1px dashed #f0f0f0', paddingTop: 6 }}>
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                本次谈价记录 · 来源：历史补录
                              </Typography.Text>
                              <Typography.Text style={{ display: 'block' }}>
                                谈前报价：
                                {formatPrice(linkedHistoricalCase.current_quote_snapshot) ?? '暂无'}
                              </Typography.Text>
                              <Typography.Text style={{ display: 'block' }}>
                                谈后价格：{formatPrice(linkedHistoricalCase.negotiated_price) ?? '-'}
                              </Typography.Text>
                              {linkedHistoricalCase.negotiated_at && (
                                <Typography.Text type="secondary" style={{ display: 'block' }}>
                                  谈价日期：{linkedHistoricalCase.negotiated_at}
                                </Typography.Text>
                              )}
                              {(linkedHistoricalCase.reason_tag_labels || []).length > 0 && (
                                <Typography.Text type="secondary" style={{ display: 'block' }}>
                                  谈价原因 / 背景：
                                  {(linkedHistoricalCase.reason_tags || [])
                                    .map((tag) => NEGOTIATION_REASON_TAG_LABELS[tag] || tag)
                                    .join(' · ')}
                                </Typography.Text>
                              )}
                              {linkedHistoricalCase.reason_note && (
                                <Typography.Text type="secondary" style={{ display: 'block' }}>
                                  补充说明：{linkedHistoricalCase.reason_note}
                                </Typography.Text>
                              )}
                              {linkedHistoricalCase.strategy_note && (
                                <Typography.Text type="secondary" style={{ display: 'block' }}>
                                  谈价依据 / 过程：{linkedHistoricalCase.strategy_note}
                                </Typography.Text>
                              )}
                              <Button size="small" style={{ marginTop: 6 }} onClick={() => setNegotiationOpen(true)}>
                                查看本次谈价记录
                              </Button>
                            </div>
                          )}
                          {/* Unification V0.2：没有真实报价阶段决策时不制造流程死锁，也不伪造 post_quote */}
                          {!latestPostQuoteDecision && (
                            <Typography.Text
                              type="secondary"
                              style={{ display: 'block', fontSize: 12, marginTop: 8 }}
                            >
                              本次谈价记录：当前没有报价阶段记录，如确实已发生谈价，请先补充当前报价 / 报价阶段事实。
                            </Typography.Text>
                          )}
                        </div>

                        <Divider style={{ margin: '4px 0' }} />

                        {/* 二级：本轮结果（Phase 4E；只针对「最新 post_quote 且 eligible」的决策） */}
                        <div>
                          <Typography.Text strong>本轮结果</Typography.Text>
                          <Typography.Text strong style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
                            实际投放结果
                          </Typography.Text>
                          {!latestPostQuoteEligible ? (
                            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
                              尚未进入可关联实际投放结果的阶段。
                            </Typography.Text>
                          ) : currentOutcome ? (
                            <Space direction="vertical" size={2} style={{ display: 'flex', marginTop: 6 }}>
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                已关联实际投放
                              </Typography.Text>
                              <Typography.Text>达人：{currentOutcome.creator || '-'}</Typography.Text>
                              <Typography.Text type="secondary">
                                发布日期：{currentOutcome.publish_date || '-'} · 实际合作成本：
                                {formatPrice(currentOutcome.total_cost) ?? '-'}
                              </Typography.Text>
                              <Typography.Text type="secondary">
                                7日播放：{formatPlays(currentOutcome.first_play)} · 累计播放：
                                {formatPlays(currentOutcome.latest_play)} · 最终 CPM：
                                {currentOutcome.latest_cpm ?? '-'}
                              </Typography.Text>
                              <Typography.Text type="secondary">
                                关联时间：{String(currentOutcome.linked_at || '').slice(0, 16)}
                              </Typography.Text>
                              <Space size={6} wrap>
                                {currentOutcome.link_evidence?.identity?.override_used && (
                                  <Tag>人工确认身份关联</Tag>
                                )}
                                {currentOutcome.link_evidence?.timing?.override_used && (
                                  <Tag>人工确认发布时间关系</Tag>
                                )}
                              </Space>
                            </Space>
                          ) : (
                            <Space size={8} wrap align="center" style={{ marginTop: 6 }}>
                              <Typography.Text type="secondary">
                                当前投放决定：
                                {latestPostQuoteDecision.human_decision_label || latestPostQuoteDecision.human_decision}
                              </Typography.Text>
                              <Button type="primary" onClick={openOutcome}>
                                关联实际投放记录
                              </Button>
                            </Space>
                          )}
                        </div>
                      </Space>
                    )
                  }
                ]}
              />

              <Divider style={{ margin: '16px 0 12px' }} />

              {/* 一级：已关联合作记录（默认折叠）
                  只使用 outcome 显式关联的投放记录：不按昵称模糊匹配、不按名称相等猜测、不自动连接历史 record。
                  多轮合作 A / B 并存，每轮独立展示，绝不覆盖。 */}
              <Collapse
                ghost
                activeKey={linkedRecordKeys}
                onChange={(keys) => setLinkedRecordKeys(Array.isArray(keys) ? keys : [keys])}
                items={[
                  {
                    key: 'linked-records',
                    label: (
                      <Space size={8} wrap>
                        <Typography.Text strong style={{ fontSize: 15 }}>
                          已关联合作记录（{linkedCollaborationRecords.length}）
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          仅统计已由 outcome 显式关联的投放记录
                        </Typography.Text>
                      </Space>
                    ),
                    children: (
                      <div>
                        {linkedCollaborationRecords.length === 0 ? (
                          <Typography.Text type="secondary">暂无已关联的历史合作记录</Typography.Text>
                        ) : (
                          <List
                            size="small"
                            dataSource={linkedCollaborationRecords}
                            renderItem={({ decision, record }) => (
                              <List.Item style={{ paddingLeft: 0, paddingRight: 0 }}>
                                <Space direction="vertical" size={2} style={{ display: 'flex' }}>
                                  <Space size={6} wrap>
                                    <Typography.Text strong>{record.creator || '-'}</Typography.Text>
                                    <Typography.Text type="secondary">
                                      发布日期：{record.publish_date || '-'}
                                    </Typography.Text>
                                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                      关联时间：{String(decision.outcome?.linked_at || '').slice(0, 16) || '-'}
                                    </Typography.Text>
                                    {currentOutcome?.record_id === record.record_id && <Tag>本轮</Tag>}
                                  </Space>
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                    实际合作成本 {formatPrice(record.total_cost) ?? '-'} · 7日播放{' '}
                                    {formatPlays(record.first_play)} · 累计播放 {formatPlays(record.latest_play)} ·
                                    最终 CPM {record.latest_cpm ?? '-'}
                                  </Typography.Text>
                                </Space>
                              </List.Item>
                            )}
                          />
                        )}
                      </div>
                    )
                  }
                ]}
              />
            </div>
          )}
        </Col>
      </Row>

      {/* B. 新建候选达人 */}
      <Modal
        title="新建候选达人"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={handleCreate}
        confirmLoading={creating}
        okText="创建"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="达人名称"
            rules={[{ required: true, message: '请填写达人名称' }]}
          >
            <Input placeholder="达人名称（允许重名）" maxLength={100} />
          </Form.Item>
          <Form.Item name="creator_type" label="达人类型（可选）">
            <Input placeholder="如 美妆 / 数码 / 生活" maxLength={50} />
          </Form.Item>
          <Form.Item name="profile_url" label="主页链接（可选）">
            <Input placeholder="https://..." maxLength={500} />
          </Form.Item>
          <Form.Item name="xingtu_id" label="星图 ID（可选）">
            <Input placeholder="星图 ID" maxLength={100} />
          </Form.Item>
          <Form.Item name="description" label="简短备注（可选）">
            <Input.TextArea placeholder="来源 / 判断线索等" maxLength={500} autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 星图 ID 就地更新（轻量 Modal，只改 xingtu_id） */}
      <Modal
        title={editingCandidate?.xingtu_id ? '更新星图 ID' : '补充星图 ID'}
        open={xingtuEditOpen}
        onCancel={() => {
          setXingtuEditOpen(false)
          setEditingCandidate(null)
        }}
        afterOpenChange={(open) => {
          // 必须等 Modal 真正打开、Form 已挂载后再回填；否则 setFieldsValue 会被丢弃
          if (!open) return
          applyXingtuIdFormValues(xingtuForm, editingCandidate)
        }}
        onOk={handleSaveXingtu}
        confirmLoading={savingXingtu}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={xingtuForm} layout="vertical" preserve={false}>
          <Form.Item
            name="xingtu_id"
            label="星图 ID"
            extra="星图平台中的达人 ID / 业务查询标识；留空表示不填写"
          >
            <Input placeholder="星图 ID" maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑资料（复用同一 PATCH；不改 candidate_id / created_at / snapshot / AI整理） */}
      <Modal
        title="编辑资料"
        open={editOpen}
        onCancel={() => {
          setEditOpen(false)
          setEditingCandidate(null)
        }}
        afterOpenChange={(open) => {
          // 必须等 Modal 真正打开、Form 已挂载后再回填；否则 setFieldsValue 会被丢弃
          if (!open) return
          applyCandidateEditValues(editForm, editingCandidate)
        }}
        onOk={handleSaveEdit}
        confirmLoading={savingEdit}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="达人名称"
            rules={[{ required: true, message: '请填写达人名称' }]}
            extra="改名不影响 candidate_id；已保存的历史快照保留创建时的旧名称"
          >
            <Input placeholder="达人名称（允许重名）" maxLength={100} />
          </Form.Item>
          <Form.Item name="creator_type" label="达人类型（可选）">
            <Input placeholder="如 美妆 / 数码 / 生活" maxLength={50} />
          </Form.Item>
          <Form.Item name="profile_url" label="达人主页链接（可选）">
            <Input placeholder="https://..." maxLength={500} />
          </Form.Item>
          <Form.Item name="xingtu_id" label="星图 ID（可选）">
            <Input placeholder="星图 ID" maxLength={100} />
          </Form.Item>
          <Form.Item
            name="description"
            label="人工观察（可选）"
            extra="观察内容变化后，旧的 AI 整理达人资料结果会自动失效"
          >
            <Input.TextArea placeholder="来源 / 判断线索等" maxLength={500} autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 当前处理（Work State）确认：沿用既有 candidate_review decision 创建能力（append-only，不 UPDATE） */}
      <Modal
        title="更新当前处理"
        open={Boolean(pendingDecision)}
        onCancel={() => {
          setPendingDecision(null)
          setDecisionNote('')
        }}
        onOk={handleSaveDecision}
        confirmLoading={savingDecision}
        okText="记录决定"
        cancelText="取消"
        destroyOnClose
      >
        <Space direction="vertical" size={8} style={{ display: 'flex' }}>
          <div>
            <Typography.Text type="secondary">你选择：</Typography.Text>
            <Typography.Text strong>{pendingDecision?.label}</Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
              会新增一条人工决定记录（历史记录不覆盖）；当前处理只由最新一次人工决定派生。
            </Typography.Text>
          </div>
          <div>
            <Typography.Text type="secondary">决策备注（可选）</Typography.Text>
            <Input.TextArea
              value={decisionNote}
              onChange={(event) => setDecisionNote(event.target.value)}
              maxLength={500}
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="记录判断依据 / 后续动作"
            />
          </div>
          <div>
            <Typography.Text type="secondary">业务决策日期</Typography.Text>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
              <DatePicker
                value={postQuoteDecidedAt ? dayjs(postQuoteDecidedAt) : null}
                format="YYYY-MM-DD"
                allowClear={false}
                style={{ width: 180 }}
                onChange={(value) => setPostQuoteDecidedAt(value ? value.format('YYYY-MM-DD') : '')}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                历史补录请填写真实决策日期；系统录入时间会自动保留。
              </Typography.Text>
            </div>
          </div>
        </Space>
      </Modal>

      {/* Phase 4D：报价阶段决策（无默认选中；不自动弹出） */}
      <Modal
        title="记录报价阶段决策"
        open={postQuoteOpen}
        onCancel={() => {
          setPostQuoteOpen(false)
          setPostQuoteAmount('')
          setPostQuoteDecision(null)
          setPostQuoteNote('')
          setPostQuoteDecidedAt(todayLocalDateOnly())
        }}
        onOk={handleSavePostQuote}
        confirmLoading={savingPostQuote}
        okText="记录报价决策"
        cancelText="取消"
        destroyOnClose
      >
        <Space direction="vertical" size={10} style={{ display: 'flex' }}>
          <div>
            <Typography.Text type="secondary">当前报价</Typography.Text>
            <Input
              value={postQuoteAmount}
              onChange={(event) => setPostQuoteAmount(event.target.value)}
              placeholder="如 ¥3000 / 3000元 / 3,000"
              maxLength={60}
            />
          </div>
          <div>
            <Typography.Text type="secondary">决策（请主动选择）</Typography.Text>
            <Space size={8} wrap style={{ display: 'flex', marginTop: 6 }}>
              {CANDIDATE_POST_QUOTE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type={postQuoteDecision?.value === option.value ? 'primary' : 'default'}
                  onClick={() => setPostQuoteDecision(option)}
                >
                  {option.label}
                </Button>
              ))}
            </Space>
          </div>
          <div>
            <Typography.Text type="secondary">决策备注（可选）</Typography.Text>
            <Input.TextArea
              value={postQuoteNote}
              onChange={(event) => setPostQuoteNote(event.target.value)}
              maxLength={500}
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="记录报价来源 / 判断依据"
            />
          </div>
        </Space>
      </Modal>

      {/* Unification V0.2：谈价经验（共享谈价经验表单 + live negotiation case 领域模型） */}
      <CandidateNegotiationExperienceModal
        open={negotiationOpen}
        candidate={selected}
        decision={latestPostQuoteDecision}
        postQuoteDecision={latestPostQuoteDecision}
        existingCase={existingNegotiationExperience}
        xingtuPrice={snapshot?.xingtu_price ?? null}
        onClose={() => setNegotiationOpen(false)}
        onSaved={() => loadDecisions(selectedId)}
      />

      {/* Phase 4E：选择真实投放记录（候选来自既有 outcome-candidates 接口） */}
      <Modal
        title="关联实际投放记录"
        open={outcomeOpen}
        onCancel={() => setOutcomeOpen(false)}
        onOk={handleLinkOutcome}
        confirmLoading={savingOutcome}
        okText="关联"
        cancelText="取消"
        okButtonProps={{ disabled: !selectedOutcomeCandidate }}
        destroyOnClose
        width={720}
      >
        {outcomeLoading ? (
          <Typography.Text type="secondary">加载可关联记录…</Typography.Text>
        ) : outcomeError ? (
          <Typography.Text type="danger">{outcomeError}</Typography.Text>
        ) : outcomeCandidates.length === 0 ? (
          <Space direction="vertical" size={8}>
            <Typography.Text type="secondary">
              暂未找到可关联的真实投放记录。请先在投放记录中录入或导入实际合作结果，再回来关联。
            </Typography.Text>
            <Button size="small" onClick={openOutcome}>
              刷新
            </Button>
          </Space>
        ) : (
          <Space direction="vertical" size={10} style={{ display: 'flex' }}>
            <List
              size="small"
              dataSource={outcomeCandidates}
              renderItem={(item) => (
                <List.Item
                  style={{
                    cursor: 'pointer',
                    background: item.record_id === selectedOutcomeRecordId ? 'rgba(22,119,255,0.06)' : undefined,
                    borderRadius: 4,
                    paddingLeft: 8,
                    paddingRight: 8
                  }}
                  onClick={() => {
                    setSelectedOutcomeRecordId(item.record_id)
                    setOutcomeIdentityConfirmed(false)
                    setOutcomeTimingConfirmed(false)
                  }}
                >
                  <Space direction="vertical" size={2} style={{ display: 'flex' }}>
                    <Space size={6} wrap>
                      <Typography.Text strong>{item.creator}</Typography.Text>
                      <Typography.Text type="secondary">{item.publish_date || '-'}</Typography.Text>
                      {item.already_linked && <Tag>已关联其他决策</Tag>}
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      实际合作 {formatPrice(item.total_cost) ?? '-'} · 7日播放 {formatPlays(item.first_play)} · 累计播放{' '}
                      {formatPlays(item.latest_play)} · 最终 CPM {item.latest_cpm ?? '-'}
                    </Typography.Text>
                  </Space>
                </List.Item>
              )}
            />

            {selectedOutcomeCandidate?.requires_identity_confirmation && (
              <div style={{ padding: 8, background: 'rgba(0,0,0,0.02)', borderRadius: 4 }}>
                <Checkbox
                  checked={outcomeIdentityConfirmed}
                  onChange={(event) => setOutcomeIdentityConfirmed(event.target.checked)}
                >
                  我确认这条投放记录属于当前候选达人
                </Checkbox>
                {selectedOutcomeCandidate.identity_reason === 'ambiguous_name' ? (
                  <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                    存在多个同名候选达人，仅凭名称无法确认身份归属。
                  </Typography.Text>
                ) : (
                  <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                    候选达人当前名称：{selected?.name || '-'}；投放记录名称：{selectedOutcomeCandidate.creator || '-'}
                  </Typography.Text>
                )}
              </div>
            )}

            {selectedOutcomeCandidate?.requires_timing_confirmation && (
              <div style={{ padding: 8, background: 'rgba(0,0,0,0.02)', borderRadius: 4 }}>
                <Checkbox
                  checked={outcomeTimingConfirmed}
                  onChange={(event) => setOutcomeTimingConfirmed(event.target.checked)}
                >
                  我确认该发布时间与当前决策的时间关系无误
                </Checkbox>
                <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                  决策日期：{latestPostQuoteDecision?.decided_at || '业务日期未补'}；投放发布日期：
                  {selectedOutcomeCandidate.publish_date || '-'}
                </Typography.Text>
              </div>
            )}
          </Space>
        )}
      </Modal>

      {/* D. 复用现有近期表现助手（候选模式：按 candidate_id 保存 / 读取） */}
      <RecentPerformanceAssistantModal
        open={assistantOpen}
        creator={selected?.name || null}
        candidateId={selected?.id ?? null}
        creatorOptions={selected ? [selected.name] : []}
        mode="update"
        onCancel={() => setAssistantOpen(false)}
        onSaved={() => {
          // 保存近期表现后同时刷新 snapshot 与历史价格参考
          loadSnapshot(selectedId)
          loadPriceReference(selectedId)
        }}
      />
    </div>
  )
}
