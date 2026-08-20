/**
 * 帳號。Email + 密碼，密碼用 node:crypto 的 scrypt（零額外相依）。
 * LINE Login 之後接 auth_identities。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { sql } from '../db.js'
import { issueToken, requireAuth } from '../auth.js'
import { bumpFail, checkLimit, clearFails, clientIp } from '../rate-limit.js'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>

async function hash(pw: string) {
  const salt = randomBytes(16)
  const key = await scrypt(pw, salt, 64)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}
async function verify(pw: string, stored: string) {
  const [alg, saltB64, keyB64] = stored.split('$')
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false
  const key = await scrypt(pw, Buffer.from(saltB64, 'base64'), 64)
  const expect = Buffer.from(keyB64, 'base64')
  return key.length === expect.length && timingSafeEqual(key, expect)
}

export const auth = new Hono()

const Register = z.object({
  email: z.string().email().max(120),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(32)
})
auth.post('/register', async c => {
  const parsed = Register.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '請確認 Email、密碼（至少 8 碼）與暱稱' }, 400)
  const { email, password, name } = parsed.data

  // 註冊只用 IP 當 key —— 防的是大量灌帳號，不是猜某個帳號的密碼
  const regKeys = [`ip:${clientIp(c)}`]
  const regLimit = await checkLimit(regKeys)
  if (regLimit.blocked) {
    return c.json(
      { error: 'TOO_MANY_ATTEMPTS', message: '操作過於頻繁，請稍後再試' },
      429, { 'retry-after': String(regLimit.retryAfter) }
    )
  }

  const id = 'u-' + randomBytes(6).toString('hex')
  /* 會員編號由序列產生（見 008_member_no.sql），handle 沿用它。
     原本 handle 是 randomBytes(2) 只有 65,536 種，而下面的 catch 把所有唯一鍵
     衝突都當成 email 重複 —— handle 撞號會讓一個 email 沒被註冊過的人
     收到「這個 Email 已經註冊過」，而且他自己無解。現在 handle 不可能撞，
     這個 catch 才真的只代表 email 重複。 */
  const memberRows = await sql<{ member_no: string }[]>`
    select member_no_of(nextval('member_seq')) as member_no
  `
  const memberNo = memberRows[0]!.member_no
  try {
    await sql`insert into users (id, handle, member_no, name, email, password_hash)
              values (${id}, ${memberNo}, ${memberNo}, ${name}, ${email.toLowerCase()}, ${await hash(password)})`
  } catch {
    // 唯一索引衝突：這個 email 已經註冊過。不透露更多
    await bumpFail(regKeys)
    return c.json({ error: 'EMAIL_TAKEN', message: '這個 Email 已經註冊過' }, 409)
  }
  return c.json({ token: await issueToken(id), userId: id, handle: memberNo, memberNo })
})

const Login = z.object({ email: z.string().email(), password: z.string().min(1) })
auth.post('/login', async c => {
  const parsed = Login.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
  const email = parsed.data.email.toLowerCase()

  /* 同時用 email 與 IP 當 key。只擋 email 的話，攻擊者拿同一台機器
     對大量帳號各試一兩個常見密碼就完全繞過去了。 */
  const keys = [`email:${email}`, `ip:${clientIp(c)}`]
  const limit = await checkLimit(keys)
  if (limit.blocked) {
    return c.json(
      { error: 'TOO_MANY_ATTEMPTS', message: `嘗試次數過多，請於 ${Math.ceil(limit.retryAfter / 60)} 分鐘後再試` },
      429, { 'retry-after': String(limit.retryAfter) }
    )
  }

  const [u] = await sql`select id, password_hash from users where email = ${email}`
  // 帳號不存在跟密碼錯回同一句：不要讓人拿這個端點探測誰有帳號
  if (!u?.password_hash || !(await verify(parsed.data.password, u.password_hash as string))) {
    await bumpFail(keys)
    return c.json({ error: 'BAD_CREDENTIALS', message: 'Email 或密碼不正確' }, 401)
  }
  // 成功就清零，正常使用者打錯幾次不會被自己的紀錄拖累
  await clearFails(keys)
  return c.json({ token: await issueToken(u.id as string), userId: u.id })
})

/* ---- 補上 Email 登入方式 ----
   給用 LINE 註冊、之後想多一種登入方式的人。
   資料完全不動——email 跟密碼是掛在既有的 user 上，
   抽卡紀錄、點數、訂單都還在同一個 user id 底下。 */
const SetPassword = z.object({
  email: z.string().email().max(120),
  password: z.string().min(8).max(200),
  /* 帳號已經有密碼時必填。沒有密碼的帳號（例如純 LINE 註冊）留空即可——
     這種帳號的「證明你是本人」靠的是你手上這張已登入的 token。 */
  currentPassword: z.string().max(200).optional()
})
auth.post('/set-password', requireAuth, async c => {
  const me = c.get('userId')
  const parsed = SetPassword.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'BAD_REQUEST', message: '請確認 Email 與密碼（至少 8 碼）' }, 400)
  }
  const { email, password, currentPassword } = parsed.data
  const lower = email.toLowerCase()

  const [u] = await sql`select id, password_hash from users where id = ${me}`
  if (!u) return c.json({ error: 'UNAUTHORIZED', message: '帳號不存在' }, 401)

  // 已經有密碼就要先驗舊的，否則等於 token 被偷就能直接改掉登入方式
  if (u.password_hash) {
    if (!currentPassword || !(await verify(currentPassword, u.password_hash as string))) {
      return c.json({ error: 'BAD_CREDENTIALS', message: '目前的密碼不正確' }, 401)
    }
  }

  const [taken] = await sql`select id from users where email = ${lower} and id <> ${me}`
  if (taken) {
    /* 這個 email 已經是別人的帳號。
       不自動合併兩個帳號——那會牽涉到點數、訂單、獎品要怎麼併，
       而且一旦併錯無法還原。要合併必須是明確、可預期的流程，不是這裡的副作用。 */
    return c.json({ error: 'EMAIL_TAKEN', message: '這個 Email 已經被其他帳號使用' }, 409)
  }

  await sql`update users set email = ${lower}, password_hash = ${await hash(password)} where id = ${me}`
  return c.json({ ok: true, email: lower })
})

/** 這個帳號現在有哪些登入方式 */
auth.get('/methods', requireAuth, async c => {
  const me = c.get('userId')
  const [u] = await sql`select email, password_hash is not null as has_password from users where id = ${me}`
  const ids = await sql<{ provider: string }[]>`
    select provider from auth_identities where user_id = ${me}
  `
  return c.json({
    email: u?.email ?? null,
    hasPassword: !!u?.has_password,
    providers: ids.map(r => r.provider)
  })
})

/* ---- 會員基本資料 ----
   全部欄位都可以留空：註冊當下不該逼人填完，要出貨時再要求補齊。
   驗證只擋明顯不合理的值，不做嚴格的格式限制——
   台灣地址、手機的寫法太多變體，擋太細只會讓正常使用者填不過。 */
const Profile = z.object({
  displayName: z.string().trim().max(20).optional(),
  realName: z.string().trim().max(40).optional(),
  phone: z.string().trim().max(20).optional(),
  addressZip: z.string().trim().max(10).optional(),
  addressCity: z.string().trim().max(40).optional(),
  addressLine1: z.string().trim().max(120).optional(),
  // 生日只收 YYYY-MM-DD。未滿 18 的判斷之後會用到這個欄位
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal(''))
})

const emptyToNull = (v: string | undefined) => (v === undefined || v === '' ? null : v)

auth.get('/profile', requireAuth, async c => {
  const [u] = await sql`
    select handle, member_no, name, display_name, real_name, phone,
           address_zip, address_city, address_line1,
           to_char(birthday, 'YYYY-MM-DD') as birthday
    from users where id = ${c.get('userId')}
  `
  if (!u) return c.json({ error: 'UNAUTHORIZED', message: '帳號不存在' }, 401)
  return c.json({ profile: {
    handle: u.handle, memberNo: u.member_no, name: u.name,
    displayName: u.display_name, realName: u.real_name, phone: u.phone,
    addressZip: u.address_zip, addressCity: u.address_city, addressLine1: u.address_line1,
    birthday: u.birthday
  } })
})

auth.put('/profile', requireAuth, async c => {
  const me = c.get('userId')
  const parsed = Profile.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? '資料格式不正確' }, 400)
  }
  const p = parsed.data

  if (p.birthday) {
    const d = new Date(p.birthday)
    const now = new Date()
    if (isNaN(d.getTime()) || d > now || d.getFullYear() < 1900) {
      return c.json({ error: 'BAD_REQUEST', message: '生日日期不正確' }, 400)
    }
  }

  /* display_name 同時寫進 users.name —— name 是全站顯示用的欄位
     （得獎動態、賣家名稱、訂單上的買賣雙方都讀它），
     如果只更新 display_name 會出現「改了暱稱但別的地方沒變」。 */
  const display = emptyToNull(p.displayName)
  await sql`
    update users set
      display_name = ${display},
      name = coalesce(${display}, name),
      real_name = ${emptyToNull(p.realName)},
      phone = ${emptyToNull(p.phone)},
      address_zip = ${emptyToNull(p.addressZip)},
      address_city = ${emptyToNull(p.addressCity)},
      address_line1 = ${emptyToNull(p.addressLine1)},
      birthday = ${p.birthday ? p.birthday : null}::date,
      profile_updated_at = now()
    where id = ${me}
  `
  return c.json({ ok: true })
})

auth.get('/me', requireAuth, async c => {
  const [u] = await sql`select id, handle, member_no, name, email, role from users where id = ${c.get('userId')}`
  if (!u) return c.json({ error: 'UNAUTHORIZED', message: '帳號不存在' }, 401)
  const [s] = await sql`select id, tier, origin from sellers where id = ${u.id}`
  return c.json({ user: u, seller: s ?? null })
})
