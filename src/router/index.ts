import { createRouter, createWebHistory } from 'vue-router'
import { applySeo } from '@/lib/seo'

/**
 * 外框樣式。頁面自己宣告要不要全域的 header / 底部導覽 / 頁尾。
 *  - full    一般頁面，三者都在
 *  - none    沉浸模式：開卡演出這種頁面不該同時出現全域導覽與頁面自己的操作列
 *
 * 走 none 的頁面：開卡結果（自己有三個出口）、選籤牆
 * （後者用 ImmersiveBar 提供返回鍵，並在有未完成動作時攔截離開）。
 */
export type Chrome = 'full' | 'none'

declare module 'vue-router' {
  interface RouteMeta {
    chrome?: Chrome
    /** 要登入才能進；沒登入導回形象頁並記住原本要去哪 */
    requiresAuth?: boolean
    requiresAdmin?: boolean
    /** 導覽深度，之後做轉場方向判斷用（往深層滑入、返回滑出） */
    depth?: number
    /** 分頁標題，afterEach 會套上 */
    title?: string
  }
}

export const router = createRouter({
  // 跟 vite.config.ts 的 base 同步，否則 GitHub Pages 的 /tcg-draw-frontend/
  // 前綴會讓路由比對失敗（router 以為自己在網域根目錄）。
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      /* 形象頁：極簡、登入／註冊。已登入者由 beforeEach 直接送進大廳 */
      path: '/', name: 'landing',
      // LINE 登入完成後後端導回 /login#code=…；同一個元件，讓 fragment 原樣到達
      alias: '/login',
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
    // 「全部池」併進大廳 —— 兩頁回答的是同一個問題「現在有什麼可以開」，
    // 差別只是挑重點還是列全部，那是同一頁的上下半。舊路徑留 redirect
    { path: '/pools', redirect: { name: 'home' } },
    {
      path: '/market', name: 'market',
      component: () => import('@/pages/MarketPage.vue'),
      meta: { depth: 1, title: '市場' }
    },
    {
      /* 單張市場卡片。購買從列表搬到這裡 ——
         列表上的行內確認框是渲染在「主列表那一格」裡的，從上方的橫向捲軸
         點下去，確認框會跑到下面某一格去長出來；主列表分頁之後那一格
         甚至可能還沒載入，點了等於沒反應。
         刻意不要 requiresAuth：逛跟買是兩件事，連結分享出去要打得開，
         擋登入的是頁面裡的購買鍵。 */
      path: '/market/:id', name: 'market-listing',
      component: () => import('@/pages/MarketListingPage.vue'),
      meta: { depth: 2, title: '市場卡片' }
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
      /* 賣家的出貨與結算。放在 /seller 底下跟開池同一層 ——
         它們是同一個身分要做的兩件事（開池是進貨、出貨是履約），
         而不是「我的」底下的一項個人設定。 */
      path: '/seller/shipping', name: 'seller-shipping',
      component: () => import('@/pages/SellerShippingPage.vue'),
      meta: { requiresAuth: true, depth: 1, title: '出貨與結算' }
    },
    {
      /* 開卡演出的試看頁。刻意不掛進任何導覽 ——
         給開發與驗收用的，知道網址的人才進得來。 */
      path: '/fx', name: 'fx-lab',
      component: () => import('@/pages/FxLabPage.vue'),
      meta: { depth: 1, title: '開卡演出試看' }
    },
    {
      /* 卡片挑選器的試跑頁。跟 /fx 同一個性質：開發與驗收用，不掛進導覽。
         挑選器要接進開池表單之前，先在這裡單獨驗它帶回的卡片身分對不對。 */
      path: '/dev/card-picker', name: 'dev-card-picker',
      component: () => import('@/pages/DevCardPickerPage.vue'),
      meta: { depth: 1, title: '卡片挑選器試跑' }
    },
    {
      /* 公平性驗證的兩頁。**站內目前沒有任何地方連過來** ——
         入口被 FAIRNESS_UI（見 lib/config.ts）暫時收起來了，等之後要展示時
         把那個常數改成 true，十處入口一起回來。

         路由本身刻意留著不關，跟 /fx、/dev/card-picker 同一個性質：
         知道網址的人還是進得去，自己驗收不用改程式。而且後端的
         commit-reveal 與 /reveal 從來沒停過，這兩頁打開就是能用的，
         關掉路由只會多出一個「之後要記得復原」的地方。 */
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
      /* 卡片上傳入庫：把手上的實體卡登記進自己的卡冊。
         獨立一頁（不是卡冊裡的面板）—— 它有挑卡器 + 鑑定表單兩大塊，
         塞進覆蓋層會跟挑卡器自己的詳情面板疊在一起。 */
      path: '/me/cards/upload', name: 'upload-card',
      component: () => import('@/pages/CardUploadPage.vue'),
      meta: { requiresAuth: true, depth: 2, title: '登記卡片' }
    },
    {
      /* 上架到市場。定價獨立一頁而不是卡冊裡的行內表單 ——
         輸入框塞進格線的一格會把那一格撐開、隔壁擠扁（見 SellListingPage 的說明） */
      path: '/me/cards/sell', name: 'sell-cards',
      component: () => import('@/pages/SellListingPage.vue'),
      meta: { requiresAuth: true, depth: 2, title: '上架到市場' }
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
      path: '/me/orders', name: 'orders',
      component: () => import('@/pages/OrdersPage.vue'),
      meta: { requiresAuth: true, depth: 2, title: '我的訂單' }
    },
    {
      /* 交易邀約收發匣。要登入 —— 出價本身就是有金錢意義的動作 */
      path: '/me/offers', name: 'offers',
      component: () => import('@/pages/OffersPage.vue'),
      meta: { requiresAuth: true, depth: 2, title: '交易邀約' }
    },
    /* 公開卡冊。刻意不要 requiresAuth：分享連結的意義就是給沒帳號的人看。
       頁面內的「提出交易」按鈕才擋登入，看跟出價是兩件事。 */
    {
      path: '/u/:slug', name: 'public-cardbook',
      component: () => import('@/pages/PublicCardbookPage.vue'),
      meta: { depth: 1, title: '卡冊' }
    },
    {
      path: '/me/profile', name: 'profile',
      component: () => import('@/pages/ProfilePage.vue'),
      meta: { requiresAuth: true, depth: 2, title: '會員資料' }
    },
    /* 客服工單（使用者端）。放在頂層 /support 而不是 /me/support ——
       它是使用者被擋住時的出口，而擋住他的地方（建池、訂單、卡冊）散在整個站上，
       那些地方要指過來的是一個好記、好貼、跟身分無關的網址。

       /support/new 必須排在 /support/:id 前面，否則 'new' 會被當成單號。 */
    {
      path: '/support', name: 'support',
      component: () => import('@/pages/support/SupportListPage.vue'),
      meta: { requiresAuth: true, depth: 1, title: '我的問題' }
    },
    {
      path: '/support/new', name: 'support-new',
      component: () => import('@/pages/support/SupportNewPage.vue'),
      meta: { requiresAuth: true, depth: 2, title: '開新問題' }
    },
    {
      path: '/support/:id', name: 'support-ticket',
      component: () => import('@/pages/support/SupportTicketPage.vue'),
      meta: { requiresAuth: true, depth: 2, title: '問題詳情' }
    },
    /* 後台：自己的外殼與子路由，不套前台的 header／底部導覽（chrome: 'none'）。
       改成子路由而不是分頁狀態，是為了讓每一區有自己的網址 —— 客服要把
       某個會員的檔案轉給別人接手時，能直接貼連結。 */
    {
      path: '/admin',
      component: () => import('@/pages/console/ConsoleShell.vue'),
      meta: { requiresAuth: true, requiresAdmin: true, chrome: 'none', depth: 1 },
      children: [
        { path: '', name: 'admin', redirect: { name: 'console-overview' } },
        {
          path: 'overview', name: 'console-overview',
          component: () => import('@/pages/console/ConsoleOverview.vue'),
          meta: { title: '後台總覽' }
        },
        {
          path: 'shipments', name: 'console-shipments',
          component: () => import('@/pages/console/ConsoleShipments.vue'),
          meta: { title: '出貨' }
        },
        {
          path: 'users', name: 'console-users',
          component: () => import('@/pages/console/ConsoleUsers.vue'),
          meta: { title: '會員' }
        },
        {
          path: 'users/:id', name: 'console-user',
          component: () => import('@/pages/console/ConsoleUserDetail.vue'),
          meta: { title: '會員檔案' }
        },
        {
          path: 'pools', name: 'console-pools',
          component: () => import('@/pages/console/ConsolePools.vue'),
          meta: { title: '池' }
        },
        {
          path: 'sellers', name: 'console-sellers',
          component: () => import('@/pages/console/ConsoleSellers.vue'),
          meta: { title: '賣家審核' }
        },
        {
          path: 'disputes', name: 'console-disputes',
          component: () => import('@/pages/console/ConsoleDisputes.vue'),
          meta: { title: '爭議' }
        },
        {
          /* 客服工單。跟會員一樣是「列表 + 詳情各有自己的網址」——
             一張單常常要轉給別人接手，貼得出連結才轉得動。 */
          path: 'tickets', name: 'console-tickets',
          component: () => import('@/pages/console/ConsoleTickets.vue'),
          meta: { title: '客服工單' }
        },
        {
          path: 'tickets/:id', name: 'console-ticket',
          component: () => import('@/pages/console/ConsoleTicketDetail.vue'),
          meta: { title: '工單' }
        },
        {
          path: 'audit', name: 'console-audit',
          component: () => import('@/pages/console/ConsoleAudit.vue'),
          meta: { title: '稽核紀錄' }
        }
      ]
    },
    // 交易保護規格。不掛導覽列 —— 這頁是用連結分享出去給人看的，
    // 不是使用者日常會用的功能
    {
      path: '/trade-protection', name: 'trade-protection',
      component: () => import('@/pages/TradeProtectionPage.vue'),
      meta: { depth: 1, title: '交易保護機制' }
    },
    /* 會員條款與隱私權政策。
       跟 /trade-protection 一樣不掛進導覽列（頁尾的連結就是唯一入口），
       但**不能**跟它一樣走 chrome: 'none' —— 這兩頁是從頁尾點進來的，
       讀完要能用底部導覽回到原本在做的事。

       刻意不要 requiresAuth：條款與隱私政策要能貼給還沒註冊的人看，
       而且形象頁的頁尾也連過來 —— 擋登入等於連結對未登入者永遠是死的。 */
    {
      path: '/terms', name: 'terms',
      component: () => import('@/pages/TermsPage.vue'),
      meta: { depth: 1, title: '會員條款' }
    },
    {
      path: '/privacy', name: 'privacy',
      component: () => import('@/pages/PrivacyPage.vue'),
      meta: { depth: 1, title: '隱私權政策' }
    },
    // 煙霧凝聚特效自己一頁：跟寶貝球示範擠在同一頁的話，
    // 量到的幀率不是這支 shader 的幀率，調不準
    {
      path: '/design/smoke', name: 'design-smoke',
      component: () => import('@/pages/DesignSmokePage.vue'),
      meta: { depth: 1, title: '煙霧凝聚' }
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
  /* 後台：重整後 user 是從 localStorage 還原的，role 可能是舊的（例如權限已被移除），
     所以進後台前先跟伺服器確認一次身分再判斷。這只是避免看到一個按了全是 403 的畫面，
     真正的權限在後端每個端點各自把關。 */
  if (to.meta.requiresAdmin) {
    await auth.refresh()
    if (!auth.isAdmin) return { name: 'home' }
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
  const cardToPool = from.name === 'home' || from.name === 'play'
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
  /* 換頁後套 meta。SPA 換頁不會重載 HTML，meta 會停在上一頁 ——
     這時候分享網址或被 Google 的 JS 渲染抓到，拿到的都是錯的。
     私人頁（我的、後台、開卡結果、選籤）標 noindex：它們本來就要登入，
     被收錄只會讓搜尋結果出現一堆導向登入頁的死連結。 */
  const priv = !!to.meta.requiresAuth || !!to.meta.requiresAdmin
  applySeo(to.fullPath, to.meta.title, !priv)
  // View Transition 在等新 DOM：下一個 tick 元件已掛上，通知它可以拍新畫面了
  if (vtSettle) { const done = vtSettle; vtSettle = null; setTimeout(done, 0) }
})
