import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import db from './db.js'
import aiRouter from './routes/ai.js'
import cyclesRouter from './routes/cycles.js'
import creatorDecisionsRouter from './routes/creatorDecisions.js'
import creatorDecisionOutcomesRouter from './routes/creatorDecisionOutcomes.js'
import creatorNegotiationCasesRouter from './routes/creatorNegotiationCases.js'
import creatorCandidatesRouter from './routes/creatorCandidates.js'
// Creator Identity V1 Phase 2：Creator 身份层只读视图（creators / creator_aliases）
import creatorsRouter from './routes/creators.js'
import importBatchesRouter from './routes/importBatches.js'
import recentSnapshotsRouter from './routes/recentSnapshots.js'
import recordsRouter from './routes/records.js'
import projectsRouter from './routes/projects.js'
import statsRouter from './routes/stats.js'
import { isDeepSeekConfigured } from './services/deepseek.js'

// 加载 backend/.env（与启动目录无关）
const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })

// 启动时校验 AI 配置（未配置不阻塞启动，AI 功能自动降级）
if (isDeepSeekConfigured()) {
  console.log('[ai] DeepSeek API Key 已配置，AI 智能校验可用')
} else {
  console.warn('[ai] 未配置 DEEPSEEK_API_KEY，AI 智能校验将降级为普通导入（不影响基础功能）')
}

const app = express()
const PORT = process.env.PORT || 3001
const HOST = '127.0.0.1'
const LOCAL_FRONTEND_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

// 仅允许固定本地前端跨域；无 Origin 的本地脚本请求仍可正常访问 API
app.use(cors({ origin: LOCAL_FRONTEND_ORIGINS }))

// 请求体大小限制：支持批量导入/批量 AI 校验数据
app.use(express.json({ limit: '5mb' }))

// 健康检查
app.get('/api/health', (req, res) => {
  let dbOk = false
  try {
    db.prepare('SELECT 1 AS ok').get()
    dbOk = true
  } catch {
    dbOk = false
  }
  res.json({
    status: dbOk ? 'ok' : 'error',
    db: dbOk ? 'ok' : 'error',
    time: new Date().toISOString(),
    port: PORT
  })
})

// 业务路由
app.use('/api/ai', aiRouter)
app.use('/api/cycles', cyclesRouter)
app.use('/api/creator-decisions', creatorDecisionsRouter)
// P5：同一前缀下追加 outcome 关联子路径（P4 router 本身不做任何改动）
app.use('/api/creator-decisions', creatorDecisionOutcomesRouter)
// A4：谈判结果沉淀（独立表 / 独立路由，不改写 decision）
app.use('/api/creator-negotiation-cases', creatorNegotiationCasesRouter)
// Playbook Phase 1：候选达人身份层（独立表 / 独立路由，不影响 creator_records 与 Radar）
app.use('/api/creator-candidates', creatorCandidatesRouter)
// Creator Identity Phase 2：Creator 只读接口（GET only；不写库、不影响 legacy nickname 路径）
app.use('/api/creators', creatorsRouter)
app.use('/api/import', importBatchesRouter)
app.use('/api/recent-snapshots', recentSnapshotsRouter)
app.use('/api/records', recordsRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/stats', statsRouter)

// 404
app.use((req, res) => {
  res.status(404).json({ code: 404, data: null, msg: '接口不存在', message: '接口不存在' })
})

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('[backend] 未捕获异常:', err)
  res.status(500).json({ code: 500, data: null, msg: '服务器内部错误', message: '服务器内部错误' })
})

app.listen(PORT, HOST, () => {
  console.log(`[backend] 服务已启动: http://${HOST}:${PORT}`)
})

// 优雅退出时关闭数据库
process.on('SIGINT', () => {
  db.close()
  process.exit(0)
})
