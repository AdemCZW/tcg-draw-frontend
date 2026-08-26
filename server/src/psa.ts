/**
 * PSA 鑑定編號查證（後端）。
 *
 * ── 為什麼整段都在後端 ────────────────────────────────────────────
 * PSA 的 bearer token 是機密（env.PSA_API_TOKEN），一旦進前端 bundle 任何人
 * 都撈得走。所以查證只有這一條路：前端把 cert 編號送來，後端持 token 去查，
 * 只把「乾淨的結果」回出去。token 的值不出現在任何回應、log 或錯誤訊息裡。
 *
 * ── 目前的現實：API 回 403 待核准 ─────────────────────────────────
 * PSA 在 2026 年中把免費層改成需核准，帳號層級待核准時六個端點全部回
 *   403 {"Message":"Access to this API is limited to approved customers."}
 * 這**不是我們的 bug、也不是 token 壞掉**（詳見 docs/psa-api-access.md）。
 * 所以這支模組必須能在「API 還不通」時優雅降級：403 一律當成
 * api_unavailable（我方問題，記 log，不對賣家說是他的錯），開池端據此
 * 把卡標成 pending 而不是硬擋。核准之後同一段程式不改一行就會開始回 ok。
 *
 * ── PSA 的錯誤語意（重要，PSA 文件明載） ──────────────────────────
 * HTTP 200 **不代表有資料**，要看 body：
 *   {IsValidRequest:false, ServerMessage:"Invalid CertNo"}      編號格式不對
 *   {IsValidRequest:true,  ServerMessage:"No data found"}       格式對但查無此卡（假編號）
 *   {IsValidRequest:true,  ServerMessage:"Request successful", PSACert:{...}}  查到了
 * 500 **通常是憑證無效**，不是「PSA 掛了」—— 要當成我方設定問題記錄，
 * 絕不能對賣家說「PSA 服務異常」。
 */
import { sql } from './db.js'
import type { Db } from './db.js'
import { env } from './env.js'

/** 查證成功時回給呼叫端的乾淨卡片資料（PublicPSACert 的關鍵欄位子集） */
export interface PsaCert {
  certNumber: string
  subject: string | null
  brand: string | null
  year: string | null
  /** 開池驗證時就是拿這一欄跟賣家挑的卡對（PSA 是英文、我們目錄是日文，卡名無法字串相等） */
  cardNumber: string | null
  variety: string | null
  cardGrade: string | null
  gradeDescription: string | null
  totalPopulation: number | null
  populationHigher: number | null
  itemStatus: string | null
}

/**
 * 查證結果。**刻意做成 discriminated union**：呼叫端必須先看 ok 才拿得到
 * cert，拿不到 cert 時一定要處理 reason —— 讓「忘了處理查無此卡」變成
 * 編譯錯誤而不是上線後才發現的漏洞。
 *
 * reason 的四種語意（開池端據此決定擋或放）：
 *   invalid_format   編號格式不對          → 擋
 *   not_found        格式對但查無此卡（假） → 擋
 *   api_unavailable  403/500/429/網路錯    → 不硬擋（標 pending），這是我方/PSA 的問題
 *   not_configured   沒設 token            → 不硬擋（標 pending）
 */
export type VerifyResult =
  | { ok: true; cert: PsaCert; cached: boolean }
  | { ok: false; reason: 'invalid_format' | 'not_found' | 'api_unavailable' | 'not_configured' }

const BASE = env.PSA_API_BASE.replace(/\/$/, '')

// ── PSA 回應的形狀（只宣告我們讀的欄位） ──────────────────────────
interface PsaRawCert {
  CertNumber?: string
  Subject?: string
  Brand?: string
  Year?: string
  CardNumber?: string
  Variety?: string
  CardGrade?: string
  GradeDescription?: string
  TotalPopulation?: number
  PopulationHigher?: number
  ItemStatus?: string
}
interface PsaResponse {
  IsValidRequest?: boolean
  ServerMessage?: string
  PSACert?: PsaRawCert
}

/** 一次 HTTP 交換的結果，抽象掉「真的打 PSA」與「stub」的差別 */
interface Exchange {
  status: number
  body: PsaResponse | null
}

/**
 * stub 分派：測試專用，PSA_STUB=1 時生效。
 *
 * 為什麼需要它：不能真的打正式環境的 PSA（會吃掉 100/天配額，而且現在全 403）。
 * 用 cert 編號的前綴選一條分支，讓 smoke 可以在一台伺服器、不動網路的情況下
 * 把每一種回應都走一遍。前綴一律大寫比對，真實編號是純數字不會誤中。
 *
 *   STUB-403 / STUB-500 / STUB-429   → 對應 HTTP 狀態（走 api_unavailable）
 *   STUB-INVALID                     → 200 {IsValidRequest:false}（invalid_format）
 *   STUB-NOTFOUND                    → 200 {IsValidRequest:true, "No data found"}（not_found）
 *   STUB-NOTCONFIG                   → 模擬「沒設 token」（not_configured），
 *                                      不必真的把 token 拿掉就能測降級路徑
 *   STUB-OK[-<卡號>]                 → 200 查到，PSACert.CardNumber = <卡號>（預設 025）
 *   其餘                             → 200 查無此卡（安全預設，不會意外放行）
 */
function stubExchange(cert: string): Exchange | { notConfigured: true } {
  const up = cert.toUpperCase()
  if (up.startsWith('STUB-NOTCONFIG')) return { notConfigured: true }
  if (up.startsWith('STUB-403')) return { status: 403, body: { ServerMessage: 'Access to this API is limited to approved customers.' } as PsaResponse }
  if (up.startsWith('STUB-500')) return { status: 500, body: null }
  if (up.startsWith('STUB-429')) return { status: 429, body: null }
  if (up.startsWith('STUB-INVALID')) return { status: 200, body: { IsValidRequest: false, ServerMessage: 'Invalid CertNo' } }
  if (up.startsWith('STUB-NOTFOUND')) return { status: 200, body: { IsValidRequest: true, ServerMessage: 'No data found' } }
  if (up.startsWith('STUB-OK')) {
    // STUB-OK-<卡號> 讓測試指定 PSA 回的 CardNumber，用來驗「對不上要賣家確認」那條
    const cardNo = cert.split('-')[2] ?? '025'
    return {
      status: 200,
      body: {
        IsValidRequest: true, ServerMessage: 'Request successful',
        PSACert: {
          CertNumber: cert, Subject: 'PIKACHU', Brand: 'POKEMON JAPANESE SV',
          Year: '2024', CardNumber: cardNo, Variety: 'MASTER BALL FOIL',
          CardGrade: 'GEM MT 10', GradeDescription: 'GEM MINT',
          TotalPopulation: 1234, PopulationHigher: 0, ItemStatus: 'Valid'
        }
      }
    }
  }
  return { status: 200, body: { IsValidRequest: true, ServerMessage: 'No data found' } }
}

/** 真的打 PSA。回網路/解析錯誤時給 status 0，讓上層當 api_unavailable */
async function realExchange(cert: string): Promise<Exchange> {
  try {
    const res = await fetch(
      `${BASE}/cert/GetByCertNumber/${encodeURIComponent(cert)}`,
      // header 名稱與大小寫照 PSA 文件：authorization: bearer <token>
      { headers: { authorization: `bearer ${env.PSA_API_TOKEN}` } }
    )
    let body: PsaResponse | null = null
    try { body = (await res.json()) as PsaResponse } catch { body = null }
    return { status: res.status, body }
  } catch (e) {
    // DNS/連線/逾時。**不要把它當成賣家的錯** —— 是我方到 PSA 的通道問題
    console.warn(`[psa] cert 查證網路錯誤（我方問題，非賣家的錯）：${e instanceof Error ? e.message : e}`)
    return { status: 0, body: null }
  }
}

function toCert(cert: string, raw: PsaRawCert): PsaCert {
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  const str = (x: unknown): string | null => (typeof x === 'string' && x.length ? x : null)
  return {
    certNumber: cert,
    subject: str(raw.Subject), brand: str(raw.Brand), year: str(raw.Year),
    cardNumber: str(raw.CardNumber), variety: str(raw.Variety),
    cardGrade: str(raw.CardGrade), gradeDescription: str(raw.GradeDescription),
    totalPopulation: num(raw.TotalPopulation), populationHigher: num(raw.PopulationHigher),
    itemStatus: str(raw.ItemStatus)
  }
}

/** 快取讀取：命中就代表這個編號查證成功過（只有成功才寫入，見 migration 020） */
async function fromCache(db: Db, cert: string): Promise<PsaCert | null> {
  const [r] = await db<{ raw: PsaRawCert }[]>`select raw from psa_certs where cert_number = ${cert}`
  return r ? toCert(cert, r.raw) : null
}

/** 快取寫入。ON CONFLICT DO NOTHING —— 併發下兩個請求同時查同一張卡不會互相炸 */
async function toCacheRow(db: Db, cert: PsaCert, raw: PsaRawCert): Promise<void> {
  await db`
    insert into psa_certs (
      cert_number, subject, brand, year, card_number, variety,
      card_grade, grade_description, total_population, population_higher,
      item_status, raw, checked_at
    ) values (
      ${cert.certNumber}, ${cert.subject}, ${cert.brand}, ${cert.year}, ${cert.cardNumber}, ${cert.variety},
      ${cert.cardGrade}, ${cert.gradeDescription}, ${cert.totalPopulation}, ${cert.populationHigher},
      ${cert.itemStatus}, ${db.json(raw as never)}, ${Date.now()}
    )
    on conflict (cert_number) do nothing
  `
}

const STUB = process.env.PSA_STUB === '1'

/**
 * 查證一個 cert 編號。先讀快取，沒有再打 PSA（或 stub），成功就寫回快取。
 *
 * db 收 Db（外層連線或交易連線都行）。開池端**故意用外層連線、在交易之外**
 * 先查完：查證是網路 I/O，擺進交易會讓 DB 連線被 PSA 的往返時間佔著。而且
 * 「向 PSA 查到這張卡」是一個獨立於「池有沒有建成」的事實 —— 就算後面因為
 * 別的原因建池失敗，這次查證的結果也值得留在快取裡（省下一次配額），
 * 所以快取不該跟著建池交易回滾。
 */
export async function verifyCert(db: Db, certNumberRaw: string): Promise<VerifyResult> {
  const cert = certNumberRaw.trim()
  // 空字串在到這裡之前就該被 zod 擋掉，但多一道防線：空的不是「格式錯」是「沒填」
  if (!cert) return { ok: false, reason: 'invalid_format' }

  const cached = await fromCache(db, cert)
  if (cached) return { ok: true, cert: cached, cached: true }

  // 交換：stub 或真打
  let ex: Exchange
  if (STUB) {
    const s = stubExchange(cert)
    if ('notConfigured' in s) return { ok: false, reason: 'not_configured' }
    ex = s
  } else {
    // 沒設 token 就不打 —— 這是「還沒接好」不是「查無此卡」，不能拿去擋賣家
    if (!env.PSA_API_TOKEN) return { ok: false, reason: 'not_configured' }
    ex = await realExchange(cert)
  }

  // 403：帳號層級待核准。**記 log、當我方問題**，不對賣家說是他的錯
  if (ex.status === 403) {
    console.warn('[psa] 403 Access limited to approved customers —— 帳號待核准，非賣家的錯，卡片將標為未驗證')
    return { ok: false, reason: 'api_unavailable' }
  }
  // 500：PSA 文件說通常是憑證無效。**當我方設定問題**，不是「PSA 掛了」
  if (ex.status === 500) {
    console.error('[psa] 500 —— 通常代表我方憑證無效（我方設定問題，非賣家的錯）')
    return { ok: false, reason: 'api_unavailable' }
  }
  // 401/429/0（網路）/其餘非 200：一律當暫時不可用，降級不硬擋
  if (ex.status !== 200) {
    console.warn(`[psa] 非預期狀態 ${ex.status}（我方問題，卡片將標為未驗證）`)
    return { ok: false, reason: 'api_unavailable' }
  }

  // 到這裡是 HTTP 200 —— 但 200 不代表有資料，要看 body
  const body = ex.body
  if (!body) return { ok: false, reason: 'api_unavailable' } // 200 但 body 解析不出來，當我方問題

  // IsValidRequest:false → 編號格式不對
  if (body.IsValidRequest === false) return { ok: false, reason: 'invalid_format' }

  const msg = (body.ServerMessage ?? '').toLowerCase()
  // 有 PSACert 且沒被標成查無 → 查到了
  if (body.PSACert && !msg.includes('no data')) {
    const parsed = toCert(cert, body.PSACert)
    await toCacheRow(db, parsed, body.PSACert)
    return { ok: true, cert: parsed, cached: false }
  }
  // IsValidRequest:true 但 "No data found"（或沒有 PSACert）→ 查無此卡（假編號）
  return { ok: false, reason: 'not_found' }
}

/**
 * 開池端要不要因為「暫時無法驗證」而硬擋。
 *
 * 預設 false（不硬擋）：API 現在全 403，硬擋等於完全開不了鑑定卡的池。
 * 明天 PSA 核准、API 開始回 ok 之後，把環境變數 PSA_VERIFY_ENFORCE 設成 1
 * 就會從「暫不驗證、標 pending」切成「驗不過就開不了池」——**不用改任何程式碼**。
 * 這是刻意的降級開關，不是遺漏。
 */
export const enforceVerification = (): boolean => env.PSA_VERIFY_ENFORCE === '1'
