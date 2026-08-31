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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from '@/lib/api'
import type { UserPrize } from '@/types/models'
import { useInfiniteList } from '@/composables/useInfiniteList'
import { useMediaQuery } from '@/composables/useMediaQuery'
import ListSentinel from '@/components/ListSentinel.vue'
import BottomActionBar from '@/components/BottomActionBar.vue'
import {
  searchCards, cardDetail, artUrlOf, CatalogError,
  type CatalogCard, type CatalogHit, type CatalogVariant,
  type SearchField, type SearchResult
} from '@/lib/tcgdex-catalog'
import { pickFromCatalog, pickFromPrize, type PickedCard } from '@/lib/card-pick'
import { mergeByCard, certTailOf, type MergeGroup } from '@/lib/card-merge'

const props = withDefaults(defineProps<{
  /** 已選的卡。v-model */
  modelValue?: PickedCard[]
  /** 最多能選幾張。到上限之後其餘的卡不能再點 */
  max?: number
  /** 一開始站在哪一個來源 */
  defaultSource?: 'cardbook' | 'catalog'
  /**
   * 這顆挑卡器就長在「登記卡片」那一頁上嗎？
   *
   * 空狀態的出路裡有一條是「去登記一張卡」→ `/me/cards/upload`。
   * 在登記頁上那條連結指的就是使用者正踩著的那一頁：按下去畫面不會變，
   * 他只會以為連結壞了（open-pool-walkthrough P9）。
   * 由呼叫端告知，不由元件自己讀 route —— 元件不該知道自己被掛在哪條路徑上，
   * 而且同一頁未來也可能掛第二顆挑卡器。
   */
  onUploadPage?: boolean
}>(), { modelValue: () => [], max: 60, defaultSource: 'cardbook', onUploadPage: false })

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
/**
 * 預設站在**有東西可以立刻點**的那一邊。
 *
 * 開池表單不帶 defaultSource，所以走預設值 'cardbook' —— 那一頁一進去
 * 就列得出卡、點得到。目錄那一頁不打字是**整片空白**，
 * 站在那裡的使用者只會以為「這裡沒有卡」。
 * （卡片登記頁刻意傳 'catalog'：要登記的卡照定義還不在卡冊裡。）
 */
const source = ref<'cardbook' | 'catalog'>(props.defaultSource)

/** 使用者自己按過分頁鍵。按過之後就不再自動幫他換 —— 那會變成搶方向盤 */
const sourcePinned = ref(false)
function chooseSource(s: 'cardbook' | 'catalog') {
  sourcePinned.value = true
  source.value = s
}

/* ---------- 來源一：我的卡冊 ---------- */
/* 分頁交給既有的 useInfiniteList —— 卡冊本來就是游標分頁的，
   在這裡自己再寫一份捲動載入等於把「請求競態、重複觸發、卸載要斷開」
   那三個坑再踩一次。 */
/**
 * 挑得到的是 **in_book，而且只有 in_book**。
 *
 * 判準只有一條：**這張實體卡現在有沒有被別的承諾綁著。**
 * 押進池等於對外宣告「這張卡會照抽選結果交出去」，所以它必須是一張
 * 現在沒有欠任何人任何事的卡。八個狀態逐一對這一條：
 *
 *   in_book        ✔ 自己登記的、接管來的、或上一個池結束解押回來的。
 *                    沒有未結的義務，實體也在自己手上 —— 唯一過關的。
 *   in_pool        ✘ 已經押在另一個池裡。押第二次就是一卡兩賣。
 *   listed         ✘ 掛在市場上等買家。成交與開池同時發生就是一卡兩賣。
 *   stashed        ✘ 「抽中後寄存在平台」。它背著一個還沒結的結算：
 *                    買家隨時可以按買回、也可以申請出貨，那筆保留額還在。
 *                    拿它當新池的獎品等於把同一張卡承諾給兩個人。
 *                    （**這正是原本寫死的那個值** —— 而且新賣家根本不會有。）
 *   ship_requested ✘ 出貨流程進行中，實體正要離開。
 *   shipped        ✘ 已經寄到擁有者手上。卡是他的、實體也在他手上，
 *                    但那一列的結算已經結案，系統再也追蹤不到它的去向；
 *                    要拿它開池的正確做法是重新登記（或接管）成 in_book。
 *   recycled       ✘ 已經賣回平台，不是自己的卡了。
 *   refunded       ✘ 賣家違約退款，卡從來沒有離開賣家。
 *
 * 這條判準跟後端是**同一條**，不是各寫一份：routes/pools.ts 的建池押記
 * 只重用 `user_id = 我 且 status = 'in_book'` 的那一列，其餘一律回
 * CARD_BUSY / CERT_ALREADY_LISTED。挑選器列出 in_book 以外的卡，
 * 等於讓人挑一張**送出去必定被擋**的卡。
 */
const book = useInfiniteList<UserPrize>((cursor, signal) =>
  api.myPrizes({ cursor, signal, status: 'in_book' }))
/* 模板的字串 ref 要綁到 setup 的頂層 binding；巢狀在物件裡的 ref 綁不到 */
const bookSentinel = book.sentinel

/** 卡冊確定是空的（載完了、沒有錯誤、零張）。載入中不算 —— 那還沒有結論 */
const bookEmpty = computed(() =>
  book.ready.value && !book.error.value && !book.items.value.length)

/**
 * 卡冊空的時候自動落到目錄。
 *
 * 為什麼要自動：卡冊是空的時候，「從我的卡冊挑」是一條**確定走不通**的路，
 * 把使用者留在那裡等於讓他自己去發現另一個分頁存在。
 * 為什麼只做一次、而且只在他還沒自己選過的時候做：他手動切回卡冊
 * （例如正要去登記卡片、想先看一眼）時再把他推走，就是跟他搶方向盤。
 */
watch(bookEmpty, empty => {
  if (empty && !sourcePinned.value && source.value === 'cardbook') source.value = 'catalog'
}, { immediate: true })

/* ---------- 來源二：卡片目錄 ---------- */
const query = ref('')
const hits = ref<CatalogHit[]>([])
const hiddenNoArt = ref(0)
/* 這一次是用哪一個欄位查到的、以及英文名繞路對到了誰。
   **一定要顯示**：使用者打 'Charizard' 拿到一整排日文卡名，
   不講清楚「我是用全國圖鑑編號對到這隻寶可夢的」就等於在變魔術。 */
const field = ref<SearchField>('name-ja')
const bridge = ref<SearchResult['bridge']>(null)
const truncated = ref(0)
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
    field.value = r.field
    bridge.value = r.bridge
    truncated.value = r.truncated
  } catch (e) {
    if (my !== gen || ac.signal.aborted) return
    hits.value = []
    hiddenNoArt.value = 0
    bridge.value = null
    truncated.value = 0
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
    bridge.value = null
    truncated.value = 0
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

/**
 * 「我是用什麼幫你找到的」。
 *
 * 搜尋跨了四個欄位又會自動往下掉（見 lib/tcgdex-catalog.ts 的 resolve），
 * 不說一聲的話使用者無從判斷結果對不對 —— 尤其英文名那條路回的是
 * 「同一隻寶可夢的所有日版卡」，不是「同一張卡」。
 */
const foundBy = computed<string | null>(() => {
  if (!hits.value.length) return null
  switch (field.value) {
    case 'card-no': return `用卡號找到 ${hits.value.length} 張`
    case 'set':     return `列出「${query.value.trim().toUpperCase()}」這一套的 ${hits.value.length} 張`
    case 'name-en': return bridge.value
      ? `英文名「${bridge.value.enName}」對到全國圖鑑編號 ${bridge.value.dexId}，`
        + `以下是這隻寶可夢的日版卡 ${hits.value.length} 張（不是同一張卡的英文名）`
      : null
    default:        return null
  }
})

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

/* ---------- 已選清單的合併顯示 ---------- */
/**
 * 為什麼要合併：從卡冊挑的每一張都是**不同的實體卡**（不同 prizeId），
 * 挑三張同款的水伊布 ex 就會排出三列一模一樣的東西，看起來像系統出錯。
 * 但合併只能是**畫面上的事** —— 底下的 PickedCard[] 一張都不能少，
 * 移除也必須真的移除其中某一張實體卡。
 *
 * 規則本身住在 lib/card-merge.ts（卡冊的上架選取用的是同一份）：
 * 「有鑑定編號的卡永遠不合併」與「變體要進鍵」這兩條，兩個畫面必須一致，
 * 抄成兩份遲早會各自漂移。
 */
type PickGroup = MergeGroup<PickedCard>
const groups = computed<PickGroup[]>(() => mergeByCard(picked.value, p => p.card))

/** 移除這一組裡**最後挑進來的那一張**。手誤多按一下時，撤銷的就該是剛剛那一下 */
function removeOne(g: PickGroup) {
  remove(g.members[g.members.length - 1])
}

/* ---------- 已選清單的開合 ---------- */
/**
 * 為什麼已選清單不常駐：挑卡的當下要看的是**還沒挑的卡**，已經挑好的
 * 只需要一個「幾張」的數字；細節要看的時候再展開就好。常駐的縮圖格就算
 * 壓到 197px，也是永遠橫在挑卡器與底下的表單之間，把「獎項配置」「買回價」
 * 推得更遠。改成：有選卡才浮出一條列（只有數字），點開才是清單。
 */
const chosenOpen = ref(false)
function closeChosen() { chosenOpen.value = false }

/* 桌機（≥900px）用 inline 的 sticky 列而不是從視窗下緣飛進來的浮列：
   900 是開池頁換成兩欄版面的斷點，右欄那份試算與送出鈕本來就一直看得到，
   再讓一條列橫過整個視窗只是噪音。用 inline 而不是整條關掉，
   是因為「已選幾張」在桌機一樣需要一個固定的位置，而且這樣任何寬度下
   畫面上都**只會有一條**這種列。 */
const wide = useMediaQuery('(min-width: 900px)')

/* 移到剩零張時面板自己收掉：一個空的「已選的卡」面板沒有東西可看，
   而它底下那條列也已經跟著消失，關不掉就變成孤兒 */
watch(() => picked.value.length, n => { if (!n) chosenOpen.value = false })

/* Esc 關面板。面板是 Teleport 到 body 的，焦點不一定落在裡面，
   所以監聽掛在 window 上而不是面板節點上 */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && chosenOpen.value) closeChosen()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

/** 鑑定編號的尾碼。合併不掉的兩張同款卡靠這個分辨，不然畫面上看起來一樣就像出錯 */
const certTail = (p: PickedCard) => certTailOf(p.card)

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
        :aria-selected="source === 'cardbook'" @click="chooseSource('cardbook')">
        從我的卡冊挑
        <!-- 張數直接寫在分頁上：使用者要決定「往哪一邊走」，
             靠的就是「那一邊有沒有東西」，不該切過去才知道 -->
        <span v-if="book.ready.value" class="tabCount">{{ book.items.value.length }}</span>
      </button>
      <button
        type="button" role="tab" class="tab" :class="{ on: source === 'catalog' }"
        :aria-selected="source === 'catalog'" @click="chooseSource('catalog')">
        搜卡片目錄
      </button>
    </div>

    <p v-if="atMax" class="note warn">已達上限 {{ max }} 張，要再加請先移除。</p>

    <!-- ---------- 卡冊 ---------- -->
    <section v-show="source === 'cardbook'" class="pane">
      <div v-if="!book.ready.value" class="grid" aria-hidden="true">
        <span v-for="i in 6" :key="i" class="skel"></span>
      </div>

      <p v-else-if="!book.items.value.length && !book.error.value" class="empty">
        卡冊裡沒有可以開池的卡。<br>
        <!-- 空狀態要說的是**真正的判準**。原本這裡寫「只有寄存中的卡能當獎品」，
             而寄存中指的是「從別人的池抽中、寄放在平台」——
             一個剛登記完自己的卡的人看到這句話，只會覺得系統在說謊。 -->
        <span class="muted">
          能當獎品的是「閒置在卡冊」的卡。押在別的池裡、掛在市場上、
          在出貨流程中、或抽中後寄存在平台的卡都不能再承諾給第二個人。
        </span><br>
        <!-- 空清單一定要接出路。沒有出路的空狀態就是一條死路。
             但在登記頁上「去登記一張卡」指回這一頁本身，那不是出路，是原地打轉 ——
             那時真正的下一步是右邊那個分頁（目錄），所以只留那一條。 -->
        <RouterLink v-if="!onUploadPage" class="emptyGo" :to="{ name: 'upload-card' }">去登記一張卡</RouterLink>
        <button type="button" class="emptyGo" @click="chooseSource('catalog')">改用卡片目錄搜</button>
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
              <!-- 自己登記進卡冊的卡沒有賞別（tier 是 null）。那不是缺資料，
                   是它沒進過池 —— 角標整顆不畫，不要畫一顆空的 -->
              <span v-if="p.tier" class="tierTag" :class="`t-${p.tier.toLowerCase()}`">{{ p.tier }}</span>
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
          placeholder="卡號 SV4a-349、349/190，或卡名"
          aria-label="搜尋卡片目錄">
      </label>
      <!-- 支援什麼就寫什麼。原本這一行只寫「日文卡名查得最準」，
           而使用者的回饋正是「搜索是要輸入日文，沒辦法用別的方式？」——
           能用卡號搜卻沒有人講，等於這個功能不存在。 -->
      <div class="hintLine">
        <p class="hintHead muted">四種搜法都可以，至少輸入兩個字：</p>
        <ul class="hintList">
          <li><b class="mono">SV4a-349</b><span>卡號（大小寫、空白、補零都可以）</span></li>
          <li><b class="mono">349/190</b><span>卡面印的編號／總數</span></li>
          <li><b class="mono">Charizard</b><span>英文寶可夢名（對到同一隻的日版卡）</span></li>
          <li><b>リザードン</b><span>日文卡名，查得最準</span></li>
        </ul>
      </div>

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
          卡號、英文寶可夢名、日文卡名都試過了。<br>
          卡號要帶套牌代號才認得出是哪一套（<b class="mono">SV4a-349</b>）；
          英文名只對得到寶可夢，訓練家卡與能量卡沒有圖鑑編號，對不到；
          日文卡名只打寶可夢的名字、不要帶 ex / SAR 這種後綴。
          <template v-if="hiddenNoArt">（另有 {{ hiddenNoArt }} 張同名卡沒有卡圖，無法用挑的）</template>
        </span><br>
        <!-- 出路。**卡冊空的時候不能叫人切回卡冊** —— 那是一條已知走不通的路；
             那時唯一有意義的下一步是先去登記一張卡。
             但在登記頁上那條連結指回這一頁本身，等於一條連到自己的死連結。
             那裡不需要連結：使用者要做的事就在同一個畫面上（上面那個搜尋框），
             所以改成一句話講清楚「你已經在對的地方了，往上打字」。 -->
        <RouterLink v-if="bookEmpty && !onUploadPage" class="emptyGo" :to="{ name: 'upload-card' }">
          去登記一張卡（登記完就會出現在卡冊）
        </RouterLink>
        <span v-else-if="bookEmpty" class="emptyHere">
          你已經在登記卡片的頁面上了 —— 在上面的搜尋框打卡號或卡名，挑到那張卡就能往下登記。
        </span>
        <button v-else type="button" class="emptyGo" @click="chooseSource('cardbook')">
          改從我的卡冊挑<template v-if="book.ready.value">（{{ book.items.value.length }} 張）</template>
        </button>
      </p>

      <!-- 還沒打字。原本這裡**什麼都沒有** —— 一個搜尋框加一大片空白，
           使用者以為那裡會列卡片可以點，結果一張都沒選到。
           空白狀態要說「這裡要你做什麼」，還要留一條回卡冊的路。 -->
      <p v-else-if="!searched && !query.trim()" class="empty" data-testid="catalog-idle">
        這裡是<b>整個日版卡片目錄</b>，要先搜才會有東西 —— 不打字是空的，不是壞掉。<br>
        <span class="muted">上面四種寫法任一種都可以，不一定要打日文。</span><br>
        <!-- 出路。**卡冊空的時候不能叫人切回卡冊** —— 那是一條已知走不通的路；
             那時唯一有意義的下一步是先去登記一張卡。
             但在登記頁上那條連結指回這一頁本身，等於一條連到自己的死連結。
             那裡不需要連結：使用者要做的事就在同一個畫面上（上面那個搜尋框），
             所以改成一句話講清楚「你已經在對的地方了，往上打字」。 -->
        <RouterLink v-if="bookEmpty && !onUploadPage" class="emptyGo" :to="{ name: 'upload-card' }">
          去登記一張卡（登記完就會出現在卡冊）
        </RouterLink>
        <span v-else-if="bookEmpty" class="emptyHere">
          你已經在登記卡片的頁面上了 —— 在上面的搜尋框打卡號或卡名，挑到那張卡就能往下登記。
        </span>
        <button v-else type="button" class="emptyGo" @click="chooseSource('cardbook')">
          改從我的卡冊挑<template v-if="book.ready.value">（{{ book.items.value.length }} 張）</template>
        </button>
      </p>

      <template v-else-if="hits.length">
        <!-- 用什麼欄位找到的要講出來，尤其英文名那條路回的是「同一隻寶可夢」 -->
        <p v-if="foundBy" class="foundBy" data-testid="found-by">{{ foundBy }}</p>
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
        <p v-if="truncated" class="note muted">
          還有 {{ truncated }} 張沒有列出來（一次最多列 120 張）。再打細一點，例如加上卡號。
        </p>
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

    <!-- 已選的卡：貼底列只報數字，清單在面板裡。
         列的內容刻意只有一行 —— 它跟池頁的購買列一樣是「隨時看得到的狀態」，
         塞進縮圖就等於把常駐清單搬到下緣，一點都沒省。 -->
    <BottomActionBar
      :open="picked.length > 0"
      label="已選的卡"
      :inline="wide"
      :spacer="84"
      :max-width="560"
    >
      <div class="pickBar">
        <span class="pickBarSum">
          <strong>已選 {{ picked.length }} 張</strong>
          <span v-if="max" class="muted">上限 {{ max }}</span>
        </span>
        <button type="button" class="btn pickBarBtn" @click="chosenOpen = true">
          查看清單
        </button>
      </div>
    </BottomActionBar>

    <!-- 清單面板。跟詳情面板同樣要 Teleport 到 body（祖先的 transform 會變成
         position:fixed 的定位基準），也共用同一組 .sheetWrap / .sheet 視覺。
         關法三種：點遮罩、右上角關閉鍵、Esc。 -->
    <Teleport to="body">
      <div v-if="chosenOpen" class="sheetWrap" @click.self="closeChosen">
        <div class="sheet" role="dialog" aria-modal="true" aria-label="已選的卡">
          <button type="button" class="close" aria-label="關閉" @click="closeChosen">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>

          <p class="chosenHead">
            <span>已選 {{ picked.length }} 張</span>
            <span v-if="max" class="muted">上限 {{ max }}</span>
          </p>
          <p class="sheetWhy muted">點一張卡＝移除一張。同一款卡合併成 ×N；有鑑定編號的卡各自獨立，不合併。</p>

          <!-- 版面是**縮圖格狀**不是一張一列：一列一張時 14 張就要 832px、
               60 張要 3587px，在面板裡一樣捲不完；而且挑選這件事本來就是
               用卡圖認卡的，卡名那一行吃掉整個寬度卻沒多說什麼。 -->
          <ul class="picks">
            <li v-for="g in groups" :key="g.key" class="pickCell">
              <!-- 整張縮圖就是移除鍵：叉叉只畫成一顆小的角標，真正可按的範圍是
                   整格（最窄也有 56×78），遠超過 44px 的觸控下限，
                   又不必為了那顆叉叉在格子裡挖掉一塊空間 -->
              <button
                type="button" class="pickTile"
                :aria-label="g.members.length > 1
                  ? `移除一張 ${g.head.card.name}，目前 ${g.members.length} 張`
                  : `移除 ${g.head.card.name}`"
                @click="removeOne(g)">
                <span class="pickArt">
                  <img
                    v-if="g.head.artUrl" :src="g.head.artUrl" :alt="g.head.card.name"
                    loading="lazy" decoding="async">
                  <span v-else class="pickPh" aria-hidden="true">{{ g.head.card.name }}</span>
                  <span class="pickX" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </span>
                  <!-- 鑑定編號尾碼。有編號的卡不會被合併，兩張同款卡並排時
                       沒有這個標就真的看不出差別 -->
                  <span v-if="certTail(g.head)" class="pickCert mono">{{ certTail(g.head) }}</span>
                  <span v-if="g.members.length > 1" class="pickQty">×{{ g.members.length }}</span>
                </span>
              </button>
            </li>
          </ul>

          <button type="button" class="btn primary wide" @click="closeChosen">完成</button>
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
  /* 44px 是全站的觸控下限（touch.css 的門檻）。原本 padding 撐出來只有 40px */
  min-height: 44px;
  border: 0; background: transparent; color: var(--muted);
  font-size: 13.5px; font-weight: 600;
  padding: 10px 8px; border-radius: var(--pill);
  transition: background .18s, color .18s;
}
.tab.on { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-sm); }
/* 卡冊有幾張直接寫在分頁上：要選走哪一邊，靠的就是「那一邊有沒有東西」 */
.tabCount {
  display: inline-block; margin-left: 6px; padding: 1px 7px;
  border-radius: var(--pill); background: var(--surface-3); color: var(--muted);
  font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
}
.tab.on .tabCount { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }

/* ---- 已選：貼底列 ---- */
/* 一行兩塊：左邊是狀態（幾張／上限），右邊是唯一的動作。
   兩塊之間用 auto 欄寬而不是 space-between，卡數變成三位數時
   按鈕才不會跟著左右跳。 */
.pickBar {
  min-width: 0;
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: center; gap: 12px;
}
.pickBarSum {
  min-width: 0; display: flex; align-items: baseline; gap: 8px;
  font-size: 13.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pickBarSum .muted { font-size: 12px; }
.pickBarBtn { flex: none; min-height: 44px; padding: 10px 16px; font-size: 13.5px; }

/* ---- 已選：面板裡的清單 ---- */
.chosenHead {
  min-width: 0; margin: 0;
  display: flex; align-items: baseline; gap: 10px;
  font-size: 15px; font-weight: 700;
  /* 右上角那顆關閉鍵是絕對定位的，標題自己要讓出那塊 */
  padding-right: 42px;
}
.chosenHead .muted { font-size: 12px; font-weight: 600; }
/* 縮圖格狀。auto-fill + minmax(0, 1fr) 讓一列塞得下幾張就塞幾張，
   手機約 5 張、桌機更多；欄寬給 minmax(0, …) 是這個 repo 的老規矩
   （預設 min-width: auto 會讓內容把格線撐破） */
.picks {
  min-width: 0; list-style: none; margin: 0; padding: 2px;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(54px, 1fr));
  gap: 8px;
}
/* 這一格**不再**自己設高度上限與捲動：清單現在住在 .sheet 裡，
   而 .sheet 本身就是 max-height + overflow:auto。再套一層內捲會變成
   兩個巢狀的捲動區 —— 手指在格子上滑動時到底捲哪一個要看落點，
   那是實測會讓人以為「捲不動」的東西。 */
.pickCell { min-width: 0; }
.pickTile {
  min-width: 0; width: 100%;
  display: block; padding: 0; border: 0; background: transparent;
  transition: transform .12s;
}
.pickTile:active { transform: scale(.94); }
.pickArt {
  position: relative; min-width: 0;
  display: block; aspect-ratio: 63 / 88;
  border-radius: 7px; overflow: hidden; background: var(--surface-3);
  box-shadow: var(--shadow-sm);
}
.pickArt img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pickPh {
  display: grid; place-items: center; width: 100%; height: 100%;
  padding: 4px; background: var(--surface-3); color: var(--muted);
  font-size: 9px; line-height: 1.3; text-align: center;
  overflow: hidden;
}
/* 叉叉只是「按了會移除」的提示，不是它自己要被瞄準 —— 可按範圍是整格 */
.pickX {
  position: absolute; right: 2px; top: 2px;
  width: 16px; height: 16px; border-radius: 50%;
  display: grid; place-items: center;
  background: rgba(0, 0, 0, .62); color: #fff;
}
.pickX svg { width: 9px; height: 9px; fill: none; stroke: currentColor; stroke-width: 3.2; stroke-linecap: round; }
.pickQty {
  position: absolute; right: 2px; bottom: 2px;
  min-width: 20px; padding: 1px 4px; border-radius: var(--pill);
  background: var(--accent); color: var(--on-accent);
  font-size: 10px; font-weight: 700; line-height: 1.5; text-align: center;
}
.pickCert {
  position: absolute; left: 2px; bottom: 2px;
  padding: 1px 3px; border-radius: 4px;
  background: rgba(0, 0, 0, .62); color: #fff;
  font-size: 8.5px; line-height: 1.5;
}

/* ---- 面板共用 ---- */
.pane { min-width: 0; display: grid; gap: 10px; }
.note { min-width: 0; margin: 0; font-size: 12px; line-height: 1.6; }
.note.warn { color: var(--warn-ink); }
.muted { color: var(--muted); }
.mono { font-family: var(--font-mono); }
/* ---- 「可以怎麼搜」 ----
   四種寫法一行一種，範例用等寬字體排在左邊、說明在右邊。
   寫成一整段散文的話沒有人會讀完，而這幾行的重點正是「照著打就會動」。 */
.hintLine { margin: 0; min-width: 0; }
.hintHead { margin: 0 0 5px; font-size: 11.5px; line-height: 1.6; }
.hintList {
  list-style: none; margin: 0; padding: 0; min-width: 0;
  display: grid; gap: 3px;
}
.hintList li {
  min-width: 0;
  display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  gap: 8px; align-items: baseline;
  font-size: 11.5px; line-height: 1.65;
}
.hintList b { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
.hintList span { color: var(--faint); min-width: 0; }

/* 找到之後說一句「我是用什麼找到的」。英文名那條路尤其要說 —— 回的是
   同一隻寶可夢的日版卡，不是同一張卡的英文名 */
.foundBy {
  min-width: 0; margin: 0 0 10px; padding: 8px 11px;
  border-radius: 10px; background: var(--surface-2);
  font-size: 11.5px; line-height: 1.7; color: var(--muted);
}

.empty {
  min-width: 0; margin: 0; padding: 26px 12px;
  text-align: center; font-size: 13px; line-height: 1.8;
}
.empty b { color: var(--ink); }
/* 空狀態裡的出路。空清單一定要有下一步，不然它就是死路 */
.emptyGo {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 44px; margin: 10px 5px 0; padding: 0 16px; min-width: 0;
  border: 1px solid var(--line); border-radius: var(--pill);
  background: var(--surface-2); color: var(--ink);
  font: inherit; font-size: 12.5px; font-weight: 600;
  text-decoration: none; cursor: pointer;
}
.emptyGo:hover { border-color: var(--accent); color: var(--accent); }
/* 「你已經在對的地方了」。刻意**不做成按鈕的樣子**：它不是出路、按不動，
   長得像膠囊按鈕的東西按下去沒反應，比一條連到自己的連結還糟 */
.emptyHere {
  display: block; margin: 12px auto 0; max-width: 34em; min-width: 0;
  font-size: 12.5px; line-height: 1.8; color: var(--muted);
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
