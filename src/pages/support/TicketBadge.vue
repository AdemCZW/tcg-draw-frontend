<script setup lang="ts">
/**
 * 狀態徽章。列表與詳情共用同一顆 —— 兩邊各畫一顆的話，某一天只有一邊
 * 會跟著改，而使用者會在兩個畫面上看到同一張單有兩種說法。
 *
 * 顏色全部走 tokens.css 的 wash / ink 兩支權杖。不寫死 hex 的理由在
 * tokens.css 裡有記錄：後台曾經整排徽章寫死深色版的 hex，換到淺色主題
 * 對比只剩 1.0，等於整排看不見。
 */
import { computed } from 'vue'
import type { TicketStatus } from '@/lib/api'
import { STATUS_TEXT } from './labels'

const props = defineProps<{ status: TicketStatus }>()
const info = computed(() => STATUS_TEXT[props.status])
</script>

<template>
  <span class="tkBadge" :class="info.tone">
    <!-- 圖示用 inline SVG，手機介面不放 emoji。四種狀態各一個形狀：
         只靠顏色分辨的話，色覺不同的人看到的是四顆一樣的膠囊。 -->
    <svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true"
         stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <template v-if="props.status === 'resolved'"><path d="M2.4 6.4 4.9 9l4.7-6" /></template>
      <template v-else-if="props.status === 'rejected'"><path d="M3 3l6 6M9 3l-6 6" /></template>
      <template v-else-if="props.status === 'pending-user'">
        <circle cx="6" cy="6" r="4.4" /><path d="M6 3.6v2.7l1.8 1.1" />
      </template>
      <template v-else><circle cx="6" cy="6" r="4.4" /><path d="M6 8.6h.01M6 3.6v3" /></template>
    </svg>
    {{ info.t }}
  </span>
</template>

<style scoped>
.tkBadge {
  display: inline-flex; align-items: center; gap: 5px;
  flex: none; min-width: 0;
  font-size: 12px; font-weight: 700; line-height: 1;
  padding: 6px 11px;
  border-radius: var(--pill);
  white-space: nowrap;
}
.tkBadge.wait { background: var(--info-wash); color: var(--info-ink); }
.tkBadge.act { background: var(--warn-wash); color: var(--warn-ink); }
.tkBadge.ok { background: var(--ok-wash); color: var(--ok-ink); }
.tkBadge.bad { background: var(--danger-wash); color: var(--danger-ink); }
</style>
