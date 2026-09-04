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
import { Rollback } from './db.js'
import { sql as root } from './db.js'
import { credit, lockSpender, walletOf } from './money.js'
import { notify } from './notify.js'
import { PLATFORM_ID } from './orders-service.js'
import {
  POOL_SHIP_DEADLINE_MS, RESERVED_STATUSES, SELLER_DEFAULT_LIMIT, applySettlementDeadline,
  physicalShipOverdue, splitTicket, type SettlementStatus, type Settlement
} from './shared/pool-settlement.js'

type Row = Record<string, unknown>

export interface SettlementRow {
  id: string
  poolId: string
  sellerId: string
  /**
   * 抽中這一籤的人。**這是歷史事實，不會變，也不是收款人。**
   *
   * 卡的擁有權會透過市場成交、接受出價、贈送而移轉，而這一欄不跟著動 ——
   * 拿它當收款人就是 F-1／F-2：買了二手卡按回收，點數匯給前一個主人。
   * 要付錢、要通知、要判斷「這是不是我的卡」一律用 ownerId。
   */
  buyerId: string
  /**
   * 卡**現在**的擁有者，來自 `prizes.user_id` 的當下值。
   *
   * 為什麼是 join 出來的、不是一個同步維護的欄位：同步要在每一條移轉路徑上
   * 都記得寫一次，漏掉任何一條 bug 就回來了 —— F-1 正是這樣發生的。
   * join 出來的話，未來新增任何移轉路徑都自動正確。
   */
  ownerId: string
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

/**
 * 把資料列轉成 SettlementRow。
 *
 * **一定要帶著 `join prizes pz on pz.id = st.prize_id` 查**，
 * 直接 `select * from pool_settlements` 會在這裡當場炸掉。那是刻意的：
 * 少一個 join 的後果是把錢付給前一個主人，而那種錯誤在測試裡看起來
 * 一切正常（金額對、狀態對，只有收款人是錯的）。寧可大聲壞掉。
 */
export function toSettlement(r: Row): SettlementRow {
  if (r.owner_id == null) {
    throw new Error(
      'toSettlement: 這一列沒有 owner_id。結算的收款人必須是卡片**當下**的擁有者，' +
      '查詢要寫成 `select st.*, pz.user_id as owner_id from pool_settlements st ' +
      'join prizes pz on pz.id = st.prize_id`。詳見 SettlementRow.ownerId 的說明。'
    )
  }
  return {
    id: r.id as string,
    poolId: r.pool_id as string,
    sellerId: r.seller_id as string,
    buyerId: r.buyer_id as string,
    ownerId: r.owner_id as string,
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

/**
 * 買家申請出貨：held → awaiting_ship，賣家的出貨時鐘開始跑。
 *
 * ── 第二個 UPDATE 是什麼（F-5）────────────────────────────────────
 * 寄存確認期滿之後結算已經 released（票金放給賣家）。買家這時候才申請出貨，
 * 第一個 UPDATE 完全不會命中 —— 於是出貨單進了佇列卻沒有任何時鐘：
 * 賣家標不了出貨、逾期不記違約、也不會退款。卡就這樣卡住。
 *
 * 這裡**不把狀態改回 awaiting_ship**：那個狀態算在保留額裡，改回去等於
 * 把已經釋放、賣家可能已經花掉的錢重新凍起來（見 migration 022）。
 * 只掛一個 ship_due_at，狀態留在 released。逾期的手段只有違約紀錄。
 */
export async function markShipRequested(tx: Tx, prizeIds: string[], now: number) {
  const due = now + POOL_SHIP_DEADLINE_MS
  await tx`
    update pool_settlements
       set status = 'awaiting_ship', ship_due_at = ${due}
     where prize_id = any(${prizeIds}) and status = 'held'
  `
  /* `ship_due_at is null` 讓重複申請不會把期限一直往後推 ——
     不然買家只要反覆按申請出貨，賣家就永遠不會逾期。 */
  await tx`
    update pool_settlements set ship_due_at = ${due}
     where prize_id = any(${prizeIds}) and status = 'released'
       and ship_due_at is null and shipped_at is null
  `
}

/**
 * 賣家出貨：awaiting_ship → shipped，鑑賞期開始跑。
 *
 * ── 為什麼這裡要一起動 prizes 與 shipments（F-3）──────────────────
 * 原本這支只改 pool_settlements。走賣家自助出貨那條路的卡因此停在
 * `ship_requested`，而那個狀態上架不行（只收 stashed / shipped）、
 * 回收不行（只收 stashed）、連確認收貨都會被 `status !== 'shipped'` 擋掉
 * 並回一句假話「賣家還沒出貨」—— 他明明寄了。
 * 買家只要沒手動按確認，鑑賞期滿錢照樣放給賣家，而卡永遠鎖死。
 *
 * 後台那條路（routes/admin.ts）本來就有做這兩件事，所以這裡的兩個 UPDATE
 * 都加了狀態守衛：兩條路先後跑到同一筆時，第二次是乾淨的 no-op。
 */
export async function markShipped(tx: Tx, prizeIds: string[], now: number) {
  await tx`
    update pool_settlements set status = 'shipped', shipped_at = ${now}
     where prize_id = any(${prizeIds}) and status = 'awaiting_ship'
  `
  /* 票金已結算的那些（F-5）：只記下實際出貨時間，**狀態不動**。
     改成 'shipped' 會讓它重新算進保留額，而那筆錢早就放出去了。
     記了 shipped_at 之後 physicalShipOverdue() 就是 false，義務結清。 */
  await tx`
    update pool_settlements set shipped_at = ${now}
     where prize_id = any(${prizeIds}) and status = 'released'
       and ship_due_at is not null and shipped_at is null
  `
  /* 只動「申請出貨中」的卡。已經 refunded / recycled 的不能被出貨動作
     救活 —— 那是 F-4 的路（後台標出貨把退過款的卡復活成 shipped，
     買家退款照領、卡再賣一次）。 */
  await tx`
    update prizes set status = 'shipped'
     where id = any(${prizeIds}) and status = 'ship_requested'
  `
  /* 出貨單要等**單上每一張卡都寄出**才算寄出。
     不能用「有交集就標」—— 一張出貨單可以混多個賣家的卡（F-9），
     其中一個賣家寄了不代表整單寄了，那會讓買家看到「已出貨」卻只收到一半。 */
  await tx`
    update shipments sh set status = 'shipped', shipped_at = ${now}
     where sh.status = 'requested'
       and sh.prize_ids && ${prizeIds}
       and not exists (
         select 1 from prizes p
          where p.id = any(sh.prize_ids) and p.status <> 'shipped'
       )
  `
}

/** 釋放的三條路，講成賣家看得懂的話。狀態機的字（closed_by）不該原樣丟給人看 */
const RELEASE_REASON: Record<'buyer-confirm' | 'inspect-timeout' | 'vault-accept', string> = {
  'buyer-confirm': '買家已確認收貨',
  'inspect-timeout': '7 天鑑賞期已滿',
  'vault-accept': '14 天寄存確認期已滿'
}

/**
 * 釋放一筆。**不寫分錄** —— 錢在抽卡當下就已經在賣家名下，
 * 這裡改的只是「還算不算保留額」。
 *
 * ── 為什麼要通知賣家（這支原本一則都不發）────────────────────────────
 * 「不寫分錄」對帳本是對的，對賣家卻造成一個看不見的時刻：他的總餘額
 * 從抽卡當下就沒再變過，變的是**可動用**那個數字 —— 而那是推導出來的，
 * 沒有任何一列帳可以讓他知道「就是現在」。三條釋放路徑（買家確認、
 * 鑑賞期滿、寄存確認期滿）全部發生在他不在場的時候，其中兩條還是掃描
 * 觸發的。結果是賣家只能反覆打開錢包看數字有沒有變。
 *
 * refId 綁**結算 id**（比照 pools-service 的寄存提醒綁 prize id）：
 * 一筆結算只會釋放一次，這是「知道了就好」的事實，不是要一直吵的狀態。
 * 上面的 `returning id` 是第一道閘 —— 掃描會重跑，沒有它同一筆會重發。
 */
export async function release(
  tx: Tx, s: SettlementRow, closedBy: 'buyer-confirm' | 'inspect-timeout' | 'vault-accept', now: number
): Promise<boolean> {
  const done = await tx`
    update pool_settlements set status = 'released', closed_at = ${now}, closed_by = ${closedBy}
     where id = ${s.id} and status = any(${RESERVED_STATUSES as unknown as string[]})
     returning id
  `
  // 影響 0 列表示別人先處理過了（掃描與買家確認可能同時到）。不能再通知一次
  if (!done.length) return false

  await notify({
    userId: s.sellerId, kind: 'listing-sold',
    title: '票金已入帳，可以動用了',
    body: `${RELEASE_REASON[closedBy]}，${s.amount} 點從保留額轉為可動用。`,
    link: '/me/wallet', refId: 'pool-release:' + s.id
  }, tx)
  return true
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
  /* 退給**卡現在的主人**，不是抽中的人（F-2）。
     卡如果在市場上轉手過，抽中的人早就把卡賣掉、收過一次錢了；
     再退他一次票金等於他收兩次，而真正拿不到卡的新主人一毛都沒有。 */
  await credit(tx, s.ownerId, s.amount + s.fee, 'pool-refund', s.id)

  await tx`update prizes set status = 'refunded' where id = ${s.prizeId}`
  await tx`update sellers set default_count = default_count + 1 where id = ${s.sellerId}`

  await notify({
    userId: s.ownerId, kind: 'system',
    title: '賣家逾期未出貨，已退還票金',
    body: `${s.amount + s.fee} 點已經退回你的帳戶。`,
    /* 原本寫的是 '/wallet' —— 前端沒有這條路由（只有 '/me/wallet'，
       見 src/router/index.ts），點下去會掉進 404 的 catch-all。
       通知的價值一半在「點得進去」，指錯地方等於只剩一半。 */
    link: '/me/wallet', refId: 'pool-refund:' + s.id
  }, tx)
  /* 賣家那一側原本完全靜默，而這一則對他的份量比對買家還重：
     票金被收回去了（他可能已經把那筆錢算進可動用），而且違約次數 +1 ——
     滿 SELLER_DEFAULT_LIMIT 次就再也開不了池。這件事發生在掃描裡，
     他不在場，下次撞到 SELLER_SUSPENDED 才知道就太晚了。
     refId 另外開一個前綴：買賣雙方是兩則不同的通知，共用同一個 refId 不會
     互相擋掉（唯一索引帶 user_id），但前綴分開讀 log 時才看得出是哪一側。 */
  await notify({
    userId: s.sellerId, kind: 'system',
    title: '逾期未出貨，票金已退還買家',
    body: `${s.amount} 點從你的帳戶收回，並記一次違約（滿 ${SELLER_DEFAULT_LIMIT} 次不能再開池）。`,
    link: '/seller/shipping', refId: 'pool-refund-seller:' + s.id
  }, tx)
  return true
}

/**
 * 票金已結算，賣家卻逾期沒有交出實體卡 —— 記一次違約，**不退款**（F-5）。
 *
 * 為什麼不退款：那筆錢是寄存確認期滿之後依規則釋放的，賣家可能已經花掉。
 * 事後追回等於平台單方面推翻自己的規則，而且帳本的「釋放不寫分錄」模型
 * 也沒有一條路可以把它倒回去。剩下的唯一手段是違約紀錄 ——
 * 累積到門檻就不能再開池（shared 的 SELLER_DEFAULT_LIMIT）。
 *
 * ship_default_at 是冪等鎖：這支會被每一個讀清單的請求觸發，
 * 沒有它同一筆逾期會在賣家每次上線時再記一次。
 */
export async function markShipDefault(tx: Tx, s: SettlementRow, now: number): Promise<boolean> {
  const done = await tx`
    update pool_settlements set ship_default_at = ${now}
     where id = ${s.id} and status = 'released'
       and ship_due_at is not null and shipped_at is null and ship_default_at is null
     returning id
  `
  if (!done.length) return false

  await tx`update sellers set default_count = default_count + 1 where id = ${s.sellerId}`
  await notify({
    userId: s.ownerId, kind: 'system',
    title: '賣家逾期未出貨',
    body: '這張卡的票金在寄存確認期滿時已經結算，所以不會退款。'
        + '我們已經記錄賣家一次違約，請透過客服協助後續。',
    link: '/me/cards', refId: 'pool-ship-default:' + s.id
  }, tx)
  /* 賣家那一側：**義務沒有結清**，這是這一則跟退款那一則最大的差別。
     票金不會被收回（那筆錢已經依規則釋放了），所以賣家從錢包上完全看不出
     發生過什麼 —— 唯一的變化是一次違約，以及那張他還欠著的實體卡。
     講清楚「現在該做什麼」＝ 還是要寄，不是「已經算了」。 */
  await notify({
    userId: s.sellerId, kind: 'system',
    title: '逾期未交卡，已記一次違約',
    body: `票金不會收回，但這張卡還是要寄（滿 ${SELLER_DEFAULT_LIMIT} 次違約不能再開池）。`,
    link: '/seller/shipping', refId: 'pool-ship-default-seller:' + s.id
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
): Promise<{ ok: true } | { ok: false; error: 'WRONG_STATE' }> {
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
  /* **throw，不是 return**（audit-3 A-1）：上面已經把結算列改成 recycled，
     回傳錯誤值的話 sql.begin 照樣 COMMIT —— 實測結果是結算列 recycled、
     卡片列還是 stashed、零分錄：賣家的保留額被無償釋放，買家的買回承諾
     永久消失，而且第二次按會撞 WRONG_STATE，死路。
     throw 讓整筆回滾，狀態回到按下按鈕之前，賣家有錢之後可以再試。 */
  if (w.available < points) {
    throw new Rollback(409, {
      error: 'SELLER_UNFUNDED',
      message: '賣家目前的保留額不足以支付這筆回收，請稍後再試或改為申請出貨'
    })
  }

  await credit(tx, s.sellerId, -points, 'pool-recycle-out', s.id)
  /* 付給**卡現在的主人**，不是抽中的人（F-1）。
     呼叫端已經確認過發起回收的就是 prizes.user_id（`and user_id = me`），
     所以 ownerId 就是按下按鈕的那個人。 */
  await credit(tx, s.ownerId, points, 'pool-recycle-in', s.id)
  await tx`update prizes set status = 'recycled' where id = ${s.prizeId}`
  /* 回收是**買家單方面按下去**的，賣家不在場，而他這一刻同時發生兩件事：
     帳戶被扣了買回價，以及那張卡不用寄了（他可能已經包好貼上標籤）。
     第二件比第一件更需要當下就知道 —— 寄出去之後那張卡就要不回來了。
     refId 綁結算 id：一筆結算只回收得了一次（上面的 returning 守衛）。 */
  await notify({
    userId: s.sellerId, kind: 'system',
    title: '買家接受了你的買回價',
    body: `${points} 點已付給買家，這張卡回到你手上 —— 不用再寄了。`,
    link: '/seller/shipping', refId: 'pool-recycle-seller:' + s.id
  }, tx)
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
 *
 * 「跟這個人有關」的買方那一側是 **prizes.user_id**，不是 settlement.buyer_id
 * （F-6）：卡轉手之後 buyer_id 還是前一個主人，新主人讀自己的卡冊會**永遠
 * 掃不到**那一筆，狀態只在前一個主人或賣家碰巧上線時才補算。
 */
/**
 * 全站的鎖序（V-1）：**先鎖 prizes 那一列，再鎖結算列。**
 *
 * 為什麼要有這條紀律：回收、申請出貨、確認收貨天生都是「從一張卡出發」，
 * 先鎖卡再找結算；而這支掃描原本反過來 —— 先鎖一批結算列、才去動 prizes。
 * 兩個方向同時發生就是教科書的死鎖（Postgres 會挑一邊 abort，資料不會壞，
 * 但被 abort 的那個請求變 500）。所以掃描改成兩段式：
 *
 *   第一段**不鎖**，只把「看起來到期了」的候選撈出來；
 *   第二段照全站鎖序**整批**上鎖（prizes → sellers，各自 order by id），
 *   第三段才逐筆重讀重判 —— 候選名單是舊的，這一筆可能已經被別人處理掉了，
 *   重判讓輸的那邊乾淨退出（refund/markShipDefault 本來就有 returning 守衛，
 *   這裡是第二層）。
 *
 * 順帶的好處：原本第一段就把使用者名下**所有**保留中的結算全部上鎖，
 * 每一次讀卡冊都要跟別人搶那批鎖；現在只有真的到期的那幾筆才上鎖。
 *
 * ⚠️ **鎖序對了還不夠，還要「不再中途拿新鎖」。** 2026-09-03 實測
 * （regress-deadlock.ts 第 3 組）在鎖序已經統一的程式碼上仍然壓出 40P01：
 * 這支原本是在迴圈裡逐筆鎖 prizes，而 refund()／markShipDefault() 會
 * `update sellers`，一個賣家只有一列、會被握到 COMMIT —— 兩支掃描於是
 * 一個握著 sellers 要 prizes、一個握著 prizes 要 sellers。詳見迴圈前的說明。
 * 所以現在是「先整批鎖完，再開始做事」，不是「邊走邊鎖」。
 *
 * 曾經的殘餘，現在補掉了：後台出貨那條路原本先鎖 shipments 再動 prizes，
 * 跟賣家自助出貨（prizes → … → shipments）方向相反。原本的判斷是
 * 「平台自己按的、頻率極低，等它真的咬人再說」—— 它咬了。
 * 併發壓測（regress-race.ts 第 7b 組）200 輪撞到 3 輪 40P01，
 * 後台那一支變成沒有內容的 500。routes/admin.ts 已改成兩階段、
 * 照 id 排序先鎖 prizes，全站鎖序現在一致是 prizes → settlements → shipments。
 */
export async function sweepSettlements(tx: Tx, userId?: string): Promise<number> {
  /* 第一段：無鎖撈候選。條件跟原本兩個查詢一致 —— 保留中的（等時限），
     加上 released 但還欠實體卡的（F-5，條件同 022 的部分索引）。 */
  const candidates = userId
    ? await tx`
        select st.id, st.prize_id, st.seller_id, st.status, st.created_at, st.ship_due_at,
               st.shipped_at, st.ship_default_at
          from pool_settlements st join prizes pz on pz.id = st.prize_id
         where (st.status = any(${RESERVED_STATUSES as unknown as string[]})
                or (st.status = 'released' and st.ship_due_at is not null
                    and st.shipped_at is null and st.ship_default_at is null))
           and (st.seller_id = ${userId} or pz.user_id = ${userId})`
    : await tx`
        select st.id, st.prize_id, st.seller_id, st.status, st.created_at, st.ship_due_at,
               st.shipped_at, st.ship_default_at
          from pool_settlements st
         where st.status = any(${RESERVED_STATUSES as unknown as string[]})
            or (st.status = 'released' and st.ship_due_at is not null
                and st.shipped_at is null and st.ship_default_at is null)`

  const now = Date.now()

  /* 第二段：從候選裡篩出**真的到期**的那幾筆。絕大多數保留中的結算離時限
     還遠，替它們上鎖是純浪費 —— 這一步用的是無鎖快照，篩完才碰鎖。 */
  const due = candidates.filter(cand => {
    const peek: Settlement = {
      id: cand.id as string, status: cand.status as SettlementStatus,
      createdAt: Number(cand.created_at),
      shipDueAt: cand.ship_due_at == null ? null : Number(cand.ship_due_at),
      shippedAt: cand.shipped_at == null ? null : Number(cand.shipped_at)
    }
    return applySettlementDeadline(peek, now) != null ||
      (cand.ship_default_at == null && physicalShipOverdue(peek, now))
  })
  if (!due.length) return 0

  /*
   * 第三段：**在動任何一列之前，先把這一輪要碰的列全部鎖起來，照固定順序。**
   *
   * ── 為什麼不能邊走邊鎖（實測，2026-09-03）──────────────────────────
   * 這支原本是在迴圈裡逐筆 `select id from prizes ... for update`。方向是對的
   * （prizes → 結算列，跟回收、確認收貨、賣家出貨同向，V-1 的環確實關掉了），
   * 但它漏掉了第三張表：`refund()` 與 `markShipDefault()` 都會
   * `update sellers set default_count = ...`，而**一個賣家只有一列** ——
   * 那一列會被這筆交易一路握到 COMMIT，同時迴圈還在往下拿新的 prizes 列。
   * 於是兩支同時跑的掃描就長成：
   *
   *   掃描 A：握著 sellers(u-shop)，正要鎖 prizes(p2)
   *   掃描 B：握著 prizes(p2)，正要鎖 sellers(u-shop)
   *
   * regress-deadlock.ts 第 3 組實際壓出來的就是這一個（Postgres 的 log：
   * `update sellers ...` 對上 `select id from prizes ... for update`）。
   * 這不需要有人在按回收 —— **兩支掃描自己就湊得出環**，而掃描掛在每一條
   * 讀清單的路徑上（讀卡冊、讀賣家結算頁）外加五分鐘一次的全域排程。
   *
   * ── 修法 ────────────────────────────────────────────────────────────
   * 把上鎖跟做事分成兩個階段。上鎖階段結束之後**不再要求任何新的列鎖**，
   * 所以「握著共用列還在拿新列」這個形狀就不存在了；而兩個階段內部都照
   * id 排序，兩支交易對同一批列的請求順序一致，排隊而不是互等。
   * 順序固定成 prizes → sellers，跟全站的 prizes → settlements → shipments
   * 疊在一起就是一條總序。
   *
   * （`order by id` 不是裝飾：`= any(...)` 本身不保證上鎖順序。
   *  同樣的寫法見 routes/admin.ts 的後台出貨。）
   */
  const prizeIds = [...new Set(due.map(c => c.prize_id as string))].sort()
  await tx`select id from prizes where id = any(${prizeIds}) order by id for update`
  const sellerIds = [...new Set(due.map(c => c.seller_id as string))].sort()
  await tx`select id from sellers where id = any(${sellerIds}) order by id for update`

  let changed = 0
  for (const cand of due) {
    /* 第四段：逐筆重讀重判。候選名單是無鎖撈的，這一筆可能已經被別人處理掉了；
       拿到鎖之後重判讓輸的那邊乾淨退出（refund/markShipDefault 本來就有
       returning 守衛，這裡是第二層）。
       這裡**不再鎖 prizes** —— 上面已經整批鎖過了，迴圈中途再要新鎖就是
       上面那個環。 */
    const [fresh] = await tx`
      select st.*, pz.user_id as owner_id
        from pool_settlements st join prizes pz on pz.id = st.prize_id
       where st.id = ${cand.id as string} for update of st`
    if (!fresh) continue
    const s = toSettlement(fresh as Row)

    if (s.status === 'released') {
      if ((fresh as Row).ship_default_at == null && physicalShipOverdue(asDeadlineInput(s), now)) {
        if (await markShipDefault(tx, s, now)) changed++
      }
      continue
    }
    const next = applySettlementDeadline(asDeadlineInput(s), now)
    if (!next) continue
    if (next.status === 'refunded') {
      if (await refund(tx, s, now)) changed++
    } else if (next.status === 'released') {
      /* release() 現在會回報有沒有真的改到（它多了 returning 守衛）——
         沒改到就不該計數，不然掃描回報的「處理了幾筆」會把別人先處理掉的
         那些也算進來。 */
      if (await release(tx, s, next.closedBy as 'inspect-timeout' | 'vault-accept', now)) changed++
    }
  }
  return changed
}

/** 排程用的包裝。自己開交易，呼叫端不用管交易邊界 */
export const sweepSettlementsAll = () => root.begin(tx => sweepSettlements(tx))
