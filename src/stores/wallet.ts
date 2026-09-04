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
    /**
     * mock 模式下「凍結」的各個來源，locked 是它們的**總和**。
     *
     * 分開記是因為兩邊的推算者不同：訂單那一份由 orders store 從訂單列表算，
     * 出價那一份由 social 的 mock 從待回應的出價算。誰都不知道對方現在是多少，
     * 所以任何一邊直接對 locked 做加減，另一邊下一次重算就會把它抹掉。
     * 由 store 自己加總，兩邊就只需要各自宣告「我這一份是多少」。
     *
     * API 模式用不到：那邊 locked 整包由伺服器回（applyServer），
     * 下面兩支 setter 本來就是 mock-only。
     */
    lockedBy: { orders: 0, offers: 0 },
    ledger: [] as LedgerEntry[],
    ledgerLoaded: false,
    ledgerLoading: false,
    /**
     * 帳本這一次載入失敗的原因（成功時是 null）。
     *
     * 有這個欄位，loadLedger() 才有地方把例外放 —— 見下面它為什麼不再往外丟。
     * 畫面拿它畫「中文訊息＋重試鈕」，而不是把錯誤畫成一本空帳本。
     */
    ledgerErr: null as string | null
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
      if (this.ledgerLoaded || this.ledgerLoading) return
      this.ledgerLoading = true
      try {
        const rows = await api.ledger()
        this.ledger = [...this.ledger, ...rows]
        this.ledgerLoaded = true
        this.ledgerErr = null
      } catch (e) {
        /* ---- 為什麼吞在這裡，而不是要每個呼叫端自己接 ----
           兩個呼叫端（錢包頁、我的）都是 `onMounted(() => wallet.loadLedger())`
           這種開火即忘。它一 reject 就是沒有人接的 promise：實測後端重啟時
           錢包頁吐出 `[Vue warn]: Unhandled error during execution of mounted hook
           at <WalletPage>` ＋ 一個 pageerror，而 <script setup> 裡的未捕捉錯誤
           會摧毀整棵元件樹（SPEC §10.5）—— 白畫面，而且換頁也救不回來。

           判準不該是「有沒有人記得接」，那是紀律問題；改成「這支本來就不 reject」
           之後漏不掉，下一個讀帳本的新畫面也自動安全。
           （同一個判斷已經用在 stores/sellers.ts 的 ensureLoaded、
           stores/pools.ts 的 ensureLoaded。）

           ledgerLoaded 維持 false，所以重試鈕直接再呼叫一次就會真的重打。 */
        this.ledgerErr = e instanceof Error ? e.message : '交易紀錄載入失敗'
      } finally {
        this.ledgerLoading = false
      }
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
     * 設定「進行中託管訂單」凍結的總額。
     *
     * 刻意不做 lock/unlock 這種增減式的 API —— 訂單存在 localStorage、
     * 錢包沒有，重新整理之後兩邊就會對不起來（實測：訂單顯示已鎖點，
     * 託管中卻是 0）。改成由訂單列表推算出唯一的總額再推過來，
     * 就不存在「兩份真相」的問題。
     */
    setOrderLocked(total: number) {
      if (!MOCK) return
      this.lockedBy.orders = Math.max(0, total)
      this.locked = this.lockedBy.orders + this.lockedBy.offers
    },

    /**
     * 設定「待回覆的交易出價」凍結的總額。
     *
     * 出價會凍結點數是後端的規則（見 server/src/money.ts 的 locked 計算）：
     * 餘額 1000 的人不該同時對十張卡各出價 1000，那是十個持有人白等一場。
     * mock 不跟著凍的話，展示模式下的可動用點數會比正式環境寬鬆 ——
     * 「餘額不足」那條分支在本機永遠走不到，改版時等於沒有被看過。
     *
     * 跟訂單那一份一樣是推算出來的總額，不是增減。
     */
    setOfferLocked(total: number) {
      if (!MOCK) return
      this.lockedBy.offers = Math.max(0, total)
      this.locked = this.lockedBy.orders + this.lockedBy.offers
    },
    /** 放款給賣家：這筆錢真的離開買家帳戶 */
    charge(amount: number) {
      if (!MOCK) return
      this.points -= amount
    },
    /**
     * 入點／扣點，並留下一筆帳本紀錄。
     *
     * 跟 topup／spend 分開是因為這種動作**事後一定會被回來對帳**
     * （「我那張卡換了多少」「那筆出價到底有沒有入帳」），
     * 只改數字不留紀錄的話，錢包頁會出現一個解釋不了的餘額。
     *
     * 原本只有回收一種（creditRecycle），但「有帳本紀錄的金額變動」不只回收 ——
     * 接受交易邀約也是。抽成同一支，type 與 note 由呼叫端給，
     * 免得每多一種入帳理由就複製一次這五行。
     */
    credit(delta: number, type: LedgerEntry['type'], note: string) {
      if (!MOCK) return
      this.points += delta
      this.ledger.unshift({
        id: `l-${Date.now()}`,
        delta,
        balanceAfter: this.points,
        type,
        note,
        createdAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
      })
    },

    /** 回收入點。就是 credit() 的回收版，留著是因為呼叫端讀起來比較直接 */
    creditRecycle(points: number, note: string) {
      this.credit(points, 'recycle', note)
    }
  }
})
