import { useState } from 'react'
import { Alert, Button, Checkbox, Input, Space, Tag, Typography, message } from 'antd'
import { harvestNegotiationExperience } from '../api/ai'
import { getErrorMessage } from '../utils/request'
import {
  NEGOTIATION_REASON_TAG_LABELS,
  getNegotiationReasonTagsForMode
} from '../utils/negotiationCaseDisplay.js'

export const MAX_SOURCE_NOTE_LENGTH = 2000

// AI 实际发送来源 -> UI 文案（只显示真实存在的来源）
export const AI_SOURCE_LABELS = {
  source_note: '本次谈价说明',
  candidate_description: '达人观察',
  // distilled 是 AI 派生内容，不能标成人工备注
  distilled_description: '达人资料AI整理',
  decision_note: '决策备注'
}

/**
 * 谈价经验共享表单（Negotiation Unification V0.2）
 *
 * 同一个「谈价经验」领域结构，两种入口共用：
 *   1. 原始谈价说明（source_note）
 *   2. 谈价原因 / 背景（reason_tags）
 *   3. 补充说明（reason_note）
 *   4. 谈价依据 / 过程（strategy_note）
 *   5. AI 整理（建议 → 应用到表单；绝不落库、绝不改 source_note、绝不生成价格字段）
 *
 * Historical Backfill 与 Creator Playbook 的 live 记录共用本组件（不复制第二套 JSX）。
 * 价格字段（星图刊例 / 谈前报价 / 谈后价格 / 谈价日期）不属于本组件：
 * 它们必须由人明确填写 / 确认，AI 永远不参与。
 */
export default function NegotiationExperienceForm({
  value = {},
  onChange,
  // AI 最小上下文：仅真实存在的值才会发送（candidateDescription / distilledDescription / decisionNote）
  aiContext = {},
  // 只读展示「系统已有信息」（context ≠ fact，不会自动写入正式字段）
  contextRows = [],
  // 保存按钮所在页面的对象名，用于提示文案（例如「历史谈价案例」/「谈价案例」）
  saveLabel = '谈价案例',
  // legacy：12 个标签；candidate_playbook：隐藏 history_performance_plain（11 个）
  mode = 'legacy',
  // 表单顶部说明
  hint = null,
  disabled = false
}) {
  const sourceNote = value.sourceNote ?? ''
  const reasonTags = value.reasonTags ?? []
  const reasonNote = value.reasonNote ?? ''
  const strategyNote = value.strategyNote ?? ''

  const [aiLoading, setAiLoading] = useState(false)
  const [aiSuggestion, setAiSuggestion] = useState(null)
  const [aiError, setAiError] = useState('')

  const patch = (next) => onChange?.({ sourceNote, reasonTags, reasonNote, strategyNote, ...next })

  /** 只把建议写进当前表单；不调用任何写入接口、不改 source_note */
  const applySuggestion = () => {
    if (!aiSuggestion) return
    patch({
      reasonTags: aiSuggestion.reason_tags || [],
      reasonNote: aiSuggestion.reason_note || '',
      strategyNote: aiSuggestion.strategy_note || ''
    })
    setAiSuggestion(null)
    // AI 建议只是写入当前表单（尚未持久化）；谈价案例仍需用户显式保存
    message.success(`已应用到表单，保存${saveLabel}后才会写入系统。`)
  }

  const handleHarvest = async () => {
    // Context Reuse V0.2：人工来源任一存在即可（不强制重复填写谈价原始备注）
    const hasHumanSource = Boolean(
      sourceNote.trim() ||
        String(aiContext.candidateDescription || '').trim() ||
        String(aiContext.decisionNote || '').trim()
    )
    if (!hasHumanSource) {
      setAiError('没有可整理的人工内容：谈价原始说明 / 达人观察 / 决策备注至少存在一项')
      return
    }
    setAiLoading(true)
    setAiError('')
    try {
      const res = await harvestNegotiationExperience({
        source_note: sourceNote.trim(),
        candidate_description: aiContext.candidateDescription || undefined,
        distilled_description: aiContext.distilledDescription || undefined,
        decision_note: aiContext.decisionNote || undefined
      })
      setAiSuggestion(res?.data || null)
    } catch (err) {
      setAiError(getErrorMessage(err, 'AI 整理失败，可继续人工填写并保存'))
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <Space direction="vertical" size={10} style={{ display: 'flex' }}>
      {hint}

      {contextRows.length > 0 && (
        <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            系统已有信息（只读参考；不会自动写入谈价案例）
          </Typography.Text>
          <Space direction="vertical" size={4} style={{ display: 'flex', marginTop: 6 }}>
            {contextRows.map((row) => (
              <div
                key={row.label}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}
              >
                <Typography.Text type="secondary">{row.label}</Typography.Text>
                <Typography.Text style={{ textAlign: 'right', whiteSpace: 'pre-wrap' }}>
                  {row.value}
                </Typography.Text>
              </div>
            ))}
          </Space>
        </div>
      )}

      <div>
        <Typography.Text type="secondary">谈价原始说明</Typography.Text>
        <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          可粘贴当时聊天摘要、人工记录或有证据的回忆。
        </Typography.Text>
        <Input.TextArea
          value={sourceNote}
          rows={4}
          maxLength={MAX_SOURCE_NOTE_LENGTH}
          showCount
          disabled={disabled}
          placeholder="可粘贴当时的聊天摘要 / 备注 / 有证据的回忆，例如：达人最开始报价5000，我先没有急着回复，后面以预算有限+后续合作预期继续谈，最后口头确认4500。"
          onChange={(event) => patch({ sourceNote: event.target.value })}
        />
        <div style={{ marginTop: 6 }}>
          <Button size="small" loading={aiLoading} disabled={disabled} onClick={handleHarvest}>
            AI整理谈价经验
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            可选；只发送这段备注与真实存在的达人 / 决策备注，结果仅作建议，需你确认后才填入
          </Typography.Text>
        </div>
        {aiError && <Alert type="warning" showIcon style={{ marginTop: 6 }} message={aiError} />}
        {aiSuggestion && (
          <div style={{ marginTop: 8, border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              AI整理建议（尚未保存）
            </Typography.Text>
            {(aiSuggestion.sources || []).length > 0 && (
              <div style={{ marginTop: 4 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  参考来源：
                </Typography.Text>
                <Space size={4} wrap>
                  {aiSuggestion.sources.map((key) => (
                    <Tag key={key} style={{ marginInlineEnd: 0 }}>
                      {AI_SOURCE_LABELS[key] || key}
                    </Tag>
                  ))}
                </Space>
              </div>
            )}
            <Space direction="vertical" size={4} style={{ display: 'flex', marginTop: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <Typography.Text type="secondary">建议原因标签</Typography.Text>
                <Typography.Text>
                  {(aiSuggestion.reason_tags || []).length
                    ? aiSuggestion.reason_tags
                        .map((tag) => NEGOTIATION_REASON_TAG_LABELS[tag] || tag)
                        .join('、')
                    : '无'}
                </Typography.Text>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <Typography.Text type="secondary">建议补充说明</Typography.Text>
                <Typography.Text>{aiSuggestion.reason_note || '无'}</Typography.Text>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <Typography.Text type="secondary">建议谈价依据 / 过程</Typography.Text>
                <Typography.Text>{aiSuggestion.strategy_note || '无'}</Typography.Text>
              </div>
            </Space>
            <Space style={{ marginTop: 8 }}>
              <Button size="small" type="primary" onClick={applySuggestion}>
                应用到表单
              </Button>
              <Button size="small" onClick={() => setAiSuggestion(null)}>
                放弃
              </Button>
            </Space>
            <Typography.Text
              type="secondary"
              style={{ display: 'block', fontSize: 12, marginTop: 8 }}
            >
              应用到表单不会写入系统；保存{saveLabel}后才会持久化。
            </Typography.Text>
          </div>
        )}
      </div>

      <div>
        <Typography.Text type="secondary">谈价原因 / 背景（可选，可多选）</Typography.Text>
        <div style={{ marginTop: 6 }}>
          <Checkbox.Group
            value={reasonTags}
            disabled={disabled}
            onChange={(values) => patch({ reasonTags: values })}
          >
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
          disabled={disabled}
          onChange={(event) => patch({ reasonNote: event.target.value })}
        />
      </div>

      <div>
        <Typography.Text type="secondary">谈价依据 / 过程（可选）</Typography.Text>
        <Input.TextArea
          value={strategyNote}
          rows={2}
          maxLength={500}
          disabled={disabled}
          onChange={(event) => patch({ strategyNote: event.target.value })}
        />
      </div>
    </Space>
  )
}
