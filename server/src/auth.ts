/**
 * 驗證。
 *
 * 目前是「給 handle 就發 token」的開發用登入，跟前端現在的 MOCK 行為一致。
 * 真正的註冊登入（密碼雜湊 / OAuth / 手機驗證）還沒做 ——
 * 這件事必須在開放註冊之前補上，不是可選項。
 */
import { SignJWT, jwtVerify } from 'jose'
import type { Context, Next } from 'hono'
import { env } from './env.js'
import { sql } from './db.js'

const key = new TextEncoder().encode(env.JWT_SECRET)

export async function issueToken(userId: string) {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key)
}

export async function ensureUser(handle: string, name: string) {
  const id = 'u-' + handle.toLowerCase()
  /* 這條路是 dev-login 與 seed 用的，handle 刻意是寫死的測試名稱（buyer / seller
     / platform），不要換成會員編號 —— 煙霧測試靠這些名字認帳號。
     但會員編號還是要有，否則後台查不到這些帳號。 */
  await sql`
    insert into users (id, handle, member_no, name)
    values (${id}, ${handle}, member_no_of(nextval('member_seq')), ${name})
    on conflict (handle) do nothing
  `
  return id
}

declare module 'hono' {
  interface ContextVariableMap { userId: string }
}

/** 不強制登入，但如果帶了合法 token 就取出 userId。
    用在「大部分人不用登入，但登入的話有差別待遇」的端點（例如檔案讀取：
    公開圖片誰都能看，但敏感檔案要看登入的人是不是本人）。 */
export async function optionalUserId(c: Context): Promise<string | null> {
  const h = c.req.header('authorization')
  if (!h?.startsWith('Bearer ')) return null
  try {
    const { payload } = await jwtVerify(h.slice(7), key)
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

/** 需要登入的路由掛這個。沒帶或帶錯 token 一律 401，不透露細節 */
export async function requireAuth(c: Context, next: Next) {
  const h = c.req.header('authorization')
  if (!h?.startsWith('Bearer ')) return c.json({ error: 'UNAUTHORIZED', message: '請先登入' }, 401)
  try {
    const { payload } = await jwtVerify(h.slice(7), key)
    if (!payload.sub) throw new Error('no sub')
    c.set('userId', payload.sub)
  } catch {
    return c.json({ error: 'UNAUTHORIZED', message: '登入已過期，請重新登入' }, 401)
  }
  await next()
}
