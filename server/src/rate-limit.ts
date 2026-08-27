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

/* 兩個維度的門檻必須不一樣。
   email：針對單一帳號猜密碼，8 次就該擋——那個量體本來就不正常。
   IP：同一個 IP 後面可能是一整個家庭、辦公室、學校或咖啡廳（NAT），
       用 8 次會讓正常使用者互相拖累（實測踩過：同一個網路裡另一個人的
       測試把整條線鎖住）。放寬到 40，仍然擋得住單機暴力破解，
       因為真正的攻擊需要的次數遠高於此。 */
const MAX_FAILS_EMAIL = 8
const MAX_FAILS_IP = 40
const WINDOW_MS = 15 * 60_000

/* 註冊（reg-ip:）是**獨立的桶**，不跟登入失敗共用 ip: 桶（M-1）。
   兩個理由：
   1) 門檻的量級不同。登入的 40 次/15 分鐘管的是「密碼猜錯」，NAT 後面
      一整間網咖打錯字都得容納；註冊是一次性的動作，同一個 IP 一天開 5 個
      新帳號對正常人已經很寬 —— 家庭、辦公室偶爾會撞到，等一天就好；
      但對灌帳號的人，40 次/15 分鐘（= 3840 帳號/天）形同不設防。
   2) 互擾。共用 ip: 桶時，同一個網路裡有人登入打錯幾十次，
      新同事連註冊都被鎖住 —— 兩件不相干的事不該共用一個計數。 */
const MAX_REG_IP = 5
const REG_WINDOW_MS = 24 * 60 * 60_000

const maxFor = (key: string) =>
  key.startsWith('email:') ? MAX_FAILS_EMAIL
  : key.startsWith('reg-ip:') ? MAX_REG_IP
  : MAX_FAILS_IP

/* 桶不同、時間窗也不同：登入是短窗（打錯了 15 分鐘後再試），
   註冊是日配額（灌帳號的攻擊本來就是以天為尺度在算產能） */
const windowFor = (key: string) => key.startsWith('reg-ip:') ? REG_WINDOW_MS : WINDOW_MS

export function clientIp(c: Context): string {
  /* 取 x-forwarded-for 的**最後一段**，不是第一段。
     這個 header 是逐跳附加的：呼叫端自己就能先塞假的
     （curl -H 'x-forwarded-for: 1.2.3.4'），代理只是把真實來源「附加」在
     後面 —— 所以左邊的每一段都是不可信的自報，只有最右邊那一段是
     最靠近我們、真正握著 TCP 連線的那層代理寫的。依 Railway 的文件，
     它的邊緣代理正是把客戶端 IP 附加在最後一段。取第一段的話，
     攻擊者每個請求換一個假 IP，整個 IP 維度的限流形同虛設。
     已知限制：如果之後在 Railway 前面再加一層 CDN（例如 Cloudflare），
     最後一段會變成 CDN 節點的 IP，所有人共用同一個桶 —— 那是過度封鎖
     而不是放行（fail closed）；到時要改成「從右往左數第 N 跳」，
     N 跟基礎架構的層數綁定。 */
  const fwd = c.req.header('x-forwarded-for')
  if (fwd) {
    const parts = fwd.split(',')
    return parts[parts.length - 1]!.trim()
  }
  return c.req.header('x-real-ip') ?? 'unknown'
}

export interface LimitResult { blocked: boolean; retryAfter: number }

/**
 * 檢查是否已被鎖。只讀不寫 —— 呼叫端要在「確定失敗」之後才 bump()，
 * 否則成功的登入也會被計入。
 */
export async function checkLimit(keys: string[]): Promise<LimitResult> {
  const rows = await sql<{ key: string; attempts: number; age_ms: number }[]>`
    select key, attempts, (extract(epoch from (now() - first_at)) * 1000)::bigint as age_ms
    from login_attempts where key = any(${keys})
  `
  for (const r of rows) {
    const age = Number(r.age_ms)
    const win = windowFor(r.key)
    if (age < win && Number(r.attempts) >= maxFor(r.key)) {
      return { blocked: true, retryAfter: Math.ceil((win - age) / 1000) }
    }
  }
  return { blocked: false, retryAfter: 0 }
}

/** 記一次計數（登入失敗、或一次註冊）。超過該桶的時間窗就從頭算起 */
export async function bumpFail(keys: string[]) {
  for (const key of keys) {
    const win = `${windowFor(key)} milliseconds`
    await sql`
      insert into login_attempts (key, attempts, first_at)
      values (${key}, 1, now())
      on conflict (key) do update set
        attempts = case
          when now() - login_attempts.first_at > ${win}::interval then 1
          else login_attempts.attempts + 1
        end,
        first_at = case
          when now() - login_attempts.first_at > ${win}::interval then now()
          else login_attempts.first_at
        end
    `
  }
}

/** 登入成功就清掉，避免正常使用者打錯幾次後被自己的紀錄拖累 */
export async function clearFails(keys: string[]) {
  await sql`delete from login_attempts where key = any(${keys})`
}

/** 定期清掉過期紀錄，這張表不需要保留歷史。
    依桶分開清：註冊桶的窗是 24 小時，用登入的 1 小時門檻去清會把
    還在計數中的註冊紀錄掃掉，等於把日配額縮成掃描間隔。 */
export async function sweepAttempts() {
  await sql`
    delete from login_attempts
     where (key like 'reg-ip:%' and first_at < now() - ${`${REG_WINDOW_MS * 2} milliseconds`}::interval)
        or (key not like 'reg-ip:%' and first_at < now() - ${`${WINDOW_MS * 4} milliseconds`}::interval)
  `
}
