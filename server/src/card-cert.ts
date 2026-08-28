/**
 * 卡片身分驗證的共用件。
 *
 * 原本住在 routes/pools.ts（建池是當時唯一會驗鑑定編號的地方）。
 * 卡冊上傳（routes/cardbook.ts）要走**同一套**對照與上限 —— 兩邊各寫
 * 一份的話，規則遲早分岔：一邊修了對照邏輯另一邊沒跟上，同一個編號
 * 在上傳時被放行、在建池時被擋（或反過來），使用者看到的就是隨機。
 * 所以搬到這裡讓兩邊 import 同一份。
 */

/**
 * PSA 回的卡號跟賣家挑的卡號對不對得上。
 *
 * 為什麼不是字串相等：PSA 是英文、我們的目錄是日文，**卡名**不可能字串相等，
 * 所以對照只能靠卡號。而卡號兩邊的寫法也不一致（PSA 常是純數字 "025"，
 * 我們可能帶前導零或系列前綴），所以比的是「數字部分」：抽出所有數字、
 * 去掉前導零再比。任一邊比不出數字時退回整串英數字比對。
 *
 * **比不出來就回 true（不擋）**：這個函式只負責抓「明顯是另一張卡」，
 * 拿不準的一律放行、交給賣家自己看 PSA 的卡片資訊確認 —— 寧可多問一次，
 * 也不要把一張其實對得上的卡誤擋成假卡。
 */
export function cardNumbersAgree(psa: string | null, seller: string | null): boolean {
  if (!psa || !seller) return true
  const digits = (s: string) => (s.match(/\d+/g)?.join('') ?? '').replace(/^0+/, '')
  const a = digits(psa), b = digits(seller)
  if (!a || !b) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    return norm(psa) === norm(seller)
  }
  return a === b
}

/* refPrice 的絕對上限。
   這個欄位現在**只是顯示**（賣家標示的參考價，不構成承諾，不參與任何金額計算），
   而且**可以完全不填** —— 它已經沒有任何計算上的用途，強迫賣家填一個
   沒有外部依據的數字只會製造一個看起來像官方行情的假資料。
   有填的話上限還是要有：它進得了 JSON、會出現在卡冊總值與排行榜上，
   也讓 numeric 運算有機會溢位成 500。 */
export const REF_PRICE_MAX = 10_000_000
