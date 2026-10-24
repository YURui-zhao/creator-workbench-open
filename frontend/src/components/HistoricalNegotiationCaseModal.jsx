import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, DatePicker, Divider, Input, Modal, Space, Tag, Typography, message } from 'antd'
import dayjs from 'dayjs'
import { createHistoricalNegotiationCase } from '../api/creatorNegotiationCases'
import { correctNegotiationCaseDate } from '../api/creatorNegotiationCases'
import NegotiationExperienceForm from './NegotiationExperienceForm.jsx'
import { getErrorMessage } from '../utils/request'
import { calcCpm } from '../utils/calc'
import { formatCpm, formatMoney, formatPlays } from '../utils/format'
import { isValidDateOnly, todayLocalDateOnly } from '../utils/recentPerformanceSave.js'
import {
  NEGOTIATION_REASON_TAG_LABELS,
  formatChangePercent,
} from '../utils/negotiationCaseDisplay.js'

const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: 12 }

// 谈价经验（共享领域结构）的空白初值
const EMPTY_EXPERIENCE = { sourceNote: '', reasonTags: [], reasonNote: '', strategyNote: '' }

function readOnlyRows(record) {
  const latest =
    record?.second_week_play === null || record?.second_week_play === undefined || record?.second_week_play === ''
      ? null
      : Number(record.second_week_play)
  const cpm =
    latest !== null && Number.isFinite(latest) && latest > 0 ? calcCpm(record?.total_cost, latest) : null
  return [
    { label: '达人', value: record?.nickname || '-' },
    { label: '发布日期', value: record?.publish_date || '-' },
    { label: '实际合作成本', value: formatMoney(record?.total_cost) },
    { label: '7日播放', value: formatPlays(record?.first_play) },
    { label: '累计播放', value: formatPlays(record?.second_week_play) },
    { label: 'final CPM', value: formatCpm(cpm) }
  ]
}

/**
 * Historical Negotiation Backfill V0.1
 *
 * 把「过去真实发生过、且已有真实 creator_record 的谈价案例」安全回填到 creator_negotiation_cases。
 *   · 只读展示真实投放结果（actual_cost 永远来自 creator_record）
 *   · 谈后价（negotiated_price）与实际成本永久分开，互不覆盖
 *   · source_note 是人工维护的原始备注，AI 只在用户显式点击后把它整理成**建议**，且绝不写库 / 不改 source_note
 *   · append-only：已补录的记录只读展示，V0.1 不提供编辑
 */
export default function HistoricalNegotiationCaseModal({
  open,
  record,
  existingCase = null,
  onClose,
  onSaved
}) {
  const [xingtuRaw, setXingtuRaw] = useState('')
  const [quoteRaw, setQuoteRaw] = useState('')
  const [priceRaw, setPriceRaw] = useState('')
  const [negotiatedAt, setNegotiatedAt] = useState(() => todayLocalDateOnly())
  // 谈价经验（共享领域结构）：source_note / reason_tags / reason_note / strategy_note
  const [experience, setExperience] = useState(() => EMPTY_EXPERIENCE)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const isReadOnly = Boolean(existingCase)
  // Real Data Calibration V1：谈成日期纠正（append-only 审计；只改 negotiated_at）
  const [dateCorrecting, setDateCorrecting] = useState(false)
  const [dateCorrectValue, setDateCorrectValue] = useState('')
  const [dateCorrectReason, setDateCorrectReason] = useState('')
  const [dateCorrectSaving, setDateCorrectSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setXingtuRaw('')
    setQuoteRaw('')
    setPriceRaw('')
    setNegotiatedAt(todayLocalDateOnly())
    setExperience(EMPTY_EXPERIENCE)
    setError('')
  }, [open, record?.id])

  const contextRows = useMemo(() => readOnlyRows(record), [record])
  const canSave = !isReadOnly && priceRaw.trim() !== '' && isValidDateOnly(negotiatedAt) && !saving

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError('')
    try {
      const res = await createHistoricalNegotiationCase({
        record_id: record.id,
        negotiated_price: priceRaw.trim(),
        negotiated_at: negotiatedAt,
        xingtu_price_snapshot: xingtuRaw.trim() || null,
        current_quote_snapshot: quoteRaw.trim() || null,
        source_note: experience.sourceNote.trim() || null,
        reason_tags: experience.reasonTags,
        reason_note: experience.reasonNote ? experience.reasonNote : null,
        strategy_note: experience.strategyNote ? experience.strategyNote : null
      })
      message.success('历史谈价案例已补录')
      onSaved?.(res?.data || null)
      onClose?.()
    } catch (err) {
      setError(getErrorMessage(err, '历史谈价案例保存失败，请稍后重试（输入内容已保留）'))
    } finally {
      setSaving(false)
    }
  }

  // ---------- 只读查看（已补录） ----------
  if (isReadOnly) {
    const outcome = existingCase.outcome || {}
    const canCorrectDate = isValidDateOnly(dateCorrectValue) && dateCorrectReason.trim() !== '' && !dateCorrectSaving
    const handleCorrectDate = async () => {
      if (!canCorrectDate) return
      setDateCorrectSaving(true)
      try {
        const res = await correctNegotiationCaseDate(existingCase.id, {
          negotiatedAt: dateCorrectValue,
          reason: dateCorrectReason.trim()
        })
        message.success('谈价日期已纠正')
        setDateCorrecting(false)
        setDateCorrectReason('')
        onSaved?.(res?.data?.case || null)
        onClose?.()
      } catch {
        // 失败提示由 request 响应拦截器统一弹出一次；这里保留用户输入，仅复位 loading
      } finally {
        setDateCorrectSaving(false)
      }
    }
    return (
      <Modal
        title={`历史谈价案例 · ${existingCase.creator || record?.nickname || ''}`}
        open={open}
        onCancel={onClose}
        footer={<Button onClick={onClose}>关闭</Button>}
        width={600}
      >
        <Space direction="vertical" size={10} style={{ display: 'flex' }}>
          <Alert
            type="info"
            showIcon
            message="该投放记录已补录历史谈价（append-only，只读）"
            description="历史谈价事实在提交时已冻结；实际合作成本仍以本投放记录为准。"
          />
          <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
            <Space direction="vertical" size={4} style={{ display: 'flex' }}>
              {contextRows.map((row) => (
                <div key={row.label} style={rowStyle}>
                  <Typography.Text type="secondary">{row.label}</Typography.Text>
                  <Typography.Text>{row.value}</Typography.Text>
                </div>
              ))}
            </Space>
          </div>
          <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
            <Space direction="vertical" size={4} style={{ display: 'flex' }}>
              <div style={rowStyle}>
                <Typography.Text type="secondary">历史星图刊例</Typography.Text>
                <Typography.Text>{formatMoney(existingCase.xingtu_price_snapshot)}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">历史初始报价</Typography.Text>
                <Typography.Text>{formatMoney(existingCase.current_quote_snapshot)}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">谈后价格</Typography.Text>
                <Typography.Text strong>{formatMoney(existingCase.negotiated_price)}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">星图折扣</Typography.Text>
                <Typography.Text>
                  {outcome.xingtu_discount_zhe === null || outcome.xingtu_discount_zhe === undefined
                    ? '暂无'
                    : `${outcome.xingtu_discount_zhe} 折`}
                </Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">相对初始报价</Typography.Text>
                <Typography.Text>
                  {outcome.quote_drop_computable
                    ? `${outcome.quote_drop_direction === 'increase' ? '上升' : outcome.quote_drop_direction === 'flat' ? '持平' : '下降'} ${formatChangePercent(outcome.quote_change_rate)}`
                    : '暂无'}
                </Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">谈价日期</Typography.Text>
                <Typography.Text>{existingCase.negotiated_at || '-'}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">录入时间</Typography.Text>
                <Typography.Text>{existingCase.created_at || '-'}</Typography.Text>
              </div>
            </Space>
          </div>
          {!dateCorrecting ? (
            <Button size="small" onClick={() => { setDateCorrecting(true); setDateCorrectValue(existingCase.negotiated_at || todayLocalDateOnly()); setDateCorrectReason('') }}>
              纠正谈价日期
            </Button>
          ) : (
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
              <Space direction="vertical" size={8} style={{ display: 'flex' }}>
                <Alert type="info" showIcon message="纠正的是「谈价日期」，不会改动谈后价、星图价与实际合作成本。" />
                <div>
                  <Typography.Text type="secondary">谈价日期</Typography.Text>
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
                    onChange={(event) => setDateCorrectReason(event.target.value)}
                  />
                </div>
                <Space>
                  <Button onClick={() => { setDateCorrecting(false); setDateCorrectReason('') }}>取消</Button>
                  <Button type="primary" disabled={!canCorrectDate} loading={dateCorrectSaving} onClick={handleCorrectDate}>
                    保存纠正
                  </Button>
                </Space>
              </Space>
            </div>
          )}
          {(existingCase.reason_tags || []).length > 0 && (
            <div>
              <Typography.Text type="secondary">谈价原因 / 背景</Typography.Text>
              <div style={{ marginTop: 4 }}>
                <Space wrap size={4}>
                  {existingCase.reason_tags.map((tag) => (
                    <Tag key={tag}>{NEGOTIATION_REASON_TAG_LABELS[tag] || tag}</Tag>
                  ))}
                </Space>
              </div>
            </div>
          )}
          {existingCase.source_note && (
            <div>
              <Typography.Text type="secondary">历史谈价原始备注</Typography.Text>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {existingCase.source_note}
              </Typography.Paragraph>
            </div>
          )}
          {existingCase.reason_note && (
            <div>
              <Typography.Text type="secondary">补充说明</Typography.Text>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {existingCase.reason_note}
              </Typography.Paragraph>
            </div>
          )}
          {existingCase.strategy_note && (
            <div>
              <Typography.Text type="secondary">谈价依据 / 过程</Typography.Text>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {existingCase.strategy_note}
              </Typography.Paragraph>
            </div>
          )}
        </Space>
      </Modal>
    )
  }

  // ---------- 新增补录 ----------
  return (
    <Modal
      title={`补录历史谈价 · ${record?.nickname || ''}`}
      open={open}
      onCancel={onClose}
      destroyOnClose
      width={640}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" disabled={!canSave} loading={saving} onClick={handleSave}>
            保存历史谈价案例
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={10} style={{ display: 'flex' }}>
        <Typography.Text type="secondary">
          仅用于补录「过去真实发生过、且已有真实投放记录」的谈价案例。不会创建决策 / 结果记录，也不改写投放数据。
        </Typography.Text>

        <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            真实投放结果（只读，来自投放记录）
          </Typography.Text>
          <Space direction="vertical" size={4} style={{ display: 'flex', marginTop: 6 }}>
            {contextRows.map((row) => (
              <div key={row.label} style={rowStyle}>
                <Typography.Text type="secondary">{row.label}</Typography.Text>
                <Typography.Text>{row.value}</Typography.Text>
              </div>
            ))}
          </Space>
        </div>

        <div>
          <Typography.Text type="secondary">历史星图刊例（可选）</Typography.Text>
          <Input
            value={xingtuRaw}
            placeholder="例如 ¥3,000 / 3000"
            style={{ width: 220 }}
            onChange={(event) => setXingtuRaw(event.target.value)}
          />
        </div>

        <div>
          <Typography.Text type="secondary">历史初始报价（可选）</Typography.Text>
          <Input
            value={quoteRaw}
            placeholder="例如 ¥5,000 / 5000"
            style={{ width: 220 }}
            onChange={(event) => setQuoteRaw(event.target.value)}
          />
        </div>

        <div>
          <Typography.Text type="secondary">谈后价格（必填）</Typography.Text>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Input
              value={priceRaw}
              placeholder="例如 ¥4,500 / 4500"
              style={{ width: 220 }}
              onChange={(event) => setPriceRaw(event.target.value)}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              与实际合作成本分开记录（不会互相覆盖）
            </Typography.Text>
          </div>
        </div>

        <div>
          <Typography.Text type="secondary">谈价日期（必填）</Typography.Text>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <DatePicker
              value={negotiatedAt ? dayjs(negotiatedAt) : null}
              format="YYYY-MM-DD"
              allowClear={false}
              style={{ width: 180 }}
              onChange={(value) => setNegotiatedAt(value ? value.format('YYYY-MM-DD') : '')}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当时真实谈价 / 确认成交的日期（系统录入时间单独记录）
            </Typography.Text>
          </div>
        </div>

        {/* 谈价经验（共享领域表单：source_note / AI整理 / 原因标签 / 补充说明 / 依据过程） */}
        <NegotiationExperienceForm
          value={experience}
          onChange={setExperience}
          saveLabel="历史谈价案例"
          hint={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              谈价原始备注由人工维护；AI 整理只在点击后调用，结果仅作建议。
            </Typography.Text>
          }
        />

        {error && <Alert type="error" showIcon message={error} />}

        <Divider style={{ margin: '2px 0' }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          只记录真实发生过的谈价事实；实际合作成本仍以投放记录为准（两者不会互相覆盖）。
        </Typography.Text>
      </Space>
    </Modal>
  )
}
