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
import { useWalletStore } from '@/stores/wallet'

const router = useRouter()
const auth = useAuthStore()
const wallet = useWalletStore()
onMounted(() => wallet.loadLedger())

function logout() {
  auth.logout()
  router.replace({ name: 'landing' })
}

const rows = [
  { name: 'cards', t: '我的卡冊', d: '抽到的卡、出貨與回收', icon: 'book' },
  { name: 'wallet', t: '錢包', d: '點數餘額與明細', icon: 'wallet' },
  { name: 'topup', t: '儲值', d: '購買點數', icon: 'plus' },
  { name: 'seller-new', t: '賣家專區 · 我要開池', d: '上架自己的抽選池', icon: 'box' },
  { name: 'fairness', t: '公平性驗證', d: '籤序怎麼封存、怎麼自己驗算', icon: 'shield' }
] as const

const paths: Record<string, string> = {
  book: 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM18 16H7a2 2 0 0 0-2 2',
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
        <strong class="mono">{{ wallet.points.toLocaleString() }}</strong>
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
      </li>
    </ul>

    <button type="button" class="btn ghost logout" @click="logout">登出</button>

    <p class="fine muted">
      點數僅可用於站內抽選與兌換商品，不可提領現金或轉讓。未滿 18 歲需監護人同意方可使用。
      <a href="#">會員條款</a> · <a href="#">隱私權政策</a>
    </p>
  </div>
</template>

<style scoped>
.page { padding-top: 28px; padding-bottom: calc(40px + var(--nav-total)); max-width: 640px; }

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

.logout { margin-top: 18px; width: 100%; }
.fine { font-size: 11.5px; line-height: 1.6; margin: 18px 0 0; }
.fine a { color: var(--muted); text-decoration: underline; }

@media (max-width: 720px) {
  .page { padding-top: 16px; }
  .hero { padding: 16px; }
}
</style>
