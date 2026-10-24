import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Button,
  DatePicker,
  Divider,
  Drawer,
  Empty,
  Input,
  Modal,
  Radio,
  Slider,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd'
import dayjs from 'dayjs'
import {
  createCreatorDecision,
  getCreatorDecisions,
  previewCreatorDecisionQuote,
  unlinkDecisionOutcome
} from '../api/creatorDecisions'
import { correctNegotiationCaseDate } from '../api/creatorNegotiationCases'
import { correctDecisionDate, voidDecision } from '../api/creatorDecisions'
import { formatCpm, formatInteger, formatMoney, formatPlays } from '../utils/format'
import { formatPrice, formatZhe } from '../utils/pricingDisplay.js'
import { isValidDateOnly, todayLocalDateOnly } from '../utils/recentPerformanceSave.js'
import OutcomeLinkModal from './OutcomeLinkModal.jsx'
import NegotiationCaseModal from './NegotiationCaseModal.jsx'
import {
  buildNegotiationPriceRows,
  NEGOTIATION_REASON_TAG_LABELS
} from '../utils/negotiationCaseDisplay.js'
import {
  SIMULATOR_DEFAULT_RATE,
  SIMULATOR_MAX_RATE,
  SIMULATOR_MIN_RATE,
  SIMULATOR_STEP_RATE,
  formatSimulatorZhe,
  simulateNegotiation
} from '../utils/negotiationSimulator.js'

const IP_OPTIONS = [
  { value: 'strong', label: '明显' },
  { value: 'medium', label: '一般' },
  { value: 'weak', label: '较弱' },
  { value: 'unknown', label: '未判断' }
]

const CONTACT_DECISIONS = [
  { value: 'contact_now', label: '开始建联' },
  { value: 'observe', label: '继续观察' },
  { value: 'skip_for_now', label: '暂不联系' }
]

const POST_QUOTE_DECISIONS = [
  { value: 'repurchase', label: '复投' },
  { value: 'small_test', label: '小额测试' },
  { value: 'negotiate', label: '继续议价' },
  { value: 'pause', label: '暂缓' }
]

const STAGE_LABELS = { contact: '联系前', post_quote: '已拿到报价' }
const IP_LABELS = { strong: '明显', medium: '一般', weak: '较弱', unknown: '未判断' }
const DECISION_LABELS = {
  contact_now: '开始建联',
  observe: '继续观察',
  skip_for_now: '暂不联系',
  repurchase: '复投',
  small_test: '小额测试',
  negotiate: '继续议价',
  pause: '暂缓'
}

const factRowStyle = { display: 'flex', justifyContent: 'space-between', gap: 12 }

/**
 * 决策记录抽屉（V3-alpha P4）
 * - 顶部只读展示「当时看到的事实」：历史证据 / 近期表现 / 星图价格 / CPM30目标价
 * - 人只提交：阶段、IP 判断、人的决定、备注、实际报价原文
 * - 实际报价的 P3 重算由后端 preview 给出（前端不复制公式）
 */
export default function CreatorDecisionDrawer({
  open,
  creatorItem,
  initialView = 'record',
  onClose,
  onSaved
}) {
  const creator = creatorItem?.creator || ''
  // Creator Identity V1 Phase 5：归属锚。雷达传入时决策读/写都按 creator_id 关联
  //（同名不同人绝不串数据）；creator text 仍作为 frozen display snapshot 传给后端。
  const creatorId = creatorItem?.creator_id ?? null
  const snapshot = creatorItem?.recent_snapshot || null
  const [view, setView] = useState(initialView)
  const [stage, setStage] = useState('contact')
  const [ipJudgement, setIpJudgement] = useState('unknown')
  const [humanDecision, setHumanDecision] = useState('')
  const [note, setNote] = useState('')
  // Real Data Calibration V1：业务决策日期（decided_at）。created_at 由服务端记录真实录入时间。
  const [decidedAt, setDecidedAt] = useState(() => todayLocalDateOnly())
  const [quoteRaw, setQuoteRaw] = useState('')
  const [preview, setPreview] = useState(null)
  // 谈价试算器：默认 7 折（区间内价格最高的一档），用户自行向下探索；与「我的决定」互不影响
  const [simulatorRate, setSimulatorRate] = useState(SIMULATOR_DEFAULT_RATE)
  const [previewError, setPreviewError] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedDecision, setSavedDecision] = useState(null)
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  // P5：关联投放结果
  const [linkModalDecision, setLinkModalDecision] = useState(null)
  // A4：谈价结果记录弹窗
  const [negotiationModalDecision, setNegotiationModalDecision] = useState(null)
  // Real Data Calibration V1：业务日期纠正 / 决策作废（append-only 审计，不开放任意字段编辑）
  const [dateCorrectModal, setDateCorrectModal] = useState(null)
  const [dateCorrectValue, setDateCorrectValue] = useState('')
  const [dateCorrectReason, setDateCorrectReason] = useState('')
  const [dateCorrectSaving, setDateCorrectSaving] = useState(false)
  const [voidModal, setVoidModal] = useState(null)
  const [voidReason, setVoidReason] = useState('')
  const [voidSaving, setVoidSaving] = useState(false)
  const [negotiationDateModal, setNegotiationDateModal] = useState(null)
  const [negotiationDateValue, setNegotiationDateValue] = useState('')
  const [negotiationDateReason, setNegotiationDateReason] = useState('')
  const [negotiationDateSaving, setNegotiationDateSaving] = useState(false)
  const [unlinkingId, setUnlinkingId] = useState(null)
  const navigate = useNavigate()

  const loadHistory = useCallback(async () => {
    if (!creator) return
    setHistoryLoading(true)
    try {
      const res = await getCreatorDecisions(creator, creatorId)
      setHistory(Array.isArray(res?.data?.decisions) ? res.data.decisions : [])
    } catch {
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }, [creator, creatorId])

  useEffect(() => {
    if (!open) return
    setView(initialView)
    setStage(snapshot ? 'contact' : 'contact')
    setIpJudgement('unknown')
    setHumanDecision('')
    setNote('')
    setDecidedAt(todayLocalDateOnly())
    setQuoteRaw('')
    setPreview(null)
    setPreviewError('')
    setSaveError('')
    setSavedDecision(null)
    loadHistory()
  }, [open, initialView, loadHistory, snapshot])

  // 切换阶段/报价后，之前的预览结果作废
  useEffect(() => {
    setPreview(null)
    setPreviewError('')
  }, [stage, quoteRaw, snapshot?.id])

  const historical = useMemo(
    () => ({
      record_count: creatorItem?.record_count ?? null,
      valid_cpm_count: creatorItem?.valid_cpm_count ?? null,
      pass_count: creatorItem?.pass_count ?? null,
      historical_status_label: creatorItem?.historical_status_label ?? null,
      median_cpm: creatorItem?.median_cpm ?? null,
      recent_risk: creatorItem?.recent_risk ?? false,
      last_collaboration_date: creatorItem?.last_collaboration_date ?? null,
      days_since_last_collaboration: creatorItem?.days_since_last_collaboration ?? null
    }),
    [creatorItem]
  )

  const canSave =
    Boolean(creator) &&
    Boolean(humanDecision) &&
    !saving &&
    (stage === 'contact' || (Boolean(snapshot?.id) && quoteRaw.trim() !== ''))

  const handlePreview = async () => {
    if (!snapshot?.id) {
      setPreviewError('该达人还没有近期表现快照，无法用实际报价重新核算；请先在雷达里更新近期表现。')
      return
    }
    setPreviewLoading(true)
    setPreviewError('')
    try {
      const res = await previewCreatorDecisionQuote({
        creator,
        snapshotId: snapshot.id,
        currentQuoteRaw: quoteRaw
      })
      setPreview(res?.data || null)
    } catch (error) {
      setPreview(null)
      setPreviewError(
        error?.response?.data?.msg ||
          error?.response?.data?.message ||
          '实际报价无法核算，请按「¥2400 / 2400元 / 2,400」等形式填写'
      )
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setSaveError('')
    try {
      const res = await createCreatorDecision({
        creator,
        // Phase 5：显式携带归属锚（Radar 已拥有 Creator 身份，不再依赖名称解析 / zero-match fallback）
        creator_id: creatorId ?? null,
        decision_stage: stage,
        snapshot_id: snapshot?.id ?? null,
        current_quote_raw: stage === 'post_quote' ? quoteRaw : null,
        ip_judgement: ipJudgement,
        human_decision: humanDecision,
        decision_note: note ? note : null,
        // Real Data Calibration V1：业务决策日期（默认今天；历史补录可显式选择真实日期）
        decided_at: decidedAt
      })
      setSavedDecision(res?.data || null)
      message.success('决策已记录')
      await loadHistory()
      onSaved?.(res?.data || null)
    } catch (error) {
      setSaveError(
        error?.response?.data?.msg ||
          error?.response?.data?.message ||
          '决策保存失败，请稍后重试（输入内容已保留）'
      )
    } finally {
      setSaving(false)
    }
  }

  // ---------- Real Data Calibration V1：业务日期纠正 / 决策作废 / 谈成日期纠正 ----------
  const canCorrectDate =
    Boolean(dateCorrectModal) &&
    isValidDateOnly(dateCorrectValue) &&
    dateCorrectReason.trim() !== '' &&
    !dateCorrectSaving

  const handleCorrectDate = async () => {
    if (!canCorrectDate) return
    setDateCorrectSaving(true)
    try {
      await correctDecisionDate(dateCorrectModal.id, {
        decidedAt: dateCorrectValue,
        reason: dateCorrectReason.trim()
      })
      message.success('业务日期已纠正')
      setDateCorrectModal(null)
      setDateCorrectReason('')
      await loadHistory()
      onSaved?.(null)
    } catch {
      // 失败提示由 request 响应拦截器统一弹出一次；这里保留用户输入，仅复位 loading
    } finally {
      setDateCorrectSaving(false)
    }
  }

  const canVoid = Boolean(voidModal) && voidReason.trim() !== '' && !voidSaving

  const handleVoid = async () => {
    if (!canVoid) return
    setVoidSaving(true)
    try {
      await voidDecision(voidModal.id, { reason: voidReason.trim() })
      message.success('该决策已作废（历史与关联事实保留）')
      setVoidModal(null)
      setVoidReason('')
      await loadHistory()
      onSaved?.(null)
    } catch (error) {
      // 失败提示由 request 响应拦截器统一弹出一次；作废弹窗保留用户输入
    } finally {
      setVoidSaving(false)
    }
  }

  const canCorrectNegotiationDate =
    Boolean(negotiationDateModal) &&
    isValidDateOnly(negotiationDateValue) &&
    negotiationDateReason.trim() !== '' &&
    !negotiationDateSaving

  const handleCorrectNegotiationDate = async () => {
    if (!canCorrectNegotiationDate) return
    setNegotiationDateSaving(true)
    try {
      await correctNegotiationCaseDate(negotiationDateModal.id, {
        negotiatedAt: negotiationDateValue,
        reason: negotiationDateReason.trim()
      })
      message.success('谈成日期已纠正')
      setNegotiationDateModal(null)
      setNegotiationDateReason('')
      await loadHistory()
      onSaved?.(null)
    } catch {
      // 失败提示由 request 响应拦截器统一弹出一次；这里保留用户输入，仅复位 loading
    } finally {
      setNegotiationDateSaving(false)
    }
  }

  const renderFacts = () => (
    <Space direction="vertical" size={6} style={{ display: 'flex' }}>
      <div style={factRowStyle}>
        <Typography.Text type="secondary">达人</Typography.Text>
        <Typography.Text strong>{creator}</Typography.Text>
      </div>
      <Typography.Text strong style={{ marginTop: 4 }}>历史证据（P1）</Typography.Text>
      <div style={factRowStyle}>
        <Typography.Text type="secondary">CPM≤30 达标</Typography.Text>
        <Typography.Text>
          {formatInteger(historical.pass_count)} / {formatInteger(historical.valid_cpm_count)}
        </Typography.Text>
      </div>
      <div style={factRowStyle}>
        <Typography.Text type="secondary">历史中位 CPM</Typography.Text>
        <Typography.Text>{historical.median_cpm === null ? '-' : historical.median_cpm}</Typography.Text>
      </div>
      <div style={factRowStyle}>
        <Typography.Text type="secondary">历史合作 / 状态</Typography.Text>
        <Typography.Text>
          {formatInteger(historical.record_count)} 次 · {historical.historical_status_label || '-'}
        </Typography.Text>
      </div>
      <div style={factRowStyle}>
        <Typography.Text type="secondary">最近合作 / 距今</Typography.Text>
        <Typography.Text>
          {historical.last_collaboration_date || '-'}
          {historical.days_since_last_collaboration === null
            ? ''
            : `（距今 ${formatInteger(historical.days_since_last_collaboration)} 天）`}
        </Typography.Text>
      </div>
      {historical.recent_risk && (
        <Typography.Text type="warning">⚠ 最近 2 次有效累计 CPM 均未达标</Typography.Text>
      )}

      <Typography.Text strong style={{ marginTop: 4 }}>近期表现（P2B）</Typography.Text>
      {snapshot ? (
        <>
          <div style={factRowStyle}>
            <Typography.Text type="secondary">有效样本</Typography.Text>
            <Typography.Text>{formatInteger(snapshot.valid_count)}</Typography.Text>
          </div>
          <div style={factRowStyle}>
            <Typography.Text type="secondary">数据观察日期</Typography.Text>
            <Typography.Text>{snapshot.observed_at || '观察日期未知'}</Typography.Text>
          </div>
          <div style={factRowStyle}>
            <Typography.Text type="secondary">中位播放 / 典型区间</Typography.Text>
            <Typography.Text>
              {formatPlays(snapshot.median_play)}
              {snapshot.p25_play === null || snapshot.p75_play === null
                ? ''
                : `　${formatPlays(snapshot.p25_play)}～${formatPlays(snapshot.p75_play)}`}
            </Typography.Text>
          </div>
          <div style={factRowStyle}>
            <Typography.Text type="secondary">星图刊例价</Typography.Text>
            <Typography.Text>
              {snapshot.xingtu_price === null || snapshot.xingtu_price === undefined
                ? '暂无'
                : formatPrice(snapshot.xingtu_price)}
            </Typography.Text>
          </div>
          <div style={factRowStyle}>
            <Typography.Text type="secondary">CPM30目标价</Typography.Text>
            <Typography.Text>{formatPrice(snapshot.pricing?.target_price)}</Typography.Text>
          </div>
          <div style={factRowStyle}>
            <Typography.Text type="secondary">CPM30参考区间</Typography.Text>
            <Typography.Text>
              {snapshot.pricing?.reference_low === null || snapshot.pricing?.reference_high === null
                ? '-'
                : `${formatPrice(snapshot.pricing.reference_low)}～${formatPrice(snapshot.pricing.reference_high)}`}
            </Typography.Text>
          </div>
        </>
      ) : (
        <Typography.Text type="secondary">尚无近期表现快照（联系前决策可不依赖）</Typography.Text>
      )}
    </Space>
  )

  const renderDecisionButtons = (options) => (
    <Radio.Group value={humanDecision} onChange={(event) => setHumanDecision(event.target.value)}>
      <Space wrap>
        {options.map((item) => (
          <Radio.Button key={item.value} value={item.value}>
            {item.label}
          </Radio.Button>
        ))}
      </Space>
    </Radio.Group>
  )

  const renderPreview = () => {
    if (previewError) return <Alert type="error" showIcon message={previewError} />
    if (!preview) return null
    const pricing = preview.xingtu_pricing
    const assessment = preview.current_quote_assessment
    return (
      <Space direction="vertical" size={4} style={{ display: 'flex' }}>
        <div style={factRowStyle}>
          <Typography.Text type="secondary">星图刊例</Typography.Text>
          <Typography.Text>{formatPrice(preview.xingtu_price)}</Typography.Text>
        </div>
        <div style={factRowStyle}>
          <Typography.Text type="secondary">实际报价</Typography.Text>
          <Typography.Text strong>{formatPrice(assessment?.current_quote)}</Typography.Text>
        </div>
        <div style={factRowStyle}>
          <Typography.Text type="secondary">约为星图</Typography.Text>
          <Typography.Text>
            {assessment?.actual_vs_xingtu_zhe === null || assessment?.actual_vs_xingtu_zhe === undefined
              ? '（无星图价，无法比较）'
              : formatZhe(assessment.actual_vs_xingtu_zhe)}
          </Typography.Text>
        </div>
        <div style={factRowStyle}>
          <Typography.Text type="secondary">CPM30目标价 / 参考区间</Typography.Text>
          <Typography.Text>
            {formatPrice(pricing?.target_price)}　
            {pricing?.reference_low === null || pricing?.reference_high === null
              ? ''
              : `${formatPrice(pricing.reference_low)}～${formatPrice(pricing.reference_high)}`}
          </Typography.Text>
        </div>
        <div style={factRowStyle}>
          <Typography.Text type="secondary">距进入参考区间</Typography.Text>
          <Typography.Text>
            {assessment?.gap_to_reference_high === 0
              ? '已进入参考区间'
              : `还需下降 ${formatPrice(assessment?.gap_to_reference_high)}`}
          </Typography.Text>
        </div>
        <div style={factRowStyle}>
          <Typography.Text type="secondary">距 CPM30目标价</Typography.Text>
          <Typography.Text>
            {assessment?.gap_to_target === 0
              ? '已达到目标价'
              : `还需下降 ${formatPrice(assessment?.gap_to_target)}`}
          </Typography.Text>
        </div>
        <Alert
          type="info"
          showIcon
          message={assessment?.negotiation_range_status_label || '-'}
          description={assessment?.current_quote_status_label || '-'}
        />
      </Space>
    )
  }

  /** 谈价试算器（what-if，纯前端展示计算，不写库、不影响「我的决定」） */
  const renderSimulator = () => {
    const xingtuPrice = snapshot?.xingtu_price ?? null
    const pricing = snapshot?.pricing || null
    const simulation = simulateNegotiation({
      xingtuPrice,
      medianPlay: snapshot?.median_play ?? null,
      targetPrice: pricing?.target_price ?? null,
      referenceHigh: pricing?.reference_high ?? null,
      rate: simulatorRate
    })
    return (
      <Space direction="vertical" size={6} style={{ display: 'flex' }}>
        <Typography.Text strong>谈价试算（2～7折，仅供自行探索）</Typography.Text>
        {!simulation.available ? (
          <Alert type="warning" showIcon message={simulation.unavailable_label} />
        ) : (
          <>
            <Space size={8} wrap>
              <Typography.Text type="secondary">{formatSimulatorZhe(SIMULATOR_MIN_RATE)}</Typography.Text>
              <Slider
                min={SIMULATOR_MIN_RATE * 100}
                max={SIMULATOR_MAX_RATE * 100}
                step={SIMULATOR_STEP_RATE * 100}
                value={simulatorRate * 100}
                onChange={(value) => setSimulatorRate(Number((value / 100).toFixed(2)))}
                style={{ width: 220 }}
              />
              <Typography.Text type="secondary">{formatSimulatorZhe(SIMULATOR_MAX_RATE)}</Typography.Text>
              <Tag color="blue">{simulation.zhe_label}</Tag>
            </Space>
            <div style={factRowStyle}>
              <Typography.Text type="secondary">按 {simulation.zhe_label}：</Typography.Text>
              <Typography.Text strong>{formatPrice(simulation.price)}</Typography.Text>
            </div>
            <div style={factRowStyle}>
              <Typography.Text type="secondary">对应近期中位播放</Typography.Text>
              <Typography.Text>{formatPlays(snapshot?.median_play)}</Typography.Text>
            </div>
            <div style={factRowStyle}>
              <Typography.Text type="secondary">对应 CPM</Typography.Text>
              <Typography.Text>{simulation.cpm === null ? '-' : simulation.cpm}</Typography.Text>
            </div>
            <Typography.Text>{simulation.status_label}</Typography.Text>
          </>
        )}
        <div style={factRowStyle}>
          <Typography.Text type="secondary">进入参考区间</Typography.Text>
          <Typography.Text>
            {pricing?.entry_discount_zhe === null || pricing?.entry_discount_zhe === undefined
              ? '-'
              : `≤${formatZhe(pricing.entry_discount_zhe)}`}
          </Typography.Text>
        </div>
        <div style={factRowStyle}>
          <Typography.Text type="secondary">CPM30目标</Typography.Text>
          <Typography.Text>
            {pricing?.target_discount_zhe === null || pricing?.target_discount_zhe === undefined
              ? '-'
              : `≈${formatZhe(pricing.target_discount_zhe)}`}
          </Typography.Text>
        </div>
      </Space>
    )
  }

  // P5：只有「已拿到报价 + 决定实际投放」的决策才允许关联真实投放结果
  const isOutcomeEligible = (item) =>
    item?.decision_stage === 'post_quote' && ['repurchase', 'small_test'].includes(item?.human_decision)

  const handleUnlink = (item) => {
    Modal.confirm({
      title: '解除关联',
      content: '仅解除决策与投放结果的关联，不会删除任何投放数据或决策记录。',
      okText: '解除关联',
      cancelText: '取消',
      onOk: async () => {
        setUnlinkingId(item.id)
        try {
          await unlinkDecisionOutcome(item.id)
          message.success('已解除关联')
          await loadHistory()
          onSaved?.(null)
        } catch (error) {
          // 失败提示由 request 拦截器统一弹出一次；异常继续抛出，让确认框保持打开
          throw error
        } finally {
          setUnlinkingId(null)
        }
      }
    })
  }

  /** 投放结果区块：live 事实（关联后随 creator_records 实时变化），不展示任何评价 */
  const renderOutcomeSection = (item) => {
    if (!isOutcomeEligible(item)) {
      return (
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            该决策未进入实际投放阶段。
          </Typography.Text>
        </div>
      )
    }
    const outcome = item.outcome
    if (!outcome) {
      return (
        <div style={{ marginTop: 8 }}>
          <Space size={8} wrap>
            <Typography.Text type="secondary">投放结果</Typography.Text>
            <Typography.Text type="secondary">尚未关联</Typography.Text>
            <Button size="small" onClick={() => setLinkModalDecision(item)}>
              关联投放结果
            </Button>
          </Space>
        </div>
      )
    }
    const pending = outcome.latest_status === 'pending'
    const anomaly = outcome.latest_status === 'anomaly'
    return (
      <div style={{ marginTop: 8, borderTop: '1px dashed #f0f0f0', paddingTop: 8 }}>
        <Typography.Text strong style={{ fontSize: 12 }}>投放结果</Typography.Text>
        <Space direction="vertical" size={2} style={{ display: 'flex', marginTop: 4 }}>
          <div style={factRowStyle}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>发布日期</Typography.Text>
            <Typography.Text style={{ fontSize: 12 }}>{outcome.publish_date || '-'}</Typography.Text>
          </div>
          <div style={factRowStyle}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>实际花费</Typography.Text>
            <Typography.Text style={{ fontSize: 12 }}>{formatMoney(outcome.total_cost, '-')}</Typography.Text>
          </div>
          <div style={factRowStyle}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>7日播放</Typography.Text>
            <Typography.Text style={{ fontSize: 12 }}>{formatPlays(outcome.first_play)}</Typography.Text>
          </div>
          <div style={factRowStyle}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>累计播放</Typography.Text>
            <Typography.Text style={{ fontSize: 12 }}>
              {pending ? '待更新' : formatPlays(outcome.latest_play)}
            </Typography.Text>
          </div>
          <div style={factRowStyle}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>后续新增</Typography.Text>
            <Typography.Text style={{ fontSize: 12 }}>
              {pending || anomaly ? '待更新' : formatPlays(outcome.subsequent_play)}
            </Typography.Text>
          </div>
          <div style={factRowStyle}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>7日CPM</Typography.Text>
            <Typography.Text style={{ fontSize: 12 }}>{formatCpm(outcome.first_cpm)}</Typography.Text>
          </div>
          <div style={factRowStyle}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>累计CPM</Typography.Text>
            <Typography.Text style={{ fontSize: 12 }}>
              {pending || anomaly ? '待更新' : formatCpm(outcome.latest_cpm)}
            </Typography.Text>
          </div>
          <div style={factRowStyle}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>CPM30状态</Typography.Text>
            <Typography.Text style={{ fontSize: 12 }}>{outcome.target_cpm_status_label}</Typography.Text>
          </div>
        </Space>
        <Space size={8} wrap style={{ marginTop: 6 }}>
          <Button size="small" type="link" onClick={() => navigate(`/records?keyword=${encodeURIComponent(creator)}`)}>
            查看投放记录
          </Button>
          <Button size="small" danger loading={unlinkingId === item.id} onClick={() => handleUnlink(item)}>
            解除关联
          </Button>
        </Space>
      </div>
    )
  }

  // A4：只有「已拿到报价 + 继续议价 / 复投 / 小额测试」的决策才记录谈价结果
  const isNegotiationEligible = (item) =>
    item?.decision_stage === 'post_quote' && ['negotiate', 'repurchase', 'small_test'].includes(item?.human_decision)

  /** 谈价结果区块：只展示事实（谈成价 / 日期 / 相对星图 / 相对报价 / 原因 / 备注），不评价谈判质量 */
  const renderNegotiationSection = (item) => {
    if (!isNegotiationEligible(item)) return null
    const negotiationCase = item.negotiation_case
    if (!negotiationCase) {
      return (
        <div style={{ marginTop: 8 }}>
          <Space size={8} wrap>
            <Typography.Text type="secondary">谈价结果</Typography.Text>
            <Typography.Text type="secondary">尚未记录</Typography.Text>
            <Button size="small" onClick={() => setNegotiationModalDecision(item)}>
              记录谈价结果
            </Button>
          </Space>
        </div>
      )
    }
    const rows = buildNegotiationPriceRows(negotiationCase)
    const tags = (negotiationCase.reason_tags || []).map(
      (tag) => NEGOTIATION_REASON_TAG_LABELS[tag] || tag
    )
    return (
      <div style={{ marginTop: 8, borderTop: '1px dashed #f0f0f0', paddingTop: 8 }}>
        <Typography.Text strong style={{ fontSize: 12 }}>谈价结果</Typography.Text>
        <Space direction="vertical" size={2} style={{ display: 'flex', marginTop: 4 }}>
          {rows.map((row) => (
            <div key={row.label} style={factRowStyle}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.label}</Typography.Text>
              <Typography.Text style={{ fontSize: 12 }}>{row.value}</Typography.Text>
            </div>
          ))}
          {tags.length > 0 && (
            <div style={factRowStyle}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>原因</Typography.Text>
              <Typography.Text style={{ fontSize: 12 }}>{tags.join(' · ')}</Typography.Text>
            </div>
          )}
          {negotiationCase.reason_note && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              备注：{negotiationCase.reason_note}
            </Typography.Text>
          )}
          {negotiationCase.strategy_note && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              谈价依据：{negotiationCase.strategy_note}
            </Typography.Text>
          )}
        </Space>
        {!item.voided_at && (
          <Button
            size="small"
            style={{ marginTop: 6 }}
            onClick={() => {
              setNegotiationDateModal(negotiationCase)
              setNegotiationDateValue(negotiationCase.negotiated_at || todayLocalDateOnly())
              setNegotiationDateReason('')
            }}
          >
            纠正谈成日期
          </Button>
        )}
      </div>
    )
  }

  const renderHistory = () => (
    <Spin spinning={historyLoading}>
      {history.length === 0 ? (
        <Empty description="暂无决策记录" />
      ) : (
        <Space direction="vertical" size={10} style={{ display: 'flex' }}>
          {history.map((item) => (
            <div key={item.id} style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
              <Space size={8} wrap>
                <Typography.Text strong>
                  {item.voided_at ? '已作废 · ' : ''}
                  {item.decided_at || '业务日期未补'}
                </Typography.Text>
                <Tag>{STAGE_LABELS[item.decision_stage] || item.decision_stage}</Tag>
                {item.current_quote !== null && <Tag color="blue">实际报价 {formatPrice(item.current_quote)}</Tag>}
                <Tag color="green">{item.human_decision_label || DECISION_LABELS[item.human_decision]}</Tag>
                <Tag>个人IP：{IP_LABELS[item.ip_judgement] || '未判断'}</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  录入于 {String(item.created_at || '').slice(0, 16)}
                </Typography.Text>
                {!item.voided_at && (
                  <>
                    <Button
                      size="small"
                      onClick={() => {
                        setDateCorrectModal(item)
                        setDateCorrectValue(item.decided_at || todayLocalDateOnly())
                        setDateCorrectReason('')
                      }}
                    >
                      纠正日期
                    </Button>
                    <Button
                      size="small"
                      danger
                      onClick={() => {
                        setVoidModal(item)
                        setVoidReason('')
                      }}
                    >
                      删除记录
                    </Button>
                  </>
                )}
              </Space>
              {item.voided_at && (
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                  作废原因：{item.void_reason || '-'} · 作废于 {String(item.voided_at || '').slice(0, 16)}
                </Typography.Text>
              )}
              {item.decision_note && (
                <div style={{ marginTop: 6 }}>
                  <Typography.Text type="secondary">{item.decision_note}</Typography.Text>
                </div>
              )}
              {item.pricing_evidence?.current_quote_assessment && (
                <div style={{ marginTop: 6 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    报价状态（记录时）：{item.pricing_evidence.current_quote_assessment.current_quote_status_label}
                  </Typography.Text>
                </div>
              )}
              {renderOutcomeSection(item)}
              {renderNegotiationSection(item)}
            </div>
          ))}
        </Space>
      )}
    </Spin>
  )

  return (
    <Drawer
      title={view === 'history' ? `${creator} · 决策记录` : `${creator} · 记录决策`}
      width={560}
      open={open}
      onClose={onClose}
      destroyOnClose
    >
      {view === 'history' ? (
        <Space direction="vertical" size={12} style={{ display: 'flex' }}>
          <Button size="small" onClick={() => setView('record')}>
            返回记录决策
          </Button>
          {renderHistory()}
        </Space>
      ) : (
        <Space direction="vertical" size={12} style={{ display: 'flex' }}>
          {renderFacts()}

          <Divider style={{ margin: '4px 0' }} />
          <Typography.Text strong>决策阶段</Typography.Text>
          <Radio.Group value={stage} onChange={(event) => setStage(event.target.value)}>
            <Space wrap>
              <Radio.Button value="contact">联系前</Radio.Button>
              <Radio.Button value="post_quote" disabled={!snapshot?.id}>
                <Tooltip title={snapshot?.id ? '' : '该达人还没有近期表现快照'}>已拿到报价</Tooltip>
              </Radio.Button>
            </Space>
          </Radio.Group>

          {stage === 'post_quote' && (
            <>
              <Typography.Text strong>实际最新报价（与星图刊例价分开记录）</Typography.Text>
              <Space wrap>
                <Input
                  value={quoteRaw}
                  placeholder="例如 ¥2400 / 2400元 / 2,400"
                  style={{ width: 220 }}
                  onChange={(event) => setQuoteRaw(event.target.value)}
                  onPressEnter={handlePreview}
                />
                <Button onClick={handlePreview} loading={previewLoading}>
                  核算实际报价
                </Button>
              </Space>
              {renderPreview()}
              {renderSimulator()}
            </>
          )}

          <Typography.Text strong>个人内容 IP 判断（由人填写）</Typography.Text>
          <Radio.Group value={ipJudgement} onChange={(event) => setIpJudgement(event.target.value)}>
            <Space wrap>
              {IP_OPTIONS.map((item) => (
                <Radio.Button key={item.value} value={item.value}>
                  {item.label}
                </Radio.Button>
              ))}
            </Space>
          </Radio.Group>

          <Typography.Text strong>我的决定</Typography.Text>
          {stage === 'contact'
            ? renderDecisionButtons(CONTACT_DECISIONS)
            : renderDecisionButtons(POST_QUOTE_DECISIONS)}

          <Typography.Text strong>备注（可选）</Typography.Text>
          <Input.TextArea
            value={note}
            rows={2}
            maxLength={500}
            placeholder="例如：内容有强人设，商单融入比较自然"
            onChange={(event) => setNote(event.target.value)}
          />

          <div>
            <Typography.Text strong>业务决策日期</Typography.Text>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
              <DatePicker
                value={decidedAt ? dayjs(decidedAt) : null}
                format="YYYY-MM-DD"
                allowClear={false}
                style={{ width: 180 }}
                onChange={(value) => setDecidedAt(value ? value.format('YYYY-MM-DD') : '')}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                历史补录请填写真实决策日期；系统录入时间会自动保留。
              </Typography.Text>
            </div>
          </div>

          <Space size={12} wrap>
            <Button type="primary" disabled={!canSave} loading={saving} onClick={handleSave}>
              保存决策
            </Button>
            <Button onClick={() => setView('history')}>查看决策记录</Button>
          </Space>

          {saveError && <Alert type="error" showIcon message={saveError} />}

          {savedDecision && (
            <Alert
              type="success"
              showIcon
              message="决策已记录"
              description={
                <Space direction="vertical" size={2}>
                    <Typography.Text>{savedDecision.decided_at || '业务日期未补'}</Typography.Text>
                    <Typography.Text type="secondary">
                      录入于 {String(savedDecision.created_at || '').slice(0, 16)}
                    </Typography.Text>
                  <Typography.Text>
                    {STAGE_LABELS[savedDecision.decision_stage] || savedDecision.decision_stage}
                    {savedDecision.current_quote === null
                      ? ''
                      : ` · 实际报价 ${formatPrice(savedDecision.current_quote)}`}
                  </Typography.Text>
                  <Typography.Text>
                    个人IP：{IP_LABELS[savedDecision.ip_judgement] || '未判断'} · 决定：
                    {savedDecision.human_decision_label || savedDecision.human_decision}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    该记录已固化当时的证据与价格口径（{savedDecision.pricing_version}），不会随未来数据变化。
                  </Typography.Text>
                </Space>
              }
            />
          )}

          <Divider style={{ margin: '4px 0' }} />
          <Space size={8} wrap>
            <Typography.Text strong>最近决策</Typography.Text>
            {history[0] ? (
              <Typography.Text type="secondary">
                {history[0].decided_at || String(history[0].created_at || '').slice(5, 10)} ·{' '}
                {history[0].human_decision_label}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary">暂无</Typography.Text>
            )}
          </Space>
        </Space>
      )}

      <OutcomeLinkModal
        open={Boolean(linkModalDecision)}
        decision={linkModalDecision}
        onClose={() => setLinkModalDecision(null)}
        onLinked={async () => {
          await loadHistory()
          onSaved?.(null)
        }}
      />

      <NegotiationCaseModal
        open={Boolean(negotiationModalDecision)}
        decision={negotiationModalDecision}
        onClose={() => setNegotiationModalDecision(null)}
        onSaved={async () => {
          await loadHistory()
          onSaved?.(null)
        }}
      />

      {/* Real Data Calibration V1：业务日期纠正（append-only 审计；只改 decided_at） */}
      <Modal
        title={`纠正业务日期 · ${dateCorrectModal?.creator || creator}`}
        open={Boolean(dateCorrectModal)}
        onCancel={() => setDateCorrectModal(null)}
        footer={
          <Space>
            <Button onClick={() => setDateCorrectModal(null)}>取消</Button>
            <Button type="primary" disabled={!canCorrectDate} loading={dateCorrectSaving} onClick={handleCorrectDate}>
              保存纠正
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={10} style={{ display: 'flex' }}>
          <Alert
            type="info"
            showIcon
            message="纠正的是「业务决策日期」，不会改动系统录入时间、达人归属与任何证据。"
          />
          <div>
            <Typography.Text type="secondary">业务决策日期</Typography.Text>
            <div style={{ marginTop: 4 }}>
              <DatePicker
                value={dateCorrectValue ? dayjs(dateCorrectValue) : null}
                format="YYYY-MM-DD"
                allowClear={false}
                style={{ width: 180 }}
                onChange={(value) => setDateCorrectValue(value ? value.format('YYYY-MM-DD') : '')}
              />
            </div>
          </div>
          <div>
            <Typography.Text type="secondary">纠正原因（必填，会保留在审计记录中）</Typography.Text>
            <Input.TextArea
              value={dateCorrectReason}
              rows={2}
              maxLength={500}
              placeholder="例如：这条决策是 8 月谈完后补录的，当时填成了今天。"
              onChange={(event) => setDateCorrectReason(event.target.value)}
            />
          </div>
        </Space>
      </Modal>

      {/* VOID：作废决策（不删除任何下游事实） */}
      <Modal
        title={`删除记录 · ${voidModal?.creator || creator}`}
        open={Boolean(voidModal)}
        onCancel={() => setVoidModal(null)}
        footer={
          <Space>
            <Button onClick={() => setVoidModal(null)}>取消</Button>
            <Button type="primary" danger disabled={!canVoid} loading={voidSaving} onClick={handleVoid}>
              作废该决策
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={10} style={{ display: 'flex' }}>
          <Alert
            type="warning"
            showIcon
            message="该操作会作废记录，不会删除历史投放事实。"
            description="决策行、达人归属、已关联的谈价 / 投放结果都会保留，只是不再参与「最近决策」与业务排序，并会在历史中标记「已作废」。"
          />
          <div>
            <Typography.Text type="secondary">作废原因（必填）</Typography.Text>
            <Input.TextArea
              value={voidReason}
              rows={2}
              maxLength={500}
              placeholder="例如：同一件事重复录了一条。"
              onChange={(event) => setVoidReason(event.target.value)}
            />
          </div>
        </Space>
      </Modal>

      {/* 谈成日期纠正（append-only 审计；只改 negotiated_at） */}
      <Modal
        title={`纠正谈成日期 · ${negotiationDateModal?.creator || creator}`}
        open={Boolean(negotiationDateModal)}
        onCancel={() => setNegotiationDateModal(null)}
        footer={
          <Space>
            <Button onClick={() => setNegotiationDateModal(null)}>取消</Button>
            <Button
              type="primary"
              disabled={!canCorrectNegotiationDate}
              loading={negotiationDateSaving}
              onClick={handleCorrectNegotiationDate}
            >
              保存纠正
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={10} style={{ display: 'flex' }}>
          <Alert
            type="info"
            showIcon
            message="纠正的是「谈成日期」，不会改动谈成价、星图价、报价快照与任何关联事实。"
          />
          <div>
            <Typography.Text type="secondary">谈成日期</Typography.Text>
            <div style={{ marginTop: 4 }}>
              <DatePicker
                value={negotiationDateValue ? dayjs(negotiationDateValue) : null}
                format="YYYY-MM-DD"
                allowClear={false}
                style={{ width: 180 }}
                onChange={(value) => setNegotiationDateValue(value ? value.format('YYYY-MM-DD') : '')}
              />
            </div>
          </div>
          <div>
            <Typography.Text type="secondary">纠正原因（必填，会保留在审计记录中）</Typography.Text>
            <Input.TextArea
              value={negotiationDateReason}
              rows={2}
              maxLength={500}
              placeholder="例如：谈成日期应为 2026-08-20，录入时默认成了今天。"
              onChange={(event) => setNegotiationDateReason(event.target.value)}
            />
          </div>
        </Space>
      </Modal>
    </Drawer>
  )
}
