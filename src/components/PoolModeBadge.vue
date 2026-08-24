<script setup lang="ts">
import type { PoolMode } from '@/types/models'

defineProps<{ mode: PoolMode; detailed?: boolean }>()

/* rule 是給玩家看的規則，所以它必須描述後端真的會做的事，不是企劃想做的事。
   muteki 那一句刻意把「沒有額外贈獎」講出來 —— 一番賞的玩家預設會以為
   最後一籤有加送（那是經典賞的規則），不講的話沉默會被讀成「有」。
   其餘四種目前開不出池（後端 enum + migration 016 兩道擋著），
   文案留著是為了它們哪天真的實作時有現成的定義。 */
const meta: Record<PoolMode, { label: string; rule: string }> = {
  classic: { label: '經典賞', rule: '抽走最後一籤的人，額外獲得最後賞。' },
  shitei: { label: '指定賞', rule: '抽中指定賞直接送最後賞，整池立刻結束。' },
  muteki: { label: '無敵賞', rule: '最後賞就是籤池裡的一張獎品，每一抽都可能是它；抽走最後一籤沒有額外贈獎。' },
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
.mode.streak { background: color-mix(in srgb, var(--wash-peach) 92%, transparent); }
.mode.auction { background: color-mix(in srgb, var(--wash-rose) 88%, transparent); }
.pmb { display: inline-flex; }
.pmb.is-detailed { display: flex; flex-direction: column; align-items: flex-start; }
.rule { font-size: 14.5px; margin-top: 10px; color: var(--muted); font-weight: 400; line-height: 1.55; }
</style>
