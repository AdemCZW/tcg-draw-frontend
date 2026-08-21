<script setup lang="ts">
/**
 * 池的清單審核。
 *
 * 平台要看得到賣家開了什麼：定價有沒有異常、獎品內容合不合理、賣家是不是
 * 還在待審核狀態就已經在賣。這頁目前是唯讀的 —— 下架動作牽涉已售出的籤要
 * 怎麼退，那要另外設計，不該用一個看起來很簡單的按鈕帶過。
 */
import { computed, onMounted, ref } from 'vue'
import { http, useAsync, fmtTime, fmtPts, POOL_LABEL, TIER_LABEL, type Pool } from './shared'
import './console.css'

const { loading, err, okMsg, run, flash } = useAsync()
const pools = ref<Pool[]>([])
const onlyRisk = ref(false)

async function load() {
  const r = await run(() => http<{ pools: Pool[] }>('/v1/admin/pools'))
  if (r) pools.value = r.pools
}
onMounted(load)

/* 值得多看一眼的：賣家還沒驗證、或單價偏高。
   門檻寫死在前端只是個篩子，不是規則 —— 真的要限制要在後端擋。 */
const HIGH_PRICE = 3000
const risky = (p: Pool) => p.seller_tier === 'pending' || p.ticket_price >= HIGH_PRICE
const shown = computed(() => onlyRisk.value ? pools.value.filter(risky) : pools.value)

/* 收攤是不可逆的（池不會再開回來），所以二段確認：先選，再出現確認鍵。
   跟爭議裁決同一套 —— 後台在手機上很容易誤觸，而這裡沒有還原鍵。 */
const closing = ref<string | null>(null)
const busy = ref<string | null>(null)

async function close(p: Pool) {
  busy.value = p.id
  const r = await run(() => http<{ ok: true }>(`/v1/pools/${p.id}/close`, { method: 'POST', json: {} }))
  busy.value = null
  if (!r) return
  flash(`「${p.title}」已收攤，稍後會自動揭曉並公開種子`)
  closing.value = null
  await load()
}
const pct = (p: Pool) => p.total_tickets ? Math.round(p.sold / p.total_tickets * 100) : 0
</script>

<template>
  <div>
    <div class="c-head">
      <h2>池</h2>
      <span class="c-sub">賣家開出的池。可以提前收攤讓它揭曉。</span>
      <div class="c-right">
        <label class="chk"><input v-model="onlyRisk" type="checkbox">只看要留意的</label>
        <button class="c-btn" type="button" :disabled="loading" @click="load">重新整理</button>
      </div>
    </div>

    <p v-if="err" class="c-err">{{ err }}</p>
    <p v-if="loading && !pools.length" class="c-empty">載入中…</p>
    <p v-else-if="!shown.length" class="c-empty">沒有符合的池。</p>

    <div v-else class="c-rows">
      <div v-for="p in shown" :key="p.id" class="c-row">
        <div class="line">
          <span class="c-t">{{ p.title }}</span>
          <span class="c-pill" :class="p.status === 'open' ? 'go' : p.status === 'revealed' ? 'done' : ''">
            {{ POOL_LABEL[p.status] || p.status }}
          </span>
          <span v-if="p.seller_tier === 'pending'" class="c-pill wait">賣家待審核</span>
          <span v-if="p.ticket_price >= 3000" class="c-pill wait">高單價</span>
        </div>
        <span class="c-m">
          {{ p.seller_name }}（{{ TIER_LABEL[p.seller_tier] || p.seller_tier }}） ·
          {{ fmtPts(p.ticket_price) }} 點／籤 ·
          {{ p.sold }}/{{ p.total_tickets }}（{{ pct(p) }}%） ·
          {{ fmtTime(p.created_at) }}
        </span>
        <div class="bar"><i :style="{ width: pct(p) + '%' }" /></div>

        <div v-if="p.status === 'open'" class="c-actions">
          <button
            class="c-btn" :class="{ danger: closing === p.id }"
            type="button" @click="closing = closing === p.id ? null : p.id"
          >{{ closing === p.id ? '取消' : '提前收攤' }}</button>
          <template v-if="closing === p.id">
            <span class="c-m warnNote">
              收攤後這個池不再開賣，剩下 {{ p.total_tickets - p.sold }} 支籤不會再發出。
              已經抽過的人不受影響，而且收攤之後才驗得到自己那一抽。這個動作不可還原。
            </span>
            <button
              class="c-btn danger" type="button" :disabled="busy === p.id"
              @click="close(p)"
            >{{ busy === p.id ? '處理中…' : '確認收攤' }}</button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.warnNote { flex-basis: 100%; line-height: 1.7; }

.line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chk { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); cursor: pointer; }
.bar { height: 4px; border-radius: 999px; background: var(--surface-3); overflow: hidden; margin-top: 7px; }
.bar i { display: block; height: 100%; background: var(--gold); }
</style>
