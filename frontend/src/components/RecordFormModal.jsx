import { useEffect, useState } from 'react'
import {
  Col,
  Collapse,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Typography,
  message
} from 'antd'
import dayjs from 'dayjs'
import { createRecord, getRecordEditHistory, updateRecord } from '../api/records'
import { alignDateToWeek, weekCodeToDateRange } from '@/utils/dateCycle.js'
import { buildRecordEditRows } from '@/utils/recordEditDisplay.js'

/**
 * 新增/编辑投放记录弹窗
 * ★ 时间周期字段：DatePicker.RangePicker 日期范围选择器（彻底替换原 Select）
 *  - 日历选日期，选完自动对齐完整自然周（周一~周日）
 *  - 输入框显示 MM/DD ~ MM/DD（如 08/05 ~ 08/11）
 *  - 表单提交/回显均为 weekCode（如 2026-W32），接口与数据库存储不变
 */
export default function RecordFormModal({ open, editingRecord, onCancel, onSuccess }) {
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  // Record Edit History V1：只读编辑历史（仅编辑已有记录时加载；失败只在本区域内提示）
  const [editHistory, setEditHistory] = useState({ loading: false, error: '', edits: [] })
  const isEditingRecord = Boolean(editingRecord?.id)

  // 编辑回显：weekCode -> 该周起止日期，赋值给日期选择器
  useEffect(() => {
    if (!open) return
    if (editingRecord) {
      const range = editingRecord.time_cycle
        ? weekCodeToDateRange(editingRecord.time_cycle)
        : null
      form.setFieldsValue({
        ...editingRecord,
        time_cycle: range ? [dayjs(range.startDate), dayjs(range.endDate)] : undefined,
        publish_date: editingRecord.publish_date
          ? dayjs(editingRecord.publish_date)
          : undefined
      })
    } else {
      form.resetFields()
    }
  }, [open, editingRecord, form])

  useEffect(() => {
    if (!open || !isEditingRecord) {
      setEditHistory({ loading: false, error: '', edits: [] })
      return
    }
    let cancelled = false
    setEditHistory({ loading: true, error: '', edits: [] })
    getRecordEditHistory(editingRecord.id)
      .then((res) => {
        if (cancelled) return
        setEditHistory({ loading: false, error: '', edits: res?.data?.edits || [] })
      })
      .catch((error) => {
        if (cancelled) return
        setEditHistory({
          loading: false,
          error: error?.response?.data?.msg || '编辑历史加载失败',
          edits: []
        })
      })
    return () => {
      cancelled = true
    }
  }, [open, isEditingRecord, editingRecord?.id])

  // 选完日期自动对齐完整自然周：先 alignDateToWeek，若跨周则收拢为起始日所在周
  const handleCycleChange = (dates) => {
    if (!dates || dates.length !== 2 || !dates[0] || !dates[1]) return
    const aligned = alignDateToWeek(
      dates[0].format('YYYY-MM-DD'),
      dates[1].format('YYYY-MM-DD')
    )
    if (!aligned) return
    // 超过 7 天说明用户跨周选择，统一收拢为起始日所在完整周（禁止跨周、不完整周）
    const dayDiff = dayjs(aligned.endDate).diff(dayjs(aligned.startDate), 'day')
    const finalRange =
      dayDiff > 6 && aligned.weekCode ? weekCodeToDateRange(aligned.weekCode) : aligned
    if (finalRange) {
      form.setFieldValue('time_cycle', [dayjs(finalRange.startDate), dayjs(finalRange.endDate)])
    }
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      // 表单值分离：日期范围 -> 提交 weekCode
      const range = values.time_cycle
      let weekCode
      if (Array.isArray(range) && range.length === 2) {
        const aligned = alignDateToWeek(
          range[0].format('YYYY-MM-DD'),
          range[1].format('YYYY-MM-DD')
        )
        weekCode = aligned?.weekCode
      }
      const payload = {
        ...values,
        time_cycle: weekCode,
        // DatePicker 的值转为后端要求的 YYYY-MM-DD
        publish_date: values.publish_date
          ? values.publish_date.format('YYYY-MM-DD')
          : undefined
      }
      setSubmitting(true)
      if (editingRecord) {
        await updateRecord(editingRecord.id, payload)
        message.success('更新成功')
      } else {
        await createRecord(payload)
        message.success('新增成功')
      }
      onSuccess?.()
    } catch {
      // 表单校验失败或接口错误（拦截器已提示）
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title={editingRecord ? '编辑投放记录' : '新增投放'}
      open={open}
      onOk={handleSubmit}
      onCancel={onCancel}
      confirmLoading={submitting}
      width={640}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
        <Row gutter={16}>
          <Col span={12}>
            {/* ★ 时间周期：DatePicker.RangePicker（原 Select 已彻底移除） */}
            <Form.Item
              name="time_cycle"
              label="时间周期"
              rules={[{ required: true, message: '请选择时间周期' }]}
            >
              <DatePicker.RangePicker
                allowClear
                size="middle"
                placeholder={['开始日期', '结束日期']}
                format="MM/DD"
                style={{ width: '100%' }}
                onChange={handleCycleChange}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="nickname"
              label="达人昵称"
              rules={[{ required: true, message: '请输入达人昵称' }]}
            >
              <Input placeholder="请输入达人昵称" maxLength={100} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="creator_type" label="博主类型">
              <Input placeholder="如 数码测评" maxLength={50} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="publish_date"
              label="发布日期"
              rules={[{ required: true, message: '请选择发布日期' }]}
            >
              <DatePicker style={{ width: '100%' }} placeholder="选择日期" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="total_cost"
              label="总花费（元）"
              rules={[
                { required: true, message: '请输入总花费' },
                { type: 'number', min: 0, message: '总花费不能为负数' }
              ]}
            >
              <InputNumber min={0} precision={2} style={{ width: '100%' }} placeholder="0.00" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="homepage" label="达人主页">
              <Input placeholder="https://" maxLength={500} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="content_link" label="植入内容链接">
              <Input placeholder="https://" maxLength={500} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="video_link" label="视频发布链接">
              <Input placeholder="https://" maxLength={500} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="first_play"
              label="7日播放量"
              extra="内容发布约7天时记录的累计播放量"
              rules={[{ type: 'number', min: 0, message: '播放量不能为负数' }]}
            >
              <InputNumber min={0} precision={0} style={{ width: '100%' }} placeholder="0" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="second_week_play"
              label="累计播放量"
              extra="最近一次更新时的累计播放量，可后续继续更新；留空表示待更新"
              dependencies={['first_play']}
              rules={[
                { type: 'number', min: 0, message: '播放量不能为负数' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    // 留空 = 待更新，允许保存
                    if (value === undefined || value === null || value === '') {
                      return Promise.resolve()
                    }
                    const firstValue = getFieldValue('first_play')
                    if (firstValue === undefined || firstValue === null || firstValue === '') {
                      return Promise.resolve()
                    }
                    const latest = Number(value)
                    const first = Number(firstValue)
                    // 产品规则：最新累计播放量不得小于 7日累计播放量
                    if (Number.isFinite(latest) && Number.isFinite(first) && latest < first) {
                      return Promise.reject(
                        new Error('累计播放量不能小于7日播放量，请检查数据是否录入正确。')
                      )
                    }
                    return Promise.resolve()
                  }
                })
              ]}
            >
              <InputNumber min={0} precision={0} style={{ width: '100%' }} placeholder="0" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
      {isEditingRecord && (
        <Collapse
          ghost
          items={[
            {
              key: 'edit-history',
              label: '编辑历史',
              children: editHistory.loading ? (
                <Typography.Text type="secondary">加载编辑历史…</Typography.Text>
              ) : editHistory.error ? (
                <Typography.Text type="warning">{editHistory.error}</Typography.Text>
              ) : buildRecordEditRows(editHistory.edits).length === 0 ? (
                <Typography.Text type="secondary">暂无编辑历史</Typography.Text>
              ) : (
                buildRecordEditRows(editHistory.edits).map((row) => (
                  <div key={row.key} style={{ marginBottom: 6 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {row.when} · {row.source} · {row.action}
                    </Typography.Text>
                    <div style={{ fontSize: 12 }}>
                      {row.field}：{row.before} → {row.after}
                    </div>
                  </div>
                ))
              )
            }
          ]}
        />
      )}
    </Modal>
  )
}
