<script setup lang="ts">
/**
 * 自製卡盒視覺 —— 完全不使用任何廠商素材。
 *
 * 幾何：正面／側面／頂面 + 上方吊掛卡榫，全部用 CSS preserve-3d 疊成真實的
 * 立體，不是用漸層假裝厚度。傾斜時各面的面積真的改變。
 * 預設帶靜止傾角（rotateX 9° / rotateY -21°），不用互動也看得出是盒子。
 *
 * 吊掛卡榫（歐洲孔）是零售卡盒最好認的特徵之一 —— 它從盒頂突出、打一個
 * 圓孔，而且因為薄，會在盒蓋上投下一小段陰影。這個細節比任何光影都更能
 * 讓人第一眼認出「這是實體商品的包裝」。
 *
 * 正面美術刻意避開任何特定角色：屬性符號（火／水／葉／雷／晶／星）是通用
 * 圖形，放射光芒與光球負責 TCG 的儀式感。用寶可夢角色剪影會把自製包裝
 * 好不容易removed 的版權曝險放回來，而且剪影「一眼認得出是誰」，
 * 比抽象圖案更難主張合理使用。
 *
 * 品牌上維持「封存」：正面橫貼防拆封條，承諾雜湊直接印在上面。
 * 尺寸全部用 cqw，88px 縮圖到滿版共用同一套幾何。
 */
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import type { Tier } from '@/types/models'
import { useTilt } from '@/composables/useTilt'

const props = withDefaults(defineProps<{
  tier?: Tier
  label?: string
  serial?: string
  hash?: string
  /** 已開封：封條褪色、盒蓋掀起 */
  opened?: boolean
  /** 縮圖模式：拿掉小字，只留封條與封緘 */
  compact?: boolean
  /** 關掉游標傾斜，靜止傾角仍保留 */
  flat?: boolean
  /** 盒身材質。不給就依賞別自動選 */
  material?: 'grey' | 'silver' | 'gold'
  /** 特效。不給就依材質自動選（金=火、銀=雷、灰=晶） */
  effect?: 'fire' | 'bolt' | 'water' | 'leaf' | 'crystal' | 'star' | 'none'
  /**
   * 產品視窗要展示的卡圖網址。給了之後盒面會開一個斜擺的窗口把卡露出來 ——
   * 實體卡盒本來就靠這個告訴人「裡面裝什麼」。
   * 有卡圖時封緘會上移讓位，底部的文字標題也讓給卡片本身。
   */
  cardImage?: string
  /** 開啟撕條互動。拖動封條上的拉環就能撕開 */
  tearable?: boolean
}>(), {
  tier: 'D', label: '', serial: '', hash: '',
  opened: false, compact: false, flat: false,
  material: undefined, effect: undefined, cardImage: undefined, tearable: false
})

const emit = defineEmits<{ (e: 'torn'): void }>()

/**
 * 材質：灰／銀／金。這是獨立於賞別的一條「等級軸」——
 * 金屬感靠的不是單一顏色，而是明暗交錯的多段漸層，所以每種材質都要
 * 一組 lo/base/hi 三色，少了任何一段就會變成平塗的色塊。
 */
const MATERIALS = {
  /*
   * 灰是「霧面石墨」，不是「暗一點的銀」。
   * 先前灰銀同色系、同一套金屬處理，只差亮度，所以怎麼看都像 ——
   * 分級要靠材質本身的差異：霧面沒有鏡面反射，色階範圍窄；
   * 金屬則是寬色階加上銳利的亮帶。matte 旗標會切換封條的漸層演算法。
   *
   * 灰的封條整條偏暗，所以 ink 反過來要用亮色，否則字讀不到。
   */
  grey:   { lo: '#43484f', base: '#5c626a', hi: '#727982', rim: '#727982', ink: '#eef0f3', matte: true },
  silver: { lo: '#3b4148', base: '#939ba4', hi: '#f4f7fa', rim: '#ffffff', ink: '#14161a', matte: false },
  gold:   { lo: '#4f3709', base: '#b9862a', hi: '#f9e6a8', rim: '#ffeab4', ink: '#201704', matte: false }
} as const
export type PackMaterial = keyof typeof MATERIALS

/** 賞別預設對應的材質，呼叫端可用 material 覆寫 */
const TIER_MATERIAL: Record<Tier, PackMaterial> = {
  A: 'gold', LAST: 'gold', B: 'silver', C: 'silver', D: 'grey', BUST: 'grey'
}

/** 特效預設：金配火、銀配雷、灰不動 */
export type PackEffect = 'fire' | 'bolt' | 'water' | 'leaf' | 'crystal' | 'star' | 'none'

/**
 * 屬性色。兩條軸分工：材質（灰銀金）＝等級，屬性＝顏色。
 * 先前特效沿用材質色，結果銀盒上的火是白色的 —— 屬性的識別力整個浪費掉。
 *
 * 每個屬性三階：core 亮心、mid 主色、deep 邊緣。
 * star 刻意做成紫white 而不是金色，否則會跟 bolt 的電黃撞在一起。
 */
const ELEMENTS = {
  fire:    { core: '#ffe0ac', mid: '#ff8a3d', deep: '#e0391a', bodyHi: '#3a1a12', bodyLo: '#160805' },
  water:   { core: '#d4f2ff', mid: '#43b4f7', deep: '#1668d4', bodyHi: '#122b40', bodyLo: '#050e18' },
  leaf:    { core: '#e8ffd2', mid: '#63d84c', deep: '#1f9440', bodyHi: '#182d14', bodyLo: '#070f06' },
  bolt:    { core: '#fffce0', mid: '#ffe14d', deep: '#f59e00', bodyHi: '#332a10', bodyLo: '#120e04' },
  crystal: { core: '#e8faff', mid: '#6fd6ff', deep: '#3f7bff', bodyHi: '#14283a', bodyLo: '#060f18' },
  star:    { core: '#ffffff', mid: '#f0a8ff', deep: '#a44cff', bodyHi: '#251636', bodyLo: '#0d0616' },
  none:    { core: '#e9edf2', mid: '#aab3bd', deep: '#6b727c', bodyHi: '#26272b', bodyLo: '#0e0f11' }
} as const
const MATERIAL_EFFECT: Record<PackMaterial, PackEffect> = {
  gold: 'fire', silver: 'bolt', grey: 'crystal'
}

const mat = computed(() => MATERIALS[props.material ?? TIER_MATERIAL[props.tier]])
const matName = computed(() => props.material ?? TIER_MATERIAL[props.tier])
const fx = computed(() => props.effect ?? MATERIAL_EFFECT[matName.value])
const foil = computed(() => mat.value.base)

/**
 * 封條的色階。
 *  金屬：明暗交錯的九段，模擬鋁箔被不同角度的光打到的亮帶。
 *  霧面：三段極窄的落差，只有邊緣稍暗 —— 霧面材質沒有鏡面反射，
 *        給它金屬亮帶就會又變回「亮一點的銀」。
 */
const sealStops = computed(() => {
  const m = mat.value
  if (m.matte) {
    return [
      { o: '0%', c: m.lo }, { o: '18%', c: m.base }, { o: '52%', c: m.hi },
      { o: '84%', c: m.base }, { o: '100%', c: m.lo }
    ]
  }
  return [
    { o: '0%', c: m.lo }, { o: '10%', c: m.base }, { o: '24%', c: m.hi },
    { o: '36%', c: m.base }, { o: '50%', c: m.rim }, { o: '62%', c: m.base },
    { o: '78%', c: m.lo }, { o: '90%', c: m.hi }, { o: '100%', c: m.base }
  ]
})
const elem = computed(() => ELEMENTS[fx.value])
const hashChip = computed(() => (props.hash ? props.hash.slice(0, 10).toUpperCase() : ''))
const tierLabel = computed(() =>
  props.tier === 'LAST' ? '最後賞' : props.tier === 'BUST' ? '爆賞' : `${props.tier} 賞`
)
/* 封條上的賞別拆成兩截排版：字母當主字、「賞」當附屬。
   整串同級同色就只是一行字，拆開才有主從。 */
const tierMark = computed(() =>
  props.tier === 'LAST' ? { big: 'L', small: '最後賞' }
  : props.tier === 'BUST' ? { big: 'X', small: '爆賞' }
  : { big: props.tier, small: '賞' }
)
/** 序號拆分子母：001 是主角，/080 是註記 */
const serialParts = computed(() => {
  const raw = props.serial || ''
  const m = raw.match(/(\d+)\s*\/\s*(\d+)/)
  return m ? { n: m[1], total: m[2] } : { n: raw.slice(-3), total: '' }
})
/**
 * uid 必須在同一頁面的所有盒子之間保證唯一 —— SVG 的 <linearGradient>／
 * <clipPath> 用 id 全域查找，不受個別 <svg> 樹的邊界限制。兩個盒子若 id
 * 相撞，後面那個會直接借用前一個的 <defs>（顏色、裁切路徑全部跑掉）。
 *
 * 舊版從 tier/material/label 等 props 組字串再清掉符號當 id，先踩到兩個坑：
 *  1. `.replace(/\W/g, '')` 只認 ASCII，中文字全被當非字元清空，
 *     不同盒子的標籤清空後可能變成同一個空字串
 *  2. 即使改成雜湊涵蓋所有欄位，只要兩個盒子的 props 剛好完全相同
 *     （這個展示頁就有 —— 同一個賞別在「材質」列、「各賞別」格、
 *     「未開封/已開封」對照三處重複出現），還是會撞出內容相同但
 *     仍然重複的 id，不合法。
 * 用 Vue 3.5 的 useId() 直接拿元件實例的唯一 id，跟 props 內容無關，
 * 徹底避免這整類問題。useId() 必須在 setup 階段同步呼叫（它讀取的是
 * setup context，包進 computed 的 getter 裡會在 context 之外延遲執行），
 * 所以宣告成一般常數，不是 computed —— 反正實例 id 本來就不會變。
 */
const uid = `bx${useId().replace(/:/g, '')}`

const { el, rx, ry, gx, gy, active, onMove, reset } = useTilt(9)

/* ---- 撕條互動 ----
   tearX 是撕開進度，用 viewBox 的 0–300 當單位，跟繪圖座標一致。

   位移用「相對拖曳距離」而不是「指標的絕對位置」：盒子有 rotateY(-17°)
   與 rotateX(3°)，clientX 換算回 viewBox 座標會被透視扭曲，算出來的
   撕開點會跟手指對不上。相對位移不受變形影響。 */
const TEAR_MAX = 300
const TEAR_COMMIT = 232        // 過這個點就算撕開，不再彈回
const tearX = ref(0)
const tearing = ref(false)
const torn = ref(false)
let tearStartX = 0
let tearStartVal = 0
let tearSpanPx = 1
let tearRaf = 0

/** 盒蓋掀起 / 封條褪色，撕開與外部傳入的 opened 兩者其一都算 */
const isOpen = computed(() => props.opened || torn.value)

function commitTear() {
  tearing.value = false
  torn.value = true
  tearX.value = TEAR_MAX
  emit('torn')
}

/** 點一下（沒有拖）也要能撕 —— 用補間把進度推到底 */
function tweenTear() {
  const from = tearX.value
  const t0 = performance.now()
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / 520)
    // easeOutCubic：撕開一開始快、末端收慢，像紙真的被扯斷
    tearX.value = from + (TEAR_MAX - from) * (1 - Math.pow(1 - k, 3))
    if (k < 1) tearRaf = requestAnimationFrame(step)
    else commitTear()
  }
  tearRaf = requestAnimationFrame(step)
}

function onTearDown(e: PointerEvent) {
  if (!props.tearable || torn.value) return
  e.stopPropagation()          // 別讓拖撕條同時觸發盒子傾斜
  cancelAnimationFrame(tearRaf)
  // 先進入拖曳狀態，再嘗試指標捕捉。
  // setPointerCapture 會在指標非活躍時丟 NotFoundError，而 `?.` 只防
  // 「方法不存在」不防「方法丟例外」—— 放在前面的話一失敗就會中斷整個
  // handler，tearing 永遠設不起來，拖曳直接失效。捕捉只是加分項，不是前提。
  tearing.value = true
  try {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  } catch { /* 捕捉失敗不影響拖曳，只是指標移出元素後會斷 */ }
  tearStartX = e.clientX
  tearStartVal = tearX.value
  tearSpanPx = stage.value?.getBoundingClientRect().width || 1
}

function onTearMove(e: PointerEvent) {
  if (!tearing.value) return
  e.stopPropagation()
  const dx = ((e.clientX - tearStartX) / tearSpanPx) * TEAR_MAX
  tearX.value = Math.max(0, Math.min(TEAR_MAX, tearStartVal + dx))
  if (tearX.value >= TEAR_COMMIT) commitTear()
}

function onTearUp(e: PointerEvent) {
  if (!tearing.value) return
  e.stopPropagation()
  tearing.value = false
  // 幾乎沒動 = 當成點擊，直接補間撕開；否則彈回
  if (Math.abs(e.clientX - tearStartX) < 4) tweenTear()
  else if (!torn.value) tearX.value = 0
}

onBeforeUnmount(() => cancelAnimationFrame(tearRaf))

/** 撕開處的鋸齒邊，隨進度長出來 */
const tearEdge = computed(() => {
  const x = tearX.value
  let d = `M${x.toFixed(1)} 72`
  for (let y = 72; y < 120; y += 8) {
    const j = (y / 8) % 2 ? 5 : -5
    d += ` L${(x + j).toFixed(1)} ${Math.min(120, y + 8)}`
  }
  return d
})

/**
 * 離屏暫停。
 *
 * 這是效能上最划算的一項：抽選列表捲到一半時，畫面外可能還有十幾個盒子，
 * 每個都在跑十幾個 SVG 動畫（實測整頁 343 個動畫元素、但視窗內只有 4 個盒子）。
 * 瀏覽器不會自己停掉看不見的 CSS 動畫，得自己用 IntersectionObserver 關。
 * 停掉動畫後，套在火／水上的濾鏡結果也能被快取，不必每幀重算。
 */
const visible = ref(true)
let io: IntersectionObserver | undefined
const stage = ref<HTMLElement | null>(null)

onMounted(() => {
  if (!stage.value || typeof IntersectionObserver === 'undefined') return
  io = new IntersectionObserver(
    ([entry]) => { visible.value = entry.isIntersecting },
    { rootMargin: '120px' }   // 提早一點恢復，捲到時已經在動
  )
  io.observe(stage.value)
})
onBeforeUnmount(() => io?.disconnect())

/**
 * 低效能裝置分級。
 *
 * 不用「是不是觸控裝置」一刀切 —— 那會讓所有手機都失去火水的亂流質感，
 * 而那正是最有價值的部分。只在真的跑不動的條件下降級：
 * 省流量模式、記憶體 4GB 以下、核心數 4 以下。
 */
const lowPower = (() => {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & {
    deviceMemory?: number
    connection?: { saveData?: boolean }
  }
  if (nav.connection?.saveData) return true
  if ((nav.deviceMemory ?? 8) <= 4) return true
  if ((nav.hardwareConcurrency ?? 8) <= 4) return true
  return false
})()

/** 低階裝置砍粒子數量 —— 密度降低但構圖不變，比整個關掉好 */
const budget = <T,>(arr: T[], lowCount: number) => (lowPower ? arr.slice(0, lowCount) : arr)

/**
 * 靜止傾角。
 *
 * rotateX 從 9° 收到 3°：原本仰角太重，配上過短的透視距離會讓盒子
 * 底部誇張外擴成梯形，讀起來像從下往上看。產品照的相機大致與物件等高，
 * 只留一點點俯角交代頂面的存在就好。
 * rotateY 保留 -17°，側面還是要看得到 —— 那是立體感的來源。
 */
const REST_X = 3, REST_Y = -17

const boxTransform = computed(() => {
  const x = REST_X + (props.flat ? 0 : rx.value)
  const y = REST_Y + (props.flat ? 0 : ry.value)
  return `rotateX(${x}deg) rotateY(${y}deg)`
})

/* 500 單位高的版面。有產品視窗時封緘要往上讓位，
   否則會壓在卡片上，兩個視覺重心互相打架。 */
const CY = computed(() => {
  if (props.compact) return 258
  return props.cardImage ? 196 : 244
})
/** 產品視窗只在正常尺寸顯示 —— 縮圖下卡圖只有十幾 px，糊成一團反而扣分 */
const showWindow = computed(() => !!props.cardImage && !props.compact)

/**
 * 縮圖不掛亂流濾鏡。
 *
 * feTurbulence 是逐像素運算，是這個元件裡最貴的一項。而列表縮圖大約
 * 88px 寬、正面實際只算繪到 ~62px，viewBox 卻是 300 單位 —— 縮放比約 0.21，
 * scale=26 的位移換算到螢幕上不到 6px，再被縮圖本身的取樣抹平，
 * 幾乎看不出差別。抽選列表一次可能出現二三十個盒子，這裡省下來最有感。
 */
const heavyFx = computed(() => !props.compact && !lowPower)
const warpFilter = (kind: 'fire' | 'water') =>
  heavyFx.value ? `url(#${uid}-${kind}Warp)` : undefined

/**
 * 屬性符號環。通用圖形，不對應任何特定角色 ——
 * 火、水、葉、雷、晶、星，是這個品類共通的視覺語彙。
 */
const GLYPHS = [
  'M0 -9 C4.5 -3 7 0 7 3.4 A7 7 0 0 1 -7 3.4 C-7 -0.4 -3 -2 0 -9 Z',            // 火
  'M0 -9.5 C5.5 -3 7.5 0.6 7.5 3.6 A7.5 7.5 0 0 1 -7.5 3.6 C-7.5 0.6 -5.5 -3 0 -9.5 Z', // 水
  'M0 -9 C7 -4.5 7.5 4 0 9 C-7.5 4 -7 -4.5 0 -9 Z',                              // 葉
  'M-2.6 -9.5 L4.2 -1.6 L0.4 -0.9 L3.2 9.5 L-3.8 1 L0 0.2 Z',                    // 雷
  'M0 -9.5 L6 -2.4 L3.2 8.6 L-3.2 8.6 L-6 -2.4 Z',                               // 晶
  'M0 -9.5 Q1.5 -1.6 9.5 0 Q1.5 1.6 0 9.5 Q-1.5 1.6 -9.5 0 Q-1.5 -1.6 0 -9.5 Z'  // 星
]

/** 符號沿上方弧線排開，避開中央封緘 */
const glyphRing = computed(() =>
  GLYPHS.map((d, i) => {
    const a = (-152 + i * 24.8) * (Math.PI / 180)
    return { d, x: 150 + Math.cos(a) * 108, y: CY.value + Math.sin(a) * 108 }
  })
)

/* ---- 火：連續火牆 ----
   關鍵是「一整片連續的火」而不是幾根分開的小火苗。真實的大火是連續的
   質量、邊緣被亂流撕開；分開的水滴狀色塊不論怎麼縮放都像蠟燭。
   三層由深到亮疊加，各自不同週期與漂移方向，讓它們永遠不同步 ——
   同步的火焰會整片一起脹縮，那是最假的一種。
   路徑左右都超出畫布（-30 → 330），橫向漂移時不會露出邊緣。 */
const FIRE_LAYERS = [
  {
    d: 'M-30 415 C-10 330 10 360 30 270 C48 340 62 300 82 200 C100 300 118 260 140 160 '
     + 'C158 270 175 230 196 280 C214 220 232 290 252 240 C268 300 290 330 330 415 Z',
    dur: '3.1s', delay: '0s', op: .72, drift: 13
  },
  {
    d: 'M-30 415 C-5 350 18 375 42 300 C62 360 80 320 104 240 C124 330 142 290 164 220 '
     + 'C182 310 200 270 222 320 C240 280 262 340 330 415 Z',
    dur: '2.3s', delay: '-.8s', op: .9, drift: -10
  },
  {
    d: 'M-20 415 C5 370 30 390 56 340 C76 385 96 355 120 300 C140 370 158 340 180 290 '
     + 'C198 355 218 330 240 360 C258 335 280 375 320 415 Z',
    dur: '1.7s', delay: '-1.4s', op: .95, drift: 7
  }
]

/** 火星：被熱氣帶上去的餘燼，越高越淡 */
const EMBERS = [
  { x: 46, r: 2.2, d: '0s' }, { x: 88, r: 1.4, d: '-2.6s' }, { x: 126, r: 2.8, d: '-1.2s' },
  { x: 168, r: 1.8, d: '-3.4s' }, { x: 208, r: 2.4, d: '-.7s' }, { x: 252, r: 1.6, d: '-2.1s' },
  { x: 106, r: 1.2, d: '-4.2s' }, { x: 228, r: 2, d: '-3.8s' }
]

/* ---- 雷：分叉主幹 ----
   真實閃電是一條有分叉的主幹，不是三根獨立的鋸齒。
   主幹從上竄到下，沿途甩出短分支。 */
const BOLT_MAIN = 'M138 40 L164 130 L146 136 L178 214 L156 220 L186 320'
const BOLT_FORKS = [
  'M164 130 L196 168 L182 172',
  'M178 214 L142 250 L156 254',
  'M146 136 L112 186'
]

/* ---- 其餘四種屬性特效的粒子 ----
   共通做法：外層 <g> 負責定位，內層元素跑 CSS 動畫。
   位置與延遲刻意錯開，避免整組同步跳動而讀成「圖案」。 */

/* ---- 水：翻湧的水體 ----
   從「地板上的漣漪」改成「淹上來的水」。漣漪只會讀成靜止水面，
   洪水要的是有厚度、表面在翻的水體。
   三層波浪各自不同波長與速度橫向捲動，疊出雜亂的水面。 */

/**
 * 產生一條正弦波輪廓，下方封成實心水體。
 * 路徑寬度必須是波長的整數倍且左右各多出一個波長 ——
 * 橫向平移剛好一個波長時才會無縫接回，否則捲動會看到接縫跳動。
 */
function wavePath(baseY: number, amp: number, len: number): string {
  const x0 = -len * 2
  const x1 = 300 + len * 2
  let d = `M${x0} ${baseY}`
  for (let x = x0; x < x1; x += len) {
    d += ` Q${(x + len * 0.25).toFixed(1)} ${(baseY - amp).toFixed(1)} ${(x + len * 0.5).toFixed(1)} ${baseY}`
    d += ` Q${(x + len * 0.75).toFixed(1)} ${(baseY + amp).toFixed(1)} ${(x + len).toFixed(1)} ${baseY}`
  }
  return `${d} L${x1} 520 L${x0} 520 Z`
}

const WAVES = [
  { d: wavePath(366, 16, 150), len: 150, dur: '7s',   delay: '0s',    op: .34 },
  { d: wavePath(392, 21, 110), len: 110, dur: '4.6s', delay: '-1.8s', op: .5 },
  { d: wavePath(418, 13, 190), len: 190, dur: '9s',   delay: '-3.1s', op: .72 }
]

/** 浪尖的白沫線，跟著最前排的浪一起走 */
const FOAM_D = wavePath(418, 13, 190)

/** 水中氣泡與飛濺 */
const BUBBLES = [
  { x: 42, r: 4, d: '0s' }, { x: 96, r: 2.6, d: '-2.1s' }, { x: 148, r: 5.2, d: '-1.1s' },
  { x: 194, r: 3, d: '-3.2s' }, { x: 246, r: 4.4, d: '-1.7s' }, { x: 122, r: 2.2, d: '-2.7s' },
  { x: 272, r: 3.2, d: '-3.9s' }, { x: 68, r: 2.8, d: '-4.6s' }
]

/**
 * 可重現的亂數。粒子要「多而有變化」才細緻，手刻幾顆一定看得出規律；
 * 但又不能用 Math.random —— 每次 render 位置都跳掉。固定種子的 PRNG
 * 兩者兼顧：分布夠亂，重繪後完全一致。
 */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** 讓數值落在 [a,b) */
const span = (r: () => number, a: number, b: number) => a + r() * (b - a)

/* ---- 葉：被風捲起的落葉 ----
   14 片、深度分層：遠的小而淡且慢，近的大而實且快。
   單一尺寸的葉子飄下來會像貼紙，深度差才有空間感。 */
const LEAVES = (() => {
  const r = mulberry32(91)
  return Array.from({ length: 14 }, () => {
    const depth = r()                       // 0 = 遠, 1 = 近
    return {
      x: span(r, -20, 320),
      s: span(r, 0.42, 1.25) * (0.55 + depth * 0.6),
      op: 0.3 + depth * 0.6,
      rot: span(r, -80, 80),
      dur: `${span(r, 8.5, 4.2).toFixed(2)}s`,
      d: `-${span(r, 0, 9).toFixed(2)}s`,
      sway: `${span(r, 24, 64).toFixed(0)}px`
    }
  })
})()
/** 帶中肋的葉形 —— 純色橢圓讀不出是葉子 */
const LEAF_D = 'M0 -12 C10 -7 10 7 0 12 C-10 7 -10 -7 0 -12 Z'
const LEAF_VEIN_D = 'M0 -9 L0 9'

/* ---- 晶：地面長出的晶簇 + 懸浮碎晶 ----
   每塊都拆成亮面與暗面兩個多邊形 —— 單色填充的多邊形讀起來是紙片，
   有明暗分面才像有厚度的結晶。 */
const CRYSTAL_SPIKES = [
  { x: 44, h: 96, w: 20, d: '0s' },
  { x: 88, h: 148, w: 26, d: '-1.4s' },
  { x: 150, h: 210, w: 32, d: '-2.6s' },
  { x: 214, h: 132, w: 24, d: '-0.7s' },
  { x: 262, h: 78, w: 18, d: '-3.1s' }
]
const SHARDS = (() => {
  const r = mulberry32(23)
  return Array.from({ length: 7 }, () => {
    const depth = r()
    return {
      x: span(r, 24, 276),
      y: span(r, 150, 430),
      s: (0.5 + depth * 0.85),
      op: 0.35 + depth * 0.5,
      dur: `${span(r, 5.2, 2.8).toFixed(2)}s`,
      d: `-${span(r, 0, 5).toFixed(2)}s`
    }
  })
})()
/** 拆成左右兩面，中線是稜 */
const SHARD_LIT_D = 'M0 -15 L9 -4 L5 14 L0 14 Z'
const SHARD_DARK_D = 'M0 -15 L-9 -4 L-5 14 L0 14 Z'

/* ---- 星：有深度的星場 ----
   分三種尺度：大量細碎星點（背景）、少數十字星芒（前景）、偶爾一顆流星。
   全部同尺寸的星星會讀成點陣圖案，尺度差才有宇宙的縱深。 */
const STAR_DUST = (() => {
  const r = mulberry32(57)
  return Array.from({ length: 34 }, () => ({
    x: span(r, 8, 292),
    y: span(r, 140, 470),
    rad: span(r, 0.5, 1.9),
    op: span(r, 0.25, 0.9),
    dur: `${span(r, 3.6, 1.4).toFixed(2)}s`,
    d: `-${span(r, 0, 4).toFixed(2)}s`
  }))
})()
/** 十字星芒：只留 5 顆當視覺重點，太多會變雜訊 */
const STAR_FLARES = [
  { x: 62, y: 178, s: 1.15, d: '0s' },
  { x: 238, y: 228, s: 0.85, d: '-1.3s' },
  { x: 118, y: 372, s: 1, d: '-2.4s' },
  { x: 206, y: 424, s: 0.7, d: '-0.8s' },
  { x: 150, y: 148, s: 0.9, d: '-3.1s' }
]
const SPARK_D = 'M0 -15 Q1.9 -2.2 15 0 Q1.9 2.2 0 15 Q-1.9 2.2 -15 0 Q-1.9 -2.2 0 -15 Z'
/** 流星：斜劃過去，帶一條漸淡的尾巴 */
const METEOR_D = 'M0 0 L-46 26'

/* ---- 體積光束 ----
   從盒頂斜射進來的光。六種屬性共用，只換顏色。
   加這個的理由：粒子全部集中在中段與底部，上半只有漸層，畫面是空的。
   光束把上下串起來，也是實體卡盒美術很常見的構圖骨架。
   角度統一偏右下，跟盒身左上的主光方向一致。 */
const SHAFTS = [
  { x1: 18,  w: 26, spread: 54, op: .17, dur: '11s', d: '0s' },
  { x1: 74,  w: 44, spread: 88, op: .11, dur: '14s', d: '-4s' },
  { x1: 152, w: 20, spread: 46, op: .2,  dur: '9s',  d: '-6.5s' },
  { x1: 206, w: 36, spread: 74, op: .09, dur: '16s', d: '-2s' }
]
/** 上寬下擴的梯形，超出畫布下緣讓它看起來是「射出去」而不是一段線 */
const shaftPath = (x1: number, w: number, spread: number) =>
  `M${x1} -10 L${x1 + w} -10 L${x1 + w + spread} 520 L${x1 + spread - 14} 520 Z`

/** 封緘後方的放射光芒 */
const rays = computed(() =>
  Array.from({ length: 16 }, (_, i) => ({
    a: i * 22.5,
    o: i % 2 ? 0.05 : 0.11
  }))
)
</script>

<template>
  <div
    ref="stage"
    class="stage"
    :class="{ opened: isOpen, tilting: !flat, active, paused: !visible }"
    :style="{ '--pk-body-hi': elem.bodyHi, '--pk-body-lo': elem.bodyLo }"
    @pointermove="flat || onMove($event)"
    @pointerleave="flat || reset()"
  >
    <div ref="el" class="box" :style="{ transform: boxTransform }">
      <!-- 吊掛卡榫：貼在盒背、從盒頂突出，中間打歐洲孔 -->
      <div class="face tab">
        <svg viewBox="0 0 200 62" aria-hidden="true">
          <defs>
            <!-- 盒身固定象牙色，不隨站台主題翻轉 —— 卡盒是獨立於頁面配色的
                 實體物件，深色頁面上要靠它自己跳出來，不是跟著背景變 -->
            <linearGradient :id="`${uid}-tab`" x1="0" y1="0" x2="0.2" y2="1">
              <stop offset="0%" :stop-color="elem.bodyHi" />
              <stop offset="100%" :stop-color="elem.bodyLo" />
            </linearGradient>
          </defs>
          <!-- 卡榫本體 + 歐洲孔（evenodd 打穿） -->
          <path
            fill-rule="evenodd" :fill="`url(#${uid}-tab)`"
            d="M22 62 L22 20 Q22 6 42 6 L158 6 Q178 6 178 20 L178 62 Z
               M100 22 m-7.5 6.5 a11 11 0 1 1 15 0 l-2 9 a5.5 5.5 0 0 1 -11 0 Z"
          />
          <path
            fill="none" stroke="#fff" stroke-opacity=".16"
            d="M22 62 L22 20 Q22 6 42 6 L158 6 Q178 6 178 20 L178 62"
          />
          <!-- 孔的內緣：上暗下亮，暗示紙板厚度 -->
          <path fill="none" stroke="#000" stroke-opacity=".6" stroke-width="2"
                d="M100 22 m-7.5 6.5 a11 11 0 1 1 15 0" />
          <path fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="1.5"
                d="M92.5 28.5 l-2 9 a5.5 5.5 0 0 0 11 0" />
          <rect x="22" y="48" width="156" height="14" :fill="foil" opacity=".2" />
        </svg>
      </div>

      <!-- 頂面 -->
      <div class="face top">
        <span class="top-foil" :style="{ background: foil }"></span>
        <!-- 卡榫在盒蓋上的落影，這道影子是「突出物」讀得出來的關鍵 -->
        <span class="tab-shadow"></span>
      </div>

      <!-- 右側面 -->
      <div class="face side">
        <span class="side-stripe" :style="{ background: foil }"></span>
        <!-- 盒蓋接縫必須繞過側面。正面 y=96/400 = 24%，數字不一致的話
             轉角處會斷開一截，那是最容易被看出來的破綻。 -->
        <span class="side-seam"></span>
        <!-- 上下摺邊：紙盒的頂蓋與底蓋都會壓出一道摺線 -->
        <span class="side-crease top"></span>
        <span class="side-crease bottom"></span>
        <span class="side-text">VAULTDRAW</span>
      </div>

      <!-- 正面 -->
      <div class="face front">
        <svg viewBox="0 0 300 500" role="img"
             :aria-label="label ? `${label} 卡盒` : '卡盒'">
          <defs>
            <!-- 盒身用屬性色的「深色去飽和版」而不是飽和色 ——
                 飽和的底色會把同色系的粒子整個吃掉，亮色粒子需要暗底才壓得出來。 -->
            <linearGradient :id="`${uid}-card`" x1="0" y1="0" x2="0.35" y2="1">
              <stop offset="0%" :stop-color="elem.bodyHi" />
              <stop offset="52%" :stop-color="elem.bodyLo" />
              <stop offset="100%" :stop-color="elem.bodyLo" />
            </linearGradient>

            <!-- 金屬感靠明暗交錯的多段漸層，不是單色加白 -->
            <linearGradient :id="`${uid}-seal`" x1="0" y1="0" x2="1" y2="0.35">
              <stop v-for="(st, i) in sealStops" :key="i" :offset="st.o" :stop-color="st.c" />
            </linearGradient>

            <!-- 火焰漸層：底部亮心，往上收成材質色 -->
            <linearGradient :id="`${uid}-flame`" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" :stop-color="elem.core" />
              <stop offset="30%" :stop-color="elem.mid" stop-opacity=".92" />
              <stop offset="72%" :stop-color="elem.deep" stop-opacity=".5" />
              <stop offset="100%" :stop-color="elem.deep" stop-opacity="0" />
            </linearGradient>

            <radialGradient :id="`${uid}-emberglow`" cx="0.5" cy="1" r="0.75">
              <stop offset="0%" :stop-color="elem.mid" stop-opacity=".55" />
              <stop offset="55%" :stop-color="elem.deep" stop-opacity=".22" />
              <stop offset="100%" :stop-color="elem.deep" stop-opacity="0" />
            </radialGradient>

            <radialGradient :id="`${uid}-orb`">
              <stop offset="0%" :stop-color="elem.mid" stop-opacity=".6" />
              <stop offset="40%" :stop-color="elem.deep" stop-opacity=".26" />
              <stop offset="100%" :stop-color="elem.deep" stop-opacity="0" />
            </radialGradient>

            <linearGradient :id="`${uid}-lit`" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#fff" stop-opacity=".09" />
              <stop offset="42%" stop-color="#fff" stop-opacity="0" />
              <stop offset="100%" stop-color="#000" stop-opacity=".38" />
            </linearGradient>

            <!-- 亂流位移：讓火與水的邊緣被撕成不規則，這是「像真的」與
                 「像圖案」的分界。seed 固定不動 —— 動 baseFrequency 或 seed
                 會強迫瀏覽器每一幀重算整張雜訊圖，非常貴；讓底下的形狀
                 移動穿過這張靜態雜訊場，一樣會得到不斷變化的扭曲，
                 但雜訊只算一次。 -->
            <filter v-if="heavyFx" :id="`${uid}-fireWarp`" x="-25%" y="-25%" width="150%" height="150%">
              <feTurbulence type="fractalNoise" baseFrequency="0.013 0.032"
                            numOctaves="2" seed="7" result="n" />
              <feDisplacementMap in="SourceGraphic" in2="n" scale="26"
                                 xChannelSelector="R" yChannelSelector="G" />
              <feGaussianBlur stdDeviation="1.4" />
            </filter>

            <filter v-if="heavyFx" :id="`${uid}-waterWarp`" x="-25%" y="-25%" width="150%" height="150%">
              <feTurbulence type="fractalNoise" baseFrequency="0.02 0.012"
                            numOctaves="2" seed="3" result="n" />
              <feDisplacementMap in="SourceGraphic" in2="n" scale="13"
                                 xChannelSelector="R" yChannelSelector="G" />
              <feGaussianBlur stdDeviation="0.7" />
            </filter>

            <!-- 火的縱向色階：底部白熱、中段主色、頂端散成煙 -->
            <linearGradient :id="`${uid}-fireBody`" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" :stop-color="elem.core" />
              <stop offset="14%" :stop-color="elem.mid" />
              <stop offset="52%" :stop-color="elem.deep" />
              <stop offset="82%" :stop-color="elem.deep" stop-opacity=".55" />
              <stop offset="100%" :stop-color="elem.deep" stop-opacity="0" />
            </linearGradient>

            <!-- 水體：越深越暗，表面偏亮 -->
            <linearGradient :id="`${uid}-waterBody`" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" :stop-color="elem.core" stop-opacity=".9" />
              <stop offset="18%" :stop-color="elem.mid" />
              <stop offset="100%" :stop-color="elem.deep" />
            </linearGradient>

            <!-- 印刷網點：比纖維更粗一階的規律紋理，疊在一起才像印刷品 -->
            <pattern :id="`${uid}-print`" width="3" height="3" patternUnits="userSpaceOnUse">
              <rect width="3" height="3" fill="none" />
              <circle cx="1" cy="1" r="0.42" fill="#000" fill-opacity=".055" />
            </pattern>

            <!-- 主光：偏左上的柔和熱點。單一線性漸層打光是 CG 感的來源之一，
                 實際受光一定有一個方向性的亮區。 -->
            <radialGradient :id="`${uid}-key`" cx="0.28" cy="0.18" r="0.85">
              <stop offset="0%" stop-color="#fff" stop-opacity=".3" />
              <stop offset="42%" stop-color="#fff" stop-opacity=".07" />
              <stop offset="100%" stop-color="#fff" stop-opacity="0" />
            </radialGradient>

            <!-- 接縫的環境遮蔽。硬邊 1px 線讀起來是「畫上去的線」，
                 真實的縫隙是有寬度的柔和暗帶。 -->
            <linearGradient :id="`${uid}-aoDown`" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#000" stop-opacity=".34" />
              <stop offset="100%" stop-color="#000" stop-opacity="0" />
            </linearGradient>
            <linearGradient :id="`${uid}-aoUp`" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stop-color="#000" stop-opacity=".28" />
              <stop offset="100%" stop-color="#000" stop-opacity="0" />
            </linearGradient>

            <radialGradient :id="`${uid}-vig`" cx="0.5" cy="0.48" r="0.7">
              <stop offset="52%" stop-color="#000" stop-opacity="0" />
              <!-- 象牙底下 .5 的黑色暗角會偏濁髒，收到 .4 維持乾淨 -->
              <stop offset="100%" stop-color="#000" stop-opacity=".4" />
            </radialGradient>
          </defs>

          <rect x="0" y="0" width="300" height="500" :fill="`url(#${uid}-card)`" />

          <!-- 放射光芒：封緘後方的儀式感 -->
          <g :transform="`translate(150 ${CY})`" :fill="elem.mid">
            <path
              v-for="(r, i) in rays" :key="i"
              :transform="`rotate(${r.a})`" :opacity="r.o"
              d="M-7 -40 L7 -40 L2.5 -168 L-2.5 -168 Z"
            />
          </g>

          <circle cx="150" :cy="CY" r="118" :fill="`url(#${uid}-orb)`" />

          <!-- 火：連續火牆 + 餘燼 -->
          <g v-if="fx === 'fire' && !isOpen" class="fire">
            <ellipse cx="150" cy="504" rx="168" ry="112" :fill="`url(#${uid}-emberglow)`" />
            <!-- 整組套亂流位移，邊緣才會被撕開而不是平滑的曲線 -->
            <g :filter="warpFilter('fire')">
              <path
                v-for="(f, i) in FIRE_LAYERS" :key="i"
                class="fireLayer" :d="f.d"
                :fill="`url(#${uid}-fireBody)`" :opacity="f.op"
                :style="{ animationDuration: f.dur, animationDelay: f.delay, '--drift': f.drift + 'px' }"
              />
            </g>
            <g class="embers">
              <circle
                v-for="(e, i) in budget(EMBERS, 4)" :key="i"
                class="ember" :cx="e.x" cy="500" :r="e.r"
                :fill="elem.core" :style="{ animationDelay: e.d }"
              />
            </g>
          </g>

          <!-- 雷：分叉主幹 + 全屏爆光 -->
          <g v-if="fx === 'bolt' && !isOpen" class="bolts">
            <rect class="boltFlash" x="0" y="0" width="300" height="500" :fill="elem.mid" />
            <g class="boltStrike" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <!-- 外層粗描邊做輝光，內層細白線做電芯 -->
              <path :d="BOLT_MAIN" :stroke="elem.mid" stroke-width="9" opacity=".45" />
              <path v-for="(f, i) in BOLT_FORKS" :key="i" :d="f"
                    :stroke="elem.mid" stroke-width="5" opacity=".4" />
              <path :d="BOLT_MAIN" :stroke="elem.core" stroke-width="3" />
              <path v-for="(f, i) in BOLT_FORKS" :key="'f' + i" :d="f"
                    :stroke="elem.core" stroke-width="1.8" />
            </g>
          </g>

          <!-- 水：翻湧水體 + 白沫 + 氣泡 -->
          <g v-if="fx === 'water' && !isOpen" class="water">
            <g :filter="warpFilter('water')">
              <path
                v-for="(w, i) in WAVES" :key="i"
                class="wave" :d="w.d"
                :fill="`url(#${uid}-waterBody)`" :opacity="w.op"
                :style="{ animationDuration: w.dur, animationDelay: w.delay, '--len': `-${w.len}px` }"
              />
              <path class="wave foam" :d="FOAM_D" fill="none"
                    :stroke="elem.core" stroke-width="2.5" opacity=".75"
                    :style="{ animationDuration: '9s', animationDelay: '-3.1s', '--len': '-190px' }" />
            </g>
            <g v-for="(b, i) in budget(BUBBLES, 4)" :key="'b' + i" :transform="`translate(${b.x} 496)`">
              <circle class="bubble" :r="b.r" :fill="elem.core" fill-opacity=".22"
                      :stroke="elem.core" stroke-width="1.5" :style="{ animationDelay: b.d }" />
            </g>
          </g>

          <!-- 葉：被風捲起的落葉，深度分層 -->
          <g v-if="fx === 'leaf' && !isOpen" class="leaves">
            <g v-for="(l, i) in budget(LEAVES, 6)" :key="i"
               :transform="`translate(${l.x.toFixed(1)} -30) scale(${l.s.toFixed(2)})`">
              <!-- 外層 <g> 負責飄落路徑，內層負責翻面 —— 兩段動畫必須拆開，
                   同一元素上的 transform 只會保留最後一個 -->
              <g class="leafFall"
                 :style="{ animationDuration: l.dur, animationDelay: l.d, '--sway': l.sway, '--rot': l.rot + 'deg' }">
                <g class="leafFlip" :style="{ animationDuration: l.dur, animationDelay: l.d }">
                  <path :d="LEAF_D" :fill="elem.mid" :opacity="l.op" />
                  <path :d="LEAF_VEIN_D" :stroke="elem.core" stroke-width="1.1"
                        :opacity="l.op * 0.8" fill="none" />
                </g>
              </g>
            </g>
          </g>

          <!-- 晶：地面晶簇 + 懸浮碎晶 -->
          <g v-if="fx === 'crystal' && !isOpen" class="crystals">
            <!-- 地面長出的晶柱，每根拆亮暗兩面才有厚度 -->
            <g v-for="(c, i) in CRYSTAL_SPIKES" :key="'sp' + i" class="spike"
               :style="{ animationDelay: c.d }">
              <path :d="`M${c.x} 500 L${c.x} ${500 - c.h} L${c.x + c.w / 2} ${500 - c.h * 0.72} L${c.x + c.w / 2} 500 Z`"
                    :fill="elem.mid" opacity=".55" />
              <path :d="`M${c.x} 500 L${c.x} ${500 - c.h} L${c.x - c.w / 2} ${500 - c.h * 0.62} L${c.x - c.w / 2} 500 Z`"
                    :fill="elem.deep" opacity=".7" />
              <path :d="`M${c.x} ${500 - c.h} L${c.x + c.w / 2} ${500 - c.h * 0.72}`"
                    :stroke="elem.core" stroke-width="1.4" opacity=".9" fill="none" />
            </g>
            <!-- 懸浮碎晶 -->
            <g v-for="(c, i) in budget(SHARDS, 3)" :key="'sh' + i"
               :transform="`translate(${c.x.toFixed(1)} ${c.y.toFixed(1)}) scale(${c.s.toFixed(2)})`">
              <g class="shard" :style="{ animationDuration: c.dur, animationDelay: c.d }">
                <path :d="SHARD_LIT_D" :fill="elem.core" :opacity="c.op" />
                <path :d="SHARD_DARK_D" :fill="elem.deep" :opacity="c.op * 0.85" />
              </g>
            </g>
          </g>

          <!-- 星：星塵 + 十字星芒 + 流星 -->
          <g v-if="fx === 'star' && !isOpen" class="starfield">
            <circle
              v-for="(p, i) in budget(STAR_DUST, 14)" :key="'d' + i"
              class="starDust" :cx="p.x.toFixed(1)" :cy="p.y.toFixed(1)" :r="p.rad.toFixed(2)"
              :fill="elem.core" :opacity="p.op"
              :style="{ animationDuration: p.dur, animationDelay: p.d }"
            />
            <g v-for="(p, i) in STAR_FLARES" :key="'f' + i"
               :transform="`translate(${p.x} ${p.y}) scale(${p.s})`">
              <path class="spark" :d="SPARK_D" :fill="elem.core" :style="{ animationDelay: p.d }" />
            </g>
            <g class="meteor">
              <path :d="METEOR_D" :stroke="elem.core" stroke-width="2"
                    stroke-linecap="round" fill="none" />
            </g>
          </g>

          <!-- 屬性符號環 -->
          <g :fill="elem.mid" opacity=".72">
            <g v-for="(g, i) in glyphRing" :key="i"
               :transform="`translate(${g.x.toFixed(1)} ${g.y.toFixed(1)})`">
              <path class="glyph" :d="g.d" :style="{ animationDelay: `${i * -0.45}s` }" />
            </g>
          </g>

          <rect x="0" y="0" width="300" height="500" :fill="`url(#${uid}-vig)`" />

          <!-- 盒蓋接縫：暗帶（縫隙的環境遮蔽）+ 下緣受光的細亮線 -->
          <rect x="0" y="88" width="300" height="10" :fill="`url(#${uid}-aoUp)`" />
          <path d="M0 96.5 H300" stroke="#000" stroke-opacity=".42" stroke-width="1.6" />
          <path d="M0 98.5 H300" stroke="#fff" stroke-opacity=".22" />
          <rect x="0" y="99" width="300" height="9" :fill="`url(#${uid}-aoDown)`" opacity=".6" />

          <!-- 防拆封條。撕開時分成三塊算繪：
               還沒撕到的完好段、已經被扯下來往下翻的碎片、以及中間的鋸齒斷口。 -->
          <clipPath :id="`${uid}-intact`">
            <rect :x="tearX" y="66" :width="300 - tearX" height="60" />
          </clipPath>
          <clipPath :id="`${uid}-gone`">
            <rect x="0" y="66" :width="tearX" height="60" />
          </clipPath>

          <!-- 已撕下的碎片：越撕越往下翻、越淡 -->
          <g
            v-if="tearX > 0" class="tearPiece"
            :clip-path="`url(#${uid}-gone)`"
            :transform="`translate(${(-tearX * 0.06).toFixed(1)} ${(tearX * 0.16).toFixed(1)}) rotate(${(-tearX * 0.02).toFixed(2)} 0 96)`"
            :opacity="Math.max(0, 1 - tearX / 300)"
          >
            <rect x="0" y="72" width="300" height="48" :fill="`url(#${uid}-seal)`" />
            <path d="M0 72 H300" stroke="#fff" :stroke-opacity="mat.matte ? .12 : .5" />
            <path d="M0 120 H300" stroke="#000" stroke-opacity=".35" />
          </g>

          <g :opacity="isOpen ? .35 : 1" :clip-path="tearable ? `url(#${uid}-intact)` : undefined">
            <rect x="0" y="72" width="300" height="48" :fill="`url(#${uid}-seal)`" />
            <!-- 上緣高光是鏡面反射，霧面材質不該有；霧面只留極淡的一道邊 -->
            <path d="M0 72 H300" stroke="#fff" :stroke-opacity="mat.matte ? .12 : .5" />
            <path d="M0 120 H300" stroke="#000" stroke-opacity=".35" />
            <path d="M0 96 H300" stroke="#000" stroke-opacity=".28" stroke-dasharray="3 4" />
            <!-- 封條排版：左側是「標籤 + 數值」兩層，右側是賞別的主從組合。
                 中間一道細分隔線把兩組資訊斷開 —— 沒有分隔的話兩邊會讀成一整行。 -->
            <template v-if="!compact">
              <text class="tLabel" x="20" y="87" :fill="mat.ink">COMMIT</text>
              <text class="tData" x="20" y="108" :fill="mat.ink">{{ hashChip }}</text>

              <path d="M212 80 V112" :stroke="mat.ink" stroke-opacity=".3" />

              <!-- 賞別：字母吃主要字級，「賞」退到附屬 -->
              <text class="tTierBig" x="234" y="109" :fill="mat.ink">{{ tierMark.big }}</text>
              <text class="tTierSm" x="262" y="109" :fill="mat.ink">{{ tierMark.small }}</text>
            </template>
            <text
              v-else class="seal-tier solo" x="150" y="102"
              text-anchor="middle" :fill="mat.ink"
            >{{ tierLabel }}</text>
          </g>

          <!-- 鋸齒斷口 -->
          <path
            v-if="tearable && tearX > 0 && tearX < 300"
            :d="tearEdge" fill="none" :stroke="mat.ink"
            stroke-opacity=".55" stroke-width="1.4"
          />

          <!-- 拉環：撕條的抓取點，也是「這裡可以撕」的唯一提示 -->
          <!-- 拉環。定位在外層、呼吸動畫在內層 —— 兩者都寫 transform 的話
               CSS 動畫會整個覆蓋 SVG 的定位屬性，拉環會彈回畫布原點。 -->
          <g
            v-if="tearable && !torn"
            class="pullTabHit" :class="{ dragging: tearing }"
            :transform="`translate(${Math.max(0, tearX - 4)} 0)`"
            @pointerdown="onTearDown" @pointermove="onTearMove"
            @pointerup="onTearUp" @pointercancel="onTearUp"
          >
            <g class="pullTab">
              <rect x="-2" y="70" width="30" height="52" rx="4" :fill="mat.ink" fill-opacity=".82" />
              <rect x="-2" y="70" width="30" height="52" rx="4" fill="none"
                    :stroke="foil" stroke-opacity=".7" />
              <!-- 三道橫線暗示這是可以捏住的凸起 -->
              <g :stroke="foil" stroke-opacity=".8" stroke-width="1.6" stroke-linecap="round">
                <path d="M6 88 H18" />
                <path d="M6 96 H18" />
                <path d="M6 104 H18" />
              </g>
            </g>
          </g>

          <!-- 火漆封緘。
               正常尺寸放完整字標鎖版；縮圖尺寸下 6–7px 的字只會糊成一團，
               所以退回單一 V 字記號 —— 那個縮到多小都還認得出來。 -->
          <g :transform="`translate(150 ${CY})${compact ? ' scale(1.3)' : ''}`"
             :opacity="isOpen ? .3 : 1">
            <path d="M0 -52 L45 -26 L45 26 L0 52 L-45 26 L-45 -26 Z"
                  fill="#1c1610" fill-opacity=".85" :stroke="foil" stroke-width="2" />
            <path d="M0 -39 L34 -19.5 L34 19.5 L0 39 L-34 19.5 L-34 -19.5 Z"
                  fill="none" stroke="#fff" stroke-opacity=".14" />

            <template v-if="compact">
              <path d="M-14 -13 L0 18 L14 -13" fill="none" :stroke="foil"
                    stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
            </template>

            <template v-else>
              <!-- 上緣微字：印章上的小字是「這是壓印品」最快的暗示 -->
              <text class="sealMicro" y="-25" text-anchor="middle" :fill="foil">SEALED</text>

              <!-- 主字標分兩行 —— VAULTDRAW 九個字排一行在六角形內會擠到邊，
                   拆行後兩邊都留得出邊距，字距也才拉得開。 -->
              <text class="sealWord" y="-3" text-anchor="middle" :fill="foil">VAULT</text>

              <!-- 分隔線兩端各一顆菱形，是印章紋章常見的收邊 -->
              <g :fill="foil" :stroke="foil">
                <path d="M-30 6 H30" stroke-width="1" fill="none" opacity=".55" />
                <path d="M-34 6 l3 -3 l3 3 l-3 3 Z" stroke="none" opacity=".8" />
                <path d="M34 6 l-3 -3 l-3 3 l3 3 Z" stroke="none" opacity=".8" />
              </g>

              <text class="sealWord" y="26" text-anchor="middle" :fill="foil">DRAW</text>
            </template>
          </g>

          <!-- 產品視窗：把真實卡圖斜擺露出來。
               實體卡盒靠開窗告訴人「裡面裝什麼」，這也是整個盒面唯一
               照片級的細節 —— 向量漸層畫不出卡面那種資訊密度。 -->
          <g v-if="showWindow" transform="translate(150 352) rotate(-6)">
            <!-- 窗口內縮的暗邊，讓卡片看起來是「陷進去」而不是貼上去 -->
            <rect x="-86" y="-116" width="172" height="232" rx="7"
                  fill="#000" fill-opacity=".55" />
            <clipPath :id="`${uid}-win`">
              <rect x="-79" y="-109" width="158" height="218" rx="5" />
            </clipPath>
            <image
              :href="cardImage" x="-79" y="-109" width="158" height="218"
              preserveAspectRatio="xMidYMid slice"
              :clip-path="`url(#${uid}-win)`"
            />
            <!-- 窗膜反光：一道斜向高光，暗示上面蓋著一層透明片 -->
            <path d="M-79 60 L79 -60 L79 -22 L-79 98 Z" fill="#fff" fill-opacity=".07"
                  :clip-path="`url(#${uid}-win)`" />
            <rect x="-79" y="-109" width="158" height="218" rx="5"
                  fill="none" :stroke="foil" stroke-width="2" stroke-opacity=".85" />
            <rect x="-83" y="-113" width="166" height="226" rx="6"
                  fill="none" stroke="#fff" stroke-opacity=".14" />
          </g>

          <template v-if="!compact">
            <text v-if="label && !showWindow" class="label" x="150" y="392" text-anchor="middle">{{ label }}</text>
            <g :transform="`translate(0 ${showWindow ? 448 : 420})`">
              <!-- 品牌牌：VAULT 粗、DRAW 細，中間一道豎線斷開。
                   同一個字重跑完九個字母就只是一串字，換重量才有鎖版感。 -->
              <path d="M26 0 H176 L188 13 V38 H26 Z" fill="#0b0a0c" fill-opacity=".92" />
              <path d="M26 0 H176 L188 13 V38 H26 Z" fill="none" :stroke="foil" stroke-opacity=".5" />
              <text class="bMark" x="40" y="26">VAULT</text>
              <path d="M96 10 V29" :stroke="foil" stroke-opacity=".55" />
              <text class="bMarkThin" x="104" y="26">DRAW</text>

              <template v-if="serial">
                <!-- 序號塊：№ 記號 + 主號 + 小一級的分母，三個層級 -->
                <rect x="194" y="0" width="80" height="38" :fill="foil" opacity=".92" />
                <!-- № 與總數放上排、主號獨佔下排。
                     三者同一條基線時，19px 的主號會撞到靠右對齊的分母。 -->
                <text class="sNo" x="203" y="15" :fill="mat.ink">№</text>
                <text
                  v-if="serialParts.total" class="sTotal" x="266" y="15"
                  text-anchor="end" :fill="mat.ink"
                >/ {{ serialParts.total }}</text>
                <text class="sNum" x="203" y="33" :fill="mat.ink">{{ serialParts.n }}</text>
              </template>
            </g>
          </template>

          <!-- 盒底唇線：底蓋壓進去的那一道，同樣用暗帶而不是硬線 -->
          <rect x="0" y="474" width="300" height="8" :fill="`url(#${uid}-aoUp)`" opacity=".8" />
          <path d="M0 482 H300" stroke="#000" stroke-opacity=".34" stroke-width="1.4" />
          <path d="M0 483.8 H300" stroke="#fff" stroke-opacity=".2" />

          <rect x="0" y="0" width="300" height="500" :fill="`url(#${uid}-lit)`" />

          <!-- 表面處理，順序有意義：先打光、再印刷網點、最後紙纖維。
               纖維要在最上層，因為它是「紙的表面」，不該被光罩住。 -->
          <rect x="0" y="0" width="300" height="500" :fill="`url(#${uid}-key)`" />
          <rect v-if="heavyFx" x="0" y="0" width="300" height="500" :fill="`url(#${uid}-print)`" />
        </svg>

        <span
          v-if="!flat" class="gloss" aria-hidden="true"
          :style="{ background: `radial-gradient(42% 32% at ${gx}% ${gy}%, rgba(255,255,255,.3), transparent 72%)` }"
        ></span>
      </div>

      <div class="shadow"></div>
    </div>
  </div>
</template>

<style scoped>
.stage {
  container-type: inline-size;
  position: relative;
  width: 100%;
  /* 上方留給卡榫（14.3cqw）、下方留給投影 */
  aspect-ratio: 1 / 1.36;
  /*
   * 透視距離。先前是 62cqw —— 對一個高度約 142cqw 的盒子來說，
   * 相機距離只有物件的 0.4 倍，等於魚眼鏡頭貼著拍：底部被放大成梯形、
   * 垂直邊嚴重外擴，整個讀起來像仰角。
   * 產品攝影一般用 2–4 倍物距，這裡取 200cqw（約 1.4 倍盒高）仍保留
   * 足夠的立體感，但不再變形。
   */
  perspective: 200cqw;
  /* 視點置中；偏移的原點會額外帶入斜切 */
  perspective-origin: 50% 50%;
}

.box {
  position: absolute;
  /*
   * 窄而厚。最早 72 寬 × 20 厚（0.28）像面膜包，現在 58 寬 × 38 厚（0.66），
   * 接近實體卡盒的比例。
   * left 要把「正面 + 側面投影」一起算進去才置中：
   * 側面在 rotateY(-17°) 下的投影約 38 × sin17° ≈ 11.1cqw，
   * 視覺總寬約 69.1，left = (100 - 69.1) / 2 ≈ 15cqw。
   */
  left: 15cqw; top: 19cqw;
  width: 58cqw; height: 96cqw;
  transform-style: preserve-3d;
  transition: transform .5s cubic-bezier(.2, .7, .3, 1);
}
.tilting.active .box { transition: transform .08s linear; }

.face { position: absolute; backface-visibility: hidden; }

/*
 * 紙纖維顆粒。這是「向量圖」與「實體物件」之間最大的一道分野 ——
 * 完美平滑的漸層一定讀成塑膠 CG，真實材質在各種頻率上都有雜訊。
 *
 * 刻意放在 CSS 而不是 SVG 濾鏡裡：SVG 濾鏡在 300 單位的 viewBox 座標系
 * 運算，整個 svg 再被縮放到實際尺寸，雜訊會跟著放大而糊掉。
 * 用 background-size 指定 px 等於固定在螢幕座標系，盒子放多大顆粒都一樣細。
 * stitchTiles='stitch' 讓噪點無縫平鋪，瀏覽器只解一次圖再重複用，很便宜。
 */
.front::after,
.side::after,
.top::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 140px 140px;
  opacity: .34;
  mix-blend-mode: overlay;
}
/* 側面與頂面受光較少，顆粒相對更明顯 —— 真實紙盒也是暗面看得到纖維 */
.side::after { opacity: .4; }
.top::after { opacity: .36; }

/* 正面。稜線受光：右緣（朝向側面的摺角）打亮、左緣壓暗、上緣一道細光。
   實體紙盒的三個面就是靠這幾道稜線分開的，少了它們會糊成一片。
   右緣用兩層 —— 外亮內暗，模擬摺痕本身的厚度。 */
.front {
  inset: 0;
  overflow: hidden;
  border-radius: 1.4cqw;
  box-shadow:
    inset -1px 0 0 rgba(255, 255, 255, .5),
    inset -2.5px 0 0 rgba(0, 0, 0, .16),
    inset 0 1px 0 rgba(255, 255, 255, .3),
    inset 0 -1px 0 rgba(0, 0, 0, .3),
    inset 2px 0 0 rgba(0, 0, 0, .42);
}
.front svg { display: block; width: 100%; height: 100%; }

/* 吊掛卡榫：貼在盒背，向上突出 */
.tab {
  left: 18%; bottom: 100%;
  /*
   * 高度必須讓容器的長寬比等於 SVG viewBox 的 200:62（= 3.226）。
   * 寬度是盒寬 72cqw 的 64% = 46.08cqw，所以高度要 46.08 / 3.226 ≈ 14.3cqw。
   * 先前給 20cqw，比例對不上，預設的 preserveAspectRatio="meet" 會等比
   * 縮放後上下留白 —— 畫出來的卡榫底邊因此碰不到盒頂，中間露出一道縫，
   * 看起來像浮在上方的另一塊板子。
   */
  width: 64%; height: 14.3cqw;
  /* 與正面同一平面。放到盒深中段（translateZ(-9cqw)）雖然物理上更接近
     真實的背板卡榫，但在 -21° 的視角下會跟盒頂錯開一段，看起來像浮著的
     另一塊板子。齊平反而讀得出「長在盒子上」。 */
  transform: translateZ(0);
  transform-origin: 50% 100%;
}
.tab svg { display: block; width: 100%; height: 100%; }

/* 右側面 */
.side {
  left: 100%; top: 0;
  width: 38cqw; height: 100%;
  transform-origin: 0 50%;
  transform: rotateY(90deg);
  /* 側面是背光面，用同一組象牙色但整體壓暗，維持跟正面同一材質的錯覺。
     靠近摺角那側（左）留一點反光，遠離的一側收暗，讓側面自己也有弧度。 */
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--pk-body-hi) 78%, #fff 22%) 0%,
    var(--pk-body-hi) 20%,
    var(--pk-body-lo) 100%);
  border-radius: 0 1.4cqw 1.4cqw 0;
  overflow: hidden;
  box-shadow:
    inset 1px 0 0 rgba(255, 255, 255, .3),
    inset 0 1px 0 rgba(255, 255, 255, .18),
    inset 0 -1px 0 rgba(0, 0, 0, .28);
}
/* 盒蓋接縫：對齊正面 y=96/400 = 24% */
.side-seam {
  position: absolute; left: 0; right: 0; top: 24%;
  height: 2px;
  background: linear-gradient(180deg, rgba(0, 0, 0, .4), rgba(255, 255, 255, .16));
}
/* 頂蓋與底蓋的摺線 */
.side-crease {
  position: absolute; left: 0; right: 0;
  height: 1px;
  background: rgba(0, 0, 0, .26);
  box-shadow: 0 1px 0 rgba(255, 255, 255, .14);
}
.side-crease.top { top: 5%; }
.side-crease.bottom { bottom: 4%; }
/* 對齊正面封條（y 72→120 於 400 高 = 18%→30%）。
   數字不一致的話，封條繞到側面就會錯開一截，立體感立刻破功。 */
.side-stripe {
  position: absolute; left: 0; right: 0; top: 18%;
  height: 12%;
  opacity: .9;
}
.side-text {
  position: absolute; left: 50%; top: 60%;
  transform: translate(-50%, -50%) rotate(90deg);
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 3cqw; font-weight: 700; letter-spacing: .3em;
  /* 側面是深色，用偏亮的灰字 */
  color: rgba(255, 255, 255, .42);
}

/* 頂面：由淺至深，呼應側面同一光源方向 */
.top {
  left: 0; bottom: 100%;
  width: 100%; height: 38cqw;
  transform-origin: 50% 100%;
  transform: rotateX(90deg);
  background: linear-gradient(180deg, var(--pk-body-lo), var(--pk-body-hi));
  border-radius: 1.2cqw 1.2cqw 0 0;
  overflow: hidden;
}
.top-foil {
  position: absolute; left: 0; right: 0; bottom: 0;
  height: 30%;
  opacity: .8;
}
/* 卡榫落在盒蓋上的影子 —— 沒有它，卡榫會像貼紙而不是突出物 */
/* 卡榫落在盒蓋上的影子。原本 62% 高、.62 濃度會把卡榫與盒身之間
   整段糊成黑塊，反而讓卡榫看起來是浮在旁邊的另一塊板子。 */
.tab-shadow {
  position: absolute; left: 18%; width: 64%;
  top: 0; height: 34%;
  background: linear-gradient(180deg, rgba(0, 0, 0, .45), transparent);
}
.opened .top { transform: rotateX(58deg); }

.shadow {
  position: absolute;
  left: -8%; right: -16%; top: 100%;
  height: 30cqw;
  transform-origin: 50% 0;
  transform: rotateX(90deg) translateZ(-10cqw);
  background: radial-gradient(closest-side, rgba(0, 0, 0, .7), transparent 76%);
  filter: blur(1.6cqw);
  pointer-events: none;
}

/* 離屏時把整棵子樹的動畫停住。用 play-state 而不是 display:none ——
   後者會讓捲回來時重新 layout，而且動畫會從頭開始跳一下。 */
.paused *,
.paused {
  animation-play-state: paused !important;
}

/* 拉環：cursor 與輕微的呼吸提示「這裡可以拖」。
   撕的時候停掉呼吸，避免跟拖曳的位移打架。 */
.pullTabHit { cursor: grab; touch-action: none; }
.pullTabHit.dragging { cursor: grabbing; }
.pullTab { transform-box: fill-box; transform-origin: 50% 50%; }
@media (prefers-reduced-motion: no-preference) {
  .pullTabHit:not(.dragging) .pullTab { animation: tab-nudge 2.4s ease-in-out infinite; }
}
@keyframes tab-nudge {
  0%, 72%, 100% { transform: translateX(0); }
  80%           { transform: translateX(3px); }
  88%           { transform: translateX(0.5px); }
}
/* 撕下的碎片不吃指標，否則會擋住底下的拉環 */
.tearPiece { pointer-events: none; }

.gloss {
  position: absolute; inset: 0;
  pointer-events: none;
  opacity: 0; transition: opacity .3s;
  mix-blend-mode: soft-light;
}
.tilting.active .gloss { opacity: 1; }

/* ---- 盒面排版系統 ----
   三個字級：微標籤 7.5 / 資料 16 / 主字 26。
   先前全部落在 13–16 之間又都是同一個字重，所以「只是換字體」——
   有階層差才讀得出主從。 */

/* 微標籤：說明它旁邊那串數值是什麼 */
.tLabel {
  font-family: var(--font-mono);
  font-size: 7.5px; font-weight: 700;
  letter-spacing: .34em;
  opacity: .58;
}
/* 資料值 */
.tData {
  font-family: var(--font-mono);
  font-size: 16.5px; font-weight: 700;
  letter-spacing: .04em;
}
/* 賞別主字：吃最大字級，是封條上的視覺重點 */
.tTierBig {
  font-family: var(--font-mono);
  font-size: 27px; font-weight: 700;
  letter-spacing: 0;
}
/* 賞別附屬字：退到微標籤等級 */
.tTierSm {
  font-family: var(--font-body);
  font-size: 11px; font-weight: 600;
  letter-spacing: .08em;
  opacity: .72;
}

.seal-tier {
  font-family: var(--font-mono);
  font-size: 16px; font-weight: 700; letter-spacing: .02em;
}
/* 縮圖時正面只算繪到約 62px 寬，viewBox 卻是 300 單位 —— 縮放比約 0.21。
   28px 會變成螢幕上的 5.8px 根本讀不到；40px 才有約 8.8px。 */
.seal-tier.solo { font-size: 40px; }
/* 序號三層：№ 記號、主號、分母 */
.sNo {
  font-family: var(--font-mono);
  font-size: 8px; font-weight: 700;
  letter-spacing: .2em; opacity: .6;
}
.sNum {
  font-family: var(--font-mono);
  font-size: 19px; font-weight: 700;
  letter-spacing: .02em;
  font-variant-numeric: tabular-nums;
}
.sTotal {
  font-family: var(--font-mono);
  font-size: 11px; font-weight: 600;
  opacity: .66;
  font-variant-numeric: tabular-nums;
}
.label {
  font-family: var(--font-body);
  font-size: 21px; font-weight: 600; letter-spacing: -.01em;
  /* 盒身回到深色，字也跟著翻回亮色 */
  fill: #f4f1ec;
}
/* 品牌鎖版：同一個詞用兩種重量拆開 */
.bMark {
  font-family: var(--font-mono);
  font-size: 15px; font-weight: 700; letter-spacing: .16em;
  fill: #f6f2ec;
}
.bMarkThin {
  font-family: var(--font-mono);
  font-size: 15px; font-weight: 400; letter-spacing: .22em;
  fill: #f6f2ec; opacity: .82;
}
/* 印章字標：等寬字 + 大字距，做出壓印的莊重感。
   SVG 的 letter-spacing 會讓 text-anchor="middle" 的置中偏掉半個字距，
   所以補一個等量的左移。 */
.sealWord {
  font-family: var(--font-mono);
  font-size: 19px; font-weight: 700;
  letter-spacing: .18em;
  transform: translateX(-0.09em);
}
.sealMicro {
  font-family: var(--font-mono);
  font-size: 7.5px; font-weight: 600;
  letter-spacing: .34em;
  opacity: .75;
  transform: translateX(-0.17em);
}

/* ---- 屬性特效 ----
   全部走 CSS 動畫，沒有 JS 迴圈。transform-box: fill-box 是必要的：
   SVG 元素的 transform-origin 預設參照的是整個 viewBox 原點，
   不設的話火苗會繞著畫布左上角縮放而不是自己的底部。 */
.fireLayer, .ember, .wave, .bubble, .boltStrike, .boltFlash {
  transform-box: fill-box;
}
/* 火焰由底部往上長，縮放原點必須釘在底邊 */
.fireLayer { transform-origin: 50% 100%; }
.wave { transform-origin: 0 50%; }
.bubble, .spark, .glyph, .shard, .starDust, .spike {
  transform-box: fill-box;
  transform-origin: 50% 50%;
}
/* 晶柱從地面長出來，原點釘在底邊 */
.spike { transform-origin: 50% 100%; }
@media (prefers-reduced-motion: no-preference) {
  /* 節奏整體加快、幅度加大 —— 先前太含蓄，在縮圖尺寸下幾乎看不出在動 */
  .fireLayer  { animation-name: fire-roar; animation-timing-function: ease-in-out;
                animation-iteration-count: infinite; animation-direction: alternate; }
  .ember      { animation: ember-rise 3.8s ease-out infinite; }
  .wave       { animation-name: wave-roll; animation-timing-function: linear;
                animation-iteration-count: infinite; }
  .boltStrike { animation: bolt-strike 2.8s steps(1, end) infinite; }
  .boltFlash  { animation: bolt-flash 2.8s steps(1, end) infinite; }
  .bubble     { animation: bubble-rise 4.2s ease-in infinite; }
  .leafFall   { animation-name: leaf-fall; animation-timing-function: linear;
                animation-iteration-count: infinite; }
  .leafFlip   { animation-name: leaf-flip; animation-timing-function: ease-in-out;
                animation-iteration-count: infinite; }
  .spike      { animation: spike-grow 4.4s ease-in-out infinite alternate; }
  .shard      { animation-name: shard-float; animation-timing-function: ease-in-out;
                animation-iteration-count: infinite; animation-direction: alternate; }
  .starDust   { animation-name: dust-twinkle; animation-timing-function: ease-in-out;
                animation-iteration-count: infinite; animation-direction: alternate; }
  .meteor     { animation: meteor-streak 7s ease-in infinite; }
  .spark      { animation: spark-twinkle 2s ease-in-out infinite; }
  .glyph      { animation: glyph-pulse 2.2s ease-in-out infinite alternate; }
}
/* 火：縱向抽長 + 橫向漂移。--drift 每層不同方向，讓火舌互相穿插，
   配合亂流位移就會churn 出「亂燒」的感覺，而不是整片一起呼吸。 */
@keyframes fire-roar {
  0%   { transform: scaleY(.86) scaleX(1.06) translateX(calc(var(--drift) * -1)); }
  35%  { transform: scaleY(1.22) scaleX(.94) translateX(calc(var(--drift) * .4)); }
  70%  { transform: scaleY(1.02) scaleX(1.03) translateX(var(--drift)); }
  100% { transform: scaleY(1.34) scaleX(.9) translateX(calc(var(--drift) * -.5)); }
}
/* 火星：被熱氣帶上去，越高越小越淡，橫向被氣流吹偏 */
@keyframes ember-rise {
  0%   { transform: translate(0, 0) scale(1); opacity: 0; }
  12%  { opacity: .95; }
  100% { transform: translate(26px, -300px) scale(.25); opacity: 0; }
}
/* 水：橫向捲動剛好一個波長，接回原位時無縫 */
@keyframes wave-roll {
  from { transform: translateX(0); }
  to   { transform: translateX(var(--len)); }
}
/* 雷擊瞬間的全屏爆光，讓閃電有「照亮整個盒面」的存在感 */
@keyframes bolt-flash {
  0%, 100% { opacity: 0; }
  2%  { opacity: .3; }
  5%  { opacity: .04; }
  8%  { opacity: .22; }
  13% { opacity: 0; }
}
/* 閃電是「大部分時間不在」，偶爾爆閃兩下 —— 持續發亮就變成裝飾線條 */
/* 閃電只改透明度、不碰 transform —— 主幹的位置是靠路徑座標定的，
   一旦動 transform 就會覆蓋掉，整條電光會飛到畫布原點。 */
@keyframes bolt-strike {
  0%, 100% { opacity: 0; }
  2%  { opacity: 1; }
  5%  { opacity: .12; }
  8%  { opacity: 1; }
  12% { opacity: .35; }
  16% { opacity: 0; }
}
/* 氣泡在水體內上升。行程收在 ~100px —— 水面現在約在 y=290，
   升太高氣泡會飄出水面外，反而穿幫。 */
@keyframes bubble-rise {
  0%   { transform: translateY(0) translateX(0) scale(.5); opacity: 0; }
  15%  { opacity: .9; }
  70%  { transform: translateY(-64px) translateX(9px) scale(1.1); opacity: .7; }
  100% { transform: translateY(-104px) translateX(-6px) scale(1.25); opacity: 0; }
}
/* 葉子飄落。--sway 每片不同的橫向擺幅、--rot 不同的初始角度，
   讓 14 片各走各的路徑而不是排隊落下。 */
@keyframes leaf-fall {
  0%   { transform: translateY(0) translateX(0) rotate(var(--rot, 0deg)); opacity: 0; }
  6%   { opacity: 1; }
  30%  { transform: translateY(140px) translateX(var(--sway)) rotate(calc(var(--rot, 0deg) + 150deg)); }
  62%  { transform: translateY(280px) translateX(calc(var(--sway) * -0.8)) rotate(calc(var(--rot, 0deg) + 340deg)); }
  90%  { opacity: .9; }
  100% { transform: translateY(450px) translateX(calc(var(--sway) * 0.5)) rotate(calc(var(--rot, 0deg) + 560deg)); opacity: 0; }
}
/* 翻面：用 scaleX 壓扁模擬葉片轉到側面，這是落葉最有辨識度的動作。
   單純平面旋轉只會像轉盤子。 */
@keyframes leaf-flip {
  0%, 100% { transform: scaleX(1); }
  25%      { transform: scaleX(.15); }
  50%      { transform: scaleX(-1); }
  75%      { transform: scaleX(.4); }
}
/* 晶柱：緩慢長高再收回，像結霜的節奏 */
@keyframes spike-grow {
  from { transform: scaleY(.72) scaleX(1.04); opacity: .55; }
  to   { transform: scaleY(1.06) scaleX(.98); opacity: 1; }
}
@keyframes shard-float {
  0%   { transform: translateY(-16px) rotate(-28deg) scale(.88); opacity: .4; }
  100% { transform: translateY(18px) rotate(34deg) scale(1.12); opacity: 1; }
}
/* 星塵只做亮度呼吸，不縮放 —— 1px 的點縮放只會閃爍成雜訊 */
@keyframes dust-twinkle {
  from { opacity: .15; }
  to   { opacity: 1; }
}
/* 流星：大部分時間不在，偶爾劃過一次 */
@keyframes meteor-streak {
  0%, 100% { transform: translate(250px, 90px); opacity: 0; }
  4%       { opacity: 0; }
  8%       { opacity: .95; }
  20%      { transform: translate(70px, 250px); opacity: 0; }
}
@keyframes spark-twinkle {
  0%, 100% { transform: scale(.15) rotate(0deg); opacity: 0; }
  40%      { transform: scale(1.5) rotate(45deg); opacity: 1; }
  62%      { transform: scale(.9) rotate(70deg); opacity: .55; }
}
@keyframes glyph-pulse {
  from { opacity: .45; transform: scale(.85); }
  to   { opacity: 1;   transform: scale(1.18); }
}

/* 減少動態時特效靜止但保留，維持材質與屬性的辨識度 */
@media (prefers-reduced-motion: reduce) {
  .box { transition: none; }
  .gloss { display: none; }
  .fireLayer { opacity: .7; }
  .ember { opacity: .5; }
  .wave { opacity: .55; }
  .boltStrike { opacity: .6; }
  .boltFlash { opacity: 0; }
  .bubble { opacity: .4; }
  .leafFall, .leafFlip { opacity: .75; }
  .spike, .shard, .starDust { opacity: .7; }
  .meteor { opacity: 0; }
  .leaf, .shard { opacity: .45; }
  .spark { opacity: .6; }
}
</style>
