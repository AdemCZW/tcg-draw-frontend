import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { MOCK } from '@/lib/config'
import type { Seller } from '@/types/models'

/** /v1/seller/me 的回覆形狀。跟 api.sellerStatus() 綁在一起，兩邊不會分岔 */
type SellerStatus = Awaited<ReturnType<typeof api.sellerStatus>>

/**
 * 正在飛的單筆請求，key 是賣家 id。
 *
 * 放在 store 外面是刻意的：它是「這一刻有沒有人在問」的傳輸層狀態，
 * 不是畫面的資料。放進 state 會讓 Promise 進到 Pinia 的響應式代理裡
 * （devtools 也會去序列化它），而沒有任何一個模板需要讀它。
 *
 * 它要存在的理由是**同一頁會同時問同一位賣家**：池外殼與池總覽都讀
 * pool.sellerId，大廳的推薦池與它底下的池卡也可能是同一位。沒有這張表
 * 就是同一個 id 打兩三次 /v1/sellers/:id。
 */
const inflight = new Map<string, Promise<void>>()

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
    listError: null as string | null,

    /**
     * 問過、而伺服器明說「沒有這個人」的賣家 id。
     *
     * 要跟「還沒問過」分得開，否則 byId() 回 undefined 的畫面每次重畫都會
     * 再問一次同一個 404 —— 進到池頁、切個分頁、回來，就是三次。
     * 連線失敗**不**記在這裡：那是「這一刻問不到」，下一次換頁本來就該再試。
     */
    missing: {} as Record<string, true>
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
     * 載入賣家清單的**第一頁**。**不會 reject。**
     *
     * ---- 這支不是拿來查某一位賣家的（A-3 之後）----
     * /v1/sellers 從 fae7d92 起是游標分頁，預設一頁 20。所以在 API 模式下
     * 這支載進來的是「最早加入的 20 位」，第 21 位以後根本不在 sellers 裡，
     * byId() 對他們一律回 undefined —— 賣家頁會變成「找不到這位賣家」、
     * 池頁的賣家膠囊整塊不渲染。實測 30 位賣家時第 30 位就是這個樣子。
     *
     * 修法沒有選「跟著 nextCursor 一路翻完」：站上沒有任何一個畫面要
     * 「所有賣家的清單」—— 五個消費者（大廳、挑池台、賣家頁、池外殼、
     * 池總覽）全部都是 byId(某一個 pool.sellerId)，也就是「這一位叫什麼」。
     * 為了答一位而把 200 位翻完是 10 次請求換 1 筆資料，而且賣家越多越糟。
     * 所以查一位就走 ensureSeller()（單筆端點跟列表共用同一支批次實作，
     * 統計欄位不會分岔）。
     *
     * 那這支還留著做什麼：MOCK 模式下它是 me/myTier 那條路的資料來源
     * （開池頁在讀），而 MOCK 的 listSellers() 本來就回全部、沒有分頁。
     * **新的畫面要查某一位賣家時請用 ensureSeller()，不要用這支。**
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
     * 確保「這一位賣家」在 sellers 裡。**不會 reject**，理由與 ensureLoaded 同一條
     * （呼叫端都是 onMounted / watch 裡的開火即忘，往外丟就是 unhandled rejection）。
     *
     * 只打 /v1/sellers/:id，不碰列表分頁 —— 畫面要的是一位賣家的名字與統計，
     * 不是整份名冊。後端那支跟列表共用 sellerViews([id])，所以這裡拿到的
     * 統計欄位跟列表逐欄位相同，不會出現「池頁說 3 池、賣家頁說 4 池」。
     *
     * 三種「不必再問」各自要分得開：已經有了（列表撈到的也算）、
     * 已知不存在（missing）、正在飛（inflight）。少了最後一種，池外殼與
     * 池總覽同時掛載就是同一個 id 打兩次。
     */
    async ensureSeller(id: string | null | undefined) {
      if (!id) return
      if (this.sellers.some(s => s.id === id)) return
      if (this.missing[id]) return
      const flying = inflight.get(id)
      if (flying) return flying

      const p = (async () => {
        try {
          const s = await api.getSeller(id)
          /* 併發時可能有人先塞進來了，所以再確認一次才 push ——
             重複的話 byId() 仍然回得出東西，但清單會有兩筆一樣的資料。 */
          if (s) { if (!this.sellers.some(x => x.id === s.id)) this.sellers = [...this.sellers, s] }
          else this.missing[id] = true
          this.listError = null
        } catch (e) {
          /* 吞掉，理由同 ensureLoaded：畫面優雅降級（膠囊不渲染），
             而錯誤留在 listError 不會靜靜消失。**不**寫進 missing ——
             連不上跟「沒有這個人」是兩件事，下次換頁應該再試一次。 */
          this.listError = e instanceof Error ? e.message : '賣家資料載入失敗'
        } finally {
          inflight.delete(id)
        }
      })()
      inflight.set(id, p)
      return p
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
