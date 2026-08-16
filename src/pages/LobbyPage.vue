<script setup lang="ts">
/**
 * 大廳 —— 一屏內就能開始玩。
 *
 * 之前是 SaaS landing page 的骨架：hero 文案 + 三步流程 + 池 grid，
 * 手機要捲 1.6 屏才看得到第一張池卡。手遊大廳的定義是相反的：
 * 主角在中央、最大；一屏不捲動；底部導覽永遠在手指旁。
 *
 * 版面三帶：狀態列（sticky） / 主舞台（flex:1） / 動態帶。
 * 主舞台是「今日推薦池」—— 用一顆寶貝球當它的視覺錨，球階對應該池
 * 目前還沒出的最高賞。CTA 只有一個。
 *
 * 搬走的內容：三步流程併進 /fairness（那裡本來就有更完整的版本），
 * 池 grid 是 /pools 的工作，hero 的 three.js 舞台整個拿掉（734 KB）。
 */
import { computed, onMounted, ref } from 'vue'
import { usePoolStore } from '@/stores/pools'
import { useSellerStore } from '@/stores/sellers'
import type { Pool, Tier } from '@/types/models'
import CapsuleArt from '@/components/CapsuleArt.vue'
import WinnerTicker from '@/components/WinnerTicker.vue'
import PoolModeBadge from '@/components/PoolModeBadge.vue'
import SellerChip from '@/components/SellerChip.vue'

const pools = usePoolStore()
const sellers = useSellerStore()
onMounted(() => { pools.ensureLoaded(); sellers.ensureLoaded() })

const RANK: Record<Tier, number> = { BUST: 0, D: 1, C: 2, B: 3, A: 4, LAST: 5 }

/** 一池目前還沒出的最高賞。這決定寶貝球的球階與推薦排序 */
function topLiveTier(p: Pool): Tier {
  return p.prizes
    .filter(x => x.remaining > 0)
    .reduce<Tier>((best, x) => (RANK[x.tier] > RANK[best] ? x.tier : best), 'D')
}

/* 今日推薦：開放中、最高賞還沒出的池優先；同級比剩餘率（越接近完抽越緊張）。
   用日期當種子輪替第一名，同一天進站看到的是同一池，隔天會換。 */
const featured = computed<Pool | undefined>(() => {
  const open = pools.openPools
  if (!open.length) return undefined
  const ranked = [...open].sort((a, b) => {
    const t = RANK[topLiveTier(b)] - RANK[topLiveTier(a)]
    if (t) return t
    return a.remainingTickets / a.totalTickets - b.remainingTickets / b.totalTickets
  })
  const top = ranked.slice(0, Math.min(3, ranked.length))
  const day = Math.floor(Date.now() / 86_400_000)
  return top[day % top.length]
})
const featuredTier = computed(() => (featured.value ? topLiveTier(featured.value) : 'D'))
const featuredPrize = computed(() =>
  featured.value?.prizes.find(p => p.tier === featuredTier.value && p.remaining > 0))
const seller = computed(() => (featured.value ? sellers.byId(featured.value.sellerId) : undefined))
const pct = computed(() =>
  featured.value ? Math.round((featured.value.remainingTickets / featured.value.totalTickets) * 100) : 0)

/** 其他進行中的池，給桌機右欄 */
const others = computed(() =>
  pools.openPools.filter(p => p.id !== featured.value?.id).slice(0, 3))

/* 寶貝球的環境色跟著球階走：這一片能量場就是大廳的「主題色」 */
const TIER_HUE: Record<Tier, string> = {
  D: '#ef4040', C: '#3f7fd8', B: '#f5c400', A: '#d8b25a', LAST: '#8b4fd0', BUST: '#ef4040'
}
const hue = computed(() => TIER_HUE[featuredTier.value])

/* 首次進站的簡短引導：三張 swipe 卡，取代原本首頁那三個教育區塊 */
const ONBOARD_KEY = 'vd.onboarded'
const showOnboard = ref(false)
onMounted(() => {
  try { showOnboard.value = !localStorage.getItem(ONBOARD_KEY) } catch { showOnboard.value = false }
})
function dismissOnboard() {
  showOnboard.value = false
  try { localStorage.setItem(ONBOARD_KEY, '1') } catch { /* 無痕模式也沒關係 */ }
}
const ONBOARD = [
  { t: '每支籤開賣前就封存', d: '籤序先洗好、公布 SHA-256 承諾雜湊。之後改不了。' },
  { t: '你自己挑要開哪一支', d: '不是系統代抽 —— 選籤牆上親手點。' },
  { t: '完抽後任何人都能驗算', d: '公開種子，你可以自己重算一次比對。' }
]
</script>

<template>
  <div class="lobby" :style="{ '--hue': hue }">
    <!-- 能量場：兩層很慢的徑向漸層互相漂移，加上寶貝球分模線的暗紋。
         這是「大廳」跟「網頁」的差別 —— 背景是活的。 -->
    <div class="field" aria-hidden="true">
      <div class="glow g1"></div>
      <div class="glow g2"></div>
      <div class="seam"></div>
    </div>

    <!-- ===== 主舞台 ===== -->
    <main class="stage container">
      <template v-if="featured">
        <p class="lbl">今日推薦池</p>

        <div class="duo">
          <!-- 左：寶貝球，球階＝這一池還沒出的最高賞 -->
          <RouterLink
            :to="{ name: 'pool', params: { id: featured.id } }"
            class="ballWrap"
            :aria-label="`${featured.title}，前往池詳情`"
          >
            <CapsuleArt :tier="featuredTier" :hash="featured.commitHash" />
          </RouterLink>

          <!-- 右：池的關鍵資訊 -->
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

            <div class="meter" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100"
                 :aria-label="`剩餘 ${pct}%`">
              <div class="fill" :style="{ width: pct + '%' }"></div>
            </div>
            <div class="nums">
              <strong class="price">{{ featured.ticketPrice.toLocaleString() }} 點<span class="per muted"> / 抽</span></strong>
              <span class="mono muted rest">剩 {{ featured.remainingTickets }} / {{ featured.totalTickets }}</span>
            </div>

            <div class="ctas">
              <RouterLink :to="{ name: 'pool', params: { id: featured.id } }" class="btn primary go">
                開這一池
              </RouterLink>
              <RouterLink :to="{ name: 'play' }" class="btn ghost">挑別池 →</RouterLink>
            </div>
            <div v-if="seller" class="sellerRow"><SellerChip :seller="seller" :link="false" /></div>
          </div>
        </div>

        <!-- 桌機右欄：其他進行中的池 -->
        <aside v-if="others.length" class="others">
          <p class="lbl">也在抽選中</p>
          <RouterLink
            v-for="p in others" :key="p.id"
            :to="{ name: 'pool', params: { id: p.id } }"
            class="mini"
          >
            <span class="miniBall"><CapsuleArt :tier="topLiveTier(p)" compact flat /></span>
            <span class="miniText">
              <strong>{{ p.title }}</strong>
              <span class="mono muted">{{ p.ticketPrice.toLocaleString() }} 點 · 剩 {{ p.remainingTickets }}</span>
            </span>
          </RouterLink>
        </aside>
      </template>

      <div v-else-if="pools.loading" class="skel" aria-hidden="true">
        <div class="skBall"></div>
        <div class="skLines"><i></i><i></i><i></i></div>
      </div>

      <p v-else class="muted empty">目前沒有進行中的抽選池。</p>
    </main>

    <!-- ===== 動態帶 ===== -->
    <div class="strip container">
      <WinnerTicker />
    </div>

    <!-- ===== 首次進站引導 ===== -->
    <div v-if="showOnboard" class="onboard" role="dialog" aria-label="怎麼玩">
      <div class="onboardCard">
        <div class="obSlides">
          <div v-for="(o, i) in ONBOARD" :key="i" class="obSlide">
            <span class="obN mono">{{ i + 1 }}</span>
            <h2>{{ o.t }}</h2>
            <p class="muted">{{ o.d }}</p>
          </div>
        </div>
        <div class="obActs">
          <RouterLink :to="{ name: 'fairness' }" class="btn ghost sm" @click="dismissOnboard">看完整說明</RouterLink>
          <button type="button" class="btn primary sm" @click="dismissOnboard">開始</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 一屏：header 66px + nav（手機）之外的高度全給大廳。
   100dvh 而不是 100vh —— iOS 的網址列會吃掉 vh，dvh 才是實際看得到的高度 */
.lobby {
  position: relative;
  min-height: calc(100dvh - 66px - var(--nav-total));
  display: grid;
  grid-template-rows: 1fr auto;
  overflow: hidden;
  isolation: isolate;
}
@media (max-width: 720px) {
  .lobby { min-height: calc(100dvh - 56px - var(--nav-total)); }
}

/* ---- 能量場 ---- */
.field { position: absolute; inset: 0; z-index: -1; pointer-events: none; }
.glow {
  position: absolute; border-radius: 50%;
  filter: blur(70px);
  opacity: .32;
}
.g1 {
  width: 62vmax; height: 62vmax; left: -14vmax; top: -22vmax;
  background: radial-gradient(circle, var(--hue), transparent 62%);
}
.g2 {
  width: 54vmax; height: 54vmax; right: -18vmax; bottom: -20vmax;
  background: radial-gradient(circle, color-mix(in srgb, var(--hue) 55%, #ff5236), transparent 62%);
  opacity: .22;
}
/* 寶貝球分模線：一條橫過畫面的暗帶，中間一顆環。很淡，是背景的骨架不是主角 */
.seam {
  position: absolute; left: -10%; right: -10%; top: 50%;
  height: 2px; translate: 0 -50%;
  background: linear-gradient(90deg, transparent, var(--line) 30%, var(--line) 70%, transparent);
  opacity: .5;
}
.seam::after {
  content: ''; position: absolute; left: 50%; top: 50%;
  width: 20vmin; height: 20vmin; translate: -50% -50%;
  border: 1.5px solid var(--line); border-radius: 50%;
  opacity: .5;
}
@media (prefers-reduced-motion: no-preference) {
  .g1 { animation: drift1 18s ease-in-out infinite alternate; }
  .g2 { animation: drift2 22s ease-in-out infinite alternate; }
}
@keyframes drift1 { to { transform: translate(6vmax, 5vmax) scale(1.08); } }
@keyframes drift2 { to { transform: translate(-7vmax, -4vmax) scale(1.06); } }

/* ---- 主舞台 ---- */
.stage {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  grid-template-areas: "eyebrow eyebrow" "duo others";
  gap: 6px 40px;
  align-content: center;
  padding-top: 26px; padding-bottom: 20px;
}
.stage > .lbl { grid-area: eyebrow; }
/* 區塊標籤：小字、字距寬、前面一顆屬性色的小點 —— 手遊 HUD 的語彙 */
.lbl {
  display: flex; align-items: center; gap: 8px;
  margin: 0 0 6px;
  font-family: var(--font-mono);
  font-size: 11.5px; letter-spacing: .18em;
  color: var(--muted);
}
.lbl::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: var(--hue); box-shadow: 0 0 8px var(--hue);
}
.duo { grid-area: duo; display: grid; grid-template-columns: minmax(240px, 380px) minmax(0, 1fr); gap: 34px; align-items: center; }
.others { grid-area: others; }

.ballWrap {
  display: block;
  border-radius: 50%;
  transition: transform .4s cubic-bezier(.2, .8, .3, 1);
}
@media (hover: hover) { .ballWrap:hover { transform: translateY(-6px) scale(1.02); } }
.ballWrap:focus-visible { outline: 3px solid var(--accent); outline-offset: 8px; }
/* 球慢慢上下浮：靜止的球是商品照，會浮的球是活的 */
@media (prefers-reduced-motion: no-preference) {
  .ballWrap { animation: bob 5.2s ease-in-out infinite alternate; }
}
@keyframes bob { from { translate: 0 -6px; } to { translate: 0 8px; } }

.info { display: grid; gap: 12px; justify-items: start; }
.badges { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.live {
  font-size: 11.5px; letter-spacing: .12em; font-weight: 600;
  padding: 4px 11px; border-radius: var(--pill);
  color: var(--ok); background: var(--ok-wash);
}
h1 {
  font-size: clamp(26px, 3.6vw, 40px);
  line-height: 1.12; letter-spacing: -.02em;
  margin: 0; font-weight: 700;
  text-wrap: balance;
}
.prize { margin: -4px 0 0; font-size: 16px; }
.prize .muted { margin-right: 8px; }
.meter { width: 100%; max-width: 380px; height: 7px; border-radius: var(--pill); background: var(--surface-2); overflow: hidden; }
.fill { height: 100%; border-radius: var(--pill); background: linear-gradient(90deg, var(--accent), var(--accent-soft)); }
.nums { display: flex; align-items: baseline; gap: 16px; }
.price { font-size: 22px; font-weight: 700; letter-spacing: -.02em; }
.per { font-size: 13px; font-weight: 400; }
.rest { font-size: 13px; }
.ctas { display: flex; gap: 12px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
.go { padding: 14px 30px; font-size: 16px; }
/* 主 CTA 呼吸光暈：這是畫面上唯一會呼吸的按鈕，所以它是「主」 */
@media (prefers-reduced-motion: no-preference) {
  .go { animation: breathe 2.6s ease-in-out infinite; }
}
@keyframes breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); }
  50%      { box-shadow: 0 0 0 10px color-mix(in srgb, var(--accent) 0%, transparent); }
}
.sellerRow { margin-top: 2px; }

/* ---- 桌機右欄 ---- */
.others { display: grid; gap: 10px; align-content: start; }
.others .lbl { margin: 0 0 4px; }
.mini {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  border: 1px solid var(--line-soft);
  transition: background .15s, transform .2s;
}
@media (hover: hover) { .mini:hover { background: var(--surface-2); transform: translateX(3px); } }
.mini:active { transform: scale(.98); }
.miniBall { width: 46px; flex: none; }
.miniText { display: grid; gap: 2px; min-width: 0; }
.miniText strong { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.miniText span { font-size: 11.5px; }

/* ---- 動態帶 ---- */
.strip { padding-bottom: 18px; }

/* ---- 骨架 ---- */
.skel { display: grid; grid-template-columns: 300px 1fr; gap: 34px; align-items: center; }
.skBall { aspect-ratio: 1; border-radius: 50%; background: var(--surface-2); }
.skLines { display: grid; gap: 14px; }
.skLines i { display: block; height: 18px; border-radius: 6px; background: var(--surface-2); }
.skLines i:nth-child(1) { width: 40%; } .skLines i:nth-child(2) { width: 75%; } .skLines i:nth-child(3) { width: 55%; }
.empty { text-align: center; padding: 60px 0; }

/* ---- 首次引導 ---- */
.onboard {
  position: fixed; inset: 0; z-index: 70;
  display: grid; place-items: end center;
  padding: 0 14px calc(18px + var(--nav-total));
  background: rgba(5, 4, 10, .55);
  backdrop-filter: blur(6px);
}
.onboardCard {
  width: 100%; max-width: 520px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 18px 18px 16px;
  box-shadow: var(--shadow-lg);
}
.obSlides {
  display: flex; gap: 12px;
  overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none;
  margin: 0 -18px; padding: 0 18px 6px;
}
.obSlides::-webkit-scrollbar { display: none; }
.obSlide {
  flex: 0 0 min(78%, 300px); scroll-snap-align: start;
  display: grid; gap: 6px; align-content: start;
  padding: 14px 16px;
  background: var(--surface-2); border-radius: var(--radius);
}
.obN { font-size: 11px; color: var(--accent); letter-spacing: .16em; }
.obSlide h2 { margin: 0; font-size: 16px; font-weight: 650; }
.obSlide p { margin: 0; font-size: 13px; line-height: 1.55; }
.obActs { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; }
.btn.sm { padding: 8px 16px; font-size: 13.5px; }

/* ---- 手機：單欄、右欄拿掉 ---- */
@media (max-width: 960px) {
  .stage { grid-template-columns: 1fr; grid-template-areas: "eyebrow" "duo"; }
  .others { display: none; }
}
@media (max-width: 720px) {
  .stage { padding-top: 12px; padding-bottom: 8px; gap: 2px; align-content: start; }
  .duo { grid-template-columns: 1fr; gap: 6px; justify-items: center; text-align: center; }
  .ballWrap { width: min(62vw, 250px); }
  .info { justify-items: center; gap: 9px; }
  .badges { justify-content: center; }
  h1 { font-size: 22px; }
  .prize { font-size: 14px; }
  .meter { max-width: 320px; }
  .price { font-size: 19px; }
  .ctas { justify-content: center; width: 100%; }
  .go { flex: 1 1 auto; max-width: 260px; padding: 13px 20px; font-size: 15px; }
  .strip { padding-bottom: 12px; }
  .skel { grid-template-columns: 1fr; justify-items: center; }
  .skBall { width: 200px; }
}
/* 極矮螢幕（iPhone SE 667px）：球再縮一點，仍然要一屏 */
@media (max-width: 720px) and (max-height: 700px) {
  .ballWrap { width: min(50vw, 200px); }
  .info { gap: 6px; }
  .strip { padding-bottom: 8px; }
}
</style>
