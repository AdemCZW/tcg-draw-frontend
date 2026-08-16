<script setup lang="ts">
/**
 * 數字滾動 —— 值變了就從舊值滾到新值。
 *
 * 三條規則：
 * 1. 初次掛載直接顯示終值。每次進頁面都從 0 數到 100,000,000 是噪音不是回饋
 * 2. tabular-nums：位數不等寬的話滾動時整行會左右抖
 * 3. reduce-motion 直接跳到終值
 *
 * 用 setTimeout 步進而不是 rAF：分頁不可見時 rAF 不推進，數字會卡在半途；
 * setTimeout 被節流也只是慢，最後一定停在終值（每一步都是算出來的絕對值，
 * 不是累加，所以掉幀不會漂）。
 */
import { onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  value: number
  /** 滾動長度（毫秒） */
  duration?: number
  /** 小數位；點數都是整數 */
  decimals?: number
}>(), { duration: 620, decimals: 0 })

const shown = ref(props.value)
/** 增加時閃綠、減少時閃暗 —— 方向要看得出來 */
const dir = ref<'up' | 'down' | ''>('')

let timer: number | undefined
let dirTimer: number | undefined
const STEP = 32   // 約 30fps；再密沒有意義，數字本來就是離散的

const reduce = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

function roll(from: number, to: number) {
  clearTimeout(timer)
  if (reduce() || from === to) { shown.value = to; return }
  const t0 = performance.now()
  const tick = () => {
    const p = Math.min(1, (performance.now() - t0) / props.duration)
    shown.value = from + (to - from) * easeOut(p)
    if (p < 1) timer = window.setTimeout(tick, STEP)
    else shown.value = to
  }
  tick()
}

watch(() => props.value, (to, from) => {
  roll(from, to)
  dir.value = to > from ? 'up' : to < from ? 'down' : ''
  clearTimeout(dirTimer)
  dirTimer = window.setTimeout(() => { dir.value = '' }, props.duration + 300)
})
onBeforeUnmount(() => { clearTimeout(timer); clearTimeout(dirTimer) })

const fmt = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: props.decimals, maximumFractionDigits: props.decimals })
</script>

<template>
  <span class="roll" :class="dir">{{ fmt(shown) }}</span>
</template>

<style scoped>
.roll {
  font-variant-numeric: tabular-nums;
  transition: color .25s ease;
}
.roll.up { color: var(--ok); }
.roll.down { color: var(--muted); }
</style>
