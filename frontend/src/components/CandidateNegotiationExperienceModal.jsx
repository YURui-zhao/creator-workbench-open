import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, DatePicker, Divider, Input, Modal, Space, Tag, Typography, message } from 'antd'
import dayjs from 'dayjs'
import { createNegotiationCase } from '../api/creatorNegotiationCases'
import NegotiationExperienceForm from './NegotiationExperienceForm.jsx'
import { getErrorMessage } from '../utils/request'
import { formatPrice } from '../utils/pricingDisplay.js'
import { isValidDateOnly, todayLocalDateOnly } from '../utils/recentPerformanceSave.js'
import {
  NEGOTIATION_REASON_TAG_LABELS,
  formatChangePercent
} from '../utils/negotiationCaseDisplay.js'

const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: 12 }
const EMPTY_EXPERIENCE = { sourceNote: '', reasonTags: [], reasonNote: '', strategyNote: '' }

/**
 * 候选达人「已发生谈价」记录（Negotiation Unification V0.2）
 *
 * 与 Historical Backfill 共用同一个谈价经验表单（NegotiationExperienceForm）与同一张
 * creator_negotiation_cases 表，但锚点不同：
 *   · live：decision_id（真实存在的报价阶段决策），source_type = live，record_id = NULL
 *   · 绝不伪造 decision / quote：没有真实 post_quote 决策时，入口只提示补充报价阶段事实
 *
 * 价格事实边界：
 *   · 谈前报价 / 星图刊例来自该决策与当时快照，保存时由后端冻结（前端不能伪造）
 *   · 谈后价格与谈价日期必须由人明确填写
 *   · AI 永远不产生任何价格字段
 */
export default function CandidateNegotiationExperienceModal({
  open,
  candidate = null,
  decision = null,
  postQuoteDecision = null,
  existingCase = null,
  xingtuPrice = null,
  onClose,
  onSaved
}) {
  const [priceRaw, setPriceRaw] = useState('')
  // 「记录已发生谈价」（proceed / small_test / pause）必须由人明确填写谈前报价
  const [preQuoteRaw, setPreQuoteRaw] = useState('')
  const [negotiatedAt, setNegotiatedAt] = useState(() => todayLocalDateOnly())
  const [experience, setExperience] = useState(EMPTY_EXPERIENCE)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const isReadOnly = Boolean(existingCase)
  const creatorName = candidate?.name || decision?.creator || ''

  useEffect(() => {
    if (!open) return
    setPriceRaw('')
    setPreQuoteRaw('')
    setNegotiatedAt(todayLocalDateOnly())
    setExperience(EMPTY_EXPERIENCE)
    setError('')
  }, [open, decision?.id, existingCase?.id])

  // 决策备注与候选备注只作为 AI 最小上下文 / 只读参考，不会自动写入正式字段
  const candidateDescription = candidate?.description || ''
  const distilledDescription = candidate?.distilled_description || ''
  const decisionNote = postQuoteDecision?.decision_note || ''

  const contextRows = useMemo(() => {
    const rows = []
    if (candidate?.description) rows.push({ label: '达人观察（资料画像）', value: candidate.description })
    if (distilledDescription) rows.push({ label: '达人资料 AI 整理', value: distilledDescription })
    if (postQuoteDecision?.human_decision_label || postQuoteDecision?.human_decision) {
      rows.push({
        label: '当前决策',
        value: `${postQuoteDecision.human_decision_label || postQuoteDecision.human_decision}（${
          String(postQuoteDecision.created_at || '').slice(0, 16)
        }）`
      })
    }
    if (decisionNote) rows.push({ label: '决策备注', value: decisionNote })
    // 价格事实：只读参考（保存时由后端按该决策 / 快照冻结）
    if (postQuoteDecision?.current_quote !== null && postQuoteDecision?.current_quote !== undefined) {
      rows.push({ label: '系统当前报价', value: formatPrice(postQuoteDecision.current_quote) })
    }
    if (xingtuPrice !== null && xingtuPrice !== undefined) {
      rows.push({ label: '系统已有星图价', value: formatPrice(xingtuPrice) })
    }
    return rows
  }, [candidate, distilledDescription, postQuoteDecision, decisionNote, xingtuPrice])

  const isPause = postQuoteDecision?.human_decision === 'pause'
  // 原生 negotiate flow：decision.current_quote 就是谈前报价，服务端冻结，用户无需重复输入
  // retrofit flow（proceed / small_test / pause）：谈价在系统外完成，谈前报价必须由人明确填写
  const isRetrofitCapture =
    Boolean(postQuoteDecision) && postQuoteDecision.human_decision !== 'negotiate'
  const canSave =
    !isReadOnly &&
    Boolean(decision?.id) &&
    priceRaw.trim() !== '' &&
    isValidDateOnly(negotiatedAt) &&
    (!isRetrofitCapture || preQuoteRaw.trim() !== '') &&
    !saving

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError('')
    try {
      // live：只用真实 decision_id；谈前报价 / 星图刊例由后端按当时证据冻结
      const res = await createNegotiationCase({
        decision_id: decision.id,
        negotiated_price: priceRaw.trim(),
        negotiated_at: negotiatedAt,
        // retrofit：谈前报价由人确认；negotiate：不提交（后端按该决策冻结）
        ...(isRetrofitCapture ? { current_quote_snapshot: preQuoteRaw.trim() } : {}),
        source_note: experience.sourceNote.trim() || null,
        reason_tags: experience.reasonTags,
        reason_note: experience.reasonNote ? experience.reasonNote : null,
        strategy_note: experience.strategyNote ? experience.strategyNote : null
      })
      message.success('谈价案例已记录')
      onSaved?.(res?.data || null)
      onClose?.()
    } catch (err) {
      setError(getErrorMessage(err, '谈价案例保存失败，请稍后重试（输入内容已保留）'))
    } finally {
      setSaving(false)
    }
  }

  // ---------- 只读查看（已有 case） ----------
  if (isReadOnly) {
    const outcome = existingCase.outcome || {}
    return (
      <Modal
        title={`本次谈价记录 · ${existingCase.creator || creatorName}`}
        open={open}
        onCancel={onClose}
        footer={<Button onClick={onClose}>关闭</Button>}
        width={600}
      >
        <Space direction="vertical" size={10} style={{ display: 'flex' }}>
          <Alert
            type="info"
            showIcon
            message="该谈价案例已保存。V0.2 暂不直接覆盖历史记录。"
            description={
              existingCase.source_type === 'historical_backfill'
                ? '来源：历史补录（该次真实投放已补录谈价事实，因此不再重复记录实时谈价）。谈价事实在提交时已冻结（append-only）；如需更正，请在后续版本使用专门的修订机制。'
                : '来源：实时谈价（live）。谈价事实在提交时已冻结（append-only）；如需更正，请在后续版本使用专门的修订机制。'
            }
          />
          {existingCase.source_type === 'historical_backfill' && (
            <Typography.Text type="secondary">来源：历史补录</Typography.Text>
          )}
          <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
            <Space direction="vertical" size={4} style={{ display: 'flex' }}>
              <div style={rowStyle}>
                <Typography.Text type="secondary">谈前报价</Typography.Text>
                <Typography.Text>{formatPrice(existingCase.current_quote_snapshot) ?? '暂无'}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">谈后价格</Typography.Text>
                <Typography.Text strong>{formatPrice(existingCase.negotiated_price) ?? '-'}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">星图刊例</Typography.Text>
                <Typography.Text>
                  {existingCase.xingtu_price_snapshot === null ||
                  existingCase.xingtu_price_snapshot === undefined
                    ? '暂无'
                    : formatPrice(existingCase.xingtu_price_snapshot)}
                </Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">相对谈前报价</Typography.Text>
                <Typography.Text>
                  {outcome.quote_drop_computable
                    ? `${
                        outcome.quote_drop_direction === 'increase'
                          ? '上升'
                          : outcome.quote_drop_direction === 'flat'
                            ? '无变化'
                            : '下降'
                      } ${formatChangePercent(outcome.quote_change_rate)}`
                    : '无法计算（谈前报价为 0 / 暂无）'}
                </Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">谈价日期</Typography.Text>
                <Typography.Text>{existingCase.negotiated_at || '-'}</Typography.Text>
              </div>
            </Space>
          </div>
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
          {existingCase.source_note && (
            <div>
              <Typography.Text type="secondary">谈价原始说明</Typography.Text>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {existingCase.source_note}
              </Typography.Paragraph>
            </div>
          )}
        </Space>
      </Modal>
    )
  }

  // ---------- 没有真实报价阶段决策：不伪造 decision / quote ----------
  if (!decision?.id) {
    return (
      <Modal
        title={`本次谈价记录 · ${creatorName}`}
        open={open}
        onCancel={onClose}
        footer={<Button onClick={onClose}>关闭</Button>}
        width={520}
      >
        <Space direction="vertical" size={10} style={{ display: 'flex' }}>
          <Alert
            type="info"
            showIcon
            message="当前没有报价阶段记录"
            description="如确实已发生谈价，请先补充当前报价 / 报价阶段事实，再记录谈价案例（系统不会伪造报价阶段决策）。"
          />
          {contextRows.length > 0 && (
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                系统已有信息
              </Typography.Text>
              <Space direction="vertical" size={4} style={{ display: 'flex', marginTop: 6 }}>
                {contextRows.map((row) => (
                  <div key={row.label} style={rowStyle}>
                    <Typography.Text type="secondary">{row.label}</Typography.Text>
                    <Typography.Text style={{ textAlign: 'right', whiteSpace: 'pre-wrap' }}>
                      {row.value}
                    </Typography.Text>
                  </div>
                ))}
              </Space>
            </div>
          )}
        </Space>
      </Modal>
    )
  }

  // ---------- 记录已发生谈价 ----------
  return (
    <Modal
      title={`记录本次谈价 · ${creatorName}`}
      open={open}
      onCancel={onClose}
      destroyOnClose
      width={640}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" disabled={!canSave} loading={saving} onClick={handleSave}>
            保存本次谈价记录
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={10} style={{ display: 'flex' }}>
        {isPause && (
          <Alert
            type="warning"
            showIcon
            message="该达人当前决策为暂不推进"
            description="记录的是已发生的谈价事实，不代表继续推进。"
          />
        )}

        {/* 谈前报价：negotiate 由后端按该决策冻结；proceed/small_test/pause 必须人工确认 */}
        {isRetrofitCapture ? (
          <div>
            <Typography.Text type="secondary">谈前报价（必填）</Typography.Text>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Input
                value={preQuoteRaw}
                placeholder="例如 ¥5,000 / 5000"
                style={{ width: 220 }}
                onChange={(event) => setPreQuoteRaw(event.target.value)}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                系统当前报价可能已经是谈价后的报价，请按真实谈价过程确认谈前价格。
              </Typography.Text>
            </div>
          </div>
        ) : (
          postQuoteDecision?.current_quote !== null &&
          postQuoteDecision?.current_quote !== undefined && (
            <div style={rowStyle}>
              <Typography.Text type="secondary">谈前报价（来自该决策，保存时冻结）</Typography.Text>
              <Typography.Text>{formatPrice(postQuoteDecision.current_quote)}</Typography.Text>
            </div>
          )
        )}

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
              当时真实谈价 / 确认成交的日期
            </Typography.Text>
          </div>
        </div>

        <Divider style={{ margin: '2px 0' }} />

        <NegotiationExperienceForm
          value={experience}
          onChange={setExperience}
          mode="candidate_playbook"
          saveLabel="谈价案例"
          aiContext={{
            candidateDescription,
            distilledDescription,
            decisionNote
          }}
          contextRows={contextRows}
          hint={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {isRetrofitCapture
                ? '谈前报价 / 谈后价格 / 谈价日期均按真实谈价过程人工填写；星图刊例（若有）由后端按当时快照冻结。'
                : '谈前报价与星图刊例来自该决策与当时快照，保存时由后端冻结；谈后价格与谈价日期必须由你填写。'}
            </Typography.Text>
          }
        />

        {error && <Alert type="error" showIcon message={error} />}
      </Space>
    </Modal>
  )
}
