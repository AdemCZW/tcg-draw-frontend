<script setup lang="ts">
/**
 * 開卡前的蓄勢演出 —— 每個球階一支獨立編排的動畫。
 *
 * 之前的版本是同一套「蓄力→爆」骨架重複 N 次、只換顏色 —— 重複本身
 * 就是無趣的來源。查了 FGO 的召喚演出後改走它的路線：每個稀有度有
 * **專屬裝置**（虹回轉＝五星、三環＝現物確定、銀轉金的昇格雷擊），
 * 不是同一招放大。五支編排：
 *
 *   精靈球「快門」   乾淨俐落一炸，無裝飾（低階就該輕快，1.5 秒）
 *   超級球「潮汐」   水波紋擴散、球體液態晃動、水滴拋物濺射
 *   高級球「鍛金」   金塵上升、兩記鍛打（打鐵的節拍）、金光雨收尾
 *   豪華球「烈焰螺旋」火舌軌道渦旋、火柱昇騰、重擊爆裂
 *   大師球「銀河變身」暗轉 → 星空 → 四顆彗星依序被吸收（就是前四階的
 *                     顏色 —— 等級階梯從「重複四次」變成「一段敘事」）
 *                     → 彩虹渦蓄力 → 全靜止 → 超新星
 *
 * 結構是資料驅動的：每支編排是一串 Act，root 掛 `m-{球階}` 與
 * `act-{段名}` 兩組 class，CSS 據此決定哪些圖層活著。通用圖層
 * （火焰／粒子／集中線）共用，簽名圖層（波紋／鍛打／渦旋／彗星）
 * 由各球階 v-if 掛載。
 *
 * ---- 誠實升級 ----
 * 不做假性升級（先閃大獎色再降回去的 near-miss 暗黑模式）。
 * 每支編排從頭到尾就是該 tier 的真實演出。
 *
 * ---- CSS + setTimeout，不用 canvas + rAF ----
 * rAF 在分頁不可見或被節流時不推進，序列會卡在半途。CSS keyframes
 * 被節流也只是慢，狀態仍會走完。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { Tier } from '@/types/models'

const props = withDefaults(defineProps<{
  tier?: Tier
  /** 掛載後自動開始 */
  auto?: boolean
}>(), { tier: 'D', auto: false })

const emit = defineEmits<{ (e: 'done'): void }>()

/** BUST 沿用精靈球的演出 */
const motif = computed(() => (props.tier === 'BUST' ? 'D' : props.tier))

const BLUE = '#8fb6ff'
const CYAN = '#5fe0ff'
const GOLD = '#ffd75e'
const FLAME = '#ff8a3d'
const VIOLET = '#b98cff'

const MOTIF_COLOUR: Record<string, string> = {
  D: BLUE, C: CYAN, B: GOLD, A: FLAME, LAST: VIOLET
}

/* ---- 編排腳本 ----
   act 的種類決定 CSS 行為；pip 標記「值得亮一顆計數點」的節拍。
   彗星四段各自帶前一階的顏色 —— 大師球把整條等級階梯吸進來。 */
type ActKind =
  | 'ignite' | 'charge' | 'ripple' | 'dustup' | 'strike' | 'strike2'
  | 'vortex' | 'pillarup' | 'dim' | 'stars'
  | 'comet1' | 'comet2' | 'comet3' | 'comet4'
  | 'swirl' | 'hold' | 'burst' | 'nova' | 'after'
type Act = { k: ActKind; ms: number; c?: string; pip?: boolean }

const SCRIPTS: Record<string, Act[]> = {
  D: [
    { k: 'ignite', ms: 360 },
    { k: 'charge', ms: 560 },
    { k: 'hold', ms: 120 },
    { k: 'burst', ms: 520, pip: true }
  ],
  C: [
    { k: 'ignite', ms: 360 },
    { k: 'ripple', ms: 780, pip: true },
    { k: 'charge', ms: 860 },
    { k: 'hold', ms: 130 },
    { k: 'burst', ms: 600, pip: true },
    { k: 'after', ms: 340 }
  ],
  B: [
    { k: 'ignite', ms: 360 },
    { k: 'dustup', ms: 860 },
    { k: 'strike', ms: 320, pip: true },
    { k: 'strike2', ms: 320, pip: true },
    { k: 'charge', ms: 920 },
    { k: 'hold', ms: 150 },
    { k: 'burst', ms: 660, pip: true },
    { k: 'after', ms: 500 }
  ],
  A: [
    { k: 'ignite', ms: 360 },
    { k: 'charge', ms: 740, pip: true },
    { k: 'vortex', ms: 1900, pip: true },
    { k: 'pillarup', ms: 1250, pip: true },
    { k: 'hold', ms: 180 },
    { k: 'burst', ms: 740, pip: true },
    { k: 'after', ms: 480 }
  ],
  LAST: [
    { k: 'dim', ms: 520 },
    { k: 'stars', ms: 900 },
    { k: 'comet1', ms: 680, c: BLUE, pip: true },
    { k: 'comet2', ms: 680, c: CYAN, pip: true },
    { k: 'comet3', ms: 680, c: GOLD, pip: true },
    { k: 'comet4', ms: 680, c: FLAME, pip: true },
    { k: 'swirl', ms: 2100 },
    { k: 'hold', ms: 300 },
    { k: 'nova', ms: 1050, pip: true },
    { k: 'after', ms: 700 }
  ]
}
/* 全長：D 1.6s / C 3.1s / B 4.1s / A 5.7s / LAST 8.3s。
   低階維持輕快，最高階跟 FGO 虹回轉同量級的「還沒完？」。 */

/* ---- 各球階的圖層配額 ----
   通用圖層開多少、簽名圖層掛不掛，都在這裡。 */
const MOTIF_CFG: Record<string, {
  aura: number; ember: number; arcs: number; tunnel: boolean; converge: number
  shard: number; spark: number; ray: number; rings: number; flare: number
  glint: number; dust: number; shock: number; shake: number; chroma: boolean
  pillarBoom: boolean; sweep: boolean
}> = {
  D: { aura: 0, ember: 8, arcs: 0, tunnel: false, converge: 0,
       shard: .3, spark: .3, ray: 0, rings: 1, flare: 0,
       glint: 0, dust: 0, shock: .6, shake: .15, chroma: false,
       pillarBoom: false, sweep: false },
  C: { aura: 8, ember: 18, arcs: 0, tunnel: false, converge: 2,
       shard: .5, spark: .55, ray: .4, rings: 2, flare: 0,
       glint: 0, dust: 0, shock: .85, shake: .4, chroma: false,
       pillarBoom: false, sweep: false },
  B: { aura: 0, ember: 0, arcs: 0, tunnel: true, converge: 2,
       shard: .7, spark: .75, ray: .7, rings: 3, flare: 2,
       glint: 14, dust: 26, shock: 1.05, shake: .6, chroma: true,
       pillarBoom: false, sweep: false },
  A: { aura: 22, ember: 26, arcs: 6, tunnel: true, converge: 2,
       shard: .9, spark: .9, ray: 1, rings: 3, flare: 2,
       glint: 8, dust: 12, shock: 1.3, shake: .85, chroma: true,
       pillarBoom: true, sweep: false },
  LAST: { aura: 24, ember: 32, arcs: 10, tunnel: true, converge: 3,
          shard: 1, spark: 1, ray: 1, rings: 3, flare: 4,
          glint: 18, dust: 34, shock: 1.65, shake: 1, chroma: true,
          pillarBoom: true, sweep: true }
}

const script = computed(() => SCRIPTS[motif.value])
const cfg = computed(() => MOTIF_CFG[motif.value])

const actIndex = ref(-1)
const running = ref(false)
const timers: number[] = []

const act = computed<Act>(() =>
  actIndex.value < 0 ? { k: 'ignite', ms: 0 } : script.value[Math.min(actIndex.value, script.value.length - 1)])

/** 蓄力類 act：通用循環圖層在這些段落活著（hold 也算 —— 凍結需要宣告還在） */
const CHARGY = new Set<ActKind>([
  'charge', 'ripple', 'dustup', 'strike', 'strike2', 'vortex', 'pillarup',
  'stars', 'comet1', 'comet2', 'comet3', 'comet4', 'swirl', 'hold'
])
const BOOMY = new Set<ActKind>(['burst', 'nova'])

const chargy = computed(() => running.value && CHARGY.has(act.value.k))
const boomy = computed(() => running.value && BOOMY.has(act.value.k))
const holding = computed(() => running.value && act.value.k === 'hold')
const isRainbow = computed(() =>
  motif.value === 'LAST' && ['swirl', 'hold', 'nova', 'after'].includes(act.value.k))

const colour = computed(() => {
  if (isRainbow.value) return '#fff'
  return act.value.c ?? MOTIF_COLOUR[motif.value]
})
/** 球體大小隨整支編排推進放大 —— 演出越後面球越大 */
const intensity = computed(() =>
  running.value ? (actIndex.value + 1) / script.value.length : 0.3)

/** 計數點：值得記的節拍數，亮到目前為止經過的 */
const pipTotal = computed(() => script.value.filter(a => a.pip).length)
const pipLit = computed(() =>
  script.value.slice(0, actIndex.value + 1).filter(a => a.pip).length)

function clear() {
  timers.forEach(clearTimeout)
  timers.length = 0
}
function runFrom(i: number) {
  if (i >= script.value.length) {
    running.value = false
    emit('done')
    return
  }
  actIndex.value = i
  timers.push(window.setTimeout(() => runFrom(i + 1), script.value[i].ms))
}
function start() {
  if (running.value) return
  clear()
  running.value = true
  runFrom(0)
}
function reset() {
  clear()
  running.value = false
  actIndex.value = -1
}
onBeforeUnmount(clear)
defineExpose({ start, reset })
if (props.auto) start()

/* ---- 粒子表（固定種子：同一階每次的形狀相同，是規律不是噪音） ---- */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const n1 = (v: number) => +v.toFixed(1)
const take = <T,>(arr: T[], frac: number, min: number) =>
  frac <= 0 ? [] : arr.slice(0, Math.max(min, Math.round(arr.length * frac)))

const SHARDS = (() => {
  const r = mulberry32(20260814)
  return Array.from({ length: 40 }, (_, i) => ({
    a: n1((i * 360) / 40 + (r() - 0.5) * 16), d: n1(40 + r() * 42),
    w: n1(5 + r() * 12), h: n1(14 + r() * 30),
    spin: Math.round((r() - 0.5) * 300), delay: Math.round(r() * 70)
  }))
})()
const SPARKS = (() => {
  const r = mulberry32(77)
  return Array.from({ length: 72 }, () => ({
    a: n1(r() * 360), d: n1(34 + r() * 62), s: n1(2 + r() * 5),
    dur: Math.round(420 + r() * 520), delay: Math.round(r() * 220)
  }))
})()
const STREAKS = (() => {
  const r = mulberry32(5150)
  return Array.from({ length: 30 }, (_, i) => ({
    a: n1((i * 360) / 30 + (r() - 0.5) * 16), len: n1(22 + r() * 34),
    delay: Math.round(r() * 240)
  }))
})()
const RAYS = (() => {
  const r = mulberry32(3131)
  return Array.from({ length: 20 }, (_, i) => ({
    a: n1((i * 360) / 20 + (r() - 0.5) * 10), w: n1(2 + r() * 9),
    len: n1(46 + r() * 34), delay: Math.round(r() * 50)
  }))
})()
const FLARES = [0, 90, 45, 135]
const AURA = (() => {
  const r = mulberry32(606)
  return Array.from({ length: 24 }, (_, i) => {
    const a = (i * 360) / 24 + (r() - 0.5) * 12
    const rad = (a * Math.PI) / 180
    return {
      x: n1(50 + Math.cos(rad) * 44), y: n1(50 + Math.sin(rad) * 44),
      tilt: n1(Math.cos(rad) * 22), w: n1(4 + r() * 3.5), h: n1(16 + r() * 16),
      dur: Math.round(520 + r() * 520), delay: Math.round(r() * 600)
    }
  })
})()
const EMBERS = (() => {
  const r = mulberry32(1717)
  return Array.from({ length: 38 }, () => ({
    x: n1(10 + r() * 80), y0: n1(58 + r() * 30),
    s: +(0.8 + r() * 1.4).toFixed(2), rise: Math.round(30 + r() * 38),
    drift: Math.round((r() - 0.5) * 10),
    dur: Math.round(1100 + r() * 1400), delay: Math.round(r() * 1500)
  }))
})()
const ARCS = (() => {
  const r = mulberry32(2929)
  return Array.from({ length: 10 }, (_, i) => {
    const a = (i * 360) / 10 + (r() - 0.5) * 20
    const rad = (a * Math.PI) / 180
    return {
      x: n1(50 + Math.cos(rad) * 20), y: n1(50 + Math.sin(rad) * 17),
      rot: Math.round(r() * 360), w: n1(7 + r() * 8),
      dur: Math.round(240 + r() * 420), delay: Math.round(r() * 900)
    }
  })
})()
const TUNNEL = (() => {
  const r = mulberry32(8080)
  return Array.from({ length: 36 }, (_, i) => ({
    a: n1(i * 10 + (r() - 0.5) * 6), len: Math.round(24 + r() * 30),
    o: +(0.08 + r() * 0.16).toFixed(2)
  }))
})()
const GLINTS = (() => {
  const r = mulberry32(88991)
  return Array.from({ length: 18 }, () => ({
    x: n1(10 + r() * 80), y: n1(12 + r() * 76),
    s: Math.round(10 + r() * 22), r0: Math.round(r() * 90),
    dur: Math.round(520 + r() * 620), delay: Math.round(r() * 700)
  }))
})()
const DUST = (() => {
  const r = mulberry32(4242)
  return Array.from({ length: 34 }, () => ({
    x: n1(6 + r() * 88), s: n1(2 + r() * 4), rise: Math.round(30 + r() * 46),
    dur: Math.round(900 + r() * 900), delay: Math.round(r() * 400),
    drift: Math.round((r() - 0.5) * 40)
  }))
})()
/* ---- 簽名粒子 ---- */
/** 超級球：水滴拋物濺射（上拋後落下） */
const DROPS = (() => {
  const r = mulberry32(333)
  return Array.from({ length: 16 }, () => ({
    dx: Math.round((r() - 0.5) * 72),
    up: Math.round(16 + r() * 26),
    fall: Math.round(30 + r() * 30),
    s: n1(2 + r() * 3.5),
    dur: Math.round(620 + r() * 380),
    delay: Math.round(r() * 140)
  }))
})()
/** 高級球：金光雨（收尾落下的碎金） */
const RAIN = (() => {
  const r = mulberry32(555)
  return Array.from({ length: 30 }, () => ({
    x: n1(4 + r() * 92), len: n1(6 + r() * 12),
    dur: Math.round(500 + r() * 600), delay: Math.round(r() * 480)
  }))
})()
/** 豪華球：渦旋火舌（繞球體公轉的軌道火焰） */
const VORTEX = (() => {
  const r = mulberry32(999)
  return Array.from({ length: 14 }, (_, i) => ({
    a: n1((i * 360) / 14 + (r() - 0.5) * 10),
    rad: n1(30 + r() * 12),
    h: n1(14 + r() * 14),
    o: +(0.5 + r() * 0.5).toFixed(2)
  }))
})()
/** 大師球：星空 */
const STARS = (() => {
  const r = mulberry32(20261)
  return Array.from({ length: 46 }, () => ({
    x: n1(2 + r() * 96), y: n1(3 + r() * 90),
    s: n1(1 + r() * 2.2),
    dur: Math.round(900 + r() * 1600), delay: Math.round(r() * 1400)
  }))
})()
/** 大師球：四顆彗星的進場參數（各自從不同角落掃進來） */
const COMETS = [
  { c: BLUE, from: -150, to: -18 },
  { c: CYAN, from: 130, to: 4 },
  { c: GOLD, from: -60, to: 76 },
  { c: FLAME, from: 210, to: 128 }
]

const shardsNow = computed(() => take(SHARDS, cfg.value.shard, 10))
const sparksNow = computed(() => take(SPARKS, cfg.value.spark, 14))
const raysNow = computed(() => take(RAYS, cfg.value.ray, 6))
const flaresNow = computed(() => FLARES.slice(0, cfg.value.flare))
const glintsNow = computed(() => GLINTS.slice(0, cfg.value.glint))
const dustNow = computed(() => DUST.slice(0, cfg.value.dust))
const auraNow = computed(() => AURA.slice(0, cfg.value.aura))
const embersNow = computed(() => EMBERS.slice(0, cfg.value.ember))
const arcsNow = computed(() => ARCS.slice(0, cfg.value.arcs))
</script>

<template>
  <div
    class="buildup"
    :class="[`m-${motif}`, `act-${act.k}`, {
      run: running, chargy, boomy, holding, rainbow: isRainbow
    }]"
    :style="{ '--c': colour, '--k': intensity, '--shake': cfg.shake, '--sk': cfg.shock }"
    aria-hidden="true"
  >
    <div class="veil"></div>
    <!-- 大師球的暗轉：比一般 veil 更深，「畫面異常變暗」本身就是高稀有訊號 -->
    <div v-if="motif === 'LAST'" class="veil2"></div>

    <!-- 星空（大師球） -->
    <div v-if="motif === 'LAST'" class="stars">
      <i
        v-for="(s, i) in STARS" :key="i"
        :style="{ left: s.x + '%', top: s.y + '%', '--s': s.s + 'px',
                  '--dur': s.dur + 'ms', '--dl': s.delay + 'ms' }"
      ></i>
    </div>

    <!-- 集中線隧道 -->
    <div v-if="cfg.tunnel" class="tunnel">
      <i
        v-for="(t, i) in TUNNEL" :key="i"
        :style="{ '--a': t.a + 'deg', '--len': t.len + 'cqmax', '--o': t.o }"
      ></i>
    </div>

    <!-- 點火收束線 -->
    <div class="streaks">
      <i
        v-for="(s, i) in STREAKS" :key="i"
        :style="{ '--a': s.a + 'deg', '--len': s.len + '%', '--dl': s.delay + 'ms' }"
      ></i>
    </div>

    <!-- 收束環 -->
    <div v-if="cfg.converge" class="converge">
      <i v-for="c in cfg.converge" :key="c" :style="{ '--dl': (c - 1) * 380 + 'ms' }"></i>
    </div>

    <!-- 水波紋（超級球）：從球心一圈圈擴出去的細環 -->
    <div v-if="motif === 'C'" class="ripples">
      <i v-for="i in 3" :key="i" :style="{ '--dl': (i - 1) * 420 + 'ms' }"></i>
    </div>

    <!-- 氣場火焰 -->
    <div v-if="auraNow.length" class="aura">
      <i
        v-for="(f, i) in auraNow" :key="i"
        :style="{ left: f.x + '%', top: f.y + '%',
                  '--tilt': f.tilt + 'deg', '--w': f.w + '%', '--h': f.h + '%',
                  '--dur': f.dur + 'ms', '--dl': f.delay + 'ms' }"
      ></i>
    </div>

    <!-- 渦旋火舌（豪華球）：整圈公轉 -->
    <div v-if="motif === 'A'" class="vortex">
      <div class="vSpin">
        <i
          v-for="(v, i) in VORTEX" :key="i"
          :style="{ '--a': v.a + 'deg', '--rad': v.rad + 'cqmin', '--h': v.h + 'cqmin', '--o': v.o }"
        ></i>
      </div>
    </div>

    <!-- 球體 -->
    <div class="orb">
      <div class="orbGlow"></div>
      <div class="orbBody"></div>
      <div class="orbRim"></div>
    </div>

    <!-- 彗星（大師球）：前四階的顏色依序被吸進球心 -->
    <template v-if="motif === 'LAST'">
      <div
        v-for="(cm, i) in COMETS" :key="i"
        class="cometW" :class="`cw${i + 1}`"
        :style="{ '--from': cm.from + 'deg', '--to': cm.to + 'deg', '--cc': cm.c }"
      >
        <i class="comet"></i>
      </div>
    </template>

    <!-- 上升粒子 -->
    <div v-if="embersNow.length" class="embers">
      <i
        v-for="(e, i) in embersNow" :key="i"
        :style="{ left: e.x + '%', top: e.y0 + '%',
                  '--s': e.s + 'cqmin', '--rise': e.rise + 'cqh', '--drift': e.drift + 'cqw',
                  '--dur': e.dur + 'ms', '--dl': e.delay + 'ms' }"
      ></i>
    </div>

    <!-- 金塵（高級球蓄力時上升；也是通用金粉爆出層） -->
    <div v-if="dustNow.length" class="dust">
      <i
        v-for="(d, i) in dustNow" :key="i"
        :style="{ left: d.x + '%', '--s': d.s + 'px', '--rise': d.rise + '%',
                  '--drift': d.drift + 'px', '--dur': d.dur + 'ms', '--dl': d.delay + 'ms' }"
      ></i>
    </div>

    <!-- 電光 -->
    <div v-if="arcsNow.length" class="arcs">
      <i
        v-for="(a, i) in arcsNow" :key="i"
        :style="{ left: a.x + '%', top: a.y + '%',
                  '--rot': a.rot + 'deg', '--w': a.w + 'cqmin',
                  '--dur': a.dur + 'ms', '--dl': a.delay + 'ms' }"
      ></i>
    </div>

    <!-- 鍛打閃擊（高級球）：兩記鍛打的白閃 -->
    <div v-if="motif === 'B'" class="strikeFlash"></div>

    <!-- 光柱：豪華球蓄力昇騰用 + 高階爆裂用 -->
    <div v-if="cfg.pillarBoom || motif === 'A'" class="pillar"></div>

    <!-- ===== 爆裂那一拍的一次性圖層 ===== -->
    <div class="rays">
      <i
        v-for="(r, i) in raysNow" :key="`${actIndex}-${i}`"
        :style="{ '--a': r.a + 'deg', '--w': r.w + 'px', '--len': r.len + '%', '--dl': r.delay + 'ms' }"
      ></i>
    </div>
    <div class="shards">
      <i
        v-for="(s, i) in shardsNow" :key="`${actIndex}-${i}`"
        :style="{ '--a': s.a + 'deg', '--d': s.d + '%', '--w': s.w + 'px', '--h': s.h + 'px',
                  '--spin': s.spin + 'deg', '--dl': s.delay + 'ms' }"
      ></i>
    </div>
    <div class="sparks">
      <i
        v-for="(s, i) in sparksNow" :key="`${actIndex}-${i}`"
        :style="{ '--a': s.a + 'deg', '--d': s.d + '%', '--s': s.s + 'px',
                  '--dur': s.dur + 'ms', '--dl': s.delay + 'ms' }"
      ></i>
    </div>
    <!-- 水滴濺射（超級球） -->
    <div v-if="motif === 'C'" class="drops">
      <i
        v-for="(d, i) in DROPS" :key="`${actIndex}-${i}`"
        :style="{ '--dx': d.dx + 'cqw', '--up': d.up + 'cqh', '--fall': d.fall + 'cqh',
                  '--s': d.s + 'px', '--dur': d.dur + 'ms', '--dl': d.delay + 'ms' }"
      ></i>
    </div>
    <!-- 金光雨（高級球收尾） -->
    <div v-if="motif === 'B'" class="rain">
      <i
        v-for="(d, i) in RAIN" :key="i"
        :style="{ left: d.x + '%', '--len': d.len + 'cqh',
                  '--dur': d.dur + 'ms', '--dl': d.delay + 'ms' }"
      ></i>
    </div>
    <div v-if="flaresNow.length" class="flare">
      <i v-for="(a, i) in flaresNow" :key="`${actIndex}-${i}`" :style="{ '--a': a + 'deg' }"></i>
    </div>
    <div v-if="cfg.sweep" class="sweep"></div>
    <div class="shock"></div>
    <template v-if="cfg.chroma">
      <div class="chroma cr"></div>
      <div class="chroma cb"></div>
    </template>
    <div v-if="glintsNow.length" class="glints">
      <i
        v-for="(g, i) in glintsNow" :key="`${actIndex}-${i}`"
        :style="{ left: g.x + '%', top: g.y + '%', '--s': g.s + 'px', '--r0': g.r0 + 'deg',
                  '--dur': g.dur + 'ms', '--dl': g.delay + 'ms' }"
      ></i>
    </div>
    <div class="ring r1"></div>
    <div v-if="cfg.rings > 1" class="ring r2"></div>
    <div v-if="cfg.rings > 2" class="ring r3"></div>
    <div class="tint"></div>
    <div class="flash"></div>

    <!-- 節拍計數點 -->
    <div v-if="pipTotal > 1" class="pips">
      <i v-for="i in pipTotal" :key="i" :class="{ on: i <= pipLit }"></i>
    </div>
  </div>
</template>

<style scoped>
.buildup {
  position: absolute; inset: 0;
  overflow: hidden;
  display: grid; place-items: center;
  pointer-events: none;
  container-type: size;   /* cqh/cqmin：粒子尺寸相對舞台，不寫死 px */
  --c: #8fb6ff;
  --k: 0.4;
}
.buildup > * { grid-area: 1 / 1; }
.buildup:not(.run) { opacity: 0; }
.buildup:not(.run) > * { opacity: 0; }

/* ---- 全靜止：蓄力循環凍在半空。hold 保有 chargy（宣告相同不重播），
   這條 pause 才有東西可暫停。動 → 停 → 炸。 ---- */
.holding *, .holding.buildup { animation-play-state: paused !important; }

/* ---- 鏡頭推進：蓄力期間緩慢放大，爆裂瞬間彈回 ---- */
@media (prefers-reduced-motion: no-preference) {
  .chargy.buildup { animation: cam-push 3200ms cubic-bezier(.4, 0, .8, .6) forwards; }
}
@keyframes cam-push { from { transform: scale(1); } to { transform: scale(1.07); } }

.veil {
  width: 100%; height: 100%;
  background: radial-gradient(circle, rgba(0, 0, 0, .45), rgba(0, 0, 0, .82) 70%);
  opacity: 0; transition: opacity .3s;
}
.run .veil { opacity: 1; }
/* 暗轉：大師球開場整個畫面沉下去 */
.veil2 {
  width: 100%; height: 100%;
  background: #020108;
  opacity: 0; transition: opacity .5s;
}
.act-dim .veil2 { opacity: .88; }
.act-stars .veil2, .act-comet1 .veil2, .act-comet2 .veil2,
.act-comet3 .veil2, .act-comet4 .veil2 { opacity: .72; }
.act-swirl .veil2, .act-hold .veil2 { opacity: .5; }

/* ---- 星空（大師球）：暗轉後浮現，超新星時全部往外吹走 ---- */
.stars { width: 100%; height: 100%; }
.stars i {
  position: absolute;
  width: var(--s); height: var(--s);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 4px #cdd8ff;
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .chargy .stars i { animation: star-twinkle var(--dur) ease-in-out var(--dl) infinite; }
  .act-nova .stars i { animation: star-blow 700ms cubic-bezier(.1, .8, .3, 1) forwards; }
}
@keyframes star-twinkle {
  0%, 100% { opacity: .12; }
  50%      { opacity: .95; }
}
@keyframes star-blow {
  0%   { opacity: .9; transform: translate(0, 0); }
  100% { opacity: 0; transform: translate(calc((var(--s) - 2px) * 30), calc((var(--s) - 2px) * -22)); }
}

/* ---- 集中線隧道 ---- */
.tunnel { position: absolute; inset: -25%; opacity: 0; transition: opacity .4s; }
.tunnel i {
  position: absolute; left: 50%; top: 50%;
  width: 1.5px; height: var(--len);
  margin-left: -.75px;
  background: linear-gradient(to top, rgba(255, 255, 255, var(--o)), transparent);
  transform-origin: 50% 0;
  transform: rotate(var(--a)) translateY(22cqmin);
}
@media (prefers-reduced-motion: no-preference) {
  .chargy .tunnel { opacity: 1; animation: tunnel-spin 16s linear infinite; }
  /* 豪華球的渦旋段：隧道跟著加速，整個空間在轉 */
  .act-vortex .tunnel, .act-pillarup .tunnel { animation-duration: 7s; }
}
@keyframes tunnel-spin { to { transform: rotate(360deg); } }

/* ---- 球體 ---- */
.orb { width: 30%; aspect-ratio: 1; display: grid; place-items: center; transform: scale(0); }
.orb > * { grid-area: 1 / 1; border-radius: 50%; }
.orbGlow {
  width: 320%; height: 320%;
  background: radial-gradient(circle, var(--c) 0%, transparent 58%);
  opacity: calc(.4 + var(--k) * .5);
  filter: blur(10px);
}
.orbBody {
  width: 100%; height: 100%;
  background:
    radial-gradient(circle at 36% 30%, #fff 0%, var(--c) 42%, transparent 72%),
    radial-gradient(circle, var(--c) 40%, transparent 70%);
  box-shadow: 0 0 30px var(--c), 0 0 80px var(--c), 0 0 140px var(--c),
              inset 0 0 26px rgba(255, 255, 255, .8);
}
.orbRim { width: 116%; height: 116%; border: 2px solid var(--c); opacity: .55; }
.rainbow .orbBody {
  background:
    radial-gradient(circle at 36% 30%, #fff 0%, transparent 46%),
    conic-gradient(#ff5f6d, #ffd75e, #7dff9b, #5fe0ff, #b98cff, #ff5f6d);
  box-shadow: 0 0 40px #ffb0e8, 0 0 110px #ff9ee0, 0 0 180px #b98cff,
              inset 0 0 30px rgba(255, 255, 255, .9);
}
.rainbow .orbGlow {
  background: conic-gradient(#ff5f6d55, #ffd75e55, #7dff9b55, #5fe0ff55, #b98cff55, #ff5f6d55);
  filter: blur(18px);
}
@media (prefers-reduced-motion: no-preference) {
  .chargy .orb, .act-ignite .orb {
    animation:
      orb-in 320ms cubic-bezier(.3, .7, .4, 1) forwards,
      orb-pulse 640ms 320ms ease-in-out infinite alternate;
  }
  .boomy .orb { animation: orb-burst 340ms cubic-bezier(.2, .9, .3, 1) forwards; }
  /* 彩虹球自轉：靜止的 conic 是調色盤不是能量體 */
  .rainbow.chargy .orbBody, .rainbow.chargy .orbGlow { animation: orb-spin 3.2s linear infinite; }
  /* 超級球：液態晃動 —— 水珠不是剛體 */
  .m-C.chargy .orbBody { animation: liquid-wobble 900ms ease-in-out infinite alternate; }
}
@keyframes orb-in {
  from { transform: scale(.2); opacity: 0; }
  to   { transform: scale(calc(.5 + var(--k) * .38)); opacity: 1; }
}
@keyframes orb-pulse {
  from { transform: scale(calc(.5 + var(--k) * .38)); }
  to   { transform: scale(calc(.58 + var(--k) * .42)); }
}
@keyframes orb-burst {
  0%   { transform: scale(calc(.56 + var(--k) * .4)); opacity: 1; }
  22%  { transform: scale(calc(.4 + var(--k) * .24)); opacity: 1; }
  100% { transform: scale(calc(1.5 + var(--k) * .8)); opacity: 0; }
}
@keyframes orb-spin { to { rotate: 1turn; } }
@keyframes liquid-wobble {
  from { scale: 1.06 .94; }
  to   { scale: .94 1.06; }
}

/* ---- 水波紋（超級球） ---- */
.ripples { width: 100%; height: 100%; display: grid; place-items: center; }
.ripples > * { grid-area: 1 / 1; }
.ripples i {
  width: 30cqmin; height: 30cqmin;
  border: 1.5px solid var(--c);
  border-radius: 50%;
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .chargy .ripples i { animation: ripple-out 1260ms cubic-bezier(.2, .6, .4, 1) var(--dl) infinite; }
}
@keyframes ripple-out {
  0%   { transform: scale(.4); opacity: 0; }
  18%  { opacity: .7; }
  100% { transform: scale(2.6); opacity: 0; }
}

/* ---- 氣場火焰 ---- */
.aura { width: 34%; aspect-ratio: 1; position: relative; }
.aura i {
  position: absolute;
  width: var(--w); height: var(--h);
  translate: -50% -100%;
  transform-origin: 50% 100%;
  border-radius: 50% 50% 50% 50% / 78% 78% 22% 22%;
  background: linear-gradient(to top, var(--c), rgba(255, 255, 255, .85) 82%, transparent);
  filter: blur(1px);
  opacity: 0;
}
.rainbow .aura i { background: linear-gradient(to top, #b98cff, #fff 78%, transparent); }
@media (prefers-reduced-motion: no-preference) {
  .chargy .aura i { animation: flame-lick var(--dur) ease-in-out var(--dl) infinite; }
}
@keyframes flame-lick {
  0%   { transform: rotate(var(--tilt)) translateY(0) scaleY(.55); opacity: 0; }
  30%  { opacity: .85; }
  100% { transform: rotate(var(--tilt)) translateY(-130%) scaleY(1.25); opacity: 0; }
}

/* ---- 渦旋火舌（豪華球）：一圈火焰公轉，越晚的段落轉越快 ---- */
.vortex { width: 100%; height: 100%; display: grid; place-items: center; opacity: 0; }
.vSpin { width: 100%; height: 100%; position: relative; }
.vSpin i {
  position: absolute; left: 50%; top: 50%;
  width: 3cqmin; height: var(--h);
  margin-left: -1.5cqmin;
  border-radius: 50% 50% 50% 50% / 80% 80% 20% 20%;
  background: linear-gradient(to top, var(--c), rgba(255, 255, 255, .8) 78%, transparent);
  transform-origin: 50% 0;
  transform: rotate(var(--a)) translateY(var(--rad)) rotate(90deg);
  opacity: var(--o);
  filter: blur(.5px);
}
@media (prefers-reduced-motion: no-preference) {
  .act-vortex .vortex, .act-pillarup .vortex, .m-A.act-hold .vortex { opacity: 1; transition: opacity .4s; }
  .act-vortex .vSpin { animation: vortex-spin 1400ms linear infinite; }
  .act-pillarup .vSpin, .m-A.act-hold .vSpin { animation: vortex-spin 800ms linear infinite; }
}
@keyframes vortex-spin { to { transform: rotate(-360deg); } }

/* ---- 彗星（大師球）----
   外層繞畫面中心掃一段弧，內層同時往中心收 —— 合成螺旋吸入。
   尾端內建吸收閃光（keyframe 末段亮一下），不用共用的 absorb 元素。 */
.cometW {
  position: absolute; inset: 0;
  transform-origin: 50% 50%;
  opacity: 0;
}
.comet {
  position: absolute; left: 50%; top: 50%;
  width: 3cqmin; height: 16cqmin;
  margin-left: -1.5cqmin;
  border-radius: 50% 50% 50% 50% / 80% 80% 20% 20%;
  background: linear-gradient(to top, #fff, var(--cc) 40%, transparent);
  box-shadow: 0 0 14px var(--cc);
  transform-origin: 50% 0;
}
@media (prefers-reduced-motion: no-preference) {
  .act-comet1 .cw1, .act-comet2 .cw2, .act-comet3 .cw3, .act-comet4 .cw4 {
    opacity: 1;
    animation: comet-sweep 660ms cubic-bezier(.3, .1, .5, 1) forwards;
  }
  .act-comet1 .cw1 .comet, .act-comet2 .cw2 .comet,
  .act-comet3 .cw3 .comet, .act-comet4 .cw4 .comet {
    animation: comet-dive 660ms cubic-bezier(.4, 0, .7, 1) forwards;
  }
}
@keyframes comet-sweep {
  from { transform: rotate(var(--from)); }
  to   { transform: rotate(var(--to)); }
}
@keyframes comet-dive {
  0%   { transform: translateY(-64cqmax) scale(.7); opacity: 0; }
  12%  { opacity: 1; }
  78%  { transform: translateY(-9cqmin) scale(1); opacity: 1; }
  88%  { transform: translateY(-4cqmin) scale(1.5); opacity: 1; }
  100% { transform: translateY(-2cqmin) scale(.2); opacity: 0; }
}

/* ---- 上升粒子 ---- */
.embers { width: 100%; height: 100%; }
.embers i {
  position: absolute;
  width: var(--s); height: var(--s);
  border-radius: 50%;
  background: var(--c);
  box-shadow: 0 0 6px var(--c);
  opacity: 0;
}
.rainbow .embers i { background: #ffd0f0; box-shadow: 0 0 6px #ffb0e8; }
@media (prefers-reduced-motion: no-preference) {
  .chargy .embers i { animation: ember-rise var(--dur) linear var(--dl) infinite; }
}
@keyframes ember-rise {
  0%   { transform: translate(0, 0) scale(.6); opacity: 0; }
  15%  { opacity: .9; }
  100% { transform: translate(var(--drift), calc(var(--rise) * -1)) scale(1.1); opacity: 0; }
}

/* ---- 金塵／金粉 ----
   高級球：蓄力時上升（鍛造的火星），爆裂時噴出。其他階只在爆裂時出現。 */
.dust { width: 100%; height: 100%; }
.dust i {
  position: absolute; top: 62%;
  width: var(--s); height: var(--s);
  border-radius: 50%;
  background: #ffe9a8;
  box-shadow: 0 0 6px #ffd75e;
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .m-B.chargy .dust i { animation: ember-rise var(--dur) linear var(--dl) infinite; }
  .boomy .dust i { animation: dust-rise var(--dur) ease-out var(--dl) forwards; }
}
@keyframes dust-rise {
  0%   { transform: translate(0, 0) scale(.4); opacity: 0; }
  20%  { opacity: 1; }
  100% { transform: translate(var(--drift), calc(var(--rise) * -1)) scale(1); opacity: 0; }
}

/* ---- 電光 ---- */
.arcs { width: 100%; height: 100%; }
.arcs i {
  position: absolute;
  width: var(--w); height: calc(var(--w) * .28);
  translate: -50% -50%;
  transform: rotate(var(--rot));
  background: #fff;
  clip-path: polygon(0% 55%, 14% 30%, 30% 62%, 46% 18%, 60% 70%, 74% 34%,
                     88% 58%, 100% 42%, 86% 66%, 68% 46%, 52% 88%, 36% 40%, 20% 74%, 8% 48%);
  filter: drop-shadow(0 0 4px var(--c)) drop-shadow(0 0 9px var(--c));
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  /* steps(2)：電光要「啪、啪」硬切，漸變的閃電讀起來是燈泡 */
  .chargy .arcs i { animation: arc-flick var(--dur) steps(2, jump-none) var(--dl) infinite; }
}
@keyframes arc-flick { 0% { opacity: 0; } 45% { opacity: 1; } 100% { opacity: 0; } }

/* ---- 收束環 ---- */
.converge { width: 100%; height: 100%; display: grid; place-items: center; }
.converge > * { grid-area: 1 / 1; }
.converge i {
  width: 56cqmin; height: 56cqmin;
  border: 1.5px solid var(--c);
  border-radius: 50%;
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .chargy .converge i { animation: ring-in 1150ms cubic-bezier(.4, 0, .7, .4) var(--dl) infinite; }
}
@keyframes ring-in {
  0%   { transform: scale(1.6); opacity: 0; }
  25%  { opacity: .5; }
  100% { transform: scale(.18); opacity: 0; }
}

/* ---- 點火收束線 ---- */
.streaks { width: 100%; height: 100%; }
.streaks i {
  position: absolute; left: 50%; top: 50%;
  width: 2px; height: var(--len);
  margin-left: -1px;
  background: linear-gradient(to bottom, transparent, var(--c));
  transform-origin: 50% 0;
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .act-ignite .streaks i { animation: streak-in 340ms ease-in var(--dl) forwards; }
}
@keyframes streak-in {
  0%   { transform: rotate(var(--a)) translateY(180%); opacity: 0; }
  40%  { opacity: .9; }
  100% { transform: rotate(var(--a)) translateY(6%); opacity: 0; }
}

/* ---- 鍛打（高級球）----
   兩記鍛打：整格白閃 + 急縮 + 震動，第二記更重。打鐵的節拍。 */
.strikeFlash {
  width: 100%; height: 100%;
  background: radial-gradient(circle, #fff 0%, #ffd75e 40%, transparent 72%);
  mix-blend-mode: screen;
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .act-strike .strikeFlash { animation: strike-pop 300ms ease-out forwards; }
  .act-strike2 .strikeFlash { animation: strike-pop2 300ms ease-out forwards; }
  .act-strike.buildup { animation: strike-shake 300ms linear; }
  .act-strike2.buildup { animation: strike-shake2 300ms linear; }
  .act-strike .orb, .act-strike2 .orb { animation: orb-clench 300ms ease-out forwards; }
}
@keyframes strike-pop  { 0% { opacity: 0; } 12% { opacity: .5; } 100% { opacity: 0; } }
@keyframes strike-pop2 { 0% { opacity: 0; } 12% { opacity: .75; } 100% { opacity: 0; } }
@keyframes strike-shake {
  0%, 100% { transform: translate(0, 0); }
  20% { transform: translate(-4px, 3px); }
  55% { transform: translate(3px, -2px); }
}
@keyframes strike-shake2 {
  0%, 100% { transform: translate(0, 0); }
  18% { transform: translate(-7px, 5px); }
  48% { transform: translate(6px, -4px); }
  76% { transform: translate(-3px, 2px); }
}
@keyframes orb-clench {
  0%   { transform: scale(calc(.5 + var(--k) * .38)); }
  30%  { transform: scale(calc(.44 + var(--k) * .3)); }
  100% { transform: scale(calc(.52 + var(--k) * .38)); }
}

/* ---- 光柱 ----
   豪華球：pillarup 段整條昇騰（循環搖曳）；高階爆裂時一次性噴出。 */
.pillar {
  width: 16%; height: 220%;
  background: linear-gradient(to bottom, transparent, var(--c) 22%, #fff 50%, var(--c) 78%, transparent);
  mix-blend-mode: screen;
  filter: blur(6px);
  opacity: 0;
}
.rainbow .pillar {
  background: linear-gradient(to bottom, transparent, #b98cff 20%, #fff 50%, #ffd75e 80%, transparent);
}
@media (prefers-reduced-motion: no-preference) {
  .act-pillarup .pillar, .m-A.act-hold .pillar {
    animation: pillar-rise 700ms cubic-bezier(.2, .7, .3, 1) forwards,
               pillar-sway 900ms 700ms ease-in-out infinite alternate;
  }
  .boomy .pillar { animation: pillar-up 520ms cubic-bezier(.1, .9, .3, 1) forwards; }
}
@keyframes pillar-rise {
  from { transform: scaleY(0) scaleX(.5); opacity: 0; }
  to   { transform: scaleY(1) scaleX(1); opacity: .8; }
}
@keyframes pillar-sway {
  from { transform: scaleY(1) scaleX(.85); opacity: .68; }
  to   { transform: scaleY(1) scaleX(1.1); opacity: .9; }
}
@keyframes pillar-up {
  0%   { transform: scaleY(0) scaleX(.4); opacity: 0; }
  20%  { transform: scaleY(1) scaleX(1); opacity: .85; }
  100% { transform: scaleY(1) scaleX(.3); opacity: 0; }
}

/* ===== 爆裂圖層 ===== */
.rays { width: 100%; height: 100%; mix-blend-mode: screen; }
.rays i {
  position: absolute; left: 50%; top: 50%;
  width: var(--w); height: var(--len);
  margin-left: calc(var(--w) / -2);
  background: linear-gradient(to top, var(--c), rgba(255, 255, 255, .9) 30%, transparent);
  transform-origin: 50% 0;
  transform: rotate(var(--a)) scaleY(0);
  opacity: 0;
  filter: blur(.5px);
}
.rainbow .rays i { background: linear-gradient(to top, #ffd0f0, #fff 28%, transparent); }
@media (prefers-reduced-motion: no-preference) {
  .boomy .rays i { animation: ray-shoot 520ms cubic-bezier(.1, .85, .25, 1) var(--dl) forwards; }
}
@keyframes ray-shoot {
  0%   { transform: rotate(var(--a)) scaleY(0); opacity: 0; }
  18%  { transform: rotate(var(--a)) scaleY(1); opacity: 1; }
  100% { transform: rotate(var(--a)) scaleY(1.5); opacity: 0; }
}

.shards { width: 100%; height: 100%; }
.shards i {
  position: absolute; left: 50%; top: 50%;
  width: var(--w); height: var(--h);
  margin: calc(var(--h) / -2) 0 0 calc(var(--w) / -2);
  background: linear-gradient(150deg, #fff, var(--c) 55%, transparent);
  clip-path: polygon(50% 0%, 100% 62%, 62% 100%, 8% 74%);
  opacity: 0;
}
.rainbow .shards i { background: linear-gradient(150deg, #fff, #ffd75e 40%, #b98cff 75%, transparent); }
@media (prefers-reduced-motion: no-preference) {
  .boomy .shards i { animation: shard-fly 560ms cubic-bezier(.15, .8, .3, 1) var(--dl) forwards; }
}
@keyframes shard-fly {
  0%   { transform: rotate(var(--a)) translateY(-10%) rotate(0deg); opacity: 0; }
  10%  { opacity: 1; }
  100% { transform: rotate(var(--a)) translateY(calc(var(--d) * -1)) rotate(var(--spin)); opacity: 0; }
}

.sparks { width: 100%; height: 100%; }
.sparks i {
  position: absolute; left: 50%; top: 50%;
  width: var(--s); height: var(--s);
  margin: calc(var(--s) / -2) 0 0 calc(var(--s) / -2);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 10px var(--c), 0 0 22px var(--c);
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .boomy .sparks i { animation: spark-fly var(--dur) ease-out var(--dl) forwards; }
}
@keyframes spark-fly {
  0%   { transform: rotate(var(--a)) translateY(-6%) scale(1); opacity: 0; }
  14%  { opacity: 1; }
  100% { transform: rotate(var(--a)) translateY(calc(var(--d) * -1)) scale(.2); opacity: 0; }
}

/* ---- 水滴濺射（超級球）：上拋 → 受重力落下 ---- */
.drops { width: 100%; height: 100%; }
.drops i {
  position: absolute; left: 50%; top: 50%;
  width: var(--s); height: calc(var(--s) * 1.4);
  border-radius: 50% 50% 50% 50% / 65% 65% 35% 35%;
  background: var(--c);
  box-shadow: 0 0 6px var(--c);
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .boomy .drops i { animation: drop-arc var(--dur) cubic-bezier(.3, 0, .7, 1) var(--dl) forwards; }
}
@keyframes drop-arc {
  0%   { transform: translate(0, 0) scale(.7); opacity: 0; }
  12%  { opacity: 1; }
  42%  { transform: translate(calc(var(--dx) * .6), calc(var(--up) * -1)) scale(1); }
  100% { transform: translate(var(--dx), var(--fall)) scale(.8); opacity: 0; }
}

/* ---- 金光雨（高級球收尾）：細長的金線往下墜 ---- */
.rain { width: 100%; height: 100%; }
.rain i {
  position: absolute; top: -8%;
  width: 1.5px; height: var(--len);
  background: linear-gradient(to bottom, transparent, #ffe9a8 60%, #fff);
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .m-B.act-after .rain i, .m-B.boomy .rain i {
    animation: rain-fall var(--dur) cubic-bezier(.4, 0, .8, .8) var(--dl) forwards;
  }
}
@keyframes rain-fall {
  0%   { transform: translateY(0); opacity: 0; }
  16%  { opacity: .9; }
  100% { transform: translateY(110cqh); opacity: 0; }
}

/* ---- 十字光芒 ---- */
.flare { width: 100%; height: 100%; mix-blend-mode: screen; }
.flare i {
  position: absolute; left: 50%; top: 50%;
  width: 200%; height: 4px;
  margin: -2px 0 0 -100%;
  background: linear-gradient(90deg, transparent 6%, var(--c) 34%, #fff 50%, var(--c) 66%, transparent 94%);
  filter: blur(1.5px);
  transform: rotate(var(--a)) scaleX(0);
  opacity: 0;
}
.rainbow .flare i {
  background: linear-gradient(90deg, transparent 6%, #b98cff 28%, #fff 50%, #ffd75e 72%, transparent 94%);
}
@media (prefers-reduced-motion: no-preference) {
  .boomy .flare i { animation: flare-open 480ms cubic-bezier(.1, .9, .25, 1) forwards; }
}
@keyframes flare-open {
  0%   { transform: rotate(var(--a)) scaleX(0); opacity: 0; }
  16%  { transform: rotate(var(--a)) scaleX(1); opacity: 1; }
  100% { transform: rotate(var(--a)) scaleX(1.2); opacity: 0; }
}

/* ---- 全畫面掃光 ---- */
.sweep {
  width: 220%; height: 100%;
  background: linear-gradient(102deg, transparent 42%, rgba(255, 255, 255, .8) 50%, transparent 58%);
  mix-blend-mode: screen;
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .boomy .sweep { animation: sweep 560ms ease-out forwards; }
}
@keyframes sweep {
  0%   { transform: translateX(-58%); opacity: 0; }
  22%  { opacity: 1; }
  100% { transform: translateX(32%); opacity: 0; }
}

/* ---- 爆裂衝擊 ---- */
.shock {
  width: 26%; aspect-ratio: 1;
  border-radius: 50%;
  background: radial-gradient(circle, transparent 52%, var(--c) 62%, rgba(255, 255, 255, .9) 72%, transparent 84%);
  opacity: 0;
  filter: blur(1px);
}
.rainbow .shock { background: radial-gradient(circle, transparent 52%, #ffd0f0 62%, #fff 72%, transparent 84%); }
@media (prefers-reduced-motion: no-preference) {
  .boomy .shock { animation: shock-out 440ms cubic-bezier(.05, .85, .25, 1) forwards; }
}
@keyframes shock-out {
  0%   { transform: scale(.2); opacity: 0; }
  10%  { opacity: 1; }
  100% { transform: scale(calc(2.2 + var(--sk) * 2.4)); opacity: 0; }
}

/* ---- 色差 ---- */
.chroma { width: 34%; aspect-ratio: 1; border-radius: 50%; mix-blend-mode: screen; opacity: 0; }
.cr { background: radial-gradient(circle, #ff2d55, transparent 62%); }
.cb { background: radial-gradient(circle, #2dd6ff, transparent 62%); }
@media (prefers-reduced-motion: no-preference) {
  .boomy .cr { animation: chroma-r 240ms ease-out forwards; }
  .boomy .cb { animation: chroma-b 240ms ease-out forwards; }
}
@keyframes chroma-r {
  0% { transform: translateX(0) scale(.6); opacity: 0; }
  18% { transform: translateX(-9px) scale(1); opacity: .55; }
  100% { transform: translateX(-20px) scale(1.5); opacity: 0; }
}
@keyframes chroma-b {
  0% { transform: translateX(0) scale(.6); opacity: 0; }
  18% { transform: translateX(9px) scale(1); opacity: .55; }
  100% { transform: translateX(20px) scale(1.5); opacity: 0; }
}

/* ---- 金光閃爍（固定金色：金光是獨立的獎賞訊號） ---- */
.glints { width: 100%; height: 100%; }
.glints i { position: absolute; width: 0; height: 0; opacity: 0; }
.glints i::before, .glints i::after {
  content: '';
  position: absolute; left: 0; top: 0;
  background: linear-gradient(var(--dir), transparent, #ffe9a8 34%, #fff 50%, #ffe9a8 66%, transparent);
}
.glints i::before { --dir: 90deg; width: var(--s); height: 2px; margin: -1px 0 0 calc(var(--s) / -2); }
.glints i::after  { --dir: 180deg; width: 2px; height: var(--s); margin: calc(var(--s) / -2) 0 0 -1px; }
@media (prefers-reduced-motion: no-preference) {
  .boomy .glints i { animation: glint-twinkle var(--dur) ease-out var(--dl) forwards; }
}
@keyframes glint-twinkle {
  0%   { transform: rotate(var(--r0)) scale(0); opacity: 0; }
  30%  { transform: rotate(calc(var(--r0) + 40deg)) scale(1); opacity: 1; }
  62%  { transform: rotate(calc(var(--r0) + 60deg)) scale(.72); opacity: .85; }
  100% { transform: rotate(calc(var(--r0) + 100deg)) scale(0); opacity: 0; }
}

/* ---- 整格震動 ---- */
@media (prefers-reduced-motion: no-preference) {
  .boomy.buildup { animation: hit-shake 240ms cubic-bezier(.36, .07, .19, .97); }
}
@keyframes hit-shake {
  0%, 100% { transform: translate(0, 0); }
  14% { transform: translate(calc(var(--shake) * -7px), calc(var(--shake) * 4px)); }
  32% { transform: translate(calc(var(--shake) * 6px), calc(var(--shake) * -3px)); }
  52% { transform: translate(calc(var(--shake) * -4px), calc(var(--shake) * -2px)); }
  74% { transform: translate(calc(var(--shake) * 2px), calc(var(--shake) * 2px)); }
}

/* ---- 衝擊環 ---- */
.ring { width: 26%; aspect-ratio: 1; border-radius: 50%; border: 2px solid var(--c); opacity: 0; }
.rainbow .ring { border-color: #ffd0f0; }
@media (prefers-reduced-motion: no-preference) {
  .boomy .r1 { animation: ring-out 520ms cubic-bezier(.1, .8, .3, 1) forwards; }
  .boomy .r2 { animation: ring-out 620ms cubic-bezier(.1, .8, .3, 1) 90ms forwards; }
  .boomy .r3 { animation: ring-out 760ms cubic-bezier(.1, .8, .3, 1) 190ms forwards; }
}
@keyframes ring-out {
  0%   { transform: scale(.3); opacity: .9; border-width: 3px; }
  100% { transform: scale(calc(2.4 + var(--k) * 1.6)); opacity: 0; border-width: 1px; }
}

/* ---- 整格色閃 ---- */
.tint { width: 100%; height: 100%; background: var(--c); mix-blend-mode: screen; opacity: 0; }
.rainbow .tint { background: conic-gradient(#ff5f6d, #ffd75e, #7dff9b, #5fe0ff, #b98cff, #ff5f6d); }
@media (prefers-reduced-motion: no-preference) {
  .boomy .tint { animation: tint-pop 340ms ease-out forwards; }
}
@keyframes tint-pop {
  0%   { opacity: 0; }
  10%  { opacity: calc(.16 + var(--k) * .22); }
  100% { opacity: 0; }
}

/* ---- 白閃（超新星） ---- */
.flash {
  width: 100%; height: 100%;
  background: radial-gradient(circle, #fff 0%, var(--c) 45%, transparent 75%);
  opacity: 0;
}
.rainbow .flash { background: radial-gradient(circle, #fff 0%, #ffd0f0 40%, transparent 75%); }
@media (prefers-reduced-motion: no-preference) {
  .act-nova .flash { animation: flash 560ms ease-out forwards; }
  .m-A.act-burst .flash { animation: flash 420ms 80ms ease-out forwards; }
}
@keyframes flash {
  0%   { opacity: 0; transform: scale(.5); }
  12%  { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.6); }
}

/* ---- 節拍計數 ---- */
.pips {
  align-self: end;
  display: flex; gap: 7px;
  margin-bottom: 8%;
  opacity: 0; transition: opacity .3s;
}
.run .pips { opacity: 1; }
.pips i {
  width: 7px; height: 7px; border-radius: 50%;
  background: rgba(255, 255, 255, .18);
  transition: background .25s, box-shadow .25s, transform .25s;
}
.pips i.on { background: var(--c); box-shadow: 0 0 10px var(--c); transform: scale(1.25); }
.rainbow .pips i.on { background: #ffd0f0; box-shadow: 0 0 12px #ffb0e8; }

@media (prefers-reduced-motion: reduce) {
  .orb { transform: scale(.6); }
  .run .veil { opacity: 1; }
}
</style>
