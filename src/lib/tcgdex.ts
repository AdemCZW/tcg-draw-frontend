// ------------------------------------------------------------------
// 官方卡圖示意圖（TCGdex，免 API key）
//
// 跟 psa.ts 不同層級的東西：PSA 圖是「這張實體鑑定卡長怎樣」的證明；
// 這裡抓的是「這隻寶可夢卡面美術長怎樣」的示意圖，不對應任何特定實體卡。
//
// 授權風險高於 PSA 路徑 —— TCGdex 條款聲明卡圖版權屬於 The Pokémon
// Company／任天堂，且不擔保不侵權。這是多數賣卡網站對「一般卡」的
// 實務做法（示意圖），但不是零風險，上線前務必自行確認。
//
// 用途邊界：只用在沒有 certNo（代表未鑑定 / 賣家還沒上傳實拍）的卡，
// 且只是「示意」，商品實際出貨仍以賣家實拍或 PSA 圖為準。
// ------------------------------------------------------------------

const TCGDEX_BASE = 'https://api.tcgdex.net/v2/zh-tw'

interface TcgdexCard {
  id: string
  name: string
  image?: string
}

const cache = new Map<string, Promise<string | null>>()

/** 卡名常帶「噴火龍 ex SAR」這類變體後綴，TCGdex 收錄的是基礎名稱 */
function baseName(name: string): string {
  return name.split(/\s+/)[0] ?? name
}

async function search(name: string): Promise<string | null> {
  try {
    const res = await fetch(`${TCGDEX_BASE}/cards?name=${encodeURIComponent(name)}`)
    if (!res.ok) return null
    const list = (await res.json()) as TcgdexCard[]
    const hit = list.find(c => c.image)
    return hit ? `${hit.image}/low.webp` : null
  } catch {
    return null
  }
}

/**
 * 依卡名找一張示意圖。查不到回傳 null，呼叫端應退回漸層佔位卡。
 * 同一個卡名只查一次（快取），避免同頁重複卡片重複打 API。
 */
export function canonicalArt(name: string | null | undefined): Promise<string | null> {
  if (!name) return Promise.resolve(null)

  const hit = cache.get(name)
  if (hit) return hit

  const task = search(baseName(name)).catch(() => null)
  cache.set(name, task)
  return task
}
