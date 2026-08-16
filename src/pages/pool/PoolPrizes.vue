<script setup lang="ts">
/** 池 · 獎項與剩餘 —— 只做一件事：把獎項表攤開。 */
import type { Pool } from '@/types/models'
import PrizeTable from '@/components/PrizeTable.vue'
defineProps<{ pool: Pool }>()
</script>

<template>
  <div class="pz">
    <h2 class="sr-only">獎項與剩餘</h2>
    <PrizeTable :pool="pool" />
  </div>
</template>

<style scoped>
.pz { display: grid; gap: 14px; }
</style>
