import { Router } from 'express'
import db from '../db.js'
import { buildXlsx } from '../utils/xlsx.js'

const router = Router()
const VALID_STATUS = ['todo', 'doing', 'done']
const STATUS_TEXT = { todo: '待开始', doing: '进行中', done: '已完成' }

function normalizeProgress(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.max(0, Math.min(100, Math.round(num)))
}

// 项目列表
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM projects ORDER BY id DESC').all()
  res.json(rows)
})

// Excel 导出
router.get('/export', (req, res) => {
  const rows = db.prepare('SELECT * FROM projects ORDER BY id DESC').all()
  const headers = ['ID', '项目名称', '负责人', '状态', '进度', '创建时间']
  const data = rows.map((row) => [
    row.id,
    row.name,
    row.owner,
    STATUS_TEXT[row.status] || row.status,
    `${row.progress}%`,
    row.created_at
  ])
  const content = buildXlsx('项目列表', headers, data)
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
  res.setHeader('Content-Disposition', 'attachment; filename="projects.xlsx"')
  res.send(content)
})

// 新增项目
router.post('/', (req, res) => {
  const { name, owner = '', status = 'todo', progress = 0 } = req.body || {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ message: '项目名称不能为空' })
  }
  if (!VALID_STATUS.includes(status)) {
    return res.status(400).json({ message: '非法的项目状态' })
  }
  const info = db
    .prepare('INSERT INTO projects (name, owner, status, progress) VALUES (?, ?, ?, ?)')
    .run(name.trim(), String(owner), status, normalizeProgress(progress))
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid)
  res.status(201).json(row)
})

// 更新项目
router.put('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: '非法的项目 ID' })
  }
  const current = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
  if (!current) {
    return res.status(404).json({ message: '项目不存在' })
  }

  const { name, owner, status, progress } = req.body || {}
  const next = {
    name: typeof name === 'string' && name.trim() ? name.trim() : current.name,
    owner: typeof owner === 'string' ? owner : current.owner,
    status: VALID_STATUS.includes(status) ? status : current.status,
    progress: progress === undefined ? current.progress : normalizeProgress(progress)
  }
  db.prepare('UPDATE projects SET name = ?, owner = ?, status = ?, progress = ? WHERE id = ?').run(
    next.name,
    next.owner,
    next.status,
    next.progress,
    id
  )
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(id))
})

// 删除项目
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: '非法的项目 ID' })
  }
  const info = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  if (info.changes === 0) {
    return res.status(404).json({ message: '项目不存在' })
  }
  res.json({ success: true })
})

export default router
