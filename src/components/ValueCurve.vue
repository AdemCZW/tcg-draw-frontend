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
 * ---- 為什麼改成「圓角階梯」而不是推翻上面那一段 ----
 * 上面那段仍然成立，沒有過時。使用者要的是「圓滑一點」的觀感，而那個觀感
 * 不必用平滑曲線換 —— 只把**轉角**磨圓就好：
 *   水平段仍然水平（「這段期間沒有新卡」還讀得出來）、
 *   垂直的跳躍仍然發生在原本那個時間點、跳到原本那個高度。
 * 被改動的只有轉角那幾像素，沒有任何一段被捏造成斜坡。
 *
 * 半徑會隨兩側線段長度自己收斂（見 R_MAX 那段）：間距很近時半徑趨近 0，
 * 圓弧不會吃掉整段而把階梯變成假的斜坡 —— 同一天抽到好幾張（水平距離 0）
 * 時退化成純垂直，跟改版前一模一樣。
 *
 * ---- 為什麼把 y 軸標籤放進圖裡 ----
 * 原本左邊留 44px 給「6 萬 / 3 萬 / 0」，那是整張圖最貴的一塊白：
 * 320px 的手機上它吃掉 15% 的寬度，而它承載的只有三個短字串。
 * 改成把刻度壓在格線上方、疊在圖內的左上角，畫布寬度多回 40px，
 * 而且整張圖矮了 56px（152 → 96）。x 軸的兩個日期則搬到圖下那一行文字裡，
 * 用完整年月日寫（比原本的 7/20 更明確），所以下方留白也一起省掉。
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

/**
 * 線型。改這一行就換整條線的畫法，不必動別的地方。
 *
 *   'step-round'（預設）＝ 圓角階梯。水平段水平、跳躍在原位，只磨轉角。
 *   'smooth'            ＝ 全平滑三次貝茲。
 *
 * 'smooth' 的代價寫在這裡，別讓下一個人以為它只是換個好看的線：
 * 它會在兩次抽卡之間畫出一條持續上升的斜線，等於宣稱「那幾天收藏也在增值」——
 * 而那幾天什麼事都沒發生。水平段消失之後，「這段期間沒有新卡」這個
 * 讀得出來的事實也一起不見了。控制點刻意與端點同高，所以至少不會過衝
 * （不會畫出「總值一度下跌」這種更嚴重的假象），但捏造斜坡這件事本身還在。
 */
type LineMode = 'step-round' | 'smooth'
/* 型別寫成 `as LineMode` 而不是直接標註：直接標註的話 TypeScript 會把它
   窄化成那個字面值，下面那個三元判斷就變成「永遠不成立的比較」而編譯失敗 ——
   換句話說，這一行改成 'smooth' 之前得先改型別，那就不是一行可切的開關了。 */
const SMOOTH_MODE = 'step-round' as LineMode

/* 轉角圓弧的上限半徑。6px 在手機那個 74px 高的繪圖區裡約佔 8%，
   看得出圓潤但不至於讓人把轉角讀成一段斜坡。 */
const R_MAX = 6

/* 座標系。
   上留白 16px 裝得下最上面那個刻度字（壓在頂端格線上方）與端點數字；
   左右各 8px 是給端點那顆圓點的半徑（4.5 + 2.5 描邊）留的，不留會被 viewBox 切掉；
   下留白只剩 6px —— x 軸日期已經搬到圖下那行文字，這裡不必再養一條軸帶。 */
const PAD = { l: 8, r: 8, t: 16, b: 6 }

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

/* 高度跟著寬度走，因為「短」是相對於寬度說的。
   手機上卡片才 350 寬，96px 已經是 3.6:1 的橫幅；桌機上同一張卡有 1100 寬，
   還用 96px 就變成 11:1 的細長條 —— 那時階梯的高低差被壓到看不出來，
   「短一點」反而換成了「看不懂」。900px 以上給 132，比例回到 8:1 左右。
   斷點看的是**曲線容器的實際寬度**而不是視窗：這個元件也可能被放進更窄的欄位。 */
const H = computed(() => (w.value >= 900 ? 132 : 96))
const plotH = computed(() => H.value - PAD.t - PAD.b)

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
    return { t: r.t, total: sum, delta: r.price, name: r.name, full: fmtFull(r.t) }
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
/* 一張卡都沒標參考價時總值恆為 0，niceCeil 退回 1，刻度就會變成「1 / 0.5 / 0」——
   那三個數字不是這本卡冊的任何一件事實（點數不會出現 0.5），只是除法的殘渣。
   這種時候只留 0 那條基準線：沒有縱向尺度可講，就不要編一個出來。 */
const ticks = computed(() =>
  (pts.value[last.value]?.total ?? 0) <= 0 ? [0] : [0, yMax.value / 2, yMax.value])

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
  return PAD.t + plotH.value - (v / yMax.value) * plotH.value
}
/* path 字串裡不需要 15 位小數，兩位就遠超過螢幕解析度 */
const f = (n: number) => Math.round(n * 100) / 100

/**
 * 圓角階梯。
 *
 * 每一次取得卡片會產生兩個轉角：
 *   ① 水平段的終點（x_i, y_{i-1}）—— 從「往右走」轉成「往上跳」
 *   ② 垂直段的終點（x_i, y_i）    —— 從「往上跳」轉成「往右走」
 * 兩個轉角各用一段二次貝茲取代，控制點就放在原本那個尖角上，
 * 所以圓弧一定內切於原本的折線，不會跑到階梯外面去。
 *
 * 半徑的三個上限缺一不可：
 *   R_MAX      —— 視覺上限，再大就開始像斜坡
 *   相鄰水平段的一半 —— 兩個相鄰轉角各吃一半，水平段中間永遠留得下平的部分
 *   垂直跳幅的一半   —— 上下兩個轉角共用同一段垂直線，各吃一半才不會互相穿過
 * 三者取最小值，所以「間距很近」與「跳很小」都會讓半徑自己趨近 0，
 * 退化成改版前那條直角階梯，不會有假的斜坡。
 */
function stepRoundPath() {
  const p = pts.value
  let d = `M ${f(x(0))} ${f(y(p[0].total))}`
  for (let i = 1; i < p.length; i++) {
    const xi = x(i)
    const yPrev = y(p[i - 1].total)
    const yi = y(p[i].total)
    const rise = yPrev - yi                                   // y 軸向下，往上跳是正值
    const dxIn = xi - x(i - 1)
    // 最後一點後面沒有水平段可走，所以它的上轉角不磨圓（路徑就結束在那裡）
    const dxOut = i < p.length - 1 ? x(i + 1) - xi : 0
    if (rise <= 0.5) {
      // 這張卡沒有參考價（或小到畫不出來）：沒有轉角要磨，直接水平走過去
      d += ` L ${f(xi)} ${f(yi)}`
      continue
    }
    const r1 = Math.max(0, Math.min(R_MAX, dxIn / 2, rise / 2))
    const r2 = Math.max(0, Math.min(R_MAX, dxOut / 2, rise / 2))
    d += ` L ${f(xi - r1)} ${f(yPrev)}`
    if (r1 > 0) d += ` Q ${f(xi)} ${f(yPrev)} ${f(xi)} ${f(yPrev - r1)}`
    d += ` L ${f(xi)} ${f(yi + r2)}`
    if (r2 > 0) d += ` Q ${f(xi)} ${f(yi)} ${f(xi + r2)} ${f(yi)}`
  }
  return d
}

/* 全平滑版（SMOOTH_MODE = 'smooth' 時才會用到）。
   控制點只在 x 方向偏移、y 與端點相同 —— 這樣曲線在每一段內單調，
   不會出現「總值先掉下去再漲回來」的過衝。 */
function smoothPath() {
  const p = pts.value
  let d = `M ${f(x(0))} ${f(y(p[0].total))}`
  for (let i = 1; i < p.length; i++) {
    const x0 = x(i - 1)
    const x1 = x(i)
    const y0 = y(p[i - 1].total)
    const y1 = y(p[i].total)
    const k = (x1 - x0) / 2
    d += ` C ${f(x0 + k)} ${f(y0)} ${f(x1 - k)} ${f(y1)} ${f(x1)} ${f(y1)}`
  }
  return d
}

const linePath = computed(() => {
  if (pts.value.length < 2) return ''
  return SMOOTH_MODE === 'smooth' ? smoothPath() : stepRoundPath()
})
const areaPath = computed(() => {
  const p = pts.value
  if (p.length < 2) return ''
  const base = PAD.t + plotH.value
  return `${linePath.value} L ${f(x(last.value))} ${base} L ${f(x(0))} ${base} Z`
})

/* ---- 掃描讀值 ----
   手機沒有 hover，而浮動 tooltip 在 375px 寬的卡片裡不是被邊界擠掉就是蓋住線。
   改成把讀數放在圖表底下那一行：手指滑到哪，那行就講哪一點。
   沒在滑的時候顯示整段的起訖日期與張數，所以那行永遠有內容，不必先互動。 */
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
  /* 五位數以上換成「萬」。刻度現在壓在圖內，字越短越不容易蓋到線。
     取兩位小數再用 Number() 把尾數的 0 吃掉：中位刻度常常是 1.25 萬這種數，
     四捨五入到一位會變成 1.3 萬 —— 刻度標錯值比標得長還糟 */
  if (v >= 10000) return `${Number((v / 10000).toFixed(2))} 萬`
  return v.toLocaleString()
}

const cur = computed(() => pts.value[active.value])
/* 圖下那一行。沒在掃描時它就是 x 軸：起訖日期（完整年月日，比原本圖上的
   7/20 更明確）加上這段期間累積了幾張。掃描時換成那一點的日期、卡名與增額。 */
const sub = computed(() => {
  const p = pts.value
  if (!p.length) return ''
  if (hover.value === null) return `${p[0].full} → ${p[last.value].full} · 累積 ${p.length} 張`
  const c = p[hover.value]
  return `${c.full} · ${c.name} +${c.delta.toLocaleString()}`
})

/* 端點標籤靠近右邊界時要改成向左展開，否則字會被切掉。
   （寧可換錨點也不要讓 SVG overflow —— 那在卡片裡會被 border-radius 裁掉） */
const labelX = computed(() => {
  const px = x(active.value)
  return px > w.value * 0.55 ? px - 9 : px + 9
})
const labelAnchor = computed(() => (x(active.value) > w.value * 0.55 ? 'end' : 'start'))
/* 端點數字預設放在點的上方；圖矮了之後線常常貼著頂端，上面塞不下時
   改放到點的**下方**（那裡是面積填色，12px 的 --ink 字壓在 11% 的金上仍然讀得到）。
   原本是「頂不住就夾在 PAD.t + 11」，那會讓數字剛好壓在線上 —— 夾住的是位置，
   不是可讀性。 */
const labelY = computed(() => {
  const yy = y(cur.value?.total ?? 0)
  return yy - 9 >= PAD.t + 9 ? yy - 9 : yy + 16
})

const aria = computed(() => {
  const p = pts.value
  if (p.length < 2) return '收藏總值累積曲線，資料不足'
  return `收藏總值累積曲線：${p[0].full} 到 ${p[last.value].full} 之間取得 ${p.length} 張卡，`
    + `總值從 ${p[0].total.toLocaleString()} 點一路累積到 ${p[last.value].total.toLocaleString()} 點。`
})
</script>

<template>
  <figure ref="box" class="curve">
    <!-- 這裡刻意沒有標題。上面那個大數字就是這條線的終點，
         再寫一次「收藏總值累積」等於同一張卡裡同一個詞出現兩次 ——
         「這條線在講什麼」交給 aria-label 與圖下那行起訖日期回答。 -->

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
      <path class="area" :d="areaPath" />
      <path class="line" :d="linePath" />

      <!-- 刻度壓在自己那條格線的正上方、貼左邊界（省掉原本左邊 44px 的軸帶）。
           畫在線之後，並用底色描一圈外框（paint-order: stroke）——
           收藏剛起步時那條線就貼著 0 那條格線，畫在線下面的話「0」會被線劃掉。
           讀不到的刻度等於沒有刻度，所以寧可讓字蓋掉那幾個像素的線。 -->
      <g class="ytick" aria-hidden="true">
        <text v-for="t in ticks" :key="`t${t}`" :x="PAD.l" :y="y(t) - 4" text-anchor="start">
          {{ fmtTick(t) }}
        </text>
      </g>

      <line
        v-if="hover !== null" class="cross"
        :x1="x(active)" :x2="x(active)" :y1="PAD.t" :y2="PAD.t + plotH"
      />

      <!-- 端點只標一顆。每個點都標數字在 50 張的情況下會糊成一團，也沒人讀 -->
      <circle class="dot" :cx="x(active)" :cy="y(cur.total)" r="4.5" />
      <text class="endval mono" :x="labelX" :y="labelY" :text-anchor="labelAnchor">
        {{ cur.total.toLocaleString() }}
      </text>
    </svg>

    <!-- 圖下那一列同時是 x 軸（起訖日期）與掃描讀數，右邊掛著逐張數字的開關。
         兩者併成一列是刻意的：它們都是「這張圖的附註」，各佔一列會讓
         一張圖底下長出兩條細字，看起來像兩個獨立的區塊。

         沒有圖的時候（只有一張卡、或一張都沒有）整列不畫：上面那句話已經把
         日期與總值講完了，再列一次起訖日期就是同一句話說兩遍。

         掃描讀值是加分項，不能是唯一的取得管道：不用觸控也要讀得到每一筆，
         所以逐張數字的表格一定要留著。預設收起來，展開才佔高度 —— 展開時
         details 改吃滿整列（見樣式），表格才不會被擠在右邊那一欄。 -->
    <div v-if="pts.length > 1" class="foot">
      <figcaption class="sub mono">{{ sub }}</figcaption>

      <details class="tbl">
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
    </div>
  </figure>
</template>

<style scoped>
/* 線色用 --gold-deep：兩套主題各自定義過（深色 #ecc063、淺色 #b9801c），
   對各自的卡片底色都過得了 3:1，不必在這裡再分岔一次 */
.curve {
  --curve: var(--gold-deep);
  margin: 0;
  display: grid;
  gap: 2px;
}

.plot {
  display: block; width: 100%; height: auto;
  /* 橫向掃描讀值，但直向仍要能捲動頁面 —— 不寫這行手指一碰圖就滑不動 */
  touch-action: pan-y;
}

.gridlines line { stroke: var(--line); stroke-width: 1; }
/* 刻度與端點數字都疊在資料上，所以各描一圈底色當襯底（paint-order 先描邊再填色）。
   這不是裝飾邊框，是讓字在線與面積上仍然讀得到的唯一辦法 —— 沒有它，
   線只要剛好經過就會把字劃斷。 */
.ytick { fill: var(--faint); font-size: 10px; font-variant-numeric: tabular-nums; }
.ytick text, .endval {
  paint-order: stroke fill;
  stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round;
}
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

/* 圖註列：左邊是軸／讀數，右邊是逐張數字的開關 */
.foot {
  display: flex; flex-wrap: wrap; align-items: baseline;
  gap: 0 12px; min-width: 0;
}
/* 讀數會隨手指變動，等寬數字才不會讓整行左右抽動 */
.sub {
  flex: 1 1 auto; min-width: 0;
  font-size: 10.5px; color: var(--muted);
  font-variant-numeric: tabular-nums;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.tbl { flex: 0 0 auto; font-size: 11.5px; }
/* 展開時吃滿整列並換到下一行，表格才有整個寬度可用；
   收起來時貼在讀數那一行的右端，不自己佔一列 */
.tbl[open] { flex: 1 1 100%; }
.tbl summary {
  cursor: pointer; color: var(--muted); font-size: 11.5px;
  /* 觸控目標：11.5px 的字本身只有 16px 高，靠 min-height 撐到 44px。
     這裡刻意**不用負外距**把多出來的高度藏回版面 —— 試過，結果是熱區往上
     長進圖表底部 11px，點圖右下角掃描讀值會誤觸展開表格（實測會展開）。
     讓那 44px 真的佔位，圖表與下面「組成」那一組之間就自然有一段留白，
     那段留白本來就要有（見 MyCardsPage 的 .ovMix），等於一塊空間做兩件事。 */
  min-height: 44px; display: inline-flex; align-items: center;
  /* ::before 的「＋」在 inline-flex 裡是獨立的 flex 項目，字串尾巴那個空白會被
     摺掉 —— 縫要用 gap 給，不能靠 content 裡的空格 */
  gap: 4px;
  padding: 0 2px; list-style: none;
  white-space: nowrap;
}
.tbl summary::-webkit-details-marker { display: none; }
.tbl summary::before { content: '＋'; }
.tbl[open] summary::before { content: '－'; }
.tbl table { width: 100%; border-collapse: collapse; margin-top: 8px; }
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
