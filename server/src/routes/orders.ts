/**
 * 訂單端點。一個端點對應 escrow.ts 的一個狀態轉換。
 *
 * 每個會改狀態的端點都做三件事，順序固定：
 *   1 zod 驗證 —— TypeScript 的型別在執行期不存在，邊界一定要真的擋
 *   2 交易內重讀並鎖定 —— 不能信任讀進來時的狀態，中間可能已經被改
 *   3 用 escrow.ts 判斷這個動作合不合法 —— 規則只有一份
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { sql } from '../db.js'
import { configured as r2configured, objectExists } from '../r2.js'
import type { Tx } from '../db.js'
import { requireAuth } from '../auth.js'
import { notify } from '../notify.js'
import { lockSpender, walletOf } from '../money.js'
import { PLATFORM_ID, depositFor, save, settle, sweep, toOrder } from '../orders-service.js'
import { actionsFor, validateTracking } from '../shared/escrow.js'
import { openDisputeTicket } from '../tickets.js'
import type { Order } from '../shared/domain.js'

export const orders = new Hono()
orders.use('*', requireAuth)

const fail = (code: string, msg: string, status = 409) => ({ error: code, message: msg, status })

/**
 * GET /orders —— 我的訂單 + 錢包 + 伺服器時間。
 *
 * ── 賣家會拿到買家的收件資訊 ────────────────────────────────────────
 * 平台不經手實體卡，卡是賣家直接寄給買家的 —— 所以賣家**必須**看得到
 * 寄去哪裡，不然這條路走不通（在這之前他只看得到買家的暱稱）。
 *
 * 範圍嚴格限定，因為這是個資：
 *   只有**這筆訂單的賣家**拿得到
 *   只在訂單**還開著**（escrowed / shipped / delivered / disputed）時給 ——
 *     結案之後寄送義務已經結束，沒有理由繼續持有對方的住址
 *   只給寄件必要的幾項，不給 email
 *
 * 資料來源是 users 的預設收件欄位（006_profile.sql）。買家沒填的話會是
 * 空的 —— 那時前端要引導賣家去問，而不是讓他對著空白發呆。
 */
orders.get('/', async c => {
  const me = c.get('userId')
  const body = await sql.begin(async tx => {
    await sweep(tx, me)
    /* 收件資訊只在「我是賣家 + 這筆還開著」時才給。條件寫在 SQL 裡而不是
       撈回來再過濾 —— 過濾寫在應用層的話，任何一個忘了濾的新欄位都會
       把個資送出去。 */
    const canShip = sql`o.seller_id = ${me} and o.status in ('escrowed','shipped','delivered','disputed')`
    const rows = await tx`
      select o.*,
             case when ${canShip} then b.real_name     end as ship_name,
             case when ${canShip} then b.phone         end as ship_phone,
             case when ${canShip} then b.address_zip   end as ship_zip,
             case when ${canShip} then b.address_city  end as ship_city,
             case when ${canShip} then b.address_line1 end as ship_line1
        from orders o join users b on b.id = o.buyer_id
       where o.buyer_id = ${me} or o.seller_id = ${me}
       order by o.created_at desc
    `
    return rows.map(r => toOrder(r as Record<string, unknown>))
  })
  return c.json({ orders: body, wallet: await walletOf(me), serverTime: Date.now() })
})

const CreateBody = z.object({
  listingId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128)
})

/**
 * POST /orders —— 買下掛單。
 *
 * 兩條通道在這裡分開：庫內轉移直接過戶（沒有訂單），需寄送才建立託管訂單。
 *
 * 整段包在一個交易裡，而且掛單那筆要 FOR UPDATE。
 * 少了這個鎖，兩個人同時買同一張卡會兩邊都通過檢查、兩邊都成立。
 */
orders.post('/', async c => {
  const me = c.get('userId')
  const parsed = CreateBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json(fail('BAD_REQUEST', '參數不合法', 400), 400)
  const { listingId, idempotencyKey } = parsed.data

  const result = await sql.begin(async tx => {
    /* 重複送出：同一個人的同一把 key 只會成立一次。
       user_id 一定要一起比 —— 鍵是呼叫端自己產生的字串，只比 key 的話
       拿到別人的鍵重放一次就會讀到別人整張訂單（卡片鑑定編號、成交價、買賣雙方）。
       別人的鍵對你等於沒用過，會照常走下去，掛單早被買走時擋在 LISTING_TAKEN。 */
    const [dup] = await tx`
      select order_id from idempotency where key = ${idempotencyKey} and user_id = ${me}
    `
    if (dup) {
      const [row] = await tx`select * from orders where id = ${dup.order_id}`
      return { order: row ? toOrder(row as Record<string, unknown>) : null }
    }

    const [l] = await tx`select * from listings where id = ${listingId} for update`
    if (!l) return fail('LISTING_NOT_FOUND', '這筆掛單不存在')
    if (l.status !== 'live') return fail('LISTING_TAKEN', '這張卡剛剛被買走了')
    if (l.seller_id === me) return fail('WRONG_STATE', '不能買自己的掛單')
    /* 庫內轉移的「交付」就是把 prizes 那一列改 owner —— 沒有那一列就沒有東西可以交付。
       原本下面是 if (l.prize_id) 包住過戶，不成立時就跳過，但點數的兩筆帳
       已經記下去了：買家被扣、賣家入帳、卡片不存在。錢動了貨沒動是最壞的一種失敗，
       寧可整筆擋掉。（種子資料的 vault 掛單就沒有 prize_id，實際被買到過。） */
    if (l.delivery === 'vault' && !l.prize_id) {
      return fail('LISTING_BROKEN', '這筆掛單沒有對應的卡片，已下架，請聯絡客服')
    }

    const price = Number(l.price)
    const seller = l.seller_id as string
    const isShip = l.delivery !== 'vault'

    /* ── 保證金也要先問賣家有沒有這筆錢 ──────────────────────────────
       需寄送的訂單會把 depositFor() 算出來的保證金寫進 orders.deposit，
       而 money.ts 的 walletOf 把賣家進行中訂單的 deposit 算進 locked。
       在這之前**沒有任何一處驗過賣家付不付得出來**：餘額 0 的人照樣
       成單，available 當場變成 −5000（DEPOSIT_CAP），逾期未出貨時
       orders-service.ts 的 settle() 照扣，帳本真的變負 ——
       單執行緒、免費帳號，每個帳號可以製造一筆 5,000 點的呆帳。

       完成 count 與保證金金額要在鎖之前先算出來，因為要不要鎖賣家
       取決於這筆金額。 */
    const done = isShip
      ? await tx<{ count: string }[]>`
          select count(*)::text as count from orders where seller_id = ${seller} and status = 'completed'
        `
      : []
    const completedCount = Number(done[0]?.count ?? 0)
    const deposit = isShip ? depositFor(price, completedCount) : 0

    /* 先鎖住帳戶再算餘額。少了這一行，同一個人同時買兩張不同的卡
       會鎖到兩列不同的 listings、互不阻擋，兩邊各自讀到同一個 available
       都判定「夠」，於是花掉兩份同一筆錢（見 money.ts 的 lockSpender）。

       這裡是全站唯一一筆交易要鎖**兩個**使用者的地方（買家出貨款、
       賣家出押品），所以 money.ts 檔頭那句「每筆交易只鎖一個使用者，
       所以不會形成死結環」在這條路上不再成立。改用固定的取得順序
       （依 id 排序）維持同一個保證：所有交易都照同一個全域順序拿鎖，
       就形成不了環。不要改成「先鎖買家再鎖賣家」—— A 買 B 的卡、
       B 同時買 A 的卡，那樣兩邊互等，Postgres 會砍掉其中一筆（40P01）。 */
    for (const u of (deposit > 0 ? [me, seller].sort() : [me])) await lockSpender(tx, u)

    const w = await walletOf(me, tx)
    if (w.available < price) return fail('INSUFFICIENT_POINTS', '可動用點數不足')

    if (deposit > 0) {
      const sw = await walletOf(seller, tx)
      if (sw.available < deposit) {
        /* ── 檢查放在這一步（建單）而不是只放在上架 ──────────────────
           這裡是錢真的被承諾出去的那一刻，也是唯一擋得住的地方：
           上架時驗過的餘額之後還會變（賣家可以上架完再去買別的東西，
           或同時賣五張卡、每一張都要各自的保證金），只驗上架等於留一個
           「上架時有錢、成交時沒錢」的窗口，而那個窗口正好是這個漏洞。
           上架端（routes/public.ts）另外有一道**提前**的檢查，那一道是
           為了讓賣家在自己的畫面上早點知道，不是防線。

           代價：這個拒絕會讓買家知道「這個賣家現在有問題」，等於洩漏賣家
           的財務狀態。所以訊息刻意只說掛單不能買、不說原因與金額 ——
           對買家而言跟「剛被買走」「賣家下架了」是同一類事實。
           真正的原因用通知送給賣家本人（refId 綁掛單，同一筆掛單只吵一次）。
           refId 另外加了前綴：notifications 的唯一索引是
           (user_id, kind, ref_id)，直接用 listingId 的話會跟庫內轉移那則
           「你的卡賣出了」（同樣是 kind='listing-sold'、同樣的 refId）
           共用一格 —— 今天兩條路不會撞在同一筆掛單上（庫內轉移不收保證金），
           但那是巧合不是設計，一格一件事比較不會在之後被人踩到。

           評估過但放棄的另外兩種：
           1 **只在上架擋**：不洩漏任何東西，但擋不住餘額後來變動，
             漏洞仍在 —— 這條是會賠錢的，不能只做 UX。
           2 **在這裡順手把掛單下架**：買家看到的變成單純的「已下架」，
             洩漏更少；但賣家會因為一次暫時性的餘額不足失去掛單
             （還要把 prizes 從 listed 收回去），而他可能只是同時有另一筆
             訂單佔著額度。掛單留著、賣家補足點數後就能成交，代價小得多。 */
        await notify({
          userId: seller, kind: 'listing-sold',
          title: '有人想買，但你的保證金不足',
          body: `「${(l.card as { name?: string }).name ?? '卡片'}」有買家要下單，`
            + `需要 ${deposit.toLocaleString('zh-TW')} 點可動用點數當保證金，`
            + `你目前只有 ${Math.max(0, sw.available).toLocaleString('zh-TW')} 點。`
            + '補足之後這筆掛單就能正常成交；在那之前買家會被擋下來。',
          link: '/me/wallet', refId: 'deposit-short:' + listingId
        }, tx)
        return fail('LISTING_UNAVAILABLE', '這張卡目前無法購買，請稍後再試或看看其他掛單')
      }
    }

    await tx`update listings set status = 'sold' where id = ${listingId}`

    // 庫內轉移：原子交換，沒有中間狀態，直接記帳過戶
    if (l.delivery === 'vault') {
      await tx`insert into points_ledger (user_id, delta, reason, ref_id) values (${me}, ${-price}, 'vault-buy', ${listingId})`
      await tx`insert into points_ledger (user_id, delta, reason, ref_id) values (${l.seller_id}, ${price}, 'vault-sell', ${listingId})`
      /* 卡還在保管庫：過戶就是改 owner，狀態回到保管中（prize_id 為空的已在上面擋掉）。
         acquired_at 一定要一起改：卡冊是照它排的，不改的話這張卡帶著賣家當初
         抽到的時間進買家的卡冊，排在幾天前的位置 —— 卡冊超過一頁時買家在第一頁
         根本看不到自己剛買的卡。won_at 不動，那是「這張卡被抽出來」的事實，
         公開的最近開出動態還要照它排。 */
      await tx`update prizes set user_id = ${me}, status = 'stashed', acquired_at = ${Date.now()} where id = ${l.prize_id}`
      // 賣家不會一直盯著市場，卡賣掉了要主動告知
      await notify({
        userId: l.seller_id as string, kind: 'listing-sold',
        title: '你的卡賣出了',
        body: `「${(l.card as { name?: string }).name ?? '卡片'}」以 ${price.toLocaleString('zh-TW')} 點成交，點數已入帳。`,
        link: '/me/wallet', refId: listingId
      }, tx)
      /* 回傳過戶到手的那張卡的 id：買家會被導去卡冊，卡冊要靠它把
         「剛買到的是這張」標出來。少了它，買家在一整面卡裡認不出多了哪一張。 */
      return { order: null, stashId: String(l.prize_id) }
    }

    const now = Date.now()
    const id = 'o-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    const [buyer] = await tx`select name from users where id = ${me}`

    const [row] = await tx`
      insert into orders (
        id, listing_id, card, price, deposit,
        buyer_id, buyer_name, seller_id, seller_name, status, created_at
      ) values (
        ${id}, ${listingId}, ${l.card as never}, ${price}, ${deposit},
        ${me}, ${buyer?.name ?? '我'}, ${l.seller_id}, ${l.seller_name}, 'escrowed', ${now}
      ) returning *
    `
    await tx`insert into idempotency (key, user_id, order_id) values (${idempotencyKey}, ${me}, ${id})`
    // 需寄送的成交：賣家有 72 小時要出貨，這則通知是那個時限的起點
    await notify({
      userId: l.seller_id as string, kind: 'order',
      title: '有人買了你的卡，該出貨了',
      body: `「${(l.card as { name?: string }).name ?? '卡片'}」以 ${price.toLocaleString('zh-TW')} 點成交，請在 72 小時內寄出並填單號。`,
      link: '/me/orders', refId: id
    }, tx)
    return { order: toOrder(row as Record<string, unknown>) }
  })

  if ('error' in result) return c.json(result, result.status as 400 | 409)
  return c.json({ ...result, wallet: await walletOf(me) })
})

/** 共用：在交易裡把訂單鎖起來、確認角色與動作合法。
    admin 路由也用它裁決爭議 —— 規則只能有一份，複製一份到後台
    等於之後改 escrow.ts 的時候會漏掉一邊。 */
export async function act(
  meId: string, orderId: string, role: 'buyer' | 'seller' | 'platform',
  need: string, apply: (o: Order) => Order | { error: string; message: string; status: number },
  /* 跟這次狀態轉換綁在一起、但不屬於 Order 型別的欄位（目前只有出貨憑證）。
     必須在同一筆交易裡寫，理由見 /ship 端點的說明。 */
  alsoWrite?: (tx: Tx, o: Order) => Promise<void>
) {
  return sql.begin(async tx => {
    const [row] = await tx`select * from orders where id = ${orderId} for update`
    if (!row) return fail('WRONG_STATE', '找不到這張訂單', 404)
    const o = toOrder(row as Record<string, unknown>)

    const isParty = role === 'platform' ? meId === PLATFORM_ID
      : role === 'buyer' ? o.buyerId === meId : o.sellerId === meId
    if (!isParty) return fail(role === 'platform' ? 'NOT_PLATFORM' : 'NOT_PARTY', '你不是這張訂單的當事人', 403)

    // 動作合不合法由 escrow.ts 判斷，不在這裡重寫一次規則
    if (!actionsFor(o, role).includes(need as never)) {
      return fail('WRONG_STATE', '訂單目前的狀態不允許這個動作')
    }

    const next = apply(o)
    if ('error' in next) return next
    await save(tx, next)
    if (alsoWrite) await alsoWrite(tx, next)
    await settle(tx, next)
    return { order: next }
  })
}

const ShipBody = z.object({
  /* ── 出貨的門檻全部拿掉了（使用者拍板）────────────────────────────
     原本要求：物流商 + 單號 + 至少一張出貨照。那套是「平台留存證據」
     的設計，但平台從來不經手實體卡 —— 卡是賣家直接寄給買家的。
     使用者的決定是：寄送與確認由雙方私下用通訊軟體完成，
     平台只提供收件資訊 + 一個雙方按下完成的機制。

     所以這三個欄位現在全是選填：
       carrier / tracking —— 暫時不串物流，也不會知道賣家用哪一家。
         願意填的人填了，爭議時客服多一個查得到的東西；不填也照樣出得了貨。
       photoFileIds —— 整條移除中（前端已經不送），保留欄位只是為了
         讓還沒更新的客戶端不會壞。收到也不會擋，但不再是必要條件。

     代價要講明白：爭議時平台手上沒有任何客觀證據，只能聽雙方各說各話。
     這是刻意的取捨 —— 判斷改由客服工單那條路承擔。 */
  carrier: z.enum(['post', 'tcat', 'seven', 'family', 'hilife', 'shopee', 'other']).optional(),
  tracking: z.string().min(6).max(24).optional(),
  photoFileIds: z.array(z.string().regex(/^f-[0-9a-f]{12}$/, '出貨照必須是站內上傳的檔案')).max(5).default([])
})
/** POST /orders/:id/ship —— 賣家出貨 */
orders.post('/:id/ship', async c => {
  const me = c.get('userId')
  const parsed = ShipBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json(fail('BAD_REQUEST', parsed.error.issues[0]?.message ?? '參數不合法', 400), 400)
  const { carrier, tracking, photoFileIds } = parsed.data

  /* 單號有填才驗。中華郵政那種有公開檢查碼規格的會真的驗檢查碼 ——
     離線驗證擋得掉隨手編的號碼與打錯的字（實測單碼打錯抓到 98%），
     但擋不掉「填一組別人的真單號」。
     沒填就跳過：不串物流之後單號是賣家自願提供的線索，不是放款條件。
     單號被別的訂單用過會被 orders_tracking_uniq 唯一索引擋下。 */
  if (tracking) {
    const v = validateTracking(carrier ?? 'other', tracking)
    if (!v.ok) return c.json(fail('BAD_TRACKING', v.reason ?? '單號格式不正確'), 409)
  }

  /* 出貨照不再強制（見 ShipBody 的說明）。還是有送上來的話照樣驗
     持有人與用途 —— 收一個不屬於他的檔案 id 比不收更糟。 */
  if (photoFileIds.length) {
    const owned = await sql<{ id: string; key: string }[]>`
      select id, key from files where id = any(${photoFileIds})
         and owner_id = ${me} and purpose = 'ship-photo'
    `
    if (owned.length !== photoFileIds.length) {
      return c.json(fail('BAD_SHIP_PHOTO', '出貨照必須是你自己在站內上傳的檔案'), 400)
    }
  }

  /* 單號撞號要講人話。唯一索引擋下來時 postgres.js 丟的是 23505，
     沒有接的話賣家拿到的是一個**沒有內容的 500** —— 他不會知道是單號
     的問題，只會以為系統壞了，然後一直重按。

     用 catch 而不是先 select 檢查：先查再寫是有競態的（兩個人同時送
     同一組單號，兩邊都查到沒人用過），而且多一次查詢。
     唯一索引本來就是權威，這裡只是把它的話翻譯出來。 */
  let r
  try {
    r = await act(me, c.req.param('id'), 'seller', 'ship',
      /* 沒填單號就不寫 tracking —— 寫成空字串會撞 orders_tracking_uniq
         （唯一索引的條件是 tracking is not null，空字串不是 null，
         於是第二筆沒填單號的訂單會被擋下來，錯得毫無道理）。 */
      o => ({
        ...o, status: 'shipped', shippedAt: Date.now(),
        ...(tracking ? { tracking: tracking.trim().toUpperCase() } : {})
      }),
      async (tx, o) => {
        /* carrier 可能是 undefined（現在是選填）—— postgres.js 不收 undefined，
           要明確轉成 null。少了這一步會在賣家不選物流商時整筆 throw。 */
        await tx`update orders set carrier = ${carrier ?? null}, ship_photos = ${photoFileIds as never}
                 where id = ${o.id}`
      })
  } catch (e) {
    const err = e as { code?: string; constraint_name?: string }
    if (err.code === '23505' && err.constraint_name === 'orders_tracking_uniq') {
      return c.json(fail('TRACKING_TAKEN',
        '這組單號已經登記在另一筆訂單上。確認一下是不是複製到別筆的單號；'
        + '真的沒填錯的話可以先不填，出貨照樣成立。', 409), 409)
    }
    throw e
  }
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
  return c.json({ ...r, wallet: await walletOf(me) })
})

/** POST /orders/:id/confirm —— 買家確認收貨，立即放款 */
orders.post('/:id/confirm', async c => {
  const me = c.get('userId')
  const r = await act(me, c.req.param('id'), 'buyer', 'confirm',
    o => ({ ...o, status: 'completed', settledAt: Date.now(), closedBy: 'buyer-confirm' }))
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
  return c.json({ ...r, wallet: await walletOf(me) })
})

const DisputeBody = z.object({
  reason: z.string().min(1).max(500),
  videoUrl: z.string().url('必須附完整未剪輯的開箱影片')
})

/** POST /orders/:id/dispute —— 買家開爭議，沒影片不受理 */
orders.post('/:id/dispute', async c => {
  const me = c.get('userId')
  const parsed = DisputeBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json(fail('NEED_VIDEO', '要申請退款必須附開箱影片', 400), 400)
  const { reason } = parsed.data

  const r = await act(me, c.req.param('id'), 'buyer', 'dispute',
    o => ({ ...o, status: 'disputed', disputedAt: Date.now(), disputeReason: reason, hasUnboxingVideo: true }))
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)

  /* 爭議成立之後補開一張客服工單（合約第五節）。**這個端點的行為一點都沒變**：
     上面那段 act() 才是爭議本身，工單只是把它送進統一的佇列讓客服看得到、
     而且讓買賣雙方有地方講話。既有的 /v1/admin/disputes 也還照樣看得到這一筆。

     開單失敗**不會讓這個端點失敗** —— openDisputeTicket 自己吞掉例外只記 log
     （比照 notifyMany）。爭議本身已經成立了、點數已經凍結了，
     工單開不出來是我們的問題，不該讓使用者的申訴消失。

     await 而不是 void：工單在回應送出前就寫好，前端跳到 /support 時看得到它。
     它不會 reject，所以不需要 catch。 */
  await openDisputeTicket(r.order.id)
  return c.json({ ...r, wallet: await walletOf(me) })
})

/**
 * POST /orders/:id/delivered —— 物流簽收。
 *
 * 這條之後會變成物流商的 webhook 落點，不是使用者按的按鈕。
 * 現在限定平台帳號呼叫，讓端到端測試跑得完整條流程。
 * 接上真的物流之後改成驗簽名，並拿掉平台帳號這條路。
 */
orders.post('/:id/delivered', async c => {
  const me = c.get('userId')
  if (me !== PLATFORM_ID) return c.json(fail('NOT_PLATFORM', '只有平台能回報簽收', 403), 403)
  const r = await sql.begin(async tx => {
    const [row] = await tx`select * from orders where id = ${c.req.param('id')} for update`
    if (!row) return fail('WRONG_STATE', '找不到這張訂單', 404)
    const o = toOrder(row as Record<string, unknown>)
    if (o.status !== 'shipped') return fail('WRONG_STATE', '這張訂單不在運送中')
    const next: Order = { ...o, status: 'delivered', deliveredAt: Date.now() }
    await save(tx, next)
    return { order: next }
  })
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
  return c.json(r)
})

const ResolveBody = z.object({ to: z.enum(['buyer', 'seller']), note: z.string().max(500).default('') })

/* POST /orders/:id/resolve 已移除。
   它認的是寫死的 u-platform 帳號而不是 role='admin'（多開一個管理員就靜默 403），
   而且不寫稽核 —— 對一個會實際移動點數且不可逆的動作來說那不能接受。
   裁決改走 POST /v1/admin/disputes/:id/resolve：權限由 requireAdmin 認，
   動作仍交給這個檔案的 act()（規則只留一份），並強制填理由、寫進 admin_actions。 */

