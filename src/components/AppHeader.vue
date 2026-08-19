<script setup lang="ts">
import { useWalletStore } from '@/stores/wallet'
import { useAuthStore } from '@/stores/auth'
import RollingNumber from '@/components/RollingNumber.vue'
const wallet = useWalletStore()
const auth = useAuthStore()
</script>

<template>
  <header class="hdr">
    <div class="container row">
      <RouterLink :to="{ name: 'home' }" class="brand display">Vault<span>Draw</span></RouterLink>
      <nav class="nav">
        <RouterLink :to="{ name: 'play' }">抽選台</RouterLink>
        <RouterLink :to="{ name: 'market' }">市場</RouterLink>
        <RouterLink :to="{ name: 'fairness' }">公平性驗證</RouterLink>
        <RouterLink :to="{ name: 'cards' }">我的卡冊</RouterLink>
        <RouterLink :to="{ name: 'seller-new' }" class="sell">＋ 我要開池</RouterLink>
        <!-- 只有管理員看得到。這是便利性入口，不是權限控制——擋在路由守衛與後端 -->
        <RouterLink v-if="auth.isAdmin" :to="{ name: 'admin' }" class="adminLink">後台</RouterLink>
      </nav>
      <div class="right">
        <RouterLink :to="{ name: 'topup' }" class="wallet mono" aria-label="點數餘額，前往儲值">
          <span class="dot" aria-hidden="true"></span><RollingNumber :value="wallet.points" /> 點
        </RouterLink>
        <RouterLink v-if="auth.isLoggedIn" :to="{ name: 'me' }" class="user">{{ auth.user?.name }}</RouterLink>
        <RouterLink v-else :to="{ name: 'landing' }" class="user">登入</RouterLink>
      </div>
    </div>
  </header>
</template>

<style scoped>
.hdr {
  position: sticky; top: 0; z-index: 50;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: saturate(180%) blur(14px);
  border-bottom: 1px solid var(--line-soft);
  /* 瀏海機的狀態列會吃掉這一條，之前完全沒讓位 */
  padding-top: var(--safe-t);
}
.row { display: flex; align-items: center; gap: 30px; height: 66px; }
.brand { font-size: 21px; font-weight: 600; letter-spacing: -0.03em; }
.brand span { color: var(--accent); }
.nav { display: flex; gap: 20px; font-size: 15px; color: var(--muted); font-weight: 500; }
.nav a { transition: color .15s; }
.nav a:hover { color: var(--ink); }
.nav a.router-link-active { color: var(--ink); font-weight: 600; }
.nav .sell {
  color: var(--accent); font-weight: 600;
  padding: 7px 16px;
  border-radius: var(--pill);
  background: var(--accent-wash);
  transition: background .15s;
}
/* 後台入口：管理員限定，用中性色不搶主導覽的注意力 */
.adminLink {
  font-size: 13px; padding: 6px 12px; border-radius: var(--pill);
  background: var(--surface-3); color: var(--muted);
}
@media (hover: hover) { .adminLink:hover { color: var(--ink); } }
.nav .sell:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.right { margin-left: auto; display: flex; align-items: center; gap: 14px; }
.wallet {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 14px; font-weight: 600; padding: 8px 16px;
  border-radius: var(--pill);
  background: var(--surface-2);
  color: var(--ink);
  transition: background .15s;
}
.wallet:hover { background: var(--surface-3); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.user { font-size: 14px; color: var(--muted); font-weight: 500; }
@media (max-width: 720px) {
  /* 手機導覽改用底部 tab bar（AppBottomNav） */
  .nav { display: none; }
  .row { height: 56px; gap: 12px; }
  .brand { font-size: 18px; }
  /* 餘額九位數在 375px 會折成兩行；不換行 + 收字距 */
  .wallet { font-size: 12.5px; padding: 6px 11px; white-space: nowrap; letter-spacing: -.01em; }
  .user { font-size: 13px; }
}
</style>
