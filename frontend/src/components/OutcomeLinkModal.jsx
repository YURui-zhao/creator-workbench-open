import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Checkbox, Empty, Modal, Radio, Space, Spin, Tag, Typography } from 'antd'
import { getDecisionOutcomeCandidates, linkDecisionOutcome } from '../api/creatorDecisions'
import { formatCpm, formatInteger, formatMoney, formatPlays } from '../utils/format'

const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: 12 }

/**
 * 关联投放结果（V3-alpha P5）
 *
 * 只做一件事：把一条真实的 V2 creator_record 关联回当时的 decision。
 * - 候选由后端给出（同一达人），花费 / 播放 / CPM 全部复用 V2 口径，前端不重新计算
 * - 不自动关联：必须由人显式选择 + 确认
 * - 关联只写 mapping，不修改 decision 证据，也不修改 creator_records
 */
export default function OutcomeLinkModal({ open, decision, onClose, onLinked }) {
  const decisionId = decision?.id ?? null
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [candidates, setCandidates] = useState([])
  const [eligibilityReason, setEligibilityReason] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [timingConfirmed, setTimingConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const loadCandidates = useCallback(async () => {
    if (!decisionId) return
    setLoading(true)
    setError('')
    try {
      const res = await getDecisionOutcomeCandidates(decisionId)
      const list = Array.isArray(res?.data?.candidates) ? res.data.candidates : []
      setCandidates(list)
      setEligibilityReason(res?.data?.eligible === false ? res.data.eligibility_reason || '' : '')
      // 默认不预选：避免用户顺手确认一条错误的记录
      setSelectedId(null)
    } catch (err) {
      setCandidates([])
      setError(err?.response?.data?.msg || '候选投放记录加载失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [decisionId])

  useEffect(() => {
    if (!open) return
    setSelectedId(null)
    setTimingConfirmed(false)
    setSaveError('')
    loadCandidates()
  }, [open, loadCandidates])

  const selected = useMemo(
    () => candidates.find((item) => item.record_id === selectedId) || null,
    [candidates, selectedId]
  )

  const needsTimingConfirm = Boolean(selected?.timing_warning)
  const canLink =
    Boolean(selected) &&
    !selected.already_linked &&
    !saving &&
    (!needsTimingConfirm || timingConfirmed)

  const handleLink = async () => {
    if (!canLink) return
    setSaving(true)
    setSaveError('')
    try {
      const res = await linkDecisionOutcome(decisionId, {
        recordId: selected.record_id,
        timingConfirmed
      })
      onLinked?.(res?.data?.outcome || null)
      onClose?.()
    } catch (err) {
      setSaveError(
        err?.response?.data?.msg || '关联失败，请刷新后重试（未写入任何业务数据）'
      )
    } finally {
      setSaving(false)
    }
  }

  const renderCandidate = (item) => (
    <Radio key={item.record_id} value={item.record_id} disabled={item.already_linked}>
      <Space direction="vertical" size={2} style={{ display: 'flex' }}>
        <Space size={8} wrap>
          <Typography.Text strong>{item.publish_date || '发布日期未知'}</Typography.Text>
          <Typography.Text type="secondary">花费 {formatMoney(item.total_cost, '-')}</Typography.Text>
          {item.already_linked && (
            <Tag color="orange">
              {item.linked_decision_id === decisionId
                ? '已关联本决策'
                : `已关联其他决策 #${item.linked_decision_id}`}
            </Tag>
          )}
        </Space>
        <Typography.Text type="secondary">
          7日播放 {formatPlays(item.first_play)} · 累计播放{' '}
          {item.latest_status === 'pending' ? '待更新' : formatPlays(item.latest_play)} · 累计CPM{' '}
          {item.latest_status === 'pending'
            ? '待更新'
            : item.latest_status === 'anomaly'
              ? '异常'
              : formatCpm(item.latest_cpm)}
        </Typography.Text>
        {item.timing_warning && (
          <Typography.Text type="warning">⚠ 发布日期早于当前决策</Typography.Text>
        )}
      </Space>
    </Radio>
  )

  return (
    <Modal
      title={`关联投放结果 · ${decision?.creator || ''}`}
      open={open}
      onCancel={onClose}
      destroyOnClose
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" disabled={!canLink} loading={saving} onClick={handleLink}>
            确认关联
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={10} style={{ display: 'flex' }}>
        <Typography.Text type="secondary">
          选择该达人真实发生的一次投放记录。只建立关联关系，不会修改决策记录，也不会修改投放数据。
        </Typography.Text>

        {eligibilityReason && <Alert type="warning" showIcon message={eligibilityReason} />}
        {error && <Alert type="error" showIcon message={error} />}

        <Spin spinning={loading}>
          {candidates.length === 0 && !loading ? (
            <Empty description="该达人暂无可关联的投放记录" />
          ) : (
            <Radio.Group
              value={selectedId}
              onChange={(event) => {
                setSelectedId(event.target.value)
                setTimingConfirmed(false)
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              {candidates.map(renderCandidate)}
            </Radio.Group>
          )}
        </Spin>

        {selected && (
          <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
            <Space direction="vertical" size={4} style={{ display: 'flex' }}>
              <div style={rowStyle}>
                <Typography.Text type="secondary">投放记录</Typography.Text>
                <Typography.Text>#{selected.record_id}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">发布日期</Typography.Text>
                <Typography.Text>{selected.publish_date || '-'}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">实际花费</Typography.Text>
                <Typography.Text>{formatMoney(selected.total_cost, '-')}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">7日播放</Typography.Text>
                <Typography.Text>{formatPlays(selected.first_play)}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">累计播放</Typography.Text>
                <Typography.Text>
                  {selected.latest_status === 'pending' ? '待更新' : formatPlays(selected.latest_play)}
                </Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">累计CPM</Typography.Text>
                <Typography.Text>
                  {selected.latest_status === 'pending'
                    ? '待更新'
                    : selected.latest_status === 'anomaly'
                      ? '异常'
                      : formatCpm(selected.latest_cpm)}
                </Typography.Text>
              </div>
            </Space>
          </div>
        )}

        {needsTimingConfirm && (
          <>
            <Alert
              type="warning"
              showIcon
              message="该投放记录的发布日期早于本次决策记录，请确认是否关联正确。"
            />
            <Checkbox
              checked={timingConfirmed}
              onChange={(event) => setTimingConfirmed(event.target.checked)}
            >
              我已确认这条投放记录确实对应本次决策
            </Checkbox>
          </>
        )}

        {saveError && <Alert type="error" showIcon message={saveError} />}
        {selected && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            当前选中记录花费 {formatMoney(selected.total_cost, '-')}，共 {formatInteger(candidates.length)} 条候选
          </Typography.Text>
        )}
      </Space>
    </Modal>
  )
}
