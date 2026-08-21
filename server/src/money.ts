/**
 * 點數。
 *
 * 沒有 balance 欄位，也沒有 locked 欄位 —— 兩個都是推算出來的：
 *   餘額   = 帳本所有 delta 的總和
 *   凍結   = 進行中訂單裡「我付的貨款」加「我押的保證金」
 *   可動用 = 餘額 − 凍結
 *
 * 存欄位的版本會有對不起來的一天，而且對帳時你不知道該信哪個。
 * 前端已經踩過一次：訂單顯示已鎖點，託管中卻是 0。
 */
import type { Db, Tx } from './db.js'
import { sql as root } from './db.js'

export const OPEN = ['escrowed', 'shipped', 'delivered', 'disputed'] as const

export interface Wallet { points: number; locked: number; available: number }

export async function walletOf(userId: string, db: Db = root): Promise<Wallet> {
  const [bal] = await db<{ sum: string | null }[]>`
    select sum(delta)::text as sum from points_ledger where user_id = ${userId}
  `
  const [lock] = await db<{ sum: string | null }[]>`
    select sum(amount)::text as sum from (
      select price   as amount from orders where buyer_id  = ${userId} and status = any(${OPEN as unknown as string[]})
      union all
      select deposit as amount from orders where seller_id = ${userId} and status = any(${OPEN as unknown as string[]})
      union all
      -- 競標中的最高出價也是凍結：被超過就自動解凍（is_top 變 false）
      select b.amount from bids b join auction_lots l on l.id = b.lot_id
       where b.user_id = ${userId} and b.is_top and l.status = 'live'
    ) t
  `
  const points = Number(bal?.sum ?? 0)
  const locked = Number(lock?.sum ?? 0)
  return { points, locked, available: points - locked }
}

/**
 * 把「這個人的錢包」鎖起來。
 *
 * walletOf() 是推算出來的（SUM(delta) 減去進行中訂單），它沒有一列可以鎖 ——
 * 也就是說兩筆同時進行的交易會讀到同一個餘額、各自通過各自的「夠不夠」檢查，
 * 然後各自花掉那筆錢。Postgres 預設的 READ COMMITTED 不會擋這件事：
 * 兩邊 SUM 的是同一批已提交的列，彼此看不見對方還沒提交的分錄。
 *
 * 實際會發生的事（餘額 1000 點的人）：
 *   同時送出兩筆各 1000 點的購買 → 兩筆鎖的是不同的 listings 列，互不阻擋
 *   → 兩邊都算出 available = 1000 → 兩張訂單都成立 → 凍結 2000、餘額 1000
 *   → 兩張都完成後帳本 SUM 變成 -1000。平台憑空發行了 1000 點。
 *
 * 所以要有一列可以鎖。users 那一列就是這個人的帳戶本身，拿它當閘門：
 * 同一個人的花錢動作被排成一列，不同人之間完全不互相影響。
 *
 * 規則：**任何「先檢查 available 再花錢」的交易，都要先呼叫這個函式。**
 * 呼叫順序固定放在其他資料列（listing / prize / offer）鎖之後、walletOf 之前，
 * 每筆交易只鎖一個使用者，所以不會形成死結環。
 */
export async function lockSpender(tx: Tx, userId: string) {
  await tx`select id from users where id = ${userId} for update`
}

/**
 * 寫一筆帳。
 *
 * 帶 refId 的分錄靠 ledger_once 唯一索引擋重複 —— 逾期掃描可能被多個請求
 * 同時觸發，沒有這層保護就會重複入帳。ON CONFLICT DO NOTHING 讓重試是安全的。
 */
export async function credit(
  db: Db, userId: string, delta: number, reason: string, refId?: string
) {
  await db`
    insert into points_ledger (user_id, delta, reason, ref_id)
    values (${userId}, ${delta}, ${reason}, ${refId ?? null})
    on conflict do nothing
  `
}
