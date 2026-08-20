<script setup lang="ts">
// 儲值頁：金額彈性（競品痛點——固定面額卡零頭）
// 正式版：建立 payment → 綠界跳轉 → callback 後入點
import { ref } from 'vue'
import { useWalletStore } from '@/stores/wallet'
import { track } from '@/lib/ga'

const wallet = useWalletStore()
const presets = [300, 500, 1000, 3000]
import { MOCK } from '@/lib/config'
const amount = ref<number>(500)
const done = ref(false)

function pick(v: number) { amount.value = v }
function pay() {
  track('click_topup')
  if (!MOCK) return   // 金流還沒接，點數由平台發放；按鈕在模板裡已停用
  if (amount.value < 100) { track('topup_failed'); return }
  // mock：直接入點；正式版導向綠界
  wallet.topup(amount.value)
  track('topup_success')
  done.value = true
  setTimeout(() => (done.value = false), 2400)
}
</script>

<template>
  <div class="container page">
    <h1>儲值</h1>
    <!-- 金流還沒接（需要跟供應商談合作）；測試期點數由平台發放 -->
    <div v-if="!MOCK" class="card box">
      <p class="notice">
        測試期間<strong>點數由平台發放</strong>，尚未開放自行儲值。
        需要點數請聯繫平台，發放後會直接出現在你的錢包與帳本。
      </p>
      <RouterLink :to="{ name: 'wallet' }" class="btn">回錢包</RouterLink>
    </div>
    <div v-else class="card box">
      <div class="presets">
        <button v-for="v in presets" :key="v" class="btn" :class="{ on: amount === v }" @click="pick(v)">
          {{ v.toLocaleString() }}
        </button>
      </div>
      <label class="lbl" for="amt">或自訂金額（100 起，1 元 = 1 點）</label>
      <input id="amt" type="number" v-model.number="amount" min="100" step="1" class="mono" />
      <button class="btn primary go" @click="pay">前往付款 {{ amount.toLocaleString() }} 元</button>
      <p class="muted fine">綠界金流付款 · 開立電子發票，可設定手機載具或統一編號</p>
      <p v-if="done" class="ok" role="status">已入點（mock）</p>
    </div>
  </div>
</template>

<style scoped>
.page { padding-top: 40px; padding-bottom: 72px; max-width: 460px; }
h1 { font-size: 22px; margin: 0 0 18px; }
.box { padding: 22px; display: grid; gap: 14px; }
/* 三處 min-width: 0 缺一不可，否則 320px 上這排會整個溢出到畫面外。
   1fr 等同 minmax(auto, 1fr)，每一欄都壓不到比「3,000」這顆按鈕的
   固有寬度更窄；而 .presets 自己是 .box（grid）的子元素，預設
   min-width: auto 讓它也不肯縮。實測 320 螢幕上容器只有 278，
   .presets 卻是 364，右邊直接被切掉 86px（連「3,000」整顆看不到）。 */
.presets { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; min-width: 0; }
.presets .btn { min-width: 0; padding-inline: 4px; }
.btn.on { border-color: var(--gold); color: var(--gold); }
.lbl { font-size: 13px; color: var(--muted); }
input {
  background: var(--field); color: var(--text);
  border: 1px solid var(--line); border-radius: 8px;
  padding: 11px 14px; font-size: 16px;
}
input:focus-visible { outline: 2px solid var(--holo-a); }
.go { padding: 13px 0; font-size: 15px; }
.fine { font-size: 12px; margin: 0; }
.ok { color: var(--ok); margin: 0; }
.notice { margin: 0; font-size: 14.5px; line-height: 1.8; color: var(--muted); }
.notice strong { color: var(--ink); }
</style>
