<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Pool } from '@/types/models'
import CardArt from './CardArt.vue'
import PoolModeBadge from './PoolModeBadge.vue'
import PoolOriginBadge from './PoolOriginBadge.vue'
import { isDrawable, isUpcoming } from '@/lib/pool-status'

const props = withDefaults(defineProps<{
  pool: Pool
  /** grid = 清單裡的一格；stage = 選池台上的主角，字級放大、資訊更好讀 */
  /* grid  直式卡，格線用
     stage 選池台的大卡
     wide  橫式卡，橫向捲動列用 —— 形狀跟格線不同才有節奏變化 */
  variant?: 'grid' | 'stage' | 'wide'
}>(), { variant: 'grid' })

const pct = computed(() => Math.round((props.pool.remainingTickets / props.pool.totalTickets) * 100))

/* 角標的字。以前是「不是 open 就印『完抽』」，於是剛開好、100 籤全在的池
   會同時印著「完抽」跟「剩 100/100」—— 一張卡上兩句互相打架的話。
   三種非開放狀態要用三個不同的字（見 lib/pool-status.ts）：
     committed 即將開賣   還不能抽，但東西都還在
     sold_out  完抽       抽完了，種子還沒公開
     revealed  開獎       種子公開了，可以驗算
   角標只放最短的那一版：這是一個蓋在卡圖上的小標，不是句子。 */
const TAG: Record<string, string> = { committed: '即將開賣', sold_out: '完抽', revealed: '開獎' }
const tag = computed(() => (isDrawable(props.pool) ? '' : TAG[props.pool.status] ?? ''))
const soon = computed(() => isUpcoming(props.pool))
const topPrize = computed(() => props.pool.prizes.find(p => p.tier === 'A') ?? props.pool.prizes.find(p => p.tier === 'LAST'))
const aLive = computed(() => (topPrize.value?.remaining ?? 0) > 0)

// 卡面隨游標傾斜 —— 3D 效果的主要載體
const art = ref<HTMLElement | null>(null)
const tilt = ref({ x: 0, y: 0, gx: 50, gy: 50 })
let raf = 0

function onMove(e: PointerEvent) {
  const el = art.value
  if (!el) return
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => {
    const r = el.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width
    const py = (e.clientY - r.top) / r.height
    tilt.value = {
      y: (px - 0.5) * 18,
      x: -(py - 0.5) * 18,
      gx: px * 100,
      gy: py * 100
    }
  })
}
function onLeave() {
  cancelAnimationFrame(raf)
  tilt.value = { x: 0, y: 0, gx: 50, gy: 50 }
}
</script>

<template>
  <RouterLink
    :to="{ name: 'pool', params: { id: pool.id } }"
    class="pool"
    :class="variant"
    @pointermove="onMove"
    @pointerleave="onLeave"
  >
    <!-- 卡圖鋪滿整格，資訊壓在圖上（跟市場同一套語彙）。
         去掉外框與內距之後，同樣的格子寬度下卡片大了一圈。 -->
    <div
      ref="art"
      class="art-tilt"
      :style="{
        transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
        /* 共享元素轉場：跟池詳情總覽頁的封面同名，換頁時封面會從卡片位置
           滑到詳情頁位置。名稱要唯一，所以帶 pool.id */
        viewTransitionName: `pool-cover-${pool.id}`
      }"
    >
      <CardArt
        class="art"
        :image="pool.cover" :alt="topPrize?.card.name ?? pool.title" :tier="topPrize?.tier" :art-id="topPrize?.card.artId"
      />
      <span
        class="glare"
        :style="{ background: `radial-gradient(60% 60% at ${tilt.gx}% ${tilt.gy}%, rgba(255,255,255,.42), transparent 70%)` }"
        aria-hidden="true"
      ></span>
    </div>

    <span class="scrim" aria-hidden="true"></span>

    <div class="mode-tag"><PoolModeBadge :mode="pool.mode" /></div>
    <div class="origin-tag"><PoolOriginBadge :origin="pool.origin" /></div>
    <span v-if="tag" class="doneTag" :class="{ soon }">{{ tag }}</span>

    <div class="body">
      <h3>{{ pool.title }}</h3>
      <p class="top" v-if="topPrize">
        <span class="prize">{{ topPrize.tier === 'LAST' ? '最後賞' : 'A 賞' }} · {{ topPrize.card.name }}</span>
        <span class="state" :class="aLive ? 'live' : 'gone'">{{ aLive ? '未出' : '已出' }}</span>
      </p>
      <div class="meter" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100" :aria-label="`剩餘 ${pct}%`">
        <div class="fill" :style="{ width: pct + '%' }"></div>
      </div>
      <div class="foot">
        <strong class="price">{{ pool.ticketPrice.toLocaleString() }} 點 <span class="per">/ 抽</span></strong>
        <span class="rest mono">剩 {{ pool.remainingTickets }}/{{ pool.totalTickets }}</span>
      </div>
    </div>
  </RouterLink>
</template>

<style scoped>
/* 一格 = 一張卡。沒有外框、沒有內距，卡圖就是整格。 */
.pool {
  position: relative;
  display: block;
  aspect-ratio: 5 / 7;
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--surface-2);
  isolation: isolate;
  perspective: 900px;
  transition: transform .28s cubic-bezier(.2, .7, .3, 1), box-shadow .28s;
}
@media (hover: hover) {
  .pool:hover { transform: translateY(-6px); box-shadow: var(--shadow-lg); }
}
.pool:active { transform: scale(.985); transition-duration: 70ms; }
.pool:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

.art-tilt {
  position: absolute; inset: 0;
  transform-style: preserve-3d;
  transition: transform .35s cubic-bezier(.2, .7, .3, 1);
}
.art { width: 100%; height: 100%; }
.art :deep(img), .art :deep(.art-img) { width: 100%; height: 100%; object-fit: cover; }
.glare {
  position: absolute; inset: 0;
  pointer-events: none;
  mix-blend-mode: soft-light;
  opacity: 0; transition: opacity .3s;
}
@media (hover: hover) { .pool:hover .glare { opacity: 1; } }

/* 左到右 + 由下往上的雙層遮罩，把文字區壓暗到足以承載白字 */
.scrim {
  position: absolute; inset: 0;
  pointer-events: none;
  /* 底部那一段要夠深：卡圖本身有招式名與傷害數字，遮罩不夠會跟白字打架。
     下緣 .96 一路撐到 16% 才開始收，剛好蓋住資訊區的高度。 */
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

.mode-tag { position: absolute; top: 10px; left: 10px; z-index: 2; }
.origin-tag { position: absolute; top: 10px; right: 10px; z-index: 2; }
.doneTag {
  position: absolute; bottom: auto; top: 44px; right: 10px; z-index: 2;
  font-size: 11px; font-weight: 700;
  padding: 4px 10px; border-radius: var(--pill);
  background: rgba(8, 6, 14, .8); color: #fff;
}
/* 「即將開賣」跟另外兩個角標的意思相反 —— 那兩個是「結束了」，
   這個是「還沒開始，等一下再來」。同一顆黑底灰標會讓它讀起來也像結束，
   所以換警示色底：它跟強調色（可以買）與中性黑（結束）都不一樣。 */
.doneTag.soon { background: var(--warn); color: #17130a; }

.body {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
  padding: 12px 12px 13px;
  /* 明寫 minmax(0, 1fr)。不寫的話隱含的欄是 auto，而 auto 的上界是
     max-content —— h3 是 -webkit-box + line-clamp，它的 max-content 是
     整串不換行的標題，於是整個軌道被撐寬。實測 320px 上 .body clientW 135
     / scrollW 147，卡片本身 overflow: hidden，底下那排價格與「剩 n/N」
     右邊 12px 就被切掉。minmax(0, …) 把上界壓回容器寬度。 */
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px;
  color: #fff;
}
/* 池標題是這張卡上最該先被讀到的東西，字級要壓過價格。
   行高收到 1.22：字放大之後如果行高不跟著收，兩行標題會多吃掉一截卡圖。 */
h3 {
  margin: 0; font-size: 18px; font-weight: 700; line-height: 1.22;
  letter-spacing: -.01em;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  text-shadow: 0 1px 7px rgba(0, 0, 0, .8);
}
.top { display: flex; align-items: baseline; gap: 6px; font-size: 12px; margin: 0; min-width: 0; }
.prize { opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.state { flex: none; font-weight: 700; font-size: 11px; }
.state.live { color: #5ce08a; }
.state.gone { opacity: .5; }

.meter { height: 4px; border-radius: var(--pill); background: rgba(255, 255, 255, .22); overflow: hidden; }
.fill { height: 100%; border-radius: var(--pill); background: linear-gradient(90deg, var(--accent), var(--accent-soft)); }

/* 允許換行。價格與「剩 n/N」兩邊都是 white-space: nowrap（價格見下面
   720px 區塊的說明），兩個都不肯縮的東西擺在同一條 flex 上，塞不下時就是
   直接溢出：實測 320px 的兩欄格線下 .foot clientW 117 / scrollW 138，
   .pool 是 overflow: hidden，「剩 37/80」的右邊 21px 被切掉。
   換行之後擠不下的那一項自己掉到第二行，資訊完整。 */
.foot { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 8px; }
.price { font-size: 17px; font-weight: 700; letter-spacing: -.01em; text-shadow: 0 2px 8px rgba(0, 0, 0, .7); }
.per { font-size: 11px; font-weight: 400; opacity: .7; }
.rest { font-size: 11px; opacity: .68; white-space: nowrap; }

/* ---- wide：橫式卡 ----
   卡圖靠左佔約四成，資訊在右邊的實底上。跟直式卡的「資訊壓在圖上」不同 ——
   橫式卡的高度矮，壓在圖上會把卡圖整個蓋掉，不如讓兩者並排。 */
.pool.wide {
  aspect-ratio: auto;
  height: 132px;
  display: grid; grid-template-columns: 96px minmax(0, 1fr);
  background: var(--surface);
  border: 1px solid var(--line-soft);
}
.pool.wide .art-tilt { position: relative; inset: auto; }
.pool.wide .scrim {
  /* 只在卡圖那一欄的右緣做一小段過渡，接到右邊的實底 */
  right: auto; width: 96px;
  background: linear-gradient(90deg, transparent 60%, var(--surface));
}
.pool.wide .mode-tag { top: 8px; left: 8px; transform: scale(.8); transform-origin: top left; }
.pool.wide .origin-tag { top: 8px; right: 8px; transform: scale(.8); transform-origin: top right; }
.pool.wide .doneTag { top: 36px; right: 8px; }
.pool.wide .body {
  position: relative; inset: auto;
  padding: 12px 14px; gap: 5px;
  align-content: center;
  color: var(--ink);
}
.pool.wide h3 { font-size: 16px; -webkit-line-clamp: 1; text-shadow: none; }
.pool.wide .top { font-size: 11.5px; }
.pool.wide .prize { color: var(--muted); }
.pool.wide .meter { background: var(--surface-3); }
.pool.wide .price { font-size: 16px; text-shadow: none; }
.pool.wide .per, .pool.wide .rest { color: var(--muted); opacity: 1; }

/* ---- stage：選池台的大卡 ----

   跟 grid／wide 最大的不同：**文字不壓在卡圖上**。

   grid 那一格只有 150px 寬，圖本來就是縮圖、看的是「哪一池」，資訊疊上去
   划算。選池台不是 —— 這一頁的整個賣點就是「一次專心看一張卡」，
   結果那張卡是畫面上最看不清的東西：原本的雙層遮罩（左到右 .95 起跳、
   由下往上 .96 起跳）加上 24px 兩行標題的資訊區，實測 283×396 的卡面上
   有 85.8% 的像素被壓暗超過 60 階，跟「沒有遮罩」的版本相比平均差 121 階。
   奇樹 SAR 只看得到輪廓。

   所以 stage 把卡圖跟資訊拆成上下兩塊：圖是完整的圖，字在圖下面的實底上。
   代價是卡片變高（5:7 之外多一段說明），換到的是卡圖 100% 可見，
   而且字放在實底上不必再靠 text-shadow 去對抗底圖，反而更好讀。
   整塊仍然是同一個 RouterLink，點哪裡都會進池，觸控目標比以前更大。 */
.pool.stage {
  border-radius: var(--radius-lg);
  /* 高度改由「圖的 5:7 + 說明區」決定，不再是整張卡 5:7 */
  aspect-ratio: auto;
  background: var(--surface);
  /* 明寫 minmax(0, 1fr)：隱含的 auto 欄上界是 max-content，
     而 .body 裡的標題不換行時很長，會把整張卡撐寬 */
  display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto;
}
/* 圖從絕對定位改回文件流，自己撐出 5:7 —— 跟 .wide 同一招 */
.pool.stage .art-tilt { position: relative; inset: auto; aspect-ratio: 5 / 7; }
/* 遮罩只剩上緣一小段，作用單純是讓兩顆角落徽章讀得到；
   卡圖的主體（構圖、招式框、閃箔）完全不碰 */
.pool.stage .scrim {
  inset: 0 0 auto; height: 84px;
  background: linear-gradient(180deg, rgba(8, 6, 14, .58), rgba(8, 6, 14, 0));
}
.pool.stage .body {
  position: relative; inset: auto;
  padding: 13px 15px 15px; gap: 7px;
  color: var(--ink);
}
/* 實底上不需要陰影撐可讀性，拿掉之後字反而乾淨 */
.pool.stage h3 { font-size: 18px; line-height: 1.3; text-shadow: none; }
.pool.stage .top { font-size: 12.5px; }
.pool.stage .prize { color: var(--muted); opacity: 1; }
.pool.stage .state.live { color: var(--ok); }
.pool.stage .state.gone { color: var(--faint); opacity: 1; }
.pool.stage .meter { height: 5px; background: var(--surface-3); }
.pool.stage .price { font-size: 20px; text-shadow: none; }
.pool.stage .per, .pool.stage .rest { font-size: 12px; color: var(--muted); opacity: 1; }

@media (max-width: 720px) {
  .body { padding: 9px 9px 10px; gap: 5px; }
  h3 { font-size: 15px; line-height: 1.2; }
  .top { font-size: 10.5px; }
  .state { font-size: 10px; }
  .price { font-size: 14.5px; }
  /* 320px 的兩欄格線下欄寬只剩約 139px，「1,280 點 / 抽」的「/ 抽」會掉到
     第二行，價格看起來像被截斷。整串不換行，再把單位縮小讓它塞得下 —— 
     寧可單位小一點，也不要一個看起來壞掉的價格 */
  .price { white-space: nowrap; }
  .price .per { font-size: .78em; }
  .per, .rest { font-size: 10px; }
  .mode-tag { top: 7px; left: 7px; transform: scale(.86); transform-origin: top left; }
  .origin-tag { top: 7px; right: 7px; transform: scale(.86); transform-origin: top right; }
  .doneTag { top: 38px; right: 7px; font-size: 10px; padding: 3px 8px; }
  .pool.stage .body { padding: 12px 13px 13px; }
  .pool.stage h3 { font-size: 16.5px; }
  .pool.stage .price { font-size: 18px; }
}

/* 1120px 起，選池台旁邊會出現資訊面板（見 PlayPage 的 .panel），
   標題、最高賞、剩餘抽數、單價在那裡全部講過一次 —— 卡片下面再講一遍
   等於同一頁上有兩份同樣的字，還把卡片多推高 130px（1280×800 下會擠到
   要捲頁才看得完）。有面板的時候就讓卡片回到「純粹是一張卡」。

   這裡用視窗斷點而不是容器查詢，是因為條件真的是視窗寬度：
   面板存不存在由 PlayPage 的 @media (min-width: 1120px) 決定，
   跟軌道自己有多寬無關。stage 這個變體也只有選池台在用。 */
@media (min-width: 1120px) {
  .pool.stage { aspect-ratio: 5 / 7; display: block; }
  .pool.stage .art-tilt { position: absolute; inset: 0; aspect-ratio: auto; }
  .pool.stage .body { display: none; }
}
</style>
