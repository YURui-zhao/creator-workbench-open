import { useEffect, useState } from 'react'
import { Button, Card, Col, Divider, Drawer, Empty, Row, Space, Tag, Typography } from 'antd'
import { formatInteger } from '../utils/format'
import {
  buildContentBlock,
  buildCorePriceRows,
  buildHistoryBlock,
  buildNegotiationReferenceRows,
  buildPriceBlock,
  buildPriceConclusion,
  buildRecentBlock,
  buildRecentDecisionBlock,
  buildWorkspaceHeader,
  computeWorkspaceWidth
} from '../utils/workspaceSummary.js'

/**
 * 达人判断工作区（Alpha.3-05）
 *
 * 定位：Radar 负责扫人，点达人昵称后在这里回答四个问题 ——
 *   1) 以前投得怎么样（历史表现）  2) 现在怎么样（近期表现 / 近期内容表现）
 *   3) 当前价格是否合适（价格 + 价格判断）  4) 下一步怎么做（主操作区）
 *
 * 说明：
 *   · 只展示 Radar API 已下发字段，不新增 API / schema，不重算业务指标
 *   · 「更新近期表现」「记录决策」复用页面已有的助手与决策组件（由父组件回调触发），本组件不复制任何业务逻辑
 *   · 数据来自父组件传入的最新 creatorItem，父组件 onSaved → loadRadar() 后这里会自动刷新
 */
export default function CreatorWorkspaceDrawer({
  open,
  creatorItem,
  onClose,
  onOpenAssistant,
  onOpenDecision
}) {
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth
  )
  // Alpha.3-05A：谈价参考默认收起（纯组件内状态：不写库 / 不写存储 / 不调 API）
  const [showNegotiationReference, setShowNegotiationReference] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const handleResize = () => setViewportWidth(window.innerWidth)
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const header = buildWorkspaceHeader(creatorItem || {})
  const history = buildHistoryBlock(creatorItem || {})
  const recent = buildRecentBlock(creatorItem || {})
  const content = buildContentBlock(creatorItem || {})
  const price = buildPriceBlock(creatorItem || {})
  const decision = buildRecentDecisionBlock(creatorItem || {})
  const snapshot = creatorItem?.recent_snapshot || null
  const negotiationRows = buildNegotiationReferenceRows(snapshot?.pricing)
  const conclusion = buildPriceConclusion(snapshot?.pricing)

  const renderRows = (rows) => (
    <Space direction="vertical" size={4} style={{ display: 'flex' }}>
      {rows.map((item) => (
        <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <Typography.Text type="secondary">{item.label}</Typography.Text>
          <Typography.Text>{item.value}</Typography.Text>
        </div>
      ))}
    </Space>
  )

  const block = (title, rows, { empty = false } = {}) => (
    <Card size="small" title={title} style={{ height: '100%' }}>
      {empty ? <Typography.Text type="secondary">{rows[0]?.value}</Typography.Text> : renderRows(rows)}
    </Card>
  )

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={computeWorkspaceWidth(viewportWidth)}
      destroyOnClose={false}
      styles={{ body: { paddingTop: 12 } }}
      title={
        <Space size={8} wrap align="center">
          <Typography.Text strong style={{ fontSize: 16 }}>
            {header.creator || '达人判断工作区'}
          </Typography.Text>
          <Typography.Text type="secondary">{header.creator_type}</Typography.Text>
          {header.statusLabel && (
            <Tag color={header.statusValue === 'passed' ? 'success' : header.statusValue === 'failed' ? 'error' : 'default'}>
              {header.statusLabel}
            </Tag>
          )}
          {header.workPriorityLabel && <Tag color="gold">{header.workPriorityLabel}</Tag>}
        </Space>
      }
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <Space size={8} wrap>
            {/* Phase 5：把归属锚 creator_id 一并传出，快照读写按身份关联（同名不同人不串数据） */}
            <Button
              onClick={() => onOpenAssistant?.(header.creator, 'update', creatorItem?.creator_id ?? null)}
            >
              更新近期表现
            </Button>
            <Button type="primary" onClick={() => onOpenDecision?.(creatorItem, 'record')}>
              记录决策
            </Button>
            <Button type="link" onClick={() => onOpenDecision?.(creatorItem, 'history')}>
              查看决策记录
            </Button>
          </Space>
          <Button onClick={onClose}>关闭</Button>
        </div>
      }
    >
      {/* 区域 A：核心判断摘要（历史 / 近期 / 近期内容 / 价格） */}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={6}>
          {block('历史表现', history)}
        </Col>
        <Col xs={24} lg={6}>
          {block('近期表现', recent.rows, { empty: recent.empty })}
        </Col>
        <Col xs={24} lg={6}>
          {block('近期内容表现', content.rows, { empty: content.empty })}
        </Col>
        <Col xs={24} lg={6}>
          {block('价格', price)}
        </Col>
      </Row>

      <Divider style={{ margin: '16px 0 12px' }} />

      {/* 区域 B：价格判断（复用既有 pricing 结果，不重算） */}
      <Card size="small" title="价格判断">
        {snapshot ? (
          <Row gutter={[24, 12]}>
            <Col xs={24} lg={12}>
              {/* 左：只平铺核心价格事实；结论型文案不在这里重复出现 */}
              <Space direction="vertical" size={6} style={{ display: 'flex' }}>
                <Typography.Text type="secondary">价格基准</Typography.Text>
                {renderRows(buildCorePriceRows(snapshot.pricing))}
              </Space>
              {negotiationRows.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <a
                    style={{ fontSize: 12 }}
                    onClick={() => setShowNegotiationReference((value) => !value)}
                  >
                    {showNegotiationReference ? '收起谈价参考' : '展开谈价参考'}
                  </a>
                  {showNegotiationReference && (
                    <div style={{ marginTop: 6 }}>{renderRows(negotiationRows)}</div>
                  )}
                </div>
              )}
            </Col>
            <Col xs={24} lg={12}>
              {/* 右：只保留一个价格结论（来自后端 pricing_status_label，前端不重算） */}
              <Space direction="vertical" size={6} style={{ display: 'flex' }}>
                <Typography.Text type="secondary">价格结论</Typography.Text>
                <Typography.Text strong>{conclusion.text}</Typography.Text>
              </Space>
            </Col>
          </Row>
        ) : (
          <Typography.Text type="secondary">暂无近期表现，先更新近期表现后再做价格判断</Typography.Text>
        )}
      </Card>

      <Divider style={{ margin: '16px 0 12px' }} />

      {/* 区域 C：最近决策 */}
      <Card size="small" title="最近决策">
        {decision.empty ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={decision.emptyText} />
        ) : (
          renderRows(decision.rows)
        )}
      </Card>
    </Drawer>
  )
}
