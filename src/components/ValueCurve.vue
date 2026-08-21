<script setup lang="ts">
/**
 * 收藏總值累積曲線。
 *
 * ---- 為什麼畫「累積」而不是「每張卡的價格分佈」 ----
 * 收藏者打開卡冊時想確認的是「我的收藏長多快」，那是一條隨時間往上疊的線。
 * 單張價格的分佈只回答「哪張最貴」，而那個問題總覽第一行已經答完了 ——
 * 同一個畫面用兩塊面積回答同一個問題是浪費。
 *
 * ---- 為什麼是階梯線而不是平滑曲線 ----
 * 收藏總值不是連續變動的量：兩次抽卡之間它完全不動，抽中的那一刻整個跳上去。
 * 畫成平滑曲線等於捏造「中間那幾天也在慢慢增值」，那是假的。
 * 階梯的水平段就是「這段期間沒有新卡」，這件事本身也是資訊。
 *
 * ---- 為什麼自己畫 SVG ----
 * 專案的原則是不加相依套件。而且圖表庫一律自帶一套顏色與字體，
 * 要把它接回 tokens.css 的變數，比自己組一條 path 還費工。
 *
 * ---- 為什麼要量容器寬度而不是固定 viewBox ----
 * 固定 viewBox + width:100% 會讓整張圖等比縮放，於是 320px 手機上
 * 10px 的軸標籤實際只有 8px、2px 的線只剩 1.6px。改成用 ResizeObserver
 * 取實際寬度當 viewBox 寬度，圖形永遠 1:1，字級與線寬在每個螢幕上都一致。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/* 只收畫得出曲線所需的三個欄位，不收整個 UserPrize。
   卡冊的列表改成分批載入之後，曲線的資料來自後端的總覽端點
   （那裡只投影 wonAt / name / refPrice，不帶整包 card），
   而 UserPrize[] 仍然餵得進來 —— 結構上相容。 */
const props = defineProps<{ prizes: { wonAt: string; card: { refPrice: number; name: string } }[] }>()

/* 座標系。上下留白要含得住端點標籤與 x 軸文字 ——
   容器高度沒把軸帶算進去，是圖表最常見的破法（軸標籤被切掉或長出捲軸）。 */
const H = 152
const PAD = { l: 44, r: 12, t: 18, b: 24 }
const plotH = H - PAD.t - PAD.b

const box = ref<HTMLElement | null>(null)
const w = ref(320)
let ro: ResizeObserver | undefined
function measure(cw: number) {
  if (cw > 0 && Math.round(cw) !== w.value) w.value = Math.round(cw)
}
onMounted(() => {
  if (!box.value) return
  /* 先同步量一次再掛觀察器。ResizeObserver 的回呼是排在「渲染步驟」裡送的，
     分頁在背景（document.hidden）時那個步驟被節流，第一次的初始通知可能遲遲不來 ——
     圖就會停在預設的 320 寬度，在 430px 的螢幕上整張被拉大、字級跟著失真。
     clientWidth 是同步讀的，不受節流影響。 */
  measure(box.value.clientWidth)
  ro = new ResizeObserver(es => measure(es[0].contentRect.width))
  ro.observe(box.value)
  /* 同樣的節流也會吃掉「轉螢幕方向」那一次通知，那是手機上唯一會改寬度的操作。
     resize 事件不走渲染步驟，補一條同步的路，圖才不會停在直式的寬度。 */
  window.addEventListener('resize', onWinResize)
})
function onWinResize() {
  if (box.value) measure(box.value.clientWidth)
}
onBeforeUnmount(() => {
  ro?.disconnect()
  window.removeEventListener('resize', onWinResize)
})

const plotW = computed(() => Math.max(60, w.value - PAD.l - PAD.r))

function fmtDay(t: number) {
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
function fmtFull(t: number) {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* 依取得時間排序後逐張累加。
   wonAt 解析不出來的直接丟掉：退回 0 會讓那筆排到 1970 年，
   整條時間軸被拉成一條貼著右邊的直線，比少畫一個點糟得多。 */
const pts = computed(() => {
  const rows = props.prizes
    .map(p => ({ t: Date.parse(p.wonAt), price: p.card.refPrice || 0, name: p.card.name }))
    .filter(r => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t)
  let sum = 0
  return rows.map(r => {
    sum += r.price
    return { t: r.t, total: sum, delta: r.price, name: r.name, day: fmtDay(r.t), full: fmtFull(r.t) }
  })
})

const last = computed(() => pts.value.length - 1)

/* 軸上界取整。直接用實際總值當上界，線的端點會頂到頂邊，
   端點標籤就沒地方放；取到整數階也讓刻度讀起來是人話。 */
function niceCeil(v: number) {
  if (v <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(v))
  const n = v / mag
  /* 階要夠細。只有 1 / 2 / 5 / 10 的話，53,380 會被推到 10 萬，
     整條線被壓在下半部，看起來像沒漲 —— 上界的留白不該多過資料本身 */
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(s => n <= s) ?? 10
  return step * mag
}
const yMax = computed(() => niceCeil(pts.value[last.value]?.total ?? 0))
const ticks = computed(() => [0, yMax.value / 2, yMax.value])

/* 同一次抽卡的好幾張會共用同一個 wonAt。全部同時間時時間跨距為 0，
   除下去是 NaN，整條 path 會消失 —— 退回用序號等距排，圖仍然成立。 */
const span = computed(() => (pts.value[last.value]?.t ?? 0) - (pts.value[0]?.t ?? 0))
function x(i: number) {
  const p = pts.value
  if (p.length < 2) return PAD.l + plotW.value
  const r = span.value > 0 ? (p[i].t - p[0].t) / span.value : i / (p.length - 1)
  return PAD.l + r * plotW.value
}
function y(v: number) {
  return PAD.t + plotH - (v / yMax.value) * plotH
}

const linePath = computed(() => {
  const p = pts.value
  if (p.length < 2) return ''
  let d = `M ${x(0)} ${y(p[0].total)}`
  // 先水平走到下一次取得的時間點，再垂直跳上去 —— 值是在「抽中的那一刻」才變的
  for (let i = 1; i < p.length; i++) d += ` L ${x(i)} ${y(p[i - 1].total)} L ${x(i)} ${y(p[i].total)}`
  return d
})
const areaPath = computed(() => {
  const p = pts.value
  if (p.length < 2) return ''
  const base = PAD.t + plotH
  return `${linePath.value} L ${x(last.value)} ${base} L ${x(0)} ${base} Z`
})

/* ---- 掃描讀值 ----
   手機沒有 hover，而浮動 tooltip 在 375px 寬的卡片裡不是被邊界擠掉就是蓋住線。
   改成把讀數放在圖表標題那一行：手指滑到哪，上面那行就講哪一點。
   沒在滑的時候顯示最後一點，所以「最終總值」永遠看得到，不必先互動。 */
const hover = ref<number | null>(null)
const active = computed(() => hover.value ?? last.value)

function scrub(e: PointerEvent) {
  const el = e.currentTarget as SVGSVGElement
  const r = el.getBoundingClientRect()
  if (!r.width) return
  // viewBox 寬度就是量到的容器寬度，但兩者之間可能差一次 layout，換算一下比較保險
  const px = (e.clientX - r.left) * (w.value / r.width)
  let best = 0
  let bd = Infinity
  for (let i = 0; i < pts.value.length; i++) {
    const d = Math.abs(x(i) - px)
    if (d < bd) { bd = d; best = i }
  }
  hover.value = best
}

function fmtTick(v: number) {
  if (v === 0) return '0'
  /* 五位數以上換成「萬」，否則 44px 的軸帶塞不下 "120,000" 這種字串。
     取兩位小數再用 Number() 把尾數的 0 吃掉：中位刻度常常是 1.25 萬這種數，
     四捨五入到一位會變成 1.3 萬 —— 刻度標錯值比標得長還糟 */
  if (v >= 10000) return `${Number((v / 10000).toFixed(2))} 萬`
  return v.toLocaleString()
}

const cur = computed(() => pts.value[active.value])
const sub = computed(() => {
  const p = pts.value
  if (!p.length) return ''
  if (hover.value === null) return `${p[0].full} 起 · ${p.length} 張`
  const c = p[hover.value]
  return `${c.full} · ${c.name} +${c.delta.toLocaleString()}`
})

/* 端點標籤靠近右邊界時要改成向左展開，否則字會被切掉。
   （寧可換錨點也不要讓 SVG overflow —— 那在卡片裡會被 border-radius 裁掉） */
const labelX = computed(() => {
  const px = x(active.value)
  return px > w.value * 0.55 ? px - 8 : px + 8
})
const labelAnchor = computed(() => (x(active.value) > w.value * 0.55 ? 'end' : 'start'))
const labelY = computed(() => Math.max(PAD.t + 11, y(cur.value?.total ?? 0) - 10))

const aria = computed(() => {
  const p = pts.value
  if (p.length < 2) return '收藏總值累積曲線，資料不足'
  return `收藏總值累積曲線：${p[0].full} 到 ${p[last.value].full} 之間取得 ${p.length} 張卡，`
    + `總值從 ${p[0].total.toLocaleString()} 點一路累積到 ${p[last.value].total.toLocaleString()} 點。`
})
</script>

<template>
  <figure ref="box" class="curve">
    <figcaption class="head">
      <span class="cap">收藏總值累積</span>
      <span class="sub mono">{{ sub }}</span>
    </figcaption>

    <!-- 只有一張卡時沒有「累積」可言。硬畫一個孤點的折線圖是在假裝有趨勢，
         不如老實講現況，順便告訴使用者要看到曲線需要什麼 -->
    <p v-if="pts.length < 2" class="lone">
      <template v-if="pts.length">
        <strong class="mono">{{ pts[0].full }}</strong> 取得第一張，目前總值
        <strong class="mono val">{{ pts[0].total.toLocaleString() }}</strong> 點。
        再收一張就會開始畫出累積曲線。
      </template>
      <template v-else>還沒有可以計算的卡片。</template>
    </p>

    <svg
      v-else
      class="plot"
      :viewBox="`0 0 ${w} ${H}`"
      role="img"
      :aria-label="aria"
      @pointermove="scrub"
      @pointerdown="scrub"
      @pointerleave="hover = null"
      @pointercancel="hover = null"
    >
      <!-- 格線：實線髮絲、只比表面亮一階。虛線會被讀成「預測值」，這裡沒有預測 -->
      <g class="gridlines" aria-hidden="true">
        <line v-for="t in ticks" :key="`g${t}`" :x1="PAD.l" :x2="w - PAD.r" :y1="y(t)" :y2="y(t)" />
      </g>
      <g class="ytick" aria-hidden="true">
        <text v-for="t in ticks" :key="`t${t}`" :x="PAD.l - 8" :y="y(t) + 3.5" text-anchor="end">
          {{ fmtTick(t) }}
        </text>
      </g>

      <path class="area" :d="areaPath" />
      <path class="line" :d="linePath" />

      <line
        v-if="hover !== null" class="cross"
        :x1="x(active)" :x2="x(active)" :y1="PAD.t" :y2="PAD.t + plotH"
      />

      <!-- 端點只標一顆。每個點都標數字在 50 張的情況下會糊成一團，也沒人讀 -->
      <circle class="dot" :cx="x(active)" :cy="y(cur.total)" r="4.5" />
      <text class="endval mono" :x="labelX" :y="labelY" :text-anchor="labelAnchor">
        {{ cur.total.toLocaleString() }}
      </text>

      <text class="xtick mono" :x="PAD.l" :y="H - 6" text-anchor="start">{{ pts[0].day }}</text>
      <text class="xtick mono" :x="w - PAD.r" :y="H - 6" text-anchor="end">{{ pts[last].day }}</text>
    </svg>

    <!-- 掃描讀值是加分項，不能是唯一的取得管道：不用觸控也要讀得到每一筆。
         預設收起來，展開才佔高度 -->
    <details v-if="pts.length > 1" class="tbl">
      <summary>逐張數字</summary>
      <table>
        <thead><tr><th>取得</th><th>卡片</th><th>單張</th><th>累計</th></tr></thead>
        <tbody>
          <tr v-for="(p, i) in pts" :key="i">
            <td class="mono">{{ p.full }}</td>
            <td class="nm">{{ p.name }}</td>
            <td class="mono num">{{ p.delta.toLocaleString() }}</td>
            <td class="mono num">{{ p.total.toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </figure>
</template>

<style scoped>
/* 線色用 --gold-deep：兩套主題各自定義過（深色 #ecc063、淺色 #b9801c），
   對各自的卡片底色都過得了 3:1，不必在這裡再分岔一次 */
.curve {
  --curve: var(--gold-deep);
  margin: 0;
  display: grid;
  gap: 8px;
}

.head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.cap { font-size: 12px; font-weight: 600; color: var(--ink); }
/* 讀數會隨手指變動，等寬數字才不會讓整行左右抽動 */
.sub {
  font-size: 10.5px; color: var(--muted);
  font-variant-numeric: tabular-nums;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.plot {
  display: block; width: 100%; height: auto;
  /* 橫向掃描讀值，但直向仍要能捲動頁面 —— 不寫這行手指一碰圖就滑不動 */
  touch-action: pan-y;
}

.gridlines line { stroke: var(--line); stroke-width: 1; }
.ytick, .xtick { fill: var(--faint); font-size: 10px; font-variant-numeric: tabular-nums; }
.area { fill: color-mix(in srgb, var(--curve) 11%, transparent); }
.line { fill: none; stroke: var(--curve); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.cross { stroke: var(--line); stroke-width: 1; }
/* 端點壓在線與面積上，靠一圈底色描邊維持辨識度（不是裝飾邊框） */
.dot { fill: var(--curve); stroke: var(--surface); stroke-width: 2.5; }
/* 數字用文字色，不用資料色 —— 金色在淺色底上當文字讀起來吃力 */
.endval { fill: var(--ink); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }

.lone { margin: 4px 0 2px; font-size: 12.5px; line-height: 1.7; color: var(--muted); }
.lone strong { color: var(--ink); font-weight: 600; }
.lone .val { color: var(--gold-deep); }

.tbl { font-size: 11.5px; }
.tbl summary {
  cursor: pointer; color: var(--muted); font-size: 11.5px;
  padding: 6px 0; list-style: none;
}
.tbl summary::-webkit-details-marker { display: none; }
.tbl summary::before { content: '＋ '; }
.tbl[open] summary::before { content: '－ '; }
.tbl table { width: 100%; border-collapse: collapse; margin-top: 2px; }
.tbl th, .tbl td {
  text-align: left; padding: 5px 6px 5px 0;
  border-bottom: 1px solid var(--line-soft);
  font-size: 11px; font-weight: 400;
}
.tbl th { color: var(--faint); }
.tbl td { color: var(--muted); }
.tbl .nm { color: var(--ink); max-width: 0; width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tbl .num { text-align: right; padding-right: 0; font-variant-numeric: tabular-nums; }
</style>
