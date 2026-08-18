import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles/base.css'
import { installTouchGuard } from './lib/touch-guard'

import { MOCK } from './lib/config'
import { useAuthStore } from './stores/auth'
import { api } from './lib/api'

installTouchGuard()

const pinia = createPinia()
const app = createApp(App).use(pinia).use(router)

/* API 模式：啟動時先問 /me 跟錢包，讓畫面一開始就是伺服器的狀態。
   不阻塞掛載 —— 先畫出上次存的使用者，回來再校正。 */
if (!MOCK) {
  const auth = useAuthStore()
  auth.refresh().then(() => { if (auth.isLoggedIn) api.wallet().catch(() => {}) })
}

app.mount('#app')
