/**
 * 產生分享預覽圖 public/og.png（1200×630）。
 *
 * 為什麼要有這支腳本，而不是丟一張畫好的圖進 repo：
 * scripts/seo.mjs 只在 dist/og.png 存在時才寫出 og:image；沒有它，
 * 連結分享到 LINE／Facebook 就是一片空白預覽。而預覽圖上的字（品牌、
 * 那一句說明）是會改的 —— 文案一改就要重畫一張圖，圖檔本身無法 diff、
 * 無法 review，改過幾次之後沒人知道現在這張是哪一版文案。
 * 把它變成「HTML → 無頭瀏覽器截圖」，改文案就只是改下面那幾行字串。
 *
 * 色票不在這裡寫死，而是**整份 src/styles/tokens.css 注入 <style>**，
 * 版面只引用 var(--…)。理由：這張圖是網站的門面，色票改了它必須跟著改；
 * 抄一份 hex 過來就等於埋下「網站換色但預覽圖沒換」的分岔。
 *
 * 用法：npm run og
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ── 文案：要改字就只改這一段 ──────────────────────────────────
   刻意不放任何數字（人數、抽數、成長率）。那些數字沒有來源，
   寫上去就是編的，而這張圖是給第一次看到這個站的人看的。 */
const COPY = {
  eyebrow: '定量池 · 可驗證開獎',
  brandHead: 'Vault',
  brandTail: 'Draw',
  /* 一句話講完這站在做什麼。取自 index.html 與 seo-routes.json 的既有描述，
     不另外發明賣點 —— 預覽圖跟 meta description 講的必須是同一件事。
     斷行是手動指定的：中文可以在任何字之間換行，交給瀏覽器排會把「開獎」
     這種詞拆成兩行（實測第一版就是這樣）。這裡在破折號後斷，語意才對得上。 */
  tagline: ['鑑定卡的線上定量池抽選 ——', '籤序在開賣前以雜湊封存，開獎後任何人都能自行驗算。'],
  footer: 'ademczw.github.io/tcg-draw-frontend'
}

const W = 1200
const H = 630

const tokens = await readFile(join(root, 'src/styles/tokens.css'), 'utf8')

/* 字體堆疊。
   為什麼不直接寫 var(--font-body)：那兩個權杖的尾巴是 sans-serif /
   monospace，而通用字族一定匹配得到 —— 補在它後面的具名字體永遠輪不到。
   第一版就是這樣中招的，網址那一行整條變成 Courier（有襯線的打字機體）。
   所以這裡照抄權杖的順序，但把本機備援插在通用字族**之前**。
   PingFang 排在 system-ui **之後**是有意的：它本身也有拉丁字面，排前面的話
   整個標誌會被它接走，字形明顯比 SF 窄而拘謹。排後面就只在 system-ui
   沒有的字（也就是漢字）上遞補 —— 不過這只是網路真的斷掉時的樣子。 */
const FONT_BODY = '"Inter", "Noto Sans TC", system-ui, "PingFang TC", "Heiti TC", sans-serif'
const FONT_MONO = '"IBM Plex Mono", Menlo, ui-monospace, monospace'

/* ── 真的把站上那三套字抓下來內嵌 ─────────────────────────────────
   這張圖是網站的門面，字體必須跟站上一致（index.html 載的是 Google Fonts
   的 Inter / Noto Sans TC / IBM Plex Mono，字重只有 400/500/600/700）。
   本機沒裝這三套，所以只靠 font-family 堆疊的話會**默默**退到 SF Pro /
   PingFang / Menlo —— 圖看起來還是好的，只是不是這個站的字。
   那種「看起來沒壞」的退化最危險，因為沒有人會發現。

   作法：用 Google Fonts 的 `text=` 參數只要我們真的用到的那幾個字，
   回來的是每個字重一支幾 KB 的 woff2（要全套的話光 Noto Sans TC 就是
   上百個 unicode-range 子集、幾十次請求）。抓到手就轉成 data: URI 內嵌，
   截圖當下不再有任何外部請求，排版結果因此是決定性的。

   連不上就**大聲失敗**，不偷偷產一張退化的圖。真的要在沒有網路的機器上
   重跑，加 --offline 明確表示「我知道字會不一樣」。 */
const OFFLINE = process.argv.includes('--offline')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 這張圖真正會排到的字元集合，拿去跟 Google 要子集 */
const usedText = [...new Set([
  COPY.eyebrow, COPY.brandHead, COPY.brandTail, ...COPY.tagline, COPY.footer
].join(''))].join('')

async function fetchEmbeddedFontCss() {
  if (OFFLINE) {
    console.warn('[og] --offline：跳過網頁字下載，改用本機備援字體（成品與站上字體不同）')
    return ''
  }
  /* 三套字分開要。一次要三套也可以，但分開時哪一套掛了看得出來是哪一套。
     字重只挑實際用到的：標誌與 eyebrow 是 600、內文與網址是 400。 */
  const families = ['Inter:wght@400;600', 'Noto+Sans+TC:wght@400;600', 'IBM+Plex+Mono:wght@400']
  let css = ''
  for (const family of families) {
    const url = `https://fonts.googleapis.com/css2?family=${family}` +
      `&text=${encodeURIComponent(usedText)}&display=block`
    /* UA 一定要偽裝成新版 Chrome：Google Fonts 是靠 UA 決定回傳
       woff2 還是老格式的，Node 的預設 UA 會拿到 ttf（大很多也慢很多）。 */
    const res = await fetch(url, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`取 ${family} 的 CSS 失敗：HTTP ${res.status}`)
    let sheet = await res.text()

    /* 把每一個 url(https://fonts.gstatic.com/…) 換成 data: URI。
       內嵌之後 setContent 的頁面是自足的，不需要 networkidle 這種
       「等多久算等夠」的猜測 —— document.fonts.ready 就是確定的答案。 */
    const urls = [...sheet.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)]
    if (urls.length === 0) throw new Error(`${family} 的 CSS 裡沒有任何字體檔網址`)
    for (const [, fontUrl] of urls) {
      const f = await fetch(fontUrl, { headers: { 'user-agent': UA } })
      if (!f.ok) throw new Error(`下載字體檔失敗：HTTP ${f.status} ${fontUrl}`)
      const b64 = Buffer.from(await f.arrayBuffer()).toString('base64')
      sheet = sheet.replace(fontUrl, `data:font/woff2;base64,${b64}`)
    }
    console.log(`[og] 內嵌 ${family.split(':')[0].replace(/\+/g, ' ')}：${urls.length} 個字重`)
    css += sheet + '\n'
  }
  return css
}

const fontCss = await fetchEmbeddedFontCss()

const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<style>
${fontCss}
</style>
<style>
${tokens}
</style>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: ${FONT_BODY};
    -webkit-font-smoothing: antialiased;
  }

  /* 兩團暖色光暈。tokens.css 的深色 wash 本來就是「摻了色的深底」，
     疊在 --bg 上只會微微透出溫度，不會變成髒髒的色塊 —— 純平塗的黑底
     在 1200×630 這麼大的面積上會顯得很死。 */
  .stage {
    position: relative; width: ${W}px; height: ${H}px; overflow: hidden;
    background:
      radial-gradient(760px 520px at 14% 6%, var(--wash-peach), transparent 68%),
      radial-gradient(680px 480px at 92% 100%, var(--wash-lilac), transparent 70%),
      var(--bg);
  }

  /* 內縮的面板：沿用「越上層越亮」的分層原則（--surface 比 --bg 亮一階），
     順便讓文字離裁切邊界遠一點 —— 各家平台裁 OG 圖的方式並不一致。 */
  .panel {
    position: absolute; inset: 34px;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--surface);
    overflow: hidden;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    text-align: center;
    /* 下緣多留一點：footer 是絕對定位、不算進置中，
       不補這一段的話文案會貼著網址，上下留白一眼看得出不對稱。 */
    padding: 0 90px 50px;
  }

  /* 全息箔光譜是這個站的辨識元素（卡片稀有度就是用它），
     放在面板頂緣一條細線，成本最低但一眼認得出來。 */
  .foil { position: absolute; top: 0; left: 0; right: 0; height: 6px; background: var(--holo); }

  /* 與站上 .eyebrow 同一組值：13px/600、accent 字配 accent-wash 底、膠囊圓角。
     這裡放大到 20px，因為 OG 圖常被縮到 300px 寬顯示。 */
  .eyebrow {
    font-size: 20px; font-weight: 600; letter-spacing: .02em;
    color: var(--accent); background: var(--accent-wash);
    padding: 10px 24px; border-radius: var(--pill);
    margin-bottom: 40px;
  }

  /* 標誌照抄 AppHeader：Vault 用文字色、Draw 用強調色、字距 -0.03em。
     字重 600 是頁首那顆標誌的值 —— 這是品牌鎖定形，不跟著 .display 走細字。 */
  .brand {
    font-size: 118px; font-weight: 600; letter-spacing: -0.03em;
    line-height: 1.06; color: var(--ink);
  }
  .brand span { color: var(--accent); }

  .tagline {
    margin-top: 34px; max-width: 830px;
    font-size: 31px; font-weight: 400; line-height: 1.62;
    color: var(--muted);
  }

  /* 網址用等寬字，跟站上顯示識別碼／編號的處理一致；
     --faint 是最低一階的文字色，不跟主文案搶。 */
  .footer {
    position: absolute; bottom: 40px;
    font-family: ${FONT_MONO};
    font-size: 19px; letter-spacing: 0; color: var(--faint);
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="panel">
      <div class="foil"></div>
      <div class="eyebrow">${COPY.eyebrow}</div>
      <div class="brand">${COPY.brandHead}<span>${COPY.brandTail}</span></div>
      <p class="tagline">${COPY.tagline.join('<br />')}</p>
      <div class="footer">${COPY.footer}</div>
    </div>
  </div>
</body>
</html>`

const browser = await chromium.launch()
/* deviceScaleFactor 維持 1：輸出必須剛好是 1200×630，
   放大兩倍再縮回來只會多一次重新取樣。 */
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
await page.setContent(html, { waitUntil: 'load' })
await page.evaluate(() => document.fonts.ready)

/* 截圖前確認那三套字**真的**被採用了。
   內嵌成功但字族名打錯、或子集裡剛好缺了某個字，畫面依然會靜靜退回
   系統字 —— 而那正是這整段程式碼要防的失敗模式，所以必須明確驗一次。
   document.fonts.check 問的是「這個字級＋字族，這串字排得出來嗎」。 */
if (!OFFLINE) {
  const loaded = await page.evaluate(() => ({
    inter: document.fonts.check('600 118px Inter', 'VaultDraw'),
    noto: document.fonts.check('400 31px "Noto Sans TC"', '籤序在開賣前以雜湊封存'),
    mono: document.fonts.check('400 19px "IBM Plex Mono"', 'ademczw.github.io')
  }))
  const missing = Object.entries(loaded).filter(([, ok]) => !ok).map(([k]) => k)
  if (missing.length) {
    console.error(`[og] 這幾套字沒有生效：${missing.join(', ')} —— 產出的圖會是系統字，不是站上的字`)
    process.exit(1)
  }
  console.log('[og] 字體確認：Inter / Noto Sans TC / IBM Plex Mono 全部生效')
}

const out = join(root, 'public/og.png')
await writeFile(out, await page.screenshot({ type: 'png' }))
await browser.close()

console.log(`[og] 產生 public/og.png（${W}×${H}）`)
