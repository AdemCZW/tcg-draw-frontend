<script setup lang="ts">
/**
 * 總覽。回答一個問題：現在有什麼需要我處理。
 *
 * 所以待辦（出貨、審核、爭議）排在前面而且會標色，
 * 「總會員數」這種看了也不會做什麼的數字排後面。
 */
import { computed, inject, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { fmtPts, type Overview } from './shared'
import './console.css'

const router = useRouter()
const overview = inject<Ref<Overview | null>>('console:overview')

const todo = computed(() => {
  const o = overview?.value
  if (!o) return []
  return [
    { k: '待出貨', v: o.ship_requested, to: 'console-shipments' },
    { k: '待審賣家', v: o.sellers_pending, to: 'console-sellers' },
    { k: '爭議中', v: o.orders_disputed, to: 'console-disputes' }
  ]
})
const rest = computed(() => {
  const o = overview?.value
  if (!o) return []
  return [
    { k: '總會員', v: fmtPts(o.users) },
    { k: '開放中的池', v: fmtPts(o.pools_open) },
    { k: '進行中訂單', v: fmtPts(o.orders_open) },
    { k: '運送中', v: fmtPts(o.ship_active) },
    { k: '託管中點數', v: fmtPts(o.escrowed_points) }
  ]
})
</script>

<template>
  <div>
    <div class="c-head">
      <h2>總覽</h2>
      <span class="c-sub">需要處理的事情排在最前面</span>
    </div>

    <p v-if="!overview" class="c-empty">載入中…</p>
    <template v-else>
      <div class="c-stats">
        <button
          v-for="t in todo" :key="t.k" type="button"
          class="c-stat" :class="{ alert: t.v > 0 }"
          @click="router.push({ name: t.to })"
        >
          <span class="c-k">{{ t.k }}</span>
          <span class="c-v">{{ t.v }}</span>
        </button>
      </div>

      <h3>其他</h3>
      <div class="c-stats">
        <div v-for="s in rest" :key="s.k" class="c-stat">
          <span class="c-k">{{ s.k }}</span><span class="c-v">{{ s.v }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
h3 { font-size: 13px; color: var(--muted); margin: 20px 0 10px; font-weight: 600; }
button.c-stat { text-align: left; cursor: pointer; font: inherit; color: inherit; }
button.c-stat:hover { background: var(--surface-2); }
</style>
