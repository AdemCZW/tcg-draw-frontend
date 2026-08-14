<script setup lang="ts">
/**
 * 404。
 *
 * 之前 router 是 `{ path: '/:pathMatch(.*)*', redirect: '/' }` —— 打錯網址會被
 * 靜默丟回首頁。使用者不知道自己打錯（以為那個池被下架了），history 還多一筆
 * 假紀錄，按上一頁會彈回錯誤網址再被導走一次。寧可誠實說「這個網址不存在」。
 */
import { useRoute } from 'vue-router'

const route = useRoute()
</script>

<template>
  <div class="container page">
    <p class="code mono">404</p>
    <h1 class="display">找不到這個頁面</h1>
    <p class="muted lede">這個網址不存在，或是已經被移除了。</p>
    <p class="mono path">{{ route.fullPath }}</p>

    <div class="acts">
      <RouterLink :to="{ name: 'pool-index' }" class="btn primary">看抽選中的池</RouterLink>
      <RouterLink :to="{ name: 'home' }" class="btn">回首頁</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.page { padding-top: 80px; padding-bottom: 100px; max-width: 640px; }
.code {
  font-size: 13px; letter-spacing: .24em; color: var(--accent);
  margin: 0 0 10px;
}
h1 { font-size: 34px; margin: 0 0 12px; }
.lede { font-size: 16px; margin: 0 0 20px; }
.path {
  font-size: 12.5px; color: var(--faint);
  background: var(--surface); border: 1px solid var(--line);
  border-radius: 10px; padding: 10px 14px;
  margin: 0 0 28px;
  overflow-wrap: anywhere;
}
.acts { display: flex; gap: 12px; flex-wrap: wrap; }
@media (max-width: 720px) {
  .page { padding-top: 48px; }
  h1 { font-size: 26px; }
  .acts .btn { flex: 1 1 auto; text-align: center; }
}
</style>
