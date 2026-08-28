/**
 * 客服工單的展示資料 —— **客服端視角**。
 *
 * 為什麼跟 mocks/tickets.ts 分開一支：那一支是使用者視角（「我的問題」），
 * 裡面每一張單的開單人都是「我」、沒有認領人、而且照契約第三節**不帶 certHolder**
 * （那是別人的身分，不該讓申請人看到）。客服佇列要的東西剛好是那些缺的欄位：
 * 不同的開單人、有沒有人認領、以及接管單目前登記在誰名下。
 * 硬把兩個視角塞進同一份資料，結果會是其中一邊永遠有一半欄位是空的。
 *
 * 這份資料會**真的被改動**（認領／回覆／結案），因為客服端要驗的是一條動線：
 * 「認領 → 回覆 → 結案 → 從待處理佇列消失」。回常數的話按下去畫面毫無變化，
 * 這條動線在沒有後端的機器上就永遠沒有人看過它對不對。
 *
 * 待處理的那幾張「等的時間」刻意拉得很開（40 分鐘到 6 天）——
 * 佇列上最重要的一欄是「等多久了」，全部都是同一天開的假資料看不出那一欄在做什麼。
 */
import type { AdminTicketDetail, AdminTicketRow, TicketMessage, TicketStatus } from '@/lib/api'

const now = Date.now()
/** h 小時前。工單的等待時間是以小時在看的，用天當單位會失真 */
const ago = (h: number) => now - h * 3600_000

/** 客服自己的身分。認領時要把名字寫進 assigneeName，畫面上要看得到是誰接的 */
export const MOCK_ADMIN = { id: 'u-platform', name: 'VaultDraw 客服' }

let seq = 900

/** 開單人的會員編號。客服查人是靠編號不是靠名字（同名的人會有好幾個） */
const MEMBER_NO: Record<string, string> = {
  'u-a1': 'VD-A3K7Q2',
  'u-a2': 'VD-M9X2P7',
  'u-a3': 'VD-T4B8N1',
  'u-s2': 'VD-S2'
}

const msg = (
  authorId: string, authorName: string, isStaff: boolean, body: string, createdAt: number, fileIds: string[] = []
): TicketMessage => ({ id: ++seq, authorId, authorName, isStaff, body, fileIds, createdAt })

const tickets: AdminTicketDetail[] = [
  {
    id: 't-1041',
    kind: 'takeover',
    status: 'open',
    subject: '接管 PSA #82345673',
    createdAt: ago(143),
    updatedAt: ago(37),
    lastMessage: null,
    unread: true,
    messageCount: 2,
    userId: 'u-a1',
    userName: '小明',
    orderId: null,
    prizeId: null,
    sellerId: null,
    grader: 'PSA',
    certNo: '82345673',
    assigneeId: null,
    assigneeName: null,
    closedAt: null,
    resolution: null,
    /* 接管單的關鍵資訊：這個編號現在登記在誰名下。沒有這一條，客服無從判斷
       「申請人說的站外轉手」到底是真的易主，還是想把別人的卡搬走。 */
    certHolder: { userId: 'u-s2', userName: '促販工房', memberNo: 'VD-S2' },
    messages: [
      msg('u-a1', '小明', false,
        '我在蝦皮向「促販工房」買下這張太樂巴戈斯 ex UR，賣家說他之前有登記在站上。附上聊天紀錄與匯款截圖，麻煩協助把編號轉到我名下。',
        ago(143), ['f-4b81c0a93e77', 'f-9d2f5c1a8b60']),
      msg('u-a1', '小明', false, '補上卡背鑑定標籤的照片，編號看得比較清楚。', ago(37), ['f-1a7e33c50fd2'])
    ]
  },
  {
    id: 't-1038',
    kind: 'order-dispute',
    status: 'open',
    subject: '訂單爭議：太樂巴戈斯 ex UR',
    createdAt: ago(96),
    updatedAt: ago(90),
    lastMessage: null,
    unread: true,
    messageCount: 2,
    userId: 'u-a1',
    userName: '小明',
    orderId: 'o-91',
    prizeId: null,
    sellerId: 'u-s2',
    grader: null,
    certNo: null,
    assigneeId: null,
    assigneeName: null,
    closedAt: null,
    resolution: null,
    certHolder: null,
    messages: [
      msg('u-a1', '小明', false,
        '收到的卡殼有明顯裂痕，跟賣場照片不一樣。開箱影片從拆封到取出全程沒有中斷，請看附件。',
        ago(96), ['f-77aa19b4c032']),
      msg('u-s2', '促販工房', false,
        '出貨前有拍照，寄出時外殼是完整的。這應該是運送途中造成的，我這邊也附上出貨照。',
        ago(90), ['f-2c40be7f1d95'])
    ]
  },
  {
    id: 't-1035',
    kind: 'card-issue',
    status: 'open',
    subject: '抽到的卡狀態與圖片不符',
    createdAt: ago(52),
    updatedAt: ago(52),
    lastMessage: null,
    unread: true,
    messageCount: 1,
    userId: 'u-a3',
    userName: '收藏家 J',
    orderId: null,
    prizeId: 'pz-4',
    sellerId: null,
    grader: null,
    certNo: null,
    assigneeId: null,
    assigneeName: null,
    closedAt: null,
    resolution: null,
    certHolder: null,
    messages: [
      msg('u-a3', '收藏家 J', false,
        '池子頁面寫 PSA 10，但我卡冊裡這張顯示的是 PSA 9。想確認是不是登錄錯了。', ago(52))
    ]
  },
  {
    id: 't-1030',
    kind: 'seller-doc',
    status: 'pending-user',
    subject: '賣家審核：關都卡舖',
    createdAt: ago(26),
    updatedAt: ago(20),
    lastMessage: null,
    unread: false,
    messageCount: 2,
    userId: 'u-a2',
    userName: '阿凱',
    orderId: null,
    prizeId: null,
    sellerId: 'u-a2',
    grader: null,
    certNo: null,
    assigneeId: 'u-platform',
    assigneeName: 'VaultDraw 客服',
    closedAt: null,
    resolution: null,
    certHolder: null,
    messages: [
      msg('u-a2', '阿凱', false, '送審文件如附件，統編與負責人資料都在上面。', ago(26), ['f-6e1b90d4a27c']),
      msg('u-platform', 'VaultDraw 客服', true,
        '文件收到了。負責人身分證影本的邊角被裁掉，看不到完整的證號，麻煩重拍一張完整的。', ago(20))
    ]
  },
  {
    id: 't-1028',
    kind: 'account',
    status: 'pending-user',
    subject: '手機換號碼，登入收不到驗證',
    createdAt: ago(11),
    updatedAt: ago(9),
    lastMessage: null,
    unread: false,
    messageCount: 2,
    userId: 'u-a2',
    userName: '阿凱',
    orderId: null,
    prizeId: null,
    sellerId: null,
    grader: null,
    certNo: null,
    assigneeId: 'u-platform',
    assigneeName: 'VaultDraw 客服',
    closedAt: null,
    resolution: null,
    certHolder: null,
    messages: [
      msg('u-a2', '阿凱', false, '舊門號停用了，LINE 綁定的驗證簡訊收不到，要怎麼換？', ago(11)),
      msg('u-platform', 'VaultDraw 客服', true,
        '請提供新門號，以及最近一次儲值的日期與金額供核對身分。', ago(9))
    ]
  },
  {
    id: 't-1022',
    kind: 'takeover',
    status: 'open',
    subject: '接管 BGS #0015678901',
    createdAt: ago(0.7),
    updatedAt: ago(0.7),
    lastMessage: null,
    unread: true,
    messageCount: 1,
    userId: 'u-a3',
    userName: '收藏家 J',
    orderId: null,
    prizeId: null,
    sellerId: null,
    grader: 'BGS',
    certNo: '0015678901',
    assigneeId: null,
    assigneeName: null,
    closedAt: null,
    resolution: null,
    certHolder: { userId: 'u-a2', userName: '阿凱', memberNo: 'VD-M9X2P7' },
    messages: [
      msg('u-a3', '收藏家 J', false,
        '面交買到的牡丹 SAR，賣家帳號是 VD-M9X2P7，他說他已經在站上把卡下架了。', ago(0.7), ['f-83cd0e2149ab'])
    ]
  },
  {
    id: 't-1009',
    kind: 'other',
    status: 'resolved',
    subject: '想問開池的抽成怎麼算',
    createdAt: ago(190),
    updatedAt: ago(186),
    lastMessage: null,
    unread: false,
    messageCount: 2,
    userId: 'u-a3',
    userName: '收藏家 J',
    orderId: null,
    prizeId: null,
    sellerId: null,
    grader: null,
    certNo: null,
    assigneeId: 'u-platform',
    assigneeName: 'VaultDraw 客服',
    closedAt: ago(186),
    resolution: '已說明抽成級距，並附上說明頁連結。',
    certHolder: null,
    messages: [
      msg('u-a3', '收藏家 J', false, '開池的手續費是固定的還是看等級？', ago(190)),
      msg('u-platform', 'VaultDraw 客服', true, '看賣家等級，已驗證與信任兩級不同，說明頁有級距表。', ago(186))
    ]
  },
  {
    id: 't-1004',
    kind: 'takeover',
    status: 'rejected',
    subject: '接管 PSA #82345675',
    createdAt: ago(300),
    updatedAt: ago(292),
    lastMessage: null,
    unread: false,
    messageCount: 2,
    userId: 'u-a2',
    userName: '阿凱',
    orderId: null,
    prizeId: null,
    sellerId: null,
    grader: 'PSA',
    certNo: '82345675',
    assigneeId: 'u-platform',
    assigneeName: 'VaultDraw 客服',
    closedAt: ago(292),
    resolution: '申請人提供的轉手憑證與登記人不符，且登記人否認出售，予以駁回。',
    certHolder: { userId: 'u-a1', userName: '小明', memberNo: 'VD-A3K7Q2' },
    messages: [
      msg('u-a2', '阿凱', false, '這張我在臉書社團買的，賣家已經封鎖我了。', ago(300)),
      msg('u-platform', 'VaultDraw 客服', true,
        '已聯繫目前登記人，對方表示未曾出售此卡。憑證無法佐證易主，本次申請駁回。', ago(292))
    ]
  }
]

/** 待處理＝還在客服手上，或還在等使用者。已結案的兩種不算 */
const PENDING: TicketStatus[] = ['open', 'pending-user']

/** 訊息串的最後一則，截 80 字 —— 佇列上要看得出「進度到哪」，但不能把整段貼上去 */
function lastOf(t: AdminTicketDetail): string | null {
  const m = t.messages[t.messages.length - 1]
  if (!m) return null
  return m.body.length > 80 ? m.body.slice(0, 80) + '…' : m.body
}

/** 把完整工單壓成佇列的一列。摘要永遠是算出來的，不是另外存的 */
function rowOf(t: AdminTicketDetail): AdminTicketRow {
  return {
    id: t.id,
    kind: t.kind,
    status: t.status,
    subject: t.subject,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    lastMessage: lastOf(t),
    unread: t.unread,
    messageCount: t.messages.length,
    userName: t.userName,
    userMemberNo: MEMBER_NO[t.userId] ?? '',
    assigneeId: t.assigneeId,
    assigneeName: t.assigneeName
  }
}

/**
 * 佇列。預設只給待處理的，舊的排前面 —— 客服的工作順序就是先進先出，
 * 讓最久沒人理的那張自然浮到最上面，不需要他自己去排序。
 */
export function adminList(scope: 'pending' | 'all'): AdminTicketRow[] {
  return tickets
    .filter(t => (scope === 'all' ? true : PENDING.includes(t.status)))
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(rowOf)
}

/* 回傳深拷貝：讓 store 與這份假資料共用同一個物件的話，改動之後新舊值相同，
   Vue 比不出差別就不會重繪（mocks/data.ts 的 poolSnapshot 同理）。 */
const clone = (t: AdminTicketDetail): AdminTicketDetail => ({
  ...t,
  lastMessage: lastOf(t),
  messageCount: t.messages.length,
  certHolder: t.certHolder ? { ...t.certHolder } : t.certHolder,
  messages: t.messages.map(m => ({ ...m, fileIds: [...m.fileIds] }))
})

export function adminGet(id: string): AdminTicketDetail | null {
  const t = tickets.find(x => x.id === id)
  return t ? clone(t) : null
}

/** 認領。已被別人認領的要擋 —— 兩個客服同時處理同一張單會回出互相矛盾的話 */
export function adminClaim(id: string, adminId: string, adminName: string): AdminTicketDetail {
  const t = tickets.find(x => x.id === id)
  if (!t) throw new Error('找不到這張工單')
  if (t.assigneeId && t.assigneeId !== adminId) throw new Error(`這張單已由 ${t.assigneeName} 認領`)
  t.assigneeId = adminId
  t.assigneeName = adminName
  t.updatedAt = Date.now()
  return clone(t)
}

/** 客服回覆。狀態推成 pending-user：球回到使用者手上，佇列上要看得出差別 */
export function adminReply(id: string, body: string, fileIds: string[]): AdminTicketDetail {
  const t = tickets.find(x => x.id === id)
  if (!t) throw new Error('找不到這張工單')
  if (t.status === 'resolved' || t.status === 'rejected') throw new Error('這張單已結案，不能再回覆')
  t.messages.push(msg(MOCK_ADMIN.id, MOCK_ADMIN.name, true, body, Date.now(), fileIds))
  t.status = 'pending-user'
  t.unread = false
  t.updatedAt = Date.now()
  return clone(t)
}

/**
 * 結案。
 *
 * `disputeTo` 只有 order-dispute + resolved 才有意義 —— 工單本身不動錢，
 * 真正移動點數的是既有的爭議裁決邏輯（契約第一節）。這裡只把「判給誰」
 * 記進結案訊息，讓展示模式看得出這個選擇真的有被帶出去，而不是一個沒接線的按鈕。
 */
export function adminResolve(
  id: string,
  outcome: 'resolved' | 'rejected',
  resolution: string,
  disputeTo?: 'buyer' | 'seller'
): AdminTicketDetail {
  const t = tickets.find(x => x.id === id)
  if (!t) throw new Error('找不到這張工單')
  if (t.status === 'resolved' || t.status === 'rejected') throw new Error('這張單已經結案了')
  if (t.kind === 'order-dispute' && outcome === 'resolved' && !disputeTo) {
    throw new Error('訂單爭議通過結案時要指定判給哪一方')
  }
  t.status = outcome
  t.resolution = resolution
  t.closedAt = Date.now()
  t.updatedAt = t.closedAt
  t.unread = false
  const tail =
    t.kind === 'order-dispute' && outcome === 'resolved'
      ? `（判給${disputeTo === 'buyer' ? '買家' : '賣家'}）`
      : ''
  t.messages.push(
    msg(MOCK_ADMIN.id, MOCK_ADMIN.name, true,
      `${outcome === 'resolved' ? '本案已處理完成' : '本案已駁回'}${tail}：${resolution}`, t.closedAt)
  )
  return clone(t)
}
