import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import type { Pool, DrawResult } from '@/types/models'

/* 開卡結果只活在記憶體裡的話，使用者抽完手滑重整就變成「沒有可顯示的抽選結果」。
   鏡射一份到 sessionStorage（分頁關掉就消失，不會累積）；
   結果頁依 drawId 取回。用 sessionStorage 而不是 localStorage：
   這是「這一次瀏覽」的東西，不該跨分頁、跨天殘留。 */
const RESULT_KEY = 'vd.lastResult'
function stashResult(r: DrawResult) {
  try { sessionStorage.setItem(RESULT_KEY, JSON.stringify(r)) } catch { /* 無痕或額度滿，忽略 */ }
}
function unstashResult(drawId: string): DrawResult | null {
  try {
    const raw = sessionStorage.getItem(RESULT_KEY)
    if (!raw) return null
    const r = JSON.parse(raw) as DrawResult
    return r.drawId === drawId ? r : null
  } catch { return null }
}

export const usePoolStore = defineStore('pools', {
  state: () => ({
    pools: [] as Pool[],
    loading: false,
    lastResult: null as DrawResult | null
  }),
  getters: {
    openPools: s => s.pools.filter(p => p.status === 'open'),
    byId: s => (id: string) => s.pools.find(p => p.id === id),
    /** 依 drawId 取結果：記憶體優先，沒有就從 sessionStorage 撈（reload 之後） */
    resultById: s => (drawId: string): DrawResult | null =>
      s.lastResult?.drawId === drawId ? s.lastResult : unstashResult(drawId)
  },
  actions: {
    async load() {
      this.loading = true
      try { this.pools = await api.listPools() }
      finally { this.loading = false }
    },
    async ensureLoaded() {
      if (!this.pools.length) await this.load()
    },

    /**
     * 把後端回傳的池狀態套用到 store。必須逐欄位寫入 reactive 物件，
     * 直接改動來源物件不會觸發畫面更新。
     */
    applyPoolState(next: Pool) {
      const cur = this.pools.find(p => p.id === next.id)
      if (!cur) { this.pools.push(next); return }
      cur.remainingTickets = next.remainingTickets
      cur.takenSeats = [...next.takenSeats]
      cur.status = next.status
      for (const np of next.prizes) {
        const cp = cur.prizes.find(p => p.id === np.id)
        if (cp) cp.remaining = np.remaining
      }
    },
    async syncPool(poolId: string) {
      this.applyPoolState(await api.poolState(poolId))
    },

    async draw(poolId: string, seats: number[]): Promise<DrawResult> {
      const result = await api.draw(poolId, seats)
      this.lastResult = result
      stashResult(result)
      await this.syncPool(poolId)
      return result
    },

    async createPool(input: Parameters<typeof api.createPool>[0]): Promise<Pool> {
      const pool = await api.createPool(input)
      this.pools.push(pool)
      return pool
    }
  }
})
