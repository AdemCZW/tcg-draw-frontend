// ------------------------------------------------------------------
// Domain models — mirrors the backend schema in the architecture doc
// ------------------------------------------------------------------

export type Grader = 'PSA' | 'BGS' | 'ARS' | 'RAW'
/** BUST = 連莊爆賞的「爆」籤，抽中即該輪歸零（僅 streak 模式使用） */
export type Tier = 'A' | 'B' | 'C' | 'D' | 'LAST' | 'BUST'

/**
 * 玩法模式（源自市場調查：金證N/oneone 四玩法 + DOPA ニブイチ）
 * - classic  經典賞：最後賞送給抽走最後一籤的人（LAST 不佔籤位）
 * - shitei   指定賞：抽中指定賞 → 加送最後賞，整池立刻結束
 * - muteki   無敵賞：最後賞作為一般大獎放在籤池內，無額外贈獎
 * - battle   大亂鬥：無最後賞，純定量池
 * - niboichi 二選一：僅 2 籤，1 大獎 1 安慰獎
 * - streak   連莊爆賞：付一次入場費可連續免費抽，隨時可收手落袋；
 *            抽到 BUST 籤則該輪全數沒收（沒收品流入賣家下一池，不回本池，
 *            以免破壞開賣前封存的籤序）
 * - auction  尾籤競標：最後 N 支籤不固定售價，改限時英式競標，落標全額退還
 */
export type PoolMode = 'classic' | 'shitei' | 'muteki' | 'battle' | 'niboichi' | 'streak' | 'auction'

export type PoolStatus = 'committed' | 'open' | 'sold_out' | 'revealed'
export type PrizeStatus = 'stashed' | 'ship_requested' | 'shipped' | 'recycled'

export interface CardItem {
  id: string
  name: string           // e.g. 噴火龍 ex SAR
  setCode: string        // e.g. sv4a
  cardNo: string         // e.g. 349/190
  language: 'JP' | 'EN'
  grader: Grader
  grade: number | null   // RAW = null
  certNo: string | null  // PSA cert — 對外可驗證
  image: string
  refPrice: number       // 市場參考價（顯示用）
}

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
  }
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
  title: string
  cover: string
  mode: PoolMode
  shiteiTier?: Tier        // shitei 模式：抽中此賞即觸發結束+送最後賞
  auctionSeats?: number    // auction 模式：最後幾支籤轉為競標（賣家設定）
  ticketPrice: number      // streak 模式為「入場費」，續抽不再收費
  totalTickets: number
  remainingTickets: number
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

export interface UserPrize {
  id: string
  card: CardItem
  tier: Tier
  status: PrizeStatus
  wonAt: string
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
