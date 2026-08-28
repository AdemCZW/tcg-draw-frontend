<script setup lang="ts">
import type { Tier } from '@/types/models'
/* tier 收 null：使用者自己登記進卡冊的卡沒有進過池，賞別對它不成立。
   null 畫成灰底的「未分級」而不是把徽章藏起來 —— 卡冊的卡面上這顆徽章
   同時是版面的一部分，整顆消失會讓那一格看起來像少了東西。 */
defineProps<{ tier: Tier | null }>()
const label: Record<Tier, string> = { A: 'A 賞', B: 'B 賞', C: 'C 賞', D: 'D 賞', LAST: '最後賞', BUST: '爆賞' }
defineExpose({ label })
</script>

<template>
  <span v-if="tier" class="tier" :class="`t-${tier.toLowerCase()}`">{{ label[tier] }}</span>
  <span v-else class="tier t-none">未分級</span>
</template>

<style scoped>
.tier {
  display: inline-flex; align-items: center;
  font-size: 12.5px; font-weight: 600;
  letter-spacing: -0.01em;
  padding: 4px 12px;
  border-radius: var(--pill);
  color: #fff;
}
.t-a    { background: var(--tier-a); }
.t-b    { background: var(--tier-b); }
.t-c    { background: var(--tier-c); }
.t-d    { background: var(--tier-d); }
.t-last { background: var(--tier-last); }
.t-bust { background: var(--ink); }
.t-d { color: var(--ink); background: var(--surface-3); }
/* 未分級：刻意比 D 賞更「不是一個賞」—— 透明底加細框，
   讓它讀起來是附註不是等級 */
.t-none { color: var(--muted); background: transparent; border: 1px solid var(--line); }
</style>
