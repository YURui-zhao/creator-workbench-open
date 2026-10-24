import axios from 'axios'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- 仅支持固定的官方服务商接口 ----------
const PROVIDERS = {
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    // P2A：图片识别固定使用官方 vision 模型（deepseek-flash 官方文档明确支持 Vision）。
    // 该字段只能由后端预设提供，请求头 x-ai-model 不得覆盖。
    visionModel: 'deepseek-flash',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    supportsJsonMode: true // 支持 response_format: json_object
  },
  zhipu: {
    key: 'zhipu',
    label: '智谱 AI',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-flash',
    // P2A 第一版只实现 DeepSeek Vision；智谱视觉模型作为后续备选，因此这里显式置空
    visionModel: null,
    apiKeyEnv: 'ZHIPU_API_KEY',
    supportsJsonMode: false // 提示词已要求严格 JSON，避免部分模型不支持该参数
  }
}
const DEFAULT_PROVIDER = 'deepseek'
const TIMEOUT = 60000 // AI 批量判定耗时较长，超时放宽到 60s

/** 解析服务商（未知/缺省回退 DeepSeek，向下兼容） */
export function resolveProvider(provider) {
  const key = String(provider ?? '').trim().toLowerCase()
  return PROVIDERS[key] || PROVIDERS[DEFAULT_PROVIDER]
}

/** 服务商的非敏感元数据 */
export function listProviders() {
  return Object.values(PROVIDERS).map((item) => ({
    key: item.key,
    label: item.label,
    model: item.model,
    visionModel: item.visionModel || null
  }))
}

/**
 * 取服务商固定的图片识别模型（P2A）
 * 只从后端预设读取，绝不接受请求头 / 参数覆盖；未开放 Vision 的服务商返回 null。
 */
export function getVisionModel(provider) {
  return resolveProvider(provider).visionModel || null
}

// ---------- 只读调用日志（不改变任何调用逻辑） ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOG_DIR = path.join(__dirname, '..', 'logs')
const LOG_FILE = path.join(LOG_DIR, 'ai.log')
let logDirReady = false

// 规范化 Token 用量（无则 null）
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const prompt = usage.prompt_tokens ?? usage.promptTokens ?? null
  const completion = usage.completion_tokens ?? usage.completionTokens ?? null
  const total = usage.total_tokens ?? usage.totalTokens ?? null
  if (prompt === null && completion === null && total === null) return null
  return { prompt, completion, total }
}

// 错误摘要（截断 + 脱敏：DeepSeek sk- 形态、智谱 id.secret 形态、上游掩码形态）
function redactKey(value, key) {
  const text = String(value)
  return key ? text.split(String(key)).join('[REDACTED]') : text
}

/**
 * 图片正文兜底脱敏（P2A）：任何进入日志 / 错误信息的文本都不得包含图片 base64。
 * 先剥离 data URL 形态，再兜底剥离超长 base64 片段（含图片正文与其它大块编码）。
 */
function redactImagePayload(value) {
  return String(value)
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, 'data:image/***;base64,[REDACTED]')
    // 兜底：错误文本里出现 64 位以上的 base64 片段（图片正文或其片段）一律剥离
    .replace(/[A-Za-z0-9+/]{64,}={0,2}/g, '[REDACTED_BASE64]')
}

function summarizeError(err, mapped, key) {
  const detail = err?.response?.data?.error?.message || err?.response?.data?.message
  const text = detail || mapped?.message || err?.message || '未知错误'
  return redactImagePayload(redactKey(text, key))
    .replace(/sk-[A-Za-z0-9_-]+/gi, 'sk-***')
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g, '***.***')
    .replace(/\*{2,}[A-Za-z0-9_-]*/g, '****')
    .slice(0, 300)
}

/**
 * 写入 AI 调用日志：backend/logs/ai.log，按天追加（每行一条 JSON，含日期字段）
 * 仅记录：时间戳、服务商、模型、HTTP 状态码、耗时(ms)、Token 用量、错误摘要、接口地址
 * 写入失败静默忽略，绝不影响正常请求；不记录任何密钥内容
 */
function writeAiLog({ provider, model, status, durationMs, usage, error, endpoint }) {
  try {
    if (!logDirReady) {
      fs.mkdirSync(LOG_DIR, { recursive: true })
      logDirReady = true
    }
    const now = new Date()
    const entry = {
      time: now.toISOString(),
      day: now.toISOString().slice(0, 10),
      provider,
      model,
      status: status ?? null,
      durationMs,
      endpoint: endpoint || null,
      usage: usage ?? null,
      error: error ?? null
    }
    fs.appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, () => {})
  } catch {
    // 日志失败静默忽略：不影响 AI 调用与业务流程
  }
}

/** AI 相关错误：统一携带友好提示，便于路由层返回 */
export class DeepSeekError extends Error {
  constructor(message, status = 502) {
    super(message)
    this.name = 'DeepSeekError'
    this.isDeepSeekError = true
    this.status = status
  }
}

// 占位值视为未配置
function isPlaceholderKey(key) {
  if (!key) return true
  const text = String(key).trim()
  return text === '' || text.includes('替换为你的') || text === 'sk-' || text.length < 8
}

/**
 * 校验指定服务商是否已配置有效 API Key：
 * 优先使用页面传入的 Key（请求头 x-ai-api-key），否则回退该服务商环境变量
 * @param {string} provider 服务商（deepseek / zhipu）
 * @param {string} [requestedKey] 请求头传入的 API Key
 */
export function isProviderConfigured(provider, requestedKey) {
  const info = resolveProvider(provider)
  const key = !isPlaceholderKey(requestedKey) ? requestedKey : process.env[info.apiKeyEnv]
  return !isPlaceholderKey(key)
}

/** 向下兼容：默认检查 DeepSeek 配置 */
export function isDeepSeekConfigured(requestedKey) {
  return isProviderConfigured(DEFAULT_PROVIDER, requestedKey)
}

// 读取 API Key：请求头优先，对应服务商环境变量兜底（禁止硬编码）
function getApiKey(providerKey, requestedKey) {
  const info = resolveProvider(providerKey)
  const key = !isPlaceholderKey(requestedKey) ? requestedKey : process.env[info.apiKeyEnv]
  if (isPlaceholderKey(key)) {
    throw new DeepSeekError(
      `未配置 ${info.label} API Key，请先在页面右上角配置（或设置后端环境变量 ${info.apiKeyEnv}）`,
      400
    )
  }
  return key
}

/** 将 axios 错误转换为友好提示（按服务商标注） */
function toDeepSeekError(err, providerLabel = PROVIDERS[DEFAULT_PROVIDER].label, key) {
  if (err instanceof DeepSeekError) return err
  if (err.code === 'ECONNABORTED') {
    return new DeepSeekError(`${providerLabel} 请求超时，请稍后重试`)
  }
  const status = err.response?.status
  const detail = err.response?.data?.error?.message || err.response?.data?.message
  // 3xx：明确拒绝跟随重定向（请求携带 API Key 与可能的图片正文）。
  // 只回显状态码，绝不回显 Location / provider 原始 body / Key / base64。
  if (status >= 300 && status < 400) {
    return new DeepSeekError(
      `${providerLabel} 接口返回重定向（HTTP ${status}），已按安全策略拒绝跟随，请稍后重试或检查服务商配置`,
      502
    )
  }
  if (status === 401 || status === 403) {
    return new DeepSeekError(
      `${providerLabel} API Key 无效或未授权，请在页面右上角「AI配置」中检查密钥（或后端环境变量）`,
      502
    )
  }
  if (status === 429) {
    return new DeepSeekError(`${providerLabel} 请求过于频繁，请稍后重试`)
  }
  if (status >= 500) {
    return new DeepSeekError(`${providerLabel} 服务异常（${status}），请稍后重试`)
  }
  // 上游错误原文也必须脱敏：既不回显 Key，也不回显图片 base64
  const detailText = detail ? `：${redactImagePayload(redactKey(detail, key)).slice(0, 200)}` : ''
  return new DeepSeekError(`${providerLabel} 接口调用失败${detailText}`, 502)
}

/**
 * 统一的多服务商 AI 调用函数（OpenAI 标准 chat/completions 协议）
 * @param {string} systemPrompt 系统提示词
 * @param {string} userContent 用户输入内容
 * @param {Object} [options] { temperature, maxTokens, apiKey, provider, model }
 * @returns {Promise<string>} 模型返回的文本内容
 */
export async function callDeepSeek(systemPrompt, userContent, options = {}) {
  const startedAt = Date.now()
  const { temperature = 0, maxTokens = 4096, apiKey, provider, model } = options
  const providerInfo = resolveProvider(provider)
  const finalModel = (model && String(model).trim()) || providerInfo.model

  return sendChatCompletion({
    providerInfo,
    model: finalModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature,
    maxTokens,
    apiKey,
    startedAt
  })
}

/**
 * P2A：图片识别调用（DeepSeek Vision）
 * - 模型固定取服务商预设的 visionModel，绝不接受请求头 / 参数覆盖
 * - 接口地址仍固定为服务商官方 endpoint；不接受 baseURL
 * - 图片以 OpenAI 兼容的 content parts 发送（data URL 内联 base64），不落盘
 * @param {Object} params
 * @param {string} params.systemPrompt 系统提示词
 * @param {string} params.userText 文字指令（不含图片正文）
 * @param {Array<{mime: string, base64: string}>} params.images 已由路由层校验过的图片
 * @param {string} [params.provider] 服务商（deepseek / zhipu）
 * @param {string} [params.apiKey] 页面传入的 Key（缺省用环境变量）
 * @returns {Promise<string>} 模型返回的文本内容
 */
export async function callProviderVision({
  systemPrompt,
  userText,
  images = [],
  provider,
  apiKey,
  maxTokens = 4096
} = {}) {
  const startedAt = Date.now()
  const providerInfo = resolveProvider(provider)
  const visionModel = providerInfo.visionModel
  if (!visionModel) {
    throw new DeepSeekError(
      `${providerInfo.label} 暂未开放图片识别（P2A 仅支持 DeepSeek Vision），请在右上角「AI配置」中切换到 DeepSeek`,
      400
    )
  }

  const content = [{ type: 'text', text: String(userText ?? '') }]
  for (const image of Array.isArray(images) ? images : []) {
    const mime = String(image?.mime || '').trim()
    const base64 = String(image?.base64 || '').trim()
    if (!mime || !base64) continue
    content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } })
  }

  return sendChatCompletion({
    providerInfo,
    model: visionModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content }
    ],
    temperature: 0,
    maxTokens,
    apiKey,
    startedAt
  })
}

/**
 * 统一的 chat/completions 发送（文本与图片共用）：固定 endpoint、脱敏日志、统一错误映射
 */
async function sendChatCompletion({
  providerInfo,
  model,
  messages,
  temperature = 0,
  maxTokens = 4096,
  apiKey,
  startedAt
}) {
  const finalUrl = providerInfo.endpoint
  const finalModel = model
  let finalKey
  try {
    finalKey = getApiKey(providerInfo.key, apiKey)
  } catch (err) {
    // 只读日志：未发起外部调用的配置错误
    writeAiLog({
      provider: providerInfo.key,
      model: finalModel,
      status: null,
      durationMs: Date.now() - startedAt,
      usage: null,
      error: `配置错误：${err.message}`,
      endpoint: finalUrl
    })
    throw err
  }

  const payload = {
    model: finalModel,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false
  }
  // 严格 JSON 输出（仅对支持该参数的服务商开启，其余依赖提示词约束）
  if (providerInfo.supportsJsonMode) {
    payload.response_format = { type: 'json_object' }
  }

  try {
    const response = await axios.post(finalUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${finalKey}`
      },
      timeout: TIMEOUT,
      // 安全边界（不可移除）：绝不跟随 3xx 跳转。
      // 请求携带 API Key（以及 Vision 场景下的图片正文），
      // 一旦跟随重定向就可能把凭据/正文发给不受信地址。
      // axios 在 maxRedirects === 0 时直接使用原生 http/https 传输层，不经过 follow-redirects。
      maxRedirects: 0
    })

    const content = response.data?.choices?.[0]?.message?.content
    if (!content) {
      throw new DeepSeekError(`${providerInfo.label} 返回内容为空`)
    }
    // 只读日志：成功调用（状态码/耗时/Token 用量）
    writeAiLog({
      provider: providerInfo.key,
      model: finalModel,
      status: response.status ?? 200,
      durationMs: Date.now() - startedAt,
      usage: normalizeUsage(response.data?.usage),
      error: null,
      endpoint: finalUrl
    })
    return String(content)
  } catch (err) {
    const mapped = toDeepSeekError(err, providerInfo.label, finalKey)
    // 只读日志：失败调用（状态码/耗时/错误摘要）
    writeAiLog({
      provider: providerInfo.key,
      model: finalModel,
      status: err.response?.status ?? null,
      durationMs: Date.now() - startedAt,
      usage: normalizeUsage(err.response?.data?.usage),
      error: summarizeError(err, mapped, finalKey),
      endpoint: finalUrl
    })
    throw mapped
  }
}
