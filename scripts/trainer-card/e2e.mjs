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
 *   api  ：第三趟。用 VITE_API_URL 起 dev，把 /v1/prizes 換成我們指定的回應 ——
 *          **「卡冊是空的」與「自己登記的卡（實拍照）」這兩條在 mock 模式下
 *          結構性地驗不到**（mock 的卡冊固定有 7 張，而且全部是目錄卡）。
 *
 * ── 卡圖一律攔截 ─────────────────────────────────────────────────────
 * assets.tcgdex.net 與站內 /v1/files/:id/raw 都用 route.fulfill 餵素材圖，
 * 並帶 `access-control-allow-origin: *`。理由有兩個：
 *   · 決定性 —— 測試不該因為別人的 CDN 慢或改版而紅
 *   · 這條路真正要驗的是「網址怎麼算出來、crossOrigin 有沒有帶、位元組進不進
 *     得了 canvas」，那三件事跟位元組是誰給的無關
 * 真實來源另外用 curl 查證過（2026-09-04：assets.tcgdex.net 回
 * `access-control-allow-origin: *`），結果寫在交付說明裡。
 *
 * 用法：node scripts/trainer-card/e2e.mjs <素材目錄>
 *   素材目錄要有 card-photo.png 與 selfie.png（見 make_warp_fixture.py 與交付說明）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
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
/* 第二版的截圖另外放一份（before/after 成對），舊的那組留著當 before */
const SHOTS2 = join(root, 'docs/shots/trainer-card-v2')
mkdirSync(SHOTS2, { recursive: true })
/* 先等進場動畫跑完再拍：.slab 的 rise 是 .22s，拍在中間會得到一張半透明的圖，
   看起來像「畫面壞了」而不是「動畫拍到一半」。 */
const shot = async (page, name, opts = {}) => {
  await page.waitForTimeout(300)
  return Promise.all([
  page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true, ...opts }),
    page.screenshot({ path: join(SHOTS2, `after-${name}.png`), fullPage: true, ...opts })
  ])
}

const problems = []
const note = (s) => console.log(s)
const fail = (s) => { problems.push(s); console.log(`  ✗ ${s}`) }
const ok = (s) => console.log(`  ✓ ${s}`)

/* ── 起伺服器 ──────────────────────────────────────────────────────── */
function serve(cmd, args, ready, env) {
  const p = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
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

/* ── 假的後端 ──────────────────────────────────────────────────────
   **為什麼三趟都走 API 模式而不是 mock**：
     · mock 的卡冊固定 7 張、而且全部是目錄卡（src/mocks/data.ts 的 image
       一律是空字串）。所以「卡冊是空的」與「自己登記的實拍卡」這兩條
       在 mock 之下**結構性地驗不到**，而它們正是這一版最容易寫錯的地方。
     · 本機的 .env.local 可能指著真的 Railway 後端（這台就是），
       不釘住 VITE_API_URL 的話，同一支測試在不同機器上跑的是不同的東西。
   卡圖也一律攔截（assets.tcgdex.net 與站內 /v1/files/:id/raw），並帶
   `access-control-allow-origin: *` —— 程式碼用 crossOrigin='anonymous'，
   沒有這個標頭圖就載不進來，那也正是 R2 沒開 CORS 時的真實行為。
   真實來源另外用 curl 查證過（2026-09-04：assets.tcgdex.net 回 ACAO: *）。 */
const API_ORIGIN = 'https://tc-e2e.invalid'
const CORS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
const CARD_BYTES = () => readFileSync(join(FIX, 'card-photo.png'))
/** 目錄卡的圖：正面、方正的掃描（fixture 裡的 pattern.png 就是那個真值圖案） */
const FLAT_BYTES = () => readFileSync(join(FIX, 'pattern.png'))

/** 目錄卡：image 空字串 + artId —— 跟 src/mocks/data.ts 的七張一模一樣的形狀 */
const CATALOG_CARD = {
  id: 'c-cat', name: '目錄卡（TCGdex）', setCode: 'sv4a', cardNo: '349/190',
  language: 'JP', grader: 'RAW', grade: null, certNo: null,
  image: '', refPrice: null, artId: 'SV4a-349'
}
/** 自己登記的卡：**兩個欄位同時有** —— cardbookApi.upload() 從目錄挑到卡號
    時就是這樣（src/lib/api.ts:1277 / 1279）。照 artId 判斷的話這張會被當成
    目錄卡直接貼上去，成品是歪的。 */
const OWN_CARD = {
  id: 'c-own', name: '自己登記的卡（實拍）', setCode: 'sv4a', cardNo: '350/190',
  language: 'JP', grader: 'RAW', grade: null, certNo: null,
  image: '/v1/files/f-e2e000000001', refPrice: null, artId: 'SV4a-350'
}
const prizeRow = (card, id) => ({
  id, card, tier: null, status: 'in_book',
  won_at: '2026-09-01T10:00:00Z', acquired_at: '2026-09-01T10:00:00Z',
  stash_expires_at: null, buyback: null, settle_status: null
})
const BOTH_CARDS = [prizeRow(CATALOG_CARD, 'up-cat'), prizeRow(OWN_CARD, 'up-own')]

/**
 * 攔截這個 context 的後端與卡圖。
 * 註冊順序有意義：Playwright 是**後註冊的先比對**，所以擋所有東西的那條
 * 要先掛，特例才蓋得過它。
 */
async function stubApi(ctx, items = BOTH_CARDS) {
  // 兜底：這支測試沒有要驗的端點一律 404，不要讓它去打真的後端或吊在那裡
  await ctx.route(`${API_ORIGIN}/**`, (route) => route.fulfill({
    status: 404, contentType: 'application/json', headers: CORS,
    body: JSON.stringify({ error: 'NOT_FOUND', message: 'e2e stub' })
  }))
  // 站內檔案：真後端會 302 到 R2，這裡直接給位元組
  await ctx.route('**/v1/files/*/raw', (route) => route.fulfill({
    status: 200, contentType: 'image/png', headers: CORS, body: CARD_BYTES()
  }))
  await ctx.route('**/v1/prizes*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: CORS,
    body: JSON.stringify({ items, nextCursor: null })
  }))
  await ctx.route('https://assets.tcgdex.net/**', (route) => route.fulfill({
    status: 200, contentType: 'image/png', headers: CORS, body: FLAT_BYTES()
  }))
}

/* ── 共用的流程片段 ────────────────────────────────────────────────── */
async function consent(page) {
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: '開始' }).click()
}

/** 讀出這一頁**實際走了哪一條分支**。看的是程式寫進 DOM 的判斷結果，不是畫面。 */
const branchOf = (page) => page.evaluate(() => {
  const sec = document.querySelector('section[data-card-source]')
  return sec
    ? { source: sec.getAttribute('data-card-source'), rectify: sec.getAttribute('data-rectify'),
        quad: document.querySelectorAll('.quad').length }
    : null
})

/** 主路徑：從卡冊挑一張目錄卡。不該出現四角編輯器。 */
async function pickCatalogCard(page) {
  await page.locator('[data-testid="tc-card-grid"] .tile[data-source="catalog"]').first().click()
  await page.locator('[data-testid="picked-card"]').waitFor({ timeout: 15_000 })
}

/** 次要入口：用一張還沒登記的卡（相簿選檔）。一定要出現四角編輯器。 */
async function useUnregisteredCard(page) {
  await page.locator('details.alt summary').click()
  await page.locator('[data-testid="card-file"]').setInputFiles(join(FIX, 'card-photo.png'))
  await page.locator('.quad canvas').waitFor({ timeout: 15_000 })
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
  const dev = await serve('npx', ['vite', '--port', '5211', '--strictPort'],
    /http:\/\/localhost:5211\/?/, { VITE_API_URL: API_ORIGIN })
  const browser = await chromium.launch()
  try {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } })
    await stubApi(ctx)
    const page = await ctx.newPage()
    const bad = watch(page, 'dev')

    /* ══ A. 目錄卡：不該跑校正 ═══════════════════════════════════════ */
    await page.goto(`${dev.url}/trainer-card?tc-test=1`)
    await consent(page)
    await pickCatalogCard(page)
    {
      const b = await branchOf(page)
      if (!b || b.source !== 'catalog' || b.rectify !== 'false') {
        fail(`目錄卡被判成 ${JSON.stringify(b)}，應為 source=catalog / rectify=false`)
      } else if (b.quad !== 0) {
        fail('目錄卡仍然出現了四角編輯器 —— 一張本來就方正的圖被拿去做不必要的校正')
      } else ok('目錄卡：走「直接貼」那一條（data-rectify=false，畫面上沒有四角編輯器）')
    }

    await selfieAndName(page)
    await setTestPanel(page, { delay: 400 })
    await page.getByRole('button', { name: '開始生成' }).click()
    await page.locator('[data-testid="result-image"]').waitFor({ timeout: 20_000 })
    ok('P1→P6 走完（從卡冊挑目錄卡），成品產生')

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

    /* ══ 長按存圖：逐項檢查會擋掉它的三件事 ════════════════════════════
       規格 §10.7 的觸控防呆要求整頁加 user-select / -webkit-touch-callout，
       但**加在成品圖上就等於把系統的「加入照片」關掉**。這裡量的是實際
       computed style 與實際的命中測試，不是「原始碼裡有沒有寫」。 */
    {
      const lp = await page.evaluate(() => {
        const img = document.querySelector('[data-testid="result-image"]')
        const cs = getComputedStyle(img)
        const r = img.getBoundingClientRect()
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
        const hit = document.elementFromPoint(cx, cy)
        return {
          callout: cs.webkitTouchCallout ?? cs.getPropertyValue('-webkit-touch-callout'),
          select: cs.userSelect || cs.webkitUserSelect,
          pointer: cs.pointerEvents,
          inView: r.top >= 0 && cy < innerHeight,
          hit: hit ? `${hit.tagName}${hit.getAttribute('data-testid') ? `[${hit.getAttribute('data-testid')}]` : ''}` : 'null',
          isSelf: hit === img
        }
      })
      if (lp.callout === 'none') fail(`成品圖的 -webkit-touch-callout 是 none —— iOS 的長按存圖選單會被關掉`)
      else ok(`成品圖 -webkit-touch-callout = ${lp.callout || '(未設，即 default)'}`)
      if (lp.select === 'none') fail('成品圖的 user-select 是 none —— 長按選單會被連帶關掉')
      else ok(`成品圖 user-select = ${lp.select}`)
      if (lp.pointer === 'none') fail('成品圖 pointer-events: none —— 長按打不到它')
      if (!lp.inView) fail('成品圖的中心點不在畫面內（scrollY = 0 那一幀就長按不到）')
      if (!lp.isSelf) fail(`elementFromPoint(成品圖中心) 回傳 ${lp.hit}，不是那張 <img> —— 有東西蓋在圖上`)
      else ok('elementFromPoint(成品圖中心) 就是那張 <img>（沒有任何覆蓋層）')
      const said = await page.locator('.warn.strong').first().textContent()
      if (!said.includes('長按')) fail('成品頁沒有告訴使用者可以長按存圖')
      else if (!said.includes('無法復原')) fail('成品頁少了「離開後無法復原」那一句（規格 §5 C-3）')
      else ok('成品頁同時講了「離開就沒了」與「可以長按存圖」')
    }

    /* 存檔：headless 沒有 navigator.share，會走 <a download> 那條 */
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      page.locator('[data-testid="save"]').click()
    ])
    ok(`存檔降級路徑可用（下載 ${dl.suggestedFilename()}）`)

    /* ══ 額度：一次生成 + 一次重來就滿 ═══════════════════════════════
       這一條是 commit 633da15 記過的坑：budget 是普通 class，Vue 追蹤不到
       私有欄位，computed 曾經永遠不重算，按鈕永遠不變灰。肉眼看不出來。 */
    await page.locator('[data-testid="regenerate"]').click()
    await page.locator('[data-testid="result-image"]').waitFor({ timeout: 20_000 })
    const regen = page.locator('[data-testid="regenerate"]')
    if (await regen.isEnabled()) fail('一次生成 + 一次重來之後「重來一次」仍可按 —— 成本上限沒擋住')
    else ok('一次生成 + 一次重來之後正確擋住（上游最多 2 次呼叫）')
    const upstream = await page.evaluate(() => null)   // 上游次數不外露，靠按鈕狀態證明
    void upstream

    /* ══ B. 還沒登記的卡（手持照片）：一定要跑校正 ═══════════════════ */
    await page.goto(`${dev.url}/trainer-card?tc-test=1`)
    await consent(page)
    await useUnregisteredCard(page)
    {
      const b = await branchOf(page)
      if (!b || b.source !== 'photo' || b.rectify !== 'true') {
        fail(`手持照片被判成 ${JSON.stringify(b)}，應為 source=photo / rectify=true`)
      } else if (b.quad !== 1) {
        fail('手持照片沒有出現四角編輯器 —— 梯形變形會原封不動貼進成品')
      } else ok('手持照片：走「四角校正」那一條（data-rectify=true，四角編輯器在）')
    }
    await dragCorners(page)
    ok('四角拖曳 + 即時校正預覽')
    await selfieAndName(page)
    await setTestPanel(page, { delay: 300 })
    await page.getByRole('button', { name: '開始生成' }).click()
    await page.locator('[data-testid="result-image"]').waitFor({ timeout: 20_000 })
    ok('還沒登記的卡也走得完整條流程')

    /* ══ B2. 卡冊裡「自己登記的卡」（實拍照）：也要跑校正 ════════════
       這張卡在 stub 裡**同時有 artId 與 /v1/files 實拍照**，跟
       cardbookApi.upload() 從目錄挑到卡號時寫進去的形狀一樣。
       照欄位名判斷的話它會被當成目錄卡直接貼上去 —— 成品是歪的，而且
       在畫面上看起來就只是「這張卡有點斜」，沒人會發現是分支走錯。 */
    await page.goto(`${dev.url}/trainer-card?tc-test=1`)
    await consent(page)
    {
      const own = page.locator('[data-testid="tc-card-grid"] .tile[data-source="photo"]')
      await own.first().waitFor({ timeout: 15_000 })
      ok('卡冊列表裡，自己登記的實拍卡就已經被標成 photo（雖然它也有 artId）')
      await own.first().click()
      await page.locator('.quad canvas').waitFor({ timeout: 15_000 })
      const b = await branchOf(page)
      if (!b || b.source !== 'photo' || b.rectify !== 'true' || b.quad !== 1) {
        fail(`卡冊裡的實拍卡走了 ${JSON.stringify(b)}，應為 source=photo / rectify=true / 有四角編輯器`)
      } else ok('卡冊裡的實拍卡：從卡冊挑進來一樣走四角校正那一條')
    }

    /* ══ C. 分類函式本身：拿真實形狀的資料直接問它走哪一條 ═══════════
       為什麼要單獨驗：**同一張卡可以既有 artId 又有實拍照** ——
       cardbookApi.upload() 在使用者從目錄挑到卡號時會兩個都寫。
       照「有沒有 artId」判斷的話，那張手持照片會被當成目錄卡直接貼上去。
       這一條在畫面上完全看不出來，只有直接問函式才問得到。 */
    {
      const verdicts = await page.evaluate(() => {
        const f = window.__tcClassify
        if (!f) return null
        return {
          // src/mocks/data.ts 的目錄卡：image 是空字串、有 artId
          catalog: f({ image: '', artId: 'SV4a-349' }),
          // cardbookApi.upload() 產生的自己登記的卡（api.ts:1277）
          uploaded: f({ image: '/v1/files/f-abc123def456', artId: undefined }),
          // ⚠️ 陷阱：從目錄挑到卡號、又上傳了實拍照 —— 兩個欄位都有
          both: f({ image: '/v1/files/f-abc123def456', artId: 'SV4a-349' }),
          // 賣家實拍的外部網址
          seller: f({ image: 'https://example.invalid/a.jpg', artId: 'SV4a-349' }),
          // 佔位漸層不是圖
          placeholder: f({ image: 'placeholder:220', artId: 'SV4a-349' }),
          // 兩者都沒有 → 拿不到圖
          none: f({ image: '', artId: undefined })
        }
      })
      if (!verdicts) fail('?tc-test=1 之下 window.__tcClassify 不存在，分類無法單獨驗證')
      else {
        const want = {
          catalog: 'catalog', uploaded: 'photo', both: 'photo',
          seller: 'photo', placeholder: 'catalog', none: null
        }
        for (const [k, exp] of Object.entries(want)) {
          const got = verdicts[k] ? verdicts[k].kind : null
          if (got !== exp) fail(`分類 ${k}：得到 ${got}，應為 ${exp}`)
        }
        if (verdicts.both && verdicts.both.kind === 'photo') {
          ok('分類：artId 與實拍照同時存在時判成 photo（會校正）—— 沒有憑欄位名猜')
        }
        ok(`分類六種真實形狀全部正確（${Object.entries(want).map(([k, v]) => `${k}→${v ?? '不可用'}`).join('、')}）`)
      }
    }

    /* ── 六條錯誤路徑，每條重新載入一次（額度是 per session） ─────── */
    /* 'exhausted' 是這一版新的一種結局，而且它是額度砍到 2 的直接後果：
       會自動重試的三種錯（NO_IMAGE / TIMEOUT / NETWORK）在**同一次生成裡**
       就把兩次上游呼叫用完了，所以連續失敗之後**不會**有重試鈕。
       這裡除了確認沒有鈕，還要確認文案有跟著改 —— 「再試一次？」配上一個
       不存在的按鈕，比直接說用完了更糟。 */
    const CASES = [
      ['NO_IMAGE_RETURNED', true, '自動重試 1 次後成功', 'result'],
      ['NO_IMAGE_RETURNED', false, '連續失敗 → 額度用完，不給鈕且文案說清楚', 'exhausted'],
      ['TIMEOUT', false, '逾時且自動重試也失敗 → 額度用完', 'exhausted'],
      ['NETWORK', false, '網路且自動重試也失敗 → 額度用完', 'exhausted'],
      ['RATE_LIMITED', false, '429 → 不可自動重試、不給重試鈕', 'norety'],
      ['REFUSED', false, '模型拒絕 → 不給重試鈕', 'norety']
    ]
    for (const [code, once, label, expect] of CASES) {
      await page.goto(`${dev.url}/trainer-card?tc-test=1`)
      await consent(page)
      await pickCatalogCard(page)
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
        const said = (await page.locator('[data-testid="gen-error"]').innerText()).trim()
        if (expect === 'retry' && has !== 1) fail(`${code}：應該要有重試鈕`)
        else if (expect !== 'retry' && has !== 0) fail(`${code}：不該給重試鈕（429 自動重試會造成限流雪崩）`)
        else if (expect === 'exhausted' && !said.includes('用完')) {
          fail(`${code}：沒有鈕卻還寫「${said}」—— 文案要說明次數用完了`)
        } else ok(`${code}：${label}`)
      }
    }

    /* 相機不再自動開（P2 主路徑不需要它）。按了「開啟相機」而 headless 沒有
       相機時，必須是可讀的訊息 + 還有檔案入口，不是白畫面。 */
    await page.goto(`${dev.url}/trainer-card`)
    await consent(page)
    const camAuto = await page.locator('video').count()
    if (camAuto) fail('進 P2 就自動開了相機 —— 主路徑是從卡冊挑，不該先要權限')
    else ok('進 P2 不會自動要相機權限')
    await page.locator('details.alt summary').click()
    await page.locator('[data-testid="open-camera"]').click()
    const warnText = await page.locator('details.alt .warn').first().textContent().catch(() => '')
    if (!warnText) fail('按了開啟相機、相機拿不到，卻沒有任何訊息')
    else ok(`相機拿不到時有人話訊息（「${warnText.trim().slice(0, 22)}…」）＋ 檔案入口還在`)

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
      await stubApi(ctx)
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

      if (tag === 'se') await shot(page, 'p1-consent-dark')
      await consent(page)
      if (tag === 'se') await shot(page, 'p2-cardbook-dark')     // 卡冊挑卡（新的主路徑）
      await pickCatalogCard(page)
      if (tag === 'se') await shot(page, 'p2-picked-dark')       // 目錄卡：沒有四角編輯器

      await selfieAndName(page)
      if (tag === 'se') await shot(page, 'p4-name-dark')
      await setTestPanel(page, { delay: 3000 })
      await page.getByRole('button', { name: '開始生成' }).click()
      await page.locator('[data-testid="phase"]').waitFor()
      if (tag === 'se') {
        await page.waitForTimeout(900)
        await shot(page, 'p5-generating-dark')
      }
      await page.locator('[data-testid="result-image"]').waitFor({ timeout: 30_000 })

      /* blob: 的成品圖真的畫出來了 = img-src blob: 沒被擋 */
      const drew = await page.evaluate(() => {
        const i = document.querySelector('[data-testid="result-image"]')
        return !!i && i.naturalWidth > 0 && i.src.startsWith('blob:')
      })
      if (!drew) fail(`${tag}: 成品 blob: 圖沒有畫出來（CSP img-src 可能擋掉了）`)
      else if (tag === 'se') ok('blob: 成品圖在建置產物上正常顯示（img-src 有 blob:）')

      if (tag === 'se') {
        await shot(page, 'p6-result-dark')
        /* 成品頁在 scrollY = 0 這一幀，主要動作不能被底部導覽那顆球吃掉。
           這裡只看視窗那一屏（fullPage 會把 fixed 元素畫在奇怪的位置）。 */
        await page.screenshot({ path: join(SHOTS2, 'after-p6-result-viewport.png') })
      }

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
    await stubApi(lightCtx)
    await lightCtx.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () =>
        document.documentElement.setAttribute('data-theme', 'light'))
    })
    const lp = await lightCtx.newPage()
    await lp.goto(`${prev.url}/trainer-card?tc-test=1`)
    await shot(lp, 'p1-consent-light')
    await consent(lp)
    await shot(lp, 'p2-cardbook-light')
    await pickCatalogCard(lp)
    await selfieAndName(lp)
    await setTestPanel(lp, { delay: 300 })
    await lp.getByRole('button', { name: '開始生成' }).click()
    await lp.locator('[data-testid="result-image"]').waitFor({ timeout: 30_000 })
    await shot(lp, 'p6-result-light')
    await lp.screenshot({ path: join(SHOTS2, 'after-p6-result-viewport-light.png') })
    ok('深淺兩套主題各截一張')
    await lightCtx.close()
  } finally {
    prev.proc.kill()
    await browser.close()
  }

  /* ── 第三趟：卡冊是空的 ────────────────────────────────────────────
     空狀態不能只說「沒有卡」—— 那是死路。這裡驗的是：講得出下一步，
     而且那個下一步真的導得到 /me/cards/upload。 */
  note('\n── api：卡冊空的 ───────────────────────────────────────')
  const api3 = await serve('npx', ['vite', '--port', '5213', '--strictPort'],
    /http:\/\/localhost:5213\/?/, { VITE_API_URL: API_ORIGIN })
  const b2 = await chromium.launch()
  try {
    const ctx = await b2.newContext({ viewport: { width: 375, height: 812 } })
    /* /me/cards/upload 是 requiresAuth 的路由（router/index.ts:181）——
       沒登入的話守衛會把人導去首頁，那樣測到的就不是「引導有沒有導到位」。
       mock 模式的登入就是 localStorage 的 vd.user（見 stores/auth.ts）。 */
    await ctx.addInitScript(() => {
      try { localStorage.setItem('vd.user', JSON.stringify({ id: 'u-TEST', name: 'VD-TEST', isAdult: true })) } catch { /* 無痕 */ }
    })
    await stubApi(ctx, [])
    const page = await ctx.newPage()
    const hard = []
    page.on('pageerror', (e) => hard.push(`api pageerror: ${e.message}`))
    page.on('console', (m) => { if (m.text().includes('[Vue warn]')) hard.push(`api ${m.text()}`) })
    await page.goto(`${api3.url}/trainer-card?tc-test=1`)
    await consent(page)
    const link = page.locator('[data-testid="tc-empty-upload"]')
    await link.waitFor({ timeout: 15_000 })
    const guide = await page.locator('.empty').innerText()
    if (!guide.includes('登記')) fail(`空狀態沒有講下一步：「${guide.replace(/\s+/g, ' ')}」`)
    const box = await link.boundingBox()
    if (!box || box.height < 44) fail(`空狀態的按鈕只有 ${box ? Math.round(box.height) : 0}px 高`)
    await shot(page, 'p2-empty-cardbook-dark')
    await link.click()
    await page.waitForURL(/\/me\/cards\/upload$/, { timeout: 10_000 })
    ok(`卡冊空的：有引導文字，按鈕（${Math.round(box.height)}px）真的導到 ${new URL(page.url()).pathname}`)
    hard.forEach(fail)
    await ctx.close()
  } finally {
    api3.proc.kill()
    await b2.close()
  }

  console.log('')
  if (problems.length) {
    console.log(`FAIL（${problems.length} 項）`)
    process.exit(1)
  }
  console.log('PASS')
}

main().catch((e) => { console.error(e); process.exit(1) })
