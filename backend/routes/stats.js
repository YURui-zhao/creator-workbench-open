import { Router } from 'express'
import db from '../db.js'

const router = Router()

router.get('/', (req, res) => {
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) AS todo,
        SUM(CASE WHEN status = 'doing' THEN 1 ELSE 0 END) AS doing,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
      FROM projects
    `)
    .get()
  res.json({
    total: row.total ?? 0,
    todo: row.todo ?? 0,
    doing: row.doing ?? 0,
    done: row.done ?? 0,
    time: new Date().toISOString()
  })
})

export default router
