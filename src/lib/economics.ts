// ------------------------------------------------------------------
// 獎池經濟試算
//
// 平台在賣家上架前就要能回答「這個池會不會賠錢 / 是不是坑玩家」。
// 算的是**保底回饋率**（Σ 宣告買回價 ÷ 票收），不是賣家標示的市值 ——
// 標示市值沒有外部依據，賣家填高就一起說謊（docs/HANDOFF.md 4.1）。
// 一般定量池可以直接除，但 shitei（指定賞）不行 —— 抽中指定賞就結束整池，
// 後面的籤不再開出，期望上大部分獎品根本不會發出去，只能用蒙地卡羅估。
// ------------------------------------------------------------------
import type { PoolMode, Tier } from '@/types/models'

export interface PrizeSpec {
  tier: Tier
  qty: number
  /** 賣家標示的參考市值。**只是顯示**，不參與任何計算 */
  unitValue: number
  /** 賣家宣告的買回價（單張）。所有金額判斷都用這個 */
  buyback: number
}

export interface PoolEconomics {
  /**
   * 保底回饋率：Σ(宣告買回價 × 數量) ÷ 票收。
   * 分子是**賣家有義務付出去的錢**，不是他標示的市值 ——
   * 換分子的理由見 shared/economics.ts 開頭。
   */
  ratio: number
  /** 買回價總和。賣家最壞情況下要付出去的點數 */
  floorValue: number
  revenue: number
  seatCount: number
  verdict: FloorVerdict
  message: string
}

/* 判斷從 shared 引用，不要在這裡再寫一份。
   後端建池時用的是同一份（shared/economics.ts）—— 兩邊各寫一份的話，
   賣家會在畫面上看到「合理」然後送出時被伺服器擋掉，
   而且沒有人會發現是門檻漂掉了。 */
import { floorRatio, floorVerdict, type FloorVerdict } from '@/shared/economics'

/** 一般定量池：每一個籤位都會開出去，**BUST 也算**（爆賞的保底卡一樣有買回價） */
function flatRatio(prizes: PrizeSpec[], seats: number, price: number) {
  return floorRatio(prizes.map(p => ({ tier: p.tier, qty: p.qty, buyback: p.buyback })), seats, price)
}

/**
 * shitei（指定賞）模擬。
 *
 * 這個模式抽中指定賞就「加送最後賞並立刻結束整池」，後面的籤不再開出 ——
 * 也就是說大部分獎品期望上根本不會發出去。用 flatRatio 直接除會嚴重高估支出：
 * 實測 p4 會被算成 161%，但它真正的還元率在 84% 附近，護欄會誤擋合法的池。
 *
 * 指定賞平均落在第 (n+1)/2 支，所以期望上只有一半的池會被開完。
 * 收入只算「實際賣出的籤」，支出只算「結束前已開出的獎品 + 最後賞」。
 */
function simulateShitei(prizes: PrizeSpec[], price: number, target: Tier, trials: number) {
  // 最後賞是額外贈獎、不佔籤位，抽中指定賞時一併送出
  const lastPrize = prizes.filter(p => p.tier === 'LAST')
  // 模擬的是「賣家要付出去多少」，所以每一張算的是宣告的買回價不是標示市值
  const lastValue = lastPrize.reduce((s, p) => s + p.qty * p.buyback, 0)

  const bag: { tier: Tier; v: number }[] = []
  for (const p of prizes) {
    if (p.tier === 'LAST') continue
    for (let i = 0; i < p.qty; i++) bag.push({ tier: p.tier, v: p.buyback })
  }
  if (!bag.length) return { ratio: 0, soldSeats: 0 }

  let revenue = 0
  let paid = 0
  let soldSeats = 0

  for (let t = 0; t < trials; t++) {
    const b = bag.slice()
    for (let i = b.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0
      ;[b[i], b[j]] = [b[j], b[i]]
    }
    for (let i = 0; i < b.length; i++) {
      revenue += price
      soldSeats++
      paid += b[i].v
      if (b[i].tier === target) { paid += lastValue; break }  // 觸發：送最後賞並結束
    }
  }
  return { ratio: revenue ? (paid / revenue) * 100 : 0, soldSeats: soldSeats / trials }
}

export interface EconomicsOptions {
  trials?: number
  /** shitei：哪一個賞別觸發結束 */
  shiteiTier?: Tier
}

export function computeEconomics(
  mode: PoolMode,
  prizes: PrizeSpec[],
  price: number,
  opts: EconomicsOptions = {}
): PoolEconomics {
  const { trials = 4000, shiteiTier = 'A' } = opts
  const seatCount = prizes.reduce((s, p) => s + p.qty, 0)
  const flat = flatRatio(prizes, seatCount, price)

  if (mode === 'shitei') {
    const sim = simulateShitei(prizes, price, shiteiTier, trials)
    return {
      ...flat,
      seatCount,
      ratio: sim.ratio,
      revenue: Math.round(sim.soldSeats * price),
      ...floorVerdict(sim.ratio)
    }
  }

  return { ...flat, seatCount, ...floorVerdict(flat.ratio) }
}
