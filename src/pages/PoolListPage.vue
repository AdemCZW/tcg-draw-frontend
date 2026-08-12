<script setup lang="ts">
import { onMounted } from 'vue'
import { usePoolStore } from '@/stores/pools'
import PoolCard from '@/components/PoolCard.vue'
import { track } from '@/lib/ga'

const pools = usePoolStore()
onMounted(() => {
  pools.ensureLoaded()
  track('view_pool_list')
})
</script>

<template>
  <div class="container page">
    <h1>全部抽選池</h1>
    <p v-if="pools.loading" class="muted">載入中…</p>
    <div class="grid">
      <PoolCard v-for="p in pools.pools" :key="p.id" :pool="p" />
    </div>
  </div>
</template>

<style scoped>
.page { padding-top: 36px; padding-bottom: 72px; }
h1 { font-size: 22px; margin: 0 0 20px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 18px; }
@media (max-width: 720px) {
  .page { padding-top: 22px; padding-bottom: 40px; }
  h1 { font-size: 19px; margin: 0 0 14px; }
  .grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
}
</style>
