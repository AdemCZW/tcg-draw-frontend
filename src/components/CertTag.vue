<script setup lang="ts">
import type { CardItem } from '@/types/models'
defineProps<{ card: CardItem }>()
</script>

<template>
  <span v-if="card.certNo" class="cert mono">
    {{ card.grader }} {{ card.grade }}
    <em>#{{ card.certNo }}</em>
  </span>
  <span v-else class="cert mono raw">RAW · 未鑑定</span>
</template>

<style scoped>
.cert {
  display: inline-flex; gap: 6px; align-items: baseline;
  font-size: 11.5px; padding: 3px 10px;
  border-radius: var(--pill);
  background: color-mix(in srgb, var(--gold) 14%, transparent);
  color: var(--gold-deep);
  white-space: nowrap;
}
.cert em { font-style: normal; color: color-mix(in srgb, var(--gold-deep) 65%, var(--muted)); }
.cert.raw { background: var(--surface-2); color: var(--muted); }
</style>
