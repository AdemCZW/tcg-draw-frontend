/**
 * 託管訂單的狀態機。
 *
 * 這裡全是純函式，不碰 Vue、不碰 store、不碰時間 —— `now` 一律由呼叫端傳進來。
 * 這樣做的理由是這塊必須可驗證：時限判斷錯了，錢就會卡在錯的人手上，
 * 而這種錯誤在 UI 上很難看出來，只能靠對函式本身下輸入來確認。
 *
 * 規格見 /trade-protection。
 */
import type { Order, OrderStatus } from '@/types/models'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

/** 下單後多久內必須出貨，逾期自動取消退款並沒收保證金 */
export const SHIP_DEADLINE = 72 * HOUR
/** 出貨後多久物流仍查無送達，自動退款買家 */
export const DELIVER_DEADLINE = 14 * DAY
/** 送達後的驗收期，期滿自動放款給賣家 */
export const INSPECT_WINDOW = 7 * DAY
/** 爭議開立後雙方補件的時間 */
export const EVIDENCE_WINDOW = 48 * HOUR

/**
 * 賣家保證金。
 *
 * 比例不套在貨款上 —— 貨款一律 100% 凍結。保證金是另一筆押品，
 * 而且一定要有絕對值上限：不設上限的話高單價卡會被門檻直接擋死，
 * 頭部交易就做不成了。
 */
export const DEPOSIT_CAP = 5_000
export function depositFor(price: number, sellerCompletedOrders: number): number {
  const rate = sellerCompletedOrders < 10 ? 0.10 : sellerCompletedOrders < 50 ? 0.05 : 0.02
  return Math.min(Math.round(price * rate), DEPOSIT_CAP)
}

/** 還在跑的訂單（點數仍被凍結） */
export const OPEN_STATUSES: OrderStatus[] = ['escrowed', 'shipped', 'delivered', 'disputed']
export const isOpen = (o: Order) => OPEN_STATUSES.includes(o.status)

export interface Deadline {
  /** 到期的絕對時間 */
  at: number
  /** 在等什麼 */
  label: string
  /** 到期會發生什麼 */
  then: string
  /** 逾期的後果對誰有利，用來決定顯示的顏色 */
  tone: 'ok' | 'warn' | 'danger'
}

/** 這張訂單現在在等哪一個時限。已結案的回 null。 */
export function deadlineOf(o: Order): Deadline | null {
  switch (o.status) {
    case 'escrowed':
      return {
        at: o.createdAt + SHIP_DEADLINE,
        label: '賣家出貨期限', then: '逾期自動取消、全額退款、沒收保證金', tone: 'warn'
      }
    case 'shipped':
      return {
        at: (o.shippedAt ?? o.createdAt) + DELIVER_DEADLINE,
        label: '物流送達期限', then: '逾期視同未送達，自動退款', tone: 'warn'
      }
    case 'delivered':
      return {
        at: (o.deliveredAt ?? o.createdAt) + INSPECT_WINDOW,
        label: '驗收期', then: '期滿自動放款給賣家', tone: 'ok'
      }
    case 'disputed':
      return {
        at: (o.disputedAt ?? o.createdAt) + EVIDENCE_WINDOW,
        label: '補件期限', then: '逾期依現有證據裁決', tone: 'danger'
      }
    default:
      return null
  }
}

/**
 * 套用時限規則。
 *
 * 回傳新物件而不是就地修改 —— 呼叫端要能比較「有沒有變」來決定要不要寫回，
 * 就地改的話 Vue 的 setter 看到同一個參考不會觸發更新（這個坑在市場頁踩過一次）。
 *
 * 爭議逾期刻意不自動裁決：那是人要判的，自動判會把錯誤放大成規模。
 * 補件期滿只代表平台可以依現有證據處理，不代表系統自己決定給誰。
 */
export function applyDeadlines(o: Order, now: number): Order {
  if (!isOpen(o)) return o
  const d = deadlineOf(o)
  if (!d || now < d.at) return o

  switch (o.status) {
    case 'escrowed':
      return { ...o, status: 'cancelled', settledAt: d.at, closedBy: 'ship-timeout' }
    case 'shipped':
      return { ...o, status: 'refunded', settledAt: d.at, closedBy: 'delivery-timeout' }
    case 'delivered':
      return { ...o, status: 'completed', settledAt: d.at, closedBy: 'auto-release' }
    default:
      // 爭議補件逾期不自動裁決，維持 disputed 等人處理
      return o
  }
}

export type Action =
  | 'ship'          // 賣家：上傳單號標記出貨
  | 'confirm'       // 買家：確認收貨，立即放款
  | 'dispute'       // 買家：開爭議（須附開箱影片）
  | 'resolve-buyer' // 平台：判買家
  | 'resolve-seller'// 平台：判賣家

/** 這個角色現在能做什麼。UI 只依這個結果決定要顯示哪些按鈕。 */
export function actionsFor(o: Order, role: 'buyer' | 'seller' | 'platform'): Action[] {
  if (!isOpen(o)) return []
  if (role === 'seller') return o.status === 'escrowed' ? ['ship'] : []
  if (role === 'buyer') return o.status === 'delivered' ? ['confirm', 'dispute'] : []
  return o.status === 'disputed' ? ['resolve-buyer', 'resolve-seller'] : []
}

/**
 * 單號長相檢查。
 *
 * 真正該做的是打物流商的 API 確認單號存在、且交寄時間晚於訂單成立時間 ——
 * 光看格式擋不掉「填一組別人的舊單號」。這裡只做最低限度的格式擋，
 * 接上物流查詢之前，這個函式是佔位不是保護。
 */
export function looksLikeTracking(s: string): boolean {
  return /^[A-Za-z0-9-]{8,24}$/.test(s.trim())
}

/** 剩餘時間的人話描述 */
export function remainText(ms: number): string {
  if (ms <= 0) return '已到期'
  const d = Math.floor(ms / DAY)
  if (d >= 1) return `剩 ${d} 天`
  const h = Math.floor(ms / HOUR)
  if (h >= 1) return `剩 ${h} 小時`
  return `剩 ${Math.max(1, Math.floor(ms / 60_000))} 分鐘`
}

export const STATUS_TEXT: Record<OrderStatus, string> = {
  escrowed: '已鎖點・等出貨',
  shipped: '運送中',
  delivered: '已送達・驗收中',
  disputed: '爭議處理中',
  completed: '已完成',
  refunded: '已退款',
  cancelled: '已取消'
}
