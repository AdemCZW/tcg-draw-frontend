/**
 * 自我檢測的對外端點。邏輯全在 ../monitor.ts，這裡只是門。
 *
 * 獨立成一個檔案而不是塞進 admin.ts：admin.ts 正在被別條工作線
 * （客服工單）擴充，兩邊同時改同一個檔案會互相蓋掉。
 * requireAdmin 因此在這裡有一份小的複製 —— 等兩邊都落地再合併，
 * 比現在硬共用便宜。
 */
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { monitorSweep, runMonitor } from '../monitor.js'

export const monitor = new Hono()
monitor.use('*', requireAuth)

async function requireAdmin(c: Context, next: Next) {
  const [u] = await sql`select role from users where id = ${c.get('userId')}`
  if (u?.role !== 'admin') return c.json({ error: 'NOT_PLATFORM', message: '需要管理員權限' }, 403)
  await next()
}
monitor.use('*', requireAdmin)

/** 手動跑一輪，看現況。只讀不通知 —— 手動查看不該重複觸發警報 */
monitor.get('/', async c => c.json(await runMonitor()))

/** 手動跑一輪並照常發通知（測試通知鏈路用） */
monitor.post('/run', async c => c.json(await monitorSweep()))
