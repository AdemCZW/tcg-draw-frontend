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
      <!-- 卡圖滿版鋪滿整格，資訊直接壓在圖上。
           左到右的漸層遮罩把左半邊壓暗 —— 卡圖的主體（寶可夢）多半偏中上，
           壓左下角最不會蓋到重點，文字也才有足夠對比。 -->
      <article v-for="l in shown" :key="l.id" class="lot">
        <CardArt
          class="art"
          :image="l.card.image" :alt="l.card.name" :cert-no="l.card.certNo"
        />
        <span class="scrim" aria-hidden="true"></span>

        <div class="info">
          <strong class="name">{{ l.card.name }}</strong>
          <div class="price">
            <strong class="mono p">{{ l.price.toLocaleString() }}</strong>
            <span class="u">點</span>
            <span class="tag" :class="diffPct(l) <= 0 ? 'good' : 'over'">
              {{ diffPct(l) <= 0 ? '' : '+' }}{{ diffPct(l) }}%
            </span>
          </div>
          <p class="meta mono">
            市值 {{ l.card.refPrice.toLocaleString() }}
          </p>
          <p class="by">{{ l.sellerName }} · {{ l.listedAt }}</p>
        </div>

        <!-- 買下鍵疊在右下角，不佔卡圖的高度 -->
        <button
          v-if="confirming !== l.id"
          type="button" class="buy" :disabled="l.status !== 'live'" @click="ask(l)"
        >買下</button>

        <!-- 確認時整格覆蓋，避免在小格子裡擠兩層資訊 -->
        <div v-else class="confirm">
          <p class="cq">
            用 <strong class="mono">{{ l.price.toLocaleString() }}</strong> 點買下？<br>
            餘額將剩 <span class="mono">{{ (wallet.points - l.price).toLocaleString() }}</span>
          </p>
          <div class="crow">
            <button type="button" class="btn sm" @click="confirming = null">取消</button>
            <button type="button" class="btn primary sm" :disabled="busy === l.id" @click="buy(l)">
              {{ busy === l.id ? '處理中…' : '確定' }}
            </button>
          </div>
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
  min-height: 44px;
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 13.5px; font-weight: 600;
  padding: 9px 16px; border-radius: var(--pill);
  background: var(--accent-wash); color: var(--accent);
  transition: background .15s;
}
.sell svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
@media (hover: hover) { .sell:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); } }
.sell:active { transform: scale(.97); }

/* 右緣淡出：這排是可以左右滑的，但截斷處如果是硬邊，看起來就只是「被切掉」
   而不是「還有更多」。mask 讓最後一顆膠囊漸隱，滑動的可能性才看得出來。 */
.sorts {
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 34px), transparent 100%);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 34px), transparent 100%);
  display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; margin: 16px 0 14px; padding-bottom: 2px; }
.sorts::-webkit-scrollbar { display: none; }
.chip {
  flex: none;
  /* 44px 是觸控目標下限；視覺上仍是細膠囊，靠 padding 撐開可點區域 */
  min-height: 44px;
  padding: 8px 16px; border-radius: var(--pill);
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

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }

/* 一格 = 一張卡。沒有外框、沒有內距，卡圖就是整格 —— 同樣的格子寬度下
   卡片比原本大了一圈（原本被 14px 內距與白底框吃掉）。 */
.lot {
  position: relative;
  aspect-ratio: 5 / 7;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--surface-2);
  isolation: isolate;
  transition: transform .25s cubic-bezier(.2, .7, .3, 1), box-shadow .25s;
}
@media (hover: hover) {
  .lot:hover { transform: translateY(-4px); box-shadow: var(--shadow-lg); }
}
.lot .art { width: 100%; height: 100%; }
.lot .art :deep(img), .lot .art :deep(.art-img) { width: 100%; height: 100%; object-fit: cover; }

/* 左到右的漸層：左側夠暗撐住文字，右側完全透明讓卡圖露出來。
   再疊一層由下往上的，因為文字是靠下的。 */
.scrim {
  position: absolute; inset: 0;
  pointer-events: none;
  /* 底部要夠深：卡圖本身有招式名與傷害數字，遮罩不夠會跟白字打架 */
  background:
    linear-gradient(100deg,
      rgba(8, 6, 14, .95) 0%,
      rgba(8, 6, 14, .8) 34%,
      rgba(8, 6, 14, .32) 62%,
      transparent 88%),
    linear-gradient(0deg,
      rgba(8, 6, 14, .96) 0%,
      rgba(8, 6, 14, .88) 16%,
      rgba(8, 6, 14, .42) 34%,
      transparent 56%);
}

/* 右側留出買下鍵的寬度：不留的話最底下那兩行（市值、賣家）會被鍵蓋掉，
   實測「市值 4,200 · PSA 10」被截成「市值 4,200 · PSA 1」 */
.info {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 12px 86px 13px 12px;
  display: grid; gap: 3px; justify-items: start;
  color: #fff;
}
/* 卡名與價格在買下鍵的上方，可以用滿整格寬度 */
.name, .price { margin-right: -74px; }
.name {
  font-size: 15px; font-weight: 700; line-height: 1.3;
  text-shadow: 0 1px 6px rgba(0, 0, 0, .7);
}
.price { display: flex; align-items: baseline; gap: 5px; margin-top: 2px; }
.p { font-size: 23px; font-weight: 800; letter-spacing: -.02em; text-shadow: 0 2px 10px rgba(0, 0, 0, .8); }
.u { font-size: 12px; opacity: .8; }
.tag { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: var(--pill); margin-left: 2px; }
.tag.good { background: var(--ok); color: #06210f; }
.tag.over { background: rgba(255, 255, 255, .22); color: #fff; }
/* 留給買下鍵的寬度之後，這兩行很窄 —— 強制單行，寧可截斷也不要折成兩行
   把整塊資訊往上推、蓋掉更多卡圖 */
.meta, .by {
  max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meta { font-size: 11px; opacity: .78; margin: 1px 0 0; }
.by { font-size: 10.5px; opacity: .6; margin: 0; }

/* 買下鍵：右下角，不佔卡圖高度 */
.buy {
  position: absolute; right: 10px; bottom: 11px; z-index: 2;
  padding: 9px 16px;
  border: none; border-radius: var(--pill);
  background: var(--accent); color: #fff;
  font-size: 13.5px; font-weight: 700; cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .45);
  transition: transform .12s, background .15s;
}
@media (hover: hover) { .buy:hover { background: var(--accent-soft); } }
.buy:active { transform: scale(.94); }
.buy:disabled { opacity: .45; cursor: default; }
.buy:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

/* 確認：整格覆蓋，小格子裡塞不下兩層資訊 */
.confirm {
  position: absolute; inset: 0; z-index: 3;
  display: grid; align-content: center; gap: 12px;
  padding: 16px;
  background: rgba(8, 6, 14, .93);
  backdrop-filter: blur(3px);
}
.cq { margin: 0; font-size: 13px; line-height: 1.6; color: #fff; text-align: center; }
.crow { display: flex; gap: 8px; }
.crow .btn { flex: 1; }
.btn.sm { padding: 9px 8px; font-size: 13px; }

.sk { aspect-ratio: 5 / 7; border-radius: var(--radius); background: var(--surface-2); }
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
  .grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .info { padding: 9px 66px 10px 9px; }
  .name, .price { margin-right: -57px; }
  .name { font-size: 12.5px; }
  .p { font-size: 18px; }
  .u, .tag { font-size: 10px; }
  .meta { font-size: 10px; }
  .by { display: none; }          /* 小格子放不下，賣家資訊讓給價格 */
  .buy { right: 7px; bottom: 8px; padding: 7px 12px; font-size: 12px; }
  .sell { font-size: 12.5px; padding: 8px 13px; }
}
</style>
