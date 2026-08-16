<script setup lang="ts">
/**
 * 池 · 總覽 —— 「要不要玩」這一頁。
 * 封面、玩法、賣家、還沒出的最高賞，然後一顆主 CTA。
 * 獎項細節與驗算材料在另外兩個 tab；這頁只回答「值不值得開」。
 */
import { computed } from 'vue'
import type { Pool, Tier } from '@/types/models'
import { useSellerStore } from '@/stores/sellers'
import { useWalletStore } from '@/stores/wallet'
import CardArt from '@/components/CardArt.vue'
import Tilt3D from '@/components/Tilt3D.vue'
import PoolModeBadge from '@/components/PoolModeBadge.vue'
import SellerChip from '@/components/SellerChip.vue'
import CapsuleArt from '@/components/CapsuleArt.vue'
import AuctionPanel from '@/components/AuctionPanel.vue'
import DrawPanel from '@/components/DrawPanel.vue'

const props = defineProps<{ pool: Pool }>()
const sellers = useSellerStore()
const wallet = useWalletStore()

const seller = computed(() => sellers.byId(props.pool.sellerId))
const RANK: Record<Tier, number> = { BUST: 0, D: 1, C: 2, B: 3, A: 4, LAST: 5 }
/** 還沒出的最高賞：寶貝球球階與「最高賞未出」標籤都看它 */
const topLive = computed(() =>
  props.pool.prizes.filter(p => p.remaining > 0)
    .reduce<typeof props.pool.prizes[number] | undefined>((best, p) =>
      !best || RANK[p.tier] > RANK[best.tier] ? p : best, undefined))
const topPrize = computed(() => props.pool.prizes.find(p => p.tier === 'A') ?? props.pool.prizes[0])
const inAuctionPhase = computed(() =>
  props.pool.mode === 'auction' && props.pool.remainingTickets <= (props.pool.auctionSeats ?? 0))
const pct = computed(() => Math.round((props.pool.remainingTickets / props.pool.totalTickets) * 100))
</script>

<template>
  <div class="ov">
    <section class="hero card">
      <!-- 左：封面卡（可傾斜）；右：寶貝球（球階＝還沒出的最高賞） -->
      <div class="art">
        <Tilt3D :max="16" class="cover">
          <CardArt :image="pool.cover" :alt="topPrize?.card.name ?? pool.title" :tier="topPrize?.tier" :cert-no="topPrize?.card.certNo" />
        </Tilt3D>
        <div class="ball" aria-hidden="true">
          <CapsuleArt :tier="topLive?.tier ?? 'D'" compact flat />
        </div>
      </div>

      <div class="facts">
        <PoolModeBadge :mode="pool.mode" detailed />
        <p v-if="topLive" class="top">
          <span class="lbl mono">最高賞未出</span>
          <strong>{{ topLive.tier === 'LAST' ? '最後賞' : topLive.tier + ' 賞' }} · {{ topLive.card.name }}</strong>
        </p>
        <div class="meter" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100" :aria-label="`剩餘 ${pct}%`">
          <div class="fill" :style="{ width: pct + '%' }"></div>
        </div>
        <div v-if="seller" class="sellerRow">
          <span class="by muted">賣家</span>
          <SellerChip :seller="seller" />
        </div>
      </div>
    </section>

    <!-- 競標階段：面板只在這一頁掛載，離開就拆（它有兩個 interval） -->
    <AuctionPanel v-if="pool.mode === 'auction' && inAuctionPhase" :pool="pool" class="auction" />

    <!-- 手機主 CTA：桌機的側欄面板在這裡看不到，所以總覽頁自己放一份 -->
    <div class="mobileCta">
      <DrawPanel v-if="pool.status === 'open' && !inAuctionPhase" :pool="pool" />
      <div v-else-if="pool.status !== 'open'" class="done card">
        <p>本池已完抽</p>
        <RouterLink :to="{ name: 'fairness-pool', params: { poolId: pool.id } }" class="btn">驗證抽選結果</RouterLink>
      </div>
    </div>

    <p class="hint muted">
      餘額 <span class="mono">{{ wallet.points.toLocaleString() }}</span> 點 ·
      <RouterLink :to="{ name: 'pool-prizes', params: { id: pool.id } }" replace>看全部獎項 →</RouterLink>
    </p>
  </div>
</template>

<style scoped>
.ov { display: grid; gap: 16px; }
.hero { padding: 18px; display: grid; grid-template-columns: auto 1fr; gap: 20px; align-items: center; }
.art { position: relative; width: 150px; flex: none; }
.cover { width: 100%; }
/* 小球疊在封面右下角，蓋一點點邊 —— 「這一池的等級」貼在封面上 */
.ball {
  position: absolute; right: -14px; bottom: -10px;
  width: 64px;
  filter: drop-shadow(0 4px 10px rgba(0, 0, 0, .5));
}
.facts { display: grid; gap: 12px; justify-items: start; min-width: 0; }
.top { margin: 0; display: grid; gap: 4px; }
.top .lbl { font-size: 11px; letter-spacing: .14em; color: var(--ok); }
.top strong { font-size: 16px; }
.meter { width: 100%; max-width: 360px; height: 6px; border-radius: var(--pill); background: var(--surface-2); overflow: hidden; }
.fill { height: 100%; border-radius: var(--pill); background: linear-gradient(90deg, var(--accent), var(--accent-soft)); }
.sellerRow { display: flex; align-items: center; gap: 8px; }
.by { font-size: 12px; font-weight: 600; }
.auction { margin-top: 2px; }
.mobileCta { display: none; }
.done { padding: 20px; text-align: center; display: grid; gap: 10px; }
.done p { margin: 0; }
.hint { font-size: 13px; margin: 0; }
.hint a { color: var(--accent); }

@media (max-width: 860px) {
  .mobileCta { display: block; }
}
@media (max-width: 720px) {
  .hero { grid-template-columns: 1fr; gap: 16px; padding: 16px; justify-items: center; text-align: center; }
  .art { width: 132px; }
  .facts { justify-items: center; }
  .top { text-align: center; }
  .sellerRow { justify-content: center; }
}
</style>
