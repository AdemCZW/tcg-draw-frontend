<script setup lang="ts">
/**
 * 「頁面程式碼載不到」時的提示條。
 *
 * 為什麼是提示而不是直接重整（決定寫在 lib/chunk-recovery.ts 的檔頭）：
 * 這個錯誤發生在**使用者按下某個連結、要離開目前這一頁的那一刻**，
 * 而他當下所在的頁面很可能有還沒送出的輸入（開池表單、登記卡片、
 * 客服表單），訓練家卡的成品頁更是離開就永久消失。無預警重整
 * 等於替他按下「放棄」。所以由他自己按。
 *
 * 這個元件**刻意不 lazy-load**：它是「chunk 載不到」時唯一還能出現的
 * 東西，自己再走一次動態載入就會跟著失敗，等於沒有救援。
 * 它由 lib/chunk-recovery.ts 用 createApp 掛在 body 上，不進 App.vue ——
 * 救援路徑不該依賴任何一個頁面元件有沒有掛好。
 *
 * 沒有 emoji（全站規則）；按鈕高度 44px 起跳；顏色一律走 tokens.css，
 * 深淺兩套主題都由權杖自己解決，這裡不寫任何寫死的顏色。
 */
type Kind = 'update' | 'offline' | 'failed'
const props = defineProps<{ kind: Kind }>()
defineEmits<{ reload: []; dismiss: [] }>()

/* 三種情況的文案。分開寫而不是拼字串 ——
   使用者要判斷的是「我現在該做什麼」，三種情況該做的事完全不同。 */
const COPY: Record<Kind, { title: string; body: string; ok: string | null; close: string }> = {
  update: {
    title: '網站剛更新',
    body: '這個頁面的程式已經換成新版本，重新載入就能繼續。目前畫面上還沒送出的輸入不會保留。',
    ok: '重新載入',
    close: '稍後再說'
  },
  offline: {
    title: '目前沒有網路連線',
    /* 離線時重整只會換來一頁瀏覽器的錯誤畫面，比留在原地更糟 —— 所以不給重整鍵 */
    body: '這個頁面還沒下載到裝置上，連上網路後再試一次就能開啟。',
    ok: null,
    close: '知道了'
  },
  failed: {
    title: '頁面載入失敗',
    /* 已經重整過一次仍然失敗：不再提供重整，否則就是無限迴圈 */
    body: '重新載入之後還是拿不到這個頁面的程式，可能是網路或伺服器暫時有問題。請稍後再試一次。',
    ok: null,
    close: '知道了'
  }
}
const copy = COPY[props.kind]
</script>

<template>
  <!-- alertdialog：它需要使用者做決定，但不擋住整個畫面（沒有遮罩）——
       使用者本來就在的那一頁仍然可用，包含他還沒存的輸入 -->
  <div class="wrap" role="alertdialog" aria-labelledby="cr-title" aria-describedby="cr-body">
    <div class="card">
      <p id="cr-title" class="title">{{ copy.title }}</p>
      <p id="cr-body" class="body">{{ copy.body }}</p>
      <div class="row">
        <button v-if="copy.ok" class="btn primary" type="button" @click="$emit('reload')">
          {{ copy.ok }}
        </button>
        <button class="btn ghost" type="button" @click="$emit('dismiss')">{{ copy.close }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 貼在畫面下緣。--nav-total 是底部固定導覽的高度權杖（桌機是 0），
   讓提示條停在導覽上面而不是被它壓住。 */
.wrap {
  position: fixed; z-index: 90;
  left: 0; right: 0; bottom: calc(var(--nav-total) + 12px);
  display: flex; justify-content: center;
  padding: 0 12px;
  /* 提示條本身要能點，但不要在它兩側擋住底下的頁面 */
  pointer-events: none;
}
.card {
  pointer-events: auto;
  width: 100%; max-width: 420px;
  padding: 16px 16px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-2);
  box-shadow: var(--shadow-lg);
}
.title { margin: 0 0 6px; font-size: 15px; font-weight: 600; color: var(--ink); }
.body { margin: 0 0 12px; font-size: 13px; line-height: 1.6; color: var(--muted); }

.row { display: flex; gap: 8px; }
.btn {
  flex: 1;
  /* 觸控目標下限 44px */
  min-height: 44px; padding: 0 14px;
  border-radius: var(--pill);
  font: inherit; font-size: 14px; font-weight: 600;
  cursor: pointer;
}
.btn.primary { border: 0; background: var(--accent); color: var(--on-accent); }
.btn.ghost { border: 1px solid var(--line); background: transparent; color: var(--muted); }
@media (hover: hover) {
  .btn.primary:hover { background: var(--accent-soft); }
  .btn.ghost:hover { background: var(--surface-3); }
}
</style>
