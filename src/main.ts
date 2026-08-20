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

const pinia = createPinia()
const app = createApp(App).use(pinia).use(router)

/* API 模式：啟動時先問 /me 跟錢包，讓畫面一開始就是伺服器的狀態。
   不阻塞掛載 —— 先畫出上次存的使用者，回來再校正。 */
if (!MOCK) {
  const auth = useAuthStore()
  auth.refresh().then(() => { if (auth.isLoggedIn) api.wallet().catch(() => {}) })
}

app.mount('#app')
