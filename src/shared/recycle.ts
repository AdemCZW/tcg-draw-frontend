/**
 * 回收：把抽到的卡換回站內點數。前後端共用。
 *
 * 只換點數、不換現金 —— 這是整套法律論述的前提（見 src/lib/recycle.ts 的說明）。
 *
 * ⚠️ 這套規則被換過兩次，兩次換的都是「這筆錢憑什麼是這個數字」。
 *
 * 第一版：平台照賣家自填的 refPrice 付 70%。那是一台印鈔機 ——
 * 分錄只有貸方沒有借方，賣家把價填高、自己抽光、全部回收就憑空發行點數。
 *
 * 第二版：賣家出價、玩家接受，**錢從那個池自己的保留額出**。印鈔機解掉了，
 * 但金額仍然是 refPrice × 比率 —— 地基還是那個沒有外部依據的自填數字。
 *
 * 第三版（現行）：**賣家在建池時直接宣告每個獎品的買回金額，開賣前鎖死。**
 * 那個金額被寫進 manifest 並綁進 commit（fairness.ts 的 v3），開賣後改不了。
 * 它不是「我覺得這張值多少」，是「我答應照這個價買回來」，而錢從他自己的
 * 保留額出。設太高自己賠、設太低沒人抽 —— 自我修正，不需要任何外部價格資料。
 *
 * refPrice 從此**不參與任何金額計算**，只是一個賣家標示的參考數字。
 */
export { BUYBACK_MIN, BUYBACK_MAX, buybackValid } from './pool-settlement'

import { BUYBACK_MIN } from './pool-settlement'

/**
 * 這張卡能不能走回收。
 *
 * buyback 是**那個池的賣家在開賣前宣告的**，不是全站常數。沒有值（null）
 * 代表這張卡所屬的池是舊制的池（沒有宣告過買回價），那不是錯誤，
 * 是那個池從來沒有做過這個承諾 —— UI 要照實說，不要猜一個數字給使用者看。
 */
export function recycleEligible(buyback: number | null | undefined): boolean {
  return buyback != null && buyback >= BUYBACK_MIN
}
