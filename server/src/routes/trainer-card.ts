/**
 * 訓練家卡的資格判斷。
 *
 * 拍板的規則（使用者原話，以最後一次為準）：
 *   「要上傳卡片到卡冊，不能是線上購買，一定要首度登記過」
 * 也就是 **登入 ＋ 自己親手把一張實體卡登記進卡冊**。抽中的、站內買來的
 * 都不算 —— 那兩種卡進卡冊的時候，人沒有把卡拿在手上過。
 *
 * ── 資料上怎麼分辨「自己登記的卡」 ────────────────────────────────
 *
 * 三個欄位，三件不同的事（欄位語意見 migrations/021 的 comment）：
 *
 *   origin        這一列是怎麼產生的。'upload' = 走 /v1/cardbook/upload
 *                 登記進來的（cardbook.ts 是全站唯一寫這個值的地方），
 *                 'draw' = 抽卡產生，'seed' = 種子資料。
 *                 **這一欄是不變的歷史事實**，不會被後續交易改寫。
 *   user_id       擁有權。會隨站內交易移轉。
 *   custodian_id  實體卡在誰手上。**站內交易一律不碰它** ——
 *                 登記時寫成自己，卡在站內轉手幾次都還是原登記人。
 *
 * 所以判準是三件事同時成立：
 *   origin = 'upload'      這一列是登記進來的，不是抽出來的
 *   user_id = me           現在是我的
 *   custodian_id = me      實體卡從沒離開過我 ⇒ 登記的人就是我
 *
 * **只有 origin 是不夠的**：一張登記進來的卡被別人在市場買走之後，
 * origin 還是 'upload'，但買家從來沒有把它拿在手上登記過。
 * custodian_id 就是分開這兩者的那一欄 —— 庫內轉移（orders.ts、social.ts）
 * 只改 user_id，實體仍記在原登記人名下。
 *
 * **status 一個字都不看**，這是刻意的：登記完之後上架（listed）、下架
 * （回 in_book）、押進池（in_pool）、回收（recycled）都會改 status，
 * 而「他登記過一張卡」是已經發生的事實，不該被之後的狀態變化取消。
 * A-5 / 032 / 034 那一串 bug 的共同形狀正是「用一個會變的狀態去代表
 * 一個不變的事實」，這裡不重蹈。
 *
 * ── 已知的破口：custodian_id 是可以被改的 ──────────────────────────
 *
 * 有兩條路會把 custodian_id 改成買方（見 021 的 comment，只有這兩條）：
 *   1 託管訂單完成（orders-service.ts 的 releasePrize）—— 需寄送的市場
 *     交易走完，卡真的寄到買家手上，user_id 與 custodian_id 一起改。
 *     於是一張別人登記、我買來收到的卡，看起來會跟我自己登記的一模一樣。
 *     **這條下面用 orders 擋掉**（見查詢裡的 not exists）：那不是猜的，
 *     是「這張卡是我買來的」這件事本身留下的紀錄。
 *   2 站外轉手接管（tickets.ts 的 applyTakeover）—— 客服審過照片、確認
 *     實體卡在申請人手上才過戶。**這條刻意不擋**：它的前提就是
 *     「卡在你手上、你證明給客服看過」，跟登記是同一件事的人工版本，
 *     擋掉它等於懲罰走了更嚴格那條路的人。
 *
 * 但這仍然是**推導**，不是紀錄。資料庫裡沒有任何一欄寫著「這一列是誰
 * 登記的」—— custodian_id 是「現在實體在誰手上」，語意上只是碰巧在
 * 登記那一刻等於登記人。真正的修法是一個不可變的 prizes.registered_by
 * （登記時寫入，之後任何交易都不動），那需要新的 migration，
 * 要先跟人確認，這一輪不自己開。
 */
import { Hono } from 'hono'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'

export const trainerCard = new Hono()
trainerCard.use('*', requireAuth)

/** 一次最多回幾張。做卡是「挑一張」，不是瀏覽整個卡冊；上限只是防呆。 */
const MAX_CARDS = 60

type CardJson = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * GET /v1/trainer-card/eligibility
 *
 * 回 { eligible, reason?, cards }。
 *
 * cards 的每一筆帶 `source`，前端**一眼分得出圖是哪來的**（這是介面契約）：
 *   source = 'catalog'  目錄卡，artId 一定有值。圖從 TCGdex 取（前端的
 *                       artUrlById），本來就是正面方正的掃描圖 ——
 *                       **不要跑透視校正**，跑了只會把方的弄歪。
 *   source = 'photo'    使用者自己拍的正面照（card-front 上傳），
 *                       imageUrl 一定有值，是手持照片 —— **要跑校正**。
 *
 * 兩種都有的情況（登記時同時給了 artId 與 frontFileId）判成 'catalog'：
 * 有現成的方正圖就不必冒校正失敗的風險。那張照片仍然放在 imageUrl 裡，
 * 前端要拿來當備援或讓人自己選都可以，但 source 才是該不該校正的答案。
 */
trainerCard.get('/eligibility', async c => {
  const me = c.get('userId')

  const rows = await sql`
    select p.id, p.card, p.status, p.acquired_at
      from prizes p
     where p.user_id = ${me}
       and p.custodian_id = ${me}
       and p.origin = 'upload'
       /* 這張卡是我在市場上買來、賣家寄給我的 —— 完成的託管訂單會把
          custodian_id 一起改成我，光看欄位跟自己登記的分不出來。
          orders 這一列就是「我買了它」的直接紀錄，不是相似度猜測。 */
       and not exists (
         select 1 from orders o
           join listings l on l.id = o.listing_id
          where l.prize_id = p.id and o.buyer_id = ${me} and o.status = 'completed'
       )
     order by p.acquired_at desc, p.id desc
     limit ${MAX_CARDS}
  `

  const cards = rows.map(r => {
    const card = (r.card ?? {}) as CardJson
    const artId = str(card.artId) || null
    /* image 在登記時寫的是 '/v1/files/<id>'（自拍正面照）或 ''（目錄卡）。
       空字串一律轉成 null：'' 在前端是個會安靜通過型別檢查的假網址。 */
    const imageUrl = str(card.image) || null
    return {
      id: String(r.id),
      name: str(card.name),
      setCode: str(card.setCode) || null,
      cardNo: str(card.cardNo) || null,
      /* 契約的核心那一欄。artId 有值就是目錄卡（不校正），否則是自拍照（要校正）。 */
      source: artId ? 'catalog' : 'photo',
      artId,
      imageUrl,
      /* 狀態不影響資格，但前端可能想標「這張正押在池裡」之類的提示，
         所以照實回；**不要拿它來當第二道資格判斷**。 */
      status: String(r.status)
    }
  })

  if (cards.length === 0) {
    return c.json({ eligible: false, reason: 'NO_REGISTERED_CARD' as const, cards: [] })
  }
  return c.json({ eligible: true, cards })
})
