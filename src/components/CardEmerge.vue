<script setup lang="ts">
/**
 * 卡片從煙霧中浮出。
 *
 * 動的不是 Y 軸。整張卡是「陷在」煙霧深處的 —— 一開始又小又糊、被煙吃掉邊緣，
 * 然後由遠而近推上來，帶起的煙在它前面散開。所以主軸是深度（縮放 + 去霾），
 * 不是位移；上下只留一點點浮動，多了就會變成貼圖在滑。
 *
 * 遮罩用的是從中心往外開的放射漸層，不是水平線。水平線會讀成「卡片沉在水面下」，
 * 但煙不是水面 —— 煙是包住整張卡的，所以是四周先化開、中間先出來。
 *
 * 四層疊起來：
 *   1 煙霧（ShaderSky，複用形象頁的著色器）—— 卡浮出時能量拉高，煙翻騰起來
 *   2 卡背後透出的光 —— 隨卡片靠近一起放大
 *   3 卡片本體 —— 由小放大、去霾、遮罩往外開
 *   4 被帶上來的煙 —— 跟著卡片往上擴散然後消散
 *
 * 相位用 setTimeout 推進，不用 rAF：分頁被節流時 rAF 不推進，
 * 整段演出會凍在某一格，使用者切回來看到的是半截卡片。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Tier } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import ShaderSky from '@/components/ShaderSky.vue'

const props = withDefaults(defineProps<{
  artId?: string | null
  image?: string
  name?: string
  tier?: Tier
  /** 掛載後自動播 */
  auto?: boolean
}>(), { artId: null, image: '', name: '', tier: 'D', auto: true })

const emit = defineEmits<{ (e: 'done'): void }>()

/* 相位：
   still  只有煙，什麼都還沒發生
   stir   煙開始翻騰，底部透出光
   rise   卡片從煙裡升起（遮罩往下退、模糊散去）
   settle 卡片定位，煙沉澱
*/
type Phase = 'still' | 'stir' | 'rise' | 'settle'
const SCRIPT: { k: Phase; ms: number }[] = [
  { k: 'still', ms: 700 },
  { k: 'stir', ms: 1100 },
  { k: 'rise', ms: 1900 },
  { k: 'settle', ms: 900 }
]
const phase = ref<Phase>('still')
let timer: number | undefined

/** 每一相的煙霧能量：卡片衝出來的那一刻煙最亂 */
const ENERGY: Record<Phase, number> = { still: 0.18, stir: 0.55, rise: 0.95, settle: 0.4 }

const TIER_HUE: Record<Tier, string> = {
  D: '#ef4040', C: '#3f7fd8', B: '#f5c400', A: '#d8b25a', LAST: '#8b4fd0', BUST: '#ef4040'
}
const hue = computed(() => TIER_HUE[props.tier])
const tint = computed<[number, number, number]>(() => {
  const h = hue.value.replace('#', '')
  const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
  return [Math.min(1, v(0) * 1.15), Math.min(1, v(2) * 1.15), Math.min(1, v(4) * 1.15)]
})

const sky3d = ref(!new URLSearchParams(location.search).has('nogl'))
const reduce = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

function run(i = 0) {
  if (i >= SCRIPT.length) { emit('done'); return }
  phase.value = SCRIPT[i].k
  timer = window.setTimeout(() => run(i + 1), SCRIPT[i].ms)
}
function play() {
  clearTimeout(timer)
  if (reduce()) { phase.value = 'settle'; emit('done'); return }
  run(0)
}
defineExpose({ play })

onMounted(() => { if (props.auto) play() })
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="emerge" :class="`ph-${phase}`" :style="{ '--hue': hue }">
    <!-- 1 煙霧 -->
    <div class="smoke" aria-hidden="true">
      <ShaderSky
        v-if="sky3d"
        class="smokeGl"
        :energy="ENERGY[phase]"
        :tint="tint"
        :gain="1.15"
        :core-y="0.62"
        @fail="sky3d = false"
      />
      <div v-else class="smokeCss"></div>
    </div>

    <!-- 2 卡背後透出的光：跟著卡片一起由小放大，才會像「那個光源正在靠近」 -->
    <div class="coreGlow" aria-hidden="true"></div>

    <!-- 2 卡片 -->
    <div class="cardWrap">
      <div class="card3d">
        <CardArt
          class="face"
          :image="image"
          :alt="name"
          :art-id="artId"
          :tier="tier"
        />
        <span class="sheen" aria-hidden="true"></span>
      </div>
    </div>

    <!-- 4 被卡片帶上來的煙：往上擴散然後散掉 -->
    <div class="wisps" aria-hidden="true">
      <span style="--wd: 2.1s; --wx: -14%"></span>
      <span style="--wd: 2.6s; --wx: 9%"></span>
      <span style="--wd: 1.8s; --wx: -3%"></span>
    </div>

    <!-- 3 煙霧前景：蓋在卡片下緣，交界處才有東西在流動 -->
    <div class="fog" aria-hidden="true">
      <span class="f1"></span><span class="f2"></span>
    </div>
  </div>
</template>

<style scoped>
.emerge {
  --reveal: 0;
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 5;
  overflow: hidden;
  border-radius: var(--radius-lg);
  background: #07050e;
  isolation: isolate;
  display: grid; place-items: center;
  transition: --reveal 1.75s cubic-bezier(.45, .05, .55, .95);
}
@property --reveal { syntax: '<number>'; inherits: true; initial-value: 0; }

/* ---- 1 煙霧 ---- */
.smoke { position: absolute; inset: 0; z-index: 0; }
.smokeGl { position: absolute; inset: 0; }
.smokeCss {
  position: absolute; inset: 0;
  background:
    radial-gradient(70% 50% at 50% 62%, color-mix(in srgb, var(--hue) 55%, transparent), transparent 70%),
    radial-gradient(60% 40% at 30% 55%, rgba(120, 80, 200, .3), transparent 70%);
  filter: blur(24px);
}

/* ---- 2 卡背後的光 ----
   它跟卡片一起放大，所以讀起來是「那個光源正在往前靠近」，
   而不是背景多了一塊固定的亮斑。 */
.coreGlow {
  position: absolute; left: 50%; top: 50%;
  width: 62%; aspect-ratio: 1;
  translate: -50% -50%;
  z-index: 1; pointer-events: none;
  border-radius: 50%;
  background:
    radial-gradient(closest-side, #fff 0%, transparent 26%),
    radial-gradient(closest-side, var(--hue) 0%, transparent 68%);
  filter: blur(24px) saturate(1.3);
  mix-blend-mode: screen;
  opacity: 0;
  scale: .35;
  transition: opacity 1.1s ease, scale 1.9s cubic-bezier(.2, .75, .25, 1);
}
.ph-stir .coreGlow { opacity: .7; scale: .5; }
.ph-rise .coreGlow { opacity: .9; scale: 1.1; }
.ph-settle .coreGlow { opacity: .4; scale: 1.25; }

/* ---- 3 卡片 ----
   遮罩從中心往外開。煙不是水面 —— 它是包住整張卡的，
   所以是四周先化開、中間先實體化，而不是有一條界線橫過卡面。
   --reveal 0 = 完全化在煙裡，1 = 整張都實了。 */
.cardWrap {
  position: relative; z-index: 2;
  width: 58%;
  perspective: 1100px;
  -webkit-mask-image: radial-gradient(farthest-corner at 50% 48%,
    #000 calc(var(--reveal) * 128%),
    transparent calc(var(--reveal) * 128% + 30%));
  mask-image: radial-gradient(farthest-corner at 50% 48%,
    #000 calc(var(--reveal) * 128%),
    transparent calc(var(--reveal) * 128% + 30%));
}

/* 位移、縮放、旋轉分開寫在三個獨立屬性上。
   全塞進 transform 的話，任何一條規則改其中一項就會把另外兩項一起清掉。 */
.card3d {
  aspect-ratio: 5 / 7;
  border-radius: 10px;
  scale: .46;
  translate: 0 7%;
  transform: rotateX(9deg);
  /* 深處的卡不只是小，還要「隔著煙看」：低對比、掉色、糊。
     只縮小不去霾的話，看起來只是一張變小的貼圖。 */
  filter: blur(11px) brightness(.5) saturate(.5) contrast(.8);
  opacity: 0;
  transition:
    scale 1.95s cubic-bezier(.2, .75, .25, 1),
    translate 1.95s cubic-bezier(.2, .75, .25, 1),
    transform 1.8s cubic-bezier(.2, .75, .25, 1),
    filter 1.2s ease-out,
    opacity .9s ease-out;
  transform-style: preserve-3d;
}
.face {
  display: block;
  width: 100%; height: 100%;
  object-fit: cover;
  border-radius: 10px;
}

/* stir：煙深處隱約有東西，還看不出是卡 */
.ph-stir .card3d { opacity: .42; scale: .53; }
/* rise：由遠推近、霾散掉 */
.ph-rise .card3d {
  opacity: 1; scale: 1; translate: 0 0;
  transform: rotateX(0deg);
  filter: blur(0) brightness(1) saturate(1) contrast(1);
}
.ph-settle .card3d {
  opacity: 1; scale: 1; translate: 0 0;
  transform: rotateX(0deg);
  filter: blur(0) brightness(1) saturate(1) contrast(1);
  box-shadow:
    0 0 30px color-mix(in srgb, var(--hue) 60%, transparent),
    0 22px 44px rgba(0, 0, 0, .7);
}
.ph-rise, .ph-settle { --reveal: 1; }
.ph-stir { --reveal: .3; }

/* 全像反光：定位後很淡地掃一次，是卡面的反光不是掃描線 */
.sheen {
  position: absolute; inset: 0;
  border-radius: 10px;
  pointer-events: none;
  mix-blend-mode: screen;
  opacity: 0;
  background: linear-gradient(104deg,
    transparent 40%, rgba(255, 255, 255, .3) 48%,
    rgba(190, 225, 255, .38) 51%, transparent 60%);
  background-size: 300% 100%;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-settle .sheen { animation: emergeSheen 1.2s ease-out .15s; opacity: 1; }
}
@keyframes emergeSheen {
  from { background-position: 190% 0; }
  to   { background-position: -70% 0; }
}

/* ---- 4 被帶上來的煙 ----
   卡片從煙裡拔出來時會扯起一團煙，那團煙往上散掉。
   沒有這一層，卡片只是「變清楚」；有了才像是從什麼東西裡面出來的。 */
.wisps { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
.wisps span {
  position: absolute; left: 50%; top: 52%;
  width: 58%; aspect-ratio: 1;
  border-radius: 50%;
  background: radial-gradient(closest-side,
    color-mix(in srgb, var(--hue) 26%, #0e0822) 0%,
    color-mix(in srgb, var(--hue) 10%, #07040f) 46%,
    transparent 74%);
  filter: blur(17px);
  opacity: 0;
  translate: -50% -50%;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-rise .wisps span { animation: wispRise var(--wd) cubic-bezier(.3, .6, .4, 1) forwards; }
}
@keyframes wispRise {
  0%   { opacity: .85; scale: .55; translate: calc(-50% + var(--wx) * .3) -50%; }
  55%  { opacity: .5; }
  100% { opacity: 0; scale: 2.1; translate: calc(-50% + var(--wx)) -128%; }
}

/* ---- 5 煙霧前景 ----
   這一層的工作是「擋住」卡片，不是發光。
   一旦它自己夠亮，卡片就會被整片紫霧吃掉 —— 只留一點色偏，其餘壓到近黑。 */
.fog { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
.fog span {
  position: absolute; left: -24%; right: -24%;
  height: 44%;
  background: radial-gradient(58% 100% at 50% 72%,
    color-mix(in srgb, var(--hue) 16%, #0a0616) 0%,
    color-mix(in srgb, var(--hue) 7%, #06040f) 48%,
    transparent 76%);
  filter: blur(16px);
  opacity: 1;
  transition: opacity 1.2s ease;
}
.f1 { bottom: -14%; }
.f2 { bottom: -2%; opacity: .52; }
@media (prefers-reduced-motion: no-preference) {
  .f1 { animation: fogDrift 11s ease-in-out infinite alternate; }
  .f2 { animation: fogDrift 8s ease-in-out -3s infinite alternate-reverse; }
}
@keyframes fogDrift {
  from { transform: translateX(-6%) scaleY(1); }
  to   { transform: translateX(7%) scaleY(1.15); }
}
/* 卡片定位後煙沉下去，不要一直擋著卡 */
.ph-settle .f1 { opacity: .5; }
.ph-settle .f2 { opacity: .26; }
</style>
