<script setup lang="ts">
/**
 * 單一會員的完整檔案 —— 使用者的「調閱會員資料」。
 *
 * 一頁看完：身分、登入方式、寄送資料、餘額、卡、訂單、出貨、帳務明細。
 * 之所以要一次全帶出來，是因為客服處理的問題幾乎都是跨區的：
 *「我抽到的卡沒收到」同時牽涉 prizes、shipments 和 points_ledger，
 * 分三個分頁查等於每次都要在腦子裡拼起來。
 */
import { computed, inject, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  http, useAsync, fmtTime, fmtPts,
  SHIP_LABEL, ORDER_LABEL, type UserDetail
} from './shared'
import './console.css'

const route = useRoute()
const { loading, err, okMsg, run, flash } = useAsync()
const refreshBadges = inject<() => Promise<void>>('console:refresh', async () => {})

const d = ref<UserDetail | null>(null)
const id = computed(() => String(route.params.id ?? ''))

async function load() {
  const r = await run(() => http<UserDetail>(`/v1/admin/users/${id.value}`))
  if (r) d.value = r
}
onMounted(load)

/* ---- 發點數 ----
   金額和備註都是必填。備註不是形式：這條會進稽核紀錄，
   三個月後看到一筆 +50000 而沒有理由，是查不出來的。 */
const pts = ref(1000)
const note = ref('')
const granting = ref(false)
const canGrant = computed(() => pts.value !== 0 && note.value.trim().length >= 2 && !granting.value)

async function grant() {
  if (!canGrant.value || !d.value) return
  granting.value = true
  const r = await run(() => http<{ ok: true }>('/v1/admin/grant', {
    method: 'POST',
    json: { userId: id.value, points: pts.value, note: note.value.trim() }
  }))
  granting.value = false
  if (!r) return
  flash(`已${pts.value > 0 ? '發放' : '扣除'} ${fmtPts(Math.abs(pts.value))} 點`)
  note.value = ''
  await load()
  await refreshBadges()
}

const PROVIDER_LABEL: Record<string, string> = { line: 'LINE', google: 'Google', email: 'Email' }
/* 寄送資料有沒有填完，決定出貨時要不要先聯絡本人 */
const addrDone = computed(() => {
  const u = d.value?.user
  return !!(u?.real_name && u.phone && u.address_city && u.address_line1)
})
const orderSide = (o: UserDetail['orders'][number]) => o.buyer_id === id.value ? '買' : '賣'
</script>

<template>
  <div>
    <div class="c-head">
      <RouterLink class="c-btn" :to="{ name: 'console-users' }">← 會員</RouterLink>
      <h2 v-if="d">{{ d.user.name || d.user.handle }}</h2>
      <span v-if="d" class="c-sub">{{ d.user.handle }}</span>
    </div>

    <p v-if="okMsg" class="c-ok">{{ okMsg }}</p>
    <p v-if="err" class="c-ok" style="background:#7f1d1d55;color:#fca5a5">{{ err }}</p>
    <p v-if="loading && !d" class="c-empty">載入中…</p>

    <template v-if="d">
      <div class="c-stats">
        <div class="c-stat"><span class="c-k">可用點數</span><span class="c-v">{{ fmtPts(d.wallet.available) }}</span></div>
        <div class="c-stat"><span class="c-k">鎖定中</span><span class="c-v">{{ fmtPts(d.wallet.locked) }}</span></div>
        <div class="c-stat"><span class="c-k">持有卡</span><span class="c-v">{{ d.prizes.length }}</span></div>
        <div class="c-stat"><span class="c-k">訂單</span><span class="c-v">{{ d.orders.length }}</span></div>
      </div>

      <div class="cols">
        <div>
          <section class="c-card">
            <h3>身分</h3>
            <dl class="c-dl">
              <dt>暱稱</dt><dd>{{ d.user.display_name || d.user.name || '—' }}</dd>
              <dt>Email</dt><dd>{{ d.user.email || '未綁定' }}</dd>
              <dt>登入</dt>
              <dd>
                <span v-for="p in d.providers" :key="p" class="c-pill">{{ PROVIDER_LABEL[p] || p }}</span>
                <span v-if="!d.providers.length" class="c-m">—</span>
              </dd>
              <dt>權限</dt><dd>{{ d.user.role === 'admin' ? '管理員' : '一般會員' }}</dd>
              <dt>加入</dt><dd>{{ fmtTime(d.user.created_at) }}</dd>
              <dt>ID</dt><dd class="c-m">{{ d.user.id }}</dd>
            </dl>
          </section>

          <section class="c-card">
            <h3>
              寄送資料
              <span class="c-pill" :class="addrDone ? 'done' : 'wait'">{{ addrDone ? '已完整' : '尚未填完' }}</span>
            </h3>
            <dl class="c-dl">
              <dt>本名</dt><dd>{{ d.user.real_name || '—' }}</dd>
              <dt>電話</dt><dd>{{ d.user.phone || '—' }}</dd>
              <dt>地址</dt>
              <dd>{{ [d.user.address_zip, d.user.address_city, d.user.address_line1].filter(Boolean).join(' ') || '—' }}</dd>
              <dt>生日</dt><dd>{{ d.user.birthday || '—' }}</dd>
            </dl>
            <p v-if="!addrDone" class="c-warn">資料不完整，出貨前需要先請對方補齊。</p>
          </section>

          <section class="c-card">
            <h3>調整點數</h3>
            <div class="c-field">
              <label class="c-lab">點數（負數為扣除）</label>
              <input v-model.number="pts" class="c-in" type="number" inputmode="numeric">
            </div>
            <div class="c-field">
              <label class="c-lab">原因（必填，會寫進稽核紀錄）</label>
              <input v-model="note" class="c-in" placeholder="例：客服補償 #1234">
            </div>
            <button class="c-btn pri" type="button" :disabled="!canGrant" @click="grant">
              {{ granting ? '處理中…' : '送出' }}
            </button>
          </section>
        </div>

        <div>
          <section class="c-card">
            <h3>出貨 <span class="c-m">{{ d.shipments.length }}</span></h3>
            <p v-if="!d.shipments.length" class="c-m">沒有出貨紀錄。</p>
            <ul v-else class="list">
              <li v-for="s in d.shipments" :key="s.id">
                <span class="c-pill" :class="s.status === 'delivered' ? 'done' : s.status === 'requested' ? 'wait' : 'go'">
                  {{ SHIP_LABEL[s.status] }}
                </span>
                <span class="c-m">{{ fmtTime(s.created_at) }}</span>
                <span v-if="s.tracking" class="c-m mono">{{ s.tracking }}</span>
              </li>
            </ul>
          </section>

          <section class="c-card">
            <h3>訂單 <span class="c-m">{{ d.orders.length }}</span></h3>
            <p v-if="!d.orders.length" class="c-m">沒有交易紀錄。</p>
            <ul v-else class="list">
              <li v-for="o in d.orders" :key="o.id">
                <span class="c-pill" :class="o.status === 'disputed' ? 'bad' : o.status === 'completed' ? 'done' : 'go'">
                  {{ orderSide(o) }}·{{ ORDER_LABEL[o.status] || o.status }}
                </span>
                <span class="nm">{{ o.card?.name || o.id }}</span>
                <span class="c-m">{{ fmtPts(o.price) }}</span>
              </li>
            </ul>
          </section>

          <section class="c-card">
            <h3>持有卡 <span class="c-m">{{ d.prizes.length }}</span></h3>
            <p v-if="!d.prizes.length" class="c-m">沒有卡片。</p>
            <ul v-else class="list">
              <li v-for="p in d.prizes" :key="p.id">
                <span class="c-pill">{{ p.tier }}</span>
                <span class="nm">{{ p.card?.name || p.id }}</span>
                <span class="c-m">{{ p.status }}</span>
              </li>
            </ul>
          </section>

          <section class="c-card">
            <h3>帳務明細 <span class="c-m">近 50 筆</span></h3>
            <ul class="list">
              <li v-for="l in d.ledger" :key="l.id">
                <span class="delta" :class="{ neg: l.delta < 0 }">{{ l.delta > 0 ? '+' : '' }}{{ fmtPts(l.delta) }}</span>
                <span class="nm c-m">{{ l.reason }}</span>
                <span class="c-m">{{ fmtTime(l.created_at) }}</span>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
h3 { font-size: 14px; margin: 0 0 11px; display: flex; align-items: center; gap: 7px; }
.c-stats { margin-bottom: 12px; }
.cols { display: grid; gap: 12px; }
@media (min-width: 900px) { .cols { grid-template-columns: 1fr 1fr; align-items: start; } }

.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.list li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-variant-numeric: tabular-nums; }
.delta { font-weight: 700; font-variant-numeric: tabular-nums; color: #86efac; min-width: 74px; }
.delta.neg { color: #fca5a5; }
</style>
