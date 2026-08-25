/* ⚠️ 這個檔案是複製本，不要手動編輯。
   真正的來源是 src/shared/（repo 根目錄），改那邊之後跑
   `npm run sync-shared`（在 server/ 底下）重新產生這份複製。
   為什麼需要複製一份見 scripts/sync-shared.mjs 開頭的說明。 */
/**
 * 抽卡池的結算規則。前後端共用。
 *
 * 為什麼需要這個檔案：在它出現之前，玩家抽卡付掉的點數只有借方沒有貸方
 * （`credit(tx, userId, -cost, 'draw', drawId)` 之後就沒有下文了）——
 * 賣家一毛都收不到，而全站的點數總量每抽一次就少一次。
 * 私人開池因此是一個「收不到錢」的功能。
 *
 * 這裡只放**規則與參數**，不碰資料庫、不碰 Vue。理由跟 escrow.ts 一樣：
 * 時限與金額算錯的後果是錢卡在錯的人手上，而那種錯誤在 UI 上看不出來，
 * 只能對純函式下輸入來驗。前端的試算與後端的結算必須是同一份，
 * 否則會出現「畫面說 7 天後入帳、後端第 14 天才放」這種漂移。
 *
 * 一張卡一列（一個籤位一列），不是一個池一列 —— 賣家的現金流不該綁在
 * 「這個池會不會抽完」上面。逐筆結算是刻意的設計，不是實作方便。
 */

/* ---------------- 參數 ---------------- */

/**
 * 平台抽成。先填 0 ——「不抽成」是現在的商業決定，不是「還沒做抽成」。
 * 做成參數是為了改的時候只改這裡；但**每個池在建立當下會把當時的費率
 * 寫進 pools.platform_fee_rate**，之後調這個常數不會回頭改已開的池。
 * 已經賣出去的票，事後改抽成等於片面改約。
 */
export const PLATFORM_FEE_RATE = 0

/** 買家申請出貨後，賣家必須在這段時間內出貨。沿用託管訂單的 72 小時 */
export const POOL_SHIP_DEADLINE_MS = 72 * 3_600_000

/**
 * 鑑賞期。出貨後買家沒有確認收貨也沒有申訴，期滿自動釋放給賣家。
 * 使用者拍板的數字就是 7 天。
 */
export const POOL_INSPECT_MS = 7 * 86_400_000

/**
 * 抽到之後買家一直沒有申請出貨、也沒有接受回收，多久之後視為「接受寄存保管」。
 *
 * 為什麼需要這條：釋放的條件是「出貨 → 收貨或鑑賞期滿」，而**出貨是買家發動的**。
 * 買家如果永遠不按，那筆錢就永遠扣在賣家的保留額裡 —— 那正是逐筆釋放要避免的
 * 「現金流被別人的行為綁住」，只是把綁住的人從整池換成單一買家。
 * 所以保留額有一個時間上界：卡還在保管庫代表買家目前不要求實體交付，
 * 那一筆先釋放。之後買家仍然可以申請出貨，賣家的出貨義務不會消失
 * （不出貨照樣記違約），只是那筆錢不再扣著。
 */
export const POOL_VAULT_ACCEPT_MS = 14 * 86_400_000

/**
 * 池的販售期限預設值與上限。
 * 到期只**停止販售**：已售出但還沒出貨的卡，出貨與鑑賞期照跑完才結算。
 */
export const POOL_DEFAULT_DAYS = 14
export const POOL_MAX_DAYS = 90

/**
 * 賣家宣告的買回價上下限。**每個獎品一個金額，不是整池一個比率。**
 *
 * 舊制是「賣家自填的 refPrice × 5–7 成」。那個算式的地基是 refPrice，
 * 而 refPrice 沒有任何外部依據（docs/HANDOFF.md 4.1）—— 賣家填高，
 * 回收價、還元率、市場折扣就一起說謊。
 *
 * 改成直接宣告買回金額之後，這個數字是**他有義務履行的**：玩家一按接受，
 * 錢就從他自己那個池的保留額出去。設太高自己賠、設太低沒人抽，
 * 不需要任何外部價格資料就會自我修正。
 *
 * 下限 10 點：低於這個數字，走一次回收流程的成本比卡本身高，
 * 而且「買回價 0」實質上是掛著買回的招牌卻什麼都不買 —— 不提供買回的池
 * 應該是不存在的池，不是買回價 0 的池。
 *
 * 上限一千萬點：這是一個**荒謬值防線**，不是經濟門檻。真正的經濟門檻是
 * 整池的 Σ(買回價) 必須低於票收（見 shared/economics.ts 的 floorAllowed）——
 * 單張大獎的買回價本來就可以遠高於單張票價，所以單張不該有相對上限。
 * 這裡擋的是手滑多打幾個零：那種值進得了 JSON、會出現在卡冊總值與排行榜上，
 * 也讓 numeric 運算有機會溢位成 500。
 */
export const BUYBACK_MIN = 10
export const BUYBACK_MAX = 10_000_000

export function buybackValid(v: number): boolean {
  return Number.isInteger(v) && v >= BUYBACK_MIN && v <= BUYBACK_MAX
}

/**
 * 賣家違約（逾期未出貨）幾次之後不能再開池。
 *
 * 沒有保證金，所以這是唯一擋得住連續違約的手段。3 次是先設一個合理值，
 * 要調整就改這裡；門檻做成參數是因為真實的違約分佈要上線之後才知道。
 */
export const SELLER_DEFAULT_LIMIT = 3

/**
 * 新賣家第一個池的額度上限。
 *
 * 用途不是風控收益，是**把第一次違約的最大損失壓住**：沒有保證金的情況下，
 * 一個新賣家開一個票收百萬的池然後不出貨，平台要從保留額退還買家 ——
 * 退得回來（錢還在保留額裡），但期間有大量買家的點數被凍在一個死池上。
 * 上限讓這個窗口有界。兩條同時檢查，任一條超過就擋。
 */
export const FIRST_POOL_TICKET_CAP = 100
export const FIRST_POOL_VALUE_CAP = 100_000

/* ---------------- 金額 ---------------- */

/**
 * 一張票怎麼拆。
 * 抽成無條件捨去，餘數歸賣家 —— 平台寧可少收一點零頭，也不要出現
 * 「三方加起來不等於票價」的分錄。借貸相加必須剛好是 0。
 */
export function splitTicket(ticketPrice: number, feeRate: number) {
  const fee = Math.floor(ticketPrice * feeRate)
  return { fee, sellerAmount: ticketPrice - fee }
}


/* ---------------- 狀態機 ---------------- */

/**
 * 一筆結算的狀態。
 *
 *   held          抽到了。錢已經記在賣家名下，但是保留額 —— 看得到、動不了
 *   awaiting_ship 買家申請出貨，賣家的出貨時鐘在跑（仍是保留額）
 *   shipped       賣家出貨了，鑑賞期在跑（仍是保留額）
 *   released      已釋放成可動用
 *   refunded      賣家逾期未出貨，從保留額退還買家
 *   recycled      買家接受了賣家的回收報價，這筆交易取消一半
 *
 * 前三個是「保留額」的定義。保留額不是一個可以直接改的欄位，
 * 它就是這幾個狀態的 amount 加總 —— 跟餘額一樣是推導出來的
 * （為什麼不存欄位見 server/src/money.ts 開頭）。
 */
export type SettlementStatus =
  | 'held' | 'awaiting_ship' | 'shipped' | 'released' | 'refunded' | 'recycled'

/** 這幾個狀態的金額計入賣家的保留額 */
export const RESERVED_STATUSES: SettlementStatus[] = ['held', 'awaiting_ship', 'shipped']

export type SettlementClosedBy =
  | 'buyer-confirm' | 'inspect-timeout' | 'vault-accept' | 'ship-timeout' | 'recycle'

export interface Settlement {
  id: string
  status: SettlementStatus
  createdAt: number
  /** awaiting_ship 的出貨期限 */
  shipDueAt?: number | null
  shippedAt?: number | null
}

export interface SettlementDeadline {
  at: number
  label: string
  then: string
}

/** 這筆結算現在在等哪一個時限。已結束的回 null。 */
export function settlementDeadline(s: Settlement): SettlementDeadline | null {
  switch (s.status) {
    case 'held':
      return {
        at: s.createdAt + POOL_VAULT_ACCEPT_MS,
        label: '寄存確認期',
        then: '期滿視為接受寄存保管，票金釋放給賣家'
      }
    case 'awaiting_ship':
      return {
        at: s.shipDueAt ?? s.createdAt + POOL_SHIP_DEADLINE_MS,
        label: '賣家出貨期限',
        then: '逾期從保留額退還買家，並記賣家一次違約'
      }
    case 'shipped':
      return {
        at: (s.shippedAt ?? s.createdAt) + POOL_INSPECT_MS,
        label: '鑑賞期',
        then: '期滿票金釋放給賣家'
      }
    default:
      return null
  }
}

/**
 * 套用時限。回傳 null 表示沒有變化 —— 呼叫端用「有沒有回東西」決定要不要寫回，
 * 就地改物件的話比較不出來（escrow.applyDeadlines 踩過這個坑）。
 *
 * 只算狀態轉換，不算分錄 —— 分錄由伺服器端決定，因為只有它知道 amount 與對象。
 */
export function applySettlementDeadline(
  s: Settlement, now: number
): { status: SettlementStatus; closedBy: SettlementClosedBy } | null {
  const d = settlementDeadline(s)
  if (!d || now < d.at) return null
  switch (s.status) {
    case 'held':          return { status: 'released', closedBy: 'vault-accept' }
    case 'awaiting_ship': return { status: 'refunded', closedBy: 'ship-timeout' }
    case 'shipped':       return { status: 'released', closedBy: 'inspect-timeout' }
    default:              return null
  }
}

export const SETTLEMENT_TEXT: Record<SettlementStatus, string> = {
  held: '保留中・等出貨申請',
  awaiting_ship: '保留中・等賣家出貨',
  shipped: '保留中・鑑賞期',
  released: '已入帳',
  refunded: '已退還買家',
  recycled: '已回收'
}
