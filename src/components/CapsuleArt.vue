<script setup lang="ts">
/**
 * 寶貝球 —— 取代原本的卡盒。
 *
 * 等級沿用遊戲內的球階：精靈球 → 超級球 → 高級球 → 豪華球 → 大師球。
 * 色語言照原作走，但外形不做 1:1 描摹：每一階自己的紋樣（超級球的紅翼、
 * 高級球的金肩章、豪華球的紅金環、大師球的 M 字）都重新設計過，
 * 中央再開一個能量觀景窗當屬性動畫的載體 —— 原作沒有這個窗。
 *
 * 開艙是真的 3D 蚌殼掀蓋：上半殼繞著「赤道背面」那條軸往後翻，
 * 不是把上半平移走。軸心靠 transform-origin 的第三個值（z）推到球背。
 */
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import type { Tier } from '@/types/models'
import { useTilt } from '@/composables/useTilt'

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
   球體漸層要七段，手寫五個等級 × 兩個半球太不好維護，
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

/* ---- 開艙序列 ----
   六拍。關鍵是第二拍那 100ms 的「全靜止」：
   動 → 停 → 炸，中間沒有那個死點的話，爆開會軟掉變成單純變亮。
   蓄能的抖動振幅是「越抖越大」，衰減式的抖動讀起來像餘震而不是蓄力。
   刻意不用 requestAnimationFrame —— 分頁不可見時 rAF 不推進，
   序列會卡在半途。setTimeout 就算被節流也只是慢，狀態仍會走完。 */
type Phase = 'idle' | 'charge' | 'hold' | 'crack' | 'burst' | 'reveal'
const phase = ref<Phase>('idle')
const timers: number[] = []

/** 掀蓋角度：裂開只開一條縫，光爆之後才全開 */
const lidAngle = computed(() => {
  if (props.opened) return 118
  if (phase.value === 'crack') return 13
  if (phase.value === 'burst' || phase.value === 'reveal') return 118
  return 0
})
const isOpen = computed(() => lidAngle.value > 0)

function openCapsule() {
  if (!props.interactive || phase.value !== 'idle') return
  phase.value = 'charge'
  timers.push(window.setTimeout(() => { phase.value = 'hold' }, 420))
  timers.push(window.setTimeout(() => { phase.value = 'crack' }, 520))
  timers.push(window.setTimeout(() => { phase.value = 'burst' }, 700))
  timers.push(window.setTimeout(() => {
    phase.value = 'reveal'
    emit('opened')
  }, 1000))
}
onBeforeUnmount(() => timers.forEach(clearTimeout))

/* ---- 3D 傾斜 ---- */
const { el, rx, ry, gx, gy, active, onMove, reset } = useTilt(10)
const REST_X = 18, REST_Y = -8
const shellTransform = computed(() => {
  const x = REST_X + (props.flat ? 0 : rx.value)
  const y = REST_Y + (props.flat ? 0 : ry.value)
  // 蓄能時整顆縮 3%，爆開才有「從壓縮狀態彈出去」的對比
  const s = phase.value === 'charge' || phase.value === 'hold' ? 0.972 : 1
  return `rotateX(${x}deg) rotateY(${y}deg) scale(${s})`
})

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
   透過上半殼的觀景窗看到，所以座標都收在鏡片圓內。
   固定種子，重繪後位置一致。 */
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
      x: Math.cos(a) * rad,
      y: Math.sin(a) * rad,
      s: 0.9 + r() * 2,
      dur: `${(1.6 + r() * 2.4).toFixed(2)}s`,
      d: `-${(r() * 3).toFixed(2)}s`
    }
  })
})()

/** 開艙時射出的光束 */
const BURST_RAYS = Array.from({ length: 14 }, (_, i) => ({
  a: i * (360 / 14),
  len: 120 + ((i * 37) % 70),
  w: i % 2 ? 3 : 6
}))

/** 環帶刻紋。等角取樣 —— 圓柱上等距的刻線投影到畫面會往兩側壓縮，
    照 x 等距畫會變成一條貼上去的條碼，密度差就是圓柱感的來源。 */
const KNURL = Array.from({ length: 26 }, (_, i) => {
  const t = (i + 0.5) / 26
  return +(200 + Math.sin((t - 0.5) * Math.PI) * 193).toFixed(1)
})
</script>

<template>
  <div
    ref="stage"
    class="stage"
    :class="[`ph-${phase}`, { compact, flat, paused: !visible, tilting: !flat, active, open: isOpen }]"
    :style="{ '--glow': grade.glow, '--core': elem.core, '--mid': elem.mid, '--deep': elem.deep }"
    @pointermove="flat || onMove($event)"
    @pointerleave="flat || reset()"
  >
    <!-- 氛圍光暈。在 rig 之外，才不會跟著抖 -->
    <div
      class="aura"
      :style="{ background: `radial-gradient(circle, ${elem.mid}00 46%, ${elem.mid}4d 68%, ${elem.deep}00 100%)` }"
    ></div>

    <!-- 兩段式接地陰影：緊實的核心 + 大範圍的環境陰影。
         只給其中一段的話，物件會像浮在半空。 -->
    <div v-if="!compact" class="shadowSoft"></div>
    <div v-if="!compact" class="shadowCore"></div>

    <div class="rig">
      <div ref="el" class="ball" :style="{ transform: shellTransform }">

        <!-- ===== 下半殼（固定不動） ===== -->
        <div class="half ballBottom">
          <svg viewBox="0 0 400 200" aria-hidden="true">
            <defs>
              <!-- userSpaceOnUse：兩個半球共用同一顆球的球心與光源方向，
                   各自用 objectBoundingBox 的話上下會對不起來 -->
              <radialGradient
                :id="`${uid}-bot`" gradientUnits="userSpaceOnUse"
                cx="200" cy="0" r="204" fx="128" fy="-44"
              >
                <stop v-for="(s, i) in baseStops" :key="i" :offset="s.o" :stop-color="s.c" />
              </radialGradient>
              <linearGradient :id="`${uid}-bandB`" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" :stop-color="lighten(grade.band, .28)" />
                <stop offset="42%" :stop-color="grade.band" />
                <stop offset="100%" :stop-color="darken(grade.band, .6)" />
              </linearGradient>
              <clipPath :id="`${uid}-bowl`"><path d="M4 0 A196 196 0 0 0 396 0 Z" /></clipPath>
            </defs>

            <path d="M4 0 A196 196 0 0 0 396 0 Z" :fill="`url(#${uid}-bot)`" />

            <g :clip-path="`url(#${uid}-bowl)`">
              <!-- 下半的環境反射：不是主光，是地面／背景彈回來的那層 -->
              <ellipse cx="112" cy="58" rx="76" ry="44" fill="#fff" fill-opacity=".055"
                       transform="rotate(-18 112 58)" />
              <!-- 底部反射光：暗部收邊回亮，這一筆決定它是金屬還是塑膠 -->
              <path d="M61 139 A196 196 0 0 0 339 139" fill="none"
                    :stroke="lighten(grade.baseHi, .55)" stroke-opacity=".22"
                    stroke-width="7" stroke-linecap="round" />
              <!-- 暗側輪廓光 -->
              <path d="M334 54 A196 196 0 0 1 306 152" fill="none"
                    stroke="#cfe4ff" stroke-opacity=".2" stroke-width="2" stroke-linecap="round" />

              <!-- 環帶下半（跟著下殼不動）。垂直漸層讓它讀成圓柱而不是貼紙 -->
              <rect x="0" y="0" width="400" height="20" :fill="`url(#${uid}-bandB)`" />
              <g v-if="grade.glow > 0.4" opacity=".2">
                <path v-for="k in KNURL" :key="k" :d="`M${k} 1 v18`" :stroke="grade.trim" stroke-width="3.4" />
              </g>
              <path d="M0 20 H400" :stroke="darken(grade.band, .6)" stroke-width="2" />
              <path d="M0 23.5 H400" :stroke="grade.trim" stroke-opacity=".3" stroke-width="1.5" />

              <!-- 分模線：三筆才有厚度。
                   最上面那筆亮線是下半殼的上緣接到光，少了它兩片會像貼紙。 -->
              <path d="M0 1 H400" stroke="#fff" stroke-opacity=".4" stroke-width="2" />
              <path d="M0 3.4 H400" stroke="#000" stroke-opacity=".7" stroke-width="3" />

            </g>
          </svg>
        </div>


        <!-- 艙口。近緣就是赤道，所以可視的內部只有赤道以上那半橢圓；
             畫成整顆橢圓的話會變成球中間挖一個洞，中央按鈕會浮在洞裡。 -->
        <div class="mouth" aria-hidden="true">
          <svg viewBox="0 0 400 200">
            <defs>
              <radialGradient :id="`${uid}-chamber`" gradientUnits="userSpaceOnUse" cx="196" cy="196" r="150">
                <stop offset="0%" :stop-color="elem.core" />
                <stop offset="34%" :stop-color="elem.mid" stop-opacity=".72" />
                <stop offset="100%" :stop-color="elem.deep" stop-opacity="0" />
              </radialGradient>
            </defs>
            <!-- 暗腔 -->
            <path d="M12 200 A188 44 0 0 1 388 200 Z" fill="#05040a" />
            <!-- 內壁受光：後壁比前壁亮 -->
            <path d="M12 200 A188 44 0 0 1 388 200 Z"
                  :fill="lighten(grade.baseHi, .1)" fill-opacity=".16" />
            <ellipse cx="200" cy="196" rx="150" ry="30" :fill="`url(#${uid}-chamber)`" />
            <!-- 殼口唇緣：金屬圈 + 內側暗溝，兩筆才有厚度 -->
            <path d="M12 200 A188 44 0 0 1 388 200" fill="none"
                  :stroke="grade.trim" stroke-opacity=".7" stroke-width="3" />
            <path d="M18 200 A182 39 0 0 1 382 200" fill="none"
                  stroke="#000" stroke-opacity=".55" stroke-width="3" />
          </svg>
        </div>

        <!-- ===== 上半殼：繞赤道背面往後翻的蚌殼蓋 ===== -->
        <div class="lidGroup" :style="{ transform: `rotateX(${lidAngle}deg)` }">
          <!-- 內襯。翻過 90° 後外殼背對觀眾，沒有這面蓋子會整片消失 -->
          <div class="half ballTopInner">
            <svg viewBox="0 0 400 200" aria-hidden="true">
              <defs>
                <!-- 凹面：碗底最暗、往唇緣提亮。反過來畫會讀成一片凸出的圓盤 -->
                <radialGradient :id="`${uid}-in`" gradientUnits="userSpaceOnUse" cx="200" cy="62" r="212">
                  <stop offset="0%" stop-color="#000" />
                  <stop offset="58%" :stop-color="darken(grade.band, .35)" />
                  <stop offset="100%" :stop-color="lighten(grade.band, .22)" />
                </radialGradient>
              </defs>
              <path d="M4 200 A196 196 0 0 1 396 200 Z" :fill="`url(#${uid}-in)`" />
              <!-- 觀景窗的背面：內側看得到鏡片的暗圓 -->
              <circle cx="200" cy="104" r="40" :fill="darken(grade.band, .4)" />
              <circle cx="200" cy="104" r="40" fill="none" :stroke="elem.deep" stroke-opacity=".5" stroke-width="3" />
              <ellipse cx="200" cy="176" rx="150" ry="34" :fill="elem.deep" fill-opacity=".18" />
              <!-- 唇緣：翻開後這一圈金屬是蓋子唯一的形狀線索 -->
              <path d="M4 200 A196 196 0 0 1 396 200 Z" fill="none"
                    :stroke="grade.trim" stroke-opacity=".8" stroke-width="5" />
              <path d="M14 200 A186 186 0 0 1 386 200" fill="none"
                    stroke="#000" stroke-opacity=".5" stroke-width="3" />
            </svg>
          </div>

          <div class="half ballTop">
            <svg viewBox="0 0 400 200" role="img"
                 :aria-label="label ? `${label} 寶貝球` : '寶貝球'">
              <defs>
                <radialGradient
                  :id="`${uid}-top`" gradientUnits="userSpaceOnUse"
                  cx="200" cy="200" r="204" fx="130" fy="114"
                >
                  <stop v-for="(s, i) in domeStops" :key="i" :offset="s.o" :stop-color="s.c" />
                </radialGradient>
                <radialGradient :id="`${uid}-core`">
                  <stop offset="0%" :stop-color="elem.core" />
                  <stop offset="30%" :stop-color="elem.mid" stop-opacity=".9" />
                  <stop offset="72%" :stop-color="elem.deep" stop-opacity=".55" />
                  <stop offset="100%" :stop-color="elem.deep" stop-opacity=".12" />
                </radialGradient>
                <linearGradient :id="`${uid}-bandT`" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" :stop-color="darken(grade.band, .55)" />
                  <stop offset="62%" :stop-color="grade.band" />
                  <stop offset="100%" :stop-color="lighten(grade.band, .3)" />
                </linearGradient>
                <clipPath :id="`${uid}-lens`"><circle cx="200" cy="96" r="38" /></clipPath>
                <clipPath :id="`${uid}-dome`"><path d="M4 200 A196 196 0 0 1 396 200 Z" /></clipPath>
              </defs>

              <path d="M4 200 A196 196 0 0 1 396 200 Z" :fill="`url(#${uid}-top)`" />

              <g :clip-path="`url(#${uid}-dome)`">
                <!-- 大範圍環境反射：很淡，負責交代「這是一顆會反射四周的球」 -->
                <ellipse cx="152" cy="96" rx="96" ry="66" fill="#fff" fill-opacity=".07"
                         transform="rotate(-24 152 96)" />

                <!-- 球階紋樣。每一階自己的識別，刻意避開左上高光帶，
                     讓那片留白去撐球體感 —— 紋樣鋪滿反而會把形狀讀平。 -->
                <g fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <!-- 超級球：兩道紅翼從環帶掃上肩線 -->
                  <template v-if="grade.ornament === 'great'">
                    <path
                      v-for="(o, i) in [-1, 1]" :key="i"
                      :d="`M${200 + o * 158} 176 Q${200 + o * 116} 106 ${200 + o * 52} 74`"
                      :stroke="grade.mark" stroke-width="17"
                    />
                    <path
                      v-for="(o, i) in [-1, 1]" :key="`h${i}`"
                      :d="`M${200 + o * 158} 176 Q${200 + o * 116} 106 ${200 + o * 52} 74`"
                      stroke="#fff" stroke-opacity=".22" stroke-width="5"
                    />
                  </template>

                  <!-- 高級球：金色肩章，直角折線 -->
                  <template v-else-if="grade.ornament === 'ultra'">
                    <path
                      v-for="(o, i) in [-1, 1]" :key="i"
                      :d="`M${200 + o * 148} 178 L${200 + o * 148} 116 L${200 + o * 82} 78`"
                      :stroke="grade.mark" stroke-width="18"
                    />
                    <path
                      v-for="(o, i) in [-1, 1]" :key="`d${i}`"
                      :d="`M${200 + o * 148} 178 L${200 + o * 148} 116 L${200 + o * 82} 78`"
                      stroke="#000" stroke-opacity=".28" stroke-width="4"
                    />
                  </template>

                  <!-- 豪華球：紅環夾兩道金線，肩上再加一組短飾 -->
                  <template v-else-if="grade.ornament === 'luxury'">
                    <path d="M0 154 H400" :stroke="grade.mark" stroke-width="11" />
                    <path d="M0 146 H400" :stroke="grade.trim" stroke-opacity=".85" stroke-width="2.5" />
                    <path d="M0 162 H400" :stroke="grade.trim" stroke-opacity=".7" stroke-width="2" />
                    <path
                      v-for="(o, i) in [-1, 1]" :key="i"
                      :d="`M${200 + o * 66} 128 Q${200 + o * 112} 96 ${200 + o * 128} 46`"
                      :stroke="grade.trim" stroke-opacity=".8" stroke-width="3"
                    />
                    <circle v-for="(o, i) in [-1, 1]" :key="`g${i}`"
                            :cx="200 + o * 128" cy="46" r="5" :fill="grade.trim" fill-opacity=".9" stroke="none" />
                  </template>

                  <!-- 大師球：M 字。中央那個折點正好落在觀景窗上，
                       窗本身就是 M 的中峰，不必再畫一次尖角。 -->
                  <template v-else-if="grade.ornament === 'master'">
                    <path d="M118 180 L118 122 L200 176 L282 122 L282 180"
                          :stroke="grade.mark" stroke-width="17" />
                    <path d="M118 180 L118 122 L200 176 L282 122 L282 180"
                          stroke="#fff" stroke-opacity=".2" stroke-width="5" />
                    <circle v-for="(o, i) in [-1, 1]" :key="i"
                            :cx="200 + o * 138" cy="104" r="14" fill="#f4f2f8" stroke="none" />
                    <circle v-for="(o, i) in [-1, 1]" :key="`r${i}`"
                            :cx="200 + o * 138" cy="104" r="14" fill="none"
                            stroke="#000" stroke-opacity=".25" stroke-width="2" />
                    <circle v-for="(o, i) in [-1, 1]" :key="`h${i}`"
                            :cx="200 + o * 138 - 4" cy="99" r="5" fill="#fff" stroke="none" />
                  </template>
                </g>

                <!-- 觀景窗：艙內能量透出來。
                     開口比例壓到直徑的 19%（工程壓力窗的量級），
                     省下來的面積全給窗框厚度 —— 大窗讀成玩具，小窗厚框讀成器械。 -->
                <circle cx="200" cy="96" r="46" :fill="darken(grade.shellLo, .45)" />
                <circle cx="200" cy="96" r="43" fill="none" :stroke="grade.trim" stroke-opacity=".75" stroke-width="2.5" />
                <circle cx="200" cy="96" r="40" fill="none" stroke="#000" stroke-opacity=".65" stroke-width="3" />
                <circle cx="200" cy="96" r="38" fill="#05040a" fill-opacity=".94" />
                <g :clip-path="`url(#${uid}-lens)`">
                  <circle cx="200" cy="96" r="38" :fill="`url(#${uid}-core)`" />
                  <circle
                    v-for="(m, i) in MOTES" :key="i"
                    class="mote" :cx="200 + m.x" :cy="96 + m.y * 0.85" :r="m.s"
                    :fill="elem.core"
                    :style="{ animationDuration: m.dur, animationDelay: m.d }"
                  />
                  <!-- 玻璃面的斜切反光 -->
                  <path d="M162 118 L214 58 L232 58 L180 118 Z" fill="#fff" fill-opacity=".14" />
                </g>

                <!-- 環帶上半（跟著蓋子一起翻） -->
                <rect x="0" y="180" width="400" height="20" :fill="`url(#${uid}-bandT)`" />
                <g v-if="grade.glow > 0.4" opacity=".2">
                  <path v-for="k in KNURL" :key="k" :d="`M${k} 181 v19`" :stroke="grade.trim" stroke-width="3.4" />
                </g>
                <path d="M0 180 H400" :stroke="lighten(grade.band, .4)" stroke-width="2" />
                <path d="M0 176.5 H400" :stroke="grade.trim" stroke-opacity=".35" stroke-width="1.5" />

                <!-- 主高光：小、緊、硬邊。
                     一顆大糊光斑 = 玩具；小亮點 + 大淡反射 = 拋光硬料。 -->
                <ellipse cx="126" cy="66" rx="21" ry="13" fill="#fff" fill-opacity=".62"
                         transform="rotate(-30 126 66)" />
                <ellipse cx="146" cy="46" rx="7" ry="4.5" fill="#fff" fill-opacity=".26"
                         transform="rotate(-30 146 46)" />

                <!-- 暗側輪廓光 -->
                <path d="M298 30 A196 196 0 0 1 394 186" fill="none"
                      stroke="#cfe4ff" stroke-opacity=".32" stroke-width="3" stroke-linecap="round" />
              </g>
            </svg>
          </div>
        </div>

        <!-- 縫隙漏光：裂開那一拍先漏光，過 180ms 才真的爆開 -->
        <div class="leak" :style="{ background: `linear-gradient(90deg, transparent, ${elem.core}, transparent)` }"></div>

        <!-- 彈出的卡片。畫在環帶之後才不會被擋住 -->
        <div v-if="cardImage && !compact" class="ejected">
          <img :src="cardImage" alt="" />
        </div>

        <!-- 光爆 -->
        <div class="burst">
          <svg viewBox="0 0 400 400" aria-hidden="true">
            <g :fill="elem.core">
              <path
                v-for="(r, i) in BURST_RAYS" :key="i"
                :transform="`translate(200 200) rotate(${r.a})`"
                :d="`M${-r.w} 0 L${r.w} 0 L2 ${-r.len} L-2 ${-r.len} Z`"
              />
            </g>
            <circle class="burstCore" cx="200" cy="200" r="72" :fill="elem.core" />
          </svg>
        </div>

        <!-- 按鈕：三層框（暗溝 → 金屬圈 → 鏡片） -->
        <component
          :is="interactive ? 'button' : 'div'"
          class="btn" :class="{ live: interactive && phase === 'idle' }"
          :type="interactive ? 'button' : undefined"
          :disabled="interactive ? phase !== 'idle' : undefined"
          :aria-label="interactive ? '開啟寶貝球' : undefined"
          @click="openCapsule"
        >
          <span class="btnRim" :style="{ borderColor: grade.trim }"></span>
          <span
            class="btnGlow"
            :style="{ background: elem.core, boxShadow: `0 0 2.2cqw ${elem.mid}, 0 0 .8cqw ${elem.core}` }"
          ></span>
        </component>

        <span
          v-if="!flat" class="gloss" aria-hidden="true"
          :style="{ background: `radial-gradient(34% 28% at ${gx}% ${gy}%, rgba(255,255,255,.28), transparent 70%)` }"
        ></span>
      </div>
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
  aspect-ratio: 1 / 1.18;
  /* 球半徑。鉸鏈的 z 位移要靠它把軸心推到球背 */
  --pk-r: 33cqw;
}
.rig {
  position: absolute; inset: 0;
  perspective: 210cqw;
  perspective-origin: 50% 44%;
}
.ball {
  position: absolute;
  left: 17cqw; top: 20cqw;
  width: 66cqw; height: 66cqw;
  transform-style: preserve-3d;
  transition: transform .5s cubic-bezier(.2, .7, .3, 1);
}
.tilting.active .ball { transition: transform .08s linear; }

.aura {
  position: absolute; left: 7cqw; top: 10cqw;
  width: 86cqw; height: 86cqw;
  pointer-events: none;
}
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
  border-radius: 50%;
  background: #000;
}
.shadowCore { top: 84cqw; width: 26cqw; height: 5cqw; opacity: .5; filter: blur(2cqw); }
.shadowSoft { top: 80cqw; width: 64cqw; height: 10cqw; opacity: .3; filter: blur(5cqw); }

.half { position: absolute; left: 0; width: 100%; height: 50%; }
.half svg { display: block; width: 100%; height: 100%; }
.ballBottom { top: 50%; }

/* ---- 上半殼：背面鉸鏈的蚌殼開法 ----
   寶貝球不是把上半平移走，是繞著赤道「背面」那條軸往後翻。
   transform-origin 的第三個值是 z —— 把軸心推到球背（-球徑）。
   少了它會變成繞正面翻，看起來像整片飄走。 */
.lidGroup {
  position: absolute;
  left: 0; top: 0;
  width: 100%; height: 50%;
  transform-style: preserve-3d;
  transform-origin: 50% 100% calc(-1 * var(--pk-r));
  transition: transform .62s cubic-bezier(.34, 1.2, .5, 1);
}
/* .lidGroup 已經是半顆球高，裡面的殼面要吃滿它，不能再折半 */
.lidGroup > .half { height: 100%; }
.ballTop { top: 0; backface-visibility: hidden; }
.ballTopInner {
  top: 0;
  transform: rotateY(180deg);
  backface-visibility: hidden;
}

/* 艙口只在開啟後出現。放在下半殼之後、蓋子之前：
   蓋子翻開後 z 是負的，會自己排到後面去，不必靠繪製順序。 */
.mouth {
  position: absolute;
  left: 0; top: 0;
  width: 100%; height: 50%;
  opacity: 0;
  pointer-events: none;
  transition: opacity .25s ease .12s;
}
.mouth svg { display: block; width: 100%; height: 100%; }
.open .mouth { opacity: 1; }

/* ---- 縫隙漏光 ---- */
.leak {
  position: absolute;
  left: 4%; top: calc(50% - .8cqw);
  width: 92%; height: 1.6cqw;
  opacity: 0;
  filter: blur(1cqw);
  pointer-events: none;
}
.ph-crack .leak { opacity: 1; transition: opacity .12s ease; }
.ph-burst .leak, .ph-reveal .leak { opacity: 0; transition: opacity .25s ease; }

/* ---- 按鈕 ---- */
.btn {
  position: absolute;
  left: 50%; top: 50%;
  width: 15cqw; height: 15cqw;
  transform: translate(-50%, -50%);
  border: none; padding: 0;
  border-radius: 50%;
  background: radial-gradient(circle at 38% 30%, #2a2c33, #08070c 70%);
  box-shadow:
    0 0 0 .5cqw rgba(0, 0, 0, .75),
    inset 0 .35cqw .7cqw rgba(0, 0, 0, .6),
    inset 0 -.2cqw .4cqw rgba(255, 255, 255, .14);
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
  width: 56%; height: 56%; border-radius: 50%;
  opacity: calc(var(--glow) * .8);
  transition: opacity .3s, transform .3s;
}
.btn.live:hover .btnGlow { opacity: 1; transform: scale(1.1); }
.btn.live:focus-visible { outline: 2px solid #fff; outline-offset: 4px; }
.ph-charge .btnGlow, .ph-hold .btnGlow { opacity: 1; transform: scale(1.3); }
@media (prefers-reduced-motion: no-preference) {
  .btn.live .btnGlow { animation: btn-idle 2.6s ease-in-out infinite; }
  /* 蓄能：振幅遞增。衰減式的抖動讀起來是餘震，遞增才是蓄力 */
  .ph-charge .rig { animation: wind-up .42s linear; }
  .ph-burst .rig { animation: kick .22s cubic-bezier(.2, .8, .3, 1); }
}
@keyframes btn-idle {
  0%, 100% { opacity: calc(var(--glow) * .5); }
  50%      { opacity: calc(var(--glow) * 1); }
}
@keyframes wind-up {
  0%   { transform: translate(0, 0) rotate(0); }
  22%  { transform: translate(-.35cqw, .1cqw) rotate(-.25deg); }
  44%  { transform: translate(.6cqw, -.15cqw) rotate(.4deg); }
  66%  { transform: translate(-1cqw, .2cqw) rotate(-.7deg); }
  86%  { transform: translate(1.5cqw, -.3cqw) rotate(1deg); }
  100% { transform: translate(0, 0) rotate(0); }
}
@keyframes kick {
  0%   { transform: scale(1); }
  35%  { transform: scale(1.045); }
  100% { transform: scale(1); }
}

/* ---- 光爆 ---- */
.burst {
  position: absolute; inset: -22%;
  pointer-events: none; opacity: 0;
}
.burst svg { width: 100%; height: 100%; }
.ph-burst .burst, .ph-reveal .burst { animation: rays .95s cubic-bezier(.15, .8, .3, 1) forwards; }
@keyframes rays {
  0%   { opacity: 0; transform: scale(.18) rotate(0deg); }
  12%  { opacity: .95; }
  100% { opacity: 0; transform: scale(1.5) rotate(14deg); }
}
/* 白光要「一拍就到頂」。峰值拖到 100ms 以上就會讀成發光而不是撞擊 */
.burstCore { transform-box: fill-box; transform-origin: 50% 50%; }
.ph-burst .burstCore, .ph-reveal .burstCore { animation: flash .8s ease-out forwards; }
@keyframes flash {
  0%   { opacity: 0; transform: scale(.2); }
  8%   { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(2.4); }
}

/* ---- 彈卡 ---- */
.ejected {
  position: absolute;
  left: 50%; top: 0%;
  width: 50%;
  transform: translate(-50%, 60%) scale(.55);
  opacity: 0;
  pointer-events: none;
  filter: drop-shadow(0 2cqw 2cqw rgba(0, 0, 0, .6));
}
.ejected img { display: block; width: 100%; border-radius: 5%; }
/* 靜態 opened（外部控制、沒跑過動畫）也要看得到卡 */
.open .ejected { opacity: 1; transform: translate(-50%, 0) scale(1); }
.ph-reveal .ejected { animation: eject .95s cubic-bezier(.2, 1.3, .4, 1) forwards; }
@keyframes eject {
  0%   { opacity: 0; transform: translate(-50%, 92%) scale(.5); }
  22%  { opacity: 1; }
  72%  { transform: translate(-50%, -10%) scale(1.06); }
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
  .ball, .lidGroup { transition: none; }
  .gloss { display: none; }
}
</style>
