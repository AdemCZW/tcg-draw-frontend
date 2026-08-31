<script setup lang="ts">
/**
 * 「這是你上架的」標記。
 *
 * 為什麼抽成元件而不是各處寫一顆 span：市場列表有三種完全不同形狀的卡片
 * （今日最殺的小方塊、已鑑定的橫式寬卡、全部掛單的滿版格），加上單張頁 ——
 * 四個地方如果各自長得不一樣，使用者要學四次「哪個顏色代表我的」。
 * 一眼認得出來的前提是「每次都長同一個樣」。
 *
 * 顏色刻意不用 --accent：強調色在這一頁已經是「買下」那顆鍵的顏色，
 * 拿同一個紅色去標「這張你不能買」會把兩件相反的事講成同一件。
 * --info-ink 在深淺兩套主題都是藍的，跟紅（買）、綠（庫內）、金（鑑定）都分得開。
 * 字色用 --bg：深色主題是近黑字壓亮藍、淺色主題是近白字壓深藍，
 * 兩邊都是高對比，不必寫死 #fff 再祈禱。
 *
 * 圖示是 inline SVG（手機 UI 不放 emoji）。
 */
withDefaults(defineProps<{
  /** 標籤文字。小尺寸的卡片放不下完整句子，由呼叫端決定講多少 */
  label?: string
  /** 緊湊版：給 104px 寬的小方塊用，字級與內距都再收一階 */
  compact?: boolean
}>(), { label: '我的掛單', compact: false })
</script>

<template>
  <span class="omark" :class="{ tight: compact }">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.4 19.3c1.2-3.4 3.7-5.1 6.6-5.1s5.4 1.7 6.6 5.1" />
    </svg>
    <span class="otext">{{ label }}</span>
  </span>
</template>

<style scoped>
/* inline-flex + min-width: 0：這顆會被塞進 grid / flex 的子欄位裡，
   少了 min-width: 0 的話長標籤會把整欄（連同整格卡片）撐開 */
.omark {
  display: inline-flex; align-items: center; gap: 5px;
  min-width: 0; max-width: 100%;
  padding: 3px 8px;
  border-radius: var(--pill);
  background: var(--info-ink);
  color: var(--bg);
  font-size: 10.5px; font-weight: 700; line-height: 1.2;
  letter-spacing: .02em;
  /* 疊在卡圖上時要跟底下的圖分得開 */
  box-shadow: var(--shadow-sm);
}
.omark svg {
  flex: none;
  width: 11px; height: 11px;
  fill: none; stroke: currentColor; stroke-width: 2.2;
  stroke-linecap: round; stroke-linejoin: round;
}
/* 標籤本身不換行、必要時截斷 —— 它是輔助標示，不該把卡片撐高 */
.otext { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.tight { padding: 2px 6px; gap: 3px; font-size: 9.5px; }
.tight svg { width: 9px; height: 9px; stroke-width: 2.6; }
</style>
