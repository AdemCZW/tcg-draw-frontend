<script setup lang="ts">
/**
 * 池的獎項表。
 *
 * 「買回價」這一欄是刻意放在**抽卡之前**的頁面上的 ——
 * 抽完才知道能買回多少就是釣魚。這個數字是賣家在開賣前宣告、
 * 寫進公平性承諾鎖死的金額，不是市值的某個比例。
 *
 * 卡片市值那一段改稱「賣家標示」：它是賣家自己填的、沒有外部依據，
 * 不參與任何金額計算（docs/HANDOFF.md 4.1）。
 */
import type { Pool } from '@/types/models'
import TierBadge from './TierBadge.vue'
import CertTag from './CertTag.vue'
import PsaBadge from './PsaBadge.vue'
import { refPriceText } from '@/lib/refprice'
defineProps<{ pool: Pool }>()
</script>

<template>
  <div class="table card">
    <div class="thead">
      <span>賞別</span><span>卡片</span><span>鑑定</span>
      <span class="num">買回價</span><span class="num">剩餘</span>
    </div>
    <div v-for="p in pool.prizes" :key="p.id" class="trow" :class="{ empty: p.remaining === 0, bust: p.tier === 'BUST' }">
      <TierBadge :tier="p.tier" />
      <!-- 爆賞不是獎品，是「抽到就歸零」的陷阱籤，不顯示卡片資訊 -->
      <div class="name" v-if="p.tier === 'BUST'">
        <strong>抽中即沒收暫持獎品，改發保底卡</strong>
        <span class="muted set">保底：{{ p.card.name }}（賣家標示參考價 {{ refPriceText(p.card.refPrice) }}）· 沒收的卡片流入賣家下一波獎池</span>
      </div>
      <div class="name" v-else>
        <strong>{{ p.card.name }}</strong>
        <span class="mono muted set">{{ p.card.setCode }} · {{ p.card.cardNo }} · {{ p.card.language }}</span>
        <!-- 鑑定卡的 PSA 查證狀態。verified 連到 PSA 官網讓買家自己對；
             pending 是「暫時無法驗證」，目前 API 待核准多半落在這裡。
             沒有 certNo 的生卡不顯示（psaStatus 是 null）。 -->
        <PsaBadge :status="p.card.psaStatus" :cert-no="p.card.certNo" :grade="p.card.grade" />
      </div>
      <CertTag v-if="p.tier !== 'BUST'" :card="p.card" />
      <span v-else></span>
      <!-- 沒有宣告買回價的舊池顯示「—」，不要顯示 0：0 讀起來像「買回價是零元」，
           而事實是「這個池從來沒有做過這個承諾」。 -->
      <span class="num mono buy" :class="{ none: p.buyback == null }">
        {{ p.buyback == null ? '—' : p.buyback.toLocaleString() }}
      </span>
      <span class="num mono" :class="{ zero: p.remaining === 0 }">{{ p.remaining }} / {{ p.total }}</span>
    </div>
  </div>
</template>

<style scoped>
.table { overflow: hidden; }
.thead, .trow {
  display: grid;
  /* minmax(0, 1fr) 不是 1fr：grid 子元素預設 min-width: auto，
     長卡名會把整列撐爆（見 docs/HANDOFF.md 2.1） */
  grid-template-columns: 84px minmax(0, 1fr) auto 92px 88px;
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
.buy { font-weight: 600; }
.buy.none { color: var(--faint); font-weight: 400; }
@media (max-width: 720px) {
  .thead { display: none; }
  /* 三列：賞別+卡名 / 鑑定+剩餘 / 買回價（整行）。
     買回價自己一行不是排版偷懶 —— 它是這張表在抽卡前最重要的數字，
     擠在剩餘旁邊會變成一個看不到的小字。cert 若擠在窄欄會換行成兩段。 */
  .trow {
    grid-template-columns: auto minmax(0, 1fr);
    grid-auto-rows: auto;
    row-gap: 9px; column-gap: 10px;
    padding: 12px 14px;
  }
  .trow > :deep(.cert) { grid-row: 2; grid-column: 1; justify-self: start; white-space: nowrap; }
  .num { grid-row: 2; grid-column: 2; text-align: right; font-size: 13px; }
  .buy { grid-row: 3; grid-column: 1 / 3; text-align: left; }
  .buy::before {
    content: '買回價　';
    font-weight: 400; font-size: 11.5px; color: var(--muted);
  }
  .name strong { font-size: 13.5px; }
  .set { font-size: 11px; }
}
</style>
