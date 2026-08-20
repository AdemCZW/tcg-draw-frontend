<script setup lang="ts">
/**
 * 大廳 —— 今日推薦 + 快沒了 + 全部抽選池 + 現貨市場出口。
 *
 * 原本「大廳」與「全部池」是兩頁，但它們回答的是同一個問題：
 * 「現在有什麼可以開」。差別只是一個挑重點、一個列全部 —— 那是同一頁的
 * 上半跟下半，不是兩個目的地。合併後導覽也空出一格給市場。
 *
 * 分類刻意做成極簡的橫向膠囊：不是多層篩選器，是「我現在想找哪一種」
 * 的一次點擊。條件都算得出來，不需要後端支援。
 *
 * ---- 這一頁的資訊架構（改版時務必先讀完這段）----
 *
 * 舊版有五個區塊：推薦 / 熱抽中 / 官方池 / 市場低於市值 / 全部池。
 * 使用者的回饋是「整個滑下來看不出各區塊想凸顯什麼」，量過之後原因很具體：
 *
 *   實測 13 個開放中的池，頁面上卻印出 22 張池卡。
 *   熱抽中的 6 張全部重複出現在下面的全部池，官方池的 2 張也是，
 *   推薦池自己再算一次 —— 重複率 100%。
 *
 * 也就是說，看不出區塊差異的根本原因不是視覺設計不夠強烈，
 * 是這幾塊裡面裝的東西「真的一樣」，連元件都是同一個 PoolCard。
 * 再怎麼加底色跟標題層級，都只是幫同一批卡片換三種包裝紙。
 *
 * 附帶的實害：PoolCard 會掛 view-transition-name="pool-cover-{id}"，
 * 同一個名字在頁面上出現兩次以上，瀏覽器會直接放棄整個 View Transition。
 * 舊版有 7 個名字撞號，等於跟池詳情的共享元素轉場一直是壞的。去重之後才會動。
 *
 * 現在每一區必須回答一個「別區答不了」的問題，並各自用不同的模組形狀講：
 *
 *   1. 今日推薦   今天開哪一池？      巨大主視覺 + 推薦理由，唯一的滿版單卡
 *   2. 快沒了     還剩多久？          大數字倒數 + 見底量表，危險色底帶、橫向捲
 *   3. 全部抽選池 全部有什麼？        唯一有篩選控制項的一區，密集直式格線
 *   4. 現貨市場   不想碰運氣？        另一種商業模式，綠色底帶 + 小方塊、放最後
 *
 * 兩個被拿掉 / 搬動的東西：
 *  - 「官方池」整區刪掉。它跟第 3 區的「官方池」膠囊是同一個篩選條件、
 *    同樣兩張卡、同一個元件，是純粹的重複。官方背書這件事本身還是要講，
 *    但那是一句保障文案 + 一顆捷徑（見 .assureBtn），不是再列一次卡片。
 *  - 「市場低於市值」從中間搬到最後。它根本不是抽池，是二手現貨交易；
 *    夾在挑池動線中間會把「挑池 → 抽」的心流切斷。放最後才是正確的角色：
 *    「上面都不想抽的話，這裡可以直接買」。
 *
 * 第 2 區刻意不用 PoolCard 自己畫一張緊迫卡，有兩個理由：
 * 一是那張卡要凸顯的數字（剩幾籤）在 PoolCard 上是最小的灰字，
 * 二是不重複掛 view-transition-name，把轉場的唯一性留給第 3 區的格線。
 */
import { computed, onMounted, ref } from 'vue'
import { usePoolStore } from '@/stores/pools'
import { useSellerStore } from '@/stores/sellers'
import type { Listing, Pool, Tier } from '@/types/models'
import { api } from '@/lib/api'
import CardArt from '@/components/CardArt.vue'
import ShaderSky from '@/components/ShaderSky.vue'
import PoolCard from '@/components/PoolCard.vue'
import LobbySection from '@/components/LobbySection.vue'
import WinnerTicker from '@/components/WinnerTicker.vue'
import PoolModeBadge from '@/components/PoolModeBadge.vue'
import SellerChip from '@/components/SellerChip.vue'
import { track } from '@/lib/ga'

const pools = usePoolStore()
const sellers = useSellerStore()
onMounted(() => {
  pools.ensureLoaded()
  sellers.ensureLoaded()
  track('view_lobby')
})

const RANK: Record<Tier, number> = { BUST: 0, D: 1, C: 2, B: 3, A: 4, LAST: 5 }

/** 一池目前還沒出的最高賞 */
function topLiveTier(p: Pool): Tier {
  return p.prizes
    .filter(x => x.remaining > 0)
    .reduce<Tier>((best, x) => (RANK[x.tier] > RANK[best] ? x.tier : best), 'D')
}
const leftPct = (p: Pool) => (p.remainingTickets / p.totalTickets) * 100
/** 池裡還沒被抽走的最貴一張的市值 */
const topLiveValue = (p: Pool) =>
  p.prizes.filter(x => x.remaining > 0).reduce((m, x) => Math.max(m, x.card.refPrice), 0)

/* 今日推薦：開放中、最高賞還沒出的優先；同級比剩餘率（越接近完抽越緊張）。
   用日期輪替前三名，同一天進站看到同一池，隔天會換。 */
const featured = computed<Pool | undefined>(() => {
  const open = pools.openPools
  if (!open.length) return undefined
  const ranked = [...open].sort((a, b) => {
    const t = RANK[topLiveTier(b)] - RANK[topLiveTier(a)]
    return t || leftPct(a) - leftPct(b)
  })
  const top = ranked.slice(0, Math.min(3, ranked.length))
  return top[Math.floor(Date.now() / 86_400_000) % top.length]
})
const featuredTier = computed(() => (featured.value ? topLiveTier(featured.value) : 'D'))
const featuredPrize = computed(() =>
  featured.value?.prizes.find(p => p.tier === featuredTier.value && p.remaining > 0))
const seller = computed(() => (featured.value ? sellers.byId(featured.value.sellerId) : undefined))
const pct = computed(() => (featured.value ? Math.round(leftPct(featured.value)) : 0))

/* 能量場色相跟著推薦池的球階走 */
const TIER_HUE: Record<Tier, string> = {
  D: '#ef4040', C: '#3f7fd8', B: '#f5c400', A: '#d8b25a', LAST: '#8b4fd0', BUST: '#ef4040'
}
const hue = computed(() => TIER_HUE[featuredTier.value])

/* 同一組球階色也餵給著色器當主色調。
   十六進位轉 0..1，並往上抬一點飽和 —— shader 裡還會再乘 0.62，
   直接餵原色的話雲氣會偏灰。 */
const tint = computed<[number, number, number]>(() => {
  const h = hue.value.replace('#', '')
  const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
  return [Math.min(1, v(0) * 1.15), Math.min(1, v(2) * 1.15), Math.min(1, v(4) * 1.15)]
})

/* 著色器背景。大廳跟形象頁的角色不同：
   形象頁只有球和 CTA，背景可以搶戲；大廳有卡片、跑馬燈、分類要讀，
   所以只搬星雲本體，不搬分幕、爆發、流星那些會閃的東西，
   而且 energy 固定在低檔、gain 壓到 0.55。 */
const sky3d = ref(!new URLSearchParams(location.search).has('nogl'))

/* ---- 分類 ---- */
type Cat = 'all' | 'official' | 'merchant' | 'personal' | 'hot' | 'cheap' | 'big' | 'special' | 'done'
const cat = ref<Cat>('all')

const MATCH: Record<Cat, (p: Pool) => boolean> = {
  all: p => p.status === 'open',
  // 來源分類：買家最常問的其實是「這池是誰開的」
  official: p => p.status === 'open' && p.origin === 'official',
  merchant: p => p.status === 'open' && p.origin === 'merchant',
  personal: p => p.status === 'open' && p.origin === 'personal',
  // 快完抽：剩不到三成。這是最有張力的狀態，排第一個
  hot: p => p.status === 'open' && leftPct(p) <= 30,
  cheap: p => p.status === 'open' && p.ticketPrice <= 300,
  /* 高額賞：池裡還沒被抽走的最貴一張市值 >= 5000。
     原本這格寫「A 賞或最後賞還在池裡」，但每個開放中的池都符合 ——
     永遠篩不掉東西的分類等於沒有分類，只是多一個要掃過的按鈕。
     改看金額才真的有選擇性，也才是玩家實際在找的訊號。 */
  big: p => p.status === 'open' && topLiveValue(p) >= 5000,
  // 特殊玩法：連莊、競標、二選一這些不是一般抽
  special: p => p.status === 'open' && ['streak', 'auction', 'muteki'].includes(p.mode),
  done: p => p.status !== 'open'
}
const CATS: { k: Cat; label: string }[] = [
  { k: 'all', label: '全部' },
  { k: 'official', label: '官方池' },
  { k: 'merchant', label: '商家池' },
  { k: 'personal', label: '個人池' },
  { k: 'hot', label: '快完抽' },
  { k: 'big', label: '高額賞' },
  { k: 'cheap', label: '銅板價' },
  { k: 'special', label: '特殊玩法' },
  { k: 'done', label: '已完抽' }
]
/** 空的分類不顯示 —— 點進去看到空白比少一個選項糟 */
const cats = computed(() => CATS.filter(c => pools.pools.some(MATCH[c.k])))
const list = computed(() => pools.pools.filter(MATCH[cat.value]))

/* ---- 第 2 區：快沒了 ----
   依「已抽走的比例」排序，取前六。
   本來寫死「剩不到 45% 才算快完抽」，但實測只有一池符合 ——
   橫向捲動列只有一張卡是沒有意義的版面。改成排序取前 N，
   資料怎麼分布都填得滿；門檻只用來擋掉幾乎沒人抽的池（未達 35% 不算熱）。

   這一區的重點只有一個數字：還剩幾籤。理由是規則本身 ——
   抽走最後一籤的人拿最後賞，所以剩餘籤數就是「距離最大獎還有多遠」，
   而不只是庫存。標題底下那句註解要把這個因果講出來，
   不然大數字只是好看，讀者不知道它為什麼重要。 */
const closing = computed(() =>
  pools.openPools
    .filter(p => leftPct(p) <= 65)
    .sort((a, b) => leftPct(a) - leftPct(b))
    .slice(0, 6))

/** 已抽走的百分比。緊迫感講的是「進度」，不是「庫存」，所以顯示的是這個數字 */
const gonePct = (p: Pool) => Math.round(100 - leftPct(p))

/* 緊迫度分三級，決定那張卡的色相。
   全部都染成紅色的話就沒有級距可言，看久了紅色等於沒有訊息。
   門檻抓 15 / 55：15% 以下是「隨時會被抽完」，實測只有一池（剩 3 籤），
   它該是全頁最紅的一張；中間那段給琥珀，剩下的用品牌色。
   中線刻意壓在 55 而不是 50 —— 這一區本來就只收 65% 以下的池，
   門檻若設 40，實測資料會有五池落在同一色，色階等於白做。 */
const URGENCY_VAR = ['var(--danger)', 'var(--warn)', 'var(--accent)'] as const
const urgencyHue = (p: Pool) => {
  /* 先四捨五入再比：11/20 在浮點下是 55.00000000000001，
     直接跟 55 比會落到錯的那一級 —— 卡片上寫「已抽走 45%」卻用最低一階的顏色。
     顯示的數字是整數，判斷也要用同一個整數。 */
  const left = Math.round(leftPct(p))
  return URGENCY_VAR[left <= 15 ? 0 : left <= 55 ? 1 : 2]
}
/** 標頭那顆數據籤：講「幾池已經過半」比講「共 6 池」有訊息量 */
const halfGone = computed(() => closing.value.filter(p => leftPct(p) <= 50).length)

/* ---- 第 3 區：全部抽選池 ----
   舊版另外開一整區列官方池，跟這裡的「官方池」膠囊是同一個篩選條件，
   卡片也一模一樣。刪掉那一區之後，官方背書改由這顆捷徑 + 一句保障文案承擔：
   一行字講完保障，一個按鈕直接把格線切到官方池。 */
const catalog = ref<HTMLElement | null>(null)
function onlyOfficial() {
  cat.value = 'official'
  /* 捲到格線而不是整區頂端：按鈕本身就在標頭附近，捲到標頭等於沒動。
     使用者按下之後要看到的是「換過的結果」。 */
  catalog.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/* ---- 第 4 區：現貨市場 ----
   低於市值最多的幾張。這一區跟上面三區的性質完全不同 ——
   那是抽選（碰運氣、單價低、結果未知），這是二手現貨（看得到買得到）。
   所以它搬到整頁最後，並且用綠色系與高密度小方塊，
   跟上面的紅／中性色卡片拉開，讀起來像「另一個地方的入口」而不是又一批池。 */
const marketPicks = ref<Listing[]>([])
onMounted(async () => {
  const all = await api.listMarket()
  marketPicks.value = all
    .filter(l => l.status === 'live')
    .map(l => ({ l, d: (l.price - l.card.refPrice) / l.card.refPrice }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 8)
    .map(x => x.l)
})
const dealPct = (l: Listing) => Math.round(((l.price - l.card.refPrice) / l.card.refPrice) * 100)
/** 標頭的數據籤直接寫「最多 -14%」，比「8 張」更接近使用者想知道的事 */
const bestDeal = computed(() =>
  marketPicks.value.length ? Math.min(...marketPicks.value.map(dealPct)) : 0)
</script>

<template>
  <div class="lobby" :style="{ '--hue': hue }">
    <div class="field" aria-hidden="true">
      <ShaderSky
        v-if="sky3d"
        class="skyGl"
        :energy="0.34"
        :tint="tint"
        :gain="0.55"
        :core-y="0.22"
        @fail="sky3d = false"
      />
      <!-- shader 失敗才用 CSS 光暈；兩層同時開會互相洗掉對比 -->
      <template v-if="!sky3d">
        <div class="glow g1"></div>
        <div class="glow g2"></div>
      </template>
    </div>

    <!-- ===== 今日推薦 ===== -->
    <section v-if="featured" class="stage container">
      <p class="lbl">今日推薦池</p>
      <div class="duo">
        <!-- 主視覺改成「這一池最高的那張獎品卡」而不是一顆球。
             球每一池都長一樣（只有顏色不同），傳達不了任何關於這一池的資訊；
             真正會讓人想抽的東西是那張卡。球留在形象頁（品牌符號）
             與開卡演出（開啟的隱喻），那裡才是它的位置。 -->
        <RouterLink
          :to="{ name: 'pool', params: { id: featured.id } }"
          class="prizeStage"
          :aria-label="`${featured.title}，最高賞 ${featuredPrize?.card.name ?? ''}，前往池詳情`"
        >
          <div class="prizeCard">
            <CardArt
              class="prizeArt"
              :image="''"
              :alt="featuredPrize?.card.name ?? featured.title"
              :art-id="featuredPrize?.card.artId"
              :tier="featuredTier"
            />
            <span class="holoSweep" aria-hidden="true"></span>
            <span class="rim" aria-hidden="true"></span>
          </div>
          <!-- 底下的倒影：把同一張卡上下翻轉再往下淡出。
               有倒影才像放在檯面上的實體，不然卡是飄在空中的貼圖 -->
          <div class="reflection" aria-hidden="true">
            <CardArt
              class="prizeArt"
              :image="''"
              :alt="''"
              :art-id="featuredPrize?.card.artId"
              :tier="featuredTier"
            />
          </div>

          <span v-if="featuredPrize" class="prizeTag">
            <span class="ptTier">{{ featuredTier === 'LAST' ? '最後賞' : featuredTier + ' 賞' }}</span>
            <span class="ptName">{{ featuredPrize.card.name }}</span>
          </span>
        </RouterLink>

        <div class="info">
          <div class="badges">
            <PoolModeBadge :mode="featured.mode" />
            <span v-if="featuredPrize" class="live mono">最高賞未出</span>
          </div>
          <h1>{{ featured.title }}</h1>
          <!-- 量表加上文字標籤：一條沒有標示的進度條只是裝飾，讀者要自己猜
               紅色那段是「已抽走」還是「還剩下」。推薦區是整頁最該把話講白的地方。 -->
          <div class="meterRow">
            <div class="meter" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100" :aria-label="`剩餘 ${pct}%`">
              <div class="fill" :style="{ width: pct + '%' }"></div>
            </div>
            <span class="mono meterLbl">剩 {{ featured.remainingTickets }} / {{ featured.totalTickets }} 籤</span>
          </div>
          <!-- 價格跟賣家併成一列：兩者都是「這一池的條件」，
               各自佔一整列會把主 CTA 推到摺線以下，第一屏就少一個按鈕。 -->
          <div class="nums">
            <strong class="price">{{ featured.ticketPrice.toLocaleString() }} 點<span class="per muted"> / 抽</span></strong>
            <SellerChip v-if="seller" :seller="seller" :link="false" />
          </div>
          <div class="ctas">
            <RouterLink :to="{ name: 'pool', params: { id: featured.id } }" class="btn primary go">開這一池</RouterLink>
            <RouterLink :to="{ name: 'play' }" class="btn ghost">滑動挑池 →</RouterLink>
          </div>
        </div>
      </div>
    </section>

    <div class="strip container"><WinnerTicker /></div>

    <!-- ===== 第 2 區：快沒了 =====
         整區壓在紅調的底帶上，跟下面純底色的目錄區立刻分開。
         卡片是這一頁獨有的形狀：左邊小卡圖、右邊一個超大的剩餘籤數。
         刻意不用 PoolCard —— 它把剩餘籤數放在最小的灰字，
         而這一區存在的唯一理由就是那個數字。 -->
    <section v-if="closing.length" class="urgentBand">
      <div class="container">
        <LobbySection
          tone="urgent"
          title="快沒了"
          :count="`${halfGone} 池過半`"
          note="抽走最後一籤的人拿最後賞。這幾池離那一籤最近。"
        />
        <div class="rail">
          <RouterLink
            v-for="p in closing" :key="p.id"
            :to="{ name: 'pool', params: { id: p.id } }"
            class="urg" :style="{ '--urg': urgencyHue(p) }"
          >
            <CardArt class="urgArt" :image="p.cover" :alt="p.title" :art-id="p.prizes[0]?.card.artId" />
            <div class="urgBody">
              <div class="urgHead">
                <span class="urgNum">{{ p.remainingTickets }}</span>
                <span class="urgUnit">籤<br />到最後賞</span>
              </div>
              <h3 class="urgTitle">{{ p.title }}</h3>
              <div class="urgBar" aria-hidden="true"><i :style="{ width: gonePct(p) + '%' }"></i></div>
              <div class="urgFoot">
                <span class="mono urgGone">已抽走 {{ gonePct(p) }}%</span>
                <strong class="urgPrice">{{ p.ticketPrice.toLocaleString() }} 點</strong>
              </div>
            </div>
          </RouterLink>
        </div>
      </div>
    </section>

    <!-- ===== 第 3 區：全部抽選池 =====
         這一頁的主體。它是唯一有篩選控制項的區塊，也是唯一用密集直式格線的區塊，
         這兩件事一起說明它的角色是「目錄」而不是「精選」。 -->
    <section class="all container">
      <LobbySection
        tone="catalog"
        title="全部抽選池"
        :count="String(list.length)"
        note="依來源、價位、玩法篩選。官方池由平台自營並直接出貨，交易糾紛平台全責。"
      >
        <template #action>
          <button
            v-if="cat !== 'official'" type="button" class="assureBtn"
            @click="onlyOfficial"
          >只看官方池</button>
        </template>
      </LobbySection>

      <div class="cats" role="tablist" aria-label="分類">
        <button
          v-for="c in cats" :key="c.k"
          type="button" role="tab" :aria-selected="cat === c.k"
          class="chip" :class="{ on: cat === c.k }"
          @click="cat = c.k"
        >{{ c.label }}</button>
      </div>

      <div ref="catalog" class="catalogAnchor">
        <div v-if="pools.loading && !pools.pools.length" class="poolGrid" aria-hidden="true">
          <div v-for="i in 4" :key="i" class="sk"></div>
        </div>
        <div v-else-if="list.length" class="poolGrid">
          <PoolCard v-for="p in list" :key="p.id" :pool="p" />
        </div>
        <p v-else class="muted none">這個分類目前沒有池。</p>
      </div>
    </section>

    <!-- ===== 第 4 區：現貨市場 =====
         放最後，因為它是「以上都不想抽」時的出口，不是抽池動線的一站。
         綠色底帶 + 密度最高的小方塊，讓它讀起來像換了一個地方。 -->
    <section v-if="marketPicks.length" class="marketBand">
      <div class="container">
        <LobbySection
          tone="market"
          title="現貨市場"
          :count="`最多 ${bestDeal}%`"
          note="不想碰運氣的話，這些卡的售價低於市值，看得到就買得到。"
        >
          <template #action>
            <RouterLink :to="{ name: 'market' }" class="more">看全部 →</RouterLink>
          </template>
        </LobbySection>
        <div class="rail tight">
          <RouterLink
            v-for="l in marketPicks" :key="l.id"
            :to="{ name: 'market' }" class="mini"
          >
            <CardArt class="miniArt" :image="''" :alt="l.card.name" :art-id="l.card.artId" />
            <span class="miniPct">{{ dealPct(l) }}%</span>
            <span class="miniPrice mono">{{ l.price.toLocaleString() }}</span>
          </RouterLink>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 底部讓位交給最後那一區自己吃，不寫在 .lobby 上 ——
   最後一區是滿版底帶時，外層的 padding 會在底帶下面留一條頁面底色，
   看起來像底帶被切斷。哪一區在最後由資料決定（市場可能沒有貨），
   所以兩區都各自宣告。 */
.lobby { position: relative; isolation: isolate; overflow: hidden; }

/* ---- 能量場：只鋪在推薦區那一屏，不要跟著整頁捲 ---- */
/* ---- 背景只鋪在推薦區那一屏 ----
   往下用遮罩淡出：卡片區要乾淨，星雲鋪到卡片後面會跟卡圖搶。 */
.field {
  position: absolute; inset: 0 0 auto; height: 720px;
  z-index: -1; pointer-events: none;
  -webkit-mask-image: linear-gradient(180deg, #000 0 58%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 0 58%, transparent 100%);
}
/* 淺色主題：能量場整體壓到 34% 並提早淡出。
   星雲本身是深色的，鋪在乳白頁面上會變成一塊接近純黑的舞台 ——
   卡片放上去很好看，但同一塊區域裡的池名、價格、剩餘籤數是 --ink（近黑），
   等於深字壓在深底上。桌機的資訊欄跟卡片並排，用垂直遮罩救不了，
   只能整體降透明度：星雲退成一層淡淡的暖紫暈，主視覺仍有氛圍，文字回到可讀。 */
:root[data-theme="light"] .field {
  opacity: .34;
  -webkit-mask-image: linear-gradient(180deg, #000 0 42%, transparent 88%);
  mask-image: linear-gradient(180deg, #000 0 42%, transparent 88%);
}
.skyGl { position: absolute; inset: 0; }
.glow { position: absolute; border-radius: 50%; filter: blur(70px); }
.g1 {
  width: 60vmax; height: 60vmax; left: -14vmax; top: -24vmax; opacity: .3;
  background: radial-gradient(circle, var(--hue), transparent 62%);
}
.g2 {
  width: 50vmax; height: 50vmax; right: -18vmax; top: 6vmax; opacity: .2;
  background: radial-gradient(circle, color-mix(in srgb, var(--hue) 55%, var(--accent-soft)), transparent 62%);
}
@media (prefers-reduced-motion: no-preference) {
  .g1 { animation: drift1 18s ease-in-out infinite alternate; }
  .g2 { animation: drift2 22s ease-in-out infinite alternate; }
}
@keyframes drift1 { to { transform: translate(6vmax, 5vmax) scale(1.08); } }
@keyframes drift2 { to { transform: translate(-7vmax, -4vmax) scale(1.06); } }

/* ---- 推薦 ---- */
.stage { padding-top: 22px; }
.lbl {
  display: flex; align-items: center; gap: 8px; margin: 0 0 10px;
  font-family: var(--font-mono); font-size: 11.5px; letter-spacing: .18em; color: var(--muted);
}
.lbl::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--hue); box-shadow: 0 0 8px var(--hue); }
/* 淺色主題下，推薦區的灰字全都壓在能量場上（就算已經降到 34%，
   那塊底色也比頁面暗一階），--muted 配上去只剩 3.0~3.2:1。
   推薦區內的灰字統一往 --ink 拉六成：看起來仍是次要資訊，但讀得到。
   只在 .stage 內生效 —— 其他區塊的灰字是壓在正常頁面底色上，不必動。 */
:root[data-theme="light"] .stage .lbl,
:root[data-theme="light"] .stage .meterLbl,
:root[data-theme="light"] .stage .muted {
  color: color-mix(in srgb, var(--muted) 40%, var(--ink));
}

.duo { display: grid; grid-template-columns: minmax(230px, 300px) minmax(0, 1fr); gap: 40px; align-items: center; }
.ballFx { display: block; }
/* ---- 獎品卡主視覺 ----
   卡片略微側傾、帶全像掃光、邊緣一圈球階色的光，底下有倒影。
   目標是讓它看起來像「放在展示檯上的一張實體卡」，不是一張貼圖。 */
.prizeStage {
  display: grid; justify-items: center; gap: 0;
  perspective: 1100px;
  padding-top: 6px;
}
.prizeStage:focus-visible { outline: 3px solid var(--accent); outline-offset: 10px; border-radius: var(--radius); }

.prizeCard {
  position: relative;
  width: min(74vw, 268px);
  aspect-ratio: 5 / 7;
  border-radius: 12px;
  transform-style: preserve-3d;
  /* 側傾一點才有立體感；正對著看就是一張平的圖 */
  transform: rotateY(-11deg) rotateX(5deg);
  transition: transform .5s cubic-bezier(.2, .8, .3, 1);
  filter:
    drop-shadow(0 0 26px color-mix(in srgb, var(--hue) 70%, transparent))
    drop-shadow(0 26px 44px rgba(0, 0, 0, .72));
}
@media (hover: hover) {
  .prizeStage:hover .prizeCard { transform: rotateY(-4deg) rotateX(2deg) scale(1.03); }
}
@media (prefers-reduced-motion: no-preference) {
  .prizeCard { animation: cardFloat 6s ease-in-out infinite alternate; }
}
@keyframes cardFloat { from { translate: 0 -7px; } to { translate: 0 9px; } }

/* CardArt 的根元素就是 <img>（沒圖時是佔位的 div），外面沒有包容器，
   所以裁切要寫在 .prizeArt 自己身上。原本的 `.prizeArt :deep(img)` 從來沒生效過 ——
   目前的卡圖剛好也是 5:7 所以看不出來，換一張別的比例就會被拉變形。 */
.prizeArt { width: 100%; height: 100%; border-radius: 12px; overflow: hidden; object-fit: cover; }

/* 邊緣光：沿著卡片輪廓的一圈球階色細邊，讓卡片跟背景分離 */
.rim {
  position: absolute; inset: 0;
  border-radius: 12px;
  box-shadow:
    inset 0 0 0 1.5px color-mix(in srgb, var(--hue) 75%, transparent),
    inset 0 0 22px color-mix(in srgb, var(--hue) 22%, transparent);
  pointer-events: none;
}

/* 全像掃光：實體 holo 卡轉動時本來就會跑彩虹光 */
.holoSweep {
  position: absolute; inset: 0;
  border-radius: 12px;
  pointer-events: none;
  mix-blend-mode: screen;
  background: linear-gradient(104deg,
    transparent 36%,
    rgba(255, 255, 255, .5) 46%,
    rgba(150, 215, 255, .72) 50%,
    rgba(255, 170, 240, .6) 54%,
    transparent 64%);
  background-size: 300% 100%;
}
@media (prefers-reduced-motion: no-preference) {
  .holoSweep { animation: prizeHolo 5.2s cubic-bezier(.3, 0, .3, 1) 1.2s infinite; }
}
@keyframes prizeHolo {
  0%, 68% { background-position: 190% 0; }
  100%    { background-position: -80% 0; }
}

/* 倒影：同一張卡翻轉後往下淡出。有倒影才像放在檯面上。
   高度只留實際看得到的那一段（遮罩之外全是透明），
   給滿版高度會多佔 190px 的空白，把主 CTA 推到摺線以下。 */
.reflection {
  width: min(74vw, 268px);
  height: 92px;
  overflow: hidden;
  margin-top: 4px;
  opacity: .18;
  -webkit-mask-image: linear-gradient(0deg, transparent 8%, #000 100%);
  mask-image: linear-gradient(0deg, transparent 8%, #000 100%);
  pointer-events: none;
}
/* 翻轉套在裡層：外層要保持正常的區塊高度才好控制 */
.reflection .prizeArt {
  height: auto; aspect-ratio: 5 / 7;
  transform: rotateY(-11deg) scaleY(-1);
  transform-origin: top center;
}

/* 賞別 + 卡名：壓在卡片下緣，主視覺自己把話講完 */
.prizeTag {
  display: inline-flex; align-items: center; gap: 9px;
  margin-top: -58px;
  padding: 7px 15px;
  border-radius: var(--pill);
  background: rgba(8, 6, 14, .82);
  backdrop-filter: blur(8px);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 40%, transparent);
  position: relative; z-index: 2;
}
.ptTier {
  font-size: 11.5px; font-weight: 800; letter-spacing: .06em;
  color: var(--hue);
}
.ptName { font-size: 14px; font-weight: 650; color: #fff; }

.info { display: grid; gap: 12px; justify-items: start; }
.badges { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.live { font-size: 11.5px; letter-spacing: .12em; font-weight: 600; padding: 4px 11px; border-radius: var(--pill); color: var(--ok); background: var(--ok-wash); }
h1 { font-size: clamp(24px, 3.4vw, 38px); line-height: 1.14; letter-spacing: -.02em; margin: 0; font-weight: 700; text-wrap: balance; }
/* 量表跟它的文字標籤綁成一列 —— 標籤如果自己另起一行，
   讀者要在兩個視覺物件之間建立關聯；並排就不用。 */
.meterRow { display: flex; align-items: center; gap: 12px; width: 100%; max-width: 420px; }
.meter { flex: 1 1 auto; height: 7px; border-radius: var(--pill); background: var(--surface-2); overflow: hidden; }
.fill { height: 100%; border-radius: var(--pill); background: linear-gradient(90deg, var(--accent), var(--accent-soft)); }
.meterLbl { flex: none; font-size: 12.5px; color: var(--muted); }
.nums { display: flex; align-items: baseline; gap: 16px; }
.price { font-size: 22px; font-weight: 700; letter-spacing: -.02em; }
.per { font-size: 13px; font-weight: 400; }
.ctas { display: flex; gap: 12px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
.go { padding: 14px 30px; font-size: 16px; }
@media (prefers-reduced-motion: no-preference) {
  .go { animation: breathe 2.6s ease-in-out infinite; }
}
@keyframes breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); }
  50%      { box-shadow: 0 0 0 10px color-mix(in srgb, var(--accent) 0%, transparent); }
}

.strip { padding: 20px 0 4px; }

/* ---- 分區共用 ----
   舊版四區的標頭是同一個模板（小圓點 + 17px 標題 + 灰註解），
   於是滑下來每一段都像同一段。標頭現在交給 LobbySection 分層，
   這裡只留「整段的容器」怎麼互相區隔。

   區隔手段刻意分成兩級，交替出現：
     滿版底帶（快沒了 / 現貨市場） ←→ 純頁面底色（推薦 / 全部池）
   底帶會撐滿螢幕寬並帶上下細線，是最強的分段訊號；
   一頁只用兩次，用多了就會退化成花紋。 */
.more { font-size: 13px; color: var(--accent); white-space: nowrap; }

/* 橫向捲動列 */
.rail {
  display: flex; gap: 12px;
  overflow-x: auto; scroll-snap-type: x proximity;
  scrollbar-width: none; overscroll-behavior-x: contain;
  padding-bottom: 4px;
  -webkit-mask-image: linear-gradient(90deg, #000 0 calc(100% - 28px), transparent);
  mask-image: linear-gradient(90deg, #000 0 calc(100% - 28px), transparent);
}
.rail::-webkit-scrollbar { display: none; }
.rail.tight { gap: 10px; }

/* ---- 第 2 區：快沒了 ---- */
.urgentBand {
  margin-top: 24px;
  padding: 22px 0 24px;
  /* 底帶用 danger 的極淡混色，不是純底色：整段染紅太吵，
     但完全不染又跟目錄區長一樣。9% 剛好在「看得出換段」與「不刺眼」之間，
     而且深淺主題都成立（color-mix 會各自跟該主題的 --bg 混）。 */
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--danger) 11%, transparent), transparent 62%),
    var(--surface);
  border-block: 1px solid var(--line-soft);
}

/* 緊迫卡：左圖右數字。--urg 由 script 依剩餘比例決定，
   整張卡的邊框、數字、量表共用它，換一級就整張換色。 */
.urg {
  position: relative;
  flex: 0 0 min(74vw, 300px);
  scroll-snap-align: start;
  display: grid; grid-template-columns: 84px minmax(0, 1fr);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--urg) 34%, var(--line-soft));
  transition: transform .22s cubic-bezier(.2, .7, .3, 1), box-shadow .22s;
}
@media (hover: hover) {
  .urg:hover {
    transform: translateY(-3px);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--urg) 62%, transparent), var(--shadow);
  }
}
.urg:active { transform: scale(.985); }
.urg:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* CardArt 的根元素本身就是 <img>（或佔位的 div），不是包一層容器 ——
   所以裁切要直接寫在 .urgArt 上，寫成 :deep(img) 會打不到任何東西。 */
.urgArt { width: 84px; height: 100%; object-fit: cover; }

.urgBody { padding: 10px 12px 11px; display: grid; gap: 5px; align-content: center; min-width: 0; }
/* 數字跟單位靠底線對齊：「3」「籤／到最後賞」讀起來要是一句話，
   不是一個數字加一段說明。 */
.urgHead { display: flex; align-items: flex-end; gap: 6px; }
.urgNum {
  font-family: var(--font-mono);
  font-size: 34px; font-weight: 700; line-height: .86;
  letter-spacing: -.04em;
  /* 同 LobbySection 的 .count：色相混一點 ink 才夠讀。
     琥珀（--warn）是最吃虧的一色，淺色主題下純色配乳白只有 2.6:1，
     連大字的 3:1 都不到。混 20% 之後兩套主題都過得去，仍然是琥珀。 */
  color: color-mix(in srgb, var(--urg) 80%, var(--ink));
}
.urgUnit { font-size: 10.5px; line-height: 1.25; color: var(--muted); padding-bottom: 1px; }
.urgTitle {
  margin: 0; font-size: 13px; font-weight: 600; line-height: 1.25;
  color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 量表方向刻意跟推薦區相反：這裡填的是「已抽走」，越滿越緊張。
   推薦區填的是「還剩下」。兩區的量表語意不同，所以旁邊都有文字標籤。 */
.urgBar { height: 4px; border-radius: var(--pill); background: var(--surface-2); overflow: hidden; }
.urgBar i { display: block; height: 100%; border-radius: var(--pill); background: var(--urg); }
.urgFoot { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.urgGone { font-size: 11px; color: var(--muted); }
.urgPrice { font-size: 13px; font-weight: 700; color: var(--ink); white-space: nowrap; }

/* ---- 第 4 區：現貨市場 ---- */
.marketBand {
  margin-top: 30px;
  padding: 22px 0 calc(30px + var(--nav-total));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--ok) 10%, transparent), transparent 62%),
    var(--surface);
  border-block: 1px solid var(--line-soft);
}

/* 市場小方塊：整頁密度最高的一區，跟旁邊的大卡形成對比 */
.mini {
  position: relative; flex: 0 0 92px;
  scroll-snap-align: start;
  border-radius: var(--radius); overflow: hidden;
  background: var(--surface-2);
  transition: transform .2s;
}
@media (hover: hover) { .mini:hover { transform: translateY(-3px); } }
.miniArt { width: 100%; aspect-ratio: 5 / 7; object-fit: cover; }
.miniPct {
  position: absolute; top: 5px; left: 5px;
  font-size: 10.5px; font-weight: 700;
  padding: 2px 6px; border-radius: var(--pill);
  /* 底是飽和綠，字色不能兩套主題共用一個值：
     深色主題用 --bg（近黑）壓在綠上最清楚；淺色主題的 --bg 是乳白，
     疊在同一塊綠上只有 1.8:1，所以那邊反過來用 --ink。
     這裡不寫死色碼，是因為兩個主題的綠不同（#35c98a / #23a06a），
     寫死的深綠在其中一邊一定會偏。 */
  background: var(--ok); color: var(--bg);
}
:root[data-theme="light"] .miniPct { color: var(--ink); }
.miniPrice {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 12px 6px 5px;
  font-size: 11.5px; font-weight: 700; color: #fff; text-align: center;
  background: linear-gradient(0deg, rgba(8,6,14,.92), transparent);
}

@media (min-width: 900px) {
  /* 桌機容器有 1180px 寬，92px 的小方塊排八個只鋪到一半，
     整條看起來像「沒排滿」而不是「還可以往右滑」。放大才填得住版面。 */
  .mini { flex: 0 0 122px; }
  .rail.tight { gap: 12px; }
}

/* ---- 第 3 區：全部抽選池 ---- */
.all { padding-top: 30px; }
/* 市場區沒有資料時，目錄就是最後一區，底部讓位改由它負責 */
.all:last-child { padding-bottom: calc(40px + var(--nav-total)); }

/* 「只看官方池」：舊版整整一區、兩張跟下面格線一模一樣的官方池卡，
   換成標頭右側這一顆按鈕 + 標頭底下那句保障文案。
   同樣講完「平台自營、糾紛全責、想只看官方池按這裡」，
   省掉 312px 的重複捲動，也解掉兩張卡的 view-transition-name 撞號。
   樣式刻意不做成 chip：它跟底下那排分類膠囊是不同性質的東西
   （一個是捷徑，一排是狀態），長得一樣會被誤認成第十顆分類。 */
.assureBtn {
  flex: none;
  min-height: 34px;
  padding: 6px 13px;
  border-radius: var(--pill);
  border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent);
  background: var(--accent-wash);
  /* 淺色主題下，橘紅原色配 --accent-wash 只有 2.9:1，12.5px 的粗體讀起來會糊。
     混 38% 的 ink 之後兩套主題都過 4.5:1，而且混的方向各自正確
     （淺色往深走、深色往亮走），紅還是紅。 */
  color: color-mix(in srgb, var(--accent) 62%, var(--ink));
  font-size: 12.5px; font-weight: 600; cursor: pointer;
  transition: background .15s, border-color .15s;
}
@media (hover: hover) { .assureBtn:hover { border-color: var(--accent); } }
.assureBtn:active { transform: scale(.96); }
.assureBtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* 捲動目標：按下「只看官方池」後要停在格線頂端而不是標頭，
   scroll-margin 把固定頁首的高度讓出來，不然第一列會被蓋住。 */
.catalogAnchor { scroll-margin-top: 76px; }

/* 右緣淡出：這排是可以左右滑的，但截斷處如果是硬邊，看起來就只是「被切掉」
   而不是「還有更多」。mask 讓最後一顆膠囊漸隱，滑動的可能性才看得出來。 */
.cats {
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 34px), transparent 100%);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 34px), transparent 100%);
  display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; margin: 14px 0 16px; padding-bottom: 2px; }
.cats::-webkit-scrollbar { display: none; }
.chip {
  flex: none;
  /* 44px 是觸控目標下限；視覺上仍是細膠囊，靠 padding 撐開可點區域 */
  min-height: 44px;
  padding: 8px 16px; border-radius: var(--pill);
  border: 1px solid var(--line-soft); background: transparent;
  color: var(--muted); font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s, transform .1s;
}
.chip.on { background: var(--ink); color: var(--bg); border-color: transparent; font-weight: 600; }
@media (hover: hover) { .chip:not(.on):hover { color: var(--ink); border-color: var(--line); } }
.chip:active { transform: scale(.96); }
.chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* 命名要夠specific：子元件的根元素會帶上父層的 scope id，所以父層寫 `.grid`
   會打到 PoolCard 的根 —— 而 PoolCard 的預設 variant 剛好就叫 grid，
   class 是 "pool grid"。結果卡片自己變成 grid 容器、卡圖寬度被壓成 0，
   徽章擠成一行一個字。父層的版面 class 不要用通用字。 */
.poolGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
.sk { height: 320px; border-radius: var(--radius); background: var(--surface-2); }
@media (prefers-reduced-motion: no-preference) { .sk { animation: pulse 1.4s ease-in-out infinite alternate; } }
@keyframes pulse { to { opacity: .55; } }
.none { text-align: center; padding: 46px 0; }

@media (max-width: 960px) {
  .duo { grid-template-columns: minmax(180px, 250px) minmax(0, 1fr); gap: 26px; }
}
@media (max-width: 720px) {
  .stage { padding-top: 12px; }
  .duo { grid-template-columns: 1fr; gap: 14px; justify-items: center; text-align: center; }
  /* 手機上主視覺再收一階（215→200、倒影 70→40）。
     少掉的 50px 不是為了「更緊湊」，是為了讓底下那條紅色底帶的
     標題剛好露在底部導覽上方 —— 使用者才知道再滑會換到另一種東西。
     推薦區佔滿整個第一屏的話，看起來就像整頁只有這一池。 */
  .prizeCard, .reflection { width: min(55vw, 200px); }
  .reflection { height: 40px; }
  .prizeTag { margin-top: -44px; }

  /* 手機上改成靠左＋每一列撐滿寬度。
     原本整欄置中，短元素（徽章、價格、賣家）只佔內容寬度，
     左右各留一大塊空白，看起來很稀疏 —— 資訊沒有變多，只是沒在用版面。
     卡片維持置中（它是主視覺），底下的資訊列靠左，是常見的
     「主視覺置中、細節左對齊」寫法，不會顯得不協調。 */
  .info { justify-items: stretch; text-align: left; gap: 9px; width: 100%; }
  .badges { justify-content: flex-start; }
  h1 { font-size: 21px; }
  .meterRow { max-width: none; }
  .price { font-size: 21px; }
  /* 價格靠左、賣家靠右，把整條寬度用掉 */
  .nums { justify-content: space-between; gap: 10px; width: 100%; }
  /* 主鈕吃掉剩餘寬度，次要連結靠右 */
  .ctas { justify-content: space-between; width: 100%; gap: 10px; flex-wrap: nowrap; }
  .go { flex: 1 1 auto; max-width: none; padding: 13px 16px; font-size: 15px; }
  .ctas .btn.ghost { flex: none; padding: 13px 4px; font-size: 13.5px; }
  .strip { padding: 10px 0 0; }
  .field { height: 560px; }
  .poolGrid { grid-template-columns: repeat(2, 1fr); gap: 11px; }
  .sk { height: 250px; }

  .urgentBand { margin-top: 12px; padding: 16px 0 20px; }
  .marketBand { margin-top: 24px; padding: 18px 0 calc(26px + var(--nav-total)); }
  .all { padding-top: 24px; }
  /* 卡寬收到 66vw：375px 上第二張會露出約三分之一，
     「這排可以左右滑」不必靠說明文字，露出來的那一角自己會講。 */
  .urg { flex: 0 0 66vw; grid-template-columns: 74px minmax(0, 1fr); }
  .urgArt { width: 74px; }
  .urgNum { font-size: 30px; }
}

/* 320px：卡片寬度改用 vw 之後在最窄的螢幕上會擠成兩位數字換行，
   單獨把卡圖再收一階，數字維持大字 —— 那是這一區唯一不能犧牲的東西。 */
@media (max-width: 360px) {
  .urg { flex: 0 0 76vw; grid-template-columns: 64px minmax(0, 1fr); }
  .urgArt { width: 64px; }
  .urgUnit { font-size: 10px; }
  .mini { flex: 0 0 84px; }
}
</style>
