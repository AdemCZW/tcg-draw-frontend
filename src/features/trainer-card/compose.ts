/**
 * 四層合成（規格 §4.1）。全部在瀏覽器 canvas 做，不呼叫任何服務。
 *
 *   ① 角色本體    ← adapter 回來的圖（這一輪 = 樣板原圖）
 *   ② 使用者的卡  ← 透視變換貼進 coords.json 的四角，並乘上樣板的陰影層
 *   ③ 手指遮罩    ← 從角色圖挖出手指，蓋在卡片上方
 *   ④ 卡框 + 名字 ← 程式畫
 *
 * ── 第 ② 層為什麼要乘陰影 ─────────────────────────────────────────────
 * 規格 §6.2 把白卡直接二值化，於是貼上去的卡是**全平的**，
 * 而樣板裡的光線、手的落影、卡緣的暗角都被丟掉了 ——
 * 結果是卡浮在角色前面，而不是被拿在手裡。
 * measure_template.py 多抽了一層明度圖（card-shading.png），
 * 這裡把它當 multiply 層乘回去。差別就在「像合成的」跟「像真的」之間。
 *
 * 乘算刻意在 warpQuad 的像素迴圈裡做，不用 canvas 的 globalCompositeOperation
 * 'multiply'：混合模式對 alpha=0 的區域行為在各家瀏覽器上不完全一致，
 * 而我們本來就已經在逐像素寫值了，順手乘一下是零成本又完全可預期。
 */
import coords from './assets/coords.json'
import templateUrl from './assets/template.jpg'
import fingerMaskUrl from './assets/finger-mask.png'
import shadingUrl from './assets/card-shading.png'
import { orderQuad, warpQuad, type Pt } from './perspective'

export { templateUrl }

export interface TemplateCoords {
  template: { width: number; height: number }
  cardQuad: [number, number][]
  measuredQuad: [number, number][]
  measuredRatio: number
  rotationDeg: number
  overlayRect: [number, number, number, number]
  namePlate: { cx: number; cy: number; w: number; h: number }
}
export const COORDS = coords as unknown as TemplateCoords

export const CARD_ASPECT = 63 / 88

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`圖片載入失敗：${src}`))
    img.src = src
  })
}

function imageDataOf(img: CanvasImageSource, w: number, h: number): ImageData {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('拿不到 2D context')
  ctx.drawImage(img, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

/** 樣板的三個衍生資產。只載一次，之後重新生成都重用。 */
export interface TemplateAssets {
  fingerMask: HTMLImageElement
  /** 陰影層攤平成單通道，直接餵給 warpQuad 的 shading 參數 */
  shading: Uint8ClampedArray
  rect: { x: number; y: number; w: number; h: number }
}

let assetsPromise: Promise<TemplateAssets> | null = null
export function loadTemplateAssets(): Promise<TemplateAssets> {
  assetsPromise ??= (async () => {
    const [mask, shade] = await Promise.all([loadImage(fingerMaskUrl), loadImage(shadingUrl)])
    const [x, y, w, h] = COORDS.overlayRect
    const sd = imageDataOf(shade, w, h)
    const flat = new Uint8ClampedArray(w * h)
    // 灰階 PNG 被 canvas 解成 RGB 三個相同的值，取一個就好
    for (let i = 0; i < flat.length; i++) flat[i] = sd.data[i * 4]!
    return { fingerMask: mask, shading: flat, rect: { x, y, w, h } }
  })()
  return assetsPromise
}

export interface ComposeInput {
  /** adapter 回來的角色圖。尺寸必須等於樣板。 */
  character: Blob
  /** 使用者拍的卡片照 */
  cardPhoto: ImageBitmap | HTMLImageElement
  /** 使用者在卡片照上標的四角（照片自己的像素座標） */
  cardCorners: Pt[]
  trainerName: string
}

/**
 * 合成成品，回傳 canvas（呼叫端自己決定要 toBlob 還是直接顯示）。
 */
export async function composeTrainerCard(input: ComposeInput): Promise<HTMLCanvasElement> {
  const { width: W, height: H } = COORDS.template
  const assets = await loadTemplateAssets()

  const charUrl = URL.createObjectURL(input.character)
  let character: HTMLImageElement
  try {
    character = await loadImage(charUrl)
  } finally {
    URL.revokeObjectURL(charUrl)
  }
  if (character.naturalWidth !== W || character.naturalHeight !== H) {
    throw new Error(`角色圖尺寸 ${character.naturalWidth}×${character.naturalHeight} 與樣板 ${W}×${H} 不符`)
  }

  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('拿不到 2D context')

  // ── ① 角色本體 ──────────────────────────────────────────────────
  ctx.drawImage(character, 0, 0)

  // ── ② 使用者的卡 ────────────────────────────────────────────────
  const { x: rx, y: ry, w: rw, h: rh } = assets.rect
  const photoW = 'width' in input.cardPhoto ? input.cardPhoto.width : 0
  const photoH = 'height' in input.cardPhoto ? input.cardPhoto.height : 0
  const photoData = imageDataOf(input.cardPhoto, photoW, photoH)

  // 目標四角換算到 overlayRect 的局部座標 —— 陰影層與遮罩都在這個座標系裡
  const dstQuad: Pt[] = COORDS.cardQuad.map(([x, y]) => ({ x: x - rx, y: y - ry }))
  const warped = warpQuad(
    photoData, orderQuad(input.cardCorners), rw, rh, dstQuad,
    { shading: assets.shading, feather: 1 }
  )

  const layer = document.createElement('canvas')
  layer.width = rw; layer.height = rh
  const lctx = layer.getContext('2d')!
  lctx.putImageData(warped, 0, 0)
  // 用 drawImage 而不是直接 putImageData 到主畫布：putImageData 會**覆寫**
  // 而不是混合，卡片四周 alpha=0 的地方會把角色挖成一個透明方框
  ctx.drawImage(layer, rx, ry)

  // ── ③ 手指遮罩 ──────────────────────────────────────────────────
  // 從**角色圖**挖手指，不是從原始樣板：換臉之後的圖若對手部有輕微重繪，
  // 用原始樣板的手指會跟角色對不上顏色。
  const fingers = document.createElement('canvas')
  fingers.width = rw; fingers.height = rh
  const fctx = fingers.getContext('2d')!
  fctx.drawImage(character, rx, ry, rw, rh, 0, 0, rw, rh)
  fctx.globalCompositeOperation = 'destination-in'
  fctx.drawImage(assets.fingerMask, 0, 0, rw, rh)
  ctx.drawImage(fingers, rx, ry)

  // ── ④ 卡框 + 名字 ───────────────────────────────────────────────
  drawFrame(ctx, W, H, input.trainerName)

  return canvas
}

/**
 * 外框與名牌。程式畫而不是一張 frame.png：
 * 框的顏色要跟站上的權杖一致（深淺兩套主題都成立），而 PNG 沒辦法跟著變。
 * 真樣板定案後若設計師要出一張正式外框圖，換成 drawImage 即可。
 */
function drawFrame(ctx: CanvasRenderingContext2D, W: number, H: number, name: string) {
  const pad = Math.round(W * 0.028)
  const r = Math.round(W * 0.045)

  ctx.save()
  // 外緣：深色描邊 + 內側一道亮邊，模擬卡片的厚度
  roundRect(ctx, pad, pad, W - pad * 2, H - pad * 2, r)
  ctx.lineWidth = pad * 1.6
  ctx.strokeStyle = '#17161a'
  ctx.stroke()
  roundRect(ctx, pad * 1.7, pad * 1.7, W - pad * 3.4, H - pad * 3.4, r * 0.82)
  ctx.lineWidth = Math.max(2, pad * 0.16)
  ctx.strokeStyle = 'rgba(247, 59, 32, .85)'
  ctx.stroke()
  ctx.restore()

  const plate = COORDS.namePlate
  const px = plate.cx - plate.w / 2
  const py = plate.cy - plate.h / 2
  ctx.save()
  roundRect(ctx, px, py, plate.w, plate.h, plate.h / 2)
  ctx.fillStyle = 'rgba(13, 12, 15, .82)'
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(244, 241, 238, .28)'
  ctx.stroke()

  ctx.fillStyle = '#f4f1ee'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const text = (name || '').trim() || '無名訓練家'
  // 字級自適應：長名字縮到塞得下為止，不讓它溢出名牌
  let size = Math.round(plate.h * 0.46)
  do {
    ctx.font = `600 ${size}px "Noto Sans TC", system-ui, sans-serif`
    if (ctx.measureText(text).width <= plate.w * 0.84) break
    size -= 4
  } while (size > 20)
  ctx.fillText(text, plate.cx, plate.cy + 2)
  ctx.restore()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * 只做透視校正、輸出拉正的卡片（P2 的預覽用）。
 * 跟合成走同一支 warpQuad，所以預覽看到的就是最後會貼上去的東西。
 */
export function rectifyPreview(
  photo: ImageBitmap | HTMLImageElement, corners: Pt[], outH = 420
): HTMLCanvasElement {
  const outW = Math.round(outH * CARD_ASPECT)
  const w = 'width' in photo ? photo.width : 0
  const h = 'height' in photo ? photo.height : 0
  const src = imageDataOf(photo, w, h)
  const data = warpQuad(src, orderQuad(corners), outW, outH, [
    { x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }
  ], { feather: 0.5 })
  const c = document.createElement('canvas')
  c.width = outW; c.height = outH
  c.getContext('2d')!.putImageData(data, 0, 0)
  return c
}
