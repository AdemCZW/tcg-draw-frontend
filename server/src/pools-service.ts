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
import { creditDraw } from './pool-settlement.js'
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
 * 寄存到期的提醒。
 *
 * ── 為什麼需要這個 ─────────────────────────────────────────────────
 * prizes.stash_expires_at 從 002 就存在，抽卡時填 90 天後，然後**沒有
 * 任何一行程式讀過它** —— 那個期限是寫著好看的。
 *
 * 而「寄存」這個詞本身是誤導的：卡不在平台的保險庫，在**賣家的抽屜裡**
 * （平台不代管實體卡，見 docs/HANDOFF.md 4.2）。所以「卡就放在卡冊」的
 * 真實意思是「要求一個陌生人無限期替你保管一張值錢的卡，而他已經收完
 * 錢了」—— 票金在 14 天後就結清入袋，義務卻沒有終點。
 *
 * ── 這一支**只通知，不改任何規則** ──────────────────────────────────
 * 到期不扣卡、不強制出貨、不影響任何功能。理由是卡不在平台手上，
 * 平台沒有辦法強迫任何人寄任何東西；能做的只有讓雙方知道。
 * 先看實際上有多少卡會放到期，再決定要不要做後面那些（自動出貨、
 * 保管費、逾期凍結），那是政策問題不是技術問題。
 *
 * 冪等靠 notify() 的 refId（007 的唯一索引 (user_id, kind, ref_id)）——
 * 這支掛在五分鐘一次的掃描上，沒有它每個人每五分鐘收一次同樣的提醒。
 */
const STASH_WARN_MS = 14 * DAY

export async function sweepStashExpiry(): Promise<{ warned: number; expired: number }> {
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
        + '卡目前還在賣家手上 —— 想拿到實體卡就申請出貨，不然也可以上架賣掉。'
        + '期限到了不會沒收，只是提醒你這張卡放很久了。',
      link: '/me/cards',
      /* refId 帶 id 而不是帶日期：同一張卡的同一種提醒只發一次，
         而卡的 id 是穩定的。帶日期的話跨過午夜就會再發一次。 */
      refId: 'stash-warn:' + r.id
    })
  }

  const over = await sqlRoot<{ id: string; user_id: string; name: string | null }[]>`
    select id, user_id, card->>'name' as name from prizes
     where status = 'stashed' and stash_expires_at <= ${now}
     limit 200
  `
  for (const r of over) {
    await notify({
      userId: r.user_id, kind: 'system',
      title: '卡片已超過寄存期限',
      body: `${r.name ?? '你的卡'} 已經超過 ${STASH_DAYS} 天的寄存期。`
        + '這張卡仍然是你的，功能也沒有任何限制 —— 但它一直放在賣家那裡，'
        + '時間越久越難處理。建議申請出貨或上架。',
      link: '/me/cards',
      refId: 'stash-over:' + r.id
    })
  }

  return { warned: soon.length, expired: over.length }
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
