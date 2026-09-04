/**
 * D-2 的迴歸測試：**過戶不重設寄存期限，但買家要看得到剩幾天**。
 *
 * ── 這一支要釘住的那兩句話 ──────────────────────────────────────────
 * 1. 三條過戶路（庫內成交、交易邀約成交、託管訂單完成）**都不重設**
 *    prizes.stash_expires_at。這不是漏掉：那 90 天量的是「實體卡在
 *    custodian 的抽屜裡放了多久」，而站內過戶不搬動實體卡
 *    （custodian_id 一律不變，見 migrations/021）。重設會讓兩個
 *    互相買賣的帳號把到期提醒無限往後推。
 * 2. 買家在**按下購買之前**看得到剩幾天
 *    （GET /v1/orders/listings/:id/stash）。不揭露的話，這條規則就是
 *    在用資訊落差懲罰買家 —— 他付完錢才收到「已超過寄存期限」的通知。
 *
 * 第 1 組是**重現組**：素材是一張 stash_expires_at 被直接寫成「明天」的卡，
 * 走完整條市場成交，斷言新主人拿到的就是明天到期。這一組通過的意思是
 * 「那個行為確實存在」，不是「那個行為是錯的」—— 第 4 組才說明它為什麼對。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   createdb vd_stash
 *   DATABASE_URL=postgres://localhost:5432/vd_stash JWT_SECRET=<32+> \
 *     npx tsx src/migrate.ts && npx tsx src/seed.ts
 *   DATABASE_URL=... JWT_SECRET=... PORT=8097 DEV_LOGIN=1 DEV_LOGIN_SECRET=<32+> \
 *     npx tsx src/index.ts
 *   DATABASE_URL=... DEV_LOGIN_SECRET=<同值> \
 *     npx tsx src/regress-stash.ts http://localhost:8097
 *
 * ⚠️ 要有自己的乾淨資料庫，不要跟 smoke 共用（理由同 regress-inventory.ts：
 * 兩邊都會消耗種子資料）。
 */
import { randomBytes } from 'node:crypto'
import { sql } from './db.js'

const base = (process.argv[2] ?? 'http://localhost:8097').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
if (!devSecret) throw new Error('regress-stash 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const json = (r: Response): Promise<Any> => r.json()
let pass = 0, fail = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
const note = (s: string) => console.log(`       ${s}`)
const head = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 54 - s.length))}`)

const DAY = 86_400_000

async function login(handle: string, name: string) {
  const r = await fetch(`${base}/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-login-secret': devSecret! },
    body: JSON.stringify({ handle, name })
  })
  if (!r.ok) throw new Error(`login ${handle}: ${r.status} ${await r.text()}`)
  return (await json(r)).token as string
}
const call = (t: string, p: string, b?: unknown) =>
  fetch(`${base}${p}`, {
    method: b === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    ...(b === undefined ? {} : { body: JSON.stringify(b) })
  })

const RUN = randomBytes(4).toString('hex')
let seq = 0
const uniq = () => `${RUN}-${++seq}`

/**
 * 直接寫一列「寄存中」的卡當素材（不打 API）。
 *
 * 為什麼要自己寫而不是真的去抽一張：這一支要控制的是 stash_expires_at，
 * 而那一欄唯一的寫入點是抽中的當下（now + 90 天），抽出來的卡永遠是
 * 「剩 90 天」。重現「剩 1 天」的唯一辦法就是直接把值寫進去 ——
 * 這正是題目要求的「造一張快到期的卡」。
 *
 * custodian 刻意設成**第三個人**（開池的賣家），不是 owner：那才是
 * 寄存的真實佈景，也是「過戶不該重設時鐘」這句話的前提。
 */
async function seedStashed(
  owner: string, custodian: string, daysLeft: number, name: string
): Promise<string> {
  const id = 'pz-stash-' + randomBytes(6).toString('hex')
  const now = Date.now()
  await sql`
    insert into prizes (id, user_id, pool_id, card, tier, status,
                        won_at, acquired_at, stash_expires_at,
                        grader, cert_no, custodian_id, origin)
    values (${id}, ${owner}, null,
            ${sql.json({ id: 'c-' + id, name, setCode: 'sv8a', cardNo: '201/187',
                         artId: 'SV8a-201', image: '', language: 'JP',
                         grader: null, grade: null, certNo: null,
                         refPrice: 5000, variantId: null })},
            'C', 'stashed', ${now - (90 - daysLeft) * DAY}, ${now - (90 - daysLeft) * DAY},
            ${now + daysLeft * DAY}, null, null, ${custodian}, 'draw')
  `
  return id
}

/** 同上，但狀態是 in_book —— 託管（需寄送）掛單只收 in_book / shipped */
async function seedInBook(owner: string, daysLeft: number, name: string): Promise<string> {
  const id = await seedStashed(owner, owner, daysLeft, name)
  await sql`update prizes set status = 'in_book' where id = ${id}`
  return id
}

const prizeRow = async (id: string) => {
  const [r] = await sql<Any[]>`
    select user_id, custodian_id, status, stash_expires_at, acquired_at from prizes where id = ${id}
  `
  return r
}

const listFor = async (tok: string, prizeId: string, price: number) => {
  const r = await call(tok, '/v1/listings', { prizeId, price })
  const b = await json(r.clone())
  if (!r.ok) throw new Error(`上架失敗 ${r.status} ${JSON.stringify(b)}`)
  return b.listingId ?? b.listing?.id ?? b.id
}

const platform = await login('platform', 'VaultDraw 官方')
const seller = await login('seller', '測試賣家')
const buyer = await login('buyer', '測試買家')
const holder = await login('holder', '寄存持有人')
await call(platform, '/v1/admin/grant', { userId: 'u-buyer', points: 5_000_000, note: 'D-2 測試' })
await call(platform, '/v1/admin/grant', { userId: 'u-seller', points: 5_000_000, note: 'D-2 測試' })
await call(platform, '/v1/admin/grant', { userId: 'u-holder', points: 5_000_000, note: 'D-2 測試' })

/* ────────────────────────────────────────────────────────────────────
   1 重現：庫內成交（routes/orders.ts）
   ──────────────────────────────────────────────────────────────────── */
head('1 庫內成交：買家繼承賣家剩下的天數')

{
  const pz = await seedStashed('u-seller', 'u-holder', 1, '快到期的卡（庫內）')
  const before = await prizeRow(pz)
  const lid = await listFor(seller, pz, 3000)
  note(`素材：owner=u-seller、custodian=u-holder、剩 1 天（${new Date(Number(before.stash_expires_at)).toISOString().slice(0, 10)}）`)

  const r = await call(buyer, '/v1/orders', { listingId: lid, idempotencyKey: uniq() + '-vault' })
  const b = await json(r.clone())
  ck('買下庫內掛單成立', r.ok, `${r.status} ${JSON.stringify(b)}`)

  const after = await prizeRow(pz)
  ck('卡真的過戶給買家', after.user_id === 'u-buyer', String(after.user_id))
  ck('狀態回到 stashed', after.status === 'stashed', String(after.status))
  ck('acquired_at 有跟著更新（卡冊排序）',
    Number(after.acquired_at) > Number(before.acquired_at), String(after.acquired_at))
  ck('custodian 沒變 —— 實體卡一步都沒動', after.custodian_id === 'u-holder', String(after.custodian_id))
  ck('【重現】stash_expires_at 原封不動：新主人只剩 1 天',
    String(after.stash_expires_at) === String(before.stash_expires_at),
    `${before.stash_expires_at} → ${after.stash_expires_at}`)
  const left = Math.ceil((Number(after.stash_expires_at) - Date.now()) / DAY)
  ck('換算出來就是 1 天', left === 1, `${left} 天`)
  note('這一組通過＝那個行為確實存在。它為什麼是對的，看第 4 組。')
}

/* ────────────────────────────────────────────────────────────────────
   2 交易邀約成交（routes/social.ts）
   ──────────────────────────────────────────────────────────────────── */
head('2 交易邀約成交：同樣不重設')

{
  /* 出價的前提是對方的卡冊有公開，否則知道 prize_id 就能繞過公開設定去騷擾 */
  await sql`update users set cardbook_public = true where id = 'u-seller'`
  const pz = await seedStashed('u-seller', 'u-holder', 2, '快到期的卡（邀約）')
  const before = await prizeRow(pz)

  const or = await call(buyer, '/v1/social/trade-offers', { prizeId: pz, points: 2500 })
  const ob = await json(or.clone())
  ck('出價送得出去', or.ok, `${or.status} ${JSON.stringify(ob)}`)
  const ar = await call(seller, `/v1/social/trade-offers/${ob.offerId}/accept`, {})
  const ab = await json(ar.clone())
  ck('持有人接受出價', ar.ok, `${ar.status} ${JSON.stringify(ab)}`)

  const after = await prizeRow(pz)
  ck('卡過戶給出價方', after.user_id === 'u-buyer', String(after.user_id))
  ck('custodian 沒變', after.custodian_id === 'u-holder', String(after.custodian_id))
  ck('stash_expires_at 原封不動：新主人只剩 2 天',
    String(after.stash_expires_at) === String(before.stash_expires_at),
    `${before.stash_expires_at} → ${after.stash_expires_at}`)
}

/* ────────────────────────────────────────────────────────────────────
   3 託管訂單完成（orders-service.ts）
   ──────────────────────────────────────────────────────────────────── */
head('3 託管訂單完成：實體真的移動，但欄位一樣不用動')

{
  const pz = await seedInBook('u-seller', 3, '快到期的卡（託管）')
  const before = await prizeRow(pz)
  const lid = await listFor(seller, pz, 4000)

  const r = await call(buyer, '/v1/orders', { listingId: lid, idempotencyKey: uniq() + '-ship' })
  const b = await json(r.clone())
  ck('託管訂單建立', r.ok && !!b.order, `${r.status} ${JSON.stringify(b)}`)
  const oid = b.order?.id
  const sr = await call(seller, `/v1/orders/${oid}/ship`, { carrier: 'other' })
  ck('賣家出貨', sr.ok, `${sr.status} ${await sr.text()}`)
  const cr = await call(buyer, `/v1/orders/${oid}/confirm`, {})
  ck('買家確認收貨', cr.ok, `${cr.status} ${await cr.text()}`)

  const after = await prizeRow(pz)
  ck('卡過戶給買家', after.user_id === 'u-buyer', String(after.user_id))
  ck('custodian 也一起改（實體真的寄到了）', after.custodian_id === 'u-buyer', String(after.custodian_id))
  ck('狀態離開 stashed，寄存掃描從此掃不到它', after.status === 'shipped', String(after.status))
  ck('stash_expires_at 原封不動（留著的舊值不再被任何人讀）',
    String(after.stash_expires_at) === String(before.stash_expires_at),
    `${before.stash_expires_at} → ${after.stash_expires_at}`)

  /* 這一句才是「不用動」的證明：sweepStashExpiry 的述詞是 status = 'stashed'。 */
  const [hit] = await sql<Any[]>`
    select count(*)::text as n from prizes
     where id = ${pz} and status = 'stashed' and stash_expires_at <= ${Date.now() + 14 * DAY}
  `
  ck('到期掃描的述詞真的掃不到這一列', hit.n === '0', String(hit.n))
}

/* ────────────────────────────────────────────────────────────────────
   4 為什麼不重設：重設會開一個免費的洞
   ──────────────────────────────────────────────────────────────────── */
head('4 不重設是對的：來回轉手不會把時鐘推走')

{
  const pz = await seedStashed('u-seller', 'u-holder', 1, '來回轉手的卡')
  const t0 = Number((await prizeRow(pz)).stash_expires_at)

  /* 賣給買家、再賣回來。兩筆庫內轉移的帳目相抵、沒有手續費 ——
     如果過戶會重設，這兩步的成本是零而收益是「時鐘往後推 89 天」。 */
  const l1 = await listFor(seller, pz, 1000)
  await call(buyer, '/v1/orders', { listingId: l1, idempotencyKey: uniq() + '-pp1' })
  const l2 = await listFor(buyer, pz, 1000)
  await call(seller, '/v1/orders', { listingId: l2, idempotencyKey: uniq() + '-pp2' })

  const after = await prizeRow(pz)
  ck('卡真的繞了一圈回到原主', after.user_id === 'u-seller', String(after.user_id))
  ck('繞完一圈到期日仍然是原本那一天 —— 洞不成立',
    Number(after.stash_expires_at) === t0, `${t0} → ${after.stash_expires_at}`)
  ck('實體保管人全程沒變', after.custodian_id === 'u-holder', String(after.custodian_id))
  note('若改成「過戶重設 90 天」，這四行就是一個零成本的無限延長寄存。')
}

/* ────────────────────────────────────────────────────────────────────
   5 非過戶路徑不該被牽連
   ──────────────────────────────────────────────────────────────────── */
head('5 上架 / 下架不碰寄存期限')

{
  const pz = await seedStashed('u-seller', 'u-holder', 5, '上架又下架的卡')
  const before = await prizeRow(pz)
  const lid = await listFor(seller, pz, 2000)
  const mid = await prizeRow(pz)
  ck('上架後狀態是 listed', mid.status === 'listed', String(mid.status))
  ck('上架不動寄存期限', String(mid.stash_expires_at) === String(before.stash_expires_at))

  const dr = await call(seller, `/v1/listings/${lid}/delist`, {})
  ck('下架成功', dr.ok, `${dr.status} ${await dr.text()}`)
  const after = await prizeRow(pz)
  ck('下架後回到 stashed', after.status === 'stashed', String(after.status))
  ck('下架也不動寄存期限', String(after.stash_expires_at) === String(before.stash_expires_at),
    `${before.stash_expires_at} → ${after.stash_expires_at}`)
}

/* ────────────────────────────────────────────────────────────────────
   6 揭露：買之前看得到剩幾天
   ──────────────────────────────────────────────────────────────────── */
head('6 揭露：GET /orders/listings/:id/stash')

{
  const soonPz = await seedStashed('u-seller', 'u-holder', 1, '快到期的掛單')
  const soonLid = await listFor(seller, soonPz, 3100)
  const farPz = await seedStashed('u-seller', 'u-holder', 88, '還很久的掛單')
  const farLid = await listFor(seller, farPz, 3200)

  const s = await json(await call(buyer, `/v1/orders/listings/${soonLid}/stash`))
  ck('快到期的掛單回得出剩餘天數', s.stash?.daysLeft === 1, JSON.stringify(s))
  ck('同時說得出總天數（90）', s.stash?.totalDays === 90, JSON.stringify(s.stash))
  ck('說得出實體卡還在別人手上', s.stash?.heldByOther === true, JSON.stringify(s.stash))

  const f = await json(await call(buyer, `/v1/orders/listings/${farLid}/stash`))
  ck('還很久的掛單回 88 天', f.stash?.daysLeft === 88, JSON.stringify(f))

  /* 過期的用負數，讓前端分得出「快到了」與「早就過了」 */
  const overPz = await seedStashed('u-seller', 'u-holder', -3, '已經過期的掛單')
  const overLid = await listFor(seller, overPz, 3300)
  const o = await json(await call(buyer, `/v1/orders/listings/${overLid}/stash`))
  ck('已經過期的回負數', typeof o.stash?.daysLeft === 'number' && o.stash.daysLeft < 0, JSON.stringify(o))

  /* 需寄送的掛單沒有「剩幾天」可言：成交就會寄到買家手上 */
  const shipPz = await seedInBook('u-seller', 4, '需寄送的掛單')
  const shipLid = await listFor(seller, shipPz, 3400)
  const sh = await json(await call(buyer, `/v1/orders/listings/${shipLid}/stash`))
  ck('需寄送的掛單回 null（寄存在成交那一刻就結束）', sh.stash === null, JSON.stringify(sh))

  const none = await json(await call(buyer, '/v1/orders/listings/l-does-not-exist/stash'))
  ck('查不到的掛單回 null 而不是 404', none.stash === null, JSON.stringify(none))

  const anon = await fetch(`${base}/v1/orders/listings/${soonLid}/stash`)
  ck('未登入拿不到（掛在 /orders 底下，要登入）', anon.status === 401, String(anon.status))
}

console.log(`\n${pass} passed / ${fail} failed`)
await sql.end({ timeout: 5 })
process.exit(fail ? 1 : 0)
