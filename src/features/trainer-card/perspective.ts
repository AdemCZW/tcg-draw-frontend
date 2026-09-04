/**
 * 四點透視變換（homography）。
 *
 * ── 為什麼一定要有這個 ────────────────────────────────────────────────
 * 規格 P2 只給了一個 63:88 的對齊框，那是**取景引導，不是校正**。
 * 手持拍一張放在桌上的卡，鏡頭幾乎不可能剛好正對卡面：近的一邊大、遠的
 * 一邊小，還會帶點旋轉。把那張照片直接塞進矩形，貼上去就是一張歪的貼紙，
 * 而且四個角一定有一兩個露在手指遮罩外面。
 * 真正要做的是解出「照片上的四角 → 目標四角」的透視變換。
 *
 * ── 為什麼是「逐像素反向映射」而不是 WebGL 或三角形貼圖 ───────────────
 * 三種做法都試得出來，取捨如下：
 *
 *   逐像素反向映射（← 採用）
 *     對每個輸出像素解一次除法得到來源座標，雙線性取樣。
 *     **數學上就是精確的**，沒有近似誤差，因此「校正得準不準」可以拿
 *     已知形變的測試圖量出像素誤差來證明（見 scripts/trainer-card/
 *     verify_warp.mjs，實測 PSNR / 平均絕對誤差）。
 *     成本：卡片區域約 542×758 ≈ 41 萬像素，實測單次 ~15ms（見驗證腳本），
 *     即時預覽用降取樣版本更快。這個量級完全在手機的預算內。
 *
 *   逐三角形 affine 貼圖（drawImage + setTransform + clip）
 *     Canvas 2D 只有 affine，透視要靠把四邊形切成很多小三角形去逼近。
 *     切得不夠細會在卡面上看到摺痕，切得細則要幾百次 drawImage + clip，
 *     反而比逐像素慢；而且誤差跟切法有關，**沒辦法給出一個乾淨的誤差保證**。
 *
 *   WebGL
 *     最快，但要多維護一個 GL context、shader、context lost 的復原路徑，
 *     而且在這個站的 CSP 下還得確認沒有 blob worker 之類的東西。
 *     為了省 10ms 增加一整層失敗面，不划算。
 *
 * 這個檔案只有純函式，沒有 DOM 依賴 —— 所以 Node 裡可以直接跑數值驗證。
 */

export interface Pt { x: number; y: number }

/** 3×3 齊次矩陣，列優先（row-major）。 */
export type Mat3 = [number, number, number, number, number, number, number, number, number]

/**
 * 解 homography：把 from 的四個點映到 to 的四個點。
 *
 * 8 個未知數（h33 固定為 1），每組對應點給兩條方程式，剛好 8×8。
 * 用帶部分主元的高斯消去 —— 四個角接近共線時矩陣會病態，不選主元會直接爆掉。
 */
export function solveHomography(from: readonly Pt[], to: readonly Pt[]): Mat3 {
  if (from.length !== 4 || to.length !== 4) throw new Error('需要正好四個點')
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]!
    const { x: u, y: v } = to[i]!
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  for (let c = 0; c < 8; c++) {
    let piv = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r
    if (Math.abs(A[piv]![c]!) < 1e-12) throw new Error('四個點退化了（共線或重疊），解不出透視變換')
    ;[A[c], A[piv]] = [A[piv]!, A[c]!]
    const pr = A[c]!
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = A[r]![c]! / pr[c]!
      if (f === 0) continue
      for (let k = c; k < 9; k++) A[r]![k]! -= f * pr[k]!
    }
  }
  const h = new Array(8)
  for (let i = 0; i < 8; i++) h[i] = A[i]![8]! / A[i]![i]!
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] as Mat3
}

export function applyHomography(m: Mat3, x: number, y: number): Pt {
  const w = m[6] * x + m[7] * y + m[8]
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w }
}

/** 四邊形在目標畫布上的整數包圍框，夾在畫布內。只有框內的像素需要算。 */
function quadBounds(q: readonly Pt[], w: number, h: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of q) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  return {
    x0: Math.max(0, Math.floor(x0) - 1), y0: Math.max(0, Math.floor(y0) - 1),
    x1: Math.min(w, Math.ceil(x1) + 1), y1: Math.min(h, Math.ceil(y1) + 1)
  }
}

export interface WarpOptions {
  /**
   * 乘算層（0–255 的灰階，尺寸與輸出相同）。
   * 樣板上那塊白卡的明度圖走這裡進來：貼上去的卡吃到樣板原本的光線與
   * 手的落影，才不會像一張浮在角色前面的貼紙。null = 不做乘算。
   */
  shading?: Uint8ClampedArray | null
  /** 邊緣羽化寬度（像素）。0 = 硬邊會有鋸齒；1 左右剛好。 */
  feather?: number
}

/**
 * 把來源圖上的 srcQuad 變換貼進輸出畫布上的 dstQuad。
 *
 * 反向映射：對每個輸出像素求它在來源圖的位置（而不是把來源像素往前推）——
 * 正向映射會在放大處留下沒被寫到的洞，反向映射不會。
 *
 * 回傳新的 ImageData（dstW × dstH），四邊形外面 alpha = 0。
 */
export function warpQuad(
  src: ImageData,
  srcQuad: readonly Pt[],
  dstW: number,
  dstH: number,
  dstQuad: readonly Pt[],
  opts: WarpOptions = {}
): ImageData {
  const { shading = null, feather = 1 } = opts
  // 解的是「輸出 → 來源」，因為我們要對每個輸出像素反查來源
  const H = solveHomography(dstQuad, srcQuad)
  const out = new ImageData(dstW, dstH)
  const o = out.data
  const s = src.data
  const sw = src.width, sh = src.height
  const maxX = sw - 1, maxY = sh - 1

  // 四條邊的法線式，用來做「在不在四邊形內」與邊緣羽化。
  // dstQuad 是順時針（影像座標 y 向下），內側恆為叉積 ≥ 0 的一側。
  const E: { a: number; b: number; c: number }[] = []
  for (let i = 0; i < 4; i++) {
    const p = dstQuad[i]!, q = dstQuad[(i + 1) % 4]!
    const ex = q.x - p.x, ey = q.y - p.y
    const len = Math.hypot(ex, ey) || 1
    // 有號距離：正 = 內側。除以邊長之後單位就是像素，羽化才有物理意義
    E.push({ a: -ey / len, b: ex / len, c: (ey * p.x - ex * p.y) / len })
  }

  const { x0, y0, x1, y1 } = quadBounds(dstQuad, dstW, dstH)
  const fw = Math.max(feather, 1e-6)

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const px = x + 0.5, py = y + 0.5

      // 先做內外判定：絕大多數像素會在這裡被剔除，比先算 homography 便宜
      let cover = 1
      for (let i = 0; i < 4; i++) {
        const e = E[i]!
        const d = e.a * px + e.b * py + e.c
        if (d <= -fw) { cover = 0; break }
        if (d < fw) {
          const t = (d + fw) / (2 * fw)
          if (t < cover) cover = t
        }
      }
      if (cover <= 0) continue

      const w = H[6] * px + H[7] * py + H[8]
      const u = (H[0] * px + H[1] * py + H[2]) / w
      const v = (H[3] * px + H[4] * py + H[5]) / w
      if (u < 0 || v < 0 || u > sw || v > sh) continue

      /* 雙線性取樣。
         **這裡的 −0.5 是必要的，不是微調。** 整份程式用的是連續座標，
         像素 i 的中心在 i+0.5；而雙線性的四個樣本是「像素中心」。
         直接用 floor(u) 當索引等於假設像素 i 的中心在 i，整張圖就會
         往左上偏半格 —— 而且是系統性的，往返一次累積成 1.3px。
         這個錯不會讓畫面壞掉，只會讓卡片整體偏移，用眼睛看不出來；
         是驗證腳本的基準點重心量出來的（見 verify_warp.mjs）。 */
      const su = u - 0.5, sv = v - 0.5
      const fux = Math.floor(su), fvy = Math.floor(sv)
      const fx = su - fux, fy = sv - fvy
      const ux = fux < 0 ? 0 : fux > maxX ? maxX : fux
      const vy = fvy < 0 ? 0 : fvy > maxY ? maxY : fvy
      const ux1 = fux + 1 < 0 ? 0 : fux + 1 > maxX ? maxX : fux + 1
      const vy1 = fvy + 1 < 0 ? 0 : fvy + 1 > maxY ? maxY : fvy + 1
      const i00 = (vy * sw + ux) << 2
      const i10 = (vy * sw + ux1) << 2
      const i01 = (vy1 * sw + ux) << 2
      const i11 = (vy1 * sw + ux1) << 2
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy)
      const w01 = (1 - fx) * fy, w11 = fx * fy

      const di = (y * dstW + x) << 2
      let mul = 1
      if (shading) mul = shading[y * dstW + x]! / 255
      for (let k = 0; k < 3; k++) {
        const val = s[i00 + k]! * w00 + s[i10 + k]! * w10 + s[i01 + k]! * w01 + s[i11 + k]! * w11
        o[di + k] = val * mul
      }
      o[di + 3] = cover * 255
    }
  }
  return out
}

/**
 * 把四邊形校正成正矩形（＝使用者拍到的卡，拉正）。
 * dstQuad 就是整張輸出畫布的四個角，所以只是 warpQuad 的一個常見特例。
 */
export function rectifyQuad(
  src: ImageData, srcQuad: readonly Pt[], outW: number, outH: number
): ImageData {
  return warpQuad(src, srcQuad, outW, outH, [
    { x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }
  ], { feather: 0.5 })
}

/**
 * 把四個點排成「左上、右上、右下、左下」。
 *
 * 使用者拖角時可能把左上拖到右邊去，順序一亂，貼上去的卡就會鏡像或扭成
 * 蝴蝶結。每次用之前都重排一次，比在 UI 上限制拖曳範圍簡單也可靠。
 */
export function orderQuad(pts: readonly Pt[]): Pt[] {
  const cx = (pts[0]!.x + pts[1]!.x + pts[2]!.x + pts[3]!.x) / 4
  const cy = (pts[0]!.y + pts[1]!.y + pts[2]!.y + pts[3]!.y) / 4
  const ring = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  )
  let start = 0
  for (let i = 1; i < 4; i++) {
    if (ring[i]!.x + ring[i]!.y < ring[start]!.x + ring[start]!.y) start = i
  }
  return [ring[start]!, ring[(start + 1) % 4]!, ring[(start + 2) % 4]!, ring[(start + 3) % 4]!]
}
