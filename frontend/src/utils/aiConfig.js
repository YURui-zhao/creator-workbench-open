// localStorage 仅存非敏感配置；Key 与 Provider 绑定，保留在当前浏览器会话。
const AI_CONFIG_KEY = 'ai_config'
const AI_SESSION_KEY = 'ai_session_key'

// 支持的服务商及其默认配置
export const AI_PROVIDERS = {
  deepseek: {
    value: 'deepseek',
    label: 'DeepSeek',
    model: 'deepseek-chat'
  },
  zhipu: {
    value: 'zhipu',
    label: '智谱 AI',
    model: 'glm-4-flash'
  }
}

export const DEFAULT_PROVIDER = 'deepseek'

/** 服务商预设（未知服务商回退 DeepSeek） */
export function getProviderPreset(provider) {
  return AI_PROVIDERS[provider] || AI_PROVIDERS[DEFAULT_PROVIDER]
}

/**
 * 归一化配置：向下兼容旧配置（无 provider 字段视为 DeepSeek）
 * @returns {{ provider: string, model: string }}
 */
export function normalizeAiConfig(config) {
  const provider = AI_PROVIDERS[config?.provider] ? config.provider : DEFAULT_PROVIDER
  const preset = getProviderPreset(provider)
  return {
    provider,
    model: config?.model || preset.model
  }
}

/** 切换 Provider 或断开时立即清除当前会话 Key。 */
export function clearAiSessionKey() {
  sessionStorage.removeItem(AI_SESSION_KEY)
}

function getSessionApiKey(provider) {
  try {
    const raw = sessionStorage.getItem(AI_SESSION_KEY)
    if (!raw) return ''
    const saved = JSON.parse(raw)
    if (saved?.provider !== provider || typeof saved.apiKey !== 'string') {
      clearAiSessionKey()
      return ''
    }
    return saved.apiKey
  } catch {
    try { clearAiSessionKey() } catch { /* 会话存储不可用 */ }
    return ''
  }
}

/**
 * 读取本地 AI 配置
 * @returns {{ provider: string, model: string, apiKey: string } | null}
 */
export function getAiConfig() {
  try {
    const raw = localStorage.getItem(AI_CONFIG_KEY)
    if (!raw) {
      clearAiSessionKey()
      return null
    }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      localStorage.removeItem(AI_CONFIG_KEY)
      clearAiSessionKey()
      return null
    }
    const safeConfig = normalizeAiConfig(parsed)
    // 读取旧版本配置时立即移除 apiKey/baseUrl 等遗留字段，且绝不将旧 Key 载入内存。
    if (raw !== JSON.stringify(safeConfig)) {
      localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(safeConfig))
    }
    return {
      ...safeConfig,
      apiKey: getSessionApiKey(safeConfig.provider)
    }
  } catch {
    // 旧数据损坏或迁移写入失败时，尽力清掉可能含有 Key 的条目。
    try { localStorage.removeItem(AI_CONFIG_KEY) } catch { /* 存储不可用 */ }
    try { clearAiSessionKey() } catch { /* 会话存储不可用 */ }
    return null
  }
}

/** 只把服务商/模型写入 localStorage，把当前 Provider 的 Key 写入 sessionStorage。 */
export function saveAiConfig(config) {
  const safeConfig = normalizeAiConfig(config)
  const apiKey = String(config?.apiKey || '').trim()
  clearAiSessionKey()
  localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(safeConfig))
  if (apiKey) {
    sessionStorage.setItem(AI_SESSION_KEY, JSON.stringify({ provider: safeConfig.provider, apiKey }))
  }
  return { ...safeConfig, apiKey }
}

/** 断开会话 Key；保留非敏感配置并清除旧版本持久化 Key。 */
export function clearAiConfig() {
  const config = getAiConfig()
  clearAiSessionKey()
  if (config) {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(normalizeAiConfig(config)))
  } else {
    localStorage.removeItem(AI_CONFIG_KEY)
  }
}
