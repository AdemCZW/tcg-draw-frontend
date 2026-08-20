<script setup lang="ts">
/**
 * 賣家審核。兩塊：等待中的證件文件、以及所有賣家的等級。
 *
 * 等級是有意義的權限：depositFor() 用完成單數決定保證金比例，
 * 而 tier 決定他能不能開池。所以調等級這件事一定要留稽核紀錄。
 */
import { onMounted, ref, inject } from 'vue'
import { http, useAsync, fmtTime, TIER_LABEL, type Seller, type Verification } from './shared'
import './console.css'

const { loading, err, okMsg, run, flash } = useAsync()
const refreshBadges = inject<() => Promise<void>>('console:refresh', async () => {})

const sellers = ref<Seller[]>([])
const verifications = ref<Verification[]>([])
const busy = ref<string | null>(null)
const reviewNote = ref<Record<string, string>>({})

async function load() {
  const [a, b] = await Promise.all([
    run(() => http<{ sellers: Seller[] }>('/v1/admin/sellers')),
    run(() => http<{ verifications: Verification[] }>('/v1/admin/verifications'))
  ])
  if (a) sellers.value = a.sellers
  if (b) verifications.value = b.verifications
}
onMounted(load)

async function review(v: Verification, status: 'approved' | 'rejected') {
  busy.value = v.id
  const r = await run(() => http<{ ok: true }>(`/v1/admin/verifications/${v.id}/review`, {
    method: 'POST', json: { status, note: (reviewNote.value[v.id] ?? '').trim() }
  }))
  busy.value = null
  if (!r) return
  flash(`已${status === 'approved' ? '通過' : '退回'} ${v.seller_name} 的文件`)
  await load(); await refreshBadges()
}

async function setTier(s: Seller, tier: string) {
  busy.value = s.id
  const r = await run(() => http<{ ok: true }>(`/v1/admin/sellers/${s.id}/tier`, {
    method: 'POST', json: { tier, note: `後台調整為 ${TIER_LABEL[tier] ?? tier}` }
  }))
  busy.value = null
  if (!r) return
  flash(`${s.name} 已設為「${TIER_LABEL[tier] ?? tier}」`)
  await load(); await refreshBadges()
}

const pending = verifications
const TIERS = ['pending', 'verified', 'trusted']
</script>

<template>
  <div>
    <div class="c-head">
      <h2>賣家審核</h2>
      <span class="c-sub">等級決定能不能開池，調整會進稽核紀錄</span>
      <div class="c-right"><button class="c-btn" type="button" :disabled="loading" @click="load">重新整理</button></div>
    </div>

    <p v-if="okMsg" class="c-ok">{{ okMsg }}</p>
    <p v-if="err" class="c-err">{{ err }}</p>

    <h3>證件文件</h3>
    <p v-if="!pending.length" class="c-empty">沒有待審核的文件。</p>
    <div v-else class="c-rows">
      <div v-for="v in pending" :key="v.id" class="c-row">
        <div class="line">
          <span class="c-t">{{ v.seller_name }}</span>
          <span class="c-pill">{{ v.seller_handle }}</span>
          <span class="c-pill" :class="v.status === 'pending' ? 'wait' : v.status === 'approved' ? 'done' : 'bad'">
            {{ v.status === 'pending' ? '待審核' : v.status === 'approved' ? '已通過' : '已退回' }}
          </span>
          <span class="c-m">{{ fmtTime(v.created_at) }}</span>
        </div>
        <span class="c-m">文件 {{ v.doc_file_id }}</span>
        <div v-if="v.status === 'pending'" class="c-actions">
          <input v-model="reviewNote[v.id]" class="c-in note" placeholder="審核備註（選填）">
          <button class="c-btn pri" type="button" :disabled="busy === v.id" @click="review(v, 'approved')">通過</button>
          <button class="c-btn danger" type="button" :disabled="busy === v.id" @click="review(v, 'rejected')">退回</button>
        </div>
        <span v-else-if="v.note" class="c-m">備註：{{ v.note }}</span>
      </div>
    </div>

    <h3>所有賣家</h3>
    <p v-if="loading && !sellers.length" class="c-empty">載入中…</p>
    <p v-else-if="!sellers.length" class="c-empty">還沒有賣家。</p>
    <div v-else class="c-rows">
      <div v-for="s in sellers" :key="s.id" class="c-row">
        <div class="line">
          <span class="c-t">{{ s.name }}</span>
          <span class="c-pill">{{ s.handle }}</span>
          <span class="c-pill" :class="s.tier === 'trusted' ? 'done' : s.tier === 'pending' ? 'wait' : 'go'">
            {{ TIER_LABEL[s.tier] || s.tier }}
          </span>
          <span v-if="s.faults" class="c-pill bad">{{ s.faults }} 次違規</span>
        </div>
        <div class="c-actions">
          <button
            v-for="t in TIERS" :key="t" type="button" class="c-btn"
            :disabled="busy === s.id || s.tier === t" @click="setTier(s, t)"
          >{{ TIER_LABEL[t] }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
h3 { font-size: 13px; color: var(--muted); margin: 20px 0 10px; font-weight: 600; }
.line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.note { flex: 1; min-width: 160px; }
</style>
