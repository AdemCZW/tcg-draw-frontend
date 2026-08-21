/**
 * 池與抽選。
 *
 * 讀取端點是公開的（逛池不用登入），抽選要登入。
 * server_seed 在 revealed 之前絕對不會出現在任何回應裡 —— toPublic() 是唯一的出口。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { returnRatio, poolAllowed } from '../shared/economics.js'
import { randomBytes } from 'node:crypto'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { walletOf } from '../money.js'
import { commitPool, draw, tryOpenPool, revealPool } from '../pools-service.js'

export const pools = new Hono()

type Row = Record<string, unknown>
// Hono 的 param() 型別是 string | undefined；路由有 :id 就一定有值
const pid = (c: { req: { param: (k: 'id') => string | undefined } }) => c.req.param('id') ?? ''

/** 對外的池資料。這裡決定什麼能出去 —— server_seed 只在 revealed 之後 */
function toPublic(p: Row, prizes: Row[], taken: number[]) {
  const revealed = p.status === 'revealed'
  return {
    id: p.id, sellerId: p.seller_id, sellerName: p.seller_name, origin: p.origin,
    mode: p.mode, title: p.title,
    coverFileId: p.cover_file_id, cover: '',
    ticketPrice: Number(p.ticket_price), totalTickets: Number(p.total_tickets),
    remainingTickets: Number(p.total_tickets) - taken.length,
    /* 開賣當下算的還元率。買家判斷一個池值不值得抽最直接的依據，
       而同業幾乎沒有人公開它。舊池沒有這個欄位就給 null，
       前端要能分辨「沒有這個數字」與「這個池還元率是 0」。 */
    returnRatio: p.return_ratio === null || p.return_ratio === undefined ? null : Number(p.return_ratio),
    takenSeats: taken,
    status: p.status,
    commitHash: p.commit_hash, clientSeedSource: p.client_seed_source,
    clientSeed: p.status === 'draft' || p.status === 'committed' ? null : p.client_seed,
    serverSeed: revealed ? p.server_seed : null,
    shiteiTier: p.shitei_tier ?? undefined, auctionSeats: p.auction_seats ?? undefined,
    prizes: prizes.map(x => ({ id: x.id, tier: x.tier, card: x.card, total: Number(x.total), remaining: Number(x.remaining) })),
    openedAt: p.opened_at, revealedAt: p.revealed_at
  }
}

async function loadPublic(id: string) {
  const [p] = await sql`
    select p.*, s.origin, s.name as seller_name from pools p join sellers s on s.id = p.seller_id where p.id = ${id}
  `
  if (!p) return null
  const prizes = await sql`
    select pp.*, (pp.total - count(ps.taken_by))::int as remaining
    from pool_prizes pp
    left join pool_seats ps on ps.prize_id = pp.id and ps.taken_by is not null
    where pp.pool_id = ${id} group by pp.id order by pp.tier
  `
  const taken = await sql<{ seat: number }[]>`
    select seat from pool_seats where pool_id = ${id} and taken_by is not null order by seat
  `
  return toPublic(p as Row, prizes as Row[], taken.map(t => Number(t.seat)))
}

pools.get('/', async c => {
  const rows = await sql`
    select id from pools where status in ('committed', 'open', 'sold_out', 'revealed')
    order by opened_at desc nulls last, created_at desc limit 100
  `
  const out = []
  for (const r of rows) { const p = await loadPublic(r.id as string); if (p) out.push(p) }
  return c.json({ pools: out })
})

pools.get('/:id', async c => {
  const p = await loadPublic(pid(c))
  if (!p) return c.json({ error: 'NOT_FOUND', message: '找不到這個池' }, 404)
  return c.json({ pool: p })
})

/** 已 revealed 的池：公布籤序，讓任何人可以用 shared/fairness.ts 重算 */
pools.get('/:id/reveal', async c => {
  const [p] = await sql`select * from pools where id = ${pid(c)}`
  if (!p) return c.json({ error: 'NOT_FOUND', message: '找不到這個池' }, 404)
  if (p.status !== 'revealed') return c.json({ error: 'NOT_REVEALED', message: '這個池還沒公布 seed' }, 409)
  /* taken_at 一起帶出來給「排出履歷」用。不帶 taken_by ——
     誰抽到什麼是個人資訊，履歷要證明的是「大獎真的在池裡、什麼時候被抽走」，
     不需要指名道姓。 */
  const seq = await sql<{ seat: number; prize_id: string; taken_at: string | null }[]>`
    select seat, prize_id, taken_at from pool_seats where pool_id = ${p.id} order by seat
  `
  const prizes = await sql<{
    id: string; total: number; tier: string; card: Record<string, unknown>
  }[]>`select id, total, tier, card from pool_prizes where pool_id = ${p.id}`

  /* v2 的池要一起吐出獎品清單，驗算端才重算得出 commit。
     這裡刻意**現在**從 pool_prizes 讀，不是讀一份存起來的快照 ——
     如果有人在開賣後改了獎品內容，這裡吐出來的就是改過的版本，
     重算的 commit 對不上，驗算就會抓到。存快照反而會把證據蓋掉。 */
  const manifest = p.manifest_hash
    ? prizes.map(x => {
        const cd = x.card as {
          name?: string; setCode?: string | null; cardNo?: string | null
          grader?: string | null; grade?: number | null; certNo?: string | null; refPrice?: number | null
        }
        return {
          prizeId: x.id, tier: x.tier, total: Number(x.total),
          name: cd.name ?? '', setCode: cd.setCode ?? null, cardNo: cd.cardNo ?? null,
          grader: cd.grader ?? null, grade: cd.grade ?? null,
          certNo: cd.certNo ?? null, refPrice: cd.refPrice ?? null
        }
      })
    : undefined

  return c.json({
    serverSeed: p.server_seed, commitHash: p.commit_hash,
    clientSeedSource: p.client_seed_source, clientSeed: p.client_seed,
    manifestHash: p.manifest_hash ?? null,
    manifest,
    prizes: prizes.map(x => ({ prizeId: x.id, total: Number(x.total) })),
    publishedSequence: seq.map(s => s.prize_id),
    /* 排出履歷：每一格開出什麼、什麼時候被抽走（沒被抽走的是 null）。
       日本業者的做法 —— 在「證明大獎真的在池裡」這件事上，
       它比雜湊更直接：一般人看不懂 SHA-256，但看得懂
       「第 47 號在 8/12 開出了噴火龍」。 */
    seats: seq.map(s => ({
      seat: Number(s.seat),
      prizeId: s.prize_id,
      takenAt: s.taken_at ? Number(s.taken_at) : null
    }))
  })
})

/* ---- 以下需要登入 ---- */

const PrizeIn = z.object({
  tier: z.enum(['A', 'B', 'C', 'D', 'LAST', 'BUST']),
  card: z.object({
    id: z.string(), name: z.string(), refPrice: z.number().int().nonnegative(),
    certNo: z.string().nullable().optional()
  }).passthrough(),
  total: z.number().int().nonnegative()
}).refine(p => !p.card.certNo || p.total <= 1, {
  /* 一個鑑定編號只對應一張實體卡。開 total > 1 等於宣告「這 N 個籤位都會
     發出同一張 PSA #xxxx」—— 那是平台聲稱要防的一卡多賣，卻由建池端自己打穿。
     後果不只是名不副實：listings_cert_live 是 unique(cert_no) where status='live'，
     所以第一個得主上架之後，其餘 N−1 個人上架全部被擋，
     而且會被告知「這張卡已經在市場上了」—— 他們的卡根本沒上架過。 */
  message: '有鑑定編號的卡只能開 1 籤 —— 一個編號對應一張實體卡'
})
const CreatePool = z.object({
  /* 只收 classic。這個檔案的抽卡邏輯（pools-service.ts）完全沒有讀 pools.mode ——
     收下其他模式等於讓賣家開一個標示著某種玩法、實際卻按一般池發獎的池，
     streak / auction 甚至會讓前端把玩家導去沒有後端的流程。
     前端也鎖了，但那只是不讓人誤按；直接打 API 的要在這裡擋。
     補上模式邏輯時把 enum 加回來。 */
  mode: z.enum(['classic']),
  title: z.string().min(1).max(60),
  ticketPrice: z.number().int().positive(),
  totalTickets: z.number().int().positive().max(5000),
  prizes: z.array(PrizeIn).min(1),
  shiteiTier: z.enum(['A', 'B', 'C', 'D', 'LAST']).optional(),
  auctionSeats: z.number().int().positive().optional(),
  coverFileId: z.string().optional()
})

/**
 * 建池 + 立刻 commit。
 * 只有賣家能建；賣家等級 pending 不能開賣（DESIGN.md：不開放完全匿名上架）。
 */
pools.post('/', requireAuth, async c => {
  const me = c.get('userId')
  const parsed = CreatePool.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? '參數不合法' }, 400)
  const b = parsed.data
  const [s] = await sql`select tier from sellers where id = ${me}`
  if (!s) return c.json({ error: 'NOT_SELLER', message: '請先申請成為賣家' }, 403)
  if (s.tier === 'pending') return c.json({ error: 'SELLER_PENDING', message: '賣家審核通過後才能開池' }, 403)
  const sum = b.prizes.reduce((a, p) => a + p.total, 0)
  if (sum !== b.totalTickets) {
    return c.json({ error: 'BAD_REQUEST', message: `獎品總數 ${sum} 必須等於籤數 ${b.totalTickets}` }, 400)
  }

  /* 還元率護欄。原本這套判斷只存在於前端的 lib/economics.ts —— 也就是說
     「還元率不合理就不給開」**只在瀏覽器裡**，直接打這支 API 就能繞過。
     門檻與前端共用 shared/economics.ts，不會分岔。 */
  const { ratio } = returnRatio(
    b.prizes.map(p => ({ tier: p.tier, qty: p.total, unitValue: p.card.refPrice })),
    b.totalTickets, b.ticketPrice
  )
  const gate = poolAllowed(ratio)
  if (!gate.allowed) {
    return c.json({
      error: 'BAD_ECONOMICS',
      message: gate.verdict === 'loss'
        ? `${gate.message}最常見的原因是獎品的參考價填錯了。`
        : `${gate.message}平台不接受這樣的池。`
    }, 400)
  }

  const id = 'p-' + randomBytes(5).toString('hex')
  try {
    const result = await sql.begin(async tx => {
      await tx`
        insert into pools (id, seller_id, mode, title, cover_file_id, ticket_price, total_tickets,
                           shitei_tier, auction_seats, return_ratio)
        values (${id}, ${me}, ${b.mode}, ${b.title}, ${b.coverFileId ?? null}, ${b.ticketPrice}, ${b.totalTickets},
                ${b.shiteiTier ?? null}, ${b.auctionSeats ?? null}, ${ratio.toFixed(2)})
      `
      const rows = b.prizes.map((p, i) => ({
        id: `${id}-pr${i}`, pool_id: id, tier: p.tier, card: p.card, total: p.total
      }))
      await tx`insert into pool_prizes ${tx(rows as never)}`
      return commitPool(tx, id)
    })
    return c.json({ poolId: id, ...result })
  } catch (e) {
    return c.json({ error: 'COMMIT_FAILED', message: e instanceof Error ? e.message : '建池失敗' }, 502)
  }
})

/**
 * committed → open。任何人可以觸發（drand round 到了就能開），
 * 結果由資料決定不由呼叫者決定，所以不需要權限。
 */
pools.post('/:id/open', requireAuth, async c => {
  try {
    const opened = await tryOpenPool(pid(c))
    return c.json({ opened, message: opened ? '已開賣' : '外部亂數還沒到，稍後再試' })
  } catch (e) {
    return c.json({ error: 'WRONG_STATE', message: e instanceof Error ? e.message : '無法開池' }, 409)
  }
})

const DrawBody = z.object({
  seats: z.array(z.number().int().positive()).min(1).max(50),
  idempotencyKey: z.string().min(8).max(128)
})

/**
 * 抽選。全成功或全失敗，衝突回 SEATS_TAKEN + 清單。
 * 交易在 draw() 回 ok:false 時要回滾 —— 用 throw 讓 sql.begin 幫我們回滾。
 */
pools.post('/:id/draw', requireAuth, async c => {
  const me = c.get('userId')
  const parsed = DrawBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
  const { seats, idempotencyKey } = parsed.data
  const poolId = pid(c)

  const [dup] = await sql`select order_id as draw_id from idempotency where key = ${idempotencyKey}`
  if (dup) {
    const [d] = await sql`select * from draws where id = ${dup.draw_id}`
    return c.json({ replay: true, draw: d ?? null })
  }

  const drawId = 'd-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex')
  class Rollback extends Error { constructor(public out: unknown) { super('rollback') } }
  try {
    const out = await sql.begin(async tx => {
      const r = await draw(tx, me, poolId, seats, drawId, Date.now())
      if (!r.ok) throw new Rollback(r)
      await tx`insert into idempotency (key, user_id, order_id) values (${idempotencyKey}, ${me}, ${drawId})`
      return r
    })
    return c.json({ ...out, wallet: await walletOf(me) })
  } catch (e) {
    if (e instanceof Rollback) {
      const r = e.out as { error: string; taken?: number[] }
      const status = r.error === 'INSUFFICIENT_POINTS' ? 402 : r.error === 'BAD_SEATS' ? 400 : 409
      return c.json({ error: r.error, taken: r.taken, message: MSG[r.error] ?? '抽選失敗' }, status)
    }
    throw e
  }
})

const MSG: Record<string, string> = {
  SEATS_TAKEN: '有籤位剛被別人抽走了，請重選',
  POOL_NOT_OPEN: '這個池目前不能抽',
  INSUFFICIENT_POINTS: '可動用點數不足',
  BAD_SEATS: '籤位不合法'
}

/** sold_out → revealed。賣家或平台都可以按 */
/**
 * open → cancelled（提前收攤）。
 *
 * 這條路原本不存在，而缺它的代價落在買家身上不是賣家：reveal 只接受
 * sold_out，所以一個賣不完的池永遠不會揭曉 server_seed ——
 * **已經在裡面抽過的人永遠無法驗證自己那一抽**。這個平台的賣點就是可驗證，
 * 卻有一條路會讓它永遠驗不到。
 *
 * 收攤不需要退款：沒賣掉的籤本來就沒人付錢，已經抽過的人卡也拿到了。
 * 收攤只是停止繼續賣，並讓揭曉變得可能。
 */
pools.post('/:id/close', requireAuth, async c => {
  const me = c.get('userId')
  const [p] = await sql`select seller_id, status from pools where id = ${pid(c)}`
  if (!p) return c.json({ error: 'NOT_FOUND', message: '找不到這個池' }, 404)
  const [u] = await sql`select role from users where id = ${me}`
  if (p.seller_id !== me && u?.role !== 'admin') {
    return c.json({ error: 'NOT_PARTY', message: '只有開池的賣家或平台可以收攤' }, 403)
  }
  if (p.status !== 'open') {
    return c.json({ error: 'WRONG_STATE', message: `這個池目前是「${p.status}」，不能收攤` }, 409)
  }
  await sql`update pools set status = 'cancelled' where id = ${pid(c)}`
  // 揭曉交給背景掃描 —— 它已經在處理 sold_out 與 cancelled 了
  return c.json({ ok: true, message: '已收攤，稍後會自動揭曉並公開種子' })
})

pools.post('/:id/reveal', requireAuth, async c => {
  const me = c.get('userId')
  const [p] = await sql`select seller_id from pools where id = ${pid(c)}`
  const [u] = await sql`select role from users where id = ${me}`
  if (!p || (p.seller_id !== me && u?.role !== 'admin')) return c.json({ error: 'NOT_PARTY', message: '沒有權限' }, 403)
  try {
    await sql.begin(tx => revealPool(tx, pid(c)))
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: 'WRONG_STATE', message: e instanceof Error ? e.message : '無法公布' }, 409)
  }
})
