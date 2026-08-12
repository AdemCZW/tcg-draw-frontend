import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import type { Pool, DrawResult, StreakRun } from '@/types/models'

export const usePoolStore = defineStore('pools', {
  state: () => ({
    pools: [] as Pool[],
    loading: false,
    lastResult: null as DrawResult | null
  }),
  getters: {
    openPools: s => s.pools.filter(p => p.status === 'open'),
    byId: s => (id: string) => s.pools.find(p => p.id === id)
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
      await this.syncPool(poolId)
      return result
    },

    // ---- 連莊爆賞 ----
    async startStreak(poolId: string): Promise<StreakRun> {
      return api.startStreak(poolId)
    },
    async streakDraw(poolId: string, runId: string, seat: number): Promise<StreakRun> {
      const run = await api.streakDraw(runId, seat)
      await this.syncPool(poolId)
      return run
    },
    async createPool(input: Parameters<typeof api.createPool>[0]): Promise<Pool> {
      const pool = await api.createPool(input)
      this.pools.push(pool)
      return pool
    },

    async bankStreak(runId: string): Promise<DrawResult> {
      const result = await api.bankStreak(runId)
      this.lastResult = result
      await this.syncPool(result.poolId)
      return result
    }
  }
})
