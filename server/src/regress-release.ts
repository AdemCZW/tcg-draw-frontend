/**
 * orders-service.ts 的 releasePrize() 這一條的迴歸測試（A-7）。
 *
 *   npx tsx src/regress-release.ts http://localhost:8094
 *
 * ⚠️ **要有自己的乾淨資料庫**（migrate + seed 一個新庫），理由同 regress-public：
 * 這支會開池、讓池到期、上下架、成交、把訂單的時鐘往回撥，
 * 會把別支測試預期的種子狀態改掉。
 * 需要伺服器帶著 DEV_LOGIN=1 與相同的 DEV_LOGIN_SECRET 跑，
 * 而且這支自己也會連同一個 DATABASE_URL（有幾條要造舊資料、驗遷移）。
 *
 * 驗的是什麼：releasePrize() 是**所有**託管訂單結案的唯一出口，
 * 而它原本三種結局共用一行 `status = 'shipped'`。這支把每一條會走到它的
 * 狀態轉換各驗一次，斷言卡最後停在對的狀態：
 *
 *   ★ 退款往返   in_book 的卡 → 上架 → 成交 → 賣家逾期未出貨（自動取消）
 *                → 卡必須回到 in_book，而且**真的能再開池**（打真的建池 API，
 *                不是只看欄位值 —— 欄位對了但開池被擋，使用者的處境沒有改善）。
 *   反向         真的走完出貨的卡仍然是 shipped、而且過戶給買家。
 *                buyer-confirm / auto-release / dispute-seller 三條各驗一次。
 *   刻意不還原   爭議判買家（refunded，賣家已按過出貨）維持 shipped ——
 *                實體卡可能已經在買家手上，資料上分不出來，寧可不開池。
 *   還原的來源   previous_status = 'shipped' 的卡不會被還原成 in_book
 *                （證明是「照抄的值」而不是「一律 in_book」）。
 *   舊資料退路   previous_status 是 null（032 之前的掛單）時退回保守的 shipped。
 *   遷移 034     救得回來的舊資料真的救回來了，救不回來的**沒有被亂猜**。
 */
import { sql } from './db.js'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = (process.argv[2] ?? 'http://localhost:8094').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
const devHeaders = () => {
  if (!devSecret) throw new Error('regress-release 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')
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
const dev = (p: string, b: unknown) =>
  fetch(`${base}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
    body: JSON.stringify(b)
  })

const platform = await login('platform', 'VaultDraw 官方')
/* 賣家借種子裡那一個（開池要通過賣家審核，測試不繞那條路 —— 那是別支在驗的） */
const seller = await login('seller', '測試賣家')
const buyer = await login('relbuyer', 'A-7 買家')
await call(platform, '/v1/admin/grant', { userId: 'u-seller', points: 5_000_000, note: 'A-7 測試' })
await call(platform, '/v1/admin/grant', { userId: 'u-relbuyer', points: 5_000_000, note: 'A-7 測試' })

/* 編號帶執行時間戳：登記過的編號永遠佔著唯一索引，固定值第二次跑會被上一輪擋住 */
const RUN = String(Date.now()).slice(-8)
let seq = 0
const nextCert = (tag: string) => `STUB-A7-${tag}-${RUN}-${++seq}`

const certCard = (certNo: string) => ({
  id: 'c-SV4a-349', name: '噴火龍 ex SAR', artId: 'SV4a-349', cardNo: '349/190',
  setCode: 'sv4a', language: 'JP', grader: 'PSA', grade: 10, certNo, refPrice: 26000
})
const plainCard = {
  id: 'c-SV8a-237', name: '太樂巴戈斯 ex UR', artId: 'SV8a-237', cardNo: '237/187',
  setCode: 'sv8a', language: 'JP', grader: 'RAW', grade: null, certNo: null, refPrice: 900
}
const makePool = (tok: string, title: string, certNo: string, tickets = 4) => call(tok, '/v1/pools', {
  mode: 'muteki', title, ticketPrice: 2000, totalTickets: tickets, days: 7,
  prizes: [
    { tier: 'A', card: certCard(certNo), total: 1 },
    { tier: 'D', card: plainCard, total: tickets - 1 }
  ],
  tierBuyback: { A: 3000, D: 200 }
})

const prizeOf = async (tok: string, pred: (x: Any) => boolean) =>
  ((await json(await call(tok, '/v1/prizes?limit=100'))).items ?? []).find(pred)

/** 開池 → 到期 → 解押，造一張 in_book 的卡出來（跟 regress-public 同一條路） */
async function makeInBookCard(tok: string, cert: string) {
  const r = await makePool(tok, '素材池（回收用）', cert)
  if (!r.ok) throw new Error(`建池失敗：${r.status} ${(await r.text()).slice(0, 200)}`)
  const poolId = (await json(r)).poolId as string
  await dev('/v1/dev/expire-pool', { poolId })
  for (let i = 0; i < 4; i++) {
    await fetch(`${base}/v1/dev/sweep-pools`, { method: 'POST', headers: devHeaders() })
    const { pool } = await json(await call(tok, `/v1/pools/${poolId}`))
    if (pool?.status === 'revealed') break
  }
  return await prizeOf(tok, (x: Any) => x.card?.certNo === cert)
}

/** 上架 + 成交，回傳 { listingId, orderId } */
async function listAndBuy(sellerTok: string, buyerTok: string, prizeId: string, price: number, tag: string) {
  const lr = await call(sellerTok, '/v1/listings', { prizeId, price })
  const lb = await json(lr.clone())
  if (!lr.ok) throw new Error(`上架失敗 ${tag}：${lr.status} ${JSON.stringify(lb).slice(0, 200)}`)
  const br = await call(buyerTok, '/v1/orders', { listingId: lb.listing.id, idempotencyKey: `a7-${tag}-${RUN}` })
  const bb = await json(br.clone())
  if (!br.ok) throw new Error(`建單失敗 ${tag}：${br.status} ${JSON.stringify(bb).slice(0, 200)}`)
  return { listingId: lb.listing.id as string, orderId: bb.order.id as string, delivery: lb.listing.delivery as string }
}

/** 把訂單的時鐘往回撥再讓正常的掃描邏輯跑（讀清單就會 sweep） */
async function rewindAndSweep(orderId: string, ms: number, who: string) {
  await dev('/v1/dev/rewind-order', { orderId, ms })
  await call(who, '/v1/orders')
  const [row] = await sql`select status, closed_by from orders where id = ${orderId}`
  return row as { status: string; closed_by: string | null } | undefined
}

const HOUR = 3_600_000, DAY = 24 * HOUR

/* ══════════════ ★ 退款往返：這條沒過等於沒做 ═══════════════════════ */

head('★ in_book → 上架 → 成交 → 逾期未出貨退款 → 回到 in_book 且真的能再開池')
{
  const cert = nextCert('ROUND')
  const card = await makeInBookCard(seller, cert)
  ck('素材：卡解押回 in_book', card?.status === 'in_book', `status=${card?.status}`)

  const { listingId, orderId, delivery } = await listAndBuy(seller, buyer, card.id, 1200, 'round')
  ck('交付方式是需寄送（實體在賣家手上）', delivery === 'ship', `delivery=${delivery}`)
  const [ps] = await sql`select previous_status from listings where id = ${listingId}`
  ck('上架時抄下了 previous_status = in_book', ps?.previous_status === 'in_book', String(ps?.previous_status))
  const locked = await prizeOf(seller, (x: Any) => x.id === card.id)
  ck('託管期間卡停在 listed（那是鎖）', locked?.status === 'listed', `status=${locked?.status}`)

  /* 賣家什麼都不做，出貨期限（72 小時）到 → 系統自動取消退款。
     這是唯一一條「卡確定從來沒離開賣家」的結案路徑。 */
  const o = await rewindAndSweep(orderId, 73 * HOUR, buyer)
  ck('訂單自動取消（closedBy = ship-timeout）',
    o?.status === 'cancelled' && o?.closed_by === 'ship-timeout', `${o?.status}/${o?.closed_by}`)

  const after = await prizeOf(seller, (x: Any) => x.id === card.id)
  ck('★ 狀態回到 in_book（修好之前這裡是 shipped）', after?.status === 'in_book', `status=${after?.status}`)

  /* 欄位值只是必要條件。真正要證明的是「這張卡救得回來」：拿同一個編號
     再開一次池，走完整的建池 API。修好之前這一步會被 CARD_BUSY 擋死。 */
  const again = await makePool(seller, 'A-7 退款後再開池', cert)
  const ab = await json(again.clone())
  ck('★ 同一張卡真的能再開池（打真的建池 API）', again.ok,
    `${again.status} ${JSON.stringify(ab).slice(0, 200)}`)
  const reused = await prizeOf(seller, (x: Any) => x.card?.certNo === cert)
  ck('而且重用同一列、狀態 in_pool', reused?.id === card.id && reused?.status === 'in_pool',
    `${card.id}/${reused?.id} status=${reused?.status}`)
}

/* ══════════════ 反向：真的出貨的卡仍然是 shipped ═════════════════ */

head('反向一：buyer-confirm 完成 → 卡過戶給買家、仍然是 shipped')
let shippedCardId = ''
{
  const cert = nextCert('CONFIRM')
  const card = await makeInBookCard(seller, cert)
  const { orderId } = await listAndBuy(seller, buyer, card.id, 1300, 'confirm')
  const sr = await call(seller, `/v1/orders/${orderId}/ship`, {})
  ck('賣家按了出貨', sr.ok, `${sr.status} ${(await sr.clone().text()).slice(0, 160)}`)
  const cr = await call(buyer, `/v1/orders/${orderId}/confirm`, {})
  ck('買家確認收貨', cr.ok, `${cr.status}`)

  const gone = await prizeOf(seller, (x: Any) => x.id === card.id)
  ck('卡不在賣家名下了', !gone, `還在：${gone?.status}`)
  const got = await prizeOf(buyer, (x: Any) => x.id === card.id)
  ck('★ 卡在買家名下、狀態 shipped（沒有被還原成賣家上架前的 in_book）',
    got?.status === 'shipped', `status=${got?.status}`)
  const [pz] = await sql`select user_id, custodian_id from prizes where id = ${card.id}`
  ck('custodian 也一起過去了（實體真的移動了）',
    pz?.user_id === 'u-relbuyer' && pz?.custodian_id === 'u-relbuyer',
    `user=${pz?.user_id} custodian=${pz?.custodian_id}`)
  shippedCardId = String(card.id)
}

head('反向二：auto-release（沉默 21 天）完成 → 一樣是 shipped')
{
  const cert = nextCert('AUTO')
  const card = await makeInBookCard(seller, cert)
  const { orderId } = await listAndBuy(seller, buyer, card.id, 1400, 'auto')
  await call(seller, `/v1/orders/${orderId}/ship`, {})
  /* 14 天視同送達 + 7 天驗收期 = 21 天。掃描要跑兩次（shipped → delivered → completed）。 */
  const o1 = await rewindAndSweep(orderId, 22 * DAY, buyer)
  const o = o1?.status === 'completed' ? o1 : await rewindAndSweep(orderId, 1000, buyer)
  ck('訂單自動完成（closedBy = auto-release）',
    o?.status === 'completed' && o?.closed_by === 'auto-release', `${o?.status}/${o?.closed_by}`)
  const got = await prizeOf(buyer, (x: Any) => x.id === card.id)
  ck('卡在買家名下、狀態 shipped', got?.status === 'shipped', `status=${got?.status}`)
}

head('反向三：爭議判賣家（completed）→ 一樣過戶給買家、shipped')
{
  const cert = nextCert('DSELLER')
  const card = await makeInBookCard(seller, cert)
  const { orderId } = await listAndBuy(seller, buyer, card.id, 1500, 'dseller')
  await call(seller, `/v1/orders/${orderId}/ship`, {})
  const dr = await call(buyer, `/v1/orders/${orderId}/dispute`,
    { reason: '卡角有摺痕', videoUrl: 'https://example.com/a7-unboxing.mp4' })
  ck('買家開得了爭議', dr.ok, `${dr.status} ${(await dr.clone().text()).slice(0, 160)}`)
  const rr = await call(platform, `/v1/admin/disputes/${orderId}/resolve`, { to: 'seller', note: '影片無異常，判賣家' })
  ck('平台判賣家', rr.ok, `${rr.status} ${(await rr.clone().text()).slice(0, 160)}`)
  const got = await prizeOf(buyer, (x: Any) => x.id === card.id)
  ck('卡在買家名下、狀態 shipped', got?.status === 'shipped', `status=${got?.status}`)
}

/* ══════════════ 刻意不還原的那一條 ════════════════════════════════ */

head('爭議判買家（refunded，賣家已按過出貨）→ 刻意維持 shipped，不還原成 in_book')
{
  const cert = nextCert('DBUYER')
  const card = await makeInBookCard(seller, cert)
  const { listingId, orderId } = await listAndBuy(seller, buyer, card.id, 1600, 'dbuyer')
  const [ps] = await sql`select previous_status from listings where id = ${listingId}`
  ck('素材：previous_status 確實是 in_book（所以「沒還原」是判斷不是缺資料）',
    ps?.previous_status === 'in_book', String(ps?.previous_status))
  await call(seller, `/v1/orders/${orderId}/ship`, {})
  await call(buyer, `/v1/orders/${orderId}/dispute`,
    { reason: '寄來的不是同一張卡', videoUrl: 'https://example.com/a7-unboxing2.mp4' })
  const rr = await call(platform, `/v1/admin/disputes/${orderId}/resolve`, { to: 'buyer', note: '影片可見不符，判買家' })
  ck('平台判買家（訂單 refunded）', rr.ok, `${rr.status}`)
  const [ord] = await sql`select status, closed_by, shipped_at from orders where id = ${orderId}`
  ck('訂單是 refunded / dispute-buyer，而且 shipped_at 有值',
    ord?.status === 'refunded' && ord?.closed_by === 'dispute-buyer' && ord?.shipped_at != null,
    `${ord?.status}/${ord?.closed_by}/${ord?.shipped_at}`)

  const after = await prizeOf(seller, (x: Any) => x.id === card.id)
  ck('★ 卡留在賣家名下但維持 shipped（實體可能已在買家手上，分不出來就不猜）',
    after?.status === 'shipped', `status=${after?.status}`)
  const again = await makePool(seller, 'A-7 爭議退款後不該能開池', cert)
  ck('★ 而且開池會被擋（保守方向：寧可不能開池，也不要開一張不在手上的卡）',
    !again.ok, `status=${again.status}`)
}

/* ══════════════ 還原的是「抄下來的值」，不是一律 in_book ══════════ */

head('previous_status = shipped 的卡退款後還是 shipped（證明是照抄不是硬填 in_book）')
{
  /* 上一段反向一留下的那張卡現在在買家手上、狀態 shipped，
     由買家轉賣就是 previous_status = 'shipped' 的來源。 */
  const seller2 = buyer, buyer2 = await login('relbuyer2', 'A-7 買家二')
  await call(platform, '/v1/admin/grant', { userId: 'u-relbuyer2', points: 5_000_000, note: 'A-7 測試' })
  const { listingId, orderId } = await listAndBuy(seller2, buyer2, shippedCardId, 1700, 'reship')
  const [ps] = await sql`select previous_status from listings where id = ${listingId}`
  ck('素材：previous_status 抄到的是 shipped', ps?.previous_status === 'shipped', String(ps?.previous_status))
  const o = await rewindAndSweep(orderId, 73 * HOUR, buyer2)
  ck('訂單逾期未出貨自動取消', o?.status === 'cancelled', `${o?.status}`)
  const after = await prizeOf(seller2, (x: Any) => x.id === shippedCardId)
  ck('卡回到 shipped（不是被一律填成 in_book）', after?.status === 'shipped', `status=${after?.status}`)
}

head('舊掛單（previous_status 是 null）退款後退回保守的 shipped')
{
  const cert = nextCert('LEGACY')
  const card = await makeInBookCard(seller, cert)
  const { listingId, orderId } = await listAndBuy(seller, buyer, card.id, 1800, 'legacy')
  /* 直接把欄位清掉，模擬 032 之前建立、而且 034 回填也證明不了的舊掛單。
     這是唯一造得出這種列的方法 —— 上架端從 032 起一律會寫值。 */
  await sql`update listings set previous_status = null where id = ${listingId}`
  const o = await rewindAndSweep(orderId, 73 * HOUR, buyer)
  ck('訂單逾期未出貨自動取消', o?.status === 'cancelled', `${o?.status}`)
  const after = await prizeOf(seller, (x: Any) => x.id === card.id)
  ck('沒有資訊就不猜，退回 shipped（方向跟 A-5 一致）',
    after?.status === 'shipped', `status=${after?.status}`)
}

/* ══════════════ 遷移 034 的回填 ═══════════════════════════════════ */

head('遷移 034：救得回來的舊資料真的救回來，救不回來的沒有被亂猜')
{
  /* 造三種「舊資料」，跑一次 034 的內容，看它各自怎麼處理。
     直接讀 migrations/034 的檔案內容來跑 —— 測的是真的那一支，不是複製品。 */
  const mig = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '034_release_prize_previous_status.sql'), 'utf8')

  const mk = async (tag: string, opts: { poolId: string | null; orderStatus: string; shippedAt: number | null }) => {
    const pid = `pz-a7mig-${tag}-${RUN}`, lid = `l-a7mig-${tag}-${RUN}`, oid = `o-a7mig-${tag}-${RUN}`
    const now = Date.now()
    await sql`insert into prizes (id, user_id, pool_id, card, tier, status, won_at, acquired_at,
                                  stash_expires_at, grader, cert_no, custodian_id, origin)
              values (${pid}, 'u-seller', ${opts.poolId}, ${{ name: '回填測試卡' } as never}, null, 'shipped',
                      ${now}, ${now}, ${now + 90 * 86_400_000}, null, ${'MIG-' + tag + '-' + RUN},
                      'u-seller', 'upload')`
    await sql`insert into listings (id, card, price, seller_id, seller_name, delivery, prize_id, status, previous_status)
              values (${lid}, ${{ name: '回填測試卡' } as never}, 100, 'u-seller', 'A-7 賣家', 'ship',
                      ${pid}, 'sold', null)`
    await sql`insert into orders (id, listing_id, card, price, deposit, buyer_id, buyer_name,
                                  seller_id, seller_name, status, created_at, shipped_at)
              values (${oid}, ${lid}, ${{ name: '回填測試卡' } as never}, 100, 10, 'u-relbuyer', 'A-7 買家',
                      'u-seller', 'A-7 賣家', ${opts.orderStatus}, ${now}, ${opts.shippedAt})`
    return pid
  }
  const [anyPool] = await sql<{ id: string }[]>`select id from pools limit 1`

  const good = await mk('good', { poolId: null, orderStatus: 'cancelled', shippedAt: null })
  const disputed = await mk('disp', { poolId: null, orderStatus: 'refunded', shippedAt: Date.now() })
  const pooled = await mk('pool', { poolId: anyPool!.id, orderStatus: 'cancelled', shippedAt: null })

  await sql.unsafe(mig)

  const st = async (id: string) => String((await sql`select status from prizes where id = ${id}`)[0]?.status)
  ck('★ 賣家從沒按過出貨就結案的那一列 → 救回 in_book', await st(good) === 'in_book', await st(good))
  ck('爭議退款（賣家已出貨）的那一列 → 維持 shipped，沒有被亂猜',
    await st(disputed) === 'shipped', await st(disputed))
  ck('進過池的那一列 → 維持 shipped（它的 shipped 有合法來源，分不出來就不動）',
    await st(pooled) === 'shipped', await st(pooled))
}

console.log(`\nregress-release: ${pass} passed, ${fail} failed`)
await sql.end()
process.exit(fail ? 1 : 0)
