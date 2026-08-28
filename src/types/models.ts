// ------------------------------------------------------------------
// Domain models — mirrors the backend schema in the architecture doc
// ------------------------------------------------------------------

/* 交易領域的型別搬到 src/shared/ —— 那裡的東西後端會直接吃。
   這裡 re-export 讓既有的 import 不用動。 */
export type {
  Grader, CardItem, Delivery, Listing, OrderStatus, ClosedBy, Order
} from '@/shared/domain'
/* re-export 不會把名字帶進本檔的作用域，底下還有型別直接引用 CardItem，
   所以要再 import 一次 */
import type { CardItem } from '@/shared/domain'
/**
 * BUST = 保底籤：這一格不發獎品，只發一張保底卡。
 *
 * 沒有任何玩法在用它了（連莊爆賞已移除），但它必須留在型別與後端的 enum 裡 ——
 * shared/economics.ts 的 redeemAllowed 就是為了「賣家把價值藏在 BUST 裡」
 * 這條攻擊路徑存在的（安全稽核 C-2）。把賞別從型別拿掉不會讓那道閘變得不必要，
 * 只會讓它看起來沒有理由。
 */
export type Tier = 'A' | 'B' | 'C' | 'D' | 'LAST' | 'BUST'

/**
 * 玩法模式（源自市場調查：金證N/oneone 四玩法 + DOPA ニブイチ）
 *
 * 三種只有 muteki 是後端真的實作了的 —— pools-service.ts 的 draw() 從來沒讀過
 * pools.mode，它做的事就是無敵賞。所以建池 API 只收 muteki，資料庫的 check
 * 也只允許 muteki（migration 016）。另外兩種在 API 模式下開不出池，
 * 型別留著是因為 mock（demo 模式）還在示範它們，而且將來要實作。
 *
 * streak（連莊爆賞）與 auction（尾籤競標）已經整組移除：它們後端零實作，
 * 前端卻有完整的頁面會把玩家導進去，是一條看得到、走不通的死路。
 * 要實作的時候從 git 歷史撿回來比留著一份沒人維護的假介面便宜。
 *
 * - classic  經典賞：最後賞送給抽走最後一籤的人（LAST 不佔籤位）
 * - shitei   指定賞：抽中指定賞 → 加送最後賞，整池立刻結束
 * - muteki   無敵賞：最後賞作為一般大獎放在籤池內，無額外贈獎
 */
/**
 * 池的來源。三級的差別必須是「實際保障不同」，不能只是顏色不同 ——
 * 標籤如果不對應任何真實差異，使用者學會忽略它只要一週。
 *
 *  official  平台自營。平台就是賣家，出貨與糾紛平台全責，沒有托管期
 *  merchant  已驗證商家（統編／實體店）。款項托管到出貨 + 鑑賞期
 *  personal  個人賣家。托管期最長、單池總額有上限、需要保證金
 */
export type PoolOrigin = 'official' | 'merchant' | 'personal'

export type PoolMode = 'classic' | 'shitei' | 'muteki'

export type PoolStatus = 'committed' | 'open' | 'sold_out' | 'revealed'
export type PrizeStatus =
  | 'stashed' | 'listed' | 'ship_requested' | 'shipped' | 'recycled'
  /** 賣家逾期未出貨，票金已從保留額退回買家。卡從來沒有離開賣家手上 */
  | 'refunded'
  /** 閒置在卡冊：接管來的、或池結束解押回來的。可以上架、可以再進池（migration 021/023） */
  | 'in_book'
  /** 押在某個池裡當獎品，抽中前不能動（migration 023 的建池押記） */
  | 'in_pool'


export interface PoolPrize {
  id: string
  tier: Tier
  card: CardItem
  total: number
  remaining: number
  /**
   * 賣家宣告的買回價（單張，點）。開賣前鎖死、寫進 commit，抽完也改不了。
   *
   * **一定要在抽卡前就顯示出來** —— 抽完才知道能買回多少就是釣魚。
   * null = 這個池是買回制上線之前開的，從來沒有做過這個承諾。
   */
  buyback?: number | null
}

/**
 * 賣家審核等級。平台不開放完全匿名上架 —— 這是多賣家市集最主要的詐騙防線。
 * - pending  已註冊未過審，只能建立草稿，不能開賣
 * - verified 已驗證身分（實名 + 金流帳戶），可開賣，單池上限較低
 * - trusted  長期履約良好，解除單池上限、可申請提前撥款
 */
export type SellerTier = 'pending' | 'verified' | 'trusted'

export interface Seller {
  id: string
  handle: string
  name: string
  tier: SellerTier
  avatarHue: number
  joinedAt: string
  bio: string
  stats: {
    poolsRun: number
    cardsShipped: number
    avgShipDays: number
    disputeRate: number   // 百分比

    /* 中獎率：標示 vs 實際結算。
       這兩個數字擺在一起才有意義 —— 只公布「標示率」等於只公布行銷文案，
       產業裡使用者最常見的抱怨就是「標示的跟實際對不上」。
       實際率由已完抽池的結果統計出來，樣本數一起公開，
       否則開三池就宣稱 100% 命中也能成立。 */
    advertisedTopRate: number   // 標示的高賞（A / 最後賞）機率 %
    actualTopRate: number       // 已完抽池實際結算的 %
    drawsSettled: number        // 統計樣本：已結算的抽數
  }
  /** 過去開出的大獎，給買家判斷這個賣家真的放得起好東西 */
  pastPrizes: {
    cardName: string
    artId?: string
    tier: Tier
    poolTitle: string
    wonAt: string
    /** 得主代號，遮罩後的 */
    winner: string
  }[]
}

/**
 * 資金托管：玩家付的錢不會立刻進賣家口袋，而是由平台代管，
 * 待出貨完成 + 鑑賞期結束才撥款。這是市集模式與單一莊家最大的差別。
 */
export interface Escrow {
  held: number              // 目前代管中的點數
  releaseAfterShipDays: number
  released: number
}

export interface Pool {
  id: string
  sellerId: string
  origin: PoolOrigin
  title: string
  cover: string
  mode: PoolMode
  shiteiTier?: Tier        // shitei 模式：抽中此賞即觸發結束+送最後賞
  ticketPrice: number
  totalTickets: number
  remainingTickets: number
  /**
   * 開賣當下算的**保底回饋率** ＝ Σ(宣告買回價 × 數量) ÷ 票收 × 100。
   * 意思是「你最少拿得回多少」，是下限不是平均。
   * null = 這個池沒有宣告過買回價（買回制上線之前開的舊池）。
   */
  floorRatio?: number | null
  /**
   * 舊制的還元率（Σ 賣家標示的市值 ÷ 票收 × 100）。**只有舊池有。**
   * 分子是賣家自己填的、沒有外部依據的數字，所以顯示它時一定要標明
   * 「賣家標示的市值」，不能講得像承諾。新池不會有這個值。
   */
  returnRatio?: number | null
  /** 這個池用哪一版 manifest 規則做的承諾（1 / 2 / 3）。驗算端照它重算 */
  commitVersion?: number | null
  takenSeats: number[]     // 已被抽走的籤位（1-based）
  status: PoolStatus
  commitHash: string       // SHA256(server_seed)，開賣前公布
  clientSeedSource: string // e.g. BTC block #920000
  prizes: PoolPrize[]
  openedAt: string
  escrow: Escrow
}

export interface DrawResultItem {
  ticketSeq: number        // 玩家親手選的籤位
  tier: Tier
  card: CardItem
  bonus?: boolean          // 最後賞加贈（不佔籤位，classic 完抽/shitei 觸發時附加）
  /** 這張卡在卡冊裡那一列的 id。用來把「剛拿到的是哪幾張」帶到卡冊標出來。
      mock 與 reload 前存下的舊結果沒有，所以是選填 */
  stashId?: string
}

export interface DrawResult {
  drawId: string
  poolId: string
  items: DrawResultItem[]
  cost: number
}

/**
 * 市場掛單 —— 玩家之間直接買賣卡片。
 *
 * 成交幣別是「點數」不是現金，而且點數永不可提現。
 * 這不是設計偏好，是 lib/recycle.ts 那整套法律論述的地基：
 * 一旦價值能流出平台，「付錢碰運氣 + 輸贏可換回金錢」的對價關係就成立。
 * 玩家互相買賣仍然停留在站內閉環，這條線不能破。
 */

export interface UserPrize {
  id: string
  card: CardItem
  /**
   * 這張卡是以什麼賞別被抽出來的。
   *
   * **null 是語意正確的值，不是缺資料**：使用者自己登記進卡冊的實體卡
   * （POST /v1/cardbook/upload）從來沒有進過任何池，賞別這個概念對它
   * 根本不成立。讀這個欄位的畫面必須自己決定 null 要怎麼呈現
   * （徽章顯示「未分級」、統計另立一類、排序排最後）——
   * 一律退回 'D' 會把「沒有賞別」講成「最低賞」，那是兩件不同的事。
   */
  tier: Tier | null
  status: PrizeStatus
  /** 這張卡被抽出來的時間。轉手不會改它 —— 那是既成事實，也是公開動態的依據 */
  wonAt: string
  /** 這張卡進到「我的」卡冊的時間。抽到時等於 wonAt，買來的是成交那一刻。
      卡冊的排序與累積曲線都看這個，不看 wonAt（見 server migrations/014） */
  acquiredAt: string
  stashExpiresAt: string
  /**
   * 這張卡的**宣告買回價**（點）。賣家在建池時一格一格填、寫進 commit 鎖死。
   * null = 那個池是買回制上線之前開的，沒有做過這個承諾，因此不能回收。
   *
   * 前端算不出這個數字也不該猜（它跟 card.refPrice 沒有任何算式關係）——
   * 由 API 帶回來，見 src/lib/recycle.ts。
   */
  buyback?: number | null
  /** 這一籤的結算狀態（保留中／已入帳／已退還…）。舊制抽到的卡沒有結算列 */
  settleStatus?: string | null
}

export interface LedgerEntry {
  id: string
  delta: number
  balanceAfter: number
  type: 'topup' | 'draw' | 'refund' | 'recycle' | 'redeem'
  note: string
  createdAt: string
}

export interface WinnerEvent {
  user: string   // 匿名化，e.g. VD-3F**
  poolTitle: string
  tier: Tier
  cardName: string
  at: string
}

/* ---------------- 託管訂單 ----------------
   只有 delivery: 'ship' 的交易會產生訂單。庫內轉移是原子交換，
   成交當下就結束，沒有中間狀態可言。 */

