/**
 * 卡片上傳入庫：把手上的實體卡登記進自己的卡冊。
 *
 * 這是卡冊優先（docs/inventory-first-plan.md）缺的最後一個入口 ——
 * 在此之前 in_book 的卡只有兩個來源：接管通過、池結束解押。
 * 賣家手上的實體卡在被抽中之前於系統裡**不存在**，也就沒辦法
 * 「先進卡冊、再從卡冊挑進池」。這支只做登記：不開池、不上架，
 * 卡進來就是 in_book，之後要進池走建池表單（那邊會重用這一列），
 * 要上架走市場（in_book 走需寄送）。
 *
 * **不限賣家。** 一般玩家也可能想登記收藏（站外買的卡、接管前先
 * 建檔）；賣家身分是「開池」的門檻，不是「擁有卡」的門檻。
 *
 * 驗證邏輯與建池押記（routes/pools.ts）**同一套**：
 * 正規化（upper(btrim)/nullif）、PSA 分流（verifyCert 的四種結果）、
 * 唯一性靠 prizes_cert_alive（unique(grader, cert_no)）。共用件在
 * src/card-cert.ts；分流的形狀刻意跟建池那段逐條對齊，改其中一邊
 * 時要看另一邊。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sql, Rollback } from '../db.js'
import { requireAuth } from '../auth.js'
import { verifyCert, enforceVerification } from '../psa.js'
import { cardNumbersAgree, REF_PRICE_MAX } from '../card-cert.js'
import { STASH_DAYS } from '../pools-service.js'

export const cardbook = new Hono()
cardbook.use('*', requireAuth)

/* 欄位形狀對齊建池的 PrizeIn.card（routes/pools.ts），少了池才需要的
   東西（id、tier、buyback）。長度上限都是荒謬值防線，不是規則。 */
const CardIn = z.object({
  name: z.string().min(1).max(120),
  setCode: z.string().min(1).max(40),
  cardNo: z.string().min(1).max(40),
  artId: z.string().max(80).nullable().optional(),
  language: z.string().max(16).nullable().optional(),
  grader: z.string().max(20).nullable().optional(),
  grade: z.union([z.number(), z.string().max(20)]).nullable().optional(),
  certNo: z.string().max(40).nullable().optional(),
  variantId: z.string().max(120).nullable().optional(),
  refPrice: z.number().int().nonnegative()
    .max(REF_PRICE_MAX, `參考價不能超過 ${REF_PRICE_MAX.toLocaleString('zh-TW')}`)
    .nullable().optional()
})
const UploadBody = z.object({
  card: CardIn,
  /* 跟建池的 certConfirmed 同一個意思：PSA 查到的 CardNumber 跟填的
     卡號對不上時，使用者看過 PSA 的卡片資訊後確認「就是同一張」。
     對得上、或沒有 certNo 時這個旗標會被忽略。 */
  certConfirmed: z.boolean().optional()
})

/** 給「卡已經在你卡冊裡」的 409 用的狀態白話。狀態機的字不該原樣丟給使用者。 */
const STATUS_LABEL: Record<string, string> = {
  in_book: '閒置在卡冊，可以直接拿去開池或上架',
  in_pool: '押在某個池裡',
  stashed: '在保管庫',
  listed: '掛在市場上',
  ship_requested: '出貨申請中',
  shipped: '已出貨',
  recycled: '已回收',
  refunded: '已退款'
}

cardbook.post('/upload', async c => {
  const me = c.get('userId')
  const parsed = UploadBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const msg = parsed.error.issues.find(i => i.code === 'too_big')?.message ?? '卡片資料不完整（至少要卡名、系列、卡號）'
    return c.json({ error: 'BAD_REQUEST', message: msg }, 400)
  }
  const { card, certConfirmed } = parsed.data

  /* 正規化跟 021 的回填、抽卡寫入（pools-service.ts）、建池押記同一套：
     upper(btrim) / nullif。索引照正規化的，card jsonb 裡的原值不動 ——
     顯示要照使用者填的。 */
  const certRaw = typeof card.certNo === 'string' ? card.certNo.trim() : ''
  const graderRaw = typeof card.grader === 'string' ? card.grader.trim() : ''
  const normGrader = graderRaw ? graderRaw.toUpperCase() : null

  /* 有編號就一定要有鑑定公司。(null, cert) 在 unique(grader, cert_no)
     眼中永遠不相等 —— 收下這種列等於親手在一卡多賣的防線上開洞，
     而且 monitor 的 cert-unprotected 檢查會立刻把它列成問題。 */
  if (certRaw && !normGrader) {
    return c.json({
      error: 'GRADER_REQUIRED',
      message: '有鑑定編號就要填鑑定公司（PSA、BGS…）—— 編號只有配上發證單位才是一張卡的身分。'
    }, 400)
  }

  /* ── PSA 查證：分流照建池那段（routes/pools.ts 的建池迴圈）──────
     在交易之外先查：查證是網路 I/O，擺進交易會讓 DB 連線被 PSA 的
     往返時間佔著。
       invalid_format / not_found        → 擋（假編號或格式錯）
       api_unavailable / not_configured  → 不硬擋，標 pending；
                                            PSA_VERIFY_ENFORCE=1 才擋
       查到但 CardNumber 對不上           → 要使用者確認（certConfirmed） */
  let psaStatus: 'verified' | 'pending' | null = null
  if (certRaw) {
    const v = await verifyCert(sql, certRaw)
    if (v.ok) {
      if (!cardNumbersAgree(v.cert.cardNumber, card.cardNo) && !certConfirmed) {
        return c.json({
          error: 'CERT_MISMATCH',
          message: 'PSA 查到的卡片跟你填的卡號對不上（PSA 是英文、目錄是日文，卡名無法直接比對）。'
            + '請確認是不是同一張卡，確認後再送出一次。',
          mismatches: [{ certNo: certRaw, psaCardNumber: v.cert.cardNumber, psaSubject: v.cert.subject }]
        }, 409)
      }
      psaStatus = 'verified'
    } else if (v.reason === 'invalid_format' || v.reason === 'not_found') {
      return c.json({
        error: v.reason === 'not_found' ? 'CERT_NOT_FOUND' : 'CERT_INVALID',
        message: v.reason === 'not_found'
          ? `鑑定編號 ${certRaw} 在 PSA 查無此卡，不能登記。請確認編號是否正確。`
          : `鑑定編號 ${certRaw} 的格式不正確，PSA 無法辨識。請確認編號。`
      }, 400)
    } else {
      if (enforceVerification()) {
        return c.json({
          error: 'VERIFY_REQUIRED',
          message: `目前無法向 PSA 查證鑑定編號 ${certRaw}，而平台已開啟強制驗證，暫時無法登記這張卡。請稍後再試。`
        }, 503)
      }
      psaStatus = 'pending'
    }
  }
  /* 沒有編號（裸卡）**照收**。先前拍板的「裸卡先緩」指的是市場上架
     （對買家宣稱一張無法驗證的卡），登記進自己的卡冊沒有欺騙任何人。
     但要知道代價：唯一索引的述詞是 `where cert_no is not null`，
     裸卡沒有唯一性防線 —— 同一張實體裸卡可以被登記成好幾列，
     擋住它重複「使用」的只有結構保證（一列一個 status，不可能同時
     in_pool 兩次），擋不住重複「存在」。 */

  const now = Date.now()
  const id = 'pz-up-' + randomBytes(6).toString('hex')
  /* refPrice / variantId 沒填就明確存 null（跟建池同一條理由：讓
     「有這個鍵但值是 null」與「沒有這個鍵」讀起來一致）。
     psaStatus 記進 card jsonb，跟池裡獎品的擺法一致 —— 前端讀同一個位置。 */
  const cardJson = {
    ...card,
    artId: card.artId ?? null,
    language: card.language ?? null,
    grader: card.grader ?? null,
    grade: card.grade ?? null,
    certNo: card.certNo ?? null,
    refPrice: card.refPrice ?? null,
    variantId: card.variantId ?? null,
    psaStatus
  }

  try {
    const prize = await sql.begin(async tx => {
      if (certRaw) {
        /* 先查有沒有人（包括自己）已經登記這個編號，分開講清楚 ——
           讓唯一索引去撞只有一句籠統的 409 好講。FOR UPDATE 跟建池
           押記、接管搶同一把鎖；真正的併發防線仍然是索引本身
           （兩個請求同時查到「沒有」時，第二個 insert 會撞 23505，
           由下面的 catch 接住）。 */
        const [taken] = await tx`
          select id, user_id, status from prizes
           where grader is not distinct from ${normGrader}::text and cert_no = ${certRaw}
           for update
        `
        if (taken && String(taken.user_id) === me) {
          const label = STATUS_LABEL[String(taken.status)] ?? String(taken.status)
          throw new Rollback(409, {
            error: 'ALREADY_IN_BOOK',
            message: `鑑定編號 ${certRaw} 已經在你的卡冊裡了（目前${label}），不用再登記一次。`,
            prizeId: String(taken.id), status: String(taken.status)
          })
        }
        if (taken) {
          throw new Rollback(409, {
            error: 'CERT_ALREADY_LISTED',
            message: `鑑定編號 ${certRaw} 已經登記在別人名下 —— 同一張實體卡不能重複登記。`
              + '如果這張卡是你在站外買到的，請到客服中心（/support）申請接管，'
              + '附上時間戳照片證明卡在你手上。'
          })
        }
      }
      /* user_id = custodian_id = 自己：登記的前提就是「卡在我手上」。
         pool_id / tier 都是 null —— 這張卡還沒進過任何池，賞別還沒發生
         （見 migration 027）。won_at / acquired_at 這裡就是「進卡冊」的
         時間；stash_expires_at 給 now + 90 天是無害的：寄存到期的提醒
         （sweepStashExpiry）只掃 stashed，in_book 不會被掃到，
         但欄位是 NOT NULL、而這張卡日後被抽走時本來就會被覆寫。 */
      const [row] = await tx`
        insert into prizes (id, user_id, pool_id, card, tier, status,
                            won_at, acquired_at, stash_expires_at,
                            grader, cert_no, custodian_id, origin)
        values (${id}, ${me}, null, ${cardJson as never}, null, 'in_book',
                ${now}, ${now}, ${now + STASH_DAYS * 86_400_000},
                ${normGrader}, ${certRaw || null}, ${me}, 'upload')
        returning *
      `
      return row!
    })
    return c.json({
      prize: {
        id: String(prize.id), card: prize.card, tier: prize.tier as string | null,
        status: String(prize.status), grader: prize.grader as string | null,
        certNo: prize.cert_no as string | null,
        custodianId: String(prize.custodian_id), psaStatus
      }
    })
  } catch (e) {
    if (e instanceof Rollback) return c.json(e.body, e.status as 409)
    /* 兩個請求同時上傳同一個編號：都通過上面的 select，第二個 insert
       撞 prizes_cert_alive。這不是伺服器故障，照實講。 */
    const pg = e as { code?: string; constraint_name?: string }
    if (pg.code === '23505' && pg.constraint_name === 'prizes_cert_alive') {
      return c.json({
        error: 'CERT_ALREADY_LISTED',
        message: '這個鑑定編號剛剛被登記了 —— 同一張實體卡不能重複登記。'
          + '如果這張卡在你手上，請到客服中心（/support）申請接管。'
      }, 409)
    }
    console.error('[cardbook] 上傳失敗:', e)
    return c.json({ error: 'UPLOAD_FAILED', message: '登記失敗，這是我們這邊的問題，請稍後再試一次' }, 502)
  }
})
