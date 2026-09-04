/**
 * A-3（公開賣家列表：游標分頁 ＋ 批次聚合統計）的迴歸測試。
 *
 *   DATABASE_URL=... npx tsx src/regress-sellers.ts http://localhost:8091
 *
 * ⚠️ **要有自己的乾淨資料庫**（migrate 過的新庫，種子有沒有都行）：
 * 這支會直接寫入幾十位測試賣家與他們的池／抽卡／獎品／訂單，
 * 不該跑在別支測試預期特定種子狀態的庫上。
 *
 * ── 這支在守什麼 ──────────────────────────────────────────────────
 *
 * 批次聚合最容易出的錯不是「慢」，是**算到別人頭上**：
 * `group by` 少一欄、`partition by` 漏掉 seller_id、`join` 少一個條件，
 * 結果仍然是一份長得很正常的 JSON —— 每個數字都是合理的數字，
 * 只是屬於另一位賣家。這種錯沒有任何型別檢查抓得到。
 *
 * 所以這支的核心不是「新版回得出東西」，而是**拿改前那條路當 ground truth，
 * 逐位賣家、逐個欄位比對**。改前那五條 SQL 原文抄在 legacy() 裡：
 * 它就是 A-3 之前 routes/public.ts 的 sellerView()，一字未改。
 *
 * 第二個容易出的錯是「沒有池的賣家整列消失」—— 批次版如果用 inner join
 * 接統計，剛通過審核、還沒開過池的賣家就會從列表上不見。素材裡刻意放了
 * 四種空殼賣家（沒池、有池沒抽、只有訂單、什麼都沒有）。
 */
import { sql } from './db.js'

const base = (process.argv[2] ?? 'http://localhost:8091').replace(/\/$/, '')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
let pass = 0, fail = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
const head = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 52 - s.length))}`)
const get = async (p: string) => {
  const r = await fetch(`${base}${p}`)
  const txt = await r.text()
  let body: Any = null
  try { body = JSON.parse(txt) } catch { /* 非 JSON 就留 null，由呼叫端判斷 */ }
  return { status: r.status, body, txt }
}

/* =====================================================================
   素材
   ===================================================================== */

const RUN = String(Date.now()).slice(-9)
const card = (n: string) => ({ id: `c-${n}`, name: n, artId: 'SV4a-349', grader: 'PSA', grade: 10, refPrice: 26000 })

/**
 * 賣家的四種形狀都要造出來。
 *
 * shape 0 完整（池＋抽卡＋獎品＋訂單）、1 有池但沒人抽、2 只有訂單沒有池、
 * 3 什麼都沒有（剛通過審核）。後三種是「批次聚合會不會把人弄不見」的正靶：
 * 只有 shape 0 的資料集在 inner join 寫錯時仍然全綠。
 */
async function seed(n: number) {
  /* won_at 全站遞增且唯一 —— pastPrizes 的排序在改前只有 `order by won_at desc`，
     平手時順序未定義。素材不製造平手，比對才不會出現「兩邊都對但順序不同」
     的假失敗。 */
  let won = 1_600_000_000_000
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const shape = i % 4
    const sid = `rs${RUN}-${String(i).padStart(3, '0')}`
    const h = `VD-R${RUN.slice(-4)}${String(i).padStart(3, '0')}`
    ids.push(sid)
    await sql`insert into users (id, handle, name) values (${sid}, ${h}, ${'測試賣家' + i})`
    /* joined_at 拉開一分鐘一位：游標分頁的排序鍵就是它，全部同一個 now()
       會讓「翻頁不重不漏」退化成只驗到 id 那一半。 */
    await sql`insert into sellers (id, handle, name, origin, tier, bio, joined_at)
              values (${sid}, ${h}, ${'測試賣家' + i}, 'merchant', 'verified', ${'簡介' + i},
                      now() - (${n - i} || ' minutes')::interval)`
    const buyer = `rb${RUN}-${String(i).padStart(3, '0')}`
    await sql`insert into users (id, handle, name) values (${buyer}, ${'VD-Q' + RUN.slice(-4) + String(i).padStart(3, '0')}, ${'買家' + i})`

    if (shape === 0 || shape === 1) {
      /* 三種池狀態都要有：pools_run / total_tickets / top_advertised 只算
         open|sold_out|revealed，draft 與 cancelled 不算。分母算錯是最難看出來的錯。 */
      const statuses = ['open', 'revealed', 'draft', 'cancelled']
      for (let p = 0; p < statuses.length; p++) {
        const pid = `rp${RUN}-${i}-${p}`
        await sql`insert into pools (id, seller_id, mode, title, ticket_price, total_tickets, status)
                  values (${pid}, ${sid}, 'muteki', ${`池 ${i}-${p}`}, 2000, ${10 + p}, ${statuses[p]!})`
        for (const [tier, total] of [['A', 1], ['LAST', 1], ['D', 8]] as [string, number][]) {
          await sql`insert into pool_prizes (id, pool_id, tier, card, total)
                    values (${`rpp${RUN}-${i}-${p}-${tier}`}, ${pid}, ${tier}, ${sql.json(card('卡' + tier))}, ${total})`
        }
        if (shape !== 0) continue
        /* 每個池 12 筆獎品 —— 刻意多過 8，才驗得到「每位賣家各自取前 8」
           而不是「全體取前 8」。 */
        for (let d = 0; d < 12; d++) {
          const did = `rd${RUN}-${i}-${p}-${d}`
          await sql`insert into draws (id, pool_id, user_id, seats, cost, created_at)
                    values (${did}, ${pid}, ${buyer}, ${'{1}'}, 2000, ${won})`
          const tier = d % 3 === 0 ? 'A' : d % 3 === 1 ? 'LAST' : 'D'
          await sql`insert into prizes (id, user_id, pool_id, seat, draw_id, card, tier, status, won_at, stash_expires_at, acquired_at, origin)
                    values (${`rz${RUN}-${i}-${p}-${d}`}, ${buyer}, ${pid}, ${d}, ${did}, ${sql.json(card('卡' + d))},
                            ${tier}, 'stashed', ${won}, ${won + 9e9}, ${won}, 'draw')`
          won++
        }
      }
    }
    if (shape === 0 || shape === 2) {
      const sts = ['completed', 'completed', 'cancelled', 'escrowed', 'delivered']
      for (let o = 0; o < sts.length; o++) {
        const lid = `rl${RUN}-${i}-${o}`
        await sql`insert into listings (id, card, price, seller_id, seller_name, delivery, status, listed_at)
                  values (${lid}, ${sql.json(card('掛單'))}, 1000, ${sid}, ${'測試賣家' + i}, 'ship', 'sold', now())`
        await sql`insert into orders (id, listing_id, card, price, deposit, buyer_id, buyer_name, seller_id, seller_name, status, created_at, closed_by)
                  values (${`ro${RUN}-${i}-${o}`}, ${lid}, ${sql.json(card('掛單'))}, 1000, 100, ${buyer}, ${'買家' + i},
                          ${sid}, ${'測試賣家' + i}, ${sts[o]!}, ${Date.now()}, ${o === 2 ? 'dispute-seller' : null})`
      }
    }
  }
  return ids
}

/* =====================================================================
   ground truth：A-3 之前的 sellerView()，SQL 原文一字未改
   ===================================================================== */

const mask = (handle: string) => handle.replace(/^(VD-..).*$/, '$1**')

async function legacy(id: string) {
  const [s] = await sql`select s.*, u.handle as user_handle from sellers s join users u on u.id = s.id where s.id = ${id}`
  if (!s) return null
  const [st] = await sql<{ pools_run: string; draws_settled: string; top_hits: string; top_advertised: string }[]>`
    select
      (select count(*) from pools where seller_id = ${id} and status in ('open','sold_out','revealed'))::text as pools_run,
      (select count(*) from draws d join pools p on p.id = d.pool_id where p.seller_id = ${id})::text as draws_settled,
      (select count(*) from prizes pz join pools p on p.id = pz.pool_id
         where p.seller_id = ${id} and pz.tier in ('A','LAST'))::text as top_hits,
      (select coalesce(sum(pp.total),0) from pool_prizes pp join pools p on p.id = pp.pool_id
         where p.seller_id = ${id} and pp.tier in ('A','LAST') and p.status in ('open','sold_out','revealed'))::text as top_advertised
  `
  const [ship] = await sql<{ shipped: string; disputes: string; orders: string }[]>`
    select
      (select count(*) from orders where seller_id = ${id} and status = 'completed')::text as shipped,
      (select count(*) from orders where seller_id = ${id} and closed_by in ('dispute-buyer','dispute-seller'))::text as disputes,
      (select count(*) from orders where seller_id = ${id} and status not in ('escrowed','shipped','delivered','disputed'))::text as orders
  `
  const past = await sql`
    select pz.card, pz.tier, p.title, pz.won_at, u.handle
    from prizes pz join pools p on p.id = pz.pool_id join users u on u.id = pz.user_id
    where p.seller_id = ${id} and pz.tier in ('A','LAST') order by pz.won_at desc limit 8
  `
  const [tot] = await sql<{ n: string }[]>`
    select coalesce(sum(total_tickets),0)::text as n from pools where seller_id = ${id} and status in ('open','sold_out','revealed')
  `
  const totalTickets = Number(tot?.n ?? 0)
  const drawsSettled = Number(st?.draws_settled ?? 0)
  const closedOrders = Number(ship?.orders ?? 0)
  return {
    id: s.id, handle: s.handle, name: s.name, tier: s.tier, origin: s.origin,
    avatarHue: parseInt(String(s.id).slice(-2), 16) % 360 || 200,
    /* toISOString 不是 String()：postgres.js 給的是 Date，String(date) 是
       「Fri Sep 04 2026 …」那種預設字串，切前十碼會得到 "Fri Sep 04" ——
       不但不是日期格式，**連年份都沒有**，前端再怎麼解析也救不回來。 */
    joinedAt: new Date(s.joined_at as string | number | Date).toISOString().slice(0, 10), bio: s.bio,
    stats: {
      poolsRun: Number(st?.pools_run ?? 0),
      cardsShipped: Number(ship?.shipped ?? 0),
      avgShipDays: 0,
      disputeRate: closedOrders ? Math.round((Number(ship?.disputes) / closedOrders) * 1000) / 10 : 0,
      advertisedTopRate: totalTickets ? Math.round((Number(st?.top_advertised) / totalTickets) * 1000) / 10 : 0,
      actualTopRate: drawsSettled ? Math.round((Number(st?.top_hits) / drawsSettled) * 1000) / 10 : 0,
      drawsSettled
    },
    pastPrizes: past.map(r => ({
      cardName: (r.card as { name?: string }).name ?? '', artId: (r.card as { artId?: string }).artId,
      tier: r.tier, poolTitle: r.title, wonAt: new Date(Number(r.won_at)).toISOString().slice(0, 10),
      winner: mask(String(r.handle))
    }))
  }
}

/** 翻完所有頁。回傳 [全部項目, 頁數, 每頁筆數] */
async function drain(limit?: number) {
  const items: Any[] = []
  const sizes: number[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 5000; guard++) {
    const qs = [limit ? `limit=${limit}` : '', cursor ? `cursor=${encodeURIComponent(cursor)}` : ''].filter(Boolean).join('&')
    const r = await get(`/v1/sellers${qs ? '?' + qs : ''}`)
    if (r.status !== 200) throw new Error(`翻頁時拿到 ${r.status}: ${r.txt.slice(0, 200)}`)
    items.push(...r.body.sellers)
    sizes.push(r.body.sellers.length)
    cursor = r.body.nextCursor ?? null
    if (!cursor) break
  }
  return { items, pages: sizes.length, sizes }
}

/* =====================================================================
   跑
   ===================================================================== */

const N = Number(process.env.REGRESS_SELLERS_N ?? 45)

head('素材')
const madeIds = await seed(N)
const allIds = (await sql<{ id: string }[]>`select id from sellers order by joined_at asc, id asc`).map(r => r.id)
ck(`造了 ${N} 位賣家（四種形狀：完整／有池沒抽／只有訂單／全空）`, madeIds.length === N)
ck('資料庫裡至少有這些賣家', madeIds.every(id => allIds.includes(id)), `${allIds.length}`)

head('回應形狀（前端相容）')
{
  const r = await get('/v1/sellers')
  ck('鍵仍然叫 sellers 而且是陣列（stores/sellers.ts 讀的就是它）',
    r.status === 200 && Array.isArray(r.body?.sellers), JSON.stringify(r.body).slice(0, 120))
  ck('預設一頁 20 筆', r.body.sellers.length === Math.min(20, allIds.length), `${r.body.sellers.length}`)
  ck('有 nextCursor 可以往下翻', typeof r.body.nextCursor === 'string' || r.body.nextCursor === null)
}

head('逐位賣家、逐個欄位比對 ground truth')
{
  const all = await drain(100)
  ck('翻完所有頁的筆數 = 資料庫裡的賣家數', all.items.length === allIds.length,
    `endpoint=${all.items.length} db=${allIds.length}`)

  let same = 0
  const bad: string[] = []
  for (const got of all.items) {
    const want = await legacy(got.id)
    if (!want) { bad.push(`${got.id}: ground truth 查不到`); continue }
    /* 統計那一包逐欄位比：JSON.stringify 的鍵順序在兩邊都由同一份物件字面值決定，
       所以字串比對等同逐欄位比對，而且失敗時看得到差在哪一欄。 */
    const a = JSON.stringify({ ...want, pastPrizes: undefined })
    const b = JSON.stringify({ ...got, pastPrizes: undefined })
    if (a !== b) { bad.push(`${got.id}\n    want ${a}\n    got  ${b}`); continue }
    /* pastPrizes 比多重集合而不是比順序：改前只有 `order by won_at desc`，
       平手時的順序是未定義的，拿它當「正確答案」會驗到一個資料庫沒有承諾的東西。
       素材本身沒有平手（won_at 全域遞增），所以在這些賣家身上
       「多重集合相同 ＋ 順序遞減」等價於完全相同。 */
    const key = (x: Any[]) => JSON.stringify(x.map(v => JSON.stringify(v)).sort())
    if (key(want.pastPrizes) !== key(got.pastPrizes)) {
      bad.push(`${got.id} pastPrizes 內容不同\n    want ${JSON.stringify(want.pastPrizes)}\n    got  ${JSON.stringify(got.pastPrizes)}`)
      continue
    }
    const wonAts = got.pastPrizes.map((p: Any) => p.wonAt)
    if (wonAts.some((v: string, i: number) => i > 0 && v > wonAts[i - 1]!)) {
      bad.push(`${got.id} pastPrizes 沒有依 wonAt 遞減`); continue
    }
    if (got.pastPrizes.length > 8) { bad.push(`${got.id} pastPrizes 超過 8 筆`); continue }
    same++
  }
  ck(`每一位賣家的每一個統計數字都跟改前完全相同（${same}/${all.items.length}）`,
    bad.length === 0, bad.slice(0, 3).join('\n  '))

  const shells = madeIds.filter((_, i) => i % 4 !== 0)
  ck('沒有池／沒有抽卡／只有訂單／全空的賣家一位都沒有消失',
    shells.every(id => all.items.some((x: Any) => x.id === id)),
    shells.filter(id => !all.items.some((x: Any) => x.id === id)).slice(0, 5).join(','))

  const withPools = all.items.filter((x: Any) => x.stats.poolsRun > 0)
  ck('素材真的有非零統計（避免「全部都是 0」造成的假通過）',
    withPools.length > 0 && withPools.some((x: Any) => x.stats.drawsSettled > 0 && x.pastPrizes.length === 8),
    `poolsRun>0 的有 ${withPools.length} 位`)
}

head('分頁：不重不漏')
{
  const full = await drain(100)
  const fullIds = full.items.map((x: Any) => x.id)
  for (const lim of [1, 7, 100]) {
    const d = await drain(lim)
    const ids = d.items.map((x: Any) => x.id)
    ck(`limit=${lim}：翻完的集合跟一次全撈相同、不重不漏（${d.pages} 頁）`,
      ids.length === fullIds.length && new Set(ids).size === ids.length &&
      ids.every((v: string, i: number) => v === fullIds[i]),
      `n=${ids.length} uniq=${new Set(ids).size} want=${fullIds.length}`)
    ck(`limit=${lim}：每一頁都不超過 limit`, d.sizes.every(s => s <= lim), d.sizes.join(','))
  }
  ck('順序跟資料庫的 (joined_at, id) 遞增一致',
    fullIds.every((v: string, i: number) => v === allIds[i]),
    `${fullIds.slice(0, 3)} vs ${allIds.slice(0, 3)}`)
}

head('分頁參數：畸形輸入回 400 不是 500')
{
  for (const [qs, why] of [
    ['limit=101', '超過上限'], ['limit=0', '零'], ['limit=-1', '負數'],
    ['limit=abc', '不是數字'], ['limit=1.5', '小數'], ['limit=1e999', '天文數字']
  ] as [string, string][]) {
    const r = await get(`/v1/sellers?${qs}`)
    ck(`${qs}（${why}）回 400`, r.status === 400, `${r.status} ${r.txt.slice(0, 80)}`)
  }
  for (const [cur, why] of [
    ['%%%', '不是 base64'], ['Zm9v', '解得開但欄位不夠'],
    ['bm90LWEtdGltZXwxMjM', '第一段不是時間戳'],
    ['MjAyNC0wMS0wMSAwMDowMDowMCswMDowMA', '只有一段'],
    ['a'.repeat(600), '超長']
  ] as [string, string][]) {
    const r = await get(`/v1/sellers?cursor=${encodeURIComponent(cur)}`)
    ck(`畸形游標（${why}）回 400`, r.status === 400, `${r.status} ${r.txt.slice(0, 120)}`)
  }
  const ok = await get('/v1/sellers?limit=100')
  ck('limit=100（上限本身）可以用', ok.status === 200 && ok.body.sellers.length <= 100, `${ok.status}`)
}

head('單筆賣家頁沒有被批次化拖累')
{
  const target = madeIds[0]!
  const one = await get(`/v1/sellers/${target}`)
  const want = await legacy(target)
  ck('/v1/sellers/:id 回的內容跟 ground truth 完全相同',
    JSON.stringify({ ...one.body.seller, pastPrizes: undefined }) === JSON.stringify({ ...want!, pastPrizes: undefined }),
    JSON.stringify(one.body.seller).slice(0, 200))
  ck('/v1/sellers/:id 的 pastPrizes 內容相同',
    JSON.stringify(one.body.seller.pastPrizes.map((v: Any) => JSON.stringify(v)).sort()) ===
    JSON.stringify(want!.pastPrizes.map(v => JSON.stringify(v)).sort()))
  const missing = await get('/v1/sellers/no-such-seller')
  ck('查不到的賣家回 seller: null（不是 500）', missing.status === 200 && missing.body.seller === null,
    `${missing.status} ${missing.txt.slice(0, 80)}`)

  /* 列表裡的那一份與單筆頁的那一份必須逐字相同 —— 兩條路各算各的統計
     是這次改動最實際的退化風險（列表走批次、單筆也走批次，但只要有人
     哪天為了「單筆更快」另寫一份，數字就會分岔）。 */
  const page = await get(`/v1/sellers?limit=100`)
  const inList = page.body.sellers.find((x: Any) => x.id === target)
  ck('列表裡的那一位與單筆頁逐字相同', JSON.stringify(inList) === JSON.stringify(one.body.seller))
}

head('查詢條數與賣家數脫鉤')
{
  /* 沒有辦法從外面數 SQL 條數（那要動 db.ts），所以用可觀察的替代指標：
     一頁 100 位的延遲不該是一頁 1 位的 100 倍。改前是 5N+1 條循序查詢，
     這個比值實測約 50–90 倍；改後固定 5 條，比值在個位數。 */
  const t = async (p: string) => {
    for (let i = 0; i < 3; i++) await get(p)
    const xs: number[] = []
    for (let i = 0; i < 10; i++) { const a = performance.now(); await get(p); xs.push(performance.now() - a) }
    return xs.sort((a, b) => a - b)[5]!
  }
  const one = await t('/v1/sellers?limit=1')
  const many = await t('/v1/sellers?limit=100')
  ck(`100 位的延遲不到 1 位的 15 倍（實測 ${one.toFixed(1)}ms → ${many.toFixed(1)}ms，${(many / one).toFixed(1)}x）`,
    many / one < 15, `${one.toFixed(1)} → ${many.toFixed(1)}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
await sql.end()
process.exit(fail ? 1 : 0)
