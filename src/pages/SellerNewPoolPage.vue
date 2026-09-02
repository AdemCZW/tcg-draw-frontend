<script setup lang="ts">
/*
 * 賣家開池。
 *
 * ── 這一頁在 2026-08 換掉了兩件事 ──────────────────────────────────
 *
 * 一、獎品從「打字」改成「挑卡」。
 *   原本每個獎品只填一個 `name: string`。打出來的字串沒有卡號、沒有系列、
 *   沒有卡圖、沒有變體 —— 賣家開的池永遠對不到外部價格，買家也看不到卡長怎樣。
 *   現在用 CardPicker（從自己的卡冊挑，或搜 TCGdex 目錄），挑到的是**完整身分**：
 *   卡號、系列、卡圖、變體、以及卡冊來源本來就有的鑑定編號。
 *   那份身分原封不動進獎品、進 manifest v4、進公平性承諾。
 *
 * 二、經濟試算從「送出才知道」改成「邊填邊算」。
 *   原本護欄不過只會在送出時被退回，賣家不知道是哪一格害的。現在票收、
 *   保底回饋、回饋率三個數字跟著每一次輸入即時更新，紅字當場就看得到。
 *   算式一律走 computeEconomics → src/shared/economics.ts，
 *   **前端不另寫一份** —— 兩份算式一定會走鐘，而走鐘的那一天沒有人會發現，
 *   只會看到「畫面說可以、伺服器說不行」。
 *
 * ── 沒有變的判斷 ────────────────────────────────────────────────────
 *
 * 算的是**保底回饋率** ＝ Σ(宣告買回價 × 數量) ÷ 票收，不是賣家標示的市值。
 * 分子換成「他有義務付出去的錢」之後，這個數字不需要外部價格資料就是誠實的
 * —— 灌高等於承諾多賠（換分子的完整理由見 src/shared/economics.ts）。
 *
 * 買回價**按賞別填**，一個賞別一個絕對金額（A 賞 3000、D 賞 120 這樣）。
 * 為什麼不是比率、也不是每張卡一個：
 *   - 比率要有基準，而唯一的基準是賣家自填的市值 —— 那是循環論證。
 *   - 每張卡一格在資料上是對的，但要賣家在 250 籤的池上填 250 次不現實。
 *   - 同一個賞別裡的卡價值本來就相近 —— 那正是分賞別的意義。
 * 某一張在該賞別裡特別貴的時候可以**單獨覆寫**，那是例外不是常態。
 *
 * 「參考價」是選填：它不參與任何計算，強迫賣家填一個沒有外部依據的數字
 * 只會製造一個看起來像官方行情的假資料。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useSellerStore } from '@/stores/sellers'
import { api } from '@/lib/api'
import { ApiError } from '@/lib/http'
import { MOCK } from '@/lib/config'
import { usePoolStore } from '@/stores/pools'
import { computeEconomics } from '@/lib/economics'
import { BUYBACK_MIN, BUYBACK_MAX } from '@/lib/recycle'
import { buybackValid } from '@/shared/recycle'
import { FLOOR_RATIO_LABEL, FLOOR_RATIO_MEANING, FLOOR_VERDICT_STAMP } from '@/shared/economics'
// 到期日不在這張表上，但要講得出是幾天 —— 常數只有一份，不要在文案裡硬寫數字
import {
  POOL_DEFAULT_DAYS,
  FIRST_POOL_TICKET_CAP, FIRST_POOL_VALUE_CAP, FIRST_POOL_DONE_MEANING, firstPoolCapCheck
} from '@/shared/pool-settlement'
import { artUrlOf } from '@/lib/tcgdex-catalog'
import { useKeyboardInset } from '@/composables/useKeyboardInset'
import type { PickedCard } from '@/lib/card-pick'
import type { Pool, PoolMode, PoolPrize, Tier } from '@/types/models'
import PoolModeBadge from '@/components/PoolModeBadge.vue'
import CardPicker from '@/components/CardPicker.vue'

/* 逐張的例外設定住在貼底面板裡，而那張面板有四個要打字的欄位 ——
   鍵盤一升起來，面板下緣連同「從這個池移除」就躲到鍵盤底下。
   讓位的算法只有一份，見 composables/useKeyboardInset.ts。 */
useKeyboardInset()

const route = useRoute()
const sellers = useSellerStore()
const pools = usePoolStore()
/* 兩支都不會 reject —— 各自在 store 裡把例外吞掉了（見 stores/sellers.ts
   的 ensureLoaded 那段說明）。這裡原本有一顆 `.catch(() => {})`，
   那是還沒把修正下沉到 store 之前的權宜；留著會讓下一個人以為
   「這一頁特別需要接」，而其實是每一頁都不需要接。
   賣家清單載不到只會少掉「以既有的池為範本」，開池本身不受影響。 */
sellers.ensureLoaded()
pools.ensureLoaded()

/** mock 假資料裡的「我」。**只有 MOCK 模式能用**，理由見 mySellerId */
const me = computed(() => sellers.me)

/* ---- 賣家身分 ----
   這一頁原本只有一段「尚未通過身分驗證，請完成實名與金流帳戶驗證」加一顆
   「回首頁」—— 但平台上根本沒有申請的地方，sellers 資料列只有 seed 產得出來。
   等於叫使用者去做一件做不到的事。現在真的接上 /v1/seller/apply。

   MOCK 模式仍然讀 sellers store：那是展示用的假資料，把它換成「你不是賣家」
   會讓沒有後端時連開池表單都看不到。 */
/* seller.id 是**送出時要帶的賣家 id**（見下面的 mySellerId）。
   舊版這個型別只挑了 tier —— 只挑用得到的欄位本來是好習慣，但也正因為
   id 沒被挑進來，送出那一段只好去撈 mock 的 sellers.me，於是有了這次的 bug。 */
const remote = ref<{ seller: { id: string; tier: string } | null; verification: { status: string; note: string | null } | null } | null>(null)
const loadingSeller = ref(!MOCK)

/* ---- 「問不到」不是「你不是賣家」（走查 P5）----

   舊版是 `catch { remote.value = { seller: null, verification: null } }`
   —— 把請求失敗壓成「這個帳號沒有賣家資料」，而畫面對這兩件事的反應
   是同一個：整頁換成「先申請成為賣家」的表單。
   實測（後端進程被回收的那一刻剛好在這一頁）：一個**已經核准**的賣家
   看到的是一張申請表，唯一的按鈕是「送出申請」。他會以為資格被取消了；
   如果照著填一次，送出的是一份重複申請。

   伺服器是賣家資格的唯一真相，問不到就是**不知道**，不知道時唯一誠實的
   畫面是「現在讀不到，這跟你的資格無關，重試一次」。所以錯誤另外收在
   loadErr，remote 保持 null，兩種狀態在模板上是兩個分支。 */
const loadErr = ref('')

async function loadSeller() {
  loadingSeller.value = true
  loadErr.value = ''
  try {
    remote.value = await api.sellerStatus()
  } catch (e) {
    remote.value = null
    loadErr.value = e instanceof ApiError ? e.message : '連不上伺服器，請檢查網路後重試'
  } finally {
    loadingSeller.value = false
  }
}
onMounted(() => { if (!MOCK) loadSeller() })

const tier = computed(() => MOCK ? (me.value?.tier ?? null) : (remote.value?.seller?.tier ?? null))
const canList = computed(() => !!tier.value && tier.value !== 'pending')
const isPending = computed(() => tier.value === 'pending')

/* ---- 送出時的賣家 id ----

   **這一行就是「按下開池上架完全沒有反應」的根因。**

   舊版直接用 `sellers.me`，而那個 getter 是 `sellers.find(x => x.id === 's3')`
   —— 's3' 是 mock 假資料裡「關都卡舖」的 id，只存在於 src/mocks/data.ts。
   API 模式下 /v1/sellers 回來的 id 是 u-shop / u-seller 這一種真的 id，
   永遠找不到 s3，所以 me 恆為 undefined，submit() 走到 `if (!me.value) return`
   就靜靜結束：沒有送出任何請求、沒有錯誤、沒有一個像素改變。
   實測 393×852（12 籤、A 賞 4800、D 賞 36、72.2%）：
   按下去前後 scrollY 都是 9243、按鈕字都是「開池上架」、
   側欄的 innerHTML 逐字相同、network 一個 POST 都沒有、console 一片乾淨。

   真正的病不是那個 return，是**兩個不同源的身分判斷**：
   閘門（canList）看 remote.seller，送出卻看 sellers.me。
   只要兩邊不同源，遲早會長出「看得到表單、卻送不出去」這種畫面。
   所以這裡跟 tier 用同一個來源：MOCK 讀假資料、API 讀 /v1/seller/me。

   （API 模式其實根本不需要這個 id —— 後端從 token 取賣家，
   見 server/src/routes/pools.ts 的 `const me = c.get('userId')`。
   它在這裡只是 createPool 的型別上有這個欄位。） */
const mySellerId = computed<string | null>(() =>
  MOCK ? (me.value?.id ?? null) : (remote.value?.seller?.id ?? null))

/* ---- 申請成為賣家 ---- */
const apply = reactive({ name: '', origin: 'personal' as 'personal' | 'merchant', bio: '' })
const applyBusy = ref(false)
const applyErr = ref('')
const applyOk = ref(false)
const canApply = computed(() => apply.name.trim().length >= 2 && !applyBusy.value)

async function submitApply() {
  if (!canApply.value) return
  applyBusy.value = true
  applyErr.value = ''
  try {
    await api.applySeller({ name: apply.name.trim(), origin: apply.origin, bio: apply.bio.trim() })
    remote.value = await api.sellerStatus()
    applyOk.value = true
  } catch (e) {
    applyErr.value = e instanceof ApiError ? e.message : '申請失敗，請稍後再試'
  } finally {
    applyBusy.value = false
  }
}

/* 玩法。目前只有 muteki（無敵賞）是真的能用的：pools-service.ts 完全沒有讀
   pools.mode，抽卡一律照籤位發獎 —— 那就是無敵賞的規則。所以
     - classic / shitei 開得出來的話，賣的是後端不存在的規則（經典賞宣傳的
       「抽走最後一籤額外得最後賞」一行都沒有），那是對買家的不實陳述
   （連莊／競標原本也列在這裡，已經整組移除 —— 它們後端零實作，前端卻有完整
   的頁面會把人導進去，留著只是把死路做得更像活路。）
   讓賣家選得到等於讓他開一個對玩家壞掉的池，所以先鎖住，但仍然列出來 ——
   藏起來的話賣家不會知道之後會有這些玩法。後端補上模式邏輯後把 enabled 打開即可
   （同時要放寬建池 API 的 enum 與資料庫的 check，見 migration 016）。
   muteki 排在第一個：它是現在唯一開得出來的，預設選項不該還要往下找。 */
const MODES: { m: PoolMode; enabled: boolean }[] = [
  { m: 'muteki', enabled: true },
  { m: 'classic', enabled: false },
  { m: 'shitei', enabled: false }
]
const TIERS: Tier[] = ['A', 'B', 'C', 'D', 'LAST', 'BUST']
const tierLabel = (t: Tier) => t === 'BUST' ? '爆賞' : t === 'LAST' ? '最後賞' : `${t} 賞`

/**
 * 一個獎項。
 *
 * `pick` 是挑選器交回來的整包（含卡圖網址與變體標籤），`pick.card` 才是
 * 會被送出去、被雜湊進承諾的那一份身分。兩者分開放是因為卡圖與變體的
 * 中文標籤只給畫面看 —— 它們會變，不該進承諾。
 */
interface PrizeRow {
  pick: PickedCard
  tier: Tier
  qty: number
  /** 參考價（選填、只顯示、不參與計算）。卡冊卡本來就有，目錄卡是 null */
  unitValue: number | null
  /** 買回價**覆寫**。null = 照該賞別的預設走 */
  buyback: number | null
  /**
   * 從範本複製過來、但身分被刻意抽掉一半的列。
   *
   * 只會發生在「範本裡那一張是鑑定卡」的情況：一個鑑定編號對應一張實體卡，
   * 上一個池已經用掉了，複製過來等於宣告同一張 PSA #xxxx 有兩個得主。
   * 所以複製時把 certNo / grader / grade 拿掉，並在這裡標記成要重挑 ——
   * 不擋住的話賣家會開出一個「本來是 PSA 10、現在悄悄變成裸卡」的池。
   */
  needsRepick?: boolean
}

const form = reactive({
  title: '',
  mode: 'muteki' as PoolMode,
  ticketPrice: 300,
  shiteiTier: 'A' as Tier,
  /* 買回價的賞別預設。一個賞別一個絕對金額 —— 沒有基準、沒有比率。
     預設值刻意讓保底回饋率落在合理區間，賣家一開表單看到的就是一個過得了的池；
     留空的話第一眼看到的是一個被擋下的表單。
     只有實際用到的賞別需要有值（下面的 tiersUsed）。 */
  tierBuyback: { A: 4800, B: 1500, C: 500, D: 36, LAST: 6000, BUST: 36 } as Record<Tier, number>,
  prizes: [] as PrizeRow[]
})

/* ---- 挑卡 ↔ 獎項列 ----
   CardPicker 的 v-model 是一個 PickedCard[]，而這一頁要的是「每一張卡加上
   賞別、數量、價格」。用 computed 的 setter 把兩邊接起來，**以 form.prizes
   為單一事實來源** —— 兩個陣列各自存一份的話，移除一張卡時很容易只清掉其中一邊。 */
const pickedModel = computed<PickedCard[]>({
  get: () => form.prizes.map(r => r.pick),
  set: next => {
    const byKey = new Map(form.prizes.map(r => [r.pick.key, r]))
    form.prizes = next.map(p => byKey.get(p.key) ?? newRow(p))
  }
})

/**
 * 一張剛挑到的卡 → 一個獎項列的預設值。
 *
 * 第一張預設 A 賞、其餘 D 賞：賣家挑卡的順序幾乎都是「先挑那張主打的大卡，
 * 再補一堆保底」，猜對第一張省下最多次點擊。猜錯只要改一個下拉選單。
 */
function newRow(p: PickedCard): PrizeRow {
  return {
    pick: p,
    tier: form.prizes.length === 0 ? 'A' : 'D',
    qty: 1,
    // 卡冊卡帶著賣家自己標過的參考價；目錄卡沒有，留 null（不是 0）
    unitValue: p.card.refPrice ?? null,
    buyback: null
  }
}

function removePrize(i: number) {
  form.prizes.splice(i, 1)
}

/**
 * 這個池實際用到哪幾個賞別。沒用到的賞別不必填買回價，也不該擋住送出。
 *
 * 照 TIERS 的順序排，**不是挑卡的順序** —— 這一份現在同時是分頁列的順序，
 * 而分頁的位置一旦會隨著挑卡順序跳動，使用者剛學會「D 賞在最右邊」
 * 就會在下一次挑卡之後失效。
 */
const tiersUsed = computed(() => TIERS.filter(t => form.prizes.some(p => p.tier === t)))

/** 解析成每個獎品的絕對金額：個別覆寫優先，否則吃該賞別的預設 */
const resolved = computed(() =>
  form.prizes.map(p => p.buyback ?? form.tierBuyback[p.tier] ?? 0))

/** 同一條規則的單列版本。畫面上要一張一張顯示金額，用不到索引 */
const resolvedOf = (p: PrizeRow) => p.buyback ?? form.tierBuyback[p.tier] ?? 0

/* ---- 獎項配置的主軸：賞別，不是卡 ----

   這一段在 2026-08 從「一列一張卡」換成「一排賞別分頁，一次顯示一個賞別」。
   換掉的是**呈現**，業務規則一條都沒動（買回價仍然按賞別填、覆寫仍然是例外、
   參考價仍然不參與計算、鑑定卡仍然只能開 1 籤）。

   為什麼換：舊版一列有五個控制項，30 張卡就是 154 個控制項、6,732px 的列陣，
   而且手機上表頭是 display:none —— 三個數字框（數量／參考價／買回價覆寫）
   在填好值的常態下沒有任何可見標籤，長得一模一樣。詳細的量測見
   docs/prize-editor-proposal.md。

   分頁的代價是**沒被選到的賞別連同它們的錯誤一起離開 DOM**。原型量過：
   30 張、清空兩處買回價、停在沒問題的那一頁時，不點不捲看得到 0 個問題、
   看到第一個問題要 3 次點擊。所以這裡有三件事不是裝飾，是這個版面能不能用的前提：
     1. 分頁列**永遠列出全部用到的賞別**，缺東西的那一頁掛紅點（3 次 → 1 次）
     2. 被收起來的賞別缺什麼，缺的**內容**印在分頁列底下（1 次 → 0 次）
     3. 按送出時**自動切到出問題的那一頁並明說切了**，「還差什麼」的每一項
        也各自跳得到自己的分頁與欄位
   第 3 條不是偏好是正確性：沒有它，送出鈕會說「還差什麼」然後指向一個
   看不見的東西 —— 那正是這一頁修過兩次的「按了沒反應」。 */

/** 賞別的顏色。跟 DrawResultPage 同一份對應（爆賞沒有自己的色票，用 --ink） */
const TIER_VAR: Record<Tier, string> = {
  A: 'var(--tier-a)', B: 'var(--tier-b)', C: 'var(--tier-c)',
  D: 'var(--tier-d)', LAST: 'var(--tier-last)', BUST: 'var(--ink)'
}

/** 現在停在哪一個賞別分頁 */
const activeTier = ref<Tier>('A')

/**
 * 真正畫出來的那一頁。
 *
 * 不直接用 activeTier：卡片被移除或改賞別之後，原本停著的賞別可能整個消失，
 * 那時候要退回第一個還在的賞別，而不是畫一個空白的分頁。
 */
const curTier = computed<Tier | null>(() => {
  const u = tiersUsed.value
  if (!u.length) return null
  return u.includes(activeTier.value) ? activeTier.value : u[0]!
})

/** 這一賞有哪幾張卡 */
const cardsOf = (t: Tier) => form.prizes.filter(p => p.tier === t)

/**
 * 軌道上先畫幾張，其餘收成一顆「還有 N 張」。
 *
 * 為什麼要有上界：軌道是橫捲的，60 張卡就是一條 3,800px 的縮圖帶，
 * 使用者看到的是一條沒有盡頭的東西。收起來之後那顆鈕是**唯一**講得出
 * 「還有多少張」的地方，所以它是 sticky 的（見 CSS 那一段）。
 */
const RAIL_MAX = 8

/** 攤成垂直清單的賞別。一次只有一個 —— 分頁本來就一次只顯示一個賞別 */
const expandedTier = ref<Tier | null>(null)

/** 這一賞的摘要行。只印「只有這裡講得出來」的東西，重複的一律不印 */
function tierMeta(t: Tier): string {
  const mine = cardsOf(t)
  const seats = mine.reduce((s, p) => s + (Number.isInteger(p.qty) ? p.qty : 0), 0)
  const overrides = mine.filter(p => p.buyback != null).length
  const total = mine.reduce((s, p) => s + resolvedOf(p) * (Number.isInteger(p.qty) ? p.qty : 0), 0)
  /* 「抽到就能換 X 點」不印：X 就是同一列右邊那格輸入框裡的數字。
     「N 籤」只有跟張數不同時才是新資訊；「共承諾」只有在超過一籤時
     才不等於買回價本身。同一個數字寫兩次，刪掉的是重複不是資訊。 */
  return `${mine.length} 張`
    + (seats !== mine.length ? ` · ${seats} 籤` : '')
    + (seats > 1 && buybackValid(form.tierBuyback[t] ?? 0) ? ` · 共承諾 ${total.toLocaleString()} 點` : '')
    + (overrides ? ` · ${overrides} 張改過` : '')
}

/** 切分頁。順手收合攤開的清單 —— 展開是「我要逐張看這一賞」，換賞別就不成立了 */
function selectTier(t: Tier) {
  activeTier.value = t
  expandedTier.value = null
}

/* 分頁列的方向鍵。role="tablist" 一旦掛上去，鍵盤使用者就會用左右鍵找下一頁 ——
   掛了角色卻不接鍵，比不掛角色更糟：他按了沒反應，而畫面上明明有六個分頁。 */
function onTabKey(e: KeyboardEvent) {
  const u = tiersUsed.value
  if (!u.length) return
  const i = Math.max(0, u.indexOf(curTier.value as Tier))
  const j = e.key === 'ArrowRight' ? (i + 1) % u.length
    : e.key === 'ArrowLeft' ? (i - 1 + u.length) % u.length
    : e.key === 'Home' ? 0
    : e.key === 'End' ? u.length - 1
    : -1
  if (j < 0) return
  e.preventDefault()
  selectTier(u[j]!)
  nextTick(() => document.getElementById(`f-tab-${u[j]}`)?.focus())
}

/* ---- 逐張的例外：貼底面板 ----
   賞別、籤數、這一張的買回價、參考價、移除，全部收在這裡。
   常態下每張卡在畫面上是「縮圖 + 卡名 + 角標」，可互動控制項 0 個。 */
const sheetKey = ref<string | null>(null)
const sheetRow = computed(() => form.prizes.find(p => p.pick.key === sheetKey.value) ?? null)
function openCard(key: string) { sheetKey.value = key }
function closeSheet() { normalizeSheetNumbers(); sheetKey.value = null }

/**
 * `type=number` 清空的時候，`v-model.number` 交回來的是**空字串**不是 null。
 *
 * 對這兩格來說空值有意義：買回價空著＝沒有覆寫、參考價空著＝未標示。
 * 不收斂的話，清掉買回價那一格會被讀成「覆寫成一個不合法的金額」，
 * 賣家看到的是一句他做不出對應動作的錯誤；參考價則會把 `''` 送給後端。
 * 綁在 change（離開欄位）而不是 input：打字打到一半的空值不該當場報錯。
 */
function normalizeSheetNumbers() {
  const r = sheetRow.value
  if (!r) return
  if ((r.buyback as unknown) === '') r.buyback = null
  if ((r.unitValue as unknown) === '') r.unitValue = null
}
/** 面板裡改賞別：畫面跟著那張卡走，不然關掉面板之後它「不見了」 */
function setSheetTier(t: Tier) {
  const r = sheetRow.value
  if (!r) return
  r.tier = t
  selectTier(t)
}
/* Esc 關面板。監聽掛在 window 上而不是面板節點上 —— 面板是 Teleport 到 body 的，
   焦點不一定落在裡面（例如使用者剛從縮圖點開，焦點還在那顆縮圖上）。 */
function onSheetKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && sheetKey.value) closeSheet()
}
onMounted(() => window.addEventListener('keydown', onSheetKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onSheetKey))

function removeSheetCard() {
  const i = form.prizes.findIndex(p => p.pick.key === sheetKey.value)
  if (i >= 0) removePrize(i)
  closeSheet()
}

/** 這個池最差的賞別保底買回多少。池頁那句人話文案就是這個數字 */
const worstBuyback = computed(() => {
  const vs = resolved.value.filter(v => v > 0)
  return vs.length ? Math.min(...vs) : 0
})

const busy = ref(false)
const error = ref('')
/* 錯誤訊息那一塊的節點。要「量得到它在不在視窗裡」，就得抓得到它 */
const errBox = ref<HTMLElement | null>(null)
/* 開好的池。有值＝這一次送出成功了。
   **成功之後不再自動導頁**：舊版直接 router.push 到池詳情，而 API 模式建好的池
   是 committed（還沒開賣，要等 drand 的外部亂數，由後端每五分鐘的掃描推開，
   見 server/src/index.ts 的 sweepPools），賣家被丟到一個「還不能買」的頁面，
   沒有一句話解釋剛剛發生了什麼、也不知道要不要再按一次。
   改成就地留下一塊結果：講出池叫什麼、現在是什麼狀態、下一步點哪裡。
   順帶擋掉重複送出 —— 成功之後那顆按鈕整顆換成這一塊。 */
const created = ref<Pool | null>(null)
const doneBox = ref<HTMLElement | null>(null)
/* 撞到 CERT_ALREADY_LISTED 時，可以拿去申請接管的編號。
   平常是空的 —— 這個出口只在被擋住的那一刻存在，不是常駐的一顆按鈕。 */
const takeoverCerts = ref<{ certNo: string; grader: string }[]>([])

/* 即時試算。computeEconomics 內部走 shared/economics.ts，跟後端建池時
   用的是同一份門檻 —— 這一頁看到的綠燈跟伺服器的判斷不會分岔。 */
const econ = computed(() =>
  computeEconomics(
    form.mode,
    form.prizes.map((p, i) => ({ tier: p.tier, qty: p.qty, unitValue: p.unitValue ?? 0, buyback: resolved.value[i]! })),
    form.ticketPrice,
    { shiteiTier: form.shiteiTier }
  )
)
const blocked = computed(() => econ.value.verdict === 'mint' || econ.value.verdict === 'predatory')

/* ---- 首池額度（走查 P4）----

   新賣家的第一個池最多 100 籤、票收 100,000 點。這條規則以前**只存在於
   送出的那一瞬間**：賣家挑完 101 張卡、填完賞別、看著即時試算的綠字寫著
   「合格 / 保底回饋率 50.0%」，按下去才收到 403。這一頁其他每一條規則都是
   邊填邊講的，只有這一條是送出才講。

   ── 為什麼不做成第四種護欄狀態（FloorVerdict），而是獨立的一條 ──

   FloorVerdict 是**一個比率**的函式：floorVerdict(ratio) 進去一個數字、
   出來一句話，前後端共用同一份。首池額度不是那種東西：
     1. 它的輸入是「籤數、票收」加上**這個賣家的歷史**，不是那個比率。
        把它塞進 floorVerdict 等於逼 shared/economics.ts 去認識賣家 ——
        那個檔案是純函式，後端建池時也在用，弄髒它的代價比省下的多。
     2. 兩者正交：一個池可以同時「保底回饋率完全合理」與「超過首池額度」，
        而一個 enum 一次只講得出一件事。真的合併，賣家就會少看到一半。
     3. 修法不同。護欄不過是**永久**的（改數字才會消失），首池額度是
        **暫時**的（走完第一個池就沒了）。同一枚章講兩種期限只會讓人誤讀。
     4. 執行的地方也不同：護欄由 economics.ts 判、首池額度在 routes/pools.ts
        查完資料庫才判。合併會讓前端看起來像有權決定後者，它沒有。
   所以：economics 的判定照舊，首池額度是自己的一塊、自己的一句話。

   ── 「還沒解除」怎麼判 ──

   後端的判準是 `select count(*) from pools where seller_id = 我 and
   status in ('revealed','cancelled')`，前端沒有這支查詢，只有公開池清單
   （GET /v1/pools，回 committed/open/sold_out/revealed，最多 100 個）。
   所以這裡只拿得到**正面證據**：看得到自己的池已經 revealed，就一定解除了。
   （'cancelled' 不在公開清單裡，但它是過渡狀態 —— 到期收攤的池會被
   revealPool 揭曉成 revealed，所以只看 revealed 不會漏掉那條路。）

   看不到證據時當作「還沒解除」，跟後端同一邊 —— 但那是**推論不是事實**
   （清單只有最近 100 個池，老賣家的第一個池可能已經被擠出去了）。
   把推論當事實鎖死使用者，就是這次要修的那一類 bug（見上面 P5 那段）。
   所以畫面照實說這是推論，並留一顆「我已經完成過第一個池」的開關：
   按下去這一頁不再擋，送出時由伺服器 —— 唯一的權威 —— 判。 */
const firstPoolDone = computed(() => myPools.value.some(p => p.status === 'revealed'))

/** 賣家自己說「我已經完成過第一個池了」。只影響這一頁擋不擋，不影響伺服器 */
const capOverride = ref(false)

/** 這一頁要不要把首池額度算進去 */
const capOn = computed(() => !firstPoolDone.value && !capOverride.value)

/** 這個池目前的籤數 / 票收 對上兩條上限。判斷式跟後端同一份（shared） */
const cap = computed(() => firstPoolCapCheck(econ.value.seatCount, form.ticketPrice || 0))

/** 照現在這樣送出**一定**會被 403 擋下 */
const capBlocked = computed(() => capOn.value && cap.value.exceeded && !!form.prizes.length)

/* ---- 判定「章」上寫的字 ----

   使用者讀這一枚章讀的是「這個池到底開不開得成」，不是「保底回饋率這一項
   評分幾分」。所以：
     - 首池額度超標時章要先講那件事 —— 比率合理不代表按得下去，
       而舊版就是在一個注定 403 的池上蓋「合格」。
       底下那句「保底回饋率 50.0%，落在合理區間」照舊留著（它仍然是真的），
       兩句話合起來才是完整的：這一項沒問題，但被另一條擋住。
     - thin 蓋的是自己的章，不是 ok 那一枚（理由見 shared/economics.ts）。
     - 一張卡都還沒挑的時候不蓋任何判定：那不是「不合格」，那是還沒開始。
       （比率此時是 0%，照 floorVerdict 會落進 predatory。） */
const stamp = computed(() => {
  if (!form.prizes.length) return '還沒挑卡'
  if (capBlocked.value) return '超過首池額度，開不了'
  return FLOOR_VERDICT_STAMP[econ.value.verdict]
})
/** 章的顏色。thin 有自己的一檔 —— 跟 ok 同色正是 P12 的病 */
const stampTone = computed<'idle' | 'ok' | 'thin' | 'no'>(() => {
  if (!form.prizes.length) return 'idle'
  if (capBlocked.value || blocked.value) return 'no'
  return econ.value.verdict === 'thin' ? 'thin' : 'ok'
})

/* ---- 「還差什麼」是一份清單，不是一個布林 ----

   原本這裡是六個各自獨立的布林旗標，而**只有經濟那一項會顯示訊息** ——
   其餘五項不過就只是把送出鈕變灰。使用者實測時就卡在這裡：回饋率綠字寫著
   「落在合理區間」、卡名都填了、買回價也都在範圍內，按鈕卻按不動，
   而真正缺的是捲在畫面最上方看不到的池名稱。
   **一顆禁用的按鈕沒有辦法解釋自己**，那正是他卡住的全部原因。

   所以改成一份具名的問題清單：每一項都有一句「是什麼、怎麼修」，
   還有一個 anchor（要跳去哪一格）。送出鈕不再禁用 —— 按得下去、
   按下去就把第一個問題捲到眼前並聚焦。
   （為什麼不留禁用：禁用的按鈕在手機上連 hover 提示都沒有，
   使用者唯一能做的事是猜。可以按、按了會指路，比不能按誠實。） */
interface Problem {
  /** 對應的欄位。點清單那一項會捲過去並聚焦 */
  anchor: string
  msg: string
  /**
   * 這一項落在哪一個賞別分頁上。
   *
   * 分頁把沒被選到的賞別整個換出 DOM，所以「跳過去」的第一步是**切分頁**，
   * 不是捲動 —— 少了這個欄位，goTo() 會在 DOM 裡找一個還沒被畫出來的 id，
   * 然後留下一句「找不到那一格」。那就是又一次「按了沒反應」。
   */
  tier?: Tier
  /**
   * 這一項屬於哪一張卡。逐張的欄位（籤數、覆寫的買回價）住在貼底面板裡，
   * 「跳過去」＝切到那張卡的分頁 ＋ 打開那張卡的面板。
   */
  cardKey?: string
}

/**
 * 買回價不合法的賞別 —— 指的是**該賞別自己填的那一格**。
 *
 * 只有在「這一賞真的有卡在吃預設值」的時候才算數：整賞的卡都單獨覆寫過的話，
 * 那一格填什麼都不影響任何金額，拿它擋住送出等於要人去修一個不存在的問題。
 * （這條判斷跟舊版「解析後的值不合法」在結果上完全一樣，只是分得出是哪一格。）
 */
const badTiersDefault = computed(() => tiersUsed.value.filter(t =>
  form.prizes.some(p => p.tier === t && p.buyback == null) &&
  !buybackValid(form.tierBuyback[t] ?? 0)))

/** 單獨覆寫成不合法金額的那幾張卡。那一格住在面板裡，所以問題要指得到卡 */
const badOverrideRows = computed(() =>
  form.prizes.filter(p => p.buyback != null && !buybackValid(p.buyback)))

const problems = computed<Problem[]>(() => {
  const out: Problem[] = []
  if (!form.title.trim()) out.push({ anchor: 'f-title', msg: '池名稱還沒填' })
  if (!(form.ticketPrice > 0)) out.push({ anchor: 'f-price', msg: '每抽價格要大於 0' })
  if (!form.prizes.length) out.push({ anchor: 'f-picker', msg: '還沒有獎項 —— 先挑幾張卡' })
  /* 逐張的三條問題各自帶著**第一張出問題的卡**：訊息維持原本的聚合寫法
     （「有獎項的數量是空的」），但跳過去的時候要有一個具體的目標 ——
     籤數這一格現在住在那張卡的面板裡，指著整段獎項配置等於指著一個
     打不開的東西。修好第一張之後這一項會自動指向下一張。 */
  const badQty = form.prizes.find(p => !Number.isInteger(p.qty) || p.qty < 1)
  if (badQty) {
    out.push({ anchor: 'f-sheet-qty', msg: '有獎項的數量是空的或小於 1', tier: badQty.tier, cardKey: badQty.pick.key })
  }
  /* 有鑑定編號的卡只能開 1 籤 —— 一個編號對應一張實體卡。後端也擋（見
     routes/pools.ts 的 PrizeIn.refine），但那個錯誤要送出才看得到，
     而這裡挑完卡調數量的當下就該講。
     面板裡那一格已經改成不可輸入的「1 籤（固定）」，所以正常操作進不來 ——
     但範本複製與後端回來的資料仍可能帶 qty > 1，這條檢查是最後一道網。 */
  const badCert = form.prizes.find(p => p.pick.card.certNo && p.qty > 1)
  if (badCert) {
    out.push({
      anchor: 'f-sheet-qty', msg: '有鑑定編號的卡只能開 1 籤（一個編號對應一張實體卡）',
      tier: badCert.tier, cardKey: badCert.pick.key
    })
  }
  const badRepick = form.prizes.find(p => p.needsRepick)
  if (badRepick) {
    out.push({
      anchor: 'f-sheet', msg: '範本裡的鑑定卡要重挑（鑑定編號不能複製）',
      tier: badRepick.tier, cardKey: badRepick.pick.key
    })
  }
  /* 解析後每一項都要落在上下限內。爆賞也要 —— 爆賞發的是保底卡，
     那張卡一樣會被抽到、一樣可以被買回，沒有理由把它排除在承諾之外。
     檢查解析後的值而不是輸入格：漏填的賞別預設會解析成 0，一樣被這裡擋下。
     講得出是**哪一個賞別**缺 —— 只說「有賞別沒填」等於要使用者自己找。 */
  /* 一個賞別一項，不再把六個賞別擠成一句話：分頁版的每一項都必須跳得到
     **一個**看得見的東西，而「A 賞、D 賞的買回價…」這種合併訊息只跳得到其中一個。
     兩條檢查加起來跟原本那一條完全等價（覆寫的走下面那條、沒覆寫的走這條）。 */
  for (const t of badTiersDefault.value) {
    out.push({
      anchor: `f-tier-${t}`, tier: t,
      msg: `${tierLabel(t)}的買回價要落在 ` +
        `${BUYBACK_MIN.toLocaleString()} – ${BUYBACK_MAX.toLocaleString()} 點之間`
    })
  }
  for (const p of badOverrideRows.value) {
    out.push({
      anchor: 'f-sheet-buy', tier: p.tier, cardKey: p.pick.key,
      msg: `${p.pick.card.name} 單獨改過的買回價要落在 ` +
        `${BUYBACK_MIN.toLocaleString()} – ${BUYBACK_MAX.toLocaleString()} 點之間`
    })
  }
  /* 一張卡都還沒挑的時候不要抱怨「回饋率 0%」—— 那不是一個要修的問題，
     那只是還沒開始。同一個畫面上同時說「先挑幾張卡」跟「保底幾乎等於沒有」
     會讓人以為那是兩件事。 */
  if (blocked.value && form.prizes.length) out.push({ anchor: 'f-econ', msg: econ.value.message })
  /* 首池額度。放進這份清單而不是只印一行警語 —— 這份清單就是「按下去會不會
     成功」的定義，不放進來就等於明知道會 403 還讓他按。訊息的形狀刻意跟
     後端那句一樣（兩個上限、你這池的兩個數字），差別只在這裡是**事前**看到。 */
  if (capBlocked.value) {
    out.push({
      anchor: 'f-cap',
      msg: `超過第一個池的額度：上限 ${FIRST_POOL_TICKET_CAP} 籤、票收 ` +
        `${FIRST_POOL_VALUE_CAP.toLocaleString()} 點，這個池是 ${cap.value.tickets} 籤、` +
        `票收 ${cap.value.value.toLocaleString()} 點`
    })
  }
  return out
})
const valid = computed(() => problems.value.length === 0)

/** 這一個賞別的分頁上有沒有缺漏。分頁列上那顆紅點就是它 */
const tierHasProblem = (t: Tier) => problems.value.some(p => p.tier === t)

/**
 * 缺漏落在**別的分頁**上的那幾項。
 *
 * 這一份會被原封不動印在分頁列底下 —— 不是一句「其他分頁有問題」，是缺的內容本身。
 * 紅點只說「那一頁有事」，還是要按過去才知道是什麼事（原型量到 1 次點擊）；
 * 把內容留在畫面上才是 0 次。這一行是分頁版**唯一**能追平分組版的地方，
 * 不能為了版面好看拿掉。
 */
const offTabProblems = computed(() =>
  problems.value.filter(p => p.tier && p.tier !== curTier.value))

/** 從清單直接開一張卡：切到它的分頁再開面板（順序跟 jumpToProblem 一樣） */
function openCardRow(p: PrizeRow) {
  selectTier(p.tier)
  sheetKey.value = p.pick.key
}

/* 找不到那一格時留下的話。**不能是空的**：goTo() 原本查無元素就直接
   return，畫面上一個字都不會變 —— 那正是使用者說的「按了沒反應」。
   欄位會不會不存在？會：獎項表整段是 v-if，還沒挑卡時 #f-prizes 根本
   沒有被畫出來，而範本／數量那幾條問題的 anchor 都指著它。 */
const jumpMiss = ref('')

/**
 * 跳到出問題的那一格。
 *
 * 捲動 + 聚焦兩件都做：只捲動的話使用者還要自己找是哪一格（手機上一屏
 * 就有五六個輸入框），只聚焦的話在畫面外根本看不到焦點跑去哪了。
 *
 * 回傳有沒有跳成功 —— 呼叫端要知道，因為「跳失敗」也必須讓使用者看見。
 */
function goTo(anchor: string, msg?: string): boolean {
  const el = document.getElementById(anchor)
  if (!el) {
    /* 靜默失敗是這一頁最貴的一個 bug：使用者按下去、畫面完全沒動，
       他得到的結論是「這顆按鈕壞了」。所以查無元素時把那句話原地講出來，
       至少他知道要修什麼、也知道系統確實收到了那一下。 */
    jumpMiss.value = msg
      ? `找不到「${msg}」對應的欄位（那一區可能還沒出現）。先把上面的表單補齊再試一次。`
      : '找不到要修正的那一格，請往上檢查表單。'
    attemptSeq.value++
    return false
  }
  jumpMiss.value = ''
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  const focusable = el.matches('input, select') ? el : el.querySelector('input, select')
  ;(focusable as HTMLElement | null)?.focus({ preventScroll: true })
  return true
}

/**
 * 「還差什麼」清單上的一項 → 那一格。
 *
 * 分頁把 DOM 換掉了，所以順序是**先切分頁、（必要時）打開那張卡的面板、
 * 等重畫完，才輪得到 goTo() 去找節點**。反過來做的話 getElementById 會
 * 查無元素，畫面上只會多一句「找不到那一格」——「按了沒反應」的第三次。
 *
 * goTo() 自己不變（捲動 + 聚焦 + 查無元素時出聲），這裡只負責把它要找的
 * 那個節點先弄到 DOM 裡。
 */
async function jumpToProblem(p: Problem) {
  if (p.tier && tiersUsed.value.includes(p.tier)) selectTier(p.tier)
  /* cardKey 有值＝那一格在貼底面板裡。沒值的話要把面板關掉，
     不然使用者跳到「池名稱」，眼前卻還蓋著一張卡的面板。 */
  sheetKey.value = p.cardKey ?? null
  await nextTick()
  goTo(p.anchor, p.msg)
}

/* ---- 以這個池為範本再開一個 ----

   開池的人多半連續開類似的池（同一批貨拆成好幾個池、每週一檔同規格的場）。
   從零重挑三十張卡是這一頁最大的一段重複勞動。

   **複製什麼**：標題、玩法、票價、每一項的卡片身分與賞別、數量、參考價、
   買回價（賞別預設與逐項覆寫都還原）。這些是「這個池長什麼樣」。

   **不複製什麼**（而且不是漏了，是不能）：
     - 籤序、server_seed、commit hash：那是開池當下才產生的承諾。
       沿用等於把已經公布過的承諾套到一份不同的獎品清單上。
     - 到期日：由建池 API 從「現在」起算，複製一個過去的日期就是開一個已經死掉的池。
     - 已售籤數、狀態、池 id、保底回饋率：那些是上一個池發生過的事實，不是設定。
     - **鑑定編號**：一個編號對應一張實體卡，上一個池已經用掉了。
       複製過來等於宣告同一張 PSA #xxxx 有兩個得主 —— 而且第一個得主上架之後，
       第二個人會被 listings_cert_live 擋下並被告知「這張卡已經在市場上了」。
       所以鑑定資訊整組拿掉，那一列標成「要重挑」並擋住送出。
*/
/* 這裡原本也是讀 sellers.me，於是 API 模式下「以既有的池為範本」整段
   永遠不出現 —— 同一個病的另一個症狀，一起用 mySellerId 修掉 */
const myPools = computed(() =>
  mySellerId.value ? pools.pools.filter(p => p.sellerId === mySellerId.value) : [])

/** 範本用到的池。有就顯示一條提示，讓賣家知道現在這一份是從哪裡來的 */
const fromPool = ref<Pool | null>(null)

/** 一個既有池的獎項 → 挑選結果。卡圖從 artId 推，沒有 artId 就沒有圖 */
function pickFromPoolPrize(pr: PoolPrize): PickedCard {
  /* certNo / grader / grade 刻意抽掉（理由見上面）。其餘的卡面身分
     —— 卡名、套牌、卡號、卡圖、**變體** —— 全部保留：那是「這是哪一張卡」，
     跟「這是哪一個殼」是兩件事，前者複製得，後者複製不得。 */
  const card = { ...pr.card, certNo: null, grader: 'RAW' as const, grade: null }
  return {
    /* 鍵要跟來源池綁在一起：同一張卡在兩個不同的範本裡是兩次獨立的挑選，
       共用一個鍵的話第二次會被挑選器當成重複而靜靜吃掉。 */
    key: `tpl:${pr.id}`,
    source: 'catalog',
    card,
    variant: null,
    artUrl: pr.card.artId ? artUrlOf({ artId: pr.card.artId }) : null
  }
}

function useTemplate(p: Pool) {
  form.title = p.title
  form.mode = p.mode
  form.ticketPrice = p.ticketPrice
  form.prizes = p.prizes.map(pr => ({
    pick: pickFromPoolPrize(pr),
    tier: pr.tier,
    qty: pr.total,
    unitValue: pr.card.refPrice ?? null,
    // 買回價先原樣帶進覆寫格，下面再把「整個賞別都一樣」的那些收斂成賞別預設
    buyback: pr.buyback ?? null,
    needsRepick: !!pr.card.certNo
  }))

  /* 把逐項的買回價收斂回「賞別預設 + 例外覆寫」。
     不收斂的話賣家會看到每一格都填滿了覆寫值 —— 表單上那一格的意思是
     「這一張是例外」，全部填滿等於這個資訊消失了。
     同賞別裡出現最多次的金額當預設，其餘留在覆寫格。 */
  for (const t of new Set(form.prizes.map(r => r.tier))) {
    const rows = form.prizes.filter(r => r.tier === t && r.buyback != null)
    if (!rows.length) continue
    const count = new Map<number, number>()
    for (const r of rows) count.set(r.buyback!, (count.get(r.buyback!) ?? 0) + 1)
    const common = [...count.entries()].sort((a, b) => b[1] - a[1])[0]![0]
    form.tierBuyback[t] = common
    for (const r of rows) if (r.buyback === common) r.buyback = null
  }

  fromPool.value = p
  templateOpen.value = false
}

const templateOpen = ref(false)

/* 網址帶 ?from=<poolId> 就直接套用那個池。池清單是非同步載入的，
   所以要等它進來 —— onMounted 當下 pools.pools 多半還是空的。 */
watch(() => [route.query.from, pools.pools.length] as const, ([from]) => {
  if (!from || fromPool.value) return
  const p = pools.pools.find(x => x.id === from)
  if (p) useTemplate(p)
}, { immediate: true })

/** 按過送出。按過之後缺漏項才變紅 —— 一打開表單就滿江紅是在罵人，不是在幫忙 */
const attempted = ref(false)

/* ---- 按下去要有「就地」的回應 ----

   實測 393×852：把送出鈕捲到畫面正中央按一下，畫面捲了 2994px 到頁首，
   按鈕與「還差什麼」清單雙雙離開視窗 —— 使用者的結論是「按了沒反應」。
   捲動**不是**回饋：它把使用者剛剛在看的東西整個換掉，而在手機上他根本
   不會把那一下位移讀成「系統回答我了」。

   所以改成三件事：
     1. 「還差什麼」清單搬到**送出鈕正下方**。按鈕在哪裡，答案就在哪裡。
     2. 按下去只更新原地的狀態（清單轉紅、按鈕改字、冒出一行「哪一項擋住了」），
        **不自動捲動**。要跳到那一格是清單裡每一項自己的按鈕，由使用者決定。
     3. attemptSeq 每按一次就 +1，當成那一行的 :key —— 第二次、第三次按
        即使問題沒變，那一行也會重新掛載、重播一次動畫。沒有這個，
        「連按兩下」的第二下一樣是零回饋。 */
const attemptSeq = ref(0)

/**
 * 按送出時自動切到了哪一個賞別分頁（空字串＝沒有切）。
 *
 * 為什麼一定要切：「還差什麼」清單裡的第一項可能落在別的分頁上，
 * 而那一頁的內容此刻不在 DOM 裡 —— 一份指著看不見的東西的清單，
 * 跟一顆禁用的按鈕一樣沒有辦法解釋自己。
 *
 * 為什麼一定要**明說**切了：畫面自己動了卻不講，下一秒使用者就會以為
 * 分頁壞掉（他記得剛才停在 A 賞）。這一行跟切分頁是同一件事的兩半。
 * 位置在按鈕正下方那塊「還差什麼」裡 —— 按鈕在哪裡，回應就在哪裡，
 * **仍然不自動捲動**（那條決定沒有變）。
 */
const tabJumped = ref('')

/**
 * 送出。
 *
 * 外層再包一次 try：runSubmit 內部已經接住 API 的錯，走到這裡的只剩
 * **程式自己的例外**（讀到 null、型別對不上）。那種例外在 @submit.prevent
 * 底下會被 Vue 吞成 console 的 unhandled rejection —— 畫面上一個字都不會變，
 * 又是一次「按了沒反應」。所以最後一道：任何例外都要在按鈕底下留下一句話。
 */
async function submit() {
  try {
    await runSubmit()
  } catch (e) {
    console.error('[開池] 未預期的例外', e)
    error.value = '開池時出了預期外的錯，池沒有開成。請重新整理這一頁再試一次；'
      + '如果一直這樣，把這個畫面截圖給客服。'
    busy.value = false
    await nextTick()
    ensureVisible(errBox.value)
  }
}

async function runSubmit() {
  // 按鈕在 busy 時是 disabled，理論上進不來；擋住是為了鍵盤 Enter 連按
  if (busy.value) return
  attempted.value = true
  attemptSeq.value++
  jumpMiss.value = ''
  error.value = ''
  takeoverCerts.value = []
  tabJumped.value = ''
  /* 不 return 就算了：按鈕按得下去，按下去一定要有回應。回應在按鈕底下
     那塊 .todo（v-if 在 attempted 之後會多出一行 data-testid="submit-hitch"），
     不是把人送去別的地方。
     但獎項配置那一段現在是分頁的：缺漏可能落在一個沒被畫出來的賞別上。
     所以在留下回應之前先把那一頁切過來，並在回應裡明說切了。 */
  if (!valid.value) {
    const first = problems.value.find(p => p.tier)
    if (first?.tier && first.tier !== curTier.value) {
      selectTier(first.tier)
      tabJumped.value = tierLabel(first.tier)
    }
    return
  }

  /* 身分拿不到就**講出來**，不要靜靜 return（那正是這次的 bug）。
     走到這裡代表閘門放行了（canList 為真）卻拿不到 id，那是資料出了問題，
     使用者能做的只有重載，所以就直接把那句話講給他聽。 */
  const sellerId = mySellerId.value
  if (!sellerId) {
    error.value = '讀不到你的賣家身分，所以沒有送出。請重新整理這一頁；'
      + '如果重整後還是這樣，代表帳號的賣家資料有問題，請聯絡客服。'
    await nextTick()
    ensureVisible(errBox.value)
    return
  }

  busy.value = true
  try {
    const pool = await pools.createPool({
      sellerId,
      title: form.title.trim(),
      mode: form.mode,
      ticketPrice: form.ticketPrice,
      shiteiTier: form.mode === 'shitei' ? form.shiteiTier : undefined,
      /* 送出去的是**解析後的絕對金額**，不是「賞別預設 + 覆寫」這組規則。
         存規則的話，事後改一次賞別預設就等於回頭改寫已經公布的承諾。 */
      prizes: form.prizes.map((p, i) => ({
        tier: p.tier,
        /* 挑到的身分原封不動送出去（含 variantId）。參考價是這一列自己的欄位，
           所以最後蓋回 card 上 —— 賣家在表單上改的是這一格，不是挑卡時的原值。 */
        card: { ...p.pick.card, refPrice: p.unitValue },
        qty: p.qty,
          buyback: resolved.value[i]!
      }))
    })
    /* 成功。不導頁 —— 就地把結果留在按鈕原本的位置（理由見 created 的宣告）。
       nextTick 之後確認它真的在視窗裡：桌機的側欄可能整條捲在別處。 */
    created.value = pool
    await nextTick()
    ensureVisible(doneBox.value)
  } catch (e) {
    if (e instanceof ApiError && e.code === 'CERT_ALREADY_LISTED') {
      /* 「這個編號已經登記在系統裡了」是整條路上唯一一個**使用者做對了事
         卻走不下去**的錯誤：卡在他手上，但編號還掛在上一手名下。
         後端那句話的結尾是「請聯絡客服」—— 而平台上找客服的路他不見得知道。

         所以出口要接在被擋住的當下，不是叫他自己去翻客服頁：
         這裡把可以申請接管的編號列出來，一鍵帶著編號跳到開單頁並預填。
         這一步是整個工單功能的意義所在。 */
      error.value = e.message
      /* 後端只回 { error, message }，沒有講是哪一個編號撞到
         （mock 會多帶一組，見 lib/api.ts）。所以退回表單上**所有**有編號的卡，
         讓賣家自己指認是哪一張 —— 猜一張填進去比讓他選更糟：
         填錯的接管單要整張作廢重開。 */
      const hit = e.data as { certNo?: string; grader?: string } | null
      if (hit?.certNo) {
        takeoverCerts.value = [{ certNo: hit.certNo, grader: hit.grader || 'PSA' }]
      } else {
        const seen = new Set<string>()
        takeoverCerts.value = form.prizes
          .map(p => ({ certNo: p.pick.card.certNo ?? '', grader: p.pick.card.grader || 'PSA' }))
          .filter(c => c.certNo && !seen.has(c.certNo) && seen.add(c.certNo))
      }
    } else if (e instanceof ApiError && e.code === 'FIRST_POOL_CAP') {
      /* 走到這裡只有兩種可能：這一頁看漏了（公開池清單只有最近 100 個池），
         或賣家自己按過「我已經完成過第一個池了」而其實還沒。兩種都是
         **伺服器說了算**，所以把這一頁的檢查收回來 —— 額度那一塊會重新
         出現，籤數與票收對著上限即時走，他不必靠猜就知道要減多少。 */
      capOverride.value = false
      /* 後端那句話結尾是「完成第一個池之後就會解除」，而「完成」沒有定義過
         （走查 P14）—— 手上有三個已開賣、甚至已售完的池，照字面讀會以為
         早該解除了。定義只有一份，就接在它後面。 */
      error.value = `${e.message}（${FIRST_POOL_DONE_MEANING}）`
    } else {
      error.value = e instanceof ApiError ? e.message : '開池失敗，請稍後再試'
    }
    /* 錯誤訊息本身現在就貼在送出鈕底下，按完按鈕的人本來就在看那裡。
       但版面會因為 takeover 那一塊冒出來而長高，而且桌機的側欄可能整條
       捲在別的位置 —— 保險再確認一次它真的在視窗裡。**不是主要回饋**，
       只是最後一道保險：主要回饋是「按鈕正下方多出一塊紅的」。 */
    await nextTick()
    ensureVisible(errBox.value)
  } finally { busy.value = false }
}

/**
 * 只有在真的看不到的時候才捲。已經看得到卻硬捲一次，就是使用者抱怨的那種位移。
 *
 * 「看得到」不等於 `bottom <= 視窗高度`：這一頁的下緣在手機上**疊著兩層
 * 貼底的東西** —— 挑卡元件的「已選 N 張／查看清單」那條，以及底部分頁列。
 * 實測 393×852，結果面板量到 bottom 747（< 852，照舊規則算「看得到」），
 * 但第二顆出口「回我的賣場」實際上被那條貼底列蓋掉一半。
 * 被蓋住跟捲出視窗，對使用者是同一件事：他看不到。
 */
function ensureVisible(el: HTMLElement | null) {
  if (!el) return
  const r = el.getBoundingClientRect()
  const vh = window.innerHeight || document.documentElement.clientHeight
  if (r.top >= 0 && r.bottom <= vh - bottomOccluded()) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/**
 * 視窗下緣有多少像素是被貼底的東西蓋住的。
 *
 * 兩段高度都不是拍腦袋量的，是各自的來源本來就宣告過的：
 *   - 底部分頁列：高度讀 --nav-h（tokens.css），只在 720px 以下出現
 *   - 挑卡的貼底列：CardPicker 傳給 BottomActionBar 的 spacer=84，
 *     而它只在 900px 以下浮起來（CardPicker 的 wide 斷點，桌機是 inline）
 *
 * 高度讀權杖、斷點寫在這裡：**不要讀 --nav-total**。那一支的值是
 * `calc(56px + env(safe-area-inset-bottom))`，而自訂屬性不會被算成 px ——
 * getPropertyValue 拿到的是 `calc(...)` 這串字，parseFloat 直接 NaN。
 * 實測就是這樣靜靜退化成 0，結果面板在 393×852 停在 bottom 747 被蓋住。
 * （安全區那幾十像素沒算進來，而 84 的留白本來就比那條列高，蓋得住。）
 */
function bottomOccluded(): number {
  const navH = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 56
  const nav = window.matchMedia('(max-width: 720px)').matches ? navH : 0
  const picker = window.matchMedia('(min-width: 900px)').matches ? 0 : 84
  return nav + picker
}
</script>

<template>
  <div class="container page">
    <h1 class="display">開一個新的池</h1>

    <div v-if="loadingSeller" class="gate card"><p class="muted">確認賣家身分中…</p></div>

    <!-- 讀不到賣家資格。**這一格不能長得像申請表**：
         「問不到」跟「你不是賣家」是兩件事，而一張申請表等於在告訴一個
         已經核准的賣家「你的資格沒了」。所以這裡只講三件事：
         發生了什麼、它跟你的資格無關、按哪裡再試一次。 -->
    <div v-else-if="loadErr" class="gate card loadFail" data-testid="seller-load-failed" role="alert">
      <p class="big">讀不到你的賣家資格</p>
      <p class="muted">{{ loadErr }}</p>
      <p class="muted">
        這是<strong>這一頁問不到伺服器</strong>，不是你的資格有問題 ——
        已經通過審核的賣家資格不會因為這次連線失敗而改變，也<strong>不需要重新申請</strong>。
        連上之後這一頁就會直接變成開池表單。
      </p>
      <button type="button" class="btn primary retry" :disabled="loadingSeller" @click="loadSeller">
        再試一次
      </button>
    </div>

    <!-- 審核中：講清楚在等什麼、通過之前能做什麼，不要只寫「審核中」讓人乾等 -->
    <div v-else-if="isPending" class="gate card">
      <p class="big">申請已送出，等待審核</p>
      <p class="muted">
        平台不開放匿名上架，這是保護玩家不被詐騙的第一道防線。
        審核通過後這一頁就會變成開池表單，通過時你會收到站內通知。
      </p>
      <p v-if="remote?.verification?.status === 'rejected'" class="muted warnLine">
        上次送出的證件被退回{{ remote.verification.note ? '：' + remote.verification.note : '' }}。
        補件後會重新審核。
      </p>
      <RouterLink :to="{ name: 'home' }" class="btn">先去逛逛</RouterLink>
    </div>

    <!-- 還不是賣家：直接給申請表，不要給死路。
         不沿用 .gate —— 那個 class 是 text-align: center + justify-items: center，
         給一段說明文字用剛好，塞進表單就變成標籤置中、輸入框不撐開、
         身分那兩顆擠在中間看不出是可以選的。表單要自己的排版。 -->
    <div v-else-if="!canList" class="apply card">
      <header class="applyHead">
        <h2>先申請成為賣家</h2>
        <p>開池等於向別人收錢，平台要知道收錢的是誰。送出後由平台審核，通過才能開池。</p>
      </header>

      <p v-if="applyOk" class="okLine">申請已送出，審核結果會用站內通知告訴你。</p>

      <template v-else>
        <label class="af">
          <span class="afLabel">賣家名稱<i>必填</i></span>
          <input v-model="apply.name" type="text" placeholder="會顯示在池卡與訂單上" maxlength="30">
          <span class="afHint">兩個字以上。之後買家在市場與訂單上看到的就是這個名字。</span>
        </label>

        <div class="af">
          <span class="afLabel">身分</span>
          <!-- 分段控制：兩顆等寬、選中的填色。原本是兩顆小膠囊擠在置中的一行，
               看起來像兩個標籤而不是一組互斥選項 -->
          <div class="seg" role="radiogroup" aria-label="身分">
            <button
              type="button" role="radio" :aria-checked="apply.origin === 'personal'"
              class="segBtn" :class="{ on: apply.origin === 'personal' }"
              @click="apply.origin = 'personal'"
            >
              個人
              <small>自己的收藏</small>
            </button>
            <button
              type="button" role="radio" :aria-checked="apply.origin === 'merchant'"
              class="segBtn" :class="{ on: apply.origin === 'merchant' }"
              @click="apply.origin = 'merchant'"
            >
              商家
              <small>有店面或營業登記</small>
            </button>
          </div>
        </div>

        <label class="af">
          <span class="afLabel">簡介<i class="opt">選填</i></span>
          <input v-model="apply.bio" type="text" placeholder="例：主營朱紫系列鑑定卡" maxlength="60">
        </label>

        <p v-if="applyErr" class="warnLine">{{ applyErr }}</p>

        <button type="button" class="btn primary applyBtn" :disabled="!canApply" @click="submitApply">
          {{ applyBusy ? '送出中…' : '送出申請' }}
        </button>
        <!-- 按鈕變灰時要講為什麼。使用者看到一顆按不動的鈕，第一個念頭是「壞了」 -->
        <p v-if="!canApply && !applyBusy" class="afWhy">填好賣家名稱才能送出。</p>
      </template>
    </div>

    <!-- novalidate：把「還差什麼」的判斷**收斂成一份**。
         瀏覽器原生的表單驗證會在 submit 事件之前直接擋下送出，而且**一句話都不說**
         （手機上連那顆原生提示氣泡都常常看不到）—— 那正是「按了沒反應、
         也不知道為什麼」的來源，實測真的踩到了：
         `min="1" step="1"` 讓**預設**票價 300 變成 stepMismatch、
         `min="10" step="1"` 讓**預設** D 賞買回價 36 變成 stepMismatch，
         於是 @submit.prevent 的 submit() 從頭到尾沒有被呼叫過。
         （那兩個 step 也一併改對了，見下面的 step="1"。留 novalidate 是第二道防線：
         之後任何人再加一個有 min/step 的欄位，也不會又長出一條沉默的死路。） -->
    <form v-else class="layout" novalidate @submit.prevent="submit">
      <div class="main">
        <!-- ---------- 以這個池為範本 ---------- -->
        <section v-if="myPools.length" class="card block tpl">
          <div class="tplHead">
            <div class="tplText">
              <h2>以既有的池為範本</h2>
              <p class="muted">
                卡片、賞別、數量、票價、買回價一次帶進來。
                <strong>籤序、種子與到期日一定重新產生</strong>——那些是開池當下才成立的承諾。
              </p>
            </div>
            <button type="button" class="btn sm" @click="templateOpen = !templateOpen">
              {{ templateOpen ? '收起' : '挑一個範本' }}
            </button>
          </div>

          <ul v-if="templateOpen" class="tplList">
            <li v-for="p in myPools" :key="p.id">
              <button type="button" class="tplItem" @click="useTemplate(p)">
                <span class="tplName">{{ p.title }}</span>
                <span class="tplMeta muted">
                  {{ p.ticketPrice.toLocaleString() }} 點 · {{ p.totalTickets }} 籤 · {{ p.prizes.length }} 種獎項
                </span>
              </button>
            </li>
          </ul>

          <p v-if="fromPool" class="tplOn">
            已套用範本「{{ fromPool.title }}」。標題也一起複製了，
            <strong>記得改一個分得出來的名字</strong>。
          </p>
        </section>

        <section class="card block">
          <h2>基本設定</h2>
          <label class="field">
            <span>池名稱<i class="req">必填</i></span>
            <input
              id="f-title" v-model="form.title" type="text"
              placeholder="例如：朱紫 SAR 精選 第 2 彈"
              :class="{ missing: attempted && !form.title.trim() }"
            />
          </label>

          <span class="field-label">玩法</span>
          <p class="modeNote">目前開放無敵賞。經典賞與指定賞還在做，開放後會在這裡解鎖。</p>
          <div class="modes">
            <button
              v-for="o in MODES" :key="o.m" type="button"
              class="mode-btn" :class="{ on: form.mode === o.m, off: !o.enabled }"
              :disabled="!o.enabled"
              :title="o.enabled ? '' : '這個玩法還沒開放'"
              @click="o.enabled && (form.mode = o.m)"
            ><PoolModeBadge :mode="o.m" /></button>
          </div>
          <PoolModeBadge :mode="form.mode" detailed class="mode-rule" />

          <div class="row2">
            <label class="field">
              <span>每抽價格（點）<i class="req">必填</i></span>
              <input
                id="f-price" v-model.number="form.ticketPrice" type="number" min="1" step="1"
                :class="{ missing: attempted && !(form.ticketPrice > 0) }"
              />
            </label>
            <label v-if="form.mode === 'shitei'" class="field">
              <span>指定賞賞別</span>
              <select v-model="form.shiteiTier">
                <option v-for="t in ['A','B','C','D']" :key="t" :value="t">{{ t }} 賞</option>
              </select>
            </label>
          </div>
        </section>

        <!-- ---------- 挑卡 ---------- -->
        <section class="card block">
          <div class="block-head">
            <h2>挑卡</h2>
            <span class="chip">已挑 {{ form.prizes.length }} 張</span>
          </div>
          <p class="hint muted pickNote">
            從你的卡冊挑，或搜卡片目錄。挑到的卡會帶著<strong>卡號、系列、卡圖與版本</strong>
            進獎品，而且那份身分會被寫進公平性承諾——開賣後換卡會被驗算抓到。
            同一組卡號的不同版本（例如大師球鏡面與普卡）在系統裡是<strong>兩張不同的卡</strong>。
          </p>
          <div id="f-picker">
            <CardPicker v-model="pickedModel" :max="60" />
          </div>
        </section>

        <!-- ---------- 獎項配置 ----------
             主軸是**賞別**不是卡：上面一排賞別分頁，一次顯示一個賞別，
             買回價一個賞別填一次，逐張的例外收進點一下才開的貼底面板。
             換掉的只有呈現，業務規則一條都沒動（見 script 裡那一段長註解）。

             id 掛在 section 上而不是裡面某個 div：`f-prizes` 是「獎項配置這一段」的
             錨點，而它以前是一個被 v-if 掉的空 div —— 還沒挑卡的時候那個 id
             根本不存在，指著它的問題跳過去只會得到一句「找不到那一格」。 -->
        <section id="f-prizes" class="card block">
          <div class="block-head">
            <h2>獎項配置</h2>
            <span class="chip">共 {{ econ.seatCount }} 籤</span>
          </div>

          <p v-if="!form.prizes.length" class="empty">
            還沒挑卡。上面挑幾張，這裡就會照賞別分頁列出來讓你設買回價與數量。
          </p>

          <template v-else>
            <!-- 分頁列。**永遠列出全部用到的賞別**，不隨當前分頁增減：
                 分頁收起來的是內容，不是索引。缺東西的那一頁掛紅點 ——
                 原型量過，只做這一條就把「看到第一個問題」從 3 次點擊降到 1 次。
                 換行不橫捲：橫捲會把最右邊那顆分頁連同它的紅點推出畫面，
                 而「錯誤不會被藏起來」正是這個版面唯一撐得住的理由。 -->
            <div class="tabs" role="tablist" aria-label="賞別" @keydown="onTabKey">
              <button
                v-for="t in tiersUsed" :key="t" type="button" role="tab"
                :id="`f-tab-${t}`" :aria-controls="`f-tier-${t}`"
                class="tab" :class="{ on: curTier === t, bad: tierHasProblem(t) }"
                :aria-selected="curTier === t"
                @click="selectTier(t)"
              >
                <span class="tmark" :style="{ background: TIER_VAR[t] }" aria-hidden="true"></span>
                <span class="tabName">{{ tierLabel(t) }}</span>
                <span class="pn mono">{{ cardsOf(t).length }}</span>
                <span v-if="tierHasProblem(t)" class="tabWarn" aria-hidden="true"></span>
                <span v-if="tierHasProblem(t)" class="sr">這一頁有缺漏</span>
              </button>
            </div>

            <!-- 被收起來的賞別缺什麼 —— 印的是缺的**內容**，不是「有問題」四個字。
                 紅點只說「那一頁有事」，還是要按過去才知道是什麼事；
                 這一塊才是把「看到問題要幾次點擊」壓到 0 的那一條。
                 每一項也點得動，點下去就是切到那一頁並聚焦。 -->
            <div v-if="offTabProblems.length" class="offTab" data-testid="off-tab-problems">
              <p class="offTabCap">其他分頁還有 {{ offTabProblems.length }} 項缺漏：</p>
              <ul>
                <li v-for="p in offTabProblems" :key="p.anchor + p.msg">
                  <button type="button" class="offTabItem" @click="jumpToProblem(p)">
                    <span>{{ p.msg }}</span>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                </li>
              </ul>
            </div>

            <!-- 買回價的說明。回答的是「填了會怎樣」與「我該填多少」，
                 機制（雜湊、保留額、為什麼不是比率）收進底下的折疊 ——
                 賣家在填第一格的當下不會問那些，公平性那一塊也已經講過一次。 -->
            <p class="tbNote muted">
              <strong>買回價一個賞別填一次</strong>：填多少，抽到那一賞的人就能拿多少點跟你換走那張卡，
              錢從這個池的池款出。填高比較好賣，但那是你真的要付的錢。<strong>開賣後改不了。</strong>
              某一張要單獨調整，點那張卡。
            </p>
            <details class="whyAbs">
              <summary>為什麼買回價是一個絕對金額，不是比率？</summary>
              <p>
                比率要有基準，而唯一的基準是你自己填的參考價——那是循環論證：你把參考價填高，
                回饋率就自己變漂亮。金額則是你真的要付出去的錢，填高等於承諾多賠，
                所以這個數字不需要外部行情就是誠實的。<br>
                <strong>爆賞也要填</strong>：爆賞發的是保底卡，那張卡一樣會被抽到、一樣可以換回點數。
                每張 {{ BUYBACK_MIN.toLocaleString() }} – {{ BUYBACK_MAX.toLocaleString() }} 點。
              </p>
            </details>

            <!-- 當前這一個賞別。
                 標題列是三格：色標 ／ 名稱＋摘要 ／ 買回價。
                 買回價的標籤與輸入框**併進標題列**（原本各自佔一列，白拿兩列）；
                 輸入框收到 72px（四位數的金額不需要滿寬，滿寬是在說「這裡要填很多」，
                 那是假的），但高度維持 44px 的觸控下限。
                 「買回」兩個字不能省 —— 這一頁的整個論點就是「欄位在常態下
                 沒有可見標籤」，標籤可以縮、可以搬，不可以消失。 -->
            <section
              v-if="curTier" :id="`f-tier-${curTier}`" class="tierGroup"
              role="tabpanel" :aria-labelledby="`f-tab-${curTier}`"
              :class="{ bad: tierHasProblem(curTier) }"
            >
              <div class="tgHead">
                <span class="tmark lg" :style="{ background: TIER_VAR[curTier] }" aria-hidden="true"></span>
                <span class="tgName">
                  {{ tierLabel(curTier) }}
                  <span class="tgMeta">{{ tierMeta(curTier) }}</span>
                </span>
                <span class="tgBuy">
                  <label class="tgBuyLbl" :for="`f-buy-${curTier}`">買回</label>
                  <input
                    :id="`f-buy-${curTier}`" v-model.number="form.tierBuyback[curTier]"
                    type="number" :min="BUYBACK_MIN" :max="BUYBACK_MAX" step="1"
                    inputmode="numeric" placeholder="必填"
                    :aria-label="`${tierLabel(curTier)}的買回價，點每張`"
                    :class="{ missing: badTiersDefault.includes(curTier) }"
                  />
                  <span class="tgUnit">點/張</span>
                </span>
              </div>

              <p v-if="badTiersDefault.includes(curTier)" class="tgErr">
                這一賞的買回價要落在 {{ BUYBACK_MIN.toLocaleString() }} – {{ BUYBACK_MAX.toLocaleString() }} 點之間，
                {{ cardsOf(curTier).filter(p => p.buyback == null).length }} 張卡都受影響。
              </p>

              <!-- 攤成垂直清單。一次只攤一個賞別（分頁本來就一次一個），
                   而且展開之後沒有軌道，所以收合的路要另外給一條。 -->
              <template v-if="expandedTier === curTier">
                <ul class="tgList">
                  <li v-for="p in cardsOf(curTier)" :key="p.pick.key">
                    <button type="button" class="tgLine" :class="{ bad: p.needsRepick }" @click="openCard(p.pick.key)">
                      <span class="tgLineArt">
                        <img v-if="p.pick.artUrl" :src="p.pick.artUrl" :alt="''" loading="lazy" decoding="async">
                      </span>
                      <span class="tgLineName">
                        {{ p.pick.card.name }}
                        <span class="tgLineMeta">
                          {{ p.pick.card.setCode || '—' }} · {{ p.pick.card.cardNo || '—' }}
                          <template v-if="p.pick.card.certNo"> · #{{ p.pick.card.certNo }}</template>
                        </span>
                      </span>
                      <span class="tgLineNum mono">
                        <template v-if="p.qty > 1">{{ p.qty }} 籤 · </template>
                        {{ resolvedOf(p).toLocaleString() }}
                        <span v-if="p.buyback != null" class="ovr">改</span>
                      </span>
                    </button>
                  </li>
                </ul>
                <button type="button" class="tgFoot" @click="expandedTier = null">收合成縮圖</button>
              </template>

              <!-- 縮圖軌。RAIL_MAX 之後收成「還有 N 張」，而那顆鈕是 sticky 的：
                   不 sticky 的話它會被橫捲推出畫面，使用者看到的是一條
                   沒有盡頭的縮圖 —— 而它是唯一講得出「還有多少張」的東西。 -->
              <div v-else class="rail">
                <button
                  v-for="p in cardsOf(curTier).slice(0, RAIL_MAX)" :key="p.pick.key"
                  type="button" class="tile"
                  :class="{ wide: cardsOf(curTier).length === 1, bad: p.needsRepick }"
                  @click="openCard(p.pick.key)"
                >
                  <span class="tileArt">
                    <img v-if="p.pick.artUrl" :src="p.pick.artUrl" :alt="''" loading="lazy" decoding="async">
                    <span v-else class="ph" aria-hidden="true"></span>
                    <span v-if="p.qty > 1" class="tileTag">x{{ p.qty }}</span>
                    <span v-if="p.buyback != null" class="tileTag ovr">改</span>
                    <span v-if="p.pick.card.certNo" class="tileTag cert">{{ p.pick.card.grader }}</span>
                  </span>
                  <span class="tileName">{{ p.pick.card.name }}</span>
                  <!-- 只有一張卡的時候軌道沒有東西可以捲，八成的寬度是空的。
                       攤成一列，右邊那片空白改放卡名與卡號（本來要點開面板才看得到）。 -->
                  <span v-if="cardsOf(curTier).length === 1" class="tileWide">
                    <span class="tileWideName">{{ p.pick.card.name }}</span>
                    <span class="tileWideMeta">
                      {{ p.pick.card.setCode || '—' }} · {{ p.pick.card.cardNo || '—' }}
                      <template v-if="p.pick.variant"> · {{ p.pick.variant.label }}</template>
                      <template v-if="p.pick.card.certNo"> · #{{ p.pick.card.certNo }}</template>
                    </span>
                  </span>
                </button>
                <button
                  v-if="cardsOf(curTier).length > 1" type="button" class="railMore"
                  @click="expandedTier = curTier"
                >
                  {{ cardsOf(curTier).length > RAIL_MAX
                     ? `還有 ${cardsOf(curTier).length - RAIL_MAX} 張`
                     : '展開成清單' }}
                </button>
              </div>
            </section>

            <p class="tbLine">
              買家會看到：<strong class="mono">{{ form.ticketPrice.toLocaleString() }} 點一抽，最差的賞別保底買回 {{ worstBuyback.toLocaleString() }} 點</strong>
            </p>
          </template>

          <p class="hint muted">
            <strong>到期日</strong>不在這張表上：它由系統從開池的當下起算
            {{ POOL_DEFAULT_DAYS }} 天。到期只是停止販售——已經抽出去的卡照樣走完出貨與鑑賞期。
          </p>

          <p v-if="form.mode === 'muteki'" class="hint muted">
            無敵賞的「最後賞」就是籤池裡的一張獎品，它跟其他賞別一樣佔一個籤位，
            所有賞別的數量加總必須剛好等於總籤數。抽走最後一籤沒有額外贈獎。
          </p>
        </section>
      </div>

      <aside class="side">
        <!-- 即時試算。**送出前就要看得到**：護欄不過在送出時才被退回的話，
             賣家不知道是哪一格害的，只知道「開不了」。 -->
        <div id="f-econ" class="card econ" :class="[form.prizes.length ? econ.verdict : 'idle', { capBad: capBlocked }]">
          <h2>即時試算</h2>
          <dl class="figures live">
            <div><dt>票收</dt><dd class="mono">{{ econ.revenue.toLocaleString() }}</dd></div>
            <div><dt>保底回饋</dt><dd class="mono">{{ econ.floorValue.toLocaleString() }}</dd></div>
          </dl>
          <div class="ratio">
            <span class="mono big-num">{{ econ.ratio.toFixed(1) }}%</span>
            <span class="muted lbl">{{ FLOOR_RATIO_LABEL }}</span>
          </div>
          <!-- 判定的章。**看得見的字**，不再只有一個綠勾加一段 sr-only ——
               綠勾在 thin（93.3%）跟 ok（50%）上長得一模一樣，而那兩種池
               對賣家的意思天差地遠。圖示一律 inline SVG，手機版不放 emoji。 -->
          <p class="stamp" :class="stampTone" data-testid="econ-stamp">
            <svg v-if="stampTone === 'ok'" class="mark" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <svg v-else-if="stampTone === 'thin'" class="mark" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3.6l9 15.4H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
              <path d="M12 10v4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
              <circle cx="12" cy="17" r="1.1" fill="currentColor" />
            </svg>
            <svg v-else-if="stampTone === 'no'" class="mark" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
            </svg>
            <span>{{ stamp }}</span>
          </p>
          <!-- 一張卡都還沒挑的時候不要說「保底回饋率僅 0.0%，等於幾乎沒有保底，
               對玩家過於不利」—— 那個池還不存在，判它「對玩家不利」是在講一件
               沒發生的事。（「還差什麼」那份清單早就是這樣處理的，兩邊要一致。） -->
          <p class="verdict">{{ form.prizes.length ? econ.message : '先挑幾張卡、填好買回價，這裡就會即時算給你看。' }}</p>
          <p v-if="form.prizes.length" class="meaning muted">{{ FLOOR_RATIO_MEANING }}</p>
        </div>

        <!-- ---------- 首池額度 ----------
             這一塊**在還沒撞到之前就在**：籤數與票收邊填邊跟著上限走，
             不是按下去才收到 403。只在「看不到自己有完成過的池」時顯示 ——
             解除之後它就消失，不會變成一句對老賣家永遠沒有意義的常駐提醒。 -->
        <div
          v-if="capOn" id="f-cap" class="card cap" :class="{ over: capBlocked }"
          data-testid="first-pool-cap"
        >
          <h2>第一個池的額度</h2>
          <dl class="figures">
            <div :class="{ bad: capOn && cap.overTickets && form.prizes.length }">
              <dt>籤數</dt>
              <dd class="mono">{{ cap.tickets.toLocaleString() }} / {{ FIRST_POOL_TICKET_CAP.toLocaleString() }}</dd>
            </div>
            <div :class="{ bad: capOn && cap.overValue && form.prizes.length }">
              <dt>票收</dt>
              <dd class="mono">{{ cap.value.toLocaleString() }} / {{ FIRST_POOL_VALUE_CAP.toLocaleString() }}</dd>
            </div>
          </dl>
          <p v-if="capBlocked" class="capOver" data-testid="cap-over">
            照這樣送出會被擋下。
            {{ cap.overTickets ? `籤數超過 ${(cap.tickets - FIRST_POOL_TICKET_CAP).toLocaleString()} 支。` : '' }}
            {{ cap.overValue ? `票收超過 ${(cap.value - FIRST_POOL_VALUE_CAP).toLocaleString()} 點（降票價或減籤數都可以）。` : '' }}
          </p>
          <p class="capWhy muted">
            兩條各自獨立，任一條超過就開不了。
            這是給還沒完成過池的賣家設的：平台沒有收保證金，上限把「萬一沒出貨」的損失壓在一個有界的範圍內。
            <strong>完成第一個池之後就解除。</strong>{{ FIRST_POOL_DONE_MEANING }}
          </p>
          <!-- 這一頁判斷「有沒有完成過」靠的是公開池清單，那是**推論不是事實**
               （清單只有最近 100 個池）。推論錯的時候不能把人鎖死在這裡，
               所以留一條出口：關掉這一頁的檢查，讓伺服器去判。 -->
          <button type="button" class="capOff" @click="capOverride = true" data-testid="cap-override">
            我已經完成過第一個池了 —— 不要在這裡擋我
          </button>
        </div>
        <p v-else-if="capOverride" class="capNote" data-testid="cap-override-note">
          已關掉這一頁的首池額度檢查。伺服器仍然會照它自己的紀錄判 ——
          如果其實還沒完成，送出時會被擋下，並告訴你目前的籤數與票收。
          <button type="button" class="capBack" @click="capOverride = false">恢復檢查</button>
        </p>

        <div class="card fair">
          <h2>公平性</h2>
          <p class="muted">
            按下開池時，系統會把 {{ econ.seatCount }} 支籤的順序預先洗好並封存，
            公布 SHA-256 commit hash。完抽後公開種子，任何人都能驗算。
            封存的內容包含<strong>每一張卡的卡號與版本</strong>與你宣告的買回價，
            <strong>你自己也無法在開賣後更動。</strong>
          </p>
        </div>

        <!-- ---------- 開好了 ----------
             成功之後按鈕整顆換成這一塊：既是「它成功了」的證據，
             也順手擋掉重複送出（同一份表單再按一次就是第二個池）。 -->
        <div v-if="created" ref="doneBox" class="done" data-testid="submit-done" role="status">
          <p class="doneT">
            <svg class="doneIco" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
              <path d="M7.5 12.4l3 3 6-6.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>池開好了：{{ created.title }}</span>
          </p>
          <!-- 「開好了」跟「買得到了」不是同一件事，講清楚差在哪 ——
               不講的話賣家點進去看到一個不能買的池，會以為剛剛沒成功 -->
          <p class="doneP">
            <template v-if="created.status === 'open'">
              {{ created.totalTickets }} 支籤的順序已經封存，池現在就在架上，買家找得到。
            </template>
            <template v-else>
              {{ created.totalTickets }} 支籤的順序已經封存、公平性承諾已經產生。
              系統取到外部亂數之後會自動開賣（通常幾分鐘內），在那之前買家還買不到 ——
              這不是出錯，是承諾的隨機來源要等下一輪。
            </template>
          </p>
          <div class="doneBtns">
            <RouterLink
              class="btn primary doneGo" data-testid="done-go"
              :to="{ name: 'pool', params: { id: created.id } }"
            >去看這個池</RouterLink>
            <RouterLink
              v-if="mySellerId" class="btn doneGo" data-testid="done-mine"
              :to="{ name: 'seller', params: { id: mySellerId } }"
            >回我的賣場看全部的池</RouterLink>
          </div>
        </div>

        <!-- **刻意不禁用**：禁用的按鈕沒有辦法解釋自己，而這一頁的欄位多半
             捲在畫面外。按得下去，按下去底下就長出「還差什麼」。
             按鈕上的字也跟著換 —— 那是按下去當下**最靠近手指**的那個變化，
             使用者的視線本來就在按鈕上，不必去別的地方找回應。 -->
        <button
          v-else type="submit" class="btn primary go"
          :class="{ notyet: !valid, working: busy }" :disabled="busy" :aria-busy="busy"
        >
          <!-- 送出中要在按鈕上看得出來。只換文字不夠：使用者按完手指還壓在
               按鈕上，字被蓋住的機率不低，而且「封存籤序中…」跟「開池上架」
               長度相近，餘光掃過去像沒變。加一個會轉的圈，它是唯一
               一直在動的東西。 -->
          <svg v-if="busy" class="spin" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6" opacity=".3" />
            <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" />
          </svg>
          <span>{{ busy ? '封存籤序中…'
             : valid ? '開池上架'
             : attempted ? `還沒送出 —— 還差 ${problems.length} 項（見下方）`
             : '看看還差什麼' }}</span>
        </button>

        <!-- 送出中的說明。按鈕上只放得下五個字，而這一段等待有可能好幾秒
             （要跟 drand 拿外部亂數），沒有一句話說明的等待會被讀成當機。 -->
        <p v-if="busy" class="busyLine" data-testid="submit-busy" role="status">
          正在把 {{ econ.seatCount }} 支籤的順序洗好、封存，並產生公平性承諾。
          先不要離開這一頁或再按一次。
        </p>

        <!-- 「還差什麼」清單。位置刻意在**送出鈕正下方**：
             它原本在按鈕上面、而按下去又會把畫面捲到頁首，實測按鈕與清單
             會一起離開視窗（2994px → 0），使用者看到的就是「按了沒反應」。
             按鈕在哪裡，答案就要在哪裡。
             每一項都點得動 —— 缺的欄位常常捲在畫面外，只寫一句「請填寫」
             等於叫使用者自己去找是哪一格。 -->
        <div v-if="problems.length" class="todo" :class="{ hot: attempted }">
          <!-- 按下去的「收據」。:key 綁 attemptSeq，所以連按第二下也會
               重新掛載、重播一次動畫 —— 沒有它，第二下一樣是零回饋。 -->
          <p
            v-if="attempted" :key="attemptSeq" class="todoHit"
            data-testid="submit-hitch" :data-attempt="attemptSeq"
            role="alert"
          >
            <svg class="todoHitIco" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
              <path d="M12 7.5v5.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
              <circle cx="12" cy="16.6" r="1.2" fill="currentColor" />
            </svg>
            <span>收到了，但還開不了池：<strong>{{ problems[0]!.msg }}</strong></span>
          </p>
          <!-- 畫面自己動了就要講。缺漏落在別的賞別分頁上時，送出會把那一頁切過來
               （不切的話清單第一項指著一個不在 DOM 裡的東西），而不講的話
               使用者只會發現分頁莫名其妙換了，以為是壞掉。 -->
          <p v-if="attempted && tabJumped" class="todoTab" data-testid="tab-jumped">
            已幫你切到「{{ tabJumped }}」那一頁 —— 缺漏在那裡。
          </p>
          <p class="todoHead">還差 {{ problems.length }} 項才能開池</p>
          <ul>
            <li v-for="p in problems" :key="p.anchor + p.msg">
              <button type="button" class="todoItem" @click="jumpToProblem(p)">
                <span>{{ p.msg }}</span>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </li>
          </ul>
        </div>

        <!-- goTo() 找不到那一格。原本這個情況是 return，畫面上一個字都不會變 -->
        <p v-if="jumpMiss" class="jumpMiss" data-testid="jump-miss" role="alert">{{ jumpMiss }}</p>

        <!-- API 的錯誤。位置同樣在按鈕正下方：它原本在按鈕**上面**，
             而使用者按完按鈕視線就在按鈕與底下，看不到就等於沒發生。 -->
        <p v-if="error" ref="errBox" class="err" data-testid="submit-error" role="alert">{{ error }}</p>

        <!-- 編號已被登記：把出路接在錯誤訊息旁邊。
             使用者被擋住的當下就看得到下一步，而不是自己去找客服頁。 -->
        <div v-if="takeoverCerts.length" class="takeover" data-testid="takeover-box">
          <p class="takeoverT">這張卡真的在你手上嗎？</p>
          <p class="takeoverP">
            如果你是在站外買到這張實體卡，可以申請把編號接管到你名下。
            通過之後這張卡就是你的，開池與上架都不會再被擋。
          </p>
          <div class="takeoverBtns">
            <RouterLink
              v-for="c in takeoverCerts" :key="c.certNo"
              class="btn takeoverGo"
              data-testid="takeover-go"
              :to="{ name: 'support-new',
                     query: { kind: 'takeover', certNo: c.certNo, grader: c.grader, from: 'pool' } }"
            >申請接管 {{ c.grader }} #{{ c.certNo }}</RouterLink>
          </div>
        </div>
      </aside>
    </form>

    <!-- ---------- 單卡面板 ----------
         逐張的例外全部收在這裡：賞別、籤數、這一張的買回價、參考價、移除。
         沿用站上既有的 .sheetWrap / .sheet.hasFoot / .sheetFoot（MyCardsPage、
         LoginMethods 同一套），不是第六種面板。

         Teleport 到 body 的理由跟 MyCardsPage 一樣：position: fixed 的定位基準
         會被任何一個有 transform / filter / contain 的祖先搶走，那時候面板會被
         推出畫面外並被裁掉。這一頁的 .layout 之後隨時可能長出那種祖先。 -->
    <Teleport to="body">
      <div v-if="sheetRow" class="sheetWrap" @click.self="closeSheet">
        <div id="f-sheet" class="sheet card hasFoot" role="dialog" aria-modal="true" aria-label="編輯這一張卡">
          <button type="button" class="sheetClose" aria-label="關閉" @click="closeSheet">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" /></svg>
          </button>
          <h2>{{ sheetRow.pick.card.name }}</h2>
          <p class="sheetSub muted">
            {{ sheetRow.pick.card.setCode || '—' }} · {{ sheetRow.pick.card.cardNo || '—' }}
            <template v-if="sheetRow.pick.variant"> · {{ sheetRow.pick.variant.label }}</template>
            <template v-if="sheetRow.pick.card.certNo">
              · {{ sheetRow.pick.card.grader }}<template v-if="sheetRow.pick.card.grade"> {{ sheetRow.pick.card.grade }}</template>
              #{{ sheetRow.pick.card.certNo }}
            </template>
          </p>

          <p v-if="sheetRow.needsRepick" class="sheetWarn">
            範本裡這一張是鑑定卡。一個鑑定編號只對應一張實體卡，不能複製——
            請從這個池移除，再從卡冊重挑一張。
          </p>

          <div class="sf">
            <span>賞別</span>
            <div class="sheetTiers">
              <button
                v-for="t in TIERS" :key="t" type="button"
                :class="{ on: sheetRow.tier === t }" @click="setSheetTier(t)"
              >{{ tierLabel(t) }}</button>
            </div>
            <span class="fnote">改了之後畫面會跟著這張卡切到那一頁。</span>
          </div>

          <!-- id 掛在整格上而不是輸入框上：鑑定卡那一格根本沒有輸入框，
               而「有鑑定編號的卡只能開 1 籤」這條問題就是指著這裡。
               掛在輸入框上的話，那條問題跳過來會查無元素。 -->
          <div id="f-sheet-qty" class="sf">
            <span>籤數</span>
            <!-- 鑑定卡固定 1 籤：規則沒變，只是從「輸錯再報錯」改成「不可能輸錯」。
                 但範本複製與後端回來的資料仍可能帶 qty > 1，那時候要修得回來，
                 所以不是只畫一格死的文字，而是給一顆把它改對的鈕。 -->
            <template v-if="sheetRow.pick.card.certNo">
              <div class="locked" :class="{ bad: sheetRow.qty > 1 }">
                {{ sheetRow.qty > 1 ? `目前是 ${sheetRow.qty} 籤，只能是 1 籤` : '1 籤（固定）' }}
              </div>
              <button v-if="sheetRow.qty > 1" type="button" class="fixQty" @click="sheetRow.qty = 1">
                改成 1 籤
              </button>
              <span class="fnote">
                這張有鑑定編號 #{{ sheetRow.pick.card.certNo }}，一個編號只對應一張實體卡，
                開兩籤就會有兩個得主。
              </span>
            </template>
            <template v-else>
              <input
                v-model.number="sheetRow.qty" type="number" min="1" step="1"
                inputmode="numeric" aria-label="數量"
                :class="{ missing: !Number.isInteger(sheetRow.qty) || sheetRow.qty < 1 }"
              />
              <span class="fnote">同一張卡面要放幾支籤。</span>
            </template>
          </div>

          <div class="sf">
            <span>這一張的買回價</span>
            <input
              id="f-sheet-buy" v-model.number="sheetRow.buyback" type="number"
              :min="BUYBACK_MIN" :max="BUYBACK_MAX" step="1" inputmode="numeric"
              :placeholder="buybackValid(form.tierBuyback[sheetRow.tier] ?? 0)
                ? (form.tierBuyback[sheetRow.tier] ?? 0).toLocaleString()
                : '這一賞還沒填'"
              aria-label="這一張的買回價（留空照賞別預設）"
              :class="{ missing: sheetRow.buyback != null && !buybackValid(sheetRow.buyback), over: sheetRow.buyback != null }"
              @change="normalizeSheetNumbers"
            />
            <span class="fnote">
              <template v-if="buybackValid(form.tierBuyback[sheetRow.tier] ?? 0)">
                空著就照 {{ tierLabel(sheetRow.tier) }}的 {{ (form.tierBuyback[sheetRow.tier] ?? 0).toLocaleString() }} 點。
                只有這張在同一賞裡特別貴才要改。
              </template>
              <template v-else>
                {{ tierLabel(sheetRow.tier) }}本身還沒填買回價，這張也就沒有可以照的預設。
              </template>
            </span>
          </div>

          <div class="sf">
            <span>參考價（選填）</span>
            <input
              id="f-sheet-ref" v-model.number="sheetRow.unitValue" type="number" min="0" step="1"
              inputmode="numeric" placeholder="未標示" aria-label="參考價（選填）"
              @change="normalizeSheetNumbers"
            />
            <span class="fnote">只顯示給買家看，不構成承諾、不參與任何計算。空著就是「未標示」。</span>
          </div>

          <div class="sheetFoot">
            <button type="button" class="btn primary sheetDone" @click="closeSheet">完成</button>
            <button type="button" class="sheetDel" @click="removeSheetCard">從這個池移除</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ---- 賣家申請表 ---- */
.apply { padding: 20px; max-width: 460px; margin: 0 auto; }
.applyHead { margin-bottom: 18px; }
.applyHead h2 { font-size: 18px; margin: 0 0 6px; }
.applyHead p { margin: 0; font-size: 13px; line-height: 1.75; color: var(--muted); }

.af { display: block; margin-bottom: 16px; }
.afLabel {
  display: flex; align-items: center; gap: 6px;
  font-size: 12.5px; font-weight: 600; color: var(--ink); margin-bottom: 6px;
}
.afLabel i {
  font-style: normal; font-size: 10.5px; font-weight: 700;
  padding: 1px 6px; border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent);
}
.afLabel i.opt { background: var(--surface-3); color: var(--muted); }
/* 輸入框撐滿。這一頁其他地方的 input 是在窄側欄裡，所以沒設寬度 —— 這裡要自己給 */
.af input { width: 100%; padding: 11px 12px; font-size: 16px; border-radius: 10px; }
.afHint { display: block; margin-top: 5px; font-size: 11.5px; line-height: 1.6; color: var(--faint); }

.seg { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.segBtn {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 11px 8px; min-width: 0;
  border: 1px solid var(--line); border-radius: 12px;
  background: var(--surface-2); color: var(--muted);
  font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
}
.segBtn small { font-size: 10.5px; font-weight: 400; }
.segBtn.on {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-color: var(--accent); color: var(--accent);
}

.applyBtn { width: 100%; margin-top: 4px; }
.afWhy { margin: 8px 0 0; font-size: 12px; color: var(--muted); text-align: center; }
.okLine { font-size: 13.5px; line-height: 1.75; color: var(--ok); margin: 0; }

.modeNote { font-size: 12.5px; line-height: 1.65; color: var(--muted); margin: 0 0 8px; }
.mode-btn.off { opacity: .38; cursor: not-allowed; }

.warnLine { font-size: 13px; line-height: 1.7; color: #fcd34d; margin: 8px 0; }
.okLine { font-size: 13.5px; line-height: 1.7; margin: 10px 0 0; }

.page { padding-top: 28px; padding-bottom: 72px; }
h1 { font-size: 28px; margin: 0 0 20px; }
h2 { font-size: 15px; margin: 0 0 12px; }
.gate { padding: 30px; text-align: center; display: grid; gap: 12px; justify-items: center; }
.gate .big { font-size: 19px; font-weight: 600; margin: 0; }
.gate p { max-width: 460px; margin: 0; }

.layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 22px; align-items: start; }
/* grid 子元素預設 min-width: auto，卡圖與長卡名會把主欄撐爆（HANDOFF 2.1） */
.main { min-width: 0; }
.block { padding: 18px; }
.block + .block { margin-top: 18px; }
.block-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.block-head h2 { margin: 0; }

.field { display: grid; gap: 4px; margin-bottom: 14px; }
.field > span, .field-label { font-size: 12px; font-weight: 600; color: var(--muted); }
.field-label { display: block; margin-bottom: 6px; }
input, select {
  padding: 8px 10px; font-size: 14px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface); color: var(--ink);
  min-width: 0;
}
input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
input:disabled { background: var(--surface-2); color: var(--faint); }
input.missing { border-color: var(--danger); }
.row2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }

.modes { display: flex; flex-wrap: wrap; gap: 8px; }
.mode-btn {
  padding: 3px; border: 2px solid transparent; border-radius: 999px;
  background: none; opacity: .5;
}
.mode-btn.on { opacity: 1; border-color: var(--line); background: var(--accent-wash); }
.mode-rule { display: block; margin: 10px 0 16px; }

/* ---- 範本 ---- */
.tplHead { display: flex; align-items: flex-start; gap: 12px; }
.tplText { min-width: 0; flex: 1; }
.tplText h2 { margin: 0 0 4px; }
.tplText p { font-size: 12px; line-height: 1.7; margin: 0; }
.tplText strong { color: var(--ink); }
.tplList { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
.tplItem {
  display: grid; gap: 3px; width: 100%; min-width: 0; text-align: left;
  padding: 10px 12px; font: inherit;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--surface-2); color: var(--ink); cursor: pointer;
}
.tplItem:hover { border-color: var(--accent); }
.tplName { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tplMeta { font-size: 11.5px; }
.tplOn { font-size: 12px; line-height: 1.7; margin: 12px 0 0; color: var(--muted); }
.tplOn strong { color: var(--ink); }

.pickNote { margin: 0 0 14px; }

/* ---- 獎項配置：賞別分頁 ---- */
.empty {
  margin: 0; padding: 22px 14px; text-align: center;
  font-size: 13px; line-height: 1.7; color: var(--muted);
  border: 1px dashed var(--line); border-radius: 12px;
}

/* 分頁列。**換行不橫捲**：橫捲會讓最右邊那顆分頁連同它的紅點被推出畫面，
   而「錯誤不會被藏起來」是這個版面唯一撐得住的理由 ——
   紅點捲得掉，整個主張就垮了。代價是多佔一到兩行高度，這筆換得值。 */
.tabs {
  display: flex; flex-wrap: wrap; gap: 4px; min-width: 0;
  margin: 0 0 10px; padding: 2px 0 0;
  border-bottom: 1px solid var(--line);
}
.tab {
  position: relative; flex: none; min-width: 0;
  /* 44px 是可點目標的下限。分頁是這一段最常被按的東西 */
  display: flex; align-items: center; gap: 5px; min-height: 44px;
  padding: 0 12px; border: 0; border-bottom: 2px solid transparent;
  background: transparent; color: var(--muted);
  font: inherit; font-size: 12.5px; font-weight: 600; line-height: 1.3;
  white-space: nowrap; cursor: pointer;
}
.tab.on { color: var(--ink); border-bottom-color: var(--accent); }
.tab .pn { font-size: 11.5px; font-weight: 500; opacity: .8; }
.tmark { width: 9px; height: 9px; border-radius: 3px; flex: none; display: block; }
.tmark.lg { width: 12px; height: 12px; }
/* 缺東西的那一頁掛紅點。紅點**不隨分頁切換消失** ——
   分頁收起來的是內容，不是索引 */
.tabWarn { width: 9px; height: 9px; border-radius: 50%; background: var(--danger); flex: none; }
.sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* 被收起來的賞別缺什麼。紅點只說「那一頁有事」，這一塊說「是什麼事」 */
.offTab {
  margin: 0 0 12px; padding: 9px 10px; min-width: 0;
  border: 1px solid var(--danger); border-radius: 10px;
  background: var(--danger-wash);
}
.offTabCap { margin: 0 0 6px; font-size: 11.5px; font-weight: 700; color: var(--danger-ink); }
.offTab ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }
.offTabItem {
  display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; min-height: 44px;
  padding: 6px 10px; font: inherit; font-size: 12px; line-height: 1.5; text-align: left;
  border: 1px solid var(--line-soft); border-radius: 9px;
  background: var(--surface); color: var(--ink); cursor: pointer;
}
.offTabItem span { min-width: 0; flex: 1; }
.offTabItem svg { width: 14px; height: 14px; flex: none; color: var(--muted); }
.offTabItem:hover { border-color: var(--accent); }

.tbNote { font-size: 12px; line-height: 1.7; margin: 0 0 8px; }
.tbNote strong { color: var(--ink); }
/* 機制（為什麼不是比率、爆賞為什麼也要填）收進折疊：賣家在填第一格的
   當下問的是「填了會怎樣、我該填多少」，機制是他問了才要出現的東西 */
.whyAbs { margin: 0 0 12px; font-size: 12px; color: var(--muted); }
.whyAbs summary {
  display: flex; align-items: center; min-height: 44px;
  font-weight: 600; color: var(--ink); cursor: pointer;
}
/* display: flex 會把 <summary> 原生的三角形吃掉，而沒有三角形的摘要行
   讀起來就是一行普通的粗體字 —— 沒有人會去點它。自己畫一個。 */
.whyAbs summary::after {
  content: ''; flex: none; width: 7px; height: 7px; margin-left: 8px;
  border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted);
  transform: rotate(45deg) translate(-2px, -2px);
}
.whyAbs[open] summary::after { transform: rotate(-135deg) translate(-2px, -2px); }
.whyAbs summary::-webkit-details-marker { display: none; }
.whyAbs p { margin: 0 0 4px; line-height: 1.75; }
.whyAbs strong { color: var(--ink); }

/* ---- 一個賞別 ----
   標題列三格：色標 ／ 名稱＋摘要 ／ 買回價。
   買回價原本是「標籤一列＋輸入框一列」自己佔兩列，併進來之後這一列的高度
   由 44px 的輸入框決定，名稱與摘要塞在同一列的剩餘空間裡 —— 白拿兩列。 */
.tierGroup {
  border: 1px solid var(--line); border-radius: 14px;
  background: var(--surface-2); overflow: hidden; min-width: 0;
  scroll-margin-top: 76px;
}
.tierGroup.bad { border-color: var(--danger); }
.tgHead {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px; align-items: center; padding: 8px 12px;
}
.tgName { font-size: 14px; font-weight: 700; min-width: 0; line-height: 1.35; }
/* 摘要併進標題底下那半行。「抽到就能換 X 點」不印 ——
   X 就是同一列右邊三公分處那格輸入框裡的數字，同一個數字寫兩次。 */
.tgMeta {
  display: block; font-size: 11px; font-weight: 500; color: var(--muted); line-height: 1.45;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tgBuy { display: flex; align-items: center; gap: 5px; min-width: 0; }
/* 「買回」這兩個字不可以拿掉。這一頁的整個論點就是「欄位在常態下沒有
   可見標籤」—— 標籤可以縮、可以搬，不可以消失。 */
.tgBuyLbl { font-size: 11px; font-weight: 700; color: var(--muted); white-space: nowrap; }
/* 寬度收到 72px：四位數的金額不需要一個滿寬的框，框寬本來在說
   「這裡要填很多」，那是假的。**高度維持 44px**，那是觸控下限。 */
.tgBuy input {
  width: 72px; min-width: 0; min-height: 44px; padding: 8px;
  text-align: right; font-size: 14px;
}
.tgUnit { font-size: 11px; color: var(--muted); white-space: nowrap; }
.tgErr {
  margin: 0; padding: 0 12px 8px;
  font-size: 11.5px; font-weight: 600; line-height: 1.6; color: var(--danger-ink);
}

/* 縮圖軌 */
.rail {
  display: flex; gap: 8px; min-width: 0;
  overflow-x: auto; padding: 0 12px 10px;
  scroll-snap-type: x proximity; overscroll-behavior-x: contain;
}
.rail::-webkit-scrollbar { height: 5px; }
.rail::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
.tile {
  flex: none; width: 54px; min-width: 0; min-height: 44px; padding: 0;
  display: grid; gap: 3px; border: 0; background: transparent; color: var(--ink);
  font: inherit; scroll-snap-align: start; cursor: pointer;
}
.tileArt {
  position: relative; display: block; width: 54px; aspect-ratio: 63 / 88;
  border-radius: 6px; overflow: hidden; background: var(--surface-3);
  border: 2px solid transparent;
}
.tile.bad .tileArt { border-color: var(--danger); }
.tileArt img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tileArt .ph { display: block; width: 100%; height: 100%; }
.tileName {
  font-size: 10px; line-height: 1.3; color: var(--muted); text-align: left;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tileTag {
  position: absolute; left: 2px; bottom: 2px;
  padding: 0 3px; border-radius: 3px;
  background: rgba(0, 0, 0, .66); color: #fff;
  font-size: 9px; font-weight: 700; line-height: 1.6;
}
/* 有覆寫的卡要看得出來 —— 否則「例外」跟「照賞別走」長得一模一樣 */
.tileTag.ovr { left: auto; right: 2px; background: var(--gold-deep); color: #1a1614; }
.tileTag.cert { top: 2px; bottom: auto; }
/* 只有一張卡的時候軌道退化：沒有東西可以捲，八成的寬度是空的，
   卡名還被壓成 10px 擠在縮圖底下。攤成一列，右邊那片空白改放
   卡名與卡號（本來要點開面板才看得到），高度反而少一列。 */
.tile.wide {
  width: 100%; grid-template-columns: 54px minmax(0, 1fr);
  gap: 10px; align-items: center; text-align: left;
}
.tile.wide .tileName { display: none; }
.tileWide { display: grid; gap: 1px; min-width: 0; }
.tileWideName {
  font-size: 12.5px; font-weight: 600; color: var(--ink);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tileWideMeta {
  font-size: 11px; color: var(--muted);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 軌道尾巴那顆鈕**黏在右邊**。踩過的坑：軌道一橫捲，「還有 N 張」連同
   它的張數就被推出畫面，使用者看到的是一條沒有盡頭的縮圖 ——
   而它是唯一講得出「還有多少張」的東西。sticky 讓它捲不掉；
   代價是它會壓在中間某一張縮圖上，所以左邊給一道陰影表示「底下還有東西」。 */
.railMore {
  position: sticky; right: 0; flex: none; align-self: center;
  min-height: 44px; min-width: 44px; padding: 0 10px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface-2); color: var(--ink);
  font: inherit; font-size: 11.5px; font-weight: 600; white-space: nowrap; cursor: pointer;
  box-shadow: -16px 0 14px -5px var(--surface-2);
}

/* 攤成垂直清單 */
.tgList { list-style: none; margin: 0; padding: 0 12px 10px; display: grid; gap: 6px; }
.tgLine {
  display: grid; grid-template-columns: 26px minmax(0, 1fr) auto;
  gap: 10px; align-items: center; width: 100%; min-width: 0; min-height: 48px;
  padding: 4px 8px; font: inherit; text-align: left;
  border: 1px solid var(--line-soft); border-radius: 9px;
  background: var(--surface); color: var(--ink); cursor: pointer;
}
.tgLine.bad { border-color: var(--danger); }
.tgLineArt {
  display: block; width: 26px; aspect-ratio: 63 / 88;
  border-radius: 3px; overflow: hidden; background: var(--surface-3);
}
.tgLineArt img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tgLineName { font-size: 12.5px; font-weight: 600; min-width: 0; display: grid; gap: 0; }
.tgLineMeta {
  font-size: 10.5px; font-weight: 400; color: var(--muted);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tgLineNum { font-size: 12px; color: var(--muted); white-space: nowrap; }
.tgLineNum .ovr { color: var(--gold-deep); font-weight: 700; }
/* 展開之後沒有軌道，收合的路要另外給一條 */
.tgFoot {
  display: block; margin: 0 12px 10px; width: calc(100% - 24px); min-height: 44px;
  border: 1px solid var(--line); border-radius: 9px;
  background: var(--surface); color: var(--ink);
  font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
}

.tbLine { font-size: 12.5px; line-height: 1.7; margin: 12px 0 0; color: var(--muted); }
.tbLine strong { color: var(--ink); }

/* PSA 卡號對不上時的確認勾選（住在單卡面板裡）。用 grid 讓勾選框與文字對齊，
   文字自己會換行（min-width: 0 讓它縮得下，見 docs/HANDOFF.md 2.1）。 */
.certConfirm {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px;
  align-items: start; font-size: 11.5px; line-height: 1.6; color: var(--gold-deep);
  margin: 0 0 14px; cursor: pointer;
}
.certConfirm input { margin-top: 2px; }

/* ---- 單卡面板 ----
   .sheetWrap / .sheet / .sheetFoot 的形狀跟 MyCardsPage 的出貨面板同一套，
   只是這一頁沒有 BottomActionBar，所以自己寫一份 scoped 的。 */
.sheetWrap {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: flex-end; justify-content: center;
  background: var(--scrim);
  /* 下緣讓給軟鍵盤（--kb 由 useKeyboardInset 寫進根節點，預設 0） */
  bottom: var(--kb, 0px);
}
.sheet {
  position: relative; width: 100%; max-width: min(520px, 100vw); min-width: 0;
  overflow-x: hidden;
  /* 88% 而不是 88dvh：.sheetWrap 的高度已經扣掉鍵盤了 */
  max-height: min(88%, 720px); overflow-y: auto; overscroll-behavior: contain;
  border-radius: 18px 18px 0 0;
  padding: 18px 16px calc(18px + var(--safe-b, 0px));
}
.sheet h2 { font-size: 17px; margin: 0 6px 4px 0; padding-right: 42px; overflow-wrap: anywhere; }
.sheetSub { font-size: 11.5px; line-height: 1.6; margin: 0 0 14px; padding-right: 42px; }
.sheetClose {
  position: absolute; right: 10px; top: 10px;
  width: 44px; height: 44px; display: grid; place-items: center;
  border: 0; background: var(--surface-2); color: var(--muted);
  border-radius: 50%; cursor: pointer;
}
.sheetClose svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.sheetWarn {
  margin: 0 0 14px; padding: 9px 11px; min-width: 0;
  border-radius: 10px; background: var(--danger-wash); color: var(--danger-ink);
  font-size: 12px; line-height: 1.7; font-weight: 600;
}
.sf { display: grid; gap: 5px; margin-bottom: 14px; min-width: 0; }
.sf > span { font-size: 11.5px; font-weight: 700; color: var(--muted); }
.sf input { min-height: 44px; min-width: 0; font-size: 16px; }
.sf .fnote { font-size: 11.5px; font-weight: 400; color: var(--muted); line-height: 1.6; }
.sheetTiers { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.sheetTiers button {
  min-height: 44px; min-width: 56px; padding: 0 12px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--surface-2); color: var(--ink);
  font: inherit; font-size: 13px; cursor: pointer;
}
.sheetTiers button.on {
  background: var(--accent); border-color: var(--accent);
  color: var(--on-accent); font-weight: 700;
}
.locked {
  display: flex; align-items: center; min-height: 44px; padding: 0 10px; min-width: 0;
  border: 1px dashed var(--line); border-radius: 8px;
  color: var(--muted); font-size: 12.5px;
}
.locked.bad { border-color: var(--danger); color: var(--danger-ink); }
.fixQty {
  min-height: 44px; padding: 0 14px; align-self: start;
  border: 1px solid var(--danger); border-radius: 10px;
  background: transparent; color: var(--danger-ink);
  font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
}
/* 有覆寫的那一格標出來 —— 否則它跟「空著吃預設」長得一模一樣 */
.sf input.over { border-color: var(--accent); }
.sheet.hasFoot { padding-bottom: 0; }
.sheetFoot {
  position: sticky; bottom: 0; z-index: 1;
  margin: 12px -16px 0; padding: 10px 16px calc(12px + var(--safe-b, 0px));
  border-top: 1px solid var(--line); background: var(--surface);
  display: grid; gap: 8px; min-width: 0;
}
.sheetDone { width: 100%; min-height: 44px; }
.sheetDel {
  width: 100%; min-height: 44px;
  border: 1px solid var(--danger); border-radius: 10px;
  background: transparent; color: var(--danger-ink);
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
}

/* 要賣家確認的那幾張卡，接在錯誤訊息底下 */
.mismatch {
  margin: 10px 0 0; padding: 11px 13px; min-width: 0;
  border-radius: 12px; background: var(--surface-2);
  display: grid; gap: 8px;
}
.mismatchT { margin: 0; font-size: 12px; font-weight: 700; color: var(--ink); }
.mismatchGo {
  width: 100%; min-height: 44px; min-width: 0; padding: 8px 11px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--surface); color: var(--ink);
  font: inherit; font-size: 12.5px; line-height: 1.5; text-align: left;
  overflow-wrap: anywhere; cursor: pointer;
}
.mismatchGo:hover { border-color: var(--accent); }

.hint { font-size: 12px; margin: 12px 0 0; line-height: 1.55; }

.side { position: sticky; top: 76px; display: grid; gap: 14px; min-width: 0; }
.econ { padding: 16px; }
.econ.ok { background: var(--ok-wash); }
.econ.thin { background: var(--warn-wash); }
.econ.mint, .econ.predatory { background: var(--danger-wash); }
.ratio { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.big-num { font-size: 34px; font-weight: 600; }
.econ.ok .big-num { color: var(--ok); }
.econ.thin .big-num { color: var(--warn); }
.econ.mint .big-num, .econ.predatory .big-num { color: var(--danger); }
.lbl { font-size: 12px; font-weight: 600; }
/* 首池額度超標時整張卡轉紅：比率那一項合格，但這個池按下去一定被擋，
   卡片的底色講的是後者 */
.econ.capBad { background: var(--danger-wash); }

/* ---- 判定的章 ----
   四種判定四種寫法（見 shared/economics.ts 的 FLOOR_VERDICT_STAMP）。
   thin 用 --warn 而不是 --ok：它跟 ok 同色正是「合格」與「可能倒貼」
   互相抵消的來源。 */
.stamp {
  display: flex; align-items: center; gap: 7px; min-width: 0;
  margin: 8px 0 0; font-size: 13px; font-weight: 700; line-height: 1.45;
}
.stamp span { min-width: 0; }
.mark { width: 18px; height: 18px; flex: none; }
.stamp.ok { color: var(--ok); }
.stamp.thin { color: var(--warn-ink); }
.stamp.no { color: var(--danger-ink); }
.stamp.idle { color: var(--muted); font-weight: 600; }
.verdict { font-size: 12.5px; font-weight: 600; margin: 8px 0 0; line-height: 1.5; }
.meaning { font-size: 11.5px; margin: 6px 0 0; line-height: 1.6; }
.figures { display: grid; gap: 6px; margin: 0 0 12px; padding-bottom: 10px; border-bottom: 1px dashed var(--line); }
.figures div { display: flex; justify-content: space-between; gap: 8px; min-width: 0; font-size: 12.5px; }
dt { color: var(--muted); font-weight: 600; }
dd { margin: 0; font-weight: 600; }
/* ---- 首池額度 ----
   平常是一張安靜的卡（它只是一條要知道的規則），超標才轉紅。
   一開始就紅的話，一個籤數還在 12 的新賣家會以為自己已經做錯了什麼。 */
.cap { padding: 14px 16px; }
.cap.over { background: var(--danger-wash); }
.cap .figures { margin-bottom: 0; padding-bottom: 0; border-bottom: 0; }
/* 超標的是哪一條要指得出來 —— 兩條都寫著 x / y，只說「超過」等於要他自己比 */
.cap .figures div.bad dt, .cap .figures div.bad dd { color: var(--danger-ink); }
.capOver {
  margin: 10px 0 0; font-size: 12.5px; font-weight: 700; line-height: 1.6;
  color: var(--danger-ink);
}
.capWhy { font-size: 11.5px; line-height: 1.75; margin: 10px 0 0; }
.capWhy strong { color: var(--ink); }
/* 出口。低調（它是例外，不是常規動作），但**點得到**：44px 是可點目標的下限 */
.capOff {
  display: flex; align-items: center; width: 100%; min-height: 44px; margin-top: 8px;
  padding: 8px 0; font: inherit; font-size: 11.5px; line-height: 1.5; text-align: left;
  border: 0; background: none; color: var(--muted);
  text-decoration: underline; text-underline-offset: 3px; cursor: pointer;
}
.capOff:hover { color: var(--ink); }
.capNote {
  margin: 0; padding: 10px 12px; min-width: 0;
  border-radius: 10px; background: var(--surface-2);
  font-size: 11.5px; line-height: 1.75; color: var(--muted);
}
.capBack {
  display: inline-flex; align-items: center; min-height: 44px;
  padding: 0; margin-left: 4px;
  font: inherit; font-size: 11.5px; border: 0; background: none;
  color: var(--accent); text-decoration: underline; text-underline-offset: 3px; cursor: pointer;
}

/* ---- 讀不到賣家資格 ----
   .gate 是置中的說明版型，這一格沿用它（它就是一段說明 + 一個動作），
   只是需要一顆真的按得到的重試鈕 */
.loadFail .big { color: var(--danger-ink); }
.loadFail strong { color: var(--ink); }
.retry { min-height: 44px; padding: 0 20px; }

.fair { padding: 14px 16px; }
.fair p { font-size: 12px; margin: 0; line-height: 1.6; }
.fair strong { color: var(--ink); }
.go { width: 100%; padding: 13px 0; font-size: 15px; min-height: 48px; }
/* 按鈕上的字會從「看看還差什麼」變成「還沒送出 —— 還差 N 項（見下方）」，
   換行了也不能被裁掉：那句話就是回饋本身 */
.go { white-space: normal; line-height: 1.4; }
/* 還不能開池時**不變灰**（灰＝壞掉），改用低調的外框色：按得下去，
   按下去會告訴你還差什麼 */
.go.notyet { background: var(--surface-2); color: var(--muted); border: 1px solid var(--line); }
/* 送出中：轉圈跟文字並排。按鈕本來只有文字，多了圖示就要自己排 */
.go { display: flex; align-items: center; justify-content: center; gap: 8px; }
.go .spin { width: 17px; height: 17px; flex: none; animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
/* 關掉動態效果的人看不到轉圈，所以那時**文字**必須自己撐起回饋 ——
   圈不動就讓它停在原地當一個狀態圖示，底下的 .busyLine 才是主要說明 */
@media (prefers-reduced-motion: reduce) { .go .spin { animation: none; } }
.busyLine {
  margin: 0; padding: 9px 11px; min-width: 0;
  border-radius: 10px; background: var(--surface-2);
  font-size: 12px; line-height: 1.7; color: var(--muted);
}

/* ---- 開好了 ----
   用 --ok 的 wash 而不是 accent：這一塊要一眼讀成「成功」，
   而 accent 在這一頁到處都是（必填徽章、覆寫框線），分不出來。 */
.done {
  padding: 14px 15px; min-width: 0;
  border: 1px solid var(--ok); border-radius: 12px;
  background: var(--ok-wash);
}
.doneT {
  display: flex; align-items: flex-start; gap: 8px; min-width: 0;
  margin: 0; font-size: 14px; font-weight: 700; color: var(--ok-ink);
}
.doneT span { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.doneIco { width: 18px; height: 18px; flex: none; margin-top: 1px; }
.doneP { margin: 8px 0 0; font-size: 12px; line-height: 1.85; color: var(--muted); }
.doneBtns { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-top: 12px; }
/* 44px 是可點目標的下限，而這兩顆是成功之後唯一的出路 */
.doneGo {
  display: grid; place-items: center; min-height: 44px; padding: 0 14px; min-width: 0;
  font-size: 13px; text-decoration: none; white-space: normal; line-height: 1.4;
}
.err {
  margin: 0; padding: 10px 12px; min-width: 0;
  border-radius: 10px; border: 1px solid var(--danger);
  background: var(--danger-wash); color: var(--danger-ink);
  font-size: 12.5px; line-height: 1.7; font-weight: 600; overflow-wrap: anywhere;
}

/* 編號已被登記時的出口。用強調色的 wash 而不是紅底：
   它不是又一則錯誤，它是**解法**，要讀起來像一條路而不是第二個壞消息。 */
.takeover {
  margin: 10px 0 0; padding: 13px 15px; min-width: 0;
  background: var(--accent-wash); border-radius: var(--radius);
}
.takeoverT { margin: 0; font-size: 13px; font-weight: 700; color: var(--ink); }
.takeoverP { margin: 6px 0 0; font-size: 12px; line-height: 1.85; color: var(--muted); }
.takeoverBtns { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-top: 11px; }
.takeoverGo {
  min-height: 44px; padding: 0 16px; min-width: 0;
  font-size: 13px; text-decoration: none;
  /* 編號不截斷 —— 賣家要靠它認出是哪一張卡 */
  white-space: normal; overflow-wrap: anywhere;
}

/* ---- 還差什麼 ---- */
.todo {
  padding: 12px 14px; border-radius: 12px;
  border: 1px solid var(--line); background: var(--surface-2);
}
/* 按過送出之後才轉紅。一打開表單就滿江紅是在罵人，不是在幫忙 */
.todo.hot { border-color: var(--danger); background: var(--danger-wash); }
/* 「已幫你切到 X 那一頁」。用中性底色不用紅：它不是又一則錯誤，
   它是在解釋畫面剛剛為什麼自己動了 */
.todoTab {
  margin: 0 0 10px; padding: 8px 11px; min-width: 0;
  border-radius: 10px; background: var(--surface-2);
  font-size: 12px; line-height: 1.6; font-weight: 600; color: var(--muted);
}
.todoHead { margin: 0 0 8px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
.todo.hot .todoHead { color: var(--danger); }
.todo ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.todoItem {
  /* min-height 44：這一排是真的要用手指點的，44 是可點目標的下限 */
  display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; min-height: 44px;
  padding: 8px 11px; font: inherit; font-size: 12.5px; line-height: 1.55; text-align: left;
  border: 1px solid var(--line-soft); border-radius: 9px;
  background: var(--surface); color: var(--ink); cursor: pointer;
}
.todoItem span { min-width: 0; flex: 1; }
.todoItem svg { width: 14px; height: 14px; flex: none; color: var(--muted); }
.todoItem:hover { border-color: var(--accent); }

/* ---- 按下送出的「收據」 ----

   為什麼要有這一行，而不是只讓清單轉紅：轉紅是一個**只有前後對照才看得出來**
   的變化，使用者按下去的當下並沒有另一張截圖可以比。多出一整行字才是
   「我按了、它回答了」。動畫也是同一個理由 —— 位置固定不動，只有它自己在動，
   視線不會被帶走（自動捲動就是把視線整個帶走，那才是災難）。 */
.todoHit {
  display: flex; align-items: flex-start; gap: 8px; min-width: 0;
  margin: 0 0 10px; padding: 9px 11px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger-ink);
  font-size: 12.5px; line-height: 1.6; font-weight: 600;
  animation: hitIn .28s ease-out;
}
.todoHit strong { color: var(--ink); overflow-wrap: anywhere; }
.todoHit span { min-width: 0; flex: 1; }
.todoHitIco { width: 16px; height: 16px; flex: none; margin-top: 1px; }

@keyframes hitIn {
  0%   { opacity: 0; transform: translateY(-6px); }
  60%  { opacity: 1; transform: translateY(2px); }
  100% { opacity: 1; transform: translateY(0); }
}
/* 關掉動態效果的人一樣要看得到那一行，只是不要它跳 */
@media (prefers-reduced-motion: reduce) {
  .todoHit { animation: none; }
}

/* goTo() 找不到那一格時講的話。舊版這個情況是靜默 return —— 按了完全沒事發生 */
.jumpMiss {
  margin: 10px 0 0; padding: 9px 11px; min-width: 0;
  border-radius: 10px;
  background: var(--warn-wash); color: var(--warn-ink);
  font-size: 12px; line-height: 1.7; font-weight: 600;
}

/* 必填徽章。必填就要標出來 —— 使用者不該靠「按鈕按不動」推斷哪一格是必填的 */
.req {
  font-style: normal; font-size: 10px; font-weight: 700; margin-left: 6px;
  padding: 1px 5px; border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent);
}

@media (max-width: 900px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  .side { position: static; }
}
@media (max-width: 720px) {
  .page { padding-top: 20px; padding-bottom: 40px; }
  h1 { font-size: 21px; }
  .row2 { grid-template-columns: minmax(0, 1fr); }
  /* 分頁列在窄螢幕上收一點左右內距：六個賞別要放得下，而分頁一旦橫捲，
     最右邊那顆連同它的紅點就會被推出畫面（見 .tabs 那一段） */
  .tab { padding: 0 9px; gap: 4px; }
  .tplHead { flex-direction: column; align-items: stretch; }
}
</style>
