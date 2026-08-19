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
  const handle = 'VD-' + randomBytes(2).toString('hex').toUpperCase()
  try {
    await sql`insert into users (id, handle, name, email, password_hash)
              values (${id}, ${handle}, ${name}, ${email.toLowerCase()}, ${await hash(password)})`
  } catch {
    // 唯一索引衝突：這個 email 已經註冊過。不透露更多
    await bumpFail(regKeys)
    return c.json({ error: 'EMAIL_TAKEN', message: '這個 Email 已經註冊過' }, 409)
  }
  return c.json({ token: await issueToken(id), userId: id, handle })
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

auth.get('/me', requireAuth, async c => {
  const [u] = await sql`select id, handle, name, email, role from users where id = ${c.get('userId')}`
  if (!u) return c.json({ error: 'UNAUTHORIZED', message: '帳號不存在' }, 401)
  const [s] = await sql`select id, tier, origin from sellers where id = ${u.id}`
  return c.json({ user: u, seller: s ?? null })
})
