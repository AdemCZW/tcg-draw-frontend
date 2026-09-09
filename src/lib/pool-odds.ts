/**
 * 池的開賣時機率與保底回饋率。
 *
 * 定量池的「中獎率」不是一個設定值，是組成的衍生結果。
 * 它確實會隨銷售改變（100 籤裡 1 張最後賞是 1/100；賣掉 60 籤而它還沒出
 * 就變成 1/40），但**畫面上呈現的是開賣當下那一組，不是即時的**。
 *
 * ── 為什麼從「即時」改成「開賣時」（2026-09）──────────────────────────
 * 這一支原本回的是即時剩餘與即時機率。查證五家同業之後改掉：
 * **即時顯示各賞別還剩幾張，市場上零家在做**（Clove、日本トレカセンター、
 * TCG JAPAN 都只公開初始封入數，機率明確標註是發售時點的理論值）。
 * 常態是「揭露分母、不揭露分子」—— 整池剩幾籤即時公開，各賞的數字凍結。
 *
 * 但這裡刻意**不照抄**同業把「剩 N」凍住的做法。凍住的剩餘數會隨著銷售
 * 變成假的，而顯示一個自己知道會變錯的數字，比不顯示更糟
 * （日本已有律所在談這類表示與景品表示法的關係）。
 * 改成講**組成**：「這一池放了 N 張」是一句開賣後永遠為真的話，
 * 而從組成算出來的開賣時機率同樣永遠為真。
 *
 * 事後的透明度不靠這裡，靠 commit-reveal：開獎後任何人可以自己重算整個
 * 籤序（見 shared/fairness.ts）。那比「我們公布履歷」強一級 ——
 * 不需要相信我們有沒有改。
 */
import type { Pool } from '@/types/models'
import { floorRatio, floorVerdict, type FloorVerdict } from '@/shared/economics'

export interface TierOdds {
  tier: string
  /**
   * 這個賞別**放了幾張**（開賣時的封入數），不是還剩幾張。
   * 這是一句開賣後永遠為真的話，凍結的「剩餘」不是。
   */
  total: number
  /** 開賣時抽一次抽中這個賞別的機率（0–1） */
  chance: number
  /** 開賣時大約幾抽會中一次。封入 0 張時為 null（理論上不會發生） */
  oneIn: number | null
}

/**
 * 依賞別彙總**開賣時**的機率。同一個賞別可能有多個獎項（不同卡），要合併。
 *
 * 分子用 `p.total`（封入數）、分母用 `pool.totalTickets`（總籤數），
 * 兩個都是開賣就固定的值 —— 所以這個函式的輸出在整個池的生命週期裡不變。
 * 用 remaining / remainingTickets 算出來的即時值刻意不再對外呈現，理由見檔頭。
 */
export function tierOdds(pool: Pool): TierOdds[] {
  const seats = pool.totalTickets
  const byTier = new Map<string, number>()
  for (const p of pool.prizes) {
    byTier.set(p.tier, (byTier.get(p.tier) ?? 0) + p.total)
  }
  const ORDER = ['LAST', 'A', 'B', 'C', 'D', 'BUST']
  return [...byTier.entries()]
    .sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))
    .map(([tier, total]) => ({
      tier,
      total,
      chance: seats > 0 ? total / seats : 0,
      oneIn: total > 0 && seats > 0 ? seats / total : null
    }))
}

/**
 * 保底回饋率 ＝ Σ(賣家宣告的買回價 × 數量) ÷ 票收。
 * 意思是**你最少拿得回多少**，不是平均回本率。
 *
 * 優先用伺服器存的（那是開賣當下承諾的數字），沒有就從獎項現算 ——
 * 現算跟存的其實會一樣：分子（買回價）被 commit 鎖死了，不像舊制的
 * refPrice 會隨賣家心情浮動。現算只是給 mock 與還沒存下這個數字的池用。
 *
 * 回 null 表示這個池沒有宣告過買回價（買回制上線之前開的舊池）。
 * **不要退回去用 refPrice 現算一個數字** —— 那正是這次要拆掉的東西。
 */
export function poolFloor(
  pool: Pool
): { ratio: number; verdict: FloorVerdict; message: string; stored: boolean } | null {
  if (pool.floorRatio !== null && pool.floorRatio !== undefined) {
    return { ratio: pool.floorRatio, ...floorVerdict(pool.floorRatio), stored: true }
  }
  // 每一個獎項都要有宣告的買回價，缺一個就算不出誠實的下限
  if (!pool.prizes.length || pool.prizes.some(p => p.buyback == null)) return null
  const { ratio } = floorRatio(
    pool.prizes.map(p => ({ tier: p.tier, qty: p.total, buyback: p.buyback as number })),
    pool.totalTickets, pool.ticketPrice
  )
  return { ratio, ...floorVerdict(ratio), stored: false }
}

/** 機率的人話。1/40 比 2.5% 好懂，但兩個都給 */
/**
 * 機率的人話。1/40 比 2.5% 好懂，但兩個都給。
 *
 * ── 「1 / 1」這個顯示是錯的，要擋掉 ──────────────────────────────────
 * 80 籤裡放了 77 張 D 賞，oneIn ＝ 80/77 ＝ 1.04，四捨五入變 1，
 * 於是畫面上寫「1 / 1（96.3%）」—— 那讀起來是**每抽必中**，但實際上
 * 每 27 抽會有一抽不是 D 賞。分數形式只在稀有的東西上讀得準；
 * 常見的東西用百分比就好，硬湊一個分數反而在說謊。
 *
 * 門檻設在 2：oneIn 不到 2 就只給百分比。不再有「已抽完」這個狀態 ——
 * 講的是封入數，那個數字不會歸零。
 */
export const oddsText = (o: TierOdds) => {
  if (o.oneIn === null) return '—'
  const pct = `${(o.chance * 100).toFixed(1)}%`
  return o.oneIn < 2 ? pct : `1 / ${Math.round(o.oneIn)}　(${pct})`
}
