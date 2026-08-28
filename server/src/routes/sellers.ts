/**
 * 賣家申請與狀態查詢。
 *
 * 這條路原本整段不存在：POST /v1/pools 會回 NOT_SELLER「請先申請成為賣家」，
 * 但沒有任何地方可以申請 —— sellers 資料列只有 seed 產得出來。
 * 使用者按了「我要開池」只會撞到一個叫他去做一件做不到的事的錯誤訊息。
 *
 * 申請後 tier = 'pending'，pools.ts 會擋住開池直到管理員在後台審核通過。
 * 證件文件是選填：個人賣家小額開池不強制驗證身分，但沒驗證的停在 pending，
 * 要驗證過才動得了 —— 門檻放在「能不能開池」而不是「能不能申請」。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { notify } from '../notify.js'
import { walletOf } from '../money.js'
import { markShipped, sweepSettlements, toSettlement } from '../pool-settlement.js'
import { validateTracking } from '../shared/escrow.js'
import { openSellerDocTicket } from '../tickets.js'

export const sellers = new Hono()
sellers.use('*', requireAuth)

/** 我的賣家狀態。沒申請過回 null，前端用它決定要顯示申請表還是開池表 */
sellers.get('/me', async c => {
  const [s] = await sql`
    /* default_count（逾期未出貨的次數）要給賣家自己看得到 ——
       它會直接決定「還能不能開新池」，看不到的話賣家只會在建池時
       撞到一個沒有預警的 403 */
    select id, handle, name, origin, tier, bio, joined_at, default_count
      from sellers where id = ${c.get('userId')}
  `
  if (!s) return c.json({ seller: null })
  const [v] = await sql`
    select status, note from seller_verifications
    where seller_id = ${s.id} order by created_at desc limit 1
  `
  return c.json({ seller: s, verification: v ?? null })
})

const Apply = z.object({
  /** 店名／賣家顯示名稱。會出現在池卡與訂單上，所以要求比暱稱嚴一點 */
  name: z.string().trim().min(2, '賣家名稱至少 2 個字').max(30),
  origin: z.enum(['merchant', 'personal']),
  bio: z.string().trim().max(200).default(''),
  /** 證件檔案 id（走 /v1/files/presign 的 seller-doc 用途）。選填 */
  docFileId: z.string().optional()
})

sellers.post('/apply', async c => {
  const me = c.get('userId')
  const parsed = Apply.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? '參數不合法' }, 400)
  }
  const { name, origin, bio, docFileId } = parsed.data

  const r = await sql.begin(async tx => {
    const [exists] = await tx`select tier from sellers where id = ${me} for update`
    if (exists) {
      // 重送申請不該變成錯誤 —— 使用者可能只是想補件。已經是賣家就補文件、不動等級
      if (docFileId) {
        const [f] = await tx`select owner_id, purpose from files where id = ${docFileId}`
        if (!f || f.owner_id !== me || f.purpose !== 'seller-doc') {
          return { error: 'BAD_REQUEST', message: '證件檔案不存在或不屬於你', status: 400 }
        }
        await tx`insert into seller_verifications (seller_id, doc_file_id) values (${me}, ${docFileId})`
      }
      return { seller: { id: me, tier: exists.tier }, already: true }
    }

    /* handle 從使用者的 handle 借過來。sellers.handle 有 unique 約束，
       而 users.handle 本來就唯一，所以不會撞 —— 不另外發一組代號是為了讓
       同一個人在買家與賣家兩個身分下看起來是同一個人。 */
    const [u] = await tx`select handle from users where id = ${me}`
    if (!u) return { error: 'NOT_FOUND', message: '找不到使用者', status: 404 }

    await tx`
      insert into sellers (id, handle, name, origin, tier, bio)
      values (${me}, ${u.handle}, ${name}, ${origin}, 'pending', ${bio})
    `
    if (docFileId) {
      const [f] = await tx`select owner_id, purpose from files where id = ${docFileId}`
      if (!f || f.owner_id !== me || f.purpose !== 'seller-doc') {
        return { error: 'BAD_REQUEST', message: '證件檔案不存在或不屬於你', status: 400 }
      }
      await tx`insert into seller_verifications (seller_id, doc_file_id) values (${me}, ${docFileId})`
    }

    await notify({
      userId: me, kind: 'system',
      title: '賣家申請已送出',
      body: '審核通過後就可以開池。通常一個工作天內會有結果。',
      link: '/seller/new', refId: 'seller-apply:' + me
    }, tx)
    return { seller: { id: me, tier: 'pending' }, already: false }
  })
  if ('error' in r) return c.json(r, r.status as 400 | 404)

  /* 送審文件成功之後補開一張客服工單（合約第五節）。**這個端點的行為沒有變**：
     seller_verifications 那一列才是審核的權威狀態，既有的
     /v1/admin/verifications 也還照樣看得到它。工單只是讓這件事跟其他
     需要人介入的事排在同一個佇列裡，並且讓賣家有地方補件與問進度。

     只有真的有送件（docFileId）才開單 —— 沒送件的申請沒有東西可以審。
     開單失敗不會讓申請失敗（openSellerDocTicket 自己吞掉例外只記 log）。 */
  if (docFileId) await openSellerDocTicket(me, docFileId)
  return c.json(r)
})

/* ---------------- 抽卡池的結算 ---------------- */

/**
 * 賣家的結算清單 + 保留額。
 *
 * 這條路原本整段不存在，而缺它的後果是賣家看不到自己的錢：票金貸記給賣家
 * 之後是**保留額** —— 看得到、動不了 —— 但如果連「看得到」都沒有介面，
 * 賣家只會看到錢包裡多了一筆不能用的數字，不知道它為什麼被扣著、什麼時候放。
 *
 * 讀取時順手把時限補算到現在，理由跟訂單那邊一樣（「拉」不是「推」）。
 */
sellers.get('/settlements', async c => {
  const me = c.get('userId')
  await sql.begin(tx => sweepSettlements(tx, me)).catch(() => {})
  const rows = await sql`
    select st.*, p.card, p.status as prize_status, pl.title as pool_title,
           b.name as buyer_name, b.member_no as buyer_member_no,
           /* 「票金入帳了，但這張卡你還沒寄」（F-5）。
              少了這個旗標，賣家在清單上只會看到「已入帳」，
              而那正是他最不會再點開的一列 —— 但它其實還欠著一張卡。 */
           (st.status = 'released' and st.ship_due_at is not null
            and st.shipped_at is null) as owes_card
      from pool_settlements st
      join prizes p on p.id = st.prize_id
      join pools  pl on pl.id = st.pool_id
      /* 買家的名字要一起帶出來：這條清單的用途是「我現在要寄哪幾張、寄給誰」，
         只給 buyer_id 的話賣家看到的是一串內部鍵，對不上任何一張出貨單。
         只取 name 與會員編號 —— 收件地址在 shipments 那張表，不屬於結算列。 */
      /* 接在 prizes 那一列的**當下擁有者**上，不是 st.buyer_id。
         卡在市場轉手之後 buyer_id 是前一個主人 —— 賣家照著它寄，
         包裹會寄錯人。要寄給誰是「這張卡現在是誰的」，不是「誰抽中的」。 */
      join users  b on b.id = p.user_id
     where st.seller_id = ${me}
     order by st.created_at desc limit 200
  `
  return c.json({
    settlements: rows,
    wallet: await walletOf(me),
    serverTime: Date.now()
  })
})

const ShipOne = z.object({
  /* 單號選填：這一段是抽卡池的實體交付，賣家直接寄給買家（平台不代管實體卡，
     見 docs/HANDOFF.md 4.2），所以單號是給買家追蹤用的憑據，不是放款條件。
     驗證沿用託管訂單那一套 —— 同一個平台不該有兩種單號規則。 */
  tracking: z.string().min(4).max(32).optional(),
  carrier: z.enum(['post', 'tcat', 'seven', 'family', 'hilife', 'shopee', 'other']).optional()
})

/**
 * 賣家出貨：awaiting_ship → shipped，鑑賞期開始跑。
 *
 * 出貨之後**不是立刻放款**：買家確認收貨或 7 天鑑賞期滿才釋放那一筆。
 * 逐筆，不等整池抽完。
 */
sellers.post('/settlements/:id/ship', async c => {
  const me = c.get('userId')
  const parsed = ShipOne.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
  const { tracking, carrier } = parsed.data
  if (tracking) {
    const v = validateTracking(carrier ?? 'other', tracking)
    if (!v.ok) return c.json({ error: 'BAD_TRACKING', message: v.reason ?? '單號格式不正確' }, 400)
  }

  const r = await sql.begin(async tx => {
    /* 帶 owner_id 出來：出貨通知要發給**卡現在的主人**。
       發給 buyer_id 的話，卡在市場轉手之後，通知會寄給早就把卡賣掉的人，
       而真正在等包裹的新主人什麼都收不到。

       鎖序照全站紀律：**先鎖 prizes、再鎖結算列**（V-1）。
       這支的 markShipped 會 update prizes，而掃描與確認收貨都是卡先鎖 ——
       這裡反向的話兩邊就可能互相等。先無鎖讀出 prize_id，照序上鎖，
       再帶條件重讀：無鎖讀到的那一列可能已經被別人改掉，鎖後那次才算數。 */
    const peekRows = await tx`
      select prize_id from pool_settlements
       where id = ${c.req.param('id') ?? ''} and seller_id = ${me}
    `
    if (!peekRows.length) return { error: 'NOT_FOUND', message: '找不到這筆結算', status: 404 }
    await tx`select id from prizes where id = ${peekRows[0]!.prize_id as string} for update`
    const [row] = await tx`
      select st.*, pz.user_id as owner_id
        from pool_settlements st join prizes pz on pz.id = st.prize_id
       where st.id = ${c.req.param('id') ?? ''} and st.seller_id = ${me} for update of st
    `
    if (!row) return { error: 'NOT_FOUND', message: '找不到這筆結算', status: 404 }
    const s = toSettlement(row as Record<string, unknown>)
    /* 兩種都可以出貨：
       - awaiting_ship：正常路徑，票金還在保留額裡等鑑賞期
       - released 且還掛著 ship_due_at：寄存確認期滿之後買家才申請出貨（F-5）。
         票金已經結算了，但實體卡還沒交 —— 義務還在，只是逾期的手段
         從退款變成違約紀錄。
       原本這裡只收前者，於是後者的賣家**想寄也寄不了**（一律 409），
       買家的卡就永遠停在 ship_requested。那是一條死路，不是保護。 */
    const owesCard = s.status === 'released' && s.shipDueAt != null && s.shippedAt == null
    if (s.status !== 'awaiting_ship' && !owesCard) {
      return { error: 'WRONG_STATE', message: '這筆目前不是等待出貨的狀態', status: 409 }
    }
    await markShipped(tx, [s.prizeId], Date.now())
    await notify({
      userId: s.ownerId, kind: 'shipment',
      title: '賣家已出貨',
      body: tracking ? `單號 ${tracking}。收到卡片後請確認收貨，或 7 天後自動結案。` : '收到卡片後請確認收貨，或 7 天後自動結案。',
      link: '/cards', refId: 'pool-ship:' + s.id
    }, tx)
    return { ok: true }
  })
  if ('error' in r) return c.json(r, r.status as 404 | 409)
  return c.json(r)
})
