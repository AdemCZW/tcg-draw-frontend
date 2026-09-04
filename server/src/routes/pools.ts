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
import { sql, Rollback } from '../db.js'
import { requireAuth } from '../auth.js'
import { walletOf } from '../money.js'
import { commitPool, draw, tryOpenPool, revealPool, STASH_DAYS } from '../pools-service.js'
import { REF_PRICE_MAX } from '../card-cert.js'
import { POINTS_INPUT_MAX, pointsInputMaxText } from '../limits.js'
import { publicCard } from '../card-public.js'
import {
  BUYBACK_MAX, BUYBACK_MIN,
  FIRST_POOL_TICKET_CAP, FIRST_POOL_VALUE_CAP, PLATFORM_FEE_RATE,
  POOL_DEFAULT_DAYS, POOL_MAX_DAYS, SELLER_DEFAULT_LIMIT
} from '../shared/pool-settlement.js'

export const pools = new Hono()

type Row = Record<string, unknown>
// Hono 的 param() 型別是 string | undefined；路由有 :id 就一定有值
const pid = (c: { req: { param: (k: 'id') => string | undefined } }) => c.req.param('id') ?? ''

/** 卡片狀態的白話。狀態機的字不該原樣丟給使用者（跟 routes/cardbook.ts 同一份） */
const STATUS_LABEL: Record<string, string> = {
  in_book: '閒置在卡冊',
  in_pool: '押在另一個池裡',
  stashed: '在保管庫（抽中後寄存）',
  listed: '掛在市場上',
  ship_requested: '出貨申請中',
  shipped: '已出貨',
  recycled: '已回收',
  refunded: '已退款'
}

/** 錯誤訊息裡指名是哪一張卡。指不出來時說「這張卡」，不要印出 id */
function cardName(card: unknown): string {
  const n = (card as { name?: unknown } | null)?.name
  return typeof n === 'string' && n.trim() ? n.trim() : '這張卡'
}

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
    /* card 走 publicCard() 白名單（A-6）：這是**展示**用的池快照，不用登入、
       全站可見，整包 jsonb 直出等於把每一張獎品的鑑定編號送給所有人 ——
       一卡多賣的防線（同一個編號全站只能登記一次）正是綁在那個編號上。
       ⚠️ revealed 的 manifest（下面 /:id/reveal）**不能**照做：certNo 是
       manifest v2 以上的序列化輸入，既有池的 commit hash 就是拿它算出來的，
       遮掉它會讓現有每一個池的驗算全部失敗。展示與公平性證據是兩件事，
       這裡分開處理就是那一條界線。 */
    prizes: prizes.map(x => ({
      id: x.id, tier: x.tier, card: publicCard(x.card),
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
     manifest_hash 是不是 null 回填成 1 或 2；新池一律 4（見 COMMIT_VERSION）。
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
          grader?: string | null; grade?: number | null; certNo?: string | null
          refPrice?: number | null; variantId?: string | null
        }
        return {
          prizeId: x.id, tier: x.tier, total: Number(x.total),
          name: cd.name ?? '', setCode: cd.setCode ?? null, cardNo: cd.cardNo ?? null,
          grader: cd.grader ?? null, grade: cd.grade ?? null,
          certNo: cd.certNo ?? null, refPrice: cd.refPrice ?? null,
          /* v2 的池這一欄一定是 null，而 v2 的序列化根本不讀它 ——
             帶出來只是為了讓驗算頁面看得到買回價，不影響雜湊。 */
          buyback: x.buyback == null ? null : Number(x.buyback),
          /* 同理：v3 以下的序列化不讀 variantId，帶出來不影響它們的雜湊。
             v4 的池則是靠這一欄才驗得出「開賣後有沒有被換成同卡號的另一版」。
             這裡一樣是**現在**從 pool_prizes 讀，不是讀快照 ——
             有人偷改了 card->>'variantId'，吐出來的就是改過的值，
             重算的 commit 對不上，驗算就抓到了。 */
          variantId: cd.variantId ?? null
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

/* refPrice 的絕對上限 —— 定義與理由搬到 src/card-cert.ts（卡冊上傳共用）。 */

const TIERS = ['A', 'B', 'C', 'D', 'LAST', 'BUST'] as const
type TierName = (typeof TIERS)[number]

const buybackAmount = z.number().int()
  .min(BUYBACK_MIN, `買回價至少 ${BUYBACK_MIN} 點 —— 低於這個數字等於沒有買回`)
  .max(BUYBACK_MAX, `買回價不能超過 ${BUYBACK_MAX.toLocaleString('zh-TW')} 點`)

const PrizeIn = z.object({
  tier: z.enum(TIERS),
  /**
   * 這個獎品押的是卡冊裡哪一列實體卡（A-4）。
   *
   * ── 為什麼要有這一欄 ──────────────────────────────────────────────
   * 在這一欄出現之前，只有**帶鑑定編號**的獎品會在 prizes 開一列並轉成
   * in_pool（023）。裸卡沒有這條路：它用自由填寫的 `card` jsonb 反覆宣告，
   * 沒有任何一列既有的卡被鎖住，於是**同一張實體裸卡可以同時放進無限多個池**
   * （實測：同一張卡連開五個池，五次全部 200，卡冊裡 in_pool 的列數是 0）。
   * prizes_cert_alive（unique(grader, cert_no)）擋得住帶編號的，裸卡沒有編號，
   * 索引蓋不到 —— 只有「一張實體卡一列、一列只有一個 status」這個**結構保證**
   * 蓋得到（inventory-first-plan.md 5.4）。
   *
   * 帶了這一欄，那一列會在同一個交易裡被 FOR UPDATE 鎖住、檢查是不是
   * **自己的、而且 in_book**，然後轉成 in_pool。押第二次時它已經不是 in_book，
   * 直接被擋 —— 不論有沒有鑑定編號。
   *
   * ── 為什麼還是 optional ───────────────────────────────────────────
   * 這一輪**沒有**把它改成必填。必填是對的方向（見 docs/open-issues.md A-4），
   * 但那是一個破壞性的 API 變更：`server/src/smoke.ts` 有十幾處直接送
   * 內嵌卡片（沒有 prizeId、而且 total > 1）並斷言建池成功，而那支檔案
   * 由另一條工作線持有、這一輪不能改。缺口與收掉它的代價寫在回報裡。
   *
   * 沒帶這一欄時走的仍然是舊路徑（帶編號 → 023 的重用／新增；裸卡 → 不押記）。
   */
  prizeId: z.string().min(1).max(80).nullable().optional(),
  card: z.object({
    id: z.string(), name: z.string(),
    /* 不填就是「賣家沒有標示參考價」，存成 null。
       **不要退回成 0** —— 0 在畫面上讀起來是「這張卡不值錢」，
       那跟「沒有標示」是兩件完全不同的事。 */
    refPrice: z.number().int().nonnegative()
      .max(REF_PRICE_MAX, `參考價不能超過 ${REF_PRICE_MAX.toLocaleString('zh-TW')}`)
      .nullable().optional(),
    certNo: z.string().nullable().optional(),
    /* 卡片變體（TCGdex 的 variantId）。**選填但一旦有值就進承諾**：
       它跟卡名、鑑定編號一樣是「這是哪一張卡」的一部分（manifest v4），
       開賣後改不了。同一組卡號的普卡與大師球鏡面實測差約 18,000 倍，
       少了這一欄，那兩張卡在承諾裡是同一個東西。

       長度上限是防呆不是規則：這個值會逐字進雜湊的輸入，
       一個超長字串塞進來只會讓 manifest 難以人工核對。 */
    variantId: z.string().max(120).nullable().optional()
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
}).refine(p => !p.prizeId || p.total === 1, {
  /* 押記的是**一張實體卡**，所以它只能開一籤 —— 這是 total > 1 在
     卡冊優先之下的答案：那個語意沒有消失，它換了位置。
     以前「同一款卡開 10 籤」是一列 pool_prizes 的 total = 10；
     現在是**十列** pool_prizes，各自押著十張不同的實體卡。
     `pool_prizes.card_id` 是單一外鍵，一列只指得到一張卡；讓 total > 1
     的那一列帶 card_id，等於宣告「這 10 個籤位都會發出同一張實體卡」——
     正是這一條要修的一卡多池，只是換成一卡多籤。
     （另一種做法是把指標下放到 pool_seats.card_id，見
     inventory-first-plan.md 3.4 —— 那會新增一個「幾號籤中哪張卡」的
     洩漏面，這一輪刻意不開。） */
  message: '從卡冊挑的卡只能開 1 籤 —— 一張實體卡對應一個籤位。要開 N 籤請挑 N 張卡'
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
  /* 票價的上界是**荒謬值防線，不是票價上限**（見 src/limits.ts）。
     票價會進 bigint 欄位、也會乘上籤數去算票收，沒有上界的話一個
     `1e308` 就讓 numeric 溢位成 500 —— 使用者打錯字被講成伺服器故障。

     今天這條路多半走不到：下面的保底回饋率閘（floorAllowed）會先擋下
     天文票價，因為單張買回價封頂一千萬，票收一大保底比率就趨近 0。
     但那是**經濟規則順手擋到的**，不是驗證。經濟規則本來就會被調整
     （買回價上限改一次、加一種新玩法，這道側門就開了），
     而「金額欄位不准是天文數字」跟經濟規則怎麼調沒有關係，
     所以它要有自己的一道閘，寫在自己該在的地方。 */
  ticketPrice: z.number().int().positive()
    .max(POINTS_INPUT_MAX, `票價不能超過 ${pointsInputMaxText()} 點`),
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

  /* 同一張卡不能在同一個池裡出現兩次。
     少了這一條，一卡多池被擋下之後還剩一卡多籤：兩個獎項指著同一個
     prizeId，第一個把它轉成 in_pool，第二個看到的已經不是 in_book ——
     那會回一句「這張卡在別的池裡」，而它其實就在**這個**池裡，
     使用者照著那句話去找不存在的另一個池。在這裡先講清楚。 */
  const seenPledge = new Set<string>()
  for (const p of b.prizes) {
    const wantId = (p.prizeId ?? '').trim()
    if (!wantId) continue
    if (seenPledge.has(wantId)) {
      return c.json({
        error: 'CARD_DUPLICATED',
        message: `「${p.card.name}」在這個池裡出現了兩次 —— 一張實體卡只能放進一個籤位。`
          + '要開兩籤請挑兩張卡。'
      }, 400)
    }
    seenPledge.add(wantId)
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
      /* ── 第一段：先無鎖找出這筆交易會動到的 prizes 列 ───────────────
         兩種來源：呼叫端指名的 prizeId，以及舊路徑靠 (grader, cert_no)
         查出來的那一列。兩種都要在**同一次**批次上鎖裡鎖掉 ——
         分兩次鎖就等於兩個不同的 id 區間，交錯的兩筆交易又是一個死結環。

         這一段刻意不上鎖，跟 sweepSettlements 的兩階段是同一個模式：
         候選名單可能是舊的（查完到上鎖之間有人動了那一列），
         所以下面拿到鎖之後讀的是**鎖住的那一份**，不是這裡查到的值。 */
      const pledgeIds: string[] = []
      const certRowId = new Map<number, string>()
      for (let i = 0; i < b.prizes.length; i++) {
        const src = b.prizes[i]!
        const wantId = (src.prizeId ?? '').trim()
        if (wantId) { pledgeIds.push(wantId); continue }
        const certRaw = typeof src.card.certNo === 'string' ? src.card.certNo.trim() : ''
        if (!certRaw) continue
        const graderRaw = typeof src.card.grader === 'string' ? src.card.grader.trim() : ''
        const normGrader = graderRaw ? graderRaw.toUpperCase() : null
        const [cand] = await tx<{ id: string }[]>`
          select id from prizes
           where grader is not distinct from ${normGrader}::text and cert_no = ${certRaw}
        `
        if (cand) { certRowId.set(i, cand.id); pledgeIds.push(cand.id) }
      }

      /* ── 第二段：把這個交易要動到的 prizes 列**一次鎖完** ──────────
         全站鎖序是 prizes → sellers → settlements → shipments（見
         pool-settlement.ts 檔頭與 commit d5c8bd3），而 prizes 排在最前面 ——
         所以這一批鎖排在 insert into pools（會對 sellers 那一列做 FK 檢查）之前，
         而且是這筆交易唯一一次對 prizes 上鎖：**先整批鎖完，再開始做事**，
         迴圈中途不再要求任何新的列鎖。

         `order by id` 不是裝飾：`= any(...)` 本身不保證上鎖順序，
         兩個賣家各拿一組交錯的卡同時開池時，沒有排序就是一個死結環。 */
      const lockIds = [...new Set(pledgeIds)]
      const lockedRows = lockIds.length
        ? await tx`
            select id, user_id, status, card, grader, cert_no
              from prizes where id = any(${lockIds}) order by id for update
          `
        : []
      const locked = new Map(lockedRows.map(r => [String(r.id), r]))

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
        /* refPrice 沒填就明確存 null（不是 0，也不是「沒有這個鍵」）。
           variantId 同理明確寫 null：commitPool 會把它序列化進 manifest v4，
           讓「有這個鍵但值是 null」與「沒有這個鍵」在資料庫裡讀起來一致。

           manifestString 只讀卡片身分那幾欄（name/setCode/cardNo/grader/grade/
           certNo/refPrice/buyback/variantId）；不加入外部驗證結果，避免日後
           查驗服務或展示文案變動改寫已公布的承諾。 */
        card: {
          ...p.card,
          refPrice: p.card.refPrice ?? null,
          variantId: p.card.variantId ?? null
        },
        total: p.total,
        // 解析後的絕對金額。manifest 與回收都只看這一欄
        buyback: resolved[i]!
      }))
      await tx`insert into pool_prizes ${tx(rows as never)}`

      /* ── 押記：把獎品接到卡冊裡那一張實體卡（023 + A-4）────────────
         兩條入口，同一個終點（prizes 一列，狀態 in_pool，pool_prizes.card_id 指著它）：

           1 獎品帶 prizeId  → 卡冊優先。**不論有沒有鑑定編號**，
                              鎖住那一列、只收自己的 in_book、轉成 in_pool。
                              裸卡唯一的防線就是這條（A-4／U-3）：它沒有編號，
                              prizes_cert_alive 蓋不到，只有「一列卡只有一個
                              status」這個結構保證擋得住第二次押注。
           2 只帶 certNo     → 023 的舊路徑。已經在自己卡冊裡的那一列就重用，
                              沒有的話當場開一列（等於順手登記）。唯一性由
                              prizes_cert_alive 保證。

         沒有 prizeId 又沒有編號的裸卡**維持原樣，一點保護都沒有** ——
         這是這一輪已知還開著的缺口，理由見 PrizeIn.prizeId 的說明。

         won_at / acquired_at 在押記當下還沒有「贏得」這件事發生，
         填現在只是為了滿足 NOT NULL；抽中時會被覆寫成真正的時間。 */
      const now = Date.now()

      for (let i = 0; i < rows.length; i++) {
        const src = b.prizes[i]!
        const wantId = (src.prizeId ?? '').trim()

        /* ---- 入口一：從卡冊挑的那一張（A-4）---- */
        if (wantId) {
          const mine = locked.get(wantId)
          if (!mine) {
            throw new Rollback(404, {
              error: 'CARD_NOT_FOUND',
              message: '挑到的卡不在你的卡冊裡了，請重新整理卡片清單再挑一次。'
            })
          }
          if (String(mine.user_id) !== me) {
            /* 講「不在你的卡冊裡」而不是「這是別人的卡」：後者等於用一個
               別人的 prizeId 就能問出「這張卡存在而且不是你的」。 */
            throw new Rollback(404, {
              error: 'CARD_NOT_FOUND',
              message: '挑到的卡不在你的卡冊裡了，請重新整理卡片清單再挑一次。'
            })
          }
          if (String(mine.status) !== 'in_book') {
            throw new Rollback(409, {
              error: 'CARD_BUSY',
              message: `「${cardName(mine.card)}」目前是「${STATUS_LABEL[String(mine.status)] ?? String(mine.status)}」`
                + ' —— 它已經押在別的池裡、掛在市場上、或在出貨流程中，不能再放進這個池。'
            })
          }

          /* 卡片身分**以卡冊那一列為準**，不用呼叫端送上來的。
             呼叫端同時決定 prizeId 與 card jsonb 的話，可以押一張普卡
             卻在承諾裡宣告成噴火龍 —— manifest 會照著那份謊言算，
             而抽到的人拿到的是普卡。身分只有一個來源這件事，
             跟 prizes.user_id 只有一個來源是同一條理由。
             pool_prizes.card 仍然是**快照**（開賣後賣家改卡冊不影響承諾），
             這裡只是把快照的來源換成權威值。
             refPrice 例外：那是「這個池對外標示的參考價」，一張卡在不同
             時間開池可以標不同的數字，所以照呼叫端送的（沒送才退回卡冊的值）。 */
          const bookCard = (mine.card ?? {}) as Record<string, unknown>
          const str = (v: unknown) => typeof v === 'string' && v ? v : null
          rows[i]!.card = {
            ...bookCard,
            /* 卡冊登記的卡沒有 `id`（routes/cardbook.ts 的 CardIn 沒有這一欄），
               而獎品的 card 需要一個非空字串。artId 是這張卡在目錄裡的唯一鍵，
               比現編一個時間戳誠實；兩者都沒有時退回呼叫端送的那一個。 */
            id: str(bookCard.id) ?? str(bookCard.artId) ?? src.card.id,
            name: str(bookCard.name) ?? src.card.name,
            refPrice: src.card.refPrice ?? (bookCard.refPrice as number | null | undefined) ?? null,
            variantId: (bookCard.variantId as string | null | undefined) ?? null
          }

          await tx`
            update prizes set pool_id = ${id}, status = 'in_pool',
                   card = ${rows[i]!.card as never}, tier = ${rows[i]!.tier},
                   seat = null, draw_id = null
             where id = ${wantId}
          `
          await tx`update pool_prizes set card = ${rows[i]!.card as never}, card_id = ${wantId} where id = ${rows[i]!.id}`
          continue
        }

        /* ---- 入口二：只帶鑑定編號（023 的舊路徑）---- */
        const card = rows[i]!.card as { grader?: unknown; certNo?: unknown }
        const certRaw = typeof card.certNo === 'string' ? card.certNo.trim() : ''
        if (!certRaw) continue
        const graderRaw = typeof card.grader === 'string' ? card.grader.trim() : ''
        const normGrader = graderRaw ? graderRaw.toUpperCase() : null

        /* 這個編號如果已經是**自己名下、閒置在卡冊**的一列（接管來的、
           或上一個池結束解押回來的 in_book），重用那一列押進新池 ——
           開新列會撞 prizes_cert_alive 唯一索引，把「拿自己的卡再開一次池」
           這個完全正當的動作擋成 CERT_ALREADY_LISTED（audit-3 的 A-3：
           in_book 進得去出不來）。
           那一列已經在上面整批鎖過了（certLookup 先無鎖找出候選、
           id 併進 lockIds），這裡不再拿新鎖。 */
        const mine = locked.get(certRowId.get(i) ?? '')
        if (mine && String(mine.user_id) === me && String(mine.status) === 'in_book') {
          await tx`
            update prizes set pool_id = ${id}, status = 'in_pool',
                   card = ${rows[i]!.card as never}, tier = ${rows[i]!.tier},
                   seat = null, draw_id = null
             where id = ${mine.id}
          `
          await tx`update pool_prizes set card_id = ${mine.id as string} where id = ${rows[i]!.id}`
          continue
        }
        /* 存在但不能用 —— 分開講清楚是哪一種：別人的卡要走接管，
           自己的卡在忙要先處理那一邊。 */
        if (mine && String(mine.user_id) !== me) {
          throw new Rollback(409, {
            error: 'CERT_ALREADY_LISTED',
            message: `鑑定編號 ${certRaw} 已經登記在別人名下 —— 同一張實體卡不能重複登記。`
              + '如果這張卡是你在站外買到的，請申請接管。'
          })
        }
        if (mine) {
          throw new Rollback(409, {
            error: 'CARD_BUSY',
            message: `鑑定編號 ${certRaw} 的卡目前是「${String(mine.status)}」狀態 —— `
              + '它正在別的池裡、掛在市場上、或在出貨流程中。先處理完那一邊才能放進新池。'
          })
        }

        const cardId = `pz-${id}-c${i}`
        await tx`
          insert into prizes (id, user_id, pool_id, card, tier, status,
                              won_at, acquired_at, stash_expires_at,
                              grader, cert_no, custodian_id, origin)
          values (${cardId}, ${me}, ${id}, ${rows[i]!.card as never}, ${rows[i]!.tier}, 'in_pool',
                  ${now}, ${now}, ${now + STASH_DAYS * 86_400_000},
                  ${normGrader}, ${certRaw},
                  ${me}, 'upload')
        `
        await tx`update pool_prizes set card_id = ${cardId} where id = ${rows[i]!.id}`
      }

      return commitPool(tx, id)
    })
    return c.json({ poolId: id, ...result })
  } catch (e) {
    // Rollback：交易已整筆回滾，回應是我們自己帶出來的（見 db.ts）
    if (e instanceof Rollback) return c.json(e.body, e.status as 409)
    /* 上游的錯誤訊息不往外送，只進 log。
       這條路上會 throw 的東西是 drand 的 HTTP 狀態（`drand round 6398588 425`）、
       fetch 的逾時、以及 pools-service 的內部狀態檢查（`pool is draft, not committed`）——
       全部是英文的內部字串。原樣回給呼叫端有兩個問題：
       它洩漏我們依賴誰、內部狀態怎麼命名；而且它把**別人的故障**
       講得像使用者做錯了什麼，使用者照著那句話做不了任何事。
       對外固定一句「這不是你的錯，等一下再試」，細節留給我們自己看。 */
    /* 但**唯一索引撞到不是我們的問題**，是使用者真的送了一個已經登記過的
       鑑定編號（023 的押記會在 prizes 上撞到 prizes_cert_alive）。
       把它一起講成 502「我們這邊的問題」有兩個後果：使用者會一直重試
       同一份表單，而真正該做的是換一張卡；而且它把平台唯一一道
       「一卡多賣」的防線講成隨機故障，等於把防線的存在藏起來。 */
    const pg = e as { code?: string; constraint_name?: string }
    if (pg.code === '23505' && pg.constraint_name === 'prizes_cert_alive') {
      return c.json({
        error: 'CERT_ALREADY_LISTED',
        message: '這個鑑定編號已經登記在系統裡了 —— 同一張實體卡不能同時放進兩個池，也不能一邊在池裡一邊掛在市場上。'
          + '如果這張卡是你的而且已經不在別處，請聯絡客服。'
      }, 409)
    }
    console.error('[pools] 建池失敗:', e)
    return c.json({ error: 'COMMIT_FAILED', message: '建池失敗，這是我們這邊的問題，請稍後再試一次' }, 502)
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
    // 同上：drand 的狀態碼與內部狀態名不對外，見建池那一段的說明
    console.error('[pools] 開池失敗:', e)
    return c.json({ error: 'WRONG_STATE', message: '目前無法開賣，請稍後再試' }, 409)
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
    // 同上。這裡的 throw 幾乎都是 `pool is open`（還沒收攤就按公布）這種內部狀態字串
    console.error('[pools] 公布失敗:', e)
    return c.json({ error: 'WRONG_STATE', message: '目前無法公布，請確認這個池已經收攤' }, 409)
  }
})
