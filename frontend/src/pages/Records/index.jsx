import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Divider,
  Form,
  Input,
  message,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tooltip,
  Typography
} from 'antd'
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  UploadOutlined
} from '@ant-design/icons'
import {
  batchDeleteRecords,
  batchUpdateRecords,
  deleteRecord,
  fetchAllRecords,
  getCycles,
  getRecords
} from '../../api/records'
import { getImportBatches } from '../../api/importBatches'
import { useSearchParams } from 'react-router-dom'
import ExcelImportModal from '../../components/ExcelImportModal'
import RecordFormModal from '../../components/RecordFormModal'
import HistoricalNegotiationCaseModal from '../../components/HistoricalNegotiationCaseModal'
import { getNegotiationCasesByRecord, getNegotiationCasesBySourceType } from '../../api/creatorNegotiationCases'
import {
  buildExportFileName,
  exportRecordsToExcel,
  weekCodeToLabel
} from '../../utils/excel'
import { formatCpm, formatMoney, formatPlays } from '../../utils/format'
import { calcCpm } from '../../utils/calc'
import { getErrorMessage } from '../../utils/request'
import { alignDateToWeek, weekCodeToDateRange } from '../../utils/dateCycle.js'
import dayjs from 'dayjs'

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

// 博主类型下拉选项
const CREATOR_TYPE_OPTIONS = ['美妆', '科技', '美食', '穿搭', '数码', '生活', '知识', '职场', '其他']

/**
 * 投放管理页面
 * - 询档筛选区：时间周期 / 博主类型 / 发布日期范围 / 达人昵称，多条件组合查询
 * - 顶部操作栏：新增投放 / 导入 / 导出
 * - 数据表格：服务端分页，链接可点击，CPM 自动换算，操作列编辑/删除
 * - 新增/编辑弹窗 + 删除二次确认
 */
export default function Records() {
  const [filterForm] = Form.useForm()
  // 支持从导入历史跳转：/records?batchId=xx 自动按批次筛选
  const [searchParams, setSearchParams] = useSearchParams()

  // 表格数据
  const [list, setList] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  // 列表加载失败信息（配合重试按钮）
  const [listError, setListError] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  // 查询条件（与分页联动，变化即触发重新查询）
  const [filters, setFilters] = useState({})
  // 时间周期下拉选项
  const [timeCycleOptions, setTimeCycleOptions] = useState([])
  // 导入批次下拉选项（来自导入历史）
  const [batchOptions, setBatchOptions] = useState([])
  const [batchLoading, setBatchLoading] = useState(false)

  // 弹窗状态
  const [modalOpen, setModalOpen] = useState(false)
  const [editingRecord, setEditingRecord] = useState(null)
  // 导入弹窗
  const [importOpen, setImportOpen] = useState(false)
  // Historical Negotiation Backfill V0.1：历史谈价补录 / 只读查看
  const [harvestRecord, setHarvestRecord] = useState(null)
  // record_id -> 已有历史回填案例（用于「已补录谈价」标记）
  const [backfilledCases, setBackfilledCases] = useState({})
  // ---------- 批量操作状态 ----------
  // 选中的记录 ID（跨分页/筛选保留，便于批量处理）
  const [selectedRowKeys, setSelectedRowKeys] = useState([])
  // 批量修改时间周期弹窗
  const [batchCycleOpen, setBatchCycleOpen] = useState(false)
  const [batchCycleRange, setBatchCycleRange] = useState(null)
  // 批量修改博主类型弹窗
  const [batchTypeOpen, setBatchTypeOpen] = useState(false)
  const [batchTypeValue, setBatchTypeValue] = useState(undefined)
  // 批量提交中（防重复提交）
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  // 失败明细（批量操作逐条原因）
  const [batchErrors, setBatchErrors] = useState([])
  // 批量修改完成结果（弹窗展示：成功/失败条数 + 失败明细）
  const [batchUpdateResult, setBatchUpdateResult] = useState(null)

  // ---------- 时间周期选项 ----------
  const loadTimeCycles = useCallback(async () => {
    try {
      const res = await getCycles()
      setTimeCycleOptions(res.data)
    } catch {
      // 错误提示由 axios 拦截器统一处理
    }
  }, [])

  useEffect(() => {
    loadTimeCycles()
  }, [loadTimeCycles])

  // ---------- 导入批次选项（供「按批次筛选」使用） ----------
  const loadBatchOptions = useCallback(async () => {
    setBatchLoading(true)
    try {
      const res = await getImportBatches({ page: 1, pageSize: 100 })
      setBatchOptions(
        (res.data.list || []).map((item) => ({
          value: item.id,
          label: `${item.file_name || `批次 #${item.id}`}（成功 ${item.success_count} / 失败 ${item.fail_count}）`
        }))
      )
    } catch {
      // 错误提示由 axios 拦截器统一处理，不影响列表主流程
    } finally {
      setBatchLoading(false)
    }
  }, [])

  useEffect(() => {
    loadBatchOptions()
  }, [loadBatchOptions])

  // ---------- Historical Negotiation Backfill V0.1：已有历史谈价回填（只读标记） ----------
  const loadBackfilledCases = useCallback(async () => {
    try {
      const res = await getNegotiationCasesBySourceType('historical_backfill')
      const map = {}
      for (const item of res?.data?.cases || []) {
        if (item?.record_id) map[item.record_id] = item
      }
      setBackfilledCases(map)
    } catch {
      // 读取失败不影响投放列表主流程（入口仍可人工补录）
    }
  }, [])

  useEffect(() => {
    loadBackfilledCases()
  }, [loadBackfilledCases])

  // 从导入历史跳转过来（/records?batchId=xx）：自动回填筛选器并按批次查询
  useEffect(() => {
    const batchId = Number(searchParams.get('batchId'))
    if (!Number.isSafeInteger(batchId) || batchId <= 0) return
    filterForm.setFieldsValue({ batch_id: batchId })
    setFilters((prev) => (prev.batch_id === batchId ? prev : { ...prev, batch_id: batchId }))
    setPage(1)
  }, [searchParams, filterForm])

  // 从决策记录跳转过来（/records?keyword=达人）：自动回填达人筛选并按达人查询
  useEffect(() => {
    const keyword = String(searchParams.get('keyword') || '').trim()
    if (!keyword) return
    filterForm.setFieldsValue({ nickname: keyword })
    setFilters((prev) => (prev.keyword === keyword ? prev : { ...prev, keyword }))
    setPage(1)
  }, [searchParams, filterForm])

  // ---------- 数据加载（分页 + 筛选联动） ----------
  const loadData = useCallback(async () => {
    setLoading(true)
    setListError('')
    try {
      const res = await getRecords({ page, pageSize, ...filters })
      setList(res.data.list)
      setTotal(res.data.total)
    } catch (err) {
      setListError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, filters])

  useEffect(() => {
    loadData()
  }, [loadData])

  // ---------- 筛选 ----------
  const handleSearch = (values) => {
    const params = {}
    // 时间周期：日期范围 -> cycleStart/cycleEnd（清空时不传，查询全部）
    if (Array.isArray(values.cycle_range) && values.cycle_range.length === 2) {
      params.cycleStart = values.cycle_range[0].format('YYYY-MM-DD')
      params.cycleEnd = values.cycle_range[1].format('YYYY-MM-DD')
    }
    if (values.creator_type) params.creatorType = values.creator_type
    if (values.nickname && values.nickname.trim()) {
      params.keyword = values.nickname.trim()
    }
    // 发布日期精确筛选：只匹配发布日期等于选中日期的记录，未选择时查询全部
    if (values.publish_date) {
      params.publishDate = values.publish_date.format('YYYY-MM-DD')
    }
    // 按导入批次筛选（来自导入历史跳转或手动选择）
    if (values.batch_id) {
      params.batch_id = values.batch_id
    }
    setFilters(params)
    setPage(1) // 查询后回到第 1 页
  }

  const handleReset = () => {
    filterForm.resetFields()
    setFilters({})
    setPage(1)
    // 清理 URL 上的批次参数，避免刷新后又按批次筛选
    if (searchParams.get('batchId')) {
      const next = new URLSearchParams(searchParams)
      next.delete('batchId')
      setSearchParams(next, { replace: true })
    }
  }

  // ---------- 新增/编辑 ----------
  const openModal = (record) => {
    setEditingRecord(record)
    setModalOpen(true)
  }

  // ---------- 删除（二次确认） ----------
  const confirmDelete = (record) => {
    Modal.confirm({
      title: '删除确认',
      content: `确定要删除「${record.nickname}」在 ${weekCodeToLabel(record.time_cycle)} 的投放记录吗？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteRecord(record.id)
          message.success('删除成功')
          // 当前页删空后自动回退一页
          if (list.length === 1 && page > 1) setPage(page - 1)
          else loadData()
        } catch {
          // 错误提示由拦截器处理
        }
      }
    })
  }

  // ---------- 导入成功回调 ----------
  const handleImportSuccess = () => {
    loadTimeCycles() // 导入可能带来新的时间周期
    if (page !== 1) setPage(1)
    else loadData()
  }

  // ---------- 批量操作（多选 -> 批量修改/删除） ----------
  // 批量操作结果统一处理：提示成功/失败条数、展示失败明细、刷新列表并清空选中
  const finishBatch = ({ success, failed, errors }, actionLabel) => {
    setSelectedRowKeys([])
    setBatchCycleOpen(false)
    setBatchTypeOpen(false)
    setBatchCycleRange(null)
    setBatchTypeValue(undefined)
    if (failed > 0) {
      setBatchErrors(errors || [])
      message.warning(`${actionLabel}完成：成功 ${success} 条，失败 ${failed} 条`)
    } else {
      message.success(`${actionLabel}成功：共 ${success} 条`)
    }
    // 操作后刷新列表与时间周期选项，保证展示与数据一致
    loadData()
    loadTimeCycles()
  }

  /**
   * 批量更新返回结果归一化：
   * 优先读取新字段 successCount / failCount / failList，缺失时回退旧字段 success / failed / errors
   */
  const normalizeBatchUpdateResult = (payload = {}) => {
    const successCount = Number.isFinite(payload.successCount)
      ? payload.successCount
      : Number.isFinite(payload.success)
        ? payload.success
        : 0
    const failList = Array.isArray(payload.failList)
      ? payload.failList
      : Array.isArray(payload.errors)
        ? payload.errors
        : []
    const failCount = Number.isFinite(payload.failCount)
      ? payload.failCount
      : Number.isFinite(payload.failed)
        ? payload.failed
        : failList.length
    return { successCount, failCount, failList }
  }

  // 批量修改（时间周期 / 博主类型）完成处理：清空选中、关闭修改弹窗、刷新数据并展示完成弹窗
  // 说明：仅批量修改走此回调；批量删除仍走 finishBatch，保持原有行为不变
  const finishBatchUpdate = (payload, actionLabel) => {
    const { successCount, failCount, failList } = normalizeBatchUpdateResult(payload)
    setSelectedRowKeys([])
    setBatchCycleOpen(false)
    setBatchTypeOpen(false)
    setBatchCycleRange(null)
    setBatchTypeValue(undefined)
    // 保留原有轻量提示，同时用完成弹窗展示成功/失败条数与失败明细
    if (failCount > 0) {
      message.warning(`${actionLabel}完成：成功 ${successCount} 条，失败 ${failCount} 条`)
    } else {
      message.success(`${actionLabel}成功：共 ${successCount} 条`)
    }
    setBatchUpdateResult({ actionLabel, successCount, failCount, failList })
    // 操作后刷新列表与时间周期选项，保证展示与数据一致
    loadData()
    loadTimeCycles()
  }

  // 批量修改时间周期：复用 alignDateToWeek（与新增/编辑弹窗同一套解析逻辑）
  const handleBatchCycleConfirm = async () => {
    const range = batchCycleRange
    if (!Array.isArray(range) || range.length !== 2 || !range[0] || !range[1]) {
      message.warning('请选择完整的时间周期（周一到周日）')
      return
    }
    const aligned = alignDateToWeek(range[0].format('YYYY-MM-DD'), range[1].format('YYYY-MM-DD'))
    if (!aligned?.weekCode) {
      message.error('时间周期解析失败，请选择完整自然周（周一至周日）')
      return
    }
    setBatchSubmitting(true)
    try {
      const res = await batchUpdateRecords(selectedRowKeys, 'time_cycle', aligned.weekCode)
      finishBatchUpdate(res.data, '批量修改时间周期')
    } catch {
      // 具体错误（如格式非法）由 axios 拦截器提示，失败不改变已有数据
    } finally {
      setBatchSubmitting(false)
    }
  }

  // 批量修改博主类型
  const handleBatchTypeConfirm = async () => {
    const value = String(batchTypeValue ?? '').trim()
    if (!value) {
      message.warning('请选择目标博主类型')
      return
    }
    setBatchSubmitting(true)
    try {
      const res = await batchUpdateRecords(selectedRowKeys, 'creator_type', value)
      finishBatchUpdate(res.data, '批量修改博主类型')
    } catch {
      // 错误提示由拦截器处理
    } finally {
      setBatchSubmitting(false)
    }
  }

  // 批量删除（二次确认）
  const confirmBatchDelete = () => {
    const count = selectedRowKeys.length
    if (!count) return
    Modal.confirm({
      title: '批量删除确认',
      content: `确定删除选中的 ${count} 条记录吗？删除后不可恢复`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setBatchSubmitting(true)
        try {
          const res = await batchDeleteRecords(selectedRowKeys)
          finishBatch(res.data, '批量删除')
          // 当前页被删空时自动回退一页
          if (list.length && list.every((row) => selectedRowKeys.includes(row.id)) && page > 1) {
            setPage(page - 1)
          }
        } catch {
          // 错误提示由拦截器处理
        } finally {
          setBatchSubmitting(false)
        }
      }
    })
  }

  // 选中当前页全部 / 反选
  const selectCurrentPage = () => {
    setSelectedRowKeys((prev) => [...new Set([...prev, ...list.map((row) => row.id)])])
  }
  const invertCurrentPage = () => {
    const pageIds = list.map((row) => row.id)
    setSelectedRowKeys((prev) => {
      const rest = prev.filter((id) => !pageIds.includes(id))
      const inverted = pageIds.filter((id) => !prev.includes(id))
      return [...rest, ...inverted]
    })
  }

  // ---------- 导出（按当前筛选条件拉取全量 -> Excel） ----------
  const handleExport = async () => {
    try {
      const all = await fetchAllRecords(filters)
      if (!all.length) {
        message.warning('暂无数据可导出')
        return
      }
      exportRecordsToExcel(all, buildExportFileName())
      message.success('导出成功')
    } catch {
      // 错误提示由拦截器处理
    }
  }

  // ---------- 表格列 ----------
  const linkRender = (value) => {
    if (!value) return <Typography.Text type="secondary">-</Typography.Text>
    return (
      <Tooltip title={value}>
        <a href={value} target="_blank" rel="noopener noreferrer">
          查看
        </a>
      </Tooltip>
    )
  }

  // 单条记录的最新累计口径：latest 已填写且不违反 latest >= first 时才可信
  const recordLatestPlay = (record) => {
    const latestRaw = record?.second_week_play
    if (latestRaw === null || latestRaw === undefined || latestRaw === '') return null
    const latest = Number(latestRaw)
    if (!Number.isFinite(latest)) return null
    const firstRaw = record?.first_play
    if (firstRaw !== null && firstRaw !== undefined && firstRaw !== '') {
      const first = Number(firstRaw)
      // latest < first 属于异常数据，不可信
      if (Number.isFinite(first) && latest < first) return null
    }
    return latest
  }

  // 最新CPM = 总花费 ÷ 最新累计播放量 × 1000
  // latest 未填写（待更新）/ 异常（latest < first）/ latest <= 0 → 显示 -
  const cpmRender = (_, record) => {
    const latest = recordLatestPlay(record)
    return formatCpm(latest === null ? null : calcCpm(record.total_cost, latest))
  }

  // 最新累计播放量：未填写显示「待更新」；异常（latest < first）保留原始数值并标红 + 悬浮提示
  const latestPlayRender = (value, record) => {
    if (value === null || value === undefined || value === '') {
      return <Typography.Text type="secondary">待更新</Typography.Text>
    }
    const latest = Number(value)
    const firstRaw = record?.first_play
    const first =
      firstRaw === null || firstRaw === undefined || firstRaw === '' ? null : Number(firstRaw)
    if (Number.isFinite(latest) && first !== null && Number.isFinite(first) && latest < first) {
      return (
        <Tooltip title="累计播放量小于7日播放量">
          <span style={{ color: '#d4380d' }}>{formatPlays(value)}</span>
        </Tooltip>
      )
    }
    return formatPlays(value)
  }

  // 7日后新增播放量 = 最新累计播放量 − 7日累计播放量
  // 仅当 latest 已填写且 latest >= 7日累计时展示；否则显示 -
  const post7dGrowthRender = (_, record) => {
    const latest = recordLatestPlay(record)
    const firstRaw = record?.first_play
    if (latest === null || firstRaw === null || firstRaw === undefined || firstRaw === '') return '-'
    const first = Number(firstRaw)
    if (!Number.isFinite(first)) return '-'
    return formatPlays(latest - first)
  }

  // Historical Negotiation Backfill V0.1：打开「补录历史谈价 / 已补录谈价（只读）」
  const openHarvest = async (record) => {
    const local = backfilledCases[record.id]
    if (local) {
      setHarvestRecord({ record, existingCase: local })
      return
    }
    try {
      const res = await getNegotiationCasesByRecord(record.id)
      const existing = (res?.data?.cases || [])[0] || null
      setHarvestRecord({ record, existingCase: existing })
    } catch {
      setHarvestRecord({ record, existingCase: null })
    }
  }

  const actionRender = (_, record) => (
    <Space size={0}>
      <Button
        type="link"
        size="small"
        onClick={() => openHarvest(record)}
      >
        {backfilledCases[record.id] ? '已补录谈价' : '补录历史谈价'}
      </Button>
      <Button
        type="link"
        size="small"
        icon={<EditOutlined />}
        onClick={() => openModal(record)}
      >
        编辑
      </Button>
      <Button
        type="link"
        size="small"
        danger
        icon={<DeleteOutlined />}
        onClick={() => confirmDelete(record)}
      >
        删除
      </Button>
    </Space>
  )

  // 时间周期列：展示月日区间（08/10-08/16），悬浮显示完整年份周数
  const timeCycleRender = (value) => {
    const found = timeCycleOptions.find((item) => item.weekCode === value)
    const label = found ? found.label : weekCodeToLabel(value)
    const match = /^(\d{4})-W(\d{1,2})$/i.exec(String(value ?? '').trim())
    const tooltip = match
      ? `${match[1]}年第${Number(match[2])}周 ${label}`
      : String(value ?? '-')
    return (
      <Tooltip title={tooltip}>
        <span>{label}</span>
      </Tooltip>
    )
  }

  const columns = [
    { title: '时间周期', dataIndex: 'time_cycle', width: 120, fixed: 'left', render: timeCycleRender },
    { title: '达人昵称', dataIndex: 'nickname', width: 130, fixed: 'left', ellipsis: true },
    { title: '博主类型', dataIndex: 'creator_type', width: 110, ellipsis: true },
    { title: '达人主页', dataIndex: 'homepage', width: 110, render: linkRender },
    { title: '植入链接', dataIndex: 'content_link', width: 110, render: linkRender },
    { title: '视频链接', dataIndex: 'video_link', width: 110, render: linkRender },
    {
      title: '总花费(元)',
      dataIndex: 'total_cost',
      width: 115,
      align: 'right',
      render: formatMoney
    },
    {
      title: 'CPM',
      key: 'latestCpm',
      width: 110,
      align: 'right',
      render: cpmRender
    },
    {
      title: '7日播放量',
      dataIndex: 'first_play',
      width: 130,
      align: 'right',
      render: formatPlays
    },
    {
      title: '累计播放量',
      dataIndex: 'second_week_play',
      width: 130,
      align: 'right',
      render: latestPlayRender
    },
    {
      title: '后续新增播放量',
      key: 'post7dGrowth',
      width: 150,
      align: 'right',
      render: post7dGrowthRender
    },
    { title: '发布日期', dataIndex: 'publish_date', width: 110 },
    { title: '操作', key: 'action', width: 220, fixed: 'right', render: actionRender }
  ]

  return (
    <Card>
      {/* 询档筛选区 */}
      <div
        style={{
          padding: 20,
          background: '#fafafa',
          borderRadius: 8
        }}
      >
        <Form form={filterForm} onFinish={handleSearch} labelAlign="right">
          <Row gutter={[16, 16]}>
            {/* 1. 时间周期（日期范围） */}
            <Col xs={24} md={12} xl={8}>
              <Form.Item
                name="cycle_range"
                label="时间周期"
                labelCol={{ flex: '0 0 90px', style: { marginRight: 8 } }}
                wrapperCol={{ style: { flex: 1, minWidth: 0 } }}
                style={{ marginBottom: 0 }}
              >
                <DatePicker.RangePicker
                  allowClear
                  size="large"
                  placeholder={['开始日期', '结束日期']}
                  format="MM/DD"
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>

            {/* 2. 博主类型（下拉） */}
            <Col xs={24} md={12} xl={8}>
              <Form.Item
                name="creator_type"
                label="博主类型"
                labelCol={{ flex: '0 0 90px', style: { marginRight: 8 } }}
                wrapperCol={{ style: { flex: 1, minWidth: 0 } }}
                style={{ marginBottom: 0 }}
              >
                <Select
                  allowClear
                  size="large"
                  placeholder="请选择博主类型"
                  style={{ width: '100%' }}
                  options={CREATOR_TYPE_OPTIONS.map((value) => ({ value, label: value }))}
                />
              </Form.Item>
            </Col>

            {/* 3. 发布日期（单选） */}
            <Col xs={24} md={12} xl={8}>
              <Form.Item
                name="publish_date"
                label="发布日期"
                labelCol={{ flex: '0 0 90px', style: { marginRight: 8 } }}
                wrapperCol={{ style: { flex: 1, minWidth: 0 } }}
                style={{ marginBottom: 0 }}
              >
                <DatePicker
                  allowClear
                  size="large"
                  placeholder="选择日期"
                  format="MM/DD"
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>

            {/* 4. 达人昵称（输入框） */}
            <Col xs={24} md={12} xl={8}>
              <Form.Item
                name="nickname"
                label="达人昵称"
                labelCol={{ flex: '0 0 90px', style: { marginRight: 8 } }}
                wrapperCol={{ style: { flex: 1, minWidth: 0 } }}
                style={{ marginBottom: 0 }}
              >
                <Input
                  allowClear
                  size="large"
                  placeholder="昵称模糊搜索"
                  maxLength={100}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>

            {/* 5. 导入批次筛选（来自导入历史，按批次查看该次导入的记录） */}
            <Col xs={24} md={12} xl={8}>
              <Form.Item
                name="batch_id"
                label="导入批次"
                labelCol={{ flex: '0 0 90px', style: { marginRight: 8 } }}
                wrapperCol={{ style: { flex: 1, minWidth: 0 } }}
                style={{ marginBottom: 0 }}
              >
                <Select
                  allowClear
                  showSearch
                  size="large"
                  placeholder="按导入批次筛选"
                  optionFilterProp="label"
                  style={{ width: '100%' }}
                  options={batchOptions}
                  loading={batchLoading}
                />
              </Form.Item>
            </Col>

            {/* 6. 留白占位 */}
            <Col xs={24} md={12} xl={8} />

            {/* 7-9. 查询/重置按钮（右侧对齐） */}
            <Col xs={24} md={12} xl={8} />
            <Col xs={24} md={12} xl={8} />
            <Col xs={24} md={12} xl={8}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  gap: 8,
                  height: 40
                }}
              >
                <Button type="primary" htmlType="submit" icon={<SearchOutlined />} size="large">
                  查询
                </Button>
                <Button icon={<ReloadOutlined />} onClick={handleReset} size="large">
                  重置
                </Button>
              </div>
            </Col>
          </Row>
        </Form>
      </div>

      <Divider style={{ margin: '12px 0 16px' }} />

      {/* 列表加载失败提示（可重试） */}
      {listError && (
        <Alert
          type="error"
          showIcon
          message="列表加载失败"
          description={listError}
          style={{ marginBottom: 16 }}
          action={
            <Button size="small" onClick={loadData}>
              重试
            </Button>
          }
        />
      )}

      {/* 顶部操作栏 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 16
        }}
      >
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal(null)}>
          新增投放
        </Button>
        <Space>
          <Button
            icon={<UploadOutlined />}
            onClick={() => setImportOpen(true)}
          >
            导入Excel
          </Button>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>
            导出Excel
          </Button>
        </Space>
      </div>

      {/* 批量操作栏：仅在有选中记录时显示 */}
      {selectedRowKeys.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            marginBottom: 12,
            padding: '8px 16px',
            background: '#e6f4ff',
            border: '1px solid #91caff',
            borderRadius: 8
          }}
        >
          <Space size={12} wrap>
            <Typography.Text strong>已选中 {selectedRowKeys.length} 条</Typography.Text>
            <Button size="small" onClick={selectCurrentPage}>
              全选本页
            </Button>
            <Button size="small" onClick={invertCurrentPage}>
              反选本页
            </Button>
            <Button size="small" onClick={() => setSelectedRowKeys([])}>
              清空选择
            </Button>
          </Space>
          <Space size={12} wrap>
            <Button
              size="small"
              loading={batchSubmitting}
              disabled={!selectedRowKeys.length}
              onClick={() => {
                setBatchCycleRange(null)
                setBatchCycleOpen(true)
              }}
            >
              批量修改时间周期
            </Button>
            <Button
              size="small"
              loading={batchSubmitting}
              disabled={!selectedRowKeys.length}
              onClick={() => {
                setBatchTypeValue(undefined)
                setBatchTypeOpen(true)
              }}
            >
              批量修改博主类型
            </Button>
            <Button
              size="small"
              danger
              loading={batchSubmitting}
              disabled={!selectedRowKeys.length}
              onClick={confirmBatchDelete}
            >
              批量删除
            </Button>
          </Space>
        </div>
      )}

      {/* 数据表格 */}
      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={list}
        rowSelection={{
          selectedRowKeys,
          preserveSelectedRowKeys: true,
          onChange: (keys) => setSelectedRowKeys(keys),
          // 选中行高亮（与表格现有样式统一）
          getCheckboxProps: () => ({ disabled: batchSubmitting })
        }}
        rowClassName={(record) => (selectedRowKeys.includes(record.id) ? 'ant-table-row-selected' : '')}
        locale={{ emptyText: '暂无投放记录，点击「新增投放」创建' }}
        scroll={{ x: 1700 }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showQuickJumper: true,
          pageSizeOptions: PAGE_SIZE_OPTIONS,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (nextPage, nextPageSize) => {
            // 切换每页条数时回到第一页
            if (nextPageSize !== pageSize) {
              setPageSize(nextPageSize)
              setPage(1)
            } else {
              setPage(nextPage)
            }
          }
        }}
      />

      {/* Historical Negotiation Backfill V0.1：历史谈价补录 / 只读查看 */}
      <HistoricalNegotiationCaseModal
        open={Boolean(harvestRecord)}
        record={harvestRecord?.record || null}
        existingCase={harvestRecord?.existingCase || null}
        onClose={() => setHarvestRecord(null)}
        onSaved={async (saved) => {
          if (saved?.record_id) {
            setBackfilledCases((current) => ({ ...current, [saved.record_id]: saved }))
          }
          await loadBackfilledCases()
        }}
      />

      {/* 新增/编辑弹窗 */}
      <RecordFormModal
        open={modalOpen}
        editingRecord={editingRecord}
        onCancel={() => setModalOpen(false)}
        onSuccess={() => {
          setModalOpen(false)
          // 新增数据按 id 倒序排在第一页，回到第一页查看
          if (editingRecord) loadData()
          else setPage(1)
        }}
      />

      {/* 导入弹窗 */}
      <ExcelImportModal
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onSuccess={handleImportSuccess}
      />

      {/* 批量修改时间周期弹窗：复用日期范围选择器 + 自动对齐自然周 */}
      <Modal
        title={`批量修改时间周期（已选中 ${selectedRowKeys.length} 条）`}
        open={batchCycleOpen}
        onCancel={() => setBatchCycleOpen(false)}
        onOk={handleBatchCycleConfirm}
        confirmLoading={batchSubmitting}
        okText="确认修改"
        cancelText="取消"
        destroyOnHidden
      >
        <Space direction="vertical" size="small" style={{ display: 'flex' }}>
          <Typography.Text type="secondary">
            选择任意起止日期，系统自动对齐到该日期所在的完整自然周（周一~周日）
          </Typography.Text>
          <DatePicker.RangePicker
            value={batchCycleRange}
            onChange={(dates) => setBatchCycleRange(dates)}
            format="MM/DD"
            placeholder={['开始日期', '结束日期']}
            style={{ width: '100%' }}
            showToday={false}
          />
          {Array.isArray(batchCycleRange) && batchCycleRange[0] && batchCycleRange[1] && (
            <Alert
              type="info"
              showIcon
              message={`将统一修改为：${
                alignDateToWeek(
                  batchCycleRange[0].format('YYYY-MM-DD'),
                  batchCycleRange[1].format('YYYY-MM-DD')
                )?.weekCode || '-'
              }`}
            />
          )}
        </Space>
      </Modal>

      {/* 批量修改博主类型弹窗 */}
      <Modal
        title={`批量修改博主类型（已选中 ${selectedRowKeys.length} 条）`}
        open={batchTypeOpen}
        onCancel={() => setBatchTypeOpen(false)}
        onOk={handleBatchTypeConfirm}
        confirmLoading={batchSubmitting}
        okText="确认修改"
        cancelText="取消"
        destroyOnHidden
      >
        <Space direction="vertical" size="small" style={{ display: 'flex' }}>
          <Typography.Text type="secondary">选择目标博主类型，将批量覆盖选中记录的博主类型</Typography.Text>
          <Select
            value={batchTypeValue}
            onChange={setBatchTypeValue}
            placeholder="请选择博主类型"
            style={{ width: '100%' }}
            showSearch
            options={[
              ...CREATOR_TYPE_OPTIONS,
              // 兼容库中已有的自定义类型
              ...Array.from(
                new Set(list.map((row) => String(row.creator_type || '').trim()).filter(Boolean))
              ).filter((type) => !CREATOR_TYPE_OPTIONS.includes(type))
            ].map((type) => ({ value: type, label: type }))}
          />
        </Space>
      </Modal>

      {/* 批量操作失败明细 */}
      <Modal
        title="批量操作失败明细"
        open={batchErrors.length > 0}
        onCancel={() => setBatchErrors([])}
        footer={<Button onClick={() => setBatchErrors([])}>知道了</Button>}
      >
        <Alert
          type="warning"
          showIcon
          message={`共 ${batchErrors.length} 条未成功处理，其余记录已正常生效`}
          style={{ marginBottom: 12 }}
        />
        <div style={{ maxHeight: 240, overflow: 'auto' }}>
          {batchErrors.map((item) => (
            <div key={item.id}>
              ID {item.id}：{item.reason}
            </div>
          ))}
        </div>
      </Modal>

      {/* 批量修改完成弹窗：成功/失败条数 + 失败明细表格（ID / 失败原因） */}
      <Modal
        title="批量处理完成"
        open={Boolean(batchUpdateResult)}
        onCancel={() => setBatchUpdateResult(null)}
        footer={
          <Button type="primary" onClick={() => setBatchUpdateResult(null)}>
            知道了
          </Button>
        }
      >
        {batchUpdateResult && (
          <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
            <Typography.Text strong>
              {`批量处理完成｜成功：${batchUpdateResult.successCount}条，失败：${batchUpdateResult.failCount}条`}
            </Typography.Text>
            <Typography.Text type="secondary">
              操作类型：{batchUpdateResult.actionLabel}
            </Typography.Text>
            {batchUpdateResult.failList.length > 0 ? (
              <Table
                size="small"
                rowKey={(record, index) => String(record?.id ?? index)}
                columns={[
                  { title: 'ID', dataIndex: 'id', width: 100 },
                  {
                    title: '失败原因',
                    dataIndex: 'reason',
                    render: (value) => value || '未提供失败原因'
                  }
                ]}
                dataSource={batchUpdateResult.failList}
                pagination={false}
                scroll={{ y: 240 }}
              />
            ) : (
              <Alert type="success" showIcon message="全部记录处理成功" />
            )}
          </Space>
        )}
      </Modal>
    </Card>
  )
}
