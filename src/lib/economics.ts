// ------------------------------------------------------------------
// 獎池經濟試算
//
// 平台在賣家上架前就要能回答「這個池會不會賠錢 / 是不是坑玩家」。
// 一般定量池可以直接除，但 shitei（指定賞）不行 —— 抽中指定賞就結束整池，
// 後面的籤不再開出，期望上大部分獎品根本不會發出去，只能用蒙地卡羅估。
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
  verdict: 'ok' | 'thin' | 'loss' | 'predatory'
  message: string
}

/* 門檻從 shared 引用，不要在這裡再寫一份。
   後端建池時用的是同一組數字（shared/economics.ts）—— 兩邊各寫一份的話，
   賣家會在畫面上看到「合理」然後送出時被伺服器擋掉，
   而且沒有人會發現是門檻漂掉了。 */
import { RETURN_LOSS as LOSS, RETURN_THIN as THIN, RETURN_PREDATORY as PREDATORY } from '@/shared/economics'

/** 一般定量池：所有非 BUST 獎品最終都會發出去 */
function flatRatio(prizes: PrizeSpec[], seats: number, price: number) {
  const prizeValue = prizes
    .filter(p => p.tier !== 'BUST')
    .reduce((s, p) => s + p.qty * p.unitValue, 0)
  const revenue = seats * price
  return { prizeValue, revenue, ratio: revenue ? (prizeValue / revenue) * 100 : 0 }
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
      ...verdictOf(sim.ratio)
    }
  }

  return { ...flat, seatCount, ...verdictOf(flat.ratio) }
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
