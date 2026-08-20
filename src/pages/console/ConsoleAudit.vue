<script setup lang="ts">
/**
 * 稽核紀錄。每一筆後台的寫入動作都會落在這裡。
 *
 * 它存在的理由是事後追查：某個帳號多了五萬點、某個賣家忽然變成信任等級，
 * 要能查出是誰在什麼時候按的、當時寫了什麼理由。所以這頁唯讀，沒有刪除。
 */
import { computed, onMounted, ref } from 'vue'
import { http, useAsync, fmtTime, type AuditAction } from './shared'
import './console.css'

const { loading, err, run } = useAsync()
const rows = ref<AuditAction[]>([])
const q = ref('')

async function load() {
  const r = await run(() => http<{ actions: AuditAction[] }>('/v1/admin/actions'))
  if (r) rows.value = r.actions
}
onMounted(load)

const ACTION_LABEL: Record<string, string> = {
  grant: '調整點數', 'seller-tier': '賣家等級', 'dispute-resolve': '爭議裁決',
  'shipment-status': '出貨進度', 'verification-review': '文件審核'
}
const shown = computed(() => {
  const s = q.value.trim().toLowerCase()
  if (!s) return rows.value
  return rows.value.filter(r =>
    [r.action, r.target, r.note, r.admin_id].some(v => String(v ?? '').toLowerCase().includes(s))
  )
})
const payloadOf = (p: unknown) => {
  if (!p || typeof p !== 'object') return ''
  return Object.entries(p as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v}`).join(' · ')
}
</script>

<template>
  <div>
    <div class="c-head">
      <h2>稽核紀錄</h2>
      <span class="c-sub">唯讀。所有後台寫入動作都會留下</span>
      <div class="c-right"><button class="c-btn" type="button" :disabled="loading" @click="load">重新整理</button></div>
    </div>

    <input v-model="q" class="c-in" placeholder="用動作、對象或理由過濾…" style="margin-bottom:14px">

    <p v-if="err" class="c-ok" style="background:#7f1d1d55;color:#fca5a5">{{ err }}</p>
    <p v-if="loading && !rows.length" class="c-empty">載入中…</p>
    <p v-else-if="!shown.length" class="c-empty">沒有符合的紀錄。</p>

    <div v-else class="c-rows">
      <div v-for="a in shown" :key="a.id" class="c-row">
        <div class="line">
          <span class="c-pill go">{{ ACTION_LABEL[a.action] || a.action }}</span>
          <span class="c-t">{{ a.target || '—' }}</span>
          <span class="c-m grow">{{ fmtTime(a.created_at) }}</span>
        </div>
        <span v-if="payloadOf(a.payload)" class="c-m">{{ payloadOf(a.payload) }}</span>
        <span v-if="a.note" class="c-m">理由：{{ a.note }}</span>
        <span class="c-m tiny">操作者 {{ a.admin_id }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.grow { margin-left: auto; }
.tiny { font-size: 11.5px; opacity: .7; }
</style>
