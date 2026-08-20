<script setup lang="ts">
/**
 * 手機底部導覽 —— 4 + 1 中央凸起鍵。桌機隱藏（桌機用 AppHeader 的橫向 nav）。
 *
 * 中央那顆是「抽選」：整個產品唯一的主動作，所以它是畫面上唯一凸出來、
 * 唯一有實色的按鈕。原本 5 個等寬 tab 沒有重心，什麼都一樣重＝什麼都不重。
 * 「開池」拿掉 —— 那是賣家功能，一般玩家不會用，收進「我的」。
 *
 * active 判定用 route name 前綴，不用 path.startsWith：
 * /me 與 /me/cards 用 path 會同時亮兩格。
 *
 * 圖示用線條 SVG 而非 emoji：emoji 在各平台字面差異大、也偏卡通。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

/* 左二 + 中央 + 右二。
   「全部池」已併進大廳（同一個問題的兩半），空出來的格子給市場 ——
   抽選是碰運氣，市場是直接買賣，兩個不同的意圖各佔一格。 */
const items = [
  { name: 'home', label: '大廳', icon: 'home', match: ['home'] },
  { name: 'market', label: '市場', icon: 'tag', match: ['market'] },
  { name: 'cards', label: '卡冊', icon: 'cards', match: ['cards'] },
  { name: 'me', label: '我的', icon: 'user', match: ['me', 'wallet', 'topup', 'seller-new'] }
] as const

/* 卡冊原本用「書本」圖示，在 21px 下只剩一個長方形加一條線，跟旁邊的
   標籤圖示一樣是圓角方塊、辨識不出來。改成兩張疊在一起的卡 ——
   這個產品裡「卡冊」就是一疊卡，直譯比隱喻好認。 */
const paths: Record<string, string> = {
  home: 'M3 10.6 12 3.2l9 7.4M5.6 9.6v9.2a1.6 1.6 0 0 0 1.6 1.6h9.6a1.6 1.6 0 0 0 1.6-1.6V9.6',
  tag: 'M3 12.5V5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.4.6l6.5 6.5a2 2 0 0 1 0 2.8l-7.5 7.5a2 2 0 0 1-2.8 0L3.6 13.9a2 2 0 0 1-.6-1.4zM7.5 7.5h.01',
  cards: 'M11.2 3.6h6A2.3 2.3 0 0 1 19.5 5.9v10.2a2.3 2.3 0 0 1-2.3 2.3h-6a2.3 2.3 0 0 1-2.3-2.3V5.9a2.3 2.3 0 0 1 2.3-2.3ZM5.6 7.5v9.8a3 3 0 0 0 3 3h6.1',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0'
}

const current = computed(() => String(route.name ?? ''))
const isOn = (match: readonly string[]) => match.includes(current.value)
/** 中央鍵：抽選相關的頁面都算 */
const playOn = computed(() => ['play', 'pool', 'pool-pick', 'streak'].includes(current.value))
</script>

<template>
  <nav class="bnav" aria-label="主導覽">
    <!-- 左兩格 -->
    <RouterLink v-for="it in items.slice(0, 2)" :key="it.name" :to="{ name: it.name }" class="item" :class="{ on: isOn(it.match) }">
      <span class="icbox">
        <svg class="ic" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path :d="paths[it.icon]" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      <span class="lb">{{ it.label }}</span>
    </RouterLink>

    <!-- 中央凸起：抽選。整顆圓就是寶貝球本身，不再是「紅底 + 小球」 -->
    <RouterLink :to="{ name: 'play' }" class="item center" :class="{ on: playOn }">
      <span class="orb">
        <svg class="pb" viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <!-- 上下半與色帶都畫成滿版矩形再用圓形裁切：比用弧線路徑好維護，
                 改色帶粗細只要動一個 y/height，不必重算弧線端點。 -->
            <clipPath id="vdBallClip"><circle cx="50" cy="50" r="48" /></clipPath>
            <!-- 球體光影：左上受光、右下收暗。少了這層，放大後的球會變成
                 一個上紅下白的平面色塊，看不出是顆球。 -->
            <radialGradient id="vdBallShade" cx="34%" cy="27%" r="82%">
              <stop offset="0%" stop-color="#fff" stop-opacity=".40" />
              <stop offset="40%" stop-color="#fff" stop-opacity="0" />
              <stop offset="100%" stop-color="#000" stop-opacity=".32" />
            </radialGradient>
          </defs>
          <g clip-path="url(#vdBallClip)">
            <rect class="pb-bot" x="0" y="50" width="100" height="50" />
            <rect class="pb-top" x="0" y="0" width="100" height="50" />
            <rect class="pb-band" x="0" y="43.5" width="100" height="13" />
          </g>
          <circle class="pb-btn" cx="50" cy="50" r="14.5" />
          <circle class="pb-shade" cx="50" cy="50" r="48" fill="url(#vdBallShade)" />
        </svg>
      </span>
      <span class="lb">抽選</span>
    </RouterLink>

    <!-- 右兩格 -->
    <RouterLink v-for="it in items.slice(2)" :key="it.name" :to="{ name: it.name }" class="item" :class="{ on: isOn(it.match) }">
      <span class="icbox">
        <svg class="ic" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path :d="paths[it.icon]" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      <span class="lb">{{ it.label }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.bnav {
  display: none;
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 60;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: saturate(180%) blur(16px);
  -webkit-backdrop-filter: saturate(180%) blur(16px);
  border-top: 1px solid var(--line-soft);
  /* 實高必須剛好等於 --nav-h：頁面下緣是靠 --nav-total 留白的，
     之前這條列子項目撐到 71.6px，等於每一頁最底下 15px 內容都被蓋住。 */
  height: var(--nav-h);
  box-sizing: content-box;
  padding-bottom: var(--safe-b);
  padding-left: var(--safe-l);
  padding-right: var(--safe-r);
  /* 中央鍵要凸出頂邊，所以這裡不能 overflow:hidden */
}
.item {
  flex: 1 1 0;
  min-width: 0;
  height: var(--nav-h);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px;
  font-size: 11px; font-weight: 500; line-height: 1.2;
  letter-spacing: .02em;
  color: var(--muted);
  transition: color .15s;
  /* iOS 上點擊會閃一塊灰底，跟自訂的選中樣式打架 */
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
/* 圖示外面包一顆膠囊：選中時填淡色底。只靠字色變紅在 21px 的線條圖示上
   太弱，尤其戶外亮度下；有個色塊才一眼看得出人在哪一頁。 */
.icbox {
  display: grid; place-items: center;
  width: 44px; height: 28px;
  border-radius: var(--pill);
  background: transparent;
  transition: background .18s;
}
.ic { width: 22px; height: 22px; transition: transform .25s cubic-bezier(.34, 1.56, .64, 1); }
.item.on { color: var(--accent); }
.item.on .icbox { background: color-mix(in srgb, var(--accent) 15%, transparent); }
/* 選中時線條加粗：CSS 會蓋過 SVG 的 stroke-width 屬性，
   不必為了粗細再多一組路徑。 */
.item.on .ic path { stroke-width: 2; }
.item.on .lb { font-weight: 600; }
.item:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }

@media (prefers-reduced-motion: no-preference) {
  /* 選中時圖示彈一下：有彈跳的回饋才有「按到了」的手感 */
  .item.on .ic { transform: scale(1.08); }
  .item:active .ic { transform: scale(.88); }
}

/* ---- 中央凸起鍵：整顆圓 = 寶貝球 ---- */
.center { position: relative; }
.center .orb {
  display: block;
  width: 56px; height: 56px;
  /* 對齊：把球的「佔位高度」壓成跟旁邊圖示膠囊一樣的 28px，
     四個標籤才會落在同一條基線上；剩下的 28px 就是凸出量。 */
  margin-top: -28px;
  border-radius: 50%;
  /* 不要任何「環」。原本有一圈 4px 的底色環把球從導覽列裡切出來，
     但深色主題的 --bg 幾乎是黑的，那圈看起來就是一道黑框套在球外面 ——
     使用者要的是一整顆球，不是球加框。
     浮起來的感覺改用兩層陰影：一層貼身的暗影負責把白色下半球從
     淺色背景上分出來（淺色主題下唯一的邊界），一層紅光給重量。 */
  box-shadow: 0 1px 3px rgba(0, 0, 0, .38),
              0 8px 20px color-mix(in srgb, var(--accent) 38%, transparent);
  transition: transform .25s cubic-bezier(.34, 1.56, .64, 1), box-shadow .25s;
}
.center .pb { display: block; width: 100%; height: 100%; }

/* 寶貝球是實體物件，紅白黑是它的固有色，不該跟著主題翻轉 ——
   淺色主題下把下半球染成米白、把黑帶染淺，就不是寶貝球了。
   只有紅色接上 --accent，因為品牌橘紅本來就跟球身同一個色相。 */
.pb-top { fill: var(--accent); }
.pb-bot { fill: #fff; }
.pb-band { fill: #17120f; }
.pb-btn { fill: #fff; stroke: #17120f; stroke-width: 6; }
.pb-shade { pointer-events: none; }

.center.on .orb {
  transform: translateY(-2px) scale(1.05);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .38),
              0 12px 26px color-mix(in srgb, var(--accent) 55%, transparent);
}
@media (prefers-reduced-motion: no-preference) {
  .center:active .orb { transform: scale(.93); }
}
/* 中央是唯一的主動作，標籤不跟其他四格一起變灰 */
.center .lb { color: var(--text); font-weight: 600; }
.center.on .lb { color: var(--accent); }
/* 原本這裡有一個 orb-breathe 無限呼吸動畫。拿掉：球放大之後本身就是全畫面
   最重的物件，不需要再閃；而底部導覽是每一頁都在的常駐元件，
   常駐元件上的無限迴圈動畫是干擾（也一直在觸發合成層重繪）。 */

@media (max-width: 720px) {
  .bnav { display: flex; }
}
</style>
