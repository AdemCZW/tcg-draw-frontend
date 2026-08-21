/**
 * 無限捲動的列表狀態。
 *
 * 卡冊、公開卡冊、市場三頁共用同一份 —— 這幾件事各寫一份的話，
 * 「防重複觸發」「請求競態」「卸載時要斷開觀察器」這三個容易漏的地方
 * 就要各對一次，而漏掉任何一個的症狀都是「偶爾才發生」，很難被測出來。
 *
 * ---- 為什麼用 IntersectionObserver 而不是 scroll 事件 ----
 * scroll 在手機上一次滑動會連發上百次，要自己節流；而且真正要問的問題是
 * 「列表末端進畫面了嗎」，那是幾何問題不是事件問題。IO 由瀏覽器在合成緒上算，
 * 不會跟捲動搶主緒，也不需要在每次回呼裡讀 scrollTop（那會強制重排）。
 *
 * ---- 為什麼哨兵要提前 400px 觸發 ----
 * 等哨兵真的進畫面才發請求，使用者會先看到一段空白再等一個來回。
 * 提前一屏左右開始抓，捲到底時下一批通常已經在畫面上了。
 * 這個數字跟 lib/near-viewport.ts 的卡圖預載是同一個量級，刻意保持一致。
 */
import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'

export interface Page<T> { items: T[]; nextCursor: string | null }

/** signal 一定要往下傳進 fetch，否則切換分頁時舊請求還會跑完 */
export type PageFetcher<T> = (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>

const ROOT_MARGIN = '400px'
const MARGIN_PX = parseInt(ROOT_MARGIN, 10)

/** 模板 ref 掛在元件上時拿到的是元件實例，掛在元素上才是 HTMLElement —— 兩種都收 */
function elementOf(v: unknown): HTMLElement | null {
  if (v instanceof HTMLElement) return v
  const root = (v as { $el?: unknown } | null | undefined)?.$el
  return root instanceof HTMLElement ? root : null
}

/**
 * 不靠 IntersectionObserver 的即時判斷（跟 lib/near-viewport.ts 同一套）。
 *
 * 這不是可有可無的備援。IO 的回呼是排在「渲染步驟」裡送的，而分頁在背景時
 * （document.hidden）瀏覽器不做渲染 —— 回呼會一直排隊不送。只靠 IO 的話，
 * 在那種狀態下列表會永遠停在第一批。getBoundingClientRect 是同步讀的，不受影響。
 *
 * 它同時解決另一件事：第一批沒填滿一屏時哨兵還留在觸發範圍裡，
 * 而 IO 只在「相交狀態改變」時回呼，不會再送第二次。
 */
function inRange(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.bottom > -MARGIN_PX && r.top < (window.innerHeight || 0) + MARGIN_PX
}

export function useInfiniteList<T>(fetchPage: PageFetcher<T>) {
  const items = ref<T[]>([]) as Ref<T[]>
  /** 任何一批載入中。第一批與後續批次靠 ready 區分，兩者的畫面不一樣 */
  const loading = ref(false)
  /** 第一批已經有結果（成功或失敗）。在那之前顯示骨架，不是「沒有資料」 */
  const ready = ref(false)
  const done = ref(false)
  const error = ref('')
  /* 原始的例外也留著。錯誤訊息是給人看的字串，但頁面有時要看 ApiError.code
     才知道該畫哪一種畫面（例如公開卡冊要分辨「連結不存在」與「已改成不公開」）。 */
  const lastError = ref<unknown>(null)
  const sentinel = ref<unknown>(null)
  /* 沒有 IntersectionObserver 的環境（很舊的瀏覽器、測試環境）要退回一顆
     「載入更多」按鈕。靜靜地停在第一頁比較糟：使用者看不出還有東西沒載。 */
  const manual = ref(typeof IntersectionObserver === 'undefined')

  let cursor: string | null = null
  /* 遞增的世代編號。切換狀態分頁時 +1，舊世代的回應一律丟掉 ——
     先發的請求後回來是很常見的（第一頁的查詢本來就比較慢），
     沒有這道防線的話快速連按分頁會把上一個分頁的卡片蓋到新分頁上。
     abort 只斷得掉還在傳輸的，已經在解析中的回應仍然會走完 then，
     所以世代檢查是必要的，不是保險。 */
  let gen = 0
  let ctrl: AbortController | null = null
  let io: IntersectionObserver | null = null

  /** 哨兵現在在不在觸發範圍內。每次都重新量，不要記在變數裡放到過期 */
  function nearEnd(): boolean {
    const el = elementOf(sentinel.value)
    return !!el && inRange(el)
  }

  async function load(): Promise<void> {
    // 載入中不再發：IO 在捲動時會連續回呼，沒有這行會一次噴好幾個請求
    if (loading.value || done.value || error.value) return
    const my = gen
    const ac = new AbortController()
    ctrl = ac
    loading.value = true
    let advanced = false
    try {
      const page = await fetchPage(cursor, ac.signal)
      if (my !== gen) return
      // cursor 為 null 代表這是第一批 —— 換掉而不是接上去，才不會殘留上一個分頁的資料
      items.value = cursor === null ? page.items : items.value.concat(page.items)
      cursor = page.nextCursor
      advanced = true
      /* 沒有下一頁就把觀察器斷開。留著的話使用者在底部來回捲動仍然會一直回呼，
         每次都要走一遍上面的判斷，白花主緒的時間。 */
      if (cursor === null) { done.value = true; disconnect() }
    } catch (e) {
      if (my !== gen || ac.signal.aborted) return
      lastError.value = e
      error.value = e instanceof Error ? e.message : '載入失敗'
    } finally {
      if (my === gen) { loading.value = false; ready.value = true }
    }
    /* 這一批載完之後哨兵可能還在範圍內（第一批沒填滿一屏），自己補一輪。
       一定要等 nextTick：剛剛只是改了 items，DOM 還沒重繪，這時量到的
       哨兵位置是「上一批的」—— 用它判斷會永遠成立，一次把整份清單抓下來，
       分頁等於白做。 */
    if (advanced && my === gen && !done.value) {
      await nextTick()
      if (my === gen && !done.value && nearEnd()) await load()
    }
  }

  function connect() {
    disconnect()
    const el = elementOf(sentinel.value)
    if (!el || typeof IntersectionObserver === 'undefined') return
    io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) void load()
    }, { rootMargin: ROOT_MARGIN })
    io.observe(el)
    // 哨兵是後來才出現的（v-if 切過去）時，它可能一掛上去就已經在範圍內
    if (!loading.value && !done.value && !error.value && inRange(el)) void load()
  }

  /* 捲動時的保險絲。IO 在文件隱藏或某些捲動容器的組合下不一定送得出回呼，
     而「捲到底卻不再載入」是這個功能唯一不能出的錯。
     這裡只讀一次 getBoundingClientRect 並且 passive，不會拖慢捲動；
     真正的節流是 load() 自己的「載入中就不再發」。 */
  function onScroll() {
    if (!done.value && !loading.value && !error.value && nearEnd()) void load()
  }

  function disconnect() {
    io?.disconnect()
    io = null
  }

  /** 換一組查詢條件（例如切換狀態分頁）：清空、回到第一頁、重新觀察 */
  function reset() {
    gen++
    ctrl?.abort()
    ctrl = null
    items.value = []
    cursor = null
    done.value = false
    error.value = ''
    lastError.value = null
    loading.value = false
    ready.value = false
    connect()
    void load()
  }

  /** 失敗之後的重試。error 沒清掉之前 load() 是不動的，避免壞掉的端點被捲動狂打 */
  function retry() {
    error.value = ''
    lastError.value = null
    void load()
  }

  // 哨兵是模板 ref，掛載前是 null；元素換掉（v-if 切換）時也要重新觀察
  watch(sentinel, () => { if (!done.value) connect() }, { flush: 'post' })

  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
  window.addEventListener('resize', onScroll, { passive: true })

  onBeforeUnmount(() => {
    // 換頁不要留下觀察器、監聽器與還在飛的請求
    disconnect()
    window.removeEventListener('scroll', onScroll, { capture: true })
    window.removeEventListener('resize', onScroll)
    gen++
    ctrl?.abort()
  })

  return { items, loading, ready, done, error, lastError, manual, sentinel, load, reset, retry }
}
