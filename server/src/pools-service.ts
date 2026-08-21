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
import { bytesToHex, commitV2, manifestHashOf, seatSequence, type PrizeManifestEntry } from './shared/fairness.js'
import type { Tx } from './db.js'
import { sql as sqlRoot } from './db.js'
import { credit } from './money.js'
import { notify } from './notify.js'

export const STASH_DAYS = 90
const DAY = 86_400_000

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

  /* v2 的承諾把獎品清單一起綁進去。
     v1 只雜湊種子，所以開賣後換掉「第 3 個獎項是哪張卡」籤序不變、
     驗算照樣通過 —— 那條路必須堵上，否則「可驗證」只涵蓋一半。 */
  const rows = await tx<{
    id: string; tier: string; total: number; card: Record<string, unknown>
  }[]>`select id, tier, total, card from pool_prizes where pool_id = ${poolId}`

  const manifest: PrizeManifestEntry[] = rows.map(r => {
    const c = r.card as {
      name?: string; setCode?: string | null; cardNo?: string | null
      grader?: string | null; grade?: number | null; certNo?: string | null; refPrice?: number | null
    }
    return {
      prizeId: r.id, tier: r.tier, total: Number(r.total),
      name: c.name ?? '', setCode: c.setCode ?? null, cardNo: c.cardNo ?? null,
      grader: c.grader ?? null, grade: c.grade ?? null,
      certNo: c.certNo ?? null, refPrice: c.refPrice ?? null
    }
  })

  const serverSeed = bytesToHex(randomBytes(32))
  const manifestHash = await manifestHashOf(manifest)
  const commit = await commitV2(serverSeed, manifestHash)
  const source = await reserveClientSeedSource()
  await tx`
    update pools set status = 'committed', server_seed = ${serverSeed},
      commit_hash = ${commit}, manifest_hash = ${manifestHash}, client_seed_source = ${source}
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
  | { ok: false; error: 'POOL_NOT_OPEN' | 'INSUFFICIENT_POINTS' | 'BAD_SEATS' }

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
    select id, tier, card from pool_prizes where id = any(${claimed.map(c => c.prize_id)})
  `
  const byId = new Map(prizeRows.map(r => [r.id as string, r]))
  const items = claimed.map(c => {
    const pr = byId.get(c.prize_id)!
    return { seat: Number(c.seat), prizeId: c.prize_id, tier: pr.tier as string, card: pr.card }
  })

  // 發到使用者名下的保管庫
  const prizeIns = items.map(it => ({
    id: `pz-${drawId}-${it.seat}`, user_id: userId, pool_id: poolId, seat: it.seat,
    draw_id: drawId, card: it.card, tier: it.tier, status: 'stashed',
    won_at: now, stash_expires_at: now + STASH_DAYS * DAY
  }))
  await tx`insert into prizes ${tx(prizeIns as never)}`

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

export async function sweepPools(): Promise<{ opened: number; revealed: number }> {
  let opened = 0
  let revealed = 0

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

  return { opened, revealed }
}

/** sold_out → revealed。從此 server_seed 可以公開 */
export async function revealPool(tx: Tx, poolId: string) {
  const [p] = await tx`select status from pools where id = ${poolId} for update`
  if (!p) throw new Error('pool not found')
  if (p.status !== 'sold_out' && p.status !== 'cancelled') throw new Error(`pool is ${p.status}`)
  await tx`update pools set status = 'revealed', revealed_at = now() where id = ${poolId}`
}
