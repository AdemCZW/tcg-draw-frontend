<script setup lang="ts">
/**
 * 形象頁 —— 進站的第一眼，展示版。
 *
 * 分層（由後往前）：
 *   0 極光星雲 → 1 星塵 → 2 流星 → 3 軌道環 → 4 環繞卡 → 5 球 → 6 屬性光點 → 7 文字
 * 每一層動的速度不同，滑鼠／陀螺儀移動時位移量也不同，做出視差深度。
 *
 * 寶可夢元素全部用 CSS／SVG 畫出「形狀語彙」，不下載官方素材：
 * 寶貝球分模線、屬性能量符號（火水草電）、精靈球開闔的光。
 * 唯一的外部素材是卡面示意圖，走專案既有的 TCGdex 管線
 * （見 lib/tcgdex.ts 開頭對授權風險與使用邊界的說明）。
 *
 * 登入／註冊是走形式：按下就進站。後端還沒有，假表單只會擋人。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import CapsuleArt from '@/components/CapsuleArt.vue'
import ShaderSky from '@/components/ShaderSky.vue'
import KineticTitle from '@/components/KineticTitle.vue'
import { canonicalArt } from '@/lib/tcgdex'
import { haptic } from '@/lib/haptics'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const busy = ref<'login' | 'register' | null>(null)

/* ================= 場次導演機 =================
   之前每一層都各自無限循環，沒有開始也沒有收尾 —— 那是氛圍壁紙不是一部片。
   改成一段 30 秒的循環短片，分五幕，每一幕整個畫面的狀態都不同：
   鏡頭會推近拉遠、能量會累積、爆發、然後沉降回夜色。

   實作跟 RevealBuildup 同一套：一串 Act 推進根節點的 class，
   CSS 用 transition 接住幕與幕之間的變化，一次性事件（閃光、衝擊波）用 animation。

   用 setTimeout 不用 rAF：分頁被節流時 rAF 不推進，整部片會停在某一幕，
   使用者切回來看到的是凍住的畫面。setTimeout 被節流只是慢，不會卡死。 */
type Act = 'night' | 'wake' | 'align' | 'burst' | 'ember'
const SCRIPT: { k: Act; ms: number }[] = [
  { k: 'night', ms: 7000 },   // 靜夜：深空緩慢漂移，球沉睡，鏡頭遠
  { k: 'wake', ms: 6500 },    // 甦醒：能量聚集，電弧變密，鏡頭推近
  { k: 'align', ms: 6500 },   // 共鳴：卡片收攏成環一起公轉，色調流轉
  { k: 'burst', ms: 3200 },   // 爆發：白閃、衝擊波、卡片被推開
  { k: 'ember', ms: 6800 }    // 餘燼：光點沉降，回到夜色
]
const act = ref<Act>('night')

/* 著色器背景。拿不到 WebGL2（或跑太慢被判定為軟體渲染）就 fail，
   退回原本那套 CSS 圖層 —— 兩者是同一個視覺方向，退化不會像壞掉。 */
/* ?nogl=1 強制走 CSS 退路。
   留著不是為了除錯方便而已 —— WebGL 在某些裝置／驅動上會「能建立但畫面全黑」，
   那種情況偵測不到，得有一個使用者或客服能直接指定的開關。 */
const sky3d = ref(!new URLSearchParams(location.search).has('nogl'))
const skyFps = ref<number | null>(null)
/** 各幕的能量餵給 shader，跟 CSS 的 --e 是同一組數字 */
const ENERGY: Record<Act, number> = { night: .12, wake: .55, align: .85, burst: 1, ember: .3 }
const cycle = ref(0)          // 每輪 +1，用來重播一次性動畫
let timer: number | undefined

const reduceMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

function runScene(i = 0) {
  const step = SCRIPT[i % SCRIPT.length]
  act.value = step.k
  if (step.k === 'night') cycle.value++
  timer = window.setTimeout(() => runScene(i + 1), step.ms)
}
onMounted(() => {
  // 關動效的人停在最安靜的那一幕，不跑劇本
  if (!reduceMotion()) runScene()
})
onBeforeUnmount(() => clearTimeout(timer))

/* ---- 環繞的卡 ----
   先畫卡背（不必等網路），卡面示意圖抓到才淡入蓋上去。
   這樣首屏永遠是完整的，慢網路只是少了圖不是缺一塊。 */
const ORBIT = [
  { name: '噴火龍', x: -168, y: -74, rot: -15, s: .96, dur: 6.4, delay: 0 },
  { name: '皮卡丘', x: 172, y: -56, rot: 13, s: 1, dur: 7.2, delay: -1.6 },
  { name: '夢幻', x: -140, y: 104, rot: 11, s: .88, dur: 6.8, delay: -3.1 },
  { name: '妙蛙種子', x: 150, y: 118, rot: -10, s: .92, dur: 7.6, delay: -4.4 }
]
const art = ref<(string | null)[]>(ORBIT.map(() => null))
onMounted(() => {
  ORBIT.forEach((c, i) => {
    canonicalArt(c.name, 'low').then(u => { if (u) art.value[i] = u })
  })
})

/* ---- 屬性能量光點 ----
   四個基本屬性的色與符號。符號是通用的自然形狀（火焰／水滴／葉／閃電），
   不是官方能量圖示的複製。 */
const MOTES = [
  { c: '#ff6a3d', p: 'M12 3c3 4 5 6 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4 0 1 1 2 2 2 0-3 0-5 1-7z', x: 18, d: 0, dur: 9 },
  { c: '#3fa9ff', p: 'M12 3c3 4 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 3-7 6-11z', x: 38, d: -2.4, dur: 11 },
  { c: '#4fd07a', p: 'M20 4C10 4 4 9 4 16c0 2 1 4 1 4s6-9 15-11c0 0-7 4-10 11 8 1 12-5 12-11 0-3 0-5-2-5z', x: 62, d: -5.1, dur: 10 },
  { c: '#ffd23d', p: 'M13 2 4 14h6l-1 8 9-12h-6l1-8z', x: 82, d: -7.3, dur: 12 }
]

/* ---- 散景光斑 ----
   失焦的圓形光點，前後景各幾顆。用 radial-gradient 畫而不是 filter: blur() ——
   blur 每一幀都要重算，這裡有九顆會直接吃掉幀率；gradient 是靜態的，
   瀏覽器只要平移合成層。 */
const BOKEH = [
  { c: '#a06bff', x: 12, y: 22, r: 190, o: .16, dur: 26, d: 0, depth: 26 },
  { c: '#3fa9ff', x: 84, y: 16, r: 150, o: .14, dur: 31, d: -6, depth: 20 },
  { c: '#ff5f8f', x: 72, y: 74, r: 210, o: .12, dur: 35, d: -12, depth: 30 },
  { c: '#5fe0c0', x: 22, y: 78, r: 130, o: .1, dur: 29, d: -3, depth: 16 },
  { c: '#ffc94d', x: 50, y: 8, r: 110, o: .1, dur: 24, d: -17, depth: 12 },
  { c: '#8b5cf6', x: 6, y: 54, r: 160, o: .12, dur: 33, d: -9, depth: 24 },
  { c: '#ff7a3d', x: 92, y: 48, r: 120, o: .1, dur: 27, d: -21, depth: 14 },
  { c: '#4f8dff', x: 38, y: 92, r: 170, o: .1, dur: 37, d: -14, depth: 22 },
  { c: '#e879f9', x: 62, y: 36, r: 100, o: .09, dur: 22, d: -5, depth: 10 }
]

/* ---- 能量電弧 ----
   球周圍偶爾竄一下的電流。三條各自的節奏，大部分時間是隱形的 ——
   一直閃就變成霓虹燈，偶爾才閃才像有能量在裡面。 */
const ARCS = [
  { d: 'M14 78 C 40 52, 62 96, 96 62', delay: 0, dur: 7 },
  { d: 'M18 30 C 48 58, 66 22, 98 44', delay: -2.8, dur: 9 },
  { d: 'M10 56 C 36 88, 70 40, 92 84', delay: -5.4, dur: 11 }
]

/* ---- 星塵 ----
   固定種子的偽亂數：每次進站星星位置一樣，不會因為重繪而跳動。 */
function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20260817)
const STARS = Array.from({ length: 46 }, () => ({
  x: +(rnd() * 100).toFixed(2),
  y: +(rnd() * 100).toFixed(2),
  s: +(rnd() * 1.9 + 0.7).toFixed(2),
  o: +(rnd() * 0.5 + 0.25).toFixed(2),
  dur: +(rnd() * 4 + 2.6).toFixed(1),
  delay: +(-rnd() * 6).toFixed(1)
}))

/* 星座連線：從星塵裡挑相鄰的幾顆連成折線。
   不是隨機連 —— 挑出來的點先照 x 排序再連，線才不會亂交叉成一團毛球。 */
const CONSTELLATIONS = (() => {
  const pick = (from: number, n: number) =>
    STARS.slice(from, from + n).sort((a, b) => a.x - b.x).map(s => `${s.x},${s.y}`).join(' ')
  return [pick(2, 5), pick(14, 4), pick(28, 5)]
})()

/* ---- 視差 ----
   指標移動時各層位移不同。用 CSS 變數餵給 transform，
   不在 JS 裡逐層改 style —— 一次寫兩個變數，其餘交給 CSS。 */
const px = ref(0)
const py = ref(0)
let raf = 0
function onMove(e: PointerEvent) {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    px.value = (e.clientX / window.innerWidth - 0.5) * 2
    py.value = (e.clientY / window.innerHeight - 0.5) * 2
  })
}
onMounted(() => window.addEventListener('pointermove', onMove, { passive: true }))
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onMove)
  if (raf) cancelAnimationFrame(raf)
})

async function goIn(kind: 'login' | 'register') {
  if (busy.value) return
  haptic('tap')
  busy.value = kind
  try {
    if (kind === 'register') await auth.register('', '')
    else await auth.login('', '')
    const back = typeof route.query.redirect === 'string' ? route.query.redirect : ''
    if (back && back.startsWith('/')) router.replace(back)
    else router.replace({ name: 'home' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="land" :class="`sc-${act}`" :style="{ '--px': px, '--py': py }">
    <!-- ===== 0 背景 =====
         優先用著色器即時算的星雲；失敗才退回下面那套 CSS 圖層。
         兩者不同時開 —— 疊在一起會互相洗掉對比，變成一片灰紫。 -->
    <ShaderSky
      v-if="sky3d"
      class="skyGl"
      :energy="ENERGY[act]"
      :burst="act === 'burst'"
      @fail="sky3d = false"
      @fps="v => (skyFps = v)"
    />

    <div v-if="!sky3d" class="sky" aria-hidden="true">
      <div class="aur a1"></div>
      <div class="aur a2"></div>
      <div class="aur a3"></div>
      <div class="vignette"></div>
    </div>

    <!-- ===== 0b 極光簾幕：shader 版已經有雲氣，這裡只留一點方向性的光帶 ===== -->
    <div class="curtains" :class="{ dim: sky3d }" aria-hidden="true">
      <div class="curtain c1"></div>
      <div class="curtain c2"></div>
    </div>

    <!-- ===== 0c 神之光：從球心放射的光柱，極慢旋轉 ===== -->
    <div class="rays" aria-hidden="true"></div>

    <!-- ===== 0d 散景光斑 ===== -->
    <div class="bokehs" :class="{ dim: sky3d }" aria-hidden="true">
      <span
        v-for="(b, i) in BOKEH" :key="i"
        class="bokeh"
        :style="{
          left: b.x + '%', top: b.y + '%',
          width: b.r + 'px', height: b.r + 'px',
          '--c': b.c, '--o': b.o, '--dur': b.dur + 's', '--delay': b.d + 's', '--depth': b.depth
        }"
      ></span>
    </div>

    <!-- ===== 0e 透視地平線格線 ===== -->
    <div class="floor" aria-hidden="true"><span></span></div>

    <!-- ===== 1 星塵 ===== -->
    <div class="stars" aria-hidden="true">
      <i
        v-for="(s, i) in STARS" :key="i"
        :style="{
          left: s.x + '%', top: s.y + '%',
          width: s.s + 'px', height: s.s + 'px',
          '--o': s.o, '--dur': s.dur + 's', '--delay': s.delay + 's'
        }"
      ></i>
    </div>

    <!-- ===== 1b 星座連線 ===== -->
    <svg class="lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline v-for="(pts, i) in CONSTELLATIONS" :key="i" :points="pts" :style="{ '--i': i }" />
    </svg>

    <!-- ===== 2 流星：兩道，長週期，不搶戲 ===== -->
    <div class="meteors" aria-hidden="true"><span class="m1"></span><span class="m2"></span></div>

    <!-- ===== 6 屬性光點：從底下升起。掛在頁面層而不是 .hero 裡面 ——
         放進 .hero 的話 z-index 是相對 hero 的堆疊上下文，會蓋在文字上，
         看起來像有東西黏在字上而不是背景的氛圍。 ===== -->
    <div class="motes" aria-hidden="true">
      <span
        v-for="(m, i) in MOTES" :key="i"
        class="mote"
        :style="{ '--c': m.c, left: m.x + '%', '--delay': m.d + 's', '--dur': m.dur + 's' }"
      >
        <svg viewBox="0 0 24 24"><path :d="m.p" /></svg>
      </span>
    </div>

    <!-- 全幕白閃：爆發那一拍蓋過整個畫面 -->
    <div v-if="act === 'burst'" :key="'f' + cycle" class="flash" aria-hidden="true"></div>

    <header class="brand">
      <span class="wordmark">Vault<em>Draw</em></span>
    </header>

    <main class="hero">
      <div class="orbit" aria-hidden="true">
        <!-- 3 軌道環：兩圈傾斜的橢圓，反向緩轉 -->
        <span class="ring r1"></span>
        <span class="ring r2"></span>

        <!-- 4 環繞卡 -->
        <div
          v-for="(c, i) in ORBIT" :key="i"
          class="fly"
          :style="{
            '--x': c.x + 'px', '--y': c.y + 'px', '--rot': c.rot + 'deg', '--s': c.s,
            '--dur': c.dur + 's', '--delay': c.delay + 's'
          }"
        >
          <div class="back">
            <span class="emblem"></span>
            <img v-if="art[i]" :src="art[i]!" alt="" class="face" loading="lazy" decoding="async" />
            <span class="sheen"></span>
          </div>
        </div>

        <!-- 5 球 + 能量脈衝環 + 電弧 -->
        <div class="ball">
          <span class="pulse p1"></span>
          <span class="pulse p2"></span>
          <span class="halo"></span>
          <!-- 衝擊波：只在爆發那一幕出現。key 綁 cycle，每輪重新掛載才會重播 -->
          <span v-if="act === 'burst'" :key="cycle" class="shock"></span>
          <svg class="arcs" viewBox="0 0 108 108" aria-hidden="true">
            <path
              v-for="(a, i) in ARCS" :key="i"
              :d="a.d" :style="{ '--delay': a.delay + 's', '--dur': a.dur + 's' }"
            />
          </svg>
          <CapsuleArt tier="LAST" compact flat />
        </div>
      </div>

      <!-- 7 文字
           英文當主視覺（動態標題），中文留在下面當真正讀的那一行 ——
           使用者是台灣人，資訊要用中文讀；英文負責的是氣勢不是傳達。
           key 綁 cycle：每一輪短片回到「靜夜」時標題重新演一次。 -->
      <h1 class="title">
        <KineticTitle
          :key="cycle"
          :lines="['SEALED', 'BEFORE THE DRAW']"
          label="Sealed before the draw"
          :stagger="46"
          :delay="180"
        />
      </h1>
      <p class="zh">每一支籤，開賣前就已封存</p>
      <p class="tag muted">PSA 鑑定卡 · 定量抽選 · 完抽可驗算</p>

      <div class="acts">
        <button type="button" class="btn primary big" :disabled="!!busy" @click="goIn('login')">
          {{ busy === 'login' ? '進入中…' : '登入' }}
        </button>
        <button type="button" class="btn big" :disabled="!!busy" @click="goIn('register')">
          {{ busy === 'register' ? '建立中…' : '註冊' }}
        </button>
        <RouterLink :to="{ name: 'home' }" class="peek muted">先逛逛 →</RouterLink>
      </div>
      <p class="demo mono">展示版：登入與註冊皆為模擬，按下即進站</p>
    </main>

    <footer class="foot muted">
      <RouterLink :to="{ name: 'fairness' }">公平性</RouterLink> ·
      <a href="#">會員條款</a> ·
      <a href="#">隱私權政策</a>
      <span class="fine">
        點數僅可用於站內抽選與兌換商品，不可提領現金或轉讓。未滿 18 歲需監護人同意方可使用。
        卡面為示意圖，版權屬各自所有權人。
      </span>
    </footer>
  </div>
</template>

<style scoped>
.land {
  position: relative;
  min-height: 100dvh;
  display: grid; grid-template-rows: auto 1fr auto;
  overflow: hidden; isolation: isolate;
  padding: var(--safe-t) 0 var(--safe-b);
  background: #07050e;
}

/* ===== 0 極光星雲 ===== */
.sky { position: absolute; inset: -10%; z-index: 0; pointer-events: none; }
.aur {
  position: absolute; border-radius: 50%;
  filter: blur(90px);
  mix-blend-mode: screen;
}
.a1 {
  width: 78vmax; height: 62vmax; left: -12vmax; top: -18vmax;
  background: radial-gradient(circle closest-side, #7b3fd4, transparent);
  opacity: .5;
}
.a2 {
  width: 66vmax; height: 58vmax; right: -14vmax; top: 4vmax;
  background: radial-gradient(circle closest-side, #1f6bd8, transparent);
  opacity: .42;
}
.a3 {
  width: 60vmax; height: 46vmax; left: 22vmax; bottom: -16vmax;
  background: radial-gradient(circle closest-side, #d8397a, transparent);
  opacity: .3;
}
/* 四角壓暗，視線收到中央 */
.vignette {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse 68% 58% at 50% 46%, transparent 40%, rgba(4, 2, 10, .82) 100%);
}
@media (prefers-reduced-motion: no-preference) {
  .a1 { animation: aur1 22s ease-in-out infinite alternate; }
  .a2 { animation: aur2 27s ease-in-out infinite alternate; }
  .a3 { animation: aur3 19s ease-in-out infinite alternate; }
}
@keyframes aur1 { to { transform: translate(7vmax, 5vmax) scale(1.14); opacity: .34; } }
@keyframes aur2 { to { transform: translate(-8vmax, 4vmax) scale(1.1);  opacity: .3; } }
@keyframes aur3 { to { transform: translate(5vmax, -6vmax) scale(1.16); opacity: .2; } }

/* ================= 分幕演出 =================
   每一幕改的是「狀態」，不是重新播一支動畫 —— 所以各層都給 transition，
   幕與幕之間是滑過去的。一次性的事件（白閃、衝擊波）才用 animation。

   .land 上的 --e 是這一幕的「能量強度」(0→1)，各層拿它去調自己的亮度／速度，
   不必每一層都寫五份規則。 */
.land { --e: 0; --cam: 1; transition: --e 2.2s ease; }
@property --e { syntax: '<number>'; inherits: true; initial-value: 0; }

.sc-night { --e: .12; --cam: 1.00; }
.sc-wake  { --e: .55; --cam: 1.06; }
.sc-align { --e: .85; --cam: 1.11; }
.sc-burst { --e: 1;   --cam: 1.16; }
.sc-ember { --e: .3;  --cam: 1.03; }

/* 鏡頭：整組舞台隨幕次推近拉遠。
   用獨立的 scale 屬性，不用 transform —— .orbit 的 transform 已經被進場動畫
   riseIn 佔用（它的終點是 transform: none 且 fill: both，會一直壓著），
   translate 又給了視差。scale 是第三個互不干擾的屬性。 */
.orbit {
  transition: scale 3.4s cubic-bezier(.33, 0, .2, 1);
  scale: var(--cam);
}
/* 爆發那一拍鏡頭要頓一下，不能慢慢推 */
.sc-burst .orbit { transition: scale .5s cubic-bezier(.2, 1.4, .3, 1); }

/* 極光：越後面越亮越飽和 */
.curtain { transition: opacity 2.6s ease, filter 2.6s ease; }
.sc-night .curtain { opacity: .28; filter: saturate(.7); }
.sc-wake  .curtain { opacity: .7; }
.sc-align .curtain { opacity: .95; filter: saturate(1.35); }
.sc-burst .curtain { opacity: 1; filter: saturate(1.8) brightness(1.3); }
.sc-ember .curtain { opacity: .45; filter: saturate(.9); }

/* 神之光：靜夜幾乎看不見，共鳴時最強 */
.rays { transition: opacity 2.4s ease; }
.sc-night .rays { opacity: .03; }
.sc-wake  .rays { opacity: .1; }
.sc-align .rays { opacity: .2; }
.sc-burst .rays { opacity: .34; }
.sc-ember .rays { opacity: .06; }

/* 地平線格線：能量越高捲得越快 */
.floor span { transition: opacity 2s ease; }
.sc-night .floor span { opacity: .28; animation-duration: 9s; }
.sc-wake  .floor span { opacity: .5;  animation-duration: 5s; }
.sc-align .floor span { opacity: .75; animation-duration: 2.4s; }
.sc-burst .floor span { opacity: .95; animation-duration: 1.1s; }
.sc-ember .floor span { opacity: .35; animation-duration: 7s; }

/* 光暈掃描：共鳴時轉快 */
.sc-night .halo { animation-duration: 16s; opacity: .35; }
.sc-wake  .halo { animation-duration: 9s; }
.sc-align .halo { animation-duration: 4s; }
.sc-burst .halo { animation-duration: 1.6s; }
.sc-ember .halo { animation-duration: 13s; opacity: .5; }
.halo { transition: opacity 1.8s ease; }

/* 電弧：靜夜不放電，越後面越密 */
.sc-night .arcs path { animation-duration: 14s; }
.sc-wake  .arcs path { animation-duration: 5s; }
.sc-align .arcs path { animation-duration: 2.2s; }
.sc-burst .arcs path { animation-duration: 1s; }
.sc-ember .arcs path { animation-duration: 11s; }

/* 環繞卡：
   靜夜散得開、共鳴時被吸近球、爆發被推出去。
   位移量用 --spread 統一縮放，一個變數就能收攏整組。 */
.fly { --spread: 1; transition: transform 3s cubic-bezier(.33, 0, .2, 1), filter 2s ease; }
.sc-night .fly { --spread: 1.12; filter: drop-shadow(0 14px 30px rgba(0,0,0,.66)) brightness(.75); }
.sc-wake  .fly { --spread: 1; }
.sc-align .fly { --spread: .74; filter: drop-shadow(0 14px 34px rgba(120,80,255,.5)) brightness(1.12); }
.sc-burst .fly { --spread: 1.42; filter: drop-shadow(0 14px 40px rgba(255,220,150,.6)) brightness(1.5); }
.sc-ember .fly { --spread: 1.05; filter: drop-shadow(0 14px 30px rgba(0,0,0,.6)) brightness(.9); }

/* 星塵：爆發時整片被吹亮一下 */
.stars i { transition: opacity 1.4s ease; }
.sc-burst .stars i { opacity: 1; }

/* 散景：能量高時脹大 */
.bokeh { transition: opacity 2.4s ease; }
.sc-night .bokeh { opacity: calc(var(--o) * .5); }
.sc-align .bokeh { opacity: calc(var(--o) * 1.6); }
.sc-burst .bokeh { opacity: calc(var(--o) * 2.2); }

/* ---- 一次性事件 ---- */
/* 衝擊波：從球心炸開的環 */
.shock {
  position: absolute; left: 50%; top: 50%;
  width: 60%; aspect-ratio: 1; translate: -50% -50%;
  border-radius: 50%;
  border: 2px solid rgba(255, 236, 190, .9);
  pointer-events: none; z-index: 3;
  animation: shockOut 1.5s cubic-bezier(.15, .7, .3, 1) forwards;
}
@keyframes shockOut {
  0%   { transform: scale(.5); opacity: 0; border-width: 4px; }
  12%  { opacity: 1; }
  100% { transform: scale(5.2); opacity: 0; border-width: .5px; }
}
/* 全幕白閃：很短，只有一拍 */
.flash {
  position: absolute; inset: 0; z-index: 6; pointer-events: none;
  background: radial-gradient(circle at 50% 42%, rgba(255, 245, 225, .82), rgba(255, 220, 190, .12) 42%, transparent 66%);
  mix-blend-mode: screen;
  animation: flashOut 1.1s ease-out forwards;
}
@keyframes flashOut {
  0%  { opacity: 0; }
  8%  { opacity: 1; }
  100% { opacity: 0; }
}

/* 著色器背景鋪在最底 */
.skyGl { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
/* shader 已經畫了雲氣，CSS 這兩層就收斂成點綴，不然疊起來會糊成一片灰紫 */
.curtains.dim { opacity: .34; }
.bokehs.dim { opacity: .45; }
.curtains, .bokehs { transition: opacity .6s ease; }

/* ===== 0b 極光簾幕 =====
   conic-gradient 轉起來就是一片繞著中心掃的光帶，很像極光。
   用 mask 讓它中間濃、邊緣散掉，不然會看到明顯的扇形邊。 */
.curtains { position: absolute; inset: -20%; z-index: 0; pointer-events: none; }
.curtain {
  position: absolute; inset: 0;
  mix-blend-mode: screen;
  -webkit-mask-image: radial-gradient(ellipse 60% 50% at 50% 45%, #000 10%, transparent 72%);
  mask-image: radial-gradient(ellipse 60% 50% at 50% 45%, #000 10%, transparent 72%);
}
.c1 {
  background: conic-gradient(from 0deg at 50% 42%,
    transparent 0deg, rgba(124, 77, 255, .30) 38deg, transparent 84deg,
    transparent 150deg, rgba(56, 189, 248, .24) 194deg, transparent 244deg,
    transparent 310deg, rgba(236, 72, 153, .22) 342deg, transparent 360deg);
  opacity: .8;
}
.c2 {
  background: conic-gradient(from 180deg at 50% 42%,
    transparent 0deg, rgba(94, 234, 212, .18) 46deg, transparent 96deg,
    transparent 190deg, rgba(167, 139, 250, .22) 236deg, transparent 288deg);
  opacity: .6;
}
@media (prefers-reduced-motion: no-preference) {
  .c1 { animation: spinSlow 52s linear infinite; }
  .c2 { animation: spinSlow 78s linear reverse infinite; }
}
@keyframes spinSlow { to { transform: rotate(1turn); } }

/* ===== 0c 神之光 =====
   repeating-conic 做出等距光柱，遮罩讓它從球心往外散開後消失 */
.rays {
  position: absolute; left: 50%; top: 42%; z-index: 0;
  width: 92vmax; height: 92vmax; translate: -50% -50%;
  pointer-events: none;
  mix-blend-mode: screen;
  opacity: .1;
  background: repeating-conic-gradient(from 0deg at 50% 50%,
    rgba(214, 190, 255, .42) 0deg 1.2deg, transparent 1.2deg 22deg);
  /* 只在球外圍一圈可見：內側讓給球本身，外側在碰到文字前就散掉 */
  -webkit-mask-image: radial-gradient(circle closest-side, transparent 11%, #000 20%, transparent 44%);
  mask-image: radial-gradient(circle closest-side, transparent 11%, #000 20%, transparent 44%);
}
@media (prefers-reduced-motion: no-preference) {
  .rays { animation: spinSlow 120s linear infinite; }
}

/* ===== 0d 散景光斑 =====
   --depth 越大位移越多，視差就有前後之分 */
.bokehs { position: absolute; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.bokeh {
  position: absolute;
  border-radius: 50%;
  translate: calc(var(--px) * var(--depth) * 1px) calc(var(--py) * var(--depth) * 1px);
  background: radial-gradient(circle closest-side, var(--c), transparent 72%);
  opacity: var(--o);
  mix-blend-mode: screen;
}
@media (prefers-reduced-motion: no-preference) {
  .bokeh { animation: drift var(--dur) ease-in-out var(--delay) infinite alternate; }
}
@keyframes drift {
  from { transform: translate(-16px, 10px) scale(.9); }
  to   { transform: translate(18px, -14px) scale(1.12); }
}

/* ===== 0e 透視地平線 =====
   兩組線做出往遠方收束的地板。background-position 往下捲＝往觀者靠近。 */
.floor {
  position: absolute; left: -25%; right: -25%; bottom: 0; height: 42vh;
  z-index: 0; pointer-events: none; overflow: hidden;
  perspective: 190px;
  -webkit-mask-image: linear-gradient(to top, #000 4%, transparent 78%);
  mask-image: linear-gradient(to top, #000 4%, transparent 78%);
}
.floor span {
  position: absolute; inset: -60% 0 -110%;
  transform: rotateX(76deg);
  transform-origin: 50% 100%;
  background-image:
    repeating-linear-gradient(90deg, rgba(168, 130, 255, .3) 0 1px, transparent 1px 68px),
    repeating-linear-gradient(0deg,  rgba(168, 130, 255, .26) 0 1px, transparent 1px 68px);
  opacity: .5;
}
@media (prefers-reduced-motion: no-preference) {
  .floor span { animation: floorRun 5.5s linear infinite; }
}
@keyframes floorRun { to { background-position: 0 68px, 0 68px; } }

/* ===== 1b 星座連線 ===== */
.lines {
  position: absolute; inset: 0; z-index: 1;
  width: 100%; height: 100%; pointer-events: none;
  translate: calc(var(--px) * -6px) calc(var(--py) * -6px);
}
.lines polyline {
  fill: none;
  stroke: rgba(190, 210, 255, .34);
  stroke-width: .12;
  vector-effect: non-scaling-stroke;
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .lines polyline { animation: lineFade 14s ease-in-out calc(var(--i) * -4.6s) infinite; }
}
@keyframes lineFade {
  0%, 62%, 100% { opacity: 0; }
  22%, 38%      { opacity: 1; }
}

/* ===== 1 星塵 ===== */
.stars { position: absolute; inset: 0; z-index: 1; pointer-events: none;
  translate: calc(var(--px) * -6px) calc(var(--py) * -6px); }
.stars i {
  position: absolute; border-radius: 50%;
  background: #fff; opacity: var(--o);
  box-shadow: 0 0 6px rgba(255, 255, 255, .8);
}
@media (prefers-reduced-motion: no-preference) {
  .stars i { animation: twinkle var(--dur) ease-in-out var(--delay) infinite alternate; }
}
@keyframes twinkle { from { opacity: calc(var(--o) * .25); } to { opacity: var(--o); } }

/* ===== 2 流星 ===== */
.meteors { position: absolute; inset: 0; z-index: 1; pointer-events: none; overflow: hidden; }
.meteors span {
  position: absolute; width: 190px; height: 2px; opacity: 0;
  background: linear-gradient(90deg, transparent, #fff, transparent);
  filter: drop-shadow(0 0 6px #9fd8ff);
  rotate: 22deg;
}
@media (prefers-reduced-motion: no-preference) {
  .m1 { left: -18%; top: 16%; animation: shoot 9s ease-in 2.4s infinite; }
  .m2 { left: -18%; top: 31%; animation: shoot 13s ease-in 7.8s infinite; }
}
@keyframes shoot {
  0%   { transform: translate(0, 0); opacity: 0; }
  6%   { opacity: .9; }
  16%  { transform: translate(135vw, 40vh); opacity: 0; }
  100% { transform: translate(135vw, 40vh); opacity: 0; }
}

.brand { position: relative; z-index: 8; padding: 22px var(--pad) 0; }
.wordmark { font-size: 20px; font-weight: 700; letter-spacing: -.03em; }
.wordmark em { font-style: normal; color: var(--accent); }

.hero {
  position: relative; z-index: 5;
  display: grid; justify-items: center; align-content: center;
  gap: 16px; padding: 6px var(--pad) 24px; text-align: center;
}

/* ===== 軌道舞台 ===== */
.orbit {
  position: relative; --k: 1;
  width: calc(470px * var(--k)); height: calc(370px * var(--k));
  display: grid; place-items: center;
  translate: calc(var(--px) * 10px) calc(var(--py) * 8px);
}

/* 3 軌道環：橢圓 + 傾斜，反向緩轉。兩圈粗細與亮度不同才有前後 */
.ring {
  position: absolute; left: 50%; top: 50%;
  border-radius: 50%;
  border: 1px solid rgba(190, 160, 255, .3);
  translate: -50% -50%;
}
.r1 { width: calc(430px * var(--k)); height: calc(160px * var(--k)); }
.r2 { width: calc(330px * var(--k)); height: calc(118px * var(--k)); border-color: rgba(255, 160, 220, .22); }
@media (prefers-reduced-motion: no-preference) {
  .r1 { animation: spinRing 26s linear infinite; }
  .r2 { animation: spinRing 34s linear reverse infinite; }
}
@keyframes spinRing {
  from { transform: rotate(0turn) rotateX(66deg); }
  to   { transform: rotate(1turn) rotateX(66deg); }
}

/* 5 球 */
.ball {
  position: relative; z-index: 6; width: calc(212px * var(--k));
  display: grid; place-items: center;
}
@media (prefers-reduced-motion: no-preference) {
  .ball { animation: float 5.6s ease-in-out infinite alternate; }
}
@keyframes float { from { translate: 0 -9px; } to { translate: 0 11px; } }
/* 能量脈衝：兩圈由內往外擴散後消失 */
.pulse {
  position: absolute; left: 50%; top: 50%;
  width: 62%; aspect-ratio: 1; translate: -50% -50%;
  border-radius: 50%;
  border: 1.5px solid rgba(214, 170, 255, .55);
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .p1 { animation: pulse 3.6s ease-out infinite; }
  .p2 { animation: pulse 3.6s ease-out 1.8s infinite; }
}
@keyframes pulse {
  0%   { transform: scale(.72); opacity: .7; }
  70%  { opacity: .12; }
  100% { transform: scale(1.9); opacity: 0; }
}

/* 球背後的光暈掃描：一圈 conic 亮帶繞著球轉，像能量在殼裡流動 */
.halo {
  position: absolute; left: 50%; top: 50%;
  width: 128%; aspect-ratio: 1; translate: -50% -50%;
  border-radius: 50%;
  background: conic-gradient(from 0deg,
    transparent 0deg, rgba(214, 170, 255, .5) 42deg, transparent 96deg,
    transparent 180deg, rgba(129, 200, 255, .38) 226deg, transparent 286deg);
  -webkit-mask-image: radial-gradient(circle closest-side, transparent 52%, #000 66%, transparent 92%);
  mask-image: radial-gradient(circle closest-side, transparent 52%, #000 66%, transparent 92%);
  mix-blend-mode: screen;
  z-index: -1;
}
@media (prefers-reduced-motion: no-preference) {
  .halo { animation: spinSlow 9s linear infinite; }
}

/* 電弧：大部分時間隱形，偶爾竄一下。stroke-dash 讓它像是「畫過去」 */
.arcs {
  position: absolute; inset: -8%;
  width: 116%; height: 116%;
  pointer-events: none; z-index: -1;
  overflow: visible;
}
.arcs path {
  fill: none;
  stroke: #cbb2ff;
  stroke-width: 1.1;
  stroke-linecap: round;
  filter: drop-shadow(0 0 4px #a97dff);
  stroke-dasharray: 26 200;
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .arcs path { animation: crackle var(--dur) ease-in-out var(--delay) infinite; }
}
@keyframes crackle {
  0%, 84%, 100% { opacity: 0; stroke-dashoffset: 40; }
  87%           { opacity: .95; }
  92%           { opacity: .45; }
  97%           { opacity: 0; stroke-dashoffset: -200; }
}

/* 4 環繞卡 */
.fly {
  position: absolute; top: 50%; left: 50%; z-index: 4;
  width: calc(100px * var(--k) * var(--s));
  aspect-ratio: 5 / 7;
  translate: calc(var(--x) * var(--k) * var(--spread) - 50%) calc(var(--y) * var(--k) * var(--spread) - 50%);
  rotate: var(--rot);
  filter: drop-shadow(0 14px 30px rgba(0, 0, 0, .66));
}
@media (prefers-reduced-motion: no-preference) {
  .fly { animation: bobCard var(--dur) ease-in-out var(--delay) infinite alternate; }
}
@keyframes bobCard {
  from { translate: calc(var(--x) * var(--k) * var(--spread) - 50%) calc(var(--y) * var(--k) * var(--spread) - 50% - 11px); }
  to   { translate: calc(var(--x) * var(--k) * var(--spread) - 50%) calc(var(--y) * var(--k) * var(--spread) + 13px - 50%); }
}
/* 卡背先畫好，卡面抓到才蓋上去 —— 慢網路只是少了圖，不是缺一塊 */
.back {
  position: relative; width: 100%; height: 100%;
  border-radius: calc(9px * var(--k)); overflow: hidden;
  background:
    radial-gradient(120% 90% at 50% 0%, #3a2f52, transparent 60%),
    linear-gradient(160deg, #241d35 0%, #171226 52%, #221a33 100%);
  border: 1px solid rgba(255, 255, 255, .14);
}
.emblem {
  position: absolute; left: 50%; top: 50%;
  width: 46%; aspect-ratio: 1; translate: -50% -50%;
  border-radius: 50%;
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--accent) 70%, transparent) 0 46%,
    rgba(255, 255, 255, .16) 46% 54%,
    rgba(255, 255, 255, .07) 54% 100%);
  box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .14);
}
.emblem::after {
  content: ''; position: absolute; left: 50%; top: 50%;
  width: 30%; aspect-ratio: 1; translate: -50% -50%;
  border-radius: 50%; background: #efeaf5;
  box-shadow: 0 0 0 1.5px rgba(0, 0, 0, .5);
}
.face {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; border-radius: inherit;
  animation: faceIn .5s ease both;
}
@keyframes faceIn { from { opacity: 0; } to { opacity: 1; } }
/* 全像反光：斜掃過卡面，各張錯開 */
.sheen {
  position: absolute; inset: 0;
  background: linear-gradient(112deg, transparent 30%, rgba(255, 255, 255, .42) 48%, transparent 66%);
  background-size: 260% 100%;
  mix-blend-mode: screen;
}
@media (prefers-reduced-motion: no-preference) {
  .sheen { animation: holo 5.5s ease-in-out var(--delay) infinite; }
}
@keyframes holo {
  0%, 62% { background-position: 190% 0; }
  100%    { background-position: -70% 0; }
}

/* ===== 6 屬性光點 ===== */
.motes { position: absolute; inset: 0; z-index: 2; pointer-events: none; overflow: hidden; }
.mote {
  position: absolute; bottom: -8%;
  width: 26px; height: 26px; opacity: 0;
  color: var(--c);
  filter: drop-shadow(0 0 10px var(--c));
}
.mote svg { width: 100%; height: 100%; fill: currentColor; opacity: .8; }
@media (prefers-reduced-motion: no-preference) {
  .mote { animation: rise var(--dur) linear var(--delay) infinite; }
}
@keyframes rise {
  0%   { transform: translateY(0) scale(.7) rotate(0deg); opacity: 0; }
  12%  { opacity: .85; }
  78%  { opacity: .5; }
  100% { transform: translateY(-92vh) scale(1.05) rotate(28deg); opacity: 0; }
}

/* ===== 7 文字 ===== */
/* 標題排版。動態與掃光都在 KineticTitle 內部，這裡只給尺寸與字距。
   英文大寫 + 極重字重 + 收緊字距：這是 title card 的排版語彙，
   跟內文用同一套 font-size 會顯得像標語不像片名。 */
.title {
  margin: 6px 0 0;
  --kt-ink: #fff;
  --kt-shine: #ffe0a8;
}
.title :deep(.r0) {
  font-size: clamp(46px, 12vw, 104px);
  font-weight: 800;
  letter-spacing: -.028em;
}
.title :deep(.r1) {
  /* 15 個字 × 寬字距，在 375px 上必須夠小才不會爆行 —— 這一行的角色是
     襯托主標的細長副標，小反而對 */
  font-size: clamp(11px, 2.9vw, 24px);
  font-weight: 600;
  letter-spacing: .3em;
  /* 字距是往右加的，整行會偏左，補回一半 */
  text-indent: .3em;
  --kt-ink: #cdbdf0;
  --kt-shine: #fff2d2;
}
/* 中文那一行才是真的要讀的資訊 */
.zh {
  margin: 14px 0 0;
  font-size: clamp(15px, 3.6vw, 18px);
  font-weight: 500;
  color: #e8e2f4;
  letter-spacing: .02em;
}
.tag { margin: 6px 0 0; font-size: 13.5px; letter-spacing: .06em; }

.acts { display: grid; grid-auto-flow: column; gap: 12px; align-items: center; margin-top: 8px; }
.btn.big { padding: 14px 32px; font-size: 16px; }
/* 主鈕呼吸光暈 */
@media (prefers-reduced-motion: no-preference) {
  .btn.primary.big { animation: breathe 2.8s ease-in-out infinite; }
}
@keyframes breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent); }
  50%      { box-shadow: 0 0 0 12px color-mix(in srgb, var(--accent) 0%, transparent); }
}
.peek { font-size: 14px; margin-left: 6px; text-decoration: underline; text-underline-offset: 3px; }
.demo { margin: 2px 0 0; font-size: 11px; letter-spacing: .06em; color: var(--faint); }

.foot { position: relative; z-index: 8; padding: 16px var(--pad) 22px; text-align: center; font-size: 12.5px; }
.foot a { color: var(--muted); }
.fine { display: block; margin: 8px auto 0; font-size: 11px; color: var(--faint); max-width: 64ch; }

/* ===== 進場編排：由後往前依序浮現 ===== */
@media (prefers-reduced-motion: no-preference) {
  .sky, .stars, .curtains, .bokehs, .floor, .lines { animation: fadeIn 1.4s ease both; }
  /* 不能共用 fadeIn：它的終點是 opacity:1，會蓋掉 .rays 自己的 .1，
     光柱就會亮到吃掉整個畫面。自己一條，終點停在設計值。 */
  .rays          { animation: spinSlow 120s linear infinite, raysIn 2.4s ease .4s both; }
  .orbit         { animation: riseIn 1s cubic-bezier(.2, .8, .3, 1) .1s both; }
  /* .title 不套 riseIn —— KineticTitle 自己有逐字進場，再疊一層整體位移會打架 */
  .zh            { animation: riseIn .8s cubic-bezier(.2,.8,.3,1) .95s both; }
  .tag           { animation: riseIn .8s cubic-bezier(.2,.8,.3,1) 1.08s both; }
  .acts          { animation: riseIn .8s cubic-bezier(.2,.8,.3,1) .54s both; }
  .demo, .foot   { animation: fadeIn .9s ease .7s both; }
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes raysIn { from { opacity: 0; } to { opacity: .1; } }
@keyframes riseIn { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }

@media (max-width: 900px) { .orbit { --k: .8; } }
@media (max-width: 720px) {
  .orbit { --k: .66; }
  .acts { grid-auto-flow: row; width: 100%; max-width: 320px; }
  .btn.big { width: 100%; }
  .peek { margin: 4px 0 0; }
  .mote { width: 20px; height: 20px; }
  /* 觸控裝置沒有指標視差，把位移歸零免得殘留 */
  .stars, .orbit { translate: none; }
}
@media (max-width: 380px) { .orbit { --k: .56; } }
</style>
