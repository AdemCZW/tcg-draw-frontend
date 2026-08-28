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
import { verifyReveal, manifestHashOf, manifestString, commitV2, type Reveal } from './shared/fairness.js'
import { genId } from './seed-gen.js'

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

/**
 * 卡冊與掛單都改成游標分頁了，測試要「整本」時必須自己翻完。
 * 只看第一批會誤判：找不到那張卡不代表它不在，可能只是在第 3 批。
 */
async function allPrizes(token: string, status?: string): Promise<Any[]> {
  const out: Any[] = []
  let cursor: string | null = null
  do {
    const q = new URLSearchParams({ limit: '100' })
    if (status) q.set('status', status)
    if (cursor) q.set('cursor', cursor)
    const r = await json(await call(token, `/v1/prizes?${q}`))
    out.push(...(r.items ?? []))
    cursor = r.nextCursor ?? null
  } while (cursor)
  return out
}

async function allListings(sort = 'new'): Promise<Any[]> {
  const out: Any[] = []
  let cursor: string | null = null
  do {
    const q = new URLSearchParams({ limit: '100', sort })
    if (cursor) q.set('cursor', cursor)
    const r = await json(await fetch(`${base}/v1/listings?${q}`))
    out.push(...(r.items ?? []))
    cursor = r.nextCursor ?? null
  } while (cursor)
  return out
}

async function run() {
  console.log(`smoke → ${base}\n`)

  const health = await fetch(`${base}/health`)
  check('健康檢查', health.ok)
  if (!health.ok) { console.error('服務沒起來，後面不用跑了'); process.exit(1) }

  const buyer = await login('buyer', '測試買家')
  const seller = await login('seller', '測試賣家')
  const platform = await login('platform', 'VaultDraw 官方')

  const listings = await allListings()
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
  const keyA = 'smoke-' + Date.now() + '-a'
  const keyB = 'smoke-' + Date.now() + '-b'
  const [a, b] = await Promise.all([
    call(buyer, '/v1/orders', { listingId: ship.id, idempotencyKey: keyA }),
    call(buyer, '/v1/orders', { listingId: ship.id, idempotencyKey: keyB })
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

  /* ---- 冪等鍵綁使用者（H-1 迴歸，訂單側） ----
     冪等鍵是呼叫端自己產生的字串。查重複時只比 key 不比人的話，
     拿到別人的鍵重放一次，回來的是別人整張訂單：卡片鑑定編號、成交價、
     買賣雙方的 id 與姓名。這是授權缺失，不是「字串猜不到就沒事」。 */
  {
    const winnerKey = a.ok ? keyA : keyB
    const stranger = await login('idem-stranger', '路人甲')
    const stolen = await json(await call(stranger, '/v1/orders',
      { listingId: ship.id, idempotencyKey: winnerKey }))
    check('別人的冪等鍵重放拿不到那張訂單', stolen.order?.id !== order.id,
      JSON.stringify(stolen).slice(0, 200))
    check('別人的冪等鍵重放什麼訂單內容都不給', !stolen.order,
      JSON.stringify(stolen).slice(0, 200))

    /* 反面：本人重放同一把鍵還是要拿回自己原本那筆。
       那是冪等的正常用途，修掉越權不能把它一起修掉。 */
    const replay = await json(await call(buyer, '/v1/orders',
      { listingId: ship.id, idempotencyKey: winnerKey }))
    check('本人重放同一把鍵仍然拿回原本那張訂單', replay.order?.id === order.id,
      JSON.stringify(replay).slice(0, 200))
  }

  /* L-3 之後出貨照只收站內檔案 id（photoFileIds），外部 URL 整個欄位都不存在了。
     這裡大多數測項的重點是單號驗證，照片給空陣列（數量暫不強制，見 orders.ts）。 */
  const photo: string[] = []

  // 買家不能替賣家出貨
  const wrongRole = await call(buyer, `/v1/orders/${order.id}/ship`,
    { carrier: 'other', tracking: 'ABC12345678', photoFileIds: photo })
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

  /* 沒填單號、沒選物流商也出得了貨 —— 平台不串物流，也不會知道賣家用哪一家
     （使用者拍板：寄送與確認由雙方私下完成，平台只提供收件資訊 + 雙方按完成）。
     這裡不真的送出去，只驗它不會被參數擋下來 —— 真的出貨留給下面那條，
     不然訂單狀態會提早離開 escrowed，後面幾條全部連鎖失敗。 */
  const bareShip = await call(seller, `/v1/orders/${order.id}/ship`, {})
  check('不填任何欄位也出得了貨（門檻已移除）', bareShip.ok, String(bareShip.status))
  /* 出貨已經發生，後面那幾條單號驗證要在「已經是 shipped」的狀態下測，
     所以它們現在驗的是「格式錯的單號在任何狀態下都不會通過」——
     狀態守衛會先擋（409），格式驗證擋不擋得到不再是這幾條的重點。 */

  const badDigit = await call(seller, `/v1/orders/${order.id}/ship`,
    { carrier: 'post', tracking: 'RR' + s10('12345678').slice(0, 8) + '9TW', photoFileIds: photo })
  check('中華郵政：檢查碼不對的單號被擋', badDigit.status === 409, String(badDigit.status))

  const wrongShape = await call(seller, `/v1/orders/${order.id}/ship`,
    { carrier: 'tcat', tracking: 'ABCD1234', photoFileIds: photo })
  check('黑貓：非純數字被擋', wrongShape.status === 409)

  const tooShort = await call(seller, `/v1/orders/${order.id}/ship`,
    { carrier: 'other', tracking: 'X', photoFileIds: photo })
  check('「其他」仍然擋掉太短的單號', tooShort.status === 400 || tooShort.status === 409)

  /* L-3 的核心測項：外部 URL 不能再當出貨憑證。
     舊制收 z.string().url()，賣家可以塞自己控制的連結、事後換內容；
     新制只收 f- 開頭的站內檔案 id，而且要驗持有人與用途。 */
  const extUrl = await call(seller, `/v1/orders/${order.id}/ship`,
    { carrier: 'other', tracking: 'ABC12345678', photoFileIds: ['https://example.com/a.jpg'] })
  check('外部 URL 不能當出貨憑證', extUrl.status === 400, String(extUrl.status))

  const fakeId = await call(seller, `/v1/orders/${order.id}/ship`,
    { carrier: 'other', tracking: 'ABC12345678', photoFileIds: ['f-aaaaaaaaaaaa'] })
  check('不存在／不是自己的檔案 id 也被擋', fakeId.status === 400, String(fakeId.status))

  // 用一組真的算得出來的 S10 出貨，順便驗證正向路徑
  const serial = String(Date.now() % 1e8).padStart(8, '0')
  const tracking = 'RR' + s10(serial) + 'TW'
  const shipped = await call(seller, `/v1/orders/${order.id}/ship`,
    { carrier: 'post', tracking, photoFileIds: photo })
  check('已經出貨過的訂單不能再出貨一次（狀態守衛）',
    shipped.status === 409, await shipped.clone().text())

  /* 賣家不能替買家確認收貨 —— 錯的是角色，不是狀態。 */
  const sellerConfirm = await call(seller, `/v1/orders/${order.id}/confirm`, {})
  check('賣家不能替買家確認收貨', !sellerConfirm.ok, String(sellerConfirm.status))

  /* 買家在 shipped 就確認得了，**不必等物流回報簽收**。
     原本這裡斷言的是相反的（「未送達不能確認收貨」），而那條規則在真實
     環境裡是一條死路：delivered 只有平台帳號標得動（未來的物流 webhook
     落點，而那個 webhook 還沒接），所以買家永遠按不到確認收貨，
     賣家寄了卡只能等時限把訂單判掉。 */
  const confirmed = await call(buyer, `/v1/orders/${order.id}/confirm`, {})
  check('買家在運送中就確認得了收貨（不必等簽收回報）',
    confirmed.ok, await confirmed.clone().text())

  const w2 = await json(await call(buyer, '/v1/orders'))
  check('放款後凍結歸還', w2.wallet.locked === w0.wallet.locked,
    `${w0.wallet.locked} → ${w2.wallet.locked}`)
  check('貨款只扣一次', w2.wallet.points === w0.wallet.points - order.price,
    `${w0.wallet.points} → ${w2.wallet.points}，價 ${order.price}`)

  // 已結案的訂單不能再動
  const again = await call(buyer, `/v1/orders/${order.id}/confirm`, {})
  check('已完成的訂單不能重複確認', !again.ok)

  /* ---- 沉默的買家不能白拿卡 ----
     這次改動的核心。舊規則是「出貨後 14 天沒有簽收回報 → 視同未送達、
     自動退款買家」，那讓任何買家都可以收到卡之後什麼都不按、等 14 天，
     結果卡跟錢都留在他手上。新規則是視同送達，接著跑 7 天驗收期，
     期滿放款給賣家。真的沒收到的買家會去開爭議，那本來就是他會做的動作。 */
  {
    const l2 = (await allListings()).find(x => x.delivery === 'ship' && x.status === 'live')
    if (!l2) check('沉默測試：找得到需寄送的掛單', false, '種子掛單不足')
    else {
      const buyer2 = await login('silentbuyer', '沉默買家')
      await call(platform, '/v1/admin/grant',
        { userId: 'u-silentbuyer', points: l2.price * 3, note: 'smoke 沉默買家測試' })
      const o2r = await json(await call(buyer2, '/v1/orders',
        { listingId: l2.id, idempotencyKey: 'smoke-silent-' + Date.now() }))
      const o2 = o2r.order
      check('沉默測試：下單成功', !!o2?.id, JSON.stringify(o2r).slice(0, 160))

      const sellerTok = await login(String(l2.sellerId).replace(/^u-/, ''), '賣家')
      const serial2 = String((Date.now() + 7777) % 1e8).padStart(8, '0')
      const shipRes = await call(sellerTok, `/v1/orders/${o2.id}/ship`,
        { carrier: 'post', tracking: 'RR' + s10(serial2) + 'TW', photoFileIds: [] })
      check('沉默測試：賣家出貨', shipRes.ok, await shipRes.clone().text())

      const sellerBefore = await json(await call(sellerTok, '/v1/wallet'))

      // 撥過 15 天：買家從頭到尾沒有按任何東西
      await fetch(`${base}/v1/dev/rewind-order`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: o2.id, ms: 15 * 86_400_000 })
      })
      const mid = (await json(await call(buyer2, '/v1/orders'))).orders?.find((x: Any) => x.id === o2.id)
      check('沉默 15 天 → 視同送達，不是退款',
        mid?.status === 'delivered', `status=${mid?.status}`)

      // 再撥 8 天：驗收期滿
      await fetch(`${base}/v1/dev/rewind-order`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: o2.id, ms: 8 * 86_400_000 })
      })
      const done = (await json(await call(buyer2, '/v1/orders'))).orders?.find((x: Any) => x.id === o2.id)
      check('再過驗收期 → 放款給賣家（completed）',
        done?.status === 'completed', `status=${done?.status}`)
      check('結案理由是自動放款，不是退款',
        done?.closedBy === 'auto-release', `closedBy=${done?.closedBy}`)

      const sellerAfter = await json(await call(sellerTok, '/v1/wallet'))
      check('賣家真的收到貨款（沉默不再等於白拿卡）',
        sellerAfter.wallet.points > sellerBefore.wallet.points,
        `${sellerBefore.wallet.points} → ${sellerAfter.wallet.points}`)
    }
  }

  // 庫內轉移：沒有訂單，直接過戶
  if (vault) {
    const v = await call(buyer, '/v1/orders', { listingId: vault.id, idempotencyKey: 'smoke-v-' + Date.now() })
    const vj = await json(v)
    check('庫內轉移不產生訂單', v.ok && vj.order === null, JSON.stringify(vj).slice(0, 120))
    check('庫內轉移直接扣點', v.ok && vj.wallet.points === w2.wallet.points - vault.price,
      v.ok ? `${w2.wallet.points} → ${vj.wallet.points}` : '')
    check('庫內轉移回傳過戶到手那張卡的 id', v.ok && typeof vj.stashId === 'string' && vj.stashId.length > 0,
      String(vj.stashId))

    /* 使用者回報的「買到的卡沒馬上跑到卡冊」就是這一條。
       卡確實在同一個交易裡就過戶了，但卡冊照時間排，而過戶只換 owner ——
       買到的卡帶著賣家當初抽到的時間，排在幾天前的位置。卡冊一超過一頁，
       它就不在第一頁上，使用者看到的畫面裡真的沒有那張卡。
       所以要驗的不是「查得到」，是「排在最前面」。 */
    if (v.ok) {
      const book = await json(await call(buyer, '/v1/prizes'))
      check('剛買到的卡排在卡冊第一筆',
        book.items[0]?.id === vj.stashId,
        `第一筆是 ${book.items[0]?.id}，剛買到的是 ${vj.stashId}`)
      check('剛買到的卡狀態回到保管中',
        book.items[0]?.status === 'stashed', String(book.items[0]?.status))
      /* won_at 不該被過戶改掉：公開的「最近開出」動態照它排，
         改了等於讓一張買來的舊卡出現在「剛剛有人抽到」裡。 */
      check('過戶沒有竄改這張卡被抽出來的時間',
        Number(book.items[0]?.acquired_at) > Number(book.items[0]?.won_at),
        `acquired=${book.items[0]?.acquired_at} won=${book.items[0]?.won_at}`)
    }
  }

  /* ---- 併發：同一個人同時花兩筆錢 ----
     跟上面「兩個人搶同一張卡」不同，這裡兩筆交易鎖的是**不同**的 listings 列，
     所以彼此完全不會互相阻擋。餘額不是欄位、是 SUM(points_ledger.delta) 推算的，
     沒有任何一列可以鎖 —— 在 READ COMMITTED 下兩邊會讀到同一個 available、
     各自判定「夠」，然後各自花掉同一筆錢，帳本因此變成負的。
     防線是 money.ts 的 lockSpender()：拿 users 那一列當這個人的帳戶閘門。 */
  console.log('\n併發花費：')
  {
    const all = await allListings()
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
  const pool = poolsRes.pools.find((p: { id: string }) => p.id === genId('p-seed-1'))
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
    const mine = await allPrizes(buyer)
    const got = mine.find((p: { seat: number }) => Number(p.seat) === seat)
    const owner = d1.ok ? buyer : seller
    if (d1.ok) check('抽到的卡在買家的保管庫', !!got && got.status === 'stashed')

    // reveal 前拿不到 seed
    const rv = await fetch(`${base}/v1/pools/${pool.id}/reveal`)
    check('未 revealed 的池不給 reveal 資料', rv.status === 409)
    void owner

    /* ---- 冪等鍵綁使用者（H-1 迴歸，抽選側） ----
       只比 key 不比人的話，重放別人的鍵會直接回 { replay: true, draw: {...} }，
       裡面是那個人的 draw 那一列（user_id、籤位、花了多少點）。 */
    {
      const drawKey = 'smoke-idem-draw-' + Date.now()
      const free = [90, 91, 92, 93, 94].find(s => !pool.takenSeats.includes(s))!
      const own = await json(await call(buyer, `/v1/pools/${pool.id}/draw`,
        { seats: [free], idempotencyKey: drawKey }))
      check('抽選建立了一筆可供重放的紀錄', own.ok === true, JSON.stringify(own).slice(0, 160))

      const stranger = await login('idem-stranger', '路人甲')
      const stolen = await json(await call(stranger, `/v1/pools/${pool.id}/draw`,
        { seats: [free], idempotencyKey: drawKey }))
      check('別人的冪等鍵重放不會回別人的抽卡紀錄',
        stolen.replay !== true && stolen.draw === undefined, JSON.stringify(stolen).slice(0, 200))
      /* 鍵對他等於沒用過，於是走正常流程，然後撞在已經被抽走的籤位上 ——
         這正是我們要的：越權讀取變回一次普通的、會被既有鎖擋住的請求。 */
      check('別人的鍵只是走正常流程，被籤位衝突擋下',
        stolen.error === 'SEATS_TAKEN' || stolen.error === 'INSUFFICIENT_POINTS',
        JSON.stringify(stolen).slice(0, 200))

      /* 兩個人剛好撞到同一把鍵不該互相擋到。這一條守的是 015 的複合主鍵：
         查詢補了 user_id 但主鍵還是 key 單獨一欄的話，這裡會撞主鍵直接 500。 */
      const other = [90, 91, 92, 93, 94, 95].find(s => s !== free && !pool.takenSeats.includes(s))!
      const sameKeyOther = await json(await call(seller, `/v1/pools/${pool.id}/draw`,
        { seats: [other], idempotencyKey: drawKey }))
      check('兩個人用同一把鍵各自抽各自的，互不影響',
        sameKeyOther.ok === true && sameKeyOther.items?.[0]?.seat === other,
        JSON.stringify(sameKeyOther).slice(0, 200))

      // 反面：本人重放自己的鍵，冪等照舊
      const mine = await json(await call(buyer, `/v1/pools/${pool.id}/draw`,
        { seats: [free], idempotencyKey: drawKey }))
      check('本人重放自己的鍵仍然回原本那一抽',
        mine.replay === true && mine.draw?.id === own.drawId, JSON.stringify(mine).slice(0, 200))
    }
  }

  /* ---- PSA 鑑定編號查證 ----
     全部走 stub（伺服器要設 PSA_STUB=1）：不能真的打正式環境的 PSA
     （會吃掉 100/天配額，而且帳號待核准全 403，見 docs/psa-api-access.md）。
     stub 用 cert 編號的前綴選分支，見 src/psa.ts 的 stubExchange。
     沒開 stub 時（例如對正式環境跑）整段跳過，不製造假警報。 */
  console.log('\nPSA 鑑定編號查證：')
  {
    const probe = await json(await call(seller, '/v1/psa/verify', { certNumber: 'STUB-OK-025' }))
    const stubbed = probe.ok === true && probe.cert?.cardNumber === '025'
    if (!stubbed) {
      check('（跳過 PSA 查證：伺服器沒開 PSA_STUB=1）', true)
    } else {
      // ── 直接打端點，逐條驗四種 reason ──
      const noAuthPsa = await fetch(`${base}/v1/psa/verify`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ certNumber: 'STUB-OK-025' })
      })
      check('查證端點沒帶 token 回 401', noAuthPsa.status === 401)

      const notFound = await json(await call(seller, '/v1/psa/verify', { certNumber: 'STUB-NOTFOUND-1' }))
      check('查無此卡 → not_found', notFound.ok === false && notFound.reason === 'not_found', JSON.stringify(notFound))

      const invalid = await json(await call(seller, '/v1/psa/verify', { certNumber: 'STUB-INVALID-1' }))
      check('格式錯 → invalid_format', invalid.ok === false && invalid.reason === 'invalid_format', JSON.stringify(invalid))

      const un403 = await json(await call(seller, '/v1/psa/verify', { certNumber: 'STUB-403-1' }))
      check('403 待核准 → api_unavailable（不是賣家的錯）', un403.ok === false && un403.reason === 'api_unavailable', JSON.stringify(un403))

      const un500 = await json(await call(seller, '/v1/psa/verify', { certNumber: 'STUB-500-1' }))
      check('500 憑證問題 → api_unavailable（我方問題，不說 PSA 掛了）', un500.ok === false && un500.reason === 'api_unavailable', JSON.stringify(un500))

      const noCfg = await json(await call(seller, '/v1/psa/verify', { certNumber: 'STUB-NOTCONFIG-1' }))
      check('沒設 token → not_configured', noCfg.ok === false && noCfg.reason === 'not_configured', JSON.stringify(noCfg))

      // 查到就快取，第二次同一張是 cached（省配額，一張卡一輩子查一次）
      const first = await json(await call(seller, '/v1/psa/verify', { certNumber: 'STUB-OK-CACHE' }))
      const second = await json(await call(seller, '/v1/psa/verify', { certNumber: 'STUB-OK-CACHE' }))
      check('查到的結果進快取，第二次同一張讀快取',
        first.ok === true && first.cached === false && second.ok === true && second.cached === true,
        `${JSON.stringify(first).slice(0, 60)} / ${JSON.stringify(second).slice(0, 60)}`)

      // ── 開鑑定卡池：每條分支走一遍 ──
      // 一個小到穩過經濟護欄的鑑定卡池：A 賞是鑑定卡（1 籤）、D 賞是生卡湊數。
      // floor = (50+50)/(100×2) = 50%，過關；票收 200 遠低於新賣家上限。
      const gradedPool = (certNo: string, sellerCardNo: string, certConfirmed?: boolean) => ({
        mode: 'muteki', title: 'PSA 測試池', ticketPrice: 100, totalTickets: 2,
        prizes: [
          {
            tier: 'A', total: 1, buyback: 50, certConfirmed,
            card: {
              id: 'c-psa-a', name: 'テストカード', setCode: 'SV8a', cardNo: sellerCardNo,
              language: 'JP', grader: 'PSA', grade: 10, certNo, image: '', variantId: null, refPrice: null
            }
          },
          {
            tier: 'D', total: 1, buyback: 50,
            card: {
              id: 'c-psa-d', name: '生卡', setCode: 'SV8a', cardNo: '001',
              language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', variantId: null, refPrice: null
            }
          }
        ]
      })
      // 讀回某個池的鑑定卡（tier A）的 psaStatus
      const gradedStatus = async (poolId: string): Promise<string | null | undefined> => {
        const pj = await json(await fetch(`${base}/v1/pools/${poolId}`))
        const a = (pj.pool?.prizes ?? []).find((x: Any) => x.tier === 'A')
        return a?.card?.psaStatus
      }

      // 1) 格式錯 → 擋
      const cInvalid = await call(seller, '/v1/pools', gradedPool('STUB-INVALID-9', '025'))
      const cInvalidJ = await json(cInvalid)
      check('開池：鑑定編號格式錯 → 擋下，不准進池',
        cInvalid.status === 400 && cInvalidJ.error === 'CERT_INVALID', `${cInvalid.status} ${JSON.stringify(cInvalidJ)}`)

      // 2) 查無此卡（假編號）→ 擋
      const cNotFound = await call(seller, '/v1/pools', gradedPool('STUB-NOTFOUND-9', '025'))
      const cNotFoundJ = await json(cNotFound)
      check('開池：查無此卡（假編號）→ 擋下',
        cNotFound.status === 400 && cNotFoundJ.error === 'CERT_NOT_FOUND', `${cNotFound.status} ${JSON.stringify(cNotFoundJ)}`)

      // 3) 查到且卡號對得上 → 放行、標 verified
      const cOk = await call(seller, '/v1/pools', gradedPool('STUB-OK-025', '025'))
      const cOkJ = await json(cOk)
      check('開池：查到且卡號對得上 → 放行', cOk.ok === true && typeof cOkJ.poolId === 'string', `${cOk.status} ${JSON.stringify(cOkJ)}`)
      if (cOk.ok) check('放行的鑑定卡標記為 verified', (await gradedStatus(cOkJ.poolId)) === 'verified')

      // 4) API 不可用（403）→ 不硬擋，標 pending
      const cUnavail = await call(seller, '/v1/pools', gradedPool('STUB-403-9', '025'))
      const cUnavailJ = await json(cUnavail)
      check('開池：暫時無法驗證（403）→ 不硬擋，池照開得成',
        cUnavail.ok === true && typeof cUnavailJ.poolId === 'string', `${cUnavail.status} ${JSON.stringify(cUnavailJ)}`)
      if (cUnavail.ok) check('無法驗證的鑑定卡標記為 pending（未驗證）', (await gradedStatus(cUnavailJ.poolId)) === 'pending')

      // 5) 卡號對不上、賣家沒確認 → 要賣家確認（擋，但講清楚）
      const cMismatch = await call(seller, '/v1/pools', gradedPool('STUB-OK-999', '025'))
      const cMismatchJ = await json(cMismatch)
      check('開池：PSA 卡號跟賣家挑的對不上、又沒確認 → 要賣家確認',
        cMismatch.status === 409 && cMismatchJ.error === 'CERT_MISMATCH' &&
        Array.isArray(cMismatchJ.mismatches) && cMismatchJ.mismatches[0]?.psaCardNumber === '999',
        `${cMismatch.status} ${JSON.stringify(cMismatchJ)}`)

      // 6) 同樣對不上、但賣家確認了是同一張 → 放行、標 verified
      const cConfirmed = await call(seller, '/v1/pools', gradedPool('STUB-OK-999', '025', true))
      const cConfirmedJ = await json(cConfirmed)
      check('開池：卡號對不上但賣家確認過 → 放行', cConfirmed.ok === true, `${cConfirmed.status} ${JSON.stringify(cConfirmedJ)}`)
      if (cConfirmed.ok) check('賣家確認後的鑑定卡標記為 verified', (await gradedStatus(cConfirmedJ.poolId)) === 'verified')
    }
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

    /* 自己抽到有卡為止，不要靠前面的段落留下庫存。
       依賴殘留狀態的結果是：前面段落一改順序，這一整段就被靜默跳過，
       看起來全綠其實什麼都沒驗到（下架那一段先前就是這樣）。 */
    const ensureStash = async (want: number) => {
      for (let round = 0; round < 4; round++) {
        // 狀態過濾走 API 參數，不是撈回來再自己濾 —— 順便把後端的過濾一起驗了
        const have = await allPrizes(buyer, 'stashed')
        if (have.length >= want) return have
        const snap = await json(await fetch(`${base}/v1/pools/${genId('p-seed-1')}`))
        const taken = new Set<number>(snap.pool?.takenSeats ?? [])
        const seats = Array.from({ length: 100 }, (_, i) => i + 1)
          .filter(n => !taken.has(n)).slice(0, want - have.length)
        if (!seats.length) return have
        await call(buyer, `/v1/pools/${genId('p-seed-1')}/draw`,
          { seats, idempotencyKey: 'smoke-ship-' + round + '-' + Date.now() })
      }
      return allPrizes(buyer, 'stashed')
    }
    const frees = await ensureStash(2)
    const [free, free2] = frees
    if (!free) {
      check('（跳過出貨流程：抽不到可用的卡）', false, '這一段沒有驗到任何東西')
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

      const stash2 = await allPrizes(buyer)
      const moved = stash2.find((p: { id: string }) => p.id === free.id)
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

      const stash3 = await allPrizes(buyer)
      const nowListed = stash3.find((p: { id: string }) => p.id === free.id)
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
        { carrier: 'post', tracking: 'RR' + s10(serial2) + 'TW', photoFileIds: photo })
      check('原持有人出貨', shipped2.ok, await shipped2.clone().text())
      await call(platform, `/v1/orders/${order2.id}/delivered`, {})
      const done2 = await call(seller, `/v1/orders/${order2.id}/confirm`, {})
      check('新買家確認收貨', done2.ok, await done2.clone().text())

      const sellerCards = await allPrizes(seller)
      check('成交後卡片過戶到新買家名下',
        sellerCards.some((p: { id: string; status: string }) =>
          p.id === free.id && p.status === 'shipped'))
      const oldOwner = await allPrizes(buyer)
      check('原持有人的卡冊裡不再有這張卡',
        !oldOwner.some((p: { id: string }) => p.id === free.id))

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
      const after2 = await allPrizes(buyer)
      const p2 = after2.find((p: { id: string }) => p.id === free2.id)
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
  /* ---- 下架 ----
     這條路原本不存在，上架之後只能等人買，卡也跟著卡在 listed。 */
  /* 保底回饋率與每一項的買回價，都要在**抽卡之前**看得到 ——
     那是判斷一個池值不值得抽最直接的依據，而且抽完才知道能買回多少就是釣魚。 */
  {
    const snap = await json(await fetch(`${base}/v1/pools/${genId('p-seed-1')}`))
    check('池快照帶出保底回饋率', typeof snap.pool?.floorRatio === 'number',
      `floorRatio=${snap.pool?.floorRatio}`)
    check('種子池的保底回饋率落在護欄之內',
      snap.pool.floorRatio >= 25 && snap.pool.floorRatio < 100, `${snap.pool?.floorRatio}`)
    check('公開的獎項清單每一項都帶宣告買回價（抽卡前就看得到）',
      (snap.pool?.prizes ?? []).length > 0 &&
      snap.pool.prizes.every((x: Any) => typeof x.buyback === 'number' && x.buyback >= 10),
      JSON.stringify((snap.pool?.prizes ?? []).map((x: Any) => x.buyback)))
    /* 保底回饋率必須真的等於 Σ(買回價 × 數量) ÷ 票收。
       少了這一條，存一個好看的常數進 floor_ratio 也會全綠。 */
    const sum = snap.pool.prizes.reduce((a: number, x: Any) => a + x.total * x.buyback, 0)
    const expect = (sum / (snap.pool.totalTickets * snap.pool.ticketPrice)) * 100
    check('保底回饋率就是 Σ(買回價 × 數量) ÷ 票收',
      Math.abs(snap.pool.floorRatio - expect) < 0.02, `${snap.pool.floorRatio} vs ${expect.toFixed(2)}`)

    /* 舊池照實顯示「沒有宣告買回價」，不拿參考價湊一個數字出來 */
    const old = await json(await fetch(`${base}/v1/pools/${genId('p-official-3')}`))
    check('舊池的保底回饋率是 null（它從來沒有宣告過買回價）',
      old.pool?.floorRatio === null, `floorRatio=${old.pool?.floorRatio}`)
    check('舊池的獎項買回價也是 null，不是 0',
      (old.pool?.prizes ?? []).every((x: Any) => x.buyback === null),
      JSON.stringify((old.pool?.prizes ?? []).map((x: Any) => x.buyback)))
    check('舊池仍然留著它當初宣告過的舊制還元率',
      typeof old.pool?.returnRatio === 'number', `returnRatio=${old.pool?.returnRatio}`)
  }

  /* ---- 公平性驗算：新舊兩套 manifest 規則都要驗得過 ----

     manifestString 用 `|` join，尾端加一個 buyback 欄位會讓**每一行**都變 ——
     既有的池用新程式重算出來的 manifest 會對不上它們存著的 commit。
     所以序列化版本化了（v2 / v3），而版本存在池上、由伺服器宣告。

     這一段就是釘住「加了欄位之後舊池沒有集體變成被竄改」。
     p-official-3 是刻意留在 v2 的種子池，p-official-4 是 v3 的。 */
  console.log('\n公平性驗算（v2 / v3 / v4）：')
  for (const [poolId, want] of [[genId('p-official-3'), 2], [genId('p-official-4'), 3], [genId('p-official-5'), 4]] as const) {
    const r = await fetch(`${base}/v1/pools/${poolId}/reveal`)
    if (!r.ok) { check(`${poolId} 取得 reveal`, false, String(r.status)); continue }
    const rv = await json(r) as Reveal & { manifestVersion?: number }
    check(`${poolId} 宣告的 manifest 版本是 v${want}`, rv.manifestVersion === want,
      `manifestVersion=${rv.manifestVersion}`)
    const out = await verifyReveal(rv)
    check(`${poolId}（v${want}）的驗算通過`, out.ok, out.reason ?? '')
    check(`${poolId} 回報的版本是 ${want}`, out.version === want, String(out.version))

    /* 版本必須是池宣告的，不能「哪個版本算得過就算哪個」——
       依序嘗試等於讓一個作弊的伺服器挑對自己有利的那一版送出。 */
    /* 用**每一個**別的版本重算都要失敗，不是只試一個。
       只試一個的話「v4 的池用 v3 算得過」這種洞漏得掉，而那正好是
       「依序嘗試就會被作弊的伺服器利用」的具體長相。 */
    for (const other of [2, 3, 4] as const) {
      if (other === want) continue
      const wrong = await verifyReveal({ ...rv, manifestVersion: other })
      check(`${poolId} 用 v${other} 的規則重算就驗不過`, !wrong.ok, wrong.reason ?? '（竟然通過了）')
    }

    if (want >= 3) {
      check(`${poolId} 的清單每一項都帶宣告買回價`,
        (rv.manifest ?? []).every(m => typeof m.buyback === 'number'),
        JSON.stringify((rv.manifest ?? []).map(m => m.buyback)))
      /* 偷改買回價 —— 籤序一個字都沒動、卡也沒換，只把承諾的金額調低。
         這裡是拿伺服器吐出來的真實資料改一個欄位再重算，
         等同於「有人在資料庫裡動了 pool_prizes.buyback」之後驗算端會看到的東西。 */
      const tampered = (rv.manifest ?? []).map((m, i) => i === 0 ? { ...m, buyback: 10 } : m)
      const bad = await verifyReveal({ ...rv, manifest: tampered })
      check(`${poolId} 開賣後偷改買回價會被驗算抓到（跟偷換卡一樣）`, !bad.ok, bad.reason ?? '（竟然通過了）')
      const reHash = await commitV2(rv.serverSeed, await manifestHashOf(tampered, want))
      check(`${poolId} 而且重算出來的 commit 真的不一樣`, reHash !== rv.commitHash.toLowerCase())
    }

    if (want === 4) {
      /* ---- 這一輪的重點：變體被鎖進承諾了 ----

         p-official-5 的三個獎項卡名、套牌、卡號**逐字相同**，只有變體不同
         （SV2a-025 ピカチュウ 的普卡 / 寶貝球鏡面 / 大師球鏡面，
         cardmarket 實測 €0.02 / €0.28 / €369）。
         在 v3 的規則下這三張在承諾裡分不出來 —— 下面兩條就是釘住這件事。 */
      const man = rv.manifest ?? []
      check('v4 的清單每一項都帶變體識別碼',
        man.length > 0 && man.every(m => typeof m.variantId === 'string' && m.variantId.length > 0),
        JSON.stringify(man.map(m => m.variantId)))
      check('而且同一組卡號的不同版本真的是不同的變體識別碼',
        new Set(man.map(m => m.variantId)).size === man.length,
        JSON.stringify(man.map(m => `${m.cardNo}/${m.variantId}`)))

      /* 偷換版本：卡名、卡號、賞別、張數、買回價**一個字都沒動**，
         只把最貴那一項的變體換成同一個池裡最便宜那一項的變體 ——
         也就是「大師球鏡面偷偷變成普卡」在資料庫裡的長相。
         v3 為止這個改動不會讓 manifest 有任何變化，驗算會回 ok。 */
      const cheap = man.find(m => m.variantId !== man[0]!.variantId)
      const swapped = man.map((m, i) => i === 0 ? { ...m, variantId: cheap!.variantId } : m)
      const swapBad = await verifyReveal({ ...rv, manifest: swapped })
      check('開賣後把卡偷換成同卡號的另一個版本會被驗算抓到', !swapBad.ok,
        swapBad.reason ?? '（竟然通過了）')

      /* 反證：同一份被偷換過的清單，用 v3 的規則序列化出來跟原本**逐字相同** ——
         這就是「為什麼非升版不可」最直接的證據，不是推論。 */
      const v3Same = manifestString(swapped, 3) === manifestString(man, 3)
      check('同一個偷換在 v3 的序列化下逐字看不出來（所以非升 v4 不可）', v3Same)
      const v4Diff = manifestString(swapped, 4) !== manifestString(man, 4)
      check('但在 v4 的序列化下就不一樣了', v4Diff)

      /* 加一欄不能動到前面的欄位 —— v4 的字串必須是「v3 的字串 + |variantId」。
         這一條釘住「舊池不受影響」的機制本身：v2 / v3 的分支逐字沒有被改。 */
      const appendOnly = man.every(m =>
        manifestString([m], 4) === `${manifestString([m], 3)}|${m.variantId ?? ''}`)
      check('v4 只在每行尾端追加一欄，前面的欄位逐字不動', appendOnly)
    }
  }

  /* ---- 印點數（C-2 迴歸） ----
     舊制的印鈔機是「還元率不算 BUST，但回收對每一種賞別都照 refPrice 付 70%」
     —— 兩套規則的縫隙。現在只有一個數字：Σ(宣告買回價) ÷ 票收，每一種賞別都算。
     Σ(買回價) ≥ 票收 的池等於「抽光整池再全部買回還有得賺」，
     這裡驗的是「開池那一刻就開不成」——
     池開不出來，後面抽光跟回收的那一整條路自然不存在。 */
  console.log('\n經濟護欄：')
  {
    /* 買回價總和 = 9,000 + 700 = 9,700，票收 1,000 —— 970% */
    const mint = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-mint', ticketPrice: 100, totalTickets: 10,
      prizes: [
        { tier: 'A', card: { id: 'c-a', name: '誘餌 A 賞', refPrice: 700 }, buyback: 700, total: 1 },
        { tier: 'BUST', card: { id: 'c-bust', name: '爆賞', refPrice: 1_000_000 }, buyback: 1_000, total: 9 }
      ]
    })
    const mj = await json(mint)
    check('Σ(買回價) 超過票收的印點數池開不出來',
      mint.status === 400 && mj.error === 'BAD_ECONOMICS', `${mint.status} ${JSON.stringify(mj)}`)

    /* 爆賞灌 refPrice 現在**不該**再影響任何金額 —— refPrice 已經降級成純顯示。
       同一組獎品，只把買回價壓回合理值，池就開得出來。
       這一條是「refPrice 真的退出金額計算」最直接的證明。 */
    const bustRef = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-bust-ref', ticketPrice: 100, totalTickets: 10,
      prizes: [
        { tier: 'A', card: { id: 'c-a', name: 'A 賞', refPrice: 700 }, buyback: 500, total: 1 },
        { tier: 'BUST', card: { id: 'c-bust', name: '爆賞', refPrice: 1_000_000 }, buyback: 30, total: 9 }
      ]
    })
    check('爆賞的 refPrice 灌到一百萬也不影響護欄（refPrice 不再參與金額計算）',
      bustRef.ok, `${bustRef.status} ${await bustRef.clone().text()}`)
    const brj = await json(bustRef)
    if (brj.poolId) {
      const s3 = await json(await fetch(`${base}/v1/pools/${brj.poolId}`))
      // (500 + 30×9) / 1000 = 77%
      check('保底回饋率只看買回價，不看 refPrice', s3.pool?.floorRatio === 77,
        `floorRatio=${s3.pool?.floorRatio}`)
    }

    // 單張 refPrice 的絕對上限：多打幾個零不該進得了資料庫
    const huge = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-huge-ref', ticketPrice: 100_000_000, totalTickets: 1,
      prizes: [{ tier: 'A', card: { id: 'c-h', name: '天價卡', refPrice: 99_999_999 }, buyback: 50_000_000, total: 1 }]
    })
    check('單張 refPrice 超過上限被擋', huge.status === 400, String(huge.status))

    /* ---- 買回價的上下限 ---- */
    const mkBuyback = (title: string, buyback: unknown) => call(seller, '/v1/pools', {
      mode: 'muteki', title, ticketPrice: 100, totalTickets: 10,
      prizes: [{ tier: 'D', card: { id: 'c-b', name: '測試卡', refPrice: 100 }, buyback, total: 10 }]
    })
    const zero = await mkBuyback('smoke-buyback-0', 0)
    check('買回價填 0 被拒（掛著買回的招牌卻什麼都不買）', zero.status === 400, String(zero.status))
    check('而且講得出下限是多少', (await zero.clone().text()).includes('10'))

    const astro = await mkBuyback('smoke-buyback-astro', 99_999_999)
    check('買回價填天文數字被拒', astro.status === 400, String(astro.status))

    const missing = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-buyback-missing', ticketPrice: 100, totalTickets: 10,
      prizes: [{ tier: 'D', card: { id: 'c-b', name: '測試卡', refPrice: 100 }, total: 10 }]
    })
    check('沒有任何買回價來源的池開不出來（不能有「抽到才發現沒得買回」的獎項）',
      missing.status === 400, String(missing.status))
    check('而且講得出是哪一個賞別缺', (await missing.clone().text()).includes('D 賞'))

    /* ---- 賞別預設 + 個別覆寫 ----
       買回價按賞別給一個絕對金額（不需要任何基準），某一項特別貴時單獨覆寫。
       **存進資料庫與 manifest 的仍然是每個獎品的絕對金額** —— 下面就是驗這件事：
       解析完之後 A 賞那一項拿到的是覆寫值，D 賞拿到的是賞別預設。 */
    const tiered = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-tier-buyback', ticketPrice: 100, totalTickets: 10,
      tierBuyback: { A: 400, D: 40 },
      prizes: [
        { tier: 'A', card: { id: 'c-ta', name: '同賞別裡特別貴的那張' }, buyback: 300, total: 1 },
        { tier: 'D', card: { id: 'c-td', name: '一般 D 賞' }, total: 9 }
      ]
    })
    check('賞別預設 + 個別覆寫開得出池', tiered.ok, `${tiered.status} ${await tiered.clone().text()}`)
    const tj = await json(tiered)
    if (tj.poolId) {
      const snap = await json(await fetch(`${base}/v1/pools/${tj.poolId}`))
      const byTier = Object.fromEntries(
        (snap.pool?.prizes ?? []).map((x: Any) => [x.tier, x.buyback]))
      check('個別覆寫蓋過賞別預設', byTier.A === 300, `A=${byTier.A}`)
      check('沒有覆寫的吃賞別預設', byTier.D === 40, `D=${byTier.D}`)
      // (300 + 40×9) / 1000 = 66%
      check('保底回饋率用的是解析後的絕對金額', snap.pool?.floorRatio === 66,
        `floorRatio=${snap.pool?.floorRatio}`)
      /* refPrice 完全沒填也要開得出來、也要照實回 null。
         退回成 0 的話買家看到的是「這張卡不值 0 元」，那跟「沒有標示」是兩件事。 */
      check('參考價完全不填也開得出池，而且照實回 null（不是 0）',
        (snap.pool?.prizes ?? []).every((x: Any) => x.card?.refPrice === null),
        JSON.stringify((snap.pool?.prizes ?? []).map((x: Any) => x.card?.refPrice)))
    }

    const tierBad = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-tier-bad', ticketPrice: 100, totalTickets: 10,
      tierBuyback: { D: 0 },
      prizes: [{ tier: 'D', card: { id: 'c-tb', name: '測試卡' }, total: 10 }]
    })
    check('賞別預設填 0 一樣被上下限擋下', tierBad.status === 400, String(tierBad.status))

    /* 反面：正常的池還是開得出來。少了這一條，把護欄寫成「一律拒絕」也會全綠。
       買回價總和 500 + 30×9 = 770，票收 1,000 → 77%，落在 25–100 之間。 */
    const okPool = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-ok-pool', ticketPrice: 100, totalTickets: 10,
      prizes: [
        { tier: 'A', card: { id: 'c-a', name: 'A 賞', refPrice: 700 }, buyback: 500, total: 1 },
        { tier: 'BUST', card: { id: 'c-bust', name: '爆賞', refPrice: 30 }, buyback: 30, total: 9 }
      ]
    })
    check('含爆賞但買回價總和合理的池照常開得出來', okPool.ok, `${okPool.status} ${await okPool.clone().text()}`)
    const okj = await json(okPool)
    if (okj.poolId) {
      const s2 = await json(await fetch(`${base}/v1/pools/${okj.poolId}`))
      check('新池的保底回饋率算得對', s2.pool?.floorRatio === 77, `floorRatio=${s2.pool?.floorRatio}`)
      check('新池不再寫舊制的還元率（兩個數字意義不同，不共用一欄）',
        s2.pool?.returnRatio === null, `returnRatio=${s2.pool?.returnRatio}`)
      check('新池宣告的 commit 版本是 4', s2.pool?.commitVersion === 4, `${s2.pool?.commitVersion}`)
    }
  }

  /* ---- 挑卡帶回的身分要完整寫進獎品 ----

     開池的獎品原本只有一個打出來的 `name`，沒有卡號、沒有系列、沒有卡圖、
     沒有版本 —— 那樣的池永遠對不到外部價格，也沒辦法驗證賣家手上是哪一張。
     建池表單改成用 CardPicker 挑卡之後，挑到的整份身分要**原樣**進資料庫，
     這一段就是釘住「中間沒有任何一欄被吃掉」。

     同時測「同一組卡號的兩個版本是兩個獎品」：兩項的卡名 / 套牌 / 卡號
     逐字相同，只有 variantId 不同（SV2a-025 的大師球鏡面與普卡，
     cardmarket 實測差約 18,000 倍）。 */
  console.log('\n挑卡帶回的身分：')
  {
    const master = {
      id: 'c-SV2a-025-master', name: '皮卡丘', setCode: 'sv2a', cardNo: '025/165',
      language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '',
      artId: 'SV2a-025', variantId: '2asus05yghmpd1ud1sdmlq3as4e', refPrice: 12800
    }
    const normal = { ...master, id: 'c-SV2a-025-normal', variantId: 'endfynwn4n10gzq', refPrice: 100 }

    const made = await call(seller, '/v1/pools', {
      /* 票價 1,200 × 10 籤 = 12,000；買回價總和 7,680 + 9×60 = 8,220 → 68.5%，
         落在護欄的 25–100 之間。這一段測的是身分有沒有被吃掉，
         不是經濟護欄，所以數字要刻意調成過得了的。 */
      mode: 'muteki', title: 'smoke-pick-identity', ticketPrice: 1200, totalTickets: 10,
      prizes: [
        { tier: 'A', card: master, buyback: 7680, total: 1 },
        { tier: 'D', card: normal, buyback: 60, total: 9 }
      ]
    })
    check('帶完整卡片身分的池開得出來', made.ok, `${made.status} ${await made.clone().text()}`)
    const mj = await json(made)
    if (mj.poolId) {
      const snap = await json(await fetch(`${base}/v1/pools/${mj.poolId}`))
      const rows: Any[] = snap.pool?.prizes ?? []
      const a = rows.find((x: Any) => x.tier === 'A')?.card
      check('卡號、系列、TCGdex 編號原樣寫進獎品（不是被吃掉的空字串）',
        a?.setCode === 'sv2a' && a?.cardNo === '025/165' && a?.artId === 'SV2a-025',
        JSON.stringify(a))
      check('變體識別碼也原樣寫進獎品',
        a?.variantId === '2asus05yghmpd1ud1sdmlq3as4e', `variantId=${a?.variantId}`)
      check('同一組卡號的兩個版本是兩個獨立的獎品（變體不同）',
        new Set(rows.map((x: Any) => x.card?.variantId)).size === 2,
        JSON.stringify(rows.map((x: Any) => x.card?.variantId)))
      check('這個新池宣告的是 manifest v4', snap.pool?.commitVersion === 4,
        `${snap.pool?.commitVersion}`)
    }

    /* 卡冊來源的卡本來就帶著鑑定編號，那份資訊也要進得去。
       一個編號對應一張實體卡，所以只能開 1 籤 —— 這條規則反過來也要成立：
       帶了編號又開 2 籤要被擋（一卡多賣正是平台聲稱要防的事）。 */
    /* 鑑定編號用 STUB-OK-349190：開池現在會向 PSA 查證（見 PSA 那一節），
       stub 讓 PSA 回 CardNumber=349190，跟這張卡的 cardNo「349/190」的數字部分
       對得上 → 查證通過、標 verified。用真的編號在 stub 下會被當成查無此卡擋掉，
       那是 stub 的安全預設，不是這條測試要驗的東西。 */
    const graded = {
      id: 'cg-smoke-pick', name: '噴火龍 ex UR', setCode: 'sv4a', cardNo: '349/190',
      language: 'JP', grader: 'PSA', grade: 10, certNo: 'STUB-OK-349190', image: '',
      artId: 'SV4a-349', variantId: null, refPrice: 42000
    }
    const g = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-pick-graded', ticketPrice: 900, totalTickets: 10,
      tierBuyback: { A: 6000, D: 200 },
      prizes: [
        { tier: 'A', card: graded, total: 1 },
        { tier: 'D', card: { ...graded, id: 'c-smoke-plain', grader: 'RAW', grade: null, certNo: null, refPrice: 400 }, total: 9 }
      ]
    })
    check('從卡冊挑的鑑定卡開得出池', g.ok, `${g.status} ${await g.clone().text()}`)
    const gj = await json(g)
    if (gj.poolId) {
      const snap = await json(await fetch(`${base}/v1/pools/${gj.poolId}`))
      const a = (snap.pool?.prizes ?? []).find((x: Any) => x.tier === 'A')?.card
      check('鑑定資訊（grader / grade / certNo）完整保留',
        a?.grader === 'PSA' && a?.grade === 10 && a?.certNo === 'STUB-OK-349190', JSON.stringify(a))
      check('卡冊挑的鑑定卡查證通過後標記為 verified', a?.psaStatus === 'verified', JSON.stringify(a?.psaStatus))
    }

    const dup = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-pick-graded-dup', ticketPrice: 900, totalTickets: 10,
      tierBuyback: { A: 6000 },
      prizes: [{ tier: 'A', card: { ...graded, certNo: 'STUB-OK-349191' }, total: 10 }]
    })
    check('帶鑑定編號卻開 10 籤被擋（一個編號對應一張實體卡）', dup.status === 400,
      String(dup.status))
  }

  console.log('\n下架：')
  {
    /* 自己抽一張來測，不要靠前面的段落留下庫存 ——
       出貨與交易那兩段會把買家的卡用掉，靠殘留的話這一整段會被靜默跳過，
       看起來是 ok 其實什麼都沒驗到（第一版就是這樣）。 */
    let free = (await allPrizes(buyer, 'stashed'))[0]
    if (!free) {
      const snap = await json(await fetch(`${base}/v1/pools/${genId('p-seed-1')}`))
      const taken = new Set<number>(snap.pool?.takenSeats ?? [])
      const seat = Array.from({ length: 100 }, (_, i) => i + 1).find(n => !taken.has(n))
      if (seat) {
        await call(buyer, `/v1/pools/${genId('p-seed-1')}/draw`,
          { seats: [seat], idempotencyKey: 'smoke-delist-' + Date.now() })
        free = (await allPrizes(buyer, 'stashed'))[0]
      }
    }
    if (!free) {
      check('（跳過下架：抽不到可用的卡）', false, '這一段沒有驗到任何東西')
    } else {
      const made = await call(buyer, '/v1/listings', { prizeId: free.id, price: 1234 })
      check('上架成功', made.ok, `${made.status}`)
      const { listing } = await json(made)

      const afterList = await allPrizes(buyer)
      check('上架後卡標成 listed',
        afterList.find((p: { id: string }) => p.id === free.id)?.status === 'listed')

      const notMine = await call(seller, `/v1/listings/${listing.id}/delist`, {})
      check('別人不能下架我的掛單', notMine.status === 403, `${notMine.status}`)

      const off = await call(buyer, `/v1/listings/${listing.id}/delist`, {})
      check('下架成功', off.ok, `${off.status}`)

      const afterOff = await allPrizes(buyer)
      check('下架後卡回到保管中',
        afterOff.find((p: { id: string }) => p.id === free.id)?.status === 'stashed')

      const again = await call(buyer, `/v1/listings/${listing.id}/delist`, {})
      check('已下架的不能再下架', again.status === 409)

      // 下架之後要能重新上架 —— 唯一索引是 where status='live'，應該已經放行
      const relist = await call(buyer, '/v1/listings', { prizeId: free.id, price: 2345 })
      check('下架後可以重新上架', relist.ok, `${relist.status}`)
      const { listing: l2 } = await json(relist)
      await call(buyer, `/v1/listings/${l2.id}/delist`, {})
    }
  }

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
        title: '不該開得成的池', mode: 'muteki', ticketPrice: 100, totalTickets: 2,
        prizes: [{ tier: 'D', card: { id: 'c-smoke', name: 'x', setCode: 'sv', cardNo: '1', language: 'JP', grader: 'RAW', grade: null, certNo: null, refPrice: 10 }, buyback: 60, total: 2 }]
      })
      check('待審核的賣家開不了池', pool.status === 403, `${pool.status}`)

      // 後台看得到這筆待審
      const list = await json(await call(platform, '/v1/admin/sellers'))
      check('後台賣家清單看得到新申請',
        (list.sellers ?? []).some((x: { id: string; tier: string }) => x.id === 'u-buyer' && x.tier === 'pending'))
    }

    /* ---- 還元率護欄 ----
       這套判斷原本只存在於前端，也就是說「不合理就不給開」只在瀏覽器裡，
       直接打 API 就能繞過。 */
    const cheapCard = { id: 'c-econ', name: '測試卡', setCode: 'sv', cardNo: '1', language: 'JP', grader: 'RAW', grade: null, certNo: null, refPrice: 10 }
    /* 買回價固定 10 點（下限），只調票價就能掃過整個保底回饋率區間 ——
       這樣測到的是護欄的門檻，不是某一組數字剛好。 */
    const mkPool = (title: string, price: number, tickets: number) => call(seller, '/v1/pools', {
      title, mode: 'muteki', ticketPrice: price, totalTickets: tickets,
      prizes: [{ tier: 'D', card: cheapCard, buyback: 10, total: tickets }]
    })

    const harsh = await mkPool('苛刻池', 100, 10)          // 保底 10%
    check('保底回饋率過低的池開不了', harsh.status === 400, `${harsh.status}`)
    check('而且講得出原因', (await harsh.clone().text()).includes('過於不利'))

    const mint2 = await mkPool('印鈔池', 2, 10)            // 保底 500%
    check('Σ(買回價) 超過票收的池也開不了', mint2.status === 400)
    check('印鈔機的訊息把兩個數字並排講清楚',
      (await mint2.clone().text()).includes('票收'))

    // 反面：保底 50%（買回價 10、票價 20）應該過得了
    const fine = await mkPool('正常池', 20, 10)
    check('保底回饋率落在區間內的池開得出來', fine.ok, `${fine.status}`)

    /* 後端只收 muteki：抽卡邏輯不讀 mode，收下其他模式等於讓賣家開出
       標示著某種玩法、實際卻不是那樣運作的池。
       classic 也在擋掉的名單裡 —— 它宣傳的「抽走最後一籤額外得最後賞」
       後端一行都沒有，開得出來就等於繼續掛著不存在的規則收錢（見 migration 016） */
    const onePrize = [{ tier: 'D', card: { id: 'c-smoke', name: 'x', setCode: 'sv', cardNo: '1', language: 'JP', grader: 'RAW', grade: null, certNo: null, refPrice: 10 }, buyback: 60, total: 1 }]
    const badMode = await call(seller, '/v1/pools', {
      title: '指定賞池', mode: 'shitei', ticketPrice: 100, totalTickets: 1, prizes: onePrize
    })
    check('後端不收 muteki 以外的玩法', badMode.status === 400, `${badMode.status}`)
    const oldMode = await call(seller, '/v1/pools', {
      title: '經典賞池', mode: 'classic', ticketPrice: 100, totalTickets: 1, prizes: onePrize
    })
    check('後端也不收 classic（最後賞規則沒實作）', oldMode.status === 400, `${oldMode.status}`)

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
    check('公開卡冊帶出持有人與卡片', !!book.owner?.name && Array.isArray(book.items))
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
    const target = (ownerBook.items ?? []).find((p: { tradable: boolean }) => p.tradable)
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
      check('同一張卡重複出價被擋', dup.status === 409, `${dup.status} ${await dup.clone().text()}`)

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

      const takerBook = await allPrizes(seller)
      check('卡片過戶到出價方名下',
        takerBook.some((p: { id: string }) => p.id === target.id))

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

  /* ---- 游標分頁 ----
     卡冊、公開卡冊、市場都改成分批載入。這一段釘住的是分頁最容易錯的幾件事：
     換頁會不會漏／重複、最後一頁的 nextCursor 是不是真的 null、
     limit 超出範圍會不會被默默截斷、以及狀態過濾有沒有真的在 SQL 做。 */
  console.log('\n游標分頁：')
  {
    /* 資料不夠就自己抽幾張。「只有 3 張所以跳過」等於這一段什麼都沒驗到 ——
       前面的段落會把買家的卡用掉，不能靠殘留狀態。 */
    for (let round = 0; round < 3; round++) {
      if ((await allPrizes(buyer)).length >= 6) break
      const snap = await json(await fetch(`${base}/v1/pools/${genId('p-seed-1')}`))
      const taken = new Set<number>(snap.pool?.takenSeats ?? [])
      const seats = Array.from({ length: 100 }, (_, i) => i + 1).filter(n => !taken.has(n)).slice(0, 6)
      if (!seats.length) break
      await call(buyer, `/v1/pools/${genId('p-seed-1')}/draw`,
        { seats, idempotencyKey: `smoke-page-${round}-${Date.now()}` })
    }

    /* 使用者回報的「買到的卡沒馬上跑到卡冊」在這裡才驗得出來 ——
       買家手上已經有一疊剛抽到的卡了。庫內轉移只換 owner，如果卡冊照
       won_at（這張卡被抽出來的時間）排，買到的卡帶著賣家當初抽到的時間，
       會排到這一疊剛抽的卡**後面**去；卡冊超過一頁時它根本不在第一頁上。
       所以這一條驗的是排序，不是「查不查得到」—— 資料一直都在，是看不到。 */
    {
      const live = (await allListings()).find(l => l.delivery === 'vault' && l.status === 'live')
      if (!live) {
        check('（跳過買到的卡排序：市場上沒有剩下的庫內轉移掛單）', true)
      } else {
        const before = (await allPrizes(buyer)).length
        const bought = await json(await call(buyer, '/v1/orders',
          { listingId: live.id, idempotencyKey: 'smoke-order-' + Date.now() }))
        const page1 = await json(await call(buyer, '/v1/prizes?limit=3'))
        check('剛買到的卡排在卡冊最前面（不是排到抽卡那疊後面）',
          page1.items[0]?.id === bought.stashId,
          `第一頁第一筆是 ${page1.items[0]?.id}，剛買到的是 ${bought.stashId}`)
        check('買到的卡真的多出一張', (await allPrizes(buyer)).length === before + 1)
      }
    }

    const full = await allPrizes(buyer)
    check('卡冊有足夠的資料可以測分頁', full.length >= 3, `只有 ${full.length} 張`)

    if (full.length >= 3) {
      const p1 = await json(await call(buyer, '/v1/prizes?limit=2'))
      check('第一頁剛好給 limit 筆', p1.items?.length === 2, `${p1.items?.length}`)
      check('還有下一頁時 nextCursor 不是 null', typeof p1.nextCursor === 'string')

      const p2 = await json(await call(buyer, `/v1/prizes?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`))
      const ids1 = new Set(p1.items.map((x: { id: string }) => x.id))
      check('第二頁跟第一頁沒有重複',
        p2.items.every((x: { id: string }) => !ids1.has(x.id)))
      check('第二頁接在第一頁後面（順序沒斷）',
        p2.items[0]?.id === full[2]?.id, `${p2.items[0]?.id} vs ${full[2]?.id}`)

      /* 資料量剛好整除 limit 的情況：拿 limit = 這個狀態的總筆數。
         後端必須當場看得出「沒有下一頁」，而不是回一個游標、
         等前端再打一次拿到空陣列才知道 —— 那一次請求是白打的，
         而且使用者會在捲到底時看到載入指示閃一下又消失。 */
      const stashedAll = await allPrizes(buyer, 'stashed')
      if (stashedAll.length >= 1 && stashedAll.length <= 100) {
        const exact = await json(await call(buyer, `/v1/prizes?status=stashed&limit=${stashedAll.length}`))
        check('資料量剛好整除 limit 時 nextCursor 是 null',
          exact.items.length === stashedAll.length && exact.nextCursor === null,
          `${exact.items.length}/${stashedAll.length} nextCursor=${exact.nextCursor}`)
      } else {
        check('（跳過整除檢查：寄存中的張數超出可測範圍）', false, `${stashedAll.length} 張`)
      }
    }

    // limit 超出範圍要回 400，不是默默給 100 筆
    check('limit 超過上限被拒', (await call(buyer, '/v1/prizes?limit=101')).status === 400)
    check('limit 0 被拒', (await call(buyer, '/v1/prizes?limit=0')).status === 400)
    check('limit 不是數字被拒', (await call(buyer, '/v1/prizes?limit=abc')).status === 400)
    check('亂編的游標被拒', (await call(buyer, '/v1/prizes?cursor=!!!not-base64!!!')).status === 400)

    // 狀態過濾在 SQL 做。翻完所有頁之後的結果必須跟「全部裡挑這個狀態」一致
    for (const st of ['stashed', 'listed', 'shipped'] as const) {
      const filtered = await allPrizes(buyer, st)
      const expected = full.filter((p: { status: string }) => p.status === st)
      check(`status=${st} 過濾的張數正確`, filtered.length === expected.length,
        `${filtered.length} vs ${expected.length}`)
      check(`status=${st} 回傳的每一筆都是這個狀態`,
        filtered.every((p: { status: string }) => p.status === st))
    }
    check('不認得的 status 被拒', (await call(buyer, '/v1/prizes?status=nope')).status === 400)

    // 總覽的數字不能從已載入的那一頁算 —— 它講的是整本卡冊
    const sum = await json(await call(buyer, '/v1/prizes/summary'))
    check('總覽的總張數等於整本卡冊', sum.total === full.length, `${sum.total} vs ${full.length}`)
    check('總覽的各狀態張數對得上',
      ['stashed', 'listed', 'ship_requested', 'shipped', 'recycled', 'refunded'].every(st =>
        sum.counts[st] === full.filter((p: { status: string }) => p.status === st).length))
    check('總覽的總值不含已回收與已退還的卡',
      sum.totalValue === full
        .filter((p: { status: string }) => !['recycled', 'refunded'].includes(p.status))
        .reduce((a: number, p: { card: { refPrice?: number } }) => a + Number(p.card?.refPrice ?? 0), 0),
      `${sum.totalValue}`)

    /* 市場：四種排序各有自己的游標鍵，翻完之後不能漏也不能重複 */
    for (const sort of ['deal', 'new', 'cheap', 'pricey'] as const) {
      const one = await allListings(sort)
      const ids = one.map((l: { id: string }) => l.id)
      check(`市場 sort=${sort} 翻頁不重複`, new Set(ids).size === ids.length)
      // 用不同的 limit 翻，翻出來的集合必須一模一樣（差一個就是邊界寫錯了）
      const small: string[] = []
      let c: string | null = null
      do {
        const q = new URLSearchParams({ limit: '3', sort })
        if (c) q.set('cursor', c)
        const r = await json(await fetch(`${base}/v1/listings?${q}`))
        small.push(...r.items.map((l: { id: string }) => l.id))
        c = r.nextCursor ?? null
      } while (c)
      check(`市場 sort=${sort} 換 limit 翻出同一組結果`,
        small.length === ids.length && small.every((id, i) => id === ids[i]),
        `${small.length} vs ${ids.length}`)
    }
    check('市場的 limit 超過上限被拒',
      (await fetch(`${base}/v1/listings?limit=101`)).status === 400)
    check('市場不認得的排序被拒',
      (await fetch(`${base}/v1/listings?sort=random`)).status === 400)

    const hl = await json(await fetch(`${base}/v1/listings/highlights`))
    check('精選區是有界的 top-N', hl.deals.length <= 6 && hl.graded.length <= 4)
    check('精選區帶出整個市場的總筆數', hl.total === (await allListings()).length)

    /* 公開卡冊：排序是「賞別 → 時間新到舊」，方向是混的，
       游標用 (賞別序, -won_at, id) 表達。這一條驗的就是那組鍵沒寫歪。 */
    const st = await json(await call(buyer, '/v1/social/cardbook/settings',
      { public: true }, 'PUT'))
    const bookAll: string[] = []
    let bc: string | null = null
    do {
      const q = new URLSearchParams({ limit: '2' })
      if (bc) q.set('cursor', bc)
      const r = await json(await fetch(`${base}/v1/share/cardbook/${st.slug}?${q}`))
      bookAll.push(...r.items.map((x: { id: string }) => x.id))
      bc = r.nextCursor ?? null
    } while (bc)
    const bookOnce = await json(await fetch(`${base}/v1/share/cardbook/${st.slug}?limit=100`))
    check('公開卡冊翻頁不重複', new Set(bookAll).size === bookAll.length)
    check('公開卡冊翻完的順序跟一次全撈一致',
      bookAll.length === bookOnce.items.length &&
      bookAll.every((id, i) => id === bookOnce.items[i].id),
      `${bookAll.length} vs ${bookOnce.items.length}`)
    /* 總覽只有第一頁帶，而且講的是整本卡冊 —— 頭部的「收藏 N 張」不能是
       「已經捲出來 N 張」，那個數字會隨著捲動一直長大。 */
    const bookFirst = await json(await fetch(`${base}/v1/share/cardbook/${st.slug}?limit=2`))
    check('公開卡冊第一頁帶總覽，數字是整本卡冊的',
      bookFirst.summary?.count === bookAll.length, `${bookFirst.summary?.count} vs ${bookAll.length}`)
    if (bookFirst.nextCursor) {
      const bookNext = await json(await fetch(
        `${base}/v1/share/cardbook/${st.slug}?limit=2&cursor=${encodeURIComponent(bookFirst.nextCursor)}`))
      check('公開卡冊後續頁不重複帶總覽', bookNext.summary === undefined)
    }
    check('公開卡冊的 limit 超過上限被拒',
      (await fetch(`${base}/v1/share/cardbook/${st.slug}?limit=101`)).status === 400)
  }


  /* ---- 抽卡結算 ----
     這一整段驗的是 docs/pool-modes-audit.md 的 C-2：在它被修好之前，
     玩家抽卡付掉的點數只有借方沒有貸方 —— 賣家一毛都收不到，
     而全站的點數總量每抽一次就少一次。

     每一條規則一組檢查。時限（72 小時 / 7 天 / 14 天）用 DEV_LOGIN 開的
     /v1/dev/rewind-settlement 把時鐘往回撥 —— 那支端點只改時間戳，
     該發生什麼仍然由正常的掃描邏輯判斷，所以測到的是產品邏輯不是測試工具。 */
  console.log('\n抽卡結算：')
  {
    const shop = await login('shop', '關都卡舖')
    const walletOf = async (t: string) => (await json(await call(t, '/v1/wallet'))).wallet
    const rewind = (prizeId: string, ms: number) =>
      fetch(`${base}/v1/dev/rewind-settlement`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prizeId, ms })
      })
    const freeSeat = async (poolId: string, skip = new Set<number>()) => {
      const snap = await json(await fetch(`${base}/v1/pools/${poolId}`))
      const taken = new Set<number>(snap.pool?.takenSeats ?? [])
      const n = Number(snap.pool?.totalTickets ?? 0)
      for (let i = 1; i <= n; i++) if (!taken.has(i) && !skip.has(i)) return i
      return null
    }
    const drawOne = async (token: string, poolId: string) => {
      const seat = await freeSeat(poolId)
      if (seat == null) return null
      const r = await json(await call(token, `/v1/pools/${poolId}/draw`,
        { seats: [seat], idempotencyKey: `smoke-st-${poolId}-${seat}-${Date.now()}` }))
      return r.items?.[0] ? { ...r.items[0], seat } as Any : null
    }
    const ADDR = { name: '測試', phone: '0912345678', line1: '中山路 1 號', city: '台北市' }
    const settlementOf = async (token: string, prizeId: string) => {
      const r = await json(await call(token, '/v1/seller/settlements'))
      return (r.settlements ?? []).find((x: Any) => x.prize_id === prizeId)
    }

    /* 規則 1：抽卡時貸記賣家的「保留額」—— 看得到、動不了 */
    const before = await walletOf(seller)
    const got = await drawOne(buyer, genId('p-seed-1'))
    check('抽得到卡（結算測試的前提）', !!got, JSON.stringify(got))
    if (got) {
      const after = await walletOf(seller)
      check('抽卡後賣家的總餘額增加了票價',
        after.points === before.points + 3250, `${before.points} → ${after.points}`)
      check('增加的部分全部進保留額',
        after.reserved === before.reserved + 3250, `${before.reserved} → ${after.reserved}`)
      check('賣家的可動用點數沒有增加（看得到、動不了）',
        after.available === before.available, `${before.available} → ${after.available}`)

      /* 規則 2：逐筆釋放 —— 出貨 + 鑑賞期滿。不等整池抽完 */
      await call(buyer, '/v1/prizes/ship', { prizeIds: [got.stashId], address: ADDR })
      const st1 = await settlementOf(seller, got.stashId)
      check('買家申請出貨後那一筆變成等待賣家出貨',
        st1?.status === 'awaiting_ship', `${st1?.status}`)
      check('等待出貨期間仍然是保留額',
        (await walletOf(seller)).reserved === before.reserved + 3250)

      const shipRes = await call(seller, `/v1/seller/settlements/${st1.id}/ship`, {})
      check('賣家標記出貨', shipRes.ok, `${shipRes.status} ${await shipRes.clone().text()}`)
      check('出貨後還沒釋放（鑑賞期還在跑）',
        (await walletOf(seller)).reserved === before.reserved + 3250)

      // 鑑賞期 7 天。撥回 8 天之後讀一次清單就會補算
      await rewind(got.stashId, 8 * 86_400_000)
      const st2 = await settlementOf(seller, got.stashId)
      check('鑑賞期滿後那一筆釋放', st2?.status === 'released', `${st2?.status}`)
      const rel = await walletOf(seller)
      check('釋放後保留額回到原本', rel.reserved === before.reserved, `${rel.reserved}`)
      check('釋放後可動用增加了票價',
        rel.available === before.available + 3250, `${before.available} → ${rel.available}`)
      check('釋放不寫新分錄（總餘額沒有再變）',
        rel.points === before.points + 3250, `${rel.points}`)
    }

    /* 規則 2 的另一半：買家確認收貨，立刻釋放，不用等 7 天 */
    {
      const b0 = await walletOf(seller)
      const g = await drawOne(buyer, genId('p-seed-1'))
      if (g) {
        await call(buyer, '/v1/prizes/ship', { prizeIds: [g.stashId], address: ADDR })
        const st = await settlementOf(seller, g.stashId)
        await call(seller, `/v1/seller/settlements/${st.id}/ship`, {})
        const cf = await call(buyer, `/v1/prizes/${g.stashId}/confirm`, {})
        check('買家確認收貨', cf.ok, `${cf.status} ${await cf.clone().text()}`)
        const w = await walletOf(seller)
        check('確認收貨後立刻釋放，不必等鑑賞期',
          w.reserved === b0.reserved && w.available === b0.available + 3250,
          `reserved ${w.reserved} available ${w.available}`)
      } else check('（跳過確認收貨：抽不到卡）', false)
    }

    /* 規則 3：沒出貨逾期 → 從保留額退還買家，並累計賣家違約次數。
       跑三次把 u-shop 推到門檻上（shared/pool-settlement.ts 的 SELLER_DEFAULT_LIMIT）。 */
    const TICKET = 350   // p-shop-1
    for (let i = 0; i < 3; i++) {
      const bBefore = await walletOf(buyer)
      const sBefore = await walletOf(shop)
      const g = await drawOne(buyer, genId('p-shop-1'))
      if (!g) { check(`（跳過逾期未出貨第 ${i + 1} 次：抽不到卡）`, false); continue }
      await call(buyer, '/v1/prizes/ship', { prizeIds: [g.stashId], address: ADDR })
      // 出貨期限 72 小時。撥回 4 天
      await rewind(g.stashId, 4 * 86_400_000)
      // 讀自己的卡冊會順手補算時限（「拉」不是「推」）
      const mine = await allPrizes(buyer)
      const card = mine.find((x: Any) => x.id === g.stashId)
      if (i === 2) {
        check('逾期未出貨：那張卡標成已退還', card?.status === 'refunded', `${card?.status}`)
        const bAfter = await walletOf(buyer)
        check('逾期未出貨：票金原路退回買家',
          bAfter.points === bBefore.points, `${bBefore.points} → ${bAfter.points}`)
        const sAfter = await walletOf(shop)
        check('逾期未出貨：賣家的保留額吐回去，總餘額回到抽卡之前',
          sAfter.points === sBefore.points && sAfter.reserved === sBefore.reserved,
          `points ${sBefore.points}→${sAfter.points} reserved ${sBefore.reserved}→${sAfter.reserved}`)
      }
    }
    const shopSeller = await json(await call(shop, '/v1/seller/me'))
    check('逾期未出貨會累計賣家的違約次數',
      Number(shopSeller.seller?.default_count ?? 0) >= 3, `${shopSeller.seller?.default_count}`)

    /* 規則 3 的後果：超過門檻不能再開池 */
    const blocked = await call(shop, '/v1/pools', {
      mode: 'muteki', title: 'smoke-blocked', ticketPrice: 100, totalTickets: 10,
      prizes: [{ tier: 'D', card: { id: 'c-x', name: '測試卡', refPrice: 85 }, buyback: 60, total: 10 }]
    })
    const bj = await json(blocked)
    check('違約次數達門檻的賣家開不了新池',
      blocked.status === 403 && bj.error === 'SELLER_SUSPENDED', `${blocked.status} ${JSON.stringify(bj)}`)

    /* 規則 4：池到期就關池、停止販售；但已售出的仍照走出貨與鑑賞期 */
    {
      const g = await drawOne(buyer, genId('p-shop-4'))
      await fetch(`${base}/v1/dev/expire-pool`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ poolId: genId('p-shop-4') })
      })
      const seat = await freeSeat(genId('p-shop-4'))
      const late = await call(buyer, `/v1/pools/${genId('p-shop-4')}/draw`,
        { seats: [seat], idempotencyKey: 'smoke-expired-' + Date.now() })
      const lj = await json(late)
      check('池到期後不能再抽', late.status === 409 && lj.error === 'POOL_EXPIRED',
        `${late.status} ${JSON.stringify(lj)}`)

      if (g) {
        await call(buyer, '/v1/prizes/ship', { prizeIds: [g.stashId], address: ADDR })
        const st = await settlementOf(shop, g.stashId)
        check('池到期不影響已售出的那一筆：仍然進得了出貨流程',
          st?.status === 'awaiting_ship', `${st?.status}`)
        const shipped = await call(shop, `/v1/seller/settlements/${st.id}/ship`, {})
        check('池到期後賣家仍然出得了貨', shipped.ok, `${shipped.status}`)
        const cf = await call(buyer, `/v1/prizes/${g.stashId}/confirm`, {})
        check('池到期後買家仍然確認得了收貨（那一筆照樣結算）', cf.ok, `${cf.status}`)
        const st2 = await settlementOf(shop, g.stashId)
        check('池到期後已售出的那一筆照樣釋放', st2?.status === 'released', `${st2?.status}`)
      } else check('（跳過到期池的已售出流程：抽不到卡）', false)
    }

    /* 規則 5：回收照**賣家宣告的買回價**成交，錢從那個池自己的保留額出。
       關鍵有兩件：
         a) 沒有任何新點數被創造（舊制是平台照 refPrice 付 70%，C-2 的印鈔機）
         b) 金額**完全不看 refPrice** —— 下一段會把 refPrice 改掉再驗一次 */
    {
      const total0 = (await json(await call(platform, '/v1/admin/reconcile'))).total
      const sBefore = await walletOf(seller)
      const bBefore = await walletOf(buyer)
      const g = await drawOne(buyer, genId('p-seed-1'))
      if (g) {
        /* 期望值從卡冊那一列帶出來的 buyback 拿 —— 那是伺服器告訴使用者
           「你按下去會拿到多少」的同一個數字。用 refPrice 反推的話，
           這條測試自己就把 refPrice 又綁回金額計算裡了。 */
        const mine = await allPrizes(buyer, 'stashed')
        const row = mine.find((x: Any) => x.id === g.stashId)
        const expect = Number(row?.buyback ?? -1)
        check('卡冊那一列帶出宣告買回價', expect >= 10, `buyback=${row?.buyback}`)
        const refPrice = Number((g.card as Any)?.refPrice ?? 0)
        check('買回價跟賣家標示的參考價是兩個獨立的數字', expect !== refPrice,
          `buyback=${expect} refPrice=${refPrice}`)
        const r = await call(buyer, `/v1/prizes/${g.stashId}/recycle`, {})
        const rj = await json(r)
        check('回收照賣家宣告的買回價成交', r.ok && rj.points === expect,
          `${r.status} ${JSON.stringify(rj)} 期望 ${expect}`)
        const sAfter = await walletOf(seller)
        const bAfter = await walletOf(buyer)
        check('回收的錢是賣家付的（不是平台憑空給的）',
          sAfter.points === sBefore.points + 3250 - expect,
          `${sBefore.points} → ${sAfter.points}`)
        check('買家拿回宣告的點數（其餘留給賣家＝這筆交易取消一半）',
          bAfter.points === bBefore.points - 3250 + expect,
          `${bBefore.points} → ${bAfter.points}`)
        check('回收之後那一筆不再是保留額', sAfter.reserved === sBefore.reserved,
          `${sBefore.reserved} → ${sAfter.reserved}`)
        const total1 = (await json(await call(platform, '/v1/admin/reconcile'))).total
        check('整輪回收沒有創造任何新點數', total1 === total0, `${total0} → ${total1}`)
      } else check('（跳過回收：抽不到卡）', false)
    }

    /* 規則 5b：**回收金額完全不受 refPrice 影響。**
       這是這次改動的核心命題，所以要正面驗一次：把那張卡的 refPrice 改成
       一個荒謬的數字，再回收一次，拿到的點數必須一模一樣。
       refPrice 從 /v1/dev/set-ref-price 改（只有 DEV_LOGIN=1 才開）——
       改的是 prizes.card 那份快照，不動 pool_prizes，所以公平性承諾不受影響。 */
    {
      const g = await drawOne(buyer, genId('p-seed-1'))
      if (g) {
        const mine = await allPrizes(buyer, 'stashed')
        const row = mine.find((x: Any) => x.id === g.stashId)
        const expect = Number(row?.buyback ?? -1)
        const bumped = await fetch(`${base}/v1/dev/set-ref-price`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prizeId: g.stashId, refPrice: 9_000_000 })
        })
        check('把 refPrice 改成天價（測試用端點）', bumped.ok, String(bumped.status))
        const after = (await allPrizes(buyer, 'stashed')).find((x: Any) => x.id === g.stashId)
        check('refPrice 真的被改掉了', Number(after?.card?.refPrice) === 9_000_000,
          `refPrice=${after?.card?.refPrice}`)
        check('買回價不受 refPrice 影響', Number(after?.buyback) === expect,
          `${expect} → ${after?.buyback}`)
        const r = await call(buyer, `/v1/prizes/${g.stashId}/recycle`, {})
        const rj = await json(r)
        check('refPrice 改成天價之後，回收拿到的點數一模一樣',
          r.ok && rj.points === expect, `${r.status} ${JSON.stringify(rj)} 期望 ${expect}`)
      } else check('（跳過 refPrice 無關性：抽不到卡）', false)
    }

    /* 規則 5c：舊制的池（沒有宣告過買回價）不能回收。
       系統不能替賣家簽一個他從來沒同意過的約 —— 見 migration 018。 */
    {
      const g = await drawOne(buyer, genId('p-promo-1'))
      if (g) {
        const mine = await allPrizes(buyer, 'stashed')
        const row = mine.find((x: Any) => x.id === g.stashId)
        check('舊池抽到的卡，買回價是 null 不是 0', row?.buyback === null, `buyback=${row?.buyback}`)
        const r = await call(buyer, `/v1/prizes/${g.stashId}/recycle`, {})
        const rj = await json(r)
        check('舊池抽到的卡回收不了，而且講得出原因',
          r.status === 409 && rj.error === 'NO_OFFER' && String(rj.message).includes('沒有宣告買回價'),
          `${r.status} ${JSON.stringify(rj)}`)
      } else check('（跳過舊池回收：抽不到卡）', false)
    }

    /* 規則 8：賣家自抽自池不禁止（錢從自己流到自己），但不計入公開的進度顯示 */
    {
      const b4 = await json(await fetch(`${base}/v1/pools/${genId('p-seed-1')}`))
      const remain0 = b4.pool.remainingTickets
      const taken0 = b4.pool.takenSeats.length
      const g = await drawOne(seller, genId('p-seed-1'))
      check('賣家抽得了自己的池', !!g, JSON.stringify(g))
      const a4 = await json(await fetch(`${base}/v1/pools/${genId('p-seed-1')}`))
      check('自抽不會推動公開的剩餘籤數',
        a4.pool.remainingTickets === remain0, `${remain0} → ${a4.pool.remainingTickets}`)
      check('但籤位本身確實被佔走（前端才畫得對）',
        a4.pool.takenSeats.length === taken0 + 1, `${taken0} → ${a4.pool.takenSeats.length}`)
      /* 反面：買家抽同一個池會推動進度。少了這一條，把 remainingTickets
         寫死成常數也會全綠 */
      const g2 = await drawOne(buyer, genId('p-seed-1'))
      const a5 = await json(await fetch(`${base}/v1/pools/${genId('p-seed-1')}`))
      check('真人抽卡照常推動公開的剩餘籤數',
        !!g2 && a5.pool.remainingTickets === remain0 - 1,
        `${remain0} → ${a5.pool.remainingTickets}`)
    }

    /* ---------------- 客服工單 ----------------
       整段最重要的兩條，其餘都是護欄：
         1 接管單結案**真的把卡過到申請人名下** —— user_id 與 custodian_id
           一起改。只改一邊的話，卡在申請人的卡冊裡但系統認為實體還在前一手，
           他上架時會被判成「需寄送」而由前一手負責寄一張不在他那的卡。
         2 爭議單結案走的是**既有的**裁決邏輯 —— 下面那條對帳的 drift
           仍然必須是 0。工單這一層一毛錢都不該碰得到。
       工單是前門，不是新的金流：tickets 兩張表 drop 掉，錢跟權限都還是對的。 */
    console.log('\n客服工單：')
    {
      const anon = await fetch(`${base}/v1/tickets`)
      check('工單清單沒登入讀不到', anon.status === 401, `${anon.status}`)
      check('一般會員進不了客服佇列', (await call(buyer, '/v1/admin/tickets')).status === 403)

      /* presign 認不認得 ticket-doc 這個用途。
         用「不在白名單的 mime」測是刻意的：格式驗證跑在 configured() 之前，
         所以這一條在沒有設定 R2 的本機也驗得到（見 files.ts 那段順序的說明）。
         回 BAD_MIME 就代表 purpose 本身被收下了；purpose 不合法會先回 BAD_REQUEST。 */
      const tdMime = await call(buyer, '/v1/files/presign',
        { purpose: 'ticket-doc', mime: 'application/zip', bytes: 1000 })
      check('ticket-doc 是合法的檔案用途，而且擋得住白名單外的 mime',
        tdMime.status === 400 && (await json(tdMime)).error === 'BAD_MIME', `${tdMime.status}`)

      const selfOpen = await call(buyer, '/v1/tickets',
        { kind: 'order-dispute', subject: '我要自己開爭議單', body: 'x' })
      check('order-dispute / seller-doc 不能由使用者自己開',
        selfOpen.status === 400 && String((await json(selfOpen)).message).includes('自動開單'),
        `${selfOpen.status}`)

      const badFile = await call(buyer, '/v1/tickets',
        { kind: 'other', subject: '塞別人的附件', body: 'x', fileIds: ['f-000000000000'] })
      check('附件不是自己站內上傳的檔案被 400 擋下（格式對也不行）',
        badFile.status === 400 && (await json(badFile)).error === 'BAD_ATTACHMENT', `${badFile.status}`)

      /* ---- 接管單：開單 → 認領 → 來回訊息 → 結案 → 過戶 ----
         找一張**別人名下、帶鑑定編號**的卡當標的。公開的掛單端點刻意不吐
         certNo（見 public.ts 的說明），所以從後台的會員檔案拿。 */
      const sellerCards = ((await json(await call(platform, '/v1/admin/users/u-seller'))).prizes ?? []) as Any[]
      const withCert = sellerCards.filter((p: Any) => p.card?.certNo)
      const listedCard = withCert.find((p: Any) => p.status === 'listed')
      const freeCard = withCert.find((p: Any) => ['in_book', 'stashed', 'shipped'].includes(p.status))
      const cand = listedCard ?? freeCard

      if (!cand) {
        check('（跳過接管單：賣家名下沒有帶鑑定編號的卡）', false)
      } else {
        const certNo = String(cand.card.certNo)
        const grader = String(cand.card.grader ?? 'PSA')

        const noCert = await call(buyer, '/v1/tickets',
          { kind: 'takeover', subject: '接管申請', body: '沒填編號' })
        check('接管單沒填鑑定公司／編號被擋', noCert.status === 400, `${noCert.status}`)

        const notReg = await call(buyer, '/v1/tickets',
          { kind: 'takeover', subject: '接管申請', body: 'x', grader: 'PSA', certNo: '00000001' })
        check('沒登記過的編號開不了接管單，而且叫他直接上傳（開單只會讓他多等一天）',
          notReg.status === 400 && String((await json(notReg)).message).includes('上傳'), `${notReg.status}`)

        const selfOwned = await call(seller, '/v1/tickets',
          { kind: 'takeover', subject: '接管自己的卡', body: 'x', grader, certNo })
        check('登記在自己名下的編號開不了接管單',
          selfOwned.status === 400 && (await json(selfOwned)).error === 'CERT_ALREADY_YOURS',
          `${selfOwned.status}`)

        /* 大小寫與前後空白要被正規化成跟 prizes 同一套（upper(btrim)）。
           不正規化的話，同一張實體卡可以被兩個人各開一張接管單而互相看不見。 */
        const openR = await call(buyer, '/v1/tickets', {
          kind: 'takeover', subject: `接管 ${grader} #${certNo}`,
          body: '我在站外買到這張卡，附上交易紀錄。',
          grader: grader.toLowerCase(), certNo: ' ' + certNo + ' '
        })
        const opened = await json(openR)
        check('開接管單成功（201）', openR.status === 201, `${openR.status} ${JSON.stringify(opened).slice(0, 200)}`)
        const tid = opened.ticket?.id as string
        check('編號被正規化（大小寫、前後空白都吃掉）',
          opened.ticket?.grader === grader.toUpperCase() && opened.ticket?.certNo === certNo,
          JSON.stringify({ g: opened.ticket?.grader, c: opened.ticket?.certNo }))
        check('使用者端不回 certHolder —— 那是別人的身分', opened.ticket?.certHolder == null)

        const dupe = await call(buyer, '/v1/tickets',
          { kind: 'takeover', subject: '再開一次', body: 'x', grader, certNo })
        check('同一個編號重複開單回 409',
          dupe.status === 409 && (await json(dupe)).error === 'TICKET_EXISTS', `${dupe.status}`)

        check('別人的單讀不到（404，不是 403 —— 403 等於承認它存在）',
          (await call(seller, `/v1/tickets/${tid}`)).status === 404)
        check('別人的單也回覆不了', (await call(seller, `/v1/tickets/${tid}/messages`, { body: 'x' })).status === 404)

        const queue = await json(await call(platform, '/v1/admin/tickets'))
        const qrow = (queue.items ?? []).find((x: Any) => x.id === tid)
        check('客服佇列看得到這張單', !!qrow, JSON.stringify(queue).slice(0, 200))
        /* 會員編號在種子帳號上是空的（seed 沒發過號），所以驗的是「這一欄有帶出來
           而且是字串」，不是「非空」—— 驗非空的話這條會在乾淨的 seed 上一直紅，
           而它要守的其實是「客服佇列拿得到查人用的欄位、且不會是 null」。 */
        check('佇列帶得出開單人與會員編號（客服要查人）',
          !!qrow?.userName && typeof qrow?.userMemberNo === 'string', JSON.stringify(qrow))
        check('客服視角看得到未讀（最後一則是使用者講的）', qrow?.unread === true)

        const detail = await json(await call(platform, `/v1/admin/tickets/${tid}`))
        check('客服端看得到那個編號目前登記在誰名下',
          detail.ticket?.certHolder?.userId === 'u-seller', JSON.stringify(detail.ticket?.certHolder))

        check('認領成功', (await call(platform, `/v1/admin/tickets/${tid}/claim`, {})).ok)
        check('自己重複認領不噴錯', (await call(platform, `/v1/admin/tickets/${tid}/claim`, {})).ok)

        check('客服回覆成功',
          (await call(platform, `/v1/admin/tickets/${tid}/messages`, { body: '請補上交易紀錄截圖' })).ok)
        const afterStaff = await json(await call(buyer, `/v1/tickets/${tid}`))
        check('客服回覆把狀態推成 pending-user（球在使用者那邊）',
          afterStaff.ticket?.status === 'pending-user', afterStaff.ticket?.status)
        check('使用者這一側看得到未讀', afterStaff.ticket?.unread === true)

        check('使用者回覆成功', (await call(buyer, `/v1/tickets/${tid}/messages`, { body: '截圖如附件' })).ok)
        const afterUser = await json(await call(buyer, `/v1/tickets/${tid}`))
        check('使用者回覆把 pending-user 推回 open（球回到客服手上）',
          afterUser.ticket?.status === 'open', afterUser.ticket?.status)
        check('訊息串照順序長出來', afterUser.ticket?.messages?.length === 3,
          `${afterUser.ticket?.messages?.length}`)

        const noReason = await call(platform, `/v1/admin/tickets/${tid}/resolve`,
          { outcome: 'resolved', resolution: '' })
        check('結案理由必填（沒有理由的裁決事後無法覆核）', noReason.status === 400, `${noReason.status}`)

        if (cand.status === 'listed') {
          /* 撞到還掛在市場上的卡：**擋下來，不是搶走**。
             過戶到一半成交會變成一卡兩賣，而下架是有出路的 —— 直接拒絕
             等於逼一個什麼都沒做錯的人重開一張單。 */
          const busy = await call(platform, `/v1/admin/tickets/${tid}/resolve`,
            { outcome: 'resolved', resolution: '查證屬實' })
          const bj = await json(busy)
          check('卡片還掛在市場上時，接管被擋下而不是直接搶走',
            busy.status === 409 && bj.error === 'CARD_BUSY', `${busy.status} ${JSON.stringify(bj)}`)
          check('而且講得出客服該先處理哪一邊', String(bj.message).includes('下架'), bj.message)

          const mine = (await allListings()).find((l: Any) => l.prizeId === cand.id)
          if (mine) check('把那張卡下架', (await call(seller, `/v1/listings/${mine.id}/delist`, {})).ok)
          else check('（找不到對應的掛單，下架這一步跳過）', false)
        }

        const doneR = await call(platform, `/v1/admin/tickets/${tid}/resolve`,
          { outcome: 'resolved', resolution: '交易紀錄與卡況相符，過戶給申請人' })
        const done = await json(doneR)
        check('接管單結案成功', doneR.ok, `${doneR.status} ${JSON.stringify(done).slice(0, 250)}`)
        check('稽核看得出動到的是哪一列卡', done.effect?.takeover?.prizeId === cand.id,
          JSON.stringify(done.effect))

        const got = (await allPrizes(buyer)).find((p: Any) => p.id === cand.id)
        check('卡真的過到申請人名下（user_id）', got?.user_id === 'u-buyer', String(got?.user_id))
        check('實體保管人也一起改了（custodian_id）—— 站外轉手是唯一兩者同時易主的路徑',
          got?.custodian_id === 'u-buyer', String(got?.custodian_id))
        check('狀態設成 in_book（可以上架、可以進池）', got?.status === 'in_book', String(got?.status))

        const closed = await call(buyer, `/v1/tickets/${tid}/messages`, { body: '再問一句' })
        const cj = await json(closed)
        check('已結案的單不能再回覆（409）',
          closed.status === 409 && cj.error === 'TICKET_CLOSED', `${closed.status}`)
        check('而且建議他開一張新的', String(cj.message).includes('新的工單'), cj.message)

        check('結案寫進 admin_actions',
          ((await json(await call(platform, '/v1/admin/actions'))).actions ?? [])
            .some((a: Any) => a.action === 'ticket-resolve' && a.target === tid))
      }

      /* ---- 訂單爭議：自動開單，而且結案走既有的裁決邏輯 ---- */
      {
        const shipL = (await allListings()).find((l: Any) => l.delivery === 'ship' && l.status === 'live')
        if (!shipL) {
          check('（跳過訂單爭議：沒有可買的需寄送掛單）', false)
        } else {
          const sellerTok = await login(String(shipL.sellerId).replace(/^u-/, ''), '掛單賣家')
          const bought = await json(await call(buyer, '/v1/orders',
            { listingId: shipL.id, idempotencyKey: 'smoke-tk-' + Date.now() }))
          const oid = bought.order?.id as string | undefined
          check('買下一張需寄送的卡（爭議只發生在託管訂單上）', !!oid, JSON.stringify(bought).slice(0, 200))

          if (oid) {
            const trk = 'SMK' + Date.now().toString(36).toUpperCase()
            check('賣家出貨',
              (await call(sellerTok, `/v1/orders/${oid}/ship`, { carrier: 'other', tracking: trk })).ok)

            const wBefore = (await json(await call(buyer, '/v1/orders'))).wallet
            const dis = await call(buyer, `/v1/orders/${oid}/dispute`,
              { reason: '卡片有摺痕，與描述不符', videoUrl: 'https://example.com/unbox.mp4' })
            check('買家開爭議', dis.ok, `${dis.status} ${(await dis.clone().text()).slice(0, 150)}`)

            const dq = await json(await call(platform, '/v1/admin/tickets?kind=order-dispute'))
            const dtk = (dq.items ?? []).find((x: Any) => String(x.subject).startsWith('訂單爭議'))
            check('爭議成立後自動長出一張 order-dispute 單', !!dtk, JSON.stringify(dq).slice(0, 250))

            /* 既有的端點**保留不動**：工單那層萬一有問題還有退路。
               這一條就是在守那個承諾 —— 自動開單不能把舊佇列弄不見。 */
            const legacy = await json(await call(platform, '/v1/admin/disputes'))
            check('既有的 /v1/admin/disputes 還是看得到那筆',
              (legacy.disputes ?? []).some((d: Any) => d.id === oid),
              JSON.stringify((legacy.disputes ?? []).map((d: Any) => d.id)))

            if (dtk) {
              const dd = await json(await call(platform, `/v1/admin/tickets/${dtk.id}`))
              check('自動開的單掛在買家名下、帶著 orderId',
                dd.ticket?.userId === 'u-buyer' && dd.ticket?.orderId === oid,
                JSON.stringify({ u: dd.ticket?.userId, o: dd.ticket?.orderId }))
              check('第一則訊息就是買家填的爭議理由',
                dd.ticket?.messages?.[0]?.body === '卡片有摺痕，與描述不符',
                dd.ticket?.messages?.[0]?.body)

              const noTo = await call(platform, `/v1/admin/tickets/${dtk.id}/resolve`,
                { outcome: 'resolved', resolution: '判給買家' })
              check('爭議單結案沒指定判給誰會被擋（那是會實際移動點數的動作）',
                noTo.status === 400 && String((await json(noTo)).message).includes('disputeTo'),
                `${noTo.status}`)

              const rr = await json(await call(platform, `/v1/admin/tickets/${dtk.id}/resolve`,
                { outcome: 'resolved', resolution: '影片可見摺痕，判給買家', disputeTo: 'buyer' }))
              check('爭議單結案走的是既有的裁決（訂單變 refunded）',
                rr.effect?.dispute?.orderStatus === 'refunded', JSON.stringify(rr.effect))

              const wAfter = (await json(await call(buyer, '/v1/orders'))).wallet
              check('買家的貨款真的照既有邏輯解凍了',
                wAfter.locked === wBefore.locked - bought.order.price,
                `locked ${wBefore.locked} → ${wAfter.locked}，貨款 ${bought.order.price}`)

              const legacy2 = await json(await call(platform, '/v1/admin/disputes'))
              check('裁決之後既有端點的爭議清單也跟著清掉（同一個事實，不是兩份）',
                !(legacy2.disputes ?? []).some((d: Any) => d.id === oid))
            }
          }
        }
      }

      /* ---- 賣家送審自動開單 ----
         需要一個真的 seller-doc 檔案，而那要 R2 才產得出來 ——
         沒設定就明確跳過，不要假裝驗過（比照上面檔案上傳那一段的作法）。 */
      {
        const docPre = await call(buyer, '/v1/files/presign',
          { purpose: 'seller-doc', mime: 'image/png', bytes: 100 })
        if (docPre.status === 503) {
          check('（跳過賣家送審自動開單：R2 未設定，產不出 seller-doc 檔案）', true)
        } else {
          const { fileId: docId } = await json(docPre)
          const ap = await call(buyer, '/v1/seller/apply',
            { name: '煙霧測試小舖', origin: 'personal', docFileId: docId })
          check('賣家補件成功', ap.ok, `${ap.status}`)
          const sq = await json(await call(platform, '/v1/admin/tickets?kind=seller-doc'))
          const stk = (sq.items ?? [])[0]
          check('送審成功後自動長出一張 seller-doc 單', !!stk, JSON.stringify(sq).slice(0, 200))
          if (stk) {
            const sr = await json(await call(platform, `/v1/admin/tickets/${stk.id}/resolve`,
              { outcome: 'resolved', resolution: '證件清晰，通過' }))
            check('seller-doc 結案呼叫到既有的審核邏輯',
              sr.effect?.verification?.updated === true, JSON.stringify(sr.effect))
            check('既有的 /v1/admin/verifications 仍然讀得到',
              (await call(platform, '/v1/admin/verifications')).ok)
          }
        }
      }
    }

    /* 對帳：全站的點數總量必須等於實際發行量。
       這條是整套設計唯一的驗收標準 —— 對不上就代表有一筆分錄只有單邊。 */
    {
      const rec = await json(await call(platform, '/v1/admin/reconcile'))
      check('全站帳本對得起來（總量 = 發行量，沒有憑空生出或消失的點數）',
        rec.drift === 0,
        `total=${rec.total} issued=${rec.issued} drift=${rec.drift} ` +
        JSON.stringify(rec.byReason))
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

run().catch(e => { console.error('\nsmoke 掛了:', e.message); process.exit(1) })
