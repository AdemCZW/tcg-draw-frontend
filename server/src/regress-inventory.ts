/**
 * A-4 的迴歸測試：**裸卡也要有「一張實體卡一列」的庫存防線**。
 *
 * ── 這一支要釘住的那句話 ────────────────────────────────────────────
 * 023 只讓帶鑑定編號的獎品進卡冊；裸卡沒有那條路，於是**同一張實體裸卡
 * 可以同時放進無限多個池**，抽到的人拿不到卡。prizes_cert_alive
 * （unique(grader, cert_no)）擋不到它 —— 裸卡沒有編號，索引的述詞
 * `where cert_no is not null` 直接跳過。
 *
 * 補上的不是第二條索引，是**結構**：獎品指名它押的是卡冊裡哪一列
 * （`prizeId` → `pool_prizes.card_id`），那一列在交易裡被鎖住、
 * 只收自己的 `in_book`、轉成 `in_pool`。一列卡只有一個 status，
 * 物理上不可能同時 in_pool 兩次。
 *
 * ── 這支同時把「改之前真的會過」記錄下來 ────────────────────────────
 * 第 0 組跑的是**沒有 prizeId 的舊路徑**，而它現在**仍然會成功** ——
 * 那是這一輪已知還開著的缺口（把 prizeId 改成必填會讓 smoke.ts 十幾處
 * 直接送內嵌卡片的建池斷言全部倒下，而那支檔案這一輪不能改）。
 * 這一組刻意留著並印出來：一個沒有被寫下來的缺口跟一個不存在的缺口
 * 在測試報告上長得一模一樣。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   createdb vd_inv
 *   DATABASE_URL=postgres://localhost:5432/vd_inv JWT_SECRET=<32+> \
 *     npx tsx src/migrate.ts && npx tsx src/seed.ts
 *   DATABASE_URL=... JWT_SECRET=... PORT=8093 DEV_LOGIN=1 DEV_LOGIN_SECRET=<32+> \
 *     npx tsx src/index.ts
 *   DATABASE_URL=... DEV_LOGIN_SECRET=<同值> \
 *     npx tsx src/regress-inventory.ts http://localhost:8093
 *
 * ⚠️ **要有自己的乾淨資料庫，不能跟 smoke 共用**（理由同 regress-pledge.ts：
 * 兩邊都會消耗種子資料、smoke 會把 u-seller 推到違約停權門檻）。
 * 第 6 組會**刻意壓死鎖的佈景**，伺服器 stdout 出現 40P01 不代表失敗 ——
 * 看的是 `pg_stat_database.deadlocks` 的增量。
 */
import { randomBytes } from 'node:crypto'
import { sql } from './db.js'

const base = (process.argv[2] ?? 'http://localhost:8093').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
if (!devSecret) throw new Error('regress-inventory 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const json = (r: Response): Promise<Any> => r.json()
let pass = 0, fail = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
const note = (s: string) => console.log(`       ${s}`)
const head = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 54 - s.length))}`)

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

const platform = await login('platform', 'VaultDraw 官方')
/* 用已經完成過池的種子賣家，避開「第一個池額度上限」那道閘。 */
const seller = await login('seller', '測試賣家')
await call(platform, '/v1/admin/grant', { userId: 'u-seller', points: 9_000_000, note: 'A-4 測試' })

/** 登記一張**裸卡**（沒有鑑定編號）進卡冊，回傳那一列的 id */
async function registerBare(tok: string, name: string): Promise<string> {
  const r = await call(tok, '/v1/cardbook/upload', {
    card: { name, setCode: 'sv8a', cardNo: '237/187', artId: 'SV8a-237', refPrice: 900 }
  })
  const b = await json(r.clone())
  if (!r.ok) throw new Error(`登記裸卡失敗 ${r.status} ${JSON.stringify(b)}`)
  return b.prize.id as string
}

/**
 * 直接寫一列裸卡進卡冊（**素材用**，不打 API）。
 *
 * 為什麼不一律走 /v1/cardbook/upload：那支有速率限制（40 張／15 分鐘，
 * routes/cardbook.ts 的 card-upload-user 桶），而第 6 組一輪就要五張、
 * 跑十二輪。用 API 產素材的話這支測試會在第九輪被自己的限流擋掉 ——
 * 那是限流正確運作，不是這一支要驗的東西。
 * 「登記這條路真的走得通」由第 1 組用真的 API 驗一次就夠。
 * 欄位比照 routes/cardbook.ts 的 insert（in_book、origin upload、
 * custodian = 自己、pool_id / tier 都是 null）。
 */
async function seedBare(userId: string, name: string): Promise<string> {
  const id = 'pz-inv-' + randomBytes(6).toString('hex')
  const now = Date.now()
  await sql`
    insert into prizes (id, user_id, pool_id, card, tier, status,
                        won_at, acquired_at, stash_expires_at,
                        grader, cert_no, custodian_id, origin)
    values (${id}, ${userId}, null,
            ${sql.json({ id: 'c-' + id, name, setCode: 'sv8a', cardNo: '237/187',
                         artId: 'SV8a-237', image: '', language: 'JP',
                         grader: null, grade: null, certNo: null,
                         refPrice: 900, variantId: null })},
            null, 'in_book', ${now}, ${now}, ${now + 90 * 86_400_000},
            null, null, ${userId}, 'upload')
  `
  return id
}

/** 登記一張**帶編號**的卡，回傳 { id, certNo } */
async function registerCert(tok: string, name: string) {
  const certNo = `INV-${uniq()}`
  const r = await call(tok, '/v1/cardbook/upload', {
    card: {
      name, setCode: 'sv4a', cardNo: '349/190', artId: 'SV4a-349',
      grader: 'PSA', grade: 10, certNo, refPrice: 26000
    }
  })
  const b = await json(r.clone())
  if (!r.ok) throw new Error(`登記鑑定卡失敗 ${r.status} ${JSON.stringify(b)}`)
  return { id: b.prize.id as string, certNo }
}

/** 一張卡一籤的池。cards 每一項都是卡冊裡的一列 */
const pledgePool = (tok: string, title: string, cards: { id: string; name: string }[]) =>
  call(tok, '/v1/pools', {
    mode: 'muteki', title, ticketPrice: 500, totalTickets: cards.length, days: 7,
    prizes: cards.map(c => ({
      tier: 'A' as const, prizeId: c.id, total: 1,
      card: { id: 'c-' + c.id, name: c.name }
    })),
    tierBuyback: { A: 260 }
  })

const cardRow = async (id: string) =>
  (await sql`select id, user_id, status, pool_id from prizes where id = ${id}`)[0] as Any

// ───────────────────────────────────────────────────────────────────
head('0 舊路徑（沒有 prizeId）—— 已知還開著的缺口')
{
  const bare = { id: 'c-bare', name: `舊路徑裸卡 ${uniq()}` }
  const mk = (t: string) => call(seller, '/v1/pools', {
    mode: 'muteki', title: t, ticketPrice: 500, totalTickets: 3, days: 7,
    prizes: [{ tier: 'A', card: bare, total: 3 }], tierBuyback: { A: 260 }
  })
  const codes: number[] = []
  for (let i = 0; i < 3; i++) codes.push((await mk(`舊路徑池 ${uniq()}`)).status)
  ck('★ 內嵌裸卡仍然可以連開三個池（缺口存在，不是被修掉了）',
    codes.every(s => s === 200), `狀態碼 = ${codes.join(', ')}`)
  const [n] = await sql<{ n: string }[]>`
    select count(*)::text as n from prizes
     where user_id = 'u-seller' and status = 'in_pool' and card->>'name' = ${bare.name}`
  ck('而且卡冊裡一列都沒有被押住（這就是漏洞的樣子）', Number(n?.n ?? -1) === 0, `in_pool 列數 = ${n?.n}`)
  note('這一組是刻意留著的紅線：把 prizeId 改成必填才會關掉它，見檔頭。')
}

// ───────────────────────────────────────────────────────────────────
head('1 押記：裸卡從卡冊進池')
let firstPool = ''
let bareId = ''
{
  const name = `押記裸卡 ${uniq()}`
  bareId = await registerBare(seller, name)
  ck('登記完是 in_book', (await cardRow(bareId))?.status === 'in_book')

  const r = await pledgePool(seller, `A-4 押記池 ${uniq()}`, [{ id: bareId, name }])
  const b = await json(r.clone())
  ck('帶 prizeId 開池成功', r.ok, `${r.status} ${JSON.stringify(b).slice(0, 200)}`)
  firstPool = b.poolId as string

  const row = await cardRow(bareId)
  ck('★ 那一列轉成 in_pool', row?.status === 'in_pool', `status=${row?.status}`)
  ck('而且記得自己押在哪個池（解押靠這一欄）', row?.pool_id === firstPool, `pool_id=${row?.pool_id}`)

  const [pp] = await sql`select id, card_id, total from pool_prizes where pool_id = ${firstPool}`
  ck('pool_prizes.card_id 指著那一列', (pp as Any)?.card_id === bareId, `card_id=${(pp as Any)?.card_id}`)
  ck('而且 total = 1（一張實體卡一個籤位）', Number((pp as Any)?.total) === 1)
}

// ───────────────────────────────────────────────────────────────────
head('2 ★ 同一張裸卡不能開進第二個池（A-4 的核心）')
{
  const r = await pledgePool(seller, `A-4 第二個池 ${uniq()}`, [{ id: bareId, name: '押記裸卡' }])
  const b = await json(r.clone())
  ck('★ 第二個池被擋下', !r.ok, `${r.status} ${JSON.stringify(b).slice(0, 200)}`)
  ck('而且不是 500（講得出原因）', r.status === 409, `status=${r.status}`)
  ck('錯誤碼是 CARD_BUSY', b.error === 'CARD_BUSY', String(b.error))
  ck('訊息指得出是哪一張卡', typeof b.message === 'string' && b.message.includes('押記裸卡'),
    String(b.message).slice(0, 120))
  const [n] = await sql<{ n: string }[]>`
    select count(*)::text as n from pool_prizes where card_id = ${bareId}`
  ck('資料庫裡那張卡只被一個獎品指著', Number(n?.n) === 1, `pool_prizes 列數 = ${n?.n}`)
}

// ───────────────────────────────────────────────────────────────────
head('3 其他拒絕路徑')
{
  const a = await seedBare('u-seller', `重複挑 ${uniq()}`)
  const dup = await call(seller, '/v1/pools', {
    mode: 'muteki', title: `重複挑 ${uniq()}`, ticketPrice: 500, totalTickets: 2, days: 7,
    prizes: [
      { tier: 'A', prizeId: a, card: { id: 'c1', name: '重複挑' }, total: 1 },
      { tier: 'A', prizeId: a, card: { id: 'c1', name: '重複挑' }, total: 1 }
    ], tierBuyback: { A: 260 }
  })
  const dj = await json(dup.clone())
  ck('同一張卡在同一個池裡放兩次被擋', dup.status === 400 && dj.error === 'CARD_DUPLICATED',
    `${dup.status} ${JSON.stringify(dj).slice(0, 160)}`)
  ck('那張卡沒有被押掉（整筆回滾）', (await cardRow(a))?.status === 'in_book')

  const many = await call(seller, '/v1/pools', {
    mode: 'muteki', title: `一卡多籤 ${uniq()}`, ticketPrice: 500, totalTickets: 3, days: 7,
    prizes: [{ tier: 'A', prizeId: a, card: { id: 'c1', name: '重複挑' }, total: 3 }],
    tierBuyback: { A: 260 }
  })
  ck('一張卡開 3 籤被擋（total > 1 的語意換位置了）', many.status === 400, String(many.status))
  ck('而且講得出「挑 N 張卡」', (await many.clone().text()).includes('N 張卡'))

  const ghost = await pledgePool(seller, `不存在的卡 ${uniq()}`, [{ id: 'pz-up-000000000000', name: '幽靈' }])
  const gj = await json(ghost.clone())
  ck('指名一列不存在的卡 → 404 CARD_NOT_FOUND', ghost.status === 404 && gj.error === 'CARD_NOT_FOUND',
    `${ghost.status} ${JSON.stringify(gj).slice(0, 160)}`)

  /* 別人的卡：回的必須跟「不存在」**同一句話**。分開講等於用一個別人的
     prizeId 就能問出「這張卡存在而且不是你的」。 */
  const other = await login('invthief', '別人')
  const mine = await seedBare('u-seller', `別人想押 ${uniq()}`)
  await call(platform, '/v1/admin/grant', { userId: 'u-invthief', points: 500_000, note: 'A-4 測試' })
  /* 這個帳號要是一個**過得了前面所有閘**的賣家，不然「押不進來」可能是
     被 NOT_SELLER 擋掉的，那就驗不到押記那一層。第一個池的額度上限也要
     避開（給他一個已經 revealed 的池，見 routes/pools.ts 的 FIRST_POOL_CAP）。 */
  await sql`insert into sellers (id, handle, name, origin, tier, bio)
            values ('u-invthief', 'invthief', '賊', 'personal', 'verified', '測試')
            on conflict (id) do update set tier = 'verified'`
  const stolen = await pledgePool(other, `偷押 ${uniq()}`, [{ id: mine, name: '別人想押' }])
  const sj = await json(stolen.clone())
  ck('★ 別人的卡押不進來', !stolen.ok, `${stolen.status}`)
  ck('而且訊息跟「卡不在了」一字不差（不洩漏這張卡存在）',
    stolen.status === 404 && sj.error === 'CARD_NOT_FOUND', `${stolen.status} ${sj.error}`)
  ck('那張卡沒有被動到', (await cardRow(mine))?.status === 'in_book')
}

// ───────────────────────────────────────────────────────────────────
head('4 卡片身分以卡冊那一列為準（押 A 卡宣告成 B 卡）')
{
  const realName = `真身分 ${uniq()}`
  const id = await seedBare('u-seller', realName)
  const r = await call(seller, '/v1/pools', {
    mode: 'muteki', title: `冒名 ${uniq()}`, ticketPrice: 500, totalTickets: 1, days: 7,
    prizes: [{
      tier: 'A', prizeId: id, total: 1,
      card: { id: 'c-lie', name: '噴火龍 ex SAR', setCode: 'sv4a', cardNo: '349/190', certNo: '99999999' }
    }],
    tierBuyback: { A: 260 }
  })
  ck('開得起來', r.ok, `${r.status} ${await r.clone().text()}`)
  const b = await json(r)
  const snap = await json(await fetch(`${base}/v1/pools/${b.poolId}`))
  const shown = snap.pool?.prizes?.[0]?.card
  ck('★ 池裡顯示的是卡冊那一張，不是呼叫端宣告的那一張',
    shown?.name === realName, `name=${shown?.name}`)
  const [pz] = await sql`select cert_no from prizes where id = ${id}`
  ck('也沒有被塞上一個假的鑑定編號', (pz as Any)?.cert_no === null, String((pz as Any)?.cert_no))
}

// ───────────────────────────────────────────────────────────────────
head('5 併發：兩個請求同時拿同一張卡開池')
{
  const id = await seedBare('u-seller', `併發 ${uniq()}`)
  const [r1, r2] = await Promise.all([
    pledgePool(seller, `併發 A ${uniq()}`, [{ id, name: '併發' }]),
    pledgePool(seller, `併發 B ${uniq()}`, [{ id, name: '併發' }])
  ])
  const ok = [r1, r2].filter(r => r.ok).length
  const bad = [r1, r2].filter(r => !r.ok)
  ck('★ 只成功一筆', ok === 1, `成功 ${ok} 筆（${r1.status} / ${r2.status}）`)
  ck('另一筆乾淨地失敗，不是 500', bad.every(r => r.status < 500), bad.map(r => r.status).join(','))
  for (const r of bad) note(`      輸的那筆：${r.status} ${(await r.clone().text()).slice(0, 140)}`)
  const [n] = await sql<{ n: string }[]>`select count(*)::text as n from pool_prizes where card_id = ${id}`
  ck('資料庫裡只有一個獎品指著它', Number(n?.n) === 1, `pool_prizes 列數 = ${n?.n}`)
}

// ───────────────────────────────────────────────────────────────────
head('6 死結：兩個賣家各拿一組交錯的卡同時開池')
{
  const deadlocks = async () => Number(
    (await sql<{ n: string }[]>`
      select deadlocks::text as n from pg_stat_database where datname = current_database()`)[0]?.n ?? 0)

  const shop = await login('shop', '關都卡舖')
  await call(platform, '/v1/admin/grant', { userId: 'u-shop', points: 9_000_000, note: 'A-4 測試' })

  const ROUNDS = 12
  const before = await deadlocks()
  let errs = 0
  for (let round = 0; round < ROUNDS; round++) {
    /* 交錯的關鍵：兩邊各自持有三張卡，而**送出的順序相反**。
       沒有 `order by id` 的批次上鎖時，這正是一個環：
       A 先鎖 x1 再要 x3，B 先鎖 x3 再要 x1。
       這裡兩個賣家各開自己的卡（押記本來就只收自己的），所以環要靠
       「同一批 id 兩種順序」製造 —— 用同一個賣家的兩筆請求。 */
    const names = [`死結 ${uniq()}`, `死結 ${uniq()}`, `死結 ${uniq()}`]
    const ids = [] as string[]
    for (const n of names) ids.push(await seedBare('u-seller', n))
    const asc = ids.map((id, i) => ({ id, name: names[i]! }))
    const desc = [...asc].reverse()
    const shopNames = [`死結商 ${uniq()}`, `死結商 ${uniq()}`]
    const shopIds = [] as string[]
    for (const n of shopNames) shopIds.push(await seedBare('u-shop', n))
    const shopCards = shopIds.map((id, i) => ({ id, name: shopNames[i]! }))

    const rs = await Promise.all([
      pledgePool(seller, `死結池 A ${uniq()}`, asc),
      pledgePool(seller, `死結池 B ${uniq()}`, desc),
      pledgePool(shop, `死結池 C ${uniq()}`, shopCards),
      pledgePool(shop, `死結池 D ${uniq()}`, [...shopCards].reverse())
    ])
    for (const r of rs) if (r.status >= 500) errs++
  }
  const delta = await deadlocks() - before
  note(`pg_stat_database.deadlocks 增量 = ${delta}（${ROUNDS} 輪 × 4 筆並行建池）`)
  ck('★ 死結增量為 0', delta === 0, `增量 = ${delta}`)
  ck('而且沒有任何一筆變成 500', errs === 0, `500 的筆數 = ${errs}`)
}

// ───────────────────────────────────────────────────────────────────
head('7 收攤／到期 → 解押回卡冊 → **真的能再開池**')
{
  const name = `解押 ${uniq()}`
  const id = await seedBare('u-seller', name)
  const p = await json(await pledgePool(seller, `解押池 ${uniq()}`, [{ id, name }]))
  ck('素材：卡押進池了', (await cardRow(id))?.status === 'in_pool')

  /* 收攤要 open 才按得下去；建池只到 committed（要等 drand 的未來輪次）。
     正式環境靠 sweepPools，測試裡直接推。 */
  let opened = false
  for (let i = 0; i < 60 && !opened; i++) {
    const r = await json(await call(seller, `/v1/pools/${p.poolId}/open`, {}))
    opened = !!r.opened
    if (!opened) await new Promise(res => setTimeout(res, 1000))
  }
  ck('素材：池開賣了', opened)
  const closed = await call(seller, `/v1/pools/${p.poolId}/close`, {})
  ck('素材：收攤成功', closed.ok, `${closed.status} ${await closed.clone().text()}`)
  const revealed = await call(seller, `/v1/pools/${p.poolId}/reveal`, {})
  ck('素材：揭曉成功（解押掛在這一步）', revealed.ok, `${revealed.status} ${await revealed.clone().text()}`)

  ck('★ 沒被抽走的卡解押回 in_book', (await cardRow(id))?.status === 'in_book',
    String((await cardRow(id))?.status))

  /* 只看欄位不算數：真正要驗的是「它能不能再被拿去開池」——
     A-5／034 那兩條 bug 的形狀就是「欄位看起來對，但每一條路都拒絕它」。 */
  const again = await pledgePool(seller, `解押後再開 ${uniq()}`, [{ id, name }])
  ck('★ 而且真的能再開一個池（打真的 API）', again.ok, `${again.status} ${await again.clone().text()}`)
  ck('再開之後又是 in_pool', (await cardRow(id))?.status === 'in_pool')
}

// ───────────────────────────────────────────────────────────────────
head('8 反向：正常的池都還開得起來（沒有誤擋）')
{
  // 帶編號的卡，從卡冊挑
  const c = await registerCert(seller, `鑑定卡 ${uniq()}`)
  const r1 = await pledgePool(seller, `鑑定卡池 ${uniq()}`, [{ id: c.id, name: '鑑定卡' }])
  ck('卡冊裡的鑑定卡開得起來', r1.ok, `${r1.status} ${await r1.clone().text()}`)
  ck('那一列也轉成 in_pool', (await cardRow(c.id))?.status === 'in_pool')

  // 舊路徑：內嵌鑑定卡（023 的路，不帶 prizeId）
  const legacyCert = `INV-LEGACY-${uniq()}`
  const r2 = await call(seller, '/v1/pools', {
    mode: 'muteki', title: `舊路徑鑑定卡 ${uniq()}`, ticketPrice: 500, totalTickets: 2, days: 7,
    prizes: [
      { tier: 'A', card: { id: 'c-l', name: '舊路徑鑑定卡', grader: 'PSA', grade: 10, certNo: legacyCert }, total: 1 },
      { tier: 'D', card: { id: 'c-p', name: '舊路徑裸卡' }, total: 1 }
    ], tierBuyback: { A: 260, D: 200 }
  })
  ck('023 的舊路徑沒有被打壞（內嵌鑑定卡照樣開得起來）', r2.ok, `${r2.status} ${await r2.clone().text()}`)
  const [legacyRow] = await sql`select status from prizes where cert_no = ${legacyCert}`
  ck('而且它照樣被押進卡冊', (legacyRow as Any)?.status === 'in_pool', String((legacyRow as Any)?.status))

  // 混合：一張卡冊卡 + 一張內嵌裸卡
  const mixName = `混合 ${uniq()}`
  const mixId = await seedBare('u-seller', mixName)
  const r3 = await call(seller, '/v1/pools', {
    mode: 'muteki', title: `混合池 ${uniq()}`, ticketPrice: 500, totalTickets: 3, days: 7,
    prizes: [
      { tier: 'A', prizeId: mixId, card: { id: 'c-m', name: mixName }, total: 1 },
      { tier: 'D', card: { id: 'c-x', name: '內嵌普卡' }, total: 2 }
    ], tierBuyback: { A: 260, D: 200 }
  })
  ck('混合池（卡冊卡 + 內嵌裸卡）開得起來', r3.ok, `${r3.status} ${await r3.clone().text()}`)
  ck('卡冊那一張被押住', (await cardRow(mixId))?.status === 'in_pool')
}

// ───────────────────────────────────────────────────────────────────
head('9 官方池／商家池沒有被誤傷')
{
  /* 官方池與商家池目前都是 seed.ts **直接寫資料庫**建的，不走這支 API
     （seed.ts:238 起的 p-official-*）。所以這次改動照定義碰不到它們 ——
     下面兩條驗的是「它們還在、還開得動」，以及「u-official 走 API
     也照樣開得起來」（origin 不是門檻，卡冊才是）。 */
  const [n] = await sql<{ n: string }[]>`
    select count(*)::text as n from pools where seller_id = 'u-official'`
  ck('種子的官方池還在', Number(n?.n) > 0, `官方池數 = ${n?.n}`)
  const [seeded] = await sql<{ n: string }[]>`
    select count(*)::text as n from pool_prizes pp join pools p on p.id = pp.pool_id
     where p.seller_id = 'u-official' and pp.card_id is null`
  ck('它們的獎品 card_id 是 null（走舊路徑，036 沒有回填它們）', Number(seeded?.n) > 0,
    `card_id is null 的官方獎品 = ${seeded?.n}`)

  /* 種子的 u-official 登不進來（dev-login 算的是 'u-' + handle = u-vaultdraw，
     而種子那一列的 id 是 u-official —— auth.ts 的 ensureUser 撞到 handle
     唯一鍵時 do nothing，回的仍然是它自己算的 id，那個帳號並不存在）。
     所以這裡另開一個 origin = 'official' 的賣家來驗**同一件事**：
     官方身分不是這條路的門檻，卡冊才是。 */
  const official = await login('invofficial', '官方自營測試')
  await call(platform, '/v1/admin/grant', { userId: 'u-invofficial', points: 5_000_000, note: 'A-4 測試' })
  await sql`insert into sellers (id, handle, name, origin, tier, bio)
            values ('u-invofficial', 'invofficial', '官方自營測試', 'official', 'trusted', '測試')
            on conflict (id) do update set origin = 'official', tier = 'trusted'`
  const oname = `官方卡 ${uniq()}`
  const oid = await seedBare('u-invofficial', oname)
  const r = await pledgePool(official, `官方新池 ${uniq()}`, [{ id: oid, name: oname }])
  ck('★ origin = official 的賣家走同一條路照樣開得起來', r.ok, `${r.status} ${await r.clone().text()}`)

  const shop = await login('shop', '關都卡舖')
  const sname = `商家卡 ${uniq()}`
  const sid = await seedBare('u-shop', sname)
  const r2 = await pledgePool(shop, `商家新池 ${uniq()}`, [{ id: sid, name: sname }])
  ck('商家賣家也是', r2.ok, `${r2.status} ${await r2.clone().text()}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
await sql.end()
process.exit(fail ? 1 : 0)
