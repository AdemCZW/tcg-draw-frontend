import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  // 跟 vite.config.ts 的 base 同步，否則 GitHub Pages 的 /tcg-draw-frontend/
  // 前綴會讓路由比對失敗（router 以為自己在網域根目錄）。
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', component: () => import('@/pages/HomePage.vue') },
    { path: '/pools', component: () => import('@/pages/PoolListPage.vue') },
    { path: '/pools/:id', component: () => import('@/pages/PoolDetailPage.vue') },
    { path: '/pools/:id/pick', component: () => import('@/pages/TicketPickPage.vue') },
    { path: '/pools/:id/streak', component: () => import('@/pages/StreakRunPage.vue') },
    { path: '/draw/:drawId', component: () => import('@/pages/DrawResultPage.vue') },
    { path: '/sellers/:id', component: () => import('@/pages/SellerPage.vue') },
    { path: '/seller/new', component: () => import('@/pages/SellerNewPoolPage.vue') },
    { path: '/fairness', component: () => import('@/pages/FairnessPage.vue') },
    // 未列在導覽的設計展示頁，改配色時用來一次比對所有變體
    { path: '/design/pack', component: () => import('@/pages/DesignPackPage.vue') },
    { path: '/fairness/:poolId', component: () => import('@/pages/FairnessPoolPage.vue') },
    { path: '/me/cards', component: () => import('@/pages/MyCardsPage.vue') },
    { path: '/me/wallet', component: () => import('@/pages/WalletPage.vue') },
    { path: '/topup', component: () => import('@/pages/TopupPage.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ],
  scrollBehavior: () => ({ top: 0 })
})
