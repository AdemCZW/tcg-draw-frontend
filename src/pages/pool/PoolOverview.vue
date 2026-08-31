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
import DrawPanel from '@/components/DrawPanel.vue'
import { FAIRNESS_UI } from '@/lib/config'
import { POOL_STATUS_LABEL, POOL_STATUS_NOTE, isDrawable, isUpcoming, isRevealed } from '@/lib/pool-status'

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

    <!-- 手機主 CTA：桌機的側欄面板在這裡看不到，所以總覽頁自己放一份。
         這一份走 sheet 版 —— 手機一屏就這麼高，合計與按鈕不該一進頁就先佔掉一塊；
         選了抽數才從畫面下緣把購買列叫出來（見 DrawPanel 的 variant 說明） -->
    <div class="mobileCta">
      <DrawPanel v-if="isDrawable(pool)" :pool="pool" variant="sheet" />
      <!-- 還沒開賣（committed）跟抽完了（sold_out / revealed）以前共用
           同一張「本池已完抽」的卡。手機上這一塊就是主 CTA 的位置，
           講錯的代價最大：一個剛開好、100 籤全在的池被說成沒得抽，
           買家直接離開，而它其實只要等幾分鐘。 -->
      <div v-else-if="isUpcoming(pool)" class="done card soonCard">
        <p class="soonHead">{{ POOL_STATUS_LABEL[pool.status] }}</p>
        <p class="muted soonNote">{{ POOL_STATUS_NOTE[pool.status] }}</p>
      </div>
      <div v-else class="done card">
        <p>{{ POOL_STATUS_LABEL[pool.status] }}</p>
        <p class="muted soonNote">{{ POOL_STATUS_NOTE[pool.status] }}</p>
        <!-- 驗算入口暫時收起來（見 lib/config.ts 的 FAIRNESS_UI）。
             這張卡本身留著：它是購買面板讓位之後的狀態說明。
             只掛在已開獎的池上 —— 抽完但種子還沒公開時按進去只會看到
             「本池尚未開獎」，那顆按鈕騙人按。 -->
        <RouterLink
          v-if="FAIRNESS_UI && isRevealed(pool)" :to="{ name: 'fairness-pool', params: { poolId: pool.id } }" class="btn"
        >驗證抽選結果</RouterLink>
      </div>
    </div>

    <p class="hint muted">
      餘額 <span class="mono">{{ wallet.shown.toLocaleString() }}</span> 點
    </p>

    <!-- 「看全部獎項」從上面那行小字裡拆出來，自己成為一列。
         原本它是接在餘額後面的行內連結：13px 字、可點高度只有 16px。
         實測（393×852）落點偏離連結中心超過 18px 就完全點不到 ——
         Chromium 的觸控修正也只把它補到約 30px，仍遠低於 44。
         使用者回報的「完全沒有反應」就是這麼來的：路由與頁面都是好的，
         是那個目標小到拇指打不中，而且它還在首屏之外 87px，
         得先捲到底才看得見，於是「找得很辛苦、點了又沒反應」。
         把餘額（資訊）與看獎項（動作）分開，動作那列整塊可點、高度給滿 44。 -->
    <RouterLink class="allPrizes" :to="{ name: 'pool-prizes', params: { id: pool.id } }" replace>
      <span>看全部獎項</span>
      <span class="arrow" aria-hidden="true">→</span>
    </RouterLink>
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
.mobileCta { display: none; }
.done { padding: 20px; text-align: center; display: grid; gap: 10px; }
.done p { margin: 0; }
/* --warn-ink 而不是 --warn：淺色主題下 --warn 當字色對比只有 2.6（見 tokens.css） */
.soonHead { color: var(--warn-ink); font-weight: 700; }
/* 說明是整段句子不是標籤：行高放寬、字級壓在標題之下，
   並限寬 —— 桌機一行 60 幾個字讀不下去 */
.soonNote { font-size: 13px; line-height: 1.65; max-width: 46ch; margin-inline: auto; }
.hint { font-size: 13px; margin: 0; }

/* 整列可點。min-height 44 是硬性下限，padding 讓字不貼邊；
   grid 的 minmax(0, 1fr) 讓長文字自己收斂，不會把箭頭擠出列外。 */
.allPrizes {
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: center; gap: 12px;
  min-height: 44px; padding: 11px 14px;
  border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--surface); color: var(--ink);
  font-size: 14.5px; font-weight: 600;
  transition: border-color .15s;
}
.allPrizes .arrow { color: var(--accent); font-size: 15px; }
@media (hover: hover) { .allPrizes:hover { border-color: var(--accent); } }
.allPrizes:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

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
