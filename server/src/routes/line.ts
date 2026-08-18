/**
 * LINE Login（OAuth 2.0 authorization code）。
 *
 *   GET  /v1/auth/line/start     產生授權連結，帶 state 防 CSRF，302 到 LINE
 *   GET  /v1/auth/line/callback  拿 code 換 token → 驗 ID token 取 userId
 *                                → auth_identities 有就登入、沒有就建帳號 → 發 JWT → 導回前端
 *
 * 不申請 email 權限：LINE 的 userId 已足以識別使用者，email 那個要另外送審。
 * scope 只要 profile openid。
 *
 * state 存在資料庫不存記憶體 —— Railway 可能跑多個實例，start 跟 callback
 * 不一定落在同一台；而且重新部署後記憶體就沒了。
 */
import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { jwtVerify, createRemoteJWKSet } from 'jose'
import { env } from '../env.js'
import { sql } from '../db.js'
import { issueToken } from '../auth.js'

export const line = new Hono()

const AUTH = 'https://access.line.me/oauth2/v2.1/authorize'
const TOKEN = 'https://api.line.me/oauth2/v2.1/token'
const redirectUri = `${env.PUBLIC_URL}/v1/auth/line/callback`
const configured = () => !!env.LINE_CHANNEL_SECRET

/* LINE 的 ID token 是 HS256，key 就是 channel secret；不需要 JWKS。
   但保留 verify 的方式而不是自己解 base64 —— 要驗簽名、issuer、audience、過期，
   少一樣都等於沒驗。 */
const secretKey = () => new TextEncoder().encode(env.LINE_CHANNEL_SECRET)
void createRemoteJWKSet // 之後若 LINE 改用 RS256 再切過去

line.get('/start', async c => {
  if (!configured()) return c.json({ error: 'NOT_CONFIGURED', message: 'LINE 登入尚未設定' }, 503)
  const state = randomBytes(16).toString('hex')
  const nonce = randomBytes(16).toString('hex')
  await sql`insert into oauth_states (state, nonce, provider, created_at) values (${state}, ${nonce}, 'line', now())`
  const u = new URL(AUTH)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', env.LINE_CHANNEL_ID)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('state', state)
  u.searchParams.set('scope', 'profile openid')
  u.searchParams.set('nonce', nonce)
  return c.redirect(u.toString(), 302)
})

line.get('/callback', async c => {
  if (!configured()) return c.json({ error: 'NOT_CONFIGURED', message: 'LINE 登入尚未設定' }, 503)
  const code = c.req.query('code')
  const state = c.req.query('state')
  const back = (q: string) => c.redirect(`${env.FRONTEND_URL}/login?${q}`, 302)

  if (c.req.query('error')) return back('line=denied')
  if (!code || !state) return back('line=bad')

  // state 只能用一次，用完刪掉；超過 10 分鐘的當作沒有
  const [st] = await sql`
    delete from oauth_states where state = ${state} and provider = 'line'
      and created_at > now() - interval '10 minutes'
    returning nonce
  `
  if (!st) return back('line=state')

  const tokenRes = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: env.LINE_CHANNEL_ID, client_secret: env.LINE_CHANNEL_SECRET!
    })
  })
  if (!tokenRes.ok) {
    console.error('[line] token exchange failed', tokenRes.status, await tokenRes.text())
    return back('line=token')
  }
  const tok = (await tokenRes.json()) as { id_token?: string }
  if (!tok.id_token) return back('line=token')

  let sub: string, name: string, picture: string | undefined
  try {
    const { payload } = await jwtVerify(tok.id_token, secretKey(), {
      issuer: 'https://access.line.me',
      audience: env.LINE_CHANNEL_ID
    })
    if (payload.nonce !== st.nonce) throw new Error('nonce mismatch')
    sub = payload.sub!
    name = (payload.name as string) ?? 'LINE 使用者'
    picture = payload.picture as string | undefined
  } catch (e) {
    console.error('[line] id_token verify failed', e)
    return back('line=verify')
  }

  // 找既有綁定；沒有就建新帳號 + 綁定。整段在交易裡，避免同一個 LINE 帳號按兩次建出兩個使用者
  const userId = await sql.begin(async tx => {
    const [ex] = await tx`select user_id from auth_identities where provider = 'line' and provider_uid = ${sub} for update`
    if (ex) return ex.user_id as string
    const id = 'u-' + randomBytes(6).toString('hex')
    const handle = 'VD-' + randomBytes(2).toString('hex').toUpperCase()
    await tx`insert into users (id, handle, name) values (${id}, ${handle}, ${name})`
    await tx`insert into auth_identities (user_id, provider, provider_uid) values (${id}, 'line', ${sub})`
    return id
  })
  void picture  // 頭像之後接 files 再存

  const jwt = await issueToken(userId)
  // token 放 fragment 不放 query：fragment 不會進伺服器日誌、也不會被 Referer 帶走
  return c.redirect(`${env.FRONTEND_URL}/login#token=${jwt}`, 302)
})
