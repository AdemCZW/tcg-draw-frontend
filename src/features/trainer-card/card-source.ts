/**
 * 「這張卡的圖從哪裡來」—— 訓練家卡 P2 的分岔點。
 *
 * ── 為什麼需要這一支 ─────────────────────────────────────────────────
 * P2 改成「從自己的卡冊挑一張」之後，挑到的卡有兩種來源，而它們需要
 * **不同的處理**：
 *
 *   catalog  圖是 TCGdex 的官方卡面掃描（assets.tcgdex.net）。
 *            正面、方正、沒有透視變形 —— 拿它去跑四角校正，等於把一張
 *            已經完美的圖多做一次不必要的重取樣，還多逼使用者拖四個角。
 *   photo    圖是使用者自己拍的照片（登記實體卡時上傳的 card-front，
 *            存成 /v1/files/<id>；或賣家實拍）。手持拍攝必然有梯形變形，
 *            **一定要走四角校正**，否則貼進成品就是一張歪的貼紙。
 *
 * ── 判準：看實際會載到的位元組，不看欄位名 ───────────────────────────
 * 直覺會想寫 `card.artId ? '目錄卡' : '自己的卡'`。**那是錯的**：
 * `cardbookApi.upload()`（src/lib/api.ts）在使用者從目錄挑到卡號時，會**同時**
 * 寫進 artId 與 frontFileId —— 也就是一張自己登記的實拍卡照樣有 artId。
 * 照欄位名判斷的話，那張手持照片會被當成目錄卡直接貼上去，成品是歪的。
 *
 * 所以這裡照 **CardArt.vue 的取圖順序**判斷 —— 那支元件決定了畫面上（以及
 * 我們等一下要餵進 canvas 的）究竟是哪一份像素：
 *
 *   1. card.image 有值且不是 'placeholder:<hue>'  → 那就是實拍圖 → photo
 *   2. 否則有 artId                                → TCGdex 卡面 → catalog
 *   3. 兩者都沒有                                  → 拿不到圖，這張卡不能用
 *
 * 判斷的是「像素從哪來」而不是「欄位長什麼樣」，所以它跟真相不會脫鉤：
 * 只要 CardArt 顯示的是實拍照，這裡就會回 photo。
 */
import type { CardItem } from '@/shared/domain'
import { API_URL } from '@/lib/config'
import { artUrlById } from '@/lib/tcgdex'

export type CardArtKind = 'catalog' | 'photo'

export interface CardArtSource {
  kind: CardArtKind
  /** 可以直接餵給 <img src> 的網址 */
  url: string
  /**
   * 這張圖要不要跑透視校正。
   * 跟 kind 一對一，但獨立成一個欄位是刻意的：呼叫端讀的是「要不要校正」
   * 這個決定本身，之後若出現第三種來源（例如掃描器直出）也不必改呼叫端。
   */
  rectify: boolean
  /** 判斷的依據，寫進 DOM 給驗收腳本讀（不對使用者顯示） */
  why: string
}

/** CardArt.vue 的同一條規則：站內檔案要補 /raw 才拿得到位元組（裸路徑回的是 JSON） */
function ownImageUrl(image: string): string {
  if (!image.startsWith('/v1/')) return image
  const path = /^\/v1\/files\/[^/]+$/.test(image) ? `${image}/raw` : image
  return `${API_URL}${path}`
}

/**
 * 這張卡的圖從哪來。拿不到圖就回 null —— 呼叫端要把這種卡標成不能選，
 * 而不是讓使用者選了才發現是一張破圖。
 */
export function classifyCardArt(card: Pick<CardItem, 'image' | 'artId'>): CardArtSource | null {
  const image = (card.image || '').trim()
  if (image && !image.startsWith('placeholder:')) {
    return {
      kind: 'photo',
      url: ownImageUrl(image),
      rectify: true,
      why: `實拍圖（card.image = ${image.startsWith('/v1/') ? '站內檔案' : '外部網址'}）`
    }
  }
  const art = card.artId ? artUrlById(card.artId) : null
  if (art) {
    return { kind: 'catalog', url: art, rectify: false, why: `TCGdex 目錄卡面（artId = ${card.artId}）` }
  }
  return null
}

/**
 * 取像素。
 *
 * 一律帶 crossOrigin='anonymous'：成品要用 getImageData 逐像素合成，
 * 沒有 CORS 的圖畫進 canvas 會把它汙染掉，getImageData 直接丟 SecurityError。
 * 帶了之後，沒有 CORS 標頭的來源會在**載入階段**就失敗 —— 那是好事：
 * 早失敗、訊息明確，比在合成到一半炸掉好查得多。
 *   · assets.tcgdex.net 實測回 `access-control-allow-origin: *`（2026-09-04）
 *   · 站內 /v1/files/:id/raw 會 302 到 R2，**R2 的 CORS 必須放行本站來源**，
 *     否則自己登記的卡在這裡讀不進來（見交付說明）
 */
export function loadCardArt(src: CardArtSource): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => { createImageBitmap(img).then(resolve, reject) }
    img.onerror = () => reject(new CardArtError(src.kind))
    img.src = src.url
  })
}

export class CardArtError extends Error {
  readonly kind: CardArtKind
  constructor(kind: CardArtKind) {
    super(kind === 'catalog'
      ? '這張卡的官方卡圖讀不進來，換一張試試。'
      : '這張卡的照片讀不進來（可能是跨網域授權還沒開）。可以改用下面的「用一張還沒登記的卡」自己拍一張。')
    this.name = 'CardArtError'
    this.kind = kind
  }
}

/**
 * 一張「不需要校正」的圖，它的四角就是圖自己的四角。
 *
 * 為什麼不是「不呼叫 warpQuad」：成品樣板上那塊卡位是**旋轉過的**四邊形
 * （量測腳本實測 +2.526°），所以任何來源的圖都得經過一次「矩形 → 目標四邊形」
 * 的映射才貼得上去，那是**擺放**不是**校正**，一次重取樣無法避免。
 * 這裡省掉的是「校正」那一段：不需要使用者拖四個角，也不會因為角拖歪而
 * 把一張本來方正的圖二次變形。
 */
export function fullFrameCorners(w: number, h: number) {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
}
