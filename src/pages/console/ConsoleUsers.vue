<script setup lang="ts">
/**
 * 會員搜尋。只負責「找到人」，找到之後的所有事情都在詳情頁做。
 *
 * 舊後台把搜尋、錢包、發點數擠在同一頁，於是發完點數想確認餘額
 * 要關掉浮層再點一次；分開之後詳情頁有自己的網址，客服可以把連結
 * 貼給另一個人接手。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { http, useAsync, fmtTime, type AdminUser } from './shared'
import './console.css'

const router = useRouter()
const { loading, err, run } = useAsync()

const users = ref<AdminUser[]>([])
const q = ref('')

async function load() {
  const s = q.value.trim()
  const r = await run(() => http<{ users: AdminUser[] }>(
    s ? `/v1/admin/users?q=${encodeURIComponent(s)}` : '/v1/admin/users'
  ))
  if (r) users.value = r.users
}
onMounted(load)

const open = (u: AdminUser) => router.push({ name: 'console-user', params: { id: u.id } })
</script>

<template>
  <div>
    <div class="c-head">
      <h2>會員</h2>
      <span class="c-sub">會員編號可以只打後幾碼，VD- 前綴可省略</span>
    </div>

    <form class="search" @submit.prevent="load">
      <input v-model="q" class="c-in" placeholder="會員編號、暱稱或 Email">
      <button class="c-btn pri" type="submit" :disabled="loading">搜尋</button>
    </form>

    <p v-if="err" class="c-ok" style="background:#7f1d1d55;color:#fca5a5">{{ err }}</p>
    <p v-if="loading && !users.length" class="c-empty">載入中…</p>
    <p v-else-if="!users.length" class="c-empty">找不到符合的會員。</p>

    <div v-else class="c-rows">
      <div v-for="u in users" :key="u.id" class="c-row c-click" @click="open(u)">
        <div class="line">
          <span class="c-t">{{ u.name || '（未命名）' }}</span>
          <span class="c-pill mono">{{ u.member_no || u.handle }}</span>
          <span v-if="u.role === 'admin'" class="c-pill go">管理員</span>
          <span class="c-m grow">{{ fmtTime(u.created_at) }} 加入</span>
        </div>
        <span class="c-m">{{ u.email || '未綁定 Email' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search { display: flex; gap: 8px; margin-bottom: 14px; }
.search .c-in { flex: 1; }
.line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.grow { margin-left: auto; }
</style>
