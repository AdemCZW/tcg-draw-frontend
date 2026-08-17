<script setup lang="ts">
/**
 * 池來源徽章：官方 / 商家 / 個人。
 *
 * 這個標籤要對應真實的保障差異，不是分級榮譽 —— detailed 模式會把
 * 「這一級實際上保障你什麼」講出來。只有顏色不同的標籤，使用者一週就學會忽略。
 *
 * 顏色的排序刻意不是「好→壞」而是「平台責任重→輕」：
 * 個人池不是劣質，只是風險由誰承擔不同，措辭上不要暗示它是次級品。
 */
import type { PoolOrigin } from '@/types/models'

defineProps<{ origin: PoolOrigin; detailed?: boolean }>()

const meta: Record<PoolOrigin, { label: string; short: string; rule: string; icon: string }> = {
  official: {
    label: '官方池',
    short: '平台自營',
    rule: '平台自營並直接出貨，糾紛由平台全責處理，沒有第三方托管期。',
    icon: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z'
  },
  merchant: {
    label: '商家池',
    short: '已驗證商家',
    rule: '賣家已完成營業登記與身分驗證。款項由平台代管，出貨並經鑑賞期後才撥給賣家。',
    icon: 'M4 9h16l-1 11H5L4 9zM4 9l1.6-4.2A1 1 0 0 1 6.5 4h11a1 1 0 0 1 .9.8L20 9M9 13v4M15 13v4'
  },
  personal: {
    label: '個人池',
    short: '個人賣家',
    rule: '個人賣家開設。托管期較長、單池總額有上限，賣家需先繳保證金。請留意出貨時間。',
    icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0'
  }
}
</script>

<template>
  <span class="pob" :class="[origin, { 'is-detailed': detailed }]">
    <span class="tag">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path :d="meta[origin].icon" />
      </svg>
      {{ meta[origin].label }}
    </span>
    <span v-if="detailed" class="rule">{{ meta[origin].rule }}</span>
  </span>
</template>

<style scoped>
.pob { display: inline-flex; align-items: center; gap: 8px; }
.pob.is-detailed { display: grid; gap: 6px; justify-items: start; }

.tag {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 700;
  padding: 5px 11px;
  border-radius: var(--pill);
  white-space: nowrap;
}
.tag svg {
  width: 13px; height: 13px; flex: none;
  fill: none; stroke: currentColor; stroke-width: 1.9;
  stroke-linecap: round; stroke-linejoin: round;
}

/* 官方＝品牌色實心：平台自己扛責任的那一級，視覺上最重 */
.official .tag { background: var(--accent); color: #fff; }
/* 商家＝綠色描邊：已驗證，但責任在賣家、平台托管 */
.merchant .tag {
  background: var(--ok-wash); color: var(--ok);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ok) 35%, transparent);
}
/* 個人＝中性灰：不是劣質，是風險分配不同，不用警告色 */
.personal .tag {
  background: var(--surface-3); color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--line);
}

.rule { font-size: 12.5px; line-height: 1.6; color: var(--muted); }
</style>
