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
 *
 * 下方的指示器不是圓點，是一條捲軸式滑桿 —— 因為圓點會隨項目數線性變長，
 * 幾十個項目就會撐爆手機視窗（詳見 template 裡那段說明）。滑桿同時解決
 * 「我在第幾個」與「直接跳到第幾個」兩件事，而且寬度不隨項目數改變。
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
/* 滑桿的軌道。它的位置用 CSS 變數直接寫在 DOM 上，不走 ref ——
   理由見 measure() 裡的說明。 */
const track = ref<HTMLElement | null>(null)

function setCell(el: unknown, i: number) {
  if (el instanceof HTMLElement) cells.value[i] = el
}

const reduceMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * instant：拖滑桿時每一格都補間會拖成一團糊，只有點擊與按鍵才需要動畫。
 *
 * 跨距超過三格也一律瞬移。smooth scroll 的時間是跟距離走的：從第 1 池
 * 按 End 跳到第 200 池，Chrome 會花好幾秒把 59000px 捲完，過程中畫面
 * 只是一片糊掉的卡片 —— 那不是「動畫」，那是「等待」。近距離才補間，
 * 因為那時動畫真的有用：它告訴你剛剛是往左還是往右移了一格。
 */
function goTo(i: number, instant = false) {
  const r = rail.value
  const cell = cells.value[i]
  if (!r || !cell) return
  const far = Math.abs(i - active.value) > 3
  r.scrollTo({
    left: cell.offsetLeft - (r.clientWidth - cell.clientWidth) / 2,
    // 'auto' 會沿用 CSS 的 scroll-behavior（這裡是 smooth），
    // 要真的瞬移必須明寫 instant
    behavior: instant || far || reduceMotion() ? 'instant' : 'smooth'
  })
}
const clampIdx = (i: number) => Math.min(props.items.length - 1, Math.max(0, i))
const step = (dir: 1 | -1) => goTo(clampIdx(active.value + dir))
/* PageUp／PageDown 一次跳一成（至少 5 格）。
   固定跳 10 格在 200 池時要按 20 次，固定跳「總數的一成」在 5 池時
   又等於跳 1 格 —— 兩個下限都要顧，所以取比例與 5 的較大值。 */
const page = (dir: 1 | -1) =>
  goTo(clampIdx(active.value + dir * Math.max(5, Math.round(props.items.length / 10))))

/* 目前停在第幾張：找離軌道中心最近的那一格。

   兩個決定：
   1. 不用 IntersectionObserver。它在某些環境不會觸發，指示器就整個卡在
      第一格 —— 這是使用者一定會注意到的壞法。
   2. 卡片中心先算好快取起來，捲動時只讀 scrollLeft 再比對一組數字。
      這樣每次 scroll 都是零版面量測，不必節流，也就不依賴 rAF
      （rAF 在分頁不可見或被節流時不推進，節流版會整個停住）。
   cell.offsetLeft 相對於未捲動的 .wrap，跟 scrollLeft 同一個座標系。 */
const centres = ref<number[]>([])
/* 軌道還能往右捲多少。滑桿的位置＝scrollLeft / 這個值，
   快取起來是為了讓 measure() 完全不碰 scrollWidth（那是一次版面計算）。 */
let maxScroll = 0

function recalc() {
  centres.value = cells.value.map(c => (c ? c.offsetLeft + c.clientWidth / 2 : NaN))
  const r = rail.value
  maxScroll = r ? Math.max(0, r.scrollWidth - r.clientWidth) : 0
  measure()
}
function measure() {
  const r = rail.value
  if (!r) return
  /* 滑桿位置直接寫進 DOM，不經過響應式的 ref。
     捲動每一幀都會動到它，而 ref 一變 Vue 就要重跑整個 template ——
     裡面是 v-for 的 200 張卡，等於每一幀 diff 200 個節點。
     寫 CSS 變數只影響一個元素的樣式，不會觸發任何 render。 */
  if (maxScroll > 0 && track.value) {
    const p = Math.min(1, Math.max(0, r.scrollLeft / maxScroll))
    track.value.style.setProperty('--pos', String(p))
  }
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

/* ---- 拖滑桿跳位 ----
   輪播本來只能一格一格滑，32 池時要看最後一池得滑 31 次。
   滑桿把「整條清單」壓成一條固定寬度的軌道，按下去就直接跳過去 ——
   而且它同時是位置指示器，一個元件解決兩件事。 */
function knobWidth(w: number) {
  // 跟 CSS 的 max(28px, 100%/n) 同一條式子，兩邊要一致滑塊才會貼著指標走
  return Math.max(28, w / Math.max(1, props.items.length))
}
function seek(clientX: number) {
  const el = track.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const kw = knobWidth(r.width)
  const span = r.width - kw
  // 扣掉滑塊寬度：指標對的是滑塊中心，不是軌道左緣
  const t = span > 0 ? (clientX - r.left - kw / 2) / span : 0
  goTo(Math.round(Math.min(1, Math.max(0, t)) * (props.items.length - 1)), true)
}
let dragging = false
function onGrab(e: PointerEvent) {
  dragging = true
  // 指標離開滑桿範圍（手指往上滑）也要繼續收到事件，不然拖到一半就斷了
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  seek(e.clientX)
}
function onDrag(e: PointerEvent) { if (dragging) seek(e.clientX) }
function onRelease() { dragging = false }

const atStart = computed(() => active.value <= 0)
const atEnd = computed(() => active.value >= props.items.length - 1)

/* 滑桿唸出來的內容。只給編號的話讀屏使用者拖到一半完全不知道停在哪一池 */
const valueText = computed(() => {
  const n = props.items.length
  if (!n) return ''
  const what = props.describe?.(props.items[active.value], active.value) ?? ''
  return `${active.value + 1} / ${n}${what ? '，' + what : ''}`
})

const liveText = computed(() => {
  const n = props.items.length
  if (!n) return ''
  const what = props.describe?.(props.items[active.value], active.value) ?? ''
  return `第 ${active.value + 1} 個，共 ${n} 個${what ? '：' + what : ''}`
})
</script>

<template>
  <!-- Home／End／PageUp／PageDown 掛在最外層而不是滑桿上：軌道本身也是可聚焦的，
       使用者 Tab 到軌道之後按 End 想跳到最後一池，卻只有滑桿有反應的話很難理解。
       .prevent 是必要的 —— 不擋的話這四個鍵會去捲整頁，而不是捲軌道。 -->
  <section
    class="wrap" :aria-label="label"
    @keydown.left.prevent="step(-1)" @keydown.right.prevent="step(1)"
    @keydown.home.prevent="goTo(0)" @keydown.end.prevent="goTo(items.length - 1)"
    @keydown.page-up.prevent="page(-1)" @keydown.page-down.prevent="page(1)"
  >
    <button
      type="button" class="arrow prev" :disabled="atStart"
      aria-label="上一個" @click="step(-1)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
    </button>

    <!-- 軌道自己要能被 Tab 聚焦：方向鍵的處理掛在外層，但事件得先有地方發生。
         桌機沒有手勢，使用者按 Tab 進來的第一站應該就是「可以左右移動的東西」，
         而不是被迫先聚焦到某一張卡（那會順便把「選了這張」的意思也講出去）。 -->
    <ul
      ref="rail" class="rail"
      tabindex="0" role="group" :aria-label="`${label}：用左右方向鍵切換`"
    >
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

    <!-- ---- 位置指示器 ＝ 跳位控制 ----
         這裡以前是「一個項目一顆圓點」。那在 5 個項目時成立，在 32 個時是壞的：
         32 顆點 6px + 31 個 6px 間距 + 計數器 ≈ 428px，超過 393px 的手機視窗，
         整列換行、「1 / 32」被折成「1 /」和「32」兩行（實測 .dots 高度 36.8px，
         正好是兩倍行高）；100 個項目時連 1280px 桌機都會換行。
         而且 6px 的點遠低於 44px 觸控下限，tabindex="-1" 又讓它連鍵盤都不給用 ——
         它既不能讀也不能點。

         換成捲軸式滑桿的關鍵性質是**寬度與項目數無關**：n 只決定滑塊佔軌道的
         比例（並設 28px 下限），軌道本身永遠是「剩下的寬度」。3 池、50 池、
         200 池的版面完全一樣，計數器永遠在同一個位置、永遠不換行。

         它同時補上輪播缺的「跳位」：按住往右拖就直接跳到第 200 池，
         不必滑 199 次。滑塊佔比本身也把「總共多少」講出來了 ——
         滑塊只有一小截就是「這清單很長」。 -->
    <div v-if="items.length > 1" class="railNav">
      <div
        ref="track" class="scrub"
        role="slider" :aria-label="`${label}位置`" tabindex="0"
        aria-orientation="horizontal"
        :aria-valuemin="1" :aria-valuemax="items.length"
        :aria-valuenow="active + 1" :aria-valuetext="valueText"
        :style="{ '--n': items.length }"
        @pointerdown="onGrab" @pointermove="onDrag"
        @pointerup="onRelease" @pointercancel="onRelease"
      >
        <span class="bar" aria-hidden="true"><i class="knob"></i></span>
      </div>
      <!-- flex: none + nowrap。這兩條就是「計數器任何情況下不換行」的保證：
           它不參與收縮，滑桿吃掉所有剩餘寬度（min-width: 0 讓它縮得下去）。
           --digits 是總數的位數：目前編號從「1」滑到「200」會多兩個字，
           計數器一變寬滑桿就跟著變窄，整條軌道在拖曳過程中會慢慢縮 ——
           實測 200 池時滑塊的終點位置差了 14.4px。先把最寬的情況佔住就不會動。 -->
      <span class="count mono" :style="{ '--digits': String(items.length).length }">
        <span class="cur">{{ active + 1 }}</span> / {{ items.length }}
      </span>
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
/* 內縮 2px：outline 畫在軌道自己的邊界上，offset 為正會被外層裁掉一半 */
.rail:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: var(--radius); }

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
/* 門檻從 860 降到 700：選池台在桌機把右半邊讓給資訊面板，1280 下軌道自己
   只剩 792cqw。用 860 當門檻的話這裡會踩不到，退回 min(70cqw, 400px)——
   卡片反而比全寬時更大，5:7 換算高度多 42px，整頁要捲的距離跟著變長。 */
@container (min-width: 700px) {
  .rail { --card-w: 370px; --gap: 20px; }
}
/* 軌道自己夠寬時中央卡再放大一階。條件掛在容器而不是視窗：
   卡片該多大取決於「軌道剩多少」，跟視窗多寬沒有直接關係。 */
@container (min-width: 900px) {
  /* 390 是上限不是美感取捨：5:7 換算下這裡每加 10px 寬就多 14px 高，
     再大一階（410）整頁在 1600x900 下要捲的距離就會比改版前更長。 */
  .rail { --card-w: 390px; --gap: 24px; }
}

/* 桌機把軌道兩側淡出。鄰居被欄位邊緣硬切一刀會像是「卡片被面板壓住」，
   淡出才讀得出「後面還有，可以繼續滑」。遮罩只在夠寬時才上 ——
   手機的軌道等於整個視窗寬，淡掉兩側會把中央卡的邊角也吃掉。 */
@container (min-width: 700px) {
  .rail {
    -webkit-mask-image: linear-gradient(90deg, transparent, #000 9% 91%, transparent);
    mask-image: linear-gradient(90deg, transparent, #000 9% 91%, transparent);
  }
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
  /* 44 而不是 42：42 差一點點就過不了觸控下限，而這兩顆是純粹的操作鈕，
     多兩個像素不影響任何版面 */
  width: 44px; height: 44px;
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
/* 出現與否看的是「有沒有滑鼠」，不是「螢幕夠不夠寬」。
   原本用 container 寬度當條件，軌道一旦被面板讓掉一段寬度就整組消失 ——
   但需不需要箭頭跟寬度無關，跟有沒有手勢有關。 */
@media (hover: hover) and (pointer: fine) {
  @container (min-width: 560px) {
    .arrow { display: grid; place-items: center; }
  }
}

/* ---- 指示器 ＝ 跳位滑桿 ---- */
/* 名字刻意不叫 .nav：站上已經有一個全域的 .nav（頁首導覽，見 styles/touch.css
   的 `.nav a` 規則），同名的類別在 devtools、量測腳本、日後的全域樣式裡都會
   混在一起 —— scoped 樣式救得了樣式，救不了「選到錯的那個」。 */
.railNav {
  display: flex; align-items: center; gap: 14px;
  /* 軌道是滿版的（.rail 左右內距 0 才能讓卡片貼邊捲），所以這一列要自己補內距，
     不然滑桿的兩端會頂到螢幕邊 */
  padding-inline: var(--pad);
  margin-top: 2px;
}

/* 觸控目標：視覺上只有 6px 的一條，但可按的範圍是 6 + 上下各 19 = 44px。
   把高度做在 padding 上而不是加大那條線 —— 這一列在大卡下面，
   畫一條粗棒子會跟卡片搶注意力。 */
.scrub {
  flex: 1 1 auto; min-width: 0;
  display: flex; align-items: center;
  padding-block: 19px;
  border-radius: var(--pill);
  cursor: pointer;
  /* 拖滑桿是橫向手勢，不設 none 的話瀏覽器會先把它判成「捲頁面」而搶走 */
  touch-action: none;
  --pos: 0;
}
.scrub:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.bar {
  position: relative;
  flex: 1 1 auto; min-width: 0;
  height: 6px;
  border-radius: var(--pill);
  background: var(--surface-3);
  /* 滑塊寬度＝軌道的 1/n，但不小於 28px。
     下限是這個設計不隨項目數退化的關鍵：200 池時 1/200 只有 1.8px，
     等於看不見也抓不住；夾在 28px 之後滑塊照樣抓得到，
     而「滑塊只佔軌道一小截」本身就是「清單很長」的訊息。
     JS 端的 knobWidth() 必須跟這條式子一致，滑塊才會貼著手指走。 */
  --knob-w: max(28px, calc(100% / var(--n)));
}
.knob {
  position: absolute; top: 0; bottom: 0;
  width: var(--knob-w);
  /* 可走的距離是「軌道寬 − 滑塊寬」，所以 --pos 要乘在那段上，
     不是乘 100% —— 乘 100% 的話滑到底時滑塊會有一半跑到軌道外面 */
  left: calc(var(--pos) * (100% - var(--knob-w)));
  border-radius: var(--pill);
  /* --rail-accent 讓外層決定顏色（選池台把它接到當前球階的色）。
     沒接的頁面就退回品牌強調色。 */
  background: var(--rail-accent, var(--accent));
}
/* 刻意不給 .knob 任何 transition：--pos 是直接跟著 scrollLeft 每一幀更新的，
   已經是最平滑的結果。再補一層過渡只會讓滑塊落後手指（拖曳）
   或落後卡片（smooth scroll），看起來像卡頓。 */
@media (hover: hover) {
  .scrub:hover .bar { background: var(--line); }
}

.count {
  /* 不換行的保證：不參與 flex 收縮 + 明確禁止斷行 + 等寬數字
     （等寬是為了讓數字進位時整串不會左右抖） */
  flex: none;
  white-space: nowrap;
  font-size: 12px; color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.cur {
  display: inline-block;
  /* 等寬數字下 1ch 正好是一個數字的寬度，所以「總數有幾位就佔幾位」 */
  min-width: calc(var(--digits, 1) * 1ch);
  text-align: right;
  color: var(--ink);
}

@media (prefers-reduced-motion: reduce) {
  .rail { scroll-behavior: auto; scroll-snap-type: x proximity; }
  .cell { transition: none; }
}
</style>
