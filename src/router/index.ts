import { createRouter, createWebHistory } from 'vue-router'

/**
 * 外框樣式。頁面自己宣告要不要全域的 header / 底部導覽 / 頁尾。
 *  - full    一般頁面，三者都在
 *  - none    沉浸模式：開卡演出這種頁面不該同時出現全域導覽與頁面自己的操作列
 *
 * 走 none 的頁面：開卡結果（自己有三個出口）、選籤牆、連莊進行中
 * （後兩者用 ImmersiveBar 提供返回鍵，並在有未完成動作時攔截離開）。
 */
export type Chrome = 'full' | 'none'

declare module 'vue-router' {
  interface RouteMeta {
    chrome?: Chrome
    /** 導覽深度，之後做轉場方向判斷用（往深層滑入、返回滑出） */
    depth?: number
    /** 分頁標題，afterEach 會套上 */
    title?: string
  }
}

const SITE = 'VAULT DRAW'

export const router = createRouter({
  // 跟 vite.config.ts 的 base 同步，否則 GitHub Pages 的 /tcg-draw-frontend/
  // 前綴會讓路由比對失敗（router 以為自己在網域根目錄）。
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/', name: 'home',
      component: () => import('@/pages/HomePage.vue'),
      meta: { depth: 0, title: '鑑定卡線上抽選' }
    },
    {
      path: '/play', name: 'play',
      component: () => import('@/pages/PlayPage.vue'),
      meta: { depth: 1, title: '挑池' }
    },
    {
      path: '/pools', name: 'pool-index',
      component: () => import('@/pages/PoolListPage.vue'),
      meta: { depth: 1, title: '抽選中' }
    },
    {
      /* 池：外殼 + 三個 tab 子頁。外殼負責標題列、tab、桌機側欄與「找不到」的 fallback；
         子頁只管內容。tab 用 replace 切換，返回鍵直接跳出池。 */
      path: '/pools/:id',
      component: () => import('@/pages/pool/PoolShell.vue'),
      meta: { depth: 2 },
      children: [
        { path: '', name: 'pool', redirect: { name: 'pool-overview' } },
        {
          path: 'overview', name: 'pool-overview',
          component: () => import('@/pages/pool/PoolOverview.vue'),
          meta: { depth: 2, title: '池' }
        },
        {
          path: 'prizes', name: 'pool-prizes',
          component: () => import('@/pages/pool/PoolPrizes.vue'),
          meta: { depth: 2, title: '獎項' }
        },
        {
          path: 'proof', name: 'pool-proof',
          component: () => import('@/pages/pool/PoolProof.vue'),
          meta: { depth: 2, title: '驗證' }
        }
      ]
    },
    {
      path: '/pools/:id/pick', name: 'pool-pick',
      component: () => import('@/pages/TicketPickPage.vue'),
      meta: { depth: 3, chrome: 'none', title: '選籤' }
    },
    {
      path: '/pools/:id/streak', name: 'streak',
      component: () => import('@/pages/StreakRunPage.vue'),
      meta: { depth: 3, chrome: 'none', title: '連莊' }
    },
    {
      path: '/draw/:drawId', name: 'draw-result',
      component: () => import('@/pages/DrawResultPage.vue'),
      meta: { depth: 4, chrome: 'none', title: '開卡結果' }
    },
    {
      path: '/sellers/:id', name: 'seller',
      component: () => import('@/pages/SellerPage.vue'),
      meta: { depth: 2 }
    },
    {
      path: '/seller/new', name: 'seller-new',
      component: () => import('@/pages/SellerNewPoolPage.vue'),
      meta: { depth: 1, title: '開池' }
    },
    {
      path: '/fairness', name: 'fairness',
      component: () => import('@/pages/FairnessPage.vue'),
      meta: { depth: 1, title: '公平性驗證' }
    },
    {
      path: '/fairness/:poolId', name: 'fairness-pool',
      component: () => import('@/pages/FairnessPoolPage.vue'),
      meta: { depth: 2, title: '驗算' }
    },
    {
      path: '/me', name: 'me',
      component: () => import('@/pages/MePage.vue'),
      meta: { depth: 1, title: '我的' }
    },
    {
      path: '/me/cards', name: 'cards',
      component: () => import('@/pages/MyCardsPage.vue'),
      meta: { depth: 1, title: '我的卡冊' }
    },
    {
      path: '/me/wallet', name: 'wallet',
      component: () => import('@/pages/WalletPage.vue'),
      meta: { depth: 1, title: '錢包' }
    },
    {
      path: '/me/wallet/topup', name: 'topup',
      component: () => import('@/pages/TopupPage.vue'),
      meta: { depth: 2, title: '儲值' }
    },
    // 儲值原本在頂層 /topup。它是錢包的子功能，搬進 /me/wallet 底下；
    // 舊路徑留一版 redirect，避免使用者的書籤壞掉
    { path: '/topup', redirect: { name: 'topup' } },
    // 未列在導覽的設計展示頁，改配色時用來一次比對所有變體
    {
      path: '/design/pack', name: 'design-pack',
      component: () => import('@/pages/DesignPackPage.vue'),
      meta: { depth: 1, title: '寶貝球設計' }
    },
    {
      path: '/:pathMatch(.*)*', name: 'not-found',
      component: () => import('@/pages/NotFoundPage.vue'),
      meta: { depth: 0, title: '找不到頁面' }
    }
  ],

  /**
   * 返回時還原捲動位置。
   * 原本是無條件 `{ top: 0 }` —— 從池詳情按上一頁回列表，捲了三十張卡的位置全丟。
   * savedPosition 只有在瀏覽器的前進／後退時才有值，一般 push 仍然回到頂端。
   */
  scrollBehavior(to, _from, savedPosition) {
    if (savedPosition) return savedPosition
    if (to.hash) return { el: to.hash, behavior: 'smooth' }
    return { top: 0 }
  }
})

router.afterEach((to) => {
  const t = to.meta.title
  document.title = t ? `${t} — ${SITE}` : `${SITE} — 鑑定卡線上抽選`
})
