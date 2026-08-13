// ------------------------------------------------------------------
// 獎池經濟試算
//
// 平台在賣家上架前就要能回答「這個池會不會賠錢 / 是不是坑玩家」。
// 一般定量池可以直接除，但 streak（連莊爆賞）不行 —— 玩家爆掉時獎品
// 不會發出去，實際支出遠低於獎池總值，只能用蒙地卡羅估。
// ------------------------------------------------------------------
import type { PoolMode, Tier } from '@/types/models'

export interface PrizeSpec {
  tier: Tier
  qty: number
  unitValue: number
}

export interface PoolEconomics {
  /** 還元率：預期發出的獎品價值 ÷ 票收 */
  ratio: number
  prizeValue: number
  revenue: number
  seatCount: number
  /** streak 專用：玩家用最佳策略時能拿到的還元率（防止被打爆） */
  worstCaseRatio?: number
  verdict: 'ok' | 'thin' | 'loss' | 'predatory'
  message: string
}

const LOSS = 100      // 超過即賠本
const THIN = 95       // 接近打平，利潤太薄
const PREDATORY = 55  // 低於此值對玩家過苛

/** 一般定量池：所有非 BUST 獎品最終都會發出去 */
function flatRatio(prizes: PrizeSpec[], seats: number, price: number) {
  const prizeValue = prizes
    .filter(p => p.tier !== 'BUST')
    .reduce((s, p) => s + p.qty * p.unitValue, 0)
  const revenue = seats * price
  return { prizeValue, revenue, ratio: revenue ? (prizeValue / revenue) * 100 : 0 }
}

/**
 * streak 模擬：玩家累積價值達 bankAt 就收手；抽到 BUST 則暫持獎品沒收，
 * 但仍發出保底卡（BUST 這列填的 unitValue 就是保底卡價值）。
 * 保底卡在約半數的入場都會發出，對還元率的影響很大，不能略過。
 */
function simulateStreak(prizes: PrizeSpec[], entry: number, bankAt: number, trials: number) {
  let revenue = 0
  let paid = 0
  const floorValue = prizes.find(p => p.tier === 'BUST')?.unitValue ?? 0
  const template: (number | null)[] = []
  for (const p of prizes) {
    for (let i = 0; i < p.qty; i++) template.push(p.tier === 'BUST' ? null : p.unitValue)
  }
  if (!template.length) return 0

  for (let t = 0; t < trials; t++) {
    const bag = template.slice()
    for (let i = bag.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0
      ;[bag[i], bag[j]] = [bag[j], bag[i]]
    }
    let idx = 0
    while (idx < bag.length) {
      revenue += entry
      let held = 0
      while (idx < bag.length) {
        const card = bag[idx++]
        if (card === null) { paid += floorValue; break }  // 爆賞 → 沒收暫持，發保底卡
        held += card
        if (held >= bankAt) { paid += held; break }
      }
    }
  }
  return revenue ? (paid / revenue) * 100 : 0
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
  const lastValue = lastPrize.reduce((s, p) => s + p.qty * p.unitValue, 0)

  const bag: { tier: Tier; v: number }[] = []
  for (const p of prizes) {
    if (p.tier === 'LAST') continue
    for (let i = 0; i < p.qty; i++) bag.push({ tier: p.tier, v: p.unitValue })
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
  /** auction：末尾幾席改為競標 */
  auctionSeats?: number
}

export function computeEconomics(
  mode: PoolMode,
  prizes: PrizeSpec[],
  price: number,
  opts: EconomicsOptions = {}
): PoolEconomics {
  const { trials = 4000, shiteiTier = 'A', auctionSeats = 0 } = opts
  const seatCount = prizes.reduce((s, p) => s + p.qty, 0)
  const flat = flatRatio(prizes, seatCount, price)

  /* auction：末尾席位不是用票價賣的，是喊標的。把它們一起丟進 flatRatio
     會用「票價 × 全部席次」當分母、卻用「含頭獎的全部獎品」當分子，
     算出來的數字毫無意義（實測會是 777%），合法的池會被護欄擋掉。
     競標席的成交價會趨近該獎品的市值，也就是那幾席大致是 100% 還元、
     對莊家損益中性。所以只評估「固定價格那一段」是否健康。 */
  if (mode === 'auction' && auctionSeats > 0) {
    const sorted = [...prizes].sort((a, b) => b.unitValue - a.unitValue)
    let toDrop = auctionSeats
    const fixed: PrizeSpec[] = []
    for (const p of sorted) {
      if (toDrop <= 0) { fixed.push(p); continue }
      const take = Math.min(toDrop, p.qty)
      toDrop -= take
      if (p.qty - take > 0) fixed.push({ ...p, qty: p.qty - take })
    }
    const fixedSeats = fixed.reduce((s, p) => s + p.qty, 0)
    const f = flatRatio(fixed, fixedSeats, price)
    const v = verdictOf(f.ratio)
    return {
      ...f,
      seatCount,
      verdict: v.verdict,
      message: `${v.message}（不含 ${auctionSeats} 席競標 —— 成交價由喊標決定，視為損益中性）`
    }
  }

  if (mode === 'shitei') {
    const sim = simulateShitei(prizes, price, shiteiTier, trials)
    return {
      ...flat,
      seatCount,
      ratio: sim.ratio,
      revenue: Math.round(sim.soldSeats * price),
      ...verdictOf(sim.ratio)
    }
  }

  if (mode !== 'streak') {
    return { ...flat, seatCount, ...verdictOf(flat.ratio) }
  }

  // streak：掃描各種收手門檻，取玩家能達到的最高還元率當作莊家風險上限
  const hasBust = prizes.some(p => p.tier === 'BUST' && p.qty > 0)
  if (!hasBust) {
    return {
      ...flat, seatCount, ratio: flat.ratio, verdict: 'loss',
      message: '連莊爆賞必須至少放 1 支爆賞籤，否則玩家可以無限免費續抽。'
    }
  }
  // 保底卡不得高於票價，否則「輸了反而划算」，玩家會刻意衝爆賞
  const floorValue = prizes.find(p => p.tier === 'BUST')?.unitValue ?? 0
  if (floorValue > price) {
    return {
      ...flat, seatCount, ratio: flat.ratio, verdict: 'loss',
      message: `保底卡市值 ${floorValue.toLocaleString()} 高於入場費 ${price.toLocaleString()}，玩家會刻意抽爆賞套利。`
    }
  }
  const thresholds = [1, price * 0.5, price, price * 1.5, price * 2.5, price * 4, price * 8]
  let expected = 0
  let worst = 0
  for (const th of thresholds) {
    const r = simulateStreak(prizes, price, th, trials)
    if (th === price) expected = r
    if (r > worst) worst = r
  }
  const v = verdictOf(worst)
  return {
    ratio: expected,
    worstCaseRatio: worst,
    prizeValue: flat.prizeValue,
    revenue: seatCount * price,
    seatCount,
    verdict: v.verdict,
    message: worst >= LOSS
      ? `玩家用最佳策略可拿到 ${worst.toFixed(1)}% —— 會賠錢，請增加爆賞數量或降低獎品價值。`
      : v.message
  }
}

function verdictOf(ratio: number): { verdict: PoolEconomics['verdict']; message: string } {
  if (ratio >= LOSS) {
    return { verdict: 'loss', message: `還元率 ${ratio.toFixed(1)}% 超過 100%，開一池賠一池。` }
  }
  if (ratio >= THIN) {
    return { verdict: 'thin', message: `還元率 ${ratio.toFixed(1)}%，利潤極薄，扣掉運費與金流成本後可能虧損。` }
  }
  if (ratio < PREDATORY) {
    return { verdict: 'predatory', message: `還元率僅 ${ratio.toFixed(1)}%，對玩家過於不利，平台不建議上架。` }
  }
  return { verdict: 'ok', message: `還元率 ${ratio.toFixed(1)}%，落在合理區間。` }
}
