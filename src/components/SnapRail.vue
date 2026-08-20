<script setup lang="ts" generic="T">
/**
 * 左右滑動的挑選台。
 *
 * 手勢完全交給瀏覽器的 CSS scroll-snap，不裝 carousel 套件（0 KB）：
 * swipe 門檻、慣性、橡皮筋回彈都是各平台原生的，跟系統手勢一致；
 * 自己用 pointer 事件重寫一定會在 iOS 的 momentum 上翻車。
 *
 * scroll-snap 相對於 transform-based 套件還有一個關鍵好處：卡片是真的
 * 排在文件流裡，Tab 鍵 focus 到某張卡時瀏覽器會自己把它捲到 snap 位置。
 * 套件方案通常要自己補這段。
 *
 * 唯一缺口是滑鼠拖曳（桌機沒人想用 shift+滾輪），所以補了箭頭鈕與方向鍵。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  items: T[]
  /** 整個挑選台的用途，給輔助技術 */
  label: string
  /** 讀屏用的位置提示要怎麼描述某一項 */
  describe?: (item: T, index: number) => string
}>(), {
  describe: undefined
})

/* 目前停在第幾張要吐給外層 —— 選池台靠它讓背景跟著當前這一池變色。
   軌道自己知道停在哪，外層要重算一次等於把 scroll 監聽做兩份。 */
const emit = defineEmits<{ (e: 'change', index: number): void }>()

const rail = ref<HTMLElement | null>(null)
const cells = ref<HTMLElement[]>([])
const active = ref(0)

function setCell(el: unknown, i: number) {
  if (el instanceof HTMLElement) cells.value[i] = el
}

const reduceMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

function goTo(i: number) {
  const r = rail.value
  const cell = cells.value[i]
  if (!r || !cell) return
  r.scrollTo({
    left: cell.offsetLeft - (r.clientWidth - cell.clientWidth) / 2,
    // 'auto' 會沿用 CSS 的 scroll-behavior（這裡是 smooth），
    // 要真的瞬移必須明寫 instant
    behavior: reduceMotion() ? 'instant' : 'smooth'
  })
}
const step = (dir: 1 | -1) =>
  goTo(Math.min(props.items.length - 1, Math.max(0, active.value + dir)))

/* 目前停在第幾張：找離軌道中心最近的那一格。

   兩個決定：
   1. 不用 IntersectionObserver。它在某些環境不會觸發，指示器就整個卡在
      第一格 —— 這是使用者一定會注意到的壞法。
   2. 卡片中心先算好快取起來，捲動時只讀 scrollLeft 再比對一組數字。
      這樣每次 scroll 都是零版面量測，不必節流，也就不依賴 rAF
      （rAF 在分頁不可見或被節流時不推進，節流版會整個停住）。
   cell.offsetLeft 相對於未捲動的 .wrap，跟 scrollLeft 同一個座標系。 */
const centres = ref<number[]>([])

function recalc() {
  centres.value = cells.value.map(c => (c ? c.offsetLeft + c.clientWidth / 2 : NaN))
  measure()
}
function measure() {
  const r = rail.value
  if (!r) return
  const mid = r.scrollLeft + r.clientWidth / 2
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < centres.value.length; i++) {
    const c = centres.value[i]
    if (Number.isNaN(c)) continue
    const d = Math.abs(c - mid)
    if (d < bestD) { bestD = d; best = i }
  }
  if (best !== active.value) {
    active.value = best
    emit('change', best)
  }
}

let ro: ResizeObserver | undefined
onMounted(() => {
  rail.value?.addEventListener('scroll', measure, { passive: true })
  // 卡寬隨容器斷點改變，尺寸一變就要重算快取
  if (rail.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(recalc)
    ro.observe(rail.value)
  }
  recalc()
})
onBeforeUnmount(() => {
  rail.value?.removeEventListener('scroll', measure)
  ro?.disconnect()
})
// 池清單是非同步載入的，資料到齊後 cell 才存在
watch(() => props.items.length, n => {
  cells.value.length = n
  // 等 Vue 把新的 cell 掛上去
  nextTick(recalc)
})

const atStart = computed(() => active.value <= 0)
const atEnd = computed(() => active.value >= props.items.length - 1)

const liveText = computed(() => {
  const n = props.items.length
  if (!n) return ''
  const what = props.describe?.(props.items[active.value], active.value) ?? ''
  return `第 ${active.value + 1} 個，共 ${n} 個${what ? '：' + what : ''}`
})
</script>

<template>
  <section class="wrap" :aria-label="label" @keydown.left.prevent="step(-1)" @keydown.right.prevent="step(1)">
    <button
      type="button" class="arrow prev" :disabled="atStart"
      aria-label="上一個" @click="step(-1)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
    </button>

    <ul ref="rail" class="rail">
      <li
        v-for="(item, i) in items" :key="i"
        :ref="el => setCell(el, i)"
        class="cell"
        :class="{ on: i === active }"
      >
        <slot :item="item" :index="i" :active="i === active" />
      </li>
    </ul>

    <button
      type="button" class="arrow next" :disabled="atEnd"
      aria-label="下一個" @click="step(1)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
    </button>

    <!-- 圓點是裝飾，真正的位置資訊走下面的 live region，
         不然快滑時讀屏會把每一顆點都唸一次 -->
    <div v-if="items.length > 1" class="dots" aria-hidden="true">
      <button
        v-for="(_, i) in items" :key="i"
        type="button" class="dot" :class="{ on: i === active }"
        tabindex="-1" @click="goTo(i)"
      ></button>
      <span class="count mono">{{ active + 1 }} / {{ items.length }}</span>
    </div>

    <p class="sr-only" aria-live="polite">{{ liveText }}</p>
  </section>
</template>

<style scoped>
.wrap {
  container-type: inline-size;
  position: relative;
}

.rail {
  /* 中央卡寬。露出左右鄰居本身就是「可以滑」的提示，
     不需要另外教學；滿版單張在桌機會浪費兩側六成空間。 */
  /* 手機刻意窄一點：卡片是 5:7 的直式卡，寬度每多 10px 高度就多 14px，
     太寬會把下面的指示器擠到底部導覽後面去 */
  --card-w: min(72cqw, 320px);
  --gap: 12px;

  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  gap: var(--gap);
  overflow-x: auto;
  /* iOS Safari：容器同時有 overflow-y 會讓 scroll-snap 整個失效 */
  overflow-y: hidden;
  scroll-snap-type: x mandatory;
  scroll-behavior: smooth;
  /* 擋掉「滑到底再滑」觸發瀏覽器的返回手勢 */
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  /* 首尾卡也要能置中。用 padding 不用 margin —— margin 會被算進 snap 位置 */
  padding-inline: calc((100% - var(--card-w)) / 2);
  scroll-padding-inline: calc((100% - var(--card-w)) / 2);
  padding-block: 4px 2px;
}
.rail::-webkit-scrollbar { display: none; }

.cell {
  flex: 0 0 var(--card-w);
  /* 一次只跳一張。少了這行快滑會一口氣甩過三張，找不到剛剛看到的那個 */
  scroll-snap-align: center;
  scroll-snap-stop: always;
  transition: opacity .3s, transform .3s;
}

@container (min-width: 480px) {
  .rail { --card-w: min(70cqw, 400px); --gap: 16px; }
}
@container (min-width: 860px) {
  .rail { --card-w: 370px; --gap: 20px; }
}

/* 鄰居退到後面。用 animation-timeline 讓縮放跟著捲動走，
   不支援的瀏覽器（目前 Safari／Firefox）只是沒有縮放，功能完全不受影響。 */
@media (prefers-reduced-motion: no-preference) {
  .cell:not(.on) { opacity: .5; transform: scale(.92); }
}
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .cell {
      opacity: 1; transform: none;
      animation: peek linear both;
      animation-timeline: view(inline);
      animation-range: cover 12% cover 88%;
    }
  }
  @keyframes peek {
    0%   { opacity: .45; transform: scale(.9); }
    50%  { opacity: 1;   transform: scale(1); }
    100% { opacity: .45; transform: scale(.9); }
  }
}

/* ---- 箭頭：只給桌機。觸控裝置有手勢，不需要多兩顆按鈕搶空間 ---- */
.arrow {
  display: none;
  position: absolute; top: 42%; z-index: 3;
  width: 42px; height: 42px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  backdrop-filter: blur(8px);
  color: var(--ink);
  cursor: pointer;
  transition: background .15s, opacity .15s;
}
.arrow svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.arrow:hover:not(:disabled) { background: var(--surface-3); }
.arrow:disabled { opacity: .25; cursor: default; }
.arrow:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* 往內 6px，不是往外 -6px。SnapRail 是滿版元件（/play 的 .page 左右內距
   是 0，讓卡片能貼邊捲動），所以「掛在軌道外面 6px」等於掛在視窗外面：
   1280px 下實測 .prev left -6 / .next right 1286，兩顆圓鈕各被螢幕邊緣
   切掉 6px。擺在軌道內側同樣壓在旁邊那張變暗的卡上，是輪播常見的樣子，
   而且不管外層有沒有內距都成立。 */
.prev { left: 6px; }
.next { right: 6px; }
@container (min-width: 860px) {
  .arrow { display: grid; place-items: center; }
}

/* ---- 指示器 ---- */
.dots {
  display: flex; align-items: center; justify-content: center;
  gap: 6px; margin-top: 10px;
}
.dot {
  width: 6px; height: 6px; padding: 0;
  border: none; border-radius: var(--pill);
  background: var(--surface-3);
  cursor: pointer;
  transition: width .25s, background .25s;
}
.dot.on { width: 20px; background: var(--accent); }
.count {
  margin-left: 8px;
  font-size: 11.5px; color: var(--muted);
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .rail { scroll-behavior: auto; scroll-snap-type: x proximity; }
  .cell, .dot { transition: none; }
}
</style>
