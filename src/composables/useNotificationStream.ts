/**
 * 通知的即時串流。
 *
 * 原本鈴鐺是 90 秒輪詢一次，而使用者在意的事件（別人對他的卡出價、開池提醒）
 * 全部是別人觸發的 —— 本地重新整理救不了，只能等下一次輪詢，平均慢 45 秒。
 * 改成伺服器主動推：後端寫進通知的同時發一則 pg_notify，SSE 端點把訊號送下來。
 *
 * 串流只送「你有新東西」，不送內容。呼叫端收到 onPush 之後自己重抓
 * GET /v1/social/notifications —— 通知的資料形狀因此只有一個來源，
 * 不會變成串流一套、列表一套。
 *
 * 為什麼不用瀏覽器原生的 EventSource：它不能帶 header，要認證就只能把 JWT
 * 放進 query string，而那會讓憑證進到伺服器存取日誌、瀏覽器歷史與 Referer。
 * 改用 fetch + ReadableStream 自己讀 text/event-stream，Authorization header
 * 就跟其他請求一樣帶。代價是要自己處理重連 —— 那本來也該自己處理，
 * EventSource 的重連策略是固定間隔，連不上時等於在打自己的後端。
 */
import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { API_URL, MOCK } from '@/lib/config'
import { token } from '@/lib/http'

export interface NotificationStreamOptions {
  /** 伺服器說「你有新東西」時呼叫。呼叫端自己去重新抓清單 */
  onPush: () => void
  /** 目前是否已登入。false 時不連線 */
  enabled: () => boolean
}

export interface NotificationStream {
  /** 串流是否連上。介面可以據此顯示即時／延遲狀態 */
  connected: Ref<boolean>
  stop: () => void
}

/** 退避從 1 秒起跳、每次加倍，上限 30 秒。連不上時不該變成 DDoS 自己的後端 */
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000

/**
 * 串流不可用時的輪詢退路（舊瀏覽器、代理擋掉 SSE、後端還沒部署到這版）。
 * 比原本的 90 秒短很多 —— 沒有串流的人才是現在體驗最差的那群，
 * 但也不能太短，這條路是一直在打真的查詢。
 */
const FALLBACK_POLL_MS = 25_000

export function useNotificationStream(opts: NotificationStreamOptions): NotificationStream {
  const connected = ref(false)

  /* MOCK 模式（沒設 VITE_API_URL）底下沒有後端可以連，連 fallback 輪詢都不必開 ——
     mock 的資料不會自己長出新的東西。 */
  const usable = !MOCK && typeof fetch === 'function' && typeof AbortController === 'function'

  let stopped = false
  let ac: AbortController | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let backoff = BACKOFF_MIN_MS
  /** 分辨「這一輪迴圈還算不算數」：舊的迴圈在被 abort 之後才跑到 finally 也不該重連 */
  let run = 0

  /* 退路輪詢只在串流沒連上時跑。兩邊同時打就是白花一半的請求，
     而且列表在手指底下重排兩次。 */
  function startPolling() {
    if (pollTimer !== undefined || stopped || !opts.enabled()) return
    pollTimer = setInterval(() => {
      // 背景分頁不用輪詢，回到前景時 onVisible 會補一次
      if (document.hidden) return
      opts.onPush()
    }, FALLBACK_POLL_MS)
  }
  function stopPolling() {
    clearInterval(pollTimer)
    pollTimer = undefined
  }

  function scheduleRetry() {
    if (stopped || retryTimer !== undefined) return
    /* 連不上的期間要有東西頂著，不然使用者是完全收不到通知 ——
       比原本的 90 秒輪詢還糟。 */
    startPolling()
    const wait = backoff
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    retryTimer = setTimeout(() => { retryTimer = undefined; connect() }, wait)
  }

  async function connect() {
    if (stopped || !usable || !opts.enabled()) return
    // 背景分頁不需要維持連線：手機的省電策略本來就會凍結它，
    // 留著只是讓後端多掛一條沒人在看的連線。回到前景再連並補抓一次。
    if (document.hidden) { stopPolling(); return }
    if (ac) return

    const my = ++run
    const controller = new AbortController()
    ac = controller
    const t = token.get()

    try {
      const res = await fetch(`${API_URL}/v1/social/notifications/stream`, {
        headers: {
          accept: 'text/event-stream',
          ...(t ? { authorization: `Bearer ${t}` } : {})
        },
        signal: controller.signal
      })
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`)

      /* 連上了就把輪詢停掉，並把退避歸零 —— 下一次真的斷線時該從 1 秒重試，
         而不是沿用上一輪已經爬到 30 秒的間隔。 */
      connected.value = true
      stopPolling()
      backoff = BACKOFF_MIN_MS

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        /* 用兩個換行切訊息：一則 SSE 事件可能被切在任意的 chunk 邊界上，
           逐行 parse 而不緩衝的話會讀到半行。 */
        let i: number
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          // 以冒號開頭的是 comment frame（後端的心跳跟連上通知），照規格忽略
          if (!frame || frame.startsWith(':')) continue
          if (my === run) opts.onPush()
        }
      }
      // 伺服器那邊把串流收掉了（代理逾時、部署重啟）—— 當成一次斷線去重連
      throw new Error('stream ended')
    } catch {
      /* 這裡不分辨錯誤種類：abort、連不上、被代理切掉，處理方式都是同一個 ——
         標記斷線、開退路輪詢、退避之後再試。分辨了也不會有不同的動作。 */
    } finally {
      if (my === run) {
        ac = null
        connected.value = false
        if (!stopped && opts.enabled()) scheduleRetry()
        else stopPolling()
      }
    }
  }

  function disconnect() {
    run++
    ac?.abort()
    ac = null
    clearTimeout(retryTimer)
    retryTimer = undefined
    connected.value = false
  }

  function onVisible() {
    if (document.hidden) {
      // 進背景就收掉連線，但輪詢也一併停 —— 背景分頁兩種都不需要
      disconnect()
      stopPolling()
      return
    }
    // 回到前景先補抓一次：離開的這段期間錯過的訊號沒有人會重送
    if (opts.enabled()) opts.onPush()
    backoff = BACKOFF_MIN_MS
    connect()
  }

  function stop() {
    stopped = true
    disconnect()
    stopPolling()
    document.removeEventListener('visibilitychange', onVisible)
  }

  function start() {
    if (stopped) return
    if (usable) { connect(); return }
    // 連 fetch streaming 都沒有的環境（很舊的瀏覽器）直接走輪詢
    if (!MOCK) startPolling()
  }

  document.addEventListener('visibilitychange', onVisible)
  start()

  /* 登出要立刻把連線收掉，不能等下一次心跳失敗 —— 那條連線是用上一個人的
     token 開的，留著等於換人登入之後還在替前一個帳號收訊號。 */
  watch(() => opts.enabled(), on => {
    backoff = BACKOFF_MIN_MS
    if (on) { start(); return }
    disconnect()
    stopPolling()
  })

  /* 元件卸載就一定要中止 fetch：留著的話那條連線會活到瀏覽器分頁關掉為止，
     而且它的 onPush 還會打到已經卸載的元件上。 */
  onScopeDispose(stop)

  return { connected, stop }
}
