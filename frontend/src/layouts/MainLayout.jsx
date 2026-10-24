import { useEffect, useRef, useState } from 'react'
import { Alert, Avatar, Button, Layout, Menu, Space, Tag, Tooltip, Typography, theme } from 'antd'
import {
  BarChartOutlined,
  ExperimentOutlined,
  HistoryOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  OrderedListOutlined,
  RadarChartOutlined,
  TeamOutlined,
  UserOutlined
} from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { checkHealth } from '../api/health'
import { getAiStatus } from '../api/ai'
import AiConfigModal from '../components/AiConfigModal'
import { DEFAULT_PROVIDER, getAiConfig, getProviderPreset } from '../utils/aiConfig.js'
import { DEMO_MODE } from '../demo/demoMode.js'

const { Header, Sider, Content } = Layout

// Persistent Sidebar：顶部导航高度（antd 默认 Header 高度，与下方 offset 保持一致）
const HEADER_HEIGHT = 64

const MENU_ITEMS = [
  { key: 'dashboard', icon: <BarChartOutlined />, label: '数据看板' },
  // Creator Identity V1 Phase 5：页面已切换为 Creator Library（仅改 label，不改菜单机制）
  { key: 'creators', icon: <TeamOutlined />, label: '达人库' },
  { key: 'repurchase-radar', icon: <RadarChartOutlined />, label: '复投雷达' },
  { key: 'creator-playbook', icon: <ExperimentOutlined />, label: '达人拓展' },
  // Phase 5：与页面职责对齐（仅改 label，不改菜单机制 / key / 路由）
  { key: 'records', icon: <OrderedListOutlined />, label: '投放记录' },
  { key: 'import-history', icon: <HistoryOutlined />, label: '导入历史' }
]

// 菜单 key <-> 路由路径（保持一致，便于高亮与跳转）
const MENU_PATHS = {
  dashboard: '/dashboard',
  creators: '/creators',
  'repurchase-radar': '/repurchase-radar',
  'creator-playbook': '/creator-playbook',
  records: '/records',
  'import-history': '/import-history'
}

export default function MainLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(true)
  // 后端连通状态：checking 检测中 / ok 已连接 / down 未连接
  const [backendStatus, setBackendStatus] = useState('checking')
  // AI 配置弹窗
  const [aiConfigOpen, setAiConfigOpen] = useState(false)
  // 浏览器当前页面的用户 Key 与后端环境变量是两种不同来源。
  const [aiConfig, setAiConfig] = useState(() => getAiConfig())
  const [environmentStatus, setEnvironmentStatus] = useState({ checked: false, available: false, provider: null })
  const statusRequestId = useRef(0)
  const aiStatus = aiConfig?.apiKey
    ? 'session'
    : !environmentStatus.checked
      ? 'checking'
      : environmentStatus.available && environmentStatus.provider === (aiConfig?.provider || DEFAULT_PROVIDER)
        ? 'environment'
        : 'unavailable'
  const { token } = theme.useToken()
  // 根据当前路由高亮菜单（默认首页仍为数据看板）
  const selectedKey =
    Object.keys(MENU_PATHS).find((key) =>
      location.pathname.startsWith(MENU_PATHS[key])
    ) || 'dashboard'

  const refreshEnvironmentStatus = () => {
    const requestId = ++statusRequestId.current
    getAiStatus()
      .then((res) => {
        if (requestId === statusRequestId.current) {
          setEnvironmentStatus({
            checked: true,
            available: Boolean(res.data?.available),
            provider: res.data?.provider || null
          })
        }
      })
      .catch(() => {
        if (requestId === statusRequestId.current) {
          setEnvironmentStatus({ checked: true, available: false, provider: null })
        }
      })
  }

  // 首页加载时自动调用健康检查，确认后端连通
  useEffect(() => {
    let active = true
    checkHealth()
      .then(() => active && setBackendStatus('ok'))
      .catch(() => active && setBackendStatus('down'))
    // 同时检测 AI 服务状态
    refreshEnvironmentStatus()
    return () => {
      active = false
      statusRequestId.current += 1
    }
  }, [])

  // 保存后立即显示当前页面 Key；状态接口只查询后端环境变量，不发送 Key。
  const handleAiConfigSaved = (config) => {
    setAiConfigOpen(false)
    setAiConfig(config)
    refreshEnvironmentStatus()
  }

  const handleAiDisconnected = () => {
    const config = getAiConfig()
    setAiConfig(config)
    setAiConfigOpen(false)
    setEnvironmentStatus({ checked: true, available: false, provider: config?.provider || DEFAULT_PROVIDER })
    refreshEnvironmentStatus()
  }

  return (
    <Layout style={{ minHeight: '100vh', background: token.colorBgLayout }}>
      {/* 顶部导航栏 */}
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: token.colorBgContainer,
          padding: '0 24px',
          boxShadow: '0 1px 4px rgba(0, 21, 41, 0.08)',
          // 固定顶栏：始终留在 viewport 顶部（z-index 低于侧栏内的交互，但高于内容）
          position: 'fixed',
          top: 0,
          insetInlineStart: 0,
          insetInlineEnd: 0,
          width: '100%',
          height: HEADER_HEIGHT,
          lineHeight: `${HEADER_HEIGHT}px`,
          zIndex: 20
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
          />
          <Typography.Title level={4} style={{ margin: 0 }}>
            达人投放工作台
          </Typography.Title>
        </div>
        <Space size={12}>
          {DEMO_MODE && <Tag color="warning">演示数据，非真实投放记录</Tag>}
          {backendStatus === 'checking' && <Tag>后端检测中...</Tag>}
          {backendStatus === 'ok' && <Tag color="success">后端已连接</Tag>}
          {backendStatus === 'down' && <Tag color="error">后端未连接</Tag>}
          {backendStatus === 'ok' && aiStatus === 'checking' && (
            <Tag style={{ cursor: 'pointer' }} onClick={() => setAiConfigOpen(true)}>
              AI检测中...
            </Tag>
          )}
          {backendStatus === 'ok' && aiStatus === 'session' && (
            <Tooltip
              title={`${getProviderPreset(aiConfig?.provider).label} · ${
                aiConfig?.model || getProviderPreset(aiConfig?.provider).model
              }`}
            >
              <Tag
                color="success"
                style={{ cursor: 'pointer' }}
                onClick={() => setAiConfigOpen(true)}
              >
                AI已连接（当前会话用户 Key）
              </Tag>
            </Tooltip>
          )}
          {backendStatus === 'ok' && aiStatus === 'environment' && (
            <Tooltip title="浏览器当前没有用户 Key；后端环境变量已配置，断开 AI 不会删除该环境变量">
              <Tag style={{ cursor: 'pointer' }} onClick={() => setAiConfigOpen(true)}>
                AI未连接 · 本地环境已配置
              </Tag>
            </Tooltip>
          )}
          {backendStatus === 'ok' && aiStatus === 'unavailable' && (
            <Tooltip title="点击设置 AI API Key（未配置时 AI 校验将自动降级为普通导入）">
              <Tag style={{ cursor: 'pointer' }} onClick={() => setAiConfigOpen(true)}>
                AI未连接
              </Tag>
            </Tooltip>
          )}
          <Avatar
            size={36}
            style={{ backgroundColor: token.colorPrimary }}
            icon={<UserOutlined />}
          />
        </Space>
      </Header>

      {DEMO_MODE && (
        <Alert
          type="warning"
          showIcon
          message="演示模式：本站展示全部为虚构的演示数据，非真实投放记录；AI 识别与文件导入功能在此模式不可用"
          banner
          style={{ marginTop: HEADER_HEIGHT }}
        />
      )}

      {/* Persistent Sidebar：固定左侧导航，主内容通过 offset 让位（不覆盖、不水平跳动） */}
      <Layout style={{ marginTop: HEADER_HEIGHT + (DEMO_MODE ? 38 : 0) }}>
        <Sider
          theme="dark"
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          width={200}
          collapsedWidth={80}
          trigger={null}
          style={{
            position: 'fixed',
            insetInlineStart: 0,
            top: HEADER_HEIGHT,
            bottom: 0,
            height: `calc(100vh - ${HEADER_HEIGHT}px)`,
            overflow: 'auto',
            zIndex: 15
          }}
        >
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[selectedKey]}
            items={MENU_ITEMS}
            onClick={({ key }) => navigate(MENU_PATHS[key] || '/dashboard')}
            style={{ borderInlineEnd: 'none', paddingBottom: 24 }}
          />
        </Sider>

        {/* 主内容区：路由出口（left offset 跟随 sidebar 收起 / 展开宽度） */}
        <Content
          style={{
            padding: 24,
            background: token.colorBgLayout,
            marginInlineStart: collapsed ? 80 : 200,
            minHeight: `calc(100vh - ${HEADER_HEIGHT}px)`,
            transition: 'margin-inline-start 0.2s'
          }}
        >
          <Outlet />
        </Content>
      </Layout>

      {/* AI 接口配置弹窗 */}
      <AiConfigModal
        open={aiConfigOpen}
        onCancel={() => setAiConfigOpen(false)}
        onSaved={handleAiConfigSaved}
        onDisconnected={handleAiDisconnected}
        onProviderChanged={() => setAiConfig(getAiConfig())}
      />
    </Layout>
  )
}
