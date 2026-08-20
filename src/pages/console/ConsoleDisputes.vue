<script setup lang="ts">
/**
 * 爭議裁決。
 *
 * 裁決是不可逆的資金動作（點數會實際移動給其中一方），所以這裡刻意做兩段確認：
 * 先選要判給誰、寫理由，才會出現送出鍵。舊後台是直接一顆按鈕就結案，
 * 在手機上很容易誤觸 —— 而這種誤觸沒有還原鍵。
 */
import { inject, onMounted, ref } from 'vue'
import { http, useAsync, fmtTime, fmtPts, type Dispute } from './shared'
import './console.css'

const { loading, err, okMsg, run, flash } = useAsync()
const refreshBadges = inject<() => Promise<void>>('console:refresh', async () => {})

const rows = ref<Dispute[]>([])
const picked = ref<Record<string, 'buyer' | 'seller' | ''>>({})
const reason = ref<Record<string, string>>({})
const busy = ref<string | null>(null)

async function load() {
  const r = await run(() => http<{ disputes: Dispute[] }>('/v1/admin/disputes'))
  if (r) rows.value = r.disputes
}
onMounted(load)

async function resolve(d: Dispute) {
  const to = picked.value[d.id]
  const why = (reason.value[d.id] ?? '').trim()
  if (!to || why.length < 4) return
  busy.value = d.id
  const r = await run(() => http<{ ok: true }>(`/v1/admin/disputes/${d.id}/resolve`, {
    method: 'POST', json: { to, note: why }
  }))
  busy.value = null
  if (!r) return
  flash(`已裁決給${to === 'buyer' ? '買家' : '賣家'}`)
  picked.value[d.id] = ''; reason.value[d.id] = ''
  await load(); await refreshBadges()
}
</script>

<template>
  <div>
    <div class="c-head">
      <h2>爭議</h2>
      <span class="c-sub">裁決會實際移動點數，不可還原</span>
      <div class="c-right"><button class="c-btn" type="button" :disabled="loading" @click="load">重新整理</button></div>
    </div>

    <p v-if="okMsg" class="c-ok">{{ okMsg }}</p>
    <p v-if="err" class="c-err">{{ err }}</p>
    <p v-if="loading && !rows.length" class="c-empty">載入中…</p>
    <p v-else-if="!rows.length" class="c-empty">目前沒有爭議中的訂單。</p>

    <div v-else class="c-rows">
      <div v-for="d in rows" :key="d.id" class="c-row">
        <div class="line">
          <span class="c-t">{{ d.card?.name || d.id }}</span>
          <span class="c-pill bad">爭議中</span>
          <span class="c-m grow">{{ fmtPts(d.price) }} 點 · {{ fmtTime(d.created_at) }}</span>
        </div>
        <span class="c-m">
          買家
          <RouterLink :to="{ name: 'console-user', params: { id: d.buyer_id } }">{{ d.buyer_id }}</RouterLink>
          ／ 賣家
          <RouterLink :to="{ name: 'console-user', params: { id: d.seller_id } }">{{ d.seller_id }}</RouterLink>
        </span>

        <div class="c-actions">
          <button
            class="c-btn" :class="{ pri: picked[d.id] === 'buyer' }"
            type="button" @click="picked[d.id] = picked[d.id] === 'buyer' ? '' : 'buyer'"
          >判給買家（退款）</button>
          <button
            class="c-btn" :class="{ pri: picked[d.id] === 'seller' }"
            type="button" @click="picked[d.id] = picked[d.id] === 'seller' ? '' : 'seller'"
          >判給賣家（放款）</button>
        </div>

        <!-- 第二段：選了才出現。理由是必填，因為當事人一定會問為什麼 -->
        <div v-if="picked[d.id]" class="confirm">
          <input v-model="reason[d.id]" class="c-in" placeholder="裁決理由（必填，至少 4 字）">
          <button
            class="c-btn danger" type="button"
            :disabled="busy === d.id || (reason[d.id] ?? '').trim().length < 4"
            @click="resolve(d)"
          >{{ busy === d.id ? '處理中…' : '確認裁決' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.grow { margin-left: auto; }
a { color: var(--gold); }
.confirm {
  display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px;
  padding-top: 10px; border-top: 1px solid var(--line-soft);
}
.confirm .c-in { flex: 1; min-width: 180px; }
</style>
