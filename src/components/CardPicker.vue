<script setup lang="ts">
/**
 * 卡片挑選器。
 *
 * 開池時的獎品原本是「打字輸入卡名」，那件事本身就是錯的：打出來的字串
 * 沒有卡號、沒有系列、沒有卡圖，系統永遠不知道那是哪一張卡，也就永遠
 * 對不到外部價格。這個元件把「輸入」換成「挑」——
 *
 *   從我的卡冊挑  賣家手上已經有的卡（含鑑定編號）。身分本來就是完整的，
 *                 點一下就帶進來，一個字都不用打，也不可能打錯。
 *   搜卡片目錄    打卡名查 TCGdex，用卡圖挑。選中之後才去查詳情補齊
 *                 「編號/總數」與變體。
 *
 * 對外介面：v-model 綁一個 PickedCard[]（見 lib/card-pick.ts）。
 * 呼叫端要 CardItem 就取每一筆的 .card。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { api } from '@/lib/api'
import type { UserPrize } from '@/types/models'
import { useInfiniteList } from '@/composables/useInfiniteList'
import ListSentinel from '@/components/ListSentinel.vue'
import {
  searchCards, cardDetail, artUrlOf, CatalogError,
  type CatalogCard, type CatalogHit, type CatalogVariant
} from '@/lib/tcgdex-catalog'
import { pickFromCatalog, pickFromPrize, type PickedCard } from '@/lib/card-pick'

const props = withDefaults(defineProps<{
  /** 已選的卡。v-model */
  modelValue?: PickedCard[]
  /** 最多能選幾張。到上限之後其餘的卡不能再點 */
  max?: number
  /** 一開始站在哪一個來源 */
  defaultSource?: 'cardbook' | 'catalog'
}>(), { modelValue: () => [], max: 60, defaultSource: 'cardbook' })

const emit = defineEmits<{
  'update:modelValue': [PickedCard[]]
  /** 單張選中。呼叫端只想「加一張到某一格」時用這個，不必自己 diff 陣列 */
  pick: [PickedCard]
  /** 單張移除 */
  remove: [PickedCard]
}>()

const picked = computed(() => props.modelValue)
const pickedKeys = computed(() => new Set(picked.value.map(p => p.key)))
const atMax = computed(() => picked.value.length >= props.max)

function add(p: PickedCard) {
  if (pickedKeys.value.has(p.key) || atMax.value) return
  emit('update:modelValue', [...picked.value, p])
  emit('pick', p)
}
function remove(p: PickedCard) {
  emit('update:modelValue', picked.value.filter(x => x.key !== p.key))
  emit('remove', p)
}
/** 點同一張＝取消選取。挑的時候手誤按到，最自然的修正就是再按一次 */
function toggle(p: PickedCard) {
  if (pickedKeys.value.has(p.key)) remove(p)
  else add(p)
}

/* ---------- 來源切換 ---------- */
const source = ref<'cardbook' | 'catalog'>(props.defaultSource)

/* ---------- 來源一：我的卡冊 ---------- */
/* 分頁交給既有的 useInfiniteList —— 卡冊本來就是游標分頁的，
   在這裡自己再寫一份捲動載入等於把「請求競態、重複觸發、卸載要斷開」
   那三個坑再踩一次。 */
const book = useInfiniteList<UserPrize>((cursor, signal) =>
  api.myPrizes({ cursor, signal, status: 'stashed' }))
/* 模板的字串 ref 要綁到 setup 的頂層 binding；巢狀在物件裡的 ref 綁不到 */
const bookSentinel = book.sentinel

/* ---------- 來源二：卡片目錄 ---------- */
const query = ref('')
const hits = ref<CatalogHit[]>([])
const hiddenNoArt = ref(0)
const searching = ref(false)
/** 已經搜過至少一次（成功或失敗）。在那之前的「查無結果」是假的 */
const searched = ref(false)
const searchError = ref('')

const DEBOUNCE_MS = 400
let timer: ReturnType<typeof setTimeout> | undefined
let ctrl: AbortController | null = null
/* 世代編號：abort 斷得掉還在傳輸的請求，但已經在解析中的仍然會走完 then。
   沒有這道檢查，先發後回的舊查詢會把新查詢的結果蓋掉。 */
let gen = 0

async function runSearch(q: string) {
  const my = ++gen
  ctrl?.abort()
  const ac = new AbortController()
  ctrl = ac
  searching.value = true
  searchError.value = ''
  try {
    const r = await searchCards(q, ac.signal)
    if (my !== gen) return
    hits.value = r.hits
    hiddenNoArt.value = r.hiddenNoArt
  } catch (e) {
    if (my !== gen || ac.signal.aborted) return
    hits.value = []
    hiddenNoArt.value = 0
    searchError.value = e instanceof CatalogError ? e.message : '搜尋失敗，請稍後再試'
  } finally {
    if (my === gen) { searching.value = false; searched.value = true }
  }
}

/* 每按一個鍵就打一次 API 是對一個免費公開 API 的濫用，而且中間那些
   打到一半的字（「リ」「リザ」）查出來的東西沒有人要看。等手停下來再查。 */
watch(query, q => {
  clearTimeout(timer)
  const s = q.trim()
  if (!s) {
    gen++              // 作廢還在飛的查詢，免得它稍後把結果塞回空畫面
    ctrl?.abort()
    hits.value = []
    hiddenNoArt.value = 0
    searching.value = false
    searched.value = false
    searchError.value = ''
    return
  }
  // 一個字幾乎必然回傳幾百筆，等於整個目錄，沒有挑選的意義
  if (s.length < 2) return
  searching.value = true       // 立刻顯示骨架，不要等 400ms 才有反應
  timer = setTimeout(() => void runSearch(s), DEBOUNCE_MS)
})

function retrySearch() {
  const s = query.value.trim()
  if (s.length >= 2) void runSearch(s)
}

/* ---------- 目錄卡的詳情 / 變體 ---------- */
/**
 * 為什麼點下去不是直接加入：搜尋端點不回 set 資訊，卡號的分母（「/190」）
 * 只有詳情裡才有。而且同一組卡號可能是完全不同的商品（普卡 vs 大師球鏡面，
 * 實測差 18,000 倍），要讓人選。
 */
const detail = ref<CatalogCard | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
let detailCtrl: AbortController | null = null
let detailGen = 0

async function openDetail(hit: CatalogHit) {
  const my = ++detailGen
  detailCtrl?.abort()
  const ac = new AbortController()
  detailCtrl = ac
  detail.value = null
  detailError.value = ''
  detailLoading.value = true
  try {
    const c = await cardDetail(hit.artId, ac.signal)
    if (my !== detailGen) return
    detail.value = c
  } catch (e) {
    if (my !== detailGen || ac.signal.aborted) return
    detailError.value = e instanceof CatalogError ? e.message : '讀取卡片資料失敗'
  } finally {
    if (my === detailGen) detailLoading.value = false
  }
}
function closeDetail() {
  detailGen++
  detailCtrl?.abort()
  detail.value = null
  detailError.value = ''
  detailLoading.value = false
}

function addFromDetail(v: CatalogVariant | null) {
  if (!detail.value) return
  add(pickFromCatalog(detail.value, v))
  closeDetail()
}

onBeforeUnmount(() => {
  clearTimeout(timer)
  gen++; ctrl?.abort()
  detailGen++; detailCtrl?.abort()
})

/* 歐元行情只做參考顯示，不換算成點數：匯率會變成一個沒人負責的數字。
   賣家看得到「普卡 €0.02 / 大師球 €369」就足以避免挑錯那一張。 */
const eur = (n: number | null) => (n === null ? '—' : `€${n < 10 ? n.toFixed(2) : Math.round(n)}`)

const prizeArt = (p: UserPrize) => pickFromPrize(p).artUrl
const isPrizePicked = (p: UserPrize) => pickedKeys.value.has(`prize:${p.id}`)
const hitPickedCount = (h: CatalogHit) =>
  picked.value.filter(p => p.source === 'catalog' && p.card.artId === h.artId).length
</script>

<template>
  <div class="picker">
    <!-- 來源切換。兩種來源回答的是不同的問題：「我手上有的」與「這世上有的」 -->
    <div class="tabs" role="tablist">
      <button
        type="button" role="tab" class="tab" :class="{ on: source === 'cardbook' }"
        :aria-selected="source === 'cardbook'" @click="source = 'cardbook'">
        從我的卡冊挑
      </button>
      <button
        type="button" role="tab" class="tab" :class="{ on: source === 'catalog' }"
        :aria-selected="source === 'catalog'" @click="source = 'catalog'">
        搜卡片目錄
      </button>
    </div>

    <!-- 已選清單。放在最上面：挑到第二十張時要知道自己挑了什麼，
         而不是捲到最下面去找 -->
    <section v-if="picked.length" class="chosen" aria-label="已選的卡">
      <p class="chosenHead">
        <span>已選 {{ picked.length }} 張</span>
        <span v-if="max" class="muted">上限 {{ max }}</span>
      </p>
      <ul class="chips">
        <li v-for="p in picked" :key="p.key" class="pickChip">
          <img
            v-if="p.artUrl" class="chipArt" :src="p.artUrl" :alt="''"
            loading="lazy" decoding="async">
          <span v-else class="chipArt ph" aria-hidden="true"></span>
          <span class="chipText">
            <span class="chipName">{{ p.card.name }}</span>
            <span class="chipMeta">
              {{ p.card.setCode || '—' }} · {{ p.card.cardNo || '—' }}
              <template v-if="p.variant"> · {{ p.variant.label }}</template>
            </span>
          </span>
          <button
            type="button" class="x" :aria-label="`移除 ${p.card.name}`" @click="remove(p)">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </li>
      </ul>
    </section>

    <p v-if="atMax" class="note warn">已達上限 {{ max }} 張，要再加請先移除。</p>

    <!-- ---------- 卡冊 ---------- -->
    <section v-show="source === 'cardbook'" class="pane">
      <div v-if="!book.ready.value" class="grid" aria-hidden="true">
        <span v-for="i in 6" :key="i" class="skel"></span>
      </div>

      <p v-else-if="!book.items.value.length && !book.error.value" class="empty">
        卡冊裡沒有可以開池的卡。<br>
        <span class="muted">只有寄存中的卡能當獎品 —— 已上架或已出貨的卡不在這裡。</span>
      </p>

      <ul v-else class="grid">
        <li v-for="p in book.items.value" :key="p.id" class="cell">
          <button
            type="button" class="tile" :class="{ on: isPrizePicked(p) }"
            :disabled="atMax && !isPrizePicked(p)"
            :aria-pressed="isPrizePicked(p)"
            @click="toggle(pickFromPrize(p))">
            <span class="art">
              <img
                v-if="prizeArt(p)" :src="prizeArt(p)!" :alt="p.card.name"
                loading="lazy" decoding="async">
              <span v-else class="ph" aria-hidden="true"></span>
              <span class="tierTag" :class="`t-${p.tier.toLowerCase()}`">{{ p.tier }}</span>
              <span v-if="isPrizePicked(p)" class="tick" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>
              </span>
            </span>
            <span class="name">{{ p.card.name }}</span>
            <span class="meta">
              {{ p.card.setCode || '—' }} · {{ p.card.cardNo || '—' }}
            </span>
            <span class="meta">
              {{ p.card.grader }}<template v-if="p.card.grade"> {{ p.card.grade }}</template>
              <template v-if="p.card.certNo"> · #{{ p.card.certNo }}</template>
            </span>
          </button>
        </li>
      </ul>

      <ListSentinel
        ref="bookSentinel"
        :loading="book.loading.value" :done="book.done.value" :error="book.error.value"
        :manual="book.manual.value" :empty="!book.items.value.length"
        done-text="卡冊到底了"
        @retry="book.retry()" @more="book.load()" />
    </section>

    <!-- ---------- 目錄 ---------- -->
    <section v-show="source === 'catalog'" class="pane">
      <label class="search">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          v-model="query" type="search" inputmode="search"
          placeholder="輸入卡名，例如 リザードン"
          aria-label="搜尋卡片目錄">
      </label>
      <p class="hintLine muted">
        日文卡名查得最準（這裡查的是日版目錄）。至少輸入兩個字。
      </p>

      <div v-if="searching" class="grid" aria-hidden="true">
        <span v-for="i in 6" :key="i" class="skel"></span>
      </div>

      <div v-else-if="searchError" class="fail" role="alert">
        <p class="failMsg">{{ searchError }}</p>
        <button type="button" class="btn sm" @click="retrySearch">重新搜尋</button>
      </div>

      <p v-else-if="searched && !hits.length" class="empty">
        找不到「{{ query.trim() }}」。<br>
        <span class="muted">
          試試日文卡名，或只打寶可夢的名字不要帶 ex / SAR 這種後綴。
          <template v-if="hiddenNoArt">（另有 {{ hiddenNoArt }} 張同名卡沒有卡圖，無法用挑的）</template>
        </span>
      </p>

      <template v-else-if="hits.length">
        <ul class="grid">
          <li v-for="h in hits" :key="h.artId" class="cell">
            <button
              type="button" class="tile" :class="{ on: hitPickedCount(h) > 0 }"
              :disabled="atMax && !hitPickedCount(h)"
              @click="openDetail(h)">
              <span class="art">
                <img
                  v-if="artUrlOf(h, 'low')" :src="artUrlOf(h, 'low')!" :alt="h.name"
                  loading="lazy" decoding="async">
                <span v-else class="ph" aria-hidden="true"></span>
                <span v-if="hitPickedCount(h)" class="tick" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>
                </span>
              </span>
              <span class="name">{{ h.name }}</span>
              <span class="meta">{{ h.artId }}</span>
            </button>
          </li>
        </ul>
        <p v-if="hiddenNoArt" class="note muted">
          另有 {{ hiddenNoArt }} 張同名卡目錄裡沒有卡圖，沒有列出來。
        </p>
      </template>
    </section>

    <!-- 詳情 / 選變體。用 Teleport 送到 body：這個元件可能被包在有 transform
         的容器裡（頁面轉場、Tilt3D），那會讓 position: fixed 改以祖先為基準。
         見 docs/HANDOFF.md 2.2 -->
    <Teleport to="body">
      <div v-if="detail || detailLoading || detailError" class="sheetWrap" @click.self="closeDetail">
        <div class="sheet" role="dialog" aria-modal="true" aria-label="卡片詳情">
          <button type="button" class="close" aria-label="關閉" @click="closeDetail">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>

          <p v-if="detailLoading" class="sheetLoad">
            <span class="ring" aria-hidden="true"></span>讀取卡片資料
          </p>

          <div v-else-if="detailError" class="fail" role="alert">
            <p class="failMsg">{{ detailError }}</p>
          </div>

          <template v-else-if="detail">
            <div class="sheetTop">
              <img
                v-if="artUrlOf(detail)" class="sheetArt" :src="artUrlOf(detail)!"
                :alt="detail.name" decoding="async">
              <span v-else class="sheetArt ph" aria-hidden="true"></span>
              <div class="sheetId">
                <p class="sheetName">{{ detail.name }}</p>
                <p class="sheetMeta">{{ detail.setName }}</p>
                <p class="sheetMeta mono">{{ detail.setCode }} · {{ detail.cardNo }}</p>
                <p v-if="detail.rarity" class="sheetMeta">{{ detail.rarity }}</p>
              </div>
            </div>

            <!-- 變體。同一組卡號可能是完全不同的商品，所以要挑，不能替使用者決定 -->
            <template v-if="detail.variants.length > 1">
              <p class="sheetLabel">選版本</p>
              <p class="sheetWhy muted">
                同一組卡號有多個版本，價差可能非常大。選錯等於獎品講的不是同一張卡。
              </p>
              <ul class="variants">
                <li v-for="v in detail.variants" :key="v.variantId">
                  <button type="button" class="varBtn" :disabled="atMax" @click="addFromDetail(v)">
                    <span class="varName">{{ v.label }}</span>
                    <span class="varPrice mono">{{ eur(v.priceEur) }}</span>
                  </button>
                </li>
              </ul>
              <p class="sheetWhy muted">價格是 cardmarket 的歐元行情，僅供辨識版本用。</p>
            </template>

            <button v-else type="button" class="btn primary wide" :disabled="atMax" @click="addFromDetail(detail.variants[0] ?? null)">
              加入這張卡
            </button>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* grid / flex 的子元素一律 min-width: 0，欄位用 minmax(0, 1fr)。
   這個 repo 的手機跑版有一半來自預設的 min-width: auto（見 HANDOFF 2.1） */
.picker { min-width: 0; display: grid; gap: 14px; }

/* ---- 來源切換 ---- */
.tabs {
  min-width: 0;
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px; padding: 4px;
  background: var(--surface-2); border-radius: var(--pill);
}
.tab {
  min-width: 0;
  border: 0; background: transparent; color: var(--muted);
  font-size: 13.5px; font-weight: 600;
  padding: 10px 8px; border-radius: var(--pill);
  transition: background .18s, color .18s;
}
.tab.on { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-sm); }

/* ---- 已選 ---- */
.chosen { min-width: 0; display: grid; gap: 8px; }
.chosenHead {
  min-width: 0; margin: 0;
  display: flex; justify-content: space-between; gap: 10px;
  font-size: 13px; font-weight: 600;
}
.chips { min-width: 0; list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.pickChip {
  min-width: 0;
  display: grid; grid-template-columns: 30px minmax(0, 1fr) 32px;
  align-items: center; gap: 10px;
  padding: 6px 8px 6px 6px;
  background: var(--surface-2); border-radius: 12px;
}
.chipArt { width: 30px; aspect-ratio: 63 / 88; object-fit: cover; border-radius: 4px; }
.chipArt.ph { background: var(--surface-3); }
.chipText { min-width: 0; display: grid; gap: 1px; }
.chipName {
  min-width: 0; font-size: 13px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chipMeta {
  min-width: 0; font-size: 11px; color: var(--muted);
  font-family: var(--font-mono);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.x {
  width: 32px; height: 32px; min-width: 0;
  display: grid; place-items: center;
  border: 0; background: transparent; color: var(--muted); border-radius: 50%;
}
.x svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }

/* ---- 面板共用 ---- */
.pane { min-width: 0; display: grid; gap: 10px; }
.note { min-width: 0; margin: 0; font-size: 12px; line-height: 1.6; }
.note.warn { color: var(--warn-ink); }
.muted { color: var(--muted); }
.mono { font-family: var(--font-mono); }
.hintLine { margin: 0; font-size: 11.5px; line-height: 1.6; }

.empty {
  min-width: 0; margin: 0; padding: 26px 12px;
  text-align: center; font-size: 13px; line-height: 1.8;
}
.fail { min-width: 0; display: grid; justify-items: center; gap: 10px; padding: 22px 12px; text-align: center; }
.failMsg { margin: 0; font-size: 13px; color: var(--danger-ink); }

/* ---- 卡片格線 ---- */
.grid {
  min-width: 0; list-style: none; margin: 0; padding: 0;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 10px;
}
.cell { min-width: 0; }
.tile {
  min-width: 0; width: 100%;
  display: grid; gap: 3px; justify-items: stretch;
  padding: 6px; border-radius: 12px;
  border: 1px solid transparent; background: var(--surface-2);
  color: var(--ink); text-align: left;
  transition: border-color .18s, background .18s, transform .12s;
}
.tile:disabled { opacity: .38; }
.tile.on { border-color: var(--accent); background: var(--accent-wash); }
.tile:active:not(:disabled) { transform: scale(.97); }
.art {
  position: relative; min-width: 0;
  display: block; aspect-ratio: 63 / 88;
  border-radius: 7px; overflow: hidden; background: var(--surface-3);
}
.art img { width: 100%; height: 100%; object-fit: cover; display: block; }
.art .ph { display: block; width: 100%; height: 100%; background: var(--surface-3); }
/* 賞別標記自己畫一顆小的，不用 TierBadge —— 那顆的內距是給列表用的，
   放在 96px 寬的縮圖角落會蓋掉半張卡 */
.tierTag {
  position: absolute; left: 4px; top: 4px;
  min-width: 16px; padding: 1px 5px; border-radius: var(--pill);
  font-size: 9.5px; font-weight: 700; color: #fff; line-height: 1.5;
}
.t-a { background: var(--tier-a); }
.t-b { background: var(--tier-b); }
.t-c { background: var(--tier-c); }
.t-d { background: var(--tier-d); }
.t-last { background: var(--tier-last); }
.t-bust { background: var(--faint); }
.tick {
  position: absolute; right: 4px; top: 4px;
  width: 20px; height: 20px; border-radius: 50%;
  background: var(--accent); display: grid; place-items: center;
}
.tick svg { width: 12px; height: 12px; fill: none; stroke: var(--on-accent); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
.name {
  min-width: 0; font-size: 12px; font-weight: 600; line-height: 1.35;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.meta {
  min-width: 0; font-size: 10.5px; color: var(--muted);
  font-family: var(--font-mono); line-height: 1.4;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* 骨架。空白畫面跟「沒有結果」長得一樣，使用者分不出在載入還是查無資料 */
.skel {
  display: block; aspect-ratio: 63 / 88; border-radius: 12px;
  background: linear-gradient(100deg, var(--surface-2) 30%, var(--surface-3) 50%, var(--surface-2) 70%);
  background-size: 300% 100%;
  animation: skel 1.3s linear infinite;
}
@keyframes skel { from { background-position: 100% 0; } to { background-position: -100% 0; } }
@media (prefers-reduced-motion: reduce) { .skel { animation: none; } }

/* ---- 搜尋框 ---- */
.search {
  min-width: 0;
  display: grid; grid-template-columns: 20px minmax(0, 1fr);
  align-items: center; gap: 8px;
  padding: 0 14px;
  background: var(--field); border: 1px solid var(--line); border-radius: var(--pill);
}
.search .ico { width: 16px; height: 16px; fill: none; stroke: var(--faint); stroke-width: 2; stroke-linecap: round; }
.search input {
  min-width: 0; width: 100%;
  border: 0; background: transparent; color: var(--ink);
  /* 16px 是底線：iOS Safari 對小於 16px 的輸入框會自動放大整頁 */
  font-size: 16px; padding: 12px 0;
  outline: none;
}
.search input::placeholder { color: var(--faint); }
/* type="search" 的原生清除鍵是系統藍的，跟整站配色不同掛而且無法上色。
   藏起來 —— 清空輸入框全選刪除就好，不值得為它破壞配色 */
.search input::-webkit-search-cancel-button,
.search input::-webkit-search-decoration { -webkit-appearance: none; appearance: none; }

/* ---- 詳情面板 ---- */
.sheetWrap {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(0, 0, 0, .62);
  display: grid; align-items: end; justify-items: center;
}
@media (min-width: 720px) { .sheetWrap { align-items: center; } }
.sheet {
  min-width: 0; width: min(460px, 100%);
  max-height: min(86dvh, 720px); overflow: auto;
  position: relative;
  display: grid; gap: 10px;
  padding: 18px 16px calc(18px + max(var(--nav-total, 0px), var(--safe-b, 0px)));
  background: var(--surface); border-radius: var(--radius-lg) var(--radius-lg) 0 0;
}
@media (min-width: 720px) { .sheet { border-radius: var(--radius-lg); padding-bottom: 18px; } }
.close {
  position: absolute; right: 10px; top: 10px;
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 0; background: var(--surface-2); color: var(--muted); border-radius: 50%;
}
.close svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.sheetLoad { margin: 0; padding: 30px 0; display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 13px; color: var(--muted); }
.ring {
  width: 15px; height: 15px; border-radius: 50%;
  border: 2px solid var(--line); border-top-color: var(--accent);
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(1turn); } }

.sheetTop {
  min-width: 0;
  display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 14px;
  padding-right: 38px;
}
.sheetArt { width: 92px; aspect-ratio: 63 / 88; object-fit: cover; border-radius: 8px; background: var(--surface-3); }
.sheetId { min-width: 0; display: grid; gap: 3px; align-content: start; }
.sheetName { min-width: 0; margin: 0; font-size: 16px; font-weight: 700; line-height: 1.3; }
.sheetMeta { min-width: 0; margin: 0; font-size: 12px; color: var(--muted); line-height: 1.5; overflow-wrap: anywhere; }
.sheetLabel { margin: 6px 0 0; font-size: 13px; font-weight: 700; }
.sheetWhy { margin: 0; font-size: 11.5px; line-height: 1.6; }
.variants { min-width: 0; list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.varBtn {
  min-width: 0; width: 100%;
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: center; gap: 10px;
  padding: 12px 14px; border-radius: 12px;
  border: 1px solid var(--line); background: var(--surface-2); color: var(--ink);
  font-size: 13.5px; font-weight: 600; text-align: left;
}
.varBtn:disabled { opacity: .4; }
.varName { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.varPrice { font-size: 12.5px; color: var(--muted); }
.wide { width: 100%; }
</style>
