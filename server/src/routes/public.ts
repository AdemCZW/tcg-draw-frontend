/**
 * 公開的讀取端點：賣家、得獎動態、掛單。不用登入。
 * 賣家統計全部即時算，不存 —— 跟餘額同一個道理。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { PageQuery, decodeCursor, encodeCursor, slicePage } from '../pagination.js'
import { POINTS_INPUT_MAX, pointsInputMaxText } from '../limits.js'
import { publicCard } from '../card-public.js'

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

/* =====================================================================
   市場掛單列表
   ===================================================================== */

/** 掛價相對市值的折數。市值填 0 或沒填時當成「不折不扣」，不要讓它變 NULL 排到天邊 */
const DEAL_RATIO = sql`coalesce(
  (price - nullif((card->>'refPrice')::numeric, 0)) / nullif((card->>'refPrice')::numeric, 0), 0)`

/**
 * 排序搬到後端。
 *
 * 跟卡冊的狀態分頁是同一個道理：列表分批載入之後，前端排序只排得到
 * 「已經載進來的那幾筆」。使用者選「價格低到高」看到的是這一頁裡最便宜的，
 * 再捲一頁又整個重排 —— 已經看過的卡片會在眼前跳來跳去。
 *
 * 每一種排序都要有自己的游標鍵，而且必須跟 order by 逐字對應：
 * 排序鍵與游標鍵只要有一邊不同，換頁時就會漏筆或重複。
 */
const SORTS = ['deal', 'new', 'cheap', 'pricey'] as const
type Sort = (typeof SORTS)[number]

const ListingQuery = PageQuery.extend({ sort: z.enum(SORTS).default('deal') })

/** 回傳 [order by 片段, 游標比較片段, 從一列取出游標值] 三件一組 */
function sortSpec(sort: Sort, after: [string, string] | null) {
  switch (sort) {
    case 'new':
      return {
        order: sql`order by listed_at desc, id desc`,
        where: after ? sql`and (listed_at, id) < (${after[0]}::timestamptz, ${after[1]}::text)` : sql``,
        key: (r: Row) => String(r.listed_at_text)
      }
    case 'cheap':
      return {
        order: sql`order by price asc, id asc`,
        where: after ? sql`and (price, id) > (${after[0]}::bigint, ${after[1]}::text)` : sql``,
        key: (r: Row) => String(r.price)
      }
    case 'pricey':
      return {
        order: sql`order by price desc, id desc`,
        where: after ? sql`and (price, id) < (${after[0]}::bigint, ${after[1]}::text)` : sql``,
        key: (r: Row) => String(r.price)
      }
    case 'deal':
      return {
        order: sql`order by ${DEAL_RATIO} asc, id asc`,
        where: after ? sql`and (${DEAL_RATIO}, id) > (${after[0]}::numeric, ${after[1]}::text)` : sql``,
        key: (r: Row) => String(r.deal_ratio)
      }
  }
}

type Row = {
  id: string; card: unknown; price: string; seller_id: string; seller_name: string
  delivery: string; status: string; listed_at: Date; prize_id: string | null
  /* listed_at 是 timestamptz（微秒精度），但 postgres.js 交給 JS 的是 Date，
     只有毫秒 —— 拿它組游標會把同一微秒內的相鄰列切錯邊，換頁時漏一筆。
     所以另外撈一份完整精度的字串專門給游標用。 */
  listed_at_text: string
  deal_ratio: string
}

/* card 一定要過 publicCard() 白名單再出去（L-2）。
   listings.card 是上架時從 prizes.card 原封搬來的 jsonb，裡面有 certNo ——
   市場列表不用登入、全站可見，整包直出等於把每張在售卡的鑑定編號
   免費送給任何人拿去搶註（一卡多賣防線正是綁在這個編號上）。
   防線本身不受影響：資料庫層的 cert_no 獨立欄位與 listings_cert_live
   唯一索引都還在，拿掉的只是**回應 JSON**裡的編號。
   買家成交後在自己的訂單裡看到編號是另一回事 —— 那是他買到的卡。 */
const toListing = (r: Row) => ({
  id: r.id, card: publicCard(r.card), price: Number(r.price),
  sellerId: r.seller_id, sellerName: r.seller_name,
  delivery: r.delivery, status: r.status, listedAt: r.listed_at, prizeId: r.prize_id
})

pub.get('/listings', async c => {
  const parsed = ListingQuery.safeParse(c.req.query())
  if (!parsed.success) {
    return c.json({ error: 'BAD_REQUEST', message: '分頁參數不合法（limit 介於 1 到 100）' }, 400)
  }
  const { limit, cursor, sort } = parsed.data

  let after: [string, string] | null = null
  if (cursor) {
    const p = decodeCursor(cursor, 2)
    if (!p) return c.json({ error: 'BAD_CURSOR', message: '分頁游標不合法' }, 400)
    after = [p[0]!, p[1]!]
  }
  const spec = sortSpec(sort, after)

  const rows = await sql<Row[]>`
    select *, listed_at::text as listed_at_text, ${DEAL_RATIO} as deal_ratio
    from listings where status = 'live' ${spec.where}
    ${spec.order}
    limit ${limit + 1}
  `
  const page = slicePage(rows, limit, r => encodeCursor([spec.key(r), r.id]))
  return c.json({ items: page.items.map(toListing), nextCursor: page.nextCursor })
})

/**
 * 市場首頁上方那兩條橫向捲軸（今日最殺、已鑑定）與總筆數。
 *
 * 它們講的是「整個市場裡最便宜／最貴的那幾張」，不是「這一頁裡的」——
 * 從已載入的清單挑會挑到假的第一名。取 top-N 是有界的查詢，跟分頁無關，
 * 所以獨立一支，前端只在第一次進頁時打一次。
 */
pub.get('/listings/highlights', async c => {
  const [deals, graded, total] = await Promise.all([
    sql<Row[]>`
      select *, listed_at::text as listed_at_text, ${DEAL_RATIO} as deal_ratio
      from listings where status = 'live' and ${DEAL_RATIO} <= -0.08
      order by ${DEAL_RATIO} asc, id asc limit 6
    `,
    sql<Row[]>`
      select *, listed_at::text as listed_at_text, ${DEAL_RATIO} as deal_ratio
      from listings where status = 'live' and cert_no is not null
      order by price desc, id desc limit 4
    `,
    sql<{ n: string }[]>`select count(*)::text as n from listings where status = 'live'`
  ])
  return c.json({
    deals: deals.map(toListing), graded: graded.map(toListing), total: Number(total[0]?.n ?? 0)
  })
})

/**
 * 單筆掛單。市場的卡片詳情頁靠這一支。
 *
 * 為什麼不從 /listings 撈回來自己挑：市場已經是游標分頁的，要的那一筆
 * 完全可能落在第五頁。而且分享連結、重新整理、直接輸入網址這三件事
 * 都拿不到列表頁的狀態，詳情頁必須自己有辦法把資料補齊。
 *
 * 註冊順序要在 /listings/highlights 之後 —— highlights 是靜態路徑，
 * 排在 :id 後面會被當成一個 id 吃掉。
 *
 * 已下架（delisted）的當成不存在：那是賣家收回的掛單，連結不該再打得開。
 * 已售出（sold）的仍然回傳，讓頁面能說「這張已經被買走了」，
 * 那比一句「不存在」誠實得多。
 */
pub.get('/listings/:id', async c => {
  const [row] = await sql<Row[]>`
    select *, listed_at::text as listed_at_text, ${DEAL_RATIO} as deal_ratio
    from listings where id = ${c.req.param('id') ?? ''} and status in ('live', 'sold')
  `
  if (!row) return c.json({ error: 'NOT_FOUND', message: '這筆掛單不存在或已下架' }, 404)
  return c.json({ listing: toListing(row) })
})

/* ---- 上架：把名下的卡掛到市場 ---- */
/* price 上界是荒謬值防線（L-1）：沒有它，1e308 這種值會一路通過
   int().positive()（JS 眼裡它是整數）撞進 bigint 欄位變成 22P02 → 500，
   把使用者的打字錯誤講成伺服器故障。取值理由見 limits.ts。 */
const ListBody = z.object({
  prizeId: z.string().min(1),
  price: z.number().int().positive().max(POINTS_INPUT_MAX, `價格不能超過 ${pointsInputMaxText()} 點`)
})
/**
 * 下架自己的掛單。
 *
 * 這條路原本不存在：上架之後只能等人買，賣家改變主意（想留著、想自己出貨、
 * 定價打錯）都沒有出路，而且卡會一直卡在 prizes.status = 'listed'，
 * 出貨與回收也一起被鎖住。
 *
 * 卡要放回上架前的狀態：庫內轉移的回 'stashed'、需寄送的回 'shipped'
 * （那就是它上架前的樣子，見上架時的 delivery 判斷）。
 */
pub.post('/listings/:id/delist', requireAuth, async c => {
  const me = c.get('userId')
  const id = c.req.param('id') ?? ''
  const r = await sql.begin(async tx => {
    const [l] = await tx`select * from listings where id = ${id} for update`
    if (!l) return { error: 'NOT_FOUND', message: '找不到這筆掛單', status: 404 }
    if (l.seller_id !== me) return { error: 'NOT_PARTY', message: '這不是你的掛單', status: 403 }
    if (l.status !== 'live') {
      return { error: 'WRONG_STATE', message: `這筆掛單目前是「${l.status}」，不能下架`, status: 409 }
    }
    await tx`update listings set status = 'delisted' where id = ${id}`
    if (l.prize_id) {
      const back = l.delivery === 'vault' ? 'stashed' : 'shipped'
      await tx`update prizes set status = ${back} where id = ${l.prize_id} and status = 'listed'`
    }
    return { ok: true }
  })
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
  return c.json(r)
})

pub.post('/listings', requireAuth, async c => {
  const me = c.get('userId')
  const parsed = ListBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    // 超出上界要把中文訊息帶出去，使用者才知道是自己多打了零，不是系統壞了
    const msg = parsed.error.issues.find(i => i.code === 'too_big')?.message ?? '參數不合法'
    return c.json({ error: 'BAD_REQUEST', message: msg }, 400)
  }
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
    } catch (e) {
      /* 依撞到的是哪一條索引分開講。
         原本這個 catch 把所有錯誤都說成「這張卡已經在市場上了」，
         而那句話對其中一種情況是假的：

         listings_cert_live 是 unique(cert_no) where status='live'，
         它擋的是「鑑定編號」不是「這一列卡」。同一個 pool_prizes 列如果
         total > 1 而 card 又帶了 certNo（種子資料的「全 PSA 10」池就是這樣，
         例如 flareonPSA 一個編號開 15 籤），那 15 位得主的卡在資料上
         共用同一個鑑定編號 —— 第一個人上架之後，其餘 14 個人上架都會被擋，
         而且被告知「這張卡已經在市場上了」。他們的卡根本沒上架過，
         照著這句話去市場也找不到自己的卡，等於一個無解又指錯方向的錯誤。

         真正的病灶在開池那一端（一個鑑定編號只對應一張實體卡，
         不該允許 certNo + total > 1），那要在 pools 的建池驗證補。
         這裡至少要說實話，並且不要把其他錯誤（連線斷、資料格式）
         一起冒充成 409 —— 那會把伺服器的問題講成使用者的問題。 */
      const pg = e as { code?: string; constraint_name?: string }
      if (pg.code !== '23505') throw e
      if (pg.constraint_name === 'listings_cert_live') {
        return {
          error: 'WRONG_STATE',
          message: '這個鑑定編號目前已經有一筆有效掛單，同一個編號同時只能上架一張',
          status: 409
        }
      }
      return { error: 'WRONG_STATE', message: '這張卡已經在市場上了', status: 409 }
    }
    /* 兩種交付方式都要把卡標成已上架。原本只有 vault 標 —— 需寄送的卡
       上架後 prizes.status 還是 'shipped'，而上面那個 delivery 判斷正好
       允許 'shipped' 上架，所以同一張卡可以一直重複上架。
       沒有鑑定編號的卡（RAW）連唯一索引都擋不住（cert 索引跳過 null），
       等於同一張實體卡同時賣給好幾個人。
       結案時由 orders-service.ts 的 releasePrize() 把 'listed' 收回去。 */
    await tx`update prizes set status = 'listed' where id = ${prizeId}`
    const [l] = await tx`select * from listings where id = ${id}`
    return { listing: l }
  })
  if ('error' in r) return c.json(r, r.status as 404 | 409)
  const l = r.listing!
  /* 這裡的回應只給賣家本人，但形狀跟公開列表同一份 —— 統一過白名單，
     省得前端拿到兩種 card、也省得之後有人把這個物件轉存到公開的地方。 */
  return c.json({ listing: {
    id: l.id, card: publicCard(l.card), price: Number(l.price), sellerId: l.seller_id, sellerName: l.seller_name,
    delivery: l.delivery, status: l.status, listedAt: l.listed_at, prizeId: l.prize_id
  } })
})
