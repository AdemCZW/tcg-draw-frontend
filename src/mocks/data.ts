import type { Pool, CardItem, Listing, DrawResult, UserPrize, LedgerEntry, WinnerEvent, PoolPrize, Seller, Escrow, Tier } from '@/types/models'

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
  { id: 'c10', name: '謎擬Ｑ SAR', setCode: 'sv4a', cardNo: '341/190', language: 'JP', grader: 'RAW', grade: null, certNo: null, image: '', artId: 'SV4a-341', refPrice: 200 },
  // 以下為擴充卡池，象徵性測試玩法在「多樣卡片」下的顯示與抽取
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
 *  p1 classic  87.6%    p2 classic  87.5%    p3 muteki 72.6%（已完抽）
 *  p4 shitei   83.8%    p5 classic  90.4%    p8 classic  84.6%（低價入門池）
 *
 * shitei 不能用「獎池總值 ÷ 票收」直接算：抽中指定賞就結束整池，
 * 期望只賣出約一半的籤，直接除會嚴重高估支出。
 *
 * p6（連莊爆賞）與 p7（尾籤競標）已隨那兩個玩法一起移除。
 *
 * 各池 prizes 加總 = totalTickets；classic/shitei 的 LAST 為額外贈獎不佔籤位。
 */
/* 市場掛單。價格用「相對市值的折數」算出來，不寫死絕對值 ——
   寫死很容易跟卡片索引對不起來，變成 PSA 10 的 SAR 掛市值一折這種假資料。
   分佈刻意從 -14% 到 +6% 都有：市場的重點是價差看得見，不是每張都划算。 */
/* 交付方式預設由賣家類型推導：
   玩家（u-*）掛的多半是抽到之後沒提領的卡，還在保管庫裡，成交只是過戶；
   商家（s*）掛的是自己的庫存，要實際寄出。
   少數玩家會先提領再上架，所以個別掛單可以覆寫成 'ship'。 */
const mk = (
  id: string, c: CardItem, ratio: number,
  sellerId: string, sellerName: string, listedAt: string,
  delivery?: 'vault' | 'ship'
): Listing => ({
  // mock 的掛單價從參考價推 —— 這是造假資料，不是執行期的算式
  id, card: c, price: Math.round(((c.refPrice ?? 0) * ratio) / 10) * 10,
  sellerId, sellerName, listedAt, status: 'live',
  delivery: delivery ?? (sellerId.startsWith('u-') ? 'vault' : 'ship')
})
export const listings: Listing[] = [
  mk('l1', cards[1], 0.94, 'u-8823', 'VD-8823', '2 小時前'),
  mk('l2', cards[5], 0.88, 'u-41A0', 'VD-41A0', '5 小時前'),
  mk('l3', cards[3], 1.06, 's1', '保庫堂', '昨天'),
  mk('l4', cards[10], 0.9, 'u-C3E0', 'VD-C3E0', '昨天'),
  mk('l5', cards[2], 0.92, 'u-77B1', 'VD-77B1', '2 天前', 'ship'),
  mk('l6', cards[6], 1.04, 'u-2D9F', 'VD-2D9F', '2 天前'),
  mk('l7', cards[0], 1.04, 's3', '關都卡舖', '3 天前'),
  mk('l8', cards[12], 0.86, 'u-5E12', 'VD-5E12', '3 天前'),
  mk('l9', cards[21], 0.95, 'u-9A44', 'VD-9A44', '4 天前'),
  mk('l10', cards[15], 0.97, 'u-B071', 'VD-B071', '5 天前'),
  mk('l11', cards[23], 0.91, 'u-3C88', 'VD-3C88', '6 天前', 'ship'),
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
    clientSeedSource: 'drand:5620604',
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
    mode: 'classic',
    ticketPrice: 100,
    totalTickets: 150,
    remainingTickets: 96,
    takenSeats: seatsOf(150, 54),
    status: 'open',
    commitHash: 'ff8811aa22bb33cc44dd55ee66770099aabbccddeeff112233445566778899aa',
    clientSeedSource: 'drand:5620611',
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
    clientSeedSource: 'drand:5620000',
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
    mode: 'classic',
    ticketPrice: 120,
    totalTickets: 40,
    remainingTickets: 40,
    takenSeats: [],
    status: 'open',
    commitHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    clientSeedSource: 'drand:5620144',
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
    clientSeedSource: 'drand:5618800',
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
    clientSeedSource: 'drand:5620302',
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
    mode: 'classic',
    ticketPrice: 8300,
    totalTickets: 2,
    remainingTickets: 2,
    takenSeats: [],
    status: 'open',
    commitHash: 'ace1ace2ace3ace4ace5ace6ace7ace8ace9ace0ace1ace2ace3ace4ace5ace6',
    clientSeedSource: 'drand:5620310',
    openedAt: '2026-08-11T12:00:00+08:00',
    escrow: escrowOf(0, 8300),
    prizes: [
      { id: 'pr16', tier: 'A', card: cards[3], total: 1, remaining: 1 },
      { id: 'pr17', tier: 'B', card: cards[1], total: 1, remaining: 1 }
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
    clientSeedSource: 'drand:5620418',
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
    clientSeedSource: 'drand:5620512',
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
    clientSeedSource: 'drand:5620533',
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
    clientSeedSource: 'drand:5619804',
    openedAt: '2026-07-25T19:00:00+08:00',
    escrow: { held: 0, releaseAfterShipDays: 7, released: 52800 },
    prizes: [
      { id: 'pr40', tier: 'A', card: cards[6], total: 1, remaining: 0 },
      { id: 'pr41', tier: 'B', card: cards[10], total: 2, remaining: 0 },
      { id: 'pr42', tier: 'C', card: cards[14], total: 12, remaining: 0 },
      { id: 'pr43', tier: 'D', card: cards[24], total: 45, remaining: 0 },
      { id: 'pr44', tier: 'LAST', card: cards[1], total: 1, remaining: 0 }
    ]
  },
  {
    /* 促販實驗室的小池：36 籤、開得快也賣得快。
       列表上要有「快滿了」的池，不然每個池看起來都像剛開沒人抽。
       獎品總值 7,980 ÷ 票收 9,000 = 88.7%。 */
    sellerId: 's2',
    origin: 'personal',
    id: 'p14',
    title: '促販卡 大亂鬥 第 7 回',
    cover: ph(260),
    mode: 'classic',
    ticketPrice: 250,
    totalTickets: 36,
    remainingTickets: 25,
    takenSeats: seatsOf(36, 11, 5),
    status: 'open',
    commitHash: '4d17b9e0c8a25f36aa11bb22cc33dd44ee55ff66007711882299aa33bb44cc55',
    clientSeedSource: 'drand:5620588',
    openedAt: '2026-08-18T21:00:00+08:00',
    escrow: escrowOf(11, 250),
    prizes: [
      { id: 'pr54', tier: 'A', card: cards[15], total: 1, remaining: 1 },
      { id: 'pr55', tier: 'B', card: cards[17], total: 1, remaining: 1 },
      { id: 'pr56', tier: 'C', card: cards[23], total: 3, remaining: 2 },
      { id: 'pr57', tier: 'D', card: cards[30], total: 31, remaining: 21 }
    ]
  },
  {
    /* 250 籤的量產大池。籤牆一次要畫 250 格，這是滾動與點擊區的壓力測試對象 ——
       只有小池的話，效能問題要等上線才會被發現。
       LAST 賞照慣例不佔籤位（完抽時加贈），所以 prizes 加總會比 totalTickets 多 1。
       獎品總值 75,120 ÷ 票收 87,500 = 85.9%。 */
    sellerId: 's3',
    origin: 'merchant',
    id: 'p15',
    title: '關都精選 · 伊布家族 250 抽',
    cover: ph(140),
    mode: 'classic',
    ticketPrice: 350,
    totalTickets: 250,
    remainingTickets: 132,
    takenSeats: seatsOf(250, 118),
    status: 'open',
    commitHash: '61c9a3f4d70b28e5ff44dd33cc22bb11aa009988776655443322110099887766',
    clientSeedSource: 'drand:5620440',
    openedAt: '2026-08-13T10:00:00+08:00',
    escrow: escrowOf(118, 350),
    prizes: [
      { id: 'pr58', tier: 'LAST', card: cards[4], total: 1, remaining: 1 },
      { id: 'pr59', tier: 'A', card: cards[8], total: 1, remaining: 1 },
      { id: 'pr60', tier: 'B', card: cards[11], total: 2, remaining: 1 },
      { id: 'pr61', tier: 'C', card: cards[14], total: 6, remaining: 3 },
      { id: 'pr62a', tier: 'D', card: cards[28], total: 120, remaining: 63 },
      { id: 'pr62b', tier: 'D', card: cards[30], total: 121, remaining: 64 }
    ]
  },
  {
    /* 已售完但還沒開獎。sold_out 與 revealed 是兩個不同的狀態，中間隔著賣家
       按下開獎 —— 兩種都要有池，否則分不出前端把哪個狀態畫錯了。
       獎品總值 63,800 ÷ 票收 75,000 = 85.1%。 */
    sellerId: 's5',
    origin: 'merchant',
    id: 'p16',
    title: '滿分場 #29 · 高額場（已售完）',
    cover: ph(46),
    mode: 'classic',
    ticketPrice: 2500,
    totalTickets: 30,
    remainingTickets: 0,
    takenSeats: Array.from({ length: 30 }, (_, i) => i + 1),
    status: 'sold_out',
    commitHash: '0b4e7c2a95d1f8630011223344556677889900aabbccddeeff0011223344aabb',
    clientSeedSource: 'drand:5620166',
    openedAt: '2026-08-08T20:00:00+08:00',
    escrow: escrowOf(30, 2500),
    prizes: [
      { id: 'pr63', tier: 'LAST', card: cards[1], total: 1, remaining: 0 },
      { id: 'pr64', tier: 'A', card: cards[2], total: 1, remaining: 0 },
      { id: 'pr65', tier: 'B', card: cards[6], total: 1, remaining: 0 },
      { id: 'pr66', tier: 'C', card: cards[15], total: 3, remaining: 0 },
      { id: 'pr67', tier: 'D', card: cards[30], total: 25, remaining: 0 }
    ]
  }
]

/* ---- mock 的宣告買回價 ----
 *
 * 真實資料裡 buyback 是賣家在建池表單上**一格一格填**的，系統從來不從
 * refPrice 推導。mock 沒有賣家可以填，所以在這裡一次補上一組示範值：
 * 取標示市值的六成（舊制回收區間 5–7 成的中間值），讓 mock 的畫面跟
 * 接上後端之後看起來一致。**這是產生假資料，不是執行期的算式。**
 *
 * 最後一個池刻意留成舊制（buyback 全部 null、只有 returnRatio）——
 * 「這個池沒有宣告買回價」那條分支在 mock 模式下也要走得到，
 * 否則本機開發永遠看不到它長什麼樣。
 */
/* 示範用的保底水位：讓每個 mock 池的保底回饋率大約落在這裡。
   真實資料裡賣家是**直接填絕對金額**的，這個比率只存在於「造假資料」這一步 ——
   要一組看起來合理的示範數字，總得有個目標水位。 */
const MOCK_FLOOR_TARGET = 0.6
pools.forEach((pool, idx) => {
  const legacy = idx === pools.length - 1
  if (legacy) {
    // 舊池：沒有買回價，只有當初宣告過的舊制還元率（不算爆賞）
    const value = pool.prizes
      .filter(p => p.tier !== 'BUST')
      .reduce((a, p) => a + p.total * (p.card.refPrice ?? 0), 0)
    pool.returnRatio = Math.round((value / (pool.totalTickets * pool.ticketPrice)) * 1000) / 10
    pool.floorRatio = null
    pool.commitVersion = 2
    for (const p of pool.prizes) p.buyback = null
    return
  }
  /* **一個賞別一個金額**，跟建池表單的填法一致 —— 同一個賞別裡的卡
     共用同一個買回價。代表值取該賞別最高的參考價，再整池等比縮到目標水位、
     湊成整十的數字（賣家實際會填的就是這種數字，不是 4,573 這種）。 */
  const rep = new Map<string, number>()
  for (const p of pool.prizes) {
    rep.set(p.tier, Math.max(rep.get(p.tier) ?? 0, p.card.refPrice ?? 0))
  }
  const raw = pool.prizes.reduce((a, p) => a + p.total * (rep.get(p.tier) ?? 0), 0)
  const revenue = pool.totalTickets * pool.ticketPrice
  const scale = raw ? (MOCK_FLOOR_TARGET * revenue) / raw : 0
  const tierBuyback = new Map(
    [...rep].map(([t, v]) => [t, Math.max(10, Math.round((v * scale) / 10) * 10)]))
  let floor = 0
  for (const p of pool.prizes) {
    p.buyback = tierBuyback.get(p.tier)!
    floor += p.total * p.buyback
  }
  pool.floorRatio = Math.round((floor / revenue) * 1000) / 10
  pool.returnRatio = null
  pool.commitVersion = 3
})

export interface NewPoolInput {
  sellerId: string
  title: string
  mode: Pool['mode']
  ticketPrice: number
  shiteiTier?: Tier
  /**
   * 一個獎項。
   *
   * `card` 是**挑出來的完整卡片身分**，不是打出來的一串字：卡號、系列、
   * 卡圖、變體、（卡冊來源的）鑑定編號全都在裡面。原本這裡只有一個
   * `name: string` —— 那樣開出來的池沒有卡圖，也永遠對不到外部價格，
   * 而且「同一組卡號的哪一個版本」在系統裡根本不存在（見 CardItem.variantId）。
   *
   * card.refPrice 是賣家標示的參考價（**選填**、只顯示、不參與計算）；
   * buyback 是他宣告的買回價（要履行的絕對金額）。
   */
  prizes: { tier: Tier; card: CardItem; qty: number; buyback: number }[]
}

/** 賣家開池。籤序在此刻預洗並產生 commit hash（mock 以假雜湊代替） */
export function createPool(input: NewPoolInput): Pool {
  const seats = input.prizes.reduce((s, p) => s + p.qty, 0)
  /* 序號要**避開已經被用掉的 id**，不能用 pools.length + 1。
     示範資料的 id 不是連號的（p1–p5、p8–p16），所以 length + 1 一開始就撞上
     既有的 p15 —— 開完池導到 /pools/p15，畫面上是別人的池。
     開池的最後一步跳出一個不是自己的池，是這條動線上最糟的一種錯。 */
  let seq = pools.length + 1
  while (pools.some(p => p.id === `p${seq}`)) seq++
  const hex = (n: number) => Array.from({ length: n }, (_, i) => 'abcdef0123456789'[(seq * 7 + i * 13) % 16]).join('')

  const prizes: PoolPrize[] = input.prizes.map((p, i) => ({
    id: `np${seq}-${i}`,
    tier: p.tier,
    total: p.qty,
    remaining: p.qty,
    // 賣家宣告的買回價。原樣存下來，不做任何換算
    buyback: p.buyback,
    /* 挑到的身分**原封不動**存下來。原本這裡是拿卡名現編一個 setCode: 'new'、
       cardNo: '1/2' 的假身分 —— 那讓 mock 看起來能開池，卻把「這是哪一張卡」
       這件事整個抹掉。只有 image 在沒有卡圖時補一張佔位圖：
       圖不進公平性承諾，補一張不會讓任何東西說謊。 */
    card: {
      ...p.card,
      id: p.card.id || `nc${seq}-${i}`,
      image: p.card.image || ph((i * 47 + seq * 23) % 360)
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

/* buyback 是那個池的賣家在開賣前宣告的買回價（點）。
   mock 取市值六成當示範值，跟上面的 mock 池一致 —— 沒有這個值的話卡冊會顯示
   「這個池沒有宣告買回價」，而 mock 模式就看不到回收這條動線了。
   up6 刻意留成 null：那條分支在 mock 裡也要看得到。 */
export const userPrizes: UserPrize[] = [
  { id: 'up1', card: cards[1], tier: 'B', status: 'stashed', wonAt: '2026-08-05T20:11:00+08:00', acquiredAt: '2026-08-05T20:11:00+08:00', stashExpiresAt: '2026-11-03', buyback: 16800 },
  { id: 'up2', card: cards[4], tier: 'D', status: 'stashed', wonAt: '2026-08-05T20:11:00+08:00', acquiredAt: '2026-08-05T20:11:00+08:00', stashExpiresAt: '2026-11-03', buyback: 7680 },
  { id: 'up3', card: cards[5], tier: 'C', status: 'shipped', wonAt: '2026-07-20T14:02:00+08:00', acquiredAt: '2026-07-20T14:02:00+08:00', stashExpiresAt: '—', buyback: 5880 },
  { id: 'up4', card: cards[16], tier: 'A', status: 'stashed', wonAt: '2026-08-09T18:40:00+08:00', acquiredAt: '2026-08-09T18:40:00+08:00', stashExpiresAt: '2026-11-07', buyback: 900 },
  { id: 'up5', card: cards[19], tier: 'D', status: 'ship_requested', wonAt: '2026-08-10T11:05:00+08:00', acquiredAt: '2026-08-10T11:05:00+08:00', stashExpiresAt: '2026-11-08', buyback: 456 },
  // 舊制的池抽到的卡：沒有宣告過買回價，所以回收不了。這條分支要看得到
  { id: 'up6', card: cards[21], tier: 'C', status: 'stashed', wonAt: '2026-08-11T09:30:00+08:00', acquiredAt: '2026-08-11T09:30:00+08:00', stashExpiresAt: '2026-11-09', buyback: null }
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
  { user: 'VD-9K**', poolTitle: '銅板場 #72 · 快開快抽', tier: 'C', cardName: '三合一磁怪 V', at: '2 小時前' },
  { user: 'VD-4M**', poolTitle: '滿分場 #30 · 全 PSA 10', tier: 'A', cardName: '莉莉艾 SR', at: '3 小時前' }
]
