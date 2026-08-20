<script setup lang="ts">
/**
 * 出貨管理。
 *
 * 這頁之前完全不存在：使用者按得下「申請寄送」，資料寫得進 shipments，
 * 但沒有任何端點能把它讀出來 —— 申請進去就沒有人看得到。這是整個後台
 * 最該先補的一塊，因為它是唯一一個「使用者已經在等，而平台不知道」的流程。
 *
 * 動作是單向推進的（待處理 → 已包裝 → 已寄出 → 已送達），不提供退回：
 * 出貨狀態會影響卡片能不能上架，可以來回改的話對帳就沒有依據了。
 * 真的按錯要走稽核紀錄查、由資料庫處理，這比給一個「還原」按鈕安全。
 */
import { computed, inject, onMounted, ref } from 'vue'
import { http, useAsync, fmtTime, fmtAddr, SHIP_LABEL, SHIP_NEXT, type Shipment } from './shared'
import './console.css'

const { loading, err, okMsg, run, flash } = useAsync()
const refreshBadges = inject<() => Promise<void>>('console:refresh', async () => {})

const rows = ref<Shipment[]>([])
const filter = ref<'all' | Shipment['status']>('requested')
const FILTERS: { k: 'all' | Shipment['status']; label: string }[] = [
  { k: 'requested', label: '待處理' },
  { k: 'packed', label: '已包裝' },
  { k: 'shipped', label: '已寄出' },
  { k: 'delivered', label: '已送達' },
  { k: 'all', label: '全部' }
]

async function load() {
  const path = filter.value === 'all' ? '/v1/admin/shipments' : `/v1/admin/shipments?status=${filter.value}`
  const r = await run(() => http<{ shipments: Shipment[] }>(path))
  if (r) rows.value = r.shipments
}
onMounted(load)
function setFilter(k: typeof filter.value) { filter.value = k; load() }

/* 展開的那一筆。收合狀態下只顯示「誰、幾張、多久以前」，
   要出貨才需要看到完整地址 —— 個資不該整頁攤開給旁邊的人看到 */
const open = ref<string | null>(null)
const toggle = (id: string) => { open.value = open.value === id ? null : id }

const tracking = ref<Record<string, string>>({})
const busy = ref<string | null>(null)

async function advance(s: Shipment) {
  const next = SHIP_NEXT[s.status]
  if (!next) return
  const tr = (tracking.value[s.id] ?? '').trim()
  if (next === 'shipped' && !tr) { err.value = '標記為已寄出前要先填物流單號'; return }

  busy.value = s.id
  const r = await run(() => http<{ ok: true }>(`/v1/admin/shipments/${s.id}/status`, {
    method: 'POST',
    json: { status: next, tracking: tr || undefined, note: `後台推進至 ${SHIP_LABEL[next]}` }
  }))
  busy.value = null
  if (!r) return
  flash(`${s.userHandle} 的出貨單已標記為「${SHIP_LABEL[next]}」`)
  await load()
  await refreshBadges()
}

const pillClass = (s: string) =>
  s === 'requested' ? 'wait' : s === 'delivered' ? 'done' : 'go'

const waiting = computed(() => rows.value.filter(r => r.status === 'requested').length)
/* 超過三天沒處理的要看得出來 —— 出貨延遲是客訴的主要來源，
   而它在列表上跟其他筆長得一樣就不會有人注意到 */
const STALE = 3 * 24 * 60 * 60 * 1000
const isStale = (s: Shipment) => s.status === 'requested' && Date.now() - s.createdAt > STALE
</script>

<template>
  <div>
    <div class="c-head">
      <h2>出貨</h2>
      <span class="c-sub">實體卡寄送。單向推進，不提供退回。</span>
      <div class="c-right">
        <button class="c-btn" type="button" :disabled="loading" @click="load()">重新整理</button>
      </div>
    </div>

    <div class="tabs">
      <button
        v-for="f in FILTERS" :key="f.k" type="button"
        class="tab" :class="{ on: filter === f.k }" @click="setFilter(f.k)"
      >
        {{ f.label }}
        <b v-if="f.k === 'requested' && waiting">{{ waiting }}</b>
      </button>
    </div>

    <p v-if="okMsg" class="c-ok">{{ okMsg }}</p>
    <p v-if="err" class="c-err">{{ err }}</p>

    <p v-if="loading && !rows.length" class="c-empty">載入中…</p>
    <p v-else-if="!rows.length" class="c-empty">這個狀態下沒有出貨單。</p>

    <div v-else class="c-rows">
      <div v-for="s in rows" :key="s.id" class="c-row">
        <div class="line" @click="toggle(s.id)">
          <span class="c-t">{{ s.userName || s.userHandle }}</span>
          <span class="c-pill" :class="pillClass(s.status)">{{ SHIP_LABEL[s.status] }}</span>
          <span v-if="isStale(s)" class="c-pill bad">已等 3 天以上</span>
          <span class="c-m grow">{{ s.prizes.length }} 張 · {{ fmtTime(s.createdAt) }}</span>
          <span class="caret" :class="{ up: open === s.id }">▾</span>
        </div>

        <div v-if="open === s.id" class="detail">
          <dl class="c-dl">
            <dt>收件人</dt><dd>{{ s.address.name || '（未填）' }}</dd>
            <dt>電話</dt><dd>{{ s.address.phone || '（未填）' }}</dd>
            <dt>地址</dt><dd>{{ fmtAddr(s.address) }}</dd>
            <dt>帳號</dt><dd>{{ s.userHandle }}</dd>
            <dt v-if="s.tracking">單號</dt><dd v-if="s.tracking">{{ s.tracking }}</dd>
            <dt v-if="s.shippedAt">寄出</dt><dd v-if="s.shippedAt">{{ fmtTime(s.shippedAt) }}</dd>
          </dl>

          <ul class="prizes">
            <li v-for="p in s.prizes" :key="p.id">
              <span class="c-pill">{{ p.tier }}</span>{{ p.name || p.id }}
            </li>
          </ul>

          <div v-if="SHIP_NEXT[s.status]" class="act">
            <input
              v-if="SHIP_NEXT[s.status] === 'shipped'"
              v-model="tracking[s.id]" class="c-in" placeholder="物流單號（必填）"
            >
            <button
              class="c-btn pri" type="button" :disabled="busy === s.id"
              @click="advance(s)"
            >
              {{ busy === s.id ? '處理中…' : `標記為「${SHIP_LABEL[SHIP_NEXT[s.status]!]}」` }}
            </button>
          </div>
          <p v-else class="c-m">已完成，沒有後續動作。</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tabs { display: flex; gap: 6px; overflow-x: auto; margin-bottom: 14px; padding-bottom: 2px; }
.tab {
  flex: none; padding: 7px 13px; font: inherit; font-size: 13px;
  border: 1px solid var(--line); border-radius: 999px;
  background: var(--surface); color: var(--muted); cursor: pointer;
}
.tab.on { background: var(--surface-3); color: var(--ink); border-color: var(--line); font-weight: 700; }
.tab b { margin-left: 5px; color: var(--gold); }

.line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; cursor: pointer; }
.grow { margin-left: auto; }
.caret { color: var(--muted); font-size: 11px; transition: transform .15s; }
.caret.up { transform: rotate(180deg); }

.detail { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line-soft); }
.prizes { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.prizes li { display: flex; align-items: center; gap: 7px; font-size: 13px; }

.act { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
.act .c-in { flex: 1; min-width: 180px; }
</style>
