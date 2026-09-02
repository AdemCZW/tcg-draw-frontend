/**
 * audit-3 的 A-1／A-2／A-4 迴歸測試（A-3 在 regress-pledge.ts）。
 *
 * A-1/A-2 的病根相同：sql.begin 只在 throw 時回滾，「先寫、後檢查、
 * 檢查沒過回錯誤值」會把前半段 COMMIT 進資料庫。修法是 db.ts 的 Rollback。
 *
 *   DATABASE_URL=... JWT_SECRET=... npx tsx src/regress-a.ts http://localhost:PORT
 *
 * ⚠️ 要自己一個乾淨的庫（migrate + seed），伺服器要 DEV_LOGIN=1 與 DEV_LOGIN_SECRET。
 */
import { sql, Rollback } from './db.js'
import { acceptRecycle, toSettlement } from './pool-settlement.js'

const base = (process.argv[2] ?? 'http://localhost:8079').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
const devHeaders = () => {
  if (!devSecret) throw new Error('regress-a 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')
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

/* ============ A-1：回收付不出錢，不能留下半個狀態 ============ */
head('A-1 回收付不出錢 → 整筆回滾，不是半提交')
{
  const now = Date.now()
  /* 直接在資料庫組場景：一個沒有任何點數的賣家、一筆 held 的結算、
     買回價 500 —— 可動用 0 < 500，必然 unfunded。
     走函式不走 HTTP：unfunded 要求「賣家可動用 < 買回價」，
     從正常 API 造這個場景要先讓賣家把錢花光，繞太遠。 */
  await sql`insert into users (id, handle, member_no, name) values
            ('u-poorseller', 'poorseller', 'VD-POOR', '沒錢的賣家')
            on conflict (id) do nothing`
  const [pz] = await sql<{ id: string; pool_id: string; user_id: string }[]>`
    select id, pool_id, user_id from prizes where status in ('stashed','listed') limit 1`
  if (!pz) throw new Error('種子沒有可用的卡')
  await sql`insert into draws (id, pool_id, user_id, seats, cost, source, created_at)
            values ('d-a1', ${pz.pool_id}, ${pz.user_id}, ${[9801]}, 0, 'draw', ${now})
            on conflict (id) do nothing`
  await sql`insert into pool_settlements
              (id, pool_id, seller_id, buyer_id, draw_id, seat, prize_id, amount, fee, status, created_at)
            values ('st-a1', ${pz.pool_id}, 'u-poorseller', ${pz.user_id}, 'd-a1', 9801,
                    ${pz.id}, 100, 0, 'held', ${now})`

  const [row] = await sql`
    select st.*, z.user_id as owner_id
      from pool_settlements st join prizes z on z.id = st.prize_id
     where st.id = 'st-a1'`
  const s = toSettlement(row as Record<string, unknown>)

  let rolled = false, payload: Any = null
  try {
    await sql.begin(tx => acceptRecycle(tx, s, 500, now))
  } catch (e) {
    if (e instanceof Rollback) { rolled = true; payload = e.body }
    else throw e
  }
  ck('付不出錢時 throw Rollback（不是回錯誤值）', rolled, '沒有 throw —— 半提交回來了')
  ck('回應講得出原因', /保留額不足/.test(String(payload?.message ?? '')), JSON.stringify(payload))

  const [after] = await sql`select status from pool_settlements where id = 'st-a1'`
  ck('結算列還是 held（回滾了，不是卡死在 recycled）',
    after?.status === 'held', `status=${after?.status}`)
  const [pzAfter] = await sql`select status from prizes where id = ${pz.id}`
  ck('卡片列沒被動過', pzAfter?.status !== 'recycled', `status=${pzAfter?.status}`)

  // 賣家有錢之後同一筆要能成交 —— 半提交的舊行為會讓這裡 WRONG_STATE
  await sql`insert into points_ledger (user_id, delta, reason, ref_id)
            values ('u-poorseller', 500, 'admin-grant', 'a1-fund')`
  const out = await sql.begin(tx => acceptRecycle(tx, s, 500, now))
  ck('補了錢之後同一筆回收成交', out.ok === true, JSON.stringify(out))
  const [led] = await sql<{ n: string }[]>`
    select count(*)::text as n from points_ledger where ref_id = 'st-a1'`
  ck('借貸成對（兩筆分錄）', led?.n === '2', `分錄 ${led?.n} 筆`)
}

/* ============ A-2：接受出價付不出錢，出價不能卡死在 accepted ============ */
head('A-2 接受出價付不出錢 → 出價退回 pending，補錢後可重試')
{
  const platform = await login('platform', 'VaultDraw 官方')
  const owner = await login('a2owner', 'A2 持有人')
  const bidder = await login('a2bidder', 'A2 出價人')

  // 持有人要有一張卡：直接塞一張 stashed 的
  const now = Date.now()
  const [pool] = await sql<{ id: string }[]>`select id from pools limit 1`
  await sql`insert into prizes (id, user_id, pool_id, card, tier, status, won_at, acquired_at, stash_expires_at, custodian_id, origin)
            values ('pz-a2', 'u-a2owner', ${pool!.id}, ${sql.json({ name: 'A2 測試卡' })}, 'B', 'stashed',
                    ${now}, ${now}, ${now + 30 * 86_400_000}, 'u-a2owner', 'draw')`
  await call(platform, '/v1/admin/grant', { userId: 'u-a2bidder', points: 1000, note: 'A2 測試' })
  // 出價要求對方的卡冊是公開的 —— 直接把旗標打開（正常路徑是 /v1/social/cardbook 設定頁）
  await sql`update users set cardbook_public = true where id = 'u-a2owner'`

  const or_ = await call(bidder, '/v1/social/trade-offers', { prizeId: 'pz-a2', points: 1000 })
  const ob = await json(or_.clone())
  ck('出價成立（1000 點全數凍結）', or_.ok, `${or_.status} ${JSON.stringify(ob).slice(0, 120)}`)
  const offerId = ob.offerId ?? ob.offer?.id ?? ob.id
  if (!offerId) throw new Error('出價沒有回 id：' + JSON.stringify(ob).slice(0, 200))

  /* 出價人的錢在他背後蒸發 600（模擬「出價後把錢花掉」——正常路徑他的錢被
     凍住花不掉，但別的併發路徑或平台調整都可能讓餘額變少）。 */
  await sql`insert into points_ledger (user_id, delta, reason, ref_id)
            values ('u-a2bidder', -600, 'admin-grant', 'a2-drain')`

  const acc1 = await call(owner, `/v1/social/trade-offers/${offerId}/accept`, {})
  ck('付不出錢 → 409', acc1.status === 409, String(acc1.status))
  const [o1] = await sql`select status from trade_offers where id = ${offerId}`
  ck('出價退回 pending（不是卡死在 accepted）', o1?.status === 'pending', `status=${o1?.status}`)
  const [pzMid] = await sql`select user_id from prizes where id = 'pz-a2'`
  ck('卡沒被過戶', pzMid?.user_id === 'u-a2owner', String(pzMid?.user_id))

  await sql`insert into points_ledger (user_id, delta, reason, ref_id)
            values ('u-a2bidder', 600, 'admin-grant', 'a2-refund')`
  const acc2 = await call(owner, `/v1/social/trade-offers/${offerId}/accept`, {})
  ck('補了錢之後同一筆出價接受成功', acc2.ok, `${acc2.status} ${await acc2.clone().text().then(t => t.slice(0, 120))}`)
  const [pzAfter] = await sql`select user_id from prizes where id = 'pz-a2'`
  ck('卡過戶給出價人', pzAfter?.user_id === 'u-a2bidder', String(pzAfter?.user_id))
}

/* ============ A-4：自我檢測有接上線 ============ */
head('A-4 自我檢測的 HTTP 端點活著（稽核時它還沒接線）')
{
  const platform = await login('platform', 'VaultDraw 官方')
  const r = await call(platform, '/v1/admin/monitor')
  ck('GET /v1/admin/monitor → 200', r.status === 200, String(r.status))
  const body = await json(r.clone())
  ck('跑了全部十條檢查', body.checked?.length === 10, `checked=${body.checked?.length}`)
  const anon = await fetch(`${base}/v1/admin/monitor`)
  ck('沒登入拿不到', anon.status === 401 || anon.status === 403, String(anon.status))
}

console.log(`\n${pass} passed, ${fail} failed`)
await sql.end({ timeout: 3 })
process.exit(fail ? 1 : 0)
