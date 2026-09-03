/**
 * 速率限制的迴歸測試（A-2 卡冊登記、A-7 OAuth 起始端點）。
 *
 *   npx tsx src/regress-ratelimit.ts http://localhost:8071
 *   npx tsx src/regress-ratelimit.ts http://localhost:8071 after-restart
 *
 * 伺服器要 DEV_LOGIN=1、DEV_LOGIN_SECRET，且要設 LINE_CHANNEL_SECRET
 * （沒設的話 /v1/auth/line/start 一律 503，這支就驗不到 A-7）。
 * 這支會直接連資料庫（DATABASE_URL 要跟伺服器同一個庫）——
 * 過期 state 的清理沒辦法只靠 HTTP 造資料。
 *
 * ⚠️ **要有自己的乾淨資料庫。** 理由跟其他迴歸一樣，而且這支更嚴格：
 * 它會把好幾個桶打到上限，那些計數會留在 login_attempts 裡 15 分鐘，
 * 跟其他測試共用庫的話，那邊的登入／登記會莫名其妙被 429。
 *
 * 這支測的**兩半**同等重要：
 *   正向 —— 打到上限真的被擋（第 N 次成功、第 N+1 次 429）
 *   反向 —— 正常節奏的人不會被擋、換帳號／換 IP 不受牽連、
 *           三個桶彼此不互相拖累
 * 只驗正向的限流測試會讓「把門檻設成 1」看起來也是綠的。
 */
import { sql } from './db.js'

const base = (process.argv[2] ?? 'http://localhost:8071').replace(/\/$/, '')
const phase = process.argv[3] ?? 'all'
const devSecret = process.env.DEV_LOGIN_SECRET
const devHeaders = () => {
  if (!devSecret) throw new Error('regress-ratelimit 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')
  return { 'x-dev-login-secret': devSecret }
}

let pass = 0, fail = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
const head = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 52 - s.length))}`)

/* 每一組測試用**自己的 IP**（x-forwarded-for 的最後一段才是 clientIp 讀的那段），
   否則所有測試共用 'unknown' 這一個 key，一組把 IP 桶打滿之後
   後面每一組都會被前面那組擋住 —— 那會測出一堆假的紅字。 */
const RUN = String(Date.now()).slice(-7)
const ipHeaders = (ip: string) => ({ 'x-forwarded-for': `10.0.0.1, ${ip}` })

async function login(handle: string, ip = '198.51.100.1') {
  const r = await fetch(`${base}/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...devHeaders(), ...ipHeaders(ip) },
    body: JSON.stringify({ handle, name: handle })
  })
  if (!r.ok) throw new Error(`dev-login ${handle}: ${r.status}`)
  return (await r.json() as { token: string }).token
}

/** 登記一張裸卡。裸卡沒有唯一索引，可以無限次重複，正好拿來數次數。 */
let seq = 0
const upload = (token: string, ip: string) =>
  fetch(`${base}/v1/cardbook/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...ipHeaders(ip) },
    body: JSON.stringify({
      card: {
        name: `限流測試卡 ${++seq}`, setCode: 'sv4a', cardNo: '777',
        artId: 'SV4a-777', language: 'JP', grader: null, grade: null,
        certNo: null, refPrice: 100
      }
    })
  })

const badLogin = (email: string, ip: string) =>
  fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ipHeaders(ip) },
    body: JSON.stringify({ email, password: 'definitely-not-the-password' })
  })

const oauthStart = (ip: string) =>
  fetch(`${base}/v1/auth/line/start`, { headers: ipHeaders(ip), redirect: 'manual' })

/** 把某個 IP 的登入失敗桶打到上限（ip: 是 40 次/15 分鐘）。
    每次換一個 email，才不會先被 email: 桶（8 次）擋住 ——
    那樣鎖住的是別的桶，證明不了任何事。 */
async function lockLoginIp(ip: string) {
  for (let i = 0; i < 40; i++) await badLogin(`nobody-${RUN}-${i}@example.com`, ip)
}

/* ══ 重啟後不歸零 ══════════════════════════════════════════════
   計數存 Postgres 不存記憶體（rate-limit.ts 開頭那段的理由）。
   驗法是分兩趟：第一趟把 rl-persist 這個帳號打到被擋，
   重啟伺服器，第二趟只確認它**還是**被擋。 */
/* 這兩個值刻意**固定**（不帶 RUN）：兩趟是不同的行程，
   帶時間戳的話第二趟會去查一個第一趟沒鎖過的 key，永遠是綠的 ——
   一條驗不到東西的斷言比沒有這條更糟。
   固定值不會撞：這支本來就要求自己一個乾淨庫。 */
const PERSIST_IP = '203.0.113.77'
const PERSIST_HANDLE = 'rlpersist'

if (phase === 'after-restart') {
  head('重啟後計數沒有歸零')
  const token = await login(PERSIST_HANDLE, PERSIST_IP)
  const r = await upload(token, PERSIST_IP)
  ck('重啟後同一個帳號仍然被擋', r.status === 429, `got ${r.status}`)
  ck('仍然帶 Retry-After', !!r.headers.get('retry-after'))
  console.log(`\n${fail === 0 ? '全部通過' : '有失敗'}：pass ${pass}、fail ${fail}`)
  await sql.end()
  process.exit(fail === 0 ? 0 : 1)
}

/* ══ A-7 過期 state 清理 ═════════════════════════════════════════
   **放在最前面跑。** 清理是節流的（一個行程 60 秒最多一次），
   而它掛在 /start 上 —— 只要別的測試先打過 /start，這一段就得等一分鐘。 */
head('A-7 過期 oauth_states 被清掉、未過期的沒被誤刪')
{
  const old1 = `st-old-${RUN}-1`, old2 = `st-old-${RUN}-2`
  const fresh = `st-fresh-${RUN}`
  await sql`insert into oauth_states (state, nonce, provider, created_at) values
    (${old1}, 'n', 'line', now() - interval '3 hours'),
    (${old2}, 'n', 'line', now() - interval '2 days'),
    (${fresh}, 'n', 'line', now())`
  /* 交換碼是同一類的短命憑證，順手一起驗（清理那段兩張表都掃）。 */
  const [u] = await sql`select id from users limit 1`
  const codeOld = `hash-old-${RUN}`, codeFresh = `hash-fresh-${RUN}`
  if (u) {
    await sql`insert into oauth_login_codes (code_hash, user_id, expires_at) values
      (${codeOld}, ${u.id as string}, now() - interval '3 hours'),
      (${codeFresh}, ${u.id as string}, now() + interval '5 minutes')`
  }

  const r = await oauthStart('192.0.2.50')
  ck('/start 有回應（302 到 LINE）', r.status === 302, `got ${r.status}`)

  /* 清理是 fire-and-forget，不會擋住那個 302 —— 所以要等它落地。
     輪詢而不是固定 sleep：慢的機器不該變成假失敗。 */
  let gone = false
  for (let i = 0; i < 30 && !gone; i++) {
    const [row] = await sql`select count(*)::int as n from oauth_states where state = ${old1}`
    gone = (row!.n as number) === 0
    if (!gone) await new Promise(res => setTimeout(res, 100))
  }
  const [oldLeft] = await sql`select count(*)::int as n from oauth_states where state in (${old1}, ${old2})`
  const [freshLeft] = await sql`select count(*)::int as n from oauth_states where state = ${fresh}`
  ck('過期的 state 被刪掉', (oldLeft!.n as number) === 0, `還剩 ${oldLeft!.n}`)
  ck('未過期的 state 沒被誤刪', (freshLeft!.n as number) === 1, `剩 ${freshLeft!.n}`)
  if (u) {
    const [co] = await sql`select count(*)::int as n from oauth_login_codes where code_hash = ${codeOld}`
    const [cf] = await sql`select count(*)::int as n from oauth_login_codes where code_hash = ${codeFresh}`
    ck('過期的登入交換碼被刪掉', (co!.n as number) === 0)
    ck('未過期的交換碼沒被誤刪', (cf!.n as number) === 1)
  }
}

/* ══ A-2 正向：打到上限真的被擋 ═══════════════════════════════ */
head('A-2 卡冊登記：第 40 張成功、第 41 張被擋')
const USER_CAP = 40
{
  const ip = '198.51.100.10'
  const token = await login(`rlcap${RUN}`, ip)
  let lastOk = 0, firstBlocked = 0
  for (let i = 1; i <= USER_CAP + 1; i++) {
    const r = await upload(token, ip)
    await r.body?.cancel()
    if (r.ok) lastOk = i
    if (r.status === 429) { firstBlocked = i; break }
  }
  ck(`前 ${USER_CAP} 張都成功`, lastOk === USER_CAP, `最後成功的是第 ${lastOk} 張`)
  ck(`第 ${USER_CAP + 1} 張被擋`, firstBlocked === USER_CAP + 1, `第 ${firstBlocked} 張才被擋`)

  const r = await upload(token, ip)
  ck('被擋時回 429', r.status === 429, `got ${r.status}`)
  const retry = r.headers.get('retry-after')
  ck('429 帶 Retry-After 而且是合理的秒數', !!retry && Number(retry) > 0 && Number(retry) <= 15 * 60, String(retry))
  const body = await r.json() as { error?: string; message?: string }
  ck('錯誤代號是登記專用的', body.error === 'TOO_MANY_UPLOADS', String(body.error))
  ck('訊息是看得懂的中文', /分鐘後再登記/.test(body.message ?? ''), body.message)
  /* 訊息不能變成一張「你手上有幾張卡」的側頻道：那既幫不上正常使用者，
     又剛好是想貼著上限走的人最想知道的數字。 */
  ck('訊息不透露登記過幾張／上限是多少', !/\d+\s*張|上限|已登記/.test(body.message ?? ''), body.message)

  /* ── 反向：換一個帳號、換一個 IP 都不受影響 ── */
  head('A-2 反向：換帳號／換 IP 不受牽連')
  const other = await login(`rlother${RUN}`, '198.51.100.11')
  const r2 = await upload(other, '198.51.100.11')
  ck('另一個帳號＋另一個 IP 照常登記', r2.ok, `got ${r2.status}`)

  /* 同一個 IP、不同帳號：IP 桶（120）還沒滿，所以應該過 —— 這條同時
     證明了「user 桶擋的是帳號不是整條網路」（NAT 後面的人不互相拖累）。 */
  const sameIpOther = await login(`rlnat${RUN}`, ip)
  const r3 = await upload(sameIpOther, ip)
  ck('同一個 IP 的另一個帳號沒被連坐', r3.ok, `got ${r3.status}`)
}

/* ══ A-2 反向：真的在整理收藏的人不會被擋 ═════════════════════ */
head('A-2 反向：正常節奏的收藏者全程 200')
{
  /* 模擬一個真的在登記收藏的人。前端沒有批次登記
     （src/pages/CardUploadPage.vue：一次一張，送出成功就導回卡冊），
     所以真人的節奏是「填表→送出→回卡冊→再進表單」，一張十幾二十秒。
     測試不可能真的等，但**次數**要照真人的量體來：
     一個下午登記 25 張是很正常的收藏整理，這 25 次必須全部 200。 */
  const ip = '198.51.100.20'
  const token = await login(`rlnormal${RUN}`, ip)
  const codes: number[] = []
  for (let i = 0; i < 25; i++) codes.push((await upload(token, ip)).status)
  ck('連續登記 25 張沒有任何一次被擋', codes.every(s => s === 200), `狀態碼：${[...new Set(codes)].join(',')}`)
}

/* ══ A-7 正向 ═══════════════════════════════════════════════ */
head('A-7 OAuth start：第 40 次成功、第 41 次被擋')
const OAUTH_CAP = 40
{
  const ip = '192.0.2.10'
  let lastOk = 0, firstBlocked = 0
  for (let i = 1; i <= OAUTH_CAP + 1; i++) {
    const r = await oauthStart(ip)
    await r.body?.cancel()
    if (r.status === 302) lastOk = i
    if (r.status === 429) { firstBlocked = i; break }
  }
  ck(`前 ${OAUTH_CAP} 次都導向 LINE`, lastOk === OAUTH_CAP, `最後成功的是第 ${lastOk} 次`)
  ck(`第 ${OAUTH_CAP + 1} 次被擋`, firstBlocked === OAUTH_CAP + 1, `第 ${firstBlocked} 次才被擋`)
  const r = await oauthStart(ip)
  ck('429 帶 Retry-After', !!r.headers.get('retry-after'))
  const body = await r.json() as { error?: string; message?: string }
  ck('訊息是看得懂的中文', /請於 \d+ 分鐘後再試/.test(body.message ?? ''), body.message)

  const r2 = await oauthStart('192.0.2.11')
  await r2.body?.cancel()
  ck('換一個 IP 不受影響', r2.status === 302, `got ${r2.status}`)
}

/* ══ 三組交叉：桶與桶之間互不干擾 ═══════════════════════════
   這是整支測試最重要的一段。共用一個桶的 bug 不會讓限流「壞掉」，
   它會讓限流在**錯的地方**生效 —— 一個人登入打錯密碼，
   另一件毫不相干的事被鎖住（M-1 就是這樣被發現的）。 */
head('交叉 1：登入被鎖 → 卡冊登記仍然可用')
{
  const ip = '198.51.100.30'
  await lockLoginIp(ip)
  const blocked = await badLogin(`nobody-${RUN}-x@example.com`, ip)
  ck('登入確實被鎖了', blocked.status === 429, `got ${blocked.status}`)
  const token = await login(`rlx1${RUN}`, ip)
  const r = await upload(token, ip)
  ck('同一個 IP 的卡冊登記照常', r.ok, `got ${r.status}`)
  const o = await oauthStart(ip)
  await o.body?.cancel()
  ck('同一個 IP 的 OAuth start 照常', o.status === 302, `got ${o.status}`)
}

head('交叉 2：卡冊登記被鎖 → 登入與 OAuth start 仍然可用')
{
  const ip = '198.51.100.40'
  const token = await login(`rlx2${RUN}`, ip)
  for (let i = 0; i < USER_CAP; i++) await upload(token, ip)
  const blocked = await upload(token, ip)
  ck('卡冊登記確實被鎖了', blocked.status === 429, `got ${blocked.status}`)
  /* 登入沒被鎖的證據是它回 401（帳密不對）而不是 429（被限流擋）。 */
  const li = await badLogin(`nobody-${RUN}-y@example.com`, ip)
  ck('同一個 IP 的登入照常受理（401 不是 429）', li.status === 401, `got ${li.status}`)
  const o = await oauthStart(ip)
  await o.body?.cancel()
  ck('同一個 IP 的 OAuth start 照常', o.status === 302, `got ${o.status}`)
}

head('交叉 3：OAuth start 被鎖 → 登入與卡冊登記仍然可用')
{
  const ip = '198.51.100.50'
  for (let i = 0; i < OAUTH_CAP; i++) (await oauthStart(ip)).body?.cancel()
  const blocked = await oauthStart(ip)
  ck('OAuth start 確實被鎖了', blocked.status === 429, `got ${blocked.status}`)
  const li = await badLogin(`nobody-${RUN}-z@example.com`, ip)
  ck('同一個 IP 的登入照常受理（401 不是 429）', li.status === 401, `got ${li.status}`)
  const token = await login(`rlx3${RUN}`, ip)
  const r = await upload(token, ip)
  ck('同一個 IP 的卡冊登記照常', r.ok, `got ${r.status}`)
}

/* ══ A-2 IP 兜底：同一台機器換帳號也有天花板 ═════════════════ */
head('A-2 IP 桶：同一個 IP 換帳號寫到 120 張就停')
{
  const ip = '198.51.100.60'
  let sent = 0, blockedAt = 0
  /* 四個帳號各寫 40 張 = 160 次，IP 桶（120）會在第 121 次擋下來。
     每個帳號都在自己的 user 桶上限之內，所以擋住它的只可能是 IP 桶。 */
  for (let u = 0; u < 4 && !blockedAt; u++) {
    const token = await login(`rlip${RUN}u${u}`, ip)
    for (let i = 0; i < USER_CAP; i++) {
      const r = await upload(token, ip)
      sent++
      if (r.status === 429) { blockedAt = sent; break }
    }
  }
  ck('第 121 次才被 IP 桶擋下', blockedAt === 121, `第 ${blockedAt} 次被擋`)
}

/* ══ 為重啟測試留下狀態 ══════════════════════════════════════ */
head('留下一個被鎖的帳號給重啟測試（after-restart）')
{
  const token = await login(PERSIST_HANDLE, PERSIST_IP)
  for (let i = 0; i < USER_CAP; i++) await upload(token, PERSIST_IP)
  const r = await upload(token, PERSIST_IP)
  ck('重啟前已經被擋', r.status === 429, `got ${r.status}`)
  console.log(`  （重啟伺服器後跑：npx tsx src/regress-ratelimit.ts ${base} after-restart）`)
}

console.log(`\n${fail === 0 ? '全部通過' : '有失敗'}：pass ${pass}、fail ${fail}`)
await sql.end()
process.exit(fail === 0 ? 0 : 1)
