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
  R2_PUBLIC_URL: z.string().url().optional()
})

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  console.error('[env] 環境變數不合法:')
  for (const i of parsed.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`)
  process.exit(1)
}

export const env = parsed.data
export const corsOrigins = env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
