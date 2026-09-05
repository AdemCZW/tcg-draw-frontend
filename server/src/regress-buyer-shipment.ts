/**
 * 買家端出貨單讀取端點的迴歸測試（補 699e239 / D-1 自己留下的缺口）。
 *
 * ── 這一支要釘住的那幾句話 ──────────────────────────────────────────
 * 1. **核心**：寄存到期 → 自動出貨 → 買家打 `/v1/shipments/for-prize/:id`
 *    看得到 **`origin = 'auto-stash-expiry'`**（「這不是你按的」）
 *    與**會寄到哪**（遮罩過的收件地點）。
 *    他沒按過任何按鈕、卡的狀態卻變了 —— 端點要說得出為什麼。
 * 2. **手動申請的單也回得出來，而且分得出跟自動的差別**：`origin = 'self'`。
 *    只驗「自動的會回 auto」不算數 —— 一個永遠回 auto 的實作也會全綠。
 * 3. **權限**：別人的出貨單一律 **404 不是 403**（403 等於確認那張單存在，
 *    而 id 猜得到）；未登入 401。
 * 4. **個資**：回應裡沒有完整的收件人姓名、電話、地址；
 *    server log 掃過同樣三個字串，命中 0。
 * 5. **進度**：賣家真的寄出之後，同一支端點的 status 會跟著走，
 *    賣家的期限會歸零 —— 不是一個建完就凍住的快照。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   createdb vd_buyership
 *   DATABASE_URL=postgres://localhost:5432/vd_buyership JWT_SECRET=<32+> \
 *     npx tsx src/migrate.ts && npx tsx src/seed.ts
 *   DATABASE_URL=... JWT_SECRET=... PORT=8099 DEV_LOGIN=1 DEV_LOGIN_SECRET=<32+> \
 *     npx tsx src/index.ts > server.log
 *   DATABASE_URL=... DEV_LOGIN_SECRET=<同值> \
 *     npx tsx src/regress-buyer-shipment.ts http://localhost:8099 [server.log]
 *
 * 第二個參數給了就會做第 6 組（掃 server log 找個資）；沒給就跳過那一組。
 *
 * ⚠️ 要有自己的乾淨資料庫，不要跟 smoke 共用（理由同 regress-autoship.ts：
 * 兩邊都會消耗種子池的籤）。
 */
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sql } from './db.js'

const base = (process.argv[2] ?? 'http://localhost:8099').replace(/\/$/, '')
const logPath = process.argv[3]
const devSecret = process.env.DEV_LOGIN_SECRET
if (!devSecret) throw new Error('regress-buyer-shipment 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const json = (r: Response): Promise<Any> => r.json()
let pass = 0, fail = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
const note = (s: string) => console.log(`       ${s}`)
const head = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 54 - s.length))}`)

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
const putProfile = (t: string, b: unknown) =>
  fetch(`${base}/v1/auth/profile`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    body: JSON.stringify(b)
  })

const RUN = randomBytes(4).toString('hex')
let seq = 0
const uniq = () => `${RUN}-${++seq}`

const sweepStash = async (): Promise<Any> =>
  json(await fetch(`${base}/v1/dev/sweep-stash`, {
    method: 'POST', headers: { 'x-dev-login-secret': devSecret! }
  }))

/** 把一張卡的寄存期限撥到過去。那一欄只在抽中的當下寫一次，沒有 API 改得動 */
const expireStash = (prizeId: string) =>
  sql`update prizes set stash_expires_at = ${Date.now() - 60_000} where id = ${prizeId}`

const settlementRow = async (prizeId: string) => {
  const [r] = await sql<Any[]>`
    select id, seller_id, status, ship_due_at, shipped_at from pool_settlements where prize_id = ${prizeId}
  `
  return r
}

const SEED_POOL = 'p-seed-1-g2'

/** 抽 n 籤，回傳卡冊裡那 n 列的 id。走真的抽卡，所以每一張都有活著的結算列 */
async function draw(token: string, n: number): Promise<string[]> {
  const free = await sql<Any[]>`
    select seat from pool_seats where pool_id = ${SEED_POOL} and taken_by is null order by seat limit ${n}
  `
  if (free.length < n) throw new Error(`種子池的空籤不夠（要 ${n}，只剩 ${free.length}）`)
  const r = await post(token, `/v1/pools/${SEED_POOL}/draw`, {
    seats: free.map(f => Number(f.seat)), idempotencyKey: 'buyership-' + uniq()
  })
  const b = await json(r.clone())
  if (!r.ok) throw new Error(`抽卡失敗 ${r.status} ${JSON.stringify(b).slice(0, 300)}`)
  return (b.items as Any[]).map(i => i.stashId as string)
}

/* 這三個字串是整支測試的個資標的：回應與 server log 裡都不可以出現。
   刻意選成獨一無二的字串（帶 RUN），這樣「命中 0」才代表真的沒有，
   而不是剛好跟別的東西撞不到。 */
const SECRET_NAME = `林測試${RUN}`
const SECRET_PHONE = '09' + RUN.replace(/\D/g, '').padEnd(8, '7').slice(0, 8)
const SECRET_LINE1 = `保密街${RUN} 88 巷 12 號 7 樓`
const ADDRESS = {
  realName: SECRET_NAME, phone: SECRET_PHONE,
  addressZip: '106', addressCity: '台北市大安區', addressLine1: SECRET_LINE1
}
/* 手動申請那條路允許單次覆寫（ShipBody），所以用另一份地址 ——
   它同時是第 5 組「differsFromProfile 對自己申請的單是正常的」的素材。 */
const OVERRIDE_LINE1 = `臨時路${RUN} 3 號`

const platform = await login('platform', 'VaultDraw 官方')
const buyer = await login('buyership-buyer', '收貨的買家')
const other = await login('buyership-other', '不相干的路人')
const seller = await login('seller', '種子賣家')
for (const u of [buyer.userId, other.userId]) {
  await post(platform.token, '/v1/admin/grant', { userId: u, points: 5_000_000, note: '買家出貨單測試' })
}
await putProfile(buyer.token, ADDRESS)

/* ════════════════════════════════════════════════════════════════════
   1 核心：自動出貨的單，買家看得出「這是系統建的」與「寄去哪」
   ════════════════════════════════════════════════════════════════════ */
head('1 自動出貨：買家看得到 origin 與寄送地點（核心）')
let autoShipmentId = ''
let autoPrize = ''
{
  const [pz] = await draw(buyer.token, 1)
  autoPrize = pz!

  /* 還沒到期時就先打一次：這張卡還在 stashed，不該有任何出貨單。
     少了這一條，「永遠回一張單」的實作也會全綠。 */
  const before = await call(buyer.token, `/v1/shipments/for-prize/${pz}`)
  ck('卡還在寄存中時，這張卡沒有出貨單（404）', before.status === 404, String(before.status))

  await expireStash(pz!)
  const out = await sweepStash()
  note(`sweep-stash 回：${JSON.stringify(out)}`)
  ck('素材：掃描自動出貨了至少一張', Number(out.shipped) >= 1, JSON.stringify(out))

  const r = await call(buyer.token, `/v1/shipments/for-prize/${pz}`)
  ck('買家用卡片 id 就查得到這張出貨單', r.ok, `${r.status} ${await r.clone().text()}`)
  const v = await json(r)
  autoShipmentId = String(v.id)
  note(`回應：${JSON.stringify({ ...v, shipTo: v.shipTo, cards: `${v.cards?.length} 張` })}`)

  ck('**origin = auto-stash-expiry —— 說得出「這不是你按的」**',
    v.origin === 'auto-stash-expiry', String(v.origin))
  ck('狀態是 requested（賣家還沒寄）', v.status === 'requested', String(v.status))
  ck('**看得到會寄到哪個縣市**（他要判斷的是「還是不是這裡」）',
    v.shipTo?.city === ADDRESS.addressCity, JSON.stringify(v.shipTo))
  ck('郵遞區號也給全文（三碼是一個行政區，指不到人）',
    v.shipTo?.zip === ADDRESS.addressZip, String(v.shipTo?.zip))
  ck('**看得到賣家的期限到什麼時候**', typeof v.sellerDueAt === 'number' && v.sellerDueAt > Date.now(),
    String(v.sellerDueAt))
  ck('期限還沒到，所以沒有逾期', v.sellerOverdue === false, String(v.sellerOverdue))
  ck('卡片清單帶得出這張卡與賣家是誰',
    v.cards?.length === 1 && v.cards[0].prizeId === pz && !!v.cards[0].sellerName,
    JSON.stringify(v.cards))
  ck('卡片的狀態是 ship_requested（跟卡冊上那一格同一件事）',
    v.cards?.[0]?.prizeStatus === 'ship_requested', String(v.cards?.[0]?.prizeStatus))
  ck('自動建的單，地址就是他自己資料裡那一份（differsFromProfile = false）',
    v.differsFromProfile === false, String(v.differsFromProfile))
  ck('端點自己講清楚地址現在改不動（addressEditable = false）',
    v.addressEditable === false, String(v.addressEditable))

  /* 同一張單用 id 查也要拿得到，而且是同一份東西 */
  const byId = await json(await call(buyer.token, `/v1/shipments/${autoShipmentId}`))
  ck('用出貨單 id 查得到同一張單', byId.id === autoShipmentId && byId.origin === v.origin,
    `${byId.id} / ${byId.origin}`)
}

/* ════════════════════════════════════════════════════════════════════
   2 個資：地址是遮罩的，全文一個欄位都不外流
   ════════════════════════════════════════════════════════════════════ */
head('2 收件地址回遮罩版，全文不外流')
{
  const r = await call(buyer.token, `/v1/shipments/${autoShipmentId}`)
  const text = await r.clone().text()
  const v = await json(r)

  ck('**整包回應裡沒有收件人的全名**', !text.includes(SECRET_NAME))
  ck('**整包回應裡沒有完整電話**', !text.includes(SECRET_PHONE))
  ck('**整包回應裡沒有完整的地址那一行**', !text.includes(SECRET_LINE1))

  ck('回應自己標明這是遮罩過的（讀的人不會拿去當寄件資料）', v.shipTo?.masked === true)
  ck('姓還在（認得出是不是填成別人的）', String(v.shipTo?.nameMasked ?? '').startsWith('林'),
    String(v.shipTo?.nameMasked))
  ck('名字被遮掉了', !String(v.shipTo?.nameMasked ?? '').includes(SECRET_NAME.slice(1)),
    String(v.shipTo?.nameMasked))
  ck('電話只剩末三碼', String(v.shipTo?.phoneMasked ?? '').endsWith(SECRET_PHONE.slice(-3))
    && String(v.shipTo?.phoneMasked ?? '').length <= 5, String(v.shipTo?.phoneMasked))
  ck('地址留頭留尾、中間遮掉（認得出、拼不回）',
    String(v.shipTo?.line1Masked ?? '').startsWith(SECRET_LINE1.slice(0, 3))
    && String(v.shipTo?.line1Masked ?? '').endsWith(SECRET_LINE1.slice(-4).trimStart())
    && String(v.shipTo?.line1Masked ?? '').includes('⋯'),
    String(v.shipTo?.line1Masked))
  ck('遮罩後的長度遠短於原文（沒有把全文換個包裝送出去）',
    String(v.shipTo?.line1Masked ?? '').length < SECRET_LINE1.length,
    `${String(v.shipTo?.line1Masked).length} vs ${SECRET_LINE1.length}`)
  /* 賣家那一側**必須**拿得到全文，否則他寄不出去 —— 這一條同時證明
     「遮罩」是這支端點的決定，不是資料本身壞掉了。 */
  const st = await settlementRow(autoPrize)
  const sellerView = await json(await call(seller.token, '/v1/seller/settlements'))
  const line = (sellerView.settlements ?? []).find((s: Any) => s.id === st?.id)
  ck('對照組：要寄貨的賣家仍然拿得到全文（遮罩只發生在買家這一側）',
    line?.ship_to?.line1 === SECRET_LINE1 && line?.ship_to?.phone === SECRET_PHONE,
    line?.ship_to ? '欄位對不上' : 'ship_to 是 null')
}

/* ════════════════════════════════════════════════════════════════════
   3 手動申請的單也回得出來，而且分得出跟自動的差別
   ════════════════════════════════════════════════════════════════════ */
head('3 手動申請的單：origin = self')
let selfShipmentId = ''
{
  const [pz] = await draw(buyer.token, 1)
  const rr = await post(buyer.token, '/v1/prizes/ship', {
    prizeIds: [pz],
    address: {
      name: SECRET_NAME, phone: SECRET_PHONE, zip: ADDRESS.addressZip,
      city: ADDRESS.addressCity, line1: OVERRIDE_LINE1
    }
  })
  ck('素材：手動申請出貨成功', rr.ok, `${rr.status} ${await rr.clone().text()}`)
  selfShipmentId = String((await json(rr)).shipmentId)

  const v = await json(await call(buyer.token, `/v1/shipments/for-prize/${pz}`))
  ck('**手動申請的單 origin = self**', v.origin === 'self', String(v.origin))
  ck('而且它跟自動那張是不同的單（不是同一份被回兩次）',
    v.id === selfShipmentId && v.id !== autoShipmentId, `${v.id} vs ${autoShipmentId}`)
  ck('手動單一樣看得到寄送地點與賣家期限',
    v.shipTo?.city === ADDRESS.addressCity && typeof v.sellerDueAt === 'number',
    JSON.stringify({ city: v.shipTo?.city, due: v.sellerDueAt }))
  ck('手動單的地址也是遮罩的（不因為是他自己填的就給全文）',
    !JSON.stringify(v).includes(OVERRIDE_LINE1) && v.shipTo?.masked === true)
  /* 單次覆寫 ≠ 資料錯了。這個旗標在 self 的單上為 true 是正常的，
     前端要看 origin 決定要不要講 —— 這一條就是把那個語意釘住。 */
  ck('單次覆寫的地址跟他的預設資料不同 → differsFromProfile = true',
    v.differsFromProfile === true, String(v.differsFromProfile))
}

/* ════════════════════════════════════════════════════════════════════
   4 權限：別人的單 404、未登入 401
   ════════════════════════════════════════════════════════════════════ */
head('4 權限：別人的看不到（404 不是 403），未登入 401')
{
  const byId = await call(other.token, `/v1/shipments/${autoShipmentId}`)
  ck('**別人用 id 查我的出貨單 → 404**（403 等於確認那張單存在）',
    byId.status === 404, String(byId.status))
  ck('而且訊息跟「單不存在」一模一樣（回應內容也不能洩漏存在與否）',
    (await json(byId)).error === 'NOT_FOUND')

  const byPrize = await call(other.token, `/v1/shipments/for-prize/${autoPrize}`)
  ck('**別人用我的卡片 id 反查 → 404**', byPrize.status === 404, String(byPrize.status))

  const ghost = await call(other.token, '/v1/shipments/sh-0000000000')
  ck('查一張根本不存在的單也是 404（兩種情況分不出來）', ghost.status === 404, String(ghost.status))

  const bodyExists = await (await call(buyer.token, `/v1/shipments/${autoShipmentId}`)).text()
  const bodyOther = await (await call(other.token, `/v1/shipments/${autoShipmentId}`)).text()
  ck('對照：同一個 id，主人拿得到內容、別人拿到的是空的 404',
    bodyExists.includes('auto-stash-expiry') && !bodyOther.includes('auto-stash-expiry'))

  const anon = await fetch(`${base}/v1/shipments/${autoShipmentId}`)
  ck('**未登入 → 401**', anon.status === 401, String(anon.status))
  const anonList = await fetch(`${base}/v1/shipments`)
  ck('未登入連清單也拿不到（401）', anonList.status === 401, String(anonList.status))
  const badToken = await fetch(`${base}/v1/shipments`, { headers: { authorization: 'Bearer not-a-real-token' } })
  ck('亂打的 token → 401', badToken.status === 401, String(badToken.status))

  /* 清單那一支也要綁死。別人的清單裡不可以出現我的單。 */
  const mine = await json(await call(buyer.token, '/v1/shipments'))
  const theirs = await json(await call(other.token, '/v1/shipments'))
  ck('我的清單看得到我的兩張單', (mine.items ?? []).length >= 2, `${(mine.items ?? []).length} 張`)
  ck('**別人的清單一張都沒有我的**',
    !(theirs.items ?? []).some((x: Any) => x.id === autoShipmentId || x.id === selfShipmentId),
    JSON.stringify((theirs.items ?? []).map((x: Any) => x.id)))
  ck('清單裡自動與手動兩種都在，而且標得出來',
    (mine.items ?? []).some((x: Any) => x.origin === 'auto-stash-expiry')
    && (mine.items ?? []).some((x: Any) => x.origin === 'self'),
    JSON.stringify((mine.items ?? []).map((x: Any) => x.origin)))
  ck('清單裡的地址一樣是遮罩的（列表是最容易漏掉的那一個出口）',
    !JSON.stringify(mine).includes(SECRET_LINE1) && !JSON.stringify(mine).includes(SECRET_PHONE))
  const badCursor = await call(buyer.token, '/v1/shipments?cursor=%E4%B8%8D%E5%90%88%E6%B3%95')
  ck('畸形游標回 400，不是 500', badCursor.status === 400, String(badCursor.status))
  const badLimit = await call(buyer.token, '/v1/shipments?limit=9999')
  ck('超界的 limit 回 400（不默默截斷）', badLimit.status === 400, String(badLimit.status))
}

/* ════════════════════════════════════════════════════════════════════
   5 搬家了：地址快照不會自己更新，但端點講得出來
   ════════════════════════════════════════════════════════════════════ */
head('5 改了「我的資料」之後，出貨單上的還是舊那份')
{
  const beforeText = await (await call(buyer.token, `/v1/shipments/${autoShipmentId}`)).text()
  const before = JSON.parse(beforeText)
  ck('前提：現在兩份是一樣的', before.differsFromProfile === false)

  await putProfile(buyer.token, { ...ADDRESS, addressCity: '高雄市左營區', addressLine1: `搬家路${RUN} 1 號` })
  const after = await json(await call(buyer.token, `/v1/shipments/${autoShipmentId}`))
  ck('**改完資料，出貨單上那份沒有跟著變**（它是快照，賣家看到的也是這一份）',
    after.shipTo?.city === ADDRESS.addressCity, String(after.shipTo?.city))
  ck('**而端點會說「跟你現在的資料不一樣」**（差異看得見，不是靜靜地寄錯）',
    after.differsFromProfile === true, String(after.differsFromProfile))
  ck('地址仍然改不動，前端據此指向客服而不是編輯鈕', after.addressEditable === false)
  // 改回去，不影響後面幾組
  await putProfile(buyer.token, ADDRESS)
}

/* ════════════════════════════════════════════════════════════════════
   6 進度會走：賣家寄出之後同一支端點跟著變
   ════════════════════════════════════════════════════════════════════ */
head('6 賣家寄出 → status 跟著走、期限歸零')
{
  const st = await settlementRow(autoPrize)
  const shipRes = await post(seller.token, `/v1/seller/settlements/${st?.id}/ship`, {})
  ck('素材：賣家用既有端點寄出', shipRes.ok, `${shipRes.status} ${await shipRes.clone().text()}`)

  const v = await json(await call(buyer.token, `/v1/shipments/${autoShipmentId}`))
  ck('**出貨單的狀態變成 shipped**（不是一個建完就凍住的欄位）',
    v.status === 'shipped', String(v.status))
  ck('卡片列也是 shipped（兩張表沒有各說各話）',
    v.cards?.[0]?.prizeStatus === 'shipped', String(v.cards?.[0]?.prizeStatus))
  ck('賣家的期限歸零了（義務結束，不該再顯示一個過去的日期）',
    v.sellerDueAt === null && v.sellerOverdue === false,
    `${v.sellerDueAt} / ${v.sellerOverdue}`)
  ck('那張卡自己那一格記下了賣家的出貨時間',
    typeof v.cards?.[0]?.sellerShippedAt === 'number', String(v.cards?.[0]?.sellerShippedAt))
  ck('origin 不會因為進度往前走就變了',
    v.origin === 'auto-stash-expiry', String(v.origin))
}

/* ════════════════════════════════════════════════════════════════════
   7 server log 掃過個資，命中 0
   ════════════════════════════════════════════════════════════════════ */
head('7 server log 沒有收件人／電話／地址')
if (logPath) {
  const log = readFileSync(logPath, 'utf8')
  for (const [label, needle] of [
    ['收件人姓名', SECRET_NAME], ['電話', SECRET_PHONE],
    ['完整地址', SECRET_LINE1], ['覆寫的地址', OVERRIDE_LINE1]
  ] as [string, string][]) {
    const hits = log.split('\n').filter(l => l.includes(needle)).length
    ck(`server log 掃過${label}：命中 0`, hits === 0, `${hits} 行`)
  }
  /* 出貨單以 id 定址，所以地址不可能出現在網址裡 —— 但 logger() 會把
     每一條網址印出來，所以順便驗一次「沒有人把地址塞進 query string」。 */
  const urlLines = log.split('\n').filter(l => l.includes('/v1/shipments'))
  ck('log 裡的 /v1/shipments 請求行沒有夾帶任何地址片段',
    !urlLines.some(l => l.includes(SECRET_NAME) || l.includes(SECRET_PHONE)
      || l.includes(SECRET_LINE1) || l.includes(OVERRIDE_LINE1)),
    `${urlLines.length} 行`)
  note(`掃了 ${log.split('\n').length} 行 log`)
} else {
  note('（沒有給 log 路徑，跳過這一組）')
}

console.log(`\n${pass} passed / ${fail} failed`)
await sql.end()
process.exit(fail ? 1 : 0)
