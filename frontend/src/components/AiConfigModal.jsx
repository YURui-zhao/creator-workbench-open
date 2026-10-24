import { useEffect } from 'react'
import { Button, Form, Input, Modal, Select, Typography, message } from 'antd'
import {
  AI_PROVIDERS,
  DEFAULT_PROVIDER,
  clearAiConfig,
  clearAiSessionKey,
  getAiConfig,
  getProviderPreset,
  saveAiConfig
} from '../utils/aiConfig.js'

const PROVIDER_OPTIONS = Object.values(AI_PROVIDERS).map((item) => ({
  value: item.value,
  label: item.label
}))

/**
 * AI 接口配置弹窗
 * - AI 服务商：DeepSeek / 智谱 AI（切换时清空密钥并填充默认模型）
 * - API 密钥：密码样式，可切换显示明文
 * - 模型可自定义；接口地址由后端按服务商固定
 * - 密钥仅保存在当前浏览器会话，刷新后仍可使用
 */
export default function AiConfigModal({ open, onCancel, onSaved, onDisconnected, onProviderChanged }) {
  const [form] = Form.useForm()

  // 打开时回显本地配置（含向下兼容：旧配置无 provider 视为 DeepSeek）
  useEffect(() => {
    if (!open) return
    const config = getAiConfig()
    if (config) {
      form.setFieldsValue(config)
    } else {
      const preset = getProviderPreset(DEFAULT_PROVIDER)
      form.setFieldsValue({
        provider: DEFAULT_PROVIDER,
        model: preset.model,
        apiKey: ''
      })
    }
  }, [open, form])

  // 切换服务商后不沿用另一服务商的密钥。
  const handleProviderChange = (provider) => {
    clearAiSessionKey()
    onProviderChanged?.()
    const preset = getProviderPreset(provider)
    form.setFieldsValue({
      provider,
      model: preset.model,
      apiKey: ''
    })
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      const config = {
        provider: values.provider,
        model: String(values.model || '').trim(),
        apiKey: String(values.apiKey || '').trim()
      }
      const saved = saveAiConfig(config)
      message.success('AI 配置已保存')
      onSaved?.(saved)
    } catch {
      // 表单校验失败由 antd 内联提示
    }
  }

  const handleDisconnect = () => {
    clearAiConfig()
    form.setFieldsValue({ apiKey: '' })
    onDisconnected?.()
    message.success('已清除当前会话的 AI Key；后端环境变量（如有）仍保留')
  }

  return (
    <Modal
      title="AI 接口配置"
      open={open}
      onOk={handleSave}
      onCancel={onCancel}
      okText="保存配置"
      cancelText="取消"
      width={520}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item
          name="provider"
          label="AI 服务商"
          rules={[{ required: true, message: '请选择 AI 服务商' }]}
        >
          <Select options={PROVIDER_OPTIONS} onChange={handleProviderChange} />
        </Form.Item>
        <Form.Item
          name="apiKey"
          label="API 密钥"
          rules={[{ required: true, message: '请输入 AI API Key' }]}
        >
          <Input.Password placeholder="请输入 AI API Key" autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="model"
          label="模型"
          rules={[{ required: true, message: '请输入模型名称' }]}
        >
          <Input placeholder="deepseek-chat" />
        </Form.Item>
        <Typography.Text type="secondary">
          密钥仅保留在当前浏览器会话，刷新后仍可使用。接口地址由服务商固定；断开不会删除后端环境变量。
        </Typography.Text>
        <div style={{ marginTop: 4 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            这里的「模型」用于文本类 AI 任务（智能校验 / 字段映射 / 周期识别）；截图识别的图片模型由后端固定（DeepSeek：deepseek-flash），不在此处编辑。
          </Typography.Text>
        </div>
        <div style={{ marginTop: 16 }}>
          <Button danger onClick={handleDisconnect}>断开 AI</Button>
        </div>
      </Form>
    </Modal>
  )
}
