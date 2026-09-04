/**
 * 公開的讀取端點：賣家、得獎動態、掛單。不用登入。
 * 賣家統計全部即時算，不存 —— 跟餘額同一個道理。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { MAX_LIMIT, PageQuery, decodeCursor, encodeCursor, slicePage } from '../pagination.js'
import { POINTS_INPUT_MAX, pointsInputMaxText } from '../limits.js'
import { publicCard } from '../card-public.js'
import { walletOf } from '../money.js'
import { depositFor } from '../shared/escrow.js'

export const pub = new Hono()

/** 得主代號遮罩：VD-3F2A → VD-3F** */
const mask = (handle: string) => handle.replace(/^(VD-..).*$/, '$1**')

/* =====================================================================
   賣家列表（A-3）
   ===================================================================== */

/**
 * 一位賣家的公開檢視。
 *
 * ── 為什麼統計是「一次查一批」而不是「一位一位查」（A-3）──────────────
 *
 * 改之前 `/v1/sellers` 是先撈全部賣家 id，再對每一位 `await sellerView()`，
 * 而每一位又跑五條統計查詢 —— 而且是**循序**的，不是並行的。
 * 本機實測（loopback、無網路延遲）：5 位 26 條／3.8ms，50 位 251 條／29ms，
 * 200 位 1001 條／205ms，完全是 5N+1 的直線。正式環境每條查詢多 1–2ms 的
 * 往返，200 位就是一兩秒，而且那一兩秒裡連線池被這一個請求佔著 ——
 * 慢的不只是它自己，是同時間所有人的請求。
 *
 * 所以統計改成「給一批 id，回一批結果」：查詢條數與賣家數脫鉤（固定 4 條），
 * 而且四條互不相依，用 Promise.all 一起送。
 *
 * ── 為什麼單筆那條路也走這裡 ────────────────────────────────────────
 * `/v1/sellers/:id`（賣家頁）呼叫的是同一支，只是陣列裡只有一個 id。
 * 不另寫一份的理由是**兩份實作會分岔**：統計的定義（哪些池算數、
 * 爭議率的分母是什麼）只要有一邊改了，列表跟賣家頁就會給出不同的數字，
 * 而那種不一致沒有任何測試會抓到，只有使用者會發現。
 *
 * 批次化沒有拖累單筆：`= any(array[一個 id])` 走的索引跟 `= id` 一樣，
 * 而且原本那五條是循序 await，現在是四條並行 —— 單筆反而變快（實測見下）。
 */

/** 池／獎品／抽卡側的統計。一條查詢拿完，避免對同一組池重複掃描 */
type PoolAgg = {
  seller_id: string; pools_run: string; total_tickets: string
  top_advertised: string; draws_settled: string; top_hits: string
}
type OrderAgg = { seller_id: string; shipped: string; disputes: string; orders: string }
type PastRow = { seller_id: string; card: unknown; tier: string; title: string; won_at: string; handle: string }

/** 「算得進統計」的池狀態。草稿與取消的池不該讓賣家的數字變好看，也不該變難看 */
const LIVE_POOL = sql`p.status in ('open','sold_out','revealed')`

async function sellerViews(ids: string[]) {
  const out = new Map<string, ReturnType<typeof compose>>()
  if (!ids.length) return out

  /* 四條查詢彼此不相依，一起送。
     `= any(${ids}::text[])` 的 ::text[] 是明寫的：不寫的話 postgres.js 也送得出去，
     但參數型別留給 describe 階段去推斷正是這支路由的 new 排序游標踩過的坑
     （見 sortSpec 的註解），這裡不重蹈覆轍。 */
  const [rows, pools, orders, past] = await Promise.all([
    /* join users 不是為了取欄位（handle 用的是 sellers 自己那份），
       是為了保留改前的過濾語意：沒有對應 users 列的賣家不出現。 */
    sql`select s.* from sellers s join users u on u.id = s.id where s.id = any(${ids}::text[])`,

    /* 池側五個數字一次算完。
       lateral 裡三個相關子查詢各自走 pool_id 索引（035 補上 prizes 那條），
       比起「四條各自 join 一次 pools」少掃三遍池表。
       filter (where ...) 讓「只算上線過的池」與「所有池」兩種分母共存於同一次掃描：
       draws_settled / top_hits 的分母是**全部**的池（改前就是如此，
       它們算的是已經發生的事實，不因為池後來被取消而消失）。 */
    sql<PoolAgg[]>`
      select p.seller_id,
             count(*) filter (where ${LIVE_POOL})::text                         as pools_run,
             coalesce(sum(p.total_tickets) filter (where ${LIVE_POOL}), 0)::text as total_tickets,
             coalesce(sum(x.adv) filter (where ${LIVE_POOL}), 0)::text           as top_advertised,
             coalesce(sum(x.draws), 0)::text                                     as draws_settled,
             coalesce(sum(x.hits), 0)::text                                      as top_hits
      from pools p
      left join lateral (
        select (select coalesce(sum(pp.total), 0) from pool_prizes pp
                 where pp.pool_id = p.id and pp.tier in ('A','LAST'))  as adv,
               (select count(*) from draws d where d.pool_id = p.id)   as draws,
               (select count(*) from prizes pz
                 where pz.pool_id = p.id and pz.tier in ('A','LAST'))  as hits
      ) x on true
      where p.seller_id = any(${ids}::text[])
      group by p.seller_id
    `,

    sql<OrderAgg[]>`
      select seller_id,
             count(*) filter (where status = 'completed')::text                            as shipped,
             count(*) filter (where closed_by in ('dispute-buyer','dispute-seller'))::text as disputes,
             count(*) filter (where status not in ('escrowed','shipped','delivered','disputed'))::text as orders
      from orders where seller_id = any(${ids}::text[])
      group by seller_id
    `,

    /* 每位賣家最近 8 筆大獎。
       改前是「一位賣家一條 limit 8」；批次版用 row_number() 在同一次掃描裡
       各自取前 8。**partition by 一定要是 p.seller_id**——這裡正是批次聚合
       最容易出錯的地方：少了它就變成「全體最近 8 筆」，第一位賣家看起來很威風，
       其餘的人整欄空白。regress-sellers.ts 逐位比對就是為了守住這一點。

       排序多帶一個 pz.id desc：改前只有 `order by won_at desc`，同一毫秒的
       兩筆誰在前是未定義的，換一次查詢就可能換一個順序。加上主鍵當第二鍵
       不改變任何「哪 8 筆」的答案，只是讓答案穩定、可比對。 */
    sql<PastRow[]>`
      select seller_id, card, tier, title, won_at, handle from (
        select p.seller_id, pz.card, pz.tier, p.title, pz.won_at, u.handle,
               row_number() over (partition by p.seller_id order by pz.won_at desc, pz.id desc) as rn
        from prizes pz
        join pools p on p.id = pz.pool_id
        join users u on u.id = pz.user_id
        where p.seller_id = any(${ids}::text[]) and pz.tier in ('A','LAST')
      ) t where rn <= 8 order by seller_id, rn
    `
  ])

  const poolBy = new Map(pools.map(r => [r.seller_id, r]))
  const orderBy = new Map(orders.map(r => [r.seller_id, r]))
  const pastBy = new Map<string, PastRow[]>()
  for (const r of past) {
    const list = pastBy.get(r.seller_id)
    if (list) list.push(r); else pastBy.set(r.seller_id, [r])
  }

  for (const s of rows) {
    const id = String(s.id)
    out.set(id, compose(s, poolBy.get(id), orderBy.get(id), pastBy.get(id) ?? []))
  }
  return out
}

/** 把四份原料組成回應。這裡刻意不碰資料庫 —— 算式與查詢分開才驗得動 */
function compose(
  s: Record<string, unknown>, st: PoolAgg | undefined, ship: OrderAgg | undefined, past: PastRow[]
) {
  const totalTickets = Number(st?.total_tickets ?? 0)
  const drawsSettled = Number(st?.draws_settled ?? 0)
  const closedOrders = Number(ship?.orders ?? 0)
  return {
    id: s.id, handle: s.handle, name: s.name, tier: s.tier, origin: s.origin,
    avatarHue: parseInt(String(s.id).slice(-2), 16) % 360 || 200,
    /* toISOString 不是 String()：postgres.js 給的是 Date，String(date) 是
       「Fri Sep 04 2026 …」那種預設字串，切前十碼會得到 "Fri Sep 04" ——
       不但不是日期格式，**連年份都沒有**，前端再怎麼解析也救不回來。 */
    joinedAt: new Date(s.joined_at as string | number | Date).toISOString().slice(0, 10), bio: s.bio,
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

async function sellerView(id: string) {
  return (await sellerViews([id])).get(id) ?? null
}

/**
 * 賣家列表的分頁。
 *
 * ── 預設 20、上限 100 ──
 * 上限沿用 pagination.ts 的 MAX_LIMIT（市場、卡冊都是同一條線），
 * 只把預設從 24 調成 20 —— A-3 指定的數字，而且賣家卡片比掛單高，
 * 一頁 20 張在 393px 上就是一屏半。
 *
 * ── 為什麼是游標不是 offset ──
 * 理由跟市場同一條（見 pagination.ts 開頭）：賣家是往後加的，
 * 排序鍵是 joined_at 遞增。多帶一個 id 當第二鍵是必要的 ——
 * 改前是 `order by joined_at`，同一微秒進來的兩位賣家順序未定義，
 * 拿它當游標邊界會漏人或重複。
 *
 * ── 這是公開端點 ──
 * 沒有登入，參數要當成完全不可信：limit 超出範圍回 400 不截斷、
 * 畸形游標回 400 不是 500。跟 /v1/listings 逐字同一套，不另發明一組。
 */
const SELLERS_LIMIT_DEFAULT = 20

const SellersQuery = PageQuery.extend({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(SELLERS_LIMIT_DEFAULT)
})

pub.get('/sellers', async c => {
  const parsed = SellersQuery.safeParse(c.req.query())
  if (!parsed.success) {
    return c.json({ error: 'BAD_REQUEST', message: `分頁參數不合法（limit 介於 1 到 ${MAX_LIMIT}）` }, 400)
  }
  const { limit, cursor } = parsed.data

  let after: [string, string] | null = null
  if (cursor) {
    const p = decodeCursor(cursor, 2)
    if (!p) return c.json({ error: 'BAD_CURSOR', message: '分頁游標不合法' }, 400)
    after = [p[0]!, p[1]!]
    /* 時間戳那一段先自己驗一次：`不是時間`::timestamptz 在資料庫端會拋 22007，
       Hono 把它翻成 500 —— 使用者改壞一個游標不該被講成伺服器故障。 */
    if (!/^\d{4}-\d\d-\d\d[ T]/.test(after[0])) {
      return c.json({ error: 'BAD_CURSOR', message: '分頁游標不合法' }, 400)
    }
  }

  /* joined_at 是 timestamptz（微秒），postgres.js 交給 JS 的 Date 只有毫秒 ——
     拿 Date 組游標會把同一毫秒的相鄰兩位切錯邊。撈一份全精度字串專門給游標用，
     回程再 ::text::timestamptz 原封送回去（理由同市場的 listed_at_text）。 */
  const rows = await sql<{ id: string; joined_at_text: string }[]>`
    select id, joined_at::text as joined_at_text from sellers
    where true ${after ? sql`and (joined_at, id) > (${after[0]}::text::timestamptz, ${after[1]}::text)` : sql``}
    order by joined_at asc, id asc
    limit ${limit + 1}
  `
  const page = slicePage(rows, limit, r => encodeCursor([r.joined_at_text, r.id]))
  const views = await sellerViews(page.items.map(r => r.id))

  /* 回應鍵仍然叫 sellers（不是 items）：前端 stores/sellers.ts 讀的是 `r.sellers`，
     改名就是當場把賣家膠囊弄不見。nextCursor 是新增欄位，舊前端讀不到它，
     行為等同「只拿第一頁」——降級而不是壞掉。 */
  return c.json({
    sellers: page.items.map(r => views.get(r.id)).filter(Boolean),
    nextCursor: page.nextCursor
  })
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

/**
 * 搜尋關鍵字。
 *
 * ── 為什麼一定要在後端 ──
 *
 * 排序在後端的理由（上面那段）對搜尋只會更強烈。列表是游標分頁的，前端過濾
 * 只濾得到已經載進來的那一批：使用者搜「伊布」看到 2 筆，而市場上其實有 15 筆，
 * 另外 13 筆躺在第 2、3 批還沒載。排序做錯只是順序怪，搜尋做錯是**答錯**，
 * 而且錯得毫無徵兆 —— 畫面上就是「只有 2 筆」，看不出少了什麼。
 * 卡冊的狀態過濾已經踩過一次同一個坑（見 MyCardsPage.vue 的註解）。
 *
 * ── 上界 ──
 *
 * 80 個字。前端的輸入框已經有 maxlength，正常打字碰不到這條線；
 * 它擋的是手動組網址塞進來的長字串，不讓它一路走進資料庫做無謂的掃描。
 * 超過就回 400 而不是默默截斷 —— 截斷之後的關鍵字比較短，會命中**更多**筆，
 * 那是在使用者不知情的狀況下回答另一個問題。
 */
const Q_MAX = 80

/**
 * 卡片等級的篩選維度。
 *
 * ── 為什麼是「鑑定公司 ＋ 分數下限」兩格，不是「PSA 10 / PSA 9.5 / …」一長串 ──
 *
 * 卡片上的等級其實是兩個欄位：`grader`（PSA / BGS / ARS / RAW）與 `grade`
 * （10、9.5、9…）。**PSA 10 與 BGS 10 不是同一件事**，所以不能只留分數；
 * 但把兩者相乘列成選項（4 家 × 10 級 = 40 個）在 393px 上是災難，
 * 而且實際資料極度稀疏（本機種子資料只有 PSA 10 與 RAW 兩種組合），
 * 使用者會看到 38 個永遠 0 筆的選項。
 *
 * 拆成兩格之後，「PSA 且 ≥10」還是表達得出 PSA 10，「BGS 且 ≥10」是另一件事，
 * 兩者不會被混為一談；而「不分家、≥9.5」這種真實需求（想要高分卡、不在乎哪一家）
 * 用一長串逐級選項反而表達不出來。
 *
 * ── RAW 是一個類別，不是「沒有值」 ──
 *
 * 裸卡是市場上最常見的一類，而且是兩種相反意圖的目標：想撿便宜的人專挑它，
 * 只要鑑定過的人要排除它。所以 `raw` 與 `graded` 都是明確的選項，
 * 不是「沒有選鑑定公司」的副作用。
 *
 * 判斷寫成 coalesce(upper(btrim(grader)), 'RAW') = 'RAW'：
 * 卡片是 jsonb 而且建池端是 passthrough 收進來的，實務上「未鑑定」有三種寫法
 * ——「RAW」、空字串、整個鍵不存在。三種都是同一件事，
 * 只比對 `= 'RAW'` 會把後兩種漏成「不屬於任何類別」，
 * 那正是「把 RAW 當成 null」的那個錯誤。
 *
 * ── 為什麼不用 tier（賞別） ──
 *
 * 賞別是「這張卡在某個池裡被當成第幾賞」，是**池的屬性不是卡的屬性**：
 * 同一張卡在別的池是別的賞。拿它當卡片等級會給出隨池而異的答案。
 */
const GRADER_FILTERS = ['raw', 'graded', 'psa', 'bgs', 'ars'] as const
type GraderFilter = (typeof GRADER_FILTERS)[number]

/** 未鑑定的三種寫法（'RAW' / 空字串 / 沒有這個鍵）收斂成同一個值 */
const GRADER_NORM = sql`coalesce(upper(nullif(btrim(card->>'grader'), '')), 'RAW')`

/**
 * 分數要當數字比，但 card 是 passthrough 的 jsonb —— 裡面的 grade 完全可能是
 * `"很棒"` 或 `""`。直接 `(card->>'grade')::numeric` 碰到那種列會回 22P02，
 * Hono 把它翻成 500：**一筆髒資料就讓整個市場的篩選變成伺服器故障**。
 * 先用正規表示式確認它長得像數字，不像的當成「沒有分數」（NULL），
 * NULL >= 9 是 unknown，那一列自然落在結果外，不會炸也不會被誤收。
 */
const GRADE_NUM = sql`(case when card->>'grade' ~ '^[0-9]+(\.[0-9]+)?$'
                            then (card->>'grade')::numeric end)`

/**
 * 空字串當成「沒有給這個參數」。
 *
 * 網址上留著一個空的 `?minPrice=` 是真的會發生的（分享連結、前端清掉輸入框、
 * 使用者手動刪值），而 z.coerce.number() 會把 '' 變成 0 —— 那會撞上
 * `.positive()` 回 400，對使用者來說是「我什麼都沒填卻被說參數錯」。
 * 沒填就是沒填，不是 0。
 */
const emptyToUndef = (v: unknown) => (v === '' || v === undefined || v === null ? undefined : v)

/**
 * 點數區間的兩個端點。
 *
 * 驗證要跟站上既有的八個金額欄位一樣嚴（見 limits.ts）：負數、0、小數、
 * `1e308`、`1e999`、`MAX_SAFE+1`、上界 +1 全部 400 而且訊息是中文可讀的。
 * 少了 `.max()` 的話 1e308 會一路撞進 bigint 的比較變成 22P02 → 500，
 * 把使用者多打的幾個零講成伺服器故障 —— 那正是 limits.ts 存在的理由。
 * `.int()` 順便擋掉小數與 Infinity（Number.isInteger(Infinity) 是 false）。
 */
const PriceParam = z.preprocess(
  emptyToUndef,
  z.coerce.number().int().positive().max(POINTS_INPUT_MAX).optional()
)

const ListingQuery = PageQuery.extend({
  sort: z.enum(SORTS).default('deal'),
  q: z.string().trim().max(Q_MAX).optional(),
  grader: z.preprocess(emptyToUndef, z.enum(GRADER_FILTERS).optional()),
  /* 只有下限沒有上限：「9.5 分以上」是真實需求，「9.5 分以下」不是 ——
     沒有人在找比較差的卡。多一個上限等於多一個永遠不會被用到的輸入框。 */
  minGrade: z.preprocess(emptyToUndef, z.coerce.number().min(1).max(10).optional()),
  minPrice: PriceParam,
  maxPrice: PriceParam
}).superRefine((v, ctx) => {
  /* 矛盾組合要當場說清楚，不要回一個「剛好 0 筆」的空清單 ——
     空清單長得跟「市場上真的沒有這種卡」一模一樣，使用者會去找不存在的卡，
     而不是去修自己的輸入。 */
  if (v.minPrice !== undefined && v.maxPrice !== undefined && v.minPrice > v.maxPrice) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['range'], message: 'min > max' })
  }
  if (v.grader === 'raw' && v.minGrade !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rawGrade'], message: 'raw + grade' })
  }
})

/**
 * 關鍵字的正規化。**跟 migration 031 的 search_text 是同一條規則**，
 * 兩邊只要有一邊改了就會開始搜不到東西，改動請一起改。
 *
 * 放在 SQL 裡而不是在 JS 先算好，就是為了讓它跟欄位定義用同一套實作：
 * JS 的 \s 與 Postgres 的 \s、JS 的 toLowerCase 與 Postgres 的 lower()
 * 在邊角情形上並不完全一致，兩份實作遲早會分岔。
 *
 * `${q}::text` 的 ::text 是明寫的保險：讓 Postgres 在 describe 階段就把 $1 判成
 * text，postgres.js 才會把字串原封送出去。不寫也剛好能跑（normalize 的參數本來
 * 就是 text），但同一支路由的 new 排序游標正是栽在「讓型別自己被推斷出來」上
 * （見 sortSpec 裡那段），這裡不重蹈覆轍。
 */
const normQ = (q: string) => sql`regexp_replace(lower(normalize(${q}::text, NFKC)), '\\s+', '', 'g')`

/**
 * 比對用 strpos()（子字串位置）而不是 LIKE。
 *
 * 關鍵字是使用者原封不動打進來的字串，而 LIKE 會把 `%` 和 `_` 當成萬用字元：
 * 搜「100%」會變成「100 開頭的任何東西」，搜「_」會命中全部。要用 LIKE 就得
 * 自己逃脫 `\ % _`，而那個逃脫必須發生在 NFKC **之後** —— 全形的「％」(U+FF05)
 * 正規化之後會變成半形 `%`，先逃脫再正規化等於沒逃脫。
 * strpos 沒有任何萬用字元，這一整類問題不存在。
 *
 * 代價是 B-tree 索引用不上；為什麼現在不需要索引、之後怎麼辦，見 031 的說明。
 */
/**
 * 關鍵字 ＋ 等級 ＋ 點數區間，全部收在同一個 where 片段。
 *
 * 這一整包都是「過濾」：它只讓候選集合變小，不碰排序鍵也不碰游標比較，
 * 所以四種排序、關鍵字、三個篩選維度天生可以任意組合，不必為誰另開一條路。
 *
 * **而且它一定要在這裡（資料庫），不能在前端。** 市場是游標分頁的：
 * 前端只濾得到已經載進來的那 24 筆。實測造 48 筆掛單、符合條件的有 15 筆而
 * 第一批裡只有 2 筆 —— 前端過濾會回答「2」。價格區間尤其危險，因為
 * 「2」看起來完全合理，沒有任何跡象顯示它是錯的。同一個坑卡冊的狀態分頁
 * 與市場搜尋已經各踩過一次。
 */
type Filters = {
  q: string
  grader?: GraderFilter
  minGrade?: number
  minPrice?: number
  maxPrice?: number
}

function listingWhere(f: Filters) {
  let w = sql``
  if (f.q) w = sql`${w} and strpos(search_text, ${normQ(f.q)}) > 0`
  if (f.grader === 'raw') w = sql`${w} and ${GRADER_NORM} = 'RAW'`
  else if (f.grader === 'graded') w = sql`${w} and ${GRADER_NORM} <> 'RAW'`
  else if (f.grader) w = sql`${w} and ${GRADER_NORM} = ${f.grader.toUpperCase()}`
  /* ::text::numeric 而不是 ::numeric：跟同一支路由的 new 排序游標同一個理由 ——
     讓 Postgres 在 describe 階段把參數判成 numeric，postgres.js 就會拿它自己的
     numeric 序列化器去處理這個值；先轉 text 則是把字串原封送過去由 Postgres 轉。
     9.5 這種值在這條路上不會有任何轉手損失。 */
  if (f.minGrade !== undefined) w = sql`${w} and ${GRADE_NUM} >= ${String(f.minGrade)}::text::numeric`
  if (f.minPrice !== undefined) w = sql`${w} and price >= ${f.minPrice}::bigint`
  if (f.maxPrice !== undefined) w = sql`${w} and price <= ${f.maxPrice}::bigint`
  return w
}

/** 有沒有任何一個條件在作用。決定要不要多算一次總筆數，也決定畫面上要不要收起精選區 */
const anyFilter = (f: Filters) =>
  !!f.q || !!f.grader || f.minGrade !== undefined || f.minPrice !== undefined || f.maxPrice !== undefined

/** 回傳 [order by 片段, 游標比較片段, 從一列取出游標值] 三件一組 */
function sortSpec(sort: Sort, after: [string, string] | null) {
  switch (sort) {
    case 'new':
      return {
        order: sql`order by listed_at desc, id desc`,
        /* ${...}::text::timestamptz 的中間那一段 ::text 不是多餘的。
           寫成 ${after[0]}::timestamptz 時，Postgres 在 describe 階段會把 $1 的型別
           判成 timestamptz(1184)，postgres.js 於是拿它的 timestamptz 序列化器去處理
           這個字串 —— 而那條路會先變成 JS 的 Date，**毫秒以下全部丟掉**。
           上面 listed_at_text 那段註解特地撈全精度字串來組游標，就是為了不丟微秒；
           少了這個 ::text，精度在回程又被丟一次，前功盡棄。

           後果不是抽象的：游標值被截到毫秒之後，
           (listed_at, id) < (被截短的值, id) 會把「跟分頁邊界同一毫秒」的掛單
           全部排除掉 —— 那幾筆不是排到後面，是**永遠不會出現**。
           實測（48 筆同一個 now() 的掛單）第二頁直接回 0 筆。
           先轉 text 就讓 $1 的型別是 text(25)，字串原封送到資料庫，由 Postgres 自己轉。 */
        where: after ? sql`and (listed_at, id) < (${after[0]}::text::timestamptz, ${after[1]}::text)` : sql``,
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
    /* 每一個參數各講各的：這些錯誤的下一步完全不同（改網址／少打幾個字／
       把最低價改小），混成同一句「參數不合法」等於要使用者自己猜是哪一格。
       金額那兩格的訊息要帶出上界的中文寫法 —— 使用者多打了三個零時，
       他需要看到的是「上限是十億」，不是「不合法」。 */
    const MSG: Record<string, string> = {
      q: `搜尋字數上限 ${Q_MAX} 個字`,
      grader: '卡片等級不合法（可用 raw / graded / psa / bgs / ars）',
      minGrade: '分數下限要是 1 到 10 之間的數字',
      minPrice: `最低點數要是 1 到 ${pointsInputMaxText()} 之間的整數`,
      maxPrice: `最高點數要是 1 到 ${pointsInputMaxText()} 之間的整數`,
      range: '最低點數不能高於最高點數',
      rawGrade: '未鑑定的卡沒有鑑定分數，不能同時指定分數下限'
    }
    const hit = parsed.error.issues.map(i => MSG[String(i.path[0] ?? '')]).find(Boolean)
    return c.json({
      error: 'BAD_REQUEST',
      message: hit ?? '分頁參數不合法（limit 介於 1 到 100）'
    }, 400)
  }
  const { limit, cursor, sort } = parsed.data
  /* zod 已經 trim 過，這裡再一次是為了讓「只有空白」明確等於「沒有搜尋」。
     全形空白 U+3000 也在 JS 的 trim 範圍內。 */
  const q = (parsed.data.q ?? '').trim()

  let after: [string, string] | null = null
  if (cursor) {
    const p = decodeCursor(cursor, 2)
    if (!p) return c.json({ error: 'BAD_CURSOR', message: '分頁游標不合法' }, 400)
    after = [p[0]!, p[1]!]
  }
  const spec = sortSpec(sort, after)
  /* 過濾與排序是兩件互不相干的事：同一組排序鍵、同一組游標比較，
     只是候選集合變小。所以關鍵字、三個篩選維度與四種排序天生可以並存，
     不必為任何一種組合另開一條路。 */
  const filters: Filters = {
    q,
    grader: parsed.data.grader,
    minGrade: parsed.data.minGrade,
    minPrice: parsed.data.minPrice,
    maxPrice: parsed.data.maxPrice
  }
  const where = listingWhere(filters)

  const rows = await sql<Row[]>`
    select *, listed_at::text as listed_at_text, ${DEAL_RATIO} as deal_ratio
    from listings where status = 'live' ${where} ${spec.where}
    ${spec.order}
    limit ${limit + 1}
  `
  const page = slicePage(rows, limit, r => encodeCursor([spec.key(r), r.id]))

  /* 有條件在作用時多回一個總筆數，而且**只在第一頁算**。
     為什麼要有它：查無結果與「這一批剛好沒有」在畫面上長得一樣，使用者需要
     一個能相信的數字。而它必須是整個市場的數字 —— 從已載入的清單數出來的
     「2 筆」正是這個功能要避免的那個錯誤答案。
     為什麼只在第一頁：捲動時每一批都算一次是白花的，數字也不會變。
     為什麼不只在搜尋時算：篩選跟搜尋一樣會把清單縮到看不出全貌，
     「PSA 10 有幾件」跟「伊布有幾件」是同一種問題。 */
  let total: number | undefined
  if (anyFilter(filters) && !cursor) {
    const [n] = await sql<{ n: string }[]>`
      select count(*)::text as n from listings where status = 'live' ${where}
    `
    total = Number(n?.n ?? 0)
  }
  return c.json({ items: page.items.map(toListing), nextCursor: page.nextCursor, total })
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
 * 卡要放回**上架前的那個狀態**，而且是照著上架時抄下來的值放回去
 * （listings.previous_status，migration 032），不是從 delivery 反推。
 *
 * ── 為什麼不能反推（A-5）──────────────────────────────────────────
 * delivery 只有 vault / ship 兩個值，而可上架的狀態有三個：
 * stashed → vault，shipped 與 in_book 都 → ship。ship 這一格是多對一，
 * 反推時只能挑一個，原本挑的是 'shipped'，於是每一張 in_book 的卡
 * 上架再下架就變成 shipped。而建池只收 in_book（pools.ts 的押記重用分支），
 * 所以那張卡明明還在使用者手上，卻永遠不能再開池，而且全程沒有錯誤訊息。
 * 反推法沒有「修對」這個選項：只要 ship 對應到一個以上的來源狀態，
 * 挑哪一個都會錯掉另一種，而且之後每多一種可上架的狀態就多錯一種。
 */
/**
 * 允許被還原的狀態白名單。
 *
 * previous_status 是上架時抄下來的，理論上只會是上架端允許的那三個值之一；
 * 但它是一個可以被舊資料、回填、或之後某次手動修資料寫進任何字串的欄位，
 * 而這一行的下游是 prizes.status —— 寫進一個沒人認得的值會讓那張卡
 * 從所有清單裡消失（每一支查詢都是列舉狀態的），比原本的 bug 更難查。
 * 不在白名單裡就當作沒有這個資訊，退回下面那條保守的老路。
 */
const RESTORABLE = new Set(['stashed', 'shipped', 'in_book'])
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
      /* 舊掛單（032 之前上架、而且回填也證明不了它上架前是什麼）沒有
         previous_status，只能退回原本的 delivery 反推。這條路**已知會在
         ship 上猜錯**，留著只是因為對那幾列沒有更好的資訊了；
         猜 'shipped' 而不是 'in_book' 是刻意的保守方向：猜成 in_book 會讓
         一張可能真的已經寄出去的卡被拿去開池，那比不能開池嚴重得多。 */
      const prev = typeof l.previous_status === 'string' ? l.previous_status : null
      const back = prev && RESTORABLE.has(prev)
        ? prev
        : (l.delivery === 'vault' ? 'stashed' : 'shipped')
      /* `and status = 'listed'` 不能拿掉：那是「這張卡確實是被這筆掛單鎖住的」
         的證明。少了它，一筆早就該死掉的掛單被下架時，會把卡從它現在真正的
         狀態（可能已經在別的池裡、或在出貨流程中）硬拉回上架前的樣子。 */
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
    /* 保管中 → 庫內轉移（實體還在開池賣家那，成交只是改登記）；
       已出貨到手上、或在卡冊閒置（in_book：接管來的／池結束解押回來的）
       → 需寄送 —— 這兩種的實體都在持有人自己手上，賣掉就得自己寄，
       走託管訂單。其他狀態不能上架。
       in_book 不給 vault：vault 的出貨申請走池結算那條路，而 in_book 的卡
       沒有（或不再有）活著的結算列，買家會拿到一張永遠出不了貨的卡。 */
    const delivery = pz.status === 'stashed' ? 'vault'
      : pz.status === 'shipped' || pz.status === 'in_book' ? 'ship' : null
    if (!delivery) return { error: 'WRONG_STATE', message: '這張卡目前不能上架', status: 409 }
    /* ── 需寄送的卡：先看賣家付不付得出保證金 ────────────────────────
       成交時 routes/orders.ts 會要求賣家有足額的可動用點數當押品，
       付不出來的話買家會被擋在建單那一步。那道才是防線（餘額會變，
       只驗上架擋不住「上架時有錢、成交時沒錢」）；這裡這一道純粹是
       **提前告知**：讓賣家在自己的上架流程裡就看到金額與差額，
       而不是把卡掛上去、等到有人來買才在對方的畫面上失敗。

       刻意不呼叫 lockSpender：這裡不承諾任何錢，鎖了也保證不了之後
       還在。而且上架這條路已經先鎖了 prizes 那一列，再去鎖 users 會
       跟建單那條路（先鎖 users 再改 prizes）形成相反的取得順序，
       換來一個真的會發生的死結，只為了一個本來就不保證的檢查。

       用 depositFor 與 orders.ts 同一個公式、用 walletOf 同一個口徑，
       不另外發明一套算法 —— 兩邊算出不同的數字比不檢查更難懂。 */
    if (delivery === 'ship') {
      const [done] = await tx<{ count: string }[]>`
        select count(*)::text as count from orders where seller_id = ${me} and status = 'completed'
      `
      const deposit = depositFor(price, Number(done?.count ?? 0))
      const w = await walletOf(me, tx)
      if (deposit > 0 && w.available < deposit) {
        return {
          error: 'INSUFFICIENT_POINTS',
          message: `需寄送的卡要押 ${deposit.toLocaleString('zh-TW')} 點保證金（逾期未出貨會被沒收），`
            + `你目前可動用 ${Math.max(0, w.available).toLocaleString('zh-TW')} 點。`
            + '請先儲值或等進行中的訂單結案再上架。',
          status: 409
        }
      }
    }

    const [u] = await tx`select name, handle from users where id = ${me}`
    const id = 'l-' + randomBytes(5).toString('hex')
    const card = pz.card as { certNo?: string | null }
    try {
      /* previous_status 抄的是**這一刻**的 pz.status（上面那個 for update
         的快照），不是等一下寫進去的 'listed'。它是下架時唯一能把卡放回
         原狀的依據 —— delivery 反推不出來（in_book 與 shipped 共用 'ship'），
         見 delist 那一段與 migration 032。 */
      await tx`insert into listings (id, card, price, seller_id, seller_name, delivery, cert_no, prize_id, previous_status)
               values (${id}, ${pz.card as never}, ${price}, ${me}, ${(u?.name as string) ?? (u?.handle as string) ?? '我'},
                       ${delivery}, ${card.certNo ?? null}, ${prizeId}, ${pz.status as string})`
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
