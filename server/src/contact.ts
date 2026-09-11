/**
 * 對外聯絡方式的輸入規則。賣家設定（routes/sellers.ts）與一般玩家上架前填寫
 * （routes/auth.ts 的 /contact）是同一個欄位（users.contact_*，migration 043），
 * 所以規則只能有一份 —— 兩邊各寫一次的話，總有一天一邊收、另一邊退。
 */
import { z } from 'zod'

export const CONTACT_KIND = ['phone', 'line', 'other'] as const

export const Contact = z.object({
  kind: z.enum(CONTACT_KIND),
  /* 上限 64 對齊 migration 041 的說明。不驗格式 —— LINE ID 的規則沒有
     公開的權威定義，而把合法的 ID 擋下來比放進一個怪字串更糟：
     真正會發現填錯的是聯絡不上的買家，那時候本人自己會來改。 */
  value: z.string().trim().min(3, '聯絡方式太短').max(64, '聯絡方式最多 64 個字')
})
