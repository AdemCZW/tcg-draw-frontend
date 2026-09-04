<script lang="ts">
/* 型別放在一般的 <script> 區塊：<script setup> 不接受 ES export，
   而兩頁要拿這個型別去標註自己的 options 陣列（tone 是字面量聯集，
   少了標註 TS 會把它放寬成 string）。 */
export interface SegOption<V> {
  value: V
  label: string
  /** 標籤後面那個較暗的數字（卡冊的分頁計數）。undefined 就不畫。 */
  count?: number
  /** 'accent' 只給「真的在篩」的那幾格；預設中性。 */
  tone?: 'neutral' | 'accent'
}
</script>

<script setup lang="ts" generic="T">
import { computed } from 'vue'
/**
 * 一體式軌道（segmented control）。
 *
 * ---- 為什麼是一個元件，不是一份共用的 CSS class ----
 *
 * 這個形態原本在 MyCardsPage（b66a5af）與 MarketPage（0ae5b99）各有逐字複製的
 * 一份 CSS。只把 .segTrack / .segCell 抽成共用樣式解決不了問題：兩頁真正會分岔的
 * 不是樣式，是**行為** —— 哪一格算選中、選中要不要上強調色、鍵盤怎麼走。
 * 只抽 class 的話那三件事還是兩頁各寫一份 JS，然後各自漂移。
 * 所以抽的是元件，樣式只是它順便帶著的東西。
 *
 * ---- 形態上不可以改掉的幾件事（兩頁都已定案，見上述兩筆 commit）----
 *
 * 細線的畫法：容器底鋪 --line、格與格之間 gap: 1px、格子自己蓋 --field，
 * 露出來的那 1px 就是分隔線。好處是**換行時橫向與縱向都自動有線**，
 * 不必為「哪一格是列尾」寫規則 —— 換行之後它變成一張表格，而表格仍然是一個物件。
 * overflow: hidden 讓四個角被外框的圓角切乾淨（圓角 13px）。
 *
 * 選中是「軌道凹（--field）→ 目前值浮（--surface）」加 inset 內描邊。
 * **不可以改用外擴陰影**：軌道有 overflow: hidden，外擴會被切掉，而且頭尾兩格
 * 被切得跟中間格不一樣，正好破壞「一體」這件唯一想講的事。
 *
 * ---- 鍵盤模型：一種，不是兩種 ----
 *
 * 抽出來之前兩頁不一致：卡冊每一格都是一個 Tab 站（8 格就是 8 站），
 * 市場是 roving tabindex ＋方向鍵（整條軌道只佔一站）。
 *
 * 統一成後者。理由不是「想一致」，是 WAI-ARIA 對 **tablist 與 radiogroup
 * 開的是同一張處方**：Tab 只停在目前選中的那一格，組內用方向鍵移動。
 * 也就是說卡冊原本那套（每格一站）對它自己宣告的 role="tablist" 本來就不合規，
 * 不是兩種都對、二選一，是其中一種是壞的。
 * 而且它實際上很痛：光走完卡冊的兩條軌道就要按 8 次 Tab 才碰得到下面的卡牆。
 *
 * 焦點必須跟著值移過去（roving tabindex 的另一半）—— 少了這一步，
 * 按方向鍵值變了但焦點還留在原地，下一次方向鍵就從錯的位置起算。
 *
 * ---- role 為什麼還是留成 prop（兩種都要）----
 *
 * 鍵盤統一了，但**語意不能統一**：
 *   role="tablist"    卡冊的「顯示 / 排序」—— 切的是「你正在看哪一批卡」，
 *                     每一格對應下面卡牆的一種內容，那是分頁。
 *   role="radiogroup" 市場的「排序 / 鑑定 / 分數」—— 這些是條件（單選），
 *                     不是「切到另一個畫面」；而且鑑定與分數有「不限」這個
 *                     未選狀態，分頁沒有這種東西。
 * 拿其中一個去套另一個，只會讓讀螢幕的人聽到錯的東西。上面那張處方之所以
 * 能統一，正是因為 ARIA 對這兩種 role 的鍵盤要求本來就一樣。
 *
 * ---- 兩頁的差異全部走 props ----
 *   layout='wrap'  卡冊：flex-wrap。五個分頁連著計數在 393px 一列裝不下，
 *                  換行但不斷開；每一列的格子把該列撐滿（最後一列只剩一格時
 *                  它自己長成整列寬，不會留下一塊露出 --line 的洞）。
 *   layout='even'  市場：等分 grid，一列排完。換行是裝不下才做的事。
 *   option.count   卡冊：標籤後面接一個較暗的數字（使用者判斷該點哪一格的依據）。
 *   option.tone    市場：選中「真的篩選條件」時上 --accent-wash ＋ accent 內描邊；
 *                  選「不限」退回中性。不區分的話「已選 PSA」跟「不限」長得一樣，
 *                  就看不出篩選正在生效。卡冊沒有未選狀態，所以全部走 neutral。
 */

const props = withDefaults(defineProps<{
  options: readonly SegOption<T>[]
  modelValue: T
  layout?: 'even' | 'wrap'
  /** 見上面「role 為什麼還是留成 prop」。 */
  role?: 'tablist' | 'radiogroup'
  ariaLabel?: string
}>(), { layout: 'even', role: 'radiogroup', ariaLabel: undefined })

const emit = defineEmits<{ 'update:modelValue': [value: T] }>()

/* aria-labelledby 不做成 prop：它是純粹的透傳屬性，Vue 的 attrs fallthrough
   會把它（跟 class）掛到根元素上，再宣告一次只是多一份會不同步的東西。 */

const selected = computed(() => props.options.findIndex(o => o.value === props.modelValue))

function pick(i: number) {
  const o = props.options[i]
  if (o) emit('update:modelValue', o.value)
}

/* 方向鍵在組內移動，Home / End 跳到頭尾，最後一格再往右環繞回第一格。
   上下也接：軌道換行之後「下一格」在使用者眼裡可能真的在下面一列。 */
function onKeydown(e: KeyboardEvent, i: number) {
  const n = props.options.length
  const k = e.key
  const step = k === 'ArrowRight' || k === 'ArrowDown' ? 1
    : k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 0
  let next = i
  if (step) next = (i + step + n) % n
  else if (k === 'Home') next = 0
  else if (k === 'End') next = n - 1
  else return
  e.preventDefault()
  pick(next)
  /* 焦點從 DOM 拿而不是存一份 template ref 陣列：格子跟 options 是一對一、
     順序也一樣，parentElement 的第 next 個孩子就是它。少一份要跟著同步的狀態。
     tabindex 這一輪還沒重算沒關係 —— 程式呼叫 focus() 不看 tabindex。 */
  const group = (e.currentTarget as HTMLElement).parentElement
  ;(group?.children[next] as HTMLElement | undefined)?.focus()
}

/* roving tabindex：整條軌道只佔一個 Tab 站，停在目前值那一格。
   一格都沒選中時（市場的「不限」其實有值，所以只在資料異常時發生）
   退回第一格，否則整條軌道會變成 Tab 走不進去的死角。 */
const rovingAt = computed(() => (selected.value >= 0 ? selected.value : 0))
</script>

<template>
  <!-- --n（格數）給頁面端算桌機的寬度上限用：市場的面板軌道是
       calc(var(--n) * 100px)，四格與六格才不會一個剛好、一個太空。
       它掛在根元素上，所以頁面自己的 scoped CSS 搆得到（Vue 的 scoped
       規則：子元件的根元素同時帶著父元件的 scope）。 -->
  <div
    class="segTrack" :class="layout"
    :role="role" :aria-label="ariaLabel"
    :style="{ '--n': options.length }"
  >
    <button
      v-for="(o, i) in options" :key="String(o.value)"
      type="button"
      :role="role === 'tablist' ? 'tab' : 'radio'"
      :aria-selected="role === 'tablist' ? o.value === modelValue : undefined"
      :aria-checked="role === 'tablist' ? undefined : o.value === modelValue"
      :tabindex="i === rovingAt ? 0 : -1"
      class="segCell"
      :class="{ on: o.value === modelValue, accent: o.tone === 'accent' }"
      @click="pick(i)"
      @keydown="onKeydown($event, i)"
    >{{ o.label }}<span v-if="o.count !== undefined" class="segN mono">{{ o.count }}</span></button>
  </div>
</template>

<style scoped>
/* 細線＝容器的底色從 gap 露出來。border 與 background 都是 --line，
   所以外框與內部的線是同一條線，接得起來。 */
.segTrack {
  min-width: 0;
  gap: 1px;
  margin: 0;
  background: var(--line);
  border: 1px solid var(--line); border-radius: 13px;
  overflow: hidden;
}
/* 卡冊：換行但不斷開。桌機收到內容寬 —— 三個排序各佔 330px 不會更像
   一個控制項，只會更像三塊板子。 */
.segTrack.wrap { display: flex; flex-wrap: wrap; flex: 0 1 auto; }
/* 市場：等分一列排完。
   grid-auto-columns 而不是 repeat(var(--n), …)：後者要 var() 進到 repeat()
   的計數位置，那件事在部分瀏覽器上不成立。
   minmax(0, 1fr) 而不是 1fr：1fr 的下限是 min-content，長標籤會把某一格
   撐寬、其他格被壓扁，「等分」就不成立了。 */
.segTrack.even { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); }

.segCell {
  min-width: 0;                  /* 預設 auto 會讓內容把軌道撐破 */
  min-height: 44px;              /* 觸控目標下限 */
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 0;
  background: var(--field);
  color: var(--muted); font-size: 12.5px; font-weight: 500; font-family: inherit; cursor: pointer;
  white-space: nowrap; overflow: hidden;
  transition: background .15s, color .15s;
}
/* 沒有間距也沒有各自的圓角之後，左右內距 10px 就夠把字撐開 ——
   每格省下的 4px ＋ 少掉的縫，就是 393px 上「計數還擺得下」的來源。 */
.wrap > .segCell { flex: 0 1 auto; gap: 6px; padding: 6px 10px; }
/* 等分之後每格寬度固定，內距再收一階，長標籤才不會太早被切 */
.even > .segCell { padding: 6px 8px; text-overflow: ellipsis; }

/* 目前值：在凹下去的軌道裡浮起來的那一格。
   深色 field(#0f1115) → surface(#17161a)、淺色 #f6f2f0 → #ffffff，
   兩套主題都是「軌道凹、目前值浮」。
   強調色與最高亮度留給頁面上真正的主要動作，這一格只要在軌道內部贏過隔壁。 */
.segCell.on {
  background: var(--surface);
  color: var(--ink); font-weight: 600;
  box-shadow: inset 0 0 0 1px var(--line);
}
/* 只有「真的在篩」的格子上強調色。強調色在這站的語意是「這裡有事情發生」，
   套在什麼都沒篩的預設值（「不限」）上，面板一打開就有兩格在喊。 */
.segCell.accent.on {
  background: var(--accent-wash);
  color: var(--accent); font-weight: 700;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent);
}
.segN { font-size: 11px; opacity: .6; font-weight: 400; }
.segCell.on .segN { opacity: .75; font-weight: 500; }
@media (hover: hover) { .segCell:not(.on):hover { background: var(--surface-2); color: var(--ink); } }

/* ---- 焦點框 ----
   根因：base.css 只給 .btn 寫了 :focus-visible，這些格子不是 .btn，
   於是掉回瀏覽器預設的焦點環 —— Chrome 是寫死的 rgb(0, 95, 204)，
   不走任何權杖，在暖色系上就是一圈突兀的藍。

   兩條規則要一起下，缺一不可：
     :focus         → outline: none，明確拆掉 UA 的環。只靠 :focus-visible
                      是把「滑鼠點完該不該留框」交給各家瀏覽器的啟發式去猜。
     :focus-visible → 補回專案自己的環。鍵盤操作必須看得見焦點，
                      這是無障礙不是裝飾；顏色走 --accent 跟全站一致。
   offset 往內縮（-2px）：軌道 overflow: hidden，外擴的環會被切掉半圈。 */
.segCell:focus { outline: none; }
.segCell:focus-visible {
  outline: 2px solid var(--accent); outline-offset: -2px;
  border-radius: 4px; position: relative; z-index: 1;
}

@media (max-width: 720px) {
  /* 手機上軌道撐滿整列、每一格平分該列剩下的寬。
     flex: 1 1 auto 同時解掉「最後一列只剩一格會留下一塊空洞」：
     那一格自己會長成整列寬，不會露出底下的 --line。 */
  .segTrack.wrap { flex: 1 1 auto; }
  .wrap > .segCell { flex: 1 1 auto; }
}
</style>
