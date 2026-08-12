// ------------------------------------------------------------------
// 本機開發專用：直接呼叫 PSA API。
//
// 這支檔案只會被 psa.ts 在 import.meta.env.DEV 為真時動態載入，
// 正式建置時整個 chunk 不會被產生 —— 確保「送出 bearer token」的程式碼
// 不存在於公開的 bundle 中。
// ------------------------------------------------------------------
import type { CertImages } from './psa'

interface PsaImage {
  ImageURL: string
  IsFrontImage: boolean
}

export async function viaPsaDirect(certNo: string, token: string): Promise<CertImages | null> {
  const res = await fetch(
    `https://api.psacard.com/publicapi/cert/GetImagesByCertNumber/${encodeURIComponent(certNo)}`,
    { headers: { authorization: `bearer ${token}` } }
  )
  // 401 = token 無效；429 = 超過每日 100 次配額
  if (!res.ok) {
    console.warn(`[psa] cert ${certNo} 取圖失敗：HTTP ${res.status}`)
    return null
  }
  const list = (await res.json()) as PsaImage[]
  if (!Array.isArray(list) || !list.length) return null
  return {
    front: list.find(i => i.IsFrontImage)?.ImageURL ?? null,
    back: list.find(i => !i.IsFrontImage)?.ImageURL ?? null
  }
}
