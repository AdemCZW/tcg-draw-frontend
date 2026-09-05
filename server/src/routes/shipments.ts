/**
 * 買家端的出貨單。**全部要登入，而且只看得到自己的。**
 *
 * ── 為什麼要有這一支 ────────────────────────────────────────────────
 * 699e239（D-1）之後，寄存期滿時系統會**自動替買家申請出貨**：卡從
 * `stashed` 變成 `ship_requested`、賣家掛上 72 小時的出貨時鐘。
 * 但買家在卡冊上只看得到「待出貨」三個字 ——
 *
 *   他沒有按過任何按鈕，卡的狀態卻自己變了；
 *   他不知道會寄到哪一份地址（他可能兩年前就搬家了）。
 *
 * 通知內文兩件事都有講，但那是**一次性的訊息，不是他隨時看得到的狀態**。
 * 而站上在這支檔案之前，`shipments` 只有 `routes/admin.ts` 讀得到 ——
 * 出貨單這個東西對它的主人本身是不存在的。
 *
 * ── 這支要回答的四個問題（形狀就是照這四個問題長的）────────────────
 *   1. 這張單是誰建的？        → `origin`：'auto-stash-expiry' / 'self'
 *   2. 會寄到哪？              → `shipTo`（**遮罩過的**，理由見下）
 *   3. 現在到哪一步？          → `status` ＋ 每張卡的 `prizeStatus`
 *   4. 賣家的期限到什麼時候？  → `sellerDueAt` / `sellerOverdue`
 *
 * ── 收件地址為什麼是遮罩而不是全文 ──────────────────────────────────
 * 判準是「他要用這個資訊做什麼決定」。這裡的決定只有一個：
 * **「這是不是我現在住的地方？要不要找客服改？」**
 * 回答那個問題不需要看到全文 —— 縣市 + 郵遞區號 + 街名開頭 + 門牌結尾
 * 就足以認出「是」或「不是」；認不出來的話全文也救不了他。
 *
 * 而全文要付的代價是真的：這條回應會流經前端記憶體、瀏覽器的
 * back/forward cache、他截圖傳給朋友問「這樣對嗎」、以及任何一個之後
 * 被加上去的錯誤回報工具。遮罩不會讓那些管道消失，但會讓管道裡流的
 * 東西不再是一張可以直接拿去寄件的標籤。
 *
 * 反過來想過也否掉了：如果地址真的錯了，他要給客服的是**正確**的地址，
 * 不是把錯的那份讀回來 —— 全文在那條路上一樣沒有用處。
 *
 * 全文只有一個人需要，就是要把卡寄出去的賣家，而他早就拿得到
 * （`routes/sellers.ts` 的 `/settlements`，義務結束就收回）。
 *
 * **不進 log、不進網址、不進任何分析事件。** 這支端點沒有任何 console
 * 輸出，地址也不會出現在任何 query string 裡（出貨單以 id 定址）。
 *
 * ── 權限：查不到一律 404，不回 403 ──────────────────────────────────
 * `where user_id = ${me}` 直接寫進查詢，不是撈回來再比。
 * 403 等於告訴對方「這張單存在，只是不給你看」—— 出貨單的 id 是
 * `sh-` + 10 個十六進位字元，可以猜；一個會誠實回答「存在」的端點
 * 就是一台可以慢慢掃出全站出貨單數量的機器。**存在與否本身也是資訊。**
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { PageQuery, decodeCursor, encodeCursor, isNumeric, slicePage } from '../pagination.js'

export const shipments = new Hono()
shipments.use('*', requireAuth)

/**
 * 「這張單是系統自動建的」這件事**現在只有一個地方記得**：
 * 自動出貨在建單的**同一個交易**裡發給買家的那一則通知，
 * 它的 ref_id 是 `stash-autoship:<出貨單 id>`（`pools-service.ts`）。
 * 買家自己申請那條（`routes/prizes.ts`）不會發這一則 —— 那條路上
 * 只有賣家收到 `ship-req:<id>`，買家沒有任何通知（他自己按的，不用通知他）。
 *
 * 所以「有這一則 = 自動、沒有 = 自己申請」是一條**精確**的規則，不是猜的：
 *   ‧ 兩條路都只有一支程式碼寫 shipments（全站 insert 只有那兩處）
 *   ‧ 通知跟出貨單在同一個交易裡，要嘛都在要嘛都不在
 *   ‧ ref_id 帶著隨機的出貨單 id，撞不到 007 的 (user_id, kind, ref_id) 唯一索引
 *   ‧ 站上沒有任何一條路會刪 notifications（只有標已讀）
 *
 * ⚠️ **但這是推導出來的，不是記下來的。** 真正該有的是
 * `shipments.source` 一欄（建單當下寫死），那需要一支新的 migration ——
 * 這一輪不開新的遷移編號（040 留給別條線）。之後補上那一欄時，
 * 這個 `exists` 就該換成讀那一欄，而且**只要換這一處**。
 */
const AUTO_REF_PREFIX = 'stash-autoship:'

/** 遮罩記號。刻意用一個字元，不用重複的星號 —— 星號的個數會洩漏長度 */
const MASK = '⋯'

/**
 * 保留頭尾、中間遮掉。
 *
 * 用 code point 切（`[...s]`）而不是 `slice()`：`slice` 切的是 UTF-16
 * code unit，遇到 emoji 或某些罕用字會把一個字切成半個，畫面上出現亂碼。
 * 地址欄位是使用者自由輸入的，什麼都可能有。
 */
function mask(raw: string, head: number, tail: number): string {
  const cp = [...raw.trim()]
  if (!cp.length) return ''
  /* 太短的字串留不住頭尾又遮不到東西 —— 只露一個字元。
     露頭還是露尾看原本的意圖：地址露頭（街名），電話露尾（末三碼）。 */
  if (cp.length <= head + tail) {
    return head >= tail ? cp[0]! + MASK : MASK + cp[cp.length - 1]!
  }
  /* 兩段各自 trim：地址常寫成「⋯88 巷 12 號 7 樓」，切在空白上時
     遮罩記號旁邊會多出一個孤兒空白，看起來像排版壞掉。 */
  return (head ? cp.slice(0, head).join('').trimEnd() : '')
    + MASK
    + (tail ? cp.slice(-tail).join('').trimStart() : '')
}

interface RawAddress {
  name?: unknown; phone?: unknown; line1?: unknown; city?: unknown; zip?: unknown
}

/**
 * 出貨單上那份地址的**遮罩版**。原始值一個欄位都不外流。
 *
 * 哪些留全文、哪些遮，是照「粗到認不出個人」這條線切的：
 *   city / zip 留全文 —— 一個縣市、一個三碼郵遞區號是幾十萬人共用的，
 *     它們本身不指向任何人，卻是「是不是我現在住的地方」最強的訊號。
 *   line1 留頭 3 尾 4 —— 街名開頭 + 門牌結尾。使用者原話的形狀
 *     （「台北市⋯⋯末四碼」），認得出來，但拼不回一張寄件標籤。
 *   name 只留姓、phone 只留末三碼 —— 這兩個是最直接的識別子，
 *     而它們在這裡的用途只有「確認是不是填成別人的」。
 */
function maskShipTo(a: RawAddress) {
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    /* 明寫在回應裡：讀到這份資料的人（包含之後接前端的人）要一眼知道
       這不是真的地址，不能拿去當寄件資料用，也不必再遮一次。 */
    masked: true as const,
    city: s(a.city).trim(),
    zip: s(a.zip).trim(),
    nameMasked: mask(s(a.name), 1, 0),
    phoneMasked: mask(s(a.phone), 0, 3),
    line1Masked: mask(s(a.line1), 3, 4)
  }
}

/** 兩份地址算不算同一份。比對在伺服器上做，兩邊的原文都不出去 */
function sameAddress(a: RawAddress, b: RawAddress): boolean {
  const n = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  return n(a.name) === n(b.name) && n(a.phone) === n(b.phone)
    && n(a.line1) === n(b.line1) && n(a.city) === n(b.city) && n(a.zip) === n(b.zip)
}

interface ShipmentRow {
  id: string
  status: string
  tracking: string | null
  created_at: string | number
  shipped_at: string | number | null
  prize_ids: string[]
  address: RawAddress | null
  auto: boolean
  /* 使用者**現在**的收件資料。用來算 differsFromProfile，不外流 */
  cur_name: string | null; cur_phone: string | null
  cur_zip: string | null; cur_city: string | null; cur_line1: string | null
}

/** 出貨單本體。where 條件由呼叫端接上去，但 `user_id = me` 一律在這裡就綁死 */
const shipmentCols = (me: string) => sql`
  select sh.id, sh.status, sh.tracking, sh.created_at, sh.shipped_at,
         sh.prize_ids, sh.address,
         /* 「這張單是系統自動建的」的唯一判準，理由見 AUTO_REF_PREFIX */
         exists (
           select 1 from notifications n
            where n.user_id = sh.user_id and n.kind = 'shipment'
              and n.ref_id = ${AUTO_REF_PREFIX} || sh.id
         ) as auto,
         u.real_name as cur_name, u.phone as cur_phone,
         u.address_zip as cur_zip, u.address_city as cur_city, u.address_line1 as cur_line1
    from shipments sh
    join users u on u.id = sh.user_id
   where sh.user_id = ${me}
`

interface CardRow {
  id: string
  name: string | null
  status: string
  tier: string | null
  seller_id: string | null
  seller_name: string | null
  ship_due_at: string | number | null
  settle_shipped_at: string | number | null
  settle_status: string | null
}

/**
 * 一張單上的每一張卡，各自帶著**那一張卡的賣家與那個賣家的期限**。
 *
 * 為什麼是每張卡一份而不是整張單一份：一次到期可以橫跨多個賣家
 * （`autoShipExpired` 是按「人」聚合成包裹的，不是按賣家），
 * 所以同一張出貨單上的兩張卡可能欠著兩個不同的人、期限也不同。
 * 給一個整張單的期限等於挑一張卡的事實去講整張單。
 *
 * 只 join 得到卡片本身的公開欄位與**賣家的顯示名稱** —— 賣家名稱本來就是
 * 公開的（市場、池頁上到處都是），而買家要聯絡誰、卡在誰手上，
 * 沒有這個名字就講不清楚。
 */
const cardCols = sql`
  select p.id, p.card->>'name' as name, p.status, p.tier,
         st.seller_id, s.name as seller_name,
         st.ship_due_at, st.shipped_at as settle_shipped_at, st.status as settle_status
    from prizes p
    left join pool_settlements st on st.prize_id = p.id
    left join sellers s on s.id = st.seller_id
`

const num = (v: string | number | null): number | null =>
  v == null ? null : Number(v)

async function toView(row: ShipmentRow, now: number) {
  const cards = await sql<CardRow[]>`${cardCols} where p.id = any(${row.prize_ids}) order by p.id`

  /* 還欠著的期限裡最早的那一個。已經寄出的（settle_shipped_at 不是 null）
     不算 —— 那張卡的義務結束了，把它的期限拿來當整張單的期限，
     使用者會看到一個早就過去的日期而且不知道那是誰的。 */
  const owed = cards
    .map(x => (x.settle_shipped_at == null ? num(x.ship_due_at) : null))
    .filter((v): v is number => v != null)
  const sellerDueAt = owed.length ? Math.min(...owed) : null

  return {
    id: row.id,
    /* requested / packed / shipped / delivered。賣家在
       `/v1/seller/settlements/:id/ship` 標出貨時，pool-settlement.ts 會把
       這一欄一起改成 shipped（F-3 修的就是「兩張表各說各話」），
       所以它真的追得上進度，不是一個建完就凍住的欄位。 */
    status: row.status,
    /**
     * 這張單是誰建的。**這是整支端點存在的理由**：
     * 'auto-stash-expiry' 的意思是「你沒有按過任何按鈕，是寄存期滿了」。
     */
    origin: row.auto ? ('auto-stash-expiry' as const) : ('self' as const),
    createdAt: num(row.created_at),
    shippedAt: num(row.shipped_at),
    tracking: row.tracking,
    shipTo: maskShipTo(row.address ?? {}),
    /**
     * 這張單上的地址跟他**現在**的收件資料不一樣。
     *
     * 自動出貨那條路上這個旗標的意思很明確：單建好之後他改過「我的資料」，
     * 而出貨單是**快照**、不會跟著變 —— 賣家看到的仍然是舊那份。
     * 自己申請那條路上不一樣是正常的（`/v1/prizes/ship` 本來就允許
     * 單次覆寫），所以前端要看 origin 決定這句話怎麼講。
     */
    differsFromProfile: !sameAddress(row.address ?? {}, {
      name: row.cur_name, phone: row.cur_phone,
      zip: row.cur_zip, city: row.cur_city, line1: row.cur_line1
    }),
    /**
     * 地址現在改不改得了。**寫成欄位而不是讓前端寫死**，因為這是一個
     * 這一輪的答案，不是一條永恆的事實 —— 之後真的做了自助更正，
     * 前端不必為了拿掉一顆按鈕再改一次。
     *
     * 為什麼是 false：出貨單上的地址是快照，而賣家在
     * `/v1/seller/settlements` 上**已經讀得到它**（義務一成立就給）。
     * 沒有任何紀錄說得出他讀過沒有、印過標籤沒有。買家單方面改掉，
     * 賣家手上那份就變成錯的，而他不會知道 —— 平台等於製造出一個
     * 「照系統給的地址寄，還是寄錯」的局面，而逾期記的是他的違約。
     * 要做對的話至少要：改動留痕、通知賣家、期限重算。那是另一輪的事。
     */
    addressEditable: false as const,
    /** 最早的那個「賣家還沒寄」的期限；全部寄出了就是 null */
    sellerDueAt,
    sellerOverdue: sellerDueAt != null && sellerDueAt < now,
    cards: cards.map(x => ({
      prizeId: x.id,
      name: x.name,
      tier: x.tier,
      /* 卡片自己的狀態。跟 shipments.status 是兩件事：一張單可以是
         requested，而其中某一張卡已經被賣家單獨標成 shipped。 */
      prizeStatus: x.status,
      sellerName: x.seller_name,
      sellerDueAt: x.settle_shipped_at == null ? num(x.ship_due_at) : null,
      sellerShippedAt: num(x.settle_shipped_at),
      settlementStatus: x.settle_status
    }))
  }
}

/**
 * GET /v1/shipments —— 我的出貨單，新到舊。
 *
 * 游標分頁跟站上其他清單同一套（`pagination.ts`）：出貨單是「從頭插入」的，
 * offset 在插入的當下會漏掉或重複一列。
 */
shipments.get('/', async c => {
  const me = c.get('userId')
  const parsed = PageQuery.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '分頁參數不合法' }, 400)
  const { limit, cursor } = parsed.data

  let after: [string, string] | null = null
  if (cursor) {
    const p = decodeCursor(cursor, 2)
    if (!p || !isNumeric(p[0]!)) return c.json({ error: 'BAD_CURSOR', message: '分頁游標不合法' }, 400)
    after = [p[0]!, p[1]!]
  }

  const rows = await sql<ShipmentRow[]>`
    ${shipmentCols(me)}
      ${after ? sql`and (sh.created_at, sh.id) < (${after[0]}::bigint, ${after[1]}::text)` : sql``}
     order by sh.created_at desc, sh.id desc
     limit ${limit + 1}
  `
  const page = slicePage(rows, limit, r => encodeCursor([String(r.created_at), String(r.id)]))
  const now = Date.now()
  return c.json({
    items: await Promise.all(page.items.map(r => toView(r, now))),
    nextCursor: page.nextCursor
  })
})

/**
 * GET /v1/shipments/for-prize/:prizeId —— **卡冊那一格要的就是這一支**。
 *
 * 卡冊是按卡片分頁的，手上只有 prize id；要從清單那一支反查得先把整份
 * 出貨單清單抓回來自己比對，而使用者可能有幾十張單。
 *
 * ⚠️ 註冊順序：這一條必須在 `/:id` **之前**。Hono 是照註冊順序比對的，
 * `/:id` 先註冊的話 `for-prize` 會被吃成一個 id、然後回 404。
 *
 * 同一張卡理論上只會在一張活著的單上（`ship_requested` 之後就不會再被
 * 建第二張），但退款／逾期取消之後那張卡有可能回到 `stashed` 再被建一次 ——
 * 所以取**最新的那一張**，那才是「現在這張卡在哪一張單上」。
 */
shipments.get('/for-prize/:prizeId', async c => {
  const me = c.get('userId')
  const prizeId = z.string().min(1).max(80).safeParse(c.req.param('prizeId'))
  if (!prizeId.success) return c.json({ error: 'NOT_FOUND', message: '找不到這張出貨單' }, 404)

  const [row] = await sql<ShipmentRow[]>`
    ${shipmentCols(me)}
      and ${prizeId.data} = any(sh.prize_ids)
     order by sh.created_at desc, sh.id desc
     limit 1
  `
  /* 卡不是他的、卡沒有出貨單、單不是他的 —— 三種都是同一句 404。
     分開講的話，「這張卡有單但不是你的」就變成一個可以查的事實。 */
  if (!row) return c.json({ error: 'NOT_FOUND', message: '找不到這張出貨單' }, 404)
  return c.json(await toView(row, Date.now()))
})

/** GET /v1/shipments/:id —— 單張。不是自己的一律 404（理由見檔頭） */
shipments.get('/:id', async c => {
  const me = c.get('userId')
  const id = z.string().min(1).max(80).safeParse(c.req.param('id'))
  if (!id.success) return c.json({ error: 'NOT_FOUND', message: '找不到這張出貨單' }, 404)

  const [row] = await sql<ShipmentRow[]>`${shipmentCols(me)} and sh.id = ${id.data} limit 1`
  if (!row) return c.json({ error: 'NOT_FOUND', message: '找不到這張出貨單' }, 404)
  return c.json(await toView(row, Date.now()))
})
