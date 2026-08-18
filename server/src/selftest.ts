/**
 * 不需要資料庫的自我檢查。
 *
 * 這支存在的理由很具體：共用模組（../../src/shared）原本是給瀏覽器用的，
 * 最大的風險是它偷偷相依了某個前端的東西，而那件事要等後端跑起來才會發現。
 * 這支在 Node 裡直接 import 並執行規則，把那個風險提前暴露。
 *
 * 需要資料庫的部分（交易邊界、併發、帳本）不在這裡 —— 那要真的連 Postgres。
 */
import { applyDeadlines, actionsFor, depositFor, looksLikeTracking, DAY, HOUR } from '../../src/shared/escrow.js'
import type { Order } from '../../src/shared/domain.js'

const base: Order = {
  id: 'o1', listingId: 'l1', card: {} as Order['card'], price: 1000, deposit: 100,
  buyerId: 'b', buyerName: 'B', sellerId: 's', sellerName: 'S',
  status: 'escrowed', createdAt: 0
}
let pass = 0, fail = 0
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.error(`  FAIL ${name}`) }
}

console.log('shared/escrow 在 Node 環境的行為：')
check('72h 未出貨 → cancelled',
  applyDeadlines(base, 73 * HOUR).status === 'cancelled')
check('71h 還沒到期，維持 escrowed',
  applyDeadlines(base, 71 * HOUR).status === 'escrowed')
check('出貨後 15 天查無送達 → refunded',
  applyDeadlines({ ...base, status: 'shipped', shippedAt: 0 }, 15 * DAY).status === 'refunded')
check('送達後 8 天 → 自動放款 completed',
  applyDeadlines({ ...base, status: 'delivered', deliveredAt: 0 }, 8 * DAY).status === 'completed')
check('送達後 6 天仍在驗收期',
  applyDeadlines({ ...base, status: 'delivered', deliveredAt: 0 }, 6 * DAY).status === 'delivered')
check('爭議逾期不自動裁決（人要判）',
  applyDeadlines({ ...base, status: 'disputed', disputedAt: 0 }, 30 * DAY).status === 'disputed')
check('escrowed 時只有賣家能出貨',
  actionsFor(base, 'seller').includes('ship') && actionsFor(base, 'buyer').length === 0)
check('delivered 時買家可確認或申訴',
  actionsFor({ ...base, status: 'delivered' }, 'buyer').length === 2)
check('新賣家保證金 10%', depositFor(1000, 0) === 100)
check('老賣家保證金 2%', depositFor(1000, 100) === 20)
check('保證金有絕對上限', depositFor(10_000_000, 0) === 5000)
check('壞單號擋下', !looksLikeTracking('BAD'))
check('正常單號放行', looksLikeTracking('ABC12345678'))

/* ---------------- 公平抽選 ---------------- */
import { commitOf, seatSequence, verifyReveal, hexToBytes, bytesToHex } from '../../src/shared/fairness.js'

console.log('\nshared/fairness：')
const seed = 'a'.repeat(64)
const seed2 = 'b'.repeat(64)
const prizes = [
  { prizeId: 'LAST', total: 1 }, { prizeId: 'A', total: 2 },
  { prizeId: 'B', total: 5 }, { prizeId: 'C', total: 12 }, { prizeId: 'D', total: 80 }
]
const N = 100

const commit = await commitOf(seed)
check('commit 是 64 位 hex', /^[0-9a-f]{64}$/.test(commit))
check('hex 來回一致', bytesToHex(hexToBytes(seed)) === seed)

const s1 = await seatSequence(seed, 'drand:12345', prizes)
const s1again = await seatSequence(seed, 'drand:12345', prizes)
check('籤序長度 = 總籤數', s1.length === N)
check('同樣輸入 → 同樣籤序（決定性）', s1.join() === s1again.join())

const counts = s1.reduce<Record<string, number>>((m, p) => ((m[p] = (m[p] ?? 0) + 1), m), {})
check('籤序是原清單的排列（每個獎的數量沒變）',
  prizes.every(p => counts[p.prizeId] === p.total))

const s2 = await seatSequence(seed2, 'drand:12345', prizes)
const s3 = await seatSequence(seed, 'drand:12346', prizes)
check('server_seed 不同 → 籤序不同', s1.join() !== s2.join())
check('client_seed 不同 → 籤序不同', s1.join() !== s3.join())

const shuffled = [...prizes].reverse()
const s4 = await seatSequence(seed, 'drand:12345', shuffled)
check('獎品傳入順序不影響結果', s1.join() === s4.join())

check('正確的 reveal 通過驗證',
  (await verifyReveal({ serverSeed: seed, commitHash: commit, clientSeed: 'drand:12345', prizes, publishedSequence: s1 })).ok)
check('換過 seed 的 reveal 被抓到',
  !(await verifyReveal({ serverSeed: seed2, commitHash: commit, clientSeed: 'drand:12345', prizes, publishedSequence: s1 })).ok)
const tampered = [...s1]; tampered[0] = tampered[0] === 'D' ? 'LAST' : 'D'
check('竄改一個籤位被抓到',
  !(await verifyReveal({ serverSeed: seed, commitHash: commit, clientSeed: 'drand:12345', prizes, publishedSequence: tampered })).ok)

// 分布粗檢：跑 400 個不同 seed，LAST 落在每個位置的次數應該接近均勻。
// 這不是嚴格統計檢定，只是抓「明顯偏向某一端」這種實作錯誤（例如取餘數偏差、迴圈方向寫錯）。
const small = [{ prizeId: 'LAST', total: 1 }, { prizeId: 'D', total: 9 }]
const hist = new Array(10).fill(0)
for (let i = 0; i < 400; i++) {
  const sq = await seatSequence(await (async () => {
    const b = new Uint8Array(32); b[0] = i & 255; b[1] = i >> 8; return bytesToHex(b)
  })(), 'x', small)
  hist[sq.indexOf('LAST')]++
}
const [mn, mx] = [Math.min(...hist), Math.max(...hist)]
check(`LAST 位置分布沒有明顯偏斜（每格期望 40，實際 ${mn}–${mx}）`, mn >= 20 && mx <= 65)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
