/**
 * 卡冊分享、交易邀約、站內通知的前端封裝。
 *
 * 不放進 api.ts 是因為那支已經很長，而且這三件事共用同一組型別
 * （通知會引用邀約、邀約會引用卡片），放在一起才看得出關聯。
 *
 * MOCK 模式（沒設 VITE_API_URL）走記憶體假資料 —— 前端要能在沒有後端的
 * 情況下開發與展示，這是這個專案一開始就定下的規則（見 lib/config.ts）。
 */
import { http } from './http'
import { MOCK } from './config'

/* ---------- 型別 ---------- */
export interface ShareSettings { public: boolean; slug: string | null }

export interface PublicCard {
  id: string
  card: { name?: string; artId?: string; grader?: string; grade?: number; certNo?: string; value?: number }
  tier: string
  /** 已上架的卡不能私下出價，要走市場 */
  tradable: boolean
}
export interface PublicCardbook {
  owner: { name: string; handle: string }
  prizes: PublicCard[]
}

export type OfferStatus = 'pending' | 'accepted' | 'declined' | 'cancelled'
export interface TradeOffer {
  id: string
  prize_id: string
  from_user: string
  to_user: string
  points: number
  message: string
  status: OfferStatus
  created_at: string | number
  responded_at: string | number | null
  card: { name?: string; artId?: string }
  /** 收件匣有 from_name、寄件匣有 to_name */
  from_name?: string
  to_name?: string
}

export type NotifyKind =
  | 'draw' | 'trade-offer' | 'trade-result' | 'listing-sold'
  | 'order' | 'shipment' | 'system'
export interface Notification {
  id: number
  kind: NotifyKind
  title: string
  body: string
  /** 前端路由字串，可能是 null（沒有現場可跳） */
  link: string | null
  ref_id: string | null
  read_at: string | null
  created_at: string | number
}

/* ---------- MOCK 資料 ----------
   刻意做成有讀有未讀、有各種 kind，這樣鈴鐺的紅點、已讀樣式、
   分類圖示在沒有後端的情況下也看得出對不對。 */
const now = Date.now()
const mockNotifications: Notification[] = [
  { id: 5, kind: 'trade-offer', title: '有人想要你的卡', body: '小明 出 12,000 點想換「噴火龍 ex UR」', link: '/me/offers', ref_id: 'to-1', read_at: null, created_at: now - 4 * 60_000 },
  { id: 4, kind: 'draw', title: '抽到最後賞', body: '噴火龍 ex UR 已經進到你的卡冊。', link: '/me/cards', ref_id: 'd-1', read_at: null, created_at: now - 40 * 60_000 },
  { id: 3, kind: 'listing-sold', title: '你的卡賣出了', body: '「月亮伊布 ex SAR」以 4,200 點成交，點數已入帳。', link: '/me/wallet', ref_id: 'l-1', read_at: null, created_at: now - 5 * 3600_000 },
  { id: 2, kind: 'shipment', title: '你的卡已經寄出', body: '物流單號 SMOKE12345678', link: '/me/cards', ref_id: 'sh-1', read_at: new Date(now - 26 * 3600_000).toISOString(), created_at: now - 28 * 3600_000 },
  { id: 1, kind: 'system', title: '測試點數已入帳', body: 'LINE 登入送 1,000,000 點，可以直接開始抽卡。', link: '/me/wallet', ref_id: 'u-1', read_at: new Date(now - 70 * 3600_000).toISOString(), created_at: now - 72 * 3600_000 }
]
let mockShare: ShareSettings = { public: false, slug: null }

/* 收發匣的假資料。要有「待回覆」「已成交」「被婉拒」「自己收回」四種，
   否則 mock 模式下只看得到空狀態，版面與狀態樣式都驗不到。 */
const mockIncoming: TradeOffer[] = [
  { id: 'to-1', prize_id: 'pz-1', from_user: 'u-a', to_user: 'u-me', points: 12_000, message: '想收這張很久了，可以割愛嗎', status: 'pending', created_at: now - 6 * 60_000, responded_at: null, card: { name: '噴火龍 ex UR', artId: 'SV4a-349' }, from_name: '小明' },
  { id: 'to-2', prize_id: 'pz-2', from_user: 'u-b', to_user: 'u-me', points: 3_500, message: '', status: 'pending', created_at: now - 3 * 3600_000, responded_at: null, card: { name: '奇樹 SAR', artId: 'SV4a-350' }, from_name: '阿凱' },
  { id: 'to-3', prize_id: 'pz-3', from_user: 'u-c', to_user: 'u-me', points: 900, message: '這個價可以嗎', status: 'declined', created_at: now - 2 * 86400_000, responded_at: now - 2 * 86400_000 + 3600_000, card: { name: '月亮伊布 ex SAR', artId: 'SV8a-217' }, from_name: '收藏家 J' }
]
const mockOutgoing: TradeOffer[] = [
  { id: 'to-4', prize_id: 'pz-9', from_user: 'u-me', to_user: 'u-d', points: 8_800, message: '誠心收購', status: 'pending', created_at: now - 40 * 60_000, responded_at: null, card: { name: '太樂巴戈斯 ex UR', artId: 'SV8a-237' }, to_name: '保庫堂' },
  { id: 'to-5', prize_id: 'pz-10', from_user: 'u-me', to_user: 'u-e', points: 26_000, message: '', status: 'accepted', created_at: now - 5 * 86400_000, responded_at: now - 5 * 86400_000 + 7200_000, card: { name: '謎擬Ｑ SAR', artId: 'SV4a-341' }, to_name: '滿分場' },
  { id: 'to-6', prize_id: 'pz-11', from_user: 'u-me', to_user: 'u-f', points: 450, message: '出價後又找到更好的，先收回', status: 'cancelled', created_at: now - 9 * 86400_000, responded_at: now - 9 * 86400_000 + 600_000, card: { name: '沙包蟒 SR', artId: 'SV4a-345' }, to_name: '促販工房' }
]

const delay = (ms = 180) => new Promise(r => setTimeout(r, ms))

/* ---------- 卡冊分享 ---------- */
export const share = {
  async get(): Promise<ShareSettings> {
    if (MOCK) { await delay(); return { ...mockShare } }
    return http<ShareSettings>('/v1/social/cardbook/settings')
  },
  async set(isPublic: boolean, rotate = false): Promise<ShareSettings> {
    if (MOCK) {
      await delay()
      const slug = rotate || !mockShare.slug ? Math.random().toString(36).slice(2, 12) : mockShare.slug
      mockShare = { public: isPublic, slug }
      return { ...mockShare }
    }
    return http<ShareSettings>('/v1/social/cardbook/settings', {
      method: 'PUT', json: { public: isPublic, rotate }
    })
  },
  /** 公開卡冊。不需要登入 —— 分享連結要能給沒帳號的人看 */
  async view(slug: string): Promise<PublicCardbook> {
    if (MOCK) {
      await delay()
      return {
        owner: { name: '示範收藏家', handle: 'VD-DEMO' },
        prizes: [
          { id: 'pz-1', card: { name: '噴火龍 ex UR', artId: 'SV4a-349', grader: 'PSA', grade: 10, value: 43680 }, tier: 'LAST', tradable: true },
          { id: 'pz-2', card: { name: '奇樹 SAR', artId: 'SV4a-350', grader: 'PSA', grade: 10, value: 26320 }, tier: 'A', tradable: true },
          { id: 'pz-3', card: { name: '月亮伊布 ex SAR', artId: 'SV8a-217', grader: 'BGS', grade: 9.5, value: 4200 }, tier: 'C', tradable: false }
        ]
      }
    }
    return http<PublicCardbook>(`/v1/share/cardbook/${encodeURIComponent(slug)}`)
  }
}

/** 分享用的完整網址。BASE_URL 是 GitHub Pages 的 /tcg-draw-frontend/ 前綴，
    少了它貼出去的連結會 404 */
export const shareUrl = (slug: string) =>
  `${location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}/u/${slug}`

/* ---------- 交易邀約 ---------- */
export const offers = {
  async list(): Promise<{ incoming: TradeOffer[]; outgoing: TradeOffer[] }> {
    if (MOCK) { await delay(); return { incoming: mockIncoming, outgoing: mockOutgoing } }
    return http('/v1/social/trade-offers')
  },
  async create(prizeId: string, points: number, message = ''): Promise<{ offerId: string }> {
    if (MOCK) { await delay(); return { offerId: 'to-mock' } }
    return http('/v1/social/trade-offers', { method: 'POST', json: { prizeId, points, message } })
  },
  async accept(id: string) {
    if (MOCK) {
      await delay()
      const o = mockIncoming.find(x => x.id === id)
      if (o) { o.status = 'accepted'; o.responded_at = Date.now() }
      return { ok: true }
    }
    return http(`/v1/social/trade-offers/${id}/accept`, { method: 'POST', json: {} })
  },
  /** 收到的人按是婉拒、送出的人按是收回，後端用身分判斷 */
  async decline(id: string) {
    if (MOCK) {
      await delay()
      const inc = mockIncoming.find(x => x.id === id)
      if (inc) { inc.status = 'declined'; inc.responded_at = Date.now() }
      const out = mockOutgoing.find(x => x.id === id)
      if (out) { out.status = 'cancelled'; out.responded_at = Date.now() }
      return { ok: true }
    }
    return http(`/v1/social/trade-offers/${id}/decline`, { method: 'POST', json: {} })
  }
}

/* ---------- 通知 ---------- */
export const notifications = {
  async list(): Promise<{ notifications: Notification[]; unread: number }> {
    if (MOCK) {
      await delay()
      return { notifications: mockNotifications, unread: mockNotifications.filter(n => !n.read_at).length }
    }
    return http('/v1/social/notifications')
  },
  /** 不給 ids 就是全部已讀 —— 打開鈴鐺就清紅點是最常見的操作 */
  async markRead(ids?: number[]) {
    if (MOCK) {
      await delay(80)
      const stamp = new Date().toISOString()
      for (const n of mockNotifications) {
        if (!n.read_at && (!ids || ids.includes(n.id))) n.read_at = stamp
      }
      return { ok: true }
    }
    return http('/v1/social/notifications/read', { method: 'POST', json: ids ? { ids } : {} })
  }
}
