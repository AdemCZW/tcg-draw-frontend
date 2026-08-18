/**
 * 種子資料。
 *
 * 部署完的資料庫是空的，沒有掛單就沒東西可買、也沒東西可測。
 * 這支可以重複執行 —— 全部用 on conflict do nothing，不會重複塞。
 */
import { sql } from './db.js'
import { PLATFORM_ID } from './orders-service.js'

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
  const [n] = await sql<{ count: string }[]>`select count(*)::text as count from listings where status = 'live'`
  console.log(`seed done — ${n?.count ?? 0} 筆有效掛單`)
  await sql.end()
}
run().catch(e => { console.error(e); process.exit(1) })
