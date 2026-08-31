import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { MOCK } from '@/lib/config'
import type { Seller } from '@/types/models'

/** /v1/seller/me 的回覆形狀。跟 api.sellerStatus() 綁在一起，兩邊不會分岔 */
type SellerStatus = Awaited<ReturnType<typeof api.sellerStatus>>

export const useSellerStore = defineStore('sellers', {
  state: () => ({
    sellers: [] as Seller[],
    /** 目前登入者所扮演的賣家（mock：固定為關都卡舖） */
    meId: 's3',

    /* ---- 我的賣家身分（API 模式） ----
       null = 還沒查過。查過但不是賣家時，status.seller 會是 null，
       兩者要分得開：前者還不能下結論，後者可以。 */
    status: null as SellerStatus | null,
    statusLoading: false,
    statusLoaded: false,

    /* 賣家清單最後一次載入失敗的原因。**沒有任何畫面在讀它** ——
       它存在的理由是「失敗不能靜靜消失」：ensureLoaded() 現在把例外吞掉
       （見下面的說明），吞掉的東西至少要留在某個地方，之後想在畫面上
       講出來的時候不必再改一次 store。 */
    listError: null as string | null
  }),
  getters: {
    byId: s => (id: string) => s.sellers.find(x => x.id === id),
    me: (s): Seller | undefined => s.sellers.find(x => x.id === s.meId),

    /**
     * 目前登入者的賣家等級，沒有就是 null。
     *
     * 判準刻意跟開池頁（SellerNewPoolPage）共用同一份，不各寫各的：
     * MOCK 讀 sellers 假資料（沒有後端時仍然看得到整條賣家動線），
     * API 讀 /v1/seller/me。兩邊要是分岔，就會出現「頁首說你是賣家、
     * 點進去卻是申請表」這種自己打自己臉的畫面。
     */
    myTier(): string | null {
      return MOCK ? (this.me?.tier ?? null) : (this.status?.seller?.tier ?? null)
    },

    /**
     * 可以營業的賣家。pending（申請送出、還在審核）不算 ——
     * 那個身分還開不了池，自然也不會有東西要出貨、有錢要結算，
     * 給他看賣家專屬入口只是把人帶到一頁空清單。
     */
    isSeller(): boolean {
      const t = this.myTier
      return !!t && t !== 'pending'
    }
  },
  actions: {
    /**
     * 載入賣家清單。**不會 reject。**
     *
     * ---- 為什麼把例外吞在這裡，而不是要每個呼叫端自己接 ----
     * 這支有五個呼叫端（大廳、挑池台、賣家頁、池外殼、開池頁），
     * 其中四個是 `onMounted(() => { sellers.ensureLoaded() })` 這種
     * 開火即忘的寫法。它一旦 reject 就是一個沒有人接的 promise ——
     * 瀏覽器把它記成 pageerror，實測畫面上是一行紅字
     * 「連不上伺服器，請檢查網路後重試」，而使用者根本沒有做任何操作。
     *
     * 開池頁先前為此在**呼叫端**補過一次 `.catch(() => {})`（bf02ca2）。
     * 那修好了那一頁，但剩下四處照樣會炸 —— 而且下一個新頁面照樣會漏。
     * 判準不該是「有沒有人記得接」，那是紀律問題；改成「這支本來就不 reject」
     * 之後，漏不掉。（同一個判斷今天也用在 applyWallet 搬到傳輸層那一筆。）
     *
     * ---- 為什麼吞掉是安全的 ----
     * 賣家清單載不到時畫面會**優雅降級**：byId() 回 undefined，
     * 賣家膠囊就不渲染，池與市場的其餘內容照常。沒有任何一個流程
     * 會因為少了這份清單而做出錯的判斷（能不能開池看的是 ensureStatus()，
     * 那是另一支、而且它自己有 try/catch）。
     *
     * 失敗時 sellers 維持空陣列，所以 `!this.sellers.length` 仍然成立 ——
     * 下一次換頁會自動再試一次，不需要另外寫重試。
     */
    async ensureLoaded() {
      if (this.sellers.length) return
      try {
        this.sellers = await api.listSellers()
        this.listError = null
      } catch (e) {
        this.listError = e instanceof Error ? e.message : '賣家清單載入失敗'
      }
    },

    /**
     * 確認我的賣家身分。呼叫幾次都只會真的問一次伺服器 ——
     * 這支會被頁首（每一頁都在）用到，不做快取等於每次換頁都多打一次 /v1/seller/me。
     */
    async ensureStatus() {
      if (MOCK) { await this.ensureLoaded(); this.statusLoaded = true; return }
      if (this.statusLoaded || this.statusLoading) return
      this.statusLoading = true
      try {
        this.status = await api.sellerStatus()
      } catch {
        /* 問不到就當作「不是賣家」。頁首少一個入口，賣家還有「我的」那條路可走；
           反過來把入口留著才糟 —— 點進去是一頁讀取失敗。 */
        this.status = { seller: null, verification: null }
      } finally {
        this.statusLoading = false
        this.statusLoaded = true
      }
    },

    /** 登出時要清掉，否則換一個帳號登入會沿用上一個人的賣家身分 */
    resetStatus() {
      this.status = null
      this.statusLoaded = false
      this.statusLoading = false
    }
  }
})
