<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/lib/api'
import type { UserPrize } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import Tilt3D from '@/components/Tilt3D.vue'
import TierBadge from '@/components/TierBadge.vue'
import CertTag from '@/components/CertTag.vue'
import { track } from '@/lib/ga'

const prizes = ref<UserPrize[]>([])
onMounted(async () => { prizes.value = await api.myPrizes() })

const statusLabel: Record<UserPrize['status'], string> = {
  stashed: '寄存中',
  ship_requested: '待出貨',
  shipped: '已出貨',
  recycled: '已回收'
}

function requestShip(p: UserPrize) {
  track('click_ship_request')
  p.status = 'ship_requested'
  track('ship_request_success')
}
function recycle(p: UserPrize) {
  track('click_recycle')
  p.status = 'recycled'
  track('recycle_success')
}
</script>

<template>
  <div class="container page">
    <h1>我的卡冊</h1>
    <p class="muted note">寄存中的卡可合併出貨（省運費），寄存期限 90 天。</p>
    <div v-if="!prizes.length" class="empty card">
      <p>卡冊還是空的。</p>
      <RouterLink to="/pools" class="btn primary">去抽第一張</RouterLink>
    </div>
    <div class="grid">
      <div v-for="p in prizes" :key="p.id" class="item card" :class="{ dim: p.status === 'recycled' }">
        <Tilt3D :max="14">
          <CardArt :image="p.card.image" :alt="p.card.name" :tier="p.tier" :cert-no="p.card.certNo" :caption="`${p.card.setCode.toUpperCase()} · ${p.card.cardNo}`" />
        </Tilt3D>
        <div class="body">
          <div class="row"><TierBadge :tier="p.tier" /><span class="chip">{{ statusLabel[p.status] }}</span></div>
          <strong>{{ p.card.name }}</strong>
          <CertTag :card="p.card" />
          <span class="mono muted exp" v-if="p.status === 'stashed'">寄存至 {{ p.stashExpiresAt }}</span>
          <div class="acts" v-if="p.status === 'stashed'">
            <button class="btn primary sm" @click="requestShip(p)">申請出貨</button>
            <button class="btn sm" @click="recycle(p)">回收成碎片</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding-top: 36px; padding-bottom: 72px; }
h1 { font-size: 22px; margin: 0 0 6px; }
.note { font-size: 13px; margin: 0 0 22px; }
.empty { padding: 40px; text-align: center; display: grid; gap: 12px; justify-items: center; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 18px; }
.item { padding: 12px; }
.item.dim { opacity: .5; }
.body { display: grid; gap: 8px; padding: 12px 4px 4px; justify-items: start; }
.row { display: flex; gap: 8px; align-items: center; }
strong { font-size: 14px; }
.exp { font-size: 11.5px; }
.acts { display: flex; gap: 8px; margin-top: 4px; }
.btn.sm { padding: 6px 12px; font-size: 12.5px; }

@media (max-width: 720px) {
  .page { padding-top: 22px; padding-bottom: 40px; }
  h1 { font-size: 19px; }
  .note { font-size: 12px; margin: 0 0 16px; }
  .grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .item { padding: 8px; }
  .body { gap: 6px; padding: 9px 2px 2px; }
  .row { flex-wrap: wrap; gap: 5px; }
  strong { font-size: 12.5px; line-height: 1.35; }
  .exp { font-size: 10.5px; }
  /* 半寬放不下並排按鈕。grid 的水平拉伸要用 justify-self（align-self 是垂直軸） */
  .acts { flex-direction: column; justify-self: stretch; gap: 6px; }
  .btn.sm { width: 100%; padding: 9px 6px; font-size: 12px; }
}
</style>
