// ------------------------------------------------------------------
// 回收：把抽到的卡換回站內點數
//
// 為什麼只換點數、不換現金：
//   競品都做高比例回收（gacha.game 95%、cardz.game 85–90%），這在品類裡
//   已經是使用者的預期功能。但那些是「可以換回錢」，在台灣刑法第 266 條
//   的對價關係下幾乎沒有辯護空間 —— 付錢碰運氣、輸贏都能換回金錢，
//   構成要件就齊了。
//
//   只換站內點數、且點數永不可提現，價值就沒有流出平台，
//   整件事停留在「用點數換商品」的閉環。這條線是這個功能的全部前提，
//   一旦開放提現，前面所有法律論述同時失效。
//
// ⚠️ 「這筆錢是多少」換過兩次。
//
//   第一版：平台照賣家自填的 refPrice 付 70%。分錄只有貸方沒有借方 ——
//   那是一台印鈔機（安全稽核 C-2）。
//
//   第二版：賣家出價、玩家接受，錢從那個池自己的保留額出。印鈔機解掉了，
//   但金額仍然是 refPrice × 比率 —— 地基還是那個沒有外部依據的自填數字
//   （docs/HANDOFF.md 4.1）。
//
//   第三版（現行）：**賣家在建池時直接宣告每個獎品的買回金額，開賣前鎖死。**
//   那個金額被寫進 manifest 並綁進 commit，開賣後改不了。它不是「我覺得
//   這張值多少」，是「我答應照這個價買回來」，而錢從他自己的保留額出。
//   設太高自己賠、設太低沒人抽 —— 自我修正，不需要任何外部價格資料。
//
//   所以前端**不做任何算術**：買回價由 API 帶回來，直接顯示。
//   拿不到就照實說「這個池沒有宣告買回價」，不要猜一個數字給使用者看。
// ------------------------------------------------------------------
import {
  BUYBACK_MIN, BUYBACK_MAX, recycleEligible
} from '@/shared/recycle'

export { BUYBACK_MIN, BUYBACK_MAX }

export interface RecycleQuote {
  /** 接受買回可得的點數。這就是賣家宣告的那個數字本身，沒有經過任何換算 */
  points: number
  /** 賣家有沒有對這張卡做過買回承諾。null = 這個池是舊制的池 */
  buyback: number | null
  eligible: boolean
  reason?: string
}

/**
 * 賣家宣告的買回價。
 *
 * buyback 由 API 隨卡片一起帶回來（`GET /v1/prizes` 的 buyback）。
 * 沒有值不是錯誤，是那個池從來沒有做過這個承諾 —— UI 要照實說，
 * 不要顯示一個 0 點的按鈕，也不要拿 refPrice 湊一個數字出來。
 */
export function recycleQuote(buyback: number | null | undefined): RecycleQuote {
  const v = buyback ?? null
  if (!recycleEligible(v)) {
    return {
      points: 0, buyback: v, eligible: false,
      reason: v == null
        ? '這個池沒有宣告買回價 —— 它是買回制上線之前開的池'
        : `賣家宣告的買回價只有 ${v} 點，不足最低門檻 ${BUYBACK_MIN} 點`
    }
  }
  return { points: v as number, buyback: v, eligible: true }
}
