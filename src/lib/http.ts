/**
 * HTTP 客戶端。帶 token、把後端的 { error, message } 變成可以直接顯示的錯誤。
 *
 * 後端的錯誤是字串碼（LISTING_TAKEN、SEATS_TAKEN…），不是 HTTP status ——
 * 同一個 409 可能是「卡被買走」也可能是「狀態不對」，前端要能分辨。
 * ApiError 把 code 跟 message 都帶著，頁面顯示 message、邏輯看 code。
 */
import { API_URL } from './config'

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
  return data as T
}

/** 給每個會改狀態的請求一把唯一的 key，重送不會重複成立 */
export const idem = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
