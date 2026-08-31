/**
 * 池的經濟護欄。
 *
 * 為什麼要放在 shared：這套判斷原本只存在於前端的 lib/economics.ts，
 * 也就是說「數字不合理就不給開」這條規則**只在瀏覽器裡**。
 * 賣家直接打 POST /v1/pools 就能繞過去，護欄形同虛設。
 * 門檻只能有一份，前後端共用同一個檔案才不會分岔。
 *
 * ── 這個檔案在 2026-08 換過分子 ────────────────────────────────────
 *
 * 舊版算的是「還元率」＝ Σ(refPrice × 數量) ÷ 票收。分子是**賣家喊的市值**，
 * 沒有任何外部依據（docs/HANDOFF.md 4.1）—— 填高一點，還元率就漂亮一點，
 * 而那個數字同時是護欄的分母與回收付點的分子。整套一起說謊。
 *
 * 現在算的是「**保底回饋率**」＝ Σ(宣告買回價 × 數量) ÷ 票收。
 * 分子換成**賣家有義務付出去的錢**：買回價寫進 manifest 綁進 commit，
 * 開賣後改不了，玩家一按接受錢就從他的保留額出去。
 * 賣家沒有動機把它灌高（灌高等於承諾多賠），所以這個比率不需要外部錨點
 * 就是誠實的 —— 這正是換分子的全部理由。
 *
 * 只有一個比率，不再有「公開的還元率」與「內部的兌現率」兩套。
 * 舊版之所以要兩套，是因為公開展示刻意不算 BUST、而回收卻對每一種賞別
 * 都照 refPrice 付點 —— 兩套規則的縫隙就是印鈔機。買回價**每一種賞別都要宣告**
 * （爆賞的保底卡也是一張真的卡），所以那條縫消失了。
 *
 * 這裡只涵蓋 muteki（固定票價、每籤必得、沒有額外贈獎）。後端目前也只收 muteki。
 */

/**
 * 保底回饋率的門檻，單位是「佔票收的百分比」。
 *
 * FLOOR_MINT（100）——「印鈔機」那條線，硬擋。
 *   Σ(買回價) ≥ 票收 時，「抽光整池再全部回收」拿回來的比付出去的多，
 *   而錢是從那個池的保留額出的：保留額不夠的部分要賣家自己補，
 *   補不出來就是一堆按不了的回收按鈕。這條閘的理由跟舊版的 redeemAllowed
 *   完全一樣，只是分子換成了真正會付出去的數字。
 *
 * FLOOR_THIN（90）—— 放行但提醒。整池被全數回收時賣家只留下 10% 票收，
 *   扣掉運費與金流成本很可能倒貼。
 *
 * FLOOR_PREDATORY（25）—— 低於此值擋下。
 *   這個數字是從舊制的門檻換算的，不是重新拍腦袋：舊制放行的最苛的池是
 *   「還元率 55%」，而舊制的回收是市值的 5–7 成 —— 換算成保底就是
 *   55% × 0.5 ≈ 27.5% 到 55% × 0.7 ≈ 38.5%。把線畫在 25% 讓過去合法的
 *   區間仍然合法（不會因為換算式而追溯性地把誠實的賣家判出局），
 *   同時擋掉「保底幾乎等於沒有」的池。
 */
export const FLOOR_MINT = 100
export const FLOOR_THIN = 90
export const FLOOR_PREDATORY = 25

export type FloorVerdict = 'ok' | 'thin' | 'mint' | 'predatory'

export interface PrizeFloor {
  tier: string
  /** 張數 */
  qty: number
  /** 賣家宣告的買回價（單張） */
  buyback: number
}

/**
 * 保底回饋率 ＝ Σ(宣告買回價 × 數量) ÷ 票收 × 100。
 *
 * **每一種賞別都算，BUST 也算。** 爆賞給的是保底卡，那張卡一樣有宣告的買回價，
 * 一樣可以被回收 —— 把它當成 0 會低估賣家真正的義務，而低估的那一塊
 * 正好是舊版拿來藏印鈔機的地方。
 */
export function floorRatio(prizes: PrizeFloor[], seats: number, price: number) {
  const floorValue = prizes.reduce((s, p) => s + p.qty * p.buyback, 0)
  const revenue = seats * price
  return { floorValue, revenue, ratio: revenue ? (floorValue / revenue) * 100 : 0 }
}

export function floorVerdict(ratio: number): { verdict: FloorVerdict; message: string } {
  if (ratio >= FLOOR_MINT) {
    return {
      verdict: 'mint',
      message: `保底回饋率 ${ratio.toFixed(1)}%，宣告的買回價總和已經超過票收。` +
        `整池抽完再全部買回，拿回來的比付出去的多 —— 這個池是一台印鈔機。`
    }
  }
  if (ratio >= FLOOR_THIN) {
    return {
      verdict: 'thin',
      message: `保底回饋率 ${ratio.toFixed(1)}%，如果整池的卡都被買回，你只留得下不到 ${(100 - ratio).toFixed(1)}% 的票收，扣掉運費與金流成本可能倒貼。`
    }
  }
  if (ratio < FLOOR_PREDATORY) {
    return {
      verdict: 'predatory',
      message: `保底回饋率僅 ${ratio.toFixed(1)}%，等於幾乎沒有保底，對玩家過於不利。`
    }
  }
  return { verdict: 'ok', message: `保底回饋率 ${ratio.toFixed(1)}%，落在合理區間。` }
}

/**
 * 判定「章」上寫的那幾個字。
 *
 * ── 為什麼不是「合格 / 不合格」兩種（走查 P12）─────────────────────
 *
 * 93.3% 的池原本蓋的是跟 50% 完全一樣的綠色「合格」章，而同一張卡片上
 * 緊接著就寫「保底幾乎吃掉整筆票收，扣掉運費與金流成本可能倒貼」。
 * 兩句話互相抵消：一句說沒問題、一句說你會賠錢，讀的人不知道該信哪一個，
 * 而通常會信那個看起來像結論的章。
 *
 * 但 thin 從來就不是「合格」。它在 floorAllowed 裡的意思是
 * **「可以開，但你要知道自己在做什麼」** —— 放行的理由是「他是拿自己的錢
 * 在承諾，沒有理由替他決定」，不是「這個池沒問題」。章就要把這件事講出來，
 * 不能借用 ok 那一枚。四種判定各自有自己的一句話，不再是二分。
 *
 * 放在 shared 而不是頁面裡：擋不擋跟章上寫什麼是同一個判斷的兩面，
 * 分兩個檔案寫就會出現「後端擋了、前端還蓋著合格」的那種分岔。
 */
export const FLOOR_VERDICT_STAMP: Record<FloorVerdict, string> = {
  ok: '合格',
  thin: '可以開，但你可能倒貼',
  mint: '不合格，無法開池',
  predatory: '不合格，無法開池'
}

/**
 * 開池能不能過。
 *
 * mint 擋（印鈔機）、predatory 擋（沒有保底）、thin 放行但提醒。
 * thin 是賣家自己的風險，而且他是拿自己的錢在承諾，沒有理由替他決定。
 */
export function floorAllowed(ratio: number): { allowed: boolean; verdict: FloorVerdict; message: string } {
  const v = floorVerdict(ratio)
  return { allowed: v.verdict !== 'mint' && v.verdict !== 'predatory', ...v }
}

/**
 * 對外的一句話說明。UI 顯示保底回饋率時一定要跟著這句 ——
 * 這個數字最容易被讀成「這個池平均回本多少」，它不是。
 * 它是**下限**：你最少拿得回多少。
 */
export const FLOOR_RATIO_LABEL = '保底回饋率'
export const FLOOR_RATIO_MEANING =
  '把整池抽完、每一張都按賣家宣告的買回價收回來，能拿回票收的多少 —— 這是下限，不是平均。'
