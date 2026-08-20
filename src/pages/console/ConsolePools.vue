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

const { loading, err, run } = useAsync()
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
const pct = (p: Pool) => p.total_tickets ? Math.round(p.sold / p.total_tickets * 100) : 0
</script>

<template>
  <div>
    <div class="c-head">
      <h2>池</h2>
      <span class="c-sub">賣家開出的池。目前唯讀。</span>
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
      </div>
    </div>
  </div>
</template>

<style scoped>
.line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chk { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); cursor: pointer; }
.bar { height: 4px; border-radius: 999px; background: var(--surface-3); overflow: hidden; margin-top: 7px; }
.bar i { display: block; height: 100%; background: var(--gold); }
</style>
