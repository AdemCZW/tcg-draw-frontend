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

/**
 * TCGdex 每張卡只提供兩種尺寸，實測結果：
 *   low.webp  → 245×337，22 KB
 *   high.webp → 600×825，79 KB
 *
 * 預設一律用 high。原因是 DPR 2 的手機上，卡片只要顯示超過 123 CSS px 寬，
 * low 就已經在被放大 —— 而站上幾乎每個卡片版位都大於這個尺寸，
 * 先前整站卡圖偏糊的根因就在這裡。
 *
 * 只有明確極小的版位（例如列表列的 40px 縮圖）才值得指定 'low' 省流量。
 */
export type ArtQuality = 'high' | 'low'

// 快取鍵含畫質 —— 同一張卡的兩種尺寸是不同資源，共用鍵會互相覆蓋
const cache = new Map<string, Promise<string | null>>()

/** 卡名常帶「噴火龍 ex SAR」這類變體後綴，TCGdex 收錄的是基礎名稱 */
function baseName(name: string): string {
  return name.split(/\s+/)[0] ?? name
}

async function search(name: string, quality: ArtQuality): Promise<string | null> {
  try {
    const res = await fetch(`${TCGDEX_BASE}/cards?name=${encodeURIComponent(name)}`)
    if (!res.ok) return null
    const list = (await res.json()) as TcgdexCard[]
    const hit = list.find(c => c.image)
    return hit ? `${hit.image}/${quality}.webp` : null
  } catch {
    return null
  }
}

/**
 * 依卡名找一張示意圖。查不到回傳 null，呼叫端應退回漸層佔位卡。
 * 同一個卡名＋畫質只查一次（快取），避免同頁重複卡片重複打 API。
 */
export function canonicalArt(
  name: string | null | undefined,
  quality: ArtQuality = 'high'
): Promise<string | null> {
  if (!name) return Promise.resolve(null)

  const key = `${quality}:${name}`
  const hit = cache.get(key)
  if (hit) return hit

  const task = search(baseName(name), quality).catch(() => null)
  cache.set(key, task)
  return task
}
