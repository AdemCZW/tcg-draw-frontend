/**
 * 底部導覽的「遮擋」驗證（headless Playwright）。
 *
 * 為什麼要多一支測試：既有的 e2e 檢查的是觸控目標的**尺寸**
 * （`r.height < 44 || r.width < 44`）。尺寸夠大跟「按得到」是兩回事 ——
 * 底部導覽中央那顆凸出的球是 fixed 的，它壓在頁面內容上，
 * 被壓住的按鈕量起來仍然是 48×48，但它的正中央會把點擊送去 /play。
 * 尺寸測試對這種故障完全無感，所以這裡改用 hit-test：
 *
 *   對每一個可點擊元素，取它的**幾何中心**丟進 document.elementFromPoint()，
 *   回傳的必須是它自己或它的子孫。回傳別的東西 = 那一點按下去不會到它。
 *
 * 中心點是刻意的判準，不是隨便取一點：使用者按按鈕時瞄的就是中心，
 * 而「邊緣還按得到」不能拿來當通過條件 —— 那等於要求使用者瞄準邊角。
 *
 * 為什麼一定要跨多頁、跨多尺寸、跨兩個捲動位置：
 *   多頁   遮擋只發生在「頁面最下面剛好有東西」的那些頁，
 *          只測一頁會漏掉；這裡掃大廳／市場／卡冊／我的／訓練家卡成品頁。
 *   多尺寸 393×667 這種矮螢幕的頁尾在捲到底時貼得更近。
 *   兩個捲動位置 捲到底是最容易被壓到的一幀，但 scrollY = 0 那一幀
 *          （內容不夠長、根本捲不動的頁）同樣要成立。
 *
 * 另外三項也在這裡驗，因為它們的失敗方式都是「熱區跑掉」：
 *   --anim    切分頁的動畫跑到一半時再測一次遮擋（動畫不能製造新的按錯）
 *   --reduce  prefers-reduced-motion: reduce 之下動畫必須真的停掉
 *   --shots   深淺兩套主題與動畫連續取樣的截圖
 *
 * 用法：
 *   node scripts/bottom-nav/occlusion.mjs              全部跑一遍
 *   node scripts/bottom-nav/occlusion.mjs --tag=before 截圖存成 before-*
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SHOTS = join(root, 'docs/shots/bottom-nav')
mkdirSync(SHOTS, { recursive: true })

const TAG = (process.argv.find(a => a.startsWith('--tag=')) ?? '--tag=after').slice(6)
const PORT = 5311

const problems = []
const fail = (s) => { problems.push(s); console.log(`  ✗ ${s}`) }
const ok = (s) => console.log(`  ✓ ${s}`)
const note = (s) => console.log(s)

/* ── 最小 PNG 編碼器 ────────────────────────────────────────────────
   訓練家卡的流程要餵兩張圖進 <input type=file>，而 repo 裡沒有素材檔
   （make_warp_fixture.py 產的圖沒有版控）。與其要求跑測試的人先去生素材，
   不如當場合成兩張純色圖 —— 這一支測的是版面遮擋，不是影像處理，
   圖裡畫什麼完全不影響結論，唯一的要求是「它是一個合法的 PNG」。 */
function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = c ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1)
    raw[row] = 0                                    // filter: none
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 4
      // 加一點漸層，免得整張純色被當成無效輸入
      raw[i] = (r + x) & 0xff; raw[i + 1] = (g + y) & 0xff; raw[i + 2] = b & 0xff; raw[i + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ])
}
const CARD_PNG = { name: 'card.png', mimeType: 'image/png', buffer: png(300, 400, [40, 90, 200]) }
const SELFIE_PNG = { name: 'selfie.png', mimeType: 'image/png', buffer: png(300, 300, [200, 120, 60]) }

/* ── 起 dev server ─────────────────────────────────────────────────
   刻意用 dev 不用 build 產物：底部導覽與 .navClear 的 CSS 在兩邊完全一樣
   （scoped CSS 不會因為建置而改變幾何），而 dev 讓這支測試可以獨立跑，
   不必先等一次完整 build —— 一支「要先做別的事才能跑」的測試不會有人跑。
   MOCK 模式（沒有 VITE_API_URL）也讓它不依賴後端。 */
function serve() {
  /* VITE_API_URL 清空 = 強制走 mock（見 lib/config.ts）。
     .env.local 平常指著 Railway 的後端，而那台會睡；後端睡著時整站是
     「連不上伺服器」的空殼，掃出來的可點元素只剩頁首頁尾幾顆 ——
     那等於這支測試會在後端狀態不好的日子悄悄失去覆蓋率。
     mock 的清單永遠有內容，測遮擋要的就是「頁面滿的時候」。 */
  const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VITE_API_URL: '' } })
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (d) => {
      buf += d.toString()
      const m = buf.match(new RegExp(`http://localhost:${PORT}/?`))
      if (m) resolve({ proc: p, url: m[0].replace(/\/$/, '') })
    }
    p.stdout.on('data', onData); p.stderr.on('data', onData)
    p.on('exit', (c) => reject(new Error(`伺服器結束了 (${c})：${buf.slice(-400)}`)))
    setTimeout(() => reject(new Error(`伺服器沒起來：${buf.slice(-400)}`)), 60_000)
  })
}

/* ── 遮擋稽核（跑在頁面裡） ──────────────────────────────────────────
 *
 * 判準分兩級，因為「中心點打到別人」有兩種完全不同的成因：
 *
 *   硬失敗（真的按不到）
 *     把元素捲到最舒服的位置（scrollIntoView block: 'center'；已經到底就是
 *     最大捲動量）之後，中心點**仍然**打到別人。這代表沒有任何捲動位置
 *     能讓使用者按到它 —— 底部導覽讓位少算的症狀正是這一種：文件末端的
 *     按鈕已經捲無可捲，卻還埋在球底下。
 *
 *   提示（捲一下就按得到）
 *     只在某一幀（例如 scrollY = 0）被蓋住。固定列與黏著頁首本來就會蓋住
 *     捲動中的內容，那是固定元素的本性，不是這次要修的缺陷。列出來但不擋。
 *
 * 兩幀都測、不只測捲到底，是因為短到捲不動的頁面只有 scrollY = 0 那一幀，
 * 而那一幀正好也是它的「最舒服位置」，會直接落進硬失敗。
 */
const AUDIT = () => {
  const desc = (el) => {
    if (!el) return 'null'
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : ''
    const t = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 18)
    return `${el.tagName.toLowerCase()}${cls}${t ? `「${t}」` : ''}`
  }
  const SEL = 'a[href], button, input, select, textarea, summary, [role="button"], label.btn'
  const clickable = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return null                   // 隱藏／收合的不算
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.pointerEvents === 'none') return null
    if (el.disabled) return null                                   // 停用的按鈕本來就不該被點到
    return r
  }
  const probe = (el) => {
    const r = clickable(el)
    if (!r) return { skip: true }
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    // 中心點不在視窗內就測不到（這一幀而已，下面還會把它捲進來再測一次）
    if (x < 0 || y < 0 || x > innerWidth - 1 || y > innerHeight - 1) return { skip: true }
    const top = document.elementFromPoint(x, y)
    return { ok: top === el || (top && el.contains(top)), top, x, y }
  }

  const y0 = window.scrollY
  const hits = []
  for (const el of document.querySelectorAll(SEL)) {
    const first = probe(el)
    if (first.skip || first.ok) continue

    /* 捲到它自己最舒服的位置再測一次。回不去原位的話後面的量測都會歪，
       所以無論結果如何都把捲動位置還原。 */
    el.scrollIntoView({ block: 'center', inline: 'nearest' })
    const best = probe(el)
    window.scrollTo(0, y0)

    const top = first.top
    const nav = document.querySelector('.bnav')
    const navTop = nav ? nav.getBoundingClientRect().top : Infinity
    hits.push({
      target: desc(el),
      got: desc(top),
      hard: !(best.skip || best.ok),          // 最佳位置也按不到 = 真的按不到
      // 蓋住它的東西是不是底部導覽 —— 這是我們要抓的那一種
      byNav: !!(top && top.closest && top.closest('.bnav')),
      /* 中心點在導覽列上緣**之上**卻打到導覽列 = 落在球凸出的那一段。
         這一類特別值得列出來：導覽列本體是一條不透明的橫列，內容捲到
         它底下沒有人會誤會；但球凸出的那 21px 在左右兩側看起來是空白的
         頁面區域，只有正中央那顆球會吃掉點擊 —— 那才是會讓人按錯的形狀。 */
      orbBand: !!(top && top.closest && top.closest('.bnav')) && first.y < navTop,
      at: [Math.round(first.x), Math.round(first.y)]
    })
  }
  return hits
}

/* 幾何不變式：讓位（--nav-total）必須蓋得住導覽列**實際佔用**的高度，
   含中央鍵凸出的那一段。這一條比 hit-test 穩 —— hit-test 會因為某顆按鈕
   剛好高了幾像素而僥倖通過，這一條直接量「球的上緣到畫面底部」有多高，
   跟頁面內容無關。少一像素就是 fail。 */
const GEOM = () => {
  const nav = document.querySelector('.bnav')
  const orb = document.querySelector('.bnav .orb')
  const clear = document.querySelector('.navClear')
  if (!nav || !orb) return null
  const orbTop = orb.getBoundingClientRect().top
  const navTop = nav.getBoundingClientRect().top
  return {
    need: Math.round((innerHeight - orbTop) * 100) / 100,   // 導覽列連球一起佔掉的高度
    have: clear ? Math.round(clear.getBoundingClientRect().height * 100) / 100 : null,
    bump: Math.round((navTop - orbTop) * 100) / 100          // 球實際凸出上緣多少
  }
}

/** 捲到底。用 scrollTo + 等一幀，不用 keyboard End（有些頁把鍵盤事件吃掉） */
const scrollBottom = async (page) => {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(260)
}
const scrollTop = async (page) => {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(160)
}

const softs = []
/* 落在球凸出那一段的（另外列，見 AUDIT 裡 orbBand 的說明）*/
const orbBand = []
async function auditPage(page, label) {
  const found = []
  for (const [where, go] of [['頂端', scrollTop], ['捲到底', scrollBottom]]) {
    await go(page)
    const hits = await page.evaluate(AUDIT)
    for (const h of hits) found.push({ ...h, where })
  }
  const hard = found.filter(h => h.hard)
  const soft = found.filter(h => !h.hard)
  for (const h of hard) {
    fail(`${label} / ${h.where}：${h.target} 的中心點 (${h.at}) 打到 ${h.got}${h.byNav ? '  ← 底部導覽壓住了它' : ''}（捲到最佳位置仍然按不到）`)
  }
  for (const h of soft) {
    (h.orbBand ? orbBand : softs)
      .push(`${label} / ${h.where}：${h.target}（中心 ${h.at}）打到 ${h.got}${h.byNav && !h.orbBand ? '（導覽列本體）' : ''}`)
  }
  if (!hard.length) ok(`${label}：所有可點元素都按得到${soft.length ? `（${soft.length} 處僅在單一捲動位置被固定元素蓋住）` : ''}`)
  return hard.length
}

/* ── 走到訓練家卡成品頁 ──────────────────────────────────────────────
   P2 已經改成「從自己的卡冊挑一張」（第二版），但這一支測的是**版面遮擋**，
   跟卡片從哪裡來無關。這裡刻意走次要入口「用一張還沒登記的卡」——
   它用本地合成的 PNG，不必打 TCGdex，這支測試就不會因為別人的 CDN 而紅。
   分支本身（目錄卡不校正 / 實拍卡要校正）由 scripts/trainer-card/e2e.mjs 驗。 */
async function toTrainerResult(page, base) {
  await page.goto(`${base}/trainer-card?tc-test=1`)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: '開始' }).click()
  await page.locator('details.alt summary').click()
  await page.locator('[data-testid="card-file"]').setInputFiles(CARD_PNG)
  await page.locator('.quad canvas').waitFor({ timeout: 15_000 })
  await page.getByRole('button', { name: '用這張' }).click()
  await page.locator('[data-testid="selfie-file"]').setInputFiles(SELFIE_PNG)
  await page.getByRole('button', { name: '用這張' }).click()
  await page.locator('[data-testid="name-input"]').fill('測試')
  await page.locator('.test summary').click()
  await page.locator('[data-testid="delay-ms"]').fill('120')
  await page.getByRole('button', { name: '開始生成' }).click()
  await page.locator('[data-testid="result-image"]').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(200)
}

/** 已登入狀態：mock 模式的登入就是 localStorage 裡的 vd.user（見 stores/auth.ts） */
const LOGIN = () => {
  try { localStorage.setItem('vd.user', JSON.stringify({ id: 'u-TEST', name: 'VD-TEST', isAdult: true })) } catch { /* 無痕 */ }
}

const PAGES = [
  ['大廳', '/lobby'],
  ['市場', '/market'],
  ['卡冊', '/me/cards'],
  ['我的', '/me'],
  ['訓練家卡成品頁', null]        // null = 要走完流程才到得了
]
const SIZES = [[375, 812], [393, 852], [393, 667]]

async function main() {
  const dev = await serve()
  const browser = await chromium.launch()
  let total = 0
  try {
    /* ── 1. 遮擋：五頁 × 三尺寸 × 兩個捲動位置 ───────────────────── */
    note('\n── 遮擋 hit-test ─────────────────────────────────────────')
    for (const [w, h] of SIZES) {
      note(`  ${w}×${h}`)
      const ctx = await browser.newContext({ viewport: { width: w, height: h } })
      await ctx.addInitScript(LOGIN)
      /* 卡圖不打真的 CDN：這支測的是遮擋，圖裡畫什麼不影響結論，
         但「TCGdex 今天慢」不該讓遮擋測試變紅。 */
      await ctx.route('https://assets.tcgdex.net/**', (r) => r.fulfill({
        status: 200, contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*' }, body: CARD_PNG.buffer
      }))
      const page = await ctx.newPage()

      /* 幾何不變式先驗 —— 它跟頁面內容無關，一頁量到就代表全站 */
      await page.goto(`${dev.url}/lobby`)
      await page.waitForTimeout(700)
      const g = await page.evaluate(GEOM)
      if (!g) fail(`${w}×${h}：找不到 .bnav / .orb`)
      else if (g.have === null) fail(`${w}×${h}：找不到 .navClear（全站唯一的讓位不見了）`)
      else if (g.have + 0.01 < g.need) {
        fail(`${w}×${h}：讓位 ${g.have}px < 導覽列實際佔用 ${g.need}px（球凸出 ${g.bump}px 沒被算進 --nav-total），差 ${Math.round((g.need - g.have) * 100) / 100}px`)
      } else ok(`${w}×${h}：讓位 ${g.have}px ≥ 導覽列實際佔用 ${g.need}px（球凸出 ${g.bump}px）`)

      for (const [label, path] of PAGES) {
        if (path) {
          await page.goto(`${dev.url}${path}`)
          await page.waitForTimeout(700)          // mock 的清單有假延遲
        } else {
          await toTrainerResult(page, dev.url)
        }
        total += await auditPage(page, `${w}×${h} ${label}`)
      }
      await ctx.close()
    }

    /* ── 2. 動畫期間的熱區 ─────────────────────────────────────────
       切分頁時指示器會滑動。滑到一半再測一次遮擋 —— 動畫不能製造新的按錯。 */
    note('\n── 動畫進行中的熱區 ──────────────────────────────────────')
    {
      const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } })
      await ctx.addInitScript(LOGIN)
      const page = await ctx.newPage()
      await page.goto(`${dev.url}/lobby`)
      await page.waitForTimeout(700)
      await page.locator('.bnav .item').nth(1).click()      // 大廳 → 市場
      await page.waitForTimeout(90)                          // 轉場正中間
      const mid = await page.evaluate(AUDIT)
      const running = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length)
      const midHard = mid.filter(h => h.hard)
      if (midHard.length) midHard.forEach(h => fail(`動畫中：${h.target} 的中心點打到 ${h.got}`))
      else ok(`動畫進行中（此刻 ${running} 支動畫在跑）熱區沒有跑掉`)
      await ctx.close()
    }

    /* ── 3. reduced-motion ─────────────────────────────────────────
       前庭系統敏感的人會因為晃動的介面不舒服，那不是喜好問題。
       判準不是「看起來沒動」，是切完分頁後 document.getAnimations() 沒有
       任何一支在跑，而且指示器已經在最終位置（= 拿掉動畫畫面照樣成立）。 */
    note('\n── prefers-reduced-motion: reduce ────────────────────────')
    {
      const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' })
      await ctx.addInitScript(LOGIN)
      const page = await ctx.newPage()
      await page.goto(`${dev.url}/lobby`)
      await page.waitForTimeout(700)
      await page.locator('.bnav .item').nth(1).click()
      const anims = await page.evaluate(() => {
        // 下一幀就問：轉場若還活著，這時一定抓得到
        return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() =>
          res(document.getAnimations().map(a => `${a.constructor.name}:${a.transitionProperty ?? a.animationName ?? '?'}:${a.playState}`))
        )))
      })
      const alive = anims.filter(a => a.endsWith(':running'))
      if (alive.length) fail(`reduce 之下仍有動畫在跑：${alive.join(' / ')}`)
      else ok(`reduce 之下 0 支動畫在跑（共 ${anims.length} 支被登記）`)
      // 畫面仍要成立：選中的那一格必須是市場
      const on = await page.evaluate(() =>
        [...document.querySelectorAll('.bnav .item')].findIndex(e => e.classList.contains('on')))
      if (on !== 1) fail(`reduce 之下選中狀態沒有到位（on = 第 ${on} 格，應為第 1 格）`)
      else ok('reduce 之下選中狀態直接到位，畫面完整成立')
      await ctx.close()
    }

    /* ── 4. 截圖：深淺兩套主題 + 動畫連續取樣 ───────────────────── */
    note('\n── 截圖 ──────────────────────────────────────────────────')
    for (const theme of ['dark', 'light']) {
      const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } })
      await ctx.addInitScript(LOGIN)
      // 主題要在第一次繪製前就種下去，不然截出來會是上一個主題的圖層
      if (theme === 'light') {
        await ctx.addInitScript(() => document.addEventListener('DOMContentLoaded', () =>
          document.documentElement.setAttribute('data-theme', 'light')))
      }
      const page = await ctx.newPage()
      await page.goto(`${dev.url}/lobby`)
      await page.waitForTimeout(900)
      await scrollBottom(page)
      await page.screenshot({ path: join(SHOTS, `${TAG}-lobby-bottom-${theme}.png`) })
      await ctx.close()
    }
    ok('深淺兩套主題各一張（捲到底那一幀）')

    {
      /* 動畫沒有影片可錄，改成時間點取樣：按下之後每 60ms 拍一張，
         六張連起來就看得到指示器從哪一格走到哪一格。 */
      const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } })
      await ctx.addInitScript(LOGIN)
      const page = await ctx.newPage()
      await page.goto(`${dev.url}/lobby`)
      await page.waitForTimeout(900)
      const clip = { x: 0, y: 812 - 96, width: 375, height: 96 }
      await page.screenshot({ path: join(SHOTS, `${TAG}-anim-0.png`), clip })
      await page.locator('.bnav .item').nth(2).click()      // 大廳 → 中央（抽選）
      for (let i = 1; i <= 5; i++) {
        await page.waitForTimeout(60)
        await page.screenshot({ path: join(SHOTS, `${TAG}-anim-${i}.png`), clip })
      }
      await ctx.close()
      ok('動畫連續取樣 6 張（0 / 60 / 120 / 180 / 240 / 300 ms）')
    }
  } finally {
    dev.proc.kill()
    await browser.close()
  }

  if (orbBand.length) {
    note('\n── 待跟進：落在球凸出那一段（看起來是空白頁面區，實際會吃掉點擊）──')
    note('   讓位只保護「文件的最末端」，保護不到捲動途中的任何一幀。')
    note('   這些要各自的頁面把主要動作改用 BottomActionBar（它的 bottom 吃 --nav-total，')
    note('   已經跟著這次的修正一起被推高），或自己把內容排離導覽列上緣。')
    orbBand.forEach(s => console.log(`  · ${s}`))
  }
  if (softs.length) {
    note('\n── 提示：被導覽列本體或黏著頁首蓋住（固定元素的本性，捲一下就按得到）──')
    softs.forEach(s => console.log(`  · ${s}`))
  }

  console.log('')
  if (problems.length) {
    console.log(`FAIL（${problems.length} 項；遮擋 ${total} 處）`)
    process.exit(1)
  }
  console.log('PASS')
}

main().catch((e) => { console.error(e); process.exit(1) })
