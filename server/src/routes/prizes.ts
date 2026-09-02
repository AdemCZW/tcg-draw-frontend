/**
 * 使用者名下的卡：在卡冊、押在池裡、保管中、已上架、申請出貨、已出貨、已回收、已退還。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sql, Rollback } from '../db.js'
import { requireAuth } from '../auth.js'
import { walletOf } from '../money.js'
import { notify } from '../notify.js'
import { recycleEligible } from '../shared/recycle.js'
import { POOL_SHIP_DEADLINE_MS } from '../shared/pool-settlement.js'
import {
  acceptRecycle, markShipRequested, release, sweepSettlements, toSettlement
} from '../pool-settlement.js'
import { PageQuery, decodeCursor, encodeCursor, isNumeric, slicePage } from '../pagination.js'

export const prizes = new Hono()
prizes.use('*', requireAuth)

/**
 * prizes.status 的完整值域。
 *
 * **這一串必須跟資料表的 check 約束逐字一致**，來源是
 * migrations/021_inventory_first.sql:111 的 prizes_status_check：
 *   stashed / listed / ship_requested / shipped / recycled / refunded / in_book / in_pool
 * （002_core.sql 原本只有前五個，017 加了 refunded，021 加了 in_book 與 in_pool。）
 *
 * 為什麼一個字都不能少：這個陣列同時是兩件事的定義 ——
 *   1. `?status=` 的 zod enum。少一個值，那個狀態就**查不到**：
 *      前端送 `?status=in_book` 會被擋成 400，連「換個參數再試」都沒有用。
 *   2. /summary 的 counts 初始化。少一個值，那一格永遠不會被建出來，
 *      卡冊的分頁列上就永遠看不到那個狀態。
 *
 * 021 加了兩個狀態卻沒有回頭改這裡，代價是自己登記進卡冊的卡（in_book）
 * 在開池的挑選器裡永遠是 0 —— 卡冊頁說「持有 1 張」，挑選器說「0 張」，
 * 而使用者沒有任何辦法從畫面上和好這兩個數字。
 *
 * ⚠️ 之後任何一支遷移動到 prizes_status_check，這一行要一起改。
 */
const STATUSES = [
  'stashed', 'listed', 'ship_requested', 'shipped', 'recycled', 'refunded',
  'in_book', 'in_pool'
] as const

/**
 * 「同一款卡」的定義。**這是卡冊分組的唯一實作。**
 *
 * ---- 為什麼寫在 SQL 而不是撈回來再用 TS 的 cardMergeKey 分 ----
 * 卡冊是游標分頁的。同款卡要在畫面上併成一格「×10」，前端就必須知道
 * 兩件事：哪些列屬於同一組（分組），以及**這一組總共幾張**（數量）。
 * 兩件事在前端都做不到 ——
 *   分組：只分得到已載入的那 24 張，第 3 批才出現的同款卡會另外自成一組；
 *   數量：使用者看到「×3」而實際上他有 10 張。對一個「要拿來整理重複卡
 *        去出售」的功能，那個 3 是會讓人做錯決定的假數字。
 * 所以分組鍵要進 order by（讓同組必然相鄰），張數要用 window function 算
 * （整本卡冊的 count，不是這一頁的）。兩件事都只有 SQL 做得到。
 *
 * ---- 規則本身（跟 src/lib/card-merge.ts 的 cardMergeKey 逐字一致）----
 * 1. **有鑑定編號的卡永遠不合併**：certNo 進鍵，等於每一張自成一組，
 *    group_total 恆為 1。PSA 10 #82345671 與 #82345672 是兩張可以各自
 *    對外查證的實體卡，併成「×2」之後「要賣的是哪一張」就講不清楚了 ——
 *    整套爭議判定就建立在 certNo 可以逐張查證上。
 * 2. **變體要進鍵**：SV2a-025 普卡 €0.02、同卡號的マスターボールミラー €369，
 *    差約 18,000 倍。併在一起等於把兩種商品講成同一種。
 * 3. 鑑定機構、分數、語言都是「這是哪一張卡」的一部分。artId 是最準的身分，
 *    沒有才退回 setCode/cardNo。
 *
 * 前端拿到的是這裡算出來的字串（group_key），**不會自己再算一次**；
 * cardMergeKey 留給建池挑卡器（那份清單不分頁，手上也沒有 group_key）。
 * 產生的字串刻意跟 cardMergeKey 完全相同，兩份規則分岔時看得出來。
 *
 * coalesce 每一格都要有：jsonb 的 ->> 取不到會回 null，而 null 參與字串
 * 串接的結果是 null —— 少一個 coalesce，那一整組卡的鍵會變成 NULL，
 * 而 SQL 裡 NULL 不等於 NULL，同款卡反而全部散開。
 */
const GROUP_KEY = sql`
  case when coalesce(p.card->>'certNo', '') <> '' then
    'one:' || coalesce(nullif(p.card->>'artId', ''),
                       coalesce(p.card->>'setCode', '') || '/' || coalesce(p.card->>'cardNo', ''))
          || ':' || coalesce(p.card->>'grader', '')
          || ':' || (p.card->>'certNo')
  else
    'same:' || coalesce(nullif(p.card->>'artId', ''),
                        coalesce(p.card->>'setCode', '') || '/' || coalesce(p.card->>'cardNo', ''))
            || '|' || coalesce(p.card->>'variantId', '')
            || '|' || coalesce(p.card->>'grader', '')
            || '|' || coalesce(p.card->>'grade', '')
            || '|' || coalesce(p.card->>'language', '')
  end
`

/** 這一組的參考價。同組每一張都是同一款卡，取 max 只是為了讓組內完全一致 ——
    同款卡的 refPrice 理論上一樣，但它是賣家自填的欄位，不能假設。
    值必須組內恆等，否則「照參考價排」時同一組會被別的卡插進中間，分組就斷了。
    沒有標示參考價的卡當 -1（排最後），不是 0 —— 見 CardItem.refPrice 的說明。 */
const GROUP_REF = sql`max(coalesce((p.card->>'refPrice')::numeric, -1)) over (partition by ${GROUP_KEY})`

/**
 * 排序。
 *
 * 為什麼只有這三個 —— 使用者提到「類型／等級」，但站上真正存在的維度只有
 * 賞別（tier）、取得時間、參考價、卡名，而其中兩個是**看起來有用**：
 *
 *   賞別：tier 是「這張卡在那個池裡被當成第幾賞」，是**池的屬性不是卡的屬性**。
 *         同一張卡在 A 池是 A 賞、在 B 池可能是 C 賞，照它排不會把同款卡排在一起。
 *         而且自己登記進卡冊的卡 tier 是 null（migration 027），卡冊裡自登記的卡
 *         愈多，這個排序就愈接近「一大坨未分級」。賞別的分佈總覽卡上已經有一條
 *         堆疊條連張數一起講完了，再做一個排序是重複。
 *   卡名：跟「同款集中」高度重疊（同名卡在那裡本來就相鄰），而中日文卡名的
 *         排序取決於資料庫的 collation，使用者無法預期順序。
 *
 * 三種排序裡有兩種（dupes / value）保證**同款卡相鄰**，前端才敢把它們併成
 * 一格 ×N。acquired 刻意不分組：它是一條時間軸，把 9 張舊卡拉到新卡旁邊
 * 就不再是時間軸了；而且它是預設值，抽完卡導回來的 ?new= 要靠它落在第一張。
 */
const SORTS = ['acquired', 'dupes', 'value'] as const
type Sort = (typeof SORTS)[number]

/** 游標裡的數值段。參考價可能是小數，isNumeric（只收整數）擋不住也放不過 */
const isDecimal = (s: string) => /^-?\d+(\.\d+)?$/.test(s)

/**
 * 過濾與排序**全部在這裡做，不在前端做**。
 *
 * 卡冊上那排「寄存中／已出貨…」的分頁，一旦列表變成分批載入就不能再用前端過濾：
 * 前端只濾得到「已經載進來的那 24 張」，於是使用者會看到「寄存中 0 張」，
 * 而真正的寄存中卡片躺在還沒載入的第 3 頁。分頁的數字也是同一個問題，
 * 所以總數走 /summary 由 SQL 算，不從已載入的陣列數。
 *
 * **排序與分組是一模一樣的坑，而且更嚴重**：前端排序只排得到已載入的那批，
 * 捲一頁就整個重排；前端分組則會告訴使用者「這款你有 3 張」，而他其實有 10 張。
 * 「找出重複的卡拿去賣」正是靠那個數字做決定的功能。
 */
const PrizeQuery = PageQuery.extend({
  status: z.enum(STATUSES).optional(),
  sort: z.enum(SORTS).default('acquired'),
  /**
   * 只回這一組的卡。
   *
   * 「這一組全選」需要**還沒載入的那幾張的 id**：使用者看到「×10」就按下
   * 全選，而畫面上只有 3 張載進來了。沒有這個參數的話，前端只有兩條路 ——
   * 假裝選了 10 張（實際只送出 3 個 id，使用者要到定價頁才發現少了 7 張），
   * 或者叫使用者「先捲到底再按」。兩條都是把分頁的實作細節丟給使用者。
   */
  group: z.string().min(1).max(400).optional()
})

prizes.get('/', async c => {
  /* 讀取時先把時限補算到現在。跟訂單那邊同一個模型（「拉」不是「推」）：
     排程掛掉不會讓狀態算錯，只會讓沒人看的那幾筆晚一點結案。 */
  await sql.begin(tx => sweepSettlements(tx, c.get('userId'))).catch(() => {})
  const parsed = PrizeQuery.safeParse(c.req.query())
  if (!parsed.success) {
    /* 分開講。四個參數的下一步完全不同（改網址、換排序、換狀態、縮 limit），
       全部回同一句「limit 介於 1 到 100」等於在 sort 打錯時答非所問 ——
       呼叫端會照著訊息去改一個根本沒問題的參數。 */
    const which = parsed.error.issues[0]?.path[0]
    const message =
      which === 'sort' ? `排序只接受 ${SORTS.join(' / ')}`
      : which === 'status' ? '狀態不在已知的值域內'
      : which === 'group' ? '分組鍵不合法'
      : '分頁參數不合法（limit 介於 1 到 100）'
    return c.json({ error: 'BAD_REQUEST', message }, 400)
  }
  const { limit, cursor, status, sort, group } = parsed.data

  /**
   * 游標。三種排序的鍵不一樣，段數也不一樣。
   *
   * ⚠️ **group_key 一定要放在最後一段。** 它裡面本來就含有分隔字元 `|`
   * （'same:SV4a-205||RAW||JP'），而 decodeCursor 只把**最後一段**的
   * 剩餘部分接回來 —— 放中間會在解碼時被切成好幾段，換頁就整個錯位。
   * 所以 payload 的順序（把 group_key 移到最後）跟排序鍵的順序刻意不同，
   * 下面的比較式再把它排回去。
   */
  let after: string[] | null = null
  if (cursor) {
    const parts = sort === 'acquired' ? 2 : sort === 'value' ? 3 : 4
    const p = decodeCursor(cursor, parts)
    const bad =
      !p ||
      (sort === 'acquired' && !isNumeric(p[0]!)) ||
      (sort === 'value' && !isDecimal(p[0]!)) ||
      (sort === 'dupes' && (!isNumeric(p[0]!) || !isDecimal(p[1]!)))
    if (bad) return c.json({ error: 'BAD_CURSOR', message: '分頁游標不合法' }, 400)
    after = p as string[]
  }

  /* 排序鍵是 acquired_at（進到這個人卡冊的時間）而不是 won_at（這張卡被抽出來的時間）。
     庫內轉移只換 owner，被買走的卡帶著賣家當初抽到的時間 —— 用 won_at 排的話，
     剛買到的卡會落在幾天前的位置，卡冊一超過一頁它就不在第一頁上，
     使用者看到的就是「我買的卡沒進卡冊」。見 migrations/014_acquired_at.sql。 */

  /**
   * 分組的張數與參考價先在一個 CTE 裡算好。
   *
   * ⚠️ **window function 一定要算在游標條件之前。** 窗算的是 WHERE 之後的
   * 結果集，如果把 `(排序鍵) < (游標)` 一起寫進這一層，第 2 頁的
   * count(*) over (...) 數到的就只剩「游標之後的那幾張」—— 同一張卡
   * 第 1 頁說 ×10、第 2 頁說 ×7，而且兩個都不是使用者手上的張數。
   * 所以：狀態過濾（那是「要看哪一批卡」，屬於統計範圍的一部分）留在這一層，
   * 游標（那是「我讀到哪」，是分頁的實作）擋在外面。
   *
   * 代價是每翻一頁都要掃過這個人整本卡冊。這跟 /summary 是同一個量級
   * （那支的 curve 本來就逐張投影整本），而卡冊的規模是「一個人擁有幾張卡」，
   * 不是全站資料量；prizes_user 索引已經把範圍限縮到這個人。
   * 真正貴的仍然是列表那邊的卡圖與 DOM。
   */
  const me = c.get('userId')
  const book = sql`
    select p.id,
           ${GROUP_KEY} as group_key,
           count(*) over (partition by ${GROUP_KEY})::int as group_total,
           /* 這一組裡**還能上架**的張數。
              使用者原話：「就會需要一張一張確認哪些有重複、哪些已經上架了」——
              「已經上架了」正是這個數字在回答的事。少了它，一格「×10」在
              「全部」分頁上會蓋掉「其中 7 張已經在市場上」這件事，
              而那正是他不想再逐張確認的東西。
              可上架的狀態（stashed / in_book）跟前端 canSell 與上架端點
              收的兩種是同一組；三處要一起改。 */
           count(*) filter (where p.status in ('stashed', 'in_book'))
             over (partition by ${GROUP_KEY})::int as group_sellable,
           ${GROUP_REF} as group_ref
      from prizes p
     where p.user_id = ${me}
       ${status ? sql`and p.status = ${status}` : sql``}
  `

  /**
   * 三種排序的 [order by, 游標比較, 從一列取出游標]。
   *
   * dupes / value 的排序鍵裡都夾著 group_key，這不是為了好看 —— 它是
   * 「同組必然相鄰」的保證本身，前端把連續同鍵的列併成一格 ×N 就是靠它。
   * 少了它，兩款張數相同（或參考價相同）的卡會照 id 交錯，畫面上一組卡
   * 會被另一組插斷成兩格。
   *
   * 方向全部統一成 asc（要倒過來的就取負值），因為列值比較 (a,b,c) > (x,y,z)
   * 只有在所有欄位同方向時才成立 —— 混方向就得拆成一串 or，規劃器用不到索引，
   * 而且邊界（含不含等號、哪一欄比哪一邊）非常容易寫錯。
   */
  const spec = (() => {
    switch (sort) {
      case 'dupes':
        /* 張數多的排最前面 —— 使用者打開這個排序就是為了找「我有好幾張的那些」。
           張數相同時照參考價高低，值錢的先看到（要整理去賣的話那才是重點）。 */
        return {
          order: sql`order by (-b.group_total), (-b.group_ref), b.group_key, b.id`,
          where: after
            ? sql`and ((-b.group_total), (-b.group_ref), b.group_key, b.id)
                    > (${after[0]!}::int, ${after[1]!}::numeric, ${after[3]!}::text, ${after[2]!}::text)`
            : sql``,
          key: (r: Row) => [String(-r.group_total), String(-Number(r.group_ref)), r.id, r.group_key]
        }
      case 'value':
        return {
          order: sql`order by (-b.group_ref), b.group_key, b.id`,
          where: after
            ? sql`and ((-b.group_ref), b.group_key, b.id)
                    > (${after[0]!}::numeric, ${after[2]!}::text, ${after[1]!}::text)`
            : sql``,
          key: (r: Row) => [String(-Number(r.group_ref)), r.id, r.group_key]
        }
      case 'acquired':
        /* 預設。游標格式跟這個改動之前**逐字相同**（2 段、acquired_at + id），
           所以舊分頁請求打進來仍然對得上，不會在部署的那一刻讓正在捲動的
           使用者拿到 400。 */
        return {
          order: sql`order by p.acquired_at desc, p.id desc`,
          where: after
            ? sql`and (p.acquired_at, p.id) < (${after[0]!}::bigint, ${after[1]!}::text)`
            : sql``,
          key: (r: Row) => [String(r.acquired_at), String(r.id)]
        }
    }
  })()

  /* 一併帶出這張卡的**宣告買回價**與結算狀態。
     買回價是那個池的賣家在開賣前宣告、寫進 commit 鎖死的金額，前端算不出來，
     也不該猜 —— 猜一個數字顯示給使用者比誠實說「這個池沒有宣告買回價」更糟。

     為什麼要繞 pool_seats：prizes 那一列只記得自己在哪個池的第幾號籤位，
     沒有直接指向 pool_prizes 的欄位。籤位對應到哪個獎項本來就是 pool_seats
     的職責（那是籤序本身），從它接過去才是唯一正確的來源。 */
  const rows = await sql<Row[]>`
    with b as (${book})
    select p.*, b.group_key, b.group_total, b.group_sellable, b.group_ref,
           /* 買回價只有在**這一筆結算還付得出來**的時候才回（F-7）。
              結算一旦 released / refunded / recycled，那筆保留額已經不在了，
              回收端點會回 409。原本這裡照樣回買回價，卡冊就長出一個
              標了價、按下去卻說「結算狀態已經改變」的按鈕 ——
              對買家來說那是一個看得到、按不動的承諾。
              擋在資料來源這一層，前端不需要知道結算的狀態機。 */
           case when st.status in ('held', 'awaiting_ship') then pp.buyback end as buyback,
           st.status as settle_status,
           st.ship_due_at as settle_ship_due_at, st.shipped_at as settle_shipped_at
      from b
      join prizes p on p.id = b.id
      left join pool_seats ps on ps.pool_id = p.pool_id and ps.seat = p.seat
      left join pool_prizes pp on pp.id = ps.prize_id
      left join pool_settlements st on st.prize_id = p.id
     where true
       ${group ? sql`and b.group_key = ${group}` : sql``}
       ${spec.where}
    ${spec.order}
    limit ${limit + 1}
  `
  return c.json(slicePage(rows, limit, r => encodeCursor(spec.key(r))))
})

/** 列表那支查出來的一列。只列後面真的會讀到的欄位 */
type Row = {
  id: string
  acquired_at: string
  group_key: string
  group_total: number
  group_ref: string
}

/**
 * 卡冊總覽的數字。
 *
 * 為什麼要一支獨立端點：總值、最高價、賞別分佈、各狀態張數這幾項講的都是
 * 「整本卡冊」，而列表已經變成分批載入 —— 用載進來的那幾張算會愈捲愈大，
 * 那不是統計，是進度條。這幾個聚合在 SQL 一次算完最便宜也最誠實。
 *
 * curve 是唯一沒有聚合掉的一段：成長曲線需要每一張卡的「時間 + 金額」才畫得出來。
 * 但它只投影三個純量欄位（約 40 bytes 一列），不含 card 這個 jsonb（約 600 bytes），
 * 而且整頁只取一次、不隨捲動重複拿。真正貴的是列表那邊的卡圖與 DOM，
 * 那一段才是分頁要解決的問題。
 */
prizes.get('/summary', async c => {
  const me = c.get('userId')
  const [counts, mix, best, curve, dup] = await Promise.all([
    sql<{ status: string; n: string }[]>`
      select status, count(*)::text as n from prizes where user_id = ${me} group by status
    `,
    /* 已回收與已退還的卡都不在這個人手上了 —— 總值、賞別分佈、最高價都要排除。
       refunded 是賣家逾期未出貨、票金已經退回買家的那些：卡從來沒有離開賣家，
       留在統計裡會讓卡冊總值長期高估。 */
    /* tier is not null：上傳進卡冊、還沒進過池的卡沒有賞別（migration 027）。
       賞別分佈講的是「抽到過什麼賞」，一張沒進過池的卡不屬於任何一格 ——
       讓 null 混進來會在圖上長出一條沒有名字的 bar。
       它們仍然算在 total / owned / totalValue 裡（卡是真的持有）。 */
    sql<{ tier: string; n: string }[]>`
      select tier, count(*)::text as n from prizes
      where user_id = ${me} and status not in ('recycled', 'refunded')
        and tier is not null group by tier
    `,
    sql<{ card: { name?: string; refPrice?: number }; tier: string }[]>`
      select card, tier from prizes
      where user_id = ${me} and status not in ('recycled', 'refunded')
      order by (card->>'refPrice')::numeric desc nulls last limit 1
    `,
    sql<{ acquired_at: string; name: string | null; ref: string | null }[]>`
      select acquired_at, card->>'name' as name, card->>'refPrice' as ref
      from prizes where user_id = ${me} and status not in ('recycled', 'refunded')
      order by acquired_at asc, id asc
    `,
    /**
     * 重複的卡有幾款、共幾張。
     *
     * 為什麼要放進總覽而不是讓前端數已載入的那幾張：那正是這一整個功能要解掉的
     * 錯誤答案 —— 分批載入之下前端數出來的「重複 1 款」是假的。
     * 而這個數字的用途是**讓「同款集中」這個排序被看見**：使用者不會去點一個
     * 他不知道自己需要的排序，但「你有 4 款重複的卡」會讓他去點。
     *
     * 已回收與已退還排除掉：那些卡已經不在這個人手上，「重複」對它們不成立。
     */
    sql<{ groups: string; cards: string }[]>`
      select count(*)::text as groups, coalesce(sum(n), 0)::text as cards
        from (
          select ${GROUP_KEY} as k, count(*) as n
            from prizes p
           where p.user_id = ${me} and p.status not in ('recycled', 'refunded')
           group by 1
          having count(*) > 1
        ) g
    `
  ])

  const byStatus: Record<string, number> = {}
  for (const s of STATUSES) byStatus[s] = 0
  let total = 0
  for (const r of counts) { byStatus[r.status] = Number(r.n); total += Number(r.n) }

  const owned = total - (byStatus.recycled ?? 0) - (byStatus.refunded ?? 0)
  const totalValue = curve.reduce((a, r) => a + (Number(r.ref) || 0), 0)
  const b = best[0]

  return c.json({
    total, counts: byStatus, owned, totalValue,
    best: b ? { name: b.card?.name ?? '', tier: b.tier, refPrice: Number(b.card?.refPrice) || 0 } : null,
    tierMix: mix.map(r => ({ tier: r.tier, n: Number(r.n) })),
    /* 「4 款重複的卡、共 21 張」。dupCards 含每一款自己的第一張 ——
       講的是「這 21 張卡分屬 4 款」，不是「有 21 張多餘的」，
       因為「多餘幾張」要看使用者想留幾張，那不是系統能替他決定的事。 */
    dupGroups: Number(dup[0]?.groups ?? 0),
    dupCards: Number(dup[0]?.cards ?? 0),
    /* 曲線畫的是「這本卡冊怎麼累積起來的」，所以 x 軸是取得時間。
       用 won_at 的話，今天買到的一張舊卡會把曲線的起點往回拉到賣家抽中它的那天。 */
    curve: curve.map(r => ({ wonAt: Number(r.acquired_at), name: r.name ?? '', refPrice: Number(r.ref) || 0 }))
  })
})

/**
 * 回收：買家接受賣家宣告的買回價。
 *
 * ⚠️ 這支的語意換過兩次，兩次換的都是「這筆錢憑什麼是這個數字」。
 *
 * 第一版：平台照賣家自填的 refPrice 付 70%。那是安全稽核 C-2 的印鈔機 ——
 * 分錄只有貸方沒有借方，全站的點數總量會單向膨脹。
 *
 * 第二版：賣家出價、玩家接受，**錢從那個池自己的保留額出**。印鈔機解掉了，
 * 但金額還是 refPrice × 比率 —— 地基仍然是那個沒有外部依據的自填數字。
 *
 * 第三版（現行）：金額是**賣家在建池時宣告、寫進 commit 鎖死的買回價**。
 * refPrice 從此完全不參與。把 refPrice 改掉，回收金額一毛都不會變。
 *
 * 錢的來源不變（那個池的保留額），所以：
 *   - **已經出貨的卡不能回收**：卡寄出去了，「取消一半」在實體上不成立
 *   - **沒有宣告過買回價的舊池不能回收**：它們從來沒有做過這個承諾，
 *     系統不能替賣家簽一個他沒同意的約（見 migration 018 的說明）
 */
prizes.post('/:id/recycle', async c => {
  const me = c.get('userId')
  let r
  try {
    r = await sql.begin(async tx => {
    /* 鎖 prizes 那一列。這是「同時被回收與被申請出貨」的仲裁點 ——
       兩條路都要先拿到這一列的鎖，而且都要求 status = 'stashed'，
       所以先到的那個把狀態改掉，後到的必然看到不合的狀態而退出。 */
    const [p] = await tx`select * from prizes where id = ${c.req.param('id') ?? ''} and user_id = ${me} for update`
    if (!p) return { error: 'NOT_FOUND', message: '找不到這張卡', status: 404 }
    if (p.status !== 'stashed') return { error: 'WRONG_STATE', message: '只有保管中的卡可以回收', status: 409 }

    /* join prizes 取當下的擁有者 —— 收款人必須是按下按鈕的這個人，
       不是抽中這一籤的人（F-1）。上面已經用 `and user_id = ${me}` 確認過
       這張卡現在是他的，所以 owner_id 就是 me。 */
    const [row] = await tx`
      select st.*, pz.user_id as owner_id
        from pool_settlements st join prizes pz on pz.id = st.prize_id
       where st.prize_id = ${p.id} for update of st
    `
    if (!row) {
      /* 舊制抽到的卡沒有結算列。它們的票金當初是被銷毀的，沒有保留額可以付，
         補一筆貸方就是真的印鈔票 —— 照實拒絕，不要假裝這裡還有錢。 */
      return { error: 'NO_OFFER', message: '這張卡沒有賣家的回收報價', status: 409 }
    }
    const s = toSettlement(row as Record<string, unknown>)

    /* 買回金額直接讀賣家宣告的那個數字，**不乘 refPrice、不乘任何比率**。
       refPrice 是賣家自己填的、沒有外部依據，把它當分子等於讓賣家自己
       決定平台要付多少（docs/HANDOFF.md 4.1）。buyback 相反：那是他寫進
       commit 的承諾，開賣後改不了，而且錢從他自己的保留額出。

       這一列是「這個籤位開出的是哪個獎項」，來源是 pool_seats（籤序本身）。 */
    const [pp] = await tx`
      select pp.buyback from pool_seats ps
        join pool_prizes pp on pp.id = ps.prize_id
       where ps.pool_id = ${s.poolId} and ps.seat = ${s.seat}
    `
    const buyback = pp?.buyback == null ? null : Number(pp.buyback)
    if (!recycleEligible(buyback)) {
      return {
        error: 'NO_OFFER',
        message: '這個池沒有宣告買回價 —— 它是買回制上線之前開的池',
        status: 409
      }
    }
    const points = buyback as number

    const out = await acceptRecycle(tx, s, points, Date.now())
    if (!out.ok) {
      /* SELLER_UNFUNDED 不會走到這裡 —— 那條在 acceptRecycle 裡是 throw
         Rollback（整筆回滾，見 db.ts 的說明），由外層 catch 轉成 409。 */
      return (
        /* 講清楚是哪一種「改變」。原本只說「結算狀態已經改變」，
           使用者不知道發生了什麼，也不知道還能不能補救。
           絕大多數情況是寄存確認期（14 天）已經過了、票金已經放給賣家。 */
        {
          error: 'WRONG_STATE',
          message: s.status === 'released'
            ? '這張卡的寄存確認期已經過了，票金已經結算給賣家，不能再回收。你可以申請出貨把卡寄給你'
            : '這張卡的結算狀態已經改變，不能回收',
          status: 409
        }
      )
    }
      return { points, buyback }
    })
  } catch (e) {
    // Rollback：交易已整筆回滾，把帶出來的回應照實回（見 db.ts）
    if (e instanceof Rollback) return c.json(e.body, e.status as 409)
    throw e
  }
  if ('error' in r) return c.json(r, r.status as 404 | 409)
  return c.json({ ...r, wallet: await walletOf(me) })
})

/**
 * 買家確認收貨：那一筆票金立刻釋放給賣家。
 *
 * 「那一筆」不是「那一池」—— 逐筆釋放，賣家的現金流不必等整池抽完。
 * 不確認也沒關係，鑑賞期滿會自動釋放（shared/pool-settlement.ts）。
 */
prizes.post('/:id/confirm', async c => {
  const me = c.get('userId')
  const r = await sql.begin(async tx => {
    /* 比對的是**卡現在的擁有者**，不是 buyer_id。
       用 buyer_id 的話，在市場上買了二手卡的新主人會拿到 404 ——
       他手上有卡、賣家寄給他、他卻沒有辦法確認收貨。

       鎖序照全站紀律：**先鎖 prizes 那一列，再鎖結算列**（V-1，
       見 pool-settlement.ts 的 sweepSettlements 檔頭說明）。
       這支後面會 update prizes，先鎖卡再鎖結算才不會跟掃描互為反向。 */
    const [pz] = await tx`
      select id from prizes where id = ${c.req.param('id') ?? ''} and user_id = ${me} for update
    `
    if (!pz) return { error: 'NOT_FOUND', message: '找不到這筆結算', status: 404 }
    const [row] = await tx`
      select st.*, pz.user_id as owner_id
        from pool_settlements st join prizes pz on pz.id = st.prize_id
       where st.prize_id = ${pz.id} for update of st
    `
    if (!row) return { error: 'NOT_FOUND', message: '找不到這筆結算', status: 404 }
    const s = toSettlement(row as Record<string, unknown>)
    if (s.status !== 'shipped') {
      return { error: 'WRONG_STATE', message: '賣家還沒出貨，不能確認收貨', status: 409 }
    }
    await release(tx, s, 'buyer-confirm', Date.now())
    await tx`update prizes set status = 'shipped' where id = ${s.prizeId}`
    return { ok: true }
  })
  if ('error' in r) return c.json(r, r.status as 404 | 409)
  return c.json(r)
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
    /* 出貨申請同時啟動賣家的出貨時鐘。這是「保留額什麼時候釋放」與
       「賣家什麼時候算違約」兩件事的共同起點 —— 少了這一步，
       買家申請了出貨，賣家卻沒有任何期限壓力，而錢也永遠釋放不掉。 */
    await markShipRequested(tx, prizeIds, Date.now())

    /* ── 通知賣家：時鐘已經開始跑了 ──────────────────────────────────
       上面那一行替賣家掛上一個**有時限的義務**（72 小時），逾期的後果是
       退款給買家＋記一次違約。而在這之前這件事對賣家是完全靜默的：
       他要自己想到去打開「出貨與結算」那一頁才看得到。這是整份稽核裡
       唯一「使用者會因為沒收到通知而被罰」的路徑，所以它比任何一則都該發。

       為什麼要 group by seller_id：一次申請可以夾帶多個賣家的卡（F-9），
       每個賣家只該收到一則、而且只該看到自己那幾張的數量。

       條件跟 markShipRequested 剛剛寫的兩個 UPDATE 對齊 —— 正常路徑
       （awaiting_ship）與 F-5（票金已釋放但還欠卡）都算義務。

       refId 綁**出貨單 id**：一次申請就是一個事件，重送會建新的出貨單、
       也就該有新的通知。同一張單重試（同一個 id）則只發一次。
       唯一索引帶 user_id，所以多個賣家共用這個 refId 不會互相擋掉。 */
    const owed = await tx<{ seller_id: string; n: number }[]>`
      select st.seller_id, count(*)::int as n
        from pool_settlements st
       where st.prize_id = any(${prizeIds})
         and st.ship_due_at is not null and st.shipped_at is null
         and st.status in ('awaiting_ship', 'released')
       group by st.seller_id
    `
    for (const o of owed) {
      await notify({
        userId: o.seller_id, kind: 'shipment',
        title: '有買家申請出貨了',
        body: `${o.n} 張卡等你寄出，期限 ${POOL_SHIP_DEADLINE_MS / 3_600_000} 小時 —— `
            + '逾期會退款給買家並記一次違約。收件地址在出貨頁上。',
        link: '/seller/shipping', refId: 'ship-req:' + id
      }, tx)
    }
    return { shipmentId: id }
  })
  if ('error' in r) return c.json(r, r.status as 409)
  return c.json(r)
})
