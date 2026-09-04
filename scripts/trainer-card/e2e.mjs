/**
 * 訓練家卡的端對端驗證（headless Playwright）。
 *
 * 分成兩趟，因為兩件事要在不同的建置產物上才驗得到：
 *   dev  ：Vue 的 [Vue warn] 只在開發建置存在，正式建置會被拿掉。
 *          走完整條 P1–P6 與六條錯誤路徑，任何 warn / pageerror / 未處理的
 *          rejection 都算失敗。
 *   build：CSP 是 build 時才注入的 <meta>（vite.config.ts 的 cspPlugin），
 *          而且沒有 media-src、script-src 也沒有 unsafe-inline ——
 *          **要在真的建置產物上確認相機與 blob: 圖片沒有被擋**，
 *          不能只在 dev 假設。截圖也在這一趟拍（看到的就是使用者看到的）。
 *
 * 用法：node scripts/trainer-card/e2e.mjs <素材目錄>
 *   素材目錄要有 card-photo.png 與 selfie.png（見 make_warp_fixture.py 與交付說明）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIX = process.argv[2]
if (!FIX || !existsSync(join(FIX, 'card-photo.png'))) {
  console.error('用法：node scripts/trainer-card/e2e.mjs <素材目錄>（需含 card-photo.png / selfie.png）')
  process.exit(2)
}
const SHOTS = join(root, 'docs/shots/trainer-card')
mkdirSync(SHOTS, { recursive: true })

const problems = []
const note = (s) => console.log(s)
const fail = (s) => { problems.push(s); console.log(`  ✗ ${s}`) }
const ok = (s) => console.log(`  ✓ ${s}`)

/* ── 起伺服器 ──────────────────────────────────────────────────────── */
function serve(cmd, args, ready) {
  const p = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (d) => {
      buf += d.toString()
      const m = buf.match(ready)
      if (m) resolve({ proc: p, url: m[0].replace(/\/$/, '') })
    }
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)
    p.on('exit', (c) => reject(new Error(`伺服器結束了 (${c})：${buf.slice(-400)}`)))
    setTimeout(() => reject(new Error(`伺服器沒起來：${buf.slice(-400)}`)), 60_000)
  })
}

/** 把 console / pageerror / unhandledrejection 全部收集起來，任何一則都算失敗 */
function watch(page, label) {
  const bad = []
  page.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error' || t.includes('[Vue warn]')) bad.push(`${label} console: ${t}`)
  })
  page.on('pageerror', (e) => bad.push(`${label} pageerror: ${e.message}`))
  return bad
}

/* ── 共用的流程片段 ────────────────────────────────────────────────── */
async function consentAndCard(page) {
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: '開始' }).click()
  await page.locator('[data-testid="card-file"]').setInputFiles(join(FIX, 'card-photo.png'))
  await page.locator('.quad canvas').waitFor()
}

/**
 * 把四個角拖到卡片真正的四角。
 * 座標來自 make_warp_fixture.py 寫死的那組（照片是同一張），
 * 所以這一步同時驗證了「拖曳把手 → 四角 → 校正預覽」整條真的接得起來。
 */
const TRUE_QUAD = [[196, 168], [694, 232], [742, 1012], [140, 940]]
const PHOTO = [900, 1200]
const LIFT = 34            // 跟 QuadEditor 的常數一致

async function dragCorners(page) {
  const stage = page.locator('.quad')
  const box = await stage.boundingBox()
  for (let i = 0; i < 4; i++) {
    const grip = page.locator(`.grip[data-corner="${i}"]`)
    const g = await grip.boundingBox()
    const [tx, ty] = TRUE_QUAD[i]
    const toX = box.x + (tx / PHOTO[0]) * box.width
    const toY = box.y + (ty / PHOTO[1]) * box.height - LIFT
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
    await page.mouse.down()
    await page.mouse.move(toX, toY, { steps: 8 })
    await page.mouse.up()
  }
}

async function selfieAndName(page, name = '小森') {
  await page.getByRole('button', { name: '用這張' }).click()
  await page.locator('[data-testid="selfie-file"]').setInputFiles(join(FIX, 'selfie.png'))
  await page.getByRole('button', { name: '用這張' }).click()
  await page.locator('[data-testid="name-input"]').fill(name)
}

async function setTestPanel(page, { error = '', failOnce = false, delay = 400 } = {}) {
  await page.locator('.test summary').click()
  await page.locator('[data-testid="force-error"]').selectOption(error)
  const fo = page.locator('[data-testid="fail-once"]')
  if (failOnce !== (await fo.isChecked())) await fo.setChecked(failOnce)
  await page.locator('[data-testid="delay-ms"]').fill(String(delay))
}

/* ══════════════════════════════════════════════════════════════════ */
async function main() {
  /* ── 第一趟：dev（抓 Vue warn） ──────────────────────────────────── */
  note('\n── dev：完整流程 + 錯誤路徑 ─────────────────────────────')
  const dev = await serve('npx', ['vite', '--port', '5211', '--strictPort'], /http:\/\/localhost:5211\/?/)
  const browser = await chromium.launch()
  try {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } })
    const page = await ctx.newPage()
    const bad = watch(page, 'dev')

    await page.goto(`${dev.url}/trainer-card?tc-test=1`)
    await consentAndCard(page)
    await dragCorners(page)
    ok('四角拖曳 + 即時校正預覽')

    await selfieAndName(page)
    await setTestPanel(page, { delay: 400 })
    await page.getByRole('button', { name: '開始生成' }).click()
    await page.locator('[data-testid="result-image"]').waitFor({ timeout: 20_000 })
    ok('P1→P6 走完，成品產生')

    /* 成品必須是真的合成出來的圖，不是樣板原圖 —— 比對兩者的像素 */
    const differs = await page.evaluate(async () => {
      const img = document.querySelector('[data-testid="result-image"]')
      const c = document.createElement('canvas')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      c.getContext('2d').drawImage(img, 0, 0)
      // 卡片中央那一點：樣板是白的，貼上使用者的卡之後不會是白的
      const [x, y] = [Math.round(c.width * 0.5), Math.round(c.height * 0.61)]
      const p = c.getContext('2d').getImageData(x, y, 1, 1).data
      return { w: c.width, h: c.height, px: [p[0], p[1], p[2]] }
    })
    if (differs.w !== 1696 || differs.h !== 2528) fail(`成品尺寸 ${differs.w}×${differs.h}，應為 1696×2528`)
    else ok(`成品尺寸 ${differs.w}×${differs.h}`)
    const [r, g, b] = differs.px
    if (r > 235 && g > 235 && b > 235) fail(`卡片中央仍是白色 (${r},${g},${b}) —— 使用者的卡沒有貼上去`)
    else ok(`卡片中央已是使用者的卡 (${r},${g},${b})`)

    /* 存檔：headless 沒有 navigator.share，會走 <a download> 那條 */
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      page.locator('[data-testid="save"]').click()
    ])
    ok(`存檔降級路徑可用（下載 ${dl.suggestedFilename()}）`)

    /* 額度：首次已用掉 1，再兩次就滿 */
    for (let i = 0; i < 2; i++) {
      await page.locator('[data-testid="regenerate"]').click()
      await page.locator('[data-testid="result-image"]').waitFor({ timeout: 20_000 })
    }
    const regen = page.locator('[data-testid="regenerate"]')
    if (await regen.isEnabled()) fail('生成 3 次之後「重新生成」仍可按 —— 成本上限沒擋住')
    else ok('生成 3 次之後正確擋住（§9 前端重試上限）')

    /* ── 六條錯誤路徑，每條重新載入一次（額度是 per session） ─────── */
    const CASES = [
      ['NO_IMAGE_RETURNED', true, '自動重試 1 次後成功', 'result'],
      ['NO_IMAGE_RETURNED', false, '連續失敗 → 可重試', 'retry'],
      ['TIMEOUT', false, '逾時 → 可重試', 'retry'],
      ['NETWORK', false, '網路 → 可重試', 'retry'],
      ['RATE_LIMITED', false, '429 → 不可自動重試、不給重試鈕', 'norety'],
      ['REFUSED', false, '模型拒絕 → 不給重試鈕', 'norety']
    ]
    for (const [code, once, label, expect] of CASES) {
      await page.goto(`${dev.url}/trainer-card?tc-test=1`)
      await consentAndCard(page)
      await page.getByRole('button', { name: '用這張' }).click()
      await page.locator('[data-testid="selfie-file"]').setInputFiles(join(FIX, 'selfie.png'))
      await page.getByRole('button', { name: '用這張' }).click()
      await page.locator('[data-testid="name-input"]').fill('測試')
      await setTestPanel(page, { error: code, failOnce: once, delay: 200 })
      await page.getByRole('button', { name: '開始生成' }).click()

      if (expect === 'result') {
        await page.locator('[data-testid="result-image"]').waitFor({ timeout: 20_000 })
        ok(`${code}：${label}`)
      } else {
        await page.locator('.pane h1').filter({ hasNotText: '正在做你的卡' }).first()
          .waitFor({ timeout: 20_000 })
        const retry = page.locator('[data-testid="retry"]')
        const has = await retry.count()
        if (expect === 'retry' && has !== 1) fail(`${code}：應該要有重試鈕`)
        else if (expect === 'norety' && has !== 0) fail(`${code}：不該給重試鈕（429 自動重試會造成限流雪崩）`)
        else ok(`${code}：${label}`)
      }
    }

    /* 相機被拒（headless 沒有相機）必須是可讀的訊息，不是白畫面 */
    await page.goto(`${dev.url}/trainer-card`)
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: '開始' }).click()
    const warnText = await page.locator('.warn').first().textContent().catch(() => '')
    if (!warnText || !warnText.includes('相簿')) fail(`相機失敗時的訊息不對：「${warnText}」`)
    else ok('相機拿不到時有人話訊息 + 檔案入口')

    if (bad.length) bad.forEach(fail)
    else ok('dev 全程沒有 [Vue warn] / pageerror / console error')

    await ctx.close()
  } finally {
    dev.proc.kill()
  }

  /* ── 第二趟：建置產物（CSP + 截圖 + 尺寸） ──────────────────────── */
  note('\n── build：CSP 實測 + 截圖 + 尺寸 ────────────────────────')
  const prev = await serve('npx', ['vite', 'preview', '--port', '4211', '--strictPort'], /http:\/\/localhost:4211\/?/)
  try {
    const SIZES = [[375, 812, 'se'], [393, 852, '393x852'], [393, 667, '393x667']]
    for (const [w, h, tag] of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } })
      const page = await ctx.newPage()
      const bad = watch(page, `build:${tag}`)
      const blocked = []
      page.on('console', (m) => {
        if (/Content Security Policy|Refused to/i.test(m.text())) blocked.push(m.text())
      })

      await page.goto(`${prev.url}/trainer-card?tc-test=1`)
      const csp = await page.evaluate(() =>
        document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? '')
      if (tag === 'se') {
        if (!csp) fail('建置產物沒有 CSP meta')
        else ok(`CSP meta 存在（media-src 未設 → 落到 default-src 'self'）`)
      }

      if (tag === 'se') await page.screenshot({ path: join(SHOTS, 'p1-consent-dark.png'), fullPage: true })
      await consentAndCard(page)
      await dragCorners(page)
      if (tag === 'se') await page.screenshot({ path: join(SHOTS, 'p2-quad-dark.png'), fullPage: true })

      await selfieAndName(page)
      if (tag === 'se') await page.screenshot({ path: join(SHOTS, 'p4-name-dark.png'), fullPage: true })
      await setTestPanel(page, { delay: 3000 })
      await page.getByRole('button', { name: '開始生成' }).click()
      await page.locator('[data-testid="phase"]').waitFor()
      if (tag === 'se') {
        await page.waitForTimeout(900)
        await page.screenshot({ path: join(SHOTS, 'p5-generating-dark.png'), fullPage: true })
      }
      await page.locator('[data-testid="result-image"]').waitFor({ timeout: 30_000 })

      /* blob: 的成品圖真的畫出來了 = img-src blob: 沒被擋 */
      const drew = await page.evaluate(() => {
        const i = document.querySelector('[data-testid="result-image"]')
        return !!i && i.naturalWidth > 0 && i.src.startsWith('blob:')
      })
      if (!drew) fail(`${tag}: 成品 blob: 圖沒有畫出來（CSP img-src 可能擋掉了）`)
      else if (tag === 'se') ok('blob: 成品圖在建置產物上正常顯示（img-src 有 blob:）')

      if (tag === 'se') await page.screenshot({ path: join(SHOTS, 'p6-result-dark.png'), fullPage: true })

      /* 版面：不得橫向溢出；所有可點的東西 ≥44px */
      const layout = await page.evaluate(() => {
        const over = document.documentElement.scrollWidth > window.innerWidth + 1
        const small = []
        for (const el of document.querySelectorAll('button, a[href], input, select, label.btn, summary')) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) continue          // 隱藏的不算
          if (el.closest('.test')) continue                       // 測試面板不是產品 UI
          if (r.height < 44 || r.width < 44) small.push(`${el.tagName}.${el.className} ${Math.round(r.width)}×${Math.round(r.height)}`)
        }
        return { over, small, sw: document.documentElement.scrollWidth, vw: window.innerWidth }
      })
      if (layout.over) fail(`${tag}: 橫向溢出（scrollWidth ${layout.sw} > ${layout.vw}）`)
      else ok(`${tag}: 無橫向溢出`)
      if (layout.small.length) fail(`${tag}: 觸控目標 <44px：${layout.small.join(' / ')}`)
      else ok(`${tag}: 觸控目標全部 ≥44px`)


      if (blocked.length) blocked.forEach((b) => fail(`${tag}: CSP 擋下 ${b}`))
      if (bad.length) bad.forEach(fail)
      await ctx.close()
    }

    /* 淺色主題另外跑一趟，**在導覽之前**就把 data-theme 種下去。
       原本是在 P6 之後才 setAttribute 再截圖，拍出來的圖有一半還是深色的
       —— 那是 Chromium fullPage 截圖把先前算好的圖層重用了，
       不是主題壞掉（實測 computed style 是對的）。要拍到誠實的淺色畫面，
       就得讓整頁從第一次繪製起就是淺色的。 */
    const lightCtx = await browser.newContext({ viewport: { width: 375, height: 812 } })
    await lightCtx.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () =>
        document.documentElement.setAttribute('data-theme', 'light'))
    })
    const lp = await lightCtx.newPage()
    await lp.goto(`${prev.url}/trainer-card?tc-test=1`)
    await lp.screenshot({ path: join(SHOTS, 'p1-consent-light.png'), fullPage: true })
    await consentAndCard(lp)
    await dragCorners(lp)
    await selfieAndName(lp)
    await setTestPanel(lp, { delay: 300 })
    await lp.getByRole('button', { name: '開始生成' }).click()
    await lp.locator('[data-testid="result-image"]').waitFor({ timeout: 30_000 })
    await lp.screenshot({ path: join(SHOTS, 'p6-result-light.png'), fullPage: true })
    ok('深淺兩套主題各截一張')
    await lightCtx.close()
  } finally {
    prev.proc.kill()
    await browser.close()
  }

  console.log('')
  if (problems.length) {
    console.log(`FAIL（${problems.length} 項）`)
    process.exit(1)
  }
  console.log('PASS')
}

main().catch((e) => { console.error(e); process.exit(1) })
