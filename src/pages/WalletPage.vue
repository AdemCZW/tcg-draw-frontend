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
    <!-- 一個「點數」是不夠的：那個數字是含凍結的總額，而使用者拿去市場買東西時
         被檢查的是可動用（wallet.canAfford 用 points - locked）。
         兩者差很多的人（例如 5 萬裡有 4 萬凍結在託管）會看到錢包說 5 萬、
         結帳說餘額不足，而這一頁沒有任何線索解釋那 4 萬去哪了。
         拆成兩個數字，措辭跟訂單頁那條錢包列一致（可動用／託管中），
         同一組概念在站上只用一種叫法。
         用 shown - locked 而不是 wallet.available：available 直接讀 points，
         訪客會看到 mock 種的那一億點（見 stores/wallet.ts 的 shown）。 -->
    <div class="balances">
      <div class="bal card">
        <span class="muted">可動用</span>
        <strong class="mono gold">{{ (wallet.shown - wallet.locked).toLocaleString() }}</strong>
        <RouterLink :to="{ name: 'topup' }" class="btn primary sm">儲值</RouterLink>
      </div>
      <div class="bal card">
        <span class="muted">託管中</span>
        <strong class="mono lock">{{ wallet.locked.toLocaleString() }}</strong>
        <p class="bhint">交易與出價結案前不能動用，錢還是你的。</p>
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
    <!-- 載入成功但一筆都沒有：也要有一句話。一張什麼都沒有的卡片跟
         「壞掉了」在畫面上長得一模一樣，而這裡兩種狀態已經分得出來了
         （ledgerErr 走上面那一塊），空的就直說是空的。 -->
    <p v-else-if="wallet.ledgerLoaded && !wallet.ledger.length" class="blank card muted">
      還沒有任何交易紀錄。儲值、抽選、回收與交易的每一筆金額變動都會記在這裡。
    </p>
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
/* 可動用與託管中並排：這兩個數字要一起讀才有意義（「總共有多少」是它們的和），
   拆成上下兩張卡就變成兩件不相干的事。窄螢幕也維持兩欄 —— 訂單頁那條
   錢包列同樣是兩欄，兩頁的同一組數字不該長得不一樣。 */
.balances { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; max-width: 520px; }
.bal { padding: 18px; display: grid; gap: 8px; justify-items: start; align-content: start; }
.bal strong { font-size: 26px; }
.gold { color: var(--gold); }
/* 託管中用跟訂單頁同一個金色，讓兩頁的「這筆錢被鎖著」是同一個顏色 */
.bal .lock { color: var(--gold); }
.bhint { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--muted); }

/* 空帳本：跟載入失敗同一個尺寸，兩種狀態切換時卡片高度不會跳 */
.blank { margin: 0; padding: 32px 16px; font-size: 13px; line-height: 1.8; text-align: center; }
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
