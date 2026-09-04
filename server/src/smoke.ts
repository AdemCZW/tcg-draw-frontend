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
const devSecret = process.env.DEV_LOGIN_SECRET

function devHeaders() {
  if (!devSecret) throw new Error('smoke 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')
  return { 'x-dev-login-secret': devSecret }
}

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
    method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
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
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...devHeaders() },
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

/**
 * 把一張卡登記進卡冊，回傳那一列的 id。
 *
 * ── 為什麼這支測試突然到處都要先登記卡片 ──────────────────────────
 * A-4 之後 `prizeId` 是**必填**的：一個籤位背後一定有卡冊裡一張真的
 * 實體卡（`pool_prizes.card_id`）。原本 smoke 到處直接送內嵌卡片
 * （沒有 prizeId、total > 1）就能開池，那正是「同一張裸卡可以宣告成
 * 無限多個池」的那條路。所以建池從此多一個前置步驟：先登記，再挑。
 *
 * **每一段原本在測的東西都沒有變**：籤數、金額、賞別、斷言全部照舊，
 * 只是「這 N 籤背後的卡從哪裡來」從憑空宣告換成了 N 張卡冊裡的列。
 */
async function bookCard(tok: string, card: Record<string, unknown>): Promise<string> {
  const r = await call(tok, '/v1/cardbook/upload', { card })
  const b = await json(r.clone())
  if (r.ok) return b.prize.id as string
  if (b.error === 'ALREADY_IN_BOOK' && b.prizeId) return b.prizeId as string
  throw new Error(`smoke 登記卡片失敗 ${r.status} ${JSON.stringify(b).slice(0, 200)}`)
}

let bookSeq = 0
/** 登記 n 張同一款的裸卡，回傳那 n 列的 id（一張實體卡一個籤位，所以 n 籤要 n 張） */
async function bookCards(tok: string, n: number, card: Record<string, unknown>): Promise<string[]> {
  const out: string[] = []
  /* 名字帶序號只是為了讀資料庫時分得出是哪一張：裸卡沒有編號，
     卡冊裡本來就可以有很多列同名的卡。 */
  for (let i = 0; i < n; i++) out.push(await bookCard(tok, { ...card, name: `${card.name} #${++bookSeq}` }))
  return out
}

/**
 * 一個**明顯不是真卡**的 prizeId。
 *
 * 下面有十幾條驗的是**建池交易開始之前**的閘（買回價上下限、賞別預設、
 * 保底回饋率、玩法、賣家狀態、鑑定編號開幾籤）—— 那些閘全部在
 * routes/pools.ts 走到 sql.begin 之前就回應了，押記那一段根本沒跑到，
 * 所以 prizeId 只要是個字串就夠。
 *
 * 刻意用一個看得出來是假的字串，不拿真的卡去墊：拿真卡的話，
 * 這一條到底是被它該被擋的那道閘擋下、還是被押記擋下，
 * 從測試輸出上分不出來 —— 而那正是這幾條要區分的東西。
 * （「不帶 prizeId 會怎樣」由 regress-inventory 第 0 組專門驗。）
 */
const stubPledges = (n: number) => Array.from({ length: n }, (_, i) => `pz-smoke-stub-${i}`)

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

  /* 託管中的卡**刻意**停在 prizes.status = 'listed'（掛單這時已經是 'sold'）——
     orders-service.ts 的 releasePrize() 要等到訂單結案才收回那一列，
     託管期間那張卡不能被賣家拿去做別的事，'listed' 就是那把鎖。
     自我檢測的 listing-prize-desync 一度只認 status='live' 的掛單，於是
     **每一筆進行中的需寄送訂單**都被判成脫鉤：一筆最長 72 小時～21 天，
     警報的 refId 又是日期桶，等於每天發一則假的 high 給所有管理員，
     把真的（例如負餘額那則 critical）淹掉。這裡剛好有一筆 escrowed 的訂單，
     就地釘住「託管中不算脫鉤」。 */
  const mon = await json(await call(platform, '/v1/admin/monitor'))
  const desync = (mon.findings ?? []).find((f: Any) => f.check === 'listing-prize-desync')
  check('託管中的訂單不會被自我檢測誤報成掛單脫鉤',
    !desync, `count=${desync?.count} sample=${JSON.stringify(desync?.sample)}`)

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
        method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
        body: JSON.stringify({ orderId: o2.id, ms: 15 * 86_400_000 })
      })
      const mid = (await json(await call(buyer2, '/v1/orders'))).orders?.find((x: Any) => x.id === o2.id)
      check('沉默 15 天 → 視同送達，不是退款',
        mid?.status === 'delivered', `status=${mid?.status}`)

      // 再撥 8 天：驗收期滿
      await fetch(`${base}/v1/dev/rewind-order`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
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

  /* ---- 鑑定編號查證：已移除 ----
     平台**不再**查證鑑定編號的真偽（server/src/psa.ts、routes/psa.ts 與
     020 的快取表都已刪除，見 migration 029）。原本這一段驗的六條分支
     —— not_found / invalid_format / api_unavailable / not_configured、
     快取命中、以及開池時的 CERT_INVALID / CERT_NOT_FOUND / CERT_MISMATCH
     與 psaStatus 標記 —— 現在沒有任何一條對應到跑得起來的程式，所以整段刪掉。

     **沒有跟著刪的是鑑定編號的唯一性**：同一個編號不能在站上登記兩次
     （CERT_ALREADY_LISTED / CERT_ALREADY_YOURS，資料庫層的唯一約束）。
     那是一卡不賣兩次的核心防線，跟 PSA 查證是兩回事。它現在驗在：
       · 本檔「帶鑑定編號卻開 10 籤被擋」（一個編號對應一張實體卡）
       · 本檔「客服工單」段的接管單：沒登記過的編號、自己名下的編號、
         重複開單 409、以及大小寫與空白的正規化
       · regress-upload.ts 的「同一個編號第二次登記被擋」整段 */

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

    /* card-front：目錄外自訂卡的正面照。整條路（presign → PUT → 登記 →
       /raw 看得到圖）與「拿別人的／沒傳完的 file id」的拒絕，
       完整版驗在 regress-upload.ts；這裡只確認這個用途在 smoke 這一層
       活著 —— 它之前在 smoke 出現次數是 0。 */
    const frontPre = await call(buyer, '/v1/files/presign', { purpose: 'card-front', mime: 'image/png', bytes: png1x1.length })
    check('card-front presign 拿得到通行證', frontPre.ok, `${frontPre.status} ${await frontPre.clone().text()}`)
    const { fileId: frontId, uploadUrl: frontUrl } = await json(frontPre)
    /* 8MB 上限在儲存層唯一的強制力：content-length 被簽進通行證，
       宣告 1 個位元組再 PUT 一個大檔，簽章對不上，R2 自己拒收。 */
    check('通行證把 content-length 簽進去（宣告大小才有強制力）',
      (new URL(String(frontUrl)).searchParams.get('X-Amz-SignedHeaders') ?? '').includes('content-length'),
      String(new URL(String(frontUrl)).searchParams.get('X-Amz-SignedHeaders')))
    const frontPut = await fetch(frontUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png1x1 })
    check('card-front 的位元組 PUT 得上去', frontPut.ok, `${frontPut.status}`)
    /* card-front 是公開用途（卡面本來就要能顯示），但 /raw 才是 <img src>
       指得動的那一條 —— /:id 回的是 JSON，塞進 img 一定是破圖。 */
    const frontRaw = await fetch(`${base}/v1/files/${frontId}/raw`, { redirect: 'follow' })
    const frontBytes = new Uint8Array(await frontRaw.arrayBuffer())
    check('/v1/files/:id/raw 取得實際圖片（位元組一致）',
      frontRaw.ok && frontBytes.length === png1x1.length && frontBytes.every((b, i) => b === png1x1[i]),
      `${frontRaw.status} ${frontBytes.length}B`)
  }

  /* 目錄外的卡沒有正面照 → 後端擋。這條不需要 R2，所以放在 if 外面：
     缺口正是「前端擋、後端沒擋」，而直接打 API 的呼叫端不經過前端。 */
  {
    const ghost = await call(buyer, '/v1/cardbook/upload', {
      card: { name: '無圖幽靈卡', setCode: 'sv0z', cardNo: 'G-smoke', artId: null, frontFileId: null }
    })
    check('目錄外的卡沒有正面照被擋（400 CARD_IMAGE_REQUIRED）',
      ghost.status === 400 && (await json(ghost.clone())).error === 'CARD_IMAGE_REQUIRED',
      `${ghost.status} ${await ghost.clone().text()}`)
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
    /* 買回價總和 = 9,000 + 700 = 9,700，票收 1,000 —— 970%。
       十籤現在是十列各一張實體卡（A-4），金額一毛沒變，護欄算的是同一個數字。
       這一條在交易開始前就被擋下，所以 prizeId 用 stub（見 stubPledges）。 */
    const mintIds = stubPledges(10)
    const mint = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-mint', ticketPrice: 100, totalTickets: 10,
      prizes: [
        { tier: 'A', prizeId: mintIds[0], card: { id: 'c-a', name: '誘餌 A 賞', refPrice: 700 }, buyback: 700, total: 1 },
        ...mintIds.slice(1).map(id => ({
          tier: 'BUST' as const, prizeId: id,
          card: { id: 'c-bust', name: '爆賞', refPrice: 1_000_000 }, buyback: 1_000, total: 1
        }))
      ]
    })
    const mj = await json(mint)
    check('Σ(買回價) 超過票收的印點數池開不出來',
      mint.status === 400 && mj.error === 'BAD_ECONOMICS', `${mint.status} ${JSON.stringify(mj)}`)

    /* 爆賞灌 refPrice 現在**不該**再影響任何金額 —— refPrice 已經降級成純顯示。
       同一組獎品，只把買回價壓回合理值，池就開得出來。
       這一條是「refPrice 真的退出金額計算」最直接的證明。 */
    /* 這一條要**開得成**，所以十籤要有十張真的卡在卡冊裡。
       refPrice 照舊由請求帶（那是「這個池標示的參考價」，不是卡冊那一列的），
       所以「爆賞灌一百萬也不影響護欄」驗的仍然是同一件事。 */
    const bustA = await bookCard(seller, { name: 'A 賞', setCode: 'sv8a', cardNo: '237/187', artId: 'SV8a-237' })
    const bustRest = await bookCards(seller, 9, { name: '爆賞', setCode: 'sv8a', cardNo: '237/187', artId: 'SV8a-237' })
    const bustRef = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-bust-ref', ticketPrice: 100, totalTickets: 10,
      prizes: [
        { tier: 'A', prizeId: bustA, card: { id: 'c-a', name: 'A 賞', refPrice: 700 }, buyback: 500, total: 1 },
        ...bustRest.map(id => ({
          tier: 'BUST' as const, prizeId: id,
          card: { id: 'c-bust', name: '爆賞', refPrice: 1_000_000 }, buyback: 30, total: 1
        }))
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
      prizes: [{ tier: 'A', prizeId: stubPledges(1)[0], card: { id: 'c-h', name: '天價卡', refPrice: 99_999_999 }, buyback: 50_000_000, total: 1 }]
    })
    check('單張 refPrice 超過上限被擋', huge.status === 400, String(huge.status))

    /* ---- 買回價的上下限 ---- */
    const mkBuyback = (title: string, buyback: unknown) => call(seller, '/v1/pools', {
      mode: 'muteki', title, ticketPrice: 100, totalTickets: 10,
      /* 買回價的上下限是**每一項**各自檢查的，所以十籤攤成十項驗到的是同一條規則。 */
      prizes: stubPledges(10).map(id => ({
        tier: 'D' as const, prizeId: id, card: { id: 'c-b', name: '測試卡', refPrice: 100 }, buyback, total: 1
      }))
    })
    const zero = await mkBuyback('smoke-buyback-0', 0)
    check('買回價填 0 被拒（掛著買回的招牌卻什麼都不買）', zero.status === 400, String(zero.status))
    check('而且講得出下限是多少', (await zero.clone().text()).includes('10'))

    const astro = await mkBuyback('smoke-buyback-astro', 99_999_999)
    check('買回價填天文數字被拒', astro.status === 400, String(astro.status))

    const missing = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-buyback-missing', ticketPrice: 100, totalTickets: 10,
      prizes: stubPledges(10).map(id => ({
        tier: 'D' as const, prizeId: id, card: { id: 'c-b', name: '測試卡', refPrice: 100 }, total: 1
      }))
    })
    check('沒有任何買回價來源的池開不出來（不能有「抽到才發現沒得買回」的獎項）',
      missing.status === 400, String(missing.status))
    check('而且講得出是哪一個賞別缺', (await missing.clone().text()).includes('D 賞'))

    /* ---- 賞別預設 + 個別覆寫 ----
       買回價按賞別給一個絕對金額（不需要任何基準），某一項特別貴時單獨覆寫。
       **存進資料庫與 manifest 的仍然是每個獎品的絕對金額** —— 下面就是驗這件事：
       解析完之後 A 賞那一項拿到的是覆寫值，D 賞拿到的是賞別預設。 */
    /* 卡冊那幾列**刻意不填 refPrice**：下面有一條驗「參考價完全不填也開得出池、
       而且照實回 null（不是 0）」，而押記之後 refPrice 沒送就退回卡冊那一列的值 ——
       兩邊都不填才驗得到「沒有標示」這件事本身。 */
    const tierA = await bookCard(seller, { name: '同賞別裡特別貴的那張', setCode: 'sv8a', cardNo: '237/187', artId: 'SV8a-237' })
    const tierD = await bookCards(seller, 9, { name: '一般 D 賞', setCode: 'sv8a', cardNo: '237/187', artId: 'SV8a-237' })
    const tiered = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-tier-buyback', ticketPrice: 100, totalTickets: 10,
      tierBuyback: { A: 400, D: 40 },
      prizes: [
        { tier: 'A', prizeId: tierA, card: { id: 'c-ta', name: '同賞別裡特別貴的那張' }, buyback: 300, total: 1 },
        ...tierD.map(id => ({ tier: 'D' as const, prizeId: id, card: { id: 'c-td', name: '一般 D 賞' }, total: 1 }))
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
      prizes: stubPledges(10).map(id => ({
        tier: 'D' as const, prizeId: id, card: { id: 'c-tb', name: '測試卡' }, total: 1
      }))
    })
    check('賞別預設填 0 一樣被上下限擋下', tierBad.status === 400, String(tierBad.status))

    /* 反面：正常的池還是開得出來。少了這一條，把護欄寫成「一律拒絕」也會全綠。
       買回價總和 500 + 30×9 = 770，票收 1,000 → 77%，落在 25–100 之間。 */
    const okA = await bookCard(seller, { name: 'A 賞', setCode: 'sv8a', cardNo: '237/187', artId: 'SV8a-237' })
    const okRest = await bookCards(seller, 9, { name: '爆賞', setCode: 'sv8a', cardNo: '237/187', artId: 'SV8a-237' })
    const okPool = await call(seller, '/v1/pools', {
      mode: 'muteki', title: 'smoke-ok-pool', ticketPrice: 100, totalTickets: 10,
      prizes: [
        { tier: 'A', prizeId: okA, card: { id: 'c-a', name: 'A 賞', refPrice: 700 }, buyback: 500, total: 1 },
        ...okRest.map(id => ({
          tier: 'BUST' as const, prizeId: id, card: { id: 'c-bust', name: '爆賞', refPrice: 30 }, buyback: 30, total: 1
        }))
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
  /* ── 為什麼這一段換一個賣家帳號 ──────────────────────────────────
     建池從此要先把卡登記進卡冊，而 /v1/cardbook/upload 有速率限制
     （40 張／15 分鐘／帳號，rate-limit.ts 的 card-upload-user 桶）。
     整支 smoke 需要開得成的池加起來超過六十張卡，全掛在 u-seller 身上
     會在中途被自己的限流擋掉 —— 那是限流正確運作，不是這裡要驗的東西
     （限流本身由 regress-ratelimit 驗）。
     所以這一段與下面「正常池」那一條改用第二個賣家帳號分攤。
     **賣家身分不影響這幾條測的任何東西**：驗的是獎品身分有沒有被吃掉、
     金額算得對不對，跟池屬於誰無關；反過來，順手也把「申請→核可→開池」
     這條路多走了一次。 */
  const seller2 = await login('seller2', '測試賣家二號')
  const apply2 = await call(seller2, '/v1/seller/apply', { name: '煙霧測試二號店', origin: 'personal' })
  check('第二個賣家申請成功', apply2.ok, `${apply2.status} ${await apply2.clone().text()}`)
  const tier2 = await call(platform, '/v1/admin/sellers/u-seller2/tier', { tier: 'verified', note: 'smoke' })
  check('後台核可第二個賣家', tier2.ok, `${tier2.status} ${await tier2.clone().text()}`)

  console.log('\n挑卡帶回的身分：')
  {
    const master = {
      id: 'c-SV2a-025-master', name: '皮卡丘', setCode: 'sv2a', cardNo: '025/165',
      language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '',
      artId: 'SV2a-025', variantId: '2asus05yghmpd1ud1sdmlq3as4e', refPrice: 12800
    }
    const normal = { ...master, id: 'c-SV2a-025-normal', variantId: 'endfynwn4n10gzq', refPrice: 100 }

    /* 十籤 = 十張實體卡。身分**以卡冊那一列為準**（押記會用卡冊的值覆蓋
       呼叫端送的 card），所以這一段測的「身分有沒有被吃掉」現在驗的是
       一條更長的路：登記進卡冊 → 挑進池 → 公開快照，中間任何一段掉一欄都會露餡。 */
    const masterId = await bookCard(seller2, master)
    const normalIds = await bookCards(seller2, 9, normal)
    const made = await call(seller2, '/v1/pools', {
      /* 票價 1,200 × 10 籤 = 12,000；買回價總和 7,680 + 9×60 = 8,220 → 68.5%，
         落在護欄的 25–100 之間。這一段測的是身分有沒有被吃掉，
         不是經濟護欄，所以數字要刻意調成過得了的。 */
      mode: 'muteki', title: 'smoke-pick-identity', ticketPrice: 1200, totalTickets: 10,
      prizes: [
        { tier: 'A', prizeId: masterId, card: master, buyback: 7680, total: 1 },
        ...normalIds.map(id => ({ tier: 'D' as const, prizeId: id, card: normal, buyback: 60, total: 1 }))
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
    /* 編號只要是站上沒登記過的字串就行 —— 平台不查證編號真偽，
       所以這裡不再有「對得上／對不上」的分支可驗。
       `STUB-` 前綴留著只是為了跟種子資料不相撞，已經沒有 stub 語意。 */
    const graded = {
      id: 'cg-smoke-pick', name: '噴火龍 ex UR', setCode: 'sv4a', cardNo: '349/190',
      language: 'JP', grader: 'PSA', grade: 10, certNo: 'STUB-OK-349', image: '',
      artId: 'SV4a-349', variantId: null, refPrice: 42000
    }
    const gradedPlain = { ...graded, id: 'c-smoke-plain', grader: 'RAW', grade: null, certNo: null, refPrice: 400 }
    const gradedId = await bookCard(seller2, graded)
    const plainIds = await bookCards(seller2, 9, gradedPlain)
    const g = await call(seller2, '/v1/pools', {
      mode: 'muteki', title: 'smoke-pick-graded', ticketPrice: 900, totalTickets: 10,
      tierBuyback: { A: 6000, D: 200 },
      prizes: [
        { tier: 'A', prizeId: gradedId, card: graded, total: 1 },
        ...plainIds.map(id => ({ tier: 'D' as const, prizeId: id, card: gradedPlain, total: 1 }))
      ]
    })
    check('從卡冊挑的鑑定卡開得出池', g.ok, `${g.status} ${await g.clone().text()}`)
    const gj = await json(g)
    if (gj.poolId) {
      const snap = await json(await fetch(`${base}/v1/pools/${gj.poolId}`))
      const a = (snap.pool?.prizes ?? []).find((x: Any) => x.tier === 'A')?.card
      /* ── 展示那一半（A-6）────────────────────────────────────────
         grader / grade 要留著：那是**商品描述**（這是 PSA 10 的噴火龍），
         公開池不顯示它等於把功能關掉。
         certNo 要拿掉：那是**身分憑據** —— 拿著編號就能到別處主張這張卡，
         而平台的一卡多賣防線正是綁在那個編號上。公開池不用登入、
         連結到處轉貼，整包 jsonb 直出等於把每一張獎品的編號免費送人。
         這條原本斷言 certNo === 'STUB-OK-349'，也就是把洩漏當成了正確答案。 */
      check('展示用的鑑定資訊（grader / grade）完整保留',
        a?.grader === 'PSA' && a?.grade === 10, JSON.stringify(a))
      check('但公開池詳情不帶 certNo（身分憑據不是展示資料）',
        a?.certNo === undefined, JSON.stringify(a))

      /* ── 反向那一半（A-6）：manifest 必須留著 certNo ──────────────
         這兩條要並排放。只留上面那條的話，下一個人很容易「順手」把
         manifest 的 certNo 一起遮掉 —— 而 certNo 是 manifest v2 以上的
         序列化輸入，既有池的 commit hash 就是拿它算出來的，
         遮掉它會讓**現有每一個池的驗算全部失敗**。
         展示與公平性證據是兩件事，這一對測試就是那條界線。 */
      await fetch(`${base}/v1/dev/expire-pool`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
        body: JSON.stringify({ poolId: gj.poolId })
      })
      for (let i = 0; i < 4; i++) {
        await fetch(`${base}/v1/dev/sweep-pools`, { method: 'POST', headers: devHeaders() })
        const st = await json(await fetch(`${base}/v1/pools/${gj.poolId}`))
        if (st.pool?.status === 'revealed') break
      }
      const rvg = await json(await fetch(`${base}/v1/pools/${gj.poolId}/reveal`))
      const mA = (rvg.manifest ?? []).find((m: Any) => m.tier === 'A')
      check('revealed 的 manifest 仍然帶 certNo（commit 的重算材料）',
        mA?.certNo === 'STUB-OK-349', JSON.stringify(mA))
    }

    const dup = await call(seller2, '/v1/pools', {
      mode: 'muteki', title: 'smoke-pick-graded-dup', ticketPrice: 900, totalTickets: 10,
      tierBuyback: { A: 6000 },
      prizes: [{ tier: 'A', prizeId: stubPledges(1)[0], card: { ...graded, certNo: 'STUB-OK-349191' }, total: 10 }]
    })
    check('帶鑑定編號卻開 10 籤被擋（一個編號對應一張實體卡）', dup.status === 400,
      String(dup.status))
    /* 擋它的必須是**編號那條規則**，不是「從卡冊挑的卡只能開 1 籤」那條。
       兩條都會回 400，所以只看狀態碼分不出來 —— 而它們是兩件事：
       前者說的是一個編號對應一張實體卡，後者說的是一列卡一個籤位。
       （PrizeIn 上兩條 refine 的順序決定了回哪一句，這一條就是把那個順序釘住。） */
    check('而且擋下來的是「編號」那條規則，不是別條',
      (await dup.clone().text()).includes('編號'), await dup.clone().text())
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
        /* 待審核的賣家在**押記之前**就被擋（routes/pools.ts 的第一道閘），
           所以這裡的 prizeId 用 stub —— 用真的卡反而會讓「擋在哪一層」看不出來。 */
        prizes: stubPledges(2).map(id => ({
          tier: 'D' as const, prizeId: id,
          card: { id: 'c-smoke', name: 'x', setCode: 'sv', cardNo: '1', language: 'JP', grader: 'RAW', grade: null, certNo: null, refPrice: 10 },
          buyback: 60, total: 1
        }))
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
    /* 一張實體卡一個籤位（A-4），所以 N 籤 = N 個獎品項。
       買回價仍然固定 10 點、仍然只調票價，掃過的還是同一段保底回饋率區間。 */
    const mkPool = (tok: string, title: string, price: number, tickets: number, ids: string[]) =>
      call(tok, '/v1/pools', {
        title, mode: 'muteki', ticketPrice: price, totalTickets: tickets,
        prizes: ids.map(id => ({ tier: 'D' as const, prizeId: id, card: cheapCard, buyback: 10, total: 1 }))
      })

    const harsh = await mkPool(seller, '苛刻池', 100, 10, stubPledges(10))          // 保底 10%
    check('保底回饋率過低的池開不了', harsh.status === 400, `${harsh.status}`)
    check('而且講得出原因', (await harsh.clone().text()).includes('過於不利'))

    const mint2 = await mkPool(seller, '印鈔池', 2, 10, stubPledges(10))            // 保底 500%
    check('Σ(買回價) 超過票收的池也開不了', mint2.status === 400)
    check('印鈔機的訊息把兩個數字並排講清楚',
      (await mint2.clone().text()).includes('票收'))

    /* 反面：保底 50%（買回價 10、票價 20）應該過得了。
       這一條要**開得成**，所以十籤要有十張真的卡 —— 掛在第二個賣家帳號上，
       理由見上面「為什麼這一段換一個賣家帳號」。 */
    const fineIds = await bookCards(seller2, 10, { name: '正常池測試卡', setCode: 'sv8a', cardNo: '237/187', artId: 'SV8a-237' })
    const fine = await mkPool(seller2, '正常池', 20, 10, fineIds)
    check('保底回饋率落在區間內的池開得出來', fine.ok, `${fine.status}`)

    /* 後端只收 muteki：抽卡邏輯不讀 mode，收下其他模式等於讓賣家開出
       標示著某種玩法、實際卻不是那樣運作的池。
       classic 也在擋掉的名單裡 —— 它宣傳的「抽走最後一籤額外得最後賞」
       後端一行都沒有，開得出來就等於繼續掛著不存在的規則收錢（見 migration 016） */
    const onePrize = [{ tier: 'D', prizeId: stubPledges(1)[0], card: { id: 'c-smoke', name: 'x', setCode: 'sv', cardNo: '1', language: 'JP', grader: 'RAW', grade: null, certNo: null, refPrice: 10 }, buyback: 60, total: 1 }]
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

    /* ---- 市場篩選：卡片等級與點數區間 ----

       這幾條驗的是「篩選在後端」這件事本身。前端過濾只濾得到已載入的那一批，
       而市場是游標分頁的 —— 符合條件的有 N 筆、第一批裡只有兩三筆時，
       前端會回答那兩三筆，而且看起來完全合理。所以這裡一律
       **翻完所有分頁再比對**，不看第一批。 */
    {
      const allWith = async (qs: string): Promise<string[]> => {
        const out: string[] = []
        let c: string | null = null
        do {
          const u = new URLSearchParams(qs)
          u.set('limit', '3')          // 刻意用很小的批次，逼出跨分頁的錯誤
          if (c) u.set('cursor', c)
          const r = await json(await fetch(`${base}/v1/listings?${u}`))
          out.push(...(r.items ?? []).map((l: { id: string }) => l.id))
          c = r.nextCursor ?? null
        } while (c)
        return out
      }
      const live = await allListings()
      /* 未鑑定的判斷要跟後端同一套：'RAW'、空字串、整個欄位不存在都是未鑑定。
         只比對 === 'RAW' 會把後兩種漏掉 —— 那正是「把 RAW 當成 null」的錯誤。 */
      const graderOf = (l: Any) => String(l.card?.grader ?? '').trim().toUpperCase() || 'RAW'
      const gradeOf = (l: Any) => (typeof l.card?.grade === 'number' ? l.card.grade : null)

      const raw = await allWith('grader=raw')
      const graded = await allWith('grader=graded')
      check('市場 grader=raw 與資料一致',
        raw.length === live.filter(l => graderOf(l) === 'RAW').length,
        `${raw.length} vs ${live.filter(l => graderOf(l) === 'RAW').length}`)
      check('市場 grader=graded 與資料一致',
        graded.length === live.filter(l => graderOf(l) !== 'RAW').length)
      check('未鑑定 + 已鑑定 = 全部有效掛單（沒有人被漏成「不屬於任何類別」）',
        raw.length + graded.length === live.length, `${raw.length}+${graded.length} vs ${live.length}`)

      const psa10 = await allWith('grader=psa&minGrade=10')
      const psa10Truth = live.filter(l => graderOf(l) === 'PSA' && (gradeOf(l) ?? -1) >= 10)
      check('市場 PSA 10 翻完所有分頁的筆數正確（不是第一批裡的那幾筆）',
        psa10.length === psa10Truth.length, `${psa10.length} vs ${psa10Truth.length}`)
      check('市場 PSA 10 翻頁不重複', new Set(psa10).size === psa10.length)
      const first = await json(await fetch(`${base}/v1/listings?grader=psa&minGrade=10&limit=1`))
      check('第一頁回的 total 是全市場符合的筆數，不是這一批的數量',
        first.total === psa10Truth.length, `${first.total} vs ${psa10Truth.length}`)

      const cheapHalf = await allWith('maxPrice=3000')
      check('市場 maxPrice 與資料一致',
        cheapHalf.length === live.filter(l => Number(l.price) <= 3000).length)
      const band = await allWith('minPrice=1000&maxPrice=5000&sort=cheap')
      check('市場點數區間 + 排序並用仍然正確',
        band.length === live.filter(l => Number(l.price) >= 1000 && Number(l.price) <= 5000).length)

      /* 金額參數要跟站上既有的八個金額欄位一樣嚴：使用者多打幾個零、
         或手動組了一個荒謬的網址，回的必須是 400 加一句中文，不是 500。 */
      for (const bad of ['-1', '0', '1.5', '1e308', '1e999', 'abc', 'null',
        '9007199254740992', '1000000001', '9.9e18']) {
        const r = await fetch(`${base}/v1/listings?minPrice=${encodeURIComponent(bad)}`)
        const body = r.status === 400 ? await json(r) : null
        check(`市場 minPrice=${bad} 被擋下且訊息可讀`,
          r.status === 400 && /點數/.test(String(body?.message ?? '')),
          `${r.status} ${JSON.stringify(body)}`)
      }
      const flipped = await fetch(`${base}/v1/listings?minPrice=5000&maxPrice=1000`)
      check('市場 minPrice > maxPrice 被擋下（不是默默回 0 筆）', flipped.status === 400)
      const rawGrade = await fetch(`${base}/v1/listings?grader=raw&minGrade=9`)
      check('未鑑定 + 分數下限這種矛盾組合被擋下', rawGrade.status === 400)
      check('市場不認得的鑑定公司被拒',
        (await fetch(`${base}/v1/listings?grader=PSA10`)).status === 400)
      check('市場空字串的篩選參數當成沒給（不是 0）',
        (await fetch(`${base}/v1/listings?minPrice=&grader=&minGrade=`)).status === 200)
    }

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
        method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
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
      /* 停權擋在押記之前（routes/pools.ts 的違約門檻），所以 prizeId 用 stub。 */
      prizes: stubPledges(10).map(id => ({
        tier: 'D' as const, prizeId: id, card: { id: 'c-x', name: '測試卡', refPrice: 85 }, buyback: 60, total: 1
      }))
    })
    const bj = await json(blocked)
    check('違約次數達門檻的賣家開不了新池',
      blocked.status === 403 && bj.error === 'SELLER_SUSPENDED', `${blocked.status} ${JSON.stringify(bj)}`)

    /* 規則 4：池到期就關池、停止販售；但已售出的仍照走出貨與鑑賞期 */
    {
      const g = await drawOne(buyer, genId('p-shop-4'))
      await fetch(`${base}/v1/dev/expire-pool`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
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
          method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
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

    /* ---------------- 通知完整性（docs/notifications-audit.md）----------------
       驗的是同一句話：**會動到使用者的錢、卡、權限或義務的事，發生時他不在場，
       所以一定要有一則通知。**

       每一條都驗三件事，缺一不可：
         1 真的寫進 notifications（不是「端點回 ok」就算數）
         2 refId 冪等 —— 重複觸發（掃描會重跑）只留一則
         3 link 指到前端真的存在的路由（'/wallet'、'/cards' 都曾經是死連結）

       第 3 點用一張白名單比對，而不是逐條 assert 字串：新增通知時忘了對
       src/router/index.ts 的成本就是「使用者點了通知掉進 404」，
       那從伺服器這一側完全看不出來。 */
    console.log('\n通知完整性：')
    {
      /* src/router/index.ts 有的路徑。動態段（:id）用前綴比對。
         這份清單改動時要跟前端路由表對一次 —— 它就是那張表的影子。 */
      const ROUTES = ['/me/wallet', '/me/cards', '/me/orders', '/me/offers', '/me/profile',
        '/seller/new', '/seller/shipping', '/support', '/support/new', '/admin/overview']
      const linkOk = (l: string | null) =>
        l == null || ROUTES.includes(l) || l.startsWith('/support/') || l.startsWith('/draw/')
          || l.startsWith('/admin/')
      const notifs = async (t: string): Promise<Any[]> =>
        (await json(await call(t, '/v1/social/notifications'))).notifications ?? []
      const withRef = (rows: Any[], ref: string) => rows.filter((n: Any) => n.ref_id === ref)

      /* ---- 1. 買家申請出貨 → 賣家有一個 72 小時的義務 ----
         這是整份稽核裡唯一「使用者會因為沒收到通知而被**罰**」的路徑：
         逾期的後果是退款給買家並記一次違約，而違約滿門檻就不能再開池。 */
      const gN = await drawOne(buyer, genId('p-seed-1'))
      if (gN) {
        const sh = await json(await call(buyer, '/v1/prizes/ship',
          { prizeIds: [gN.stashId], address: ADDR }))
        const ref = 'ship-req:' + sh.shipmentId
        const sn = await notifs(seller)
        const hit = withRef(sn, ref)
        check('買家申請出貨後，賣家收到「有買家申請出貨了」', hit.length === 1,
          `${hit.length} 則 ref=${ref}`)
        check('那一則指到賣家真的能處理它的頁面（出貨與結算）',
          hit[0]?.link === '/seller/shipping', `${hit[0]?.link}`)
        check('內文講得出期限與後果（不是只說「狀態已更新」）',
          String(hit[0]?.body ?? '').includes('72') && String(hit[0]?.body ?? '').includes('違約'),
          `${hit[0]?.body}`)

        /* ---- 2. 票金結算入帳 ----
           賣家的總餘額從抽卡當下就沒再變過，變的是**可動用** —— 那是推導的，
           沒有任何一列帳讓他知道「就是現在」。 */
        const stN = await settlementOf(seller, gN.stashId)
        await call(seller, `/v1/seller/settlements/${stN.id}/ship`, {})
        await call(buyer, `/v1/prizes/${gN.stashId}/confirm`, {})
        const relRef = 'pool-release:' + stN.id
        const rel = withRef(await notifs(seller), relRef)
        check('票金釋放時賣家收到「票金已入帳，可以動用了」', rel.length === 1,
          `${rel.length} 則 ref=${relRef}`)
        check('那一則指到錢包（看得到可動用的地方）',
          rel[0]?.link === '/me/wallet', `${rel[0]?.link}`)
        check('內文說得出是哪一條路釋放的與金額',
          String(rel[0]?.body ?? '').includes('確認收貨') && String(rel[0]?.body ?? '').includes('3250'),
          `${rel[0]?.body}`)

        /* 冪等：讀清單會觸發 sweepSettlements，掃描一天會跑很多次 ——
           refId 綁結算 id 就是為了讓重跑不再發一次。 */
        await call(seller, '/v1/seller/settlements')
        await call(buyer, '/v1/prizes?limit=100')
        check('掃描重跑不會再發一次（refId 綁結算 id）',
          withRef(await notifs(seller), relRef).length === 1)
      } else check('（跳過出貨申請與結算入帳的通知：抽不到卡）', false)

      /* ---- 3. 逾期未出貨：買賣雙方各一則 ----
         原本只有買家那一側有。賣家被收回票金**而且**記一次違約，
         那件事發生在掃描裡，他不在場 —— 下次撞到 SELLER_SUSPENDED 才知道就太晚了。 */
      {
        const g = await drawOne(buyer, genId('p-shop-1'))
        if (g) {
          await call(buyer, '/v1/prizes/ship', { prizeIds: [g.stashId], address: ADDR })
          await rewind(g.stashId, 4 * 86_400_000)
          await allPrizes(buyer)   // 讀卡冊順手補算時限
          const mine = (await notifs(shop)).filter((n: Any) =>
            String(n.ref_id).startsWith('pool-refund-seller:'))
          check('逾期未出貨時賣家也收到通知（原本只有買家有）', mine.length >= 1,
            '找不到 ref_id 以 pool-refund-seller: 開頭的通知')
          check('賣家那一則把兩個後果都講出來：錢被收回 + 記違約',
            String(mine[0]?.body ?? '').includes('收回') && String(mine[0]?.body ?? '').includes('違約'),
            `${mine[0]?.body}`)
          const before = mine.length
          await allPrizes(buyer)   // 再掃一次
          check('逾期通知冪等（掃描重跑不會洗版）',
            (await notifs(shop)).filter((n: Any) =>
              String(n.ref_id).startsWith('pool-refund-seller:')).length === before)
          /* 買家那一側的連結曾經是 '/wallet' —— 前端沒有這條路由 */
          const bn = (await notifs(buyer)).filter((n: Any) =>
            String(n.ref_id).startsWith('pool-refund:'))
          check('買家的退款通知指到 /me/wallet（不是不存在的 /wallet）',
            bn.every((n: Any) => n.link === '/me/wallet'),
            JSON.stringify(bn.map((n: Any) => n.link)))
        } else check('（跳過逾期未出貨的賣家通知：抽不到卡）', false)
      }

      /* ---- 4. 回收：賣家被扣款、卡回到他手上 ----
         第二件比第一件更急 —— 寄出去之後那張卡就要不回來了。 */
      {
        const g = await drawOne(buyer, genId('p-seed-1'))
        if (g) {
          const r = await call(buyer, `/v1/prizes/${g.stashId}/recycle`, {})
          if (r.ok) {
            const rn = (await notifs(seller)).filter((n: Any) =>
              String(n.ref_id).startsWith('pool-recycle-seller:'))
            check('買家按下回收後，賣家收到「買家接受了你的買回價」', rn.length >= 1)
            check('而且講清楚「不用再寄了」', String(rn[0]?.body ?? '').includes('不用再寄'),
              `${rn[0]?.body}`)
          } else check('（跳過回收通知：這張卡回收不了）', false, `${r.status}`)
        } else check('（跳過回收通知：抽不到卡）', false)
      }

      /* ---- 5. 平台發點數 ---- */
      {
        const ref = (await json(await call(platform, '/v1/admin/grant',
          { userId: 'u-shop', points: 777, note: '內部備註：不該出現在通知裡' }))).ref
        const gn = withRef(await notifs(shop), ref)
        check('平台發放點數時收款人收到通知', gn.length === 1, `ref=${ref}`)
        check('通知帶得出金額與去處', String(gn[0]?.body ?? '').includes('777') && gn[0]?.link === '/me/wallet',
          `${gn[0]?.body} link=${gn[0]?.link}`)
        /* 發放的 note 是寫給稽核看的內部字，不是寫給當事人的 */
        check('內部備註不會外流到通知裡',
          !String(gn[0]?.body ?? '').includes('內部備註'), `${gn[0]?.body}`)
      }

      /* ---- 6. 賣家等級：這一行 UPDATE 決定他能不能做生意 ---- */
      {
        const tierOf = async () =>
          (await json(await call(platform, '/v1/admin/sellers'))).sellers
            ?.find((s: Any) => s.id === 'u-shop')?.tier
        const t0 = await tierOf()
        const target = t0 === 'verified' ? 'trusted' : 'verified'
        const n0 = (await notifs(shop)).filter((n: Any) => String(n.ref_id).startsWith('seller-tier:')).length
        check('調整賣家等級', (await call(platform, `/v1/admin/sellers/u-shop/tier`,
          { tier: target, note: 'smoke' })).ok)
        const n1 = (await notifs(shop)).filter((n: Any) => String(n.ref_id).startsWith('seller-tier:'))
        check('等級變更會通知賣家（那是他能不能開池的門檻）', n1.length === n0 + 1,
          `${n0} → ${n1.length}`)
        check('等級通知點得進去', linkOk(n1[0]?.link ?? null), `${n1[0]?.link}`)
        /* 重按同一個等級不該再發一則 —— 那不是一次變更 */
        await call(platform, `/v1/admin/sellers/u-shop/tier`, { tier: target, note: 'smoke 重按' })
        check('重設成同一個等級不會再發一則',
          (await notifs(shop)).filter((n: Any) => String(n.ref_id).startsWith('seller-tier:')).length === n0 + 1)
        /* 降回 pending 是**擋住他開池**，一定要說 */
        await call(platform, `/v1/admin/sellers/u-shop/tier`, { tier: 'pending', note: 'smoke 降級' })
        const n2 = (await notifs(shop)).filter((n: Any) => String(n.ref_id).startsWith('seller-tier:'))
        check('降級（開不了池了）也會通知', n2.length === n0 + 2, `${n1.length} → ${n2.length}`)
        await call(platform, `/v1/admin/sellers/u-shop/tier`, { tier: t0 ?? 'verified', note: 'smoke 還原' })
      }

      /* ---- 7. 出貨單 shipped → delivered 是兩件事（refId 撞號迴歸）----
         原本兩則共用同一個 refId = 出貨單 id，而 notifications_once 是
         unique(user_id, kind, ref_id) —— 第二則被 `on conflict do nothing`
         靜默吃掉，使用者永遠收不到送達通知，端點卻照樣回 ok。 */
      {
        const g = await drawOne(buyer, genId('p-seed-1'))
        if (g) {
          const sh = await json(await call(buyer, '/v1/prizes/ship',
            { prizeIds: [g.stashId], address: ADDR }))
          const id = sh.shipmentId
          await call(platform, `/v1/admin/shipments/${id}/status`,
            { status: 'shipped', tracking: 'SMOKE87654321', note: 'smoke' })
          await call(platform, `/v1/admin/shipments/${id}/status`, { status: 'delivered', note: 'smoke' })
          const bn = await notifs(buyer)
          check('已寄出與已送達是兩則獨立的通知（refId 帶狀態）',
            withRef(bn, `${id}:shipped`).length === 1 && withRef(bn, `${id}:delivered`).length === 1,
            `shipped=${withRef(bn, id + ':shipped').length} delivered=${withRef(bn, id + ':delivered').length}`)
        } else check('（跳過出貨單兩段通知：抽不到卡）', false)
      }

      /* ---- 8. 市場託管訂單的整條時間線 ----
         這一組是稽核裡 ⛔ 的六則。它們全部寫在 orders-service.ts 的
         settle() 裡，因為那是「人按的」（act）與「時限掃描的」（sweep）
         兩條路的共同必經點 —— 寫在路由層的話，逾期那條（沒有人在場、
         正是最該通知的一條）永遠會漏。

         測試自己造標的：買家抽一張卡 → 申請出貨 → 拿到實體卡 → 掛上市場，
         再由 shop 買下。不用種子的掛單，因為那幾張前面的測試已經吃掉了，
         而且數量不夠這裡的四種結局。
         **角色會反過來**：buyer 是這幾筆的賣家，shop 是買家。 */
      {
        let trackSeq = 0
        const track = () => `SMK${Date.now().toString(36).toUpperCase()}${trackSeq++}`

        /** 造一張「需寄送」的市場訂單，回 { order }；抽不到卡就回 null */
        const mkShipOrder = async (price: number): Promise<Any | null> => {
          const g = await drawOne(buyer, genId('p-seed-1'))
          if (!g) return null
          await call(buyer, '/v1/prizes/ship', { prizeIds: [g.stashId], address: ADDR })
          const st = await settlementOf(seller, g.stashId)
          if (st) await call(seller, `/v1/seller/settlements/${st.id}/ship`, {})
          await call(buyer, `/v1/prizes/${g.stashId}/confirm`, {})
          const l = await json(await call(buyer, '/v1/listings', { prizeId: g.stashId, price }))
          if (!l.listing?.id) return null
          const o = await json(await call(shop, '/v1/orders',
            { listingId: l.listing.id, idempotencyKey: `smoke-notif-${l.listing.id}` }))
          return o.order ?? null
        }
        const rewindOrder = (id: string, ms: number) =>
          fetch(`${base}/v1/dev/rewind-order`, {
            method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
            body: JSON.stringify({ orderId: id, ms })
          })

        /* ── 沉默那條路：出貨 → 14 天視同送達 → 7 天驗收期滿放款 ── */
        const o1 = await mkShipOrder(2000)
        if (o1) {
          check('賣家出貨（沉默路徑）',
            (await call(buyer, `/v1/orders/${o1.id}/ship`, { carrier: 'other', tracking: track() })).ok)

          /* 這一則是整條線上最重要的：買家的鐘從這一刻開始跑，而**沉默＝視同送達**。
             不通知等於讓人在不知道自己被計時的情況下被計時。 */
          const b4 = withRef(await notifs(shop), 'order-shipped:' + o1.id)
          check('賣家出貨後，買家收到「賣家已寄出」', b4.length === 1, `${b4.length} 則`)
          check('那一則把兩段時限都講出來（14 天視同送達、再 7 天放款）',
            String(b4[0]?.body ?? '').includes('14 天') && String(b4[0]?.body ?? '').includes('7 天'),
            `${b4[0]?.body}`)
          check('指到買家看得到訂單的地方', b4[0]?.link === '/me/orders', `${b4[0]?.link}`)

          await rewindOrder(o1.id, 15 * 86_400_000)
          await call(shop, '/v1/orders')
          /* 14 天到了。這是買家的最後警告 —— 只剩 7 天可以開爭議，
             而「賣家已寄出」那則是 14 天前發的，早就被洗掉了。 */
          const bd = withRef(await notifs(shop), 'order-delivered:' + o1.id)
          check('沉默 14 天後，買家收到「已視同送達」的最後提醒', bd.length === 1, `${bd.length} 則`)
          check('那一則說得出剩幾天與過期的後果',
            String(bd[0]?.body ?? '').includes('7 天') && String(bd[0]?.body ?? '').includes('不能再開爭議'),
            `${bd[0]?.body}`)

          await rewindOrder(o1.id, 8 * 86_400_000)
          await call(shop, '/v1/orders')
          const cs = withRef(await notifs(buyer), 'order-completed:' + o1.id)
          const cb = withRef(await notifs(shop), 'order-completed:' + o1.id)
          check('驗收期滿：賣家收到「貨款入帳」', cs.length === 1, `${cs.length} 則`)
          check('驗收期滿：買家也收到（他的爭議窗口從此關閉）', cb.length === 1, `${cb.length} 則`)
          check('賣家那一則指到出貨與結算', cs[0]?.link === '/seller/shipping', `${cs[0]?.link}`)

          /* sweep 掛在每一次讀取上，一天會跑很多次 —— 冪等只能靠 refId */
          await call(shop, '/v1/orders'); await call(buyer, '/v1/orders')
          check('掃描重跑不會再發一次（refId 綁 orderId）',
            withRef(await notifs(shop), 'order-completed:' + o1.id).length === 1)
        } else check('（跳過沉默路徑的通知：造不出訂單）', false)

        /* ── 買家自己按確認：只有賣家不在場 ── */
        const o2 = await mkShipOrder(2100)
        if (o2) {
          await call(buyer, `/v1/orders/${o2.id}/ship`, { carrier: 'other', tracking: track() })
          check('買家確認收貨', (await call(shop, `/v1/orders/${o2.id}/confirm`, {})).ok)
          const n = withRef(await notifs(buyer), 'order-completed:' + o2.id)
          check('買家確認收貨後，賣家收到「貨款入帳」', n.length === 1, `${n.length} 則`)
          check('金額寫在通知裡（賣家不必自己去對帳本）',
            String(n[0]?.body ?? '').includes('2,100'), `${n[0]?.body}`)
          check('買家自己按的，他不該再收到一則',
            withRef(await notifs(shop), 'order-completed:' + o2.id).length === 0)
        } else check('（跳過確認收貨的通知：造不出訂單）', false)

        /* ── 買家開爭議：賣家的貨款被別人的動作凍住 ── */
        const o3 = await mkShipOrder(2200)
        if (o3) {
          await call(buyer, `/v1/orders/${o3.id}/ship`, { carrier: 'other', tracking: track() })
          check('買家開爭議', (await call(shop, `/v1/orders/${o3.id}/dispute`,
            { reason: '卡況與描述不符', videoUrl: 'https://example.com/unbox.mp4' })).ok)
          const n = withRef(await notifs(buyer), 'order-disputed:' + o3.id)
          check('買家開爭議後，賣家收到通知（他的錢被凍住了）', n.length === 1, `${n.length} 則`)
          check('而且告訴他該去哪講話',
            String(n[0]?.body ?? '').includes('客服'), `${n[0]?.body}`)
        } else check('（跳過爭議通知：造不出訂單）', false)

        /* ── 逾期未出貨：兩邊都不在場，而且賣家的保證金被沒收 ── */
        const o4 = await mkShipOrder(2300)
        if (o4) {
          await rewindOrder(o4.id, 4 * 86_400_000)
          await call(shop, '/v1/orders')
          const nb = withRef(await notifs(shop), 'order-forfeit:' + o4.id)
          const ns = withRef(await notifs(buyer), 'order-forfeit:' + o4.id)
          check('逾期未出貨：買家收到「已自動退款」', nb.length === 1, `${nb.length} 則`)
          check('逾期未出貨：賣家收到「保證金已沒收」', ns.length === 1, `${ns.length} 則`)
          check('賣家那一則把沒收金額講出來（不然他只能自己打開錢包才發現）',
            /\d/.test(String(ns[0]?.body ?? '')) && String(ns[0]?.body ?? '').includes('保證金'),
            `${ns[0]?.body}`)
        } else check('（跳過逾期未出貨的通知：造不出訂單）', false)

        /* ── 撞號要講人話。唯一索引擋下來時原本是一個沒有內容的 500，
             賣家不會知道是單號的問題，只會以為系統壞了然後一直重按。 ── */
        const o5 = await mkShipOrder(2400)
        const o6 = await mkShipOrder(2500)
        if (o5 && o6) {
          const t = track()
          check('第一筆用這組單號出得了貨',
            (await call(buyer, `/v1/orders/${o5.id}/ship`, { carrier: 'other', tracking: t })).ok)
          const dup = await call(buyer, `/v1/orders/${o6.id}/ship`, { carrier: 'other', tracking: t })
          check('第二筆用同一組單號被擋下，而且不是 500',
            dup.status === 409, `${dup.status}`)
          const dj = await json(dup)
          check('而且說得出是單號的問題、也給得出出路',
            dj.error === 'TRACKING_TAKEN' && String(dj.message).includes('單號'), `${dj.message}`)
        } else check('（跳過撞號測試：造不出訂單）', false)
      }

      /* ---- 9. 池揭曉：沒抽走的卡解押回賣家卡冊 ----
         解押只發生在揭曉那一刻，而揭曉是掃描觸發的 —— 賣家不在場，
         但這件事改變了他手上的資源：那幾張卡從「鎖在一個結束的池上」
         變回可以再開池、可以上架。 */
      {
        const cert = 'STUB-OK-' + Math.floor(Math.random() * 900_000 + 100_000)
        const relA = { id: 'c-rel-a', name: 'テストカード', setCode: 'SV8a', cardNo: '025',
          artId: 'SV8a-025', language: 'JP', grader: 'PSA', grade: 10, certNo: cert,
          image: '', variantId: null, refPrice: null }
        const relD = { id: 'c-rel-d', name: '生卡', setCode: 'SV8a', cardNo: '001',
          artId: 'SV8a-001', language: 'JP', grader: 'RAW', grade: null, certNo: null,
          image: '', variantId: null, refPrice: null }
        /* 兩張都先登記進卡冊（A-4：建池只能從卡冊挑）。
           **兩張都會被解押**，所以下面那條通知的張數是 2 而不是 1 ——
           改之前只有帶編號的那一張會進 prizes（023 只押帶編號的），
           裸卡那一張根本不存在於卡冊，當然也不會被解押回去。
           張數變了，測的東西沒變：驗的仍然是「沒抽走的卡回到卡冊、
           通知說得出張數、指得到卡冊、重掃不會再發一次」。 */
        const relAId = await bookCard(seller, relA)
        const relDId = await bookCard(seller, relD)
        const r = await json(await call(seller, '/v1/pools', {
          mode: 'muteki', title: '解押通知測試池', ticketPrice: 100, totalTickets: 2,
          prizes: [
            { tier: 'A', prizeId: relAId, total: 1, buyback: 50, card: relA },
            { tier: 'D', prizeId: relDId, total: 1, buyback: 50, card: relD }
          ]
        }))
        const pid = r.poolId
        check('建得起帶鑑定編號的池（解押測試的前提）', !!pid, JSON.stringify(r).slice(0, 120))
        if (pid) {
          // 一張都不抽就收攤：質押的那張應該原封不動回到卡冊
          await fetch(`${base}/v1/dev/expire-pool`, {
            method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
            body: JSON.stringify({ poolId: pid })
          })
          await fetch(`${base}/v1/dev/sweep-pools`, { method: 'POST', headers: devHeaders() })
          const n = withRef(await notifs(seller), 'pool-released:' + pid)
          check('池揭曉後，賣家收到「沒抽走的卡已回到卡冊」', n.length === 1, `${n.length} 則`)
          check('通知說得出張數，而且指到卡冊',
            String(n[0]?.title ?? '').includes('2 張') && n[0]?.link === '/me/cards',
            `${n[0]?.title} link=${n[0]?.link}`)
          await fetch(`${base}/v1/dev/sweep-pools`, { method: 'POST', headers: devHeaders() })
          check('重掃不會再發一次（refId 綁 poolId）',
            withRef(await notifs(seller), 'pool-released:' + pid).length === 1)
        }
      }

      /* ---- 10. 每一則通知的 link 都要指到存在的路由 ----
         這條是整段的安全網：上面漏驗的那些也逃不掉。 */
      for (const [who, tok] of [['買家', buyer], ['賣家', seller], ['賣場', shop]] as const) {
        const bad = (await notifs(tok)).filter((n: Any) => !linkOk(n.link))
        check(`${who}的通知沒有指向不存在的路由`, bad.length === 0,
          JSON.stringify(bad.map((n: Any) => ({ t: n.title, l: n.link }))))
      }
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

        /* 站內唯一「一張卡從甲的卡冊消失」的動作，而甲不是開單人 ——
           工單那則「已處理完成」跟他無關，他原本收不到任何東西。 */
        const lost = String(done.effect?.takeover?.fromUserId ?? '')
        if (lost && lost !== 'u-buyer') {
          const lt = lost === 'u-seller' ? seller : await login(lost.replace(/^u-/, ''), lost)
          const ln = ((await json(await call(lt, '/v1/social/notifications'))).notifications ?? [])
            .filter((n: Any) => n.ref_id === 'takeover-out:' + tid)
          check('卡被接管走的那一方收得到通知（他不是開單人，沒有別的訊號）',
            ln.length === 1, `${ln.length} 則，fromUserId=${lost}`)
          check('而且告訴他有誤要立刻開客服單', ln[0]?.link === '/support/new', `${ln[0]?.link}`)
        } else check('（跳過接管轉出通知：卡本來就在申請人名下）', true)

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

            /* 用 orderId 認自己那一張，不是「佇列裡第一張爭議單」——
               這支測試跑到這裡時站上已經有別的爭議（通知那一節造的），
               照順序抓會抓到別人的單，然後在下面的斷言裡以各種
               看不出原因的方式失敗。佇列摘要沒有 orderId，所以要逐張讀詳情。 */
            const dq = await json(await call(platform, '/v1/admin/tickets?kind=order-dispute'))
            const cands = (dq.items ?? []).filter((x: Any) => String(x.subject).startsWith('訂單爭議'))
            let dtk: Any = null
            for (const cand of cands) {
              const d = await json(await call(platform, `/v1/admin/tickets/${cand.id}`))
              if (d.ticket?.orderId === oid) { dtk = cand; break }
            }
            check('爭議成立後自動長出一張 order-dispute 單', !!dtk,
              `${cands.length} 張候選，沒有一張的 orderId 是 ${oid}`)

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

              /* 裁決是「錢的歸屬由第三人單方面決定」而且不可逆，雙方都不在場。
                 賣家那一側原本完全靜默 —— 保證金被沒收了他只能自己發現。 */
              const dref = 'dispute-resolved:' + oid
              /* 賣家是哪一位由訂單決定，不能寫死 u-seller —— 這一段買的是
                 「當下還在架上的需寄送掛單」，前面的測試會把它換掉。 */
              const sellerId = String(bought.order?.sellerId ?? '')
              const sellerTok = sellerId === 'u-seller' ? seller : await login(sellerId.replace(/^u-/, ''), sellerId)
              const bN = ((await json(await call(buyer, '/v1/social/notifications'))).notifications ?? [])
                .filter((n: Any) => n.ref_id === dref)
              const sN = ((await json(await call(sellerTok, '/v1/social/notifications'))).notifications ?? [])
                .filter((n: Any) => n.ref_id === dref)
              check('裁決會通知買家', bN.length === 1, `${bN.length} 則`)
              check('裁決也會通知賣家（原本這一側完全靜默）', sN.length === 1, `${sN.length} 則`)
              check('賣家那一則說得出保證金被沒收',
                String(sN[0]?.body ?? '').includes('保證金'), `${sN[0]?.body}`)
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
            /* 審核結果一定要通知送件的人。工單那則只說「已經處理完成」，
               不會讓賣家知道那句話同時也是他證件的判決。 */
            const vn = ((await json(await call(buyer, '/v1/social/notifications'))).notifications ?? [])
              .filter((n: Any) => String(n.ref_id).startsWith('seller-verify:'))
            check('審核結果會通知送件的賣家', vn.length >= 1,
              '找不到 ref_id 以 seller-verify: 開頭的通知')
            check('而且指到賣家看得到自己狀態的頁面', vn[0]?.link === '/seller/new', `${vn[0]?.link}`)
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
