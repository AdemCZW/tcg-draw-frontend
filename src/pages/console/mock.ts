/**
 * 後台的展示資料。
 *
 * 為什麼需要：後台的每一支呼叫都直接走 http()，完全沒有 MOCK 分支 ——
 * 沒有後端的時候所有後台頁都停在「載入中…」，等於這一整套介面在展示模式下
 * 是不存在的。要給人看後台、或在沒有資料庫的機器上調版面，都做不到。
 *
 * 資料刻意做出「需要處理的東西」：待處理的出貨、待審核的賣家、爭議中的訂單。
 * 全部都是零的後台看不出它為什麼長這樣。
 */
import type {
  Overview, AdminUser, UserDetail, Shipment, Seller, Verification, Pool, Dispute, AuditAction
} from './shared'

const now = Date.now()
const ago = (d: number) => now - d * 86400_000

const users: AdminUser[] = [
  { id: 'u-a1', handle: 'VD-A3K7Q2', member_no: 'VD-A3K7Q2', name: '小明', email: null, role: 'user', created_at: ago(2) },
  { id: 'u-a2', handle: 'VD-M9X2P7', member_no: 'VD-M9X2P7', name: '阿凱', email: 'kai@example.com', role: 'user', created_at: ago(9) },
  { id: 'u-a3', handle: 'VD-T4B8N1', member_no: 'VD-T4B8N1', name: '收藏家 J', email: null, role: 'user', created_at: ago(23) },
  { id: 'u-platform', handle: 'platform', member_no: 'VD-0000P1', name: 'VaultDraw 官方', email: 'admin@example.com', role: 'admin', created_at: ago(90) }
]

const shipments: Shipment[] = [
  {
    id: 'sh-01', userId: 'u-a1', userHandle: 'VD-A3K7Q2', userName: '小明',
    address: { name: '王小明', phone: '0912345678', zip: '106', city: '台北市', line1: '大安區測試路 1 號 5 樓' },
    status: 'requested', tracking: null, createdAt: ago(4), shippedAt: null,
    prizes: [{ id: 'pz-1', name: '噴火龍 ex UR', tier: 'LAST' }, { id: 'pz-2', name: '奇樹 SAR', tier: 'A' }]
  },
  {
    id: 'sh-02', userId: 'u-a2', userHandle: 'VD-M9X2P7', userName: '阿凱',
    address: { name: '陳阿凱', phone: '0922333444', zip: '407', city: '台中市', line1: '西屯區示範街 88 號' },
    status: 'packed', tracking: null, createdAt: ago(1), shippedAt: null,
    prizes: [{ id: 'pz-3', name: '月亮伊布 ex SAR', tier: 'C' }]
  },
  {
    id: 'sh-03', userId: 'u-a3', userHandle: 'VD-T4B8N1', userName: '收藏家 J',
    address: { name: '林某', phone: '0955666777', zip: '801', city: '高雄市', line1: '前金區範例路 12 號' },
    status: 'shipped', tracking: 'RR123456785TW', createdAt: ago(6), shippedAt: ago(3),
    prizes: [{ id: 'pz-4', name: '謎擬Ｑ SAR', tier: 'D' }]
  }
]

const sellers: Seller[] = [
  { id: 'u-a2', handle: 'VD-M9X2P7', name: '關都卡舖', tier: 'pending', pools: 0, faults: 0, created_at: ago(1) },
  { id: 'u-s1', handle: 'VD-S1', name: '保庫堂', tier: 'trusted', pools: 6, faults: 0, created_at: ago(120) },
  { id: 'u-s2', handle: 'VD-S2', name: '促販工房', tier: 'verified', pools: 2, faults: 1, created_at: ago(45) }
]

const verifications: Verification[] = [
  {
    id: 'v-1', seller_id: 'u-a2', doc_file_id: 'f-doc-1', status: 'pending', note: null,
    created_at: ago(1), seller_name: '關都卡舖', seller_handle: 'VD-M9X2P7', tier: 'pending'
  }
]

const pools: Pool[] = [
  { id: 'p-1', title: '官方旗艦場 #59', mode: 'classic', status: 'open', ticket_price: 1280, total_tickets: 100, sold: 42, created_at: ago(5), opened_at: ago(5), seller_name: 'VaultDraw 官方', seller_tier: 'trusted' },
  { id: 'p-2', title: '關都精選 · 伊布家族', mode: 'classic', status: 'open', ticket_price: 350, total_tickets: 250, sold: 118, created_at: ago(12), opened_at: ago(12), seller_name: '保庫堂', seller_tier: 'trusted' },
  { id: 'p-3', title: '新賣家的第一池', mode: 'classic', status: 'open', ticket_price: 3200, total_tickets: 20, sold: 2, created_at: ago(1), opened_at: ago(1), seller_name: '關都卡舖', seller_tier: 'pending' },
  { id: 'p-4', title: '官方旗艦場 #58', mode: 'classic', status: 'revealed', ticket_price: 800, total_tickets: 60, sold: 60, created_at: ago(30), opened_at: ago(30), seller_name: 'VaultDraw 官方', seller_tier: 'trusted' }
]

const disputes: Dispute[] = [
  { id: 'o-91', card: { name: '太樂巴戈斯 ex UR' }, price: 19800, status: 'disputed', buyer_id: 'u-a1', seller_id: 'u-s2', created_at: ago(8) }
]

const actions: AuditAction[] = [
  { id: 3, admin_id: 'u-platform', action: 'grant', target: 'u-a1', payload: { points: 5000 }, note: '客服補償 #1234', created_at: ago(1) },
  { id: 2, admin_id: 'u-platform', action: 'shipment-status', target: 'sh-03', payload: { status: 'shipped', tracking: 'RR123456785TW' }, note: '後台推進至 已寄出', created_at: ago(3) },
  { id: 1, admin_id: 'u-platform', action: 'seller-tier', target: 'u-s1', payload: { tier: 'trusted' }, note: '後台調整為 信任', created_at: ago(20) }
]

const detailOf = (id: string): UserDetail | null => {
  const u = users.find(x => x.id === id)
  if (!u) return null
  return {
    user: {
      ...u,
      display_name: u.name, real_name: u.name ? u.name + '（本名）' : null,
      phone: '0912345678', address_zip: '106', address_city: '台北市',
      address_line1: '大安區測試路 1 號 5 樓', birthday: '1995-03-12'
    },
    providers: ['line'],
    wallet: { points: 128_400, locked: 19_800, available: 108_600 },
    prizes: [
      { id: 'pz-1', card: { name: '噴火龍 ex UR' }, tier: 'LAST', status: 'stashed', won_at: ago(4) },
      { id: 'pz-3', card: { name: '月亮伊布 ex SAR' }, tier: 'C', status: 'listed', won_at: ago(11) }
    ],
    orders: [
      { id: 'o-91', card: { name: '太樂巴戈斯 ex UR' }, price: 19800, status: 'disputed', created_at: ago(8), buyer_id: id, seller_id: 'u-s2' }
    ],
    shipments: shipments.filter(s => s.userId === id).map(s => ({ id: s.id, status: s.status, tracking: s.tracking, created_at: s.createdAt })),
    ledger: [
      { id: 4, delta: 5000, reason: 'admin-grant', created_at: ago(1) },
      { id: 3, delta: -1050, reason: 'draw', created_at: ago(4) },
      { id: 2, delta: 19600, reason: 'recycle', created_at: ago(11) },
      { id: 1, delta: 1_000_000, reason: 'admin-grant', created_at: ago(23) }
    ]
  }
}

const overview: Overview = {
  users: users.length,
  pools_open: pools.filter(p => p.status === 'open').length,
  orders_open: 4,
  orders_disputed: disputes.length,
  ship_requested: shipments.filter(s => s.status === 'requested').length,
  ship_active: shipments.filter(s => s.status === 'packed' || s.status === 'shipped').length,
  escrowed_points: 41_600,
  sellers_pending: sellers.filter(s => s.tier === 'pending').length
}

/**
 * 回傳這條路徑的展示資料。認不出來就回 null，呼叫端會照常走真的 http()
 * —— 這樣新加的端點不會因為忘了補假資料而靜默拿到空物件。
 */
/* 公開聯絡表單送進來的訊息（/v1/admin/contact）。
   **一定要有一筆匿名的**：這個佇列跟客服工單的差別就在「送出的人多半
   沒有帳號」，全部都有帳號的展示資料看不出它為什麼要獨立成一頁。
   （沒有這一段的話展示模式會落到下面那條「寫入類一律回 ok」，
   回一個沒有 items 的物件，畫面直接壞掉。） */
const contactMessages = [
  {
    id: 'ct-000000000001', topic: 'login', name: '匿名訪客',
    email: 'guest@example.com',
    body: '我忘記密碼了，登入頁上找不到忘記密碼的按鈕，也開不了工單。我是用 Email 註冊的。',
    userId: null, userName: null, userMemberNo: null,
    status: 'new', createdAt: ago(2), handledAt: null, handledByName: null, handledNote: null
  },
  {
    id: 'ct-000000000002', topic: 'report', name: '林小姐',
    email: 'reporter@example.com',
    body: '市場上有一張卡的鑑定編號跟我手上那張一模一樣，我懷疑是同一張被重複登記。',
    userId: null, userName: null, userMemberNo: null,
    status: 'new', createdAt: ago(1), handledAt: null, handledByName: null, handledNote: null
  },
  {
    id: 'ct-000000000003', topic: 'order', name: '阿凱',
    email: 'kai@example.com',
    body: '訂單一直停在運送中，物流查不到單號。',
    userId: 'u-a2', userName: '阿凱', userMemberNo: 'VD-M9X2P7',
    status: 'handled', createdAt: ago(6), handledAt: ago(5),
    handledByName: 'VaultDraw 官方', handledNote: '已回信，請賣家補正確單號'
  }
]

export function mockAdmin(path: string): unknown | null {
  const [route, query = ''] = path.split('?')
  const q = new URLSearchParams(query)

  if (route === '/v1/admin/overview') return { overview }
  if (route === '/v1/admin/actions') return { actions }
  if (route === '/v1/admin/disputes') return { disputes }
  if (route === '/v1/admin/pools') return { pools }
  if (route === '/v1/admin/sellers') return { sellers }
  if (route === '/v1/admin/verifications') return { verifications }
  if (route === '/v1/admin/contact') {
    const items = q.get('scope') === 'all' ? contactMessages : contactMessages.filter(m => m.status === 'new')
    return { items, nextCursor: null, pending: contactMessages.filter(m => m.status === 'new').length }
  }

  if (route === '/v1/admin/shipments') {
    const st = q.get('status')
    return { shipments: st ? shipments.filter(s => s.status === st) : shipments }
  }
  if (route === '/v1/admin/users') {
    const s = (q.get('q') ?? '').trim().toLowerCase()
    if (!s) return { users }
    const bare = s.replace(/^vd-?/, '')
    return {
      users: users.filter(u =>
        (u.member_no ?? '').toLowerCase().includes(bare) ||
        u.handle.toLowerCase().includes(s) ||
        (u.name ?? '').toLowerCase().includes(s) ||
        (u.email ?? '').toLowerCase().includes(s))
    }
  }
  const m = /^\/v1\/admin\/users\/([^/]+)$/.exec(route ?? '')
  if (m) return detailOf(m[1]!)

  // 收攤：展示模式下也真的改狀態，不然按了畫面沒反應看不出流程對不對
  const closeM = /^\/v1\/pools\/([^/]+)\/close$/.exec(route ?? '')
  if (closeM) {
    const p = pools.find(x => x.id === closeM[1])
    if (p) p.status = 'cancelled'
    return { ok: true }
  }

  // 其餘寫入類的動作：展示模式下一律當作成功，但不改資料
  if (/^\/v1\/(admin|orders)\//.test(route ?? '') || route === '/v1/admin/grant') return { ok: true }
  return null
}
