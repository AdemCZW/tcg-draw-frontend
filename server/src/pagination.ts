/**
 * 游標分頁。
 *
 * ---- 為什麼不用 offset ----
 * 這幾張清單（卡冊、公開卡冊、市場掛單）都是「會從頭插入」的：每抽一次就多一張卡、
 * 每上架一次就多一筆掛單，而且排序都是最新的在前。使用者捲到第 2 頁的那幾秒之間
 * 只要前面插了一列，offset 24 就會跳過原本的第 24 筆（漏資料）；刪掉一列則會
 * 讓第 23 筆再出現一次（重複）。這不是罕見的競態，是這幾頁的常態。
 *
 * 游標記的是「我上次讀到哪一列」而不是「我跳過幾列」，前面插幾列都不影響。
 *
 * ---- 為什麼要 opaque ----
 * 游標的內容是「排序鍵長什麼樣」，那是實作細節。讓前端自己組 won_at|id
 * 等於把排序鍵變成公開契約，之後排序改了就得同時改前端，而且舊分頁請求
 * 會帶著對不上的欄位打進來。base64 不是加密，只是把「不要自己拼」講清楚。
 *
 * ---- 為什麼比較寫成 row value ----
 * (won_at, id) < (a, b) 是 SQL 標準的列值比較，Postgres 會直接用
 * (won_at desc, id desc) 的索引做 range scan。拆成
 * won_at < a or (won_at = a and id < b) 的話規劃器多半用不到索引，
 * 而且邊界（要不要含等號、id 該比哪一邊）很容易寫錯。
 */
import { z } from 'zod'

export const DEFAULT_LIMIT = 24
export const MAX_LIMIT = 100

/** limit 超出範圍就回 400，不要默默截斷 —— 呼叫端要知道自己拿到的不是它要的量 */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(512).optional()
})

const SEP = '|'

export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(parts.map(String).join(SEP), 'utf8').toString('base64url')
}

/**
 * 解游標。壞掉就回 null，讓呼叫端回 400 而不是拿一組半殘的值去查 ——
 * 游標是使用者可以隨手改的字串，必須當成外部輸入驗。
 *
 * 最後一段允許含有分隔字元：主鍵是 id，而 id 是唯一可能被塞進奇怪字元的欄位。
 */
export function decodeCursor(raw: string, parts: number): string[] | null {
  let text: string
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (!text) return null
  const seg = text.split(SEP)
  if (seg.length < parts) return null
  return [...seg.slice(0, parts - 1), seg.slice(parts - 1).join(SEP)]
}

/**
 * 把「多撈一列」的結果切成一頁。
 *
 * 多撈一列（limit + 1）才有辦法誠實回答「還有沒有下一頁」。
 * 用「回傳數量 < limit 就是最後一頁」判斷的話，資料量剛好是 limit 的整數倍時
 * 前端還會再打一次、拿到空陣列才停 —— 那一次請求是白打的，而且在捲到底的
 * 那一刻使用者會看到載入指示閃一下又消失。
 */
export function slicePage<T>(rows: T[], limit: number, cursorOf: (row: T) => string) {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  return { items, nextCursor: hasMore && last !== undefined ? cursorOf(last) : null }
}

/** 只由數字組成才算合法的時間戳游標段 */
export const isNumeric = (s: string) => /^-?\d+$/.test(s)
