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
import { useSellerStore } from '@/stores/sellers'
import type { Pool, Tier } from '@/types/models'
import PoolCard from '@/components/PoolCard.vue'
import SnapRail from '@/components/SnapRail.vue'
import ShaderSky from '@/components/ShaderSky.vue'
import SellerChip from '@/components/SellerChip.vue'
import PoolModeBadge from '@/components/PoolModeBadge.vue'
import PoolOriginBadge from '@/components/PoolOriginBadge.vue'
import { track } from '@/lib/ga'

const pools = usePoolStore()
const sellers = useSellerStore()
onMounted(() => {
  pools.ensureLoaded()
  // 桌機的資訊面板要秀賣家；手機沒有面板，但這支是快取過的，重複呼叫不花錢
  sellers.ensureLoaded()
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

/* 每次換池 +1，用來重播「切換脈衝」。
   一次性動畫要重播就得讓元素重新掛載 —— 同一個節點上重設 animation
   不會重跑，這是 CSS 動畫的規則。 */
const switchKey = ref(0)
function onChange(i: number) {
  activeIndex.value = i
  switchKey.value++
}

/* ---- 桌機資訊面板 ----
   寬螢幕上中央那張卡只吃掉一半的寬度，剩下的以前是空的。卡片下緣塞得下的
   只有標題、單價、剩幾抽 —— 「這一池到底放了什麼」得點進去才知道。
   面板把那些攤開來講：賞別分佈、最高賞還在不在、賣家是誰、還元率。
   挑池的判斷本來就需要這些，把它們搬到選池台等於少一次來回。 */
const activeSeller = computed(() =>
  activePool.value ? sellers.byId(activePool.value.sellerId) : undefined)

/** 還沒出的最高賞。這是挑池時最先被問的一件事 */
const topLive = computed(() => {
  const p = activePool.value
  if (!p) return undefined
  return p.prizes.filter(x => x.remaining > 0)
    .reduce<Pool['prizes'][number] | undefined>(
      (best, x) => (!best || RANK[x.tier] > RANK[best.tier] ? x : best), undefined)
})

/* 賞別分佈：同一個賞別可能有好幾筆獎品，先加總再排序。
   由高到低排 —— 使用者掃這一欄是在找「大獎還剩幾隻」，不是在讀清單。 */
const TIER_ORDER: Tier[] = ['LAST', 'A', 'B', 'C', 'D', 'BUST']
const TIER_LABEL: Record<Tier, string> = {
  LAST: '最後賞', A: 'A 賞', B: 'B 賞', C: 'C 賞', D: 'D 賞', BUST: '爆賞'
}
const tierRows = computed(() => {
  const p = activePool.value
  if (!p) return []
  const sum = new Map<Tier, { total: number; remaining: number }>()
  for (const x of p.prizes) {
    const cur = sum.get(x.tier) ?? { total: 0, remaining: 0 }
    cur.total += x.total
    cur.remaining += x.remaining
    sum.set(x.tier, cur)
  }
  return TIER_ORDER.filter(t => sum.has(t)).map(t => ({ tier: t, ...sum.get(t)! }))
})

const pct = computed(() => {
  const p = activePool.value
  return p ? Math.round((p.remainingTickets / p.totalTickets) * 100) : 0
})
</script>

<template>
  <div class="page" :style="{ '--hue': hue }">
    <!-- 環境層：跟著當前這一池換色。放在最底、上下都淡出 -->
    <div class="env" aria-hidden="true">
      <ShaderSky
        v-if="sky3d"
        class="envGl"
        :energy="0.62"
        :tint="tint"
        :gain="1.05"
        :core-y="0.42"
        @fail="sky3d = false"
      />
      <div v-else class="envCss"></div>
    </div>

    <header class="head container">
      <div>
        <h1>挑一池來開</h1>
        <!-- 兩句提示用 CSS 切換而不是 matchMedia：這是純樣式的差異，
             拿 JS 判斷會在 SSR／初次繪製時先閃錯的那一句 -->
        <p class="muted sub">
          <span class="onTouch">左右滑動選擇</span>
          <span class="onMouse">方向鍵或兩側箭頭切換</span>
        </p>
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

    <!-- 桌機是「軌道 + 資訊面板」兩欄。面板的顯示與否交給 CSS 斷點而不是
         JS：這是純樣式的分歧，用 matchMedia 判斷會在視窗跨過斷點時多一次
         掛載／卸載，中央卡的捲動位置也跟著被重算。 -->
    <div v-else-if="list.length" class="stage">
      <SnapRail
        :items="list"
        label="抽選池"
        :describe="describe"
        @change="onChange"
        v-slot="{ item, active }"
      >
        <!-- 置中那一張加一圈跟球階同色的光暈：讓「現在選的是這張」有實體感 -->
        <div class="slot" :class="{ on: active }">
          <PoolCard :pool="item" variant="stage" />
          <!-- 切換脈衝：只掛在置中那張，key 變動才會重播 -->
          <span v-if="active" :key="switchKey" class="pulse" aria-hidden="true"></span>
        </div>
      </SnapRail>

      <!-- key 綁 switchKey 讓面板整塊重掛載：換池時內容全變，用 transition
           一項一項補間會看到數字亂跳，整塊淡入反而乾淨。
           面板是卡片的展開說明，讀屏已經有軌道那份 live region，這裡不再播報。 -->
      <aside v-if="activePool" :key="switchKey" class="panel">
        <div class="tags">
          <PoolModeBadge :mode="activePool.mode" />
          <PoolOriginBadge :origin="activePool.origin" />
        </div>

        <h2>{{ activePool.title }}</h2>
        <SellerChip v-if="activeSeller" :seller="activeSeller" />

        <p v-if="topLive" class="topLive">
          <span class="lbl mono">最高賞未出</span>
          <strong>{{ topLive.tier === 'LAST' ? '最後賞' : topLive.tier + ' 賞' }} · {{ topLive.card.name }}</strong>
        </p>
        <p v-else class="topLive gone">
          <span class="lbl mono">高賞已出完</span>
        </p>

        <!-- 賞別分佈。條的長度是「還剩多少比例」，不是絕對數量 ——
             各賞別的總數差一個數量級，照絕對值畫的話 D 賞會把其他全部壓扁。 -->
        <ul class="tiers">
          <li v-for="row in tierRows" :key="row.tier" :class="`t-${row.tier.toLowerCase()}`">
            <span class="tname">{{ TIER_LABEL[row.tier] }}</span>
            <span class="tbar"><i :style="{ width: (row.remaining / row.total * 100) + '%' }"></i></span>
            <span class="tnum mono">{{ row.remaining }}<span class="of">/{{ row.total }}</span></span>
          </li>
        </ul>

        <div class="progress">
          <div class="meter" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100" :aria-label="`剩餘 ${pct}%`">
            <div class="fill" :style="{ width: pct + '%' }"></div>
          </div>
          <p class="pline">
            <span class="mono">剩 {{ activePool.remainingTickets }} / {{ activePool.totalTickets }} 抽</span>
            <!-- 保底回饋率＝Σ(賣家宣告的買回價) ÷ 票收，也就是「你最少拿得回多少」。
                 舊池沒有這個數字（賣家沒有宣告過買回價），那就什麼都不顯示 ——
                 拿舊制的還元率頂替會讓兩個意義不同的數字看起來是同一個。 -->
            <span v-if="activePool.floorRatio != null" class="muted">保底回饋 {{ activePool.floorRatio }}%</span>
          </p>
        </div>

        <!-- 選池台以前沒有任何行動點，唯一的出口是「點卡片」——
             那是可以點的，但畫面上看不出來。把單價跟入口併成一顆按鈕講明白。
             完抽的池不掛強調色：那顆橘鈕的意思是「可以買」，
             對著一池 0 抽還喊價等於騙人進去撞牆。 -->
        <RouterLink
          :to="{ name: 'pool', params: { id: activePool.id } }"
          class="cta" :class="{ done: activePool.status !== 'open' }"
        >
          <template v-if="activePool.status === 'open'">
            <span class="ctaPrice">{{ activePool.ticketPrice.toLocaleString() }} 點<span class="per"> / 抽</span></span>
            <span class="ctaGo">進入這一池</span>
          </template>
          <template v-else>
            <span class="ctaPrice">已完抽</span>
            <span class="ctaGo">看抽選結果</span>
          </template>
        </RouterLink>
      </aside>
    </div>

    <!-- 錯誤排在空狀態前面：斷網時 list 是空的，沒有這一層會直接掉進
         「目前沒有進行中的抽選池」——錯誤被畫成空，使用者不會想到重試。 -->
    <div v-else-if="pools.error" class="container loadFail" role="alert">
      <p class="muted">{{ pools.error }}</p>
      <button type="button" class="btn" @click="pools.load()">重新載入</button>
    </div>

    <p v-else class="container empty muted">目前沒有進行中的抽選池。</p>
  </div>
</template>

<style scoped>
/* 底部導覽的讓位由頁尾負責（見 App.vue）—— 頁尾就接在這一頁下面，
   這裡再留一次是留給沒有東西的空白。

   原本還有一條 min-height: calc(100dvh - 56px - --nav-total)：它把這一頁
   撐滿整個視窗，於是頁尾整段被推到視窗外，下緣就多出「一頁高的黑 + 頁尾」
   可以捲。撐滿視窗買到的只有環境光鋪得比較開，賠掉的是每次滑到底都要
   經過一段沒有內容的黑 —— 拿掉之後環境光跟著內容高度走。 */
.page {
  position: relative; isolation: isolate;
  padding-top: 26px; padding-bottom: 40px;
}

/* ---- 環境層 ---- */
.env {
  position: absolute; inset: 0 0 auto; height: 86%;
  z-index: -1; pointer-events: none;
  /* 裡面那團光是 90vmax 見方的，頁面短的時候（例如「目前沒有進行中的抽選池」）
     它會凸出這一層底下 —— 遮罩只管畫不管版面，凸出去的部分照樣算進文件高度，
     整頁下緣就會多出一段捲得到、卻什麼都沒有的空間。clip 讓它只影響畫面不影響高度。 */
  overflow: clip;
  -webkit-mask-image: linear-gradient(180deg, transparent, #000 18% 62%, transparent);
  mask-image: linear-gradient(180deg, transparent, #000 18% 62%, transparent);
}
.envGl { position: absolute; inset: 0; }
/* 沒有 WebGL 時的替代：單純一團跟著換色的光 */
.envCss {
  position: absolute; left: 50%; top: 42%;
  width: 120vmax; height: 90vmax; translate: -50% -50%;
  background: radial-gradient(circle closest-side, var(--hue), transparent 62%);
  opacity: .4; filter: blur(70px);
}

/* 置中卡的光暈。用 filter 而不是 box-shadow ——
   卡片是圓角矩形，box-shadow 會沿著矩形邊框走，看起來像加了外框；
   drop-shadow 吃的是元素的實際輪廓，光才會貼著卡片本身。 */
/* --hue 現在是註冊過的 <color>（見 styles/fx.css），可以被內插了，
   所以換池時整頁的顏色是滑過去的，不是硬跳。 */
.page { transition: --hue .5s ease; }

/* 置中卡的光暈。
   用 filter 不用 box-shadow：卡片是圓角矩形，box-shadow 會沿著矩形邊框走，
   看起來像加了外框；drop-shadow 吃的是元素實際輪廓，光才會貼著卡片。 */
.slot { position: relative; }
.slot.on {
  filter:
    drop-shadow(0 0 26px color-mix(in srgb, var(--hue) 85%, transparent))
    drop-shadow(0 0 60px color-mix(in srgb, var(--hue) 45%, transparent))
    drop-shadow(0 16px 38px rgba(0, 0, 0, .6));
}

/* 切換脈衝：一圈跟球階同色的環從卡片邊緣擴散出去。
   只有一次、340ms —— 換池是頻繁動作，長一點就會拖沓。 */
.pulse {
  position: absolute; inset: -2px;
  border-radius: var(--radius-lg);
  border: 2px solid var(--hue);
  pointer-events: none;
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .pulse { animation: switchPulse .34s cubic-bezier(.2, .8, .3, 1) forwards; }
}
@keyframes switchPulse {
  0%   { transform: scale(.97); opacity: .9; }
  100% { transform: scale(1.06); opacity: 0; }
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

/* 載入失敗：跟空狀態同一個位置，但多一顆重試鈕 */
.loadFail {
  min-width: 0;
  display: grid; justify-items: center; gap: 12px;
  padding: 60px 0; text-align: center;
}
.loadFail p { margin: 0; }

/* 提示句預設是觸控版；有滑鼠才換成鍵盤／箭頭那句 */
.onMouse { display: none; }
@media (hover: hover) and (pointer: fine) {
  .onTouch { display: none; }
  .onMouse { display: inline; }
}

/* ---- 桌機兩欄舞台 ----
   原本整條軌道獨佔全寬，1280 以上會排到三張半卡片：多出來的兩張是同一個
   元件的暗掉複本，佔了空間卻沒有新資訊。改成軌道只留「中央卡 + 兩側各露一半」，
   省下來的寬度交給面板 —— 同樣的像素，從「重複的縮圖」換成「這一池的細節」。

   斷點壓在 1120：再窄一點的話兩欄各自都不夠寬（軌道 <700 會退回較大的卡寬，
   面板也塞不下賞別分佈），不如維持單欄。 */
.stage { min-width: 0; }
@media (min-width: 1120px) {
  .stage {
    max-width: var(--maxw); margin-inline: auto; padding-inline: var(--pad);
    display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 320px);
    gap: 28px; align-items: center;
  }
}

/* 超寬螢幕再放寬一階。站上其他頁面都停在 --maxw(1180)，但那是「一欄一欄
   讀下去」的頁；選池台是舞台，1600 上照 1180 收邊會在左右各留 210px 的黑，
   而那正是這次要處理的問題。放寬之後軌道拿到多的寬度，兩側鄰居露得更完整。 */
@media (min-width: 1440px) {
  .stage {
    max-width: 1400px;
    grid-template-columns: minmax(0, 1fr) minmax(0, 360px);
    gap: 32px;
  }
}

/* ---- 資訊面板 ---- */
.panel { display: none; }
@media (min-width: 1120px) {
  .panel {
    display: grid; align-content: start; gap: 13px;
    min-width: 0;
    padding: 20px;
    border-radius: var(--radius);
    border: 1px solid var(--line);
    /* 半透明底而不是實色：面板浮在會換色的環境光上面，實色會像貼了一塊補丁 */
    background: color-mix(in srgb, var(--surface) 82%, transparent);
    backdrop-filter: blur(14px);
    /* 上緣一道跟當前球階同色的光，把面板跟中央卡綁成同一組 */
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, var(--hue) 45%, transparent),
      var(--shadow);
  }
}
@media (min-width: 1120px) and (prefers-reduced-motion: no-preference) {
  /* 換池時整塊淡入。位移只有 6px —— 面板不是主角，動作太大會搶走中央卡的注意力 */
  .panel { animation: panelIn .26s cubic-bezier(.2, .8, .3, 1) both; }
}
@keyframes panelIn {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}

.tags { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.panel h2 {
  margin: 0; font-size: 19px; line-height: 1.25; letter-spacing: -.02em;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}

.topLive { margin: 0; display: grid; gap: 3px; min-width: 0; }
.topLive .lbl { font-size: 10.5px; letter-spacing: .14em; color: var(--ok); }
.topLive.gone .lbl { color: var(--faint); }
.topLive strong {
  font-size: 14px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.tiers {
  list-style: none; margin: 0; padding: 11px 0 0;
  border-top: 1px solid var(--line-soft);
  display: grid; gap: 7px;
}
.tiers li {
  display: grid; grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center; gap: 9px;
  font-size: 12px;
}
/* 賞別色只宣告一次，名稱吃它當文字色、長條吃它當底色。
   直接針對每個賞別各寫兩條規則的話，色票分散在八個地方，改一個賞別的顏色
   就要記得兩處一起改。
   預設值放在 .tiers 而不是 .tiers li：後者特異度 (0,1,1) 會贏過 li 自己的
   .t-last (0,1,0)，每一列都會退回 D 賞的灰；靠繼承下來的值才蓋得掉。 */
.tiers { --tc: var(--tier-d); }
.t-last { --tc: var(--tier-last); }
.t-a { --tc: var(--tier-a); }
.t-b { --tc: var(--tier-b); }
.t-c { --tc: var(--tier-c); }
.tname { color: var(--tc); white-space: nowrap; }
.tbar { height: 4px; border-radius: var(--pill); background: var(--surface-3); overflow: hidden; }
.tbar i { display: block; height: 100%; border-radius: var(--pill); background: var(--tc); }
.tnum { font-size: 11.5px; font-variant-numeric: tabular-nums; }
.tnum .of { color: var(--faint); }

.progress { display: grid; gap: 6px; padding-top: 11px; border-top: 1px solid var(--line-soft); }
.meter { height: 5px; border-radius: var(--pill); background: var(--surface-3); overflow: hidden; }
.fill { height: 100%; border-radius: var(--pill); background: linear-gradient(90deg, var(--accent), var(--accent-soft)); }
.pline { margin: 0; display: flex; justify-content: space-between; gap: 10px; font-size: 11.5px; }

.cta {
  margin-top: 2px;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 11px 16px;
  border-radius: var(--pill);
  background: var(--accent); color: var(--on-accent);
  transition: background .15s;
}
.ctaPrice { font-size: 17px; font-weight: 800; letter-spacing: -.01em; }
.ctaPrice .per { font-size: 11.5px; font-weight: 400; opacity: .8; }
.ctaGo { font-size: 13px; font-weight: 600; white-space: nowrap; }
@media (hover: hover) { .cta:hover { background: var(--accent-soft); } }
.cta:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.cta.done { background: var(--surface-3); color: var(--muted); }
.cta.done .ctaPrice { font-size: 15px; font-weight: 700; }
@media (hover: hover) { .cta.done:hover { background: var(--line); } }

@media (max-width: 720px) {
  .page { padding-top: 12px; padding-bottom: 20px; }
  h1 { font-size: 20px; }
  .sub { font-size: 12.5px; }
  .toggle { font-size: 12.5px; padding: 7px 13px; }
  .sk { height: 360px; }
  .head { margin-bottom: 10px; }
  .sub { margin-top: 3px; }
}
</style>
