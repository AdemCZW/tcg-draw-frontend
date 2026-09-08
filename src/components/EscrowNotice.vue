<script setup lang="ts">
/**
 * 資金托管說明。玩家付的錢不會直接進賣家口袋，這是「賣家跑路」風險的
 * 主要保護，必須在購買前就講清楚。
 *
 * ── 為什麼分支整個拿掉 ────────────────────────────────────────────────
 * 舊版依 pool.origin 走三條不同的文案：
 *   official → 「平台自營、沒有第三方賣家，因此不需要托管期」
 *   personal → 「個人池的鑑賞期較長，且賣家已預繳保證金」
 * 兩句都是假的。抽卡不分賣家身分，一律建結算列
 * （pool-settlement.ts 的 creditDraw 是唯一入口，沒有讀過 origin），
 * 而 POOL_SHIP_DEADLINE_MS / POOL_INSPECT_MS / POOL_VAULT_ACCEPT_MS
 * 全部是全站常數。個人賣家也沒有任何預繳保證金的機制。
 *
 * 官方那一條還多錯一層：它連「本池代管中 N 點」那一列都藏起來，
 * 等於對使用者說這一池沒有代管 —— 而錢確確實實被代管著。
 *
 * 現在一種文案打天下，因為規則本來就只有一種。
 */
import type { Pool } from '@/types/models'
defineProps<{ pool: Pool }>()
</script>

<template>
  <div class="escrow card" :class="pool.origin">
    <div class="row">
      <div>
        <strong>款項由平台代管</strong>
        <p class="muted">
          你付的點數不會立刻進賣家帳戶。賣家出貨、你確認收到，
          再經過 {{ pool.escrow.releaseAfterShipDays }} 天鑑賞期後才撥款。
          期間若未出貨或商品不符，可申請全額退回。
          <!-- 明白寫出「不分賣家」。舊版正是在這裡依賣家身分編出不同的
               保障，所以新版把「都一樣」講死，不留想像空間。 -->
          這一條<b>不分賣家身分</b>，所有池都一樣。
        </p>
      </div>
    </div>
    <div class="bar">
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
