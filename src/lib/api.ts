// ------------------------------------------------------------------
// API layer。
//
// MOCK 由 VITE_API_URL 決定（見 lib/config.ts）：沒設就全走 mock，有設就打後端。
// 後端的回應形狀在這裡轉成前端既有的型別，頁面元件不用改。
// ------------------------------------------------------------------
import type {
  Pool, DrawResult, UserPrize, LedgerEntry, WinnerEvent,
  Seller, Listing, CardItem, PoolStatus, Tier, Grader, Order
} from '@/types/models'
import { deliveryOf } from '@/shared/domain'
import * as mock from '@/mocks/data'
/* 客服端工單的假資料。它有自己的狀態機（認領／回覆／結案會真的改資料），
   而且是客服視角（不同開單人、認領人、certHolder），跟使用者視角的
   mocks/tickets.ts 是兩份不同的東西，見那兩支檔頭的說明 */
import * as mockTickets from '@/mocks/tickets-admin'
import { MOCK } from './config'
import { ApiError, http, idem } from './http'
import { useWalletStore } from '@/stores/wallet'
import { useAuthStore } from '@/stores/auth'
/* 訂單那一半。ShipTo 與「怎麼把出貨動作送出去」都已經有一份了 ——
   出貨與結算頁要按得到市場那邊的「我已寄出」，走的是同一個 store 動作，
   不另外發明第二條路（第二條路遲早會跟第一條長得不一樣）。 */
import { useOrdersStore, type ShipTo } from '@/stores/orders'
import { refDiscount, refPriceNum } from './refprice'
import { cardMergeKey } from './card-merge'
import type { SettlementStatus } from '@/shared/pool-settlement'
import { RESERVED_STATUSES } from '@/shared/pool-settlement'
import type { Carrier } from '@/shared/escrow'

export { MOCK }

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

/* ---------- 後端 → 前端 的形狀轉換 ---------- */
type Any = Record<string, unknown>
const ts = (v: unknown) => (v == null ? '' : new Date(Number(v) || String(v)).toISOString().slice(0, 16).replace('T', ' '))

function toPool(p: Any): Pool {
  return {
    id: String(p.id), sellerId: String(p.sellerId),
    origin: (p.origin as Pool['origin']) ?? 'personal',
    title: String(p.title), cover: (p.cover as string) ?? '',
    mode: p.mode as Pool['mode'],
    shiteiTier: p.shiteiTier as Tier | undefined,
    ticketPrice: Number(p.ticketPrice), totalTickets: Number(p.totalTickets),
    remainingTickets: Number(p.remainingTickets),
    floorRatio: p.floorRatio === null || p.floorRatio === undefined ? null : Number(p.floorRatio),
    returnRatio: p.returnRatio === null || p.returnRatio === undefined ? null : Number(p.returnRatio),
    commitVersion: p.commitVersion == null ? null : Number(p.commitVersion),
    takenSeats: (p.takenSeats as number[]) ?? [],
    status: p.status as PoolStatus,
    commitHash: String(p.commitHash ?? ''), clientSeedSource: String(p.clientSeedSource ?? ''),
    prizes: ((p.prizes as Any[]) ?? []).map(x => ({
      id: String(x.id), tier: x.tier as Tier, card: x.card as CardItem,
      total: Number(x.total), remaining: Number(x.remaining),
      /* 賣家宣告的買回價。要在抽卡前就看得到 —— 抽完才知道能買回多少就是釣魚 */
      buyback: x.buyback == null ? null : Number(x.buyback)
    })),
    openedAt: ts(p.openedAt),
    escrow: { held: 0, releaseAfterShipDays: 7, released: 0 }
  }
}

function toPrize(r: Any): UserPrize {
  return {
    /* tier 可以是 null：使用者自己登記進卡冊的卡沒有進過池，沒有賞別。
       這裡不做任何退回值 —— 退回 'D' 會把「沒有賞別」講成「最低賞」。 */
    id: String(r.id), card: r.card as CardItem, tier: (r.tier ?? null) as Tier | null,
    status: r.status as UserPrize['status'],
    wonAt: ts(r.won_at),
    /* 舊資料（或還沒跑 014 的後端）沒有 acquired_at，退回 won_at ——
       第一手持有者的兩個時間本來就相同，退回去不會讓畫面說錯話 */
    acquiredAt: ts(r.acquired_at ?? r.won_at), stashExpiresAt: ts(r.stash_expires_at),
    /* 宣告買回價與結算狀態由 /v1/prizes 一起帶回來。舊制的卡兩個都是 null，
       前端要能分辨「這個池沒有宣告買回價」跟「買回價 0 點」—— 後者是假的數字。
       買回價跟 card.refPrice 沒有任何算式關係，前端算不出來也不該猜。 */
    buyback: r.buyback == null ? null : Number(r.buyback),
    settleStatus: (r.settle_status as string | null) ?? null,
    /* 分組鍵與同款張數由後端算（server/src/routes/prizes.ts 的 GROUP_KEY）。
       前端**不自己再算一次**：張數要跨整本卡冊才對，而前端手上只有已載入的那批。
       舊後端沒有這兩欄，所以是選填 —— 那時畫面退回逐張顯示，不會壞。 */
    groupKey: r.group_key == null ? undefined : String(r.group_key),
    groupTotal: r.group_total == null ? undefined : Number(r.group_total),
    groupSellable: r.group_sellable == null ? undefined : Number(r.group_sellable)
  }
}

/* ---------- 賣家結算 ---------- */

/** 賣家錢包。reserved 是「已貸記但還動不了」的那一塊，locked 已經含它 */
export interface SellerWallet {
  points: number
  locked: number
  reserved: number
  available: number
}

/** 一筆結算 = 一個籤位 = 一張卡。逐筆釋放，不等整池抽完 */
export interface SellerSettlement {
  id: string
  poolId: string
  poolTitle: string
  buyerName: string
  buyerMemberNo: string | null
  card: CardItem
  amount: number
  status: SettlementStatus
  createdAt: number
  shipDueAt: number | null
  shippedAt: number | null
  closedAt: number | null
  closedBy: string | null
  selfDraw: boolean
  /**
   * 「票金已入帳，但這張卡你還沒寄」（F-5）。後端一直有算這個旗標，
   * 前端卻沒有收 —— 於是那幾列只顯示「已入帳」躺在已結束分頁裡，
   * 而它們其實還掛著一個逾期會記違約的出貨期限。
   */
  owesCard: boolean
  /**
   * 收件資訊。**權限判斷已經在伺服器的 SQL 裡做完了**（見
   * server/src/routes/sellers.ts 那支 lateral join）：只有這筆結算的賣家、
   * 而且出貨義務還活著時才會有值。前端只判斷「有沒有值」與「哪幾欄是空的」——
   * 同一條規則有兩個來源遲早會分岔，而分岔的其中一個方向是把住址給錯的人。
   */
  shipTo: ShipTo | null
}

export interface SellerSettlements {
  settlements: SellerSettlement[]
  /**
   * 市場成交・需寄送的託管訂單（賣家視角）。
   *
   * 為什麼跟結算放同一支回應：賣家欠實體卡的來源有兩個，而只顯示其中一個
   * 的那一頁叫「出貨與結算」。兩邊的時限都要用同一個 serverTime 當基準，
   * 分兩支 API 拿會拿到兩個時鐘。
   */
  orders: Order[]
  wallet: SellerWallet
  serverTime: number
}

/** bigint 過了 JSON 可能是 number 也可能是字串，兩種都要吃；null 保持 null */
const ms = (v: unknown): number | null => (v == null ? null : Number(v))

function toSettlement(r: Any): SellerSettlement {
  return {
    id: String(r.id),
    poolId: String(r.pool_id),
    /* 池標題可能是空字串（舊資料），退回 id 而不是留白 ——
       「哪一個池」是賣家找卡的第一個線索，空白等於問號 */
    poolTitle: String(r.pool_title || r.pool_id),
    buyerName: String(r.buyer_name ?? ''),
    buyerMemberNo: (r.buyer_member_no as string | null) ?? null,
    card: r.card as CardItem,
    amount: Number(r.amount),
    status: r.status as SettlementStatus,
    createdAt: Number(r.created_at),
    shipDueAt: ms(r.ship_due_at),
    shippedAt: ms(r.shipped_at),
    closedAt: ms(r.closed_at),
    closedBy: (r.closed_by as string | null) ?? null,
    selfDraw: Boolean(r.self_draw),
    owesCard: Boolean(r.owes_card),
    /* 沒有值就是 null，不要造一個五個欄位都 undefined 的空物件 ——
       呼叫端會用「有沒有 shipTo」判斷要不要顯示寄件區塊。 */
    shipTo: (r.ship_to as ShipTo | null) ?? null
  }
}

const REASON_TYPE: Record<string, LedgerEntry['type']> = {
  'admin-grant': 'topup', topup: 'topup', draw: 'draw',
  refund: 'refund', recycle: 'recycle', 'vault-buy': 'redeem', 'vault-sell': 'redeem',
  'order-pay': 'redeem', 'order-receive': 'redeem',
  /* 交易邀約成交。沒有這兩行的話會落到預設的 'redeem'，而 note 會退回
     後端的原始字串 —— 錢包頁上就是一行「trade-sell」，看得懂的只有寫程式的人。 */
  'trade-buy': 'trade', 'trade-sell': 'trade'
}
const REASON_NOTE: Record<string, string> = {
  'admin-grant': '平台發放', draw: '抽選', recycle: '回收', 'vault-buy': '市場購入',
  'vault-sell': '市場售出', 'order-pay': '託管訂單付款', 'order-receive': '託管訂單收款',
  /* 類型徽章已經寫著「交易」了，note 不用再說一次「交易」 */
  'trade-buy': '出價買入', 'trade-sell': '出價售出',
  'deposit-forfeit': '保證金沒收', seed: '測試點數'
}
function toLedger(rows: Any[], endBalance: number): LedgerEntry[] {
  // 後端不存 balanceAfter（餘額是算的），從最新往回推
  let bal = endBalance
  return rows.map(r => {
    const delta = Number(r.delta)
    const entry: LedgerEntry = {
      id: String(r.id), delta, balanceAfter: bal,
      type: REASON_TYPE[String(r.reason)] ?? 'redeem',
      note: REASON_NOTE[String(r.reason)] ?? String(r.reason),
      createdAt: ts(r.created_at)
    }
    bal -= delta
    return entry
  })
}

/* ---------- 分頁 ---------- */
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface PageOpts { cursor?: string | null; limit?: number; signal?: AbortSignal }
export type MarketSort = 'deal' | 'new' | 'cheap' | 'pricey'
/**
 * 市場的等級篩選。`raw`（未鑑定）與 `graded`（不分家、只要鑑定過）是兩個
 * 明確的類別，不是「有沒有填鑑定公司」的副作用 —— 裸卡是市場上最常見的一類，
 * 而且是兩種相反意圖的目標（撿便宜／排除它）。
 * 值與後端 routes/public.ts 的 GRADER_FILTERS 一一對應。
 */
export type MarketGrader = 'raw' | 'graded' | 'psa' | 'bgs' | 'ars'
/** 市場列表的篩選條件。四個都是「過濾」，跟排序互不相干，可以任意並用 */
export interface MarketFilters {
  q?: string
  grader?: MarketGrader
  /** 分數下限（含）。只有下限沒有上限 —— 沒有人在找比較差的卡 */
  minGrade?: number
  minPrice?: number
  maxPrice?: number
}

export interface PrizeSummary {
  total: number
  counts: Record<UserPrize['status'], number>
  owned: number
  totalValue: number
  /* tier 為 null＝那張卡是自己登記進來的，沒有賞別。
     分佈另立一類（「未分級」）而不是把它們藏掉 —— 藏掉的話
     分佈的張數加總會對不上「持有 N 張」，看起來像統計壞了。 */
  best: { name: string; tier: Tier | null; refPrice: number } | null
  tierMix: { tier: Tier | null; n: number }[]
  /** 成長曲線只需要「時間 + 金額」，所以不帶整包 card */
  curve: { wonAt: number; name: string; refPrice: number }[]
  /** 重複的卡有幾款（同款 2 張以上才算）。舊後端沒有這一欄 */
  dupGroups?: number
  /** 那幾款總共幾張（含每一款的第一張） */
  dupCards?: number
}

/**
 * 卡冊的排序。三個值跟 server/src/routes/prizes.ts 的 SORTS 一一對應。
 *
 *   acquired 取得時間（預設，一條時間軸，**不分組**）
 *   dupes    同款集中（張數多的在前，同款卡保證相鄰）
 *   value    參考價高到低（同款卡也保證相鄰）
 *
 * 後兩個保證「同鍵必然相鄰」，前端才敢把連續同鍵的卡併成一格 ×N。
 */
export type PrizeSort = 'acquired' | 'dupes' | 'value'

/** 只把有值的參數放進 query string —— 帶 cursor=null 會被後端當成不合法的游標 */
function qs(o: Record<string, unknown>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) {
    if (k === 'signal' || v === undefined || v === null || v === '') continue
    p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

/**
 * 搜尋字串的正規化 —— **只給 MOCK 用**。
 *
 * 真後端的規則寫在 migrations/031 的 search_text 與 routes/public.ts 的 normQ，
 * 那兩處才是唯一的事實；這裡是為了讓沒有後端的 mock 模式表現得一樣。
 * 三件事：NFKC（全形 Ｑ／半形片假名 ﾘｻﾞｰﾄﾞﾝ 都要能打得中）、
 * 小寫（SV4A = sv4a）、去掉所有空白（「噴火龍 ex」＝「噴火龍ex」）。
 */
function normalizeSearch(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
}

/**
 * mock 的游標分頁。游標直接用「上一批最後一筆的 id」，因為 mock 的陣列
 * 順序就是排序本身；真後端不能這樣做（見 server/src/pagination.ts）。
 */
function mockPage<T>(all: T[], idOf: (x: T) => string, opts: PageOpts): Page<T> {
  const limit = opts.limit ?? 24
  const from = opts.cursor ? all.findIndex(x => idOf(x) === opts.cursor) + 1 : 0
  const items = all.slice(from, from + limit)
  const end = from + items.length
  return { items, nextCursor: end < all.length && items.length ? idOf(items[items.length - 1]!) : null }
}

function toListing(l: Any): Listing {
  return {
    id: String(l.id), card: l.card as CardItem, price: Number(l.price),
    sellerId: String(l.sellerId), sellerName: String(l.sellerName),
    listedAt: ts(l.listedAt), status: l.status as Listing['status'],
    delivery: l.delivery as Listing['delivery'], fromPrizeId: (l.prizeId as string) ?? undefined
  }
}

/* 這裡原本有一支 applyWallet()，由下面每一支端點自己記得呼叫。
   它已經搬到 lib/http.ts 的傳輸層 —— 只要後端回應帶 wallet 就會套用，
   不再有「這支忘了呼叫」這種漏（見那支的說明）。 */

export const api = {
  async listPools(): Promise<Pool[]> {
    // 必須回傳副本：若讓 store 與 mock 共用同一份物件，mock 改動後
    // 快照與 store 現值相同，賦值不會觸發 Vue 的反應性更新。
    if (MOCK) { await delay(200); return mock.pools.map(p => mock.poolSnapshot(p.id)) }
    const r = await http<{ pools: Any[] }>('/v1/pools')
    return r.pools.map(toPool)
  },

  async getPool(id: string): Promise<Pool | undefined> {
    if (MOCK) { await delay(150); return mock.poolSnapshot(id) }
    const r = await http<{ pool: Any }>(`/v1/pools/${id}`)
    return toPool(r.pool)
  },

  /** 抽選後重新取得池狀態（籤數、各賞剩餘） */
  async poolState(id: string): Promise<Pool> {
    if (MOCK) { await delay(0); return mock.poolSnapshot(id) }
    const r = await http<{ pool: Any }>(`/v1/pools/${id}`)
    return toPool(r.pool)
  },

  async draw(poolId: string, seats: number[]): Promise<DrawResult> {
    if (MOCK) { await delay(600); return mock.mockDraw(poolId, seats) }
    const r = await http<{ drawId: string; items: Any[]; cost: number; wallet: { points: number; locked: number } }>(
      `/v1/pools/${poolId}/draw`, { method: 'POST', json: { seats, idempotencyKey: idem() } })
    return {
      drawId: r.drawId, poolId, cost: r.cost,
      items: r.items.map(it => ({
        ticketSeq: Number(it.seat), tier: it.tier as Tier, card: it.card as CardItem,
        stashId: it.stashId ? String(it.stashId) : undefined
      }))
    }
  },

  // ---- 賣家 ----
  async listSellers(): Promise<Seller[]> {
    if (MOCK) { await delay(120); return mock.listSellers() }
    const r = await http<{ sellers: Seller[] }>('/v1/sellers')
    return r.sellers
  },

  async getSeller(id: string): Promise<Seller | undefined> {
    if (MOCK) { await delay(120); return mock.getSeller(id) }
    const r = await http<{ seller: Seller | null }>(`/v1/sellers/${id}`)
    return r.seller ?? undefined
  },

  async createPool(input: mock.NewPoolInput): Promise<Pool> {
    if (MOCK) {
      await delay(500)
      /* 「這個鑑定編號已經登記在系統裡」在正式環境是資料庫唯一索引擋下來的
         （prizes_cert_alive → 409 CERT_ALREADY_LISTED，見 server/src/routes/pools.ts）。
         mock 也要擋，理由不是求真：那個 409 旁邊掛著整個站唯一的「申請接管」入口，
         而入口只在錯誤發生的當下存在。mock 不擋的話，這條動線在沒有後端時
         永遠沒有人看得到，也就沒有人驗得了它。 */
      const hit = (await import('@/mocks/tickets')).listedCertHit(input.prizes)
      if (hit) {
        throw new ApiError(
          'CERT_ALREADY_LISTED',
          '這個鑑定編號已經登記在系統裡了 —— 同一張實體卡不能同時放進兩個池，也不能一邊在池裡一邊掛在市場上。'
          + '如果這張卡是你的而且已經不在別處，請聯絡客服。',
          409, hit
        )
      }
      return mock.createPool(input)
    }
    /* 開池表單送出來的每一項都已經帶著**挑出來的完整卡片身分**
       （卡號、系列、卡圖、變體、鑑定編號），所以這裡不再現編任何欄位。
       原本這裡會拿卡名湊一個 `setCode: ''`、`cardNo: ''` 的空殼送上去 ——
       那正是「賣家開的池永遠對不到外部價格」的來源。 */
    const total = input.prizes.reduce((a, p) => a + p.qty, 0)
    const r = await http<{ poolId: string }>('/v1/pools', { method: 'POST', json: {
      mode: input.mode, title: input.title, ticketPrice: input.ticketPrice, totalTickets: total,
      shiteiTier: input.shiteiTier,
      prizes: input.prizes.map((p, i) => ({
        tier: p.tier, total: p.qty,
        /* buyback 跟 card 分開送：card.refPrice 是賣家標示的參考價（選填、只顯示），
           buyback 是他宣告要履行的絕對金額。兩者沒有算式關係，不能混在一起。

           這裡送的一律是**解析後的絕對金額**：表單上是「賞別預設 + 個別覆寫」，
           但那只是填表的方式。後端仍然收得下 tierBuyback，
           前端先解析完再送是為了讓畫面上的試算跟送出去的東西逐字相同。 */
        buyback: p.buyback,
        /* 逐欄明列不用展開整個物件：card 會被雜湊進 manifest（v4），
           而 manifest 的欄位集合就是「承諾涵蓋什麼」。順手多送一個欄位
           等於默默擴張承諾的範圍，之後沒有人知道那一欄是什麼時候進去的。
           id 沒有就用 artId 補：後端要一個非空字串，而 artId 是這張卡在
           目錄裡的唯一鍵，比現編一個時間戳誠實。 */
        card: {
          id: p.card.id || p.card.artId || `c-${i}`,
          name: p.card.name,
          setCode: p.card.setCode,
          cardNo: p.card.cardNo,
          language: p.card.language,
          grader: p.card.grader,
          grade: p.card.grade,
          certNo: p.card.certNo,
          image: p.card.image,
          artId: p.card.artId,
          // 變體：manifest v4 的最後一欄，同卡號不同版本靠它分辨
          variantId: p.card.variantId ?? null,
          refPrice: p.card.refPrice
        }
      }))
    } })
    const g = await http<{ pool: Any }>(`/v1/pools/${r.poolId}`)
    return toPool(g.pool)
  },

  /**
   * 我的卡冊，一次一批。
   *
   * status、sort、group 三個**全部由後端做**，不是撈回來再自己處理 ——
   * 分批載入之後前端只碰得到已經載進來的那幾張：
   *   status：「寄存中 0 張」但第 3 頁其實有，是這個改動最容易踩的坑
   *   sort：  只排得到已載入的那批，捲一頁就整個重排，看過的卡在眼前跳位
   *   group： 更糟 —— 會告訴使用者「這款你有 3 張」而他其實有 10 張
   *
   * group 是「只回這一組的卡」。給「這一組全選」用：使用者看到 ×10 按下全選，
   * 而畫面上只有 3 張載進來了，其餘 7 個 id 只有後端拿得出來。
   */
  async myPrizes(
    opts: PageOpts & { status?: UserPrize['status']; sort?: PrizeSort; group?: string } = {}
  ): Promise<Page<UserPrize>> {
    /* mock 也要真的分頁，不能整包回。mock 是本機開發與展示唯一的資料來源，
       它不分頁的話捲動載入這條路在開發時永遠走不到，等到接上後端才發現壞掉。 */
    if (MOCK) {
      await delay(150)
      let all = opts.status ? mock.userPrizes.filter(p => p.status === opts.status) : mock.userPrizes
      /* mock 也要照同一套規則分組與排序，否則本機開發時「同款集中」永遠是空的，
         而這個功能最容易錯的地方（跨批的張數）在 mock 下根本走不到。
         鍵用 cardMergeKey —— 它跟後端 GROUP_KEY 產生的是同一個字串。 */
      const total = new Map<string, number>()
      for (const p of all) {
        const k = cardMergeKey(p.card)
        total.set(k, (total.get(k) ?? 0) + 1)
      }
      const refOf = (k: string) =>
        Math.max(...all.filter(p => cardMergeKey(p.card) === k).map(p => refPriceNum(p.card.refPrice) || -1))
      const sellable = new Map<string, number>()
      for (const p of all) {
        const k = cardMergeKey(p.card)
        if (p.status === 'stashed' || p.status === 'in_book') sellable.set(k, (sellable.get(k) ?? 0) + 1)
      }
      all = all.map(p => ({
        ...p, groupKey: cardMergeKey(p.card),
        groupTotal: total.get(cardMergeKey(p.card)),
        groupSellable: sellable.get(cardMergeKey(p.card)) ?? 0
      }))
      if (opts.group) all = all.filter(p => p.groupKey === opts.group)
      if (opts.sort === 'dupes' || opts.sort === 'value') {
        // 同鍵必須相鄰 —— 分組能成立的唯一前提，跟後端的 order by 對齊
        all = [...all].sort((a, b) =>
          (opts.sort === 'dupes' ? (b.groupTotal ?? 1) - (a.groupTotal ?? 1) : 0) ||
          refOf(b.groupKey!) - refOf(a.groupKey!) ||
          a.groupKey!.localeCompare(b.groupKey!) ||
          a.id.localeCompare(b.id))
      }
      return mockPage(all, p => p.id, opts)
    }
    const r = await http<{ items: Any[]; nextCursor: string | null }>(
      `/v1/prizes${qs({ ...opts, status: opts.status, sort: opts.sort, group: opts.group })}`,
      { signal: opts.signal })
    return { items: r.items.map(toPrize), nextCursor: r.nextCursor }
  },

  /** 卡冊總覽的數字。講的是整本卡冊，所以不能從已載入的那幾張算 */
  async prizeSummary(): Promise<PrizeSummary> {
    if (MOCK) {
      await delay(120)
      const counts = {} as PrizeSummary['counts']
      /* 全部的狀態都要數，不能只列常見的那幾種：漏掉的狀態在分頁列上
         永遠是 0，那個分頁就永遠不會出現 —— 自己登記進來的卡（in_book）
         之前就是這樣消失的。 */
      for (const s of ['stashed', 'listed', 'ship_requested', 'shipped', 'recycled', 'refunded', 'in_book', 'in_pool'] as const) {
        counts[s] = mock.userPrizes.filter(p => p.status === s).length
      }
      const owned = mock.userPrizes.filter(p => p.status !== 'recycled')
      // 鍵可以是 null（未分級），跟 PrizeSummary.tierMix 的型別一致
      const mix = new Map<Tier | null, number>()
      for (const p of owned) mix.set(p.tier, (mix.get(p.tier) ?? 0) + 1)
      const best = owned.reduce<UserPrize | null>(
        (b, p) => (!b || refPriceNum(p.card.refPrice) > refPriceNum(b.card.refPrice) ? p : b), null)
      return {
        total: mock.userPrizes.length, counts, owned: owned.length,
        /* 沒有標示參考價的卡在總值裡算 0 —— 這是「這本卡冊被標示出來的總值」，
           不是「它值多少」。那個問題這個平台答不出來，也不該假裝答得出來。 */
        totalValue: owned.reduce((a, p) => a + refPriceNum(p.card.refPrice), 0),
        best: best ? { name: best.card.name, tier: best.tier, refPrice: refPriceNum(best.card.refPrice) } : null,
        tierMix: [...mix].map(([tier, n]) => ({ tier, n })),
        curve: owned.map(p => ({ wonAt: Date.parse(p.wonAt) || Date.now(), name: p.card.name, refPrice: refPriceNum(p.card.refPrice) })),
        /* 重複的卡有幾款、共幾張。跟後端 /summary 同一條規則（同款 2 張以上才算） */
        ...(() => {
          const n = new Map<string, number>()
          for (const p of owned) { const k = cardMergeKey(p.card); n.set(k, (n.get(k) ?? 0) + 1) }
          const dup = [...n.values()].filter(v => v > 1)
          return { dupGroups: dup.length, dupCards: dup.reduce((a, v) => a + v, 0) }
        })()
      }
    }
    return http<PrizeSummary>('/v1/prizes/summary')
  },

  // ---- 市場 ----
  /**
   * 掛單一次一批。排序與**搜尋**都在後端。
   *
   * 搜尋為什麼不能留在前端：列表是游標分頁的，前端過濾只濾得到已載入的那一批。
   * 使用者搜「伊布」看到 2 筆、實際上市場有 15 筆，另外 13 筆在還沒載入的批次裡 ——
   * 排序做錯只是順序怪，搜尋做錯是給出**錯的答案**，而且畫面上看不出來。
   * 完整理由見 server/src/routes/public.ts 與 migrations/031。
   *
   * total 只有在有關鍵字、而且是第一批時後端才會給（見同一支路由的說明）。
   */
  async listMarket(
    opts: PageOpts & { sort?: MarketSort } & MarketFilters = {}
  ): Promise<Page<Listing> & { total?: number }> {
    if (MOCK) {
      await delay(160)
      const live = mock.listings.filter(l => l.status === 'live')
      /* mock 的比對規則要跟真後端同一套（NFKC + 小寫 + 去空白），
         不然本機看起來會的東西接上後端就不會 —— 那種落差最難查。
         這裡只搜卡名、系列、卡號三欄，也跟 031 的 search_text 一致。 */
      const q = normalizeSearch(opts.q ?? '')
      /* 等級的判斷也要跟後端同一套：未鑑定在資料上有三種寫法（'RAW'、空字串、
         整個欄位沒有），三種都是同一件事。只比對 === 'RAW' 會把後兩種漏成
         「不屬於任何類別」—— 那正是「把 RAW 當成 null」的那個錯誤。 */
      const graderOf = (l: Listing) => (l.card.grader || 'RAW').toUpperCase()
      const gradeOf = (l: Listing) => (typeof l.card.grade === 'number' ? l.card.grade : null)
      const hit = (l: Listing) => {
        if (q && !normalizeSearch(`${l.card.name}|${l.card.setCode}|${l.card.cardNo}`).includes(q)) return false
        const g = graderOf(l)
        if (opts.grader === 'raw' && g !== 'RAW') return false
        if (opts.grader === 'graded' && g === 'RAW') return false
        if (opts.grader && !['raw', 'graded'].includes(opts.grader) && g !== opts.grader.toUpperCase()) return false
        if (opts.minGrade !== undefined && (gradeOf(l) ?? -1) < opts.minGrade) return false
        if (opts.minPrice !== undefined && l.price < opts.minPrice) return false
        if (opts.maxPrice !== undefined && l.price > opts.maxPrice) return false
        return true
      }
      const found = live.filter(hit)
      // 沒有標示參考價的排在最後：沒有基準可比，不是「零折價」
      const d = (l: Listing) => refDiscount(l) ?? Number.POSITIVE_INFINITY
      const sorted = [...found].sort(
        opts.sort === 'cheap' ? (a, b) => a.price - b.price
        : opts.sort === 'pricey' ? (a, b) => b.price - a.price
        : opts.sort === 'new' ? () => 0            // mock 已依上架時間排好
        : (a, b) => d(a) - d(b))
      const page = mockPage(sorted, l => l.id, opts)
      /* 有任何條件在作用時才回總筆數，跟後端同一個規則：那個數字講的是
         「整個市場符合的有幾件」，不是「這一批載進來幾件」。 */
      const filtering = !!q || !!opts.grader || opts.minGrade !== undefined
        || opts.minPrice !== undefined || opts.maxPrice !== undefined
      return { ...page, ...(filtering && !opts.cursor ? { total: found.length } : {}) }
    }
    const r = await http<{ items: Any[]; nextCursor: string | null; total?: number }>(
      `/v1/listings${qs({ ...opts, sort: opts.sort, q: opts.q })}`, { signal: opts.signal })
    return { items: r.items.map(toListing), nextCursor: r.nextCursor, total: r.total }
  },

  /** 市場上方那兩條橫向捲軸：講的是「整個市場最便宜／最貴的幾張」，跟分頁無關 */
  async marketHighlights(): Promise<{ deals: Listing[]; graded: Listing[]; total: number }> {
    if (MOCK) {
      await delay(120)
      const live = mock.listings.filter(l => l.status === 'live')
      const d = (l: Listing) => refDiscount(l) ?? Number.POSITIVE_INFINITY
      return {
        deals: [...live].filter(l => d(l) <= -0.08).sort((a, b) => d(a) - d(b)).slice(0, 6),
        graded: [...live].filter(l => l.card.certNo).sort((a, b) => b.price - a.price).slice(0, 4),
        total: live.length
      }
    }
    const r = await http<{ deals: Any[]; graded: Any[]; total: number }>('/v1/listings/highlights')
    return { deals: r.deals.map(toListing), graded: r.graded.map(toListing), total: r.total }
  },
  /**
   * 單筆掛單。市場的卡片詳情頁靠這一支載入。
   *
   * 刻意不做成「撈整個市場再挑一筆」：市場是游標分頁的，要的那筆多半不在第一頁。
   * 而且分享出去的連結與重新整理都拿不到列表頁的狀態，詳情頁必須自己補得齊資料。
   * 找不到回 null（不是丟例外），讓頁面自己畫「不存在或已下架」——
   * 那是預期中的結果，不是錯誤。
   */
  async getListing(id: string): Promise<Listing | null> {
    if (MOCK) {
      await delay(140)
      return mock.listings.find(l => l.id === id) ?? null
    }
    try {
      const r = await http<{ listing: Any }>(`/v1/listings/${id}`)
      return toListing(r.listing)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
  },
  /** 回傳裡的 stashId 是「剛過戶到手的那張卡在卡冊裡的 id」，只有庫內轉移才有。
      買完要導去卡冊，卡冊靠它把剛買到的那張標出來。 */
  async buyListing(id: string): Promise<{ listing: Listing; stashId?: string }> {
    if (MOCK) {
      await delay(300)
      const l = mock.listings.find(x => x.id === id)
      if (!l) throw new Error('listing not found')
      if (l.status === 'sold') throw new Error('already sold')
      l.status = 'sold'
      /* 庫內轉移在後端是「卡真的過戶」（orders.ts 把 prizes.user_id 換成買家、
         status 改回 stashed）。mock 少了這一步的話，買完跳進卡冊會看不到那張卡 ——
         使用者回報的「買了沒進卡冊」在 mock 模式下就會是真的，而 mock 是本機
         開發與展示唯一的資料來源，這條路走不完等於整個流程沒被驗過。
         需寄送的不進卡冊：那是託管訂單，卡還在賣家手上，還不是買家的。 */
      if (deliveryOf(l) === 'vault') {
        const p = refPriceNum(l.card.refPrice)
        const stashId = 'up-' + l.id
        mock.userPrizes.unshift({
          id: stashId,
          card: l.card,
          // 市場買來的卡沒有賞別可言，這裡只是讓 mock 的卡冊有東西可畫
          tier: p >= 20_000 ? 'A' : p >= 5_000 ? 'B' : p >= 1_500 ? 'C' : 'D',
          status: 'stashed',
          /* wonAt 是「這張卡被抽出來」的時間、acquiredAt 是「我什麼時候拿到的」。
             買來的卡兩者不同，而卡冊是照 acquiredAt 排的（見後端 migrations/014）。 */
          wonAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
          acquiredAt: new Date().toISOString(),
          stashExpiresAt: new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10),
          /* 市場買來的卡沒有「那個池的賣家宣告買回價」可言 —— 它已經易主了，
             原本那筆結算跟現在的持有人無關。所以 mock 也給 null，
             讓卡冊照實顯示「沒有買回承諾」。 */
          buyback: null
        })
        return { listing: l, stashId }
      }
      return { listing: l }
    }
    // 真的買：回 { order | null, wallet }。order 為 null 表示庫內轉移，成交即完成
    const r = await http<{ order: Any | null; stashId?: string; wallet: { points: number; locked: number } }>(
      '/v1/orders', { method: 'POST', json: { listingId: id, idempotencyKey: idem() } })
    /* 原本這裡會把整個市場再撈一次只為了找回那一筆。掛單改成分頁之後那個做法
       既錯（要的那筆可能不在第一頁）又浪費，而且呼叫端根本沒用這個回傳值 ——
       成交與否看的是有沒有丟例外。 */
    return { listing: { id, status: 'sold' } as Listing, stashId: r.stashId }
  },
  async createListing(input: { prizeId: string; card: CardItem; price: number; sellerName: string }): Promise<Listing> {
    if (MOCK) {
      await delay(300)
      const l: Listing = {
        id: 'l-' + input.prizeId,
        card: input.card,
        price: input.price,
        /* mock 也要用真的使用者 id：原本寫死 'me'，而 mock 登入拿到的是 'u-XXXX'，
           兩者永遠對不起來 —— 市場上「自己上架的卡」的標示在 mock 模式下就會失效，
           而 mock 是本機開發與展示唯一的資料來源。 */
        sellerId: useAuthStore().user?.id ?? 'me',
        sellerName: input.sellerName,
        listedAt: '剛剛',
        status: 'live',
        fromPrizeId: input.prizeId
      }
      mock.listings.unshift(l)
      /* 真後端的 POST /v1/listings 會把 prizes.status 改成 'listed'（卡鎖在市場上，
         賣掉前不能出貨也不能回收）。mock 不跟著改的話，同一張卡可以重複上架，
         而且卡冊的分頁永遠不會出現「市場販售中」—— 那是假的成功。 */
      const src = mock.userPrizes.find(x => x.id === input.prizeId)
      if (src) src.status = 'listed'
      return l
    }
    const r = await http<{ listing: Any }>('/v1/listings', { method: 'POST', json: { prizeId: input.prizeId, price: input.price } })
    return toListing(r.listing)
  },
  /**
   * 下架自己的掛單。接的是既有的 POST /v1/listings/:id/delist
   * （server/src/routes/public.ts），這裡只是把它接上前端 ——
   * 後端會擋非本人（NOT_PARTY）與非 live 狀態（WRONG_STATE）。
   *
   * mock 直接把那筆從陣列拿掉，而不是改 status：Listing 的 status 型別只有
   * 'live' | 'sold'（見 shared/domain.ts），沒有 'delisted' 可以放，
   * 而後端對已下架的掛單本來就回 404「當成不存在」—— 拿掉正好等價。
   * 同時把卡的狀態放回上架前的樣子，否則它會一直卡在 'listed'，
   * 卡冊裡看起來還在市場販售中，出貨與回收也跟著鎖死（後端那支也做了同一件事）。
   */
  async delistListing(id: string): Promise<void> {
    if (MOCK) {
      await delay(260)
      const i = mock.listings.findIndex(l => l.id === id)
      if (i < 0) throw new Error('找不到這筆掛單')
      const [l] = mock.listings.splice(i, 1)
      if (l?.fromPrizeId) {
        const src = mock.userPrizes.find(x => x.id === l.fromPrizeId)
        if (src) src.status = deliveryOf(l) === 'vault' ? 'stashed' : 'shipped'
      }
      return
    }
    await http<{ ok: true }>(`/v1/listings/${id}/delist`, { method: 'POST' })
  },

  async ledger(): Promise<LedgerEntry[]> {
    if (MOCK) { await delay(150); return mock.ledger }
    const r = await http<{ wallet: { points: number; locked: number }; ledger: Any[] }>('/v1/wallet')
    return toLedger(r.ledger, r.wallet.points)
  },

  async recentWinners(): Promise<WinnerEvent[]> {
    if (MOCK) { await delay(100); return mock.winners }
    const r = await http<{ winners: WinnerEvent[] }>('/v1/winners')
    return r.winners
  },

  /** 回收：mock 直接入點；API 模式由後端結算並回最新錢包 */
  async recyclePrize(prizeId: string, mockPoints: number, mockNote: string): Promise<{ points: number }> {
    if (MOCK) {
      await delay(200)
      useWalletStore().creditRecycle(mockPoints, mockNote)
      return { points: mockPoints }
    }
    const r = await http<{ points: number; wallet: { points: number; locked: number } }>(
      `/v1/prizes/${prizeId}/recycle`, { method: 'POST' })
    return { points: r.points }
  },

  /**
   * 申請把保管中的卡實體寄出。
   *
   * 這支之前不存在 —— 卡冊上的「申請出貨」按鈕只把本地物件的 status 改掉，
   * 完全沒有打後端。在 API 模式下按了畫面會變、重新整理就打回原形，
   * 而後台的出貨清單永遠收不到東西。
   *
   * 一次可以送多張：後端收 prizeIds 陣列，同一批合併成一張出貨單，
   * 使用者只付一次運費、平台只包一次。
   */
  async shipPrizes(prizeIds: string[], address: {
    name: string; phone: string; zip?: string; city: string; line1: string
  }): Promise<{ shipmentId: string }> {
    if (MOCK) {
      await delay(300)
      for (const p of mock.userPrizes) {
        if (prizeIds.includes(p.id)) p.status = 'ship_requested'
      }
      return { shipmentId: 'sh-mock-' + Date.now().toString(36) }
    }
    return http<{ shipmentId: string }>('/v1/prizes/ship', {
      method: 'POST', json: { prizeIds, address }
    })
  },

  /** 我的賣家狀態。null = 還沒申請過 */
  async sellerStatus(): Promise<{
    seller: { id: string; name: string; tier: string; origin: string } | null
    verification: { status: string; note: string | null } | null
  }> {
    if (MOCK) { await delay(120); return { seller: null, verification: null } }
    return http('/v1/seller/me')
  },

  /** 申請成為賣家。通過審核前 tier = pending，開池會被擋 */
  async applySeller(input: { name: string; origin: 'merchant' | 'personal'; bio?: string }) {
    if (MOCK) { await delay(300); return { seller: { id: 'me', tier: 'pending' }, already: false } }
    return http<{ seller: { id: string; tier: string }; already: boolean }>('/v1/seller/apply', {
      method: 'POST', json: input
    })
  },

  /**
   * 賣家的結算清單 + 錢包。
   *
   * 這兩支後端早就有了，前端一行都沒接 —— 結果是賣家看得到保留額
   * （錢包的「凍結」裡有一塊），卻沒有任何地方按得下「已出貨」，
   * 而不出貨那筆錢永遠不會釋放。整條金流缺的就是這一段。
   *
   * 後端回的是資料庫的原始列（snake_case）：那是 `select st.*` 直接吐出來的，
   * 不是後端偷懶，是這張表的欄位就是結算的定義本身。轉成前端型別的工作
   * 一律在這一層做完，頁面不該認得 `ship_due_at` 這種名字。
   *
   * 時間全部是毫秒數（bigint 經過 JSON 會變成 number 或字串，兩種都要吃）。
   * serverTime 一起帶回來是為了讓倒數以**伺服器的時鐘**為基準 ——
   * 使用者的電腦慢十分鐘，畫面就會說「還有時間」而後端已經判逾期。
   */
  async sellerSettlements(): Promise<SellerSettlements> {
    if (MOCK) {
      await delay(180)
      const w = useWalletStore()
      const reserved = mock.sellerSettlements
        .filter(s => RESERVED_STATUSES.includes(s.status))
        .reduce((a, s) => a + s.amount, 0)
      const locked = w.locked + reserved
      /* mock 的市場那一半直接讀訂單 store —— 它就是 mock 模式下訂單的
         唯一真相（demo 用的 seedSellerOrder 也寫在那裡）。在這裡另外造
         一份假訂單的話，同一筆交易在 /orders 與這一頁會長得不一樣。 */
      const os = useOrdersStore()
      await os.load()
      return {
        settlements: mock.sellerSettlements.map(s => ({
          ...s,
          /* mock 的種子沒有這兩欄。owesCard 照後端同一條規則推，
             shipTo 給 null —— demo 要看得到「買家還沒填」那一版長什麼樣。 */
          owesCard: s.status === 'released' && s.shipDueAt != null && s.shippedAt == null,
          shipTo: null
        })),
        orders: os.orders.filter(o => o.sellerId === 'me'),
        /* mock 的保留額是從清單推出來的，不是另外記一個數字 ——
           跟後端的 walletOf() 同一個模型（保留額沒有可以直接改的欄位）。 */
        wallet: { points: w.points, locked, reserved, available: w.points - locked },
        serverTime: Date.now()
      }
    }
    const r = await http<{
      settlements: Any[]; orders?: Order[]; wallet: SellerWallet; serverTime: number
    }>('/v1/seller/settlements')
    return {
      settlements: r.settlements.map(toSettlement),
      /* 舊版後端不回這個欄位。缺的時候當成空陣列而不是壞掉 ——
         前端會先於後端上線，那段時間這一頁只是回到「只有池」的樣子。 */
      orders: r.orders ?? [],
      wallet: r.wallet,
      serverTime: Number(r.serverTime) || Date.now()
    }
  },

  /**
   * 標記某一筆已出貨。單號選填 —— 平台不代管實體卡，賣家直接寄給買家
   * （docs/HANDOFF.md 4.2），所以單號是給買家追蹤用的憑據，不是放款條件。
   *
   * 一次只送一筆是刻意的：後端沒有批次端點，而在前端硬湊一個
   * 「一次成功或一次失敗」的假原子操作，會在中間某一筆撞到 409 時
   * 讓賣家不知道到底寄出了幾筆。呼叫端自己迴圈，並逐筆回報結果。
   */
  async shipSettlement(id: string, opts: { carrier?: Carrier; tracking?: string } = {}): Promise<void> {
    if (MOCK) {
      await delay(240)
      if (!mock.mockShipSettlement(id)) throw new Error('這筆目前不是等待出貨的狀態')
      return
    }
    const tracking = opts.tracking?.trim()
    await http(`/v1/seller/settlements/${id}/ship`, {
      method: 'POST',
      // 沒填單號就整個欄位不送：送空字串會被 zod 的 min(4) 擋成 400
      json: tracking ? { tracking, carrier: opts.carrier ?? 'other' } : {}
    })
  },

  /**
   * 標記某一筆**市場託管訂單**已出貨。
   *
   * 出貨與結算頁要成為賣家唯一要看的地方，那就必須在同一頁按得下這個動作 ——
   * 只把訂單列出來卻要人跳去 /orders 才按得到，等於把漏看的風險換個地方擺。
   *
   * 委託給訂單 store 而不是自己打一次 HTTP：那支已經處理了
   * 「空單號不要送」與 mock 模式的狀態轉換，而且送完會 sweep 一次。
   * 這裡再寫一份的話，兩條路對同一個端點的參數會慢慢分岔。
   * 失敗時 store 會把錯誤往外丟，呼叫端照樣逐筆收得到。
   */
  async shipOrder(id: string, opts: { carrier?: Carrier; tracking?: string } = {}): Promise<void> {
    const ok = await useOrdersStore().ship(id, opts)
    if (!ok) throw new Error('這張訂單目前不是等待出貨的狀態')
  },

  /** 目前錢包（API 模式用來初始化；mock 模式回 store 現值） */
  async wallet(): Promise<{ points: number; locked: number }> {
    const w = useWalletStore()
    if (MOCK) return { points: w.points, locked: w.locked }
    const r = await http<{ wallet: { points: number; locked: number } }>('/v1/wallet')
    return r.wallet
  },

  // ---- 客服工單（客服端）----
  // 端點與形狀見 docs/tickets-contract.md 第四節。使用者端那條動線（/v1/tickets）
  // 由另一支負責，不寫在這裡，免得兩邊互相蓋掉。

  /**
   * 佇列。預設只要待處理的 —— 客服打開這頁要看的是「現在有什麼要我處理」，
   * 已結案的單混在裡面只會把真正在等的人往下推。
   *
   * 後端預設就是回 open + pending-user（契約第四節），所以「待處理」不帶 status，
   * 「全部」才明確要 status=all；反過來在前端列舉兩個狀態送上去的話，
   * 之後後端多一種待處理狀態，這裡會靜默漏掉它。
   */
  async adminTickets(scope: 'pending' | 'all' = 'pending'): Promise<AdminTicketRow[]> {
    if (MOCK) { await delay(180); return mockTickets.adminList(scope) }
    const r = await http<{ items: AdminTicketRow[] }>(`/v1/admin/tickets${scope === 'all' ? '?status=all' : ''}`)
    return r.items
  },

  async adminTicket(id: string): Promise<AdminTicketDetail> {
    if (MOCK) {
      await delay(160)
      const t = mockTickets.adminGet(id)
      if (!t) throw new Error('找不到這張工單')
      return t
    }
    const r = await http<{ ticket: AdminTicketDetail }>(`/v1/admin/tickets/${id}`)
    return r.ticket
  },

  /** 認領。已被別人認領時後端回 409，錯誤訊息照原樣給人看（那句話本來就是寫給客服的） */
  async claimTicket(id: string): Promise<AdminTicketDetail> {
    if (MOCK) {
      await delay(220)
      const me = useAuthStore()
      return mockTickets.adminClaim(id, me.user?.id ?? mockTickets.MOCK_ADMIN.id,
        me.user?.name || mockTickets.MOCK_ADMIN.name)
    }
    await http(`/v1/admin/tickets/${id}/claim`, { method: 'POST' })
    return this.adminTicket(id)
  },

  /** 客服回覆。後端會把狀態推成 pending-user 並通知開單人 */
  async replyTicket(id: string, body: string, fileIds: string[] = []): Promise<AdminTicketDetail> {
    if (MOCK) { await delay(260); return mockTickets.adminReply(id, body, fileIds) }
    await http(`/v1/admin/tickets/${id}/messages`, {
      method: 'POST',
      // 沒有附件就整個欄位不送：空陣列跟「沒有附件」對後端是同一件事，但少送一欄比較不容易踩到驗證
      json: fileIds.length ? { body, fileIds } : { body }
    })
    return this.adminTicket(id)
  },

  /**
   * 結案。
   *
   * `disputeTo` 只在 `kind === 'order-dispute'` 且 `outcome === 'resolved'` 時要帶
   * —— 那一條會讓後端去呼叫既有的爭議裁決邏輯，**點數會真的移動**。
   * 其餘情況一律不送這個欄位：多送一個沒人讀的欄位，日後很難查出它是什麼時候
   * 開始被讀的。
   */
  async resolveTicket(
    id: string,
    input: { outcome: 'resolved' | 'rejected'; resolution: string; disputeTo?: 'buyer' | 'seller' }
  ): Promise<AdminTicketDetail> {
    const { outcome, resolution, disputeTo } = input
    if (MOCK) { await delay(320); return mockTickets.adminResolve(id, outcome, resolution, disputeTo) }
    await http(`/v1/admin/tickets/${id}/resolve`, {
      method: 'POST',
      json: disputeTo ? { outcome, resolution, disputeTo } : { outcome, resolution }
    })
    return this.adminTicket(id)
  }
}

/* ------------------------------------------------------------------
   客服工單：**客服端視角**才有的兩個形狀。

   TicketKind / TicketStatus / TicketSummary / TicketMessage / TicketDetail
   五個共用型別宣告在下面「使用者端」那一段（同一個檔案，同一份契約第二節），
   這裡刻意不重覆宣告一份 —— 兩份會分岔，而分岔的那一天沒有人會發現，
   因為 TypeScript 只會說「重複宣告」，不會說「哪一份才對」。

   這裡只加客服端多出來的部分，用繼承接上去，不去改使用者端那一段。
------------------------------------------------------------------ */

/**
 * 客服看到的單一張工單。比使用者端多一個 `certHolder`。
 *
 * 為什麼是獨立的型別而不是把欄位加進 TicketDetail：契約第三節寫得很清楚，
 * `GET /v1/tickets/:id`（使用者端）**一律不回** certHolder —— 那是別人的身分。
 * 讓它只存在於客服端的型別上，「誰讀得到目前登記人」這件事就變成型別問題，
 * 而不是要靠每個人記得的約定。
 */
export interface AdminTicketDetail extends TicketDetail {
  /** 接管單專用：那個編號目前登記在誰名下 */
  certHolder?: { userId: string; userName: string; memberNo: string } | null
}

/**
 * 佇列的一列。
 *
 * 契約第四節寫的是「TicketSummary 額外帶 userName、userMemberNo」，
 * 但第七節要求佇列上要有「認領人」那一欄，而 TicketSummary 沒有 assignee。
 * 後兩個欄位在這裡標成**選填**：後端若照第四節的字面只回 userName／userMemberNo，
 * 畫面會顯示「未認領」而不是壞掉 —— 少一欄資訊是可以接受的降級，整頁噴錯不是。
 * （契約需要補這兩欄，已回報。）
 */
export interface AdminTicketRow extends TicketSummary {
  userName: string
  userMemberNo?: string
  assigneeId?: string | null
  assigneeName?: string | null
}

/* ==================================================================
   客服工單（使用者端）

   契約：docs/tickets-contract.md 第二、三節。後端由另一支平行實作，
   所以這一段只照契約寫，不等它上線 —— MOCK 模式走 mocks/tickets.ts 的
   有狀態假資料，接上後端只是把 MOCK 分支關掉。

   刻意獨立成一個物件而不是塞進上面的 `api`：工單跟池／市場／錢包不是
   同一組領域，而且這個檔案同時有兩支 agent 在動，附加一整塊比插進去安全。
================================================================== */

export type TicketKind =
  | 'takeover'       // 站外轉手接管：想把已登記的鑑定編號轉到自己名下
  | 'order-dispute'  // 訂單爭議（系統自動開單）
  | 'seller-doc'     // 賣家審核（系統自動開單）
  | 'card-issue'
  | 'account'
  | 'other'

export type TicketStatus =
  | 'open'          // 等客服處理
  | 'pending-user'  // 客服問了問題，等使用者回覆
  | 'resolved'      // 結案，問題解決／申請通過
  | 'rejected'      // 結案，申請駁回

export interface TicketSummary {
  id: string
  kind: TicketKind
  status: TicketStatus
  subject: string
  /** 毫秒。後端的 bigint 經過 JSON 可能是 number 也可能是字串，轉換在這一層做完 */
  createdAt: number
  updatedAt: number
  /** 最後一則訊息的前 80 字。列表上直接看得到進度，不必逐張點進去 */
  lastMessage: string | null
  unread: boolean
  messageCount: number
}

export interface TicketMessage {
  id: number
  authorId: string
  authorName: string
  isStaff: boolean
  body: string
  /** 檔案 id。私有用途，取檔要走 GET /v1/files/:id（只有當事人與管理員讀得到） */
  fileIds: string[]
  createdAt: number
}

export interface TicketDetail extends TicketSummary {
  userId: string
  userName: string
  /** 依 kind 而定，其餘為 null */
  orderId: string | null
  prizeId: string | null
  sellerId: string | null
  grader: string | null
  certNo: string | null
  assigneeId: string | null
  assigneeName: string | null
  closedAt: number | null
  resolution: string | null
  messages: TicketMessage[]
}

export interface NewTicketInput {
  /* 型別就把 order-dispute / seller-doc 排除掉。那兩種只能由系統自動開
     （契約第五節），讓它們在型別上就送不出去，比在畫面上藏起來可靠 */
  kind: Exclude<TicketKind, 'order-dispute' | 'seller-doc'>
  subject: string
  body: string
  fileIds?: string[]
  /** takeover 必填 */
  certNo?: string
  grader?: string
  /** card-issue 選填 */
  prizeId?: string
  orderId?: string
}

/** 後端的時間可能是 number 或字串，一律轉成毫秒數。轉不動就給 0 而不是 NaN。
    （名字不叫 ms —— 這個檔案上面已經有一支給結算用的 ms，那支回 number | null） */
const tms = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : (Date.parse(String(v)) || 0)
}

function toTicketSummary(t: Any): TicketSummary {
  return {
    id: String(t.id),
    kind: t.kind as TicketKind,
    status: t.status as TicketStatus,
    subject: String(t.subject ?? ''),
    createdAt: tms(t.createdAt ?? t.created_at),
    updatedAt: tms(t.updatedAt ?? t.updated_at),
    lastMessage: (t.lastMessage ?? t.last_message ?? null) as string | null,
    unread: !!t.unread,
    messageCount: Number(t.messageCount ?? t.message_count ?? 0)
  }
}

function toTicketMessage(m: Any): TicketMessage {
  return {
    id: Number(m.id),
    authorId: String(m.authorId ?? m.author_id ?? ''),
    authorName: String(m.authorName ?? m.author_name ?? ''),
    isStaff: !!(m.isStaff ?? m.is_staff),
    body: String(m.body ?? ''),
    fileIds: ((m.fileIds ?? m.file_ids ?? []) as string[]).map(String),
    createdAt: tms(m.createdAt ?? m.created_at)
  }
}

function toTicketDetail(t: Any): TicketDetail {
  const closed = t.closedAt ?? t.closed_at ?? null
  return {
    ...toTicketSummary(t),
    userId: String(t.userId ?? t.user_id ?? ''),
    userName: String(t.userName ?? t.user_name ?? ''),
    orderId: (t.orderId ?? t.order_id ?? null) as string | null,
    prizeId: (t.prizeId ?? t.prize_id ?? null) as string | null,
    sellerId: (t.sellerId ?? t.seller_id ?? null) as string | null,
    grader: (t.grader ?? null) as string | null,
    certNo: (t.certNo ?? t.cert_no ?? null) as string | null,
    assigneeId: (t.assigneeId ?? t.assignee_id ?? null) as string | null,
    assigneeName: (t.assigneeName ?? t.assignee_name ?? null) as string | null,
    closedAt: closed == null ? null : tms(closed),
    resolution: (t.resolution ?? null) as string | null,
    messages: ((t.messages ?? []) as Any[]).map(toTicketMessage)
  }
}

export const ticketsApi = {
  /** 我的單。游標分頁，跟其他列表同一個 Page<T> 形狀 */
  async list(opts: PageOpts & { status?: TicketStatus } = {}): Promise<Page<TicketSummary>> {
    if (MOCK) {
      await delay(180)
      const m = await import('@/mocks/tickets')
      return { items: m.listTickets(opts.status), nextCursor: null }
    }
    const q = new URLSearchParams()
    if (opts.status) q.set('status', opts.status)
    if (opts.limit) q.set('limit', String(opts.limit))
    if (opts.cursor) q.set('cursor', opts.cursor)
    const qs = q.toString()
    const r = await http<{ items: Any[]; nextCursor: string | null }>(
      `/v1/tickets${qs ? `?${qs}` : ''}`, { signal: opts.signal })
    return { items: r.items.map(toTicketSummary), nextCursor: r.nextCursor ?? null }
  },

  /** 單一張（含訊息串）。只有開單人自己讀得到，後端會擋 */
  async get(id: string): Promise<TicketDetail> {
    if (MOCK) {
      await delay(160)
      const m = await import('@/mocks/tickets')
      const t = m.getTicket(id)
      if (!t) throw new ApiError('NOT_FOUND', '找不到這張單，或它不屬於你', 404)
      return t
    }
    const r = await http<{ ticket: Any }>(`/v1/tickets/${encodeURIComponent(id)}`)
    return toTicketDetail(r.ticket)
  },

  /** 開單。回的是完整明細，呼叫端可以直接跳進詳情頁 */
  async create(input: NewTicketInput): Promise<TicketDetail> {
    if (MOCK) {
      await delay(420)
      const m = await import('@/mocks/tickets')
      return m.createTicket(input)
    }
    const r = await http<{ ticket: Any }>('/v1/tickets', {
      method: 'POST',
      /* 開單是會成立一筆新資料的動作，重送必須不重複成立 ——
         手機上送出後網路一卡，使用者的第一個反應就是再按一次。 */
      headers: { 'idempotency-key': idem() },
      json: {
        kind: input.kind,
        subject: input.subject,
        body: input.body,
        fileIds: input.fileIds?.length ? input.fileIds : undefined,
        certNo: input.certNo || undefined,
        grader: input.grader || undefined,
        prizeId: input.prizeId || undefined,
        orderId: input.orderId || undefined
      }
    })
    return toTicketDetail(r.ticket)
  },

  /** 回一則。已結案的單後端回 409，訊息會建議開新單 */
  async reply(id: string, body: string, fileIds: string[] = []): Promise<TicketMessage> {
    if (MOCK) {
      await delay(320)
      const m = await import('@/mocks/tickets')
      return m.addMessage(id, body, fileIds)
    }
    const r = await http<{ message: Any }>(`/v1/tickets/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      json: { body, fileIds: fileIds.length ? fileIds : undefined }
    })
    return toTicketMessage(r.message)
  }
}

/* ==================================================================
   卡片上傳入庫（卡冊登記）

   使用者把手上的實體卡登記進自己的卡冊：POST /v1/cardbook/upload。
   後端由另一支平行實作，這一段照契約寫，不等它上線 —— MOCK 模式
   直接把一張 in_book 的卡塞進 mocks/data.ts 的 userPrizes，
   整條動線（登記 → 卡冊看得到）沒有後端也走得完。

   刻意獨立成一個物件而不是塞進上面的 `api`：跟工單那一段同一個理由 ——
   這個檔案同時有多支 agent 在動，附加一整塊比插進既有物件安全。
================================================================== */

export interface UploadCardInput {
  name: string
  setCode: string
  cardNo: string
  artId?: string | null
  language?: 'JP' | 'EN'
  grader?: Grader
  /** RAW 的卡是 null */
  grade?: number | null
  /** 裸卡（RAW）沒有編號，null／不送都可以 */
  certNo?: string | null
  variantId?: string | null
  /** 自己標的參考價。選填、只顯示，不參與任何計算 */
  refPrice?: number | null
  /** 目錄沒有這張卡時必填的正面照；必須是本人上傳的 card-front 檔案。 */
  frontFileId?: string | null
}

/* mock 專用：一個「登記在別人名下」的示範編號。
   卡冊 mock 裡帶編號的卡全都在自己名下（登記它們會撞 ALREADY_IN_BOOK，
   那是另一條分支），所以 CERT_ALREADY_LISTED 這條需要一個不在自己
   卡冊裡的編號才走得到 —— 沒有它，「申請接管」的入口在 mock 模式下
   永遠沒有人看得到。 */
const MOCK_OTHERS_CERT = '82345699'

export const cardbookApi = {
  /**
   * 登記一張實體卡。成功回 201 { prize }：新列 status 是 in_book、
   * tier 是 **null**（沒進過池就沒有賞別，見 types/models.ts）、
   * 保管人是自己（卡還在使用者手上，所以沒有寄存期限）。
   *
  * 失敗時以 ApiError.code 分流：CERT_ALREADY_LISTED 代表登記在別人名下，
  * ALREADY_IN_BOOK 代表已經在自己的卡冊裡。
   */
  async upload(input: UploadCardInput): Promise<{ prize: UserPrize }> {
    if (MOCK) {
      await delay(420)
      const cert = input.certNo?.trim() || null
      if (cert) {
        const mine = mock.userPrizes.find(p =>
          p.card.certNo === cert && p.status !== 'recycled' && p.status !== 'refunded')
        if (mine) {
          const statusText: Record<UserPrize['status'], string> = {
            stashed: '寄存中', in_book: '在卡冊', in_pool: '押在池裡當獎品',
            listed: '在市場上販售中', ship_requested: '等待出貨', shipped: '已出貨',
            recycled: '已回收', refunded: '已退還'
          }
          /* 代號照真後端（server/src/routes/cardbook.ts 的 ALREADY_IN_BOOK）。
             mock 自己編一個字的話，照著展示模式寫的分支到了真後端就不成立 ——
             那正是這條分支之前發生的事。 */
          throw new ApiError(
            'ALREADY_IN_BOOK',
            `這張卡已經在你的卡冊裡了（目前狀態：${statusText[mine.status]}），不用再登記一次。`,
            409, { prizeId: mine.id, status: mine.status }
          )
        }
        const listed = (await import('@/mocks/tickets')).MOCK_LISTED_CERTS
        if (listed.has(cert) || cert === MOCK_OTHERS_CERT) {
          throw new ApiError(
            'CERT_ALREADY_LISTED',
            '這個鑑定編號目前登記在別人名下 —— 同一張實體卡在系統裡只能有一個持有人。'
            + '如果這張卡確實在你手上（例如站外買來的），可以申請接管。',
            409, { certNo: cert, grader: input.grader || 'PSA' }
          )
        }
      }
      const now = new Date()
      const prize: UserPrize = {
        id: `up-upl-${now.getTime().toString(36)}`,
        card: {
          id: input.artId || `upl-${now.getTime().toString(36)}`,
          name: input.name,
          setCode: input.setCode,
          cardNo: input.cardNo,
          language: input.language ?? 'JP',
          grader: input.grader ?? 'RAW',
          grade: input.grader && input.grader !== 'RAW' ? (input.grade ?? null) : null,
          certNo: cert,
          image: input.frontFileId ? `/v1/files/${input.frontFileId}` : '',
          refPrice: input.refPrice ?? null,
          artId: input.artId ?? undefined,
          variantId: input.variantId ?? null
        },
        /* 沒進過池的卡沒有賞別 —— null 是語意正確的值，不能退回 'D' */
        tier: null,
        status: 'in_book',
        wonAt: now.toISOString().slice(0, 16).replace('T', ' '),
        acquiredAt: now.toISOString(),
        /* 卡在自己手上（保管人是自己），沒有平台寄存的 90 天期限可言 */
        stashExpiresAt: '—',
        buyback: null
      }
      mock.userPrizes.unshift(prize)
      /* 回副本：mock 的原始物件之後還會被改（上架、進池），
         呼叫端拿到的那一份不該跟著變。 */
      return { prize: { ...prize, card: { ...prize.card } } }
    }
    const r = await http<{ prize: Any }>('/v1/cardbook/upload', {
      method: 'POST',
      json: { card: {
        name: input.name,
        setCode: input.setCode,
        cardNo: input.cardNo,
        artId: input.artId || undefined,
        language: input.language || undefined,
        grader: input.grader || undefined,
        grade: input.grade ?? undefined,
        certNo: input.certNo || undefined,
        variantId: input.variantId || undefined,
        refPrice: input.refPrice ?? undefined,
        frontFileId: input.frontFileId || undefined
      } }
    })
    return { prize: toPrize(r.prize) }
  }
}
