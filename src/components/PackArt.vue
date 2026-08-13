<script setup lang="ts">
/**
 * 自製卡盒視覺 —— 完全不使用任何廠商素材。
 *
 * 從「平面卡包」改成「立體卡盒」的理由：
 *   平面袋只能用明暗『假裝』厚度，怎麼調都少一味。盒子有正面／側面／頂面
 *   三個真實的面，用 CSS transform-style: preserve-3d 疊起來就是真的立體 ——
 *   傾斜時側面與頂面會產生視差、面積真的改變，那是漸層模擬不出來的。
 *
 * 預設就帶一個靜止傾角（rotateX 8° / rotateY -18°），所以不用互動、
 * 不用滑鼠，一眼就看得出是個盒子。游標移上去再疊加微幅傾斜。
 *
 * 品牌上維持「封存」：正面橫貼一條防拆封條，承諾雜湊直接印在上面 ——
 * 撕開就破壞，跟「開賣前就已封存、事後可驗算」是同一個語意。
 *
 * 尺寸全部用 cqw（容器查詢單位），所以從 88px 縮圖到滿版都同一套幾何。
 */
import { computed } from 'vue'
import type { Tier } from '@/types/models'
import { useTilt } from '@/composables/useTilt'

const props = withDefaults(defineProps<{
  tier?: Tier
  label?: string
  serial?: string
  hash?: string
  /** 已開封：封條斷開、盒蓋掀起一角 */
  opened?: boolean
  /** 縮圖模式：拿掉小字，只留封條與封緘 */
  compact?: boolean
  /** 關掉游標傾斜（長列表裡不要整片一起晃），靜止傾角仍保留 */
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
const uid = computed(() => `bx${props.tier}${(props.serial || props.label || 'vd').replace(/\W/g, '')}`)

// 9 度 —— 疊在靜止傾角上，要的是「微」而不是甩
const { el, rx, ry, gx, gy, active, onMove, reset } = useTilt(9)

/** 靜止傾角：不互動也看得出立體 */
const REST_X = 8, REST_Y = -18

const boxTransform = computed(() => {
  const x = REST_X + (props.flat ? 0 : rx.value)
  const y = REST_Y + (props.flat ? 0 : ry.value)
  return `rotateX(${x}deg) rotateY(${y}deg)`
})
</script>

<template>
  <div
    class="stage"
    :class="{ opened, tilting: !flat, active }"
    @pointermove="flat || onMove($event)"
    @pointerleave="flat || reset()"
  >
    <div ref="el" class="box" :style="{ transform: boxTransform }">
      <!-- 頂面（盒蓋上緣） -->
      <div class="face top">
        <span class="top-foil" :style="{ background: foil }"></span>
      </div>

      <!-- 右側面 -->
      <div class="face side">
        <span class="side-stripe" :style="{ background: foil }"></span>
        <span class="side-text">VAULTDRAW</span>
      </div>

      <!-- 正面 -->
      <div class="face front">
        <svg viewBox="0 0 300 400" role="img"
             :aria-label="label ? `${label} 卡盒` : '卡盒'">
          <defs>
            <linearGradient :id="`${uid}-card`" x1="0" y1="0" x2="0.35" y2="1">
              <stop offset="0%" stop-color="var(--surface-3)" />
              <stop offset="45%" stop-color="var(--surface)" />
              <stop offset="100%" stop-color="var(--bg)" />
            </linearGradient>

            <!-- 防拆封條：賞別色箔面 -->
            <linearGradient :id="`${uid}-seal`" x1="0" y1="0" x2="1" y2="0.4">
              <stop offset="0%" :stop-color="foil" stop-opacity=".5" />
              <stop offset="32%" :stop-color="foil" stop-opacity="1" />
              <stop offset="50%" stop-color="#fff" stop-opacity=".95" />
              <stop offset="68%" :stop-color="foil" stop-opacity="1" />
              <stop offset="100%" :stop-color="foil" stop-opacity=".45" />
            </linearGradient>

            <radialGradient :id="`${uid}-orb`">
              <stop offset="0%" :stop-color="foil" stop-opacity=".46" />
              <stop offset="42%" :stop-color="foil" stop-opacity=".16" />
              <stop offset="100%" :stop-color="foil" stop-opacity="0" />
            </radialGradient>

            <!-- 正面受光：左上亮、右下沉，配合盒子的靜止傾角 -->
            <linearGradient :id="`${uid}-lit`" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#fff" stop-opacity=".08" />
              <stop offset="42%" stop-color="#fff" stop-opacity="0" />
              <stop offset="100%" stop-color="#000" stop-opacity=".35" />
            </linearGradient>
          </defs>

          <rect x="0" y="0" width="300" height="400" :fill="`url(#${uid}-card)`" />
          <circle cx="150" :cy="compact ? 210 : 196" r="112" :fill="`url(#${uid}-orb)`" />

          <!-- 盒蓋接縫 -->
          <path d="M0 96 H300" stroke="#000" stroke-opacity=".5" stroke-width="2" />
          <path d="M0 98.5 H300" stroke="#fff" stroke-opacity=".08" stroke-width="1" />

          <!-- 防拆封條，橫跨接縫 -->
          <g :opacity="opened ? .35 : 1">
            <rect x="0" y="72" width="300" height="48" :fill="`url(#${uid}-seal)`" />
            <path d="M0 72 H300" stroke="#fff" stroke-opacity=".5" />
            <path d="M0 120 H300" stroke="#000" stroke-opacity=".35" />
            <!-- 封條上的細鋸齒撕線 -->
            <path d="M0 96 H300" stroke="#000" stroke-opacity=".28"
                  stroke-width="1" stroke-dasharray="3 4" />
            <text v-if="hashChip && !compact" class="seal-text" x="20" y="102">封存 {{ hashChip }}</text>
            <text
              class="seal-tier" :class="{ solo: compact }"
              :x="compact ? 150 : 280" y="102"
              :text-anchor="compact ? 'middle' : 'end'"
            >{{ tierLabel }}</text>
          </g>

          <!-- 火漆封緘 -->
          <g :transform="`translate(150 ${compact ? 210 : 196})${compact ? ' scale(1.35)' : ''}`"
             :opacity="opened ? .3 : 1">
            <path d="M0 -48 L42 -24 L42 24 L0 48 L-42 24 L-42 -24 Z"
                  fill="var(--bg)" fill-opacity=".5" :stroke="foil" stroke-width="2" />
            <path d="M0 -35 L30 -17.5 L30 17.5 L0 35 L-30 17.5 L-30 -17.5 Z"
                  fill="none" stroke="#fff" stroke-opacity=".14" />
            <path d="M-14 -13 L0 18 L14 -13" fill="none" :stroke="foil"
                  stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
          </g>

          <template v-if="!compact">
            <text v-if="label" class="label" x="150" y="296" text-anchor="middle">{{ label }}</text>
            <g transform="translate(0 322)">
              <path d="M26 0 H182 L194 12 V34 H26 Z" fill="#0b0a0c" fill-opacity=".9" />
              <path d="M26 0 H182 L194 12 V34 H26 Z" fill="none" :stroke="foil"
                    stroke-opacity=".45" />
              <text class="brand" x="40" y="23">VAULTDRAW</text>
              <template v-if="serial">
                <rect x="198" y="0" width="76" height="34" :fill="foil" opacity=".9" />
                <text class="serial" x="236" y="23" text-anchor="middle">{{ serial.slice(-7) }}</text>
              </template>
            </g>
          </template>

          <!-- 受光疊在最上層 -->
          <rect x="0" y="0" width="300" height="400" :fill="`url(#${uid}-lit)`" />
        </svg>

        <span
          v-if="!flat" class="gloss" aria-hidden="true"
          :style="{ background: `radial-gradient(42% 32% at ${gx}% ${gy}%, rgba(255,255,255,.3), transparent 72%)` }"
        ></span>
      </div>

      <!-- 地面投影：跟著盒子一起轉，維持接地感 -->
      <div class="shadow"></div>
    </div>
  </div>
</template>

<style scoped>
/* cqw 讓整個幾何跟著容器寬度縮放 —— 88px 縮圖與滿版共用同一套數字 */
.stage {
  container-type: inline-size;
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1.24;
  perspective: 90cqw;
  perspective-origin: 50% 42%;
}

.box {
  position: absolute;
  /* 側面與頂面要佔空間，所以正面本身不能滿版 */
  left: 6cqw; top: 9cqw;
  width: 74cqw; height: 98cqw;
  transform-style: preserve-3d;
  transition: transform .5s cubic-bezier(.2, .7, .3, 1);
}
.tilting.active .box { transition: transform .08s linear; }

.face { position: absolute; backface-visibility: hidden; }

/* 正面 */
.front {
  inset: 0;
  overflow: hidden;
  border-radius: 1.2cqw;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .09);
}
.front svg { display: block; width: 100%; height: 100%; }

/* 右側面：由正面右緣向後轉 90° */
.side {
  left: 100%; top: 0;
  width: 17cqw; height: 100%;
  transform-origin: 0 50%;
  transform: rotateY(90deg);
  background: linear-gradient(90deg, var(--surface-2), var(--bg) 70%);
  box-shadow: inset 1px 0 0 rgba(255, 255, 255, .07);
  border-radius: 0 1.2cqw 1.2cqw 0;
  overflow: hidden;
}
/* 對齊正面封條（y 72→120 於 400 高 = 18%→30%）。
   數字不一致的話，封條繞到側面就會錯開一截，立體感立刻破功。 */
.side-stripe {
  position: absolute; left: 0; right: 0; top: 18%;
  height: 12%;
  opacity: .9;
}
.side-text {
  position: absolute; left: 50%; top: 58%;
  transform: translate(-50%, -50%) rotate(90deg);
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 3.2cqw; font-weight: 700; letter-spacing: .28em;
  color: var(--faint);
}

/* 頂面：由正面上緣向後轉 90° */
.top {
  left: 0; bottom: 100%;
  width: 100%; height: 17cqw;
  transform-origin: 50% 100%;
  transform: rotateX(90deg);
  background: linear-gradient(180deg, var(--bg), var(--surface-2));
  box-shadow: inset 0 -1px 0 rgba(255, 255, 255, .08);
  border-radius: 1.2cqw 1.2cqw 0 0;
  overflow: hidden;
}
.top-foil {
  position: absolute; left: 0; right: 0; bottom: 0;
  height: 34%;
  opacity: .8;
}
/* 已開封：盒蓋掀起 */
.opened .top { transform: rotateX(58deg); transform-origin: 50% 100%; }

/* 投影躺在盒子底部，跟著 3D 一起轉 */
.shadow {
  position: absolute;
  left: -6%; right: -14%; top: 100%;
  height: 26cqw;
  transform-origin: 50% 0;
  transform: rotateX(90deg) translateZ(-8cqw);
  background: radial-gradient(closest-side, rgba(0, 0, 0, .62), transparent 78%);
  filter: blur(1.5cqw);
  pointer-events: none;
}

.gloss {
  position: absolute; inset: 0;
  pointer-events: none;
  opacity: 0; transition: opacity .3s;
  mix-blend-mode: soft-light;
}
.tilting.active .gloss { opacity: 1; }

/* 封條與序號塊都是亮色底，字必須近黑 */
.seal-text, .seal-tier {
  font-family: var(--font-mono);
  font-size: 16px; font-weight: 700; letter-spacing: .05em;
  fill: #14110e;
}
.seal-tier { letter-spacing: .02em; }
/* 縮圖時正面只算繪到約 62px 寬，而 viewBox 是 300 單位 —— 縮放比約 0.21。
   28px 會變成螢幕上的 5.8px，根本讀不到；40px 才有約 8.8px，
   剛好塞得進 10.5px 高的封條。 */
.seal-tier.solo { font-size: 40px; }
.serial {
  font-family: var(--font-mono);
  font-size: 13px; font-weight: 700;
  fill: #14110e;
}
/* 盒面在兩個主題下都是深色，所以字固定用亮色 */
.label {
  font-family: var(--font-body);
  font-size: 21px; font-weight: 600; letter-spacing: -.01em;
  fill: #fff;
}
.brand {
  font-family: var(--font-mono);
  font-size: 13px; font-weight: 700; letter-spacing: .2em;
  fill: #efeae4;
}

@media (prefers-reduced-motion: reduce) {
  .box { transition: none; }
  .gloss { display: none; }
}
</style>
