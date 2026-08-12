import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import type { Seller } from '@/types/models'

export const useSellerStore = defineStore('sellers', {
  state: () => ({
    sellers: [] as Seller[],
    /** 目前登入者所扮演的賣家（mock：固定為關都卡舖） */
    meId: 's3'
  }),
  getters: {
    byId: s => (id: string) => s.sellers.find(x => x.id === id),
    me: (s): Seller | undefined => s.sellers.find(x => x.id === s.meId)
  },
  actions: {
    async ensureLoaded() {
      if (!this.sellers.length) this.sellers = await api.listSellers()
    }
  }
})
