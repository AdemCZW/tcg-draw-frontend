<script setup lang="ts">
/**
 * 卡片挑選器的試跑頁。
 *
 * 為什麼要有這一頁：CardPicker 之後會被開池表單引用，但那個表單有一整套
 * 自己的狀態（賞別、數量、買回價、經濟護欄），在那裡面驗挑選器等於同時
 * 在驗兩件事 —— 出問題分不出是誰的。這一頁只掛挑選器本身，
 * 並且把它吐出來的東西原封不動印出來，好確認「帶回的卡片身分是對的」。
 *
 * 比照 /fx：不掛進任何導覽，知道網址的人才進得來。
 */
import { computed, ref } from 'vue'
import CardPicker from '@/components/CardPicker.vue'
import type { PickedCard } from '@/lib/card-pick'
import { MOCK } from '@/lib/config'

const picked = ref<PickedCard[]>([])

/** 直接印出送進 CardItem 的那個物件。看的是實際會被寫進池的東西，不是摘要 */
const json = computed(() => JSON.stringify(picked.value.map(p => ({
  source: p.source,
  prizeId: p.prizeId,
  variant: p.variant ? { label: p.variant.label, variantId: p.variant.variantId, priceEur: p.variant.priceEur } : null,
  artUrl: p.artUrl,
  card: p.card
})), null, 2))
</script>

<template>
  <div class="page wrap">
    <h1>卡片挑選器 試跑</h1>
    <p class="lead muted">
      開發用頁面，沒有掛進導覽。
      <template v-if="MOCK">目前是 mock 模式：卡冊來自 src/mocks/data.ts，目錄搜尋打的是真的 TCGdex。</template>
    </p>

    <div class="panel card">
      <CardPicker v-model="picked" :max="8" />
    </div>

    <h2>帶回的卡片身分</h2>
    <p class="lead muted">這就是呼叫端會拿到的東西。card 可以直接塞進獎品。</p>
    <pre class="out">{{ json }}</pre>
  </div>
</template>

<style scoped>
/* 頁面根容器不要再加一次 --nav-total，全域頁尾已經留過一份（HANDOFF 2.3） */
.wrap { min-width: 0; padding-top: 22px; padding-bottom: 50px; max-width: 720px; }
h1 { font-size: 21px; margin: 0 0 6px; }
h2 { font-size: 16px; margin: 22px 0 4px; }
.lead { font-size: 12.5px; line-height: 1.7; margin: 0 0 14px; }
.muted { color: var(--muted); }
.panel { min-width: 0; padding: 14px; }
.out {
  min-width: 0;
  margin: 8px 0 0; padding: 12px;
  background: var(--field); border: 1px solid var(--line); border-radius: 12px;
  font-family: var(--font-mono); font-size: 11px; line-height: 1.6;
  /* 長網址不換行會把整頁撐寬 —— 這一塊自己捲，不要讓 body 橫捲 */
  white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 340px; overflow: auto;
}
</style>
