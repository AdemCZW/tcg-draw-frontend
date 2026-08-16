<script setup lang="ts">
/**
 * 市場 —— 玩家之間直接買賣卡片，不經過抽選。
 *
 * 為什麼要有這一頁：抽選是碰運氣，但「我就是要這張」跟「我這張想出掉」
 * 是兩個真實需求。原本只有「回收給平台換 70% 點數」一條出口 ——
 * 那是保底價，不是市價。市場讓賣方自己定價、買方直接拿到指定卡。
 *
 * 成交幣別是點數，且點數永不可提現（見 lib/recycle.ts 的完整理由）。
 * 玩家互相買賣仍在站內閉環，這是整套合規論述的地基。
 */
import { computed, onMounted, ref } from 'vue'
import { api } from '@/lib/api'
import type { Listing } from '@/types/models'
import { useWalletStore } from '@/stores/wallet'
import { useAuthStore } from '@/stores/auth'
import CardArt from '@/components/CardArt.vue'
import Tilt3D from '@/components/Tilt3D.vue'
import CertTag from '@/components/CertTag.vue'
import RollingNumber from '@/components/RollingNumber.vue'
import { haptic } from '@/lib/haptics'
import { track } from '@/lib/ga'

const wallet = useWalletStore()
const auth = useAuthStore()

const listings = ref<Listing[]>([])
const loading = ref(true)
onMounted(async () => {
  listings.value = await api.listMarket()
  loading.value = false
  track('view_market')
})

/* 排序而不是篩選：市場的品項還不多，先給「怎麼排」比「濾掉什麼」有用。
   低於市值放第一個 —— 那是使用者真正在找的東西。 */
type Sort = 'deal' | 'new' | 'cheap' | 'pricey'
const sort = ref<Sort>('deal')
const SORTS: { k: Sort; label: string }[] = [
  { k: 'deal', label: '低於市值' },
  { k: 'new', label: '最新上架' },
  { k: 'cheap', label: '價格低到高' },
  { k: 'pricey', label: '價格高到低' }
]

/** 掛價相對市值的折數。負數＝比市值便宜 */
const diffPct = (l: Listing) => Math.round(((l.price - l.card.refPrice) / l.card.refPrice) * 100)

const shown = computed(() => {
  const live = listings.value.filter(l => l.status === 'live')
  const a = [...live]
  if (sort.value === 'deal') return a.sort((x, y) => diffPct(x) - diffPct(y))
  if (sort.value === 'cheap') return a.sort((x, y) => x.price - y.price)
  if (sort.value === 'pricey') return a.sort((x, y) => y.price - x.price)
  return a   // 'new'：mock 已依上架時間排好
})

/* 買 —— 不可逆（點數扣掉、卡片入卡冊），所以要一段確認。
   行內展開而不是 window.confirm：要把價格、市值、餘額變化一起講清楚。 */
const confirming = ref<string | null>(null)
const busy = ref<string | null>(null)
const bought = ref<Listing | null>(null)
const error = ref('')

function ask(l: Listing) {
  error.value = ''
  confirming.value = confirming.value === l.id ? null : l.id
}

async function buy(l: Listing) {
  if (!wallet.canAfford(l.price)) {
    error.value = '點數不足，請先儲值'
    return
  }
  busy.value = l.id
  error.value = ''
  try {
    await api.buyListing(l.id)
    wallet.spend(l.price)
    markSold(l.id)
    confirming.value = null
    bought.value = l
    haptic('success')
    track('market_buy_success')
    setTimeout(() => { bought.value = null }, 4500)
  } catch {
    error.value = '這張剛剛被買走了'
    markSold(l.id)
  } finally {
    busy.value = null
  }
}

/* 換掉整個陣列，而不是改 item.status。
   mock 的 api.buyListing 會直接改共用的 mock 陣列，等這裡再寫一次
   l.status = 'sold' 時值已經是 'sold' —— Vue 的 setter 看到沒變就不觸發，
   賣掉的卡不會消失，使用者可以再買一次被重複扣款。
   重建陣列讓「畫面更新」不依賴那次寫入到底有沒有變動。 */
function markSold(id: string) {
  listings.value = listings.value.map(x => (x.id === id ? { ...x, status: 'sold' as const } : x))
}
</script>

<template>
  <div class="container page">
    <header class="head">
      <div>
        <h1>市場</h1>
        <p class="muted sub">玩家直接買賣，不用碰運氣</p>
      </div>
      <RouterLink :to="{ name: 'cards' }" class="sell">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        我要上架
      </RouterLink>
    </header>

    <!-- 排序：極簡橫向膠囊 -->
    <div class="sorts" role="tablist" aria-label="排序方式">
      <button
        v-for="s in SORTS" :key="s.k"
        type="button" role="tab" :aria-selected="sort === s.k"
        class="chip" :class="{ on: sort === s.k }"
        @click="sort = s.k"
      >{{ s.label }}</button>
    </div>

    <p v-if="bought" class="ok" role="status">
      已買下 <strong>{{ bought.card.name }}</strong>，已收進卡冊。
      <RouterLink :to="{ name: 'cards' }">去看看 →</RouterLink>
    </p>
    <p v-if="error" class="err" role="alert">{{ error }}</p>

    <div v-if="loading" class="grid" aria-hidden="true">
      <div v-for="i in 6" :key="i" class="sk"></div>
    </div>

    <div v-else-if="shown.length" class="grid">
      <article v-for="l in shown" :key="l.id" class="lot card">
        <Tilt3D :max="12" class="art">
          <CardArt :image="l.card.image" :alt="l.card.name" :cert-no="l.card.certNo" />
        </Tilt3D>

        <div class="body">
          <strong class="name">{{ l.card.name }}</strong>
          <CertTag :card="l.card" />

          <div class="price">
            <strong class="mono p">{{ l.price.toLocaleString() }}</strong>
            <span class="muted u">點</span>
            <span class="tag" :class="diffPct(l) <= 0 ? 'good' : 'over'">
              {{ diffPct(l) <= 0 ? '' : '+' }}{{ diffPct(l) }}%
            </span>
          </div>
          <p class="ref muted mono">市值參考 {{ l.card.refPrice.toLocaleString() }}</p>

          <p class="by muted">{{ l.sellerName }} · {{ l.listedAt }}</p>

          <!-- 確認區 -->
          <div v-if="confirming === l.id" class="confirm">
            <p class="cq">
              用 <strong class="mono">{{ l.price.toLocaleString() }}</strong> 點買下？
              餘額將剩 <span class="mono">{{ (wallet.points - l.price).toLocaleString() }}</span>
            </p>
            <div class="crow">
              <button type="button" class="btn sm" @click="confirming = null">取消</button>
              <button type="button" class="btn primary sm" :disabled="busy === l.id" @click="buy(l)">
                {{ busy === l.id ? '處理中…' : '確定買下' }}
              </button>
            </div>
          </div>
          <button v-else type="button" class="btn primary buy" :disabled="l.status !== 'live'" @click="ask(l)">買下</button>
        </div>
      </article>
    </div>

    <p v-else class="empty muted">目前市場沒有掛單。</p>

    <footer class="foot">
      <p class="muted">
        餘額 <strong class="mono"><RollingNumber :value="wallet.points" /></strong> 點
        <RouterLink :to="{ name: 'topup' }" class="tu">儲值 →</RouterLink>
      </p>
      <p class="fine muted">
        市場以站內點數成交，賣出所得為點數，不可提領現金或轉讓。
        卡片由平台代管轉移，買方可另行申請出貨。
      </p>
    </footer>
  </div>
</template>

<style scoped>
.page { padding-top: 26px; padding-bottom: calc(48px + var(--nav-total)); }

.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
h1 { font-size: 24px; margin: 0; letter-spacing: -.02em; }
.sub { font-size: 13.5px; margin: 5px 0 0; }
.sell {
  flex: none;
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 13.5px; font-weight: 600;
  padding: 9px 16px; border-radius: var(--pill);
  background: var(--accent-wash); color: var(--accent);
  transition: background .15s;
}
.sell svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
@media (hover: hover) { .sell:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); } }
.sell:active { transform: scale(.97); }

.sorts { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; margin: 16px 0 14px; padding-bottom: 2px; }
.sorts::-webkit-scrollbar { display: none; }
.chip {
  flex: none;
  padding: 8px 15px; border-radius: var(--pill);
  border: 1px solid var(--line-soft); background: transparent;
  color: var(--muted); font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s;
}
.chip.on { background: var(--ink); color: var(--bg); border-color: transparent; font-weight: 600; }
@media (hover: hover) { .chip:not(.on):hover { color: var(--ink); border-color: var(--line); } }
.chip:active { transform: scale(.96); }

.ok, .err { margin: 0 0 14px; font-size: 13.5px; padding: 11px 14px; border-radius: var(--radius); }
.ok { background: var(--ok-wash); color: var(--ok); }
.ok a { color: inherit; text-decoration: underline; }
.err { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); font-weight: 600; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 16px; }
.lot { padding: 14px; display: grid; gap: 10px; align-content: start; }
.art { width: 100%; }
.body { display: grid; gap: 6px; justify-items: start; }
.name { font-size: 14.5px; font-weight: 650; line-height: 1.35; }
.price { display: flex; align-items: baseline; gap: 6px; margin-top: 2px; }
.p { font-size: 21px; font-weight: 700; letter-spacing: -.02em; }
.u { font-size: 12.5px; }
.tag { font-size: 11.5px; font-weight: 700; padding: 2px 8px; border-radius: var(--pill); margin-left: 2px; }
.tag.good { background: var(--ok-wash); color: var(--ok); }
.tag.over { background: var(--surface-2); color: var(--muted); }
.ref { font-size: 11.5px; margin: -2px 0 0; }
.by { font-size: 11.5px; margin: 2px 0 0; }
.buy { width: 100%; margin-top: 6px; padding: 11px; font-size: 14.5px; }

.confirm { width: 100%; margin-top: 6px; display: grid; gap: 9px; padding: 12px; background: var(--surface-2); border-radius: var(--radius); }
.cq { margin: 0; font-size: 13px; line-height: 1.5; }
.crow { display: flex; gap: 8px; }
.crow .btn { flex: 1; }
.btn.sm { padding: 9px 10px; font-size: 13.5px; }

.sk { height: 340px; border-radius: var(--radius); background: var(--surface-2); }
@media (prefers-reduced-motion: no-preference) {
  .sk { animation: pulse 1.4s ease-in-out infinite alternate; }
}
@keyframes pulse { to { opacity: .55; } }

.empty { text-align: center; padding: 60px 0; }
.foot { margin-top: 26px; padding-top: 18px; border-top: 1px solid var(--line-soft); display: grid; gap: 6px; }
.foot p { margin: 0; font-size: 13px; }
.tu { color: var(--accent); margin-left: 10px; }
.fine { font-size: 11.5px; line-height: 1.6; color: var(--faint); }

@media (max-width: 720px) {
  .page { padding-top: 16px; }
  h1 { font-size: 20px; }
  .sub { font-size: 12.5px; }
  .grid { grid-template-columns: repeat(2, 1fr); gap: 11px; }
  .lot { padding: 10px; gap: 8px; }
  .name { font-size: 13px; }
  .p { font-size: 17px; }
  .buy { padding: 9px; font-size: 13.5px; }
  .sell { font-size: 12.5px; padding: 8px 13px; }
}
</style>
