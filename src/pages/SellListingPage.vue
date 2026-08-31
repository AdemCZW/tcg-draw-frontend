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
import { refPriceText } from '@/lib/refprice'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const ids = computed(() => String(route.query.ids ?? '').split(',').filter(Boolean))
const all = ref<UserPrize[]>([])
const loading = ref(true)

/** 只收還在保管庫的卡 —— 已上架、已申請出貨的不能再上架 */
const cards = computed(() => all.value.filter(p => ids.value.includes(p.id) && (p.status === 'stashed' || p.status === 'in_book')))

/** 每張卡各自的定價。預設帶市值當錨點，但一定讓人改得動 —— 市值只是參考 */
const price = ref<Record<string, number | null>>({})

/* 卡冊改成分批載入之後不能只抓第一批：使用者是從卡冊裡「選好幾張」進來的，
   被選中的卡完全可能落在第 3 批。這裡沿著游標一路翻到「要的都找到了」為止，
   翻完就停 —— 只撈寄存中的，那是唯一能上架的狀態，量比整本卡冊小得多。 */
onMounted(async () => {
  const want = new Set(ids.value)
  const found: UserPrize[] = []
  let cursor: string | null = null
  do {
    /* 不帶 status 過濾：可上架的有兩種（stashed 與 in_book），
       API 的 status 參數一次只能給一個 —— 抓全部再在前端濾，
       選卡清單本來就已經把不能上架的排除在外。 */
    const page = await api.myPrizes({ cursor, limit: 100 })
    for (const p of page.items) if (want.has(p.id)) found.push(p)
    cursor = page.nextCursor
  } while (cursor && found.length < want.size)
  all.value = found
  for (const p of cards.value) price.value[p.id] = p.card.refPrice || null
  loading.value = false
})

const total = computed(() =>
  cards.value.reduce((a, p) => a + (price.value[p.id] || 0), 0))

const busy = ref(false)

/* ---- 灰掉的「確認上架」要說得出是哪一張卡 ----
   門檻只有一條：每一張都要有大於 0 的售價。但卡冊一次可以選很多張，
   價格欄一路往下排、按鈕在最下面 —— 上面某一格空著、下面按鈕灰掉，
   使用者看不出是哪一格的問題，而那一列很可能已經捲到視窗外了。
   所以理由要**指名卡片**，不能只說「有卡不符合條件」。

   帶市值進來當預設值的那一段（onMounted）讓大多數格子一開始就是填好的，
   會空的通常是「賣家沒標參考價」的那幾張 —— 更需要被點名，
   因為使用者根本不知道自己漏了哪一張。 */
const priceMissing = computed(() =>
  cards.value.filter(p => !((price.value[p.id] ?? 0) > 0)).map(p => p.card.name))
/* 超過四張就只列前四張。全部列出來的話，選了二十張時這段字會比表單還長，
   而「還差 N 張」那個數字已經把規模講清楚了，往上捲就找得到剩下的。 */
const LIST_CAP = 4
const blockWhy = computed(() => {
  if (busy.value || !cards.value.length) return ''
  const miss = priceMissing.value
  if (!miss.length) return ''
  const shown = miss.slice(0, LIST_CAP).join('、')
  const rest = miss.length > LIST_CAP ? `等 ${miss.length} 張` : ''
  return `還差 ${miss.length} 張的售價（要大於 0）：${shown}${rest}。`
})
const ready = computed(() => cards.value.length > 0 && priceMissing.value.length === 0)

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
      <!-- 這裡的「沒有卡」幾乎都是「直接打網址進來、沒有從卡冊帶選取」，
           不是使用者真的沒有卡 —— 說「沒有可以上架的卡」會讓有卡的人
           以為卡不能上架。文案講清楚是「還沒選」。 -->
      還沒選要上架的卡，回<RouterLink :to="{ name: 'cards' }">卡冊</RouterLink>挑幾張再過來。
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
            <!-- 兩個對照數字：參考價是賣家標示的行情（僅供參考、不構成承諾），
                 買回價是賣家宣告、有義務履行的金額。定價低於買回價的話上架
                 就沒有意義，要讓人當場看得出來。
                 沒有宣告買回價的池就不顯示這個對照 —— 硬湊一個數字會讓人
                 拿一個不存在的選項來比價。 -->
            <p class="hint mono">
              賣家標示參考價 {{ refPriceText(p.card.refPrice) }}
              <template v-if="recycleQuote(p.buyback).eligible">
                · 賣家宣告買回價 {{ recycleQuote(p.buyback).points.toLocaleString() }}
                <span
                  v-if="(price[p.id] ?? 0) > 0 && (price[p.id] ?? 0) < recycleQuote(p.buyback).points"
                  class="warn"
                >
                  　低於買回價
                </span>
              </template>
            </p>
          </div>
        </li>
      </ul>

      <div class="bar card">
        <!-- 理由跟按鈕同一格、就在它正上方：這條列是 sticky，按鈕永遠看得到，
             把理由放在別的地方等於又要使用者去找。role="status" 讓讀屏在
             最後一格填好的當下就聽到門檻已經過了。 -->
        <p v-if="blockWhy" id="sellWhy" class="blockWhy" role="status">{{ blockWhy }}</p>
        <div class="barRow">
          <span class="sum">
            {{ cards.length }} 張 · 合計 <strong class="mono">{{ total.toLocaleString() }}</strong> 點
          </span>
          <button
            class="btn primary" :disabled="!ready || busy"
            :aria-describedby="blockWhy ? 'sellWhy' : undefined"
            @click="submit"
          >
            {{ busy ? '上架中…' : '確認上架' }}
          </button>
        </div>
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
/* 讓位只留一份：安全區已經由全域頁尾的 --nav-total 算過了（見 App.vue），
   這裡再加一次會在頁面下緣多出一段捲得到卻空無一物的黑。
   96px 是留給下面那條 sticky 結帳列的活動空間，跟安全區無關。 */
.page { padding-top: 20px; padding-bottom: 96px; max-width: 640px; }
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
  /* 手機上底部導覽是在的（這頁沒設 chrome: none），原本只避開安全區
     會讓這條列的下半截被導覽蓋掉 —— 而它是整個上架流程的送出鍵。
     取 max：手機的 --nav-total 已含安全區，桌機是 0 才輪到 --safe-b
     （同 NotifyBell 的寫法）。 */
  position: sticky; bottom: calc(12px + max(var(--nav-total, 0px), var(--safe-b, 0px)));
  /* 從 flex 改成 grid：理由那一行要獨佔一列疊在按鈕上方，
     跟合計並排的話它會被擠成一條讀不了的窄柱。 */
  display: grid; gap: 8px; min-width: 0;
  padding: 12px 14px; margin-top: 14px;
  background: var(--surface);
}
.barRow { display: flex; align-items: center; gap: 12px; min-width: 0; }
/* 灰按鈕的理由。用 --warn-ink 不用 --danger：使用者沒做錯事，
   只是還沒填完，紅字會讀成「出錯了」（同卡冊出貨面板與出價面板） */
.blockWhy {
  margin: 0; min-width: 0;
  font-size: 12.5px; line-height: 1.55; color: var(--warn-ink);
  overflow-wrap: anywhere;
}
.sum { flex: 1; min-width: 0; font-size: 13px; }
.sum strong { font-size: 17px; color: var(--gold-deep); }

.msg { margin: 12px 0 0; padding: 11px 13px; border-radius: 10px; font-size: 13px; line-height: 1.7; }
.msg p { margin: 0; }
.msg.ok { background: #14532d55; color: #86efac; }
.msg.bad { background: #7f1d1d55; color: #fca5a5; }
</style>
