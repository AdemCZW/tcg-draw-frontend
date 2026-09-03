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

/**
 * 簽一張 token。
 *
 * `sv`（session version）是撤銷用的：驗證時會拿它跟 users.session_version 比對，
 * 對不上就當作已撤銷（見 requireAuth）。省略 sessionVersion 時自己去查 ——
 * 這樣既有的呼叫端（dev-login、LINE exchange）不用改就會帶到正確的版本；
 * 已經查過使用者的呼叫端（改密碼、登出所有裝置）則直接把新版本傳進來，
 * 省一次查詢，也避免「先更新再查」之間的競態拿到舊值。
 */
export async function issueToken(userId: string, sessionVersion?: number) {
  const sv = sessionVersion ?? (await currentSessionVersion(userId)) ?? 0
  return new SignJWT({ sub: userId, sv })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key)
}

/** 查某個使用者現在的 session 版本；帳號不存在回 null */
export async function currentSessionVersion(userId: string): Promise<number | null> {
  const [row] = await sql<{ session_version: number }[]>`
    select session_version from users where id = ${userId}
  `
  return row ? Number(row.session_version) : null
}

/**
 * 把某個使用者的 session 版本 +1：所有已簽發的 token 立刻失效。
 * 回傳新版本，呼叫端可以拿它重簽一張給「當前這台裝置」。
 *
 * 用 `+ 1` 在 SQL 裡做而不是先讀再寫：兩個並發的撤銷都會生效，
 * 不會有一邊覆蓋掉另一邊（那等於漏踢一次）。
 */
export async function bumpSessionVersion(userId: string): Promise<number> {
  const [row] = await sql<{ session_version: number }[]>`
    update users set session_version = session_version + 1
     where id = ${userId}
     returning session_version
  `
  if (!row) throw new Error(`bumpSessionVersion: 找不到使用者 ${userId}`)
  return Number(row.session_version)
}

/**
 * 驗簽名 + 比對 session 版本。通過回 userId，否則回 null。
 *
 * payload 沒有 `sv` 的是遷移之前簽出去的 token，視為第 0 版（見 033 遷移的說明）：
 * 那些人不會被這次遷移踢掉，但只要他們改一次密碼或按一次「登出所有裝置」，
 * 版本就會前進，那些舊 token 也就一併失效。
 */
async function verifyToken(token: string): Promise<string | null> {
  let sub: string
  let sv: number
  try {
    const { payload } = await jwtVerify(token, key)
    if (typeof payload.sub !== 'string' || !payload.sub) return null
    sub = payload.sub
    sv = typeof payload.sv === 'number' ? payload.sv : 0
  } catch {
    return null
  }
  /* 這一次查詢是這個機制的全部代價，而且不能省：
     快取會讓「登出所有裝置」延後生效，那正是這個功能唯一要保證的事。 */
  const current = await currentSessionVersion(sub)
  // 帳號被刪掉（current === null）也一律視為無效，不要讓 token 活過帳號
  if (current === null || current !== sv) return null
  return sub
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
  /* 這裡一樣要比對版本：這條路會決定「敏感檔案要不要給你看」，
     被撤銷的 token 不該還能換到本人待遇。 */
  return verifyToken(h.slice(7))
}

/** 需要登入的路由掛這個。沒帶或帶錯 token 一律 401，不透露細節 */
export async function requireAuth(c: Context, next: Next) {
  const h = c.req.header('authorization')
  if (!h?.startsWith('Bearer ')) return c.json({ error: 'UNAUTHORIZED', message: '請先登入' }, 401)
  const userId = await verifyToken(h.slice(7))
  if (!userId) return c.json({ error: 'UNAUTHORIZED', message: '登入已過期，請重新登入' }, 401)
  c.set('userId', userId)
  await next()
}
