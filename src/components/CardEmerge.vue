<script setup lang="ts">
/**
 * 卡片從煙霧中浮出。
 *
 * 「從煙裡浮上來」的關鍵不是把卡片淡入 —— 淡入只會看起來像貼圖漸漸變不透明。
 * 真正的訊號是：卡的下半部還「陷在」煙裡看不清，上半部已經出來了，
 * 而這條界線隨著卡片上升往下退。所以核心是一條會移動的遮罩，不是 opacity。
 *
 * 四層疊起來：
 *   1 煙霧（ShaderSky，複用形象頁的著色器）—— 卡浮出時能量拉高，煙翻騰起來
 *   2 卡片本體 —— 上升、去模糊、遮罩往下退
 *   3 煙霧前景 —— 蓋在卡片下緣，讓交界處有東西在流動而不是一條硬線
 *   4 浮出時的光 —— 從卡背後透出來
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

    <!-- 4 卡背後透出的光（先出現，預告有東西要上來） -->
    <div class="underglow" aria-hidden="true"></div>

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

    <!-- 2.5 煙面線：卡片破出煙面的那一條光，跟著遮罩邊界一起往下退 -->
    <div class="surface" aria-hidden="true"></div>

    <!-- 3 煙霧前景：蓋在卡片下緣，交界處才有東西在流動 -->
    <div class="fog" aria-hidden="true">
      <span class="f1"></span><span class="f2"></span><span class="f3"></span>
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
  transition: --reveal 1.55s cubic-bezier(.45, .05, .55, .95) .25s;
}

/* ---- 1 煙霧 ---- */
.smoke { position: absolute; inset: 0; z-index: 0; }
.smokeGl { position: absolute; inset: 0; }
.smokeCss {
  position: absolute; inset: 0;
  background:
    radial-gradient(70% 50% at 50% 78%, color-mix(in srgb, var(--hue) 55%, transparent), transparent 70%),
    radial-gradient(60% 40% at 30% 60%, rgba(120, 80, 200, .3), transparent 70%);
  filter: blur(24px);
}

/* ---- 4 底下透出的光 ---- */
.underglow {
  position: absolute; left: 50%; bottom: 16%;
  width: 56%; height: 17%;
  translate: -50% 0;
  z-index: 1; pointer-events: none;
  background:
    radial-gradient(ellipse at 50% 100%, #fff 0%, transparent 30%),
    radial-gradient(ellipse at 50% 100%, var(--hue), transparent 70%);
  filter: blur(20px) saturate(1.35);
  mix-blend-mode: screen;
  opacity: 0;
  transition: opacity 1s ease, transform 1.4s ease;
}
.ph-stir .underglow { opacity: .75; transform: scale(1.05); }
.ph-rise .underglow { opacity: .9; transform: scale(1.15); }
.ph-settle .underglow { opacity: .35; }

/* ---- 2 卡片 ----
   遮罩是整段演出的核心：--reveal 是「已經浮出煙面的比例」。
   0 = 完全在煙裡，1 = 整張都出來了。
   遮罩下緣留一段漸層，交界處才是糊的而不是一條切線。 */
.cardWrap {
  position: relative; z-index: 2;
  width: 58%;
  -webkit-mask-image: linear-gradient(180deg,
    #000 0,
    #000 calc(var(--reveal) * 100%),
    transparent calc(var(--reveal) * 100% + 34%));
  mask-image: linear-gradient(180deg,
    #000 0,
    #000 calc(var(--reveal) * 100%),
    transparent calc(var(--reveal) * 100% + 34%));
  /* 曲線刻意接近線性，而且比卡片上升晚 .25s 起跑。
     用一般的 ease-out（前段快）會讓界線在前 30% 就掃完，
     真正該被看到的那一格 —— 界線正橫過卡面 —— 就整個消失了。 */

}
@property --reveal { syntax: '<number>'; inherits: true; initial-value: 0; }

.card3d {
  aspect-ratio: 5 / 7;
  border-radius: 10px;
  transform: translateY(38%) scale(.92) rotateX(16deg);
  filter: blur(12px) brightness(.55) saturate(.7);
  transition:
    transform 1.9s cubic-bezier(.22, .8, .24, 1),
    filter 1.05s ease-out;
  transform-style: preserve-3d;
  perspective: 900px;
}
/* CardArt 的根就是 <img> 本身（不是包一層 div），所以尺寸直接寫在 .face 上，
   不要寫成 .face :deep(img) —— 那會找不到東西。 */
.face {
  display: block;
  width: 100%; height: 100%;
  object-fit: cover;
  border-radius: 10px;
}

/* 浮出：位移歸零、去模糊、遮罩退到底 */
.ph-rise { --reveal: 1; }
.ph-rise .card3d {
  transform: translateY(-2%) scale(1) rotateX(0deg);
  filter: blur(0) brightness(1) saturate(1);
}
.ph-settle { --reveal: 1; }
.ph-settle .card3d {
  transform: translateY(0) scale(1) rotateX(0deg);
  filter: blur(0) brightness(1) saturate(1);
  box-shadow:
    0 0 30px color-mix(in srgb, var(--hue) 60%, transparent),
    0 22px 44px rgba(0, 0, 0, .7);
}

/* 煙面線。
   它不是裝飾 —— 沒有這條線，遮罩邊界只是「卡片下面糊掉」，
   有了它才會讀成「卡片正從一個表面下方穿出來」。
   位置綁同一個 --reveal，所以線一定壓在遮罩交界上。 */
.surface {
  position: absolute; left: 50%; top: 50%;
  translate: -50% -50%;
  width: 58%; aspect-ratio: 5 / 7;
  /* 要壓在 .fog 之上。破出來的光是從交界處發出來的，
     會透過近處的煙 —— 排在煙下面就整條被煙吃掉了。 */
  z-index: 4; pointer-events: none;
  opacity: 0;
  transition: opacity .5s ease;
}
.surface::before {
  content: '';
  position: absolute; left: -12%; right: -12%;
  top: calc(var(--reveal) * 100%);
  height: 3px;
  translate: 0 -50%;
  border-radius: 50%;
  background: linear-gradient(90deg,
    transparent, #fff 22%, var(--hue) 50%, #fff 78%, transparent);
  box-shadow: 0 0 22px 5px color-mix(in srgb, var(--hue) 85%, transparent);
  filter: blur(1.5px);
  mix-blend-mode: screen;
}
.ph-stir .surface { opacity: .85; }
.ph-rise .surface { opacity: 1; }
.ph-settle .surface { opacity: 0; }

/* 全像掃光：卡片出來之後才掃，出來之前它還在煙裡看不到 */
.sheen {
  position: absolute; inset: 0;
  border-radius: 10px;
  pointer-events: none;
  mix-blend-mode: screen;
  opacity: 0;
  background: linear-gradient(104deg,
    transparent 36%, rgba(255, 255, 255, .55) 47%,
    rgba(160, 220, 255, .75) 50%, rgba(255, 175, 240, .6) 54%, transparent 64%);
  background-size: 300% 100%;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-settle .sheen { animation: emergeSheen 1.1s ease-out .1s; opacity: 1; }
}
@keyframes emergeSheen {
  from { background-position: 190% 0; }
  to   { background-position: -70% 0; }
}

/* ---- 3 煙霧前景 ----
   兩片很慢的橫向漂移擋在卡片下緣。沒有這一層的話，遮罩的邊界會是
   一條乾淨的漸層 —— 看起來像卡片被裁掉，不像陷在煙裡。 */
.fog { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
.fog span {
  position: absolute; left: -24%; right: -24%;
  height: 52%;
  /* 這一層的工作是「擋住」卡片下緣，不是發光。
     一旦它自己夠亮，卡片就會被整片紫霧吃掉 —— 只留一點色偏，其餘壓到近黑。 */
  background: radial-gradient(58% 100% at 50% 72%,
    color-mix(in srgb, var(--hue) 16%, #0a0616) 0%,
    color-mix(in srgb, var(--hue) 7%, #06040f) 48%,
    transparent 76%);
  filter: blur(16px);
  opacity: 1;
}
.f1 { bottom: -10%; }
.f2 { bottom: 4%; opacity: .7; }
/* f3 橫在卡片中段：卡片升到一半時會有一縷煙從卡面前面飄過，
   沒有這一縷，卡片看起來就只是「疊在」煙前面而不是「穿過」煙。 */
.f3 { bottom: 26%; height: 26%; opacity: .32; filter: blur(20px); }
@media (prefers-reduced-motion: no-preference) {
  .f1 { animation: fogDrift 11s ease-in-out infinite alternate; }
  .f2 { animation: fogDrift 8s ease-in-out -3s infinite alternate-reverse; }
  .f3 { animation: fogDrift 6.5s ease-in-out -2s infinite alternate; }
}
@keyframes fogDrift {
  from { transform: translateX(-6%) scaleY(1); }
  to   { transform: translateX(7%) scaleY(1.15); }
}
/* 卡片定位後煙沉下去，不要一直擋著卡 */
.fog span { transition: opacity 1.2s ease, transform 1.2s ease; }
.ph-settle .f1 { opacity: .55; }
.ph-settle .f2 { opacity: .3; }
.ph-settle .f3 { opacity: 0; }
</style>
