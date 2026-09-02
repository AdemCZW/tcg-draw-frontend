/**
 * 對外可見的卡片欄位白名單。
 *
 * ── 為什麼是白名單，不是「刪掉 certNo」 ──
 *
 * `prizes.card` / `listings.card` 是 jsonb，而建池端收 card 時用的是
 * `.passthrough()`（見 routes/pools.ts 的 PrizeIn）—— 也就是說**賣家送什麼
 * 進來就存什麼進去**，這個物件裡有哪些鍵，不是任何一份型別定義說了算。
 *
 * 黑名單（撈出整包再 delete 幾個鍵）在這種結構上一定會漏：今天有人在 card 裡
 * 多塞一個欄位，它明天就自動出現在公開回應裡，而且沒有任何一行程式碼改過。
 * 白名單是相反的預設 —— 新欄位預設不公開，要公開得有人特地把它加進這份清單，
 * 那一刻他就會被迫想一次「這個東西可以給全世界看嗎」。
 *
 * ── 什麼該留、什麼該拿掉 ──
 *
 * 留下的是「這是哪一張卡、長什麼樣」：卡名、卡圖、系列、卡號、鑑定公司、分數。
 * 公開卡冊的意義就是給人看收藏，把這些拿掉等於把功能一起關掉。
 *
 * 拿掉的是**身分憑據** —— 「拿著它就可以在別的地方主張這張卡是我的」的東西。
 * 目前只有 `certNo` 屬於這一類：鑑定編號是每個殼唯一、可對外查證的識別碼，
 * 平台正在做的一卡多賣防線（同一個編號全站只能登記一次）就是綁在它上面。
 * 分享連結會被轉貼到群組裡，等於把持有人整本收藏的編號免費送給別人拿去搶註。
 * 前端本來就刻意不顯示它（見 src/components/CertTag.vue 的說明），
 * 只是 API 一直照送。
 */

/** 公開回應裡的卡片。每一欄都是「這是哪一張卡」，沒有任何一欄是身分憑據 */
export interface PublicCardView {
  name?: unknown
  image?: unknown
  artId?: unknown
  setCode?: unknown
  cardNo?: unknown
  language?: unknown
  grader?: unknown
  grade?: unknown
  refPrice?: unknown
  variantId?: unknown
}

/**
 * 白名單本體。
 *
 * `certNo` 不在裡面 —— 那是這支的重點，見檔頭。
 * `id`（目錄內部的卡片鍵）也不在裡面：它對展示沒有用途，而白名單的規矩是
 * 「沒有展示用途就不出去」，不是「想不到壞處就放行」。
 *
 */
const PUBLIC_CARD_KEYS = [
  'name', 'image', 'artId', 'setCode', 'cardNo', 'language',
  'grader', 'grade', 'refPrice', 'variantId'
] as const

/**
 * 把一包 card jsonb 收斂成可以對外送的形狀。
 *
 * 不存在的鍵不會被補成 undefined 送出去 —— 公開卡冊的 JSON 一向是
 * 「整個欄位不存在」而不是 `null`，前端兩種都吃得下（CertTag.vue），
 * 但少送幾個空欄位就少讓人猜「這是沒有還是被拿掉了」。
 */
export function publicCard(card: unknown): PublicCardView {
  if (!card || typeof card !== 'object') return {}
  const src = card as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of PUBLIC_CARD_KEYS) if (k in src) out[k] = src[k]
  return out
}
