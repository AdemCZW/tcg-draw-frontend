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
import { notify } from './notify.js'

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
    closedBy: (r.closed_by as Order['closedBy']) ?? undefined,
    /* 收件資訊：只有賣家視角、訂單還開著時才會有值（見 routes/orders.ts
       的 canShip）。這裡不做任何權限判斷 —— 判斷在 SQL 那一層做完了，
       在這裡再判一次等於讓同一條規則有兩個來源。
       五個欄位全空就不給整個物件，前端才好用「有沒有 ship」判斷。 */
    ...(r.ship_name || r.ship_phone || r.ship_line1 || r.ship_city || r.ship_zip
      ? {
          ship: {
            name: (r.ship_name as string) ?? undefined,
            phone: (r.ship_phone as string) ?? undefined,
            zip: (r.ship_zip as string) ?? undefined,
            city: (r.ship_city as string) ?? undefined,
            line1: (r.ship_line1 as string) ?? undefined
          }
        }
      : {})
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
 *
 * ── 為什麼通知也寫在這裡 ────────────────────────────────────────────
 * 這支不只在「結案」時被呼叫 —— act()（人按的）與 sweep()（時限掃描）
 * 每一次狀態真的改變都會走到它，而且**只有這兩條路**改得動訂單狀態。
 * 把通知放在這裡，兩條路各自的入口就不需要「記得也發一則」；
 * 放在路由層的話，逾期那條（沒有人在場、正是最該通知的一條）永遠會漏。
 *
 * 通知用 notify(..., tx) 寫在同一筆交易裡，而且**不吞例外**：
 * Postgres 的交易一旦 abort，後面的語句都會失敗，吞掉只會讓錯誤
 * 變成一堆看不懂的後續失敗。冪等交給 notifications 的唯一索引
 * （user_id, kind, ref_id），不能靠「這支被呼叫幾次」——
 * sweep 每一次讀取都可能觸發。
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
  await notifyTransition(tx, o)
}

const pts = (n: number) => `${n.toLocaleString('zh-TW')} 點`

/**
 * 這次狀態轉換要通知誰。
 *
 * 進來的 o 一定是**剛剛才變成這個狀態**的：act() 只在動作合法時呼叫，
 * sweep() 在 applyDeadlines 回傳同一個物件時就 continue 了。
 * 所以這裡用 status 判斷「剛發生什麼事」是安全的。
 *
 * 爭議裁決（closedBy = dispute-*）刻意不在這裡發：routes/admin.ts 已經
 * 發過買賣雙方各一則，在這裡再發一次會變成同一件事兩則不同的文案。
 */
async function notifyTransition(tx: Tx, o: Order) {
  const name = o.card?.name ?? '卡片'

  /* 賣家剛按下出貨。買家的鐘從這一刻開始跑，而**沉默＝視同送達** ——
     這是整條時間線裡唯一一個「你什麼都不做，錢就會過去」的規則，
     不通知等於讓人在不知道自己被計時的情況下被計時。
     兩段時限都寫出來：14 天視同送達、再 7 天驗收期滿放款，總共 21 天。 */
  if (o.status === 'shipped') {
    await notify({
      userId: o.buyerId, kind: 'order',
      title: '賣家已寄出，收到請確認',
      body: `「${name}」${o.tracking ? `，單號 ${o.tracking}` : ''}。`
        + '收到後請按「我已收到」放款。14 天內沒有回報會視同送達，'
        + '再過 7 天驗收期就自動放款給賣家。',
      link: '/me/orders', refId: 'order-shipped:' + o.id
    }, tx)
    return
  }

  /* 14 天到了，系統視同送達。這是買家的**最後警告** ——
     從這一刻起只剩 7 天可以開爭議，過了錢就是賣家的。
     稽核清單沒有列這一則，但它是那條規則真正咬人的時刻：
     「賣家已寄出」那則是 14 天前發的，早就被其他通知洗掉了。 */
  if (o.status === 'delivered') {
    await notify({
      userId: o.buyerId, kind: 'order',
      title: '已視同送達，7 天內可以反映問題',
      body: `「${name}」超過 14 天沒有回報，系統視同你已收到。`
        + `7 天驗收期滿後 ${pts(o.price)}會放款給賣家，之後就不能再開爭議了。`
        + '沒收到貨請盡快申訴。',
      link: '/me/orders', refId: 'order-delivered:' + o.id
    }, tx)
    return
  }

  /* 買家開了爭議。賣家的貨款被凍住，而且他需要去說明 ——
     這是少數「別人的動作直接凍結你的錢」的情況。 */
  if (o.status === 'disputed') {
    await notify({
      userId: o.sellerId, kind: 'order',
      title: '買家對這筆交易提出爭議',
      body: `「${name}」的 ${pts(o.price)}已暫時凍結，等客服處理。`
        + '請到客服工單補充你這邊的說明。',
      link: '/seller/shipping', refId: 'order-disputed:' + o.id
    }, tx)
    return
  }

  if (o.status === 'completed' && o.closedBy === 'buyer-confirm') {
    // 買家自己按的，他當場看得到結果；只有賣家不在場
    await notify({
      userId: o.sellerId, kind: 'order',
      title: '買家已確認收貨，貨款入帳',
      body: `「${name}」的 ${pts(o.price)}已進到你的可動用點數。`,
      link: '/seller/shipping', refId: 'order-completed:' + o.id
    }, tx)
    return
  }

  /* 驗收期滿自動完成。兩邊都不在場（掃描觸發），而且對兩邊的意義不同：
     賣家是收款，買家是「爭議窗口從此關閉」。 */
  if (o.status === 'completed' && o.closedBy === 'auto-release') {
    await notify({
      userId: o.sellerId, kind: 'order',
      title: '驗收期已滿，貨款入帳',
      body: `「${name}」的 ${pts(o.price)}已進到你的可動用點數。`,
      link: '/seller/shipping', refId: 'order-completed:' + o.id
    }, tx)
    await notify({
      userId: o.buyerId, kind: 'order',
      title: '訂單已完成',
      body: `「${name}」的 7 天驗收期已滿，${pts(o.price)}已放款給賣家，`
        + '這筆交易結案。之後有問題請開客服單。',
      link: '/me/orders', refId: 'order-completed:' + o.id
    }, tx)
    return
  }

  /* 賣家逾期未出貨，系統自動取消。買家退款、**賣家的保證金被沒收** ——
     沒收那件事賣家完全不在場，不通知的話他只能自己某天打開錢包才發現。 */
  if (o.status === 'cancelled' && o.closedBy === 'ship-timeout') {
    await notify({
      userId: o.buyerId, kind: 'order',
      title: '賣家逾期未出貨，已自動退款',
      body: `「${name}」的 ${pts(o.price)}已解除凍結，回到你的可動用點數。`,
      link: '/me/orders', refId: 'order-forfeit:' + o.id
    }, tx)
    await notify({
      userId: o.sellerId, kind: 'order',
      title: '逾期未出貨，保證金已沒收',
      body: `「${name}」超過期限沒有出貨，訂單已取消、貨款退還買家，`
        + `保證金 ${pts(o.deposit)}一併沒收。`,
      link: '/seller/shipping', refId: 'order-forfeit:' + o.id
    }, tx)
  }
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
  /* custodian 一起改：託管訂單的完成定義就是「實體卡寄到了買家手上」
     （出貨＋簽收或鑑賞期滿），退款/取消則是卡根本沒離開賣家。
     這是站內唯一「實體真的移動」的交易路徑，custodian 不跟著走的話，
     buyer 之後把這張卡上架，能不能上架的判準（custodian 是不是自己）
     會給出錯的答案。 */
  await tx`
    update prizes p set user_id = ${owner}, custodian_id = ${owner}, status = 'shipped'
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
