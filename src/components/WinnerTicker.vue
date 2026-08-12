<script setup lang="ts">
// 即時中獎跑馬燈 —— mock 輪播；正式版接 SSE /winners/stream
import { onMounted, ref } from 'vue'
import { api } from '@/lib/api'
import type { WinnerEvent } from '@/types/models'
import TierBadge from './TierBadge.vue'

const winners = ref<WinnerEvent[]>([])
const idx = ref(0)
let timer: ReturnType<typeof setInterval> | undefined

onMounted(async () => {
  winners.value = await api.recentWinners()
  timer = setInterval(() => { idx.value = (idx.value + 1) % Math.max(winners.value.length, 1) }, 3600)
})
</script>

<template>
  <div v-if="winners.length" class="ticker card" aria-live="polite">
    <span class="dot" aria-hidden="true"></span>
    <Transition name="slide" mode="out-in">
      <div class="line" :key="idx">
        <TierBadge :tier="winners[idx].tier" />
        <span class="mono who">{{ winners[idx].user }}</span>
        <span>抽中</span>
        <strong>{{ winners[idx].cardName }}</strong>
        <span class="muted at">{{ winners[idx].at }}</span>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.ticker {
  position: relative; display: flex; align-items: center; gap: 10px;
  padding: 13px 20px 13px 40px;
  border-radius: var(--pill);
}
.dot {
  position: absolute; left: 18px; top: 50%; translate: 0 -50%;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 15%, transparent);
}
@media (prefers-reduced-motion: no-preference) {
  .dot { animation: pulse 1.8s ease-in-out infinite; }
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .45; }
}
.line { display: flex; align-items: center; gap: 10px; font-size: 14px; white-space: nowrap; flex: 1; min-width: 0; }
.line strong { overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
.who { color: var(--accent); font-weight: 500; }
.at { margin-left: auto; font-size: 13px; flex: none; }

@media (max-width: 720px) {
  .ticker { padding: 11px 14px 11px 34px; }
  .dot { left: 14px; }
  .line { font-size: 12.5px; gap: 7px; }
  /* 窄螢幕塞不下「抽中」與時間，優先保留誰中了什麼 */
  .line > span:nth-of-type(2) { display: none; }
  .at { display: none; }
}
.slide-enter-active, .slide-leave-active { transition: all .3s ease; }
.slide-enter-from { opacity: 0; transform: translateY(8px); }
.slide-leave-to { opacity: 0; transform: translateY(-8px); }
</style>
