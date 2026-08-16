<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useSellerStore } from '@/stores/sellers'
import { usePoolStore } from '@/stores/pools'
import PoolCard from '@/components/PoolCard.vue'
import SellerChip from '@/components/SellerChip.vue'

const route = useRoute()
const sellers = useSellerStore()
const pools = usePoolStore()

onMounted(() => { sellers.ensureLoaded(); pools.ensureLoaded() })

const seller = computed(() => sellers.byId(String(route.params.id)))
const theirPools = computed(() => pools.pools.filter(p => p.sellerId === route.params.id))
const openPools = computed(() => theirPools.value.filter(p => p.status === 'open'))
const pastPools = computed(() => theirPools.value.filter(p => p.status !== 'open'))
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
