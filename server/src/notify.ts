/**
 * 站內通知的寫入端。
 *
 * 為什麼要一個 helper 而不是各處直接 insert：通知有一條非寫不可的規則 ——
 * 同一件事只能通知一次。結算路徑是 idempotent 的（會重試），
 * 各處自己寫 insert 的話，重試一次就在使用者的鈴鐺裡多一則一樣的東西。
 * 這裡統一帶上 ref_id 並吃 notifications_once 唯一索引。
 *
 * 另一個規則是「點得進去」：通知如果只說「你有新的交易邀約」卻沒有連結，
 * 使用者知道發生事情但找不到現場。所以 link 是必填參數而不是選填。
 */
import type { Db } from './db.js'
import { sql as root } from './db.js'
import { publishNotify } from './notify-stream.js'

export type NotifyKind =
  | 'draw' | 'trade-offer' | 'trade-result' | 'listing-sold'
  | 'order' | 'shipment' | 'system'

export interface NotifyInput {
  userId: string
  kind: NotifyKind
  title: string
  /** 前端路由字串，例如 /me/cards 或 /me/orders。點通知要跳得到現場 */
  link: string | null
  body?: string
  /** 關聯的事件 id（draw / offer / order…）。有帶就保證只通知一次 */
  refId?: string
}

export async function notify(input: NotifyInput, db: Db = root) {
  const { userId, kind, title, link, body = '', refId } = input
  const ins = await db`
    insert into notifications (user_id, kind, title, body, link, ref_id)
    values (${userId}, ${kind}, ${title}, ${body}, ${link}, ${refId ?? null})
    on conflict do nothing
    returning id
  `
  /* 只有真的寫進去才推播。
     上面那條唯一索引擋掉的是「同一件事重試第二次」—— 那次沒有新東西，
     推出去只會讓每個開著的分頁白跑一趟 GET /notifications。
     推播也吃同一個 db：包在交易裡的話 NOTIFY 會跟著 commit 才送出，
     前端收到訊號時那一列一定已經看得到。 */
  if (ins.length) await publishNotify(userId, db)
}

/** 一次通知多個人（例如一筆交易的買賣雙方）。失敗不該擋住主流程，所以不拋。 */
export async function notifyMany(inputs: NotifyInput[], db: Db = root) {
  for (const i of inputs) {
    try { await notify(i, db) }
    catch (e) { console.error('[notify] 寫入失敗，主流程繼續:', (e as Error).message) }
  }
}
