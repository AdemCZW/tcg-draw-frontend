/**
 * 022 上線前的唯讀掃描。
 *
 * 目的：唯一索引 create unique index prizes_cert_alive on prizes(grader, cert_no)
 * 只要既有資料裡有一組重複就會**建不起來**，而且那組重複本身就是
 * 「一卡多賣已經發生了」的證據，必須先人工處理。
 *
 * 這支只下 SELECT。不 UPDATE、不 INSERT、不 DDL。
 */
import postgres from 'postgres'

/* 本機跑要走 DATABASE_PUBLIC_URL —— web 服務的 DATABASE_URL 指的是
   postgres.railway.internal，那個主機名只有在 Railway 網路裡面解析得到。
   用法：railway run --service postgres -- npx tsx scripts/scan-certs.ts */
const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
if (!url) { console.error('沒有 DATABASE_PUBLIC_URL / DATABASE_URL'); process.exit(1) }

const sql = postgres(url, {
  max: 2,
  idle_timeout: 10,
  ssl: url.includes('localhost') ? false : { rejectUnauthorized: false }
})

const line = (s = '') => console.log(s)
const head = (s: string) => { line(); line(`── ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`) }

try {
  /* ---------- 0. 規模 ---------- */
  head('現況規模')
  const counts = await sql`
    select
      (select count(*) from pools)                              as pools,
      (select count(*) from pools where status = 'open')        as pools_open,
      (select count(*) from pool_prizes)                        as pool_prizes,
      (select count(*) from prizes)                             as prizes,
      (select count(*) from listings)                           as listings,
      (select count(*) from listings where status = 'live')     as listings_live,
      (select count(*) from pool_settlements)                   as settlements
  `
  console.table(counts[0])

  /* ---------- 1. 有編號的卡各有幾張 ---------- */
  head('帶鑑定編號的資料列')
  const certCounts = await sql`
    select
      (select count(*) from pool_prizes where card->>'certNo' is not null
         and card->>'certNo' <> '')                             as pool_prizes_cert,
      (select count(*) from prizes      where card->>'certNo' is not null
         and card->>'certNo' <> '')                             as prizes_cert,
      (select count(*) from listings    where cert_no is not null)  as listings_cert
  `
  console.table(certCounts[0])

  /* ---------- 2. 核心：把三張表的編號攤平，找重複 ----------
     union all 不是 union —— union 會先去重，那正是我們要找的東西。 */
  head('重複的鑑定編號（跨 pool_prizes / prizes / listings）')
  const dupes = await sql`
    with all_certs as (
      select 'pool_prize' as src, pp.id as row_id,
             coalesce(pp.card->>'grader','?') as grader,
             pp.card->>'certNo' as cert_no,
             pp.pool_id as ctx, p.status as ctx_status
        from pool_prizes pp join pools p on p.id = pp.pool_id
       where pp.card->>'certNo' is not null and pp.card->>'certNo' <> ''
      union all
      select 'prize', pz.id,
             coalesce(pz.card->>'grader','?'),
             pz.card->>'certNo',
             pz.pool_id, pz.status
        from prizes pz
       where pz.card->>'certNo' is not null and pz.card->>'certNo' <> ''
      union all
      select 'listing', l.id,
             coalesce(l.card->>'grader','?'),
             l.cert_no,
             l.seller_id, l.status
        from listings l
       where l.cert_no is not null
    )
    select grader, cert_no, count(*) as n,
           array_agg(src || ':' || row_id || ' [' || ctx_status || ']' order by src) as rows
      from all_certs
     group by grader, cert_no
    having count(*) > 1
     order by count(*) desc, cert_no
  `
  if (dupes.length === 0) line('乾淨：沒有任何編號出現在一個以上的地方。')
  else {
    line(`找到 ${dupes.length} 組重複：`)
    for (const d of dupes) line(`  ${d.grader} #${d.cert_no}  ×${d.n}\n    ${(d.rows as string[]).join('\n    ')}`)
  }

  /* ---------- 3. 只看「同時活著」的重複 ----------
     上一段連已結束的池、已售出的掛單都算進去。真正會擋住索引、
     也真正是「現在正在一卡多賣」的，是同時都還活著的那些。 */
  head('同時活著的重複（真正的一卡多賣）')
  const liveDupes = await sql`
    with live_certs as (
      select 'pool_prize' as src, pp.id as row_id,
             coalesce(pp.card->>'grader','?') as grader, pp.card->>'certNo' as cert_no
        from pool_prizes pp join pools p on p.id = pp.pool_id
       where pp.card->>'certNo' is not null and pp.card->>'certNo' <> ''
         and p.status in ('draft','committed','open')
      union all
      select 'prize', pz.id, coalesce(pz.card->>'grader','?'), pz.card->>'certNo'
        from prizes pz
       where pz.card->>'certNo' is not null and pz.card->>'certNo' <> ''
         and pz.status in ('stashed','listed','ship_requested','shipped')
      union all
      select 'listing', l.id, coalesce(l.card->>'grader','?'), l.cert_no
        from listings l
       where l.cert_no is not null and l.status = 'live'
    )
    select grader, cert_no, count(*) as n,
           array_agg(src || ':' || row_id order by src) as rows
      from live_certs
     group by grader, cert_no
    having count(*) > 1
     order by cert_no
  `
  if (liveDupes.length === 0) line('乾淨：沒有任何編號同時活在兩個地方。')
  else {
    line(`⚠ 找到 ${liveDupes.length} 組，這些是已經發生的一卡多賣：`)
    for (const d of liveDupes) line(`  ${d.grader} #${d.cert_no}  ×${d.n}  ${(d.rows as string[]).join(' , ')}`)
  }

  /* ---------- 4. listings 現有索引的盲點：少了 grader ----------
     現在的 listings_cert_live 是 on(cert_no)，沒有 grader。
     所以「不同鑑定公司撞號」會被誤擋。看看有沒有真的撞到。 */
  head('不同鑑定公司撞號（現有索引會誤擋的情況）')
  const graderClash = await sql`
    with all_certs as (
      select coalesce(card->>'grader','?') as grader, card->>'certNo' as cert_no
        from pool_prizes where card->>'certNo' is not null and card->>'certNo' <> ''
      union all
      select coalesce(card->>'grader','?'), card->>'certNo'
        from prizes where card->>'certNo' is not null and card->>'certNo' <> ''
      union all
      select coalesce(card->>'grader','?'), cert_no
        from listings where cert_no is not null
    )
    select cert_no, array_agg(distinct grader) as graders
      from all_certs group by cert_no
    having count(distinct grader) > 1
  `
  if (graderClash.length === 0) line('沒有。目前所有編號都只對應一家鑑定公司。')
  else for (const g of graderClash) line(`  #${g.cert_no} → ${(g.graders as string[]).join(' / ')}`)

  /* ---------- 5. 有編號卻 total > 1 ----------
     PSA #12345678 不可能有三份。建池 API 現在沒擋這件事。 */
  head('有鑑定編號卻 total > 1 的獎品')
  const multi = await sql`
    select pp.id, pp.pool_id, p.status as pool_status, pp.tier, pp.total,
           pp.card->>'grader' as grader, pp.card->>'certNo' as cert_no,
           pp.card->>'name' as name
      from pool_prizes pp join pools p on p.id = pp.pool_id
     where pp.card->>'certNo' is not null and pp.card->>'certNo' <> ''
       and pp.total > 1
     order by pp.total desc
  `
  if (multi.length === 0) line('沒有。')
  else {
    line(`⚠ 找到 ${multi.length} 列：`)
    for (const m of multi) line(`  ${m.pool_id} [${m.pool_status}] ${m.tier} ×${m.total}  ${m.grader} #${m.cert_no}  ${m.name}`)
  }

  /* ---------- 6. grader 缺漏 ----------
     唯一鍵要用 (grader, cert_no)。grader 是 null 的列會讓
     唯一性失效（null 不等於 null），所以要先知道有多少。 */
  head('有編號但沒有 grader 的列')
  const noGrader = await sql`
    select
      (select count(*) from pool_prizes where card->>'certNo' is not null
         and card->>'certNo' <> '' and coalesce(card->>'grader','') = '')  as pool_prizes,
      (select count(*) from prizes where card->>'certNo' is not null
         and card->>'certNo' <> '' and coalesce(card->>'grader','') = '')  as prizes,
      (select count(*) from listings where cert_no is not null
         and coalesce(card->>'grader','') = '')                           as listings
  `
  console.table(noGrader[0])

  /* ---------- 7. 順便：public.ts 允許 shipped 上架的後果 ---------- */
  head('已出貨卻還掛在市場上的卡')
  const shippedListed = await sql`
    select l.id as listing_id, l.cert_no, pz.id as prize_id, pz.status
      from listings l
      join prizes pz on pz.card->>'certNo' = l.cert_no
     where l.status = 'live' and l.cert_no is not null
       and pz.status in ('shipped','ship_requested')
  `
  if (shippedListed.length === 0) line('沒有。')
  else for (const s of shippedListed) line(`  ⚠ listing:${s.listing_id} ← prize:${s.prize_id} [${s.status}]`)

  /* ---------- 8. 舊制 vs 新制的池 ---------- */
  head('池的 commit 版本分布（判斷有多少舊池要並存）')
  const versions = await sql`
    select coalesce(commit_version, 0) as commit_version, status, count(*) as n
      from pools group by 1, 2 order by 1, 2
  `
  console.table(versions.map(v => ({ ...v })))

  line()
  line('掃描結束。以上全部是 SELECT，沒有任何寫入。')
} finally {
  await sql.end({ timeout: 5 })
}
