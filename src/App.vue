<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import AppBottomNav from '@/components/AppBottomNav.vue'
import { FAIRNESS_UI } from '@/lib/config'

const route = useRoute()

/**
 * 沉浸模式的頁面不掛全域外框。
 * 由 route meta 宣告，不要在 App.vue 裡比對路徑 —— 那會隨著拆頁一直改。
 */
const chrome = computed(() => route.meta.chrome ?? 'full')
const showChrome = computed(() => chrome.value !== 'none')

</script>

<template>
  <AppHeader v-if="showChrome" />
  <main>
    <!--
      這裡刻意沒有換頁轉場。

      原本包著一層 <Transition mode="out-in">，它造成過三種真實故障：

        1. 頁面整個 opacity: 0 —— 有渲染但看不見（使用者回報「點下去沒任何反應」）
        2. .page 卡在 transform: translateX(28px) —— 整頁偏移，
           而且**祖先有 transform 時 position: fixed 會改以它為基準**，
           頁面裡所有覆蓋層跟著錯位、被裁掉
        3. 元件根本沒被換掉 —— mode="out-in" 要等離場結束才讓新頁進來，
           離場一卡住，網址與標題都變了但畫面停在上一頁

      根因是 Vue 的 Transition 依賴 requestAnimationFrame 來切換
      `-enter-from` / `-leave-to`，而那一步**不受 :duration 計時器保護**。
      rAF 一旦被節流（背景分頁、iOS Safari 省電、系統忙碌）就整個卡死。

      我試過兩種修法（改寫 class 時序、改用 @keyframes），都還是脆弱。
      換頁轉場買到的只有「手感」，賠掉的是「頁面到底看不看得見」——
      這個交換不划算，所以拿掉。

      池卡 → 池詳情那條共享元素轉場不受影響：它走 View Transitions API，
      在 router 裡自己判斷、不支援就自動跳過（見 router/index.ts 的 beforeResolve）。
    -->
    <RouterView />
  </main>
  <AppBottomNav v-if="showChrome" />
  <!-- 通知鈴固定在右下角。跟著 showChrome 走：沉浸模式（開卡演出、選籤牆）
       不該有東西浮在畫面上搶注意力 -->
  <footer v-if="showChrome && route.name !== 'home'" class="foot">
    <div class="container">
      <span class="mono muted">VaultDraw · 定量池鑑定卡抽選</span>
      <span class="muted links">
        <!-- 公平性入口暫時收起來（見 lib/config.ts 的 FAIRNESS_UI）。
             連結與它後面那個「·」綁在同一個 <template> 裡一起進出 ——
             分開寫的話收起來會變成「 · 會員條款 · 隱私權政策」，
             行首多一個沒有東西可分隔的間隔點。 -->
        <template v-if="FAIRNESS_UI">
          <RouterLink :to="{ name: 'fairness' }">公平性</RouterLink> ·
        </template>
        <RouterLink :to="{ name: 'terms' }">會員條款</RouterLink> ·
        <RouterLink :to="{ name: 'privacy' }">隱私權政策</RouterLink>
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
/* 觸控目標補到 44px：12.5px 的字約 15px 高，上下各補 15px 的內距。
   同時給等量的負外距抵銷掉，所以頁尾的視覺高度一個像素都沒變 ——
   長出來的只有可以點的範圍。相鄰的兩列都不是互動元素，重疊無害。 */
.links a {
  color: var(--muted);
  display: inline-block; padding: 15px 6px; margin: -15px 0;
}
.fine { font-size: 11.5px; color: var(--faint); }

/* ------------------------------------------------------------------
   底部固定導覽的讓位：有頁尾的頁面只在這裡做一次
   ------------------------------------------------------------------
   頁尾是除了大廳以外每一頁文件裡的最後一塊，導覽是 fixed，
   能遮到的也只有最後一塊 —— 所以讓位只能有這一個來源。

   之前各頁的根容器也在自己的 padding-bottom 裡加了一次 --nav-total，
   而它們下面還接著頁尾，那一份讓位永遠沒東西可以讓 —— 兩份相加，
   手機上（--nav-total = 56px + 安全區）每頁下緣就多出一段捲不到內容的黑。
   iPhone 上還要再多算一次 34px 的 Home 指示器。

   大廳（name === 'home'）沒有頁尾，它的讓位由自己的最後一區負責，
   一樣是只有一個來源。
------------------------------------------------------------------- */
.foot { padding-bottom: calc(40px + var(--nav-total)); }

/* 手機上頁尾只是兩行小字，桌機的留白原封不動搬過來會在每頁最底下
   堆出快半個螢幕的空白。讓位仍然只靠 --nav-total 一個來源。 */
@media (max-width: 720px) {
  .foot { margin-top: 28px; padding-top: 20px; padding-bottom: calc(16px + var(--nav-total)); }
}

/* 換頁轉場已移除（原因見上方 <main> 裡的說明）。
   元件內部的小轉場（跑馬燈、通知面板、池的分頁切換）不受影響 ——
   那些不會擋住整頁的顯示。 */
</style>
