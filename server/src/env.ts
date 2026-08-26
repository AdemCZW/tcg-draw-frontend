/**
 * 環境變數。
 *
 * 在啟動時就驗證完，缺東西直接死在部署階段 ——
 * 比起跑到第一個請求進來才發現 DATABASE_URL 是 undefined，
 * 前者你會在 Railway 的 log 立刻看到，後者是使用者幫你發現。
 */
import { z } from 'zod'

const Env = z.object({
  DATABASE_URL: z.string().min(1, '缺少 DATABASE_URL'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少要 32 個字元'),
  PORT: z.coerce.number().int().positive().default(8080),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /* LINE Login。Channel ID 是公開的；Secret 只能從環境變數來。
     兩個都沒填時 LINE 登入端點回 503，其他功能照常 —— 本機開發不一定要設。 */
  LINE_CHANNEL_ID: z.string().default('2011159689'),
  LINE_CHANNEL_SECRET: z.string().optional(),
  /** 後端對外的網址，組 LINE 的 redirect_uri 用。Railway 上要填自己的網址 */
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  /** 登入完成後導回前端的網址 */
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),

  /* Cloudflare R2（S3 相容）。四項都沒填時檔案上傳端點回 503 ——
     跟 LINE 一樣，本機開發不一定要設齊。Account ID 不是敏感值，
     但 Access Key / Secret 只能從環境變數來，不進 git。 */
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  /** 公開讀取用的網址（r2.dev 的開發網域，或你自己接的自訂網域）。
      沒填的話所有檔案都走簽名網址讀取，沒有東西是公開的——這是安全的預設值。 */
  R2_PUBLIC_URL: z.string().url().optional(),

  /* PSA 鑑定編號查證。詳見 src/psa.ts 與 docs/psa-api-access.md。
     ── 目前的現實：token 已存在但 API 回 403 待核准 ──
     所以整條路必須能在「API 還不通」時優雅降級（見下方 PSA_VERIFY_ENFORCE）。 */

  /** PSA 的 bearer token。**只從環境變數來，絕不進前端 bundle**。
      沒設時查證回 not_configured，開池不硬擋（標 pending），其他功能照常。 */
  PSA_API_TOKEN: z.string().optional(),
  /** PSA API 的 base（測試時可指向假伺服器；正式就是官方網址）。 */
  PSA_API_BASE: z.string().url().default('https://api.psacard.com/publicapi'),
  /**
   * 是否「驗不過就開不了鑑定卡的池」。
   *
   * 預設 '0'（不強制）：API 現在全 403，強制等於完全開不了鑑定卡的池。
   * 這時 api_unavailable / not_configured 只會把卡標成 pending（未驗證），
   * 池照常開得成。查無此卡 / 格式錯仍然一律擋，跟這個旗標無關。
   *
   * **明天 PSA 核准、API 開始回 ok 之後，把這個值設成 '1'**，就會從
   * 「暫不驗證」切成「強制驗證」——不用改任何一行程式碼。
   */
  PSA_VERIFY_ENFORCE: z.enum(['0', '1']).default('0')
})

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  console.error('[env] 環境變數不合法:')
  for (const i of parsed.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`)
  process.exit(1)
}

export const env = parsed.data
export const corsOrigins = env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
