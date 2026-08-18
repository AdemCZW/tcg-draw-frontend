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
/**
 * 池的來源。三級的差別必須是「實際保障不同」，不能只是顏色不同 ——
 * 標籤如果不對應任何真實差異，使用者學會忽略它只要一週。
 *
 *  official  平台自營。平台就是賣家，出貨與糾紛平台全責，沒有托管期
 *  merchant  已驗證商家（統編／實體店）。款項托管到出貨 + 鑑賞期
 *  personal  個人賣家。托管期最長、單池總額有上限、需要保證金
 */
export type PoolOrigin = 'official' | 'merchant' | 'personal'

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
  /* TCGdex 的卡片編號，例如 'SV4a-349'（閃色寶藏ex 的噴火龍ex UR 金卡）。
     給了就直接取那一張的圖；不給才退回用卡名去搜。

     為什麼需要這個：搜尋只吃卡名的第一個詞（「噴火龍 ex SAR」→ 搜「噴火龍」），
     然後拿回傳清單裡第一張有圖的 —— 那通常是普卡，不是我們想展示的密卡。
     要指定「就是那張金卡」只能給編號。 */
  artId?: string
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

/**
 * 市場掛單 —— 玩家之間直接買賣卡片。
 *
 * 成交幣別是「點數」不是現金，而且點數永不可提現。
 * 這不是設計偏好，是 lib/recycle.ts 那整套法律論述的地基：
 * 一旦價值能流出平台，「付錢碰運氣 + 輸贏可換回金錢」的對價關係就成立。
 * 玩家互相買賣仍然停留在站內閉環，這條線不能破。
 */
export interface Listing {
  id: string
  card: CardItem
  /** 賣家開的點數價 */
  price: number
  /** 上架者。平台自營用 'platform' */
  sellerId: string
  sellerName: string
  listedAt: string
  status: 'live' | 'sold'
  /** 來源：玩家抽到的卡（帶 UserPrize.id），或平台上架 */
  fromPrizeId?: string
  /**
   * 交付方式。決定這筆交易要不要走託管與爭議流程：
   *   vault 卡還在保管庫 —— 成交是一筆所有權異動，沒有運送、沒有驗收期
   *   ship  卡在賣家手上 —— 要寄送，付款與交付之間有時間差，需要託管
   *
   * 沒填時由 fromPrizeId 推導（抽到的卡預設還在庫裡）。等後端接上之後
   * 這裡要變成必填 —— 使用者可以先提領再上架，那時就推不出來了。
   */
  delivery?: 'vault' | 'ship'
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

/* ---------------- 託管訂單 ----------------
   只有 delivery: 'ship' 的交易會產生訂單。庫內轉移是原子交換，
   成交當下就結束，沒有中間狀態可言。 */

export type OrderStatus =
  /** 已鎖點，等賣家出貨 */
  | 'escrowed'
  /** 已出貨，運送中 */
  | 'shipped'
  /** 已送達，驗收期內 */
  | 'delivered'
  /** 爭議處理中 */
  | 'disputed'
  /** 已放款給賣家 */
  | 'completed'
  /** 已退款給買家 */
  | 'refunded'
  /** 逾期未出貨，自動取消 */
  | 'cancelled'

export interface Order {
  id: string
  listingId: string
  card: CardItem
  /** 貨款，成立時從買家帳戶凍結的點數 */
  price: number
  /** 賣家保證金。爭議判賣家敗訴或逾期未出貨時沒收 */
  deposit: number
  buyerId: string
  buyerName: string
  sellerId: string
  sellerName: string
  status: OrderStatus
  /** 以下都是毫秒時間戳，沒發生的階段是 undefined */
  createdAt: number
  shippedAt?: number
  deliveredAt?: number
  settledAt?: number
  /** 物流單號。沒有通過驗證的單號就不能標記出貨 */
  tracking?: string
  /** 爭議：開立時間與買家主張 */
  disputedAt?: number
  disputeReason?: string
  /** 買家是否已附開箱影片。沒有影片不受理索賠 */
  hasUnboxingVideo?: boolean
  /** 結案原因，供帳本與客服追溯 */
  closedBy?: 'buyer-confirm' | 'auto-release' | 'ship-timeout' | 'delivery-timeout' | 'dispute-buyer' | 'dispute-seller'
}
