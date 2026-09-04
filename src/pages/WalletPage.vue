<script setup lang="ts">
import { onMounted } from 'vue'
import { useWalletStore } from '@/stores/wallet'

const wallet = useWalletStore()
/* loadLedger() 自己不會 reject（見 stores/wallet.ts 的說明）——
   這裡刻意保持開火即忘，失敗由 wallet.ledgerErr 在畫面上講出來。
   以前這一行的例外會變成「mounted hook 未捕捉」，整棵元件樹當場被摧毀。 */
onMounted(() => { wallet.loadLedger() })

const typeLabel: Record<string, string> = {
  topup: '儲值', draw: '抽選', refund: '退點', recycle: '回收', redeem: '兌換', trade: '交易'
}
</script>

<template>
  <div class="container page">
    <h1>錢包</h1>
    <div class="balances">
      <div class="bal card">
        <span class="muted">點數</span>
        <strong class="mono gold">{{ wallet.shown.toLocaleString() }}</strong>
        <RouterLink :to="{ name: 'topup' }" class="btn primary sm">儲值</RouterLink>
      </div>
    </div>
    <h2>交易紀錄</h2>
    <!-- 讀不到帳本要說「讀不到」，不能畫成一本空帳本 ——
         後端冷啟動要 20 秒是常態，而「你還沒有任何交易紀錄」跟
         「這一刻問不到」對剛儲值完的人是完全相反的兩件事。
         版型沿用大廳與出貨頁那一套：訊息＋一顆重試鈕。 -->
    <div v-if="wallet.ledgerErr" class="loadFail card" role="alert">
      <p class="muted">{{ wallet.ledgerErr }}</p>
      <button type="button" class="btn" @click="wallet.loadLedger()" :disabled="wallet.ledgerLoading">
        {{ wallet.ledgerLoading ? '重試中…' : '重試' }}
      </button>
    </div>
    <div v-else class="ledger card">
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
/* 碎片移除後只剩點數一張卡。固定兩欄會把它拉滿整行、
   26px 的數字孤零零浮在一大片留白裡，所以改成自然寬度加上限。 */
.balances { display: grid; gap: 14px; max-width: 320px; }
.bal { padding: 18px; display: grid; gap: 8px; justify-items: start; }
.bal strong { font-size: 26px; }
.gold { color: var(--gold); }
/* 儲值是這一頁唯一的行動鍵，44px 是手指按得到的下限 —— 原本 34px 高，
   在 393px 的手機上就是「看得到但常常按不準」。 */
.btn.sm { padding: 6px 14px; font-size: 12.5px; min-height: 44px; }

/* 載入失敗：跟大廳、出貨頁同一套（訊息置中＋一顆重試鈕），
   不另外發明一種錯誤態。min-width: 0 讓長訊息不撐破容器。 */
.loadFail {
  min-width: 0;
  display: grid; justify-items: center; gap: 12px;
  padding: 32px 16px; text-align: center;
}
.loadFail p { margin: 0; }
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
  .entry { grid-template-columns: auto 1fr auto; }
  .after, .at { display: none; }
}
</style>
