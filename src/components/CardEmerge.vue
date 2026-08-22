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
 *   4 衝擊層：蓄力吸入、爆發、粒子（ImpactBurst，加法疊光）
 *
 * 第 4 層是後來補的，因為整段演出原本從頭到尾都是柔和的漸變，沒有爆點。
 * 衝擊感的來源不是「更亮更多」而是**對比**：charge 那一拍先把畫面收暗、
 * 把東西吸進核心，burst 才炸得開。詳見 docs/reveal-fx-research.md。
 *
 * 相位用 setTimeout 推進，不用 rAF：分頁被節流時 rAF 不推進，
 * 整段演出會凍在某一格，使用者切回來看到的是半截卡片。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Tier } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import { artUrlById } from '@/lib/tcgdex'
import SmokePlume from '@/components/SmokePlume.vue'
import ImpactBurst from '@/components/ImpactBurst.vue'

const props = withDefaults(defineProps<{
  artId?: string | null
  image?: string
  name?: string
  tier?: Tier
  /** 掛載後自動播 */
  auto?: boolean
  /**
   * 演出速度倍率。1 = 完整十秒。
   *
   * 開卡結果頁會依實際開出的賞別調 —— 最高賞值得看完整段，
   * 每抽一張 D 賞都播十秒只會讓人想關掉。這跟 RevealBuildup
   * 「演出等級對應真的開出來的東西」是同一個原則。
   */
  pace?: number
  /**
   * 演出強度 0..1。爆發的粒子量、震幅、爆光量都乘這個數。
   *
   * 跟 pace 分開的理由：光靠加速，低賞別看到的還是同一場大爆炸只是快轉，
   * 「衝擊感」就被稀釋成常態。要衝擊感成立，它必須是**稀有的**——
   * 低賞別要真的比較小聲，不只是比較短。
   */
  intensity?: number
}>(), { artId: null, image: '', name: '', tier: 'D', auto: true, pace: 1, intensity: 1 })

const emit = defineEmits<{ (e: 'done'): void }>()

/* 相位：
   still   空的，只有一點微光
   gather  煙從四個邊往內聚攏
   swell   煙合攏成一片，翻騰、懸著
   charge  核心把煙吸進去壓實，畫面收暗、震動累積
   burst   炸開：命中停頓、爆光、衝擊波、粒子
   form    卡片從爆散的餘料裡凝聚出來
   settle  煙散掉，卡片定裝
*/
/* 七拍。
   charge / burst 是後來補的兩拍，整段從八秒拉到十秒。
   加的不是長度而是**落差**：原本 swell 之後直接接 form，卡片就這麼柔柔地
   浮出來，全程沒有一個地方讓人心跳漏一拍。
   charge 負責把基準線壓低（暗、靜、向內），burst 才有東西可以對比。
   這兩拍拆開而不是合成一拍：蓄力要慢到讀得出「它在吸」，爆發要快到來不及看清楚。

   form 那一拍裡面還分兩段：煙先堆成卡的形狀，圖案才在上面顯影。
   swell 那一拍（煙已經合攏、卡片還沒開始成形）是刻意留的空白 ——
   演出要有一個「什麼都沒發生」的懸置，後面的凝聚才有份量。 */
type Phase = 'still' | 'gather' | 'swell' | 'charge' | 'burst' | 'form' | 'settle'
const SCRIPT: { k: Phase; ms: number }[] = [
  { k: 'still', ms: 700 },
  { k: 'gather', ms: 1600 },
  { k: 'swell', ms: 1100 },
  { k: 'charge', ms: 1500 },
  { k: 'burst', ms: 900 },
  { k: 'form', ms: 2600 },
  { k: 'settle', ms: 1600 }
]
/* 各拍的起點（毫秒，未乘倍率）。衝擊層要知道「幾秒的時候該炸」，
   而它跑的是自己的 rAF 時鐘，不是這裡的 setTimeout。 */
const MARK = SCRIPT.reduce<number[]>((a, s) => (a.push(a[a.length - 1]! + s.ms), a), [0])
const CHARGE_AT = MARK[3]!            // 3400
const BURST_AT = MARK[4]!             // 4900
/* 煙霧那支 shader 的 uProg 走到 1 是在 form 結束的時候，不是整段結束。
   settle 是 DOM 那張卡接手之後的餘韻，煙在那時候已經沒事做了。
   它 shader 裡那幾個 smoothstep 的常數就是對著這個長度的比例算的 ——
   改 SCRIPT 一定要回去核對（那支檔案開頭有對照表）。 */
const SMOKE_MS = MARK[6]!             // 8400
/* 演出可以整段放慢，用來逐格調動畫：?fxslow=8。
   跟 ?nogl=1 同一套除錯開關。正式流程不會帶這個參數，倍率就是 1。 */
const SLOW = Math.min(20, Math.max(1, Number(new URLSearchParams(location.search).get('fxslow')) || 1))
/** 每一拍實際的毫秒數 = 腳本值 × 除錯倍率 ÷ 速度倍率 */
const rate = computed(() => SLOW / Math.max(0.2, props.pace))

const phase = ref<Phase>('still')
let timer: number | undefined

/** 整段演出的總長 */
const TOTAL = computed(() => MARK[MARK.length - 1]! * rate.value)
/** 煙霧那一層自己的長度（到 form 結束為止） */
const SMOKE_TOTAL = computed(() => SMOKE_MS * rate.value)

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
const burst = ref<{ restart: () => void } | null>(null)
const burstGl = ref(!new URLSearchParams(location.search).has('nogl'))
const reduce = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/* 命中停頓的那一格。DOM 這邊做的是「定格」：不做過渡、直接跳到一個
   被推開的姿勢（放大一點、過曝），撐住約 110 ms 再放開。
   CSS 的 transition 沒辦法真的暫停，所以停頓不是「凍住動畫」而是
   「插進一格不動的畫」—— 讀起來是一樣的，而且不必接管任何時間軸。
   衝擊層那邊是把餵給 shader 的秒數重映射，兩邊對的是同一個時刻。 */
const HIT_DELAY = 55
const HIT_STOP = 110
const hit = ref(false)
let hitTimer: number | undefined
let hitOff: number | undefined

function run(i = 0) {
  if (i >= SCRIPT.length) { emit('done'); return }
  phase.value = SCRIPT[i].k
  timer = window.setTimeout(() => run(i + 1), SCRIPT[i].ms * rate.value)
}
function play() {
  clearTimeout(timer)
  clearTimeout(hitTimer)
  clearTimeout(hitOff)
  hit.value = false
  plume.value?.restart()
  burst.value?.restart()
  if (reduce()) { phase.value = 'settle'; emit('done'); return }
  run(0)
  // 停頓的長度不隨 pace 縮放：40–80 ms 這個量級是人眼的門檻，
  // 按倍率縮下去就低到看不出來了。強度倒是要縮 —— 小獎不該有重擊。
  const hs = HIT_STOP * props.intensity
  if (hs > 20) {
    hitTimer = window.setTimeout(() => {
      hit.value = true
      hitOff = window.setTimeout(() => { hit.value = false }, hs)
    }, (BURST_AT + HIT_DELAY) * rate.value)
  }
}
defineExpose({ play })

onMounted(() => { if (props.auto) play() })
onBeforeUnmount(() => { clearTimeout(timer); clearTimeout(hitTimer); clearTimeout(hitOff) })
</script>

<template>
  <div
    class="emerge"
    :class="[`ph-${phase}`, { sc: shaderCard, hit }]"
    :style="{ '--hue': hue, '--rate': rate, '--int': intensity }"
  >
    <!-- 所有層都住在 .stage 裡，螢幕震動與過曝加在 .stage 上。
         **不能加在 .emerge 上** —— 結果頁靠 .emerge 自己的 transform 做置中
         （見 DrawResultPage 的說明），在上面再寫一次 transform 會把置中蓋掉，
         整個舞台會跳到左上角。 -->
    <div class="stage">
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
        :duration="SMOKE_TOTAL"
        :tint="tint"
        :image="cardUrl"
        :card-half="cardHalf"
        @fail="plumeGl = false"
        @cardready="shaderCard = true"
      />
      <div v-else class="plumeCss" aria-hidden="true"></div>

      <!-- 4 衝擊：蓄力吸入 → 爆發 → 粒子餘燼。加法疊在最上面 -->
      <ImpactBurst
        v-if="burstGl"
        ref="burst"
        class="burstLayer"
        :charge-at="CHARGE_AT * rate"
        :burst-at="BURST_AT * rate"
        :total="TOTAL"
        :intensity="intensity"
        :tint="tint"
        @fail="burstGl = false"
      />
    </div>
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
}

/* 舞台：震動與過曝的載體。
   它跟 .emerge 一樣大，子元素都不比它大，所以這裡用 grid 置中是安全的 ——
   會裁得不對稱的是「子元素比容器大 + overflow: hidden」那個組合，
   那個問題發生在外層 .emergeWrap，不在這裡。 */
.stage {
  position: absolute; inset: 0;
  display: grid; place-items: center;
  /* 震動用 translate、過曝用 scale，兩個分開的屬性。
     全塞進 transform 的話 keyframes 一跑就會把 scale 清掉。 */
  translate: 0 0;
  scale: 1;
}

/* ---- 蓄力：把基準線壓低 ----
   畫面收暗、掉彩度。爆發的「亮」是相對的，前面不暗就炸不亮。
   時間跟著 --rate 縮放，低賞別整段被壓縮時這一段也要跟著短。 */
.ph-charge .stage {
  filter: brightness(calc(1 - .34 * var(--int))) saturate(.82) contrast(1.06);
  transition: filter calc(1.4s * var(--rate)) ease-in;
}
@media (prefers-reduced-motion: no-preference) {
  /* 低頻震動漸強：還沒炸，但已經按不住了 */
  .ph-charge .stage { animation: emergeTremor calc(1.5s * var(--rate)) linear both; }
}
@keyframes emergeTremor {
  0%   { translate: 0 0; }
  20%  { translate: .4px -.3px; }
  40%  { translate: -.7px .5px; }
  60%  { translate: 1.1px .8px; }
  80%  { translate: -1.8px -1.3px; }
  100% { translate: 2.4px 1.6px; }
}

/* ---- 爆發：指數衰減的螢幕震動 ----
   關鍵在「快速收斂」。一直抖下去畫面就沒法看了，而且抖久了反而不痛 ——
   衝擊是一瞬間的事，之後要立刻讓人看得清楚卡片。
   震幅不隨 pace 縮放但隨 intensity 縮放：小獎不該把畫面搖成這樣。 */
.ph-burst .stage,
.ph-form .stage,
.ph-settle .stage {
  filter: none;
  transition: filter .5s ease-out;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-burst .stage { animation: emergeShake calc(.7s * var(--rate)) cubic-bezier(.2, .7, .3, 1) both; }
}
@keyframes emergeShake {
  0%   { translate: 0 0; }
  6%   { translate: calc(-9px * var(--int)) calc(6px * var(--int)); }
  13%  { translate: calc(7px * var(--int)) calc(-7px * var(--int)); }
  22%  { translate: calc(-6px * var(--int)) calc(-4px * var(--int)); }
  33%  { translate: calc(4px * var(--int)) calc(4px * var(--int)); }
  46%  { translate: calc(-3px * var(--int)) calc(2px * var(--int)); }
  62%  { translate: calc(2px * var(--int)) calc(-1.5px * var(--int)); }
  80%  { translate: calc(-1px * var(--int)) calc(.6px * var(--int)); }
  100% { translate: 0 0; }
}

/* ---- 命中停頓的那一格 ----
   transition: none 是重點：這一格要「跳」進去，不能是滑進去的。
   滑進去就變成一個放大效果，讀不出停頓。

   亮度只推三成半。推太多（試過 1.85）會跟 shader 的爆光疊成一整片純白 ——
   那一格就什麼形狀都看不到了，讀起來是「畫面壞掉」不是「被打中」。
   衝擊那一格仍然要看得見輪廓，過曝的是核心不是整個螢幕。 */
.hit .stage {
  transition: none;
  scale: calc(1 + .035 * var(--int));
  filter: brightness(calc(1 + .35 * var(--int))) contrast(1.22) saturate(1.2);
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
.ph-gather .coreGlow { opacity: .55; scale: .45; }
.ph-swell .coreGlow { opacity: .85; scale: .62; }
/* 蓄力：光源不是變大，是**縮成一點**。
   能量被壓進一個更小的體積裡 —— 這是「要炸了」最直接的視覺說法，
   而且它跟前面 gather→swell 一路放大的方向相反，方向反轉本身就是訊號。 */
.ph-charge .coreGlow {
  opacity: 1; scale: .26;
  transition: opacity .5s ease, scale calc(1.5s * var(--rate)) cubic-bezier(.7, 0, .85, .2);
}
.ph-burst .coreGlow {
  opacity: 1; scale: 2.2;
  transition: opacity .2s ease, scale .28s cubic-bezier(.05, .8, .3, 1);
}
.ph-form .coreGlow { opacity: 1; scale: 1.1; }
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

/* 煙裡隱約有東西，還看不出是卡 */
.ph-gather .card3d { opacity: .3; scale: .5; }
.ph-swell .card3d { opacity: .5; scale: .56; }
/* 蓄力時卡片反而被吸得更遠更小：畫面上所有東西都在往核心收 */
.ph-charge .card3d { opacity: .38; scale: .48; }
.ph-burst .card3d,
.ph-form .card3d,
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
/* 凝聚開始之後，背光交給 shader 裡的凝聚光。
   但 charge / burst 那兩拍要留著 —— 那時候 shader 還沒開始堆卡，
   核心光正是「能量被壓成一點再炸開」這件事的主角。 */
.sc.ph-form .coreGlow,
.sc.ph-settle .coreGlow { opacity: 0; }

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

/* ---- 4 衝擊層 ----
   壓在煙之上。它是「光」不是「物體」，所以是加法疊加（元件內用 screen），
   煙擋不住它 —— 爆光本來就該穿過煙。 */
.burstLayer { position: absolute; inset: 0; z-index: 4; }

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
.ph-charge .plumeCss { opacity: 1; transform: scale(.82); }
.ph-burst .plumeCss { opacity: .7; transform: scale(1.45); }
.ph-form .plumeCss { opacity: .35; transform: scale(1.3); }
.ph-settle .plumeCss { opacity: 0; transform: scale(1.5); }
</style>
