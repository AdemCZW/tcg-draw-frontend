// ------------------------------------------------------------------
// PSA 鑑定卡實拍圖
//
// 圖片來源是 PSA 自己拍的鑑定盒照片（PSA 的著作物），不是卡面美術，
// 用途也正好對應「證明這個 cert 編號長什麼樣」——授權上比抓官方卡圖乾淨。
//
// 安全性（重要）：
//   PSA 的 bearer token 是機密。雖然 PSA 回應 Access-Control-Allow-Origin: *
//   讓瀏覽器「能」直連，但只要 token 進了前端 bundle，任何人都能從 JS 撈走。
//   因此正式環境一律走自家後端代理：後端持有 token、抓圖、快取到 R2，
//   前端只拿到自家網域的圖片網址。
//
//   VITE_PSA_DEV_TOKEN 只在 dev server 生效（import.meta.env.DEV 為真），
//   正式建置時整段會被 tree-shake 掉，token 不會被打包。
//
// 配額（實測）：
//   免費層「每天 100 次」，超過回 429
//   {"API calls quota exceeded! maximum admitted 100 per Day"}
//   所以絕對不能每次瀏覽都打 PSA。正確作法是「上架時抓一次」：
//   賣家新增卡片 → 後端向 PSA 取圖 → 存進 R2 → 之後永遠讀 R2。
//   一張卡一輩子只需要一次呼叫，100/天足夠支撐日常上架量。
// ------------------------------------------------------------------

import { MOCK } from './api'

export interface CertImages {
  front: string | null
  back: string | null
}

// certNo → 結果。同一張卡在頁面上可能出現多次，必須去重避免重複請求。
const cache = new Map<string, Promise<CertImages | null>>()

async function viaBackend(certNo: string): Promise<CertImages | null> {
  // 後端負責持有 token、抓 PSA、快取到 R2，回傳自家網域的網址
  const res = await fetch(`/api/certs/${encodeURIComponent(certNo)}/images`)
  if (!res.ok) return null
  return res.json() as Promise<CertImages>
}

/**
 * 取得某個鑑定編號的實拍圖。查不到、無權限、或未設定時回傳 null，
 * 呼叫端應退回漸層佔位卡（PSA 2021/10 之後的 cert 才有圖）。
 */
export function certImages(certNo: string | null | undefined): Promise<CertImages | null> {
  if (!certNo) return Promise.resolve(null)

  const hit = cache.get(certNo)
  if (hit) return hit

  let task: Promise<CertImages | null>
  // 這個 if 在正式建置時整段是死碼，連同 psa-dev chunk 一起被移除
  if (import.meta.env.DEV && import.meta.env.VITE_PSA_DEV_TOKEN) {
    const token = import.meta.env.VITE_PSA_DEV_TOKEN
    task = import('./psa-dev').then(m => m.viaPsaDirect(certNo, token))
  } else if (MOCK) {
    // mock 階段沒有後端，打了只會在 console 洗一排 500
    task = Promise.resolve(null)
  } else {
    task = viaBackend(certNo)
  }

  task = task.catch(() => null)
  cache.set(certNo, task)
  return task
}
