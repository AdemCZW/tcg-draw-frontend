import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
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
    { path: '/fairness/:poolId', component: () => import('@/pages/FairnessPoolPage.vue') },
    { path: '/me/cards', component: () => import('@/pages/MyCardsPage.vue') },
    { path: '/me/wallet', component: () => import('@/pages/WalletPage.vue') },
    { path: '/topup', component: () => import('@/pages/TopupPage.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ],
  scrollBehavior: () => ({ top: 0 })
})
