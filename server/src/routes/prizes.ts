/**
 * 使用者名下的卡：保管中、已上架、申請出貨、已出貨、已回收。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { walletOf } from '../money.js'
import { recycleEligible } from '../shared/recycle.js'
import {
  acceptRecycle, markShipRequested, release, sweepSettlements, toSettlement
} from '../pool-settlement.js'
import { PageQuery, decodeCursor, encodeCursor, isNumeric, slicePage } from '../pagination.js'

export const prizes = new Hono()
prizes.use('*', requireAuth)

const STATUSES = ['stashed', 'listed', 'ship_requested', 'shipped', 'recycled', 'refunded'] as const

/**
 * 狀態過濾在這裡做，不在前端做。
 *
 * 卡冊上那排「寄存中／已出貨…」的分頁，一旦列表變成分批載入就不能再用前端過濾：
 * 前端只濾得到「已經載進來的那 24 張」，於是使用者會看到「寄存中 0 張」，
 * 而真正的寄存中卡片躺在還沒載入的第 3 頁。分頁的數字也是同一個問題，
 * 所以總數走 /summary 由 SQL 算，不從已載入的陣列數。
 */
const PrizeQuery = PageQuery.extend({
  status: z.enum(STATUSES).optional()
})

prizes.get('/', async c => {
  /* 讀取時先把時限補算到現在。跟訂單那邊同一個模型（「拉」不是「推」）：
     排程掛掉不會讓狀態算錯，只會讓沒人看的那幾筆晚一點結案。 */
  await sql.begin(tx => sweepSettlements(tx, c.get('userId'))).catch(() => {})
  const parsed = PrizeQuery.safeParse(c.req.query())
  if (!parsed.success) {
    return c.json({ error: 'BAD_REQUEST', message: '分頁參數不合法（limit 介於 1 到 100）' }, 400)
  }
  const { limit, cursor, status } = parsed.data

  let after: [string, string] | null = null
  if (cursor) {
    const p = decodeCursor(cursor, 2)
    if (!p || !isNumeric(p[0]!)) return c.json({ error: 'BAD_CURSOR', message: '分頁游標不合法' }, 400)
    after = [p[0]!, p[1]!]
  }

  /* 排序鍵是 acquired_at（進到這個人卡冊的時間）而不是 won_at（這張卡被抽出來的時間）。
     庫內轉移只換 owner，被買走的卡帶著賣家當初抽到的時間 —— 用 won_at 排的話，
     剛買到的卡會落在幾天前的位置，卡冊一超過一頁它就不在第一頁上，
     使用者看到的就是「我買的卡沒進卡冊」。見 migrations/014_acquired_at.sql。 */
  /* 一併帶出這張卡的**宣告買回價**與結算狀態。
     買回價是那個池的賣家在開賣前宣告、寫進 commit 鎖死的金額，前端算不出來，
     也不該猜 —— 猜一個數字顯示給使用者比誠實說「這個池沒有宣告買回價」更糟。

     為什麼要繞 pool_seats：prizes 那一列只記得自己在哪個池的第幾號籤位，
     沒有直接指向 pool_prizes 的欄位。籤位對應到哪個獎項本來就是 pool_seats
     的職責（那是籤序本身），從它接過去才是唯一正確的來源。 */
  const rows = await sql<{ id: string; acquired_at: string }[]>`
    select p.*, pp.buyback, st.status as settle_status,
           st.ship_due_at as settle_ship_due_at, st.shipped_at as settle_shipped_at
      from prizes p
      left join pool_seats ps on ps.pool_id = p.pool_id and ps.seat = p.seat
      left join pool_prizes pp on pp.id = ps.prize_id
      left join pool_settlements st on st.prize_id = p.id
    where p.user_id = ${c.get('userId')}
      ${status ? sql`and p.status = ${status}` : sql``}
      ${after ? sql`and (p.acquired_at, p.id) < (${after[0]}::bigint, ${after[1]}::text)` : sql``}
    order by p.acquired_at desc, p.id desc
    limit ${limit + 1}
  `
  return c.json(slicePage(rows, limit, r => encodeCursor([String(r.acquired_at), String(r.id)])))
})

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
  const [counts, mix, best, curve] = await Promise.all([
    sql<{ status: string; n: string }[]>`
      select status, count(*)::text as n from prizes where user_id = ${me} group by status
    `,
    /* 已回收與已退還的卡都不在這個人手上了 —— 總值、賞別分佈、最高價都要排除。
       refunded 是賣家逾期未出貨、票金已經退回買家的那些：卡從來沒有離開賣家，
       留在統計裡會讓卡冊總值長期高估。 */
    sql<{ tier: string; n: string }[]>`
      select tier, count(*)::text as n from prizes
      where user_id = ${me} and status not in ('recycled', 'refunded') group by tier
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
  const r = await sql.begin(async tx => {
    /* 鎖 prizes 那一列。這是「同時被回收與被申請出貨」的仲裁點 ——
       兩條路都要先拿到這一列的鎖，而且都要求 status = 'stashed'，
       所以先到的那個把狀態改掉，後到的必然看到不合的狀態而退出。 */
    const [p] = await tx`select * from prizes where id = ${c.req.param('id') ?? ''} and user_id = ${me} for update`
    if (!p) return { error: 'NOT_FOUND', message: '找不到這張卡', status: 404 }
    if (p.status !== 'stashed') return { error: 'WRONG_STATE', message: '只有保管中的卡可以回收', status: 409 }

    const [row] = await tx`
      select * from pool_settlements where prize_id = ${p.id} for update
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
      return out.error === 'SELLER_UNFUNDED'
        ? { error: 'SELLER_UNFUNDED', message: '賣家目前的保留額不足以支付這筆回收，請稍後再試或改為申請出貨', status: 409 }
        : { error: 'WRONG_STATE', message: '這張卡的結算狀態已經改變，不能回收', status: 409 }
    }
    return { points, buyback }
  })
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
    const [row] = await tx`
      select * from pool_settlements where prize_id = ${c.req.param('id') ?? ''} and buyer_id = ${me} for update
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
    return { shipmentId: id }
  })
  if ('error' in r) return c.json(r, r.status as 409)
  return c.json(r)
})
