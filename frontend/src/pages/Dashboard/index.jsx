import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Alert,
  Row,
  Skeleton,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  DownloadOutlined,
  FilterOutlined
} from '@ant-design/icons'
import dayjs from 'dayjs'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import {
  buildRecordsExportUrl,
  fetchAllRecords,
  getRecordFilters,
  getWeekRangeStats,
  getWeekStatsFiltered
} from '../../api/records'
import {
  dateToWeekCode,
  formatWeekLabel,
  getNextWeek,
  getPrevWeek,
  weekCodeToDateRange
} from '../../utils/dateCycle.js'
import { formatCpm, formatInteger, formatMoney, formatPlays } from '../../utils/format'
import { calcCpm } from '../../utils/calc.js'
import { getErrorMessage } from '../../utils/request'

// 按需引入 echarts 核心模块
echarts.use([
  PieChart,
  BarChart,
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer
])

// 明细列表分页大小（默认每页 20 条）
const DETAIL_PAGE_SIZE = 20

// 主色 #1677ff 延伸的渐变色系
const PALETTE = ['#1677ff', '#3d8bfd', '#5ea1ff', '#7fb6ff', '#a0cbff', '#c1dfff', '#e2f1ff']
const OTHER_COLOR = '#bfbfbf'
// 爆款阈值（与后端 HOT_PLAY_THRESHOLD 保持一致）：
//   累计爆款 = 最新累计播放量 ≥ 10 万（latest 必须有效）；7日爆款 = 7日累计播放量 ≥ 10 万
const HOT_PLAY_THRESHOLD = 100000

/**
 * 数据看板：基于现有投放记录接口，前端计算指标与图表
 * 顶部周选择器支持切换任意历史周（默认当前自然周，禁止未来周）
 */
export default function Dashboard() {
  const [loading, setLoading] = useState(true)
  // 周/口径切换时的指标加载状态（与 week-stats 请求生命周期联动，不额外发请求）
  const [statsLoading, setStatsLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [records, setRecords] = useState([])
  // 周度聚合（Batch 1 新口径：latest = 最新累计播放量；first = 7日累计播放量）
  const [weekStats, setWeekStats] = useState(null)
  // 统计口径：campaign 投放周（主口径，固定）。
  // occurrence 发生周缺少周级快照（无法还原每周新增播放），本轮前端停用（Segmented 选项 disabled）。
  const [caliber, setCaliber] = useState('campaign')
  const [selectedWeek, setSelectedWeek] = useState(null)
  // ---------- BI 分析状态（周范围 / 维度筛选 / 明细分页） ----------
  // 周范围：与选中周同源，startWeek === endWeek 时视为单周模式（保持原有看板表现）
  const [rangeStart, setRangeStart] = useState(null)
  const [rangeEnd, setRangeEnd] = useState(null)
  const [rangeData, setRangeData] = useState(null)
  const [filterTypes, setFilterTypes] = useState([])
  const [filterNicknames, setFilterNicknames] = useState([])
  const [filterMeta, setFilterMeta] = useState({
    creatorTypes: [],
    nicknames: [],
    weekRange: { earliestWeek: null, latestWeek: null }
  })
  const [weekOptions, setWeekOptions] = useState([])
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [detailPage, setDetailPage] = useState(1)
  const selectedWeekCode = selectedWeek ? selectedWeek.weekCode : null
  // 范围模式：起止周都存在且不相同
  const rangeEnabled = Boolean(rangeStart && rangeEnd && rangeStart !== rangeEnd)
  const pieRef = useRef(null)
  const barRef = useRef(null)
  const trendRef = useRef(null)
  const pieChartRef = useRef(null)
  const barChartRef = useRef(null)
  const trendChartRef = useRef(null)

  // 周信息构建：日期 -> { weekCode, startDate, endDate, label }
  const buildWeekInfo = (date) => {
    const weekCode = dateToWeekCode(date)
    return buildWeekInfoFromWeekCode(weekCode)
  }

  // 周信息构建：周码 -> { weekCode, startDate, endDate, label }
  const buildWeekInfoFromWeekCode = (weekCode) => {
    const range = weekCodeToDateRange(weekCode)
    if (!range) return null
    return {
      weekCode,
      ...range,
      label: formatWeekLabel(range.startDate, range.endDate)
    }
  }

  // 当前系统日期所在自然周（仅无数据时兜底，不参与按钮边界判断）
  const currentWeek = useMemo(() => buildWeekInfo(new Date()), [])

  // 拉取全量投放记录（可重试；默认选中最新有数据周，确保打开即有数据而非全 0）
  const loadRecords = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const rows = await fetchAllRecords()
      setRecords(rows)
      if (rows.length) {
        // 取所有记录中 time_cycle 最新的一周（YYYY-Wxx 字符串比较即时间序）
        const latestWeekCode = rows.reduce(
          (max, row) => (row.time_cycle > max ? row.time_cycle : max),
          ''
        )
        const nextSelectedWeek = buildWeekInfoFromWeekCode(latestWeekCode) || currentWeek
        setSelectedWeek(nextSelectedWeek)
        // 周范围默认与选中周一致（单周模式，保持原有看板表现）
        setRangeStart(nextSelectedWeek.weekCode)
        setRangeEnd(nextSelectedWeek.weekCode)
      } else {
        // 无任何数据：兜底选中系统当前自然周，展示空状态
        setSelectedWeek(currentWeek)
        setRangeStart(currentWeek?.weekCode || null)
        setRangeEnd(currentWeek?.weekCode || null)
      }
    } catch (err) {
      setRecords([])
      setSelectedWeek(currentWeek)
      setLoadError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [currentWeek])

  useEffect(() => {
    loadRecords()
  }, [loadRecords])

  // 投放周边界：只取数据中真实存在的投放周
  // （不再为 occurrence 把 second>0 的周扩展到下一周，避免 W34 这类「只有播放、没有花费」的空壳周）
  const weekBounds = useMemo(() => {
    let earliestWeek = null
    let latestWeek = null
    for (const row of records) {
      const code = row.time_cycle
      if (typeof code !== 'string' || !code) continue
      if (!earliestWeek || code < earliestWeek) earliestWeek = code
      if (!latestWeek || code > latestWeek) latestWeek = code
    }
    return { earliestWeek, latestWeek }
  }, [records])
  const earliestWeekCode = weekBounds.earliestWeek
  const latestWeekCode = weekBounds.latestWeek

  // 周下拉选项：按投放周范围展开（含空周）
  useEffect(() => {
    if (!earliestWeekCode || !latestWeekCode) {
      setWeekOptions([])
      return
    }
    const options = []
    let cursor = earliestWeekCode
    while (cursor && cursor <= latestWeekCode && options.length < 300) {
      const info = buildWeekInfoFromWeekCode(cursor)
      if (info) options.push(info)
      cursor = getNextWeek(cursor)
    }
    setWeekOptions(options)
  }, [earliestWeekCode, latestWeekCode])

  // 筛选元数据：博主类型 / 达人昵称（筛选面板用；周范围由上面的投放周边界决定）
  useEffect(() => {
    let active = true
    getRecordFilters()
      .then((res) => {
        if (!active || !res?.data) return
        setFilterMeta(res.data)
      })
      .catch(() => {
        // 元数据拉取失败不影响主流程（筛选面板为空）
      })
    return () => {
      active = false
    }
  }, [])

  // 拉取当前选中周（或周范围）+ 当前口径 + 当前筛选条件的聚合数据
  useEffect(() => {
    // 范围模式：使用 startWeek/endWeek；单周模式：沿用原有 weekCode 请求
    const isRange = Boolean(rangeStart && rangeEnd && rangeStart !== rangeEnd)
    if (!isRange && !selectedWeekCode) {
      setWeekStats(null)
      setRangeData(null)
      return undefined
    }
    let active = true
    // 周切换 / 口径切换：指标卡片进入骨架屏，请求结束（含失败）后平滑显示数值
    setStatsLoading(true)
    const filters = { creatorTypes: filterTypes, nicknames: filterNicknames }
    const request = isRange
      ? getWeekRangeStats({ startWeek: rangeStart, endWeek: rangeEnd, caliber, ...filters })
      : getWeekStatsFiltered(selectedWeekCode, caliber, filters)
    request
      .then((res) => {
        if (!active) return
        if (isRange) {
          setRangeData(res.data)
          setWeekStats(null)
        } else {
          setWeekStats(res.data)
          setRangeData(null)
        }
      })
      .catch(() => {
        if (!active) return
        setWeekStats(null)
        setRangeData(null)
      })
      .finally(() => active && setStatsLoading(false))
    return () => {
      active = false
    }
  }, [selectedWeekCode, caliber, rangeStart, rangeEnd, filterTypes, filterNicknames])

  // 周切换：更新选中周（加载态由上面的请求 effect 驱动）
  const switchToWeek = (weekCode) => {
    const info = buildWeekInfoFromWeekCode(weekCode)
    if (!info) return
    setSelectedWeek(info)
    // 单周切换：范围同步为该周（避免范围模式残留）
    setRangeStart(weekCode)
    setRangeEnd(weekCode)
  }

  // 日历选周：任意日期自动对齐到完整自然周
  const handlePickerChange = (date) => {
    if (!date) return
    const info = buildWeekInfo(date)
    if (info) switchToWeek(info.weekCode)
  }

  // 顶部核心指标：单周取 weekStats（week-stats 单周 bucket），范围取 rangeData.total_summary，
  // 两者字段完全一致；CPM / 爆款 / 样本数一律使用后端聚合结果，前端不再自行聚合
  const metrics = useMemo(() => {
    const source = rangeEnabled ? rangeData?.total_summary : weekStats
    return {
      // 最新累计播放量（兼容旧字段名 total_play）
      latestPlayTotal: source?.latest_play_total ?? source?.total_play ?? 0,
      // 7日累计播放量
      firstPlayTotal: source?.first_play_total ?? 0,
      // 7日后新增播放量
      post7dGrowthTotal: source?.post_7d_growth_total ?? 0,
      totalCost: source?.total_cost ?? 0,
      // 最新平均CPM / 7日CPM：直接使用后端结果；无有效样本时为 null（界面显示 -）
      avgCpm: Number.isFinite(source?.avg_cpm) ? source.avg_cpm : null,
      cpm7d: Number.isFinite(source?.cpm_7d) ? source.cpm_7d : null,
      creatorCount: source?.creator_count ?? 0,
      recordCount: source?.record_count ?? 0,
      // 爆款：累计爆款为主指标，7日爆款为辅助
      hitLatestCount: source?.hit_latest_count ?? 0,
      hit7dCount: source?.hit_7d_count ?? 0,
      // 数据完整性：有效最新累计样本 / 待更新 / 异常
      latestSampleCount: source?.latest_sample_count ?? 0,
      latestPendingCount: source?.latest_pending_count ?? 0,
      anomalyCount: source?.anomaly_count ?? 0
    }
  }, [weekStats, rangeEnabled, rangeData])

  const caliberLabel = '按投放周'
  // 口径说明（hover 提示文案）
  const playCaliberTip =
    '按投放周：按投放记录归属周统计。累计播放量取各条内容最近一次更新的累计播放量；' +
    '7日播放量为内容发布约7天时记录的累计播放量'

  // ---------- BI：周范围、快捷选择、筛选、导出 ----------
  const weekOptionValues = weekOptions.map((item) => item.weekCode)
  const selectedRangeText = rangeStart
    ? rangeStart === rangeEnd
      ? buildWeekInfoFromWeekCode(rangeStart)?.label || rangeStart
      : `${buildWeekInfoFromWeekCode(rangeStart)?.label || rangeStart} ~ ${
          buildWeekInfoFromWeekCode(rangeEnd)?.label || rangeEnd
        }（${rangeData?.total_summary?.weekCount ?? 0} 周）`
    : '--'
  const activeFilterCount = filterTypes.length + filterNicknames.length

  // 周范围选择：任一改动都同步「选中周」，单周模式与范围模式共用同一套聚合接口
  const handleRangeStartChange = (value) => {
    setRangeStart(value)
    // 起始周晚于结束周时自动纠正结束周
    if (value && rangeEnd && value > rangeEnd) setRangeEnd(value)
    const info = buildWeekInfoFromWeekCode(value)
    if (info) setSelectedWeek(info)
    setDetailPage(1)
  }

  const handleRangeEndChange = (value) => {
    setRangeEnd(value)
    if (value && rangeStart && value < rangeStart) setRangeStart(value)
    const info = buildWeekInfoFromWeekCode(value)
    if (info) setSelectedWeek(info)
    setDetailPage(1)
  }

  // 快捷范围：近 N 周 / 全部（以数据中最晚周为终点）
  const applyQuickRange = (type) => {
    const latest = weekOptionValues[weekOptionValues.length - 1] || selectedWeekCode
    const earliest = weekOptionValues[0] || selectedWeekCode
    if (!latest || !earliest) return
    if (type === 'all') {
      setRangeStart(earliest)
      setRangeEnd(latest)
    } else {
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
    const info = buildWeekInfoFromWeekCode(latest)
    if (info) setSelectedWeek(info)
    setDetailPage(1)
  }

  // 上一周 / 下一周：单周模式移动一周；范围模式整体平移窗口
  const shiftWindow = (direction) => {
    const step = direction === 'prev' ? getPrevWeek : getNextWeek
    const nextStart = step(rangeStart || selectedWeekCode)
    const nextEnd = step(rangeEnd || selectedWeekCode)
    if (!nextStart || !nextEnd) return
    if (earliestWeekCode && nextStart < earliestWeekCode) return
    if (latestWeekCode && nextEnd > latestWeekCode) return
    setRangeStart(nextStart)
    setRangeEnd(nextEnd)
    const info = buildWeekInfoFromWeekCode(nextEnd)
    if (info) setSelectedWeek(info)
    setDetailPage(1)
  }

  const handleExportDetail = () => {
    const url = buildRecordsExportUrl({
      startWeek: rangeStart,
      endWeek: rangeEnd,
      creatorTypes: filterTypes,
      nicknames: filterNicknames
    })
    // 触发浏览器下载（后端直接返回 xlsx，Content-Disposition 指定文件名）
    const link = document.createElement('a')
    link.href = url
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // 明细列表：按当前周范围 + 维度筛选过滤（与聚合接口同一套筛选口径）
  const detailRecords = useMemo(() => {
    return records.filter((row) => {
      const code = row.time_cycle
      if (rangeStart && code < rangeStart) return false
      if (rangeEnd && code > rangeEnd) return false
      if (filterTypes.length && !filterTypes.includes(String(row.creator_type || '').trim())) {
        return false
      }
      if (
        filterNicknames.length &&
        !filterNicknames.includes(String(row.nickname || '').trim())
      ) {
        return false
      }
      return true
    })
  }, [records, rangeStart, rangeEnd, filterTypes, filterNicknames])

  useEffect(() => {
    setDetailPage(1)
  }, [detailRecords.length])

  // 单条记录的最新累计口径：latest 已填写且不违反 latest >= first 时才可信
  const recordLatestPlay = (record) => {
    const latestRaw = record?.second_week_play
    if (latestRaw === null || latestRaw === undefined || latestRaw === '') return null
    const latest = Number(latestRaw)
    if (!Number.isFinite(latest)) return null
    const firstRaw = record?.first_play
    if (firstRaw !== null && firstRaw !== undefined && firstRaw !== '') {
      const first = Number(firstRaw)
      // latest < first 属于异常数据，不可信（不参与累计爆款 / 最新CPM / 7日后新增）
      if (Number.isFinite(first) && latest < first) return null
    }
    return latest
  }

  // 最新CPM（单条）= 花费 ÷ 最新累计播放量 × 1000；latest 缺失 / 异常 / 为 0 → 显示 -
  const recordLatestCpm = (record) => {
    const latest = recordLatestPlay(record)
    if (latest === null) return null
    return calcCpm(record?.total_cost, latest)
  }

  // 7日后新增播放量 = 最新累计播放量 − 7日累计播放量（仅两者都有且 latest >= first 时展示，否则 -）
  const recordPost7dGrowth = (record) => {
    const latest = recordLatestPlay(record)
    const firstRaw = record?.first_play
    if (latest === null || firstRaw === null || firstRaw === undefined || firstRaw === '') return null
    const first = Number(firstRaw)
    if (!Number.isFinite(first)) return null
    return latest - first
  }

  // 范围模式：把各周 creators 合并成一条达人播放量列表（与范围汇总同口径）
  const pieSource = useMemo(() => {
    if (!rangeEnabled) return weekStats?.creators || []
    const merged = new Map()
    for (const week of rangeData?.weeks || []) {
      for (const item of week.creators || []) {
        const name = String(item.nickname || '').trim()
        if (!name) continue
        merged.set(name, (merged.get(name) || 0) + (Number(item.play) || 0))
      }
    }
    return [...merged.entries()].map(([nickname, play]) => ({ nickname, play }))
  }, [rangeEnabled, rangeData, weekStats])

  // 饼图：达人播放量占比（Top7 + 其他）
  const pieData = useMemo(() => {
    const sorted = (pieSource || [])
      .map((item) => ({
        name: String(item.nickname || '').trim() || '未知达人',
        value: Number(item.play) || 0
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value)
    if (sorted.length <= 7) return sorted
    const top = sorted.slice(0, 7)
    const rest = sorted.slice(7).reduce((sum, item) => sum + item.value, 0)
    return [...top, { name: '其他', value: rest, itemStyle: { color: OTHER_COLOR } }]
  }, [pieSource])

  // 爆款类型分布：使用与页面其它区域完全相同的「当前筛选后记录」（detailRecords 已应用
  // 周范围 + 博主类型 + 达人昵称），确保筛选口径一致。
  // 主系列 = 累计爆款：有效 latest ≥ 阈值（latest 为空 → 不计入；latest < first 的异常 → 不计入）
  // 辅助系列 = 7日爆款：first 有效且 ≥ 阈值（first = 0 是有效观察，但不是爆款）
  const barData = useMemo(() => {
    const map = new Map()
    for (const row of detailRecords) {
      const latest = recordLatestPlay(row)
      const firstRaw = row?.first_play
      const first = firstRaw === null || firstRaw === undefined || firstRaw === '' ? null : Number(firstRaw)
      const hitLatest = latest !== null && latest >= HOT_PLAY_THRESHOLD
      const hit7d = first !== null && Number.isFinite(first) && first >= HOT_PLAY_THRESHOLD
      if (!hitLatest && !hit7d) continue
      const type = String(row.creator_type || '').trim() || '未分类'
      const entry = map.get(type) || { hitLatest: 0, hit7d: 0 }
      if (hitLatest) entry.hitLatest += 1
      if (hit7d) entry.hit7d += 1
      map.set(type, entry)
    }
    return [...map.entries()]
      .map(([name, value]) => ({ name, ...value }))
      .sort((a, b) => b.hitLatest - a.hitLatest || b.hit7d - a.hit7d)
  }, [detailRecords])

  // 图表配置（数据变化时重新生成）
  const pieOption = useMemo(
    () => ({
      color: PALETTE,
      // 图表数值格式与全局统一：播放量万级转换
      tooltip: {
        trigger: 'item',
        formatter: (params) => `${params.name}<br/>${formatPlays(params.value)}（${params.percent}%）`
      },
      legend: { orient: 'vertical', right: 0, top: 'center' },
      series: [
        {
          name: '累计播放量',
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['38%', '50%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
          label: { show: false },
          emphasis: { label: { show: true, fontWeight: 'bold' } },
          data: pieData
        }
      ]
    }),
    [pieData]
  )

  const barOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params) => {
          const rows = Array.isArray(params) ? params : [params]
          const head = rows[0]?.axisValue ?? ''
          const lines = rows.map(
            (item) => `${item.marker}${item.seriesName}：${formatInteger(item.value)} 条`
          )
          return [head, ...lines, '（“爆款”按当前累计播放量判断）'].join('<br/>')
        }
      },
      legend: { data: ['爆款', '7日爆款'], top: 0 },
      grid: { left: 12, right: 24, top: 40, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        data: barData.map((item) => item.name),
        axisTick: { alignWithLabel: true }
      },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        {
          name: '爆款',
          type: 'bar',
          data: barData.map((item) => item.hitLatest),
          itemStyle: { color: '#1677ff', borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 28
        },
        {
          name: '7日爆款',
          type: 'bar',
          data: barData.map((item) => item.hit7d),
          itemStyle: { color: '#91caff', borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 28
        }
      ]
    }),
    [barData]
  )

  // 周度趋势（投放周口径）：总花费（左轴）/ 最新累计播放量(万) 与 最新平均CPM（右轴）
  // 含义：各投放周投出去的内容，截至目前（最新采集）的累计表现——不是「该自然周实际产生多少播放」
  const trendWeeks = rangeData?.weeks || []
  const trendOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const week = trendWeeks[params[0]?.dataIndex ?? 0]
          if (!week) return ''
          return [
            `${week.weekCode}`,
            `总花费：${formatMoney(week.total_cost)} 元`,
            `累计播放量：${formatPlays(week.latest_play_total ?? week.total_play)}`,
            `平均CPM：${formatCpm(week.avg_cpm)}`,
            `7日播放量：${formatPlays(week.first_play_total)}　7日CPM：${formatCpm(week.cpm_7d)}`,
            `后续新增播放量：${formatPlays(week.post_7d_growth_total)}`,
            `投放达人数：${formatInteger(week.creator_count)} 人　投放次数：${formatInteger(
              week.record_count
            )}`
          ].join('<br/>')
        }
      },
      legend: { data: ['总花费(元)', '累计播放量(万)', '平均CPM(元)'], top: 0 },
      grid: { left: 12, right: 24, top: 44, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: trendWeeks.map((week) => week.weekCode.slice(5))
      },
      yAxis: [
        { type: 'value', name: '花费(元)', position: 'left' },
        { type: 'value', name: '播放(万)/CPM(元)', position: 'right' }
      ],
      series: [
        {
          name: '总花费(元)',
          type: 'line',
          smooth: true,
          yAxisIndex: 0,
          itemStyle: { color: '#faad14' },
          data: trendWeeks.map((week) => Number(week.total_cost) || 0)
        },
        {
          name: '累计播放量(万)',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          itemStyle: { color: '#1677ff' },
          data: trendWeeks.map((week) => {
            const play = week.latest_play_total ?? week.total_play
            return Number.isFinite(play) ? Number((play / 10000).toFixed(2)) : null
          })
        },
        {
          name: '平均CPM(元)',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          itemStyle: { color: '#52c41a' },
          // 直接用后端 avg_cpm（无有效 latest 样本时为 null → 图上留空断点，不再画成 0）
          data: trendWeeks.map((week) => (Number.isFinite(week.avg_cpm) ? week.avg_cpm : null))
        }
      ]
    }),
    [trendWeeks]
  )

  // 明细列表列
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
      render: (value) => formatPlays(value)
    },
    {
      title: 'CPM',
      key: 'latestCpm',
      width: 105,
      align: 'right',
      render: (_, record) => formatCpm(recordLatestCpm(record))
    },
    {
      title: '后续新增播放量',
      key: 'post7dGrowth',
      width: 145,
      align: 'right',
      render: (_, record) => formatPlays(recordPost7dGrowth(record))
    },
    { title: '发布日期', dataIndex: 'publish_date', width: 110, render: (value) => value || '-' }
  ]

  // 渲染/更新图表：实例复用 + setOption 平滑过渡，数据为空时销毁实例
  useEffect(() => {
    if (loading) return
    const renderChart = (ref, chartRef, data, option) => {
      if (data.length === 0) {
        if (chartRef.current) {
          chartRef.current.dispose()
          chartRef.current = null
        }
        return
      }
      const el = ref.current
      if (!el) return
      let instance = chartRef.current
      // 骨架屏加载会把图表容器卸载后重建：旧实例绑定在已移除的节点上，需要重建
      if (instance && typeof instance.getDom === 'function' && instance.getDom() !== el) {
        instance.dispose()
        instance = null
      }
      if (!instance) instance = echarts.init(el)
      chartRef.current = instance
      instance.setOption(option)
    }
    renderChart(pieRef, pieChartRef, pieData, pieOption)
    renderChart(barRef, barChartRef, barData, barOption)
    renderChart(trendRef, trendChartRef, trendWeeks, trendOption)
    // statsLoading 决定骨架屏与图表容器之间的切换：必须作为依赖，
    // 否则「加载中先卸载容器、加载完成后容器重建」时不会重新 init 图表
  }, [
    loading,
    statsLoading,
    pieData,
    pieOption,
    barData,
    barOption,
    trendWeeks,
    trendOption
  ])

  // 窗口缩放与组件卸载清理
  useEffect(() => {
    const handleResize = () => {
      pieChartRef.current?.resize()
      barChartRef.current?.resize()
      trendChartRef.current?.resize()
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      pieChartRef.current?.dispose()
      barChartRef.current?.dispose()
      trendChartRef.current?.dispose()
      pieChartRef.current = null
      barChartRef.current = null
      trendChartRef.current = null
    }
  }, [])

  // ---------- 顶部核心指标卡片：仅布局/样式（数据计算、API、图表、日期与口径逻辑均不变） ----------
  // 四张主卡严格等高：Row 默认 stretch，每列只放一个 Card，height:100% 不会再挤出任何子卡片
  const metricCardStyle = { height: '100%', minHeight: 180 }
  // 卡内排版统一：标题 + 主数字在上，播放量卡的 secondary 贴底，四张卡一致
  const metricCardBodyStyle = {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: 12
  }
  // 主数字 30px；「投放达人数量」单独放大到 32px
  const metricValueStyle = { fontSize: 30, lineHeight: '36px', fontWeight: 600 }
  const metricValueLargeStyle = { fontSize: 32, lineHeight: '38px', fontWeight: 600 }
  // 播放量卡内的 secondary 指标：浅灰分隔线 + 左右两栏（不再是独立 Card）
  const playSplitStyle = {
    borderTop: '1px solid #f0f0f0',
    paddingTop: 12,
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    columnGap: 12
  }
  // 卡内 secondary 指标名固定单行：空间不足时省略而不是拆字（完整含义由外层 Tooltip 说明）
  const playSplitLabelStyle = {
    fontSize: 12,
    display: 'block',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  }
  const playSplitValueStyle = { fontSize: 18, lineHeight: '24px', fontWeight: 500 }
  // 数据完整性提示（小号辅助文案）
  const metricFootnoteStyle = { fontSize: 12, lineHeight: '18px', color: 'rgba(0, 0, 0, 0.45)' }

  return (
    <div>
      {/* 周选择栏（与指标卡同宽，右对齐布局） */}
      <Row gutter={[16, 16]}>
        <Col span={24}>
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
                {/* 统计口径：按投放周（主口径，固定）；按发生周缺周级快照，本轮暂未开放 */}
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
                {/* 快捷范围：近 4 周 / 近 8 周 / 全部 */}
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
                <Typography.Text strong>
                  当前统计：{selectedRangeText}
                </Typography.Text>
              </Space>
              <Space wrap>
                <Button
                  icon={<FilterOutlined />}
                  onClick={() => setFiltersOpen((prev) => !prev)}
                  type={filtersOpen || activeFilterCount > 0 ? 'primary' : 'default'}
                  ghost={filtersOpen || activeFilterCount > 0}
                >
                  筛选{activeFilterCount > 0 ? `（${activeFilterCount}）` : ''}
                </Button>
                <Button icon={<DownloadOutlined />} onClick={handleExportDetail}>
                  导出明细
                </Button>
              </Space>
            </div>

            {/* 周范围选择：起止周下拉（所有可用周），单周模式 = 起止周相同 */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 12,
                marginTop: 12
              }}
            >
              <Space wrap>
                <Typography.Text type="secondary">周范围：</Typography.Text>
                <Select
                  value={rangeStart}
                  onChange={handleRangeStartChange}
                  options={weekOptions.map((item) => ({
                    value: item.weekCode,
                    label: `${item.label}（${item.weekCode.slice(5)}）`
                  }))}
                  placeholder="起始周"
                  style={{ width: 200 }}
                  showSearch
                  optionFilterProp="label"
                />
                <Typography.Text type="secondary">~</Typography.Text>
                <Select
                  value={rangeEnd}
                  onChange={handleRangeEndChange}
                  options={weekOptions.map((item) => ({
                    value: item.weekCode,
                    label: `${item.label}（${item.weekCode.slice(5)}）`
                  }))}
                  placeholder="结束周"
                  style={{ width: 200 }}
                  showSearch
                  optionFilterProp="label"
                />
              </Space>
              <Space wrap>
                <Button
                  icon={<ArrowLeftOutlined />}
                  onClick={() => shiftWindow('prev')}
                  // 上一周：仅当窗口起始已到最早有数据的周时禁用
                  disabled={!rangeStart || (earliestWeekCode && rangeStart <= earliestWeekCode)}
                >
                  上一周
                </Button>
                <DatePicker
                  value={selectedWeek ? dayjs(selectedWeek.startDate) : null}
                  onChange={handlePickerChange}
                  format="MM/DD"
                  allowClear={false}
                  placeholder="跳转到周"
                  style={{ width: 150 }}
                />
                <Button
                  icon={<ArrowRightOutlined />}
                  onClick={() => shiftWindow('next')}
                  // 下一周：窗口结束到达数据中最新的周时禁用
                  disabled={!rangeEnd || (latestWeekCode && rangeEnd >= latestWeekCode)}
                >
                  下一周
                </Button>
              </Space>
            </div>

            {/* 筛选面板：博主类型 / 达人昵称（实时生效，可折叠） */}
            {filtersOpen && (
              <div
                style={{
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: '1px solid #f0f0f0',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 16
                }}
              >
                <div style={{ minWidth: 280, flex: '1 1 280px' }}>
                  <Typography.Text type="secondary">博主类型（可多选）</Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    <Space size={8} wrap style={{ marginBottom: 6 }}>
                      <Button
                        size="small"
                        onClick={() =>
                          setFilterTypes(filterMeta.creatorTypes.map((item) => item.value))
                        }
                      >
                        全选
                      </Button>
                      <Button size="small" onClick={() => setFilterTypes([])}>
                        取消全选
                      </Button>
                    </Space>
                    <Select
                      mode="multiple"
                      value={filterTypes}
                      onChange={(values) => {
                        setFilterTypes(values)
                        setDetailPage(1)
                      }}
                      placeholder="全部博主类型"
                      style={{ width: '100%' }}
                      allowClear
                      optionFilterProp="label"
                      options={filterMeta.creatorTypes.map((item) => ({
                        value: item.value,
                        label: `${item.value}（${item.count}）`
                      }))}
                    />
                  </div>
                </div>
                <div style={{ minWidth: 280, flex: '1 1 280px' }}>
                  <Typography.Text type="secondary">达人昵称（支持搜索）</Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    <Select
                      mode="multiple"
                      value={filterNicknames}
                      onChange={(values) => {
                        setFilterNicknames(values)
                        setDetailPage(1)
                      }}
                      placeholder="全部达人"
                      style={{ width: '100%' }}
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      maxTagCount="responsive"
                      options={filterMeta.nicknames.map((item) => ({
                        value: item.value,
                        label: `${item.value}（${item.count}）`
                      }))}
                    />
                  </div>
                </div>
                <div style={{ alignSelf: 'flex-end' }}>
                  <Button
                    size="small"
                    onClick={() => {
                      setFilterTypes([])
                      setFilterNicknames([])
                    }}
                  >
                    清空筛选
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </Col>
      </Row>

      <Spin spinning={statsLoading}>
        {/* 数据加载失败提示 */}
        {loadError && (
          <Alert
            type="error"
            showIcon
            message={loadError}
            style={{ marginBottom: 16 }}
            action={
              <Button size="small" onClick={loadRecords}>
                重试
              </Button>
            }
          />
        )}

        {/* 无任何数据：统一空状态，不展示全 0 数值 */}
        {!loading && !loadError && records.length === 0 && (
          <Card>
            <Empty description="暂无任何投放数据，请先新增投放记录" style={{ padding: 48 }} />
          </Card>
        )}

        {records.length > 0 && (
          <>
            {/* 顶部核心指标行：桌面端一行四张（lg 7+5+5+7=24），左右稍宽、中间稍窄，四张等高 */}
            <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
              <Col xs={24} sm={12} lg={7}>
                {/* 播放量卡：主指标累计播放量 + 卡内 secondary（7日播放量 / 后续新增播放量） */}
                <Card style={metricCardStyle} styles={{ body: metricCardBodyStyle }}>
                  {loading || statsLoading ? (
                    <Skeleton active paragraph={{ rows: 3 }} />
                  ) : (
                    <>
                      <Tooltip title={playCaliberTip}>
                        <Statistic
                          title="累计播放量"
                          value={metrics.latestPlayTotal}
                          formatter={(value) => formatPlays(value)}
                          valueStyle={metricValueStyle}
                        />
                      </Tooltip>
                      {/* secondary：7日播放量 / 后续新增播放量（均为后端聚合值） */}
                      <div style={playSplitStyle}>
                        <Tooltip title="内容发布约7天时记录的累计播放量">
                          <Statistic
                            title={<span style={playSplitLabelStyle}>7日播放量</span>}
                            value={formatPlays(metrics.firstPlayTotal)}
                            valueStyle={playSplitValueStyle}
                          />
                        </Tooltip>
                        <Tooltip title="当前累计播放量减去7日播放量">
                          <Statistic
                            title={<span style={playSplitLabelStyle}>后续新增播放量</span>}
                            value={formatPlays(metrics.post7dGrowthTotal)}
                            valueStyle={playSplitValueStyle}
                          />
                        </Tooltip>
                      </div>
                    </>
                  )}
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={5}>
                <Card style={metricCardStyle} styles={{ body: metricCardBodyStyle }}>
                  {loading || statsLoading ? (
                    <Skeleton active paragraph={{ rows: 1 }} />
                  ) : (
                    <Tooltip title="总花费：所选投放周范围内全部投放记录的花费之和（按投放记录归属周统计）">
                      <Statistic
                        title="总花费"
                        value={metrics.totalCost}
                        formatter={(value) => formatMoney(value)}
                        suffix="元"
                        valueStyle={metricValueStyle}
                      />
                    </Tooltip>
                  )}
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={5}>
                <Card style={metricCardStyle} styles={{ body: metricCardBodyStyle }}>
                  {loading || statsLoading ? (
                    <Skeleton active paragraph={{ rows: 3 }} />
                  ) : (
                    <>
                      <Tooltip
                        title="基于已有有效累计播放数据计算的平均CPM"
                      >
                        <Statistic
                          title="平均CPM"
                          value={formatCpm(metrics.avgCpm)}
                          valueStyle={metricValueStyle}
                        />
                      </Tooltip>
                      {/* secondary：7日CPM + 最新累计数据完整性提示 */}
                      <div style={playSplitStyle}>
                        <Tooltip title="基于内容发布约7天时的播放数据计算">
                          <Statistic
                            title={<span style={playSplitLabelStyle}>7日CPM</span>}
                            value={formatCpm(metrics.cpm7d)}
                            valueStyle={playSplitValueStyle}
                          />
                        </Tooltip>
                        <Tooltip title="播放数据已更新 = 有有效累计播放数据的投放数；待更新 = 尚未填写；异常 = 累计播放量小于7日播放量">
                          {/* 数据完整性提示独占一整行：保证「已更新 X / Y」不因卡内两栏太窄而拆行 */}
                          <div style={{ gridColumn: '1 / -1', alignSelf: 'center' }}>
                            <div>
                              <Typography.Text style={{ ...metricFootnoteStyle, whiteSpace: 'nowrap' }}>
                                播放数据已更新{' '}
                                <span style={{ whiteSpace: 'nowrap' }}>
                                  {formatInteger(metrics.latestSampleCount)} /{' '}
                                  {formatInteger(metrics.recordCount)}
                                </span>
                              </Typography.Text>
                            </div>
                            {metrics.latestPendingCount > 0 && (
                              <div>
                                <Typography.Text style={metricFootnoteStyle}>
                                  待更新 {formatInteger(metrics.latestPendingCount)} 条
                                </Typography.Text>
                              </div>
                            )}
                            {metrics.anomalyCount > 0 && (
                              <div>
                                <Typography.Text style={{ ...metricFootnoteStyle, color: '#d4380d' }}>
                                  异常数据 {formatInteger(metrics.anomalyCount)} 条
                                </Typography.Text>
                              </div>
                            )}
                          </div>
                        </Tooltip>
                      </div>
                    </>
                  )}
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={7}>
                {/* 达人数量卡：宽度 lg=7 且主数字略大（32px），保持同一套视觉语言 */}
                <Card style={metricCardStyle} styles={{ body: metricCardBodyStyle }}>
                  {loading || statsLoading ? (
                    <Skeleton active paragraph={{ rows: 1 }} />
                  ) : (
                    <Tooltip title="投放达人数：所选投放周范围内有投放记录的达人昵称去重数量">
                      <Statistic
                        title="投放达人数"
                        value={formatInteger(metrics.creatorCount)}
                        suffix="人"
                        valueStyle={metricValueLargeStyle}
                      />
                    </Tooltip>
                  )}
                </Card>
              </Col>
            </Row>

            {/* 下方双列图表区 */}
            <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
              <Col xs={24} md={12}>
                <Card title="达人累计播放量占比">
                  {loading ? (
                    <Skeleton active paragraph={{ rows: 8 }} />
                  ) : pieData.length === 0 ? (
                    <Empty
                      description={
                        rangeEnabled
                          ? '所选范围暂无有效累计播放量数据'
                          : '该周暂无有效累计播放量数据'
                      }
                      style={{ padding: 40 }}
                    />
                  ) : (
                    <div ref={pieRef} style={{ width: '100%', height: 360 }} />
                  )}
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card title="爆款类型分布">
                  {loading ? (
                    <Skeleton active paragraph={{ rows: 8 }} />
                  ) : barData.length === 0 ? (
                    <Empty
                      description="暂无爆款记录（当前累计播放量 ≥ 10 万）"
                      style={{ padding: 40 }}
                    />
                  ) : (
                    <div ref={barRef} style={{ width: '100%', height: 360 }} />
                  )}
                </Card>
              </Col>
            </Row>

            {/* 周度趋势：仅范围模式展示（单周模式保持原有看板布局不变） */}
            {rangeEnabled && (
              <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
                <Col span={24}>
                  <Card
                    title={`投放周趋势${activeFilterCount ? ' · 已筛选' : ''}`}
                    extra={
                      <Typography.Text type="secondary">
                        近 {trendWeeks.length} 周 · 展示各投放周内容当前的累计表现
                      </Typography.Text>
                    }
                  >
                    {loading || statsLoading ? (
                      <Skeleton active paragraph={{ rows: 8 }} />
                    ) : trendWeeks.length === 0 ? (
                      <Empty description="所选范围内暂无数据" style={{ padding: 40 }} />
                    ) : (
                      <div ref={trendRef} style={{ width: '100%', height: 340 }} />
                    )}
                  </Card>
                </Col>
              </Row>
            )}

            {/* 投放明细列表：当前周范围 + 筛选条件下的全部记录（默认每页 20 条） */}
            <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
              <Col span={24}>
                <Card
                  title="投放明细"
                  extra={
                    <Space size={12} wrap>
                      <Typography.Text type="secondary">
                        共 {detailRecords.length} 条
                      </Typography.Text>
                      <Button size="small" icon={<DownloadOutlined />} onClick={handleExportDetail}>
                        导出明细
                      </Button>
                    </Space>
                  }
                >
                  <Table
                    size="small"
                    rowKey="id"
                    loading={loading}
                    columns={detailColumns}
                    dataSource={detailRecords}
                    pagination={{
                      pageSize: DETAIL_PAGE_SIZE,
                      current: detailPage,
                      onChange: setDetailPage,
                      showSizeChanger: false,
                      showTotal: (total) => `共 ${total} 条`
                    }}
                    scroll={{ x: 1180 }}
                  />
                </Card>
              </Col>
            </Row>
          </>
        )}
      </Spin>
    </div>
  )
}
