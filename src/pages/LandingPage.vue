<script setup lang="ts">
/**
 * 形象頁 —— 進站的第一眼。
 *
 * 一顆大師球，四張卡繞著它浮。不放三步流程、不放池清單、不放跑馬燈 ——
 * 那些是大廳的事。形象頁只做兩件事：讓人一眼知道這是什麼、把人送進去。
 *
 * 登入／註冊目前是「走個形式」：按下去就進站，不填表。
 * 這是刻意的暫時狀態 —— 後端還沒有，假的表單只會擋住人。
 * 接上後端時把 goIn() 換成真的表單即可，auth store 的介面不用動。
 */
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import CapsuleArt from '@/components/CapsuleArt.vue'
import { haptic } from '@/lib/haptics'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const busy = ref<'login' | 'register' | null>(null)

/* 環繞的卡畫「卡背」不畫卡面。
   兩個理由：卡面佔位圖是淡色漸層，四張淡色方塊圍著球會被讀成一個方框；
   而且這裡沒有真的卡，畫卡面等於假裝有。卡背是誠實的，也更像一疊未開的卡。
   角度／半徑／週期各自不同，看起來才像各自漂浮而不是一個轉盤。
   s = 縮放，遠的小一點做出景深。 */
const ORBIT = [
  { x: -142, y: -68, rot: -14, s: .94, delay: 0, dur: 6.4, z: 2 },
  { x: 146, y: -52, rot: 12, s: 1, delay: -1.6, dur: 7.2, z: 2 },
  { x: -118, y: 96, rot: 10, s: .88, delay: -3.1, dur: 6.8, z: 3 },
  { x: 128, y: 108, rot: -9, s: .92, delay: -4.4, dur: 7.6, z: 3 }
]

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
  <div class="land">
    <div class="field" aria-hidden="true"><div class="glow"></div></div>

    <header class="brand">
      <span class="wordmark">Vault<em>Draw</em></span>
    </header>

    <main class="hero">
      <!-- 球 + 環繞的卡。整組一起當作一個視覺物件 -->
      <div class="orbit" aria-hidden="true">
        <div
          v-for="(c, i) in ORBIT" :key="i"
          class="fly"
          :style="{
            '--x': c.x + 'px', '--y': c.y + 'px', '--rot': c.rot + 'deg', '--s': c.s,
            '--delay': c.delay + 's', '--dur': c.dur + 's', zIndex: c.z
          }"
        >
          <div class="back">
            <span class="emblem"></span>
            <span class="sheen"></span>
          </div>
        </div>
        <div class="ball"><CapsuleArt tier="LAST" compact flat /></div>
      </div>

      <h1>每一支籤，<br class="br">開賣前就已封存。</h1>
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
      <span class="fine">點數僅可用於站內抽選與兌換商品，不可提領現金或轉讓。未滿 18 歲需監護人同意方可使用。</span>
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
}
.field { position: absolute; inset: 0; z-index: -1; pointer-events: none; }
.glow {
  position: absolute; left: 50%; top: 42%;
  width: 70vmax; height: 70vmax; translate: -50% -50%;
  background: radial-gradient(circle, #8b4fd0 0%, transparent 58%);
  filter: blur(80px); opacity: .22;
}

.brand { padding: 22px var(--pad) 0; }
.wordmark { font-size: 20px; font-weight: 700; letter-spacing: -.03em; }
.wordmark em { font-style: normal; color: var(--accent); }

.hero { display: grid; justify-items: center; align-content: center; gap: 16px; padding: 10px var(--pad) 26px; text-align: center; }

/* ---- 球 + 環繞卡 ----
   容器給固定的視覺高度，卡片用絕對定位散在四周。
   縮放靠 --k：一個變數就能整組等比縮小，不必逐一改位移。 */
.orbit {
  position: relative;
  --k: 1;
  width: calc(420px * var(--k));
  height: calc(340px * var(--k));
  display: grid; place-items: center;
}
.ball { position: relative; z-index: 4; width: calc(210px * var(--k)); }
@media (prefers-reduced-motion: no-preference) {
  .ball { animation: float 5.6s ease-in-out infinite alternate; }
}
@keyframes float { from { translate: 0 -8px; } to { translate: 0 10px; } }

.fly {
  position: absolute; top: 50%; left: 50%;
  width: calc(92px * var(--k) * var(--s));
  aspect-ratio: 5 / 7;
  translate: calc(var(--x) * var(--k) - 50%) calc(var(--y) * var(--k) - 50%);
  rotate: var(--rot);
  filter: drop-shadow(0 12px 26px rgba(0, 0, 0, .6));
}
/* 各自不同的週期與負延遲：看起來像各自漂浮，不是一個轉盤 */
@media (prefers-reduced-motion: no-preference) {
  .fly { animation: bobCard var(--dur) ease-in-out var(--delay) infinite alternate; }
}
@keyframes bobCard {
  from { translate: calc(var(--x) * var(--k) - 50%) calc(var(--y) * var(--k) - 50% - 10px); }
  to   { translate: calc(var(--x) * var(--k) - 50%) calc(var(--y) * var(--k) - 50% + 12px); }
}

/* 卡背：深色底 + 中央寶貝球徽記 + 一道斜向反光。
   全部用 CSS 畫，不載任何圖 —— 形象頁的首屏不該等圖。 */
.back {
  position: relative; width: 100%; height: 100%;
  border-radius: calc(9px * var(--k));
  overflow: hidden;
  background:
    radial-gradient(120% 90% at 50% 0%, #3a2f52, transparent 60%),
    linear-gradient(160deg, #241d35 0%, #171226 52%, #221a33 100%);
  border: 1px solid rgba(255, 255, 255, .12);
  box-shadow: inset 0 0 0 calc(3px * var(--k)) rgba(255, 255, 255, .045);
}
/* 徽記：上半實色、下半淡、中間一條分模線 —— 寶貝球的形狀語彙 */
.emblem {
  position: absolute; left: 50%; top: 50%;
  width: 46%; aspect-ratio: 1; translate: -50% -50%;
  border-radius: 50%;
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--accent) 70%, transparent) 0 46%,
      rgba(255, 255, 255, .16) 46% 54%,
      rgba(255, 255, 255, .07) 54% 100%);
  box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .14);
}
.emblem::after {
  content: ''; position: absolute; left: 50%; top: 50%;
  width: 30%; aspect-ratio: 1; translate: -50% -50%;
  border-radius: 50%;
  background: #efeaf5;
  box-shadow: 0 0 0 1.5px rgba(0, 0, 0, .5);
}
.sheen {
  position: absolute; inset: 0;
  background: linear-gradient(112deg, transparent 34%, rgba(255, 255, 255, .17) 50%, transparent 62%);
}

h1 { margin: 4px 0 0; font-size: clamp(26px, 4.6vw, 40px); line-height: 1.22; letter-spacing: -.02em; font-weight: 700; text-wrap: balance; }
.br { display: none; }
.tag { margin: -6px 0 0; font-size: 14px; letter-spacing: .04em; }

.acts { display: grid; grid-auto-flow: column; gap: 12px; align-items: center; margin-top: 8px; }
.btn.big { padding: 14px 32px; font-size: 16px; }
.peek { font-size: 14px; margin-left: 6px; text-decoration: underline; text-underline-offset: 3px; }
/* 展示版的誠實標註：假登入要講出來，不然是欺騙 */
.demo { margin: 2px 0 0; font-size: 11px; letter-spacing: .06em; color: var(--faint); }

.foot { padding: 16px var(--pad) 22px; text-align: center; font-size: 12.5px; }
.foot a { color: var(--muted); }
.fine { display: block; margin: 8px auto 0; font-size: 11px; color: var(--faint); max-width: 60ch; }

@media (max-width: 860px) { .orbit { --k: .84; } }
@media (max-width: 720px) {
  .orbit { --k: .68; }
  .br { display: inline; }
  .acts { grid-auto-flow: row; width: 100%; max-width: 320px; }
  .btn.big { width: 100%; }
  .peek { margin: 4px 0 0; }
}
@media (max-width: 380px) { .orbit { --k: .58; } }
</style>
