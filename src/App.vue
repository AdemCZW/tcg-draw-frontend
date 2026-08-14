<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import AppBottomNav from '@/components/AppBottomNav.vue'

const route = useRoute()

/**
 * 沉浸模式的頁面不掛全域外框。
 *
 * 開卡演出頁掛著頁尾的「會員條款 · 隱私權政策」與未滿 18 歲警語，
 * 是這個介面最違和的一處；底部導覽也會跟頁面自己的固定操作列打架。
 * 由 route meta 宣告，不要在 App.vue 裡比對路徑 —— 那會隨著拆頁一直改。
 */
const chrome = computed(() => route.meta.chrome ?? 'full')
const showChrome = computed(() => chrome.value !== 'none')
</script>

<template>
  <AppHeader v-if="showChrome" />
  <main>
    <RouterView />
  </main>
  <AppBottomNav v-if="showChrome" />
  <footer v-if="showChrome" class="foot">
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
</style>
