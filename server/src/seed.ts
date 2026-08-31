/**
 * 種子資料。
 *
 * 部署完的資料庫是空的，沒有掛單就沒東西可買、也沒東西可測。
 * 這支可以重複執行 —— 全部用 on conflict do nothing，不會重複塞。
 */
import { randomBytes } from 'node:crypto'
import { sql } from './db.js'
import { GEN, genId } from './seed-gen.js'
import { PLATFORM_ID } from './orders-service.js'
import { assertSeedEntropy } from './pools-service.js'
import { BUYBACK_MIN } from './shared/pool-settlement.js'
import { commitV2, manifestHashOf, seatSequence, type ManifestVersion } from './shared/fairness.js'
import { floorAllowed, floorRatio } from './shared/economics.js'
import { env } from './env.js'

/**
 * 種子的目標庫守門。
 *
 * ── 為什麼要有這道閘 ────────────────────────────────────────────────
 * 這支腳本原本掛在 Railway 的 startCommand 裡（`migrate && seed && start`），
 * 於是**每一次部署或當機重啟都會再灌一批示範池**。正式站因此長成
 * 32 個池全是 fixture、其中 10 個還開著賣 —— 要給卡商看的時候，
 * 簡報上標了「示意」的畫面，站上卻沒有任何一個字說那是假的。
 *
 * 把 seed 從 startCommand 拿掉（見 railway.json）解決了「這次」的問題。
 * 但那只是一行設定，下一個人為了讓新環境有東西看，很容易又把它接回去。
 * 這道閘是機械式的防線：**種子只准打進用完就丟的庫**。
 *
 * ── 判準：主機是不是本機 ────────────────────────────────────────────
 * 不看 NODE_ENV —— 那是一個誰都可以設、而且在 Railway 上預設就是
 * 'production' 之外還有一堆邊界情況的值。看連線指向哪裡才是誠實的問題：
 * 種子會寫進哪個資料庫，只由 DATABASE_URL 決定。
 *
 * 逃生口留 SEED_ALLOW_REMOTE=1，因為「開一個全新的雲端測試環境、想灌一批
 * 示範資料」是合理需求。它必須是**當下那一次呼叫明確打上去的**，
 * 不能是設一次就永遠生效的東西 —— 所以刻意不寫進 .env.example。
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function assertSeedTargetIsDisposable() {
  let host = ''
  try {
    host = new URL(env.DATABASE_URL).hostname
  } catch {
    /* 解析不出來就當成「不是本機」。這裡的預設值必須是拒絕：
       看不懂的連線字串最不該做的事，就是猜它是安全的。 */
    host = '(無法解析)'
  }
  if (LOCAL_HOSTS.has(host)) return
  if (process.env.SEED_ALLOW_REMOTE === '1') {
    console.warn(`[seed] ⚠️  目標是非本機資料庫（${host}），因 SEED_ALLOW_REMOTE=1 而放行`)
    return
  }
  console.error(
    `[seed] 拒絕執行：目標資料庫不是本機（host = ${host}）。\n` +
    `       種子會憑空生出示範池與示範點數，正式環境不該有這種東西。\n` +
    `       真的要灌進遠端環境的話，加上 SEED_ALLOW_REMOTE=1 再跑一次。`
  )
  process.exit(1)
}

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
const SET_SIZE: Record<string, string> = { sv4a: '190', sv8a: '187', sv3: '108', sv6: '101', sv2a: '165' }
const pcard = (
  name: string, artId: string, refPrice: number,
  certNo: string | null = null,
  /* 卡片變體（TCGdex 的 variantId）。同一組卡號的不同版本是完全不同的商品，
     所以 id 也要跟著分岔 —— 兩個 variantId 共用一個 card.id 的話，
     「這是哪一張卡」在資料裡就又變回一個值。 */
  variantId: string | null = null
) => {
  const set = (artId.split('-')[0] ?? '').toLowerCase()
  const no = artId.split('-')[1] ?? ''
  return {
    id: (certNo ? 'cg-' : 'c-') + artId + (variantId ? '-' + variantId : ''), name,
    setCode: set, cardNo: SET_SIZE[set] ? `${no}/${SET_SIZE[set]}` : no, language: 'JP',
    grader: certNo ? 'PSA' : 'RAW', grade: certNo ? 10 : null, certNo,
    image: '', refPrice, artId, variantId
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
  /* 補進來的第二批。原本的目錄集中在 sv8a 的伊布家族，每個池看起來都一樣；
     多幾張 sv4a / sv6 / sv3 的卡，池與池之間才分得出來。 */
  botanSAR: pcard('牡丹 SAR', 'SV4a-354', 15600),
  mewUR: pcard('夢幻 ex UR', 'SV4a-347', 6400),
  raidenSAR: pcard('猛雷鼓 ex SAR', 'SV8a-222', 3400),
  blisseySAR: pcard('幸福蛋 ex SAR', 'SV6-121', 1500),
  dragapultSV6: pcard('多龍巴魯托 ex', 'SV6-120', 980),
  jolteon: pcard('雷伊布 ex', 'SV8a-209', 520),
  vaporeon: pcard('水伊布 ex', 'SV8a-205', 460),
  ironHands: pcard('鐵臂膀 ex', 'SV8a-210', 300),
  ditto: pcard('差不多娃娃 ex', 'SV8a-215', 240),
  finizen: pcard('海豚俠 ex', 'SV8a-207', 150),
  /* 同一組卡號的三個變體（真實資料，TCGdex SV2a-025 ピカチュウ）。
     **卡名、套牌、卡號三欄逐字相同，只有 variantId 不同** —— 這正是
     manifest v4 要處理的那件事：在 v3 的規則下這三張在承諾裡分不出來，
     所以開賣後把大師球鏡面換成普卡驗算抓不到。
     cardmarket 實測行情：普卡 €0.02、寶貝球鏡面 €0.28、大師球鏡面 €369。
     refPrice 是換算後的概略點數，只用來排賞別（它不參與任何金額計算）。 */
  pikachuMaster: pcard('皮卡丘', 'SV2a-025', 12800, null, '2asus05yghmpd1ud1sdmlq3as4e'),
  pikachuPoke: pcard('皮卡丘', 'SV2a-025', 400, null, '3739bbtj3i910y5ynn9xc6ryf'),
  pikachuNormal: pcard('皮卡丘', 'SV2a-025', 100, null, 'endfynwn4n10gzq'),
  // 滿分保庫只收 PSA 10，附鑑定編號讓買家自己去 PSA 網站對
  terapagosPSA: pcard('太樂巴戈斯 ex UR', 'SV8a-237', 19800, '84120031'),
  pikachuPSA: pcard('皮卡丘 ex SAR', 'SV8a-236', 12800, '84120032'),
  charizardPSA: pcard('噴火龍 ex SAR', 'SV3-125', 9800, '84120033'),
  dragapultPSA: pcard('多龍巴魯托 ex SAR', 'SV8a-221', 4200, '84120034'),
  flareonPSA: pcard('火伊布 ex', 'SV8a-202', 420, '84120035'),
  /* 給非「全 PSA」的池用的鑑定卡。編號一定要跟上面那批不同 ——
     一個編號對應一張實體卡，兩個池共用同一個編號等於宣告同一張卡有兩個得主，
     而 listings_cert_live 會在第二個人上架時把他擋下來。 */
  botanPSA: pcard('牡丹 SAR', 'SV4a-354', 15600, '84120041'),
  gardevoirPSA: pcard('沙奈朵 ex UR', 'SV4a-348', 7600, '84120042'),
  umbreonPSA: pcard('月亮伊布 ex SAR', 'SV8a-217', 5400, '84120043'),
  raidenPSA: pcard('猛雷鼓 ex SAR', 'SV8a-222', 3400, '84120044')
}

type Tier = 'A' | 'B' | 'C' | 'D' | 'LAST' | 'BUST'

interface PoolDef {
  id: string
  sellerId: string
  mode: 'muteki'
  title: string
  ticketPrice: number
  /** 只用 002_core.sql 允許的值：draft / committed / open / sold_out / revealed */
  status: 'open' | 'sold_out' | 'revealed'
  /** 已售出的籤數。沒有人抽過的池看起來像壞掉，所以先預填一部分 */
  sold: number
  /** 籤位排列：預設散落（像真的有人挑籤）；接近完抽的池從頭填比較像真的賣光 */
  soldLayout?: 'scatter' | 'head'
  openedDaysAgo: number
  shiteiTier?: 'A' | 'B' | 'C' | 'D'
  /** 只有既有的 p-seed-1 需要 —— 它的籤序已經在正式資料庫裡，不能因為改規則就變 */
  clientSeed?: string
  /**
   * 刻意停在舊制（commit v2、沒有宣告買回價）的池。
   *
   * 種子裡一定要留至少一個，否則「舊池的驗算仍然過得了」這條迴歸
   * 在本機永遠碰不到 —— 而那正是 manifest 版本化最容易做壞的地方。
   * 這種池的卡不能回收，跟正式環境現有的池行為一致。
   */
  legacyV2?: boolean
  /**
   * 刻意停在 v3（有買回價，但獎品沒有變體）的池。
   *
   * 跟 legacyV2 是同一個用途、不同的一版：v4 在尾端追加了 variantId，
   * 種子裡要留一個 v3 的池，「v3 的舊池仍然驗得過」才有固定樣本可測。
   * 這兩個池加起來釘住的是同一件事 —— **升 manifest 版本沒有讓既有的池
   * 集體變成「被竄改」**，而那是這套版本化最容易做壞的地方。
   */
  legacyV3?: boolean
  prizes: { tier: Tier; card: ReturnType<typeof pcard>; total: number }[]
}

/* 池清單。設計原則：

   一、還元率（獎品總值 ÷ 票收）一律壓在 80～90%，太高莊家賠錢、太低沒人抽。
       D 賞的單價必須遠低於票價，否則「每抽都回本」會讓池失去意義。

   二、票價要橫跨整個區間，低／中／高各約三分之一。示範資料如果全擠在同一個
       價位，看的人會以為平台只做那個價位的生意；四個 300 塊的池證明不了
       這裡開得起 3,000 塊的池，反過來也一樣。目前的分佈（12 池）：
         低價 ≤400   p-official-2 200 / p-promo-1 250 / p-shop-1 350 / p-seller-2 400
         中價 ~1000  p-shop-5 550 / p-shop-4 700 / p-official-3 800 / p-official-1 1280
         高價 >1500  p-vault-3 1900 / p-vault-1 2500 / p-grade10-1 3200 / p-seed-1 3250

   三、賣家的 origin 三種都要有池（官方／商家／個人）—— 前端會依 origin 顯示
       不同的信任標示，只有一種就驗不到那段畫面。

   四、籤數也要有變化（20～250），卡片要跨套牌、鑑定卡與裸卡都有。
       每個池長得一樣的話，籤牆與卡圖的問題要等到正式資料進來才會被發現。

   原本這裡還有幾個池是從指定賞／連莊／競標「改標成 muteki」留下來的
   （p-shop-2 多龍巴魯托 50 抽、p-shop-3 夢幻 66 抽、p-vault-2 噴火龍 80 抽）。
   那些玩法的前端介面已經整組移除，池只剩下一個被硬調過票價的空殼，
   跟其他池比沒有多示範任何東西，所以一併刪掉（個人賣家的 p-seller-1 也刪了，
   它跟 p-promo-1 示範的是同一件事）。新的池用新的 id（p-shop-5 / p-vault-3）——
   seedPool 看到 id 已存在就整個跳過，沿用舊 id 的話在既有的資料庫上重跑
   只會靜靜地跳過，新池永遠不會出現。 */
const poolDefs: PoolDef[] = [
  {
    /* 官方旗艦池：平台自營，規格刻意做得比商家池好一階。
       官方池的角色是基準線 —— 讓買家知道這個站的池應該長什麼樣。 */
    id: 'p-official-1', sellerId: 'u-official', mode: 'muteki',
    title: '官方旗艦場 #59 · 閃色寶藏 精選',
    ticketPrice: 1280, status: 'open', sold: 42, openedDaysAgo: 4,
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
    id: 'p-official-2', sellerId: 'u-official', mode: 'muteki',
    title: '官方入門場 · 兩百點開一張',
    ticketPrice: 200, status: 'open', sold: 61, openedDaysAgo: 3,
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
    id: 'p-official-3', sellerId: 'u-official', mode: 'muteki',
    title: '官方旗艦場 #58 · 已開獎',
    /* **刻意停在舊制**（commit v2、沒有宣告買回價）。
       這是「manifest 版本化之後舊池仍然驗得過」那條迴歸的固定樣本 ——
       種子裡全部改成 v3 的話，那個洞在本機就永遠碰不到，
       而它是這次改動最容易做壞的一件事。 */
    legacyV2: true,
    ticketPrice: 800, status: 'revealed', sold: 60, openedDaysAgo: 26,
    prizes: [ // 60 籤，還元 84.2%
      { tier: 'LAST', card: C.gardevoirUR, total: 1 },
      { tier: 'A', card: C.dragapultSAR, total: 1 },
      { tier: 'B', card: C.pidgeotSAR, total: 2 },
      { tier: 'C', card: C.hasselSAR, total: 6 },
      { tier: 'D', card: C.glaceon, total: 50 }
    ]
  },
  {
    /* 已完抽並公布 seed 的 **v3** 池（有宣告買回價）。
       p-official-3 是 v2 的樣本，這一池是 v3 的 —— 兩個都 revealed，
       所以 /pools/:id/reveal 的驗算在新舊兩套規則下都有東西可測。
       少了這一池，「新池驗得過」只能靠現場建一個池再等 drand 開賣完抽，
       那在測試裡跑不動。 */
    id: 'p-official-4', sellerId: 'u-official', mode: 'muteki',
    title: '官方旗艦場 #59 · 已開獎',
    /* **刻意停在 v3**（有買回價、獎品沒有變體）。跟 p-official-3 的 v2
       同一個用途：v4 之後這一池就是「v3 的舊池仍然驗得過」的固定樣本。 */
    legacyV3: true,
    ticketPrice: 900, status: 'revealed', sold: 40, openedDaysAgo: 20,
    prizes: [ // 40 籤，票收 36,000
      { tier: 'LAST', card: C.terapagosUR, total: 1 },
      { tier: 'A', card: C.gardevoirUR, total: 1 },
      { tier: 'B', card: C.pidgeotSAR, total: 2 },
      { tier: 'C', card: C.hasselSAR, total: 6 },
      { tier: 'D', card: C.glaceon, total: 30 }
    ]
  },
  {
    /* 已完抽並公布 seed 的 **v4** 池 —— manifest 尾端多一欄 variantId。
       這一池刻意讓三個獎項的卡名、套牌、卡號**逐字相同**，只有變體不同：
       在 v3 的規則下這三張卡在承諾裡分不出來，賣家開賣後把大師球鏡面
       換成普卡，manifest 幾乎不變（只有 refPrice 那一欄，而那一欄本來就
       允許賣家亂填）。v4 之後那條路被堵死。

       p-official-3 是 v2 的樣本、p-official-4 是 v3 的、這一池是 v4 的 ——
       三個都 revealed，所以「升版沒有讓舊池變成被竄改」有三個固定樣本可測。 */
    id: 'p-official-5', sellerId: 'u-official', mode: 'muteki',
    title: '官方變體場 · 皮卡丘 151 已開獎',
    ticketPrice: 350, status: 'revealed', sold: 40, openedDaysAgo: 12,
    prizes: [ // 40 籤，票收 14,000；買回價總和 7,680 + 9×240 + 30×60 = 11,640 → 83.1%
      { tier: 'A', card: C.pikachuMaster, total: 1 },
      { tier: 'C', card: C.pikachuPoke, total: 9 },
      { tier: 'D', card: C.pikachuNormal, total: 30 }
    ]
  },
  {
    // 商家的量產大池：籤多、單價中等，用來壓測籤牆一次畫 250 格的效能
    id: 'p-shop-1', sellerId: 'u-shop', mode: 'muteki',
    title: '關都精選 · 伊布家族 250 抽',
    ticketPrice: 350, status: 'open', sold: 118, openedDaysAgo: 6,
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
    /* 商家的中價位池。低價池靠量、高價池靠一張大卡，中間這一段兩者都不是 ——
       它要證明的是「45 籤也排得出完整的賞別階梯」，而那是最多賣家實際會開的規模。
       這一池刻意混了 PSA 鑑定卡與裸卡：買家看得到兩種標示並排的樣子，
       才知道 CertTag 有出現跟沒出現的差別在哪。 */
    id: 'p-shop-5', sellerId: 'u-shop', mode: 'muteki',
    title: '關都精選 · 中額場 45 抽',
    ticketPrice: 550, status: 'open', sold: 19, openedDaysAgo: 4,
    prizes: [ // 45 籤，票收 24,750、獎品總值 21,640 → 還元 87.4%
      { tier: 'LAST', card: C.mewUR, total: 1 },
      { tier: 'A', card: C.raidenPSA, total: 1 },
      { tier: 'B', card: C.blisseySAR, total: 2 },
      { tier: 'C', card: C.jolteon, total: 5 },
      { tier: 'D', card: C.ditto, total: 16 },
      { tier: 'D', card: C.sandyShocks, total: 20 }
    ]
  },
  {
    // 這個池本來就是無敵賞，是唯一不用改規則的示範池 —— 後端跑的就是它
    id: 'p-shop-4', sellerId: 'u-shop', mode: 'muteki',
    title: '謎擬Ｑ 60 抽',
    ticketPrice: 700, status: 'open', sold: 33, openedDaysAgo: 8,
    prizes: [ // 60 籤，還元 83.6%
      { tier: 'LAST', card: C.charizardSAR, total: 1 },
      { tier: 'B', card: C.dragapultSAR, total: 2 },
      { tier: 'C', card: C.pepperSAR, total: 6 },
      { tier: 'D', card: C.sandyShocks, total: 51 }
    ]
  },
  {
    /* 已售完但還沒公布 seed。sold_out 與 revealed 是兩個狀態，
       中間隔著賣家按下開獎 —— 前端要分得出來，所以兩種都要有池。 */
    id: 'p-seller-2', sellerId: 'u-seller', mode: 'muteki',
    title: '個人開池 · 伊布家族全餐（已售完）',
    ticketPrice: 400, status: 'sold_out', sold: 66, openedDaysAgo: 12,
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
    id: 'p-vault-1', sellerId: 'u-vaultkeeper', mode: 'muteki',
    title: '保庫堂 · 高額場 30 抽',
    ticketPrice: 2500, status: 'open', sold: 7, openedDaysAgo: 3,
    prizes: [ // 30 籤，還元 84.9%
      { tier: 'LAST', card: C.kieran, total: 1 },
      { tier: 'A', card: C.terapagosUR, total: 1 },
      { tier: 'B', card: C.gardevoirUR, total: 1 },
      { tier: 'C', card: C.pepperSAR, total: 3 },
      { tier: 'D', card: C.sandyShocks, total: 24 }
    ]
  },
  {
    /* 保庫堂的鑑定精選：24 籤、票價 1,900。這一池補的是「高價但不是最高價」——
       只有 3,000 級的池的話，高價區看起來像個懸崖而不是連續的區間。
       頂三賞刻意用兩張 PSA 加一張裸卡：同一池裡並排才看得出鑑定溢價。 */
    id: 'p-vault-3', sellerId: 'u-vaultkeeper', mode: 'muteki',
    title: '保庫堂 · 鑑定精選 24 抽',
    ticketPrice: 1900, status: 'open', sold: 6, openedDaysAgo: 2,
    prizes: [ // 24 籤，票收 45,600、獎品總值 38,740 → 還元 85.0%
      { tier: 'LAST', card: C.botanPSA, total: 1 },
      { tier: 'A', card: C.gardevoirPSA, total: 1 },
      { tier: 'B', card: C.umbreonSAR, total: 1 },
      { tier: 'C', card: C.dragapultSV6, total: 4 },
      { tier: 'D', card: C.vaporeon, total: 7 },
      { tier: 'D', card: C.ironHands, total: 10 }
    ]
  },
  {
    // 全部附鑑定編號的精品池：這種池的賣點是「可查證」，買家能拿 certNo 自己去對
    id: 'p-grade10-1', sellerId: 'u-grade10', mode: 'muteki',
    title: '滿分場 #30 · 全 PSA 10',
    ticketPrice: 3200, status: 'open', sold: 9, openedDaysAgo: 5,
    prizes: [ // 20 籤，票收 64,000、獎品總值 54,440 → 還元 85.1%
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
      /* 湊籤的 16 席原本是 flareonPSA ×1 + 砂鐵蜥 ×15（單價 120）。
         票價 3,200 的池配 120 元的墊底卡，還元率只有 76.3% —— 註解寫的 89.2%
         是拆掉重號那批卡之前的舊數字，沒有跟著改。高價池的墊底不能是銅板卡：
         付 3,200 抽到一張 120 的卡，那不是運氣不好，是池本身不合理。 */
      { tier: 'D', card: C.jolteon, total: 8 },
      { tier: 'D', card: C.vaporeon, total: 8 }
    ]
  },
  {
    // 個人賣家的小池，開得快、賣得也快：接近完抽的池在列表上要看得到
    id: 'p-promo-1', sellerId: 'u-promolab', mode: 'muteki',
    title: '促販卡 大亂鬥 第 7 回',
    /* **刻意停在舊制**（沒有宣告買回價），而且是 open 的 ——
       p-official-3 已經 revealed，抽不了，所以「舊池抽到的卡回收不了」
       這條迴歸需要一個還在賣的舊池。正式環境現有的池全部長這樣。 */
    legacyV2: true,
    ticketPrice: 250, status: 'open', sold: 25, openedDaysAgo: 1,
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
    id: 'p-seed-1', sellerId: 'u-seller', mode: 'muteki',
    title: '測試池：閃色寶藏 100 抽',
    /* 票價從 300 調到 3250。原本的獎品總值是 276,120，用 300 × 100 籤賣
       等於還元率 920% —— 賣一池賠九池，而且過不了平台自己的護欄。
       獎品組成不動（那是這個池的賣點），調票價讓它落在 85% 左右。 */
    ticketPrice: 3250, status: 'open', clientSeed: 'fixture:seed-1',
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
  const id = genId(d.id)
  const [exists] = await sql`select 1 from pools where id = ${id}`
  if (exists) return
  const clientSeed = d.clientSeed ?? `fixture:${id}`
  /* server_seed 一定要是密碼學隨機，不能寫死。
     commitHash、clientSeed、整份獎品清單都由 GET /v1/pools/:id 公開，
     只要 server_seed 可預測（例如寫死成 'a1' 重複 32 次，全空間才 256 種），
     任何人都能離線暴力比對 commit、還原出「哪個籤位是好卡」——
     開獎前的盲盒就被看穿了。改用 32 bytes 隨機值，這條路整個封死。
     （安全稽核 C-1：docs/security-audit.md） */
  const serverSeed = randomBytes(32).toString('hex')
  /* 種子池的 server_seed 也要過同一道低熵閘（security-audit C-1）。
     這條路正是當年 'b1'.repeat(32) 寫進正式資料庫的入口 ——
     產生端改對了還不夠，得讓錯的值從此寫不進去。 */
  assertSeedEntropy(serverSeed)
  const prizeDefs = d.prizes.map((p, i) => ({ ...p, id: `${id}-pr${i}` }))
  const total = prizeDefs.reduce((a, p) => a + p.total, 0)
  const openedAt = new Date(Date.now() - d.openedDaysAgo * 86_400_000)

  /* 示範賣家「宣告」的買回價：取標示市值的六成。
     這是**建構種子資料**時挑的一個合理示範值，不是執行期的算式 ——
     線上的買回價由賣家在建池表單上一格一格填，系統從來不從 refPrice 推導。
     六成是舊制回收區間（5–7 成）的中間值，讓示範資料的數字看起來跟以前一樣，
     這樣改動前後的畫面可以直接對照。 */
  const declaredBuyback = (refPrice: number) => Math.max(BUYBACK_MIN, Math.floor(refPrice * 0.6))

  const version: ManifestVersion = d.legacyV2 ? 2 : d.legacyV3 ? 3 : 4
  const withBuyback = prizeDefs.map(p => ({
    ...p,
    buyback: d.legacyV2 ? null : declaredBuyback((p.card as { refPrice?: number }).refPrice ?? 0)
  }))

  /* 種子池也走含獎品清單的承諾 ——
     示範資料如果停在 v1，那「開賣後換卡抓不到」的洞在展示與測試裡就永遠碰不到，
     而那正是最需要被測到的一條。版本照 d.legacyV2 決定：留一個 v2 的池，
     「舊池仍然驗得過」這條迴歸才有東西可驗。 */
  const manifest = withBuyback.map(p => {
    const c = p.card as {
      name?: string; setCode?: string | null; cardNo?: string | null
      grader?: string | null; grade?: number | null; certNo?: string | null
      refPrice?: number | null; variantId?: string | null
    }
    return {
      prizeId: p.id, tier: p.tier, total: p.total,
      name: c.name ?? '', setCode: c.setCode ?? null, cardNo: c.cardNo ?? null,
      grader: c.grader ?? null, grade: c.grade ?? null,
      certNo: c.certNo ?? null, refPrice: c.refPrice ?? null,
      buyback: p.buyback,
      variantId: c.variantId ?? null
    }
  })
  const manifestHash = await manifestHashOf(manifest, version)

  /* 保底回饋率。v2 的池沒有宣告買回價，所以算不出來 —— 它存的是舊制的
     還元率（return_ratio），那個數字留在資料庫裡不動。 */
  const ratio = d.legacyV2
    ? null
    : floorRatio(withBuyback.map(p => ({ tier: p.tier, qty: p.total, buyback: p.buyback ?? 0 })),
                 total, d.ticketPrice).ratio

  /* 種子走的是 insert，繞過了 POST /v1/pools 上的經濟護欄。
     繞過去的後果不是「示範資料醜一點」：示範池是所有人第一眼看到的東西，
     一個 Σ(買回價) 超過票收的池自己就是一台印鈔機。
     所以這裡自己補上同一道閘，而且是 throw 不是 warn ——
     算錯的池應該在 seed 就停下來，不是安靜地進資料庫。 */
  if (ratio !== null) {
    const gate = floorAllowed(ratio)
    if (!gate.allowed) throw new Error(`種子池 ${id} 過不了保底回饋率護欄：${gate.message}`)
  }

  /* v2 的舊池存的是舊制還元率（Σ 賣家標示市值 ÷ 票收），v3 存的是保底回饋率。
     兩個數字分開存在兩個欄位，不共用一欄 —— 意義不同，混在一起沒有辦法
     事後分辨哪一列是哪一種（見 migration 018）。 */
  const legacyReturn = d.legacyV2
    ? prizeDefs.filter(p => p.tier !== 'BUST')
        .reduce((a, p) => a + p.total * ((p.card as { refPrice?: number }).refPrice ?? 0), 0)
      / (total * d.ticketPrice) * 100
    : null

  await sql`
    insert into pools (id, seller_id, mode, title, ticket_price, total_tickets, status,
                       server_seed, commit_hash, manifest_hash, commit_version,
                       client_seed_source, client_seed,
                       shitei_tier, opened_at, revealed_at, return_ratio, floor_ratio,
                       expires_at, platform_fee_rate)
    values (${id}, ${d.sellerId}, ${d.mode}, ${d.title}, ${d.ticketPrice}, ${total}, ${d.status},
            ${serverSeed}, ${await commitV2(serverSeed, manifestHash)}, ${manifestHash}, ${version},
            ${clientSeed}, ${clientSeed},
            ${d.shiteiTier ?? null}, ${openedAt},
            ${d.status === 'revealed' ? new Date() : null},
            ${legacyReturn === null ? null : legacyReturn.toFixed(2)},
            ${ratio === null ? null : ratio.toFixed(2)},
            /* 池一定要有到期日。種子給 30 天，剛好長到示範資料不會在開發途中
               自己關掉，又短到「到期會關」這件事在種子裡也是真的。 */
            ${Date.now() + 30 * 86_400_000},
            /* 平台抽成先填 0。做成參數是為了改的時候只改一個地方 */
            ${0})
  `
  await sql`insert into pool_prizes ${sql(withBuyback.map(p => ({
    id: p.id, pool_id: id, tier: p.tier, card: p.card, total: p.total, buyback: p.buyback
  })) as never)}`

  const seq = await seatSequence(serverSeed, clientSeed, prizeDefs.map(p => ({ prizeId: p.id, total: p.total })))
  /* 已售出的籤直接標在 pool_seats 上，不補 draws / prizes ——
     這裡要的只是「這個池賣了多少」的畫面，補了反而會讓測試帳號的保管庫多出憑空的卡。 */
  const taken = pickSeats(total, d.sold, d.soldLayout ?? 'scatter')
  const takenAt = openedAt.getTime() + 3_600_000
  await sql`insert into pool_seats ${sql(seq.map((prizeId, i) => ({
    pool_id: id, seat: i + 1, prize_id: prizeId,
    taken_by: taken.has(i + 1) ? 'u-buyer' : null,
    taken_at: taken.has(i + 1) ? takenAt : null
  })) as never)}`
  console.log(`seed pool ${id}: 票價 ${d.ticketPrice} × ${total} 籤，` +
    (ratio === null ? `舊制 v2（無買回價）` : `保底回饋 ${ratio.toFixed(1)}%`) +
    `，已售 ${taken.size}，${d.status}`)
}

async function run() {
  /* 第一件事就是問「我要寫進哪裡」。任何一句 INSERT 之前 ——
     半灌進正式庫再中止，比完全沒跑更難收拾。 */
  assertSeedTargetIsDisposable()
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

/* 把「上一個世代」的示範池收攤。
   判準是**世代**不是「有沒有買回價」：只挑 client_seed 以 fixture: 開頭
   （＝種子建的）、還開著、而且 id 不屬於目前世代的池。

   第一版寫成「沒有買回價就收攤」，結果誤殺了 p-promo-1 —— 那是**刻意**
   停在舊制的示範池，存在的理由就是讓「舊池抽到的卡回收不了」這條迴歸
   有一個還在賣的對象。用世代判斷就不會誤傷：它屬於當前世代，留著。

   關掉不是刪掉：prizes.pool_id 是 not null 外鍵，刪池等於毀掉使用者
   卡冊裡已經抽到的卡。cancelled 只是停止販售，已抽出的卡與出貨流程照跑
   （見 rules.md 第七節）。

   條件寫得很窄是刻意的：真人開的池 client_seed 不是 fixture:，
   有買回價的新世代池也不符合 —— 這段永遠不會誤傷它們。 */
async function retireStalePools() {
  const rows = await sql`
    update pools set status = 'cancelled'
     where status = 'open'
       and client_seed like 'fixture:%'
       and id not like ${'%' + GEN}
    returning id
  `
  if (rows.length) console.log(`收攤舊世代示範池 ${rows.length} 個：${rows.map(r => r.id).join(', ')}`)
}

  for (const d of poolDefs) await seedPool(d)
  await retireStalePools()

  /* vault 掛單一定要有對應的 prizes 那一列 —— 「庫內轉移」的交付就是把那一列改 owner。
     原本種子只寫 listings 不寫 prizes，買家付了錢、賣家入了帳，卡卻不存在。
     （orders.ts 現在會擋掉這種掛單，但種子本來就不該產生它。）
     ship 通道不需要：那是託管訂單，卡由賣家實體寄送，平台手上沒有東西可以過戶。

     這一輪必須排在 seedPool 之後 —— prizes.pool_id 是 not null 外鍵，
     池還沒建好的時候查不到可掛的池，這正是上面那個迴圈不能順手做掉的原因。 */
  for (const [id, c, , sellerId, , delivery] of listings) {
    if (delivery !== 'vault') continue
    const [pool] = await sql<{ id: string }[]>`
      select id from pools where seller_id = ${sellerId} order by id limit 1
    `
    if (!pool) throw new Error(`vault 掛單 ${id} 的賣家 ${sellerId} 沒有任何池，無法建立對應的卡`)
    const prizeId = 'pz-' + id
    const wonAt = Date.now() - 3 * 86_400_000
    /* grader / cert_no 要跟抽卡那條路寫同一套正規化（upper(btrim) / nullif）——
       它們是 prizes_cert_alive 這條唯一索引的鍵，空著的話索引蓋不到這一列，
       示範資料就變成「唯一性防線的破口」而不是示範。
       custodian_id 是賣家：這張卡的實體本來就在他手上（origin='seed'）。 */
    const cardAny = c as unknown as { grader?: unknown; certNo?: unknown }
    const trimmed = (v: unknown) => {
      const t = typeof v === 'string' ? v.trim() : ''
      return t === '' ? null : t
    }
    const gr = trimmed(cardAny.grader)
    await sql`
      insert into prizes (id, user_id, pool_id, card, tier, status, won_at, acquired_at, stash_expires_at,
                          grader, cert_no, custodian_id, origin)
      values (${prizeId}, ${sellerId}, ${pool.id}, ${c as never}, 'B', 'listed',
              ${wonAt}, ${wonAt}, ${wonAt + 90 * 86_400_000},
              ${gr === null ? null : gr.toUpperCase()}, ${trimmed(cardAny.certNo)},
              ${sellerId}, 'seed')
      on conflict (id) do nothing
    `
    await sql`update listings set prize_id = ${prizeId} where id = ${id} and prize_id is null`
  }

  const [n] = await sql<{ count: string }[]>`select count(*)::text as count from listings where status = 'live'`
  const [pc] = await sql<{ count: string }[]>`select count(*)::text as count from pools`
  console.log(`seed done — ${n?.count ?? 0} 筆有效掛單、${pc?.count ?? 0} 個池`)
  await sql.end()
}
run().catch(e => { console.error(e); process.exit(1) })
