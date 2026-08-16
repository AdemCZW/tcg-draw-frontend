import { defineStore } from 'pinia'

/**
 * 登入狀態。Mock：正式版接後端 session / JWT。
 *
 * 之前是「永遠登入的 VD-3F2A」—— 那樣形象頁上的登入／註冊按鈕沒有意義。
 * 現在有真的登出狀態，記在 localStorage（重整不會掉），登入／註冊都是
 * 即時成功的 mock。後端接上後只要換掉這三個 action 的實作。
 */
export interface User { id: string; name: string; isAdult: boolean }

const KEY = 'vd.user'
function load(): User | null {
  try { const raw = localStorage.getItem(KEY); return raw ? (JSON.parse(raw) as User) : null }
  catch { return null }
}
function save(u: User | null) {
  try { u ? localStorage.setItem(KEY, JSON.stringify(u)) : localStorage.removeItem(KEY) }
  catch { /* 無痕模式沒關係 */ }
}
/** 給 mock 用的會員代號：VD- 加四碼 hex */
function mockId() {
  const h = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0')
  return { id: 'u-' + h, name: 'VD-' + h }
}

export const useAuthStore = defineStore('auth', {
  state: () => ({ user: load() as User | null }),
  getters: { isLoggedIn: s => !!s.user },
  actions: {
    async login(_email: string, _password: string) {
      // mock：任何帳密都通過。正式版：POST /auth/login
      await new Promise(r => setTimeout(r, 380))
      this.user = { ...mockId(), isAdult: true }
      save(this.user)
      return this.user
    },
    async register(_email: string, _password: string) {
      await new Promise(r => setTimeout(r, 480))
      this.user = { ...mockId(), isAdult: true }
      save(this.user)
      return this.user
    },
    logout() {
      this.user = null
      save(null)
    }
  }
})
