<script setup lang="ts">
/**
 * 這個帳號有哪些登入方式，以及怎麼補上另一種。
 *
 * 重點是讓使用者清楚：補綁不會換帳號。用 LINE 註冊的人補了 Email 之後，
 * 兩種方式登入的是同一個帳號、同一批卡、同一筆點數。
 * 這件事不講明白，沒有人敢按。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { MOCK, API_URL } from '@/lib/config'
import { http, token, ApiError } from '@/lib/http'

interface Methods { email: string | null; hasPassword: boolean; providers: string[] }
const methods = ref<Methods | null>(null)
const loading = ref(false)
const err = ref('')
const okMsg = ref('')

const showForm = ref(false)
const email = ref('')
const password = ref('')
const currentPassword = ref('')
const busy = ref(false)

const hasLine = computed(() => methods.value?.providers.includes('line') ?? false)
const canSubmit = computed(() =>
  /.+@.+\..+/.test(email.value) && password.value.length >= 8 &&
  (!methods.value?.hasPassword || currentPassword.value.length > 0)
)

const route = useRoute()

async function load() {
  if (MOCK) return
  loading.value = true
  try { methods.value = await http<Methods>('/v1/auth/methods') }
  catch (e) { err.value = e instanceof ApiError ? e.message : '載入失敗' }
  finally { loading.value = false }
}

async function save() {
  if (!canSubmit.value) return
  busy.value = true
  err.value = ''
  try {
    await http('/v1/auth/set-password', { method: 'POST', json: {
      email: email.value.trim(), password: password.value,
      ...(methods.value?.hasPassword ? { currentPassword: currentPassword.value } : {})
    } })
    okMsg.value = '已加上 Email 登入。之後兩種方式都會進到這個帳號。'
    showForm.value = false
    password.value = ''
    currentPassword.value = ''
    await load()
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : '設定失敗'
  } finally {
    busy.value = false
  }
}

/* 綁 LINE：把目前的 token 當一次性憑證帶過去，後端驗過才知道要綁到誰身上。
   走整頁導向而不是彈窗——LINE 的授權頁不允許被嵌在 iframe 裡。 */
function linkLine() {
  const t = token.get()
  if (!t) return
  window.location.href = `${API_URL}/v1/auth/line/start?link=${encodeURIComponent(t)}`
}

onMounted(() => {
  load()
  const r = typeof route.query.line === 'string' ? route.query.line : ''
  if (r === 'linked') okMsg.value = '已綁定 LINE。之後用 LINE 登入會進到這個帳號。'
  else if (r === 'taken') err.value = '這個 LINE 帳號已經綁在別的帳號上了'
  else if (r === 'badtoken') err.value = '登入狀態已過期，請重新登入再試一次'
})
</script>

<template>
  <section v-if="!MOCK" class="lm">
    <h2>登入方式</h2>
    <p class="hint">
      多綁一種方式不會換帳號 —— 你的卡、點數、訂單都還在同一個帳號底下，
      只是多一條進得來的路。
    </p>

    <p v-if="err" class="msg err" role="alert">{{ err }}</p>
    <p v-if="okMsg" class="msg ok" role="status">{{ okMsg }}</p>
    <p v-if="loading" class="muted small">載入中…</p>

    <ul v-if="methods" class="list">
      <li class="item">
        <span class="ico line" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.6 2 11c0 3.9 3.5 7.2 8.2 7.9.3.1.8.2.9.5.1.3.1.7 0 1l-.1.9c0 .3-.2 1 .9.6s5.9-3.5 8.1-6c1.5-1.6 2-3.3 2-4.9C22 6.6 17.5 3 12 3z"/></svg>
        </span>
        <div class="txt">
          <strong>LINE</strong>
          <span class="muted small">{{ hasLine ? '已綁定' : '尚未綁定' }}</span>
        </div>
        <button v-if="!hasLine" type="button" class="btn sm" @click="linkLine">綁定</button>
        <span v-else class="ok small">✓</span>
      </li>

      <li class="item">
        <span class="ico mail" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M3 6h18v12H3z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m3 7 9 6 9-6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
        </span>
        <div class="txt">
          <strong>Email 與密碼</strong>
          <span class="muted small">{{ methods.email ?? '尚未設定' }}</span>
        </div>
        <button type="button" class="btn sm" @click="showForm = !showForm">
          {{ methods.hasPassword ? '變更' : '設定' }}
        </button>
      </li>
    </ul>

    <form v-if="showForm" class="form" @submit.prevent="save">
      <label>
        Email
        <input v-model="email" type="email" autocomplete="email" required placeholder="you@example.com" />
      </label>
      <label v-if="methods?.hasPassword">
        目前的密碼
        <input v-model="currentPassword" type="password" autocomplete="current-password" required />
      </label>
      <label>
        {{ methods?.hasPassword ? '新密碼' : '密碼' }}（至少 8 碼）
        <input v-model="password" type="password" autocomplete="new-password" required minlength="8" />
      </label>
      <div class="acts">
        <button type="button" class="btn sm" @click="showForm = false">取消</button>
        <button type="submit" class="btn primary sm" :disabled="!canSubmit || busy">
          {{ busy ? '儲存中…' : '儲存' }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.lm { margin-top: 28px; }
h2 { font-size: 16px; margin: 0 0 6px; }
.hint { font-size: 12.5px; line-height: 1.75; color: var(--muted); margin: 0 0 14px; max-width: 46ch; }
.small { font-size: 12.5px; }
.msg { font-size: 13px; margin: 0 0 10px; }
.msg.err { color: var(--danger); }
.msg.ok { color: var(--ok); }

.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.item {
  display: flex; align-items: center; gap: 12px;
  background: var(--surface); border-radius: var(--radius-lg); padding: 12px 14px;
}
.ico { flex: none; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; }
.ico svg { width: 19px; height: 19px; }
.ico.line { background: #06C755; color: #fff; }
.ico.line svg { fill: currentColor; }
.ico.mail { background: var(--surface-3); color: var(--muted); }
.txt { display: grid; gap: 1px; flex: 1; min-width: 0; }
.txt strong { font-size: 14px; }
.txt span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .ok { color: var(--ok); font-weight: 700; }

.form {
  display: grid; gap: 10px; margin-top: 12px;
  background: var(--surface); border-radius: var(--radius-lg); padding: 14px;
}
.form label { display: grid; gap: 4px; font-size: 12.5px; color: var(--muted); }
.form input {
  min-height: 44px; padding: 10px 14px; font-size: 15px;
  background: var(--field); border: 1px solid var(--line);
  border-radius: var(--radius); color: var(--ink);
}
.acts { display: flex; gap: 8px; justify-content: flex-end; }
</style>
