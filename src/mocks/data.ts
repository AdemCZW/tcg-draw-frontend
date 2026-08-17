import type { Pool, CardItem, Listing, DrawResult, UserPrize, LedgerEntry, WinnerEvent, PoolPrize, StreakRun, AuctionLot, Seller, Escrow, Tier } from '@/types/models'

// 卡圖先用漸層佔位；正式版換 R2 實拍圖 URL
const ph = (hue: number) => `placeholder:${hue}`

const cards: CardItem[] = [
  /* 高階密卡（SAR / UR 金卡）。artId 指定 TCGdex 的確切編號 ——
     不指定的話卡名搜尋只會拿到同名的普卡，展示不出金卡的樣子。
     市值抓的是 2025 年前後日版單卡的概略行情，示意用。 */
  { id: 'c1', name: '噴火龍 ex UR', setCode: 'sv4a', cardNo: '349/190', language: 'JP', grader: 'PSA', grade: 10, certNo: '82345671', image: '', artId: 'SV4a-349', refPrice: 42000 },
  { id: 'c2', name: '奇樹 SAR', setCode: 'sv4a', cardNo: '350/190', language: 'JP', grader: 'PSA', grade: 10, certNo: '82345672', image: '', artId: 'SV4a-350', refPrice: 28000 },
  { id: 'c3', name: '太樂巴戈斯 ex UR', setCode: 'sv8a', cardNo: '237/187', language: 'JP', grader: 'PSA', grade: 10, certNo: '82345673', image: '', artId: 'SV8a-237', refPrice: 19800 },
  { id: 'c4', name: '牡丹 SAR', setCode: 'sv4a', cardNo: '354/190', language: 'JP', grader: 'BGS', grade: 9.5, certNo: '0015678901', image: '', artId: 'SV4a-354', refPrice: 15600 },
  { id: 'c5', name: '皮卡丘 ex SAR', setCode: 'sv8a', cardNo: '236/187', language: 'JP', grader: 'PSA', grade: 10, certNo: '82345675', image: '', artId: 'SV8a-236', refPrice: 12800 },
  { id: 'c6', name: '噴火龍 ex SAR', setCode: 'sv3', cardNo: '125/108', language: 'JP', grader: 'PSA', grade: 9, certNo: '82345676', image: '', artId: 'SV3-125', refPrice: 9800 },
  { id: 'c7', name: '沙奈朵 ex UR', setCode: 'sv4a', cardNo: '348/190', language: 'JP', grader: 'PSA', grade: 10, certNo: '82345677', image: '', artId: 'SV4a-348', refPrice: 7600 },
  { id: 'c8', name: '夢幻 ex UR', setCode: 'sv4a', cardNo: '347/190', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV4a-347', refPrice: 6400 },
  { id: 'c9', name: '月亮伊布 ex SAR', setCode: 'sv8a', cardNo: '217/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-217', refPrice: 5400 },
  /* 保底卡：價值必須低於票價，否則「輸了反而划算」會破壞獎池 */
  { id: 'c10', name: '謎擬Ｑ SAR（保底）', setCode: 'sv4a', cardNo: '341/190', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV4a-341', refPrice: 200 },
  // 以下為擴充卡池，象徵性測試各玩法在「多樣卡片」下的顯示與抽取
  { id: 'c11', name: '多龍巴魯托 ex SAR', setCode: 'sv8a', cardNo: '221/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-221', refPrice: 4200 },
  { id: 'c12', name: '伊布 ex SAR', setCode: 'sv8a', cardNo: '223/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-223', refPrice: 3800 },
  { id: 'c13', name: '猛雷鼓 ex SAR', setCode: 'sv8a', cardNo: '222/187', language: 'JP', grader: 'PSA', grade: 10, certNo: '82345680', image: '', artId: 'SV8a-222', refPrice: 3400 },
  { id: 'c14', name: '太陽伊布 ex SAR', setCode: 'sv8a', cardNo: '211/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-211', refPrice: 2600 },
  { id: 'c15', name: '大比鳥 ex SAR', setCode: 'sv3', cardNo: '128/108', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV3-128', refPrice: 2200 },
  { id: 'c16', name: '派帕 SAR', setCode: 'sv4a', cardNo: '353/190', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV4a-353', refPrice: 1800 },
  { id: 'c17', name: '幸福蛋 ex SAR', setCode: 'sv6', cardNo: '121/101', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV6-121', refPrice: 1500 },
  { id: 'c18', name: '八朔 SAR', setCode: 'sv6', cardNo: '124/101', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV6-124', refPrice: 1200 },
  { id: 'c19', name: '多龍巴魯托 ex', setCode: 'sv6', cardNo: '120/101', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV6-120', refPrice: 980 },
  { id: 'c20', name: '波琵 SAR', setCode: 'sv3', cardNo: '131/108', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV3-131', refPrice: 760 },
  { id: 'c21', name: '仙子伊布 ex', setCode: 'sv8a', cardNo: '212/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-212', refPrice: 620 },
  { id: 'c22', name: '雷伊布 ex', setCode: 'sv8a', cardNo: '209/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-209', refPrice: 520 },
  { id: 'c23', name: '水伊布 ex', setCode: 'sv8a', cardNo: '205/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-205', refPrice: 460 },
  { id: 'c24', name: '火伊布 ex', setCode: 'sv8a', cardNo: '202/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-202', refPrice: 420 },
  { id: 'c25', name: '葉伊布 ex', setCode: 'sv8a', cardNo: '200/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-200', refPrice: 380 },
  { id: 'c26', name: '冰伊布 ex', setCode: 'sv8a', cardNo: '206/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-206', refPrice: 340 },
  { id: 'c27', name: '鐵臂膀 ex', setCode: 'sv8a', cardNo: '210/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-210', refPrice: 300 },
  { id: 'c28', name: '差不多娃娃 ex', setCode: 'sv8a', cardNo: '215/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-215', refPrice: 240 },
  { id: 'c29', name: '桃歹郎 ex', setCode: 'sv8a', cardNo: '219/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-219', refPrice: 180 },
  { id: 'c30', name: '海豚俠 ex', setCode: 'sv8a', cardNo: '207/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-207', refPrice: 150 },
  { id: 'c31', name: '砂鐵蜥 ex', setCode: 'sv8a', cardNo: '216/187', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV8a-216', refPrice: 120 }
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
/* 市場掛單。價格用「相對市值的折數」算出來，不寫死絕對值 ——
   寫死很容易跟卡片索引對不起來，變成 PSA 10 的 SAR 掛市值一折這種假資料。
   分佈刻意從 -14% 到 +6% 都有：市場的重點是價差看得見，不是每張都划算。 */
const mk = (id: string, c: CardItem, ratio: number, sellerId: string, sellerName: string, listedAt: string): Listing => ({
  id, card: c, price: Math.round((c.refPrice * ratio) / 10) * 10,
  sellerId, sellerName, listedAt, status: 'live'
})
export const listings: Listing[] = [
  mk('l1', cards[1], 0.94, 'u-8823', 'VD-8823', '2 小時前'),
  mk('l2', cards[5], 0.88, 'u-41A0', 'VD-41A0', '5 小時前'),
  mk('l3', cards[3], 1.06, 's1', '保庫堂', '昨天'),
  mk('l4', cards[10], 0.9, 'u-C3E0', 'VD-C3E0', '昨天'),
  mk('l5', cards[2], 0.92, 'u-77B1', 'VD-77B1', '2 天前'),
  mk('l6', cards[6], 1.04, 'u-2D9F', 'VD-2D9F', '2 天前'),
  mk('l7', cards[0], 1.04, 's3', '關都卡舖', '3 天前'),
  mk('l8', cards[12], 0.86, 'u-5E12', 'VD-5E12', '3 天前'),
  mk('l9', cards[21], 0.95, 'u-9A44', 'VD-9A44', '4 天前'),
  mk('l10', cards[15], 0.97, 'u-B071', 'VD-B071', '5 天前'),
  mk('l11', cards[23], 0.91, 'u-3C88', 'VD-3C88', '6 天前'),
  mk('l12', cards[16], 1.02, 'u-6F20', 'VD-6F20', '6 天前')
]

export const sellers: Seller[] = [
  {
    /* 平台自營。官方池的賣家就是平台自己 —— 沒有托管，因為沒有第三方要防。 */
    id: 's0', handle: 'vaultdraw', name: 'VaultDraw 官方', tier: 'trusted', avatarHue: 14,
    joinedAt: '2025-01-01', bio: '平台自營池。全數由 VaultDraw 進貨、鑑定、直接出貨，糾紛由平台全責處理。',
    stats: {
      poolsRun: 310, cardsShipped: 12480, avgShipDays: 1.2, disputeRate: 0.05,
      advertisedTopRate: 3.0, actualTopRate: 3.0, drawsSettled: 24600
    },
    pastPrizes: [
      { cardName: '噴火龍 ex UR', artId: 'SV4a-349', tier: 'A', poolTitle: '官方旗艦場 #58', wonAt: '2026-08-10', winner: 'VD-A2**' },
      { cardName: '太樂巴戈斯 ex UR', artId: 'SV8a-237', tier: 'LAST', poolTitle: '官方旗艦場 #55', wonAt: '2026-07-26', winner: 'VD-77**' }
    ]
  },
  {
    id: 's1', handle: 'vaultkeeper', name: '保庫堂', tier: 'trusted', avatarHue: 28,
    joinedAt: '2025-03-11', bio: 'PSA / BGS 鑑定卡專門。開池前全數實拍上架，出貨附鑑定證書照。',
    stats: {
      poolsRun: 142, cardsShipped: 3810, avgShipDays: 1.8, disputeRate: 0.2,
      advertisedTopRate: 2.5, actualTopRate: 2.6, drawsSettled: 8420
    },
    pastPrizes: [
      { cardName: '噴火龍 ex UR', artId: 'SV4a-349', tier: 'A', poolTitle: '朱紫 SAR 精選 第 9 彈', wonAt: '2026-07-28', winner: 'VD-7F**' },
      { cardName: '奇樹 SAR', artId: 'SV4a-350', tier: 'LAST', poolTitle: '閃色寶藏 尾張', wonAt: '2026-07-14', winner: 'VD-21**' },
      { cardName: '太樂巴戈斯 ex UR', artId: 'SV8a-237', tier: 'A', poolTitle: '太晶慶典 精選', wonAt: '2026-06-30', winner: 'VD-C4**' }
    ]
  },
  {
    id: 's2', handle: 'promo_lab', name: '促販實驗室', tier: 'verified', avatarHue: 260,
    joinedAt: '2026-01-20', bio: '專收日版促販卡與 AR，小池快開快抽。',
    stats: {
      poolsRun: 23, cardsShipped: 402, avgShipDays: 3.1, disputeRate: 1.1,
      advertisedTopRate: 4.0, actualTopRate: 3.8, drawsSettled: 910
    },
    pastPrizes: [
      { cardName: '皮卡丘 ex SAR', artId: 'SV8a-236', tier: 'A', poolTitle: '促販卡 大亂鬥 第 6 回', wonAt: '2026-07-22', winner: 'VD-9A**' },
      { cardName: '謎擬Ｑ SAR', artId: 'SV4a-341', tier: 'B', poolTitle: '促販卡 大亂鬥 第 5 回', wonAt: '2026-06-18', winner: 'VD-3D**' }
    ]
  },
  {
    id: 's3', handle: 'kanto_cards', name: '關都卡舖', tier: 'verified', avatarHue: 140,
    joinedAt: '2025-11-02', bio: '實體店第 8 年，線上同步開池。台北可自取。',
    stats: {
      poolsRun: 67, cardsShipped: 1520, avgShipDays: 2.4, disputeRate: 0.6,
      advertisedTopRate: 3.0, actualTopRate: 3.1, drawsSettled: 3260
    },
    pastPrizes: [
      { cardName: '沙奈朵 ex UR', artId: 'SV4a-348', tier: 'A', poolTitle: '關都精選 夏季場', wonAt: '2026-08-02', winner: 'VD-55**' },
      { cardName: '多龍巴魯托 ex SAR', artId: 'SV8a-221', tier: 'B', poolTitle: '變幻假面 開箱', wonAt: '2026-07-09', winner: 'VD-E1**' }
    ]
  },
  {
    /* 高單價、低量的精品賣家：樣本數少，所以實際率的信賴區間寬 —— 
       頁面上要標示樣本數，不然「4.2% 命中」看起來會比保庫堂的 2.6% 更好，
       但那只是還沒開夠多池。 */
    id: 's5', handle: 'grade10_vault', name: '滿分保庫', tier: 'trusted', avatarHue: 46,
    joinedAt: '2025-08-19', bio: '只收 PSA 10。單池 20 籤以內，每張都附鑑定編號可自行查證。',
    stats: {
      poolsRun: 31, cardsShipped: 590, avgShipDays: 1.5, disputeRate: 0.1,
      advertisedTopRate: 4.0, actualTopRate: 4.2, drawsSettled: 620
    },
    pastPrizes: [
      { cardName: '噴火龍 ex SAR', artId: 'SV3-125', tier: 'A', poolTitle: '滿分場 #29', wonAt: '2026-08-05', winner: 'VD-B8**' },
      { cardName: '牡丹 SAR', artId: 'SV4a-354', tier: 'LAST', poolTitle: '滿分場 #27', wonAt: '2026-07-19', winner: 'VD-4C**' }
    ]
  },
  {
    /* 刻意放一個「實際率低於標示」的賣家。
       如果每個賣家的數字都漂亮，這組數字就沒有資訊量、也不會有人相信。
       願意把難看的數字也顯示出來，整套統計才有公信力 —— 這是「公開實際中獎率」
       這件事的重點，不是拿來當行銷徽章。 */
    id: 's6', handle: 'nangang_box', name: '南港開箱王', tier: 'verified', avatarHue: 8,
    joinedAt: '2026-02-14', bio: '大量快開，主打銅板價入門池。出貨較慢請見諒。',
    stats: {
      poolsRun: 88, cardsShipped: 2140, avgShipDays: 4.6, disputeRate: 2.3,
      advertisedTopRate: 3.5, actualTopRate: 2.7, drawsSettled: 5180
    },
    pastPrizes: [
      { cardName: '猛雷鼓 ex SAR', artId: 'SV8a-222', tier: 'A', poolTitle: '銅板場 #71', wonAt: '2026-07-30', winner: 'VD-6F**' }
    ]
  },
  {
    id: 's4', handle: 'newbie_seller', name: '新手賣家', tier: 'pending', avatarHue: 200,
    joinedAt: '2026-08-09', bio: '剛註冊，等待身分驗證中。',
    stats: {
      poolsRun: 0, cardsShipped: 0, avgShipDays: 0, disputeRate: 0,
      advertisedTopRate: 0, actualTopRate: 0, drawsSettled: 0
    },
    pastPrizes: []
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
    /* 官方旗艦池：平台自營、直接出貨，沒有托管期。
       獎項規格刻意做得比商家池好一階 —— 官方池的角色是「基準線」，
       讓買家知道這個平台的池應該長什麼樣。 */
    sellerId: 's0',
    origin: 'official',
    id: 'p12',
    title: '官方旗艦場 #59 · 閃色寶藏 精選',
    cover: ph(14),
    mode: 'classic',
    ticketPrice: 1280,
    totalTickets: 100,
    remainingTickets: 58,
    takenSeats: seatsOf(100, 42),
    status: 'open',
    commitHash: 'a91c3f7e5d2b8064ff2233445566778899aabbccddeeff00112233445566aabb',
    clientSeedSource: 'BTC block #920604 hash',
    openedAt: '2026-08-16T18:00:00+08:00',
    escrow: { held: 0, releaseAfterShipDays: 0, released: 53760 },
    prizes: [
      { id: 'pr45', tier: 'A', card: cards[0], total: 1, remaining: 1 },
      { id: 'pr46', tier: 'B', card: cards[2], total: 2, remaining: 1 },
      { id: 'pr47', tier: 'C', card: cards[6], total: 6, remaining: 3 },
      { id: 'pr48a', tier: 'D', card: cards[13], total: 45, remaining: 26 },
      { id: 'pr48b', tier: 'D', card: cards[20], total: 46, remaining: 27 },
      { id: 'pr49', tier: 'LAST', card: cards[1], total: 1, remaining: 1 }
    ]
  },
  {
    /* 官方的銅板池：低門檻讓新使用者第一次抽有個安全的地方 */
    sellerId: 's0',
    origin: 'official',
    id: 'p13',
    title: '官方入門場 · 一百點開一張',
    cover: ph(200),
    mode: 'battle',
    ticketPrice: 100,
    totalTickets: 150,
    remainingTickets: 96,
    takenSeats: seatsOf(150, 54),
    status: 'open',
    commitHash: 'ff8811aa22bb33cc44dd55ee66770099aabbccddeeff112233445566778899aa',
    clientSeedSource: 'BTC block #920611 hash',
    openedAt: '2026-08-17T09:00:00+08:00',
    escrow: { held: 0, releaseAfterShipDays: 0, released: 5400 },
    prizes: [
      { id: 'pr50', tier: 'A', card: cards[14], total: 1, remaining: 1 },
      { id: 'pr51', tier: 'B', card: cards[18], total: 3, remaining: 2 },
      { id: 'pr52', tier: 'C', card: cards[22], total: 20, remaining: 12 },
      { id: 'pr53a', tier: 'D', card: cards[28], total: 63, remaining: 41 },
      { id: 'pr53b', tier: 'D', card: cards[30], total: 63, remaining: 40 }
    ]
  },
  {
    sellerId: 's1',
    origin: 'merchant',
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
    origin: 'personal',
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
    origin: 'merchant',
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
    origin: 'personal',
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
    origin: 'merchant',
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
    origin: 'merchant',
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
    origin: 'merchant',
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
    origin: 'personal',
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
  },
  {
    /* 滿分保庫的精品池：籤少、單價高、每張都有鑑定編號。
       這種池的價值主張是「可查證」——買家能拿 certNo 自己去 PSA 網站對。 */
    sellerId: 's5',
    origin: 'merchant',
    id: 'p9',
    title: '滿分場 #30 · 全 PSA 10',
    cover: ph(46),
    mode: 'classic',
    ticketPrice: 4800,
    totalTickets: 20,
    remainingTickets: 11,
    takenSeats: Array.from({ length: 9 }, (_, i) => i + 1),
    status: 'open',
    commitHash: '9a1f4c7e2b8d6053ff11aa22bb33cc44dd55ee66ff7788990011223344556677',
    clientSeedSource: 'BTC block #920512 hash',
    openedAt: '2026-08-15T20:00:00+08:00',
    escrow: escrowOf(9, 4800),
    prizes: [
      { id: 'pr31', tier: 'A', card: cards[0], total: 1, remaining: 1 },
      { id: 'pr32', tier: 'B', card: cards[2], total: 1, remaining: 1 },
      { id: 'pr33', tier: 'C', card: cards[5], total: 3, remaining: 2 },
      { id: 'pr34', tier: 'D', card: cards[12], total: 15, remaining: 7 },
      { id: 'pr35', tier: 'LAST', card: cards[3], total: 1, remaining: 1 }
    ]
  },
  {
    /* 南港開箱王的量產池：便宜、籤多、獎項普通。
       這個賣家的實際中獎率低於標示，賣家頁上會看得到 —— 刻意留著。 */
    sellerId: 's6',
    origin: 'personal',
    id: 'p10',
    title: '銅板場 #72 · 快開快抽',
    cover: ph(8),
    mode: 'classic',
    ticketPrice: 60,
    totalTickets: 120,
    remainingTickets: 74,
    takenSeats: Array.from({ length: 46 }, (_, i) => i + 1),
    status: 'open',
    commitHash: '5e2b8d6039a1f4c7ff99aa88bb77cc66dd55ee44ff3322110099887766554433',
    clientSeedSource: 'BTC block #920533 hash',
    openedAt: '2026-08-16T11:30:00+08:00',
    escrow: escrowOf(46, 60),
    prizes: [
      { id: 'pr36', tier: 'A', card: cards[12], total: 1, remaining: 1 },
      { id: 'pr37', tier: 'B', card: cards[16], total: 2, remaining: 1 },
      { id: 'pr38', tier: 'C', card: cards[20], total: 17, remaining: 10 },
      { id: 'pr39a', tier: 'D', card: cards[28], total: 50, remaining: 31 },
      { id: 'pr39b', tier: 'D', card: cards[29], total: 50, remaining: 31 }
    ]
  },
  {
    /* 關都卡舖的已完抽池：賣家頁要有「過去的池」才看得出經營時間。 */
    sellerId: 's3',
    origin: 'merchant',
    id: 'p11',
    title: '關都精選 夏季場（已完抽）',
    cover: ph(140),
    mode: 'classic',
    ticketPrice: 880,
    totalTickets: 60,
    remainingTickets: 0,
    takenSeats: Array.from({ length: 60 }, (_, i) => i + 1),
    status: 'revealed',
    commitHash: '77aa33bb99cc11dd55ee22ff8800112233445566778899aabbccddeeff001122',
    clientSeedSource: 'BTC block #919804 hash',
    openedAt: '2026-07-25T19:00:00+08:00',
    escrow: { held: 0, releaseAfterShipDays: 7, released: 52800 },
    prizes: [
      { id: 'pr40', tier: 'A', card: cards[6], total: 1, remaining: 0 },
      { id: 'pr41', tier: 'B', card: cards[10], total: 2, remaining: 0 },
      { id: 'pr42', tier: 'C', card: cards[14], total: 12, remaining: 0 },
      { id: 'pr43', tier: 'D', card: cards[24], total: 45, remaining: 0 },
      { id: 'pr44', tier: 'LAST', card: cards[1], total: 1, remaining: 0 }
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

  /* 使用者自己開的池一律是個人池 —— 要升級成商家池得先完成營業登記驗證，
     不是開池表單上可以自己勾的選項。 */
  const pool: Pool = {
    sellerId: input.sellerId,
    origin: 'personal',
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
