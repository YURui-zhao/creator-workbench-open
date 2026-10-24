import { useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Divider,
  Form,
  Input,
  List,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Steps,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message
} from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { batchCreateRecords, fetchAllRecords, getCycles } from '../api/records'
import { normalizeTimeCyclesAI, suggestFieldMappingsAI, validateRecordsAI } from '../api/ai'
import { getAiConfig, getProviderPreset } from '../utils/aiConfig.js'
import { getErrorMessage } from '../utils/request.js'
import {
  applyManualImportCorrection,
  applyTimeCycleMapping,
  buildHeaderMappingReview,
  confirmSourceTimeCycleConflict,
  FIELD_LABELS,
  IGNORE_FIELD,
  isMappingReviewComplete,
  MAPPING_FIELD_OPTIONS,
  classifyImportRows,
  isPreviewEligible,
  RECORD_FACT_LABELS,
  splitExistingChanges,
  buildUpdateIntents,
  detectMappingConflicts,
  exportFailedRowsToExcel,
  parseRecordsExcel,
  weekCodeToLabel,
  buildFailedRowsFileName
} from '../utils/excel'
import { explainTimeCycle, parseTimeCycleToWeekCode } from '../utils/dateCycle.js'

const { Dragger } = Upload

// AI 校验结果为空/结构异常时的兜底文案（禁止展示空内容）
const AI_RESULT_INVALID_TIP = 'AI校验结果格式异常，请重试'

// 行号兜底：无法解析时显示「未知行」，避免出现「第 行」
function formatRowLabel(rowIndex) {
  const num = Number(rowIndex)
  return Number.isFinite(num) && num > 0 ? `第 ${num} 行` : '未知行'
}

// 结构化问题项 -> 展示用明细（行号 / 字段 / 原始值 / AI输出或失败原因 / 原因 / 建议）
function buildAiDetailRows(record, cycleNotes = {}) {
  const items = [
    ...(record.errors || []).map((entry) => ({ ...entry, level: 'error' })),
    ...(record.warnings || []).map((entry) => ({ ...entry, level: 'warning' }))
  ]
  // 时间周期相关的 AI 识别备注（AI 输出 / AI 识别失败原因），按行号取
  const cycleNote = cycleNotes[record.rowIndex] || ''
  return items.map((entry, index) => {
    const field = entry.field && entry.field !== 'record' ? entry.field : ''
    const raw = field ? record.rawRow?.[field] : undefined
    const correctedValue = field ? record.corrected?.[field] : undefined
    const correctedText =
      correctedValue === undefined || correctedValue === null || correctedValue === ''
        ? ''
        : `${weekCodeToLabel(String(correctedValue))}（${String(correctedValue)}）`
    const aiNote =
      field === 'time_cycle'
        ? cycleNote || (correctedText ? `AI输出：${correctedText}` : '无 AI 识别备注')
        : correctedText
          ? `AI输出：${correctedText}`
          : ''
    return {
      key: `${record.rowIndex ?? 'unknown'}-${index}`,
      rowIndex: Number.isFinite(Number(entry.rowIndex)) ? Number(entry.rowIndex) : record.rowIndex,
      level: entry.level,
      field: field ? FIELD_LABELS[field] || field : '整条记录',
      originalValue: raw === undefined || raw === null || String(raw).trim() === '' ? '（空）' : String(raw),
      aiNote,
      reason: entry.reason || '未说明原因',
      suggestion: entry.suggestion || '暂无建议'
    }
  })
}

// 可勾选的高级判定规则（key 与后端 RULE_LIBRARY 对应）
const RULE_OPTIONS = [
  { label: '达人类型CPM匹配（如美妆CPM不超过50，超限标红提示）', value: 'creator_type_cpm' },
  { label: '时间周期格式（YYYY-Wxx）', value: 'time_cycle_format' },
  { label: '重复数据判定（相同达人 + 相同发布日期）', value: 'duplicate_check' },
  { label: '数据量级合理性（播放量与总花费商业逻辑）', value: 'magnitude_check' },
  { label: '链接平台与博主类型匹配（抖音/小红书/B站等）', value: 'platform_link_match' }
]

const MANUAL_EDIT_FIELDS = [
  'nickname',
  'publish_date',
  'sourceTimeCycleRaw',
  'creator_type',
  'homepage',
  'content_link',
  'video_link',
  'total_cost',
  'first_play',
  'second_week_play'
]

// 与后端白名单一致；解析/校验元数据不随智能校验请求发送。
const AI_VALIDATION_FIELDS = [
  'rowIndex', 'time_cycle', 'nickname', 'creator_type', 'homepage', 'content_link',
  'video_link', 'total_cost', 'publish_date', 'first_play', 'second_week_play', 'cpm_quote'
]
const pickAiValidationFields = (row) => Object.fromEntries(
  AI_VALIDATION_FIELDS.filter((field) => row[field] !== undefined)
    .map((field) => [field, row[field]])
)

// 单元格渲染：无效单元格标红并悬浮显示原因
function renderCell(field) {
  return (value, record) => {
    const error = record.cellErrors?.find((item) => item.field === field)
    if (!error) return value ?? '-'
    return (
      <Tooltip title={error.reason}>
        <span style={{ color: '#ff4d4f', cursor: 'help' }}>{value ?? ''}</span>
      </Tooltip>
    )
  }
}

// 时间周期列：显示月日区间，无效单元格标红
function renderTimeCycle(value, record) {
  const error = record.cellErrors?.find((item) => item.field === 'time_cycle')
  const display = weekCodeToLabel(value)
  if (error) {
    return (
      <Tooltip title={error.reason}>
        <span style={{ color: '#ff4d4f', cursor: 'help' }}>{display}</span>
      </Tooltip>
    )
  }
  // 源业务周期只作来源信息展示（它与 canonical 自然周不同属于正常情况，不做警告）
  const sourceText = record.sourceTimeCycleRaw || ''
  if (!sourceText) return display
  return (
    <Tooltip title={`源业务周期：${sourceText}（最终按发布日期归属）`}>
      <span style={{ cursor: 'help' }}>
        {display}
        <Tag
          color="default"
          style={{ marginLeft: 4, fontSize: 11, lineHeight: '16px', padding: '0 4px' }}
        >
          源
        </Tag>
      </span>
    </Tooltip>
  )
}

// 预览表格列（前 5 条）
const PREVIEW_COLUMNS = [
  { title: '行号', dataIndex: 'rowIndex', width: 70 },
  { title: '时间周期', dataIndex: 'time_cycle', width: 120, ellipsis: true, render: renderTimeCycle },
  {
    title: '达人昵称',
    dataIndex: 'nickname',
    width: 170,
    render: (value, record) => (
      <Space size={4}>
        {renderCell('nickname')(value, record)}
        {record.manualCorrection && <Tag color="blue">人工修正</Tag>}
        {record.sourceCycleConfirmed && <Tag color="gold">人工确认</Tag>}
      </Space>
    )
  },
  { title: '博主类型', dataIndex: 'creator_type', width: 110, ellipsis: true, render: renderCell('creator_type') },
  { title: '总花费(元)', dataIndex: 'total_cost', width: 100, align: 'right', render: renderCell('total_cost') },
  { title: '发布日期', dataIndex: 'publish_date', width: 110, render: renderCell('publish_date') },
  {
    title: '7日播放量',
    dataIndex: 'first_play',
    width: 110,
    align: 'right',
    render: renderCell('first_play')
  },
  {
    title: '累计播放量',
    dataIndex: 'second_week_play',
    width: 110,
    align: 'right',
    render: renderCell('second_week_play')
  }
]

/**
 * Excel 批量导入弹窗：上传并本地校验后，可主动请求 AI 建议，再确认导入。
 */
export default function ExcelImportModal({ open, onCancel, onSuccess }) {
  const navigate = useNavigate()
  const [manualForm] = Form.useForm()
  // 步骤：0 上传文件 / 1 字段或周期确认 / 2 预览与导入
  const [step, setStep] = useState(0)
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  // 批量导入失败信息（保留在弹窗内，便于重试）
  const [importError, setImportError] = useState('')
  // 解析结果（含本地校验）
  const [preview, setPreview] = useState(null)
  // AI 判定结果
  const [aiResults, setAiResults] = useState([])
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  // AI 返回结构异常（无法解析出任何有效条目）时置位，界面给出重试提示而不是空白
  const [aiFormatError, setAiFormatError] = useState(false)
  // 原始数据与修正后数据：importRows 始终为「当前待导入数据」
  const [importRows, setImportRows] = useState([])
  const aiRequestInFlightRef = useRef(false)
  const mappingRequestInFlightRef = useRef(false)
  const cycleRequestInFlightRef = useRef(false)
  const [manualEditRowIndex, setManualEditRowIndex] = useState(null)
  const [manualEditFromAi, setManualEditFromAi] = useState(false)
  const [manualEditError, setManualEditError] = useState('')
  const [manualSaving, setManualSaving] = useState(false)
  // 高级规则配置
  const [selectedRules, setSelectedRules] = useState([])
  const [customRules, setCustomRules] = useState('')
  // 时间周期智能识别（本地规则无法识别时的 AI 兜底）
  const [cycleReview, setCycleReview] = useState(null)
  // 字段映射确认（Batch 6A：存在未识别表头时必须先确认，不允许静默丢弃）
  const [mappingReview, setMappingReview] = useState(null)
  // 最近一次上传的文件与周期选项：用户确认字段映射后需要重新解析同一份文件
  const sourceFileRef = useRef(null)
  const sourceCyclesRef = useRef([])
  // 时间周期 AI 识别备注（按 Excel 行号索引）：AI 输出 / AI 识别失败原因，用于界面展示与失败明细导出
  const [cycleNotes, setCycleNotes] = useState({})
  // 去重阶段剔除的行（行号 + 原因）：应用时间周期映射后需要继续保持排除
  const excludedRowsRef = useRef([])
  // Phase: record identity 分类结果（exact / noop / changed / uncertain / new），用于统计与明细展示
  const [identityReview, setIdentityReview] = useState(null)
  // Existing Record Update V0.1：用户是否显式选择「同时更新已有记录」（mixed 场景默认不勾选）
  const [includeUpdates, setIncludeUpdates] = useState(false)
  // 时间周期识别面板中手动「跳过该行」的行号，计入「跳过」统计
  const [skippedRowIndexes, setSkippedRowIndexes] = useState([])

  // AI 结果按 Excel 行号索引（与本地校验行号口径一致）
  const aiMap = useMemo(() => new Map(aiResults.map((r) => [r.rowIndex, r])), [aiResults])
  const aiProviderLabel = getProviderPreset(getAiConfig()?.provider).label

  // 统计：共 / 通过 / 警告 / 错误
  const stats = useMemo(() => {
    const s = { total: aiResults.length, pass: 0, warning: 0, error: 0 }
    for (const r of aiResults) {
      if (r.level === 'error') s.error += 1
      else if (r.level === 'warning') s.warning += 1
      else s.pass += 1
    }
    return s
  }, [aiResults])

  // AI 错误仅作为风险提示，不能自行改变本地校验决定的可导入范围。
  const aiErrors = useMemo(() => aiResults.filter((r) => r.level === 'error'), [aiResults])

  // ---------- Existing Record Update V0.1：把 existing_changed 拆成「可安全更新 / 需人工处理」 ----------
  // safe_update 只允许 second_week_play 安全增长；其余（含下降 / 其它字段变化）一律 manual_review
  const updatePlan = useMemo(
    () => splitExistingChanges(identityReview?.existingChanged || []),
    [identityReview]
  )
  const safeUpdateCount = updatePlan.safeUpdates.length
  const manualReviewCount = updatePlan.manualReview.length
  // ---------- 导入结果统计（新记录 / 可安全更新 / 需人工处理 / 无新信息 / 完全重复 / 失败 / 跳过） ----------
  // 不进入本次导入的行 = exact duplicate + noop + 需人工处理的 changed + uncertain（都不允许 POST 成新 record）
  const excludedImportRows = useMemo(() => {
    if (!identityReview) return []
    const pick = (list, kind) => (list || []).map((item) => ({ rowIndex: item.row.rowIndex, reason: item.reason, kind }))
    return [
      ...pick(identityReview.exactDuplicates, 'exact_duplicate'),
      ...pick(identityReview.existingNoop, 'existing_noop'),
      ...(updatePlan.manualReview || []).map((item) => ({
        rowIndex: item.row.rowIndex,
        reason: `需人工处理（不自动更新）：${item.update?.reason || ''}`,
        kind: 'manual_review'
      })),
      ...pick(identityReview.identityUncertain, 'identity_uncertain')
    ]
  }, [identityReview, updatePlan])
  const duplicateIndexes = useMemo(
    () => new Set(excludedImportRows.map((item) => item.rowIndex)),
    [excludedImportRows]
  )
  const skippedIndexes = useMemo(() => new Set(skippedRowIndexes), [skippedRowIndexes])
  // 失败明细：排除重复行与手动跳过的行（各自单独统计，避免重复计数）
  const failedRows = useMemo(
    () =>
      (preview?.failedRows || []).filter(
        (item) => !duplicateIndexes.has(item.rowIndex) && !skippedIndexes.has(item.rowIndex)
      ),
    [preview, duplicateIndexes, skippedIndexes]
  )
  const confirmationRows = useMemo(
    () => (preview?.confirmationRows || []).filter(
      (item) => !duplicateIndexes.has(item.rowIndex) && !skippedIndexes.has(item.rowIndex)
    ),
    [preview, duplicateIndexes, skippedIndexes]
  )
  const importStats = useMemo(
    () => ({
      新记录: identityReview ? identityReview.newRecords.length : importRows.length,
      可安全更新: updatePlan.safeUpdates.length,
      需人工处理: updatePlan.manualReview.length,
      已有记录无新增信息: identityReview ? identityReview.existingNoop.length : 0,
      完全重复: identityReview ? identityReview.exactDuplicates.length : 0,
      需确认: confirmationRows.length,
      失败: failedRows.length,
      // 跳过 = 空白行 + 重复表头行 + 时间周期面板中手动跳过的行
      跳过: (preview?.blankRows || 0) + (preview?.repeatedHeaderRows || 0) + skippedRowIndexes.length,
      需人工确认身份: identityReview ? identityReview.identityUncertain.length : 0
    }),
    [importRows.length, confirmationRows.length, failedRows.length, preview, skippedRowIndexes.length, identityReview, updatePlan]
  )
  const blankRowIndexes = preview?.blankRowIndexes || []
  const headerRowIndexes = preview?.headerRowIndexes || []
  const manualEditIsSourceConflict = Boolean(preview?.allRows?.find(
    (row) => row.rowIndex === manualEditRowIndex
  )?.sourceCycleConflictOrigin)

  const importableRows = importRows

  // Existing Record Update V0.1：是否应用已有记录更新
  //   · mixed（有新增）→ 必须由用户显式勾选「同时更新」，默认只导入新增
  //   · update-only（无新增）→ 主 CTA「更新已有记录」本身就是显式确认（点击后还有二次确认）
  const hasNewRecords = importableRows.length > 0
  const applyUpdates = hasNewRecords ? includeUpdates : safeUpdateCount > 0
  const updateIntents = useMemo(
    () => (applyUpdates ? buildUpdateIntents(updatePlan.safeUpdates) : []),
    [applyUpdates, updatePlan]
  )

  // 下载失败明细（行号 / 错误字段 / 原始值 / 错误原因），无失败数据时给出提示
  const handleDownloadFailedRows = () => {
    if (!failedRows.length) {
      message.info('当前没有失败数据')
      return
    }
    const count = exportFailedRowsToExcel(
      failedRows,
      buildFailedRowsFileName(),
      preview?.allRows || [],
      // 失败明细附加【AI识别备注】列（按行号索引）
      { aiNotes: cycleNotes }
    )
    message.success(`已导出 ${count} 条失败明细`)
  }

  // 忙碌状态：解析/AI校验/导入中禁止关闭，避免异步回调写入已重置的状态
  const busy = parsing || importing || aiLoading || manualSaving ||
    Boolean(mappingReview?.loading) || Boolean(cycleReview?.loading)

  // 重置并回到上传步骤
  const resetUpload = () => {
    setStep(0)
    setPreview(null)
    setAiResults([])
    setAiError('')
    setAiFormatError(false)
    setImportError('')
    setCycleReview(null)
    setMappingReview(null)
    setCycleNotes({})
    setImportRows([])
    setManualEditRowIndex(null)
    setManualEditFromAi(false)
    setManualEditError('')
    manualForm.resetFields()
    setIdentityReview(null)
    setIncludeUpdates(false)
    setSkippedRowIndexes([])
    excludedRowsRef.current = []
    sourceFileRef.current = null
    sourceCyclesRef.current = []
    setParsing(false)
    setImporting(false)
  }

  const closeModal = () => {
    if (busy) return
    resetUpload()
    onCancel()
  }

  // ---------- 调用 AI 校验 ----------
  /**
   * AI 返回结果 -> 弹窗展示结构
   * 行号统一取 rowIndex（缺省回退 index），解析不出时置 null（界面显示「未知行」）；
   * warnings/errors 统一成 {field, reason, suggestion} 结构，便于逐条展示
   */
  const normalizeAiResults = (list, rows) => {
    const rowMap = new Map((Array.isArray(rows) ? rows : []).map((row) => [row.rowIndex, row]))
    const pickList = (source, level, fallbackRowIndex) =>
      (Array.isArray(source) ? source : [])
        .map((entry) => {
          if (entry === null || entry === undefined) return null
          if (typeof entry === 'string') {
            const reason = entry.trim()
            return reason
              ? { field: '', reason, suggestion: '', level, rowIndex: fallbackRowIndex }
              : null
          }
          if (typeof entry !== 'object') return null
          const reason = String(entry.reason ?? entry.issue ?? entry.message ?? '').trim()
          const suggestion = String(entry.suggestion ?? entry.suggest ?? entry.advice ?? '').trim()
          const field = String(entry.field ?? entry.column ?? '').trim()
          const entryIndex = Number(entry.rowIndex)
          if (!reason && !suggestion) return null
          return {
            field,
            reason,
            suggestion,
            level,
            rowIndex: Number.isFinite(entryIndex) && entryIndex > 0 ? entryIndex : fallbackRowIndex
          }
        })
        .filter(Boolean)

    return (Array.isArray(list) ? list : []).map((item) => {
      const rawIndex = item?.rowIndex ?? item?.index
      const num = Number(rawIndex)
      const rowIndex = Number.isFinite(num) && num > 0 ? num : null
      const errors = pickList(item?.errors, 'error', rowIndex)
      const warnings = pickList(item?.warnings, 'warning', rowIndex)
      const level =
        item?.level === 'error' || item?.level === 'warning' || item?.level === 'info'
          ? item.level
          : errors.length
            ? 'error'
            : 'warning'
      return {
        rowIndex,
        level,
        pass: Boolean(item?.pass),
        issues: Array.isArray(item?.issues) ? item.issues : [],
        suggestions: Array.isArray(item?.suggestions) ? item.suggestions : [],
        warnings,
        errors,
        corrected: item?.corrected && typeof item.corrected === 'object' ? item.corrected : null,
        rawRow: rowMap.get(rowIndex)
      }
    })
  }

  const runAiValidation = async (rows) => {
    if (aiRequestInFlightRef.current || !rows.length) return
    aiRequestInFlightRef.current = true
    setAiLoading(true)
    setAiError('')
    setAiFormatError(false)
    try {
      // 未在右上角配置 API 密钥时：明确提示并跳过，不发起任何 AI 接口请求
      const config = getAiConfig()
      if (!config?.apiKey) {
        const tip = '请先在右上角配置API密钥'
        setAiError(tip)
        message.warning(tip)
        setStep(2)
        return
      }

      // 组装规则：勾选的规则标识 + 自定义自然语言条件（每行一条）
      const rules = [
        ...selectedRules,
        ...customRules
          .split('\n')
          .map((text) => text.trim())
          .filter(Boolean)
      ]
      const res = await validateRecordsAI(rows.map(pickAiValidationFields), rules)
      const items = normalizeAiResults(res.data, rows)
      if (!items.length) {
        // 结构异常（不是数组 / 空数组）：不展示空列表，给出明确重试提示
        setAiResults([])
        setAiFormatError(true)
        setStep(2)
        return
      }
      setAiResults(items)
      setStep(2)
    } catch (err) {
      // AI 调用失败自动降级为普通导入，不阻塞基础功能
      // 错误信息优先后端返回的 msg（如密钥无效、请求过于频繁），避免只显示 500/502
      setAiError(getErrorMessage(err, 'AI校验失败，将跳过智能判定'))
      setStep(2)
    } finally {
      setAiLoading(false)
      aiRequestInFlightRef.current = false
    }
  }

  // ---------- 时间周期智能识别（AI 兜底 + 本地二次校验） ----------
  // 构造识别面板初始数据（需要识别的时间周期原始值）
  const buildCycleReview = (values) => ({
    values,
    results: values.map((value) => ({ value, weekCode: '', skipped: false })),
    loading: false,
    error: '',
    notice: ''
  })

  // 识别结果 -> 原始值映射（跳过 / 识别失败均映射为 null，对应行按原规则判失败）
  const buildCycleMapping = (review) => {
    const mapping = {}
    for (const item of review.results) {
      mapping[item.value] = item.skipped ? null : parseTimeCycleToWeekCode(item.weekCode) || null
    }
    return mapping
  }

  // 面板中手动「跳过该行」的原始值 -> 命中这些值的行号（计入「跳过」统计）
  const collectSkippedRowIndexes = (rows, review) => {
    const skippedValues = (review?.results || []).filter((item) => item.skipped).map((item) => item.value)
    if (!skippedValues.length) return []
    const skippedSet = new Set(skippedValues)
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => skippedSet.has(row.time_cycle))
      .map((row) => row.rowIndex)
  }

  /**
   * 时间周期识别结果 -> 按 Excel 行号索引的备注（AI 输出 / AI 识别失败原因 / 手动跳过）
   * 用于 AI 校验区展示「原始内容 + AI 输出/失败原因」，以及失败明细导出的【AI识别备注】列
   */
  const buildCycleNotes = (rows, review) => {
    const notes = {}
    const rowList = Array.isArray(rows) ? rows : []
    for (const item of review?.results || []) {
      const note = item.skipped
        ? '用户手动跳过该行'
        : item.weekCode
          ? item.aiNote || `已识别为 ${item.weekCode}`
          : item.aiNote || '未能识别为完整自然周'
      for (const row of rowList) {
        if (row.time_cycle === item.value) notes[row.rowIndex] = note
      }
    }
    return notes
  }

  const updateCycleResult = (index, patch) => {
    setCycleReview((prev) =>
      prev
        ? {
            ...prev,
            results: prev.results.map((item, i) => (i === index ? { ...item, ...patch } : item))
          }
        : prev
    )
  }

  /**
   * 调用 AI 识别时间周期（显式传入 review，避免自动流程读到过期的 state）
   * 未配置密钥 / 接口失败时返回带 error 的 review，由调用方决定后续流程
   */
  const requestCycleRecognition = async (review) => {
    // 未配置密钥：明确提示，不发起 AI 请求
    const config = getAiConfig()
    if (!config?.apiKey) {
      const tip = '请先在右上角配置 API 密钥'
      message.warning(tip)
      return { ...review, loading: false, error: tip }
    }
    try {
      const res = await normalizeTimeCyclesAI(review.values)
      // 后端返回 { value, weekCode, error }：error 为 AI 给出的具体失败原因（如 ERROR:xxx）
      const resultMap = new Map((res.data || []).map((item) => [item.value, item]))
      return {
        ...review,
        loading: false,
        error: '',
        // AI 结果统一经本地二次校验（explainTimeCycle）：非完整自然周一律拦截，不提交后端
        results: review.results.map((item) => {
          if (item.skipped) return item
          const found = resultMap.get(item.value) || {}
          const aiOutput = String(found.weekCode || '').trim()
          const aiError = String(found.error || '').trim()
          if (!aiOutput) {
            return {
              ...item,
              weekCode: '',
              aiNote: `AI识别失败：${aiError || '未返回识别结果'}`
            }
          }
          const { weekCode, reason } = explainTimeCycle(aiOutput)
          if (!weekCode) {
            return {
              ...item,
              weekCode: '',
              aiNote: `AI识别失败：${aiError || reason}（AI输出：${aiOutput}）`
            }
          }
          return { ...item, weekCode, aiNote: `AI输出：${aiOutput}（${weekCode}）` }
        })
      }
    } catch (err) {
      return { ...review, loading: false, error: getErrorMessage(err) }
    }
  }

  const handleCycleAiRecognize = async () => {
    if (!cycleReview || cycleRequestInFlightRef.current) return
    cycleRequestInFlightRef.current = true
    setCycleReview((prev) =>
      prev ? { ...prev, loading: true, error: '', notice: '' } : prev
    )
    try {
      const recognized = await requestCycleRecognition(cycleReview)
      setCycleReview(recognized)
    } finally {
      cycleRequestInFlightRef.current = false
    }
  }

  // 继续原有校验流程（应用映射后 / 跳过识别时）
  const continueAfterCycleReview = async () => {
    setCycleReview(null)
    setStep(2)
  }

  /**
   * applyTimeCycleMapping 会基于 allRows 重新计算有效行，
   * 这里把 identity 阶段判为非新增的行重新排除，避免重复 / 更新行被放行成新 record。
   * 注意：这些行不属于「失败」，因此不再合并进 failedRows（各自单独统计）。
   */
  const reapplyDedupeExclusion = (result) => {
    const excluded = excludedRowsRef.current
    if (!excluded.length) return result
    const excludedIndexes = new Set(excluded.map((item) => item.rowIndex))
    const validRows = result.validRows.filter((row) => !excludedIndexes.has(row.rowIndex))
    return { ...result, validRows }
  }

  const admitValidatedRow = async (checked, rowIndex) => {
    const candidate = checked.validRows.find((row) => row.rowIndex === rowIndex)
    if (!candidate) return false
    // 新放行的行此前未参与去重，按现有规则与数据库和本次待导入行比较。
    let existing = []
    try {
      existing = await fetchAllRecords()
    } catch {
      // 与首次解析一致：拉取已有记录失败时仍执行文件内去重。
    }
    const classification = classifyImportRows(
      [candidate], [...existing, ...importRows.filter((row) => row.rowIndex !== rowIndex)]
    )
    if (!classification.newRecords.length) {
      const notNew = [
        ...classification.exactDuplicates,
        ...classification.existingNoop,
        ...classification.existingChanged,
        ...classification.identityUncertain
      ][0]
      const excluded = { rowIndex, reason: notNew?.reason || '与已有记录相同，未导入' }
      excludedRowsRef.current = [...excludedRowsRef.current, excluded]
      setIdentityReview((current) => {
        if (!current) return current
        const next = {
          newRecords: current.newRecords.filter((item) => item.row.rowIndex !== rowIndex),
          exactDuplicates: [...current.exactDuplicates],
          existingNoop: [...current.existingNoop],
          existingChanged: [...current.existingChanged],
          identityUncertain: [...current.identityUncertain]
        }
        if (notNew) {
          const bucket = classification.exactDuplicates.includes(notNew) ? 'exactDuplicates'
            : classification.existingNoop.includes(notNew) ? 'existingNoop'
            : classification.existingChanged.includes(notNew) ? 'existingChanged' : 'identityUncertain'
          next[bucket].push(notNew)
        }
        return next
      })
      setPreview({
        ...checked,
        validRows: checked.validRows.filter((row) => row.rowIndex !== rowIndex)
      })
      setImportRows((current) => current.filter((row) => row.rowIndex !== rowIndex))
      return false
    }
    setPreview(checked)
    setImportRows((current) => [...current.filter((row) => row.rowIndex !== rowIndex), candidate]
      .sort((a, b) => a.rowIndex - b.rowIndex))
    return true
  }

  const confirmCurrentSourceCycle = async (rowIndex) => {
    if (!preview || !confirmationRows.some((item) => item.rowIndex === rowIndex) || manualSaving) return
    setManualSaving(true)
    try {
      const confirmed = reapplyDedupeExclusion(confirmSourceTimeCycleConflict(preview, rowIndex))
      const admitted = await admitValidatedRow(confirmed, rowIndex)
      message[admitted ? 'success' : 'warning'](
        admitted
          ? `Excel 第${rowIndex}行已确认当前投放档期，可导入`
          : `Excel 第${rowIndex}行与现有记录重复，仍不会导入`
      )
    } catch (error) {
      message.error(getErrorMessage(error, '确认投放档期失败，请重试'))
    } finally {
      setManualSaving(false)
    }
  }

  const openManualCorrection = (rowIndex, fromAi = false) => {
    if (!failedRows.some((item) => item.rowIndex === rowIndex) &&
        !confirmationRows.some((item) => item.rowIndex === rowIndex) &&
        !(fromAi && aiMap.has(rowIndex) && importRows.some((row) => row.rowIndex === rowIndex))) return
    const row = preview?.allRows?.find((item) => item.rowIndex === rowIndex)
    if (!row) return
    manualForm.resetFields()
    manualForm.setFieldsValue(
      Object.fromEntries(MANUAL_EDIT_FIELDS.map((field) => [field, String(row[field] ?? '')]))
    )
    setManualEditError('')
    setManualEditFromAi(fromAi)
    setManualEditRowIndex(rowIndex)
  }

  const saveManualCorrection = async () => {
    if (!preview || manualEditRowIndex === null) return
    const original = preview.allRows.find((row) => row.rowIndex === manualEditRowIndex)
    const changes = manualForm.getFieldsValue()
    if (manualEditFromAi && !MANUAL_EDIT_FIELDS.some((field) =>
      String(original?.[field] ?? '') !== String(changes[field] ?? '')
    )) {
      setManualEditError('请先核对原始数据并调整字段；AI 建议不会自动写入。')
      return
    }
    setManualSaving(true)
    try {
      const rechecked = reapplyDedupeExclusion(
        applyManualImportCorrection(
          preview,
          manualEditRowIndex,
          changes,
          sourceCyclesRef.current,
          { allowValidRow: manualEditFromAi, aiSuggestionAdopted: manualEditFromAi }
        )
      )
      const repaired = rechecked.validRows.find((row) => row.rowIndex === manualEditRowIndex)
      if (!repaired) {
        // AI 建议行校验失败时保留原行；建议值不得进入待导入列表。
        if (!manualEditFromAi) setPreview(rechecked)
        setManualEditError(
          rechecked.confirmationRows?.find((item) => item.rowIndex === manualEditRowIndex)?.reason ||
          rechecked.failedRows.find((item) => item.rowIndex === manualEditRowIndex)?.reason ||
            '本地校验仍未通过，请检查填写内容。'
        )
        return
      }

      const admitted = await admitValidatedRow(rechecked, manualEditRowIndex)
      if (!admitted) {
        setManualEditRowIndex(null)
        message.warning(`Excel 第${manualEditRowIndex}行修正后与现有记录重复，仍不会导入`)
        return
      }

      if (manualEditFromAi) setAiResults((current) => current.filter((item) => item.rowIndex !== manualEditRowIndex))
      setManualEditRowIndex(null)
      setManualEditFromAi(false)
      setManualEditError('')
      message.success(`Excel 第${manualEditRowIndex}行已通过本地校验，可导入`)
    } catch (error) {
      message.error(getErrorMessage(error, '人工修正失败，请重试'))
    } finally {
      setManualSaving(false)
    }
  }

  const applyCycleMapping = async () => {
    if (!cycleReview || !preview) return
    // 手动跳过的行单独统计（不重复计入「失败」）
    setSkippedRowIndexes(collectSkippedRowIndexes(preview.allRows, cycleReview))
    // 记录每行的 AI 识别备注，供 AI 校验区与失败明细导出使用
    setCycleNotes(buildCycleNotes(preview.allRows, cycleReview))
    const updated = reapplyDedupeExclusion(
      applyTimeCycleMapping(preview, buildCycleMapping(cycleReview))
    )
    setPreview(updated)
    setImportRows(updated.validRows.map((row) => ({ ...row })))
    await continueAfterCycleReview(updated)
  }

  const skipCycleRecognition = async () => {
    if (!preview) return
    // 不应用识别结果：未识别值对应行按原有校验规则失败并被跳过
    await continueAfterCycleReview(preview)
  }

  // ---------- 字段映射确认（Batch 6A）----------
  // 映射面板初始数据由 excel.js 的纯函数构造：
  // 未识别表头一律默认「未选择」，系统 / AI 的建议只是建议，必须用户主动确认
  const buildMappingReview = (result) => buildHeaderMappingReview(result)

  // 对「仍无法确定」的未识别字段调用 AI 建议（AI = 增强建议，不是导入前置依赖）
  const requestFieldMappingSuggestions = async (review) => {
    const config = getAiConfig()
    if (!config?.apiKey) {
      return { ...review, loading: false, notice: '未配置 AI 密钥，请手动确认下列字段映射后继续' }
    }
    try {
      const columns = review.items.map((item) => ({ header: item.header, samples: item.samples }))
      const res = await suggestFieldMappingsAI(columns)
      const map = new Map((res.data?.suggestions || []).map((item) => [item.source_header, item]))
      return {
        ...review,
        loading: false,
        error: '',
        items: review.items.map((item) => {
          // 本地已有建议时不覆盖；AI 只补充「本地完全没识别」的字段
          if (item.suggestion) return item
          const hit = map.get(item.header)
          const field = String(hit?.suggested_field || '').trim()
          if (!field || field === 'UNKNOWN') return item
          return {
            ...item,
            // 仅作为「建议映射」展示，绝不自动填入用户的最终选择
            aiSuggestion: field,
            confidence: hit?.confidence || 'low',
            reason: hit?.reason || 'AI 建议',
            source: 'ai'
          }
        })
      }
    } catch (err) {
      // AI 失败不影响导入：退回手动映射
      return {
        ...review,
        loading: false,
        error: getErrorMessage(err),
        notice: 'AI 字段识别失败，请手动确认字段映射'
      }
    }
  }

  const handleMappingAiSuggestions = async () => {
    if (!mappingReview || mappingRequestInFlightRef.current) return
    mappingRequestInFlightRef.current = true
    setMappingReview((current) => current ? { ...current, loading: true } : current)
    try {
      setMappingReview(await requestFieldMappingSuggestions(mappingReview))
    } finally {
      mappingRequestInFlightRef.current = false
    }
  }

  const updateMappingItem = (index, patch) => {
    setMappingReview((prev) =>
      prev
        ? { ...prev, items: prev.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) }
        : prev
    )
  }

  // 目标字段冲突（同一目标字段有多个来源列）：本轮不做字段合并，必须由用户消除冲突
  const mappingConflicts = useMemo(
    () => detectMappingConflicts(mappingReview?.items || []),
    [mappingReview]
  )
  // 只要还有未识别字段没有明确选择（映射字段 或 忽略此列），就不允许继续
  const mappingIncomplete = !isMappingReviewComplete(mappingReview?.items || [])

  // 用户确认映射后：用同一份文件按确认的映射重新解析，再走原导入流程
  const applyHeaderMapping = async () => {
    if (!mappingReview || mappingConflicts.length || mappingIncomplete) return
    const overrides = {}
    for (const item of mappingReview.items) overrides[item.header] = item.target || IGNORE_FIELD
    setMappingReview(null)
    setParsing(true)
    try {
      const result = await parseRecordsExcel(sourceFileRef.current, sourceCyclesRef.current, {
        overrides
      })
      await runImportPipeline(result)
    } catch (err) {
      message.error(`文件解析失败：${err.message}`)
    } finally {
      setParsing(false)
    }
  }

  // ---------- 解析后的通用流程：本地校验/去重 -> 必要时确认周期 -> 预览 ----------
  const runImportPipeline = async (result) => {
      // 自动判定无效数据：与库中已有记录重复、文件内重复的行剔除
      excludedRowsRef.current = []
      setIdentityReview(null)
      setIncludeUpdates(false)
      setSkippedRowIndexes([])
      let classification = null
      try {
        const existing = await fetchAllRecords()
        // record identity：只有 newRecords 允许导入；其余（exact / noop / changed / uncertain）只识别不写入
        classification = classifyImportRows(result.validRows, existing)
        setIdentityReview(classification)
        result.validRows = classification.newRecords.map((item) => item.row)
        excludedRowsRef.current = [
          ...classification.exactDuplicates,
          ...classification.existingNoop,
          ...classification.existingChanged,
          ...classification.identityUncertain
        ].map((item) => ({ rowIndex: item.row.rowIndex, reason: item.reason }))
      } catch {
        // 拉取已有记录失败时跳过 identity 分类（不阻断解析）
      }
      // Preview 可用性 ≠ 可新增导入（见 isPreviewEligible 注释）
      if (
        !isPreviewEligible({
          classification,
          parsedValidCount: result.validRows.length,
          failedCount: result.failedRows?.length || 0,
          confirmationCount: result.confirmationRows?.length || 0
        })
      ) {
        message.warning('文件中没有有效数据')
        return false
      }

      setPreview(result)
      // 本地校验通过的记录先进入可导入列表，AI 校验由用户另行主动触发。
      setImportRows(result.validRows.map((row) => ({ ...row })))

      // 本地规则无法识别的时间周期：先进入智能识别面板（不直接放行/丢弃）
      const unknownCycles = result.unrecognizedTimeCycles || []
      if (unknownCycles.length > 0) {
        const review = buildCycleReview(unknownCycles)
        setCycleReview(review)
        setStep(1)
        return false
      }
      setStep(2)
      return false
  }

  // ---------- 上传 -> 解析 -> 字段映射确认 -> 本地校验/去重 -> 预览 ----------
  const handleFile = async (file) => {
    setParsing(true)
    try {
      // 获取周期选项：导入时「08/13-08/19」自动识别为对应 weekCode
      let cycles = []
      try {
        const cyclesRes = await getCycles()
        cycles = cyclesRes.data
      } catch {
        // 周期选项获取失败不影响解析，走兜底换算
      }
      // 记录本次上传的文件与周期选项：用户确认字段映射后需要用同一份文件重新解析
      sourceFileRef.current = file
      sourceCyclesRef.current = cycles
      const result = await parseRecordsExcel(file, cycles)

      // 存在未识别表头：先进入字段映射确认，绝不静默丢弃（Batch 6A P0 修复）
      const review = buildMappingReview(result)
      if (review) {
        setPreview(result)
        setMappingReview(review)
        setStep(1)
        return false
      }

      await runImportPipeline(result)
    } catch (err) {
      message.error(`文件解析失败：${err.message}`)
    } finally {
      setParsing(false)
    }
    return false // 阻止 antd Upload 自动上传
  }

  // ---------- 确认导入（导入修正后的数据） ----------
  /**
   * 二次确认：只要本次会写入已有记录（update），就必须由用户显式确认后才能调用后端。
   * 绝不在上传文件后自动更新。
   */
  const handleConfirmClick = () => {
    if (!updateIntents.length) {
      handleConfirm()
      return
    }
    const hasNew = importableRows.length > 0
    Modal.confirm({
      title: hasNew ? '确认导入并更新已有记录？' : '确认更新已有记录？',
      content: hasNew
        ? `将导入 ${importableRows.length} 条新记录，并更新 ${updateIntents.length} 条已有投放记录的累计播放量。系统会记录更新前的值，并支持批次回滚。`
        : `将更新 ${updateIntents.length} 条已有投放记录的累计播放量。系统会记录更新前的值，并支持批次回滚。`,
      okText: hasNew ? '导入并更新' : '确认更新',
      cancelText: '取消',
      onOk: () => handleConfirm()
    })
  }

  const handleConfirm = async () => {
    // 安全兜底：存在未确认的字段映射时，绝不允许正式导入（避免「假成功」）
    if (mappingReview) {
      message.warning('请先完成字段映射确认后再导入')
      return
    }
    // AI 结果只提示风险；正式导入资格由确定性本地校验决定。
    // Existing Record Update V0.1：update-only 场景允许「只更新已有记录」（无新增导入）。
    if (!importableRows.length && !updateIntents.length) return
    const locallyChecked = reapplyDedupeExclusion(applyTimeCycleMapping(preview, {}))
    const checkedByIndex = new Map(locallyChecked.validRows.map((row) => [row.rowIndex, row]))
    if (importableRows.some((row) => !checkedByIndex.has(row.rowIndex))) {
      message.error('导入前本地校验未通过，请重新检查记录')
      return
    }
    setImporting(true)
    setImportError('')
    try {
      const payload = importableRows.map((row) => checkedByIndex.get(row.rowIndex)).map(
        ({ rowIndex, sourceTimeCycle, sourceTimeCycleRaw, manualCorrection, manualCorrectionFields,
          aiSuggestionAdopted,
          sourceCycleConflictOrigin, sourceCycleConfirmed, ...record }) =>
          record
      )
      // 导入批次元数据（写入导入历史）：文件名 + 本次成功/失败/跳过/重复统计 + 行级明细
      // 说明：后端 status 允许 success / fail / skip / duplicate / updated。
      //   exact_duplicate / existing_noop 记为 duplicate（已有记录，本次不新增）；
      //   真实完成的字段更新记为 updated；需人工处理的更新 / 身份待确认记为 skip。
      //   批量口径与 import_batches 计数保持一致。
      const duplicateCount = identityReview
        ? identityReview.exactDuplicates.length + identityReview.existingNoop.length
        : 0
      const identityUncertainCount = identityReview ? identityReview.identityUncertain.length : 0
      const batchMeta = {
        fileName: preview?.fileName || '',
        totalCount:
          payload.length +
          updateIntents.length +
          confirmationRows.length +
          failedRows.length +
          excludedImportRows.length +
          importStats.跳过,
        failCount: failedRows.length,
        skipCount:
          importStats.跳过 + confirmationRows.length + identityUncertainCount + manualReviewCount,
        duplicateCount,
        items: [
          ...importableRows
            .filter((row) => row.manualCorrection || row.sourceCycleConfirmed || row.aiSuggestionAdopted)
            .map((row) => ({
              rowIndex: row.rowIndex,
              status: 'success',
              reason: [
                row.manualCorrection && `人工修正：${(row.manualCorrectionFields || [])
                  .map((field) => field === 'sourceTimeCycleRaw' ? '源时间周期' : FIELD_LABELS[field] || field)
                  .join('、')}`,
                row.aiSuggestionAdopted && 'AI建议 / 用户采用（已通过本地校验）',
                row.sourceCycleConfirmed && `人工确认当前投放档期：源周期 ${row.sourceTimeCycleRaw || ''}；发布日期 ${row.publish_date}`
              ].filter(Boolean).join('；')
            })),
          ...confirmationRows.map((item) => ({
            rowIndex: item.rowIndex,
            status: 'skip',
            reason: `需人工确认，未导入：${item.reason}`
          })),
          ...failedRows.map((item) => ({
            rowIndex: item.rowIndex,
            status: 'fail',
            reason: item.reason || '本地校验或 AI 校验未通过'
          })),
          // 真实完成的已有记录更新（不再伪装成 duplicate）
          ...updateIntents.map((intent) => ({
            rowIndex: null,
            status: 'updated',
            reason: `更新已有记录 #${intent.record_id} 的累计播放量：${
              intent.expected_before === null ? '（未观察）' : intent.expected_before
            } → ${intent.desired_after}`
          })),
          ...excludedImportRows.map((item) => ({
            rowIndex: item.rowIndex,
            status:
              item.kind === 'identity_uncertain' || item.kind === 'manual_review'
                ? 'skip'
                : 'duplicate',
            reason:
              item.kind === 'manual_review'
                ? item.reason || '需人工处理，未自动写入'
                : item.kind === 'existing_noop'
                  ? `同一条已有记录，Excel 未提供更强的新信息，未导入：${item.reason || ''}`
                  : item.reason || '与已有记录重复，未导入'
          })),
          ...skippedRowIndexes.map((rowIndex) => ({
            rowIndex,
            status: 'skip',
            reason: cycleNotes[rowIndex] || '手动跳过该行'
          }))
        ]
      }
      // 前端只提交 record_id / expected_before / desired_after；field_name 由后端固定为 second_week_play
      const res = await batchCreateRecords(payload, batchMeta, updateIntents)
      const batchId = res.data?.batchId
      const updatedCount = res.data?.updatedCount || 0
      // 成功提示中提供「查看批次」快捷入口（跳转导入历史并自动展开该批次）
      if (batchId) {
        message.success({
          duration: 6,
          content: (
            <span>
              成功导入 {res.data.count} 条记录
              {updatedCount > 0 && `，更新 ${updatedCount} 条已有记录`}
              <a
                style={{ marginLeft: 8 }}
                onClick={() => {
                  onSuccess?.()
                  closeModal()
                  navigate(`/import-history?batchId=${batchId}`)
                }}
              >
                查看批次
              </a>
            </span>
          )
        })
      } else {
        message.success(
          updatedCount > 0
            ? `成功导入 ${res.data.count} 条记录，更新 ${updatedCount} 条已有记录`
            : `成功导入 ${res.data.count} 条记录`
        )
      }
      if (failedRows.length) {
        message.warning(`${failedRows.length} 条本地校验失败数据已跳过`)
      }
      onSuccess?.()
      closeModal()
    } catch (err) {
      // 导入失败：保留错误信息与当前数据，便于修正后重试（拦截器同时给出提示）
      setImportError(getErrorMessage(err, '导入失败，请检查数据后重试'))
    } finally {
      setImporting(false)
    }
  }

  // ---------- AI 结果列表项 ----------
  const renderAiItem = (item) => {
    const row = item.rawRow || importRows.find((r) => r.rowIndex === item.rowIndex)
    const levelTag =
      item.level === 'error' ? (
        <Tag color="error">错误</Tag>
      ) : item.level === 'warning' ? (
        <Tag color="orange">警告</Tag>
      ) : (
        <Tag color="success">通过</Tag>
      )
    const detailRows = buildAiDetailRows(item, cycleNotes)
    const rowNote = cycleNotes[item.rowIndex] || ''
    return (
      <List.Item style={{ padding: 0 }}>
        <Collapse
          size="small"
          style={{ width: '100%' }}
          items={[
            {
              key: String(item.rowIndex ?? 'unknown'),
              label: (
                <Space size={8} wrap>
                  <Typography.Text strong>{formatRowLabel(item.rowIndex)}</Typography.Text>
                  {row?.nickname && (
                    <Typography.Text type="secondary">{row.nickname}</Typography.Text>
                  )}
                  {levelTag}
                  {detailRows.length > 0 && (
                    <Typography.Text type="secondary">
                      问题 {detailRows.length} 项
                    </Typography.Text>
                  )}
                  {rowNote && (
                    <Typography.Text
                      type={rowNote.startsWith('AI识别失败') ? 'danger' : 'secondary'}
                      style={{ maxWidth: 260 }}
                      ellipsis={{ tooltip: rowNote }}
                    >
                      {rowNote}
                    </Typography.Text>
                  )}
                </Space>
              ),
              children: (
                <Space direction="vertical" size="small" style={{ display: 'flex' }}>
                  {/* 结构化问题明细：行号 / 涉及字段 / 原始值 / 原因 / 优化建议 */}
                  {detailRows.length > 0 ? (
                    <Table
                      size="small"
                      rowKey="key"
                      pagination={false}
                      dataSource={detailRows}
                      scroll={{ x: 640 }}
                      columns={[
                        {
                          title: '行号',
                          dataIndex: 'rowIndex',
                          width: 90,
                          render: (value) => formatRowLabel(value)
                        },
                        {
                          title: '级别',
                          dataIndex: 'level',
                          width: 80,
                          render: (value) =>
                            value === 'error' ? (
                              <Tag color="error">错误</Tag>
                            ) : (
                              <Tag color="orange">警告</Tag>
                            )
                        },
                        { title: '涉及字段', dataIndex: 'field', width: 110 },
                        { title: '原始值', dataIndex: 'originalValue', width: 120, ellipsis: true },
                        {
                          title: 'AI输出/识别备注',
                          dataIndex: 'aiNote',
                          width: 200,
                          render: (value) =>
                            value ? (
                              <Typography.Text
                                type={String(value).startsWith('AI识别失败') ? 'danger' : undefined}
                                style={{ fontSize: 12 }}
                              >
                                {value}
                              </Typography.Text>
                            ) : (
                              <Typography.Text type="secondary">—</Typography.Text>
                            )
                        },
                        { title: '原因', dataIndex: 'reason', width: 220 },
                        { title: '优化建议', dataIndex: 'suggestion', width: 220 }
                      ]}
                    />
                  ) : item.issues.length > 0 || item.suggestions.length > 0 ? (
                    // 兼容旧版自由文本返回（无结构化 warnings/errors）
                    <>
                      {item.issues.length > 0 && (
                        <div>
                          <Typography.Text strong>问题描述：</Typography.Text>
                          {item.issues.map((issue, index) => (
                            <div key={`issue-${index}`}>
                              <Typography.Text type="danger">{issue}</Typography.Text>
                            </div>
                          ))}
                        </div>
                      )}
                      {item.suggestions.length > 0 && (
                        <div>
                          <Typography.Text strong>优化建议：</Typography.Text>
                          {item.suggestions.map((suggestion, index) => (
                            <div key={`suggestion-${index}`}>
                              <Typography.Text type="warning">{suggestion}</Typography.Text>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <Typography.Text type="secondary">
                      {item.level === 'info' ? '本行无问题，可直接导入' : AI_RESULT_INVALID_TIP}
                    </Typography.Text>
                  )}
                  {item.corrected && Object.keys(item.corrected).length > 0 && (
                    <div>
                      <Typography.Text strong>AI 建议修改（不会自动写入）：</Typography.Text>
                      <Space direction="vertical" size={4} style={{ display: 'flex' }}>
                        {Object.entries(item.corrected).map(([key, value]) => (
                          <Typography.Text key={key}>
                            {FIELD_LABELS[key] || key}：{String(row?.[key] ?? '（空）')} → {String(value ?? '（空）')}
                          </Typography.Text>
                        ))}
                      </Space>
                    </div>
                  )}
                  {importRows.some((candidate) => candidate.rowIndex === item.rowIndex) && (
                    <Button size="small" onClick={() => openManualCorrection(item.rowIndex, true)}>
                      参考建议，逐条人工调整
                    </Button>
                  )}
                </Space>
              )
            }
          ]}
        />
      </List.Item>
    )
  }

  // ---------- 底部按钮 ----------
  // 预览可用性 ≠ 可新增导入：update-only / 全重复文件也要能进入预览查看分类。
  // 无新记录时主操作不能显示 0 条「确认导入」，更不能 POST 空批次。
  // Existing Record Update V0.1：可按用户选择执行「只导入新增 / 同时更新已有记录 / 只更新已有记录」。
  const importLabel = hasNewRecords
    ? applyUpdates && safeUpdateCount > 0
      ? `导入 ${importableRows.length} 条新记录并更新 ${safeUpdateCount} 条已有记录`
      : `确认导入（${importableRows.length} 条）`
    : safeUpdateCount > 0
      ? `更新已有记录（${safeUpdateCount} 条）`
      : '当前无新记录可导入'
  const confirmDisabled = importing || (!hasNewRecords && updateIntents.length === 0)

  const renderFooter = () => {
    if (!preview) {
      return <Button onClick={closeModal}>关闭</Button>
    }
    // 字段映射确认：未确认完成前不允许进入导入（避免未识别列静默丢失后仍提示成功）
    if (mappingReview) {
      return (
        <Space>
          <Button onClick={closeModal} disabled={parsing}>
            取消
          </Button>
          <Button
            type="primary"
            onClick={applyHeaderMapping}
            loading={parsing}
            disabled={mappingReview.loading || mappingIncomplete || mappingConflicts.length > 0}
          >
            确认字段映射并继续
          </Button>
        </Space>
      )
    }
    if (step === 2) {
      return (
        <Space>
          <Button onClick={closeModal} disabled={importing}>
            取消
          </Button>
          <Button onClick={resetUpload} disabled={importing}>
            重新上传
          </Button>
          <Button
            type="primary"
            onClick={handleConfirmClick}
            loading={importing}
            disabled={confirmDisabled}
          >
            {importLabel}
          </Button>
        </Space>
      )
    }
    return <Button onClick={closeModal}>关闭</Button>
  }

  return (
    <>
    <Modal
      title="导入Excel"
      open={open}
      onCancel={closeModal}
      zIndex={1000}
      width={820}
      footer={renderFooter()}
    >
      {/* 步骤条 */}
      <Steps
        current={step}
        size="small"
        items={[{ title: '上传文件' }, { title: '字段/周期确认' }, { title: '预览与导入' }]}
        style={{ marginBottom: 16 }}
      />

      {/* 步骤1：上传文件 */}
      {step === 0 && (
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Spin spinning={parsing} tip="正在解析文件...">
            <Dragger
              accept=".xlsx,.xls"
              multiple={false}
              showUploadList={false}
              beforeUpload={handleFile}
              disabled={parsing}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽文件到此处上传</p>
              <p className="ant-upload-hint">
                仅支持 .xlsx / .xls；上传后只进行本地解析与校验，AI 需另行主动点击
              </p>
            </Dragger>
          </Spin>

          {/* 高级规则配置 */}
          <Collapse
            items={[
              {
                key: 'advanced-rules',
                label: '高级规则（可选）',
                children: (
                  <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
                    <Checkbox.Group
                      options={RULE_OPTIONS}
                      value={selectedRules}
                      onChange={(values) => setSelectedRules(values)}
                    />
                    <div>
                      <Typography.Text type="secondary">
                        自定义判定条件（自然语言，每行一条，随请求发送给 AI）：
                      </Typography.Text>
                      <Input.TextArea
                        rows={3}
                        placeholder={'例如：美妆类达人CPM不应超过50，超过则标红提示\n例如：总花费超过10万的记录需要重点审核\n例如：播放量低于1000的疑似无效投放'}
                        value={customRules}
                        onChange={(e) => setCustomRules(e.target.value)}
                        style={{ marginTop: 4 }}
                      />
                    </div>
                  </Space>
                )
              }
            ]}
          />
        </Space>
      )}

      {/* 步骤1.5：字段映射确认（Batch 6A：存在未识别表头时必须先确认，不允许静默丢弃） */}
      {mappingReview && (
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Alert
            type="warning"
            showIcon
            message={`发现 ${mappingReview.items.length} 个未识别字段，请确认后再导入`}
            description="下列源字段未匹配到系统已知列名，请为每一列选择对应字段，或明确选择「忽略此列」。全部确认前无法进入导入。"
          />
          <Space wrap>
            <Typography.Text type="secondary">
              点击后仅向 {aiProviderLabel} 发送未知表头及每列最多 5 个短样例；不会发送整份 Excel。
            </Typography.Text>
            <Button onClick={handleMappingAiSuggestions} loading={mappingReview.loading}>
              AI 字段映射建议
            </Button>
          </Space>
          {mappingIncomplete && (
            <Alert
              type="info"
              showIcon
              message="请为所有未识别字段选择映射关系，或明确选择「忽略此列」。"
            />
          )}
          {mappingReview.loading && (
            <Typography.Text type="secondary">正在请求 AI 识别字段含义…</Typography.Text>
          )}
          {mappingReview.error && <Alert type="error" showIcon message={mappingReview.error} />}
          {mappingReview.notice && <Alert type="info" showIcon message={mappingReview.notice} />}
          <Table
            size="small"
            rowKey="header"
            pagination={false}
            dataSource={mappingReview.items}
            scroll={{ y: 240 }}
            columns={[
              {
                title: '源字段',
                dataIndex: 'header',
                width: 200,
                render: (value, record) => (
                  <Space direction="vertical" size={0} style={{ display: 'flex' }}>
                    <Typography.Text strong>{value}</Typography.Text>
                    {record.samples.length > 0 && (
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12 }}
                        ellipsis={{ tooltip: record.samples.join(' / ') }}
                      >
                        样例：{record.samples.slice(0, 3).join(' / ')}
                      </Typography.Text>
                    )}
                  </Space>
                )
              },
              {
                title: '建议映射',
                dataIndex: 'suggestion',
                width: 150,
                render: (_value, record) => {
                  const field = record.suggestion || record.aiSuggestion || ''
                  if (!field) return <Typography.Text type="secondary">未识别</Typography.Text>
                  const option = MAPPING_FIELD_OPTIONS.find((item) => item.value === field)
                  return (
                    <Tag color={record.source === 'ai' ? 'blue' : 'green'}>
                      {option ? option.label : field}
                      {record.source === 'ai' ? '（AI）' : ''}
                    </Tag>
                  )
                }
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 100,
                render: (_value, record) =>
                  record.target ? (
                    <Tag color="orange">待确认</Tag>
                  ) : (
                    <Tag color="error">未选择</Tag>
                  )
              },
              {
                title: '你的选择',
                dataIndex: 'target',
                render: (value, _record, index) => (
                  <Select
                    value={value || undefined}
                    disabled={mappingReview.loading}
                    placeholder="请选择"
                    style={{ width: 170 }}
                    status={value ? undefined : 'error'}
                    options={MAPPING_FIELD_OPTIONS}
                    onChange={(next) => updateMappingItem(index, { target: next })}
                  />
                )
              }
            ]}
          />
          {mappingConflicts.length > 0 && (
            <Alert
              type="error"
              showIcon
              message="已有字段映射冲突，请确认"
              description={mappingConflicts.map((item) => (
                <div key={item.field}>
                  「{FIELD_LABELS[item.field] || item.field}」被多个源字段同时映射：
                  {item.headers.join('、')}（同一目标字段只能有一个来源列）
                </div>
              ))}
            />
          )}
        </Space>
      )}

      {/* 步骤2：时间周期智能识别（本地规则无法识别时） */}
      {step === 1 && cycleReview && (
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Alert
            type="info"
            showIcon
            message={`检测到 ${cycleReview.values.length} 种无法识别的时间周期，可主动点击 AI 智能识别`}
            description={`点击后仅向 ${aiProviderLabel} 发送这些原始周期文本，不发送 Excel 原文件。`}
          />
          <Space wrap>
            <Button
              type="primary"
              loading={cycleReview.loading}
              onClick={handleCycleAiRecognize}
            >
              AI 智能识别
            </Button>
            <Button onClick={skipCycleRecognition} disabled={cycleReview.loading}>
              跳过识别，继续导入
            </Button>
          </Space>
          {cycleReview.error && <Alert type="error" showIcon message={cycleReview.error} />}
          {cycleReview.notice && <Alert type="warning" showIcon message={cycleReview.notice} />}
          <Table
            size="small"
            rowKey="value"
            pagination={false}
            dataSource={cycleReview.results}
            scroll={{ y: 260 }}
            columns={[
              { title: '原始单元格内容', dataIndex: 'value', width: 180, ellipsis: true },
              {
                title: 'AI识别备注（输出/失败原因）',
                dataIndex: 'aiNote',
                width: 260,
                render: (value, record) => {
                  const note = value || (record.loading ? '识别中…' : '')
                  if (!note) return <Typography.Text type="secondary">—</Typography.Text>
                  const isError = String(note).startsWith('AI识别失败')
                  return (
                    <Typography.Text type={isError ? 'danger' : 'secondary'}>
                      {note}
                    </Typography.Text>
                  )
                }
              },
              {
                title: '识别结果（可手动修改）',
                dataIndex: 'weekCode',
                render: (value, record, index) => {
                  const typed = String(value || '').trim()
                  const invalid = !record.skipped && typed !== '' && !parseTimeCycleToWeekCode(typed)
                  // 未填写或填写非法时给出具体原因（区分空值 / 非自然周 / 写法无法识别）
                  const reason = !record.skipped && !typed && !record.loading
                    ? record.aiNote || '请手动填写标准周码，如 2026-W33'
                    : invalid
                      ? explainTimeCycle(typed).reason
                      : ''
                  return (
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Input
                        value={value}
                        placeholder="如 2026-W33"
                        disabled={record.skipped || cycleReview.loading}
                        status={invalid ? 'error' : undefined}
                        onChange={(e) => updateCycleResult(index, { weekCode: e.target.value })}
                      />
                      {reason && <Typography.Text type="danger">{reason}</Typography.Text>}
                    </Space>
                  )
                }
              },
              {
                title: '跳过该行',
                dataIndex: 'skipped',
                width: 100,
                render: (checked, _record, index) => (
                  <Checkbox
                    checked={checked}
                    disabled={cycleReview.loading}
                    onChange={(e) => updateCycleResult(index, { skipped: e.target.checked })}
                  />
                )
              }
            ]}
          />
          <Space>
            <Button type="primary" onClick={applyCycleMapping} disabled={cycleReview.loading}>
              确认应用
            </Button>
          </Space>
        </Space>
      )}

      {/* 步骤3：确认导入（AI 结果 + 修正 + 预览） */}
      {step === 2 && preview && (
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Alert
            type="info"
            showIcon
            message={`已解析：${preview.fileName}`}
            description={
              <>
                匹配字段：
                {preview.mappedFields.length
                  ? preview.mappedFields.map((field) => FIELD_LABELS[field] || field).join('、')
                  : '无'}
                {preview.missingFields.length > 0 && (
                  <div style={{ color: '#d46b08' }}>
                    缺失必填列（对应行将被判定失败）：
                    {preview.missingFields.map((field) => FIELD_LABELS[field] || field).join('、')}
                  </div>
                )}
                {(preview.ignoredHeaders?.length > 0 ||
                  preview.systemIgnoredHeaders?.length > 0) && (
                  <div style={{ color: '#8c8c8c' }}>
                    已忽略列（不参与导入）：
                    {[...(preview.ignoredHeaders || []), ...(preview.systemIgnoredHeaders || [])].join(
                      '、'
                    )}
                  </div>
                )}
              </>
            }
          />

          {/* update-only / 全重复文件：允许进入预览查看分类，并明确当前可执行的操作 */}
          {identityReview && identityReview.newRecords.length === 0 && (
            <Alert
              type={safeUpdateCount > 0 ? 'warning' : 'info'}
              showIcon
              message={
                safeUpdateCount > 0
                  ? `当前无新记录可导入；可安全更新 ${safeUpdateCount} 条已有记录`
                  : manualReviewCount > 0
                    ? `未发现新记录；${manualReviewCount} 条已有记录变化需人工处理`
                    : '未发现新记录或可更新数据。'
              }
              description={
                safeUpdateCount > 0 ? (
                  <div>
                    本次没有可新增导入的记录；可将下方「可安全更新已有记录」中的累计播放量写入已有记录。
                    系统会记录更新前的值，并支持批次回滚；删除 / 其它字段变化不会自动写入。
                  </div>
                ) : manualReviewCount > 0 ? (
                  <div>
                    已有记录的变化均不满足安全更新条件（仅允许累计播放量安全增长），只做识别与展示，不会自动写入。
                  </div>
                ) : (
                  <div>
                    文件中的业务行均为已存在记录（完全重复 / 已有记录无新增信息）或需人工确认的行，
                    本次没有可新增导入的记录。
                  </div>
                )
              }
            />
          )}

          {/* ============ 阶段一：本地校验结果（解析 + 本地规则，与 AI 无关） ============ */}
          <Divider orientation="left" style={{ margin: '4px 0' }}>
            <Typography.Text strong>本地校验结果</Typography.Text>
            <Typography.Text type="secondary" style={{ marginLeft: 8, fontWeight: 'normal' }}>
              （Excel 解析 + 格式/必填/去重规则，AI 未参与）
            </Typography.Text>
          </Divider>

          {/* 本地统计：按 record identity 分类（新记录 / 可安全更新 / 需人工处理 / 已有无新信息 / 完全重复 / 需人工确认身份 / 跳过 / 需确认 / 失败） */}
          <Row gutter={[12, 12]}>
            <Col xs={12} md={6}>
              <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
                <Statistic
                  title="新记录（可导入）"
                  value={importStats.新记录}
                  valueStyle={{ color: '#52c41a', fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
                <Statistic
                  title="可安全更新"
                  value={importStats.可安全更新}
                  valueStyle={{ color: importStats.可安全更新 ? '#faad14' : undefined, fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
                <Statistic
                  title="需人工处理"
                  value={importStats.需人工处理}
                  valueStyle={{ color: importStats.需人工处理 ? '#faad14' : undefined, fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
                <Statistic
                  title="已有记录无新增信息"
                  value={importStats.已有记录无新增信息}
                  valueStyle={{ fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
                <Statistic
                  title="完全重复"
                  value={importStats.完全重复}
                  valueStyle={{ color: importStats.完全重复 ? '#faad14' : undefined, fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
                <Statistic
                  title="需人工确认身份"
                  value={importStats.需人工确认身份}
                  valueStyle={{ color: importStats.需人工确认身份 ? '#faad14' : undefined, fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} md={4}>
              <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
                <Statistic
                  title="跳过"
                  value={importStats.跳过}
                  valueStyle={{ fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} md={4}>
              <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
                <Statistic
                  title="需确认"
                  value={importStats.需确认}
                  valueStyle={{ color: importStats.需确认 ? '#faad14' : undefined, fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} md={4}>
              <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
                <Statistic
                  title="失败"
                  value={importStats.失败}
                  valueStyle={{ color: importStats.失败 ? '#ff4d4f' : undefined, fontSize: 22 }}
                />
              </Card>
            </Col>
          </Row>

          {/* 导入失败提示：保留错误信息，便于修正后重试 */}
          {importError && (
            <Alert
              type="error"
              showIcon
              message="导入失败"
              description={importError}
            />
          )}

          {/* 来源档期与发布日期冲突：需业务确认，确认前不进入可导入列表 */}
          {confirmationRows.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`需确认 ${confirmationRows.length} 条（确认前不会导入）`}
              description={
                <div style={{ maxHeight: 180, overflow: 'auto' }}>
                  {confirmationRows.map((item) => {
                    const row = preview.allRows.find((candidate) => candidate.rowIndex === item.rowIndex)
                    return (
                      <div key={item.rowIndex} style={{ marginBottom: 8 }}>
                        <div>
                          Excel 第{item.rowIndex}行：{row?.nickname}；发布日期 {row?.publish_date}；源时间周期{' '}
                          {row?.sourceTimeCycleRaw}。{item.reason}
                        </div>
                        <Space size="small" style={{ marginTop: 4 }}>
                          <Button size="small" type="primary" disabled={manualSaving}
                            onClick={() => confirmCurrentSourceCycle(item.rowIndex)}>
                            确认当前投放档期
                          </Button>
                          <Button size="small" disabled={manualSaving}
                            onClick={() => openManualCorrection(item.rowIndex)}>
                            人工调整
                          </Button>
                        </Space>
                      </div>
                    )
                  })}
                </div>
              }
            />
          )}

          {/* 本地失败明细：本地校验不通过的行，可一键下载明细 */}
          {failedRows.length > 0 && (
            <Alert
              type="error"
              showIcon
              message={`失败 ${failedRows.length} 条（导入时将跳过）`}
              action={
                <Button size="small" onClick={handleDownloadFailedRows}>
                  下载失败明细
                </Button>
              }
              description={
                <div style={{ maxHeight: 140, overflow: 'auto' }}>
                  {failedRows.map((item) => (
                    <div key={item.rowIndex} style={{ marginBottom: 6 }}>
                      <Space align="start">
                        <span>Excel 第{item.rowIndex}行：{item.reason}</span>
                        <Button size="small" onClick={() => openManualCorrection(item.rowIndex)}>
                          人工修正
                        </Button>
                      </Space>
                    </div>
                  ))}
                </div>
              }
            />
          )}

          {/* Existing Record Update V0.1：可安全更新（只允许累计播放量安全增长） */}
          {updatePlan.safeUpdates.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`可安全更新已有记录（${updatePlan.safeUpdates.length}）`}
              description={
                <div style={{ maxHeight: 260, overflow: 'auto' }}>
                  <div style={{ color: '#8c8c8c', marginBottom: 6 }}>
                    这些行的视频链接与库中已有记录相同（同一条内容），且仅累计播放量安全增长；
                    确认后只更新累计播放量，不会新增重复记录，也不会覆盖其它字段。
                  </div>
                  {updatePlan.safeUpdates.map((item) => (
                    <div key={item.row.rowIndex} style={{ marginBottom: 8 }}>
                      <div>
                        {item.row.nickname}；发布日期 {item.row.publish_date}；视频链接 {item.row.video_link}
                      </div>
                      <div style={{ color: '#d46b08' }}>
                        累计播放量：{String(item.update.before ?? '（未观察）')} → {String(item.update.after)}
                      </div>
                      {(item.diffs || [])
                        .filter((diff) => diff.change_type === 'incoming_missing')
                        .map((diff) => (
                          <div key={diff.field} style={{ color: '#8c8c8c' }}>
                            Excel 未提供{RECORD_FACT_LABELS[diff.field] || diff.field}，保留已有值
                            {String(diff.existing_value ?? '')}
                          </div>
                        ))}
                    </div>
                  ))}
                  <div style={{ color: '#8c8c8c', marginTop: 6 }}>
                    更新前会记录当前值，支持按批次回滚；删除 / 其它字段变化不会自动写入。
                  </div>
                </div>
              }
            />
          )}

          {/* Existing Record Update V0.1：不满足安全更新条件的已有记录变化 → 需人工处理 */}
          {updatePlan.manualReview.length > 0 && (
            <Alert
              type="info"
              showIcon
              message={`${updatePlan.manualReview.length} 条已有记录变化需人工处理（不自动写入）`}
              description={
                <div style={{ maxHeight: 200, overflow: 'auto' }}>
                  {updatePlan.manualReview.map((item) => (
                    <div key={item.row.rowIndex} style={{ marginBottom: 6 }}>
                      Excel 第{item.row.rowIndex}行：{item.row.nickname}；{item.update?.reason}
                    </div>
                  ))}
                </div>
              }
            />
          )}

          {/* mixed：显式选择是否同时更新已有记录（默认不勾选，只导入新增） */}
          {hasNewRecords && updatePlan.safeUpdates.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={
                <Checkbox checked={includeUpdates} onChange={(e) => setIncludeUpdates(e.target.checked)}>
                  同时更新 {updatePlan.safeUpdates.length} 条已有记录的累计播放量
                </Checkbox>
              }
              description={
                <span style={{ color: '#8c8c8c' }}>
                  不勾选时只导入新增记录；勾选后会在同一批次内更新已有记录，并记录更新前的值以支持回滚。
                </span>
              }
            />
          )}

          {/* 完全重复 / 已有无新增信息 / 身份待确认：均不导入 */}
          {excludedImportRows.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`不导入 ${excludedImportRows.length} 条（完全重复 ${
                importStats.完全重复
              } 条 · 需人工处理 ${importStats.需人工处理} 条 · 已有无新增信息 ${
                importStats.已有记录无新增信息
              } 条 · 身份待确认 ${importStats.需人工确认身份} 条）`}
              description={
                <div style={{ maxHeight: 200, overflow: 'auto' }}>
                  {excludedImportRows.map((item) => (
                    <div key={item.rowIndex}>
                      Excel 第 {item.rowIndex} 行：{item.reason}
                    </div>
                  ))}
                </div>
              }
            />
          )}

          {/* 跳过的行：空白行 + 时间周期识别面板中手动跳过的行 */}
          {importStats.跳过 > 0 && (
            <Alert
              type="info"
              showIcon
              message={`跳过 ${importStats.跳过} 条（空白行 ${preview.blankRows || 0} 条${
                headerRowIndexes.length ? `，重复表头行 ${headerRowIndexes.length} 条` : ''
              }${
                skippedRowIndexes.length ? `，手动跳过 ${skippedRowIndexes.length} 条` : ''
              }）`}
              description={
                skippedRowIndexes.length || blankRowIndexes.length || headerRowIndexes.length ? (
                  <div style={{ maxHeight: 100, overflow: 'auto' }}>
                    {blankRowIndexes.length > 0 && (
                      <div>空白行：第 {blankRowIndexes.join('、')} 行</div>
                    )}
                    {headerRowIndexes.length > 0 && (
                      <div>重复表头行：第 {headerRowIndexes.join('、')} 行</div>
                    )}
                    {skippedRowIndexes.length > 0 && (
                      <div>手动跳过：第 {skippedRowIndexes.join('、')} 行</div>
                    )}
                  </div>
                ) : null
              }
            />
          )}

          {/* ============ 阶段二：AI 校验结果（本地校验通过后才执行） ============ */}
          <Divider orientation="left" style={{ margin: '4px 0' }}>
            <Typography.Text strong>AI 校验结果</Typography.Text>
            <Typography.Text type="secondary" style={{ marginLeft: 8, fontWeight: 'normal' }}>
              （主动触发；结果仅供核对，不改变本地校验结果）
            </Typography.Text>
          </Divider>

          <Alert
            type="info"
            showIcon
            message={`AI 智能校验 · ${aiProviderLabel}`}
            description={`点击后会将本次分析所需的达人信息、链接、花费、发布日期、时间周期和播放数据发送给 ${aiProviderLabel}。不会上传 Excel 原文件；AI 建议不会自动修改记录。`}
            action={
              <Button
                type="primary"
                size="small"
                onClick={() => runAiValidation(importRows)}
                loading={aiLoading}
                disabled={importing || importRows.length === 0}
              >
                AI 智能校验
              </Button>
            }
          />

          {/* 无密钥 / 调用失败：降级提示，不影响基础导入 */}
          {aiError ? (
            <Alert
              type="warning"
              showIcon
              message="AI校验失败，将跳过智能判定"
              description={
                <>
                  {aiError}
                  <div>基础导入功能不受影响，可直接确认导入。</div>
                </>
              }
              action={
                <Button size="small" onClick={() => runAiValidation(importRows)}>
                  重试AI校验
                </Button>
              }
            />
          ) : aiFormatError ? (
            <Alert
              type="error"
              showIcon
              message={AI_RESULT_INVALID_TIP}
              description="未解析到有效的校验条目，请点击重试；你也可以直接确认导入（不拦截基础流程）。"
              action={
                <Button size="small" onClick={() => runAiValidation(importRows)}>
                  重试AI校验
                </Button>
              }
            />
          ) : (
            <>
              {aiResults.length === 0 && (
                <Typography.Text type="secondary">
                  尚未运行 AI 智能校验；可直接按本地校验结果导入。
                </Typography.Text>
              )}
              {/* AI 校验统计：通过 / 警告 / 错误 */}
              <Space size="middle" wrap>
                <Tag>共 {stats.total} 条</Tag>
                <Tag color="success">通过 {stats.pass} 条</Tag>
                <Tag color="orange">警告 {stats.warning} 条</Tag>
                <Tag color="error">错误 {stats.error} 条</Tag>
              </Space>

              {aiErrors.length > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  message={`${aiErrors.length} 条 AI 风险提示，请核对原始数据`}
                  description={`涉及：${aiErrors.map((r) => formatRowLabel(r.rowIndex)).join('、')}。AI 不会自动修改或跳过记录；人工调整后会重新执行本地校验。`}
                />
              )}

              {/* AI 判定结果列表（每条含行号 / 字段 / 原始值 / 原因 / 优化建议） */}
              <List size="small" dataSource={aiResults} renderItem={renderAiItem} />
            </>
          )}

          {/* 修正后数据预览（前 5 条） */}
          <div>
            <Typography.Text strong>修正后数据预览（前 5 条）</Typography.Text>
            <Table
              size="small"
              rowKey="rowIndex"
              columns={PREVIEW_COLUMNS}
              dataSource={importRows.slice(0, 5)}
              pagination={false}
              scroll={{ x: 700 }}
              style={{ marginTop: 8 }}
            />
          </div>
        </Space>
      )}
    </Modal>
    <Modal
      title={`人工修正 · Excel 第${manualEditRowIndex ?? ''}行`}
      open={manualEditRowIndex !== null}
      zIndex={2000}
      onCancel={() => {
        if (!manualSaving) {
          setManualEditRowIndex(null)
          setManualEditFromAi(false)
        }
      }}
      onOk={saveManualCorrection}
      okText="保存并重新校验"
      confirmLoading={manualSaving}
      forceRender
      width={600}
    >
      <Typography.Paragraph type="secondary">
        {manualEditIsSourceConflict
          ? '发布日期保留原值；可调整源时间周期。最终自然周仍由发布日期自动计算。'
          : '仅修改本次导入会话；最终时间周期由发布日期自动计算，源时间周期只用于核对 Excel 原分组。'}
      </Typography.Paragraph>
      <Form form={manualForm} layout="vertical">
        {MANUAL_EDIT_FIELDS.map((field) => (
          <Form.Item
            key={field}
            name={field}
            label={field === 'sourceTimeCycleRaw' ? '源时间周期' : FIELD_LABELS[field] || field}
          >
            <Input
              placeholder={field === 'publish_date' ? 'YYYY-MM-DD' : undefined}
              disabled={field === 'publish_date' && manualEditIsSourceConflict}
            />
          </Form.Item>
        ))}
      </Form>
      {manualEditError && (
        <Alert
          type={preview?.confirmationRows?.some((row) => row.rowIndex === manualEditRowIndex) ? 'warning' : 'error'}
          showIcon
          message={preview?.confirmationRows?.some((row) => row.rowIndex === manualEditRowIndex)
            ? '仍需确认当前投放档期' : '本地校验仍未通过'}
          description={manualEditError}
        />
      )}
    </Modal>
    </>
  )
}
