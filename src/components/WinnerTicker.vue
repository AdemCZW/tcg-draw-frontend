<script setup lang="ts">
/**
 * 中獎廣播。
 *
 * ── 為什麼長這樣 ────────────────────────────────────────────────────
 * 它唯一的工作是**證明這個站是活的**：現在有人在抽、而且真的有人中。
 * 那是一句話就講得完的事，所以它不該長得像一張卡片。
 *
 * 前一版把它做成 .card（外框、圓角膠囊、13px 內距）加大顆的賞別徽章、
 * 會員代號、時間 —— 五個元素爭一行，而讀的人只會抓到「有人中了好東西」。
 * 資訊多不等於傳達得多；在這個位置，多出來的每一項都在稀釋那一句話。
 *
 * 現在只剩三樣：脈動的綠點（活著）、賞別（多好）、卡名（什麼）。
 * 沒有外框 —— 它是一行狀態，不是一個容器。
 *
 * ── 為什麼不顯示會員代號 ────────────────────────────────────────────
 * 「VD-1A2B 抽中」對讀的人沒有意義（那是一串他不認識的編號），
 * 但它會讓每一則廣播都變長、而且把真正的重點往右推。
 * 想知道誰中了什麼，公開卡冊那邊看得到。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from '@/lib/api'
import type { WinnerEvent } from '@/types/models'

const winners = ref<WinnerEvent[]>([])
const idx = ref(0)
let timer: ReturnType<typeof setInterval> | undefined

onMounted(async () => {
  /* 失敗就整條不顯示（v-if="winners.length"）—— 廣播是錦上添花，
     它連不上不該在畫面上留一塊錯誤訊息。 */
  winners.value = await api.recentWinners().catch(() => [])
  timer = setInterval(() => {
    idx.value = (idx.value + 1) % Math.max(winners.value.length, 1)
  }, 3600)
})
/* 原本沒有清掉這個 interval —— 換頁之後它會一直跑到重新整理為止。
   單一個計時器不痛，但這是離開頁面就該停的東西。 */
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div v-if="winners.length" class="ticker" aria-live="polite">
    <span class="pulse" aria-hidden="true"></span>
    <Transition name="slide" mode="out-in">
      <p class="line" :key="idx">
        <span class="tier" :data-tier="winners[idx].tier">{{
          winners[idx].tier === 'LAST' ? '最後賞' : winners[idx].tier + ' 賞'
        }}</span>
        <span class="name">{{ winners[idx].cardName }}</span>
      </p>
    </Transition>
  </div>
</template>

<style scoped>
/* 沒有 .card：它是一行狀態不是一個容器。高度靠內容撐，不給固定值 ——
   賞別字數會變（「最後賞」比「A 賞」寬），寫死會讓文字貼邊。 */
.ticker {
  display: flex; align-items: center; gap: 9px;
  min-width: 0; padding: 2px 0;
}

/* 綠點是唯一的「即時」訊號，所以它是唯一會動的東西 */
.pulse {
  flex: none; width: 7px; height: 7px; border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 16%, transparent);
}
@media (prefers-reduced-motion: no-preference) {
  .pulse { animation: pulse 1.8s ease-in-out infinite; }
}
@keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .4 } }

/* min-width: 0 讓 .name 的 ellipsis 生效 —— flex 子元素預設不會縮到比內容小 */
.line {
  display: flex; align-items: baseline; gap: 7px;
  min-width: 0; margin: 0; font-size: 13px;
}

/* 賞別只用顏色與字重表達，不畫膠囊底 —— 一行狀態裡塞一顆實心色塊，
   眼睛會先看到那個色塊而不是卡名，而卡名才是內容。 */
.tier {
  flex: none; font-weight: 700; font-size: 12px;
  letter-spacing: .02em; color: var(--accent);
}
.tier[data-tier="A"], .tier[data-tier="LAST"] { color: var(--gold); }
.tier[data-tier="B"] { color: var(--accent); }
.tier[data-tier="C"], .tier[data-tier="D"] { color: var(--muted); }

.name {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--ink); font-weight: 600;
}

.slide-enter-active, .slide-leave-active { transition: opacity .3s ease, transform .3s ease; }
.slide-enter-from { opacity: 0; transform: translateY(6px); }
.slide-leave-to { opacity: 0; transform: translateY(-6px); }
</style>
