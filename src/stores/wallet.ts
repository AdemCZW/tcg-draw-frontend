import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import type { LedgerEntry } from '@/types/models'

export const useWalletStore = defineStore('wallet', {
  state: () => ({
    // demo 用：給足點數讓所有玩法都能試（正式版由後端回傳真實餘額）
    points: 100_000_000,
    /**
     * 託管中的點數。
     *
     * 跟 points 分開記，因為「凍結」不是「扣款」—— 這筆錢還是使用者的，
     * 只是在訂單結案前不能動。合成一個數字的話，退款時就分不出
     * 該還多少、以及餘額為什麼會變動。
     */
    locked: 0,
    ledger: [] as LedgerEntry[],
    ledgerLoaded: false
  }),
  getters: {
    /** 真正能拿去花的餘額 */
    available: (s) => s.points - s.locked
  },
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
      // 用可動用餘額判斷，不是總餘額 —— 託管中的點數不能再拿去買東西
      return this.points - this.locked >= cost
    },
    spend(cost: number) {
      this.points -= cost
    },
    topup(amount: number) {
      this.points += amount
    },
    /**
     * 設定託管中的總額。
     *
     * 刻意不做 lock/unlock 這種增減式的 API —— 訂單存在 localStorage、
     * 錢包沒有，重新整理之後兩邊就會對不起來（實測：訂單顯示已鎖點，
     * 託管中卻是 0）。改成由訂單列表推算出唯一的總額再推過來，
     * 就不存在「兩份真相」的問題。
     */
    setLocked(total: number) {
      this.locked = Math.max(0, total)
    },
    /** 放款給賣家：這筆錢真的離開買家帳戶 */
    charge(amount: number) {
      this.points -= amount
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
