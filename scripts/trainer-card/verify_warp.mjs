/**
 * 透視校正的**量化**驗證。「看起來對」不算驗證。
 *
 * 流程：
 *   1. make_warp_fixture.py 用 Pillow（獨立實作）把已知圖案壓進已知的梯形
 *   2. 這支腳本用前端真正會用的 src/features/trainer-card/perspective.ts
 *      把它拉回矩形
 *   3. 跟原始圖案逐像素比對，印出 MAE / PSNR / 最大誤差，並量單次耗時
 *
 * 判定門檻寫在下面 THRESH。超過就 exit 1 —— 這支腳本是可以掛進 CI 的。
 *
 * 用法：
 *   python3 scripts/trainer-card/make_warp_fixture.py /tmp/fx
 *   node scripts/trainer-card/verify_warp.mjs /tmp/fx
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/* Node 沒有 ImageData。perspective.ts 只用到 {data,width,height} 這三個欄位，
   所以補一個最小的替身就夠了 —— 這也正是把變換寫成純函式、不碰 DOM 的好處：
   同一份程式碼在瀏覽器與 Node 裡跑的是同一條路徑。 */
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(a, b, c) {
      if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4) }
      else { this.data = a; this.width = b; this.height = c }
    }
  }
}

const { warpQuad, solveHomography, applyHomography, orderQuad } =
  await import('../../src/features/trainer-card/perspective.ts')

const dir = process.argv[2] ?? '.'
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
const [pw, ph] = meta.pattern
const [fw, fh] = meta.photo

const pattern = new ImageData(new Uint8ClampedArray(readFileSync(join(dir, 'pattern.bin'))), pw, ph)
const photo = new ImageData(new Uint8ClampedArray(readFileSync(join(dir, 'photo.bin'))), fw, fh)

/* ── 先驗解算本身：四角送進去，應該原樣映回四角 ──────────────────── */
const rect = [{ x: 0, y: 0 }, { x: pw, y: 0 }, { x: pw, y: ph }, { x: 0, y: ph }]
const H = solveHomography(rect, meta.quad)
let cornerErr = 0
for (let i = 0; i < 4; i++) {
  const got = applyHomography(H, rect[i].x, rect[i].y)
  cornerErr = Math.max(cornerErr, Math.hypot(got.x - meta.quad[i].x, got.y - meta.quad[i].y))
}

/* orderQuad 不該動已經正確的順序，打亂之後也要能還原 */
const shuffled = [meta.quad[2], meta.quad[0], meta.quad[3], meta.quad[1]]
const reordered = orderQuad(shuffled)
const orderOk = reordered.every((p, i) => p.x === meta.quad[i].x && p.y === meta.quad[i].y)

/* ── 校正：把照片裡的梯形拉回 63:88 正矩形 ───────────────────────── */
const runs = []
let out
for (let i = 0; i < 6; i++) {
  const t0 = performance.now()
  out = warpQuad(photo, meta.quad, pw, ph, rect, { feather: 0.5 })
  runs.push(performance.now() - t0)
}
runs.sort((a, b) => a - b)

/* ── 幾何誤差：把基準圓盤的重心找回來，跟已知位置比 ────────────────
      這才是「校正準不準」的直接量法。逐像素差量到的主要是重取樣把銳利
      邊緣磨掉多少（那是素材的頻寬問題），不是幾何對位。 */
function redCentroid(img, cx, cy, r) {
  let sw = 0, sx = 0, sy = 0
  const x0 = Math.max(0, Math.round(cx - r)), x1 = Math.min(img.width, Math.round(cx + r))
  const y0 = Math.max(0, Math.round(cy - r)), y1 = Math.min(img.height, Math.round(cy + r))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4
      // 「純紅程度」：圖案裡其他東西都不是純紅，這個權重只會落在圓盤上
      const w = Math.max(0, img.data[i] - Math.max(img.data[i + 1], img.data[i + 2]))
      sw += w; sx += w * (x + 0.5); sy += w * (y + 0.5)
    }
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw, w: sw } : null
}

/* 真值不是「畫圓時給的那個整數座標」，而是**同一顆圓盤在原始 pattern 上
   用同一個重心公式量到的位置**。理由：Pillow 畫橢圓的邊界怎麼取整、
   像素中心算 i 還是 i+0.5，都是繪圖端的慣例，會在真值上疊一個固定偏移
   （實測就是整齊的 −0.5px，五顆一模一樣）。拿那個偏移當校正誤差是錯的。
   兩邊用同一支尺量，剩下的差才是校正真正引入的位移。 */
let fidWorst = 0, fidSum = 0
const fidRows = []
for (const f of meta.fiducials) {
  const ref = redCentroid(pattern, f.x, f.y, 40)
  const got = redCentroid(out, f.x, f.y, 40)
  const d = got && ref ? Math.hypot(got.x - ref.x, got.y - ref.y) : Infinity
  fidRows.push([f, ref, got, d])
  fidSum += d
  if (d > fidWorst) fidWorst = d
}
const fidMean = fidSum / meta.fiducials.length

/* ── 頻寬對齊後的光度誤差 ──────────────────────────────────────────
      原始逐像素差在棋盤格邊緣一定很大：素材被 Pillow 的 bicubic 縮過一次、
      又被我們的 bilinear 放回來，高頻本來就回不來，那不是校正的錯。
      兩邊都套同一個小模糊之後再比，量到的才是「有沒有對齊」。 */
function blur3(img) {
  const { width: w, height: h, data: d } = img
  const o = new Uint8ClampedArray(d.length)
  const K = [1, 2, 1]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let k = 0; k < 3; k++) {
      let acc = 0, wt = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx
        if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue
        const g = K[dy + 1] * K[dx + 1]
        acc += g * d[(yy * w + xx) * 4 + k]; wt += g
      }
      o[(y * w + x) * 4 + k] = acc / wt
    }
  }
  return { data: o, width: w, height: h }
}
const outB = blur3(out), patB = blur3(pattern)

/* ── 比對。邊界 3px 不算：來源照片在卡緣之外是背景色，任何取樣核
      都會在那裡混到背景，那是素材的性質不是校正的錯。 ───────────── */
const M = 4
function photometric(a, b) {
  let n = 0, sum = 0, sqsum = 0, worst = 0
  for (let y = M; y < ph - M; y++) {
    for (let x = M; x < pw - M; x++) {
      const i = (y * pw + x) * 4
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(a.data[i + k] - b.data[i + k])
        sum += d; sqsum += d * d; n++
        if (d > worst) worst = d
      }
    }
  }
  const rmse = Math.sqrt(sqsum / n)
  return { mae: sum / n, rmse, psnr: 20 * Math.log10(255 / rmse), worst }
}
const raw = photometric(out, pattern)
const soft = photometric(outB, patB)
const { mae, rmse, psnr, worst } = soft

/* 存一份輸出，給人眼再看一次（不是判定依據） */
writeFileSync(join(dir, 'rectified.bin'), Buffer.from(out.data.buffer))

/* 門檻。幾何是主判定（校正的本業），光度是輔助（確認沒有整片位移或錯色）。
   0.25px 的幾何誤差門檻是有意義的：卡片實際貼上去是 542px 寬，
   0.25px 等於卡面對位誤差 0.05%，遠小於手指遮罩的羽化寬度（約 2px）。 */
const THRESH = { cornerErr: 1e-6, fidMean: 0.25, fidWorst: 0.5, mae: 3.5, psnr: 28 }
const pass = cornerErr < THRESH.cornerErr && orderOk &&
  fidMean < THRESH.fidMean && fidWorst < THRESH.fidWorst &&
  mae < THRESH.mae && psnr > THRESH.psnr

console.log('── 透視校正 量化驗證 ────────────────────────────────')
console.log(`  來源照片        ${fw}×${fh}`)
console.log(`  已知四角        ${meta.quad.map(p => `(${p.x},${p.y})`).join(' ')}`)
console.log(`  校正輸出        ${pw}×${ph}  (63:88 = ${(63 / 88).toFixed(4)}, 實際 ${(pw / ph).toFixed(4)})`)
console.log('')
console.log(`  homography 四角回代誤差   ${cornerErr.toExponential(2)} px   (門檻 < ${THRESH.cornerErr})`)
console.log(`  orderQuad 打亂後可還原    ${orderOk ? 'yes' : 'NO'}`)
console.log('')
console.log('  幾何誤差（基準圓盤重心：校正後 vs 原圖，同一支尺）')
for (const [, ref, got, d] of fidRows) {
  console.log(`    原圖 (${ref.x.toFixed(2)},${ref.y.toFixed(2)})` +
    `  → 校正後 (${got ? got.x.toFixed(2) : '—'},${got ? got.y.toFixed(2) : '—'})` +
    `   誤差 ${d.toFixed(3)} px`)
}
console.log(`    平均 ${fidMean.toFixed(3)} px（門檻 < ${THRESH.fidMean}）、` +
  `最大 ${fidWorst.toFixed(3)} px（門檻 < ${THRESH.fidWorst}）`)
console.log('')
console.log('  光度誤差（頻寬對齊後：兩邊各套同一個 3×3 模糊）')
console.log(`    MAE  ${mae.toFixed(3)} / 255   (門檻 < ${THRESH.mae})`)
console.log(`    RMSE ${rmse.toFixed(3)}   PSNR ${psnr.toFixed(2)} dB   (門檻 > ${THRESH.psnr})`)
console.log(`    單一像素最大誤差 ${worst} / 255`)
console.log(`  光度誤差（未對齊頻寬，僅供參考：主要反映兩次重取樣的銳利度損失）`)
console.log(`    MAE ${raw.mae.toFixed(3)}   PSNR ${raw.psnr.toFixed(2)} dB   最大 ${raw.worst}`)
console.log(`  單次校正耗時（6 次取中位）${runs[3].toFixed(1)} ms   ${pw}×${ph} = ${(pw * ph / 1000).toFixed(0)}k px`)
console.log('')
console.log(pass ? '  PASS' : '  FAIL')
process.exit(pass ? 0 : 1)
