/**
 * 建立／更新管理員的登入憑證。
 *
 * 為什麼需要這支：平台帳號（u-platform）在種子資料裡就有 role='admin'，
 * 但沒有 email 跟密碼，等於有權限卻無法登入——後台形同不存在。
 *
 * 密碼只從環境變數讀，不寫死在程式碼裡，也不放進 git。
 * 刻意做成獨立腳本而不是 API 端點：建立管理員這種事不該有任何對外的入口，
 * 只能由能存取伺服器的人主動執行。
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... npm run bootstrap-admin
 *
 * 可以重複執行——同一個 email 會直接更新密碼，用來重設忘記的密碼。
 */
import { randomBytes, scrypt as scryptCb } from 'node:crypto'
import { promisify } from 'node:util'
import { sql } from './db.js'
import { PLATFORM_ID } from './orders-service.js'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>

async function hash(pw: string) {
  const salt = randomBytes(16)
  const key = await scrypt(pw, salt, 64)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

async function run() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.ADMIN_PASSWORD

  if (!email || !password) {
    console.error('缺少 ADMIN_EMAIL 或 ADMIN_PASSWORD 環境變數')
    process.exit(1)
  }
  if (password.length < 8) {
    console.error('管理員密碼至少 8 碼')
    process.exit(1)
  }
  if (password.length < 12) {
    // 不擋，但要講清楚：這個帳號能無上限發點數、看所有人的帳本、裁決爭議。
    // 8 碼可接受的前提是登入端點有速率限制（見 rate-limit.ts），
    // 沒有那層的話 8 碼等於可以被慢慢猜出來。
    console.warn('⚠ 密碼短於 12 碼。這是能發點數與裁決爭議的帳號，建議用密碼管理器產一組長的。')
  }

  const [existing] = await sql`select id from users where email = ${email}`
  const pwHash = await hash(password)

  if (existing) {
    await sql`update users set password_hash = ${pwHash}, role = 'admin' where id = ${existing.id}`
    console.log(`已更新既有帳號的密碼並確保 admin 權限：${email} (${existing.id})`)
  } else {
    // 掛到平台帳號上。它已經是訂單裁決、保證金沒收的收受方，
    // 讓「平台」在系統裡維持單一身分，不要再多開一個管理員帳號。
    await sql`
      update users set email = ${email}, password_hash = ${pwHash}, role = 'admin'
      where id = ${PLATFORM_ID}
    `
    const [check] = await sql`select id from users where id = ${PLATFORM_ID}`
    if (!check) {
      console.error(`找不到平台帳號 ${PLATFORM_ID}，請先跑 npm run seed`)
      process.exit(1)
    }
    console.log(`已設定平台帳號的登入憑證：${email} (${PLATFORM_ID})`)
  }

  await sql.end()
}

run().catch(e => { console.error(e); process.exit(1) })
