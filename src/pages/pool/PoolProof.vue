<script setup lang="ts">
/**
 * 池 · 驗證 —— 承諾雜湊、托管、驗算入口。
 * 這是「不需要信任我們」的材料。獨立成一頁，是因為它值得一個安靜的位置：
 * 塞在獎項表下面的第四個區塊，沒有人會讀。
 *
 * FAIRNESS_UI 關著的時候（見 lib/config.ts）：**整塊留著，只收兩個連結**。
 *
 * 為什麼不整塊（或整個 tab）收掉：這一頁裝的不只有驗算入口 ——
 * 承諾雜湊、client seed 來源、還有托管聲明（那是錢的保障，跟公平性是兩回事）。
 * 整塊收掉等於把這幾樣一起藏了，而後端根本沒停過，等於自己把揭露拿掉。
 *
 * 但只拔連結會留下一個講到一半的段落：原本那句「任何人都能重算一次比對」
 * 是在替下面那顆驗算按鈕鋪路，按鈕不在了就變成一個沒有下文的承諾。
 * 所以那句說明跟著開關換一種寫法，收在「材料都在這裡」而不是「你可以去算」，
 * 讀起來仍然是完整的一段話。
 */
import type { Pool } from '@/types/models'
import CommitHashBox from '@/components/CommitHashBox.vue'
import EscrowNotice from '@/components/EscrowNotice.vue'
import { FAIRNESS_UI } from '@/lib/config'
defineProps<{ pool: Pool }>()
</script>

<template>
  <div class="pf">
    <p class="claim">這一池的結果<strong>不需要你信任我們</strong></p>
    <p v-if="FAIRNESS_UI" class="how muted">
      籤序在開賣前就已洗好封存並公布承諾雜湊；完抽後公開種子，任何人都能重算一次比對。
    </p>
    <!-- 驗算入口收起來時換這一句：句子停在「材料都公布了」，
         不再指向一顆已經不在畫面上的按鈕。內容照樣是真的 ——
         封存、承諾雜湊、完抽後公開種子，後端這三件事一件都沒少做。 -->
    <p v-else class="how muted">
      籤序在開賣前就已洗好封存，承諾雜湊當時就公布了（見下方）；完抽後種子一併公開，事後改不了。
    </p>
    <CommitHashBox :pool="pool" />
    <EscrowNotice :pool="pool" />
    <RouterLink
      v-if="FAIRNESS_UI"
      :to="{ name: 'fairness-pool', params: { poolId: pool.id } }" class="btn verify"
    >
      {{ pool.status === 'open' ? '看這一池的驗算頁 →' : '自己驗算這一池 →' }}
    </RouterLink>
    <RouterLink v-if="FAIRNESS_UI" :to="{ name: 'fairness' }" class="more muted">公平性機制完整說明</RouterLink>
  </div>
</template>

<style scoped>
/* 收起連結後最後一個子元素是 EscrowNotice，grid 的 gap 不會留下多餘的尾巴 */
.pf { display: grid; gap: 14px; justify-items: start; min-width: 0; }
.pf > * { min-width: 0; }
.claim { margin: 0; font-size: 16px; }
.claim strong { color: var(--accent); }
.how { margin: -6px 0 2px; font-size: 13.5px; line-height: 1.62; max-width: 60ch; }
.verify { width: 100%; max-width: 420px; }
.more { font-size: 13px; text-decoration: underline; text-underline-offset: 3px; }
</style>
