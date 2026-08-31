<script setup lang="ts">
/**
 * 承諾雜湊方塊 —— 開賣前公布的 commit hash 與 client seed 來源。
 *
 * 只收「驗證本池 →」那個連結，整塊留著（見 lib/config.ts 的 FAIRNESS_UI）。
 * 判準是「收起來之後還讀不讀得通」：這一塊的本體是那兩筆揭露的資料，
 * 標題加一份 dl 自己就完整 —— 雜湊照樣印在畫面上，想自己比對的人抄得走。
 * 收掉整塊反而是把後端從沒停過的承諾也一起藏起來，那才是說謊。
 */
import type { Pool } from '@/types/models'
import { FAIRNESS_UI } from '@/lib/config'
defineProps<{ pool: Pool }>()
</script>

<template>
  <div class="fair card">
    <div class="head">
      <span class="lbl display">Provably Fair</span>
      <RouterLink v-if="FAIRNESS_UI" :to="`/fairness/${pool.id}`" class="verify">驗證本池 →</RouterLink>
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
/* space-between 在只剩標籤一個子元素時就等於靠左，收起連結不會留下空洞 */
.head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; }
.head > * { min-width: 0; }
.lbl { font-size: 12px; background: var(--holo); -webkit-background-clip: text; background-clip: text; color: transparent; }
.verify { font-size: 12.5px; color: var(--holo-a); }
dl { margin: 0; }
dt { font-size: 11.5px; color: var(--faint); margin-top: 8px; }
dd { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }
.hash { word-break: break-all; }
</style>
