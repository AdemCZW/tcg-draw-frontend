<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import AppBottomNav from '@/components/AppBottomNav.vue'

const route = useRoute()

/**
 * 沉浸模式的頁面不掛全域外框。
 * 由 route meta 宣告，不要在 App.vue 裡比對路徑 —— 那會隨著拆頁一直改。
 */
const chrome = computed(() => route.meta.chrome ?? 'full')
const showChrome = computed(() => chrome.value !== 'none')

/**
 * 頁面轉場方向。
 * 往深層（depth 變大）從右滑入，返回（depth 變小）從左滑入，同層淡入淡出。
 * 進開卡結果頁另有一支「白閃放大」—— 那是儀式的入口，不該跟一般換頁一樣。
 * 方向要在 route 變的那一刻決定並凍住，不能在 transition 進行中再變。
 */
const transitionName = ref('fade')
watch(
  () => route.meta.depth ?? 0,
  (to, from) => {
    /* 分頁看不見的時候完全不做轉場（真正的關閉在 :css="!tabHidden"，
       見下方說明；這裡把名字也設成 none 只是不要留下無意義的 class）。
       Vue 移除 *-enter-from 這個 class 是排在 requestAnimationFrame 裡的，
       而 rAF 在隱藏／被節流的分頁不會執行 —— 轉場會永遠停在中途，
       新頁面進不來，使用者看到的是「點了沒反應」。
       :duration 只讓 Vue 用計時器呼叫 done()，救不了卡住的 class。

       實測（正式站）：切到市場後元素停在
       `lobby fade-enter-from push-leave-from push-leave-active` 超過 3 秒不動。

       反正看不見的時候也沒有人在看動畫，直接跳過最安全。 */
    if (tabHidden.value) transitionName.value = 'none'
    // 這次換頁若交給了 View Transitions（router 會在 <html> 上標記），Vue 的轉場讓路
    else if (document.documentElement.dataset.vt) transitionName.value = 'none'
    else if (route.name === 'draw-result') transitionName.value = 'flash'
    else if (to > from) transitionName.value = 'push'
    else if (to < from) transitionName.value = 'pop'
    else transitionName.value = 'fade'
  }
)

/* 回到前景時，把可能卡在中途的轉場 class 清掉。
   上面那條只擋「導航發生時分頁是隱藏的」；如果是導航開始後才被切走，
   class 已經加上去了，回來時 rAF 雖然恢復，但 Vue 那次 nextFrame 的
   callback 早就被丟掉，不會有人來收尾。 */
/* :name="none" 沒有真的關掉轉場 —— Vue 照樣套 none-leave-* 的 class、
   照樣走那套要等 requestAnimationFrame 的狀態機，所以還是會卡住（實測過）。
   真正跳過的開關是 :css="false"：那會讓 Vue 完全不碰 CSS class，
   也不等 rAF，直接把新頁面換上去。 */
const tabHidden = ref(document.hidden)

function clearStuckTransition() {
  if (document.hidden) return
  document.querySelectorAll(
    '[class*="-enter-from"], [class*="-leave-from"], [class*="-leave-active"]'
  ).forEach(el => {
    el.classList.forEach(c => {
      if (/-(enter|leave)-(from|active|to)$/.test(c)) el.classList.remove(c)
    })
  })
}
function onVisibility() {
  tabHidden.value = document.hidden
  clearStuckTransition()
}
document.addEventListener('visibilitychange', onVisibility)
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisibility))
</script>

<template>
  <AppHeader v-if="showChrome" />
  <main>
    <RouterView v-slot="{ Component }">
      <!-- :duration 明寫：mode="out-in" 靠 transitionend 事件切頁，
           在被節流的分頁裡那個事件可能永遠不來，新頁就永遠進不來。
           給明確時長後 Vue 改用計時器，時間到一定切。 -->
      <Transition
        :name="transitionName" mode="out-in"
        :duration="{ enter: 420, leave: 220 }"
        :css="!tabHidden"
      >
        <component :is="Component" :key="route.fullPath" />
      </Transition>
    </RouterView>
  </main>
  <AppBottomNav v-if="showChrome" />
  <footer v-if="showChrome && route.name !== 'home'" class="foot">
    <div class="container">
      <span class="mono muted">VaultDraw · 定量池鑑定卡抽選</span>
      <span class="muted links">
        <RouterLink :to="{ name: 'fairness' }">公平性</RouterLink> ·
        <a href="#">會員條款</a> ·
        <a href="#">隱私權政策</a>
      </span>
      <span class="muted fine">點數僅可用於站內抽選與兌換商品，不可提領現金或轉讓。未滿 18 歲需監護人同意方可使用。</span>
    </div>
  </footer>
</template>

<style scoped>
.foot { border-top: 1px solid var(--line); margin-top: 40px; padding: 26px 0 40px; font-size: 12.5px; }
.foot .container { display: grid; gap: 6px; }
.links a { color: var(--muted); }
.fine { font-size: 11.5px; color: var(--faint); }
/* 讓底部導覽不遮住頁尾。--nav-total 在桌機是 0，不需要再包一層斷點 */
.foot { padding-bottom: calc(40px + var(--nav-total)); }

/* ---- 頁面轉場 ----
   全部很短（180–260ms）：轉場是「換頁的手感」不是動畫秀，
   太長會讓人覺得網站慢。 */
@media (prefers-reduced-motion: no-preference) {
  .fade-enter-active, .fade-leave-active { transition: opacity .18s ease; }
  .fade-enter-from, .fade-leave-to { opacity: 0; }

  .push-enter-active, .push-leave-active,
  .pop-enter-active, .pop-leave-active {
    transition: opacity .22s ease, transform .26s cubic-bezier(.2, .8, .3, 1);
  }
  .push-enter-from { opacity: 0; transform: translateX(28px); }
  .push-leave-to   { opacity: 0; transform: translateX(-16px); }
  .pop-enter-from  { opacity: 0; transform: translateX(-28px); }
  .pop-leave-to    { opacity: 0; transform: translateX(16px); }

  /* 進開卡頁：從 94% 放大到 100%，帶一層白閃 —— 儀式的門 */
  .flash-enter-active { transition: opacity .3s ease, transform .42s cubic-bezier(.2, .9, .3, 1); }
  .flash-enter-from { opacity: 0; transform: scale(.94); }
  .flash-leave-active { transition: opacity .16s ease; }
  .flash-leave-to { opacity: 0; }
}
</style>
