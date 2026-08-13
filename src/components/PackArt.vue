<script setup lang="ts">
/**
 * 自製卡包視覺 —— 完全不使用任何廠商素材。
 *
 * 精緻度的來源（拆解 gacha.game 的實體卡包版型後補上的）：
 *  1. 明亮的金屬熱封帶 —— 不是暗色，是會反光的鋁箔，帶橫向壓紋與兩端星芒
 *  2. 縱向皺褶高光    —— 鋁膜之所以讀起來像鋁膜，就是靠這幾道不規則的直向反光
 *  3. 中央發光體      —— 徽章後面襯一顆賞別色的光球，撐起構圖重心
 *  4. 設計過的品牌牌  —— 切角黑牌配反白序號塊，而不是一行裸字
 *  5. 圓柱受光        —— 裡面裝了卡會鼓起，左右壓暗給出體積
 *
 * 刻意沒有做 AI 繪製的星雲背景 —— 那是他們的視覺語言，不是 VaultDraw 的。
 * 這裡的豐富度全部由光學細節堆出來，主體維持「封存」的克制調性。
 *
 * 微 3D：SVG 內的明暗給靜態體積，外層 perspective + rotate 隨游標傾斜。
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
  opened?: boolean
  compact?: boolean
  /** 關掉游標傾斜（長列表裡不要整片一起晃） */
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
const tierLabel = computed(() =>
  props.tier === 'LAST' ? '最後賞' : props.tier === 'BUST' ? '爆賞' : `${props.tier} 賞`
)

const phase = computed(() => {
  let h = 0
  for (const ch of props.serial || props.label || 'VD') h = (h * 31 + ch.charCodeAt(0)) % 997
  return h
})
const uid = computed(() => `pk${phase.value}${props.tier}`)

// 9 度 —— 要的是「微」3D，角度大了會像在甩卡
const { el, rx, ry, gx, gy, active, onMove, reset } = useTilt(9)

const W = 300, H = 540
const X0 = 14, X1 = 286
const TEETH = 26
const TOOTH = (X1 - X0) / TEETH

function zigzag(fromX: number, toX: number, valleyY: number, peakY: number) {
  const step = TOOTH * (toX > fromX ? 1 : -1)
  let d = ''
  for (let i = 0; i < TEETH; i++) {
    const x = fromX + step * i
    d += ` L${(x + step / 2).toFixed(1)} ${peakY} L${(x + step).toFixed(1)} ${valleyY}`
  }
  return d
}

const outline = computed(() =>
  `M${X0} 30` + zigzag(X0, X1, 30, 16) + ` L${X1} 510` + zigzag(X1, X0, 510, 524) + ' Z'
)

/**
 * 縱向皺褶。位置與寬度由 phase 決定 —— 每個包的皺法不同但可重現。
 * 寬度刻意不一致：等距等寬會讀成條紋圖案，而不是揉過的膜。
 */
const wrinkles = computed(() => {
  const seeded = (n: number) => ((phase.value * 7919 + n * 104729) % 1000) / 1000
  // 只留 4 道。等距等寬會讀成「金色直條紋」而不是揉過的膜 ——
  // 位置抖動要大於間距的一半，寬度差距要明顯，並各自輕微傾斜。
  return [0, 1, 2, 3].map(i => {
    const t = seeded(i)
    const u = seeded(i + 11)
    return {
      x: 24 + i * 62 + (t - 0.5) * 54,
      w: 4 + u * 16,
      o: 0.04 + t * 0.07,
      skew: (u - 0.5) * 5
    }
  })
})

/** 四角星芒：熱封帶兩端各一顆，是整個包反光最強的點 */
const SPARK = 'M0 -7 Q1.2 -1.2 7 0 Q1.2 1.2 0 7 Q-1.2 1.2 -7 0 Q-1.2 -1.2 0 -7 Z'
const BANDS = [16, 476]
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
          <!-- 金屬壓紋：疊在賞別色上做出鋁箔的明暗條帶 -->
          <linearGradient :id="`${uid}-metal`" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#000" stop-opacity=".45" />
            <stop offset="14%" stop-color="#fff" stop-opacity=".75" />
            <stop offset="30%" stop-color="#000" stop-opacity=".28" />
            <stop offset="46%" stop-color="#fff" stop-opacity=".55" />
            <stop offset="62%" stop-color="#000" stop-opacity=".3" />
            <stop offset="78%" stop-color="#fff" stop-opacity=".42" />
            <stop offset="100%" stop-color="#000" stop-opacity=".5" />
          </linearGradient>

          <linearGradient :id="`${uid}-seal`" x1="0" y1="0" x2="1" y2="0.35">
            <stop offset="0%" :stop-color="foil" stop-opacity=".45" />
            <stop offset="34%" :stop-color="foil" stop-opacity="1" />
            <stop offset="52%" stop-color="#fff" stop-opacity=".95" />
            <stop offset="68%" :stop-color="foil" stop-opacity="1" />
            <stop offset="100%" :stop-color="foil" stop-opacity=".4" />
          </linearGradient>

          <linearGradient :id="`${uid}-body`" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--surface-3)" />
            <stop offset="40%" stop-color="var(--surface)" />
            <stop offset="100%" stop-color="var(--bg)" />
          </linearGradient>

          <radialGradient :id="`${uid}-orb`">
            <stop offset="0%" :stop-color="foil" stop-opacity=".5" />
            <stop offset="38%" :stop-color="foil" stop-opacity=".2" />
            <stop offset="72%" :stop-color="foil" stop-opacity=".05" />
            <stop offset="100%" :stop-color="foil" stop-opacity="0" />
          </radialGradient>

          <!-- 單道皺褶的截面：偏一側亮、另一側收掉，像折起來的稜線 -->
          <linearGradient :id="`${uid}-wr`" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#fff" stop-opacity="0" />
            <stop offset="45%" stop-color="#fff" stop-opacity="1" />
            <stop offset="58%" stop-color="#fff" stop-opacity=".35" />
            <stop offset="100%" stop-color="#fff" stop-opacity="0" />
          </linearGradient>

          <linearGradient :id="`${uid}-round`" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#000" stop-opacity=".5" />
            <stop offset="10%" stop-color="#000" stop-opacity=".22" />
            <stop offset="30%" stop-color="#fff" stop-opacity=".06" />
            <stop offset="46%" stop-color="#fff" stop-opacity=".11" />
            <stop offset="62%" stop-color="#fff" stop-opacity=".05" />
            <stop offset="80%" stop-color="#000" stop-opacity=".2" />
            <stop offset="100%" stop-color="#000" stop-opacity=".52" />
          </linearGradient>

          <radialGradient :id="`${uid}-vig`" cx="0.5" cy="0.42" r="0.72">
            <stop offset="55%" stop-color="#000" stop-opacity="0" />
            <stop offset="100%" stop-color="#000" stop-opacity=".55" />
          </radialGradient>

          <clipPath :id="`${uid}-clip`"><path :d="outline" /></clipPath>
        </defs>

        <path :d="outline" :fill="`url(#${uid}-body)`" />

        <g :clip-path="`url(#${uid}-clip)`">
          <!-- 中央光球：構圖重心 -->
          <circle cx="150" :cy="compact ? 300 : 286" r="130" :fill="`url(#${uid}-orb)`" />

          <!-- 縱向皺褶高光 -->
          <g class="wrinkles">
            <rect
              v-for="(w, i) in wrinkles" :key="i"
              :x="w.x" y="-30" :width="w.w" height="600"
              :fill="`url(#${uid}-wr)`" :opacity="w.o"
              :transform="`skewX(${w.skew})`"
            />
          </g>

          <rect x="0" y="0" :width="W" :height="H" :fill="`url(#${uid}-vig)`" />

          <!-- 熱封帶：賞別色打底 + 金屬壓紋 + 兩端星芒 -->
          <g v-for="y in BANDS" :key="y">
            <rect :x="X0" :y="y" :width="X1 - X0" height="48" :fill="foil" opacity=".85" />
            <rect :x="X0" :y="y" :width="X1 - X0" height="48" :fill="`url(#${uid}-metal)`" />
            <g stroke="#000" stroke-opacity=".28" stroke-width="1">
              <path v-for="n in 5" :key="n" :d="`M${X0} ${y + n * 8} H${X1}`" />
            </g>
            <g fill="#fff" fill-opacity=".85">
              <path :transform="`translate(30 ${y + 24})`" :d="SPARK" />
              <path :transform="`translate(270 ${y + 24})`" :d="SPARK" />
            </g>
          </g>

          <!-- 封條 -->
          <g :opacity="opened ? .4 : 1">
            <rect :x="X0" y="104" :width="X1 - X0" height="46" :fill="`url(#${uid}-seal)`" />
            <path :d="`M${X0} 104 H${X1}`" stroke="#fff" stroke-opacity=".5" stroke-width="1" />
            <path :d="`M${X0} 150 H${X1}`" stroke="#000" stroke-opacity=".35" stroke-width="1" />
            <text v-if="hashChip && !compact" class="seal-text" x="30" y="133">封存 {{ hashChip }}</text>
            <text
              class="seal-tier" :class="{ solo: compact }"
              :x="compact ? 150 : 270" y="133"
              :text-anchor="compact ? 'middle' : 'end'"
            >{{ tierLabel }}</text>
          </g>

          <!-- 火漆封緘 -->
          <g :transform="`translate(150 ${compact ? 300 : 286})${compact ? ' scale(1.4)' : ''}`"
             :opacity="opened ? .3 : 1">
            <path d="M0 -52 L45 -26 L45 26 L0 52 L-45 26 L-45 -26 Z"
                  fill="var(--bg)" fill-opacity=".55" :stroke="foil" stroke-width="2" />
            <path d="M0 -38 L33 -19 L33 19 L0 38 L-33 19 L-33 -19 Z"
                  fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="1" />
            <path d="M-15 -14 L0 19 L15 -14" fill="none" :stroke="foil"
                  stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" />
          </g>

          <template v-if="!compact">
            <text v-if="label" class="label" x="150" y="398" text-anchor="middle">{{ label }}</text>

            <!-- 品牌牌：右上切角黑牌 + 反白序號塊 -->
            <g transform="translate(0 430)">
              <path d="M40 0 H196 L208 12 V34 H40 Z" fill="#0b0a0c" fill-opacity=".92" />
              <path d="M40 0 H196 L208 12 V34 H40 Z" fill="none" :stroke="foil"
                    stroke-opacity=".45" stroke-width="1" />
              <text class="brand" x="54" y="23">VAULTDRAW</text>
              <template v-if="serial">
                <rect x="212" y="0" width="64" height="34" :fill="foil" opacity=".9" />
                <text class="serial" x="244" y="23" text-anchor="middle">{{ serial.slice(-7) }}</text>
              </template>
            </g>
          </template>

          <!-- 圓柱受光最後整片蓋上，印刷跟著袋身一起彎 -->
          <rect x="0" y="0" :width="W" :height="H" :fill="`url(#${uid}-round)`" />
        </g>

        <!-- 外緣極細亮邊，把袋子從背景切出來 -->
        <path :d="outline" fill="none" stroke="#fff" stroke-opacity=".1" stroke-width="1" />
      </svg>

      <span
        v-if="!flat" class="gloss" aria-hidden="true"
        :style="{ background: `radial-gradient(40% 30% at ${gx}% ${gy}%, rgba(255,255,255,.32), transparent 72%)` }"
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
  filter: drop-shadow(0 16px 26px rgba(0, 0, 0, .6));
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

/* 封條與序號塊都是亮色底，字必須用近黑 */
.seal-text, .seal-tier {
  font-family: var(--font-mono);
  font-size: 15px; font-weight: 700; letter-spacing: .06em;
  fill: #14110e;
}
.seal-tier { font-size: 16px; letter-spacing: .02em; }
.seal-tier.solo { font-size: 26px; letter-spacing: .04em; }
.serial {
  font-family: var(--font-mono);
  font-size: 11.5px; font-weight: 700; letter-spacing: .02em;
  fill: #14110e;
}

/* 袋面上的字固定用亮色 —— 袋身兩個主題下都是深的 */
.label {
  font-family: var(--font-body);
  font-size: 20px; font-weight: 600; letter-spacing: -.01em;
  fill: #fff;
}
.brand {
  font-family: var(--font-mono);
  font-size: 12.5px; font-weight: 700; letter-spacing: .2em;
  fill: #efeae4;
}

/* 皺褶極緩慢橫向呼吸，只是讓膜面不死板 */
@media (prefers-reduced-motion: no-preference) {
  .wrinkles { animation: pack-breathe 9s ease-in-out infinite alternate; }
}
@keyframes pack-breathe {
  from { transform: translateX(-5px); }
  to   { transform: translateX(7px); }
}
.opened .wrinkles { animation: none; opacity: .45; }

@media (prefers-reduced-motion: reduce) {
  .plane { transition: none; transform: none !important; }
  .gloss { display: none; }
}
</style>
