/**
 * 端到端煙霧測試。打真的 HTTP、對真的 Postgres。
 *
 * 存在的理由：selftest 只驗規則（純函式），但這個系統真正會出事的地方
 * 是資料庫那一層 —— 交易邊界、SELECT FOR UPDATE、帳本一致性。
 * 那些沒有真的 Postgres 就驗不了，所以必須有一支能對著已部署的服務跑的測試。
 *
 *   npm run smoke                          # 打 localhost:8080（伺服器要設 DEV_LOGIN=1）
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
  const r = await fetch(`${base}/v1/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, name })
  })
  if (!r.ok) throw new Error(`login ${handle} failed: ${r.status} ${await r.text()}`)
  return (await json(r)).token as string
}

/**
 * 用「有沒有帶 body」判斷 GET/POST。
 *
 * 陷阱：不需要 body 的 POST 端點（confirm、delivered）如果呼叫時省略第三個參數，
 * 會被誤判成 GET，打到只註冊 POST 的路由上得到 Hono 預設的 404 —— 這個 404
 * 又剛好滿足「不是 ok」，會讓用 !xxx.ok 判斷失敗與否的檢查誤判成功。
 * 這個檔案曾經因為這個原因產生過一次完全看不出來是測試工具問題的假警報。
 * 不需要 body 的 POST 呼叫時，一律明確傳 {}，不要省略第三個參數。
 */
const call = (token: string, path: string, body?: unknown, method?: 'GET' | 'POST' | 'PUT') =>
  fetch(`${base}${path}`, {
    // 沒指定 method 時沿用「有 body 就是 POST」的推斷（見上方說明）；
    // PUT 的端點必須明寫，推斷不出來
    method: method ?? (body === undefined ? 'GET' : 'POST'),
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

  const photo = ['https://example.com/a.jpg']

  // 買家不能替賣家出貨
  const wrongRole = await call(buyer, `/v1/orders/${order.id}/ship`,
    { carrier: 'other', tracking: 'ABC12345678', photoUrls: photo })
  check('買家不能替賣家出貨', wrongRole.status === 403, String(wrongRole.status))

  /* ---- 單號驗證 ----
     中華郵政走萬國郵政聯盟的 S10：2 個英文字母 + 9 位數字 + 2 位國碼，
     第 9 位是前 8 位的 mod-11 檢查碼。這幾條釘住「隨手編的過不了、
     打錯一碼會被抓到」—— 後者其實比防詐騙更常派上用場，
     誠實賣家打錯字的代價是訂單卡十四天然後自動退款。 */
  const s10 = (eight: string) => {
    const w = [8, 6, 4, 2, 3, 5, 9, 7]
    let sum = 0
    for (let i = 0; i < 8; i++) sum += Number(eight[i]) * w[i]!
    const r = 11 - (sum % 11)
    return eight + String(r === 10 ? 0 : r === 11 ? 5 : r)
  }

  const noCarrier = await call(seller, `/v1/orders/${order.id}/ship`,
    { tracking: 'RR123456785TW', photoUrls: photo })
  check('沒選物流商 → 被擋', noCarrier.status === 400, String(noCarrier.status))

  const badDigit = await call(seller, `/v1/orders/${order.id}/ship`,
    { carrier: 'post', tracking: 'RR' + s10('12345678').slice(0, 8) + '9TW', photoUrls: photo })
  check('中華郵政：檢查碼不對的單號被擋', badDigit.status === 409, String(badDigit.status))

  const wrongShape = await call(seller, `/v1/orders/${order.id}/ship`,
    { carrier: 'tcat', tracking: 'ABCD1234', photoUrls: photo })
  check('黑貓：非純數字被擋', wrongShape.status === 409)

  const tooShort = await call(seller, `/v1/orders/${order.id}/ship`,
    { carrier: 'other', tracking: 'X', photoUrls: photo })
  check('「其他」仍然擋掉太短的單號', tooShort.status === 400 || tooShort.status === 409)

  const noPhoto = await call(seller, `/v1/orders/${order.id}/ship`,
    { carrier: 'other', tracking: 'ABC12345678', photoUrls: [] })
  check('沒有出貨照被擋', !noPhoto.ok)

  // 用一組真的算得出來的 S10 出貨，順便驗證正向路徑
  const serial = String(Date.now() % 1e8).padStart(8, '0')
  const tracking = 'RR' + s10(serial) + 'TW'
  const shipped = await call(seller, `/v1/orders/${order.id}/ship`,
    { carrier: 'post', tracking, photoUrls: photo })
  check('檢查碼正確的中華郵政單號可以出貨', shipped.ok, await shipped.clone().text())

  // 還沒送達，買家不能確認收貨
  const early = await call(buyer, `/v1/orders/${order.id}/confirm`, {})
  check('未送達不能確認收貨', !early.ok)

  const delivered = await call(platform, `/v1/orders/${order.id}/delivered`, {})
  check('物流回報簽收', delivered.ok, await delivered.clone().text())

  const confirmed = await call(buyer, `/v1/orders/${order.id}/confirm`, {})
  check('買家確認收貨', confirmed.ok, await confirmed.clone().text())

  const w2 = await json(await call(buyer, '/v1/orders'))
  check('放款後凍結歸還', w2.wallet.locked === w0.wallet.locked,
    `${w0.wallet.locked} → ${w2.wallet.locked}`)
  check('貨款只扣一次', w2.wallet.points === w0.wallet.points - order.price,
    `${w0.wallet.points} → ${w2.wallet.points}，價 ${order.price}`)

  // 已結案的訂單不能再動
  const again = await call(buyer, `/v1/orders/${order.id}/confirm`, {})
  check('已完成的訂單不能重複確認', !again.ok)

  // 庫內轉移：沒有訂單，直接過戶
  if (vault) {
    const v = await call(buyer, '/v1/orders', { listingId: vault.id, idempotencyKey: 'smoke-v-' + Date.now() })
    const vj = await json(v)
    check('庫內轉移不產生訂單', v.ok && vj.order === null, JSON.stringify(vj).slice(0, 120))
    check('庫內轉移直接扣點', v.ok && vj.wallet.points === w2.wallet.points - vault.price,
      v.ok ? `${w2.wallet.points} → ${vj.wallet.points}` : '')
  }

  /* ---- 併發：同一個人同時花兩筆錢 ----
     跟上面「兩個人搶同一張卡」不同，這裡兩筆交易鎖的是**不同**的 listings 列，
     所以彼此完全不會互相阻擋。餘額不是欄位、是 SUM(points_ledger.delta) 推算的，
     沒有任何一列可以鎖 —— 在 READ COMMITTED 下兩邊會讀到同一個 available、
     各自判定「夠」，然後各自花掉同一筆錢，帳本因此變成負的。
     防線是 money.ts 的 lockSpender()：拿 users 那一列當這個人的帳戶閘門。 */
  console.log('\n併發花費：')
  {
    const all = (await json(await fetch(`${base}/v1/listings`))).listings as Any[]
    const two = all.filter(l => l.delivery === 'ship' && l.status === 'live').slice(0, 2)
    if (two.length < 2) {
      check('（跳過併發花費：市場上剩不到兩筆需寄送的掛單）', true)
    } else {
      const spender = await login('dblspend', '併發測試')
      const [la, lb] = two as [Any, Any]
      // 剛好差一點，湊不出兩筆 —— 沒有鎖的話兩筆都會成立
      const budget = la.price + lb.price - 1
      const g = await call(platform, '/v1/admin/grant',
        { userId: 'u-dblspend', points: budget, note: 'smoke 併發花費測試' })
      check('發點數給測試帳號', g.ok, await g.clone().text())
      const w = await json(await call(spender, '/v1/wallet'))
      check('測試帳號的餘額剛好差一點湊不出兩筆',
        w.wallet.available === budget, `${w.wallet.available} vs ${budget}`)

      const [ra, rb] = await Promise.all([
        call(spender, '/v1/orders', { listingId: la.id, idempotencyKey: 'smoke-ds-' + Date.now() + '-a' }),
        call(spender, '/v1/orders', { listingId: lb.id, idempotencyKey: 'smoke-ds-' + Date.now() + '-b' })
      ])
      const okCount = [ra, rb].filter(r => r.ok).length
      check('同時買兩張不同的卡，只有一筆成立（點數不夠買兩筆）',
        okCount === 1, `實際 ${okCount} 筆成功`)
      const rejected = await Promise.all([ra, rb].filter(r => !r.ok).map(json))
      check('另一筆回 INSUFFICIENT_POINTS',
        rejected[0]?.error === 'INSUFFICIENT_POINTS', JSON.stringify(rejected[0]))

      const w2 = await json(await call(spender, '/v1/wallet'))
      check('凍結沒有超過餘額（available 不能是負的）',
        w2.wallet.available >= 0,
        `points ${w2.wallet.points} / locked ${w2.wallet.locked} / available ${w2.wallet.available}`)
    }
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

  /* ---- 檔案上傳 ---- */
  console.log('\n檔案上傳：')
  const noAuth = await fetch(`${base}/v1/files/presign`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ purpose: 'avatar', mime: 'image/png', bytes: 1000 })
  })
  check('presign 沒帶 token 回 401', noAuth.status === 401)

  const badMime = await call(buyer, '/v1/files/presign', { purpose: 'avatar', mime: 'application/zip', bytes: 1000 })
  check('presign 不在白名單的 mime 被拒', badMime.status === 400 && (await json(badMime)).error === 'BAD_MIME')

  const tooBig = await call(buyer, '/v1/files/presign', { purpose: 'avatar', mime: 'image/png', bytes: 999_999_999 })
  check('presign 超過大小上限被拒', tooBig.status === 400 && (await json(tooBig)).error === 'TOO_LARGE')

  const png1x1 = Uint8Array.from(atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  ), ch => ch.charCodeAt(0))

  const pre = await call(buyer, '/v1/files/presign', { purpose: 'ship-photo', mime: 'image/png', bytes: png1x1.length })
  if (pre.status === 503) {
    check('R2 未設定時 presign 明確回 503（不是本地才有的行為，是尚未設定的預期行為）', true)
  } else {
    check('presign 成功回 fileId 與 uploadUrl', pre.ok, await pre.clone().text())
    const { fileId, uploadUrl } = await json(pre)

    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png1x1 })
    check('用簽名網址直接 PUT 到 R2 成功', put.ok, `${put.status} ${await put.clone().text().catch(() => '')}`)

    const anonRead = await fetch(`${base}/v1/files/${fileId}`)
    check('私密檔案（ship-photo）沒登入讀不到', anonRead.status === 401)

    const authRead = await call(buyer, `/v1/files/${fileId}`)
    check('上傳者本人可以讀到 ship-photo 的網址', authRead.ok)

    /* 這條是修正過的行為：ship-photo / unbox-video 原本任何登入使用者都讀得到。
       出貨照會拍到面單上的姓名電話地址，開箱影片會拍到家裡 —— 註冊一個帳號
       就看得到別人的，那是實質的個資外洩。 */
    const otherRead = await call(seller, `/v1/files/${fileId}`)
    check('ship-photo 別的登入者讀不到', otherRead.status === 403, `${otherRead.status}`)
    const adminShipRead = await call(platform, `/v1/files/${fileId}`)
    check('ship-photo 管理員讀得到（裁決爭議需要）', adminShipRead.ok)
    const { url: readUrl } = await json(authRead)
    const fetched = await fetch(readUrl)
    check('讀到的網址真的能拿到剛才上傳的內容', fetched.ok, `${fetched.status}`)

    // seller-doc：更敏感，只有本人或平台能看
    const docPre = await call(seller, '/v1/files/presign', { purpose: 'seller-doc', mime: 'image/png', bytes: png1x1.length })
    const { fileId: docId, uploadUrl: docUrl } = await json(docPre)
    await fetch(docUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png1x1 })
    const strangerRead = await call(buyer, `/v1/files/${docId}`)
    check('seller-doc 不是本人也不是平台會被拒', strangerRead.status === 403)
    const ownerRead = await call(seller, `/v1/files/${docId}`)
    check('seller-doc 本人可以讀', ownerRead.ok)
    const adminRead = await call(platform, `/v1/files/${docId}`)
    check('seller-doc 平台帳號可以讀', adminRead.ok)
  }

  /* ---- 後台：出貨與調閱 ----
     出貨這條線之前沒有讀取端點，使用者申請完就沒人看得到。
     這裡驗的是補上之後的完整迴路：申請 → 後台看得到 → 單向推進 → 卡片狀態跟著改。 */
  console.log('\n後台：')
  {
    const notAdmin = await call(buyer, '/v1/admin/overview')
    check('一般會員打後台端點被擋', notAdmin.status === 403, `${notAdmin.status}`)

    const ov = await json(await call(platform, '/v1/admin/overview'))
    check('總覽帶出待處理出貨數', typeof ov.overview?.ship_requested === 'number')

    // 用買家保管庫裡任何一張還在庫的卡送出貨申請
    const stash = await json(await call(buyer, '/v1/prizes'))
    const frees = (stash.prizes ?? []).filter((p: { status: string }) => p.status === 'stashed')
    const [free, free2] = frees
    if (!free) {
      check('（跳過出貨流程：買家沒有庫存卡）', true)
    } else {
      const req = await call(buyer, '/v1/prizes/ship', {
        prizeIds: [free.id],
        address: { name: '測試收件', phone: '0900000000', zip: '106', city: '台北市', line1: '測試路 1 號' }
      })
      check('使用者送得出出貨申請', req.ok, `${req.status}`)
      const { shipmentId } = await json(req)

      const list = await json(await call(platform, '/v1/admin/shipments?status=requested'))
      const found = (list.shipments ?? []).find((x: { id: string }) => x.id === shipmentId)
      check('後台在待處理清單裡看得到這筆', !!found)
      check('清單帶出收件人與卡片內容', !!found?.address?.phone && found?.prizes?.length === 1)

      const packed = await call(platform, `/v1/admin/shipments/${shipmentId}/status`, { status: 'packed', note: 'smoke' })
      check('推進到已包裝', packed.ok, `${packed.status}`)

      const noTrack = await call(platform, `/v1/admin/shipments/${shipmentId}/status`, { status: 'shipped', note: 'smoke' })
      check('標為已寄出但沒填單號 → 被擋', noTrack.status === 400)

      const tn = 'SMOKE' + Date.now()
      const shippedR = await call(platform, `/v1/admin/shipments/${shipmentId}/status`,
        { status: 'shipped', tracking: tn, note: 'smoke' })
      check('填了單號才寄得出', shippedR.ok, `${shippedR.status}`)

      const back = await call(platform, `/v1/admin/shipments/${shipmentId}/status`, { status: 'packed', note: 'smoke' })
      check('不能往回改狀態', back.status === 409)

      const after = await json(await call(platform, '/v1/admin/shipments'))
      const now = (after.shipments ?? []).find((x: { id: string }) => x.id === shipmentId)
      check('單號有記下來', now?.tracking === tn)
      check('寄出後卡片離開保管庫', now?.status === 'shipped')

      const stash2 = await json(await call(buyer, '/v1/prizes'))
      const moved = (stash2.prizes ?? []).find((p: { id: string }) => p.id === free.id)
      check('卡片狀態同步成 shipped', moved?.status === 'shipped', moved?.status)

      /* ---- 需寄送的二手轉賣：卡真的要換手 ----
         這一段釘住的是一個原本整段不存在的行為。庫內轉移會改 prizes.user_id，
         但需寄送的訂單從頭到尾沒有動過 prizes，於是：
           1 買家付了點數、收到實體卡，卡冊裡卻什麼都沒有
           2 賣家可以把同一張卡一直重新上架再賣一次 —— 訂單完成後
             listings.status 變 'sold'，兩條 `where status='live'` 的唯一索引
             立刻不再擋，而沒有鑑定編號的 RAW 卡連同時掛兩筆都擋不住。 */
      const relistPrice = 300
      const listed = await call(buyer, '/v1/listings', { prizeId: free.id, price: relistPrice })
      check('已寄出的卡可以再上架（需寄送）', listed.ok, await listed.clone().text())
      const listing2 = (await json(listed)).listing

      const stash3 = await json(await call(buyer, '/v1/prizes'))
      const nowListed = (stash3.prizes ?? []).find((p: { id: string }) => p.id === free.id)
      check('上架後卡片標成 listed（需寄送也要標，否則擋不住重複上架）',
        nowListed?.status === 'listed', nowListed?.status)

      const relist = await call(buyer, '/v1/listings', { prizeId: free.id, price: relistPrice })
      check('同一張卡不能同時掛兩筆', relist.status === 409, `${relist.status}`)

      // 讓賣家買下來，走完整條託管流程
      await call(platform, '/v1/admin/grant',
        { userId: 'u-seller', points: relistPrice * 4, note: 'smoke 轉賣測試' })
      const buy2 = await call(seller, '/v1/orders',
        { listingId: listing2.id, idempotencyKey: 'smoke-relist-' + Date.now() })
      check('另一個人買得下這張二手卡', buy2.ok, await buy2.clone().text())
      const order2 = (await json(buy2)).order

      const serial2 = String((Date.now() + 7) % 1e8).padStart(8, '0')
      const shipped2 = await call(buyer, `/v1/orders/${order2.id}/ship`,
        { carrier: 'post', tracking: 'RR' + s10(serial2) + 'TW', photoUrls: photo })
      check('原持有人出貨', shipped2.ok, await shipped2.clone().text())
      await call(platform, `/v1/orders/${order2.id}/delivered`, {})
      const done2 = await call(seller, `/v1/orders/${order2.id}/confirm`, {})
      check('新買家確認收貨', done2.ok, await done2.clone().text())

      const sellerCards = await json(await call(seller, '/v1/prizes'))
      check('成交後卡片過戶到新買家名下',
        (sellerCards.prizes ?? []).some((p: { id: string; status: string }) =>
          p.id === free.id && p.status === 'shipped'))
      const oldOwner = await json(await call(buyer, '/v1/prizes'))
      check('原持有人的卡冊裡不再有這張卡',
        !(oldOwner.prizes ?? []).some((p: { id: string }) => p.id === free.id))

      // 賣掉之後不能再上架一次 —— 卡已經不是他的了
      const resell = await call(buyer, '/v1/listings', { prizeId: free.id, price: relistPrice })
      check('賣掉之後原持有人不能再上架同一張卡', resell.status === 404, `${resell.status}`)
    }

    /* ---- 出貨單直接跳到已送達 ----
       狀態只擋往回走，所以 requested → delivered 是合法的一步
       （客服拿到簽收回報時直接標完成，中間那步沒人按）。
       原本只有 'shipped' 那個分支會把卡片標成離開保管庫，跳過去的話
       卡就永遠停在 'ship_requested' —— 上架不行、回收不行、交易也不行，
       而且沒有任何端點救得回來。 */
    if (free2) {
      const req2 = await call(buyer, '/v1/prizes/ship', {
        prizeIds: [free2.id],
        address: { name: '測試收件', phone: '0900000000', zip: '106', city: '台北市', line1: '測試路 2 號' }
      })
      check('第二筆出貨申請送得出', req2.ok, `${req2.status}`)
      const sid2 = (await json(req2)).shipmentId
      const jump = await call(platform, `/v1/admin/shipments/${sid2}/status`,
        { status: 'delivered', note: 'smoke 直接標送達' })
      check('可以從 requested 直接標成 delivered', jump.ok, `${jump.status}`)
      const after2 = await json(await call(buyer, '/v1/prizes'))
      const p2 = (after2.prizes ?? []).find((p: { id: string }) => p.id === free2.id)
      check('跳過 shipped 的出貨單也要把卡片放出 ship_requested',
        p2?.status === 'shipped', p2?.status)
    }

    // 調閱會員資料：一次要帶回身分、餘額、卡、訂單、出貨、帳本
    const users = await json(await call(platform, '/v1/admin/users?q=buyer'))
    const uid = users.users?.[0]?.id
    check('後台搜尋得到會員', !!uid)
    if (uid) {
      const d = await json(await call(platform, `/v1/admin/users/${uid}`))
      check('會員檔案一次帶回六個區塊',
        !!d.user && Array.isArray(d.providers) && !!d.wallet &&
        Array.isArray(d.prizes) && Array.isArray(d.orders) && Array.isArray(d.ledger))
      check('會員檔案含出貨紀錄', Array.isArray(d.shipments))
    }
    const missing = await call(platform, '/v1/admin/users/u-does-not-exist')
    check('查不存在的會員回 404', missing.status === 404)

    check('池清單讀得到', (await call(platform, '/v1/admin/pools')).ok)
    check('驗證文件清單讀得到', (await call(platform, '/v1/admin/verifications')).ok)

    // 爭議裁決改走 admin 路由：理由是必填，因為它會實際移動點數且不可逆
    const noReason = await call(platform, '/v1/admin/disputes/o-nope/resolve', { to: 'buyer', note: 'x' })
    check('裁決理由太短 → 被擋', noReason.status === 400, `${noReason.status}`)
  }

  /* ---- 卡冊分享、交易邀約、通知 ----
     這三件事是同一條動線：分享卡冊 → 別人看到想要 → 出價 → 我收到通知。
     所以一起測，斷在哪一環都看得出來。 */
  /* ---- 賣家申請 ----
     這條路原本整段不存在：POST /v1/pools 回 NOT_SELLER 叫人「先申請成為賣家」，
     但平台上沒有任何地方可以申請。 */
  console.log('\n賣家申請：')
  {
    const anon = await fetch(`${base}/v1/seller/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '路人商店', origin: 'personal' })
    })
    check('沒登入不能申請', anon.status === 401)

    // buyer 在 seed 裡不是賣家，拿他來驗完整流程
    const before = await json(await call(buyer, '/v1/seller/me'))
    if (before.seller) {
      check('（跳過申請：這個帳號已經是賣家了）', true)
    } else {
      const short = await call(buyer, '/v1/seller/apply', { name: 'x', origin: 'personal' })
      check('賣家名稱太短被擋', short.status === 400)

      const ok = await call(buyer, '/v1/seller/apply', { name: '煙霧測試小舖', origin: 'personal', bio: 'smoke' })
      check('申請成功', ok.ok, `${ok.status}`)
      check('申請後是待審核', (await json(ok)).seller?.tier === 'pending')

      const again = await call(buyer, '/v1/seller/apply', { name: '煙霧測試小舖', origin: 'personal' })
      check('重複送出不會變成錯誤', again.ok && (await json(again)).already === true)

      const meNow = await json(await call(buyer, '/v1/seller/me'))
      check('查得到自己的賣家狀態', meNow.seller?.tier === 'pending')

      // pending 不能開池 —— 門檻在這裡，不在申請
      const pool = await call(buyer, '/v1/pools', {
        title: '不該開得成的池', mode: 'classic', ticketPrice: 100, totalTickets: 2,
        prizes: [{ tier: 'D', card: { name: 'x', setCode: 'sv', cardNo: '1', language: 'JP', grader: 'RAW', grade: null, certNo: null, refPrice: 10 }, total: 2 }]
      })
      check('待審核的賣家開不了池', pool.status === 403, `${pool.status}`)

      // 後台看得到這筆待審
      const list = await json(await call(platform, '/v1/admin/sellers'))
      check('後台賣家清單看得到新申請',
        (list.sellers ?? []).some((x: { id: string; tier: string }) => x.id === 'u-buyer' && x.tier === 'pending'))
    }

    /* 後端只收 classic：抽卡邏輯不讀 mode，收下其他模式等於讓賣家開出
       標示著某種玩法、實際卻不是那樣運作的池 */
    const badMode = await call(seller, '/v1/pools', {
      title: '連莊池', mode: 'streak', ticketPrice: 100, totalTickets: 1,
      prizes: [{ tier: 'D', card: { name: 'x', setCode: 'sv', cardNo: '1', language: 'JP', grader: 'RAW', grade: null, certNo: null, refPrice: 10 }, total: 1 }]
    })
    check('後端不收 classic 以外的玩法', badMode.status === 400, `${badMode.status}`)

    // 公開的賣家端點不能被 /v1/seller 的 requireAuth 波及
    check('賣家列表仍然公開', (await fetch(`${base}/v1/sellers`)).ok)
    check('賣家頁仍然公開', (await fetch(`${base}/v1/sellers/u-seller`)).ok)
  }

  /* ---- 出價會凍結點數 ----
     沒有這條防線，餘額 1000 的人可以同時對十張卡各出價 1000：
     lockSpender 保證只有一筆成交、不會憑空造錢，但另外九個持有人
     會花時間去看一個根本付不出來的出價。 */
  console.log('\n出價凍結：')
  {
    const before = (await json(await call(seller, '/v1/wallet'))).wallet
    check('凍結金額一開始是可讀的數字', typeof before.locked === 'number')
  }

  console.log('\n分享與交易邀約：')
  {
    // 沒公開之前，連結不該有效
    const s0 = await json(await call(buyer, '/v1/social/cardbook/settings'))
    check('卡冊預設不公開', s0.public === false)

    const on = await json(await call(buyer, '/v1/social/cardbook/settings',
      { public: true }, 'PUT'))
    check('打開公開會拿到分享代號', on.public === true && typeof on.slug === 'string' && on.slug.length > 0)

    // 公開頁不需要登入 —— 分享連結的意義就是給沒帳號的人看
    const anon = await fetch(`${base}/v1/share/cardbook/${on.slug}`)
    check('公開卡冊不用登入就看得到', anon.ok, `${anon.status}`)
    const book = await json(anon)
    check('公開卡冊帶出持有人與卡片', !!book.owner?.name && Array.isArray(book.prizes))
    check('公開卡冊不外洩 user_id / email / 電話',
      !JSON.stringify(book).includes('u-buyer') && !JSON.stringify(book).includes('@'))

    // 關掉之後，已經流傳出去的連結要真的失效
    await call(buyer, '/v1/social/cardbook/settings', { public: false }, 'PUT')
    const closed = await fetch(`${base}/v1/share/cardbook/${on.slug}`)
    check('關掉公開後舊連結立刻失效', closed.status === 403, `${closed.status}`)
    await call(buyer, '/v1/social/cardbook/settings', { public: true }, 'PUT')

    // 換代號：舊的失效、新的可用
    const rot = await json(await call(buyer, '/v1/social/cardbook/settings',
      { public: true, rotate: true }, 'PUT'))
    check('換代號後拿到不一樣的代號', rot.slug !== on.slug)
    check('舊代號失效', (await fetch(`${base}/v1/share/cardbook/${on.slug}`)).status === 404)
    check('新代號可用', (await fetch(`${base}/v1/share/cardbook/${rot.slug}`)).ok)

    // 賣家卡冊裡挑一張還在保管庫的卡，讓買家出價
    const ownerBook = await json(await fetch(`${base}/v1/share/cardbook/${rot.slug}`))
    const target = (ownerBook.prizes ?? []).find((p: { tradable: boolean }) => p.tradable)
    if (!target) {
      check('（跳過出價流程：卡冊裡沒有可交易的卡）', true)
    } else {
      const anonOffer = await fetch(`${base}/v1/social/trade-offers`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prizeId: target.id, points: 500 })
      })
      check('沒登入不能提出交易', anonOffer.status === 401, `${anonOffer.status}`)

      const selfOffer = await call(buyer, '/v1/social/trade-offers', { prizeId: target.id, points: 500 })
      check('不能對自己的卡出價', selfOffer.status === 409)

      const made = await call(seller, '/v1/social/trade-offers',
        { prizeId: target.id, points: 500, message: 'smoke 測試出價' })
      check('登入後提得出交易', made.ok, `${made.status}`)
      const { offerId } = await json(made)

      const dup = await call(seller, '/v1/social/trade-offers', { prizeId: target.id, points: 600 })
      check('同一張卡重複出價被擋', dup.status === 409)

      /* 出價之後那筆錢要真的被凍住 —— 這是「未入帳／已承諾的點數不能再花」的防線 */
      const wAfterOffer = (await json(await call(seller, '/v1/wallet'))).wallet
      check('待回應的出價計入凍結', wAfterOffer.locked >= 500,
        `locked=${wAfterOffer.locked}`)

      // 全部身家都出價出去之後，不該還能再開一筆超出可動用額度的
      const over = await call(seller, '/v1/social/trade-offers',
        { prizeId: target.id + '-nope', points: 999_999_999 })
      check('超過可動用點數的出價開不了', !over.ok)

      // 對方收到通知了嗎
      const sn = await json(await call(buyer, '/v1/social/notifications'))
      check('卡冊持有人收到出價通知',
        (sn.notifications ?? []).some((n: { kind: string; ref_id: string }) =>
          n.kind === 'trade-offer' && n.ref_id === offerId))
      check('未讀數大於零', sn.unread > 0)

      // 成交：點數與卡片同時換手
      const bBefore = (await json(await call(seller, '/v1/wallet'))).wallet.points
      const acc = await call(buyer, `/v1/social/trade-offers/${offerId}/accept`, {})
      check('持有人接受出價', acc.ok, `${acc.status}`)
      const bAfter = (await json(await call(seller, '/v1/wallet'))).wallet.points
      check('出價方被扣了出價的點數', bBefore - bAfter === 500, `${bBefore} → ${bAfter}`)

      const takerBook = await json(await call(seller, '/v1/prizes'))
      check('卡片過戶到出價方名下',
        (takerBook.prizes ?? []).some((p: { id: string }) => p.id === target.id))

      const again = await call(buyer, `/v1/social/trade-offers/${offerId}/accept`, {})
      check('同一筆出價不能重複接受', again.status === 409)

      const bn = await json(await call(seller, '/v1/social/notifications'))
      check('出價方收到成交通知',
        (bn.notifications ?? []).some((n: { kind: string; ref_id: string }) =>
          n.kind === 'trade-result' && n.ref_id === offerId))

      await call(seller, '/v1/social/notifications/read', {})
      const after = await json(await call(seller, '/v1/social/notifications'))
      check('全部已讀後未讀歸零', after.unread === 0)
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

run().catch(e => { console.error('\nsmoke 掛了:', e.message); process.exit(1) })
