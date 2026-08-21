/**
 * 種子資料。
 *
 * 部署完的資料庫是空的，沒有掛單就沒東西可買、也沒東西可測。
 * 這支可以重複執行 —— 全部用 on conflict do nothing，不會重複塞。
 */
import { sql } from './db.js'
import { PLATFORM_ID } from './orders-service.js'
import { commitOf, seatSequence } from './shared/fairness.js'

const users: [string, string, string][] = [
  [PLATFORM_ID, 'platform', 'VaultDraw 官方'],
  ['u-buyer', 'buyer', '測試買家'],
  ['u-seller', 'seller', '測試賣家'],
  ['u-shop', 'shop', '關都卡舖'],
  /* 為了讓池看起來有市場，賣家要有不同的來源與規模。
     users 是 sellers 的外鍵母表，所以賣家一定要先有帳號。 */
  ['u-official', 'vaultdraw', 'VaultDraw 自營'],
  ['u-vaultkeeper', 'vaultkeeper', '保庫堂'],
  ['u-grade10', 'grade10', '滿分保庫'],
  ['u-promolab', 'promolab', '促販實驗室']
]

const card = (name: string, certNo: string | null, artId: string, refPrice: number) => ({
  id: 'c-' + artId, name, setCode: 'sv4a', cardNo: '349/190', language: 'JP',
  grader: certNo ? 'PSA' : 'RAW', grade: certNo ? 10 : null, certNo,
  image: '', refPrice, artId
})

const listings: [string, ReturnType<typeof card>, number, string, string, 'vault' | 'ship'][] = [
  ['l-seed-1', card('噴火龍 ex SAR', '82345671', 'SV4a-349', 9800), 8620, 'u-seller', '測試賣家', 'ship'],
  ['l-seed-2', card('太樂巴戈斯 ex UR', '82345672', 'SV8a-237', 19800, ), 18220, 'u-shop', '關都卡舖', 'ship'],
  ['l-seed-3', card('月亮伊布 ex SAR', '82345673', 'SV8a-217', 28000), 26320, 'u-seller', '測試賣家', 'vault'],
  ['l-seed-4', card('謎擬Ｑ SAR', null, 'SV4a-341', 4200), 3780, 'u-shop', '關都卡舖', 'ship'],
  ['l-seed-5', card('奇樹 SAR', '82345675', 'SV4a-350', 3400), 2920, 'u-seller', '測試賣家', 'vault']
]

/* 池裡的卡片。上面的 card() 把 setCode / cardNo 寫死成 sv4a 349/190 ——
   一個池看不出來，十幾個池每張卡都同編號就露餡了，所以這裡從 artId 反推。
   artId 是 <套牌>-<編號>，跟前端抓卡圖用的是同一組代碼，不能亂編。 */
const SET_SIZE: Record<string, string> = { sv4a: '190', sv8a: '187', sv3: '108', sv6: '101' }
const pcard = (name: string, artId: string, refPrice: number, certNo: string | null = null) => {
  const set = (artId.split('-')[0] ?? '').toLowerCase()
  const no = artId.split('-')[1] ?? ''
  return {
    id: (certNo ? 'cg-' : 'c-') + artId, name,
    setCode: set, cardNo: SET_SIZE[set] ? `${no}/${SET_SIZE[set]}` : no, language: 'JP',
    grader: certNo ? 'PSA' : 'RAW', grade: certNo ? 10 : null, certNo,
    image: '', refPrice, artId
  }
}

/* 卡片目錄。價位是日版單卡 2025 年前後的概略行情，用來排賞別與算還元率。
   只列已知編號的卡 —— 編號亂寫的話前端抓不到卡圖，池會整片空白。 */
const C = {
  charizardUR: pcard('噴火龍 ex UR', 'SV4a-349', 42000),
  kieran: pcard('奇樹 SAR', 'SV4a-350', 28000),
  terapagosUR: pcard('太樂巴戈斯 ex UR', 'SV8a-237', 19800),
  pikachuSAR: pcard('皮卡丘 ex SAR', 'SV8a-236', 12800),
  charizardSAR: pcard('噴火龍 ex SAR', 'SV3-125', 9800),
  gardevoirUR: pcard('沙奈朵 ex UR', 'SV4a-348', 7600),
  umbreonSAR: pcard('月亮伊布 ex SAR', 'SV8a-217', 5400),
  dragapultSAR: pcard('多龍巴魯托 ex SAR', 'SV8a-221', 4200),
  eeveeSAR: pcard('伊布 ex SAR', 'SV8a-223', 3800),
  espeonSAR: pcard('太陽伊布 ex SAR', 'SV8a-211', 2600),
  pidgeotSAR: pcard('大比鳥 ex SAR', 'SV3-128', 2200),
  pepperSAR: pcard('派帕 SAR', 'SV4a-353', 1800),
  hasselSAR: pcard('八朔 SAR', 'SV6-124', 1200),
  poppySAR: pcard('波琵 SAR', 'SV3-131', 760),
  sylveon: pcard('仙子伊布 ex', 'SV8a-212', 620),
  flareon: pcard('火伊布 ex', 'SV8a-202', 420),
  leafeon: pcard('葉伊布 ex', 'SV8a-200', 380),
  glaceon: pcard('冰伊布 ex', 'SV8a-206', 340),
  morpeko: pcard('桃歹郎 ex', 'SV8a-219', 180),
  sandyShocks: pcard('砂鐵蜥 ex', 'SV8a-216', 120),
  // 滿分保庫只收 PSA 10，附鑑定編號讓買家自己去 PSA 網站對
  terapagosPSA: pcard('太樂巴戈斯 ex UR', 'SV8a-237', 19800, '84120031'),
  pikachuPSA: pcard('皮卡丘 ex SAR', 'SV8a-236', 12800, '84120032'),
  charizardPSA: pcard('噴火龍 ex SAR', 'SV3-125', 9800, '84120033'),
  dragapultPSA: pcard('多龍巴魯托 ex SAR', 'SV8a-221', 4200, '84120034'),
  flareonPSA: pcard('火伊布 ex', 'SV8a-202', 420, '84120035')
}

type Tier = 'A' | 'B' | 'C' | 'D' | 'LAST' | 'BUST'

interface PoolDef {
  id: string
  sellerId: string
  mode: 'classic' | 'shitei' | 'muteki' | 'streak' | 'auction'
  title: string
  ticketPrice: number
  /** 只用 002_core.sql 允許的值：draft / committed / open / sold_out / revealed */
  status: 'open' | 'sold_out' | 'revealed'
  /** 每個池都要不同 —— 同一組 seed 會洗出同一個籤序，共用就等於沒洗 */
  serverSeed: string
  /** 已售出的籤數。沒有人抽過的池看起來像壞掉，所以先預填一部分 */
  sold: number
  /** 籤位排列：預設散落（像真的有人挑籤），競標池要留最後幾支所以從頭填 */
  soldLayout?: 'scatter' | 'head'
  openedDaysAgo: number
  shiteiTier?: 'A' | 'B' | 'C' | 'D'
  auctionSeats?: number
  /** 只有既有的 p-seed-1 需要 —— 它的籤序已經在正式資料庫裡，不能因為改規則就變 */
  clientSeed?: string
  prizes: { tier: Tier; card: ReturnType<typeof pcard>; total: number }[]
}

/* 池清單。設計原則：
   還元率（獎品總值 ÷ 票收）一律壓在 80～90%，太高莊家賠錢、太低沒人抽。
   D 賞的單價必須遠低於票價，否則「每抽都回本」會讓池失去意義。
   模式五種都各留一個池，前端每條路徑都有東西可以點。 */
const poolDefs: PoolDef[] = [
  {
    /* 官方旗艦池：平台自營，規格刻意做得比商家池好一階。
       官方池的角色是基準線 —— 讓買家知道這個站的池應該長什麼樣。 */
    id: 'p-official-1', sellerId: 'u-official', mode: 'classic',
    title: '官方旗艦場 #59 · 閃色寶藏 精選',
    ticketPrice: 1280, status: 'open', serverSeed: 'a1'.repeat(32), sold: 42, openedDaysAgo: 4,
    prizes: [ // 100 籤，還元 86.3%
      { tier: 'LAST', card: C.charizardUR, total: 1 },
      { tier: 'A', card: C.gardevoirUR, total: 1 },
      { tier: 'B', card: C.dragapultSAR, total: 3 },
      { tier: 'C', card: C.pidgeotSAR, total: 6 },
      { tier: 'D', card: C.flareon, total: 30 },
      { tier: 'D', card: C.leafeon, total: 59 }
    ]
  },
  {
    /* 官方入門池：漏斗上緣，給第一次抽的人一個便宜又安全的地方。
       票價壓不到 100 是因為最低價的普卡就要 120 —— 再低就變成每抽必賺。 */
    id: 'p-official-2', sellerId: 'u-official', mode: 'classic',
    title: '官方入門場 · 兩百點開一張',
    ticketPrice: 200, status: 'open', serverSeed: 'a2'.repeat(32), sold: 61, openedDaysAgo: 3,
    prizes: [ // 200 籤，還元 87.8%
      { tier: 'A', card: C.espeonSAR, total: 1 },
      { tier: 'B', card: C.hasselSAR, total: 3 },
      { tier: 'C', card: C.flareon, total: 10 },
      { tier: 'D', card: C.morpeko, total: 40 },
      { tier: 'D', card: C.sandyShocks, total: 146 }
    ]
  },
  {
    /* 已完抽並公布 seed 的池。沒有這種池就驗不到 /pools/:id/reveal 與前端的
       公平性頁面 —— server_seed 只有在 revealed 之後才會出現在回應裡。 */
    id: 'p-official-3', sellerId: 'u-official', mode: 'classic',
    title: '官方旗艦場 #58 · 已開獎',
    ticketPrice: 800, status: 'revealed', serverSeed: 'a3'.repeat(32), sold: 60, openedDaysAgo: 26,
    prizes: [ // 60 籤，還元 84.2%
      { tier: 'LAST', card: C.gardevoirUR, total: 1 },
      { tier: 'A', card: C.dragapultSAR, total: 1 },
      { tier: 'B', card: C.pidgeotSAR, total: 2 },
      { tier: 'C', card: C.hasselSAR, total: 6 },
      { tier: 'D', card: C.glaceon, total: 50 }
    ]
  },
  {
    // 商家的量產大池：籤多、單價中等，用來壓測籤牆一次畫 250 格的效能
    id: 'p-shop-1', sellerId: 'u-shop', mode: 'classic',
    title: '關都精選 · 伊布家族 250 抽',
    ticketPrice: 350, status: 'open', serverSeed: 'b1'.repeat(32), sold: 118, openedDaysAgo: 6,
    prizes: [ // 250 籤，還元 85.7%
      { tier: 'LAST', card: C.pikachuSAR, total: 1 },
      { tier: 'A', card: C.umbreonSAR, total: 1 },
      { tier: 'B', card: C.eeveeSAR, total: 2 },
      { tier: 'C', card: C.pidgeotSAR, total: 6 },
      { tier: 'D', card: C.morpeko, total: 120 },
      { tier: 'D', card: C.sandyShocks, total: 120 }
    ]
  },
  {
    /* 指定賞：抽中 A 賞就結束整池，所以不能用「獎品總值 ÷ 全部票收」評估 ——
       A 賞平均落在第 25.5 支，期望只賣得掉一半的籤。
       期望票收 25.5 × 350 = 8,925，期望發出 4,200 + 24.5 × 144.5 ≈ 7,740，
       還元約 87%。用整池票收去算會誤判成 63%，那個數字沒有意義。 */
    /* 原本設計成指定賞（shitei）。改回 classic 是因為 pools-service.ts 完全沒有讀
       pools.mode —— 抽卡一律照籤位發獎。掛著 shitei 的話前端會顯示指定賞的徽章
       與期望值，實際抽起來卻是一般池，那比沒有這個模式更糟。
       等後端補上模式邏輯再把 mode 改回來即可，獎項結構不用動。 */
    id: 'p-shop-2', sellerId: 'u-shop', mode: 'classic',
    title: '多龍巴魯托 精選 50 抽',
    ticketPrice: 350, status: 'open', serverSeed: 'b2'.repeat(32), sold: 9, openedDaysAgo: 5,
    prizes: [ // 50 籤
      { tier: 'A', card: C.dragapultSAR, total: 1 },
      { tier: 'C', card: C.morpeko, total: 20 },
      { tier: 'D', card: C.sandyShocks, total: 29 }
    ]
  },
  {
    /* 原本設計成連莊爆賞（streak）。改回 classic 的原因比 shitei 更硬：
       前端的 DrawPanel 看到 mode === 'streak' 會把人導去 StreakRunPage，
       而連莊在 API 模式下沒有後端（只有 mock 有），點下去就是死路。
       BUST 賞也一併拿掉 —— 爆賞只有在「抽到就收手」的規則下才有意義，
       在一般池裡它會變成一張可以被正常抽走的廢卡。那 20 席併進 D 賞。 */
    id: 'p-shop-3', sellerId: 'u-shop', mode: 'classic',
    title: '夢幻 精選 66 抽',
    ticketPrice: 500, status: 'open', serverSeed: 'b3'.repeat(32), sold: 14, openedDaysAgo: 2,
    prizes: [ // 66 籤
      { tier: 'A', card: C.dragapultSAR, total: 1 },
      { tier: 'B', card: C.pidgeotSAR, total: 3 },
      { tier: 'C', card: C.hasselSAR, total: 6 },
      { tier: 'D', card: C.flareon, total: 36 },
      { tier: 'D', card: C.sandyShocks, total: 20 }
    ]
  },
  {
    // 原本是無敵賞（muteki）。同樣因為後端不讀 mode 而改回 classic，見 p-shop-2 的說明
    id: 'p-shop-4', sellerId: 'u-shop', mode: 'classic',
    title: '謎擬Ｑ 60 抽',
    ticketPrice: 700, status: 'open', serverSeed: 'b4'.repeat(32), sold: 33, openedDaysAgo: 8,
    prizes: [ // 60 籤，還元 83.6%
      { tier: 'LAST', card: C.charizardSAR, total: 1 },
      { tier: 'B', card: C.dragapultSAR, total: 2 },
      { tier: 'C', card: C.pepperSAR, total: 6 },
      { tier: 'D', card: C.sandyShocks, total: 51 }
    ]
  },
  {
    // 個人賣家的小池：40 籤，抽起來很快就完抽
    id: 'p-seller-1', sellerId: 'u-seller', mode: 'classic',
    title: '個人開池 · 伊布小場 40 抽',
    ticketPrice: 800, status: 'open', serverSeed: 'c1'.repeat(32), sold: 12, openedDaysAgo: 1,
    prizes: [ // 40 籤，還元 86.6%
      { tier: 'A', card: C.umbreonSAR, total: 1 },
      { tier: 'B', card: C.eeveeSAR, total: 1 },
      { tier: 'C', card: C.pidgeotSAR, total: 3 },
      { tier: 'D', card: C.glaceon, total: 35 }
    ]
  },
  {
    /* 已售完但還沒公布 seed。sold_out 與 revealed 是兩個狀態，
       中間隔著賣家按下開獎 —— 前端要分得出來，所以兩種都要有池。 */
    id: 'p-seller-2', sellerId: 'u-seller', mode: 'classic',
    title: '個人開池 · 伊布家族全餐（已售完）',
    ticketPrice: 400, status: 'sold_out', serverSeed: 'c2'.repeat(32), sold: 66, openedDaysAgo: 12,
    prizes: [ // 66 籤，還元 81.4%
      { tier: 'A', card: C.umbreonSAR, total: 1 },
      { tier: 'B', card: C.espeonSAR, total: 1 },
      { tier: 'C', card: C.sylveon, total: 8 },
      { tier: 'D', card: C.morpeko, total: 30 },
      { tier: 'D', card: C.sandyShocks, total: 26 }
    ]
  },
  {
    // 高單價、低籤數。頂獎佔票收的比例高，抽起來的感覺跟銅板池完全不同
    id: 'p-vault-1', sellerId: 'u-vaultkeeper', mode: 'classic',
    title: '保庫堂 · 高額場 30 抽',
    ticketPrice: 2500, status: 'open', serverSeed: 'd1'.repeat(32), sold: 7, openedDaysAgo: 3,
    prizes: [ // 30 籤，還元 84.9%
      { tier: 'LAST', card: C.kieran, total: 1 },
      { tier: 'A', card: C.terapagosUR, total: 1 },
      { tier: 'B', card: C.gardevoirUR, total: 1 },
      { tier: 'C', card: C.pepperSAR, total: 3 },
      { tier: 'D', card: C.sandyShocks, total: 24 }
    ]
  },
  {
    /* 尾籤競標：前 77 支固定價賣掉，最後 3 支的大獎改用喊標。
       固定席的還元 86.1%（19,880 ÷ 23,100），競標席不含在內 ——
       成交價由市場決定，事前算不出來。 */
    /* 原本是尾籤競標（auction）。競標同樣只有 mock 有實作，API 模式下
       沒有出價端點，開出來只會是一個按了沒反應的池。改回 classic。 */
    id: 'p-vault-2', sellerId: 'u-vaultkeeper', mode: 'classic',
    title: '保庫堂 · 噴火龍 80 抽',
    ticketPrice: 300, status: 'open', serverSeed: 'd2'.repeat(32), sold: 77, soldLayout: 'head',
    openedDaysAgo: 9,
    prizes: [ // 80 籤
      { tier: 'A', card: C.charizardSAR, total: 1 },
      { tier: 'B', card: C.umbreonSAR, total: 1 },
      { tier: 'B', card: C.dragapultSAR, total: 1 },
      { tier: 'C', card: C.hasselSAR, total: 3 },
      { tier: 'D', card: C.flareon, total: 10 },
      { tier: 'D', card: C.glaceon, total: 20 },
      { tier: 'D', card: C.sandyShocks, total: 44 }
    ]
  },
  {
    // 全部附鑑定編號的精品池：這種池的賣點是「可查證」，買家能拿 certNo 自己去對
    id: 'p-grade10-1', sellerId: 'u-grade10', mode: 'classic',
    title: '滿分場 #30 · 全 PSA 10',
    ticketPrice: 3200, status: 'open', serverSeed: 'e1'.repeat(32), sold: 9, openedDaysAgo: 5,
    prizes: [ // 20 籤，還元 89.2%
      { tier: 'LAST', card: C.terapagosPSA, total: 1 },
      { tier: 'A', card: C.pikachuPSA, total: 1 },
      { tier: 'B', card: C.charizardPSA, total: 1 },
      /* 有鑑定編號的卡一個編號只能開一籤 —— 一個編號對應一張實體卡。
         原本 dragapultPSA 開 2 籤、flareonPSA 開 15 籤，等於宣告有 15 個人
         會各自拿到「同一張 PSA #84120035」。那是平台聲稱要防的一卡多賣，
         而且第一個得主上架之後其餘 14 人都會被 listings_cert_live 擋下。
         這個池的賣點是「全部可查證」，就用不帶編號的卡湊籤數，
         真正有編號的只開一籤。 */
      { tier: 'C', card: C.dragapultPSA, total: 1 },
      { tier: 'D', card: C.flareonPSA, total: 1 },
      { tier: 'D', card: C.sandyShocks, total: 15 }
    ]
  },
  {
    // 個人賣家的小池，開得快、賣得也快：接近完抽的池在列表上要看得到
    id: 'p-promo-1', sellerId: 'u-promolab', mode: 'classic',
    title: '促販卡 大亂鬥 第 7 回',
    ticketPrice: 250, status: 'open', serverSeed: 'e2'.repeat(32), sold: 25, openedDaysAgo: 1,
    prizes: [ // 36 籤，還元 88.7%
      { tier: 'A', card: C.pepperSAR, total: 1 },
      { tier: 'B', card: C.hasselSAR, total: 1 },
      { tier: 'C', card: C.flareon, total: 3 },
      { tier: 'D', card: C.sandyShocks, total: 31 }
    ]
  },
  {
    /* 最早的測試池。籤序已經在正式資料庫裡，client_seed 與 server_seed
       都必須維持原值 —— 換掉就等於偷改了已公布的籤序。 */
    id: 'p-seed-1', sellerId: 'u-seller', mode: 'classic',
    title: '測試池：閃色寶藏 100 抽',
    ticketPrice: 300, status: 'open', serverSeed: '11'.repeat(32), clientSeed: 'fixture:seed-1',
    sold: 0, openedDaysAgo: 0,
    prizes: [
      { tier: 'LAST', card: pcard('噴火龍 ex UR', 'SV4a-349', 43680), total: 1 },
      { tier: 'A', card: pcard('奇樹 SAR', 'SV4a-350', 26320), total: 2 },
      { tier: 'B', card: pcard('太樂巴戈斯 ex UR', 'SV8a-237', 19800), total: 5 },
      { tier: 'C', card: pcard('月亮伊布 ex SAR', 'SV8a-217', 4200), total: 12 },
      { tier: 'D', card: pcard('謎擬Ｑ SAR', 'SV4a-341', 380), total: 80 }
    ]
  }
]

/**
 * 挑出「已被抽走」的籤位。
 * 用固定步長跳位，籤牆看起來才像有人一支一支挑過，而不是從 1 號整齊排到 N 號。
 * 步長跟總籤數有公因數時會提早繞回原點，這時退回加 1，確保一定挑得滿。
 */
function pickSeats(total: number, sold: number, layout: 'scatter' | 'head'): Set<number> {
  if (sold >= total) return new Set(Array.from({ length: total }, (_, i) => i + 1))
  if (layout === 'head') return new Set(Array.from({ length: sold }, (_, i) => i + 1))
  const s = new Set<number>()
  let cur = 3
  while (s.size < sold) {
    const before = s.size
    s.add((cur % total) + 1)
    cur += s.size === before ? 1 : 7
  }
  return s
}

/**
 * 建一個池。已經存在就整個跳過 —— 池一旦開賣，籤序就是對外承諾過的東西，
 * 重跑 seed 不能把它洗掉。
 *
 * 這裡不走 drand（測試不能等兩分鐘），用固定的 server_seed 與 client_seed 算籤序。
 * commit-reveal 的結構完全一樣，只是亂數來源是 fixture —— 標在 client_seed_source 裡。
 */
async function seedPool(d: PoolDef) {
  const [exists] = await sql`select 1 from pools where id = ${d.id}`
  if (exists) return
  const clientSeed = d.clientSeed ?? `fixture:${d.id}`
  const prizeDefs = d.prizes.map((p, i) => ({ ...p, id: `${d.id}-pr${i}` }))
  const total = prizeDefs.reduce((a, p) => a + p.total, 0)
  const openedAt = new Date(Date.now() - d.openedDaysAgo * 86_400_000)

  await sql`
    insert into pools (id, seller_id, mode, title, ticket_price, total_tickets, status,
                       server_seed, commit_hash, client_seed_source, client_seed,
                       shitei_tier, auction_seats, opened_at, revealed_at)
    values (${d.id}, ${d.sellerId}, ${d.mode}, ${d.title}, ${d.ticketPrice}, ${total}, ${d.status},
            ${d.serverSeed}, ${await commitOf(d.serverSeed)}, ${clientSeed}, ${clientSeed},
            ${d.shiteiTier ?? null}, ${d.auctionSeats ?? null}, ${openedAt},
            ${d.status === 'revealed' ? new Date() : null})
  `
  await sql`insert into pool_prizes ${sql(prizeDefs.map(p => ({ id: p.id, pool_id: d.id, tier: p.tier, card: p.card, total: p.total })) as never)}`

  const seq = await seatSequence(d.serverSeed, clientSeed, prizeDefs.map(p => ({ prizeId: p.id, total: p.total })))
  /* 已售出的籤直接標在 pool_seats 上，不補 draws / prizes ——
     這裡要的只是「這個池賣了多少」的畫面，補了反而會讓測試帳號的保管庫多出憑空的卡。 */
  const taken = pickSeats(total, d.sold, d.soldLayout ?? 'scatter')
  const takenAt = openedAt.getTime() + 3_600_000
  await sql`insert into pool_seats ${sql(seq.map((prizeId, i) => ({
    pool_id: d.id, seat: i + 1, prize_id: prizeId,
    taken_by: taken.has(i + 1) ? 'u-buyer' : null,
    taken_at: taken.has(i + 1) ? takenAt : null
  })) as never)}`
  console.log(`seed pool ${d.id}: ${total} seats, ${taken.size} sold, ${d.status}`)
}

async function run() {
  for (const [id, handle, name] of users) {
    await sql`insert into users (id, handle, name) values (${id}, ${handle}, ${name})
              on conflict (id) do nothing`
  }
  await sql`update users set role = 'admin' where id = ${PLATFORM_ID}`
  // 給測試買家一些點數。正式環境的點數只能從儲值來，這裡是為了讓 smoke 測跑得動
  await sql`insert into points_ledger (user_id, delta, reason)
            select 'u-buyer', 1000000, 'seed'
            where not exists (select 1 from points_ledger where user_id = 'u-buyer' and reason = 'seed')`
  await sql`insert into points_ledger (user_id, delta, reason)
            select 'u-seller', 100000, 'seed'
            where not exists (select 1 from points_ledger where user_id = 'u-seller' and reason = 'seed')`
  await sql`insert into points_ledger (user_id, delta, reason)
            select 'u-shop', 100000, 'seed'
            where not exists (select 1 from points_ledger where user_id = 'u-shop' and reason = 'seed')`

  for (const [id, c, price, sellerId, sellerName, delivery] of listings) {
    await sql`
      insert into listings (id, card, price, seller_id, seller_name, delivery, cert_no)
      values (${id}, ${c as never}, ${price}, ${sellerId}, ${sellerName}, ${delivery}, ${c.certNo})
      on conflict (id) do nothing
    `
  }

  /* 賣家。origin 三種都要有池：官方自營、商家、個人 ——
     前端會依 origin 顯示不同的信任標示，只有一種就驗不到。 */
  const sellerRows: [string, string, string, 'official' | 'merchant' | 'personal', 'pending' | 'verified' | 'trusted', string][] = [
    ['u-seller', 'seller', '測試賣家', 'personal', 'verified', '個人玩家，開自己收藏的池。'],
    ['u-shop', 'shop', '關都卡舖', 'merchant', 'trusted', '實體店第 8 年，線上同步開池。台北可自取。'],
    ['u-official', 'vaultdraw', 'VaultDraw 自營', 'official', 'trusted', '平台自營池。進貨、鑑定、出貨全由 VaultDraw 負責，糾紛平台全責處理。'],
    ['u-vaultkeeper', 'vaultkeeper', '保庫堂', 'merchant', 'trusted', 'PSA / BGS 鑑定卡專門。開池前全數實拍上架，出貨附鑑定證書照。'],
    ['u-grade10', 'grade10', '滿分保庫', 'merchant', 'trusted', '只收 PSA 10。單池 20 籤以內，每張都附鑑定編號可自行查證。'],
    ['u-promolab', 'promolab', '促販實驗室', 'personal', 'verified', '專收日版促販卡與 AR，小池快開快抽。']
  ]
  for (const [id, handle, name, origin, tier, bio] of sellerRows) {
    await sql`insert into sellers (id, handle, name, origin, tier, bio)
              values (${id}, ${handle}, ${name}, ${origin}, ${tier}, ${bio})
              on conflict (id) do nothing`
  }

  for (const d of poolDefs) await seedPool(d)

  const [n] = await sql<{ count: string }[]>`select count(*)::text as count from listings where status = 'live'`
  const [pc] = await sql<{ count: string }[]>`select count(*)::text as count from pools`
  console.log(`seed done — ${n?.count ?? 0} 筆有效掛單、${pc?.count ?? 0} 個池`)
  await sql.end()
}
run().catch(e => { console.error(e); process.exit(1) })
