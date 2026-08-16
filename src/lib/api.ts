// ------------------------------------------------------------------
// API layer — currently backed by in-memory mocks.
// Swap `MOCK = false` once FastAPI endpoints are live; the function
// signatures already mirror the REST interface in the architecture doc.
// ------------------------------------------------------------------
import type { Pool, DrawResult, UserPrize, LedgerEntry, WinnerEvent, StreakRun, AuctionLot, Seller, Listing, CardItem } from '@/types/models'
import * as mock from '@/mocks/data'

export const MOCK = true
const BASE = '/api'

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json() as Promise<T>
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

export const api = {
  async listPools(): Promise<Pool[]> {
    // 必須回傳副本：若讓 store 與 mock 共用同一份物件，mock 改動後
    // 快照與 store 現值相同，賦值不會觸發 Vue 的反應性更新。
    if (MOCK) { await delay(200); return mock.pools.map(p => mock.poolSnapshot(p.id)) }
    return http('/pools')
  },

  async getPool(id: string): Promise<Pool | undefined> {
    if (MOCK) { await delay(150); return mock.poolSnapshot(id) }
    return http(`/pools/${id}`)
  },

  /** 抽選後重新取得池狀態（籤數、各賞剩餘） */
  async poolState(id: string): Promise<Pool> {
    if (MOCK) { await delay(0); return mock.poolSnapshot(id) }
    return http(`/pools/${id}`)
  },

  async draw(poolId: string, seats: number[]): Promise<DrawResult> {
    if (MOCK) { await delay(600); return mock.mockDraw(poolId, seats) }
    return http(`/pools/${poolId}/draw`, { method: 'POST', body: JSON.stringify({ seats }) })
  },

  // ---- 賣家 ----
  async listSellers(): Promise<Seller[]> {
    if (MOCK) { await delay(120); return mock.listSellers() }
    return http('/sellers')
  },

  async getSeller(id: string): Promise<Seller | undefined> {
    if (MOCK) { await delay(120); return mock.getSeller(id) }
    return http(`/sellers/${id}`)
  },

  async createPool(input: mock.NewPoolInput): Promise<Pool> {
    if (MOCK) { await delay(500); return mock.createPool(input) }
    return http('/seller/pools', { method: 'POST', body: JSON.stringify(input) })
  },

  // ---- 連莊爆賞 ----
  async startStreak(poolId: string): Promise<StreakRun> {
    if (MOCK) { await delay(250); return mock.startStreak(poolId) }
    return http(`/pools/${poolId}/streak`, { method: 'POST' })
  },

  async streakDraw(runId: string, seat: number): Promise<StreakRun> {
    if (MOCK) { await delay(500); return mock.streakDraw(runId, seat) }
    return http(`/streak/${runId}/draw`, { method: 'POST', body: JSON.stringify({ seat }) })
  },

  async bankStreak(runId: string): Promise<DrawResult> {
    if (MOCK) { await delay(300); return mock.bankStreak(runId) }
    return http(`/streak/${runId}/bank`, { method: 'POST' })
  },

  // ---- 尾籤競標 ----
  async listLots(poolId: string): Promise<AuctionLot[]> {
    if (MOCK) { await delay(150); return mock.listLots(poolId) }
    return http(`/pools/${poolId}/lots`)
  },

  async placeBid(lotId: string, amount: number): Promise<{ lot: AuctionLot; refunded: number }> {
    if (MOCK) { await delay(300); return mock.placeBid(lotId, amount) }
    return http(`/lots/${lotId}/bid`, { method: 'POST', body: JSON.stringify({ amount }) })
  },

  async myPrizes(): Promise<UserPrize[]> {
    if (MOCK) { await delay(150); return mock.userPrizes }
    return http('/me/prizes')
  },

  // ---- 市場 ----
  async listMarket(): Promise<Listing[]> {
    if (MOCK) { await delay(160); return mock.listings }
    return http('/market/listings')
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
    return http(`/market/listings/${id}/buy`, { method: 'POST' })
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
    return http('/market/listings', { method: 'POST', body: JSON.stringify(input) })
  },

  async ledger(): Promise<LedgerEntry[]> {
    if (MOCK) { await delay(150); return mock.ledger }
    return http('/me/wallet/ledger')
  },

  async recentWinners(): Promise<WinnerEvent[]> {
    if (MOCK) { await delay(100); return mock.winners }
    return http('/winners/recent')
  }
}
