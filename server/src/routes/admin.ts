/**
 * 後台。只有 users.role = 'admin' 能進。
 *
 * 每個動作都寫進 admin_actions —— 發點數、審賣家、裁爭議，
 * 沒有稽核紀錄的話出事時連自己都說不清。
 */
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { credit, walletOf } from '../money.js'

export const admin = new Hono()
admin.use('*', requireAuth)

async function requireAdmin(c: Context, next: Next) {
  const [u] = await sql`select role from users where id = ${c.get('userId')}`
  if (u?.role !== 'admin') return c.json({ error: 'NOT_PLATFORM', message: '需要管理員權限' }, 403)
  await next()
}
admin.use('*', requireAdmin)

async function audit(adminId: string, action: string, target: string | null, payload: unknown, note = '') {
  await sql`insert into admin_actions (admin_id, action, target, payload, note)
            values (${adminId}, ${action}, ${target}, ${payload as never}, ${note})`
}

/* ---- 發點數 ----
   金流還沒接，點數由平台發放。每一筆帶 ref_id = 一次性的發放編號，
   靠 ledger_once 擋重送；note 必填，逼發放的人寫清楚為什麼。 */
const Grant = z.object({
  userId: z.string().min(1),
  points: z.number().int().positive().max(100_000_000),
  note: z.string().min(2).max(200)
})
admin.post('/grant', async c => {
  const me = c.get('userId')
  const parsed = Grant.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '需要 userId、points、note（說明原因）' }, 400)
  const { userId, points, note } = parsed.data
  const [u] = await sql`select id from users where id = ${userId}`
  if (!u) return c.json({ error: 'NOT_FOUND', message: '找不到這個使用者' }, 404)
  const ref = 'grant-' + randomBytes(6).toString('hex')
  await sql.begin(async tx => {
    await credit(tx, userId, points, 'admin-grant', ref)
  })
  await audit(me, 'grant', userId, { points, ref }, note)
  return c.json({ ok: true, ref, wallet: await walletOf(userId) })
})

/* ---- 賣家 ---- */
const Verify = z.object({ tier: z.enum(['pending', 'verified', 'trusted']), note: z.string().max(200).default('') })
admin.post('/sellers/:id/tier', async c => {
  const me = c.get('userId')
  const id = c.req.param('id') ?? ''
  const parsed = Verify.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
  const r = await sql`update sellers set tier = ${parsed.data.tier} where id = ${id} returning id`
  if (!r.length) return c.json({ error: 'NOT_FOUND', message: '找不到這個賣家' }, 404)
  await audit(me, 'seller-tier', id, { tier: parsed.data.tier }, parsed.data.note)
  return c.json({ ok: true })
})

/* ---- 使用者 ---- */
admin.get('/users', async c => {
  const q = (c.req.query('q') ?? '').trim()
  const rows = q
    ? await sql`select id, handle, name, email, role, created_at from users
                where handle ilike ${'%' + q + '%'} or name ilike ${'%' + q + '%'} or email ilike ${'%' + q + '%'}
                order by created_at desc limit 50`
    : await sql`select id, handle, name, email, role, created_at from users order by created_at desc limit 50`
  return c.json({ users: rows })
})

admin.get('/users/:id/wallet', async c => {
  const id = c.req.param('id') ?? ''
  const rows = await sql`select id, delta, reason, ref_id, created_at from points_ledger
                         where user_id = ${id} order by id desc limit 200`
  return c.json({ wallet: await walletOf(id), ledger: rows })
})

/* ---- 賣家 ----
   後台要看的跟公開頁不同：這裡要的是「誰在等審核」，
   還有平台自己關心的營運數字（開了幾池、爭議多少），不是行銷用的展示資料。 */
admin.get('/sellers', async c => {
  const rows = await sql`
    select s.id, s.handle, s.name, s.origin, s.tier, s.joined_at,
      (select count(*) from pools p where p.seller_id = s.id
        and p.status in ('open','sold_out','revealed'))::int as pools_run,
      (select count(*) from orders o where o.seller_id = s.id
        and o.closed_by in ('dispute-buyer','ship-timeout'))::int as faults,
      (select count(*) from seller_verifications v where v.seller_id = s.id
        and v.status = 'pending')::int as pending_docs
    from sellers s
    order by
      case s.tier when 'pending' then 0 when 'verified' then 1 else 2 end,
      s.joined_at desc
  `
  return c.json({ sellers: rows })
})

/* ---- 總覽 ----
   一次把要盯的數字撈齊。全部即時算，不存快取——這些查詢很輕，
   而存下來就要面對「什麼時候失效」的問題，不值得。 */
admin.get('/overview', async c => {
  const [r] = await sql`
    select
      (select count(*) from users)::int as users,
      (select count(*) from users where created_at > now() - interval '7 days')::int as users_7d,
      (select count(*) from sellers where tier = 'pending')::int as sellers_pending,
      (select count(*) from pools where status = 'open')::int as pools_open,
      (select count(*) from orders where status in ('escrowed','shipped','delivered'))::int as orders_open,
      (select count(*) from orders where status = 'disputed')::int as orders_disputed,
      (select coalesce(sum(price),0) from orders
        where status in ('escrowed','shipped','delivered','disputed'))::bigint as escrowed_points,
      (select coalesce(sum(delta),0) from points_ledger)::bigint as points_outstanding
  `
  return c.json({ overview: r })
})

/* ---- 爭議 ----
   需要人判的訂單。裁決本身走既有的 /v1/orders/:id/resolve（平台帳號限定）。 */
admin.get('/disputes', async c => {
  const rows = await sql`
    select id, card, price, deposit, buyer_id, buyer_name, seller_id, seller_name,
           disputed_at, dispute_reason, has_unboxing_video, tracking
    from orders where status = 'disputed' order by disputed_at asc
  `
  return c.json({ disputes: rows })
})

/* ---- 稽核 ---- */
admin.get('/actions', async c => {
  const rows = await sql`select * from admin_actions order by id desc limit 200`
  return c.json({ actions: rows })
})
