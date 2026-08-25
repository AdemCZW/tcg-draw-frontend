/**
 * 抽卡池結算的商業邏輯。
 *
 * 規則本身不在這裡 —— 在 ./shared/pool-settlement.ts，跟前端同一份。
 * 這個檔案只負責「把規則的判斷結果寫進資料庫，並且移動點數」。
 * 結構刻意跟 orders-service.ts 對齊：那一套（純函式規則 + 薄薄的資料層）
 * 已經在託管訂單上跑過，兩邊的心智模型一樣，讀的人不用學兩套。
 *
 * ── 帳本科目 ──────────────────────────────────────────────────────
 * 抽卡（draw）：
 *   買家  −票價   'draw'                 ref = drawId（原本就有的那一筆）
 *   賣家  +amount 'pool-ticket'          ref = settlementId
 *   平台  +fee    'pool-fee'             ref = settlementId（fee = 0 時不寫）
 * 釋放（released）：
 *   **沒有分錄。** 錢在抽卡當下就已經記在賣家名下了，釋放改的是
 *   「算不算保留額」，而保留額是推導的 —— 狀態一變，保留額自然就少了。
 *   這跟託管訂單的凍結是同一個模型：凍結消失不需要分錄。
 * 退款（refunded，賣家逾期未出貨）：
 *   賣家  −amount 'pool-ticket-refund'   ref = settlementId
 *   平台  −fee    'pool-fee-refund'      ref = settlementId
 *   買家  +票價   'pool-refund'          ref = settlementId
 * 回收（recycled，買家接受賣家的報價）：
 *   賣家  −報價   'pool-recycle-out'     ref = settlementId
 *   買家  +報價   'pool-recycle-in'      ref = settlementId
 *
 * 每一組的 delta 相加都是 0，所以全站 SUM(points_ledger.delta) 恆等於
 * 實際發行量（儲值 + 平台發放 + 註冊禮）。這是這整套設計唯一的驗收標準。
 *
 * 每一筆都帶 settlementId，靠 ledger_once（ref_id, user_id, reason）擋重複：
 * 逾期掃描可能被多個請求同時觸發，重試必須是安全的。
 */
import type { Tx } from './db.js'
import { sql as root } from './db.js'
import { credit, lockSpender, walletOf } from './money.js'
import { notify } from './notify.js'
import { PLATFORM_ID } from './orders-service.js'
import {
  POOL_SHIP_DEADLINE_MS, RESERVED_STATUSES, applySettlementDeadline,
  splitTicket, type SettlementStatus, type Settlement
} from './shared/pool-settlement.js'

type Row = Record<string, unknown>

export interface SettlementRow {
  id: string
  poolId: string
  sellerId: string
  buyerId: string
  drawId: string
  seat: number
  prizeId: string
  amount: number
  fee: number
  selfDraw: boolean
  status: SettlementStatus
  createdAt: number
  shipDueAt: number | null
  shippedAt: number | null
  closedAt: number | null
  closedBy: string | null
}

export function toSettlement(r: Row): SettlementRow {
  return {
    id: r.id as string,
    poolId: r.pool_id as string,
    sellerId: r.seller_id as string,
    buyerId: r.buyer_id as string,
    drawId: r.draw_id as string,
    seat: Number(r.seat),
    prizeId: r.prize_id as string,
    amount: Number(r.amount),
    fee: Number(r.fee),
    selfDraw: Boolean(r.self_draw),
    status: r.status as SettlementStatus,
    createdAt: Number(r.created_at),
    shipDueAt: r.ship_due_at == null ? null : Number(r.ship_due_at),
    shippedAt: r.shipped_at == null ? null : Number(r.shipped_at),
    closedAt: r.closed_at == null ? null : Number(r.closed_at),
    closedBy: (r.closed_by as string) ?? null
  }
}

const asDeadlineInput = (s: SettlementRow): Settlement => ({
  id: s.id, status: s.status, createdAt: s.createdAt,
  shipDueAt: s.shipDueAt, shippedAt: s.shippedAt
})

/**
 * 抽卡的貸方。
 *
 * 在 draw() 的同一個交易裡呼叫 —— 借方（買家 −票價）與貸方必須是原子的，
 * 分成兩個交易寫的話，中間掛掉就會留下一筆只有借方的抽卡，
 * 而那正是這整套要修的問題。
 */
export async function creditDraw(
  tx: Tx, opts: {
    poolId: string; sellerId: string; buyerId: string; drawId: string
    ticketPrice: number; feeRate: number
    items: { seat: number; prizeId: string }[]
    now: number
  }
) {
  const { fee, sellerAmount } = splitTicket(opts.ticketPrice, opts.feeRate)
  /* 賣家抽自己的池不禁止：這個模型下錢從自己流到自己，沒有新點數被創造，
     所以不是攻擊。但要標記起來 —— 唯一殘留的濫用面是「刷進度騙跟抽」，
     公開的進度顯示會依這個旗標排除（見 routes/pools.ts 的 loadPublic）。 */
  const selfDraw = opts.sellerId === opts.buyerId

  const rows = opts.items.map(it => ({
    id: `st-${opts.drawId}-${it.seat}`,
    pool_id: opts.poolId, seller_id: opts.sellerId, buyer_id: opts.buyerId,
    draw_id: opts.drawId, seat: it.seat, prize_id: it.prizeId,
    amount: sellerAmount, fee, self_draw: selfDraw,
    status: 'held', created_at: opts.now
  }))
  await tx`insert into pool_settlements ${tx(rows as never)}`

  for (const r of rows) {
    await credit(tx, opts.sellerId, sellerAmount, 'pool-ticket', r.id)
    // fee = 0 時不寫一筆 delta 0 的空分錄 —— 帳本裡的每一列都該代表真的發生過的移動
    if (fee > 0) await credit(tx, PLATFORM_ID, fee, 'pool-fee', r.id)
  }
  return { fee, sellerAmount, selfDraw, count: rows.length }
}

/* ---------------- 狀態轉換 ---------------- */

/** 買家申請出貨：held → awaiting_ship，賣家的出貨時鐘開始跑 */
export async function markShipRequested(tx: Tx, prizeIds: string[], now: number) {
  await tx`
    update pool_settlements
       set status = 'awaiting_ship', ship_due_at = ${now + POOL_SHIP_DEADLINE_MS}
     where prize_id = any(${prizeIds}) and status = 'held'
  `
}

/** 賣家出貨：awaiting_ship → shipped，鑑賞期開始跑 */
export async function markShipped(tx: Tx, prizeIds: string[], now: number) {
  await tx`
    update pool_settlements set status = 'shipped', shipped_at = ${now}
     where prize_id = any(${prizeIds}) and status = 'awaiting_ship'
  `
}

/**
 * 釋放一筆。**不寫分錄** —— 錢在抽卡當下就已經在賣家名下，
 * 這裡改的只是「還算不算保留額」。
 */
export async function release(
  tx: Tx, s: SettlementRow, closedBy: 'buyer-confirm' | 'inspect-timeout' | 'vault-accept', now: number
) {
  await tx`
    update pool_settlements set status = 'released', closed_at = ${now}, closed_by = ${closedBy}
     where id = ${s.id} and status = any(${RESERVED_STATUSES as unknown as string[]})
  `
}

/**
 * 退款：賣家逾期未出貨。
 *
 * 錢從保留額原路退回買家，賣家的違約次數加一。
 * 卡從來沒有離開賣家手上，所以買家卡冊那一列標成 refunded（不是 recycled ——
 * 那兩件事的責任歸屬不同，見 migration 017 的說明）。
 */
export async function refund(tx: Tx, s: SettlementRow, now: number) {
  const done = await tx`
    update pool_settlements set status = 'refunded', closed_at = ${now}, closed_by = 'ship-timeout'
     where id = ${s.id} and status = 'awaiting_ship'
     returning id
  `
  // 影響 0 列表示別人先處理過了。不能繼續寫分錄，否則同一筆退兩次
  if (!done.length) return false

  await credit(tx, s.sellerId, -s.amount, 'pool-ticket-refund', s.id)
  if (s.fee > 0) await credit(tx, PLATFORM_ID, -s.fee, 'pool-fee-refund', s.id)
  await credit(tx, s.buyerId, s.amount + s.fee, 'pool-refund', s.id)

  await tx`update prizes set status = 'refunded' where id = ${s.prizeId}`
  await tx`update sellers set default_count = default_count + 1 where id = ${s.sellerId}`

  await notify({
    userId: s.buyerId, kind: 'system',
    title: '賣家逾期未出貨，已退還票金',
    body: `${s.amount + s.fee} 點已經退回你的帳戶。`,
    link: '/wallet', refId: 'pool-refund:' + s.id
  }, tx)
  return true
}

/**
 * 買家接受賣家宣告的買回價。
 *
 * points 由呼叫端從 pool_prizes.buyback 直接讀出來 —— 那是賣家在建池時
 * 宣告、寫進 commit 鎖死的金額，**不是任何比率乘 refPrice 的結果**。
 * 這一層不知道也不需要知道那個數字怎麼來的，它只負責移動點數。
 *
 * 「這筆交易取消一半」：卡本來就還在賣家手上（從沒出貨），買家把卡還回去、
 * 拿回部分點數。**錢從這個池的保留額出，沒有任何新點數被創造。**
 *
 * 順序很重要：先把這一列的狀態改掉（它就不再計入保留額），再算賣家的可動用。
 * 反過來的話這筆保留額會把自己凍住，賣家永遠付不出來 ——
 * 接受出價時也踩過同一個坑（見 docs/HANDOFF.md 3.2）。
 */
export async function acceptRecycle(
  tx: Tx, s: SettlementRow, points: number, now: number
): Promise<{ ok: true } | { ok: false; error: 'WRONG_STATE' | 'SELLER_UNFUNDED' }> {
  const done = await tx`
    update pool_settlements set status = 'recycled', closed_at = ${now}, closed_by = 'recycle'
     where id = ${s.id} and status in ('held', 'awaiting_ship')
     returning id
  `
  if (!done.length) return { ok: false, error: 'WRONG_STATE' }

  await lockSpender(tx, s.sellerId)
  const w = await walletOf(s.sellerId, tx)
  /* 買回價通常低於票價，這筆保留額剛剛才被解開，所以「原路退」自然付得出來。
     但單張大獎的買回價可以遠高於一張票的價格（護欄管的是整池的總和，
     不是單張）—— 那時候差額要從賣家自己的可動用出。付不出來就不能成交，
     而且要照實說：假裝成交會讓買家的卡消失卻沒拿到點數。 */
  if (w.available < points) return { ok: false, error: 'SELLER_UNFUNDED' }

  await credit(tx, s.sellerId, -points, 'pool-recycle-out', s.id)
  await credit(tx, s.buyerId, points, 'pool-recycle-in', s.id)
  await tx`update prizes set status = 'recycled' where id = ${s.prizeId}`
  return { ok: true }
}

/* ---------------- 逾期掃描 ---------------- */

/**
 * 把所有到期的結算補算到現在。
 *
 * 跟 orders-service.sweep() 一樣是「拉」不是「推」：時限是用時間戳算的，
 * 排程掛掉不會讓狀態算錯，只會讓沒人看的那幾筆晚一點結案。
 *
 * userId 有值時只掃跟這個人有關的 —— 讀取自己的清單時順手補算，
 * 使用者看到的永遠是算到當下的狀態，不是上一輪排程的殘影。
 */
export async function sweepSettlements(tx: Tx, userId?: string): Promise<number> {
  const rows = userId
    ? await tx`
        select * from pool_settlements
         where status = any(${RESERVED_STATUSES as unknown as string[]})
           and (seller_id = ${userId} or buyer_id = ${userId})
         for update`
    : await tx`
        select * from pool_settlements
         where status = any(${RESERVED_STATUSES as unknown as string[]})
         for update`

  const now = Date.now()
  let changed = 0
  for (const r of rows) {
    const s = toSettlement(r as Row)
    const next = applySettlementDeadline(asDeadlineInput(s), now)
    if (!next) continue
    if (next.status === 'refunded') {
      if (await refund(tx, s, now)) changed++
    } else if (next.status === 'released') {
      await release(tx, s, next.closedBy as 'inspect-timeout' | 'vault-accept', now)
      changed++
    }
  }
  return changed
}

/** 排程用的包裝。自己開交易，呼叫端不用管交易邊界 */
export const sweepSettlementsAll = () => root.begin(tx => sweepSettlements(tx))
