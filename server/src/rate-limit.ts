/**
 * 登入速率限制。
 *
 * 同時擋兩個維度，缺一個都會留下破口：
 *   email —— 針對單一帳號慢慢猜密碼
 *   IP    —— 拿同一台機器對大量帳號噴常見密碼（credential stuffing），
 *            只擋 email 的話這種攻擊每個帳號都只試一兩次，永遠不會觸發
 *
 * 計數存 Postgres 不存記憶體：Railway 重新部署很頻繁，存記憶體的話
 * 攻擊者只要等一次部署計數就歸零；而且之後如果加開 replica，
 * 每台各記一份等於限制被放大成 N 倍。
 */
import type { Context } from 'hono'
import { sql } from './db.js'

/** 時間窗內允許的失敗次數。成功登入會清零，所以正常使用者不會踩到 */
const MAX_FAILS = 8
const WINDOW_MS = 15 * 60_000

export function clientIp(c: Context): string {
  // Railway 在前面有代理，真實 IP 在 x-forwarded-for 的第一段
  const fwd = c.req.header('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim()
  return c.req.header('x-real-ip') ?? 'unknown'
}

export interface LimitResult { blocked: boolean; retryAfter: number }

/**
 * 檢查是否已被鎖。只讀不寫 —— 呼叫端要在「確定失敗」之後才 bump()，
 * 否則成功的登入也會被計入。
 */
export async function checkLimit(keys: string[]): Promise<LimitResult> {
  const rows = await sql<{ attempts: number; age_ms: number }[]>`
    select attempts, (extract(epoch from (now() - first_at)) * 1000)::bigint as age_ms
    from login_attempts where key = any(${keys})
  `
  for (const r of rows) {
    const age = Number(r.age_ms)
    if (age < WINDOW_MS && Number(r.attempts) >= MAX_FAILS) {
      return { blocked: true, retryAfter: Math.ceil((WINDOW_MS - age) / 1000) }
    }
  }
  return { blocked: false, retryAfter: 0 }
}

/** 記一次失敗。超過時間窗就從頭算起 */
export async function bumpFail(keys: string[]) {
  for (const key of keys) {
    await sql`
      insert into login_attempts (key, attempts, first_at)
      values (${key}, 1, now())
      on conflict (key) do update set
        attempts = case
          when now() - login_attempts.first_at > ${`${WINDOW_MS} milliseconds`}::interval then 1
          else login_attempts.attempts + 1
        end,
        first_at = case
          when now() - login_attempts.first_at > ${`${WINDOW_MS} milliseconds`}::interval then now()
          else login_attempts.first_at
        end
    `
  }
}

/** 登入成功就清掉，避免正常使用者打錯幾次後被自己的紀錄拖累 */
export async function clearFails(keys: string[]) {
  await sql`delete from login_attempts where key = any(${keys})`
}

/** 定期清掉過期紀錄，這張表不需要保留歷史 */
export async function sweepAttempts() {
  await sql`delete from login_attempts where first_at < now() - ${`${WINDOW_MS * 4} milliseconds`}::interval`
}
