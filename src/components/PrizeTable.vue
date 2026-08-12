<script setup lang="ts">
import type { Pool } from '@/types/models'
import TierBadge from './TierBadge.vue'
import CertTag from './CertTag.vue'
defineProps<{ pool: Pool }>()
</script>

<template>
  <div class="table card">
    <div class="thead">
      <span>賞別</span><span>卡片</span><span>鑑定</span><span class="num">剩餘</span>
    </div>
    <div v-for="p in pool.prizes" :key="p.id" class="trow" :class="{ empty: p.remaining === 0, bust: p.tier === 'BUST' }">
      <TierBadge :tier="p.tier" />
      <!-- 爆賞不是獎品，是「抽到就歸零」的陷阱籤，不顯示卡片資訊 -->
      <div class="name" v-if="p.tier === 'BUST'">
        <strong>抽中即沒收暫持獎品，改發保底卡</strong>
        <span class="muted set">保底：{{ p.card.name }}（市值 {{ p.card.refPrice.toLocaleString() }}）· 沒收的卡片流入賣家下一波獎池</span>
      </div>
      <div class="name" v-else>
        <strong>{{ p.card.name }}</strong>
        <span class="mono muted set">{{ p.card.setCode }} · {{ p.card.cardNo }} · {{ p.card.language }}</span>
      </div>
      <CertTag v-if="p.tier !== 'BUST'" :card="p.card" />
      <span v-else></span>
      <span class="num mono" :class="{ zero: p.remaining === 0 }">{{ p.remaining }} / {{ p.total }}</span>
    </div>
  </div>
</template>

<style scoped>
.table { overflow: hidden; }
.thead, .trow {
  display: grid;
  grid-template-columns: 84px 1fr auto 90px;
  gap: 14px; align-items: center;
  padding: 12px 18px;
}
.thead { font-size: 12px; color: var(--faint); border-bottom: 1px solid var(--line-soft); }
.trow { border-bottom: 1px solid var(--line-soft); }
/* grid 項目預設 stretch，膠囊徽章會被撐滿整欄 */
.trow > :deep(.tier), .trow > :deep(.cert) { justify-self: start; }
.trow:last-child { border-bottom: 0; }
.trow.empty { opacity: .42; }
.trow.bust { background: color-mix(in srgb, var(--danger) 6%, transparent); }
.name { display: flex; flex-direction: column; }
.name strong { font-size: 14px; }
.set { font-size: 11.5px; }
.num { text-align: right; font-size: 13.5px; }
.num.zero { color: var(--faint); }
@media (max-width: 720px) {
  .thead { display: none; }
  /* 兩列：賞別+卡名 / 鑑定+剩餘。cert 若擠在窄欄會換行成兩段 */
  .trow {
    grid-template-columns: auto 1fr;
    grid-auto-rows: auto;
    row-gap: 9px; column-gap: 10px;
    padding: 12px 14px;
  }
  .trow > :deep(.cert) { grid-row: 2; grid-column: 1; justify-self: start; white-space: nowrap; }
  .num { grid-row: 2; grid-column: 2; text-align: right; font-size: 13px; }
  .name strong { font-size: 13.5px; }
  .set { font-size: 11px; }
}
</style>
