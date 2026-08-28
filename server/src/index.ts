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
import { cardbook } from './routes/cardbook.js'
import { line } from './routes/line.js'
import { admin } from './routes/admin.js'
import { pub } from './routes/public.js'
import { files } from './routes/files.js'
import { social, socialPublic } from './routes/social.js'
import { sellers } from './routes/sellers.js'
import { psa } from './routes/psa.js'
import { tickets } from './routes/tickets.js'
import { sweep } from './orders-service.js'
import { sweepPools, sweepStashExpiry } from './pools-service.js'
import { sweepSettlementsAll } from './pool-settlement.js'
import { sweepAttempts } from './rate-limit.js'
import { certUniquenessPreflight } from './preflight.js'
import { monitor } from './routes/monitor.js'
import { monitorSweep } from './monitor.js'

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
  /* 把一筆結算的時鐘往回撥。
     為什麼需要它：結算的三條時限是 72 小時、7 天、14 天 —— 端到端測試沒有辦法
     等那麼久，而這幾條規則（逾期退款、鑑賞期滿釋放、寄存期滿釋放）正是
     最需要被驗的部分：算錯的後果是錢卡在錯的人手上，而那在 UI 上看不出來。
     純函式的部分在 selftest 驗，但「分錄有沒有真的成對寫進帳本」只有
     對著真的 Postgres 跑才驗得到。
     跟 dev-login 掛同一個旗標：正式環境不設 DEV_LOGIN 就沒有這條路。
     它只改時間戳，不改金額也不改狀態 —— 撥完之後仍然要由正常的掃描邏輯
     去判斷該發生什麼，否則測到的就不是產品邏輯而是這支端點。 */
  const RewindBody = z.object({ prizeId: z.string(), ms: z.number().int().positive() })
  app.post('/v1/dev/rewind-settlement', async c => {
    const parsed = RewindBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
    const { prizeId, ms } = parsed.data
    const rows = await sql`
      update pool_settlements set
        created_at  = created_at - ${ms},
        ship_due_at = case when ship_due_at is null then null else ship_due_at - ${ms} end,
        shipped_at  = case when shipped_at  is null then null else shipped_at  - ${ms} end
      where prize_id = ${prizeId}
      returning id, status
    `
    return c.json({ moved: rows.length, rows })
  })
  /* 託管訂單的時鐘。沒有這支就驗不到這次改動最重要的那條規則：
     「買家沉默 14 天 → 視同送達，不是自動退款」。
     那條規則是防詐騙的核心（沉默不該是白拿一張卡的手段），
     而它要等 14 天才會發生 —— 只能靠把時間戳往回撥來驗。
     跟 rewind-settlement 一樣只改時間戳，不改金額也不改狀態：
     撥完之後仍然由正常的 applyDeadlines 去判斷該發生什麼。 */
  const RewindOrder = z.object({ orderId: z.string(), ms: z.number().int().positive() })
  app.post('/v1/dev/rewind-order', async c => {
    const parsed = RewindOrder.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
    const { orderId, ms } = parsed.data
    const rows = await sql`
      update orders set
        created_at   = created_at - ${ms},
        shipped_at   = case when shipped_at   is null then null else shipped_at   - ${ms} end,
        delivered_at = case when delivered_at is null then null else delivered_at - ${ms} end
      where id = ${orderId}
      returning id, status
    `
    return c.json({ moved: rows.length, rows })
  })
  /* 手動推一次池的生命週期掃描。
     正式環境靠上面那個五分鐘的 setInterval，測試等不了五分鐘 ——
     而「到期關池 → 揭曉 → 解押把卡還給賣家」這條鏈只有掃描會推。
     不改任何規則，只是把排程要做的事現在做一次。 */
  app.post('/v1/dev/sweep-pools', async c => c.json(await sweepPools()))
  /* 寄存到期的提醒同理：正式環境靠五分鐘的排程，測試等不了。 */
  app.post('/v1/dev/sweep-stash', async c => c.json(await sweepStashExpiry()))
  /* 池的到期日同理：測「到期就不能再抽、但已售出的仍走完出貨流程」
     不可能真的等到期。 */
  const ExpireBody = z.object({ poolId: z.string() })
  app.post('/v1/dev/expire-pool', async c => {
    const parsed = ExpireBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
    await sql`update pools set expires_at = ${Date.now() - 1000} where id = ${parsed.data.poolId}`
    return c.json({ ok: true })
  })
  /* 把一張卡的 refPrice 改掉。
     為什麼需要它：這次把回收金額從「refPrice × 比率」換成「賣家宣告的買回價」，
     核心命題是**refPrice 從此完全不影響任何金額**。那個命題只能正面驗：
     把 refPrice 改成一個荒謬的數字，回收拿到的點數必須一模一樣。
     沒有這條路的話，測試只能驗「金額等於某個常數」——
     而那在舊制底下也會全綠（舊制的常數剛好也算得出同一個數字）。

     只動 prizes.card 那份快照（買家卡冊裡的那一列），**不碰 pool_prizes** ——
     pool_prizes 的內容在公平性承諾的雜湊裡，動它就等於偽造承諾。 */
  const RefPriceBody = z.object({ prizeId: z.string(), refPrice: z.number().int().nonnegative() })
  app.post('/v1/dev/set-ref-price', async c => {
    const parsed = RefPriceBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
    const rows = await sql`
      update prizes set card = jsonb_set(card, '{refPrice}', ${String(parsed.data.refPrice)}::jsonb)
       where id = ${parsed.data.prizeId}
      returning id
    `
    return c.json({ changed: rows.length })
  })
  console.warn('[auth] DEV_LOGIN 已開啟：/v1/auth/dev-login 給 handle 就發 token，正式環境不要開')
  console.warn('[dev] /v1/dev/rewind-settlement、/v1/dev/rewind-order、/v1/dev/expire-pool、/v1/dev/sweep-pools、/v1/dev/set-ref-price 也開著，正式環境不要開')
}

/* 市場掛單的讀取端點搬進 routes/public.ts —— 上架、下架都在那裡，
   而它現在還要處理排序與游標分頁，不該長在入口檔裡。掛載路徑不變。 */

app.route('/v1/orders', orders)
app.route('/v1/auth', authRoutes)
app.route('/v1/wallet', wallet)
app.route('/v1/pools', pools)
app.route('/v1/prizes', prizes)
/* 卡片上傳入庫（登記手上的實體卡進卡冊）。自己一個前綴：
   這支整組要登入（use('*', requireAuth)），不能掛在 /v1 底下
   把公開端點一起變成要登入（同 /v1/seller 那條的理由）。 */
app.route('/v1/cardbook', cardbook)
app.route('/v1/auth/line', line)
app.route('/v1/admin', admin)
/* 自我檢測（獨立檔案的理由見 routes/monitor.ts 檔頭） */
app.route('/v1/admin/monitor', monitor)
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
/* PSA 鑑定編號查證。要登入（查證吃 PSA 每天 100 次配額，不開放匿名）。
   真正的把關在建池 API，這支只是讓前端在送出前先問一次。 */
app.route('/v1/psa', psa)
/* 客服工單（使用者端）。客服端在 /v1/admin/tickets，走既有的 requireAdmin。
   掛在 /v1/tickets 而不是 /v1 底下：這支有 use('*', requireAuth)，
   掛同一個前綴會把 public.ts 那些公開端點一起變成要登入（同 /v1/seller 那條的理由）。 */
app.route('/v1/tickets', tickets)

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
  /* 寄存到期只發提醒，不改任何規則（見 pools-service.ts 的 sweepStashExpiry）。
     失敗不能影響其他掃描 —— 這是三條裡最不重要的一條。 */
  sweepStashExpiry()
    .then(({ warned, expired }) => {
      if (warned || expired) console.log(`[stash] 提醒 ${warned} 張快到期、${expired} 張已過期`)
    })
    .catch(e => console.error('[stash] 失敗', e))

  /* 自我檢測：十條不變式，破了就通知管理員一張修復任務。
     它自己保證不 throw（monitorSweep 內部全 catch）。 */
  void monitorSweep().then(r => {
    if (r && (r.findings.length || r.errors.length)) {
      console.warn(`[monitor] 發現 ${r.findings.length} 個問題、${r.errors.length} 個檢查失敗`)
    }
  })

  sweepPools()
    .then(({ opened, revealed, expired }) => {
      if (opened || revealed || expired) {
        console.log(`[pools] 開賣 ${opened} 池、揭曉 ${revealed} 池、到期關閉 ${expired} 池`)
      }
    })
    .catch(e => console.error('[pools] 掃描失敗', e))

  /* 抽卡結算的時限：寄存確認期滿釋放、賣家逾期未出貨退款、鑑賞期滿釋放。
     跟訂單的掃描一樣不是唯一真相 —— 讀取自己的清單時也會補算一次
     （sweepSettlements(tx, userId)），排程掛掉只會讓沒人看的那幾筆晚一點結案。 */
  sweepSettlementsAll()
    .then(n => { if (n) console.log(`[settle] 結算 ${n} 筆抽卡`) })
    .catch(e => console.error('[settle] 失敗', e))
  // 順手清掉過期的登入失敗紀錄，那張表不需要保留歷史
  sweepAttempts().catch(e => console.error('[sweep] 清理登入紀錄失敗', e))
}, SWEEP_MS)

serve({ fetch: app.fetch, port: env.PORT }, info => {
  console.log(`vaultdraw-server listening on :${info.port}`)

  /* 鑑定編號唯一性的預檢。
     刻意放在開始聽之後、而且刻意不 await：它是一道檢查，不是啟動的前提。
     放在前面會讓每次冷啟動都多等幾個查詢，而 Railway 的健康檢查等不了；
     而且萬一資料庫慢或掛了，await 它等於讓整個服務陪葬 ——
     一個「順便看看資料乾不乾淨」的功能不該有那種權力。
     它自己保證不 reject，所以 void 是安全的。 */
  void certUniquenessPreflight()

  /* files.purpose 的 ticket-doc 放行已升級成 migration 026，
     開機補丁（ticketDocPurposePatch）隨之移除 —— 約束的歷史要住在
     migrations/ 裡讓看 schema 的人找得到。 */
})
