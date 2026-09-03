<script setup lang="ts">
/**
 * 市場 —— 玩家之間直接買賣卡片，不經過抽選。
 *
 * 為什麼要有這一頁：抽選是碰運氣，但「我就是要這張」跟「我這張想出掉」
 * 是兩個真實需求。原本只有「回收給平台換 70% 點數」一條出口 ——
 * 那是保底價，不是市價。市場讓賣方自己定價、買方直接拿到指定卡。
 *
 * 成交幣別是點數，且點數永不可提現（見 lib/recycle.ts 的完整理由）。
 * 玩家互相買賣仍在站內閉環，這是整套合規論述的地基。
 *
 * 這一頁只負責「逛」。點任何一張卡都是進 /market/:id 由那一頁成交 ——
 * 購買原本是這裡的行內確認框，而那個框是渲染在主列表的那一格裡的：
 * 從上方的橫向捲軸點一張，確認框會跑到下面某一格去長出來；主列表改成
 * 游標分頁之後，那一格甚至可能還沒載入，點了完全沒有反應。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import { api, type MarketSort, type MarketGrader } from '@/lib/api'
import type { Listing } from '@/types/models'
import { deliveryOf } from '@/shared/domain'
import { useWalletStore } from '@/stores/wallet'
import { useAuthStore } from '@/stores/auth'
import CardArt from '@/components/CardArt.vue'
import OwnerTag from '@/components/OwnerTag.vue'
import TradeGuard from '@/components/TradeGuard.vue'
import ListSentinel from '@/components/ListSentinel.vue'
import { useInfiniteList } from '@/composables/useInfiniteList'
import RollingNumber from '@/components/RollingNumber.vue'
import { track } from '@/lib/ga'
import { refDiscount, refPriceText } from '@/lib/refprice'

const wallet = useWalletStore()
const auth = useAuthStore()

/* 這一頁原本完全不知道使用者是誰 —— 自己上架的卡跟別人的卡在列表上長得
   一模一樣，要點進去、按下購買、被後端擋掉（orders.ts 的「不能買自己的掛單」）
   才知道。整條路走到最後一步才擋，前面每一步都在騙人。

   比對 sellerId 而不是 sellerName：名字會重複，也可能被改。
   未登入時一律 false —— 那時候根本沒有「你」，訪客不該看到任何個人化痕跡。 */
const isMine = (l: Listing) => !!auth.user && l.sellerId === auth.user.id

/* ---- 搜尋 ----

   「有一張很明確想收的卡」是買家來市場的第一個動作，而這一頁原本只能用捲的。
   排序解不了它：捲到第 8 批才看到那張卡，跟沒有一樣。

   搜尋一定要打後端（api.listMarket 會把 q 帶下去）。前端過濾只濾得到
   已載入的那一批 —— 搜「伊布」看到 2 筆而市場上有 15 筆，另外 13 筆
   在還沒載入的批次裡。那不是不方便，是**錯的答案**，而且畫面上看不出來。

   系列篩選（setCode）沒有另外做一個選單：使用者說的「伊布家族」是一個主題，
   它的卡散在 sv8a、sv3、sv6 好幾個 setCode 裡，選單解不了他的需求；
   反過來，真的要按系列看的人打 `sv8a` 就有 —— 後端的搜尋欄位含 setCode。 */
const route = useRoute()
const router = useRouter()

/** 輸入框最大字數。後端上界是 80，這裡收得更緊：卡名沒有這麼長 */
const Q_MAX = 40
/** 去抖動間隔。連續打字時只有停下來之後才會送出一次請求 */
const DEBOUNCE_MS = 300

/** 使用者正在打的字（每一鍵都會變） */
const draft = ref(typeof route.query.q === 'string' ? route.query.q : '')
/** 真正送去查詢的關鍵字（去抖動之後才會變）。分成兩個 ref 是去抖動的全部意義 */
const q = ref(draft.value.trim())
/** 打完了但還沒送出去的那段空窗。這一段也要顯示忙碌狀態，否則使用者以為沒反應 */
const pending = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

function commit(value: string) {
  if (timer) { clearTimeout(timer); timer = null }
  pending.value = false
  q.value = value.trim()
}

watch(draft, v => {
  if (timer) clearTimeout(timer)
  // 打到跟目前查詢一樣的字（例如刪掉又打回來）不必再排一次
  if (v.trim() === q.value) { timer = null; pending.value = false; return }
  pending.value = true
  timer = setTimeout(() => commit(v), DEBOUNCE_MS)
})

/** Enter 直接送出，不等剩下的去抖動 —— 使用者已經表示打完了 */
const submitNow = () => commit(draft.value)
/* 打進金額框的非數字當場消失（連 e、+、- 都進不去）。
   要順手把 el.value 也寫回去：只綁 :value 的話，輸入 'a' 之後草稿仍是空字串、
   沒有變化就不會重繪，那個 'a' 會留在畫面上不走。 */
function onPriceInput(e: Event, which: 'min' | 'max') {
  const el = e.target as HTMLInputElement
  const v = digitsOnly(el.value)
  el.value = v
  if (which === 'min') minDraft.value = v
  else maxDraft.value = v
}
const clearSearch = () => { draft.value = ''; commit('') }

onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

/* 排序。低於市值放第一個 —— 那是使用者真正在找的東西。 */
type Sort = MarketSort
const sort = ref<Sort>('deal')
const SORTS: { k: Sort; label: string }[] = [
  { k: 'deal', label: '低於市值' },
  { k: 'new', label: '最新上架' },
  { k: 'cheap', label: '價格低到高' },
  { k: 'pricey', label: '價格高到低' }
]

/* ---- 篩選：卡片等級與點數區間 ----

   ── 為什麼不是再鋪兩排膠囊 ──

   這一頁的控制區原本只有一種語意（排序），四顆膠囊、一種視覺編碼。
   直接把「等級」與「點數」也做成膠囊鋪上去，會變成同一片區域裡三種語意
   長得一模一樣，而且選中狀態互相搶眼 —— 卡冊的控制列剛因為這件事被說「有點亂」。

   所以篩選收進一塊要按才展開的面板，控制列上只多一顆按鈕（不是兩排選項）：
   排序仍然是「圓角實心膠囊」，篩選鍵是「方角描邊、生效時只上淡色底」，
   形狀與顏色都不同，掃過去分得出哪個是哪個。面板裡的選項也刻意用方角磚，
   不重複排序膠囊的形狀。

   ── 為什麼等級是「鑑定公司 ＋ 分數下限」兩格 ──

   卡片上的等級是兩個欄位：grader（PSA / BGS / ARS / RAW）與 grade（10、9.5、9…），
   而且 **PSA 10 與 BGS 10 不是同一件事**，不能只留分數。但把兩者相乘列成
   逐級選項（4 家 × 10 級）在 393px 上放不下，實際資料又極稀疏，
   使用者會看到一整排永遠 0 筆的選項。拆成兩格之後 PSA 10 仍然表達得出來，
   而「不分家、9.5 以上」這種真實需求反而只有拆開才講得出來。

   RAW（未鑑定）是一個真實的類別而不是「沒有值」：想撿便宜的人專挑它，
   只要鑑定過的人要排除它，所以「未鑑定」與「已鑑定」都是明確的選項。

   刻意不用 tier（賞別）：那是「這張卡在某個池裡是第幾賞」，是池的屬性
   不是卡的屬性，同一張卡在不同池是不同賞。卡冊那條線已經為此砍過賞別排序。 */
type GraderFilter = MarketGrader
const GRADER_OPTS: { k: GraderFilter; label: string }[] = [
  { k: 'raw', label: '未鑑定' },
  { k: 'graded', label: '已鑑定' },
  { k: 'psa', label: 'PSA' },
  { k: 'bgs', label: 'BGS' },
  { k: 'ars', label: 'ARS' }
]
const GRADER_LABEL = (k: GraderFilter) => GRADER_OPTS.find(o => o.k === k)?.label ?? k
/* 只有下限沒有上限：「9.5 分以上」是真實需求，「9.5 分以下」不是 ——
   沒有人在找比較差的卡。 */
const GRADE_OPTS = [9, 9.5, 10]

/**
 * 點數輸入的上界。跟後端 server/src/limits.ts 的 POINTS_INPUT_MAX 是同一個數字
 * （十億），兩邊要一起改。
 *
 * 前端這一道只是**提前告知**：輸入框當場說「上限是十億點」，
 * 比送出去等後端回 400 少一趟往返。真正的防線在後端 —— 網址是可以自己打的，
 * 前端擋不到直接組 URL 的人。
 */
const PRICE_MAX = 1_000_000_000

const grader = ref<GraderFilter | null>(null)
const minGrade = ref<number | null>(null)
const minPrice = ref<number | null>(null)
const maxPrice = ref<number | null>(null)
const panelOpen = ref(false)

/* 金額輸入框的草稿。跟搜尋同一套去抖動：每打一個數字就送一次請求，
   打「10000」會發五次，而中間那四次的答案沒有人想知道。 */
const minDraft = ref('')
const maxDraft = ref('')
let priceTimer: ReturnType<typeof setTimeout> | null = null

/** 只留數字：非數字連打都打不進去，畸形輸入在這一層就不存在（後端仍然自己驗） */
const digitsOnly = (s: string) => s.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 13)
const numOf = (s: string) => (s === '' ? null : Number(s))

/** 超出上界或上下顛倒時當場說出來，而不是送一趟請求換一句錯誤 */
const priceNote = computed(() => {
  const lo = numOf(minDraft.value), hi = numOf(maxDraft.value)
  if ((lo !== null && lo > PRICE_MAX) || (hi !== null && hi > PRICE_MAX)) {
    return `點數上限是 ${PRICE_MAX.toLocaleString()} 點`
  }
  if (lo !== null && hi !== null && lo > hi) return '最低點數不能高於最高點數'
  if (lo === 0 || hi === 0) return '點數要大於 0'
  return ''
})

function commitPrice() {
  if (priceTimer) { clearTimeout(priceTimer); priceTimer = null }
  // 有問題的組合不送出去：送了只會拿回 400，把一個「還沒打完」講成錯誤
  if (priceNote.value) return
  minPrice.value = numOf(minDraft.value)
  maxPrice.value = numOf(maxDraft.value)
}
watch([minDraft, maxDraft], () => {
  if (priceTimer) clearTimeout(priceTimer)
  priceTimer = setTimeout(commitPrice, DEBOUNCE_MS)
})

/* 未鑑定的卡沒有分數，兩個一起選是矛盾的（後端會回 400）。
   這裡直接把分數清掉而不是讓使用者送出一個必定失敗的組合 ——
   面板上那一段也會跟著收起來，看得到「這裡沒有東西可選」。 */
watch(grader, g => { if (g === 'raw') minGrade.value = null })

/* 符合關鍵字的**全市場**筆數，由後端在第一批一起回。
   為什麼不自己數 listings.length：那是「已經載進來幾筆」，正是這個功能
   要避免的那個錯誤答案。null＝沒有在搜尋，或這一批還沒回來。 */
const matched = ref<number | null>(null)

/* 掛單分批載入，排序與搜尋都在後端。
   排序不能留在前端：分批之後前端只排得到已載入的那幾筆，捲一頁就整個重排，
   已經看過的卡片會在眼前跳位。這跟卡冊的狀態分頁是同一個問題。 */
/** 這一次查詢的全部條件。排序不算在裡面 —— 它換的是順序不是集合 */
const params = computed(() => ({
  q: q.value || undefined,
  grader: grader.value ?? undefined,
  minGrade: minGrade.value ?? undefined,
  minPrice: minPrice.value ?? undefined,
  maxPrice: maxPrice.value ?? undefined
}))
/** 條件的指紋。用來擋過期回應、也用來決定什麼時候要重新查 */
const queryKey = computed(() => JSON.stringify(params.value))

const list = useInfiniteList<Listing>(async (cursor, signal) => {
  /* 發出去的當下是哪一組條件要記住：回應晚於下一次輸入時，
     用它擋掉過期的筆數（清單本身由 composable 的世代編號擋）。 */
  const asked = queryKey.value
  const page = await api.listMarket({ cursor, signal, sort: sort.value, ...params.value })
  if (cursor === null && asked === queryKey.value) matched.value = page.total ?? null
  return page
})
const sentinelRef = list.sentinel
const listings = list.items
const loading = computed(() => list.loading.value && !list.ready.value)
/** 有沒有事情正在進行：去抖動的空窗也算，不然按下第一個鍵之後畫面像沒反應 */
const busy = computed(() => pending.value || list.loading.value)

const gridRef = ref<HTMLElement | null>(null)
/* 換排序或換關鍵字＝換一組查詢：游標歸零、清空既有清單，過期的回應由
   composable 擋掉。同時把清單頂端捲回視野：整批換掉之後停在原本的捲動位置，
   會落在一個只剩第一批的短清單底部，哨兵當場又在範圍內 —— 使用者沒有捲動，
   卻會看到後面幾批被一路抓下來。 */
function restart() {
  list.reset()
  const top = gridRef.value?.getBoundingClientRect().top ?? 0
  if (top < 0) gridRef.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
/** 網址參數 → 狀態。看不懂的值一律當成沒給，不要拿它去查一個沒人要的東西 */
const oneOf = (v: unknown) => (typeof v === 'string' ? v : '')
function readQuery() {
  const s = oneOf(route.query.q).trim()
  if (s !== q.value) { draft.value = s; commit(s) }

  /* 排序也跟著進出網址。它不是「條件」（換的是順序不是集合），但分享連結
     要重現的是「我看到的那一頁」—— 條件帶得走、排序帶不走的話，
     收到連結的人看到的順序跟寄件人不一樣，而畫面上沒有任何跡象。 */
  const so = oneOf(route.query.sort)
  sort.value = SORTS.some(x => x.k === so) ? (so as Sort) : 'deal'

  const g = oneOf(route.query.grader).toLowerCase()
  grader.value = GRADER_OPTS.some(o => o.k === g) ? (g as GraderFilter) : null

  const mg = Number(oneOf(route.query.minGrade))
  minGrade.value = GRADE_OPTS.includes(mg) ? mg : null

  /* 金額只收純數字：網址是人手打得出來的，'1e308' 這種東西不要讓它進到狀態裡
     （後端有自己的防線，但前端也沒必要拿它去查一次） */
  const money = (v: unknown) => {
    const t = digitsOnly(oneOf(v))
    const n = numOf(t)
    return n !== null && n > 0 && n <= PRICE_MAX ? n : null
  }
  minPrice.value = money(route.query.minPrice)
  maxPrice.value = money(route.query.maxPrice)
  if (minPrice.value !== null && maxPrice.value !== null && minPrice.value > maxPrice.value) {
    maxPrice.value = null
  }
  minDraft.value = minPrice.value === null ? '' : String(minPrice.value)
  maxDraft.value = maxPrice.value === null ? '' : String(maxPrice.value)
}
/* 從外面帶著條件進來（分享連結、上一頁）時要跟著走。
   自己 replace 造成的那一次會落在這裡但兩邊相等，是個空操作，不會迴圈。 */
watch(() => [route.query.q, route.query.grader, route.query.minGrade,
  route.query.minPrice, route.query.maxPrice, route.query.sort], readQuery)

/* 一進頁就先把網址上的條件讀進來。**要在 queryKey 的 watcher 之前** ——
   放在後面的話這一次讀取本身會被當成「條件變了」，跟 onMounted 的第一次載入
   疊成兩個請求，帶著篩選條件的分享連結每次都會白打一趟。 */
readQuery()

/* 條件與排序進網址：篩選後的結果要能貼給別人、能重新整理、能加書籤 ——
   關鍵字（?q=）已經是這樣，篩選沒有理由是另一套。
   用 replace 不用 push —— 去抖動之後每停一次就是一筆歷史紀錄的話，
   使用者按上一頁要按十幾次才離得開這一頁。
   預設值（sort=deal）不寫進去：乾淨的網址才看得出哪些是使用者真的挑過的。 */
function syncUrl() {
  const next: LocationQueryRaw = { ...route.query }
  for (const [k, v] of Object.entries(params.value)) {
    if (v === undefined || v === '') delete next[k]
    else next[k] = String(v)
  }
  if (sort.value === 'deal') delete next.sort
  else next.sort = sort.value
  void router.replace({ query: next })
}
watch(sort, () => { restart(); syncUrl() })
watch(queryKey, () => {
  matched.value = null
  restart()
  syncUrl()
})


/* ---- 目前生效的條件 ----
   「有沒有在篩選」必須看得出來，而且每一條都要能單獨拿掉：
   一整組一起清掉的話，使用者只是想放寬價格卻連等級一起沒了。 */
type Cond = { k: 'q' | 'grader' | 'minGrade' | 'price'; label: string; clear: () => void }
const conds = computed<Cond[]>(() => {
  const out: Cond[] = []
  if (q.value) out.push({ k: 'q', label: `關鍵字「${q.value}」`, clear: clearSearch })
  if (grader.value) {
    out.push({ k: 'grader', label: GRADER_LABEL(grader.value), clear: () => { grader.value = null } })
  }
  if (minGrade.value !== null) {
    out.push({ k: 'minGrade', label: `${minGrade.value} 分以上`, clear: () => { minGrade.value = null } })
  }
  if (minPrice.value !== null || maxPrice.value !== null) {
    const lo = minPrice.value?.toLocaleString(), hi = maxPrice.value?.toLocaleString()
    out.push({
      k: 'price',
      label: lo && hi ? `${lo} – ${hi} 點` : lo ? `${lo} 點以上` : `${hi} 點以下`,
      clear: () => { minDraft.value = ''; maxDraft.value = ''; commitPrice() }
    })
  }
  return out
})
/** 篩選鍵上的數字。搜尋不算 —— 它有自己的輸入框，算進來會讓使用者找不到那一條 */
const filterCount = computed(() => conds.value.filter(c => c.k !== 'q').length)
const filtering = computed(() => conds.value.length > 0)
function clearAll() {
  for (const c of [...conds.value]) c.clear()
}

/* 上方兩條橫向捲軸與總筆數講的是「整個市場」，不是「已經捲出來的那幾筆」——
   從已載入的清單挑會挑到假的第一名，所以獨立取一次。 */
const deals = ref<Listing[]>([])
const graded = ref<Listing[]>([])
const total = ref(0)

onMounted(async () => {
  list.reset()
  track('view_market')
  try {
    const h = await api.marketHighlights()
    deals.value = h.deals
    graded.value = h.graded
    total.value = h.total
  } catch { /* 精選區拿不到不該擋住主清單，那只是兩條輔助捲軸 */ }
})

/* 這筆走哪一條通道。推導的理由見 shared/domain.ts 的 deliveryOf ——
   放在共用層是因為列表徽章、詳情頁與 mock 的成交邏輯必須是同一個判斷。 */
const laneOf = deliveryOf

/** 掛價相對市值的折數。負數＝比市值便宜 */
// 沒有標示參考價就沒有折價幅度可言 —— 回 null，畫面不顯示那個標籤
const diffPct = (l: Listing) => { const d = refDiscount(l); return d == null ? null : Math.round(d * 100) }

/* ---- 分區 ----
   市場原本跟大廳一樣是單一格線，兩頁看起來幾乎一樣。
   買家來市場只有兩種意圖：「撿便宜」或「找特定的好貨」，
   所以先用這兩個意圖分區，剩下的才進全部清單。
   兩區的內容由 /listings/highlights 取（見上面的 onMounted）。 */

/* 已載入的掛單。只濾掉「剛剛在這一頁被買走的」—— 排序已經由後端排好，
   這裡再排一次會把跨批次的順序打亂。 */
const shown = computed(() => listings.value.filter(l => l.status === 'live'))

/* ---- 查無結果時：是哪一個條件擋掉的 ----

   同時開了三個條件卻一片空白時，使用者唯一能做的事是把條件一個一個拿掉重試 ——
   那是我們該替他做的。每個條件各問一次「只拿掉這一個會有幾件」（limit=1，
   要的只是 total 那個數字），就能直接說「只放寬價格就有 12 件」。

   為什麼問得起：只在「已經是 0 件」時才問，最多四個條件四次請求，
   而且每次只要一筆。平常逛市場一次都不會發。

   為什麼不自己在前端算：這頁只有已載入的那一批，算出來的答案正是這整個
   功能要避免的那種「看起來很合理的錯數字」。 */
const hints = ref<{ label: string; n: number; clear: () => void }[]>([])
let hintGen = 0

async function diagnose() {
  const my = ++hintGen
  const cs = conds.value
  // 只有一個條件時不必問：擋掉結果的就是它，畫面直接講出來
  if (cs.length < 2) { hints.value = []; return }
  const out: { label: string; n: number; clear: () => void }[] = []
  for (const c of cs) {
    const p: Record<string, unknown> = { ...params.value }
    if (c.k === 'price') { delete p.minPrice; delete p.maxPrice }
    else delete p[c.k]
    try {
      const r = await api.listMarket({ ...p, limit: 1, sort: sort.value })
      // 條件全部拿掉時後端不回 total（那就是整個市場），用精選區那個數字補
      const n = r.total ?? total.value
      if (n > 0) out.push({ label: c.label, n, clear: c.clear })
    } catch { /* 診斷問不到不該蓋掉「查無結果」本身，那才是使用者要看的 */ }
  }
  if (my === hintGen) hints.value = out.sort((a, b) => b.n - a.n)
}

watch([() => list.ready.value, shown, queryKey], () => {
  hintGen++            // 條件一變，上一輪的診斷就過期了
  hints.value = []
  if (list.ready.value && !list.loading.value && shown.value.length === 0 && conds.value.length) {
    void diagnose()
  }
})
</script>

<template>
  <div class="container page">
    <header class="head">
      <div>
        <h1>市場</h1>
        <p class="muted sub">玩家直接買賣，不用碰運氣</p>
      </div>
      <RouterLink :to="{ name: 'cards' }" class="sell">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        我要上架
      </RouterLink>
    </header>

    <!-- 搜尋：放在排序上面。買家「我就是要這張」的意圖比「怎麼排」更前面，
         而且排序膠囊是可以左右滑的，把搜尋擠進那一排會被滑走看不見 -->
    <form class="search" role="search" @submit.prevent="submitNow">
      <svg class="mag" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" />
      </svg>
      <input
        v-model="draft"
        class="qbox"
        type="search"
        :maxlength="Q_MAX"
        enterkeyhint="search"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder="搜尋卡名、系列或卡號"
        aria-label="搜尋掛單"
      />
      <!-- 忙碌指示跟清除鍵佔同一格：兩個都出現會把輸入框擠窄，
           而且「還在查」跟「清掉」不是同時想做的事 -->
      <span v-if="busy && draft" class="ring" aria-hidden="true"></span>
      <button v-else-if="draft" type="button" class="clear" aria-label="清除搜尋" @click="clearSearch">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </form>

    <!-- 控制列：一顆篩選鍵 ＋ 排序膠囊，同一列。
         篩選沒有鋪成第二排選項，是因為那會讓「排序」與「篩選」在同一片區域裡
         長得一模一樣（卡冊的控制列剛因為這件事被說「有點亂」）。
         這裡的視覺編碼刻意分開：排序＝圓角膠囊、選中是實心；
         篩選＝方角描邊鍵、生效只上淡色底＋數字，比主要動作（我要上架）安靜。 -->
    <div class="bar">
      <button
        type="button" class="fbtn" :class="{ on: filterCount > 0 }"
        :aria-expanded="panelOpen" aria-controls="marketFilters"
        @click="panelOpen = !panelOpen"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
          <circle cx="9" cy="7" r="2.4" /><circle cx="15" cy="12" r="2.4" /><circle cx="7" cy="17" r="2.4" />
        </svg>
        <span>篩選</span>
        <!-- 用了幾個條件直接寫在鍵上：面板收起來之後，這是「篩選正在生效」
             唯一還看得見的訊號 -->
        <span v-if="filterCount" class="fnum">{{ filterCount }}</span>
      </button>
      <span class="barsep" aria-hidden="true"></span>
      <div class="sorts" role="tablist" aria-label="排序方式">
        <button
          v-for="s in SORTS" :key="s.k"
          type="button" role="tab" :aria-selected="sort === s.k"
          class="chip" :class="{ on: sort === s.k }"
          @click="sort = s.k"
        >{{ s.label }}</button>
      </div>
    </div>

    <!-- 篩選面板。預設收起來 —— 不篩選的人（多數）版面跟以前一模一樣。
         選項用方角磚，不重複排序膠囊的形狀 -->
    <div v-if="panelOpen" id="marketFilters" class="fpanel">
      <div class="frow">
        <span id="fl-grader" class="flabel">鑑定</span>
        <div class="fopts" role="group" aria-labelledby="fl-grader">
          <button
            type="button" class="tile any" :class="{ on: grader === null }"
            :aria-pressed="grader === null" @click="grader = null"
          >不限</button>
          <button
            v-for="g in GRADER_OPTS" :key="g.k"
            type="button" class="tile" :class="{ on: grader === g.k }"
            :aria-pressed="grader === g.k" @click="grader = grader === g.k ? null : g.k"
          >{{ g.label }}</button>
        </div>
      </div>

      <!-- 未鑑定的卡沒有分數，這一段整塊收起來：
           留一排點了必定 0 件的選項，比沒有這一段更難懂 -->
      <div v-if="grader !== 'raw'" class="frow">
        <span id="fl-grade" class="flabel">分數</span>
        <div class="fopts" role="group" aria-labelledby="fl-grade">
          <button
            type="button" class="tile any" :class="{ on: minGrade === null }"
            :aria-pressed="minGrade === null" @click="minGrade = null"
          >不限</button>
          <button
            v-for="g in GRADE_OPTS" :key="g"
            type="button" class="tile" :class="{ on: minGrade === g }"
            :aria-pressed="minGrade === g" @click="minGrade = minGrade === g ? null : g"
          >{{ g }} 分以上</button>
        </div>
      </div>
      <p v-else class="fnote muted">未鑑定的卡沒有鑑定分數，所以這裡不提供分數條件。</p>

      <div class="frow">
        <span class="flabel">點數</span>
        <div class="prices">
          <input
            class="pbox mono" type="text" inputmode="numeric" autocomplete="off"
            placeholder="最低" aria-label="最低點數"
            :value="minDraft" @input="onPriceInput($event, 'min')"
          />
          <span class="dash" aria-hidden="true">–</span>
          <input
            class="pbox mono" type="text" inputmode="numeric" autocomplete="off"
            placeholder="最高" aria-label="最高點數"
            :value="maxDraft" @input="onPriceInput($event, 'max')"
          />
        </div>
      </div>
      <!-- 上下顛倒／超出上界當場說，不要送一趟請求換一句 400 -->
      <p v-if="priceNote" class="fnote bad" role="alert">{{ priceNote }}</p>

      <div class="fpfoot">
        <button v-if="filtering" type="button" class="flink" @click="clearAll">清除全部條件</button>
        <button type="button" class="flink done" @click="panelOpen = false">收起</button>
      </div>
    </div>

    <TradeGuard />

    <!-- 撿便宜：橫向捲動的小方塊，密度高，跟下面的大格線形成對比。
         搜尋時整區收起來：這兩條講的是「整個市場」，跟關鍵字無關，
         留著會讓使用者以為那也是搜尋結果 -->
    <section v-if="deals.length && sort === 'deal' && !filtering" class="band">
      <header class="bh">
        <h2><span class="dot deal"></span>今日最殺</h2>
        <span class="muted bhNote">低於市值 8% 以上</span>
      </header>
      <div class="rail">
        <RouterLink
          v-for="l in deals" :key="l.id"
          class="dealCard" :class="{ mine: isMine(l) }"
          :to="{ name: 'market-listing', params: { id: l.id } }"
        >
          <CardArt class="dealArt" :image="''" :alt="l.card.name" :art-id="l.card.artId" />
          <span v-if="diffPct(l) !== null" class="dealPct">{{ diffPct(l) }}%</span>
          <!-- 104px 的小方塊左上角已經被折數佔走，標記放右上角。
               只講「我的」兩個字：這個寬度放不下完整句子，形狀＋顏色＋外框
               三個訊號加起來已經夠認 -->
          <OwnerTag v-if="isMine(l)" class="dealMine" label="我的" compact />
          <span class="dealFoot">
            <span class="mono dealPrice">{{ l.price.toLocaleString() }}</span>
            <span class="dealRef mono">賣家標示 {{ refPriceText(l.card.refPrice) }}</span>
          </span>
        </RouterLink>
      </div>
    </section>

    <!-- 鑑定卡：單價最高的一區，用寬一點的卡凸顯 -->
    <section v-if="graded.length && sort === 'deal' && !filtering" class="band gradedBand">
      <header class="bh">
        <h2><span class="dot cert"></span>已鑑定</h2>
        <span class="muted bhNote">附鑑定編號，可自行到鑑定機構查證</span>
      </header>
      <div class="rail">
        <RouterLink
          v-for="l in graded" :key="l.id"
          class="gradedCard" :class="{ mine: isMine(l) }"
          :to="{ name: 'market-listing', params: { id: l.id } }"
        >
          <CardArt class="gradedArt" :image="''" :alt="l.card.name" :art-id="l.card.artId" />
          <span class="gradedInfo">
            <!-- 這種卡沒有可疊圖的空白角落（縮圖只有 66px），標記進資訊欄第一行。
                 gName 要 min-width: 0 才不會被長卡名把標記擠出卡片外 -->
            <span class="gTop">
              <OwnerTag v-if="isMine(l)" label="我的" compact />
              <strong class="gName">{{ l.card.name }}</strong>
            </span>
            <!-- 只到「哪一家、幾分」為止，不接鑑定編號。
                 編號是身分憑據（見 server/src/card-public.ts），公開市場的回應
                 本來就過了白名單拿不到它 —— 印在這裡的結果是一個孤零零的 "#"。 -->
            <span class="gCert mono">{{ l.card.grader }} {{ l.card.grade }}</span>
            <span class="mono gPrice">{{ l.price.toLocaleString() }} 點</span>
          </span>
        </RouterLink>
      </div>
    </section>

    <!-- 搜尋結果的標頭。筆數是**整個市場**符合的數量（後端第一批一起回），
         不是「已經載進來幾筆」—— 後者正是分頁搜尋最容易給錯的那個數字。
         aria-live 讓讀螢幕的人也知道結果換了。 -->
    <header v-if="filtering" class="bh allHead" aria-live="polite">
      <h2><span class="dot all"></span>{{ q ? `「${q}」的結果` : '篩選結果' }}</h2>
      <span v-if="matched !== null" class="muted bhNote">{{ matched }} 件</span>
      <span v-else-if="busy" class="muted bhNote">搜尋中</span>
      <button type="button" class="clearAll" @click="clearAll">清除條件</button>
    </header>

    <!-- 生效中的條件各自一顆，點一下就拿掉那一個。
         「一鍵清除全部」在上面那顆；這裡要的是「只放寬價格、等級留著」——
         全部一起清掉的話使用者得把其他條件重設一次 -->
    <div v-if="filtering" class="active">
      <button
        v-for="c in conds" :key="c.k"
        type="button" class="atag" :aria-label="`移除條件：${c.label}`" @click="c.clear()"
      >
        <span>{{ c.label }}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>

    <header v-else-if="sort === 'deal' && (deals.length || graded.length)" class="bh allHead">
      <h2><span class="dot all"></span>全部掛單</h2>
      <span class="muted bhNote">{{ total }} 件</span>
    </header>

    <div v-if="loading" class="grid" aria-hidden="true">
      <div v-for="i in 6" :key="i" class="sk"></div>
    </div>

    <div v-else-if="shown.length" ref="gridRef" class="grid">
      <!-- 卡圖滿版鋪滿整格，資訊直接壓在圖上。
           左到右的漸層遮罩把左半邊壓暗 —— 卡圖的主體（寶可夢）多半偏中上，
           壓左下角最不會蓋到重點，文字也才有足夠對比。 -->
      <article v-for="l in shown" :key="l.id" class="lot" :class="{ mine: isMine(l) }">
        <CardArt
          class="art"
          :image="l.card.image" :alt="l.card.name" :art-id="l.card.artId"
        />
        <span class="scrim" aria-hidden="true"></span>

        <!-- 通道徽章疊在卡圖上。原本放在 .by 那行，但那行在手機上會被隱藏，
             而「要不要等寄送」是買家下單前最需要先知道的事 -->
        <span class="lane" :class="laneOf(l)">
          {{ laneOf(l) === 'vault' ? '庫內' : '需寄送' }}
        </span>

        <!-- 通道徽章佔了左上角，這個放右上角，兩個不會撞在一起 -->
        <OwnerTag v-if="isMine(l)" class="lotMine" label="我的掛單" />

        <div class="info">
          <strong class="name">{{ l.card.name }}</strong>
          <div class="price">
            <strong class="mono p">{{ l.price.toLocaleString() }}</strong>
            <span class="u">點</span>
            <!-- 沒有標示參考價就沒有折價幅度可言 —— 不顯示這個標籤，
                 拿 0 頂替會讓一張沒有基準的卡看起來像「剛好平價」 -->
            <span v-if="diffPct(l) !== null" class="tag" :class="(diffPct(l) ?? 0) <= 0 ? 'good' : 'over'">
              {{ (diffPct(l) ?? 0) <= 0 ? '' : '+' }}{{ diffPct(l) }}%
            </span>
          </div>
          <p class="meta mono">
            賣家標示 {{ refPriceText(l.card.refPrice) }}
          </p>
          <p class="by">{{ l.sellerName }} · {{ l.listedAt }}</p>
        </div>

        <!-- 整格都是連結（撐滿的透明 <a>），而不是只有「買下」那顆鍵可以點：
             使用者的直覺是「點卡片就進去看」。連結放在資訊層下面，
             文字才選得到；「買下」是純視覺的標籤，pointer-events: none
             讓點在它身上的手指落到下面這條連結上。 -->
        <RouterLink
          class="open" :to="{ name: 'market-listing', params: { id: l.id } }"
          :aria-label="isMine(l)
            ? `${l.card.name}，${l.price.toLocaleString()} 點，你上架的掛單`
            : `${l.card.name}，${l.price.toLocaleString()} 點`"
        />
        <!-- 自己的卡不能寫「買下」。後端本來就會擋，寫著買下等於邀請使用者
             走一趟必定失敗的流程；改成「管理」才對得上點進去實際能做的事 -->
        <span class="buy" aria-hidden="true">{{ isMine(l) ? '管理' : '買下' }}</span>
      </article>
    </div>

    <!-- 查無結果。一片空白等於讓使用者自己猜「是壞了還是真的沒有」，
         所以要把三件事講清楚：沒有的是什麼、為什麼可能沒有、下一步往哪走。
         兩條出路都是真的走得到的地方 —— 回全部掛單，或去抽選池碰。 -->
    <div v-else-if="filtering && !list.error.value" class="none">
      <p class="noneTitle">{{ q ? `市場上沒有「${q}」的掛單` : '沒有符合這些條件的掛單' }}</p>

      <!-- 只有一個條件時，擋掉結果的必然是它，直接說 -->
      <p v-if="conds.length === 1" class="muted noneWhy">
        擋下結果的是「{{ conds[0]?.label }}」這一個條件。
        <template v-if="q">
          可能還沒有人賣這張卡，或是卡名的寫法不一樣 ——
          試試短一點的關鍵字（例如只打「伊布」），或直接輸入卡號、系列代碼。
        </template>
      </p>
      <template v-else>
        <p v-if="hints.length" class="muted noneWhy">是這幾個條件加起來把結果篩空的。只放寬其中一個就有：</p>
        <p v-else-if="hints.length === 0" class="muted noneWhy">
          這幾個條件單獨拿掉任何一個都還是 0 件 —— 要看到東西得一次放寬不只一個。
        </p>
        <div v-if="hints.length" class="hints">
          <button v-for="h in hints" :key="h.label" type="button" class="hint" @click="h.clear()">
            放寬「{{ h.label }}」<span class="hintN mono">{{ h.n }} 件</span>
          </button>
        </div>
      </template>

      <div class="noneActs">
        <button type="button" class="btn" @click="clearAll">看全部掛單</button>
        <RouterLink :to="{ name: 'home' }" class="btn ghost">去抽選池找</RouterLink>
      </div>
    </div>

    <p v-else-if="!list.error.value" class="empty muted">目前市場沒有掛單。</p>

    <!-- 哨兵放在格線外面：塞進 grid 會佔掉一格，而且 grid 子元素預設
         min-width: auto，長錯誤訊息會把整欄撐開（這頁是兩欄，很敏感） -->
    <ListSentinel
      ref="sentinelRef"
      :loading="list.loading.value && list.ready.value"
      :done="list.done.value"
      :error="list.error.value"
      :manual="list.manual.value"
      :empty="!shown.length"
      :done-text="filtering ? '已經是全部符合條件的掛單了' : '已經是全部的掛單了'"
      @retry="list.retry()"
      @more="list.load()"
    />

    <footer class="foot">
      <p class="muted">
        餘額 <strong class="mono"><RollingNumber :value="wallet.shown" /></strong> 點
        <RouterLink :to="{ name: 'topup' }" class="tu">儲值 →</RouterLink>
      </p>
      <p class="fine muted">
        市場以站內點數成交，賣出所得為點數，不可提領現金或轉讓。
        卡片由平台代管轉移，買方可另行申請出貨。
      </p>
    </footer>
  </div>
</template>

<style scoped>
/* 底部導覽的讓位交給頁尾（見 App.vue），這裡只留自己的排版留白 */
.page { padding-top: 26px; padding-bottom: 48px; }

.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
h1 { font-size: 24px; margin: 0; letter-spacing: -.02em; }
.sub { font-size: 13.5px; margin: 5px 0 0; }
.sell {
  flex: none;
  min-height: 44px;
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 13.5px; font-weight: 600;
  padding: 9px 16px; border-radius: var(--pill);
  background: var(--accent-wash); color: var(--accent);
  transition: background .15s;
}
.sell svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
@media (hover: hover) { .sell:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); } }
.sell:active { transform: scale(.97); }

/* ---- 搜尋框 ----
   一整條 44px 高的欄位（觸控目標下限），圖示與清除鍵用 grid 分三欄，
   中間那欄 minmax(0, 1fr) 才不會被 input 的預設寬度（size=20）撐破版面。 */
.search {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding: 0 6px 0 14px;
  min-height: 46px;
  border-radius: var(--pill);
  border: 1px solid var(--line-soft);
  background: var(--surface);
  transition: border-color .15s, background .15s;
}
.search:focus-within { border-color: var(--line); background: var(--surface-2); }
.mag { width: 17px; height: 17px; flex: none; fill: none; stroke: var(--muted); stroke-width: 2; stroke-linecap: round; }
.qbox {
  min-width: 0;
  border: 0; background: transparent; outline: none;
  color: var(--ink);
  /* 16px 是 iOS 不自動放大頁面的門檻。小於它的話點進輸入框整頁會被縮放，
     退出時又不會縮回去 —— 這頁的兩欄格線會整個跑掉 */
  font-size: 16px;
  padding: 12px 0;
  font-family: inherit;
}
.qbox::placeholder { color: var(--faint); }
/* type=search 在 WebKit 會長出自己的清除鍵，跟下面那顆重複而且不受樣式控制 */
.qbox::-webkit-search-cancel-button,
.qbox::-webkit-search-decoration { -webkit-appearance: none; appearance: none; }

.clear {
  flex: none;
  width: 44px; height: 44px;      /* 觸控目標下限，視覺上靠 svg 縮小 */
  display: grid; place-items: center;
  border: 0; background: transparent; cursor: pointer;
  border-radius: 50%;
  color: var(--muted);
}
.clear svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
@media (hover: hover) { .clear:hover { color: var(--ink); } }
.clear:active { transform: scale(.92); }
/* 忙碌指示佔跟清除鍵一樣的 44px，兩者互換時輸入框寬度不會跳一下 */
.search .ring {
  flex: none;
  width: 44px; height: 44px;
  border-radius: 50%;
  position: relative;
}
.search .ring::after {
  content: '';
  position: absolute; inset: 14px;
  border-radius: 50%;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
}
@media (prefers-reduced-motion: no-preference) {
  .search .ring::after { animation: spin .7s linear infinite; }
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ---- 查無結果 ---- */
.none { display: grid; justify-items: center; gap: 10px; padding: 48px 0 40px; text-align: center; }
.noneTitle { margin: 0; font-size: 16px; font-weight: 700; overflow-wrap: anywhere; }
.noneWhy { margin: 0; font-size: 13px; line-height: 1.7; max-width: 30em; }
.noneActs { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 6px; }
.noneActs .btn { min-height: 44px; padding: 10px 20px; font-size: 14px; }

/* ---- 控制列：篩選鍵 + 排序 ----
   兩者同一列。篩選鍵不捲（釘在左邊，永遠看得到「用了幾個條件」），
   排序那段自己橫向捲 —— 所以 .sorts 要 min-width: 0，
   flex 子元素預設不縮到比內容窄，少了它整列會被四顆膠囊撐破版面。 */
.bar { display: flex; align-items: center; gap: 10px; margin: 12px 0 14px; }

.fbtn {
  flex: none;
  min-height: 44px;              /* 觸控目標下限 */
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 13px;
  /* 方角（10px）而不是膠囊：排序是膠囊，形狀不同才掃得出這是另一種東西 */
  border-radius: 10px;
  border: 1px solid var(--line);
  background: transparent; color: var(--muted);
  font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s;
}
.fbtn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.fbtn svg circle { fill: var(--bg); }
/* 生效時只上淡色底＋強調色字，不做成實心 —— 實心會比頁首那顆主要動作
   （我要上架）更搶眼，那正是使用者說「有點亂」的那種矛盾 */
.fbtn.on { background: var(--accent-wash); border-color: transparent; color: var(--accent); }
.fbtn.on svg circle { fill: var(--accent-wash); }
@media (hover: hover) { .fbtn:hover { color: var(--ink); border-color: var(--line); } .fbtn.on:hover { color: var(--accent); } }
.fbtn:active { transform: scale(.97); }
.fnum {
  min-width: 18px; height: 18px; padding: 0 5px;
  display: inline-grid; place-items: center;
  border-radius: var(--pill);
  background: var(--accent); color: var(--on-accent);
  font-size: 11px; font-weight: 700; line-height: 1;
}
/* 一條細線把「篩選」與「排序」分開：兩種語意之間要有看得見的界線 */
.barsep { flex: none; width: 1px; align-self: stretch; margin: 6px 0; background: var(--line-soft); }

/* 右緣淡出：這排是可以左右滑的，但截斷處如果是硬邊，看起來就只是「被切掉」
   而不是「還有更多」。mask 讓最後一顆膠囊漸隱，滑動的可能性才看得出來。 */
.sorts {
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 34px), transparent 100%);
  mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 34px), transparent 100%);
  flex: 1 1 auto; min-width: 0;
  display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }
.sorts::-webkit-scrollbar { display: none; }

/* ---- 篩選面板 ----
   收起來時這一塊完全不存在，不篩選的人版面跟以前一樣。
   選項用方角磚（8px），跟排序的圓角膠囊分得開。 */
.fpanel {
  /* minmax(0, 1fr) 不是可有可無：grid 的軌道預設是 auto，也就是最寬那一列的
     max-content —— 六顆「鑑定」磚會把整條軌道撐成 487px 塞進 353px 的面板裡，
     右半邊（ARS、最高點數、收起）直接被切在螢幕外。實測就是這樣。 */
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px;
  margin: -4px 0 16px;
  padding: 14px;
  border-radius: var(--radius);
  border: 1px solid var(--line-soft);
  background: var(--surface);
}
/* 同一個道理（見上）：軌道要明寫 minmax(0, 1fr)，
   不然兩個金額框那一列會把它撐成 max-content，「最高」被切出畫面。 */
.frow { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-width: 0; }
.flabel { font-size: 12px; font-weight: 600; color: var(--muted); }
.fopts { display: flex; flex-wrap: wrap; gap: 8px; }
.tile {
  min-height: 44px;
  padding: 8px 13px;
  border-radius: 8px;
  border: 1px solid var(--line-soft);
  background: var(--surface-2); color: var(--muted);
  font-size: 13px; font-weight: 500; font-family: inherit; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s;
}
/* 選中用淡色底＋強調色字，跟排序膠囊的「實心墨色」不同 —— 兩排東西同時
   出現在畫面上時，看得出哪一個是排序、哪一個是篩選 */
.tile.on { background: var(--accent-wash); border-color: color-mix(in srgb, var(--accent) 40%, transparent); color: var(--accent); font-weight: 700; }
/* 「不限」是「沒有在篩選」，不能長得跟生效中的條件一樣 ——
   強調色在這站的語意是「這裡有事情發生」，套在一個什麼都沒篩的預設值上，
   等於整個面板一打開就有兩個紅框在喊。選中時只做中性的加深。 */
.tile.any.on { background: var(--surface-3); border-color: var(--line); color: var(--ink); }
@media (hover: hover) { .tile:not(.on):hover { color: var(--ink); border-color: var(--line); } }
.tile:active { transform: scale(.97); }

.prices { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pbox {
  min-width: 0; flex: 1 1 0;
  min-height: 44px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--line-soft);
  background: var(--field); color: var(--ink);
  /* 16px 是 iOS 不自動放大整頁的門檻 —— 小於它的話點進輸入框版面會整個跑掉 */
  font-size: 16px; font-family: var(--font-mono);
}
.pbox::placeholder { color: var(--faint); font-family: var(--font-body); }
.pbox:focus { outline: none; border-color: var(--line); background: var(--surface-2); }
.dash { flex: none; color: var(--faint); }
.fnote { margin: -4px 0 0; font-size: 12px; line-height: 1.6; }
.fnote.bad { color: var(--danger-ink); }
.fpfoot { display: flex; justify-content: space-between; gap: 10px; border-top: 1px solid var(--line-soft); padding-top: 4px; }
.flink {
  min-height: 44px; padding: 8px 4px;
  border: 0; background: transparent; cursor: pointer;
  font-size: 13px; font-family: inherit; color: var(--muted);
}
.flink.done { color: var(--accent); font-weight: 600; margin-left: auto; }
@media (hover: hover) { .flink:hover { color: var(--ink); } }

/* ---- 生效中的條件 ---- */
.clearAll {
  margin-left: auto;
  min-height: 44px; padding: 8px 4px;
  border: 0; background: transparent; cursor: pointer;
  font-size: 12.5px; font-family: inherit; color: var(--accent);
}
@media (hover: hover) { .clearAll:hover { color: var(--accent-soft); } }
.active { display: flex; flex-wrap: wrap; gap: 7px; margin: -4px 0 12px; }
.atag {
  min-width: 0;
  display: inline-flex; align-items: center; gap: 6px;
  /* 這一顆是「拿掉這個條件」，不是一個可選的選項 —— 高度刻意比 44px 矮一階，
     它是結果的註腳不是控制列的一部分；點擊區靠 padding 撐到 32px 以上 */
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
  background: var(--accent-wash); color: var(--accent);
  font-size: 12px; font-weight: 600; font-family: inherit; cursor: pointer;
}
.atag span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.atag svg { width: 11px; height: 11px; flex: none; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; }
@media (hover: hover) { .atag:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); } }
.atag:active { transform: scale(.96); }

/* ---- 查無結果時的「放寬哪一個」 ---- */
.hints { display: grid; gap: 8px; width: min(100%, 30em); }
.hint {
  min-height: 44px;
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--line-soft);
  background: var(--surface); color: var(--ink);
  font-size: 13.5px; font-family: inherit; cursor: pointer; text-align: left;
}
.hintN { flex: none; color: var(--ok-ink); font-weight: 700; font-size: 13px; }
@media (hover: hover) { .hint:hover { border-color: var(--line); background: var(--surface-2); } }
.hint:active { transform: scale(.98); }
.chip {
  flex: none;
  /* 44px 是觸控目標下限；視覺上仍是細膠囊，靠 padding 撐開可點區域 */
  min-height: 44px;
  padding: 8px 16px; border-radius: var(--pill);
  border: 1px solid var(--line-soft); background: transparent;
  color: var(--muted); font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s;
}
.chip.on { background: var(--ink); color: var(--bg); border-color: transparent; font-weight: 600; }
@media (hover: hover) { .chip:not(.on):hover { color: var(--ink); border-color: var(--line); } }
.chip:active { transform: scale(.96); }

/* ---- 分區 ---- */
.band { margin-bottom: 22px; }
.bh { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 11px; }
.bh h2 { display: flex; align-items: center; gap: 8px; font-size: 16px; margin: 0; letter-spacing: -.01em; }
.bhNote { font-size: 11.5px; }
.allHead { margin-top: 4px; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dot.deal { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
.dot.cert { background: #d8b25a; box-shadow: 0 0 8px #d8b25a; }
.dot.all { background: var(--muted); }

.rail {
  display: flex; gap: 10px;
  overflow-x: auto; scroll-snap-type: x proximity;
  scrollbar-width: none; overscroll-behavior-x: contain;
  padding-bottom: 4px;
  -webkit-mask-image: linear-gradient(90deg, #000 0 calc(100% - 26px), transparent);
  mask-image: linear-gradient(90deg, #000 0 calc(100% - 26px), transparent);
}
.rail::-webkit-scrollbar { display: none; }

/* 撿便宜：小方塊，整頁密度最高 */
.dealCard {
  position: relative; display: block; flex: 0 0 104px;
  scroll-snap-align: start;
  padding: 0; border: none; cursor: pointer;
  border-radius: var(--radius); overflow: hidden;
  background: var(--surface-2);
  color: inherit; text-decoration: none;
  transition: transform .2s;
}
@media (hover: hover) { .dealCard:hover { transform: translateY(-3px); } }
.dealCard:active { transform: scale(.96); }
.dealArt { width: 100%; aspect-ratio: 5 / 7; display: block; }
.dealArt :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.dealPct {
  position: absolute; top: 5px; left: 5px;
  font-size: 11px; font-weight: 700;
  padding: 2px 7px; border-radius: var(--pill);
  background: var(--ok); color: #06210f;
}
.dealFoot {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: grid; gap: 1px;
  padding: 14px 7px 6px;
  background: linear-gradient(0deg, rgba(8,6,14,.94), transparent);
  color: #fff;
}
.dealPrice { font-size: 13px; font-weight: 700; }
.dealRef { font-size: 9.5px; opacity: .6; text-decoration: line-through; }

/* 已鑑定：橫式寬卡，跟上面的小方塊形狀完全不同 */
.gradedCard {
  position: relative;
  flex: 0 0 min(80vw, 300px);
  scroll-snap-align: start;
  display: grid; grid-template-columns: 66px minmax(0, 1fr);
  gap: 11px; align-items: center;
  padding: 9px; cursor: pointer;
  border-radius: var(--radius);
  border: 1px solid color-mix(in srgb, #d8b25a 32%, transparent);
  background: linear-gradient(100deg, color-mix(in srgb, #d8b25a 10%, transparent), var(--surface) 60%);
  text-align: left; color: inherit; text-decoration: none;
  transition: transform .2s, border-color .2s;
}
@media (hover: hover) { .gradedCard:hover { transform: translateY(-3px); border-color: #d8b25a; } }
.gradedCard:active { transform: scale(.98); }
.gradedArt { width: 100%; aspect-ratio: 5 / 7; border-radius: 6px; overflow: hidden; }
.gradedArt :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.gradedInfo { display: grid; gap: 3px; min-width: 0; }
/* 標記與卡名同一行：多開一行會把這張橫式卡撐高，整條捲軸的節奏就跟著跑掉。
   min-width: 0 在兩層都要有 —— flex 子元素預設不縮到比內容窄 */
.gTop { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* 標記不准縮：它自己帶 min-width: 0（那是為了疊在卡圖上時不撐開格子），
   放進 flex 行裡就會被長卡名壓成 0 寬 —— 實測長卡名下整顆標記被擠沒了，
   只剩一條藍線。要讓的是卡名，不是標示。 */
.gTop .omark { flex: 0 0 auto; }
.gTop .gName { min-width: 0; }
.gName { font-size: 13.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gCert { font-size: 10px; color: #d8b25a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gPrice { font-size: 15px; font-weight: 700; margin-top: 1px; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }

/* 一格 = 一張卡。沒有外框、沒有內距，卡圖就是整格 —— 同樣的格子寬度下
   卡片比原本大了一圈（原本被 14px 內距與白底框吃掉）。 */
.lot {
  position: relative;
  aspect-ratio: 5 / 7;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--surface-2);
  isolation: isolate;
  transition: transform .25s cubic-bezier(.2, .7, .3, 1), box-shadow .25s;
}
@media (hover: hover) {
  .lot:hover { transform: translateY(-4px); box-shadow: var(--shadow-lg); }
}
.lot .art { width: 100%; height: 100%; }
.lot .art :deep(img), .lot .art :deep(.art-img) { width: 100%; height: 100%; object-fit: cover; }

/* 左到右的漸層：左側夠暗撐住文字，右側完全透明讓卡圖露出來。
   再疊一層由下往上的，因為文字是靠下的。 */
.scrim {
  position: absolute; inset: 0;
  pointer-events: none;
  /* 底部要夠深：卡圖本身有招式名與傷害數字，遮罩不夠會跟白字打架 */
  background:
    linear-gradient(100deg,
      rgba(8, 6, 14, .95) 0%,
      rgba(8, 6, 14, .8) 34%,
      rgba(8, 6, 14, .32) 62%,
      transparent 88%),
    linear-gradient(0deg,
      rgba(8, 6, 14, .96) 0%,
      rgba(8, 6, 14, .88) 16%,
      rgba(8, 6, 14, .42) 34%,
      transparent 56%);
}

/* 右側留出買下鍵的寬度：不留的話最底下那兩行（市值、賣家）會被鍵蓋掉，
   實測「市值 4,200 · PSA 10」被截成「市值 4,200 · PSA 1」 */
.info {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 12px 86px 13px 12px;
  display: grid; gap: 3px; justify-items: start;
  color: #fff;
}
/* 卡名與價格在買下鍵的上方，可以用滿整格寬度 */
.name, .price { margin-right: -74px; }
.name {
  font-size: 15px; font-weight: 700; line-height: 1.3;
  text-shadow: 0 1px 6px rgba(0, 0, 0, .7);
}
.price { display: flex; align-items: baseline; gap: 5px; margin-top: 2px; }
.p { font-size: 23px; font-weight: 700; letter-spacing: -.02em; text-shadow: 0 2px 10px rgba(0, 0, 0, .8); }
.u { font-size: 12px; opacity: .8; }
.tag { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: var(--pill); margin-left: 2px; }
.tag.good { background: var(--ok); color: #06210f; }
.tag.over { background: rgba(255, 255, 255, .22); color: #fff; }
/* 留給買下鍵的寬度之後，這兩行很窄 —— 強制單行，寧可截斷也不要折成兩行
   把整塊資訊往上推、蓋掉更多卡圖 */
.meta, .by {
  max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meta { font-size: 11px; opacity: .78; margin: 1px 0 0; }
.by { font-size: 10.5px; opacity: .6; margin: 0; }

/* 通道徽章：疊在卡圖左上角，不跟價格搶 .info 的空間。
   pointer-events: none —— 它蓋在整格的連結上面，不能把點擊吃掉 */
.lane {
  position: absolute; left: 8px; top: 8px; z-index: 2;
  pointer-events: none;
  font-size: 10px; font-weight: 700; line-height: 1;
  padding: 4px 7px; border-radius: var(--pill);
  letter-spacing: .02em;
  backdrop-filter: blur(6px);
}
.lane.vault { background: rgba(22, 130, 90, .82); color: #fff; }
.lane.ship { background: rgba(10, 10, 14, .62); color: rgba(255, 255, 255, .92); }

/* 撐滿整格的連結：整張卡都可以點進詳情頁，不是只有右下角那顆鍵 */
.open { position: absolute; inset: 0; z-index: 3; border-radius: var(--radius); }
.open:focus-visible { outline: 2px solid #fff; outline-offset: -3px; }

/* 「買下」現在只是視覺標籤，真正的連結是 .open。
   pointer-events: none 讓點在它身上的手指直接落到那條連結上 */
.buy {
  position: absolute; right: 10px; bottom: 11px; z-index: 4;
  pointer-events: none;
  padding: 9px 16px;
  border-radius: var(--pill);
  background: var(--accent); color: #fff;
  font-size: 13.5px; font-weight: 700; line-height: 1.25;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .45);
  transition: background .15s;
}
@media (hover: hover) { .lot:hover .buy { background: var(--accent-soft); } }

/* ---- 自己上架的掛單 ----
   三種形狀共用同一組訊號：藍色外框 ＋ 同一顆標記。只加一行小字是不夠的 ——
   使用者是在滑動中掃過這些卡片的，能被掃到的只有形狀與顏色。

   外框用 ::after 而不是 border / outline / inset box-shadow：
   這三種卡的圖都是滿版鋪在元素裡的子節點，畫在元素自己身上的邊框會被圖蓋掉
   （dealCard 與 lot 都是 overflow: hidden ＋ object-fit: cover）。
   ::after 是繪製在子節點之上的獨立疊層，而且不必動 template 加空 span。
   pointer-events: none —— 它蓋在整格的連結上面，不能把點擊吃掉。 */
.dealCard.mine::after,
.gradedCard.mine::after,
.lot.mine::after {
  content: '';
  position: absolute; inset: 0;
  z-index: 5;
  pointer-events: none;
  border: 2px solid var(--info-ink);
  border-radius: inherit;
}

/* 小方塊：左上角是折數，標記走右上角 */
.dealMine { position: absolute; right: 5px; top: 5px; z-index: 6; pointer-events: none; max-width: calc(100% - 10px); }

/* 滿版格：左上角是通道徽章，標記走右上角 */
.lotMine { position: absolute; right: 8px; top: 8px; z-index: 6; pointer-events: none; max-width: calc(100% - 16px); }

/* 「買下」在自己的卡上會變成「管理」（見 template）——
   顏色也要跟著換，不然一顆強調色的鍵仍然在喊「買」 */
.lot.mine .buy { background: var(--info-ink); color: var(--bg); }
@media (hover: hover) { .lot.mine:hover .buy { background: var(--info-ink); } }

.sk { aspect-ratio: 5 / 7; border-radius: var(--radius); background: var(--surface-2); }
@media (prefers-reduced-motion: no-preference) {
  .sk { animation: pulse 1.4s ease-in-out infinite alternate; }
}
@keyframes pulse { to { opacity: .55; } }

.empty { text-align: center; padding: 60px 0; }
.foot { margin-top: 26px; padding-top: 18px; border-top: 1px solid var(--line-soft); display: grid; gap: 6px; }
.foot p { margin: 0; font-size: 13px; }
.tu { color: var(--accent); margin-left: 10px; }
.fine { font-size: 11.5px; line-height: 1.6; color: var(--faint); }

@media (max-width: 720px) {
  .page { padding-top: 16px; }
  h1 { font-size: 20px; }
  .sub { font-size: 12.5px; }
  .grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .info { padding: 9px 66px 10px 9px; }
  .name, .price { margin-right: -57px; }
  .name { font-size: 12.5px; }
  .p { font-size: 18px; }
  .u, .tag { font-size: 10px; }
  .meta { font-size: 10px; }
  .by { display: none; }          /* 小格子放不下，賣家資訊讓給價格 */
  .buy { right: 7px; bottom: 8px; padding: 7px 12px; font-size: 12px; }
  /* 兩欄版的格子只有一半寬，標記靠右上角容易跟卡圖的角落花紋糊在一起，
     縮一階並貼近邊緣，留給卡名的空間才夠 */
  .lotMine { right: 6px; top: 6px; max-width: calc(100% - 12px); }
  .sell { font-size: 12.5px; padding: 8px 13px; }
}
</style>
