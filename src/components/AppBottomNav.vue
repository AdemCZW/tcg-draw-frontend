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
 *
 * ---- 動畫：整條列只有一個動作 ----
 * 選中指示器是一顆共用的膠囊，切分頁時橫向滑到新的那一格；經過中央的
 * 抽選鍵時縮進球裡（球本身就是實色的，底下不需要再墊一顆膠囊）。
 * 只在換頁那一刻播，停在同一頁時完全靜止 —— 底部導覽是每一頁都在的
 * 常駐元件，一個第一次覺得可愛、第五十次覺得煩的效果是失敗的，所以
 * 這裡不放任何持續播放的裝飾（也是當初拿掉 orb-breathe 的同一個理由）。
 * 只動 transform / opacity，reduce 之下整組關掉。
 *
 * ---- 中央鍵凸出來的那 28px 是有代價的 ----
 * 它是 fixed 的一部分，蓋在頁面內容上。抬升量與頁面讓位共用
 * tokens.css 的 --nav-bump，不可以只改一邊 —— 只改抬升量的話，
 * 每一頁最下面那顆按鈕的正中央就會打到球（實測過：訓練家卡成品頁的
 * 「儲存到相簿」，而那一頁離開就永久失去圖片）。
 */
import { computed, ref, watch } from 'vue'
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
const playOn = computed(() => ['play', 'pool', 'pool-pick'].includes(current.value))

/* ---- 選中指示器（會滑動的那顆膠囊） ----------------------------------
 * 原本每一格各有一顆 .icbox 底色，選中的那格「亮起來」、上一格「暗掉」。
 * 那是兩個獨立的狀態變化，畫面上不會告訴你「你從哪裡去了哪裡」。
 * 改成整條列共用一顆膠囊、切分頁時橫向滑過去 —— 動的東西本身就是答案。
 *
 * slot 是 0–4 的格號（中央鍵佔第 2 格），指示器用 translateX(格號 × 100%)
 * 定位：不量 DOM、不寫死像素，格寬永遠是「內容寬 ÷ 5」。
 */
const slot = computed(() => {
  if (playOn.value) return 2
  const i = items.findIndex(it => isOn(it.match))
  return i < 0 ? -1 : (i < 2 ? i : i + 1)   // 後兩格要跳過中央鍵
})

/* 有些頁不屬於任何一格（條款、客服、訓練家卡…）。那時指示器要收起來，
   但**位置留在最後去過的那一格**：跳回第 0 格等於在說「你現在在大廳」，
   那是錯的訊息，而且會出現一段沒有意義的長距離滑行。 */
const at = ref(slot.value < 0 ? 2 : slot.value)
watch(slot, v => { if (v >= 0) at.value = v })

/* 中央鍵沒有膠囊底（它自己就是一顆實色的球），所以指示器經過第 2 格時
   要縮成 0 —— 看起來是「膠囊縮進球裡」、離開抽選時再從球裡長出來。
   這比讓膠囊在球底下憑空消失誠實：它去哪裡了，畫面有交代。 */
const shown = computed(() => slot.value >= 0 && slot.value !== 2)
</script>

<template>
  <nav class="bnav" aria-label="主導覽">
    <!-- 選中指示器。純裝飾：aria-hidden + pointer-events: none，
         不能讓它出現在無障礙樹裡，更不能讓它接走底下那一格的點擊。 -->
    <span class="pill" :class="{ off: !shown }" :style="{ '--i': at }" aria-hidden="true">
      <span class="pill-in" />
    </span>

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
  /* 一格裡由上而下是：圖示膠囊、間距、標籤。三個高度寫成權杖而不是
     靠 justify-content: center 自己算出來，是因為**指示器與中央球的
     垂直位置都得從同一組數字推**：置中是「算完才知道」的結果，
     外面的元素抄不到，只能各自寫魔術數字，然後在改字級那天一起錯位。 */
  --ic-h: 28px;
  --lb-h: 13px;
  --row-gap: 3px;
  /* 一格內容在 56px 裡的上緣位置。指示器的 top 與球的凸出量都由它推得。 */
  --pad-t: calc((var(--nav-h) - var(--ic-h) - var(--row-gap) - var(--lb-h)) / 2);
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
  /* justify-content: center → flex-start + 明確的 padding-top。
     結果完全一樣（--pad-t 就是置中會算出來的那個值），差別是這個值
     現在有名字，指示器與中央球可以讀它，不必各自猜。 */
  display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
  box-sizing: border-box; padding-top: var(--pad-t);
  gap: var(--row-gap);
  font-size: 11px; font-weight: 500; line-height: var(--lb-h);
  letter-spacing: .02em;
  color: var(--muted);
  transition: color .15s;
  /* iOS 上點擊會閃一塊灰底，跟自訂的選中樣式打架 */
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
/* 圖示外面包一顆膠囊大小的框。底色不再畫在這裡 —— 改由整條列共用的
   .pill 滑過來填（見下方）。只靠字色變紅在 21px 的線條圖示上太弱，
   尤其戶外亮度下；有個色塊才一眼看得出人在哪一頁。 */
.icbox {
  display: grid; place-items: center;
  width: 44px; height: var(--ic-h);
  border-radius: var(--pill);
}
.ic { width: 22px; height: 22px; transition: transform .25s cubic-bezier(.34, 1.56, .64, 1); }
.item.on { color: var(--accent); }

/* ---- 選中指示器：整條列只有一顆，切分頁時滑過去 ----------------------
 * 為什麼是「滑動」而不是「淡入淡出」：底部導覽是每一頁都在的東西，
 * 會一直重複的動畫必須說得出它在講什麼。滑行講的是「你剛才在那一格，
 * 現在到這一格」—— 使用者按了什麼、去了哪裡，這是唯一有資訊量的回饋。
 * 停在同一頁時它一格都不會動：這裡沒有任何持續播放的裝飾。
 *
 * 定位：一格 = 內容寬 ÷ 5，位移 = 格號 × 100%（100% 是自己的寬 = 一格）。
 * 用 100% 而不是量 DOM，換頁時不必等版面、轉螢幕方向也自動對。
 * 寬度扣掉 --safe-l/r：絕對定位的包含塊是 padding box（含安全區內距），
 * 而格子是排在 content box 裡的，不扣就會整排偏掉。
 *
 * 只動 transform 與 opacity，不動 width/left —— 那兩個會觸發版面配置，
 * 而這條列每次換頁都要跑一次，掉幀比沒動畫糟。
 */
.pill {
  position: absolute;
  top: var(--pad-t);
  left: var(--safe-l);
  width: calc((100% - var(--safe-l) - var(--safe-r)) / 5);
  height: var(--ic-h);
  display: grid; place-items: center;
  /* 絕對不能接走底下那一格的點擊。這是「動畫不可以製造新的按錯」那條
     底線在這裡的具體形式：指示器蓋在圖示上，有 pointer-events 的話
     hit-test 就會回傳它而不是連結。 */
  pointer-events: none;
  transform: translateX(calc(var(--i) * 100%));
  transition: transform .34s cubic-bezier(.32, .72, 0, 1);
}
.pill-in {
  width: 44px; height: 100%;
  border-radius: var(--pill);
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  /* 收合用 scale 而不是 width：同上，width 會觸發版面配置 */
  transition: transform .28s cubic-bezier(.34, 1.4, .64, 1), opacity .2s ease;
}
/* 縮進球裡（走到中央鍵）／收起來（走到不屬於任何一格的頁）。
   縮到 .18 而不是 0：0 的話最後幾毫秒是一個沒有尺寸的東西在動，
   看起來像閃掉；留一點體積才讀得出「它被吸進去了」。 */
.pill.off .pill-in { transform: scale(.18); opacity: 0; }
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
  /* 對齊：把球的「佔位高度」壓成跟旁邊圖示膠囊一樣的 --ic-h，
     四個標籤才會落在同一條基線上；抬起來的那一段就凸出導覽列上緣。

     抬升量讀 --nav-bump（tokens.css），**不是**寫死的 28px ——
     頁面的讓位（.navClear 的 --nav-total）也是加同一支權杖。
     兩邊綁在同一個數字上，才不會再出現「球凸出來、讓位沒算到」的狀態：
     那個狀態下每一頁最下面那顆按鈕的正中央都會打到球，跳去 /play。 */
  margin-top: calc(-1 * var(--nav-bump));
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

/* ---- prefers-reduced-motion: reduce ---------------------------------
 * 前庭系統敏感的人會因為晃動的介面不舒服，那不是喜好問題，所以這裡是
 * 全關而不是「放慢」。**關掉之後畫面照樣成立**：指示器是用 transform
 * 在兩個合法狀態之間過場，拿掉過場就是直接站在正確的那一格 ——
 * 跟形象頁那一輪立下的原則同一件事（用遮蔽物揭露、不用淡入，
 * 所以拿掉遮蔽物就是最終畫面），沒有任何資訊只存在於動畫過程裡。
 * 驗證：scripts/bottom-nav/occlusion.mjs 在 reduce 下確認
 * document.getAnimations() 沒有任何一支在跑，而且選中格已經到位。 */
@media (prefers-reduced-motion: reduce) {
  .bnav, .bnav * { transition: none !important; animation: none !important; }
}

@media (max-width: 720px) {
  .bnav { display: flex; }
}
</style>
