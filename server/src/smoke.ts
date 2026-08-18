/**
 * 端到端煙霧測試。打真的 HTTP、對真的 Postgres。
 *
 * 存在的理由：selftest 只驗規則（純函式），但這個系統真正會出事的地方
 * 是資料庫那一層 —— 交易邊界、SELECT FOR UPDATE、帳本一致性。
 * 那些沒有真的 Postgres 就驗不了，所以必須有一支能對著已部署的服務跑的測試。
 *
 *   npm run smoke                          # 打 localhost:8080
 *   npm run smoke -- https://xxx.up.railway.app
 *
 * 會改資料，不要對正式環境跑。
 */
const base = (process.argv[2] ?? 'http://localhost:8080').replace(/\/$/, '')

// 測試腳本裡對回應形狀的假設是刻意寬鬆的：這裡驗的是行為，不是型別
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const json = (r: Response): Promise<Any> => r.json()

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

async function login(handle: string, name: string) {
  const r = await fetch(`${base}/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, name })
  })
  if (!r.ok) throw new Error(`login ${handle} failed: ${r.status} ${await r.text()}`)
  return (await json(r)).token as string
}

const call = (token: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })

async function run() {
  console.log(`smoke → ${base}\n`)

  const health = await fetch(`${base}/health`)
  check('健康檢查', health.ok)
  if (!health.ok) { console.error('服務沒起來，後面不用跑了'); process.exit(1) }

  const buyer = await login('buyer', '測試買家')
  const seller = await login('seller', '測試賣家')
  const platform = await login('platform', 'VaultDraw 官方')

  const { listings } = await json(await fetch(`${base}/v1/listings`))
  const ship = listings.find((l: { delivery: string; sellerId: string }) =>
    l.delivery === 'ship' && l.sellerId === 'u-seller')
  const vault = listings.find((l: { delivery: string }) => l.delivery === 'vault')
  check('種子資料有需寄送的掛單', !!ship, '先跑 npm run seed')
  check('種子資料有庫內轉移的掛單', !!vault)
  if (!ship) { console.error('沒有可測的掛單'); process.exit(1) }

  const w0 = await json(await call(buyer, '/v1/orders'))

  /* 併發：同一張卡同時買兩次。
     這是整支測試最重要的一條 —— 驗的是 SELECT ... FOR UPDATE 有沒有真的鎖住。
     沒有鎖的話兩邊都會通過「掛單還是 live」的檢查，兩張訂單都成立，
     一張卡賣給兩個人。 */
  const [a, b] = await Promise.all([
    call(buyer, '/v1/orders', { listingId: ship.id, idempotencyKey: 'smoke-' + Date.now() + '-a' }),
    call(buyer, '/v1/orders', { listingId: ship.id, idempotencyKey: 'smoke-' + Date.now() + '-b' })
  ])
  const oks = [a, b].filter(r => r.ok).length
  check('同時買同一張卡，只有一筆成立', oks === 1, `實際 ${oks} 筆成功`)
  const taken = await Promise.all([a, b].filter(r => !r.ok).map(json))
  check('另一筆回 LISTING_TAKEN', taken[0]?.error === 'LISTING_TAKEN', JSON.stringify(taken[0]))

  const created = await json(a.ok ? a : b)
  const order = created.order
  check('建立的是託管訂單', order?.status === 'escrowed')
  check('保證金有算出來', typeof order?.deposit === 'number' && order.deposit > 0)

  const w1 = await json(await call(buyer, '/v1/orders'))
  check('貨款被凍結（不是扣款）',
    w1.wallet.locked === w0.wallet.locked + order.price && w1.wallet.points === w0.wallet.points,
    `locked ${w0.wallet.locked}→${w1.wallet.locked}, points ${w0.wallet.points}→${w1.wallet.points}`)

  // 重複送出同一把 key 不該再成立一張
  const dupKey = 'smoke-dup-' + Date.now()
  const d1 = await call(buyer, '/v1/orders', { listingId: ship.id, idempotencyKey: dupKey })
  const d2 = await call(buyer, '/v1/orders', { listingId: ship.id, idempotencyKey: dupKey })
  check('掛單賣掉後不能再買', !d1.ok && (await json(d1)).error === 'LISTING_TAKEN')
  check('重複的 idempotencyKey 不會爆炸', d2.status === d1.status)

  // 買家不能替賣家出貨
  const wrongRole = await call(buyer, `/v1/orders/${order.id}/ship`,
    { tracking: 'ABC12345678', photoUrls: ['https://example.com/a.jpg'] })
  check('買家不能替賣家出貨', wrongRole.status === 403, String(wrongRole.status))

  // 單號驗證
  const bad = await call(seller, `/v1/orders/${order.id}/ship`,
    { tracking: 'BAD', photoUrls: ['https://example.com/a.jpg'] })
  check('壞單號被擋', !bad.ok)
  const noPhoto = await call(seller, `/v1/orders/${order.id}/ship`,
    { tracking: 'ABC12345678', photoUrls: [] })
  check('沒有出貨照被擋', !noPhoto.ok)

  const tracking = 'SMOKE' + Date.now().toString(36).toUpperCase()
  const shipped = await call(seller, `/v1/orders/${order.id}/ship`,
    { tracking, photoUrls: ['https://example.com/a.jpg'] })
  check('賣家出貨成功', shipped.ok, await shipped.clone().text())

  // 還沒送達，買家不能確認收貨
  const early = await call(buyer, `/v1/orders/${order.id}/confirm`)
  check('未送達不能確認收貨', !early.ok)

  const delivered = await call(platform, `/v1/orders/${order.id}/delivered`)
  check('物流回報簽收', delivered.ok, await delivered.clone().text())

  const confirmed = await call(buyer, `/v1/orders/${order.id}/confirm`)
  check('買家確認收貨', confirmed.ok, await confirmed.clone().text())

  const w2 = await json(await call(buyer, '/v1/orders'))
  check('放款後凍結歸還', w2.wallet.locked === w0.wallet.locked,
    `${w0.wallet.locked} → ${w2.wallet.locked}`)
  check('貨款只扣一次', w2.wallet.points === w0.wallet.points - order.price,
    `${w0.wallet.points} → ${w2.wallet.points}，價 ${order.price}`)

  // 已結案的訂單不能再動
  const again = await call(buyer, `/v1/orders/${order.id}/confirm`)
  check('已完成的訂單不能重複確認', !again.ok)

  // 庫內轉移：沒有訂單，直接過戶
  if (vault) {
    const v = await call(buyer, '/v1/orders', { listingId: vault.id, idempotencyKey: 'smoke-v-' + Date.now() })
    const vj = await json(v)
    check('庫內轉移不產生訂單', v.ok && vj.order === null, JSON.stringify(vj).slice(0, 120))
    check('庫內轉移直接扣點', v.ok && vj.wallet.points === w2.wallet.points - vault.price,
      v.ok ? `${w2.wallet.points} → ${vj.wallet.points}` : '')
  }

  /* ---- 抽選 ---- */
  console.log('\n抽選：')
  const poolsRes = await json(await fetch(`${base}/v1/pools`))
  const pool = poolsRes.pools.find((p: { id: string }) => p.id === 'p-seed-1')
  check('種子池存在且 open', pool?.status === 'open', '先跑 npm run seed')
  if (pool) {
    check('open 的池不會洩漏 server_seed', pool.serverSeed === null)
    check('但 commit_hash 是公開的', typeof pool.commitHash === 'string' && pool.commitHash.length === 64)

    // 兩個人同時搶同一格
    const seat = pool.takenSeats.includes(7) ? 8 : 7
    const [d1, d2] = await Promise.all([
      call(buyer, `/v1/pools/${pool.id}/draw`, { seats: [seat], idempotencyKey: 'smoke-d-' + Date.now() + 'a' }),
      call(seller, `/v1/pools/${pool.id}/draw`, { seats: [seat], idempotencyKey: 'smoke-d-' + Date.now() + 'b' })
    ])
    const won = [d1, d2].filter(r => r.ok)
    check('同一格只有一個人抽到', won.length === 1, `${won.length} 個成功`)
    const lost = await Promise.all([d1, d2].filter(r => !r.ok).map(json))
    check('另一個收到 SEATS_TAKEN 與衝突清單',
      lost[0]?.error === 'SEATS_TAKEN' && Array.isArray(lost[0]?.taken) && lost[0].taken.includes(seat),
      JSON.stringify(lost[0]))

    const dj = await json(won[0]!)
    check('抽到的東西有籤位、賞別、卡', dj.items?.[0]?.seat === seat && !!dj.items[0].tier && !!dj.items[0].card)
    check('抽選扣點', dj.wallet.points < 1000000)

    // 多籤：其中一格已被拿走 → 整筆失敗、一格都不給
    const wBefore = (await json(await call(buyer, '/v1/wallet'))).wallet.points
    const multi = await call(buyer, `/v1/pools/${pool.id}/draw`,
      { seats: [seat, 90, 91], idempotencyKey: 'smoke-m-' + Date.now() })
    check('多籤含已被拿走的格 → 整筆失敗', !multi.ok && (await json(multi)).error === 'SEATS_TAKEN')
    const wAfter = (await json(await call(buyer, '/v1/wallet'))).wallet.points
    check('失敗的多籤沒有扣任何點', wBefore === wAfter)

    // 獎品進了保管庫
    const mine = await json(await call(buyer, '/v1/prizes'))
    const got = mine.prizes.find((p: { seat: number }) => Number(p.seat) === seat)
    const owner = d1.ok ? buyer : seller
    if (d1.ok) check('抽到的卡在買家的保管庫', !!got && got.status === 'stashed')

    // reveal 前拿不到 seed
    const rv = await fetch(`${base}/v1/pools/${pool.id}/reveal`)
    check('未 revealed 的池不給 reveal 資料', rv.status === 409)
    void owner
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

run().catch(e => { console.error('\nsmoke 掛了:', e.message); process.exit(1) })
