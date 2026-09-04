/**
 * 陰影層的前後對照圖。
 *
 * 規格 §6.2 用 `mn > 200` 把樣板的白卡直接二值化 —— 那一步把樣板裡的
 * 光線、手的落影、卡緣暗角**全部丟掉**，貼上去的卡因此是全平的，
 * 看起來像浮在角色前面的一張貼紙。
 * measure_template.py 多抽了一層明度圖（card-shading.png），合成時乘回去。
 *
 * 這支腳本把「乘」與「不乘」兩種結果各輸出一張，放進 docs/shots/trainer-card/
 * 讓差別是看得到的，而不是只寫在註解裡。
 *
 * 用法：node scripts/trainer-card/shadow_compare.mjs <素材目錄>
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIX = process.argv[2]
const SHOTS = join(root, 'docs/shots/trainer-card')
mkdirSync(SHOTS, { recursive: true })

const PORT = 5214
const dev = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((res, rej) => {
  let buf = ''
  const on = (d) => { buf += d; if (buf.includes(String(PORT))) res() }
  dev.stdout.on('data', on); dev.stderr.on('data', on)
  setTimeout(() => rej(new Error(buf.slice(-300))), 60_000)
})

const cardB64 = readFileSync(join(FIX, 'card-photo.png')).toString('base64')
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(`http://localhost:${PORT}/trainer-card`)

  const out = await page.evaluate(async (b64) => {
    const [compose, persp] = await Promise.all([
      import('/src/features/trainer-card/compose.ts'),
      import('/src/features/trainer-card/perspective.ts')
    ])
    const { COORDS, loadTemplateAssets, templateUrl } = compose
    const { warpQuad, orderQuad } = persp
    const assets = await loadTemplateAssets()

    const load = (src) => new Promise((r, j) => {
      const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = src
    })
    const tpl = await load(templateUrl)
    const card = await load(`data:image/png;base64,${b64}`)

    // 跟 e2e 用的是同一張照片、同一組已知四角
    const srcQuad = orderQuad([
      { x: 196, y: 168 }, { x: 694, y: 232 }, { x: 742, y: 1012 }, { x: 140, y: 940 }
    ])
    const cc = document.createElement('canvas')
    cc.width = card.naturalWidth; cc.height = card.naturalHeight
    cc.getContext('2d').drawImage(card, 0, 0)
    const cardData = cc.getContext('2d').getImageData(0, 0, cc.width, cc.height)

    const [rx, ry, rw, rh] = COORDS.overlayRect
    const dstQuad = COORDS.cardQuad.map(([x, y]) => ({ x: x - rx, y: y - ry }))

    function render(shading) {
      const c = document.createElement('canvas')
      c.width = COORDS.template.width; c.height = COORDS.template.height
      const ctx = c.getContext('2d')
      ctx.drawImage(tpl, 0, 0)

      const layer = document.createElement('canvas')
      layer.width = rw; layer.height = rh
      layer.getContext('2d').putImageData(
        warpQuad(cardData, srcQuad, rw, rh, dstQuad, { shading, feather: 1 }), 0, 0)
      ctx.drawImage(layer, rx, ry)

      const fing = document.createElement('canvas')
      fing.width = rw; fing.height = rh
      const fc = fing.getContext('2d')
      fc.drawImage(tpl, rx, ry, rw, rh, 0, 0, rw, rh)
      fc.globalCompositeOperation = 'destination-in'
      fc.drawImage(assets.fingerMask, 0, 0, rw, rh)
      ctx.drawImage(fing, rx, ry)

      // 只裁卡片那一塊：整張圖縮小之後陰影就看不出來了
      const crop = document.createElement('canvas')
      crop.width = rw; crop.height = rh
      crop.getContext('2d').drawImage(c, rx, ry, rw, rh, 0, 0, rw, rh)
      return crop.toDataURL('image/png')
    }

    return { off: render(null), on: render(assets.shading) }
  }, cardB64)

  for (const [name, url] of [['shadow-off', out.off], ['shadow-on', out.on]]) {
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'))
    console.log(`wrote docs/shots/trainer-card/${name}.png`)
  }
} finally {
  await browser.close()
  dev.kill()
}
