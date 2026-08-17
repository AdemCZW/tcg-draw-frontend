<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '@/lib/api'
import type { UserPrize } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import Tilt3D from '@/components/Tilt3D.vue'
import TierBadge from '@/components/TierBadge.vue'
import CertTag from '@/components/CertTag.vue'
import { useWalletStore } from '@/stores/wallet'
import { recycleQuote, RECYCLE_RATE } from '@/lib/recycle'
import { track } from '@/lib/ga'

const wallet = useWalletStore()
const prizes = ref<UserPrize[]>([])
onMounted(async () => { prizes.value = await api.myPrizes() })

/* ---- 收藏總覽 ----
   卡冊原本是一長串扁平清單，看不出「我收了多少、值多少」。
   對抽卡的人來說那是這一頁最想知道的事，所以拉到最上面。
   已回收的不計入市值 —— 卡已經交還平台了，還算進總值是騙自己。 */
const owned = computed(() => prizes.value.filter(p => p.status !== 'recycled'))
const totalValue = computed(() => owned.value.reduce((s, p) => s + p.card.refPrice, 0))
const bestCard = computed(() =>
  owned.value.reduce<UserPrize | null>((b, p) => (!b || p.card.refPrice > b.card.refPrice ? p : b), null))

/* ---- 狀態分頁 ----
   寄存中要出貨、待出貨要等、已出貨是歷史 —— 三種狀態的下一步動作完全不同，
   混在同一張清單裡每張卡都要重新判斷「這張現在能做什麼」。 */
type Tab = 'all' | UserPrize['status']
const tab = ref<Tab>('all')
const TABS: { k: Tab; label: string }[] = [
  { k: 'all', label: '全部' },
  { k: 'stashed', label: '寄存中' },
  { k: 'ship_requested', label: '待出貨' },
  { k: 'shipped', label: '已出貨' },
  { k: 'recycled', label: '已回收' }
]
const countOf = (k: Tab) => k === 'all' ? prizes.value.length : prizes.value.filter(p => p.status === k).length
const tabs = computed(() => TABS.filter(t => countOf(t.k) > 0))
const shown = computed(() => tab.value === 'all' ? prizes.value : prizes.value.filter(p => p.status === tab.value))

const statusLabel: Record<UserPrize['status'], string> = {
  stashed: '寄存中',
  ship_requested: '待出貨',
  shipped: '已出貨',
  recycled: '已回收'
}

function requestShip(p: UserPrize) {
  track('click_ship_request')
  p.status = 'ship_requested'
  track('ship_request_success')
}

/* 回收是不可逆的（卡片交還平台換點數），所以一定要有一段確認，
   而且確認畫面要把「換多少點」和「點數不能提現」同時講清楚。
   用行內展開而不是 window.confirm —— 原生對話框放不下這些資訊。 */
const confirming = ref<string | null>(null)
const justRecycled = ref<{ id: string; points: number } | null>(null)

function askRecycle(p: UserPrize) {
  track('click_recycle')
  confirming.value = confirming.value === p.id ? null : p.id
}

function doRecycle(p: UserPrize) {
  const q = recycleQuote(p.card)
  if (!q.eligible) return
  wallet.creditRecycle(q.points, `回收 ${p.card.name}`)
  p.status = 'recycled'
  confirming.value = null
  justRecycled.value = { id: p.id, points: q.points }
  setTimeout(() => { justRecycled.value = null }, 4000)
  track('recycle_success')
}
</script>

<template>
  <div class="container page">
    <h1>我的卡冊</h1>

    <!-- 收藏總覽：這一頁最想被回答的問題就是「我收了多少、值多少」 -->
    <section v-if="owned.length" class="overview card">
      <div class="ovCell">
        <span class="ovLabel">持有</span>
        <strong class="ovNum mono">{{ owned.length }}</strong>
        <span class="ovUnit">張</span>
      </div>
      <div class="ovCell">
        <span class="ovLabel">市值合計</span>
        <strong class="ovNum mono val">{{ totalValue.toLocaleString() }}</strong>
      </div>
      <div class="ovBest" v-if="bestCard">
        <span class="ovLabel">最高價</span>
        <span class="ovBestRow">
          <TierBadge :tier="bestCard.tier" />
          <strong>{{ bestCard.card.name }}</strong>
        </span>
      </div>
    </section>

    <p class="muted note">寄存中的卡可合併出貨（省運費），寄存期限 90 天。</p>

    <div v-if="!prizes.length" class="empty card">
      <p>卡冊還是空的。</p>
      <RouterLink :to="{ name: 'home' }" class="btn primary">去抽第一張</RouterLink>
    </div>

    <!-- 狀態分頁：三種狀態的下一步動作完全不同，分開才不用每張卡重新判斷 -->
    <div v-if="tabs.length > 1" class="tabs" role="tablist">
      <button
        v-for="t in tabs" :key="t.k"
        type="button" role="tab" :aria-selected="tab === t.k"
        class="tab" :class="{ on: tab === t.k }"
        @click="tab = t.k"
      >{{ t.label }}<span class="tabN mono">{{ countOf(t.k) }}</span></button>
    </div>

    <div class="grid">
      <div v-for="p in shown" :key="p.id" class="item card" :class="{ dim: p.status === 'recycled' }">
        <Tilt3D :max="14">
          <CardArt :image="p.card.image" :alt="p.card.name" :tier="p.tier" :cert-no="p.card.certNo" :art-id="p.card.artId" :caption="`${p.card.setCode.toUpperCase()} · ${p.card.cardNo}`" />
        </Tilt3D>
        <div class="body">
          <div class="row"><TierBadge :tier="p.tier" /><span class="chip">{{ statusLabel[p.status] }}</span></div>
          <strong>{{ p.card.name }}</strong>
          <CertTag :card="p.card" />
          <span class="mono muted exp" v-if="p.status === 'stashed'">寄存至 {{ p.stashExpiresAt }}</span>

          <p v-if="justRecycled?.id === p.id" class="got" role="status">
            已入帳 <strong class="mono">+{{ justRecycled.points.toLocaleString() }}</strong> 點
          </p>

          <div class="acts" v-if="p.status === 'stashed'">
            <button class="btn primary sm" @click="requestShip(p)">申請出貨</button>
            <button
              class="btn sm" @click="askRecycle(p)"
              :disabled="!recycleQuote(p.card).eligible"
              :title="recycleQuote(p.card).reason"
            >
              回收 +{{ recycleQuote(p.card).points.toLocaleString() }} 點
            </button>
          </div>

          <!-- 回收確認：不可逆，所以把報價與提現限制一次講完 -->
          <div v-if="confirming === p.id && p.status === 'stashed'" class="confirm">
            <dl class="quote">
              <div><dt>卡片市值</dt><dd class="mono">{{ p.card.refPrice.toLocaleString() }}</dd></div>
              <div><dt>回收率</dt><dd class="mono">{{ Math.round(RECYCLE_RATE * 100) }}%</dd></div>
              <div class="tot">
                <dt>你會拿到</dt>
                <dd class="mono">+{{ recycleQuote(p.card).points.toLocaleString() }} 點</dd>
              </div>
            </dl>
            <p class="warn">
              卡片交還平台後<strong>無法取回</strong>。
              點數只能用於站內抽選，<strong>不可提領現金、不可轉讓他人</strong>。
            </p>
            <div class="acts">
              <button class="btn primary sm" @click="doRecycle(p)">確認回收</button>
              <button class="btn sm" @click="confirming = null">取消</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---- 收藏總覽 ---- */
.overview {
  display: flex; align-items: center; gap: 26px; flex-wrap: wrap;
  padding: 16px 18px; margin: 14px 0 10px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--accent) 8%, transparent), transparent 70%),
    var(--surface);
}
.ovCell { display: grid; gap: 2px; }
.ovLabel { font-size: 11.5px; color: var(--faint); letter-spacing: .04em; }
.ovNum { font-size: 26px; font-weight: 800; letter-spacing: -.02em; line-height: 1.1; }
.ovNum.val { color: var(--gold, #d8b25a); }
.ovUnit { font-size: 11.5px; color: var(--muted); }
.ovBest { display: grid; gap: 4px; margin-left: auto; min-width: 0; }
.ovBestRow { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ovBestRow strong { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ---- 狀態分頁 ---- */
.tabs {
  display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none;
  margin: 4px 0 16px; padding-bottom: 2px;
  -webkit-mask-image: linear-gradient(90deg, #000 0 calc(100% - 24px), transparent);
  mask-image: linear-gradient(90deg, #000 0 calc(100% - 24px), transparent);
}
.tabs::-webkit-scrollbar { display: none; }
.tab {
  flex: none; min-height: 44px;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 8px 15px; border-radius: var(--pill);
  border: 1px solid var(--line-soft); background: transparent;
  color: var(--muted); font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s;
}
.tab.on { background: var(--ink); color: var(--bg); border-color: transparent; font-weight: 600; }
.tabN { font-size: 11px; opacity: .65; }
.tab.on .tabN { opacity: .8; }
@media (hover: hover) { .tab:not(.on):hover { color: var(--ink); border-color: var(--line); } }

@media (max-width: 720px) {
  .overview { gap: 18px; padding: 14px; }
  .ovNum { font-size: 22px; }
  .ovBest { margin-left: 0; width: 100%; }
}


.page { padding-top: 36px; padding-bottom: 72px; }
h1 { font-size: 22px; margin: 0 0 6px; }
.note { font-size: 13px; margin: 0 0 22px; }
.empty { padding: 40px; text-align: center; display: grid; gap: 12px; justify-items: center; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 18px; }
.item { padding: 12px; }
.item.dim { opacity: .5; }
.body { display: grid; gap: 8px; padding: 12px 4px 4px; justify-items: start; }
.row { display: flex; gap: 8px; align-items: center; }
strong { font-size: 14px; }
.exp { font-size: 11.5px; }
.acts { display: flex; gap: 8px; margin-top: 4px; }
.btn.sm { padding: 6px 12px; font-size: 12.5px; }

.got {
  margin: 0; font-size: 12.5px; color: var(--ok);
  font-weight: 600;
}
.got strong { color: var(--ok); }

/* 回收確認 —— 撐滿卡片寬度，讓報價與警語不被擠成兩欄 */
.confirm {
  justify-self: stretch;
  margin-top: 6px; padding: 12px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 12px;
  display: grid; gap: 10px;
}
.quote { margin: 0; display: grid; gap: 5px; font-size: 12.5px; }
.quote div { display: flex; justify-content: space-between; gap: 10px; }
.quote dt { color: var(--muted); }
.quote dd { margin: 0; }
.quote .tot {
  padding-top: 6px; border-top: 1px dashed var(--line);
  font-weight: 600;
}
.quote .tot dd { color: var(--ok); }
.warn { margin: 0; font-size: 11.5px; line-height: 1.55; color: var(--muted); }
.warn strong { color: var(--danger); font-weight: 600; }
.confirm .acts { margin-top: 0; }
.confirm .acts .btn { flex: 1; }

@media (max-width: 720px) {
  .page { padding-top: 22px; padding-bottom: 40px; }
  h1 { font-size: 19px; }
  .note { font-size: 12px; margin: 0 0 16px; }
  .grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .item { padding: 8px; }
  .body { gap: 6px; padding: 9px 2px 2px; }
  .row { flex-wrap: wrap; gap: 5px; }
  strong { font-size: 12.5px; line-height: 1.35; }
  .exp { font-size: 10.5px; }
  /* 半寬放不下並排按鈕。grid 的水平拉伸要用 justify-self（align-self 是垂直軸） */
  .acts { flex-direction: column; justify-self: stretch; gap: 6px; }
  .btn.sm { width: 100%; padding: 9px 6px; font-size: 12px; }

  /* 兩欄格線下每張卡內容區只剩約 115px，報價的標籤與數字並排會被折成四行。
     改成標籤在上、數字在下，數字本身禁止換行。 */
  .confirm { padding: 10px; }
  .quote div { flex-direction: column; align-items: flex-start; gap: 0; }
  .quote dt { font-size: 11px; }
  .quote dd { white-space: nowrap; font-size: 13px; }
  .quote .tot dd { font-size: 15px; }
}
</style>
