/**
 * 使用者名下的卡：保管中、已上架、申請出貨、已出貨、已回收。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { credit, walletOf } from '../money.js'
import { recycleEligible, recyclePoints } from '../shared/recycle.js'

export const prizes = new Hono()
prizes.use('*', requireAuth)

prizes.get('/', async c => {
  const rows = await sql`select * from prizes where user_id = ${c.get('userId')} order by won_at desc`
  return c.json({ prizes: rows })
})

/**
 * 回收：卡 → 點數。只有 stashed 的卡能回收（已上架、已申請出貨的不行）。
 * 報價用 shared/recycle.ts，跟前端試算是同一個數字。
 */
prizes.post('/:id/recycle', async c => {
  const me = c.get('userId')
  const r = await sql.begin(async tx => {
    const [p] = await tx`select * from prizes where id = ${c.req.param('id') ?? ''} and user_id = ${me} for update`
    if (!p) return { error: 'NOT_FOUND', message: '找不到這張卡', status: 404 }
    if (p.status !== 'stashed') return { error: 'WRONG_STATE', message: '只有保管中的卡可以回收', status: 409 }
    const refPrice = Number((p.card as { refPrice?: number }).refPrice ?? 0)
    if (!recycleEligible(refPrice)) return { error: 'TOO_LOW', message: '這張卡的市值太低，不開放回收', status: 409 }
    const pts = recyclePoints(refPrice)
    await tx`update prizes set status = 'recycled' where id = ${p.id}`
    await credit(tx, me, pts, 'recycle', p.id as string)
    return { points: pts }
  })
  if ('error' in r) return c.json(r, r.status as 404 | 409)
  return c.json({ ...r, wallet: await walletOf(me) })
})

const ShipBody = z.object({
  prizeIds: z.array(z.string()).min(1).max(50),
  address: z.object({
    name: z.string().min(1).max(40), phone: z.string().min(8).max(20),
    line1: z.string().min(1).max(120), city: z.string().min(1).max(40), zip: z.string().max(10).optional()
  })
})

/** 申請出貨：卡從保管庫離開。之後這些卡若要上架就是 delivery: 'ship'
 *
 *  address 目前由呼叫端整包傳進來。使用者的預設收件資料存在 users 表
 *  （real_name / phone / address_*，見 006_profile.sql），前端做出貨表單時
 *  應該用那些欄位預先填好，讓人不用每次重打；這裡仍然收完整的 address，
 *  因為「這次要寄到哪」跟「我的預設地址」是兩件事，得允許單次覆寫。
 */
prizes.post('/ship', async c => {
  const me = c.get('userId')
  const parsed = ShipBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '請填完整的收件資料' }, 400)
  const { prizeIds, address } = parsed.data
  const r = await sql.begin(async tx => {
    const rows = await tx`
      select id from prizes where id = any(${prizeIds}) and user_id = ${me} and status = 'stashed' for update
    `
    if (rows.length !== prizeIds.length) return { error: 'WRONG_STATE', message: '有卡片不在保管中，無法出貨', status: 409 }
    const id = 'sh-' + randomBytes(5).toString('hex')
    await tx`insert into shipments (id, user_id, prize_ids, address, created_at)
             values (${id}, ${me}, ${prizeIds}, ${address as never}, ${Date.now()})`
    await tx`update prizes set status = 'ship_requested' where id = any(${prizeIds})`
    return { shipmentId: id }
  })
  if ('error' in r) return c.json(r, r.status as 409)
  return c.json(r)
})
