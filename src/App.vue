<script setup lang="ts">
import AppHeader from '@/components/AppHeader.vue'
import AppBottomNav from '@/components/AppBottomNav.vue'
</script>

<template>
  <AppHeader />
  <main>
    <RouterView />
  </main>
  <AppBottomNav />
  <footer class="foot">
    <div class="container">
      <span class="mono muted">VaultDraw · 定量池鑑定卡抽選</span>
      <span class="muted links">
        <RouterLink to="/fairness">公平性</RouterLink> ·
        <a href="#">會員條款</a> ·
        <a href="#">隱私權政策</a>
      </span>
      <span class="muted fine">碎片僅可兌換商品，不可兌換現金或轉讓。未滿 18 歲需監護人同意方可使用。</span>
    </div>
  </footer>
</template>

<style scoped>
.foot { border-top: 1px solid var(--line); margin-top: 40px; padding: 26px 0 40px; font-size: 12.5px; }
.foot .container { display: grid; gap: 6px; }
.links a { color: var(--muted); }
.fine { font-size: 11.5px; color: var(--faint); }
/* 讓底部導覽不遮住頁尾 */
@media (max-width: 720px) {
  .foot { padding-bottom: calc(40px + 56px + env(safe-area-inset-bottom, 0px)); }
}
</style>
