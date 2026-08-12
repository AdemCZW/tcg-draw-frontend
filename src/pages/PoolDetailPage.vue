<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { usePoolStore } from '@/stores/pools'
import PrizeTable from '@/components/PrizeTable.vue'
import DrawPanel from '@/components/DrawPanel.vue'
import CommitHashBox from '@/components/CommitHashBox.vue'
import CardArt from '@/components/CardArt.vue'
import PoolModeBadge from '@/components/PoolModeBadge.vue'
import AuctionPanel from '@/components/AuctionPanel.vue'
import SellerChip from '@/components/SellerChip.vue'
import EscrowNotice from '@/components/EscrowNotice.vue'
import Tilt3D from '@/components/Tilt3D.vue'
import { useSellerStore } from '@/stores/sellers'
import { track } from '@/lib/ga'

const route = useRoute()
const pools = usePoolStore()
const sellers = useSellerStore()
sellers.ensureLoaded()
const seller = computed(() => pool.value ? sellers.byId(pool.value.sellerId) : undefined)
const pool = computed(() => pools.byId(String(route.params.id)))
const topPrize = computed(() => pool.value?.prizes.find(p => p.tier === 'A'))
const inAuctionPhase = computed(() =>
  pool.value?.mode === 'auction' && pool.value.remainingTickets <= (pool.value.auctionSeats ?? 0)
)

onMounted(async () => {
  await pools.ensureLoaded()
  track('view_pool_detail')
})
</script>

<template>
  <div class="container page" v-if="pool">
    <div class="layout">
      <div class="main">
        <div class="head">
          <div class="cover">
            <Tilt3D :max="18">
              <CardArt :image="pool.cover" :alt="topPrize?.card.name ?? pool.title" :tier="topPrize?.tier" :cert-no="topPrize?.card.certNo" />
            </Tilt3D>
          </div>
          <div>
            <h1>{{ pool.title }}</h1>
            <div class="meta mono muted">
              <span>{{ pool.ticketPrice.toLocaleString() }} 點 / 抽</span>
              <span>剩 {{ pool.remainingTickets }} / {{ pool.totalTickets }} 籤</span>
              <span :class="pool.status === 'open' ? 'live' : ''">{{ pool.status === 'open' ? '抽選中' : '已完抽' }}</span>
            </div>
            <div class="mode-row">
              <PoolModeBadge :mode="pool.mode" detailed />
            </div>
            <div v-if="seller" class="seller-row">
              <span class="by muted">賣家</span>
              <SellerChip :seller="seller" />
            </div>
          </div>
        </div>
        <h2>獎項與剩餘</h2>
        <PrizeTable :pool="pool" />
        <AuctionPanel v-if="pool.mode === 'auction'" :pool="pool" />
        <EscrowNotice :pool="pool" />
        <CommitHashBox :pool="pool" class="fair" />
      </div>
      <aside class="side">
        <!-- 競標階段：剩餘籤全是標的，不走一般購買 -->
        <div v-if="pool.status === 'open' && inAuctionPhase" class="done card">
          <p><strong>已進入尾籤競標</strong></p>
          <p class="muted fine">剩下的 {{ pool.remainingTickets }} 支籤改由競標決定得主，請於下方獎項表後方出價。</p>
        </div>
        <DrawPanel v-else-if="pool.status === 'open'" :pool="pool" />
        <div v-else class="done card">
          <p>本池已完抽</p>
          <RouterLink :to="`/fairness/${pool.id}`" class="btn">驗證抽選結果</RouterLink>
        </div>
      </aside>
    </div>
  </div>
  <div v-else class="container page"><p class="muted">找不到這個池，可能已下架。<RouterLink to="/pools">回抽選列表</RouterLink></p></div>
</template>

<style scoped>
.page { padding-top: 32px; padding-bottom: 72px; }
.layout { display: grid; grid-template-columns: 1fr 320px; gap: 28px; align-items: start; }
.head { display: flex; gap: 20px; margin-bottom: 26px; }
.cover { width: 130px; flex: none; }
h1 { font-size: 22px; margin: 4px 0 10px; }
.meta { display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px; }
.mode-row { margin-top: 12px; }
.seller-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.by { font-size: 12px; font-weight: 600; }
.live { color: var(--ok); font-weight: 600; }
h2 { font-size: 15px; color: var(--muted); margin: 0 0 10px; }
.fair { margin-top: 16px; }
.side { position: sticky; top: 76px; }
.done { padding: 20px; text-align: center; display: grid; gap: 10px; }
.done p { margin: 0; }
.done .fine { font-size: 12.5px; }
@media (max-width: 860px) {
  .layout { grid-template-columns: 1fr; }
  .side { position: static; order: -1; }
}
@media (max-width: 720px) {
  .page { padding-top: 20px; padding-bottom: 40px; }
  .layout { gap: 22px; }
  .head { gap: 14px; margin-bottom: 20px; }
  .cover { width: 96px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  .meta { gap: 6px 12px; font-size: 12px; }
  .mode-row { margin-top: 10px; }
}
</style>
