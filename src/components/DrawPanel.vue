<script setup lang="ts">
// 抽獎面板：選抽數 → 前往選籤牆（親手挑籤位）
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Pool } from '@/types/models'
import { useWalletStore } from '@/stores/wallet'
import { track } from '@/lib/ga'

const props = defineProps<{ pool: Pool }>()
const router = useRouter()
const wallet = useWalletStore()

const counts = [1, 3, 5, 10] as const
const selected = ref<number>(1)
const error = ref('')

const cost = computed(() => selected.value * props.pool.ticketPrice)
const soldOut = computed(() => props.pool.remainingTickets <= 0)
const notEnoughTickets = computed(() => selected.value > props.pool.remainingTickets)

const isStreak = computed(() => props.pool.mode === 'streak')

function goPick() {
  error.value = ''
  track(`click_draw_${selected.value}` as Parameters<typeof track>[0])

  // 連莊爆賞是自己的流程（付一次入場費後連抽），不走選抽數
  if (isStreak.value) {
    if (!wallet.canAfford(props.pool.ticketPrice)) {
      track('draw_failed_insufficient')
      error.value = '點數不足，請先儲值'
      return
    }
    router.push({ name: 'streak', params: { id: props.pool.id } })
    return
  }

  if (soldOut.value || notEnoughTickets.value) {
    track('draw_failed_soldout')
    error.value = soldOut.value ? '本池已完抽' : `剩餘籤數不足 ${selected.value} 抽`
    return
  }
  if (!wallet.canAfford(cost.value)) {
    track('draw_failed_insufficient')
    error.value = '點數不足，請先儲值'
    return
  }
  router.push({ name: 'pool-pick', params: { id: props.pool.id }, query: { count: selected.value } })
}
</script>

<template>
  <div class="panel card">
    <template v-if="isStreak">
      <div class="total">
        <span class="muted">入場費</span>
        <strong class="mono">{{ pool.ticketPrice.toLocaleString() }} 點</strong>
      </div>
      <button class="btn primary go" :disabled="soldOut" @click="goPick">
        {{ soldOut ? '已完抽' : '進場連莊' }}
      </button>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p class="note muted">付一次入場費即可連續抽，隨時可收手落袋。抽到爆賞則該輪全數沒收。</p>
    </template>

    <template v-else>
      <div class="counts" role="radiogroup" aria-label="抽數">
        <button
          v-for="c in counts" :key="c"
          class="count" :class="{ on: selected === c }"
          role="radio" :aria-checked="selected === c"
          :disabled="c > pool.remainingTickets"
          @click="selected = c"
        >{{ c }} 抽</button>
      </div>
      <div class="total">
        <span class="muted">合計</span>
        <strong class="mono">{{ cost.toLocaleString() }} 點</strong>
      </div>
      <button class="btn primary go" :disabled="soldOut" @click="goPick">
        {{ soldOut ? '已完抽' : '去選籤 →' }}
      </button>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p class="note muted">下一步由你親手選籤位。籤序已於開賣前封存（見下方 commit hash），結果不可事後變更。</p>
    </template>
  </div>
</template>

<style scoped>
.panel { padding: 18px; border-radius: var(--radius-lg); }
.counts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.count {
  padding: 9px 0; border-radius: 9px;
  background: var(--surface-2); border: 1px solid var(--line);
  color: var(--muted); font-size: 14px; font-weight: 600;
}
.count.on { color: var(--ink); background: var(--accent-wash); box-shadow: var(--shadow-sm); }
.count:disabled { opacity: .35; cursor: not-allowed; }
.count:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.total { display: flex; justify-content: space-between; align-items: baseline; margin: 14px 2px 10px; }
.total strong { font-size: 20px; color: var(--gold-deep); }
.go { width: 100%; padding: 13px 0; font-size: 15.5px; }
.err { color: var(--danger); font-size: 13px; margin: 10px 0 0; font-weight: 600; }
.note { font-size: 11.5px; margin: 12px 0 0; }
</style>
