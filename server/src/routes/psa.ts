/**
 * PSA 鑑定編號查證端點。
 *
 * 前端在賣家填 cert 編號時呼叫這支預先查一次，好在**送出開池表單之前**就
 * 告訴賣家「這張查得到／查不到／暫時無法查」。真正的把關仍然在建池 API
 * （routes/pools.ts）—— 這支只是提前給回饋，不能當成唯一防線（直接打建池
 * API 的人不會先來這裡）。
 *
 * 要登入才能用：查證會消耗 PSA 每天 100 次的配額，不開放匿名打。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { verifyCert } from '../psa.js'

export const psa = new Hono()

const Body = z.object({
  // 長度上限防呆：真實 cert 編號是 7–9 位數字，STUB-* 也短。太長的直接擋
  certNumber: z.string().min(1).max(64)
})

/**
 * POST /v1/psa/verify
 * → { ok:true, cert:{...} } 查到
 * → { ok:false, reason:'invalid_format' | 'not_found' | 'api_unavailable' | 'not_configured' }
 *
 * 一律回 HTTP 200：這四種都是「查證的正常結果」，不是請求本身出錯。
 * 用 body 裡的 ok/reason 分辨，跟建池 API 的判斷共用同一套語意
 * （見 psa.ts 的 VerifyResult）。
 */
psa.post('/verify', requireAuth, async c => {
  const parsed = Body.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '請提供 cert 編號' }, 400)
  const result = await verifyCert(sql, parsed.data.certNumber)
  return c.json(result)
})
