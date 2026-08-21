/**
 * 訂單的商業邏輯。
 *
 * 規則本身不在這裡 —— 在 ./shared/escrow.ts，跟前端同一份。
 * 這個檔案只負責「把規則的判斷結果寫進資料庫，並且結算點數」。
 */
import type { Order } from './shared/domain.js'
import { applyDeadlines, depositFor } from './shared/escrow.js'
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
  await releasePrize(tx, o)
}

/**
 * 結案時把掛單背後那張卡的歸屬結清。
 *
 * 原本這件事整段不存在：庫內轉移（orders.ts 的 delivery === 'vault'）當場改
 * prizes.user_id，但**需寄送的訂單從頭到尾沒有動過 prizes**。後果有兩個，
 * 兩個都會發生在正常使用者身上：
 *
 *   1 買家付了點數、收到實體卡，但他的卡冊裡什麼都沒有 —— 平台的紀錄上
 *     那張卡仍然掛在賣家名下。
 *   2 賣家可以一直重賣同一張卡。訂單完成後 listings.status 變成 'sold'，
 *     listings_prize_live / listings_cert_live 兩條唯一索引都是
 *     `where status = 'live'`，所以它們立刻不再擋 —— 再上架一次就過了。
 *     沒有鑑定編號的卡（RAW，certNo = null）連「同時」都擋不住：
 *     cert 索引跳過 null，所以同一張卡可以同時掛出好幾筆有效掛單，
 *     好幾個買家的點數同時被凍結，而賣家只有一張卡。
 *
 * 這裡把兩件事一起補上。所有訂單都來自 delivery = 'ship' 的掛單
 * （vault 在 orders.ts 當場過戶、根本不建訂單），所以卡的實體去向是確定的：
 *   completed          → 卡寄到買家手上了，過戶給買家
 *   refunded/cancelled → 交易沒成，卡還在賣家那邊
 * 兩種情況狀態都回到 'shipped'（＝在人手上、不在保管庫），
 * 之後要再上架就是「需寄送」那條路。
 *
 * 只動 status = 'listed' 的那一列：那是上架時標記的，代表這張卡確實是被
 * 這筆掛單鎖住的。加這個條件讓重複呼叫不會覆蓋掉之後才發生的狀態變化。
 */
async function releasePrize(tx: Tx, o: Order) {
  if (o.status !== 'completed' && o.status !== 'refunded' && o.status !== 'cancelled') return
  const owner = o.status === 'completed' ? o.buyerId : o.sellerId
  await tx`
    update prizes p set user_id = ${owner}, status = 'shipped'
    from listings l
    where l.id = ${o.listingId} and p.id = l.prize_id and p.status = 'listed'
  `
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
