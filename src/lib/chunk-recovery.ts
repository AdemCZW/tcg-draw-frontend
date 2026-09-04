/**
 * 換版之後「按了沒反應」的救援。
 *
 * ── 症狀（正式站實際發生過）────────────────────────────────────────
 * 每一條路由都是 lazy-load（`component: () => import('@/pages/…')`），
 * 檔名帶內容雜湊。使用者分頁裡的 index.html 是**部署前**那一版，記著舊雜湊；
 * 部署把 dist/assets 整個換掉之後，舊檔名在伺服器上不存在了。
 * 於是他點「登記卡片」→ 動態 import 被 reject → vue-router 的導航
 * 靜靜中止（沒有 onError 就只剩一個 unhandled rejection 進 console）→
 * 畫面不動、沒有任何回饋。重整就好，因為重整會拿到新的 index.html。
 *
 * 本機重現（2026-09-04，dist 建置版 + 靜態伺服器）拿到的原文：
 *   Chromium 404 或連線失敗 →
 *     TypeError: Failed to fetch dynamically imported module: …/ContactPage-D_UEg26F.js
 *   Firefox 同一情況 →
 *     TypeError: error loading dynamically imported module: …/ContactPage-D_UEg26F.js
 *   只有 CSS 那一半失敗（Vite 的 preload helper 自己丟的，跟瀏覽器無關）→
 *     Error: Unable to preload CSS for /assets/ContactPage-Cyw-SG0n.css
 * 三種措辭都要認得，而且 Safari 還有第四種（Importing a module script failed.）。
 *
 * ── 怎麼判定「是 chunk 載入失敗」而不是真的程式錯誤 ─────────────────
 * 只比對字串太危險：措辭每個瀏覽器都不一樣（上面已經三種），比對太寬
 * 就會把真正的程式錯誤也當成換版，結果是「bug 變成靜默重整」——
 * 那比原本的沒反應更難查。所以這裡要兩個條件**同時**成立：
 *
 *   1. 這顆錯誤物件是 **Vite 的動態載入器**丟出來的。
 *      Vite 的 preload helper 在丟出錯誤前會先發一個 `vite:preloadError`
 *      事件，payload 就是**同一顆**錯誤物件（見 vite 的 preload-helper：
 *      `a.payload=o; window.dispatchEvent(a); if(!a.defaultPrevented) throw o`）。
 *      我們把 payload 記下來，用 `===` 比身分 —— 這一條跟瀏覽器措辭完全無關，
 *      而且頁面自己 setup 裡丟的錯根本不會經過這條路。
 *   2. 訊息對得上「檔案拿不到」的樣子（下面的正規式）。
 *      用來擋掉「模組頂層真的丟了一個錯」的情況 —— 那也會讓 import reject、
 *      也會經過同一個 helper，但訊息是程式自己的，不會長成這樣。
 *
 * 兩條缺一不可。少了 (1) 會被字串巧合誤傷，少了 (2) 會把模組頂層的真錯吃掉。
 */
import { createApp, h, ref } from 'vue'
import AppUpdateNotice from '@/components/AppUpdateNotice.vue'

/* 「檔案拿不到」在各家瀏覽器與 Vite 自己的措辭。
   刻意都是完整片語（唯一的例外 `Load failed` 用 ^$ 綁全字串，那是 Safari
   對 fetch 失敗的整句訊息）—— 用單字比對會把正常的錯誤訊息掃進來。 */
const LOAD_FAIL_RE = new RegExp([
  'failed to fetch dynamically imported module',   // Chrome / Edge
  'error loading dynamically imported module',     // Firefox
  'importing a module script failed',              // Safari / WebKit
  'unable to preload css for',                     // Vite 的 preload helper（CSS 那一半）
  'failed to load module script',                  // Chrome：MIME 不對（SPA fallback 回 index.html）
  'expected a javascript(-or-wasm)? module script', // 同上，另一種措辭
  'loading chunk [\\w-]+ failed',                  // 舊版打包器的措辭，留著不吃虧
  '^typeerror: load failed$'                       // Safari 的網路失敗整句
].join('|'), 'i')

/** 最後一次由 Vite 動態載入器丟出來的錯誤（身分比對用） */
let lastLoaderError: unknown = null
let lastLoaderAt = 0

if (typeof window !== 'undefined') {
  /* 只記錄，**不要** preventDefault —— 取消預設會讓 Vite 不再往外丟，
     那樣 router.onError 就收不到，整條救援反而失效。 */
  window.addEventListener('vite:preloadError', (e) => {
    lastLoaderError = (e as Event & { payload?: unknown }).payload
    lastLoaderAt = Date.now()
  })
}

export function isChunkLoadFailure(err: unknown): boolean {
  // 條件一：這顆錯誤確實是動態載入器丟的（同一顆物件，且就在剛剛）
  const fromLoader = err === lastLoaderError && Date.now() - lastLoaderAt < 10_000
  if (!fromLoader) return false
  // 條件二：訊息長得像「檔案拿不到」，而不是模組自己丟的錯
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return LOAD_FAIL_RE.test(msg)
}

/* ------------------------------------------------------------------
   防迴圈：同一個目標路徑只自動重整一次
   ------------------------------------------------------------------
   如果失敗的原因不是換版而是真的壞掉（CDN 掛了、檔案真的沒上傳、
   使用者的網路一直斷），無腦重整會變成無限重整 —— 比「沒反應」糟得多，
   使用者連按上一頁的機會都沒有。

   記在 sessionStorage 而不是 localStorage：這是「這個分頁這一次」的狀態，
   關掉分頁就該忘記。記的是**目標路徑**，所以 A 頁重整過不會讓 B 頁失去
   它自己的那一次機會。成功抵達之後（router.afterEach）就清掉。
------------------------------------------------------------------- */
const RETRY_KEY = 'vd.chunkReload'

function readRetried(): string | null {
  try { return sessionStorage.getItem(RETRY_KEY) } catch { return null }  // 無痕模式可能會丟
}
function markRetried(path: string) {
  try { sessionStorage.setItem(RETRY_KEY, path) } catch { /* 存不了就退化成「不擋」，至少不會壞 */ }
}
/** 成功走到那一頁之後把標記清掉，否則下一次真的換版時會被誤判成「重試過了」 */
export function clearRetryMark(path: string) {
  if (readRetried() === path) { try { sessionStorage.removeItem(RETRY_KEY) } catch { /* 同上 */ } }
}

/* ------------------------------------------------------------------
   提示 UI。自己 createApp 掛在 body 上
   ------------------------------------------------------------------
   不放進 App.vue：救援路徑不該依賴任何頁面元件掛得起來，而且 App.vue
   同時有別條線在改。這顆小 app 不需要 router 也不需要 pinia。
------------------------------------------------------------------- */
type Kind = 'update' | 'offline' | 'failed'
const notice = ref<{ kind: Kind; onReload: (() => void) | null } | null>(null)
let mounted = false

function ensureMounted() {
  if (mounted || typeof document === 'undefined') return
  mounted = true
  const host = document.createElement('div')
  document.body.appendChild(host)
  createApp({
    render: () => notice.value
      ? h(AppUpdateNotice, {
        kind: notice.value.kind,
        onReload: () => notice.value?.onReload?.(),
        onDismiss: () => { notice.value = null }
      })
      : null
  }).mount(host)
}

function show(kind: Kind, onReload: (() => void) | null = null) {
  ensureMounted()
  notice.value = { kind, onReload }
}

/**
 * 導航因為載不到頁面程式而失敗時的處置。
 *
 * @param fullPath 使用者本來要去的路徑 —— 重整之後要回到**那一頁**，不是首頁。
 *                 他按的是「登記卡片」，重整完就該在登記頁。
 * @param href     已經套上 base 的實際網址（GitHub Pages 有 /tcg-draw-frontend/ 前綴）
 * @param isFirstNavigation 這次是不是進站的第一次導航
 */
export function recoverFromChunkFailure(fullPath: string, href: string, isFirstNavigation: boolean) {
  /* 離線：重整只會換來一頁瀏覽器的錯誤畫面，而且會把使用者手上的頁面也弄丟。
     這時候唯一有用的是告訴他發生什麼事。 */
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    show('offline')
    return
  }

  /* 已經為了這個路徑重整過一次，還是失敗 —— 那就不是換版問題。
     停在這裡，給一句看得懂的話，不再重整。 */
  if (readRetried() === fullPath) {
    show('failed')
    return
  }

  const reload = () => { markRetried(fullPath); location.assign(href) }

  /* 進站的第一次導航（使用者直接開網址／重整／從外部連結進來）：
     畫面上還是空白，沒有任何「未儲存的輸入」可以被弄壞，
     而提示條會是空白頁上唯一的東西 —— 那不如直接把該做的事做掉。
     防迴圈的標記照樣先寫，所以最多只會自動重整一次。 */
  if (isFirstNavigation) { reload(); return }

  /* 站內換頁：**不要**自動重整。這個錯誤發生在使用者要離開目前那一頁的
     瞬間，而他手上可能有還沒送出的東西（開池表單、登記卡片的鑑定資料、
     客服表單），訓練家卡的成品頁離開更是永久消失。要不要放棄那些，
     只有他能決定。 */
  show('update', reload)
}
