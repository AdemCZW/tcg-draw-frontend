<script setup lang="ts">
// 抽選結果：Three.js 立體開卡演出，下方保留明細清單
import { computed, onMounted, ref } from 'vue'
import { usePoolStore } from '@/stores/pools'
import CardArt from '@/components/CardArt.vue'
import TierBadge from '@/components/TierBadge.vue'
import CertTag from '@/components/CertTag.vue'
import CardReveal3D from '@/components/CardReveal3D.vue'
import Tilt3D from '@/components/Tilt3D.vue'
import { track } from '@/lib/ga'

const pools = usePoolStore()
const result = pools.lastResult
const revealed = ref(false)

// 兩張並排往下排：舞台高度隨列數成長，讓每張卡維持可辨識的大小
const rows = computed(() => Math.ceil((result?.items.length ?? 1) / 2))
const stageHeight = computed(() => 300 + (rows.value - 1) * 250)

onMounted(() => track('view_prize_result'))
</script>

<template>
  <div class="container page" v-if="result">
    <h1 class="display">抽選結果</h1>
    <p class="muted sub mono">draw {{ result.drawId }} · 共 {{ result.items.length }} 抽 · {{ result.cost.toLocaleString() }} 點</p>
    <!-- 3D 開卡舞台 -->
    <div class="stage" :style="{ height: stageHeight + 'px' }">
      <CardReveal3D :items="result.items" @revealed="revealed = true">
        <template #fallback>
          <div class="grid flat">
            <div v-for="(item, i) in result.items" :key="i" class="slot">
              <div class="face card">
                <CardArt :image="item.card.image" :alt="item.card.name" :tier="item.tier" :cert-no="item.card.certNo" />
                <div class="info"><TierBadge :tier="item.tier" /><strong>{{ item.card.name }}</strong></div>
              </div>
            </div>
          </div>
        </template>
      </CardReveal3D>
    </div>

    <!-- 明細（3D 之外仍需可讀、可複製的文字資訊） -->
    <ul class="detail" :class="{ in: revealed }">
      <li v-for="(item, i) in result.items" :key="i">
        <Tilt3D :max="12" radius="10px" class="thumb">
          <CardArt :image="item.card.image" :alt="item.card.name" :tier="item.tier" :cert-no="item.card.certNo" />
        </Tilt3D>
        <div class="meta">
          <div class="row">
            <TierBadge :tier="item.tier" />
            <span v-if="item.bonus" class="bonus">最後賞加贈</span>
            <span v-else class="mono seat">籤 #{{ item.ticketSeq }}</span>
          </div>
          <strong>{{ item.card.name }}</strong>
          <CertTag :card="item.card" />
        </div>
      </li>
    </ul>

    <div class="actions">
      <RouterLink to="/me/cards" class="btn primary">收進卡冊</RouterLink>
      <RouterLink :to="`/pools/${result.poolId}`" class="btn">再抽一次</RouterLink>
    </div>
  </div>
  <div v-else class="container page">
    <p class="muted">沒有可顯示的抽選結果。<RouterLink to="/pools">去抽選</RouterLink></p>
  </div>
</template>

<style scoped>
.page { padding-top: 40px; padding-bottom: 72px; text-align: center; }
h1 { font-size: 26px; margin: 0; }
.sub { font-size: 12.5px; margin: 6px 0 30px; }
/* 兩欄直向排列。舞台寬度要貼近「2 卡寬 : N 列高」的比例 ——
   太寬時相機會為了框住高度而後退，卡片就被推小、兩側空一大片。 */
.stage { width: 100%; max-width: 430px; margin: 8px auto 4px; }

/* fallback（無 WebGL / 減少動態）用的平面排列 */
.grid.flat { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; align-content: center; height: 100%; }
.grid.flat .slot { width: 150px; }
.grid.flat .face { padding: 8px; }
.grid.flat .info { display: grid; gap: 5px; justify-items: start; padding: 8px 2px 2px; text-align: left; }
.grid.flat .info strong { font-size: 13px; }

/* 明細清單 */
.detail {
  list-style: none; padding: 0;
  margin: 20px auto 0; max-width: 620px;
  display: grid; gap: 10px;
  opacity: 0; transform: translateY(10px);
  transition: opacity .6s ease, transform .6s cubic-bezier(.2,.7,.3,1);
}
.detail.in { opacity: 1; transform: none; }
.detail li {
  display: flex; align-items: center; gap: 14px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  text-align: left;
}
.thumb { width: 54px; flex: none; }
.meta { display: grid; gap: 5px; justify-items: start; min-width: 0; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.meta strong { font-size: 14.5px; font-weight: 600; }
.seat { font-size: 12px; color: var(--muted); }
.bonus {
  font-size: 12px; font-weight: 600;
  padding: 2px 10px; border-radius: var(--pill);
  background: var(--accent-wash); color: var(--accent);
}
.actions { display: flex; gap: 12px; justify-content: center; margin-top: 30px; }

@media (max-width: 720px) {
  .page { padding-top: 24px; padding-bottom: 40px; }
  h1 { font-size: 24px; }
  .sub { font-size: 11.5px; margin: 5px 0 14px; }
  .grid.flat { gap: 12px; }
  .grid.flat .slot { width: calc(50% - 6px); max-width: 150px; }
  .detail li { padding: 10px 12px; gap: 11px; }
  .thumb { width: 46px; }
  .meta strong { font-size: 13.5px; line-height: 1.35; }
  .actions { margin-top: 24px; }
  .actions .btn { flex: 1; padding: 11px 8px; font-size: 13.5px; }
}
</style>
