<script setup lang="ts">
/**
 * 交易保護的一行摘要。
 *
 * 原本這裡是一整塊：標題、兩張並排的通道說明卡（庫內轉移 / 需寄送）、
 * 再加一個裝著完整規則的 <details>。問題是那兩點在同一頁已經講過兩次 ——
 * 每張卡圖上有「庫內／需寄送」徽章，按下購買時的確認框又針對該筆
 * 講一次錢會怎麼流。第三次講不會讓人更懂，只會把商品往下推一整屏。
 *
 * 規則出現在它真正有用的時刻，這個原則沒有變，只是「有用的時刻」不是
 * 逛列表的時候，而是按下購買的那一刻 —— 那裡本來就有針對該筆的說明。
 * 這裡只留一句承諾，完整條文交給 /trade-protection 那一頁
 * （那頁是後來才做的，做完之後這裡的 <details> 就變成重複維護的第二份）。
 */
defineProps<{ open?: boolean }>()
</script>

<template>
  <RouterLink class="guard" :to="{ name: 'trade-protection' }">
    <span class="shield" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z" /></svg>
    </span>
    <span class="txt">
      <b>交易保護</b>
      錢先鎖在平台，賣家收不到；出問題退你點數
    </span>
    <span class="go" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" /></svg>
    </span>
  </RouterLink>
</template>

<style scoped>
.guard {
  display: flex; align-items: center; gap: 11px;
  padding: 11px 14px; margin-bottom: 14px;
  border: 1px solid var(--line-soft); border-radius: 14px;
  background: var(--surface);
  color: var(--ink); text-decoration: none;
}
@media (hover: hover) { .guard:hover { background: var(--surface-2); } }

.shield {
  flex: none; display: grid; place-items: center;
  width: 32px; height: 32px; border-radius: 10px;
  background: color-mix(in srgb, var(--ok, #16825a) 18%, transparent);
  color: var(--ok, #16825a);
}
.shield svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linejoin: round; }

/* 標題與說明同一行流動：手機上窄了自然折成兩行，
   不必為了「標題一行、說明一行」再多一層容器與間距 */
.txt { flex: 1; min-width: 0; font-size: 12.5px; line-height: 1.55; color: var(--muted); }
.txt b { display: inline; margin-right: 6px; font-size: 13.5px; color: var(--ink); }

.go { flex: none; color: var(--faint); }
.go svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
</style>
