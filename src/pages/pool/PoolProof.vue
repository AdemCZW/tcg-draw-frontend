<script setup lang="ts">
/**
 * 池 · 驗證 —— 承諾雜湊、托管、驗算入口。
 * 這是「不需要信任我們」的材料。獨立成一頁，是因為它值得一個安靜的位置：
 * 塞在獎項表下面的第四個區塊，沒有人會讀。
 */
import type { Pool } from '@/types/models'
import CommitHashBox from '@/components/CommitHashBox.vue'
import EscrowNotice from '@/components/EscrowNotice.vue'
defineProps<{ pool: Pool }>()
</script>

<template>
  <div class="pf">
    <p class="claim">這一池的結果<strong>不需要你信任我們</strong></p>
    <p class="how muted">
      籤序在開賣前就已洗好封存並公布承諾雜湊；完抽後公開種子，任何人都能重算一次比對。
    </p>
    <CommitHashBox :pool="pool" />
    <EscrowNotice :pool="pool" />
    <RouterLink :to="{ name: 'fairness-pool', params: { poolId: pool.id } }" class="btn verify">
      {{ pool.status === 'open' ? '看這一池的驗算頁 →' : '自己驗算這一池 →' }}
    </RouterLink>
    <RouterLink :to="{ name: 'fairness' }" class="more muted">公平性機制完整說明</RouterLink>
  </div>
</template>

<style scoped>
.pf { display: grid; gap: 14px; justify-items: start; }
.claim { margin: 0; font-size: 16px; }
.claim strong { color: var(--accent); }
.how { margin: -6px 0 2px; font-size: 13.5px; line-height: 1.62; max-width: 60ch; }
.verify { width: 100%; max-width: 420px; }
.more { font-size: 13px; text-decoration: underline; text-underline-offset: 3px; }
</style>
