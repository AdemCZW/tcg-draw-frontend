<script setup lang="ts">
// 尾籤競標：限時英式競標，落標全額退還。
// 籤內容不公開 —— 張力來自「已知還剩哪些賞」（見上方獎項表）。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AuctionLot, Pool } from '@/types/models'
import { api } from '@/lib/api'
import { useWalletStore } from '@/stores/wallet'

const props = defineProps<{ pool: Pool }>()
const wallet = useWalletStore()

const lots = ref<AuctionLot[]>([])
const now = ref(Date.now())
const bidInput = ref<Record<string, number>>({})
// 我在各標的上鎖住的金額。被超越時必須確實退還這筆錢。
const myLocked = ref<Record<string, number>>({})
const busy = ref<string | null>(null)
const notice = ref('')
const error = ref('')
let ticker: ReturnType<typeof setInterval> | undefined

const MIN_INCREMENT = 50

onMounted(async () => {
  /* 正式模式下 api.listLots 會直接丟「尾籤競標尚未上線」。要接住它 ——
     不接的話是 onMounted 裡的 unhandled rejection，畫面只會是一塊空白面板，
     使用者看到的是「壞掉」而不是「還沒開」。 */
  try {
    lots.value = await api.listLots(props.pool.id)
  } catch (e) {
    error.value = e instanceof Error && e.message ? e.message : '無法載入競標資訊'
    return
  }
  for (const l of lots.value) bidInput.value[l.id] = l.currentBid + MIN_INCREMENT

  ticker = setInterval(() => {
    now.value = Date.now()
    for (const l of lots.value) {
      if (now.value < l.endsAt || l.status === 'ended') continue
      l.status = 'ended'
      // 保險：結標時若未得標卻仍有鎖定額（例如錯過超越事件），一律退還
      if (!l.youAreTop && myLocked.value[l.id]) {
        wallet.topup(myLocked.value[l.id])
        delete myLocked.value[l.id]
      }
    }
  }, 500)

  /* 這裡原本還有第二個定時器：每 11 秒呼叫一次 mock.rivalBid()，把「對手加價」
     演出來。它沒有被 MOCK 旗標擋住，所以那是平台無條件內建的自動抬價機器人 ——
     對真人顯示「有人出價超過你」，而根本沒有那個人。競標系統最不能有的就是這個，
     所以直接刪掉，不是關掉。真實的對手出價要靠後端推播（SSE / WebSocket），
     等競標真的有後端時再接。 */
})

onUnmounted(() => { clearInterval(ticker) })

function remain(lot: AuctionLot) {
  const ms = Math.max(0, lot.endsAt - now.value)
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}:${String(s).padStart(2, '0')}`
}
const closingSoon = (lot: AuctionLot) => lot.endsAt - now.value < 60_000 && lot.status === 'live'

async function bid(lot: AuctionLot) {
  error.value = ''; notice.value = ''
  const amount = Number(bidInput.value[lot.id])
  if (!Number.isFinite(amount) || amount < lot.currentBid + MIN_INCREMENT) {
    error.value = `出價至少要 ${(lot.currentBid + MIN_INCREMENT).toLocaleString()} 點`
    return
  }
  // 已是最高出價者時只需補差額（舊出價會全額退還）
  const owed = lot.youAreTop ? amount - lot.currentBid : amount
  if (!wallet.canAfford(owed)) { error.value = '點數不足，請先儲值'; return }

  busy.value = lot.id
  try {
    wallet.spend(owed)
    const { lot: updated, refunded } = await api.placeBid(lot.id, amount)
    Object.assign(lot, updated)
    myLocked.value[lot.id] = amount   // 加價時舊額併入，鎖定額即為新出價
    bidInput.value[lot.id] = updated.currentBid + MIN_INCREMENT
    notice.value = refunded
      ? `已加價到 ${amount.toLocaleString()} 點（前次出價 ${refunded.toLocaleString()} 點已折抵，實扣 ${owed.toLocaleString()}）`
      : `出價 ${amount.toLocaleString()} 點成功，你目前是最高出價者`
  } catch {
    error.value = '出價失敗，點數已退回'
    wallet.topup(owed)
  } finally { busy.value = null }
}

const liveCount = computed(() => lots.value.filter(l => l.status === 'live').length)
</script>

<template>
  <div class="auction">
    <div class="head">
      <h2>尾籤競標</h2>
      <span class="chip">{{ liveCount }} 支進行中</span>
    </div>
    <p class="intro muted">
      最後 {{ pool.auctionSeats }} 支籤改由競標決定得主。<strong>籤的內容不公開</strong>——
      你能看到的是上方獎項表「還剩什麼沒出」，自己判斷值多少。落標者全額退還，最後一分鐘內有人出價會自動延長 60 秒。
    </p>

    <div class="lots">
      <div v-for="lot in lots" :key="lot.id" class="lot card" :class="{ ended: lot.status === 'ended', mine: lot.youAreTop }">
        <div class="lot-head">
          <span class="seat display">籤 #{{ lot.seat }}</span>
          <span class="clock mono" :class="{ hot: closingSoon(lot) }">
            {{ lot.status === 'ended' ? '已結標' : remain(lot) }}
          </span>
        </div>

        <div class="bid-now">
          <span class="muted lbl">目前最高</span>
          <strong class="mono amount">{{ lot.currentBid.toLocaleString() }} 點</strong>
          <span class="muted who">
            {{ lot.topBidder ? (lot.youAreTop ? '你' : lot.topBidder) : '尚無人出價' }}
            · {{ lot.bidCount }} 次出價
          </span>
        </div>

        <div v-if="lot.status === 'live'" class="bid-form">
          <input
            v-model.number="bidInput[lot.id]"
            type="number"
            class="bid-input mono"
            :min="lot.currentBid + MIN_INCREMENT"
            :step="MIN_INCREMENT"
            :aria-label="`第 ${lot.seat} 籤出價金額`"
          />
          <button class="btn primary" :disabled="busy === lot.id" @click="bid(lot)">
            {{ busy === lot.id ? '送出中…' : lot.youAreTop ? '加價' : '出價' }}
          </button>
        </div>
        <p v-else class="result mono">
          {{ lot.youAreTop ? '你得標了' : `由 ${lot.topBidder ?? '—'} 得標` }}
        </p>

        <p v-if="lot.youAreTop && lot.status === 'live'" class="lead">你目前領先</p>
      </div>
    </div>

    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.auction { margin-top: 20px; }
.head { display: flex; align-items: center; gap: 10px; }
h2 { font-size: 16px; margin: 0; }
.intro { font-size: 12.5px; margin: 8px 0 14px; }
.lots { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
.lot { padding: 14px; display: grid; gap: 10px; }
.lot.ended { opacity: .6; }
.lot.mine { border-color: var(--ok); box-shadow: 4px 4px 0 color-mix(in srgb, var(--ok) 70%, var(--ink)); }
.lot-head { display: flex; align-items: baseline; justify-content: space-between; }
.seat { font-size: 15px; }
.clock { font-size: 13px; font-weight: 600; padding: 1px 8px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-2); }
.clock.hot { background: var(--accent); color: #fff; }
.bid-now { display: grid; gap: 1px; }
.lbl { font-size: 11px; font-weight: 600; }
.amount { font-size: 21px; color: var(--gold-deep); }
.who { font-size: 11.5px; }
.bid-form { display: flex; gap: 8px; }
.bid-input {
  flex: 1; min-width: 0;
  padding: 8px 10px; font-size: 14px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface);
}
.bid-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.result { font-size: 13px; font-weight: 600; margin: 0; }
.lead { margin: 0; font-size: 12px; font-weight: 600; color: var(--ok); }
.notice { font-size: 12.5px; font-weight: 600; color: var(--ok); margin: 12px 0 0; }
.err { font-size: 13px; font-weight: 600; color: var(--danger); margin: 8px 0 0; }
@media (max-width: 720px) {
  .lots { grid-template-columns: 1fr; gap: 12px; }
  .intro { font-size: 12px; }
}
</style>
