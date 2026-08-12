import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // GitHub Pages 把網站放在 /<repo名稱>/ 底下而非網域根目錄，
  // 資源路徑（JS/CSS）必須知道這個前綴，否則會 404。
  // 只在建置 GitHub Pages 時套用，本機開發與其他平台部署不受影響。
  base: process.env.GH_PAGES ? '/tcg-draw-frontend/' : '/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5173,
    proxy: {
      // Point to FastAPI once the backend exists
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true
      }
    }
  }
})
