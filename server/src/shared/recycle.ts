/* ⚠️ 這個檔案是複製本，不要手動編輯。
   真正的來源是 src/shared/（repo 根目錄），改那邊之後跑
   `npm run sync-shared`（在 server/ 底下）重新產生這份複製。
   為什麼需要複製一份見 scripts/sync-shared.mjs 開頭的說明。 */
/**
 * 回收：把抽到的卡換回站內點數。前後端共用。
 *
 * 只換點數、不換現金 —— 這是整套法律論述的前提（見 src/lib/recycle.ts 的說明）。
 * 這個檔案只放規則常數與報價計算，讓前端試算跟後端結算永遠是同一個數字。
 */

/** 回收率。站上 1 元 = 1 點，refPrice 是台幣市值，所以這就是「幾折收卡」 */
export const RECYCLE_RATE = 0.7
/** 低於這個點數不開放回收 —— 手續成本比卡片本身還高 */
export const RECYCLE_MIN_VALUE = 10

export function recyclePoints(refPrice: number): number {
  return Math.floor(refPrice * RECYCLE_RATE)
}
export function recycleEligible(refPrice: number): boolean {
  return recyclePoints(refPrice) >= RECYCLE_MIN_VALUE
}
