/**
 * 回收：把抽到的卡換回站內點數。前後端共用。
 *
 * 只換點數、不換現金 —— 這是整套法律論述的前提（見 src/lib/recycle.ts 的說明）。
 *
 * ⚠️ 這套規則在 2026-08 整個換掉了，換的是**誰付這筆錢**。
 *
 * 舊版：平台照賣家自填的 refPrice 付 70%。那是一台印鈔機 ——
 * refPrice 沒有外部錨點（見 docs/HANDOFF.md 4.1），賣家把價填高、自己抽光、
 * 全部回收，平台就憑空發行了點數。安全稽核 C-2 講的就是這件事。
 *
 * 新版：**賣家出價、玩家選擇接受，而且錢從那個池自己的保留額出。**
 * 沒有任何新點數被創造 —— 買家拿回的點數就是他當初付的票金的一部分，
 * 原路退回。經濟意義是「這筆交易取消一半」：卡本來就還在賣家手上
 * （從來沒有出貨），玩家把卡還回去、拿回部分點數。
 * 這同時解掉了「保留額被鎖住就付不出回收」的死結：付款來源就是那筆保留額本身。
 *
 * 報價的比率由賣家在建池時設定，上下限見 pool-settlement.ts。
 */
export {
  RECYCLE_MIN_VALUE,
  RECYCLE_RATE_MIN,
  RECYCLE_RATE_MAX,
  recycleOfferPoints,
  recycleRateValid
} from './pool-settlement'

import { RECYCLE_MIN_VALUE, recycleOfferPoints } from './pool-settlement'

/**
 * 這張卡能不能走回收。
 *
 * rate 是**那個池的賣家設定的**，不是全站常數 —— 沒有設定（null）就代表
 * 這個池不提供回收，那不是錯誤，是賣家的選擇，UI 要照實說。
 */
export function recycleEligible(refPrice: number, rate: number | null | undefined): boolean {
  if (rate == null) return false
  return recycleOfferPoints(refPrice, rate) >= RECYCLE_MIN_VALUE
}
