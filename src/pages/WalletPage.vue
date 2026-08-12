<script setup lang="ts">
import { onMounted } from 'vue'
import { useWalletStore } from '@/stores/wallet'

const wallet = useWalletStore()
onMounted(() => wallet.loadLedger())

const typeLabel: Record<string, string> = {
  topup: '儲值', draw: '抽選', refund: '退點', recycle: '回收', redeem: '兌換'
}
</script>

<template>
  <div class="container page">
    <h1>錢包</h1>
    <div class="balances">
      <div class="bal card">
        <span class="muted">點數</span>
        <strong class="mono gold">{{ wallet.points.toLocaleString() }}</strong>
        <RouterLink to="/topup" class="btn primary sm">儲值</RouterLink>
      </div>
      <div class="bal card">
        <span class="muted">碎片</span>
        <strong class="mono holo-text">{{ wallet.shards.toLocaleString() }}</strong>
        <span class="chip">僅可兌換商品</span>
      </div>
    </div>
    <h2>交易紀錄</h2>
    <div class="ledger card">
      <div v-for="e in wallet.ledger" :key="e.id" class="entry">
        <span class="chip">{{ typeLabel[e.type] }}</span>
        <span class="note">{{ e.note }}</span>
        <span class="mono delta" :class="e.delta > 0 ? 'pos' : 'neg'">{{ e.delta > 0 ? '+' : '' }}{{ e.delta.toLocaleString() }}</span>
        <span class="mono muted after">餘 {{ e.balanceAfter.toLocaleString() }}</span>
        <span class="mono muted at">{{ e.createdAt }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding-top: 36px; padding-bottom: 72px; max-width: 760px; }
h1 { font-size: 22px; margin: 0 0 18px; }
h2 { font-size: 15px; color: var(--muted); margin: 26px 0 10px; }
.balances { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.bal { padding: 18px; display: grid; gap: 8px; justify-items: start; }
.bal strong { font-size: 26px; }
.gold { color: var(--gold); }
.holo-text { background: var(--holo); -webkit-background-clip: text; background-clip: text; color: transparent; }
.btn.sm { padding: 6px 14px; font-size: 12.5px; }
.entry {
  display: grid; grid-template-columns: auto 1fr auto auto auto;
  gap: 12px; align-items: center;
  padding: 11px 16px; border-bottom: 1px solid var(--line-soft);
  font-size: 13px;
}
.entry:last-child { border-bottom: 0; }
.delta.pos { color: var(--ok); }
.delta.neg { color: var(--muted); }
.after, .at { font-size: 12px; }
@media (max-width: 640px) {
  .balances { grid-template-columns: 1fr; }
  .entry { grid-template-columns: auto 1fr auto; }
  .after, .at { display: none; }
}
</style>
