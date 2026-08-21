/**
 * 後台共用層：型別、格式化、狀態文案。
 *
 * 舊後台把這些散在單一元件裡，於是每加一個分頁就複製一次 fmtTime、
 * 複製一次錯誤處理。拆出來的目的不是「整潔」，是讓「某個狀態該顯示什麼字」
 * 只有一個地方會改到 —— 出貨的 shipped 在列表、詳情、會員檔案三個地方都要出現。
 */
import { ref } from 'vue'
import { http as rawHttp, ApiError } from '@/lib/http'
import { MOCK } from '@/lib/config'
import { mockAdmin } from './mock'

/* ---------- 型別 ---------- */
export interface Overview {
  users: number
  pools_open: number
  orders_open: number
  orders_disputed: number
  ship_requested: number
  ship_active: number
  escrowed_points: number
  sellers_pending: number
}
export interface AdminUser {
  id: string; handle: string; name: string | null; email: string | null
  /** 會員編號。客服查人的主要依據，舊帳號補號前可能是 null */
  member_no: string | null
  role: string; created_at: string | number
}
export interface UserDetail {
  user: AdminUser & {
    display_name: string | null; real_name: string | null; phone: string | null
    address_zip: string | null; address_city: string | null; address_line1: string | null
    birthday: string | null
  }
  providers: string[]
  wallet: { points: number; locked: number; available: number }
  prizes: { id: string; card: { name?: string }; tier: string; status: string; won_at: string | number }[]
  orders: { id: string; card: { name?: string }; price: number; status: string; created_at: string | number; buyer_id: string; seller_id: string }[]
  shipments: { id: string; status: string; tracking: string | null; created_at: string | number }[]
  ledger: { id: number; delta: number; reason: string; created_at: string | number }[]
}
export interface Shipment {
  id: string; userId: string; userHandle: string; userName: string | null
  address: { name?: string; phone?: string; zip?: string; city?: string; line1?: string }
  status: 'requested' | 'packed' | 'shipped' | 'delivered'
  tracking: string | null; createdAt: number; shippedAt: number | null
  prizes: { id: string; name?: string; tier: string }[]
}
export interface Seller {
  id: string; handle: string; name: string; tier: string
  pools?: number; faults?: number; created_at?: string | number
}
export interface Verification {
  id: string; seller_id: string; doc_file_id: string; status: string; note: string | null
  created_at: string | number; seller_name: string; seller_handle: string; tier: string
}
export interface Pool {
  id: string; title: string; mode: string; status: string
  ticket_price: number; total_tickets: number; sold: number
  created_at: string | number; opened_at: string | number | null
  seller_name: string; seller_tier: string
}
export interface Dispute {
  id: string; card: { name?: string }; price: number; status: string
  buyer_id: string; seller_id: string; created_at: string | number
}
export interface AuditAction {
  id: number; admin_id: string; action: string; target: string | null
  payload: unknown; note: string | null; created_at: string | number
}

/* ---------- 狀態文案 ----------
   後端存英文碼，畫面一律顯示中文。對照表放這裡，不放各頁的模板裡。 */
export const SHIP_LABEL: Record<string, string> = {
  requested: '待處理', packed: '已包裝', shipped: '已寄出', delivered: '已送達'
}
/** 出貨的下一步。null = 已到終點，沒有可推進的動作。 */
export const SHIP_NEXT: Record<string, 'packed' | 'shipped' | 'delivered' | null> = {
  requested: 'packed', packed: 'shipped', shipped: 'delivered', delivered: null
}
export const TIER_LABEL: Record<string, string> = {
  pending: '待審核', verified: '已驗證', trusted: '信任'
}
export const ORDER_LABEL: Record<string, string> = {
  open: '待出貨', shipped: '運送中', delivered: '已送達', inspecting: '驗收中',
  completed: '已完成', disputed: '爭議中', cancelled: '已取消', refunded: '已退款'
}
export const POOL_LABEL: Record<string, string> = {
  draft: '草稿', committed: '待開賣', open: '開放中', sold_out: '已售完',
  /* cancelled 是「提前收攤」不是「取消」—— 已經抽過的人不受影響，
     那些卡都還在他們手上。用「已收攤」才不會讓人以為抽過的也被作廢了。 */
  cancelled: '已收攤', revealed: '已開獎', closed: '已結束'
}

/* ---------- 格式化 ---------- */
export const fmtTime = (v: string | number | null | undefined) => {
  if (v === null || v === undefined) return '—'
  const n = typeof v === 'number' ? v : Number(v)
  const d = new Date(Number.isFinite(n) && n > 1e11 ? n : v as string)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
export const fmtPts = (n: number) => n.toLocaleString('zh-TW')
/** 收件地址攤成一行；缺欄位就跳過，不要留下「  ,  」這種空洞 */
export const fmtAddr = (a: Shipment['address']) =>
  [a.zip, a.city, a.line1].filter(Boolean).join(' ') || '（地址不完整）'

/* ---------- 共用的請求狀態 ----------
   每頁都要 loading / err / 送出中，重複寫五次不如給一個。 */
export function useAsync() {
  const loading = ref(false)
  const err = ref('')
  const okMsg = ref('')

  /** 包住一次請求：自動開關 loading、把 ApiError 的中文訊息接住。失敗回 null。 */
  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    loading.value = true; err.value = ''
    try { return await fn() }
    catch (e) { err.value = e instanceof ApiError ? e.message : '連線失敗'; return null }
    finally { loading.value = false }
  }
  /** 成功提示會自己消失 —— 後台操作很密集，訊息堆著會讓人分不清是哪一次的結果 */
  function flash(m: string) { okMsg.value = m; setTimeout(() => { if (okMsg.value === m) okMsg.value = '' }, 3000) }
  return { loading, err, okMsg, run, flash }
}

/**
 * 後台專用的 http。
 *
 * 展示模式（沒設 VITE_API_URL）下改回假資料 —— 後台原本每一支呼叫都直接
 * 走 http()，沒有後端的時候所有頁面都停在「載入中…」，等於這一整套介面
 * 在展示模式下是不存在的。
 *
 * 認不出來的路徑照常打真的後端，不要靜默回空物件 ——
 * 那會讓「忘了補假資料」看起來像「這個端點沒有資料」。
 */
export async function http<T>(path: string, init?: Parameters<typeof rawHttp>[1]): Promise<T> {
  if (MOCK) {
    const hit = mockAdmin(path)
    if (hit !== null) {
      await new Promise(r => setTimeout(r, 160))  // 讓載入狀態看得到
      return hit as T
    }
  }
  return rawHttp<T>(path, init)
}
