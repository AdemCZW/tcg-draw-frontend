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
import { markShipped } from '../pool-settlement.js'
import { credit, walletOf } from '../money.js'
import { notify } from '../notify.js'
import { act } from './orders.js'
import { PLATFORM_ID } from '../orders-service.js'

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
  /* 會員編號是客服查人的主要依據，所以要好查：
     打 VD-A3K7Q2、a3k7q2、甚至只記得後三碼都要找得到。
     ilike 已經不分大小寫，再把使用者可能省略的 VD- 前綴補掉。 */
  const bare = q.replace(/^vd-?/i, '')
  const rows = q
    ? await sql`select id, handle, member_no, name, email, role, created_at from users
                where member_no ilike ${'%' + bare + '%'}
                   or handle ilike ${'%' + q + '%'}
                   or name ilike ${'%' + q + '%'}
                   or email ilike ${'%' + q + '%'}
                order by created_at desc limit 50`
    : await sql`select id, handle, member_no, name, email, role, created_at from users order by created_at desc limit 50`
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
/* 注意 ::text：postgres.js 只把 int2/int4/oid/float 解析成 JS number
   （見 node_modules/postgres/src/types.js 的 from 清單，裡面沒有 int8），
   bigint 會原封不動變成字串。下面這個物件本來一半是 number 一半是字串，
   拿去做加總或格式化就會靜默出錯。統一用 ::text 撈、在 JS 這一側轉成數字，
   跟這個專案其他地方（walletOf、sellerView）的作法一致。 */
admin.get('/overview', async c => {
  const [r] = await sql<(Record<string, number> & { escrowed_points: string; points_outstanding: string })[]>`
    select
      (select count(*) from users)::int as users,
      (select count(*) from users where created_at > now() - interval '7 days')::int as users_7d,
      (select count(*) from sellers where tier = 'pending')::int as sellers_pending,
      (select count(*) from pools where status = 'open')::int as pools_open,
      (select count(*) from orders where status in ('escrowed','shipped','delivered'))::int as orders_open,
      (select count(*) from orders where status = 'disputed')::int as orders_disputed,
      (select count(*) from shipments where status = 'requested')::int as ship_requested,
      (select count(*) from shipments where status in ('packed','shipped'))::int as ship_active,
      (select coalesce(sum(price),0) from orders
        where status in ('escrowed','shipped','delivered','disputed'))::text as escrowed_points,
      (select coalesce(sum(delta),0) from points_ledger)::text as points_outstanding
  `
  return c.json({
    overview: {
      ...r,
      escrowed_points: Number(r?.escrowed_points ?? 0),
      points_outstanding: Number(r?.points_outstanding ?? 0)
    }
  })
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

/* ---- 爭議裁決 ----
   前端原本直接打 /v1/orders/:id/resolve，那個端點認的是寫死的 u-platform 帳號
   而不是 role='admin'：目前兩者剛好是同一個人，但多開一個管理員就會靜默 403。
   而且它不寫稽核 —— 這是會實際移動點數而且不可逆的動作，沒有紀錄不行。
   改走這裡：權限由 requireAdmin 認，動作仍交給 orders 的狀態機，額外補上稽核。 */
const Resolve = z.object({
  to: z.enum(['buyer', 'seller']),
  note: z.string().trim().min(4).max(200)
})
admin.post('/disputes/:id/resolve', async c => {
  const me = c.get('userId')
  const id = c.req.param('id') ?? ''
  const parsed = Resolve.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '要選裁決對象並填理由（至少 4 字）' }, 400)
  const { to, note } = parsed.data

  const r = await act(PLATFORM_ID, id, 'platform', to === 'buyer' ? 'resolve-buyer' : 'resolve-seller',
    o => ({
      ...o,
      status: to === 'buyer' ? 'refunded' as const : 'completed' as const,
      settledAt: Date.now(),
      closedBy: to === 'buyer' ? 'dispute-buyer' as const : 'dispute-seller' as const
    }))
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
  await audit(me, 'dispute-resolve', id, { to }, note)
  return c.json(r)
})

/* ---- 出貨 ----
   這條線原本是斷的：使用者送得出申請，但沒有任何端點能查詢或處理，
   申請進去就石沉大海。營運上這是最該先補的一塊。 */
admin.get('/shipments', async c => {
  const status = c.req.query('status')
  const rows = status
    ? await sql`select * from shipments where status = ${status} order by created_at asc`
    : await sql`select * from shipments order by
        case status when 'requested' then 0 when 'packed' then 1 when 'shipped' then 2 else 3 end,
        created_at asc limit 200`

  // 收件人與卡片內容一起帶出來，不用再點進去查
  const out = []
  for (const r of rows) {
    const [u] = await sql`select handle, name from users where id = ${r.user_id}`
    const prizes = await sql`select id, card, tier from prizes where id = any(${r.prize_ids})`
    out.push({
      id: r.id, userId: r.user_id, userHandle: u?.handle, userName: u?.name,
      address: r.address, status: r.status, tracking: r.tracking,
      createdAt: Number(r.created_at), shippedAt: r.shipped_at ? Number(r.shipped_at) : null,
      prizes: prizes.map(p => ({ id: p.id, name: (p.card as { name?: string }).name, tier: p.tier }))
    })
  }
  return c.json({ shipments: out })
})

const ShipStatus = z.object({
  status: z.enum(['packed', 'shipped', 'delivered']),
  tracking: z.string().trim().max(40).optional(),
  note: z.string().max(200).default('')
})
admin.post('/shipments/:id/status', async c => {
  const me = c.get('userId')
  const id = c.req.param('id') ?? ''
  const parsed = ShipStatus.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
  const { status, tracking, note } = parsed.data

  // 標成已寄出一定要有單號，否則使用者查不到貨在哪，客服也無從追起
  if (status === 'shipped' && !tracking) {
    return c.json({ error: 'BAD_REQUEST', message: '標記為已寄出時必須填物流單號' }, 400)
  }

  const r = await sql.begin(async tx => {
    const [sh] = await tx`select * from shipments where id = ${id} for update`
    if (!sh) return { error: 'NOT_FOUND', message: '找不到這筆出貨單', status: 404 }

    const order = ['requested', 'packed', 'shipped', 'delivered']
    if (order.indexOf(status) <= order.indexOf(sh.status as string)) {
      return { error: 'WRONG_STATE', message: `目前是「${sh.status}」，不能改回或重複設定`, status: 409 }
    }

    await tx`
      update shipments set status = ${status},
        tracking = ${tracking ?? sh.tracking},
        shipped_at = ${status === 'shipped' ? Date.now() : sh.shipped_at}
      where id = ${id}
    `
    /* 卡片離開保管庫後狀態要跟著走，之後上架只能走「需寄送」。
       'delivered' 也要做這件事：狀態只檢查不能往回走，所以
       requested → delivered 是合法的一步（客服拿到簽收回報時直接標完成，
       中間那步沒人按）。原本只有 'shipped' 這個分支會動 prizes，
       跳過去的話那些卡就永遠停在 'ship_requested' ——
       那個狀態上架不行（只收 stashed / shipped）、回收不行（只收 stashed）、
       私下交易也不行，等於使用者的卡被鎖死而且沒有任何端點救得回來。 */
    if (status === 'shipped' || status === 'delivered') {
      /* **只動還在申請出貨中的卡**（F-4）。
         原本這行沒有狀態守衛：賣家逾期未出貨、系統已經退款把卡標成
         'refunded' 之後，出貨佇列那張單還停在 'requested'。後台人員
         照著佇列按一下「已出貨」，那張退過款的卡就復活成 'shipped' ——
         買家退款照領，卡也回來了，還能再上架賣一次。那是免費印卡。
         'recycled'（買家已賣回給賣家）同理，卡已經不是他的了。 */
      await tx`
        update prizes set status = 'shipped'
         where id = any(${sh.prize_ids}) and status = 'ship_requested'
      `
      /* 抽卡池的結算也要跟著走。後台標出貨與賣家自己標出貨是同一件事實，
         只是誰按的不同 —— 少了這一行，走後台那條路的卡會出貨了卻永遠
         停在 awaiting_ship，鑑賞期不會開始，賣家的保留額永遠釋放不掉，
         而且 72 小時後還會被判成「逾期未出貨」記賣家一次違約。 */
      await markShipped(tx, sh.prize_ids as string[], Date.now())
      const shipped = status === 'shipped'
      await notify({
        userId: sh.user_id as string, kind: 'shipment',
        title: shipped ? '你的卡已經寄出' : '你的卡已送達',
        body: tracking ? `物流單號 ${tracking}` : shipped ? '出貨單已寄出。' : '出貨單已送達。',
        link: '/me/cards', refId: id
      }, tx)
    }
    return { ok: true }
  })
  if ('error' in r) return c.json(r, r.status as 404 | 409)
  await audit(me, 'shipment-status', id, { status, tracking }, note)
  return c.json(r)
})

/* ---- 單一會員的完整檔案 ----
   客服要處理一個人的問題時，需要一次看到全部：資料、餘額、卡、訂單、出貨。
   分散在不同分頁查等於每次都要記住上一頁看到什麼。 */
admin.get('/users/:id', async c => {
  const id = c.req.param('id') ?? ''
  const [u] = await sql`
    select id, handle, member_no, name, email, role, created_at,
           display_name, real_name, phone, address_zip, address_city, address_line1,
           to_char(birthday, 'YYYY-MM-DD') as birthday
    from users where id = ${id}
  `
  if (!u) return c.json({ error: 'NOT_FOUND', message: '找不到這個使用者' }, 404)

  const [ids, prizes, orders, shipments, ledger] = await Promise.all([
    sql`select provider from auth_identities where user_id = ${id}`,
    sql`select id, card, tier, status, won_at from prizes where user_id = ${id} order by won_at desc limit 50`,
    sql`select id, card, price, status, created_at, buyer_id, seller_id
        from orders where buyer_id = ${id} or seller_id = ${id} order by created_at desc limit 30`,
    sql`select id, status, tracking, created_at from shipments where user_id = ${id} order by created_at desc limit 20`,
    sql`select id, delta, reason, created_at from points_ledger where user_id = ${id} order by id desc limit 50`
  ])

  return c.json({
    user: u,
    providers: ids.map(r => r.provider),
    wallet: await walletOf(id),
    prizes, orders, shipments, ledger
  })
})

/* ---- 池 ----
   賣家開的池平台要看得到：有沒有奇怪的定價、獎品內容合不合理。 */
admin.get('/pools', async c => {
  const rows = await sql`
    select p.id, p.title, p.mode, p.status, p.ticket_price, p.total_tickets,
           p.created_at, p.opened_at, s.name as seller_name, s.tier as seller_tier,
           (select count(*) from pool_seats ps where ps.pool_id = p.id and ps.taken_by is not null)::int as sold
    from pools p join sellers s on s.id = p.seller_id
    order by p.created_at desc limit 100
  `
  return c.json({ pools: rows })
})

/* ---- 賣家驗證文件 ----
   目前還沒有送件的前端流程，但審核端點先備好，
   免得之後做了送件卻沒有地方審。 */
admin.get('/verifications', async c => {
  const rows = await sql`
    select v.id, v.seller_id, v.doc_file_id, v.status, v.note, v.created_at,
           s.name as seller_name, s.handle as seller_handle, s.tier
    from seller_verifications v join sellers s on s.id = v.seller_id
    order by case v.status when 'pending' then 0 else 1 end, v.created_at asc
    limit 100
  `
  return c.json({ verifications: rows })
})

const VerifyDoc = z.object({
  status: z.enum(['approved', 'rejected']),
  note: z.string().max(200).default('')
})
admin.post('/verifications/:id/review', async c => {
  const me = c.get('userId')
  const id = c.req.param('id') ?? ''
  const parsed = VerifyDoc.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
  const r = await sql`
    update seller_verifications set status = ${parsed.data.status}, note = ${parsed.data.note},
      reviewed_by = ${me}, reviewed_at = now()
    where id = ${id} and status = 'pending' returning seller_id
  `
  if (!r.length) return c.json({ error: 'WRONG_STATE', message: '這筆文件不存在或已審核過' }, 409)
  await audit(me, 'verification-review', id, { status: parsed.data.status }, parsed.data.note)
  return c.json({ ok: true })
})

/* ---- 稽核 ---- */
admin.get('/actions', async c => {
  const rows = await sql`select * from admin_actions order by id desc limit 200`
  return c.json({ actions: rows })
})

/**
 * 對帳：全站的點數有沒有憑空生出或消失。
 *
 * 這是抽卡結算那一整套設計唯一的驗收標準。點數只有三個發行來源
 * （儲值、平台發放、註冊禮），其餘每一筆移動都必須借貸成對 ——
 * 所以 SUM(points_ledger.delta) 必須恆等於發行總額。
 *
 * 對不上就代表有一筆分錄只有單邊。差額的方向講得出是哪一種病：
 *   總量 < 發行量  → 有點數被銷毀（抽卡只扣不貸，就是稽核的 C-2）
 *   總量 > 發行量  → 有點數被憑空創造（舊的平台回收，安全稽核的 C-2）
 *
 * ⚠️ 這支遷移（017）之前抽的卡，票金當初是真的被銷毀的，而且**不回填**
 * （回填等於現在才印一批鈔票）。所以在有舊資料的環境上，差額會停在一個
 * **不再增加**的常數 —— 會不會增加才是這支端點要看的東西，不是差額為 0。
 */
admin.get('/reconcile', async c => {
  const ISSUE = ['topup', 'seed', 'admin-grant', 'line-signup-bonus']
  const [r] = await sql<{ total: string; issued: string }[]>`
    select
      (select coalesce(sum(delta),0) from points_ledger)::text as total,
      (select coalesce(sum(delta),0) from points_ledger where reason = any(${ISSUE}))::text as issued
  `
  const byReason = await sql<{ reason: string; n: string; sum: string }[]>`
    select reason, count(*)::text as n, sum(delta)::text as sum
      from points_ledger group by reason order by reason
  `
  const total = Number(r?.total ?? 0)
  const issued = Number(r?.issued ?? 0)
  const [held] = await sql<{ sum: string }[]>`
    select coalesce(sum(amount),0)::text as sum from pool_settlements
     where status in ('held','awaiting_ship','shipped')
  `
  return c.json({
    total, issued,
    /* 0 = 完全對得上。非 0 一定要查得出來源，不要當成捨去誤差 ——
       這裡沒有任何一筆分錄是浮點數，捨去只發生在拆票金的時候，
       而那一步的餘數是刻意歸給賣家的（splitTicket），三方相加仍然是票價。 */
    drift: total - issued,
    reserved: Number(held?.sum ?? 0),
    byReason: byReason.map(x => ({ reason: x.reason, count: Number(x.n), sum: Number(x.sum) }))
  })
})
