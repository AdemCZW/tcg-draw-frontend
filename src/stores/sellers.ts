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
    statusLoaded: false
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
    async ensureLoaded() {
      if (!this.sellers.length) this.sellers = await api.listSellers()
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
