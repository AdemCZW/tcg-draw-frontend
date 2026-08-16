<script setup lang="ts">
/**
 * 寶貝球 —— 取代原本的卡盒。
 *
 * 等級沿用遊戲內的球階：精靈球 → 超級球 → 高級球 → 豪華球 → 大師球。
 * 色語言照原作走，但外形不做 1:1 描摹：每一階自己的紋樣（超級球的紅翼、
 * 高級球的金肩章、豪華球的紅金環、大師球的 M 字）都重新設計過，
 * 中央再開一個能量觀景窗當屬性動畫的載體 —— 原作沒有這個窗。
 *
 * ---- 為什麼俯角是烘在 SVG 裡而不是用 CSS rotateX ----
 * 球體從任何角度看，輪廓都是正圓；會隨視角改變的只有球面上的「緯線」。
 * 拿平面半圓去 rotateX，壓扁的是輪廓本身 —— 那是一片圓盤躺下，不是一顆球
 * 從上面看，而且俯角拉越高越不像球。所以這裡反過來做：輪廓永遠是正圓，
 * 赤道、環帶、豪華球的紅環全部按俯角算成橢圓弧。改視角只要動 TILT 一個數字。
 *
 * 開球是真的蚌殼掀蓋：鉸鏈設在赤道的「遠緣」（畫面上是橢圓的頂點），
 * 蓋子繞著那條線往後翻，所以不管開多大，蓋子跟球身永遠在那一點相連。
 */
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import type { Tier } from '@/types/models'
import { useTilt } from '@/composables/useTilt'
import { haptic } from '@/lib/haptics'

const props = withDefaults(defineProps<{
  tier?: Tier
  label?: string
  serial?: string
  hash?: string
  /** 已開啟（外部控制）。內部按鈕開啟會自己記狀態 */
  opened?: boolean
  /** 縮圖模式：拿掉細節與文字，只留形制與等級色 */
  compact?: boolean
  /** 關掉游標傾斜 */
  flat?: boolean
  /** 屬性特效。不給就依等級自動選 */
  effect?: 'fire' | 'bolt' | 'water' | 'leaf' | 'crystal' | 'star' | 'none'
  /** 開啟後彈出的卡圖 */
  cardImage?: string
  /** 開啟按鈕是否可按 */
  interactive?: boolean
}>(), {
  tier: 'D', label: '', serial: '', hash: '',
  opened: false, compact: false, flat: false,
  effect: undefined, cardImage: undefined, interactive: false
})

const emit = defineEmits<{ (e: 'opened'): void }>()

/* ---- 混色工具 ----
   球面漸層要七段，手寫五個等級 × 兩個半球太不好維護，
   統一從 shellHi/shellLo 兩個基準色算出來。 */
function rgb(hex: string) {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function mix(a: string, b: string, t: number) {
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b)
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0')
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`
}
const lighten = (h: string, t: number) => mix(h, '#ffffff', t)
const darken = (h: string, t: number) => mix(h, '#000000', t)

/* ---- 球面幾何 ----
   全部從 TILT（俯角）算出來，改視角只要動這一個數字。
   viewBox 是 400×400，球心 (200,200)、半徑 196。 */
const TILT = 36
const TH = (TILT * Math.PI) / 180
const R = 196, CX = 200, CY = 200
const n = (v: number) => +v.toFixed(2)

/** 某一條緯線投影出來的橢圓。lat 是緯度（度），正值在赤道以上。 */
function ring(lat: number) {
  const la = (lat * Math.PI) / 180
  const rx = R * Math.cos(la)
  return { rx, ry: rx * Math.sin(TH), cy: CY - R * Math.sin(la) * Math.cos(TH) }
}
/** 緯線面向鏡頭那一側的弧（球體會擋住自己的背面，所以只畫近弧） */
function nearArc(lat: number, reverse = false) {
  const { rx, ry, cy } = ring(lat)
  return reverse
    ? `M${n(CX + rx)} ${n(cy)} A${n(rx)} ${n(ry)} 0 0 1 ${n(CX - rx)} ${n(cy)}`
    : `M${n(CX - rx)} ${n(cy)} A${n(rx)} ${n(ry)} 0 0 0 ${n(CX + rx)} ${n(cy)}`
}
/** 兩條緯線之間、面向鏡頭那一片帶狀區域 */
function zone(top: number, bot: number) {
  const a = ring(top), b = ring(bot)
  return `M${n(CX - a.rx)} ${n(a.cy)} A${n(a.rx)} ${n(a.ry)} 0 0 0 ${n(CX + a.rx)} ${n(a.cy)}`
    + ` L${n(CX + b.rx)} ${n(b.cy)} A${n(b.rx)} ${n(b.ry)} 0 0 1 ${n(CX - b.rx)} ${n(b.cy)} Z`
}

const EQ = ring(0)
/** 赤道近緣（球身最前面那條線）與遠緣（鉸鏈所在） */
const EQ_NEAR = CY + EQ.ry
const EQ_FAR = CY - EQ.ry

/** 上半殼。俯視時它蓋掉的是「圓的上弧 + 赤道近弧」之間 —— 超過半個圓。 */
const LID_PATH =
  `M${n(CX - R)} ${CY} A${R} ${R} 0 0 1 ${n(CX + R)} ${CY}`
  + ` A${R} ${n(EQ.ry)} 0 0 1 ${n(CX - R)} ${CY} Z`
/** 下半殼看得到的只有近緣以下那一彎 —— 近緣以上是碗口內部，不是外殼 */
const BASE_PATH =
  `M${n(CX - R)} ${CY} A${R} ${n(EQ.ry)} 0 0 0 ${n(CX + R)} ${CY}`
  + ` A${R} ${R} 0 0 1 ${n(CX - R)} ${CY} Z`

const BAND = 7
const BAND_TOP = zone(BAND, 0)
const BAND_BOT = zone(0, -BAND)
/** 環帶刻紋。等角取樣：圓柱上等距的刻線投影到畫面會往兩側壓縮，
    照 x 等距畫會變成一條貼上去的條碼，密度差就是圓柱感的來源。 */
const KNURL = Array.from({ length: 30 }, (_, i) => {
  const a = ((i + 0.5) / 30 - 0.5) * Math.PI
  const x = CX + Math.sin(a) * R * Math.cos((BAND * Math.PI) / 180)
  const t = ring(BAND), b = ring(-BAND)
  const k = Math.cos(a)
  return { x: n(x), y1: n(t.cy + t.ry * k), y2: n(b.cy + b.ry * k) }
})

/** 殼的材料厚度。開蓋後真正讓畫面立體的不是漸層，是「看得到殼是有厚度的」——
    少了這一圈斷面，開口就只是一張貼在球上的黑色橢圓。 */
const WALL = { rx: n(R - 13), ry: n(EQ.ry - 7.5) }
const LID_IN_R = R - 12
const LID_IN_RY = n(EQ.ry - 7)
const LID_INNER_PATH =
  `M${n(CX - LID_IN_R)} ${CY} A${LID_IN_R} ${LID_IN_R} 0 0 1 ${n(CX + LID_IN_R)} ${CY}`
  + ` A${LID_IN_R} ${LID_IN_RY} 0 0 1 ${n(CX - LID_IN_R)} ${CY} Z`

/** 中央按鈕落在赤道最前面。那裡的球面正對水平方向，被俯角壓扁 cos(TILT) */
const BTN = { cx: CX, cy: n(EQ_NEAR - R * Math.sin((BAND * Math.PI) / 180) * Math.cos(TH) * 0.1), rx: 30, ry: n(30 * Math.cos(TH)) }
/** 鉸鏈在畫面上的高度，CSS transform-origin 要用 */
const HINGE = `${n((EQ_FAR / 400) * 100)}%`

/* ---- 等級階梯：遊戲內的球階 ----
   遞進不是只換色相，四個軸同時往上疊：
   殼體材質（霧面塑膠 → 拋光 → 鏡面）、紋樣、環帶刻紋、自體發光強度。
   下半殼一律比上半殼悶一階 —— 同色系不同材質才不會讀成一體成型的玩具。 */
const GRADES = {
  poke: {
    name: '精靈球',
    shellHi: '#ef4040', shellLo: '#7e0f0f', shellRim: '#ff9d8c',
    baseHi: '#e9ecf1', baseLo: '#8e949d',
    band: '#17191d', trim: '#c9ced6',
    glow: 0.18, ornament: 'plain' as const, mark: '#ffffff', metal: false
  },
  great: {
    name: '超級球',
    shellHi: '#3f7fd8', shellLo: '#0f3068', shellRim: '#a8ccff',
    baseHi: '#e6eaf0', baseLo: '#878e98',
    band: '#14181f', trim: '#cfe0ff',
    glow: 0.32, ornament: 'great' as const, mark: '#e0392b', metal: true
  },
  ultra: {
    name: '高級球',
    shellHi: '#333941', shellLo: '#0b0d10', shellRim: '#79828d',
    baseHi: '#e3e7ec', baseLo: '#848a93',
    band: '#0b0d10', trim: '#f5c400',
    glow: 0.48, ornament: 'ultra' as const, mark: '#f5c400', metal: true
  },
  luxury: {
    name: '豪華球',
    shellHi: '#2c3036', shellLo: '#08090b', shellRim: '#8c939c',
    baseHi: '#43474d', baseLo: '#121316',
    band: '#08090b', trim: '#d8b25a',
    glow: 0.64, ornament: 'luxury' as const, mark: '#c0392b', metal: true
  },
  master: {
    name: '大師球',
    shellHi: '#8b4fd0', shellLo: '#33115f', shellRim: '#dcb8ff',
    baseHi: '#d5d0e2', baseLo: '#6a6280',
    band: '#140f22', trim: '#f07ab8',
    glow: 0.88, ornament: 'master' as const, mark: '#f07ab8', metal: true
  }
} as const
export type CapsuleGrade = keyof typeof GRADES

const TIER_GRADE: Record<Tier, CapsuleGrade> = {
  D: 'poke', C: 'great', B: 'ultra',
  A: 'luxury', LAST: 'master', BUST: 'poke'
}
const grade = computed(() => GRADES[TIER_GRADE[props.tier]])

/* ---- 球面漸層 ----
   分辨「玩具」跟「金屬件」的不是色相，是明度曲線會不會反轉。
   霧面從亮到暗一路遞減；拋光面會在中段掉暗、再回亮出一條地平線反光。
   最後一站一定要回亮 —— 真實物體的暗部有環境反射光，死黑就是塑膠感。 */
type Stop = { o: string; c: string }
/** gain 收窄整條明度曲線。下半殼要比上半殼「悶」，兩片材質不同才不會像
    一體成型的塑膠玩具 —— 同色相不同材質，是高級感最直接的一招。 */
function sphereStops(hi: string, lo: string, rim: string, metal: boolean, gain = 1): Stop[] {
  if (!metal) {
    return [
      { o: '0%', c: lighten(hi, 0.34 * gain) },
      { o: '34%', c: hi },
      { o: '74%', c: lo },
      { o: '100%', c: lighten(lo, 0.24) }
    ]
  }
  // 高光段刻意壓窄（0→7%）。放寬會讓整顆球泛白，深色殼體尤其明顯 ——
  // 硬料的鏡面反射本來就是一小點，大面積的亮區是霧面漆才有的事。
  return [
    { o: '0%', c: lighten(rim, 0.42 * gain) },
    { o: '7%', c: rim },
    { o: '24%', c: hi },
    { o: '46%', c: darken(hi, 0.52) },
    { o: '63%', c: mix(hi, rim, 0.5 * gain) },
    { o: '86%', c: lo },
    { o: '100%', c: lighten(lo, 0.3) }
  ]
}
const domeStops = computed(() =>
  sphereStops(grade.value.shellHi, grade.value.shellLo, grade.value.shellRim, grade.value.metal))
/* 下半球：亮部 → 本色 → 終止線 → 反射光。最後那一站往回提亮，
   是「暗部有環境反射」的物理事實，也是塑膠感跟實體感的分界。 */
const baseStops = computed(() => {
  const g = grade.value
  return [
    { o: '0%', c: lighten(g.baseHi, 0.12) },
    { o: '24%', c: g.baseHi },
    { o: '60%', c: g.baseLo },
    { o: '86%', c: darken(g.baseLo, 0.34) },
    { o: '100%', c: lighten(g.baseLo, 0.2) }
  ]
})

/* ---- 屬性色 ---- */
const ELEMENTS = {
  fire:    { core: '#ffe0ac', mid: '#ff8a3d', deep: '#e0391a' },
  water:   { core: '#d4f2ff', mid: '#43b4f7', deep: '#1668d4' },
  leaf:    { core: '#e8ffd2', mid: '#63d84c', deep: '#1f9440' },
  bolt:    { core: '#fffce0', mid: '#ffe14d', deep: '#f59e00' },
  crystal: { core: '#e8faff', mid: '#6fd6ff', deep: '#3f7bff' },
  star:    { core: '#ffffff', mid: '#f0a8ff', deep: '#a44cff' },
  none:    { core: '#e9edf2', mid: '#aab3bd', deep: '#6b727c' }
} as const
const GRADE_EFFECT: Record<CapsuleGrade, keyof typeof ELEMENTS> = {
  poke: 'fire', great: 'water', ultra: 'bolt',
  luxury: 'crystal', master: 'star'
}
const fx = computed(() => props.effect ?? GRADE_EFFECT[TIER_GRADE[props.tier]])
const elem = computed(() => ELEMENTS[fx.value])


const uid = `cap${useId().replace(/:/g, '')}`
const hashChip = computed(() => (props.hash ? props.hash.slice(0, 10).toUpperCase() : ''))

/* ---- 開球序列 ----
   六拍。關鍵是第二拍那 100ms 的「全靜止」：
   動 → 停 → 炸，中間沒有那個死點的話，爆開會軟掉變成單純變亮。
   刻意不用 requestAnimationFrame —— 分頁不可見時 rAF 不推進，
   序列會卡在半途。setTimeout 就算被節流也只是慢，狀態仍會走完。 */
type Phase = 'idle' | 'charge' | 'hold' | 'crack' | 'burst' | 'reveal'
const phase = ref<Phase>('idle')
const timers: number[] = []

/** 掀蓋角度。負值＝近緣往上往後翻，繞的是赤道遠緣那條軸。 */
const OPEN_DEG = -126
const lidAngle = computed(() => {
  if (props.opened) return OPEN_DEG
  if (phase.value === 'crack') return -13
  if (phase.value === 'burst' || phase.value === 'reveal') return OPEN_DEG
  return 0
})
const isOpen = computed(() => lidAngle.value !== 0)

function openCapsule() {
  if (!props.interactive || phase.value !== 'idle') return
  haptic('tap')
  phase.value = 'charge'
  timers.push(window.setTimeout(() => { phase.value = 'hold' }, 420))
  timers.push(window.setTimeout(() => { phase.value = 'crack' }, 520))
  timers.push(window.setTimeout(() => { phase.value = 'burst'; haptic('burst') }, 700))
  timers.push(window.setTimeout(() => {
    phase.value = 'reveal'
    emit('opened')
  }, 1000))
}
onBeforeUnmount(() => timers.forEach(clearTimeout))

/* ---- 游標互動 ----
   只挪高光，不轉球。轉球會把正圓輪廓壓成橢圓，
   前面整套幾何就是為了避免那件事。 */
const { el, gx, gy, active, onMove, reset } = useTilt(10)

/* ---- 離屏暫停 ---- */
const visible = ref(true)
const stage = ref<HTMLElement | null>(null)
let io: IntersectionObserver | undefined
onMounted(() => {
  if (!stage.value || typeof IntersectionObserver === 'undefined') return
  io = new IntersectionObserver(([e]) => { visible.value = e.isIntersecting }, { rootMargin: '120px' })
  io.observe(stage.value)
})
onBeforeUnmount(() => io?.disconnect())

/* ---- 艙內能量粒子 ----
   透過觀景窗看到，所以座標都收在鏡片內。固定種子，重繪後位置一致。 */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const MOTES = (() => {
  const r = mulberry32(41)
  return Array.from({ length: 14 }, () => {
    const a = r() * Math.PI * 2
    const rad = Math.sqrt(r()) * 30
    return {
      x: n(Math.cos(a) * rad),
      y: n(Math.sin(a) * rad * 0.86),
      s: n(0.9 + r() * 2),
      dur: `${(1.6 + r() * 2.4).toFixed(2)}s`,
      d: `-${(r() * 3).toFixed(2)}s`
    }
  })
})()

/** 開球時射出的光束 */
const BURST_RAYS = Array.from({ length: 14 }, (_, i) => ({
  a: i * (360 / 14),
  len: 120 + ((i * 37) % 70),
  w: i % 2 ? 3 : 6
}))

/* ---- 蓋子內襯的球面座標 ----
   ψ=0 是近側，lat 是緯度。用的是內殼半徑（外殼扣掉一個壁厚），
   所以肋條與觀景窗背面都會貼在內壁上，不會浮在殼外。
   投影公式跟 ring()/nearArc() 同一套：
     x = CX + Ri·cos(lat)·sin(ψ)
     y = CY − Ri·sin(lat)·cos(TILT) + Ri·sin(TILT)·cos(ψ) */
function innerPt(lat: number, psi: number) {
  const la = (lat * Math.PI) / 180
  const c = Math.cos(la), s = Math.sin(la)
  return {
    x: n(CX + LID_IN_R * c * Math.sin(psi)),
    y: n(CY - LID_IN_R * s * Math.cos(TH) + LID_IN_RY * c * Math.cos(psi))
  }
}
/** 內壁補強肋。沿經線走 —— 直線畫上去就是貼紙，跟著球面收斂才讀成模出來的肋。
    注意內襯被 rotateY(180) 再 rotateX(>90°) 轉了整整 180°，
    所以 svg 的「右下」對應畫面的「左上」＝光源方向，受光係數照那個方向算。 */
const RIB_LATS = [82, 66, 50, 34, 18, 3]
const LID_RIBS = Array.from({ length: 10 }, (_, i) => {
  const psi = (i / 10) * Math.PI * 2
  const d = RIB_LATS.map((l, k) => {
    const p = innerPt(l, psi)
    return `${k ? 'L' : 'M'}${p.x} ${p.y}`
  }).join(' ')
  return { d, lit: n(Math.max(0, Math.sin(psi) * 0.72 + Math.cos(psi) * 0.7)) }
})
/** 觀景窗背面的凸起。窗心在外殼 lat≈45°、ψ=0，換算到內壁就是這個點。 */
const BOSS = innerPt(45, 0)
/** 內壁的緯線圈。從殼裡往外看是看得到整圈的，所以是完整橢圓不是近弧。 */
function innerRing(lat: number) {
  const la = (lat * Math.PI) / 180
  const rx = LID_IN_R * Math.cos(la)
  return { rx: n(rx), ry: n(rx * Math.sin(TH)), cy: n(CY - LID_IN_R * Math.sin(la) * Math.cos(TH)) }
}
/** 靠殼口的密封槽。一圈同心的凹線，跟放射狀的肋一起把內壁撐成模出來的件 */
const LID_SEAL = innerRing(9)

/* ---- 球體周圍的環繞微粒 ----
   座標落在赤道平面的橢圓軌道上（ry = rx·sin(TILT)），跟球面幾何共用同一個俯角，
   所以微粒讀起來是「繞著球轉」而不是「灑在畫面上的雪」。
   ψ 在近半圈的畫在球前面、遠半圈的畫在球後面 —— 那個前後遮擋就是立體感的來源。
   固定種子，重繪後位置一致。 */
const ORB_POOL = (() => {
  const r = mulberry32(907)
  return Array.from({ length: 20 }, (_, i) => {
    // 前後交錯配額，這樣不管取幾顆，前景背景都不會偏掉一邊
    const front = i % 2 === 0
    const psi = (front ? 0 : Math.PI) + (r() - 0.5) * Math.PI * 0.94
    const rx = R * (1.05 + r() * 0.37)
    const x = CX + Math.sin(psi) * rx
    const y = CY + Math.cos(psi) * rx * Math.sin(TH) + (r() - 0.5) * rx * 0.44
    const s = 2 + r() * 4.2
    const ang = r() * Math.PI * 2
    const amp = 3 + r() * 6
    return {
      i, front,
      x: n(x), y: n(y),
      // 收束／爆散用的位移向量（相對球心）
      dx: `${n(x - CX)}px`, dy: `${n(y - CY)}px`,
      halo: n(s * 3.2), core: n(s * 0.72),
      o: n(0.42 + r() * 0.4),
      dur: `${(3.6 + r() * 3.8).toFixed(2)}s`,
      delay: `-${(r() * 7).toFixed(2)}s`,
      drx: `${n(Math.cos(ang) * amp)}px`,
      dry: `${n(Math.sin(ang) * amp)}px`
    }
  })
})()
/** 微粒數量綁等級：精靈球 7 顆、大師球 17 顆。compact 不上特效，96px 縮圖跑不動。 */
const orbCount = computed(() => (props.compact ? 0 : Math.round(4 + grade.value.glow * 15)))
const orbsBack = computed(() => ORB_POOL.slice(0, orbCount.value).filter(o => !o.front))
const orbsFront = computed(() => ORB_POOL.slice(0, orbCount.value).filter(o => o.front))
/** 特效總強度。0.3 打底，剩下 0.7 由 glow 決定 —— 高階球才有滿版特效。 */
const fxPower = computed(() => n(0.3 + grade.value.glow * 0.7))

/* ---- 環繞軌道 ----
   同樣是赤道平面的橢圓，拆成遠半圈與近半圈分別畫在球後／球前。
   兩段的行進方向接得上（遠圈右→左、近圈左→右），
   所以 stroke-dashoffset 一起跑時，光點看起來是繞著球連續轉。 */
const ORB_RX = n(R * 1.2)
const ORB_RY = n(R * 1.2 * Math.sin(TH))
const ORBIT_FAR = `M${n(CX + ORB_RX)} ${CY} A${ORB_RX} ${ORB_RY} 0 0 0 ${n(CX - ORB_RX)} ${CY}`
const ORBIT_NEAR = `M${n(CX - ORB_RX)} ${CY} A${ORB_RX} ${ORB_RY} 0 0 0 ${n(CX + ORB_RX)} ${CY}`
</script>

<template>
  <div
    ref="stage"
    class="stage"
    :class="[`ph-${phase}`, { compact, flat, paused: !visible, tilting: !flat, active, open: isOpen }]"
    :style="{ '--glow': grade.glow, '--hinge': HINGE }"
    @pointermove="flat || onMove($event)"
    @pointerleave="flat || reset()"
  >
    <div
      class="aura"
      :style="{ background: `radial-gradient(circle, ${elem.mid}00 44%, ${elem.mid}4d 66%, ${elem.deep}00 100%)` }"
    ></div>

    <!-- 兩段式接地陰影：緊實核心 + 大範圍環境。只給一段物件會像浮在半空 -->
    <div v-if="!compact" class="shadowSoft"></div>
    <div v-if="!compact" class="shadowCore"></div>

    <div ref="el" class="ball">

      <!-- ===== 球後的環繞特效 =====
           畫在所有球體圖層之前，凡是跟球身重疊的都會被擋住。
           跟後面 .fxFront 那一層是同一套軌道的兩個半圈，
           「一半被擋住、一半蓋在球上」才會讀成繞著球轉而不是貼在畫面上。 -->
      <div v-if="!compact" class="fx fxBack" aria-hidden="true">
        <svg viewBox="0 0 400 400">
          <defs>
            <!-- 遠側微粒：偏冷、偏暗。空氣透視 —— 遠的東西對比低 -->
            <radialGradient :id="`${uid}-orbB`">
              <stop offset="0%" :stop-color="elem.mid" />
              <stop offset="40%" :stop-color="elem.mid" stop-opacity=".5" />
              <stop offset="100%" :stop-color="elem.deep" stop-opacity="0" />
            </radialGradient>
            <!-- 衝擊環的遠半圈：地平線固定在球心高度，所以裁切框套在不動的父層上 -->
            <clipPath :id="`${uid}-far`"><rect x="-600" y="-600" width="1600" height="800" /></clipPath>
          </defs>
          <g :opacity="fxPower">
            <g v-if="grade.glow > 0.28" class="orbitRing">
              <path :d="ORBIT_FAR" fill="none" :stroke="elem.mid" stroke-opacity=".13" stroke-width="1.5" />
              <path class="pip" :d="ORBIT_FAR" fill="none" :stroke="elem.core" stroke-opacity=".55"
                    stroke-width="3.6" stroke-linecap="round" pathLength="100" stroke-dasharray="2.5 47.5" />
            </g>
            <g v-for="o in orbsBack" :key="o.i" class="orb" :style="{ '--dx': o.dx, '--dy': o.dy }">
              <g class="orbDot"
                 :style="{ animationDuration: o.dur, animationDelay: o.delay, '--drx': o.drx, '--dry': o.dry }">
                <circle :cx="o.x" :cy="o.y" :r="o.halo" :fill="`url(#${uid}-orbB)`" :fill-opacity="o.o * 0.7" />
              </g>
            </g>
            <g :clip-path="`url(#${uid}-far)`">
              <ellipse v-for="k in 2" :key="k" class="shock" :style="{ animationDelay: `${(k - 1) * 0.14}s` }"
                       :cx="CX" :cy="CY" :rx="R" :ry="n(EQ.ry)" fill="none"
                       :stroke="elem.core" :stroke-width="k === 1 ? 5 : 12"
                       :stroke-opacity="k === 1 ? 1 : .3" />
            </g>
          </g>
        </svg>
      </div>

      <!-- ===== 上半殼：繞赤道遠緣往後翻的蚌殼蓋 =====
           畫在最底層。翻開後它整片在碗口後面，靠繪製順序就能排對，
           不必依賴 3D 深度排序。 -->
      <div class="lidGroup" :style="{ transform: `rotateX(${lidAngle}deg)` }">
        <!-- 內襯。翻過 90° 後外殼背對觀眾，沒有這一面蓋子會整片消失 -->
        <div class="face lidInner">
          <svg viewBox="0 0 400 400" aria-hidden="true">
            <defs>
              <!-- 凹面：碗底（圓頂內側最深處）最暗，往殼口提亮。
                   方向反過來畫會讀成一片凸出的圓盤而不是凹進去的殼。 -->
              <radialGradient :id="`${uid}-in`" gradientUnits="userSpaceOnUse" :cx="CX" cy="52" r="292">
                <stop offset="0%" stop-color="#04030a" />
                <stop offset="42%" :stop-color="darken(grade.baseLo, .5)" />
                <stop offset="100%" :stop-color="mix(grade.baseHi, grade.baseLo, .45)" />
              </radialGradient>
              <!-- 斷面：被切開的材料厚度，朝上受光 -->
              <linearGradient :id="`${uid}-lipT`" x1="0.14" y1="0" x2="0.86" y2="1">
                <stop offset="0%" :stop-color="lighten(grade.shellRim, .5)" />
                <stop offset="42%" :stop-color="grade.shellHi" />
                <stop offset="100%" :stop-color="darken(grade.shellLo, .35)" />
              </linearGradient>
              <!-- 內壁的鏡面掃光。內襯在畫面上被轉了 180°，
                   焦點要放在 svg 的右下角才會落在畫面的左上（光源方向）。 -->
              <radialGradient :id="`${uid}-spec`" gradientUnits="userSpaceOnUse" cx="266" cy="216" r="158">
                <stop offset="0%" stop-color="#fff" stop-opacity=".26" />
                <stop offset="44%" stop-color="#fff" stop-opacity=".085" />
                <stop offset="100%" stop-color="#fff" stop-opacity="0" />
              </radialGradient>
              <!-- 觀景窗背面透出來的能量 -->
              <radialGradient :id="`${uid}-boss`">
                <stop offset="0%" :stop-color="elem.core" />
                <stop offset="42%" :stop-color="elem.mid" stop-opacity=".7" />
                <stop offset="100%" :stop-color="elem.deep" stop-opacity="0" />
              </radialGradient>
              <!-- 通用的柔邊投影 -->
              <radialGradient :id="`${uid}-drop`">
                <stop offset="0%" stop-color="#000" stop-opacity=".62" />
                <stop offset="62%" stop-color="#000" stop-opacity=".3" />
                <stop offset="100%" stop-color="#000" stop-opacity="0" />
              </radialGradient>
              <clipPath :id="`${uid}-li`"><path :d="LID_INNER_PATH" /></clipPath>
            </defs>
            <!-- 先鋪滿斷面色，再用內壁蓋掉中間 —— 露出來的那一圈就是殼的厚度 -->
            <path :d="LID_PATH" :fill="`url(#${uid}-lipT)`" />
            <path :d="LID_INNER_PATH" :fill="`url(#${uid}-in)`" />
            <g :clip-path="`url(#${uid}-li)`">
              <!-- 內壁靠殼口那一段離鏡頭最近也最受光 -->
              <path :d="nearArc(-1.5)" fill="none" :stroke="lighten(grade.baseHi, .25)"
                    stroke-opacity=".4" stroke-width="26" />
              <ellipse :cx="CX" cy="250" rx="140" ry="52" :fill="elem.deep" fill-opacity=".22" />

              <!-- 補強肋。每條都是一暗一亮兩筆：暗筆是溝、亮筆是溝旁邊被打亮的稜。
                   只有一筆的話讀成畫上去的線，兩筆才有「模出來的高低差」。 -->
              <g v-if="!compact" fill="none" stroke-linecap="round">
                <template v-for="(rb, i) in LID_RIBS" :key="i">
                  <path :d="rb.d" stroke="#000" :stroke-opacity="n(.32 - rb.lit * .17)" stroke-width="6" />
                  <path :d="rb.d" :stroke="lighten(grade.baseHi, .45)"
                        :stroke-opacity="n(.05 + rb.lit * .24)" stroke-width="2.4"
                        transform="translate(2.6 2.6)" />
                </template>
              </g>

              <!-- 密封槽：靠殼口的一圈同心凹線。一暗一亮，亮筆偏 svg 右下（受光側） -->
              <g v-if="!compact" fill="none">
                <ellipse :cx="CX" :cy="LID_SEAL.cy" :rx="LID_SEAL.rx" :ry="LID_SEAL.ry"
                         stroke="#000" stroke-opacity=".42" stroke-width="5" />
                <ellipse :cx="n(CX + 2)" :cy="n(LID_SEAL.cy + 2.4)" :rx="LID_SEAL.rx" :ry="LID_SEAL.ry"
                         :stroke="lighten(grade.baseHi, .45)" stroke-opacity=".2" stroke-width="2" />
              </g>

              <!-- 觀景窗背面的凸起。從內側看得到窗座是「凸出來的」，
                   蓋子內側就不再是一個扁平的碟子。投影往 svg 左上 = 畫面右下。 -->
              <g v-if="!compact">
                <ellipse :cx="n(BOSS.x - 12)" :cy="n(BOSS.y - 10)" rx="68" ry="47"
                         :fill="`url(#${uid}-drop)`" />
                <!-- 窗心透出來的能量在座圈外圍暈開 -->
                <ellipse :cx="BOSS.x" :cy="BOSS.y" rx="88" ry="60" :fill="`url(#${uid}-boss)`"
                         :opacity="n(.14 + grade.glow * .26)" />
                <ellipse :cx="BOSS.x" :cy="BOSS.y" rx="46" ry="31"
                         :fill="mix(grade.baseHi, grade.baseLo, .58)" />
                <!-- 背光側先壓一圈暗邊，凸起才有厚度 -->
                <path :d="`M${n(BOSS.x - 45)} ${n(BOSS.y - 6)} A46 31 0 0 1 ${n(BOSS.x + 45)} ${n(BOSS.y - 6)}`"
                      fill="none" stroke="#000" stroke-opacity=".5" stroke-width="5" stroke-linecap="round" />
                <ellipse :cx="BOSS.x" :cy="BOSS.y" rx="46" ry="31" fill="none"
                         stroke="#000" stroke-opacity=".45" stroke-width="2" />
                <!-- 凸起受光的那一側：svg 下緣 = 畫面上緣 -->
                <path :d="`M${n(BOSS.x - 41)} ${n(BOSS.y + 11)} A46 31 0 0 0 ${n(BOSS.x + 41)} ${n(BOSS.y + 9)}`"
                      fill="none" :stroke="lighten(grade.baseHi, .6)" stroke-opacity=".7"
                      stroke-width="3.4" stroke-linecap="round" />
                <ellipse :cx="BOSS.x" :cy="BOSS.y" rx="32" ry="20" :fill="darken(grade.shellLo, .55)" />
                <ellipse :cx="BOSS.x" :cy="BOSS.y" rx="30" ry="18" :fill="`url(#${uid}-boss)`"
                         :opacity="n(.4 + grade.glow * .55)" />
              </g>

              <!-- 鏡面掃光。硬料的內殼是拋光面，一道長掃光比整片提亮更像實體，
                   而且只在蓋子翻過去之後才亮起來 —— 高光本來就該隨角度變。 -->
              <path class="lidSpec" :d="LID_INNER_PATH" :fill="`url(#${uid}-spec)`" />
            </g>
            <!-- 內緣暗溝：斷面與內壁的交界，這一筆讓厚度讀得出來 -->
            <path :d="LID_INNER_PATH" fill="none" stroke="#000" stroke-opacity=".62" stroke-width="3" />
            <path :d="LID_PATH" fill="none" :stroke="grade.trim"
                  stroke-opacity=".4" stroke-width="1.5" />
          </svg>
        </div>

        <div class="face lidOuter">
          <svg viewBox="0 0 400 400" role="img"
               :aria-label="label ? `${label} 寶貝球` : '寶貝球'">
            <defs>
              <radialGradient
                :id="`${uid}-dome`" gradientUnits="userSpaceOnUse"
                :cx="CX" :cy="CY" r="212" fx="122" fy="108"
              >
                <stop v-for="(s, i) in domeStops" :key="i" :offset="s.o" :stop-color="s.c" />
              </radialGradient>
              <linearGradient :id="`${uid}-bandT`" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" :stop-color="darken(grade.band, .55)" />
                <stop offset="70%" :stop-color="grade.band" />
                <stop offset="100%" :stop-color="lighten(grade.band, .34)" />
              </linearGradient>
              <radialGradient :id="`${uid}-core`">
                <stop offset="0%" :stop-color="elem.core" />
                <stop offset="30%" :stop-color="elem.mid" stop-opacity=".9" />
                <stop offset="72%" :stop-color="elem.deep" stop-opacity=".55" />
                <stop offset="100%" :stop-color="elem.deep" stop-opacity=".12" />
              </radialGradient>
              <clipPath :id="`${uid}-lens`"><ellipse :cx="CX" cy="168" rx="45" ry="40" /></clipPath>
              <clipPath :id="`${uid}-dc`"><path :d="LID_PATH" /></clipPath>
            </defs>

            <path :d="LID_PATH" :fill="`url(#${uid}-dome)`" />

            <g :clip-path="`url(#${uid}-dc)`">
              <!-- 大範圍環境反射：很淡，交代「這是一顆會反射四周的球」 -->
              <ellipse cx="140" cy="150" rx="104" ry="76" fill="#fff" fill-opacity=".07"
                       transform="rotate(-22 140 150)" />

              <!-- 球階紋樣。全部沿著緯線弧走 —— 直線畫在球上就是貼紙 -->
              <g fill="none" stroke-linecap="round" stroke-linejoin="round">
                <!-- 超級球：兩道紅翼從環帶掃上肩線 -->
                <template v-if="grade.ornament === 'great'">
                  <path v-for="(o, i) in [-1, 1]" :key="i"
                        :d="`M${200 + o * 148} 252 Q${200 + o * 100} 186 ${200 + o * 42} 156`"
                        :stroke="grade.mark" stroke-width="19" />
                  <path v-for="(o, i) in [-1, 1]" :key="`h${i}`"
                        :d="`M${200 + o * 148} 252 Q${200 + o * 100} 186 ${200 + o * 42} 156`"
                        stroke="#fff" stroke-opacity=".2" stroke-width="6" />
                </template>

                <!-- 高級球：金色肩章 -->
                <template v-else-if="grade.ornament === 'ultra'">
                  <path v-for="(o, i) in [-1, 1]" :key="i"
                        :d="`M${200 + o * 142} 254 L${200 + o * 142} 196 L${200 + o * 76} 158`"
                        :stroke="grade.mark" stroke-width="20" />
                  <path v-for="(o, i) in [-1, 1]" :key="`d${i}`"
                        :d="`M${200 + o * 142} 254 L${200 + o * 142} 196 L${200 + o * 76} 158`"
                        stroke="#000" stroke-opacity=".26" stroke-width="4" />
                </template>

                <!-- 豪華球：紅環夾兩道金線。三條都是緯線弧，繞著球走 -->
                <template v-else-if="grade.ornament === 'luxury'">
                  <path :d="nearArc(12)" :stroke="grade.mark" stroke-width="13" />
                  <path :d="nearArc(15.5)" :stroke="grade.trim" stroke-opacity=".85" stroke-width="3" />
                  <path :d="nearArc(8.6)" :stroke="grade.trim" stroke-opacity=".7" stroke-width="2.5" />
                  <path v-for="(o, i) in [-1, 1]" :key="i"
                        :d="`M${200 + o * 64} 224 Q${200 + o * 116} 190 ${200 + o * 140} 128`"
                        :stroke="grade.trim" stroke-opacity=".8" stroke-width="3.5" />
                  <circle v-for="(o, i) in [-1, 1]" :key="`g${i}`"
                          :cx="200 + o * 140" cy="128" r="6" :fill="grade.trim" fill-opacity=".9" stroke="none" />
                </template>

                <!-- 大師球：M 字。中峰壓在觀景窗下方，窗本身就是視覺焦點 -->
                <template v-else-if="grade.ornament === 'master'">
                  <path d="M112 272 L112 214 L200 272 L288 214 L288 272"
                        :stroke="grade.mark" stroke-width="19" />
                  <path d="M112 272 L112 214 L200 272 L288 214 L288 272"
                        stroke="#fff" stroke-opacity=".2" stroke-width="6" />
                  <ellipse v-for="(o, i) in [-1, 1]" :key="i"
                           :cx="200 + o * 139" cy="180" rx="17" ry="14"
                           fill="#f4f2f8" stroke="#000" stroke-opacity=".22" stroke-width="2" />
                  <ellipse v-for="(o, i) in [-1, 1]" :key="`h${i}`"
                           :cx="200 + o * 139 - 5" cy="175" rx="6" ry="5" fill="#fff" stroke="none" />
                </template>
              </g>

              <!-- 觀景窗。開口比例壓在直徑的 23% 上下（工程壓力窗的量級），
                   省下來的面積全給窗框厚度 —— 大窗讀成玩具，小窗厚框讀成器械。 -->
              <ellipse :cx="CX" cy="168" rx="54" ry="49" :fill="darken(grade.shellLo, .45)" />
              <ellipse :cx="CX" cy="168" rx="51" ry="46" fill="none"
                       :stroke="grade.trim" stroke-opacity=".75" stroke-width="3" />
              <ellipse :cx="CX" cy="168" rx="47" ry="42" fill="none"
                       stroke="#000" stroke-opacity=".62" stroke-width="3.5" />
              <ellipse :cx="CX" cy="168" rx="45" ry="40" fill="#05040a" fill-opacity=".94" />
              <g :clip-path="`url(#${uid}-lens)`">
                <ellipse :cx="CX" cy="168" rx="45" ry="40" :fill="`url(#${uid}-core)`" />
                <circle v-for="(m, i) in MOTES" :key="i" class="mote"
                        :cx="CX + m.x" :cy="168 + m.y" :r="m.s" :fill="elem.core"
                        :style="{ animationDuration: m.dur, animationDelay: m.d }" />
                <path d="M162 192 L214 132 L232 132 L180 192 Z" fill="#fff" fill-opacity=".14" />
              </g>

              <!-- 環帶上半（跟著蓋子一起翻） -->
              <path :d="BAND_TOP" :fill="`url(#${uid}-bandT)`" />
              <g v-if="grade.glow > 0.4" opacity=".2">
                <path v-for="(k, i) in KNURL" :key="i" :d="`M${k.x} ${k.y1} L${k.x} ${k.y2}`"
                      :stroke="grade.trim" stroke-width="3.4" />
              </g>
              <path :d="nearArc(BAND)" fill="none" :stroke="grade.trim" stroke-opacity=".35" stroke-width="2" />

              <!-- 主高光：小、緊、硬邊。一顆大糊光斑＝玩具 -->
              <ellipse cx="112" cy="112" rx="24" ry="15" fill="#fff" fill-opacity=".6"
                       transform="rotate(-30 112 112)" />
              <ellipse cx="139" cy="86" rx="8" ry="5" fill="#fff" fill-opacity=".28"
                       transform="rotate(-30 139 86)" />

              <!-- 暗側輪廓光 -->
              <path d="M318 62 A196 196 0 0 1 372 258" fill="none"
                    stroke="#cfe4ff" stroke-opacity=".3" stroke-width="3" stroke-linecap="round" />
            </g>
          </svg>
        </div>
      </div>

      <!-- ===== 碗口 ===== -->
      <div class="mouth" aria-hidden="true">
        <svg viewBox="0 0 400 400">
          <defs>
            <!-- 內壁：遠側（上緣）同時朝著鏡頭與光源，最亮；近側內壁背光，最暗。
                 這道上下明暗差就是「一只碗」跟「一個黑洞」的差別。 -->
            <linearGradient :id="`${uid}-wall`" x1="0.18" y1="0" x2="0.5" y2="1">
              <stop offset="0%" :stop-color="lighten(grade.baseHi, .22)" />
              <stop offset="26%" :stop-color="grade.baseLo" />
              <stop offset="62%" :stop-color="darken(grade.baseLo, .72)" />
              <stop offset="100%" stop-color="#05040a" />
            </linearGradient>
            <!-- 斷面：殼被切開的厚度，朝上受光 -->
            <linearGradient :id="`${uid}-lipB`" x1="0.14" y1="0" x2="0.86" y2="1">
              <stop offset="0%" :stop-color="lighten(grade.baseHi, .42)" />
              <stop offset="40%" :stop-color="grade.baseHi" />
              <stop offset="100%" :stop-color="darken(grade.baseLo, .45)" />
            </linearGradient>
            <radialGradient :id="`${uid}-chamber`" gradientUnits="userSpaceOnUse"
                            :cx="CX" cy="262" r="168">
              <stop offset="0%" :stop-color="elem.core" />
              <stop offset="30%" :stop-color="elem.mid" stop-opacity=".72" />
              <stop offset="100%" :stop-color="elem.deep" stop-opacity="0" />
            </radialGradient>
            <!-- 內壁邊緣的環境遮蔽：越靠殼口越暗。這一圈是「一只碗」跟「一張黑色貼紙」的分界 -->
            <radialGradient :id="`${uid}-ao`">
              <stop offset="50%" stop-color="#000" stop-opacity="0" />
              <stop offset="84%" stop-color="#000" stop-opacity=".34" />
              <stop offset="100%" stop-color="#000" stop-opacity=".7" />
            </radialGradient>
            <!-- 蓋子打在碗裡的投影 -->
            <radialGradient :id="`${uid}-cast`">
              <stop offset="0%" stop-color="#04030a" stop-opacity=".74" />
              <stop offset="56%" stop-color="#04030a" stop-opacity=".46" />
              <stop offset="100%" stop-color="#04030a" stop-opacity="0" />
            </radialGradient>
            <clipPath :id="`${uid}-wc`">
              <ellipse :cx="CX" :cy="CY" :rx="WALL.rx" :ry="WALL.ry" />
            </clipPath>
            <clipPath :id="`${uid}-mo`">
              <ellipse :cx="CX" :cy="CY" :rx="R" :ry="n(EQ.ry)" />
            </clipPath>
          </defs>
          <!-- 殼口斷面。先鋪外圈，再用內壁蓋掉中間，露出來的一圈就是殼的厚度 -->
          <ellipse :cx="CX" :cy="CY" :rx="R" :ry="n(EQ.ry)" :fill="`url(#${uid}-lipB)`" />
          <ellipse :cx="CX" :cy="CY" :rx="WALL.rx" :ry="WALL.ry" :fill="`url(#${uid}-wall)`" />
          <g :clip-path="`url(#${uid}-wc)`">
            <ellipse :cx="CX" cy="262" rx="138" ry="48" :fill="`url(#${uid}-chamber)`" />
            <ellipse :cx="CX" :cy="CY" :rx="WALL.rx" :ry="WALL.ry" :fill="`url(#${uid}-ao)`" />
          </g>
          <!-- 內緣暗溝：斷面與內壁的交界 -->
          <ellipse :cx="CX" :cy="CY" :rx="WALL.rx" :ry="WALL.ry" fill="none"
                   stroke="#000" stroke-opacity=".62" stroke-width="3" />
          <!-- 外緣亮邊 -->
          <ellipse :cx="CX" :cy="CY" :rx="R" :ry="n(EQ.ry)" fill="none"
                   :stroke="grade.trim" stroke-opacity=".38" stroke-width="1.5" />
          <!-- 蓋子的投影。蓋子翻在球的後上方，光源在左上，
               所以影子壓在遠側內壁偏右那一塊，連斷面一起吃掉。
               投影是最強的立體線索 —— 少了它，掀開的蓋子跟碗口只是兩個疊在一起的形狀。 -->
          <g :clip-path="`url(#${uid}-mo)`">
            <ellipse cx="228" cy="140" rx="188" ry="82" :fill="`url(#${uid}-cast)`"
                     transform="rotate(-7 228 140)" />
          </g>
        </svg>
      </div>

      <!-- ===== 卡片投在碗內壁上的影子 =====
           畫在碗口之後、卡片之前，所以影子在內壁上、卡片在影子上。
           光源在左上，影子往右偏；右側那道暗帶就是「卡片真的插在碗裡」的證據。 -->
      <div v-if="cardImage && !compact" class="cardCast" aria-hidden="true">
        <svg viewBox="0 0 400 400">
          <defs>
            <clipPath :id="`${uid}-cc`">
              <ellipse :cx="CX" :cy="CY" :rx="WALL.rx" :ry="WALL.ry" />
            </clipPath>
            <filter :id="`${uid}-cb`" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="11" />
            </filter>
          </defs>
          <g :clip-path="`url(#${uid}-cc)`" :filter="`url(#${uid}-cb)`">
            <!-- 卡片擋掉的環境光：整片內壁先壓暗一階 -->
            <rect x="84" y="112" width="232" height="210" fill="#000" opacity=".3" />
            <!-- 卡片本體投上去的影子，往右下偏出卡片邊界才看得到 -->
            <rect x="140" y="126" width="212" height="196" fill="#000" opacity=".55"
                  transform="skewX(3)" />
          </g>
        </svg>
      </div>

      <!-- 縫隙漏光 -->
      <div class="leak" :style="{ background: `radial-gradient(60% 100% at 50% 50%, ${elem.core}, transparent 72%)` }"></div>

      <!-- ===== 卡片 =====
           畫在碗口之後、近側殼壁之前，所以下緣會被殼口切掉，
           讀起來是「從球裡浮上來」而不是貼在球前面。 -->
      <div v-if="cardImage && !compact" class="ejected">
        <img :src="cardImage" alt="" />
      </div>

      <!-- ===== 下半殼的近側壁 =====
           唯一看得到的下半殼就是赤道近緣以下這一彎。畫在卡片之後，
           它就是遮住卡片下緣的那道殼口。 -->
      <div class="face base">
        <svg viewBox="0 0 400 400" aria-hidden="true">
          <defs>
            <radialGradient
              :id="`${uid}-base`" gradientUnits="userSpaceOnUse"
              :cx="CX" :cy="CY" r="212" fx="128" fy="150"
            >
              <stop v-for="(s, i) in baseStops" :key="i" :offset="s.o" :stop-color="s.c" />
            </radialGradient>
            <linearGradient :id="`${uid}-bandB`" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" :stop-color="lighten(grade.band, .3)" />
              <stop offset="36%" :stop-color="grade.band" />
              <stop offset="100%" :stop-color="darken(grade.band, .6)" />
            </linearGradient>
            <clipPath :id="`${uid}-bc`"><path :d="BASE_PATH" /></clipPath>
          </defs>

          <path :d="BASE_PATH" :fill="`url(#${uid}-base)`" />

          <g :clip-path="`url(#${uid}-bc)`">
            <!-- 環境反射（下半的主要形狀線索） -->
            <ellipse cx="118" cy="300" rx="84" ry="48" fill="#fff" fill-opacity=".07"
                     transform="rotate(-16 118 300)" />
            <!-- 底部反射光：暗部收邊回亮，這一筆決定金屬還是塑膠 -->
            <path d="M62 340 A196 196 0 0 0 338 340" fill="none"
                  :stroke="lighten(grade.baseHi, .5)" stroke-opacity=".24"
                  stroke-width="8" stroke-linecap="round" />
            <path d="M344 268 A196 196 0 0 1 314 348" fill="none"
                  stroke="#cfe4ff" stroke-opacity=".2" stroke-width="2.5" stroke-linecap="round" />

            <!-- 環帶下半 -->
            <path :d="BAND_BOT" :fill="`url(#${uid}-bandB)`" />
            <g v-if="grade.glow > 0.4" opacity=".2">
              <path v-for="(k, i) in KNURL" :key="i" :d="`M${k.x} ${k.y1} L${k.x} ${k.y2}`"
                    :stroke="grade.trim" stroke-width="3.4" />
            </g>
            <path :d="nearArc(-BAND)" fill="none" :stroke="grade.trim" stroke-opacity=".3" stroke-width="2" />

            <!-- 分模線：三筆才有厚度。最上面那筆亮線是下半殼上緣接到的光，
                 少了它兩片會像貼紙疊在一起。 -->
            <path :d="nearArc(0)" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="2.5" />
            <path :d="nearArc(-0.9)" fill="none" stroke="#000" stroke-opacity=".65" stroke-width="3.5" />
          </g>
        </svg>
      </div>

      <!-- ===== 球前的環繞特效 =====
           畫在下半殼之後，所以會蓋在球身上。跟 .fxBack 是同一條軌道的近半圈。 -->
      <div v-if="!compact" class="fx fxFront" aria-hidden="true">
        <svg viewBox="0 0 400 400">
          <defs>
            <!-- 近側微粒：比遠側亮一階，中心再補一顆實心核 -->
            <radialGradient :id="`${uid}-orbF`">
              <stop offset="0%" :stop-color="elem.core" />
              <stop offset="34%" :stop-color="elem.mid" stop-opacity=".62" />
              <stop offset="100%" :stop-color="elem.deep" stop-opacity="0" />
            </radialGradient>
            <clipPath :id="`${uid}-near`"><rect x="-600" y="200" width="1600" height="800" /></clipPath>
          </defs>
          <g :opacity="fxPower">
            <g v-if="grade.glow > 0.28" class="orbitRing">
              <path :d="ORBIT_NEAR" fill="none" :stroke="elem.mid" stroke-opacity=".16" stroke-width="1.5" />
              <path class="pip" :d="ORBIT_NEAR" fill="none" :stroke="elem.core" stroke-opacity=".9"
                    stroke-width="4.2" stroke-linecap="round" pathLength="100" stroke-dasharray="2.5 47.5" />
            </g>
            <g v-for="o in orbsFront" :key="o.i" class="orb" :style="{ '--dx': o.dx, '--dy': o.dy }">
              <g class="orbDot"
                 :style="{ animationDuration: o.dur, animationDelay: o.delay, '--drx': o.drx, '--dry': o.dry }">
                <circle :cx="o.x" :cy="o.y" :r="o.halo" :fill="`url(#${uid}-orbF)`" :fill-opacity="o.o" />
                <circle :cx="o.x" :cy="o.y" :r="o.core" :fill="elem.core" :fill-opacity="n(o.o * .9)" />
              </g>
            </g>
            <g :clip-path="`url(#${uid}-near)`">
              <ellipse v-for="k in 2" :key="k" class="shock" :style="{ animationDelay: `${(k - 1) * 0.14}s` }"
                       :cx="CX" :cy="CY" :rx="R" :ry="n(EQ.ry)" fill="none"
                       :stroke="elem.core" :stroke-width="k === 1 ? 5 : 12"
                       :stroke-opacity="k === 1 ? 1 : .3" />
            </g>
          </g>
        </svg>
      </div>

      <!-- 光爆 -->
      <div class="burst">
        <svg viewBox="0 0 400 400" aria-hidden="true">
          <g :fill="elem.core" :opacity="n(.5 + grade.glow * .5)">
            <path v-for="(r, i) in BURST_RAYS" :key="i"
                  :transform="`translate(200 200) rotate(${r.a})`"
                  :d="`M${-r.w} 0 L${r.w} 0 L2 ${-r.len} L-2 ${-r.len} Z`" />
          </g>
          <circle class="burstCore" cx="200" cy="200" r="72" :fill="elem.core" />
        </svg>
      </div>

      <!-- 按鈕。落在赤道最前面，球面在那裡正對水平，所以是被壓扁的橢圓 -->
      <component
        :is="interactive ? 'button' : 'div'"
        class="btn" :class="{ live: interactive && phase === 'idle' }"
        :type="interactive ? 'button' : undefined"
        :disabled="interactive ? phase !== 'idle' : undefined"
        :aria-label="interactive ? '開啟寶貝球' : undefined"
        :style="{
          left: `${(BTN.cx / 400) * 100}%`, top: `${(BTN.cy / 400) * 100}%`,
          width: `${(BTN.rx * 2 / 400) * 100}%`, height: `${(BTN.ry * 2 / 400) * 100}%`
        }"
        @click="openCapsule"
      >
        <span class="btnRim" :style="{ borderColor: grade.trim }"></span>
        <span
          class="btnGlow"
          :style="{ background: elem.core, boxShadow: `0 0 1.6cqw ${elem.mid}, 0 0 .6cqw ${elem.core}` }"
        ></span>
      </component>

      <span v-if="!flat" class="gloss" aria-hidden="true"
            :style="{ background: `radial-gradient(30% 26% at ${gx}% ${gy}%, rgba(255,255,255,.26), transparent 70%)` }"></span>
    </div>

    <div v-if="!compact" class="plate">
      <span class="gLabel" :style="{ color: grade.trim }">{{ grade.name }}</span>
      <span v-if="hashChip" class="gHash">封存 {{ hashChip }}</span>
    </div>
  </div>
</template>

<style scoped>
.stage {
  container-type: inline-size;
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1.3;
}
.compact { aspect-ratio: 1 / 1.06; }

/* 球一律是正圓。俯角烘在 SVG 幾何裡，這裡不做任何會壓扁輪廓的變形。
   perspective 只給蓋子的 3D 掀開用；transform-style 維持 flat，
   讓圖層順序（而不是 3D 深度排序）決定誰蓋誰 —— 卡片要夾在碗口與殼壁之間。 */
.ball {
  position: absolute;
  left: 21cqw; top: 40cqw;
  width: 58cqw; height: 58cqw;
  perspective: 180cqw;
  perspective-origin: 50% 30%;
}
.compact .ball { left: 12cqw; top: 12cqw; width: 76cqw; height: 76cqw; }

.face, .mouth, .lidGroup {
  position: absolute; inset: 0;
}
.face svg, .mouth svg, .lidGroup svg { display: block; width: 100%; height: 100%; overflow: visible; }

.aura {
  position: absolute; left: 6cqw; top: 25cqw;
  width: 88cqw; height: 88cqw;
  pointer-events: none;
}
.compact .aura { left: 6cqw; top: -3cqw; width: 88cqw; height: 88cqw; }
@media (prefers-reduced-motion: no-preference) {
  .aura { animation: aura-breathe 4.2s ease-in-out infinite alternate; }
}
@keyframes aura-breathe {
  from { opacity: .5; transform: scale(.95); }
  to   { opacity: 1;  transform: scale(1.05); }
}

/* 接地陰影 */
.shadowCore, .shadowSoft {
  position: absolute; left: 50%; pointer-events: none;
  transform: translateX(-50%);
  border-radius: 50%; background: #000;
  transition: width .6s ease, opacity .6s ease;
}
.shadowCore { top: 96cqw; width: 24cqw; height: 4.5cqw; opacity: .5; filter: blur(1.8cqw); }
.shadowSoft { top: 92cqw; width: 58cqw; height: 9cqw; opacity: .3; filter: blur(4.5cqw); }
/* 掀開後多出一整片蓋子擋光，地上的影子跟著攤開變濃 */
.open .shadowSoft { width: 72cqw; opacity: .38; }

/* ---- 掀蓋 ----
   鉸鏈設在赤道遠緣（--hinge）。那條線是旋轉軸，所以不管開多大，
   蓋子跟球身永遠在那一點相連 —— 這是「蚌殼」跟「蓋子飛走」的分界。 */
.lidGroup {
  transform-style: preserve-3d;
  transform-origin: 50% var(--hinge);
  transition: transform .66s cubic-bezier(.32, 1.1, .5, 1);
}
.lidOuter { backface-visibility: hidden; }
.lidInner { transform: rotateY(180deg); backface-visibility: hidden; }

/* 碗口只在開啟後出現 */
.mouth, .cardCast {
  position: absolute; inset: 0;
  opacity: 0; pointer-events: none; transition: opacity .22s ease .1s;
}
.cardCast svg { display: block; width: 100%; height: 100%; }
.open .mouth, .open .cardCast { opacity: 1; }
/* 內殼的鏡面掃光只在蓋子翻過去之後亮起來 —— 高光本來就該隨角度變 */
.lidSpec { opacity: 0; transition: opacity .5s ease .18s; }
.open .lidSpec { opacity: 1; }

/* 縫隙漏光：沿著赤道近緣那一條 */
.leak {
  position: absolute;
  left: 4%; top: 72%;
  width: 92%; height: 12%;
  opacity: 0;
  pointer-events: none;
  filter: blur(1cqw);
}
.ph-crack .leak { opacity: 1; transition: opacity .12s ease; }
.ph-burst .leak, .ph-reveal .leak { opacity: 0; transition: opacity .25s ease; }

/* ---- 按鈕 ---- */
.btn {
  position: absolute;
  transform: translate(-50%, -50%);
  border: none; padding: 0;
  border-radius: 50%;
  background: radial-gradient(ellipse at 38% 26%, #2c2e35, #08070c 72%);
  box-shadow:
    0 0 0 .35cqw rgba(0, 0, 0, .75),
    inset 0 .3cqw .6cqw rgba(0, 0, 0, .6),
    inset 0 -.16cqw .3cqw rgba(255, 255, 255, .16);
  display: grid; place-items: center;
  cursor: default;
}
.btn.live { cursor: pointer; }
.btn:disabled { cursor: default; }
.btnRim {
  position: absolute;
  width: 78%; height: 78%;
  border-radius: 50%;
  border: 1.5px solid;
  opacity: .7;
}
.btnGlow {
  position: absolute;
  width: 54%; height: 54%; border-radius: 50%;
  opacity: calc(var(--glow) * .8);
  transition: opacity .3s, transform .3s;
}
.btn.live:hover .btnGlow { opacity: 1; transform: scale(1.12); }
.btn.live:focus-visible { outline: 2px solid #fff; outline-offset: 4px; }
.ph-charge .btnGlow, .ph-hold .btnGlow { opacity: 1; transform: scale(1.3); }
@media (prefers-reduced-motion: no-preference) {
  .btn.live .btnGlow { animation: btn-idle 2.6s ease-in-out infinite; }
  /* 蓄能：振幅遞增。衰減式的抖動讀起來是餘震，遞增才是蓄力 */
  .ph-charge .ball { animation: wind-up .42s linear; }
  .ph-burst .ball { animation: kick .22s cubic-bezier(.2, .8, .3, 1); }
}
@keyframes btn-idle {
  0%, 100% { opacity: calc(var(--glow) * .5); }
  50%      { opacity: calc(var(--glow) * 1); }
}
@keyframes wind-up {
  0%   { transform: translate(0, 0) rotate(0); }
  22%  { transform: translate(-.3cqw, .1cqw) rotate(-.2deg); }
  44%  { transform: translate(.5cqw, -.12cqw) rotate(.34deg); }
  66%  { transform: translate(-.85cqw, .18cqw) rotate(-.6deg); }
  86%  { transform: translate(1.3cqw, -.25cqw) rotate(.86deg); }
  100% { transform: translate(0, 0) rotate(0); }
}
@keyframes kick {
  0%   { transform: scale(1); }
  35%  { transform: scale(1.04); }
  100% { transform: scale(1); }
}

/* ---- 光爆 ---- */
.burst {
  position: absolute; inset: -24%;
  pointer-events: none; opacity: 0;
}
.burst svg { width: 100%; height: 100%; }
.ph-burst .burst, .ph-reveal .burst { animation: rays .95s cubic-bezier(.15, .8, .3, 1) forwards; }
@keyframes rays {
  0%   { opacity: 0; transform: scale(.18) rotate(0deg); }
  12%  { opacity: .95; }
  100% { opacity: 0; transform: scale(1.5) rotate(14deg); }
}
/* 白光要一拍到頂。峰值拖過 100ms 就會讀成發光而不是撞擊 */
.burstCore { transform-box: fill-box; transform-origin: 50% 50%; }
.ph-burst .burstCore, .ph-reveal .burstCore { animation: flash .8s ease-out forwards; }
@keyframes flash {
  0%   { opacity: 0; transform: scale(.2); }
  8%   { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(2.4); }
}

/* ---- 彈卡 ----
   bottom 訂在球高的 8%：卡片下緣落在殼口之內，被後面畫的殼壁切掉，
   看起來就是浮在殼裡而不是貼在球前面。 */
.ejected {
  position: absolute;
  /* 24% 是「還會被殼口切到」的上限。近弧在中央是球高的 78.8%、在卡片
     左右緣是 74.8%，卡片下緣落在 76% —— 中央那段浮出弧線之上，左右下角
     仍被上翹的弧線切掉。那道橫過下面兩角的弧線就是「立在碗裡」的讀法。 */
  left: 50%; bottom: 24%;
  width: 50%;
  transform: translate(-50%, 34%) scale(.6);
  opacity: 0;
  pointer-events: none;
  filter: drop-shadow(0 1.6cqw 1.6cqw rgba(0, 0, 0, .65));
}
.ejected img { display: block; width: 100%; border-radius: 4%; }
/* 靜態 opened（外部控制、沒跑過動畫）也要看得到卡 */
.open .ejected { opacity: 1; transform: translate(-50%, 0) scale(1); }
.ph-reveal .ejected { animation: eject .95s cubic-bezier(.2, 1.3, .4, 1) forwards; }
@keyframes eject {
  0%   { opacity: 0; transform: translate(-50%, 46%) scale(.55); }
  22%  { opacity: 1; }
  72%  { transform: translate(-50%, -6%) scale(1.05); }
  100% { opacity: 1; transform: translate(-50%, 0) scale(1); }
}

/* ---- 艙內粒子 ---- */
.mote { transform-box: fill-box; transform-origin: 50% 50%; }
@media (prefers-reduced-motion: no-preference) {
  .mote { animation-name: mote-drift; animation-timing-function: ease-in-out;
          animation-iteration-count: infinite; animation-direction: alternate; }
}
@keyframes mote-drift {
  from { transform: translate(-3px, 2px) scale(.6); opacity: .35; }
  to   { transform: translate(4px, -4px) scale(1.3); opacity: 1; }
}

/* ---- 球體周圍的環繞特效 ----
   .fxBack 在所有球體圖層之前、.fxFront 在下半殼之後，
   同一條軌道被球身切成「擋住的那半」跟「蓋住球的那半」。
   svg overflow 開著，微粒才能飄出球的外框。 */
.fx {
  position: absolute; inset: 0;
  pointer-events: none;
}
.fx svg { display: block; width: 100%; height: 100%; overflow: visible; }
.orb, .orbDot, .shock {
  transform-box: fill-box;
  transform-origin: 50% 50%;
}
/* 軌道光點：開啟後轉成滿亮，當作 reveal 的持續環繞光暈 */
.orbitRing { opacity: .5; transition: opacity .45s ease; }
.open .orbitRing { opacity: 1; }
.pip { stroke-dashoffset: 0; }
.shock { opacity: 0; }

@media (prefers-reduced-motion: no-preference) {
  .orbDot {
    animation-name: orb-drift;
    animation-timing-function: ease-in-out;
    animation-iteration-count: infinite;
    animation-direction: alternate;
  }
  /* 光點沿著軌道跑。遠圈與近圈的行進方向接得上，看起來是同一圈能量在繞 */
  .pip { animation: pip-flow 3.8s linear infinite; }
  /* 蓄能：微粒往球心收束。「往內收」比「單純變亮」更像在充能 */
  .ph-charge .orb, .ph-hold .orb, .ph-crack .orb {
    animation: orb-suck .62s cubic-bezier(.4, 0, .7, .2) both;
  }
  /* 光爆：一口氣甩出去。0.3s 收尾，剛好接上 reveal */
  .ph-burst .orb { animation: orb-blast .3s cubic-bezier(.1, .75, .3, 1) both; }
  .ph-reveal .orb { animation: orb-return .9s ease .18s both; }
  .ph-burst .shock, .ph-reveal .shock {
    animation: shock .85s cubic-bezier(.15, .85, .35, 1) both;
  }
}
@keyframes orb-drift {
  from { transform: translate(0, 0) scale(.8); opacity: .45; }
  to   { transform: translate(var(--drx), var(--dry)) scale(1.16); opacity: 1; }
}
@keyframes pip-flow { to { stroke-dashoffset: -50; } }
@keyframes orb-suck {
  0%   { transform: translate(0, 0) scale(1); opacity: 1; }
  /* 先漲一下再往內鑽。直接一路縮進去會讀成「消失」，漲一下才讀成「被吸走」 */
  26%  { transform: translate(calc(var(--dx) * -.12), calc(var(--dy) * -.12)) scale(1.55); opacity: 1; }
  74%  { opacity: 1; }
  100% { transform: translate(calc(var(--dx) * -.84), calc(var(--dy) * -.84)) scale(.28); opacity: 0; }
}
@keyframes orb-blast {
  0%   { transform: translate(calc(var(--dx) * -.84), calc(var(--dy) * -.84)) scale(.28); opacity: 1; }
  55%  { opacity: 1; }
  100% { transform: translate(calc(var(--dx) * .55), calc(var(--dy) * .55)) scale(1.6); opacity: 0; }
}
@keyframes orb-return { from { opacity: 0; } to { opacity: 1; } }
/* 衝擊環走的是赤道平面的橢圓，不是正圓 —— 跟球面幾何同一個俯角，
   所以它讀起來是從球裡「橫著」擴出去，而不是貼在畫面上的圈 */
@keyframes shock {
  0%   { transform: scale(.34); opacity: 0; }
  12%  { opacity: .9; }
  100% { transform: scale(2.1); opacity: 0; }
}

.gloss {
  position: absolute; inset: 0;
  pointer-events: none; opacity: 0; transition: opacity .3s;
  mix-blend-mode: soft-light;
  border-radius: 50%;
}
.tilting.active .gloss { opacity: 1; }

.plate {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: grid; gap: 2px; justify-items: center;
}
.gLabel {
  font-family: var(--font-body);
  font-size: 4.4cqw; font-weight: 700; letter-spacing: .16em;
}
.gHash {
  font-family: var(--font-mono);
  font-size: 2.9cqw; letter-spacing: .08em;
  color: var(--muted);
}

.paused * { animation-play-state: paused !important; }

@media (prefers-reduced-motion: reduce) {
  .lidGroup { transition: none; }
  .gloss { display: none; }
  /* 環繞特效整組定格：微粒停在原位、光點不跑、衝擊環不出現 */
  .orb, .orbDot, .pip, .shock { animation: none !important; }
  .shock { display: none; }
  .shadowCore, .shadowSoft, .orbitRing, .lidSpec { transition: none; }
}
</style>
