<script setup lang="ts">
// 連莊爆賞：付一次入場費 → 反覆「選籤 → 揭曉 → 收手 or 賭下去」
// 抽到 BUST 該輪全數沒收（沒收品流入賣家下一池，不回本池，以保籤序可驗證）
import { computed, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { usePoolStore } from '@/stores/pools'
import { useWalletStore } from '@/stores/wallet'
import type { StreakRun, DrawResultItem } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import TierBadge from '@/components/TierBadge.vue'
import PoolModeBadge from '@/components/PoolModeBadge.vue'
import ImmersiveBar from '@/components/ImmersiveBar.vue'
import { track } from '@/lib/ga'

type Phase = 'idle' | 'picking' | 'revealing' | 'decide' | 'busted'

const route = useRoute()
const router = useRouter()
const pools = usePoolStore()
const wallet = useWalletStore()

const pool = computed(() => pools.byId(String(route.params.id)))
const run = ref<StreakRun | null>(null)
const phase = ref<Phase>('idle')

/* 進行中的一輪有暫持獎品，離開要問一聲。往結果頁（收手落袋）的那次不算。
   後端 mock 裡 run 仍在，所以答案是「會保留」—— 但這版還沒有從 /me 回到進行中
   run 的入口，先誠實說「離開後這一輪無法接續」。 */
let leavingForResult = false
onBeforeRouteLeave(() => {
  const inRun = ['picking', 'revealing', 'decide'].includes(phase.value)
  if (leavingForResult || !inRun) return true
  return window.confirm('這一輪還在進行中，離開後無法接續。確定要離開？')
})
const lastItem = ref<DrawResultItem | null>(null)
const flipped = ref(false)
const busy = ref(false)
const error = ref('')

onMounted(() => pools.ensureLoaded())

const taken = computed(() => new Set(pool.value?.takenSeats ?? []))
const held = computed(() => run.value?.items ?? [])
const heldValue = computed(() => run.value?.heldValue ?? 0)
const entry = computed(() => pool.value?.ticketPrice ?? 0)
// 爆賞剩幾支 / 總剩幾籤 —— 這是玩家決定續不續的關鍵資訊，必須攤開
const bustLeft = computed(() => pool.value?.prizes.find(p => p.tier === 'BUST')?.remaining ?? 0)
const seatsLeft = computed(() => pool.value?.remainingTickets ?? 0)
const bustPct = computed(() => seatsLeft.value ? Math.round((bustLeft.value / seatsLeft.value) * 100) : 0)
// 爆掉後 items 只剩保底卡
const floorItem = computed(() => run.value?.status === 'busted' ? run.value.items[0] : null)
// 未開局時先讓玩家知道保底是什麼
const floorCard = computed(() => pool.value?.prizes.find(p => p.tier === 'BUST')?.card)

async function start() {
  if (!pool.value) return
  error.value = ''
  if (!wallet.canAfford(entry.value)) { error.value = '點數不足，請先儲值'; return }
  busy.value = true
  try {
    wallet.spend(entry.value)
    run.value = await pools.startStreak(pool.value.id)
    phase.value = 'picking'
    track('click_draw_1')
  } catch {
    error.value = '無法開始，點數已退回'
    wallet.topup(entry.value)
  } finally { busy.value = false }
}

async function pick(seat: number) {
  if (!run.value || taken.value.has(seat) || busy.value) return
  busy.value = true
  phase.value = 'revealing'
  flipped.value = false
  try {
    const before = run.value.items.length
    const updated = await pools.streakDraw(pool.value!.id, run.value.runId, seat)
    run.value = updated
    if (updated.status === 'busted') {
      lastItem.value = null
      phase.value = 'busted'
      track('draw_failed_soldout')
    } else {
      lastItem.value = updated.items[before] ?? updated.items[updated.items.length - 1]
      phase.value = 'decide'
      setTimeout(() => { flipped.value = true }, 60)
    }
  } finally { busy.value = false }
}

async function bank() {
  if (!run.value) return
  busy.value = true
  try {
    const result = await pools.bankStreak(run.value.runId)
    track('draw_success')
    leavingForResult = true
    // replace 而不是 push：抽選是不可逆的，返回鍵若能回到選籤牆會讓人以為能重抽
    router.replace({ name: 'draw-result', params: { drawId: result.drawId } })
  } finally { busy.value = false }
}

function pushOn() {
  phase.value = 'picking'
  lastItem.value = null
}
</script>

<template>
  <div v-if="pool" class="wrap">
    <ImmersiveBar :title="pool.title" :fallback="{ name: 'pool', params: { id: pool.id } }">
      <template #right><PoolModeBadge :mode="pool.mode" /></template>
    </ImmersiveBar>
  <div class="container page">
    <div class="head">
      <h1 class="display">連莊爆賞</h1>
    </div>
    <p class="sub"><strong>{{ pool.title }}</strong> — 入場 {{ entry.toLocaleString() }} 點，之後每一抽都免費。收手就落袋，抽到爆賞全部歸零。</p>

    <!-- 風險儀表：續不續的判斷依據 -->
    <div class="gauge card" v-if="phase !== 'idle'">
      <div class="g-item">
        <span class="g-label">暫持獎品</span>
        <strong class="g-val">{{ held.length }} 張</strong>
      </div>
      <div class="g-item">
        <span class="g-label">暫持價值</span>
        <strong class="g-val mono money">{{ heldValue.toLocaleString() }}</strong>
      </div>
      <div class="g-item risk" :class="{ hot: bustPct >= 25 }">
        <span class="g-label">下一抽爆掉機率</span>
        <strong class="g-val mono">{{ bustPct }}%</strong>
        <span class="g-sub">爆賞剩 {{ bustLeft }} / {{ seatsLeft }} 籤</span>
      </div>
    </div>

    <!-- 起手 -->
    <div v-if="phase === 'idle'" class="stage card">
      <p class="big">準備好了嗎？</p>
      <p class="muted">爆賞共 {{ pool.prizes.find(p => p.tier === 'BUST')?.total }} 支藏在 {{ pool.totalTickets }} 籤裡，位置開賣前就已封存。</p>
      <p v-if="floorCard" class="muted fine">
        就算抽到爆賞也不會空手 —— 暫持獎品沒收，但保底卡
        <strong>{{ floorCard.name }}</strong>（市值 {{ floorCard.refPrice.toLocaleString() }}）一定帶得走。
      </p>
      <button class="btn primary lg" :disabled="busy" @click="start">
        {{ busy ? '準備中…' : `付 ${entry.toLocaleString()} 點入場` }}
      </button>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </div>

    <!-- 選籤 -->
    <div v-else-if="phase === 'picking'" class="wall card">
      <button
        v-for="seat in pool.totalTickets" :key="seat"
        class="ticket" :class="{ taken: taken.has(seat) }"
        :disabled="taken.has(seat) || busy"
        :aria-label="taken.has(seat) ? `第 ${seat} 籤（已抽走）` : `抽第 ${seat} 籤`"
        @click="pick(seat)"
      >
        <span class="no mono">{{ seat }}</span>
        <span v-if="taken.has(seat)" class="gone">已抽</span>
      </button>
    </div>

    <!-- 揭曉 + 決策 -->
    <div v-else-if="phase === 'revealing' || phase === 'decide'" class="stage card">
      <div class="reveal" v-if="lastItem">
        <div class="flip" :class="{ on: flipped }">
          <div class="face back" aria-hidden="true"><span class="display q">?</span></div>
          <div class="face front">
            <CardArt :image="lastItem.card.image" :alt="lastItem.card.name" :tier="lastItem.tier" :cert-no="lastItem.card.certNo" />
          </div>
        </div>
        <div class="got">
          <TierBadge :tier="lastItem.tier" />
          <strong>{{ lastItem.card.name }}</strong>
          <span class="mono muted">+{{ lastItem.card.refPrice.toLocaleString() }}</span>
        </div>
      </div>
      <p v-else class="muted">開籤中…</p>

      <div class="choice" v-if="phase === 'decide'">
        <button class="btn primary lg" :disabled="busy" @click="bank">
          收手落袋（{{ heldValue.toLocaleString() }}）
        </button>
        <button class="btn danger lg" :disabled="busy || seatsLeft <= 0" @click="pushOn">
          賭下去！再抽一支
        </button>
      </div>
    </div>

    <!-- 爆掉：暫持沒收，但仍發保底卡 -->
    <div v-else-if="phase === 'busted'" class="stage card bust">
      <p class="big">爆賞！</p>
      <p>本輪暫持的獎品全數沒收。</p>

      <div class="floor" v-if="floorItem">
        <p class="floor-label">但保底卡是你的</p>
        <div class="floor-card">
          <CardArt :image="floorItem.card.image" :alt="floorItem.card.name" :cert-no="floorItem.card.certNo" />
        </div>
        <strong>{{ floorItem.card.name }}</strong>
        <span class="mono muted">市值 {{ floorItem.card.refPrice.toLocaleString() }}</span>
      </div>

      <p class="muted fine">沒收的卡片將流入賣家的下一波獎池，並公開記錄；本池籤序不受影響，仍可事後驗算。</p>
      <div class="choice">
        <button class="btn primary lg" :disabled="busy" @click="bank">收下保底卡</button>
        <button class="btn" :disabled="busy" @click="phase = 'idle'; run = null">再來一輪</button>
      </div>
    </div>
  </div>
  </div>
  <div v-else class="container page"><p class="muted">找不到這個池。<RouterLink :to="{ name: 'pool-index' }">回抽選列表</RouterLink></p></div>
</template>

<style scoped>
.page { padding-top: 28px; padding-bottom: 72px; }
.head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
h1 { font-size: 30px; margin: 0; }
.sub { margin: 10px 0 18px; font-size: 14.5px; color: var(--muted); }

.gauge { display: flex; gap: 10px; padding: 14px 18px; margin-bottom: 16px; }
.g-item { display: grid; gap: 2px; flex: 1; }
.g-label { font-size: 11.5px; color: var(--muted); font-weight: 600; }
.g-val { font-size: 20px; }
.money { color: var(--gold-deep); }
.g-sub { font-size: 11px; color: var(--faint); }
.risk .g-val { color: var(--ok); }
.risk.hot .g-val { color: var(--danger); }

.stage { padding: 26px 20px; text-align: center; display: grid; gap: 12px; justify-items: center; }
.big { font-size: 22px; font-weight: 600; margin: 0; }
.lg { padding: 13px 26px; font-size: 15.5px; }
.btn.danger { background: var(--accent); color: #fff; }
.choice { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; margin-top: 6px; }
.err { color: var(--danger); font-size: 13.5px; font-weight: 600; margin: 0; }

.reveal { display: grid; gap: 12px; justify-items: center; }
.flip { width: 168px; perspective: 900px; position: relative; transform-style: preserve-3d; transition: transform .55s cubic-bezier(.2,.7,.3,1); }
.flip.on { transform: rotateY(180deg); }
@media (prefers-reduced-motion: reduce) { .flip { transition: none; } }
.face { backface-visibility: hidden; border-radius: var(--radius); }
.face.back {
  position: absolute; inset: 0;
  display: grid; place-items: center;
  border: 1px solid var(--line); background: var(--surface-2);
}
.q { font-size: 40px; color: var(--faint); }
.face.front { transform: rotateY(180deg); }
.got { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center; }

.bust { background: color-mix(in srgb, var(--danger) 8%, var(--surface)); }
.floor {
  display: grid; gap: 6px; justify-items: center;
  padding: 16px 20px; margin: 4px 0;
  background: var(--surface); border-radius: var(--radius-lg);
}
.floor-label { margin: 0; font-size: 13px; font-weight: 600; color: var(--ok); }
.floor-card { width: 96px; }
.floor strong { font-size: 14.5px; }
.fine { font-size: 12px; max-width: 420px; }

.wall { perspective: 1000px; display: grid; grid-template-columns: repeat(auto-fill, minmax(62px, 1fr)); gap: 10px; padding: 18px; }
.ticket {
  position: relative; aspect-ratio: 3 / 4;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  font-weight: 600; display: grid; place-items: center;
  transform-style: preserve-3d;
  transition: transform .22s cubic-bezier(.2,.7,.3,1), box-shadow .22s;
}
.ticket:hover:not(:disabled) {
  transform: translateZ(34px) rotateX(9deg);
  box-shadow: 0 18px 34px rgba(26, 22, 20, .18);
  background: var(--accent-wash);
  z-index: 2;
}
.ticket:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ticket.taken { background: var(--surface-2); border-style: dashed; box-shadow: none; color: var(--faint); cursor: not-allowed; opacity: .55; }
.no { font-size: 13px; }
.gone { position: absolute; bottom: 6px; font-size: 10px; color: var(--faint); font-weight: 600; }

@media (max-width: 720px) {
  .page { padding-top: 20px; padding-bottom: 40px; }
  h1 { font-size: 23px; }
  .sub { font-size: 13px; }
  .gauge { flex-wrap: wrap; gap: 12px 10px; padding: 12px 14px; }
  .g-item { flex: 1 1 40%; }
  .g-val { font-size: 17px; }
  .wall { grid-template-columns: repeat(5, 1fr); gap: 7px; padding: 12px; }
  .no { font-size: 12px; }
  .gone { font-size: 9px; bottom: 4px; }
  .choice { flex-direction: column; align-self: stretch; width: 100%; }
  .choice .btn { width: 100%; }
}
</style>
