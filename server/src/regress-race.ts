/**
 * 併發壓力測試（open-issues 第九節 V-1 / V-2 / V-3）。
 *
 * 這一支存在的理由：站上五百多條自動化測試幾乎都是**循序**的，
 * 而這個系統的核心命題（「錢不能算錯」）靠的是交易邊界與 `SELECT ... FOR UPDATE`——
 * 那些東西循序跑的時候**永遠是綠的**。第九節那三條之所以一直停在「推論」，
 * 就是因為沒有人真的把兩條路同時送出去過。
 *
 * ── 不變式只有一條 ──────────────────────────────────────────────────
 * 全站 SUM(points_ledger.delta) 恆等於發行量（topup + seed + admin-grant
 * ），也就是 `GET /v1/admin/reconcile` 的 `drift` 不變。
 * 每一組壓完都驗它，外加「沒有人的餘額變成負的」。
 * 其他的（誰贏誰輸、狀態機、分錄成不成對）都是為了在 drift 真的壞掉時
 * **指得出是哪一筆**，不是驗收標準本身。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   createdb vd_race
 *   DATABASE_URL=postgres://$(whoami)@localhost:5432/vd_race \
 *   JWT_SECRET=<至少 32 個字元> npx tsx src/migrate.ts
 *   DATABASE_URL=... JWT_SECRET=... npx tsx src/seed.ts
 *   DATABASE_URL=... JWT_SECRET=... PORT=8051 DEV_LOGIN=1 DEV_LOGIN_SECRET=<至少 32 個字元> npx tsx src/index.ts
 *   DATABASE_URL=... JWT_SECRET=... DEV_LOGIN_SECRET=<同一個值> npx tsx src/regress-race.ts http://localhost:8051
 *
 * ⚠️ **要自己一個乾淨的庫**，不能跟 smoke / regress-f / regress-pledge 共用。
 * 這支會吃掉數百個籤位、把賣家的違約次數推高、把一大批結算撥到逾期 ——
 * 那些都是它要驗的東西，但對別的測試來說是被污染的種子資料。
 * 反過來也一樣：別的測試先跑會讓這支預期的籤位與賣家餘額對不上。
 * 這支本身可以在同一個庫上重複跑（fixture 的 handle 都帶 runId 隨機字尾，
 * 見下方 runId 的說明），但籤位是消耗品，跑個兩三輪就會用完。
 *
 * ── 為什麼同時用 HTTP 與直連資料庫 ──────────────────────────────────
 * 產品行為一律走 HTTP（要壓的是真的端點，不是被抽出來的函式），但三件事
 * HTTP 做不到：
 *   1 **看得見死鎖。** sweep 掛在讀清單的路徑上，而那兩處都是
 *     `.catch(() => {})`（routes/prizes.ts:36、routes/sellers.ts:115）——
 *     40P01 被靜靜吞掉，HTTP 回 200。唯一誠實的計數器是
 *     `pg_stat_database.deadlocks`。
 *   2 **全域掃描沒有端點。** `sweepSettlementsAll()` 只有五分鐘一次的排程
 *     在呼叫，而它正是 V-1 環上最兇的一邊（一次撈全部未結案的結算列）。
 *     這裡直接 import 進來跑 —— 跟排程走的是同一個函式、同一個資料庫，
 *     只是換一個行程觸發。
 *   3 **挑籤位。** 「賣家保留額剛好差一點」要算得出來，就得先知道某個籤位
 *     背後的買回價。那是測試佈景，不是被測的行為。
 */
import { randomBytes } from 'node:crypto'
import { sql } from './db.js'
import { sweepSettlementsAll } from './pool-settlement.js'

const base = (process.argv[2] ?? 'http://localhost:8051').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
const devHeaders = () => {
  if (!devSecret) throw new Error('regress-race 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')
  return { 'x-dev-login-secret': devSecret }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/* fixture 的 handle / 冪等鍵一律帶這個字尾。
   `users_handle_key`、`ledger_once`（ref_id, user_id, reason）、
   `idempotency` 的主鍵都會擋固定值 —— 固定字串的話這支在同一個庫上
   跑第二次會撞 23505，而那是那幾道防線該做的事，不是缺陷。
   （前例：regress-monitor.ts 的檔頭說明。） */
const runId = randomBytes(4).toString('hex')
let seq = 0

let pass = 0, fail = 0, soft = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
/* known-fail：壓出來的真 bug 印出來但不讓整支 exit 非零。
   這支的職責是「把推論變成證據」，不是順手改產品碼 —— 修法由人決定。 */
const known = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) }
  else { soft++; console.error(` KNOWN-FAIL ${n}${d ? ' — ' + d : ''}`) }
}
const head = (s: string) => console.log(`\n══ ${s} ${'═'.repeat(Math.max(0, 60 - s.length))}`)
const note = (s: string) => console.log(`     · ${s}`)

/* ---------------- HTTP ---------------- */

interface Res { status: number; body: Any; text: string }
async function hit(path: string, init: RequestInit): Promise<Res> {
  const r = await fetch(`${base}${path}`, init)
  const text = await r.text()
  let body: Any = null
  try { body = JSON.parse(text) } catch { /* 500 可能不是 JSON —— 原文留在 text 給診斷用 */ }
  return { status: r.status, body, text }
}
const call = (token: string, path: string, body?: unknown, method?: 'GET' | 'POST') =>
  hit(path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
const dev = (path: string, body: unknown) =>
  hit(`/v1/dev/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() }, body: JSON.stringify(body)
  })

async function login(handle: string, name: string) {
  const r = await hit('/v1/auth/dev-login', {
    method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
    body: JSON.stringify({ handle, name })
  })
  if (r.status !== 200) throw new Error(`login ${handle}: ${r.status} ${r.text}`)
  return r.body.token as string
}

/* ---------------- 併發的原語 ---------------- */

interface Shot<T> { label: string; start: number; end: number; value?: T; err?: unknown }

/**
 * 把 n 個工作**同時**送出去，並記下每一個的在途時間窗。
 *
 * 時間窗是「有沒有真的併發」唯一誠實的客戶端證據：只印「跑了 20 輪」的話，
 * 20 次循序跑出來的結果長得一模一樣。它證明的是「請求在途時間重疊」，
 * **不是**「兩邊同時進到同一筆交易」—— 後者從客戶端看不到，所以報告裡
 * 一律照這個字面意思說。
 */
async function together<T>(jobs: { label: string; run: () => Promise<T> }[]): Promise<Shot<T>[]> {
  const shots: Shot<T>[] = jobs.map(j => ({ label: j.label, start: 0, end: 0 }))
  await Promise.all(jobs.map(async (j, i) => {
    const s = shots[i]!
    s.start = performance.now()
    try { s.value = await j.run() } catch (e) { s.err = e }
    s.end = performance.now()
  }))
  return shots
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 時間窗最多幾個同時重疊。1 表示這一輪其實是循序跑完的 */
function maxOverlap(shots: { start: number; end: number }[]): number {
  const ev: [number, number][] = []
  for (const s of shots) { ev.push([s.start, 1]); ev.push([s.end, -1]) }
  // 同一個時間點先關後開 —— 寧可低估重疊，不要把「剛好接在後面」算成併發
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let cur = 0, best = 0
  for (const [, d] of ev) { cur += d; if (cur > best) best = cur }
  return best
}

/** 一組情境的統計。`overlapped` 是真的重疊過的輪數 */
class Stat {
  rounds = 0; overlapped = 0; maxSeen = 0
  readonly outcomes = new Map<string, number>()
  round(shots: { start: number; end: number }[], outcome: string) {
    this.rounds++
    const m = maxOverlap(shots)
    if (m >= 2) this.overlapped++
    if (m > this.maxSeen) this.maxSeen = m
    this.outcomes.set(outcome, (this.outcomes.get(outcome) ?? 0) + 1)
  }
  report(label: string) {
    const dist = [...this.outcomes].map(([k, v]) => `${k}×${v}`).join('、')
    note(`${label}：${this.rounds} 輪，其中 ${this.overlapped} 輪請求在途時間窗真的重疊`
      + `（最高同時 ${this.maxSeen} 個）；結果分佈 ${dist}`)
  }
}

/* ---------------- 不變式 ---------------- */

let platform = ''
const reconcile = async () => (await call(platform, '/v1/admin/reconcile')).body as
  { total: number; issued: number; drift: number; reserved: number }

let baselineDrift = 0

async function negatives() {
  return sql<{ user_id: string; bal: string }[]>`
    select user_id, sum(delta)::text as bal from points_ledger
     group by user_id having sum(delta) < 0`
}

/** 每一組壓完都要跑。drift 不變 + 沒有人的餘額是負的 */
async function invariants(label: string) {
  const r = await reconcile()
  ck(`${label}：drift 不變（${r.drift}）`, r.drift === baselineDrift,
    `基準 ${baselineDrift} → 現在 ${r.drift}；total=${r.total} issued=${r.issued}`)
  const neg = await negatives()
  ck(`${label}：沒有人的餘額變成負的`, neg.length === 0,
    neg.map(n => `${n.user_id}=${n.bal}`).join('、'))
}

/** 診斷用：把一張卡的三個面向一次印出來 —— 卡、結算、那筆結算的所有分錄 */
async function dump(prizeId: string, why: string) {
  const [pz] = await sql`select id, user_id, status, pool_id, seat from prizes where id = ${prizeId}`
  const [st] = await sql`
    select id, seller_id, buyer_id, status, amount, fee, ship_due_at, shipped_at,
           ship_default_at, closed_at, closed_by
      from pool_settlements where prize_id = ${prizeId}`
  const led = st
    ? await sql`select user_id, delta, reason from points_ledger where ref_id = ${st.id as string} order by reason, user_id`
    : []
  const sh = await sql`select id, status from shipments where ${prizeId} = any(prize_ids)`
  console.error(`        ↳ ${why}`)
  console.error(`          prize      ${JSON.stringify(pz)}`)
  console.error(`          settlement ${JSON.stringify(st)}`)
  console.error(`          ledger     ${JSON.stringify(led)}`)
  console.error(`          shipments  ${JSON.stringify(sh)}`)
}

/**
 * Postgres 自己數的死鎖次數。
 *
 * 這是唯一看得見 V-1 的計數器：40P01 在讀清單那兩條路上被
 * `.catch(() => {})` 吞掉（routes/prizes.ts:36、routes/sellers.ts:115），
 * 端點照樣回 200；就算沒被吞掉，HTTP 那端也只看得到一個沒有內容的 500。
 * 真正的 detail（哪兩個 process、卡在哪一張表的哪一個 tuple）只會出現在
 * **伺服器的 stdout**，所以這個數字一跳，就要回頭去看那份 log。
 */
const deadlocks = async () => Number(
  (await sql<{ n: string }[]>`
    select deadlocks::text as n from pg_stat_database where datname = current_database()`)[0]?.n ?? 0)

/**
 * 賣家的可動用點數。
 *
 * 刻意在測試裡重算一次而不是打端點：`/v1/wallet` 只回自己的錢包，
 * 而 V-2 要在「別人是賣家」的情況下把他的可動用**調到剛好差一點**。
 * 算式逐條對著 money.ts 的 walletOf() 抄 —— 那邊改了這裡要跟著改，
 * 所以下面 V-2 第一輪會拿賣家自己的 /v1/wallet 對照一次。
 */
async function availableOf(userId: string) {
  const [r] = await sql<{ points: string; reserved: string; locked: string }[]>`
    select
      (select coalesce(sum(delta),0) from points_ledger where user_id = ${userId})::text as points,
      (select coalesce(sum(amount),0) from pool_settlements
        where seller_id = ${userId} and status in ('held','awaiting_ship','shipped'))::text as reserved,
      (select coalesce(sum(x),0) from (
         select price   as x from orders where buyer_id  = ${userId} and status in ('escrowed','shipped','delivered','disputed')
         union all
         select deposit as x from orders where seller_id = ${userId} and status in ('escrowed','shipped','delivered','disputed')
         union all
         select points  as x from trade_offers where from_user = ${userId} and status = 'pending'
       ) t)::text as locked`
  const points = Number(r?.points ?? 0), reserved = Number(r?.reserved ?? 0), locked = Number(r?.locked ?? 0)
  return { points, reserved, available: points - reserved - locked }
}

/* ---------------- 佈景：帳號、籤位 ---------------- */

platform = await login('platform', 'VaultDraw 官方')
const grant = (userId: string, points: number) =>
  call(platform, '/v1/admin/grant', { userId, points, note: `race ${runId}` })

/** 開一個這一輪專屬的帳號並給點數 */
async function actor(tag: string, points = 5_000_000) {
  const handle = `rc${runId}${tag}`
  const token = await login(handle, `壓測 ${tag}`)
  if (points > 0) await grant(`u-${handle}`, points)
  return { token, id: `u-${handle}`, handle }
}

interface Seat {
  poolId: string; seat: number; buyback: number; ticket: number; sellerId: string
}

/*
 * 籤位分兩堆，而且**依賣家分開**。
 *
 * 一般情境（1〜7）要的是「回收一定付得出來」：買回價 ≤ 票價時，賣家在
 * 回收前後的可動用只增不減（收了票金 T、付出買回價 B ≤ T），所以永遠不會
 * 意外撞進 SELLER_UNFUNDED 而把測試結果換成另一件事。
 *
 * V-2 要的剛好相反：買回價 > 票價，才有辦法把賣家的可動用調到差一點。
 * 而且那個調整只在「這個賣家的可動用完全由這支測試控制」時才算得準 ——
 * 所以 V-2 專用的賣家（u-official / u-vaultkeeper / u-grade10，種子沒有
 * 發給他們任何點數）不給其他情境用，其他情境只用 u-shop / u-seller 的池。
 */
const seatRows = await sql<{
  pool_id: string; seat: number; buyback: string; ticket_price: string; seller_id: string
}[]>`
  select ps.pool_id, ps.seat, pp.buyback::text as buyback,
         p.ticket_price::text as ticket_price, p.seller_id
    from pool_seats ps
    join pool_prizes pp on pp.id = ps.prize_id
    join pools p on p.id = ps.pool_id
   where ps.taken_by is null and p.status = 'open' and pp.buyback is not null
   order by p.ticket_price asc, ps.pool_id, ps.seat`
const allSeats: Seat[] = seatRows.map(r => ({
  poolId: r.pool_id, seat: Number(r.seat), buyback: Number(r.buyback),
  ticket: Number(r.ticket_price), sellerId: r.seller_id
}))

const PLAIN_SELLERS = new Set(['u-shop', 'u-seller'])
const plain = allSeats.filter(s => PLAIN_SELLERS.has(s.sellerId) && s.buyback <= s.ticket)
/* V-2 的籤位：買回價 > 票價。
   為什麼一定要 buyback > ticket：要做出「剛好差一點」，賣家在回收當下的
   可動用必須是 buyback − 1，而那一刻的可動用至少是這筆結算的 amount（＝票價）。
   買回價不大於票價的籤位，「差一點」根本做不出來。
   排序無所謂 —— 每一輪結束時那個賣家的可動用都會回到 0（見 V-2 的說明）。 */
const unfunded = allSeats.filter(s => s.buyback > s.ticket)

/*
 * 籤位按賣家分成幾條佇列，不是一條扁平的清單。
 *
 * 7b 要「同一張出貨單上三張卡都是同一個賣家」。用扁平清單 + 「不是同一個賣家
 * 就跳過」寫的第一版把籤位燒光了：跨過賣家邊界之後，已經收進手裡的那一張
 * 永遠等不到同賣家的下一張，於是之後每一個籤位都被丟掉。
 * 分佇列之後「拿 n 個同賣家的」是查詢而不是碰運氣，一個籤位都不會浪費。
 *
 * 每次挑剩最多的那個賣家，讓兩條佇列一起見底 —— 不然先用完的那一邊會讓
 * 「拿 n 個同賣家」提早失敗，而另一邊還剩一大半。
 */
const queues = new Map<string, Seat[]>()
for (const s of plain) {
  const q = queues.get(s.sellerId)
  if (q) q.push(s); else queues.set(s.sellerId, [s])
}
let seatsUsed = 0
function pickQueue(min: number): Seat[] {
  let best: Seat[] | null = null
  for (const q of queues.values()) if (q.length >= min && (!best || q.length > best.length)) best = q
  if (!best) {
    throw new Error(`籤位用完了：要 ${min} 個同賣家的，已用 ${seatsUsed} / ${plain.length}`
      + `（各賣家剩 ${[...queues].map(([k, v]) => `${k}:${v.length}`).join('、')}）—— 請開一個新的乾淨庫再跑`)
  }
  return best
}
/** 拿一個籤位 */
const nextSeat = (): Seat => { seatsUsed++; return pickQueue(1).shift()! }
/** 拿 n 個**同一個賣家**的籤位 */
const nextSeatsSameSeller = (n: number): Seat[] => { seatsUsed += n; return pickQueue(n).splice(0, n) }

/** 抽指定的那一格，回傳卡冊裡那一列的 id */
async function drawSeat(token: string, s: Seat): Promise<string> {
  const r = await call(token, `/v1/pools/${s.poolId}/draw`,
    { seats: [s.seat], idempotencyKey: `race-${runId}-${seq++}` })
  if (r.status !== 200) throw new Error(`draw ${s.poolId}#${s.seat}: ${r.status} ${r.text}`)
  const stashId = r.body?.items?.[0]?.stashId as string | undefined
  if (!stashId) throw new Error(`draw 沒有回 stashId: ${r.text}`)
  return stashId
}

const settlementOf = async (prizeId: string) => {
  const [st] = await sql<{ id: string; status: string; amount: string }[]>`
    select id, status, amount::text as amount from pool_settlements where prize_id = ${prizeId}`
  return st
}
const prizeStatus = async (prizeId: string) => {
  const [p] = await sql<{ status: string; user_id: string }[]>`
    select status, user_id from prizes where id = ${prizeId}`
  return p
}

const ADDRESS = { name: '壓測收件', phone: '0912345678', line1: '併發路 1 號', city: '台北市' }

const sellerHandles = new Map<string, string>(
  (await sql<{ id: string; handle: string }[]>`select id, handle from users`).map(u => [u.id, u.handle]))
const sellerToken = new Map<string, string>()
async function asSeller(sellerId: string) {
  const cached = sellerToken.get(sellerId)
  if (cached) return cached
  const h = sellerHandles.get(sellerId)
  if (!h) throw new Error(`找不到賣家 ${sellerId} 的 handle`)
  const t = await login(h, '賣家')
  sellerToken.set(sellerId, t)
  return t
}

/* ==================================================================
   開場：記下基準
   ================================================================== */
head('開場')
{
  const r = await reconcile()
  baselineDrift = r.drift
  ck('對帳基準取得', typeof r.drift === 'number', JSON.stringify(r))
  note(`drift 基準 = ${baselineDrift}（total=${r.total}、issued=${r.issued}、reserved=${r.reserved}）`)
  note(`可用籤位：一般 ${plain.length} 個（賣家 ${[...PLAIN_SELLERS].join('/')}），`
    + `V-2 專用 ${unfunded.length} 個`)
  ck('drift 起點是 0（乾淨的庫）', r.drift === 0, `drift=${r.drift}`)
  const neg = await negatives()
  ck('起點沒有負餘額', neg.length === 0, JSON.stringify(neg))
}

/* 每一組跑幾輪。可以用 RACE_ROUNDS 調高，但**籤位是消耗品** ——
   20 輪就會吃掉種子 267 個籤位裡的 224 個，調高到 30 以上就會在中途
   用完而不是失敗，讀輸出時會以為某幾組「通過」了。
   要累積更多輪數的正確作法是開新的乾淨庫重跑，不是把這個數字調大。 */
const ROUNDS = Number(process.env.RACE_ROUNDS) || 20

/* ==================================================================
   1 同一個籤位兩人同搶
   ------------------------------------------------------------------
   只能有一個成功，其餘拿 SEATS_TAKEN，而且**輸的那個不能被扣款**。
   後半句才是這一組真正在驗的東西：draw() 的順序是「先扣款、再搶籤位」
   （pools-service.ts 的 credit 在 claimed 檢查之後，但整筆是同一個交易），
   搶輸時靠外層 throw 讓 sql.begin 回滾。回滾漏掉的話畫面上看不出來 ——
   使用者只會覺得「抽輸了還被扣錢」。
   ================================================================== */
head('1 同一個籤位 N 人同搶')
{
  const N = 6
  const buyers = await Promise.all(
    Array.from({ length: N }, (_, i) => actor(`s1b${i}`, 2_000_000)))
  const st = new Stat()
  let chargedLoser = 0

  for (let round = 0; round < ROUNDS; round++) {
    const seat = nextSeat()
    const before = await Promise.all(buyers.map(async b => (await availableOf(b.id)).points))

    const shots = await together(buyers.map((b, i) => ({
      label: `b${i}`,
      run: () => call(b.token, `/v1/pools/${seat.poolId}/draw`,
        { seats: [seat.seat], idempotencyKey: `race-${runId}-s1-${round}-${i}` })
    })))

    const won = shots.filter(s => s.value?.status === 200)
    const taken = shots.filter(s => s.value?.status === 409 && s.value.body?.error === 'SEATS_TAKEN')
    const other = shots.filter(s => !won.includes(s) && !taken.includes(s))

    if (won.length !== 1 || other.length) {
      ck(`第 ${round + 1} 輪只有一個人搶到`, false,
        `贏 ${won.length}、SEATS_TAKEN ${taken.length}、其他 ${other.length}：`
        + JSON.stringify(other.map(o => o.value?.status ?? String(o.err))))
      console.error(`        ↳ ${seat.poolId}#${seat.seat}`)
    }

    const after = await Promise.all(buyers.map(async b => (await availableOf(b.id)).points))
    for (let i = 0; i < N; i++) {
      const isWinner = shots[i]!.value?.status === 200
      const delta = after[i]! - before[i]!
      if (!isWinner && delta !== 0) {
        chargedLoser++
        console.error(`        ↳ 輸的人被扣款：${buyers[i]!.id} ${before[i]} → ${after[i]}`
          + `（${seat.poolId}#${seat.seat}、票價 ${seat.ticket}）`)
      }
      if (isWinner && delta !== -seat.ticket) {
        ck(`第 ${round + 1} 輪贏家扣款正確`, false, `delta=${delta}、票價=${seat.ticket}`)
      }
    }
    st.round(shots, won.length === 1 ? `1贏${taken.length}擋` : `異常(贏${won.length})`)
  }

  ck('每一輪都只有一個人搶到，其餘一律 SEATS_TAKEN', st.outcomes.has(`1贏${N - 1}擋`)
    && st.outcomes.get(`1贏${N - 1}擋`) === ROUNDS,
    [...st.outcomes].map(([k, v]) => `${k}×${v}`).join('、'))
  ck('搶輸的人一毛都沒有被扣', chargedLoser === 0, `${chargedLoser} 次`)
  st.report('籤位同搶')
  await invariants('1 籤位同搶')
}

/* ==================================================================
   2 同一筆結算：回收 vs 申請出貨（V-3 的前半）
   ------------------------------------------------------------------
   兩條路都先鎖 prizes 那一列、都要求 status='stashed'，所以推論上
   先到的把狀態改掉、後到的必然退出。這一組把那句推論送去撞。
   兩邊都成功 = 卡同時被回收又進了出貨佇列 —— 買家拿了買回價，
   賣家還收到一張要寄的單。
   ================================================================== */
head('2 同一筆結算：回收 vs 申請出貨')
{
  const buyer = await actor('s2', 20_000_000)
  const st = new Stat()
  let bothWon = 0
  const K = 3   // 每一側各 3 個 —— 一輪同時 6 個請求打同一張卡

  for (let round = 0; round < ROUNDS; round++) {
    const seat = nextSeat()
    const prizeId = await drawSeat(buyer.token, seat)

    /* 兩側的送出順序逐輪對調。Promise.all 是同一個 tick 內排好的，
       但排在前面的那幾個 fetch 早幾微秒出門 —— 固定順序的話 20 輪會有
       十幾輪都是同一邊贏，另一條分支的收尾檢查等於沒跑到。
       對調的是**到達順序**，不是任何產品行為。 */
    const recycleJobs = Array.from({ length: K }, (_, i) => ({
      label: `recycle${i}`,
      run: () => call(buyer.token, `/v1/prizes/${prizeId}/recycle`, {})
    }))
    const shipJobs = Array.from({ length: K }, (_, i) => ({
      label: `ship${i}`,
      run: () => call(buyer.token, '/v1/prizes/ship', { prizeIds: [prizeId], address: ADDRESS })
    }))
    const recycleFirst = round % 2 === 0
    const shots = await together(recycleFirst ? [...recycleJobs, ...shipJobs] : [...shipJobs, ...recycleJobs])
    const recShots = recycleFirst ? shots.slice(0, K) : shots.slice(K)
    const shipShots = recycleFirst ? shots.slice(K) : shots.slice(0, K)
    const recWins = recShots.filter(s => s.value?.status === 200)
    const shipWins = shipShots.filter(s => s.value?.status === 200)
    const rec = recShots[0]!.value!, ship = shipShots[0]!.value!
    const recOk = recWins.length > 0, shipOk = shipWins.length > 0
    if (recWins.length > 1 || shipWins.length > 1) {
      ck(`第 ${round + 1} 輪同一側沒有重複成功`, false,
        `回收成功 ${recWins.length} 次、申請出貨成功 ${shipWins.length} 次`)
      await dump(prizeId, '同一側重複成功')
    }

    const s = await settlementOf(prizeId)
    const p = await prizeStatus(prizeId)

    if (recOk && shipOk) {
      bothWon++
      await dump(prizeId, `第 ${round + 1} 輪：回收與申請出貨**同時成功**`)
    } else if (!recOk && !shipOk) {
      ck(`第 ${round + 1} 輪至少有一邊成功`, false,
        `recycle ${rec.status} ${rec.text.slice(0, 120)} / ship ${ship.status} ${ship.text.slice(0, 120)}`)
      await dump(prizeId, '兩邊都失敗')
    } else if (recOk) {
      const good = s?.status === 'recycled' && p?.status === 'recycled'
      if (!good) { ck(`第 ${round + 1} 輪回收贏、狀態一致`, false, `settlement=${s?.status} prize=${p?.status}`); await dump(prizeId, '回收贏但狀態不一致') }
    } else {
      const good = s?.status === 'awaiting_ship' && p?.status === 'ship_requested'
      if (!good) { ck(`第 ${round + 1} 輪出貨贏、狀態一致`, false, `settlement=${s?.status} prize=${p?.status}`); await dump(prizeId, '出貨贏但狀態不一致') }
    }
    st.round(shots, recOk && shipOk ? '兩邊都成功' : recOk ? '回收贏' : shipOk ? '出貨贏' : '兩邊都敗')
  }

  ck('回收與申請出貨從來沒有同時成功', bothWon === 0, `${bothWon} 輪`)
  st.report('回收 vs 申請出貨')
  await invariants('2 回收vs出貨申請')
}

/* ==================================================================
   3 同一筆結算：逾期退款（掃描）vs 賣家標出貨（V-3 的後半）
   ------------------------------------------------------------------
   這一組是 V-1 環上唯一真的會動 prizes 的 sweep 分支（refund()），
   所以它同時也是 V-1 最可能咬人的組合。
   兩邊都成功 = 買家拿了退款、賣家還是把卡寄出去了。
   ================================================================== */
head('3 同一筆結算：逾期退款 vs 賣家標出貨')
{
  const buyer = await actor('s3', 20_000_000)
  const st = new Stat()
  const K = 3
  let bothWon = 0, http500 = 0, headStartRounds = 0
  /* 掃描那一側慢很多：sweepSettlements 先做一次無鎖候選掃描（會掃過這個
     使用者名下**所有**未結案的結算），賣家出貨那支只有三個查詢。
     不做任何事的話 20 輪會 20 次都是出貨贏 —— 那不是「兩邊都驗過了」，
     是「只驗到其中一條分支」。所以單數輪讓掃描先起跑一小段，
     長度取上一輪掃描實際耗時的六成（仍然遠短於掃描本身，時間窗照樣重疊）。
     這是調整**到達時間**，不是改任何產品行為 —— 真實世界的到達時間本來就是隨機的。 */
  let lastSweepMs = 30

  for (let round = 0; round < ROUNDS; round++) {
    const seat = nextSeat()
    const prizeId = await drawSeat(buyer.token, seat)
    const sr = await call(buyer.token, '/v1/prizes/ship', { prizeIds: [prizeId], address: ADDRESS })
    if (sr.status !== 200) throw new Error(`佈景失敗：申請出貨 ${sr.status} ${sr.text}`)
    // 把出貨期限撥到 96 小時前（期限是 72 小時）—— 掃描一碰就該退款
    await dev('rewind-settlement', { prizeId, ms: 96 * 3_600_000 })

    const s0 = await settlementOf(prizeId)
    const seller = await asSeller(seat.sellerId)
    const headStart = round % 2 === 1 ? Math.max(1, Math.round(lastSweepMs * 0.6)) : 0
    if (headStart) headStartRounds++

    const shots = await together([
      /* 讀卡冊會觸發 sweepSettlements(tx, buyerId)。刻意用產品路徑而不是
         直接呼叫掃描 —— 正式環境的退款絕大多數就是這樣被觸發的。 */
      ...Array.from({ length: K }, (_, i) => ({
        label: `sweep${i}`,
        run: () => call(buyer.token, '/v1/prizes?limit=1')
      })),
      /* 不帶單號 —— 單號在這一段不是放款條件（見 routes/sellers.ts 的 ShipOne），
         帶了只是多一條 validateTracking 的失敗可能，會把「誰贏」換成「格式錯」。 */
      ...Array.from({ length: K }, (_, i) => ({
        label: `ship${i}`,
        run: async () => { if (headStart) await sleep(headStart); return call(seller, `/v1/seller/settlements/${s0!.id}/ship`, {}) }
      }))
    ])
    lastSweepMs = Math.max(1, Math.round(
      shots.slice(0, K).reduce((a, s) => a + (s.end - s.start), 0) / K))
    const sweeps = shots.slice(0, K).map(s => s.value!)
    const ships = shots.slice(K).map(s => s.value!)
    const shipWins = ships.filter(x => x.status === 200)
    if (shipWins.length > 1) {
      ck(`第 ${round + 1} 輪賣家出貨沒有重複成功`, false, `${shipWins.length} 次 200`)
      await dump(prizeId, '賣家出貨重複成功')
    }
    const bad5xx = [...sweeps, ...ships].filter(x => x.status >= 500)
    if (bad5xx.length) {
      http500 += bad5xx.length
      console.error(`        ↳ 第 ${round + 1} 輪有 5xx：`
        + JSON.stringify(bad5xx.map(x => `${x.status} ${x.text.slice(0, 120)}`)))
    }

    const s = await settlementOf(prizeId)
    const p = await prizeStatus(prizeId)
    const refundLed = await sql<{ n: string }[]>`
      select count(*)::text as n from points_ledger
       where ref_id = ${s0!.id} and reason = 'pool-refund'`
    const refunds = Number(refundLed[0]?.n ?? 0)

    let outcome: string
    if (s?.status === 'refunded') {
      outcome = '退款贏'
      /* 退款贏的話賣家那三個出貨請求一個都不能成功 —— 有一個 200
         就是「錢退給買家了，卡也寄出去了」。 */
      const good = p?.status === 'refunded' && refunds === 1 && shipWins.length === 0
      if (!good) {
        if (shipWins.length) bothWon++
        ck(`第 ${round + 1} 輪退款贏、狀態一致`, false,
          `prize=${p?.status}、pool-refund 分錄 ${refunds} 筆、`
          + `賣家出貨回 ${JSON.stringify(ships.map(x => x.status))}`)
        await dump(prizeId, '退款贏但收尾不一致')
      }
    } else if (s?.status === 'shipped') {
      outcome = '出貨贏'
      const good = p?.status === 'shipped' && refunds === 0 && shipWins.length === 1
      if (!good) {
        if (refunds > 0) bothWon++
        ck(`第 ${round + 1} 輪出貨贏、沒有退款`, false,
          `prize=${p?.status}、pool-refund 分錄 ${refunds} 筆、出貨成功 ${shipWins.length} 次`)
        await dump(prizeId, '出貨贏卻同時退了款')
      }
    } else {
      outcome = `異常(${s?.status})`
      ck(`第 ${round + 1} 輪結算走到終局`, false, `settlement=${s?.status}`)
      await dump(prizeId, '既沒退款也沒出貨')
    }
    st.round(shots, outcome)
  }

  ck('退款與出貨從來沒有同時成立', bothWon === 0, `${bothWon} 輪`)
  ck('這一組沒有出現 5xx', http500 === 0, `${http500} 次`)
  st.report('逾期退款 vs 賣家出貨')
  note(`其中 ${headStartRounds} 輪刻意讓掃描先起跑（最後一輪的讓步 ${Math.round(lastSweepMs * 0.6)}ms、`
    + `掃描本身平均 ${lastSweepMs}ms）——`
    + '不這樣做的話賣家出貨每一次都先到，只會驗到其中一條分支')
  await invariants('3 退款vs賣家出貨')
}

/* ==================================================================
   4 同一張卡：上架 vs 回收
   ------------------------------------------------------------------
   兩邊都成功 = 卡被回收（買家拿了買回價）之後還掛在市場上賣。
   ================================================================== */
head('4 同一張卡：上架 vs 回收')
{
  const buyer = await actor('s4', 20_000_000)
  const st = new Stat()
  const K = 3
  let bothWon = 0

  for (let round = 0; round < ROUNDS; round++) {
    const seat = nextSeat()
    const prizeId = await drawSeat(buyer.token, seat)

    // 送出順序逐輪對調，理由同上一組
    const listJobs = Array.from({ length: K }, (_, i) => ({
      label: `list${i}`,
      run: () => call(buyer.token, '/v1/listings', { prizeId, price: 100 })
    }))
    const recycleJobs = Array.from({ length: K }, (_, i) => ({
      label: `recycle${i}`,
      run: () => call(buyer.token, `/v1/prizes/${prizeId}/recycle`, {})
    }))
    const listFirst = round % 2 === 0
    const shots = await together(listFirst ? [...listJobs, ...recycleJobs] : [...recycleJobs, ...listJobs])
    const listShots = listFirst ? shots.slice(0, K) : shots.slice(K)
    const recShots = listFirst ? shots.slice(K) : shots.slice(0, K)
    const listWins = listShots.filter(s => s.value?.status === 200)
    const recWins = recShots.filter(s => s.value?.status === 200)
    const list = listShots[0]!.value!, rec = recShots[0]!.value!
    const listOk = listWins.length > 0, recOk = recWins.length > 0
    if (listWins.length > 1 || recWins.length > 1) {
      ck(`第 ${round + 1} 輪同一側沒有重複成功`, false,
        `上架成功 ${listWins.length} 次、回收成功 ${recWins.length} 次`)
      await dump(prizeId, '同一側重複成功')
    }

    const p = await prizeStatus(prizeId)
    const live = await sql<{ n: string }[]>`
      select count(*)::text as n from listings where prize_id = ${prizeId} and status = 'live'`

    if (listOk && recOk) {
      bothWon++
      await dump(prizeId, `第 ${round + 1} 輪：上架與回收**同時成功**（live 掛單 ${live[0]?.n} 筆）`)
    } else if (!listOk && !recOk) {
      ck(`第 ${round + 1} 輪至少有一邊成功`, false, `list ${list.status} / recycle ${rec.status}`)
      await dump(prizeId, '兩邊都失敗')
    } else if (recOk) {
      const good = p?.status === 'recycled' && Number(live[0]?.n) === 0
      if (!good) { ck(`第 ${round + 1} 輪回收贏、卡沒有留在市場上`, false, `prize=${p?.status}、live 掛單 ${live[0]?.n}`); await dump(prizeId, '回收贏但市場上還有掛單') }
    } else {
      const good = p?.status === 'listed' && Number(live[0]?.n) === 1
      if (!good) { ck(`第 ${round + 1} 輪上架贏、只留下一筆掛單`, false, `prize=${p?.status}、live 掛單 ${live[0]?.n}`); await dump(prizeId, '上架贏但狀態不一致') }
    }
    st.round(shots, listOk && recOk ? '兩邊都成功' : listOk ? '上架贏' : recOk ? '回收贏' : '兩邊都敗')
  }

  ck('上架與回收從來沒有同時成功', bothWon === 0, `${bothWon} 輪`)
  st.report('上架 vs 回收')
  await invariants('4 上架vs回收')
}

/* ==================================================================
   5 同一筆掛單兩人同時買
   ------------------------------------------------------------------
   只能成交一筆。兩筆都成交 = 一張卡賣兩次，而且第二個買家的點數
   有去無回（庫內轉移的 vault-buy 分錄不帶 on conflict，同一個 ref_id
   換一個 user_id 就寫得進去 —— 唯一的防線是那筆掛單的 FOR UPDATE）。
   ================================================================== */
head('5 同一筆掛單 N 人同時買')
{
  const N = 5
  const lister = await actor('s5l', 20_000_000)
  const buyers = await Promise.all(Array.from({ length: N }, (_, i) => actor(`s5b${i}`, 2_000_000)))
  const st = new Stat()
  let doubleSold = 0

  for (let round = 0; round < ROUNDS; round++) {
    const seat = nextSeat()
    const prizeId = await drawSeat(lister.token, seat)
    const lr = await call(lister.token, '/v1/listings', { prizeId, price: 100 })
    if (lr.status !== 200) throw new Error(`佈景失敗：上架 ${lr.status} ${lr.text}`)
    const listingId = lr.body.listing.id as string

    const shots = await together(buyers.map((b, i) => ({
      label: `b${i}`,
      run: () => call(b.token, '/v1/orders',
        { listingId, idempotencyKey: `race-${runId}-s5-${round}-${i}` })
    })))
    const won = shots.filter(s => s.value?.status === 200)
    const takenErr = shots.filter(s => s.value?.body?.error === 'LISTING_TAKEN')

    const led = await sql<{ user_id: string; delta: string; reason: string }[]>`
      select user_id, delta::text as delta, reason from points_ledger where ref_id = ${listingId}`
    const buys = led.filter(l => l.reason === 'vault-buy')
    const owner = (await prizeStatus(prizeId))?.user_id

    if (won.length !== 1 || buys.length !== 1) {
      doubleSold++
      ck(`第 ${round + 1} 輪只成交一筆`, false,
        `成功 ${won.length} 筆、vault-buy 分錄 ${buys.length} 筆、卡現在屬於 ${owner}`)
      console.error(`        ↳ listing ${listingId} 的分錄：${JSON.stringify(led)}`)
    }
    if (won.length === 1) {
      const winnerId = buyers[shots.indexOf(won[0]!)]!.id
      if (owner !== winnerId) {
        ck(`第 ${round + 1} 輪卡過戶給贏家`, false, `贏家 ${winnerId}、卡卻在 ${owner}`)
      }
    }
    st.round(shots, won.length === 1 ? `1成交${takenErr.length}擋` : `異常(成交${won.length})`)
  }

  ck('同一筆掛單從來沒有成交兩次', doubleSold === 0, `${doubleSold} 輪`)
  st.report('同一筆掛單同搶')
  await invariants('5 掛單同搶')
}

/* ==================================================================
   6 餘額剛好只夠一筆，同時買兩筆（lockSpender 守的就是這個）
   ------------------------------------------------------------------
   兩筆都成交 = 平台憑空發行了一筆點數（money.ts 的 lockSpender 註解
   把這條路寫得很清楚）。這一組直接把那段註解送去撞。
   每一輪換一個全新的買家，點數 grant 成**剛好一筆的價錢**。
   ================================================================== */
head('6 餘額只夠一筆，同時買兩筆')
{
  const lister = await actor('s6l', 20_000_000)
  const PRICE = 777
  /* 三筆掛單，一輪最多只會賣掉一筆 —— 沒賣掉的下一輪還在，
     所以每輪只需要補一張新的卡。 */
  const listings: string[] = []
  async function freshListing() {
    const prizeId = await drawSeat(lister.token, nextSeat())
    const lr = await call(lister.token, '/v1/listings', { prizeId, price: PRICE })
    if (lr.status !== 200) throw new Error(`佈景失敗：上架 ${lr.status} ${lr.text}`)
    return lr.body.listing.id as string
  }
  listings.push(await freshListing(), await freshListing(), await freshListing())

  const st = new Stat()
  let doubleSpend = 0, negativeSeen = 0

  for (let round = 0; round < ROUNDS; round++) {
    const buyer = await actor(`s6b${round}`, PRICE)   // 剛好一筆的錢，一點不多
    const before = (await availableOf(buyer.id)).points
    if (before !== PRICE) throw new Error(`佈景失敗：買家餘額應該是 ${PRICE}，實際 ${before}`)

    const shots = await together(listings.map((id, i) => ({
      label: `buy${i}`,
      run: () => call(buyer.token, '/v1/orders',
        { listingId: id, idempotencyKey: `race-${runId}-s6-${round}-${i}` })
    })))
    const won = shots.filter(s => s.value?.status === 200)
    const poor = shots.filter(s => s.value?.body?.error === 'INSUFFICIENT_POINTS')

    const after = await availableOf(buyer.id)
    if (won.length !== 1 || after.points !== 0) {
      doubleSpend++
      ck(`第 ${round + 1} 輪只成交一筆`, false,
        `成交 ${won.length} 筆、買家餘額 ${before} → ${after.points}`)
      const led = await sql`select user_id, delta, reason, ref_id from points_ledger where user_id = ${buyer.id}`
      console.error(`        ↳ 買家分錄：${JSON.stringify(led)}`)
    }
    if (after.points < 0) {
      negativeSeen++
      console.error(`        ↳ 第 ${round + 1} 輪買家餘額變成負的：${after.points}`)
    }

    // 補回被買走的那一筆
    for (let i = 0; i < listings.length; i++) {
      const [l] = await sql<{ status: string }[]>`select status from listings where id = ${listings[i]!}`
      if (l?.status !== 'live') listings[i] = await freshListing()
    }
    st.round(shots, won.length === 1 ? `1成交${poor.length}擋` : `異常(成交${won.length})`)
  }

  ck('同一筆錢從來沒有被花兩次', doubleSpend === 0, `${doubleSpend} 輪`)
  ck('買家的餘額一次都沒有變成負的', negativeSeen === 0, `${negativeSeen} 輪`)
  st.report('雙花')
  await invariants('6 雙花')
}

/* ==================================================================
   7 V-1 專項：sweep 與回收高頻交錯
   ------------------------------------------------------------------
   要找的是 Postgres 的 40P01（死鎖）。
   **不能只看 HTTP 狀態碼**：讀卡冊與讀賣家結算頁那兩處的 sweep 都是
   `.catch(() => {})`（routes/prizes.ts:36、routes/sellers.ts:115），
   死鎖被吞掉之後端點照樣回 200。所以這一組的主證據是
   `pg_stat_database.deadlocks` 的差值；行程內直接跑的
   `sweepSettlementsAll()` 是第二個證據（那裡沒有人 catch，40P01 會原樣拋出來）。
   ================================================================== */
head('7 V-1 專項：sweep × 回收高頻交錯')
{
  const buyer = await actor('s7', 30_000_000)
  const st = new Stat()
  const sellerTokens = await Promise.all([...PLAIN_SELLERS].map(async sid =>
    ({ sid, token: await asSeller(sid) })))
  const SWEEPS = 4, READS = 3
  const perRound = SWEEPS + 1 /* 回收 */ + READS + sellerTokens.length
  const before = await deadlocks()
  let sweepErrs = 0, http5xx = 0, rounds = 0, refunded = 0
  let seenDl = before, deadlockRounds = 0
  const errSamples: string[] = []

  for (let round = 0; round < ROUNDS; round++) {
    /* 每一輪重新造料：
       - 1 張「已申請出貨且已逾期」→ 掃描會走到 refund()，那是 sweep 這一側
         唯一真的會 `update prizes` 的分支（V-1 的環就在那裡）
       - 1 張「保管中」→ 回收那一側的目標
       只造兩張是為了把籤位留給 7b（那一組一輪要三張）；併發密度靠掃描與
       讀取的份數撐，那些不吃籤位。 */
    {
      const id = await drawSeat(buyer.token, nextSeat())
      await call(buyer.token, '/v1/prizes/ship', { prizeIds: [id], address: ADDRESS })
      await dev('rewind-settlement', { prizeId: id, ms: 96 * 3_600_000 })
    }
    const stashed = [await drawSeat(buyer.token, nextSeat())]

    const jobs: { label: string; run: () => Promise<unknown> }[] = []
    /* 全域掃描：一筆交易裡逐一鎖過所有到期的結算 —— V-1 環上最兇的一邊。
       跑好幾個是為了讓「兩個掃描以不同順序拿到同一批列」也進到壓測範圍：
       候選名單沒有 ORDER BY，兩筆同時跑的交易不保證照同一個順序上鎖。 */
    for (let i = 0; i < SWEEPS; i++) {
      jobs.push({
        label: `sweepAll${i}`,
        run: async () => {
          try { return await sweepSettlementsAll() } catch (e) {
            sweepErrs++
            const err = e as { code?: string; message?: string }
            const msg = `sweepAll code=${err.code ?? '-'} ${err.message ?? String(e)}`
            if (errSamples.length < 10) errSamples.push(msg.slice(0, 200))
            return null   // 這裡吞掉：要的是計數，不是讓整組停下來
          }
        }
      })
    }
    // 回收：卡 → 結算，跟掃描同一個方向（統一鎖序之後應該是同向）
    for (const id of stashed) {
      jobs.push({ label: 'recycle', run: () => call(buyer.token, `/v1/prizes/${id}/recycle`, {}) })
    }
    // 讀卡冊：使用者範圍的掃描，正式環境最常觸發 sweep 的路徑
    for (let i = 0; i < READS; i++) {
      jobs.push({ label: `cards${i}`, run: () => call(buyer.token, '/v1/prizes?limit=100') })
    }
    // 賣家結算頁：另一條會觸發 sweep 的讀取路徑
    for (const s of sellerTokens) {
      jobs.push({ label: `seller:${s.sid}`, run: () => call(s.token, '/v1/seller/settlements') })
    }

    const shots = await together(jobs)
    for (const s of shots) {
      const v = s.value as Res | undefined
      if (v && typeof v.status === 'number' && v.status >= 500) {
        http5xx++
        if (errSamples.length < 10) errSamples.push(`${s.label} → ${v.status} ${v.text.slice(0, 160)}`)
      }
      if (s.err && errSamples.length < 10) errSamples.push(`${s.label} threw ${String(s.err).slice(0, 160)}`)
    }
    rounds++
    const nowDl = await deadlocks()
    if (nowDl > seenDl) { deadlockRounds++; seenDl = nowDl }
    st.round(shots, '一輪')
  }

  const after = await deadlocks()
  const delta = after - before
  const [ref] = await sql<{ n: string }[]>`
    select count(*)::text as n from pool_settlements where status = 'refunded'`
  refunded = Number(ref?.n ?? 0)

  st.report('sweep × 回收')
  note(`每輪同時發出 ${perRound} 個請求（${SWEEPS} 個全域掃描 + 1 個回收 + ${READS} 個讀卡冊 + `
    + `${sellerTokens.length} 個賣家結算頁）`)
  note(`跑完時全站已退款的結算共 ${refunded} 筆 —— 掃描確實走到了 refund()（會 update prizes 的那一支）`)
  note(`pg_stat_database.deadlocks：${before} → ${after}（差 ${delta}）`)
  note(`行程內全域掃描拋錯 ${sweepErrs} 次、HTTP 5xx ${http5xx} 次`)
  if (errSamples.length) note(`錯誤樣本：${JSON.stringify(errSamples)}`)

  if (delta === 0 && sweepErrs === 0 && http5xx === 0) {
    ck(`V-1：${rounds} 輪 × ${perRound} 個併發請求，沒有出現任何死鎖（40P01）`, true)
    note('⚠️ 這是「N 輪未重現」，不是「證明不會發生」——'
      + '報告要照這個字面意思寫，不要說成「已驗過不會死鎖」。')
  } else {
    known(`V-1：${rounds} 輪裡有 ${deadlockRounds} 輪重現死鎖或 5xx`, false,
      `deadlocks +${delta}、掃描拋錯 ${sweepErrs}、5xx ${http5xx}；`
      + '40P01 的 detail 在伺服器的 stdout，不在 HTTP 回應裡')
  }

  await invariants('7 V-1 壓測')
}

/* ==================================================================
   7b 已知殘餘的那個環：後台出貨 vs 賣家自助出貨
   ------------------------------------------------------------------
   sweepSettlements 的檔頭自己點名了這一條（「記錄，不處理」）：
     後台   routes/admin.ts:235   先鎖 shipments → 再 update prizes
     賣家   routes/sellers.ts:190 先鎖 prizes    → markShipped 再 update shipments
   方向相反，而且兩邊都會動到同一張出貨單上的多張卡。
   V-1 主環既然已經統一成同向，這一條就是現在唯一剩下的反向環 ——
   把它一起壓完，V-1 的結論才講得完整。
   ------------------------------------------------------------------
   造料：一張出貨單裝三張同一個賣家的卡（後台那一側會一次鎖三列 prizes），
   然後同時發 1 個後台標出貨 + 3 個賣家自助出貨（每張卡一個）。
   ------------------------------------------------------------------
   ⚠️ **這一組是機率性的。** 首次實測（2026-08-31，本機 Postgres 17）：
   10 次完整跑 × 每次 20 輪 = 200 輪，撞到 3 輪（約 1.5%）。三次都一樣：
   後台那一支拿到 40P01 變成 500（`where: while updating tuple in relation "prizes"`），
   賣家那三支照常成功。
   資料本身沒有壞 —— 三張卡、三筆結算、出貨單事後都還是一致的，
   壞的是**後台人員按下去看到一個沒有理由的伺服器錯誤**。
   **某一次跑出 0 不代表它被修好了**，只代表那一次沒抽中。
   要判斷有沒有修好，看的是那兩條路的鎖序有沒有被統一，不是這一組綠不綠。
   ================================================================== */
head('7b 已知殘餘的環：後台出貨 vs 賣家自助出貨')
{
  const buyer = await actor('s7b', 30_000_000)
  const st = new Stat()
  const before = await deadlocks()
  let http5xx = 0, rounds = 0, mismatched = 0
  let seenDl = before, deadlockRounds = 0
  const errSamples: string[] = []
  const PER = 3

  for (let round = 0; round < ROUNDS; round++) {
    /* 三張卡都要同一個賣家 —— 後台那一側鎖的是整張出貨單上的卡，
       賣家那一側一次只碰一張，同一個賣家才形成「多列 × 反向」的環。 */
    const seats = nextSeatsSameSeller(PER)
    const prizeIds: string[] = []
    for (const s of seats) prizeIds.push(await drawSeat(buyer.token, s))
    const sr = await call(buyer.token, '/v1/prizes/ship', { prizeIds, address: ADDRESS })
    if (sr.status !== 200) throw new Error(`佈景失敗：申請出貨 ${sr.status} ${sr.text}`)
    const shipmentId = sr.body.shipmentId as string
    const seller = await asSeller(seats[0]!.sellerId)
    const sts = await Promise.all(prizeIds.map(id => settlementOf(id)))

    const shots = await together([
      {
        label: 'admin',
        run: () => call(platform, `/v1/admin/shipments/${shipmentId}/status`,
          { status: 'shipped', tracking: `RACE${runId}${round}` })
      },
      ...sts.map((s, i) => ({
        label: `seller${i}`,
        run: () => call(seller, `/v1/seller/settlements/${s!.id}/ship`, {})
      }))
    ])
    for (const s of shots) {
      const v = s.value as Res | undefined
      if (v && v.status >= 500) {
        http5xx++
        if (errSamples.length < 10) errSamples.push(`${s.label} → ${v.status} ${v.text.slice(0, 160)}`)
      }
      if (s.err && errSamples.length < 10) errSamples.push(`${s.label} threw ${String(s.err).slice(0, 160)}`)
    }

    /* 不管誰贏，收尾都必須一致：三張卡都 shipped、三筆結算都 shipped、
       出貨單也 shipped。這兩條路做的是同一件事實，只是誰按的不同。 */
    for (let i = 0; i < PER; i++) {
      const p = await prizeStatus(prizeIds[i]!)
      const s2 = await settlementOf(prizeIds[i]!)
      if (p?.status !== 'shipped' || s2?.status !== 'shipped') {
        mismatched++
        ck(`第 ${round + 1} 輪第 ${i + 1} 張卡收尾一致`, false,
          `prize=${p?.status}、settlement=${s2?.status}`)
        await dump(prizeIds[i]!, '後台與賣家同時出貨之後狀態不一致')
      }
    }
    const [sh] = await sql<{ status: string }[]>`select status from shipments where id = ${shipmentId}`
    if (sh?.status !== 'shipped') {
      mismatched++
      ck(`第 ${round + 1} 輪出貨單標成已寄出`, false, `shipment=${sh?.status}`)
    }
    rounds++
    const nowDl = await deadlocks()
    if (nowDl > seenDl) { deadlockRounds++; seenDl = nowDl }
    st.round(shots, '一輪')
  }

  const after = await deadlocks()
  const delta = after - before
  st.report('後台出貨 vs 賣家出貨')
  note(`每輪同時發出 ${1 + PER} 個請求（1 個後台標出貨 + ${PER} 個賣家自助出貨，同一張出貨單）`)
  note(`pg_stat_database.deadlocks：${before} → ${after}（差 ${delta}）`)
  if (errSamples.length) note(`錯誤樣本：${JSON.stringify(errSamples)}`)

  if (delta === 0 && http5xx === 0) {
    ck(`已知殘餘的環：${rounds} 輪 × ${1 + PER} 個併發請求沒有重現死鎖`, true)
  } else {
    /* known-fail 而不是 FAIL：這條在 pool-settlement.ts 的 sweepSettlements
       檔頭已經被記錄成「已知的殘餘（記錄，不處理）」，只是從來沒有人實測過。
       現在它從「理論上仍有一個極窄的環」變成「壓得出來」——
       修不修由人決定，這支不擅自改產品碼。 */
    known(`已知殘餘的環重現了：${rounds} 輪裡有 ${deadlockRounds} 輪撞到`, false,
      `deadlocks +${delta}、5xx ${http5xx}；`
      + '40P01 的 detail（哪兩個 process、卡在 prizes 的哪個 tuple）在伺服器的 stdout')
  }
  ck('後台與賣家同時出貨，收尾始終一致', mismatched === 0, `${mismatched} 處不一致`)
  await invariants('7b 出貨雙路徑')
}

/* ==================================================================
   8 V-2：SELLER_UNFUNDED 併發，而且狀態完全回滾
   ------------------------------------------------------------------
   audit-3 的 A-1 把這條從「回錯誤值」改成 `throw Rollback`。回錯誤值時
   sql.begin 照樣 COMMIT，結果是結算列 recycled、卡片列還是 stashed、
   零分錄 —— 賣家的保留額被無償釋放、買家的買回承諾永久消失。
   這一組驗的就是「throw 之後真的什麼都沒留下」，而且是在併發之下。
   ------------------------------------------------------------------
   怎麼把「剛好不夠」做出來：
     回收當下賣家的可動用 = 現在的可動用 + 這筆結算的 amount
     （那一列從 held 變成 recycled，就不再算進保留額）
     所以補到 buyback − 1 就是**剛好差一點**。
   併發回收全部失敗之後，補 1 點再單獨回收一次 —— 它必須成功。
   那一次成功會把賣家的可動用**精確地帶回 0**（(buyback−1)+1−buyback），
   所以下一輪的算式不受上一輪影響，順序完全自由。
   ================================================================== */
head('8 V-2：SELLER_UNFUNDED 併發 + 完全回滾')
{
  const buyer = await actor('s8', 60_000_000)
  const drainLister = await actor('s8d', 20_000_000)
  const K = 5
  const st = new Stat()
  let leaked = 0, retryFailed = 0, wrongError = 0, drained = 0
  const usable = unfunded.slice(0, ROUNDS)
  let walletChecked = false

  /**
   * 把一個賣家的可動用清成 0。
   *
   * 為什麼需要：種子給了 u-shop / u-seller 各 100,000 點，他們名下那些
   * 「買回價 > 票價」的籤位因此做不出「剛好差一點」（可動用已經遠高於目標，
   * 而 admin grant 只能往上加）。清成 0 之後那些籤位就跟其他賣家一樣可用 ——
   * 少了這一步，這一組能跑的輪數要看種子那一輪剛好排出幾個合格籤位。
   *
   * 清的手段是**產品路徑**：掛一筆價格剛好等於他可動用的庫內轉移，讓他買下來。
   * 直接 UPDATE 帳本會憑空改變發行量，drift 當場就壞了。
   */
  async function drainToZero(sellerId: string): Promise<number> {
    const av = await availableOf(sellerId)
    if (av.available <= 0) return 0
    const prizeId = await drawSeat(drainLister.token, nextSeat())
    const lr = await call(drainLister.token, '/v1/listings', { prizeId, price: av.available })
    if (lr.status !== 200) throw new Error(`佈景失敗：清空用的掛單 ${lr.status} ${lr.text}`)
    const t = await asSeller(sellerId)
    const br = await call(t, '/v1/orders',
      { listingId: lr.body.listing.id, idempotencyKey: `race-${runId}-drain-${seq++}` })
    if (br.status !== 200) throw new Error(`佈景失敗：清空買入 ${br.status} ${br.text}`)
    drained++
    return av.available
  }

  for (let round = 0; round < usable.length; round++) {
    const seat = usable[round]!
    const prizeId = await drawSeat(buyer.token, seat)
    const s0 = await settlementOf(prizeId)
    const amount = Number(s0!.amount)

    /* 可動用比目標高的話先清成 0（種子給過點數的賣家會落在這裡）。
       正常情況下不會走到 —— 每一輪最後那次成功的回收會把可動用精確帶回 0。 */
    if ((await availableOf(seat.sellerId)).available > (seat.buyback - 1) - amount) {
      await drainToZero(seat.sellerId)
    }
    const av = await availableOf(seat.sellerId)
    if (!walletChecked) {
      /* availableOf() 是照著 money.ts 的 walletOf() 重寫的 —— 對照一次，
         免得算式漂掉之後這一整組驗的是另一件事。 */
      const t = await asSeller(seat.sellerId)
      const w = (await call(t, '/v1/wallet')).body.wallet
      ck('availableOf() 跟 /v1/wallet 對得起來', Number(w.available) === av.available,
        `端點 ${w.available} / 測試算的 ${av.available}`)
      walletChecked = true
    }
    const needTopUp = (seat.buyback - 1) - (av.available + amount)
    if (needTopUp < 0) {
      note(`第 ${round + 1} 輪跳過：${seat.sellerId} 的可動用 ${av.available} 已經超過 `
        + `${seat.buyback - 1 - amount}，做不出「剛好差一點」`)
      continue
    }
    if (needTopUp > 0) await grant(seat.sellerId, needTopUp)

    const shots = await together(Array.from({ length: K }, (_, i) => ({
      label: `recycle${i}`,
      run: () => call(buyer.token, `/v1/prizes/${prizeId}/recycle`, {})
    })))
    const codes = shots.map(s => `${s.value?.status}:${s.value?.body?.error ?? ''}`)
    const allUnfunded = shots.every(s => s.value?.status === 409 && s.value.body?.error === 'SELLER_UNFUNDED')
    if (!allUnfunded) {
      wrongError++
      ck(`第 ${round + 1} 輪 ${K} 個併發回收全部拿到 SELLER_UNFUNDED`, false, codes.join('、'))
      await dump(prizeId, `賣家可動用 ${av.available + amount}、買回價 ${seat.buyback}`)
    }

    // 完全回滾：結算列沒動、卡片沒動、零分錄
    const s1 = await settlementOf(prizeId)
    const p1 = await prizeStatus(prizeId)
    const led = await sql<{ n: string }[]>`
      select count(*)::text as n from points_ledger
       where ref_id = ${s0!.id} and reason in ('pool-recycle-out', 'pool-recycle-in')`
    const clean = s1?.status === 'held' && p1?.status === 'stashed' && Number(led[0]?.n) === 0
    if (!clean) {
      leaked++
      ck(`第 ${round + 1} 輪狀態完全回滾`, false,
        `settlement=${s1?.status}（應為 held）、prize=${p1?.status}（應為 stashed）、回收分錄 ${led[0]?.n} 筆`)
      await dump(prizeId, '回滾不完全')
    }

    /* 補 1 點就該成功 —— 這一步同時證明「上一批失敗真的什麼都沒留下」：
       結算列如果被改成 recycled 了，這裡會拿到 WRONG_STATE 死路（那正是 A-1
       修之前的症狀）。 */
    await grant(seat.sellerId, 1)
    const retry = await call(buyer.token, `/v1/prizes/${prizeId}/recycle`, {})
    if (retry.status !== 200) {
      retryFailed++
      ck(`第 ${round + 1} 輪補 1 點之後回收得了`, false, `${retry.status} ${retry.text.slice(0, 160)}`)
      await dump(prizeId, '補款之後仍然回收不了')
    } else {
      const s2 = await settlementOf(prizeId)
      const p2 = await prizeStatus(prizeId)
      const pair = await sql<{ reason: string; delta: string }[]>`
        select reason, delta::text as delta from points_ledger
         where ref_id = ${s0!.id} and reason in ('pool-recycle-out', 'pool-recycle-in') order by reason`
      const sum = pair.reduce((a, r) => a + Number(r.delta), 0)
      if (s2?.status !== 'recycled' || p2?.status !== 'recycled' || pair.length !== 2 || sum !== 0) {
        ck(`第 ${round + 1} 輪成功的那次收尾正確`, false,
          `settlement=${s2?.status}、prize=${p2?.status}、分錄 ${JSON.stringify(pair)}`)
        await dump(prizeId, '成功的回收收尾不正確')
      }
    }
    st.round(shots, allUnfunded ? `${K}個全部 UNFUNDED` : '有非預期回應')
  }

  ck('併發的 SELLER_UNFUNDED 一次都沒有留下痕跡（狀態完全回滾）', leaked === 0, `${leaked} 輪`)
  ck('併發回收全部回 SELLER_UNFUNDED，沒有別的錯誤', wrongError === 0, `${wrongError} 輪`)
  ck('補款之後每一輪都回收得了（不是死路）', retryFailed === 0, `${retryFailed} 輪`)
  ck(`跑滿了 ${ROUNDS} 輪`, st.rounds >= ROUNDS,
    `只跑了 ${st.rounds} 輪 —— 合格籤位（買回價 > 票價）只有 ${unfunded.length} 個`)
  st.report('SELLER_UNFUNDED 併發')
  note(`過程中把 ${drained} 個賣家的可動用清成 0（種子發過點數的那幾個）`)
  await invariants('8 V-2')
}

/* ==================================================================
   收尾
   ================================================================== */
head('收尾：全站對帳')
{
  const r = await reconcile()
  note(`total=${r.total}、issued=${r.issued}、drift=${r.drift}、reserved=${r.reserved}`)
  ck('drift 仍然是基準值', r.drift === baselineDrift, `${baselineDrift} → ${r.drift}`)
  const neg = await negatives()
  ck('全站沒有負餘額', neg.length === 0, JSON.stringify(neg))
  const dl = await deadlocks()
  note(`整支跑完 pg_stat_database.deadlocks = ${dl}`)
  note(`用掉的一般籤位 ${seatsUsed} / ${plain.length}`
    + `（各賣家剩 ${[...queues].map(([k, v]) => `${k}:${v.length}`).join('、')}）`)
}

console.log(`\n${pass} passed, ${fail} failed${soft ? `, ${soft} known-fail（不計入 exit code）` : ''}`)
await sql.end({ timeout: 5 })
process.exit(fail ? 1 : 0)
