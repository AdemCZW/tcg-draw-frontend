/**
 * 池的即時機率與還元率。
 *
 * 定量池的「中獎率」不是一個設定值，是組成的衍生結果 ——
 * 而且**會隨著銷售改變**：100 籤裡有 1 張最後賞，開賣時是 1/100；
 * 賣掉 60 籤而它還沒出，就變成 1/40；已經被抽走就是 0。
 *
 * 這件事本來就算得出來（伺服器回傳的池快照裡每個獎項都有 remaining），
 * 只是從來沒有呈現給買家看。而它是買家最想知道的資訊，
 * 也是公平會處理原則裡「機會中獎商品的機率」那條所指的東西。
 */
import type { Pool } from '@/types/models'
import { returnRatio, verdictOf, type ReturnVerdict } from '@/shared/economics'

export interface TierOdds {
  tier: string
  /** 這個賞別還剩幾張 */
  remaining: number
  /** 抽一次抽中這個賞別的機率（0–1） */
  chance: number
  /** 大約幾抽會中一次。剩 0 時為 null */
  oneIn: number | null
}

/** 依賞別彙總目前的機率。同一個賞別可能有多個獎項（不同卡），要合併 */
export function tierOdds(pool: Pool): TierOdds[] {
  const left = pool.remainingTickets
  const byTier = new Map<string, number>()
  for (const p of pool.prizes) {
    byTier.set(p.tier, (byTier.get(p.tier) ?? 0) + p.remaining)
  }
  const ORDER = ['LAST', 'A', 'B', 'C', 'D', 'BUST']
  return [...byTier.entries()]
    .sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))
    .map(([tier, remaining]) => ({
      tier,
      remaining,
      chance: left > 0 ? remaining / left : 0,
      // 剩 0 張就是抽不到，不要顯示成「1/∞」那種看起來像很難但還有機會的東西
      oneIn: remaining > 0 && left > 0 ? left / remaining : null
    }))
}

/**
 * 還元率。優先用伺服器存的（那是**開賣當下**承諾的數字），
 * 舊池或 mock 沒有就從獎項現算 —— 現算的會隨 refPrice 浮動，
 * 所以只當後備，不當承諾。
 */
export function poolReturn(pool: Pool): { ratio: number; verdict: ReturnVerdict; message: string; stored: boolean } {
  if (pool.returnRatio !== null && pool.returnRatio !== undefined) {
    return { ratio: pool.returnRatio, ...verdictOf(pool.returnRatio), stored: true }
  }
  const { ratio } = returnRatio(
    pool.prizes.map(p => ({ tier: p.tier, qty: p.total, unitValue: p.card.refPrice })),
    pool.totalTickets, pool.ticketPrice
  )
  return { ratio, ...verdictOf(ratio), stored: false }
}

/** 機率的人話。1/40 比 2.5% 好懂，但兩個都給 */
export const oddsText = (o: TierOdds) =>
  o.oneIn === null ? '已抽完' : `1 / ${Math.round(o.oneIn)}　(${(o.chance * 100).toFixed(1)}%)`
