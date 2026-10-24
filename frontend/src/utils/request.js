import axios from 'axios'
import { message } from 'antd'

// 统一的 axios 实例：baseURL /api，由 Vite 代理转发到后端 3001
const request = axios.create({
  baseURL: '/api',
  timeout: 15000
})

// 响应拦截器：直接返回后端统一格式 { code, data, msg }
request.interceptors.response.use(
  (response) => response.data,
  (error) => {
    // silentError：辅助只读请求（如「编辑历史」面板）自行展示加载失败，不弹全局 toast。
    // 这是全局唯一的选择性关闭机制：HTTP 错误默认仍由这里统一提示一次。
    if (!error?.config?.silentError) {
      message.error(getErrorMessage(error))
    }
    return Promise.reject(error)
  }
)

/**
 * 统一的错误信息提取：优先后端 msg/message，其次网络错误原因
 * 供页面 catch 兜底展示（配合重试按钮）
 */
export function getErrorMessage(error, fallback = '请求失败，请检查后端服务是否已启动') {
  return (
    error?.response?.data?.msg ||
    error?.response?.data?.message ||
    error?.message ||
    fallback
  )
}

export default request
