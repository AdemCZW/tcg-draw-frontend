// ------------------------------------------------------------------
// API layer。
//
// MOCK 由 VITE_API_URL 決定（見 lib/config.ts）：沒設就全走 mock，有設就打後端。
// 每個方法兩條路徑並存，後端沒建的功能（連莊、競標）在 API 模式下也繼續走 mock，
// 不會出現「按了沒反應」。
//
// 後端的回應形狀在這裡轉成前端既有的型別，頁面元件不用改。
// ------------------------------------------------------------------
import type {
  Pool, DrawResult, UserPrize, LedgerEntry, WinnerEvent, StreakRun, AuctionLot,
  Seller, Listing, CardItem, PoolStatus, Tier
} from '@/types/models'
import { deliveryOf } from '@/shared/domain'
import * as mock from '@/mocks/data'
import { MOCK } from './config'
import { ApiError, http, idem } from './http'
import { useWalletStore } from '@/stores/wallet'

export { MOCK }

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

/* ---------- 後端 → 前端 的形狀轉換 ---------- */
type Any = Record<string, unknown>
const ts = (v: unknown) => (v == null ? '' : new Date(Number(v) || String(v)).toISOString().slice(0, 16).replace('T', ' '))

function toPool(p: Any): Pool {
  return {
    id: String(p.id), sellerId: String(p.sellerId),
    origin: (p.origin as Pool['origin']) ?? 'personal',
    title: String(p.title), cover: (p.cover as string) ?? '',
    mode: p.mode as Pool['mode'],
    shiteiTier: p.shiteiTier as Tier | undefined, auctionSeats: p.auctionSeats as number | undefined,
    ticketPrice: Number(p.ticketPrice), totalTickets: Number(p.totalTickets),
    remainingTickets: Number(p.remainingTickets),
    returnRatio: p.returnRatio === null || p.returnRatio === undefined ? null : Number(p.returnRatio),
    takenSeats: (p.takenSeats as number[]) ?? [],
    status: p.status as PoolStatus,
    commitHash: String(p.commitHash ?? ''), clientSeedSource: String(p.clientSeedSource ?? ''),
    prizes: ((p.prizes as Any[]) ?? []).map(x => ({
      id: String(x.id), tier: x.tier as Tier, card: x.card as CardItem,
      total: Number(x.total), remaining: Number(x.remaining)
    })),
    openedAt: ts(p.openedAt),
    escrow: { held: 0, releaseAfterShipDays: 7, released: 0 }
  }
}

function toPrize(r: Any): UserPrize {
  return {
    id: String(r.id), card: r.card as CardItem, tier: r.tier as Tier,
    status: r.status as UserPrize['status'],
    wonAt: ts(r.won_at),
    /* 舊資料（或還沒跑 014 的後端）沒有 acquired_at，退回 won_at ——
       第一手持有者的兩個時間本來就相同，退回去不會讓畫面說錯話 */
    acquiredAt: ts(r.acquired_at ?? r.won_at), stashExpiresAt: ts(r.stash_expires_at)
  }
}

const REASON_TYPE: Record<string, LedgerEntry['type']> = {
  'admin-grant': 'topup', topup: 'topup', draw: 'draw', 'streak-entry': 'draw',
  refund: 'refund', recycle: 'recycle', 'vault-buy': 'redeem', 'vault-sell': 'redeem',
  'order-pay': 'redeem', 'order-receive': 'redeem'
}
const REASON_NOTE: Record<string, string> = {
  'admin-grant': '平台發放', draw: '抽選', recycle: '回收', 'vault-buy': '市場購入',
  'vault-sell': '市場售出', 'order-pay': '託管訂單付款', 'order-receive': '託管訂單收款',
  'deposit-forfeit': '保證金沒收', seed: '測試點數'
}
function toLedger(rows: Any[], endBalance: number): LedgerEntry[] {
  // 後端不存 balanceAfter（餘額是算的），從最新往回推
  let bal = endBalance
  return rows.map(r => {
    const delta = Number(r.delta)
    const entry: LedgerEntry = {
      id: String(r.id), delta, balanceAfter: bal,
      type: REASON_TYPE[String(r.reason)] ?? 'redeem',
      note: REASON_NOTE[String(r.reason)] ?? String(r.reason),
      createdAt: ts(r.created_at)
    }
    bal -= delta
    return entry
  })
}

/* ---------- 分頁 ---------- */
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface PageOpts { cursor?: string | null; limit?: number; signal?: AbortSignal }
export type MarketSort = 'deal' | 'new' | 'cheap' | 'pricey'

export interface PrizeSummary {
  total: number
  counts: Record<UserPrize['status'], number>
  owned: number
  totalValue: number
  best: { name: string; tier: Tier; refPrice: number } | null
  tierMix: { tier: Tier; n: number }[]
  /** 成長曲線只需要「時間 + 金額」，所以不帶整包 card */
  curve: { wonAt: number; name: string; refPrice: number }[]
}

/** 只把有值的參數放進 query string —— 帶 cursor=null 會被後端當成不合法的游標 */
function qs(o: Record<string, unknown>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) {
    if (k === 'signal' || v === undefined || v === null || v === '') continue
    p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

/**
 * mock 的游標分頁。游標直接用「上一批最後一筆的 id」，因為 mock 的陣列
 * 順序就是排序本身；真後端不能這樣做（見 server/src/pagination.ts）。
 */
function mockPage<T>(all: T[], idOf: (x: T) => string, opts: PageOpts): Page<T> {
  const limit = opts.limit ?? 24
  const from = opts.cursor ? all.findIndex(x => idOf(x) === opts.cursor) + 1 : 0
  const items = all.slice(from, from + limit)
  const end = from + items.length
  return { items, nextCursor: end < all.length && items.length ? idOf(items[items.length - 1]!) : null }
}

function toListing(l: Any): Listing {
  return {
    id: String(l.id), card: l.card as CardItem, price: Number(l.price),
    sellerId: String(l.sellerId), sellerName: String(l.sellerName),
    listedAt: ts(l.listedAt), status: l.status as Listing['status'],
    delivery: l.delivery as Listing['delivery'], fromPrizeId: (l.prizeId as string) ?? undefined
  }
}

/** 後端回應裡若帶 wallet，直接套用 —— 伺服器是餘額的唯一真相 */
function applyWallet(res: { wallet?: { points: number; locked: number } }) {
  if (res?.wallet) useWalletStore().applyServer(res.wallet)
}

export const api = {
  async listPools(): Promise<Pool[]> {
    // 必須回傳副本：若讓 store 與 mock 共用同一份物件，mock 改動後
    // 快照與 store 現值相同，賦值不會觸發 Vue 的反應性更新。
    if (MOCK) { await delay(200); return mock.pools.map(p => mock.poolSnapshot(p.id)) }
    const r = await http<{ pools: Any[] }>('/v1/pools')
    return r.pools.map(toPool)
  },

  async getPool(id: string): Promise<Pool | undefined> {
    if (MOCK) { await delay(150); return mock.poolSnapshot(id) }
    const r = await http<{ pool: Any }>(`/v1/pools/${id}`)
    return toPool(r.pool)
  },

  /** 抽選後重新取得池狀態（籤數、各賞剩餘） */
  async poolState(id: string): Promise<Pool> {
    if (MOCK) { await delay(0); return mock.poolSnapshot(id) }
    const r = await http<{ pool: Any }>(`/v1/pools/${id}`)
    return toPool(r.pool)
  },

  async draw(poolId: string, seats: number[]): Promise<DrawResult> {
    if (MOCK) { await delay(600); return mock.mockDraw(poolId, seats) }
    const r = await http<{ drawId: string; items: Any[]; cost: number; wallet: { points: number; locked: number } }>(
      `/v1/pools/${poolId}/draw`, { method: 'POST', json: { seats, idempotencyKey: idem() } })
    applyWallet(r)
    return {
      drawId: r.drawId, poolId, cost: r.cost,
      items: r.items.map(it => ({
        ticketSeq: Number(it.seat), tier: it.tier as Tier, card: it.card as CardItem,
        stashId: it.stashId ? String(it.stashId) : undefined
      }))
    }
  },

  // ---- 賣家 ----
  async listSellers(): Promise<Seller[]> {
    if (MOCK) { await delay(120); return mock.listSellers() }
    const r = await http<{ sellers: Seller[] }>('/v1/sellers')
    return r.sellers
  },

  async getSeller(id: string): Promise<Seller | undefined> {
    if (MOCK) { await delay(120); return mock.getSeller(id) }
    const r = await http<{ seller: Seller | null }>(`/v1/sellers/${id}`)
    return r.seller ?? undefined
  },

  async createPool(input: mock.NewPoolInput): Promise<Pool> {
    if (MOCK) { await delay(500); return mock.createPool(input) }
    // 前端的開池表單是「賞別 + 名稱 + 數量 + 單價」，後端要完整的 card 物件
    const total = input.prizes.reduce((a, p) => a + p.qty, 0)
    const r = await http<{ poolId: string }>('/v1/pools', { method: 'POST', json: {
      mode: input.mode, title: input.title, ticketPrice: input.ticketPrice, totalTickets: total,
      shiteiTier: input.shiteiTier, auctionSeats: input.auctionSeats,
      prizes: input.prizes.map((p, i) => ({
        tier: p.tier, total: p.qty,
        card: { id: `c-${Date.now().toString(36)}-${i}`, name: p.name, setCode: '', cardNo: '', language: 'JP',
                grader: 'RAW', grade: null, certNo: null, image: '', refPrice: p.unitValue }
      }))
    } })
    const g = await http<{ pool: Any }>(`/v1/pools/${r.poolId}`)
    return toPool(g.pool)
  },

  // ---- 連莊爆賞 ----
  async startStreak(poolId: string): Promise<StreakRun> {
    // 連莊的後端是階段 3，還沒建；API 模式下先繼續走 mock，不要讓按鈕沒反應
    await delay(250); return mock.startStreak(poolId)
  },

  async streakDraw(runId: string, seat: number): Promise<StreakRun> {
    await delay(500); return mock.streakDraw(runId, seat)
  },

  async bankStreak(runId: string): Promise<DrawResult> {
    await delay(300); return mock.bankStreak(runId)
  },

  // ---- 尾籤競標 ----
  async listLots(poolId: string): Promise<AuctionLot[]> {
    // 競標的後端是階段 3；同上
    await delay(150); return mock.listLots(poolId)
  },

  async placeBid(lotId: string, amount: number): Promise<{ lot: AuctionLot; refunded: number }> {
    await delay(300); return mock.placeBid(lotId, amount)
  },

  /**
   * 我的卡冊，一次一批。
   *
   * status 由後端過濾，不是撈回來再自己濾 —— 分批載入之後前端只濾得到
   * 已經載進來的那幾張，「寄存中 0 張」但第 3 頁其實有，是這個改動最容易踩的坑。
   */
  async myPrizes(opts: PageOpts & { status?: UserPrize['status'] } = {}): Promise<Page<UserPrize>> {
    /* mock 也要真的分頁，不能整包回。mock 是本機開發與展示唯一的資料來源，
       它不分頁的話捲動載入這條路在開發時永遠走不到，等到接上後端才發現壞掉。 */
    if (MOCK) {
      await delay(150)
      const all = opts.status ? mock.userPrizes.filter(p => p.status === opts.status) : mock.userPrizes
      return mockPage(all, p => p.id, opts)
    }
    const r = await http<{ items: Any[]; nextCursor: string | null }>(
      `/v1/prizes${qs({ ...opts, status: opts.status })}`, { signal: opts.signal })
    return { items: r.items.map(toPrize), nextCursor: r.nextCursor }
  },

  /** 卡冊總覽的數字。講的是整本卡冊，所以不能從已載入的那幾張算 */
  async prizeSummary(): Promise<PrizeSummary> {
    if (MOCK) {
      await delay(120)
      const counts = {} as PrizeSummary['counts']
      for (const s of ['stashed', 'listed', 'ship_requested', 'shipped', 'recycled'] as const) {
        counts[s] = mock.userPrizes.filter(p => p.status === s).length
      }
      const owned = mock.userPrizes.filter(p => p.status !== 'recycled')
      const mix = new Map<string, number>()
      for (const p of owned) mix.set(p.tier, (mix.get(p.tier) ?? 0) + 1)
      const best = owned.reduce<UserPrize | null>((b, p) => (!b || p.card.refPrice > b.card.refPrice ? p : b), null)
      return {
        total: mock.userPrizes.length, counts, owned: owned.length,
        totalValue: owned.reduce((a, p) => a + p.card.refPrice, 0),
        best: best ? { name: best.card.name, tier: best.tier, refPrice: best.card.refPrice } : null,
        tierMix: [...mix].map(([tier, n]) => ({ tier: tier as Tier, n })),
        curve: owned.map(p => ({ wonAt: Date.parse(p.wonAt) || Date.now(), name: p.card.name, refPrice: p.card.refPrice }))
      }
    }
    return http<PrizeSummary>('/v1/prizes/summary')
  },

  // ---- 市場 ----
  /** 掛單一次一批。排序也在後端 —— 前端排序只排得到已載入的那幾筆，會愈捲愈亂 */
  async listMarket(opts: PageOpts & { sort?: MarketSort } = {}): Promise<Page<Listing>> {
    if (MOCK) {
      await delay(160)
      const live = mock.listings.filter(l => l.status === 'live')
      const d = (l: Listing) => (l.price - l.card.refPrice) / l.card.refPrice
      const sorted = [...live].sort(
        opts.sort === 'cheap' ? (a, b) => a.price - b.price
        : opts.sort === 'pricey' ? (a, b) => b.price - a.price
        : opts.sort === 'new' ? () => 0            // mock 已依上架時間排好
        : (a, b) => d(a) - d(b))
      return mockPage(sorted, l => l.id, opts)
    }
    const r = await http<{ items: Any[]; nextCursor: string | null }>(
      `/v1/listings${qs({ ...opts, sort: opts.sort })}`, { signal: opts.signal })
    return { items: r.items.map(toListing), nextCursor: r.nextCursor }
  },

  /** 市場上方那兩條橫向捲軸：講的是「整個市場最便宜／最貴的幾張」，跟分頁無關 */
  async marketHighlights(): Promise<{ deals: Listing[]; graded: Listing[]; total: number }> {
    if (MOCK) {
      await delay(120)
      const live = mock.listings.filter(l => l.status === 'live')
      const d = (l: Listing) => (l.price - l.card.refPrice) / l.card.refPrice
      return {
        deals: [...live].filter(l => d(l) <= -0.08).sort((a, b) => d(a) - d(b)).slice(0, 6),
        graded: [...live].filter(l => l.card.certNo).sort((a, b) => b.price - a.price).slice(0, 4),
        total: live.length
      }
    }
    const r = await http<{ deals: Any[]; graded: Any[]; total: number }>('/v1/listings/highlights')
    return { deals: r.deals.map(toListing), graded: r.graded.map(toListing), total: r.total }
  },
  /**
   * 單筆掛單。市場的卡片詳情頁靠這一支載入。
   *
   * 刻意不做成「撈整個市場再挑一筆」：市場是游標分頁的，要的那筆多半不在第一頁。
   * 而且分享出去的連結與重新整理都拿不到列表頁的狀態，詳情頁必須自己補得齊資料。
   * 找不到回 null（不是丟例外），讓頁面自己畫「不存在或已下架」——
   * 那是預期中的結果，不是錯誤。
   */
  async getListing(id: string): Promise<Listing | null> {
    if (MOCK) {
      await delay(140)
      return mock.listings.find(l => l.id === id) ?? null
    }
    try {
      const r = await http<{ listing: Any }>(`/v1/listings/${id}`)
      return toListing(r.listing)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
  },
  /** 回傳裡的 stashId 是「剛過戶到手的那張卡在卡冊裡的 id」，只有庫內轉移才有。
      買完要導去卡冊，卡冊靠它把剛買到的那張標出來。 */
  async buyListing(id: string): Promise<{ listing: Listing; stashId?: string }> {
    if (MOCK) {
      await delay(300)
      const l = mock.listings.find(x => x.id === id)
      if (!l) throw new Error('listing not found')
      if (l.status === 'sold') throw new Error('already sold')
      l.status = 'sold'
      /* 庫內轉移在後端是「卡真的過戶」（orders.ts 把 prizes.user_id 換成買家、
         status 改回 stashed）。mock 少了這一步的話，買完跳進卡冊會看不到那張卡 ——
         使用者回報的「買了沒進卡冊」在 mock 模式下就會是真的，而 mock 是本機
         開發與展示唯一的資料來源，這條路走不完等於整個流程沒被驗過。
         需寄送的不進卡冊：那是託管訂單，卡還在賣家手上，還不是買家的。 */
      if (deliveryOf(l) === 'vault') {
        const p = l.card.refPrice
        const stashId = 'up-' + l.id
        mock.userPrizes.unshift({
          id: stashId,
          card: l.card,
          // 市場買來的卡沒有賞別可言，這裡只是讓 mock 的卡冊有東西可畫
          tier: p >= 20_000 ? 'A' : p >= 5_000 ? 'B' : p >= 1_500 ? 'C' : 'D',
          status: 'stashed',
          /* wonAt 是「這張卡被抽出來」的時間、acquiredAt 是「我什麼時候拿到的」。
             買來的卡兩者不同，而卡冊是照 acquiredAt 排的（見後端 migrations/014）。 */
          wonAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
          acquiredAt: new Date().toISOString(),
          stashExpiresAt: new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)
        })
        return { listing: l, stashId }
      }
      return { listing: l }
    }
    // 真的買：回 { order | null, wallet }。order 為 null 表示庫內轉移，成交即完成
    const r = await http<{ order: Any | null; stashId?: string; wallet: { points: number; locked: number } }>(
      '/v1/orders', { method: 'POST', json: { listingId: id, idempotencyKey: idem() } })
    applyWallet(r)
    /* 原本這裡會把整個市場再撈一次只為了找回那一筆。掛單改成分頁之後那個做法
       既錯（要的那筆可能不在第一頁）又浪費，而且呼叫端根本沒用這個回傳值 ——
       成交與否看的是有沒有丟例外。 */
    return { listing: { id, status: 'sold' } as Listing, stashId: r.stashId }
  },
  async createListing(input: { prizeId: string; card: CardItem; price: number; sellerName: string }): Promise<Listing> {
    if (MOCK) {
      await delay(300)
      const l: Listing = {
        id: 'l-' + input.prizeId,
        card: input.card,
        price: input.price,
        sellerId: 'me',
        sellerName: input.sellerName,
        listedAt: '剛剛',
        status: 'live',
        fromPrizeId: input.prizeId
      }
      mock.listings.unshift(l)
      /* 真後端的 POST /v1/listings 會把 prizes.status 改成 'listed'（卡鎖在市場上，
         賣掉前不能出貨也不能回收）。mock 不跟著改的話，同一張卡可以重複上架，
         而且卡冊的分頁永遠不會出現「市場販售中」—— 那是假的成功。 */
      const src = mock.userPrizes.find(x => x.id === input.prizeId)
      if (src) src.status = 'listed'
      return l
    }
    const r = await http<{ listing: Any }>('/v1/listings', { method: 'POST', json: { prizeId: input.prizeId, price: input.price } })
    return toListing(r.listing)
  },

  async ledger(): Promise<LedgerEntry[]> {
    if (MOCK) { await delay(150); return mock.ledger }
    const r = await http<{ wallet: { points: number; locked: number }; ledger: Any[] }>('/v1/wallet')
    applyWallet(r)
    return toLedger(r.ledger, r.wallet.points)
  },

  async recentWinners(): Promise<WinnerEvent[]> {
    if (MOCK) { await delay(100); return mock.winners }
    const r = await http<{ winners: WinnerEvent[] }>('/v1/winners')
    return r.winners
  },

  /** 回收：mock 直接入點；API 模式由後端結算並回最新錢包 */
  async recyclePrize(prizeId: string, mockPoints: number, mockNote: string): Promise<{ points: number }> {
    if (MOCK) {
      await delay(200)
      useWalletStore().creditRecycle(mockPoints, mockNote)
      return { points: mockPoints }
    }
    const r = await http<{ points: number; wallet: { points: number; locked: number } }>(
      `/v1/prizes/${prizeId}/recycle`, { method: 'POST' })
    applyWallet(r)
    return { points: r.points }
  },

  /**
   * 申請把保管中的卡實體寄出。
   *
   * 這支之前不存在 —— 卡冊上的「申請出貨」按鈕只把本地物件的 status 改掉，
   * 完全沒有打後端。在 API 模式下按了畫面會變、重新整理就打回原形，
   * 而後台的出貨清單永遠收不到東西。
   *
   * 一次可以送多張：後端收 prizeIds 陣列，同一批合併成一張出貨單，
   * 使用者只付一次運費、平台只包一次。
   */
  async shipPrizes(prizeIds: string[], address: {
    name: string; phone: string; zip?: string; city: string; line1: string
  }): Promise<{ shipmentId: string }> {
    if (MOCK) {
      await delay(300)
      for (const p of mock.userPrizes) {
        if (prizeIds.includes(p.id)) p.status = 'ship_requested'
      }
      return { shipmentId: 'sh-mock-' + Date.now().toString(36) }
    }
    return http<{ shipmentId: string }>('/v1/prizes/ship', {
      method: 'POST', json: { prizeIds, address }
    })
  },

  /** 我的賣家狀態。null = 還沒申請過 */
  async sellerStatus(): Promise<{
    seller: { id: string; name: string; tier: string; origin: string } | null
    verification: { status: string; note: string | null } | null
  }> {
    if (MOCK) { await delay(120); return { seller: null, verification: null } }
    return http('/v1/seller/me')
  },

  /** 申請成為賣家。通過審核前 tier = pending，開池會被擋 */
  async applySeller(input: { name: string; origin: 'merchant' | 'personal'; bio?: string }) {
    if (MOCK) { await delay(300); return { seller: { id: 'me', tier: 'pending' }, already: false } }
    return http<{ seller: { id: string; tier: string }; already: boolean }>('/v1/seller/apply', {
      method: 'POST', json: input
    })
  },

  /** 目前錢包（API 模式用來初始化；mock 模式回 store 現值） */
  async wallet(): Promise<{ points: number; locked: number }> {
    const w = useWalletStore()
    if (MOCK) return { points: w.points, locked: w.locked }
    const r = await http<{ wallet: { points: number; locked: number } }>('/v1/wallet')
    applyWallet(r)
    return r.wallet
  }
}
