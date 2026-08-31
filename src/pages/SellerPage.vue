<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useSellerStore } from '@/stores/sellers'
import { usePoolStore } from '@/stores/pools'
import PoolCard from '@/components/PoolCard.vue'
import SellerChip from '@/components/SellerChip.vue'
import CardArt from '@/components/CardArt.vue'
import TierBadge from '@/components/TierBadge.vue'

const route = useRoute()
const sellers = useSellerStore()
const pools = usePoolStore()

onMounted(() => { sellers.ensureLoaded(); pools.ensureLoaded() })

const seller = computed(() => sellers.byId(String(route.params.id)))
const theirPools = computed(() => pools.pools.filter(p => p.sellerId === route.params.id))
const openPools = computed(() => theirPools.value.filter(p => p.status === 'open'))
const pastPools = computed(() => theirPools.value.filter(p => p.status !== 'open'))

/* 實際 vs 標示的落差。
   正號代表實際比標示好，負號代表比較差。
   樣本數少於 1000 抽就標成「樣本不足」—— 開三池宣稱 100% 命中也能成立，
   沒有樣本數的百分比是沒有意義的數字。 */
const gap = computed(() => {
  const st = seller.value?.stats
  if (!st || !st.drawsSettled) return null
  return {
    diff: +(st.actualTopRate - st.advertisedTopRate).toFixed(2),
    thin: st.drawsSettled < 1000
  }
})
</script>

<template>
  <div class="container page" v-if="seller">
    <header class="profile card">
      <SellerChip :seller="seller" size="md" :link="false" />
      <p class="handle mono muted">@{{ seller.handle }} · 加入於 {{ seller.joinedAt }}</p>
      <p class="bio">{{ seller.bio }}</p>

      <div v-if="seller.tier === 'pending'" class="warn">
        此賣家尚未通過身分驗證，目前不能開賣。
      </div>

      <dl class="stats">
        <div><dt>開過的池</dt><dd class="mono">{{ seller.stats.poolsRun }}</dd></div>
        <div><dt>已出貨卡片</dt><dd class="mono">{{ seller.stats.cardsShipped.toLocaleString() }}</dd></div>
        <div><dt>平均出貨</dt><dd class="mono">{{ seller.stats.avgShipDays }} 天</dd></div>
        <div :class="{ bad: seller.stats.disputeRate > 1 }">
          <dt>糾紛率</dt><dd class="mono">{{ seller.stats.disputeRate }}%</dd>
        </div>
      </dl>

      <!-- 中獎率：標示與實際擺在一起。
           只放標示率等於只放行銷文案；只放實際率沒有對照也看不出好壞。 -->
      <section v-if="gap" class="rate">
        <h2>高賞中獎率</h2>
        <div class="rateRow">
          <div class="rateCell">
            <span class="rl">標示</span>
            <strong class="mono rv">{{ seller.stats.advertisedTopRate }}%</strong>
          </div>
          <span class="arrow" aria-hidden="true">→</span>
          <div class="rateCell">
            <span class="rl">實際結算</span>
            <strong class="mono rv" :class="gap.diff >= 0 ? 'good' : 'under'">
              {{ seller.stats.actualTopRate }}%
            </strong>
          </div>
          <span class="delta mono" :class="gap.diff >= 0 ? 'good' : 'under'">
            {{ gap.diff >= 0 ? '+' : '' }}{{ gap.diff }}
          </span>
        </div>
        <p class="sample muted mono">
          樣本 {{ seller.stats.drawsSettled.toLocaleString() }} 抽（已完抽池）
          <span v-if="gap.thin" class="thin">· 樣本數偏少，誤差大</span>
        </p>
        <p v-if="gap.diff < -0.3" class="under note">
          此賣家的實際中獎率低於標示。數字由已完抽池自動結算，賣家無法修改。
        </p>
      </section>

      <!-- 過去開出的大獎 -->
      <section v-if="seller.pastPrizes.length" class="past">
        <h2>過去開出的大獎</h2>
        <ul class="prizeList">
          <li v-for="(pz, i) in seller.pastPrizes" :key="i">
            <span class="pzArt"><CardArt :image="''" :alt="pz.cardName" :art-id="pz.artId" :tier="pz.tier" /></span>
            <span class="pzText">
              <span class="pzTop"><TierBadge :tier="pz.tier" /><strong>{{ pz.cardName }}</strong></span>
              <span class="muted mono pzMeta">{{ pz.poolTitle }} · {{ pz.wonAt }} · {{ pz.winner }}</span>
            </span>
          </li>
        </ul>
      </section>
    </header>

    <section v-if="openPools.length">
      <h2 class="sec display">抽選中</h2>
      <div class="poolGrid"><PoolCard v-for="p in openPools" :key="p.id" :pool="p" /></div>
    </section>

    <section v-if="pastPools.length">
      <h2 class="sec display">已完抽</h2>
      <div class="poolGrid"><PoolCard v-for="p in pastPools" :key="p.id" :pool="p" /></div>
    </section>

    <p v-if="!theirPools.length" class="muted empty">這位賣家還沒有開過池。</p>
  </div>
  <div v-else class="container page"><p class="muted">找不到這位賣家。<RouterLink to="/pools">回抽選列表</RouterLink></p></div>
</template>

<style scoped>
/* ---- 中獎率 ---- */
.rate { margin-top: 18px; padding-top: 16px; border-top: 1px dashed var(--line); }
.rate h2, .past h2 { font-size: 13px; color: var(--muted); margin: 0 0 10px; font-weight: 600; }
.rateRow { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.rateCell { display: grid; gap: 2px; }
.rl { font-size: 11.5px; color: var(--faint); }
.rv { font-size: 24px; font-weight: 700; letter-spacing: -.02em; }
.rv.good { color: var(--ok); }
.rv.under { color: var(--danger); }
.arrow { color: var(--faint); font-size: 18px; }
.delta { font-size: 15px; font-weight: 700; padding: 3px 10px; border-radius: var(--pill); }
.delta.good { background: var(--ok-wash); color: var(--ok); }
.delta.under { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); }
.sample { font-size: 11.5px; margin: 8px 0 0; }
.thin { color: var(--warn, var(--muted)); }
.note { font-size: 12.5px; line-height: 1.6; margin: 8px 0 0; }
.note.under { color: var(--danger); }

/* ---- 過去大獎 ---- */
.past { margin-top: 18px; padding-top: 16px; border-top: 1px dashed var(--line); }
.prizeList { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.prizeList li { display: flex; align-items: center; gap: 12px; }
.pzArt { width: 44px; flex: none; }
.pzText { display: grid; gap: 3px; min-width: 0; }
.pzTop { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pzTop strong { font-size: 14px; font-weight: 700; }
.pzMeta { font-size: 11px; }


.page { padding-top: 28px; padding-bottom: 72px; }
.profile { padding: 20px; margin-bottom: 26px; }
.handle { font-size: 12.5px; margin: 8px 0 0; }
.bio { font-size: 14px; margin: 10px 0 0; max-width: 620px; }
.warn {
  margin-top: 12px; padding: 8px 12px;
  border: 1px solid var(--line); border-radius: 8px;
  background: color-mix(in srgb, var(--warn) 18%, var(--surface));
  font-size: 13px; font-weight: 600;
}
.stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px; margin: 16px 0 0; padding-top: 14px;
  border-top: 1px dashed var(--line);
}
.stats div { display: grid; gap: 1px; }
dt { font-size: 11.5px; color: var(--muted); font-weight: 600; }
dd { margin: 0; font-size: 19px; font-weight: 600; }
.stats .bad dd { color: var(--danger); }
.sec {
  display: inline-block; font-size: 17px; margin: 0 0 14px;
  padding: 3px 14px; color: var(--ink);
}
section + section { margin-top: 30px; }
/* 不叫 .grid：子元件根元素會帶父層 scope id，而 PoolCard 預設 variant 就叫 grid，
   會被這條規則打到、整張卡變成 grid 容器把卡圖壓成 0 寬 */
.poolGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 18px; }
.empty { margin-top: 20px; }
@media (max-width: 720px) {
  .page { padding-top: 20px; padding-bottom: 40px; }
  .poolGrid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
  dd { font-size: 16px; }
}
</style>
