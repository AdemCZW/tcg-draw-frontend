<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Pool } from '@/types/models'
import CardArt from './CardArt.vue'
import PoolModeBadge from './PoolModeBadge.vue'

const props = withDefaults(defineProps<{
  pool: Pool
  /** grid = 清單裡的一格；stage = 選池台上的主角，字級放大、資訊更好讀 */
  variant?: 'grid' | 'stage'
}>(), { variant: 'grid' })

const pct = computed(() => Math.round((props.pool.remainingTickets / props.pool.totalTickets) * 100))
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
        :image="pool.cover" :alt="topPrize?.card.name ?? pool.title" :tier="topPrize?.tier" :cert-no="topPrize?.card.certNo"
      />
      <span
        class="glare"
        :style="{ background: `radial-gradient(60% 60% at ${tilt.gx}% ${tilt.gy}%, rgba(255,255,255,.42), transparent 70%)` }"
        aria-hidden="true"
      ></span>
    </div>

    <span class="scrim" aria-hidden="true"></span>

    <div class="mode-tag"><PoolModeBadge :mode="pool.mode" /></div>
    <span v-if="pool.status !== 'open'" class="doneTag">完抽</span>

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
.doneTag {
  position: absolute; top: 10px; right: 10px; z-index: 2;
  font-size: 11px; font-weight: 700;
  padding: 4px 10px; border-radius: var(--pill);
  background: rgba(8, 6, 14, .8); color: #fff;
}

.body {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
  padding: 12px 12px 13px;
  display: grid; gap: 6px;
  color: #fff;
}
h3 {
  margin: 0; font-size: 15px; font-weight: 700; line-height: 1.3;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  text-shadow: 0 1px 6px rgba(0, 0, 0, .75);
}
.top { display: flex; align-items: baseline; gap: 6px; font-size: 12px; margin: 0; min-width: 0; }
.prize { opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.state { flex: none; font-weight: 700; font-size: 11px; }
.state.live { color: #5ce08a; }
.state.gone { opacity: .5; }

.meter { height: 4px; border-radius: var(--pill); background: rgba(255, 255, 255, .22); overflow: hidden; }
.fill { height: 100%; border-radius: var(--pill); background: linear-gradient(90deg, var(--accent), var(--accent-soft)); }

.foot { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.price { font-size: 17px; font-weight: 800; letter-spacing: -.01em; text-shadow: 0 2px 8px rgba(0, 0, 0, .7); }
.per { font-size: 11px; font-weight: 400; opacity: .7; }
.rest { font-size: 11px; opacity: .68; white-space: nowrap; }

/* ---- stage：選池台的大卡，同一套版面放大 ---- */
.pool.stage { border-radius: var(--radius-lg); }
.pool.stage .body { padding: 16px 16px 17px; gap: 8px; }
.pool.stage h3 { font-size: 20px; }
.pool.stage .top { font-size: 13.5px; }
.pool.stage .price { font-size: 22px; }
.pool.stage .per, .pool.stage .rest { font-size: 13px; }
.pool.stage .meter { height: 5px; }

@media (max-width: 720px) {
  .body { padding: 9px 9px 10px; gap: 5px; }
  h3 { font-size: 12.5px; }
  .top { font-size: 10.5px; }
  .state { font-size: 10px; }
  .price { font-size: 14.5px; }
  .per, .rest { font-size: 10px; }
  .mode-tag { top: 7px; left: 7px; transform: scale(.86); transform-origin: top left; }
  .doneTag { top: 7px; right: 7px; font-size: 10px; padding: 3px 8px; }
  .pool.stage .body { padding: 14px; }
  .pool.stage h3 { font-size: 17px; }
  .pool.stage .price { font-size: 19px; }
}
</style>
