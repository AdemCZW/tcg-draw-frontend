<script setup lang="ts">
/**
 * 會員基本資料。
 *
 * 分兩塊而不是一長串欄位：
 *   站上顯示 —— 別人看得到的
 *   出貨資料 —— 只有平台跟物流看得到
 * 這個界線要在畫面上講清楚，不然使用者填本名時會猶豫。
 *
 * 全部欄位都不強制。要出貨時才需要補齊，那時再擋比較合理——
 * 註冊當下就要人填地址是流失使用者最快的方法。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { MOCK } from '@/lib/config'
import { http, ApiError } from '@/lib/http'
import { useAuthStore } from '@/stores/auth'

interface Profile {
  handle: string; name: string
  displayName: string | null; realName: string | null; phone: string | null
  addressZip: string | null; addressCity: string | null; addressLine1: string | null
  birthday: string | null
}

const router = useRouter()
const auth = useAuthStore()

const form = ref({
  displayName: '', realName: '', phone: '',
  addressZip: '', addressCity: '', addressLine1: '', birthday: ''
})
const handle = ref('')
const loading = ref(true)
const busy = ref(false)
const err = ref('')
const okMsg = ref('')

/** 出貨需要的欄位是否齊全 —— 讓使用者知道還差什麼，而不是等到出貨才被擋 */
const shipReady = computed(() =>
  !!form.value.realName.trim() && !!form.value.phone.trim() &&
  !!form.value.addressCity.trim() && !!form.value.addressLine1.trim()
)

async function load() {
  if (MOCK) { loading.value = false; return }
  try {
    const r = await http<{ profile: Profile }>('/v1/auth/profile')
    const p = r.profile
    handle.value = p.handle
    form.value = {
      displayName: p.displayName ?? p.name ?? '',
      realName: p.realName ?? '', phone: p.phone ?? '',
      addressZip: p.addressZip ?? '', addressCity: p.addressCity ?? '',
      addressLine1: p.addressLine1 ?? '', birthday: p.birthday ?? ''
    }
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : '載入失敗'
  } finally {
    loading.value = false
  }
}

async function save() {
  busy.value = true
  err.value = ''
  okMsg.value = ''
  try {
    await http('/v1/auth/profile', { method: 'PUT', json: form.value })
    okMsg.value = '已儲存'
    // 暱稱會影響全站顯示，重新抓一次讓標頭那些地方立刻跟上
    await auth.refresh()
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : '儲存失敗'
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="container page prof">
    <header class="head">
      <h1>會員資料</h1>
      <p class="sub muted">
        會員代號 <span class="mono">{{ handle || '—' }}</span> ——
        這是別人在市場與得獎紀錄看到的代號，不會變動
      </p>
    </header>

    <p v-if="MOCK" class="msg warn">展示模式沒有連後端，這頁的儲存不會生效。</p>
    <p v-if="err" class="msg err" role="alert">{{ err }}</p>
    <p v-if="okMsg" class="msg ok" role="status">{{ okMsg }}</p>
    <p v-if="loading" class="muted">載入中…</p>

    <form v-else @submit.prevent="save">
      <section class="card block">
        <h2>站上顯示</h2>
        <p class="note muted">其他使用者看得到的資訊。</p>
        <label>
          暱稱
          <input v-model="form.displayName" type="text" maxlength="20" placeholder="例如：小明" />
          <span class="hint">留空的話會沿用目前的名稱。</span>
        </label>
      </section>

      <section class="card block">
        <div class="blockHead">
          <h2>出貨資料</h2>
          <span class="pill" :class="shipReady ? 'ok' : 'todo'">
            {{ shipReady ? '已完整' : '尚未填完' }}
          </span>
        </div>
        <p class="note muted">
          只有平台與物流看得到，不會出現在市場或任何公開頁面。
          申請卡片出貨時會自動帶入，不用每次重打。
        </p>

        <label>
          收件人姓名
          <input v-model="form.realName" type="text" maxlength="40" autocomplete="name" placeholder="須與證件相符" />
        </label>
        <label>
          手機
          <input v-model="form.phone" type="tel" maxlength="20" autocomplete="tel" placeholder="09xxxxxxxx" />
        </label>
        <div class="row2">
          <label>
            郵遞區號
            <input v-model="form.addressZip" type="text" maxlength="10" autocomplete="postal-code" inputmode="numeric" placeholder="選填" />
          </label>
          <label class="grow">
            縣市
            <input v-model="form.addressCity" type="text" maxlength="40" autocomplete="address-level1" placeholder="例如：台北市" />
          </label>
        </div>
        <label>
          地址
          <input v-model="form.addressLine1" type="text" maxlength="120" autocomplete="street-address" placeholder="路名、門牌、樓層" />
        </label>
      </section>

      <section class="card block">
        <h2>其他</h2>
        <label>
          生日
          <input v-model="form.birthday" type="date" />
          <span class="hint">未滿 18 歲需監護人同意才能使用本站。</span>
        </label>
      </section>

      <div class="acts">
        <button type="button" class="btn" @click="router.back()">返回</button>
        <button type="submit" class="btn primary" :disabled="busy">
          {{ busy ? '儲存中…' : '儲存' }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.prof { padding-bottom: calc(48px + var(--safe-b)); max-width: 560px; }
.head { margin-bottom: 16px; }
h1 { font-size: 22px; margin: 0 0 6px; }
.sub { font-size: 13px; line-height: 1.7; margin: 0; }
h2 { font-size: 15px; margin: 0 0 4px; }
.note { font-size: 12.5px; line-height: 1.7; margin: 0 0 14px; }
.hint { font-size: 11.5px; color: var(--faint); line-height: 1.6; }

.msg { font-size: 13.5px; margin: 0 0 12px; }
.msg.err { color: var(--danger); }
.msg.ok { color: var(--ok); }
.msg.warn { color: var(--warn); }

.block { padding: 18px; margin-bottom: 12px; display: grid; gap: 12px; }
.blockHead { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.blockHead h2 { margin: 0; }
.pill { font-size: 11.5px; font-weight: 700; padding: 3px 10px; border-radius: var(--pill); white-space: nowrap; }
.pill.ok { background: var(--ok-wash); color: var(--ok); }
.pill.todo { background: var(--warn-wash); color: var(--warn); }

label { display: grid; gap: 5px; font-size: 12.5px; color: var(--muted); }
input {
  width: 100%; min-height: 46px; padding: 10px 14px; font-size: 15px;
  background: var(--field); border: 1px solid var(--line);
  border-radius: var(--radius); color: var(--ink);
}
input:focus-visible { outline: 2px solid var(--holo-a); outline-offset: 1px; }
.row2 { display: grid; grid-template-columns: 110px 1fr; gap: 10px; }
.row2 .grow { min-width: 0; }

.acts { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.acts .btn { padding: 12px 24px; }
</style>
