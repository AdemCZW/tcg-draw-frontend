<script setup lang="ts">
/**
 * 上架到市場。
 *
 * 為什麼是獨立一頁而不是卡片裡的行內表單：表單的輸入框有自己的固有寬度，
 * 塞進卡冊的格線裡會把那一格撐開、隔壁格被擠扁（實測 393px 上兩欄
 * 從各 172px 變成 290px + 62.5px）。定價這件事也值得一個能好好看清楚的畫面 ——
 * 它決定你拿多少錢。
 *
 * 上架 ≠ 開池。這裡是把手上的單張卡放到市場讓人直接買；
 * 開池是自己當賣家組一整池獎品讓人抽，要先申請賣家並通過審核。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/lib/api'
import { ApiError } from '@/lib/http'
import { useAuthStore } from '@/stores/auth'
import { recycleQuote } from '@/lib/recycle'
import type { UserPrize } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import TierBadge from '@/components/TierBadge.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const ids = computed(() => String(route.query.ids ?? '').split(',').filter(Boolean))
const all = ref<UserPrize[]>([])
const loading = ref(true)

/** 只收還在保管庫的卡 —— 已上架、已申請出貨的不能再上架 */
const cards = computed(() => all.value.filter(p => ids.value.includes(p.id) && p.status === 'stashed'))

/** 每張卡各自的定價。預設帶市值當錨點，但一定讓人改得動 —— 市值只是參考 */
const price = ref<Record<string, number | null>>({})

onMounted(async () => {
  all.value = await api.myPrizes()
  for (const p of cards.value) price.value[p.id] = p.card.refPrice || null
  loading.value = false
})

const total = computed(() =>
  cards.value.reduce((a, p) => a + (price.value[p.id] || 0), 0))
const ready = computed(() =>
  cards.value.length > 0 && cards.value.every(p => (price.value[p.id] ?? 0) > 0))

const busy = ref(false)
const err = ref('')
/** 部分成功也要講清楚是哪幾張成功了，不要只說「失敗」讓人不知道現在的狀態 */
const done = ref<{ ok: string[]; failed: string[] } | null>(null)

async function submit() {
  if (!ready.value || busy.value) return
  busy.value = true
  err.value = ''
  const ok: string[] = []
  const failed: string[] = []
  for (const p of cards.value) {
    try {
      await api.createListing({
        prizeId: p.id, card: p.card, price: price.value[p.id]!,
        sellerName: auth.user?.name || auth.user?.handle || '我'
      })
      ok.push(p.card.name)
    } catch (e) {
      failed.push(`${p.card.name}（${e instanceof ApiError ? e.message : '失敗'}）`)
    }
  }
  busy.value = false
  done.value = { ok, failed }
  if (!failed.length) setTimeout(() => router.replace({ name: 'cards' }), 1600)
}
</script>

<template>
  <div class="container page">
    <header class="head">
      <RouterLink :to="{ name: 'cards' }" class="back">← 卡冊</RouterLink>
      <h1>上架到市場</h1>
    </header>

    <p class="lead">
      上架後這幾張卡會出現在<strong>市場</strong>，任何人都能直接買下。
      卡片還在保管庫，所以買家下單即成交、點數直接入帳，不需要寄送。
      賣出前這些卡不能出貨也不能回收。
    </p>

    <p v-if="loading" class="muted">載入中…</p>
    <p v-else-if="!cards.length" class="muted">
      沒有可以上架的卡。<RouterLink :to="{ name: 'cards' }">回卡冊</RouterLink>
    </p>

    <template v-else>
      <ul class="list">
        <li v-for="p in cards" :key="p.id" class="row card">
          <CardArt
            class="thumb" :image="p.card.image" :alt="p.card.name"
            :tier="p.tier" :cert-no="p.card.certNo" :art-id="p.card.artId"
          />
          <div class="meta">
            <div class="top"><TierBadge :tier="p.tier" /><strong class="nm">{{ p.card.name }}</strong></div>
            <label class="priceRow">
              <span>售價</span>
              <input v-model.number="price[p.id]" type="number" inputmode="numeric" min="1">
              <span class="u">點</span>
            </label>
            <!-- 兩個對照數字：市值是行情、回收價是「不上架的話平台給多少」。
                 定價低於回收價的話上架就沒有意義，要讓人當場看得出來 -->
            <p class="hint mono">
              市值 {{ (p.card.refPrice || 0).toLocaleString() }}
              · 回收價 {{ recycleQuote(p.card).points.toLocaleString() }}
              <span v-if="(price[p.id] ?? 0) > 0 && (price[p.id] ?? 0) < recycleQuote(p.card).points" class="warn">
                　低於回收價
              </span>
            </p>
          </div>
        </li>
      </ul>

      <div class="bar card">
        <span class="sum">
          {{ cards.length }} 張 · 合計 <strong class="mono">{{ total.toLocaleString() }}</strong> 點
        </span>
        <button class="btn primary" :disabled="!ready || busy" @click="submit">
          {{ busy ? '上架中…' : '確認上架' }}
        </button>
      </div>

      <p v-if="err" class="msg bad">{{ err }}</p>
      <div v-if="done" class="msg" :class="done.failed.length ? 'bad' : 'ok'" role="status">
        <p v-if="done.ok.length">已上架：{{ done.ok.join('、') }}</p>
        <p v-if="done.failed.length">未成功：{{ done.failed.join('、') }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.page { padding-top: 20px; padding-bottom: calc(96px + var(--safe-b, 0px)); max-width: 640px; }
.head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.back { font-size: 13px; color: var(--muted); text-decoration: none; }
h1 { font-size: 20px; margin: 0; }
.lead { font-size: 13.5px; line-height: 1.8; color: var(--muted); margin: 0 0 16px; }
.lead strong { color: var(--ink); }

.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; gap: 12px; padding: 12px; align-items: flex-start; }
.thumb { width: 68px; flex: none; border-radius: 8px; }
/* min-width: 0 —— flex 子元素預設不會縮到比內容窄，少了它輸入框會把整列撐爆 */
.meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.top { display: flex; align-items: center; gap: 8px; }
.nm { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.priceRow { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted); }
.priceRow input {
  flex: 1; min-width: 0;
  padding: 9px 11px; font: inherit; font-size: 16px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--field, var(--surface-2)); color: var(--ink);
}
.priceRow input:focus { outline: none; border-color: var(--gold); }
.priceRow .u { flex: none; }
.hint { font-size: 11.5px; line-height: 1.6; color: var(--faint); margin: 0; }
.hint .warn { color: #fcd34d; }

.bar {
  position: sticky; bottom: calc(12px + var(--safe-b, 0px));
  display: flex; align-items: center; gap: 12px;
  padding: 12px 14px; margin-top: 14px;
  background: var(--surface);
}
.sum { flex: 1; min-width: 0; font-size: 13px; }
.sum strong { font-size: 17px; color: var(--gold-deep); }

.msg { margin: 12px 0 0; padding: 11px 13px; border-radius: 10px; font-size: 13px; line-height: 1.7; }
.msg p { margin: 0; }
.msg.ok { background: #14532d55; color: #86efac; }
.msg.bad { background: #7f1d1d55; color: #fca5a5; }
</style>
