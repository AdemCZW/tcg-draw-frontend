// ------------------------------------------------------------------
// 卡片目錄查詢（TCGdex）
//
// 跟 tcgdex.ts 的分工：那支只回答「這張卡的圖長怎樣」，這一支回答
// 「這是哪一張卡」—— setCode、卡號、卡名、變體。開池的獎品要有完整身分，
// 否則系統永遠對不到外部價格，也沒辦法驗證賣家手上真的是那一張。
//
// 語系一律用 /v2/ja/。實測 /v2/en/ 查不到日版卡（日文卡名在英文端點沒有
// 索引），而這個平台賣的是日版鑑定卡。
//
// ── 目錄實際可以用什麼搜（2026-08 對 api.tcgdex.net 逐一實測，不是推測）──
//
//   ?name=      日文卡名。contains、不分大小寫。「リザードン」→ 49 筆。
//   ?id=        TCGdex 卡片編號（SV4a-349）。**contains、不分大小寫** ——
//               'sv4a-349' → 1 筆，'SV4a-3' → 61 筆，'SV4a-' → 整套 320 筆。
//               支援 eq: 運算子（'eq:SV4a-349' → 1 筆）。
//   ?localId=   套內編號（349）。**只吃 contains，eq: 無效** ——
//               實測 'localId=eq:349' → 0 筆、'localId=349' → 2 筆
//               （MC-349 與 SV4a-349）。所以精確比對只能撈回來自己濾。
//   ?dexId=     全國圖鑑編號。contains 會亂中（'6' → 2397 筆），
//               但 'eq:25' → 63 筆是準的。
//
// **英文卡名：日版目錄沒有。** /v2/en/sets/SV4a → 404，
// /v2/en/cards/SV4a-349 → 404 —— 日版套牌在英文端點整組不存在，
// 所以「同一張日版卡的英文名」這個欄位並不存在，做不出來就不要假裝。
// 唯一做得出來的是**繞路**：英文卡名 → 英文端點查到那張卡 → 它的 dexId
// → 用 dexId 回頭查日版目錄。對得到的是「同一隻寶可夢」而不是「同一張卡」，
// 所以 UI 必須照實講（見 SearchResult.bridge）。訓練家卡與能量卡沒有 dexId，
// 這條路對它們無效，也要照實講。
// ------------------------------------------------------------------

import { artUrlById, registerSerie, serieFromImageUrl, type ArtQuality } from './tcgdex'

const BASE = 'https://api.tcgdex.net/v2/ja'
/* 只有「英文名 → dexId」那一步會打這裡。日版卡本身在這個端點不存在 */
const BASE_EN = 'https://api.tcgdex.net/v2/en'

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

async function getJson<T>(path: string, signal?: AbortSignal, base: string = BASE): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`, { signal })
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
 * 搜尋結果。
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
  /** 這一次**實際**是用哪一個欄位查到的。畫面要照實說，不能讓使用者猜 */
  field: SearchField
  /** 命中太多、被截掉的筆數。0 代表全部都列出來了 */
  truncated: number
  /**
   * 英文名繞路時對到的那隻寶可夢。
   * 有值就代表這一頁結果**不是**「這張卡的英文名」，而是「這隻寶可夢的所有日版卡」，
   * 畫面必須講出來 —— 不講的話使用者會以為系統認得英文卡名。
   */
  bridge: { enName: string; dexId: number } | null
}

/**
 * 使用者到底是用什麼在搜。
 *   name-ja  日文卡名
 *   card-no  卡號（SV4a-349 / 349/190 / 349）
 *   set      整套代號（SV4a）
 *   name-en  英文寶可夢名繞 dexId
 */
export type SearchField = 'name-ja' | 'card-no' | 'set' | 'name-en'

/* 一次最多列這麼多張。整套 320 張全畫出來只會讓手機捲不完，
   而且那不是「挑」，是「翻」。超過就截掉並照實說截了幾張。 */
const MAX_HITS = 120

const searchCache = new Map<string, SearchResult>()

/* ---------- 小工具 ---------- */

/** set 代號是 id 去掉最後一段編號（SV4a-349 → SV4a、SV-P-001 → SV-P） */
const setCodeOf = (id: string): string => id.slice(0, id.lastIndexOf('-'))

function toHits(raw: RawHit[]): { hits: CatalogHit[]; hiddenNoArt: number } {
  const withArt = raw.filter(c => !!c.image)
  return {
    hits: withArt.map(c => {
      learnSerie(setCodeOf(c.id), c.image)
      return { artId: c.id, localId: c.localId ?? '', name: c.name ?? '', imageBase: c.image ?? null }
    }),
    hiddenNoArt: raw.length - withArt.length
  }
}

function pack(raw: RawHit[], field: SearchField, bridge: SearchResult['bridge'] = null): SearchResult {
  const { hits, hiddenNoArt } = toHits(raw)
  return {
    hits: hits.slice(0, MAX_HITS),
    hiddenNoArt,
    field,
    truncated: Math.max(0, hits.length - MAX_HITS),
    bridge
  }
}

/**
 * 兩個套內編號算不算同一個。
 *
 * 為什麼不能直接字串相等：同一套裡卡面印的是 349，但 TCGdex 的 localId
 * 在別的套是補零的 001。使用者打「SV4a-1」要找得到 SV4a-001，
 * 打「SV4a-001」也要找得到 —— 兩邊都是數字時就比數值。
 * 非數字的 localId（TG01、SWSH001 這種）退回字串比對，不亂猜。
 */
function sameLocalId(a: string, b: string): boolean {
  if (a.toUpperCase() === b.toUpperCase()) return true
  return /^\d+$/.test(a) && /^\d+$/.test(b) && Number(a) === Number(b)
}

/* ---------- 整套的卡（給卡號與套牌代號用） ---------- */

/**
 * 撈一整套的卡，快取起來。
 *
 * 為什麼要整套撈，而不是直接查那一個編號：`?id=` 是 contains，
 * 而編號有沒有補零是每一套自己的事 —— 實測 `?id=SV4a-1` 回 60 筆
 * （SV4a-100…159），**唯獨不含 SV4a-001**，因為 'SV4a-001' 這個字串
 * 裡沒有 'SV4a-1'。要讓使用者打「SV4a-1」也找得到第 1 號，
 * 就只能把整套撈回來按**數值**比。
 *
 * 一套 320 張的回應實測 35 KB / 0.45s，而且同一套只會撈一次 ——
 * 比為了補零去猜三個網址各打一次划算，也不會漏。
 */
const setCards = new Map<string, RawHit[]>()

async function fetchSet(setCode: string, signal?: AbortSignal): Promise<RawHit[]> {
  const key = setCode.toUpperCase()
  const hit = setCards.get(key)
  if (hit) return hit
  /* 用 `SV4a-` 而不是 `SV4a`：不加尾巴的話 'SV4' 會撈到 SV4a / SV4b / SV4K，
     而使用者打的是一個明確的套。加了尾巴仍然是 contains，
     所以還要自己再濾一次 setCode 完全相等（'P-' 會撈到 'SV-P-001'）。 */
  const raw = await getJson<RawHit[]>(`/cards?id=${encodeURIComponent(setCode + '-')}`, signal)
  const mine = raw.filter(c => setCodeOf(c.id).toUpperCase() === key)
  setCards.set(key, mine)
  return mine
}

/* ---------- 套牌總張數（給「349/190」用） ---------- */

/**
 * setCode → 卡面印的總張數（cardCount.official）。
 *
 * 「349/190」裡的 190 是**分母**，它是辨識「哪一套」的唯一線索：
 * 卡號 349 在 MC 與 SV4a 兩套都有，但只有 SV4a 的分母是 190。
 * /sets 一次 16 KB、184 套，撈一次就夠整個工作階段用。
 */
let setsIndex: Promise<Map<string, number>> | null = null

function officialCounts(signal?: AbortSignal): Promise<Map<string, number>> {
  if (!setsIndex) {
    setsIndex = getJson<{ id: string; cardCount?: { official?: number } }[]>('/sets', signal)
      .then(list => new Map(list.map(s => [s.id.toUpperCase(), s.cardCount?.official ?? 0])))
      .catch(e => { setsIndex = null; throw e })   // 失敗不要把空表快取起來
  }
  return setsIndex
}

/* ---------- 英文名繞路 ---------- */

/** 英文名（小寫）→ 全國圖鑑編號。null = 查過，但那個名字沒有 dexId（訓練家 / 能量卡） */
const dexIdCache = new Map<string, { dexId: number; enName: string } | null>()

/**
 * 英文寶可夢名 → dexId。
 *
 * 做法：英文端點查卡名（先 eq: 精確，沒有再 contains）→ 取第一筆的詳情
 * → 讀 dexId。三個請求、實測 1.5 秒左右，結果快取。
 * 這是**唯一**能從英文走進日版目錄的路：日版套牌在英文端點整組是 404，
 * 所以「這張日版卡的英文名」這個欄位根本不存在（見檔案開頭的實測）。
 */
async function dexIdFromEnglish(
  q: string, signal?: AbortSignal
): Promise<{ dexId: number; enName: string } | null> {
  const key = q.toLowerCase()
  if (dexIdCache.has(key)) return dexIdCache.get(key)!

  const exact = await getJson<RawHit[]>(
    `/cards?name=${encodeURIComponent('eq:' + q)}`, signal, BASE_EN)
  const list = exact.length
    ? exact
    : await getJson<RawHit[]>(`/cards?name=${encodeURIComponent(q)}`, signal, BASE_EN)
  const first = list[0]
  if (!first) { dexIdCache.set(key, null); return null }

  const card = await getJson<{ name?: string; dexId?: number[] }>(
    `/cards/${encodeURIComponent(first.id)}`, signal, BASE_EN)
  const dexId = card.dexId?.[0]
  const out = typeof dexId === 'number'
    ? { dexId, enName: card.name ?? first.name ?? q }
    : null
  dexIdCache.set(key, out)
  return out
}

/* ---------- 分辨使用者打的是什麼 ---------- */

/* 三種不用打日文的卡號寫法。分隔符收得寬一點（空白 / - / _ / /），
   因為卡面印的是「349/190」、TCGdex 用的是「SV4a-349」，
   而使用者兩種都會打，還會打成「sv4a 349」。 */
const RE_SET_NUM = /^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z]+)*)[\s\-_/]+([0-9A-Za-z]{1,6})$/
const RE_NO_DENOM = /^(\d{1,4})\s*\/\s*(\d{1,5})$/
const RE_NUM = /^(\d{1,5})$/
const RE_SET_ONLY = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z]+)*$/
/* 英文名：純拉丁字母（含空白、撇號、句點、連字號），至少三個字元。
   兩個字元的純字母幾乎都是套牌代號（MC、SM），不是寶可夢名。 */
const RE_EN_NAME = /^[A-Za-z][A-Za-z'\u2019.\- ]{2,}$/

/* ---------- 對外的搜尋 ---------- */

/**
 * 搜卡片目錄。
 *
 * 原本這裡只有一條路：把整串字丟去 `?name=`。而 `?name=` 查的是**日文**卡名，
 * 所以不打日文就永遠是空白畫面 —— 使用者的原話是「搜索是要輸入日文，
 * 沒辦法用別的方式？」。日文輸入法在手機上是一道真實的牆。
 *
 * 現在是一條**依序往下掉**的路徑，每一段查不到就換下一段：
 *
 *   1. 349/190      卡面印的編號/總數 —— 分母用來認是哪一套
 *   2. SV4a-349     套牌代號 + 編號（大小寫、補零、空白或連字號都收）
 *   3. 349          只有編號（會跨套，全部列出來讓人用卡圖認）
 *   4. SV4a         整套代號 —— 列出整套
 *   5. Charizard    英文寶可夢名，繞 dexId 回日版目錄（見 dexIdFromEnglish）
 *   6. リザードン    日文卡名（原本唯一的一條路）
 *
 * 「往下掉」而不是「一次選定」是刻意的：分類靠的是字串長相，一定會有猜錯的
 * 時候（「Charizard 349」看起來像套牌 CHARIZARD 的第 349 號）。猜錯時空手
 * 而回是最糟的結果 —— 使用者只會得到「又是空白」。所以猜錯就往下一種試。
 */
export async function searchCards(name: string, signal?: AbortSignal): Promise<SearchResult> {
  const q = name.trim().replace(/\s+/g, ' ')
  if (!q) return { hits: [], hiddenNoArt: 0, field: 'name-ja', truncated: 0, bridge: null }

  const cached = searchCache.get(q)
  if (cached) return cached

  const result = await resolve(q, signal)
  searchCache.set(q, result)
  return result
}

async function resolve(q: string, signal?: AbortSignal): Promise<SearchResult> {
  /* ---- 1. 349/190：編號 + 卡面總數 ---- */
  const denom = RE_NO_DENOM.exec(q)
  if (denom) {
    const [, num, official] = denom
    const raw = await getJson<RawHit[]>(`/cards?localId=${encodeURIComponent(num!)}`, signal)
    const exact = raw.filter(c => sameLocalId(c.localId ?? '', num!))
    /* 分母對得起來的那一套優先。對不起來就退回「所有這個編號的卡」——
       少列比多列糟：使用者至少還能用卡圖認出是哪一張。 */
    try {
      const counts = await officialCounts(signal)
      const bySet = exact.filter(c => counts.get(setCodeOf(c.id).toUpperCase()) === Number(official))
      if (bySet.length) return pack(bySet, 'card-no')
    } catch { /* /sets 掛了不該讓整個搜尋失敗，退回不看分母 */ }
    if (exact.length) return pack(exact, 'card-no')
  }

  /* ---- 2. SV4a-349 / sv4a 349 ---- */
  const setNum = RE_SET_NUM.exec(q)
  if (setNum && /\d/.test(setNum[2]!)) {
    const [, set, num] = setNum
    const all = await fetchSet(set!, signal)
    const exact = all.filter(c => sameLocalId(c.localId ?? '', num!))
    if (exact.length) return pack(exact, 'card-no')
    /* 打到一半的編號（SV4a-3）也要有用：列出 3 開頭的那些，讓人接著挑 */
    const bare = num!.replace(/^0+/, '')
    const prefix = all.filter(c => (c.localId ?? '').replace(/^0+/, '').startsWith(bare))
    if (prefix.length) return pack(prefix, 'card-no')
  }

  /* ---- 3. 349：只有編號，跨套 ---- */
  const num = RE_NUM.exec(q)
  if (num) {
    const raw = await getJson<RawHit[]>(`/cards?localId=${encodeURIComponent(num[1]!)}`, signal)
    const exact = raw.filter(c => sameLocalId(c.localId ?? '', num[1]!))
    if (exact.length) return pack(exact, 'card-no')
  }

  /* ---- 4. SV4a：整套 ----
     長度 ≤ 5 才試。實測 /sets 的 184 個套牌代號**沒有一個超過 5 個字元**，
     所以「Charizard」這種純字母的長字串不必先去打一次必然落空的請求。 */
  if (q.length <= 5 && RE_SET_ONLY.test(q)) {
    const all = await fetchSet(q, signal)
    if (all.length) return pack(all, 'set')
  }

  /* ---- 5. Charizard：英文寶可夢名繞 dexId ---- */
  if (RE_EN_NAME.test(q)) {
    const bridge = await dexIdFromEnglish(q, signal)
    if (bridge) {
      /* dexId 一定要用 eq:。contains 是災難：實測 '6' → 2397 筆
         （把 16、26、106… 全撈進來），那不是搜尋，那是整個目錄。 */
      const raw = await getJson<RawHit[]>(`/cards?dexId=eq:${bridge.dexId}`, signal)
      if (raw.length) return pack(raw, 'name-en', bridge)
    }
  }

  /* ---- 6. 日文卡名。原本唯一的一條路，現在是最後一條 ---- */
  const raw = await getJson<RawHit[]>(`/cards?name=${encodeURIComponent(q)}`, signal)
  return pack(raw, 'name-ja')
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
