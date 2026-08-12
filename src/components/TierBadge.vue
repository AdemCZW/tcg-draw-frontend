<script setup lang="ts">
import type { Tier } from '@/types/models'
defineProps<{ tier: Tier }>()
const label: Record<Tier, string> = { A: 'A 賞', B: 'B 賞', C: 'C 賞', D: 'D 賞', LAST: '最後賞', BUST: '爆賞' }
defineExpose({ label })
</script>

<template>
  <span class="tier" :class="`t-${tier.toLowerCase()}`">{{ label[tier] }}</span>
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
</style>
