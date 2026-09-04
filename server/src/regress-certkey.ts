/**
 * U-2 的迴歸測試：**市場的唯一鍵少了 grader**。
 *
 * ── 這一支要釘住的那句話 ────────────────────────────────────────────
 * `001_init.sql:46` 的 `listings_cert_live` 是 `unique(cert_no) where status='live'`。
 * 編號本身不是一張卡的身分 —— **發證單位＋編號**才是。
 * PSA #12345678 和 BGS #12345678 是兩張完全不同的實體卡，八位數編號
 * 撞號是遲早的事。舊索引會把第二個人擋在「這個編號已經有人上架了」，
 * 而他做的事完全正當，也沒有任何自救的路（他總不能去改 BGS 的編號）。
 *
 * 卡冊那一側（`prizes_cert_alive`，preflight.ts 建）**早就是**
 * `unique(grader, cert_no)`。兩側不一致本身就是問題：同一個判斷
 * 「這張卡是不是已經被登記／上架了」在兩個地方有兩種答案。
 *
 * ── 兩條缺一不可 ────────────────────────────────────────────────────
 * 第 2 組（放寬）跟第 3 組（仍要擋）是同一件事的兩面。放寬唯一鍵最容易
 * 犯的錯是**放寬過頭** —— 只跑第 2 組的話，把索引整條刪掉也會全綠，
 * 而那正是一卡多賣。所以第 3 組用直接寫 DB 的方式（繞過應用層）確認
 * 同 grader 同編號的第二筆 live 掛單仍然撞 23505：那是資料庫層的保證，
 * 不是應用層的檢查（001_init.sql:44 已經寫過這條教訓）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   createdb vd_certkey
 *   DATABASE_URL=postgres://localhost:5432/vd_certkey JWT_SECRET=<32+> \
 *     npx tsx src/migrate.ts && npx tsx src/seed.ts
 *   DATABASE_URL=... JWT_SECRET=... PORT=8097 DEV_LOGIN=1 DEV_LOGIN_SECRET=<32+> \
 *     npx tsx src/index.ts
 *   DATABASE_URL=... DEV_LOGIN_SECRET=<同值> \
 *     npx tsx src/regress-certkey.ts http://localhost:8097
 *
 * ⚠️ 要有自己的乾淨資料庫，不要跟 smoke 共用（理由同 regress-inventory.ts）。
 */
import { randomBytes } from 'node:crypto'
import { sql } from './db.js'

const base = (process.argv[2] ?? 'http://localhost:8097').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
if (!devSecret) throw new Error('regress-certkey 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')

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
  return (await json(r)) as { token: string; userId: string }
}
const call = (t: string, p: string, b?: unknown) =>
  fetch(`${base}${p}`, {
    method: b === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    ...(b === undefined ? {} : { body: JSON.stringify(b) })
  })

/* 每次跑都換一組編號：這支會留下 live 掛單（不清庫也能重跑），
   固定編號的話第二次跑會撞到第一次自己留下的資料。 */
const RUN = randomBytes(3).toString('hex').toUpperCase()
let seq = 0
const cert = () => `${RUN}${String(++seq).padStart(5, '0')}`

/**
 * 登記一張卡進卡冊，回傳那一列的 id。
 * grader / certNo 都給 null 就是裸卡。
 */
async function register(tok: string, grader: string | null, certNo: string | null) {
  const r = await call(tok, '/v1/cardbook/upload', {
    card: {
      name: '測試卡 ' + (certNo ?? '裸'), setCode: 'sv8a', cardNo: '237/187',
      artId: 'SV8a-237', language: 'JP', grader, grade: grader ? 10 : null,
      certNo, refPrice: 900
    }
  })
  const b = await json(r.clone())
  return { status: r.status, body: b, id: b?.prize?.id as string | undefined }
}

/** 上架。價格刻意壓到 1 點：保證金是價格的 10%（escrow.ts 的 depositFor），
    1 點四捨五入之後是 0，測試帳號就不需要先儲值 —— 這支要驗的是唯一鍵，
    不是保證金。 */
async function list(tok: string, prizeId: string, price = 1) {
  const r = await call(tok, '/v1/listings', { prizeId, price })
  return { status: r.status, body: await json(r) }
}
async function delist(tok: string, listingId: string) {
  const r = await call(tok, `/v1/listings/${listingId}/delist`, {})
  return { status: r.status, body: await json(r) }
}

/** 直接寫一列掛單（**繞過應用層**）。第 3 組要驗的是索引本身，
    不是路由的檢查 —— 應用層的檢查擋不住併發，只有索引擋得住。 */
async function rawListing(sellerId: string, card: Record<string, unknown>, certNo: string | null, status = 'live') {
  const id = 'l-ck-' + randomBytes(5).toString('hex')
  try {
    await sql`
      insert into listings (id, card, price, seller_id, seller_name, delivery, cert_no, status)
      values (${id}, ${card as never}, 100, ${sellerId}, '測試賣家', 'ship', ${certNo}, ${status})
    `
    return { ok: true as const, id }
  } catch (e) {
    const pg = e as { code?: string; constraint_name?: string; message?: string }
    return { ok: false as const, code: pg.code, constraint: pg.constraint_name, message: pg.message }
  }
}

const graded = (grader: string, certNo: string) => ({
  id: 'c-ck', name: '測試卡', setCode: 'sv8a', cardNo: '237/187', artId: 'SV8a-237',
  language: 'JP', grader, grade: 10, certNo, image: '', refPrice: 900
})

const A = await login('certkey-a', '玩家 A')
const B = await login('certkey-b', '玩家 B')
const C = await login('certkey-c', '玩家 C')

/* ── 第 1 組：索引的形狀 ──────────────────────────────────────────── */
head('1 索引本身：唯一鍵要含 grader')
{
  const [ix] = await sql<{ def: string }[]>`
    select indexdef as def from pg_indexes
     where schemaname = 'public' and indexname = 'listings_cert_live'
  `
  ck('listings_cert_live 存在', !!ix, JSON.stringify(ix))
  ck('唯一鍵含 grader（改前是 unique(cert_no)，這條會失敗）',
    /grader/.test(ix?.def ?? ''), ix?.def ?? '(沒有這條索引)')
  ck('仍然只管 live 的掛單（述詞沒被放掉）',
    /status\s*=\s*'live'/.test(ix?.def ?? ''), ix?.def ?? '')
  ck('仍然只管有編號的掛單', /cert_no IS NOT NULL/i.test(ix?.def ?? ''), ix?.def ?? '')

  const [col] = await sql<{ gen: string | null }[]>`
    select is_generated as gen from information_schema.columns
     where table_name = 'listings' and column_name = 'grader'
  `
  ck('listings.grader 是從 card jsonb 算出來的欄位（寫入路不必記得填）',
    col?.gen === 'ALWAYS', JSON.stringify(col))
}

/* ── 第 2 組：核心 —— 不同鑑定公司、同一組數字，兩個人都要上得了架 ── */
head('2 PSA #N 與 BGS #N 是兩張卡：兩筆都要成功')
{
  const n = cert()
  note(`兩位玩家分別拿 PSA #${n} 與 BGS #${n} 上架`)
  const ra = await register(A.token, 'PSA', n)
  ck('A 把 PSA 那張登記進卡冊', ra.status === 200, JSON.stringify(ra.body))
  const rb = await register(B.token, 'BGS', n)
  ck('B 把 BGS 那張登記進卡冊（卡冊那側早就含 grader，本來就過）',
    rb.status === 200, JSON.stringify(rb.body))

  const la = await list(A.token, ra.id!)
  ck('A 上架成功', la.status === 200, JSON.stringify(la.body))
  const lb = await list(B.token, rb.id!)
  ck('B 上架成功 ← 改之前這一筆被誤擋（409 WRONG_STATE）',
    lb.status === 200, `${lb.status} ${JSON.stringify(lb.body)}`)

  const rows = await sql<{ grader: string | null }[]>`
    select grader from listings where cert_no = ${n} and status = 'live' order by grader
  `
  ck('兩筆 live 掛單並存，grader 各記各的',
    rows.length === 2 && rows[0]?.grader === 'BGS' && rows[1]?.grader === 'PSA',
    JSON.stringify(rows))
}

/* ── 第 3 組：反向 —— 放寬不能放寬過頭 ───────────────────────────── */
head('3 同 grader 同編號：第二筆 live 仍然要被資料庫擋下')
{
  const n = cert()
  const first = await rawListing(A.userId, graded('PSA', n), n)
  ck('第一筆 live 寫得進去', first.ok, JSON.stringify(first))
  const second = await rawListing(B.userId, graded('PSA', n), n)
  ck('第二筆撞唯一約束（23505）', !second.ok && second.code === '23505', JSON.stringify(second))
  ck('撞的是 listings_cert_live 這條（錯誤訊息才講得對）',
    !second.ok && second.constraint === 'listings_cert_live', JSON.stringify(second))

  /* 大小寫／空白：'psa' 與 'PSA ' 是同一家鑑定公司。不正規化的話，
     同一張實體卡換個大小寫就能再上架一次，索引等於白建。 */
  const third = await rawListing(C.userId, graded(' psa ', n), n)
  ck("grader 大小寫／空白不同（' psa '）也算同一家，照樣擋",
    !third.ok && third.code === '23505', JSON.stringify(third))
}

/* ── 第 4 組：狀態變化 —— 述詞 where status='live' 仍然正確 ────────── */
head('4 下架再上架、賣掉再上架')
{
  const n = cert()
  const r = await register(A.token, 'PSA', n)
  const l1 = await list(A.token, r.id!)
  ck('上架', l1.status === 200, JSON.stringify(l1.body))
  const d = await delist(A.token, l1.body.listing.id)
  ck('下架', d.status === 200, JSON.stringify(d.body))
  const l2 = await list(A.token, r.id!)
  ck('同一張卡下架後可以再上架（下架後那筆不是 live，不佔編號）',
    l2.status === 200, JSON.stringify(l2.body))

  /* 賣掉：站內轉手之後同一個編號會再出現一筆 live 掛單，那是正常的
     交易歷史。索引只看 live，所以歷史上的 sold 不佔位。 */
  await sql`update listings set status = 'sold' where id = ${l2.body.listing.id}`
  const again = await rawListing(B.userId, graded('PSA', n), n)
  ck('前一筆變成 sold 之後，同編號可以再上架一次（轉手）', again.ok, JSON.stringify(again))
  const dup = await rawListing(C.userId, graded('PSA', n), n)
  ck('但同時只能有一筆 live', !dup.ok && dup.code === '23505', JSON.stringify(dup))
}

/* ── 第 5 組：裸卡不會互相誤擋 ───────────────────────────────────── */
head('5 裸卡（grader 與 cert_no 都是 null）')
{
  const ids: string[] = []
  for (let i = 0; i < 3; i++) {
    const r = await register(A.token, null, null)
    ck(`第 ${i + 1} 張裸卡登記成功`, r.status === 200, JSON.stringify(r.body))
    ids.push(r.id!)
  }
  const results = []
  for (const id of ids) results.push(await list(A.token, id))
  ck('三張裸卡全部上架成功（索引的述詞是 cert_no is not null，裸卡不進索引）',
    results.every(x => x.status === 200), JSON.stringify(results.map(x => x.status)))

  /* 裸卡沒有唯一性防線是**已知**的（U-3）：擋住同一張實體裸卡被重複
     「使用」的是結構保證 —— 一列卡只有一個 status，上架後變 'listed'，
     而 'listed' 不在可上架的狀態裡。這一條把那個保證釘住，
     免得有人以為裸卡是靠索引擋的。 */
  const twice = await list(A.token, ids[0]!)
  ck('同一列裸卡不能上架兩次（靠 prizes.status，不是靠索引）',
    twice.status === 409, `${twice.status} ${JSON.stringify(twice.body)}`)
}

/* ── 第 6 組：被擋的時候要說得出是哪一家的哪一個編號 ──────────────── */
head('6 錯誤訊息')
{
  const n = cert()
  const ra = await register(A.token, 'PSA', n)
  const la = await list(A.token, ra.id!)
  ck('A 先上架', la.status === 200, JSON.stringify(la.body))

  /* 同一個 (grader, cert) 在卡冊那側就已經被 prizes_cert_alive 擋住了，
     所以 B 根本拿不到第二列可以上架的卡 —— 這正是兩側一致之後應有的
     樣子：問題在「登記」那一步就被講清楚，而不是拖到上架才爆。 */
  const rb = await register(B.token, 'PSA', n)
  ck('B 登記同一個 PSA 編號 → 卡冊那側先擋下，並指向接管流程',
    rb.status === 409 && rb.body?.error === 'CERT_ALREADY_LISTED',
    `${rb.status} ${JSON.stringify(rb.body)}`)

  /* 上架那條路自己的 409 訊息：要點名鑑定公司，不能只說「這個編號」——
     使用者手上可能真的有另一家的同號卡。 */
  const dup = await rawListing(B.userId, graded('PSA', n), n)
  ck('直接寫 DB 的重複仍被擋（上架路的 409 訊息由這條索引觸發）',
    !dup.ok && dup.constraint === 'listings_cert_live', JSON.stringify(dup))
}

/* ── 第 7 組：撞到索引時要回 409，不是 500 ───────────────────────── */
head('7 上架撞唯一索引：409 加一句人話，不是 500')
{
  /* 佈景：先直接寫一列 live 掛單（**只寫 listings，不寫 prizes**）。
     這正是舊資料的樣子 —— seed 的掛單、以及 036 之前一個編號開多籤
     發出去的那些卡，掛單的編號在 prizes 那側找不到對應的一列。
     於是 A 照樣登記得成（卡冊那側乾淨），卡在上架這一步。 */
  const n = cert()
  const pre = await rawListing(C.userId, graded('PSA', n), n)
  ck('先佈一列 live 掛單（只在 listings，繞過卡冊）', pre.ok, JSON.stringify(pre))

  const ra = await register(A.token, 'PSA', n)
  ck('A 登記同一個編號進卡冊（prizes 那側沒有這一列，所以過得了）',
    ra.status === 200, JSON.stringify(ra.body))
  const la = await list(A.token, ra.id!)
  /* 改之前這裡是 500 Internal Server Error：舊的 catch 包在 sql.begin
     **裡面**，而唯一約束一撞，交易在 Postgres 那端就已經中止，
     postgres.js 讓整個 begin 連同被接住的錯誤一起 reject。
     使用者拿到的是一句英文的伺服器錯誤，連「發生了什麼」都不知道。 */
  ck('回 409 不是 500', la.status === 409, `${la.status} ${JSON.stringify(la.body)}`)
  ck('訊息點名「同一家鑑定公司的同一個鑑定編號」，並指出下一步',
    typeof la.body?.message === 'string'
      && la.body.message.includes('鑑定公司')
      && la.body.message.includes('接管'),
    JSON.stringify(la.body))

  const [pz] = await sql<{ status: string }[]>`select status from prizes where id = ${ra.id!}`
  ck('失敗之後卡還在卡冊裡（交易有回滾，沒被標成 listed）',
    pz?.status === 'in_book', JSON.stringify(pz))
}

console.log(`\n${pass} passed / ${fail} failed`)
await sql.end()
process.exit(fail === 0 ? 0 : 1)
