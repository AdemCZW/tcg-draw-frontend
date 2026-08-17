<script setup lang="ts">
/**
 * 大廳 —— 今日推薦 + 全部抽選池。
 *
 * 原本「大廳」與「全部池」是兩頁，但它們回答的是同一個問題：
 * 「現在有什麼可以開」。差別只是一個挑重點、一個列全部 —— 那是同一頁的
 * 上半跟下半，不是兩個目的地。合併後導覽也空出一格給市場。
 *
 * 分類刻意做成極簡的橫向膠囊：不是多層篩選器，是「我現在想找哪一種」
 * 的一次點擊。條件都算得出來，不需要後端支援。
 */
import { computed, onMounted, ref } from 'vue'
import { usePoolStore } from '@/stores/pools'
import { useSellerStore } from '@/stores/sellers'
import type { Listing, Pool, Tier } from '@/types/models'
import { api } from '@/lib/api'
import CardArt from '@/components/CardArt.vue'
import ShaderSky from '@/components/ShaderSky.vue'
import PoolCard from '@/components/PoolCard.vue'
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
  special: p => p.status === 'open' && ['streak', 'auction', 'niboichi', 'battle', 'muteki'].includes(p.mode),
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

/* ---- 分區的資料 ----
   大廳單調的原因不是特效不夠，是「整頁只有一種模組」：一排一樣大的卡片格線。
   遊戲大廳的節奏來自模組形狀交替 —— 大主視覺 → 橫向捲動列 → 寬版帶 → 密集格線。
   下面三個區塊各自用不同的排版方式，就是為了製造這個節奏。 */

/* 熱抽中：依「已抽走的比例」排序，取前六。
   本來寫死「剩不到 45% 才算快完抽」，但實測只有一池符合 ——
   橫向捲動列只有一張卡是沒有意義的版面。改成排序取前 N，
   資料怎麼分布都填得滿；門檻只用來擋掉幾乎沒人抽的池（未達 35% 不算熱）。
   標題也跟著改成「熱抽中」而不是「快完抽」—— 一池剩 64% 說它快完抽是誇大。 */
const closing = computed(() =>
  pools.openPools
    .filter(p => leftPct(p) <= 65)
    .sort((a, b) => leftPct(a) - leftPct(b))
    .slice(0, 6))

/** 官方池：平台自營，當基準線 */
const officials = computed(() => pools.openPools.filter(p => p.origin === 'official').slice(0, 2))

/** 市場精選：低於市值最多的幾張 */
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
          <div class="meter" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100" :aria-label="`剩餘 ${pct}%`">
            <div class="fill" :style="{ width: pct + '%' }"></div>
          </div>
          <div class="nums">
            <strong class="price">{{ featured.ticketPrice.toLocaleString() }} 點<span class="per muted"> / 抽</span></strong>
            <span class="mono muted rest">剩 {{ featured.remainingTickets }} / {{ featured.totalTickets }}</span>
          </div>
          <div class="ctas">
            <RouterLink :to="{ name: 'pool', params: { id: featured.id } }" class="btn primary go">開這一池</RouterLink>
            <RouterLink :to="{ name: 'play' }" class="btn ghost">滑動挑池 →</RouterLink>
          </div>
          <div v-if="seller" class="sellerRow"><SellerChip :seller="seller" :link="false" /></div>
        </div>
      </div>
    </section>

    <div class="strip container"><WinnerTicker /></div>

    <!-- ===== 快完抽：橫向捲動列，寬版卡 =====
         跟下面的直式格線形狀完全不同 —— 節奏就是這樣做出來的 -->
    <section v-if="closing.length" class="band container">
      <header class="bh">
        <h2><span class="dot hot"></span>熱抽中</h2>
        <span class="muted bhNote">已抽走最多的幾池，抽走最後一籤有最後賞</span>
      </header>
      <div class="rail">
        <PoolCard v-for="p in closing" :key="p.id" :pool="p" variant="wide" class="railItem" />
      </div>
    </section>

    <!-- ===== 官方池：兩張大卡，獨立的帶狀底色 ===== -->
    <section v-if="officials.length" class="official">
      <div class="container">
        <header class="bh">
          <h2><span class="dot off"></span>官方池</h2>
          <span class="muted bhNote">平台自營並直接出貨，糾紛平台全責</span>
        </header>
        <div class="offGrid">
          <PoolCard v-for="p in officials" :key="p.id" :pool="p" />
        </div>
      </div>
    </section>

    <!-- ===== 市場精選：小方塊橫排，密度最高的一區 ===== -->
    <section v-if="marketPicks.length" class="band container">
      <header class="bh">
        <h2><span class="dot deal"></span>市場低於市值</h2>
        <RouterLink :to="{ name: 'market' }" class="more">看全部 →</RouterLink>
      </header>
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
    </section>

    <!-- ===== 全部池 ===== -->
    <section class="all container">
      <header class="allHead">
        <h2>抽選池</h2>
        <span class="muted count mono">{{ list.length }}</span>
      </header>

      <div class="cats" role="tablist" aria-label="分類">
        <button
          v-for="c in cats" :key="c.k"
          type="button" role="tab" :aria-selected="cat === c.k"
          class="chip" :class="{ on: cat === c.k }"
          @click="cat = c.k"
        >{{ c.label }}</button>
      </div>

      <div v-if="pools.loading && !pools.pools.length" class="poolGrid" aria-hidden="true">
        <div v-for="i in 4" :key="i" class="sk"></div>
      </div>
      <div v-else-if="list.length" class="poolGrid">
        <PoolCard v-for="p in list" :key="p.id" :pool="p" />
      </div>
      <p v-else class="muted none">這個分類目前沒有池。</p>
    </section>
  </div>
</template>

<style scoped>
.lobby { position: relative; padding-bottom: calc(40px + var(--nav-total)); isolation: isolate; overflow: hidden; }

/* ---- 能量場：只鋪在推薦區那一屏，不要跟著整頁捲 ---- */
/* ---- 背景只鋪在推薦區那一屏 ----
   往下用遮罩淡出：卡片區要乾淨，星雲鋪到卡片後面會跟卡圖搶。 */
.field {
  position: absolute; inset: 0 0 auto; height: 720px;
  z-index: -1; pointer-events: none;
  -webkit-mask-image: linear-gradient(180deg, #000 0 58%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 0 58%, transparent 100%);
}
.skyGl { position: absolute; inset: 0; }
.glow { position: absolute; border-radius: 50%; filter: blur(70px); }
.g1 {
  width: 60vmax; height: 60vmax; left: -14vmax; top: -24vmax; opacity: .3;
  background: radial-gradient(circle, var(--hue), transparent 62%);
}
.g2 {
  width: 50vmax; height: 50vmax; right: -18vmax; top: 6vmax; opacity: .2;
  background: radial-gradient(circle, color-mix(in srgb, var(--hue) 55%, #ff5236), transparent 62%);
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

.prizeArt { width: 100%; height: 100%; border-radius: 12px; overflow: hidden; }
.prizeArt :deep(img) { width: 100%; height: 100%; object-fit: cover; }

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
.meter { width: 100%; max-width: 380px; height: 7px; border-radius: var(--pill); background: var(--surface-2); overflow: hidden; }
.fill { height: 100%; border-radius: var(--pill); background: linear-gradient(90deg, var(--accent), var(--accent-soft)); }
.nums { display: flex; align-items: baseline; gap: 16px; }
.price { font-size: 22px; font-weight: 700; letter-spacing: -.02em; }
.per { font-size: 13px; font-weight: 400; }
.rest { font-size: 13px; }
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

/* ---- 分區共用 ---- */
.band { padding-top: 26px; }
.bh { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.bh h2 { display: flex; align-items: center; gap: 8px; font-size: 17px; margin: 0; letter-spacing: -.01em; }
.bhNote { font-size: 12px; }
.more { margin-left: auto; font-size: 13px; color: var(--accent); }
/* 每一區一個顏色的小點：不用整區換色（那會很吵），
   一個點就足以讓眼睛知道「換段落了」 */
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dot.hot { background: #ff5236; box-shadow: 0 0 8px #ff5236; }
.dot.off { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
.dot.deal { background: var(--ok); box-shadow: 0 0 8px var(--ok); }

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
.railItem { flex: 0 0 min(78vw, 340px); scroll-snap-align: start; }
.rail.tight { gap: 10px; }

/* 市場小方塊：整頁密度最高的一區，跟旁邊的大卡形成對比 */
.mini {
  position: relative; flex: 0 0 92px;
  scroll-snap-align: start;
  border-radius: var(--radius); overflow: hidden;
  background: var(--surface-2);
  transition: transform .2s;
}
@media (hover: hover) { .mini:hover { transform: translateY(-3px); } }
.miniArt { width: 100%; aspect-ratio: 5 / 7; }
.miniArt :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.miniPct {
  position: absolute; top: 5px; left: 5px;
  font-size: 10.5px; font-weight: 700;
  padding: 2px 6px; border-radius: var(--pill);
  background: var(--ok); color: #06210f;
}
.miniPrice {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 12px 6px 5px;
  font-size: 11.5px; font-weight: 700; color: #fff; text-align: center;
  background: linear-gradient(0deg, rgba(8,6,14,.92), transparent);
}

/* 官方池帶：獨立底色把它從深色頁面裡切出來 */
.official {
  margin-top: 26px;
  padding: 22px 0 24px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--accent) 9%, transparent), transparent 70%),
    var(--surface);
  border-block: 1px solid var(--line-soft);
}
.offGrid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; max-width: 560px; }

/* ---- 全部池 ---- */
.all { padding-top: 14px; }
.allHead { display: flex; align-items: baseline; gap: 10px; }
h2 { font-size: 18px; margin: 0; letter-spacing: -.01em; }
.count { font-size: 13px; }

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
  .prizeCard, .reflection { width: min(58vw, 215px); }
  .reflection { height: 70px; }
  .prizeTag { margin-top: -46px; }

  /* 手機上改成靠左＋每一列撐滿寬度。
     原本整欄置中，短元素（徽章、價格、賣家）只佔內容寬度，
     左右各留一大塊空白，看起來很稀疏 —— 資訊沒有變多，只是沒在用版面。
     卡片維持置中（它是主視覺），底下的資訊列靠左，是常見的
     「主視覺置中、細節左對齊」寫法，不會顯得不協調。 */
  .info { justify-items: stretch; text-align: left; gap: 10px; width: 100%; }
  .badges { justify-content: flex-start; }
  h1 { font-size: 21px; }
  .meter { max-width: none; }
  .price { font-size: 21px; }
  /* 價格靠左、剩餘靠右，把整條寬度用掉 */
  .nums { justify-content: space-between; gap: 10px; width: 100%; }
  .rest { font-size: 12.5px; }
  /* 主鈕吃掉剩餘寬度，次要連結靠右 */
  .ctas { justify-content: space-between; width: 100%; gap: 10px; flex-wrap: nowrap; }
  .go { flex: 1 1 auto; max-width: none; padding: 13px 16px; font-size: 15px; }
  .ctas .btn.ghost { flex: none; padding: 13px 4px; font-size: 13.5px; }
  .sellerRow { justify-content: flex-start; }
  .strip { padding: 14px 0 2px; }
  .field { height: 560px; }
  .poolGrid { grid-template-columns: repeat(2, 1fr); gap: 11px; }
  .sk { height: 250px; }
}
</style>
