/**
 * 成品的儲存與分享（規格 §10.2）。
 *
 * ── 為什麼 iOS 要用「分享」而不是「下載」──────────────────────────────
 * iOS Safari 的下載會存進「檔案」App，一般使用者在相簿裡找不到，
 * 而這個功能的整個賣點就是「直接存進相簿」。所以優先走 Web Share API，
 * 且**一定要先用 navigator.canShare({ files }) 檢查**：
 * 有 navigator.share 不代表能分享檔案（桌機 Chrome 就是這樣）。
 *
 * ── blob 必須預先備好 ─────────────────────────────────────────────────
 * iOS 對 navigator.share 有使用者手勢限制：按鈕的 click handler 裡如果先
 * await 一個非同步工作（例如 canvas.toBlob）再呼叫 share，手勢已經過期，
 * 分享會被靜默擋掉。所以成品一畫完就立刻轉好 blob 放著，
 * 按鈕按下去那一刻是同步呼叫 share。
 */

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled'

export function canShareFiles(file: File): boolean {
  return typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    typeof navigator.share === 'function' &&
    navigator.canShare({ files: [file] })
}

export function makeFile(blob: Blob, name = 'trainer-card.png'): File {
  return new File([blob], name, { type: blob.type || 'image/png' })
}

/**
 * 存檔。**必須在使用者手勢的 handler 裡同步呼叫**，file 要事先備好。
 */
export async function saveOrShare(file: File, fallbackName: string): Promise<SaveOutcome> {
  if (canShareFiles(file)) {
    try {
      await navigator.share({ files: [file] })
      return 'shared'
    } catch (e) {
      // 使用者自己按取消不是錯誤，不該跳錯誤訊息
      if ((e as { name?: string })?.name === 'AbortError') return 'cancelled'
      // 其他失敗就掉到下載，總比什麼都沒有好
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = fallbackName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 會讓部分瀏覽器的下載中斷，等一拍
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloaded'
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('產生圖片失敗'))), type)
  })
}
