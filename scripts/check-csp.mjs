/**
 * 建置後檢查 dist 的 CSP meta。
 *
 * ── 為什麼需要這一支 ────────────────────────────────────────────────
 * `vite.config.ts` 的 cspPlugin 是在**建置時**用環境變數組出 CSP 的：
 * `img-src` / `connect-src` 裡的 API 與 R2 網域，全部來自 `VITE_*`。
 * 環境變數沒帶進來時，plugin 不會報錯 —— 它只是產生一份**少了那幾條白名單**
 * 的 CSP，建置照樣成功、部署照樣綠燈。
 *
 * 而 CSP 擋東西是 fail-closed 且**沒有使用者看得見的錯誤**：
 * 卡片圖片變成破圖、R2 直傳一直失敗，Console 裡才有一行違規。
 * 這種壞法不會有人回報「500」，只會有人說「怪怪的」。
 * 所以正確的防線不是「記得設變數」，而是**建置產物本身要被斷言**。
 *
 * ── 為什麼檢查 dist 而不是檢查環境變數 ──────────────────────────────
 * 環境變數對了不代表 CSP 對了（plugin 可能被改壞、seo.mjs 可能把 meta 洗掉）。
 * 真正要保證的是「送到瀏覽器的那份 HTML」，所以斷言的對象是產物。
 *
 * ── 「本機沒設 R2」與「正式漏設 R2」怎麼分開 ────────────────────────
 * 這兩種情況在**環境變數層面長得一模一樣**（都是空字串），所以不可能靠
 * 讀變數分辨。分辨的依據必須來自另一個地方：**這次建置的預期**。
 *
 *   - `CSP_EXPECT_R2=true`（由 `.github/workflows/deploy-pages.yml` 寫死在
 *     版控檔案裡）＝「這是一次正式建置，R2 必須有」。變數漏設 → 直接紅。
 *   - 沒設這個旗標（本機 `npm run build`）＝ 寬鬆模式：R2 變數有值就驗它
 *     真的進了 CSP，沒值就印 SKIP 略過。
 *
 * 關鍵在於**預期宣告在 repo 裡、值放在 GitHub 設定裡**，兩者來源不同。
 * 「忘記在 GitHub 填變數」動不到 workflow 裡那一行 `true`，所以漏設一定會被抓到；
 * 反過來要讓 CI 接受「這個部署還沒有 R2」，必須明確改掉 workflow 那一行並 commit ——
 * 是一個看得到、審得到、留得下紀錄的決定，而不是一個沒有人知道的空值。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

/** GitHub Actions 的 env 值一律是字串；'false'／'0'／'' 都當成關 */
const flag = (name) => {
  const v = (process.env[name] ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/** 跟 cspPlugin 一樣去尾斜線，否則比對永遠對不上 */
const origin = (v) => (v ?? '').trim().replace(/\/$/, '')

const EXPECT_API = flag('CSP_EXPECT_API')
const EXPECT_R2 = flag('CSP_EXPECT_R2')

/* 用 vite 自己的 loadEnv，跟 vite.config.ts 的 cspPlugin 讀同一份來源
   （.env / .env.local / .env.production… 加上 process.env 裡的 VITE_ 變數）。
   只讀 process.env 的話，本機用 .env.local 建置出來的 CSP 明明有 api，
   檢查卻會因為「看不到變數」而略過 —— 兩邊必須看到一樣的東西才算數。 */
const env = loadEnv('production', root, 'VITE_')

const api = origin(env.VITE_API_URL)
const r2Public = origin(env.VITE_R2_PUBLIC_URL)
const r2Upload = origin(env.VITE_R2_UPLOAD_ORIGIN)

const failures = []
const notes = []
const fail = (msg) => failures.push(msg)
const skip = (msg) => notes.push(`SKIP  ${msg}`)
const ok = (msg) => notes.push(`OK    ${msg}`)

/** 遞迴收集 dist 底下所有 .html —— seo.mjs 會複製出 404.html 與五條靜態路由頁，
    它們也是真的會被瀏覽器載入的入口，CSP 少一份就是少一份 */
async function htmlFiles(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await htmlFiles(p)))
    else if (e.name.endsWith('.html')) out.push(p)
  }
  return out
}

function extractCsp(html) {
  const m = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i
  )
  return m ? m[1] : null
}

/** 'img-src' -> ["'self'", 'data:', ...]；重複的指令以第一次出現為準（瀏覽器行為） */
function parse(csp) {
  const map = new Map()
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (!tokens.length) continue
    const name = tokens[0].toLowerCase()
    if (!map.has(name)) map.set(name, tokens.slice(1))
  }
  return map
}

let files
try {
  files = await htmlFiles(dist)
} catch {
  console.error('[csp] 找不到 dist/ —— 這支腳本要在建置之後跑（npm run build）')
  process.exit(1)
}
if (!files.length) {
  console.error('[csp] dist/ 裡沒有任何 .html')
  process.exit(1)
}

const indexPath = join(dist, 'index.html')
const indexHtml = await readFile(indexPath, 'utf8')
const csp = extractCsp(indexHtml)

if (!csp) {
  console.error('[csp] dist/index.html 裡沒有 Content-Security-Policy meta。')
  console.error('      cspPlugin 只在 build 期套用；請確認不是用 dev server 的產物，')
  console.error('      也確認 scripts/seo.mjs 沒有把那個 meta 洗掉。')
  process.exit(1)
}

console.log('[csp] dist/index.html 實際產生的 CSP：')
for (const part of csp.split(';')) console.log('        ' + part.trim())
console.log('')

const d = parse(csp)
const has = (name, value) => (d.get(name) ?? []).includes(value)
const list = (name) => (d.get(name) ?? []).join(' ') || '(這個指令不存在)'

/* ── 1. script-src 不可以有 'unsafe-inline' / 'unsafe-eval' ──────────
   M-2 那一輪是刻意把 inline script 全部搬走才拿掉 'unsafe-inline' 的
   （GA 移除、字體 onload 搬進 main.ts）。加回去等於整條 XSS 防線失效，
   而且不會有任何症狀 —— 頁面照常運作，只是保護沒了。 */
for (const bad of ["'unsafe-inline'", "'unsafe-eval'"]) {
  if (has('script-src', bad)) {
    fail(`script-src 含有 ${bad} —— M-2 刻意拿掉的，不能加回去。目前：script-src ${list('script-src')}`)
  } else {
    ok(`script-src 沒有 ${bad}`)
  }
}
if (!d.has('script-src')) fail(`完全沒有 script-src 指令（會退回 default-src，但這是預期外的改動）`)

/* ── 2. API 網域要同時在 img-src 與 connect-src ──────────────────────
   img-src 那半條是踩過的坑：使用者上傳的卡面是 <img src="${API}/v1/files/…/raw">，
   connect-src 有 api 而 img-src 沒有時，資料抓得到、圖片全破。 */
if (EXPECT_API && !api) {
  fail(`CSP_EXPECT_API=true 但 VITE_API_URL 是空的 —— 這次建置宣告是正式建置，API 網址必須有值（GitHub repo variable VITE_API_URL）`)
} else if (!api) {
  skip(`VITE_API_URL 沒有值（mock 模式）—— 不檢查 api 網域`)
} else {
  for (const dir of ['img-src', 'connect-src']) {
    if (has(dir, api)) ok(`${dir} 含有 api ${api}`)
    else fail(`${dir} 少了 api 網域 ${api}。目前：${dir} ${list(dir)}`)
  }
}

/* ── 3. R2：公開讀取網域要在 img-src，上傳網域要在 connect-src ───────
   /v1/files/:id/raw 是 302 導到 R2，導過去的目的地一樣受 img-src 管；
   直傳是對 <帳號>.r2.cloudflarestorage.com 的預簽名 PUT，受 connect-src 管。
   這兩個是不同主機，少任何一個就是「圖破掉」或「上傳永遠失敗」。 */
const r2Checks = [
  ['VITE_R2_PUBLIC_URL', r2Public, 'img-src', '卡片圖片（/raw 會 302 導到這裡）'],
  ['VITE_R2_UPLOAD_ORIGIN', r2Upload, 'connect-src', 'R2 預簽名直傳 PUT']
]
for (const [varName, value, dir, why] of r2Checks) {
  if (!value) {
    if (EXPECT_R2) {
      fail(
        `CSP_EXPECT_R2=true 但 ${varName} 是空的 —— CSP 的 ${dir} 因此少了 R2 網域，` +
        `${why} 會被瀏覽器靜靜擋掉。請到 GitHub repo 的 Settings → Secrets and variables → Actions → Variables 設定 ${varName}。`
      )
    } else {
      skip(`${varName} 沒有值，且這次建置沒有宣告 CSP_EXPECT_R2 —— 視為「本機／尚未接 R2 的環境」，不檢查 ${dir} 的 R2 網域`)
    }
    continue
  }
  if (has(dir, value)) ok(`${dir} 含有 ${varName} ${value}`)
  else fail(`${dir} 少了 ${varName} 的網域 ${value}（變數有值卻沒進 CSP，代表 cspPlugin 或建置環境有問題）。目前：${dir} ${list(dir)}`)
}

/* ── 4. 其他 HTML 入口要有一模一樣的 CSP ────────────────────────────
   404.html 與五條靜態路由頁都是 seo.mjs 從 index.html 複製出來的真入口。
   任何一份被改到少了 CSP，那條路徑就是沒有保護的 —— 而且從首頁完全看不出來。 */
for (const f of files) {
  if (f === indexPath) continue
  const other = extractCsp(await readFile(f, 'utf8'))
  const rel = relative(root, f)
  if (other === null) fail(`${rel} 沒有 CSP meta（index.html 有，這份沒有）`)
  else if (other !== csp) fail(`${rel} 的 CSP 跟 index.html 不一致`)
}
ok(`共檢查 ${files.length} 份 HTML 入口的 CSP 一致性`)

for (const n of notes) console.log('[csp] ' + n)

if (failures.length) {
  console.error('')
  console.error(`[csp] 失敗 ${failures.length} 項：`)
  for (const f of failures) console.error('  ✗ ' + f)
  console.error('')
  console.error('[csp] CSP 違規在正式站不會有任何使用者看得見的錯誤，只會是破圖與上傳失敗。')
  console.error('      這一步刻意讓建置紅，不是印警告。')
  process.exit(1)
}

console.log('')
console.log('[csp] 全部通過。')
