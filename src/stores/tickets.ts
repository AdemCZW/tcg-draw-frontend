/**
 * 客服工單（使用者端）的狀態。
 *
 * 為什麼要一個 store 而不是每頁各自 fetch：列表與詳情是同一份資料的兩個視角，
 * 而它們之間**會互相改寫**——在詳情頁回一則，列表那一列的「最後一則訊息」、
 * 時間、狀態全部要跟著變。各自 fetch 的話，回完覆按上一頁看到的是舊的一列，
 * 使用者會以為訊息沒送出去。所以回覆成功之後在這裡就地把摘要補好，
 * 不必等下一次重新載入。
 *
 * 錯誤刻意分成 listErr / detailErr 兩支：兩個畫面各自要能說出自己壞了。
 * 共用一支的話，詳情頁的失敗會讓返回後的列表也頂著一句紅字。
 */
import { defineStore } from 'pinia'
import { ticketsApi, type NewTicketInput, type TicketDetail, type TicketSummary } from '@/lib/api'
import { ApiError } from '@/lib/http'
/* 客服端（/admin/tickets）用的東西。跟上面那一行分開寫是刻意的：
   這個檔案同時有兩支 agent 在動，各自的 import 各佔一行才不會互相蓋掉。 */
import {
  api,
  type AdminTicketDetail, type AdminTicketRow, type TicketKind, type TicketStatus
} from '@/lib/api'

/** 錯誤一律翻成一句人話。ApiError 的 message 已經是後端寫給人看的，直接用 */
const say = (e: unknown, fallback: string) =>
  e instanceof ApiError ? e.message : e instanceof Error && e.message ? e.message : fallback

/* ==================================================================
   客服工單：顯示文案與小工具（客服端 /admin/tickets 用）

   為什麼放在 store 檔而不是各自的元件裡：同一個 kind 會出現在佇列、詳情、
   結案對話框三個地方，散開就會慢慢長歪 —— 後台既有的 console/shared.ts
   收 SHIP_LABEL 也是同一個理由。
================================================================== */

export const TICKET_KIND_LABEL: Record<TicketKind, string> = {
  takeover: '接管申請',
  'order-dispute': '訂單爭議',
  'seller-doc': '賣家審核',
  'card-issue': '卡片問題',
  account: '帳號問題',
  other: '其他'
}

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: '待處理',
  'pending-user': '等使用者回覆',
  resolved: '已結案',
  rejected: '已駁回'
}

/** 徽章配色（對到 console.css 的 c-pill 變體）。
    「等使用者回覆」不是壞事，用中性的藍；「待處理」才是要人動手的黃 */
export const TICKET_STATUS_TONE: Record<TicketStatus, string> = {
  open: 'wait',
  'pending-user': 'go',
  resolved: 'done',
  rejected: 'bad'
}

/** 已結案的兩種。判斷「還要不要處理」只看這裡，不要在各頁各寫一次條件 */
export const isTicketClosed = (s: TicketStatus) => s === 'resolved' || s === 'rejected'

/**
 * 「等多久了」。
 *
 * 客服在佇列上最需要的一欄就是這個，所以刻意不顯示開單時間戳 ——
 * 「08/24 14:32」要人在腦中減一次才知道等了多久，而那正是排序的依據。
 * 未滿一小時給分鐘、未滿一天給小時、之後給「天 + 小時」：只給天數的話，
 * 「等 3 天」與「等 3 天 23 小時」看起來一樣急，實際上差快一天。
 */
export function fmtWait(since: number): string {
  const ms = Math.max(0, Date.now() - since)
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '剛剛'
  if (min < 60) return `${min} 分鐘`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小時`
  const day = Math.floor(hr / 24)
  const rest = hr % 24
  return rest ? `${day} 天 ${rest} 小時` : `${day} 天`
}

/** 超過兩天還沒結案的要在畫面上跳出來 —— 跟其他列長得一樣就不會有人注意到它 */
const STALE_MS = 48 * 3600_000
export const isTicketStale = (t: { createdAt: number; status: TicketStatus }) =>
  !isTicketClosed(t.status) && Date.now() - t.createdAt > STALE_MS

export const useTicketsStore = defineStore('tickets', {
  state: () => ({
    items: [] as TicketSummary[],
    nextCursor: null as string | null,
    /** 載過一次沒有？沒載過的空陣列跟「真的一張都沒有」是兩件事，空狀態不能共用 */
    listLoaded: false,
    listLoading: false,
    listErr: '',

    detail: null as TicketDetail | null,
    detailLoading: false,
    detailErr: '',

    /* ---- 客服端（/admin/tickets）----
       欄位一律 admin 前綴，跟上面使用者端的 items / detail 完全分開。
       同一張單在兩個視角看到的東西本來就不同（最明顯的是 certHolder：
       客服看得到目前登記人，申請人看不到），共用一份狀態遲早會把
       客服視角的資料洩到使用者的畫面上。 */
    adminRows: [] as AdminTicketRow[],
    /** pending = 只看還在等的（預設）；all = 連結案的一起看 */
    adminScope: 'pending' as 'pending' | 'all',
    adminListLoading: false,
    adminListErr: '',
    /** 待處理張數。後台側欄的待辦數字用它，不必先點進佇列才知道有幾張 */
    adminPendingCount: 0,

    adminDetail: null as AdminTicketDetail | null,
    adminDetailLoading: false,
    adminDetailErr: '',
    /** 認領／回覆／結案共用一個「進行中」旗標：三個動作不可能同時進行 */
    adminActing: false,
    adminActErr: ''
  }),

  getters: {
    /** 未讀的張數。之後要在導覽掛紅點就靠這個 */
    unreadCount: s => s.items.filter(t => t.unread).length,

    /** 佇列裡還沒有人認領的張數。有人認領的單至少「有人知道」了，沒認領的才是真的沒人管 */
    adminUnclaimed: s => s.adminRows.filter(r => !r.assigneeId).length
  },

  actions: {
    /**
     * 載入我的單。
     * force 用在「開完單跳回列表」這種一定要重新拿的時候；
     * 平常重進頁面沿用已載入的資料，不要每次切頁都閃一次載入中。
     */
    async loadList(force = false) {
      if (this.listLoading) return
      if (this.listLoaded && !force) return
      this.listLoading = true
      this.listErr = ''
      try {
        const r = await ticketsApi.list({ limit: 20 })
        this.items = r.items
        this.nextCursor = r.nextCursor
        this.listLoaded = true
      } catch (e) {
        /* 失敗時**不要**把 items 清空。清空的話畫面會從「有五張單」變成
           空狀態那句「你還沒問過任何問題」—— 那是在斷網的時候說謊。 */
        this.listErr = say(e, '讀不到你的問題清單，請稍後再試')
      } finally {
        this.listLoading = false
      }
    },

    /** 下一頁。沒有游標就什麼都不做 */
    async loadMore() {
      if (!this.nextCursor || this.listLoading) return
      this.listLoading = true
      this.listErr = ''
      try {
        const r = await ticketsApi.list({ limit: 20, cursor: this.nextCursor })
        this.items = [...this.items, ...r.items]
        this.nextCursor = r.nextCursor
      } catch (e) {
        this.listErr = say(e, '載入更多失敗，請稍後再試')
      } finally {
        this.listLoading = false
      }
    },

    /** 打開一張單。切換單號時先把舊的清掉，否則會看到上一張的訊息串一閃 */
    async open(id: string) {
      if (this.detail?.id !== id) this.detail = null
      this.detailLoading = true
      this.detailErr = ''
      try {
        this.detail = await ticketsApi.get(id)
        // 讀過了，列表那一列的未讀點要跟著滅掉
        const row = this.items.find(t => t.id === id)
        if (row) row.unread = false
      } catch (e) {
        this.detailErr = say(e, '讀不到這張單，請稍後再試')
      } finally {
        this.detailLoading = false
      }
    },

    /**
     * 開一張新單。成功之後同時放進列表最上面與 detail ——
     * 呼叫端可以直接跳去詳情頁，不必再打一次 GET。
     */
    async create(input: NewTicketInput): Promise<TicketDetail> {
      const t = await ticketsApi.create(input)
      this.items = [summaryOf(t), ...this.items.filter(x => x.id !== t.id)]
      this.listLoaded = true
      this.detail = t
      return t
    },

    /**
     * 回一則。成功之後就地把訊息接到串上並把摘要補好。
     * 不重新拉整張單是刻意的：重拉會讓剛送出的那一則「消失一下再出現」，
     * 在手機的慢網路上那一秒看起來就像送失敗了。
     */
    async reply(id: string, body: string, fileIds: string[] = []) {
      const m = await ticketsApi.reply(id, body, fileIds)
      const t = this.detail
      if (t && t.id === id) {
        t.messages = [...t.messages, m]
        t.messageCount = t.messages.length
        t.lastMessage = m.body.slice(0, 80)
        t.updatedAt = m.createdAt
        // 使用者回覆＝球回到客服手上。後端也這樣做，兩邊要一致（契約第三節）
        if (t.status === 'pending-user') t.status = 'open'
      }
      const row = this.items.find(x => x.id === id)
      if (row) {
        row.lastMessage = m.body.slice(0, 80)
        row.updatedAt = m.createdAt
        row.messageCount += 1
        if (row.status === 'pending-user') row.status = 'open'
        /* 列表是照 updatedAt 由新到舊排的。回完覆這一列要浮到最上面 ——
           不重排的話使用者回到列表會在原本的位置找不到剛回過的那一張。 */
        this.items = [...this.items].sort((a, b) => b.updatedAt - a.updatedAt)
      }
      return m
    },

    /* ================================================================
       客服端（/admin/tickets）。以下都只在後台頁用得到。
       ================================================================ */

    /** 佇列。載入的同時順手把待辦數字算好，不要為了數數字再打一次 API */
    async adminLoadQueue() {
      this.adminListLoading = true
      this.adminListErr = ''
      try {
        this.adminRows = await api.adminTickets(this.adminScope)
        this.adminPendingCount = this.adminScope === 'pending'
          ? this.adminRows.length
          : this.adminRows.filter(r => !isTicketClosed(r.status)).length
      } catch (e) {
        /* 跟使用者端同一個理由：失敗**不清空** adminRows。
           清空的話畫面會從「有六張單」變成空狀態那句「目前沒有待處理的工單」——
           那是在斷網的時候說謊，而客服看到那句話就真的不會去處理了。 */
        this.adminListErr = say(e, '讀不到工單佇列，請稍後再試')
      } finally {
        this.adminListLoading = false
      }
    },

    adminSetScope(scope: 'pending' | 'all') {
      if (this.adminScope === scope) return
      this.adminScope = scope
      return this.adminLoadQueue()
    },

    /** 只更新側欄的數字。失敗就維持上一個值 —— 輔助資訊不值得為它跳一句紅字 */
    async adminRefreshCount() {
      try {
        this.adminPendingCount = (await api.adminTickets('pending')).length
      } catch { /* 靜默：這不是這一頁的主體 */ }
    },

    async adminLoadDetail(id: string) {
      /* 切換單號時先把舊的清掉。不清的話換單那一瞬間會先畫出上一張的訊息串，
         客服可能就對著別人的單按下認領或結案了。 */
      if (this.adminDetail?.id !== id) this.adminDetail = null
      this.adminDetailLoading = true
      this.adminDetailErr = ''
      this.adminActErr = ''
      try {
        this.adminDetail = await api.adminTicket(id)
      } catch (e) {
        this.adminDetailErr = say(e, '讀不到這張工單，請稍後再試')
      } finally {
        this.adminDetailLoading = false
      }
    },

    /** 三個寫入動作共用的外殼：統一開關 adminActing、接住錯誤、把回來的單套回畫面 */
    async adminAct(fn: () => Promise<AdminTicketDetail>): Promise<boolean> {
      this.adminActing = true
      this.adminActErr = ''
      try {
        this.adminDetail = await fn()
        return true
      } catch (e) {
        this.adminActErr = say(e, '操作失敗，請重試')
        return false
      } finally {
        this.adminActing = false
      }
    },

    adminClaim(id: string) { return this.adminAct(() => api.claimTicket(id)) },

    adminReply(id: string, body: string, fileIds: string[] = []) {
      return this.adminAct(() => api.replyTicket(id, body, fileIds))
    },

    /**
     * 結案。
     *
     * `disputeTo` 只有「訂單爭議 + 通過結案」才帶得動，因為那一條會讓後端去呼叫
     * 既有的爭議裁決邏輯、**點數會真的移動**（契約第四節）。這個判斷放在 store
     * 而不是元件裡：之後別的頁也要結案時，「什麼時候該帶 disputeTo」只有一個地方會錯。
     */
    adminResolve(
      id: string,
      input: { outcome: 'resolved' | 'rejected'; resolution: string; disputeTo?: 'buyer' | 'seller' }
    ) {
      const moveMoney = this.adminDetail?.kind === 'order-dispute' && input.outcome === 'resolved'
      return this.adminAct(() => api.resolveTicket(id, {
        outcome: input.outcome,
        resolution: input.resolution,
        disputeTo: moveMoney ? input.disputeTo : undefined
      }))
    }
  }
})

/** 明細 → 摘要。列表那一列要看的東西全部推得出來，不必另外跟後端要一次 */
function summaryOf(t: TicketDetail): TicketSummary {
  const last = t.messages[t.messages.length - 1]
  return {
    id: t.id, kind: t.kind, status: t.status, subject: t.subject,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
    lastMessage: last ? last.body.slice(0, 80) : null,
    unread: t.unread, messageCount: t.messages.length
  }
}
