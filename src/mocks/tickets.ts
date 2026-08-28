/**
 * 客服工單的假資料層。
 *
 * 為什麼要有這一支：後端的 /v1/tickets 由另一支 agent 平行實作，還沒上線。
 * 但工單這個功能**不能只做得出靜態畫面** —— 它整條動線的價值在於
 * 「開單 → 出現在列表 → 進去看 → 回一則 → 訊息串多一則」，
 * 那條路走不通的話，介面做完也沒有人驗得了它。所以 mock 這一層要真的有狀態：
 * 開單會寫進去、回覆會推進狀態機，跟 server/migrations/024_tickets.sql
 * 那張表的行為對齊（見 docs/tickets-contract.md 第三節）。
 *
 * 狀態存 localStorage：重整之後剛開的單還在。沒有這一段的話，
 * 使用者（或驗收的人）一按重新整理就會以為單子不見了 —— 那是比沒有 mock 更糟的謊。
 */
import type {
  NewTicketInput, TicketDetail, TicketMessage, TicketStatus, TicketSummary
} from '@/lib/api'

const KEY = 'vd_tickets_v1'

/** 前 80 字。列表上要直接看得到進度，不必點進去（契約第二節 lastMessage） */
const cut = (s: string) => (s.length > 80 ? s.slice(0, 80) : s)

const D = 86_400_000
const now = Date.now()

/**
 * 種子資料刻意把**四種狀態與兩種自動開單**各放一張：
 * 徽章、結案理由、停用的回覆框、系統自動開的單，四件事都得看得到才調得準。
 */
function seed(): TicketDetail[] {
  return [
    {
      id: 't-2041', kind: 'takeover', status: 'pending-user',
      subject: '接管 PSA #82345671',
      createdAt: now - 2 * D, updatedAt: now - 5 * 3600_000,
      lastMessage: null, unread: true, messageCount: 2,
      userId: 'me', userName: '我',
      orderId: null, prizeId: null, sellerId: null,
      grader: 'PSA', certNo: '82345671',
      assigneeId: 'staff-1', assigneeName: '客服 小林',
      closedAt: null, resolution: null,
      messages: [
        {
          id: 1, authorId: 'me', authorName: '我', isStaff: false,
          body: '我在蝦皮向「卡途」買到這張 PSA 10 噴火龍 ex UR，實體卡已經在我手上，'
            + '但要開池的時候被擋下來說編號已經登記過了。附上購買紀錄與卡背照片，麻煩幫我轉到我名下。',
          fileIds: ['f-a1b2c3d4e5f6'], createdAt: now - 2 * D
        },
        {
          id: 2, authorId: 'staff-1', authorName: '客服 小林', isStaff: true,
          body: '收到。麻煩再補一張「卡背鑑定編號」與「你的手寫紙條（寫上今天日期與會員編號）」同框的照片，'
            + '我們要確認實體卡真的在你手上。補上之後我會直接處理過戶。',
          fileIds: [], createdAt: now - 5 * 3600_000
        }
      ]
    },
    {
      /* 自動開單的一種：買家申訴訂單之後系統補開（契約第五節）。
         使用者要能在同一個地方看到它 —— 申訴不該是一件「送出去就沒有下文」的事。 */
      id: 't-2040', kind: 'order-dispute', status: 'open',
      subject: '訂單爭議：噴火龍 ex UR',
      createdAt: now - 20 * 3600_000, updatedAt: now - 20 * 3600_000,
      lastMessage: null, unread: false, messageCount: 1,
      userId: 'me', userName: '我',
      orderId: 'o-8831', prizeId: null, sellerId: null, grader: null, certNo: null,
      assigneeId: null, assigneeName: null,
      closedAt: null, resolution: null,
      messages: [
        {
          id: 1, authorId: 'me', authorName: '我', isStaff: false,
          body: '收到的卡殼有裂痕，跟賣家出貨照上的狀態不一樣。開箱影片已附上，'
            + '從拆封到取出全程沒有中斷。',
          fileIds: ['f-0f1e2d3c4b5a'], createdAt: now - 20 * 3600_000
        }
      ]
    },
    {
      id: 't-2039', kind: 'card-issue', status: 'resolved',
      subject: '卡冊裡有一張卡的圖一直讀不出來',
      createdAt: now - 9 * D, updatedAt: now - 7 * D,
      lastMessage: null, unread: false, messageCount: 3,
      userId: 'me', userName: '我',
      orderId: null, prizeId: 'pz-77120', sellerId: null, grader: null, certNo: null,
      assigneeId: 'staff-2', assigneeName: '客服 阿哲',
      closedAt: now - 7 * D,
      resolution: '卡圖來源站台當時中斷，已改抓備援來源並回填這張卡的圖。'
        + '同一批受影響的卡都已修好，不需要你再做任何事。',
      messages: [
        {
          id: 1, authorId: 'me', authorName: '我', isStaff: false,
          body: '我的卡冊裡「幸福蛋 ex SAR」那張一直是灰的，其他張都正常。',
          fileIds: [], createdAt: now - 9 * D
        },
        {
          id: 2, authorId: 'staff-2', authorName: '客服 阿哲', isStaff: true,
          body: '看到了，是卡圖來源站台那邊的問題，我們正在改抓備援來源。你的卡本身沒有異常。',
          fileIds: [], createdAt: now - 8 * D
        },
        {
          id: 3, authorId: 'staff-2', authorName: '客服 阿哲', isStaff: true,
          body: '已經修好了，重新整理卡冊就看得到圖。造成不便很抱歉。',
          fileIds: [], createdAt: now - 7 * D
        }
      ]
    },
    {
      id: 't-2038', kind: 'seller-doc', status: 'rejected',
      subject: '賣家身分審核',
      createdAt: now - 26 * D, updatedAt: now - 24 * D,
      lastMessage: null, unread: false, messageCount: 2,
      userId: 'me', userName: '我',
      orderId: null, prizeId: null, sellerId: 's-me', grader: null, certNo: null,
      assigneeId: 'staff-1', assigneeName: '客服 小林',
      closedAt: now - 24 * D,
      resolution: '證件照片四角沒有入鏡、編號那一行反光看不清楚，無法核對。'
        + '請重新拍一次再送一次審核，這一張不影響你之後的申請。',
      messages: [
        {
          id: 1, authorId: 'me', authorName: '我', isStaff: false,
          body: '送出賣家身分審核文件。', fileIds: ['f-9988776655aa'], createdAt: now - 26 * D
        },
        {
          id: 2, authorId: 'staff-1', authorName: '客服 小林', isStaff: true,
          body: '文件收到了，但照片沒辦法核對，細節寫在結案理由裡。', fileIds: [], createdAt: now - 24 * D
        }
      ]
    }
  ]
}

let db: TicketDetail[] = load()

function load(): TicketDetail[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as TicketDetail[]
  } catch { /* 無痕模式或壞掉的舊資料：退回種子，不要讓整頁掛掉 */ }
  return seed()
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(db)) } catch { /* 無痕模式沒關係 */ }
}

/** 摘要是從明細算出來的，不是另外記一份 —— 兩份會分岔，而分岔的那一份一定是列表 */
function toSummary(t: TicketDetail): TicketSummary {
  const last = t.messages[t.messages.length - 1]
  return {
    id: t.id, kind: t.kind, status: t.status, subject: t.subject,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
    lastMessage: last ? cut(last.body) : null,
    unread: t.unread, messageCount: t.messages.length
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export function listTickets(status?: TicketStatus): TicketSummary[] {
  return db
    .filter(t => !status || t.status === status)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toSummary)
}

export function getTicket(id: string): TicketDetail | undefined {
  const t = db.find(x => x.id === id)
  if (!t) return undefined
  /* 讀過就不再是未讀。真的寫回去（而不是只在畫面上蓋掉）——
     否則列表上的紅點在返回之後又冒出來，看起來像沒讀到。 */
  if (t.unread) { t.unread = false; persist() }
  return clone(t)
}

let seq = 3000

export function createTicket(input: NewTicketInput): TicketDetail {
  const at = Date.now()
  const t: TicketDetail = {
    id: `t-${++seq}`,
    kind: input.kind,
    status: 'open',
    subject: input.subject,
    createdAt: at, updatedAt: at,
    lastMessage: cut(input.body), unread: false, messageCount: 1,
    userId: 'me', userName: '我',
    orderId: input.orderId ?? null,
    prizeId: input.prizeId ?? null,
    sellerId: null,
    grader: input.grader ?? null,
    certNo: input.certNo ?? null,
    assigneeId: null, assigneeName: null,
    closedAt: null, resolution: null,
    messages: [{
      id: 1, authorId: 'me', authorName: '我', isStaff: false,
      body: input.body, fileIds: input.fileIds ?? [], createdAt: at
    }]
  }
  db.unshift(t)
  persist()
  return clone(t)
}

/**
 * 回一則。已結案的單擋在這裡並丟出錯誤 —— 契約第三節說後端回 409，
 * mock 要有同一條規則，否則「已結案還能回」這個 bug 只會在接上後端那天才被發現。
 */
export function addMessage(id: string, body: string, fileIds: string[]): TicketMessage {
  const t = db.find(x => x.id === id)
  if (!t) throw new Error('找不到這張單')
  if (t.status === 'resolved' || t.status === 'rejected') {
    throw new Error('這張單已經結案，沒辦法再回覆。如果還有後續問題，請開一張新的單。')
  }
  const at = Date.now()
  const m: TicketMessage = {
    id: (t.messages[t.messages.length - 1]?.id ?? 0) + 1,
    authorId: 'me', authorName: '我', isStaff: false,
    body, fileIds, createdAt: at
  }
  t.messages.push(m)
  t.messageCount = t.messages.length
  t.lastMessage = cut(body)
  t.updatedAt = at
  /* 使用者回覆把球打回客服手上（契約第三節）。狀態機只有這一條由使用者端推動，
     其餘都在客服端 —— 所以這裡要是漏了，單子會永遠停在「等你回覆」。 */
  if (t.status === 'pending-user') t.status = 'open'
  persist()
  return clone(m)
}

/** 測試與展示用：把資料清回種子狀態 */
export function resetTickets() {
  db = seed()
  persist()
}

/* ------------------------------------------------------------------
   已經被登記走的鑑定編號（mock 專用）

   為什麼放在工單的 mock 裡：它存在的唯一理由是讓「建池撞到
   CERT_ALREADY_LISTED → 申請接管」這條入口在**沒有後端的時候也走得完**。
   正式環境這件事由 prizes 上的唯一索引 prizes_cert_alive 判定
   （server/src/routes/pools.ts 那段 23505 的處理），前端不做任何判斷。

   挑 82345675 是因為 mock 裡唯一帶得出鑑定編號的來源是使用者自己的卡冊，
   而這是卡冊中挑得到的其中一張（皮卡丘 ex SAR）。
------------------------------------------------------------------- */
export const MOCK_LISTED_CERTS = new Set(['82345675'])

/** 這批獎項裡有沒有撞到已登記的編號。有的話回那一張的編號與鑑定機構 */
export function listedCertHit(
  prizes: { card: { certNo?: string | null; grader?: string | null } }[]
): { certNo: string; grader: string } | null {
  for (const p of prizes) {
    const c = p.card.certNo
    if (c && MOCK_LISTED_CERTS.has(c)) return { certNo: c, grader: p.card.grader || 'PSA' }
  }
  return null
}
