import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * 追蹤一條媒體查詢的結果。
 *
 * 為什麼需要它：斷點只要是「由呼叫端決定」的（不同頁面不同寬度），CSS 的
 * @media 條件就寫不出來 —— 它吃不到 prop。matchMedia 是事件驅動的，
 * 不像 resize 監聽那樣每一幀都醒過來，也不像 rAF 會在背景分頁被節流。
 *
 * query 傳 null 代表「這個情境根本不需要斷點」，那就連監聽都不要掛。
 */
export function useMediaQuery(query: string | null): Ref<boolean> {
  const matches = ref(false)
  if (!query) return matches

  let mq: MediaQueryList | null = null
  const onChange = (e: MediaQueryListEvent) => { matches.value = e.matches }

  onMounted(() => {
    mq = window.matchMedia(query)
    matches.value = mq.matches
    mq.addEventListener('change', onChange)
  })
  onBeforeUnmount(() => mq?.removeEventListener('change', onChange))

  return matches
}
