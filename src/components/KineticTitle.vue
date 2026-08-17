<script setup lang="ts">
/**
 * 動態標題 —— 逐字元的定格式揭示。
 *
 * 這不是「字體 + fade in」。動態設計的標題之所以看起來是設計過的，是因為
 * 好幾個手法疊在一起、而且有明確的節奏。這裡用的六層（參考動態圖形常見的
 * title reveal 做法）：
 *
 *   1 逐字元切分，每個字自己的延遲（stagger）—— 節奏的來源
 *   2 遮罩升起：每個字裝在 overflow:hidden 的槽裡，從槽底浮上來，
 *     所以看起來是「從一條看不見的線後面出現」，不是憑空淡入
 *   3 模糊到清晰：進場帶 blur，像鏡頭對焦
 *   4 3D 傾倒：rotateX 從躺平轉正，給厚度
 *   5 過衝定格：緩動曲線超過 1 再回彈，字會「咬」進定位 —— 這是「機械鎖定」
 *     的感覺來源，也是整支動畫最關鍵的一拍
 *   6 色差分離：定格那一瞬間紅／青兩份副本錯開再收回，一格的殘影
 *   收尾再掃一道光。
 *
 * 可及性：切開的字元對讀屏是雜訊（會逐字唸），所以整組 aria-hidden，
 * 真正的文字用 sr-only 放一份。
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  /** 每一行的文字 */
  lines: string[]
  /** 每個字元之間的間隔（毫秒） */
  stagger?: number
  /** 整體延遲（毫秒） */
  delay?: number
  /** 給讀屏的完整句子，不給就用 lines 串起來 */
  label?: string
}>(), { stagger: 42, delay: 0, label: undefined })

/** 切成字元，同時記錄全域序號 —— 跨行連續才有一條走過去的節奏 */
const rows = computed(() => {
  let n = 0
  return props.lines.map(line => ({
    text: line,
    chars: [...line].map((ch, k) => ({ ch, i: ch === ' ' ? -1 : n++, p: line.length > 1 ? k / (line.length - 1) : 0 }))
  }))
})
const srText = computed(() => props.label ?? props.lines.join(' '))
</script>

<template>
  <div class="kt">
    <span class="sr-only">{{ srText }}</span>
    <div
      v-for="(row, r) in rows" :key="r"
      class="ktRow" :class="`r${r}`"
      aria-hidden="true"
    >
      <!-- 每個字一個「槽」，字從槽底升上來 -->
      <span
        v-for="(c, k) in row.chars" :key="k"
        class="slot"
        :class="{ space: c.ch === ' ' }"
      >
        <span
          class="ch"
          :style="{ '--d': (delay + (c.i < 0 ? 0 : c.i) * stagger) + 'ms', '--p': c.p }"
          :data-ch="c.ch"
        >{{ c.ch === ' ' ? ' ' : c.ch }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.kt { display: grid; justify-items: center; gap: .18em; }

/* 不換行：標題斷在奇怪的地方（例如 DRAW 的 W 自己掉一行）比字小一點糟得多。
   要塞不下就靠外層調字級，不要靠折行。 */
.ktRow {
  display: flex; flex-wrap: nowrap; justify-content: center;
  line-height: 1;
  white-space: nowrap;
}

/* 槽：把字裁掉，字才會像從一條線後面冒出來 */
.slot {
  display: inline-block;
  overflow: hidden;
  /* 上下多留一點，避免字母的上伸部與下伸部被裁到 */
  padding: .12em .012em .16em;
  margin: -.12em 0 -.16em;
  perspective: 420px;
}
/* 空白也要吃字距 —— 字距拉寬時，固定寬的空白會被相對壓縮，
   整行就變成 BEFORETHEDRAW 看不出斷詞 */
.slot.space { width: calc(.34em + 1em * 0.16); }

.ch {
  display: inline-block;
  transform-origin: 50% 100%;
  will-change: transform, opacity, filter;
}

/* ---- 進場：升起 + 對焦 + 轉正 + 過衝定格 ---- */
@media (prefers-reduced-motion: no-preference) {
  /* 色差分離：兩份彩色副本在定格那一拍錯開再收回 */
  .ch::before,
  .ch::after {
    content: attr(data-ch);
    position: absolute; left: 0; top: 0;
    pointer-events: none;
    animation: ktSplit 900ms cubic-bezier(.16, 1.36, .3, 1) var(--d) both;
  }
  .ch::before { color: #ff3b6b; mix-blend-mode: screen; }
  .ch::after  { color: #35e8ff; mix-blend-mode: screen; --dir: -1; }
  .ch { position: relative; }
}

@keyframes ktRise {
  0%   { transform: translateY(115%) rotateX(-72deg) scale(.94); }
  62%  { transform: translateY(-7%) rotateX(6deg) scale(1.03); }   /* 過衝 */
  100% { transform: translateY(0) rotateX(0deg) scale(1); }
}
@keyframes ktFocus {
  0%   { opacity: 0; filter: blur(11px); }
  55%  { opacity: 1; filter: blur(1.5px); }
  100% { opacity: 1; filter: blur(0); }
}
/* 只在中段可見 —— 定格前後都要是乾淨的字，殘影只有一瞬間 */
@keyframes ktSplit {
  0%, 100% { opacity: 0; transform: translate(0, 0); }
  48%      { opacity: .8; transform: translate(calc(var(--dir, 1) * .06em), calc(var(--dir, 1) * -.02em)); }
  76%      { opacity: .35; transform: translate(calc(var(--dir, 1) * .02em), 0); }
  92%      { opacity: 0; transform: translate(0, 0); }
}

/* ---- 填色與掃光 ----
   漸層必須掛在 .ch 自己身上，不能掛在 .ktRow 讓它裁到子孫的字。
   原因：.ch 有 filter（模糊對焦），filter 會讓它自成一個算繪層，
   祖先的 background-clip: text 就抓不到這些字了 —— 整行會變成透明，
   標題整個不見。掛在同一個元素上就沒有跨層的問題。

   掃光跨字連續：每個字用自己在行內的位置 --p 去偏移 background-position，
   一道光才會從行首掃到行尾，而不是每個字各閃各的。 */
.ch {
  background: linear-gradient(100deg,
    var(--kt-ink, #fff) 0 42%,
    var(--kt-shine, #ffe6b8) 50%,
    var(--kt-ink, #fff) 58% 100%);
  background-size: 900% 100%;
  background-position: calc(var(--bp, 180%) - var(--p, 0) * 100%) 0;
  -webkit-background-clip: text; background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
}
@media (prefers-reduced-motion: no-preference) {
  .r0 .ch { animation-name: ktRise, ktFocus, ktShine; }
  .r1 .ch { animation-name: ktRise, ktFocus, ktShine; }
  .ch {
    animation-duration: 900ms, 620ms, 6.5s;
    animation-timing-function: cubic-bezier(.16, 1.36, .3, 1), ease-out, ease-in-out;
    animation-delay: var(--d), var(--d), 1.2s;
    animation-fill-mode: both, both, none;
    animation-iteration-count: 1, 1, infinite;
  }
}
@keyframes ktShine {
  0%, 62% { --bp: 180%; }
  100%    { --bp: -260%; }
}
@property --bp { syntax: '<percentage>'; inherits: false; initial-value: 180%; }

/* 色差副本要吃自己的實色，不能被 background-clip 洗成透明 */
.ch::before, .ch::after {
  -webkit-text-fill-color: currentColor;
  background: none;
}
</style>
