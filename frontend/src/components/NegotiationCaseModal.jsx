import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Divider,
  Input,
  Modal,
  Space,
  Typography,
  message
} from 'antd'
import dayjs from 'dayjs'
import { createNegotiationCase } from '../api/creatorNegotiationCases'
import { getErrorMessage } from '../utils/request'
import { isValidDateOnly, todayLocalDateOnly } from '../utils/recentPerformanceSave.js'
import {
  buildCandidateNegotiationContextRows,
  buildNegotiationContextRows,
  getNegotiationReasonTagsForMode
} from '../utils/negotiationCaseDisplay.js'

const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: 12 }

/**
 * 记录谈价结果（V3-alpha.2 A4）
 *
 * 只提交「人的输入」：最终谈成价、谈成日期、原因标签、备注。
 * 星图价 / 达人报价 / CPM30 目标价 / 参考区间由后端在创建时重新读取并冻结，
 * 前端提交的同名字段会被忽略。
 */
export default function NegotiationCaseModal({ open, decision, onClose, onSaved, mode = 'legacy' }) {
  // Phase 4F-B：candidate_playbook 模式只展示 Playbook 体系事实，不展示旧 CPM30 目标价 / 参考区间
  const isCandidateMode = mode === 'candidate_playbook'
  const [priceRaw, setPriceRaw] = useState('')
  const [negotiatedAt, setNegotiatedAt] = useState(() => todayLocalDateOnly())
  const [reasonTags, setReasonTags] = useState([])
  const [reasonNote, setReasonNote] = useState('')
  const [strategyNote, setStrategyNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setPriceRaw('')
    setNegotiatedAt(todayLocalDateOnly())
    setReasonTags([])
    setReasonNote('')
    setStrategyNote('')
    setError('')
  }, [open, decision?.id])

  // 只读上下文：来自 decision 创建时固化的证据（与后端冻结的值一致）
  const context = useMemo(() => {
    const recent = decision?.recent_evidence || null
    const pricing = decision?.pricing_evidence?.xingtu_pricing || null
    return {
      xingtuPrice: recent?.xingtu_price ?? null,
      currentQuote: decision?.current_quote ?? null,
      targetPrice: pricing?.target_price ?? null,
      referenceLow: pricing?.reference_low ?? null,
      referenceHigh: pricing?.reference_high ?? null
    }
  }, [decision])

  const contextRows = useMemo(() => buildNegotiationContextRows(context), [context])
  const candidateContextRows = useMemo(
    () => buildCandidateNegotiationContextRows(decision),
    [decision]
  )
  const visibleContextRows = isCandidateMode ? candidateContextRows : contextRows
  const canSave = Boolean(decision?.id) && priceRaw.trim() !== '' && isValidDateOnly(negotiatedAt) && !saving

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError('')
    try {
      const res = await createNegotiationCase({
        decision_id: decision.id,
        negotiated_price: priceRaw.trim(),
        negotiated_at: negotiatedAt,
        reason_tags: reasonTags,
        reason_note: reasonNote ? reasonNote : null,
        strategy_note: strategyNote ? strategyNote : null
      })
      message.success('谈价结果已记录')
      onSaved?.(res?.data || null)
      onClose?.()
    } catch (err) {
      setError(getErrorMessage(err, '谈价结果保存失败，请稍后重试（输入内容已保留）'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`记录谈价结果 · ${decision?.creator || ''}`}
      open={open}
      onCancel={onClose}
      destroyOnClose
      width={560}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" disabled={!canSave} loading={saving} onClick={handleSave}>
            保存谈价结果
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={10} style={{ display: 'flex' }}>
        <Typography.Text type="secondary">
          {isCandidateMode
            ? '记录真实谈价结果。星图刊例价 / 当前报价按当时证据冻结，无需填写；此处不涉及 CPM30 体系。'
            : '记录真实谈价结果。星图价 / 达人报价 / 目标价 / 参考区间由系统按当时证据冻结，无需填写。'}
        </Typography.Text>

        <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
          <Space direction="vertical" size={4} style={{ display: 'flex' }}>
            {visibleContextRows.map((row) => (
              <div key={row.label} style={rowStyle}>
                <Typography.Text type="secondary">{row.label}</Typography.Text>
                <Typography.Text>{row.value}</Typography.Text>
              </div>
            ))}
          </Space>
        </div>

        <div>
          <Typography.Text type="secondary">最终谈成价</Typography.Text>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Input
              value={priceRaw}
              placeholder="例如 ¥2,200 / 2200元 / 2,200"
              style={{ width: 220 }}
              onChange={(event) => setPriceRaw(event.target.value)}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已谈成的最终价格（与星图刊例价、实际投放花费分开记录）
            </Typography.Text>
          </div>
        </div>

        <div>
          <Typography.Text type="secondary">谈成日期</Typography.Text>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <DatePicker
              value={negotiatedAt ? dayjs(negotiatedAt) : null}
              format="YYYY-MM-DD"
              allowClear={false}
              style={{ width: 180 }}
              onChange={(value) => setNegotiatedAt(value ? value.format('YYYY-MM-DD') : '')}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              谈成 / 确认成交的日期（默认今天）
            </Typography.Text>
          </div>
        </div>

        <div>
          <Typography.Text type="secondary">
            {isCandidateMode ? '谈价原因 / 背景（可多选，可留空）' : '为什么能谈下来（可多选，可留空）'}
          </Typography.Text>
          <div style={{ marginTop: 6 }}>
            <Checkbox.Group value={reasonTags} onChange={(values) => setReasonTags(values)}>
              <Space direction="vertical" size={4}>
                {getNegotiationReasonTagsForMode(mode).map((tag) => (
                  <Checkbox key={tag.value} value={tag.value}>
                    {tag.label}
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </div>
        </div>

        <div>
          <Typography.Text type="secondary">补充说明（可选）</Typography.Text>
          <Input.TextArea
            value={reasonNote}
            rows={2}
            maxLength={500}
            placeholder="例如：对方原报价3000，结合历史CPM和预算，最终接受2200。"
            onChange={(event) => setReasonNote(event.target.value)}
          />
        </div>

        <div>
          <Typography.Text type="secondary">谈价依据 / 过程备注（可选）</Typography.Text>
          <Input.TextArea
            value={strategyNote}
            rows={2}
            maxLength={500}
            placeholder={
              isCandidateMode
                ? '例如：用历史同量级案例与 Playbook 经验估价作为依据，并强调后续复投机会。'
                : '例如：用历史CPM和CPM30目标价作为依据，并强调后续复投机会。'
            }
            onChange={(event) => setStrategyNote(event.target.value)}
          />
        </div>

        {error && <Alert type="error" showIcon message={error} />}

        <Divider style={{ margin: '2px 0' }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {isCandidateMode
            ? '谈价结果只做事实记录，不代表系统决策；实际投放花费仍以投放记录为准。'
            : '谈价结果只做事实记录，不参与 P1 历史判断与 P3 价格规则；实际投放花费仍以投放记录为准。'}
        </Typography.Text>
      </Space>
    </Modal>
  )
}
