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
   同一個功能出現在兩個地方只會讓人猶豫哪個才對。 */
const rows = [
  { name: 'profile', t: '會員資料', d: '暱稱、收件人與地址', icon: 'user' },
  { name: 'wallet', t: '錢包', d: '點數餘額與明細', icon: 'wallet' },
  { name: 'offers', t: '交易邀約', d: '別人想換你的卡、你出價的紀錄', icon: 'swap' },
  { name: 'topup', t: '儲值', d: '購買點數', icon: 'plus' },
  { name: 'seller-new', t: '賣家專區 · 我要開池', d: '上架自己的抽選池', icon: 'box' },
  { name: 'fairness', t: '公平性驗證', d: '籤序怎麼封存、怎麼自己驗算', icon: 'shield' }
]

/* 後台入口。原本只放在 AppHeader 的導覽列裡，但那一列在 720px 以下是
   display:none（手機改用底部 tab bar），所以手機上根本看不到。
   「我的」是手機上真的找得到後台的地方。 */
const adminRow = { name: 'admin', t: '平台後台', d: '發點數、審賣家、裁決爭議', icon: 'shield' } as const

const paths: Record<string, string> = {
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
  swap: 'M4 8h13l-3-3M20 16H7l3 3',
  wallet: 'M4 8a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v1M4 8v9a2 2 0 0 0 2 2h12a1 1 0 0 0 1-1v-3M4 8h14M20 11v4h-4a2 2 0 0 1 0-4z',
  plus: 'M12 5v14M5 12h14',
  box: 'M4 8l8-4 8 4-8 4-8-4zM4 8v8l8 4 8-4V8M12 12v8',
  shield: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z'
}
</script>

<template>
  <div class="container page">
    <header class="hero card">
      <div class="avatar" aria-hidden="true">{{ (auth.user?.name ?? 'VD').slice(0, 2) }}</div>
      <div class="who">
        <p class="eyebrow">會員</p>
        <h1 class="mono">{{ auth.user?.name ?? '尚未登入' }}</h1>
      </div>
      <RouterLink :to="{ name: 'topup' }" class="balance">
        <span class="muted lbl">點數餘額</span>
        <strong class="mono"><RollingNumber :value="wallet.shown" /></strong>
        <span class="muted unit">點 · 儲值 →</span>
      </RouterLink>
    </header>

    <ul class="menu">
      <li v-for="r in rows" :key="r.name">
        <RouterLink :to="{ name: r.name }" class="row">
          <span class="ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path :d="paths[r.icon]" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <span class="txt">
            <strong>{{ r.t }}</strong>
            <span class="muted">{{ r.d }}</span>
          </span>
          <span class="chev" aria-hidden="true">›</span>
        </RouterLink>
        <RouterLink v-if="auth.isAdmin" :to="{ name: adminRow.name }" class="row admin">
          <span class="ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path :d="paths[adminRow.icon]" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <span class="txt">
            <strong>{{ adminRow.t }}</strong>
            <span class="muted">{{ adminRow.d }}</span>
          </span>
          <span class="chev" aria-hidden="true">›</span>
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
  display: grid; grid-template-columns: auto 1fr; grid-template-areas: "av who" "bal bal";
  gap: 14px 16px; align-items: center;
  padding: 18px 20px;
}
.avatar {
  grid-area: av;
  width: 52px; height: 52px; border-radius: 50%;
  display: grid; place-items: center;
  font-family: var(--font-mono); font-size: 15px; font-weight: 600; letter-spacing: .04em;
  background: linear-gradient(135deg, var(--accent), var(--accent-soft));
  color: #fff;
}
.who { grid-area: who; min-width: 0; }
.who .eyebrow { margin: 0 0 2px; }
h1 { margin: 0; font-size: 20px; letter-spacing: .02em; }
.balance {
  grid-area: bal;
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--surface-2);
  transition: background .15s;
}
@media (hover: hover) { .balance:hover { background: var(--surface-3); } }
.balance:active { transform: scale(.99); }
.balance .lbl { font-size: 12.5px; }
.balance strong { font-size: 24px; letter-spacing: -.01em; }
.balance .unit { font-size: 12.5px; margin-left: auto; color: var(--accent); }

.menu { list-style: none; padding: 0; margin: 16px 0 0; display: grid; gap: 8px; }
.row {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  transition: background .15s, transform .12s;
}
@media (hover: hover) { .row:hover { background: var(--surface-2); } }
.row:active { transform: scale(.985); }
.row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ic {
  width: 38px; height: 38px; flex: none;
  display: grid; place-items: center;
  border-radius: 12px;
  background: var(--accent-wash); color: var(--accent);
}
.ic svg { width: 20px; height: 20px; }
.txt { display: grid; gap: 2px; min-width: 0; }
.txt strong { font-size: 15px; font-weight: 600; }
.txt span { font-size: 12.5px; }
.chev { margin-left: auto; color: var(--faint); font-size: 22px; line-height: 1; }

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
.row.admin { box-shadow: inset 3px 0 0 var(--gold); }
.row.admin strong { color: var(--gold); }
</style>
