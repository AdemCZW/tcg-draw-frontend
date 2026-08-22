/**
 * 通知的即時推播管線：Postgres 的 LISTEN / NOTIFY → 行程內的分派 → SSE。
 *
 * 為什麼不是讓前端輪詢就好：使用者在意的事件（別人對他的卡出價、開池提醒）
 * 全部是「別人觸發的」，本地重新整理救不了，只能等下一次輪詢 ——
 * 90 秒的輪詢週期等於通知平均慢 45 秒到，這正是使用者回報的「有點慢」。
 *
 * 為什麼推播來源用 pg_notify 而不是行程內的事件匯流排：寫入通知的路徑不只一條
 * （HTTP 端點、五分鐘一次的 sweep），未來也可能不只一個行程（Railway 擴到兩個
 * instance 就是兩個行程）。走資料庫的話，不管是誰寫進去的都會廣播到每一個
 * 有掛 LISTEN 的行程，不需要行程之間再自己牽線。
 * 而且 NOTIFY 是交易性的 —— 包在 tx 裡的通知只有在 commit 之後才會送出去，
 * 不會發生「前端收到訊號、回頭抓卻還看不到那一則」的競態。
 *
 * payload 只放 userId，不放通知內容。兩個理由：
 * 一是 pg_notify 的 payload 有 8000 bytes 上限，塞內容遲早會爆；
 * 二是通知的資料形狀只該有一個來源（GET /v1/social/notifications），
 * 兩邊各自定義早晚會走鐘。串流只負責喊「你有新東西」，內容由前端重抓。
 */
import { sql as root } from './db.js'
import type { Db } from './db.js'

/** 頻道名寫死成一個常數：發送端與接收端只要有一邊拼錯，訊號就靜靜地不見 */
export const NOTIFY_CHANNEL = 'vd_notify'

type Sink = () => void

/** userId → 這個人目前開著的所有 SSE 連線。同一個人可能同時開好幾個分頁 */
const sinks = new Map<string, Set<Sink>>()

/**
 * 整個行程共用同一條 LISTEN 連線。
 *
 * postgres.js 的 sql.listen() 會獨佔一條連線（LISTEN 的連線不能再拿去下查詢），
 * 每個 SSE 連線各開一條的話，連線池（max: 10）幾個使用者就見底，
 * 接著整個服務連一般查詢都下不了。分派誰該收到訊號是行程內就能做的事，
 * 不需要讓資料庫替我們做。
 */
let listening: Promise<unknown> | null = null

function ensureListening(): Promise<unknown> {
  if (listening) return listening
  const p = root
    .listen(NOTIFY_CHANNEL, payload => {
      const set = sinks.get(payload)
      if (!set) return
      for (const fn of set) {
        // 一條連線寫失敗（對方剛斷線）不該讓同一個人的其他分頁收不到
        try { fn() } catch (e) { console.error('[notify-stream] 推送失敗:', (e as Error).message) }
      }
    })
    .catch(e => {
      // 建立失敗就把旗標放掉，下一個訂閱者才有機會重試，
      // 而不是整個行程從此永遠停在一個壞掉的 promise 上
      if (listening === p) listening = null
      throw e
    })
  listening = p
  return p
}

/**
 * 讓一條 SSE 連線開始收這個人的訊號。回傳的函式一定要在連線關閉時呼叫 ——
 * 忘了呼叫就是每一次斷線都在 Map 裡留一個永遠不會被清掉的 closure。
 */
export async function subscribe(userId: string, sink: Sink): Promise<() => void> {
  await ensureListening()
  let set = sinks.get(userId)
  if (!set) { set = new Set(); sinks.set(userId, set) }
  set.add(sink)
  return () => {
    const cur = sinks.get(userId)
    if (!cur) return
    cur.delete(sink)
    // 空集合要連 key 一起刪：留著的話 Map 會隨著曾經連過的人數單調成長
    if (!cur.size) sinks.delete(userId)
  }
}

/**
 * 廣播「這個人有新通知了」。
 *
 * 吃 db 參數而不是固定用外層連線：包在交易裡送出的 NOTIFY 會跟著 commit 一起生效，
 * rollback 的話就自動不送 —— 這正是我們要的語意。
 */
export async function publishNotify(userId: string, db: Db = root) {
  await db`select pg_notify(${NOTIFY_CHANNEL}, ${userId})`
}

/** 目前有多少人掛著串流。健康檢查與本機實測用得到 */
export const streamStats = () => ({
  users: sinks.size,
  connections: [...sinks.values()].reduce((n, s) => n + s.size, 0)
})
