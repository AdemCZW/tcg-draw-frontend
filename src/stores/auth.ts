import { defineStore } from 'pinia'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    // Mock：正式版接後端 session / JWT
    user: { id: 'u1', name: 'VD-3F2A', isAdult: true } as { id: string; name: string; isAdult: boolean } | null
  }),
  getters: {
    isLoggedIn: s => !!s.user
  }
})
