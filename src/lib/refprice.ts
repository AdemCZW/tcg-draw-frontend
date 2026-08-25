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
