// ------------------------------------------------------------------
// 卡片目錄查詢（TCGdex）
//
// 跟 tcgdex.ts 的分工：那支只回答「這張卡的圖長怎樣」，這一支回答
// 「這是哪一張卡」—— setCode、卡號、卡名、變體。開池的獎品要有完整身分，
// 否則系統永遠對不到外部價格，也沒辦法驗證賣家手上真的是那一張。
//
// 語系一律用 /v2/ja/。實測 /v2/en/ 查不到日版卡（日文卡名在英文端點沒有
// 索引），而這個平台賣的是日版鑑定卡。
// ------------------------------------------------------------------

import { artUrlById, registerSerie, serieFromImageUrl, type ArtQuality } from './tcgdex'

const BASE = 'https://api.tcgdex.net/v2/ja'

/**
 * 一張卡的變體。
 *
 * 為什麼一定要有：同一組卡號可能是完全不同的商品。實測 SV2a-025（ピカチュウ）
 * 普卡 cardmarket 低價 €0.02，同一組卡號的マスターボールミラー €369 ——
 * 差 18,000 倍。只憑「SV2a-025」下單，賣家送哪一張都算「對」。
 *
 * TCGdex 的 variants（布林值那組）分不出這件事，要看 variants_detailed，
 * 它才有 foil（pokeball / masterball）與各自的 variantId 與價格。
 */
export interface CatalogVariant {
  /** normal / reverse / holo / … */
  type: string
  /** 箔膜種類。pokeball / masterball 就是那兩種鏡面，一般卡是 undefined */
  foil?: string | null
  /** TCGdex 對這個變體的唯一鍵。要精確指定「哪一張」時用它，不是卡號 */
  variantId: string
  /** 給人看的中文標籤 */
  label: string
  /** cardmarket 的趨勢價（歐元）。查不到是 null —— 不要退回 0 */
  priceEur: number | null
}

/** 搜尋結果的一筆。搜尋端點不回 set 資訊，所以卡號還不完整 */
export interface CatalogHit {
  /** TCGdex 卡片編號，例如 'SV4a-349'。這就是 CardItem.artId */
  artId: string
  /** 這一套裡的編號，例如 '349' */
  localId: string
  name: string
  /** TCGdex 給的圖片基底網址（不含畫質尾巴）。沒有圖的舊卡是 null */
  imageBase: string | null
}

/** 單張卡的完整身分 */
export interface CatalogCard extends CatalogHit {
  /** 例如 'SV4a' */
  setCode: string
  setName: string
  /** 例如 '349/190'，見 cardNoOf() 的說明 */
  cardNo: string
  rarity: string | null
  variants: CatalogVariant[]
}

/* ---------- 卡號 ---------- */

/**
 * 組出「編號/總數」格式的卡號。
 *
 * 實體卡卡面印的就是這個格式（349/190），玩家與外部價格網站也都用它。
 * TCGdex 把兩半拆在不同地方：localId 是編號，總數在詳情的 set.cardCount。
 *
 * 分母用 official 不用 total：official 是「官方宣告的張數」（卡面印的那個
 * 數字），total 還含密卡，所以 SV4a 的 total 是 320 而卡面印的是 190。
 * 用 total 會組出 349/320 —— 一個卡面上不存在的編號。
 *
 * official 是 0 的情況（促銷卡 SV-P 那類本來就沒有分母）不硬湊分母，
 * 直接回編號本身。憑空造一個 001/0 出來比留空更糟。
 */
export function cardNoOf(localId: string, cardCount?: { official?: number; total?: number }): string {
  const denom = cardCount?.official || 0
  return denom > 0 ? `${localId}/${denom}` : localId
}

/* ---------- 變體 ---------- */

const FOIL_LABEL: Record<string, string> = {
  pokeball: '寶貝球鏡面',
  masterball: '大師球鏡面'
}
const TYPE_LABEL: Record<string, string> = {
  normal: '普卡',
  reverse: '鏡面',
  holo: '閃卡',
  firstEdition: '初版',
  wPromo: '促銷'
}

function variantLabel(type: string, foil?: string | null): string {
  const base = TYPE_LABEL[type] ?? type
  const f = foil ? FOIL_LABEL[foil] ?? foil : null
  return f ? `${base}（${f}）` : base
}

/* TCGdex 的價格結構有 avg / low / trend / avg7…。用 trend：
   avg 是全期間平均（含很久以前的成交），low 是單一筆最低價（常常是瑕疵品）。
   trend 是它自己算的目前行情，最接近「現在值多少」。 */
type Pricing = { cardmarket?: { trend?: number; avg?: number } | null } | null | undefined
const priceOf = (p: Pricing): number | null => {
  const cm = p?.cardmarket
  /* trend 為 0 是「沒有成交資料」的哨兵值，不是「這張卡值 0 元」——
     實測 SV2a-025 的マスターボールミラー trend 就是 0（那張卡在
     cardmarket 上要價三位數歐元）。原樣顯示 €0.00 會讓賣家以為挑到廢卡，
     正好是我們要靠這個欄位避免的誤判。當成沒有資料，退回 avg，再沒有就留空。 */
  const trend = typeof cm?.trend === 'number' && cm.trend > 0 ? cm.trend : null
  const avg = typeof cm?.avg === 'number' && cm.avg > 0 ? cm.avg : null
  return trend ?? avg
}

/* ---------- 網路 ---------- */

interface RawHit { id: string; localId?: string; name?: string; image?: string }
interface RawCard extends RawHit {
  rarity?: string
  set?: { id?: string; name?: string; cardCount?: { official?: number; total?: number } }
  variants_detailed?: { type?: string; foil?: string | null; variantId?: string; pricing?: Pricing }[]
}

export class CatalogError extends Error {
  constructor(message: string, public kind: 'network' | 'server') { super(message) }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { signal })
  } catch (e) {
    // AbortError 要原樣往上丟，呼叫端靠它分辨「使用者又打了一個字」與「真的失敗」
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new CatalogError('連不上卡片目錄，請檢查網路後重試', 'network')
  }
  if (!res.ok) throw new CatalogError(`卡片目錄回應異常（${res.status}）`, 'server')
  return (await res.json()) as T
}

/** 把 API 給的圖片網址記進 serie 修正表，之後 artUrlById() 對同一個 set 就不會猜錯 */
function learnSerie(setCode: string | undefined, image: string | undefined): void {
  if (!setCode || !image) return
  const serie = serieFromImageUrl(image)
  if (serie) registerSerie(setCode, serie)
}

/**
 * 依卡名搜尋。
 *
 * 沒有圖的卡直接濾掉並回報數量 —— 實測「ピカチュウ」63 筆裡有 52 筆
 * TCGdex 根本沒有卡圖（多半是很舊的促銷卡）。這是一個要用「看的」挑的介面，
 * 一整排灰色空框既挑不出東西，也會讓人以為是程式壞了。濾掉幾張要講出來，
 * 不然使用者找不到那張卡時不知道是搜尋爛還是資料沒有。
 */
export interface SearchResult {
  hits: CatalogHit[]
  /** 因為沒有卡圖而被濾掉的筆數 */
  hiddenNoArt: number
}

const searchCache = new Map<string, SearchResult>()

export async function searchCards(name: string, signal?: AbortSignal): Promise<SearchResult> {
  const q = name.trim()
  if (!q) return { hits: [], hiddenNoArt: 0 }

  const cached = searchCache.get(q)
  if (cached) return cached

  const raw = await getJson<RawHit[]>(`/cards?name=${encodeURIComponent(q)}`, signal)
  const withArt = raw.filter(c => !!c.image)
  const result: SearchResult = {
    hits: withArt.map(c => {
      // set 代號是 id 去掉最後一段編號（SV4a-349 → SV4a、SV-P-001 → SV-P）
      const setCode = c.id.slice(0, c.id.lastIndexOf('-'))
      learnSerie(setCode, c.image)
      return { artId: c.id, localId: c.localId ?? '', name: c.name ?? '', imageBase: c.image ?? null }
    }),
    hiddenNoArt: raw.length - withArt.length
  }
  searchCache.set(q, result)
  return result
}

const detailCache = new Map<string, CatalogCard>()

/**
 * 單張卡的完整身分。
 *
 * 只在使用者「點下某一張」時才查 —— 搜尋一次可能回四十筆，每筆都查詳情
 * 就是四十個請求打在一個免費公開 API 上。卡號的分母只有詳情裡才有，
 * 所以清單上先不顯示完整卡號，選中之後才補齊。
 */
export async function cardDetail(artId: string, signal?: AbortSignal): Promise<CatalogCard> {
  const cached = detailCache.get(artId)
  if (cached) return cached

  const c = await getJson<RawCard>(`/cards/${encodeURIComponent(artId)}`, signal)
  const setCode = c.set?.id ?? artId.slice(0, artId.lastIndexOf('-'))
  learnSerie(setCode, c.image)

  const variants: CatalogVariant[] = (c.variants_detailed ?? [])
    .filter(v => !!v.variantId)
    .map(v => ({
      type: v.type ?? 'normal',
      foil: v.foil ?? null,
      variantId: v.variantId!,
      label: variantLabel(v.type ?? 'normal', v.foil),
      priceEur: priceOf(v.pricing)
    }))

  const card: CatalogCard = {
    artId: c.id,
    localId: c.localId ?? '',
    name: c.name ?? '',
    imageBase: c.image ?? null,
    setCode,
    setName: c.set?.name ?? '',
    cardNo: cardNoOf(c.localId ?? '', c.set?.cardCount),
    /* TCGdex 對沒有稀有度的卡回傳字串 'None'，不是 null ——
       原樣顯示會在畫面上出現一行「None」，那不是資訊 */
    rarity: c.rarity && c.rarity !== 'None' ? c.rarity : null,
    variants
  }
  detailCache.set(artId, card)
  return card
}

/**
 * 這張卡的圖片網址。
 *
 * 優先用 API 給的基底：那是權威答案，含正確的 serie。沒有基底（例如只知道
 * artId 的既有資料）才退回 artUrlById() 推導。
 */
export function artUrlOf(hit: { artId: string; imageBase?: string | null }, quality: ArtQuality = 'high'): string | null {
  return hit.imageBase ? `${hit.imageBase}/${quality}.webp` : artUrlById(hit.artId, quality)
}
