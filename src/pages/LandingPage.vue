<script setup lang="ts">
/**
 * 形象頁 —— 進站的第一眼，展示版。
 *
 * ================= 這一版把進場整個換掉的理由 =================
 *
 * 開卡演出（CardEmerge / reveal-fx-research.md）把四條原則寫得很清楚，
 * 逐條對回來，這一頁本來四條全部沒做到：
 *
 *  1「揭曉靠遮蔽物散開，不是靠淡入」
 *    —— 本來每一層都是 fadeIn / riseIn，從 opacity 0 長出來。
 *    而且這不只是品味問題：opacity:0 的元素不算 LCP 候選，
 *    整頁的字因此沒有一個進得了首屏指標，最後 LCP 落在一張
 *    要打兩趟第三方網路才拿得到的裝飾卡圖上（實測 2.0 s）。
 *    改成：內容一開始就畫好、opacity 1，前面蓋一層**保管庫的門**，
 *    門往兩側退場才露出來。遮蔽物在前、內容不動 —— 跟煙霧揭曉同一件事。
 *
 *  2「動作是深度，不是 Y 軸」
 *    —— 本來 riseIn 是 translateY(18px)，字和舞台都在上下滑。
 *    改成：舞台由遠推近（scale 1.075 → 1），卡片各自從深處歸位。
 *    上下位移只留卡片待機那一點浮動。
 *
 *  3「衝擊感來自對比，不是更亮更多」
 *    —— 本來五幕是 night(.12) → wake(.55) → align(.85) → burst(1)，
 *    爆發前是全場第二亮的一幕，等於沒有基準線。
 *    改成：門關著的那 260 ms 是全片最暗最靜的一格，之後才放。
 *
 *  4「加碼只給高賞別 —— 衝擊一旦變成常態就不再是衝擊」
 *    —— 這一條原本被違反得最嚴重：一個全幕白閃 + 衝擊波環，
 *    每 30 秒在使用者讀登入按鈕的時候重播一次，永遠。
 *    **這一條也是唯一一條不能照搬的**：開卡是抽完才播一次的高潮，
 *    形象頁是每次進站都會看到的門面。所以這裡的正確做法不是
 *    「把爆點做得更好」，而是把它整個拿掉，改成只在進站那一次發生。
 *    詳見下面的「拿掉了什麼」。
 *
 * ---- 拿掉了什麼（以及為什麼） ----
 *   五幕 30 秒迴圈       整段刪除。門面不需要劇情，需要的是安靜。
 *   --e 自訂屬性         宣告了、@property 註冊了、transition 了 2.2 s，
 *                        然後**沒有任何一條 CSS 讀它**。而它 inherits: true，
 *                        每次幕次切換都讓整棵子樹重算樣式 2.2 秒。
 *   全幕白閃 .flash      見上面第 4 條。
 *   衝擊波環 .shock      同上。
 *   神之光 .rays         784×784 的 repeating-conic + mask + screen 混色，
 *                        永遠在轉。shader 已經畫了同一顆光源的光暈與光斑，
 *                        這層是同一件事畫兩次。
 *   散景光斑 .bokehs     九顆 screen 混色的色斑。原本的註解自己承認
 *                        shader 開著時要 dim 到 .45 —— 那就是冗餘的自白。
 *   極光簾幕 .curtains   同理，改成只在 shader 退場時才出現（那裡才需要雲氣）。
 *   流星 .meteors        兩條帶 drop-shadow 的全幕位移，九秒閃一次。
 *   星座連線 .lines      14 秒淡進淡出一次的 SVG 折線，沒人看得到。
 *   屬性光點 .motes      四顆帶 drop-shadow 的圖示飄過整個登入表單，永遠。
 *   電弧 .arcs           三條 stroke-dashoffset + drop-shadow 的 SVG，
 *                        實測單這一層就吃 22 ms/s 主執行緒，而它 84% 的
 *                        時間是隱形的。球的「有能量」交給 .halo 與 .pulse。
 *   地板捲動 floorRun    背景往前捲是跑步機，不是敘事。格線留著當地面，不動。
 *   主鈕呼吸 breathe     box-shadow 動畫 = 每一幀主執行緒重繪，永遠。
 *                        深色頁上唯一的紅色按鈕本來就夠顯眼。
 *   卡片 drop-shadow     換成 .card 的 box-shadow。同樣的影子，
 *                        但 filter 會讓整個子樹每幀重算濾鏡區域。
 *   星塵 46 → 30 顆
 *
 * 加回來的只有一個東西：**保管庫的門**（.vault），而且它在 1.5 秒後
 * 整組從 DOM 移除，之後成本歸零。
 *
 * ---- 進場的節拍 ----
 *   sealed  0 – 150 ms   門合著，中縫一道光。內容已經全部畫好在門後。
 *                        這是「收」：全片最暗、最靜的一格。
 *   open    150 – 930 ms  門往兩側退場（transform，合成層）；
 *                        同時舞台由遠推近、卡片從深處歸位、
 *                        中縫的光橫向炸開一次 —— 全片唯一的一次亮點。
 *   calm    1060 ms 起    永久待機。之後不會再有任何一次性事件。
 *
 * 整段不到 1.1 秒，而且全程 pointer-events: none —— 門還在播的時候
 * 登入／註冊／先逛逛就已經按得到。
 *
 * 為什麼是 1.1 秒不是原本設計的 1.5 秒：逐格比對前後版本時發現，
 * 舊版在 60 ms 就已經能讀到 CTA（因為它根本沒有遮蔽物，只是各層還在淡入），
 * 而 1.5 秒版的門要到 700 ms 才讓人看得懂畫面。**門面頁不能用結局演出的長度。**
 * 壓到 1.1 秒之後，可讀的時間點回到 450 ms 左右，
 * 揭曉的動作還在，但不再是「先讓使用者等一下」。
 *
 * ---- 分層（由後往前） ----
 *   0 著色器星空（或 CSS 退路）→ 0e 地平線 → 1 星塵 → 3 軌道環
 *   → 4 環繞卡 → 5 球 → 7 文字 → 9 保管庫的門（只在前 1.5 秒）
 *
 * 寶可夢元素全部用 CSS／SVG 畫出「形狀語彙」，不下載官方素材：
 * 寶貝球分模線、精靈球開闔的光。
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
import { FAIRNESS_UI, MOCK } from '@/lib/config'
import { ApiError } from '@/lib/http'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const busy = ref<'login' | 'register' | 'line' | null>(null)

/* API 模式的登入表單。mock 模式不顯示，一鍵進站照舊 */
const showEmail = ref(false)
const email = ref('')
const password = ref('')
const loginErr = ref('')

function afterLogin() {
  const back = typeof route.query.redirect === 'string' ? route.query.redirect : ''
  if (back && back.startsWith('/')) router.replace(back)
  else router.replace({ name: 'home' })
}

/* LINE 登入回來時網址是 /login#code=…；換取 JWT 後就直接進站。
   LINE 那邊拒絕或驗證失敗會帶 ?line=denied|state|token|verify 回來。 */
onMounted(async () => {
  if (MOCK) return
  try {
    if (await auth.consumeToken()) { afterLogin(); return }
  } catch {
    /* 一定要接。consumeToken() 只有在網址帶著 #code=… 時才會真的打 API，
       但那正是「LINE 剛把人導回來」的那一刻 —— 後端這時候沒醒（冷啟動）
       就是一個未捕捉的 mounted hook 錯誤，而 <script setup> 裡的未捕捉錯誤
       會摧毀整棵元件樹（SPEC §10.5）：使用者從 LINE 回來只看到白畫面，
       連「再登入一次」的按鈕都沒有。接住之後，登入面板還在，他可以重按。 */
    loginErr.value = 'LINE 登入沒有完成，請再試一次'
    return
  }
  const why = typeof route.query.line === 'string' ? route.query.line : ''
  if (why) loginErr.value = why === 'denied' ? '你取消了 LINE 登入' : 'LINE 登入沒有完成，請再試一次'
})

/* ================= 進場節拍 =================
   三個狀態，一次演完，然後永遠停在最後一個。

   前一版是五幕 30 秒無限迴圈。拿掉它的理由不是效能（雖然效能也是）：
   形象頁是使用者**每次進站都會看到**的畫面，不是抽完卡才播一次的結局。
   在這裡放一個每 30 秒重來一次的爆發，等於把「衝擊」變成壁紙的一部分 ——
   而且那 30 秒裡使用者多半正在讀登入按鈕，畫面卻在搶他的注意力。

   門的開闔本身用 CSS animation + delay，不靠這裡的 class 準時翻 ——
   setTimeout 會漂，animation-delay 不會，兩者差幾毫秒門就會抽一下。
   這裡的 stage 只負責兩件事：餵 shader 的能量、以及把門從 DOM 拿掉。 */
type Stage = 'sealed' | 'open' | 'calm'
const stage = ref<Stage>('sealed')
/** 門還在不在 DOM 裡。演完就整組移除，之後成本歸零 */
const veiled = ref(true)

/* 著色器背景。拿不到 WebGL2（或跑太慢被判定為軟體渲染）就 fail，
   退回原本那套 CSS 圖層 —— 兩者是同一個視覺方向，退化不會像壞掉。 */
/* ?nogl=1 強制走 CSS 退路。
   留著不是為了除錯方便而已 —— WebGL 在某些裝置／驅動上會「能建立但畫面全黑」，
   那種情況偵測不到，得有一個使用者或客服能直接指定的開關。 */
const sky3d = ref(!new URLSearchParams(location.search).has('nogl'))
const skyFps = ref<number | null>(null)
/* 餵給 shader 的能量。三個數字就是這一頁的明暗節拍：
   門關著的時候最暗（這是基準線），門開的那一下最亮，然後落到待機。
   shader 內部每幀往目標插值 2%，所以這裡給階梯值、畫面上是滑過去的。 */
const ENERGY: Record<Stage, number> = { sealed: .08, open: .78, calm: .34 }

/* 球在畫面上的垂直位置，餵給 shader 當光源座標。
   實測量出來的：桌機球心約在 28%、手機約 26%。寫死一個近似值就夠 ——
   要精準到跟著版面走，得每幀讀 getBoundingClientRect，不值得。 */
const coreY = ref(0.28)
onMounted(() => {
  const el = document.querySelector('.ball')
  if (!el) return
  const b = el.getBoundingClientRect()
  if (b.height) coreY.value = (b.top + b.height / 2) / window.innerHeight
})
const timers: number[] = []

const mq = (q: string) => typeof matchMedia !== 'undefined' && matchMedia(q).matches
const reduceMotion = () => mq('(prefers-reduced-motion: reduce)')

onMounted(() => {
  /* 關動效的人：門從來不掛上去，直接是最終畫面。
     因為內容本來就是 opacity 1，少了門畫面仍然成立 ——
     這是把揭曉做成「遮蔽物」而不是「淡入」順帶換到的好處：
     降級路徑不需要另外寫一份，把遮蔽物拿掉就是了。 */
  if (reduceMotion()) { stage.value = 'calm'; veiled.value = false; return }
  timers.push(window.setTimeout(() => { stage.value = 'open' }, 150))
  timers.push(window.setTimeout(() => { stage.value = 'calm'; veiled.value = false }, 1060))
})
onBeforeUnmount(() => timers.forEach(clearTimeout))

/* 分頁看不見就把待機的環境動畫停掉。
   ShaderSky 自己已經會停 rAF；這裡停的是 CSS 那幾層（星塵、光暈、卡片浮動）。
   瀏覽器在背景分頁本來就會少畫，但明確 paused 才是真的不排合成工作。 */
const away = ref(false)
function onVis() { away.value = document.hidden }
onMounted(() => document.addEventListener('visibilitychange', onVis))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVis))

/* ---- 環繞的卡 ----
   先畫卡背（不必等網路），卡面示意圖抓到才淡入蓋上去。
   這樣首屏永遠是完整的，慢網路只是少了圖不是缺一塊。 */
/* `in` 是進場時各自從深處歸位的延遲（秒）。四張不同時到位 ——
   同時到位讀起來是一整片貼圖在縮放，錯開才像四個各自有距離的東西。
   上排先、下排後：近的東西後到，符合「鏡頭推近」的視差順序。 */
const ORBIT = [
  { name: '噴火龍', x: -168, y: -74, rot: -15, s: .96, dur: 6.4, delay: 0, in: .19 },
  { name: '皮卡丘', x: 172, y: -56, rot: 13, s: 1, dur: 7.2, delay: -1.6, in: .25 },
  { name: '夢幻', x: -140, y: 104, rot: 11, s: .88, dur: 6.8, delay: -3.1, in: .31 },
  { name: '妙蛙種子', x: 150, y: 118, rot: -10, s: .92, dur: 7.6, delay: -4.4, in: .37 }
]
const art = ref<(string | null)[]>(ORBIT.map(() => null))
onMounted(() => {
  ORBIT.forEach((c, i) => {
    canonicalArt(c.name, 'low').then(u => { if (u) art.value[i] = u })
  })
})

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
/* 46 → 30 顆。星塵是這一頁待機時唯一還在動的 DOM 層，每一顆都是一支
   無限的 opacity 動畫；顆數就是成本。實際看過去，30 顆跟 46 顆的差別
   是「數不出來」跟「數不出來」。 */
const rnd = mulberry32(20260817)
const STARS = Array.from({ length: 30 }, () => ({
  x: +(rnd() * 100).toFixed(2),
  y: +(rnd() * 100).toFixed(2),
  s: +(rnd() * 1.9 + 0.7).toFixed(2),
  o: +(rnd() * 0.5 + 0.25).toFixed(2),
  dur: +(rnd() * 4 + 2.6).toFixed(1),
  delay: +(-rnd() * 6).toFixed(1)
}))

/* ---- 視差 ----
   指標移動時各層位移不同。用 CSS 變數餵給 transform，
   不在 JS 裡逐層改 style —— 一次寫兩個變數，其餘交給 CSS。 */
/* --px / --py 掛在根節點上，而且是**沒有註冊過**的自訂屬性 ——
   改它一次就讓整棵子樹的樣式失效。桌機上滑鼠一動就是每幀一次全樹重算。
   所以只在真的有精確指標的裝置才掛這個監聽：
   觸控裝置本來就沒有 pointermove（而且 720px 以下的 media query
   已經把位移歸零），關動效的人也不需要。 */
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
onMounted(() => {
  if (reduceMotion() || !mq('(hover: hover) and (pointer: fine)')) return
  window.addEventListener('pointermove', onMove, { passive: true })
})
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onMove)
  if (raf) cancelAnimationFrame(raf)
})

async function goIn(kind: 'login' | 'register') {
  if (busy.value) return
  haptic('tap')
  loginErr.value = ''
  busy.value = kind
  try {
    if (kind === 'register') await auth.register(email.value, password.value)
    else await auth.login(email.value, password.value)
    afterLogin()
  } catch (e) {
    loginErr.value = e instanceof ApiError ? e.message : '登入失敗，請再試一次'
  } finally {
    busy.value = null
  }
}

function goLine() {
  if (busy.value) return
  haptic('tap')
  busy.value = 'line'
  auth.loginWithLine()   // 整頁導向，不會回來這裡
}
</script>

<template>
  <div class="land" :class="[`st-${stage}`, { away }]" :style="{ '--px': px, '--py': py }">
    <!-- ===== 0 背景 =====
         優先用著色器即時算的星雲；失敗才退回下面那套 CSS 圖層。
         兩者不同時開 —— 疊在一起會互相洗掉對比，變成一片灰紫。 -->
    <ShaderSky
      v-if="sky3d"
      class="skyGl"
      :energy="ENERGY[stage]"
      :burst="stage === 'open'"
      :core-y="coreY"
      @fail="sky3d = false"
      @fps="v => (skyFps = v)"
    />

    <!-- CSS 退路：拿不到 WebGL2 時才出現。
         簾幕（.curtains）本來是無條件掛上去、shader 開著時再 dim 到 .34 ——
         那等於承認它在 shader 模式下是多的。改成跟 .sky 一起只走退路：
         那邊沒有 shader 算出來的雲氣，才真的需要有東西填出層次。 -->
    <template v-if="!sky3d">
      <div class="sky" aria-hidden="true">
        <div class="aur a1"></div>
        <div class="aur a2"></div>
        <div class="aur a3"></div>
        <div class="vignette"></div>
      </div>
      <div class="curtains" aria-hidden="true">
        <div class="curtain c1"></div>
        <div class="curtain c2"></div>
      </div>
    </template>

    <!-- ===== 0e 透視地平線格線：靜態。給球一個站的地方，不捲動 ===== -->
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
            '--dur': c.dur + 's', '--delay': c.delay + 's', '--in': c.in + 's'
          }"
        >
          <!-- 多一層 .card：待機的浮動掛在這裡，用純 px 的 transform。
               本來浮動是掛在 .fly 的 translate 上，而那個 translate 帶著
               `- 50%` 的百分比置中 —— 百分比要對元素自己的盒子解析，
               瀏覽器因此每一幀都替整個舞台重跑一次版面配置（實測 60 次/秒）。
               把「定位」與「浮動」拆成兩層之後，浮動就純粹是合成層的事。 -->
          <div class="card">
            <span class="emblem"></span>
            <img v-if="art[i]" :src="art[i]!" alt="" class="face" loading="lazy" decoding="async" />
            <span class="sheen"></span>
          </div>
        </div>

        <!-- 5 球 + 能量脈衝環 -->
        <div class="ball">
          <span class="pulse p1"></span>
          <span class="pulse p2"></span>
          <span class="halo"></span>
          <CapsuleArt tier="LAST" compact flat />
        </div>
      </div>

      <!-- 7 文字
           英文當主視覺（動態標題），中文留在下面當真正讀的那一行 ——
           使用者是台灣人，資訊要用中文讀；英文負責的是氣勢不是傳達。

           不用「寶可夢」當主標：那是別人的商標，放成自己的招牌會讀起來
           像官方授權或聯名，跟「我們賣寶可夢卡」這種描述性使用不是同一件事。
           主標講的是這個站是什麼（鑑定卡的交易場），品類留在說明行。

           標題只演一次（本來綁 :key="cycle"，每輪 30 秒重演一遍）。
           shine="once" 與 glitch-every="0" 關掉待機時的無限迴圈 ——
           那幾支動畫加起來是 95 支永遠在跑的動畫，全部長在首屏上。
           delay 對齊門開的那一拍：字是被門讓開之後才升起來的。 -->
      <h1 class="title">
        <KineticTitle
          :lines="['GRADED', 'CARD EXCHANGE']"
          label="Graded card exchange"
          :stagger="24"
          :delay="190"
          shine="once"
          :glitch-every="0"
        />
      </h1>
      <p class="zh">鑑定卡的交易中心</p>
      <p class="tag muted">抽選 · 市場 · 卡冊 · 玩家互換</p>

      <!-- mock：一鍵進站 -->
      <template v-if="MOCK">
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
      </template>

      <!-- API：LINE 為主、Email 為備援 -->
      <template v-else>
        <!-- 兩個登入入口是同一組決定，做成一樣寬高並列；
             「先逛逛」是不登入直接看，屬於另一種動作，所以留在外面當唯一的文字連結 -->
        <div class="authBox">
          <button type="button" class="btn auth line" :disabled="!!busy" @click="goLine">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3C6.5 3 2 6.6 2 11c0 3.9 3.5 7.2 8.2 7.9.3.1.8.2.9.5.1.3.1.7 0 1l-.1.9c0 .3-.2 1 .9.6s5.9-3.5 8.1-6c1.5-1.6 2-3.3 2-4.9C22 6.6 17.5 3 12 3z"/></svg>
            {{ busy === 'line' ? '前往 LINE…' : '用 LINE 登入' }}
          </button>
          <button v-if="!showEmail" type="button" class="btn auth email" @click="showEmail = true">
            用 Email 登入或註冊
          </button>

          <form v-if="showEmail" class="emailForm" @submit.prevent="goIn('login')">
            <input v-model="email" type="email" autocomplete="email" placeholder="Email" required />
            <input v-model="password" type="password" autocomplete="current-password" placeholder="密碼（至少 8 碼）" required minlength="8" />
            <div class="formRow">
              <button type="submit" class="btn auth primary" :disabled="!!busy">
                {{ busy === 'login' ? '登入中…' : '登入' }}
              </button>
              <button type="button" class="btn auth" :disabled="!!busy" @click="goIn('register')">
                {{ busy === 'register' ? '建立中…' : '註冊' }}
              </button>
            </div>
          </form>
        </div>

        <p v-if="loginErr" class="loginErr" role="alert">{{ loginErr }}</p>
        <RouterLink :to="{ name: 'home' }" class="peek solo">先逛逛 →</RouterLink>
      </template>
    </main>

    <footer class="foot muted">
      <!-- 公平性入口暫時收起來（見 lib/config.ts 的 FAIRNESS_UI）。
           跟全域頁尾一樣：連結連同後面的「·」一起進出，
           不然這一列會以一個孤零零的間隔點開頭。 -->
      <template v-if="FAIRNESS_UI">
        <RouterLink :to="{ name: 'fairness' }">公平性</RouterLink> ·
      </template>
      <RouterLink :to="{ name: 'terms' }">會員條款</RouterLink> ·
      <RouterLink :to="{ name: 'privacy' }">隱私權政策</RouterLink>
      <span class="fine">
        點數僅可用於站內抽選與兌換商品，不可提領現金或轉讓。未滿 18 歲需監護人同意方可使用。
        卡面為示意圖，版權屬各自所有權人。
      </span>
    </footer>

    <!-- ===== 9 保管庫的門 =====
         這是整個進場唯一新增的東西，而且 1.5 秒後整組從 DOM 移除。

         它為什麼是門而不是煙：CardEmerge 用煙，是因為那裡要的是「材料」——
         煙散開之後還要變成卡片凝聚的原料。這裡不需要材料，需要的是一個
         「本來關著、現在開了」的動作，而這個站叫 VaultDraw，門就是它自己的字。

         全程 pointer-events: none：門還在播的時候三個出口就已經按得到。
         使用者不必等演出結束，這是門面跟結局演出的另一個差別。 -->
    <div v-if="veiled" class="vault" aria-hidden="true">
      <span class="leaf l"></span>
      <span class="leaf r"></span>
      <span class="seam"></span>
      <span class="haze"></span>
    </div>
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

/* ================= 保管庫的門 =================
   進場的主角。原則是 CardEmerge 的第一條：**揭曉靠遮蔽物散開，不是靠淡入。**

   所以這底下的內容一律不做 opacity 動畫 —— 它們從第一幀就是完成品，
   只是被門蓋著。門走了就露出來。這帶來三個好處：
     1 讀起來是「開門」而不是「東西一個一個浮出來」
     2 opacity: 0 的元素不算首屏 LCP 候選，不做淡入就不會拖到指標
     3 關動效時把門拿掉就是最終畫面，降級路徑不必另外寫

   門的動作全部是 transform / opacity，而且只有四個元素，
   所以整段進場在合成層上跑，不碰版面配置。 */
.vault {
  position: absolute; inset: 0; z-index: 9;
  pointer-events: none;          /* 三個出口在門還沒開完時就要按得到 */
  contain: strict;
}
.leaf {
  position: absolute; top: -2%; bottom: -2%; width: 54%;
  will-change: transform;
}
/* 內緣要羽化。硬邊的門看起來是兩塊色塊在滑，
   羽化過的內緣看起來才像光從縫裡漏出來、越開越多。 */
.l {
  left: 0;
  background: linear-gradient(90deg,
    #07050e 0 74%, rgba(7, 5, 14, .97) 88%, rgba(9, 6, 18, .62) 96%, rgba(9, 6, 18, 0) 100%);
}
.r {
  right: 0;
  background: linear-gradient(270deg,
    #07050e 0 74%, rgba(7, 5, 14, .97) 88%, rgba(9, 6, 18, .62) 96%, rgba(9, 6, 18, 0) 100%);
}
/* 中縫的光。門合著的時候它是唯一亮的東西 —— 也就是說，
   第一格畫面不是全黑（全黑讀起來像還沒載入），是「有東西關在裡面」。 */
.seam {
  position: absolute; left: 50%; top: 0; bottom: 0;
  width: 3px; translate: -50% 0;
  background: linear-gradient(180deg,
    transparent 0%, rgba(255, 236, 196, .1) 18%, rgba(255, 242, 214, .95) 46%,
    rgba(255, 242, 214, .95) 54%, rgba(255, 236, 196, .1) 82%, transparent 100%);
  mix-blend-mode: screen;
  will-change: transform, opacity;
}
/* 殘餘的暖霾：門帶走的那一層。跟著門一起散，不是自己淡出。
   刻意小而短：第一版做到 150vmax、峰值 .9，結果是一片奶油色的膜蓋在
   登入按鈕上將近一秒 —— 霧是用來「被帶走」的，不是用來蓋住 CTA 的。
   收到 78vmax、峰值 .5，而且比門早一點收乾淨。 */
.haze {
  position: absolute; left: 50%; top: 34%;
  width: 78vmax; height: 78vmax; translate: -50% -50%;
  background: radial-gradient(circle closest-side,
    rgba(255, 226, 178, .26) 0%, rgba(190, 140, 255, .12) 36%, transparent 70%);
  mix-blend-mode: screen;
  opacity: 0;
  will-change: transform, opacity;
}

/* ---- 節拍 ----
   用 animation + delay 而不是 class 翻頁的 transition：
   class 是 setTimeout 翻的，會漂幾毫秒；門一漂就會抽一下。
   animation-delay 是算繪引擎自己排的，不會漂。 */
@media (prefers-reduced-motion: no-preference) {
  /* sealed（0–260 ms）由 animation-delay 的空窗負責：門就停在起點不動。 */
  .l { animation: leafL .78s cubic-bezier(.56, 0, .14, 1) .15s both; }
  .r { animation: leafR .78s cubic-bezier(.56, 0, .14, 1) .15s both; }
  .seam { animation: seamFlare .78s cubic-bezier(.2, .78, .28, 1) .15s both; }
  .haze { animation: hazeOut .70s cubic-bezier(.24, .68, .2, 1) .17s both; }
}
@keyframes leafL { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(-104%, 0, 0); } }
@keyframes leafR { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(104%, 0, 0); } }
/* 中縫：門一開，累了 260 ms 的光橫向炸開一次，然後被門帶走。
   這是全片唯一的亮點 —— 只有一次，所以它是衝擊而不是壁紙。 */
@keyframes seamFlare {
  0%   { opacity: .9;  transform: scaleX(1) scaleY(.86); }
  9%   { opacity: 1;   transform: scaleX(16) scaleY(1); }
  26%  { opacity: .30; transform: scaleX(38) scaleY(1); }
  58%  { opacity: .06; transform: scaleX(74) scaleY(1); }
  100% { opacity: 0;   transform: scaleX(118) scaleY(1.04); }
}
/* 亮度必須比寬度先退。第一版讓它在 46% 還留著 .45 的不透明度，
   那時它已經 190 px 寬 —— 讀起來不是「光從縫裡溢出來」，
   是「畫面中間插了一根白棒子」。光要炸得快、退得更快。 */
@keyframes hazeOut {
  0%   { opacity: .5; transform: translate(-50%, -50%) scale(.4); }
  62%  { opacity: .22; }
  100% { opacity: 0;  transform: translate(-50%, -50%) scale(1.1); }
}

/* ================= 鏡頭 =================
   由遠推近，不是由下往上。CardEmerge 的第二條：動作是深度，不是 Y 軸。
   用獨立的 scale 屬性 —— translate 給了視差，兩者互不干擾。 */
@media (prefers-reduced-motion: no-preference) {
  .orbit { animation: camIn .95s cubic-bezier(.24, .74, .22, 1) .15s both; }
}
@keyframes camIn { from { scale: 1.075; } to { scale: 1; } }

/* 著色器背景鋪在最底 */
.skyGl { position: absolute; inset: 0; z-index: 0; pointer-events: none; }

/* 待機的環境動畫（星塵、光暈、脈衝、球的浮動、卡片的浮動）在兩種情況下停住：

   away      分頁看不見。無限迴圈在使用者看不到的時候沒有理由繼續。
   st-sealed 門還關著。「最靜的一格」如果底下有東西在動，那就不是最靜的一格 ——
             基準線要低，就要真的低。環境的生命從門開的那一刻才開始。 */
.land.away .stars i,
.land.away .halo,
.land.away .pulse,
.land.away .ball,
.land.away .card,
.land.st-sealed .stars i,
.land.st-sealed .halo,
.land.st-sealed .pulse,
.land.st-sealed .ball,
.land.st-sealed .card { animation-play-state: paused; }

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
  opacity: .42;
}
/* 本來這裡有 floorRun：格線永遠往觀者捲。拿掉了 ——
   那是跑步機不是敘事，而且 background-position 動畫每一幀都要主執行緒
   重繪整條 42vh 的帶子。地板的工作是給球一個站的地方，站著就好。 */

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

/* 4 環繞卡 */
/* .fly 只負責「在哪裡」，而且是靜態的。
   進場動的是 scale（由遠歸位），待機動的是子層的 translateY。
   三個屬性各歸各的，誰都不用去覆蓋誰。 */
.fly {
  position: absolute; top: 50%; left: 50%; z-index: 4;
  width: calc(100px * var(--k) * var(--s));
  aspect-ratio: 5 / 7;
  translate: calc(var(--x) * var(--k) - 50%) calc(var(--y) * var(--k) - 50%);
  rotate: var(--rot);
}
@media (prefers-reduced-motion: no-preference) {
  /* 進場：從深處（小、更遠）歸位。四張各自的 --in 錯開 */
  .fly { animation: cardIn .82s cubic-bezier(.2, .78, .24, 1) var(--in) both; }
  /* 待機：純 px 的上下浮動，掛在子層，不碰版面 */
  .card { animation: bobCard var(--dur) ease-in-out var(--delay) infinite alternate; }
}
@keyframes cardIn { from { scale: .74; } to { scale: 1; } }
@keyframes bobCard {
  from { transform: translateY(-11px); }
  to   { transform: translateY(13px); }
}
/* 卡背先畫好，卡面抓到才蓋上去 —— 慢網路只是少了圖，不是缺一塊 */
/* 影子用 box-shadow 不用 filter: drop-shadow。
   這是一個有 border-radius 的矩形，兩者看起來一樣；但 drop-shadow 是濾鏡，
   子層一動就要重算整個濾鏡區域，box-shadow 只是合成層的一部分。 */
.card {
  position: relative; width: 100%; height: 100%;
  border-radius: calc(9px * var(--k)); overflow: hidden;
  background:
    radial-gradient(120% 90% at 50% 0%, #3a2f52, transparent 60%),
    linear-gradient(160deg, #241d35 0%, #171226 52%, #221a33 100%);
  border: 1px solid rgba(255, 255, 255, .14);
  box-shadow: 0 14px 30px rgba(0, 0, 0, .66);
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
/* 全像反光。本來是 5.5 秒無限迴圈 —— background-position 是主執行緒
   重繪的屬性，四張卡等於永遠有四塊在重畫。
   改成：進場掃一次（那是卡片「到位」的那一下），之後停在斜角的靜態高光。
   靜態高光已經足夠說明「這是有膜的卡」，掃光的資訊只在它掃過的那一瞬間。 */
.sheen {
  position: absolute; inset: 0;
  background: linear-gradient(112deg, transparent 30%, rgba(255, 255, 255, .42) 48%, transparent 66%);
  background-size: 260% 100%;
  background-position: 78% 0;
  mix-blend-mode: screen;
}
@media (prefers-reduced-motion: no-preference) {
  .sheen { animation: holo 1.1s ease-out calc(var(--in) + .18s) both; }
}
@keyframes holo {
  from { background-position: 190% 0; }
  to   { background-position: 78% 0; }
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
  font-weight: 700;
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

/* ===== 登入區 =====
   三個層級要一眼分得出來，之前 Email 跟「先逛逛」共用同一個底線連結樣式，
   兩條看起來一模一樣的字疊在一起，等於沒有主次：
     1 LINE      主要入口 —— 品牌實心色
     2 Email     同樣是真的入口，所以也是按鈕、同寬同高，但用描邊不搶主色
     3 先逛逛     不登入直接看，是另一種動作 —— 唯一的文字連結，並且拉開距離
   寬度收在 300px：按鈕橫拉太寬會失去「可按」的形狀感，變成一條色帶。 */
.authBox {
  display: grid;
  gap: 10px;
  width: min(300px, 100%);
  margin: 26px auto 0;
}
.btn.auth {
  width: 100%;
  min-height: 50px;
  padding: 0 20px;
  font-size: 15px;
  letter-spacing: .01em;
}
.btn.auth.line { background: #06C755; border-color: #06C755; color: #fff; }
.btn.auth.line svg { width: 19px; height: 19px; fill: currentColor; flex: none; }
.btn.auth.email {
  background: color-mix(in srgb, #cdbdf0 9%, transparent);
  border-color: color-mix(in srgb, #cdbdf0 40%, transparent);
  color: #e8e2f4;
}
@media (hover: hover) {
  .btn.auth.line:hover { background: #05b34c; border-color: #05b34c; box-shadow: 0 10px 26px rgba(6, 199, 85, .3); }
  .btn.auth.email:hover { background: color-mix(in srgb, #cdbdf0 12%, transparent); border-color: color-mix(in srgb, #cdbdf0 46%, transparent); }
}

.emailForm { display: grid; gap: 10px; }
.emailForm input {
  width: 100%; min-height: 50px; padding: 10px 16px; font-size: 15px;
  background: color-mix(in srgb, #0b0716 55%, transparent);
  border: 1px solid color-mix(in srgb, #cdbdf0 22%, transparent);
  border-radius: var(--pill); color: #e8e2f4;
}
.emailForm input::placeholder { color: color-mix(in srgb, #cdbdf0 45%, transparent); }
.emailForm input:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, #cdbdf0 60%, transparent);
  background: color-mix(in srgb, #0b0716 75%, transparent);
}
/* 登入／註冊是一組對等選擇，等寬並列比上下排更快讀。
   minmax(0, …) 是預防性的：1fr 等同 minmax(auto, 1fr)，兩顆按鈕只要有一顆
   的文字比欄寬長就會撐開自己、擠扁另一顆（.formRow 目前在展示版沒有掛上，
   等 Email 表單接回來就會遇到）。 */
.formRow { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }

.loginErr { margin: 12px 0 0; font-size: 13px; color: var(--danger); }
.btn.big { padding: 14px 32px; font-size: 16px; }
/* 本來主鈕有一支 breathe 光暈（box-shadow 無限迴圈）。拿掉了：
   box-shadow 動畫是每一幀主執行緒重繪，而且是永遠 —— 實測它是整頁
   清空所有圖層之後**還剩下**的那 27 ms/s。深色頁面上唯一的實心紅按鈕
   本來就是全場最顯眼的東西，再讓它呼吸只是替它自己製造雜訊。 */
/* 文字連結。不加底線 —— 底線的視覺重量會讓它跟上面的按鈕搶層級，
   它要明顯更輕才對。mock 模式是排在 .acts 那一列裡，維持行內間距。 */
.peek {
  font-size: 14px; color: var(--muted); text-decoration: none; transition: color .18s;
  /* 觸控目標補到 44px。做法與頁尾連結、App.vue 一致：
     內距長出可點範圍，等量負外距把版面高度收回來。
     這一行本來只有 22 px 高，而它是三個出口之一 —— 不登入直接逛的那個出口，
     偏偏是最不該讓人點不到的。 */
  display: inline-block;
  padding: 12px 10px;
  margin: -12px 0;
}
.acts .peek { margin-left: 6px; }
/* 原本 margin-top: 20px。補了 12px 內距之後要加回去才是同樣的視覺間距 */
.peek.solo { margin-top: 32px; font-size: 13.5px; }
@media (hover: hover) { .peek:hover { color: #e8e2f4; } }
.demo { margin: 2px 0 0; font-size: 11px; letter-spacing: .06em; color: var(--faint); }

.foot { position: relative; z-index: 8; padding: 20px var(--pad) 26px; text-align: center; font-size: 12.5px; }
/* 觸控目標補到 44px，做法與 App.vue 的頁尾一致：內距長出可點範圍、
   等量負外距把版面高度收回來。這一列本來只有 15px 高，手指點不準。 */
.foot a {
  color: var(--muted); text-decoration: none;
  display: inline-block; padding: 15px 6px; margin: -15px 0;
}
@media (hover: hover) { .foot a:hover { color: #e8e2f4; } }
/* 免責條款：11px 拉到 64ch 太密，一行太長眼睛會找不到下一行的開頭。
   收窄到 46ch 並把行高拉開，讀起來才不像一團字。 */
.fine {
  display: block; margin: 12px auto 0;
  font-size: 11px; line-height: 1.85; color: var(--faint);
  max-width: 46ch;
}

/* ===== 進場編排 =====
   這裡本來有七條 fadeIn / riseIn：背景層、舞台、中文行、標語、按鈕組、
   說明、頁尾，各自從 opacity 0 加 translateY(18px) 長出來。全部拿掉了。

   理由有兩層。
   表面那層是 CardEmerge 的前兩條：揭曉要靠遮蔽物離開，不是靠內容淡入；
   而位移要走深度，不是走 Y 軸。這七條同時違反了兩條。
   底下那層是量出來的：opacity 0 的元素不是 LCP 候選，
   所以整頁的字沒有一個進得了首屏指標 —— 實測 LCP 候選只有兩個，
   一個是左上角的 wordmark，一個是要打兩趟第三方網路才拿得到的裝飾卡圖。
   把淡入拿掉，字從第一幀就在那裡（只是被門蓋著），指標與體感同時變好。

   現在還留著的進場動作只有三個，而且全部是「深度」或「遮蔽」：
     .vault  門往兩側退場（遮蔽物離開）
     .orbit  camIn，舞台由遠推近（深度）
     .fly    cardIn，四張卡各自從深處歸位（深度）
   文字完全不動 —— 它本來就在那裡。 */

@media (max-width: 900px) { .orbit { --k: .8; } }
@media (max-width: 720px) {
  .orbit { --k: .66; }
  .acts { grid-auto-flow: row; width: 100%; max-width: 320px; }
  .btn.big { width: 100%; }
  .acts .peek { margin: -8px 0 -12px; }
  /* 觸控裝置沒有指標視差，把位移歸零免得殘留 */
  .stars, .orbit { translate: none; }
}
@media (max-width: 380px) { .orbit { --k: .56; } }
</style>
