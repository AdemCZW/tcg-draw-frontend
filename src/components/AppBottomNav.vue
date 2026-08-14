<script setup lang="ts">
// 手機底部導覽 —— 桌機隱藏（桌機用 AppHeader 的橫向 nav）
// 圖示用線條 SVG 而非 emoji：emoji 在各平台字面差異大、也偏卡通
const items = [
  { to: '/', label: '首頁', icon: 'home', exact: true },
  { to: '/pools', label: '抽選中', icon: 'grid', exact: false },
  { to: '/seller/new', label: '開池', icon: 'plus', exact: false },
  { to: '/me/cards', label: '卡冊', icon: 'book', exact: false },
  { to: '/me/wallet', label: '錢包', icon: 'wallet', exact: false }
]

const paths: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5',
  grid: 'M4 5h6v6H4zM14 5h6v6h-6zM4 13h6v6H4zM14 13h6v6h-6z',
  plus: 'M12 5v14M5 12h14',
  book: 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM18 16H7a2 2 0 0 0-2 2',
  wallet: 'M4 8a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v1M4 8v9a2 2 0 0 0 2 2h12a1 1 0 0 0 1-1v-3M4 8h14M20 11v4h-4a2 2 0 0 1 0-4z'
}
</script>

<template>
  <nav class="bnav" aria-label="主導覽">
    <RouterLink
      v-for="it in items" :key="it.to"
      :to="it.to"
      class="item"
      :class="{ on: it.exact ? $route.path === it.to : $route.path.startsWith(it.to) }"
    >
      <svg class="ic" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path :d="paths[it.icon]" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="lb">{{ it.label }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.bnav {
  display: none;
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 60;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: saturate(180%) blur(16px);
  border-top: 1px solid var(--line-soft);
  padding-bottom: var(--safe-b);
  padding-left: var(--safe-l);
  padding-right: var(--safe-r);
  overflow: hidden; /* 5 等分的次像素進位會多撐出 1px */
}
.item {
  flex: 1 1 0;
  min-width: 0;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 9px 2px 8px;
  font-size: 11px; font-weight: 500;
  color: var(--muted);
  min-height: var(--nav-h);
  justify-content: center;
}
.ic { width: 21px; height: 21px; }
.item.on { color: var(--accent); }
.item.on .lb { font-weight: 600; }
.item:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
@media (max-width: 720px) {
  .bnav { display: flex; }
}
</style>
