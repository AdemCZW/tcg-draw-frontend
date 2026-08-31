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
  /** 待機時的循環故障週期（秒）。0 = 關掉 */
  glitchEvery?: number
  /**
   * 掃光。'loop' 每 6.5 秒掃一次、'once' 只在進場掃一次、'off' 不掃。
   *
   * 會有這個 prop 是因為掃光是靠一支註冊過的自訂屬性（--bp）在動，
   * 而註冊過的自訂屬性動畫是**主執行緒**的：它每一幀都要重算樣式、
   * 再重繪 background-clip: text 的那一層。一行標題切成十九個字元，
   * 就是十九支這樣的動畫永遠在跑。
   * 放在結果頁那種看完就走的地方無所謂；放在形象頁的首屏，
   * 那是使用者停留期間**一直**在付的錢。
   */
  shine?: 'loop' | 'once' | 'off'
}>(), { stagger: 42, delay: 0, label: undefined, glitchEvery: 5.5, shine: 'loop' })

/* 待機的故障（跳字、殘影）只在 glitchEvery > 0 時才掛上去。
   不是把週期設成 0 就算了 —— 那樣動畫還是存在，只是時長為零，
   引擎照樣要為每個字元建立動畫物件。要省就要真的不要那條規則。 */
const idle = computed(() => props.glitchEvery > 0)

/** 切成字元，同時記錄全域序號 —— 跨行連續才有一條走過去的節奏 */
const rows = computed(() => {
  let n = 0
  return props.lines.map(line => ({
    text: line,
    chars: [...line].map((ch, k) => ({
      ch,
      i: ch === ' ' ? -1 : n++,
      p: line.length > 1 ? k / (line.length - 1) : 0,
      /* 固定的偽亂數相位：故障要在字之間跳來跳去才像「訊號不穩」，
         整行同時抽動看起來只是整體震動。用字元碼當種子，重繪不會變。 */
      g: ((ch.charCodeAt(0) * 37 + k * 91) % 100) / 100
    }))
  }))
})
const srText = computed(() => props.label ?? props.lines.join(' '))
</script>

<template>
  <div class="kt" :class="[`sh-${shine}`, { idle }]">
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
          :style="{
            '--d': (delay + (c.i < 0 ? 0 : c.i) * stagger) + 'ms',
            '--p': c.p,
            '--g': (-c.g * glitchEvery).toFixed(2) + 's',
            '--ge': glitchEvery + 's'
          }"
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
  /* 這裡本來有 will-change: transform, opacity, filter。
     那是十九個永久的合成層（每個還帶兩個 mix-blend-mode 的偽元素），
     為了一段九百毫秒的進場長期佔著記憶體。
     transform / filter 動畫進行中瀏覽器本來就會自己提升圖層，
     講明反而只是讓它提早、而且不放手。 */
}

/* ---- 進場：升起 + 對焦 + 轉正 + 過衝定格 ---- */
@media (prefers-reduced-motion: no-preference) {
  /* 色差分離：兩份彩色副本在定格那一拍錯開再收回 */
  .ch::before,
  .ch::after {
    content: attr(data-ch);
    position: absolute; left: 0; top: 0;
    pointer-events: none;
  }
  .ch::before { color: #ff3b6b; mix-blend-mode: screen; }
  .ch::after  { color: #35e8ff; mix-blend-mode: screen; --dir: -1; }
  .ch::before, .ch::after {
    animation: ktSplit 900ms cubic-bezier(.16, 1.36, .3, 1) var(--d) both;
  }
  /* 待機故障時色差副本也跳一下，而且跳得比進場那次遠 —— 訊號斷裂的感覺 */
  .idle .ch::before, .idle .ch::after {
    animation:
      ktSplit 900ms cubic-bezier(.16, 1.36, .3, 1) var(--d) both,
      ktGhost var(--ge) steps(1, end) var(--g) infinite;
  }
  .ch { position: relative; }
}

@keyframes ktRise {
  0%   { transform: translateY(115%) rotateX(-72deg) scale(.94); }
  62%  { transform: translateY(-7%) rotateX(6deg) scale(1.03); }   /* 過衝 */
  100% { transform: translateY(0) rotateX(0deg) scale(1); }
}
/* 對焦。**刻意沒有 opacity。**
   字一開始就在槽底、被 .slot 的 overflow: hidden 裁掉，看不見是因為
   「被擋住」不是因為「還沒亮」—— 這跟煙霧揭曉是同一條原則。
   而且 opacity: 0 的元素不算 LCP 候選，加了淡入等於把標題整個
   移出首屏指標之外。 */
@keyframes ktFocus {
  0%   { filter: blur(9px); }
  55%  { filter: blur(1.5px); }
  100% { filter: blur(0); }
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
/* 進場的兩支是所有情況都有的：升起（過衝定格）與對焦。 */
@media (prefers-reduced-motion: no-preference) {
  .ch {
    animation-name: ktRise, ktFocus;
    animation-duration: 900ms, 620ms;
    animation-timing-function: cubic-bezier(.16, 1.36, .3, 1), ease-out;
    animation-delay: var(--d), var(--d);
    animation-fill-mode: both, both;
    animation-iteration-count: 1, 1;
  }
  /* 掃光。--bp 是註冊過的自訂屬性，動畫在主執行緒跑 ——
     'once' 只付一次，'loop' 是永遠付。 */
  .sh-once .ch { animation-name: ktRise, ktFocus, ktShine;
    animation-duration: 900ms, 620ms, 1.5s;
    animation-timing-function: cubic-bezier(.16, 1.36, .3, 1), ease-out, ease-out;
    animation-delay: var(--d), var(--d), calc(var(--d) + 620ms);
    animation-fill-mode: both, both, none;
    animation-iteration-count: 1, 1, 1; }
  .sh-loop .ch { animation-name: ktRise, ktFocus, ktShine;
    animation-duration: 900ms, 620ms, 6.5s;
    animation-timing-function: cubic-bezier(.16, 1.36, .3, 1), ease-out, ease-in-out;
    animation-delay: var(--d), var(--d), 1.2s;
    animation-fill-mode: both, both, none;
    animation-iteration-count: 1, 1, infinite; }
  /* 待機故障：整組只在 .idle 時存在。
     故障用 steps()：數位訊號是硬切的，一用平滑緩動就變成普通的抖動動畫。
     這是「看起來像故障」跟「看起來像沒做完的動畫」的分界。 */
  .idle .ch {
    animation-name: ktRise, ktFocus, ktShine, ktGlitch, ktBlink;
    animation-duration: 900ms, 620ms, 6.5s, var(--ge), var(--ge);
    animation-timing-function:
      cubic-bezier(.16, 1.36, .3, 1), ease-out, ease-in-out,
      steps(1, end), steps(1, end);
    animation-delay: var(--d), var(--d), 1.2s, var(--g), var(--g);
    animation-fill-mode: both, both, none, none, none;
    animation-iteration-count: 1, 1, infinite, infinite, infinite;
  }
}
@keyframes ktShine {
  0%, 62% { --bp: 180%; }
  100%    { --bp: -260%; }
}
/* 'once' 的掃光是一支獨立的 1.5 秒動畫，掃完 --bp 回到初始值 180%
   （fill-mode: none），字停在乾淨的實色上。 */
@property --bp { syntax: '<percentage>'; inherits: false; initial-value: 180%; }

/* ---- 待機故障 ----
   九成五的時間完全靜止。故障只佔幾個百分點，而且是一連串硬切的位置 ——
   偶爾才壞一下才叫故障，一直在動只是吵。 */
@keyframes ktGlitch {
  0%, 90%   { transform: none; }
  90.5%     { transform: translate(-.06em, .02em) skewX(-9deg); }
  91.5%     { transform: translate(.05em, -.03em) skewX(7deg); }
  92.5%     { transform: translate(-.03em, 0) skewX(0deg); }
  93.5%     { transform: translate(.02em, .01em) skewX(-3deg); }
  94.5%, 100% { transform: none; }
}
/* 瞬間消失再出現 —— 「瞬移」的關鍵不是位移，是中間那兩格空白 */
@keyframes ktBlink {
  0%, 90%     { opacity: 1; }
  90.8%       { opacity: 0; }
  91.6%       { opacity: 1; }
  92.4%       { opacity: 0; }
  93.2%, 100% { opacity: 1; }
}

@keyframes ktGhost {
  0%, 90%     { opacity: 0; transform: none; }
  90.5%       { opacity: .95; transform: translate(calc(var(--dir, 1) * .16em), 0); }
  91.5%       { opacity: .7;  transform: translate(calc(var(--dir, 1) * -.11em), .02em); }
  92.5%       { opacity: .9;  transform: translate(calc(var(--dir, 1) * .07em), 0); }
  93.5%       { opacity: .4;  transform: translate(calc(var(--dir, 1) * -.03em), 0); }
  94.5%, 100% { opacity: 0; transform: none; }
}

/* 色差副本要吃自己的實色，不能被 background-clip 洗成透明 */
.ch::before, .ch::after {
  -webkit-text-fill-color: currentColor;
  background: none;
}
</style>
