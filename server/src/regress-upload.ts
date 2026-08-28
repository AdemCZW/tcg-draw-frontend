/**
 * 卡片上傳入庫的迴歸測試（routes/cardbook.ts + migration 027）。
 *
 * 驗的是卡冊優先的最後一塊：賣家把手上的實體卡登記進卡冊，
 * 而且**登記進來的卡走得完整條路** —— 進池（重用同一列、賞別被寫上）、
 * 被抽走、過戶給買家；或直接上架市場（需寄送）。
 * 半條路的入口比沒有入口更糟：卡進得來出不去，就是 audit-3 A-3 那種死路。
 *
 *   npx tsx src/regress-upload.ts http://localhost:8060
 *
 * 伺服器要 DEV_LOGIN=1、PSA_STUB=1。
 *
 * ⚠️ **要有自己的乾淨資料庫，不能跟 smoke 共用一個。**
 * 理由同 regress-pledge：兩邊都會消耗種子資料而且互相干擾
 * （smoke 會把 u-seller 的違約累積到停權門檻；這支會開池、抽卡，
 * 改掉 smoke 預期的種子狀態）。各自 migrate + seed 一個新庫再跑。
 *
 * ⚠️ 每一支迴歸都要**各自一個乾淨庫**，不只是躲開 smoke ——
 * 這支會消耗 u-seller 的種子池、登記 STUB 編號、抽卡改籤位，
 * regress-pledge 接在後面跑會倒在「池已沒籤」「編號已佔用」這類
 * 污染上（實測 6 條假失敗）。反過來也一樣。
 */
const base = (process.argv[2] ?? 'http://localhost:8060').replace(/\/$/, '')
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
    method: 'POST', headers: { 'content-type': 'application/json' },
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
/* 用已經完成過池的種子賣家，避開「第一個池額度上限」那道閘（同 regress-pledge）。 */
const seller = await login('seller', '測試賣家')
await call(platform, '/v1/admin/grant', { userId: 'u-seller', points: 5_000_000, note: 'upload 測試' })

/* 帶時間戳讓這支可以重複跑：編號一旦登記過就永遠佔著（那正是防線本身），
   固定編號第二次跑就會被自己上一輪擋住。
   stub 的卡號取 split('-')[2]，所以 'STUB-OK-777-<ts>' 回的 CardNumber 是 '777' ——
   上傳的卡號直接填 '777' 讓 cardNumbersAgree 對得上，不用 certConfirmed。 */
const RUN = String(Date.now()).slice(-8)
const upCard = (certNo: string | null, cardNo = '777') => ({
  name: '噴火龍 ex SAR', setCode: 'sv4a', cardNo,
  artId: 'SV4a-777', language: 'JP',
  grader: certNo ? 'PSA' : null, grade: certNo ? 10 : null,
  certNo, refPrice: 26000
})

/* 建池用的卡（重用押記那條路要靠 grader+cert_no 對上；卡號帶系列尾碼，
   跟 stub 回的 '349' 對不上，所以要 certConfirmed —— 同 regress-pledge）。 */
const certCard = (certNo: string) => ({
  id: 'c-SV4a-349', name: '噴火龍 ex SAR', artId: 'SV4a-349', cardNo: '349/190',
  setCode: 'sv4a', language: 'JP', grader: 'PSA', grade: 10, certNo, refPrice: 26000
})
const plainCard = {
  id: 'c-SV8a-237', name: '太樂巴戈斯 ex UR', artId: 'SV8a-237', cardNo: '237/187',
  setCode: 'sv8a', language: 'JP', grader: 'RAW', grade: null, certNo: null, refPrice: 900
}
const makePool = (title: string, certNo: string) => call(seller, '/v1/pools', {
  mode: 'muteki', title, ticketPrice: 2000, totalTickets: 4, days: 7,
  prizes: [
    { tier: 'A', card: certCard(certNo), total: 1, certConfirmed: true },
    { tier: 'D', card: plainCard, total: 3 }
  ],
  tierBuyback: { A: 3000, D: 200 }
})

const bookOf = async (t: string) => (await json(await call(t, '/v1/prizes?limit=100'))).items ?? []

head('上傳含編號的卡 → in_book、tier null、custodian 是自己')
const CERT = `STUB-OK-777-${RUN}`
{
  const r = await call(seller, '/v1/cardbook/upload', { card: upCard(CERT) })
  const b = await json(r.clone())
  ck('上傳成功', r.ok, `${r.status} ${JSON.stringify(b).slice(0, 200)}`)
  ck('回應帶新列的 id', typeof b.prize?.id === 'string' && b.prize.id.length > 0, JSON.stringify(b.prize).slice(0, 120))
  ck('回應帶 psaStatus=verified（STUB-OK）', b.prize?.psaStatus === 'verified', `psaStatus=${b.prize?.psaStatus}`)

  const mine = (await bookOf(seller)).find((x: Any) => x.card?.certNo === CERT)
  ck('卡冊裡出現那張卡', !!mine, `找不到 certNo=${CERT}`)
  ck('狀態是 in_book', mine?.status === 'in_book', `status=${mine?.status}`)
  ck('tier 是 null（還沒進過池，賞別還沒發生）', mine?.tier === null, `tier=${JSON.stringify(mine?.tier)}`)
  ck('custodian 是自己（卡在我手上）', mine?.custodian_id === 'u-seller', `custodian_id=${mine?.custodian_id}`)
  ck('origin 是 upload', mine?.origin === 'upload', `origin=${mine?.origin}`)

  const sum = await call(seller, '/v1/prizes/summary')
  const sj = await json(sum.clone())
  ck('summary 沒被 tier null 弄炸', sum.ok, `${sum.status}`)
  ck('賞別分佈不含 null 的格子', !(sj.tierMix ?? []).some((t: Any) => t.tier == null),
    JSON.stringify(sj.tierMix))
}

head('同編號再傳 → 409，「自己的」與「別人的」訊息要分開')
{
  const r = await call(seller, '/v1/cardbook/upload', { card: upCard(CERT) })
  const b = await json(r.clone())
  ck('自己再傳被擋', r.status === 409, `${r.status}`)
  ck('講清楚已經在自己卡冊裡', b.error === 'ALREADY_IN_BOOK' && String(b.message).includes('你的卡冊'),
    JSON.stringify(b).slice(0, 200))

  const other = await login('uploader2', '第二個人')
  const r2 = await call(other, '/v1/cardbook/upload', { card: upCard(CERT) })
  const b2 = await json(r2.clone())
  ck('別人再傳也被擋', r2.status === 409, `${r2.status}`)
  ck('引導他去申請接管', b2.error === 'CERT_ALREADY_LISTED' && String(b2.message).includes('接管'),
    JSON.stringify(b2).slice(0, 200))
}

head('裸卡照收（登記進自己的卡冊沒有欺騙任何人）')
{
  const r = await call(seller, '/v1/cardbook/upload', { card: upCard(null) })
  const b = await json(r.clone())
  ck('裸卡上傳成功', r.ok, `${r.status} ${JSON.stringify(b).slice(0, 160)}`)
  ck('狀態是 in_book', b.prize?.status === 'in_book', `status=${b.prize?.status}`)
  ck('沒有 psaStatus（沒東西可驗）', b.prize?.psaStatus === null, `psaStatus=${b.prize?.psaStatus}`)
}

head('假編號（stub 查無此卡）→ 400 講清楚')
{
  /* 純數字、沒有 STUB-OK 前綴 → stubExchange 的安全預設是 No data found */
  const r = await call(seller, '/v1/cardbook/upload', { card: upCard(`99${RUN}`, '777') })
  const b = await json(r.clone())
  ck('被擋成 400', r.status === 400, `${r.status}`)
  ck('錯誤是 CERT_NOT_FOUND', b.error === 'CERT_NOT_FOUND', JSON.stringify(b).slice(0, 160))
}

head('整條路：上傳 → 開池重用同一列（tier 被寫上）→ 抽走 → 過戶')
{
  const CERT2 = `STUB-OK-349-${RUN}`
  const up = await call(seller, '/v1/cardbook/upload', { card: upCard(CERT2, '349') })
  const upB = await json(up.clone())
  ck('上傳成功', up.ok, `${up.status} ${JSON.stringify(upB).slice(0, 160)}`)
  const uploadedId = upB.prize?.id as string

  const pr = await makePool('upload 測試池（重用上傳的卡）', CERT2)
  const pb = await json(pr.clone())
  ck('用同編號開池成功（上傳的卡不擋自己）', pr.ok, `${pr.status} ${JSON.stringify(pb).slice(0, 200)}`)
  const poolId = pb.poolId as string

  const pledged = (await bookOf(seller)).find((x: Any) => x.card?.certNo === CERT2)
  ck('是同一列（重用，不是開新列）', pledged?.id === uploadedId, `${uploadedId} vs ${pledged?.id}`)
  ck('狀態進 in_pool', pledged?.status === 'in_pool', `status=${pledged?.status}`)
  ck('tier 被池寫上（A）', pledged?.tier === 'A', `tier=${JSON.stringify(pledged?.tier)}`)

  const buyer = await login('upbuyer', '上傳測試買家')
  await call(platform, '/v1/admin/grant', { userId: 'u-upbuyer', points: 100_000, note: 'upload 測試' })
  /* 建池只到 committed —— 開賣要等 drand 的未來輪次（FUTURE_ROUNDS=4，
     約兩分鐘後），測試裡自己推（同 regress-pledge，但上限放到五分鐘：
     40 秒等不到那個 round 是常態，不是故障）。 */
  for (let i = 0; i < 150; i++) {
    const o = await json(await call(buyer, `/v1/pools/${poolId}/open`, {}))
    if (o.opened) break
    await new Promise(r => setTimeout(r, 2000))
  }
  const { pool } = await json(await call(buyer, `/v1/pools/${poolId}`))
  ck('池已開賣', pool?.status === 'open', `status=${pool?.status}`)
  const seats: number[] = []
  const takenSet = new Set<number>(pool?.takenSeats ?? [])
  for (let i = 1; i <= (pool?.totalTickets ?? 0); i++) if (!takenSet.has(i)) seats.push(i)
  const dr = await call(buyer, `/v1/pools/${poolId}/draw`, { seats, idempotencyKey: 'up-' + Date.now() })
  ck('抽完整池', dr.ok, `${dr.status} ${(await dr.clone().text()).slice(0, 200)}`)

  const got = (await bookOf(buyer)).filter((x: Any) => x.card?.certNo === CERT2)
  ck('買家卡冊裡有那張卡（一列，不是兩列）', got.length === 1, `找到 ${got.length} 列`)
  ck('過戶的還是上傳那一列（id 沒變）', got[0]?.id === uploadedId, `${uploadedId} vs ${got[0]?.id}`)
  ck('狀態是保管中', got[0]?.status === 'stashed', `status=${got[0]?.status}`)
  const left = (await bookOf(seller)).filter((x: Any) => x.card?.certNo === CERT2)
  ck('賣家卡冊不再有那張卡', left.length === 0, `還剩 ${left.length} 列`)
}

head('整條路：上傳 → 直接上架市場（in_book 走需寄送）')
{
  const CERT3 = `STUB-OK-555-${RUN}`
  const up = await call(seller, '/v1/cardbook/upload', { card: upCard(CERT3, '555') })
  const upB = await json(up.clone())
  ck('上傳成功', up.ok, `${up.status} ${JSON.stringify(upB).slice(0, 160)}`)

  const lr = await call(seller, '/v1/listings', { prizeId: upB.prize.id, price: 500 })
  const lb = await json(lr.clone())
  ck('上傳的卡上架成功', lr.ok, `${lr.status} ${JSON.stringify(lb).slice(0, 160)}`)
  ck('交付方式是需寄送（實體在自己手上）', lb.listing?.delivery === 'ship', `delivery=${lb.listing?.delivery}`)

  const listed = (await bookOf(seller)).find((x: Any) => x.card?.certNo === CERT3)
  ck('卡冊那一列進 listed', listed?.status === 'listed', `status=${listed?.status}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

export {}
