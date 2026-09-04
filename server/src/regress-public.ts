/**
 * routes/public.ts 這一輪四條的迴歸測試：A-5、A-6、L-1、L-2。
 *
 *   npx tsx src/regress-public.ts http://localhost:8091
 *
 * ⚠️ **要有自己的乾淨資料庫**（migrate + seed 一個新庫），理由同 regress-pledge：
 * 這支會開池、讓池到期、上下架，會把別支測試預期的種子狀態改掉。
 * 需要伺服器帶著 DEV_LOGIN=1 與相同的 DEV_LOGIN_SECRET 跑。
 *
 * 四條驗的是什麼：
 *
 *   A-5  in_book 的卡 上架 → 下架 之後必須回到 in_book，而且**真的能再開池**
 *        （不是只看欄位值 —— 欄位對了但開池被擋，使用者的處境沒有任何改善）。
 *        stashed 走 vault 那條不能退化；成交那條不能被誤還原。
 *   A-6  公開池詳情的展示卡片不帶 certNo，**但 revealed 的 manifest 仍然帶**
 *        而且驗算還算得過 —— 後面那半是這條的反向，沒驗等於沒做。
 *   L-1  掛單價的十種畸形輸入全部 400、訊息中文可讀，一個 500 都不能有。
 *   L-2  沒登入抓得到的每一條回應，整包遞迴掃不到 certNo，也掃不到實際編號字串。
 */
const base = (process.argv[2] ?? 'http://localhost:8091').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
const devHeaders = () => {
  if (!devSecret) throw new Error('regress-public 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')
  return { 'x-dev-login-secret': devSecret }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const json = (r: Response): Promise<Any> => r.json()
let pass = 0, fail = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
const head = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 52 - s.length))}`)

async function login(handle: string, name: string) {
  const r = await fetch(`${base}/v1/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
    body: JSON.stringify({ handle, name })
  })
  if (!r.ok) throw new Error(`login ${handle}: ${r.status}`)
  return (await json(r)).token as string
}
const call = (t: string, p: string, b?: unknown) =>
  fetch(`${base}${p}`, {
    method: b === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    ...(b === undefined ? {} : { body: JSON.stringify(b) })
  })

const platform = await login('platform', 'VaultDraw 官方')
const seller = await login('seller', '測試賣家')
await call(platform, '/v1/admin/grant', { userId: 'u-seller', points: 5_000_000, note: 'public 測試' })

/* 編號帶執行時間戳：登記過的編號永遠佔著唯一索引，固定值第二次跑會被上一輪擋住 */
const RUN = String(Date.now()).slice(-8)
const certCard = (certNo: string) => ({
  id: 'c-SV4a-349', name: '噴火龍 ex SAR', artId: 'SV4a-349', cardNo: '349/190',
  setCode: 'sv4a', language: 'JP', grader: 'PSA', grade: 10, certNo, refPrice: 26000
})
const plainCard = {
  id: 'c-SV8a-237', name: '太樂巴戈斯 ex UR', artId: 'SV8a-237', cardNo: '237/187',
  setCode: 'sv8a', language: 'JP', grader: 'RAW', grade: null, certNo: null, refPrice: 900
}
/**
 * 把一張卡登記進卡冊，回傳那一列的 id。
 *
 * A-4 之後 `prizeId` 是必填的：建池只能從卡冊挑，023 那條「內嵌鑑定卡
 * 就順手替你開一列」的舊路徑已經整條收掉。所以原本靠建池順便產生的
 * 那一列卡，現在要自己先登記 —— **驗的東西一條都沒有變**，
 * 只是「那一列卡從哪裡來」換了地方。
 *
 * 同一個編號登記第二次時 /v1/cardbook/upload 回 409 ALREADY_IN_BOOK
 * 並帶著既有那一列的 prizeId，這裡照收：這幾支測試問的正是
 * 「拿同一張卡（同一列）再開一次池會怎樣」。
 */
async function bookCard(tok: string, card: Record<string, unknown>): Promise<string> {
  const r = await call(tok, '/v1/cardbook/upload', { card })
  const b = await json(r.clone())
  if (r.ok) return b.prize.id as string
  if (b.error === 'ALREADY_IN_BOOK' && b.prizeId) return b.prizeId as string
  throw new Error(`登記卡片失敗 ${r.status} ${JSON.stringify(b).slice(0, 200)}`)
}
let nameSeq = 0
/* 裸卡沒有編號，卡冊裡可以有很多列同名的卡；名字帶序號只是為了讀測試
   輸出時分得出是哪一張，不是規則。 */
const uniqName = () => `${Date.now().toString(36)}-${++nameSeq}`

/* N 籤的池 = N 張實體卡（1 張鑑定卡 + N−1 張裸卡），全部先進卡冊再挑。 */
const makePool = async (title: string, certNo: string, tickets = 4) => {
  const certId = await bookCard(seller, certCard(certNo))
  const plainIds: string[] = []
  for (let i = 0; i < tickets - 1; i++) {
    plainIds.push(await bookCard(seller, { ...plainCard, name: `${plainCard.name} ${uniqName()}` }))
  }
  return call(seller, '/v1/pools', {
    mode: 'muteki', title, ticketPrice: 2000, totalTickets: tickets, days: 7,
    prizes: [
      { tier: 'A', prizeId: certId, card: certCard(certNo), total: 1 },
      ...plainIds.map(id => ({ tier: 'D' as const, prizeId: id, card: plainCard, total: 1 }))
    ],
    tierBuyback: { A: 3000, D: 200 }
  })
}

const prizeOf = async (tok: string, pred: (x: Any) => boolean) =>
  ((await json(await call(tok, '/v1/prizes?limit=100'))).items ?? []).find(pred)

/** 開池 → 到期 → 解押，造一張 in_book 的卡出來（跟 regress-pledge 同一條路） */
async function makeInBookCard(cert: string) {
  /* 池名**不能**帶編號：後面 L-2 的掃描是拿編號字串去整包比對，
     池名帶著它會變成自己撞自己的假失敗（而且會掩蓋真的洩漏）。 */
  const r = await makePool('素材池（回收用）', cert)
  if (!r.ok) throw new Error(`建池失敗：${r.status} ${(await r.text()).slice(0, 200)}`)
  const poolId = (await json(r)).poolId as string
  await fetch(`${base}/v1/dev/expire-pool`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
    body: JSON.stringify({ poolId })
  })
  /* 到期→cancelled→revealed 是同一支掃描的兩個分支，推兩次以上 */
  for (let i = 0; i < 4; i++) {
    await fetch(`${base}/v1/dev/sweep-pools`, { method: 'POST', headers: devHeaders() })
    const { pool } = await json(await call(seller, `/v1/pools/${poolId}`))
    if (pool?.status === 'revealed') break
  }
  return await prizeOf(seller, (x: Any) => x.card?.certNo === cert)
}

/* ══════════════ A-5：往返 ══════════════════════════════════════════ */

head('A-5：in_book → 上架 → 下架 → 還是 in_book，而且真的能再開池')
{
  const cert = `STUB-A5-349-${RUN}`
  const card = await makeInBookCard(cert)
  ck('素材：卡解押回 in_book', card?.status === 'in_book', `status=${card?.status}`)

  const lr = await call(seller, '/v1/listings', { prizeId: card.id, price: 500 })
  const lb = await json(lr.clone())
  ck('in_book 的卡上架成功', lr.ok, `${lr.status} ${JSON.stringify(lb).slice(0, 200)}`)
  ck('交付方式是需寄送（實體在持有人手上）', lb.listing?.delivery === 'ship', `delivery=${lb.listing?.delivery}`)

  const dr = await call(seller, `/v1/listings/${lb.listing.id}/delist`, {})
  ck('下架成功', dr.ok, `${dr.status}`)

  const after = await prizeOf(seller, (x: Any) => x.id === card.id)
  ck('★ 狀態回到 in_book（修好之前這裡是 shipped）', after?.status === 'in_book', `status=${after?.status}`)

  /* 欄位值只是必要條件。真正要證明的是「這張卡救得回來」：拿同一個編號
     再開一次池，走完整的建池 API。修好之前這一步會被 CARD_BUSY 擋死。 */
  const again = await makePool('A-5 回收後再開池', cert)
  const ab = await json(again.clone())
  ck('★ 同一張卡真的能再開池（打真的建池 API）', again.ok,
    `${again.status} ${JSON.stringify(ab).slice(0, 200)}`)
  const reused = await prizeOf(seller, (x: Any) => x.card?.certNo === cert)
  ck('而且重用同一列、狀態 in_pool', reused?.id === card.id && reused?.status === 'in_pool',
    `${card.id}/${reused?.id} status=${reused?.status}`)
}

head('A-5：stashed 走 vault 那條不能退化')
{
  /* 需要一張 stashed（寄存在平台）的卡 —— 那是 delivery = 'vault' 的唯一來源。
     從**種子已經開賣的池**抽一張，不自己開池：開賣要等 drand 的未來輪次到期，
     那是外部服務的時鐘，測試等它等不到，也不該讓一支迴歸測試的成敗
     取決於別人的 API 現在回不回 425。 */
  const buyer = await login('a5buyer', 'A-5 買家')
  await call(platform, '/v1/admin/grant', { userId: 'u-a5buyer', points: 500_000, note: 'public 測試' })
  const pools = (await json(await fetch(`${base}/v1/pools`))).pools ?? []
  const openPool = pools.find((p: Any) => p.status === 'open' && p.remainingTickets > 0)
  ck('素材：種子裡有已開賣的池', !!openPool, '沒有 open 的池')
  const taken = new Set<number>(openPool?.takenSeats ?? [])
  let seat = 0
  for (let i = 1; i <= (openPool?.totalTickets ?? 0); i++) if (!taken.has(i)) { seat = i; break }
  const drawR = await call(buyer, `/v1/pools/${openPool.id}/draw`,
    { seats: [seat], idempotencyKey: `pub-draw-${RUN}-${seat}` })
  ck('素材：抽到卡', drawR.ok, `${drawR.status} ${(await drawR.clone().text()).slice(0, 200)}`)
  const won = await prizeOf(buyer, (x: Any) => x.status === 'stashed')
  ck('素材：手上有一張 stashed 的卡', !!won, '沒有 stashed 的卡')

  const lr = await call(buyer, '/v1/listings', { prizeId: won.id, price: 700 })
  const lb = await json(lr.clone())
  ck('stashed 的卡上架成功', lr.ok, `${lr.status} ${JSON.stringify(lb).slice(0, 200)}`)
  ck('交付方式是庫內轉移', lb.listing?.delivery === 'vault', `delivery=${lb.listing?.delivery}`)
  const dr = await call(buyer, `/v1/listings/${lb.listing.id}/delist`, {})
  ck('下架成功', dr.ok, `${dr.status}`)
  const after = await prizeOf(buyer, (x: Any) => x.id === won.id)
  ck('狀態回到 stashed（沒有退化）', after?.status === 'stashed', `status=${after?.status}`)
}

head('A-5：成交那條路不會被錯誤還原（卡易主了）')
{
  /* 庫內轉移成交：掛單變 sold、卡當場過戶給買家並且是 stashed。
     還原邏輯只掛在 delist 上，這裡要證明它沒有被順手套用到 sold。 */
  const seller2 = await login('a5buyer', 'A-5 買家')   // 上一段的買家改當賣家
  const buyer2 = await login('a5buyer2', 'A-5 買家二')
  await call(platform, '/v1/admin/grant', { userId: 'u-a5buyer2', points: 200_000, note: 'public 測試' })
  const mine = await prizeOf(seller2, (x: Any) => x.status === 'stashed')
  ck('素材：手上有一張 stashed 的卡', !!mine, '沒有 stashed 的卡')
  const lb = await json(await call(seller2, '/v1/listings', { prizeId: mine.id, price: 800 }))
  ck('素材：上架成功', !!lb.listing, JSON.stringify(lb).slice(0, 200))
  const buy = await call(buyer2, '/v1/orders',
    { listingId: lb.listing.id, idempotencyKey: `pub-order-v-${RUN}` })
  const bb = await json(buy.clone())
  ck('買家買得到', buy.ok, `${buy.status} ${JSON.stringify(bb).slice(0, 200)}`)

  const gone = await prizeOf(seller2, (x: Any) => x.id === mine.id)
  ck('卡不在原賣家名下了', !gone, `還在：${gone?.status}`)
  const got = await prizeOf(buyer2, (x: Any) => x.id === mine.id)
  ck('卡在買家名下、狀態 stashed（不是被還原成賣家上架前的樣子）',
    got?.status === 'stashed', `status=${got?.status}`)
  const dr = await call(seller2, `/v1/listings/${lb.listing.id}/delist`, {})
  ck('已成交的掛單不能下架（409，不會觸發還原）', dr.status === 409, `status=${dr.status}`)
}

head('A-5：需寄送成交後，託管期間的卡維持 listed（不能被還原放出來）')
{
  const cert = `STUB-A5-SHIP-${RUN}`
  const card = await makeInBookCard(cert)
  ck('素材：卡是 in_book', card?.status === 'in_book', `status=${card?.status}`)
  const lb = await json(await call(seller, '/v1/listings', { prizeId: card.id, price: 900 }))
  ck('素材：上架成功', !!lb.listing, JSON.stringify(lb).slice(0, 200))
  const buyer = await login('a5shipbuyer', 'A-5 寄送買家')
  await call(platform, '/v1/admin/grant', { userId: 'u-a5shipbuyer', points: 200_000, note: 'public 測試' })
  const buy = await call(buyer, '/v1/orders',
    { listingId: lb.listing.id, idempotencyKey: `pub-order-s-${RUN}` })
  ck('建立託管訂單', buy.ok, `${buy.status} ${(await buy.clone().text()).slice(0, 200)}`)
  const still = await prizeOf(seller, (x: Any) => x.id === card.id)
  ck('託管期間卡停在 listed（那是鎖，不是待還原的狀態）',
    still?.status === 'listed', `status=${still?.status}`)
}

/* ══════════════ L-1：畸形掛單價 ═══════════════════════════════════ */

head('L-1：十種畸形掛單價全部 400、訊息中文可讀，不能有 500')
{
  const cert = `STUB-L1-349-${RUN}`
  const card = await makeInBookCard(cert)
  ck('素材：有一張可上架的卡', !!card, '素材沒造出來')
  const BAD: [string, unknown][] = [
    ['-1', -1], ['0', 0], ['1.5', 1.5], ['1e308', 1e308], ['1e999', Number('1e999')],
    ['abc', 'abc'], ['null', null], ['9007199254740992', 9007199254740992],
    ['上界+1', 1_000_000_001], ['9.9e18', 9.9e18]
  ]
  for (const [label, price] of BAD) {
    const r = await call(seller, '/v1/listings', { prizeId: card.id, price })
    const body = await json(r.clone()).catch(() => ({}))
    const msg = String(body?.message ?? '')
    const cjk = /[一-鿿]/.test(msg)
    ck(`price=${label} → 400 且中文訊息`, r.status === 400 && cjk, `status=${r.status} msg=${msg}`)
    if (r.status === 500) ck(`price=${label} 不能是 500`, false, '出現 500')
    console.log(`       ${label} → ${r.status} ${msg}`)
  }
  /* 反向：合法的價格照樣過得去（上界本身是可以用的，不是差一位的 off-by-one） */
  const okR = await call(seller, '/v1/listings', { prizeId: card.id, price: 1_000_000_000 })
  ck('上界本身（十億）可以上架', okR.ok, `${okR.status} ${(await okR.clone().text()).slice(0, 160)}`)
  if (okR.ok) await call(seller, `/v1/listings/${(await json(okR)).listing.id}/delist`, {})
}

/* ══════════════ L-2 / A-6：公開回應掃 certNo ══════════════════════ */

/** 整包遞迴找鍵名 certNo，或任何一個值裡出現指定字串 */
function scan(v: unknown, needle: string, path = '$'): string[] {
  const hits: string[] = []
  if (v === null || v === undefined) return hits
  if (typeof v === 'string') { if (v.includes(needle)) hits.push(`${path} = ${v}`); return hits }
  if (Array.isArray(v)) { v.forEach((x, i) => hits.push(...scan(x, needle, `${path}[${i}]`))); return hits }
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'certNo' && x !== null) hits.push(`${path}.certNo = ${String(x)}`)
      hits.push(...scan(x, needle, `${path}.${k}`))
    }
  }
  return hits
}

head('L-2 / A-6：沒登入抓得到的每一條回應都不能有 certNo')
{
  /* 造一張帶編號的卡掛到市場上，確保「市場上真的有一張已鑑定的卡」——
     沒有這一步，掃不到 certNo 可能只是因為市場上剛好沒有這種卡。 */
  const cert = `STUB-L2-349-${RUN}`
  const card = await makeInBookCard(cert)
  const lb = await json(await call(seller, '/v1/listings', { prizeId: card.id, price: 12345 }))
  ck('素材：一張帶編號的卡掛上市場', !!lb.listing, JSON.stringify(lb).slice(0, 200))
  ck('★ 賣家自己拿到的上架回應也走白名單', !('certNo' in (lb.listing?.card ?? {})),
    JSON.stringify(lb.listing?.card ?? {}).slice(0, 200))

  /* 順便造一個帶編號的公開池（A-6 的展示那一半） */
  const poolCert = `STUB-A6-349-${RUN}`
  const pr = await makePool('A-6 展示池', poolCert)
  const a6Pool = (await json(pr)).poolId as string
  ck('素材：帶編號的池建起來了', pr.ok, `${pr.status}`)

  const seedCert = '82345671'   // 種子資料裡真的存在的一個編號
  const paths = [
    '/v1/listings',
    '/v1/listings?grader=psa&minGrade=10',
    '/v1/listings?grader=graded&sort=pricey',
    '/v1/listings?q=噴火龍',
    '/v1/listings?minPrice=1&maxPrice=1000000000',
    '/v1/listings/highlights',
    `/v1/listings/${lb.listing.id}`,
    '/v1/pools',
    `/v1/pools/${a6Pool}`,
    '/v1/sellers',
    '/v1/sellers/u-seller',
    '/v1/winners'
  ]
  for (const p of paths) {
    const r = await fetch(`${base}${p}`)
    const txt = await r.text()
    let body: unknown = null
    try { body = JSON.parse(txt) } catch { /* 非 JSON 就用原文比對 */ }
    const hits = body ? [...scan(body, cert), ...scan(body, seedCert)] : []
    const raw = txt.includes('certNo') || txt.includes(cert) || txt.includes(seedCert)
    ck(`${p} 沒有 certNo（狀態 ${r.status}）`, r.status < 500 && hits.length === 0 && !raw,
      hits.slice(0, 3).join(' | ') || (raw ? '原文裡出現了 certNo/編號字串' : `status=${r.status}`))
  }

  /* 那個「已鑑定」貨架是用 cert_no is not null 篩出來的 —— 篩選條件本身
     不洩漏（值沒出去），但要確認它回的資料沒有繞過白名單，而且真的有東西
     （空清單會讓上面那一輪掃描變成沒掃到任何東西的假通過）。 */
  const hl = await json(await fetch(`${base}/v1/listings/highlights`))
  ck('已鑑定貨架真的有資料（不是空清單造成的假通過）',
    Array.isArray(hl.graded) && hl.graded.length > 0, `graded=${JSON.stringify(hl.graded).slice(0, 120)}`)
  ck('已鑑定貨架的每一筆都有卡名（白名單留下了展示欄位）',
    (hl.graded ?? []).every((l: Any) => typeof l.card?.name === 'string'),
    JSON.stringify(hl.graded?.[0]?.card ?? {}).slice(0, 200))
  ck('grader/grade 篩選回來的資料仍然帶得出等級（篩選線沒被弄壞）',
    await (async () => {
      const r = await json(await fetch(`${base}/v1/listings?grader=psa&minGrade=10&limit=5`))
      return (r.items ?? []).length > 0 && (r.items ?? []).every((l: Any) => l.card?.grader === 'PSA')
    })(), '')
}

head('A-6 反向：revealed 的 manifest 仍然有 certNo，而且驗算過得了')
{
  const { verifyReveal } = await import('./shared/fairness.js')
  /* 這一段是 A-6 的另一半。展示那半是「certNo 不能出去」，這一半是
     「certNo 必須留在 manifest 裡而且雜湊算得回來」—— 只驗前半會讓人
     把 manifest 一起遮掉，那會讓**現有每一個池的驗算全部失敗**。 */
  const pools = (await json(await fetch(`${base}/v1/pools`))).pools ?? []
  let checked = 0, withCert = 0
  for (const p of pools) {
    if (p.status !== 'revealed') continue
    const rv = await json(await fetch(`${base}/v1/pools/${p.id}/reveal`))
    if (!rv.manifest) continue
    if ((rv.manifest as Any[]).some(m => m.certNo)) withCert++
    /* 從沒開賣過就到期的池（這支自己造的那幾個素材池就是）也會走到 revealed，
       但它們沒有籤序可以公布 —— publishedSequence 是空的，
       verifyReveal 會誠實地說「籤數不符：宣告 4，公布 0」。
       那是那種池本來的樣子，不是這一輪改動造成的迴歸，所以不拿它當驗算樣本；
       它們的 manifest 仍然算進上面的 certNo 檢查（那才是這一段要保護的東西）。 */
    if (!(rv.publishedSequence ?? []).length) continue
    /* 用前端同一支 shared/fairness.ts 驗 —— 它會拿 serverSeed ＋ manifest
       重算 commit 再跟開賣前公布的對。這一行才是「沒弄壞驗算」的證明：
       欄位還在但序列化變了、算出別的雜湊，一樣是壞的。 */
    const v = await verifyReveal({
      serverSeed: rv.serverSeed, commitHash: rv.commitHash, clientSeed: rv.clientSeed,
      manifest: rv.manifest, manifestVersion: Number(rv.manifestVersion) as 2 | 3 | 4,
      prizes: rv.prizes, publishedSequence: rv.publishedSequence
    })
    ck(`池 ${p.id} 的驗算通過（v${v.version}）`, v.ok, JSON.stringify(v).slice(0, 200))
    checked++
  }
  ck('驗到了 revealed 的池（不是零筆的假通過）', checked > 0, '沒有 revealed 且帶 manifest 的池')
  /* 這一輪自己開的池都帶鑑定編號，所以「一個帶 certNo 的 manifest 都沒有」
     只可能是被遮掉了。種子裡的 RAW 池 certNo 本來就是 null，不能只看第一個。 */
  ck('★ 至少一個池的 manifest 裡真的有 certNo（公平性證據沒被遮掉）', withCert > 0,
    `檢查了 ${checked} 個 revealed 的池，沒有一個 manifest 帶編號`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

export {}
