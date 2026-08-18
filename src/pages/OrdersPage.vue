<script setup lang="ts">
/**
 * 託管訂單。
 *
 * 一張訂單卡要回答三件事，順序不能亂：現在卡在哪一步、還剩多久、我可以做什麼。
 * 「還剩多久」放在最上面是刻意的 —— 整套機制的重點就是時限，
 * 使用者最需要知道的是「我再不動作會發生什麼」。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useOrdersStore } from '@/stores/orders'
import { useWalletStore } from '@/stores/wallet'
import { actionsFor, deadlineOf, DAY, HOUR, isOpen, looksLikeTracking, remainText, STATUS_TEXT } from '@/shared/escrow'
import type { Order } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import { MOCK } from '@/lib/config'

const store = useOrdersStore()
const wallet = useWalletStore()

const tab = ref<'open' | 'done'>('open')
const shipFor = ref<string | null>(null)
const tracking = ref('')
const disputeFor = ref<string | null>(null)
const reason = ref('')
const hasVideo = ref(false)
/* API 模式：伺服器要影片的 URL 才受理。R2 直傳是下一階段，先讓使用者貼連結 */
const videoUrl = ref('')
const canDispute = () => MOCK ? hasVideo.value : /^https?:\/\/.+/.test(videoUrl.value.trim())

/* 每分鐘重掃一次，讓倒數會動、到期的訂單自己結案。
   真正的推進靠時間戳，這個計時器只是讓畫面跟上，
   所以分頁被凍住也不會算錯 —— 回來時一次補算完。 */
let timer: number | undefined
onMounted(() => {
  store.load()
  timer = window.setInterval(() => store.sweep(), 60_000)
})
onUnmounted(() => clearInterval(timer))

const now = ref(store.now())
setInterval(() => { now.value = store.now() }, 1000)

const list = computed(() =>
  store.orders.filter(o => (tab.value === 'open' ? isOpen(o) : !isOpen(o)))
)
const roleOf = (o: Order) => (o.sellerId === 'me' ? 'seller' : 'buyer') as 'seller' | 'buyer'
const canShip = computed(() => looksLikeTracking(tracking.value))

const err = ref('')
async function doShip(o: Order) {
  if (!canShip.value) return
  err.value = ''
  try {
    // API 模式後端要出貨照；R2 直傳是下一階段，先給一個佔位 URL 讓流程走得通
    await store.ship(o.id, tracking.value.trim(), MOCK ? [] : ['https://placeholder.invalid/ship-photo'])
    shipFor.value = null
    tracking.value = ''
  } catch (e) { err.value = e instanceof Error ? e.message : '出貨失敗' }
}
async function doDispute(o: Order) {
  if (!canDispute()) return
  err.value = ''
  try {
    await store.dispute(o.id, reason.value.trim() || '未說明', true, videoUrl.value.trim())
    disputeFor.value = null
    reason.value = ''
    hasVideo.value = false
    videoUrl.value = ''
  } catch (e) { err.value = e instanceof Error ? e.message : '申訴送出失敗' }
}
</script>

<template>
  <div class="container page">
    <header class="head">
      <h1>我的訂單</h1>
      <p class="muted sub">需寄送的交易會走託管。庫內轉移不產生訂單，成交即結束。</p>
    </header>

    <div class="bal">
      <div><span class="bl">可動用</span><strong class="mono">{{ wallet.available.toLocaleString() }}</strong></div>
      <div><span class="bl">託管中</span><strong class="mono lock">{{ wallet.locked.toLocaleString() }}</strong></div>
    </div>

    <div class="tabs" role="tablist">
      <button type="button" role="tab" :aria-selected="tab === 'open'"
        class="chip" :class="{ on: tab === 'open' }" @click="tab = 'open'">
        進行中 {{ store.openCount }}
      </button>
      <button type="button" role="tab" :aria-selected="tab === 'done'"
        class="chip" :class="{ on: tab === 'done' }" @click="tab = 'done'">已結案</button>
    </div>

    <p v-if="err" class="err" role="alert">{{ err }}</p>
    <p v-if="!list.length" class="empty muted">
      {{ tab === 'open' ? '目前沒有進行中的訂單。到市場買一張「需寄送」的卡就會建立託管訂單。' : '還沒有結案的訂單。' }}
    </p>

    <article v-for="o in list" :key="o.id" class="ord">
      <div class="top">
        <CardArt class="thumb" :image="o.card.image" :alt="o.card.name"
                 :cert-no="o.card.certNo" :art-id="o.card.artId" />
        <div class="meta">
          <strong class="nm">{{ o.card.name }}</strong>
          <p class="who">
            <span class="role" :class="roleOf(o)">{{ roleOf(o) === 'seller' ? '我是賣家' : '我是買家' }}</span>
            {{ roleOf(o) === 'seller' ? o.buyerName : o.sellerName }}
          </p>
          <p class="amt mono">{{ o.price.toLocaleString() }} 點<span v-if="o.deposit"> · 保證金 {{ o.deposit.toLocaleString() }}</span></p>
        </div>
        <span class="st" :class="o.status">{{ STATUS_TEXT[o.status] }}</span>
      </div>

      <!-- 時限：整套機制的重點，放最顯眼 -->
      <div v-if="deadlineOf(o)" class="dl" :class="deadlineOf(o)!.tone">
        <div class="dlTop">
          <span>{{ deadlineOf(o)!.label }}</span>
          <strong class="mono">{{ remainText(deadlineOf(o)!.at - now) }}</strong>
        </div>
        <p>{{ deadlineOf(o)!.then }}</p>
      </div>

      <p v-if="o.tracking" class="trk mono">單號 {{ o.tracking }}</p>
      <p v-if="o.disputeReason" class="dr">爭議：{{ o.disputeReason }}</p>

      <!-- 可做的動作完全由狀態機決定，UI 不自己判斷 -->
      <div class="acts">
        <template v-for="a in actionsFor(o, roleOf(o))" :key="a">
          <button v-if="a === 'ship'" type="button" class="btn primary sm" @click="shipFor = o.id; tracking = ''">
            上傳單號出貨
          </button>
          <button v-if="a === 'confirm'" type="button" class="btn primary sm" @click="store.confirm(o.id)">
            確認收貨
          </button>
          <button v-if="a === 'dispute'" type="button" class="btn sm" @click="disputeFor = o.id">
            我要申訴
          </button>
        </template>

        <!-- demo：物流回報與平台裁決在正式版不是使用者按的 -->
        <button v-if="MOCK && o.status === 'shipped'" type="button" class="btn sm ghost" @click="store.markDelivered(o.id)">
          模擬物流簽收
        </button>
        <template v-if="MOCK && o.status === 'disputed'">
          <button type="button" class="btn sm ghost" @click="store.resolve(o.id, 'buyer')">裁決：判買家</button>
          <button type="button" class="btn sm ghost" @click="store.resolve(o.id, 'seller')">裁決：判賣家</button>
        </template>
      </div>

      <!-- 出貨表單 -->
      <div v-if="shipFor === o.id" class="form">
        <label>
          物流單號
          <input v-model="tracking" type="text" placeholder="例如 ABC12345678" />
        </label>
        <p class="hint">正式版會即時向物流查詢單號是否存在、交寄時間是否晚於訂單成立。目前只擋格式。</p>
        <div class="frow">
          <button type="button" class="btn sm" @click="shipFor = null">取消</button>
          <button type="button" class="btn primary sm" :disabled="!canShip" @click="doShip(o)">確認出貨</button>
        </div>
      </div>

      <!-- 申訴表單：沒有開箱影片不受理 -->
      <div v-if="disputeFor === o.id" class="form">
        <label>
          發生什麼事
          <input v-model="reason" type="text" placeholder="例如：盒內是空的" />
        </label>
        <label v-if="MOCK" class="chk">
          <input v-model="hasVideo" type="checkbox" />
          我有完整未剪輯的開箱影片（從封箱狀態開始、拍到面單與鑑定編號）
        </label>
        <label v-else>
          開箱影片連結（完整未剪輯、從封箱狀態開始、拍到面單與鑑定編號）
          <input v-model="videoUrl" type="url" placeholder="https://…" />
        </label>
        <p class="hint">沒有影片無法受理索賠 —— 買東西不強制錄影，但要申請退款必須附。</p>
        <div class="frow">
          <button type="button" class="btn sm" @click="disputeFor = null">取消</button>
          <button type="button" class="btn primary sm" :disabled="!canDispute()" @click="doDispute(o)">送出申訴</button>
        </div>
      </div>
    </article>

    <!-- 時間旅行：不用真的等 7 天就能看完整條流程。只有 mock 有；伺服器的時間不能撥 -->
    <section v-if="MOCK" class="dev">
      <h2>Demo 時鐘</h2>
      <p class="muted">
        時限是用時間戳算的，不是背景排程 —— 把時鐘往前撥，到期的訂單會立刻自己結案。
        目前偏移 <strong class="mono">{{ Math.round(store.offset / HOUR) }}</strong> 小時。
      </p>
      <div class="devRow">
        <button type="button" class="btn sm" @click="store.travel(HOUR)">+1 小時</button>
        <button type="button" class="btn sm" @click="store.travel(DAY)">+1 天</button>
        <button type="button" class="btn sm" @click="store.travel(3 * DAY)">+3 天</button>
        <button type="button" class="btn sm" @click="store.travel(8 * DAY)">+8 天</button>
        <button type="button" class="btn sm ghost" @click="store.seedSellerOrder({ id: 'demo', name: '噴火龍 ex UR', artId: 'SV4a-349', refPrice: 43680, rarity: 'UR', certNo: '82345671', grade: 10 } as any, 41000)">
          + 賣家視角訂單
        </button>
        <button type="button" class="btn sm ghost" @click="store.reset()">全部清除</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.head { margin-bottom: 14px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { font-size: 13px; margin: 0; }

.bal {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
  background: var(--surface); border-radius: var(--radius-lg);
  padding: 14px 16px; margin-bottom: 14px;
}
.bl { display: block; font-size: 11.5px; color: var(--muted); margin-bottom: 2px; }
.bal strong { font-size: 18px; }
.bal .lock { color: var(--gold); }

.tabs { display: flex; gap: 8px; margin-bottom: 14px; }
.empty { padding: 28px 4px; font-size: 14px; line-height: 1.8; }

.ord { background: var(--surface); border-radius: var(--radius-lg); padding: 14px; margin-bottom: 12px; }
.top { display: grid; grid-template-columns: 52px 1fr auto; gap: 12px; align-items: start; }
.thumb { width: 52px; height: 73px; border-radius: 6px; overflow: hidden; }
.thumb :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.nm { display: block; font-size: 14.5px; line-height: 1.4; margin-bottom: 4px; }
.who { font-size: 12px; color: var(--muted); margin: 0 0 3px; }
.role {
  display: inline-block; font-size: 10px; font-weight: 700;
  padding: 1px 6px; border-radius: var(--pill); margin-right: 5px;
}
.role.buyer { background: var(--accent-wash); color: var(--accent); }
.role.seller { background: var(--ok-wash); color: var(--ok); }
.amt { font-size: 13px; margin: 0; }
.st {
  font-size: 11px; font-weight: 700; white-space: nowrap;
  padding: 4px 9px; border-radius: var(--pill);
  background: var(--surface-3); color: var(--muted);
}
.st.delivered, .st.escrowed, .st.shipped { color: var(--ink); }
.st.disputed { background: var(--danger-wash); color: var(--danger); }
.st.completed { background: var(--ok-wash); color: var(--ok); }

.dl { border-radius: var(--radius); padding: 10px 12px; margin-top: 12px; background: var(--surface-2); }
.dl.warn { box-shadow: inset 2px 0 0 var(--warn); }
.dl.ok { box-shadow: inset 2px 0 0 var(--ok); }
.dl.danger { box-shadow: inset 2px 0 0 var(--danger); }
.dlTop { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.dlTop span { font-size: 12px; color: var(--muted); }
.dlTop strong { font-size: 15px; }
.dl p { font-size: 11.5px; line-height: 1.6; color: var(--muted); margin: 3px 0 0; }

.trk { font-size: 12px; color: var(--muted); margin: 10px 0 0; }
.dr { font-size: 12.5px; color: var(--danger); margin: 8px 0 0; }

.acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.acts .btn.sm { padding: 8px 14px; font-size: 13px; }
.btn.ghost { opacity: .72; font-size: 12px; }

.form { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.form label { display: block; font-size: 12.5px; color: var(--muted); margin-bottom: 8px; }
.form input[type="text"] {
  display: block; width: 100%; margin-top: 5px;
  background: var(--field); border: 1px solid var(--line);
  border-radius: var(--radius); color: var(--ink);
  padding: 10px 12px; font-size: 14px; min-height: 44px;
}
.chk { display: flex; gap: 8px; align-items: flex-start; line-height: 1.6; }
.chk input { margin-top: 3px; width: 18px; height: 18px; flex: none; }
.hint { font-size: 11.5px; line-height: 1.65; color: var(--muted); margin: 0 0 10px; }
.frow { display: flex; gap: 8px; justify-content: flex-end; }

.err { color: var(--danger); font-size: 13.5px; margin: 0 0 12px; }
.dev { margin-top: 26px; padding: 14px 16px; background: var(--surface-2); border-radius: var(--radius-lg); }
.dev h2 { font-size: 14px; margin: 0 0 6px; }
.dev p { font-size: 12.5px; line-height: 1.7; margin: 0 0 10px; }
.devRow { display: flex; flex-wrap: wrap; gap: 8px; }
.devRow .btn.sm { padding: 7px 12px; font-size: 12.5px; }
</style>
