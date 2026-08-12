import { onBeforeUnmount, ref } from 'vue'

/**
 * 卡片隨游標傾斜 + 反光位置。
 * 用 rAF 節流，避免 pointermove 每一幀都觸發重排。
 */
export function useTilt(maxDeg = 16) {
  const el = ref<HTMLElement | null>(null)
  const rx = ref(0)
  const ry = ref(0)
  const gx = ref(50)
  const gy = ref(50)
  const active = ref(false)
  let raf = 0

  function onMove(e: PointerEvent) {
    const node = el.value
    if (!node) return
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      const r = node.getBoundingClientRect()
      const px = (e.clientX - r.left) / r.width
      const py = (e.clientY - r.top) / r.height
      ry.value = (px - 0.5) * 2 * maxDeg
      rx.value = -(py - 0.5) * 2 * maxDeg
      gx.value = px * 100
      gy.value = py * 100
      active.value = true
    })
  }

  function reset() {
    cancelAnimationFrame(raf)
    rx.value = 0; ry.value = 0
    gx.value = 50; gy.value = 50
    active.value = false
  }

  onBeforeUnmount(() => cancelAnimationFrame(raf))

  return { el, rx, ry, gx, gy, active, onMove, reset }
}
