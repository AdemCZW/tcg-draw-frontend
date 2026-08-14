<script setup lang="ts">
// 選籤牆：玩家親手挑籤位，而不是系統代抽
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePoolStore } from '@/stores/pools'
import { useWalletStore } from '@/stores/wallet'
import PoolModeBadge from '@/components/PoolModeBadge.vue'
import { track } from '@/lib/ga'

const route = useRoute()
const router = useRouter()
const pools = usePoolStore()
const wallet = useWalletStore()

const pool = computed(() => pools.byId(String(route.params.id)))
const count = computed(() => Math.max(1, Number(route.query.count) || 1))
const picked = ref<number[]>([])
const busy = ref(false)
const error = ref('')

onMounted(() => pools.ensureLoaded())

const taken = computed(() => new Set(pool.value?.takenSeats ?? []))
const cost = computed(() => (pool.value?.ticketPrice ?? 0) * count.value)
const ready = computed(() => picked.value.length === count.value)

function toggle(seat: number) {
  if (taken.value.has(seat) || busy.value) return
  const i = picked.value.indexOf(seat)
  if (i >= 0) { picked.value.splice(i, 1); return }
  if (picked.value.length >= count.value) picked.value.shift()
  picked.value.push(seat)
}

async function confirm() {
  if (!pool.value || !ready.value) return
  error.value = ''
  if (!wallet.canAfford(cost.value)) { error.value = '點數不足，請先儲值'; return }
  busy.value = true
  try {
    wallet.spend(cost.value)
    const result = await pools.draw(pool.value.id, [...picked.value])
    track('draw_success')
    router.push({ name: 'draw-result', params: { drawId: result.drawId } })
  } catch {
    error.value = '抽選失敗，點數已退回'
    wallet.topup(cost.value)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="container page" v-if="pool">
    <div class="head">
      <h1 class="display">選你的籤！</h1>
      <PoolModeBadge :mode="pool.mode" />
    </div>
    <p class="sub">
      <strong>{{ pool.title }}</strong> — 從剩下的
      <strong class="mono">{{ pool.remainingTickets }}</strong> 支籤中，親手挑出
      <strong class="mono">{{ count }}</strong> 支。籤序開賣前就已封存，位置由你決定。
    </p>

    <div class="wall card" :class="{ duel: pool.totalTickets <= 2 }">
      <button
        v-for="seat in pool.totalTickets" :key="seat"
        class="ticket"
        :class="{ taken: taken.has(seat), on: picked.includes(seat) }"
        :disabled="taken.has(seat) || busy"
        :aria-label="taken.has(seat) ? `第 ${seat} 籤（已抽走）` : `第 ${seat} 籤`"
        :aria-pressed="picked.includes(seat)"
        @click="toggle(seat)"
      >
        <span class="no mono">{{ seat }}</span>
        <span v-if="taken.has(seat)" class="gone">已抽</span>
      </button>
    </div>

    <div class="bar card">
      <span class="status">
        已選 <strong class="mono">{{ picked.length }}</strong> / {{ count }}
        <span class="muted seats" v-if="picked.length">（{{ picked.map(s => '#' + s).join('、') }}）</span>
      </span>
      <strong class="mono cost">{{ cost.toLocaleString() }} 點</strong>
      <button class="btn primary" :disabled="!ready || busy" @click="confirm">
        {{ busy ? '開籤中…' : ready ? '就是這幾支，開！' : `再選 ${count - picked.length} 支` }}
      </button>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </div>
  </div>
  <div v-else class="container page"><p class="muted">找不到這個池。<RouterLink to="/pools">回抽選列表</RouterLink></p></div>
</template>

<style scoped>
.page { padding-top: 32px; padding-bottom: 72px; }
.head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
h1 { font-size: 30px; margin: 0; }
.sub { margin: 10px 0 22px; font-size: 14.5px; color: var(--muted); }
.wall {
  perspective: 1000px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(62px, 1fr));
  gap: 10px; padding: 18px;
}
.wall.duel { grid-template-columns: repeat(2, 1fr); gap: 20px; padding: 28px; }
.ticket {
  position: relative;
  aspect-ratio: 3 / 4;
  border: 1px solid var(--line);
  border-radius: 8px;
  background:
    var(--surface);
  box-shadow: var(--shadow-sm);
  font-weight: 600;
  display: grid; place-items: center;
  transform-style: preserve-3d;
  transition: transform .22s cubic-bezier(.2,.7,.3,1), box-shadow .22s;
  cursor: pointer;
}
.wall.duel .ticket { font-size: 26px; }
.ticket:hover:not(:disabled) {
  transform: translateZ(34px) rotateX(9deg);
  box-shadow: 0 18px 34px rgba(26, 22, 20, .18);
  z-index: 2;
}
.ticket:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ticket.on {
  background: var(--accent-wash);
  border-color: var(--accent);
  transform: translateZ(26px) rotateX(7deg);
  box-shadow: 0 16px 30px rgba(247, 59, 32, .22);
  z-index: 2;
}
.ticket.taken {
  background: var(--surface-2);
  border-style: dashed;
  box-shadow: none;
  color: var(--faint);
  cursor: not-allowed;
  opacity: .55;
}
.no { font-size: 13px; }
.wall.duel .no { font-size: 30px; }
.gone { position: absolute; bottom: 6px; font-size: 10px; color: var(--faint); font-weight: 600; }
.bar {
  position: sticky; bottom: 14px;
  display: flex; flex-wrap: wrap; align-items: center; gap: 16px;
  padding: 12px 18px; margin-top: 18px;
  background: var(--surface);
}
.status { font-size: 14px; }
.seats { font-size: 12px; }
.cost { margin-left: auto; font-size: 19px; color: var(--gold-deep); }
/* 錯誤訊息放在結算列內 —— 手機上結算列是 fixed，放外面會被蓋住 */
.err { flex-basis: 100%; color: var(--danger); font-size: 13.5px; margin: 0; font-weight: 600; }

@media (max-width: 720px) {
  /* 底部要同時容納 sticky 結算列與 AppBottomNav。
     導覽高度吃 --nav-total，不再自己抄一份數字 */
  .page { padding-top: 20px; padding-bottom: calc(94px + var(--nav-total)); }
  h1 { font-size: 23px; }
  .head { gap: 10px; }
  .sub { font-size: 13px; margin: 8px 0 16px; }
  .wall { grid-template-columns: repeat(5, 1fr); gap: 7px; padding: 12px; }
  .wall.duel { gap: 14px; padding: 18px; }
  .no { font-size: 12px; }
  .gone { font-size: 9px; bottom: 4px; }
  .bar {
    position: fixed; left: 10px; right: 10px;
    bottom: var(--nav-total);
    z-index: 55;
    display: grid; grid-template-columns: 1fr auto; gap: 6px 12px;
    padding: 10px 14px;
  }
  .status { font-size: 12.5px; }
  .seats { display: block; font-size: 11px; }
  .cost { grid-row: 1; grid-column: 2; font-size: 16px; align-self: center; }
  .bar .btn { grid-column: 1 / -1; width: 100%; padding: 11px 0; }
  .err { grid-column: 1 / -1; font-size: 12.5px; }
}
</style>
