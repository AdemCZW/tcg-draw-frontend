<script setup lang="ts">
/**
 * 選池台 —— 左右滑動挑要開哪一池。
 *
 * 跟 /pools 的 grid 是兩種模式並存，不是取代：
 * grid 適合「一眼掃六個」的比較，選池台適合「一次專心看一個」的挑選。
 * 右上的切換鍵可以隨時跳過去。
 */
import { computed, onMounted, ref } from 'vue'
import { usePoolStore } from '@/stores/pools'
import type { Pool, Tier } from '@/types/models'
import PoolCard from '@/components/PoolCard.vue'
import SnapRail from '@/components/SnapRail.vue'
import ShaderSky from '@/components/ShaderSky.vue'
import { track } from '@/lib/ga'

const pools = usePoolStore()
onMounted(() => {
  pools.ensureLoaded()
  track('view_play')
})

/** 開放中的排前面；完抽的仍然看得到，但排到後面去 */
const list = computed<Pool[]>(() => [
  ...pools.pools.filter(p => p.status === 'open'),
  ...pools.pools.filter(p => p.status !== 'open')
])

const describe = (p: Pool) => `${p.title}，${p.ticketPrice} 點一抽，剩 ${p.remainingTickets} 抽`

/* ---- 背景跟著當前這一池變色 ----
   這一頁的核心是「一次專心看一池」，所以整個環境應該對「你現在看的是哪一池」
   有反應。滑到大師球的池，背景就轉紫；滑到豪華球，轉金。
   這比在卡片上加閃光有意義得多 —— 它讓滑動這個動作本身有回饋。 */
const RANK: Record<Tier, number> = { BUST: 0, D: 1, C: 2, B: 3, A: 4, LAST: 5 }
const TIER_HUE: Record<Tier, string> = {
  D: '#ef4040', C: '#3f7fd8', B: '#f5c400', A: '#d8b25a', LAST: '#8b4fd0', BUST: '#ef4040'
}
const topLiveTier = (p: Pool): Tier =>
  p.prizes.filter(x => x.remaining > 0)
    .reduce<Tier>((best, x) => (RANK[x.tier] > RANK[best] ? x.tier : best), 'D')

const activeIndex = ref(0)
const activePool = computed(() => list.value[activeIndex.value])
const activeTier = computed(() => (activePool.value ? topLiveTier(activePool.value) : 'D'))
const hue = computed(() => TIER_HUE[activeTier.value])
const tint = computed<[number, number, number]>(() => {
  const h = hue.value.replace('#', '')
  const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
  return [Math.min(1, v(0) * 1.15), Math.min(1, v(2) * 1.15), Math.min(1, v(4) * 1.15)]
})
const sky3d = ref(!new URLSearchParams(location.search).has('nogl'))
</script>

<template>
  <div class="page" :style="{ '--hue': hue }">
    <!-- 環境層：跟著當前這一池換色。放在最底、上下都淡出 -->
    <div class="env" aria-hidden="true">
      <ShaderSky
        v-if="sky3d"
        class="envGl"
        :energy="0.42"
        :tint="tint"
        :gain="0.6"
        :core-y="0.42"
        @fail="sky3d = false"
      />
      <div v-else class="envCss"></div>
    </div>

    <header class="head container">
      <div>
        <h1>挑一池來開</h1>
        <p class="muted sub">左右滑動選擇</p>
      </div>
      <RouterLink :to="{ name: 'home' }" class="toggle">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5h6v6H4zM14 5h6v6h-6zM4 13h6v6H4zM14 13h6v6h-6z" />
        </svg>
        清單
      </RouterLink>
    </header>

    <!-- 載入中放骨架卡而不是一行「載入中…」：
         空的軌道看起來像壞掉，骨架至少交代了「這裡等一下會有卡片」 -->
    <div v-if="pools.loading && !list.length" class="skeleton" aria-hidden="true">
      <div v-for="i in 3" :key="i" class="sk"></div>
    </div>

    <SnapRail
      v-else-if="list.length"
      :items="list"
      label="抽選池"
      :describe="describe"
      @change="i => (activeIndex = i)"
      v-slot="{ item, active }"
    >
      <!-- 置中那一張加一圈跟球階同色的光暈：讓「現在選的是這張」有實體感 -->
      <div class="slot" :class="{ on: active }">
        <PoolCard :pool="item" variant="stage" />
      </div>
    </SnapRail>

    <p v-else class="container empty muted">目前沒有進行中的抽選池。</p>

    <p v-if="list.length" class="container tail muted">
      共 {{ list.length }} 池 ·
      <RouterLink :to="{ name: 'home' }">回大廳看全部</RouterLink>
    </p>
  </div>
</template>

<style scoped>
/* 底部導覽是 fixed，不讓位的話頁尾會被壓在它後面。
   --nav-total 在桌機是 0，不必再包斷點 */
.page {
  position: relative; isolation: isolate;
  padding-top: 26px; padding-bottom: calc(40px + var(--nav-total));
  min-height: calc(100dvh - 56px - var(--nav-total));
}

/* ---- 環境層 ---- */
.env {
  position: absolute; inset: 0 0 auto; height: 86%;
  z-index: -1; pointer-events: none;
  -webkit-mask-image: linear-gradient(180deg, transparent, #000 18% 62%, transparent);
  mask-image: linear-gradient(180deg, transparent, #000 18% 62%, transparent);
}
.envGl { position: absolute; inset: 0; }
/* 沒有 WebGL 時的替代：單純一團跟著換色的光 */
.envCss {
  position: absolute; left: 50%; top: 42%;
  width: 120vmax; height: 90vmax; translate: -50% -50%;
  background: radial-gradient(circle closest-side, var(--hue), transparent 62%);
  opacity: .22; filter: blur(70px);
}

/* 置中卡的光暈。用 filter 而不是 box-shadow ——
   卡片是圓角矩形，box-shadow 會沿著矩形邊框走，看起來像加了外框；
   drop-shadow 吃的是元素的實際輪廓，光才會貼著卡片本身。 */
/* 置中卡的光暈。
   刻意不加 transition：filter 的值裡有 var(--hue)（未註冊的自訂屬性），
   而 --hue 變動時不會觸發過渡 —— 實測 getAnimations() 回傳空陣列，
   過渡根本沒開始，光暈就卡在基底值永遠不出現。
   真要淡入得先用 @property 把 --hue 註冊成可動畫型別，但它在多處被使用，
   為了一個 0.35 秒的淡入不值得。滑動輪播本來就該是即時的手感。

   用 filter 不用 box-shadow：卡片是圓角矩形，box-shadow 會沿著矩形邊框走，
   看起來像加了外框；drop-shadow 吃的是元素實際輪廓，光才會貼著卡片。 */
.slot.on {
  filter:
    drop-shadow(0 0 18px color-mix(in srgb, var(--hue) 60%, transparent))
    drop-shadow(0 14px 34px rgba(0, 0, 0, .55));
}

.head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px; margin-bottom: 14px;
}
h1 { font-size: 24px; margin: 0; letter-spacing: -.02em; }
.sub { font-size: 13.5px; margin: 5px 0 0; }

.toggle {
  flex: none;
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 13.5px; font-weight: 500;
  padding: 8px 15px;
  border-radius: var(--pill);
  background: var(--surface-2);
  color: var(--ink);
  transition: background .15s;
}
.toggle svg {
  width: 15px; height: 15px;
  fill: none; stroke: currentColor; stroke-width: 1.7;
  stroke-linecap: round; stroke-linejoin: round;
}
@media (hover: hover) { .toggle:hover { background: var(--surface-3); } }
.toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

/* 骨架：跟 SnapRail 的節奏對齊，載入完不會有明顯的版面跳動 */
.skeleton {
  display: flex; gap: 12px;
  padding-inline: max(var(--pad), calc((100% - min(72vw, 320px)) / 2));
  overflow: hidden;
}
.sk {
  flex: 0 0 min(72vw, 320px);
  height: 420px;
  border-radius: var(--radius-lg);
  background: linear-gradient(100deg,
    var(--surface) 30%, var(--surface-2) 48%, var(--surface) 66%);
  background-size: 280% 100%;
}
@media (prefers-reduced-motion: no-preference) {
  .sk { animation: sheen 1.5s linear infinite; }
}
@keyframes sheen {
  from { background-position: 140% 0; }
  to   { background-position: -40% 0; }
}

.empty { padding: 60px 0; text-align: center; }
.tail { margin-top: 18px; text-align: center; font-size: 13px; }
.tail a { color: var(--accent); }

@media (max-width: 720px) {
  .page { padding-top: 12px; padding-bottom: calc(20px + var(--nav-total)); }
  h1 { font-size: 20px; }
  .sub { font-size: 12.5px; }
  .toggle { font-size: 12.5px; padding: 7px 13px; }
  .sk { height: 360px; }
  .head { margin-bottom: 10px; }
  .sub { margin-top: 3px; }
  .tail { margin-top: 12px; }
}
</style>
