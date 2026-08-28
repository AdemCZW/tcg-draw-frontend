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
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSellerStore } from '@/stores/sellers'
import { api } from '@/lib/api'
import { ApiError } from '@/lib/http'
import { MOCK } from '@/lib/config'
import { usePoolStore } from '@/stores/pools'
import { computeEconomics } from '@/lib/economics'
import { BUYBACK_MIN, BUYBACK_MAX } from '@/lib/recycle'
import { buybackValid } from '@/shared/recycle'
import { FLOOR_RATIO_LABEL, FLOOR_RATIO_MEANING } from '@/shared/economics'
// 到期日不在這張表上，但要講得出是幾天 —— 常數只有一份，不要在文案裡硬寫數字
import { POOL_DEFAULT_DAYS } from '@/shared/pool-settlement'
import { artUrlOf } from '@/lib/tcgdex-catalog'
import type { PickedCard } from '@/lib/card-pick'
import type { Pool, PoolMode, PoolPrize, Tier } from '@/types/models'
import PoolModeBadge from '@/components/PoolModeBadge.vue'
import CardPicker from '@/components/CardPicker.vue'

const router = useRouter()
const route = useRoute()
const sellers = useSellerStore()
const pools = usePoolStore()
sellers.ensureLoaded()
pools.ensureLoaded()

const me = computed(() => sellers.me)

/* ---- 賣家身分 ----
   這一頁原本只有一段「尚未通過身分驗證，請完成實名與金流帳戶驗證」加一顆
   「回首頁」—— 但平台上根本沒有申請的地方，sellers 資料列只有 seed 產得出來。
   等於叫使用者去做一件做不到的事。現在真的接上 /v1/seller/apply。

   MOCK 模式仍然讀 sellers store：那是展示用的假資料，把它換成「你不是賣家」
   會讓沒有後端時連開池表單都看不到。 */
const remote = ref<{ seller: { tier: string } | null; verification: { status: string; note: string | null } | null } | null>(null)
const loadingSeller = ref(!MOCK)
onMounted(async () => {
  if (MOCK) return
  try { remote.value = await api.sellerStatus() }
  catch { remote.value = { seller: null, verification: null } }
  finally { loadingSeller.value = false }
})

const tier = computed(() => MOCK ? (me.value?.tier ?? null) : (remote.value?.seller?.tier ?? null))
const canList = computed(() => !!tier.value && tier.value !== 'pending')
const isPending = computed(() => tier.value === 'pending')

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
  /**
   * PSA 查到的卡跟這一張對不上時，後端回來的資訊（PSA 的卡號與主體）。
   * 有值時這一列會冒出一個「這確實是同一張卡」的確認勾選。
   * null / undefined = 沒有對不上的問題。
   */
  certMismatch?: { psaCardNumber: string | null; psaSubject: string | null } | null
  /** 賣家勾了「確實是同一張卡」。勾了才會把 certConfirmed 送給後端放行 */
  certConfirmed?: boolean
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

/** 這個池實際用到哪幾個賞別。沒用到的賞別不必填買回價，也不該擋住送出 */
const tiersUsed = computed(() => [...new Set(form.prizes.map(p => p.tier))])

/** 解析成每個獎品的絕對金額：個別覆寫優先，否則吃該賞別的預設 */
const resolved = computed(() =>
  form.prizes.map(p => p.buyback ?? form.tierBuyback[p.tier] ?? 0))

/** 這個池最差的賞別保底買回多少。池頁那句人話文案就是這個數字 */
const worstBuyback = computed(() => {
  const vs = resolved.value.filter(v => v > 0)
  return vs.length ? Math.min(...vs) : 0
})

const busy = ref(false)
const error = ref('')
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
}

/** 數量欄可以被清空成 NaN（type=number 清掉不是 0 而是空值），那會讓籤數變成 0 */
const qtyBad = computed(() =>
  form.prizes.some(p => !Number.isInteger(p.qty) || p.qty < 1))

const problems = computed<Problem[]>(() => {
  const out: Problem[] = []
  if (!form.title.trim()) out.push({ anchor: 'f-title', msg: '池名稱還沒填' })
  if (!(form.ticketPrice > 0)) out.push({ anchor: 'f-price', msg: '每抽價格要大於 0' })
  if (!form.prizes.length) out.push({ anchor: 'f-picker', msg: '還沒有獎項 —— 先挑幾張卡' })
  if (qtyBad.value) out.push({ anchor: 'f-prizes', msg: '有獎項的數量是空的或小於 1' })
  /* 有鑑定編號的卡只能開 1 籤 —— 一個編號對應一張實體卡。後端也擋（見
     routes/pools.ts 的 PrizeIn.refine），但那個錯誤要送出才看得到，
     而這裡挑完卡調數量的當下就該講。 */
  if (form.prizes.some(p => p.pick.card.certNo && p.qty > 1)) {
    out.push({ anchor: 'f-prizes', msg: '有鑑定編號的卡只能開 1 籤（一個編號對應一張實體卡）' })
  }
  if (form.prizes.some(p => p.needsRepick)) {
    out.push({ anchor: 'f-prizes', msg: '範本裡的鑑定卡要重挑（鑑定編號不能複製）' })
  }
  /* 解析後每一項都要落在上下限內。爆賞也要 —— 爆賞發的是保底卡，
     那張卡一樣會被抽到、一樣可以被買回，沒有理由把它排除在承諾之外。
     檢查解析後的值而不是輸入格：漏填的賞別預設會解析成 0，一樣被這裡擋下。
     講得出是**哪一個賞別**缺 —— 只說「有賞別沒填」等於要使用者自己找。 */
  const badTiers = tiersUsed.value.filter(t =>
    form.prizes.some((p, i) => p.tier === t && !buybackValid(resolved.value[i] ?? 0)))
  if (badTiers.length) {
    out.push({
      anchor: 'f-tierbuy',
      msg: `${badTiers.map(tierLabel).join('、')}的買回價要落在 ` +
        `${BUYBACK_MIN.toLocaleString()} – ${BUYBACK_MAX.toLocaleString()} 點之間`
    })
  }
  /* 一張卡都還沒挑的時候不要抱怨「回饋率 0%」—— 那不是一個要修的問題，
     那只是還沒開始。同一個畫面上同時說「先挑幾張卡」跟「保底幾乎等於沒有」
     會讓人以為那是兩件事。 */
  if (blocked.value && form.prizes.length) out.push({ anchor: 'f-econ', msg: econ.value.message })
  return out
})
const valid = computed(() => problems.value.length === 0)

/**
 * 跳到出問題的那一格。
 *
 * 捲動 + 聚焦兩件都做：只捲動的話使用者還要自己找是哪一格（手機上一屏
 * 就有五六個輸入框），只聚焦的話在畫面外根本看不到焦點跑去哪了。
 */
function goTo(anchor: string) {
  const el = document.getElementById(anchor)
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  const focusable = el.matches('input, select') ? el : el.querySelector('input, select')
  ;(focusable as HTMLElement | null)?.focus({ preventScroll: true })
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
const myPools = computed(() =>
  me.value ? pools.pools.filter(p => p.sellerId === me.value!.id) : [])

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

async function submit() {
  attempted.value = true
  /* **不 return 就算了**：按鈕按得下去，所以按下去一定要有回應。
     把第一個問題捲到眼前並聚焦 —— 使用者要的是「還差什麼」，不是一聲不響。 */
  if (!valid.value) { goTo(problems.value[0]!.anchor); return }
  if (!me.value) return
  error.value = ''
  takeoverCerts.value = []
  busy.value = true
  try {
    const pool = await pools.createPool({
      sellerId: me.value.id,
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
        buyback: resolved.value[i]!,
        /* 只有賣家勾過「確實是同一張卡」才送 certConfirmed。
           一般情況卡號對得上、根本不會用到這個旗標。 */
        certConfirmed: p.certConfirmed || undefined
      }))
    })
    router.push({ name: 'pool', params: { id: pool.id } })
  } catch (e) {
    /* PSA 查到的卡跟賣家挑的對不上：後端不硬擋，要賣家自己確認是不是同一張
       （PSA 是英文、目錄是日文，卡名無法字串相等）。把對不上的列標出來、
       冒出確認勾選，賣家勾了再送一次就會過。 */
    if (e instanceof ApiError && e.code === 'CERT_MISMATCH') {
      const list = (e.data as { mismatches?: { certNo: string; psaCardNumber: string | null; psaSubject: string | null }[] })?.mismatches ?? []
      for (const m of list) {
        const row = form.prizes.find(p => p.pick.card.certNo === m.certNo)
        if (row) row.certMismatch = { psaCardNumber: m.psaCardNumber, psaSubject: m.psaSubject }
      }
      error.value = e.message
    } else if (e instanceof ApiError && e.code === 'CERT_ALREADY_LISTED') {
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
    } else {
      error.value = e instanceof ApiError ? e.message : '開池失敗，請稍後再試'
    }
  } finally { busy.value = false }
}
</script>

<template>
  <div class="container page">
    <h1 class="display">開一個新的池</h1>

    <div v-if="loadingSeller" class="gate card"><p class="muted">確認賣家身分中…</p></div>

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

        <!-- ---------- 獎項配置 ---------- -->
        <section class="card block">
          <div class="block-head">
            <h2>獎項配置</h2>
            <span class="chip">共 {{ econ.seatCount }} 籤</span>
          </div>

          <!-- 買回價：一個賞別一個絕對金額。
               這一塊放在獎項表**之前** —— 它是主要的填法，逐項覆寫才是例外。 -->
          <section v-if="tiersUsed.length" id="f-tierbuy" class="tierBuy">
            <h3>買回價（依賞別）<i class="req">必填</i></h3>
            <p class="tbNote muted">
              你答應照這個價把卡買回來的金額，<strong>開賣前鎖死、開賣後改不了</strong>
              （它被寫進公平性承諾的雜湊裡）。玩家按下接受時，這筆錢直接從你這個池的保留額出。
              同一個賞別的卡價值本來就相近，所以填一個絕對金額就好，<strong>不需要任何基準</strong>。
            </p>
            <div class="tbGrid">
              <label v-for="t in tiersUsed" :key="t" class="tbCell">
                <span class="tbLbl">{{ tierLabel(t) }}</span>
                <input
                  v-model.number="form.tierBuyback[t]" type="number"
                  :min="BUYBACK_MIN" :max="BUYBACK_MAX" step="1"
                  :class="{ missing: !buybackValid(form.tierBuyback[t] ?? 0) }"
                />
              </label>
            </div>
            <p class="tbLine">
              買家會看到：<strong class="mono">{{ form.ticketPrice.toLocaleString() }} 點一抽，最差的賞別保底買回 {{ worstBuyback.toLocaleString() }} 點</strong>
            </p>
          </section>

          <p v-if="!form.prizes.length" class="empty">
            還沒挑卡。上面挑幾張，這裡就會列出來讓你設賞別與數量。
          </p>

          <template v-else>
            <div id="f-prizes"></div>
            <div class="prize-head">
              <span></span><span>卡片</span><span>賞別</span><span>數量</span><span>參考價/張</span><span>買回價/張</span><span></span>
            </div>
            <div v-for="(p, i) in form.prizes" :key="p.pick.key" class="prize-row" :class="{ bad: p.needsRepick }">
              <span class="art">
                <img v-if="p.pick.artUrl" :src="p.pick.artUrl" :alt="''" loading="lazy" decoding="async">
                <span v-else class="ph" aria-hidden="true"></span>
              </span>

              <span class="ident">
                <span class="idName">{{ p.pick.card.name }}</span>
                <span class="idMeta">
                  {{ p.pick.card.setCode || '—' }} · {{ p.pick.card.cardNo || '—' }}
                  <template v-if="p.pick.variant"> · {{ p.pick.variant.label }}</template>
                </span>
                <span v-if="p.pick.card.certNo" class="idCert">
                  {{ p.pick.card.grader }}<template v-if="p.pick.card.grade"> {{ p.pick.card.grade }}</template>
                  · #{{ p.pick.card.certNo }}
                </span>
                <span v-else-if="p.needsRepick" class="idWarn">
                  範本裡這一張是鑑定卡。一個鑑定編號只對應一張實體卡，不能複製——請從卡冊重挑一張。
                </span>
                <!-- PSA 查到的卡跟這一張的卡號對不上。PSA 是英文、目錄是日文，
                     卡名沒辦法直接比對，所以不硬擋 —— 讓賣家看過 PSA 查到的卡號後
                     自己確認是不是同一張，勾了才會放行。 -->
                <label v-if="p.certMismatch" class="certConfirm">
                  <input type="checkbox" v-model="p.certConfirmed" />
                  <span>
                    PSA 查到的卡號是「{{ p.certMismatch.psaCardNumber || '未提供' }}」<template
                      v-if="p.certMismatch.psaSubject">（{{ p.certMismatch.psaSubject }}）</template>，
                    跟你挑的「{{ p.pick.card.cardNo || '—' }}」對不上。確認是同一張卡再勾選並重新送出。
                  </span>
                </label>
              </span>

              <select v-model="p.tier" aria-label="賞別">
                <option v-for="t in TIERS" :key="t" :value="t">{{ tierLabel(t) }}</option>
              </select>
              <!-- 手機把表頭藏起來了（欄寬不夠），所以每一格自己要說得出自己是什麼。
                   少了 placeholder 的話手機上是三個一模一樣的數字框。 -->
              <input
                v-model.number="p.qty" type="number" min="1" aria-label="數量" placeholder="數量"
                :class="{ missing: p.pick.card.certNo && p.qty > 1 }"
              />
              <!-- 參考價選填：空著就是「賣家沒有標示」，畫面上顯示「未標示」。
                   不要退回成 0 —— 0 讀起來是「這張卡不值錢」。 -->
              <input
                v-model.number="p.unitValue" type="number" min="0" step="1"
                aria-label="參考價（選填）" placeholder="參考價（選填）"
              />
              <!-- 這一格是**覆寫**，不是必填：空著就照該賞別的預設走。
                   placeholder 直接顯示會套用的金額，讓「空著會發生什麼」看得見。 -->
              <input
                v-model.number="p.buyback" type="number" :min="BUYBACK_MIN" :max="BUYBACK_MAX" step="1"
                aria-label="買回價（留空照賞別預設）"
                :placeholder="(form.tierBuyback[p.tier] ?? 0).toLocaleString()"
                :class="{ missing: !buybackValid(resolved[i] ?? 0), over: p.buyback != null }"
              />
              <button type="button" class="del" @click="removePrize(i)" aria-label="移除這個獎項">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
              </button>
            </div>
          </template>

          <!-- 兩欄的意義完全不同，而且很容易被當成同一件事。講清楚 -->
          <p class="hint muted twoCols">
            <strong>參考價</strong>是你自己標示的市場行情，<strong>選填</strong>，
            只顯示給買家看、<strong>不構成承諾</strong>，也不參與任何金額計算。
            空著的話買家看到的是「未標示」。<br>
            <strong>買回價</strong>那一格是<strong>覆寫</strong>：空著就照上面該賞別的金額走，
            只有某一張在同賞別裡特別貴的時候才需要單獨填。
            每張 {{ BUYBACK_MIN.toLocaleString() }} 點起跳。
          </p>

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
        <div id="f-econ" class="card econ" :class="econ.verdict">
          <h2>即時試算</h2>
          <dl class="figures live">
            <div><dt>票收</dt><dd class="mono">{{ econ.revenue.toLocaleString() }}</dd></div>
            <div><dt>保底回饋</dt><dd class="mono">{{ econ.floorValue.toLocaleString() }}</dd></div>
          </dl>
          <div class="ratio">
            <span class="mono big-num">{{ econ.ratio.toFixed(1) }}%</span>
            <span class="muted lbl">{{ FLOOR_RATIO_LABEL }}</span>
            <!-- 圖示一律 inline SVG，手機版不放 emoji -->
            <svg v-if="!blocked && econ.seatCount" class="mark ok" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <svg v-else-if="blocked" class="mark no" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
            </svg>
            <span class="sr-only">{{ blocked ? '不合格，無法開池' : '合格' }}</span>
          </div>
          <p class="verdict">{{ econ.message }}</p>
          <p class="meaning muted">{{ FLOOR_RATIO_MEANING }}</p>
        </div>

        <div class="card fair">
          <h2>公平性</h2>
          <p class="muted">
            按下開池時，系統會把 {{ econ.seatCount }} 支籤的順序預先洗好並封存，
            公布 SHA-256 commit hash。完抽後公開種子，任何人都能驗算。
            封存的內容包含<strong>每一張卡的卡號與版本</strong>與你宣告的買回價，
            <strong>你自己也無法在開賣後更動。</strong>
          </p>
        </div>

        <!-- 「還差什麼」清單。**每一項都點得動**：缺的欄位常常捲在畫面外，
             只寫一句「請填寫」等於叫使用者自己去找是哪一格。 -->
        <div v-if="problems.length" class="todo" :class="{ hot: attempted }">
          <p class="todoHead">還差 {{ problems.length }} 項才能開池</p>
          <ul>
            <li v-for="p in problems" :key="p.anchor + p.msg">
              <button type="button" class="todoItem" @click="goTo(p.anchor)">
                <span>{{ p.msg }}</span>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </li>
          </ul>
        </div>

        <p v-if="error" class="err">{{ error }}</p>

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
        <!-- **刻意不禁用**：禁用的按鈕沒有辦法解釋自己，而這一頁的欄位多半
             捲在畫面外。按得下去、按下去把第一個問題捲到眼前並聚焦。 -->
        <button type="submit" class="btn primary go" :class="{ notyet: !valid }" :disabled="busy">
          {{ busy ? '封存籤序中…' : valid ? '開池上架' : '看看還差什麼' }}
        </button>
      </aside>
    </form>
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

/* ---- 獎項列 ---- */
.empty {
  margin: 0; padding: 22px 14px; text-align: center;
  font-size: 13px; line-height: 1.7; color: var(--muted);
  border: 1px dashed var(--line); border-radius: 12px;
}
.prize-head, .prize-row {
  /* minmax(0, …) 不是 1fr：grid 子元素預設 min-width: auto，
     長卡名會把整列撐爆（見 docs/HANDOFF.md 2.1） */
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 88px 60px 84px 84px 32px;
  gap: 8px; align-items: center;
}
.prize-head { font-size: 11.5px; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
.prize-row { margin-bottom: 8px; min-width: 0; }
.prize-row.bad { outline: 1px solid var(--danger); outline-offset: 4px; border-radius: 8px; }
.art {
  display: block; width: 34px; aspect-ratio: 63 / 88;
  border-radius: 4px; overflow: hidden; background: var(--surface-3);
}
.art img { width: 100%; height: 100%; object-fit: cover; display: block; }
.art .ph { display: block; width: 100%; height: 100%; }
.ident { display: grid; gap: 1px; min-width: 0; }
.idName {
  font-size: 13px; font-weight: 600; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.idMeta, .idCert { font-size: 11px; color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.idCert { color: var(--accent); }
.idWarn { font-size: 11px; line-height: 1.55; color: var(--danger); }
/* PSA 卡號對不上時的確認勾選。用 grid 讓勾選框與文字對齊，
   文字自己會換行（min-width: 0 讓它縮得下，見 docs/HANDOFF.md 2.1）。 */
.certConfirm {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px;
  align-items: start; font-size: 11px; line-height: 1.55; color: var(--gold-deep);
  margin-top: 3px; cursor: pointer;
}
.certConfirm input { margin-top: 2px; }
.del {
  display: grid; place-items: center;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface); color: var(--muted);
  padding: 8px 0;
}
.del svg { width: 15px; height: 15px; }
.del:hover { color: var(--danger); border-color: var(--danger); }

.tierBuy {
  margin: 0 0 16px; padding: 14px;
  border: 1px solid var(--line-soft); border-radius: 12px;
  background: var(--surface-2);
}
.tierBuy h3 { font-size: 13.5px; margin: 0 0 6px; }
.tbNote { font-size: 12px; line-height: 1.7; margin: 0 0 12px; }
.tbNote strong { color: var(--ink); }
/* auto-fit + minmax(0, …)：賞別數量會變，而 grid 子元素預設 min-width: auto
   會讓輸入框撐破容器（見 docs/HANDOFF.md 2.1） */
.tbGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
.tbCell { display: grid; gap: 4px; min-width: 0; }
.tbLbl { font-size: 11.5px; font-weight: 600; color: var(--muted); }
.tbCell input { width: 100%; min-width: 0; }
.tbLine { font-size: 12.5px; line-height: 1.7; margin: 12px 0 0; color: var(--muted); }
.tbLine strong { color: var(--ink); }
/* 有覆寫的那一格標出來 —— 否則它跟「空著吃預設」長得一模一樣 */
.prize-row input.over { border-color: var(--accent); }

.hint { font-size: 12px; margin: 12px 0 0; line-height: 1.55; }
.twoCols { line-height: 1.75; }
.twoCols strong { color: var(--ink); }

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
.mark { width: 18px; height: 18px; flex: none; align-self: center; margin-left: auto; }
.mark.ok { color: var(--ok); }
.mark.no { color: var(--danger); }
.verdict { font-size: 12.5px; font-weight: 600; margin: 8px 0 0; line-height: 1.5; }
.meaning { font-size: 11.5px; margin: 6px 0 0; line-height: 1.6; }
.figures { display: grid; gap: 6px; margin: 0 0 12px; padding-bottom: 10px; border-bottom: 1px dashed var(--line); }
.figures div { display: flex; justify-content: space-between; gap: 8px; min-width: 0; font-size: 12.5px; }
dt { color: var(--muted); font-weight: 600; }
dd { margin: 0; font-weight: 600; }
.fair { padding: 14px 16px; }
.fair p { font-size: 12px; margin: 0; line-height: 1.6; }
.fair strong { color: var(--ink); }
.go { width: 100%; padding: 13px 0; font-size: 15px; }
/* 還不能開池時**不變灰**（灰＝壞掉），改用低調的外框色：按得下去，
   按下去會告訴你還差什麼 */
.go.notyet { background: var(--surface-2); color: var(--muted); border: 1px solid var(--line); }
.err { color: var(--danger); font-size: 12.5px; font-weight: 600; margin: 0; }

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
.todoHead { margin: 0 0 8px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
.todo.hot .todoHead { color: var(--danger); }
.todo ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.todoItem {
  display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0;
  padding: 7px 9px; font: inherit; font-size: 12.5px; line-height: 1.55; text-align: left;
  border: 1px solid var(--line-soft); border-radius: 9px;
  background: var(--surface); color: var(--ink); cursor: pointer;
}
.todoItem span { min-width: 0; flex: 1; }
.todoItem svg { width: 14px; height: 14px; flex: none; color: var(--muted); }
.todoItem:hover { border-color: var(--accent); }

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
  .prize-head { display: none; }
  /* 手機一列變四行：
       1  卡圖 ｜ 卡片身分（跨兩欄）  ｜ ✕
       2  賞別 ｜ 數量
       3  參考價（整行）
       4  買回價（整行，它是這一列最重要的數字，不跟別的擠） */
  /* 四欄不是三欄：三欄時「數量」只分得到刪除鈕那一格（32px），
     實測輸入框的內容寬 36–47px 撐破 30px 的可視寬。中間兩欄各 1fr，
     賞別與數量才各拿得到約一半的寬度。 */
  .prize-row {
    grid-template-columns: 34px minmax(0, 1fr) minmax(0, 1fr) 32px;
    gap: 8px; padding: 10px; margin-bottom: 10px;
    border: 1px solid var(--line-soft); border-radius: 10px;
  }
  .prize-row > .art { grid-row: 1; grid-column: 1; }
  .prize-row > .ident { grid-row: 1; grid-column: 2 / 4; }
  .prize-row > .del { grid-row: 1; grid-column: 4; }
  .prize-row > select { grid-row: 2; grid-column: 1 / 3; }
  .prize-row > input:nth-of-type(1) { grid-row: 2; grid-column: 3 / 5; } /* 數量 */
  .prize-row > input:nth-of-type(2) { grid-row: 3; grid-column: 1 / 5; } /* 參考價 */
  .prize-row > input:nth-of-type(3) { grid-row: 4; grid-column: 1 / 5; } /* 買回價 */
  .tplHead { flex-direction: column; align-items: stretch; }
}
</style>
