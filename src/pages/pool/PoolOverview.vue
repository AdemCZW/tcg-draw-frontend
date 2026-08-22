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
import PoolOriginBadge from '@/components/PoolOriginBadge.vue'
import SellerChip from '@/components/SellerChip.vue'
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
      <!-- 這裡本來疊了一顆 compact 寶貝球當等級標記，拿掉了：
           CapsuleArt 的細節（光暈、開口漏光、按鈕高光）在 70px 上糊成一團紫色斑塊，
           讀不出那是一顆球；而它要傳達的等級，下面已經用文字講了三次
           （玩法徽章 / 最高賞未出 / 最後賞 · 卡名）。讀不懂的裝飾就只是雜訊。 -->
      <div class="art">
        <!-- 玩法與來源標在卡片上緣：這兩件事講的是「這一池是什麼」，
             跟卡片是同一個對象，分開放會讓人要在兩處之間來回對照。
             原本用 detailed 模式在下面各展開一段規則說明，兩段字把卡片擠小了 —— 
             卡是這一頁的主角，規則細節在賣家頁與交易保護頁都查得到。 -->
        <div class="artTags">
          <PoolModeBadge :mode="pool.mode" />
          <PoolOriginBadge :origin="pool.origin" />
        </div>
        <Tilt3D :max="16" class="cover" :style="{ viewTransitionName: `pool-cover-${pool.id}` }">
          <CardArt :image="pool.cover" :alt="topPrize?.card.name ?? pool.title" :tier="topPrize?.tier" :cert-no="topPrize?.card.certNo" :art-id="topPrize?.card.artId" />
        </Tilt3D>
      </div>

      <div class="facts">
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
      餘額 <span class="mono">{{ wallet.shown.toLocaleString() }}</span> 點 ·
      <RouterLink :to="{ name: 'pool-prizes', params: { id: pool.id } }" replace>看全部獎項 →</RouterLink>
    </p>
  </div>
</template>

<style scoped>
.ov { display: grid; gap: 16px; }
.hero { padding: 18px; display: grid; grid-template-columns: auto 1fr; gap: 20px; align-items: center; }
.art { position: relative; width: 190px; flex: none; }
.cover { width: 100%; }
/* 疊在卡片上緣，左右各一。z-index 要壓過 Tilt3D —— 它有 transform，
   會自成一個堆疊脈絡，不給值的話標籤會被卡面蓋住 */
.artTags {
  position: absolute; z-index: 3; top: -11px; left: 6px; right: 6px;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  pointer-events: none;
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
  /* 手機上卡片是唯一的主角，佔滿可用寬度。上限擋住平板寬度下的過度放大 */
  .art { width: min(100%, 260px); }
  .facts { justify-items: center; }
  .top { text-align: center; }
  .sellerRow { justify-content: center; }
}
</style>
