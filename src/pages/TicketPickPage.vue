<script setup lang="ts">
/**
 * 選籤牆：玩家親手挑籤位，而不是系統代抽。
 *
 * 重做的兩個原因：
 *
 * 1. 跑版。舊版在 .wall 上設 perspective，選中的籤用 translateZ 抬起來。
 *    perspective 的原點是整面牆的中心，而 250 格的牆非常高 —— 離中心越遠的格子，
 *    投影位移越大，選中的籤會被推到隔壁列去蓋住別人。改用 scale，
 *    它不會位移、也不需要 3D 圖層，250 格的手機捲動順很多。
 *
 * 2. 難用。250 格要捲五十列，而多數人根本不在乎抽到第幾號 ——
 *    卻被逼著一格一格找。所以補上「隨機挑」與「跳到號碼」：
 *    在乎號碼的人照樣自己挑，不在乎的人一鍵就走。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { usePoolStore } from '@/stores/pools'
import { useWalletStore } from '@/stores/wallet'
import PoolModeBadge from '@/components/PoolModeBadge.vue'
import ImmersiveBar from '@/components/ImmersiveBar.vue'
import { haptic } from '@/lib/haptics'
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
/* 顯示時排序。挑選的順序對使用者沒有意義，但「#9、#19、#14」這種
   跳來跳去的清單會讓人以為自己選錯了 */
const pickedSorted = computed(() => [...picked.value].sort((a, b) => a - b))

const remaining = computed(() => pool.value ? pool.value.totalTickets - taken.value.size : 0)
const soldPct = computed(() =>
  pool.value?.totalTickets ? Math.round(taken.value.size / pool.value.totalTickets * 100) : 0)

function toggle(seat: number) {
  if (taken.value.has(seat) || busy.value) return
  haptic('select')
  const i = picked.value.indexOf(seat)
  if (i >= 0) { picked.value.splice(i, 1); return }
  if (picked.value.length >= count.value) picked.value.shift()
  picked.value.push(seat)
}

/* ---- 隨機挑 ----
   從還沒被抽走的籤裡挑滿。用 Fisher-Yates 的前 N 步而不是「隨機挑一個、
   撞到重複就再挑」—— 後者在池快賣完時會退化成長時間空轉。
   這只是介面上的便利選號，跟公平性無關（決定獎品的是封存的籤序）。 */
function pickRandom() {
  if (!pool.value || busy.value) return
  const free: number[] = []
  for (let s = 1; s <= pool.value.totalTickets; s++) if (!taken.value.has(s)) free.push(s)
  const n = Math.min(count.value, free.length)
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (free.length - i))
    ;[free[i], free[j]] = [free[j]!, free[i]!]
  }
  picked.value = free.slice(0, n)
  haptic('select')
  track('pick_random')
}

function clearPick() { picked.value = []; haptic('select') }

/* ---- 跳到號碼 ----
   有人是為了特定號碼來的（生日、幸運數）。250 格裡用捲的找一個號碼很痛苦。 */
const jumpTo = ref<number | null>(null)
const flash = ref<number | null>(null)
const wallEl = ref<HTMLElement | null>(null)

async function jump() {
  const n = jumpTo.value
  if (!pool.value || !n || n < 1 || n > pool.value.totalTickets) return
  await nextTick()
  const el = wallEl.value?.querySelector<HTMLElement>(`[data-seat="${n}"]`)
  if (!el) return
  /* 平滑捲動靠 rAF，在背景分頁或關掉動態效果時不會動 —— 那種情況直接跳過去，
     不然使用者按了「前往」但畫面沒反應，會以為功能壞了 */
  const still = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: still || document.hidden ? 'auto' : 'smooth', block: 'center' })
  // 捲到定位後閃一下：一面都是數字的牆，不指出來人找不到剛才輸入的那格
  flash.value = n
  setTimeout(() => { if (flash.value === n) flash.value = null }, 1600)
}

/* 已選了籤但還沒送出就要離開 —— 問一下。往結果頁的那次不算（是 confirm 觸發的）。
   用原生 confirm：這是不可逆邊界，不需要漂亮，需要的是不會被 CSS 動畫吃掉。 */
let leavingForResult = false
onBeforeRouteLeave(() => {
  if (leavingForResult || busy.value || picked.value.length === 0) return true
  return window.confirm(`要放棄已選的 ${picked.value.length} 支籤嗎？`)
})

async function confirm() {
  if (!pool.value || !ready.value) return
  error.value = ''
  if (!wallet.canAfford(cost.value)) { error.value = '點數不足，請先儲值'; return }
  busy.value = true
  try {
    wallet.spend(cost.value)
    const result = await pools.draw(pool.value.id, [...picked.value])
    track('draw_success')
    leavingForResult = true
    // replace 而不是 push：抽選是不可逆的，返回鍵若能回到選籤牆會讓人以為能重抽
    router.replace({ name: 'draw-result', params: { drawId: result.drawId } })
  } catch {
    error.value = '抽選失敗，點數已退回'
    wallet.topup(cost.value)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="pool" class="wrap">
    <ImmersiveBar :title="pool.title" :fallback="{ name: 'pool', params: { id: pool.id } }">
      <template #right><PoolModeBadge :mode="pool.mode" /></template>
    </ImmersiveBar>

    <div class="container page">
      <h1 class="display">選你的籤</h1>
      <p class="sub">
        剩 <strong class="mono">{{ remaining }}</strong> 支，挑
        <strong class="mono">{{ count }}</strong> 支。籤序開賣前就已封存，位置由你決定。
      </p>

      <!-- 售出進度：這面牆有幾格被抽走，用一條線講比數格子快 -->
      <div class="progress" :aria-label="`已售出 ${soldPct}%`">
        <i :style="{ width: soldPct + '%' }" />
      </div>

      <!-- 快速操作。多數人不在乎抽到第幾號，不該逼他們在 250 格裡找 -->
      <div class="quick">
        <button type="button" class="qbtn go" :disabled="busy" @click="pickRandom">
          隨機挑 {{ count }} 支
        </button>
        <button type="button" class="qbtn" :disabled="busy || !picked.length" @click="clearPick">
          清除
        </button>
        <form class="jump" @submit.prevent="jump">
          <input
            v-model.number="jumpTo" type="number" inputmode="numeric"
            :min="1" :max="pool.totalTickets" placeholder="跳到號碼"
            aria-label="跳到指定號碼"
          >
          <button type="submit" class="qbtn" :disabled="!jumpTo">前往</button>
        </form>
      </div>

      <div ref="wallEl" class="wall card" :class="{ duel: pool.totalTickets <= 2 }">
        <button
          v-for="seat in pool.totalTickets" :key="seat"
          class="ticket"
          :data-seat="seat"
          :class="{ taken: taken.has(seat), on: picked.includes(seat), flash: flash === seat }"
          :disabled="taken.has(seat) || busy"
          :aria-label="taken.has(seat) ? `第 ${seat} 籤（已抽走）` : `第 ${seat} 籤`"
          :aria-pressed="picked.includes(seat)"
          @click="toggle(seat)"
        >
          <span class="no mono">{{ seat }}</span>
        </button>
      </div>

      <div class="bar card">
        <span class="status">
          已選 <strong class="mono">{{ picked.length }}</strong> / {{ count }}
          <span v-if="picked.length" class="muted seats">{{ pickedSorted.map(s => '#' + s).join('、') }}</span>
        </span>
        <strong class="mono cost">{{ cost.toLocaleString() }} 點</strong>
        <button class="btn primary" :disabled="!ready || busy" @click="confirm">
          {{ busy ? '開籤中…' : ready ? '就是這幾支，開！' : `再選 ${count - picked.length} 支` }}
        </button>
        <p v-if="error" class="err" role="alert">{{ error }}</p>
      </div>
    </div>
  </div>
  <div v-else class="container page">
    <p class="muted">找不到這個池。<RouterLink :to="{ name: 'home' }">回抽選列表</RouterLink></p>
  </div>
</template>

<style scoped>
.page { padding-top: 22px; padding-bottom: 72px; }
h1 { margin: 0 0 6px; }
.sub { font-size: 14px; line-height: 1.7; color: var(--muted); margin: 0 0 12px; }

.progress {
  height: 4px; border-radius: 999px; background: var(--surface-3);
  overflow: hidden; margin-bottom: 14px;
}
.progress i { display: block; height: 100%; background: var(--accent); }

/* ---- 快速操作 ---- */
.quick { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
.qbtn {
  padding: 9px 14px; font: inherit; font-size: 13px; font-weight: 600;
  border: 1px solid var(--line); border-radius: 999px;
  background: var(--surface); color: var(--ink); cursor: pointer;
  white-space: nowrap;
}
.qbtn:hover:not(:disabled) { background: var(--surface-2); }
.qbtn:disabled { opacity: .4; cursor: not-allowed; }
.qbtn.go { background: var(--accent-wash); border-color: var(--accent); color: var(--accent); }

.jump { display: flex; gap: 6px; margin-left: auto; }
.jump input {
  width: 108px; padding: 8px 11px; font: inherit; font-size: 16px;
  border: 1px solid var(--line); border-radius: 999px;
  background: var(--field, var(--surface-2)); color: var(--ink);
}
.jump input:focus { outline: none; border-color: var(--accent); }

/* ---- 籤牆 ----
   沒有 perspective。舊版在這裡設 perspective 再用 translateZ 抬起選中的籤，
   而 perspective 的原點是整面牆的中心 —— 牆一高，離中心遠的格子就會被投影
   推到隔壁列去。250 格的池必然踩到。 */
.wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
  gap: 8px; padding: 14px;
  /* 這一大塊自己一層，捲動時不用跟頁面其他部分一起重繪 */
  contain: content;
}
.wall.duel { grid-template-columns: repeat(2, 1fr); gap: 20px; padding: 28px; }

.ticket {
  position: relative;
  aspect-ratio: 1;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--ink);
  font-weight: 700;
  display: grid; place-items: center;
  cursor: pointer;
  transition: transform .16s ease, background-color .16s, border-color .16s;
}
.wall.duel .ticket { aspect-ratio: 3 / 4; font-size: 26px; }

.ticket:hover:not(:disabled) { background: var(--surface-3); }
.ticket:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.ticket.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  /* scale 不會位移，也不需要 3D 圖層 —— 這是修掉跑版的關鍵 */
  transform: scale(1.08);
  z-index: 1;
}

/* 已抽走的籤：拿掉框線與底色，退成背景的一部分。
   舊版用虛線框加「已抽」兩個字，在 250 格的密度下那些字比號碼還搶眼，
   整面牆看起來是滿的而不是空的 */
.ticket.taken {
  background: none;
  border-color: transparent;
  color: var(--faint);
  opacity: .32;
  cursor: not-allowed;
}
.ticket.taken .no { text-decoration: line-through; }

/* 跳到號碼之後閃一下，不然一面都是數字的牆找不到剛才輸入的那格 */
.ticket.flash { animation: seatFlash 1.6s ease-out; }
@keyframes seatFlash {
  0%, 100% { box-shadow: 0 0 0 0 transparent; }
  20%, 60% { box-shadow: 0 0 0 3px var(--accent); }
}

.no { font-size: 13px; }
.wall.duel .no { font-size: 30px; }

/* ---- 結算列 ---- */
.bar {
  position: sticky; bottom: 14px;
  display: flex; flex-wrap: wrap; align-items: center; gap: 16px;
  padding: 12px 18px; margin-top: 18px;
  background: var(--surface);
}
.status { font-size: 14px; }
.seats { font-size: 12px; margin-left: 6px; }
.cost { margin-left: auto; font-size: 19px; color: var(--gold-deep); }
/* 錯誤訊息放在結算列內 —— 手機上結算列是 fixed，放外面會被蓋住 */
.err { flex-basis: 100%; color: var(--danger); font-size: 13.5px; margin: 0; font-weight: 600; }

@media (max-width: 720px) {
  /* 沉浸模式沒有底部導覽，只要讓出結算列自己的高度 + Home 指示器 */
  .page { padding-top: 14px; padding-bottom: calc(118px + var(--safe-b)); }
  h1 { font-size: 23px; }
  .sub { font-size: 13px; margin: 0 0 10px; }

  .quick { gap: 6px; }
  .qbtn { padding: 8px 12px; font-size: 12.5px; }
  .jump { margin-left: 0; width: 100%; }
  .jump input { flex: 1; width: auto; }

  /* 手機一列六格。舊版是五格 3/4 直式，250 格要捲五十列 */
  .wall { grid-template-columns: repeat(6, 1fr); gap: 6px; padding: 10px; }
  .wall.duel { gap: 14px; padding: 18px; }
  .no { font-size: 12px; }

  .bar {
    position: fixed; left: 10px; right: 10px;
    bottom: calc(10px + var(--safe-b));
    z-index: 55;
    display: grid; grid-template-columns: 1fr auto; gap: 6px 12px;
    padding: 10px 14px;
  }
  .status { font-size: 12.5px; }
  .seats { display: block; margin-left: 0; font-size: 11px; }
  .cost { grid-row: 1; grid-column: 2; font-size: 16px; align-self: center; }
  .bar .btn { grid-column: 1 / -1; width: 100%; padding: 11px 0; }
  .err { grid-column: 1 / -1; font-size: 12.5px; }
}
</style>
