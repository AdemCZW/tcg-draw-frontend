/**
 * 託管訂單。
 *
 * 時間軸的推進是「拉」不是「推」：沒有背景排程去改狀態，而是每次讀取時
 * 用當下時間把所有到期的訂單補算一次（sweep）。前端沒有可信的排程器 ——
 * 使用者關掉分頁時 setTimeout 就死了，回來之後狀態會停在關掉的那一刻。
 * 用時間戳推算則不管中間有沒有人在看，結果都一樣。
 *
 * 接後端時這個 store 只需要換掉三個地方：seed 改成 API 讀取、
 * 四個 mutation 改成打 API、sweep 交給伺服器做（前端只顯示）。
 */
import { defineStore } from 'pinia'
import type { CardItem, Listing, Order } from '@/types/models'
import { applyDeadlines, depositFor, isOpen, looksLikeTracking } from '@/lib/escrow'
import { useWalletStore } from '@/stores/wallet'

const KEY = 'vd_orders_v1'
/** demo 用的時間位移，讓人不用真的等 7 天就能看完整個流程 */
const OFFSET_KEY = 'vd_orders_offset'

export const useOrdersStore = defineStore('orders', {
  state: () => ({
    orders: [] as Order[],
    /** 加在真實時間上的毫秒偏移。正式版永遠是 0 */
    offset: Number(localStorage.getItem(OFFSET_KEY) || 0),
    loaded: false
  }),

  getters: {
    /** demo 時鐘。所有時限判斷都走這裡，不直接用 Date.now() */
    now: (s) => () => Date.now() + s.offset,
    asBuyer: (s) => s.orders.filter(o => o.buyerId === 'me'),
    asSeller: (s) => s.orders.filter(o => o.sellerId === 'me'),
    openCount: (s) => s.orders.filter(isOpen).length
  },

  actions: {
    load() {
      if (this.loaded) return
      const raw = localStorage.getItem(KEY)
      if (raw) {
        try { this.orders = JSON.parse(raw) as Order[] } catch { this.orders = [] }
      }
      this.loaded = true
      this.sweep()
      this.syncLocked()
    },

    persist() {
      localStorage.setItem(KEY, JSON.stringify(this.orders))
      localStorage.setItem(OFFSET_KEY, String(this.offset))
    },

    /**
     * 把所有到期的訂單補算到現在。
     * 結案的訂單要同時處理凍結的點數，否則餘額會跟訂單狀態對不起來。
     */
    sweep() {
      const t = Date.now() + this.offset
      let changed = false
      this.orders = this.orders.map(o => {
        const next = applyDeadlines(o, t)
        if (next === o) return o
        changed = true
        if (o.buyerId === 'me' && next.status === 'completed') useWalletStore().charge(next.price)
        return next
      })
      if (changed) this.persist()
      this.syncLocked()
    },

    /**
     * 把「託管中」的總額推回錢包。
     *
     * 凍結金額是從訂單推算出來的，不另外存 —— 訂單有持久化、錢包沒有，
     * 各存一份的話重新整理之後就會打架。
     */
    syncLocked() {
      const w = useWalletStore()
      w.setLocked(
        this.orders
          .filter(o => o.buyerId === 'me' && isOpen(o))
          .reduce((sum, o) => sum + o.price, 0)
      )
    },

    /** 訂單結案時，只有「放款」需要真的扣錢；退款與取消不動餘額 */
    releaseFor(o: Order) {
      if (o.status === 'completed') useWalletStore().charge(o.price)
      this.syncLocked()
    },

    /** 買下需寄送的掛單 → 建立託管訂單並凍結點數 */
    createFromListing(l: Listing, buyerName: string): Order {
      const t = Date.now() + this.offset
      const completed = this.orders.filter(o => o.sellerId === l.sellerId && o.status === 'completed').length
      const o: Order = {
        id: 'o-' + t.toString(36),
        listingId: l.id,
        card: l.card as CardItem,
        price: l.price,
        deposit: depositFor(l.price, completed),
        buyerId: 'me', buyerName,
        sellerId: l.sellerId, sellerName: l.sellerName,
        status: 'escrowed',
        createdAt: t
      }
      this.orders.unshift(o)
      this.persist()
      this.syncLocked()
      return o
    },

    /** demo：直接塞一張已經在跑的訂單，用來看賣家視角 */
    seedSellerOrder(card: CardItem, price: number) {
      const t = Date.now() + this.offset
      this.orders.unshift({
        id: 'o-seed-' + t.toString(36),
        listingId: 'seed', card, price,
        deposit: depositFor(price, 0),
        buyerId: 'u-9A44', buyerName: 'VD-9A44',
        sellerId: 'me', sellerName: '我',
        status: 'escrowed', createdAt: t - 6 * 3_600_000
      })
      this.persist()
    },

    patch(id: string, fields: Partial<Order>) {
      this.orders = this.orders.map(o => (o.id === id ? { ...o, ...fields } : o))
      this.persist()
    },

    /* ---- 四個狀態轉換。每一個都對應規格裡的一個步驟 ---- */

    /**
     * 賣家出貨。
     *
     * 單號驗證在這裡也要做一次，不能只靠 UI 的 disabled ——
     * 狀態轉換是資料層的規則，任何呼叫端（之後的 API、測試、其他頁面）
     * 都必須受同一套約束。第一版只擋在按鈕上，直接呼叫 ship(id,'BAD')
     * 就進得去，訂單會帶著一個假單號變成運送中。
     */
    ship(id: string, tracking: string): boolean {
      const o = this.orders.find(x => x.id === id)
      if (!o || o.status !== 'escrowed') return false
      if (!looksLikeTracking(tracking)) return false
      this.patch(id, { status: 'shipped', shippedAt: Date.now() + this.offset, tracking: tracking.trim() })
      return true
    },

    /** 物流簽收。真實情況是輪詢物流商回報，demo 由按鈕代打 */
    markDelivered(id: string) {
      const o = this.orders.find(x => x.id === id)
      if (!o || o.status !== 'shipped') return
      this.patch(id, { status: 'delivered', deliveredAt: Date.now() + this.offset })
    },

    /** 買家確認收貨，立即放款 */
    confirm(id: string) {
      const o = this.orders.find(x => x.id === id)
      if (!o || o.status !== 'delivered') return
      const next: Order = { ...o, status: 'completed', settledAt: Date.now() + this.offset, closedBy: 'buyer-confirm' }
      this.orders = this.orders.map(x => (x.id === id ? next : x))
      if (o.buyerId === 'me') this.releaseFor(next)
      this.persist()
    },

    /** 買家開爭議。沒有開箱影片不受理 —— 這是規格裡「舉證綁在索賠上」的實作 */
    dispute(id: string, reason: string, hasVideo: boolean) {
      const o = this.orders.find(x => x.id === id)
      if (!o || o.status !== 'delivered' || !hasVideo) return
      this.patch(id, {
        status: 'disputed', disputedAt: Date.now() + this.offset,
        disputeReason: reason, hasUnboxingVideo: hasVideo
      })
    },

    /** 平台裁決 */
    resolve(id: string, to: 'buyer' | 'seller') {
      const o = this.orders.find(x => x.id === id)
      if (!o || o.status !== 'disputed') return
      const next: Order = {
        ...o,
        status: to === 'buyer' ? 'refunded' : 'completed',
        settledAt: Date.now() + this.offset,
        closedBy: to === 'buyer' ? 'dispute-buyer' : 'dispute-seller'
      }
      this.orders = this.orders.map(x => (x.id === id ? next : x))
      if (o.buyerId === 'me') this.releaseFor(next)
      this.persist()
    },

    /** demo：把時鐘往前撥，看時限到期會發生什麼 */
    travel(ms: number) {
      this.offset += ms
      this.sweep()
      this.persist()
    },

    reset() {
      this.orders = []
      this.offset = 0
      this.persist()
      this.syncLocked()
    }
  }
})
