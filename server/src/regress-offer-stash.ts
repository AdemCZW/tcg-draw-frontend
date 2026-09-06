/**
 * D-2 的第二個缺口：**交易邀約那條路也要看得到剩幾天**。
 *
 * ── 這一支要釘住的三句話 ────────────────────────────────────────────
 * 1. 出價方在**這筆邀約還沒被接受**的時候就看得到那張卡剩幾天。
 *    邀約成交走庫內轉移，`stash_expires_at` 刻意不重設（見 migrations/039
 *    與 regress-stash.ts），所以他換到手的可能是一張明天就到期的卡；
 *    而到期之後系統會**自動替他申請出貨**（pools-service.ts 的
 *    autoShipExpired）—— 這個數字有真實後果，不是一則可以滑掉的提醒。
 *    上一輪只補了市場那條（GET /orders/listings/:id/stash），
 *    邀約這條整條沒有揭露。
 * 2. 兩邊都看得到，而且分得出是哪一張卡。邀約是**單向**的
 *    （點數換一張卡，schema 見 migrations/007：一個 prize_id、一個 points，
 *    沒有「我也拿一張出來」那一欄），所以一筆邀約只有一張卡有到期日；
 *    但同一個人可以同時對好幾張卡出價，每一筆必須帶自己那張卡的天數。
 * 3. 這個資訊只有**一份實作**。市場那支與這支對同一張卡必須給出
 *    逐字相同的 daysLeft —— 這個 repo 為「同一個資訊兩份實作」吃過虧
 *    （賣家統計曾經列表與單頁給出不同答案），那次沒有測試釘著。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   createdb vd_offerstash
 *   DATABASE_URL=postgres://localhost:5432/vd_offerstash JWT_SECRET=<32+> \
 *     npx tsx src/migrate.ts && npx tsx src/seed.ts
 *   DATABASE_URL=... JWT_SECRET=... PORT=8098 DEV_LOGIN=1 DEV_LOGIN_SECRET=<32+> \
 *     npx tsx src/index.ts
 *   DATABASE_URL=... DEV_LOGIN_SECRET=<同值> \
 *     npx tsx src/regress-offer-stash.ts http://localhost:8098
 *
 * ⚠️ 要有自己的乾淨資料庫，不要跟 smoke 共用（理由同 regress-stash.ts：
 * 兩邊都會消耗種子資料）。
 */
import { randomBytes } from 'node:crypto'
import { sql } from './db.js'

const base = (process.argv[2] ?? 'http://localhost:8098').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
if (!devSecret) throw new Error('regress-offer-stash 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')

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

/**
 * 直接寫一列「寄存中」的卡當素材（不打 API）。理由同 regress-stash.ts：
 * `stash_expires_at` 唯一的寫入點是抽中的那一刻（now + 90 天），
 * 真的去抽一張永遠只會得到「剩 90 天」。要重現「剩 1 天」只能自己寫。
 *
 * custodian 可以指定成第三個人（開池的賣家，寄存的真實佈景）、
 * 指定成 owner 自己、或 null（021 之前留下的舊列）—— 第 4 組驗的是
 * heldByOther 只看「有沒有」，跟市場那支同一個定義。
 */
async function seedStashed(
  owner: string, custodian: string | null, daysLeft: number, name: string
): Promise<string> {
  const id = 'pz-ofs-' + randomBytes(6).toString('hex')
  const now = Date.now()
  await sql`
    insert into prizes (id, user_id, pool_id, card, tier, status,
                        won_at, acquired_at, stash_expires_at,
                        grader, cert_no, custodian_id, origin)
    values (${id}, ${owner}, null,
            ${sql.json({ id: 'c-' + id, name, setCode: 'sv8a', cardNo: '202/187',
                         artId: 'SV8a-202', image: '', language: 'JP',
                         grader: null, grade: null, certNo: null,
                         refPrice: 5000, variantId: null })},
            'C', 'stashed', ${now - (90 - daysLeft) * DAY}, ${now - (90 - daysLeft) * DAY},
            ${now + daysLeft * DAY}, null, null, ${custodian}, 'draw')
  `
  return id
}

/** 出價，回 offerId。失敗直接炸 —— 素材出問題時要看到原因，不是看到一片 FAIL */
async function offer(tok: string, prizeId: string, points: number): Promise<string> {
  const r = await call(tok, '/v1/social/trade-offers', { prizeId, points })
  const b = await json(r.clone())
  if (!r.ok) throw new Error(`出價失敗 ${r.status} ${JSON.stringify(b)}`)
  return b.offerId as string
}

/** 某個人的收發匣裡，指定那一筆邀約長什麼樣（找不到回 undefined） */
async function offerRow(tok: string, box: 'incoming' | 'outgoing', offerId: string): Promise<Any> {
  const b = await json(await call(tok, '/v1/social/trade-offers'))
  return (b[box] as Any[]).find(o => o.id === offerId)
}

const listFor = async (tok: string, prizeId: string, price: number) => {
  const r = await call(tok, '/v1/listings', { prizeId, price })
  const b = await json(r.clone())
  if (!r.ok) throw new Error(`上架失敗 ${r.status} ${JSON.stringify(b)}`)
  return b.listingId ?? b.listing?.id ?? b.id
}

const platform = await login('platform', 'VaultDraw 官方')
const seller = await login('seller', '測試持卡人')
const buyer = await login('buyer', '測試出價方')
const stranger = await login('stranger', '路人甲')
await login('holder', '寄存保管人')
await call(platform, '/v1/admin/grant', { userId: 'u-buyer', points: 5_000_000, note: 'D-2 邀約揭露' })
await call(platform, '/v1/admin/grant', { userId: 'u-stranger', points: 5_000_000, note: 'D-2 邀約揭露' })
/* 出價的前提是對方的卡冊有公開，否則知道 prize_id 就能繞過公開設定去騷擾 */
await sql`update users set cardbook_public = true where id = 'u-seller'`

/* ────────────────────────────────────────────────────────────────────
   0 先確認這條路真的是單向的
   ──────────────────────────────────────────────────────────────────── */
head('0 交易邀約是單向：點數換一張卡')

{
  const cols = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns where table_name = 'trade_offers'
  `
  const names = cols.map(c => c.column_name)
  ck('只有一個 prize_id', names.filter(n => n.startsWith('prize')).length === 1, names.join(','))
  ck('對價是 points，沒有「我也拿一張卡出來」那一欄',
    names.includes('points') && !names.some(n => n.includes('offer_prize') || n.includes('give')),
    names.join(','))
  note('所以「兩邊的卡各自的天數」不存在 —— 一筆邀約只有一張卡有寄存時鐘。')
  note('要分得出是哪一張，靠的是「同時對多張卡出價時每筆帶自己那張」（第 3 組）。')
}

/* ────────────────────────────────────────────────────────────────────
   1 核心：出價方在被接受之前就看得到「剩 1 天」
   ──────────────────────────────────────────────────────────────────── */
head('1 核心：剩 1 天的卡，出價方接受前就看得到')

{
  const pz = await seedStashed('u-seller', 'u-holder', 1, '明天就到期的卡')
  const oid = await offer(buyer, pz, 2500)
  note(`素材：owner=u-seller、custodian=u-holder、剩 1 天；出價方 u-buyer 已出價`)

  const row = await offerRow(buyer, 'outgoing', oid)
  ck('出價方的寄件匣找得到這筆', !!row, JSON.stringify(row))
  ck('這筆邀約還沒被接受（還收得回來）', row?.status === 'pending', String(row?.status))
  ck('**接受之前**就帶得出剩餘天數＝1', row?.stash?.daysLeft === 1, JSON.stringify(row?.stash))
  ck('同時說得出總天數（90）', row?.stash?.totalDays === 90, JSON.stringify(row?.stash))
  ck('說得出實體卡還在別人手上', row?.stash?.heldByOther === true, JSON.stringify(row?.stash))
  ck('到期時間戳也給了（前端要自己算也行）',
    typeof row?.stash?.expiresAt === 'number' && row.stash.expiresAt > Date.now(),
    JSON.stringify(row?.stash))

  /* 持卡人那一側看到的是同一張卡的同一個時鐘 —— 他要交出去的是剩下的天數 */
  const inRow = await offerRow(seller, 'incoming', oid)
  ck('持卡人的收件匣看到同一個天數', inRow?.stash?.daysLeft === 1, JSON.stringify(inRow?.stash))

  /* 揭露的那句話（「換到手不會重新計算」）必須是真的 */
  const ar = await call(seller, `/v1/social/trade-offers/${oid}/accept`, {})
  ck('持卡人接受', ar.ok, `${ar.status} ${await ar.text()}`)
  const [after] = await sql<Any[]>`select stash_expires_at, custodian_id, user_id from prizes where id = ${pz}`
  ck('成交後卡真的過戶給出價方', after.user_id === 'u-buyer', String(after.user_id))
  ck('成交後 custodian 沒變 —— 實體卡一步都沒動', after.custodian_id === 'u-holder', String(after.custodian_id))
  const leftAfter = Math.ceil((Number(after.stash_expires_at) - Date.now()) / DAY)
  ck('成交後仍然是剩 1 天，沒有重設成 90 —— 揭露的那句話是真的', leftAfter === 1, `${leftAfter} 天`)
}

/* ────────────────────────────────────────────────────────────────────
   2 兩種樣式的分界：88 天與 1 天
   ──────────────────────────────────────────────────────────────────── */
head('2 分界：88 天（淡字）與 1 天（警示）')

{
  const far = await seedStashed('u-seller', 'u-holder', 88, '還很久的卡')
  const soon = await seedStashed('u-seller', 'u-holder', 1, '快到期的卡')
  const farId = await offer(buyer, far, 1200)
  const soonId = await offer(buyer, soon, 1300)

  const f = await offerRow(buyer, 'outgoing', farId)
  const s = await offerRow(buyer, 'outgoing', soonId)
  ck('還很久的回 88', f?.stash?.daysLeft === 88, JSON.stringify(f?.stash))
  ck('快到期的回 1', s?.stash?.daysLeft === 1, JSON.stringify(s?.stash))
  ck('88 在 14 天門檻之外（前端畫淡字）', (f?.stash?.daysLeft ?? 0) > 14)
  ck('1 在 14 天門檻之內（前端升成警示塊）', (s?.stash?.daysLeft ?? 99) <= 14)

  /* 門檻本身是 14：兩側各驗一格，改動門檻時這兩行會一起說話 */
  const on = await seedStashed('u-seller', 'u-holder', 14, '剛好在門檻上的卡')
  const off = await seedStashed('u-seller', 'u-holder', 15, '剛好在門檻外的卡')
  const onRow = await offerRow(buyer, 'outgoing', await offer(buyer, on, 1400))
  const offRow = await offerRow(buyer, 'outgoing', await offer(buyer, off, 1500))
  ck('14 天含在警示裡（<= 14）', onRow?.stash?.daysLeft === 14, JSON.stringify(onRow?.stash))
  ck('15 天不含（> 14）', offRow?.stash?.daysLeft === 15, JSON.stringify(offRow?.stash))
}

/* ────────────────────────────────────────────────────────────────────
   3 分得出是哪一張
   ──────────────────────────────────────────────────────────────────── */
head('3 同時對多張卡出價：每一筆帶自己那張卡的天數')

{
  const a = await seedStashed('u-seller', 'u-holder', 2, '甲卡（剩 2 天）')
  const b = await seedStashed('u-seller', 'u-holder', 60, '乙卡（剩 60 天）')
  const oa = await offer(buyer, a, 2100)
  const ob = await offer(buyer, b, 2200)

  const box = await json(await call(buyer, '/v1/social/trade-offers'))
  const rowA = (box.outgoing as Any[]).find(o => o.id === oa)
  const rowB = (box.outgoing as Any[]).find(o => o.id === ob)
  ck('甲卡那筆是 2 天', rowA?.stash?.daysLeft === 2, JSON.stringify(rowA?.stash))
  ck('乙卡那筆是 60 天', rowB?.stash?.daysLeft === 60, JSON.stringify(rowB?.stash))
  ck('天數跟著 prize_id 走，不會串行', rowA?.prize_id === a && rowB?.prize_id === b,
    `${rowA?.prize_id} / ${rowB?.prize_id}`)
  ck('每一列都畫得出是哪一張卡（卡名有帶）',
    !!rowA?.card?.name && rowA.card.name !== rowB?.card?.name,
    `${rowA?.card?.name} / ${rowB?.card?.name}`)
}

/* ────────────────────────────────────────────────────────────────────
   4 heldByOther 跟市場端點同一個定義，而且永遠不說是誰
   ──────────────────────────────────────────────────────────────────── */
head('4 heldByOther：有沒有人在保管，不是保管人是不是你')

{
  /* 定義逐字沿用 routes/orders.ts：custodian_id 非空就是 true。
     前一版寫成「相對於看的人」，同一張卡從市場頁與邀約頁問會拿到不同答案 ——
     這一組釘的就是「兩邊必須同一個定義」。 */
  const pz = await seedStashed('u-seller', 'u-seller', 30, '在持卡人自己手上的卡')
  const oid = await offer(buyer, pz, 1800)

  const out = await offerRow(buyer, 'outgoing', oid)
  const inc = await offerRow(seller, 'incoming', oid)
  ck('出價方看到 true（有人在保管，換到手實體不會跟著過來）',
    out?.stash?.heldByOther === true, JSON.stringify(out?.stash))
  ck('持卡人也看到 true —— 同一張卡同一個答案，不隨看的人改變',
    inc?.stash?.heldByOther === true, JSON.stringify(inc?.stash))
  ck('兩邊的天數一樣', out?.stash?.daysLeft === inc?.stash?.daysLeft,
    `${out?.stash?.daysLeft} / ${inc?.stash?.daysLeft}`)

  /* 沒有保管人（custodian_id 為 null）才是 false —— 跟市場那支 `(custodian_id ?? '') !== ''` 一致 */
  const noCust = await seedStashed('u-seller', null, 30, '沒有保管人紀錄的卡')
  const noRow = await offerRow(buyer, 'outgoing', await offer(buyer, noCust, 1700))
  ck('custodian_id 為 null 時回 false', noRow?.stash?.heldByOther === false, JSON.stringify(noRow?.stash))

  /* 保管人的身分是別人的個資，一個欄位都不該漏出去。
     `select o.*` 這種寫法多 select 一欄就自動多回一欄，所以這幾行是必要的。 */
  for (const [who, row] of [['寄件匣', out], ['收件匣', inc]] as const) {
    ck(`${who}不外洩 custodian_id`, !('custodian_id' in (row ?? {})), Object.keys(row ?? {}).join(','))
    ck(`${who}不外洩 stash_expires_at 原欄`, !('stash_expires_at' in (row ?? {})), Object.keys(row ?? {}).join(','))
    ck(`${who}不外洩 prize_status`, !('prize_status' in (row ?? {})), Object.keys(row ?? {}).join(','))
  }
}

/* ────────────────────────────────────────────────────────────────────
   5 不適用的情況回 null，不回 0
   ──────────────────────────────────────────────────────────────────── */
head('5 沒有這個資訊時回 null')

{
  const pz = await seedStashed('u-seller', 'u-holder', 20, '出價後又去申請出貨的卡')
  const oid = await offer(buyer, pz, 1900)
  const before = await offerRow(buyer, 'outgoing', oid)
  ck('還在寄存時有天數', before?.stash?.daysLeft === 20, JSON.stringify(before?.stash))

  /* 卡離開 stashed（申請出貨）之後就沒有「剩幾天」可言：
     寄存掃描只看 stashed，那一欄從此不再被讀（見 migrations/039）。 */
  await sql`update prizes set status = 'ship_requested' where id = ${pz}`
  const after = await offerRow(buyer, 'outgoing', oid)
  ck('卡不在寄存中就回 null', after?.stash === null, JSON.stringify(after?.stash))
  ck('回的是 null 不是 0（0 會被讀成「今天到期」）', after?.stash !== 0 && after?.stash !== undefined,
    JSON.stringify(after?.stash))

  // 已經寄出的也一樣
  await sql`update prizes set status = 'shipped' where id = ${pz}`
  ck('已寄出也回 null', (await offerRow(buyer, 'outgoing', oid))?.stash === null)

  /* 「沒有到期日的卡」在今天的 schema 裡造不出來：prizes.stash_expires_at
     是 NOT NULL。程式碼裡仍然留著那個 null 防線，因為那一欄的語意已經是
     「只在 stashed 期間有意義」（039），哪天有人把它放寬成可為空，
     這支端點不該因此回一個編出來的 0。這一行釘的是「今天確實還是 NOT NULL」——
     它變了，上面那句註解就要重寫。 */
  const [col] = await sql<{ is_nullable: string }[]>`
    select is_nullable from information_schema.columns
     where table_name = 'prizes' and column_name = 'stash_expires_at'
  `
  ck('stash_expires_at 目前是 NOT NULL（所以「沒有到期日」造不出來）',
    col?.is_nullable === 'NO', String(col?.is_nullable))

  /* 已經過期的用負數，讓前端分得出「快到了」與「早就過了」 */
  const over = await seedStashed('u-seller', 'u-holder', -3, '早就過期的卡')
  const overRow = await offerRow(buyer, 'outgoing', await offer(buyer, over, 1100))
  ck('過期的回負數而不是 0',
    typeof overRow?.stash?.daysLeft === 'number' && overRow.stash.daysLeft < 0,
    JSON.stringify(overRow?.stash))
}

/* ────────────────────────────────────────────────────────────────────
   6 權限：別人的邀約看不到
   ──────────────────────────────────────────────────────────────────── */
head('6 權限：不是當事人就什麼都看不到')

{
  const pz = await seedStashed('u-seller', 'u-holder', 7, '路人不該看到的卡')
  const oid = await offer(buyer, pz, 2600)

  const box = await json(await call(stranger, '/v1/social/trade-offers'))
  const seen = [...(box.incoming as Any[]), ...(box.outgoing as Any[])].some(o => o.id === oid)
  ck('路人的收發匣裡沒有這筆邀約', !seen, JSON.stringify(box).slice(0, 200))
  note('天數塞在列表裡而不是另開 /trade-offers/:id/stash，權限就直接沿用列表的；')
  note('多一支用 offer id 定址的端點，就多一個要自己驗身分的地方。')

  const anon = await fetch(`${base}/v1/social/trade-offers`)
  ck('未登入拿不到列表', anon.status === 401, String(anon.status))
}

/* ────────────────────────────────────────────────────────────────────
   7 同一個資訊只有一份答案
   ──────────────────────────────────────────────────────────────────── */
head('7 跟市場那支對同一張卡給出相同的答案')

{
  const pz = await seedStashed('u-seller', 'u-holder', 9, '兩條路都問得到的卡')
  const oid = await offer(buyer, pz, 2700)
  const viaOffer = (await offerRow(buyer, 'outgoing', oid))?.stash

  /* 同一張卡改走市場：上架之後 delivery = 'vault'，市場那支才回得出東西。
     上架會把 status 推離 stashed，所以順序只能是「先問邀約、再上架問市場」。 */
  const lid = await listFor(seller, pz, 3000)
  const viaMarket = (await json(await call(buyer, `/v1/orders/listings/${lid}/stash`))).stash

  ck('市場那支也回得出來', !!viaMarket, JSON.stringify(viaMarket))
  ck('daysLeft 逐字相同', viaOffer?.daysLeft === viaMarket?.daysLeft,
    `邀約 ${viaOffer?.daysLeft} / 市場 ${viaMarket?.daysLeft}`)
  ck('totalDays 相同（同一個 STASH_DAYS）', viaOffer?.totalDays === viaMarket?.totalDays,
    `${viaOffer?.totalDays} / ${viaMarket?.totalDays}`)
  ck('expiresAt 相同（同一列資料）', viaOffer?.expiresAt === viaMarket?.expiresAt,
    `${viaOffer?.expiresAt} / ${viaMarket?.expiresAt}`)
  ck('heldByOther 相同', viaOffer?.heldByOther === viaMarket?.heldByOther,
    `${viaOffer?.heldByOther} / ${viaMarket?.heldByOther}`)
  note('抽不成共用函式是這一輪的檔案界線（orders.ts 由另一條線持有），')
  note('所以由這一組釘住。兩邊只要有一邊改了進位或門檻，這裡就會紅。')

  // 上架之後卡離開 stashed，邀約那一側就該說「沒有這個資訊」
  ck('上架後邀約那一側改回 null', (await offerRow(buyer, 'outgoing', oid))?.stash === null)
}

console.log(`\n${pass} passed / ${fail} failed`)
await sql.end({ timeout: 5 })
process.exit(fail ? 1 : 0)
