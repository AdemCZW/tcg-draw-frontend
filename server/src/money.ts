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

export interface Wallet {
  points: number
  /** 凍結：進行中訂單的貨款與保證金、pending 的交易報價，再加上抽卡的保留額 */
  locked: number
  /**
   * 保留額。抽卡的票金已經貸記給賣家，但那一張卡還沒出貨、還沒過鑑賞期 ——
   * 看得到、動不了。它是 locked 的一部分，另外報出來只是為了讓賣家的
   * 錢包畫面能分辨「這筆是買東西被凍住」還是「這筆是我還沒交付的貨款」。
   *
   * 跟餘額一樣是**推導**的：SUM(pool_settlements.amount) where status 還沒結束。
   * 不存欄位的理由見這個檔案開頭。
   */
  reserved: number
  available: number
}

export async function walletOf(userId: string, db: Db = root): Promise<Wallet> {
  const [bal] = await db<{ sum: string | null }[]>`
    select sum(delta)::text as sum from points_ledger where user_id = ${userId}
  `
  /* 這裡原本還 union 了一段「尾籤競標的最高出價也要凍結」。尾籤競標整組移除了
     （前端沒有介面、後端從來沒有寫入 bids 的端點），那段子查詢永遠回空集合 ——
     留著會讓讀的人以為平台有競標，而且每次查餘額都白掃兩張表。 */
  const [lock] = await db<{ sum: string | null }[]>`
    select sum(amount)::text as sum from (
      select price   as amount from orders where buyer_id  = ${userId} and status = any(${OPEN as unknown as string[]})
      union all
      select deposit as amount from orders where seller_id = ${userId} and status = any(${OPEN as unknown as string[]})
      union all
      /* 待回應的交易邀約也要凍結。
         沒有這一段的話，餘額 1000 的人可以同時對十張卡各出價 1000 ——
         lockSpender 保證只有一筆會成功、不會憑空造錢，但另外九個持有人
         會花時間去看一個根本付不出來的出價，而且以為自己有九個買家。
         出價是有金錢意義的承諾，錢就該真的在那裡。
         代價是不能同時廣撒超過餘額的出價 —— 那是刻意的取捨。 */
      select o.points as amount from trade_offers o
       where o.from_user = ${userId} and o.status = 'pending'
    ) t
  `
  /* 抽卡的保留額也是一種凍結，而且**跟訂單的凍結是同一個模型**：
     票金在抽卡當下就已經貸記給賣家（否則帳本會單向蒸發，見 pool-settlement.ts），
     但那張卡還沒交付，所以那筆錢不該是可動用的。
     用「已入帳但仍受限」表達，而不是「先不入帳、之後再補一筆」——
     後者要在釋放時再寫一次分錄，而任何「之後再補」的分錄都有補不到的一天。 */
  const [held] = await db<{ sum: string | null }[]>`
    select sum(amount)::text as sum from pool_settlements
     where seller_id = ${userId} and status in ('held', 'awaiting_ship', 'shipped')
  `
  const points = Number(bal?.sum ?? 0)
  const reserved = Number(held?.sum ?? 0)
  const locked = Number(lock?.sum ?? 0) + reserved
  return { points, locked, reserved, available: points - locked }
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
