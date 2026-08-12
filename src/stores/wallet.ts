import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import type { LedgerEntry } from '@/types/models'

export const useWalletStore = defineStore('wallet', {
  state: () => ({
    // demo 用：給足點數讓所有玩法都能試（正式版由後端回傳真實餘額）
    points: 100_000_000,
    shards: 320,
    ledger: [] as LedgerEntry[]
  }),
  actions: {
    async loadLedger() {
      this.ledger = await api.ledger()
    },
    canAfford(cost: number) {
      return this.points >= cost
    },
    spend(cost: number) {
      this.points -= cost
    },
    topup(amount: number) {
      this.points += amount
    }
  }
})
