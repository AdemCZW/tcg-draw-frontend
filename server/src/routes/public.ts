/**
 * 公開的讀取端點：賣家、得獎動態、掛單。不用登入。
 * 賣家統計全部即時算，不存 —— 跟餘額同一個道理。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'

export const pub = new Hono()

/** 得主代號遮罩：VD-3F2A → VD-3F** */
const mask = (handle: string) => handle.replace(/^(VD-..).*$/, '$1**')

async function sellerView(id: string) {
  const [s] = await sql`select s.*, u.handle as user_handle from sellers s join users u on u.id = s.id where s.id = ${id}`
  if (!s) return null
  const [st] = await sql<{ pools_run: string; draws_settled: string; top_hits: string; top_advertised: string }[]>`
    select
      (select count(*) from pools where seller_id = ${id} and status in ('open','sold_out','revealed'))::text as pools_run,
      (select count(*) from draws d join pools p on p.id = d.pool_id where p.seller_id = ${id})::text as draws_settled,
      (select count(*) from prizes pz join pools p on p.id = pz.pool_id
         where p.seller_id = ${id} and pz.tier in ('A','LAST'))::text as top_hits,
      (select coalesce(sum(pp.total),0) from pool_prizes pp join pools p on p.id = pp.pool_id
         where p.seller_id = ${id} and pp.tier in ('A','LAST') and p.status in ('open','sold_out','revealed'))::text as top_advertised
  `
  const [ship] = await sql<{ shipped: string; disputes: string; orders: string }[]>`
    select
      (select count(*) from orders where seller_id = ${id} and status = 'completed')::text as shipped,
      (select count(*) from orders where seller_id = ${id} and closed_by in ('dispute-buyer','dispute-seller'))::text as disputes,
      (select count(*) from orders where seller_id = ${id} and status not in ('escrowed','shipped','delivered','disputed'))::text as orders
  `
  const past = await sql`
    select pz.card, pz.tier, p.title, pz.won_at, u.handle
    from prizes pz join pools p on p.id = pz.pool_id join users u on u.id = pz.user_id
    where p.seller_id = ${id} and pz.tier in ('A','LAST') order by pz.won_at desc limit 8
  `
  const [tot] = await sql<{ n: string }[]>`
    select coalesce(sum(total_tickets),0)::text as n from pools where seller_id = ${id} and status in ('open','sold_out','revealed')
  `
  const totalTickets = Number(tot?.n ?? 0)
  const drawsSettled = Number(st?.draws_settled ?? 0)
  const closedOrders = Number(ship?.orders ?? 0)
  return {
    id: s.id, handle: s.handle, name: s.name, tier: s.tier, origin: s.origin,
    avatarHue: parseInt(String(s.id).slice(-2), 16) % 360 || 200,
    joinedAt: String(s.joined_at).slice(0, 10), bio: s.bio,
    stats: {
      poolsRun: Number(st?.pools_run ?? 0),
      cardsShipped: Number(ship?.shipped ?? 0),
      avgShipDays: 0,
      disputeRate: closedOrders ? Math.round((Number(ship?.disputes) / closedOrders) * 1000) / 10 : 0,
      advertisedTopRate: totalTickets ? Math.round((Number(st?.top_advertised) / totalTickets) * 1000) / 10 : 0,
      actualTopRate: drawsSettled ? Math.round((Number(st?.top_hits) / drawsSettled) * 1000) / 10 : 0,
      drawsSettled
    },
    pastPrizes: past.map(r => ({
      cardName: (r.card as { name?: string }).name ?? '', artId: (r.card as { artId?: string }).artId,
      tier: r.tier, poolTitle: r.title, wonAt: new Date(Number(r.won_at)).toISOString().slice(0, 10),
      winner: mask(String(r.handle))
    }))
  }
}

pub.get('/sellers', async c => {
  const rows = await sql`select id from sellers order by joined_at`
  const out = []
  for (const r of rows) { const v = await sellerView(r.id as string); if (v) out.push(v) }
  return c.json({ sellers: out })
})
pub.get('/sellers/:id', async c => c.json({ seller: await sellerView(c.req.param('id') ?? '') }))

/** 最近的得獎動態，匿名化 */
pub.get('/winners', async c => {
  const rows = await sql`
    select u.handle, p.title, pz.tier, pz.card, pz.won_at
    from prizes pz join users u on u.id = pz.user_id join pools p on p.id = pz.pool_id
    where pz.tier in ('A','B','LAST') order by pz.won_at desc limit 20
  `
  return c.json({
    winners: rows.map(r => ({
      user: mask(String(r.handle)), poolTitle: r.title, tier: r.tier,
      cardName: (r.card as { name?: string }).name ?? '',
      at: new Date(Number(r.won_at)).toISOString().slice(0, 16).replace('T', ' ')
    }))
  })
})

/* ---- 上架：把名下的卡掛到市場 ---- */
const ListBody = z.object({ prizeId: z.string().min(1), price: z.number().int().positive() })
pub.post('/listings', requireAuth, async c => {
  const me = c.get('userId')
  const parsed = ListBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
  const { prizeId, price } = parsed.data
  const r = await sql.begin(async tx => {
    const [pz] = await tx`select * from prizes where id = ${prizeId} and user_id = ${me} for update`
    if (!pz) return { error: 'NOT_FOUND', message: '找不到這張卡', status: 404 }
    // 保管中 → 庫內轉移；已出貨到手上 → 需寄送。其他狀態不能上架
    const delivery = pz.status === 'stashed' ? 'vault' : pz.status === 'shipped' ? 'ship' : null
    if (!delivery) return { error: 'WRONG_STATE', message: '這張卡目前不能上架', status: 409 }
    const [u] = await tx`select name, handle from users where id = ${me}`
    const id = 'l-' + randomBytes(5).toString('hex')
    const card = pz.card as { certNo?: string | null }
    try {
      await tx`insert into listings (id, card, price, seller_id, seller_name, delivery, cert_no, prize_id)
               values (${id}, ${pz.card as never}, ${price}, ${me}, ${(u?.name as string) ?? (u?.handle as string) ?? '我'},
                       ${delivery}, ${card.certNo ?? null}, ${prizeId})`
    } catch {
      // listings_cert_live / listings_prize_live 唯一索引：同一張卡已經在賣
      return { error: 'WRONG_STATE', message: '這張卡已經在市場上了', status: 409 }
    }
    if (delivery === 'vault') await tx`update prizes set status = 'listed' where id = ${prizeId}`
    const [l] = await tx`select * from listings where id = ${id}`
    return { listing: l }
  })
  if ('error' in r) return c.json(r, r.status as 404 | 409)
  const l = r.listing!
  return c.json({ listing: {
    id: l.id, card: l.card, price: Number(l.price), sellerId: l.seller_id, sellerName: l.seller_name,
    delivery: l.delivery, status: l.status, listedAt: l.listed_at, prizeId: l.prize_id
  } })
})
