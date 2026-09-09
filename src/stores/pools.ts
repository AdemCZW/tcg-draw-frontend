import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import type { Pool, DrawResult } from '@/types/models'
import { isDrawable } from '@/lib/pool-status'

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
    /* 載入失敗的訊息。沒有這個欄位的話例外一路 unhandled，頁面拿到
       空陣列照畫空狀態 —— 斷網會被畫成「沒有池」「池已下架」，
       使用者不會想到重新整理，等於死路。 */
    error: '',
    lastResult: null as DrawResult | null
  }),
  getters: {
    /* 「現在抽得到的池」。判斷借 lib/pool-status.ts 那一份 ——
       committed 也不是 open，但它是「還沒開賣」不是「不能抽了」，
       兩者的差別由那個檔統一定義，這裡不再自己寫一次比較式。 */
    openPools: s => s.pools.filter(isDrawable),
    byId: s => (id: string) => s.pools.find(p => p.id === id),
    /** 依 drawId 取結果：記憶體優先，沒有就從 sessionStorage 撈（reload 之後） */
    resultById: s => (drawId: string): DrawResult | null =>
      s.lastResult?.drawId === drawId ? s.lastResult : unstashResult(drawId)
  },
  actions: {
    async load() {
      this.loading = true
      this.error = ''
      /* 失敗吞在這裡、記進 error，而不是往外丟：呼叫端都是 onMounted 裡
         fire-and-forget 的 ensureLoaded()，往外丟只會變成 unhandled rejection。
         頁面看 error 欄位畫「載入失敗＋重試」。 */
      try { this.pools = await api.listPools() }
      catch (e) { this.error = e instanceof Error ? e.message : '載入失敗' }
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

    /**
     * 抽選。**只有 api.draw 的成敗算成這個函式的成敗。**
     *
     * syncPool 原本是 await 在這裡的，於是它一失敗就會讓整個 draw() 拋例外 ——
     * 而那時候後端**已經扣了款、已經發了卡**，drawId 也已經進了 sessionStorage。
     * 呼叫端的 catch 接著印「抽選失敗，點數已退回」並在前端把點數加回去，
     * 使用者看到的是一次失敗的抽選、一個假的餘額，然後他會再抽一次 ——
     * 而真正抽到的那一次沒有人帶他去看結果。
     *
     * 後端冷啟動（這個專案多處註解把 ~20 秒當常態）或換個網路就足以觸發。
     *
     * 所以 syncPool 改成不擋路：它更新的是「這個池還剩幾籤」這種顯示用的
     * 衍生狀態，沒同步到最多是進度條慢一拍，下一次讀清單就會對上。
     * 拿那個去否定一次已經成立的抽選，代價完全不成比例。
     */
    async draw(poolId: string, seats: number[]): Promise<DrawResult> {
      const result = await api.draw(poolId, seats)
      this.lastResult = result
      stashResult(result)
      /* 不 await、也不讓它的失敗冒出去。void 是刻意的：這裡要的是
         「順便更新一下」，不是「更新成功才算抽到」。 */
      void this.syncPool(poolId).catch(() => { /* 顯示用的狀態，慢一拍不影響正確性 */ })
      return result
    },

    async createPool(input: Parameters<typeof api.createPool>[0]): Promise<Pool> {
      const pool = await api.createPool(input)
      this.pools.push(pool)
      return pool
    }
  }
})
