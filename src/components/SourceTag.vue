<script setup lang="ts">
/**
 * 「這一筆是哪來的」徽章。
 *
 * 為什麼需要它：出貨與結算頁把兩種來源混成一份清單（抽卡池被抽走的卡、
 * 市場成交需寄送的卡），而**兩邊的出貨流程與時限不一樣** ——
 * 池是買家申請後 72 小時出貨、7 天鑑賞期、14 天寄存確認；
 * 市場託管是成交後 72 小時出貨、14 天送達、7 天驗收。
 * 混在一起而不標示，賣家會拿其中一套規則去套另一種卡。
 *
 * 不靠顏色單獨表意：每一顆都帶文字，色塊只是加速辨識。
 * 圖示用 inline SVG 不用 emoji —— emoji 在各家系統上長得不一樣，
 * 而且在手機上會被算成彩色圖片破壞整行的基線。
 */
const props = defineProps<{ src: 'pool' | 'market' }>()

const LABEL = { pool: '抽卡池', market: '市場成交' } as const
const label = LABEL[props.src]
</script>

<template>
  <span class="srcTag" :class="src">
    <!-- 池＝一疊卡；市場＝價格標籤。兩個輪廓在小尺寸下也分得出來 -->
    <svg v-if="src === 'pool'" class="srcIco" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.6" y="4.2" width="7" height="9.2" rx="1.4" fill="none"
            stroke="currentColor" stroke-width="1.3" />
      <path d="M6.4 2.6h5.1a1.4 1.4 0 0 1 1.4 1.4v7.6" fill="none"
            stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
    <svg v-else class="srcIco" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8.3 2.2H13a.8.8 0 0 1 .8.8v4.7L7.6 13.9a.9.9 0 0 1-1.3 0L2.4 10a.9.9 0 0 1 0-1.3z"
            fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
      <circle cx="10.9" cy="5.1" r="1.05" fill="currentColor" />
    </svg>
    {{ label }}
  </span>
</template>

<style scoped>
.srcTag {
  display: inline-flex; align-items: center; gap: 4px;
  /* baseline 對齊：這顆常常跟一行文字並排，用 inline-flex 預設會沉下去 */
  vertical-align: middle;
  font-size: 10.5px; font-weight: 700; line-height: 1.4;
  padding: 3px 8px; border-radius: var(--pill);
  white-space: nowrap; flex: none;
}
.srcIco { width: 11px; height: 11px; flex: none; }

/* 兩種來源給兩組完全不同的色相，而不是同一色的深淺 ——
   深淺在小尺寸與低對比螢幕上分不出來，而分不出來就是這顆徽章沒有作用 */
.srcTag.pool { background: var(--warn-wash); color: var(--gold); }
.srcTag.market { background: var(--info-wash); color: var(--info-ink); }
</style>
