// ------------------------------------------------------------------
// 官方卡圖示意圖（TCGdex，免 API key）
//
// 抓的是「這隻寶可夢卡面美術長怎樣」的示意圖，不對應任何特定實體卡。
//
// （原本這裡對照的是 psa.ts 抓的鑑定實拍 ——「這張實體鑑定卡長怎樣」的證明。
//  PSA 那條路已整組移除，所以現在沒有那一層了：站上唯一「這一張卡本人」
//  的圖像來源是賣家自己上傳的實拍。）
//
// 授權風險：TCGdex 條款聲明卡圖版權屬於 The Pokémon Company／任天堂，
// 且不擔保不侵權。這是多數賣卡網站對「一般卡」的實務做法（示意圖），
// 但不是零風險，上線前務必自行確認。
//
// 用途邊界：只用在賣家還沒上傳實拍的卡，且只是「示意」，
// 商品實際出貨仍以賣家實拍為準。
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
/**
 * 用 TCGdex 卡片編號直接組出圖片網址，不必查 API。
 *
 * 網址格式是固定的：assets.tcgdex.net/{lang}/{serie}/{set}/{number}/{quality}.webp
 * 例如 SV4a-349 → .../ja/SV/SV4a/349/high.webp
 *
 * 語系用日文：密卡（SAR / UR 金卡）的圖只有日文端點齊全，
 * 中文端點對這些高號段卡片全部沒有圖 —— 實測 zh-tw 的 SV4a-349 回傳 image: null。
 * 反正卡面美術是共通的，卡名我們自己用中文顯示。
 */
export function artUrlById(id: string, quality: ArtQuality = 'high'): string | null {
  const m = id.match(/^([A-Za-z]+\d*[a-zA-Z]*)-(\d+)$/)
  if (!m) return null
  const [, set, num] = m
  /* 先查修正表（見下方 serieOf 的說明）—— 字母前綴推導在 SVK / CP2 這類
     set 上會推出 404 的網址。查不到才退回推導：多數 set（SV4a → SV、
     S8a → S）推導是對的，沒必要為了少數例外去打 API。 */
  const serie = serieOf.get(set!)
    ?? set!.match(/^[A-Za-z]+/)?.[0]?.replace(/\d.*$/, '')
    ?? set!
  return `https://assets.tcgdex.net/ja/${serie}/${set}/${num}/${quality}.webp`
}

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

/* ------------------------------------------------------------------
   serie 修正表

   artUrlById() 是用「set 代號開頭的字母」去猜 serie 的，實測那個規則會錯：
   TCGdex 的 serie 跟 set 代號沒有字面關係 —— SVK 屬於 SV、CP2 屬於 XY、
   M2 屬於 M。猜錯的結果是 assets 網址 404（實測
   /ja/SVK/SVK/001/high.webp → 404，正確的是 /ja/SV/SVK/001/high.webp → 200），
   畫面上就是一張破圖，而且看起來像「這張卡沒有圖」，很難查。

   正確答案只有 API 知道（卡片詳情的 image 欄位本身就含 serie）。所以這裡
   開一張「學到就記起來」的表：卡片目錄每查到一張卡的真實圖片網址，就把
   set → serie 的對應登記進來，之後同一個 set 的其他卡就不必再猜。
   另外先塞幾組已經實測過的常見錯誤，讓沒經過目錄查詢的頁面也能對。
------------------------------------------------------------------- */
const serieOf = new Map<string, string>([
  // 實測：這三組用字母前綴推導都會推錯
  ['SVK', 'SV'],
  ['SV-P', 'SV'],
  ['CP2', 'XY']
])

/** 由卡片目錄回填。同一個 set 只要有一張卡查過詳情，整個 set 的網址就都對了 */
export function registerSerie(setCode: string, serie: string): void {
  if (setCode && serie) serieOf.set(setCode, serie)
}

/** 從 TCGdex 給的圖片基底網址反推 serie：.../assets/{lang}/{serie}/{set}/{num} */
export function serieFromImageUrl(image: string): string | null {
  const m = image.match(/assets\.tcgdex\.net\/[^/]+\/([^/]+)\/([^/]+)\//)
  return m ? m[1]! : null
}
