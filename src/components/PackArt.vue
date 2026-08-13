<script setup lang="ts">
/**
 * 自製卡包視覺 —— 完全不使用任何廠商素材。
 *
 * 讓它「像卡包」而不是像信封，靠的是四個真實特徵：
 *  1. 鋸齒熱封邊 —— booster pack 最標誌性的特徵，上下各一道
 *  2. 中央鼓起  —— 裡面裝了卡，袋身會膨；用圓柱受光模擬
 *  3. 細長比例  —— 真實卡包約 1:1.8，比卡片（1:1.4）瘦長得多
 *  4. 鋁膜光澤  —— 縱向的柔和高光帶，加上幾道折痕
 *
 * 微 3D 用兩層達成：SVG 內的圓柱明暗給出體積感（靜態就有），
 * 外層再用 perspective + rotate 隨游標傾斜，並讓高光反向位移產生視差。
 *
 * 品牌上仍然把承諾雜湊印在封條，讓包裝與「開賣前就已封存」的機制指向同一件事。
 * 純 SVG，任何尺寸都不會糊。
 */
import { computed } from 'vue'
import type { Tier } from '@/types/models'
import { useTilt } from '@/composables/useTilt'

const props = withDefaults(defineProps<{
  tier?: Tier
  label?: string
  serial?: string
  hash?: string
  /** 撕開後：上緣封邊掀開、封條褪色、光澤停止 */
  opened?: boolean
  /** 縮圖模式：拿掉小字，只留封條與封緘 */
  compact?: boolean
  /** 關掉游標傾斜（例如放在可捲動的長列表裡） */
  flat?: boolean
}>(), {
  tier: 'D', label: '', serial: '', hash: '',
  opened: false, compact: false, flat: false
})

const TIER_VAR: Record<Tier, string> = {
  A: '--tier-a', B: '--tier-b', C: '--tier-c',
  D: '--tier-d', LAST: '--tier-last', BUST: '--faint'
}
const foil = computed(() => `var(${TIER_VAR[props.tier]})`)
const hashChip = computed(() => (props.hash ? props.hash.slice(0, 10).toUpperCase() : ''))

const phase = computed(() => {
  let h = 0
  for (const ch of props.serial || props.label || 'VD') h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
})
const uid = computed(() => `pk${phase.value}${props.tier}`)

// 9 度而非預設的 16 —— 要的是「微」3D，角度大了會像在甩卡
const { el, rx, ry, gx, gy, active, onMove, reset } = useTilt(9)

/* ---- 鋸齒封邊 ----
   真實卡包的上下緣是用鋸齒刀裁的。齒距做成 11.3 左右（272 / 24），
   太大會像鋸子、太小會在縮圖時糊成直線。 */
const W = 300, H = 540
const X0 = 14, X1 = 286
const TEETH = 24
const TOOTH = (X1 - X0) / TEETH

function zigzag(fromX: number, toX: number, valleyY: number, peakY: number) {
  const dir = toX > fromX ? 1 : -1
  const step = TOOTH * dir
  let d = ''
  for (let i = 0; i < TEETH; i++) {
    const x = fromX + step * i
    d += ` L${(x + step / 2).toFixed(1)} ${peakY} L${(x + step).toFixed(1)} ${valleyY}`
  }
  return d
}

/** 袋身外框：上緣鋸齒 → 右側 → 下緣鋸齒 → 左側 */
const outline = computed(() =>
  `M${X0} 30` +
  zigzag(X0, X1, 30, 16) +
  ` L${X1} 510` +
  zigzag(X1, X0, 510, 524) +
  ' Z'
)
</script>

<template>
  <div
    class="pack3d"
    :class="{ opened, tilting: !flat, active }"
    @pointermove="flat || onMove($event)"
    @pointerleave="flat || reset()"
  >
    <div
      ref="el"
      class="plane"
      :style="flat ? undefined : { transform: `rotateX(${rx}deg) rotateY(${ry}deg)` }"
    >
      <svg class="pack" :viewBox="`0 0 ${W} ${H}`" role="img"
           :aria-label="label ? `${label} 卡包` : '卡包'">
        <defs>
          <!-- 燙金封條 -->
          <linearGradient :id="`${uid}-foil`" x1="0" y1="0" x2="1" y2="0.3">
            <stop offset="0%" :stop-color="foil" stop-opacity=".5" />
            <stop offset="40%" :stop-color="foil" stop-opacity="1" />
            <stop offset="56%" stop-color="#fff" stop-opacity=".92" />
            <stop offset="70%" :stop-color="foil" stop-opacity="1" />
            <stop offset="100%" :stop-color="foil" stop-opacity=".45" />
          </linearGradient>

          <!-- 袋身底色 -->
          <linearGradient :id="`${uid}-body`" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--surface-3)" />
            <stop offset="45%" stop-color="var(--surface)" />
            <stop offset="100%" stop-color="var(--bg)" />
          </linearGradient>

          <!-- 圓柱受光：中央鼓起的關鍵。左右壓暗、中間偏亮，
               讓平面的 SVG 讀起來像一個有厚度的袋子。 -->
          <linearGradient :id="`${uid}-round`" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#000" stop-opacity=".45" />
            <stop offset="9%" stop-color="#000" stop-opacity=".26" />
            <stop offset="26%" stop-color="#fff" stop-opacity=".05" />
            <stop offset="44%" stop-color="#fff" stop-opacity=".12" />
            <stop offset="58%" stop-color="#fff" stop-opacity=".07" />
            <stop offset="78%" stop-color="#000" stop-opacity=".2" />
            <stop offset="100%" stop-color="#000" stop-opacity=".5" />
          </linearGradient>

          <!-- 鋁膜縱向高光 -->
          <linearGradient :id="`${uid}-mylar`" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#fff" stop-opacity="0" />
            <stop offset="50%" stop-color="#fff" stop-opacity=".13" />
            <stop offset="100%" stop-color="#fff" stop-opacity="0" />
          </linearGradient>

          <!-- 熱封邊的細密壓紋 -->
          <pattern :id="`${uid}-crimp`" width="6" height="6" patternUnits="userSpaceOnUse">
            <path d="M3 0 L3 6" stroke="#000" stroke-width="2" stroke-opacity=".22" />
          </pattern>

          <clipPath :id="`${uid}-clip`"><path :d="outline" /></clipPath>
        </defs>

        <!-- 袋身 -->
        <path :d="outline" :fill="`url(#${uid}-body)`" />

        <!-- 所有內容都在裁切群組內，圓柱受光最後才整片蓋上 ——
             這樣連封條與文字都會跟著袋身彎，而不是浮在一個彎曲的袋子上面。 -->
        <g :clip-path="`url(#${uid}-clip)`">
          <!-- 折痕：幾道極淡的斜線，避免袋面太乾淨 -->
          <g stroke="#fff" stroke-opacity=".05" stroke-width="1" fill="none">
            <path d="M40 60 C 120 190, 90 320, 150 520" />
            <path d="M215 40 C 180 200, 235 330, 200 520" />
          </g>
          <!-- 鋁膜高光帶 -->
          <rect class="mylar" x="70" y="0" width="72" height="540" :fill="`url(#${uid}-mylar)`" />
          <!-- 上下熱封邊：壓紋 + 內側一道亮邊，讓它跟袋面分層 -->
          <g>
            <rect :x="X0" y="30" :width="X1 - X0" height="34" fill="#000" fill-opacity=".42" />
            <rect :x="X0" y="30" :width="X1 - X0" height="34" :fill="`url(#${uid}-crimp)`" />
            <path :d="`M${X0} 64.5 H${X1}`" stroke="#fff" stroke-opacity=".1" stroke-width="1" />
            <rect :x="X0" y="476" :width="X1 - X0" height="34" fill="#000" fill-opacity=".42" />
            <rect :x="X0" y="476" :width="X1 - X0" height="34" :fill="`url(#${uid}-crimp)`" />
            <path :d="`M${X0} 475.5 H${X1}`" stroke="#fff" stroke-opacity=".1" stroke-width="1" />
          </g>

          <!-- 封條 -->
          <g :opacity="opened ? .4 : 1">
            <rect :x="X0" y="96" :width="X1 - X0" height="48" :fill="`url(#${uid}-foil)`" />
            <text v-if="hashChip && !compact" class="seal-text" x="30" y="126">封存 {{ hashChip }}</text>
            <text
              class="seal-tier" :class="{ solo: compact }"
              :x="compact ? 150 : 270" y="126"
              :text-anchor="compact ? 'middle' : 'end'"
            >{{ tier === 'LAST' ? '最後賞' : tier === 'BUST' ? '爆賞' : `${tier} 賞` }}</text>
          </g>

          <!-- 火漆封緘 -->
          <g :transform="`translate(150 ${compact ? 300 : 286})${compact ? ' scale(1.45)' : ''}`"
           :opacity="opened ? .3 : 1">
          <path d="M0 -50 L43 -25 L43 25 L0 50 L-43 25 L-43 -25 Z"
                fill="var(--surface-2)" fill-opacity=".85" :stroke="foil" stroke-width="1.8" />
          <path d="M0 -37 L32 -18 L32 18 L0 37 L-32 18 L-32 -18 Z"
                fill="none" stroke="var(--line)" stroke-width="1" />
          <path d="M-15 -14 L0 18 L15 -14" fill="none" :stroke="foil"
                  stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
          </g>

          <template v-if="!compact">
            <text v-if="label" class="label" x="150" y="392" text-anchor="middle">{{ label }}</text>
            <path d="M50 424 h200" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 4" />
            <text class="brand" x="50" y="454">VAULTDRAW</text>
            <text v-if="serial" class="serial" x="250" y="454" text-anchor="end">{{ serial }}</text>
          </template>

          <!-- 圓柱受光：最後整片蓋上，印刷與袋身一起彎 -->
          <rect x="0" y="0" :width="W" :height="H" :fill="`url(#${uid}-round)`"
                style="pointer-events:none" />
        </g>
      </svg>

      <!-- 游標處的柔光，與傾斜反向位移做出視差 -->
      <span
        v-if="!flat" class="gloss" aria-hidden="true"
        :style="{ background: `radial-gradient(42% 32% at ${gx}% ${gy}%, rgba(255,255,255,.30), transparent 72%)` }"
      ></span>
    </div>
  </div>
</template>

<style scoped>
.pack3d { perspective: 900px; }
.plane {
  position: relative;
  transform-style: preserve-3d;
  transition: transform .45s cubic-bezier(.2, .7, .3, 1);
  /* 袋身底部的落影，讓它離開背景而不是貼在上面 */
  filter: drop-shadow(0 14px 22px rgba(0, 0, 0, .55));
}
.tilting.active .plane { transition: transform .08s linear; }
.pack { display: block; width: 100%; height: auto; }

.gloss {
  position: absolute; inset: 0;
  pointer-events: none;
  opacity: 0; transition: opacity .3s;
  mix-blend-mode: soft-light;
}
.tilting.active .gloss { opacity: 1; }

.seal-text, .seal-tier {
  font-family: var(--font-mono);
  font-size: 15px; font-weight: 600; letter-spacing: .06em;
  fill: #14110e;
}
.seal-tier { font-size: 16px; letter-spacing: .02em; }
.seal-tier.solo { font-size: 26px; letter-spacing: .04em; }

.label {
  font-family: var(--font-body);
  font-size: 20px; font-weight: 600; letter-spacing: -.01em;
  fill: var(--ink);
}
.brand {
  font-family: var(--font-mono);
  font-size: 12px; font-weight: 600; letter-spacing: .22em;
  fill: var(--muted);
}
.serial {
  font-family: var(--font-mono);
  font-size: 12px; letter-spacing: .04em;
  fill: var(--faint);
}

/* 鋁膜高光緩慢橫掃，幅度刻意小 —— 重點是材質感不是閃 */
@media (prefers-reduced-motion: no-preference) {
  .mylar { animation: pack-mylar 8s ease-in-out infinite alternate; }
}
@keyframes pack-mylar {
  from { transform: translateX(-30px); }
  to   { transform: translateX(150px); }
}
.opened .mylar { animation: none; opacity: .3; }

@media (prefers-reduced-motion: reduce) {
  .plane { transition: none; transform: none !important; }
  .gloss { display: none; }
}
</style>
