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
// ------------------------------------------------------------------
import type { CardItem } from '@/types/models'

/**
 * 回收率。站上 1 元 = 1 點，卡片的 refPrice 也是台幣市值，
 * 所以這個數字直接等於「用幾折收卡、以點數支付」。
 *
 * 選 70% 的理由：
 *  - 點數只能用來抽卡，而各池還元率約 85%，所以 1 點的期望價值低於 1 元。
 *    70% 的點數回收，實際期望值約當市值的 0.7 × 0.85 ≈ 60%。
 *  - 平台收回卡片後可再上架，這部分成本是可回收的。
 *  - 不做到 90% 以上，是留出運費、金流與鑑定成本的空間。
 *
 * 要調整就改這一個常數，全站的報價與試算都跟著走。
 */
/* 常數搬到 src/shared/recycle.ts，後端結算跟這裡的試算是同一份。
   這裡 re-export 讓既有 import 不用動。 */
export { RECYCLE_RATE, RECYCLE_MIN_VALUE } from '@/shared/recycle'
import { RECYCLE_RATE, RECYCLE_MIN_VALUE } from '@/shared/recycle'

export interface RecycleQuote {
  /** 回收可得點數（已取整） */
  points: number
  /** 卡片市值，用來對照 */
  refPrice: number
  rate: number
  eligible: boolean
  reason?: string
}

export function recycleQuote(card: Pick<CardItem, 'refPrice'>): RecycleQuote {
  const refPrice = card.refPrice
  // 無條件捨去：報價寧可低於實際折算，也不要出現平台多付的零頭
  const points = Math.floor(refPrice * RECYCLE_RATE)

  if (points < RECYCLE_MIN_VALUE) {
    return {
      points,
      refPrice,
      rate: RECYCLE_RATE,
      eligible: false,
      reason: `市值過低，回收僅 ${points} 點，不足最低門檻 ${RECYCLE_MIN_VALUE} 點`
    }
  }
  return { points, refPrice, rate: RECYCLE_RATE, eligible: true }
}
