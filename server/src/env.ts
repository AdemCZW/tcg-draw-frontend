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
  CORS_ORIGINS: z.string().default('http://localhost:5173')
})

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  console.error('[env] 環境變數不合法:')
  for (const i of parsed.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`)
  process.exit(1)
}

export const env = parsed.data
export const corsOrigins = env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
