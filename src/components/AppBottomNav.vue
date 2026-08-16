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
  { name: 'cards', label: '卡冊', icon: 'book', match: ['cards'] },
  { name: 'me', label: '我的', icon: 'user', match: ['me', 'wallet', 'topup', 'seller-new'] }
] as const

const paths: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5',
  tag: 'M3 12.5V5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.4.6l6.5 6.5a2 2 0 0 1 0 2.8l-7.5 7.5a2 2 0 0 1-2.8 0L3.6 13.9a2 2 0 0 1-.6-1.4zM7.5 7.5h.01',
  book: 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM18 16H7a2 2 0 0 0-2 2',
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
      <svg class="ic" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path :d="paths[it.icon]" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="lb">{{ it.label }}</span>
    </RouterLink>

    <!-- 中央凸起：抽選 -->
    <RouterLink :to="{ name: 'play' }" class="item center" :class="{ on: playOn }" aria-label="抽選">
      <span class="orb">
        <!-- 寶貝球剪影：上半有色、下半留白、中央按鈕 -->
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 12a9 9 0 0 1 18 0" fill="currentColor" opacity=".95" />
          <path d="M3 12a9 9 0 0 0 18 0" fill="#fff" opacity=".92" />
          <path d="M3 12h18" stroke="#1a1216" stroke-width="2.2" />
          <circle cx="12" cy="12" r="3.1" fill="#fff" stroke="#1a1216" stroke-width="2" />
        </svg>
      </span>
      <span class="lb">抽選</span>
    </RouterLink>

    <!-- 右兩格 -->
    <RouterLink v-for="it in items.slice(2)" :key="it.name" :to="{ name: it.name }" class="item" :class="{ on: isOn(it.match) }">
      <svg class="ic" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path :d="paths[it.icon]" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
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
  border-top: 1px solid var(--line-soft);
  padding-bottom: var(--safe-b);
  padding-left: var(--safe-l);
  padding-right: var(--safe-r);
  /* 中央鍵要凸出頂邊，所以這裡不能 overflow:hidden */
}
.item {
  flex: 1 1 0;
  min-width: 0;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 9px 2px 8px;
  font-size: 11px; font-weight: 500;
  color: var(--muted);
  min-height: var(--nav-h);
  justify-content: center;
  transition: color .15s;
}
.ic { width: 21px; height: 21px; transition: transform .25s cubic-bezier(.34, 1.56, .64, 1); }
.item.on { color: var(--accent); }
.item.on .lb { font-weight: 600; }
/* 選中時圖示彈一下：有彈跳的回饋才有「按到了」的手感 */
.item.on .ic { transform: scale(1.1); }
.item:active .ic { transform: scale(.9); }
.item:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }

/* ---- 中央凸起鍵 ---- */
.center { position: relative; }
.center .orb {
  display: grid; place-items: center;
  width: 54px; height: 54px;
  margin-top: -22px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent);
  box-shadow: 0 8px 22px color-mix(in srgb, var(--accent) 45%, transparent),
              0 0 0 5px var(--bg);
  transition: transform .25s cubic-bezier(.34, 1.56, .64, 1), box-shadow .25s;
}
.center .orb svg { width: 30px; height: 30px; }
.center.on .orb {
  transform: translateY(-3px) scale(1.06);
  box-shadow: 0 12px 28px color-mix(in srgb, var(--accent) 60%, transparent),
              0 0 0 5px var(--bg);
}
.center:active .orb { transform: scale(.94); }
.center .lb { color: var(--muted); }
.center.on .lb { color: var(--accent); }
/* 待機呼吸：中央鍵是唯一會呼吸的東西 */
@media (prefers-reduced-motion: no-preference) {
  .center:not(.on) .orb { animation: orb-breathe 3s ease-in-out infinite; }
}
@keyframes orb-breathe {
  0%, 100% { box-shadow: 0 8px 22px color-mix(in srgb, var(--accent) 45%, transparent), 0 0 0 5px var(--bg); }
  50%      { box-shadow: 0 10px 30px color-mix(in srgb, var(--accent) 65%, transparent), 0 0 0 5px var(--bg); }
}

@media (max-width: 720px) {
  .bnav { display: flex; }
}
</style>
