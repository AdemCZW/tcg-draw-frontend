<script setup lang="ts">
/**
 * 收藏家等級徽章。
 *
 * 等級 0 不畫任何東西：還沒登記過鑑定卡的人頭像旁邊掛一個「0 級」，
 * 讀起來像是被點名「你什麼都沒有」。
 *
 * 圖形是一枚六角盾，等級越高層次越多：
 *   1 單色描邊  2 實心  3 金色  4 金色＋內圈  5 全息漸層＋內圈
 * 用形狀層次而不是只換顏色 —— 色弱的人、以及淺色主題下金銀對比變弱時，
 * 仍然分得出高低。
 */
import { computed } from 'vue'
import { collectorLevelName } from '@/shared/collector'

const props = withDefaults(defineProps<{
  level: number
  size?: 'sm' | 'md'
  showName?: boolean
}>(), { size: 'sm', showName: true })

const name = computed(() => collectorLevelName(props.level))
</script>

<template>
  <span
    v-if="name"
    class="cb"
    :class="[`lv${props.level}`, props.size]"
    role="img"
    :aria-label="`收藏家等級 ${props.level}：${name}`"
  >
    <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient :id="`cbHolo${props.level}`" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--holo-a)" />
          <stop offset=".5" stop-color="var(--holo-b)" />
          <stop offset="1" stop-color="var(--holo-c)" />
        </linearGradient>
      </defs>
      <path class="shield" d="M12 2 20.5 7v10L12 22 3.5 17V7Z" :fill="props.level === 5 ? `url(#cbHolo${props.level})` : undefined" />
      <path v-if="props.level >= 4" class="inner" d="M12 6.5 16.8 9.3v5.4L12 17.5 7.2 14.7V9.3Z" />
      <text class="num" x="12" y="15.2" text-anchor="middle">{{ props.level }}</text>
    </svg>
    <span v-if="props.showName" class="nm">{{ name }}</span>
  </span>
</template>

<style scoped>
.cb {
  display: inline-flex; align-items: center; gap: 6px;
  min-width: 0; max-width: 100%;
  padding: 3px 10px 3px 4px;
  border: 1px solid var(--line); border-radius: var(--pill);
  background: var(--surface-2); color: var(--ink);
  font-size: 12px; font-weight: 700; line-height: 1.2;
  vertical-align: middle;
}
.cb.md { font-size: 13.5px; padding: 4px 12px 4px 5px; gap: 8px; }
.mark { width: 20px; height: 20px; flex: none; }
.cb.md .mark { width: 26px; height: 26px; }
.nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.shield { stroke-width: 1.6; stroke-linejoin: round; }
.num { font-family: var(--font-mono); font-size: 9px; font-weight: 800; }
.inner { fill: none; stroke-width: 1.2; }

/* 1：只有描邊 */
.lv1 .shield { fill: none; stroke: var(--muted); }
.lv1 .num { fill: var(--muted); }
/* 2：實心 */
.lv2 .shield { fill: var(--muted); stroke: var(--muted); }
.lv2 .num { fill: var(--surface); }
/* 3：金 */
.lv3 { border-color: color-mix(in srgb, var(--gold) 55%, var(--line)); }
.lv3 .shield { fill: var(--gold); stroke: var(--gold-deep); }
/* 4：金＋內圈 */
.lv4 { border-color: var(--gold); }
.lv4 .shield { fill: var(--gold); stroke: var(--gold-deep); }
.lv4 .inner { stroke: var(--gold-deep); }
/* 5：全息＋內圈 */
.lv5 { border-color: var(--holo-b); }
.lv5 .shield { stroke: var(--ink); }
.lv5 .inner { stroke: var(--ink); }

/* 3／4／5 級的數字：金色盾牌與全息漸層都偏亮、彼此明度又接近
   （原本 lv3/4 用 --gold-deep 疊在 --gold 上，深色主題對比只有 1.03；
   lv5 的 --ink 疊在全息漸層上，深色主題對比只有 1.3～2.3），
   換成淺色字看起來還是「差不多亮」，讀不出數字。
   --ink／--bg 這類權杖在兩套主題裡明暗會互換，沒有一支「兩套主題都是深色」，
   所以用 :global([data-theme="light"]) 分開設：
   深色主題（預設）用 --bg（近黑）疊在偏亮的金／全息底上，
   淺色主題换成 --ink（該主題下同樣近黑），兩邊都量到 ≥ 4.5:1。 */
.lv3 .num, .lv4 .num, .lv5 .num { fill: var(--bg); }
:global([data-theme="light"]) .lv3 .num,
:global([data-theme="light"]) .lv4 .num,
:global([data-theme="light"]) .lv5 .num { fill: var(--ink); }
</style>
