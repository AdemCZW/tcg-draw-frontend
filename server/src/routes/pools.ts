/**
 * 池與抽選。
 *
 * 讀取端點是公開的（逛池不用登入），抽選要登入。
 * server_seed 在 revealed 之前絕對不會出現在任何回應裡 —— toPublic() 是唯一的出口。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { floorRatio, floorAllowed } from '../shared/economics.js'
import { randomBytes } from 'node:crypto'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { walletOf } from '../money.js'
import { commitPool, draw, tryOpenPool, revealPool } from '../pools-service.js'
import {
  BUYBACK_MAX, BUYBACK_MIN,
  FIRST_POOL_TICKET_CAP, FIRST_POOL_VALUE_CAP, PLATFORM_FEE_RATE,
  POOL_DEFAULT_DAYS, POOL_MAX_DAYS, SELLER_DEFAULT_LIMIT
} from '../shared/pool-settlement.js'

export const pools = new Hono()

type Row = Record<string, unknown>
// Hono 的 param() 型別是 string | undefined；路由有 :id 就一定有值
const pid = (c: { req: { param: (k: 'id') => string | undefined } }) => c.req.param('id') ?? ''

/** 對外的池資料。這裡決定什麼能出去 —— server_seed 只在 revealed 之後 */
function toPublic(p: Row, prizes: Row[], taken: number[], publicTaken: number) {
  const revealed = p.status === 'revealed'
  return {
    id: p.id, sellerId: p.seller_id, sellerName: p.seller_name, origin: p.origin,
    mode: p.mode, title: p.title,
    coverFileId: p.cover_file_id, cover: '',
    ticketPrice: Number(p.ticket_price), totalTickets: Number(p.total_tickets),
    /* 剩餘籤數**不算賣家自抽的那幾籤**。
       自抽本身不禁止（錢從自己流到自己，沒有新點數被創造），但如果它會
       推動公開的進度條，賣家就可以把「剩 3/50」刷出來誘導真人跟進 ——
       那是這個模型下唯一殘留的濫用面，所以擋在顯示這一層。
       takenSeats 仍然是完整的：那是功能性的資料，前端靠它把已售的格子畫成
       不可選，少了自抽的格子會讓玩家點下去才收到 SEATS_TAKEN。
       兩者因此不一定滿足 remainingTickets = totalTickets − takenSeats.length，
       這是刻意的，不要「修正」成一致。 */
    remainingTickets: Number(p.total_tickets) - publicTaken,
    /* 開賣當下算的**保底回饋率** ＝ Σ(宣告買回價 × 數量) ÷ 票收。
       分子是賣家有義務付出去的錢，不是他喊的市值 —— 這是這個數字跟
       returnRatio 最重要的差別。null = 這個池沒有宣告過買回價（舊池）。 */
    floorRatio: p.floor_ratio == null ? null : Number(p.floor_ratio),
    /* 舊制的還元率（Σ 賣家標示市值 ÷ 票收）。**只有舊池有**，留著是因為
       那是它們開賣當下對外宣告過的數字，不能事後改寫成一個算不出來的新數字。
       前端顯示它時必須標明是「賣家標示的市值」，不是承諾。 */
    returnRatio: p.return_ratio === null || p.return_ratio === undefined ? null : Number(p.return_ratio),
    /* 這個池用哪一版 manifest 規則做的承諾。驗算端照它重算，不「依序嘗試」 */
    commitVersion: p.commit_version == null ? null : Number(p.commit_version),
    takenSeats: taken,
    status: p.status,
    commitHash: p.commit_hash, clientSeedSource: p.client_seed_source,
    clientSeed: p.status === 'draft' || p.status === 'committed' ? null : p.client_seed,
    serverSeed: revealed ? p.server_seed : null,
    shiteiTier: p.shitei_tier ?? undefined,
    /* buyback 要在**抽卡前**就看得到。抽完才知道能買回多少就是釣魚 ——
       這是這個欄位出現在公開池快照裡的全部理由。 */
    prizes: prizes.map(x => ({
      id: x.id, tier: x.tier, card: x.card,
      total: Number(x.total), remaining: Number(x.remaining),
      buyback: x.buyback == null ? null : Number(x.buyback)
    })),
    /* 到期日。時間到就關池、停止販售，未售出籤位的卡回到賣家手上。
       null = 舊池，沒有到期日 */
    expiresAt: p.expires_at == null ? null : Number(p.expires_at),
    openedAt: p.opened_at, revealedAt: p.revealed_at
  }
}

async function loadPublic(id: string) {
  const [p] = await sql`
    select p.*, s.origin, s.name as seller_name from pools p join sellers s on s.id = p.seller_id where p.id = ${id}
  `
  if (!p) return null
  /* 各賞別的剩餘數同樣排除賣家自抽 —— 「A 賞還剩 1 張」是玩家決定要不要跟進
     最直接的依據，那個數字被自抽推動就等於誘餌。條件寫在 join 上而不是
     where 上：寫在 where 會把「一張都沒被抽走」的獎項整列濾掉。 */
  const prizes = await sql`
    select pp.*, (pp.total - count(ps.taken_by))::int as remaining
    from pool_prizes pp
    left join pool_seats ps
      on ps.prize_id = pp.id and ps.taken_by is not null and ps.taken_by <> ${p.seller_id as string}
    where pp.pool_id = ${id} group by pp.id order by pp.tier
  `
  const taken = await sql<{ seat: number }[]>`
    select seat from pool_seats where pool_id = ${id} and taken_by is not null order by seat
  `
  const [pub] = await sql<{ n: string }[]>`
    select count(*)::text as n from pool_seats
     where pool_id = ${id} and taken_by is not null and taken_by <> ${p.seller_id as string}
  `
  return toPublic(p as Row, prizes as Row[], taken.map(t => Number(t.seat)), Number(pub?.n ?? 0))
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
    id: string; total: number; tier: string; card: Record<string, unknown>; buyback: string | null
  }[]>`select id, total, tier, card, buyback from pool_prizes where pool_id = ${p.id}`

  /* 這個池宣告的 manifest 版本。舊池的 commit_version 由 migration 018 依
     manifest_hash 是不是 null 回填成 1 或 2；新池一律 3。
     驗算端照這個版本重算，**不「依序嘗試」**——那等於接受「任何一版算得過就好」，
     一個作弊的伺服器可以挑對自己有利的那一版送出。 */
  const version = Number(p.commit_version ?? (p.manifest_hash ? 2 : 1))

  /* v2 以上的池要一起吐出獎品清單，驗算端才重算得出 commit。
     這裡刻意**現在**從 pool_prizes 讀，不是讀一份存起來的快照 ——
     如果有人在開賣後改了獎品內容（包括偷改買回價），這裡吐出來的就是改過的
     版本，重算的 commit 對不上，驗算就會抓到。存快照反而會把證據蓋掉。 */
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
          certNo: cd.certNo ?? null, refPrice: cd.refPrice ?? null,
          /* v2 的池這一欄一定是 null，而 v2 的序列化根本不讀它 ——
             帶出來只是為了讓驗算頁面看得到買回價，不影響雜湊。 */
          buyback: x.buyback == null ? null : Number(x.buyback)
        }
      })
    : undefined

  return c.json({
    serverSeed: p.server_seed, commitHash: p.commit_hash,
    clientSeedSource: p.client_seed_source, clientSeed: p.client_seed,
    manifestHash: p.manifest_hash ?? null,
    manifestVersion: version,
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

/* refPrice 的絕對上限。
   這個欄位現在**只是顯示**（賣家標示的參考價，不構成承諾，不參與任何金額計算），
   而且**可以完全不填** —— 它已經沒有任何計算上的用途，強迫賣家填一個
   沒有外部依據的數字只會製造一個看起來像官方行情的假資料。
   有填的話上限還是要有：它進得了 JSON、會出現在卡冊總值與排行榜上，
   也讓 numeric 運算有機會溢位成 500。 */
const REF_PRICE_MAX = 10_000_000

const TIERS = ['A', 'B', 'C', 'D', 'LAST', 'BUST'] as const
type TierName = (typeof TIERS)[number]

const buybackAmount = z.number().int()
  .min(BUYBACK_MIN, `買回價至少 ${BUYBACK_MIN} 點 —— 低於這個數字等於沒有買回`)
  .max(BUYBACK_MAX, `買回價不能超過 ${BUYBACK_MAX.toLocaleString('zh-TW')} 點`)

const PrizeIn = z.object({
  tier: z.enum(TIERS),
  card: z.object({
    id: z.string(), name: z.string(),
    /* 不填就是「賣家沒有標示參考價」，存成 null。
       **不要退回成 0** —— 0 在畫面上讀起來是「這張卡不值錢」，
       那跟「沒有標示」是兩件完全不同的事。 */
    refPrice: z.number().int().nonnegative()
      .max(REF_PRICE_MAX, `參考價不能超過 ${REF_PRICE_MAX.toLocaleString('zh-TW')}`)
      .nullable().optional(),
    certNo: z.string().nullable().optional()
  }).passthrough(),
  /* 這一項的買回價。**選填 —— 它是「覆寫」不是「必填」。**
     一般情況下買回價按賞別給（見 CreatePool.tierBuyback），這裡只處理例外：
     同一個賞別裡某一張特別貴的時候單獨指定。 */
  buyback: buybackAmount.optional(),
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
  /* 只收 muteki（無敵賞）。這是唯一「標示等於實際」的玩法：pools-service.ts 的
     draw() 沒有讀過 pools.mode，它的行為就是「最後賞是籤池裡的一張普通獎品，
     抽走最後一籤不加送」—— 那正是無敵賞的定義。原本這裡收的是 classic，
     但 classic 的賣點（抽走最後一籤額外得最後賞）後端一行都沒有（見 migration 016）。
     其餘兩種收下來只會開出標示著某種玩法、實際照無敵賞發獎的池。
     （原本還有 streak / auction，前端那兩套介面已整組移除 —— 後端零實作，
     留著只是把死路做得像活路。）
     前端也鎖了，但那只是不讓人誤按；直接打 API 的要在這裡擋，
     資料庫的 check 是最後一道（016）。補上模式邏輯時再把該玩法加回三個地方。 */
  mode: z.enum(['muteki']),
  title: z.string().min(1).max(60),
  ticketPrice: z.number().int().positive(),
  totalTickets: z.number().int().positive().max(5000),
  prizes: z.array(PrizeIn).min(1),
  shiteiTier: z.enum(['A', 'B', 'C', 'D', 'LAST']).optional(),
  coverFileId: z.string().optional(),
  /* 販售天數。池一定要有到期日 —— 沒有到期日的池會把賣家的獎品與買家的
     期待無限期綁住，而且「大獎還沒出」可以永遠掛在首頁上。
     不給就用預設值，不允許不設。 */
  days: z.number().int().positive().max(POOL_MAX_DAYS).default(POOL_DEFAULT_DAYS),
  /**
   * 買回價的賞別預設：一個賞別一個絕對金額。
   *
   * 為什麼是「賞別」而不是「每張卡」也不是「一個比率」：
   *   - 比率要有基準，而唯一的基準是賣家自填的市值 —— 那是循環論證，
   *     正是這次要擺脫的東西。
   *   - 每張卡一個金額在資料上是對的（下面就是這樣存的），但要賣家在
   *     一個 250 籤的池上填 250 次不現實。
   *   - 同一個賞別裡的卡價值本來就相近 —— 那正是分賞別的意義。
   *     所以整池只要四五個絕對金額，不需要任何基準。
   *
   * **存進資料庫與 manifest 的仍然是每個獎品的絕對金額**（解析後的值）。
   * 賞別預設只是填表的來源，不是儲存的形式 —— 承諾鎖住的是每一項的實際金額，
   * 不是一組事後可以重新解讀的規則。
   */
  tierBuyback: z.object(
    Object.fromEntries(TIERS.map(t => [t, buybackAmount.optional()])) as
      Record<TierName, z.ZodOptional<typeof buybackAmount>>
  ).partial().optional()
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
  const [s] = await sql`select tier, default_count from sellers where id = ${me}`
  if (!s) return c.json({ error: 'NOT_SELLER', message: '請先申請成為賣家' }, 403)
  if (s.tier === 'pending') return c.json({ error: 'SELLER_PENDING', message: '賣家審核通過後才能開池' }, 403)

  /* 違約門檻。逾期未出貨會從保留額退還買家並累計違約次數；
     累到門檻就不能再開池。沒有保證金，所以這是唯一擋得住連續違約的手段 ——
     擋在「能不能開新池」而不是「能不能抽」：已經在跑的池要讓它把出貨與
     鑑賞期走完，中途凍結只會讓已經付錢的買家更難拿到卡。 */
  if (Number(s.default_count ?? 0) >= SELLER_DEFAULT_LIMIT) {
    return c.json({
      error: 'SELLER_SUSPENDED',
      message: `你有 ${s.default_count} 次逾期未出貨的紀錄，已達 ${SELLER_DEFAULT_LIMIT} 次上限，暫時不能開新池。請聯絡平台。`
    }, 403)
  }

  /* 新賣家的第一個池有額度上限。
     沒有保證金，所以這是替代手段：把第一次違約的最大損失壓住。
     「新」的定義是「還沒有任何一個池走完生命週期」—— 用 revealed / cancelled
     而不是「開過幾個池」，因為同時開十個池然後全部不出貨正是要防的那件事。 */
  const [done] = await sql<{ n: string }[]>`
    select count(*)::text as n from pools
     where seller_id = ${me} and status in ('revealed', 'cancelled')
  `
  if (Number(done?.n ?? 0) === 0) {
    const value = b.ticketPrice * b.totalTickets
    if (b.totalTickets > FIRST_POOL_TICKET_CAP || value > FIRST_POOL_VALUE_CAP) {
      return c.json({
        error: 'FIRST_POOL_CAP',
        message: `第一個池的上限是 ${FIRST_POOL_TICKET_CAP} 籤、票收 ${FIRST_POOL_VALUE_CAP.toLocaleString('zh-TW')} 點。這個池是 ${b.totalTickets} 籤、票收 ${value.toLocaleString('zh-TW')} 點。完成第一個池之後就會解除。`
      }, 403)
    }
  }

  /* 把「賞別預設 + 個別覆寫」解析成每個獎品的絕對金額。
     解析在**建池當下**做一次，之後資料庫裡就只有絕對金額 ——
     存規則的話，改一次賞別預設就等於回頭改寫已經公布的承諾。 */
  const resolved: number[] = []
  for (const p of b.prizes) {
    const v = p.buyback ?? b.tierBuyback?.[p.tier]
    if (v == null) {
      return c.json({
        error: 'BAD_REQUEST',
        message: `${p.tier === 'BUST' ? '爆賞' : p.tier === 'LAST' ? '最後賞' : p.tier + ' 賞'}` +
          `還沒有買回價。每個賞別都要給一個金額，或是替這一項單獨指定。`
      }, 400)
    }
    resolved.push(v)
  }

  const sum = b.prizes.reduce((a, p) => a + p.total, 0)
  if (sum !== b.totalTickets) {
    return c.json({ error: 'BAD_REQUEST', message: `獎品總數 ${sum} 必須等於籤數 ${b.totalTickets}` }, 400)
  }

  /* 保底回饋率護欄。原本這套判斷只存在於前端的 lib/economics.ts —— 也就是說
     「數字不合理就不給開」**只在瀏覽器裡**，直接打這支 API 就能繞過。
     門檻與前端共用 shared/economics.ts，不會分岔。

     只有一道閘就夠了，舊版需要兩道是因為公開展示不算 BUST、回收卻對每一種
     賞別都付點 —— 那條縫就是印鈔機。買回價每一種賞別都要宣告，縫消失了。
     這道閘同時堵住兩件事：Σ(買回價) ≥ 票收（抽光再全部買回有利可圖），
     以及保底低到形同沒有。 */
  const { ratio, floorValue } = floorRatio(
    b.prizes.map((p, i) => ({ tier: p.tier, qty: p.total, buyback: resolved[i]! })),
    b.totalTickets, b.ticketPrice
  )
  const gate = floorAllowed(ratio)
  if (!gate.allowed) {
    return c.json({
      error: 'BAD_ECONOMICS',
      message: gate.verdict === 'mint'
        ? `${gate.message}買回價總和 ${floorValue.toLocaleString('zh-TW')} 點，票收只有 ${(b.totalTickets * b.ticketPrice).toLocaleString('zh-TW')} 點。`
        : `${gate.message}平台不接受這樣的池。`
    }, 400)
  }

  const id = 'p-' + randomBytes(5).toString('hex')
  try {
    const result = await sql.begin(async tx => {
      await tx`
        insert into pools (id, seller_id, mode, title, cover_file_id, ticket_price, total_tickets,
                           shitei_tier, floor_ratio, expires_at, platform_fee_rate)
        values (${id}, ${me}, ${b.mode}, ${b.title}, ${b.coverFileId ?? null}, ${b.ticketPrice}, ${b.totalTickets},
                ${b.shiteiTier ?? null},
                /* 開賣當下算的保底回饋率。之後 refPrice 怎麼浮動都不改它 ——
                   它是承諾的一部分，而且分子（買回價）本來就被 commit 鎖死了。
                   return_ratio 不寫：那一欄存的是舊制「賣家標示市值 ÷ 票收」，
                   意義不同，混在同一欄會讓買家在同一個標籤下看到兩種東西。 */
                ${ratio.toFixed(2)},
                ${Date.now() + b.days * 86_400_000},
                /* 抽成寫死在池上，不是每次結算去讀全站常數 ——
                   票賣出去之後才調整抽成等於片面改約 */
                ${PLATFORM_FEE_RATE})
      `
      const rows = b.prizes.map((p, i) => ({
        id: `${id}-pr${i}`, pool_id: id, tier: p.tier,
        // refPrice 沒填就明確存 null（不是 0，也不是「沒有這個鍵」）
        card: { ...p.card, refPrice: p.card.refPrice ?? null },
        total: p.total,
        // 解析後的絕對金額。manifest 與回收都只看這一欄
        buyback: resolved[i]!
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

  /* 一定要連 user_id 一起比。只比 key 的話，鍵是呼叫端自己產生的字串，
     拿到別人的鍵重放一次就會拿到別人那一抽的內容 —— 冪等是「同一個人的同一個請求
     只做一次」，不是「這把字串全站只做一次」。別人的鍵對你等於沒用過，
     照常建立；真的撞到同一個籤位會被既有的 FOR UPDATE 與唯一索引擋下。 */
  const [dup] = await sql`
    select order_id as draw_id from idempotency where key = ${idempotencyKey} and user_id = ${me}
  `
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
  POOL_EXPIRED: '這個池已經到期，停止販售了',
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
