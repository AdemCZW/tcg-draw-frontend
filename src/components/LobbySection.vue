<script setup lang="ts">
/**
 * 大廳分區的標頭。
 *
 * 抽出來的原因不是為了少寫幾行 CSS，是為了讓「層級」變成一個可宣告的東西。
 * 舊版四個區塊的標頭長得一模一樣（彩色小圓點 + 17px 標題 + 灰字註解），
 * 於是滑下來每一段都像同一段 —— 使用者抱怨的「看不出重點」有一半出在這裡。
 *
 * 現在標頭自己要帶三樣資訊：
 *  1. tone   這一段是哪一種東西（緊迫 / 目錄 / 別的地方），決定色相與飾條
 *  2. count  區塊本身的數據。標題旁邊直接寫「7 池」「-14%」，
 *            比註解那行小灰字更早被讀到，也讓兩個區塊一眼就不一樣
 *  3. note   一句話講清楚「為什麼這些被放在一起」
 *
 * 註解只是補充；重點必須由 title + count 講完。
 */
type Tone = 'urgent' | 'catalog' | 'market'

withDefaults(defineProps<{
  title: string
  /** 標題右側的數據籤，例如「7 池」。沒有就不顯示 */
  count?: string
  note?: string
  tone?: Tone
}>(), { count: undefined, note: undefined, tone: 'catalog' })
</script>

<template>
  <header class="sh" :class="tone">
    <div class="row">
      <!-- 飾條取代舊版的小圓點：圓點太小，四個並排時只是四個雜訊點。
           一條有高度的直條會跟標題一起被當成同一個視覺單位。 -->
      <span class="tick" aria-hidden="true"></span>
      <h2>{{ title }}</h2>
      <span v-if="count" class="count mono">{{ count }}</span>
      <span class="spacer"></span>
      <slot name="action" />
    </div>
    <p v-if="note" class="note">{{ note }}</p>
  </header>
</template>

<style scoped>
.sh { margin-bottom: 14px; }
.row { display: flex; align-items: center; gap: 9px; }
.spacer { flex: 1 1 auto; }

.tick {
  flex: none; width: 3px; height: 17px; border-radius: 2px;
  background: var(--sh-hue);
}
h2 {
  margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -.015em;
  line-height: 1.2;
}
/* 數據籤：標題的一部分，不是註解。用底色圈起來讓它有重量 ——
   這是整個標頭裡唯一會隨資料變動的東西，值得被看見。 */
.count {
  flex: none;
  font-size: 11.5px; font-weight: 700; letter-spacing: .04em;
  padding: 3px 9px; border-radius: var(--pill);
  /* 字色往 --ink 拉 28%，不直接用色相原色。
     色相是為了「在底色上看得見」挑的，不是為了「當小字」挑的：
     淺色主題下 #e0453a 配淡紅底只有 3.5:1，11.5px 的字讀起來會發虛。
     混 ink 在兩套主題都往正確方向走（淺色變深、深色變亮），
     色相保留 72% 仍然一眼看得出是紅／綠。 */
  color: color-mix(in srgb, var(--sh-hue) 72%, var(--ink));
  background: color-mix(in srgb, var(--sh-hue) 15%, transparent);
}
/* 註解降到跟標題明顯不同的層級：換行、縮排對齊標題、字級收到 12px。
   舊版跟標題同一行且 baseline 對齊，兩者搶同一個位置。 */
.note {
  margin: 6px 0 0 12px;
  font-size: 12.5px; line-height: 1.45; color: var(--muted);
  max-width: 46ch;
}

/* 三種語氣各自的色相。整段的底色、飾條、數據籤共用同一個變數，
   換一個 tone 就整段換色，不必分別維護。 */
.urgent  { --sh-hue: var(--danger); }
.catalog { --sh-hue: var(--ink); }
.market  { --sh-hue: var(--ok); }

/* 目錄段的標題要最大：它是這一頁的主體，前面兩段都是它的入口。 */
.catalog h2 { font-size: 22px; }
.catalog .count { color: var(--muted); background: var(--surface-2); }

@media (max-width: 720px) {
  h2 { font-size: 17px; }
  .catalog h2 { font-size: 20px; }
  .note { font-size: 12px; margin-left: 12px; }
}
</style>
