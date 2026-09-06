/**
 * 池的生命週期與抽選。
 *
 * draft → committed → open → sold_out → revealed
 *
 * 規則在 ./shared/fairness.ts（跟前端同一份）。這裡負責：
 * 產生並保管 server_seed、跟 drand 拿 client_seed、把籤序寫進 pool_seats、
 * 以及抽選時的搶佔。
 */
import { randomBytes } from 'node:crypto'
import {
  bytesToHex, commitV2, manifestHashOf, seatSequence,
  type ManifestVersion, type PrizeManifestEntry
} from './shared/fairness.js'
import type { Tx } from './db.js'
import { sql as sqlRoot } from './db.js'
import { credit } from './money.js'
/* markShipRequested：寄存到期自動出貨要掛上賣家的 72 小時出貨時鐘，
   走的就是買家自己申請出貨時的同一支（見 sweepStashExpiry 的說明）。 */
import { creditDraw, markShipRequested } from './pool-settlement.js'
import { POOL_SHIP_DEADLINE_MS } from './shared/pool-settlement.js'
import { notify } from './notify.js'

export const STASH_DAYS = 90
const DAY = 86_400_000

/**
 * 拒絕低熵 server_seed（security-audit C-1 建議的第 3 點）。
 *
 * 歷史教訓：示範池的 server_seed 曾經寫死成 'b1'.repeat(32) 這種 fixture 值。
 * commit_hash、client_seed、整份獎品清單都由公開 API 吐出，server_seed 一旦
 * 可預測（重複單一位元組的全空間只有 256 種），任何人都能離線暴力比對 commit、
 * 在開獎前還原出「哪個籤位是好卡」。產生端已經改用 randomBytes(32)，但那只保證
 * 「現在的程式碼是對的」；這道閘保證的是「錯的種子寫不進資料庫」——
 * 防的是未來哪次重構又把寫死的 fixture 值接回種子路徑。
 *
 * 為什麼門檻是「相異位元組數 < 8」：security-audit 的建議值。
 * 32 個真隨機位元組的相異數期望約 28，低於 8 的機率在 10^-30 以下 ——
 * 也就是永遠不會誤殺 randomBytes 產生的正常種子；而會被攔下的是
 * 'b1'.repeat(32)（相異數 1）、少數幾個值輪流拼出來的 fixture 這類
 * 「人手寫得出來」的低熵模式。這不是精確的熵量測，是一道成本為零、
 * 只攔明顯錯誤的哨線。
 */
export function assertSeedEntropy(seedHex: string): void {
  // 種子的既定格式是 32 bytes 的 hex（64 字元）。格式錯的直接擋，
  // 不然「相異位元組」的計算對象就不明確。
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error('server_seed must be 32 bytes of lowercase/uppercase hex (64 chars)')
  }
  const distinct = new Set<string>()
  for (let i = 0; i < seedHex.length; i += 2) {
    distinct.add(seedHex.slice(i, i + 2).toLowerCase())
  }
  if (distinct.size < 8) {
    throw new Error(
      `server_seed entropy too low: ${distinct.size} distinct bytes (< 8). ` +
      'refusing to commit a predictable seed (security-audit C-1)'
    )
  }
}

/**
 * 新池一律用這個 manifest 版本。
 *
 * 改這個常數只影響**之後**建的池 —— 既有的池把自己的版本存在
 * pools.commit_version 上，驗算照它們宣告的版本重算。
 * 承諾一旦公布就不能被後來的程式碼追溯改寫，這是這整套的前提。
 */
export const COMMIT_VERSION: ManifestVersion = 4

/**
 * drand（League of Entropy）。開池時鎖定一個未來的 round，
 * 那個 round 的亂數在 commit 之後才會出現 —— 這是 client_seed 不能被伺服器挑選的關鍵。
 *
 * 來源做成可替換：換成別的公開亂數只要改這兩個函式。
 */
const DRAND = 'https://api.drand.sh'
const DRAND_PERIOD_S = 30
const FUTURE_ROUNDS = 4  // 大約兩分鐘後。太近會撞到「commit 那一刻 round 已經出了」

/* 對外部服務的請求一律給逾時。沒有逾時的 fetch 在 Node 會等到 TCP 自己放棄，
   而 openPool 曾經是在交易裡呼叫它的 —— drand 一慢，那筆交易就抓著
   FOR UPDATE 的鎖不放，整個池被卡住。現在改在交易外先抓（見 tryOpenPool），
   逾時仍然要有：這是對外部相依的基本防護。 */
const DRAND_TIMEOUT_MS = 6000
const drandFetch = (path: string) =>
  fetch(`${DRAND}${path}`, { signal: AbortSignal.timeout(DRAND_TIMEOUT_MS) })

export async function reserveClientSeedSource(): Promise<string> {
  const r = await drandFetch('/public/latest')
  if (!r.ok) throw new Error(`drand latest ${r.status}`)
  const { round } = (await r.json()) as { round: number }
  return `drand:${round + FUTURE_ROUNDS}`
}

/** 回 null 表示那個 round 還沒到 */
export async function fetchClientSeed(source: string): Promise<string | null> {
  const m = /^drand:(\d+)$/.exec(source)
  if (!m) throw new Error(`unknown client seed source: ${source}`)
  const r = await drandFetch(`/public/${m[1]}`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`drand round ${m[1]} ${r.status}`)
  const { randomness } = (await r.json()) as { randomness: string }
  return randomness
}

/** draft → committed。產生 seed 與 commit，宣告亂數來源 */
export async function commitPool(tx: Tx, poolId: string) {
  const [p] = await tx`select * from pools where id = ${poolId} for update`
  if (!p) throw new Error('pool not found')
  if (p.status !== 'draft') throw new Error(`pool is ${p.status}, not draft`)

  const sumRows = await tx<{ sum: string | null }[]>`
    select sum(total)::text as sum from pool_prizes where pool_id = ${poolId}
  `
  const prizeTotal = Number(sumRows[0]?.sum ?? 0)
  if (prizeTotal !== Number(p.total_tickets)) {
    throw new Error(`prize totals (${prizeTotal}) must equal total_tickets (${p.total_tickets})`)
  }

  /* 承諾把獎品清單一起綁進去。
     v1 只雜湊種子，所以開賣後換掉「第 3 個獎項是哪張卡」籤序不變、
     驗算照樣通過 —— 那條路必須堵上，否則「可驗證」只涵蓋一半。

     **新池一律 v4**：序列化尾端有 buyback（賣家宣告的買回價）與
     variantId（卡片變體）。
     buyback 是整份清單裡唯一一個賣家有義務履行的金額；variantId 則堵住
     「同一組卡號的不同版本」那條縫 —— 少了它，把大師球鏡面換成同卡號的普卡
     manifest 逐字不變、驗算照樣回 ok，而那兩張卡實測差約 18,000 倍。 */
  const rows = await tx<{
    id: string; tier: string; total: number; card: Record<string, unknown>; buyback: string | null
  }[]>`select id, tier, total, card, buyback from pool_prizes where pool_id = ${poolId}`

  const manifest: PrizeManifestEntry[] = rows.map(r => {
    const c = r.card as {
      name?: string; setCode?: string | null; cardNo?: string | null
      grader?: string | null; grade?: number | null; certNo?: string | null
      refPrice?: number | null; variantId?: string | null
    }
    /* 少一個買回價就不 commit。這裡是最後一道 ——
       放行的話會產生一個「宣告了 v3 卻有獎品沒有買回價」的池：
       它的 manifest 會把 null 序列化成空字串，驗算過得了，
       但玩家抽到那張卡時按不了回收，而池上又寫著保底回饋率。
       那種池比開不出來更糟。 */
    if (r.buyback == null) throw new Error(`prize ${r.id} has no buyback`)
    return {
      prizeId: r.id, tier: r.tier, total: Number(r.total),
      name: c.name ?? '', setCode: c.setCode ?? null, cardNo: c.cardNo ?? null,
      grader: c.grader ?? null, grade: c.grade ?? null,
      certNo: c.certNo ?? null, refPrice: c.refPrice ?? null,
      buyback: Number(r.buyback),
      /* 沒挑變體就是 null。這裡不替它猜一個值 —— manifest 把 null 序列化成
         空字串，而「空字串」在驗算端是一個明確的宣告：這個獎品沒有指定版本。
         猜一個進去等於平台替賣家宣告了一件他沒說過的事。 */
      variantId: c.variantId ?? null
    }
  })

  const serverSeed = bytesToHex(randomBytes(32))
  /* 寫進 pools 之前的最後一道閘：randomBytes 本身不會產生低熵值，
     這裡防的是未來把上面那行改壞（見 assertSeedEntropy 的註解）。 */
  assertSeedEntropy(serverSeed)
  const manifestHash = await manifestHashOf(manifest, COMMIT_VERSION)
  const commit = await commitV2(serverSeed, manifestHash)
  const source = await reserveClientSeedSource()
  await tx`
    update pools set status = 'committed', server_seed = ${serverSeed},
      commit_hash = ${commit}, manifest_hash = ${manifestHash},
      commit_version = ${COMMIT_VERSION}, client_seed_source = ${source}
    where id = ${poolId}
  `
  return { commit, source }
}

/**
 * committed → open。拿到 client_seed、算籤序、寫滿 pool_seats。
 * 回 false 表示 drand 的 round 還沒到，晚點再試。
 */
/**
 * committed → open。**clientSeed 必須由呼叫端在交易外先取得**。
 *
 * 原本是在這個交易裡直接 fetch drand：那表示一筆持有 FOR UPDATE 鎖的交易
 * 中途要等一個外部 HTTP 回應，drand 一慢整個池就被鎖住。
 * 交易裡不要做外部 I/O —— 用 tryOpenPool() 這個包裝，它會先抓再開交易。
 */
export async function openPool(tx: Tx, poolId: string, clientSeed: string): Promise<boolean> {
  const [p] = await tx`select * from pools where id = ${poolId} for update`
  if (!p) throw new Error('pool not found')
  if (p.status !== 'committed') throw new Error(`pool is ${p.status}, not committed`)

  const prizes = await tx<{ id: string; total: number }[]>`
    select id, total from pool_prizes where pool_id = ${poolId}
  `
  const seq = await seatSequence(p.server_seed as string, clientSeed,
    prizes.map(x => ({ prizeId: x.id, total: Number(x.total) })))

  // 一次寫滿。籤位從 1 開始 —— 玩家看到的號碼跟 UI 一致
  const rows = seq.map((prizeId, i) => ({ pool_id: poolId, seat: i + 1, prize_id: prizeId }))
  for (let i = 0; i < rows.length; i += 500) {
    await tx`insert into pool_seats ${tx(rows.slice(i, i + 500))}`
  }
  await tx`
    update pools set status = 'open', client_seed = ${clientSeed}, opened_at = now()
    where id = ${poolId}
  `
  return true
}

export type DrawOutcome =
  | { ok: true; drawId: string; items: { seat: number; prizeId: string; tier: string; card: unknown }[]; cost: number }
  | { ok: false; error: 'SEATS_TAKEN'; taken: number[] }
  | { ok: false; error: 'POOL_NOT_OPEN' | 'POOL_EXPIRED' | 'INSUFFICIENT_POINTS' | 'BAD_SEATS' }

/**
 * 抽選。全成功或全失敗。
 *
 * 併發防線是那條 UPDATE ... WHERE taken_by IS NULL：
 * 兩個人同時搶同一格，只有一個 UPDATE 會影響到列。影響列數不等於要的數量
 * 就整筆回滾並回報哪些格被搶走了 —— 前端拿到清單重選。
 */
export async function draw(
  tx: Tx, userId: string, poolId: string, seats: number[], drawId: string, now: number
): Promise<DrawOutcome> {
  const uniq = [...new Set(seats)]
  if (!uniq.length || uniq.length !== seats.length || uniq.some(s => !Number.isInteger(s) || s < 1)) {
    return { ok: false, error: 'BAD_SEATS' }
  }

  const [p] = await tx`select * from pools where id = ${poolId} for update`
  if (!p || p.status !== 'open') return { ok: false, error: 'POOL_NOT_OPEN' }
  /* 到期就不能再抽。這裡要判一次而不是只靠背景掃描把 status 改掉：
     掃描每五分鐘一輪，中間那段時間池的 status 還是 'open'。
     判斷跟 FOR UPDATE 在同一個交易裡，所以「同時到期與被抽」不會兩邊都成立 ——
     關池的那筆交易也要拿同一列的鎖，兩者必然排成先後。 */
  if (p.expires_at != null && now >= Number(p.expires_at)) return { ok: false, error: 'POOL_EXPIRED' }
  if (uniq.some(s => s > Number(p.total_tickets))) return { ok: false, error: 'BAD_SEATS' }

  const cost = Number(p.ticket_price) * uniq.length
  const { walletOf, lockSpender } = await import('./money.js')
  /* 先鎖住這個帳戶再算餘額。
     walletOf 是推算的（帳本 SUM 減進行中訂單），**沒有任何一列可以鎖** ——
     這裡原本只鎖了 pools 那一列，所以同一個人同時抽兩個**不同**的池
     會鎖到不同的列、完全不互相阻擋，兩邊各自 SUM 到同一批已提交的帳本
     都判定「夠」，等於同一筆點數花兩次。
     拿 users 那一列當這個帳戶的閘門。鎖序固定「其他資料列 → 使用者列」、
     每筆交易只鎖一個使用者，不會形成死結環。 */
  await lockSpender(tx, userId)
  const w = await walletOf(userId, tx)
  if (w.available < cost) return { ok: false, error: 'INSUFFICIENT_POINTS' }

  const claimed = await tx<{ seat: number; prize_id: string }[]>`
    update pool_seats set taken_by = ${userId}, taken_at = ${now}, draw_id = ${drawId}
    where pool_id = ${poolId} and seat = any(${uniq}) and taken_by is null
    returning seat, prize_id
  `
  if (claimed.length !== uniq.length) {
    const got = new Set(claimed.map(c => Number(c.seat)))
    // 交易會被外層 rollback；這裡只是回報
    return { ok: false, error: 'SEATS_TAKEN', taken: uniq.filter(s => !got.has(s)) }
  }

  await credit(tx, userId, -cost, 'draw', drawId)
  await tx`
    insert into draws (id, pool_id, user_id, seats, cost, source, created_at)
    values (${drawId}, ${poolId}, ${userId}, ${uniq}, ${cost}, 'draw', ${now})
  `

  const prizeRows = await tx`
    select id, tier, card, card_id from pool_prizes where id = any(${claimed.map(c => c.prize_id)})
  `
  const byId = new Map(prizeRows.map(r => [r.id as string, r]))
  const items = claimed.map(c => {
    const pr = byId.get(c.prize_id)!
    const seat = Number(c.seat)
    /* stashId 是這張卡在使用者卡冊裡那一列的 id（prizeId 是池裡的獎項定義，是兩回事）。
       回給前端是為了讓開卡結果導到卡冊時能指名「剛剛拿到的是這幾張」——
       少了它，前端只能自己拼 `pz-<drawId>-<seat>`，等於把主鍵的組法變成契約。

       **card_id 有值時 stashId 就是它**（023）：那張卡在建池時就已經
       在卡冊裡了（賣家名下、狀態 in_pool），抽中是把那一列過戶給買家，
       不是開一列新的。開新的會撞上 prizes_cert_alive —— 同一個編號兩列。 */
    const pledgedId = (pr.card_id as string | null) ?? null
    return {
      seat, prizeId: c.prize_id,
      stashId: pledgedId ?? `pz-${drawId}-${seat}`,
      pledgedId,
      tier: pr.tier as string, card: pr.card
    }
  })

  /* 發到使用者名下的保管庫。
     ── 為什麼要寫 grader / cert_no / custodian_id / origin ──────────
     021 加了這四個欄位並回填了當時已存在的列，但**沒有任何程式碼在新增時
     寫它們** —— 於是每一張新抽出來的卡這四欄都是 null，而
     `prizes_cert_alive`（unique(grader, cert_no) where cert_no is not null）
     對 null 完全不生效。索引因此只保護得到 021 之前的舊卡，新卡一張都沒蓋到：
     一個鑑定編號可以被抽出兩次而資料庫一聲都不吭。

     正規化要跟 021 的回填**用同一套規則**（upper(btrim) / nullif(btrim, '')），
     不然 'PSA' 與 'psa '、' 12345678' 與 '12345678' 會被索引當成不同的卡，
     同一張實體卡換個大小寫或空白就能再登記一次。
     card jsonb 裡的原值不動 —— 顯示照賣家填的，索引照正規化的。 */
  const norm = (v: unknown) => {
    const t = typeof v === 'string' ? v.trim() : ''
    return t === '' ? null : t
  }
  /* 已經押在卡冊裡的那些（建池時開的列）：**過戶，不是新增**。
     用 `status = 'in_pool'` 當守衛 —— 兩個人同時抽到同一個籤位時
     只有一個 UPDATE 會命中（另一個看到的狀態已經不是 in_pool），
     跟 pool_seats 那條「UPDATE ... WHERE taken_by IS NULL」是同一個模式。
     籤位本身其實已經先搶過一輪了，這一層是第二道。 */
  for (const it of items) {
    if (!it.pledgedId) continue
    const moved = await tx`
      update prizes
         set user_id = ${userId}, status = 'stashed', origin = 'draw',
             seat = ${it.seat}, draw_id = ${drawId},
             won_at = ${now}, acquired_at = ${now},
             stash_expires_at = ${now + STASH_DAYS * DAY}
       where id = ${it.pledgedId} and status = 'in_pool'
       returning id
    `
    if (!moved.length) {
      /* 押記的那一列不在預期的狀態 —— 資料被別的路徑動過了。
         這裡**一定要 throw 讓整筆交易回滾**：繼續下去的話買家的點數
         已經扣了（credit 在前面），而他不會拿到任何卡。 */
      throw new Error(`pledged card ${it.pledgedId} is not in_pool`)
    }
  }

  const prizeIns = items.filter(it => !it.pledgedId).map(it => {
    const cd = it.card as { grader?: unknown; certNo?: unknown }
    const g = norm(cd.grader)
    return {
      id: it.stashId, user_id: userId, pool_id: poolId, seat: it.seat,
      draw_id: drawId, card: it.card, tier: it.tier, status: 'stashed',
      grader: g === null ? null : g.toUpperCase(),
      cert_no: norm(cd.certNo),
      /* 實體卡還在賣家抽屜裡 —— 玩家拿到的是擁有權，不是卡。
         這兩件事分開記的理由見 021 與 SettlementRow.ownerId。 */
      custodian_id: p.seller_id as string,
      origin: 'draw',
      /* 抽到的當下兩個時間一樣；分開記是為了轉手 —— 見 migrations/014 */
      won_at: now, acquired_at: now, stash_expires_at: now + STASH_DAYS * DAY
    }
  })
  // 全部都是押記過戶時 prizeIns 會是空的 —— 空陣列不能餵給 tx()
  if (prizeIns.length) await tx`insert into prizes ${tx(prizeIns as never)}`

  /* 票金的貸方。這一段以前整個不存在 —— 買家被扣了 cost，但沒有任何分錄
     把那筆錢給誰，於是賣家收不到錢、全站的點數總量每抽一次就少一次
     （docs/pool-modes-audit.md 的 C-2）。
     必須排在 prizes 插入之後：pool_settlements.prize_id 是外鍵，
     指向買家卡冊裡的那一列，出貨與回收都要靠它把兩邊接起來。 */
  await creditDraw(tx, {
    poolId, sellerId: p.seller_id as string, buyerId: userId, drawId,
    ticketPrice: Number(p.ticket_price), feeRate: Number(p.platform_fee_rate ?? 0),
    items: items.map(i => ({ seat: i.seat, prizeId: i.stashId })),
    now
  })

  /* 抽到高賞才通知。每抽一次都發通知會讓鈴鐺變成雜訊 ——
     使用者剛剛才在開卡畫面上看過結果，重複告知一次沒有資訊量；
     真正值得事後回頭看的是「我抽到了 LAST／A 賞」這種事。 */
  const best = items.filter(i => i.tier === 'LAST' || i.tier === 'A')
  if (best.length) {
    const names = best.map(i => (i.card as { name?: string }).name ?? '卡片').join('、')
    await notify({
      userId, kind: 'draw',
      title: best.some(i => i.tier === 'LAST') ? '抽到最後賞' : '抽到 A 賞',
      body: `${names} 已經進到你的卡冊。`,
      link: `/draw/${drawId}`, refId: drawId
    }, tx)
  }

  // 完抽 → sold_out
  const freeRows = await tx<{ free: string }[]>`
    select count(*)::text as free from pool_seats where pool_id = ${poolId} and taken_by is null
  `
  if (Number(freeRows[0]?.free ?? 0) === 0) await tx`update pools set status = 'sold_out' where id = ${poolId}`

  return { ok: true, drawId, items, cost }
}

/**
 * 開池的正確入口：先在交易外跟 drand 拿值，拿到才開交易。
 *
 * 回傳 false 代表「那一輪的亂數還沒出現」—— 這不是錯誤，是還沒到時間，
 * 呼叫端（背景掃描）稍後會再試一次。
 */
export async function tryOpenPool(poolId: string): Promise<boolean> {
  /* 不收 db 參數：這支自己會開交易，如果呼叫端傳進一個現有交易，
     就會變成交易裡開交易。直接用 root 連線，型別上就不可能誤用。 */
  const [p] = await sqlRoot`select status, client_seed_source from pools where id = ${poolId}`
  if (!p) throw new Error('pool not found')
  if (p.status !== 'committed') throw new Error(`pool is ${p.status}, not committed`)

  const clientSeed = await fetchClientSeed(p.client_seed_source as string)
  if (!clientSeed) return false

  // 交易裡會再鎖一次並重新確認狀態 —— 上面那次讀沒有鎖，中間可能有人先開了
  return sqlRoot.begin(tx => openPool(tx, poolId, clientSeed))
}

/**
 * 背景推進池的生命週期。
 *
 * 為什麼需要：commited → open → sold_out → revealed 這條鏈，中間兩步
 * （開賣、揭曉）原本只有 HTTP 端點、**前端完全沒有任何地方呼叫**，
 * 背景掃描也只掃訂單不掃池。結果是：
 *   - 賣家建好的池永遠停在 committed，不會開賣
 *   - 售完的池永遠停在 sold_out，server_seed 不公開，
 *     公平性驗證因此永遠跑不到 —— 而那是這個平台的核心賣點
 *
 * 開池不需要權限（結果由已承諾的種子與 drand 決定，呼叫者影響不了），
 * 所以交給伺服器自己推進是最自然的做法。
 *
 * 每輪限量處理：每個 committed 的池都要打一次 drand，池一多會拖慢整輪掃描。
 */
const SWEEP_LIMIT = 20

export async function sweepPools(): Promise<{ opened: number; revealed: number; expired: number }> {
  let opened = 0
  let revealed = 0

  /* 到期的池先關。
     關池**只停止販售** —— 已售出但還沒出貨的卡，出貨與鑑賞期照跑完才結算
     （那些結算列在 pool_settlements 裡，跟池的狀態完全脫鉤，這是刻意的：
     賣家的現金流不該綁在池的生命週期上）。
     未售出的籤位從來沒有產生過 prizes 列，所以「卡回到賣家手上」不需要
     任何搬移動作，停止賣就是了。
     沿用 'cancelled' 而不是新增一個狀態：提前收攤已經是這個語意，
     而 revealPool 本來就接受 cancelled —— 到期的池一樣要揭曉種子，
     否則已經抽過的人永遠驗不了自己那一抽。 */
  /* `status in ('open','committed')` —— committed 也要收。
     池建立時是 committed，要等 drand 的未來輪次到期才開賣。如果那一輪
     一直取不到（drand 掛掉、網路長時間不通），池會停在 committed；
     而到期掃描原本只看 open，於是那個池**永遠不會結束** ——
     它的押記卡（023）也就永遠停在 in_pool，賣家再也拿不回那張實體卡。
     從來沒開賣過的池沒有人抽得到，收掉它是無損的。 */
  const expiredRows = await sqlRoot<{ id: string }[]>`
    update pools set status = 'cancelled'
     where status in ('open', 'committed')
       and expires_at is not null and expires_at <= ${Date.now()}
     returning id
  `
  const expired = expiredRows.length

  const committed = await sqlRoot<{ id: string }[]>`
    select id from pools where status = 'committed' order by created_at limit ${SWEEP_LIMIT}
  `
  for (const p of committed) {
    try {
      // false 代表那一輪的 drand 還沒出現 —— 不是錯誤，下一輪再試
      if (await tryOpenPool(p.id)) opened++
    } catch (e) {
      console.error(`[pools] 開池失敗 ${p.id}:`, (e as Error).message)
    }
  }

  /* cancelled 也要揭曉：提前收攤的池，已經抽過的人一樣有權驗證自己那一抽。
     revealPool 本來就接受這兩種狀態。 */
  const soldOut = await sqlRoot<{ id: string }[]>`
    select id from pools where status in ('sold_out', 'cancelled')
    order by created_at limit ${SWEEP_LIMIT}
  `
  for (const p of soldOut) {
    try {
      await sqlRoot.begin(tx => revealPool(tx, p.id))
      revealed++
    } catch (e) {
      console.error(`[pools] 揭曉失敗 ${p.id}:`, (e as Error).message)
    }
  }

  return { opened, revealed, expired }
}

/**
 * 沒被抽走的押記卡回到賣家卡冊（023）。
 *
 * 建池時帶鑑定編號的獎品會在 prizes 開一列（賣家名下、狀態 in_pool），
 * 池結束時那些還沒被抽走的要解押回 in_book —— 不然那張實體卡會**永遠
 * 卡在一個已經結束的池上**，賣家再也不能拿它開新池、也不能上架，
 * 而且那個編號會一直佔著 prizes_cert_alive 的位置。
 *
 * 只動 `status = 'in_pool'` 且**還在自己名下**的列：抽走的那些早就
 * 過戶給買家、狀態是 stashed，一個都不該被碰到。
 *
 * 回的是 in_book 不是 stashed：stashed 的語意是「抽到的獎品寄存在平台」，
 * 而這些卡從來沒有被抽出去過。混用會讓賣家的卡冊看起來像中過獎。
 */
export async function releasePledgedCards(tx: Tx, poolId: string): Promise<number> {
  const rows = await tx`
    update prizes set status = 'in_book'
     where pool_id = ${poolId} and status = 'in_pool'
     returning id
  `
  return rows.length
}

/**
 * 寄存到期：**自動替買家申請出貨**（open-issues.md 的 D-1，使用者拍板）。
 *
 * ── 為什麼需要這個 ─────────────────────────────────────────────────
 * prizes.stash_expires_at 從 002 就存在，抽卡時填 90 天後，然後很長一段
 * 時間**沒有任何一行程式讀過它** —— 那個期限是寫著好看的。039 之後這支
 * 開始發提醒，但仍然「到期不代表任何後果」：一個期限如果過了什麼都不會
 * 發生，它就不是期限，是一句文案。
 *
 * 而「寄存」這個詞本身是誤導的：卡不在平台的保險庫，在**賣家的抽屜裡**
 * （平台不代管實體卡，見 docs/HANDOFF.md 4.2）。所以「卡就放在卡冊」的
 * 真實意思是「要求一個陌生人無限期替你保管一張值錢的卡，而他已經收完
 * 錢了」—— 票金 14 天就結清入袋，義務卻沒有終點。90 天就是那個終點。
 *
 * ── 到期做什麼：替買家建出貨申請 ───────────────────────────────────
 * 走的是**買家自己按「申請出貨」時走的同一條路**（routes/prizes.ts 的
 * POST /prizes/ship）：建一張 shipments、把卡改成 ship_requested、
 * 呼叫 markShipRequested() 掛上賣家的 72 小時出貨時鐘。
 *
 * 「同一條路」是刻意的，也是這支唯一該做的事 —— 賣家逾期不寄的後果
 * （F-5 的 ship_default_at / markShipDefault()、違約次數、滿額不能再開池）
 * 已經長在 sweepSettlements() 裡，自動出貨只要把時鐘掛上去，那一整套就
 * 自己接手了。另造一條平行的逾期路等於讓「賣家欠一張卡」有兩個定義。
 *
 * ── 只碰 stashed，這不是偷懶 ───────────────────────────────────────
 * listed：卡正掛在市場上，強制出貨會跟掛單打架（掛單的 prize_id 唯一索引、
 *   成交後的 releasePrize 都預期那一列是 listed）。而且主人正在處理它 ——
 *   他選擇賣掉而不是收貨，那也是一種「處理完寄存」。
 * in_pool：賣家自己押在池上的卡，從來沒被抽走過，沒有買家、沒有收件人。
 * ship_requested / shipped：已經在路上了，再建一張就是重複出貨。
 * recycled / refunded：已經不是他的卡。
 * in_book：卡在自己手上（custodian = owner），沒有東西要寄。
 *
 * 剩下 stashed 這一個狀態，正好就是「錢付了、卡還在別人抽屜裡」那一種。
 *
 * ── 沒填收件地址的人 ───────────────────────────────────────────────
 * 出貨要地址，而地址是 users 表的 real_name / phone / address_*（006），
 * 全部允許空值。沒填就**不建出貨單**，改發一則「去補收件資料」。
 * 為什麼不建：賣家的出貨頁（routes/sellers.ts 的 /settlements）是用
 * shipments.address 餵地址的，沒有地址那一欄會是 null —— 賣家會看到一筆
 * 「你欠一張卡、期限 72 小時」卻不知道要寄去哪，而且逾期會真的記他違約。
 * 那是平台自己製造出來、對方無法履行的義務。
 *
 * ── 冪等 ───────────────────────────────────────────────────────────
 * 這支掛在五分鐘一次的排程上，出貨那一段又會動錢與義務，所以「同一張卡
 * 不能被建出兩筆出貨單」是硬需求。三層：
 *   1. 撈候選只看 status = 'stashed'，而建單的同一個交易就把它改成
 *      ship_requested —— 下一輪掃描根本撈不到它。
 *   2. 交易裡 `for update` 重鎖重判（候選是無鎖撈的，可能已經被買家
 *      自己申請出貨了）。
 *   3. 通知走 notify() 的 refId（007 的唯一索引 (user_id, kind, ref_id)）。
 *
 * ── 鎖序 ───────────────────────────────────────────────────────────
 * 全站鎖序是 **prizes → sellers → settlements → shipments**（見
 * pool-settlement.ts 檔頭）。這支：先 `order by id` 整批鎖 prizes，
 * 再讓 markShipRequested 動 pool_settlements，最後 insert shipments。
 * 上鎖階段結束之後不再要求新的 prizes 列鎖 —— 那正是 regress-deadlock
 * 第 3 組壓出 40P01 的形狀（握著共用列還在拿新列）。
 * 這支不碰 sellers：違約次數是 sweepSettlements 那邊記的，不是這裡。
 *
 * ── 這一輪刻意不做「延長寄存」 ─────────────────────────────────────
 * 讓買家按一下就延 90 天，期限就又回到「不代表任何後果」——
 * 只是把「永遠不處理」換成「每 90 天按一次」。代價是：真的還不想收貨的
 * 買家會被迫收貨（或收到之後自己再上架）。目前的出口是**上架賣掉**與
 * **接受買回價**，兩條都在卡冊上按得到；到期前兩週的提醒就是講這件事的。
 * 如果實際跑起來抱怨集中在這一點，再回來討論延長要付出什麼代價
 * （例如延長要收保管費、或延長次數有上限）—— 那是政策問題不是技術問題。
 */
const STASH_WARN_MS = 14 * DAY

/**
 * 一輪最多自動出貨幾張。
 *
 * 不是效能考量，是**爆炸半徑**：這支替使用者做決定並讓賣家背上有罰則的
 * 義務，萬一條件寫錯，一輪 100 張比一輪 100000 張好收拾。掃描五分鐘一次，
 * 積壓的量幾輪就消化完。
 */
const AUTO_SHIP_BATCH = 100

/** 一張出貨單最多幾張卡。跟 routes/prizes.ts 的 ShipBody 同一個上限 */
const SHIP_MAX_PER_SHIPMENT = 50

/**
 * 「收件資料填齊了」的判斷，**只寫這一次**。
 *
 * 條件跟 routes/prizes.ts 的 ShipBody 對齊（name / phone / line1 / city 必填，
 * zip 選填），寫成 SQL 片段是為了讓「撈可以自動出貨的」與「撈缺地址的」
 * 是同一條規則的正反面 —— 兩邊各寫一次的話，某天改了其中一邊，就會有一批
 * 卡兩邊都撈不到，永遠卡在到期狀態而且沒有人收到任何通知。
 */
const addressReady = sqlRoot`
  btrim(coalesce(u.real_name, ''))     <> ''
  and length(btrim(coalesce(u.phone, ''))) >= 8
  and btrim(coalesce(u.address_line1, '')) <> ''
  and btrim(coalesce(u.address_city, ''))  <> ''
`

/**
 * 「這張卡有人有義務把它寄出去」的守衛。
 *
 * 跟 addressReady 同一個道理：撈「可以自動出貨的」與撈「缺地址卡住的」必須是
 * 同一條規則，兩邊各寫一次就會有一批卡兩邊都撈不到。而這一段原本只寫在
 * autoShipExpired 裡，warnMissingAddress 沒有 —— 後果不是漏撈，是**發出一則
 * 兌現不了的承諾**：沒有結算列的卡就算補齊地址也不會被自動出貨，而那則提醒
 * 說的是「補齊之後系統會自動接手」。
 *
 * 為什麼一定有這種卡：017_pool_settlement.sql 明寫「既有的 draws 不回填
 * pool_settlements」，所以 017 之前抽中、還放在卡冊裡的卡全部沒有結算列 ——
 * 而它們是站上最老的卡，幾乎都已經過了 90 天。
 */
const hasShipObligation = sqlRoot`
  exists (
    select 1 from pool_settlements st
     where st.prize_id = p.id and st.status in ('held', 'released')
  )
`

/** 收件地址。**個人資料：不進 log、不進網址、不進通知內文。** */
interface ShipAddress {
  name: string; phone: string; line1: string; city: string; zip?: string
}

export async function sweepStashExpiry(): Promise<{
  warned: number; expired: number; shipped: number; noAddress: number
}> {
  const now = Date.now()

  /* 只看 stashed。listed / ship_requested / shipped 的卡主人正在處理它，
     再提醒一次只是雜訊；recycled / refunded 已經不是他的卡了。 */
  const soon = await sqlRoot<{ id: string; user_id: string; name: string | null }[]>`
    select id, user_id, card->>'name' as name from prizes
     where status = 'stashed'
       and stash_expires_at > ${now}
       and stash_expires_at <= ${now + STASH_WARN_MS}
     limit 200
  `
  for (const r of soon) {
    await notify({
      userId: r.user_id, kind: 'system',
      title: '卡片的寄存期限快到了',
      body: `${r.name ?? '你的卡'} 再過兩週就滿 ${STASH_DAYS} 天寄存期。`
        + '期限到了我們會自動替你申請出貨，把卡從賣家那裡寄給你 —— '
        + '請先確認「我的資料」裡的收件人、電話、地址是最新的。'
        + '不想收實體卡的話，也可以在期限前上架賣掉或接受買回價。',
      /* refId 換了前綴（原本是 stash-warn:）。到期的後果從「什麼都不會發生」
         變成「自動出貨」，舊那則的內文（「期限到了不會沒收」）現在是錯的 ——
         沿用舊前綴的話，已經收過舊提醒的人永遠不會收到正確的那一則，
         而他們正是最可能被自動出貨嚇到的一群。
         帶 id 而不是帶日期：同一張卡的同一種提醒只發一次，卡的 id 是穩定的；
         帶日期的話跨過午夜就會再發一次。 */
      link: '/me/profile',
      refId: 'stash-warn2:' + r.id
    })
  }

  const shipped = await autoShipExpired(now)
  const noAddress = await warnMissingAddress(now)

  return { warned: soon.length, expired: shipped + noAddress, shipped, noAddress }
}

/**
 * 到期而且收件資料填齊的：**建出貨申請**。回傳實際出貨的張數。
 *
 * `exists (... pool_settlements ...)` 那一段是刻意的守衛：自動出貨的全部
 * 意義是「讓賣家真的把卡寄出來」，而那個義務住在結算列上
 * （markShipRequested 只會動 held 與 released 兩種）。沒有結算列的
 * stashed 卡（測試素材、或某條路徑寫壞留下的）建出來的是一張**沒有人
 * 有義務履行**的出貨單：賣家的出貨頁 join 的是 pool_settlements，
 * 他連看都看不到，而買家的卡會永遠停在 ship_requested。
 * 寧可不動它 —— 那種列本來就該由 monitor 抓出來，不該由這支蓋掉。
 */
async function autoShipExpired(now: number): Promise<number> {
  /* 第一段：無鎖撈候選，照 id 排序（第二段要照同一個順序上鎖）。 */
  const cand = await sqlRoot<{ id: string }[]>`
    select p.id
      from prizes p join users u on u.id = p.user_id
     where p.status = 'stashed'
       and p.stash_expires_at <= ${now}
       and ${addressReady}
       and ${hasShipObligation}
     order by p.id
     limit ${AUTO_SHIP_BATCH}
  `
  if (!cand.length) return 0
  const ids = cand.map(c => c.id).sort()

  return await sqlRoot.begin(async tx => {
    /* 第二段：照全站鎖序先把 prizes 整批鎖起來（order by id —— `= any(...)`
       本身不保證上鎖順序），而且**鎖完之後不再要新的 prizes 列鎖**。
       重帶 where：候選是無鎖撈的，這幾張可能已經被買家自己申請出貨、
       上架、或接受買回價了。 */
    const locked = await tx<{ id: string; user_id: string }[]>`
      select id, user_id from prizes
       where id = any(${ids}) and status = 'stashed' and stash_expires_at <= ${now}
       order by id
       for update
    `
    if (!locked.length) return 0

    /* 按人分組：一張出貨單就是一個包裹，同一個人到期的卡該一起寄，
       不是一張卡一張單。 */
    const byUser = new Map<string, string[]>()
    for (const r of locked) {
      const list = byUser.get(r.user_id) ?? []
      list.push(r.id)
      byUser.set(r.user_id, list)
    }

    let done = 0
    for (const [userId, cards] of byUser) {
      /* 地址在鎖之後再讀一次：上面那次是無鎖快照，使用者可能剛好把資料清空。
         填不齊就整個人跳過 —— 這一輪不出貨，下一輪 warnMissingAddress
         會提醒他去補。 */
      const [u] = await tx<{
        real_name: string | null; phone: string | null
        address_zip: string | null; address_city: string | null; address_line1: string | null
      }[]>`
        select real_name, phone, address_zip, address_city, address_line1
          from users where id = ${userId}
      `
      const addr = toShipAddress(u)
      if (!addr) continue

      /* 一張單最多 50 張（同 ShipBody 的上限）—— 一次到期 80 張的人
         會拿到兩張單，那也是他手動申請時會拿到的樣子。 */
      for (let i = 0; i < cards.length; i += SHIP_MAX_PER_SHIPMENT) {
        const prizeIds = cards.slice(i, i + SHIP_MAX_PER_SHIPMENT)
        const shipmentId = 'sh-' + randomBytes(5).toString('hex')

        await tx`
          insert into shipments (id, user_id, prize_ids, address, created_at)
          values (${shipmentId}, ${userId}, ${prizeIds}, ${addr as never}, ${now})
        `
        await tx`update prizes set status = 'ship_requested' where id = any(${prizeIds})`
        /* 賣家的 72 小時出貨時鐘。少了這一行，出貨單會進佇列卻沒有任何
           後果 —— 那正是 F-5，而 F-5 已經修好了，這裡只是接上去。 */
        await markShipRequested(tx, prizeIds, now)

        /* ── 買家：這件事是平台替你做的，講清楚為什麼、以及他還能做什麼 ──
           **地址一個字都不放進內文**（個資），只說「去確認」。 */
        await notify({
          userId, kind: 'shipment',
          title: `${prizeIds.length} 張卡已自動申請出貨`,
          body: `這些卡放滿了 ${STASH_DAYS} 天寄存期。實體卡一直在賣家手上，`
            + '所以期限到了我們會自動替你申請出貨，把卡寄到你留的收件地址。'
            + '請到「我的資料」確認收件人、電話、地址正確 —— 有錯請盡快聯絡客服更正。'
            + '收到卡片後記得到卡冊按確認收貨。',
          link: '/me/profile', refId: 'stash-autoship:' + shipmentId
        }, tx)

        /* ── 賣家：時鐘已經開始跑了，以及不寄的後果 ──────────────────
           條件跟 markShipRequested 剛剛寫的兩個 UPDATE 對齊（正常路徑的
           awaiting_ship、以及票金已釋放但還欠卡的 released）。
           group by seller_id：一批到期可以橫跨多個賣家，每個人只該收到
           一則、而且只看到自己那幾張的數量。
           refId 綁出貨單 id，前綴跟買家自己申請那條（ship-req:）分開 ——
           內文不一樣（這一則要解釋「買家沒按，是期限到了」），
           共用前綴會讓先發生的那一則把另一則擋掉。 */
        const owed = await tx<{ seller_id: string; n: number }[]>`
          select st.seller_id, count(*)::int as n
            from pool_settlements st
           where st.prize_id = any(${prizeIds})
             and st.ship_due_at is not null and st.shipped_at is null
             and st.status in ('awaiting_ship', 'released')
           group by st.seller_id
        `
        for (const o of owed) {
          await notify({
            userId: o.seller_id, kind: 'shipment',
            title: '寄存期滿，這些卡要出貨了',
            body: `${o.n} 張卡放滿 ${STASH_DAYS} 天寄存期，系統已自動替買家申請出貨 —— `
              + `不是買家臨時按的，是期限到了。請在 ${POOL_SHIP_DEADLINE_MS / 3_600_000} 小時內寄出，`
              /* 兩種後果都要講，因為兩種都可能發生：票金還在保留額裡的會退款給買家
                 （refund），已經結算出去的不退款、只記違約（markShipDefault，F-5）。
                 只講其中一種，另一種發生時賣家會覺得平台說謊。 */
              + '逾期會記一次違約；票金還沒結算的話還會退款給買家。'
              + '記違約不代表義務結清 —— 卡還是要寄。收件地址在出貨頁上。',
            link: '/seller/shipping', refId: 'stash-autoship-seller:' + shipmentId
          }, tx)
        }
        done += prizeIds.length
      }
    }
    return done
  })
}

/**
 * 到期但收件資料不齊的：只提醒去補，**不建出貨單**（理由見 sweepStashExpiry
 * 檔頭）。回傳被卡住的張數。
 *
 * 為什麼按人聚合而不是按卡：一個人缺的是同一份資料，缺 20 張就發 20 則
 * 只是把唯一一則有用的訊息埋掉。
 *
 * refId 帶年月：**這一則不能只發一次**。它擋住的是整個機制 —— 沒補資料，
 * 卡就永遠停在到期狀態，而一則六個月前被滑掉的通知等於沒發過。
 * 但也不能每次掃描都發（五分鐘一次），所以折成一個月一則。
 */
async function warnMissingAddress(now: number): Promise<number> {
  const rows = await sqlRoot<{ user_id: string; n: number }[]>`
    select p.user_id, count(*)::int as n
      from prizes p join users u on u.id = p.user_id
     where p.status = 'stashed'
       and p.stash_expires_at <= ${now}
       and not (${addressReady})
       and ${hasShipObligation}
     group by p.user_id
     limit 200
  `
  const month = new Date(now).toISOString().slice(0, 7)
  let stuck = 0
  for (const r of rows) {
    stuck += r.n
    await notify({
      userId: r.user_id, kind: 'shipment',
      title: '有卡片到期要出貨，但收件資料還沒填',
      body: `你有 ${r.n} 張卡放滿了 ${STASH_DAYS} 天寄存期，本來會自動申請出貨，`
        + '但「我的資料」裡的收件人、電話、地址還沒填齊，出不了貨。'
        + '補齊之後系統會自動接手，你不用再按任何按鈕。',
      link: '/me/profile', refId: `stash-noaddr:${r.user_id}:${month}`
    })
  }
  return stuck
}

/**
 * users 那五欄 → 出貨用的收件地址。填不齊回 null。
 *
 * 條件跟 routes/prizes.ts 的 ShipBody 逐項對齊，長度也照它截 ——
 * users 那幾欄的長度是 routes/auth.ts 的 Profile 擋的，兩份 schema 現在
 * 一致，但截一次的成本是零，而不截的代價是自動出貨會因為長度而整批失敗。
 *
 * **回傳值是個人資料**：不可以進 console.log、不可以進網址、不可以進通知內文。
 */
function toShipAddress(u: {
  real_name: string | null; phone: string | null
  address_zip: string | null; address_city: string | null; address_line1: string | null
} | undefined): ShipAddress | null {
  if (!u) return null
  const name = (u.real_name ?? '').trim().slice(0, 40)
  const phone = (u.phone ?? '').trim().slice(0, 20)
  const line1 = (u.address_line1 ?? '').trim().slice(0, 120)
  const city = (u.address_city ?? '').trim().slice(0, 40)
  const zip = (u.address_zip ?? '').trim().slice(0, 10)
  if (!name || phone.length < 8 || !line1 || !city) return null
  return zip ? { name, phone, line1, city, zip } : { name, phone, line1, city }
}

/** sold_out → revealed。從此 server_seed 可以公開 */
export async function revealPool(tx: Tx, poolId: string) {
  const [p] = await tx`select status, seller_id, title from pools where id = ${poolId} for update`
  if (!p) throw new Error('pool not found')
  if (p.status !== 'sold_out' && p.status !== 'cancelled') throw new Error(`pool is ${p.status}`)
  await tx`update pools set status = 'revealed', revealed_at = now() where id = ${poolId}`
  /* 揭曉是所有結束路徑（抽完、到期、提前關）的共同終點，所以解押掛在這裡
     只會發生一次。掛在「到期」那條的話，抽完售罄的池就漏掉了。 */
  const released = await releasePledgedCards(tx, poolId)

  /* 解押完要通知賣家。揭曉是掃描觸發的（見 sweepPools），賣家不在場，
     而這件事改變了他手上的資源：那幾張卡從「鎖在一個已結束的池上」
     變回可以再開池、可以上架。不講的話他要自己某天打開卡冊才發現。

     只在真的有卡回來時發：一張都沒剩（全部抽走）的池發一則
     「0 張已解押」只是噪音。
     refId 綁 poolId —— 一個池只揭曉一次，是一次性的事實。 */
  if (released > 0) {
    await notify({
      userId: p.seller_id as string, kind: 'system',
      title: `沒抽走的 ${released} 張卡已回到你的卡冊`,
      body: `「${p.title as string}」已開獎結束。沒有被抽走的卡解除質押，`
        + '可以再開新池或上架販售。',
      link: '/me/cards', refId: 'pool-released:' + poolId
    }, tx)
  }
}
