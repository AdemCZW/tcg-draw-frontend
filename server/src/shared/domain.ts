/* ⚠️ 這個檔案是複製本，不要手動編輯。
   真正的來源是 src/shared/（repo 根目錄），改那邊之後跑
   `npm run sync-shared`（在 server/ 底下）重新產生這份複製。
   為什麼需要複製一份見 scripts/sync-shared.mjs 開頭的說明。 */
/**
 * 交易領域的型別。前後端共用。
 *
 * 這個資料夾裡的東西不能 import 任何前端的東西 —— 不能有 Vue、不能有 '@/' 別名、
 * 不能碰 window。後端會直接吃這些檔案，帶進一個瀏覽器 API 就是編譯失敗。
 * 資料夾內部一律用相對路徑。
 */

export type Grader = 'PSA' | 'BGS' | 'ARS' | 'RAW'

export interface CardItem {
  id: string
  name: string
  setCode: string
  cardNo: string
  language: 'JP' | 'EN'
  grader: Grader
  /** RAW = null */
  grade: number | null
  /** 鑑定編號。整套爭議判定能成立的關鍵 —— 每個殼唯一，可對外查證 */
  certNo: string | null
  image: string
  /**
   * 賣家標示的參考價（**純顯示**）。
   *
   * null = 賣家沒有標示。**不要退回成 0** —— 0 在畫面上讀起來是
   * 「這張卡不值錢」，跟「沒有標示」是兩件完全不同的事。
   * 這個欄位不參與任何金額計算：回收看的是賣家宣告的買回價
   * （見 docs/HANDOFF.md 4.1 與 src/lib/recycle.ts）。
   */
  refPrice: number | null
  /** TCGdex 卡片編號，例如 'SV4a-349' */
  artId?: string
  /**
   * 卡片變體（TCGdex variants_detailed 的 variantId）。
   *
   * 為什麼卡號不夠：同一組卡號可能是完全不同的商品。實測 SV2a-025（ピカチュウ）
   * 普卡 cardmarket €0.02、同一組卡號的マスターボールミラー €369 —— 差約 18,000 倍。
   * 少了這一欄，「SV2a-025」在系統裡（包括公平性承諾的 manifest 裡）
   * 是同一個東西，賣家可以在開賣後把貴的那一版換成便宜的那一版而不被抓到。
   *
   * 這一欄**會進 manifest v4**（src/shared/fairness.ts），所以它跟卡名、
   * 鑑定編號一樣是承諾的一部分，開賣後改不了。
   *
   * null / undefined = 沒有指定變體。卡冊來的實體卡靠 certNo 定位，
   * 本來就不需要它；目錄卡沒有變體資料時也是空的。
   */
  variantId?: string | null
  /**
   * PSA 鑑定編號的查證狀態。**後端在開池時填，前端不送**（見 server/src/psa.ts）。
   *
   *   'verified'  已向 PSA 查證，且卡號對得上（或賣家確認過是同一張）
   *   'pending'   有 certNo 但暫時無法查證（API 待核准／未設定）—— 顯示「未驗證」
   *   null        這張卡沒有 certNo，不需要驗證
   *
   * **刻意不進 manifest**（src/shared/fairness.ts 只序列化卡片身分那幾欄）：
   * 它是會變的附註，今天 pending、明天 API 通了重驗就變 verified，
   * 綁進承諾會讓一次誠實的重新查證看起來像竄改。
   */
  psaStatus?: 'verified' | 'pending' | null
}

/**
 * 交付方式。決定這筆交易要不要走託管：
 *   vault 卡還在保管庫 —— 成交是一筆所有權異動，沒有運送、沒有驗收期
 *   ship  卡在賣家手上 —— 要寄送，付款與交付之間有時間差，需要託管
 */
export type Delivery = 'vault' | 'ship'

export interface Listing {
  id: string
  card: CardItem
  price: number
  sellerId: string
  sellerName: string
  listedAt: string
  status: 'live' | 'sold'
  fromPrizeId?: string
  delivery?: Delivery
}

export type OrderStatus =
  /** 已鎖點，等賣家出貨 */
  | 'escrowed'
  /** 已出貨，運送中 */
  | 'shipped'
  /** 已送達，驗收期內 */
  | 'delivered'
  /** 爭議處理中 */
  | 'disputed'
  /** 已放款給賣家 */
  | 'completed'
  /** 已退款給買家 */
  | 'refunded'
  /** 逾期未出貨，自動取消 */
  | 'cancelled'

export type ClosedBy =
  | 'buyer-confirm' | 'auto-release' | 'ship-timeout'
  | 'delivery-timeout' | 'dispute-buyer' | 'dispute-seller'

export interface Order {
  id: string
  listingId: string
  card: CardItem
  /** 貨款，成立時從買家帳戶凍結的點數 */
  price: number
  /** 賣家保證金。爭議判賣家敗訴或逾期未出貨時沒收 */
  deposit: number
  buyerId: string
  buyerName: string
  sellerId: string
  sellerName: string
  status: OrderStatus
  /** 毫秒時間戳。沒發生的階段是 undefined */
  createdAt: number
  shippedAt?: number
  deliveredAt?: number
  settledAt?: number
  tracking?: string
  disputedAt?: number
  disputeReason?: string
  hasUnboxingVideo?: boolean
  closedBy?: ClosedBy
}

/**
 * 這筆掛單走哪一條通道。
 *
 * 後端建立掛單時一定會寫 delivery，但舊資料與 mock 的種子不一定有，
 * 所以留一條推導：抽到之後沒提領的卡（帶 fromPrizeId）與平台自營的卡
 * 都還躺在保管庫裡，成交只是過戶；其餘當成賣家手上的實體卡，要寄送。
 * delivery 一旦有值就以它為準 —— 使用者可以先提領再上架，那時候推導會失準。
 *
 * 放在共用層而不是各頁自己寫一份：買下之後錢是「扣掉」還是「凍結」全看這個
 * 判斷，市場列表、掛單詳情、mock 的成交邏輯三邊只要有一邊走岔，
 * 使用者看到的通道徽章就會跟實際發生的事對不起來。
 */
export const deliveryOf = (
  l: Pick<Listing, 'delivery' | 'fromPrizeId' | 'sellerId'>
): Delivery => l.delivery ?? (l.fromPrizeId || l.sellerId === 'platform' ? 'vault' : 'ship')
