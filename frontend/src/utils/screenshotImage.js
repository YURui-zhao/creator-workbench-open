/**
 * 截图处理（V3-alpha P2A）：类型/数量/体积校验 + 上传前本地缩放压缩
 *
 * 目标：base64 后请求体稳定落在后端现有 5mb JSON limit 内
 *   - 最多 3 张
 *   - 单张处理后 <= 1.5MB
 *   - 总发送体积 <= 3.2MB
 *   - 长边 <= 2000px（文字可读性优先，只缩小不放大）
 *
 * 纯函数（可单测）：MIME 归一化、体积换算、校验、压缩尝试序列、缩放尺寸
 * 浏览器相关（canvas 编码）只在 prepareImageFile 内，测试不依赖
 */

export const MAX_SCREENSHOT_COUNT = 3
export const MAX_IMAGE_BYTES = 1572864 // 1.5MB
export const MAX_TOTAL_BYTES = 3355400 // ~3.2MB
export const MAX_EDGE = 2000
export const ALLOWED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp']
export const IMAGE_ACCEPT_ATTR = 'image/png,image/jpeg,image/webp'

const MIME_ALIASES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  'image/jpg': 'image/jpeg'
}

/** 归一化图片 MIME（仅允许 png / jpg / jpeg / webp），非法返回 null */
export function normalizeImageMime(raw) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (!text) return null
  const mime = MIME_ALIASES[text] || text
  return ALLOWED_IMAGE_MIMES.includes(mime) ? mime : null
}

/** base64 字符串 -> 解码后的真实字节数（上行前自检，与后端算法一致） */
export function base64ByteLength(base64) {
  const text = String(base64 ?? '').trim()
  if (!text) return 0
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding)
}

/** 单个文件校验：只做类型与基本可用性（体积上限在压缩后再判） */
export function validateImageFile(file) {
  if (!file) return { ok: false, reason: '未读取到文件' }
  const mime = normalizeImageMime(file.type)
  if (!mime) {
    return { ok: false, reason: `不支持的文件类型（仅支持 png / jpg / jpeg / webp）：${file.name || '未命名'}` }
  }
  if (!Number(file.size)) {
    return { ok: false, reason: `文件为空：${file.name || '未命名'}` }
  }
  return { ok: true, mime }
}

/** 追加数量校验（保持最多 MAX_SCREENSHOT_COUNT 张） */
export function validateSelection(fileCount, currentCount, limit = MAX_SCREENSHOT_COUNT) {
  if (fileCount <= 0) return { ok: false, reason: '没有可添加的图片' }
  if (currentCount + fileCount > limit) {
    return { ok: false, reason: `最多支持 ${limit} 张截图（当前已有 ${currentCount} 张，本次选择 ${fileCount} 张）` }
  }
  return { ok: true }
}

/** 总发送体积校验（原始字节，不含 base64 膨胀） */
export function validateTotalBytes(bytes, limit = MAX_TOTAL_BYTES) {
  if (bytes > limit) {
    return { ok: false, reason: `截图总体积超过 ${(limit / 1024 / 1024).toFixed(1)}MB，请减少张数或压缩后重试` }
  }
  return { ok: true }
}

/** 长边缩放到 maxEdge 内（只缩小不放大） */
export function scaleSize(width, height, maxEdge = MAX_EDGE) {
  const w = Number(width) || 0
  const h = Number(height) || 0
  if (w <= 0 || h <= 0) return { width: 0, height: 0, scale: 1 }
  const longest = Math.max(w, h)
  if (longest <= maxEdge) return { width: Math.round(w), height: Math.round(h), scale: 1 }
  const scale = maxEdge / longest
  return { width: Math.round(w * scale), height: Math.round(h * scale), scale }
}

/**
 * 压缩尝试序列（确定性、可单测）
 * PNG 截图文字最清晰：先尝试原格式（无损）；仍超限时再逐级降 JPEG 质量与像素，
 * 保证「文字可读性优先」，且最终体积可控。
 */
export function buildCompressionAttempts(sourceMime) {
  const isPng = normalizeImageMime(sourceMime) === 'image/png'
  return [
    { type: isPng ? 'image/png' : 'image/jpeg', quality: isPng ? undefined : 0.92, maxEdge: MAX_EDGE },
    { type: 'image/jpeg', quality: 0.9, maxEdge: MAX_EDGE },
    { type: 'image/jpeg', quality: 0.8, maxEdge: MAX_EDGE },
    { type: 'image/jpeg', quality: 0.75, maxEdge: 1600 },
    { type: 'image/jpeg', quality: 0.7, maxEdge: 1200 }
  ]
}

/** 从多个候选结果中挑选：优先第一个不超限的；全部超限则取最小体积 */
export function pickBestAttempt(results, limit = MAX_IMAGE_BYTES) {
  const list = Array.isArray(results) ? results.filter(Boolean) : []
  const within = list.find((item) => item.bytes <= limit)
  if (within) return within
  return list.reduce((min, item) => (!min || item.bytes < min.bytes ? item : min), null)
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
    }
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => resolve({ image, url })
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片解析失败'))
    }
    image.src = url
  })
}

function canvasToBlob(canvas, attempt) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), attempt.type, attempt.quality)
  })
}

/**
 * 处理单张图片：校验 -> 缩放 -> 编码 -> 体积收敛
 * @returns {Promise<{ok: boolean, reason?: string, image?: Object}>}
 */
export async function prepareImageFile(file) {
  const basic = validateImageFile(file)
  if (!basic.ok) return basic

  let loaded
  try {
    loaded = await loadImage(file)
  } catch (error) {
    return { ok: false, reason: error?.message || '图片解析失败' }
  }

  const { image, url } = loaded
  const attempts = buildCompressionAttempts(basic.mime)
  const results = []
  try {
    for (const attempt of attempts) {
      const size = scaleSize(image.naturalWidth || image.width, image.naturalHeight || image.height, attempt.maxEdge)
      if (!size.width || !size.height) continue
      const canvas = document.createElement('canvas')
      canvas.width = size.width
      canvas.height = size.height
      const ctx = canvas.getContext('2d')
      // JPEG 不支持透明通道：统一铺白底，避免截图透明区域变黑
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, size.width, size.height)
      ctx.drawImage(image, 0, 0, size.width, size.height)
      const blob = await canvasToBlob(canvas, attempt)
      if (!blob) continue
      results.push({ blob, bytes: blob.size, width: size.width, height: size.height, type: blob.type || attempt.type })
      if (blob.size <= MAX_IMAGE_BYTES) break
    }
  } finally {
    URL.revokeObjectURL(url)
  }

  const best = pickBestAttempt(results)
  if (!best) return { ok: false, reason: `图片处理失败：${file.name || '未命名'}` }

  const base64 = await blobToBase64(best.blob)
  return {
    ok: true,
    image: {
      id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name || '粘贴的截图',
      mime: normalizeImageMime(best.type) || basic.mime,
      base64,
      bytes: base64ByteLength(base64),
      width: best.width,
      height: best.height,
      previewUrl: URL.createObjectURL(best.blob),
      oversize: best.bytes > MAX_IMAGE_BYTES
    }
  }
}

/** 释放预览用 objectURL（组件卸载 / 移除图片时调用） */
export function releasePreview(image) {
  if (image?.previewUrl) {
    try {
      URL.revokeObjectURL(image.previewUrl)
    } catch {
      // 忽略释放失败
    }
  }
}

/** 人类可读体积 */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / 1024 / 1024).toFixed(2)} MB`
}
