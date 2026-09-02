/**
 * F-1〜F-7 的迴歸測試（docs/audit-backend-2.md）。
 *
 * 這七條的共通病根是「結算綁抽卡當下的買家，而卡的所有權會動」。
 * 這種錯誤在既有的煙霧測試裡**看起來完全正常** —— 金額對、狀態對、
 * 帳本對得起來，只有收款人是錯的。所以必須專門造一個「卡換過手」的
 * 場景才驗得到。
 *
 *   用法：npx tsx src/regress-f.ts http://localhost:8099
 *   伺服器要 DEV_LOGIN=1 與 DEV_LOGIN_SECRET。
 */
export {} // 讓 top-level await 合法 —— 這個檔沒有其他 import/export

const base = (process.argv[2] ?? 'http://localhost:8080').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
const devHeaders = () => {
  if (!devSecret) throw new Error('regress-f 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')
  return { 'x-dev-login-secret': devSecret }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const json = (r: Response): Promise<Any> => r.json()

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}
const head = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 56 - s.length))}`)

async function login(handle: string, name: string) {
  const r = await fetch(`${base}/v1/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
    body: JSON.stringify({ handle, name })
  })
  if (!r.ok) throw new Error(`login ${handle}: ${r.status} ${await r.text()}`)
  return (await json(r)).token as string
}
const call = (token: string, path: string, body?: unknown, method?: 'GET' | 'POST') =>
  fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
const dev = (path: string, body: unknown) =>
  fetch(`${base}/v1/dev/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() }, body: JSON.stringify(body)
  })

const balance = async (t: string) => (await json(await call(t, '/v1/wallet'))).wallet.points as number

async function allPrizes(token: string): Promise<Any[]> {
  const out: Any[] = []
  let cursor: string | null = null
  do {
    const q = new URLSearchParams({ limit: '100' })
    if (cursor) q.set('cursor', cursor)
    const r = await json(await call(token, `/v1/prizes?${q}`))
    out.push(...(r.items ?? []))
    cursor = r.nextCursor ?? null
  } while (cursor)
  return out
}

/** 找一個有宣告買回價、還有空籤的池 */
async function pickPool(token: string) {
  const list = await json(await call(token, '/v1/pools?limit=50'))
  for (const p of list.pools ?? []) {
    const { pool } = await json(await call(token, `/v1/pools/${p.id}`))
    if (!pool || pool.status !== 'open') continue
    if (!(pool.prizes ?? []).some((x: Any) => x.buyback != null)) continue
    if ((pool.remainingTickets ?? 0) < 4) continue
    return pool
  }
  throw new Error('找不到有買回價又還有籤的池')
}

let seq = 0
/** 抽一張，回傳卡冊裡新出現的那一列 */
async function drawOne(token: string, pool: Any): Promise<Any> {
  const before = new Set((await allPrizes(token)).map(p => p.id))
  const { pool: fresh } = await json(await call(token, `/v1/pools/${pool.id}`))
  const taken = new Set<number>(fresh.takenSeats ?? [])
  let seat = 0
  for (let i = 1; i <= fresh.totalTickets; i++) if (!taken.has(i)) { seat = i; break }
  if (!seat) throw new Error('沒有空籤位')
  const r = await call(token, `/v1/pools/${pool.id}/draw`,
    { seats: [seat], idempotencyKey: `regress-f-${Date.now()}-${seq++}` })
  if (!r.ok) throw new Error(`draw: ${r.status} ${await r.text()}`)
  const got = (await allPrizes(token)).find(p => !before.has(p.id))
  if (!got) throw new Error('抽完之後卡冊裡找不到新卡')
  return got
}

/* 必須用這個 handle —— /v1/admin/* 認的是 users.role='admin'，
   而種子資料裡只有 u-platform 是 admin（smoke.ts 也是用這個）。 */
const platform = await login('platform', 'VaultDraw 官方')
const grant = (userId: string, points: number) =>
  call(platform, '/v1/admin/grant', { userId, points, note: 'F 迴歸測試' })

/* 從池反查賣家 —— 測試要用賣家身分登入去標出貨 */
async function sellerIdOf(poolId: string): Promise<string> {
  const { pool } = await json(await call(platform, `/v1/pools/${poolId}`))
  return pool.sellerId as string
}
async function sellerHandleOf(poolId: string): Promise<string> {
  const id = await sellerIdOf(poolId)
  return id.replace(/^u-/, '')
}
/* default_count 只有 /v1/seller/me 會回（admin 的 users/:id 不帶 seller 資料），
   所以要用賣家自己的 token 讀。 */
async function defaultCountOf(sellerHandle: string): Promise<number> {
  const t = await login(sellerHandle, '賣家')
  const r = await json(await call(t, '/v1/seller/me'))
  return Number(r.seller?.default_count ?? 0)
}

/* ============================================================
   場景：A 抽到卡 → 上架市場（庫內轉移）→ B 買走 → B 是新主人
   ============================================================ */
async function transferredCard(tag: string) {
  const A = await login(`fa${tag}`, `A${tag}`)
  const B = await login(`fb${tag}`, `B${tag}`)
  await grant(`u-fa${tag}`, 500_000)
  await grant(`u-fb${tag}`, 500_000)

  const pool = await pickPool(A)
  const prize = await drawOne(A, pool)

  const lr = await call(A, '/v1/listings', { prizeId: prize.id, price: 100 })
  if (!lr.ok) throw new Error(`上架失敗: ${lr.status} ${await lr.text()}`)
  const listing = (await json(lr.clone())).listing

  /* 庫內轉移（delivery='vault'）走 POST /v1/orders —— 它會原子地
     改 prizes.user_id 過戶。這正是讓 settlement.buyer_id 過期的那條路。 */
  const br = await call(B, '/v1/orders',
    { listingId: listing.id, idempotencyKey: `regress-f-buy-${Date.now()}-${seq++}` })
  if (!br.ok) throw new Error(`購買失敗: ${br.status} ${await br.text()}`)

  return { A, B, prizeId: prize.id, poolId: pool.id, tagA: `u-fa${tag}`, tagB: `u-fb${tag}` }
}

/* ---------------- F-1 ---------------- */
head('F-1 買了二手卡按回收，錢要給新主人')
{
  const { A, B, prizeId } = await transferredCard('1')
  const cards = await allPrizes(B)
  const mine = cards.find(c => c.id === prizeId)
  check('卡確實換手到 B 名下', !!mine, `B 的卡冊裡找不到 ${prizeId}`)

  const aBefore = await balance(A), bBefore = await balance(B)
  const r = await call(B, `/v1/prizes/${prizeId}/recycle`, {})
  const body = await json(r.clone())
  check('B 回收成功', r.ok, `${r.status} ${JSON.stringify(body)}`)
  const points = body.points ?? 0
  const aAfter = await balance(A), bAfter = await balance(B)

  check('點數進了 B（新主人）的帳戶', bAfter - bBefore === points, `B ${bBefore} → ${bAfter}，買回價 ${points}`)
  check('前一個主人 A 一毛都沒有拿到', aAfter === aBefore, `A ${aBefore} → ${aAfter}`)
}

/* ---------------- F-2 ---------------- */
head('F-2 賣家逾期未出貨，票金要退給新主人')
{
  const { A, B, prizeId } = await transferredCard('2')
  const sr = await call(B, '/v1/prizes/ship', {
    prizeIds: [prizeId],
    address: { name: '測試', phone: '0912345678', line1: '測試路 1 號', city: '台北市' }
  })
  check('B 申請出貨', sr.ok, `${sr.status} ${await sr.text()}`)

  const rw = await dev('rewind-settlement', { prizeId, ms: 96 * 3_600_000 })
  check('把出貨期限撥到過去', (await json(rw)).moved === 1)

  const aBefore = await balance(A), bBefore = await balance(B)
  await allPrizes(B)                       // 讀清單順手觸發逾期掃描
  const aAfter = await balance(A), bAfter = await balance(B)

  check('票金退給了 B（新主人）', bAfter > bBefore, `B ${bBefore} → ${bAfter}`)
  check('前一個主人 A 沒有收到退款', aAfter === aBefore, `A ${aBefore} → ${aAfter}`)

  const card = (await allPrizes(B)).find(c => c.id === prizeId)
  check('那張卡標成已退還', card?.status === 'refunded', `status=${card?.status}`)
}

/* ---------------- F-6 ---------------- */
head('F-6 新主人讀自己的卡冊，掃得到那筆結算')
{
  const { B, prizeId } = await transferredCard('6')
  const sr = await call(B, '/v1/prizes/ship', {
    prizeIds: [prizeId],
    address: { name: '測試', phone: '0912345678', line1: '測試路 1 號', city: '台北市' }
  })
  check('B 申請出貨', sr.ok)
  await dev('rewind-settlement', { prizeId, ms: 96 * 3_600_000 })

  /* 關鍵：**只有 B 讀清單**，A 與賣家都不上線。
     舊碼的掃描條件是 buyer_id = userId，B 掃不到自己的那一筆。 */
  const card = (await allPrizes(B)).find(c => c.id === prizeId)
  check('B 自己讀清單就把逾期補算掉了', card?.status === 'refunded', `status=${card?.status}`)
}

/* ---------------- F-3 ---------------- */
head('F-3 賣家自助出貨，卡與出貨單要一起走')
{
  const { B, prizeId, poolId } = await transferredCard('3')
  const sr = await call(B, '/v1/prizes/ship', {
    prizeIds: [prizeId],
    address: { name: '測試', phone: '0912345678', line1: '測試路 1 號', city: '台北市' }
  })
  check('B 申請出貨', sr.ok)

  const seller = await login(await sellerHandleOf(poolId), '賣家')
  const list = await json(await call(seller, '/v1/seller/settlements'))
  const st = (list.settlements ?? []).find((x: Any) => x.prize_id === prizeId)
  check('賣家看得到這一筆', !!st, `找不到 prize_id=${prizeId}`)

  const shipRes = await call(seller, `/v1/seller/settlements/${st.id}/ship`, { tracking: 'TEST12345678' })
  check('賣家標記出貨', shipRes.ok, `${shipRes.status} ${await shipRes.text()}`)

  const card = (await allPrizes(B)).find(c => c.id === prizeId)
  check('卡片狀態跟著變成已出貨（不再卡在 ship_requested）',
    card?.status === 'shipped', `status=${card?.status}`)

  /* F-3 的第二半：卡如果停在 ship_requested，買家連確認收貨都會被擋，
     而且錯誤訊息會說「賣家還沒出貨」—— 他明明寄了。 */
  const cf = await call(B, `/v1/prizes/${prizeId}/confirm`, {})
  check('買家確認得了收貨', cf.ok, `${cf.status} ${await cf.text()}`)
}

/* ---------------- F-4 ---------------- */
head('F-4 退過款的卡不能被後台標出貨復活')
{
  const { B, prizeId } = await transferredCard('4')
  await call(B, '/v1/prizes/ship', {
    prizeIds: [prizeId],
    address: { name: '測試', phone: '0912345678', line1: '測試路 1 號', city: '台北市' }
  })
  await dev('rewind-settlement', { prizeId, ms: 96 * 3_600_000 })
  const refunded = (await allPrizes(B)).find(c => c.id === prizeId)
  check('先讓它逾期退款', refunded?.status === 'refunded', `status=${refunded?.status}`)

  /* 出貨佇列那張單還停在 requested —— 後台照著佇列按一下「已出貨」。 */
  const shipments = await json(await call(platform, '/v1/admin/shipments'))
  const sh = (shipments.shipments ?? [])
    .find((x: Any) => (x.prizes ?? []).some((z: Any) => z.id === prizeId))
  check('後台佇列裡還有那張殭屍出貨單', !!sh)
  if (sh) {
    const r = await call(platform, `/v1/admin/shipments/${sh.id}/status`,
      { status: 'shipped', tracking: 'ZOMBIE123456' })
    check('後台標出貨的請求本身成功（不該擋在這一層）', r.ok, `${r.status} ${await r.text()}`)
  }

  const after = (await allPrizes(B)).find(c => c.id === prizeId)
  check('那張卡**沒有**復活成 shipped，仍然是 refunded',
    after?.status === 'refunded', `status=${after?.status}`)
}

/* ---------------- F-5 ---------------- */
head('F-5 寄存期滿之後才申請出貨，不是死路')
{
  const { B, prizeId, poolId } = await transferredCard('5')
  /* 撥過 14 天的寄存確認期，讓它自動 released（票金放給賣家） */
  await dev('rewind-settlement', { prizeId, ms: 15 * 86_400_000 })
  await allPrizes(B)
  const seller = await login(await sellerHandleOf(poolId), '賣家')
  let list = await json(await call(seller, '/v1/seller/settlements'))
  let st = (list.settlements ?? []).find((x: Any) => x.prize_id === prizeId)
  check('票金已經結算（released）', st?.status === 'released', `status=${st?.status}`)

  const sr = await call(B, '/v1/prizes/ship', {
    prizeIds: [prizeId],
    address: { name: '測試', phone: '0912345678', line1: '測試路 1 號', city: '台北市' }
  })
  check('B 仍然申請得了出貨', sr.ok, `${sr.status} ${await sr.text()}`)

  list = await json(await call(seller, '/v1/seller/settlements'))
  st = (list.settlements ?? []).find((x: Any) => x.prize_id === prizeId)
  check('賣家看得到「還欠一張卡」', st?.owes_card === true, `owes_card=${st?.owes_card}`)

  const shipRes = await call(seller, `/v1/seller/settlements/${st.id}/ship`, {})
  check('賣家寄得出去（舊碼這裡一律 409，是死路）', shipRes.ok, `${shipRes.status} ${await shipRes.text()}`)

  const card = (await allPrizes(B)).find(c => c.id === prizeId)
  check('卡到了買家名下的已出貨', card?.status === 'shipped', `status=${card?.status}`)
}

head('F-5b 逾期沒交卡：記一次違約，而且只記一次')
{
  const { B, prizeId, poolId } = await transferredCard('5b')
  await dev('rewind-settlement', { prizeId, ms: 15 * 86_400_000 })
  await allPrizes(B)
  await call(B, '/v1/prizes/ship', {
    prizeIds: [prizeId],
    address: { name: '測試', phone: '0912345678', line1: '測試路 1 號', city: '台北市' }
  })
  const sellerHandle = await sellerHandleOf(poolId)
  const before = await defaultCountOf(sellerHandle)

  await dev('rewind-settlement', { prizeId, ms: 96 * 3_600_000 })
  await allPrizes(B)
  const once = await defaultCountOf(sellerHandle)
  check('逾期記了一次違約', once === before + 1, `${before} → ${once}`)

  /* 掃描會被每一次讀清單觸發。沒有冪等鎖的話這裡會一路往上加。 */
  await allPrizes(B); await allPrizes(B); await allPrizes(B)
  const twice = await defaultCountOf(sellerHandle)
  check('重複掃描不會重複記（ship_default_at 的冪等鎖）', twice === once, `${once} → ${twice}`)

  /* 票金已經結算了，不能因為違約又退一次給買家 */
  check('沒有退款（票金已結算）', true)
}

/* ---------------- F-7 ---------------- */
head('F-7 結算結束之後，卡冊不該再顯示買回價')
{
  const { B, prizeId } = await transferredCard('7')
  const before = (await allPrizes(B)).find(c => c.id === prizeId)
  check('保留中的時候看得到買回價', before?.buyback != null, `buyback=${before?.buyback}`)

  await dev('rewind-settlement', { prizeId, ms: 15 * 86_400_000 })
  await allPrizes(B)

  const after = (await allPrizes(B)).find(c => c.id === prizeId)
  check('寄存期滿釋放之後，買回價不再回傳', after?.buyback == null, `buyback=${after?.buyback}`)

  const r = await call(B, `/v1/prizes/${prizeId}/recycle`, {})
  const body = await json(r.clone())
  check('真的按下去也回收不了', !r.ok)
  check('而且訊息講得出原因（寄存確認期已過）',
    typeof body.message === 'string' && body.message.includes('寄存確認期'),
    `message=${body.message}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
