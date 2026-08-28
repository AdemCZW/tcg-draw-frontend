/**
 * 客服工單的商業邏輯。
 *
 * ── 這一層刻意不做什麼 ──────────────────────────────────────────────
 * **工單是前門，不是新的金流。**（見 migrations/024_tickets.sql 的檔頭）
 *
 * 訂單爭議會實際移動點數、賣家審核會改開池權限，那兩條已經寫好、測過、在跑。
 * 這個檔案裡**沒有任何一行會寫 points_ledger、也沒有任何一行會改 sellers.tier**。
 * 裁決時呼叫既有的那套（爭議走 routes/orders.ts 的 act()，審核走
 * seller_verifications 那段），呼叫點在 routes/admin.ts 的工單結案端點 ——
 * 那個檔案本來就已經匯入 act()，放在同一個檔案裡兩段互相看得見，
 * 比在這裡再匯入一次更不容易漂移。
 *
 * 這一層唯一會動到「事實」的地方是接管單的過戶（applyTakeover）——
 * 那是站外轉手，本來就沒有任何既有邏輯可以呼叫，見下面那一段的說明。
 *
 * 驗收標準：把 tickets / ticket_messages 兩張表 drop 掉，錢跟權限都還是對的。
 */
import { randomBytes } from 'node:crypto'
import { sql } from './db.js'
import type { Db, Tx } from './db.js'
import { notify, notifyMany } from './notify.js'

/* 測試腳本以外的地方不用 any；資料庫回來的列在這個 repo 一律是
   Record<string, unknown>，跟 orders-service.ts 的 toOrder 同一個作法。 */
type Row = Record<string, unknown>

export const TICKET_KINDS = [
  'takeover', 'order-dispute', 'seller-doc', 'card-issue', 'account', 'other'
] as const
export type TicketKind = (typeof TICKET_KINDS)[number]

/** 使用者自己開得了的類型。order-dispute / seller-doc 只能由系統自動開 */
export const USER_KINDS = ['takeover', 'card-issue', 'account', 'other'] as const

export type TicketStatus = 'open' | 'pending-user' | 'resolved' | 'rejected'

/** 未結案。客服佇列與各種「還在跑」的判斷都用這一組，不要各處自己列 */
export const LIVE_STATUSES = ['open', 'pending-user'] as const

const newId = () => 'tk-' + randomBytes(6).toString('hex')

/* ---------------------------------------------------------------- 正規化 */

/**
 * 鑑定資訊的正規化。**一定要跟 prizes 那一套完全一樣**
 * （見 migrations/021_inventory_first.sql 的回填、pools.ts 的押記）：
 * upper(btrim) / nullif。少了它，客服查「這個編號有沒有人申請過接管」
 * 會漏掉大小寫或前後空白不同的那幾筆 —— 而漏掉的後果是同一張實體卡
 * 被兩個人各開一張接管單，兩張都通過。
 */
export const normGrader = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim().toUpperCase()
  return t === '' ? null : t
}
export const normCert = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim()
  return t === '' ? null : t
}

/* ------------------------------------------------------------ 對外的形狀 */

export interface TicketMessage {
  id: number
  authorId: string
  authorName: string
  isStaff: boolean
  body: string
  fileIds: string[]
  createdAt: number
}

/** 摘要的前 80 字。佇列上要直接看得到進度，不用點進去 */
const PREVIEW = 80

/**
 * 「有沒有對方還沒看過的新訊息」。
 *
 * 024 **沒有已讀欄位**，所以這裡是推導的：最後一則是不是對方講的。
 * 這個近似在真實的使用情境下幾乎總是對的（一問一答），會失準的情況是
 * 「同一邊連續發兩則、對方只看了第一則」—— 代價是少提醒一次，
 * 不會多提醒，也不會把別人的東西標成你的。
 *
 * 真的要精確就得加一張 ticket_reads（誰在什麼時候讀到哪一則）——
 * 那是一支新的遷移，不在這次範圍。
 */
const unreadFor = (viewer: 'user' | 'staff', lastIsStaff: boolean | null): boolean =>
  lastIsStaff === null ? false : viewer === 'user' ? lastIsStaff : !lastIsStaff

export function toSummary(r: Row, viewer: 'user' | 'staff') {
  const lastBody = r.last_body == null ? null : String(r.last_body)
  return {
    id: String(r.id),
    kind: r.kind as TicketKind,
    status: r.status as TicketStatus,
    subject: String(r.subject),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastMessage: lastBody === null ? null : lastBody.slice(0, PREVIEW),
    unread: unreadFor(viewer, r.last_is_staff == null ? null : Boolean(r.last_is_staff)),
    messageCount: Number(r.message_count ?? 0)
  }
}

export function toDetail(r: Row, messages: TicketMessage[], viewer: 'user' | 'staff') {
  return {
    ...toSummary(r, viewer),
    userId: String(r.user_id),
    userName: String(r.user_name ?? ''),
    orderId: r.order_id == null ? null : String(r.order_id),
    prizeId: r.prize_id == null ? null : String(r.prize_id),
    sellerId: r.seller_id == null ? null : String(r.seller_id),
    grader: r.grader == null ? null : String(r.grader),
    certNo: r.cert_no == null ? null : String(r.cert_no),
    assigneeId: r.assignee_id == null ? null : String(r.assignee_id),
    assigneeName: r.assignee_name == null ? null : String(r.assignee_name),
    closedAt: r.closed_at == null ? null : Number(r.closed_at),
    resolution: r.resolution == null ? null : String(r.resolution),
    messages
  }
}

/* --------------------------------------------------------------- 查詢 */

/** 摘要要的三個衍生欄位（訊息數、最後一則的內容與是誰講的）。
    寫成一段共用的 SQL 片段，使用者端與客服端才不會各長一份查詢而漂移。 */
const summaryCols = (db: Db) => db`
  (select count(*) from ticket_messages m where m.ticket_id = t.id)::int as message_count,
  lm.body as last_body, lm.is_staff as last_is_staff
`
const summaryJoin = (db: Db) => db`
  left join lateral (
    select body, is_staff from ticket_messages m
     where m.ticket_id = t.id order by m.id desc limit 1
  ) lm on true
`

export { summaryCols, summaryJoin }

/** 訊息串。作者名字一起帶出來 —— 前端拿到 id 也顯示不了任何東西 */
export async function loadMessages(ticketId: string, db: Db = sql): Promise<TicketMessage[]> {
  const rows = await db`
    select m.id, m.author_id, m.body, m.file_ids, m.is_staff, m.created_at,
           coalesce(u.name, u.handle) as author_name
      from ticket_messages m
      left join users u on u.id = m.author_id
     where m.ticket_id = ${ticketId}
     order by m.id asc
  `
  return rows.map(r => ({
    id: Number(r.id),
    authorId: String(r.author_id),
    authorName: String(r.author_name ?? ''),
    isStaff: Boolean(r.is_staff),
    body: String(r.body),
    fileIds: (r.file_ids as string[] | null) ?? [],
    createdAt: Number(r.created_at)
  }))
}

/** 一張單（含開單人與認領人的名字）。找不到回 null */
export async function loadTicket(ticketId: string, viewer: 'user' | 'staff', db: Db = sql) {
  const [r] = await db`
    select t.*,
           coalesce(u.name, u.handle) as user_name,
           coalesce(a.name, a.handle) as assignee_name,
           ${summaryCols(db)}
      from tickets t
      join users u on u.id = t.user_id
      left join users a on a.id = t.assignee_id
      ${summaryJoin(db)}
     where t.id = ${ticketId}
  `
  if (!r) return null
  return { row: r as Row, detail: toDetail(r as Row, await loadMessages(ticketId, db), viewer) }
}

/**
 * 接管單專用：那個編號目前登記在誰名下。
 *
 * **只給客服端**（合約第三節：使用者端一律不回）—— 那是別人的身分，
 * 不該讓申請人看到。把它做成一支獨立的函式而不是塞進 loadTicket，
 * 就是為了讓「誰呼叫得到它」在程式碼上看得見。
 */
export async function certHolderOf(grader: string | null, certNo: string | null, db: Db = sql) {
  if (!certNo) return null
  const [r] = await db`
    select u.id, coalesce(u.name, u.handle) as name, u.member_no
      from prizes p join users u on u.id = p.user_id
     where p.grader is not distinct from ${grader}::text and p.cert_no = ${certNo}
     order by p.acquired_at desc limit 1
  `
  return r ? { userId: String(r.id), userName: String(r.name), memberNo: String(r.member_no ?? '') } : null
}

/* ------------------------------------------------------------ 附件驗證 */

/**
 * 附件要驗**持有人與用途**，不是驗格式。
 *
 * 格式驗證（/^f-[0-9a-f]{12}$/）擋不住拿別人的 id 或拿頭像的 id 來充數 ——
 * file id 是 API 回應裡看得到的東西。比照 orders.ts 出貨照那一段。
 *
 * 驗在交易外面是安全的：files 的列一旦寫入就不會換擁有者也不會換用途，
 * 沒有可以搶的時窗；放在交易裡反而得用 throw 打斷，那會穿出去變成 500 ——
 * 把使用者的輸入錯誤講成伺服器故障（security-audit L-4）。
 */
export async function ownsFiles(fileIds: string[], ownerId: string): Promise<boolean> {
  if (!fileIds.length) return true
  const owned = await sql`
    select id from files
     where id = any(${fileIds}) and owner_id = ${ownerId} and purpose = 'ticket-doc'
  `
  return owned.length === fileIds.length
}

/* --------------------------------------------------------------- 寫入 */

export interface NewTicket {
  userId: string
  kind: TicketKind
  subject: string
  body: string
  fileIds?: string[]
  orderId?: string | null
  prizeId?: string | null
  sellerId?: string | null
  grader?: string | null
  certNo?: string | null
  /** 第一則訊息是不是客服講的（自動開單的第一則一律是當事人的話） */
  firstMessageBy?: string
  isStaff?: boolean
}

/** 建單 + 第一則訊息，同一筆交易。單開得成但第一則訊息掉了的單客服看不懂 */
export async function insertTicket(tx: Tx, t: NewTicket): Promise<string> {
  const id = newId()
  const now = Date.now()
  await tx`
    insert into tickets (id, user_id, kind, status, subject,
                         order_id, prize_id, seller_id, grader, cert_no,
                         created_at, updated_at)
    values (${id}, ${t.userId}, ${t.kind}, 'open', ${t.subject},
            ${t.orderId ?? null}, ${t.prizeId ?? null}, ${t.sellerId ?? null},
            ${t.grader ?? null}, ${t.certNo ?? null},
            ${now}, ${now})
  `
  await tx`
    insert into ticket_messages (ticket_id, author_id, body, file_ids, is_staff, created_at)
    values (${id}, ${t.firstMessageBy ?? t.userId}, ${t.body},
            ${(t.fileIds ?? []) as never}, ${t.isStaff ?? false}, ${now})
  `
  return id
}

/**
 * 通知客服。
 *
 * 沒有「群發給管理員」的機制（notifications 是一人一列），所以這裡自己
 * 展開成每個 role='admin' 的人一則。人數是個位數，不需要另一套廣播。
 *
 * refId 一定要**每則不同**：notifications_once 是
 * unique(user_id, kind, ref_id)，同一張單的第二則通知會被靜默吃掉，
 * 於是客服再也收不到這張單的後續 —— 那個症狀從外面完全看不出來。
 */
export async function notifyStaff(refId: string, title: string, body: string, link: string, db: Db = sql) {
  const admins = await db`select id from users where role = 'admin' limit 20`
  await notifyMany(admins.map(a => ({
    userId: String(a.id), kind: 'system' as const, title, body, link, refId
  })), db)
}

/* --------------------------------------------------- 接管單的過戶（唯一會動擁有權的地方） */

/**
 * 撞到這幾個狀態要**擋下來**，不是搶走。
 *
 * 站外轉手接管是整套工單裡唯一會改 prizes.user_id 的動作，而這三個狀態
 * 代表「這張卡現在正被另一條流程握著」：
 *
 *   in_pool         押在某個抽卡池裡。有人正在買那個池的籤，獎品清單與
 *                   公平性承諾都已經對外公開了 —— 從池裡把獎品抽走，
 *                   等於讓已經付錢的人抽到一張不存在的卡。
 *   listed          掛在市場上。買家可能正在結帳（orders.ts 那段 FOR UPDATE
 *                   就是為了這個時窗），過戶到一半成交會變成一卡兩賣。
 *   ship_requested  平台正在把實體卡寄給現在的擁有者。實體在移動中，
 *                   而接管的前提是「實體已經在申請人手上」—— 兩件事同時
 *                   為真的話，其中一個人手上的卡是假的，那要先查清楚。
 *
 * 所以選擇是「擋下來，要客服先處理那一邊」而不是「拒絕接管」：
 * 這三個狀態都有既有的出路（等池結束解押、賣家自己下架、出貨走完），
 * 走完之後同一張單再按一次結案就過得了。直接拒絕等於逼使用者重開一張單，
 * 而他什麼都沒做錯。
 *
 * 反過來，**沒有列在這裡的狀態一律放行**，包含 recycled / refunded ——
 * 那兩個的實體卡已經回到賣家手上，賣家把它拿去站外賣掉是完全合法的，
 * 而且那正是接管要處理的情況。擋掉它們會讓一張真實存在的卡永遠進不了系統。
 */
const TAKEOVER_BLOCKED: Record<string, string> = {
  in_pool: '這張卡目前押在一個抽卡池裡，要等那個池結束、卡解押回賣家的卡冊之後才能接管。請先處理池那一邊。',
  listed: '這張卡目前掛在市場上，要請現在的持有人先下架才能接管。請先處理掛單那一邊。',
  ship_requested: '這張卡正在出貨流程中（平台正要寄給現在的持有人），實體卡的位置還沒確定。請先把出貨處理完再接管。'
}

export interface TakeoverResult {
  prizeId: string
  fromUserId: string
  changed: boolean
}

/**
 * 把一個鑑定編號的卡過到申請人名下。
 *
 * **user_id 與 custodian_id 要一起改** —— 站外轉手是唯一「擁有權與實體同時
 * 易主」的路徑（見 migrations/021 對 custodian_id 的說明：只有出貨簽收與
 * 站外轉手接管會動那一欄，站內交易一律不碰）。只改一邊的後果：
 * 只改 user_id 的話，卡在申請人的卡冊裡但系統認為實體還在前一手那裡，
 * 上架時會被判成「需寄送」而由前一手負責寄 —— 那張卡根本不在他那。
 *
 * 狀態設成 in_book：那是「閒置在卡冊、可以上架也可以進池」的意思，
 * 而 stashed 的語意是「抽到的獎品寄存在平台」——這張卡不是抽來的，
 * 平台也沒有保管它。（同一個理由見 pools-service.ts 解押回 in_book 那段。）
 *
 * 一定要在交易裡、而且要 FOR UPDATE 鎖住那一列：上架端點
 * （public.ts 的 POST /listings）也是先鎖 prizes 再寫 listings，
 * 兩邊鎖同一列才互斥得了。少了這個鎖，「檢查狀態不是 listed」與
 * 「改 user_id」之間的那一瞬間剛好可以塞進一筆掛單。
 */
export async function applyTakeover(
  tx: Tx, grader: string | null, certNo: string, toUserId: string
): Promise<TakeoverResult | { error: string; message: string; status: number }> {
  const [pz] = await tx`
    select id, user_id, custodian_id, status from prizes
     where grader is not distinct from ${grader}::text and cert_no = ${certNo}
     order by acquired_at desc limit 1
     for update
  `
  if (!pz) {
    return {
      error: 'CERT_NOT_FOUND',
      message: '這個鑑定編號現在沒有登記在系統裡，沒有東西可以接管。請確認編號，或請申請人直接把卡片上傳到卡冊。',
      status: 409
    }
  }
  const from = String(pz.user_id)
  const blocked = TAKEOVER_BLOCKED[String(pz.status)]
  if (blocked) return { error: 'CARD_BUSY', message: blocked, status: 409 }

  /* 已經在申請人名下（客服重按一次、或申請人自己先處理掉了）不當成錯誤：
     接管的目的地就是這個狀態，回報 changed = false 讓稽核看得出來沒有動到東西。 */
  if (from === toUserId && String(pz.custodian_id ?? '') === toUserId) {
    return { prizeId: String(pz.id), fromUserId: from, changed: false }
  }

  /* acquired_at 一起改的理由跟庫內轉移那段一樣（orders.ts）：卡冊是照它排的，
     不改的話這張卡帶著前一手當初取得的時間進申請人的卡冊，排在幾天前的位置 ——
     卡冊超過一頁時申請人在第一頁根本看不到自己剛接管的卡。
     won_at 不動，那是「這張卡被抽出來」的事實。 */
  await tx`
    update prizes
       set user_id = ${toUserId}, custodian_id = ${toUserId},
           status = 'in_book', acquired_at = ${Date.now()}
     where id = ${pz.id}
  `
  return { prizeId: String(pz.id), fromUserId: from, changed: true }
}

/* ------------------------------------------------------------ 自動開單 */

/**
 * 自動開單一律「失敗只記 log」。
 *
 * 爭議本身已經成立了（點數已經凍結、訂單已經進 disputed），工單開不出來
 * 是我們的問題，不該讓使用者的申訴消失。比照 notifyMany 的寫法。
 *
 * 這也是為什麼既有的 /v1/admin/disputes 與 /v1/admin/verifications
 * 兩條端點保留不動：工單這一層萬一整個壞掉，客服還有原本那條路可以走。
 */
async function quietly(what: string, fn: () => Promise<void>): Promise<void> {
  try { await fn() } catch (e) { console.error(`[ticket] ${what} 自動開單失敗，主流程繼續:`, (e as Error).message) }
}

/** 訂單爭議成立後補開一張單。呼叫端不需要 catch */
export async function openDisputeTicket(orderId: string): Promise<void> {
  await quietly('order-dispute', async () => {
    const [o] = await sql`
      select id, buyer_id, card, dispute_reason from orders where id = ${orderId}
    `
    if (!o) return
    /* tickets_order_live 是 unique(order_id) where status in ('open','pending-user')，
       所以「同一張訂單只有一張未結案的爭議單」是結構保證，不是這裡的檢查。
       先查一次只是為了少寫一次註定會撞的 insert。 */
    const [live] = await sql`
      select id from tickets where order_id = ${orderId} and status = any(${[...LIVE_STATUSES]})
    `
    if (live) return
    const cardName = (o.card as { name?: string })?.name ?? '卡片'
    const id = await sql.begin(tx => insertTicket(tx, {
      userId: String(o.buyer_id),
      kind: 'order-dispute',
      subject: `訂單爭議：${cardName}`,
      /* 影片是**外部網址**，所以放在訊息內文裡而不是 file_ids ——
         那一欄只收站內上傳的檔案（024 的欄位註解、security-audit L-3）。
         這裡不是在放寬那條規則：內文是使用者講的話，本來就是自由文字；
         file_ids 才是「平台背書、不可替換的證據」。 */
      body: String(o.dispute_reason ?? '（買家沒有填寫原因）'),
      orderId
    }))
    await notifyStaff('ticket:' + id, '新的訂單爭議',
      `${cardName} 的買家提出爭議，等待裁決。`, '/admin/tickets/' + id)
  })
}

/** 賣家送審文件成功後補開一張單。呼叫端不需要 catch */
export async function openSellerDocTicket(sellerId: string, docFileId: string): Promise<void> {
  await quietly('seller-doc', async () => {
    /* 同一個賣家同時只留一張未結案的審核單。這一條**沒有結構保證**
       （024 的唯一索引只蓋 order_id），所以補件時重複開單擋不住併發 ——
       代價是客服佇列上多一張一樣的單，不會有任何金額或權限的後果，
       可以接受。真要擋得死需要一支新的部分唯一索引，不在這次範圍。 */
    const [live] = await sql`
      select id from tickets
       where seller_id = ${sellerId} and kind = 'seller-doc' and status = any(${[...LIVE_STATUSES]})
    `
    if (live) return
    const [s] = await sql`select name from sellers where id = ${sellerId}`
    const id = await sql.begin(tx => insertTicket(tx, {
      userId: sellerId,
      kind: 'seller-doc',
      subject: `賣家審核：${s?.name ?? sellerId}`,
      body: '賣家送出了身分／營業證明文件，等待審核。',
      /* 證件檔案的用途是 'seller-doc' 不是 'ticket-doc'，所以**不放進 file_ids**：
         那一欄的讀取端（前端）會假設它是這張單的附件，而附件的驗證規則是
         「擁有者是開單人且用途是 ticket-doc」。把別種用途的 id 混進去，
         等於讓那條規則對這一列失效。客服要看證件走既有的
         /v1/admin/verifications（那條保留不動），檔案本身走 /v1/files/:id
         —— 管理員讀得到。 */
      sellerId
    }))
    await notifyStaff('ticket:' + id, '新的賣家審核',
      `${s?.name ?? sellerId} 送出了證明文件（檔案 ${docFileId}），等待審核。`,
      '/admin/tickets/' + id)
  })
}

/** 通知開單人。refId 每則不同，理由見 notifyStaff */
export async function notifyOpener(
  userId: string, ticketId: string, refSuffix: string, title: string, body: string, db: Db = sql
) {
  await notify({
    userId, kind: 'system', title, body,
    link: '/support/' + ticketId,
    refId: `ticket:${ticketId}:${refSuffix}`
  }, db).catch(e => console.error('[ticket] 通知寫入失敗，主流程繼續:', (e as Error).message))
}
