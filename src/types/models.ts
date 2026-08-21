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
/** BUST = 連莊爆賞的「爆」籤，抽中即該輪歸零（僅 streak 模式使用） */
export type Tier = 'A' | 'B' | 'C' | 'D' | 'LAST' | 'BUST'

/**
 * 玩法模式（源自市場調查：金證N/oneone 四玩法 + DOPA ニブイチ）
 * - classic  經典賞：最後賞送給抽走最後一籤的人（LAST 不佔籤位）
 * - shitei   指定賞：抽中指定賞 → 加送最後賞，整池立刻結束
 * - muteki   無敵賞：最後賞作為一般大獎放在籤池內，無額外贈獎
 * - streak   連莊爆賞：付一次入場費可連續免費抽，隨時可收手落袋；
 *            抽到 BUST 籤則該輪全數沒收（沒收品流入賣家下一池，不回本池，
 *            以免破壞開賣前封存的籤序）
 * - auction  尾籤競標：最後 N 支籤不固定售價，改限時英式競標，落標全額退還
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

export type PoolMode = 'classic' | 'shitei' | 'muteki' | 'streak' | 'auction'

export type PoolStatus = 'committed' | 'open' | 'sold_out' | 'revealed'
export type PrizeStatus = 'stashed' | 'listed' | 'ship_requested' | 'shipped' | 'recycled'


export interface PoolPrize {
  id: string
  tier: Tier
  card: CardItem
  total: number
  remaining: number
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
  auctionSeats?: number    // auction 模式：最後幾支籤轉為競標（賣家設定）
  ticketPrice: number      // streak 模式為「入場費」，續抽不再收費
  totalTickets: number
  remainingTickets: number
  /** 開賣當下算的還元率（獎品總值 ÷ 票收 × 100）。舊池沒有這個數字就是 null */
  returnRatio?: number | null
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

/** 連莊爆賞的一輪進行狀態。items 為「暫持中」，收手才真正入袋 */
export interface StreakRun {
  runId: string
  poolId: string
  entryCost: number
  items: DrawResultItem[]
  heldValue: number
  drawnSeats: number[]
  status: 'live' | 'banked' | 'busted'
}

/** 尾籤競標的一個標的。籤內容不公開——競標的張力來自「已知還剩什麼賞」 */
export interface AuctionLot {
  id: string
  poolId: string
  seat: number
  startBid: number
  currentBid: number
  bidCount: number
  topBidder: string | null
  youAreTop: boolean
  endsAt: number          // epoch ms
  status: 'live' | 'ended'
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
  tier: Tier
  status: PrizeStatus
  /** 這張卡被抽出來的時間。轉手不會改它 —— 那是既成事實，也是公開動態的依據 */
  wonAt: string
  /** 這張卡進到「我的」卡冊的時間。抽到時等於 wonAt，買來的是成交那一刻。
      卡冊的排序與累積曲線都看這個，不看 wonAt（見 server migrations/014） */
  acquiredAt: string
  stashExpiresAt: string
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

