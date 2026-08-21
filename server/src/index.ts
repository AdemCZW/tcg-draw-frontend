/**
 * 伺服器入口。
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { z } from 'zod'
import { corsOrigins, env } from './env.js'
import { sql } from './db.js'
import { ensureUser, issueToken } from './auth.js'
import { orders } from './routes/orders.js'
import { auth as authRoutes } from './routes/auth.js'
import { wallet } from './routes/wallet.js'
import { pools } from './routes/pools.js'
import { prizes } from './routes/prizes.js'
import { line } from './routes/line.js'
import { admin } from './routes/admin.js'
import { pub } from './routes/public.js'
import { files } from './routes/files.js'
import { social, socialPublic } from './routes/social.js'
import { sellers } from './routes/sellers.js'
import { sweep } from './orders-service.js'
import { sweepPools } from './pools-service.js'
import { sweepAttempts } from './rate-limit.js'

const app = new Hono()
app.use('*', logger())
app.use('*', cors({ origin: corsOrigins, credentials: true }))

app.get('/health', async c => {
  await sql`select 1`
  return c.json({ ok: true, time: Date.now() })
})

/* 開發用登入：給 handle 就發 token。
   只在 DEV_LOGIN=1 時開 —— smoke 測試靠它建立測試身分。正式環境不設這個變數就沒有這條路。 */
if (process.env.DEV_LOGIN === '1') {
  const LoginBody = z.object({ handle: z.string().min(2).max(32), name: z.string().min(1).max(32) })
  app.post('/v1/auth/dev-login', async c => {
    const parsed = LoginBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
    const id = await ensureUser(parsed.data.handle, parsed.data.name)
    return c.json({ token: await issueToken(id), userId: id })
  })
  console.warn('[auth] DEV_LOGIN 已開啟：/v1/auth/dev-login 給 handle 就發 token，正式環境不要開')
}

/* 市場掛單的讀取端點搬進 routes/public.ts —— 上架、下架都在那裡，
   而它現在還要處理排序與游標分頁，不該長在入口檔裡。掛載路徑不變。 */

app.route('/v1/orders', orders)
app.route('/v1/auth', authRoutes)
app.route('/v1/wallet', wallet)
app.route('/v1/pools', pools)
app.route('/v1/prizes', prizes)
app.route('/v1/auth/line', line)
app.route('/v1/admin', admin)
app.route('/v1', pub)
app.route('/v1/files', files)
/* social 的兩半分開掛：需要登入的那半有 use('*', requireAuth)，
   掛在 /v1 底下會把整個 /v1 都變成要登入（Hono 的 sub-app middleware
   是以掛載前綴註冊的），所以各自給一個明確前綴。
   /v1/share 刻意不要登入 —— 分享連結要能給沒帳號的人看。 */
app.route('/v1/social', social)
app.route('/v1/share', socialPublic)
/* 掛在單數 /v1/seller，不是 /v1/sellers —— 後者已經被 public.ts 佔用
   （GET /v1/sellers 賣家列表、GET /v1/sellers/:id 賣家頁，兩個都是公開的）。
   這支有 use('*', requireAuth)，掛同一個前綴會把那兩個公開端點一起變成要登入。 */
app.route('/v1/seller', sellers)

/* 逾期掃描。
   時限本身是用時間戳算的，所以這支排程不是唯一真相 —— 它掛掉不會讓狀態算錯，
   只會讓「沒有人去看」的訂單晚一點結案。每五分鐘一次綽綽有餘。 */
const SWEEP_MS = 5 * 60_000
setInterval(() => {
  sql.begin(tx => sweep(tx))
    .then(n => { if (n) console.log(`[sweep] 結案 ${n} 張逾期訂單`) })
    .catch(e => console.error('[sweep] 失敗', e))

  /* 池的生命週期也要有人推。原本這條掃描只掃訂單，而開賣與揭曉
     只有 HTTP 端點、前端沒有任何地方呼叫 —— 池建好就停在 committed、
     售完就停在 sold_out，server_seed 永遠不公開，公平性驗證跑不到。 */
  sweepPools()
    .then(({ opened, revealed }) => {
      if (opened || revealed) console.log(`[pools] 開賣 ${opened} 池、揭曉 ${revealed} 池`)
    })
    .catch(e => console.error('[pools] 掃描失敗', e))
  // 順手清掉過期的登入失敗紀錄，那張表不需要保留歷史
  sweepAttempts().catch(e => console.error('[sweep] 清理登入紀錄失敗', e))
}, SWEEP_MS)

serve({ fetch: app.fetch, port: env.PORT }, info => {
  console.log(`vaultdraw-server listening on :${info.port}`)
})
