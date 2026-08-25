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
// ⚠️ 誰付這筆錢，2026-08 整個換掉了。
//
//   舊版：平台照賣家自填的 refPrice 付 70%。那是一台印鈔機 —— refPrice
//   沒有外部錨點（docs/HANDOFF.md 4.1），賣家把價填高、自己抽光、全部回收，
//   平台就憑空發行了點數。分錄只有貸方沒有借方。
//
//   新版：**賣家出價、玩家選擇接受，錢從那個池自己的保留額出。**
//   沒有任何新點數被創造 —— 買家拿回的就是他當初付的票金的一部分，原路退。
//   經濟意義是「這筆交易取消一半」：卡本來就還在賣家手上（從沒出貨），
//   玩家把卡還回去、拿回部分點數。
//
//   因此回收率不再是全站常數，而是**每個池的賣家設定的**（市場價 5–7 成）。
//   前端拿不到那個比率就算不出報價 —— 這是刻意的：猜一個數字顯示給使用者，
//   比誠實說「這個池不提供回收」更糟。
// ------------------------------------------------------------------
import type { CardItem } from '@/types/models'
import {
  RECYCLE_MIN_VALUE, RECYCLE_RATE_MIN, RECYCLE_RATE_MAX, recycleOfferPoints
} from '@/shared/recycle'

export { RECYCLE_MIN_VALUE, RECYCLE_RATE_MIN, RECYCLE_RATE_MAX }

export interface RecycleQuote {
  /** 接受賣家報價可得的點數（已取整） */
  points: number
  /** 卡片市值，用來對照 */
  refPrice: number
  /** 這個池的賣家設定的回收比率。null = 這個池不提供回收 */
  rate: number | null
  eligible: boolean
  reason?: string
}

/**
 * 賣家的回收報價。
 *
 * rate 由 API 隨卡片一起帶回來（`GET /v1/prizes` 的 recycle_rate）。
 * 沒有值不是錯誤，是賣家沒有提供回收 —— UI 要照實說，不要顯示一個 0 點的按鈕。
 */
export function recycleQuote(
  card: Pick<CardItem, 'refPrice'>, rate: number | null | undefined
): RecycleQuote {
  const refPrice = card.refPrice
  if (rate == null) {
    return { points: 0, refPrice, rate: null, eligible: false, reason: '這個池的賣家沒有提供回收' }
  }
  // 無條件捨去：報價寧可低於實際折算，也不要出現賣家多付的零頭
  const points = recycleOfferPoints(refPrice, rate)
  if (points < RECYCLE_MIN_VALUE) {
    return {
      points, refPrice, rate, eligible: false,
      reason: `市值過低，賣家的報價只有 ${points} 點，不足最低門檻 ${RECYCLE_MIN_VALUE} 點`
    }
  }
  return { points, refPrice, rate, eligible: true }
}
