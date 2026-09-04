/**
 * Google Login（OAuth 2.0 authorization code + OpenID Connect）。
 *
 *   GET  /v1/auth/google/status    這台伺服器有沒有設定 Google 登入（前端據此決定顯不顯示按鈕）
 *   GET  /v1/auth/google/start     產生授權連結，帶 state 防 CSRF，302 到 Google
 *   POST /v1/auth/google/link/start 已登入者要把 Google 綁到現有帳號（JWT 走 header，不進 URL）
 *   GET  /v1/auth/google/callback  拿 code 換 token → 驗 ID token 取 sub
 *                                  → auth_identities 有就登入、沒有就建帳號 → 導回前端
 *   POST /v1/auth/google/exchange  用一次性交換碼換 JWT
 *
 * 這支刻意跟 routes/line.ts 長得幾乎一樣：state 一次性消耗、10 分鐘期限、
 * 共用 oauth_states、共用 oauth_login_codes 交換碼、共用 `oauth-start-ip:` 限流桶、
 * 起始端點順手清過期列。**不抽共用函式**是因為 line.ts 不歸這條線動；
 * 等兩邊都穩定之後再合併成一支 oauth.ts 才是對的順序（現在合併＝改動一條
 * 已經上線且驗過的登入路徑，風險不對等）。
 *
 * 跟 LINE 的三個真正差別：
 *   1 ID token 是 RS256，公鑰要去 Google 的 JWKS 取（LINE 是 HS256，key 就是 secret）
 *   2 issuer 有兩個合法值（accounts.google.com 與 https://accounts.google.com），
 *     Google 自己兩種都發過，只認一個會在某些帳號上莫名其妙失敗
 *   3 **不要 email scope**，只要 `openid profile`。
 *     理由不是懶：拿了 email 就會有人想「同一個 email 就自動接到既有帳號上」，
 *     而這個站的 users.email 從來沒有驗證過 —— 任何人都能先用別人的 email
 *     註冊一組密碼帳號等在那裡，等真正的擁有者用 Google 登入時直接接管
 *     （pre-account hijacking）。不收 email 就沒有這條路可走，
 *     而且 users.email 是 unique，硬寫進去還會在撞號時變成 500。
 *     要把 Google 接到既有帳號，只有一條路：本人登入後自己按「綁定」。
 *
 * 憑證沒設時（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 缺任一）整條路關閉，
 * 每個端點回 503 NOT_CONFIGURED —— 跟 r2.ts 的 configured()、files.ts 的
 * notReady() 同一個模式。不是 500：沒設定是部署狀態，不是錯誤。
 */
import { Hono } from 'hono'
import { createHash, randomBytes } from 'node:crypto'
import { jwtVerify, createRemoteJWKSet } from 'jose'
import { z } from 'zod'
import { env } from '../env.js'
import { sql } from '../db.js'
import { issueToken, requireAuth } from '../auth.js'
import { bumpAttempt, checkLimit, clientIp } from '../rate-limit.js'
import type { Context } from 'hono'

export const google = new Hono()

/* 測試用端點覆寫。刻意直接讀 process.env 而不進 env.ts 的 schema，
   跟 r2.ts 的 `R2_ENDPOINT` 同一個理由與同一個手法：它不是部署要填的東西，
   沒填就是正式行為。有它才驗得到「state 一次性消耗、過期拒絕、重放拒絕」——
   那幾條在沒有一個可控的授權伺服器時只能靠讀程式碼相信。 */
const endpointOverride = process.env.GOOGLE_OAUTH_ENDPOINT?.replace(/\/$/, '') || null

const AUTH = endpointOverride ? `${endpointOverride}/authorize` : 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = endpointOverride ? `${endpointOverride}/token` : 'https://oauth2.googleapis.com/token'
const JWKS_URL = endpointOverride ? `${endpointOverride}/jwks` : 'https://www.googleapis.com/oauth2/v3/certs'
/* Google 兩種 iss 都發過，兩種都認。假伺服器則以它自己的 base 當 iss。 */
const ISSUERS = endpointOverride ? [endpointOverride] : ['https://accounts.google.com', 'accounts.google.com']

const redirectUri = `${env.PUBLIC_URL}/v1/auth/google/callback`

/** 兩個都要有才算設定完成：只有 client id 沒有 secret，換 token 一定失敗。 */
export const configured = () => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)

const codeHash = (code: string) => createHash('sha256').update(code).digest('hex')

/* JWKS 要快取（createRemoteJWKSet 自己會做），但不能在模組載入時就建 ——
   沒設定 Google 的部署根本不該碰到這個網址。第一次用到才建。 */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
const keySet = () => (jwks ??= createRemoteJWKSet(new URL(JWKS_URL)))

/** 把登入／綁定意圖寫進一次性 OAuth state，再組 Google 授權網址。 */
async function authorizationUrl(linkUserId: string | null) {
  const state = randomBytes(16).toString('hex')
  const nonce = randomBytes(16).toString('hex')
  await sql`insert into oauth_states (state, nonce, provider, user_id, created_at)
            values (${state}, ${nonce}, 'google', ${linkUserId}, now())`
  const u = new URL(AUTH)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('state', state)
  /* 只要 openid profile。email 不要 —— 見檔頭第 3 點。 */
  u.searchParams.set('scope', 'openid profile')
  u.searchParams.set('nonce', nonce)
  /* 這個站不需要 refresh token（登入完就發自己的 JWT，之後不再代表使用者
     去呼叫 Google），所以不要 access_type=offline。少拿一樣東西就少一樣要保管的。
     prompt=select_account：共用電腦上不預設沿用上一個人的 Google 帳號。 */
  u.searchParams.set('prompt', 'select_account')
  return u.toString()
}

/* ── 起始端點的速率限制與過期清理 ────────────────────────────
   跟 LINE 共用 `oauth-start-ip:` 這個桶，而且**必須共用**：
   這個桶算的是「oauth_states 這張表長多快」，不是「哪一家登入被試了幾次」。
   分成兩個桶的話，同一個人打兩條路就能把表灌成兩倍，限制等於被繞過。
   反過來，被擋住時兩條社群登入一起擋住也是對的 —— 它們寫的是同一張表。 */
let lastStateSweep = 0
const STATE_SWEEP_EVERY_MS = 60_000
function sweepOauthStatesSoon() {
  const now = Date.now()
  if (now - lastStateSweep < STATE_SWEEP_EVERY_MS) return
  lastStateSweep = now
  /* 不 await：清理是維護工作，不該讓使用者的登入多等一個 DELETE。
     失敗只是下一分鐘再清一次，所以 catch 掉不讓它變成 unhandled rejection。
     跟 line.ts 那份是同一段（節流狀態各自一份沒關係：清理是冪等的，
     最壞情況只是一分鐘內多跑一次 DELETE）。 */
  void sql`delete from oauth_states where created_at < now() - interval '1 hour'`
    .catch(e => console.error('[google] 清理過期 oauth_states 失敗', e))
  void sql`delete from oauth_login_codes where expires_at < now() - interval '1 hour'`
    .catch(e => console.error('[google] 清理過期 oauth_login_codes 失敗', e))
}

/** 起始端點共用的 IP 限流。擋下來回 429 + Retry-After。 */
async function startLimited(c: Context): Promise<Response | null> {
  const keys = [`oauth-start-ip:${clientIp(c)}`]
  const limit = await checkLimit(keys)
  if (limit.blocked) {
    return c.json(
      { error: 'TOO_MANY_REQUESTS',
        message: `Google 登入的嘗試太頻繁了，請於 ${Math.max(1, Math.ceil(limit.retryAfter / 60))} 分鐘後再試。` },
      429, { 'retry-after': String(limit.retryAfter) }
    )
  }
  // 成功也計數：算的是「發出了幾個 state」，不是「失敗了幾次」
  await bumpAttempt(keys)
  return null
}

const notConfigured = (c: Context) =>
  c.json({ error: 'NOT_CONFIGURED', message: 'Google 登入尚未設定' }, 503)

/* 前端要問「這台伺服器能不能用 Google 登入」。
   沒有這條的話前端只能永遠畫出按鈕，讓使用者按下去撞 503 ——
   一顆按了會壞的按鈕比沒有按鈕更傷信任。
   回的是布林，不是憑證內容：client id 雖然是公開值，但沒有理由多吐一份出去。 */
google.get('/status', c => c.json({ configured: configured() }))

/* 一般 Google 登入不需要身份，直接導向 Google。 */
google.get('/start', async c => {
  if (!configured()) return notConfigured(c)
  const blocked = await startLimited(c)
  if (blocked) return blocked
  sweepOauthStatesSoon()
  return c.redirect(await authorizationUrl(null), 302)
})

/* 綁定必須用 Authorization header 識別既有帳號。JWT 絕不能放進 URL query，
   因為 query 會進代理與伺服器日誌。前端取得 URL 後才整頁導向 Google。 */
google.post('/link/start', requireAuth, async c => {
  if (!configured()) return notConfigured(c)
  const blocked = await startLimited(c)
  if (blocked) return blocked
  sweepOauthStatesSoon()
  return c.json({ url: await authorizationUrl(c.get('userId')) })
})

google.get('/callback', async c => {
  if (!configured()) return notConfigured(c)
  const code = c.req.query('code')
  const state = c.req.query('state')
  const back = (q: string) => c.redirect(`${env.FRONTEND_URL}/login?${q}`, 302)

  if (c.req.query('error')) return back('google=denied')
  if (!code || !state) return back('google=bad')

  /* state 只能用一次，用完刪掉；超過 10 分鐘的當作沒有。
     DELETE ... RETURNING 是重點：判斷與消耗在同一個原子操作裡，
     兩個並發的重放只會有一個拿到那一列。 */
  const [st] = await sql`
    delete from oauth_states where state = ${state} and provider = 'google'
      and created_at > now() - interval '10 minutes'
    returning nonce, user_id
  `
  if (!st) return back('google=state')

  const tokenRes = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!
    })
  })
  if (!tokenRes.ok) {
    /* 回應內文可能帶著使用者可識別的資訊，只記狀態碼與 Google 的錯誤代碼。
       整包 body 不進 log。 */
    console.error('[google] token exchange failed', tokenRes.status)
    return back('google=token')
  }
  const tok = (await tokenRes.json().catch(() => null)) as { id_token?: string } | null
  if (!tok?.id_token) return back('google=token')

  let sub: string, name: string
  try {
    const { payload } = await jwtVerify(tok.id_token, keySet(), {
      issuer: ISSUERS,
      audience: env.GOOGLE_CLIENT_ID
    })
    /* nonce 綁定這一次授權與我們發出去的那個 state。少了它，
       別處攔到的一張合法 id_token 就能拿來當作這次登入的答案。 */
    if (payload.nonce !== st.nonce) throw new Error('nonce mismatch')
    if (!payload.sub) throw new Error('no sub')
    sub = payload.sub
    /* name 是 profile scope 給的顯示名稱，不是 email。
       沒有就給一個中性的預設值 —— 這只是畫面上的稱呼，之後可以自己改。 */
    name = (payload.name as string | undefined)?.slice(0, 40) || 'Google 使用者'
  } catch (e) {
    /* 只記錯誤訊息本身，不記 id_token（裡面有使用者資料）。 */
    console.error('[google] id_token verify failed', e instanceof Error ? e.message : e)
    return back('google=verify')
  }

  const linkTo = (st.user_id as string | null) ?? null

  /* 綁定模式：把這個 Google 身分接到指定的既有帳號上。
     已經綁在別的帳號時不自動搬 —— 那等於把兩個帳號的資料歸屬悄悄改掉。
     跟 LINE 同一條規則、同一組回前端的參數名。 */
  if (linkTo) {
    const conflict = await sql.begin(async tx => {
      const [ex] = await tx`
        select user_id from auth_identities
        where provider = 'google' and provider_uid = ${sub} for update
      `
      if (ex && ex.user_id !== linkTo) return 'other'
      if (ex) return 'already'
      await tx`insert into auth_identities (user_id, provider, provider_uid)
               values (${linkTo}, 'google', ${sub})`
      return null
    })
    if (conflict === 'other') return c.redirect(`${env.FRONTEND_URL}/me?google=taken`, 302)
    return c.redirect(`${env.FRONTEND_URL}/me?google=linked`, 302)
  }

  /* 一般登入：找既有綁定；沒有就建新帳號 + 綁定。
     整段在交易裡，避免同一個 Google 帳號連按兩次建出兩個使用者。 */
  const userId = await sql.begin(async tx => {
    const [ex] = await tx`select user_id from auth_identities where provider = 'google' and provider_uid = ${sub} for update`
    if (ex) return ex.user_id as string
    const id = 'u-' + randomBytes(6).toString('hex')
    /* 會員編號由序列產生，結構上不可能撞號（008_member_no.sql）。
       handle 直接沿用它，跟 LINE 那條一致。 */
    const rows = await tx<{ member_no: string }[]>`
      select member_no_of(nextval('member_seq')) as member_no
    `
    const memberNo = rows[0]!.member_no
    await tx`insert into users (id, handle, member_no, name)
             values (${id}, ${memberNo}, ${memberNo}, ${name})`
    await tx`insert into auth_identities (user_id, provider, provider_uid) values (${id}, 'google', ${sub})`
    return id
  })

  /* 不把 JWT 放進 URL：fragment 雖然不進 Referer，仍可能被瀏覽器歷史或擴充套件
     讀到。回傳一把高熵、五分鐘有效且只能消耗一次的交換碼；資料庫只留雜湊。
     `provider=google` 讓前端知道要打哪一條 exchange —— 交換碼本身
     不分家（同一張 oauth_login_codes），但端點分家比較好讀，也讓
     日後要對某一家做特別處理時不必回頭拆。 */
  const loginCode = randomBytes(32).toString('base64url')
  await sql`
    insert into oauth_login_codes (code_hash, user_id, expires_at)
    values (${codeHash(loginCode)}, ${userId}, now() + interval '5 minutes')
  `
  return c.redirect(
    `${env.FRONTEND_URL}/login#code=${encodeURIComponent(loginCode)}&provider=google`, 302
  )
})

const ExchangeBody = z.object({ code: z.string().min(40).max(64) })

/** 用 callback 的一次性 code 換 JWT。DELETE ... RETURNING 讓並發重放只有一個成功。 */
google.post('/exchange', async c => {
  if (!configured()) return notConfigured(c)
  const parsed = ExchangeBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '登入交換碼不合法' }, 400)

  const [row] = await sql`
    delete from oauth_login_codes
     where code_hash = ${codeHash(parsed.data.code)} and expires_at > now()
     returning user_id
  `
  if (!row) return c.json({ error: 'LOGIN_CODE_INVALID', message: '登入連結已失效，請重新使用 Google 登入' }, 401)
  return c.json({ token: await issueToken(String(row.user_id)) })
})
