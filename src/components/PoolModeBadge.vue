<script setup lang="ts">
import type { PoolMode } from '@/types/models'

defineProps<{ mode: PoolMode; detailed?: boolean }>()

const meta: Record<PoolMode, { label: string; rule: string }> = {
  classic: { label: '經典賞', rule: '抽走最後一籤的人，額外獲得最後賞。' },
  shitei: { label: '指定賞', rule: '抽中指定賞直接送最後賞，整池立刻結束。' },
  muteki: { label: '無敵賞', rule: '最後賞就藏在籤池裡，每一抽都可能是它。' },
  battle: { label: '大亂鬥', rule: '沒有最後賞，全員公平混戰。' },
  niboichi: { label: '二選一', rule: '只有 2 支籤，二分之一機率直取大獎。' },
  streak: { label: '連莊爆賞', rule: '付一次入場費就能連抽，隨時可收手落袋；抽到爆賞則該輪全部歸零。' },
  auction: { label: '尾籤競標', rule: '最後幾支籤不賣固定價，價高者得，落標全額退還。' }
}
</script>

<template>
  <!-- 單一根節點：多根會變成 fragment，外部傳入的 class 無法套用 -->
  <span class="pmb" :class="{ 'is-detailed': detailed }">
    <span class="mode" :class="mode">{{ meta[mode].label }}</span>
    <span v-if="detailed" class="rule">{{ meta[mode].rule }}</span>
  </span>
</template>

<style scoped>
.mode {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12.5px; font-weight: 600;
  padding: 5px 12px;
  border-radius: var(--pill);
  background: color-mix(in srgb, var(--surface) 78%, transparent);
  backdrop-filter: blur(8px);
  color: var(--ink);
  box-shadow: var(--shadow-sm);
}
.mode.classic { background: color-mix(in srgb, var(--wash-sand) 88%, transparent); }
.mode.shitei { background: color-mix(in srgb, var(--wash-peach) 88%, transparent); }
.mode.muteki { background: color-mix(in srgb, var(--wash-mint) 88%, transparent); }
.mode.battle { background: color-mix(in srgb, var(--wash-lilac) 88%, transparent); }
.mode.niboichi { background: color-mix(in srgb, var(--wash-mint) 88%, transparent); }
.mode.streak { background: color-mix(in srgb, var(--wash-peach) 92%, transparent); }
.mode.auction { background: color-mix(in srgb, var(--wash-rose) 88%, transparent); }
.pmb { display: inline-flex; }
.pmb.is-detailed { display: flex; flex-direction: column; align-items: flex-start; }
.rule { font-size: 14.5px; margin-top: 10px; color: var(--muted); font-weight: 400; line-height: 1.55; }
</style>
