/**
 * 訂單的商業邏輯。
 *
 * 規則本身不在這裡 —— 在 ../../src/shared/escrow.ts，跟前端同一份。
 * 這個檔案只負責「把規則的判斷結果寫進資料庫，並且結算點數」。
 */
import type { Order } from '../../src/shared/domain.js'
import { applyDeadlines, depositFor } from '../../src/shared/escrow.js'
import type { Tx } from './db.js'
import { credit, OPEN } from './money.js'

/** 沒收的保證金進這個帳戶 */
export const PLATFORM_ID = 'u-platform'

type Row = Record<string, unknown>

export function toOrder(r: Row): Order {
  return {
    id: r.id as string,
    listingId: r.listing_id as string,
    card: r.card as Order['card'],
    price: Number(r.price),
    deposit: Number(r.deposit),
    buyerId: r.buyer_id as string,
    buyerName: r.buyer_name as string,
    sellerId: r.seller_id as string,
    sellerName: r.seller_name as string,
    status: r.status as Order['status'],
    createdAt: Number(r.created_at),
    shippedAt: r.shipped_at == null ? undefined : Number(r.shipped_at),
    deliveredAt: r.delivered_at == null ? undefined : Number(r.delivered_at),
    settledAt: r.settled_at == null ? undefined : Number(r.settled_at),
    tracking: (r.tracking as string) ?? undefined,
    disputedAt: r.disputed_at == null ? undefined : Number(r.disputed_at),
    disputeReason: (r.dispute_reason as string) ?? undefined,
    hasUnboxingVideo: (r.has_unboxing_video as boolean) ?? undefined,
    closedBy: (r.closed_by as Order['closedBy']) ?? undefined
  }
}

export { depositFor }

/**
 * 結算一張已經結案的訂單。
 *
 * 只有 completed 會真的移動貨款 —— 下單時點數是「凍結」不是「扣款」，
 * 凍結是從進行中訂單推算的，所以退款與取消不需要任何分錄，
 * 訂單狀態一變，凍結自然就消失了。
 *
 * 每一筆分錄都帶 orderId，靠 ledger_once 唯一索引擋重複：
 * 逾期掃描可能同時被多個請求觸發，重試必須是安全的。
 */
export async function settle(tx: Tx, o: Order) {
  if (o.status === 'completed') {
    await credit(tx, o.buyerId, -o.price, 'order-pay', o.id)
    await credit(tx, o.sellerId, o.price, 'order-receive', o.id)
  }
  // 賣家違約才沒收保證金：逾期未出貨，或爭議判買家勝
  const forfeit = o.closedBy === 'ship-timeout' || o.closedBy === 'dispute-buyer'
  if (forfeit && o.deposit > 0) {
    await credit(tx, o.sellerId, -o.deposit, 'deposit-forfeit', o.id)
    await credit(tx, PLATFORM_ID, o.deposit, 'deposit-collect', o.id)
  }
}

/** 把一張訂單寫回資料庫（只寫會變的欄位） */
export async function save(tx: Tx, o: Order) {
  await tx`
    update orders set
      status = ${o.status},
      shipped_at = ${o.shippedAt ?? null},
      delivered_at = ${o.deliveredAt ?? null},
      settled_at = ${o.settledAt ?? null},
      tracking = ${o.tracking ?? null},
      disputed_at = ${o.disputedAt ?? null},
      dispute_reason = ${o.disputeReason ?? null},
      has_unboxing_video = ${o.hasUnboxingVideo ?? null},
      closed_by = ${o.closedBy ?? null}
    where id = ${o.id}
  `
}

/**
 * 把所有到期的訂單補算到現在。
 *
 * 時間軸是「拉」不是「推」：不靠排程去改狀態，而是每次讀取時用當下時間重算。
 * 排程仍然要掛（沒人讀的訂單也得結案），但排程只是再呼叫一次這個函式，
 * 不是唯一真相 —— 排程掛掉不會讓狀態錯，只會讓結案晚一點。
 */
export async function sweep(tx: Tx, userId?: string): Promise<number> {
  const rows = userId
    ? await tx`select * from orders where status = any(${OPEN as unknown as string[]})
               and (buyer_id = ${userId} or seller_id = ${userId}) for update`
    : await tx`select * from orders where status = any(${OPEN as unknown as string[]}) for update`

  const now = Date.now()
  let changed = 0
  for (const r of rows) {
    const o = toOrder(r as Row)
    const next = applyDeadlines(o, now)
    if (next === o) continue
    await save(tx, next)
    await settle(tx, next)
    changed++
  }
  return changed
}
