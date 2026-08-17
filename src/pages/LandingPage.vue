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
import { canonicalArt } from '@/lib/tcgdex'
import { haptic } from '@/lib/haptics'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const busy = ref<'login' | 'register' | null>(null)

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
  <div class="land" :style="{ '--px': px, '--py': py }">
    <!-- ===== 0 極光星雲 ===== -->
    <div class="sky" aria-hidden="true">
      <div class="aur a1"></div>
      <div class="aur a2"></div>
      <div class="aur a3"></div>
      <div class="vignette"></div>
    </div>

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

        <!-- 5 球 + 能量脈衝環 -->
        <div class="ball">
          <span class="pulse p1"></span>
          <span class="pulse p2"></span>
          <CapsuleArt tier="LAST" compact flat />
        </div>
      </div>

      <!-- 7 文字 -->
      <h1 class="title">每一支籤，<br class="br">開賣前就已封存。</h1>
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

/* 4 環繞卡 */
.fly {
  position: absolute; top: 50%; left: 50%; z-index: 4;
  width: calc(100px * var(--k) * var(--s));
  aspect-ratio: 5 / 7;
  translate: calc(var(--x) * var(--k) - 50%) calc(var(--y) * var(--k) - 50%);
  rotate: var(--rot);
  filter: drop-shadow(0 14px 30px rgba(0, 0, 0, .66));
}
@media (prefers-reduced-motion: no-preference) {
  .fly { animation: bobCard var(--dur) ease-in-out var(--delay) infinite alternate; }
}
@keyframes bobCard {
  from { translate: calc(var(--x) * var(--k) - 50%) calc(var(--y) * var(--k) - 50% - 11px); }
  to   { translate: calc(var(--x) * var(--k) - 50%) calc(var(--y) * var(--k) - 50% + 13px); }
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
.title {
  position: relative;
  margin: 6px 0 0;
  font-size: clamp(27px, 4.8vw, 42px);
  line-height: 1.2; letter-spacing: -.02em; font-weight: 700;
  text-wrap: balance;
  /* 漸層字 + 掃光：亮部靠 background-position 移動 */
  background: linear-gradient(100deg, #fff 0 38%, #ffd9ef 46%, #b9a2ff 54%, #fff 62% 100%);
  background-size: 260% 100%;
  -webkit-background-clip: text; background-clip: text;
  color: transparent;
}
@media (prefers-reduced-motion: no-preference) {
  .title { animation: shimmer 7s ease-in-out infinite; }
}
@keyframes shimmer {
  0%, 55% { background-position: 180% 0; }
  100%    { background-position: -60% 0; }
}
.br { display: none; }
.tag { margin: -4px 0 0; font-size: 14px; letter-spacing: .06em; }

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
  .sky, .stars   { animation: fadeIn 1.1s ease both; }
  .orbit         { animation: riseIn 1s cubic-bezier(.2, .8, .3, 1) .1s both; }
  .title         { animation: shimmer 7s ease-in-out infinite, riseIn .8s cubic-bezier(.2,.8,.3,1) .3s both; }
  .tag           { animation: riseIn .8s cubic-bezier(.2,.8,.3,1) .42s both; }
  .acts          { animation: riseIn .8s cubic-bezier(.2,.8,.3,1) .54s both; }
  .demo, .foot   { animation: fadeIn .9s ease .7s both; }
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes riseIn { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }

@media (max-width: 900px) { .orbit { --k: .8; } }
@media (max-width: 720px) {
  .orbit { --k: .66; }
  .br { display: inline; }
  .acts { grid-auto-flow: row; width: 100%; max-width: 320px; }
  .btn.big { width: 100%; }
  .peek { margin: 4px 0 0; }
  .mote { width: 20px; height: 20px; }
  /* 觸控裝置沒有指標視差，把位移歸零免得殘留 */
  .stars, .orbit { translate: none; }
}
@media (max-width: 380px) { .orbit { --k: .56; } }
</style>
