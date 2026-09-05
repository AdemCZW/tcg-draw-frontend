// ------------------------------------------------------------------
// 賣家標示的參考價：怎麼顯示、怎麼不要拿它算錢
//
// refPrice 是賣家自己填的，沒有任何外部依據（docs/HANDOFF.md 4.1）。
// 它現在**不參與任何金額計算** —— 回收給多少看的是賣家宣告的買回價
// （src/lib/recycle.ts），跟這個欄位沒有算式關係。
//
// 而且它是**選填的**：不填就是 null。
//   - null 要顯示成「未標示」，**不能顯示成 0**。
//     0 讀起來是「這張卡不值錢」，那跟「賣家沒有標示」是兩件完全不同的事。
//   - 任何拿 refPrice 當分母的東西（市場的折價幅度）碰到 null 一律回 null，
//     不要用 0 頂替 —— 除以 0 會得到 Infinity，然後那張卡就變成「今日最殺」。
// ------------------------------------------------------------------
import type { CardItem } from '@/types/models'

export const REF_PRICE_UNSET = '未標示'

/** 顯示用。null / undefined 一律「未標示」 */
export const refPriceText = (v: number | null | undefined) =>
  v == null ? REF_PRICE_UNSET : v.toLocaleString()

/** 數字化。**只給統計加總用**，不要拿去算任何要付出去的錢 */
export const refPriceNum = (v: number | null | undefined) => v ?? 0

/**
 * 掛單相對於賣家標示參考價的折價幅度（負數 = 比標示價便宜）。
 * 沒有標示參考價就回 null —— 沒有基準可比，不是「零折價」。
 */
export function refDiscount(l: { price: number; card: Pick<CardItem, 'refPrice'> }): number | null {
  const ref = l.card.refPrice
  if (ref == null || ref <= 0) return null
  return (l.price - ref) / ref
}

/**
 * 折數的合理下界。**跟 server/src/routes/public.ts 的 DEAL_FLOOR 是同一個數字，
 * 兩邊要一起改。**
 *
 * 為什麼有這條線：分母是賣家自己填的，所以「宣稱這張卡值掛價的 3.3 倍以上」
 * 不是一個更划算的證據，是一個平台查不動的宣稱（外部錨點還沒接，見 A-3）。
 * 後端已經不讓這種掛單排到前面、也不讓它進精選區；顯示層要跟著同一條線 ——
 * 不然會出現「排序不承認它，但每一格上面照樣印一個綠色的 -90%」，
 * 那個綠色標籤本身就是平台在替那個數字背書。
 */
export const REF_DISCOUNT_FLOOR = -0.7

/**
 * 給**畫面**用的折數。離群的宣稱回 null，畫面就不畫那個標籤。
 *
 * 跟 refDiscount 分成兩支而不是直接改它：refDiscount 回答的是
 * 「這筆相對賣家標示便宜多少」（一個算式），這一支回答的是
 * 「我們願不願意把這個數字印出來」（一個政策）。混在一起的話，
 * 之後有人要算真正的折數就會拿到一個被政策動過手腳的值。
 */
export function shownDiscount(l: { price: number; card: Pick<CardItem, 'refPrice'> }): number | null {
  const d = refDiscount(l)
  return d == null || d < REF_DISCOUNT_FLOOR ? null : d
}
