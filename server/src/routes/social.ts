/**
 * 卡冊分享、交易邀約、站內通知。
 *
 * 這三件事是同一條動線：把卡冊分享出去 → 別人看到想要 → 提出交易 → 我收到通知。
 *
 * 分成兩個 Hono 實例：public 的部分（用分享代號看別人的卡冊）不能要求登入，
 * 否則「分享連結」就沒有意義了；其餘一律要登入。使用者的原話是
 * 「如果要提出交易，就必須要登入狀況下才可以提出」—— 看可以匿名，出價不行。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { lockSpender, walletOf } from '../money.js'
import { notify } from '../notify.js'
import { PageQuery, decodeCursor, encodeCursor, isNumeric, slicePage } from '../pagination.js'

/* =====================================================================
   公開：不需要登入
   ===================================================================== */
export const socialPublic = new Hono()

/**
 * 用分享代號看某個人的卡冊。
 *
 * 只回傳卡片本身與持有人的顯示名稱 —— 不含 email、電話、地址、餘額、
 * 也不含 user_id。分享連結會被轉貼到群組裡，任何從這裡漏出去的欄位
 * 等於公開，所以這裡是白名單而不是「把 user 撈出來刪幾個欄位」。
 */
/* 賞別的展示順序。寫成 SQL 片段而不是字串，才能同時給 order by 與游標比較用 ——
   兩邊只要有一邊漏改，分頁就會在賞別交界處漏卡或重複。 */
const TIER_RANK = sql`case tier when 'LAST' then 0 when 'A' then 1 when 'B' then 2 when 'C' then 3 else 4 end`

socialPublic.get('/cardbook/:slug', async c => {
  const slug = c.req.param('slug') ?? ''
  const parsed = PageQuery.safeParse(c.req.query())
  if (!parsed.success) {
    return c.json({ error: 'BAD_REQUEST', message: '分頁參數不合法（limit 介於 1 到 100）' }, 400)
  }
  const { limit, cursor } = parsed.data

  const [u] = await sql`
    select id, coalesce(display_name, name) as name, handle, cardbook_public
    from users where share_slug = ${slug}
  `
  if (!u) return c.json({ error: 'NOT_FOUND', message: '找不到這個卡冊' }, 404)
  // 已經分享出去又關掉的連結要真的失效，不能只是前端不顯示
  if (!u.cardbook_public) return c.json({ error: 'CARDBOOK_PRIVATE', message: '這本卡冊已經改成不公開' }, 403)

  /* 游標是 (賞別序, -won_at, id)。
     列值比較只能表達「全部同方向」的排序，而這裡要的是賞別由高到低、
     同賞別內時間由新到舊 —— 方向是混的。把 won_at 取負號就把「時間遞減」
     翻成「-won_at 遞增」，三個鍵全部變成遞增，一個 (a,b,c) > (x,y,z) 就寫得完。
     order by 也用同一組表達式，兩邊必須逐字對應。 */
  let after: [string, string, string] | null = null
  if (cursor) {
    const p = decodeCursor(cursor, 3)
    if (!p || !isNumeric(p[0]!) || !isNumeric(p[1]!)) {
      return c.json({ error: 'BAD_CURSOR', message: '分頁游標不合法' }, 400)
    }
    after = [p[0]!, p[1]!, p[2]!]
  }

  // 只列還在保管庫或已上架的卡：已寄出、已回收的不算「持有」
  const rows = await sql<{ id: string; tier: string; status: string; won_at: string; rank: number }[]>`
    select id, card, tier, status, won_at, ${TIER_RANK} as rank from prizes
    where user_id = ${u.id} and status in ('stashed', 'listed')
      ${after
        ? sql`and (${TIER_RANK}, -won_at, id) > (${after[0]}::int, ${after[1]}::bigint, ${after[2]}::text)`
        : sql``}
    order by ${TIER_RANK}, -won_at, id
    limit ${limit + 1}
  `
  const page = slicePage(rows, limit, r => encodeCursor([r.rank, -Number(r.won_at), String(r.id)]))

  return c.json({
    owner: { name: u.name, handle: u.handle },
    // 提出交易要登入，但「有幾張、長什麼樣」不用 —— 不然分享出去沒人看得到
    items: page.items.map(p => ({
      id: p.id, card: (p as unknown as { card: unknown }).card, tier: p.tier,
      // 已上架的卡不能私下出價，要走市場，前端得看得出來
      tradable: p.status === 'stashed'
    })),
    nextCursor: page.nextCursor,
    /* 頭部的「收藏 N 張／可談交易 N 張／市值合計」講的是整本卡冊，
       不能拿載進來的那一頁去數 —— 那個數字會隨著捲動一直長大。 */
    ...(cursor ? {} : { summary: await cardbookSummary(u.id as string) })
  })
})

async function cardbookSummary(userId: string) {
  const [r] = await sql<{ n: string; tradable: string; value: string }[]>`
    select
      count(*)::text as n,
      count(*) filter (where status = 'stashed')::text as tradable,
      coalesce(sum((card->>'refPrice')::numeric), 0)::text as value
    from prizes where user_id = ${userId} and status in ('stashed', 'listed')
  `
  return { count: Number(r?.n ?? 0), tradable: Number(r?.tradable ?? 0), totalValue: Number(r?.value ?? 0) }
}

/* =====================================================================
   需要登入
   ===================================================================== */
export const social = new Hono()
social.use('*', requireAuth)

/* ---- 卡冊公開設定 ---- */
social.get('/cardbook/settings', async c => {
  const [u] = await sql`select cardbook_public, share_slug from users where id = ${c.get('userId')}`
  return c.json({ public: !!u?.cardbook_public, slug: u?.share_slug ?? null })
})

const Visibility = z.object({
  public: z.boolean(),
  /** 換一組新代號：舊連結立刻失效。分享錯對象時唯一的補救手段 */
  rotate: z.boolean().default(false)
})
social.put('/cardbook/settings', async c => {
  const me = c.get('userId')
  const parsed = Visibility.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
  const { public: isPublic, rotate } = parsed.data

  const [cur] = await sql`select share_slug from users where id = ${me}`
  // 第一次公開才發代號。關掉再開不換代號，否則之前分享的連結會無聲失效
  const slug = rotate || !cur?.share_slug
    ? randomBytes(8).toString('base64url')
    : cur.share_slug as string

  await sql`update users set cardbook_public = ${isPublic}, share_slug = ${slug} where id = ${me}`
  return c.json({ public: isPublic, slug })
})

/* ---- 交易邀約 ---- */
const Offer = z.object({
  prizeId: z.string().min(1),
  points: z.number().int().positive().max(100_000_000),
  message: z.string().trim().max(200).default('')
})

social.post('/trade-offers', async c => {
  const me = c.get('userId')
  const parsed = Offer.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '請填出價點數' }, 400)
  const { prizeId, points, message } = parsed.data

  const r = await sql.begin(async tx => {
    const [p] = await tx`select id, user_id, card, status from prizes where id = ${prizeId}`
    if (!p) return { error: 'NOT_FOUND', message: '找不到這張卡', status: 404 }
    if (p.user_id === me) return { error: 'WRONG_STATE', message: '不能對自己的卡出價', status: 409 }
    if (p.status !== 'stashed') {
      return { error: 'WRONG_STATE', message: '這張卡目前不能私下交易（已上架或已出貨）', status: 409 }
    }
    // 卡冊沒公開就不該被出價 —— 否則知道 prize_id 就能繞過公開設定去騷擾
    const [owner] = await tx`select cardbook_public from users where id = ${p.user_id}`
    if (!owner?.cardbook_public) {
      return { error: 'CARDBOOK_PRIVATE', message: '這本卡冊沒有公開，不能提出交易', status: 403 }
    }

    /* 出價會凍結點數（見 money.ts 的 locked 計算），所以這裡的檢查
       已經把「我其他還在等回應的出價」算進去了 —— 不會出到超過自己付得起的總額。
       仍然不是最終檢查：對方可能三天後才按接受，那一刻的餘額才算數。
       這裡也要鎖帳戶，否則同時送出兩筆出價會各自讀到還沒算進對方的餘額。 */
    await lockSpender(tx, me)
    const w = await walletOf(me, tx)
    if (w.available < points) return { error: 'INSUFFICIENT_POINTS', message: '可動用點數不足', status: 409 }

    const id = 'to-' + randomBytes(6).toString('hex')
    /* 用 ON CONFLICT DO NOTHING 判斷重複，不要靠 try/catch 接唯一索引的例外。
       Postgres 只要有一句失敗，**整個交易就進入 aborted 狀態** —— 就算把例外
       catch 住並提早 return，postgres.js 接著要 COMMIT 一樣會失敗，
       結果是使用者拿到 500 而不是「你已經出過價了」。
       這個寫法從一開始就是錯的，但這條路徑直到煙霧測試真的跑起來才被走到。

       沒有回傳列 = 撞到 trade_offers_one_open（同一張卡對同一個人只能有一筆
       待回應）。交易全程健康，也不需要先 SELECT 再 INSERT 那種有競態的檢查。 */
    const ins = await tx<{ id: string }[]>`
      insert into trade_offers (id, prize_id, from_user, to_user, points, message, created_at)
      values (${id}, ${prizeId}, ${me}, ${p.user_id}, ${points}, ${message}, ${Date.now()})
      on conflict do nothing
      returning id
    `
    if (!ins.length) {
      return { error: 'OFFER_EXISTS', message: '你對這張卡已經有一筆還沒回應的出價', status: 409 }
    }

    const [from] = await tx`select coalesce(display_name, name) as name from users where id = ${me}`
    const card = p.card as { name?: string }
    await notify({
      userId: p.user_id as string, kind: 'trade-offer',
      title: '有人想要你的卡',
      body: `${from?.name ?? '有人'} 出 ${points.toLocaleString('zh-TW')} 點想換「${card.name ?? '卡片'}」`,
      link: '/me/offers', refId: id
    }, tx)
    return { offerId: id }
  })
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
  return c.json(r)
})

/** 收到的與送出的，一次給 —— 分兩個端點的話前端要打兩次才畫得出一個列表 */
social.get('/trade-offers', async c => {
  const me = c.get('userId')
  const [incoming, outgoing] = await Promise.all([
    sql`select o.*, p.card, coalesce(u.display_name, u.name) as from_name
        from trade_offers o join prizes p on p.id = o.prize_id
        join users u on u.id = o.from_user
        where o.to_user = ${me} order by o.created_at desc limit 100`,
    sql`select o.*, p.card, coalesce(u.display_name, u.name) as to_name
        from trade_offers o join prizes p on p.id = o.prize_id
        join users u on u.id = o.to_user
        where o.from_user = ${me} order by o.created_at desc limit 100`
  ])
  return c.json({ incoming, outgoing })
})

/**
 * 接受出價。
 *
 * 走的是既有的「庫內轉移」語意（orders.ts 的 delivery === 'vault'）：
 * 卡本來就在平台保管庫，成立就是改 owner + 記兩筆帳，一個交易內完成，
 * 沒有託管、沒有物流、沒有中間狀態。不為了這條路另外發明一套結算規則。
 */
social.post('/trade-offers/:id/accept', async c => {
  const me = c.get('userId')
  const id = c.req.param('id') ?? ''

  const r = await sql.begin(async tx => {
    const [o] = await tx`select * from trade_offers where id = ${id} for update`
    if (!o) return { error: 'NOT_FOUND', message: '找不到這筆出價', status: 404 }
    if (o.to_user !== me) return { error: 'NOT_PARTY', message: '這筆出價不是給你的', status: 403 }
    if (o.status !== 'pending') return { error: 'WRONG_STATE', message: '這筆出價已經處理過了', status: 409 }

    const [p] = await tx`select * from prizes where id = ${o.prize_id} for update`
    if (!p || p.user_id !== me) return { error: 'WRONG_STATE', message: '這張卡已經不在你名下', status: 409 }
    if (p.status !== 'stashed') return { error: 'WRONG_STATE', message: '這張卡目前不能交易', status: 409 }

    // 出價到現在可能過了幾天，這一刻的餘額才算數
    const price = Number(o.points)
    /* 鎖的是出價方（付錢的那一邊）而不是我。待回應的出價不算凍結，
       所以同一個人可以同時掛好幾筆出價；兩個持有人同時按下接受時，
       兩筆交易鎖到的是不同的 trade_offers 與 prizes 列，互不阻擋，
       兩邊都會讀到同一個 available 而都判定「夠」—— 對方的餘額就被花了兩次
       （見 money.ts 的 lockSpender）。 */
    await lockSpender(tx, o.from_user as string)

    /* 順序很重要：先把這筆出價移出 pending，再算餘額。
       待回應的出價會被計入 locked（見 money.ts），所以在改狀態之前，
       **這筆出價自己**也還在凍結裡 —— 餘額 1000、出價 1000 的人算出來的
       available 會是 0，每一筆接受都會被自己擋掉。
       改完狀態它就不在 locked 裡了，這時算出來的才是真正付得起多少。
       檢查沒過就回錯誤，整筆交易連同這次狀態變更一起回滾。 */
    await tx`update trade_offers set status = 'accepted', responded_at = ${Date.now()} where id = ${id}`

    const w = await walletOf(o.from_user as string, tx)
    if (w.available < price) {
      return { error: 'INSUFFICIENT_POINTS', message: '對方的可動用點數已經不足，無法成交', status: 409 }
    }
    await tx`insert into points_ledger (user_id, delta, reason, ref_id)
             values (${o.from_user}, ${-price}, 'trade-buy', ${id}) on conflict do nothing`
    await tx`insert into points_ledger (user_id, delta, reason, ref_id)
             values (${me}, ${price}, 'trade-sell', ${id}) on conflict do nothing`
    /* 跟市場的庫內轉移同一件事：卡冊照 acquired_at 排，過戶要一起更新，
       否則買方的卡冊裡這張卡排在賣方抽到它的那天（見 routes/orders.ts 的說明） */
    await tx`update prizes set user_id = ${o.from_user}, acquired_at = ${Date.now()} where id = ${o.prize_id}`

    // 同一張卡上其他人還在等的出價全部作廢：卡已經不是我的了，不可能再答應
    const dropped = await tx`
      update trade_offers set status = 'cancelled', responded_at = ${Date.now()}
      where prize_id = ${o.prize_id} and status = 'pending'
      returning id, from_user
    `
    const card = p.card as { name?: string }
    // 這些人的出價是被動作廢的，不通知的話他們會一直以為還在等回覆
    for (const d of dropped) {
      await notify({
        userId: d.from_user as string, kind: 'trade-result',
        title: '你的出價已失效',
        body: `「${card.name ?? '卡片'}」被其他人的出價買走了，你的點數沒有被扣。`,
        link: '/me/offers', refId: d.id as string
      }, tx)
    }
    await notify({
      userId: o.from_user as string, kind: 'trade-result',
      title: '你的出價成交了',
      body: `「${card.name ?? '卡片'}」已經進到你的卡冊，扣了 ${price.toLocaleString('zh-TW')} 點`,
      link: '/me/cards', refId: id
    }, tx)
    return { ok: true }
  })
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
  return c.json({ ...r, wallet: await walletOf(me) })
})

social.post('/trade-offers/:id/decline', async c => {
  const me = c.get('userId')
  const id = c.req.param('id') ?? ''
  const r = await sql.begin(async tx => {
    const [o] = await tx`select * from trade_offers where id = ${id} for update`
    if (!o) return { error: 'NOT_FOUND', message: '找不到這筆出價', status: 404 }
    // 收到的人可以婉拒，送出的人可以收回 —— 同一個端點，兩種身分
    const isOwner = o.to_user === me
    const isSender = o.from_user === me
    if (!isOwner && !isSender) return { error: 'NOT_PARTY', message: '這筆出價與你無關', status: 403 }
    if (o.status !== 'pending') return { error: 'WRONG_STATE', message: '這筆出價已經處理過了', status: 409 }

    await tx`update trade_offers set status = ${isOwner ? 'declined' : 'cancelled'},
             responded_at = ${Date.now()} where id = ${id}`
    // 只有被婉拒要通知對方；自己收回不用通知自己
    if (isOwner) {
      await notify({
        userId: o.from_user as string, kind: 'trade-result',
        title: '對方婉拒了你的出價', body: '你的點數沒有被扣。',
        link: '/me/offers', refId: id
      }, tx)
    }
    return { ok: true }
  })
  if ('error' in r) return c.json(r, r.status as 403 | 404 | 409)
  return c.json(r)
})

/* ---- 通知 ---- */
social.get('/notifications', async c => {
  const me = c.get('userId')
  const rows = await sql`
    select id, kind, title, body, link, ref_id, read_at, created_at
    from notifications where user_id = ${me} order by id desc limit 50
  `
  const [n] = await sql<{ count: string }[]>`
    select count(*)::text as count from notifications where user_id = ${me} and read_at is null
  `
  return c.json({ notifications: rows, unread: Number(n?.count ?? 0) })
})

const ReadBody = z.object({
  /** 不給 ids 就是全部已讀 —— 鈴鐺打開就清紅點是最常見的操作 */
  ids: z.array(z.number().int()).optional()
})
social.post('/notifications/read', async c => {
  const me = c.get('userId')
  const parsed = ReadBody.safeParse(await c.req.json().catch(() => ({})))
  const ids = parsed.success ? parsed.data.ids : undefined
  if (ids?.length) {
    await sql`update notifications set read_at = now()
              where user_id = ${me} and read_at is null and id = any(${ids})`
  } else {
    await sql`update notifications set read_at = now() where user_id = ${me} and read_at is null`
  }
  return c.json({ ok: true })
})
