/**
 * 自我檢測的迴歸測試。
 *
 * 驗三件事：乾淨的庫全綠、每一種故意弄壞的不變式都被抓到、
 * 同一天重複跑不重複通知（refId 的日期桶冪等）。
 *
 * 不需要 HTTP server —— monitor 是純資料庫函式，直接 import 來跑。
 *
 *   DATABASE_URL=... JWT_SECRET=... npx tsx src/regress-monitor.ts
 *
 * ⚠️ **這支會故意把資料庫寫壞**（單邊分錄、負餘額、狀態不一致…）——
 * 那是它的工作：驗證每一種壞法都被檢測抓得到。所以它**必須跑在一個
 * 用完就丟的庫上**，而且第一段「乾淨的庫要全綠」只有在真的乾淨時才成立。
 *
 * 一度想把 fixture 的 id 都帶隨機字尾讓它能重複跑，但那是治標：
 * 上一輪弄壞的資料還留著，第二輪的「乾淨的庫要全綠」必然失敗，
 * 而那個失敗完全沒有意義。**id 仍然帶 runId**（避開同一輪內的碰撞與
 * 手動重跑時難懂的主鍵錯誤），但正確的用法一律是先開一個新庫。
 *
 * fixture 的 ref_id 帶隨機字尾：`ledger_once` 是 (ref_id, user_id, reason)
 * 的唯一索引，用固定字串的話同一個庫跑第二次會撞 23505 —— 而那正是那道
 * 防線該做的事，不是缺陷。帶隨機字尾讓這支可以重複跑。
 * 所有 fixture 的 id 一律帶同一個 runId 字尾 —— 之前只改了帳本那兩筆，
 * 結果 settlements / prizes / shipments 照樣在第二次跑撞主鍵。
 * 同一個 runId 讓同一輪的 fixture 互相對得起來，跨輪則不衝突。
 */
import { randomBytes } from 'node:crypto'
import { sql } from './db.js'
import { runMonitor, alertFindings } from './monitor.js'

let pass = 0, fail = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
const head = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 52 - s.length))}`)
const has = (r: Awaited<ReturnType<typeof runMonitor>>, check: string) =>
  r.findings.some(f => f.check === check)

head('乾淨的庫要全綠')
{
  const r1 = await runMonitor()   // 第一輪：記 ledger-drift 基準
  const r2 = await runMonitor()   // 第二輪：基準已在，應該全綠
  ck('跑了全部檢查', r2.checked.length === 10, `checked=${r2.checked.length}`)
  ck('沒有任何發現', r2.findings.length === 0,
    JSON.stringify(r2.findings.map(f => f.check)))
  ck('沒有檢查自己掛掉', r2.errors.length === 0, JSON.stringify(r2.errors))
  void r1
}

/* 這一輪所有 fixture 共用的字尾，讓這支可以重複跑（見檔頭） */
const runId = randomBytes(4).toString('hex')

head('每一種弄壞的不變式都要被抓到')
const now = Date.now()
let report2!: Awaited<ReturnType<typeof runMonitor>>
{
  // 1. 單邊分錄 → drift 變了
  await sql`insert into points_ledger (user_id, delta, reason, ref_id)
            values ('u-buyer', 12345, 'draw', ${'monitor-test-oneside-' + runId})`
  // 2. 負餘額
  /* handle 與 member_no 也各有唯一索引，一起帶 runId ——
     只改 id 的話第二次跑會撞 users_handle_key。 */
  await sql`insert into users (id, handle, member_no, name)
            values (${'u-neg-' + runId}, ${'negtest-' + runId}, ${'VD-N' + runId}, '負餘額')
            on conflict (id) do nothing`
  await sql`insert into points_ledger (user_id, delta, reason, ref_id)
            values (${'u-neg-' + runId}, -500, 'draw', ${'monitor-test-neg-' + runId})`
  // 3. 結算與卡片各說各話
  const [anyPrize] = await sql<{ id: string; pool_id: string; user_id: string }[]>`
    select id, pool_id, user_id from prizes limit 1`
  if (!anyPrize) throw new Error('種子資料不完整：沒有卡可用')
  /* 種子庫沒有任何 draws 列（籤位是 seed 直接寫的，不走抽卡）。
     結算的 draw_id 是 NOT NULL 外鍵，所以先造一列 ——
     第一版用 insert...select from draws limit 1，靜默插了 0 列，
     兩個結算 fixture 根本不存在，測試「抓不到」其實是「沒東西可抓」。 */
  await sql`insert into draws (id, pool_id, user_id, seats, cost, source, created_at)
            values (${'d-mon-test-' + runId}, ${anyPrize.pool_id}, ${anyPrize.user_id}, ${[9000 + (parseInt(runId, 16) % 900)]}, 0, 'draw', ${now})
            on conflict (id) do nothing`
  await sql`insert into pool_settlements
              (id, pool_id, seller_id, buyer_id, draw_id, seat, prize_id, amount, fee, status, created_at)
            values (${'st-mon-test-' + runId}, ${anyPrize.pool_id}, 'u-seller', ${anyPrize.user_id},
                   ${'d-mon-test-' + runId}, ${9000 + (parseInt(runId, 16) % 900)}, ${anyPrize.id}, 100, 0, 'refunded', ${now})`
  // 卡片留在原狀態（不是 refunded）→ desync
  // 4. 掛單指著不在上架狀態的卡
  await sql`update prizes set status = 'stashed' where id in
              (select prize_id from listings where status = 'live' and prize_id is not null limit 1)`
  // 5. 揭曉的池上還押著卡
  const [pool] = await sql<{ id: string }[]>`select id from pools limit 1`
  if (!pool) throw new Error('種子資料不完整：沒有池可用')
  await sql`insert into prizes (id, user_id, pool_id, card, tier, status, won_at, acquired_at, stash_expires_at)
            values (${'pz-mon-inpool-' + runId}, 'u-seller', ${pool.id}, ${sql.json({ name: '檢測用' })}, 'A', 'in_pool',
                    ${now}, ${now}, ${now})`
  await sql`update pools set status = 'revealed' where id = ${pool.id}`
  // 6. 過期一天以上的結算
  await sql`insert into pool_settlements
              (id, pool_id, seller_id, buyer_id, draw_id, seat, prize_id, amount, fee, status, created_at, ship_due_at)
            values (${'st-mon-stall-' + runId}, ${anyPrize.pool_id}, 'u-seller', ${anyPrize.user_id},
                   ${'d-mon-test-' + runId}, ${9000 + (parseInt(runId, 16) % 900) + 1}, ${anyPrize.id}, 100, 0, 'awaiting_ship', ${now}, ${now - 3 * 86_400_000})`
  // 7. 殭屍出貨單
  await sql`update prizes set status = 'refunded' where id = ${'pz-mon-inpool-' + runId}`
  await sql`insert into shipments (id, user_id, prize_ids, address, created_at)
            values (${'sh-mon-test-' + runId}, 'u-seller', ${['pz-mon-inpool-' + runId]},
                    ${sql.json({ name: 'x', phone: '0900000000', line1: 'x', city: 'x' })}, ${now})`
  // 7 蓋掉了 5 的 in_pool —— 再補一張真的 in_pool
  await sql`insert into prizes (id, user_id, pool_id, card, tier, status, won_at, acquired_at, stash_expires_at)
            values (${'pz-mon-inpool2-' + runId}, 'u-seller', ${pool.id}, ${sql.json({ name: '檢測用2' })}, 'A', 'in_pool',
                    ${now}, ${now}, ${now})`
  // 8. 有編號沒 grader
  await sql`insert into prizes (id, user_id, pool_id, card, tier, status, won_at, acquired_at, stash_expires_at, cert_no)
            values (${'pz-mon-nograder-' + runId}, 'u-seller', ${pool.id}, ${sql.json({ name: '檢測用3' })}, 'B', 'stashed',
                    ${now}, ${now}, ${now}, '55555555')`

  const r = await runMonitor()
  report2 = r
  ck('抓到：單邊分錄（drift 變了）', has(r, 'ledger-drift'))
  ck('抓到：負餘額', has(r, 'negative-balance'))
  ck('抓到：結算與卡片各說各話', has(r, 'settlement-prize-desync'))
  ck('抓到：掛單與卡片脫鉤', has(r, 'listing-prize-desync'))
  ck('抓到：揭曉的池上還押著卡', has(r, 'stuck-in-pool'))
  ck('抓到：結算過期沒人收', has(r, 'settlement-sweep-stalled'))
  ck('抓到：殭屍出貨單', has(r, 'zombie-shipment'))
  ck('抓到：沒有 grader 的編號', has(r, 'cert-unprotected'))
  const sev = r.findings.find(f => f.check === 'ledger-drift')?.severity
  ck('drift 是 critical', sev === 'critical', String(sev))
  const msg = r.findings.find(f => f.check === 'settlement-prize-desync')?.message ?? ''
  ck('訊息講得出「先查哪裡」', /先看|先查|看樣本/.test(msg), msg.slice(0, 60))
}

head('通知：發給管理員、同一天不重複')
{
  /* 沿用上一段的報告再跑一次 alert。重新 runMonitor() 的話
     drift 的基準已經在上一輪被更新，ledger-drift 不會再出現 ——
     那是 monitor 的正確行為（變一次警報一次），但這裡要驗的是通知。 */
  const r = report2
  const sent1 = await alertFindings(r)
  ck('有發出通知', sent1 > 0, String(sent1))
  const [n1] = await sql<{ n: string }[]>`
    select count(*)::text as n from notifications
     where user_id in (select id from users where role = 'admin')
       and ref_id like 'monitor:%'`
  const again = await alertFindings(r)
  const [n2] = await sql<{ n: string }[]>`
    select count(*)::text as n from notifications
     where user_id in (select id from users where role = 'admin')
       and ref_id like 'monitor:%'`
  ck('同一天再跑不重複通知（refId 日期桶）', n1?.n === n2?.n, `${n1?.n} → ${n2?.n}`)
  void again
  const [sample] = await sql<{ title: string; body: string }[]>`
    select title, body from notifications where ref_id like 'monitor:ledger-drift:%' limit 1`
  console.log(`\n通知範例：\n  ${sample?.title}\n  ${(sample?.body ?? '').slice(0, 120)}…`)
}

head('檢查自己掛掉也要看得見')
{
  await sql`alter table monitor_state rename to monitor_state_hidden`
  const r = await runMonitor()
  ck('ledger-drift 進了 errors 而不是靜默消失',
    r.errors.some(e => e.check === 'ledger-drift'), JSON.stringify(r.errors))
  ck('其他檢查照常跑完', r.checked.length === 9, String(r.checked.length))
  await sql`alter table monitor_state_hidden rename to monitor_state`
}

console.log(`\n${pass} passed, ${fail} failed`)
await sql.end({ timeout: 3 })
process.exit(fail ? 1 : 0)
