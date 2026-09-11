import type { SellerContact } from '@/types/models'

/**
 * 對外聯絡方式的三種種類，各自要講不同的話：提示、輸入框提示字、
 * 以及買家那側能不能直接撥。賣家設定頁與上架頁共用 —— 兩頁寫的是同一個欄位。
 */
export const CONTACT_KINDS: { k: SellerContact['kind']; label: string; hint: string; ph: string }[] = [
  { k: 'phone', label: '手機', hint: '買家可以直接撥給你。', ph: '09xx-xxx-xxx' },
  { k: 'line', label: 'LINE ID', hint: '買家只能複製後自己搜尋加你 —— 記得先把「允許被加入好友」打開。', ph: '你的 LINE ID' },
  { k: 'other', label: '其他', hint: '例如 IG 帳號、電子郵件。買家只能複製，平台不會替你轉接。', ph: 'IG 帳號、email…' }
]

/** 長度門檻跟後端 server/src/contact.ts 同一組（3～64）。回空字串表示可以送出 */
export function contactBlockWhy(value: string): string {
  const t = value.trim()
  if (!t) return '還差：填一個買家聯絡得到你的方式。'
  if (t.length < 3) return '聯絡方式太短了，至少 3 個字。'
  if (t.length > 64) return `聯絡方式太長了，最多 64 個字（目前 ${t.length} 個）。`
  return ''
}
