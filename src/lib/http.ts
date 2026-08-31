/**
 * HTTP 客戶端。帶 token、把後端的 { error, message } 變成可以直接顯示的錯誤。
 *
 * 後端的錯誤是字串碼（LISTING_TAKEN、SEATS_TAKEN…），不是 HTTP status ——
 * 同一個 409 可能是「卡被買走」也可能是「狀態不對」，前端要能分辨。
 * ApiError 把 code 跟 message 都帶著，頁面顯示 message、邏輯看 code。
 */
import { API_URL } from './config'
import { useWalletStore } from '@/stores/wallet'

const TOKEN_KEY = 'vd.token'
export const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public data?: unknown) {
    super(message)
  }
}

/* 後台那幾支（grant、users/:id、users/:id/wallet）回的 wallet 是
   **被查看的那個使用者**的錢包，不是客服自己的。套下去會把客服頭部的
   餘額換成別人的數字，而且他完全不會知道。 */
const FOREIGN_WALLET = /^\/v1\/admin\//

/**
 * 回應裡帶 wallet 就套用到錢包 store —— 伺服器是餘額的唯一真相。
 *
 * **這件事故意放在傳輸層，不放在每一支呼叫端。** 原本它是 api.ts 裡的一個
 * helper，由每支端點自己記得呼叫；漏掉的那幾支就變成「畫面說錢動了、
 * 餘額不動」（接受交易邀約那條最明顯：後端確實把新錢包回在 response 裡，
 * 前端整包丟掉）。逐處補只會修好這一輪已知的漏，下一支新端點照樣會漏 ——
 * 判準必須從「有沒有人記得呼叫」改成「後端有沒有回 wallet」，
 * 後者是後端契約的一部分，不是前端的紀律問題。
 *
 * 匯出而不是私有：之後若有不經過 http() 的來源（SSE 推播、WebSocket）也帶回
 * 錢包，那條路要走同一支，不要在別的地方再長出第二套套用邏輯。
 */
export function applyWallet(res: unknown, path = '') {
  if (FOREIGN_WALLET.test(path)) return
  const w = (res as { wallet?: { points: number; locked: number } } | null)?.wallet
  if (w && typeof w.points === 'number') useWalletStore().applyServer(w)
}

export async function http<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) }
  const t = token.get()
  if (t) headers.authorization = `Bearer ${t}`
  let body = init.body
  if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json) }

  /* 網路層失敗（斷網、DNS 不通、後端冷啟動）時 fetch 丟的是英文的
     TypeError: Failed to fetch —— 這句會一路穿到畫面上被當錯誤訊息顯示。
     在這裡統一換成中文，三個列表頁（大廳／市場／池）就共用同一句。
     文案刻意中性：Railway 後端冷啟動 ~20 秒是常態，這不是「系統壞了」。
     AbortError 原樣往外丟 —— 那是呼叫端自己取消的（例如無限捲動切分頁），
     不是網路壞了，包裝成錯誤訊息會把「正常取消」畫成「載入失敗」。 */
  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers, body })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError('NETWORK_ERROR', '連不上伺服器，請檢查網路後重試', 0, e)
  }
  const text = await res.text()
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { /* 非 JSON 回應 */ }

  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string }
    // 401 一律當作登入失效：清掉 token，讓 router guard 把人送回登入
    if (res.status === 401) token.clear()
    throw new ApiError(d.error ?? `HTTP_${res.status}`, d.message ?? `請求失敗（${res.status}）`, res.status, data)
  }
  /* 成功才套用。失敗的回應不帶 wallet，而且失敗代表那筆交易在後端整筆
     回滾了（見 server/src/db.ts 的 Rollback），這時去改餘額是憑空造數字。 */
  applyWallet(data, path)
  return data as T
}

/** 給每個會改狀態的請求一把唯一的 key，重送不會重複成立 */
export const idem = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
