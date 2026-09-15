<script setup lang="ts">
/**
 * 我的頁的收藏家等級區塊：徽章、目前積分、離下一級還差多少。
 * 「還差 N 分」比百分比好懂 —— 使用者要做的判斷是「再登記幾張」。
 */
import { computed } from 'vue'
import { collectorProgress } from '@/shared/collector'
import CollectorBadge from '@/components/CollectorBadge.vue'

const props = defineProps<{ points: number }>()
const p = computed(() => collectorProgress(props.points))
</script>

<template>
  <section class="cp card" aria-label="收藏家等級">
    <div class="top">
      <CollectorBadge v-if="p.level > 0" :level="p.level" size="md" />
      <span v-else class="none">還沒有等級</span>
      <span class="pts mono">{{ p.points }}<span class="u">收藏積分</span></span>
    </div>
    <div
      class="bar" role="progressbar"
      :aria-valuenow="Math.round(p.ratio * 100)" aria-valuemin="0" aria-valuemax="100"
    >
      <span class="fill" :style="{ width: `${Math.round(p.ratio * 100)}%` }"></span>
    </div>
    <p class="hint">
      <template v-if="p.toNext !== null">還差 <b class="mono">{{ p.toNext }}</b> 分升到下一級。登記一張鑑定卡加 1 分。</template>
      <template v-else>已達最高等級。</template>
    </p>
  </section>
</template>

<style scoped>
.cp { margin-top: 12px; padding: 12px 14px; display: grid; gap: 8px; min-width: 0; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.none { font-size: 13px; color: var(--muted); }
.pts { flex: none; font-size: 16px; font-weight: 700; color: var(--ink); }
.pts .u { margin-left: 4px; font-family: var(--font-body); font-size: 11.5px; font-weight: 500; color: var(--muted); }
.bar { height: 6px; border-radius: var(--pill); background: var(--surface-2); overflow: hidden; }
.fill { display: block; height: 100%; border-radius: inherit; background: var(--gold); }
.hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--muted); overflow-wrap: anywhere; }
.hint b { color: var(--ink); }
</style>
