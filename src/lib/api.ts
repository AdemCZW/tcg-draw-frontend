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
import * as mock from '@/mocks/data'
import { MOCK } from './config'
import { http, idem } from './http'
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
    wonAt: ts(r.won_at), stashExpiresAt: ts(r.stash_expires_at)
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
      items: r.items.map(it => ({ ticketSeq: Number(it.seat), tier: it.tier as Tier, card: it.card as CardItem }))
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

  async myPrizes(): Promise<UserPrize[]> {
    if (MOCK) { await delay(150); return mock.userPrizes }
    const r = await http<{ prizes: Any[] }>('/v1/prizes')
    return r.prizes.map(toPrize)
  },

  // ---- 市場 ----
  async listMarket(): Promise<Listing[]> {
    if (MOCK) { await delay(160); return mock.listings }
    const r = await http<{ listings: Any[] }>('/v1/listings')
    return r.listings.map(toListing)
  },
  async buyListing(id: string): Promise<Listing> {
    if (MOCK) {
      await delay(300)
      const l = mock.listings.find(x => x.id === id)
      if (!l) throw new Error('listing not found')
      if (l.status === 'sold') throw new Error('already sold')
      l.status = 'sold'
      return l
    }
    // 真的買：回 { order | null, wallet }。order 為 null 表示庫內轉移，成交即完成
    const r = await http<{ order: Any | null; wallet: { points: number; locked: number } }>(
      '/v1/orders', { method: 'POST', json: { listingId: id, idempotencyKey: idem() } })
    applyWallet(r)
    const l = (await this.listMarket()).find(x => x.id === id)
    return l ?? ({ id, status: 'sold' } as Listing)
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

  /** 目前錢包（API 模式用來初始化；mock 模式回 store 現值） */
  async wallet(): Promise<{ points: number; locked: number }> {
    const w = useWalletStore()
    if (MOCK) return { points: w.points, locked: w.locked }
    const r = await http<{ wallet: { points: number; locked: number } }>('/v1/wallet')
    applyWallet(r)
    return r.wallet
  }
}
