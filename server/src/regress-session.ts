/**
 * A-1 第一階段的迴歸測試：JWT 撤銷（users.session_version）。
 *
 * 這一支存在的理由只有一條：**token 外流之後，改密碼要能把它趕走。**
 * 原本 JWT 固定 30 天有效、驗證只看簽名與到期，改密碼對已簽出去的 token
 * 完全沒有作用。下面第 2 組就是這條 —— 它沒過就等於這個功能沒做。
 *
 * 另外一半同樣重要：**不該踢人的日常操作不能把人踢掉。**
 * 一個「太會撤銷」的實作（例如每次登入都遞增版本）在第 2 組也會綠，
 * 但會讓使用者每換一台裝置就把另一台登出。第 4 組驗的是這個反向。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   createdb vd_session
 *   DATABASE_URL=postgres://$(whoami)@localhost:5432/vd_session \
 *   JWT_SECRET=<至少 32 個字元> npx tsx src/migrate.ts
 *   DATABASE_URL=... JWT_SECRET=... npx tsx src/seed.ts
 *   DATABASE_URL=... JWT_SECRET=... PORT=8071 DEV_LOGIN=1 DEV_LOGIN_SECRET=<至少 32 字元> npx tsx src/index.ts
 *   DATABASE_URL=... DEV_LOGIN_SECRET=<同一個值> npx tsx src/regress-session.ts http://localhost:8071
 *
 * ⚠️ 要有自己的乾淨資料庫，理由跟其他 regress-* 一樣（見 regress-pledge.ts 的說明）。
 * 這支只開自己的帳號、不消耗籤位，但**註冊限流是一天 5 次/IP**，而它要用掉 3 個
 * （只有「需要用密碼登入」的情境才註冊，其餘都走 dev-login）。同一個庫要再跑一次的話
 * 先 `delete from login_attempts;`，或換一個新庫。
 */
const base = (process.argv[2] ?? 'http://localhost:8071').replace(/\/$/, '')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
let pass = 0, fail = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
const head = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 52 - s.length))}`)

const rnd = Math.random().toString(36).slice(2, 8)
const call = (t: string | null, p: string, b?: unknown, method?: string) =>
  fetch(`${base}${p}`, {
    method: method ?? (b === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
    ...(b === undefined ? {} : { body: JSON.stringify(b) })
  })

async function register(tag: string) {
  const email = `sess-${tag}-${rnd}@example.com`
  const r = await call(null, '/v1/auth/register', { email, password: 'passw0rd-1', name: `測試 ${tag}` })
  if (!r.ok) throw new Error(`register ${tag}: ${r.status} ${await r.text()}`)
  const j = (await r.json()) as Any
  return { email, password: 'passw0rd-1', token: j.token as string, userId: j.userId as string }
}
async function login(email: string, password: string) {
  const r = await call(null, '/v1/auth/login', { email, password })
  if (!r.ok) throw new Error(`login: ${r.status} ${await r.text()}`)
  return ((await r.json()) as Any).token as string
}
/* 不需要密碼的情境一律走 dev-login：註冊有一天 5 次/IP 的限流，
   而這支要開的帳號比 5 個多。dev-login 走的是同一條 issueToken，
   對「token 帶不帶得到正確版本」的驗證力完全一樣。 */
const devSecret = process.env.DEV_LOGIN_SECRET
async function devLogin(tag: string) {
  if (!devSecret) throw new Error('regress-session 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')
  const r = await fetch(`${base}/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-login-secret': devSecret },
    body: JSON.stringify({ handle: `sess-${rnd}-${tag}`, name: `測試 ${tag}` })
  })
  if (!r.ok) throw new Error(`dev-login ${tag}: ${r.status} ${await r.text()}`)
  return ((await r.json()) as Any).token as string
}

/** 受保護端點：只要 401 就代表 token 已經不算數 */
const meStatus = async (t: string) => (await call(t, '/v1/auth/me')).status

// ── 1 基本：新簽的 token 可用 ────────────────────────────────────────
head('1 基本')
const a = await register('a')
ck('註冊拿到的 token 可以打受保護端點', (await meStatus(a.token)) === 200)
ck('亂改過的 token 打不進去', (await meStatus(a.token.slice(0, -2) + 'xx')) === 401)

/* 遷移之前簽出去的 token 沒有 `sv` 這個欄位。033 的決定是把它們當第 0 版
   （不要因為一次遷移把全站踢下線），這一組就是在釘住那個決定 ——
   同時釘住它的另一半：那些舊 token 一旦遇到版本遞增就會跟著失效。 */
const legacySecret = process.env.JWT_SECRET
if (legacySecret) {
  const { SignJWT } = await import('jose')
  const key = new TextEncoder().encode(legacySecret)
  const legacyUser = await devLogin('legacy')
  const legacyId = ((await (await call(legacyUser, '/v1/auth/me')).json()) as Any).user.id as string
  const noSv = await new SignJWT({ sub: legacyId })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('30d').sign(key)
  ck('沒有 sv 欄位的舊 token 仍可用（遷移不踢人）', (await meStatus(noSv)) === 200)
  await call(legacyUser, '/v1/auth/logout-all', { keepCurrent: false })
  ck('版本遞增之後，那張舊 token 也失效', (await meStatus(noSv)) === 401)
} else {
  console.log('  skip 舊 token 相容性（沒有給 JWT_SECRET）')
}

// ── 2 核心：改密碼之後，舊 token 必須 401 ───────────────────────────
head('2 改密碼撤銷舊 token（核心）')
const tokenA = a.token
ck('改密碼前 token A 有效', (await meStatus(tokenA)) === 200)
const chg = await call(tokenA, '/v1/auth/set-password', {
  email: a.email, password: 'passw0rd-2', currentPassword: a.password
})
ck('改密碼成功', chg.status === 200, String(chg.status))
const chgBody = (await chg.json()) as Any
const statusAfter = await meStatus(tokenA)
ck('★ 改密碼後 token A 打受保護端點回 401', statusAfter === 401, `實際 ${statusAfter}`)
ck('改密碼回應帶了新 token（當前裝置留著）', typeof chgBody.token === 'string')
ck('新 token 立刻可用', (await meStatus(chgBody.token)) === 200)
ck('舊密碼登不進去了', (await call(null, '/v1/auth/login', { email: a.email, password: 'passw0rd-1' })).status === 401)
a.password = 'passw0rd-2'

// ── 3 登出所有裝置 ──────────────────────────────────────────────────
head('3 登出所有裝置')
const b = await register('b')
const three = [b.token, await login(b.email, b.password), await login(b.email, b.password)]
ck('三張 token 一開始都有效', (await Promise.all(three.map(meStatus))).every(s => s === 200))
const lo = await call(three[0]!, '/v1/auth/logout-all', {})
const loBody = (await lo.json()) as Any
ck('logout-all 回 200', lo.status === 200, String(lo.status))
const afterLogout = await Promise.all(three.map(meStatus))
ck('★ 三張舊 token 全部 401', afterLogout.every(s => s === 401), afterLogout.join(','))
ck('回傳的新 token 可用（呼叫的人自己留著）', (await meStatus(loBody.token)) === 200)

// keepCurrent: false —— 連自己也一起登出，不回新 token
const c2 = { token: await devLogin('c') }
const lo2 = await call(c2.token, '/v1/auth/logout-all', { keepCurrent: false })
const lo2Body = (await lo2.json()) as Any
ck('keepCurrent:false 不回新 token', lo2.status === 200 && lo2Body.token === undefined)
ck('keepCurrent:false 之後自己的 token 也 401', (await meStatus(c2.token)) === 401)

// ── 4 反向：不該踢人的操作不能把人踢掉 ──────────────────────────────
head('4 日常操作不會讓 token 失效')
const d = await register('d')
const paths = ['/v1/auth/me', '/v1/auth/methods', '/v1/auth/profile', '/v1/wallet/balance', '/v1/cardbook', '/v1/prizes']
for (const p of paths) {
  const s = (await call(d.token, p)).status
  ck(`GET ${p} 不是 401`, s !== 401, `實際 ${s}`)
}
// 在別的裝置登入，不該影響原本那張
const dOther = await login(d.email, d.password)
ck('另一台裝置登入之後，原本的 token 仍有效', (await meStatus(d.token)) === 200)
ck('新登入的 token 也有效', (await meStatus(dOther)) === 200)
// 改個人資料（沒有換憑證）不該遞增版本
ck('更新 profile 回 200', (await call(d.token, '/v1/auth/profile', { displayName: '新暱稱' }, 'PUT')).status === 200)
ck('更新 profile 之後 token 仍有效', (await meStatus(d.token)) === 200)
ck('更新 profile 之後另一台也還在', (await meStatus(dOther)) === 200)

// ── 5 並發：同一張 token 同時打十個請求 ─────────────────────────────
head('5 並發')
const eTok = await devLogin('e')
const many = await Promise.all(Array.from({ length: 10 }, () => meStatus(eTok)))
ck('十個並發請求全部 200', many.every(s => s === 200), many.join(','))
// 撤銷的那一刻併發：不論誰先，結果只能是「舊的全 401、新的全 200」
const fOld = await devLogin('f')
const loF = await call(fOld, '/v1/auth/logout-all', {})
const fNew = ((await loF.json()) as Any).token as string
const mixed = await Promise.all([
  ...Array.from({ length: 5 }, () => meStatus(fOld)),
  ...Array.from({ length: 5 }, () => meStatus(fNew))
])
ck('撤銷後：舊 token 五個都 401', mixed.slice(0, 5).every(s => s === 401), mixed.slice(0, 5).join(','))
ck('撤銷後：新 token 五個都 200', mixed.slice(5).every(s => s === 200), mixed.slice(5).join(','))

// ── 6 每請求成本：多出來的那一次查詢值多少 ──────────────────────────
head('6 requireAuth 成本')
const gTok = await devLogin('g')
const warm = 20, runs = 200
for (let i = 0; i < warm; i++) await meStatus(gTok)
const took: number[] = []
for (let i = 0; i < runs; i++) {
  const t0 = performance.now()
  await meStatus(gTok)
  took.push(performance.now() - t0)
}
took.sort((x, y) => x - y)
const q = (p: number) => took[Math.min(took.length - 1, Math.floor(took.length * p))]!.toFixed(2)
console.log(`  /v1/auth/me（含 requireAuth 的版本查詢）: p50 ${q(0.5)}ms  p95 ${q(0.95)}ms  p99 ${q(0.99)}ms  n=${runs}`)
// 對照組：不經過 requireAuth 的端點，扣掉它就是這條路的網路與框架底噪
const bare: number[] = []
for (let i = 0; i < runs; i++) {
  const t0 = performance.now()
  await fetch(`${base}/health`)
  bare.push(performance.now() - t0)
}
bare.sort((x, y) => x - y)
const bq = (p: number) => bare[Math.min(bare.length - 1, Math.floor(bare.length * p))]!.toFixed(2)
console.log(`  /health（一樣有一次 select 1，無 requireAuth）: p50 ${bq(0.5)}ms  p95 ${bq(0.95)}ms  n=${runs}`)
ck('成本量得出來', took.length === runs)

console.log(`\n${fail === 0 ? '✅' : '❌'} regress-session: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

/* 這支沒有 import 任何東西（全部走 HTTP），加一個空 export 讓 TS 把它當模組，
   否則頂層 await 不合法。 */
export {}
