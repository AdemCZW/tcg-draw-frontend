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
 * 正規化（upper(btrim)/nullif），唯一性靠 prizes_cert_alive
 * （unique(grader, cert_no)）。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sql, Rollback } from '../db.js'
import { requireAuth } from '../auth.js'
import { bumpAttempt, checkLimit, clientIp } from '../rate-limit.js'
import { REF_PRICE_MAX } from '../card-cert.js'
import { STASH_DAYS } from '../pools-service.js'
import { configured as r2configured, objectState } from '../r2.js'

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
  frontFileId: z.string().regex(/^f-[0-9a-f]{12}$/, '卡片正面圖片必須先上傳').nullable().optional(),
  refPrice: z.number().int().nonnegative()
    .max(REF_PRICE_MAX, `參考價不能超過 ${REF_PRICE_MAX.toLocaleString('zh-TW')}`)
    .nullable().optional()
})
const UploadBody = z.object({
  card: CardIn
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

  /* ── 速率限制（A-2）────────────────────────────────────────
     帶編號的登記是平台內對一張實體卡的**所有權宣告**：搶下一個編號之後，
     真正的持有人就只剩「申請接管」這條要人工審的路。所以這支不是
     普通的寫入端點，爆量寫進來的代價是 DB 加上一堆人工客服。

     **兩個獨立的桶**，都不共用登入失敗的 ip:（M-1 的教訓：共用計數的話，
     同一個網路裡有人登入打錯幾十次，隔壁的人連卡都登記不了）：
       card-upload-user:  這個帳號登記了幾張
       card-upload-ip:    這台機器（含換帳號）登記了幾張

     **不做 cert-claim:<grader>:<certNo> 的桶。** 同一個編號本來就只能
     首次成功一次（prizes_cert_alive 唯一索引），限制「重複失敗」擋不住
     「第一次搶註」—— 搶註是所有權驗證與人工審核的問題，
     加一個 per-cert 的計數只會讓人以為它被修好了。 */
  const limitKeys = [`card-upload-user:${me}`, `card-upload-ip:${clientIp(c)}`]
  const limit = await checkLimit(limitKeys)
  if (limit.blocked) {
    /* 訊息刻意不提「你已經登記了幾張」「上限是幾張」：那是在告訴人
       怎麼貼著上限走，對正常使用者也沒有用。只講「等多久」。
       429 一定帶 Retry-After —— 沒有它，自動重試的客戶端只能亂猜間隔，
       而猜錯的那一方會一直撞牆（同這支 503 那條的理由）。 */
    return c.json(
      { error: 'TOO_MANY_UPLOADS',
        message: `短時間內登記的卡片太多了，請於 ${Math.max(1, Math.ceil(limit.retryAfter / 60))} 分鐘後再登記。`
          + '（如果你正在整理一整批收藏，分幾次登記就好，已經登記進去的不會不見。）' },
      429, { 'retry-after': String(limit.retryAfter) }
    )
  }

  const parsed = UploadBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const msg = parsed.error.issues.find(i => i.code === 'too_big')?.message ?? '卡片資料不完整（至少要卡名、系列、卡號）'
    return c.json({ error: 'BAD_REQUEST', message: msg }, 400)
  }
  const { card } = parsed.data

  /* ── 目錄外的卡一定要有正面照 ──────────────────────────────
     artId 是「這張卡在卡片目錄裡的身分」：有它，卡面圖從目錄推導得出來。
     沒有它（使用者手填卡名／系列／卡號的那條路），正面照就是這張卡
     **唯一**可辨識的證據 —— 少了它，卡冊裡是一張沒有人能確認是什麼的卡，
     而它照樣進得了開池與交易流程，最後看到空白卡面的是買家。

     前端已經把送出鈕鎖住了（CardUploadPage.vue 的 canSubmit），
     但那只是體驗；規則要在後端才算數 —— 直接打這支 API 的呼叫端
     不會經過那顆按鈕。artId 是空白字串也算沒有（送空字串跟沒送是同一件事）。 */
  const artIdRaw = typeof card.artId === 'string' ? card.artId.trim() : ''
  if (!artIdRaw && !card.frontFileId) {
    return c.json({
      error: 'CARD_IMAGE_REQUIRED',
      message: '目錄裡沒有這張卡的話，請先上傳一張卡片正面照片再登記 —— '
        + '那是這張卡在卡冊裡唯一能被認出來的依據。'
    }, 400)
  }

  /* 在真正動手之前先計數，**成功也算**（同註冊那條的理由，M-1）：
     這個桶計的是「這個帳號／這台機器登記了幾張」，只在失敗時記的話，
     一路成功的爆量寫入永遠觸發不了限制。
     代價講明：後面那個 503（問不到 R2）也已經吃掉一次額度 ——
     那是我們這邊的問題卻算在使用者頭上。上限 40 張/15 分鐘之下這是
     可以接受的；如果哪天要退還額度，要的是「單獨扣掉一次」的能力，
     不是 clearFails（那會把整個桶清成 0，等於送人一次繞過限制的機會）。
     格式不合的請求（上面那些 400）**刻意不計數**：它們連一次 DB 寫入
     都沒發生，計進去只會讓打錯欄位的人被自己的錯誤鎖住。 */
  await bumpAttempt(limitKeys)

  let frontImage: string | null = null
  if (card.frontFileId) {
    const [front] = await sql`select owner_id, purpose, key from files where id = ${card.frontFileId}`
    if (!front || front.owner_id !== me || front.purpose !== 'card-front') {
      return c.json({ error: 'BAD_CARD_IMAGE', message: '請上傳自己的卡片正面圖片後再登記' }, 400)
    }

    /* files 有一列**不等於** R2 上真的有那個物件：presign 一成功就先寫 files，
       位元組是瀏覽器另外 PUT 上去的。PUT 失敗（斷線、逾時、使用者取消）
       那一列照樣留著，拿那個 id 來登記，卡就會帶著一個永遠 404 的 image
       進卡冊 —— 而卡冊、開池、市場都照樣收它。

       關鍵是 objectState() 的**三態**：布林版本（舊的 objectExists）
       把「問不到 R2」也回成 false，拿它當關卡的話一次網路抖動就會把
       一張傳好的圖擋成「你的圖沒傳完」，比不檢查更糟。
       所以只有 R2 明確說 404（missing）才拒絕呼叫端；
       問不到（unavailable）是我們這邊的狀況，回可重試的 503，
       不要求使用者重傳他明明已經傳好的圖。 */
    const state = r2configured() ? await objectState(front.key as string) : 'unavailable'
    if (state === 'missing') {
      return c.json({
        error: 'BAD_CARD_IMAGE',
        message: '這張正面照沒有上傳完成（圖片檔本身不在），請重新選一次照片、等上傳跑完再登記。'
      }, 400)
    }
    if (state === 'unavailable') {
      /* 明確告訴呼叫端「等一下再來」—— 503 沒有 Retry-After 的話，
         自動重試的客戶端只能亂猜間隔。 */
      c.header('retry-after', '5')
      return c.json({
        error: 'IMAGE_CHECK_UNAVAILABLE',
        message: '目前無法確認你的照片，這是我們這邊的問題 —— 你的卡片資料還沒有送出，請稍後再試一次。'
      }, 503)
    }

    frontImage = `/v1/files/${card.frontFileId}`
  }

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

  /* 沒有編號（裸卡）**照收**。先前拍板的「裸卡先緩」指的是市場上架
     （對買家宣稱一張無法驗證的卡），登記進自己的卡冊沒有欺騙任何人。
     但要知道代價：唯一索引的述詞是 `where cert_no is not null`，
     裸卡沒有唯一性防線 —— 同一張實體裸卡可以被登記成好幾列，
     擋住它重複「使用」的只有結構保證（一列一個 status，不可能同時
     in_pool 兩次），擋不住重複「存在」。 */

  const now = Date.now()
  const id = 'pz-up-' + randomBytes(6).toString('hex')
  /* refPrice / variantId 沒填就明確存 null（跟建池同一條理由：讓
    「有這個鍵但值是 null」與「沒有這個鍵」讀起來一致）。 */
  const cardJson = {
    ...card,
    /* image 明確補一個空字串。CardIn 沒有這一欄（登記進來的卡沒有實拍圖，
       卡圖從 artId 推導），但 shared/domain.ts 的 CardItem 宣告的是
       `image: string` —— 少了這個鍵，前端拿到的是 undefined，
       卡冊那顆 CardArt 每畫一次就吐一行 [Vue warn]（型別檢查失敗）。
       池裡的獎品一直都帶著 image: ''，這裡對齊它。 */
    image: frontImage ?? '',
    artId: card.artId ?? null,
    language: card.language ?? null,
    grader: card.grader ?? null,
    grade: card.grade ?? null,
    certNo: card.certNo ?? null,
    refPrice: card.refPrice ?? null,
    variantId: card.variantId ?? null
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
        custodianId: String(prize.custodian_id)
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
