/**
 * 託管訂單的狀態機。
 *
 * 這裡全是純函式，不碰 Vue、不碰 store、不碰時間 —— `now` 一律由呼叫端傳進來。
 * 這樣做的理由是這塊必須可驗證：時限判斷錯了，錢就會卡在錯的人手上，
 * 而這種錯誤在 UI 上很難看出來，只能靠對函式本身下輸入來確認。
 *
 * 規格見 /trade-protection。
 *
 * 這個檔案前後端共用，所以不能 import 任何前端的東西 ——
 * 沒有 Vue、沒有 '@/' 別名、沒有 window。伺服器必須是唯一權威，
 * 但兩邊跑同一份規則就消滅了「前端顯示剩 5 天、後端第 7 天才放款」這類漂移。
 */
import type { Order, OrderStatus } from './domain'

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
        /* 逾期**視同送達**，不是視同未送達。
           原本這裡是「自動退款」，那個預設方向是反的：賣家手上有經過格式
           驗證的物流單號，而「買家沉默」被一律推定成「沒送到」——等於任何
           買家都可以收到卡之後什麼都不按、等 14 天，然後卡跟錢都留在他手上。
           沉默不該是白拿一張卡的手段。
           真的沒收到的買家會去開爭議，那本來就是他會做的動作；
           開了爭議才輪到平台人工查單號（見 SHIP_DEADLINE 附近的說明）。 */
        label: '物流送達期限', then: '期滿視同送達，接著進入 7 天驗收期', tone: 'ok'
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
      /* 視同送達，驗收期從這一刻起算（deliveredAt 用時限那一刻而不是 now，
         這樣「補算」跟「當下就跑到」算出來的結果一樣 —— 時限是用時間戳
         推導的，不能依賴誰什麼時候上線觸發掃描）。
         注意它不是終局狀態：接著還有 7 天驗收期，買家在那期間仍然可以
         開爭議。所以沉默的買家最終會走到 completed，總長 14 + 7 = 21 天。 */
      return { ...o, status: 'delivered', deliveredAt: d.at }
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
  /* 買家在 shipped 就能按，不必等到 delivered。
     delivered 這個狀態現在只有平台帳號標得動（未來的物流 webhook 落點），
     而那個 webhook 還沒接 —— 只認 delivered 的話，真實流程裡買家永遠
     按不到確認收貨，賣家寄了卡卻要等到時限把訂單判掉。
     讓買家自己按是安全的：按下去對他自己不利（啟動驗收期倒數、
     或直接放款），所以不會有人濫按。 */
  if (role === 'buyer') {
    return o.status === 'shipped' || o.status === 'delivered' ? ['confirm', 'dispute'] : []
  }
  return o.status === 'disputed' ? ['resolve-buyer', 'resolve-seller'] : []
}

/**
 * 單號長相檢查。
 *
 * 依物流商驗證單號。
 *
 * 原本只有一條 /^[A-Za-z0-9-]{8,24}$/ —— 什麼都收，連 ABCD1234 都算合法。
 * 那條規則擋不住假單號，也擋不住**誠實賣家打錯字**，而打錯的後果一樣重：
 * 訂單卡在運送中十四天，到期自動退款，買家的錢被鎖了兩週、賣家沒拿到錢、
 * 貨其實已經寄出去了。所以這裡的第一個目的其實是防手誤，不是防詐騙。
 *
 * 中華郵政走萬國郵政聯盟的 S10 標準（2 英文字母 + 9 位數字 + 2 位國碼），
 * 其中第 9 位數字是前 8 位的 mod-11 檢查碼 —— 這是有公開規格的，
 * 隨手編一組數字幾乎不可能通過。其餘物流商的單號規則沒有公開的檢查碼演算法，
 * 不要憑感覺發明一套，只驗字元集與長度，並在註解標明哪些是驗證過的、
 * 哪些只是啟發式。
 *
 * 「其他」這個選項刻意保留寬鬆規則：我們沒有model到的物流商不該讓真的有寄貨的
 * 賣家卡住。但訂單會記下 carrier，平台看得出這筆的單號沒有經過驗證。
 *
 * 這些都還是**離線**驗證。要確認「這組單號真的存在、而且交寄時間晚於訂單成立」
 * 只能打物流商的 API，那需要跟各家申請帳號，是另一件事。
 */
export type Carrier = 'post' | 'tcat' | 'seven' | 'family' | 'hilife' | 'shopee' | 'other'

export const CARRIERS: { id: Carrier; label: string; hint: string }[] = [
  { id: 'post',   label: '中華郵政',     hint: '例：RR123456785TW' },
  { id: 'tcat',   label: '黑貓宅急便',   hint: '10 或 12 位數字' },
  { id: 'seven',  label: '7-11 交貨便',  hint: '8～12 位數字' },
  { id: 'family', label: '全家店到店',   hint: '10～12 位數字' },
  { id: 'hilife', label: '萊爾富',       hint: '10～12 位數字' },
  { id: 'shopee', label: '蝦皮店到店',   hint: '英數字混合' },
  { id: 'other',  label: '其他',         hint: '單號不會被驗證' }
]

/**
 * 萬國郵政聯盟 S10 的檢查碼。
 * 前 8 位數字各乘權重 [8,6,4,2,3,5,9,7] 後加總，取 mod 11，
 * 檢查碼 = 11 − 餘數；結果為 10 時記為 0、為 11 時記為 5。
 */
function s10CheckDigit(eight: string): number {
  const w = [8, 6, 4, 2, 3, 5, 9, 7]
  let sum = 0
  for (let i = 0; i < 8; i++) sum += Number(eight[i]) * w[i]!
  const r = 11 - (sum % 11)
  return r === 10 ? 0 : r === 11 ? 5 : r
}

/** 驗證結果帶原因 —— 只回 false 的話畫面只能說「格式不正確」，使用者不知道錯在哪 */
export function validateTracking(carrier: Carrier, raw: string): { ok: boolean; reason?: string } {
  const s = raw.trim().toUpperCase()
  if (!s) return { ok: false, reason: '請填單號' }

  switch (carrier) {
    case 'post': {
      const m = /^([A-Z]{2})(\d{9})([A-Z]{2})$/.exec(s)
      if (!m) return { ok: false, reason: '中華郵政單號是 2 個英文字母 + 9 位數字 + 2 位國碼，例如 RR123456785TW' }
      const digits = m[2]!
      if (s10CheckDigit(digits.slice(0, 8)) !== Number(digits[8])) {
        return { ok: false, reason: '單號的檢查碼不對，請確認有沒有打錯字' }
      }
      return { ok: true }
    }
    case 'tcat':
      return /^\d{10}$|^\d{12}$/.test(s)
        ? { ok: true }
        : { ok: false, reason: '黑貓的單號是 10 或 12 位數字' }
    case 'seven':
      return /^\d{8,12}$/.test(s)
        ? { ok: true }
        : { ok: false, reason: '7-11 交貨便的單號是 8～12 位數字' }
    case 'family':
    case 'hilife':
      return /^\d{10,12}$/.test(s)
        ? { ok: true }
        : { ok: false, reason: '店到店的單號是 10～12 位數字' }
    case 'shopee':
      return /^[A-Z0-9]{10,20}$/.test(s)
        ? { ok: true }
        : { ok: false, reason: '蝦皮的單號是 10～20 位英數字' }
    case 'other':
      // 沒有 model 到的物流商：只做最低限度的字元檢查，不假裝驗證過
      return /^[A-Z0-9-]{8,24}$/.test(s)
        ? { ok: true }
        : { ok: false, reason: '單號只能是英數字與連字號，長度 8～24' }
  }
}

/** @deprecated 舊的純格式檢查。留著只為了不讓既有呼叫端一次全壞，新程式請用 validateTracking */
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
