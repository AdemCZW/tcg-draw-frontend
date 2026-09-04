/**
 * 相機與取圖。
 *
 * ── 規格 §10.1：getUserMedia 不可以指定寬高 ───────────────────────────
 * 指定了 width/height 的 ideal 值，手機會**裁切感光元件**再放大，
 * 自拍的臉會被放大、拍卡的視角會變窄。桌機看不出來，只有手機會發生。
 * 所以下面只給 facingMode，解析度交給裝置決定。
 * 降級鏈：{facingMode} → true（有些桌機外接鏡頭不認 facingMode）。
 *
 * ── 為什麼一定要有「從檔案選圖」──────────────────────────────────────
 * 兩個理由，缺一不可：
 *   1. 使用者可能早就把卡拍好放在相簿裡，逼他重拍一次是沒必要的摩擦
 *   2. headless 測試環境沒有相機。沒有這條路徑，整條流程就**測不到**
 * 所以它不是降級方案，是並列的第一級入口。
 */

export type CameraFacing = 'user' | 'environment'

export type CameraErrorKind = 'denied' | 'not-found' | 'in-use' | 'unsupported' | 'unknown'

export class CameraError extends Error {
  readonly kind: CameraErrorKind
  constructor(kind: CameraErrorKind, message: string) {
    super(message)
    this.name = 'CameraError'
    this.kind = kind
  }
}

/** 規格 §8.2：一律「人話 + 下一步」，不露技術細節。 */
export function cameraMessage(kind: CameraErrorKind): string {
  switch (kind) {
    case 'denied':
      return '需要相機權限才能拍照。請到瀏覽器的網站設定裡允許相機，或改用「從相簿選一張」。'
    case 'not-found':
      return '找不到可以用的相機。改用「從相簿選一張」就好。'
    case 'in-use':
      return '相機正被其他 App 使用中。關掉那個 App 再試一次，或改用「從相簿選一張」。'
    case 'unsupported':
      return '這個瀏覽器不支援直接拍照。請改用「從相簿選一張」。'
    default:
      return '相機打不開。改用「從相簿選一張」就好。'
  }
}

function classify(e: unknown): CameraErrorKind {
  const name = (e as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'not-found'
  if (name === 'NotReadableError' || name === 'AbortError') return 'in-use'
  return 'unknown'
}

export async function openCamera(facing: CameraFacing): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('unsupported', '此瀏覽器沒有 getUserMedia')
  }
  /* 注意：**沒有 width / height**。見檔頭。 */
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false })
  } catch (e) {
    const kind = classify(e)
    // 權限被拒就不要再降級試一次 —— 再試一次還是被拒，只是多跳一個框
    if (kind === 'denied') throw new CameraError(kind, cameraMessage(kind))
    try {
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    } catch (e2) {
      const k2 = classify(e2)
      throw new CameraError(k2, cameraMessage(k2))
    }
  }
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach(t => t.stop())
}

/**
 * 從 <video> 抓一張。回傳 ImageBitmap（比 dataURL 省記憶體，也不會經過
 * base64 那一層 —— 個人照片不該變成一條可以被不小心記錄下來的字串）。
 */
export async function grabFrame(video: HTMLVideoElement): Promise<ImageBitmap> {
  const w = video.videoWidth, h = video.videoHeight
  if (!w || !h) throw new CameraError('unknown', '相機還沒準備好')
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  c.getContext('2d')!.drawImage(video, 0, 0)
  return await createImageBitmap(c)
}

/**
 * 從 File 讀成 ImageBitmap。
 * 走 createImageBitmap 而不是 <img src=objectURL>：前者會處理 EXIF 方向
 * （imageOrientation: 'from-image'），手機直拍的照片才不會躺著。
 */
export async function bitmapFromFile(file: File): Promise<ImageBitmap> {
  if (!file.type.startsWith('image/')) throw new Error('請選一張圖片')
  return await createImageBitmap(file, { imageOrientation: 'from-image' })
}

/** ImageBitmap → Blob。分享與送進 adapter 都需要 Blob。 */
export function bitmapToBlob(bmp: ImageBitmap, type = 'image/jpeg', quality = 0.92): Promise<Blob> {
  const c = document.createElement('canvas')
  c.width = bmp.width; c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  return new Promise((resolve, reject) => {
    c.toBlob(b => (b ? resolve(b) : reject(new Error('轉檔失敗'))), type, quality)
  })
}
