<script setup lang="ts">
/**
 * 卡片從煙霧中浮出。
 *
 * 參考的是「smoke logo reveal」那一類的片頭：一團煙衝進畫面、翻捲，
 * 然後散開露出後面的東西。所以揭曉靠的是**煙散掉**，不是卡片變亮 ——
 * 煙畫在卡片「前面」（SmokePlume，輸出帶 alpha），不是背景。
 * 這是煙霧揭曉跟一般淡入的根本差別。
 *
 * 卡片自己的動作不是 Y 軸，是深度：從遠處又小又糊被煙包著，
 * 由遠推近、霾散掉。上下只留一點浮動，多了就變成貼圖在滑。
 *
 * 層次由後往前：
 *   1 背光：卡背後的光源，跟卡片一起放大 = 光源正在靠近
 *   2 卡片本體：由小放大、去霾
 *   3 煙霧羽流：蓋在卡片前面，湧入 → 翻捲 → 散開
 *
 * 相位用 setTimeout 推進，不用 rAF：分頁被節流時 rAF 不推進，
 * 整段演出會凍在某一格，使用者切回來看到的是半截卡片。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Tier } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import { artUrlById } from '@/lib/tcgdex'
import SmokePlume from '@/components/SmokePlume.vue'

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
/* 演出可以整段放慢，用來逐格調動畫：?fxslow=8。
   跟 ?nogl=1 同一套除錯開關。正式流程不會帶這個參數，倍率就是 1。 */
const SLOW = Math.min(20, Math.max(1, Number(new URLSearchParams(location.search).get('fxslow')) || 1))

const phase = ref<Phase>('still')
let timer: number | undefined

/** 整段演出的總長 —— 煙的湧入與消散攤在這段時間上 */
const TOTAL = SCRIPT.reduce((a, b) => a + b.ms, 0) * SLOW

const TIER_HUE: Record<Tier, string> = {
  D: '#ef4040', C: '#3f7fd8', B: '#f5c400', A: '#d8b25a', LAST: '#8b4fd0', BUST: '#ef4040'
}
const hue = computed(() => TIER_HUE[props.tier])
const tint = computed<[number, number, number]>(() => {
  const h = hue.value.replace('#', '')
  const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
  return [Math.min(1, v(0) * 1.15), Math.min(1, v(2) * 1.15), Math.min(1, v(4) * 1.15)]
})

const plumeGl = ref(!new URLSearchParams(location.search).has('nogl'))

/* 要交給 shader 當貼圖的卡圖。拿不到就退回 DOM 那張卡自己做推近。 */
const cardUrl = computed(() => {
  if (props.image && !props.image.startsWith('placeholder:')) return props.image
  return props.artId ? artUrlById(props.artId) : null
})

/* 卡片矩形換算到 shader 座標（以畫布高為 1）。
   舞台 4:5、卡片佔寬 58%、卡面 5:7 —— 這三個數字一改這裡就要跟著改，
   對不上的話 shader 聚出來的卡跟 DOM 那張會錯位。 */
const STAGE_AR = 4 / 5
const CARD_W = 0.58
const cardHalf = computed<[number, number]>(() => {
  const hx = (CARD_W * STAGE_AR) / 2
  return [hx, hx * (7 / 5)]
})

/** shader 已經拿到卡圖：卡片改由煙聚出來，DOM 那張等 settle 才接手 */
const shaderCard = ref(false)
const plume = ref<{ restart: () => void } | null>(null)
const reduce = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

function run(i = 0) {
  if (i >= SCRIPT.length) { emit('done'); return }
  phase.value = SCRIPT[i].k
  timer = window.setTimeout(() => run(i + 1), SCRIPT[i].ms * SLOW)
}
function play() {
  clearTimeout(timer)
  plume.value?.restart()
  if (reduce()) { phase.value = 'settle'; emit('done'); return }
  run(0)
}
defineExpose({ play })

onMounted(() => { if (props.auto) play() })
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div
    class="emerge"
    :class="[`ph-${phase}`, { sc: shaderCard }]"
    :style="{ '--hue': hue }"
  >
    <!-- 1 卡背後的光：跟著卡片一起由小放大，才會像「那個光源正在靠近」 -->
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

    <!-- 3 煙霧：聚攏成一片，再收攏成卡片本身 -->
    <SmokePlume
      v-if="plumeGl"
      ref="plume"
      class="plumeLayer"
      :duration="TOTAL"
      :tint="tint"
      :image="cardUrl"
      :card-half="cardHalf"
      @fail="plumeGl = false"
      @cardready="shaderCard = true"
    />
    <div v-else class="plumeCss" aria-hidden="true"></div>
  </div>
</template>

<style scoped>
.emerge {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 5;
  overflow: hidden;
  border-radius: var(--radius-lg);
  background: #05040b;
  isolation: isolate;
  display: grid; place-items: center;
}

/* ---- 1 卡背後的光 ----
   它跟卡片一起放大，所以讀起來是「那個光源正在往前靠近」，
   而不是背景多了一塊固定的亮斑。煙是背光的，光源就是這個。 */
.coreGlow {
  position: absolute; left: 50%; top: 50%;
  width: 66%; aspect-ratio: 1;
  translate: -50% -50%;
  z-index: 1; pointer-events: none;
  border-radius: 50%;
  background:
    radial-gradient(closest-side, #fff 0%, transparent 24%),
    radial-gradient(closest-side, var(--hue) 0%, transparent 70%);
  filter: blur(26px) saturate(1.3);
  mix-blend-mode: screen;
  opacity: 0;
  scale: .35;
  transition: opacity 1.1s ease, scale 1.9s cubic-bezier(.2, .75, .25, 1);
}
.ph-stir .coreGlow { opacity: .8; scale: .5; }
.ph-rise .coreGlow { opacity: 1; scale: 1.1; }
.ph-settle .coreGlow { opacity: .45; scale: 1.25; }

/* ---- 2 卡片 ----
   位移、縮放、旋轉分開寫在三個獨立屬性上。
   全塞進 transform 的話，任何一條規則改其中一項就會把另外兩項一起清掉。

   這裡不再需要遮罩：遮住卡片的是前面那層真的煙，不是 CSS 假裝的邊界。 */
.cardWrap {
  position: relative; z-index: 2;
  width: 58%;
  perspective: 1100px;
}
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
    /* 去霾比推近快：卡片還在往前的時候就要讀得出是一張卡，
       不然中段那一秒畫面上什麼都沒有 */
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
.ph-stir .card3d { opacity: .5; scale: .53; }
.ph-rise .card3d,
.ph-settle .card3d {
  opacity: 1; scale: 1; translate: 0 0;
  transform: rotateX(0deg);
  filter: blur(0) brightness(1) saturate(1) contrast(1);
}
.ph-settle .card3d {
  box-shadow:
    0 0 30px color-mix(in srgb, var(--hue) 60%, transparent),
    0 22px 44px rgba(0, 0, 0, .7);
}

/* ---- shader 聚出卡片時的接手 ----
   卡片由 shader 用煙聚出來，DOM 這張只負責最後的定裝：
   它有 shader 給不了的東西（正確的色彩管理、陰影、掃光、可被選取的 <img>）。

   接手點放在 settle：shader 那邊的凝聚在 uProg 0.80 完成，settle 正好從
   0.804 開始。兩張卡的矩形是同一組數字算出來的，所以交接時是同一個位置。
   畫布晚一點才淡出，讓殘煙有時間飄完，不要在交接那一刻整片消失。 */
.sc .card3d {
  opacity: 0;
  scale: 1;
  translate: 0 0;
  transform: none;
  filter: none;
  transition: opacity .5s ease;
}
.sc.ph-settle .card3d { opacity: 1; }
.sc .plumeLayer { transition: opacity .7s ease .3s; }
.sc.ph-settle .plumeLayer { opacity: 0; }
/* 背光交給 shader 裡的凝聚光。這條排在 .ph-* 那幾條後面，
   同分but後到，不需要 !important */
.sc .coreGlow { opacity: 0; }

/* 全像反光：定位後很淡地掃一次。這是卡面的反光，不是掃描線 */
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

/* ---- 3 煙霧羽流 ----
   壓在卡片之上。它不是背景，是「擋在前面然後散掉的東西」。 */
.plumeLayer { position: absolute; inset: 0; z-index: 3; }

/* 拿不到 WebGL2 時的替代：兩片會漂的暗霧 + 一次退場。
   做不到翻捲，但至少「有東西擋著然後讓開」這件事還在。 */
.plumeCss {
  position: absolute; inset: 0; z-index: 3; pointer-events: none;
  background:
    radial-gradient(70% 55% at 50% 78%, color-mix(in srgb, var(--hue) 40%, #0a0616), transparent 72%),
    radial-gradient(60% 45% at 35% 55%, #0b0718, transparent 70%),
    radial-gradient(60% 45% at 68% 62%, #0d081f, transparent 70%);
  filter: blur(18px);
  opacity: 1;
  transition: opacity 1.6s ease, transform 2.2s ease;
}
.ph-rise .plumeCss { opacity: .35; transform: scale(1.3); }
.ph-settle .plumeCss { opacity: 0; transform: scale(1.5); }
</style>
