<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import AppBottomNav from '@/components/AppBottomNav.vue'
import NotifyBell from '@/components/NotifyBell.vue'

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
    // 這次換頁若交給了 View Transitions（router 會在 <html> 上標記），Vue 的轉場讓路
    if (document.documentElement.dataset.vt) transitionName.value = 'none'
    else if (route.name === 'draw-result') transitionName.value = 'flash'
    else if (to > from) transitionName.value = 'push'
    else if (to < from) transitionName.value = 'pop'
    else transitionName.value = 'fade'
  }
)
</script>

<template>
  <AppHeader v-if="showChrome" />
  <main>
    <RouterView v-slot="{ Component }">
      <!-- :duration 明寫：mode="out-in" 靠 transitionend 事件切頁，
           在被節流的分頁裡那個事件可能永遠不來，新頁就永遠進不來。
           給明確時長後 Vue 改用計時器，時間到一定切。 -->
      <Transition :name="transitionName" mode="out-in" :duration="{ enter: 420, leave: 220 }">
        <component :is="Component" :key="route.fullPath" />
      </Transition>
    </RouterView>
  </main>
  <AppBottomNav v-if="showChrome" />
  <!-- 通知鈴固定在右下角。跟著 showChrome 走：沉浸模式（開卡演出、選籤牆）
       不該有東西浮在畫面上搶注意力 -->
  <NotifyBell v-if="showChrome" />
  <footer v-if="showChrome && route.name !== 'home'" class="foot">
    <div class="container">
      <span class="mono muted">VaultDraw · 定量池鑑定卡抽選</span>
      <span class="muted links">
        <RouterLink :to="{ name: 'fairness' }">公平性</RouterLink> ·
        <a href="#">會員條款</a> ·
        <a href="#">隱私權政策</a>
      </span>
      <!-- 點數不可提現的聲明暫時拿掉（使用者要求）。
           那句話是對外的公開聲明，跟「點數只能在站內流通」這條產品底線是一組的，
           正式營運前要放回來，或至少收進會員條款頁。 -->
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
