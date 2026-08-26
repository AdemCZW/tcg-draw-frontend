import { defineStore } from 'pinia'
import { MOCK, API_URL } from '@/lib/config'
import { http, token } from '@/lib/http'

/**
 * 登入狀態。
 *
 * mock：任何帳密都通過，記在 localStorage。
 * API：Email/密碼打後端，或 LINE Login（整頁導向後端 /auth/line/start，
 *      回來時網址帶 #token=…，由 consumeToken() 收下）。
 *
 * token 存 localStorage、user 也存一份 —— 重整不用等 /me 就能先畫出已登入的畫面，
 * 但 /me 回來後以伺服器為準。
 */
export interface User { id: string; name: string; handle?: string; email?: string | null; role?: string; isAdult: boolean }

const KEY = 'vd.user'
function load(): User | null {
  try { const raw = localStorage.getItem(KEY); return raw ? (JSON.parse(raw) as User) : null }
  catch { return null }
}
function save(u: User | null) {
  try { u ? localStorage.setItem(KEY, JSON.stringify(u)) : localStorage.removeItem(KEY) }
  catch { /* 無痕模式沒關係 */ }
}
function mockId() {
  const h = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0')
  return { id: 'u-' + h, name: 'VD-' + h }
}

export const useAuthStore = defineStore('auth', {
  state: () => ({ user: load() as User | null }),
  getters: {
    isLoggedIn: s => !!s.user,
    isAdmin: s => s.user?.role === 'admin'
  },
  actions: {
    /** 從 /me 拿最新的使用者資料 */
    async refresh() {
      if (MOCK || !token.get()) return this.user
      try {
        const r = await http<{ user: { id: string; handle: string; name: string; email: string | null; role: string } }>('/v1/auth/me')
        this.user = { id: r.user.id, name: r.user.name, handle: r.user.handle, email: r.user.email, role: r.user.role, isAdult: true }
        save(this.user)
      } catch (e) {
        /* 只有「真的登入失效」才清掉登入狀態，網路失敗不清。
           判準是 token 還在不在：http() 收到 401 時會 token.clear()，
           所以 token 沒了＝這次是憑證問題。而 Railway 冷啟動那幾秒
           /v1/auth/me 會逾時或連不上，那時 token 仍在 —— 一律清 user 的話，
           使用者每次後端冷啟動都會被踢回登入頁，症狀還像帳號出問題，最傷信任。
           連不上就保留上一次記住的登入狀態，等後端醒來下一個請求自然恢復。 */
        if (!token.get()) { this.user = null; save(null) }
        else console.warn('[auth] /me 暫時連不上，保留登入狀態', e instanceof Error ? e.message : e)
      }
      return this.user
    },

    async login(email: string, password: string) {
      if (MOCK) {
        await new Promise(r => setTimeout(r, 380))
        this.user = { ...mockId(), isAdult: true }; save(this.user)
        return this.user
      }
      const r = await http<{ token: string }>('/v1/auth/login', { method: 'POST', json: { email, password } })
      token.set(r.token)
      return this.refresh()
    },

    async register(email: string, password: string, name = '') {
      if (MOCK) {
        await new Promise(r => setTimeout(r, 480))
        this.user = { ...mockId(), isAdult: true }; save(this.user)
        return this.user
      }
      const r = await http<{ token: string }>('/v1/auth/register',
        { method: 'POST', json: { email, password, name: name || email.split('@')[0] } })
      token.set(r.token)
      return this.refresh()
    },

    /** LINE：整頁導去後端，後端處理完導回 /login#token=… */
    loginWithLine() {
      window.location.href = `${API_URL}/v1/auth/line/start`
    },

    /** 從網址 fragment 收下 token（LINE 回來時）。收完把 fragment 清掉，token 不要留在網址列 */
    async consumeToken(): Promise<boolean> {
      const m = /[#&]token=([^&]+)/.exec(window.location.hash)
      if (!m) return false
      token.set(decodeURIComponent(m[1]!))
      history.replaceState(null, '', window.location.pathname + window.location.search)
      await this.refresh()
      return !!this.user
    },

    logout() {
      this.user = null
      save(null)
      token.clear()
    }
  }
})
