<script setup lang="ts">
/**
 * 開卡前的蓄勢演出（球體演出）。
 *
 * 日系オリパ那套「確定演出」的核心不是特效多花俏，是**用動畫本身當稀有度暗號**：
 * 一顆發光球體在畫面中央反覆碎裂重組，碎的次數與最後停在什麼顏色，
 * 就告訴你接下來要開出什麼等級。藍 → 青 → 金 → 橙 → 虹。
 *
 * ---- 一個刻意的設計決定：這裡的升級是誠實的 ----
 * 業界常見的做法是「假性升級」：先閃出大獎的顏色再降回去，製造擦身而過的錯覺。
 * 那是賭博心理學裡研究最透徹的暗黑模式（near-miss effect），而 VaultDraw 整個
 * 賣點是可驗證公平 —— 在開獎結果早就封存在承諾雜湊裡的前提下，用假訊號騙一次
 * 心跳，跟這個賣點是直接衝突的。所以這裡的顏色階梯**一定**走到該 tier 的真實
 * 終點，不會先高後低。要改成假性升級的話那是產品決策，不是調參數。
 *
 * ---- 為什麼是 CSS + setTimeout 而不是 canvas + rAF ----
 * rAF 在分頁不可見或被節流時不推進，序列會卡在半途 —— 開卡演出卡住等於
 * 使用者以為自己的抽選壞了。CapsuleArt 的六拍當初就是為此避開 rAF，這裡一致。
 * 碎片與火花都是 CSS keyframes，被節流也只是慢，狀態仍然會走完。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { Tier } from '@/types/models'

const props = withDefaults(defineProps<{
  tier?: Tier
  /** 掛載後自動開始 */
  auto?: boolean
}>(), { tier: 'D', auto: false })

const emit = defineEmits<{ (e: 'done'): void }>()

/* ---- 顏色階梯 ----
   每一階是一次「碎裂 → 重組」。階數與終點顏色一起編碼稀有度：
   低階球只碎一次就停在藍白，最後賞要碎五次一路燒到彩虹。 */
const BLUE = '#8fb6ff'
const CYAN = '#5fe0ff'
const GOLD = '#ffd75e'
const FLAME = '#ff8a3d'
/** 彩虹不是單色，交給 CSS 的 conic-gradient 處理 */
const RAINBOW = 'rainbow'

const TIER_LADDER: Record<Tier, string[]> = {
  D: [BLUE],
  C: [BLUE, CYAN],
  B: [BLUE, CYAN, GOLD],
  A: [BLUE, CYAN, GOLD, FLAME],
  LAST: [BLUE, CYAN, GOLD, FLAME, RAINBOW],
  BUST: [BLUE]
}
const ladder = computed(() => TIER_LADDER[props.tier])

/* ---- 節奏 ----
   蓄力 340ms → 碎裂 280ms，一輪 620ms。最後一輪碎完再 420ms 的白閃收尾。
   最低階約 1.0 秒，最後賞約 3.5 秒 —— 長度本身就是獎賞的一部分。 */
const CHARGE = 340
const BURST = 280
const FINALE = 420

type Phase = 'idle' | 'charge' | 'burst' | 'finale' | 'done'
const phase = ref<Phase>('idle')
/** 目前在第幾輪（0-based），決定顏色 */
const round = ref(0)
const timers: number[] = []

const colour = computed(() => ladder.value[Math.min(round.value, ladder.value.length - 1)])
const isRainbow = computed(() => colour.value === RAINBOW)
/** 越後面的輪次球越大、火花越多 */
const intensity = computed(() => (round.value + 1) / ladder.value.length)
const isLastRound = computed(() => round.value >= ladder.value.length - 1)

function clear() {
  timers.forEach(clearTimeout)
  timers.length = 0
}

function runRound() {
  phase.value = 'charge'
  timers.push(window.setTimeout(() => {
    phase.value = 'burst'
    timers.push(window.setTimeout(() => {
      if (isLastRound.value) {
        phase.value = 'finale'
        timers.push(window.setTimeout(() => {
          phase.value = 'done'
          emit('done')
        }, FINALE))
      } else {
        round.value += 1
        runRound()
      }
    }, BURST))
  }, CHARGE))
}

function start() {
  if (phase.value !== 'idle' && phase.value !== 'done') return
  clear()
  round.value = 0
  runRound()
}
function reset() {
  clear()
  round.value = 0
  phase.value = 'idle'
}
onBeforeUnmount(clear)
defineExpose({ start, reset })
if (props.auto) start()

/* ---- 碎片與火花 ----
   固定種子，重繪後位置一致 —— 同一個 tier 每次看到的碎裂形狀相同，
   這讓「碎了幾次」讀起來是規律而不是隨機噪音。 */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const SHARDS = (() => {
  const r = mulberry32(20260814)
  return Array.from({ length: 18 }, (_, i) => ({
    a: (i * 360) / 18 + (r() - 0.5) * 14,
    d: 34 + r() * 26,
    w: 5 + r() * 9,
    h: 12 + r() * 20,
    spin: (r() - 0.5) * 220,
    delay: r() * 60
  }))
})()
const SPARKS = (() => {
  const r = mulberry32(77)
  return Array.from({ length: 26 }, () => ({
    a: r() * 360,
    d: 30 + r() * 46,
    s: 2 + r() * 4,
    dur: 420 + r() * 380,
    delay: r() * 180
  }))
})()
/** 收束線：蓄力時從外往內收，是「正在充能」最直接的語言 */
const STREAKS = (() => {
  const r = mulberry32(5150)
  return Array.from({ length: 14 }, (_, i) => ({
    a: (i * 360) / 14 + (r() - 0.5) * 18,
    len: 18 + r() * 26,
    delay: r() * 220
  }))
})()
</script>

<template>
  <div
    class="buildup"
    :class="[`ph-${phase}`, { rainbow: isRainbow, last: isLastRound }]"
    :style="{ '--c': isRainbow ? '#fff' : colour, '--k': intensity }"
    aria-hidden="true"
  >
    <!-- 壓暗背景，讓球體成為畫面上唯一的光源 -->
    <div class="veil"></div>

    <!-- 收束線：只在蓄力那一拍出現 -->
    <div class="streaks">
      <i
        v-for="(s, i) in STREAKS" :key="i"
        :style="{ '--a': s.a + 'deg', '--len': s.len + '%', '--dl': s.delay + 'ms' }"
      ></i>
    </div>

    <!-- 球體本身 -->
    <div class="orb">
      <div class="orbGlow"></div>
      <div class="orbBody"></div>
      <div class="orbRim"></div>
    </div>

    <!-- 碎裂的殼片 -->
    <div class="shards">
      <i
        v-for="(s, i) in SHARDS" :key="`${round}-${i}`"
        :style="{
          '--a': s.a + 'deg', '--d': s.d + '%',
          '--w': s.w + 'px', '--h': s.h + 'px',
          '--spin': s.spin + 'deg', '--dl': s.delay + 'ms'
        }"
      ></i>
    </div>

    <!-- 火花 -->
    <div class="sparks">
      <i
        v-for="(s, i) in SPARKS" :key="`${round}-${i}`"
        :style="{
          '--a': s.a + 'deg', '--d': s.d + '%', '--s': s.s + 'px',
          '--dur': s.dur + 'ms', '--dl': s.delay + 'ms'
        }"
      ></i>
    </div>

    <!-- 衝擊環 -->
    <div class="ring r1"></div>
    <div class="ring r2"></div>

    <!-- 收尾白閃 -->
    <div class="flash"></div>

    <!-- 碎裂次數的計數點。這是把暗號說白：碎越多顆亮越多 -->
    <div v-if="ladder.length > 1" class="pips">
      <i v-for="(_, i) in ladder" :key="i" :class="{ on: i <= round && phase !== 'idle' }"></i>
    </div>
  </div>
</template>

<style scoped>
.buildup {
  position: absolute; inset: 0;
  overflow: hidden;
  display: grid; place-items: center;
  pointer-events: none;
  --c: #8fb6ff;
  --k: 0.4;
}
.buildup > * { grid-area: 1 / 1; }
.ph-idle > *, .ph-done > * { opacity: 0; }
.ph-idle, .ph-done { opacity: 0; }

.veil {
  width: 100%; height: 100%;
  background: radial-gradient(circle at 50% 50%,
    rgba(0, 0, 0, .45) 0%, rgba(0, 0, 0, .82) 70%);
  opacity: 0; transition: opacity .3s;
}
.ph-charge .veil, .ph-burst .veil, .ph-finale .veil { opacity: 1; }

/* ---- 球體 ---- */
.orb {
  width: 30%; aspect-ratio: 1;
  display: grid; place-items: center;
  transform: scale(0);
}
.orb > * { grid-area: 1 / 1; border-radius: 50%; }
.orbGlow {
  width: 260%; height: 260%;
  background: radial-gradient(circle, var(--c) 0%, transparent 62%);
  opacity: calc(.28 + var(--k) * .4);
  filter: blur(6px);
}
.orbBody {
  width: 100%; height: 100%;
  background:
    radial-gradient(circle at 36% 30%, #fff 0%, var(--c) 42%, transparent 72%),
    radial-gradient(circle, var(--c) 40%, transparent 70%);
  box-shadow: 0 0 40px var(--c), inset 0 0 24px rgba(255, 255, 255, .7);
}
.orbRim {
  width: 116%; height: 116%;
  border: 2px solid var(--c);
  opacity: .55;
}
/* 彩虹階：球體本身換成 conic，單一色相撐不起「最高階」的份量 */
.rainbow .orbBody {
  background:
    radial-gradient(circle at 36% 30%, #fff 0%, transparent 46%),
    conic-gradient(#ff5f6d, #ffd75e, #7dff9b, #5fe0ff, #b98cff, #ff5f6d);
  box-shadow: 0 0 54px #ffb0e8, inset 0 0 26px rgba(255, 255, 255, .85);
}
.rainbow .orbGlow {
  background: conic-gradient(#ff5f6d55, #ffd75e55, #7dff9b55, #5fe0ff55, #b98cff55, #ff5f6d55);
  filter: blur(18px);
}

@media (prefers-reduced-motion: no-preference) {
  /* 蓄力：球體膨脹並抖動，越後面的輪次抖得越兇 */
  .ph-charge .orb { animation: orb-charge var(--t, 340ms) cubic-bezier(.4, 0, .8, .3) forwards; }
  /* 碎裂：先急縮再爆開 —— 少了那一縮，爆開會軟掉變成單純變亮 */
  .ph-burst .orb { animation: orb-burst 280ms cubic-bezier(.2, .9, .3, 1) forwards; }
  .ph-finale .orb { animation: orb-finale 420ms ease-out forwards; }
}
@keyframes orb-charge {
  0%   { transform: scale(.24) translate(0, 0); opacity: .7; }
  70%  { transform: scale(calc(.7 + var(--k) * .35)) translate(1px, -1px); opacity: 1; }
  84%  { transform: scale(calc(.66 + var(--k) * .35)) translate(-2px, 1px); }
  100% { transform: scale(calc(.62 + var(--k) * .3)) translate(0, 0); opacity: 1; }
}
@keyframes orb-burst {
  0%   { transform: scale(calc(.62 + var(--k) * .3)); opacity: 1; }
  22%  { transform: scale(calc(.42 + var(--k) * .2)); opacity: 1; }
  100% { transform: scale(calc(1.5 + var(--k) * .7)); opacity: 0; }
}
@keyframes orb-finale {
  0%   { transform: scale(calc(.62 + var(--k) * .3)); opacity: 1; }
  100% { transform: scale(2.6); opacity: 0; }
}

/* ---- 收束線 ---- */
.streaks { width: 100%; height: 100%; }
.streaks i {
  position: absolute; left: 50%; top: 50%;
  width: 2px; height: var(--len);
  margin-left: -1px;
  background: linear-gradient(to bottom, transparent, var(--c));
  transform-origin: 50% 0;
  transform: rotate(var(--a)) translateY(0);
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-charge .streaks i { animation: streak-in 340ms ease-in var(--dl) forwards; }
}
@keyframes streak-in {
  0%   { transform: rotate(var(--a)) translateY(180%); opacity: 0; }
  40%  { opacity: .9; }
  100% { transform: rotate(var(--a)) translateY(6%); opacity: 0; }
}

/* ---- 殼片 ---- */
.shards { width: 100%; height: 100%; }
.shards i {
  position: absolute; left: 50%; top: 50%;
  width: var(--w); height: var(--h);
  margin: calc(var(--h) / -2) 0 0 calc(var(--w) / -2);
  background: linear-gradient(150deg, #fff, var(--c) 55%, transparent);
  clip-path: polygon(50% 0%, 100% 62%, 62% 100%, 8% 74%);
  opacity: 0;
}
.rainbow .shards i {
  background: linear-gradient(150deg, #fff, #ffd75e 40%, #b98cff 75%, transparent);
}
@media (prefers-reduced-motion: no-preference) {
  .ph-burst .shards i, .ph-finale .shards i {
    animation: shard-fly 560ms cubic-bezier(.15, .8, .3, 1) var(--dl) forwards;
  }
}
@keyframes shard-fly {
  0%   { transform: rotate(var(--a)) translateY(-10%) rotate(0deg); opacity: 0; }
  10%  { opacity: 1; }
  100% { transform: rotate(var(--a)) translateY(calc(var(--d) * -1)) rotate(var(--spin)); opacity: 0; }
}

/* ---- 火花 ---- */
.sparks { width: 100%; height: 100%; }
.sparks i {
  position: absolute; left: 50%; top: 50%;
  width: var(--s); height: var(--s);
  margin: calc(var(--s) / -2) 0 0 calc(var(--s) / -2);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 8px var(--c);
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-burst .sparks i, .ph-finale .sparks i {
    animation: spark-fly var(--dur) ease-out var(--dl) forwards;
  }
}
@keyframes spark-fly {
  0%   { transform: rotate(var(--a)) translateY(-6%) scale(1); opacity: 0; }
  14%  { opacity: 1; }
  100% { transform: rotate(var(--a)) translateY(calc(var(--d) * -1)) scale(.2); opacity: 0; }
}

/* ---- 衝擊環 ---- */
.ring {
  width: 30%; aspect-ratio: 1;
  border-radius: 50%;
  border: 2px solid var(--c);
  opacity: 0;
}
.rainbow .ring { border-color: #ffd0f0; }
@media (prefers-reduced-motion: no-preference) {
  .ph-burst .r1, .ph-finale .r1 { animation: ring-out 520ms cubic-bezier(.1, .8, .3, 1) forwards; }
  .ph-burst .r2, .ph-finale .r2 { animation: ring-out 620ms cubic-bezier(.1, .8, .3, 1) 90ms forwards; }
}
@keyframes ring-out {
  0%   { transform: scale(.3); opacity: .9; border-width: 3px; }
  100% { transform: scale(calc(2.4 + var(--k) * 1.6)); opacity: 0; border-width: 1px; }
}

/* ---- 白閃 ----
   峰值要在一拍之內到頂。拖過 100ms 就會讀成「變亮」而不是「撞擊」。 */
.flash {
  width: 100%; height: 100%;
  background: radial-gradient(circle, #fff 0%, var(--c) 45%, transparent 75%);
  opacity: 0;
}
.rainbow .flash {
  background: radial-gradient(circle, #fff 0%, #ffd0f0 40%, transparent 75%);
}
@media (prefers-reduced-motion: no-preference) {
  .ph-finale .flash { animation: flash 420ms ease-out forwards; }
}
@keyframes flash {
  0%   { opacity: 0; transform: scale(.5); }
  12%  { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.6); }
}

/* ---- 碎裂計數 ---- */
.pips {
  align-self: end;
  display: flex; gap: 7px;
  margin-bottom: 8%;
  opacity: 0; transition: opacity .3s;
}
.ph-charge .pips, .ph-burst .pips, .ph-finale .pips { opacity: 1; }
.pips i {
  width: 7px; height: 7px; border-radius: 50%;
  background: rgba(255, 255, 255, .18);
  transition: background .25s, box-shadow .25s, transform .25s;
}
.pips i.on {
  background: var(--c);
  box-shadow: 0 0 10px var(--c);
  transform: scale(1.25);
}
.rainbow .pips i.on { background: #ffd0f0; box-shadow: 0 0 12px #ffb0e8; }

/* 動效偏好：關掉所有位移與閃光，只留顏色階梯本身的資訊 */
@media (prefers-reduced-motion: reduce) {
  .orb { transform: scale(.6); }
  .buildup:not(.ph-idle):not(.ph-done) .veil { opacity: 1; }
}
</style>
