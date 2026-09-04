/**
 * 訓練家卡資格判斷的迴歸測試（routes/trainer-card.ts）。
 *
 *   npx tsx src/regress-trainer-card.ts http://localhost:8060
 *
 * 伺服器要 DEV_LOGIN=1 與 DEV_LOGIN_SECRET；這支也會直接連 DATABASE_URL
 * （理由見下面「為什麼有幾處直接寫 DB」）。
 *
 * ⚠️ **要有自己的乾淨資料庫，不能跟 smoke 或其他迴歸共用。**
 * 理由同 regress-upload：這支會消耗 u-seller 的額度、開池、抽掉整池籤，
 * 別支接在後面跑會倒在「池已沒籤」這類污染上。各自 migrate + seed 一個新庫。
 *
 * ── 這支在驗什麼 ──────────────────────────────────────────────────
 * 拍板的規則是「登入 ＋ 自己親手登記過至少一張卡」。所以核心是三種人
 * 各驗一次，而且**三個人都是用真的流程造出來的**，不是塞資料塞出來的：
 *   (a) 只有抽中的卡（真的開池、真的抽完整池）      → 不符合資格
 *   (b) 只有市場買來的卡（真的下單、出貨、確認收貨）→ 不符合資格
 *   (c) 自己登記過一張（真的走 /v1/cardbook/upload）→ 符合資格
 * (b) 特別重要：託管訂單完成時 custodian_id 會一起改成買家，光看
 * origin + custodian 分不出它跟自己登記的卡有什麼不同 —— 擋住它的是
 * 端點裡那條 orders 的 not exists。這條測試就是那句話的證據。
 *
 * 另外驗：狀態變化不影響資格、cards 的 source 契約、沒登入是 401。
 *
 * ── 為什麼有幾處直接寫 DB ─────────────────────────────────────────
 * 兩處，都標了註解：
 *   1 自拍正面照那一筆 —— 走 API 要 R2（presign + PUT），本機常見沒設，
 *     整條會回 503。這一列照 cardbook.ts 的寫法插進去，只為了驗
 *     **回傳契約分得出 catalog 與 photo**，不是為了繞過登記邏輯。
 *   2 status 的擾動（in_pool / shipped）—— 要驗的命題就是「status 不影響
 *     資格」，直接把狀態改成各種值正是最直接的驗法。上架／下架那兩個
 *     狀態仍然走真的端點。
 */
import { sql } from './db.js'

const base = (process.argv[2] ?? 'http://localhost:8060').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
const devHeaders = () => {
  if (!devSecret) throw new Error('regress-trainer-card 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')
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

/** 這支測試唯一在問的東西 */
const eligibility = async (t: string) => json(await call(t, '/v1/trainer-card/eligibility'))
const bookOf = async (t: string) => (await json(await call(t, '/v1/prizes?limit=100'))).items ?? []

const RUN = String(Date.now()).slice(-8)
const platform = await login('platform', 'VaultDraw 官方')
/* 用種子賣家：他已經完成過池，不會撞到「第一個池額度上限」那道閘（同 regress-upload）。 */
const seller = await login('seller', '測試賣家')
await call(platform, '/v1/admin/grant', { userId: 'u-seller', points: 5_000_000, note: 'trainer-card 測試' })

/* 目錄卡（有 artId）：登記進來的卡沒有實拍圖，卡圖從 artId 推導。 */
const catalogCard = (tag: string, certNo: string | null) => ({
  name: `噴火龍 ex SAR ${tag}`, setCode: 'sv4a', cardNo: '349/190',
  artId: 'SV4a-349', language: 'JP',
  grader: certNo ? 'PSA' : null, grade: certNo ? 10 : null, certNo, refPrice: 26000
})

head('沒登入 → 401（不是 500）')
{
  const r = await fetch(`${base}/v1/trainer-card/eligibility`)
  ck('沒帶 token 回 401', r.status === 401, `status=${r.status}`)
  const b = await json(r.clone())
  ck('而且是 UNAUTHORIZED，不是伺服器爆掉', b.error === 'UNAUTHORIZED', JSON.stringify(b).slice(0, 160))

  const bad = await fetch(`${base}/v1/trainer-card/eligibility`, { headers: { authorization: 'Bearer not-a-real-token' } })
  ck('壞掉的 token 也是 401', bad.status === 401, `status=${bad.status}`)
}

head('(c) 自己登記過一張 → 符合資格')
const regist = await login('tcregist', '自己登記的人')
/* 下面上架那一段要押 50 點保證金（需寄送的掛單），先給他點數 */
await call(platform, '/v1/admin/grant', { userId: 'u-tcregist', points: 10_000, note: 'trainer-card 測試' })
let registeredId = ''
{
  const before = await eligibility(regist)
  ck('還沒登記之前不符合資格', before.eligible === false, JSON.stringify(before).slice(0, 160))
  ck('而且說得出原因 NO_REGISTERED_CARD', before.reason === 'NO_REGISTERED_CARD', String(before.reason))
  ck('cards 是空陣列，不是 undefined', Array.isArray(before.cards) && before.cards.length === 0,
    JSON.stringify(before.cards))

  const up = await call(regist, '/v1/cardbook/upload', { card: catalogCard('C', `STUB-TC-C-${RUN}`) })
  const ub = await json(up.clone())
  ck('登記成功', up.ok, `${up.status} ${JSON.stringify(ub).slice(0, 160)}`)
  registeredId = String(ub.prize?.id ?? '')

  const after = await eligibility(regist)
  ck('登記完就符合資格', after.eligible === true, JSON.stringify(after).slice(0, 200))
  ck('符合資格時沒有 reason', after.reason === undefined, String(after.reason))
  ck('cards 就是剛登記的那一張', after.cards?.length === 1 && after.cards[0].id === registeredId,
    JSON.stringify(after.cards).slice(0, 200))
}

head('cards 的契約：前端分得出目錄卡與自己拍的照片')
{
  const r = await eligibility(regist)
  const cat = r.cards.find((x: Any) => x.id === registeredId)
  ck('目錄卡的 source 是 catalog', cat?.source === 'catalog', `source=${cat?.source}`)
  ck('目錄卡帶得出 artId（前端拿它去 TCGdex 取圖）', cat?.artId === 'SV4a-349', `artId=${cat?.artId}`)
  ck('目錄卡沒有自拍照（imageUrl 是 null，不是空字串）', cat?.imageUrl === null, JSON.stringify(cat?.imageUrl))
  ck('帶得出卡名（貼圖要用）', typeof cat?.name === 'string' && cat.name.length > 0, String(cat?.name))

  /* 自拍正面照那一筆。走 API 要 R2（presign + PUT），本機常見沒設 ——
     這一列照 routes/cardbook.ts 的寫法直接插進去，欄位一模一樣
     （origin='upload'、custodian=自己、card.image='/v1/files/…'、artId 沒有）。
     驗的是回傳契約分得出兩種圖，不是繞過登記邏輯。 */
  const now = Date.now()
  const photoId = `pz-up-tcphoto${RUN}`
  await sql`
    insert into prizes (id, user_id, pool_id, card, tier, status,
                        won_at, acquired_at, stash_expires_at,
                        grader, cert_no, custodian_id, origin)
    values (${photoId}, 'u-tcregist', null, ${sql.json({
      name: '手拍的自建卡', setCode: 'sv0z', cardNo: `P${RUN}`,
      artId: null, image: '/v1/files/f-000000000001', language: 'JP',
      grader: null, grade: null, certNo: null, refPrice: null, variantId: null
    })}, null, 'in_book',
            ${now}, ${now}, ${now + 90 * 86_400_000}, null, null, 'u-tcregist', 'upload')
  `
  const r2 = await eligibility(regist)
  const photo = r2.cards.find((x: Any) => x.id === photoId)
  ck('自拍照那一筆也回得出來', !!photo, `cards=${JSON.stringify(r2.cards.map((x: Any) => x.id))}`)
  ck('自拍照的 source 是 photo（前端要跑透視校正）', photo?.source === 'photo', `source=${photo?.source}`)
  ck('自拍照帶得出 imageUrl', photo?.imageUrl === '/v1/files/f-000000000001', String(photo?.imageUrl))
  ck('自拍照沒有 artId', photo?.artId === null, JSON.stringify(photo?.artId))
  ck('兩種來源在同一份回應裡分得開',
    new Set(r2.cards.map((x: Any) => x.source)).size === 2,
    JSON.stringify(r2.cards.map((x: Any) => [x.id, x.source])))
}

head('狀態變化不影響資格（上架、下架、押進池、寄出）')
{
  /* 上架與下架走真的端點：那是使用者真的會做的兩步，而 A-5／032／034
     那一串 bug 全部發生在這條路上。 */
  const lr = await call(regist, '/v1/listings', { prizeId: registeredId, price: 500 })
  const lb = await json(lr.clone())
  ck('登記的卡上架成功', lr.ok, `${lr.status} ${JSON.stringify(lb).slice(0, 160)}`)
  const listingId = String(lb.listing?.id ?? '')

  const onSale = await eligibility(regist)
  ck('上架中（listed）仍然符合資格', onSale.eligible === true, JSON.stringify(onSale).slice(0, 160))
  ck('而且那張卡還在 cards 裡', onSale.cards.some((x: Any) => x.id === registeredId),
    JSON.stringify(onSale.cards.map((x: Any) => [x.id, x.status])))

  const dr = await call(regist, `/v1/listings/${listingId}/delist`, {})
  ck('下架成功', dr.ok, `${dr.status} ${(await dr.clone().text()).slice(0, 160)}`)
  const off = await eligibility(regist)
  ck('下架之後仍然符合資格（登記過是不會被收回的事實）', off.eligible === true,
    JSON.stringify(off).slice(0, 160))

  /* 其餘狀態直接改 status：要驗的命題就是「status 不影響資格」，
     把狀態換成各種值正是最直接的驗法。
     in_pool 要一起給 pool_id —— 036 的 prizes_in_pool_has_pool 約束就是
     「押在池裡的卡一定說得出是哪個池」，繞過它就不是真的 in_pool 了。 */
  const [anyPool] = await sql<{ id: string }[]>`select id from pools limit 1`
  for (const st of ['in_pool', 'shipped', 'recycled']) {
    const poolId = st === 'in_pool' ? anyPool!.id : null
    await sql`update prizes set status = ${st}, pool_id = ${poolId} where id = ${registeredId}`
    const e = await eligibility(regist)
    ck(`status = ${st} 仍然符合資格`, e.eligible === true, JSON.stringify(e).slice(0, 120))
    ck(`status = ${st} 時那張卡照樣回得出來`, e.cards.some((x: Any) => x.id === registeredId),
      JSON.stringify(e.cards.map((x: Any) => [x.id, x.status])))
  }
  await sql`update prizes set status = 'in_book', pool_id = null where id = ${registeredId}`
}

head('(b) 只有市場買來的卡 → 不符合資格')
{
  /* 完整走一次需寄送的市場交易：賣家登記一張卡、上架、買家下單、
     賣家出貨、買家確認收貨。訂單完成時 releasePrize() 會把 user_id 與
     custodian_id **一起**改成買家 —— 那一列從此看起來就跟買家自己登記的
     一模一樣，這正是這一段要擋住的東西。 */
  const buyer = await login('tcbuyer', '市場買家')
  await call(platform, '/v1/admin/grant', { userId: 'u-tcbuyer', points: 100_000, note: 'trainer-card 測試' })

  const before = await eligibility(buyer)
  ck('買之前不符合資格', before.eligible === false, JSON.stringify(before).slice(0, 160))

  const up = await json(await call(seller, '/v1/cardbook/upload', { card: catalogCard('B', `STUB-TC-B-${RUN}`) }))
  const soldId = String(up.prize?.id ?? '')
  ck('賣家登記了一張卡', soldId.length > 0, JSON.stringify(up).slice(0, 160))

  const sellerBefore = await eligibility(seller)
  ck('賣家登記完之後是符合資格的（賣掉之前先量一次）', sellerBefore.eligible === true,
    JSON.stringify(sellerBefore).slice(0, 160))

  const lb = await json(await call(seller, '/v1/listings', { prizeId: soldId, price: 500 }))
  ck('上架成功且是需寄送（實體在賣家手上）', lb.listing?.delivery === 'ship',
    JSON.stringify(lb).slice(0, 200))

  const ob = await json(await call(buyer, '/v1/orders',
    { listingId: lb.listing.id, idempotencyKey: `tc-buy-${RUN}` }))
  ck('買家下單成功', !!ob.order?.id, JSON.stringify(ob).slice(0, 200))

  const shipRes = await call(seller, `/v1/orders/${ob.order.id}/ship`, { photoFileIds: [] })
  ck('賣家出貨', shipRes.ok, `${shipRes.status} ${(await shipRes.clone().text()).slice(0, 160)}`)
  const confRes = await call(buyer, `/v1/orders/${ob.order.id}/confirm`, {})
  ck('買家確認收貨（訂單 completed）', confRes.ok, `${confRes.status} ${(await confRes.clone().text()).slice(0, 160)}`)

  /* 先確認這一列真的長成「難分辨」的樣子 —— 不然下面那條就算過了也證明不了什麼。 */
  const got = (await bookOf(buyer)).find((x: Any) => x.id === soldId)
  ck('卡真的過到買家名下', !!got, `找不到 ${soldId}`)
  ck('而且 origin 還是 upload（不是抽來的）', got?.origin === 'upload', `origin=${got?.origin}`)
  ck('custodian 也一起變成買家 —— 光看欄位跟自己登記的一模一樣',
    got?.custodian_id === 'u-tcbuyer', `custodian_id=${got?.custodian_id}`)

  const after = await eligibility(buyer)
  ck('買來的卡不算資格（擋住它的是 orders 那條紀錄）', after.eligible === false,
    JSON.stringify(after).slice(0, 200))
  ck('原因仍然是 NO_REGISTERED_CARD', after.reason === 'NO_REGISTERED_CARD', String(after.reason))
  ck('cards 是空的', after.cards?.length === 0, JSON.stringify(after.cards).slice(0, 200))

  /* 反向那半，也是目前這個判準最大的**已知限制**：卡賣掉之後那一列
     不在賣家名下了，於是「他登記過一張卡」這件已經發生的事在資料上消失，
     他的資格跟著沒了。要修這一條就要一個不可變的 registered_by
     （見 routes/trainer-card.ts 檔頭）—— 那是新欄位，要先確認，不自己開。
     這裡把現況原樣釘住，之後真的加了欄位這條會紅，那正是它該做的事。 */
  const sellerNow = await eligibility(seller)
  ck('賣掉的那一張不在他的 cards 裡了', !sellerNow.cards.some((x: Any) => x.id === soldId),
    JSON.stringify(sellerNow.cards.map((x: Any) => x.id)))
  ck('已知限制：把唯一一張登記卡賣掉之後，賣家的資格也跟著沒了',
    sellerNow.eligible === false, JSON.stringify(sellerNow).slice(0, 160))
}

head('(a) 只有抽中的卡 → 不符合資格')
{
  const drawer = await login('tcdrawer', '只抽卡的人')
  await call(platform, '/v1/admin/grant', { userId: 'u-tcdrawer', points: 100_000, note: 'trainer-card 測試' })
  const before = await eligibility(drawer)
  ck('抽之前不符合資格', before.eligible === false, JSON.stringify(before).slice(0, 160))

  /* 4 籤的池，四張卡全部先進賣家的卡冊再挑（A-4 之後建池只能從卡冊挑）。 */
  const bookCard = async (card: Record<string, unknown>) => {
    const b = await json(await call(seller, '/v1/cardbook/upload', { card }))
    if (b.prize?.id) return String(b.prize.id)
    if (b.prizeId) return String(b.prizeId)
    throw new Error('登記卡片失敗：' + JSON.stringify(b).slice(0, 200))
  }
  const plain = (n: number) => ({
    name: `太樂巴戈斯 ex UR ${RUN}-${n}`, setCode: 'sv8a', cardNo: '237/187',
    artId: 'SV8a-237', language: 'JP', grader: null, grade: null, certNo: null, refPrice: 900
  })
  const certNo = `STUB-TC-A-${RUN}`
  const aId = await bookCard(catalogCard('A', certNo))
  const dIds = [await bookCard(plain(1)), await bookCard(plain(2)), await bookCard(plain(3))]
  /* 建池的 card 要帶 id（PrizeIn.card 的必填欄位）；卡冊登記那支沒有這一欄。 */
  const pr = await call(seller, '/v1/pools', {
    mode: 'muteki', title: `訓練家卡測試池 ${RUN}`, ticketPrice: 2000, totalTickets: 4, days: 7,
    prizes: [
      { tier: 'A', prizeId: aId, card: { id: 'c-SV4a-349', ...catalogCard('A', certNo) }, total: 1 },
      ...dIds.map((id, i) => ({ tier: 'D' as const, prizeId: id, card: { id: 'c-SV8a-237', ...plain(i + 1) }, total: 1 }))
    ],
    tierBuyback: { A: 3000, D: 200 }
  })
  const pb = await json(pr.clone())
  ck('開池成功', pr.ok, `${pr.status} ${JSON.stringify(pb).slice(0, 200)}`)
  const poolId = String(pb.poolId ?? '')

  /* 建池只到 committed，開賣要等 drand 的未來輪次（約兩分鐘），
     測試裡自己推（同 regress-upload；上限五分鐘，等不到是常態不是故障）。 */
  for (let i = 0; i < 150; i++) {
    const o = await json(await call(drawer, `/v1/pools/${poolId}/open`, {}))
    if (o.opened) break
    await new Promise(r => setTimeout(r, 2000))
  }
  const { pool } = await json(await call(drawer, `/v1/pools/${poolId}`))
  ck('池已開賣', pool?.status === 'open', `status=${pool?.status}`)
  const taken = new Set<number>(pool?.takenSeats ?? [])
  const seats: number[] = []
  for (let i = 1; i <= (pool?.totalTickets ?? 0); i++) if (!taken.has(i)) seats.push(i)
  const dr = await call(drawer, `/v1/pools/${poolId}/draw`, { seats, idempotencyKey: `tc-draw-${RUN}` })
  ck('抽完整池', dr.ok, `${dr.status} ${(await dr.clone().text()).slice(0, 200)}`)

  const book = await bookOf(drawer)
  ck('抽到的卡真的進了他的卡冊', book.length >= 4, `${book.length} 張`)
  ck('每一張的 origin 都是 draw（抽卡會把來源改寫成 draw）',
    book.every((x: Any) => x.origin === 'draw'), JSON.stringify(book.map((x: Any) => x.origin)))
  ck('每一張的 custodian 都還是賣家（實體從沒到過他手上）',
    book.every((x: Any) => x.custodian_id === 'u-seller'),
    JSON.stringify(book.map((x: Any) => x.custodian_id)))

  const after = await eligibility(drawer)
  ck('抽中一整池仍然不符合資格', after.eligible === false, JSON.stringify(after).slice(0, 200))
  ck('原因是 NO_REGISTERED_CARD', after.reason === 'NO_REGISTERED_CARD', String(after.reason))
  ck('cards 是空的', after.cards?.length === 0, JSON.stringify(after.cards).slice(0, 200))
}

console.log(`\n${pass} passed / ${fail} failed`)
await sql.end({ timeout: 3 })
process.exit(fail ? 1 : 0)
