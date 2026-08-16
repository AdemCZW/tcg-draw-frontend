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
import type { Pool, Tier } from '@/types/models'
import CapsuleArt from '@/components/CapsuleArt.vue'
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

/* ---- 分類 ---- */
type Cat = 'all' | 'hot' | 'cheap' | 'big' | 'special' | 'done'
const cat = ref<Cat>('all')

const MATCH: Record<Cat, (p: Pool) => boolean> = {
  all: p => p.status === 'open',
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
  { k: 'hot', label: '快完抽' },
  { k: 'big', label: '高額賞' },
  { k: 'cheap', label: '銅板價' },
  { k: 'special', label: '特殊玩法' },
  { k: 'done', label: '已完抽' }
]
/** 空的分類不顯示 —— 點進去看到空白比少一個選項糟 */
const cats = computed(() => CATS.filter(c => pools.pools.some(MATCH[c.k])))
const list = computed(() => pools.pools.filter(MATCH[cat.value]))
</script>

<template>
  <div class="lobby" :style="{ '--hue': hue }">
    <div class="field" aria-hidden="true">
      <div class="glow g1"></div>
      <div class="glow g2"></div>
    </div>

    <!-- ===== 今日推薦 ===== -->
    <section v-if="featured" class="stage container">
      <p class="lbl">今日推薦池</p>
      <div class="duo">
        <RouterLink
          :to="{ name: 'pool', params: { id: featured.id } }"
          class="ballWrap"
          :aria-label="`${featured.title}，前往池詳情`"
        >
          <CapsuleArt :tier="featuredTier" :hash="featured.commitHash" />
        </RouterLink>

        <div class="info">
          <div class="badges">
            <PoolModeBadge :mode="featured.mode" />
            <span v-if="featuredPrize" class="live mono">最高賞未出</span>
          </div>
          <h1>{{ featured.title }}</h1>
          <p v-if="featuredPrize" class="prize">
            <span class="muted">{{ featuredTier === 'LAST' ? '最後賞' : featuredTier + ' 賞' }}</span>
            {{ featuredPrize.card.name }}
          </p>
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

      <div v-if="pools.loading && !pools.pools.length" class="grid" aria-hidden="true">
        <div v-for="i in 4" :key="i" class="sk"></div>
      </div>
      <div v-else-if="list.length" class="grid">
        <PoolCard v-for="p in list" :key="p.id" :pool="p" />
      </div>
      <p v-else class="muted none">這個分類目前沒有池。</p>
    </section>
  </div>
</template>

<style scoped>
.lobby { position: relative; padding-bottom: calc(40px + var(--nav-total)); isolation: isolate; overflow: hidden; }

/* ---- 能量場：只鋪在推薦區那一屏，不要跟著整頁捲 ---- */
.field { position: absolute; inset: 0 0 auto; height: 720px; z-index: -1; pointer-events: none; }
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

.duo { display: grid; grid-template-columns: minmax(220px, 340px) minmax(0, 1fr); gap: 34px; align-items: center; }
.ballWrap { display: block; border-radius: 50%; transition: transform .4s cubic-bezier(.2, .8, .3, 1); }
@media (hover: hover) { .ballWrap:hover { transform: translateY(-6px) scale(1.02); } }
.ballWrap:focus-visible { outline: 3px solid var(--accent); outline-offset: 8px; }
@media (prefers-reduced-motion: no-preference) {
  .ballWrap { animation: bob 5.2s ease-in-out infinite alternate; }
}
@keyframes bob { from { translate: 0 -6px; } to { translate: 0 8px; } }

.info { display: grid; gap: 12px; justify-items: start; }
.badges { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.live { font-size: 11.5px; letter-spacing: .12em; font-weight: 600; padding: 4px 11px; border-radius: var(--pill); color: var(--ok); background: var(--ok-wash); }
h1 { font-size: clamp(24px, 3.4vw, 38px); line-height: 1.14; letter-spacing: -.02em; margin: 0; font-weight: 700; text-wrap: balance; }
.prize { margin: -4px 0 0; font-size: 16px; }
.prize .muted { margin-right: 8px; }
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

/* ---- 全部池 ---- */
.all { padding-top: 14px; }
.allHead { display: flex; align-items: baseline; gap: 10px; }
h2 { font-size: 18px; margin: 0; letter-spacing: -.01em; }
.count { font-size: 13px; }

.cats { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; margin: 14px 0 16px; padding-bottom: 2px; }
.cats::-webkit-scrollbar { display: none; }
.chip {
  flex: none;
  padding: 8px 15px; border-radius: var(--pill);
  border: 1px solid var(--line-soft); background: transparent;
  color: var(--muted); font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s, transform .1s;
}
.chip.on { background: var(--ink); color: var(--bg); border-color: transparent; font-weight: 600; }
@media (hover: hover) { .chip:not(.on):hover { color: var(--ink); border-color: var(--line); } }
.chip:active { transform: scale(.96); }
.chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
.sk { height: 320px; border-radius: var(--radius); background: var(--surface-2); }
@media (prefers-reduced-motion: no-preference) { .sk { animation: pulse 1.4s ease-in-out infinite alternate; } }
@keyframes pulse { to { opacity: .55; } }
.none { text-align: center; padding: 46px 0; }

@media (max-width: 960px) {
  .duo { grid-template-columns: minmax(180px, 260px) minmax(0, 1fr); gap: 24px; }
}
@media (max-width: 720px) {
  .stage { padding-top: 12px; }
  .duo { grid-template-columns: 1fr; gap: 8px; justify-items: center; text-align: center; }
  .ballWrap { width: min(56vw, 220px); }
  .info { justify-items: center; gap: 9px; }
  .badges { justify-content: center; }
  h1 { font-size: 21px; }
  .prize { font-size: 14px; }
  .meter { max-width: 320px; }
  .price { font-size: 19px; }
  .ctas { justify-content: center; width: 100%; }
  .go { flex: 1 1 auto; max-width: 260px; padding: 13px 20px; font-size: 15px; }
  .strip { padding: 14px 0 2px; }
  .field { height: 560px; }
  .grid { grid-template-columns: repeat(2, 1fr); gap: 11px; }
  .sk { height: 250px; }
}
</style>
