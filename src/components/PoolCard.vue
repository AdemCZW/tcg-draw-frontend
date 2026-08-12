<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Pool } from '@/types/models'
import CardArt from './CardArt.vue'
import PoolModeBadge from './PoolModeBadge.vue'
import SellerChip from './SellerChip.vue'
import { useSellerStore } from '@/stores/sellers'

const props = defineProps<{ pool: Pool }>()
const sellers = useSellerStore()
sellers.ensureLoaded()
const seller = computed(() => sellers.byId(props.pool.sellerId))

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
    :to="`/pools/${pool.id}`"
    class="pool"
    @pointermove="onMove"
    @pointerleave="onLeave"
  >
    <div class="art-scene">
      <div
        ref="art"
        class="art-tilt"
        :style="{ transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` }"
      >
        <CardArt :image="pool.cover" :alt="topPrize?.card.name ?? pool.title" :tier="topPrize?.tier" :cert-no="topPrize?.card.certNo" />
        <span
          class="glare"
          :style="{ background: `radial-gradient(60% 60% at ${tilt.gx}% ${tilt.gy}%, rgba(255,255,255,.5), transparent 70%)` }"
          aria-hidden="true"
        ></span>
      </div>
      <div class="mode-tag"><PoolModeBadge :mode="pool.mode" /></div>
    </div>

    <div class="body">
      <div class="title-row">
        <h3>{{ pool.title }}</h3>
        <span v-if="pool.status !== 'open'" class="chip">完抽</span>
      </div>
      <p class="top" v-if="topPrize">
        <span class="muted prize">{{ topPrize.tier === 'LAST' ? '最後賞' : 'A 賞' }} · {{ topPrize.card.name }}</span>
        <span class="state" :class="aLive ? 'live' : 'gone'">{{ aLive ? '未出' : '已出' }}</span>
      </p>
      <div class="meter" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100" :aria-label="`剩餘 ${pct}%`">
        <div class="fill" :style="{ width: pct + '%' }"></div>
      </div>
      <div class="foot">
        <strong class="price">{{ pool.ticketPrice.toLocaleString() }} 點 <span class="per muted">/ 抽</span></strong>
        <span class="muted rest">剩 {{ pool.remainingTickets }} / {{ pool.totalTickets }}</span>
      </div>
      <div v-if="seller" class="seller"><SellerChip :seller="seller" :link="false" /></div>
    </div>
  </RouterLink>
</template>

<style scoped>
/* 卡片高度由 grid 拉齊，內部用 flex 把進度條以下推到底 ——
   否則標題長短不一時，各卡的價格與進度條會落在不同高度。 */
.pool {
  display: flex; flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-lg);
  padding: 12px;
  box-shadow: var(--shadow-sm);
  transition: transform .28s cubic-bezier(.2,.7,.3,1), box-shadow .28s;
}
.pool:hover { transform: translateY(-6px); box-shadow: var(--shadow-lg); }
.pool:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

.art-scene { position: relative; perspective: 900px; }
.art-tilt {
  position: relative;
  transform-style: preserve-3d;
  transition: transform .35s cubic-bezier(.2,.7,.3,1);
  border-radius: 14px;
  overflow: hidden;
}
.pool:hover .art-tilt { transition: transform .08s linear; }
.glare {
  position: absolute; inset: 0;
  pointer-events: none;
  mix-blend-mode: soft-light;
  opacity: 0; transition: opacity .3s;
}
.pool:hover .glare { opacity: 1; }
.mode-tag { position: absolute; top: 10px; left: 10px; }

.body { padding: 14px 6px 4px; display: flex; flex-direction: column; flex: 1; }
.title-row { display: flex; align-items: flex-start; gap: 8px; }
h3 {
  margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.02em;
  /* 統一最多兩行，避免超長標題把版面撐開 */
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.top { display: flex; align-items: baseline; gap: 6px; font-size: 13px; margin: 6px 0 12px; }
.prize { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { flex: none; }
.live { color: var(--ok); font-weight: 600; }
.gone { color: var(--faint); }
/* 進度條以下貼齊卡片底部 */
.meter { margin-top: auto; height: 6px; border-radius: var(--pill); background: var(--surface-2); overflow: hidden; }
.fill { height: 100%; border-radius: var(--pill); background: linear-gradient(90deg, var(--accent), var(--accent-soft)); }
.foot { display: flex; align-items: baseline; justify-content: space-between; margin-top: 12px; }
.price { font-size: 16px; font-weight: 600; letter-spacing: -0.02em; }
.per { font-size: 13px; font-weight: 400; }
.rest { font-size: 13px; }
.seller { margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--line-soft); }

@media (max-width: 720px) {
  .pool { padding: 9px; border-radius: var(--radius); }
  .pool:hover { transform: none; box-shadow: var(--shadow-sm); }
  .mode-tag { top: 7px; left: 7px; transform: scale(.9); transform-origin: top left; }
  .body { padding: 11px 4px 2px; }
  h3 { font-size: 14px; line-height: 1.35; }
  /* 手機不換行：靠截斷保持每張卡同高，換行會讓相鄰卡片錯開 */
  .top { font-size: 12px; margin: 5px 0 10px; gap: 5px; }
  .foot { flex-direction: column; align-items: flex-start; gap: 2px; }
  .price { font-size: 14.5px; }
  .rest { font-size: 12px; }
  .seller { margin-top: 10px; padding-top: 9px; }
}
</style>
