<script setup lang="ts">
/**
 * 無限捲動列表的末端。
 *
 * 這個元素同時是三件事：IntersectionObserver 要觀察的哨兵、載入中的指示、
 * 以及失敗時的重試出口。做成一個元件是因為三頁都需要，而且「載入失敗要能重試」
 * 最容易被漏掉 —— 靜靜地停住的列表看起來就只是「沒有更多了」。
 *
 * 把它放在格線的**外面**當兄弟節點，不要塞進 grid 裡：grid 子元素預設是
 * min-width: auto，一段長訊息會撐出一欄的寬度，整個格線跟著變形
 * （這個 repo 的手機跑版有一半是這樣來的）。
 */
defineProps<{
  loading: boolean
  done: boolean
  error: string
  /** 沒有 IntersectionObserver 的環境要給一顆手動按鈕，不然列表停在第一頁 */
  manual: boolean
  /** 全部載完時的收尾文字。列表本來就空的時候由頁面自己畫空狀態，這裡不出現 */
  doneText?: string
  /** 目前列表是不是空的 —— 空列表不需要「已經到底了」這種收尾 */
  empty?: boolean
}>()

defineEmits<{ retry: []; more: [] }>()
</script>

<template>
  <div class="end" aria-live="polite">
    <p v-if="loading" class="load">
      <span class="ring" aria-hidden="true"></span>
      <span>載入中</span>
    </p>

    <div v-else-if="error" class="fail" role="alert">
      <p class="failMsg">{{ error }}</p>
      <button type="button" class="btn sm" @click="$emit('retry')">重新載入</button>
    </div>

    <button v-else-if="manual && !done" type="button" class="btn sm" @click="$emit('more')">
      載入更多
    </button>

    <p v-else-if="done && !empty && doneText" class="tail muted">{{ doneText }}</p>
  </div>
</template>

<style scoped>
/* min-width: 0 是保險絲：這一塊之後若被放進 grid 或 flex，
   預設的 min-width: auto 會讓裡面的長訊息把版面撐破 */
.end {
  min-width: 0;
  /* 沒有任何內容時仍然要佔一點高度，否則哨兵貼在最後一張卡的邊緣，
     IntersectionObserver 觀察一個 0 高度的元素在某些瀏覽器上不會回呼 */
  min-height: 24px;
  display: grid; justify-items: center; gap: 10px;
  padding: 18px 0 8px;
  text-align: center;
}

.load {
  display: inline-flex; align-items: center; gap: 9px;
  margin: 0; font-size: 12.5px; color: var(--muted);
}
.ring {
  flex: none;
  width: 15px; height: 15px;
  border-radius: 50%;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
}
@media (prefers-reduced-motion: no-preference) {
  .ring { animation: spin .7s linear infinite; }
}
@keyframes spin { to { transform: rotate(360deg); } }

.fail { display: grid; justify-items: center; gap: 9px; min-width: 0; }
.failMsg {
  margin: 0; font-size: 12.5px; line-height: 1.6;
  color: var(--danger);
  /* 錯誤訊息可能很長（後端的 message 是給人看的整句話），
     限寬並允許任意處斷行，不要讓它把頁面推出視窗 */
  max-width: 30em; overflow-wrap: anywhere;
}
.tail { margin: 0; font-size: 11.5px; letter-spacing: .02em; }
</style>
