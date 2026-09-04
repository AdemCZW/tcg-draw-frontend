/**
 * V-1 專項：**把「鎖序相反會死鎖」從推理變成實測**。
 *
 * ── 這一支跟 regress-race.ts 第 7 組的差別 ──────────────────────────
 * regress-race 第 7 組壓的是**現在的**程式碼，跑出 0 個死鎖。那個結果只證明
 * 「20 輪沒撞到」，它沒有辦法回答讀者心裡真正的問題：
 *
 *   「0 是因為鎖序被統一了，還是因為這組壓測根本壓不出死鎖？」
 *
 * 分不出這兩者，那個 0 就沒有證據力 —— 一支永遠回 0 的測試看起來跟一支
 * 真的在保護不變式的測試一模一樣。所以這一支做的是 **A/B 對照**：
 * 同一份佈景、同一個併發時序，只換鎖序。
 *
 *   A（舊鎖序，這支自己用裸 SQL 重演）：結算列 → prizes   ⟶ 必須撞出 40P01
 *   B（現行鎖序，直接呼叫產品碼）    ：prizes → 結算列    ⟶ 必須 0
 *
 * A 撞得出來，就證明了這個佈景**有能力**製造死鎖；B 是 0，才代表那個 0
 * 來自鎖序而不是來自壓不到。兩邊缺一個，結論都不成立。
 *
 * ── 為什麼 A 要用裸 SQL 重演，不是把產品碼改回去 ────────────────────
 * 產品碼現在是對的（f851070 把 sweepSettlements 改成兩段式、42caace 補完
 * 後台那條）。為了做實驗把它改壞再改回來，等於讓「證據」依賴一次沒有人
 * 會 review 的暫時修改。裸 SQL 重演的是**鎖序這一個變因**本身：
 * 舊版 sweep 的 `select ... for update`（先鎖結算列）加上 refund() 的
 * `update prizes` —— 環的兩條邊都在，而且看得見。
 *
 * ── 這支測試在第一次跑的時候抓到的東西（2026-09-03）──────────────────
 * V-1 的環（prizes ↔ 結算列）確實已經關掉了，但第 3 組還是撞出 40P01：
 * **第三張表 `sellers`**。refund()／markShipDefault() 都會
 * `update sellers set default_count`，一個賣家只有一列、會被握到 COMMIT，
 * 而掃描原本還在迴圈裡逐筆拿新的 prizes 列 —— 兩支掃描自己就湊成環，
 * 跟回收完全無關（第 3b 組專門壓這個：修前 20 輪撞到 14 輪，修後 0）。
 * 結論寫進了 sweepSettlements 的檔頭：**鎖序對了還不夠，還要「不再中途拿新鎖」。**
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   createdb vd_dl
 *   DATABASE_URL=postgres://$(whoami)@localhost:5432/vd_dl \
 *   JWT_SECRET=<32+ 字元> npx tsx src/migrate.ts && npx tsx src/seed.ts
 *   DATABASE_URL=... JWT_SECRET=... PORT=8061 DEV_LOGIN=1 DEV_LOGIN_SECRET=<32+ 字元> \
 *     npx tsx src/index.ts
 *   DATABASE_URL=... JWT_SECRET=... DEV_LOGIN_SECRET=<同值> \
 *     npx tsx src/regress-deadlock.ts http://localhost:8061
 *
 * ⚠️ 要自己一個乾淨的庫（理由同 regress-race.ts）。這支會刻意製造死鎖，
 * 伺服器的 stdout 會出現 40P01 的 detail —— **那是預期輸出，不是失敗**。
 */
import { randomBytes } from 'node:crypto'
import { sql } from './db.js'
import { sweepSettlements, sweepSettlementsAll } from './pool-settlement.js'

const base = (process.argv[2] ?? 'http://localhost:8061').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
if (!devSecret) throw new Error('regress-deadlock 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const runId = randomBytes(4).toString('hex')
let seq = 0

let pass = 0, fail = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
const head = (s: string) => console.log(`\n══ ${s} ${'═'.repeat(Math.max(0, 60 - s.length))}`)
const note = (s: string) => console.log(`     · ${s}`)
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/* ---------------- HTTP ---------------- */

interface Res { status: number; body: Any; text: string }
async function hit(path: string, init: RequestInit): Promise<Res> {
  const r = await fetch(`${base}${path}`, init)
  const text = await r.text()
  let body: Any = null
  try { body = JSON.parse(text) } catch { /* 500 可能不是 JSON */ }
  return { status: r.status, body, text }
}
const call = (token: string, path: string, body?: unknown) =>
  hit(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
const dev = (path: string, body: unknown) =>
  hit(`/v1/dev/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-login-secret': devSecret! },
    body: JSON.stringify(body)
  })
async function login(handle: string, name: string) {
  const r = await hit('/v1/auth/dev-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-login-secret': devSecret! },
    body: JSON.stringify({ handle, name })
  })
  if (r.status !== 200) throw new Error(`login ${handle}: ${r.status} ${r.text}`)
  return r.body.token as string
}

/**
 * Postgres 自己數的死鎖次數 —— 這一支唯一誠實的計數器。
 *
 * 讀清單那兩條路的 sweep 都是 `.catch(() => {})`（routes/prizes.ts、
 * routes/sellers.ts），40P01 被吞掉之後端點照樣回 200；HTTP 那端看得到的
 * 最多是一個沒有內容的 500。要判斷「有沒有真的死鎖」只能問資料庫。
 */
const deadlocks = async () => Number(
  (await sql<{ n: string }[]>`
    select deadlocks::text as n from pg_stat_database where datname = current_database()`)[0]?.n ?? 0)

/* ---------------- 佈景 ---------------- */

const platform = await login('platform', 'VaultDraw 官方')
async function actor(tag: string, points: number) {
  const handle = `dl${runId}${tag}`
  const token = await login(handle, `死鎖測 ${tag}`)
  if (points > 0) {
    await call(platform, '/v1/admin/grant', { userId: `u-${handle}`, points, note: `deadlock ${runId}` })
  }
  return { token, id: `u-${handle}`, handle }
}

interface Seat { poolId: string; seat: number; buyback: number; ticket: number; sellerId: string }
const seatRows = await sql<{
  pool_id: string; seat: number; buyback: string; ticket_price: string; seller_id: string
}[]>`
  select ps.pool_id, ps.seat, pp.buyback::text as buyback,
         p.ticket_price::text as ticket_price, p.seller_id
    from pool_seats ps
    join pool_prizes pp on pp.id = ps.prize_id
    join pools p on p.id = ps.pool_id
   where ps.taken_by is null and p.status = 'open' and pp.buyback is not null
     and p.seller_id in ('u-shop', 'u-seller')
   order by p.ticket_price asc, ps.pool_id, ps.seat`
/* 只留買回價 ≤ 票價的籤位：回收在那種籤位上一定付得出來，
   不會意外撞進 SELLER_UNFUNDED 把結果換成另一件事（同 regress-race 的理由）。 */
const seats: Seat[] = seatRows
  .map(r => ({
    poolId: r.pool_id, seat: Number(r.seat), buyback: Number(r.buyback),
    ticket: Number(r.ticket_price), sellerId: r.seller_id
  }))
  .filter(s => s.buyback <= s.ticket)
let used = 0
const nextSeat = (): Seat => {
  const s = seats[used++]
  if (!s) throw new Error(`籤位用完了（已用 ${used}／共 ${seats.length}）—— 請開一個新的乾淨庫再跑`)
  return s
}

const ADDRESS = { name: '死鎖測收件', phone: '0912345678', line1: '鎖序路 1 號', city: '台北市' }

async function drawSeat(token: string, s: Seat): Promise<string> {
  const r = await call(token, `/v1/pools/${s.poolId}/draw`,
    { seats: [s.seat], idempotencyKey: `dl-${runId}-${seq++}` })
  if (r.status !== 200) throw new Error(`draw ${s.poolId}#${s.seat}: ${r.status} ${r.text}`)
  const id = r.body?.items?.[0]?.stashId as string | undefined
  if (!id) throw new Error(`draw 沒有回 stashId: ${r.text}`)
  return id
}

/** 造一張「已申請出貨、且已逾期」的卡 —— 掃描會走到 refund()（環上那一支） */
async function overdueCard(token: string): Promise<string> {
  const id = await drawSeat(token, nextSeat())
  const r = await call(token, '/v1/prizes/ship', { prizeIds: [id], address: ADDRESS })
  if (r.status !== 200) throw new Error(`ship ${id}: ${r.status} ${r.text}`)
  await dev('rewind-settlement', { prizeId: id, ms: 96 * 3_600_000 })
  return id
}

const settlementOf = async (prizeId: string) => {
  const [st] = await sql<{ id: string; status: string; amount: string; fee: string }[]>`
    select id, status, amount::text as amount, fee::text as fee
      from pool_settlements where prize_id = ${prizeId}`
  return st
}
const prizeStatus = async (prizeId: string) => (await sql<{ status: string }[]>`
  select status from prizes where id = ${prizeId}`)[0]?.status
const balance = async (userId: string) => Number((await sql<{ b: string }[]>`
  select coalesce(sum(delta),0)::text as b from points_ledger where user_id = ${userId}`)[0]?.b ?? 0)

const reconcile = async () => (await call(platform, '/v1/admin/reconcile')).body as
  { total: number; issued: number; drift: number; reserved: number }
let baselineDrift = 0
async function invariants(label: string) {
  const r = await reconcile()
  ck(`${label}：drift 不變（${r.drift}）`, r.drift === baselineDrift,
    `基準 ${baselineDrift} → 現在 ${r.drift}`)
  const neg = await sql<{ user_id: string }[]>`
    select user_id from points_ledger group by user_id having sum(delta) < 0`
  ck(`${label}：沒有人的餘額變成負的`, neg.length === 0, JSON.stringify(neg))
}

/* ---------------- 兩條路的鎖序，用裸 SQL 重演 ---------------- */

interface Outcome { deadlocked: boolean; err?: string }
const isDeadlock = (e: unknown) => (e as { code?: string })?.code === '40P01'
const asOutcome = (e: unknown): Outcome =>
  isDeadlock(e) ? { deadlocked: true } : { deadlocked: false, err: String((e as Error)?.message ?? e) }

/**
 * **舊鎖序**的 sweep→refund（結算列 → prizes）。
 *
 * 這是 f851070 之前那一版的形狀：先把結算列鎖起來，再去 `update prizes`。
 * 不寫分錄、不發通知 —— 這支只是要重現「拿鎖的順序」，把錢真的移動了
 * 反而會污染 drift。`gap` 是刻意留的空窗，讓對面那條路有機會插進來拿到
 * 它要的第一把鎖；沒有它兩邊多半會前後排隊而不是交叉。
 */
async function oldOrderRefund(settlementId: string, prizeId: string, gap: number): Promise<Outcome> {
  try {
    await sql.begin(async tx => {
      await tx`select id from pool_settlements where id = ${settlementId} for update`
      await sleep(gap)
      await tx`update prizes set status = status where id = ${prizeId}`
    })
    return { deadlocked: false }
  } catch (e) { return asOutcome(e) }
}

/**
 * **現行鎖序**的 sweep→refund（prizes → 結算列），逐字照 sweepSettlements
 * 第二段的形狀寫。跟上面那支唯一的差別就是前兩行對調。
 */
async function newOrderRefund(settlementId: string, prizeId: string, gap: number): Promise<Outcome> {
  try {
    await sql.begin(async tx => {
      await tx`select id from prizes where id = ${prizeId} for update`
      await sleep(gap)
      await tx`
        select st.id from pool_settlements st join prizes pz on pz.id = st.prize_id
         where st.id = ${settlementId} for update of st`
      await tx`update prizes set status = status where id = ${prizeId}`
    })
    return { deadlocked: false }
  } catch (e) { return asOutcome(e) }
}

/**
 * 回收那條路的鎖序（prizes → 結算列），照 routes/prizes.ts 的 /recycle 抄。
 * 這一側**兩個實驗都一樣** —— 變因只有對面那條。
 */
async function recycleOrder(prizeId: string, gap: number): Promise<Outcome> {
  try {
    await sql.begin(async tx => {
      await tx`select id from prizes where id = ${prizeId} for update`
      await sleep(gap)
      await tx`
        select st.id from pool_settlements st join prizes pz on pz.id = st.prize_id
         where st.prize_id = ${prizeId} for update of st`
    })
    return { deadlocked: false }
  } catch (e) { return asOutcome(e) }
}

/* ==================================================================
   開場
   ================================================================== */
head('開場')
{
  const r = await reconcile()
  baselineDrift = r.drift
  ck('對帳基準取得', typeof r.drift === 'number', JSON.stringify(r))
  ck('drift 起點是 0（乾淨的庫）', r.drift === 0, `drift=${r.drift}`)
  note(`可用籤位 ${seats.length} 個（買回價 ≤ 票價）`)
  note(`pg_stat_database.deadlocks 起點 = ${await deadlocks()}`)
}

const buyer = await actor('b', 60_000_000)
/* 第二個買家：3b 要讓兩支「使用者範圍」的掃描看到不同的候選集合，
   那個差異正是它們拿鎖順序會分岔的原因。 */
const buyer2 = await actor('c', 60_000_000)

/* ==================================================================
   1 A 組：舊鎖序 —— 這個環真的會咬人
   ------------------------------------------------------------------
   結算列 → prizes（舊 sweep）× prizes → 結算列（回收），交錯送出。
   兩邊各自先拿到自己的第一把鎖、再去要對方手上那一把 —— 教科書的環。
   **這一組期望的是「撞得出來」**：撞不出來的話，B 組那個 0 就不算證據。
   ================================================================== */
head('1 A 組（舊鎖序）：結算列 → prizes  ×  prizes → 結算列')
const ROUNDS = Number(process.env.DL_ROUNDS) || 20
let aHit = 0
{
  const before = await deadlocks()
  for (let i = 0; i < ROUNDS; i++) {
    const pid = await overdueCard(buyer.token)
    const st = await settlementOf(pid)
    if (!st) throw new Error(`${pid} 沒有結算列`)
    /* 兩邊都先拿第一把鎖再睡，睡完才要第二把 —— 這是「同時進到交易裡」
       唯一可靠的做法。時間窗重疊只證明請求在途重疊，不證明鎖交叉。 */
    const [a, b] = await Promise.all([
      oldOrderRefund(st.id, pid, 120),
      recycleOrder(pid, 120)
    ])
    if (a.deadlocked || b.deadlocked) aHit++
    if (a.err) note(`A 組第 ${i + 1} 輪 sweep 側非死鎖錯誤：${a.err.slice(0, 120)}`)
    if (b.err) note(`A 組第 ${i + 1} 輪回收側非死鎖錯誤：${b.err.slice(0, 120)}`)
  }
  const delta = await deadlocks() - before
  note(`pg_stat_database.deadlocks 增量 = ${delta}（${ROUNDS} 輪裡 ${aHit} 輪撞到 40P01）`)
  ck(`A 組：舊鎖序在 ${ROUNDS} 輪內重現死鎖（環是真的）`, aHit > 0 && delta > 0,
    `撞到 ${aHit} 輪、deadlocks +${delta}；沒撞到就代表這個佈景壓不出死鎖，B 組的 0 沒有證據力`)
}

/* ==================================================================
   2 B 組：現行鎖序 —— 同一組佈景、同一個時序，只換鎖序
   ------------------------------------------------------------------
   變因只有一個：sweep 那一側改成先鎖 prizes 再鎖結算列。
   ================================================================== */
head('2 B 組（現行鎖序）：prizes → 結算列  ×  prizes → 結算列')
{
  const before = await deadlocks()
  let hit = 0
  for (let i = 0; i < ROUNDS; i++) {
    const pid = await overdueCard(buyer.token)
    const st = await settlementOf(pid)
    if (!st) throw new Error(`${pid} 沒有結算列`)
    const [a, b] = await Promise.all([
      newOrderRefund(st.id, pid, 120),
      recycleOrder(pid, 120)
    ])
    if (a.deadlocked || b.deadlocked) hit++
    if (a.err) note(`B 組第 ${i + 1} 輪 sweep 側非死鎖錯誤：${a.err.slice(0, 120)}`)
    if (b.err) note(`B 組第 ${i + 1} 輪回收側非死鎖錯誤：${b.err.slice(0, 120)}`)
  }
  const delta = await deadlocks() - before
  note(`pg_stat_database.deadlocks 增量 = ${delta}`)
  ck(`B 組：同一組佈景、同一個時序，統一鎖序後 ${ROUNDS} 輪 0 死鎖`, hit === 0 && delta === 0,
    `撞到 ${hit} 輪、deadlocks +${delta}`)
  note(`對照：A 組 ${aHit}／${ROUNDS} 輪撞到，B 組 0／${ROUNDS} —— 差的只有鎖序`)
}

/* ==================================================================
   3 產品碼實跑：真的 sweepSettlementsAll() × 真的 POST /recycle
   ------------------------------------------------------------------
   前兩組證明的是鎖序這個變因；這一組證明**產品碼現在走的就是 B 的方向**。
   一邊是行程內直接呼叫的全域掃描（沒有人 catch，40P01 會原樣拋出來），
   一邊是真的 HTTP 端點，外加讀卡冊與賣家結算頁（那兩條路也會觸發 sweep）。
   ================================================================== */
head('3 產品碼實跑：sweepSettlementsAll() × POST /prizes/:id/recycle')
{
  const sellerTokens = await Promise.all(
    ['u-shop', 'u-seller'].map(async sid => {
      const [u] = await sql<{ handle: string }[]>`select handle from users where id = ${sid}`
      return { sid, token: await login(u!.handle, '賣家') }
    }))
  const before = await deadlocks()
  let sweepErrs = 0, http5xx = 0, recycled = 0, refunded = 0
  const samples: string[] = []
  const checks: { prizeId: string; stId: string; sellerId: string; amount: number; fee: number }[] = []

  for (let i = 0; i < ROUNDS; i++) {
    /* 一張逾期待出貨的（掃描要退款它），一張保管中的（回收要吃掉它）。
       兩張是不同的卡 —— 同一筆結算不可能同時被退款又被回收，
       環要的是「兩條路同時在動，各自的第一把鎖是對方的第二把」。 */
    const overdue = await overdueCard(buyer.token)
    const stash = await drawSeat(buyer.token, nextSeat())
    const stOverdue = (await settlementOf(overdue))!
    const stStash = (await settlementOf(stash))!
    checks.push({
      prizeId: overdue, stId: stOverdue.id, sellerId: 'x',
      amount: Number(stOverdue.amount), fee: Number(stOverdue.fee)
    })

    const jobs: Promise<unknown>[] = [
      sweepSettlementsAll().catch(e => {
        sweepErrs++
        if (samples.length < 10) samples.push(`sweepAll code=${(e as Any)?.code ?? '-'} ${String((e as Error).message).slice(0, 160)}`)
      }),
      sweepSettlementsAll().catch(e => {
        sweepErrs++
        if (samples.length < 10) samples.push(`sweepAll code=${(e as Any)?.code ?? '-'} ${String((e as Error).message).slice(0, 160)}`)
      }),
      call(buyer.token, `/v1/prizes/${stash}/recycle`, {}),
      call(buyer.token, '/v1/prizes?limit=100'),
      ...sellerTokens.map(s => call(s.token, '/v1/seller/settlements'))
    ]
    const results = await Promise.all(jobs)
    for (const r of results) {
      const v = r as Res | undefined
      if (v && typeof v.status === 'number' && v.status >= 500) {
        http5xx++
        if (samples.length < 10) samples.push(`HTTP ${v.status} ${v.text.slice(0, 160)}`)
      }
    }
    /* 回收那一支可能因為掃描先把卡處理掉而拿到 409 —— 那是狀態守衛，不是錯誤。
       這裡只統計真的成交的，資料正確性在下面逐筆驗。 */
    const rec = results[2] as Res
    if (rec.status === 200) recycled++
    if (await prizeStatus(stash) === 'recycled') { /* 對得上就好 */ }
    if ((await settlementOf(overdue))?.status === 'refunded') refunded++
  }

  const delta = await deadlocks() - before
  note(`每輪同時發出 6 個工作（2 個全域掃描 + 1 個回收 + 1 個讀卡冊 + 2 個賣家結算頁）`)
  note(`pg_stat_database.deadlocks 增量 = ${delta}`)
  note(`掃描拋錯 ${sweepErrs} 次、HTTP 5xx ${http5xx} 次；回收成交 ${recycled}／${ROUNDS}、逾期退款 ${refunded}／${ROUNDS}`)
  if (samples.length) note(`錯誤樣本：${JSON.stringify(samples)}`)
  ck(`產品碼：${ROUNDS} 輪併發，deadlocks 增量 0`, delta === 0, `+${delta}`)
  ck('產品碼：掃描一次都沒拋錯', sweepErrs === 0, `${sweepErrs} 次`)
  ck('產品碼：一個 5xx 都沒有', http5xx === 0, `${http5xx} 次`)
  ck('產品碼：每一輪的逾期結算都真的被退款了（掃描確實走到 refund()）',
    refunded === ROUNDS, `${refunded}／${ROUNDS}`)

  /* 資料正確性：退款那一側的錢有沒有到、卡的狀態對不對。
     `deadlocks = 0` 只說沒有人被 abort，不說沒有人被**回滾成一半**。 */
  let badPrize = 0, badLedger = 0
  for (const c of checks) {
    if (await prizeStatus(c.prizeId) !== 'refunded') badPrize++
    const [led] = await sql<{ n: string }[]>`
      select coalesce(sum(delta),0)::text as n from points_ledger
       where ref_id = ${c.stId} and user_id = ${buyer.id} and reason = 'pool-refund'`
    if (Number(led?.n ?? 0) !== c.amount + c.fee) badLedger++
  }
  ck('退款後卡片列全部是 refunded（結算列與卡片列沒有各說各話）', badPrize === 0, `${badPrize} 張不對`)
  ck('退款的錢一筆不差地退回卡的主人（amount + fee）', badLedger === 0, `${badLedger} 筆對不上`)

  await invariants('3 產品碼併發')
}

/* ==================================================================
   3b sweep × sweep：**不需要有人在按回收，兩支掃描自己就湊得出環**
   ------------------------------------------------------------------
   第 3 組壓出來的那一個 40P01 不是 V-1 的環（prizes ↔ 結算列），是第三張表：
     掃描 A：握著 sellers(賣家) → 要 prizes(p2)
     掃描 B：握著 prizes(p2)    → 要 sellers(賣家)
   `refund()` 與 `markShipDefault()` 都會 `update sellers set default_count`，
   而一個賣家只有一列、會被握到 COMMIT；掃描原本又是在迴圈裡逐筆鎖 prizes。
   「握著共用列還在拿新列」＝ 環，跟回收那條路完全無關。

   ── 為什麼一定要混「全域掃描」與「使用者範圍掃描」──────────────────
   四支**全域**掃描互撞其實很難撞出來：它們的候選查詢一模一樣，計畫也一樣，
   於是拿鎖的順序也一樣 —— 第二名在第一列就整個排隊等，手上什麼都沒有，
   湊不成環。真正會分岔的是 `sweepSettlements(tx, userId)`：它多了
   `and (st.seller_id = $1 or pz.user_id = $1)`，候選集合與順序都跟全域那支
   不同。而那正是正式環境最常跑的一支 —— 它掛在讀卡冊與讀賣家結算頁上。
   所以這一組是「2 支全域 + 2 支各自使用者範圍」，卡分給兩個買家，
   兩邊的候選集合刻意不重疊成同一個順序。
   ================================================================== */
head('3b sweep × sweep（不含回收）：共用的 sellers 列 × 逐筆新拿的 prizes 列')
{
  const before = await deadlocks()
  let sweepErrs = 0, dlThrows = 0, dlRounds = 0
  const samples: string[] = []
  /* 籤位是消耗品（種子總共兩百多個，前面三組已經吃掉一半），
     所以這一組的密度靠「掃描支數 × 候選集合分岔」撐，不是靠輪數。 */
  const PER_BUYER = 3
  const rounds = ROUNDS
  let seen = before
  for (let i = 0; i < rounds; i++) {
    const ids: string[] = []
    for (let k = 0; k < PER_BUYER; k++) ids.push(await overdueCard(buyer.token))
    for (let k = 0; k < PER_BUYER; k++) ids.push(await overdueCard(buyer2.token))

    const oneSweep = (run: () => Promise<unknown>) => run().catch(e => {
      sweepErrs++
      if ((e as Any)?.code === '40P01') dlThrows++
      if (samples.length < 6) samples.push(`code=${(e as Any)?.code ?? '-'} ${String((e as Error).message).slice(0, 140)}`)
    })
    await Promise.all([
      oneSweep(() => sweepSettlementsAll()),
      oneSweep(() => sweepSettlementsAll()),
      /* 使用者範圍的那一支，跟 routes/prizes.ts 讀卡冊時走的是同一個函式、
         同一個交易邊界 —— 只是這裡沒有 `.catch(() => {})` 把 40P01 吞掉。 */
      oneSweep(() => sql.begin(tx => sweepSettlements(tx, buyer.id))),
      oneSweep(() => sql.begin(tx => sweepSettlements(tx, buyer2.id)))
    ])
    const nowDl = await deadlocks()
    if (nowDl > seen) { dlRounds++; seen = nowDl }
    /* 掃描被 abort 的那一支整筆回滾，但另外幾支會把同一批補完 ——
       所以逾期的結算最後一定都結案了。這是「死鎖沒有弄壞資料」的證據。 */
    for (const id of ids) {
      const st = await settlementOf(id)
      if (st?.status !== 'refunded' && samples.length < 6) samples.push(`${id} 停在 ${st?.status}`)
    }
  }
  const delta = await deadlocks() - before
  note(`每輪 ${PER_BUYER * 2} 筆逾期（兩個買家各半）× 4 支同時掃描（2 全域 + 2 使用者範圍），共 ${rounds} 輪`)
  note(`pg_stat_database.deadlocks 增量 = ${delta}（${dlRounds} 輪撞到）；掃描拋錯 ${sweepErrs} 次（其中 40P01 ${dlThrows} 次）`)
  if (samples.length) note(`樣本：${JSON.stringify(samples)}`)
  ck(`3b：${rounds} 輪 sweep 對撞，deadlocks 增量 0`, delta === 0, `+${delta}`)
  ck('3b：掃描一次都沒拋 40P01', dlThrows === 0, `${dlThrows} 次`)
  const [left] = await sql<{ n: string }[]>`
    select count(*)::text as n from pool_settlements
     where status = 'awaiting_ship' and ship_due_at is not null and ship_due_at < ${Date.now()}`
  ck('3b：所有逾期的結算都被結案了（沒有因為死鎖而漏掉）', Number(left?.n ?? 0) === 0, `還剩 ${left?.n}`)
  await invariants('3b sweep 對撞')
}

/* ==================================================================
   4 反向：兩條路各自單獨跑，行為完全沒變
   ------------------------------------------------------------------
   統一鎖序的改動要是把正常路徑改壞了，上面三組全綠也沒有意義。
   ================================================================== */
head('4 反向：正常回收、正常逾期退款各自單獨跑')
{
  // 4a 單獨回收
  const pid = await drawSeat(buyer.token, nextSeat())
  const st = (await settlementOf(pid))!
  /* 賣家要從結算列讀出來，不能寫死 —— 籤位是從幾個池裡輪流拿的，
     寫死 'u-shop' 的話只要這一格剛好是別的池，這個檢查驗到的就是
     另一個人的餘額（而那個人當然沒有變）。 */
  const [stSeller] = await sql<{ seller_id: string }[]>`
    select seller_id from pool_settlements where id = ${st.id}`
  const sellerId = stSeller!.seller_id
  const sellerBefore = await balance(sellerId)
  const before = await balance(buyer.id)
  const r = await call(buyer.token, `/v1/prizes/${pid}/recycle`, {})
  ck('4a 單獨回收：200', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`)
  const paid = Number(r.body?.points ?? 0)
  ck('4a 回收後卡片是 recycled', await prizeStatus(pid) === 'recycled')
  ck('4a 回收後結算是 recycled', (await settlementOf(pid))?.status === 'recycled')
  ck('4a 買家收到買回價', await balance(buyer.id) - before === paid, `差 ${await balance(buyer.id) - before}、報價 ${paid}`)
  const sellerDelta = sellerBefore - await balance(sellerId)
  ck('4a 賣家付出同一個數字（不多不少）', sellerDelta === paid,
    `賣家(${sellerId})減少 ${sellerDelta}、買家增加 ${paid}`)
  note(`回收報價 ${paid} 點，賣家 ${sellerId}，結算 ${st.id}`)

  // 4b 單獨逾期退款
  const pid2 = await overdueCard(buyer.token)
  const st2 = (await settlementOf(pid2))!
  const b2 = await balance(buyer.id)
  await sweepSettlementsAll()
  ck('4b 單獨逾期退款：結算變 refunded', (await settlementOf(pid2))?.status === 'refunded')
  ck('4b 單獨逾期退款：卡片變 refunded', await prizeStatus(pid2) === 'refunded')
  ck('4b 單獨逾期退款：票金原封退回（amount + fee）',
    await balance(buyer.id) - b2 === Number(st2.amount) + Number(st2.fee),
    `退回 ${await balance(buyer.id) - b2}、應退 ${Number(st2.amount) + Number(st2.fee)}`)

  await invariants('4 反向')
}

/* ==================================================================
   收尾
   ================================================================== */
head('收尾')
note(`整支跑完 pg_stat_database.deadlocks = ${await deadlocks()}`
  + `（其中 A 組是**刻意**製造的 ${aHit} 次 —— 那是預期輸出）`)
note(`籤位用掉 ${used}／${seats.length}`)
console.log(`\n${fail === 0 ? '全部通過' : '有失敗'}：${pass} passed / ${fail} failed`)
await sql.end()
process.exit(fail === 0 ? 0 : 1)
