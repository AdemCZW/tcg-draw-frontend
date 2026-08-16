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
    /** 要登入才能進；沒登入導回形象頁並記住原本要去哪 */
    requiresAuth?: boolean
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
      /* 形象頁：極簡、登入／註冊。已登入者由 beforeEach 直接送進大廳 */
      path: '/', name: 'landing',
      component: () => import('@/pages/LandingPage.vue'),
      meta: { depth: 0, chrome: 'none', title: '鑑定卡線上抽選' }
    },
    {
      path: '/lobby', name: 'home',
      component: () => import('@/pages/LobbyPage.vue'),
      meta: { depth: 0, title: '大廳' }
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
      meta: { requiresAuth: true, depth: 3, chrome: 'none', title: '選籤' }
    },
    {
      path: '/pools/:id/streak', name: 'streak',
      component: () => import('@/pages/StreakRunPage.vue'),
      meta: { requiresAuth: true, depth: 3, chrome: 'none', title: '連莊' }
    },
    {
      path: '/draw/:drawId', name: 'draw-result',
      component: () => import('@/pages/DrawResultPage.vue'),
      meta: { requiresAuth: true, depth: 4, chrome: 'none', title: '開卡結果' }
    },
    {
      path: '/sellers/:id', name: 'seller',
      component: () => import('@/pages/SellerPage.vue'),
      meta: { depth: 2 }
    },
    {
      path: '/seller/new', name: 'seller-new',
      component: () => import('@/pages/SellerNewPoolPage.vue'),
      meta: { requiresAuth: true, depth: 1, title: '開池' }
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
      meta: { requiresAuth: true, depth: 1, title: '我的' }
    },
    {
      path: '/me/cards', name: 'cards',
      component: () => import('@/pages/MyCardsPage.vue'),
      meta: { requiresAuth: true, depth: 1, title: '我的卡冊' }
    },
    {
      path: '/me/wallet', name: 'wallet',
      component: () => import('@/pages/WalletPage.vue'),
      meta: { requiresAuth: true, depth: 1, title: '錢包' }
    },
    {
      path: '/me/wallet/topup', name: 'topup',
      component: () => import('@/pages/TopupPage.vue'),
      meta: { requiresAuth: true, depth: 2, title: '儲值' }
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

/* 登入守衛。
   - 沒登入去要登入的頁：導回形象頁，redirect query 記原本要去哪，登入後送回去
   - 已登入去形象頁：直接進大廳（形象頁對已登入的人沒有意義） */
router.beforeEach(async (to) => {
  const { useAuthStore } = await import('@/stores/auth')
  const auth = useAuthStore()
  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: 'landing', query: { redirect: to.fullPath } }
  }
  if (to.name === 'landing' && auth.isLoggedIn) {
    return { name: 'home' }
  }
})

/* 共享元素轉場（View Transitions API）。
   把「舊畫面 → 新畫面」的 DOM 更新包進 startViewTransition，同名的元素
   （pool-cover-{id}）會從舊位置滑到新位置。只在「池卡 → 池詳情」這條路啟用：
   其他換頁維持 App.vue 的 <Transition>；兩者同時作用會打架。
   不支援的瀏覽器（Firefox）走一般轉場，功能不受影響。

   時序是關鍵：startViewTransition 的 callback 必須「等新 DOM 畫好」才 return，
   否則它拍到的新畫面還是舊的。做法：beforeResolve 開一個 promise 擋住導航，
   把「放行導航」放進 transition callback，callback 再等 afterEach 通知
   「新 DOM 已掛」（nextTick 之後）才結束。 */
/* startViewTransition 的型別由 lib.dom 提供（TS 5.x 已內建），不要自己 declare —— 會跟內建衝突 */
let vtSettle: (() => void) | null = null
router.beforeResolve((to, from) => {
  const cardToPool = from.name === 'pool-index' || from.name === 'play' || from.name === 'home'
  const intoPool = String(to.name ?? '').startsWith('pool-')
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!document.startViewTransition || !cardToPool || !intoPool || reduce) return
  document.documentElement.dataset.vt = '1'
  return new Promise<void>(release => {
    document.startViewTransition?.(() => new Promise<void>(done => {
      vtSettle = done       // afterEach + nextTick 會呼叫它：新 DOM 已在畫面上
      release()             // 放行導航 → 路由切換 → 元件掛載
    })).finished.finally(() => { delete document.documentElement.dataset.vt; vtSettle = null })
  })
})

router.afterEach((to) => {
  const t = to.meta.title
  document.title = t ? `${t} — ${SITE}` : `${SITE} — 鑑定卡線上抽選`
  // View Transition 在等新 DOM：下一個 tick 元件已掛上，通知它可以拍新畫面了
  if (vtSettle) { const done = vtSettle; vtSettle = null; setTimeout(done, 0) }
})
