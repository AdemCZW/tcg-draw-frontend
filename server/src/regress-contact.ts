/**
 * 公開客服聯絡表單的迴歸測試（/v1/contact 與 /v1/admin/contact）。
 *
 *   npx tsx src/regress-contact.ts http://localhost:8072
 *
 * 伺服器要 DEV_LOGIN=1、DEV_LOGIN_SECRET（要造一個管理員來驗後台那條路）。
 * 這支會直接連資料庫（DATABASE_URL 要跟伺服器同一個庫）——
 * 「有沒有把原始 IP 存進去」只能打開那一列看。
 *
 * ⚠️ **要有自己的乾淨資料庫。** 它會把 contact-ip: 桶打到上限，
 * 那些計數會留在 login_attempts 裡 15 分鐘。
 *
 * ── 這支在釘什麼 ───────────────────────────────────────────────────
 * 這個功能唯一不能出的錯是「送出成功了，但客服看不到」，
 * 所以核心那條測的是**整條路**：完全沒有 token 的請求送出 → 管理員
 * 用後台真的會打的那支端點讀得到那一筆。只看資料庫不算數。
 *
 * 限流的**兩半同等重要**：
 *   正向 —— 打到上限真的被擋（429 + Retry-After）
 *   反向 —— 正常節奏的真人不會被擋、換 IP 不受牽連、
 *           而且**登入被鎖住的人仍然送得出去**（那正是這張表單存在的理由）
 * 只驗正向的限流測試會讓「把門檻設成 1」看起來也是綠的。
 */
import { sql } from './db.js'

const base = (process.argv[2] ?? 'http://localhost:8072').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
const devHeaders = () => {
  if (!devSecret) throw new Error('regress-contact 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')
  return { 'x-dev-login-secret': devSecret }
}

let pass = 0, fail = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
const head = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 52 - s.length))}`)

/* 每一組用**自己的 IP**（clientIp 讀的是 x-forwarded-for 的最後一段），
   否則所有組共用一個桶，前面那組把它打滿之後後面全是假的紅字。 */
const RUN = String(Date.now()).slice(-7)
const ipHeaders = (ip: string) => ({ 'x-forwarded-for': `10.0.0.1, ${ip}` })

type Any = Record<string, unknown>

/** 匿名送出：**刻意不帶任何 Authorization**，這是這支測試的主體。 */
const send = (ip: string, body: unknown, token?: string) =>
  fetch(`${base}/v1/contact`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...ipHeaders(ip),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  })

let seq = 0
const goodBody = (over: Partial<Record<string, unknown>> = {}) => ({
  topic: 'login',
  name: `測試訪客 ${++seq}`,
  email: `visitor-${RUN}-${seq}@example.com`,
  /* 內容帶 RUN：同一個庫被重跑第二次時，「資料庫裡只有一筆」那條斷言
     才不會撈到上一趟留下的同名列（這支本來就要求乾淨的庫，但一條會
     因為重跑而變紅的斷言，讀的人分不出是產品壞了還是測試髒了）。 */
  body: `我忘記密碼了，登入頁沒有忘記密碼的按鈕。第 ${RUN}-${seq} 則測試訊息。`,
  ...over
})

async function login(handle: string, ip = '198.51.100.1') {
  const r = await fetch(`${base}/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...devHeaders(), ...ipHeaders(ip) },
    body: JSON.stringify({ handle, name: handle })
  })
  if (!r.ok) throw new Error(`dev-login ${handle}: ${r.status}`)
  return (await r.json() as { token: string }).token
}

const badLogin = (email: string, ip: string) =>
  fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ipHeaders(ip) },
    body: JSON.stringify({ email, password: 'definitely-not-the-password' })
  })

/** 後台佇列 —— **前端那一頁真的會打的那支**，不是自己去查資料庫。 */
const adminList = (token: string, scope = 'new', limit = 100) =>
  fetch(`${base}/v1/admin/contact?scope=${scope}&limit=${limit}`,
    { headers: { authorization: `Bearer ${token}`, ...devHeaders() } })

/* ══ 準備一個管理員 ═══════════════════════════════════════════ */
const adminHandle = `ctadmin${RUN}`
const adminToken = await login(adminHandle, '203.0.113.9')
await sql`update users set role = 'admin' where handle = ${adminHandle}`

/* ══ 核心：完全沒有登入，整條路走得完 ══════════════════════════ */
head('核心：匿名送出 → 後台看得到那一筆')
let coreId = ''
{
  const ip = '198.51.100.101'
  const b = goodBody()
  const r = await send(ip, b)
  const j = await r.json() as Any
  ck('沒有帶任何 token 也送得出去', r.status === 200, `${r.status} ${JSON.stringify(j).slice(0, 160)}`)
  ck('回一個訊息編號', typeof j.id === 'string' && String(j.id).startsWith('ct-'), String(j.id))
  coreId = String(j.id)

  /* **這一條才是驗收標準。** 只查資料庫的話，「後台的查詢寫錯、
     客服其實看不到」會整段測綠。 */
  const q = await adminList(adminToken)
  const list = await q.json() as { items: Any[]; pending: number }
  const row = (list.items ?? []).find(x => x.id === coreId)
  ck('管理員從後台端點看得到那一筆', !!row, `佇列上有 ${list.items?.length ?? 0} 筆`)
  ck('內容一字不差地讀得回來', row?.body === b.body, String(row?.body).slice(0, 80))
  ck('email 讀得回來（那是唯一的回覆管道）', row?.email === b.email, String(row?.email))
  ck('匿名的那幾筆 userId 是 null', row?.userId === null, String(row?.userId))
  ck('狀態是未處理', row?.status === 'new', String(row?.status))
  ck('未處理計數 >= 1', (list.pending ?? 0) >= 1, String(list.pending))
}

/* ══ 個資：原始 IP 不進資料庫 ═══════════════════════════════════ */
head('個資：存的是雜湊，不是 IP 本身')
{
  const [row] = await sql<{ ip_hash: string | null; body: string }[]>`
    select ip_hash, body from contact_messages where id = ${coreId}
  `
  ck('有存來源雜湊（限流要用）', !!row?.ip_hash, String(row?.ip_hash))
  ck('雜湊不是 IP 本身', row?.ip_hash !== '198.51.100.101', String(row?.ip_hash))
  ck('雜湊裡看不到 IP 的任何一段', !String(row?.ip_hash ?? '').includes('198.51'), String(row?.ip_hash))
  ck('雜湊長度是 32（128 bit）', String(row?.ip_hash ?? '').length === 32, String(row?.ip_hash?.length))
  /* 整張表沒有任何一欄叫 ip / remote_addr —— 之後有人「順手加一欄存原始 IP」時
     這條會紅。 */
  const cols = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns where table_name = 'contact_messages'
  `
  const names = cols.map(c => c.column_name)
  ck('表上沒有任何存原始 IP 的欄位',
    !names.some(n => ['ip', 'ip_addr', 'remote_addr', 'client_ip'].includes(n)), names.join(','))
}

/* ══ 已登入的人送出 ═══════════════════════════════════════════ */
head('已登入：身分會被帶上，客服因此有脈絡')
{
  const ip = '198.51.100.102'
  const tok = await login(`ctuser${RUN}`, ip)
  const r = await send(ip, goodBody({ topic: 'order' }), tok)
  const j = await r.json() as Any
  ck('已登入的人一樣送得出去', r.status === 200, `${r.status}`)

  const list = await (await adminList(adminToken)).json() as { items: Any[] }
  const row = (list.items ?? []).find(x => x.id === j.id)
  ck('後台看得到 userId', typeof row?.userId === 'string' && !!row.userId, String(row?.userId))
  ck('後台看得到站內顯示名稱', String(row?.userName ?? '').length > 0, String(row?.userName))

  /* token 壞掉**不能**讓送出失敗 —— 一個 token 過期到進不了站的人，
     正是這張表單的目標對象。這條是整個設計的關鍵，不是邊角案例。 */
  const r2 = await send('198.51.100.103', goodBody(), 'this.is.not-a-valid-jwt')
  const j2 = await r2.json() as Any
  ck('token 壞掉時退回匿名，而不是 401', r2.status === 200, `${r2.status}`)
  const list2 = await (await adminList(adminToken)).json() as { items: Any[] }
  ck('壞 token 的那筆是匿名的',
    (list2.items ?? []).find(x => x.id === j2.id)?.userId === null)
}

/* ══ 畸形輸入 ════════════════════════════════════════════════ */
head('畸形輸入：擋得掉，而且錯誤訊息是給人看的')
{
  const ip = '198.51.100.110'
  const cases: [string, unknown, RegExp][] = [
    ['空白的內文', goodBody({ body: '     ' }), /多寫幾個字|不完整/],
    ['太短的內文', goodBody({ body: '救我' }), /多寫幾個字/],
    ['超長內文（4001 字）', goodBody({ body: 'あ'.repeat(4001) }), /4000/],
    ['假 email（沒有 @）', goodBody({ email: 'notanemail' }), /Email/],
    ['假 email（沒有網域）', goodBody({ email: 'a@b' }), /Email/],
    ['超長 email', goodBody({ email: `${'x'.repeat(200)}@example.com` }), /Email/],
    ['沒有稱呼', goodBody({ name: '   ' }), /稱呼/],
    ['不存在的主題', goodBody({ topic: 'wire-transfer' }), /./],
    ['整包不是 JSON 物件', 'nope', /./],
    ['少一半欄位', { topic: 'other' }, /./]
  ]
  for (const [label, body, re] of cases) {
    const r = await send(ip, body)
    const j = await r.json() as { error?: string; message?: string }
    ck(`${label} → 400`, r.status === 400, `${r.status} ${JSON.stringify(j).slice(0, 120)}`)
    ck(`${label} 的訊息是看得懂的中文`, re.test(j.message ?? ''), j.message)
  }
  /* 被擋掉的那幾則**不可以**留在資料庫裡。 */
  const [n] = await sql<{ n: number }[]>`
    select count(*)::int as n from contact_messages where body like '%あああ%' or email = 'notanemail'
  `
  ck('被擋掉的畸形輸入沒有任何一則被寫進去', n!.n === 0, `寫進了 ${n!.n} 筆`)
}

/* ══ 注入 ═══════════════════════════════════════════════════ */
head('注入：原樣存、原樣回，後端不做任何解讀')
let xssId = ''
{
  const ip = '198.51.100.111'
  /* 這一串同時測三件事：HTML 標籤、屬性事件、以及 SQL 的單引號。
     後端唯一該做的事是「原封不動地存下來」—— 逸出是顯示端的責任
     （後台那一頁一律走 {{ }} 插值，絕不用 v-html）。 */
  const payload = `<script>alert('xss')</` + `script><img src=x onerror="alert(1)">`
    + ` '; drop table contact_messages; -- 我的卡不見了`
  const r = await send(ip, goodBody({ topic: 'report', name: '<b>粗體</b>', body: payload }))
  const j = await r.json() as Any
  ck('含腳本的內容照樣收下（不該由後端審查內容）', r.status === 200, `${r.status}`)
  xssId = String(j.id)

  const [row] = await sql<{ body: string; name: string }[]>`
    select body, name from contact_messages where id = ${xssId}
  `
  ck('內文一字不差地存下來（沒有被偷偷改寫）', row?.body === payload, String(row?.body).slice(0, 90))
  ck('稱呼裡的標籤也原樣保留', row?.name === '<b>粗體</b>', String(row?.name))

  /* SQL 注入沒有生效的證據：表還在，而且前面那幾筆都還在。 */
  const [alive] = await sql<{ n: number }[]>`select count(*)::int as n from contact_messages`
  ck('資料表沒有被 drop（參數化查詢生效）', alive!.n >= 2, `剩 ${alive!.n} 筆`)

  const list = await (await adminList(adminToken)).json() as { items: Any[] }
  const back = (list.items ?? []).find(x => x.id === xssId)
  ck('後台端點回的也是原字串（JSON 不做 HTML 逸出，那是畫面的事）',
    back?.body === payload, String(back?.body).slice(0, 90))
}

/* ══ 連按兩下 ═══════════════════════════════════════════════ */
head('連按兩下送出只會產生一筆')
{
  const ip = '198.51.100.112'
  const b = goodBody()
  const r1 = await send(ip, b)
  const r2 = await send(ip, b)
  const j1 = await r1.json() as Any, j2 = await r2.json() as Any
  ck('第二次也是 200（回 409 會讓人以為第一次沒送出去）', r2.status === 200, `${r2.status}`)
  ck('兩次拿到同一個編號', j1.id === j2.id, `${j1.id} vs ${j2.id}`)
  ck('第二次標記為重送', j2.duplicate === true, String(j2.duplicate))
  const [n] = await sql<{ n: number }[]>`select count(*)::int as n from contact_messages where body = ${b.body}`
  ck('資料庫裡只有一筆', n!.n === 1, `${n!.n} 筆`)
}

/* ══ 限流 · 反向（先跑）：正常速度的真人不會被擋 ═══════════════
   反向放在正向前面，因為它比較容易被忽略而且更重要：
   只驗正向的話，把門檻設成 1 也會全綠。 */
head('限流反向：正常節奏的真人全程 200')
{
  /* 一個真的需要幫忙的人會送 1 則，講不清楚再補 1、2 則。
     這裡連送 3 則（而且是完全不同的內容，避免撞到去重），全部必須 200。 */
  const ip = '198.51.100.120'
  const codes: number[] = []
  for (let i = 0; i < 3; i++) codes.push((await send(ip, goodBody())).status)
  ck('連續送 3 則沒有任何一次被擋', codes.every(s => s === 200), `狀態碼：${[...new Set(codes)].join(',')}`)
}

head('限流反向：換一個網路不受牽連')
{
  /* 先把某個 IP 的日配額用光，再從另一個 IP 送 —— 必須照常。 */
  const hot = '198.51.100.121'
  for (let i = 0; i < 10; i++) await send(hot, goodBody())
  const blocked = await send(hot, goodBody())
  ck('前一個 IP 確實被擋了', blocked.status === 429, `${blocked.status}`)
  const other = await send('198.51.100.122', goodBody())
  ck('另一個 IP 照常送得出去', other.status === 200, `${other.status}`)
}

/* ══ 限流 · 正向：日配額 ═══════════════════════════════════════ */
head('限流正向：日配額 第 10 則成功、第 11 則被擋')
const DAILY_MAX = 10
{
  const ip = '198.51.100.130'
  let lastOk = 0, firstBlocked = 0
  for (let i = 1; i <= DAILY_MAX + 1; i++) {
    const r = await send(ip, goodBody())
    if (r.status === 200) lastOk = i
    if (r.status === 429) { firstBlocked = i; break }
  }
  ck(`前 ${DAILY_MAX} 則都收下`, lastOk === DAILY_MAX, `最後成功的是第 ${lastOk} 則`)
  ck(`第 ${DAILY_MAX + 1} 則被擋`, firstBlocked === DAILY_MAX + 1, `第 ${firstBlocked} 則才被擋`)

  const r = await send(ip, goodBody())
  ck('被擋時回 429', r.status === 429, `${r.status}`)
  const retry = Number(r.headers.get('retry-after'))
  ck('429 帶 Retry-After 而且是合理的秒數（<= 24 小時）',
    retry > 0 && retry <= 24 * 3600, String(retry))
  const body = await r.json() as { error?: string; message?: string }
  ck('錯誤代號是這支專用的', body.error === 'TOO_MANY_CONTACTS', String(body.error))
  ck('訊息是看得懂的中文，而且講得出還要等多久', /小時後再試/.test(body.message ?? ''), body.message)
  /* 訊息不能變成「你今天送了幾則、上限是幾則」的側頻道：那既幫不上
     正常使用者，又剛好是想貼著上限走的人最想知道的數字。 */
  ck('訊息不透露送過幾則／上限是多少',
    !/\d+\s*則|上限是|已送出\s*\d/.test(body.message ?? ''), body.message)
  ck('訊息有給另一條出路', /信箱/.test(body.message ?? ''), body.message)
}

/* ══ 限流 · 正向：突發桶（畸形請求也要計數） ═══════════════════
   這一段驗的是「只計成功的話，用畸形 body 猛打的機器人永遠碰不到限制」。
   contact-ip: 的門檻是 rate-limit.ts 對未知前綴的退回值（40 次／15 分鐘）——
   數字是繼承來的，見 routes/contact.ts 的說明。 */
head('限流正向：畸形請求也計數，第 41 次被擋')
const BURST_MAX = 40
{
  const ip = '198.51.100.140'
  let firstBlocked = 0
  for (let i = 1; i <= BURST_MAX + 1; i++) {
    /* 一律送畸形 body：這些都不會寫進資料庫，所以日配額永遠不會觸發，
       擋下來的只可能是突發桶。 */
    const r = await send(ip, { topic: 'other' })
    if (r.status === 429) { firstBlocked = i; break }
  }
  ck(`第 ${BURST_MAX + 1} 次被擋（前 ${BURST_MAX} 次都只是 400）`,
    firstBlocked === BURST_MAX + 1, `第 ${firstBlocked} 次被擋`)
  const r = await send(ip, goodBody())
  ck('桶滿之後連合法的請求也擋（桶是以來源計，不是以內容計）', r.status === 429, `${r.status}`)
  ck('帶 Retry-After', !!r.headers.get('retry-after'))
  const j = await r.json() as { message?: string }
  ck('訊息講得出還要等幾分鐘', /分鐘後再試/.test(j.message ?? ''), j.message)
}

/* ══ 桶與桶互不干擾 ══════════════════════════════════════════
   **這是整支測試最重要的一段。** 這張表單存在的理由就是
   「一個因為登入一直失敗而被鎖在外面的人，還有地方可以講話」——
   如果它跟登入共用計數，那個人一輩子送不出來（M-1 這個 repo 犯過兩次）。 */
head('交叉：登入被鎖到 429 → 這張表單仍然送得出去')
{
  const ip = '198.51.100.150'
  /* 每次換一個 email，才不會先被 email: 桶（8 次）擋住 —— 那樣鎖住的是別的桶 */
  for (let i = 0; i < 40; i++) await badLogin(`nobody-${RUN}-${i}@example.com`, ip)
  const blocked = await badLogin(`nobody-${RUN}-x@example.com`, ip)
  ck('登入確實被鎖了（429）', blocked.status === 429, `${blocked.status}`)

  const r = await send(ip, goodBody())
  ck('同一個 IP 的聯絡表單照常送得出去', r.status === 200, `${r.status}`)
  const j = await r.json() as Any
  const list = await (await adminList(adminToken)).json() as { items: Any[] }
  ck('而且後台真的看得到那一筆', (list.items ?? []).some(x => x.id === j.id))
}

head('交叉：聯絡表單被鎖 → 登入與卡冊登記不受影響')
{
  const ip = '198.51.100.151'
  for (let i = 0; i < DAILY_MAX; i++) await send(ip, goodBody())
  const blocked = await send(ip, goodBody())
  ck('聯絡表單確實被鎖了', blocked.status === 429, `${blocked.status}`)
  /* 登入沒被鎖的證據是它回 401（帳密不對）而不是 429（被限流擋）。 */
  const li = await badLogin(`nobody-${RUN}-y@example.com`, ip)
  ck('同一個 IP 的登入照常受理（401 不是 429）', li.status === 401, `${li.status}`)
  const tok = await login(`ctx2${RUN}`, ip)
  const up = await fetch(`${base}/v1/cardbook/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...ipHeaders(ip) },
    body: JSON.stringify({ card: {
      name: `交叉測試卡 ${RUN}`, setCode: 'sv4a', cardNo: '777', artId: 'SV4a-777',
      language: 'JP', grader: null, grade: null, certNo: null, refPrice: 100
    } })
  })
  ck('同一個 IP 的卡冊登記照常', up.ok, `${up.status}`)
}

/* ══ 後台：權限與處理流程 ═══════════════════════════════════ */
head('後台：不是管理員讀不到；處理要留紀錄')
{
  const plain = await login(`ctplain${RUN}`, '198.51.100.160')
  const r1 = await fetch(`${base}/v1/admin/contact`, { headers: { authorization: `Bearer ${plain}` } })
  ck('一般會員讀不到佇列（403）', r1.status === 403, `${r1.status}`)
  const r2 = await fetch(`${base}/v1/admin/contact`)
  ck('沒登入更讀不到（401）', r2.status === 401, `${r2.status}`)

  const handle = (token: string, id: string, note: unknown) =>
    fetch(`${base}/v1/admin/contact/${id}/handle`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ note })
    })

  const noNote = await handle(adminToken, coreId, '')
  ck('備註沒填就處理 → 400（沒有紀錄的處理事後無法覆核）', noNote.status === 400, `${noNote.status}`)

  const ok = await handle(adminToken, coreId, '已回信協助重設密碼')
  ck('標記處理完成', ok.status === 200, `${ok.status}`)

  const again = await handle(adminToken, coreId, '再一次')
  ck('第二個客服重複處理 → 409（不會覆蓋掉第一個人的紀錄）', again.status === 409, `${again.status}`)

  const notFound = await handle(adminToken, 'ct-doesnotexist', '查無此筆')
  ck('不存在的編號 → 404', notFound.status === 404, `${notFound.status}`)

  const newList = await (await adminList(adminToken)).json() as { items: Any[] }
  ck('處理完的那筆從「未處理」佇列消失', !(newList.items ?? []).some(x => x.id === coreId))
  const allList = await (await adminList(adminToken, 'all')).json() as { items: Any[] }
  const row = (allList.items ?? []).find(x => x.id === coreId)
  ck('但在「全部」裡還找得到', !!row)
  ck('而且帶著處理紀錄', row?.handledNote === '已回信協助重設密碼', String(row?.handledNote))
  ck('也記得是誰處理的', String(row?.handledByName ?? '') === adminHandle, String(row?.handledByName))
}

head('後台：佇列的順序是先進先出')
{
  const list = await (await adminList(adminToken)).json() as { items: Any[] }
  const times = (list.items ?? []).map(x => Number(x.createdAt))
  ck('未處理佇列舊的排前面（沒有人想碰的那一則不會被新的擠掉）',
    times.every((t, i) => i === 0 || times[i - 1]! <= t), times.slice(0, 5).join(','))
  const all = await (await adminList(adminToken, 'all')).json() as { items: Any[] }
  const t2 = (all.items ?? []).map(x => Number(x.createdAt))
  ck('「全部」是新的排前面（那是翻歷史，不是工作佇列）',
    t2.every((t, i) => i === 0 || t2[i - 1]! >= t), t2.slice(0, 5).join(','))
}

console.log(`\n${fail === 0 ? '全部通過' : '有失敗'}：pass ${pass}、fail ${fail}`)
await sql.end()
process.exit(fail === 0 ? 0 : 1)
