/**
 * 種子資料。
 *
 * 部署完的資料庫是空的，沒有掛單就沒東西可買、也沒東西可測。
 * 這支可以重複執行 —— 全部用 on conflict do nothing，不會重複塞。
 */
import { sql } from './db.js'
import { PLATFORM_ID } from './orders-service.js'
import { commitOf, seatSequence } from './shared/fairness.js'

const users: [string, string, string][] = [
  [PLATFORM_ID, 'platform', 'VaultDraw 官方'],
  ['u-buyer', 'buyer', '測試買家'],
  ['u-seller', 'seller', '測試賣家'],
  ['u-shop', 'shop', '關都卡舖']
]

const card = (name: string, certNo: string | null, artId: string, refPrice: number) => ({
  id: 'c-' + artId, name, setCode: 'sv4a', cardNo: '349/190', language: 'JP',
  grader: certNo ? 'PSA' : 'RAW', grade: certNo ? 10 : null, certNo,
  image: '', refPrice, artId
})

const listings: [string, ReturnType<typeof card>, number, string, string, 'vault' | 'ship'][] = [
  ['l-seed-1', card('噴火龍 ex SAR', '82345671', 'SV4a-349', 9800), 8620, 'u-seller', '測試賣家', 'ship'],
  ['l-seed-2', card('太樂巴戈斯 ex UR', '82345672', 'SV8a-237', 19800, ), 18220, 'u-shop', '關都卡舖', 'ship'],
  ['l-seed-3', card('月亮伊布 ex SAR', '82345673', 'SV8a-217', 28000), 26320, 'u-seller', '測試賣家', 'vault'],
  ['l-seed-4', card('謎擬Ｑ SAR', null, 'SV4a-341', 4200), 3780, 'u-shop', '關都卡舖', 'ship'],
  ['l-seed-5', card('奇樹 SAR', '82345675', 'SV4a-350', 3400), 2920, 'u-seller', '測試賣家', 'vault']
]

async function run() {
  for (const [id, handle, name] of users) {
    await sql`insert into users (id, handle, name) values (${id}, ${handle}, ${name})
              on conflict (id) do nothing`
  }
  await sql`update users set role = 'admin' where id = ${PLATFORM_ID}`
  // 給測試買家一些點數。正式環境的點數只能從儲值來，這裡是為了讓 smoke 測跑得動
  await sql`insert into points_ledger (user_id, delta, reason)
            select 'u-buyer', 1000000, 'seed'
            where not exists (select 1 from points_ledger where user_id = 'u-buyer' and reason = 'seed')`
  await sql`insert into points_ledger (user_id, delta, reason)
            select 'u-seller', 100000, 'seed'
            where not exists (select 1 from points_ledger where user_id = 'u-seller' and reason = 'seed')`
  await sql`insert into points_ledger (user_id, delta, reason)
            select 'u-shop', 100000, 'seed'
            where not exists (select 1 from points_ledger where user_id = 'u-shop' and reason = 'seed')`

  for (const [id, c, price, sellerId, sellerName, delivery] of listings) {
    await sql`
      insert into listings (id, card, price, seller_id, seller_name, delivery, cert_no)
      values (${id}, ${c as never}, ${price}, ${sellerId}, ${sellerName}, ${delivery}, ${c.certNo})
      on conflict (id) do nothing
    `
  }
  /* 賣家 + 一個直接處於 open 的池。
     這裡不走 drand（測試不能等兩分鐘），用固定的 seed 與 client_seed 算籤序。
     commit-reveal 的結構完全一樣，只是亂數來源是 fixture —— 標在 client_seed_source 裡。 */
  await sql`insert into sellers (id, handle, name, origin, tier)
            values ('u-seller', 'seller', '測試賣家', 'personal', 'verified')
            on conflict (id) do nothing`
  await sql`insert into sellers (id, handle, name, origin, tier)
            values ('u-shop', 'shop', '關都卡舖', 'merchant', 'trusted')
            on conflict (id) do nothing`

  const poolId = 'p-seed-1'
  const [exists] = await sql`select 1 from pools where id = ${poolId}`
  if (!exists) {
    const serverSeed = '11'.repeat(32)
    const clientSeed = 'fixture:seed-1'
    const prizeDefs = [
      { id: `${poolId}-pr0`, tier: 'LAST', card: card('噴火龍 ex UR', null, 'SV4a-349', 43680), total: 1 },
      { id: `${poolId}-pr1`, tier: 'A', card: card('奇樹 SAR', null, 'SV4a-350', 26320), total: 2 },
      { id: `${poolId}-pr2`, tier: 'B', card: card('太樂巴戈斯 ex UR', null, 'SV8a-237', 19800), total: 5 },
      { id: `${poolId}-pr3`, tier: 'C', card: card('月亮伊布 ex SAR', null, 'SV8a-217', 4200), total: 12 },
      { id: `${poolId}-pr4`, tier: 'D', card: card('謎擬Ｑ SAR', null, 'SV4a-341', 380), total: 80 }
    ]
    const total = prizeDefs.reduce((a, p) => a + p.total, 0)
    await sql`
      insert into pools (id, seller_id, mode, title, ticket_price, total_tickets, status,
                         server_seed, commit_hash, client_seed_source, client_seed, opened_at)
      values (${poolId}, 'u-seller', 'classic', '測試池：閃色寶藏 100 抽', 300, ${total}, 'open',
              ${serverSeed}, ${await commitOf(serverSeed)}, ${clientSeed}, ${clientSeed}, now())
    `
    await sql`insert into pool_prizes ${sql(prizeDefs.map(p => ({ id: p.id, pool_id: poolId, tier: p.tier, card: p.card, total: p.total })) as never)}`
    const seq = await seatSequence(serverSeed, clientSeed, prizeDefs.map(p => ({ prizeId: p.id, total: p.total })))
    await sql`insert into pool_seats ${sql(seq.map((prizeId, i) => ({ pool_id: poolId, seat: i + 1, prize_id: prizeId })) as never)}`
    console.log(`seed pool ${poolId}: ${total} seats`)
  }

  const [n] = await sql<{ count: string }[]>`select count(*)::text as count from listings where status = 'live'`
  console.log(`seed done — ${n?.count ?? 0} 筆有效掛單`)
  await sql.end()
}
run().catch(e => { console.error(e); process.exit(1) })
