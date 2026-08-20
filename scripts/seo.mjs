/**
 * 建置後產生 SEO 需要的靜態檔。
 *
 * 為什麼需要這一步：這個網站是純前端 SPA，部署在 GitHub Pages。
 * GitHub Pages 只會對「實際存在的檔案」回 200，其餘一律回 404.html ——
 * 而且**帶著 404 狀態碼**。人用瀏覽器打開沒事（404.html 就是整個 app，
 * router 會接手），但搜尋引擎看到 404 就不收錄。
 * 實測改之前：/ 回 200，/market、/fairness、/trade-protection 全部 404。
 * 也就是整個網站在 Google 眼裡只有一頁。
 *
 * 解法是替每一條值得收錄的路由實際產生一個 dist/<path>/index.html，
 * GitHub Pages 就會對它回 200。順便把該頁專屬的 title / description /
 * Open Graph 直接寫進 HTML —— LINE 與 Facebook 的爬蟲不執行 JS，
 * 靠 router 在執行期塞 meta 對它們完全無效，分享出去只會是一片空白預覽。
 *
 * 做不到的部分（誠實記著）：/u/:slug 這種動態網址無法預先產生，
 * 因為 slug 事前不知道。那些連結對人可用、對爬蟲仍是 404。
 * 要根治得換到支援 SPA rewrite 的主機（Cloudflare Pages / Netlify，
 * public/_redirects 已經寫好了），那邊一行設定就能讓所有路徑回 200。
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

const cfg = JSON.parse(await readFile(join(root, 'src/lib/seo-routes.json'), 'utf8'))
const { site, routes } = cfg

// GH_PAGES 決定有沒有 /tcg-draw-frontend 前綴，跟 vite.config.ts 的 base 同一個開關
const base = process.env.GH_PAGES ? site.base : ''
const origin = site.origin + base

const exists = async (p) => { try { await access(p); return true } catch { return false } }
const hasOg = await exists(join(dist, 'og.png'))

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 把該頁的 meta 塞進 </head> 之前。原本的 <title> 一併換掉，不要留兩個 */
function inject(html, { path, title, description }) {
  /* 結尾要有斜線。GitHub Pages 會把 /market 用 301 導到 /market/
     （目錄的正常行為），canonical 若指向沒有斜線的版本，等於告訴 Google
     「正規網址是那個會轉址的」—— 自己跟自己打架。 */
  const url = origin + (path === '/' ? '/' : path + '/')
  const full = path === '/' ? title : `${title} — ${site.name}`
  const tags = [
    `<meta name="description" content="${esc(description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(site.name)}" />`,
    `<meta property="og:locale" content="${site.locale}" />`,
    `<meta property="og:title" content="${esc(full)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    hasOg ? `<meta property="og:image" content="${esc(origin)}/og.png" />` : null,
    `<meta name="twitter:card" content="${hasOg ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${esc(full)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`
  ].filter(Boolean).join('\n    ')

  /* 先清掉原始檔裡的預設值再塞新的。
     不清的話 description 會有兩份 —— Google 採用第一份，也就是每一頁都拿到
     首頁的描述，等於這整套白做。canonical / og / twitter 同理。 */
  return html
    .replace(/[ \t]*<meta\s+name="(description|twitter:title|twitter:description|twitter:card)"[^>]*>\n?/g, '')
    .replace(/[ \t]*<meta\s+property="og:[^"]*"[^>]*>\n?/g, '')
    .replace(/[ \t]*<link\s+rel="canonical"[^>]*>\n?/g, '')
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(full)}</title>`)
    .replace('</head>', `    ${tags}\n  </head>`)
}

const shell = await readFile(join(dist, 'index.html'), 'utf8')

/* 首頁與 404.html 用預設 meta。
   404.html 刻意加 noindex —— 它是 SPA 的 fallback，會被當成每一個
   不存在網址的內容，被收錄的話等於在搜尋結果裡塞一堆重複頁。 */
const home = routes.find(r => r.path === '/') ?? {
  path: '/', title: site.defaultTitle, description: site.defaultDescription
}
await writeFile(join(dist, 'index.html'), inject(shell, home))
await writeFile(
  join(dist, '404.html'),
  inject(shell, { path: '/', title: site.defaultTitle, description: site.defaultDescription })
    .replace('</head>', '    <meta name="robots" content="noindex" />\n  </head>')
)

let made = 0
for (const r of routes) {
  if (r.path === '/') continue
  const dir = join(dist, r.path.replace(/^\//, ''))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.html'), inject(shell, r))
  made++
}

/* robots.txt：擋掉會員專屬與後台。那些路徑本來就要登入，
   但讓爬蟲去敲它們只是浪費抓取預算，而且 /admin 不該出現在任何索引裡。 */
await writeFile(join(dist, 'robots.txt'), `User-agent: *
Allow: /
Disallow: ${base}/admin
Disallow: ${base}/me
Disallow: ${base}/draw
Disallow: ${base}/design

Sitemap: ${origin}/sitemap.xml
`)

const today = new Date().toISOString().slice(0, 10)
await writeFile(join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes.map(r => `  <url>
    <loc>${origin}${r.path === '/' ? '/' : r.path + '/'}</loc>
    <lastmod>${today}</lastmod>
    <priority>${r.priority ?? '0.5'}</priority>
  </url>`).join('\n')}
</urlset>
`)

console.log(`[seo] 產生 ${made} 個靜態路由頁 + robots.txt + sitemap.xml${hasOg ? '' : '（沒有 dist/og.png，略過 og:image）'}`)
