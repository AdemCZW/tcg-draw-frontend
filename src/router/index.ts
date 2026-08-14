import { createRouter, createWebHistory } from 'vue-router'

/**
 * 外框樣式。頁面自己宣告要不要全域的 header / 底部導覽 / 頁尾。
 *  - full    一般頁面，三者都在
 *  - none    沉浸模式：開卡演出這種頁面不該同時出現全域導覽與頁面自己的操作列
 *
 * 目前只有開卡結果頁走 none —— 它自己有「收進卡冊 / 再抽一次 / 自己驗算」三個出口。
 * 選籤牆與連莊進行中同樣該沉浸，但它們現在沒有任何返回控制，
 * 直接拿掉導覽會把人困在頁面裡，等 Phase 3 拆頁補上返回鍵再切。
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
      path: '/pools/:id', name: 'pool',
      component: () => import('@/pages/PoolDetailPage.vue'),
      meta: { depth: 2 }
    },
    {
      path: '/pools/:id/pick', name: 'pool-pick',
      component: () => import('@/pages/TicketPickPage.vue'),
      meta: { depth: 3, title: '選籤' }
    },
    {
      path: '/pools/:id/streak', name: 'streak',
      component: () => import('@/pages/StreakRunPage.vue'),
      meta: { depth: 3, title: '連莊' }
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
      path: '/topup', name: 'topup',
      component: () => import('@/pages/TopupPage.vue'),
      meta: { depth: 2, title: '儲值' }
    },
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
