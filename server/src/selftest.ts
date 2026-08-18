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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
