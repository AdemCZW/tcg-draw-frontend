<script setup lang="ts">
/**
 * 從畫面下緣滑出的操作列。
 *
 * 為什麼要抽成共用元件：這個模式看起來只是「fixed 到底部再加個動畫」，
 * 實際上有三個實測才會撞到的坑（下面每一段都有註解說明），每複製一份
 * 就要再踩一次。內容一律由呼叫端用 slot 給，這支只負責「怎麼浮、怎麼進出」。
 *
 * props：
 *   open            列要不要在。呼叫端自己決定什麼狀態算「有事可做」，
 *                   免得空列浮在下緣。
 *   label           無障礙用的區域名稱。
 *   desktopMinWidth 到這個寬度以上就整條關掉。不給＝任何寬度都成立。
 *                   為什麼用 JS matchMedia 而不是 CSS 媒體查詢：斷點由呼叫端
 *                   決定（池頁 861、市場頁不一定），CSS 的 @media 條件沒辦法
 *                   吃 prop。matchMedia 是事件驅動的，不像 rAF 會被節流。
 *   spacer          讓位高度，約等於列高加下緣間距。
 *   gap             列與畫面下緣的間距。
 *   maxWidth        列的最大寬度（置中）。寬螢幕上讓列跟頁面同寬，
 *                   不要拉成橫貫整個視窗的一條。
 *   inline          不浮出，就地當成頁面裡的 sticky 結帳列。給桌機用：
 *                   桌機沒有拇指可及的問題，也沒有底部導覽會蓋住東西，
 *                   一條從視窗下緣飛進來的列只是噪音。有了這個模式，
 *                   同一份 slot 內容不必為了兩種版型抄成兩份。
 */
import { computed } from 'vue'
import { useMediaQuery } from '@/composables/useMediaQuery'

const props = withDefaults(defineProps<{
  open: boolean
  label?: string
  desktopMinWidth?: number
  spacer?: number
  gap?: number
  maxWidth?: number
  inline?: boolean
}>(), { label: '操作', spacer: 96, gap: 10 })

/* 桌機斷點：沒給就不掛任何監聽 */
const wide = useMediaQuery(props.desktopMinWidth == null ? null : `(min-width: ${props.desktopMinWidth}px)`)
const up = computed(() => props.open && !wide.value && !props.inline)

/* 位移與尺寸走 inline style 而不是 <style> 裡的 v-bind()：v-bind() 是把
   自訂屬性設在「元件根元素」上，而這支的內容是 Teleport 出去的，變數根本
   到不了那個節點，bottom 會整條算不出來、退回 auto，列就留在原本的流內位置。
   實測就是這樣才發現的。 */
const spacerStyle = computed(() => ({ height: `${props.spacer}px` }))
const barStyle = computed(() => ({
  /* 取 max()：手機的 --nav-total 已含安全區，桌機是 0 才輪到 --safe-b
     自己出面（慣例見 NotifyBell.vue）。只加 --safe-b 會被底部導覽蓋掉。 */
  bottom: `calc(${props.gap}px + max(var(--nav-total, 0px), var(--safe-b, 0px)))`,
  maxWidth: props.maxWidth ? `${props.maxWidth}px` : undefined
}))
</script>

<template>
  <!-- inline 模式：就地長一條 sticky 列，不 Teleport、不做進場動畫。
       它跟浮出版共用同一份 slot 內容與同一組視覺，只是定位方式不同。 -->
  <div v-if="inline && open" class="actionBar inlineBar" role="region" :aria-label="label" :style="barStyle">
    <slot />
  </div>

  <!-- 必須 Teleport 到 body：祖先只要有 transform（Tilt3D、換頁轉場、任何動畫）
       或 backdrop-filter，就會變成 position:fixed 子孫的定位基準，這條列會被
       釘在那個祖先上而不是視窗下緣。 -->
  <Teleport to="body">
    <!-- 讓位要補在整份文件的最後面，不能補在頁面容器裡：捲到底時被列蓋住的是
         文件的最末端（全域頁尾那排連結），在中間插一段只是把整頁往下推，
         最末端相對視窗的位置一點都沒變。實測過，補在頁面裡完全沒有用。
         只在列真的浮著時才存在 —— 底部導覽的讓位全域頁尾已經算過一次，
         再加一次會在下緣多出一段捲得到卻空無一物的黑。 -->
    <div v-if="up" class="actionBarSpacer" aria-hidden="true" :style="spacerStyle" />
    <Transition name="bar">
      <div v-if="up" class="actionBar" role="region" :aria-label="label" :style="barStyle">
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 有 maxWidth 時 left/right 都在、寬度靠 max-width 收窄，margin auto 才會置中。
   類名刻意不叫 .bar：Vue 會把呼叫端的 scope id 蓋到子元件根元素上，
   撞名的話呼叫端那份 .bar 規則會連這裡一起改到，改一頁壞另一頁。 */
.actionBar {
  position: fixed; z-index: 65;
  left: calc(10px + var(--safe-l, 0px));
  right: calc(10px + var(--safe-r, 0px));
  margin-inline: auto;
  padding: 12px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
}

/* inline 版：sticky 而不是 fixed，所以不需要 Teleport（sticky 不吃祖先的
   transform 當定位基準）。bottom 沿用同一條算式，兩種模式停在同一個高度。 */
.inlineBar {
  position: sticky; z-index: auto;
  left: auto; right: auto;
  margin: 16px 0 0;
}

/* 滑入用 @keyframes 而不是 transition + .bar-enter-from：
   Vue 是在下一個 rAF 才拿掉 enter-from 這個 class，而 rAF 一被節流
   （背景分頁、iOS 省電）就永遠停在畫面外 —— 這個 repo 的換頁轉場已經
   踩過同一個坑（見 App.vue 的說明）。keyframes 從插入那一刻就自己跑，
   不欠任何一幀。關掉動效的人直接出現，不必等滑入。 */
@media (prefers-reduced-motion: no-preference) {
  .bar-enter-active { animation: barUp .24s cubic-bezier(.2, .85, .3, 1); }
  /* 收回刻意用另一組 keyframes 而不是把 barUp 反著播：animation-name 沒變的話
     瀏覽器當成同一個動畫、不會重新開始，animationend 就永遠不來，Vue 也就
     永遠不把這條列從 DOM 拿掉（在 rAF 被節流的分頁實測到過） */
  .bar-leave-active { animation: barDown .16s ease-in; }
}
@keyframes barUp {
  from { opacity: 0; transform: translateY(calc(100% + 16px)); }
  to   { opacity: 1; transform: none; }
}
@keyframes barDown {
  from { opacity: 1; transform: none; }
  to   { opacity: 0; transform: translateY(calc(100% + 16px)); }
}
</style>
