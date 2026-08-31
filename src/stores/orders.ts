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
import { applyDeadlines, depositFor, isOpen, validateTracking, type Carrier } from '@/shared/escrow'
import { useWalletStore } from '@/stores/wallet'
import { useAuthStore } from '@/stores/auth'
import { MOCK } from '@/lib/config'
import { http } from '@/lib/http'
import { ORDER_ROUTES } from '@/shared/contract'

/* API 模式：伺服器擁有訂單狀態。每個動作 = 打端點 → 重新載入。
   時限的推進在伺服器（讀取時重算 + 排程），前端只顯示。 */
type OrdersRes = { orders: Order[]; wallet: { points: number; locked: number }; serverTime: number }
async function pull(): Promise<OrdersRes> {
  const r = await http<OrdersRes>(ORDER_ROUTES.list())
  useWalletStore().applyServer(r.wallet)
  return r
}

/**
 * 收件資訊。
 *
 * **權限判斷已經在伺服器的 SQL 裡做完了**（見 server/src/routes/orders.ts 的
 * canShip）：只有這筆訂單的賣家、而且訂單還開著的時候才會有值。
 * 前端不再判斷一次「該不該顯示」—— 同一條規則有兩個來源，遲早會分岔，
 * 而分岔的其中一個方向是把買家的住址顯示給不該看的人。
 * 前端只判斷「有沒有值」與「哪幾欄是空的」。
 *
 * 型別宣告在這裡而不是 shared/domain.ts：那個檔案前後端共用，這次不動它。
 * 讀取一律走 shipToOf()，不要在頁面裡自己寫 cast —— 只有一處知道這件事，
 * 之後型別搬回 domain.ts 時也只有一處要改。
 */
export interface ShipTo {
  name?: string
  phone?: string
  zip?: string
  city?: string
  line1?: string
}
export const shipToOf = (o: Order): ShipTo | undefined =>
  (o as Order & { ship?: ShipTo }).ship

/**
 * 「訂單上的這個 id 是不是我」。
 *
 * 角色判斷（我是買家還是賣家）以前是拿 id 去跟寫死的字串 'me' 比 ——
 * 那是 mock 種子留下來的代號。正式環境的 buyerId / sellerId 是真的 user id
 * （u-xxxx），**永遠不等於 'me'**，所以每一筆訂單都會被判成「我是買家」：
 * 賣家在正式站看自己的訂單會拿到買家視角，看不到收件資訊、按不到「我已寄出」，
 * 然後在出貨期限到期時被判逾期未出貨、沒收保證金。錢會因為這個字串搬到錯的人手上。
 *
 * 判準改成跟登入者的 id 比對。'me' 仍然要收：localStorage 裡已經存在的 mock
 * 訂單是用那個字串寫進去的，不收的話使用者本機的舊訂單會整批變成「不是我的」。
 * 但新造的種子一律改用真實格式的 id（見 seedSellerOrder / seedBuyerOrder），
 * 這樣開發時看到的形狀就跟正式環境一樣 —— 同一個 bug 才不會再躲過一次。
 */
export function isSelf(id?: string | null): boolean {
  if (!id) return false
  if (id === 'me') return true
  return id === useAuthStore().user?.id
}

const KEY = 'vd_orders_v1'
/** demo 用的時間位移，讓人不用真的等 7 天就能看完整個流程 */
const OFFSET_KEY = 'vd_orders_offset'

export const useOrdersStore = defineStore('orders', {
  state: () => ({
    orders: [] as Order[],
    /** demo 時鐘：加在真實時間上的毫秒偏移。API 模式永遠是 0 */
    offset: MOCK ? Number(localStorage.getItem(OFFSET_KEY) || 0) : 0,
    /** API 模式：伺服器時間與本機的差，倒數用伺服器時間算，不信使用者的裝置時鐘 */
    serverOffset: 0,
    loaded: false
  }),

  getters: {
    /** demo 時鐘。所有時限判斷都走這裡，不直接用 Date.now() */
    now: (s) => () => Date.now() + (MOCK ? s.offset : s.serverOffset),
    asBuyer: (s) => s.orders.filter(o => isSelf(o.buyerId)),
    asSeller: (s) => s.orders.filter(o => isSelf(o.sellerId)),
    openCount: (s) => s.orders.filter(isOpen).length
  },

  actions: {
    async load() {
      if (!MOCK) {
        const r = await pull()
        this.orders = r.orders
        this.serverOffset = r.serverTime - Date.now()
        this.loaded = true
        return
      }
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
      if (!MOCK) return
      localStorage.setItem(KEY, JSON.stringify(this.orders))
      localStorage.setItem(OFFSET_KEY, String(this.offset))
    },

    /**
     * 把所有到期的訂單補算到現在。
     * 結案的訂單要同時處理凍結的點數，否則餘額會跟訂單狀態對不起來。
     */
    async sweep() {
      if (!MOCK) { const r = await pull(); this.orders = r.orders; return }
      const t = Date.now() + this.offset
      let changed = false
      this.orders = this.orders.map(o => {
        const next = applyDeadlines(o, t)
        if (next === o) return o
        changed = true
        if (isSelf(o.buyerId) && next.status === 'completed') useWalletStore().charge(next.price)
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
          .filter(o => isSelf(o.buyerId) && isOpen(o))
          .reduce((sum, o) => sum + o.price, 0)
      )
    },

    /** 訂單結案時，只有「放款」需要真的扣錢；退款與取消不動餘額 */
    releaseFor(o: Order) {
      if (o.status === 'completed') useWalletStore().charge(o.price)
      this.syncLocked()
    },

    /** 買下需寄送的掛單 → 建立託管訂單並凍結點數 */
    async createFromListing(l: Listing, buyerName: string): Promise<Order> {
      if (!MOCK) {
        const r = await pull()
        this.orders = r.orders
        const o = r.orders.find(x => x.listingId === l.id)
        if (!o) throw new Error('訂單尚未建立')
        return o
      }
      const t = Date.now() + this.offset
      const completed = this.orders.filter(o => o.sellerId === l.sellerId && o.status === 'completed').length
      const o: Order = {
        id: 'o-' + t.toString(36),
        listingId: l.id,
        card: l.card as CardItem,
        price: l.price,
        deposit: depositFor(l.price, completed),
        /* 買家 id 用登入者真實的 id，不要再寫 'me'。
           mock 造出來的訂單形狀要跟伺服器回來的一樣，否則只有 mock 會過的
           判斷（例如角色判斷）會一路活到正式環境才爆。沒登入才退回 'me'。 */
        buyerId: useAuthStore().user?.id ?? 'me', buyerName,
        sellerId: l.sellerId, sellerName: l.sellerName,
        status: 'escrowed',
        createdAt: t
      }
      this.orders.unshift(o)
      this.persist()
      this.syncLocked()
      return o
    },

    /**
     * demo：直接塞一張已經在跑的訂單，用來看賣家視角。
     *
     * ship 是選填，而且**三種情況都要能造得出來** —— 買家填了完整收件資料、
     * 只填了一部分、完全沒填。第三種在正式環境是常態（會員資料全部欄位都不
     * 強制），而它正是最容易被做壞的那個畫面：沒有這個種子，開發時只會看到
     * 有地址的版本，賣家對著一片空白的那一版永遠沒有人看過。
     */
    seedSellerOrder(card: CardItem, price: number, ship?: ShipTo) {
      const t = Date.now() + this.offset
      /* sellerId 用登入者真實的 id，不再寫 'me'。
         這一行本身就是那個角色判斷 bug 之所以躲了這麼久的原因：種子造出來的
         訂單長得跟正式環境不一樣，所以「sellerId === 'me'」在開發時永遠是對的。
         種子必須跟伺服器回來的資料同形，它才有資格當驗證的依據。 */
      const me = useAuthStore().user
      const o: Order & { ship?: ShipTo } = {
        id: 'o-seed-' + t.toString(36),
        listingId: 'seed', card, price,
        deposit: depositFor(price, 0),
        buyerId: 'u-9A44', buyerName: 'VD-9A44',
        sellerId: me?.id ?? 'me', sellerName: me?.name ?? '我',
        status: 'escrowed', createdAt: t - 6 * 3_600_000,
        ...(ship ? { ship } : {})
      }
      this.orders.unshift(o)
      this.persist()
    },

    /**
     * demo：買家視角的訂單。刻意不帶 ship —— 伺服器對買家本來就不會給。
     *
     * 五種狀態都造得出來，因為買家那半的畫面**每一種狀態講的話都不一樣**
     * （在等什麼、錢在哪、我能按什麼）。只造得出一種的話，其餘四種永遠
     * 沒有人看過，而「已完成」與「爭議中」正是使用者最焦慮、最會回來看的兩種。
     *
     * 賣家用 mock 的真實賣家（保庫堂 s1），不是隨手編的 u-7C12 ——
     * 買家視角要顯示賣家等級與評價，那些資料掛在賣家檔案上，
     * 編一個不存在的 id 只會讓開發時永遠看到「查不到賣家」的退路版本。
     */
    seedBuyerOrder(
      card: CardItem, price: number,
      status: 'escrowed' | 'shipped' | 'delivered' | 'disputed' | 'completed' = 'shipped',
      seller: { id: string; name: string } = { id: 's1', name: '保庫堂' }
    ) {
      const t = Date.now() + this.offset
      const H = 3_600_000
      const me = useAuthStore().user
      /* 每一種狀態的時間戳都要讓倒數落在「看得出意義」的區間，而且
         remainText 的兩種格式都要驗到：escrowed 留 14 小時（小時級）、
         shipped 留 13 天（天級）。只驗天級的話，小時級那條分支
         （剩不到一天、最急的那一刻）永遠沒有人看過。 */
      const stamps: Record<string, Partial<Order>> = {
        escrowed: { createdAt: t - 58 * H },
        shipped: { createdAt: t - 30 * H, shippedAt: t - 4 * H },
        delivered: { createdAt: t - 120 * H, shippedAt: t - 96 * H, deliveredAt: t - 24 * H },
        disputed: {
          createdAt: t - 144 * H, shippedAt: t - 120 * H, deliveredAt: t - 48 * H,
          disputedAt: t - 3 * H, disputeReason: '外盒完好，但卡片邊角有壓痕，跟賣場照片不符',
          hasUnboxingVideo: true
        },
        completed: {
          createdAt: t - 216 * H, shippedAt: t - 192 * H, deliveredAt: t - 168 * H,
          settledAt: t - H, closedBy: 'buyer-confirm'
        }
      }
      this.orders.unshift({
        id: 'o-buy-' + t.toString(36),
        listingId: 'seed', card, price,
        deposit: depositFor(price, 0),
        buyerId: me?.id ?? 'me', buyerName: me?.name ?? '我',
        sellerId: seller.id, sellerName: seller.name,
        status, createdAt: t,
        ...stamps[status]
      } as Order)
      this.persist()
    },

    patch(id: string, fields: Partial<Order>) {
      this.orders = this.orders.map(o => (o.id === id ? { ...o, ...fields } : o))
      this.persist()
    },

    /* ---- 四個狀態轉換。每一個都對應規格裡的一個步驟 ---- */

    /**
     * 賣家出貨 ＝「我已寄出」。
     *
     * 物流商、單號、出貨照三個門檻全部拿掉了（使用者拍板的模型：寄送與確認
     * 由雙方私下完成，平台只給收件資訊 ＋ 一個雙方按下完成的機制）。
     * 所以這個動作現在**不帶任何必要參數也成立**，後端收 {} 就出得了貨。
     *
     * 出貨照整條不再送。後端還收得下 photoFileIds 只是為了讓舊版客戶端不壞，
     * 前端沒有理由繼續傳一組不再是條件的東西。
     *
     * 單號有填才驗，而且驗證留在資料層：任何呼叫端（測試、之後的其他頁面）
     * 都該受同一套約束，只擋在按鈕的 disabled 上，直接呼叫就繞過去了。
     * 沒填就跳過 —— 空字串不是「格式錯誤」，是「沒有提供」。
     */
    async ship(id: string, opts: { carrier?: Carrier; tracking?: string } = {}): Promise<boolean> {
      const tracking = (opts.tracking ?? '').trim()
      const carrier = opts.carrier
      if (!MOCK) {
        /* 沒填的欄位不要送空字串。後端的 tracking 有 min(6) 而且唯一索引把
           空字串當成一個值 —— 送 '' 會變成「第二筆沒填單號的訂單被擋下來」。 */
        await http(ORDER_ROUTES.ship(id), {
          method: 'POST',
          json: { ...(carrier ? { carrier } : {}), ...(tracking ? { tracking } : {}) }
        })
        await this.sweep()
        return true
      }
      const o = this.orders.find(x => x.id === id)
      if (!o || o.status !== 'escrowed') return false
      // 沒選物流商時用最寬鬆的規則驗，跟後端的 carrier ?? 'other' 一致
      if (tracking && !validateTracking(carrier ?? 'other', tracking).ok) return false
      this.patch(id, {
        status: 'shipped',
        shippedAt: Date.now() + this.offset,
        // 後端會把單號轉大寫，mock 跟著做，不然兩種模式顯示出來的單號長得不一樣
        ...(tracking ? { tracking: tracking.toUpperCase() } : {})
      })
      return true
    },

    /** 物流簽收。真實情況是輪詢物流商回報，demo 由按鈕代打 */
    async markDelivered(id: string) {
      if (!MOCK) {
        // 正式版是物流 webhook；測試用的端點限平台帳號
        await http(`/v1/orders/${id}/delivered`, { method: 'POST' })
        await this.sweep()
        return
      }
      const o = this.orders.find(x => x.id === id)
      if (!o || o.status !== 'shipped') return
      this.patch(id, { status: 'delivered', deliveredAt: Date.now() + this.offset })
    },

    /** 買家確認收貨，立即放款 */
    async confirm(id: string) {
      if (!MOCK) { await http(ORDER_ROUTES.confirm(id), { method: 'POST' }); await this.sweep(); return }
      const o = this.orders.find(x => x.id === id)
      /* shipped 也收 —— 判準跟 shared/escrow.ts 的 actionsFor 一致。
         只認 delivered 的話，mock 模式會出現「按鈕按得下去但什麼都沒發生」，
         而那是最難查的一種 bug。 */
      if (!o || (o.status !== 'shipped' && o.status !== 'delivered')) return
      const next: Order = { ...o, status: 'completed', settledAt: Date.now() + this.offset, closedBy: 'buyer-confirm' }
      this.orders = this.orders.map(x => (x.id === id ? next : x))
      if (isSelf(o.buyerId)) this.releaseFor(next)
      this.persist()
    },

    /** 買家開爭議。沒有開箱影片不受理 —— 這是規格裡「舉證綁在索賠上」的實作 */
    async dispute(id: string, reason: string, hasVideo: boolean, videoUrl = '') {
      if (!MOCK) {
        await http(ORDER_ROUTES.dispute(id), { method: 'POST', json: { reason, videoUrl } })
        await this.sweep()
        return
      }
      const o = this.orders.find(x => x.id === id)
      if (!o || (o.status !== 'shipped' && o.status !== 'delivered') || !hasVideo) return
      this.patch(id, {
        status: 'disputed', disputedAt: Date.now() + this.offset,
        disputeReason: reason, hasUnboxingVideo: hasVideo
      })
    },

    /** 平台裁決 */
    async resolve(id: string, to: 'buyer' | 'seller') {
      if (!MOCK) { await http(ORDER_ROUTES.resolve(id), { method: 'POST', json: { to, note: '' } }); await this.sweep(); return }
      const o = this.orders.find(x => x.id === id)
      if (!o || o.status !== 'disputed') return
      const next: Order = {
        ...o,
        status: to === 'buyer' ? 'refunded' : 'completed',
        settledAt: Date.now() + this.offset,
        closedBy: to === 'buyer' ? 'dispute-buyer' : 'dispute-seller'
      }
      this.orders = this.orders.map(x => (x.id === id ? next : x))
      if (isSelf(o.buyerId)) this.releaseFor(next)
      this.persist()
    },

    /** demo：把時鐘往前撥，看時限到期會發生什麼 */
    travel(ms: number) {
      if (!MOCK) return   // demo 時鐘只有 mock 有；伺服器的時間不能撥
      this.offset += ms
      this.sweep()
      this.persist()
    },

    reset() {
      if (!MOCK) return
      this.orders = []
      this.offset = 0
      this.persist()
      this.syncLocked()
    }
  }
})
