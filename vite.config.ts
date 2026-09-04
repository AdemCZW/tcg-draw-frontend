import { defineConfig, loadEnv, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

/**
 * 內容安全政策（CSP）。security-audit M-2。
 *
 * ── 為什麼是 <meta> 而不是 HTTP 標頭 ────────────────────────────────
 * 正式站放在 GitHub Pages，那裡**不能設 response header**。meta 版的 CSP
 * 是次好的選擇，而且有兩個必須知道的限制：
 *   1. `frame-ancestors` 在 meta 裡會被瀏覽器**忽略** —— 也就是說
 *      防點擊劫持（把我們的頁面嵌進別人的 iframe）這件事，
 *      在換到能設標頭的主機之前**做不到**。這是已知缺口，不是漏寫。
 *   2. `report-uri` / `report-to` 同樣被忽略，所以沒有違規回報。
 *
 * ── 為什麼在 build 時產生而不是寫死在 index.html ─────────────────────
 * API 網址是部署時才決定的（GitHub Actions 的 repo variable），R2 的公開
 * 網域是選填的。寫死等於把「換一個後端」變成要改原始碼；而寫成寬鬆的
 * `https:` 又等於這幾條白名單形同虛設。從 env 生成是唯一兩者都不犧牲的做法。
 *
 * ── 為什麼只在 build 套用 ───────────────────────────────────────────
 * 開發伺服器靠 inline script 與 eval 做 HMR，套上嚴格 CSP 會直接壞掉。
 * 而開發環境本來就不是攻擊面。
 */
function cspPlugin(env: Record<string, string | undefined>): Plugin {
  return {
    name: 'vaultdraw-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const api = (env.VITE_API_URL ?? '').replace(/\/$/, '')
      /* 上傳走 R2 的預簽名 PUT，那是一個跟公開讀取網域不同的主機
         （<帳號>.r2.cloudflarestorage.com）。兩個都要能連，而且都是選填 ——
         沒設就不放行，寧可上傳壞掉被發現，也不要預設開一個沒人記得的洞。 */
      const r2Public = (env.VITE_R2_PUBLIC_URL ?? '').replace(/\/$/, '')
      const r2Upload = (env.VITE_R2_UPLOAD_ORIGIN ?? '').replace(/\/$/, '')

      const has = (...xs: string[]) => xs.filter(Boolean)

      const csp = [
        `default-src 'self'`,
        /* 沒有 'unsafe-inline'：index.html 已經沒有任何 inline script
           （GA 的那段移除了，字體的 onload 搬進 main.ts）。
           application/ld+json 不是可執行腳本，CSP 不會擋它。 */
        `script-src 'self'`,
        /* 樣式必須留 'unsafe-inline'：Vue 的 <style scoped> 在 build 時會抽成
           檔案，但執行期仍有元件用 :style 綁動態值（開卡演出整段都是），
           那些會變成 style 屬性。style 屬性的風險遠低於腳本 —— 它改的是
           外觀，不是行為。要拿掉得先把所有動態樣式改成 CSS 變數，
           那是另一件事，不該讓 CSP 卡在那裡不上線。 */
        `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
        `font-src 'self' https://fonts.gstatic.com data:`,
        /* blob: 是開卡演出的 canvas 截圖用的；data: 是佔位圖與 QR。
           **api 一定要在這裡**：使用者上傳的卡面是 <img src="${API_URL}/v1/files/…/raw">，
           少了它整條卡面上傳在正式建置下會被 CSP 直接擋掉 —— 而且後端有沒有那條路由
           完全無關，症狀是破圖加一行 CSP 違規，跟「端點壞了」長得一模一樣。
           （下一行的 connect-src 一直都有 api，這一行漏掉。）

           **R2 的兩個網域都要放進 img-src，因為 /raw 是 302 導到 R2，目的地同樣
           受這條規則管，而「導去哪裡」取決於 bucket 有沒有開公開讀取：**
             有公開網域（R2_PUBLIC_URL 有設）→ 導到 r2Public
             沒有（正式環境現況）           → publicUrlOf() 回 null，退回簽名網址，
                                              導到 r2Upload（<帳號>.r2.cloudflarestorage.com）
           2026-09-04 實測 Railway：R2_ACCOUNT_ID/BUCKET/金鑰都有值，唯獨
           R2_PUBLIC_URL 沒設 —— 也就是走的正是第二條。而 r2Upload 當時只在
           connect-src，於是每一張使用者上傳的圖都被 img-src 擋掉。
           兩個都列進來，bucket 之後開不開公開讀取都不會再壞。 */
        ...[`img-src ${has(`'self'`, 'data:', 'blob:', api, 'https://assets.tcgdex.net', r2Public, r2Upload).join(' ')}`],
        ...[`connect-src ${has(`'self'`, api, 'https://api.tcgdex.net', r2Upload).join(' ')}`],
        /* 這三條是低成本高價值的：沒有 <object>／<embed>、
           <base> 不能被改寫（防止相對路徑被劫持）、表單只能送回自己站上。 */
        `object-src 'none'`,
        `base-uri 'self'`,
        `form-action 'self'`
      ].join('; ')

      return html.replace(
        '</title>',
        `</title>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`
      )
    }
  }
}

export default defineConfig(({ mode }) => ({
  // GitHub Pages 把網站放在 /<repo名稱>/ 底下而非網域根目錄，
  // 資源路徑（JS/CSS）必須知道這個前綴，否則會 404。
  // 只在建置 GitHub Pages 時套用，本機開發與其他平台部署不受影響。
  base: process.env.GH_PAGES ? '/tcg-draw-frontend/' : '/',
  plugins: [vue(), cspPlugin(loadEnv(mode, process.cwd(), 'VITE_'))],
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
}))
