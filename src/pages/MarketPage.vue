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
 *
 * 這一頁只負責「逛」。點任何一張卡都是進 /market/:id 由那一頁成交 ——
 * 購買原本是這裡的行內確認框，而那個框是渲染在主列表的那一格裡的：
 * 從上方的橫向捲軸點一張，確認框會跑到下面某一格去長出來；主列表改成
 * 游標分頁之後，那一格甚至可能還沒載入，點了完全沒有反應。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { api, type MarketSort } from '@/lib/api'
import type { Listing } from '@/types/models'
import { deliveryOf } from '@/shared/domain'
import { useWalletStore } from '@/stores/wallet'
import { useAuthStore } from '@/stores/auth'
import CardArt from '@/components/CardArt.vue'
import OwnerTag from '@/components/OwnerTag.vue'
import TradeGuard from '@/components/TradeGuard.vue'
import ListSentinel from '@/components/ListSentinel.vue'
import { useInfiniteList } from '@/composables/useInfiniteList'
import RollingNumber from '@/components/RollingNumber.vue'
import { track } from '@/lib/ga'
import { refDiscount, refPriceText } from '@/lib/refprice'

const wallet = useWalletStore()
const auth = useAuthStore()

/* 這一頁原本完全不知道使用者是誰 —— 自己上架的卡跟別人的卡在列表上長得
   一模一樣，要點進去、按下購買、被後端擋掉（orders.ts 的「不能買自己的掛單」）
   才知道。整條路走到最後一步才擋，前面每一步都在騙人。

   比對 sellerId 而不是 sellerName：名字會重複，也可能被改。
   未登入時一律 false —— 那時候根本沒有「你」，訪客不該看到任何個人化痕跡。 */
const isMine = (l: Listing) => !!auth.user && l.sellerId === auth.user.id

/* 排序而不是篩選：市場的品項還不多，先給「怎麼排」比「濾掉什麼」有用。
   低於市值放第一個 —— 那是使用者真正在找的東西。 */
type Sort = MarketSort
const sort = ref<Sort>('deal')
const SORTS: { k: Sort; label: string }[] = [
  { k: 'deal', label: '低於市值' },
  { k: 'new', label: '最新上架' },
  { k: 'cheap', label: '價格低到高' },
  { k: 'pricey', label: '價格高到低' }
]

/* 掛單分批載入，排序在後端。
   排序不能留在前端：分批之後前端只排得到已載入的那幾筆，捲一頁就整個重排，
   已經看過的卡片會在眼前跳位。這跟卡冊的狀態分頁是同一個問題。 */
const list = useInfiniteList<Listing>((cursor, signal) =>
  api.listMarket({ cursor, signal, sort: sort.value }))
const sentinelRef = list.sentinel
const listings = list.items
const loading = computed(() => list.loading.value && !list.ready.value)

const gridRef = ref<HTMLElement | null>(null)
/* 換排序＝換一組查詢：游標歸零、清空既有清單，過期的回應由 composable 擋掉。
   同時把清單頂端捲回視野：整批換掉之後停在原本的捲動位置，會落在一個
   只剩第一批的短清單底部，哨兵當場又在範圍內 —— 使用者沒有捲動，
   卻會看到後面幾批被一路抓下來。 */
watch(sort, () => {
  list.reset()
  const top = gridRef.value?.getBoundingClientRect().top ?? 0
  if (top < 0) gridRef.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
})

/* 上方兩條橫向捲軸與總筆數講的是「整個市場」，不是「已經捲出來的那幾筆」——
   從已載入的清單挑會挑到假的第一名，所以獨立取一次。 */
const deals = ref<Listing[]>([])
const graded = ref<Listing[]>([])
const total = ref(0)

onMounted(async () => {
  list.reset()
  track('view_market')
  try {
    const h = await api.marketHighlights()
    deals.value = h.deals
    graded.value = h.graded
    total.value = h.total
  } catch { /* 精選區拿不到不該擋住主清單，那只是兩條輔助捲軸 */ }
})

/* 這筆走哪一條通道。推導的理由見 shared/domain.ts 的 deliveryOf ——
   放在共用層是因為列表徽章、詳情頁與 mock 的成交邏輯必須是同一個判斷。 */
const laneOf = deliveryOf

/** 掛價相對市值的折數。負數＝比市值便宜 */
// 沒有標示參考價就沒有折價幅度可言 —— 回 null，畫面不顯示那個標籤
const diffPct = (l: Listing) => { const d = refDiscount(l); return d == null ? null : Math.round(d * 100) }

/* ---- 分區 ----
   市場原本跟大廳一樣是單一格線，兩頁看起來幾乎一樣。
   買家來市場只有兩種意圖：「撿便宜」或「找特定的好貨」，
   所以先用這兩個意圖分區，剩下的才進全部清單。
   兩區的內容由 /listings/highlights 取（見上面的 onMounted）。 */

/* 已載入的掛單。只濾掉「剛剛在這一頁被買走的」—— 排序已經由後端排好，
   這裡再排一次會把跨批次的順序打亂。 */
const shown = computed(() => listings.value.filter(l => l.status === 'live'))
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

    <!-- 撿便宜：橫向捲動的小方塊，密度高，跟下面的大格線形成對比 -->
    <section v-if="deals.length && sort === 'deal'" class="band">
      <header class="bh">
        <h2><span class="dot deal"></span>今日最殺</h2>
        <span class="muted bhNote">低於市值 8% 以上</span>
      </header>
      <div class="rail">
        <RouterLink
          v-for="l in deals" :key="l.id"
          class="dealCard" :class="{ mine: isMine(l) }"
          :to="{ name: 'market-listing', params: { id: l.id } }"
        >
          <CardArt class="dealArt" :image="''" :alt="l.card.name" :art-id="l.card.artId" />
          <span v-if="diffPct(l) !== null" class="dealPct">{{ diffPct(l) }}%</span>
          <!-- 104px 的小方塊左上角已經被折數佔走，標記放右上角。
               只講「我的」兩個字：這個寬度放不下完整句子，形狀＋顏色＋外框
               三個訊號加起來已經夠認 -->
          <OwnerTag v-if="isMine(l)" class="dealMine" label="我的" compact />
          <span class="dealFoot">
            <span class="mono dealPrice">{{ l.price.toLocaleString() }}</span>
            <span class="dealRef mono">賣家標示 {{ refPriceText(l.card.refPrice) }}</span>
          </span>
        </RouterLink>
      </div>
    </section>

    <!-- 鑑定卡：單價最高的一區，用寬一點的卡凸顯 -->
    <section v-if="graded.length && sort === 'deal'" class="band gradedBand">
      <header class="bh">
        <h2><span class="dot cert"></span>已鑑定</h2>
        <span class="muted bhNote">附鑑定編號，可自行到鑑定機構查證</span>
      </header>
      <div class="rail">
        <RouterLink
          v-for="l in graded" :key="l.id"
          class="gradedCard" :class="{ mine: isMine(l) }"
          :to="{ name: 'market-listing', params: { id: l.id } }"
        >
          <CardArt class="gradedArt" :image="''" :alt="l.card.name" :art-id="l.card.artId" />
          <span class="gradedInfo">
            <!-- 這種卡沒有可疊圖的空白角落（縮圖只有 66px），標記進資訊欄第一行。
                 gName 要 min-width: 0 才不會被長卡名把標記擠出卡片外 -->
            <span class="gTop">
              <OwnerTag v-if="isMine(l)" label="我的" compact />
              <strong class="gName">{{ l.card.name }}</strong>
            </span>
            <span class="gCert mono">{{ l.card.grader }} {{ l.card.grade }} · #{{ l.card.certNo }}</span>
            <span class="mono gPrice">{{ l.price.toLocaleString() }} 點</span>
          </span>
        </RouterLink>
      </div>
    </section>

    <header v-if="sort === 'deal' && (deals.length || graded.length)" class="bh allHead">
      <h2><span class="dot all"></span>全部掛單</h2>
      <span class="muted bhNote">{{ total }} 件</span>
    </header>

    <div v-if="loading" class="grid" aria-hidden="true">
      <div v-for="i in 6" :key="i" class="sk"></div>
    </div>

    <div v-else-if="shown.length" ref="gridRef" class="grid">
      <!-- 卡圖滿版鋪滿整格，資訊直接壓在圖上。
           左到右的漸層遮罩把左半邊壓暗 —— 卡圖的主體（寶可夢）多半偏中上，
           壓左下角最不會蓋到重點，文字也才有足夠對比。 -->
      <article v-for="l in shown" :key="l.id" class="lot" :class="{ mine: isMine(l) }">
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

        <!-- 通道徽章佔了左上角，這個放右上角，兩個不會撞在一起 -->
        <OwnerTag v-if="isMine(l)" class="lotMine" label="我的掛單" />

        <div class="info">
          <strong class="name">{{ l.card.name }}</strong>
          <div class="price">
            <strong class="mono p">{{ l.price.toLocaleString() }}</strong>
            <span class="u">點</span>
            <!-- 沒有標示參考價就沒有折價幅度可言 —— 不顯示這個標籤，
                 拿 0 頂替會讓一張沒有基準的卡看起來像「剛好平價」 -->
            <span v-if="diffPct(l) !== null" class="tag" :class="(diffPct(l) ?? 0) <= 0 ? 'good' : 'over'">
              {{ (diffPct(l) ?? 0) <= 0 ? '' : '+' }}{{ diffPct(l) }}%
            </span>
          </div>
          <p class="meta mono">
            賣家標示 {{ refPriceText(l.card.refPrice) }}
          </p>
          <p class="by">{{ l.sellerName }} · {{ l.listedAt }}</p>
        </div>

        <!-- 整格都是連結（撐滿的透明 <a>），而不是只有「買下」那顆鍵可以點：
             使用者的直覺是「點卡片就進去看」。連結放在資訊層下面，
             文字才選得到；「買下」是純視覺的標籤，pointer-events: none
             讓點在它身上的手指落到下面這條連結上。 -->
        <RouterLink
          class="open" :to="{ name: 'market-listing', params: { id: l.id } }"
          :aria-label="isMine(l)
            ? `${l.card.name}，${l.price.toLocaleString()} 點，你上架的掛單`
            : `${l.card.name}，${l.price.toLocaleString()} 點`"
        />
        <!-- 自己的卡不能寫「買下」。後端本來就會擋，寫著買下等於邀請使用者
             走一趟必定失敗的流程；改成「管理」才對得上點進去實際能做的事 -->
        <span class="buy" aria-hidden="true">{{ isMine(l) ? '管理' : '買下' }}</span>
      </article>
    </div>

    <p v-else-if="!list.error.value" class="empty muted">目前市場沒有掛單。</p>

    <!-- 哨兵放在格線外面：塞進 grid 會佔掉一格，而且 grid 子元素預設
         min-width: auto，長錯誤訊息會把整欄撐開（這頁是兩欄，很敏感） -->
    <ListSentinel
      ref="sentinelRef"
      :loading="list.loading.value && list.ready.value"
      :done="list.done.value"
      :error="list.error.value"
      :manual="list.manual.value"
      :empty="!shown.length"
      done-text="已經是全部的掛單了"
      @retry="list.retry()"
      @more="list.load()"
    />

    <footer class="foot">
      <p class="muted">
        餘額 <strong class="mono"><RollingNumber :value="wallet.shown" /></strong> 點
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
/* 底部導覽的讓位交給頁尾（見 App.vue），這裡只留自己的排版留白 */
.page { padding-top: 26px; padding-bottom: 48px; }

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
  position: relative; display: block; flex: 0 0 104px;
  scroll-snap-align: start;
  padding: 0; border: none; cursor: pointer;
  border-radius: var(--radius); overflow: hidden;
  background: var(--surface-2);
  color: inherit; text-decoration: none;
  transition: transform .2s;
}
@media (hover: hover) { .dealCard:hover { transform: translateY(-3px); } }
.dealCard:active { transform: scale(.96); }
.dealArt { width: 100%; aspect-ratio: 5 / 7; display: block; }
.dealArt :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.dealPct {
  position: absolute; top: 5px; left: 5px;
  font-size: 11px; font-weight: 700;
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
.dealPrice { font-size: 13px; font-weight: 700; }
.dealRef { font-size: 9.5px; opacity: .6; text-decoration: line-through; }

/* 已鑑定：橫式寬卡，跟上面的小方塊形狀完全不同 */
.gradedCard {
  position: relative;
  flex: 0 0 min(80vw, 300px);
  scroll-snap-align: start;
  display: grid; grid-template-columns: 66px minmax(0, 1fr);
  gap: 11px; align-items: center;
  padding: 9px; cursor: pointer;
  border-radius: var(--radius);
  border: 1px solid color-mix(in srgb, #d8b25a 32%, transparent);
  background: linear-gradient(100deg, color-mix(in srgb, #d8b25a 10%, transparent), var(--surface) 60%);
  text-align: left; color: inherit; text-decoration: none;
  transition: transform .2s, border-color .2s;
}
@media (hover: hover) { .gradedCard:hover { transform: translateY(-3px); border-color: #d8b25a; } }
.gradedCard:active { transform: scale(.98); }
.gradedArt { width: 100%; aspect-ratio: 5 / 7; border-radius: 6px; overflow: hidden; }
.gradedArt :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.gradedInfo { display: grid; gap: 3px; min-width: 0; }
/* 標記與卡名同一行：多開一行會把這張橫式卡撐高，整條捲軸的節奏就跟著跑掉。
   min-width: 0 在兩層都要有 —— flex 子元素預設不縮到比內容窄 */
.gTop { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* 標記不准縮：它自己帶 min-width: 0（那是為了疊在卡圖上時不撐開格子），
   放進 flex 行裡就會被長卡名壓成 0 寬 —— 實測長卡名下整顆標記被擠沒了，
   只剩一條藍線。要讓的是卡名，不是標示。 */
.gTop .omark { flex: 0 0 auto; }
.gTop .gName { min-width: 0; }
.gName { font-size: 13.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gCert { font-size: 10px; color: #d8b25a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gPrice { font-size: 15px; font-weight: 700; margin-top: 1px; }

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
.p { font-size: 23px; font-weight: 700; letter-spacing: -.02em; text-shadow: 0 2px 10px rgba(0, 0, 0, .8); }
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

/* 通道徽章：疊在卡圖左上角，不跟價格搶 .info 的空間。
   pointer-events: none —— 它蓋在整格的連結上面，不能把點擊吃掉 */
.lane {
  position: absolute; left: 8px; top: 8px; z-index: 2;
  pointer-events: none;
  font-size: 10px; font-weight: 700; line-height: 1;
  padding: 4px 7px; border-radius: var(--pill);
  letter-spacing: .02em;
  backdrop-filter: blur(6px);
}
.lane.vault { background: rgba(22, 130, 90, .82); color: #fff; }
.lane.ship { background: rgba(10, 10, 14, .62); color: rgba(255, 255, 255, .92); }

/* 撐滿整格的連結：整張卡都可以點進詳情頁，不是只有右下角那顆鍵 */
.open { position: absolute; inset: 0; z-index: 3; border-radius: var(--radius); }
.open:focus-visible { outline: 2px solid #fff; outline-offset: -3px; }

/* 「買下」現在只是視覺標籤，真正的連結是 .open。
   pointer-events: none 讓點在它身上的手指直接落到那條連結上 */
.buy {
  position: absolute; right: 10px; bottom: 11px; z-index: 4;
  pointer-events: none;
  padding: 9px 16px;
  border-radius: var(--pill);
  background: var(--accent); color: #fff;
  font-size: 13.5px; font-weight: 700; line-height: 1.25;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .45);
  transition: background .15s;
}
@media (hover: hover) { .lot:hover .buy { background: var(--accent-soft); } }

/* ---- 自己上架的掛單 ----
   三種形狀共用同一組訊號：藍色外框 ＋ 同一顆標記。只加一行小字是不夠的 ——
   使用者是在滑動中掃過這些卡片的，能被掃到的只有形狀與顏色。

   外框用 ::after 而不是 border / outline / inset box-shadow：
   這三種卡的圖都是滿版鋪在元素裡的子節點，畫在元素自己身上的邊框會被圖蓋掉
   （dealCard 與 lot 都是 overflow: hidden ＋ object-fit: cover）。
   ::after 是繪製在子節點之上的獨立疊層，而且不必動 template 加空 span。
   pointer-events: none —— 它蓋在整格的連結上面，不能把點擊吃掉。 */
.dealCard.mine::after,
.gradedCard.mine::after,
.lot.mine::after {
  content: '';
  position: absolute; inset: 0;
  z-index: 5;
  pointer-events: none;
  border: 2px solid var(--info-ink);
  border-radius: inherit;
}

/* 小方塊：左上角是折數，標記走右上角 */
.dealMine { position: absolute; right: 5px; top: 5px; z-index: 6; pointer-events: none; max-width: calc(100% - 10px); }

/* 滿版格：左上角是通道徽章，標記走右上角 */
.lotMine { position: absolute; right: 8px; top: 8px; z-index: 6; pointer-events: none; max-width: calc(100% - 16px); }

/* 「買下」在自己的卡上會變成「管理」（見 template）——
   顏色也要跟著換，不然一顆強調色的鍵仍然在喊「買」 */
.lot.mine .buy { background: var(--info-ink); color: var(--bg); }
@media (hover: hover) { .lot.mine:hover .buy { background: var(--info-ink); } }

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
  /* 兩欄版的格子只有一半寬，標記靠右上角容易跟卡圖的角落花紋糊在一起，
     縮一階並貼近邊緣，留給卡名的空間才夠 */
  .lotMine { right: 6px; top: 6px; max-width: calc(100% - 12px); }
  .sell { font-size: 12.5px; padding: 8px 13px; }
}
</style>
