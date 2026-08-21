/* ⚠️ 這個檔案是複製本，不要手動編輯。
   真正的來源是 src/shared/（repo 根目錄），改那邊之後跑
   `npm run sync-shared`（在 server/ 底下）重新產生這份複製。
   為什麼需要複製一份見 scripts/sync-shared.mjs 開頭的說明。 */
/**
 * 池的經濟護欄。
 *
 * 為什麼要放在 shared：這套判斷原本只存在於前端的 lib/economics.ts，
 * 也就是說「還元率不合理就不給開」這條規則**只在瀏覽器裡**。
 * 賣家直接打 POST /v1/pools 就能開一個還元率 20% 的池，護欄形同虛設。
 * 門檻只能有一份，前後端共用同一個檔案才不會分岔。
 *
 * 這裡只涵蓋 classic（固定票價、每籤必得）。後端目前也只收 classic，
 * 其他玩法的抽卡邏輯還沒實作（見 routes/pools.ts 的 mode enum）。
 * 競標那種「成交價由市場決定」的算法留在前端的 economics.ts。
 */

/** 還元率 = 獎品總值 ÷ 票收 × 100 */
export const RETURN_LOSS = 100      // 超過即賠本
export const RETURN_THIN = 95       // 接近打平，利潤太薄
export const RETURN_PREDATORY = 55  // 低於此值對玩家過苛

export type ReturnVerdict = 'ok' | 'thin' | 'loss' | 'predatory'

export interface PrizeValue {
  tier: string
  /** 張數 */
  qty: number
  /** 單張參考市值 */
  unitValue: number
}

/**
 * BUST 不計入獎品總值：抽到爆賞的人拿到的是保底卡，
 * 那張卡的價值另外算在保底那一列。把 BUST 當成有價值的獎品會高估還元率。
 */
export function returnRatio(prizes: PrizeValue[], seats: number, price: number) {
  const prizeValue = prizes
    .filter(p => p.tier !== 'BUST')
    .reduce((s, p) => s + p.qty * p.unitValue, 0)
  const revenue = seats * price
  return { prizeValue, revenue, ratio: revenue ? (prizeValue / revenue) * 100 : 0 }
}

export function verdictOf(ratio: number): { verdict: ReturnVerdict; message: string } {
  if (ratio >= RETURN_LOSS) {
    return { verdict: 'loss', message: `還元率 ${ratio.toFixed(1)}% 超過 100%，開一池賠一池。` }
  }
  if (ratio >= RETURN_THIN) {
    return { verdict: 'thin', message: `還元率 ${ratio.toFixed(1)}%，利潤極薄，扣掉運費與金流成本後可能虧損。` }
  }
  if (ratio < RETURN_PREDATORY) {
    return { verdict: 'predatory', message: `還元率僅 ${ratio.toFixed(1)}%，對玩家過於不利。` }
  }
  return { verdict: 'ok', message: `還元率 ${ratio.toFixed(1)}%，落在合理區間。` }
}

/**
 * 開池能不能過。
 *
 * loss 也擋：那是賣家自己會虧的池，看起來是他家的事 —— 但一個賠本池
 * 開出來會拉高整個平台的還元率預期，而且最常見的成因是把 refPrice 填錯，
 * 那對誰都不是好事。thin 放行但要提醒。
 */
export function poolAllowed(ratio: number): { allowed: boolean; verdict: ReturnVerdict; message: string } {
  const v = verdictOf(ratio)
  return { allowed: v.verdict !== 'loss' && v.verdict !== 'predatory', ...v }
}
