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
        <!-- 聯絡客服排在最前面（公平性之後）：頁尾是全站唯一每一頁都有的
             出口，而這條連結的目標對象是「卡住了、找不到人講」的人 ——
             他不會先去讀條款再找信箱。而且這一頁不需要登入，所以連
             形象頁的頁尾也連得過去（同 /terms 與 /privacy 的理由）。 -->
        <RouterLink :to="{ name: 'contact' }">聯絡客服</RouterLink> ·
        <RouterLink :to="{ name: 'terms' }">會員條款</RouterLink> ·
        <RouterLink :to="{ name: 'privacy' }">隱私權政策</RouterLink>
      </span>
      <!-- 點數不可提現的聲明暫時拿掉（使用者要求）。
           那句話是對外的公開聲明，跟「點數只能在站內流通」這條產品底線是一組的，
           正式營運前要放回來，或至少收進會員條款頁。 -->
    </div>
  </footer>
  <!--
    底部固定導覽的讓位 —— 全站唯一的一塊。

    跟著 showChrome 走，因為它就是 <AppBottomNav> 的出現條件：
    有導覽才有東西要讓，沒有導覽（沉浸模式）就連這一塊都不該存在。
    大廳沒有頁尾，這一塊照樣在 —— 讓位不再跟「有沒有頁尾」綁在一起。
  -->
  <div v-if="showChrome" class="navClear" aria-hidden="true" />
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
   底部固定導覽的讓位：整份文件只有 .navClear 這一塊
   ------------------------------------------------------------------
   導覽是 fixed，它能遮到的永遠只有「文件的最末端」，所以讓位只需要一份。

   ── 上一次為什麼沒修乾淨 ────────────────────────────────────────
   71beffb 已經把各頁重複的讓位收掉過一次，但當時是把唯一來源設成
   「全域頁尾的 padding-bottom」。那個選擇有兩個弱點，而它們正是這個問題
   會再回來的原因：

     1. 大廳沒有頁尾，所以它必須自己記得再寫一份 var(--nav-total)。
        「有頁尾的頁面不要寫、沒頁尾的頁面要寫」這種規則，只活在註解裡。
     2. 頁面容器寫 padding-bottom 是天經地義的事，沒有任何東西擋著
        下一個人在裡面又加一次 var(--nav-total)。57d2cc6 就是這樣在
        PlayPage 上加了回來（實測手機比桌機多出 74px 的黑帶）。

   改成一塊獨立的 .navClear 之後，讓位跟「哪個元素剛好在最後」脫鉤：
   頁面只要管自己的留白，永遠不必碰 --nav-total（規則寫在 tokens.css）。
   桌機的 --nav-total 是 0，這塊高度就是 0，等於不存在。
------------------------------------------------------------------- */
.navClear { height: var(--nav-total); }

.foot { padding-bottom: 40px; }

/* 手機上頁尾只是兩行小字，桌機的留白原封不動搬過來會在每頁最底下
   堆出快半個螢幕的空白。這裡是純粹的視覺留白，不含任何讓位。 */
@media (max-width: 720px) {
  .foot { margin-top: 28px; padding-top: 20px; padding-bottom: 16px; }
}

/* 換頁轉場已移除（原因見上方 <main> 裡的說明）。
   元件內部的小轉場（跑馬燈、通知面板、池的分頁切換）不受影響 ——
   那些不會擋住整頁的顯示。 */
</style>
