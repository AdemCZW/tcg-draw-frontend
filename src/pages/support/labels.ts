/**
 * 工單的白話文案與時間格式。三頁共用一份。
 *
 * 為什麼抽出來：資料庫的英文狀態（open / pending-user / resolved / rejected）
 * 不能直接吐給使用者看，而列表、詳情、開單三個畫面**必須說同一句話** ——
 * 同一張單在列表寫「等你回覆」、進去卻寫「處理中」，使用者會以為是兩件事。
 */
import type { TicketKind, TicketStatus } from '@/lib/api'

/** 徽章的語氣。對應 tokens.css 的四組 wash / ink，不要在元件裡寫死 hex */
export type Tone = 'wait' | 'act' | 'ok' | 'bad'

/**
 * 狀態的白話。
 *
 * `pending-user` 刻意寫成「等你回覆」而不是「待補件」：這是四種狀態裡
 * **唯一一個球在使用者手上**的，那句話必須讀起來像在叫他，不是在描述系統。
 */
export const STATUS_TEXT: Record<TicketStatus, { t: string; tone: Tone }> = {
  open: { t: '客服處理中', tone: 'wait' },
  'pending-user': { t: '等你回覆', tone: 'act' },
  resolved: { t: '已解決', tone: 'ok' },
  rejected: { t: '未通過', tone: 'bad' }
}

/** 結案的兩種。結案的單不能再回覆（契約第三節），畫面上要看得出來 */
export const isClosed = (s: TicketStatus) => s === 'resolved' || s === 'rejected'

export const KIND_TEXT: Record<TicketKind, string> = {
  takeover: '接管申請',
  'order-dispute': '訂單爭議',
  'seller-doc': '賣家審核',
  'card-issue': '卡片問題',
  account: '帳號問題',
  other: '其他'
}

/**
 * 開新單時選得到的類型。
 *
 * order-dispute 與 seller-doc **不在這裡** —— 那兩種只能由系統在爭議成立、
 * 文件送審成功之後自動開（契約第五節）。讓人手動開得出來的話，會出現一張
 * 沒有對應訂單／審核紀錄的空殼爭議單，而客服端結案時要呼叫的既有裁決邏輯
 * 根本找不到對象。
 *
 * 每一種都附一句「什麼時候用它」：類型選錯的單會在佇列裡繞一圈才被轉回來，
 * 那一圈的成本是使用者多等一天。
 */
export const OPENABLE_KINDS: { k: Exclude<TicketKind, 'order-dispute' | 'seller-doc'>; t: string; hint: string }[] = [
  {
    k: 'takeover', t: '接管鑑定編號',
    hint: '你在站外買到一張卡，實體卡在你手上，但編號還登記在別人名下。'
  },
  {
    k: 'card-issue', t: '卡片有問題',
    hint: '卡冊裡的卡狀態不對、圖不對、或是收到的實體卡跟描述不符。'
  },
  {
    k: 'account', t: '帳號問題',
    hint: '登入、會員資料、點數對不上這一類跟帳號本身有關的事。'
  },
  {
    k: 'other', t: '其他',
    hint: '上面都不像。寫清楚一點，我們會轉給對的人。'
  }
]

/** 這兩種是系統自動開的，開單頁要講出來 —— 不然使用者會一直找不到入口 */
export const AUTO_KINDS = ['order-dispute', 'seller-doc'] as const

const p2 = (n: number) => String(n).padStart(2, '0')

/**
 * 時間。
 *
 * 一天內給相對時間（「3 小時前」），更久給絕對日期。
 * 理由：剛送出的單使用者在意的是「多久以前」，兩週前的單在意的是「哪一天」。
 * 全部用絕對時間的話，「剛剛回的那則」看起來跟三天前的一樣遠。
 */
export function fmtWhen(t: number, now = Date.now()): string {
  if (!t) return ''
  const d = new Date(t)
  const diff = now - t
  if (diff < 60_000) return '剛剛'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分鐘前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小時前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return sameYear
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`
}

/** 訊息串上的時間要精確到分鐘 —— 對話的順序與間隔是讀懂一串對話的一部分 */
export function fmtStamp(t: number): string {
  if (!t) return ''
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
