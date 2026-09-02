/**
 * 上傳前的影像處理：定向 → 裁切 → 縮放 → 壓縮。
 *
 * 為什麼需要這一層：
 *
 * 1. iPhone 一張照片 3–5MB，行動網路上傳慢又容易斷；超過 15MB 會被上傳規則
 *    當場擋掉 —— 而使用者在手機上沒有辦法自己縮圖，那條路等於走不通。
 *    先在瀏覽器裡縮到長邊 2400px、壓成 JPEG，同一張只剩幾百 KB。
 * 2. 工單附件是爭議時的證據：站外轉手接管要靠「卡背鑑定標籤 + 手寫紙條同框」
 *    的時間戳照片，判準是那 8 位鑑定編號讀不讀得出來。壓過頭讓數字糊掉
 *    等於把證據變成廢紙，所以參數是實測出來的，不是憑感覺挑 0.8
 *    （實測數字寫在 EDIT_POLICY 上面）。
 * 3. 手持拍的照片一定歪斜、周圍一堆桌面雜物，裁切讓使用者自己把重點框起來。
 *
 * 這支只做「像素」，完全不碰上傳流程 —— useUploads 負責把結果接回去，
 * ImageCropper.vue 負責讓使用者選範圍。三件事拆開，各自都能單獨驗。
 */
import type { UploadPurpose } from './uploads'

const MB = 1024 * 1024

/* ------------------------------------------------------------------
   比例
   寶可夢卡是 63×88mm ≒ 5:7，但**不強制** —— 出貨照可能要拍整個包裝、
   工單附件可能是任何東西。所以 5:7 是選項之一（外加一條參考線），
   不是唯一的框。'source' 是「原圖比例」：整張都在框裡，一格都不裁掉。
------------------------------------------------------------------- */
export type AspectId = 'source' | 'card' | 'square' | 'wide'

/** 寬 / 高。'source' 不在這裡 —— 它的比例要看圖片本身 */
export const ASPECT_RATIO: Record<Exclude<AspectId, 'source'>, number> = {
  card: 5 / 7,
  square: 1,
  wide: 4 / 3
}
export const ASPECT_LABEL: Record<AspectId, string> = {
  source: '原圖',
  card: '卡片 5:7',
  square: '方形',
  wide: '橫幅 4:3'
}

/** 卡片比例，畫參考線用 */
export const CARD_RATIO = ASPECT_RATIO.card

export interface EditPolicy {
  /** 可以切換的比例。只給一個就等於鎖死（頭像） */
  aspects: AspectId[]
  initial: AspectId
  /** 自由比例時要不要疊一條 5:7 參考線 —— 幫助，不是限制 */
  cardGuide: boolean
  /** 輸出長邊上限 */
  maxDim: number
  /** 起始品質。太大時會自己往下降到 minQuality */
  quality: number
  minQuality: number
  /** 已經夠小就別逼人再走一次裁切：長邊與位元組都在門檻內就直接傳原檔 */
  skipDim: number
  skipBytes: number
  /** 輸出格式。一定要在後端 PURPOSES 的白名單內（見 EDIT_POLICY 上面的說明） */
  outMime: string
  /** 給人看的一句話，寫在裁切框的標題 */
  label: string
}

/* ------------------------------------------------------------------
   各用途的參數

   輸出一律 image/jpeg。理由不是「JPEG 比較好」，是**只有 image/jpeg
   同時出現在後端 files.ts 那六個用途的每一張白名單裡**（seller-doc 只收
   jpeg/png/pdf，沒有 webp）。轉檔後的 mime 落在白名單外，presign 會回 400，
   而那個 400 在本機 mock 模式看不出來 —— 這種錯誤只會在正式環境爆。

   ⚠️ 契約：policy 不是 null 的用途，呼叫端**必須**把 ImageCropper 掛出來
   （看 useUploads 回傳的 editTarget）。不掛的話檔案會停在 editing 狀態，
   永遠不會開始上傳，而且畫面上看不出來為什麼。

   ── ticket-doc 的數字是實測出來的，不是猜的 ──
   工單附件現在是「站外轉手接管」的證據：卡背鑑定標籤 + 手寫紙條同框，
   使用者手持拍攝、一定歪斜。爭議時要讀的就是標籤上那 8 位鑑定編號，
   壓過頭讓數字糊掉等於把證據變成廢紙。

   做法：合成一張 4000×3000 的手持照（標籤傾斜、有感光雜訊、紙條同框），
   數字高度只佔畫面高度的 1.47%（比真實拍攝更嚴苛），跑 5 種解析度 × 5 種
   品質，把數字區域用最近鄰放大回來實際看。結論：
     · 長邊 800px  → 數字只剩 5px 高，q0.82 也一樣糊成色塊（25KB），**救不回來**
     · 長邊 1200px → q0.6 已在邊緣、q0.7 讀得出來（36KB），這是可讀下限
     · 長邊 1600px → q0.6 就乾淨（47KB）
     · 長邊 2400px + q0.82 → 邊緣與原檔幾乎沒有差別，249KB（原檔 1.76MB，7.2 倍）
   取 2400 / 0.82：是可讀下限（1200px）的兩倍解析度，留了整整一級餘裕。
   證據照寧可多傳 200KB，也不要在爭議時發現數字糊了 —— 那時已經沒有第二次機會。
   品質往下掉對數字的傷害遠小於解析度，所以 encodeWithin 也是先降品質再降解析度。

   avatar 反過來 —— 頭像最大顯示不過 96px，512 已經是兩倍餘裕。
------------------------------------------------------------------- */
export const EDIT_POLICY: Record<UploadPurpose, EditPolicy | null> = {
  /* 工單附件＝證據，重清晰（數字要讀得出來，見上面的實測）。
     預設「原圖比例」不裁掉任何東西：接管證據要標籤與紙條**同框**，
     預設就切成 5:7 等於幫使用者把證據裁掉一半。5:7 用參考線提示就好。
     PDF 不是影像，policy 再寬也輪不到它 —— 見 planFor() 的 EDITABLE。
     跳過門檻放寬到 2600px / 1.2MB：手機截圖（1179×2556、幾百 KB）本來就
     方正也夠小，不該被逼著再走一次裁切；手持拍的照片一定超過 1.2MB，會進裁切。 */
  'ticket-doc': {
    aspects: ['source', 'card', 'square', 'wide'], initial: 'source', cardGuide: true,
    maxDim: 2400, quality: 0.82, minQuality: 0.62,
    skipDim: 2600, skipBytes: 1.2 * MB,
    outMime: 'image/jpeg', label: '附件'
  },
  /* 封面，重構圖不是重證據。列表上是卡片形狀，所以預設就給 5:7 的框 */
  'pool-cover': {
    aspects: ['card', 'wide', 'square', 'source'], initial: 'card', cardGuide: false,
    maxDim: 1600, quality: 0.82, minQuality: 0.62,
    skipDim: 1600, skipBytes: 700 * 1024,
    outMime: 'image/jpeg', label: '池封面'
  },
  /* 卡片正面照。以前是 null，而且一句理由都沒寫 —— 那個 null 有兩個具體代價：
       1. 顯示端（CardFrontUpload 的預覽、CardArt、卡冊與市場的卡位）
          一律是 5:7 框 + object-fit: cover。手機直出的照片是 4:3，
          cover 會從中間硬切，卡的上下緣直接被裁掉，而使用者沒有任何
          辦法決定要留哪一段。
       2. card-front 的上限是 8MB，比出貨照的 15MB 更緊。手機拍的照片
          4–5MB 很常見、開了高畫質更容易破 8MB，而 precheck 會當場退掉 ——
          使用者在手機上沒有辦法自己縮圖，那條路等於走不通。
     兩件事都正好是這一層存在的理由，所以它不該是 null。

     參數比照最相近的 pool-cover（同樣是「重構圖不是重證據」的用途），
     只有兩處不同：
       · initial 一樣是 'card'，但 aspects 把 'source' 排在第二 ——
         卡本來就是 5:7，可是使用者可能拍了整個卡殼（鑑定卡的殼是 6:11 左右），
         那種要留原圖比例才不會把標籤裁掉。
       · maxDim 給 2000 而不是 1600：卡面上的圖鑑編號與鑑定標籤
         買家會拿來核對，1600 在放大看時已經開始糊。8MB 的上限撐得住。
     skipDim / skipBytes 設在 2000 / 900KB：已經夠小又方正的圖
     （例如從電腦轉存過的卡圖）不必再逼人走一次裁切。 */
  'card-front': {
    aspects: ['card', 'source', 'square', 'wide'], initial: 'card', cardGuide: true,
    maxDim: 2000, quality: 0.85, minQuality: 0.65,
    skipDim: 2000, skipBytes: 900 * 1024,
    outMime: 'image/jpeg', label: '卡片正面'
  },
  /* 頭像只有方形一種，而且一定要走裁切 —— 直接把長方形照片塞進圓框
     會從中間硬切，臉常常被切掉半邊。沒有 'source' 就沒有「跳過裁切」 */
  avatar: {
    aspects: ['square'], initial: 'square', cardGuide: false,
    maxDim: 512, quality: 0.85, minQuality: 0.7,
    skipDim: 0, skipBytes: 0,
    outMime: 'image/jpeg', label: '頭像'
  },
  /* 賣家證件：字要讀得出來（跟工單證據同一個道理），解析度不能省。
     目前還沒有任何畫面在用這個用途；真的要用的時候記得看上面那條契約，
     呼叫端要自己把 ImageCropper 掛出來。 */
  'seller-doc': {
    aspects: ['source', 'wide', 'square'], initial: 'source', cardGuide: false,
    maxDim: 2400, quality: 0.82, minQuality: 0.65,
    skipDim: 2400, skipBytes: 1.2 * MB,
    outMime: 'image/jpeg', label: '證件'
  },
  /* 出貨照：null，維持原檔直傳。
     產品決定把「寄送與出貨確認」整條移到站外（買賣雙方自己用通訊軟體確認，
     平台只給收件資訊與一個雙方按完成的機制），這個用途正在退場。
     而且它的呼叫端 ShipPhotoUpload.vue 沒有掛 ImageCropper —— 依照上面那條契約，
     這裡只要不是 null，那支元件的檔案就會全部卡在 editing。 */
  'ship-photo': null,
  /* 影片沒有 canvas 這條路，整個用途不進裁切 */
  'unbox-video': null
}

/** 瀏覽器畫得出來、我們也重編得回去的格式。HEIC 不在裡面 —— iOS 選檔時會自己轉成 JPEG */
const EDITABLE = new Set(['image/jpeg', 'image/png', 'image/webp'])

/* ------------------------------------------------------------------
   檔頭窺看

   為什麼要自己讀位元組：解碼**之前**就得知道長寬與 EXIF 方向。
   知道長寬才能在 createImageBitmap 當下就把超大圖縮下來（iOS Safari 的
   canvas 有記憶體上限，先解成 48MP 再縮就已經太遲了）；知道方向才能
   驗證瀏覽器到底有沒有幫我們轉。只讀前 256KB —— EXIF 與 SOF 都在檔頭。
------------------------------------------------------------------- */
export interface ImageMeta {
  width: number
  height: number
  /** EXIF orientation 1–8，沒有就是 1 */
  orientation: number
}

const ascii = (b: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...b.subarray(at, at + n))

/** 回傳 0 代表沒讀到 orientation 標籤 */
function exifOrientation(dv: DataView, tiff: number): number {
  if (tiff + 8 > dv.byteLength) return 0
  const tag = dv.getUint16(tiff)
  // "II" = little endian、"MM" = big endian
  const le = tag === 0x4949
  if (!le && tag !== 0x4d4d) return 0
  if (dv.getUint16(tiff + 2, le) !== 42) return 0
  let p = tiff + dv.getUint32(tiff + 4, le)
  if (p + 2 > dv.byteLength) return 0
  const n = dv.getUint16(p, le)
  p += 2
  for (let i = 0; i < n; i++, p += 12) {
    if (p + 12 > dv.byteLength) return 0
    if (dv.getUint16(p, le) === 0x0112) return dv.getUint16(p + 8, le)
  }
  return 0
}

function peekJpeg(b: Uint8Array): ImageMeta | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let off = 2
  let orientation = 1
  let width = 0
  let height = 0
  while (off + 4 <= b.length) {
    // 壞掉的檔案不能讓我們卡在無限迴圈裡，對不到 0xFF 就往前挪一格
    if (b[off] !== 0xff) { off++; continue }
    const marker = b[off + 1]!
    if (marker === 0xff) { off++; continue }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue }
    // SOS 之後是壓縮資料，再走下去只是亂讀
    if (marker === 0xda || marker === 0xd9) break
    const len = dv.getUint16(off + 2)
    if (len < 2) break
    const seg = off + 4
    if (marker === 0xe1 && seg + 6 <= b.length && ascii(b, seg, 4) === 'Exif') {
      orientation = exifOrientation(dv, seg + 6) || orientation
    }
    // SOFn（0xC4 是 DHT、0xC8 是 JPG、0xCC 是 DAC，那三個不是 SOF）
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof && !height && seg + 5 <= b.length) {
      height = dv.getUint16(seg + 1)
      width = dv.getUint16(seg + 3)
    }
    off += 2 + len
  }
  return width && height ? { width, height, orientation } : null
}

function peekPng(b: Uint8Array): ImageMeta | null {
  if (b.length < 24) return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  // IHDR 一定是第一個區塊：長度(4) + 'IHDR'(4) 之後就是寬高
  if (ascii(b, 12, 4) !== 'IHDR') return null
  return { width: dv.getUint32(16), height: dv.getUint32(20), orientation: 1 }
}

export async function peekMeta(file: Blob): Promise<ImageMeta | null> {
  try {
    const b = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer())
    if (b[0] === 0xff && b[1] === 0xd8) return peekJpeg(b)
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return peekPng(b)
    return null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------
   解碼

   EXIF 方向：iPhone 直拍的照片不會真的旋轉像素，只在檔頭插一個旗標，
   畫進 canvas 不處理就會躺著。createImageBitmap(blob, {imageOrientation:
   'from-image'}) 應該要幫我們轉 —— 但「應該」不算數，所以這裡**驗證**：
   方向 5–8 會交換長寬，把解出來的長寬跟檔頭裡的比一比就知道瀏覽器做了沒。
   沒做的話我們自己在 canvas 上補一次轉換（下面的 ORIENT 矩陣）。
   兩邊都做會轉兩次，所以一定是「先驗再補」，不是「保險起見都做」。

   方向 2/3/4 不會交換長寬，驗不出來；那三種相機幾乎不會產生
   （2/4 是鏡像、3 是 180 度），而且只要瀏覽器認得 options 就會處理。
------------------------------------------------------------------- */

/** 各方向要套的 2D 變換（引數是**原始**點陣圖的長寬） */
const ORIENT: Record<number, (w: number, h: number) => [number, number, number, number, number, number]> = {
  2: w => [-1, 0, 0, 1, w, 0],
  3: (w, h) => [-1, 0, 0, -1, w, h],
  4: (_w, h) => [1, 0, 0, -1, 0, h],
  5: () => [0, 1, 1, 0, 0, 0],
  6: (_w, h) => [0, 1, -1, 0, h, 0],
  7: (w, h) => [0, -1, -1, 0, h, w],
  8: (w, _h) => [0, -1, 1, 0, 0, w]
}

export interface Decoded {
  /** 已經轉正、可以直接 drawImage 的來源 */
  source: CanvasImageSource
  /** 解碼後的長寬（可能已經被 DECODE_CAP 縮過），所有幾何都用這一組 */
  width: number
  height: number
  /** 檔案裡**真正**的長寬（轉正後）。只拿來顯示 —— 畫面上說「原圖 4096×3072」
      而使用者手上那張其實是 8000×6000，是在騙人 */
  sourceWidth: number
  sourceHeight: number
  /** 檔頭裡的方向旗標 */
  orientation: number
  /** 瀏覽器有沒有自己轉正。null = 這張圖沒有方向旗標，無從驗起 */
  browserOriented: boolean | null
  /** 我們自己補了一次轉換 */
  manualFix: boolean
  close(): void
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

/**
 * 解碼上限。超過就在解碼當下直接縮 —— 不是為了輸出品質（輸出另外有 maxDim），
 * 是為了不要在 iOS Safari 上把一張 48MP 的圖整個攤成點陣圖。
 * 4096 對長邊 2400 的輸出還有 1.7 倍餘裕，縮圖品質綽綽有餘。
 */
const DECODE_CAP = 4096

export async function decodeOriented(file: Blob, cap = DECODE_CAP): Promise<Decoded> {
  const meta = await peekMeta(file)
  const rotates = !!meta && meta.orientation >= 5

  const opts: ImageBitmapOptions = { imageOrientation: 'from-image' }
  /* 只有「不會旋轉」時才敢下 resizeWidth/resizeHeight：兩個都指定會強制輸出尺寸，
     而旋轉之後長寬互換，指定下去就是把照片壓成錯的比例。會旋轉的那幾張是手機
     直拍（通常 12MP 以內），不縮也還在記憶體吃得下的範圍。 */
  if (meta && !rotates) {
    const long = Math.max(meta.width, meta.height)
    if (long > cap) {
      const s = cap / long
      opts.resizeWidth = Math.max(1, Math.round(meta.width * s))
      opts.resizeHeight = Math.max(1, Math.round(meta.height * s))
      opts.resizeQuality = 'high'
    }
  }

  let bmp: ImageBitmap
  let optsTaken = true
  try {
    bmp = await createImageBitmap(file, opts)
  } catch {
    // 舊 Safari 不認 options 物件會直接丟例外。退回沒有選項的解碼，方向自己補
    optsTaken = false
    bmp = await createImageBitmap(file)
  }

  const orientation = meta?.orientation ?? 1
  let browserOriented: boolean | null = null
  if (orientation >= 5) {
    // 5–8 一定交換長寬。有換 = 瀏覽器轉過了
    browserOriented = bmp.width === meta!.height && bmp.height === meta!.width
  } else if (orientation > 1) {
    browserOriented = optsTaken
  }

  /* 檔頭裡的真實長寬（轉正後）。讀不到檔頭就退回解碼後的長寬 */
  const [srcW, srcH] = meta
    ? (orientation >= 5 ? [meta.height, meta.width] : [meta.width, meta.height])
    : [bmp.width, bmp.height]

  if (orientation > 1 && browserOriented === false) {
    const [ow, oh] = orientation >= 5 ? [bmp.height, bmp.width] : [bmp.width, bmp.height]
    const cv = makeCanvas(ow, oh)
    const ctx = cv.getContext('2d')!
    ctx.setTransform(...ORIENT[orientation]!(bmp.width, bmp.height))
    ctx.drawImage(bmp, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    bmp.close()
    return {
      source: cv, width: ow, height: oh, sourceWidth: srcW, sourceHeight: srcH, orientation,
      browserOriented, manualFix: true,
      close: () => { cv.width = 0; cv.height = 0 }
    }
  }

  return {
    source: bmp, width: bmp.width, height: bmp.height, sourceWidth: srcW, sourceHeight: srcH, orientation,
    browserOriented, manualFix: false,
    close: () => bmp.close()
  }
}

/* ------------------------------------------------------------------
   裁切 + 縮放 + 編碼
------------------------------------------------------------------- */

/** 裁切範圍用「比例」而不是像素：解碼時可能已經縮過，比例才不會跟著跑掉 */
export interface FracRect { x: number; y: number; w: number; h: number }

export const FULL_FRAME: FracRect = { x: 0, y: 0, w: 1, h: 1 }

export interface EncodeResult {
  blob: Blob
  width: number
  height: number
  bytes: number
  mime: string
  quality: number
}

function toBlob(cv: HTMLCanvasElement, mime: string, q: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    cv.toBlob(b => (b ? resolve(b) : reject(new Error('這張圖壓縮失敗，請換一張'))), mime, q)
  })
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/**
 * 把來源的某一塊畫成目標尺寸。
 *
 * 為什麼要分階段減半：一次從 4000px 直接畫到 600px，多數瀏覽器的取樣是
 * 雙線性的，會直接漏掉大量像素 —— 對照片沒差，但對「卡背上的 8 位數字」
 * 就是筆畫斷掉。每次最多砍一半，等於自己做了一層 mipmap。
 */
function drawScaled(dec: Decoded, rect: FracRect, tw: number, th: number): HTMLCanvasElement {
  let sx = clamp(rect.x, 0, 1) * dec.width
  let sy = clamp(rect.y, 0, 1) * dec.height
  let sw = Math.max(1, Math.min(dec.width - sx, rect.w * dec.width))
  let sh = Math.max(1, Math.min(dec.height - sy, rect.h * dec.height))

  let src: CanvasImageSource = dec.source
  const steps: HTMLCanvasElement[] = []

  while (sw > tw * 2 && sh > th * 2) {
    const nw = Math.max(tw, Math.round(sw / 2))
    const nh = Math.max(th, Math.round(sh / 2))
    const c = makeCanvas(nw, nh)
    const cx = c.getContext('2d')!
    cx.imageSmoothingEnabled = true
    cx.imageSmoothingQuality = 'high'
    cx.drawImage(src, sx, sy, sw, sh, 0, 0, nw, nh)
    steps.push(c)
    src = c
    sx = 0; sy = 0; sw = nw; sh = nh
  }

  const out = makeCanvas(tw, th)
  const ox = out.getContext('2d')!
  /* JPEG 沒有透明通道。不先鋪白的話，PNG 的透明區在多數瀏覽器會變成純黑，
     一張去背的封面壓完會整片黑掉 */
  ox.fillStyle = '#ffffff'
  ox.fillRect(0, 0, tw, th)
  ox.imageSmoothingEnabled = true
  ox.imageSmoothingQuality = 'high'
  ox.drawImage(src, sx, sy, sw, sh, 0, 0, tw, th)

  // 中間步驟的 canvas 立刻歸零，手機上這幾張加起來可以是幾十 MB
  for (const c of steps) { c.width = 0; c.height = 0 }
  return out
}

/**
 * 目標尺寸：只縮不放。放大只會讓檔案變大又不會多出細節。
 * 收「長寬」而不是收 Decoded，是因為裁切框要用它算「輸出會是多大」，
 * 而那邊拿得到的只有響應式的長寬 —— Decoded 是個不響應的區域變數，
 * 傳它進來的話畫面上那行輸出尺寸永遠停在 0（實際踩過）。
 */
export function targetSize(srcW: number, srcH: number, rect: FracRect, maxDim: number) {
  const sw = Math.max(1, rect.w * srcW)
  const sh = Math.max(1, rect.h * srcH)
  const s = Math.min(1, maxDim / Math.max(sw, sh))
  return { w: Math.max(1, Math.round(sw * s)), h: Math.max(1, Math.round(sh * s)), scaled: s < 1 }
}

/**
 * 編碼，並且**保證**落在 maxBytes 內。
 * 先降品質（畫面上幾乎看不出來），真的還不夠才降解析度 —— 順序不能顛倒：
 * 解析度掉下去，鑑定編號就再也救不回來了。
 */
async function encodeWithin(
  cv: HTMLCanvasElement, mime: string, q0: number, qMin: number, maxBytes: number
): Promise<EncodeResult> {
  let canvas = cv
  let q = q0
  for (let round = 0; round < 4; round++) {
    for (;;) {
      const blob = await toBlob(canvas, mime, q)
      if (blob.size <= maxBytes || q <= qMin + 1e-6) {
        if (blob.size <= maxBytes) {
          return { blob, width: canvas.width, height: canvas.height, bytes: blob.size, mime, quality: q }
        }
        break
      }
      q = Math.max(qMin, q - 0.08)
    }
    // 品質見底還是太大：退一步縮解析度，品質回到起點
    const nw = Math.round(canvas.width * 0.75)
    const nh = Math.round(canvas.height * 0.75)
    if (nw < 320 || nh < 320) break
    const next = makeCanvas(nw, nh)
    const nx = next.getContext('2d')!
    nx.imageSmoothingEnabled = true
    nx.imageSmoothingQuality = 'high'
    nx.drawImage(canvas, 0, 0, nw, nh)
    if (canvas !== cv) { canvas.width = 0; canvas.height = 0 }
    canvas = next
    q = q0
  }
  const blob = await toBlob(canvas, mime, qMin)
  return { blob, width: canvas.width, height: canvas.height, bytes: blob.size, mime, quality: qMin }
}

/**
 * 裁切 + 壓縮。maxBytes 傳的是那個用途的上限（UPLOAD_RULES），
 * 這樣結果**保證**過得了後端那關 —— 不然壓完才發現超標，使用者又要重來一次。
 */
export async function renderCrop(
  dec: Decoded, rect: FracRect, policy: EditPolicy, maxBytes: number
): Promise<EncodeResult> {
  const t = targetSize(dec.width, dec.height, rect, policy.maxDim)
  const cv = drawScaled(dec, rect, t.w, t.h)
  const out = await encodeWithin(cv, policy.outMime, policy.quality, policy.minQuality, maxBytes)
  cv.width = 0; cv.height = 0
  return out
}

/* ------------------------------------------------------------------
   要不要走裁切
------------------------------------------------------------------- */
export type EditPlan = 'as-is' | 'edit'

/** 這個檔案能不能被我們重新編碼（能的話，「太大」就不是死路，壓一次就過了） */
export const isProcessable = (file: File, policy: EditPolicy | null) =>
  !!policy && EDITABLE.has(file.type)

/**
 * 'as-is' = 這個檔案直接傳原檔，連裁切框都不要開。
 *
 * 三種情形：這個用途不做影像處理（影片）、這個檔不是影像（PDF）、
 * 或者它本來就夠小夠短邊 —— 從相簿選的截圖再壓一次只是白白掉品質，
 * 還要使用者多按一次確認。
 */
export async function planFor(file: File, policy: EditPolicy | null): Promise<EditPlan> {
  if (!policy) return 'as-is'
  if (!EDITABLE.has(file.type)) return 'as-is'
  // 頭像一定要方形，再小也得裁
  if (policy.skipDim <= 0) return 'edit'
  if (file.size > policy.skipBytes) return 'edit'
  const meta = await peekMeta(file)
  // 讀不出長寬（例如 webp）就只看位元組：夠小就放行
  if (!meta) return 'as-is'
  return Math.max(meta.width, meta.height) <= policy.skipDim ? 'as-is' : 'edit'
}

/** 轉檔之後副檔名要跟著換，不然使用者下載回去會是一個打不開的 .png */
export function renamed(name: string, mime: string): string {
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
  const base = (name || '照片').replace(/\.[^./\\]{1,8}$/, '')
  return `${base}.${ext}`
}

export function fileFrom(result: EncodeResult, name: string): File {
  return new File([result.blob], renamed(name, result.mime), {
    type: result.mime, lastModified: Date.now()
  })
}

export const fmtBytes = (n: number) =>
  n >= MB ? `${(n / MB).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`
