<script setup lang="ts">
/**
 * 個人中心 —— 底部導覽「我的」的落點。
 *
 * 之前錢包、儲值、開池、公平性說明各自散在導覽的不同角落，
 * 手機底部塞了五格還是放不下。這頁把「跟我有關的一切」收成一張清單，
 * 底部導覽就能只留四格 + 中央抽選鍵。
 */
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LoginMethods from '@/components/LoginMethods.vue'
import { useWalletStore } from '@/stores/wallet'
import RollingNumber from '@/components/RollingNumber.vue'
import { hapticsEnabled, hapticsSupported, setHaptics } from '@/lib/haptics'
import { ref } from 'vue'

const router = useRouter()

/* 觸覺開關只在裝置支援時出現：iOS Safari 沒有 vibrate，顯示一個沒作用的開關是欺騙 */
const hapticsOn = ref(hapticsEnabled())
function toggleHaptics() { hapticsOn.value = !hapticsOn.value; setHaptics(hapticsOn.value) }
const auth = useAuthStore()
const wallet = useWalletStore()
onMounted(() => wallet.loadLedger())

function logout() {
  auth.logout()
  router.replace({ name: 'landing' })
}

/* 「我的卡冊」不放這裡 —— 底部選單已經有一顆卡冊，
   同一個功能出現在兩個地方只會讓人猶豫哪個才對。

   六項排成三欄兩列的格狀選單。副標題全部拿掉：一整行一項時副標題還讀得完，
   擠進三分之一寬的格子只會變成兩三行灰字，反而看不到真正要點的標題。
   標題也一併縮短（「賣家專區 · 我要開池」→「我要開池」），
   窄格子裡塞得下才有得看；語意由圖示與落地頁再補完。
   排序照使用頻率由高到低，最常回來看的錢包擺在左上第一格。 */
const rows = [
  { name: 'wallet', t: '錢包', icon: 'wallet' },
  { name: 'topup', t: '儲值', icon: 'plus' },
  { name: 'offers', t: '交易邀約', icon: 'swap' },
  { name: 'profile', t: '會員資料', icon: 'user' },
  { name: 'seller-new', t: '我要開池', icon: 'box' },
  /* 出貨緊接著開池：那是同一個賣家身分的下一步，而且是**有時限的**那一步。
     藏在別的地方等於讓賣家在逾期之後才發現有東西該寄，
     而逾期的代價是退款給買家加一次違約。 */
  { name: 'seller-shipping', t: '出貨與結算', icon: 'truck' },
  { name: 'fairness', t: '公平性驗證', icon: 'shield' }
]

/* 後台入口。原本只放在 AppHeader 的導覽列裡，但那一列在 720px 以下是
   display:none（手機改用底部 tab bar），所以手機上根本看不到。
   「我的」是手機上真的找得到後台的地方。 */
const adminRow = { name: 'admin', t: '平台後台', icon: 'shield' } as const

const paths: Record<string, string> = {
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
  swap: 'M4 8h13l-3-3M20 16H7l3 3',
  wallet: 'M4 8a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v1M4 8v9a2 2 0 0 0 2 2h12a1 1 0 0 0 1-1v-3M4 8h14M20 11v4h-4a2 2 0 0 1 0-4z',
  plus: 'M12 5v14M5 12h14',
  box: 'M4 8l8-4 8 4-8 4-8-4zM4 8v8l8 4 8-4V8M12 12v8',
  truck: 'M3 7h10v9H3zM13 10h4l3 3v3h-7zM7.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM17.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  shield: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z'
}
</script>

<template>
  <div class="container page">
    <!-- 一列講完：誰、有多少點、去哪儲值。
         原本餘額自己包一個有底色的盒子另起一行，那個盒子沒有承載任何額外資訊，
         只是把頁首撐高一倍 —— 「點數餘額」四個字也是，數字後面跟著「點」跟儲值箭頭
         已經說明它是什麼了。 -->
    <header class="hero card">
      <div class="avatar" aria-hidden="true">{{ (auth.user?.name ?? 'VD').slice(0, 2) }}</div>
      <div class="who">
        <h1 class="mono">{{ auth.user?.name ?? '尚未登入' }}</h1>
        <p class="eyebrow">會員</p>
      </div>
      <RouterLink :to="{ name: 'topup' }" class="balance">
        <span class="amt">
          <strong class="mono"><RollingNumber :value="wallet.shown" /></strong><span class="unit">點</span>
        </span>
        <span class="go">儲值 →</span>
      </RouterLink>
    </header>

    <ul class="menu">
      <li v-for="r in rows" :key="r.name">
        <RouterLink :to="{ name: r.name }" class="cell">
          <span class="ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path :d="paths[r.icon]" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <strong>{{ r.t }}</strong>
        </RouterLink>
      </li>
      <!-- 後台自己佔一格，不再跟著 v-for 跑 —— 之前寫在迴圈裡，管理員會看到六顆一樣的後台入口 -->
      <li v-if="auth.isAdmin">
        <RouterLink :to="{ name: adminRow.name }" class="cell admin">
          <span class="ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path :d="paths[adminRow.icon]" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <strong>{{ adminRow.t }}</strong>
        </RouterLink>
      </li>
    </ul>

    <div v-if="hapticsSupported" class="pref card">
      <div class="txt">
        <strong>觸覺回饋</strong>
        <span class="muted">選籤、開球、開出大獎時輕震</span>
      </div>
      <button
        type="button" class="switch" :class="{ on: hapticsOn }"
        role="switch" :aria-checked="hapticsOn" aria-label="觸覺回饋"
        @click="toggleHaptics"
      ><span class="knob"></span></button>
    </div>

    <LoginMethods />

    <button type="button" class="btn ghost logout" @click="logout">登出</button>

    <p class="fine muted">
      點數僅可用於站內抽選與兌換商品，不可提領現金或轉讓。未滿 18 歲需監護人同意方可使用。
      <a href="#">會員條款</a> · <a href="#">隱私權政策</a>
    </p>
  </div>
</template>

<style scoped>
/* 下緣不再自己讓開底部導覽：頁尾接在這一頁下面，讓位由它做（見 App.vue）。
   兩邊都留一次的話，手機上每頁最底下就會多出一整條導覽高度的空白。 */
.page { padding-top: 28px; padding-bottom: 40px; max-width: 640px; }

.hero {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 12px; align-items: center;
  padding: 14px 16px;
}
.avatar {
  width: 44px; height: 44px; border-radius: 50%;
  display: grid; place-items: center;
  font-family: var(--font-mono); font-size: 15px; font-weight: 600; letter-spacing: .04em;
  background: linear-gradient(135deg, var(--accent), var(--accent-soft));
  color: #fff;
}
.who { min-width: 0; }
/* 名字可能很長，撞到餘額之前先截斷 —— 餘額是右邊那欄，不該被推出去 */
h1 {
  margin: 0; font-size: 17px; letter-spacing: .02em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.who .eyebrow { margin: 1px 0 0; }
/* 整塊是連往儲值的連結，觸控區靠 min-height 撐足，不另外畫背景 */
.balance {
  display: grid; justify-items: end; gap: 1px;
  min-height: 44px; align-content: center;
  padding: 0 2px; border-radius: var(--radius);
}
.balance:active { transform: scale(.99); }
.amt { display: inline-flex; align-items: baseline; gap: 3px; }
.balance strong { font-size: 20px; letter-spacing: -.01em; }
.balance .unit { font-size: 12px; color: var(--muted); }
.balance .go { font-size: 12px; color: var(--accent); }

/* minmax(0, 1fr) 而不是 1fr：grid 子元素預設 min-width:auto，
   標題一長就把欄位撐爆整個視窗，手機上直接橫向捲。 */
.menu {
  list-style: none; padding: 0; margin: 16px 0 0;
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;
}
.cell {
  /* 整格可點，所以不再畫箭頭：一格就是一顆按鈕，多一個 › 只是噪音 */
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  min-height: 96px; padding: 14px 8px;
  text-align: center;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  transition: background .15s, transform .12s;
}
@media (hover: hover) { .cell:hover { background: var(--surface-2); } }
.cell:active { transform: scale(.985); }
.cell:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ic {
  width: 38px; height: 38px; flex: none;
  display: grid; place-items: center;
  border-radius: 12px;
  background: var(--accent-wash); color: var(--accent);
}
.ic svg { width: 20px; height: 20px; }
.cell strong {
  font-size: 13.5px; font-weight: 600; line-height: 1.35;
  /* 窄格子寧可讓標題折行、格子長高，也不要壓字或截斷 */
  max-width: 100%; overflow-wrap: anywhere;
}

.pref .txt { display: grid; gap: 2px; min-width: 0; }
.pref .txt strong { font-size: 15px; font-weight: 600; }
.pref .txt span { font-size: 12.5px; }
.pref { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 16px; margin-top: 8px; }
.switch {
  position: relative; width: 46px; height: 28px; flex: none;
  /* 視覺上是 46x28 的細開關，但觸控目標要 44 高 —— 用偽元素把可點範圍撐開，
     不動視覺尺寸。直接加 height 會把開關畫成一顆胖膠囊。 */
  border-radius: var(--pill); border: none; cursor: pointer;
  background: var(--surface-3);
  transition: background .2s;
}
.switch .knob {
  position: absolute; top: 3px; left: 3px;
  width: 22px; height: 22px; border-radius: 50%;
  background: #fff;
  transition: transform .2s cubic-bezier(.34, 1.4, .64, 1);
}
.switch::after {
  content: ''; position: absolute; left: 0; right: 0;
  top: 50%; height: 44px; translate: 0 -50%;
}
.switch.on { background: var(--accent); }
.switch.on .knob { transform: translateX(18px); }
.switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.logout { margin-top: 18px; width: 100%; }
.fine { font-size: 11.5px; line-height: 1.6; margin: 18px 0 0; }
.fine a { color: var(--muted); text-decoration: underline; }

@media (max-width: 720px) {
  .page { padding-top: 16px; }
  .hero { padding: 16px; }
}

/* 後台列跟一般功能區隔開：它是平台營運用的，不是使用者功能 */
.cell.admin { box-shadow: inset 0 -3px 0 var(--gold); }
.cell.admin strong { color: var(--gold); }
</style>
