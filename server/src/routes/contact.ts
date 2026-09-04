/**
 * 公開的客服聯絡表單（**不需要登入**）與它的後台佇列。
 *
 * ── 這支跟 routes/tickets.ts 的分工 ─────────────────────────────────
 * tickets.ts 第一行是 `tickets.use('*', requireAuth)` —— 它服務的是
 * 已經進得來的人。這一支服務的是**進不來的人**：忘記密碼的（平台刻意
 * 沒有忘記密碼流程）、還沒註冊的、檢舉的、主管機關與律師。
 * 為什麼開新表而不是共用 tickets，寫在 migrations/037_contact.sql 的檔頭。
 *
 * ── 為什麼公開端點與後台端點放在同一個檔案 ─────────────────────────
 * 這兩半是同一份資料的兩面，而且**這個功能唯一不能出的錯就是
 * 「送出成功了，但客服看不到」**。放在一起，寫入的欄位與讀出的欄位
 * 在同一個畫面上看得見；分兩個檔案時它們會各自漂移。
 * 掛載點仍然是分開的（見 index.ts）：`contact` 沒有任何 middleware，
 * `contactAdmin` 走 requireAuth + 管理員檢查。
 *
 * ── 這支刻意不做的事 ───────────────────────────────────────────────
 * · 不收附件（理由見 037 檔頭：匿名上傳等於開一個不記名的檔案空間）
 * · 不做 CAPTCHA（對真人是負擔，而且擋不住便宜的人力農場）
 * · **不把內容寄到任何地方。** 這支沒有任何 outbound HTTP、沒有寄信 ——
 *   收件人永遠是資料庫與後台，表單裡沒有任何一個欄位可以指定投遞對象。
 *   （公開端點只要能指定收件人，就是一台開放轉發器。）
 * · 不 console.log 任何欄位。姓名、email、內文一律不進日誌 —— 全站規矩，
 *   而這張表是唯一會收到「沒有帳號的人」的個資的地方。
 */
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { z } from 'zod'
import { createHash, randomBytes } from 'node:crypto'
import { sql } from '../db.js'
import { env } from '../env.js'
import { optionalUserId, requireAuth } from '../auth.js'
import { bumpAttempt, checkLimit, clientIp } from '../rate-limit.js'
import { notifyStaff } from '../tickets.js'
import { PageQuery, decodeCursor, encodeCursor, isNumeric, slicePage } from '../pagination.js'

export const contact = new Hono()
export const contactAdmin = new Hono()

const newId = () => 'ct-' + randomBytes(6).toString('hex')

/** 主題的中文。後端只用在給客服的通知上；畫面上的文案在前端。 */
const TOPIC_LABEL: Record<string, string> = {
  login: '登入不了', account: '帳號問題', order: '訂單或出貨',
  report: '檢舉或申訴', privacy: '個資與隱私', other: '其他'
}

/* ------------------------------------------------------------------ 限流

   這是公開端點，一定會被機器人打。兩層，**兩層都不共用登入失敗的桶**
   （M-1 的教訓在這個功能上特別致命：這張表單存在的全部理由，就是
   「一個因為登入一直失敗而被鎖在外面的人，還有地方可以講話」——
   如果它跟登入共用計數，那個人一輩子送不出來。regress-contact.ts 的
   交叉測試就是在釘這一條）。

   第一層 · 突發上限：`contact-ip:` 桶
     每一次 POST 都計數，**不管有沒有通過驗證** —— 只計成功的話，
     用畸形 body 猛打的機器人永遠碰不到限制。
     數字：`contact-ip:` 是一個新前綴，而 rate-limit.ts 的 maxFor()
     對不認得的前綴會落到 MAX_FAILS_IP（40 次／15 分鐘）。
     **這個數字是繼承來的，不是為這個端點挑的**；要挑一個更緊的
     （這裡想要的是 10 次／15 分鐘）就非得改 rate-limit.ts 不可，
     而那支檔案這一輪不能動。繼承值的方向是安全的：它比較寬鬆，
     所以不會誤擋真人，而真正的節流由第二層負責。桶本身仍然是獨立的
     ——「不跟登入互相拖累」這件事已經成立。

   第二層 · 日配額：從 contact_messages 自己數（10 則／24 小時／來源）
     擋的是「慢慢滴」的垃圾：每 15 分鐘乖乖只送 39 則的機器人，
     一天可以塞 3700 列進客服佇列，第一層完全攔不到。
     10 這個數字是照**真人的量體**定的：一個真的需要幫忙的人會送 1 則，
     講不清楚再補 1、2 則；為了同一件事送到第 10 則的人不存在。
     另一邊也想過：辦公室、學校、咖啡廳（NAT）後面共用一個來源時，
     一天要有 10 個不同的人各自來找客服才會撞到 —— 而客服訊息的
     發生率遠低於此（對照卡冊登記那個桶：那件事一個下午做 40 次是常態，
     這件事一個人一年做不到一次）。
     配額用完時 Retry-After 給的是「最舊那一則滿 24 小時還要多久」，
     不是固定值 —— 亂猜的間隔會讓被擋的人一直撞牆。 */
const CONTACT_BURST_KEY = (ip: string) => `contact-ip:${ip}`
const DAILY_MAX = 10
const DAILY_WINDOW_MS = 24 * 60 * 60_000

/**
 * 來源的雜湊。**原始 IP 不進資料庫。**
 *
 * 這張表是全站唯一會收到「沒有帳號的人」的個資的地方，而 IP 本身就是個資；
 * 我們需要的只是「是不是同一個來源」，那用雜湊就夠了。
 * 帶 JWT_SECRET 當胡椒（不是當簽章用）：沒有它的話，IPv4 的空間小到
 * 任何人拿到這張表都能在幾分鐘內把每一列反查回真實位址 —— 純 sha256
 * 對只有 40 億種可能的輸入不構成保護。
 * 取前 32 個十六進位字元（128 bit）：碰撞機率遠低於這張表的量體，
 * 而少存一半的位元就少一半可以被拿去比對的東西。
 */
const hashIp = (ip: string): string | null =>
  ip === 'unknown' ? null
    : createHash('sha256').update(`contact:${env.JWT_SECRET}:${ip}`).digest('hex').slice(0, 32)

/** 內容的指紋，只給「連按兩下送出」的去重用（見下面 POST 裡的說明） */
const bodyFingerprint = (topic: string, email: string, body: string) =>
  createHash('sha256').update(`${topic} ${email} ${body}`).digest('hex').slice(0, 32)

/* ------------------------------------------------------------------ 輸入 */

export const CONTACT_TOPICS = ['login', 'account', 'order', 'report', 'privacy', 'other'] as const

/* 長度上限的理由：
   name 40   —— 一個稱呼。超過就不是稱呼了。
   email 160 —— RFC 5321 的信封上限是 254，但實務上超過 160 的地址不存在；
                收得太寬只是給人塞東西的空間。
   body 4000 —— 比工單的 2000 寬一倍：這裡的人沒有第二則可以補充
                （沒有登入就沒有對話串），一次要講完。
                但仍然要有上限：沒有上限的公開欄位就是免費的儲存空間。 */
const Body = z.object({
  topic: z.enum(CONTACT_TOPICS),
  name: z.string().trim().min(1, '請留一個稱呼').max(40, '稱呼最多 40 個字'),
  /* z.string().email() 擋掉的是明顯不是地址的東西（沒有 @、沒有網域）。
     它**不保證那個信箱收得到信** —— 沒有人能保證，除非真的寄一封出去，
     而這個平台沒有寄信服務。所以表單上要請對方自己再看一次，
     而不是讓一個綠色勾勾去暗示「已驗證」。 */
  email: z.string().trim().max(160, 'Email 太長了').email('請填一個看得懂的 Email 地址'),
  body: z.string().trim().min(10, '請多寫幾個字，太短的訊息客服看不出你需要什麼')
    .max(4000, '訊息最多 4000 個字')
})

/* ------------------------------------------------------------------ 公開端點 */

/**
 * POST /v1/contact —— 送出一則聯絡訊息。**不需要登入。**
 *
 * 有帶 token 就記下是誰（客服因此有脈絡）；沒帶就是匿名，一樣收。
 * token 壞掉／過期**不會**讓這支失敗 —— optionalUserId 回 null 而已。
 * 那正是重點：一個 token 過期到進不了站的人，就是這張表單的目標對象。
 */
contact.post('/', async c => {
  const ip = clientIp(c)
  const burstKeys = [CONTACT_BURST_KEY(ip)]

  const burst = await checkLimit(burstKeys)
  if (burst.blocked) {
    return c.json(
      { error: 'TOO_MANY_CONTACTS',
        message: `短時間內送出的訊息太多了，請於 ${Math.max(1, Math.ceil(burst.retryAfter / 60))} 分鐘後再試。` },
      429, { 'retry-after': String(burst.retryAfter) }
    )
  }
  /* **驗證之前就先計數。** 順序反過來的話，用畸形 body 猛打的請求
     一次都不會被記到，第一層等於不存在。 */
  await bumpAttempt(burstKeys)

  const parsed = Body.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    /* 只回第一個問題，而且回的是 zod 上寫好的中文句子。
       把整包 issues 攤出來會連同使用者填的值一起回顯，那是把個資
       送回一個我們還不確定是誰的呼叫端。 */
    const msg = parsed.error.issues[0]?.message ?? '表單內容不完整'
    return c.json({ error: 'BAD_REQUEST', message: msg }, 400)
  }
  const { topic, name, email, body } = parsed.data
  const ipHash = hashIp(ip)
  const fp = bodyFingerprint(topic, email, body)

  /* 日配額。ipHash 是 null（取不到來源）時跳過這一層 ——
     擋住一個真的需要幫忙的人，比多收一筆垃圾嚴重（第一層仍然在）。 */
  if (ipHash) {
    const since = Date.now() - DAILY_WINDOW_MS
    const [q] = await sql<{ n: number; oldest: string | null }[]>`
      select count(*)::int as n, min(created_at)::text as oldest
        from contact_messages
       where ip_hash = ${ipHash} and created_at > ${since}
    `
    if (q && q.n >= DAILY_MAX) {
      /* 最舊那一則滿 24 小時還要多久。至少給 60 秒 ——
         算出 0 或負數時回 0 等於邀請對方立刻重打。 */
      const retryAfter = Math.max(60, Math.ceil((Number(q.oldest) + DAILY_WINDOW_MS - Date.now()) / 1000))
      return c.json(
        { error: 'TOO_MANY_CONTACTS',
          /* 不講「你今天送了幾則」「上限是幾則」：那是在教人怎麼貼著上限走，
             對真的有事的人也沒有幫助。只講「等多久」跟「還有別條路」。 */
          message: '今天從這個網路送出的訊息已經達到上限了，請於 '
            + `${Math.max(1, Math.ceil(retryAfter / 3600))} 小時後再試。`
            + '如果事情緊急，請直接寫信到條款頁上的客服信箱。' },
        429, { 'retry-after': String(retryAfter) }
      )
    }

    /* 連按兩下的去重。手機上送出後網路一卡，第一個反應就是再按一次 ——
       而客服佇列上兩則一模一樣的訊息只會浪費一次人工。
       工單那條走的是 idempotency-key，這裡不能：那需要呼叫端會存 key，
       而這張表單的使用者可能連 localStorage 都沒有（無痕、剛裝的瀏覽器）。
       所以改用內容指紋 + 5 分鐘窗，並且**回 200 與原本那一筆的編號**，
       讓重送看起來就是成功 —— 回 409 會讓人以為第一次沒送出去。 */
    const dupSince = Date.now() - 5 * 60_000
    const [dup] = await sql<{ id: string }[]>`
      select id from contact_messages
       where ip_hash = ${ipHash} and fingerprint = ${fp} and created_at > ${dupSince}
       order by created_at desc limit 1
    `
    if (dup) return c.json({ ok: true, id: String(dup.id), duplicate: true })
  }

  /* 已登入就記下來。**這一步失敗不能讓整支失敗** —— optionalUserId 讀的是
     token，而 token 有問題的人正是最需要這張表單的人。 */
  const userId = await optionalUserId(c).catch(() => null)

  const id = newId()
  const now = Date.now()
  await sql`
    insert into contact_messages
      (id, topic, name, email, body, user_id, ip_hash, fingerprint, status, created_at)
    values
      (${id}, ${topic}, ${name}, ${email}, ${body}, ${userId}, ${ipHash},
       ${ipHash ? fp : null}, 'new', ${now})
  `

  /* 通知客服。**內文不進通知**：站內通知會顯示在後台的鈴鐺上，
     而那一段文字會被複製到通知資料表裡 —— 個資多存一份就多一個
     要一起刪、一起管保存期限的地方。只講「有一則新的、去哪裡看」。
     失敗不能讓送出失敗：訊息已經寫進資料庫了，佇列上就看得到，
     少一則通知只是客服晚一點發現。 */
  await notifyStaff(`contact:${id}`, '新的聯絡訊息',
    `有人從公開的聯絡表單送出一則訊息（${TOPIC_LABEL[topic]}）。`, '/admin/contact')
    .catch(() => {})

  return c.json({ ok: true, id })
})

/* ------------------------------------------------------------------ 後台 */

contactAdmin.use('*', requireAuth)
contactAdmin.use('*', async (c: Context, next: Next) => {
  const [u] = await sql`select role from users where id = ${c.get('userId')}`
  if (u?.role !== 'admin') return c.json({ error: 'NOT_PLATFORM', message: '需要管理員權限' }, 403)
  await next()
})

const toRow = (r: Record<string, unknown>) => ({
  id: String(r.id),
  topic: String(r.topic),
  name: String(r.name),
  email: String(r.email),
  body: String(r.body),
  /* 已登入者送的訊息才有這兩欄。匿名是常態，客服要一眼看得出差別 ——
     「這個人有帳號」跟「這個人進不來」是兩種完全不同的處理方式。 */
  userId: r.user_id == null ? null : String(r.user_id),
  userName: r.user_name == null ? null : String(r.user_name),
  userMemberNo: r.user_member_no == null ? null : String(r.user_member_no),
  status: String(r.status),
  createdAt: Number(r.created_at),
  handledAt: r.handled_at == null ? null : Number(r.handled_at),
  handledByName: r.handled_by_name == null ? null : String(r.handled_by_name),
  handledNote: r.handled_note == null ? null : String(r.handled_note)
})

const ListQuery = PageQuery.extend({ scope: z.enum(['new', 'all']).default('new') })

/**
 * GET /v1/admin/contact —— 佇列。
 *
 * 預設只回未處理的，而且**舊的排前面**（跟 024 的工單佇列同一條紀律：
 * 照新的排前面的話，一則沒有人想碰的訊息會被每一則新的擠下去，永遠等不到人）。
 * scope=all 時改成新的排前面 —— 那是「翻歷史」的模式，不是工作佇列。
 */
contactAdmin.get('/', async c => {
  const parsed = ListQuery.safeParse(c.req.query())
  if (!parsed.success) {
    return c.json({ error: 'BAD_REQUEST', message: '查詢參數不合法（limit 介於 1 到 100）' }, 400)
  }
  const { limit, cursor, scope } = parsed.data

  let after: [string, string] | null = null
  if (cursor) {
    const p = decodeCursor(cursor, 2)
    if (!p || !isNumeric(p[0]!)) return c.json({ error: 'BAD_CURSOR', message: '分頁游標不合法' }, 400)
    after = [p[0]!, p[1]!]
  }

  const rows = await sql`
    select m.*, coalesce(u.name, u.handle) as user_name, u.member_no as user_member_no,
           coalesce(h.name, h.handle) as handled_by_name
      from contact_messages m
      left join users u on u.id = m.user_id
      left join users h on h.id = m.handled_by
     where ${scope === 'new' ? sql`m.status = 'new'` : sql`true`}
       ${after
      ? scope === 'new'
        ? sql`and (m.created_at, m.id) > (${after[0]}::bigint, ${after[1]}::text)`
        : sql`and (m.created_at, m.id) < (${after[0]}::bigint, ${after[1]}::text)`
      : sql``}
     order by ${scope === 'new'
      ? sql`m.created_at asc, m.id asc`
      : sql`m.created_at desc, m.id desc`}
     limit ${limit + 1}
  `
  const page = slicePage(rows, limit, r => encodeCursor([String(r.created_at), String(r.id)]))
  const [n] = await sql<{ n: number }[]>`select count(*)::int as n from contact_messages where status = 'new'`
  return c.json({
    items: page.items.map(r => toRow(r as Record<string, unknown>)),
    nextCursor: page.nextCursor,
    /* 側欄的待辦數字。跟列表同一支回，客服處理完一則之後側欄會跟著減 ——
       另外開一支計數端點的話，兩邊遲早會不同步。 */
    pending: n?.n ?? 0
  })
})

/**
 * POST /v1/admin/contact/:id/handle —— 標記處理完成。
 *
 * 備註**必填**，跟工單結案理由同一條紀律：沒有紀錄的處理事後無法覆核，
 * 而這張表裡的每一列都是一個站外的人在等回音。
 * 這裡刻意沒有「回覆」動作 —— 平台沒有寄信服務，回覆實際發生在客服自己的
 * 信箱裡。在後台放一個看起來會寄信的按鈕，是在騙客服自己。
 */
const Handle = z.object({
  note: z.string().trim().min(2, '請寫下你做了什麼').max(500, '備註最多 500 個字')
})

contactAdmin.post('/:id/handle', async c => {
  const parsed = Handle.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? '參數不合法' }, 400)
  }
  const id = c.req.param('id') ?? ''
  /* 用 status = 'new' 當守衛而不是先讀再寫：兩個客服同時按時，
     第二個會更新到 0 列而不是覆蓋掉第一個人的備註。 */
  const rows = await sql`
    update contact_messages
       set status = 'handled', handled_at = ${Date.now()},
           handled_by = ${c.get('userId')}, handled_note = ${parsed.data.note}
     where id = ${id} and status = 'new'
    returning id
  `
  if (!rows.length) {
    const [exists] = await sql`select status from contact_messages where id = ${id}`
    if (!exists) return c.json({ error: 'NOT_FOUND', message: '找不到這則訊息' }, 404)
    return c.json({ error: 'ALREADY_HANDLED', message: '這則訊息已經有人處理過了' }, 409)
  }
  return c.json({ ok: true })
})

/* ------------------------------------------------------------------ 保存期限

   隱私權政策第四節必須答得出「留多久」，而編一個沒有人在執行的期限
   是最糟的做法。所以這裡真的實作：

     已處理的 —— 180 天後刪除。客服回完信之後，這一列的用途就只剩
                 「查得到當初講了什麼」，半年夠了。
     未處理的 —— **不刪**。還沒回覆就刪掉，等於把一個人的問題丟掉；
                 而且未處理的列會一直掛在後台佇列上，不會被忘記。

   掛在 index.ts 既有的五分鐘掃描上（跟 sweepAttempts 同一個位置）。
   它自己保證不 throw：一個「清舊資料」的功能不該有讓其他掃描陪葬的權力。 */
export const CONTACT_KEEP_DAYS = 180

export async function sweepContact(): Promise<number> {
  try {
    const cutoff = Date.now() - CONTACT_KEEP_DAYS * 24 * 60 * 60_000
    const rows = await sql`
      delete from contact_messages
       where status = 'handled' and handled_at is not null and handled_at < ${cutoff}
      returning id
    `
    return rows.length
  } catch {
    return 0
  }
}
