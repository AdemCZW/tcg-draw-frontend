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
import TradeGuard from '@/components/TradeGuard.vue'
import { useOrdersStore } from '@/stores/orders'
import RollingNumber from '@/components/RollingNumber.vue'
import { haptic } from '@/lib/haptics'
import { track } from '@/lib/ga'

const wallet = useWalletStore()
const auth = useAuthStore()
const orders = useOrdersStore()

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
/* 這筆走哪一條通道。
   後端還沒接，listing.delivery 多半是空的，先由來源推導：
   玩家抽到的卡跟平台自營的卡都還在保管庫，成交只是過戶。
   使用者可以先提領再上架，那時候推導會失準 —— 所以 delivery 一旦有值就以它為準。 */
const laneOf = (l: Listing): 'vault' | 'ship' =>
  l.delivery ?? (l.fromPrizeId || l.sellerId === 'platform' ? 'vault' : 'ship')

const diffPct = (l: Listing) => Math.round(((l.price - l.card.refPrice) / l.card.refPrice) * 100)

/* ---- 分區 ----
   市場原本跟大廳一樣是單一格線，兩頁看起來幾乎一樣。
   買家來市場只有兩種意圖：「撿便宜」或「找特定的好貨」，
   所以先用這兩個意圖分區，剩下的才進全部清單。 */

/** 撿便宜：低於市值最多的幾張，橫向捲動 */
const deals = computed(() =>
  listings.value.filter(l => l.status === 'live' && diffPct(l) <= -8)
    .sort((a, b) => diffPct(a) - diffPct(b))
    .slice(0, 6))

/** 鑑定卡：有鑑定編號的，這些是市場上單價最高、也最需要被凸顯的 */
const graded = computed(() =>
  listings.value.filter(l => l.status === 'live' && l.card.certNo)
    .sort((a, b) => b.price - a.price)
    .slice(0, 4))

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
/* 走託管的那條路：買下之後錢是凍結不是扣掉，要引導去看訂單 */
const escrowed = ref<Listing | null>(null)
const error = ref('')

function ask(l: Listing) {
  error.value = ''
  confirming.value = confirming.value === l.id ? null : l.id
}

async function buy(l: Listing) {
  if (busy.value) return
  error.value = ''
  busy.value = l.id
  try {
    await api.buyListing(l.id)

    /* 兩條通道在這裡分開。
       庫內轉移是原子交換：點數直接扣、卡直接過戶，沒有中間狀態。
       需寄送則建立託管訂單，點數只是「凍結」不是扣款 —— 錢還是買家的，
       要等確認收貨或驗收期滿才真的付給賣家。 */
    if (laneOf(l) === 'vault') {
      wallet.spend(l.price)
      bought.value = l
    } else {
      await orders.createFromListing(l, auth.user?.name ?? '我')
      escrowed.value = l
    }

    markSold(l.id)
    confirming.value = null
    track('market_buy_success')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '購買失敗'
    if (String(error.value).includes('sold')) markSold(l.id)
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

    <TradeGuard />

    <p v-if="bought" class="ok" role="status">
      已買下 <strong>{{ bought.card.name }}</strong>，已收進卡冊。
      <RouterLink :to="{ name: 'cards' }">去看看 →</RouterLink>
    </p>
    <p v-if="escrowed" class="ok" role="status">
      <strong>{{ escrowed.card.name }}</strong> 的 {{ escrowed.price.toLocaleString() }} 點已凍結，
      賣家出貨後你會收到通知。
      <RouterLink :to="{ name: 'orders' }">看訂單 →</RouterLink>
    </p>
    <p v-if="error" class="err" role="alert">{{ error }}</p>

    <!-- 撿便宜：橫向捲動的小方塊，密度高，跟下面的大格線形成對比 -->
    <section v-if="deals.length && sort === 'deal'" class="band">
      <header class="bh">
        <h2><span class="dot deal"></span>今日最殺</h2>
        <span class="muted bhNote">低於市值 8% 以上</span>
      </header>
      <div class="rail">
        <button
          v-for="l in deals" :key="l.id"
          type="button" class="dealCard" @click="ask(l)"
        >
          <CardArt class="dealArt" :image="''" :alt="l.card.name" :art-id="l.card.artId" />
          <span class="dealPct">{{ diffPct(l) }}%</span>
          <span class="dealFoot">
            <span class="mono dealPrice">{{ l.price.toLocaleString() }}</span>
            <span class="dealRef mono">市值 {{ l.card.refPrice.toLocaleString() }}</span>
          </span>
        </button>
      </div>
    </section>

    <!-- 鑑定卡：單價最高的一區，用寬一點的卡凸顯 -->
    <section v-if="graded.length && sort === 'deal'" class="band gradedBand">
      <header class="bh">
        <h2><span class="dot cert"></span>已鑑定</h2>
        <span class="muted bhNote">附鑑定編號，可自行到鑑定機構查證</span>
      </header>
      <div class="rail">
        <button
          v-for="l in graded" :key="l.id"
          type="button" class="gradedCard" @click="ask(l)"
        >
          <CardArt class="gradedArt" :image="''" :alt="l.card.name" :art-id="l.card.artId" />
          <span class="gradedInfo">
            <strong class="gName">{{ l.card.name }}</strong>
            <span class="gCert mono">{{ l.card.grader }} {{ l.card.grade }} · #{{ l.card.certNo }}</span>
            <span class="mono gPrice">{{ l.price.toLocaleString() }} 點</span>
          </span>
        </button>
      </div>
    </section>

    <header v-if="sort === 'deal' && (deals.length || graded.length)" class="bh allHead">
      <h2><span class="dot all"></span>全部掛單</h2>
      <span class="muted bhNote">{{ shown.length }} 件</span>
    </header>

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
          :image="l.card.image" :alt="l.card.name" :cert-no="l.card.certNo" :art-id="l.card.artId"
        />
        <span class="scrim" aria-hidden="true"></span>

        <!-- 通道徽章疊在卡圖上。原本放在 .by 那行，但那行在手機上會被隱藏，
             而「要不要等寄送」是買家下單前最需要先知道的事 -->
        <span class="lane" :class="laneOf(l)">
          {{ laneOf(l) === 'vault' ? '庫內' : '需寄送' }}
        </span>

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
          <!-- 錢會怎麼流，要在按下去之前講，不是在爭議發生之後才講 -->
          <p class="cnote">
            {{ laneOf(l) === 'vault'
              ? '卡在保管庫，成交立刻過戶到你名下。'
              : '點數先凍結，你確認收貨或 7 天後才放款給賣家。' }}
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

/* ---- 分區 ---- */
.band { margin-bottom: 22px; }
.bh { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 11px; }
.bh h2 { display: flex; align-items: center; gap: 8px; font-size: 16px; margin: 0; letter-spacing: -.01em; }
.bhNote { font-size: 11.5px; }
.allHead { margin-top: 4px; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dot.deal { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
.dot.cert { background: #d8b25a; box-shadow: 0 0 8px #d8b25a; }
.dot.all { background: var(--muted); }

.rail {
  display: flex; gap: 10px;
  overflow-x: auto; scroll-snap-type: x proximity;
  scrollbar-width: none; overscroll-behavior-x: contain;
  padding-bottom: 4px;
  -webkit-mask-image: linear-gradient(90deg, #000 0 calc(100% - 26px), transparent);
  mask-image: linear-gradient(90deg, #000 0 calc(100% - 26px), transparent);
}
.rail::-webkit-scrollbar { display: none; }

/* 撿便宜：小方塊，整頁密度最高 */
.dealCard {
  position: relative; flex: 0 0 104px;
  scroll-snap-align: start;
  padding: 0; border: none; cursor: pointer;
  border-radius: var(--radius); overflow: hidden;
  background: var(--surface-2);
  transition: transform .2s;
}
@media (hover: hover) { .dealCard:hover { transform: translateY(-3px); } }
.dealCard:active { transform: scale(.96); }
.dealArt { width: 100%; aspect-ratio: 5 / 7; display: block; }
.dealArt :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.dealPct {
  position: absolute; top: 5px; left: 5px;
  font-size: 11px; font-weight: 800;
  padding: 2px 7px; border-radius: var(--pill);
  background: var(--ok); color: #06210f;
}
.dealFoot {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: grid; gap: 1px;
  padding: 14px 7px 6px;
  background: linear-gradient(0deg, rgba(8,6,14,.94), transparent);
  color: #fff;
}
.dealPrice { font-size: 13px; font-weight: 800; }
.dealRef { font-size: 9.5px; opacity: .6; text-decoration: line-through; }

/* 已鑑定：橫式寬卡，跟上面的小方塊形狀完全不同 */
.gradedCard {
  flex: 0 0 min(80vw, 300px);
  scroll-snap-align: start;
  display: grid; grid-template-columns: 66px minmax(0, 1fr);
  gap: 11px; align-items: center;
  padding: 9px; cursor: pointer;
  border-radius: var(--radius);
  border: 1px solid color-mix(in srgb, #d8b25a 32%, transparent);
  background: linear-gradient(100deg, color-mix(in srgb, #d8b25a 10%, transparent), var(--surface) 60%);
  text-align: left;
  transition: transform .2s, border-color .2s;
}
@media (hover: hover) { .gradedCard:hover { transform: translateY(-3px); border-color: #d8b25a; } }
.gradedCard:active { transform: scale(.98); }
.gradedArt { width: 100%; aspect-ratio: 5 / 7; border-radius: 6px; overflow: hidden; }
.gradedArt :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.gradedInfo { display: grid; gap: 3px; min-width: 0; }
.gName { font-size: 13.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gCert { font-size: 10px; color: #d8b25a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gPrice { font-size: 15px; font-weight: 800; margin-top: 1px; }

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
/* 通道徽章：疊在卡圖左上角，不跟價格搶 .info 的空間 */
.lane {
  position: absolute; left: 8px; top: 8px; z-index: 2;
  font-size: 10px; font-weight: 700; line-height: 1;
  padding: 4px 7px; border-radius: var(--pill);
  letter-spacing: .02em;
  backdrop-filter: blur(6px);
}
.lane.vault { background: rgba(22, 130, 90, .82); color: #fff; }
.lane.ship { background: rgba(10, 10, 14, .62); color: rgba(255, 255, 255, .92); }

.cnote {
  font-size: 11px; line-height: 1.55;
  color: var(--muted);
  margin: 6px 0 0;
  max-width: 22ch;
}

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
