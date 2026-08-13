import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import type { LedgerEntry } from '@/types/models'

export const useWalletStore = defineStore('wallet', {
  state: () => ({
    // demo 用：給足點數讓所有玩法都能試（正式版由後端回傳真實餘額）
    points: 100_000_000,
    ledger: [] as LedgerEntry[],
    ledgerLoaded: false
  }),
  actions: {
    /**
     * 帳本只從後端載入一次。
     *
     * 原本每次掛載都直接覆蓋整個陣列，結果是：使用者回收完卡片、
     * 切到錢包頁想確認入帳，那筆紀錄剛好被這行洗掉。
     * MOCK 模式下後端永遠不會回傳本地新增的紀錄，所以只能載一次；
     * 接上真後端後伺服器本來就會回傳完整帳本，屆時可改為每次重新整理。
     */
    async loadLedger() {
      if (this.ledgerLoaded) return
      const rows = await api.ledger()
      this.ledger = [...this.ledger, ...rows]
      this.ledgerLoaded = true
    },
    canAfford(cost: number) {
      return this.points >= cost
    },
    spend(cost: number) {
      this.points -= cost
    },
    topup(amount: number) {
      this.points += amount
    },
    /**
     * 回收入點。跟 topup 分開是因為這筆一定要留下帳本紀錄 ——
     * 使用者拿卡換點，事後一定會回來對帳「我那張卡換了多少」。
     */
    creditRecycle(points: number, note: string) {
      this.points += points
      this.ledger.unshift({
        id: `l-${Date.now()}`,
        delta: points,
        balanceAfter: this.points,
        type: 'recycle',
        note,
        createdAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
      })
    }
  }
})
