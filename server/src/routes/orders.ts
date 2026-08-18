/**
 * 訂單端點。一個端點對應 escrow.ts 的一個狀態轉換。
 *
 * 每個會改狀態的端點都做三件事，順序固定：
 *   1 zod 驗證 —— TypeScript 的型別在執行期不存在，邊界一定要真的擋
 *   2 交易內重讀並鎖定 —— 不能信任讀進來時的狀態，中間可能已經被改
 *   3 用 escrow.ts 判斷這個動作合不合法 —— 規則只有一份
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { walletOf } from '../money.js'
import { PLATFORM_ID, depositFor, save, settle, sweep, toOrder } from '../orders-service.js'
import { actionsFor, looksLikeTracking } from '../../../src/shared/escrow.js'
import type { Order } from '../../../src/shared/domain.js'

export const orders = new Hono()
orders.use('*', requireAuth)

const fail = (code: string, msg: string, status = 409) => ({ error: code, message: msg, status })

/** GET /orders —— 我的訂單 + 錢包 + 伺服器時間 */
orders.get('/', async c => {
  const me = c.get('userId')
  const body = await sql.begin(async tx => {
    await sweep(tx, me)
    const rows = await tx`
      select * from orders where buyer_id = ${me} or seller_id = ${me}
      order by created_at desc
    `
    return rows.map(r => toOrder(r as Record<string, unknown>))
  })
  return c.json({ orders: body, wallet: await walletOf(me), serverTime: Date.now() })
})

const CreateBody = z.object({
  listingId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128)
})

/**
 * POST /orders —— 買下掛單。
 *
 * 兩條通道在這裡分開：庫內轉移直接過戶（沒有訂單），需寄送才建立託管訂單。
 *
 * 整段包在一個交易裡，而且掛單那筆要 FOR UPDATE。
 * 少了這個鎖，兩個人同時買同一張卡會兩邊都通過檢查、兩邊都成立。
 */
orders.post('/', async c => {
  const me = c.get('userId')
  const parsed = CreateBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json(fail('BAD_REQUEST', '參數不合法', 400), 400)
  const { listingId, idempotencyKey } = parsed.data

  const result = await sql.begin(async tx => {
    // 重複送出：同一把 key 只會成立一次
    const [dup] = await tx`select order_id from idempotency where key = ${idempotencyKey}`
    if (dup) {
      const [row] = await tx`select * from orders where id = ${dup.order_id}`
      return { order: row ? toOrder(row as Record<string, unknown>) : null }
    }

    const [l] = await tx`select * from listings where id = ${listingId} for update`
    if (!l) return fail('LISTING_NOT_FOUND', '這筆掛單不存在')
    if (l.status !== 'live') return fail('LISTING_TAKEN', '這張卡剛剛被買走了')
    if (l.seller_id === me) return fail('WRONG_STATE', '不能買自己的掛單')

    const price = Number(l.price)
    const w = await walletOf(me, tx)
    if (w.available < price) return fail('INSUFFICIENT_POINTS', '可動用點數不足')

    await tx`update listings set status = 'sold' where id = ${listingId}`

    // 庫內轉移：原子交換，沒有中間狀態，直接記帳過戶
    if (l.delivery === 'vault') {
      await tx`insert into points_ledger (user_id, delta, reason) values (${me}, ${-price}, 'vault-buy')`
      await tx`insert into points_ledger (user_id, delta, reason) values (${l.seller_id}, ${price}, 'vault-sell')`
      return { order: null }
    }

    const done = await tx<{ count: string }[]>`
      select count(*)::text as count from orders where seller_id = ${l.seller_id} and status = 'completed'
    `
    const completedCount = Number(done[0]?.count ?? 0)
    const now = Date.now()
    const id = 'o-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    const [buyer] = await tx`select name from users where id = ${me}`

    const [row] = await tx`
      insert into orders (
        id, listing_id, card, price, deposit,
        buyer_id, buyer_name, seller_id, seller_name, status, created_at
      ) values (
        ${id}, ${listingId}, ${l.card as never}, ${price}, ${depositFor(price, completedCount)},
        ${me}, ${buyer?.name ?? '我'}, ${l.seller_id}, ${l.seller_name}, 'escrowed', ${now}
      ) returning *
    `
    await tx`insert into idempotency (key, user_id, order_id) values (${idempotencyKey}, ${me}, ${id})`
    return { order: toOrder(row as Record<string, unknown>) }
  })

  if ('error' in result) return c.json(result, result.status as 400 | 409)
  return c.json({ ...result, wallet: await walletOf(me) })
})

/** 共用：在交易裡把訂單鎖起來、確認角色與動作合法 */
async function act(
  meId: string, orderId: string, role: 'buyer' | 'seller' | 'platform',
  need: string, apply: (o: Order) => Order | { error: string; message: string; status: number }
) {
  return sql.begin(async tx => {
    const [row] = await tx`select * from orders where id = ${orderId} for update`
    if (!row) return fail('WRONG_STATE', '找不到這張訂單', 404)
    const o = toOrder(row as Record<string, unknown>)

    const isParty = role === 'platform' ? meId === PLATFORM_ID
      : role === 'buyer' ? o.buyerId === meId : o.sellerId === meId
    if (!isParty) return fail(role === 'platform' ? 'NOT_PLATFORM' : 'NOT_PARTY', '你不是這張訂單的當事人', 403)

    // 動作合不合法由 escrow.ts 判斷，不在這裡重寫一次規則
    if (!actionsFor(o, role).includes(need as never)) {
      return fail('WRONG_STATE', '訂單目前的狀態不允許這個動作')
    }

    const next = apply(o)
    if ('error' in next) return next
    await save(tx, next)
    await settle(tx, next)
    return { order: next }
  })
}

const ShipBody = z.object({
  tracking: z.string().min(8).max(24),
  photoUrls: z.array(z.string().url()).min(1, '出貨照至少一張，且需含可辨識的鑑定編號')
})

/** POST /orders/:id/ship —— 賣家出貨 */
orders.post('/:id/ship', async c => {
  const me = c.get('userId')
  const parsed = ShipBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json(fail('BAD_REQUEST', parsed.error.issues[0]?.message ?? '參數不合法', 400), 400)
  const { tracking } = parsed.data

  /* 這裡只驗格式。正式上線前必須改成真的打物流商 API：
     確認單號存在、交寄時間晚於訂單成立、而且沒被其他訂單用過。
     單號重複用會被 orders_tracking_uniq 唯一索引擋下，但那是最後一道，
     不是第一道。 */
  if (!looksLikeTracking(tracking)) {
    return c.json(fail('BAD_TRACKING', '單號格式不正確'), 409)
  }

  const r = await act(me, c.req.param('id'), 'seller', 'ship',
    o => ({ ...o, status: 'shipped', shippedAt: Date.now(), tracking }))
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
  return c.json({ ...r, wallet: await walletOf(me) })
})

/** POST /orders/:id/confirm —— 買家確認收貨，立即放款 */
orders.post('/:id/confirm', async c => {
  const me = c.get('userId')
  const r = await act(me, c.req.param('id'), 'buyer', 'confirm',
    o => ({ ...o, status: 'completed', settledAt: Date.now(), closedBy: 'buyer-confirm' }))
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
  return c.json({ ...r, wallet: await walletOf(me) })
})

const DisputeBody = z.object({
  reason: z.string().min(1).max(500),
  videoUrl: z.string().url('必須附完整未剪輯的開箱影片')
})

/** POST /orders/:id/dispute —— 買家開爭議，沒影片不受理 */
orders.post('/:id/dispute', async c => {
  const me = c.get('userId')
  const parsed = DisputeBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json(fail('NEED_VIDEO', '要申請退款必須附開箱影片', 400), 400)
  const { reason } = parsed.data

  const r = await act(me, c.req.param('id'), 'buyer', 'dispute',
    o => ({ ...o, status: 'disputed', disputedAt: Date.now(), disputeReason: reason, hasUnboxingVideo: true }))
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
  return c.json({ ...r, wallet: await walletOf(me) })
})

/**
 * POST /orders/:id/delivered —— 物流簽收。
 *
 * 這條之後會變成物流商的 webhook 落點，不是使用者按的按鈕。
 * 現在限定平台帳號呼叫，讓端到端測試跑得完整條流程。
 * 接上真的物流之後改成驗簽名，並拿掉平台帳號這條路。
 */
orders.post('/:id/delivered', async c => {
  const me = c.get('userId')
  if (me !== PLATFORM_ID) return c.json(fail('NOT_PLATFORM', '只有平台能回報簽收', 403), 403)
  const r = await sql.begin(async tx => {
    const [row] = await tx`select * from orders where id = ${c.req.param('id')} for update`
    if (!row) return fail('WRONG_STATE', '找不到這張訂單', 404)
    const o = toOrder(row as Record<string, unknown>)
    if (o.status !== 'shipped') return fail('WRONG_STATE', '這張訂單不在運送中')
    const next: Order = { ...o, status: 'delivered', deliveredAt: Date.now() }
    await save(tx, next)
    return { order: next }
  })
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
  return c.json(r)
})

const ResolveBody = z.object({ to: z.enum(['buyer', 'seller']), note: z.string().max(500).default('') })

/** POST /orders/:id/resolve —— 平台裁決。只有平台帳號能呼叫 */
orders.post('/:id/resolve', async c => {
  const me = c.get('userId')
  const parsed = ResolveBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json(fail('BAD_REQUEST', '參數不合法', 400), 400)
  const { to } = parsed.data

  const r = await act(me, c.req.param('id'), 'platform', to === 'buyer' ? 'resolve-buyer' : 'resolve-seller',
    o => ({
      ...o,
      status: to === 'buyer' ? 'refunded' : 'completed',
      settledAt: Date.now(),
      closedBy: to === 'buyer' ? 'dispute-buyer' : 'dispute-seller'
    }))
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
  return c.json(r)
})
