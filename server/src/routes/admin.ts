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
import { notify, notifyMany } from '../notify.js'
import { act } from './orders.js'
import { PLATFORM_ID } from '../orders-service.js'
import type { Order } from '../shared/domain.js'
import { PageQuery, decodeCursor, encodeCursor, isNumeric, slicePage } from '../pagination.js'
import {
  LIVE_STATUSES, TICKET_KINDS, applyTakeover, certHolderOf, loadMessages, loadTicket,
  notifyOpener, ownsFiles, summaryCols, summaryJoin, toSummary
} from '../tickets.js'

export const admin = new Hono()
admin.use('*', requireAuth)

async function requireAdmin(c: Context, next: Next) {
  const [u] = await sql`select role from users where id = ${c.get('userId')}`
  if (u?.role !== 'admin') return c.json({ error: 'NOT_PLATFORM', message: '需要管理員權限' }, 403)
  await next()
}
admin.use('*', requireAdmin)

/**
 * 寫一筆稽核，並把那一列的 id 回傳。
 *
 * 回傳 id 是為了給通知當 refId 用。後台的動作跟系統自動觸發的不一樣：
 * 「把賣家調成 verified」可以合法地發生第二次（先降級、再升回來），
 * 所以 refId 不能綁實體（賣家 id）也不能綁狀態值（tier）—— 那兩種都會
 * 把第二次的通知靜默吃掉。admin_actions.id 是「這一次動作」本身，
 * 一次動作一則通知，重按就是另一列、另一則，語意剛好對上。
 */
async function audit(adminId: string, action: string, target: string | null, payload: unknown, note = '') {
  const [r] = await sql<{ id: string }[]>`
    insert into admin_actions (admin_id, action, target, payload, note)
    values (${adminId}, ${action}, ${target}, ${payload as never}, ${note})
    returning id
  `
  return String(r?.id ?? '')
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
  /* 錢憑空多出來一筆，而收到的人不在場。沒有這一則，他只能在某次打開
     錢包時發現數字不對，然後開一張客服單問「這是什麼」。

     **note 刻意不帶進 body**：那是發放的人寫給稽核看的內部字（「補償 #123」
     之類），不是寫給當事人的。要知道為什麼就去看點數明細或問客服。

     refId 綁發放編號 ref（同時也是 points_ledger 的 ref_id，靠 ledger_once
     擋重送）—— 一筆發放一則通知，跟帳本那一列一對一。
     用 notifyMany 走「失敗只記 log」那條：點數已經進帳了，通知寫不進去
     不該讓這支端點回錯誤，那會誘導發放的人再按一次。 */
  await notifyMany([{
    userId, kind: 'system',
    title: '平台發放了點數',
    body: `${points.toLocaleString('zh-TW')} 點已入帳，可以直接使用。明細看點數紀錄。`,
    link: '/me/wallet', refId: ref
  }])
  return c.json({ ok: true, ref, wallet: await walletOf(userId) })
})

/* ---- 賣家 ---- */
const Verify = z.object({ tier: z.enum(['pending', 'verified', 'trusted']), note: z.string().max(200).default('') })
admin.post('/sellers/:id/tier', async c => {
  const me = c.get('userId')
  const id = c.req.param('id') ?? ''
  const parsed = Verify.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
  /* 先讀舊值：等級沒真的變的時候不該發通知（客服重按一次、或批次把整批
     都設成 verified 時掃到已經是 verified 的那些）。這是純粹的通知判斷，
     跟資料無關，所以不必跟 UPDATE 綁在同一個交易裡。 */
  const [before] = await sql<{ tier: string | null }[]>`select tier from sellers where id = ${id}`
  const r = await sql`update sellers set tier = ${parsed.data.tier} where id = ${id} returning id`
  if (!r.length) return c.json({ error: 'NOT_FOUND', message: '找不到這個賣家' }, 404)
  const auditId = await audit(me, 'seller-tier', id, { tier: parsed.data.tier }, parsed.data.note)

  /* ── 賣家等級 = 他能不能開池 ──────────────────────────────────────
     routes/pools.ts 的第一道門就是 `if (s.tier === 'pending') → 403
     SELLER_PENDING`。也就是說這一行 UPDATE 直接決定了對方能不能做生意，
     而他完全不在場。原本這件事一則通知都沒有 —— 賣家送完件之後只能
     每天回來按一次「我的賣家狀態」看有沒有變。

     升級與降級都要發。降級尤其不能省：他下次開池會撞到一個沒有預警的
     403，而那時候他已經把卡準備好了。

     refId 綁 admin_actions.id（見 audit() 的說明）：等級可以來回改，
     綁賣家 id 或綁 tier 值都會讓第二次靜默消失。 */
  if (before && before.tier !== parsed.data.tier) {
    const t = parsed.data.tier
    await notifyMany([{
      userId: id, kind: 'system',
      title: t === 'pending' ? '你的賣家資格已改回待審核' : '賣家審核通過',
      body: t === 'pending'
        ? '在恢復之前不能開新池。已經開著的池不受影響，出貨義務也還在。'
        : t === 'trusted'
          ? '你已經是信任賣家，可以開池。'
          : '你的賣家等級是已驗證，現在可以開池了。',
      link: t === 'pending' ? '/support/new' : '/seller/new',
      refId: 'seller-tier:' + auditId
    }])
  }
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
/**
 * 裁決結果通知**雙方**。
 *
 * 這是全站少數「錢的歸屬由第三人單方面決定」的動作，而且不可逆：
 * 判給買家＝退款＋沒收賣家保證金，判給賣家＝貨款放行。兩個人都不在場，
 * 而在此之前這條路一則通知都沒有 —— 走工單那條至少會發一則「工單已處理」
 * 給開單人（通常是買家），賣家則是完全靜默：他的保證金被沒收了，
 * 只能在某次打開錢包時發現。
 *
 * refId 綁**訂單 id**：一張訂單只裁決得了一次（act() 的狀態機守衛 +
 * 工單那條的 `o.status === 'disputed'` 分支），所以是一次性的事實。
 * 兩條裁決入口（/disputes/:id/resolve 與工單結案）共用同一個 refId
 * 是刻意的 —— 就算兩邊先後跑到，當事人也只會收到一則。
 *
 * 失敗只記 log（notifyMany）：錢已經動完了，通知寫不進去不該讓端點回錯誤，
 * 那會誘導客服再裁一次。
 */
async function notifyDisputeResolved(o: Order, to: 'buyer' | 'seller') {
  const name = o.card?.name ?? '卡片'
  await notifyMany([
    {
      userId: o.buyerId, kind: 'order',
      title: to === 'buyer' ? '爭議判給你，貨款已退回' : '爭議裁決：貨款判給賣家',
      body: to === 'buyer'
        ? `「${name}」的 ${o.price.toLocaleString('zh-TW')} 點已解除凍結，回到你的可動用點數。`
        : `「${name}」的貨款已付給賣家。有疑問可以開客服單。`,
      link: '/me/orders', refId: 'dispute-resolved:' + o.id
    },
    {
      userId: o.sellerId, kind: 'order',
      title: to === 'seller' ? '爭議判給你，貨款已入帳' : '爭議判給買家，貨款已退回',
      body: to === 'seller'
        ? `「${name}」的 ${o.price.toLocaleString('zh-TW')} 點已入帳。`
        : `「${name}」的貨款退回買家，保證金 ${o.deposit.toLocaleString('zh-TW')} 點也一併沒收。`,
      link: '/seller/shipping', refId: 'dispute-resolved:' + o.id
    }
  ])
}

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
  await notifyDisputeResolved(r.order, to)
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
    /* ── 鎖序：prizes 先，shipments 後（V-1 的同一條紀律）────────────────
       這一支原本是 `shipments FOR UPDATE` → `update prizes`，而賣家自助出貨
       是 `prizes FOR UPDATE` → … → `update shipments`，方向相反。
       pool-settlement.ts 的檔頭把這條記成「理論上的極窄的環」，
       併發壓測（server/src/regress-race.ts 第 7b 組）把它壓出來了：
       一張出貨單裝三張同賣家的卡，同時發一個後台標出貨 + 三個賣家自助出貨，
       200 輪撞到 3 輪。Postgres 回 40P01，拋出點就是下面那行 update prizes，
       後台這一支變成沒有內容的 500（賣家那幾支照常 200）。
       資料不會壞 —— 事務整個回滾 —— 壞的是後台會莫名其妙失敗而且看不出原因。

       改成兩階段，跟 sweepSettlements 用的是同一個模式：
       先不上鎖讀出 prize_ids，照 id 排序鎖 prizes，再鎖 shipments 那一列。
       排序是必要的：`update ... where id = any(...)` 依掃描順序上鎖，
       兩個同時進來的請求就算拿的是同一組 id，順序也不保證一樣。

       先讀的那一筆只拿來知道「要鎖哪幾張卡」，狀態判斷一律用上鎖後重讀的
       那一筆 —— 這中間出貨單可能已經被別人推進到下一個狀態了。 */
    const [peek] = await tx`select prize_ids from shipments where id = ${id}`
    if (!peek) return { error: 'NOT_FOUND', message: '找不到這筆出貨單', status: 404 }
    const pids = [...(peek.prize_ids as string[])].sort()
    if (pids.length) await tx`select id from prizes where id = any(${pids}) order by id for update`

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
        /* refId 要帶狀態。原本只帶出貨單 id —— 而 notifications_once 是
           unique(user_id, kind, ref_id)，同一張單先「已寄出」再「已送達」
           時，第二則會被 `on conflict do nothing` 靜默吃掉：使用者永遠
           收不到送達通知，而且從外面完全看不出來（那支端點照樣回 ok）。
           一張單的兩個里程碑是兩件事，refId 就該是兩個。 */
        link: '/me/cards', refId: `${id}:${status}`
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

/**
 * 送件的賣家：你的證件審過了／被退回了。
 *
 * ── 為什麼一定要有 ────────────────────────────────────────────────
 * 這件事有兩個入口（這支端點，以及 seller-doc 工單結案），兩邊都只改
 * seller_verifications 那一列就結束。賣家送完件之後**沒有任何訊號**：
 * 他只能自己一直回來打開 /v1/seller/me 看 verification.status 有沒有變。
 * 被退回的更糟 —— 他看到的是「還在審」，實際上已經沒有人會再看那份文件。
 *
 * ── 為什麼措辭是「證件」不是「可以開池了」──────────────────────────
 * 通過這一份文件**不會**動 sellers.tier，而開池的門檻讀的是 tier
 * （routes/pools.ts 的 SELLER_PENDING）。寫成「現在可以開池了」對一半的
 * 賣家是假的：他點進去照樣 403。能不能開池由 /sellers/:id/tier 那一步
 * 決定，那一步有它自己的通知。這裡只講這一份文件的結果。
 *
 * refId 綁**這一份 verification 的 id**：一份文件只會被審一次
 * （兩個入口的 UPDATE 都帶 `status = 'pending'` 守衛），所以這是
 * 「知道了就好」的一次性事實，比照 pools-service 的寄存提醒綁 prize id。
 * 兩個入口共用同一個 refId 是刻意的 —— 就算兩邊都跑到也只會有一則。
 */
async function notifyVerification(
  sellerId: string, verificationId: string, status: 'approved' | 'rejected', note: string
) {
  const reason = note.trim()
  await notifyMany([{
    userId: sellerId, kind: 'system',
    title: status === 'approved' ? '賣家證件審核通過' : '賣家證件沒有通過',
    body: status === 'approved'
      ? '你送出的證明文件已經通過。開池權限由平台在審核後開通，開通時會再通知你。'
      : (reason ? `原因：${reason}。` : '') + '可以重新送件，或開客服單詢問。',
    link: '/seller/new', refId: 'seller-verify:' + verificationId
  }])
}

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
  await notifyVerification(String(r[0]!.seller_id), id, parsed.data.status, parsed.data.note)
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

/* ==================================================================
   客服工單
   ------------------------------------------------------------------
   商業邏輯在 src/tickets.ts，使用者端在 routes/tickets.ts。

   **結案要順帶做的事一律呼叫既有的那套**，不在這裡重寫：
     order-dispute → 上面那個 act(PLATFORM_ID, …) 的呼叫（同一個檔案，
                     兩段互相看得見，改一邊時另一邊在同一個畫面上）
     seller-doc    → seller_verifications 那一句 UPDATE
   工單自己的 status 只記「處理完了沒有」，不是任何裁決結果的權威狀態。
   把 tickets 兩張表 drop 掉，錢跟權限都還是對的。

   既有的 /disputes 與 /verifications 兩條端點刻意保留不動：它們是驗過的，
   而且工單這一層萬一有問題還有退路（合約第五節）。
   ================================================================== */

const TicketQuery = PageQuery.extend({
  status: z.enum(['open', 'pending-user', 'resolved', 'rejected']).optional(),
  kind: z.enum(TICKET_KINDS).optional()
})

/**
 * 佇列。預設回待處理的（open + pending-user），**舊的排前面**。
 *
 * 先進先出不是美觀問題：照 updated_at 或新的排前面的話，一張沒有人想碰的
 * 難單會被每一張新單擠下去，永遠等不到人 —— 而那正是最需要人處理的那一張。
 * （024 的 tickets_queue 索引就是照 (status, created_at) 建的。）
 */
admin.get('/tickets', async c => {
  const parsed = TicketQuery.safeParse(c.req.query())
  if (!parsed.success) {
    return c.json({ error: 'BAD_REQUEST', message: '查詢參數不合法（limit 介於 1 到 100）' }, 400)
  }
  const { limit, cursor, status, kind } = parsed.data

  let after: [string, string] | null = null
  if (cursor) {
    const p = decodeCursor(cursor, 2)
    if (!p || !isNumeric(p[0]!)) return c.json({ error: 'BAD_CURSOR', message: '分頁游標不合法' }, 400)
    after = [p[0]!, p[1]!]
  }

  const rows = await sql`
    select t.*, coalesce(u.name, u.handle) as user_name, u.member_no as user_member_no,
           coalesce(a.name, a.handle) as assignee_name,
           ${summaryCols(sql)}
      from tickets t
      join users u on u.id = t.user_id
      left join users a on a.id = t.assignee_id
      ${summaryJoin(sql)}
     where ${status ? sql`t.status = ${status}` : sql`t.status = any(${[...LIVE_STATUSES]})`}
       ${kind ? sql`and t.kind = ${kind}` : sql``}
       ${after ? sql`and (t.created_at, t.id) > (${after[0]}::bigint, ${after[1]}::text)` : sql``}
     order by t.created_at asc, t.id asc
     limit ${limit + 1}
  `
  const page = slicePage(rows, limit, r => encodeCursor([String(r.created_at), String(r.id)]))
  return c.json({
    items: page.items.map(r => ({
      ...toSummary(r as Record<string, unknown>, 'staff'),
      userName: String(r.user_name ?? ''),
      /* 會員編號可能是空的（種子帳號沒發過），照樣回一個字串而不是 null ——
         前端拿到 null 會印出 'null'，而客服要的是「這格空著」。 */
      userMemberNo: String(r.user_member_no ?? ''),
      assigneeId: r.assignee_id == null ? null : String(r.assignee_id),
      assigneeName: r.assignee_name == null ? null : String(r.assignee_name)
    })),
    nextCursor: page.nextCursor
  })
})

/** 一張單。**含 certHolder** —— 接管單要看得到那個編號目前登記在誰名下。
    使用者端那條刻意不回這一塊（那是別人的身分）。 */
admin.get('/tickets/:id', async c => {
  const t = await loadTicket(c.req.param('id') ?? '', 'staff')
  if (!t) return c.json({ error: 'NOT_FOUND', message: '找不到這張工單' }, 404)
  const certHolder = t.row.kind === 'takeover'
    ? await certHolderOf(t.row.grader as string | null, t.row.cert_no as string | null)
    : null
  return c.json({ ticket: { ...t.detail, certHolder } })
})

/** 認領。不做指派流程，只是讓兩個客服不會同時處理同一張單 */
admin.post('/tickets/:id/claim', async c => {
  const me = c.get('userId')
  const id = c.req.param('id') ?? ''
  /* 用「assignee_id is null」當守衛而不是先讀再寫：兩個客服同時按的話
     只有一個 UPDATE 會命中，另一個看到的已經不是 null（同一個手法見
     pools-service.ts 抽籤那段的 status = 'in_pool' 守衛）。 */
  const done = await sql`
    update tickets set assignee_id = ${me}, updated_at = ${Date.now()}
     where id = ${id} and assignee_id is null
     returning id
  `
  if (!done.length) {
    const [t] = await sql`select assignee_id from tickets where id = ${id}`
    if (!t) return c.json({ error: 'NOT_FOUND', message: '找不到這張工單' }, 404)
    // 自己認領過就不是錯誤，重按一次不該噴紅
    if (String(t.assignee_id) === me) return c.json({ ok: true, assigneeId: me })
    const [u] = await sql`select coalesce(name, handle) as name from users where id = ${t.assignee_id}`
    return c.json({
      error: 'ALREADY_CLAIMED',
      message: `這張單已經由 ${String(u?.name ?? '其他客服')} 認領了。`
    }, 409)
  }
  await audit(me, 'ticket-claim', id, {}, '')
  return c.json({ ok: true, assigneeId: me })
})

const StaffReply = z.object({
  body: z.string().trim().min(1, '請輸入內容').max(2000, '每則訊息最多 2000 個字'),
  fileIds: z.array(z.string().regex(/^f-[0-9a-f]{12}$/, '附件必須是站內上傳的檔案')).max(5).default([])
})

/** 客服回覆。is_staff = true，而且把狀態推成 pending-user（球在使用者那邊） */
admin.post('/tickets/:id/messages', async c => {
  const me = c.get('userId')
  const id = c.req.param('id') ?? ''
  const parsed = StaffReply.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? '參數不合法' }, 400)
  }
  const { body, fileIds } = parsed.data

  // 附件驗持有人與用途，跟使用者端同一條規則（客服自己的 ticket-doc 檔案）
  if (!(await ownsFiles(fileIds, me))) {
    return c.json({ error: 'BAD_ATTACHMENT', message: '附件必須是你自己在站內上傳的工單附件' }, 400)
  }

  const r = await sql.begin(async tx => {
    const [t] = await tx`select * from tickets where id = ${id} for update`
    if (!t) return { error: 'NOT_FOUND', message: '找不到這張工單', status: 404 }
    if (t.status === 'resolved' || t.status === 'rejected') {
      return { error: 'TICKET_CLOSED', message: '這張工單已經結案，不能再回覆', status: 409 }
    }
    const now = Date.now()
    const [m] = await tx`
      insert into ticket_messages (ticket_id, author_id, body, file_ids, is_staff, created_at)
      values (${id}, ${me}, ${body}, ${fileIds as never}, true, ${now})
      returning id
    `
    await tx`update tickets set status = 'pending-user', updated_at = ${now} where id = ${id}`
    return { messageId: Number(m?.id ?? 0), userId: String(t.user_id) }
  })
  if ('error' in r) return c.json(r, r.status as 404 | 409)

  await notifyOpener(r.userId, id, 'msg:' + r.messageId,
    '客服回覆了你的工單', body.slice(0, 80))
  const messages = await loadMessages(id)
  return c.json({ message: messages[messages.length - 1] })
})

const TicketResolve = z.object({
  outcome: z.enum(['resolved', 'rejected']),
  /* 理由必填。024 的欄位註解寫得很直接：沒有理由的裁決事後無法覆核，
     而這張表裡的每一筆都是有人被拒絕或被通過的紀錄。 */
  resolution: z.string().trim().min(1, '結案一定要填理由').max(500, '結案理由最多 500 個字'),
  /** order-dispute 專用：點數要判給誰。其餘 kind 忽略 */
  disputeTo: z.enum(['buyer', 'seller']).optional()
})

/**
 * 結案。**這裡是整個設計的關鍵。**
 *
 * outcome = 'resolved' 時依 kind 順帶呼叫既有的邏輯；'rejected' 一律只結案。
 * 順序刻意是「先做既有的那套、再結案」：工單不是權威狀態，
 * 既有那套失敗時整張單要留在佇列上讓人再按一次，
 * 反過來（先結案再動錢）失敗的話錢沒動而單子看起來處理完了 —— 那沒有人會發現。
 */
admin.post('/tickets/:id/resolve', async c => {
  const me = c.get('userId')
  const id = c.req.param('id') ?? ''
  const parsed = TicketResolve.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? '參數不合法' }, 400)
  }
  const { outcome, resolution, disputeTo } = parsed.data

  const t = await loadTicket(id, 'staff')
  if (!t) return c.json({ error: 'NOT_FOUND', message: '找不到這張工單' }, 404)
  const row = t.row
  if (row.status === 'resolved' || row.status === 'rejected') {
    return c.json({ error: 'TICKET_CLOSED', message: '這張工單已經結案過了' }, 409)
  }
  const kind = String(row.kind)
  // 稽核要看得出「除了結案還做了什麼」，所以副作用的結果一起寫進 payload
  const effect: Record<string, unknown> = {}

  if (outcome === 'resolved') {
    if (kind === 'takeover') {
      const certNo = row.cert_no == null ? null : String(row.cert_no)
      if (!certNo) {
        return c.json({ error: 'BAD_REQUEST', message: '這張接管單沒有鑑定編號，無法過戶' }, 400)
      }
      const r = await sql.begin(tx =>
        applyTakeover(tx, row.grader == null ? null : String(row.grader), certNo, String(row.user_id)))
      if ('error' in r) return c.json(r, r.status as 400 | 409)
      effect.takeover = r
      // prize_id 補記下來：事後覆核時要看得出當時動的是哪一列，不用再靠編號反查
      await sql`update tickets set prize_id = ${r.prizeId} where id = ${id}`

      /* ── 通知**失去這張卡的那個人** ──────────────────────────────────
         接管是站內唯一「一張卡從甲的卡冊消失、出現在乙的卡冊」的動作，
         而它由客服單方面執行 —— 甲不是開單人，工單那則
         「你的工單已經處理完成」跟他無關，他不會收到任何東西。
         下一次打開卡冊少一張卡，而且沒有任何紀錄告訴他發生過什麼。

         changed = false 時不發：那是「卡本來就已經在申請人名下」
         （客服重按一次），沒有人失去任何東西。
         from === 申請人 也不發：那是同一個人。

         refId 綁**工單 id**：一張接管單只會過戶一次（過完就結案），
         所以這是一次性的事實；綁卡片 id 的話同一張卡日後再被接管一次
         （合法：可以再轉手）就會被靜默吃掉。 */
      if (r.changed && r.fromUserId !== String(row.user_id)) {
        await notifyMany([{
          userId: r.fromUserId, kind: 'system',
          title: '一張卡已從你的卡冊轉出',
          body: '有人以站外轉手接管了這個鑑定編號的卡。如果你認為有誤，請立刻開客服單。',
          link: '/support/new', refId: 'takeover-out:' + id
        }])
      }

    } else if (kind === 'order-dispute') {
      if (!disputeTo) {
        return c.json({
          error: 'BAD_REQUEST',
          message: '訂單爭議結案要指定 disputeTo（判給 buyer 或 seller）'
        }, 400)
      }
      const orderId = String(row.order_id ?? '')
      const [o] = await sql`select status from orders where id = ${orderId}`
      if (!o) return c.json({ error: 'NOT_FOUND', message: '找不到這張單對應的訂單' }, 404)

      if (o.status === 'disputed') {
        /* **呼叫既有的那套**：跟上面 /disputes/:id/resolve 走同一個 act()、
           同一個 escrow.ts 的狀態機、同一組帳本分錄。工單這一層一毛錢都沒碰。 */
        const r = await act(PLATFORM_ID, orderId, 'platform',
          disputeTo === 'buyer' ? 'resolve-buyer' : 'resolve-seller',
          o2 => ({
            ...o2,
            status: disputeTo === 'buyer' ? 'refunded' as const : 'completed' as const,
            settledAt: Date.now(),
            closedBy: disputeTo === 'buyer' ? 'dispute-buyer' as const : 'dispute-seller' as const
          }))
        if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
        effect.dispute = { to: disputeTo, orderStatus: r.order.status }
        /* 跟 /disputes/:id/resolve 走同一個通知（同一個 refId），
           理由跟「同一個 act()」一樣：這是同一件事，不該有兩套說法。 */
        await notifyDisputeResolved(r.order, disputeTo)
      } else {
        /* 訂單已經不在 disputed：有人先用既有的 /v1/admin/disputes/:id/resolve
           裁決過了（那條刻意保留著當退路），或是這一支上次跑到一半掛了。
           兩種情況都**不能再動一次錢** —— 這裡只把工單關掉，把「錢是誰的」
           留給 orders 那邊已經寫下的事實。 */
        effect.dispute = { to: disputeTo, skipped: true, orderStatus: String(o.status) }
      }

    } else if (kind === 'seller-doc') {
      /* 呼叫既有的審核邏輯：跟 /verifications/:id/review 同一句 UPDATE。
         沒有待審的列時**不擋下來** —— 客服可能已經從既有的審核頁按過了，
         那時再回 409 會讓這張單永遠關不掉（一條死路，不是保護）。 */
      const done = await sql`
        update seller_verifications set status = 'approved', note = ${resolution.slice(0, 200)},
          reviewed_by = ${me}, reviewed_at = now()
        where id = (select id from seller_verifications
                     where seller_id = ${String(row.seller_id ?? '')} and status = 'pending'
                     order by created_at asc limit 1)
        returning id
      `
      effect.verification = { updated: done.length > 0 }
      /* 只有真的改到那一列才通知。沒改到＝客服早就從審核頁按過了，
         那一則已經發過（refId 兩邊共用同一份 verification id）。 */
      if (done.length) {
        await notifyVerification(String(row.seller_id ?? ''), String(done[0]!.id), 'approved', resolution)
      }
    }
    /* 其餘 kind（card-issue / account / other）只結案，不做別的 ——
       它們本來就沒有對應的既有邏輯可以呼叫。 */
  } else if (kind === 'seller-doc') {
    /* **駁回一張賣家審核單 = 駁回那份審核。**
       合約原本寫「rejected 一律只結案」，但對 seller-doc 那是語意錯誤：
       客服按下駁回的意思就是「這份證件不行」，只關工單不動審核的話，
       seller_verifications 那一列永遠停在 pending —— 賣家看到的是
       「還在審」，實際上已經被拒絕了，而且沒有人會再看它。
       跟通過那條一樣呼叫既有的 UPDATE、一樣不擋「沒有待審的列」。
       其他 kind 的 rejected 仍然只結案：接管駁回不該動卡、
       爭議駁回不該動錢（要判就得走 resolved + disputeTo）。 */
    const done = await sql`
      update seller_verifications set status = 'rejected', note = ${resolution.slice(0, 200)},
        reviewed_by = ${me}, reviewed_at = now()
      where id = (select id from seller_verifications
                   where seller_id = ${String(row.seller_id ?? '')} and status = 'pending'
                   order by created_at asc limit 1)
      returning id
    `
    effect.verification = { updated: done.length > 0, rejected: true }
    /* 駁回這一側更需要通知：工單那則只說「沒有受理」，賣家不會知道
       那句話同時也把他的證件審核判掉了。 */
    if (done.length) {
      await notifyVerification(String(row.seller_id ?? ''), String(done[0]!.id), 'rejected', resolution)
    }
  }

  const now = Date.now()
  const closed = await sql.begin(async tx => {
    /* 條件帶上「還沒結案」：兩個客服同時按的話只有一個會命中，
       另一個拿到 0 列 —— 而副作用那一段已經各自擋過一次（爭議會撞
       WRONG_STATE、接管會看到卡已經在申請人名下）。 */
    const r = await tx`
      update tickets set status = ${outcome}, resolution = ${resolution},
             closed_at = ${now}, closed_by = ${me}, updated_at = ${now}
       where id = ${id} and status = any(${[...LIVE_STATUSES]})
       returning id
    `
    if (!r.length) return false
    /* 結案理由同時寫成一則客服訊息：只寫進 tickets.resolution 的話，
       使用者在訊息串上看到的最後一句還是他自己問的問題，
       整段對話讀起來像沒有下文。 */
    await tx`
      insert into ticket_messages (ticket_id, author_id, body, file_ids, is_staff, created_at)
      values (${id}, ${me},
              ${(outcome === 'resolved' ? '【已處理】' : '【未受理】') + resolution},
              ${[] as never}, true, ${now})
    `
    return true
  })
  if (!closed) return c.json({ error: 'TICKET_CLOSED', message: '這張工單剛剛已經被結案了' }, 409)

  await audit(me, 'ticket-resolve', id, { kind, outcome, ...effect }, resolution)
  await notifyOpener(String(row.user_id), id, 'closed',
    outcome === 'resolved' ? '你的工單已經處理完成' : '你的工單沒有受理',
    resolution.slice(0, 80))

  const after = await loadTicket(id, 'staff')
  return c.json({ ticket: after?.detail, effect })
})
