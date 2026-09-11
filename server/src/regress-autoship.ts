/**
 * D-1 的迴歸測試：**寄存到期就自動替買家申請出貨**。
 *
 * ── 這一支要釘住的那幾句話 ──────────────────────────────────────────
 * 1. 到期的 `stashed` 卡，掃描會**真的建出一張出貨單** —— 而且賣家在他的
 *    出貨頁上看得到（含收件地址）、買家在卡冊上看得到狀態變成出貨申請中。
 *    只看資料庫欄位不算數：這一組全部打真的 API。
 * 2. **冪等**：掃描掛在每一條讀清單的路徑上，同一張卡連掃五次也只能有
 *    一張出貨單。
 * 3. **不該碰的一張都不碰**：listed / in_pool / ship_requested / shipped /
 *    recycled。前四種的素材都是**走真流程做出來的**（有活著的結算列、
 *    owner 地址填齊、而且已經到期），所以只要把狀態守衛拿掉，這一組就會紅 ——
 *    這是它跟「隨手插一列進資料庫」的差別。
 * 4. **沒填收件地址的買家**：不建出貨單（不然賣家會收到一筆他無法完成的
 *    義務），只提醒去補；補完之後下一輪掃描自動接手。
 * 5. **接上既有的逾期機制**：自動建出來的出貨單，賣家不處理時走的是
 *    F-5 那一套（`ship_default_at` / `markShipDefault()` / 違約次數 +1），
 *    不是另一條平行的路。
 * 6. **併發**：兩個請求同時觸發掃描，`pg_stat_database.deadlocks` 增量為 0、
 *    也不會重複建單。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   createdb vd_autoship
 *   DATABASE_URL=postgres://localhost:5432/vd_autoship JWT_SECRET=<32+> \
 *     npx tsx src/migrate.ts && npx tsx src/seed.ts
 *   DATABASE_URL=... JWT_SECRET=... PORT=8097 DEV_LOGIN=1 DEV_LOGIN_SECRET=<32+> \
 *     npx tsx src/index.ts
 *   DATABASE_URL=... DEV_LOGIN_SECRET=<同值> \
 *     npx tsx src/regress-autoship.ts http://localhost:8097
 *
 * ⚠️ 要有自己的乾淨資料庫，不要跟 smoke 共用（理由同 regress-stash.ts：
 * 兩邊都會消耗種子資料）。
 */
import { randomBytes } from 'node:crypto'
import { sql } from './db.js'

const base = (process.argv[2] ?? 'http://localhost:8097').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
if (!devSecret) throw new Error('regress-autoship 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const json = (r: Response): Promise<Any> => r.json()
let pass = 0, fail = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
const note = (s: string) => console.log(`       ${s}`)
const head = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 54 - s.length))}`)

const DAY = 86_400_000

async function login(handle: string, name: string) {
  const r = await fetch(`${base}/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-login-secret': devSecret! },
    body: JSON.stringify({ handle, name })
  })
  if (!r.ok) throw new Error(`login ${handle}: ${r.status} ${await r.text()}`)
  return (await json(r)) as { token: string; userId: string }
}
const call = (t: string, p: string, b?: unknown) =>
  fetch(`${base}${p}`, {
    method: b === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    ...(b === undefined ? {} : { body: JSON.stringify(b) })
  })
const post = (t: string, p: string, b: unknown = {}) => call(t, p, b)
/** 會員資料是 PUT（routes/auth.ts:231），不是 POST */
const putProfile = (t: string, b: unknown) =>
  fetch(`${base}/v1/auth/profile`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    body: JSON.stringify(b)
  })

const RUN = randomBytes(4).toString('hex')
let seq = 0
const uniq = () => `${RUN}-${++seq}`

/** 手動推一次寄存掃描。回的是 { warned, expired, shipped, noAddress } */
const sweepStash = async (): Promise<Any> =>
  json(await fetch(`${base}/v1/dev/sweep-stash`, {
    method: 'POST', headers: { 'x-dev-login-secret': devSecret! }
  }))

/** 把一張卡的寄存期限撥到過去。這是「造一張到期的卡」唯一的辦法 —— 那一欄
 *  只在抽中的當下寫一次（now + 90 天），沒有任何 API 改得動它。 */
const expireStash = (prizeId: string) =>
  sql`update prizes set stash_expires_at = ${Date.now() - 60_000} where id = ${prizeId}`

/** 把一筆結算的時鐘往回撥。用既有的 dev 端點，它只動時間戳、不改狀態 ——
 *  撥完之後仍然由正常的 sweepSettlements() 去判斷該發生什麼。 */
const rewind = (prizeId: string, ms: number) =>
  fetch(`${base}/v1/dev/rewind-settlement`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-login-secret': devSecret! },
    body: JSON.stringify({ prizeId, ms })
  })

const prizeRow = async (id: string) => {
  const [r] = await sql<Any[]>`
    select user_id, status, stash_expires_at, custodian_id from prizes where id = ${id}
  `
  return r
}
const settlementRow = async (prizeId: string) => {
  const [r] = await sql<Any[]>`
    select id, seller_id, status, ship_due_at, shipped_at, ship_default_at
      from pool_settlements where prize_id = ${prizeId}
  `
  return r
}
/** 這張卡出現在幾張出貨單上。冪等那一組的唯一斷言 */
const shipmentsFor = async (prizeId: string) => {
  const rows = await sql<Any[]>`
    select id, user_id, status, created_at from shipments where ${prizeId} = any(prize_ids)
  `
  return rows
}
const notif = async (token: string) => (await json(await call(token, '/v1/social/notifications'))).notifications as Any[]
const hasNotif = (list: Any[], title: string) => list.some(n => String(n.title).includes(title))

/* 種子池 p-seed-1-g2：u-seller 開的、100 籤、有宣告買回價。
   用種子池而不是現場開一個：現場開池要先把 N 張卡登記進卡冊，
   而這一支要驗的東西跟「池是怎麼開的」無關。 */
const SEED_POOL = 'p-seed-1-g2'
const SEED_POOL_SELLER = 'u-seller'

/** 抽 n 籤，回傳卡冊裡那 n 列的 id。**走真的抽卡**，所以每一張都有活著的結算列 */
async function draw(token: string, n: number): Promise<string[]> {
  const free = await sql<Any[]>`
    select seat from pool_seats where pool_id = ${SEED_POOL} and taken_by is null order by seat limit ${n}
  `
  if (free.length < n) throw new Error(`種子池的空籤不夠（要 ${n}，只剩 ${free.length}）`)
  const r = await post(token, `/v1/pools/${SEED_POOL}/draw`, {
    seats: free.map(f => Number(f.seat)), idempotencyKey: 'autoship-' + uniq()
  })
  const b = await json(r.clone())
  if (!r.ok) throw new Error(`抽卡失敗 ${r.status} ${JSON.stringify(b).slice(0, 300)}`)
  return (b.items as Any[]).map(i => i.stashId as string)
}

const ADDRESS = { realName: '自動出貨測試', phone: '0912345678', addressZip: '106', addressCity: '台北市', addressLine1: '測試路 100 號 5 樓' }

const platform = await login('platform', 'VaultDraw 官方')
const buyer = await login('autoship-buyer', '有地址的買家')
/* 第 3 組的素材要走「上架」，而上架現在先檢查賣家聯絡方式（public.ts 的
   NEED_CONTACT，migration 041）。這一支測的不是那道閘，直接把素材備齊。 */
await sql`
  insert into sellers (id, handle, name, origin, tier, contact_kind, contact_value)
  values (${buyer.userId}, 'autoship-buyer', '有地址的買家', 'personal', 'verified', 'line', 'autoship-test')
  on conflict (id) do update set contact_kind = 'line', contact_value = 'autoship-test'
`
const noaddr = await login('autoship-noaddr', '沒填地址的買家')
const seller = await login('seller', '種子賣家')
for (const u of [buyer.userId, noaddr.userId]) {
  await post(platform.token, '/v1/admin/grant', { userId: u, points: 5_000_000, note: 'D-1 測試' })
}
/* 買家填好收件資料；noaddr 那個帳號**刻意一個字都不填** */
await putProfile(buyer.token, ADDRESS)

/* ────────────────────────────────────────────────────────────────────
   1 核心：到期 → 掃描 → 出貨單真的建出來，而且雙方在自己的頁面上看得到
   ──────────────────────────────────────────────────────────────────── */
head('1 到期就自動建出貨單（核心）')
{
  const [pz] = await draw(buyer.token, 1)
  const before = await prizeRow(pz!)
  ck('素材：剛抽到的卡是 stashed，實體在賣家手上', before?.status === 'stashed' && before?.custodian_id === SEED_POOL_SELLER,
    `status=${before?.status} custodian=${before?.custodian_id}`)
  ck('素材：而且有一列活著的結算（賣家的義務住在那裡）',
    ['held', 'released'].includes((await settlementRow(pz!))?.status), String((await settlementRow(pz!))?.status))

  /* 到期之前掃一次：什麼都不該發生。少了這一條，「條件寫成一律出貨」也會全綠 */
  await sweepStash()
  ck('還沒到期的卡，掃描不動它', (await prizeRow(pz!))?.status === 'stashed')
  ck('也還沒有任何出貨單', (await shipmentsFor(pz!)).length === 0)

  await expireStash(pz!)
  const out = await sweepStash()
  note(`sweep-stash 回：${JSON.stringify(out)}`)
  ck('掃描回報自動出貨了至少一張', Number(out.shipped) >= 1, JSON.stringify(out))

  const sh = await shipmentsFor(pz!)
  ck('**出貨單真的建出來了**（正好一張）', sh.length === 1, `${sh.length} 張`)
  ck('出貨單掛在買家名下、狀態是 requested',
    sh[0]?.user_id === buyer.userId && sh[0]?.status === 'requested',
    `${sh[0]?.user_id} / ${sh[0]?.status}`)

  /* ── 買家那一側：打真的卡冊 API ── */
  const book = await json(await call(buyer.token, '/v1/prizes?status=ship_requested'))
  ck('買家在卡冊上看得到狀態變成「出貨申請中」',
    (book.prizes ?? book.items ?? []).some((x: Any) => x.id === pz),
    JSON.stringify((book.prizes ?? book.items ?? []).map((x: Any) => x.id)).slice(0, 200))

  /* ── 賣家那一側：打真的出貨頁 API ── */
  const sellerView = await json(await call(seller.token, '/v1/seller/settlements'))
  const line = (sellerView.settlements ?? []).find((s: Any) => s.prize_id === pz)
  ck('賣家在出貨頁上看得到這一筆', !!line, '出貨頁沒有這張卡')
  ck('而且卡片列的狀態是 ship_requested（兩張表沒有各說各話）',
    line?.prize_status === 'ship_requested', String(line?.prize_status))
  ck('出貨頁帶得出收件地址（沒有地址的話賣家寄不了）',
    !!line?.ship_to?.name && !!line?.ship_to?.line1 && !!line?.ship_to?.phone,
    line?.ship_to ? '欄位不齊' : 'ship_to 是 null')
  /* 地址內容本身不印出來（個資），只驗「有」與「是這個人的」 */
  ck('地址就是買家自己填的那一份', line?.ship_to?.name === ADDRESS.realName, '收件人對不上')

  /* ── 賣家的出貨時鐘真的掛上了 ── */
  const st = await settlementRow(pz!)
  ck('結算列掛上了出貨期限（賣家的 72 小時開始跑）', st?.ship_due_at != null, `ship_due_at=${st?.ship_due_at}`)
  ck('結算狀態走的是既有的兩條之一（awaiting_ship 或 F-5 的 released）',
    ['awaiting_ship', 'released'].includes(st?.status), String(st?.status))

  /* ── 雙方都被告知，而且說得出「為什麼會這樣」 ── */
  const bn = await notif(buyer.token)
  ck('買家收到「已自動申請出貨」', hasNotif(bn, '自動申請出貨'), JSON.stringify(bn.map(n => n.title)).slice(0, 300))
  const bodyText = bn.find(n => String(n.title).includes('自動申請出貨'))?.body ?? ''
  ck('通知說得出原因（放滿 90 天）', String(bodyText).includes('90'), String(bodyText).slice(0, 120))
  ck('**通知內文沒有夾帶收件地址**（個資不進通知）',
    !String(bodyText).includes(ADDRESS.addressLine1) && !String(bodyText).includes(ADDRESS.phone),
    '通知內文出現了地址或電話')
  const sn = await notif(seller.token)
  ck('賣家收到「寄存期滿，這些卡要出貨了」', hasNotif(sn, '寄存期滿'), JSON.stringify(sn.map(n => n.title)).slice(0, 300))
  const sbody = sn.find(n => String(n.title).includes('寄存期滿'))?.body ?? ''
  ck('賣家那一則說得出「不是買家臨時按的」以及不寄的後果',
    String(sbody).includes('期限到了') && String(sbody).includes('違約'), String(sbody).slice(0, 160))

  /* ── 賣家真的寄得出去（不是一條死路）── */
  const shipRes = await post(seller.token, `/v1/seller/settlements/${st?.id}/ship`, {})
  ck('賣家用既有的出貨端點就能把它寄掉', shipRes.ok, `${shipRes.status} ${await shipRes.clone().text()}`)
  ck('寄掉之後卡片列變成 shipped', (await prizeRow(pz!))?.status === 'shipped', String((await prizeRow(pz!))?.status))
}

/* ────────────────────────────────────────────────────────────────────
   2 冪等：連掃五次只有一張單
   ──────────────────────────────────────────────────────────────────── */
head('2 冪等：連續觸發五次只建出一筆')
{
  const [pz] = await draw(buyer.token, 1)
  await expireStash(pz!)
  const results: Any[] = []
  for (let i = 0; i < 5; i++) results.push(await sweepStash())
  note(`五輪的回報：${results.map(r => r.shipped).join(', ')}`)
  const sh = await shipmentsFor(pz!)
  ck('**五次掃描之後仍然只有一張出貨單**', sh.length === 1, `${sh.length} 張：${sh.map(s => s.id).join(',')}`)
  ck('只有第一輪算數，之後四輪都是 0', results.slice(1).every(r => Number(r.shipped) === 0),
    results.map(r => r.shipped).join(','))
  const dupNotif = (await notif(buyer.token)).filter(n => String(n.title).includes('自動申請出貨'))
  ck('買家也只收到一則新的自動出貨通知（每張單一則，不是每輪一則）',
    dupNotif.length === 2, `${dupNotif.length} 則`)
  note('（2 則 = 第 1 組那張 + 這一組這張，各一則）')
}

/* ────────────────────────────────────────────────────────────────────
   3 不該碰的一張都不碰
   ──────────────────────────────────────────────────────────────────── */
head('3 listed / in_pool / ship_requested / shipped / recycled 都不動')
{
  /* 每一張素材都是**走真流程**做出來的：有活著的結算列、owner 的地址填齊、
     而且已經到期 —— 也就是說，除了 status 之外每一個條件都命中。
     把 `status = 'stashed'` 那個守衛拿掉，這一組就會紅。 */
  const [pzListed, pzReq, pzShipped, pzRecycled] = await draw(buyer.token, 4)

  // listed：上架（庫內轉移）
  /* 2000 而不是 4000：抽出來的是裸卡，沒有成交紀錄的賣家單筆上限 3,000
     （shared/escrow.ts 的 rawListingCap）。這一組要的只是「一張 listed 的卡」。 */
  const lr = await post(buyer.token, '/v1/listings', { prizeId: pzListed, price: 2000 })
  ck('素材：上架成功', lr.ok, `${lr.status} ${await lr.clone().text()}`)

  // ship_requested：買家自己申請出貨
  const rr = await post(buyer.token, '/v1/prizes/ship', {
    prizeIds: [pzReq],
    address: { name: ADDRESS.realName, phone: ADDRESS.phone, zip: ADDRESS.addressZip, city: ADDRESS.addressCity, line1: ADDRESS.addressLine1 }
  })
  ck('素材：手動申請出貨成功', rr.ok, `${rr.status} ${await rr.clone().text()}`)

  // shipped：手動申請 + 賣家寄出
  await post(buyer.token, '/v1/prizes/ship', {
    prizeIds: [pzShipped],
    address: { name: ADDRESS.realName, phone: ADDRESS.phone, zip: ADDRESS.addressZip, city: ADDRESS.addressCity, line1: ADDRESS.addressLine1 }
  })
  const stShipped = await settlementRow(pzShipped!)
  await post(seller.token, `/v1/seller/settlements/${stShipped?.id}/ship`, {})

  // recycled：買家接受買回價
  const rc = await post(buyer.token, `/v1/prizes/${pzRecycled}/recycle`)
  ck('素材：回收成功', rc.ok, `${rc.status} ${await rc.clone().text()}`)

  // in_pool：賣家押在池上的卡（這一種天生沒有結算列，是比較弱的樣本）
  const bookCard = await json(await post(seller.token, '/v1/cardbook/upload', {
    card: { name: '押在池上的卡 ' + uniq(), setCode: 'sv8a', cardNo: '237/187', artId: 'SV8a-237' }
  }))
  const pledged = bookCard.prize?.id as string
  const mk = await post(seller.token, '/v1/pools', {
    mode: 'muteki', title: 'autoship-inpool-' + uniq(), ticketPrice: 100, totalTickets: 1,
    prizes: [{ tier: 'A', prizeId: pledged, card: { id: 'c-ip', name: '押在池上的卡' }, buyback: 50, total: 1 }]
  })
  ck('素材：建池成功（卡被押進池裡）', mk.ok, `${mk.status} ${await mk.clone().text()}`)

  const samples: [string, string][] = [
    ['listed', pzListed!], ['ship_requested', pzReq!], ['shipped', pzShipped!],
    ['recycled', pzRecycled!], ['in_pool', pledged]
  ]
  const before = new Map<string, Any>()
  for (const [, id] of samples) {
    await expireStash(id)
    before.set(id, await prizeRow(id))
  }
  const shipmentsBefore = new Map<string, number>()
  for (const [, id] of samples) shipmentsBefore.set(id, (await shipmentsFor(id)).length)

  const out = await sweepStash()
  note(`sweep-stash 回：${JSON.stringify(out)}`)

  for (const [want, id] of samples) {
    const now = await prizeRow(id)
    ck(`${want} 的卡狀態沒有被掃描改動`, now?.status === before.get(id)?.status,
      `${before.get(id)?.status} → ${now?.status}`)
    ck(`${want} 的卡沒有多出新的出貨單`,
      (await shipmentsFor(id)).length === shipmentsBefore.get(id),
      `${shipmentsBefore.get(id)} → ${(await shipmentsFor(id)).length}`)
  }
  ck('素材的狀態確實是預期的那五種', samples.every(([w, id]) => before.get(id)?.status === w),
    samples.map(([w, id]) => `${w}:${before.get(id)?.status}`).join(' '))
}

/* ────────────────────────────────────────────────────────────────────
   4 沒有收件地址的買家
   ──────────────────────────────────────────────────────────────────── */
head('4 沒填收件地址：不建單、只提醒，補完之後自動接手')
{
  const [pz] = await draw(noaddr.token, 1)
  await expireStash(pz!)
  const out = await sweepStash()
  note(`sweep-stash 回：${JSON.stringify(out)}`)
  ck('掃描把他算進「缺收件資料」', Number(out.noAddress) >= 1, JSON.stringify(out))
  ck('**沒有建出貨單**（不然賣家會收到一筆他無法完成的義務）',
    (await shipmentsFor(pz!)).length === 0, `${(await shipmentsFor(pz!)).length} 張`)
  ck('卡還留在 stashed', (await prizeRow(pz!))?.status === 'stashed', String((await prizeRow(pz!))?.status))
  ck('賣家的結算列沒有被掛上出貨期限（義務沒有被憑空製造）',
    (await settlementRow(pz!))?.ship_due_at == null, String((await settlementRow(pz!))?.ship_due_at))
  const nn = await notif(noaddr.token)
  ck('買家收到「收件資料還沒填」', hasNotif(nn, '收件資料還沒填'), JSON.stringify(nn.map(n => n.title)).slice(0, 300))

  /* 補完資料 → 下一輪掃描自動接手，不用他再按任何按鈕 */
  await putProfile(noaddr.token, { ...ADDRESS, realName: '補填測試' })
  const out2 = await sweepStash()
  ck('補完收件資料之後，下一輪掃描就自動出貨了', Number(out2.shipped) >= 1, JSON.stringify(out2))
  ck('這時候出貨單建出來了', (await shipmentsFor(pz!)).length === 1, `${(await shipmentsFor(pz!)).length} 張`)
  ck('卡片列跟著變成 ship_requested', (await prizeRow(pz!))?.status === 'ship_requested', String((await prizeRow(pz!))?.status))
}

/* ────────────────────────────────────────────────────────────────────
   5 接上既有的逾期機制（F-5 那一套，不是另一條平行的路）
   ──────────────────────────────────────────────────────────────────── */
head('5 賣家不寄：走既有的違約流程')
{
  const [pz] = await draw(buyer.token, 1)
  await expireStash(pz!)
  await sweepStash()
  const st = await settlementRow(pz!)
  ck('素材：自動出貨掛上了出貨期限', st?.ship_due_at != null, String(st?.ship_due_at))
  ck('素材：這一筆還沒被記過違約', st?.ship_default_at == null, String(st?.ship_default_at))
  const [sellerBefore] = await sql<Any[]>`select default_count from sellers where id = ${SEED_POOL_SELLER}`

  /* 把時鐘往回撥 —— 用的是既有的 /v1/dev/rewind-settlement，它只動時間戳。
     撥完之後仍然由正常的 sweepSettlements() 去判斷該發生什麼。 */
  const shBefore = await shipmentsFor(pz!)
  await rewind(pz!, 5 * DAY)
  /* 觸發結算掃描的方式也照既有的：賣家讀自己的出貨頁就會補算。
     刻意不打任何新端點 —— 那正是「接上去、不另造」要證明的事。 */
  await call(seller.token, '/v1/seller/settlements')

  const after = await settlementRow(pz!)
  const [sellerAfter] = await sql<Any[]>`select default_count from sellers where id = ${SEED_POOL_SELLER}`
  const refunded = after?.status === 'refunded'
  const defaulted = after?.ship_default_at != null
  ck('**自動建的出貨單逾期後真的走進既有的違約流程**', refunded || defaulted,
    `status=${after?.status} ship_default_at=${after?.ship_default_at}`)
  note(refunded
    ? '走的是 refund()：票金還在保留額裡，原路退給買家並記一次違約'
    : '走的是 markShipDefault()（F-5）：票金已結算所以不退款，只記違約')
  if (refunded) {
    /* monitor 的 zombie-shipment：退款後出貨單不能還停在「待處理」 */
    const ids = shBefore.map(x => x.id as string)
    const shs = await sql<Any[]>`select id, status, prize_ids from shipments where id = any(${ids}::text[])`
    ck('素材：退款前這張卡在出貨單上', ids.length > 0, `${ids.length} 張`)
    ck('退款後原本那張出貨單不再是「待處理」，而且卡已經從單上拿掉',
      shs.length === ids.length && shs.every(x =>
        x.status !== 'requested' && !(x.prize_ids as string[]).includes(pz!)),
      JSON.stringify(shs.map(x => [x.status, x.prize_ids])))
  }
  ck('賣家的違約次數 +1（用的是既有的 sellers.default_count，不是新欄位）',
    Number(sellerAfter?.default_count) === Number(sellerBefore?.default_count) + 1,
    `${sellerBefore?.default_count} → ${sellerAfter?.default_count}`)
  const sn = await notif(seller.token)
  ck('賣家收到既有的逾期通知', hasNotif(sn, '逾期'), JSON.stringify(sn.map(n => n.title)).slice(0, 300))

  /* 再掃一次：違約不能被記第二次（ship_default_at / refund 的 returning 守衛） */
  await call(seller.token, '/v1/seller/settlements')
  const [sellerAgain] = await sql<Any[]>`select default_count from sellers where id = ${SEED_POOL_SELLER}`
  ck('再讀一次出貨頁不會把同一筆逾期再記一次',
    Number(sellerAgain?.default_count) === Number(sellerAfter?.default_count),
    `${sellerAfter?.default_count} → ${sellerAgain?.default_count}`)
}

/* ────────────────────────────────────────────────────────────────────
   5b 正式環境真正會走的那一條：票金已釋放（released）的 F-5 路
   ──────────────────────────────────────────────────────────────────── */
head('5b 票金已結算的卡（released）：記違約，不退款')
{
  /* 為什麼要單獨一組：寄存期是 90 天，而寄存確認期只有 14 天 ——
     到了第 90 天，結算幾乎**一定**已經是 released（票金早就放給賣家）。
     上面那一組因為是現抽現到期，走的是 held → awaiting_ship → refund()；
     那條在正式環境幾乎不會發生。這一組才是真的那一條。 */
  const [pz] = await draw(buyer.token, 1)
  /* 先讓寄存確認期（14 天）過掉，用既有的 rewind + 既有的掃描觸發點 */
  await rewind(pz!, 15 * DAY)
  await call(buyer.token, '/v1/prizes')
  const st0 = await settlementRow(pz!)
  ck('素材：票金已經釋放給賣家（released）', st0?.status === 'released', String(st0?.status))
  ck('素材：而且還沒有任何出貨期限', st0?.ship_due_at == null, String(st0?.ship_due_at))

  await expireStash(pz!)
  const out = await sweepStash()
  ck('released 的卡一樣會被自動出貨', Number(out.shipped) >= 1, JSON.stringify(out))
  const st1 = await settlementRow(pz!)
  ck('掛上了出貨期限', st1?.ship_due_at != null, String(st1?.ship_due_at))
  ck('**狀態留在 released，沒有被改回 awaiting_ship**', st1?.status === 'released', String(st1?.status))
  note('（改回去等於把已經放給賣家、他可能已經花掉的錢重新凍起來 —— 見 migration 022）')

  const [before] = await sql<Any[]>`select default_count from sellers where id = ${SEED_POOL_SELLER}`
  const walletBefore = await json(await call(buyer.token, '/v1/wallet'))
  await rewind(pz!, 5 * DAY)
  await call(seller.token, '/v1/seller/settlements')

  const st2 = await settlementRow(pz!)
  const [after] = await sql<Any[]>`select default_count from sellers where id = ${SEED_POOL_SELLER}`
  ck('**逾期走的是 markShipDefault()（F-5），不是另一條平行的路**',
    st2?.ship_default_at != null, `ship_default_at=${st2?.ship_default_at}`)
  ck('賣家違約次數 +1', Number(after?.default_count) === Number(before?.default_count) + 1,
    `${before?.default_count} → ${after?.default_count}`)
  ck('**不退款**（那筆錢是依規則釋放的，事後追回等於平台推翻自己的規則）',
    st2?.status === 'released', String(st2?.status))
  const walletAfter = await json(await call(buyer.token, '/v1/wallet'))
  ck('買家的餘額沒有變（沒有退款）',
    walletAfter.wallet?.balance === walletBefore.wallet?.balance,
    `${walletBefore.wallet?.balance} → ${walletAfter.wallet?.balance}`)
  ck('義務沒有結清 —— 卡還停在出貨申請中，賣家還是要寄',
    (await prizeRow(pz!))?.status === 'ship_requested', String((await prizeRow(pz!))?.status))

  /* 冪等第二層：違約不能被記第二次 */
  await call(seller.token, '/v1/seller/settlements')
  const [again] = await sql<Any[]>`select default_count from sellers where id = ${SEED_POOL_SELLER}`
  ck('再掃一次不會把同一筆違約再記一次',
    Number(again?.default_count) === Number(after?.default_count),
    `${after?.default_count} → ${again?.default_count}`)
}

/* ────────────────────────────────────────────────────────────────────
   6 併發：兩個掃描同時進來
   ──────────────────────────────────────────────────────────────────── */
head('6 併發：同時觸發不死鎖、不重複建單')
{
  const ids = await draw(buyer.token, 6)
  for (const id of ids) await expireStash(id)
  const [dl0] = await sql<Any[]>`select deadlocks from pg_stat_database where datname = current_database()`

  const results = await Promise.all([sweepStash(), sweepStash(), sweepStash(), sweepStash()])
  note(`四路同時掃描的回報：${results.map(r => JSON.stringify(r)).join(' ')}`)

  const [dl1] = await sql<Any[]>`select deadlocks from pg_stat_database where datname = current_database()`
  ck('**deadlocks 增量為 0**', Number(dl1?.deadlocks) === Number(dl0?.deadlocks),
    `${dl0?.deadlocks} → ${dl1?.deadlocks}`)
  ck('四路都沒有炸掉（回的都是正常的計數物件）',
    results.every(r => typeof r.shipped === 'number'), JSON.stringify(results))

  let bad = 0
  for (const id of ids) {
    const n = (await shipmentsFor(id)).length
    if (n !== 1) { bad++; note(`  ${id} 有 ${n} 張出貨單`) }
  }
  ck('六張卡各自只有一張出貨單', bad === 0, `${bad} 張卡的出貨單數不對`)
  const total = results.reduce((a, r) => a + Number(r.shipped), 0)
  ck('四路加起來剛好處理了六張（沒有人重複處理）', total === 6, `合計 ${total}`)
}

console.log(`\n${pass} passed / ${fail} failed`)
await sql.end()
process.exit(fail ? 1 : 0)
