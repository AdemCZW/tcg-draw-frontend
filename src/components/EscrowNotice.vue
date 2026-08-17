<script setup lang="ts">
// 資金托管說明。市集模式下玩家付的錢不會直接進賣家口袋，
// 這是「賣家跑路」風險的主要保護，必須在購買前就講清楚。
import type { Pool } from '@/types/models'
defineProps<{ pool: Pool }>()
</script>

<template>
  <div class="escrow card" :class="pool.origin">
    <div class="row">
      <!-- 官方池沒有第三方賣家，講「代管防跑路」是沒有意義的 ——
           它的保障來源不同，文案也必須不同 -->
      <div v-if="pool.origin === 'official'">
        <strong>平台自營，直接出貨</strong>
        <p class="muted">
          這一池由 VaultDraw 進貨、鑑定並直接出貨，沒有第三方賣家，
          因此不需要托管期。出貨或商品有任何問題，由平台直接負責處理。
        </p>
      </div>
      <div v-else>
        <strong>款項由平台代管</strong>
        <p class="muted">
          你付的點數不會立刻進賣家帳戶。賣家出貨、你確認收到，
          再經過 {{ pool.escrow.releaseAfterShipDays }} 天鑑賞期後才撥款。
          期間若未出貨或商品不符，可申請全額退回。
          <template v-if="pool.origin === 'personal'">
            個人池的鑑賞期較長，且賣家已預繳保證金。
          </template>
        </p>
      </div>
    </div>
    <div class="bar" v-if="pool.origin !== 'official'">
      <span class="mono">本池代管中 <strong>{{ pool.escrow.held.toLocaleString() }}</strong> 點</span>
      <span class="mono muted" v-if="pool.escrow.released">已撥款 {{ pool.escrow.released.toLocaleString() }} 點</span>
    </div>
  </div>
</template>

<style scoped>
.escrow { padding: 12px 14px; margin-top: 14px; background: var(--ok-wash); }
.row { display: flex; gap: 10px; align-items: flex-start; }
strong { font-size: 13.5px; }
p { margin: 2px 0 0; font-size: 12px; line-height: 1.55; }
.bar {
  display: flex; flex-wrap: wrap; gap: 6px 14px;
  margin-top: 10px; padding-top: 9px;
  border-top: 1px dashed var(--line);
  font-size: 12px;
}
.bar strong { color: var(--gold-deep); }
</style>
