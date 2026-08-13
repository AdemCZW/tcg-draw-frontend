<script setup lang="ts">
/**
 * 自製卡包視覺 —— 完全不使用任何廠商素材。
 *
 * 設計方向刻意不做「糖果紙式的閃亮包裝」，而是做成「封存的保管袋」：
 * 撕口虛線、防偽底紋、火漆封緘、序號與承諾雜湊片段。
 *
 * 理由有兩個：
 *  1. 版權 —— 卡包外觀是這個平台唯一能百分之百自有的視覺資產
 *  2. 品牌 —— 站上的核心主張是「開賣前就已封存」。把承諾雜湊直接印在
 *     包裝上，讓視覺與機制指向同一件事，而不是兩套各說各話的語言。
 *
 * 純 SVG：任何尺寸都不會糊，也不需要再多一次網路請求。
 */
import { computed } from 'vue'
import type { Tier } from '@/types/models'

const props = withDefaults(defineProps<{
  /** 決定封條與燙金的顏色 */
  tier?: Tier
  /** 包裝正面的標題，通常是池名或賞別 */
  label?: string
  /** 序號，顯示在底部。給 undefined 就不顯示 */
  serial?: string
  /** 承諾雜湊，只取前段印在封條上 */
  hash?: string
  /** 撕開後的狀態：封條斷開、上緣撕口參差 */
  opened?: boolean
  /**
   * 縮圖模式。88px 以下時標題與序號會縮到 3–4px，只是一團糊字，
   * 不如整組拿掉、把封緘放大，賞別與品牌仍然一眼可辨。
   */
  compact?: boolean
}>(), {
  tier: 'D',
  label: '',
  serial: '',
  hash: '',
  opened: false,
  compact: false
})

const TIER_VAR: Record<Tier, string> = {
  A: '--tier-a', B: '--tier-b', C: '--tier-c',
  D: '--tier-d', LAST: '--tier-last', BUST: '--faint'
}
const foil = computed(() => `var(${TIER_VAR[props.tier]})`)

/** 承諾雜湊只印前 10 碼 —— 夠辨識，又不會擠滿封條 */
const hashChip = computed(() => (props.hash ? props.hash.slice(0, 10).toUpperCase() : ''))

/* 防偽紋的相位由序號決定，讓每個包的紋路略有差異但可重現。
   純視覺用途，不參與任何抽選邏輯。 */
const phase = computed(() => {
  let h = 0
  for (const ch of props.serial || props.label || 'VD') h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
})

const uid = computed(() => `pk${phase.value}${props.tier}`)
</script>

<template>
  <svg
    class="pack" :class="{ opened }"
    viewBox="0 0 300 420" role="img"
    :aria-label="label ? `${label} 卡包` : '卡包'"
  >
    <defs>
      <!-- 燙金封條：賞別色往兩端收暗，做出金屬箔的反光帶 -->
      <linearGradient :id="`${uid}-foil`" x1="0" y1="0" x2="1" y2="0.35">
        <stop offset="0%" :stop-color="foil" stop-opacity=".55" />
        <stop offset="42%" :stop-color="foil" stop-opacity="1" />
        <stop offset="58%" stop-color="#ffffff" stop-opacity=".9" />
        <stop offset="72%" :stop-color="foil" stop-opacity="1" />
        <stop offset="100%" :stop-color="foil" stop-opacity=".5" />
      </linearGradient>

      <!-- 袋身：上緣略亮，模擬受光 -->
      <linearGradient :id="`${uid}-body`" x1="0" y1="0" x2="0.2" y2="1">
        <stop offset="0%" stop-color="var(--surface-3)" />
        <stop offset="55%" stop-color="var(--surface)" />
        <stop offset="100%" stop-color="var(--bg)" />
      </linearGradient>

      <!-- 流光。漸層必須是純水平（x2=1, y2=0）：
           預設的 objectBoundingBox 會把 (0,0)→(1,1) 正規化到矩形比例，
           在 120×480 這種細長矩形上對角線會被壓成近乎垂直，
           左右兩端就不淡出，掃過時在袋身上切出一條垂直硬邊。
           傾斜感改由外層 <g> 的 skewX 負責。 -->
      <linearGradient :id="`${uid}-sheen`" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#fff" stop-opacity="0" />
        <stop offset="50%" stop-color="#fff" stop-opacity=".08" />
        <stop offset="100%" stop-color="#fff" stop-opacity="0" />
      </linearGradient>

      <!-- 防偽底紋：極細斜線，密到不會被誤認為裝飾線條 -->
      <pattern :id="`${uid}-guilloche`" width="9" height="9"
               patternUnits="userSpaceOnUse" :patternTransform="`rotate(${phase % 30 + 20})`">
        <path d="M0 0 L0 9" stroke="var(--ink)" stroke-width=".5" stroke-opacity=".07" />
        <path d="M4.5 0 L4.5 9" stroke="var(--ink)" stroke-width=".3" stroke-opacity=".04" />
      </pattern>

      <clipPath :id="`${uid}-clip`">
        <rect x="14" y="14" width="272" height="392" rx="18" />
      </clipPath>
    </defs>

    <!-- 袋身 -->
    <rect x="14" y="14" width="272" height="392" rx="18" :fill="`url(#${uid}-body)`" />
    <g :clip-path="`url(#${uid}-clip)`">
      <rect x="14" y="14" width="272" height="392" :fill="`url(#${uid}-guilloche)`" />
      <g transform="skewX(-14)">
        <rect class="sheen" x="-160" y="-20" width="120" height="480" :fill="`url(#${uid}-sheen)`" />
      </g>
    </g>
    <rect x="14" y="14" width="272" height="392" rx="18"
          fill="none" stroke="var(--line)" stroke-width="1" />

    <!-- 上緣撕口：一排小齒 + 虛線，未開封時虛線完整 -->
    <g :clip-path="`url(#${uid}-clip)`">
      <path
        d="M14 62 h272"
        stroke="var(--line)" stroke-width="1.5"
        stroke-dasharray="7 6" :stroke-opacity="opened ? '.25' : '.6'"
      />
      <g fill="var(--bg)">
        <circle v-for="n in 14" :key="n" :cx="14 + n * 19" cy="62" r="2.4" />
      </g>
    </g>

    <!-- 燙金封條 -->
    <rect x="14" y="82" width="272" height="46" :fill="`url(#${uid}-foil)`" :opacity="opened ? .45 : 1" />
    <text v-if="hashChip && !compact" class="seal-text" x="30" y="111">封存 {{ hashChip }}</text>
    <text
      class="seal-tier" :class="{ solo: compact }"
      :x="compact ? 150 : 270" y="111"
      :text-anchor="compact ? 'middle' : 'end'"
    >{{ tier === 'LAST' ? '最後賞' : tier === 'BUST' ? '爆賞' : `${tier} 賞` }}</text>

    <!-- 火漆封緘：六角形內嵌 V 字 -->
    <g
      :transform="`translate(150 ${opened ? 232 : 236})${compact ? ' scale(1.5)' : ''}`"
      :opacity="opened ? .35 : 1"
    >
      <path
        d="M0 -46 L40 -23 L40 23 L0 46 L-40 23 L-40 -23 Z"
        fill="var(--surface-2)" :stroke="foil" stroke-width="1.6"
      />
      <path
        d="M0 -34 L30 -17 L30 17 L0 34 L-30 17 L-30 -17 Z"
        fill="none" stroke="var(--line)" stroke-width="1"
      />
      <path d="M-14 -13 L0 17 L14 -13" fill="none" :stroke="foil"
            stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" />
    </g>

    <!-- 標題 -->
    <template v-if="!compact">
      <text v-if="label" class="label" x="150" y="316" text-anchor="middle">{{ label }}</text>

      <!-- 底部：序號 + 品牌 -->
      <path d="M40 348 h220" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 4" />
      <text class="brand" x="40" y="376">VAULTDRAW</text>
      <text v-if="serial" class="serial" x="260" y="376" text-anchor="end">{{ serial }}</text>
    </template>
  </svg>
</template>

<style scoped>
.pack {
  display: block;
  width: 100%;
  height: auto;
}

/* 封條上的字要壓在燙金帶上，用深色才讀得到 —— 兩個主題皆然，
   因為燙金帶本身在兩個主題下都是亮色 */
.seal-text,
.seal-tier {
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: .06em;
  fill: #14110e;
}
.seal-tier { font-size: 16px; letter-spacing: .02em; }
/* 縮圖模式沒有其他文字搶版面，賞別可以放大到真正看得見 */
.seal-tier.solo { font-size: 24px; letter-spacing: .04em; }

.label {
  font-family: var(--font-body);
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -.01em;
  fill: var(--ink);
}
.brand {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .22em;
  fill: var(--muted);
}
.serial {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: .04em;
  fill: var(--faint);
}

/* 流光緩慢橫掃。這是唯一的動態，刻意做得很淡：
   包裝的重點是「封存感」，不是閃。 */
@media (prefers-reduced-motion: no-preference) {
  .sheen { animation: pack-sheen 7s linear infinite; }
}
@keyframes pack-sheen {
  from { transform: translateX(0); }
  to   { transform: translateX(440px); }
}
.opened .sheen { animation: none; opacity: 0; }
</style>
