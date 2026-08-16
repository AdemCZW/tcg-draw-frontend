<script setup lang="ts">
/**
 * 形象頁 —— 進站的第一眼。
 *
 * 刻意極簡：一顆球、一句話、登入／註冊、一條「先逛逛」。
 * 不放三步流程、不放池清單、不放跑馬燈 —— 那些是大廳（/lobby）的事。
 * 形象頁的工作只有兩件：讓人一眼知道「這是什麼」，然後把人送進去。
 *
 * 已登入的人進 / 會被 router 直接送到 /lobby，不會看到這頁。
 *
 * 球慢慢上下浮是這頁唯一的動態 —— 只有一個東西在動，它就是主角。
 * （不自轉：寶貝球轉起來赤道會歪，讀起來像在滾，不是懸浮的聖物）
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import CapsuleArt from '@/components/CapsuleArt.vue'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

type Mode = 'idle' | 'login' | 'register'
const mode = ref<Mode>('idle')
const email = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

const title = computed(() => (mode.value === 'register' ? '建立帳號' : '登入'))
const canSubmit = computed(() => email.value.includes('@') && password.value.length >= 6 && !busy.value)

function open(m: Exclude<Mode, 'idle'>) { mode.value = m; error.value = '' }
function close() { mode.value = 'idle'; error.value = '' }

async function submit() {
  if (!canSubmit.value) return
  busy.value = true; error.value = ''
  try {
    if (mode.value === 'register') await auth.register(email.value, password.value)
    else await auth.login(email.value, password.value)
    // 被守衛擋回來的人，登入後送回原本要去的頁；否則進大廳
    const back = typeof route.query.redirect === 'string' ? route.query.redirect : ''
    if (back && back.startsWith('/')) router.replace(back)
    else router.replace({ name: 'home' })
  } catch {
    error.value = '暫時無法完成，請稍後再試'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="land">
    <!-- 極淡的能量場，比大廳更收斂：形象頁要安靜 -->
    <div class="field" aria-hidden="true"><div class="glow"></div></div>

    <header class="brand">
      <span class="wordmark">Vault<em>Draw</em></span>
    </header>

    <main class="hero">
      <div class="ball" aria-hidden="true">
        <CapsuleArt tier="LAST" compact flat />
      </div>
      <h1>每一支籤，<br class="br">開賣前就已封存。</h1>
      <p class="tag muted">PSA 鑑定卡 · 定量抽選 · 完抽可驗算</p>

      <div v-if="mode === 'idle'" class="acts">
        <button type="button" class="btn primary big" @click="open('login')">登入</button>
        <button type="button" class="btn big" @click="open('register')">註冊</button>
        <RouterLink :to="{ name: 'home' }" class="peek muted">先逛逛 →</RouterLink>
      </div>

      <!-- 登入／註冊：就地展開，不跳頁。形象頁的節奏不該被一次跳轉打斷 -->
      <form v-else class="auth card" @submit.prevent="submit" :aria-label="title">
        <div class="authHead">
          <h2>{{ title }}</h2>
          <button type="button" class="x" aria-label="關閉" @click="close">×</button>
        </div>
        <label class="fld">
          <span>Email</span>
          <input v-model.trim="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required />
        </label>
        <label class="fld">
          <span>密碼</span>
          <input v-model="password" type="password" :autocomplete="mode === 'register' ? 'new-password' : 'current-password'" placeholder="至少 6 碼" minlength="6" required />
        </label>
        <p v-if="error" class="err" role="alert">{{ error }}</p>
        <button type="submit" class="btn primary big full" :disabled="!canSubmit">
          {{ busy ? '請稍候…' : title }}
        </button>
        <p class="swap muted">
          <template v-if="mode === 'login'">還沒有帳號？<button type="button" class="lnk" @click="open('register')">註冊</button></template>
          <template v-else>已經有帳號？<button type="button" class="lnk" @click="open('login')">登入</button></template>
        </p>
      </form>
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
  display: grid;
  grid-template-rows: auto 1fr auto;
  overflow: hidden;
  isolation: isolate;
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

.hero {
  display: grid; justify-items: center; align-content: center;
  gap: 18px;
  padding: 10px var(--pad) 30px;
  text-align: center;
}
.ball { width: min(58vw, 260px); }
/* 球慢慢上下浮：這頁唯一會動的東西 */
@media (prefers-reduced-motion: no-preference) {
  .ball { animation: float 5.6s ease-in-out infinite alternate; }
}
@keyframes float { from { translate: 0 -8px; } to { translate: 0 10px; } }
h1 {
  margin: 4px 0 0;
  font-size: clamp(26px, 4.6vw, 40px);
  line-height: 1.22; letter-spacing: -.02em; font-weight: 700;
  text-wrap: balance;
}
.br { display: none; }
.tag { margin: -6px 0 0; font-size: 14px; letter-spacing: .04em; }

.acts { display: grid; grid-auto-flow: column; gap: 12px; align-items: center; margin-top: 10px; }
.btn.big { padding: 14px 32px; font-size: 16px; }
.peek { font-size: 14px; margin-left: 6px; text-decoration: underline; text-underline-offset: 3px; }

/* ---- 就地登入 ---- */
.auth {
  width: 100%; max-width: 380px;
  padding: 20px 20px 16px;
  display: grid; gap: 12px;
  text-align: left;
}
.authHead { display: flex; align-items: center; justify-content: space-between; }
.authHead h2 { margin: 0; font-size: 18px; }
.x {
  width: 34px; height: 34px; border-radius: 50%; border: none;
  background: var(--surface-2); color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer;
}
.fld { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
.fld input {
  font: inherit; font-size: 15px; color: var(--ink);
  padding: 12px 14px;
  border-radius: 12px; border: 1px solid var(--line);
  background: var(--field);
}
.fld input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
.err { margin: 0; color: var(--danger); font-size: 13px; }
.full { width: 100%; }
.swap { margin: 0; font-size: 13px; text-align: center; }
.lnk { border: none; background: none; color: var(--accent); font: inherit; font-weight: 600; cursor: pointer; padding: 0 2px; }

.foot {
  padding: 16px var(--pad) 22px;
  text-align: center; font-size: 12.5px;
}
.foot a { color: var(--muted); }
.fine { display: block; margin: 8px auto 0; font-size: 11px; color: var(--faint); max-width: 60ch; }

@media (max-width: 720px) {
  .br { display: inline; }
  .acts { grid-auto-flow: row; width: 100%; max-width: 320px; }
  .btn.big { width: 100%; }
  .peek { margin: 4px 0 0; }
}
</style>
