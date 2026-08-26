// ------------------------------------------------------------------
// 「同一款卡合併成 ×N」的規則。
//
// 為什麼要有這個檔案：合併規則同時出現在兩個地方 —— 建池的挑卡器
// （CardPicker）與卡冊的上架選取（MyCardsPage）。兩邊都在回答同一個問題
// 「畫面上這兩張要不要併成一列」，而這個問題答錯的後果是**賣家以為自己
// 挑的是同一張卡**。這個 repo 已經因為「同一件事兩份實作」吃過虧
// （還元率算式曾經前後端各寫一份），所以規則只能有一份。
//
// 合併永遠只是**畫面上的事**：底下那張實體卡一張都不能少，移除也必須
// 真的移除其中某一張實體卡。這個模組只產生鍵與分組，不碰任何選取狀態。
// ------------------------------------------------------------------

import type { CardItem } from '@/shared/domain'

/**
 * 合併鍵。同鍵的卡在畫面上併成一格 ×N。
 *
 * 兩條規則：
 *
 * 1. **有鑑定編號的卡永遠不合併。** 鍵裡帶上 certNo，等於每一張自成一組。
 *    PSA 10 #82345671 跟 PSA 10 #82345672 是兩張可以各自對外查證的實體卡，
 *    買家看到的也是兩個不同的獎品；併成「×2」會讓賣家以為自己挑的是同一張，
 *    也讓「哪一張出了問題」變得說不清 —— 整套爭議判定就是建立在
 *    certNo 可以逐張查證上（見 shared/domain.ts 的 certNo 說明）。
 *
 * 2. **變體一定要進鍵。** 同一組卡號可能是完全不同的商品：實測 SV2a-025
 *    普卡 cardmarket €0.02、同卡號的マスターボールミラー €369，差約 18,000 倍。
 *    併在一起等於把兩種商品講成同一種。variantId 也正是進了 manifest v4
 *    的那一欄（見 docs/HANDOFF.md 3.1），畫面上的「同一款」必須跟承諾裡的
 *    「同一張卡」對得起來。
 *
 * 其餘進鍵的欄位（鑑定機構、分數、語言）都是「這是哪一張卡」的一部分：
 * RAW 跟 PSA 10 的同款卡不是同一個商品，日版與英版也不是。
 * artId 是最準的身分，沒有才退回 setCode/cardNo。
 */
export function cardMergeKey(c: CardItem): string {
  const who = c.artId || `${c.setCode}/${c.cardNo}`
  if (c.certNo) return `one:${who}:${c.grader}:${c.certNo}`
  return `same:${who}|${c.variantId ?? ''}|${c.grader}|${c.grade ?? ''}|${c.language}`
}

export interface MergeGroup<T> {
  key: string
  /** 這一組底下的每一張實體卡，順序＝原本的順序（通常是挑選順序） */
  members: T[]
  /** 代表卡，拿來顯示卡圖與卡名 */
  head: T
}

/**
 * 依合併鍵分組。
 *
 * 泛型而不是綁死某一種資料形狀：挑卡器手上是 PickedCard、卡冊手上是
 * UserPrize，兩者都「有一張 CardItem」，取法交給呼叫端一個函式就好，
 * 不必為了共用把其中一邊轉成另一邊的型別。
 *
 * 順序用「第一次出現」的順序，不重排：使用者是照自己的順序挑的，
 * 數量變化時整排卡跳位比多佔幾格還難用。
 */
export function mergeByCard<T>(items: readonly T[], cardOf: (x: T) => CardItem): MergeGroup<T>[] {
  const byKey = new Map<string, MergeGroup<T>>()
  for (const it of items) {
    const k = cardMergeKey(cardOf(it))
    const g = byKey.get(k)
    if (g) g.members.push(it)
    else byKey.set(k, { key: k, members: [it], head: it })
  }
  return [...byKey.values()]
}

/**
 * 鑑定編號的尾碼。
 *
 * 合併不掉的兩張同款鑑定卡並排時，畫面上看起來一模一樣就像系統出錯 ——
 * 這個標是它們唯一看得出來的差別。取末四碼是因為完整編號在 54px 的縮圖上
 * 放不下，而尾碼在同一批卡裡幾乎不會撞。
 */
export function certTailOf(c: CardItem): string {
  return c.certNo ? `#${c.certNo.slice(-4)}` : ''
}
