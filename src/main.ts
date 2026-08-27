import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles/base.css'
/* 排在 base.css 之後：手機防呆的補強有幾條要蓋過 base.css 的同名規則
   （最明顯的是輸入框字級），靠載入順序解決，不用 !important。 */
import './styles/touch.css'
import { installTouchGuard } from './lib/touch-guard'
import { installTapGuard } from './lib/tap-guard'

import { MOCK } from './lib/config'
import { useAuthStore } from './stores/auth'
import { api } from './lib/api'

installTouchGuard()
installTapGuard()

/* 網頁字體改成「載完才套用」。
   index.html 那個 <link> 掛的是 media="print" —— 瀏覽器視為非必要、
   不擋首次繪製，但照樣立刻開始下載。切回 all 的動作原本寫成標籤上的
   onload="this.media='all'"，而那是 inline event handler，CSP 的
   script-src 會擋掉它（除非開 'unsafe-inline'，那等於把 CSP 最重要的
   那一半關掉）。搬到這裡只改「什麼時候套用」，下載時機沒有變。
   已經載完（快取命中）的情況 onload 不會再觸發，所以要先看 sheet 在不在。 */
{
  const link = document.getElementById('webfonts') as HTMLLinkElement | null
  if (link) {
    const apply = () => { link.media = 'all' }
    if (link.sheet) apply()
    else link.addEventListener('load', apply, { once: true })
  }
}

const pinia = createPinia()
const app = createApp(App).use(pinia).use(router)

/* API 模式：啟動時先問 /me 跟錢包，讓畫面一開始就是伺服器的狀態。
   不阻塞掛載 —— 先畫出上次存的使用者，回來再校正。 */
if (!MOCK) {
  const auth = useAuthStore()
  auth.refresh().then(() => { if (auth.isLoggedIn) api.wallet().catch(() => {}) })
}

app.mount('#app')
