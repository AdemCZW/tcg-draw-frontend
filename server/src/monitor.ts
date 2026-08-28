/**
 * 系統自我檢測。
 *
 * ── 這是什麼 ────────────────────────────────────────────────────────
 * 一組**不變式**：系統健康時永遠成立的敘述（帳本總量等於發行量、
 * 兩張表對同一件事說同一句話、該被排程收走的東西沒有堆著）。
 * 定期跑一輪，破掉的每一條變成一張「修復任務」通知發給所有管理員，
 * 並且可以隨時用 GET /v1/admin/monitor 手動跑一次看現況。
 *
 * ── 為什麼需要 ──────────────────────────────────────────────────────
 * 這個系統的錯誤有一個共同的長相：**畫面上看起來一切正常**。
 * F-1（回收把錢付給前一個主人）金額對、狀態對，只有收款人是錯的；
 * F-3（出貨不同步）要等買家去按確認才炸；021 的索引蓋不到新卡
 * （grader 欄位沒人寫）是「沒有東西被擋」，本來就靜悄悄。
 * 這類問題不會自己冒出來，只能靠把不變式寫下來、反覆對著資料檢查。
 * 過去這些檢查散在每次修完手動跑的一次性腳本裡 —— 跑完就丟，
 * 下次壞掉還是沒人知道。這支把它們變成系統的常駐能力。
 *
 * ── 設計原則 ────────────────────────────────────────────────────────
 * 1. **只讀，永不修。** 檢測發現問題就通知，不自動「修復」——
 *    自動修等於把一個沒人理解的狀態靜靜改成另一個沒人理解的狀態，
 *    證據也沒了。修復是人的事，這裡只負責讓人知道。
 * 2. **每條檢查都要便宜。** 這支掛在排程上，掃描不能比它要保護的
 *    系統還重。每條都是單一聚合查詢，吃現有的索引。
 * 3. **訊息要講得出「所以呢」。** 「settlement 與 prizes 不一致 3 筆」
 *    沒有用；要說這代表什麼、會造成什麼、先查哪裡。
 * 4. 檢測自己壞掉不能拖垮任何東西 —— 呼叫端一律 catch。
 */
import { sql } from './db.js'
import { notify } from './notify.js'
import {
  POOL_INSPECT_MS, POOL_SHIP_DEADLINE_MS, POOL_VAULT_ACCEPT_MS
} from './shared/pool-settlement.js'
import { DELIVER_DEADLINE, INSPECT_WINDOW, SHIP_DEADLINE } from './shared/escrow.js'

const DAY = 86_400_000
/* 「逾期」再寬限一天才算異常：排程五分鐘一輪，正常運作下到期的東西
   幾分鐘內就會被收走。留一天的緩衝是為了不要在排程短暫落後
   （部署重啟、資料庫瞬斷）時就對管理員喊狼來了 —— 警報疲勞會讓
   真的警報也被忽略，那比晚一天發現更糟。 */
const GRACE = 1 * DAY

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface Finding {
  check: string
  severity: Severity
  count: number
  /** 給人看的：這代表什麼、會造成什麼、先查哪裡 */
  message: string
  /** 幾個樣本 id，查起來有起點。刻意不帶完整資料 —— 通知會進資料庫 */
  sample: string[]
}

interface CheckResult { findings: Finding[] }

const finding = (
  check: string, severity: Severity, rows: { id?: unknown }[], message: string
): Finding[] => rows.length
  ? [{ check, severity, count: rows.length, message, sample: rows.slice(0, 5).map(r => String(r.id ?? '?')) }]
  : []

/* ---------------- 各檢查 ---------------- */

/**
 * 帳本總量 − 發行量。
 *
 * 有舊資料的環境 drift 是**已知的非零常數**（017 之前的票金真的被銷毀，
 * 刻意不回填 —— 回填等於現在才印鈔票）。所以「≠ 0」本身不是異常，
 * **「變了」才是**：常數會一直是同一個常數，一動就代表有一筆分錄
 * 只寫了單邊。基準存 monitor_state，第一次看到就記下來。
 *
 * 變了會更新基準再警報 —— 之後**再變**要能再警報一次；
 * 不更新的話同一次事故會每輪重複警報，把後續真的變動淹掉。
 */
async function checkLedgerDrift(): Promise<CheckResult> {
  const ISSUE = ['topup', 'seed', 'admin-grant', 'line-signup-bonus']
  const [r] = await sql<{ total: string; issued: string }[]>`
    select
      (select coalesce(sum(delta),0) from points_ledger)::text as total,
      (select coalesce(sum(delta),0) from points_ledger where reason = any(${ISSUE}))::text as issued
  `
  const drift = Number(r?.total ?? 0) - Number(r?.issued ?? 0)

  const [prev] = await sql<{ value: string }[]>`
    select value from monitor_state where key = 'ledger-drift'
  `
  await sql`
    insert into monitor_state (key, value, updated_at)
    values ('ledger-drift', ${String(drift)}, ${Date.now()})
    on conflict (key) do update set value = ${String(drift)}, updated_at = ${Date.now()}
  `
  if (prev && Number(prev.value) !== drift) {
    return {
      findings: [{
        check: 'ledger-drift', severity: 'critical', count: 1,
        message: `帳本漂移從 ${prev.value} 變成 ${drift}（差 ${drift - Number(prev.value)} 點）。`
          + '這代表有分錄只寫了單邊 —— 點數被憑空創造或消滅了。'
          + '用 GET /v1/admin/reconcile 的 byReason 找哪個科目的借貸不成對，'
          + '再對 points_ledger 找那段時間的單邊分錄。**這是最高優先。**',
        sample: []
      }]
    }
  }
  return { findings: [] }
}

/** 任何人的餘額都不該是負的 —— lockSpender 的整套設計就是在保證這件事 */
async function checkNegativeBalance(): Promise<CheckResult> {
  const rows = await sql<{ id: string }[]>`
    select user_id as id from points_ledger
     group by user_id having sum(delta) < 0 limit 20
  `
  return {
    findings: finding('negative-balance', 'critical', rows,
      '有帳戶餘額是負的。lockSpender 的併發防線被繞過了 —— '
      + '找出這個帳戶最近的分錄，看哪兩筆是同時成立的。')
  }
}

/**
 * 結算列與卡片列必須對同一件事說同一句話。
 * 這正是 F-3（出貨不同步把卡鎖死）與 F-4（退款後復活）的長相 ——
 * 兩張表各說各話，使用者卡在中間哪邊都動不了。
 */
async function checkSettlementPrizeSync(): Promise<CheckResult> {
  const rows = await sql<{ id: string; st: string; pz: string }[]>`
    select st.id, st.status as st, pz.status as pz
      from pool_settlements st join prizes pz on pz.id = st.prize_id
     where (st.status = 'awaiting_ship' and pz.status <> 'ship_requested')
        or (st.status = 'refunded'      and pz.status <> 'refunded')
        or (st.status = 'recycled'      and pz.status <> 'recycled')
        or (st.status = 'shipped'       and pz.status <> 'shipped')
     limit 20
  `
  return {
    findings: finding('settlement-prize-desync', 'high', rows,
      '結算列與卡片列的狀態對不上（例如結算說等出貨、卡片卻不是申請出貨中）。'
      + '這是 F-3／F-4 那一類問題的長相：某條路徑只更新了其中一張表。'
      + '先看樣本那幾筆的兩邊狀態組合，找最近哪個動作只寫了一半。')
  }
}

/** 市場掛單與卡片的上架狀態要互相對得上 —— 錯開就是可以賣掉不存在的卡，或卡被鎖住下不了架 */
async function checkListingPrizeSync(): Promise<CheckResult> {
  const rows = await sql<{ id: string }[]>`
    select l.id from listings l join prizes pz on pz.id = l.prize_id
     where l.status = 'live' and pz.status <> 'listed'
    union all
    select pz.id from prizes pz
     where pz.status = 'listed'
       and not exists (select 1 from listings l where l.prize_id = pz.id and l.status = 'live')
     limit 20
  `
  return {
    findings: finding('listing-prize-desync', 'high', rows,
      '有效掛單指著一張不在上架狀態的卡，或一張標著上架的卡沒有任何有效掛單。'
      + '前者可以成交一張不該賣的卡；後者的卡被鎖在 listed 出不來。'
      + '看樣本那幾筆是掛單先死還是卡先變。')
  }
}

/** 池都結束了，押記的卡還沒解押 —— 賣家的實體卡被一個死掉的池扣住 */
async function checkStuckPledges(): Promise<CheckResult> {
  const rows = await sql<{ id: string }[]>`
    select pz.id from prizes pz join pools p on p.id = pz.pool_id
     where pz.status = 'in_pool' and p.status = 'revealed'
     limit 20
  `
  return {
    findings: finding('stuck-in-pool', 'high', rows,
      '池已經揭曉了，押記的卡還停在 in_pool —— revealPool 的解押'
      + '（releasePledgedCards）沒有跑到。那張實體卡的編號被永久佔住，'
      + '賣家不能拿它開新池也不能上架。手動把那幾列改回 in_book 前，'
      + '先確認它們沒有被抽走（有 draw_id 的不該在這份名單裡）。')
  }
}

/**
 * 該被排程收走的結算堆著沒人收 —— 掃描停了。
 * 單筆逾期是正常的（掃描五分鐘一輪），**過期超過一天還在**才是異常。
 */
async function checkSweepStalled(): Promise<CheckResult> {
  const now = Date.now()
  const rows = await sql<{ id: string }[]>`
    select id from pool_settlements
     where (status = 'held'          and created_at < ${now - POOL_VAULT_ACCEPT_MS - GRACE})
        or (status = 'awaiting_ship' and ship_due_at is not null and ship_due_at < ${now - GRACE})
        or (status = 'shipped'       and shipped_at is not null and shipped_at < ${now - POOL_INSPECT_MS - GRACE})
     limit 20
  `
  return {
    findings: finding('settlement-sweep-stalled', 'medium', rows,
      '有結算過了時限一天以上還停在保留狀態 —— 逾期掃描（sweepSettlements）'
      + '沒有在跑，或每次都在同一筆上失敗。看伺服器 log 的 [sweep] 那幾行；'
      + '賣家的錢正被多扣著，買家的退款也沒發。')
  }
}

/** 託管訂單同理 —— escrow 的時限掃描停了 */
async function checkEscrowStalled(): Promise<CheckResult> {
  const now = Date.now()
  const rows = await sql<{ id: string }[]>`
    select id from orders
     where (status = 'escrowed'  and created_at   < ${now - SHIP_DEADLINE - GRACE})
        or (status = 'shipped'   and shipped_at   is not null and shipped_at   < ${now - DELIVER_DEADLINE - GRACE})
        or (status = 'delivered' and delivered_at is not null and delivered_at < ${now - INSPECT_WINDOW - GRACE})
     limit 20
  `
  /* disputed 刻意不算：爭議逾期不自動裁決是規則（人要判），堆著是預期的 */
  return {
    findings: finding('escrow-sweep-stalled', 'medium', rows,
      '有託管訂單過了時限一天以上還開著 —— escrow 的掃描沒跑。'
      + '買家的貨款與賣家的保證金都還凍著。看 [sweep] 的 log。')
  }
}

/**
 * 池卡在 committed 超過一天 —— drand 一直取不到。
 * 到期掃描最後會收掉它（cancelled），但那可能是十四天後；
 * 這段期間賣家看著一個開不了賣的池，該早點知道是基礎設施的問題。
 */
async function checkStuckCommitted(): Promise<CheckResult> {
  const rows = await sql<{ id: string }[]>`
    select id from pools
     where status = 'committed' and opened_at is null
       and created_at < now() - interval '24 hours'
     limit 20
  `
  return {
    findings: finding('pool-stuck-committed', 'medium', rows,
      '有池建立超過 24 小時還開不了賣 —— 十之八九是 drand 取不到'
      + '（開賣要等它的未來輪次）。看 log 裡 [pools] 的開賣失敗訊息；'
      + 'drand 長時間不通的話所有新池都會卡住。')
  }
}

/** 退過款的卡還掛在出貨佇列裡 —— F-4 的殭屍單。後台的人照著佇列按會出事 */
async function checkZombieShipments(): Promise<CheckResult> {
  const rows = await sql<{ id: string }[]>`
    select distinct sh.id from shipments sh
     join prizes pz on pz.id = any(sh.prize_ids)
     where sh.status = 'requested' and pz.status in ('refunded', 'recycled')
     limit 20
  `
  return {
    findings: finding('zombie-shipment', 'medium', rows,
      '出貨佇列裡有單子，上面的卡已經退款或回收了。後台照佇列出貨'
      + '不會復活那些卡（有狀態守衛），但佇列本身在說謊 —— '
      + '把這幾張單標掉，不然客服會一直看到不存在的待辦。')
  }
}

/**
 * 唯一索引蓋不到的卡：有鑑定編號、沒有 grader。
 * (null, cert) 在 unique(grader, cert_no) 眼中永遠不相等 ——
 * 這些卡可以被登記第二次，是一卡多賣防線上的洞。
 */
async function checkUnprotectedCerts(): Promise<CheckResult> {
  const rows = await sql<{ id: string }[]>`
    select id from prizes
     where cert_no is not null and grader is null
     limit 20
  `
  return {
    findings: finding('cert-unprotected', 'low', rows,
      '有卡片有鑑定編號但沒有鑑定公司（grader 是 null）。'
      + '唯一索引對 null 不生效，這些編號可以被重複登記。'
      + '查 card jsonb 補上 grader，或確認它們為什麼會漏。')
  }
}

/* ---------------- 執行 ---------------- */

const CHECKS: [string, () => Promise<CheckResult>][] = [
  ['ledger-drift', checkLedgerDrift],
  ['negative-balance', checkNegativeBalance],
  ['settlement-prize-desync', checkSettlementPrizeSync],
  ['listing-prize-desync', checkListingPrizeSync],
  ['stuck-in-pool', checkStuckPledges],
  ['settlement-sweep-stalled', checkSweepStalled],
  ['escrow-sweep-stalled', checkEscrowStalled],
  ['pool-stuck-committed', checkStuckCommitted],
  ['zombie-shipment', checkZombieShipments],
  ['cert-unprotected', checkUnprotectedCerts]
]

export interface MonitorReport {
  at: number
  /** 跑了哪些檢查 —— 全綠時它證明「有檢查過」而不是「沒檢查」 */
  checked: string[]
  findings: Finding[]
  /** 檢查本身掛掉的（例如查詢逾時）。檢測壞了也要看得見，不能靜默 */
  errors: { check: string; error: string }[]
}

export async function runMonitor(): Promise<MonitorReport> {
  const report: MonitorReport = { at: Date.now(), checked: [], findings: [], errors: [] }
  for (const [name, fn] of CHECKS) {
    try {
      const r = await fn()
      report.checked.push(name)
      report.findings.push(...r.findings)
    } catch (e) {
      /* 單一檢查壞掉不能擋住其他檢查 —— 而且它自己也是一個發現 */
      report.errors.push({ check: name, error: (e as Error).message })
    }
  }
  return report
}

const SEV_TEXT: Record<Severity, string> = {
  critical: '嚴重', high: '高', medium: '中', low: '低'
}

/**
 * 把發現變成管理員的「修復任務」通知。
 *
 * refId 帶**日期桶**：同一個問題持續存在時，每天再提醒一次，
 * 但同一天內排程跑幾十輪只發一則。這跟寄存提醒的 refId 刻意相反
 * （那邊綁卡片、永遠只發一次）——寄存到期是「知道了就好」的事實，
 * 系統壞掉是「還沒修就要一直吵」的狀態。兩種語意，兩種冪等。
 */
export async function alertFindings(report: MonitorReport): Promise<number> {
  const admins = await sql<{ id: string }[]>`select id from users where role = 'admin'`
  if (!admins.length) return 0
  const day = new Date(report.at).toISOString().slice(0, 10)
  let sent = 0
  const items = [
    ...report.findings,
    /* 檢查自己掛掉也是要修的事 —— 檢測失明比單一問題更危險 */
    ...report.errors.map<Finding>(e => ({
      check: `check-error:${e.check}`, severity: 'high', count: 1,
      message: `檢測「${e.check}」本身執行失敗：${e.error}。檢測失明期間別的問題不會被發現，先修這個。`,
      sample: []
    }))
  ]
  for (const f of items) {
    for (const a of admins) {
      await notify({
        userId: a.id, kind: 'system',
        title: `系統檢測（${SEV_TEXT[f.severity] ?? f.severity}）：${f.check}`,
        body: `${f.message}${f.count > 1 ? `（共 ${f.count} 筆）` : ''}`
          + (f.sample.length ? `\n樣本：${f.sample.join('、')}` : ''),
        link: '/admin/overview',
        refId: `monitor:${f.check}:${day}`
      })
      sent++
    }
  }
  return sent
}

/** 排程用的一站式包裝：跑 → 有事就通知。永不 throw（呼叫端在 setInterval 裡）。 */
export async function monitorSweep(): Promise<MonitorReport | null> {
  try {
    const report = await runMonitor()
    if (report.findings.length || report.errors.length) await alertFindings(report)
    return report
  } catch (e) {
    console.error('[monitor] 整輪失敗:', (e as Error).message)
    return null
  }
}
