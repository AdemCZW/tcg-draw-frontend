/**
 * 023 的迴歸測試：帶鑑定編號的獎品在建池時就進卡冊。
 *
 * 這一組驗的是「同一個編號不能同時放進兩個池」—— 那是 open-issues U-1，
 * 也是這次改動唯一的目的。順帶驗抽卡的過戶路徑沒有把卡開成兩列。
 *
 *   npx tsx src/regress-pledge.ts http://localhost:8089
 *
 * ⚠️ **要有自己的乾淨資料庫，不能跟 smoke 共用一個。**
 * 兩邊都會消耗種子資料而且互相干擾：
 *   - smoke 先跑 → 它在 u-seller 上累積逾期違約（那是它刻意要驗的），
 *     跑完那個帳號達到停權門檻，這支全部倒在 SELLER_SUSPENDED
 *   - 這支先跑 → 它開池、抽卡、讓池到期，smoke 預期的種子狀態就變了
 * 兩種都是測試互相污染，不是缺陷。各自 migrate + seed 一個新庫再跑。
 */
const base = (process.argv[2] ?? 'http://localhost:8089').replace(/\/$/, '')
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

/* 用一個已經完成過池的賣家，避開「第一個池額度上限」那道閘。
   種子的 u-seller 有 revealed 的池。 */
const seller = await login('seller', '測試賣家')
await call(platform, '/v1/admin/grant', { userId: 'u-seller', points: 5_000_000, note: '023 測試' })

/* PSA_STUB=1 時查證走 psa.ts 的 stubExchange：'STUB-OK-<卡號>' 才會回
   verified，隨手編的數字一律 'No data found' → CERT_NOT_FOUND 400。
   第一版用了隨機數字，結果「第二個池被擋下」是因為 PSA 查無此卡而不是
   唯一索引 —— 測試通過但驗到的是完全不同的東西。卡號要跟下面 certCard
   的 cardNo 前綴對得上（cardNumbersAgree 比的是數字部分）。 */
/* 帶時間戳讓這支可以重複跑：編號一旦登記過就永遠佔著
   （那正是這支要驗的東西），固定編號第二次跑就會被自己上一輪擋住。
   stub 取的是 split('-')[2]，所以後面再接東西不影響卡號對照。 */
const RUN = String(Date.now()).slice(-8)
const CERT = `STUB-OK-349-${RUN}`
const CERT2 = `STUB-OK-237-${RUN}`
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
    /* certConfirmed: true —— stub 回的 CardNumber 是從 'STUB-OK-<卡號>'
       取的，跟目錄卡號比得上就 verified；比不上時這個旗標表示賣家已經
       自己確認過。這裡測的不是 PSA 對照那條路，不要讓它擋住。 */
    { tier: 'A', card: certCard(certNo), total: 1, certConfirmed: true },
    { tier: 'D', card: plainCard, total: 3 }
  ],
  tierBuyback: { A: 3000, D: 200 }
})

head('建池時帶編號的獎品要進卡冊')
const p1r = await makePool('023 測試池 A', CERT)
const p1 = await json(p1r.clone())
ck('建池成功', p1r.ok, `${p1r.status} ${JSON.stringify(p1).slice(0, 200)}`)
const poolId = p1.poolId as string

const book = await json(await call(seller, '/v1/prizes?limit=100'))
const pledged = (book.items ?? []).find((x: Any) => x.card?.certNo === CERT)
ck('那張卡出現在賣家的卡冊裡', !!pledged, `找不到 certNo=${CERT}`)
ck('狀態是 in_pool（押在池裡）', pledged?.status === 'in_pool', `status=${pledged?.status}`)

head('同一個編號不能再放進第二個池（U-1）')
const p2r = await makePool('023 測試池 B（同一個編號）', CERT)
const p2 = await json(p2r.clone())
ck('第二個池被擋下', !p2r.ok, `${p2r.status} ${JSON.stringify(p2).slice(0, 160)}`)
ck('而且不是 500（要講得出原因）', p2r.status !== 500, `status=${p2r.status}`)
console.log(`       回應：${p2r.status} ${JSON.stringify(p2).slice(0, 200)}`)

head('不同編號照樣開得起來（沒有誤擋）')
const p3r = await makePool('023 測試池 C（不同編號）', CERT2)
ck('不同編號的池建得成', p3r.ok, `${p3r.status} ${(await p3r.clone().text()).slice(0, 160)}`)

head('抽中要過戶，不是開第二列')
{
  const buyer = await login('pledgebuyer', '押記買家')
  await call(platform, '/v1/admin/grant', { userId: 'u-pledgebuyer', points: 100_000, note: '023 測試' })
  /* 建池只到 committed —— 開賣要等 drand 的未來輪次到期。
     正式環境靠 sweepPools 定期試，測試裡直接推一把。 */
  for (let i = 0; i < 40; i++) {
    const o = await json(await call(buyer, `/v1/pools/${poolId}/open`, {}))
    if (o.opened) break
    await new Promise(r => setTimeout(r, 1000))
  }
  const { pool } = await json(await call(buyer, `/v1/pools/${poolId}`))
  ck('池已開賣', pool?.status === 'open', `status=${pool?.status}`)
  const taken = new Set<number>(pool.takenSeats ?? [])
  const seats: number[] = []
  for (let i = 1; i <= pool.totalTickets && seats.length < pool.totalTickets; i++) if (!taken.has(i)) seats.push(i)
  const dr = await call(buyer, `/v1/pools/${poolId}/draw`,
    { seats, idempotencyKey: 'pledge-' + Date.now() })
  ck('抽完整池', dr.ok, `${dr.status} ${(await dr.clone().text()).slice(0, 200)}`)

  const bb = await json(await call(buyer, '/v1/prizes?limit=100'))
  const got = (bb.items ?? []).filter((x: Any) => x.card?.certNo === CERT)
  ck('買家卡冊裡有那張卡', got.length === 1, `找到 ${got.length} 列`)
  ck('而且狀態是保管中', got[0]?.status === 'stashed', `status=${got[0]?.status}`)
  ck('它就是建池時押記的那一列（id 沒變＝過戶不是新增）',
    got[0]?.id === pledged?.id, `${pledged?.id} vs ${got[0]?.id}`)

  const sb = await json(await call(seller, '/v1/prizes?limit=100'))
  const left = (sb.items ?? []).filter((x: Any) => x.card?.certNo === CERT)
  ck('賣家卡冊裡不再有那張卡', left.length === 0, `還剩 ${left.length} 列`)
}

head('池結束時沒被抽走的押記卡要回賣家卡冊')
{
  const CERT3 = `STUB-OK-341-${RUN}`
  const r = await makePool('023 測試池 D（會讓它到期）', CERT3)
  const pd = await json(r.clone())
  ck('建池成功', r.ok, `${r.status} ${JSON.stringify(pd).slice(0, 160)}`)
  const pid2 = pd.poolId as string

  const b0 = await json(await call(seller, '/v1/prizes?limit=100'))
  const before = (b0.items ?? []).find((x: Any) => x.card?.certNo === CERT3)
  ck('押記中（in_pool）', before?.status === 'in_pool', `status=${before?.status}`)

  /* 讓它到期。到期只停止販售，接著會走到 revealed —— 解押掛在 revealPool，
     因為那是抽完／到期／提前關三條路的共同終點。 */
  await fetch(`${base}/v1/dev/expire-pool`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poolId: pid2 })
  })
  /* sweepPools 是五分鐘一次的排程，測試等不了。用 dev 端點推。
     到期→cancelled→revealed 是兩步（同一支掃描的不同分支），所以推兩次。 */
  for (let i = 0; i < 4; i++) {
    await fetch(`${base}/v1/dev/sweep-pools`, { method: 'POST' })
    const { pool } = await json(await call(seller, `/v1/pools/${pid2}`))
    if (pool?.status === 'revealed') break
  }
  const { pool: fin } = await json(await call(seller, `/v1/pools/${pid2}`))
  ck('池走到 revealed', fin?.status === 'revealed', `status=${fin?.status}`)

  const b1 = await json(await call(seller, '/v1/prizes?limit=100'))
  const after = (b1.items ?? []).find((x: Any) => x.card?.certNo === CERT3)
  ck('卡還在賣家名下（沒有消失）', !!after, '找不到那張卡')
  ck('狀態解押回 in_book', after?.status === 'in_book', `status=${after?.status}`)
  ck('還是同一列（沒有被重建）', after?.id === before?.id, `${before?.id} vs ${after?.id}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

export {}
