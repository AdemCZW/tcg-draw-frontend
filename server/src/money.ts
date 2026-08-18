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
 * 寫一筆帳。
 *
 * 帶 refId 的分錄靠 ledger_once 唯一索引擋重複 —— 逾期掃描可能被多個請求
 * 同時觸發，沒有這層保護就會重複入帳。ON CONFLICT DO NOTHING 讓重試是安全的。
 */
export async function credit(
  db: Tx, userId: string, delta: number, reason: string, refId?: string
) {
  await db`
    insert into points_ledger (user_id, delta, reason, ref_id)
    values (${userId}, ${delta}, ${reason}, ${refId ?? null})
    on conflict do nothing
  `
}
