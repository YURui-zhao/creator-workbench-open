import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Collapse,
  Drawer,
  Empty,
  Input,
  message,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  buildRecordsExportUrl,
  fetchAllRecords,
  getCreatorSummary,
  getRecordFilters
} from '../../api/records'
import { formatCpm, formatInteger, formatMoney, formatPlays } from '../../utils/format'
import { calcCpm } from '../../utils/calc.js'
import { getNextWeek, getPrevWeek, weekCodeToDateRange, formatWeekLabel } from '../../utils/dateCycle.js'
import { getErrorMessage } from '../../utils/request'
import {
  buildCreatorCompareFileName,
  buildCreatorSummaryFileName,
  exportCreatorStatsToExcel
} from '../../utils/excel'
import {
  buildCompareRows,
  canCompareCreators,
  creatorDisplayName,
  creatorIdentityKey as creatorRowKey,
  COMPARE_MAX,
  COMPARE_MIN
} from '../../utils/creatorCompare.js'

// 最小投放次数下拉选项
const MIN_CAMPAIGNS_OPTIONS = [
  { value: 0, label: '不限' },
  { value: 2, label: '2 次及以上' },
  { value: 3, label: '3 次及以上' }
]


/**
 * 达人汇总分析页：按达人横向聚合投放数据，支持周范围/博主类型筛选、口径切换、
 * 分组折叠、列排序与单达人下钻明细、一键导出汇总。
 */
export default function CreatorSummary() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [summary, setSummary] = useState(null)
  const [filterMeta, setFilterMeta] = useState({
    creatorTypes: [],
    nicknames: [],
    weekRange: { earliestWeek: null, latestWeek: null }
  })
  const [weekOptions, setWeekOptions] = useState([])
  const [rangeStart, setRangeStart] = useState(null)
  const [rangeEnd, setRangeEnd] = useState(null)
  const [filterTypes, setFilterTypes] = useState([])
  // 统计口径：campaign 投放周（主口径，固定）。occurrence 缺周级快照，本轮前端停用（Segmented 选项 disabled）
  const [caliber, setCaliber] = useState('campaign')
  // 新增筛选：达人昵称（防抖 500ms）+ 最小投放次数
  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [minCampaigns, setMinCampaigns] = useState(0)
  // 排序：由接口完成（sortBy + sortOrder），默认按总花费降序
  const [sort, setSort] = useState({ sortBy: 'total_cost', sortOrder: 'desc' })
  // 达人对比：勾选的达人昵称 + 对比弹窗
  const [compareKeys, setCompareKeys] = useState([])
  const [compareOpen, setCompareOpen] = useState(false)
  // 抽屉：单达人下钻明细
  const [drawerCreator, setDrawerCreator] = useState(null)
  const [detailRecords, setDetailRecords] = useState([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [allRecords, setAllRecords] = useState([])

  const caliberLabel = caliber === 'campaign' ? '按投放周' : '按发生周'

  // 筛选元数据 + 全量记录（用于下钻明细与周下拉）
  const loadBaseData = useCallback(async () => {
    setLoadError('')
    try {
      const [filtersRes, records] = await Promise.all([getRecordFilters(), fetchAllRecords()])
      const meta = filtersRes.data || {}
      setFilterMeta(meta)
      setAllRecords(records)
      const { earliestWeek, latestWeek } = meta.weekRange || {}
      if (earliestWeek && latestWeek) {
        const options = []
        let cursor = earliestWeek
        while (cursor && cursor <= latestWeek && options.length < 300) {
          const range = weekCodeToDateRange(cursor)
          if (range) {
            options.push({
              weekCode: cursor,
              label: formatWeekLabel(range.startDate, range.endDate)
            })
          }
          cursor = getNextWeek(cursor)
        }
        setWeekOptions(options)
        // 默认整段范围：与看板「全部」一致（不传范围即全量）
        setRangeStart((prev) => prev || earliestWeek)
        setRangeEnd((prev) => prev || latestWeek)
      }
    } catch (err) {
      setLoadError(getErrorMessage(err))
    }
  }, [])

  useEffect(() => {
    loadBaseData()
  }, [loadBaseData])

  // 昵称搜索防抖 500ms（输入即搜索，清空立即生效）
  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(keywordInput.trim()), 500)
    return () => window.clearTimeout(timer)
  }, [keywordInput])

  // 汇总数据：周范围 / 类型筛选 / 口径变化即重新拉取
  useEffect(() => {
    let active = true
    setLoading(true)
    getCreatorSummary({
      startWeek: rangeStart,
      endWeek: rangeEnd,
      caliber,
      creatorTypes: filterTypes,
      keyword,
      minCampaigns: minCampaigns || undefined,
      sortBy: sort.sortBy,
      sortOrder: sort.sortOrder
    })
      .then((res) => {
        if (!active) return
        setSummary(res.data)
        setLoadError('')
      })
      .catch((err) => {
        if (!active) return
        setSummary(null)
        setLoadError(getErrorMessage(err))
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [rangeStart, rangeEnd, caliber, filterTypes, keyword, minCampaigns, sort])

  const totalSummary = summary?.total_summary
  const groups = summary?.groups || []
  // Phase 5：身份模式来自后端（identity_mode）。identity 模式下行必须有 creator_id，
  // 缺失属契约破坏 → 行键使用稳定无效键且不参与选择/对比（绝不静默用名称合并）。
  const identityMode = summary?.identity_mode === true
  // 扁平达人列表（接口返回全集，用于对比与明细导出）
  const allCreators = summary?.creators || []
  // 对比勾选校验（2~5 位）
  const compareCheck = canCompareCreators(compareKeys.length)
  const compareRows = useMemo(
    () => buildCompareRows(allCreators, compareKeys, identityMode),
    [allCreators, compareKeys, identityMode]
  )
  // 当前选择是否覆盖全部数据周（用于区分「真的没有历史投放」与「只是这个范围没有」）
  const isCreatorFullRange = useMemo(() => {
    if (!weekOptions.length) return false
    const first = weekOptions[0]?.weekCode
    const last = weekOptions[weekOptions.length - 1]?.weekCode
    return rangeStart === first && rangeEnd === last
  }, [weekOptions, rangeStart, rangeEnd])
  const rangeText = useMemo(() => {
    if (!rangeStart || !rangeEnd) return '全部数据'
    const start = weekOptions.find((item) => item.weekCode === rangeStart)?.label || rangeStart
    const end = weekOptions.find((item) => item.weekCode === rangeEnd)?.label || rangeEnd
    return start === end ? start : `${start} ~ ${end}`
  }, [rangeStart, rangeEnd, weekOptions])

  // 快捷范围：近 N 周 / 全部
  const applyQuickRange = (type) => {
    const latest = weekOptions[weekOptions.length - 1]?.weekCode
    const earliest = weekOptions[0]?.weekCode
    if (!latest || !earliest) return
    if (type === 'all') {
      setRangeStart(earliest)
      setRangeEnd(latest)
      return
    }
    const span = type === '4' ? 4 : 8
    let start = latest
    for (let i = 1; i < span; i += 1) {
      const prev = getPrevWeek(start)
      if (!prev || prev < earliest) break
      start = prev
    }
    setRangeStart(start)
    setRangeEnd(latest)
  }

  // 导出达人汇总（与页面同一筛选条件，后端直接返回 xlsx）
  const handleExportSummary = () => {
    const url = buildRecordsExportUrl({
      startWeek: rangeStart,
      endWeek: rangeEnd,
      caliber,
      creatorTypes: filterTypes,
      type: 'creator-summary',
      keyword,
      minCampaigns,
      sortBy: sort.sortBy,
      sortOrder: sort.sortOrder
    })
    const link = document.createElement('a')
    link.href = url
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // 下钻：该达人在当前周范围内的全部投放记录
  const openCreatorDrawer = (creator) => {
    // Phase 5：identity 模式下行缺少 creator_id = 契约破坏。
    // 该行不是合法 Creator ownership：拒绝下钻，绝不退回昵称匹配（否则同名会串数据）。
    if (identityMode && (creator.creator_id === null || creator.creator_id === undefined)) return
    setDrawerCreator(creator)
    setDetailLoading(true)
    const rows = allRecords.filter((row) => {
      // 非 identity 模式（老 schema，根本没有 creator_id 能力）→ 保留昵称匹配（旧契约）
      if (!identityMode) {
        if (String(row.nickname || '').trim() !== creator.nickname) return false
      } else if (creator.creator_id === null || creator.creator_id === undefined) {
        // 契约破坏行已被上方拒绝；此处兜底不匹配任何记录
        return false
      } else if (row.creator_id !== creator.creator_id) {
        return false
      }
      if (rangeStart && row.time_cycle < rangeStart) return false
      if (rangeEnd && row.time_cycle > rangeEnd) return false
      return true
    })
    setDetailRecords(rows)
    setDetailLoading(false)
  }

  // 排序状态 -> antd 列头箭头（服务端排序，全局统一）
  const sortOrderOf = (field) => (sort.sortBy === field ? sort.sortOrder : null)
  // 点击列头：同一列切换升/降序，切列时重置为降序（默认仍为总花费降序）
  const handleTableSort = (pagination, filters, sorter) => {
    const field = sorter?.field || sorter?.columnKey
    if (!field) return
    const order = sorter.order === 'ascend' ? 'asc' : sorter.order === 'descend' ? 'desc' : 'desc'
    setSort({ sortBy: field, sortOrder: order })
  }

  // 达人表列：数值列支持点击排序（服务端排序），默认总花费降序
  const creatorColumns = [
    {
      title: '达人',
      dataIndex: 'canonical_name',
      width: 160,
      render: (_value, record) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => openCreatorDrawer(record)}>
          {creatorDisplayName(record)}
        </Button>
      )
    },
    {
      title: '投放次数',
      dataIndex: 'total_campaigns',
      width: 110,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('total_campaigns'),
      render: (value) => formatInteger(value)
    },
    {
      title: '总花费(元)',
      dataIndex: 'total_cost',
      width: 130,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('total_cost'),
      render: (value) => formatMoney(value)
    },
    {
      title: '累计播放量',
      dataIndex: 'latest_play_total',
      width: 135,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('latest_play_total'),
      render: (value, record) => formatPlays(value ?? record?.total_play ?? 0)
    },
    {
      title: '平均CPM',
      dataIndex: 'avg_cpm',
      width: 120,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('avg_cpm'),
      render: (value) => formatCpm(value)
    },
    {
      title: '爆款数',
      dataIndex: 'hit_latest_count',
      width: 115,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('hit_latest_count'),
      render: (value, record) => {
        const hits = value ?? record?.hit_count ?? 0
        return Number(hits) >= 1 ? (
          <Tag color="volcano">{formatInteger(hits)}</Tag>
        ) : (
          formatInteger(hits)
        )
      }
    },
    {
      title: '爆款率',
      dataIndex: 'hit_rate_latest',
      width: 115,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('hit_rate_latest'),
      render: (value, record) => formatPercent(value ?? record?.hit_rate)
    },
    {
      title: '平均播放量',
      dataIndex: 'avg_play',
      width: 165,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('avg_play'),
      render: (value) => formatPlays(value)
    },
    {
      title: '复投次数',
      dataIndex: 'repeat_count',
      width: 110,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('repeat_count'),
      render: (value, record) => {
        // Phase 5：复投次数只在「有真实合作」时才有意义。
        // 无任何投放记录（zero-history Creator）→ 0（既不是复投，也不是「首次合作」）；
        // 有 1 条记录且 0 次复投 → 沿用既有产品语义「首次」。
        if (Number(record?.total_campaigns ?? 0) === 0) return formatInteger(0)
        return Number(value) > 0 ? (
          `${formatInteger(value)} 次`
        ) : (
          <Typography.Text type="secondary">首次</Typography.Text>
        )
      }
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      fixed: 'right',
      render: (_, record) => (
        <Button size="small" type="link" onClick={() => openCreatorDrawer(record)}>
          查看明细
        </Button>
      )
    }
  ]

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

  // 最新CPM = 总花费 ÷ 最新累计播放量 × 1000；latest 待更新 / 异常 / ≤ 0 → -
  const latestCpmRender = (_, record) => {
    const latest = recordLatestPlay(record)
    return formatCpm(latest === null ? null : calcCpm(record.total_cost, latest))
  }

  // 7日后新增播放量 = 最新累计播放量 − 7日累计播放量（仅 latest 有效且 ≥ 7日累计时展示，否则 -）
  const post7dGrowthRender = (_, record) => {
    const latest = recordLatestPlay(record)
    const firstRaw = record?.first_play
    if (latest === null || firstRaw === null || firstRaw === undefined || firstRaw === '') return '-'
    const first = Number(firstRaw)
    if (!Number.isFinite(first)) return '-'
    return formatPlays(latest - first)
  }

  // 抽屉明细列（与投放管理保持一致）
  const detailColumns = [
    {
      title: '时间周期',
      dataIndex: 'time_cycle',
      width: 120,
      render: (value) => {
        const range = weekCodeToDateRange(value)
        return range ? formatWeekLabel(range.startDate, range.endDate) : value || '-'
      }
    },
    { title: '达人昵称', dataIndex: 'nickname', width: 130, ellipsis: true },
    { title: '博主类型', dataIndex: 'creator_type', width: 110, ellipsis: true },
    {
      title: '总花费(元)',
      dataIndex: 'total_cost',
      width: 110,
      align: 'right',
      render: (value) => formatMoney(value)
    },
    {
      title: '7日播放量',
      dataIndex: 'first_play',
      width: 130,
      align: 'right',
      render: (value) => formatPlays(value)
    },
    {
      title: '累计播放量',
      dataIndex: 'second_week_play',
      width: 130,
      align: 'right',
      render: latestPlayRender
    },
    {
      title: 'CPM',
      key: 'latestCpm',
      width: 105,
      align: 'right',
      render: latestCpmRender
    },
    {
      title: '后续新增播放量',
      key: 'post7dGrowth',
      width: 145,
      align: 'right',
      render: post7dGrowthRender
    },
    { title: '发布日期', dataIndex: 'publish_date', width: 110, render: (value) => value || '-' }
  ]

  // 百分比格式化：null / undefined → -
  const formatPercent = (value) =>
    value === null || value === undefined ? '-' : `${value}%`
  // 数据完整性提示（小号辅助文案；在卡片定义前声明，供 metricCards 内联使用）
  const metricFootnoteStyle = { fontSize: 11, lineHeight: '16px', color: 'rgba(0, 0, 0, 0.45)' }

  // ---------- 顶部指标卡片（新口径：最新累计为主，7日累计/7日爆款为辅助） ----------
  const metricCards = [
    {
      key: 'creators',
      title: '达人数',
      value: formatInteger(totalSummary?.creator_count ?? 0),
      suffix: '人',
      tooltip: '所选范围内有投放记录的达人昵称去重数量'
    },
    {
      key: 'campaigns',
      title: '投放次数',
      value: formatInteger(totalSummary?.total_campaigns ?? 0),
      suffix: '次',
      tooltip: '所选范围内全部投放记录条数（不因「播放数据待更新」而减少）'
    },
    {
      key: 'cost',
      title: '总花费',
      value: formatMoney(totalSummary?.total_cost ?? 0),
      suffix: '元',
      tooltip: '总花费：按投放记录归属周汇总，不随口径切换'
    },
    {
      key: 'play',
      title: '累计播放量',
      value: formatPlays(totalSummary?.latest_play_total ?? totalSummary?.total_play ?? 0),
      tooltip: '按各条内容最近一次更新的累计播放量汇总',
      secondary: [
        {
          label: '7日播放量',
          value: formatPlays(totalSummary?.first_play_total ?? 0),
          tooltip: '内容发布约7天时记录的累计播放量'
        },
        {
          label: '后续新增播放量',
          value: formatPlays(totalSummary?.post_7d_growth_total ?? 0),
          tooltip: '当前累计播放量减去7日播放量'
        }
      ]
    },
    {
      key: 'cpm',
      title: '平均CPM',
      value: formatCpm(totalSummary?.avg_cpm),
      tooltip: '基于已有有效累计播放数据计算的平均CPM',
      secondary: [
        {
          label: '7日CPM',
          value: formatCpm(totalSummary?.cpm_7d),
          tooltip: '基于内容发布约7天时的播放数据计算'
        }
      ],
      footnote: (
        <Space size={6} wrap style={{ justifyContent: 'center' }}>
          <Typography.Text type="secondary" style={metricFootnoteStyle}>
            播放数据已更新 {formatInteger(totalSummary?.latest_sample_count ?? 0)} /{' '}
            {formatInteger(totalSummary?.record_count ?? 0)}
          </Typography.Text>
          {(totalSummary?.latest_pending_count ?? 0) > 0 && (
            <Typography.Text type="secondary" style={metricFootnoteStyle}>
              待更新 {formatInteger(totalSummary?.latest_pending_count)} 条
            </Typography.Text>
          )}
          {(totalSummary?.anomaly_count ?? 0) > 0 && (
            <Typography.Text style={{ ...metricFootnoteStyle, color: '#d4380d' }}>
              异常数据 {formatInteger(totalSummary?.anomaly_count)} 条
            </Typography.Text>
          )}
        </Space>
      )
    },
    {
      key: 'hits',
      title: '爆款数',
      value: formatInteger(
        totalSummary?.hit_latest_count ?? totalSummary?.total_hits ?? totalSummary?.hit_count ?? 0
      ),
      suffix: '条',
      tooltip: '当前累计播放量达到爆款阈值的投放数量',
      secondary: [
        {
          label: '7日爆款数',
          value: `${formatInteger(totalSummary?.hit_7d_count ?? 0)} 条`,
          tooltip: '用于衡量内容前7天的起量能力'
        }
      ]
    },
    {
      key: 'hitRate',
      title: '爆款率',
      value: formatPercent(totalSummary?.hit_rate_latest ?? totalSummary?.hit_rate),
      tooltip: '爆款数 ÷ 已有有效累计播放数据的投放数',
      secondary: [
        {
          label: '7日爆款率',
          value: formatPercent(totalSummary?.hit_rate_7d),
          tooltip: '用于衡量内容前7天的起量能力'
        }
      ]
    }
  ]
  // 卡片标题：13px 灰色小字在上 + 水平居中 + 收紧行高，超长省略，避免撑高卡片
  const metricTitleStyle = {
    fontSize: 13,
    lineHeight: '18px',
    textAlign: 'center',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  }
  // 数值：20px + nowrap。valueStyle 作用于 .ant-statistic-content（数值 + 单位同容器），
  // 因此「60,535.00 元」「343.2万」等数值与单位始终在同一行，不会换行
  const metricValueStyle = {
    fontSize: 20,
    lineHeight: '28px',
    whiteSpace: 'nowrap',
    textAlign: 'center'
  }
  // 卡片标题/数值：Statistic 根节点撑满栅格单元并整体居中（仅作用于这 7 张卡片，不影响其他 Statistic）
  const metricStatisticStyle = { width: '100%', textAlign: 'center' }
  // secondary 区（7日指标）：浅灰分隔线 + 居中排版；单条时占满整行
  const metricSecondaryStyle = {
    borderTop: '1px solid #f0f0f0',
    marginTop: 8,
    paddingTop: 8,
    width: '100%',
    display: 'grid',
    columnGap: 8,
    // 多列时按内容自适应：给「后续新增播放量」这类较长指标名留足宽度，
    // 空间不足时再回落到省略号（minmax(0, auto) 允许收缩，不会溢出卡片）
    justifyContent: 'center'
  }
  const metricSecondaryLabelStyle = {
    fontSize: 11,
    lineHeight: '16px',
    color: 'rgba(0, 0, 0, 0.45)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  }
  const metricSecondaryValueStyle = { fontSize: 13, lineHeight: '20px', fontWeight: 500 }
  // 卡片内容：内边距 12px 16px + 标题/数值水平居中 + 撑满卡片高度（同一行卡片高度一致）
  const metricCardBodyStyle = {
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    textAlign: 'center',
    height: '100%',
    minHeight: 76
  }
  // 卡片外层（Grid 单元）：宽度由栅格决定，不做按 key 的固定宽度
  const metricCardWrapStyle = {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box'
  }

  return (
    <div>
      {/* 顶部操作区 */}
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
          <Space size={16} wrap>
            <Segmented
              value={caliber}
              onChange={(value) => {
                if (value === 'campaign') setCaliber(value)
              }}
              options={[
                { label: '按投放周', value: 'campaign' },
                {
                  label: (
                    <Tooltip title="当前没有逐周播放快照，暂时无法准确统计每周新增播放；后续接入周级数据后开放。">
                      <span>按发生周（暂未开放）</span>
                    </Tooltip>
                  ),
                  value: 'occurrence',
                  disabled: true
                }
              ]}
            />
            <Space size={8} wrap>
              <Typography.Text type="secondary">快捷范围：</Typography.Text>
              <Button size="small" onClick={() => applyQuickRange('4')}>
                近4周
              </Button>
              <Button size="small" onClick={() => applyQuickRange('8')}>
                近8周
              </Button>
              <Button size="small" onClick={() => applyQuickRange('all')}>
                全部
              </Button>
            </Space>
            <Typography.Text strong>当前范围：{rangeText}</Typography.Text>
          </Space>
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={loadBaseData}>
              刷新
            </Button>
            <Tooltip title={compareCheck.ok ? '打开达人对比' : compareCheck.reason}>
              <Button
                disabled={!compareCheck.ok}
                onClick={() => setCompareOpen(true)}
              >
                对比所选（{compareKeys.length}）
              </Button>
            </Tooltip>
            <Button
              icon={<DownloadOutlined />}
              onClick={() => {
                const count = exportCreatorStatsToExcel(allCreators, {
                  fileName: buildCreatorSummaryFileName(),
                  sheetName: '达人明细'
                })
                if (count) message.success(`已导出 ${count} 位达人明细`)
                else message.info('当前筛选条件下暂无可导出的达人数据')
              }}
            >
              导出达人明细
            </Button>
            <Button type="primary" icon={<DownloadOutlined />} onClick={handleExportSummary}>
              导出汇总
            </Button>
          </Space>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
            marginTop: 12
          }}
        >
          <Typography.Text type="secondary">周范围：</Typography.Text>
          <Select
            value={rangeStart}
            onChange={setRangeStart}
            options={weekOptions.map((item) => ({ value: item.weekCode, label: `${item.label}（${item.weekCode.slice(5)}）` }))}
            placeholder="起始周"
            style={{ width: 200 }}
            showSearch
            optionFilterProp="label"
          />
          <Typography.Text type="secondary">~</Typography.Text>
          <Select
            value={rangeEnd}
            onChange={setRangeEnd}
            options={weekOptions.map((item) => ({ value: item.weekCode, label: `${item.label}（${item.weekCode.slice(5)}）` }))}
            placeholder="结束周"
            style={{ width: 200 }}
            showSearch
            optionFilterProp="label"
          />
          <Typography.Text type="secondary">博主类型：</Typography.Text>
          <Select
            mode="multiple"
            value={filterTypes}
            onChange={setFilterTypes}
            placeholder="全部博主类型"
            style={{ minWidth: 240 }}
            allowClear
            optionFilterProp="label"
            options={filterMeta.creatorTypes.map((item) => ({
              value: item.value,
              label: `${item.value}（${item.count}）`
            }))}
          />
          <Typography.Text type="secondary">达人昵称：</Typography.Text>
          <Input
            allowClear
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            placeholder="输入即搜索（防抖 500ms）"
            maxLength={50}
            style={{ width: 220 }}
          />
          <Typography.Text type="secondary">最小投放次数：</Typography.Text>
          <Select
            value={minCampaigns}
            onChange={setMinCampaigns}
            options={MIN_CAMPAIGNS_OPTIONS}
            style={{ width: 150 }}
          />
          {compareKeys.length > 0 && (
            <Button size="small" onClick={() => setCompareKeys([])}>
              清空对比选择
            </Button>
          )}
        </div>
      </Card>

      {loadError && (
        <Alert
          type="error"
          showIcon
          message={loadError}
          style={{ marginTop: 16 }}
          action={
            <Button size="small" onClick={loadBaseData}>
              重试
            </Button>
          }
        />
      )}

      {/* 全局汇总卡片：CSS Grid 自动响应，minmax(170px, 1fr) 自动决定一行几列（宽屏 7 列，变窄自动换行） */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 12,
          width: '100%',
          alignItems: 'stretch',
          marginTop: 16
        }}
      >
        {metricCards.map((item) => (
          <div key={item.key} style={metricCardWrapStyle}>
            <Card
              size="small"
              style={{
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                borderRadius: 12,
                background: '#fff'
              }}
              styles={{ body: metricCardBodyStyle }}
            >
              {loading ? (
                <Skeleton active paragraph={{ rows: 1 }} style={{ width: '100%' }} />
              ) : (
                <>
                  <Tooltip title={item.tooltip}>
                    <Statistic
                      title={<span style={metricTitleStyle}>{item.title}</span>}
                      value={item.value}
                      suffix={item.suffix ? <span style={{ fontSize: 12 }}>{item.suffix}</span> : undefined}
                      style={metricStatisticStyle}
                      valueStyle={metricValueStyle}
                    />
                  </Tooltip>
                  {item.secondary?.length ? (
                    <div
                      style={{
                        ...metricSecondaryStyle,
                        gridTemplateColumns:
                          item.secondary.length > 1 ? 'minmax(0, auto) minmax(0, auto)' : '1fr'
                      }}
                    >
                      {item.secondary.map((sub) => (
                        <Tooltip key={sub.label} title={`${sub.label}：${sub.tooltip}`}>
                          <div style={{ minWidth: 0, textAlign: 'center' }}>
                            <div style={metricSecondaryLabelStyle}>{sub.label}</div>
                            <div style={metricSecondaryValueStyle}>{sub.value}</div>
                          </div>
                        </Tooltip>
                      ))}
                    </div>
                  ) : null}
                  {item.footnote ? (
                    <div style={{ marginTop: 6, width: '100%' }}>{item.footnote}</div>
                  ) : null}
                </>
              )}
            </Card>
          </div>
        ))}
      </div>

      {/* 按博主类型分组的达人汇总 */}
      {loading ? (
        <Card style={{ marginTop: 16 }}>
          <Skeleton active paragraph={{ rows: 8 }} />
        </Card>
      ) : groups.length === 0 ? (
        <Card style={{ marginTop: 16 }}>
          <Empty description="当前筛选条件下暂无达人数据" style={{ padding: 48 }} />
        </Card>
      ) : (
        <Collapse
          style={{ marginTop: 16 }}
          defaultActiveKey={groups.map((group) => group.creator_type)}
          items={groups.map((group) => ({
            key: group.creator_type,
            label: (
              <Space size={12} wrap>
                <Typography.Text strong>{group.creator_type}</Typography.Text>
                <Tag color="blue">{formatInteger(group.creator_count)} 位达人</Tag>
                <Tag>花费 {formatMoney(group.total_cost)} 元</Tag>
                <Tag>累计播放 {formatPlays(group.latest_play_total ?? group.total_play)}</Tag>
                <Tag color="green">平均CPM {formatCpm(group.avg_cpm)}</Tag>
                <Tag color="volcano">
                  爆款 {formatInteger(group.hit_latest_count ?? group.total_hits ?? 0)}
                </Tag>
                <Tag>投放 {formatInteger(group.total_campaigns)} 次</Tag>
              </Space>
            ),
            children: (
              <Table
                size="small"
                rowKey="__rowKey"
                columns={creatorColumns}
                // Phase 5：渲染前先算好行身份键（invalid 分支需要行下标来区分同名行）
                dataSource={group.creators.map((item, index) => ({
                  ...item,
                  __rowKey: creatorRowKey(item, index, identityMode)
                }))}
                pagination={false}
                onChange={handleTableSort}
                rowSelection={{
                  selectedRowKeys: compareKeys,
                  preserveSelectedRowKeys: true,
                  onChange: (keys) => setCompareKeys(keys),
                  // Phase 5：identity 模式下缺 creator_id 的行不是合法 ownership，禁止进入对比
                  getCheckboxProps: (record) => ({
                    disabled:
                      identityMode &&
                      (record.creator_id === null || record.creator_id === undefined)
                  }),
                  columnWidth: 46
                }}
                scroll={{ x: 1400 }}
              />
            )
          }))}
        />
      )}

      {/* 达人下钻明细抽屉 */}
      <Drawer
        title={
          drawerCreator
            ? `${creatorDisplayName(drawerCreator)}（${drawerCreator.creator_type || '未分类'}）· 明细`
            : '达人明细'
        }
        width={860}
        open={Boolean(drawerCreator)}
        onClose={() => setDrawerCreator(null)}
      >
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Typography.Text type="secondary">
            范围：{rangeText} · {caliberLabel} · 共 {detailRecords.length} 条投放记录
          </Typography.Text>
          {/* Phase 5：zero-history Creator（无任何历史投放）可正常打开详情，明确提示不伪造表现 */}
          {detailRecords.length === 0 ? (
            <Empty
              description={
                // 全量范围（默认）下 0 条 = 该 Creator 真的没有任何历史投放；
                // 缩小范围后 0 条 = 只是这个范围没有（Creator 仍在达人库中）
                !isCreatorFullRange
                  ? '该统计范围内暂无投放记录（达人仍在达人库中）'
                  : '暂无历史投放记录'
              }
              style={{ padding: 32 }}
            />
          ) : (
            <Table
              size="small"
              rowKey="id"
              loading={detailLoading}
              columns={detailColumns}
              dataSource={detailRecords}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              scroll={{ x: 1230 }}
            />
          )}
        </Space>
      </Drawer>

      {/* 达人对比弹窗：横向对比所选达人（2~5 位），按总花费降序 */}
      <Modal
        title={`达人对比（${compareRows.length} 位 · 按总花费降序）`}
        open={compareOpen}
        onCancel={() => setCompareOpen(false)}
        width={1000}
        footer={
          <Space>
            <Button onClick={() => setCompareOpen(false)}>关闭</Button>
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              onClick={() => {
                const count = exportCreatorStatsToExcel(compareRows, {
                  fileName: buildCreatorCompareFileName(),
                  sheetName: '达人对比'
                })
                if (count) message.success(`已导出 ${count} 位达人对比数据`)
              }}
            >
              导出Excel
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size="small" style={{ display: 'flex' }}>
          <Typography.Text type="secondary">
            范围：{rangeText} · {caliberLabel} · 最多支持对比 {COMPARE_MAX} 位达人（至少 {COMPARE_MIN} 位）
          </Typography.Text>
          {compareRows.length === 0 ? (
            <Empty description="请先在达人列表勾选 2~5 位达人" style={{ padding: 32 }} />
          ) : (
            <Table
              size="small"
              rowKey={creatorRowKey}
              dataSource={compareRows}
              pagination={false}
              scroll={{ x: 1180 }}
              columns={[
                {
                  title: '达人',
                  dataIndex: 'canonical_name',
                  width: 140,
                  fixed: 'left',
                  render: (_value, record) => creatorDisplayName(record)
                },
                { title: '博主类型', dataIndex: 'creator_type', width: 110 },
                {
                  title: '投放次数',
                  dataIndex: 'total_campaigns',
                  width: 100,
                  align: 'right',
                  render: (value) => formatInteger(value)
                },
                {
                  title: '总花费(元)',
                  dataIndex: 'total_cost',
                  width: 120,
                  align: 'right',
                  render: (value) => formatMoney(value)
                },
                {
                  title: '累计播放量',
                  dataIndex: 'latest_play_total',
                  width: 135,
                  align: 'right',
                  render: (value, record) => formatPlays(value ?? record?.total_play ?? 0)
                },
                {
                  title: '平均CPM',
                  dataIndex: 'avg_cpm',
                  width: 120,
                  align: 'right',
                  render: (value) => formatCpm(value)
                },
                {
                  title: '爆款数',
                  dataIndex: 'hit_latest_count',
                  width: 115,
                  align: 'right',
                  render: (value, record) => {
                    const hits = value ?? record?.hit_count ?? 0
                    return Number(hits) >= 1 ? (
                      <Tag color="volcano">{formatInteger(hits)}</Tag>
                    ) : (
                      formatInteger(hits)
                    )
                  }
                },
                {
                  title: '爆款率',
                  dataIndex: 'hit_rate_latest',
                  width: 115,
                  align: 'right',
                  render: (value, record) => formatPercent(value ?? record?.hit_rate)
                },
                {
                  title: '平均播放量',
                  dataIndex: 'avg_play',
                  width: 165,
                  align: 'right',
                  render: (value) => formatPlays(value)
                },
                {
                  title: '复投次数',
                  dataIndex: 'repeat_count',
                  width: 100,
                  align: 'right',
                  render: (value, record) => {
                    // Phase 5：与主表同一语义 —— zero-history Creator 显示 0，不显示「首次」
                    if (Number(record?.total_campaigns ?? 0) === 0) return formatInteger(0)
                    return Number(value) > 0 ? (
                      `${formatInteger(value)} 次`
                    ) : (
                      <Typography.Text type="secondary">首次</Typography.Text>
                    )
                  }
                }
              ]}
            />
          )}
        </Space>
      </Modal>
    </div>
  )
}
