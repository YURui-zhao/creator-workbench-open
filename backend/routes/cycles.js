import { Router } from 'express'
import { generateYearWeeks } from '../utils/dateCycle.js'

const router = Router()

function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, msg) {
  res.status(code).json({ code, data: null, msg })
}

/**
 * GET /api/cycles/list?year=2026
 * 获取指定年份（默认 2026）全年自然周列表，按时间倒序（最新周在最上面）
 */
router.get('/list', (req, res) => {
  const rawYear = req.query.year
  const year = rawYear === undefined || rawYear === '' ? undefined : Number(rawYear)
  if (year !== undefined && (!Number.isInteger(year) || year < 1970 || year > 9999)) {
    return fail(res, 400, 'year 必须为 1970-9999 之间的整数')
  }
  try {
    // 升序生成后反转，保证最新周在最上面
    const weeks = generateYearWeeks(year).reverse()
    ok(res, weeks)
  } catch (err) {
    return fail(res, 400, err.message)
  }
})

export default router
