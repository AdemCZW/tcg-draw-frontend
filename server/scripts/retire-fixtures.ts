/**
 * 示範池（fixture）的一次性收攤腳本。
 *
 * ── 這支存在的理由 ──────────────────────────────────────────────────
 * `npm run seed` 曾經掛在 Railway 的 startCommand 裡，於是每次部署或當機
 * 重啟都會再灌一批示範池。正式站因此變成 100% 示範資料 —— 而站上沒有
 * 任何一個字說那是假的。railway.json 已經把 seed 拿掉了，但**既有的那批
 * 資料還在線上**，這支負責收掉它們。
 *
 * ── 判準：`client_seed like 'fixture:%'` ────────────────────────────
 * seed.ts 給每個示範池寫 `client_seed = 'fixture:<id>'`（見 seedPool），
 * 真人開的池走 drand，client_seed 絕不會是這個形狀。條件寫得窄是刻意的：
 * 寧可漏掉一個示範池，也不要誤傷一個真人的池。
 * （seed.ts 的 retireStalePools 用的是同一條判準。）
 *
 * ── 為什麼預設是 dry-run ────────────────────────────────────────────
 * 這支要對正式資料庫跑。不帶旗標時它一列都不會改，只印出「會動到什麼」。
 * 要真的寫入必須明確加 --apply。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   # 只看，不動（預設）
 *   npm run retire-fixtures
 *   # 真的關掉 + 標記
 *   npm run retire-fixtures -- --apply
 *   # 連同「證明沒有任何帳務痕跡」的池一起刪掉
 *   npm run retire-fixtures -- --apply --delete
 *
 * 對 Railway 的庫跑要走 DATABASE_PUBLIC_URL（web 服務的 DATABASE_URL 指的是
 * postgres.railway.internal，那個主機名只有在 Railway 網路裡面解析得到）：
 *   railway run --service postgres -- npx tsx scripts/retire-fixtures.ts
 */
import postgres from 'postgres'

const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
if (!url) { console.error('沒有 DATABASE_PUBLIC_URL / DATABASE_URL'); process.exit(1) }

const args = new Set(process.argv.slice(2))
const APPLY = args.has('--apply')
const DELETE = args.has('--delete')

/* 給人看的標記。前綴而不是新欄位：不用改 schema、不用改前端，
   而且它會出現在每一個顯示標題的地方（池卡、訂單、卡冊來源、後台列表）——
   「站上沒標」這個問題要的正是這個。可逆（把前綴拿掉就還原）、可重跑
   （已經有前綴的跳過）。 */
const MARK = '［示範］'

/* /v1/admin/reconcile 的發行科目。這裡要跟 routes/admin.ts 那份**逐字一致** ——
   兩邊算的是同一個不變式，分岔的話這支的「drift 沒變」就是一句空話。 */
const ISSUE = ['topup', 'seed', 'admin-grant', 'line-signup-bonus']

const sql = postgres(url, {
  max: 2,
  idle_timeout: 10,
  ssl: url.includes('localhost') ? false : { rejectUnauthorized: false }
})

const line = (s = '') => console.log(s)
const head = (s: string) => { line(); line(`── ${s} ${'─'.repeat(Math.max(0, 62 - s.length))}`) }

/** 帳本快照。跟 GET /v1/admin/reconcile 算同一組數字，跑前跑後各取一次。 */
async function snapshot() {
  const [r] = await sql<{ total: string; issued: string; reserved: string; neg: string }[]>`
    select
      (select coalesce(sum(delta),0) from points_ledger)::text as total,
      (select coalesce(sum(delta),0) from points_ledger where reason = any(${ISSUE}))::text as issued,
      (select coalesce(sum(amount),0) from pool_settlements
        where status in ('held','awaiting_ship','shipped'))::text as reserved,
      /* 餘額不存欄位，一律 SUM(delta) 推算。負餘額代表帳本被動過手腳 ——
         drift 對得上但有人變負數的情況是存在的（例如把 reason='seed' 的
         發放刪掉，total 與 issued 同減、drift 不動，但那個人已經花掉了）。
         所以兩個都要驗。 */
      (select count(*) from (
         select user_id from points_ledger group by user_id having sum(delta) < 0
       ) q)::text as neg
  `
  const total = Number(r?.total ?? 0), issued = Number(r?.issued ?? 0)
  return { total, issued, drift: total - issued, reserved: Number(r?.reserved ?? 0), negative: Number(r?.neg ?? 0) }
}

type Row = {
  id: string; title: string; status: string; seller_id: string
  seats: string; taken: string; draws: string; prizes: string; settlements: string
  lots: string; bids: string; streaks: string; seats_with_draw: string
  marked: boolean
}

/**
 * 每個示範池身上掛了多少「帳務痕跡」。
 * 這張表就是「能不能刪」的唯一依據 —— 見下方 deletable() 的說明。
 */
async function inventory(): Promise<Row[]> {
  return await sql<Row[]>`
    select p.id, p.title, p.status, p.seller_id,
           (select count(*) from pool_seats  s where s.pool_id = p.id)::text as seats,
           (select count(*) from pool_seats  s where s.pool_id = p.id and s.taken_by is not null)::text as taken,
           (select count(*) from pool_seats  s where s.pool_id = p.id and s.draw_id  is not null)::text as seats_with_draw,
           (select count(*) from draws       d where d.pool_id = p.id)::text as draws,
           (select count(*) from prizes      z where z.pool_id = p.id)::text as prizes,
           (select count(*) from pool_settlements t where t.pool_id = p.id)::text as settlements,
           (select count(*) from auction_lots l where l.pool_id = p.id)::text as lots,
           (select count(*) from bids b join auction_lots l on l.id = b.lot_id where l.pool_id = p.id)::text as bids,
           (select count(*) from streak_runs r where r.pool_id = p.id)::text as streaks,
           (p.title like ${MARK + '%'}) as marked
      from pools p
     where p.client_seed like 'fixture:%'
     order by p.status, p.id
  `
}

/**
 * 這個池刪掉會不會動到錢或別人的卡？
 *
 * ── 為什麼判準是這六張表，而不是「有沒有人買過」──────────────────
 * pool_seats.taken_by 在示範池上是**種子直接寫死的裝飾**（seed.ts 明講：
 * 「已售出的籤直接標在 pool_seats 上，不補 draws / prizes」）。拿它當判準
 * 會把幾乎所有示範池都判成不可刪，這個旗標就沒有意義了。
 *
 * 真正對應到「錢動過 / 卡發出去了」的是這幾張：
 *   draws            抽卡事實，points_ledger 的 ref_id 指向它
 *   prizes           使用者卡冊裡的卡
 *   pool_settlements 賣家該收的錢（reconcile 的 reserved 就是加總它）
 *   auction_lots/bids 出價會凍結點數
 *   streak_runs      連抽的中途狀態
 * 外加 pool_seats.draw_id 不為 null 的列 —— 那是真人抽過的籤位，
 * 是上面幾張表之外的第二個獨立證據（帶不帶得起來都不該刪）。
 */
const deletable = (r: Row) =>
  r.draws === '0' && r.prizes === '0' && r.settlements === '0' &&
  r.lots === '0' && r.bids === '0' && r.streaks === '0' && r.seats_with_draw === '0'

const blockers = (r: Row) => [
  ['draws', r.draws], ['prizes', r.prizes], ['pool_settlements', r.settlements],
  ['auction_lots', r.lots], ['bids', r.bids], ['streak_runs', r.streaks],
  ['已抽走的籤位', r.seats_with_draw]
].filter(([, n]) => n !== '0').map(([k, n]) => `${k}=${n}`).join(' ')

try {
  const before = await snapshot()

  head('模式')
  line(APPLY ? (DELETE ? '⚠️  --apply --delete：會關閉、標記，並刪除無帳務痕跡的示範池'
                       : '⚠️  --apply：會關閉並標記示範池（不刪任何一列）')
             : 'dry-run（預設）。一列都不會改。要真的寫入請加 --apply')
  line(`目標資料庫 host：${(() => { try { return new URL(url).hostname } catch { return '(無法解析)' } })()}`)

  head('帳本現況（等同 GET /v1/admin/reconcile）')
  console.table(before)

  const rows = await inventory()
  head(`示範池（client_seed like 'fixture:%'）共 ${rows.length} 個`)
  if (rows.length === 0) { line('沒有符合的池，收工。'); process.exit(0) }

  console.table(rows.map(r => ({
    id: r.id, status: r.status, 已標記: r.marked ? 'v' : '',
    籤位: `${r.taken}/${r.seats}`,
    draws: r.draws, prizes: r.prizes, 結算: r.settlements,
    可刪: deletable(r) ? 'v' : `x ${blockers(r)}`
  })))

  /* ---------- 要動到哪些列，先攤開來數 ---------- */
  const OPENISH = ['draft', 'committed', 'open', 'sold_out']
  const toClose = rows.filter(r => OPENISH.includes(r.status))
  const toMark = rows.filter(r => !r.marked)
  const canDelete = rows.filter(deletable)
  const cannotDelete = rows.filter(r => !deletable(r))

  head('這一輪會動到的列')
  line(`關閉（status → cancelled）：${toClose.length} 列` +
       (toClose.length ? `\n  ${toClose.map(r => `${r.id} [${r.status}]`).join('\n  ')}` : ''))
  line(`標記（title 前綴 ${MARK}）：${toMark.length} 列` +
       (toMark.length ? `\n  ${toMark.map(r => r.id).join('\n  ')}` : ''))
  if (DELETE) {
    line(`刪除：${canDelete.length} 個池` +
         `（連同 pool_seats ${canDelete.reduce((a, r) => a + Number(r.seats), 0)} 列與其 pool_prizes）` +
         (canDelete.length ? `\n  ${canDelete.map(r => r.id).join('\n  ')}` : ''))
    line(`拒絕刪除：${cannotDelete.length} 個池（有帳務痕跡，只關閉 + 標記）` +
         (cannotDelete.length ? `\n  ${cannotDelete.map(r => `${r.id} ← ${blockers(r)}`).join('\n  ')}` : ''))
  } else {
    line(`刪除：未指定 --delete，不刪任何一列`)
  }

  if (!APPLY) {
    head('dry-run 結束')
    line('沒有任何一列被修改。確認上面的清單無誤後，加 --apply 再跑一次。')
    process.exit(0)
  }

  /* ---------- 真的寫入 ---------- */
  /* 整批包在一個交易裡：跑到一半失敗時，正式庫不該留下半套狀態。 */
  const done = await sql.begin(async tx => {
    const closed = await tx`
      update pools set status = 'cancelled'
       where client_seed like 'fixture:%' and status = any(${OPENISH})
      returning id`
    const marked = await tx`
      update pools set title = ${MARK} || title
       where client_seed like 'fixture:%' and title not like ${MARK + '%'}
      returning id`

    let deleted: string[] = []
    if (DELETE && canDelete.length) {
      const ids = canDelete.map(r => r.id)
      /* 刪除順序照外鍵反向來：pool_seats.prize_id → pool_prizes.id → pools.id。
         這幾張表**沒有 on delete cascade**（整個 schema 只有 tickets 有），
         所以順序寫錯的話 Postgres 會直接擋下來 —— 那其實是好事，
         它保證了「刪一半」在資料庫層面就不可能發生。 */
      await tx`delete from pool_seats  where pool_id = any(${ids})`
      await tx`delete from pool_prizes where pool_id = any(${ids})`
      const d = await tx`delete from pools where id = any(${ids}) returning id`
      deleted = d.map(r => String(r.id))
    }
    return { closed: closed.map(r => String(r.id)), marked: marked.map(r => String(r.id)), deleted }
  })

  head('已寫入')
  line(`關閉 ${done.closed.length} 個、標記 ${done.marked.length} 個、刪除 ${done.deleted.length} 個`)

  const after = await snapshot()
  head('帳本前後對照')
  console.table({ before, after })
  /* 這一行才是驗收標準。上面關閉與標記都不碰 points_ledger，刪除也只挑
     沒有任何帳務痕跡的池 —— 所以四個數字必須逐一相同，一個都不准變。 */
  const same = before.total === after.total && before.issued === after.issued
    && before.drift === after.drift && before.reserved === after.reserved
    && before.negative === after.negative
  line(same ? '✅ drift / total / issued / reserved / 負餘額人數 全部不變'
            : '❌ 帳本數字變了 —— 這不該發生，立刻停下來查')
  if (!same) process.exit(1)
} finally {
  await sql.end()
}
