/**
 * 訂單 API 的介面約定。前後端共用。
 *
 * 這份檔案的用途是讓兩邊對同一組型別編譯 —— 後端回傳的形狀改了，
 * 前端會編不過，而不是等到執行時才在使用者面前壞掉。
 *
 * 端點對應到 src/shared/escrow.ts 的狀態轉換，一個端點一個轉換。
 */
import type { Order, OrderStatus } from './domain'

export const API_VERSION = 'v1'

/* ---------------- 錯誤碼 ----------------
   後端一律回 { error: OrderError, message: string }，前端依 code 決定怎麼講。
   用字串碼不用 HTTP status：同一個 409 可能是「卡被買走」也可能是
   「訂單狀態不對」，前端要能分辨才給得出有用的訊息。 */
export type OrderError =
  /** 掛單已被別人買走 */
  | 'LISTING_TAKEN'
  /** 掛單不存在或已下架 */
  | 'LISTING_NOT_FOUND'
  /** 可動用點數不足（注意：託管中的點數不算可動用） */
  | 'INSUFFICIENT_POINTS'
  /** 訂單目前的狀態不允許這個動作 */
  | 'WRONG_STATE'
  /** 物流單號查無此筆，或交寄時間早於訂單成立 */
  | 'BAD_TRACKING'
  /** 同一組單號已經用在其他訂單 */
  | 'TRACKING_REUSED'
  /** 開爭議未附開箱影片 */
  | 'NEED_VIDEO'
  /** 不是這張訂單的當事人 */
  | 'NOT_PARTY'
  /** 只有平台能做（裁決） */
  | 'NOT_PLATFORM'

export interface ApiError {
  error: OrderError
  message: string
}

/* ---------------- 端點 ---------------- */

export interface CreateOrderReq {
  listingId: string
  /** 用來擋重複送出：同一把 key 重送只會成立一張訂單 */
  idempotencyKey: string
}

export interface ShipReq {
  /** 物流單號。伺服器必須真的去查，不能只驗格式 */
  tracking: string
  /** 出貨照，需含可辨識的鑑定編號 */
  photoUrls: string[]
}

export interface DisputeReq {
  reason: string
  /** 完整未剪輯的開箱影片。沒有這個一律回 NEED_VIDEO */
  videoUrl: string
}

export interface ResolveReq {
  to: 'buyer' | 'seller'
  note: string
}

export interface WalletDto {
  /** 帳本推算出來的總餘額 */
  points: number
  /** 進行中訂單的貨款總和 */
  locked: number
}

export interface OrdersRes {
  orders: Order[]
  wallet: WalletDto
  /** 伺服器當下時間（毫秒）。前端用它算倒數，不要用使用者的裝置時間 */
  serverTime: number
}

/**
 * 端點表。
 *
 * 每一條都對應 escrow.ts 裡的一個狀態轉換；沒有對應轉換的端點就不該存在，
 * 有轉換卻沒有端點代表那個轉換只有伺服器自己能觸發（例如時限到期）。
 */
export const ORDER_ROUTES = {
  /** GET  —— 我的訂單 + 錢包 + 伺服器時間 */
  list: () => `/${API_VERSION}/orders`,
  /** POST —— 建立託管訂單，凍結買家 100% 貨款 */
  create: () => `/${API_VERSION}/orders`,
  /** POST —— 賣家出貨（escrowed → shipped） */
  ship: (id: string) => `/${API_VERSION}/orders/${id}/ship`,
  /** POST —— 買家確認收貨（delivered → completed，立即放款） */
  confirm: (id: string) => `/${API_VERSION}/orders/${id}/confirm`,
  /** POST —— 買家開爭議（delivered → disputed，須附影片） */
  dispute: (id: string) => `/${API_VERSION}/orders/${id}/dispute`,
  /** POST —— 平台裁決（disputed → completed | refunded） */
  resolve: (id: string) => `/${API_VERSION}/orders/${id}/resolve`
} as const

/**
 * 只有伺服器能觸發的轉換（時限到期）。
 * 前端不該有對應端點 —— 這幾條是 escrow.applyDeadlines() 的結果，
 * 由伺服器在讀取時補算或用排程掃出來。
 */
export const SERVER_ONLY_TRANSITIONS: Record<string, OrderStatus> = {
  'escrowed 逾 72h 未出貨': 'cancelled',
  'shipped 逾 14 天查無送達': 'refunded',
  'delivered 逾 7 天驗收期': 'completed'
}
