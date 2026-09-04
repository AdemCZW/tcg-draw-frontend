<script setup lang="ts">
/**
 * 四角拖曳的透視校正編輯器。
 *
 * ── 為什麼是手動拖四個角，而不是自動偵測卡片邊緣 ─────────────────────
 * 自動偵測（Canny + 霍夫直線 + 找最大四邊形）在乾淨背景上很漂亮，
 * 但它會失敗：卡放在有花紋的桌布上、光線在卡面反光、旁邊還有別張卡。
 * 一旦失敗就要有「偵測不到怎麼辦」的分支，而那個分支的答案還是
 * 「請使用者自己標」—— 那不如先把那條路做對做好。
 * 手動拖曳 100% 可靠、不需要任何 CV 函式庫、沒有失敗分支，
 * 而且使用者一看就懂在做什麼。
 * 之後要加自動偵測，是加成「先自動猜一次，四個角照樣可以微調」，
 * 這個元件不用改。
 *
 * ── 觸控細節 ─────────────────────────────────────────────────────────
 * 把手的**視覺**是 22px 的圓，**熱區**是 48px 的透明方塊（≥44px）。
 * 拖曳中把手上移一段距離（LIFT），否則手指會蓋住自己正在對的那個角。
 */
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import type { Pt } from '../perspective'
import { orderQuad } from '../perspective'

const props = defineProps<{
  photo: ImageBitmap
  /** 四角，照片自己的像素座標 */
  modelValue: Pt[]
}>()
const emit = defineEmits<{ 'update:modelValue': [Pt[]] }>()

const stage = useTemplateRef<HTMLDivElement>('stage')
const canvas = useTemplateRef<HTMLCanvasElement>('canvas')

/** 拖曳中把手往上抬多少（畫面像素），讓手指不擋住角點 */
const LIFT = 34
const dragging = ref<number | null>(null)

/** 照片畫進 canvas。只在 photo 換掉時做一次。 */
function paint() {
  const c = canvas.value
  if (!c || !props.photo) return
  c.width = props.photo.width
  c.height = props.photo.height
  const ctx = c.getContext('2d')
  if (!ctx) return
  ctx.drawImage(props.photo, 0, 0)
}
/* 掛載後畫一次，之後 photo 換掉再畫。
   **不能只靠 watch 的 immediate**：immediate 的那一次是在 setup 階段跑的，
   那時 canvas 的 template ref 還是 null，paint() 直接 return，
   結果 canvas 停在預設的 300×150、照片從頭到尾沒出現過（畫面上只看得到
   四邊形的紅色框，看起來像「照片載入失敗」）。這個錯不會丟例外，
   是截圖比對才發現的。 */
onMounted(paint)
watch(() => props.photo, paint, { flush: 'post' })

/** 四角換算成百分比，把手用百分比定位就不必監聽容器尺寸變化 */
const handles = computed(() => props.modelValue.map(p => ({
  left: `${(p.x / props.photo.width) * 100}%`,
  top: `${(p.y / props.photo.height) * 100}%`
})))

const polygon = computed(() =>
  props.modelValue.map(p => `${p.x},${p.y}`).join(' ')
)

function toPhoto(clientX: number, clientY: number): Pt {
  const el = stage.value
  if (!el) return { x: 0, y: 0 }
  const r = el.getBoundingClientRect()
  const x = ((clientX - r.left) / r.width) * props.photo.width
  const y = ((clientY - r.top + LIFT) / r.height) * props.photo.height
  return {
    x: Math.min(props.photo.width, Math.max(0, x)),
    y: Math.min(props.photo.height, Math.max(0, y))
  }
}

function onDown(i: number, e: PointerEvent) {
  dragging.value = i
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}
function onMove(i: number, e: PointerEvent) {
  if (dragging.value !== i) return
  const next = [...props.modelValue]
  next[i] = toPhoto(e.clientX, e.clientY)
  emit('update:modelValue', next)
}
function onUp() {
  if (dragging.value === null) return
  dragging.value = null
  /* 放手時重排一次順序。使用者可以把「左上」那顆拖到右邊去，
     順序亂掉的話 homography 會把卡片扭成蝴蝶結。在放手時做而不是
     拖曳過程中做：中途重排會讓把手在手指底下跳掉。 */
  emit('update:modelValue', orderQuad(props.modelValue))
}

onBeforeUnmount(() => { dragging.value = null })

const CORNER_LABELS = ['左上', '右上', '右下', '左下']

/** 鍵盤微調：桌機驗收與無障礙都需要，方向鍵一次 1px、Shift 一次 10px */
function onKey(i: number, e: KeyboardEvent) {
  const step = e.shiftKey ? 10 : 1
  const d: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]
  }
  const move = d[e.key]
  if (!move) return
  e.preventDefault()
  const next = [...props.modelValue]
  const p = next[i]!
  next[i] = {
    x: Math.min(props.photo.width, Math.max(0, p.x + move[0])),
    y: Math.min(props.photo.height, Math.max(0, p.y + move[1]))
  }
  emit('update:modelValue', next)
}
</script>

<template>
  <div ref="stage" class="quad">
    <canvas ref="canvas" class="photo" />
    <svg class="ink" :viewBox="`0 0 ${photo.width} ${photo.height}`" preserveAspectRatio="none"
         aria-hidden="true">
      <polygon :points="polygon" />
      <polyline :points="`${polygon} ${modelValue[0]?.x},${modelValue[0]?.y}`" />
    </svg>
    <button
      v-for="(h, i) in handles" :key="i"
      class="grip" :class="{ on: dragging === i }" :style="h"
      type="button"
      :aria-label="`${CORNER_LABELS[i]}角，方向鍵可微調`"
      :data-corner="i"
      @pointerdown="onDown(i, $event)"
      @pointermove="onMove(i, $event)"
      @pointerup="onUp"
      @pointercancel="onUp"
      @keydown="onKey(i, $event)"
    ><span class="dot" /></button>
  </div>
</template>

<style scoped>
.quad {
  position: relative;
  width: 100%;
  /* 圖片自己決定高度。不用 grid + place-items + max-height:100%
     —— 那組合的百分比解析不出來，容器會溢出（規格 §10.4）。 */
  display: flex;
  border-radius: 14px;
  overflow: hidden;
  background: var(--field);
  touch-action: none;          /* 拖角時不要讓瀏覽器捲頁 */
  user-select: none;
  -webkit-user-select: none;
}
.photo { display: block; width: 100%; height: auto; }

.ink { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.ink polygon { fill: rgba(247, 59, 32, .14); stroke: none; }
/* vector-effect 讓線寬不被 viewBox 的非等比縮放拉扁 */
.ink polyline {
  fill: none; stroke: var(--accent); stroke-width: 3;
  vector-effect: non-scaling-stroke;
}

.grip {
  position: absolute;
  width: 48px; height: 48px;      /* 觸控熱區 ≥44px */
  margin: -24px 0 0 -24px;
  padding: 0; border: 0; background: none;
  display: flex; align-items: center; justify-content: center;
  cursor: grab;
  touch-action: none;
  -webkit-touch-callout: none;
}
.grip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 50%; }
.dot {
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 3px rgba(255, 255, 255, .9), 0 2px 8px rgba(0, 0, 0, .5);
  transition: transform .12s ease;
}
.grip.on { cursor: grabbing; }
.grip.on .dot { transform: scale(1.35); }
</style>
