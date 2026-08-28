<script setup lang="ts">
/**
 * 上傳前的裁切框。
 *
 * 為什麼自己寫而不是裝套件：這個專案的相依只有 vue / pinia / vue-router，
 * 沒有 UI 框架。需求只有「拖動、縮放、確認」三件事 —— 為了這個裝一套
 * 幾百 KB 的裁切器，等於為了省下的上傳流量再付一次下載流量回去。
 *
 * 互動模型是「框固定、圖在底下動」（iOS 相簿裁切那一種），不是「拉四個角」。
 * 理由是手指：44px 的角把手在 360px 寬的手機上會互相打架，而且拖角的時候
 * 手指正好蓋住你要對齊的那個角。框固定之後，單指=平移、雙指=縮放，
 * 兩個手勢都不需要精準命中任何東西。
 *
 * 比例是**選項**不是限制：'原圖' 保留整張（一格都不裁），另外給 5:7 卡片、
 * 方形、4:3。出貨照另外疊一條 5:7 虛線參考線 —— 幫助，不是強制。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  ASPECT_LABEL, ASPECT_RATIO, CARD_RATIO, FULL_FRAME,
  decodeOriented, fmtBytes, renderCrop, targetSize,
  type AspectId, type Decoded, type EditPolicy, type EncodeResult
} from '@/lib/image-edit'

const props = defineProps<{
  file: File
  policy: EditPolicy
  /** 這個用途的位元組上限，壓縮保證壓到這個數字以內 */
  maxBytes: number
  /** 第幾張 / 共幾張。一次選五張時要看得出還有幾張要處理 */
  index: number
  total: number
}>()

const emit = defineEmits<{
  /** result 為 null＝原檔已經夠好，不重新編碼（重壓一次只會白掉品質） */
  done: [EncodeResult | null]
  cancel: []
}>()

const MAX_ZOOM = 8

const stage = ref<HTMLDivElement | null>(null)
const cvs = ref<HTMLCanvasElement | null>(null)
const okBtn = ref<HTMLButtonElement | null>(null)

const loading = ref(true)
const working = ref(false)
const err = ref('')

let dec: Decoded | null = null
const img = reactive({ w: 0, h: 0 })
const box = reactive({ w: 0, h: 0 })

const aspect = ref<AspectId>(props.policy.initial)
/* 視圖狀態：z＝每個原圖像素畫成幾個 CSS 像素；cx/cy＝對齊在框中心的那個原圖座標。
   用「框中心對到哪個點」而不是「左上角位移」，是因為縮放要以中心／手指為錨點，
   後者每次都要換算，前者直接就是錨點本人。 */
const view = reactive({ z: 1, cx: 0, cy: 0 })

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

const frameAspect = computed(() =>
  aspect.value === 'source'
    ? (img.h ? img.w / img.h : 1)
    : ASPECT_RATIO[aspect.value as Exclude<AspectId, 'source'>])

/** 裁切框在畫布上的位置（CSS px） */
const frame = computed(() => {
  const pad = 12
  const aw = Math.max(40, box.w - pad * 2)
  const ah = Math.max(40, box.h - pad * 2)
  let w = aw
  let h = w / frameAspect.value
  if (h > ah) { h = ah; w = h * frameAspect.value }
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h }
})

/** 最小縮放＝框一定要被圖蓋滿。低於這個值框裡會出現空白，那個空白會被壓成白邊 */
const zMin = computed(() => {
  if (!img.w || !img.h) return 1
  return Math.max(frame.value.w / img.w, frame.value.h / img.h)
})

function clampView() {
  view.z = clamp(view.z, zMin.value, zMin.value * MAX_ZOOM)
  const hw = frame.value.w / (2 * view.z)
  const hh = frame.value.h / (2 * view.z)
  view.cx = hw * 2 >= img.w ? img.w / 2 : clamp(view.cx, hw, img.w - hw)
  view.cy = hh * 2 >= img.h ? img.h / 2 : clamp(view.cy, hh, img.h - hh)
}

/** 裁切範圍用比例，跟解碼時有沒有縮過無關 */
const crop = computed(() => {
  const hw = frame.value.w / (2 * view.z)
  const hh = frame.value.h / (2 * view.z)
  const w = Math.min(1, (hw * 2) / img.w)
  const h = Math.min(1, (hh * 2) / img.h)
  return {
    x: clamp((view.cx - hw) / img.w, 0, 1 - w),
    y: clamp((view.cy - hh) / img.h, 0, 1 - h),
    w, h
  }
})

/** 輸出尺寸：只縮不放，所以放大裁切一小塊的時候輸出會比上限小，這要讓使用者看到 */
const outSize = computed(() => {
  if (!dec) return { w: 0, h: 0 }
  return targetSize(dec, crop.value, props.policy.maxDim)
})

/* ---------- 畫 ---------- */
let raf = 0
function schedule() {
  if (raf) return
  raf = requestAnimationFrame(() => { raf = 0; draw() })
}

function draw() {
  const c = cvs.value
  if (!c || !dec || !box.w) return
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1)
  const pw = Math.round(box.w * dpr)
  const ph = Math.round(box.h * dpr)
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph }
  const x = c.getContext('2d')
  if (!x) return
  x.setTransform(dpr, 0, 0, dpr, 0, 0)
  x.clearRect(0, 0, box.w, box.h)

  const f = frame.value
  x.save()
  x.translate(f.x + f.w / 2, f.y + f.h / 2)
  x.scale(view.z, view.z)
  x.translate(-view.cx, -view.cy)
  x.imageSmoothingEnabled = true
  x.imageSmoothingQuality = 'high'
  x.drawImage(dec.source, 0, 0)
  x.restore()

  /* 框外壓暗。這是整個介面唯一在說「會被裁掉的是這些」的東西 ——
     沒有它，使用者不知道自己正在丟掉什麼 */
  x.fillStyle = 'rgba(0, 0, 0, .60)'
  x.fillRect(0, 0, box.w, f.y)
  x.fillRect(0, f.y + f.h, box.w, box.h - f.y - f.h)
  x.fillRect(0, f.y, f.x, f.h)
  x.fillRect(f.x + f.w, f.y, box.w - f.x - f.w, f.h)

  // 三分線：構圖用，淡到不干擾
  x.strokeStyle = 'rgba(255, 255, 255, .22)'
  x.lineWidth = 1
  x.beginPath()
  for (let i = 1; i < 3; i++) {
    x.moveTo(f.x + (f.w * i) / 3, f.y); x.lineTo(f.x + (f.w * i) / 3, f.y + f.h)
    x.moveTo(f.x, f.y + (f.h * i) / 3); x.lineTo(f.x + f.w, f.y + (f.h * i) / 3)
  }
  x.stroke()

  /* 5:7 參考線。只在「框本身不是 5:7」時畫 —— 已經是卡片比例還疊一條
     一模一樣的虛線只是噪音 */
  if (props.policy.cardGuide && Math.abs(frameAspect.value - CARD_RATIO) > 0.01) {
    let gw = f.w
    let gh = gw / CARD_RATIO
    if (gh > f.h) { gh = f.h; gw = gh * CARD_RATIO }
    x.save()
    x.strokeStyle = 'rgba(255, 255, 255, .62)'
    x.setLineDash([7, 6])
    x.lineWidth = 1.5
    x.strokeRect(f.x + (f.w - gw) / 2, f.y + (f.h - gh) / 2, gw, gh)
    x.restore()
  }

  x.strokeStyle = 'rgba(255, 255, 255, .96)'
  x.lineWidth = 2
  x.strokeRect(f.x + 1, f.y + 1, f.w - 2, f.h - 2)
}

watch([frame, () => view.z, () => view.cx, () => view.cy], schedule)

/* ---------- 手勢 ----------
   單指平移、雙指縮放。用 pointer 事件是因為滑鼠、觸控、觸控筆三種
   在這裡的行為完全一樣，分成 mouse* / touch* 兩套只會寫出兩份會分岔的程式。 */
const pts = new Map<number, { x: number; y: number }>()
let pinch = 0

const local = (e: PointerEvent) => {
  const r = cvs.value!.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}
const centroid = () => {
  let sx = 0, sy = 0
  for (const p of pts.values()) { sx += p.x; sy += p.y }
  return { x: sx / pts.size, y: sy / pts.size }
}
const spread = () => {
  const a = [...pts.values()]
  if (a.length < 2) return 0
  return Math.hypot(a[0]!.x - a[1]!.x, a[0]!.y - a[1]!.y)
}
/** 畫布座標 → 原圖座標 */
function toImage(p: { x: number; y: number }) {
  const f = frame.value
  return {
    x: view.cx + (p.x - (f.x + f.w / 2)) / view.z,
    y: view.cy + (p.y - (f.y + f.h / 2)) / view.z
  }
}

let anchor = { x: 0, y: 0 }
let anchorImg = { x: 0, y: 0 }

function onDown(e: PointerEvent) {
  /* 捕捉指標，手指滑出畫布邊界時手勢才不會斷在半路。
     包 try：某些情況（合成事件、Safari 的邊界狀況）這裡會丟
     「No active pointer with the given id」—— 捕捉失敗只是手勢會在邊界斷掉，
     不該讓整個 pointerdown 處理器掛掉，那才是真的動不了 */
  try { (e.target as HTMLElement).setPointerCapture?.(e.pointerId) } catch { /* 捕捉不到就算了 */ }
  pts.set(e.pointerId, local(e))
  anchor = centroid()
  anchorImg = toImage(anchor)
  pinch = spread()
}

function onMove(e: PointerEvent) {
  if (!pts.has(e.pointerId)) return
  e.preventDefault()
  pts.set(e.pointerId, local(e))
  const c = centroid()
  if (pts.size >= 2) {
    const d = spread()
    if (pinch > 4 && d > 4) view.z = clamp(view.z * (d / pinch), zMin.value, zMin.value * MAX_ZOOM)
    pinch = d
  }
  /* 讓「按下去的那個原圖點」跟著手指走 —— 平移與縮放共用同一條式子，
     所以雙指縮放的同時也可以順手挪位置，不必先放開再拖 */
  const f = frame.value
  view.cx = anchorImg.x - (c.x - (f.x + f.w / 2)) / view.z
  view.cy = anchorImg.y - (c.y - (f.y + f.h / 2)) / view.z
  clampView()
}

function onUp(e: PointerEvent) {
  pts.delete(e.pointerId)
  if (pts.size) { anchor = centroid(); anchorImg = toImage(anchor); pinch = spread() }
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const r = cvs.value!.getBoundingClientRect()
  const p = { x: e.clientX - r.left, y: e.clientY - r.top }
  const i = toImage(p)
  view.z = clamp(view.z * (e.deltaY < 0 ? 1.12 : 1 / 1.12), zMin.value, zMin.value * MAX_ZOOM)
  const f = frame.value
  view.cx = i.x - (p.x - (f.x + f.w / 2)) / view.z
  view.cy = i.y - (p.y - (f.y + f.h / 2)) / view.z
  clampView()
}

/* 滑桿：手指縮放在單手持機時很難，而且鍵盤使用者沒有雙指。
   兩者共用同一個 z，不是兩套狀態 */
const zoomPct = computed({
  get: () => Math.round((Math.log(view.z / zMin.value) / Math.log(MAX_ZOOM)) * 100),
  set: (v: number) => {
    view.z = zMin.value * Math.pow(MAX_ZOOM, clamp(v, 0, 100) / 100)
    clampView()
  }
})

function pickAspect(a: AspectId) {
  if (a === aspect.value) return
  aspect.value = a
  // 換比例之後框大小變了，縮放與位置要重新夾一次，否則框會跑到圖外面
  requestAnimationFrame(() => { view.z = Math.max(view.z, zMin.value); clampView(); schedule() })
}

/* ---------- 載入 ---------- */
let ro: ResizeObserver | null = null

function measure() {
  const el = stage.value
  if (!el) return
  box.w = el.clientWidth
  box.h = el.clientHeight
  clampView()
  schedule()
}

onMounted(async () => {
  // 開著裁切框時背景不該還能捲動，手指一滑整頁跑掉會讓人以為手勢壞了
  document.body.style.overflow = 'hidden'
  ro = new ResizeObserver(measure)
  if (stage.value) ro.observe(stage.value)
  try {
    dec = await decodeOriented(props.file)
    img.w = dec.width
    img.h = dec.height
    view.cx = img.w / 2
    view.cy = img.h / 2
    loading.value = false
    await new Promise(r => requestAnimationFrame(r))
    measure()
    view.z = zMin.value
    clampView()
    schedule()
    okBtn.value?.focus()
  } catch {
    loading.value = false
    err.value = '這張圖讀不進來，可能是檔案壞了。請換一張，或直接送出原檔。'
  }
})

onUnmounted(() => {
  document.body.style.overflow = ''
  ro?.disconnect()
  if (raf) cancelAnimationFrame(raf)
  dec?.close()
  dec = null
})

/* ---------- 送出 ---------- */
async function confirm() {
  if (!dec || working.value) return
  working.value = true
  err.value = ''
  try {
    emit('done', await renderCrop(dec, crop.value, props.policy, props.maxBytes))
  } catch (e) {
    working.value = false
    err.value = e instanceof Error ? e.message : '處理失敗，請重試'
  }
}

/**
 * 跳過裁切 ≠ 什麼都不做：整張保留，但該縮的還是要縮。
 * 真的縮不動又壓不小（本來就是小圖）才原檔照送 —— 那時重壓一次只會白掉品質。
 */
async function skip() {
  if (!dec || working.value) return
  working.value = true
  err.value = ''
  try {
    const t = targetSize(dec, FULL_FRAME, props.policy.maxDim)
    const r = await renderCrop(dec, FULL_FRAME, props.policy, props.maxBytes)
    const worthIt = t.scaled || r.bytes < props.file.size
    emit('done', worthIt || props.file.size > props.maxBytes ? r : null)
  } catch (e) {
    working.value = false
    err.value = e instanceof Error ? e.message : '處理失敗，請重試'
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('cancel')
}

const canSkip = computed(() => props.policy.aspects.includes('source'))
</script>

<template>
  <div class="icBack" role="dialog" aria-modal="true" aria-label="調整照片範圍" @keydown="onKey">
    <div class="icPanel">
      <header class="icHead">
        <div class="icTitleWrap">
          <h2 class="icTitle">調整{{ props.policy.label }}範圍</h2>
          <p class="icSub">
            <span v-if="props.total > 1" class="mono">第 {{ props.index + 1 }} / {{ props.total }} 張 · </span>
            拖動移動、雙指縮放
          </p>
        </div>
        <button type="button" class="icClose" aria-label="取消這張" @click="emit('cancel')">
          <svg viewBox="0 0 14 14" width="14" height="14" fill="none" aria-hidden="true"
               stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </header>

      <div ref="stage" class="icStage">
        <canvas
          ref="cvs" class="icCv" data-testid="cropper-canvas"
          @pointerdown="onDown" @pointermove="onMove"
          @pointerup="onUp" @pointercancel="onUp" @wheel="onWheel"
        ></canvas>
        <p v-if="loading" class="icBusy">讀取照片…</p>
        <p v-else-if="working" class="icBusy">壓縮中…</p>
      </div>

      <div class="icZoom">
        <span class="icZi" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none"
               stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <circle cx="7" cy="7" r="4.4" /><path d="M10.4 10.4 14 14" /><path d="M5 7h4" />
          </svg>
        </span>
        <input
          v-model.number="zoomPct" class="icRange" type="range" min="0" max="100" step="1"
          aria-label="縮放" data-testid="cropper-zoom"
        />
        <span class="icZi" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none"
               stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <circle cx="7" cy="7" r="4.4" /><path d="M10.4 10.4 14 14" />
            <path d="M5 7h4" /><path d="M7 5v4" />
          </svg>
        </span>
      </div>

      <div v-if="props.policy.aspects.length > 1" class="icChips" role="group" aria-label="裁切比例">
        <button
          v-for="a in props.policy.aspects" :key="a" type="button"
          class="icChip" :class="{ on: aspect === a }" :aria-pressed="aspect === a"
          :data-testid="`crop-aspect-${a}`" @click="pickAspect(a)"
        >{{ ASPECT_LABEL[a] }}</button>
      </div>

      <p class="icInfo mono">
        原圖 {{ img.w }}×{{ img.h }} · {{ fmtBytes(props.file.size) }}
        <span v-if="outSize.w">　輸出 {{ outSize.w }}×{{ outSize.h }}</span>
      </p>
      <p v-if="err" class="icErr" role="alert">{{ err }}</p>

      <footer class="icFoot">
        <button type="button" class="icBtn ghost" :disabled="working" @click="emit('cancel')">取消</button>
        <button
          v-if="canSkip" type="button" class="icBtn" :disabled="working || loading"
          data-testid="crop-skip" @click="skip"
        >跳過裁切</button>
        <button
          ref="okBtn" type="button" class="icBtn pri" :disabled="working || loading"
          data-testid="crop-confirm" @click="confirm"
        >{{ working ? '處理中…' : '使用這個範圍' }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.icBack {
  position: fixed; inset: 0; z-index: 90;
  display: grid; place-items: end center;
  background: rgba(0, 0, 0, .72);
  padding: 0;
}
@media (min-width: 700px) { .icBack { place-items: center; padding: 20px; } }

.icPanel {
  width: 100%; max-width: 560px; min-width: 0;
  display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto auto auto;
  gap: 10px;
  max-height: 100%;
  padding: 12px 14px calc(12px + var(--safe-b));
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
}
@media (min-width: 700px) { .icPanel { border-radius: var(--radius-lg); padding-bottom: 14px; } }

.icHead { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.icTitleWrap { min-width: 0; flex: 1; }
.icTitle { margin: 0; font-size: 15px; font-weight: 700; color: var(--ink); }
.icSub { margin: 3px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--muted); }

/* 44×44 的觸控目標，但不能用負的右邊界把它推出容器 ——
   推出去的 8px 會讓標題列自己就比面板寬（實測 371 > 363） */
.icClose {
  flex: none;
  width: 44px; height: 44px; min-width: 44px; min-height: 44px;
  margin: -8px 0 0 0;
  display: grid; place-items: center;
  padding: 0; border: 0; background: none; color: var(--muted); cursor: pointer;
}

.icStage {
  position: relative; min-width: 0; min-height: 0;
  height: 46vh;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg);
}
@media (min-width: 700px) { .icStage { height: 380px; } }

/* touch-action: none 是必要的：不關掉的話單指拖曳會被瀏覽器判成捲動，
   手勢只有第一下有反應，之後整個頁面跟著跑 */
.icCv { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
.icCv:active { cursor: grabbing; }

.icBusy {
  position: absolute; inset: 0; margin: 0;
  display: grid; place-items: center;
  font-size: 12.5px; color: var(--ink);
  background: rgba(0, 0, 0, .5);
}

.icZoom { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.icZi { color: var(--muted); display: grid; place-items: center; }
/* 高度給滿 44：滑桿的可點區域就是它自己的高度，18px 的滑桿在手機上抓不到 */
.icRange { min-width: 0; width: 100%; height: 44px; accent-color: var(--accent); cursor: pointer; }

.icChips { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
.icChip {
  min-height: 44px; padding: 0 15px;
  border-radius: var(--pill); border: 1px solid var(--line);
  background: var(--surface-2); color: var(--muted);
  font: inherit; font-size: 12.5px; cursor: pointer;
}
.icChip.on { background: var(--accent-wash); border-color: var(--accent); color: var(--ink); }

.icInfo { margin: 0; font-size: 11px; line-height: 1.6; color: var(--faint); overflow-wrap: anywhere; }
.icErr { margin: 0; font-size: 12px; line-height: 1.65; color: var(--danger-ink); overflow-wrap: anywhere; }

.icFoot { display: flex; flex-wrap: wrap; gap: 8px; }
.icBtn {
  flex: 1 1 auto; min-width: 0;
  min-height: 44px; padding: 0 16px;
  border-radius: var(--pill); border: 1px solid var(--line);
  background: var(--surface-2); color: var(--ink);
  font: inherit; font-size: 13px; cursor: pointer;
}
.icBtn.ghost { flex: 0 1 auto; background: none; color: var(--muted); }
.icBtn.pri { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 700; }
.icBtn:disabled { opacity: .55; cursor: default; }
</style>
