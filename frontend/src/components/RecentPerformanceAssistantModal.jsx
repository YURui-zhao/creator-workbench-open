import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Divider,
  Empty,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd'
import dayjs from 'dayjs'
import {
  DeleteOutlined,
  FileImageOutlined,
  InboxOutlined,
  ReloadOutlined,
  SendOutlined
} from '@ant-design/icons'
import { extractCreatorScreenshot, getAiStatus } from '../api/ai'
import { getLatestRecentSnapshot, saveRecentSnapshot } from '../api/recentSnapshots'
import { getCandidateLatestSnapshot, saveCandidateRecentSnapshot } from '../api/creatorCandidates'
import { getAiConfig } from '../utils/aiConfig.js'
import { getErrorMessage } from '../utils/request'
import { formatInteger, formatPlays } from '../utils/format'
import {
  buildSnapshotPayload,
  canSaveSnapshot,
  countRequiredConfirmations,
  formatPlayRange,
  formatTrendRatio,
  getIdentityCheckState,
  getPriceFieldStatus,
  IDENTITY_STATUS,
  isValidDateOnly,
  PRICE_FIELD_STATUS,
  PRICE_FIELD_STATUS_LABELS,
  todayLocalDateOnly,
  TREND_LABELS_FULL
} from '../utils/recentPerformanceSave.js'
import { buildPricingRows } from '../utils/pricingDisplay.js'
import {
  IMAGE_ACCEPT_ATTR,
  MAX_IMAGE_BYTES,
  MAX_SCREENSHOT_COUNT,
  formatBytes,
  prepareImageFile,
  releasePreview,
  validateSelection,
  validateTotalBytes
} from '../utils/screenshotImage.js'
import {
  buildDraftFromManualPlays,
  buildDraftFromSnapshot,
  buildConfirmedDraft,
  buildDraftFromExtraction,
  splitManualPlayLines,
  summarizeDraft,
  togglePlayExcluded,
  updatePlayContentType,
  updatePlayRawText,
  updatePriceRawText
} from '../utils/recentPerformanceDraft.js'
import { CONTENT_TYPE_OPTIONS, normalizeContentType } from '../utils/contentType.js'

const SEND_NOTICE =
  '将向当前配置的 AI 服务发送所选截图，用于识别：达人昵称、星图刊例价、作品播放量。原图不会作为业务记录长期保存。'
const ORDER_NOTICE =
  '请确认作品顺序是否为从旧到新（时间向下推进，最新一条在最后）；如截图包含置顶或重复作品，可排除对应项。'
const SAVE_NOTICE = '将保存结构化播放数据与统计结果，不保存原截图。'

/**
 * 近期表现助手（V3-alpha P2A）
 * - 选择 / 拖拽 / 粘贴截图后只在本地预览，绝不自动上传
 * - 只有用户显式点击「开始 AI 识别」才会向 AI 发送截图
 * - AI 只返回可见事实；数值由确定性解析器换算，用户可逐条修改 / 排除
 * - 确认识别结果只在生成前端草稿，P2A 不写数据库、不估值、不给复投建议
 */
export default function RecentPerformanceAssistantModal({
  open,
  onCancel,
  onConfirmed,
  onSaved,
  creator = null,
  creatorOptions = [],
  // Creator Identity V1 Phase 5：归属锚。传入时快照读写按 creator_id 关联（同名不同人不串数据）；
  // 未传（老调用方）时保持原有 creator 文本行为。
  creatorId = null,
  // Alpha.3-04B：'update'（更新近期表现，全能力）/ 'classify_existing'（只补内容分类）
  mode = 'update',
  // V3-alpha.3 Playbook Phase 1：候选达人稳定身份。传入时走候选 snapshot API（按 candidate_id 归属），
  // 历史 Radar 调用不传该参数，行为完全不变。
  candidateId = null
}) {
  const [images, setImages] = useState([])
  const [preparing, setPreparing] = useState(false)
  const [prepareError, setPrepareError] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [draft, setDraft] = useState(null)
  const [confirmed, setConfirmed] = useState(null)
  // P2B：快照必须绑定到用户点击的雷达达人（header 入口需先选择达人）
  const [boundCreator, setBoundCreator] = useState('')
  // Phase 5：用户从下拉里选择的达人身份（与 boundCreator 成对出现）
  const [boundCreatorId, setBoundCreatorId] = useState(null)
  const [identityConfirmed, setIdentityConfirmed] = useState(false)
  // Alpha.2：数据观察日期（默认浏览器本地今天；用户可改为截图实际观察的那天）
  const [observedAt, setObservedAt] = useState(() => todayLocalDateOnly())
  // Alpha.2 A2：身份「已核对」只做短暂提示，不长期占位；AI 详情默认折叠
  const [identityFlash, setIdentityFlash] = useState(false)
  const [warningsExpanded, setWarningsExpanded] = useState(false)
  const [priceManuallyEdited, setPriceManuallyEdited] = useState(false)
  // Alpha.2 A3：入口模式（截图 AI 识别 / 手工录入），手工模式不依赖 AI
  const [entryMode, setEntryMode] = useState('screenshot')
  const [manualText, setManualText] = useState('')
  const [manualError, setManualError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedSnapshot, setSavedSnapshot] = useState(null)
  const [aiStatus, setAiStatus] = useState({ checked: false, available: false, visionModel: null, visionAvailable: false, providerLabel: '' })
  const [dragging, setDragging] = useState(false)
  // Alpha.3-04B：补充分类模式（预加载已有快照；只允许改 content_type）
  const [classifyLoading, setClassifyLoading] = useState(false)
  const [classifyError, setClassifyError] = useState('')
  const isClassifyMode = mode === 'classify_existing'
  // 候选模式：存在稳定 candidateId 时，保存 / 读取都走候选 API（绝不按名称匹配）
  const isCandidateMode = candidateId !== null && candidateId !== undefined && candidateId !== ''
  // Phase 5：达人选择器选项（支持 { value, label, creator, creator_id } 对象；字符串保持兼容）
  const creatorOptionItems = (Array.isArray(creatorOptions) ? creatorOptions : []).map((item) => {
    if (item && typeof item === 'object') {
      return {
        value: item.value ?? item.creator ?? '',
        label: item.label ?? item.creator ?? '',
        creator: item.creator ?? item.label ?? '',
        creator_id: item.creator_id ?? null
      }
    }
    return { value: item, label: item, creator: item, creator_id: null }
  })
  // 本次读写使用的归属锚：行内入口固定 creatorId；全局入口取用户所选达人的身份
  const effectiveCreatorId = creator ? creatorId ?? null : boundCreatorId ?? null
  const inputRef = useRef(null)
  // 并发保护：识别进行中禁止重复点击（同一次请求不会被叠加）
  const aiInFlightRef = useRef(false)

  // 打开时绑定达人：由行内入口传入；header 入口为空，需要用户显式选择
  useEffect(() => {
    if (!open) return
    setBoundCreator(String(creator ?? '').trim())
    setBoundCreatorId(creator ? creatorId ?? null : null)
    setIdentityConfirmed(false)
    setObservedAt(todayLocalDateOnly())
    setSaveError('')
    setSavedSnapshot(null)
    setClassifyError('')
    setClassifyLoading(false)
    setDraft(null)
    setConfirmed(null)
    if (mode !== 'classify_existing') return
    // Alpha.3-04B：补充分类 —— 直接读取该达人 latest snapshot，预加载已有播放数据
    const targetCreator = String(creator ?? '').trim()
    if (!targetCreator) {
      setClassifyError('未找到可补充分类的近期快照')
      return
    }
    let active = true
    setClassifyLoading(true)
    // 候选模式按 candidate_id 读取（不退回名称匹配）；历史模式行为不变
    const latestRequest = isCandidateMode
      ? getCandidateLatestSnapshot(candidateId)
      : getLatestRecentSnapshot(targetCreator, effectiveCreatorId)
    latestRequest
      .then((res) => {
        if (!active) return
        const snapshot = res?.data?.snapshot || null
        if (!snapshot || !Array.isArray(snapshot.plays) || snapshot.plays.length === 0) {
          setClassifyError('未找到可补充分类的近期快照')
          return
        }
        const nextDraft = buildDraftFromSnapshot(snapshot)
        setDraft(nextDraft)
        // observation 日期继承旧快照（补分类不是一次新的观察）
        if (isValidDateOnly(nextDraft.observed_at)) setObservedAt(nextDraft.observed_at)
      })
      .catch(() => {
        if (active) setClassifyError('未找到可补充分类的近期快照')
      })
      .finally(() => {
        if (active) setClassifyLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, creator, mode, candidateId, isCandidateMode])

  // 打开时读取 AI 状态（只查后端环境变量与固定 vision 模型，不发送 Key/图片）
  useEffect(() => {
    if (!open) return
    // Alpha.3-04B：补充分类模式不需要任何 AI 能力（也不探测 AI 状态）
    if (isClassifyMode) return
    let active = true
    getAiStatus()
      .then((res) => {
        if (!active) return
        setAiStatus({
          checked: true,
          available: Boolean(res?.data?.available),
          providerLabel: res?.data?.providerLabel || '',
          visionModel: res?.data?.visionModel || null,
          visionAvailable: Boolean(res?.data?.visionAvailable)
        })
      })
      .catch(() => {
        if (active) {
          setAiStatus({ checked: true, available: false, providerLabel: '', visionModel: null, visionAvailable: false })
        }
      })
    return () => {
      active = false
    }
  }, [open])

  const resetAll = useCallback(() => {
    setImages((list) => {
      list.forEach(releasePreview)
      return []
    })
    setPreparing(false)
    setPrepareError('')
    setAiError('')
    setAiLoading(false)
    setDraft(null)
    setConfirmed(null)
    setIdentityConfirmed(false)
    setIdentityFlash(false)
    setWarningsExpanded(false)
    setPriceManuallyEdited(false)
    setManualText('')
    setManualError('')
    setSaveError('')
    setSavedSnapshot(null)
    aiInFlightRef.current = false
  }, [])

  const handleClose = () => {
    if (aiLoading) return
    resetAll()
    onCancel?.()
  }

  /**
   * Alpha.3-04B「补充分类」保存：append-only
   * - 播放量 / raw_text / excluded / 顺序 全部来自旧快照（只读，用户没改过）
   * - 只替换用户本次确认的 content_type
   * - observed_at 继承旧快照（补分类不是一次新的观察）
   * - 不发 AI、不写旧快照；新增一条 status/price 等事实继承的新快照
   */
  const handleClassifySave = async () => {
    if (saving) return
    if (!draft || !Array.isArray(draft.plays) || draft.plays.length === 0) {
      message.warning('未找到可补充分类的近期快照')
      return
    }
    if (!boundCreator) {
      message.warning('缺少达人信息，无法保存分类')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      const payload = buildSnapshotPayload(draft, {
        creator: boundCreator,
        // 快照本来就属于该达人：身份核对沿用原快照事实，不再让用户重复确认
        identityConfirmed: true,
        observedAt: isValidDateOnly(draft.observed_at) ? draft.observed_at : ''
      })
      // Phase 5：带归属锚时显式声明 creator_id（绝不靠名称二次解析）
      if (effectiveCreatorId !== null) payload.creator_id = effectiveCreatorId
      // 候选模式走候选 API（服务端用 candidate.name 作为 creator，并落 candidate_id）
      const res = isCandidateMode
        ? await saveCandidateRecentSnapshot(candidateId, payload)
        : await saveRecentSnapshot(payload)
      setSavedSnapshot(res?.data || null)
      onSaved?.(res?.data || null)
      message.success('内容分类已保存为新的快照')
      // 补充分类保存成功后关闭该模式（Radar / 工作区由 onSaved → loadRadar 刷新）
      onCancel?.()
    } catch (error) {
      setSaveError(getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const totalBytes = useMemo(
    () => images.reduce((sum, image) => sum + (image.bytes || 0), 0),
    [images]
  )

  // 添加图片：只做本地校验 + 本地压缩 + 预览；绝不触发 AI
  const addFiles = useCallback(
    async (fileList) => {
      const files = Array.from(fileList || [])
      if (!files.length) return
      setPrepareError('')
      let currentCount = 0
      setImages((list) => {
        currentCount = list.length
        return list
      })
      const countCheck = validateSelection(files.length, currentCount)
      if (!countCheck.ok) {
        setPrepareError(countCheck.reason)
        return
      }

      setPreparing(true)
      const accepted = []
      let failure = ''
      for (const file of files) {
        const result = await prepareImageFile(file)
        if (!result.ok) {
          failure = result.reason
          break
        }
        if (result.image.oversize) {
          releasePreview(result.image)
          failure = `${file.name || '图片'} 压缩后仍超过 ${formatBytes(MAX_IMAGE_BYTES)}，请先裁剪或降低分辨率`
          break
        }
        accepted.push(result.image)
      }
      setPreparing(false)

      if (failure) {
        accepted.forEach(releasePreview)
        setPrepareError(failure)
        return
      }
      setImages((list) => {
        const next = [...list, ...accepted]
        const totalCheck = validateTotalBytes(next.reduce((sum, image) => sum + (image.bytes || 0), 0))
        if (!totalCheck.ok) {
          setPrepareError(totalCheck.reason)
          accepted.forEach(releasePreview)
          return list
        }
        return next
      })
      // 图片变化后，之前的识别结果不再对应当前截图
      setDraft(null)
      setConfirmed(null)
      setIdentityConfirmed(false)
      setIdentityFlash(false)
      setWarningsExpanded(false)
      setPriceManuallyEdited(false)
      setSavedSnapshot(null)
      setAiError('')
    },
    []
  )

  // 粘贴截图（Ctrl/Cmd + V）：仍然只在本地预览
  useEffect(() => {
    if (!open) return undefined
    const handlePaste = (event) => {
      const items = event.clipboardData?.items
      if (!items) return
      const files = []
      for (const item of items) {
        if (item.kind === 'file' && String(item.type || '').startsWith('image/')) {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      if (files.length) {
        event.preventDefault()
        addFiles(files)
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [open, addFiles])

  const removeImage = (image) => {
    releasePreview(image)
    setImages((list) => list.filter((item) => item.id !== image.id))
    setDraft(null)
    setConfirmed(null)
    setIdentityConfirmed(false)
    setIdentityFlash(false)
    setWarningsExpanded(false)
    setPriceManuallyEdited(false)
    setSavedSnapshot(null)
    setAiError('')
  }

  const sessionKeyReady = Boolean(getAiConfig()?.apiKey)
  const canStart = images.length > 0 && !preparing && !aiLoading

  // 唯一的 AI 触发点：必须由用户显式点击
  const handleStartRecognition = async () => {
    if (aiInFlightRef.current || aiLoading) return
    if (!images.length) {
      message.warning('请先选择或粘贴 1~3 张截图')
      return
    }
    if (!sessionKeyReady && !aiStatus.available) {
      setAiError('未检测到可用的 AI 配置：请先在右上角「AI配置」中填写 DeepSeek API Key（或由后端环境变量提供）后再识别。')
      return
    }
    if (!aiStatus.visionAvailable) {
      setAiError('当前 AI 服务商暂未开放图片识别（P2A 仅支持 DeepSeek Vision），请在右上角「AI配置」中切换到 DeepSeek。')
      return
    }

    aiInFlightRef.current = true
    setAiLoading(true)
    setAiError('')
    setConfirmed(null)
    try {
      const res = await extractCreatorScreenshot(images.map((image) => ({ mime: image.mime, base64: image.base64 })))
      const nextDraft = buildDraftFromExtraction(res?.data || {})
      setDraft(nextDraft)
      setConfirmed(null)
      setIdentityConfirmed(false)
      setWarningsExpanded(false)
      setPriceManuallyEdited(false)
      setSavedSnapshot(null)
      // 身份一致时只做一次短暂提示（不长期占位）；不一致 / 未识别不在这里提示
      const identity = getIdentityCheckState({
        currentCreator: boundCreator,
        recognizedCreatorName: nextDraft.creator_name
      })
      setIdentityFlash(identity.status === IDENTITY_STATUS.matched)
    } catch (error) {
      // 识别失败：保留已选截图与人工修改，只提示失败原因
      setAiError(getErrorMessage(error, 'AI 识别失败，请重试（截图与已修改内容均已保留）'))
    } finally {
      aiInFlightRef.current = false
      setAiLoading(false)
    }
  }

  const handleConfirm = () => {
    if (!draft) return
    const result = buildConfirmedDraft(draft)
    setConfirmed(result)
    onConfirmed?.(result)
    message.success('已确认识别结果（P2A 暂不写入数据库）')
  }

  /**
   * Alpha.2 A3：手工录入播放量（不调用 AI、不访问网络）
   * 复用同一套确定性解析与同一份草稿结构，最终与截图路径汇入同一条保存链。
   */
  const handleParseManualPlays = () => {
    const lines = splitManualPlayLines(manualText)
    if (lines.length === 0) {
      setManualError('请输入至少一条播放量，例如「5.2万」或「12000」')
      return
    }
    const nextDraft = buildDraftFromManualPlays(lines)
    setManualError('')
    setDraft(nextDraft)
    setConfirmed(null)
    setIdentityConfirmed(false)
    setIdentityFlash(false)
    setWarningsExpanded(false)
    setPriceManuallyEdited(false)
    setSavedSnapshot(null)
    setSaveError('')
  }

  // P2B：显式保存（不静默写库）；失败保留 confirmed draft 与全部人工修改
  const handleSave = async () => {
    if (saving) return
    if (!confirmed) {
      message.warning('请先点击「确认识别结果」，再保存近期表现')
      return
    }
    if (!boundCreator) {
      message.warning('请先选择本次快照所属的达人')
      return
    }
    if (identityNeedsConfirm && !identityConfirmed) {
      message.warning('截图昵称与当前达人不一致，请勾选确认后再保存')
      return
    }
    if (!isValidDateOnly(observedAt)) {
      message.warning('请先填写数据观察日期（这批播放量和刊例价是哪天看到的）')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      const payload = buildSnapshotPayload(draft, {
        creator: boundCreator,
        identityConfirmed,
        observedAt
      })
      // Phase 5：带归属锚时显式声明 creator_id（绝不靠名称二次解析）
      if (effectiveCreatorId !== null) payload.creator_id = effectiveCreatorId
      // 候选模式走候选 API（服务端用 candidate.name 作为 creator，并落 candidate_id）
      const res = isCandidateMode
        ? await saveCandidateRecentSnapshot(candidateId, payload)
        : await saveRecentSnapshot(payload)
      setSavedSnapshot(res?.data || null)
      onSaved?.(res?.data || null)
      message.success('近期表现已保存为快照')
    } catch (error) {
      // 后端统一返回中文 msg；网络层失败（超时 / 502 等）不回显 axios 原始英文错误
      const backendMessage = error?.response?.data?.msg || error?.response?.data?.message
      setSaveError(backendMessage || '保存失败，识别结果与人工修改均已保留，可重试')
    } finally {
      setSaving(false)
    }
  }

  const summary = draft ? summarizeDraft(draft) : null
  // Alpha.2 A2：达人身份核对三态（matched / unknown / mismatch）
  // canonical creator 始终是雷达传入的 boundCreator；AI 昵称只用于判断有没有传错截图
  const identityState = getIdentityCheckState({
    currentCreator: boundCreator,
    recognizedCreatorName: draft?.creator_name
  })
  const identityNeedsConfirm = identityState.status === IDENTITY_STATUS.mismatch
  const identityMatched = identityState.status === IDENTITY_STATUS.matched
  const identityUnknown = identityState.status === IDENTITY_STATUS.unknown

  // 星图刊例价字段状态（只显示一个状态文案）
  const priceFieldStatus = draft
    ? getPriceFieldStatus({
        rawText: draft.xingtu_price_raw,
        price: draft.xingtu_price,
        needsReview: draft.xingtu_price_needs_review,
        manuallyEdited: priceManuallyEdited
      })
    : PRICE_FIELD_STATUS.missing
  // 只统计真正需要用户处理的事项（无法解析的播放量 / 身份不一致）
  // A3：星图刊例价是可选事实，缺失不再计入「需要确认 X 项」
  const requiredConfirmations = draft
    ? countRequiredConfirmations({
        unresolvedCount: summary?.unresolved_count ?? 0,
        identityStatus: identityState.status
      })
    : 0

  const canSave = canSaveSnapshot({
    confirmed: Boolean(confirmed),
    creator: boundCreator,
    identityNeedsConfirm,
    identityConfirmed,
    saving,
    savedSnapshot
  }) && isValidDateOnly(observedAt)

  // 「已核对」短暂提示：4 秒后自动消失，不长期占据页面空间
  useEffect(() => {
    if (!identityFlash) return undefined
    const timer = setTimeout(() => setIdentityFlash(false), 4000)
    return () => clearTimeout(timer)
  }, [identityFlash])

  /**
   * 草稿的任何人工修改都会让「确认识别结果」与「已保存」状态失效：
   * 这样「确认识别结果 → 保存近期表现」始终对应同一份内容，
   * 也避免同一份草稿被重复保存成多条快照。
   */
  const applyDraftChange = (nextDraft) => {
    setDraft(nextDraft)
    setConfirmed(null)
    setSavedSnapshot(null)
    setSaveError('')
  }

  return (
    <Modal
      title={isClassifyMode ? `${boundCreator || '达人'} · 补充内容分类` : '近期表现助手'}
      open={open}
      onCancel={handleClose}
      width={860}
      maskClosable={!aiLoading}
      footer={null}
      destroyOnClose
    >
      {isClassifyMode ? (
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Alert
            type="info"
            showIcon
            message="正在补充已有快照的内容分类"
            description="已有播放数据不会被修改；只需确认每条内容属于商单、日常或未识别。保存后会新增一条快照，历史快照不会被改写。"
          />
          {classifyError ? (
            <Alert type="warning" showIcon message={classifyError} />
          ) : classifyLoading ? (
            <Spin />
          ) : (
            <>
              <Space size={12} wrap>
                <Typography.Text type="secondary">达人：{boundCreator}</Typography.Text>
                <Typography.Text type="secondary">
                  数据观察日期：{isValidDateOnly(observedAt) ? observedAt : '观察日期未知'}（继承自原快照，不可修改）
                </Typography.Text>
                <Typography.Text type="secondary">作品数：{draft?.plays?.length ?? 0} 条</Typography.Text>
              </Space>
              <div>
                {draft?.plays?.length === 0 ? (
                  <Empty description="该快照没有可分类的作品" />
                ) : (
                  draft?.plays?.map((play, index) => (
                    <div
                      key={play.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '6px 0',
                        borderBottom: '1px solid #f5f5f5',
                        opacity: play.excluded ? 0.55 : 1
                      }}
                    >
                      <Typography.Text type="secondary" style={{ width: 24 }}>
                        {String(index + 1).padStart(2, '0')}
                      </Typography.Text>
                      {/* 播放量：已有事实，只读展示（不做输入框） */}
                      <Typography.Text
                        strong
                        style={{ minWidth: 96, textDecoration: play.excluded ? 'line-through' : 'none' }}
                      >
                        {play.normalized_play === null ? play.raw_text || '需人工确认' : formatInteger(play.normalized_play)}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ flex: 1, minWidth: 120 }}>
                        {play.raw_text}
                      </Typography.Text>
                      {play.excluded && <Tag color="default">已排除</Tag>}
                      {play.needs_review && <Tag color="warning">需人工确认</Tag>}
                      <Select
                        size="small"
                        value={normalizeContentType(play.content_type)}
                        options={CONTENT_TYPE_OPTIONS}
                        style={{ width: 96 }}
                        onChange={(value) =>
                          applyDraftChange(updatePlayContentType(draft, play.id, value))
                        }
                      />
                    </div>
                  ))
                )}
              </div>
              <Divider style={{ margin: '4px 0' }} />
              <Space size={12} wrap>
                <Button onClick={handleClose}>取消</Button>
                <Button
                  type="primary"
                  loading={saving}
                  disabled={!draft || (draft?.plays?.length ?? 0) === 0 || Boolean(classifyError)}
                  onClick={handleClassifySave}
                >
                  保存分类
                </Button>
                <Typography.Text type="secondary">
                  保存后会新增一条快照（append-only），原快照与播放数据保持不变。
                </Typography.Text>
              </Space>
              {saveError && <Alert type="error" showIcon message={saveError} />}
            </>
          )}
        </Space>
      ) : (
      <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
        <Typography.Text type="secondary">
          可以上传截图让 AI 识别，也可以直接手工录入播放量（无需 AI）。
          AI 只负责识别截图上的可见信息（昵称、星图刊例价、作品播放量），数值换算与判断由系统确定性地完成，
          结果必须经你确认；在你点击「保存近期表现」之前不会写入数据库。
        </Typography.Text>

        {/* 发送范围只与截图识别有关；手工录入不会向 AI 发送任何内容 */}
        {entryMode === 'screenshot' && (
          <Alert type="info" showIcon message="发送范围" description={SEND_NOTICE} />
        )}

        {/* Alpha.2 A2：canonical creator 来自雷达（静态展示，不再让用户重选）；仅全局入口需要先选择达人 */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography.Text type="secondary">正在更新：</Typography.Text>
          {creator ? (
            <Typography.Text strong>{creator}</Typography.Text>
          ) : (
            <Select
              value={boundCreator || undefined}
              placeholder="请选择本次快照所属达人"
              style={{ width: 220 }}
              showSearch
              optionFilterProp="label"
              onChange={(value) => {
                // Phase 5：选项 value 是身份键（creator_id 优先），选中后同时取得归属锚
                const selected = creatorOptionItems.find((item) => item.value === value)
                setBoundCreator(selected?.creator ?? String(value))
                setBoundCreatorId(selected?.creator_id ?? null)
                setIdentityConfirmed(false)
              }}
              options={creatorOptionItems.map((item) => ({ value: item.value, label: item.label }))}
            />
          )}
        </div>

        {/* Alpha.2：数据观察日期（这批播放量 / 星图价是哪天看到的），与「何时保存进系统」分开 */}
        <div>
          <Typography.Text type="secondary">数据观察日期</Typography.Text>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <DatePicker
              value={observedAt ? dayjs(observedAt) : null}
              format="YYYY-MM-DD"
              allowClear={false}
              style={{ width: 180 }}
              placeholder="请选择观察日期"
              onChange={(value) => setObservedAt(value ? value.format('YYYY-MM-DD') : '')}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              这批播放量和刊例价是哪天看到的（默认今天，可改为实际观察的那天）
            </Typography.Text>
          </div>
        </div>

        {/* 上传区：点击 / 拖拽 / 粘贴 */}
        {/* Alpha.2 A3：AI 是加速器而不是入口门槛 —— 两个入口主动可见，不必先失败一次 AI */}
        <Space size={12} wrap>
          <Typography.Text strong>近期作品数据</Typography.Text>
          <Radio.Group
            value={entryMode}
            onChange={(event) => setEntryMode(event.target.value)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="screenshot">上传截图识别</Radio.Button>
            <Radio.Button value="manual">手工录入</Radio.Button>
          </Radio.Group>
        </Space>

        {entryMode === 'screenshot' && (
          <>
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            addFiles(event.dataTransfer?.files)
          }}
          style={{
            border: `1px dashed ${dragging ? '#1677ff' : '#d9d9d9'}`,
            background: dragging ? '#f0f7ff' : '#fafafa',
            borderRadius: 8,
            padding: '18px 16px',
            textAlign: 'center',
            cursor: 'pointer'
          }}
          onClick={() => inputRef.current?.click()}
        >
          <p style={{ margin: 0, fontSize: 22 }}>
            <InboxOutlined />
          </p>
          <p style={{ margin: '6px 0 0' }}>点击选择图片，或拖拽图片到此处，也可直接 Ctrl / Cmd + V 粘贴截图</p>
          <Typography.Text type="secondary">
            仅支持 png / jpg / jpeg / webp，最多 {MAX_SCREENSHOT_COUNT} 张；单张处理后 ≤ 1.5MB，总发送体积 ≤ 3.2MB，
            长边自动缩放到 2000px 以内（只缩小不放大）
          </Typography.Text>
          <input
            ref={inputRef}
            type="file"
            accept={IMAGE_ACCEPT_ATTR}
            multiple
            style={{ display: 'none' }}
            onChange={(event) => {
              addFiles(event.target.files)
              event.target.value = ''
            }}
          />
        </div>

        <Typography.Text type="secondary">
          上传后不会自动发送，需点击下方的「开始 AI 识别」才会向 AI 发送截图。
        </Typography.Text>

        {prepareError && <Alert type="error" showIcon message={prepareError} />}

        {preparing && <Spin size="small" tip="正在本地压缩图片..." />}

        {images.length > 0 && (
          <div>
            <Space size={8} wrap>
              <Typography.Text strong>已选择 {images.length} 张截图</Typography.Text>
              <Typography.Text type="secondary">合计 {formatBytes(totalBytes)}</Typography.Text>
            </Space>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
              {images.map((image, index) => (
                <div
                  key={image.id}
                  style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 8, width: 180 }}
                >
                  <img
                    src={image.previewUrl}
                    alt={image.name}
                    style={{ width: '100%', height: 96, objectFit: 'cover', borderRadius: 6, background: '#fafafa' }}
                  />
                  <div style={{ marginTop: 6, fontSize: 12 }} title={image.name}>
                    <FileImageOutlined /> 图 {index + 1} · {formatBytes(image.bytes)}
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
                    {image.width}×{image.height}
                  </div>
                  <Button
                    size="small"
                    type="link"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={aiLoading}
                    onClick={(event) => {
                      event.stopPropagation()
                      removeImage(image)
                    }}
                  >
                    移除
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <Space size={12} wrap>
          <Tooltip
            title={
              aiStatus.visionAvailable
                ? '图片识别模型由系统固定，不可编辑'
                : '当前服务商暂未开放图片识别，请切换到 DeepSeek'
            }
          >
            <Tag color={aiStatus.visionAvailable ? 'blue' : 'default'}>
              图片识别模型：{aiStatus.visionModel || '未配置'}
            </Tag>
          </Tooltip>
          <Typography.Text type="secondary">
            {sessionKeyReady ? '已使用当前会话的 AI Key' : aiStatus.available ? '使用后端环境变量中的 AI Key' : '尚未配置 AI Key'}
          </Typography.Text>
        </Space>

        {!sessionKeyReady && !aiStatus.available && aiStatus.checked && (
          <Alert
            type="warning"
            showIcon
            message="未检测到可用的 AI 配置"
            description="请先在右上角「AI配置」中填写 DeepSeek API Key（或由后端环境变量提供）后再识别；系统不会自动调用 AI，也不会生成假的识别结果。"
          />
        )}

        <Space size={12} wrap>
          <Button
            type="primary"
            icon={<SendOutlined />}
            disabled={!canStart}
            loading={aiLoading}
            onClick={handleStartRecognition}
          >
            开始 AI 识别
          </Button>
          {aiError && (
            <Button
              icon={<ReloadOutlined />}
              disabled={!canStart}
              onClick={handleStartRecognition}
            >
              重新识别
            </Button>
          )}
          {images.length > 0 && (
            <Button disabled={aiLoading} onClick={resetAll}>
              清空重来
            </Button>
          )}
        </Space>

        {aiError && <Alert type="error" showIcon message={aiError} description="已保留当前截图与人工修改内容，可直接重试。" />}
          </>
        )}

        {/* Alpha.2 A3：手工录入（完全不依赖 AI / 截图 / Key） */}
        {entryMode === 'manual' && (
          <Space direction="vertical" size={8} style={{ display: 'flex' }}>
            <Typography.Text type="secondary">
              请按「从旧到新」的时间顺序输入每条作品的播放量，一行一个（也支持中文 / 英文逗号分隔）。
              数值换算由系统确定性地完成，不会调用 AI。
            </Typography.Text>
            <Input.TextArea
              value={manualText}
              rows={6}
              placeholder={'例如：\n5.2万\n4.8万\n39000\n8.3w'}
              onChange={(event) => {
                setManualText(event.target.value)
                setManualError('')
              }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              建议录入最近约 15 条作品；至少 5 条才能计算中位播放与典型区间，8 条以上才能计算趋势。不强制凑满 15 条。
            </Typography.Text>
            <Space size={12} wrap>
              <Button type="primary" onClick={handleParseManualPlays}>
                解析并进入确认
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                已输入 {splitManualPlayLines(manualText).length} 条
              </Typography.Text>
            </Space>
            {manualError && <Alert type="error" showIcon message={manualError} />}
          </Space>
        )}

        {draft && (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <Typography.Title level={5} style={{ margin: 0 }}>
              人工确认识别结果
            </Typography.Title>
            <Typography.Text type="secondary">
              识别到 {summary.identified_count} 条作品（AI 识别到多少就展示多少，不会自动补足 15 条）；数值可修改，
              无法确定性解析的条目请人工确认。{ORDER_NOTICE}
            </Typography.Text>

            {/* Alpha.2 A2：身份核对三态（一致：短暂提示；未识别：轻提示；不一致：黄色风险 + 显式确认） */}
            {identityMatched && identityFlash && (
              <Typography.Text type="success" style={{ fontSize: 12 }}>
                ✓ 达人身份已核对
              </Typography.Text>
            )}
            {/* A3：手工录入没有 AI 昵称，不属于「截图是否传错」，因此不显示该提示 */}
            {identityUnknown && entryMode === 'screenshot' && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                未识别到达人昵称，请自行确认截图
              </Typography.Text>
            )}

            {identityNeedsConfirm && (
              <Alert
                type="warning"
                showIcon
                message={`截图识别昵称「${identityState.recognizedName}」与当前达人「${boundCreator || '未选择'}」不一致。请确认是否上传了正确截图。`}
                description={
                  <Checkbox
                    checked={identityConfirmed}
                    onChange={(event) => setIdentityConfirmed(event.target.checked)}
                  >
                    {`我确认截图无误，仍保存到「${boundCreator || '未选择'}」`}
                  </Checkbox>
                }
              />
            )}

            {/* Alpha.2 A2：AI 详情默认折叠；只把「需要用户处理」的事项计入 X 项 */}
            {requiredConfirmations > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`需要确认 ${requiredConfirmations} 项`}
                description={
                  <Space direction="vertical" size={4} style={{ display: 'flex' }}>
                    <Typography.Text>
                      {(summary?.unresolved_count ?? 0) > 0
                        ? `${summary.unresolved_count} 条播放量无法确定性解析；`
                        : ''}
                      {identityNeedsConfirm ? '识别昵称与当前达人不一致；' : ''}
                      核对无误后即可保存。
                    </Typography.Text>
                    <div>
                      <Button
                        type="link"
                        size="small"
                        style={{ padding: 0 }}
                        onClick={() => setWarningsExpanded((value) => !value)}
                      >
                        {warningsExpanded ? '收起识别详情' : '查看识别详情'}
                      </Button>
                    </div>
                    {warningsExpanded &&
                      (draft.warnings.length > 0 ? (
                        draft.warnings.map((item) => (
                          <Typography.Text key={item} type="secondary">
                            · {item}
                          </Typography.Text>
                        ))
                      ) : (
                        <Typography.Text type="secondary">本次识别没有额外的解释性说明。</Typography.Text>
                      ))}
                  </Space>
                }
              />
            ) : (
              <Space direction="vertical" size={2} style={{ display: 'flex' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  识别结果已可检查
                </Typography.Text>
                {draft.warnings.length > 0 && (
                  <>
                    <div>
                      <Button
                        type="link"
                        size="small"
                        style={{ padding: 0 }}
                        onClick={() => setWarningsExpanded((value) => !value)}
                      >
                        {warningsExpanded ? '收起识别详情' : '查看识别详情'}
                      </Button>
                    </div>
                    {warningsExpanded &&
                      draft.warnings.map((item) => (
                        <Typography.Text key={item} type="secondary">
                          · {item}
                        </Typography.Text>
                      ))}
                  </>
                )}
              </Space>
            )}

            {/* Alpha.2 A2：星图刊例价只保留一个字段 + 一个状态文案 */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Typography.Text type="secondary">星图刊例价（选填）</Typography.Text>
              <Input
                value={draft.xingtu_price_raw}
                placeholder="可不填，例如 ¥3,000"
                style={{ width: 200 }}
                onChange={(event) => {
                  setPriceManuallyEdited(true)
                  applyDraftChange(updatePriceRawText(draft, event.target.value))
                }}
              />
              <Typography.Text
                type={
                  priceFieldStatus === PRICE_FIELD_STATUS.identified ||
                  priceFieldStatus === PRICE_FIELD_STATUS.confirmed
                    ? 'success'
                    : 'warning'
                }
                style={{ fontSize: 12 }}
              >
                {PRICE_FIELD_STATUS_LABELS[priceFieldStatus]}
              </Typography.Text>
              {priceFieldStatus === PRICE_FIELD_STATUS.identified ||
              priceFieldStatus === PRICE_FIELD_STATUS.confirmed ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {`¥${formatInteger(draft.xingtu_price)}`}
                </Typography.Text>
              ) : null}
            </div>

            <div>
              <Space size={8} wrap>
                <Typography.Text strong>作品播放量</Typography.Text>
                <Typography.Text type="secondary">
                  作品顺序：柱状图从左到右、作品列表从上到下识别；工作台统一按从旧到新展示，最新作品在最后。多张图片按上传顺序拼接，请确认图片间的时间先后。修改原文后会立即重新换算。
                  内容类型：柱状图按柱体填充颜色判断——粉红色柱体为商单、蓝色柱体为日常；纵向作品列表依据行内可见颜色标识判断；红色火焰图标与均值虚线不代表商单；无法确认 = 未识别（可逐条修改，不需要重新识别）
                </Typography.Text>
              </Space>
              <div style={{ marginTop: 8 }}>
                {draft.plays.length === 0 ? (
                  <Empty description="本次没有识别到作品播放量（系统不会自动补足，可重新识别或手工填写）" />
                ) : (
                  draft.plays.map((play, index) => (
                    <div
                      key={play.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                        padding: '6px 0',
                        borderBottom: '1px solid #f5f5f5',
                        opacity: play.excluded ? 0.55 : 1
                      }}
                    >
                      <Typography.Text type="secondary" style={{ width: 24 }}>
                        {String(index + 1).padStart(2, '0')}
                      </Typography.Text>
                      <Input
                        size="small"
                        value={play.raw_text ?? ''}
                        placeholder="截图原文"
                        style={{ width: 120 }}
                        onChange={(event) => applyDraftChange(updatePlayRawText(draft, play.id, event.target.value))}
                      />
                      <Typography.Text type="secondary">→</Typography.Text>
                      <Typography.Text
                        strong
                        style={{ minWidth: 92, textDecoration: play.excluded ? 'line-through' : 'none' }}
                      >
                        {play.normalized_play === null ? '需人工确认' : formatInteger(play.normalized_play)}
                      </Typography.Text>
                      <Tag>{`图 ${play.source_image_index ?? '?'} · 第 ${play.position_index} 条`}</Tag>
                      {/* Alpha.3-04：逐条内容类型（商单 / 日常 / 未识别）——人工可直接改这一条，不重新识别 */}
                      <Select
                        size="small"
                        value={normalizeContentType(play.content_type)}
                        options={CONTENT_TYPE_OPTIONS}
                        style={{ width: 96 }}
                        onChange={(value) =>
                          applyDraftChange(updatePlayContentType(draft, play.id, value))
                        }
                      />
                      {play.needs_review && (
                        <Tooltip title={play.reason || '无法确定性解析'}>
                          <Tag color="warning">需人工确认</Tag>
                        </Tooltip>
                      )}
                      {play.excluded && <Tag color="default">已排除</Tag>}
                      <Button
                        size="small"
                        type="link"
                        onClick={() => applyDraftChange(togglePlayExcluded(draft, play.id))}
                      >
                        {play.excluded ? '恢复该条' : '排除该条'}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <Space size={16} wrap>
                <Typography.Text>识别作品：{summary.identified_count}</Typography.Text>
                <Typography.Text>有效作品：{summary.valid_count}</Typography.Text>
                <Typography.Text>排除：{summary.excluded_count}</Typography.Text>
                {summary.unresolved_count > 0 && (
                  <Tooltip title="未排除但无法确定性解析的条目，不计入有效样本（后端会存为 unresolved）">
                    <Typography.Text type="warning">
                      待人工确认：{summary.unresolved_count}
                    </Typography.Text>
                  </Tooltip>
                )}
                {/* 星图价状态只在字段处显示一次；摘要只展示已换算出的金额 */}
                {summary.xingtu_price !== null && (
                  <Typography.Text>{`星图价：¥${formatInteger(summary.xingtu_price)}`}</Typography.Text>
                )}
                {/* Alpha.3-04：保存前先让用户看到内容类型构成（商单 / 日常 / 未识别，仅计数不做加权） */}
                <Typography.Text type="secondary">
                  {`内容类型：商单 ${summary.content_type_counts.sponsored} · 日常 ${summary.content_type_counts.organic} · 未识别 ${summary.content_type_counts.unknown}`}
                </Typography.Text>
              </Space>
              <Button type="primary" disabled={aiLoading} onClick={handleConfirm}>
                确认识别结果
              </Button>
            </div>

            {confirmed && (
              <Alert
                type="success"
                showIcon
                message="已生成确认草稿"
                description="确认只是形成草稿，尚未写入数据库；点击下方「保存近期表现」才会写入快照。不计算目标价、不做折扣与复投建议。"
              />
            )}

            {/* P2B：显式保存动作（与「确认识别结果」分开，不做静默写库） */}
            <Divider style={{ margin: '4px 0' }} />
            <Space direction="vertical" size={8} style={{ display: 'flex' }}>
              <Typography.Text type="secondary">{SAVE_NOTICE}</Typography.Text>
              <Space size={12} wrap>
                <Tooltip title={confirmed ? '' : '请先点击上方「确认识别结果」'}>
                  <Button type="primary" loading={saving} disabled={!canSave} onClick={handleSave}>
                    保存近期表现
                  </Button>
                </Tooltip>
                <Typography.Text type="secondary">
                  {isCandidateMode
                    ? '保存后可在本页看到该候选达人的最新快照（append-only，不会覆盖历史快照）'
                    : '保存后可在复投雷达对应达人处看到最新快照（append-only，不会覆盖历史快照）'}
                </Typography.Text>
              </Space>

              {saveError && (
                <Alert
                  type="error"
                  showIcon
                  message={saveError}
                  description="识别结果与人工修改均已保留，可直接重试。"
                />
              )}

              {savedSnapshot && (
                <Alert
                  type="success"
                  showIcon
                  message={`已保存快照 #${savedSnapshot.id}（保存于 ${savedSnapshot.created_at || ''}）`}
                  description={
                    <Space direction="vertical" size={2}>
                      <Typography.Text>
                        数据观察日期：{savedSnapshot.observed_at || '观察日期未知'}
                      </Typography.Text>
                      <Typography.Text>
                        有效样本：{formatInteger(savedSnapshot.valid_count)}
                        {savedSnapshot.excluded_count > 0 ? `，排除 ${formatInteger(savedSnapshot.excluded_count)}` : ''}
                        {savedSnapshot.unresolved_count > 0 ? `，待人工确认 ${formatInteger(savedSnapshot.unresolved_count)}` : ''}
                      </Typography.Text>
                      {savedSnapshot.stats_status === 'ok' ? (
                        <>
                          <Typography.Text>
                            中位播放：{formatPlays(savedSnapshot.median_play)}　典型区间（P25–P75）：
                            {formatPlayRange(savedSnapshot.p25_play, savedSnapshot.p75_play)}
                          </Typography.Text>
                          <Typography.Text>
                            趋势：{TREND_LABELS_FULL[savedSnapshot.trend_label] || '样本不足'}
                            {formatTrendRatio(savedSnapshot.trend_ratio)
                              ? `（${formatTrendRatio(savedSnapshot.trend_ratio)}）`
                              : ''}
                          </Typography.Text>
                        </>
                      ) : (
                        <Typography.Text>样本不足：本次不展示中位播放与典型区间，建议补充更多近期作品截图。</Typography.Text>
                      )}
                      <Typography.Text>
                        星图价：{savedSnapshot.xingtu_price === null || savedSnapshot.xingtu_price === undefined ? '暂无（选填，未提供）' : `¥${formatInteger(savedSnapshot.xingtu_price)}`}
                      </Typography.Text>
                      <Typography.Text type="secondary">统计口径：{savedSnapshot.stats_version}</Typography.Text>
                      <Divider style={{ margin: '6px 0' }} />
                      <Typography.Text strong>
                        CPM30 价格核算
                        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                          按近期中位播放 / 典型区间（P25–P75）换算，仅价格参考
                        </Typography.Text>
                      </Typography.Text>
                      {buildPricingRows(savedSnapshot.pricing).map((row) => (
                        <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                          <Typography.Text type="secondary">{row.label}</Typography.Text>
                          <Typography.Text>{row.value}</Typography.Text>
                        </div>
                      ))}
                      <Typography.Text>
                        价格状态：{savedSnapshot.pricing?.pricing_status_label || '-'}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        价格规则版本：{savedSnapshot.pricing?.pricing_version || '-'}
                      </Typography.Text>
                    </Space>
                  }
                />
              )}
            </Space>
          </>
        )}

        <Divider style={{ margin: '4px 0' }} />
        <div style={{ textAlign: 'right' }}>
          <Button onClick={handleClose} disabled={aiLoading}>
            关闭
          </Button>
        </div>
      </Space>
      )}
    </Modal>
  )
}
