import request from '../utils/request.js'

// 后端健康检查（含数据库连通性）
export function checkHealth() {
  return request.get('/health')
}
