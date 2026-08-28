/**
 * 客服工單：使用者端。全部要登入。
 *
 * 這條路原本整段不存在，而缺它的後果寫在 migration 024 的檔頭：023 之後
 * 「一個鑑定編號全站只能登記一次」是資料庫層的硬約束，被擋下來的人會看到
 * 「如果這張卡是你的而且已經不在別處，請聯絡客服」—— 而客服沒有任何工具
 * 可以處理，使用者也沒有任何地方可以講。
 *
 * 客服端（含結案時要順帶做的事）在 routes/admin.ts，商業邏輯在 src/tickets.ts。
 *
 * 驗證的順序在這個檔案裡是固定的，跟 orders.ts 同一套紀律：
 *   1 zod 擋形狀
 *   2 **在交易外面**驗附件與關聯（持有人、用途、編號登記狀況）
 *   3 交易只做寫入
 * 第 2 步刻意不放進交易：交易裡要擋下來只能用 throw，那會穿出去變成 500 ——
 * 把使用者的輸入錯誤講成伺服器故障（security-audit L-4）。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { notify } from '../notify.js'
import { PageQuery, decodeCursor, encodeCursor, isNumeric, slicePage } from '../pagination.js'
import {
  LIVE_STATUSES, USER_KINDS,
  insertTicket, loadMessages, loadTicket, normCert, normGrader,
  notifyStaff, ownsFiles, summaryCols, summaryJoin, toSummary
} from '../tickets.js'

export const tickets = new Hono()
tickets.use('*', requireAuth)

const bad = (c: import('hono').Context, msg: string, code = 'BAD_REQUEST') =>
  c.json({ error: code, message: msg }, 400)

/** 附件：格式先擋一層，持有人與用途另外驗（見 tickets.ts 的 ownsFiles）。
    上限 5 個跟出貨照同一個數字 —— 沒有理由讓工單比爭議證據更寬。 */
const FileIds = z.array(z.string().regex(/^f-[0-9a-f]{12}$/, '附件必須是站內上傳的檔案'))
  .max(5, '一則訊息最多 5 個附件').default([])

const CreateBody = z.object({
  /* order-dispute / seller-doc 不在這個列舉裡：那兩種只能由系統在既有流程
     成功之後自動開（合約第五節）。讓使用者自己開得了的話，佇列上會出現
     一張沒有對應訂單／送件的「爭議單」，而客服結案時要呼叫的既有邏輯
     根本沒有東西可以呼叫。 */
  kind: z.enum(USER_KINDS),
  subject: z.string().trim().min(1, '請填主旨').max(60, '主旨最多 60 個字'),
  body: z.string().trim().min(1, '請描述你遇到的問題').max(2000, '說明最多 2000 個字'),
  fileIds: FileIds,
  /* 下面幾欄依 kind 而定，其餘一律忽略（不是報錯）——
     前端一份表單送所有欄位是常態，多送不該變成失敗。 */
  certNo: z.string().trim().max(32).optional(),
  grader: z.string().trim().max(16).optional(),
  prizeId: z.string().trim().max(64).optional()
})

/** POST /v1/tickets —— 開單 */
tickets.post('/', async c => {
  const me = c.get('userId')
  const parsed = CreateBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    /* kind 打錯要講得出「哪幾種可以開」，不然使用者（或前端）只會看到
       一句「參數不合法」，而真正該做的是換一個類型或走既有流程。 */
    const msg = issue?.path[0] === 'kind'
      ? '這個類型不能自己開單。可以開的是：接管、卡片問題、帳號問題、其他；訂單爭議與賣家審核由系統自動開單。'
      : issue?.message ?? '參數不合法'
    return bad(c, msg)
  }
  const { kind, subject, body, fileIds } = parsed.data

  if (!(await ownsFiles(fileIds, me))) {
    return bad(c, '附件必須是你自己在站內上傳的檔案（用途要是工單附件）', 'BAD_ATTACHMENT')
  }

  let grader: string | null = null
  let certNo: string | null = null
  let prizeId: string | null = null

  if (kind === 'takeover') {
    grader = normGrader(parsed.data.grader)
    certNo = normCert(parsed.data.certNo)
    if (!grader || !certNo) return bad(c, '接管申請要填鑑定公司與鑑定編號')

    /* 「那個編號必須真的已經登記給**別人**了」。
       這兩個分支不是龜毛，是把使用者送到對的地方：
         沒登記過   → 他其實可以直接把卡上傳到卡冊，開單只會多等一天
         在他名下   → 他要的東西已經在手上了，開單解決不了他真正的問題
       這裡是**建議性**的檢查（在交易外面、也擋不住併發）：真正的把關在
       結案時的 applyTakeover，那一段會 FOR UPDATE 鎖住卡片重新判一次。 */
    const [holder] = await sql`
      select user_id, status from prizes
       where grader is not distinct from ${grader}::text and cert_no = ${certNo}
       order by acquired_at desc limit 1
    `
    if (!holder) {
      return bad(c,
        '這個鑑定編號目前沒有登記在系統裡，不需要申請接管 —— 你可以直接把這張卡上傳到自己的卡冊。',
        'CERT_NOT_REGISTERED')
    }
    if (String(holder.user_id) === me) {
      return bad(c,
        '這個鑑定編號已經登記在你自己名下了，不需要申請接管。如果卡片狀態不對，請改開「卡片有問題」。',
        'CERT_ALREADY_YOURS')
    }

    /* 同一個人對同一個編號同時只能有一張未結案的接管單。
       024 沒有替這一條建部分唯一索引（只有 order_id 有），所以擋不住併發 ——
       代價是佇列上多一張重複的單，沒有金額或擁有權的後果（過戶只發生在
       結案，而結案會鎖卡片、第二次會撞上「已經在申請人名下」）。 */
    const [dupe] = await sql`
      select id from tickets
       where user_id = ${me} and kind = 'takeover'
         and grader is not distinct from ${grader}::text and cert_no = ${certNo}
         and status = any(${[...LIVE_STATUSES]})
    `
    if (dupe) {
      return c.json({
        error: 'TICKET_EXISTS',
        message: `你已經有一張這個編號的接管申請正在處理中（單號 ${String(dupe.id)}），請直接在那張單裡補充說明。`
      }, 409)
    }
  }

  if (kind === 'card-issue' && parsed.data.prizeId) {
    /* 關聯的卡片要驗**是不是你的**。格式驗證擋不住拿別人的 prize id ——
       那個 id 在公開的最近開出動態裡就看得到，而客服會照著這一欄去查卡。 */
    const [pz] = await sql`select id from prizes where id = ${parsed.data.prizeId} and user_id = ${me}`
    if (!pz) return bad(c, '這張卡不在你的卡冊裡', 'BAD_PRIZE')
    prizeId = String(pz.id)
  }

  const id = await sql.begin(tx => insertTicket(tx, {
    userId: me, kind, subject, body, fileIds, grader, certNo, prizeId
  }))

  await notifyStaff('ticket:' + id, '有新的客服工單', `${subject}`, '/admin/tickets/' + id)

  const t = await loadTicket(id, 'user')
  // certHolder 在使用者端一律不回：那是別人的身分（合約第三節）
  return c.json({ ticket: t?.detail }, 201)
})

const ListQuery = PageQuery.extend({
  status: z.enum(['open', 'pending-user', 'resolved', 'rejected']).optional()
})

/** GET /v1/tickets —— 我的單。新的排前面（跟卡冊、通知同一個方向） */
tickets.get('/', async c => {
  const me = c.get('userId')
  const parsed = ListQuery.safeParse(c.req.query())
  if (!parsed.success) {
    return c.json({ error: 'BAD_REQUEST', message: '分頁參數不合法（limit 介於 1 到 100）' }, 400)
  }
  const { limit, cursor, status } = parsed.data

  let after: [string, string] | null = null
  if (cursor) {
    const p = decodeCursor(cursor, 2)
    if (!p || !isNumeric(p[0]!)) return c.json({ error: 'BAD_CURSOR', message: '分頁游標不合法' }, 400)
    after = [p[0]!, p[1]!]
  }

  const rows = await sql`
    select t.*, ${summaryCols(sql)}
      from tickets t
      ${summaryJoin(sql)}
     where t.user_id = ${me}
       ${status ? sql`and t.status = ${status}` : sql``}
       ${after ? sql`and (t.created_at, t.id) < (${after[0]}::bigint, ${after[1]}::text)` : sql``}
     order by t.created_at desc, t.id desc
     limit ${limit + 1}
  `
  const page = slicePage(rows, limit, r => encodeCursor([String(r.created_at), String(r.id)]))
  return c.json({
    items: page.items.map(r => toSummary(r as Record<string, unknown>, 'user')),
    nextCursor: page.nextCursor
  })
})

/**
 * GET /v1/tickets/:id —— 一張單（含訊息串）。
 *
 * 別人的單一律回 404 而不是 403：403 等於承認「這張單存在」，
 * 而單號是可以一個一個試的。管理員走 /v1/admin/tickets/:id。
 */
tickets.get('/:id', async c => {
  const me = c.get('userId')
  const t = await loadTicket(c.req.param('id') ?? '', 'user')
  if (!t || String(t.row.user_id) !== me) {
    return c.json({ error: 'NOT_FOUND', message: '找不到這張工單' }, 404)
  }
  return c.json({ ticket: t.detail })
})

const ReplyBody = z.object({
  body: z.string().trim().min(1, '請輸入內容').max(2000, '每則訊息最多 2000 個字'),
  fileIds: FileIds
})

/** POST /v1/tickets/:id/messages —— 回覆 */
tickets.post('/:id/messages', async c => {
  const me = c.get('userId')
  const id = c.req.param('id') ?? ''
  const parsed = ReplyBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return bad(c, parsed.error.issues[0]?.message ?? '參數不合法')
  const { body, fileIds } = parsed.data

  if (!(await ownsFiles(fileIds, me))) {
    return bad(c, '附件必須是你自己在站內上傳的檔案（用途要是工單附件）', 'BAD_ATTACHMENT')
  }

  const r = await sql.begin(async tx => {
    const [t] = await tx`select * from tickets where id = ${id} for update`
    // 存在但不是你的：跟讀取同一個判斷，一律 404
    if (!t || String(t.user_id) !== me) {
      return { error: 'NOT_FOUND', message: '找不到這張工單', status: 404 }
    }
    if (t.status === 'resolved' || t.status === 'rejected') {
      return {
        error: 'TICKET_CLOSED',
        message: '這張工單已經結案，不能再回覆。如果問題還沒解決，請開一張新的工單並附上這張的單號。',
        status: 409
      }
    }
    const now = Date.now()
    const [m] = await tx`
      insert into ticket_messages (ticket_id, author_id, body, file_ids, is_staff, created_at)
      values (${id}, ${me}, ${body}, ${fileIds as never}, false, ${now})
      returning id
    `
    /* 使用者回覆會把 pending-user 推回 open —— 球回到客服手上。
       updated_at 一定要跟著動：客服佇列與使用者列表都靠它排「誰在等最久」，
       不動的話一張被追問三次的單看起來還是三天前那樣安靜。 */
    await tx`
      update tickets set status = case when status = 'pending-user' then 'open' else status end,
                         updated_at = ${now}
       where id = ${id}
    `
    return { messageId: Number(m?.id ?? 0), assigneeId: t.assignee_id as string | null }
  })
  if ('error' in r) return c.json(r, r.status as 404 | 409)

  /* 通知客服。已經有人認領就只通知那個人（不然每次回覆都吵全部管理員），
     還沒認領才進佇列廣播。失敗只記 log —— 訊息本身已經寫進去了。 */
  const link = '/admin/tickets/' + id
  const ref = `ticket:${id}:msg:${r.messageId}`
  if (r.assigneeId) {
    await notify({
      userId: r.assigneeId, kind: 'system',
      title: '工單有新回覆', body: '你認領的工單有新的回覆。', link, refId: ref
    }).catch(e => console.error('[ticket] 通知寫入失敗，主流程繼續:', (e as Error).message))
  } else {
    await notifyStaff(ref, '工單有新回覆', '一張還沒有人認領的工單有新的回覆。', link)
  }

  const messages = await loadMessages(id)
  return c.json({ message: messages[messages.length - 1] })
})
