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

export const sellers = new Hono()
sellers.use('*', requireAuth)

/** 我的賣家狀態。沒申請過回 null，前端用它決定要顯示申請表還是開池表 */
sellers.get('/me', async c => {
  const [s] = await sql`
    select id, handle, name, origin, tier, bio, joined_at from sellers where id = ${c.get('userId')}
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
  return c.json(r)
})
