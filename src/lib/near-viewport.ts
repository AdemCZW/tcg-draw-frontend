/**
 * 「這個元素快進入畫面了嗎」。
 *
 * 為什麼需要：卡圖的網址不是現成的，要先打 PSA（鑑定實拍）或 TCGdex（官方卡圖）
 * 才查得到。原本每張卡一掛載就查，於是開一頁 40 張卡＝瞬間 80 個請求，
 * 250 格的池更誇張 —— 畫面外的卡把頻寬吃光，使用者正在看的那幾張反而最慢。
 * `<img loading="lazy">` 救不了這個：那只管圖片本身，網址早就查完了。
 *
 * 共用同一個 IntersectionObserver：每張卡各開一個的話，光是建立觀察器的成本
 * 在長列表上就很可觀。
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/* 提前 400px 開始查。太小會看到卡片先空白一下才出圖，
   太大就退化回「全部一起載」失去意義。 */
const ROOT_MARGIN = '400px'

/** 不靠 IntersectionObserver 的即時判斷。ROOT_MARGIN 換算成像素 */
const MARGIN_PX = parseInt(ROOT_MARGIN, 10)
function inRange(el: Element): boolean {
  const r = el.getBoundingClientRect()
  const h = window.innerHeight || 0
  const w = window.innerWidth || 0
  return r.bottom > -MARGIN_PX && r.top < h + MARGIN_PX
      && r.right > -MARGIN_PX && r.left < w + MARGIN_PX
}

type Cb = () => void
const callbacks = new WeakMap<Element, Cb>()
let observer: IntersectionObserver | null = null

function shared(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null
  observer ??= new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      const cb = callbacks.get(e.target)
      // 一次性：查過就不再觀察，長列表捲來捲去不會重複觸發
      observer?.unobserve(e.target)
      callbacks.delete(e.target)
      cb?.()
    }
  }, { rootMargin: ROOT_MARGIN })
  return observer
}

/**
 * 回傳 { el, near }：把 el 綁到要觀察的節點，near 在它接近畫面時變成 true。
 *
 * 沒有 IntersectionObserver 的環境（很舊的瀏覽器、SSR、測試）直接回 true ——
 * 寧可退回「全部載入」的舊行為，也不要因為偵測不到而永遠不顯示圖。
 */
export function useNearViewport() {
  const el = ref<HTMLElement | null>(null)
  const near = ref(typeof IntersectionObserver === 'undefined')

  onMounted(() => {
    if (near.value || !el.value) return

    /* 先直接量一次幾何。兩個理由：
       1. 首屏的卡不必等 IntersectionObserver 的第一次回呼，量到在範圍內就馬上載
       2. 保險絲 —— IO 在某些情況下不會觸發（例如整個文件處於隱藏狀態時
          瀏覽器不做渲染，回呼會一直排隊）。只靠 IO 的話那種情況下圖永遠不出來，
          那比多載幾張圖嚴重得多。 */
    if (inRange(el.value)) { near.value = true; return }

    const io = shared()
    if (!io) { near.value = true; return }
    callbacks.set(el.value, () => { near.value = true })
    io.observe(el.value)
  })

  onBeforeUnmount(() => {
    if (!el.value) return
    observer?.unobserve(el.value)
    callbacks.delete(el.value)
  })

  return { el, near } as { el: Ref<HTMLElement | null>; near: Ref<boolean> }
}
