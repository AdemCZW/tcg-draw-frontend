/**
 * 執行期的頁面 meta。
 *
 * 靜態的那一半由 scripts/seo.mjs 在建置後寫進各路由的 index.html
 * （爬蟲不執行 JS，只看得到那一份）。這裡負責的是**站內換頁之後**：
 * 使用者從大廳點到市場，網址變了但 HTML 沒有重新載入，
 * meta 還停在大廳那一頁 —— 這時候分享網址或被 Google 的 JS 渲染抓到，
 * 拿到的都是錯的。
 *
 * 兩邊共用 seo-routes.json，不要各寫一份文案，否則一定會分岔。
 */
import seo from './seo-routes.json'

type RouteSeo = { path: string; title: string; description: string }
const ROUTES = seo.routes as RouteSeo[]
const SITE = seo.site

/** 去掉 GitHub Pages 的 /tcg-draw-frontend 前綴，換算成 seo-routes.json 裡的路徑 */
function normalize(fullPath: string): string {
  const p = fullPath.split('?')[0]!.split('#')[0]!
  return p.length > 1 ? p.replace(/\/$/, '') : '/'
}

function set(selector: string, attr: 'content' | 'href', value: string, create: () => HTMLElement) {
  let el = document.head.querySelector(selector)
  if (!el) { el = create(); document.head.appendChild(el) }
  el.setAttribute(attr, value)
}

const meta = (name: string, value: string) =>
  set(`meta[name="${name}"]`, 'content', value, () => {
    const el = document.createElement('meta'); el.setAttribute('name', name); return el
  })

const og = (property: string, value: string) =>
  set(`meta[property="${property}"]`, 'content', value, () => {
    const el = document.createElement('meta'); el.setAttribute('property', property); return el
  })

/**
 * 套用某條路由的 meta。
 *
 * @param fullPath  router 的 fullPath
 * @param title     路由自己宣告的標題（route.meta.title），沒有對照表時的後備
 * @param indexable 私人頁面（我的、後台、開卡結果）要標 noindex。
 *                  它們本來就要登入，但被收錄的話標題會出現在搜尋結果裡，
 *                  而且爬蟲每次去敲都只會拿到登入導向。
 */
export function applySeo(fullPath: string, title?: string, indexable = true) {
  const path = normalize(fullPath)
  const hit = ROUTES.find(r => r.path === path)

  const full = hit
    ? (hit.path === '/' ? hit.title : `${hit.title} — ${SITE.name}`)
    : title ? `${title} — ${SITE.name}` : SITE.defaultTitle
  const desc = hit?.description ?? SITE.defaultDescription

  document.title = full
  meta('description', desc)
  meta('robots', indexable ? 'index,follow' : 'noindex,follow')

  const url = location.origin + location.pathname
  set('link[rel="canonical"]', 'href', url, () => {
    const el = document.createElement('link'); el.setAttribute('rel', 'canonical'); return el
  })

  og('og:title', full)
  og('og:description', desc)
  og('og:url', url)
  og('og:type', 'website')
  og('og:site_name', SITE.name)
  meta('twitter:title', full)
  meta('twitter:description', desc)
}
