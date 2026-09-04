/**
 * Google 登入的迴歸測試（routes/google.ts）。
 *
 *   npx tsx src/regress-google.ts http://localhost:8071
 *
 * 這支自己起一台**假的 Google 授權伺服器**（/authorize、/token、/jwks），
 * 被測伺服器要用 `GOOGLE_OAUTH_ENDPOINT` 指向它。手法與 `R2_ENDPOINT`
 * 完全相同（見 r2.ts 開頭）：沒有一個可控的對手方，
 * 「state 一次性消耗、過期拒絕、重放拒絕」這幾條就只能靠讀程式碼相信 ——
 * 而這幾條正是 OAuth 唯一真正要驗的東西。
 *
 * 假伺服器持有自己的 RSA 金鑰並對外供 JWKS，所以**兩個行程之間不需要
 * 共用任何祕密**：被測伺服器就照正式流程去抓公鑰驗簽。這也順帶驗到了
 * 「RS256 + 遠端 JWKS」這條跟 LINE（HS256）不一樣的路真的通。
 *
 * 兩種模式，看 /status 自動決定：
 *   未設定憑證 → 只驗「整條路關閉且是 503 不是 500」（這是預設狀態，
 *                憑證還沒申請下來之前，站上就是長這樣）
 *   有假憑證   → 驗完整流程與四道防線
 *
 * ⚠️ 要有自己的乾淨資料庫（同其他 regress：各自 migrate + seed 一個新庫）。
 * 這支會寫 oauth_states / oauth_login_codes / users，而且最後一段會把
 * `oauth-start-ip:` 這個桶打到滿 —— 跟別支共用庫的話會讓對方莫名其妙被限流。
 *
 * 環境變數：
 *   FAKE_GOOGLE_PORT  假伺服器要聽哪個埠（必須跟被測伺服器的
 *                     GOOGLE_OAUTH_ENDPOINT 對得上）
 *   DATABASE_URL      跟被測伺服器同一個庫（有幾條要直接改資料庫造出
 *                     「過期」的狀態 —— 那是等不起的十分鐘）
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { sql } from './db.js'

const base = (process.argv[2] ?? 'http://localhost:8071').replace(/\/$/, '')
const fakePort = Number(process.env.FAKE_GOOGLE_PORT ?? 8099)
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? 'fake-client-id.apps.googleusercontent.com'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
let pass = 0, fail = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
const head = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 52 - s.length))}`)

/* 一律不自動跟隨轉址：這支測的東西幾乎全部是「轉去哪裡」，
   跟隨的話 Location 就看不到了，而且會真的去打 FRONTEND_URL。 */
const get = (p: string) => fetch(`${base}${p}`, { redirect: 'manual' })
const post = (p: string, b: unknown) =>
  fetch(`${base}${p}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(b)
  })

/* ── 假的 Google ──────────────────────────────────────────
   /authorize  記下這次的 nonce，發一組 code，302 回 redirect_uri
   /token      拿 code 換一張自己簽的 id_token
   /jwks       公鑰
   兩個「壞掉」的旋鈕，用 query 打開：
     bad=nonce  簽一個不對的 nonce（模擬 id_token 被搬到別的授權流程用）
     bad=aud    簽一個不對的 aud（模擬拿別家 app 的 token 來換） */
const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
const issuer = `http://localhost:${fakePort}`
type Pending = { nonce: string; bad: string | null; sub: string }
const codes = new Map<string, Pending>()

const fake = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', issuer)
  if (u.pathname === '/jwks') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ keys: [jwk] }))
    return
  }
  if (u.pathname === '/authorize') {
    const code = randomBytes(12).toString('hex')
    codes.set(code, {
      nonce: u.searchParams.get('nonce') ?? '',
      bad: u.searchParams.get('bad'),
      /* sub 可以被指定：綁定那幾條要模擬「另一個 Google 帳號」，
         而 sub 正是 Google 那邊的帳號身分 */
      sub: u.searchParams.get('sub') ?? 'google-sub-fixed-001'
    })
    const back = new URL(u.searchParams.get('redirect_uri')!)
    back.searchParams.set('code', code)
    back.searchParams.set('state', u.searchParams.get('state') ?? '')
    res.writeHead(302, { location: back.toString() })
    res.end()
    return
  }
  if (u.pathname === '/token') {
    const body = new URLSearchParams(await new Promise<string>(r => {
      let s = ''; req.on('data', c => (s += c)); req.on('end', () => r(s))
    }))
    const p = codes.get(body.get('code') ?? '')
    if (!p) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid_grant"}'); return }
    codes.delete(body.get('code')!)   // Google 的 code 也是一次性的，照做
    const id_token = await new SignJWT({
      nonce: p.bad === 'nonce' ? 'not-the-right-nonce' : p.nonce,
      name: '測試 Google 使用者'
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(p.bad === 'aud' ? 'someone-elses-client-id' : CLIENT_ID)
      .setSubject(p.sub)
      .setIssuedAt().setExpirationTime('5m')
      .sign(privateKey)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id_token, access_token: 'fake', token_type: 'Bearer' }))
    return
  }
  res.writeHead(404); res.end()
})
await new Promise<void>(r => fake.listen(fakePort, r))
console.log(`假 Google 起在 ${issuer}`)

/** 走一次 /authorize，拿到後端 callback 該收的 code。回傳 callback 的完整 query。 */
async function authorize(startLocation: string, bad?: 'nonce' | 'aud' | null, sub?: string) {
  const u = new URL(startLocation)
  if (bad) u.searchParams.set('bad', bad)
  if (sub) u.searchParams.set('sub', sub)
  const r = await fetch(u, { redirect: 'manual' })
  const loc = r.headers.get('location') ?? ''
  return new URL(loc).search   // ?code=…&state=…
}

const status = (await (await get('/v1/auth/google/status')).json()) as { configured: boolean }

if (!status.configured) {
  /* ---- 預設狀態：憑證還沒設 ----
     這一段才是今天實際部署上的樣子，所以它必須被驗，而且要驗到
     「503 而不是 500」：500 會被監控當成故障、被使用者當成壞掉，
     但這裡什麼都沒壞 —— 只是這台伺服器沒有這項功能。 */
  head('未設定 Google 憑證：整條路關閉')
  ck('/status 回 configured:false', status.configured === false)

  const s = await get('/v1/auth/google/start')
  ck('/start 回 503（不是 500、不是 302）', s.status === 503, `得到 ${s.status}`)
  ck('/start 的錯誤碼是 NOT_CONFIGURED', ((await s.json()) as Any).error === 'NOT_CONFIGURED')

  const cb = await get('/v1/auth/google/callback?code=x&state=y')
  ck('/callback 回 503', cb.status === 503, `得到 ${cb.status}`)

  const ex = await post('/v1/auth/google/exchange', { code: 'x'.repeat(43) })
  ck('/exchange 回 503', ex.status === 503, `得到 ${ex.status}`)

  const lk = await post('/v1/auth/google/link/start', {})
  ck('/link/start 未登入回 401（requireAuth 先擋）', lk.status === 401, `得到 ${lk.status}`)
} else {
  head('起始端點')
  const start = await get('/v1/auth/google/start')
  ck('/start 回 302', start.status === 302, `得到 ${start.status}`)
  const loc1 = start.headers.get('location') ?? ''
  const q1 = new URL(loc1).searchParams
  ck('導向假 Google 的 /authorize', loc1.startsWith(`${issuer}/authorize`), loc1.slice(0, 80))
  ck('帶 state', (q1.get('state') ?? '').length >= 24)
  ck('帶 nonce', (q1.get('nonce') ?? '').length >= 24)
  ck('client_id 正確', q1.get('client_id') === CLIENT_ID)
  ck('response_type=code', q1.get('response_type') === 'code')
  /* scope 一定要驗：多要一個 email 就多一整條「同 email 自動接管既有帳號」
     的攻擊面，而那條路在這個站特別危險（users.email 從來沒被驗證過）。 */
  ck('scope 只有 openid profile，沒有 email', q1.get('scope') === 'openid profile',
    q1.get('scope') ?? '(無)')
  ck('redirect_uri 指回自己的 callback', (q1.get('redirect_uri') ?? '').endsWith('/v1/auth/google/callback'))

  head('完整登入流程')
  const cbq = await authorize(loc1)
  const cb = await get(`/v1/auth/google/callback${cbq}`)
  ck('callback 回 302', cb.status === 302, `得到 ${cb.status}`)
  const cbLoc = cb.headers.get('location') ?? ''
  ck('導回前端 /login 並帶交換碼', /\/login#code=[^&]+&provider=google$/.test(cbLoc), cbLoc)
  ck('JWT 不在網址裡', !/token=/i.test(cbLoc))
  const loginCode = decodeURIComponent(/#code=([^&]+)/.exec(cbLoc)?.[1] ?? '')

  const ex = await post('/v1/auth/google/exchange', { code: loginCode })
  const exBody = (await ex.json()) as Any
  ck('exchange 回 200 且拿到 token', ex.status === 200 && typeof exBody.token === 'string')

  const me = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${exBody.token}` } })
  const meBody = (await me.json()) as Any
  ck('token 真的能用（/me 200）', me.status === 200, `得到 ${me.status}`)
  ck('新帳號沒有 email（我們沒要 email scope）', meBody?.user?.email === null,
    JSON.stringify(meBody?.user?.email))
  const firstUserId = meBody?.user?.id as string

  head('交換碼：一次性')
  const ex2 = await post('/v1/auth/google/exchange', { code: loginCode })
  ck('同一把交換碼再換一次回 401', ex2.status === 401, `得到 ${ex2.status}`)
  ck('錯誤碼是 LOGIN_CODE_INVALID', ((await ex2.json()) as Any).error === 'LOGIN_CODE_INVALID')

  head('交換碼：過期')
  {
    const start2 = await get('/v1/auth/google/start')
    const cb2 = await get(`/v1/auth/google/callback${await authorize(start2.headers.get('location')!)}`)
    const code2 = decodeURIComponent(/#code=([^&]+)/.exec(cb2.headers.get('location') ?? '')?.[1] ?? '')
    // 五分鐘等不起，直接把到期時間推到過去
    await sql`update oauth_login_codes set expires_at = now() - interval '1 minute'
              where expires_at > now()`
    const exOld = await post('/v1/auth/google/exchange', { code: code2 })
    ck('過期的交換碼回 401', exOld.status === 401, `得到 ${exOld.status}`)
  }

  head('同一個 Google 帳號登入第二次：不會再建一個人')
  {
    const s3 = await get('/v1/auth/google/start')
    const cb3 = await get(`/v1/auth/google/callback${await authorize(s3.headers.get('location')!)}`)
    const code3 = decodeURIComponent(/#code=([^&]+)/.exec(cb3.headers.get('location') ?? '')?.[1] ?? '')
    const ex3 = await post('/v1/auth/google/exchange', { code: code3 })
    const tok3 = ((await ex3.json()) as Any).token as string
    const me3 = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${tok3}` } })
    const id3 = ((await me3.json()) as Any)?.user?.id
    ck('回到同一個 userId', !!firstUserId && id3 === firstUserId, `${firstUserId} vs ${id3}`)
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from auth_identities where provider = 'google'
    `
    const n = rows[0]?.n
    ck('auth_identities 只有一列 google', n === '1', `有 ${n} 列`)
  }

  head('state：一次性消耗')
  {
    const s = await get('/v1/auth/google/start')
    const loc = s.headers.get('location')!
    const q = await authorize(loc)
    const first = await get(`/v1/auth/google/callback${q}`)
    ck('第一次通過', /#code=/.test(first.headers.get('location') ?? ''))
    /* 同一個 state 再打一次（重放）。code 換過都沒差 ——
       state 那一列已經被 DELETE ... RETURNING 消耗掉了。 */
    const again = await get(`/v1/auth/google/callback${await authorize(loc)}`)
    ck('同一個 state 重放被擋（google=state）',
      (again.headers.get('location') ?? '').includes('google=state'),
      again.headers.get('location') ?? '')
  }

  head('state：過期（10 分鐘）')
  {
    const s = await get('/v1/auth/google/start')
    const loc = s.headers.get('location')!
    const st = new URL(loc).searchParams.get('state')!
    // 等 10 分鐘不現實，直接把那一列的 created_at 推回去
    await sql`update oauth_states set created_at = now() - interval '11 minutes' where state = ${st}`
    const r = await get(`/v1/auth/google/callback${await authorize(loc)}`)
    ck('過期的 state 被擋（google=state）', (r.headers.get('location') ?? '').includes('google=state'),
      r.headers.get('location') ?? '')
  }

  head('state：不存在 / 缺參數 / 使用者取消')
  {
    const r1 = await get('/v1/auth/google/callback?code=abc&state=never-existed')
    ck('沒見過的 state 被擋', (r1.headers.get('location') ?? '').includes('google=state'))
    const r2 = await get('/v1/auth/google/callback?state=only-state')
    ck('缺 code 回 google=bad', (r2.headers.get('location') ?? '').includes('google=bad'))
    const r3 = await get('/v1/auth/google/callback?error=access_denied&state=x')
    ck('使用者取消回 google=denied', (r3.headers.get('location') ?? '').includes('google=denied'))
  }

  head('id_token：nonce 與 aud 都要驗')
  {
    const sN = await get('/v1/auth/google/start')
    const rN = await get(`/v1/auth/google/callback${await authorize(sN.headers.get('location')!, 'nonce')}`)
    ck('nonce 對不上被擋（google=verify）', (rN.headers.get('location') ?? '').includes('google=verify'),
      rN.headers.get('location') ?? '')

    const sA = await get('/v1/auth/google/start')
    const rA = await get(`/v1/auth/google/callback${await authorize(sA.headers.get('location')!, 'aud')}`)
    ck('aud 不是我們被擋（google=verify）', (rA.headers.get('location') ?? '').includes('google=verify'),
      rA.headers.get('location') ?? '')
  }

  head('exchange 的輸入驗證')
  {
    const r1 = await post('/v1/auth/google/exchange', { code: 'too-short' })
    ck('太短的 code 回 400', r1.status === 400, `得到 ${r1.status}`)
    const r2 = await post('/v1/auth/google/exchange', {})
    ck('沒有 code 回 400', r2.status === 400, `得到 ${r2.status}`)
  }

  head('綁定到既有帳號')
  {
    /* 綁定要有身分，用 dev-login（伺服器要 DEV_LOGIN=1 + DEV_LOGIN_SECRET）。
       這條路測的是「已經用密碼註冊的人補綁 Google」—— 也就是這次改版
       真正想把人導過去的那個動作。 */
    const devSecret = process.env.DEV_LOGIN_SECRET
    if (!devSecret) throw new Error('綁定測試需要 DEV_LOGIN_SECRET，請與被測伺服器設定相同的值')
    const devLogin = async (handle: string) => {
      const r = await fetch(`${base}/v1/auth/dev-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dev-login-secret': devSecret },
        body: JSON.stringify({ handle, name: handle })
      })
      return ((await r.json()) as Any).token as string
    }
    const linkStart = (tok: string) =>
      fetch(`${base}/v1/auth/google/link/start`, {
        method: 'POST', headers: { authorization: `Bearer ${tok}` }
      })

    const tokA = await devLogin('gbind-a')
    const rA = await linkStart(tokA)
    const urlA = ((await rA.json()) as Any).url as string
    ck('link/start 需要登入才給網址', rA.status === 200 && urlA.startsWith(`${issuer}/authorize`))
    ck('JWT 不在授權網址裡', !urlA.includes(tokA.slice(0, 20)))

    const cbA = await get(`/v1/auth/google/callback${await authorize(urlA, null, 'google-sub-link-001')}`)
    ck('綁定成功導回 /me?google=linked',
      (cbA.headers.get('location') ?? '').endsWith('/me?google=linked'), cbA.headers.get('location') ?? '')
    const mA = await fetch(`${base}/v1/auth/methods`, { headers: { authorization: `Bearer ${tokA}` } })
    ck('/methods 看得到 google', ((await mA.json()) as Any).providers.includes('google'))

    /* 同一個 Google 身分再去綁另一個帳號：**不能自動搬家**。
       搬家等於把兩個帳號的資料歸屬悄悄改掉，使用者不會預期，
       而且那是接管別人帳號最好用的一條路。 */
    const tokB = await devLogin('gbind-b')
    const urlB = ((await (await linkStart(tokB)).json()) as Any).url as string
    const cbB = await get(`/v1/auth/google/callback${await authorize(urlB, null, 'google-sub-link-001')}`)
    ck('已被綁走的 Google 不會改綁（/me?google=taken）',
      (cbB.headers.get('location') ?? '').endsWith('/me?google=taken'), cbB.headers.get('location') ?? '')
    const mB = await fetch(`${base}/v1/auth/methods`, { headers: { authorization: `Bearer ${tokB}` } })
    ck('另一個帳號沒有被接上 google', !((await mB.json()) as Any).providers.includes('google'))
  }

  /* 限流放最後：它會把這個 IP 的 `oauth-start-ip:` 桶打滿，
     之後任何 /start（含 LINE 的）都會 429。 */
  head('起始端點限流（跟 LINE 共用同一個桶）')
  {
    let blocked = 0, tries = 0
    for (let i = 0; i < 60 && blocked === 0; i++) {
      tries++
      const r = await get('/v1/auth/google/start')
      if (r.status === 429) {
        blocked = 429
        ck('429 有帶 Retry-After', !!r.headers.get('retry-after'), '沒有')
      }
    }
    ck('連打 /start 會被限流', blocked === 429, `打了 ${tries} 次都沒被擋`)
    const lineToo = await get('/v1/auth/line/start')
    /* LINE 沒設定時本來就 503（configured() 先擋），那條路上驗不到共用桶；
       有設定時就應該一起 429 —— 兩條路寫的是同一張表。 */
    ck('同一個桶：LINE 的 /start 也被擋（或本來就沒設定而 503）',
      lineToo.status === 429 || lineToo.status === 503, `得到 ${lineToo.status}`)
  }
}

console.log(`\n通過 ${pass}，失敗 ${fail}`)
fake.close()
await sql.end()
process.exit(fail ? 1 : 0)
