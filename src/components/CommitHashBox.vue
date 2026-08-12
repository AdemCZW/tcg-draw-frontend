<script setup lang="ts">
import type { Pool } from '@/types/models'
defineProps<{ pool: Pool }>()
</script>

<template>
  <div class="fair card">
    <div class="head">
      <span class="lbl display">Provably Fair</span>
      <RouterLink :to="`/fairness/${pool.id}`" class="verify">驗證本池 →</RouterLink>
    </div>
    <dl>
      <dt>Commit hash（開賣前公布）</dt>
      <dd class="mono hash">{{ pool.commitHash }}</dd>
      <dt>Client seed 來源</dt>
      <dd class="mono">{{ pool.clientSeedSource }}</dd>
    </dl>
  </div>
</template>

<style scoped>
.fair { padding: 16px 18px; }
.head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.lbl { font-size: 12px; background: var(--holo); -webkit-background-clip: text; background-clip: text; color: transparent; }
.verify { font-size: 12.5px; color: var(--holo-a); }
dl { margin: 0; }
dt { font-size: 11.5px; color: var(--faint); margin-top: 8px; }
dd { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }
.hash { word-break: break-all; }
</style>
