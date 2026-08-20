import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { MOCK } from '@/lib/config'
import type { LedgerEntry } from '@/types/models'
import { useAuthStore } from '@/stores/auth'

export const useWalletStore = defineStore('wallet', {
  state: () => ({
    /* mock 給足點數讓所有玩法都能試；API 模式從 0 開始，由伺服器回傳真實餘額。
       API 模式下這裡的所有增減動作都是 no-op —— 頁面在呼叫 api 前後做的
       樂觀更新（spend / topup）會被伺服器回傳的錢包覆蓋，伺服器才是真相。 */
    points: MOCK ? 100_000_000 : 0,
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
    available: (s) => s.points - s.locked,

    /**
     * 對外顯示用的餘額。**畫面上一律用這個，不要直接用 points。**
     *
     * 沒有帳號的人不該看到餘額。mock 模式種了一億點是為了讓所有玩法都試得動，
     * 但那是「已登入的測試帳號」的錢 —— 市場頁與池詳情頁都是公開的，
     * 訪客在那裡看到「餘額 100,000,000」是假的，而且那顆膠囊還連到
     * 需要登入的儲值頁，按下去只會被守衛彈回形象頁。
     *
     * API 模式下訪客本來就是 0，但顯示 0 跟顯示「請先登入」是兩件事，
     * 讓呼叫端自己用 isLoggedIn 決定要不要畫這一塊。
     */
    shown(s): number {
      return useAuthStore().isLoggedIn ? s.points : 0
    }
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
    /** API 模式：伺服器回傳的錢包直接套用 */
    applyServer(w: { points: number; locked: number }) {
      this.points = w.points
      this.locked = w.locked
    },
    spend(cost: number) {
      if (!MOCK) return
      this.points -= cost
    },
    topup(amount: number) {
      if (!MOCK) return
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
      if (!MOCK) return
      this.locked = Math.max(0, total)
    },
    /** 放款給賣家：這筆錢真的離開買家帳戶 */
    charge(amount: number) {
      if (!MOCK) return
      this.points -= amount
    },
    /**
     * 回收入點。跟 topup 分開是因為這筆一定要留下帳本紀錄 ——
     * 使用者拿卡換點，事後一定會回來對帳「我那張卡換了多少」。
     */
    creditRecycle(points: number, note: string) {
      if (!MOCK) return
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
