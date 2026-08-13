import type { Pool, CardItem, DrawResult, UserPrize, LedgerEntry, WinnerEvent, PoolPrize, StreakRun, AuctionLot, Seller, Escrow, Tier } from '@/types/models'

// 卡圖先用漸層佔位；正式版換 R2 實拍圖 URL
const ph = (hue: number) => `placeholder:${hue}`

const cards: CardItem[] = [
  { id: 'c1', name: '噴火龍 ex SAR', setCode: 'sv4a', cardNo: '349/190', language: 'JP', grader: 'PSA', grade: 10, certNo: '82345671', image: ph(28), refPrice: 18800 },
  { id: 'c2', name: '皮卡丘 AR', setCode: 'sv4a', cardNo: '205/190', language: 'JP', grader: 'PSA', grade: 10, certNo: '82345672', image: ph(48), refPrice: 5200 },
  { id: 'c3', name: '夢幻 SAR', setCode: 'sv2a', cardNo: '347/165', language: 'JP', grader: 'PSA', grade: 9, certNo: '82345673', image: ph(300), refPrice: 3600 },
  { id: 'c4', name: '莉莉艾 SR', setCode: 'sm12a', cardNo: '196/173', language: 'JP', grader: 'BGS', grade: 9.5, certNo: '0015678901', image: ph(340), refPrice: 9800 },
  { id: 'c5', name: '伊布 促販卡', setCode: 'promo', cardNo: '175/S-P', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(80), refPrice: 60 },
  { id: 'c6', name: '卡比獸 AR', setCode: 'sv1a', cardNo: '181/165', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(200), refPrice: 380 },
  { id: 'c7', name: '夢幻 促販卡', setCode: 'promo', cardNo: '151/S-P', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(260), refPrice: 520 },
  { id: 'c8', name: '寶可夢中心 木木梟', setCode: 'promo', cardNo: '215/S-P', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(120), refPrice: 300 },
  { id: 'c9', name: '皮卡丘 普卡', setCode: 'svp', cardNo: '087/SV-P', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(56), refPrice: 60 },
  // 保底卡：價值必須低於票價，否則「輸了反而划算」會破壞獎池
  { id: 'c10', name: '皮卡丘 AR（保底）', setCode: 'sv2a', cardNo: '173/165', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(50), refPrice: 200 },
  // 以下為擴充卡池，象徵性測試各玩法在「多樣卡片」下的顯示與抽取
  { id: 'c11', name: '傑尼龜 AR', setCode: 'sv3a', cardNo: '007/165', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(210), refPrice: 420 },
  { id: 'c12', name: '妙蛙種子 AR', setCode: 'sv3a', cardNo: '001/165', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(140), refPrice: 380 },
  { id: 'c13', name: '小火龍 SAR', setCode: 'sv3a', cardNo: '223/165', language: 'JP', grader: 'PSA', grade: 10, certNo: '82345680', image: ph(20), refPrice: 4200 },
  { id: 'c14', name: '卡蒂狗 促販卡', setCode: 'promo', cardNo: '058/S-P', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(24), refPrice: 90 },
  { id: 'c15', name: '快龍 VSTAR', setCode: 's12a', cardNo: '093/172', language: 'JP', grader: 'PSA', grade: 9, certNo: '82345681', image: ph(255), refPrice: 6800 },
  { id: 'c16', name: '拉普拉斯 AR', setCode: 'sv1a', cardNo: '131/165', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(200), refPrice: 340 },
  { id: 'c17', name: '胡地 ex', setCode: 'sv4a', cardNo: '256/190', language: 'JP', grader: 'ARS', grade: 8, certNo: 'ARS9012345', image: ph(285), refPrice: 2200 },
  { id: 'c18', name: '卡拉卡拉 促販卡', setCode: 'promo', cardNo: '104/S-P', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(35), refPrice: 70 },
  { id: 'c19', name: '大針蜂 AR', setCode: 'sv1a', cardNo: '015/165', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(45), refPrice: 260 },
  { id: 'c20', name: '三合一磁怪 V', setCode: 's9', cardNo: '082/100', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(190), refPrice: 180 },
  { id: 'c21', name: '六尾 促販卡', setCode: 'promo', cardNo: '037/S-P', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(15), refPrice: 85 },
  { id: 'c22', name: '暴鯉龍 SAR', setCode: 'sv1a', cardNo: '230/165', language: 'JP', grader: 'BGS', grade: 9.5, certNo: '0015678910', image: ph(230), refPrice: 7600 },
  { id: 'c23', name: '皮皮 AR', setCode: 'sv2a', cardNo: '040/165', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(320), refPrice: 150 },
  { id: 'c24', name: '耿鬼 VMAX', setCode: 's8', cardNo: '157/184', language: 'JP', grader: 'PSA', grade: 10, certNo: '82345682', image: ph(275), refPrice: 5400 },
  { id: 'c25', name: '卡比獸 促販卡', setCode: 'promo', cardNo: '143/S-P', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(205), refPrice: 95 },
  { id: 'c26', name: '波克比 AR', setCode: 'sv3a', cardNo: '196/165', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(40), refPrice: 220 },
  { id: 'c27', name: '迷唇姐 促販卡', setCode: 'promo', cardNo: '122/S-P', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(330), refPrice: 65 },
  { id: 'c28', name: '鯉魚王 AR', setCode: 'sv1a', cardNo: '128/165', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(215), refPrice: 40 },

  /* 低價入門池專用的普卡（c29–c31）。
     一定要有這個價位帶：在「每支籤都保底給卡」的前提下，票價的下限被最便宜的
     卡值綁死 —— 原本最低只有 40 元的鯉魚王，35 元的池還元率會直接超過 130%
     必然賠本。有 16–18 元的普卡，低價漏斗才算得出來。
     三張皆已確認 TCGdex 繁中庫有圖。 */
  { id: 'c29', name: '綠毛蟲 普卡', setCode: 'sv9', cardNo: '001/098', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(110), refPrice: 17 },
  { id: 'c30', name: '波波 普卡', setCode: 'sv2a', cardNo: '016/165', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(35), refPrice: 18 },
  { id: 'c31', name: '小拉達 普卡', setCode: 'sv2a', cardNo: '019/165', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: ph(275), refPrice: 16 }
]

// 產生已抽籤位（mock 用固定步長跳位，讓籤牆看起來自然散落）
function seatsOf(total: number, taken: number, step = 7): number[] {
  const s: number[] = []
  let cur = 3
  for (let i = 0; i < taken; i++) {
    while (s.includes((cur % total) + 1)) cur++
    s.push((cur % total) + 1)
    cur += step
  }
  return s.sort((a, b) => a - b)
}

/**
 * 還元率設計，全部以 computeEconomics() 實際跑過驗證（不是手算）：
 *
 *  p1 classic  87.6%    p2 battle   87.5%    p3 muteki 72.6%（已完抽）
 *  p4 shitei   83.8%    p5 niboichi 90.4%    p6 streak 84.4%（最佳策略 86.2%）
 *  p7 auction  85.0%    p8 classic  84.6%（低價入門池）
 *
 * 三個模式不能用「獎池總值 ÷ 票收」直接算，各有專屬模型：
 *  - streak  玩家爆掉時獎品不發出，蒙地卡羅模擬各種收手策略
 *  - shitei  抽中指定賞就結束整池，期望只賣出約一半的籤
 *  - auction 末尾席位由喊標決定成交價，只評估固定價格那一段
 *
 * 各池 prizes 加總 = totalTickets；classic/shitei 的 LAST 為額外贈獎不佔籤位。
 */
export const sellers: Seller[] = [
  {
    id: 's1', handle: 'vaultkeeper', name: '保庫堂', tier: 'trusted', avatarHue: 28,
    joinedAt: '2025-03-11', bio: 'PSA / BGS 鑑定卡專門。開池前全數實拍上架，出貨附鑑定證書照。',
    stats: { poolsRun: 142, cardsShipped: 3810, avgShipDays: 1.8, disputeRate: 0.2 }
  },
  {
    id: 's2', handle: 'promo_lab', name: '促販實驗室', tier: 'verified', avatarHue: 260,
    joinedAt: '2026-01-20', bio: '專收日版促販卡與 AR，小池快開快抽。',
    stats: { poolsRun: 23, cardsShipped: 402, avgShipDays: 3.1, disputeRate: 1.1 }
  },
  {
    id: 's3', handle: 'kanto_cards', name: '關都卡舖', tier: 'verified', avatarHue: 140,
    joinedAt: '2025-11-02', bio: '實體店第 8 年，線上同步開池。台北可自取。',
    stats: { poolsRun: 67, cardsShipped: 1520, avgShipDays: 2.4, disputeRate: 0.6 }
  },
  {
    id: 's4', handle: 'newbie_seller', name: '新手賣家', tier: 'pending', avatarHue: 200,
    joinedAt: '2026-08-09', bio: '剛註冊，等待身分驗證中。',
    stats: { poolsRun: 0, cardsShipped: 0, avgShipDays: 0, disputeRate: 0 }
  }
]

export function listSellers(): Seller[] { return sellers.map(s => ({ ...s, stats: { ...s.stats } })) }
export function getSeller(id: string): Seller | undefined {
  const s = sellers.find(x => x.id === id)
  return s ? { ...s, stats: { ...s.stats } } : undefined
}

/** 依已售籤數推算代管中的金額 */
const escrowOf = (sold: number, price: number, released = 0): Escrow => ({
  held: sold * price - released,
  releaseAfterShipDays: 7,
  released
})

export const pools: Pool[] = [
  {
    sellerId: 's1',
    id: 'p1',
    title: '朱紫 SAR 精選 第 1 彈',
    cover: ph(28),
    mode: 'classic',
    ticketPrice: 650,
    totalTickets: 80,
    remainingTickets: 37,
    takenSeats: seatsOf(80, 43),
    status: 'open',
    commitHash: '3f8a9c1d5e2b7a4f6c0d8e9b1a3c5d7e9f2b4a6c8d0e1f3a5b7c9d2e4f6a8b0c',
    clientSeedSource: 'BTC block #920000 hash',
    openedAt: '2026-08-01T12:00:00+08:00',
    escrow: escrowOf(43, 650),
    prizes: [
      { id: 'pr1', tier: 'A', card: cards[0], total: 1, remaining: 1 },
      { id: 'pr2', tier: 'B', card: cards[1], total: 1, remaining: 1 },
      { id: 'pr3', tier: 'C', card: cards[2], total: 1, remaining: 1 },
      // D 賞拆成多種卡片增加多樣性，數量／剩餘總和與原本相同（4/2、73/32）
      { id: 'pr4a', tier: 'D', card: cards[6], total: 2, remaining: 1 },
      { id: 'pr4b', tier: 'D', card: cards[17], total: 2, remaining: 1 },
      { id: 'pr5a', tier: 'D', card: cards[8], total: 25, remaining: 11 },
      { id: 'pr5b', tier: 'D', card: cards[27], total: 25, remaining: 11 },
      { id: 'pr5c', tier: 'D', card: cards[25], total: 23, remaining: 10 },
      { id: 'pr6', tier: 'LAST', card: cards[3], total: 1, remaining: 1 }
    ]
  },
  {
    sellerId: 's2',
    id: 'p2',
    title: '經典促販卡 大亂鬥',
    cover: ph(260),
    mode: 'battle',
    ticketPrice: 120,
    totalTickets: 40,
    remainingTickets: 40,
    takenSeats: [],
    status: 'open',
    commitHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    clientSeedSource: 'BTC block #920144 hash',
    openedAt: '2026-08-08T12:00:00+08:00',
    escrow: escrowOf(0, 120),
    prizes: [
      { id: 'pr7', tier: 'A', card: cards[6], total: 1, remaining: 1 },
      { id: 'pr8a', tier: 'B', card: cards[7], total: 3, remaining: 3 },
      { id: 'pr8b', tier: 'B', card: cards[26], total: 2, remaining: 2 },
      { id: 'pr9a', tier: 'C', card: cards[8], total: 12, remaining: 12 },
      { id: 'pr9b', tier: 'C', card: cards[13], total: 12, remaining: 12 },
      { id: 'pr9c', tier: 'C', card: cards[20], total: 10, remaining: 10 }
    ]
  },
  {
    sellerId: 's3',
    id: 'p3',
    title: '莉莉艾 無敵賞（已完抽）',
    cover: ph(340),
    mode: 'muteki',
    ticketPrice: 700,
    totalTickets: 60,
    remainingTickets: 0,
    takenSeats: seatsOf(60, 60),
    status: 'revealed',
    commitHash: 'deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb',
    clientSeedSource: 'BTC block #918800 hash',
    openedAt: '2026-07-15T12:00:00+08:00',
    escrow: escrowOf(60, 700, 42000),
    prizes: [
      { id: 'pr10', tier: 'LAST', card: cards[3], total: 1, remaining: 0 },
      { id: 'pr11a', tier: 'B', card: cards[2], total: 2, remaining: 0 },
      { id: 'pr11b', tier: 'B', card: cards[15], total: 1, remaining: 0 },
      { id: 'pr12a', tier: 'C', card: cards[7], total: 20, remaining: 0 },
      { id: 'pr12b', tier: 'C', card: cards[22], total: 20, remaining: 0 },
      { id: 'pr12c', tier: 'C', card: cards[18], total: 16, remaining: 0 }
    ]
  },
  {
    sellerId: 's2',
    id: 'p4',
    title: '皮卡丘 指定賞挑戰',
    cover: ph(48),
    mode: 'shitei',
    shiteiTier: 'A',
    /* 指定賞的經濟結構跟定量池完全不同，先前這池的數字是錯的：
       D 賞放了 420 與 380 元的卡，票價卻只有 280 —— 每抽必賠，跟提前結束無關。
       而且抽中 A 賞就結束整池，期望上只賣出約一半的籤（(n+1)/2 ≈ 25.5 支），
       但 A 賞與最後賞一定會發出去，等於用半池的收入扛全額的頭獎。
       重算後：票價 320、A 賞 5,200、最後賞改為 220（原本 3,600 扛不住），
       D 賞平均 55 元，還元率約 83%。 */
    ticketPrice: 320,
    totalTickets: 50,
    remainingTickets: 41,
    takenSeats: seatsOf(50, 9, 5),
    status: 'open',
    commitHash: 'c0ffee9988776655443322110000ffeeddccbbaa99887766554433221100aabb',
    clientSeedSource: 'BTC block #920302 hash',
    openedAt: '2026-08-10T12:00:00+08:00',
    escrow: escrowOf(9, 320),
    prizes: [
      { id: 'pr13', tier: 'A', card: cards[1], total: 1, remaining: 1 },
      { id: 'pr14a', tier: 'D', card: cards[8], total: 20, remaining: 17 },
      { id: 'pr14b', tier: 'D', card: cards[27], total: 15, remaining: 12 },
      { id: 'pr14c', tier: 'D', card: cards[26], total: 14, remaining: 11 },
      { id: 'pr15', tier: 'LAST', card: cards[25], total: 1, remaining: 1 }
    ]
  },
  {
    sellerId: 's1',
    id: 'p5',
    title: '莉莉艾 二選一對決',
    cover: ph(340),
    // 落選方改放 5,200 的皮卡丘 AR（票價 8,300 的 63%）——
    // 原本 4,980 對上 60 元安慰獎，對價關係太懸殊，屬「以小博大」的高風險設計
    mode: 'niboichi',
    ticketPrice: 8300,
    totalTickets: 2,
    remainingTickets: 2,
    takenSeats: [],
    status: 'open',
    commitHash: 'ace1ace2ace3ace4ace5ace6ace7ace8ace9ace0ace1ace2ace3ace4ace5ace6',
    clientSeedSource: 'BTC block #920310 hash',
    openedAt: '2026-08-11T12:00:00+08:00',
    escrow: escrowOf(0, 8300),
    prizes: [
      { id: 'pr16', tier: 'A', card: cards[3], total: 1, remaining: 1 },
      { id: 'pr17', tier: 'B', card: cards[1], total: 1, remaining: 1 }
    ]
  },
  {
    /* 爆賞 20 / 總 66 籤 / 保底卡 200 元。
       抽到爆賞不再空手 —— 暫持獎品沒收，但改發保底卡，
       確保「付入場費一定帶走一張卡」。經模擬：一般玩法還元率 86.5%、
       玩家最佳策略 90.3%。保底卡若給到 120 元以上，最佳策略會衝破 100% 打爆莊家。 */
    sellerId: 's3',
    id: 'p6',
    title: '夢幻 連莊爆賞',
    cover: ph(300),
    mode: 'streak',
    ticketPrice: 500,
    totalTickets: 66,
    remainingTickets: 52,
    takenSeats: seatsOf(66, 14, 5),
    status: 'open',
    commitHash: 'b00mb00mfeed1234567890abcdefb00mb00mfeed1234567890abcdefb00mb00m',
    clientSeedSource: 'BTC block #920355 hash',
    openedAt: '2026-08-11T09:00:00+08:00',
    escrow: escrowOf(14, 500),
    prizes: [
      { id: 'pr18', tier: 'A', card: cards[2], total: 1, remaining: 1 },
      { id: 'pr19', tier: 'B', card: cards[6], total: 3, remaining: 2 },
      { id: 'pr20a', tier: 'C', card: cards[5], total: 7, remaining: 5 },
      { id: 'pr20b', tier: 'C', card: cards[19], total: 5, remaining: 4 },
      { id: 'pr21a', tier: 'D', card: cards[8], total: 12, remaining: 9 },
      { id: 'pr21b', tier: 'D', card: cards[17], total: 10, remaining: 8 },
      { id: 'pr21c', tier: 'D', card: cards[27], total: 8, remaining: 6 },
      // BUST 必須是「唯一一項」——多處程式碼用 .find(tier === 'BUST') 抓保底卡，拆成多項會讓其餘項目被忽略
      { id: 'pr22', tier: 'BUST', card: cards[9], total: 20, remaining: 17 }
    ]
  },
  {
    /* 77 支正常販售 + 最後 3 支競標。
       原本這池的 D 賞被錯放成 暴鯉龍 SAR（7,600）×20 與 傑尼龜 AR（420）×25，
       獎品總值 186,550 對上固定席票收 23,100 —— 卡片索引寫錯造成的資料錯誤。
       重組後：三個大獎（莉莉艾 9,800 / 快龍 6,800 / 夢幻 3,600）留給競標席，
       固定 77 席獎品總值 19,640，還元率 85.0%。 */
    sellerId: 's1',
    id: 'p7',
    title: '噴火龍 尾籤競標',
    cover: ph(28),
    mode: 'auction',
    auctionSeats: 3,
    ticketPrice: 300,
    totalTickets: 80,
    remainingTickets: 3,
    takenSeats: Array.from({ length: 77 }, (_, i) => i + 1),
    status: 'open',
    commitHash: 'a0c7104ebeef55aa11bb22cc33dd44ee55ff6600771188229933aa44bb55cc66',
    clientSeedSource: 'BTC block #920361 hash',
    openedAt: '2026-08-09T12:00:00+08:00',
    escrow: escrowOf(77, 300),
    prizes: [
      // 三個大獎留在最後 3 席競標，因此仍是 remaining: 1
      { id: 'pr23', tier: 'A', card: cards[3], total: 1, remaining: 1 },
      { id: 'pr24a', tier: 'B', card: cards[14], total: 1, remaining: 1 },
      { id: 'pr24b', tier: 'B', card: cards[2], total: 1, remaining: 1 },
      // 固定價格的 77 席已全數售出
      { id: 'pr25a', tier: 'C', card: cards[6], total: 3, remaining: 0 },
      { id: 'pr25b', tier: 'C', card: cards[10], total: 4, remaining: 0 },
      { id: 'pr25c', tier: 'C', card: cards[5], total: 5, remaining: 0 },
      { id: 'pr26a', tier: 'D', card: cards[15], total: 15, remaining: 0 },
      { id: 'pr26b', tier: 'D', card: cards[18], total: 20, remaining: 0 },
      { id: 'pr26c', tier: 'D', card: cards[25], total: 15, remaining: 0 },
      { id: 'pr26d', tier: 'D', card: cards[8], total: 15, remaining: 0 }
    ]
  },
  {
    /* 低價入門池 —— 漏斗上緣。
       競品最低入手價：cc1kuji NT$25、gacha.game US$0.5，本站原本最低 NT$120，
       等於沒有給新使用者一個「先試一次」的價位。
       80 席 × 35 元 = 2,800 收入；獎品總值 2,370；還元率 84.6%（已試算驗證）。
       每支籤都保底給卡，最低的普卡值 16 元，仍佔票價的 46%。 */
    sellerId: 's2',
    id: 'p8',
    title: '銅板入門賞 · 銅板價開一張',
    cover: ph(110),
    mode: 'classic',
    ticketPrice: 35,
    totalTickets: 80,
    remainingTickets: 62,
    takenSeats: Array.from({ length: 18 }, (_, i) => i + 1),
    status: 'open',
    commitHash: 'c3f81a09bb27de4455ff6611aa88cc7733dd0099eeff2244aa66bb88cc00dd11',
    clientSeedSource: 'BTC block #920418 hash',
    openedAt: '2026-08-12T09:00:00+08:00',
    escrow: escrowOf(18, 35),
    prizes: [
      { id: 'pr27', tier: 'A', card: cards[18], total: 1, remaining: 1 },
      { id: 'pr28', tier: 'B', card: cards[22], total: 3, remaining: 2 },
      { id: 'pr29', tier: 'C', card: cards[27], total: 16, remaining: 13 },
      { id: 'pr30a', tier: 'D', card: cards[28], total: 20, remaining: 16 },
      { id: 'pr30b', tier: 'D', card: cards[29], total: 20, remaining: 15 },
      { id: 'pr30c', tier: 'D', card: cards[30], total: 20, remaining: 15 }
    ]
  }
]

export interface NewPoolInput {
  sellerId: string
  title: string
  mode: Pool['mode']
  ticketPrice: number
  shiteiTier?: Tier
  auctionSeats?: number
  prizes: { tier: Tier; name: string; qty: number; unitValue: number }[]
}

/** 賣家開池。籤序在此刻預洗並產生 commit hash（mock 以假雜湊代替） */
export function createPool(input: NewPoolInput): Pool {
  const seats = input.prizes.reduce((s, p) => s + p.qty, 0)
  const seq = pools.length + 1
  const hex = (n: number) => Array.from({ length: n }, (_, i) => 'abcdef0123456789'[(seq * 7 + i * 13) % 16]).join('')

  const prizes: PoolPrize[] = input.prizes.map((p, i) => ({
    id: `np${seq}-${i}`,
    tier: p.tier,
    total: p.qty,
    remaining: p.qty,
    card: {
      id: `nc${seq}-${i}`,
      name: p.name,
      setCode: 'new',
      cardNo: `${i + 1}/${input.prizes.length}`,
      language: 'JP',
      grader: 'RAW',
      grade: null,
      certNo: null,
      image: ph((i * 47 + seq * 23) % 360),
      refPrice: p.unitValue
    }
  }))

  const pool: Pool = {
    sellerId: input.sellerId,
    id: `p${seq}`,
    title: input.title,
    cover: prizes[0]?.card.image ?? ph(200),
    mode: input.mode,
    shiteiTier: input.shiteiTier,
    auctionSeats: input.auctionSeats,
    ticketPrice: input.ticketPrice,
    totalTickets: seats,
    remainingTickets: seats,
    takenSeats: [],
    status: 'open',
    commitHash: hex(64),
    clientSeedSource: 'BTC block (待開賣前指定) hash',
    openedAt: new Date().toISOString(),
    escrow: escrowOf(0, input.ticketPrice),
    prizes
  }
  pools.push(pool)
  const seller = sellers.find(s => s.id === input.sellerId)
  if (seller) seller.stats.poolsRun++
  return poolSnapshot(pool.id)
}

/**
 * 回傳池狀態快照。mock 直接改動模組內的原始物件，Pinia 的 reactive proxy
 * 收不到通知，因此每次變更後都要回傳快照讓 store 透過 proxy 套用。
 * （正式版後端本來就會回傳更新後的狀態，介面一致。）
 */
export function poolSnapshot(poolId: string): Pool {
  const p = pools.find(x => x.id === poolId)!
  return { ...p, takenSeats: [...p.takenSeats], prizes: p.prizes.map(pr => ({ ...pr })) }
}

// ---------------------------------------------------------------
// 連莊爆賞
// ---------------------------------------------------------------
const streakRuns = new Map<string, StreakRun>()

export function startStreak(poolId: string): StreakRun {
  const pool = pools.find(p => p.id === poolId)!
  const run: StreakRun = {
    runId: `s-${Date.now()}`,
    poolId,
    entryCost: pool.ticketPrice,
    items: [],
    heldValue: 0,
    drawnSeats: [],
    status: 'live'
  }
  streakRuns.set(run.runId, run)
  return { ...run, items: [...run.items] }
}

export function streakDraw(runId: string, seat: number): StreakRun {
  const run = streakRuns.get(runId)!
  const pool = pools.find(p => p.id === run.poolId)!
  const alive = pool.prizes.filter(p => p.remaining > 0)
  const bag: PoolPrize[] = alive.flatMap(p => Array(p.remaining).fill(p))
  const prize = bag[Math.floor(Math.random() * bag.length)]

  prize.remaining--
  pool.remainingTickets--
  pool.takenSeats.push(seat)
  run.drawnSeats.push(seat)

  if (prize.tier === 'BUST') {
    /* 爆掉：暫持獎品全數沒收（流入賣家下一池，不回本池以保籤序可驗證），
       但改發保底卡 —— 確保每次入場至少帶走一張卡，維持「必得商品」的對價關係。 */
    run.items = [{ ticketSeq: seat, tier: 'BUST', card: prize.card }]
    run.heldValue = prize.card.refPrice
    run.status = 'busted'
  } else {
    run.items.push({ ticketSeq: seat, tier: prize.tier, card: prize.card })
    run.heldValue += prize.card.refPrice
  }
  if (pool.remainingTickets <= 0) pool.status = 'sold_out'
  return { ...run, items: [...run.items] }
}

/** 收手落袋，把暫持獎品轉成正式抽選結果 */
export function bankStreak(runId: string): DrawResult {
  const run = streakRuns.get(runId)!
  run.status = 'banked'
  return { drawId: `d-${run.runId}`, poolId: run.poolId, items: [...run.items], cost: run.entryCost }
}

// ---------------------------------------------------------------
// 尾籤競標
// ---------------------------------------------------------------
const YOU = 'VD-3F2A'
const auctionLots: AuctionLot[] = [
  { id: 'lot1', poolId: 'p7', seat: 78, startBid: 300, currentBid: 1250, bidCount: 7, topBidder: 'VD-A8**', youAreTop: false, endsAt: 0, status: 'live' },
  { id: 'lot2', poolId: 'p7', seat: 79, startBid: 300, currentBid: 800, bidCount: 3, topBidder: 'VD-11**', youAreTop: false, endsAt: 0, status: 'live' },
  { id: 'lot3', poolId: 'p7', seat: 80, startBid: 300, currentBid: 300, bidCount: 0, topBidder: null, youAreTop: false, endsAt: 0, status: 'live' }
]
// endsAt 於首次讀取時才錨定，避免模組載入時間與實際開啟時間落差
let auctionAnchored = false

export function listLots(poolId: string): AuctionLot[] {
  if (!auctionAnchored) {
    const now = Date.now()
    auctionLots[0].endsAt = now + 3 * 60_000
    auctionLots[1].endsAt = now + 8 * 60_000
    auctionLots[2].endsAt = now + 15 * 60_000
    auctionAnchored = true
  }
  const now = Date.now()
  for (const l of auctionLots) if (now >= l.endsAt) l.status = 'ended'
  return auctionLots.filter(l => l.poolId === poolId).map(l => ({ ...l }))
}

/** 出價。回傳被退還的金額（若你先前是最高出價者，舊出價全額退還） */
export function placeBid(lotId: string, amount: number): { lot: AuctionLot; refunded: number } {
  const lot = auctionLots.find(l => l.id === lotId)!
  const refunded = lot.youAreTop ? lot.currentBid : 0
  lot.currentBid = amount
  lot.bidCount++
  lot.topBidder = YOU
  lot.youAreTop = true
  // 接近結束時出價自動延長 60 秒，避免「最後一秒偷襲」
  const now = Date.now()
  if (lot.endsAt - now < 60_000) lot.endsAt = now + 60_000
  return { lot: { ...lot }, refunded }
}

/** 模擬對手加價（僅 mock 用；正式版由後端 / SSE 推播） */
export function rivalBid(lotId: string): AuctionLot | null {
  const lot = auctionLots.find(l => l.id === lotId)
  if (!lot || lot.status === 'ended' || lot.currentBid > 4000) return null
  const bump = 100 + Math.floor(Math.random() * 4) * 50
  lot.currentBid += bump
  lot.bidCount++
  lot.topBidder = Math.random() > 0.5 ? 'VD-A8**' : 'VD-7C**'
  lot.youAreTop = false
  const now = Date.now()
  if (lot.endsAt - now < 60_000) lot.endsAt = now + 60_000
  return { ...lot }
}

/**
 * mock 抽選：玩家親手選籤位（seats），依剩餘數加權隨機決定賞別。
 * 僅供前端展示；正式版籤位→實體卡（cert 編號）的對應於開賣前預洗封存，後端只查表。
 */
export function mockDraw(poolId: string, seats: number[]): DrawResult {
  const pool = pools.find(p => p.id === poolId)!
  const items: DrawResult['items'] = []

  for (const seat of seats) {
    const alive = pool.prizes.filter(p => p.tier !== 'LAST' || pool.mode === 'muteki')
      .filter(p => p.remaining > 0)
    const bag: PoolPrize[] = alive.flatMap(p => Array(p.remaining).fill(p))
    const prize = bag[Math.floor(Math.random() * bag.length)]
    prize.remaining--
    pool.remainingTickets--
    pool.takenSeats.push(seat)
    items.push({ ticketSeq: seat, tier: prize.tier, card: prize.card })

    // 指定賞：抽中指定賞 → 加送最後賞、整池結束
    if (pool.mode === 'shitei' && prize.tier === pool.shiteiTier) {
      const last = pool.prizes.find(p => p.tier === 'LAST' && p.remaining > 0)
      if (last) {
        last.remaining--
        items.push({ ticketSeq: seat, tier: 'LAST', card: last.card, bonus: true })
      }
      pool.status = 'sold_out'
      break
    }

    // 經典賞：抽走最後一籤 → 加送最後賞
    if (pool.mode === 'classic' && pool.remainingTickets <= 0) {
      const last = pool.prizes.find(p => p.tier === 'LAST' && p.remaining > 0)
      if (last) {
        last.remaining--
        items.push({ ticketSeq: seat, tier: 'LAST', card: last.card, bonus: true })
      }
    }
  }

  if (pool.remainingTickets <= 0) pool.status = 'sold_out'
  return { drawId: `d-${Date.now()}`, poolId, items, cost: seats.length * pool.ticketPrice }
}

export const userPrizes: UserPrize[] = [
  { id: 'up1', card: cards[1], tier: 'B', status: 'stashed', wonAt: '2026-08-05T20:11:00+08:00', stashExpiresAt: '2026-11-03' },
  { id: 'up2', card: cards[4], tier: 'D', status: 'stashed', wonAt: '2026-08-05T20:11:00+08:00', stashExpiresAt: '2026-11-03' },
  { id: 'up3', card: cards[5], tier: 'C', status: 'shipped', wonAt: '2026-07-20T14:02:00+08:00', stashExpiresAt: '—' },
  { id: 'up4', card: cards[16], tier: 'A', status: 'stashed', wonAt: '2026-08-09T18:40:00+08:00', stashExpiresAt: '2026-11-07' },
  { id: 'up5', card: cards[19], tier: 'D', status: 'ship_requested', wonAt: '2026-08-10T11:05:00+08:00', stashExpiresAt: '2026-11-08' },
  { id: 'up6', card: cards[21], tier: 'C', status: 'stashed', wonAt: '2026-08-11T09:30:00+08:00', stashExpiresAt: '2026-11-09' }
]

export const ledger: LedgerEntry[] = [
  { id: 'l4', delta: -1950, balanceAfter: 1150, type: 'draw', note: '朱紫 SAR 精選 ×3', createdAt: '2026-08-05 20:11' },
  { id: 'l3', delta: +2000, balanceAfter: 3100, type: 'topup', note: '綠界儲值', createdAt: '2026-08-05 20:08' },
  { id: 'l2', delta: -360, balanceAfter: 1100, type: 'draw', note: '經典促販卡 ×3', createdAt: '2026-07-20 14:02' },
  { id: 'l1', delta: +1460, balanceAfter: 1460, type: 'topup', note: '綠界儲值', createdAt: '2026-07-20 13:59' }
]

export const winners: WinnerEvent[] = [
  { user: 'VD-3F**', poolTitle: '朱紫 SAR 精選', tier: 'A', cardName: '噴火龍 ex SAR', at: '2 分鐘前' },
  { user: 'VD-A8**', poolTitle: '經典促販卡 大亂鬥', tier: 'B', cardName: '寶可夢中心 木木梟', at: '9 分鐘前' },
  { user: 'VD-11**', poolTitle: '朱紫 SAR 精選', tier: 'C', cardName: '夢幻 SAR', at: '17 分鐘前' },
  { user: 'VD-C2**', poolTitle: '莉莉艾 無敵賞', tier: 'LAST', cardName: '莉莉艾 SR', at: '1 小時前' },
  { user: 'VD-7Q**', poolTitle: '皮卡丘 指定賞挑戰', tier: 'D', cardName: '妙蛙種子 AR', at: '1 小時前' },
  { user: 'VD-9K**', poolTitle: '夢幻 連莊爆賞', tier: 'C', cardName: '三合一磁怪 V', at: '2 小時前' },
  { user: 'VD-4M**', poolTitle: '噴火龍 尾籤競標', tier: 'A', cardName: '莉莉艾 SR', at: '3 小時前' }
]
