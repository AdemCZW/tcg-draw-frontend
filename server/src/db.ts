/**
 * 資料庫連線。
 *
 * 用 raw SQL 不用 ORM：這個系統的核心是「錢不能算錯」，
 * 而錢的正確性靠的是明確的交易邊界跟 SELECT ... FOR UPDATE。
 * ORM 會把這兩件事藏起來，出事時你得先搞懂它產生了什麼 SQL。
 * 表只有四張，抽象層帶來的麻煩大於好處。
 */
import postgres from 'postgres'
import { env } from './env.js'

export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  // Railway 的 Postgres 走 TLS，但憑證是內部簽的
  ssl: env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
})

/* begin() 有多載，用 Parameters<> 反推會得到 never，
   所以直接用 postgres 匯出的型別。
   Db 是「能下查詢的東西」—— 外層連線或交易連線都算，
   讓輔助函式可以同時給兩種呼叫端用。 */
export type Tx = postgres.TransactionSql<Record<string, never>>
export type Db = postgres.Sql<Record<string, never>> | Tx

/**
 * 讓交易回滾、同時把 HTTP 回應帶出去的錯誤型別。
 *
 * ── 為什麼需要（audit-3 的 A-5）────────────────────────────────────
 * postgres.js 的 sql.begin **只在 callback throw 時回滾**；回傳一個
 * 錯誤物件在它眼中是正常結束，照樣 COMMIT。於是「先寫、後檢查、
 * 檢查沒過回錯誤值」的端點會把前半段寫進資料庫：回收付不出錢時
 * 結算列已經 recycled、卡片列還是 stashed（A-1），接受出價付不出錢時
 * 出價永久卡在 accepted（A-2）—— 註解還寫著「回錯誤就會回滾」，
 * 機制認知本身是錯的。
 *
 * 紀律：**交易裡檢查沒過，一律 throw new Rollback(...)**，
 * 路由邊界 catch 它轉成 c.json(e.body, e.status)。
 */
export class Rollback extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super('rollback')
  }
}
