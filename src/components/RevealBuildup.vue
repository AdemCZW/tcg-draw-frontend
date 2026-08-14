<script setup lang="ts">
/**
 * 開卡前的蓄勢演出（變身演出版）。
 *
 * 參考日系轉蛋高稀有演出（トレクル的「キュイーン」溜め、ドッカン的變身
 * cut-in、FGO 的呼び戻し）之後的結論：讓人起雞皮疙瘩的不是爆炸本身，
 * 是爆炸前那段**被拉長的蓄力** —— 氣場火焰舔上來、粒子逆重力上升、
 * 集中線隧道慢慢旋轉、電光劈啪作響，然後「全靜止一拍」，才炸。
 * 所以這版把重心從 burst 挪到 charge：
 *
 *   點火 → 長蓄力（火焰／上升粒子／集中線／電光／收束環／鏡頭推進，全部循環）
 *        → 全靜止 130ms（動 → 停 → 炸，少了死點爆開會軟掉）
 *        → 爆裂 → 下一段
 *
 * 蓄力長度逐段翻倍（500ms → 2100ms）。大師球全程約 8.7 秒 ——
 * 跟 FGO／原神最高稀有動畫同一個量級，「還沒完？」就是期待感本身。
 *
 * ---- 一個刻意的設計決定：這裡的升級是誠實的 ----
 * 業界常見的做法是「假性升級」：先閃出大獎的顏色再降回去，製造擦身而過的
 * 錯覺。那是賭博心理學裡研究最透徹的暗黑模式（near-miss effect），而
 * VaultDraw 整個賣點是可驗證公平 —— 結果早就封存在承諾雜湊裡，用假訊號
 * 騙一次心跳跟這個賣點直接衝突。顏色階梯一定走到該 tier 的真實終點。
 *
 * ---- 為什麼是 CSS + setTimeout 而不是 canvas + rAF ----
 * rAF 在分頁不可見或被節流時不推進，序列會卡在半途 —— 開卡演出卡住等於
 * 使用者以為自己的抽選壞了。所有循環特效都是 CSS keyframes，
 * 被節流也只是慢，狀態仍然會走完。
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
   每一階是一次「蓄力 → 碎裂」。階數與終點顏色一起編碼稀有度：
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

const HOLD = 130
const BURST = 300
const FINALE = 460

type Phase = 'idle' | 'charge' | 'hold' | 'burst' | 'finale' | 'done'
const phase = ref<Phase>('idle')
/** 目前在第幾輪（0-based），決定顏色 */
const round = ref(0)
const timers: number[] = []

const colour = computed(() => ladder.value[Math.min(round.value, ladder.value.length - 1)])
const isRainbow = computed(() => colour.value === RAINBOW)
const isLastRound = computed(() => round.value >= ladder.value.length - 1)

/* ---- 逐段升級表 ----
   「越來越華麗」不能只靠顏色跟亮度 —— 那樣第五段跟第一段的骨架長得一樣。
   真正有效的是每一段**多開一種特效、多放一批粒子、蓄力拉得更長**。

   關鍵：等級吃的是「絕對段數」而不是「這一段佔該 tier 的幾成」。
   精靈球只有一段，它就該長得跟大師球的第一段一模一樣；
   用相對比例算的話精靈球會直接全開，等級遞進就毀了。 */
const LEVELS = [
  { charge: 500, shard: .26, spark: .20, ray: 0, line: false, tint: false, rings: 1,
    flare: 0, sweep: false, glint: 0, dust: 0, pillar: false, shock: .55, shake: 0,
    chroma: false, aura: 6, ember: 10, arcs: 0, tunnel: false, converge: 0 },
  { charge: 780, shard: .46, spark: .40, ray: .45, line: true, tint: true, rings: 2,
    flare: 0, sweep: false, glint: 0, dust: 0, pillar: false, shock: .8, shake: .35,
    chroma: false, aura: 10, ember: 16, arcs: 0, tunnel: true, converge: 1 },
  { charge: 1150, shard: .66, spark: .62, ray: .7, line: true, tint: true, rings: 3,
    flare: 2, sweep: false, glint: 0, dust: 10, pillar: false, shock: 1, shake: .6,
    chroma: true, aura: 14, ember: 24, arcs: 4, tunnel: true, converge: 2 },
  { charge: 1600, shard: .86, spark: .84, ray: 1, line: true, tint: true, rings: 3,
    flare: 2, sweep: false, glint: 10, dust: 20, pillar: true, shock: 1.25, shake: .8,
    chroma: true, aura: 18, ember: 30, arcs: 7, tunnel: true, converge: 2 },
  { charge: 2100, shard: 1, spark: 1, ray: 1, line: true, tint: true, rings: 3,
    flare: 4, sweep: true, glint: 18, dust: 34, pillar: true, shock: 1.6, shake: 1,
    chroma: true, aura: 24, ember: 38, arcs: 10, tunnel: true, converge: 3 }
]
const lvl = computed(() => LEVELS[Math.min(round.value, LEVELS.length - 1)])
/** 球體大小與輝光也跟著絕對段數走 */
const intensity = computed(() => (Math.min(round.value, 4) + 1) / 5)

const take = <T,>(arr: T[], frac: number, min: number) =>
  frac <= 0 ? [] : arr.slice(0, Math.max(min, Math.round(arr.length * frac)))

function clear() {
  timers.forEach(clearTimeout)
  timers.length = 0
}

function runRound() {
  phase.value = 'charge'
  timers.push(window.setTimeout(() => {
    // 全靜止：所有循環凍在半空。動 → 停 → 炸，這一拍是撞擊感的來源
    phase.value = 'hold'
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
    }, HOLD))
  }, lvl.value.charge))
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

/* ---- 粒子表 ----
   固定種子，重繪後位置一致 —— 同一個 tier 每次看到的形狀相同，
   這讓「碎了幾次」讀起來是規律而不是隨機噪音。 */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const n1 = (v: number) => +v.toFixed(1)

const SHARDS = (() => {
  const r = mulberry32(20260814)
  return Array.from({ length: 40 }, (_, i) => ({
    a: n1((i * 360) / 40 + (r() - 0.5) * 16),
    d: n1(40 + r() * 42),
    w: n1(5 + r() * 12),
    h: n1(14 + r() * 30),
    spin: Math.round((r() - 0.5) * 300),
    delay: Math.round(r() * 70)
  }))
})()
const SPARKS = (() => {
  const r = mulberry32(77)
  return Array.from({ length: 72 }, () => ({
    a: n1(r() * 360),
    d: n1(34 + r() * 62),
    s: n1(2 + r() * 5),
    dur: Math.round(420 + r() * 520),
    delay: Math.round(r() * 220)
  }))
})()
/** 點火收束線：蓄力開始那一瞬從外往內收，宣告「開始充能」 */
const STREAKS = (() => {
  const r = mulberry32(5150)
  return Array.from({ length: 30 }, (_, i) => ({
    a: n1((i * 360) / 30 + (r() - 0.5) * 16),
    len: n1(22 + r() * 34),
    delay: Math.round(r() * 240)
  }))
})()
/** 神光：碎裂瞬間從球心射出的長光束 */
const RAYS = (() => {
  const r = mulberry32(3131)
  return Array.from({ length: 20 }, (_, i) => ({
    a: n1((i * 360) / 20 + (r() - 0.5) * 10),
    w: n1(2 + r() * 9),
    len: n1(46 + r() * 34),
    delay: Math.round(r() * 50)
  }))
})()
/** 十字光芒：高段才出現的巨大星芒，橫跨整個畫面 */
const FLARES = [0, 90, 45, 135]

/** 氣場火焰：貼著球面舔上來的火舌，蓄力期間一直循環。
    位置繞球一圈、側邊的往外傾 —— 這是「氣場包住球」跟「旁邊有火」的差別 */
const AURA = (() => {
  const r = mulberry32(606)
  return Array.from({ length: 24 }, (_, i) => {
    const a = (i * 360) / 24 + (r() - 0.5) * 12
    const rad = (a * Math.PI) / 180
    return {
      x: n1(50 + Math.cos(rad) * 44),
      y: n1(50 + Math.sin(rad) * 44),
      tilt: n1(Math.cos(rad) * 22),
      w: n1(4 + r() * 3.5),
      h: n1(16 + r() * 16),
      dur: Math.round(520 + r() * 520),
      delay: Math.round(r() * 600)
    }
  })
})()
/** 上升粒子：逆著重力往上飄。「往上」本身就是超自然力量的視覺語言 */
const EMBERS = (() => {
  const r = mulberry32(1717)
  return Array.from({ length: 38 }, () => ({
    x: n1(10 + r() * 80),
    y0: n1(58 + r() * 30),
    s: +(0.8 + r() * 1.4).toFixed(2),
    rise: Math.round(30 + r() * 38),
    drift: Math.round((r() - 0.5) * 10),
    dur: Math.round(1100 + r() * 1400),
    delay: Math.round(r() * 1500)
  }))
})()
/** 電光：球體周圍隨機劈啪的鋸齒閃電，第三段起出現 */
const ARCS = (() => {
  const r = mulberry32(2929)
  return Array.from({ length: 10 }, (_, i) => {
    const a = (i * 360) / 10 + (r() - 0.5) * 20
    const rad = (a * Math.PI) / 180
    return {
      x: n1(50 + Math.cos(rad) * 20),
      y: n1(50 + Math.sin(rad) * 17),
      rot: Math.round(r() * 360),
      w: n1(7 + r() * 8),
      dur: Math.round(240 + r() * 420),
      delay: Math.round(r() * 900)
    }
  })
})()
/** 集中線隧道：漫畫的集中線做成會慢慢旋轉的環，蓄力期間罩住整個畫面 */
const TUNNEL = (() => {
  const r = mulberry32(8080)
  return Array.from({ length: 36 }, (_, i) => ({
    a: n1(i * 10 + (r() - 0.5) * 6),
    len: Math.round(24 + r() * 30),
    o: +(0.08 + r() * 0.16).toFixed(2)
  }))
})()
/** 金光閃爍：四角星芒。固定金色不吃屬性色 —— 金光本身就是獨立的獎賞訊號。
    每顆隨機的初始角度與尺寸，整齊劃一的旋轉會讀成貼圖 */
const GLINTS = (() => {
  const r = mulberry32(88991)
  return Array.from({ length: 18 }, () => ({
    x: n1(10 + r() * 80),
    y: n1(12 + r() * 76),
    s: Math.round(10 + r() * 22),
    r0: Math.round(r() * 90),
    dur: Math.round(520 + r() * 620),
    delay: Math.round(r() * 700)
  }))
})()
/** 金粉：爆開後緩緩上飄的碎金 */
const DUST = (() => {
  const r = mulberry32(4242)
  return Array.from({ length: 34 }, () => ({
    x: n1(6 + r() * 88),
    s: n1(2 + r() * 4),
    rise: Math.round(30 + r() * 46),
    dur: Math.round(900 + r() * 900),
    delay: Math.round(r() * 400),
    drift: Math.round((r() - 0.5) * 40)
  }))
})()

/* 每一段實際參與的粒子。切片而不是全開，是「越變越華麗」成立的前提 */
const shardsNow = computed(() => take(SHARDS, lvl.value.shard, 10))
const sparksNow = computed(() => take(SPARKS, lvl.value.spark, 14))
const raysNow = computed(() => take(RAYS, lvl.value.ray, 6))
const flaresNow = computed(() => FLARES.slice(0, lvl.value.flare))
const glintsNow = computed(() => GLINTS.slice(0, lvl.value.glint))
const dustNow = computed(() => DUST.slice(0, lvl.value.dust))
const auraNow = computed(() => AURA.slice(0, lvl.value.aura))
const embersNow = computed(() => EMBERS.slice(0, lvl.value.ember))
const arcsNow = computed(() => ARCS.slice(0, lvl.value.arcs))
</script>

<template>
  <div
    class="buildup"
    :class="[`ph-${phase}`, { rainbow: isRainbow, last: isLastRound }]"
    :style="{ '--c': isRainbow ? '#fff' : colour, '--k': intensity, '--shake': lvl.shake, '--sk': lvl.shock }"
    aria-hidden="true"
  >
    <!-- 壓暗背景，讓球體成為畫面上唯一的光源 -->
    <div class="veil"></div>

    <!-- 集中線隧道：蓄力期間慢慢旋轉 -->
    <div v-if="lvl.tunnel" class="tunnel" :key="`tn-${round}`">
      <i
        v-for="(t, i) in TUNNEL" :key="i"
        :style="{ '--a': t.a + 'deg', '--len': t.len + 'cqmax', '--o': t.o }"
      ></i>
    </div>

    <!-- 點火收束線：蓄力開始那一瞬 -->
    <div v-if="lvl.line" class="streaks" :key="`st-${round}`">
      <i
        v-for="(s, i) in STREAKS" :key="i"
        :style="{ '--a': s.a + 'deg', '--len': s.len + '%', '--dl': s.delay + 'ms' }"
      ></i>
    </div>

    <!-- 收束環：一圈圈縮進球心，「能量流入」的語言 -->
    <div v-if="lvl.converge" class="converge" :key="`cv-${round}`">
      <i v-for="c in lvl.converge" :key="c" :style="{ '--dl': (c - 1) * 380 + 'ms' }"></i>
    </div>

    <!-- 氣場火焰：貼著球面舔上來 -->
    <div class="aura" :key="`au-${round}`">
      <i
        v-for="(f, i) in auraNow" :key="i"
        :style="{
          left: f.x + '%', top: f.y + '%',
          '--tilt': f.tilt + 'deg', '--w': f.w + '%', '--h': f.h + '%',
          '--dur': f.dur + 'ms', '--dl': f.delay + 'ms'
        }"
      ></i>
    </div>

    <!-- 球體本身 -->
    <div class="orb">
      <div class="orbGlow"></div>
      <div class="orbBody"></div>
      <div class="orbRim"></div>
    </div>

    <!-- 上升粒子 -->
    <div class="embers" :key="`em-${round}`">
      <i
        v-for="(e, i) in embersNow" :key="i"
        :style="{
          left: e.x + '%', top: e.y0 + '%',
          '--s': e.s + 'cqmin', '--rise': e.rise + 'cqh', '--drift': e.drift + 'cqw',
          '--dur': e.dur + 'ms', '--dl': e.delay + 'ms'
        }"
      ></i>
    </div>

    <!-- 電光 -->
    <div v-if="arcsNow.length" class="arcs" :key="`ar-${round}`">
      <i
        v-for="(a, i) in arcsNow" :key="i"
        :style="{
          left: a.x + '%', top: a.y + '%',
          '--rot': a.rot + 'deg', '--w': a.w + 'cqmin',
          '--dur': a.dur + 'ms', '--dl': a.delay + 'ms'
        }"
      ></i>
    </div>

    <!-- 神光：碎裂瞬間從球心射出的長光束 -->
    <div class="rays">
      <i
        v-for="(r, i) in raysNow" :key="`${round}-${i}`"
        :style="{ '--a': r.a + 'deg', '--w': r.w + 'px', '--len': r.len + '%', '--dl': r.delay + 'ms' }"
      ></i>
    </div>

    <!-- 碎裂的殼片 -->
    <div class="shards">
      <i
        v-for="(s, i) in shardsNow" :key="`${round}-${i}`"
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
        v-for="(s, i) in sparksNow" :key="`${round}-${i}`"
        :style="{
          '--a': s.a + 'deg', '--d': s.d + '%', '--s': s.s + 'px',
          '--dur': s.dur + 'ms', '--dl': s.delay + 'ms'
        }"
      ></i>
    </div>

    <!-- 十字光芒 -->
    <div v-if="flaresNow.length" class="flare">
      <i v-for="(a, i) in flaresNow" :key="`${round}-${i}`" :style="{ '--a': a + 'deg' }"></i>
    </div>

    <!-- 全畫面掃光：只有最後一段（彩虹）才會出現 -->
    <div v-if="lvl.sweep" class="sweep"></div>

    <!-- 爆裂衝擊：硬邊的擴張圓盤。跟細線衝擊環不同，這是「有質量的東西炸開」 -->
    <div class="shock"></div>

    <!-- 色差：撞擊瞬間的紅／青偏移，讀起來是「鏡頭被震到」 -->
    <template v-if="lvl.chroma">
      <div class="chroma cr"></div>
      <div class="chroma cb"></div>
    </template>

    <!-- 光柱：從球心直上直下的光束，高段限定 -->
    <div v-if="lvl.pillar" class="pillar"></div>

    <!-- 金光閃爍 -->
    <div v-if="glintsNow.length" class="glints">
      <i
        v-for="(g, i) in glintsNow" :key="`${round}-${i}`"
        :style="{
          left: g.x + '%', top: g.y + '%', '--s': g.s + 'px', '--r0': g.r0 + 'deg',
          '--dur': g.dur + 'ms', '--dl': g.delay + 'ms'
        }"
      ></i>
    </div>

    <!-- 金粉 -->
    <div v-if="dustNow.length" class="dust">
      <i
        v-for="(d, i) in dustNow" :key="`${round}-${i}`"
        :style="{
          left: d.x + '%', '--s': d.s + 'px', '--rise': d.rise + '%',
          '--drift': d.drift + 'px', '--dur': d.dur + 'ms', '--dl': d.delay + 'ms'
        }"
      ></i>
    </div>

    <!-- 衝擊環 -->
    <div class="ring r1"></div>
    <div v-if="lvl.rings > 1" class="ring r2"></div>
    <div v-if="lvl.rings > 2" class="ring r3"></div>

    <!-- 每次碎裂時整格閃一下屬性色 -->
    <div v-if="lvl.tint" class="tint"></div>

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
  /* cqh/cqmin 給上升粒子與電光用 —— 尺寸全部相對於舞台，不寫死 px */
  container-type: size;
  --c: #8fb6ff;
  --k: 0.4;
}
.buildup > * { grid-area: 1 / 1; }
.ph-idle > *, .ph-done > * { opacity: 0; }
.ph-idle, .ph-done { opacity: 0; }

/* ---- 全靜止 ----
   蓄力的所有循環凍在半空。動 → 停 → 炸；
   凍結（而不是消失）需要 hold 沿用 charge 的同一組 animation 宣告 ——
   宣告相同就不會重播，這一條 pause 才有東西可暫停。 */
.ph-hold *, .ph-hold.buildup { animation-play-state: paused !important; }

/* ---- 鏡頭推進 ----
   蓄力期間整個畫面慢慢放大。固定時長：低段蓄力短、只推進到一半就炸，
   高段推好推滿 —— 不用另外寫參數，時間本身就是參數。 */
@media (prefers-reduced-motion: no-preference) {
  .ph-charge.buildup, .ph-hold.buildup {
    animation: cam-push 2400ms cubic-bezier(.4, 0, .8, .6) forwards;
  }
}
@keyframes cam-push {
  from { transform: scale(1); }
  to   { transform: scale(1.065); }
}

.veil {
  width: 100%; height: 100%;
  background: radial-gradient(circle at 50% 50%,
    rgba(0, 0, 0, .45) 0%, rgba(0, 0, 0, .82) 70%);
  opacity: 0; transition: opacity .3s;
}
.ph-charge .veil, .ph-hold .veil, .ph-burst .veil, .ph-finale .veil { opacity: 1; }

/* ---- 集中線隧道 ---- */
.tunnel {
  position: absolute; inset: -25%;
  opacity: 0;
  transition: opacity .4s;
}
.tunnel i {
  position: absolute; left: 50%; top: 50%;
  width: 1.5px; height: var(--len);
  margin-left: -.75px;
  background: linear-gradient(to top, rgba(255, 255, 255, var(--o)), transparent);
  transform-origin: 50% 0;
  transform: rotate(var(--a)) translateY(22cqmin);
}
@media (prefers-reduced-motion: no-preference) {
  .ph-charge .tunnel, .ph-hold .tunnel {
    opacity: 1;
    animation: tunnel-spin 16s linear infinite;
  }
}
@keyframes tunnel-spin { to { transform: rotate(360deg); } }

/* ---- 球體 ---- */
.orb {
  width: 30%; aspect-ratio: 1;
  display: grid; place-items: center;
  transform: scale(0);
}
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
  box-shadow:
    0 0 30px var(--c),
    0 0 80px var(--c),
    0 0 140px var(--c),
    inset 0 0 26px rgba(255, 255, 255, .8);
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
  box-shadow: 0 0 40px #ffb0e8, 0 0 110px #ff9ee0, 0 0 180px #b98cff,
              inset 0 0 30px rgba(255, 255, 255, .9);
}
.rainbow .orbGlow {
  background: conic-gradient(#ff5f6d55, #ffd75e55, #7dff9b55, #5fe0ff55, #b98cff55, #ff5f6d55);
  filter: blur(18px);
}
/* 彩虹球蓄力時慢速自轉 —— 靜止的 conic-gradient 讀起來是調色盤不是能量體 */
@media (prefers-reduced-motion: no-preference) {
  .ph-charge.rainbow .orbBody, .ph-hold.rainbow .orbBody,
  .ph-charge.rainbow .orbGlow, .ph-hold.rainbow .orbGlow {
    animation: orb-spin 3.2s linear infinite;
  }
}
@keyframes orb-spin { to { rotate: 1turn; } }

@media (prefers-reduced-motion: no-preference) {
  /* 長蓄力：先浮現，然後像心跳一樣脈動到炸開為止 */
  .ph-charge .orb, .ph-hold .orb {
    animation:
      orb-in 320ms cubic-bezier(.3, .7, .4, 1) forwards,
      orb-pulse 640ms 320ms ease-in-out infinite alternate;
  }
  .ph-burst .orb { animation: orb-burst 300ms cubic-bezier(.2, .9, .3, 1) forwards; }
  .ph-finale .orb { animation: orb-finale 460ms ease-out forwards; }
}
@keyframes orb-in {
  from { transform: scale(.2); opacity: 0; }
  to   { transform: scale(calc(.58 + var(--k) * .28)); opacity: 1; }
}
@keyframes orb-pulse {
  from { transform: scale(calc(.58 + var(--k) * .28)); }
  to   { transform: scale(calc(.68 + var(--k) * .32)); }
}
@keyframes orb-burst {
  0%   { transform: scale(calc(.64 + var(--k) * .3)); opacity: 1; }
  22%  { transform: scale(calc(.42 + var(--k) * .2)); opacity: 1; }
  100% { transform: scale(calc(1.5 + var(--k) * .7)); opacity: 0; }
}
@keyframes orb-finale {
  0%   { transform: scale(calc(.64 + var(--k) * .3)); opacity: 1; }
  100% { transform: scale(2.6); opacity: 0; }
}

/* ---- 氣場火焰 ---- */
.aura {
  width: 34%; aspect-ratio: 1;
  position: relative;
}
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
.rainbow .aura i {
  background: linear-gradient(to top, #b98cff, #fff 78%, transparent);
}
@media (prefers-reduced-motion: no-preference) {
  .ph-charge .aura i, .ph-hold .aura i {
    animation: flame-lick var(--dur) ease-in-out var(--dl) infinite;
  }
}
@keyframes flame-lick {
  0%   { transform: rotate(var(--tilt)) translateY(0) scaleY(.55); opacity: 0; }
  30%  { opacity: .85; }
  100% { transform: rotate(var(--tilt)) translateY(-130%) scaleY(1.25); opacity: 0; }
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
  .ph-charge .embers i, .ph-hold .embers i {
    animation: ember-rise var(--dur) linear var(--dl) infinite;
  }
}
@keyframes ember-rise {
  0%   { transform: translate(0, 0) scale(.6); opacity: 0; }
  15%  { opacity: .9; }
  100% { transform: translate(var(--drift), calc(var(--rise) * -1)) scale(1.1); opacity: 0; }
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
  .ph-charge .arcs i, .ph-hold .arcs i {
    animation: arc-flick var(--dur) steps(2, jump-none) var(--dl) infinite;
  }
}
@keyframes arc-flick {
  0%   { opacity: 0; }
  45%  { opacity: 1; }
  100% { opacity: 0; }
}

/* ---- 收束環 ---- */
.converge { width: 100%; height: 100%; }
.converge i {
  position: absolute; left: 50%; top: 50%;
  width: 56cqmin; height: 56cqmin;
  margin: -28cqmin 0 0 -28cqmin;
  border: 1.5px solid var(--c);
  border-radius: 50%;
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-charge .converge i, .ph-hold .converge i {
    animation: ring-in 1150ms cubic-bezier(.4, 0, .7, .4) var(--dl) infinite;
  }
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
  box-shadow: 0 0 10px var(--c), 0 0 22px var(--c);
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

/* ---- 神光 ----
   從球心射出的長光束。用 screen 混色疊在一起，交界處自然變白，
   這是單靠不透明度堆不出來的亮度層次。 */
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
.rainbow .rays i {
  background: linear-gradient(to top, #ffd0f0, #fff 28%, transparent);
}
@media (prefers-reduced-motion: no-preference) {
  .ph-burst .rays i, .ph-finale .rays i {
    animation: ray-shoot 520ms cubic-bezier(.1, .85, .25, 1) var(--dl) forwards;
  }
}
@keyframes ray-shoot {
  0%   { transform: rotate(var(--a)) scaleY(0); opacity: 0; }
  18%  { transform: rotate(var(--a)) scaleY(1); opacity: 1; }
  100% { transform: rotate(var(--a)) scaleY(1.5); opacity: 0; }
}

/* ---- 十字光芒 ----
   橫跨整個畫面的星芒。第三段才開始出現、第五段補到四道 ——
   「多一種特效」比「同一種特效變亮」更能讀出等級差。 */
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
  .ph-burst .flare i, .ph-finale .flare i {
    animation: flare-open 480ms cubic-bezier(.1, .9, .25, 1) forwards;
  }
}
@keyframes flare-open {
  0%   { transform: rotate(var(--a)) scaleX(0); opacity: 0; }
  16%  { transform: rotate(var(--a)) scaleX(1); opacity: 1; }
  100% { transform: rotate(var(--a)) scaleX(1.2); opacity: 0; }
}

/* ---- 全畫面掃光：只有最後一段有 ---- */
.sweep {
  width: 220%; height: 100%;
  background: linear-gradient(102deg, transparent 42%, rgba(255, 255, 255, .8) 50%, transparent 58%);
  mix-blend-mode: screen;
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-burst .sweep, .ph-finale .sweep { animation: sweep 560ms ease-out forwards; }
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
  background: radial-gradient(circle,
    transparent 52%, var(--c) 62%, rgba(255, 255, 255, .9) 72%, transparent 84%);
  opacity: 0;
  filter: blur(1px);
}
.rainbow .shock {
  background: radial-gradient(circle, transparent 52%, #ffd0f0 62%, #fff 72%, transparent 84%);
}
@media (prefers-reduced-motion: no-preference) {
  .ph-burst .shock, .ph-finale .shock { animation: shock-out 440ms cubic-bezier(.05, .85, .25, 1) forwards; }
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
  .ph-burst .cr, .ph-finale .cr { animation: chroma-r 240ms ease-out forwards; }
  .ph-burst .cb, .ph-finale .cb { animation: chroma-b 240ms ease-out forwards; }
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

/* ---- 光柱 ---- */
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
  .ph-burst .pillar, .ph-finale .pillar { animation: pillar-up 520ms cubic-bezier(.1, .9, .3, 1) forwards; }
}
@keyframes pillar-up {
  0%   { transform: scaleY(0) scaleX(.4); opacity: 0; }
  20%  { transform: scaleY(1) scaleX(1); opacity: .85; }
  100% { transform: scaleY(1) scaleX(.3); opacity: 0; }
}

/* ---- 金光閃爍 ----
   四角星芒。固定金色不吃屬性色 —— 「金光」本身就是一個獨立的獎賞訊號，
   混進屬性色就變成單純的裝飾亮點，失去意義。 */
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
  .ph-burst .glints i, .ph-finale .glints i { animation: glint-twinkle var(--dur) ease-out var(--dl) forwards; }
}
@keyframes glint-twinkle {
  0%   { transform: rotate(var(--r0)) scale(0); opacity: 0; }
  30%  { transform: rotate(calc(var(--r0) + 40deg)) scale(1); opacity: 1; }
  62%  { transform: rotate(calc(var(--r0) + 60deg)) scale(.72); opacity: .85; }
  100% { transform: rotate(calc(var(--r0) + 100deg)) scale(0); opacity: 0; }
}

/* ---- 金粉 ---- */
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
  .ph-burst .dust i, .ph-finale .dust i { animation: dust-rise var(--dur) ease-out var(--dl) forwards; }
}
@keyframes dust-rise {
  0%   { transform: translate(0, 0) scale(.4); opacity: 0; }
  20%  { opacity: 1; }
  100% { transform: translate(var(--drift), calc(var(--rise) * -1)) scale(1); opacity: 0; }
}

/* ---- 整格震動 ----
   撞擊感最便宜也最有效的一招。振幅吃段數，第一段完全不震。 */
@media (prefers-reduced-motion: no-preference) {
  .ph-burst, .ph-finale { animation: hit-shake 240ms cubic-bezier(.36, .07, .19, .97); }
}
@keyframes hit-shake {
  0%, 100% { transform: translate(0, 0); }
  14% { transform: translate(calc(var(--shake) * -7px), calc(var(--shake) * 4px)); }
  32% { transform: translate(calc(var(--shake) * 6px), calc(var(--shake) * -3px)); }
  52% { transform: translate(calc(var(--shake) * -4px), calc(var(--shake) * -2px)); }
  74% { transform: translate(calc(var(--shake) * 2px), calc(var(--shake) * 2px)); }
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
  .ph-burst .r3, .ph-finale .r3 { animation: ring-out 760ms cubic-bezier(.1, .8, .3, 1) 190ms forwards; }
}
@keyframes ring-out {
  0%   { transform: scale(.3); opacity: .9; border-width: 3px; }
  100% { transform: scale(calc(2.4 + var(--k) * 1.6)); opacity: 0; border-width: 1px; }
}

/* ---- 整格色閃 ---- */
.tint {
  width: 100%; height: 100%;
  background: var(--c);
  mix-blend-mode: screen;
  opacity: 0;
}
.rainbow .tint {
  background: conic-gradient(#ff5f6d, #ffd75e, #7dff9b, #5fe0ff, #b98cff, #ff5f6d);
}
@media (prefers-reduced-motion: no-preference) {
  .ph-burst .tint, .ph-finale .tint { animation: tint-pop 340ms ease-out forwards; }
}
@keyframes tint-pop {
  0%   { opacity: 0; }
  10%  { opacity: calc(.16 + var(--k) * .22); }
  100% { opacity: 0; }
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
.ph-charge .pips, .ph-hold .pips, .ph-burst .pips, .ph-finale .pips { opacity: 1; }
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
