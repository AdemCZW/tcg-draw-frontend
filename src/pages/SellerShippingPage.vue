<script setup lang="ts">
/**
 * 賣家的出貨與結算。
 *
 * 為什麼這一頁必須存在：抽卡池的結算已經整套做完了（票金貸記給賣家 →
 * 保留額 → 出貨 → 買家確認或鑑賞期滿 → 逐筆釋放），唯獨「賣家按已出貨」
 * 那一步前端一行都沒有。後果不是少一個按鈕，是**那條金流跑不完** ——
 * 賣家看得到保留額卻永遠拿不到，而買家的卡也永遠等不到。
 *
 * ── 為什麼這一頁要涵蓋兩種來源 ─────────────────────────────────────
 * 平台有兩條路會讓賣家欠一張實體卡：
 *   抽卡池被抽走      → pool_settlements，本來就在這一頁
 *   市場成交・需寄送  → orders（託管訂單），本來**只在 /orders**
 *   市場成交・庫內轉移 → 當場過戶，沒有東西要寄（所以這裡不會出現）
 *
 * 分成兩頁的代價不是不方便，是罰則：兩邊都是 72 小時沒出貨就自動結案 ——
 * 池那邊退款給買家並記一次違約（滿 SELLER_DEFAULT_LIMIT 次不能再開池），
 * 市場那邊取消訂單、退款並沒收保證金。賣家會因為「東西在另一個分頁」
 * 而被記違約。所以合併的判準是**責任**，不是資料表。
 *
 * 既有的 /orders 保留不動（那是買家也在用的頁面），兩套狀態機、時限、金流
 * 一行都沒有動 —— 這一頁只做三件事：把兩份清單合起來、標清楚哪個是哪個、
 * 讓兩邊的「我已寄出」在同一個地方按得到。
 *
 * 這一頁只回答三個問題，順序就是版面的順序：
 *   1. 我的錢在哪？   —— 可動用 vs 保留中，以及保留中的錢卡在哪個階段
 *   2. 快到期了嗎？   —— 逾期會罰，所以警告要在**逾期之前**
 *   3. 哪幾張要寄？   —— 待出貨清單，兩種來源混排，最急的在最上面
 *
 * 「錢在哪」擺在最上面而不是清單：賣家回到這一頁的頻率遠高於他真的有東西要寄，
 * 而每次回來要看的都是那個數字。清單為空時這一段仍然有話可說。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api, type SellerSettlement, type SellerWallet } from '@/lib/api'
import { MOCK } from '@/lib/config'
import CardArt from '@/components/CardArt.vue'
import CopyLine from '@/components/CopyLine.vue'
import BottomActionBar from '@/components/BottomActionBar.vue'
import SourceTag from '@/components/SourceTag.vue'
import {
  settlementDeadline, SELLER_DEFAULT_LIMIT,
  POOL_SHIP_DEADLINE_MS, POOL_INSPECT_MS, POOL_VAULT_ACCEPT_MS,
  type SettlementStatus
} from '@/shared/pool-settlement'
import {
  CARRIERS, remainText, validateTracking, deadlineOf,
  SHIP_DEADLINE, DELIVER_DEADLINE, INSPECT_WINDOW,
  HOUR, DAY, type Carrier
} from '@/shared/escrow'
import { shipToOf, type ShipTo } from '@/stores/orders'
import type { CardItem, Order, OrderStatus } from '@/types/models'

/* ---------------- 資料 ---------------- */

const rows = ref<SellerSettlement[]>([])
const orders = ref<Order[]>([])
const wallet = ref<SellerWallet>({ points: 0, locked: 0, reserved: 0, available: 0 })
const loading = ref(true)
const loadErr = ref('')

/**
 * 伺服器與這台電腦的時鐘差。倒數一律以伺服器為準。
 *
 * 沒有這個補正的話，使用者的電腦慢十分鐘，畫面就會說「還有時間」而後端
 * 早就判逾期並退款了 —— 而逾期的代價是一次違約，那不是可以「大概」的事。
 *
 * 兩種來源共用同一個 skew，因為它們是同一支 API 同一個 serverTime 帶回來的 ——
 * 分兩支拿會拿到兩個時鐘，而混排的清單就會用兩把不同的尺在比誰比較急。
 */
const skew = ref(0)
const now = ref(Date.now())

async function load() {
  loadErr.value = ''
  try {
    const r = await api.sellerSettlements()
    rows.value = r.settlements
    orders.value = r.orders
    wallet.value = r.wallet
    skew.value = r.serverTime - Date.now()
    now.value = Date.now() + skew.value
    /* 沒有待寄的東西時落在「等你寄出」是一片空白，但別的分頁其實有東西。
       自動退到第一個非空的分頁 —— **只在第一次載入**。出貨完成之後再跳一次
       會把人從剛按完的地方拖走，而那正是他要確認結果的地方。 */
    if (!tabPinned.value) {
      if (!toShip.value.length) tab.value = running.value.length ? 'run' : done.value.length ? 'done' : 'ship'
      tabPinned.value = true
    }
  } catch (e) {
    loadErr.value = e instanceof Error ? e.message : '讀取失敗'
  } finally {
    loading.value = false
  }
}

/* 每秒重算一次「現在」讓倒數會動。計時器一定要跟著元件收掉 ——
   留著的話它會持續替一個已卸載的元件排重繪，整個 app 會在 renderer 裡炸開
   （訂單頁實測過，見 OrdersPage 的註解）。 */
let tick: number | undefined
onMounted(() => {
  load()
  tick = window.setInterval(() => { now.value = Date.now() + skew.value }, 1000)
})
onUnmounted(() => clearInterval(tick))

/* ---------------- 合併成一種東西 ---------------- */

type Src = 'pool' | 'market'
type Bucket = 'ship' | 'run' | 'done'
type Tone = 'wait' | 'act' | 'ok' | 'bad'

/**
 * 兩種來源在畫面上共用的形狀。
 *
 * 為什麼要有這一層：清單要照「剩多少時間」混排，而排序不能認得兩種型別。
 * 但**合併的是顯示，不是規則** —— due 仍然各自由各自的 shared 函式算
 * （池走 settlementDeadline、市場走 deadlineOf），這裡一個時限都沒有重寫。
 */
interface Job {
  key: string
  src: Src
  id: string
  card: CardItem
  buyer: string
  memberNo: string | null
  /** 這筆錢的名字兩邊不一樣：池是票金，市場是貨款 */
  amount: number
  amountLabel: string
  /** 這筆是哪來的：池標題 / 市場成交 */
  origin: string
  bucket: Bucket
  due: { at: number; label: string; then: string } | null
  /** 逾期會罰到我。只有這種才會變紅、才會進警示區 */
  penal: boolean
  statusT: string
  statusSub: string
  tone: Tone
  /** 現在按得下「我已寄出」 */
  actionable: boolean
  /** 這一列的時限規則一句話。兩種來源的規則不同，混在一起不標會讓人用錯 */
  rule: string
  ship: ShipView
  /** 市場訂單專屬：逾期未出貨會沒收的保證金。池那條路沒有保證金 */
  deposit: number
}

/** 收件資訊攤平成畫面直接用得到的樣子，順便算出缺哪幾項 */
interface ShipView {
  name: string
  phone: string
  addr: string
  missing: string[]
  any: boolean
  /** 這個階段本來就還不該有地址（例如買家還沒申請出貨），不是「缺」 */
  expected: boolean
}
function shipViewOf(s: ShipTo | null | undefined, expected: boolean): ShipView {
  const trim = (v?: string) => (v ?? '').trim()
  const name = trim(s?.name)
  const phone = trim(s?.phone)
  const addr = [trim(s?.zip), trim(s?.city), trim(s?.line1)].filter(Boolean).join(' ')
  return {
    name, phone, addr,
    missing: [!name && '收件人', !phone && '電話', !addr && '地址'].filter(Boolean) as string[],
    any: !!(name || phone || addr),
    expected
  }
}

/* 時限的數字一律從常數推，不要在文案裡寫死 —— 規則改了文案要跟著改。
   兩行並列擺在這裡也是為了讓「兩套規則真的不一樣」這件事在程式碼裡就看得見。 */
const POOL_RULE =
  `抽卡池：買家申請後 ${Math.round(POOL_SHIP_DEADLINE_MS / HOUR)} 小時內出貨` +
  ` → 買家確認或 ${Math.round(POOL_INSPECT_MS / DAY)} 天鑑賞期滿才入帳` +
  `（沒申請的 ${Math.round(POOL_VAULT_ACCEPT_MS / DAY)} 天後自動入帳）`
const MARKET_RULE =
  `市場託管：成交後 ${Math.round(SHIP_DEADLINE / HOUR)} 小時內出貨` +
  ` → ${Math.round(DELIVER_DEADLINE / DAY)} 天送達 → ${Math.round(INSPECT_WINDOW / DAY)} 天驗收期滿放款`

/**
 * 資料庫的英文狀態不能直接吐給使用者看。
 *
 * 而且同一個狀態對買家與賣家的意思不一樣：`held` 對買家是「卡在保管庫」，
 * 對賣家是「先別寄，買家還沒說要」。所以這裡不共用 shared 的 SETTLEMENT_TEXT，
 * 那一份是中性描述，這一份是**站在賣家角度的下一步動作**。
 */
const POOL_UI: Record<SettlementStatus, { t: string; sub: string; tone: Tone }> = {
  held: { t: '買家還沒申請', sub: '這張卡還在買家的保管庫，你先不用寄。', tone: 'wait' },
  awaiting_ship: { t: '等你寄出', sub: '買家已經申請出貨，請在期限內寄給他。', tone: 'act' },
  shipped: { t: '你已寄出', sub: '等買家確認收貨；沒確認的話鑑賞期滿也算完成。', tone: 'wait' },
  released: { t: '已入帳', sub: '這筆票金已經變成可動用的點數。', tone: 'ok' },
  refunded: { t: '逾期未寄・已退還買家', sub: '這筆票金退回買家，並記你一次違約。', tone: 'bad' },
  recycled: { t: '買家賣回', sub: '卡回到你手上，這筆票金取消。', tone: 'wait' }
}

/** 市場訂單的賣家視角。同樣不共用 shared 的 STATUS_TEXT —— 那份是中性的 */
const MARKET_UI: Record<OrderStatus, { t: string; sub: string; tone: Tone }> = {
  escrowed: { t: '等你寄出', sub: '買家的貨款已經鎖在託管裡，請在期限內寄給他。', tone: 'act' },
  shipped: { t: '你已寄出', sub: '等買家確認收貨；沒有爭議的話送達後驗收期滿就放款。', tone: 'wait' },
  delivered: { t: '已送達・驗收中', sub: '買家的驗收期滿就放款給你。', tone: 'wait' },
  disputed: { t: '爭議處理中', sub: '平台在處理，請留意補件期限。', tone: 'bad' },
  completed: { t: '已完成', sub: '貨款已經入帳。', tone: 'ok' },
  refunded: { t: '已退款買家', sub: '這筆貨款退回買家。', tone: 'bad' },
  cancelled: { t: '已取消', sub: '這筆交易取消，貨款退回買家。', tone: 'bad' }
}

/** 抽卡池的一筆結算 → Job */
function poolJob(r: SellerSettlement): Job {
  /* 「票金已入帳，但卡還沒寄」（F-5）要算成**待出貨**，不是已結束。
     那幾列的狀態是 released，照字面會被歸到已結束分頁 —— 但它們仍然掛著
     一個出貨期限，逾期一樣記違約（只是不再退款）。躺在已結束裡的那一列
     正是賣家最不會再點開的一列，而它其實還欠著一張卡。
     後端的 /settlements/:id/ship 本來就收這個狀態，是前端一直沒讓人按到。 */
  const owes = r.owesCard
  const ui = owes
    /* 徽章要短 —— 它排在卡名右邊那一欄，長句子會折成三行把整列撐高。
       完整的話留給下面那行 sub。 */
    ? { t: '已入帳・欠卡', sub: '票金已經結算，但這張卡還沒寄出。逾期記你一次違約，票金不會退款。', tone: 'act' as Tone }
    : POOL_UI[r.status]
  const actionable = r.status === 'awaiting_ship' || owes
  return {
    key: 'pool:' + r.id,
    src: 'pool',
    id: r.id,
    card: r.card,
    buyer: r.buyerName || '買家',
    memberNo: r.buyerMemberNo,
    amount: r.amount,
    amountLabel: '票金',
    origin: r.poolTitle,
    bucket: actionable ? 'ship'
      : r.status === 'held' || r.status === 'shipped' ? 'run' : 'done',
    due: settlementDeadline({
      id: r.id, status: r.status, createdAt: r.createdAt,
      shipDueAt: r.shipDueAt, shippedAt: r.shippedAt
    }),
    penal: actionable,
    statusT: ui.t,
    statusSub: ui.sub,
    tone: ui.tone,
    actionable,
    rule: POOL_RULE,
    /* 地址只有在出貨義務還活著時後端才會給（權限判斷在 SQL，見
       server/src/routes/sellers.ts）。expected 表示「這個階段本來就該有」——
       held 的卡買家還沒申請出貨，沒地址是正確的，不該顯示成缺件。 */
    ship: shipViewOf(r.shipTo, actionable),
    deposit: 0
  }
}

/** 市場的一張託管訂單 → Job */
function marketJob(o: Order): Job {
  const ui = MARKET_UI[o.status]
  const d = deadlineOf(o)
  const actionable = o.status === 'escrowed'
  return {
    key: 'market:' + o.id,
    src: 'market',
    id: o.id,
    card: o.card,
    buyer: o.buyerName || '買家',
    memberNo: null,
    amount: o.price,
    amountLabel: '貨款',
    /* 訂單編號是買賣雙方在站外對話時唯一分得出「在講哪一筆」的共同代號，
       所以它要出現在這一列上，而不是只在訂單頁。 */
    origin: '市場成交 · ' + o.id,
    bucket: actionable ? 'ship'
      : o.status === 'shipped' || o.status === 'delivered' || o.status === 'disputed' ? 'run' : 'done',
    due: d ? { at: d.at, label: d.label, then: d.then } : null,
    /* 只有「等你寄出」逾期會罰到賣家（取消退款 + 沒收保證金）。
       送達與驗收期滿對賣家是好事，不該染紅。 */
    penal: actionable,
    statusT: ui.t,
    statusSub: ui.sub,
    tone: ui.tone,
    actionable,
    rule: MARKET_RULE,
    ship: shipViewOf(shipToOf(o), o.status === 'escrowed'),
    deposit: o.deposit
  }
}

/**
 * 全部混成一份，然後**照剩餘時間排**。
 *
 * 判準是「剩多少時間到期」，不是「哪一種來源」—— 一筆剩五小時的市場訂單
 * 排在還有兩週的抽卡池結算後面，等於這一頁沒解決任何問題。
 * 沒有時限的（已結束的那些）一律沉到最後，它們沒有「急」可言。
 */
const jobs = computed<Job[]>(() => {
  const all = [...rows.value.map(poolJob), ...orders.value.map(marketJob)]
  return all.sort((a, b) => {
    if (a.due && b.due) return a.due.at - b.due.at
    if (a.due) return -1
    if (b.due) return 1
    return 0
  })
})

const toShip = computed(() => jobs.value.filter(j => j.bucket === 'ship'))
const running = computed(() => jobs.value.filter(j => j.bucket === 'run'))
const done = computed(() => jobs.value.filter(j => j.bucket === 'done'))

type Tab = 'ship' | 'run' | 'done'
const tab = ref<Tab>('ship')
/* 使用者自己按過分頁之後就不再自動跳。第一次載入前不知道哪一堆有東西，
   而預設落在一個空分頁會讓人以為「什麼都沒有」，然後直接離開。 */
const tabPinned = ref(false)
function pickTab(t: Tab) { tabPinned.value = true; tab.value = t }
const list = computed(() => (tab.value === 'ship' ? toShip.value : tab.value === 'run' ? running.value : done.value))

/** 保留額卡在哪一段。三段加起來就是 wallet.reserved —— 那個數字不是憑空的 */
const stages = computed(() => {
  const sum = (s: SettlementStatus) =>
    rows.value.filter(r => r.status === s).reduce((a, r) => a + r.amount, 0)
  const n = (s: SettlementStatus) => rows.value.filter(r => r.status === s).length
  return [
    { k: 'awaiting_ship' as const, t: '等你寄出', n: n('awaiting_ship'), v: sum('awaiting_ship') },
    { k: 'shipped' as const, t: '寄出後鑑賞期', n: n('shipped'), v: sum('shipped') },
    { k: 'held' as const, t: '買家還沒申請', n: n('held'), v: sum('held') }
  ]
})

/**
 * 市場那一半的錢。
 *
 * 它**不在 reserved 裡** —— 保留額的定義是「已經貸記給我但動不了的票金」，
 * 而託管訂單的貨款根本還沒貸記給賣家，要等訂單完成才會有那筆分錄。
 * 兩者混成同一個數字會讓上面那句「三段加起來就是保留中」變成假的。
 * 但賣家還是得知道市場那邊有多少錢在跑，所以另外給一行。
 */
const marketMoney = computed(() => {
  const open = orders.value.filter(o => marketJob(o).bucket !== 'done')
  return {
    n: open.length,
    price: open.reduce((a, o) => a + o.price, 0),
    deposit: open.reduce((a, o) => a + o.deposit, 0)
  }
})

/* ---------------- 時限 ---------------- */

/** 只有「逾期會罰到我」的才會變紅；其他時限到了對賣家是好事 */
function toneOf(j: Job, at: number): 'ok' | 'warn' | 'danger' {
  if (!j.penal) return 'ok'
  const left = at - now.value
  if (left <= 0) return 'danger'
  return left <= 24 * HOUR ? 'warn' : 'ok'
}

/**
 * 快到期的待出貨。門檻 24 小時，兩種來源一起算。
 *
 * 為什麼要提前警告而不是逾期後才說：逾期的代價在池是「票金退還買家 + 記一次違約」
 * （違約累積 SELLER_DEFAULT_LIMIT 次就不能再開新池），在市場是「取消退款 +
 * 沒收保證金」—— 兩者都是事後補救不了的結果。
 * 事後通知只是通報壞消息，事前通知才有機會避免它。
 */
const urgent = computed(() =>
  toShip.value
    .map(j => ({ j, at: j.due?.at ?? 0 }))
    .filter(x => x.at - now.value <= 24 * HOUR)
    .sort((a, b) => a.at - b.at))
/** 警示文案要講對罰則，所以要知道快到期的那幾筆各是哪一種來源 */
const urgentHasPool = computed(() => urgent.value.some(x => x.j.src === 'pool'))
const urgentHasMarket = computed(() => urgent.value.some(x => x.j.src === 'market'))

/* ---------------- 選取與出貨 ---------------- */

/**
 * 已選的 key。用 Set 而不是陣列：一個池賣掉十張是常態，
 * 全選之後每一列都要問「我被選了嗎」，陣列是 O(n) 而 Set 是 O(1)。
 * key 帶來源前綴 —— 兩種來源的 id 各自唯一，但混在同一個集合裡就不保證了。
 */
const picked = ref(new Set<string>())
const pickedList = computed(() => toShip.value.filter(j => picked.value.has(j.key)))

function toggle(key: string) {
  /* Set 就地改不會觸發 Vue 的反應性追蹤（Vue 3 的 reactive Set 可以，
     但 ref(new Set) 換整個值最保險，也不必去記哪一種容器有攔截器）。 */
  const next = new Set(picked.value)
  next.has(key) ? next.delete(key) : next.add(key)
  picked.value = next
}
const allPicked = computed(() => toShip.value.length > 0 && picked.value.size === toShip.value.length)
function toggleAll() {
  picked.value = allPicked.value ? new Set() : new Set(toShip.value.map(j => j.key))
}

/* 確認面板。scope 是「這次要寄哪幾筆」——
   逐筆與多筆走同一個面板，因為單號與物流商的填法一模一樣，
   分成兩套 UI 只會有兩份會走鐘的文案。兩種來源也共用它：
   後端兩支端點收的參數（carrier + 選填 tracking）本來就一樣。 */
const sheet = ref<Job[] | null>(null)
const carrier = ref<Carrier>('post')
const tracking = ref('')
const busy = ref(false)
const shipErr = ref('')
const shipMsg = ref('')

const trackErr = computed(() => {
  const t = tracking.value.trim()
  if (!t) return ''            // 選填：空的不是錯
  const v = validateTracking(carrier.value, t)
  return v.ok ? '' : (v.reason ?? '')
})

/** 這批要寄的東西裡有幾種來源。混寄時面板要提醒「兩種的規則不一樣」 */
const sheetSrcs = computed(() => new Set((sheet.value ?? []).map(j => j.src)))

function openSheet(target: Job[]) {
  if (!target.length) return
  sheet.value = target
  tracking.value = ''
  shipErr.value = ''
}
function closeSheet() { if (!busy.value) sheet.value = null }

/**
 * 送出。**一筆一筆打**，因為後端沒有批次端點。
 *
 * 刻意不用 Promise.all：十筆同時打會在後端撞上同一批 `for update`，
 * 而且任何一筆失敗時 all 會直接 reject，賣家不知道究竟寄出了幾筆。
 * 循序跑並逐筆記錄成功數，失敗的留在清單上讓他重試。
 *
 * 兩種來源打不同的端點，但對賣家是同一個動作，所以不分成兩顆按鈕 ——
 * 「我要寄哪幾張」是他的問題，「這幾張分別屬於哪張表」不是。
 */
async function submitShip() {
  const target = sheet.value
  if (!target || busy.value || trackErr.value) return
  busy.value = true
  shipErr.value = ''
  const opts = { carrier: carrier.value, tracking: tracking.value.trim() || undefined }
  let okN = 0
  const failed: string[] = []
  for (const j of target) {
    try {
      if (j.src === 'pool') await api.shipSettlement(j.id, opts)
      else await api.shipOrder(j.id, opts)
      okN++
    } catch (e) {
      failed.push(`${j.card.name}：${e instanceof Error ? e.message : '失敗'}`)
    }
  }
  busy.value = false
  if (failed.length) shipErr.value = failed.join('；')
  else {
    sheet.value = null
    shipMsg.value = `已標記 ${okN} 筆出貨。買家收到通知了；確認收貨或期滿後這幾筆才會入帳。`
  }
  picked.value = new Set()
  await load()          // 重新拉：保留額與階段筆數都要跟著動，本地推算會走鐘
}

/* 底部列只在「等你寄出」這個分頁、而且真的有東西可選時才浮出。
   空列浮在下緣是純粹的遮擋。 */
const barOpen = computed(() => tab.value === 'ship' && toShip.value.length > 0 && !sheet.value)
</script>

<template>
  <div class="container page">
    <header class="head">
      <h1>出貨與結算</h1>
      <p class="muted sub">
        你要寄出的東西<b>兩種來源都在這裡</b>：抽卡池被抽走的卡，以及在市場上賣掉、
        需要寄送的卡。兩邊的時限與規則不一樣，每一列都會標出來。
        逾期未寄會自動結案並記你一次違約，所以最急的排在最上面。
      </p>
    </header>

    <p v-if="loadErr" class="errLine" role="alert">
      {{ loadErr }}
      <button type="button" class="btn sm" @click="load">重試</button>
    </p>

    <!-- ① 我的錢在哪 -->
    <section class="money card" aria-label="我的點數">
      <div class="mrow">
        <div class="mcell">
          <span class="ml">可動用</span>
          <strong class="mono">{{ wallet.available.toLocaleString() }}</strong>
        </div>
        <div class="mcell">
          <span class="ml">保留中（抽卡池票金）</span>
          <strong class="mono hold">{{ wallet.reserved.toLocaleString() }}</strong>
        </div>
      </div>
      <p class="mnote muted">
        保留中的點數看得到、動不了。它不是被扣走 —— 是還沒交付完成，所以先扣著。
      </p>
      <!-- 保留額卡在哪：只給一個總數，賣家沒辦法知道該做什麼才會變少 -->
      <ul class="stages">
        <li v-for="s in stages" :key="s.k" class="stage" :class="s.k">
          <span class="sn">{{ s.t }}</span>
          <strong class="mono">{{ s.v.toLocaleString() }}</strong>
          <span class="sc muted">{{ s.n }} 筆</span>
        </li>
      </ul>
      <!-- 市場那一半的錢刻意跟保留額分開講，理由見 marketMoney 的說明 -->
      <p v-if="marketMoney.n" class="mkMoney">
        <SourceTag src="market" />
        <span class="mkTxt">
          進行中 <b class="mono">{{ marketMoney.n }}</b> 筆・貨款
          <b class="mono">{{ marketMoney.price.toLocaleString() }}</b> 點在託管裡，訂單完成才入帳<template v-if="marketMoney.deposit">；
          你的保證金 <b class="mono">{{ marketMoney.deposit.toLocaleString() }}</b> 點凍結中</template>。
        </span>
      </p>
    </section>

    <!-- ② 快到期了嗎 -->
    <aside v-if="urgent.length" class="alertBox" role="alert">
      <strong class="at">{{ urgent.length }} 筆快到出貨期限</strong>
      <p class="ap">
        最近的一筆是
        <SourceTag :src="urgent[0]!.j.src" />
        <b>{{ urgent[0]!.j.card.name }}</b>，<b class="mono">{{ remainText(urgent[0]!.at - now) }}</b>。
        <template v-if="urgentHasPool">
          抽卡池逾期會把票金退還買家，並記你一次違約；違約滿
          <b class="mono">{{ SELLER_DEFAULT_LIMIT }}</b> 次就不能再開新池。
        </template>
        <template v-if="urgentHasMarket">
          市場訂單逾期會自動取消、全額退款買家，並沒收你的保證金。
        </template>
      </p>
      <button v-if="tab !== 'ship'" type="button" class="btn sm" @click="pickTab('ship')">去處理</button>
    </aside>

    <p v-if="shipMsg" class="okLine" role="status">{{ shipMsg }}</p>

    <!-- ③ 哪幾張要寄 -->
    <div class="tabs" role="tablist" aria-label="結算分類">
      <button
        type="button" role="tab" :aria-selected="tab === 'ship'"
        class="chip" :class="{ on: tab === 'ship' }" @click="pickTab('ship')"
      >等你寄出 {{ toShip.length }}</button>
      <button
        type="button" role="tab" :aria-selected="tab === 'run'"
        class="chip" :class="{ on: tab === 'run' }" @click="pickTab('run')"
      >進行中 {{ running.length }}</button>
      <button
        type="button" role="tab" :aria-selected="tab === 'done'"
        class="chip" :class="{ on: tab === 'done' }" @click="pickTab('done')"
      >已結束 {{ done.length }}</button>
    </div>

    <p class="sortNote muted">依「還剩多久到期」排序，最急的在最上面 —— 不分抽卡池或市場。</p>

    <div v-if="tab === 'ship' && toShip.length" class="selRow">
      <button type="button" class="btn sm ghost" @click="toggleAll">
        {{ allPicked ? '取消全選' : `全選 ${toShip.length} 筆` }}
      </button>
      <span class="muted selHint">同一個買家的多張卡可以裝一起寄，選起來一次標記。</span>
    </div>

    <p v-if="loading" class="empty muted">載入中…</p>
    <p v-else-if="!list.length" class="empty muted">
      <template v-if="tab === 'ship'">
        <template v-if="!jobs.length">
          目前沒有要寄的東西。有人抽走你池裡的卡、或是在市場上買下你要寄送的卡，
          這裡就會出現一筆。
        </template>
        <template v-else>
          目前沒有要寄的卡。抽卡池的卡要買家申請出貨之後才會出現在這裡 ——
          在那之前卡放在他的保管庫，你不用先寄。
        </template>
      </template>
      <template v-else-if="tab === 'run'">沒有進行中的項目。</template>
      <template v-else>還沒有結束的項目。</template>
    </p>

    <article
      v-for="j in list" :key="j.key"
      class="row" :class="[j.tone, j.src, { on: picked.has(j.key) }]"
      data-testid="job" :data-src="j.src" :data-due="j.due ? j.due.at : ''"
    >
      <!--
        待寄的那一疊，上半塊整塊可點：拇指在手機上點不準一個 20px 的方框。
        但**只包上半塊** —— 整列包成 label 的話，下面收件資訊的「複製」按鈕
        一按就會順手把這一列選起來／取消掉。
      -->
      <component :is="j.bucket === 'ship' ? 'label' : 'div'" class="rTop" :class="{ withPick: j.bucket === 'ship' }">
        <span v-if="j.bucket === 'ship'" class="pickBox">
          <input
            type="checkbox" class="pick"
            :checked="picked.has(j.key)" :aria-label="`選取 ${j.card.name}`"
            @change="toggle(j.key)"
          />
          <span class="pickMark" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <path d="M3.4 8.4l3.1 3.1 6.1-6.4" fill="none" stroke="currentColor"
                    stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </span>
        <CardArt class="thumb" :image="j.card.image" :alt="j.card.name"
                 :art-id="j.card.artId" />
        <div class="meta">
          <SourceTag :src="j.src" />
          <strong class="nm">{{ j.card.name }}</strong>
          <p class="who">
            寄給 <b>{{ j.buyer }}</b>
            <span v-if="j.memberNo" class="mono mno">{{ j.memberNo }}</span>
          </p>
          <p class="src muted">
            {{ j.origin }} · {{ j.amountLabel }}
            <b class="mono">{{ j.amount.toLocaleString() }}</b> 點
            <template v-if="j.deposit"> · 保證金 <b class="mono">{{ j.deposit.toLocaleString() }}</b> 點</template>
          </p>
        </div>
        <span class="stTag" :class="j.tone">{{ j.statusT }}</span>
      </component>

      <p class="sSub muted">{{ j.statusSub }}</p>

      <div v-if="j.due" class="due" :class="toneOf(j, j.due.at)">
        <div class="dueTop">
          <span>{{ j.due.label }}</span>
          <strong class="mono">{{ remainText(j.due.at - now) }}</strong>
        </div>
        <p>{{ j.due.then }}</p>
      </div>

      <!-- 兩種來源混在同一份清單裡，不標規則會讓賣家拿池的時限去套市場的卡 -->
      <p v-if="j.bucket !== 'done'" class="ruleLine muted">{{ j.rule }}</p>

      <!--
        寄件依據。權限判斷在伺服器的 SQL 做完了（池那邊見 routes/sellers.ts
        的 lateral join，市場那邊見 routes/orders.ts 的 canShip）：有值就是可以顯示。
        平台不經手實體卡，所以「看得到」不夠，一定要「拿得走」—— 手抄地址
        是這條流程最容易出錯的一步，抄錯一個字包裹就寄丟了。
      -->
      <section v-if="j.ship.expected" class="send">
        <h3 class="sendH">
          <svg class="sendIco" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 5.4l6-2.9 6 2.9v5.2l-6 2.9-6-2.9z" fill="none"
                  stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
            <path d="M2 5.4l6 2.9 6-2.9M8 8.3v5.2" fill="none"
                  stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          </svg>
          寄給買家
        </h3>

        <template v-if="j.ship.any">
          <CopyLine v-if="j.ship.name" label="收件人" :value="j.ship.name" :testid="`copy-name-${j.id}`" />
          <p v-else class="gap"><span class="gapLb">收件人</span><span class="gapTag">買家還沒填</span></p>

          <CopyLine v-if="j.ship.phone" label="電話" :value="j.ship.phone" mono :testid="`copy-phone-${j.id}`" />
          <p v-else class="gap"><span class="gapLb">電話</span><span class="gapTag">買家還沒填</span></p>

          <CopyLine v-if="j.ship.addr" label="地址" :value="j.ship.addr" :testid="`copy-addr-${j.id}`" />
          <p v-else class="gap"><span class="gapLb">地址</span><span class="gapTag">買家還沒填</span></p>

          <p class="sendWhy muted">
            <template v-if="j.ship.addr">照這個地址寄出。</template>寄送方式、時間與運費請直接跟買家聯絡
            —— 平台不經手實體卡，也不會替你追蹤包裹。
          </p>
        </template>
        <p v-else class="sendWhy muted">
          買家還沒填收件資料，先別寄。請用站內私訊或訂單編號跟他要地址；
          在他填好之前寄出去的包裹平台無法協助追查。
        </p>
      </section>

      <!-- 逐筆出貨：選一筆再按底部列也做得到，但「我現在就要處理這一筆」
           是最常見的動作，不該逼人先進選取模式 -->
      <div v-if="j.actionable" class="acts">
        <button type="button" class="btn primary sm" @click.prevent="openSheet([j])">
          只標記這筆已出貨
        </button>
      </div>
    </article>

    <!-- 多筆的操作列。定位、讓位、進出場動畫都在 BottomActionBar 裡
         （Teleport 到 body：祖先有 transform 會變成 fixed 的定位基準）。 -->
    <BottomActionBar :open="barOpen" label="出貨" :spacer="104" :max-width="560">
      <div class="shipBar">
        <span class="sbInfo" role="status">
          <strong>已選 <span class="mono">{{ pickedList.length }}</span> 筆</strong>
          <span class="mono sbSub">{{ pickedList.reduce((a, j) => a + j.amount, 0).toLocaleString() }} 點</span>
        </span>
        <button
          type="button" class="btn primary sm" :disabled="!pickedList.length"
          @click="openSheet(pickedList)"
        >標記已出貨</button>
      </div>
    </BottomActionBar>

    <!-- 確認面板。Teleport 到 body，理由同上 -->
    <Teleport to="body">
      <div v-if="sheet" class="sheetWrap" @click.self="closeSheet">
        <div class="sheet card" role="dialog" aria-modal="true" aria-label="標記已出貨">
          <h2 class="sh">標記 {{ sheet.length }} 筆已出貨</h2>
          <ul class="shList">
            <li v-for="j in sheet" :key="j.key">
              <SourceTag :src="j.src" />
              <span class="shNm">{{ j.card.name }}</span>
              <span class="muted">→ {{ j.buyer }}</span>
            </li>
          </ul>
          <p v-if="sheetSrcs.size > 1" class="fHint warnHint">
            這批同時有抽卡池與市場的卡，兩邊的後續時限不一樣（見清單上每一列的說明），
            但「已寄出」這個動作是一樣的。
          </p>

          <label class="fLab">
            物流商
            <select v-model="carrier">
              <option v-for="c in CARRIERS" :key="c.id" :value="c.id">{{ c.label }}</option>
            </select>
          </label>
          <label class="fLab">
            物流單號（選填）
            <input
              v-model="tracking" type="text"
              :placeholder="CARRIERS.find(c => c.id === carrier)?.hint"
              :aria-invalid="!!trackErr"
            />
            <span v-if="trackErr" class="warnLine">{{ trackErr }}</span>
          </label>
          <p class="fHint muted">
            平台不代管實體卡，卡由你直接寄給買家，所以單號不是必填 ——
            它只是給買家追蹤用的憑據，填不填都不影響入帳。
          </p>
          <p class="fHint muted">
            按下去之後這幾筆的後續時限開始跑，買家會收到通知。
            <b>出貨不等於入帳</b>：要等買家確認收貨或期滿。
          </p>

          <p v-if="shipErr" class="errLine" role="alert">{{ shipErr }}</p>
          <div class="fRow">
            <button type="button" class="btn sm" :disabled="busy" @click="closeSheet">取消</button>
            <button type="button" class="btn primary sm" :disabled="busy || !!trackErr" @click="submitShip">
              {{ busy ? '處理中…' : '確認已出貨' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <p v-if="MOCK" class="fine muted">
      示範模式：這裡的結算是本機造的假資料，按下出貨只會改本機狀態，不會真的通知任何人。
    </p>
  </div>
</template>

<style scoped>
/* 下緣不自己讓開底部導覽 —— 全域頁尾已經算過一份（見 HANDOFF 2.3），
   兩邊都留會在每頁最底多出一條捲得到卻空無一物的黑。 */
.page { padding-top: 24px; padding-bottom: 40px; max-width: 720px; }

.head { margin-bottom: 14px; }
h1 { font-size: 22px; margin: 0 0 6px; }
.sub { font-size: 13px; line-height: 1.75; margin: 0; }

/* ---- 錢 ---- */
.money { padding: 14px 16px; }
/* minmax(0, 1fr)：數字可能是七位數，1fr 的子元素預設 min-width:auto 會撐爆 */
.mrow { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.mcell { min-width: 0; }
.ml { display: block; font-size: 11.5px; color: var(--muted); margin-bottom: 2px; line-height: 1.4; overflow-wrap: anywhere; }
.mcell strong { font-size: 20px; overflow-wrap: anywhere; }
.mcell .hold { color: var(--gold); }
.mnote { font-size: 11.5px; line-height: 1.7; margin: 8px 0 0; }

.stages {
  list-style: none; padding: 0; margin: 12px 0 0;
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;
}
.stage {
  min-width: 0; padding: 8px 10px;
  background: var(--surface-2); border-radius: 12px;
}
.stage.awaiting_ship { box-shadow: inset 2px 0 0 var(--warn); }
.stage.shipped { box-shadow: inset 2px 0 0 var(--ok); }
.sn { display: block; font-size: 11px; color: var(--muted); line-height: 1.4; overflow-wrap: anywhere; }
.stage strong { display: block; font-size: 15px; margin-top: 3px; overflow-wrap: anywhere; }
.sc { display: block; font-size: 11px; }

.mkMoney {
  margin: 10px 0 0; padding: 9px 11px;
  background: var(--surface-2); border-radius: 12px;
  font-size: 11.5px; line-height: 1.75; color: var(--muted);
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px;
  min-width: 0;
}
.mkTxt { min-width: 0; overflow-wrap: anywhere; flex: 1 1 200px; }
.mkMoney b { color: var(--text); }

/* ---- 警告 ---- */
.alertBox {
  margin-top: 12px; padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--warn-wash); box-shadow: inset 2px 0 0 var(--warn);
}
.at { display: block; font-size: 14px; color: var(--warn-ink); }
.ap { font-size: 12.5px; line-height: 1.9; margin: 4px 0 0; color: var(--text); overflow-wrap: anywhere; }
.alertBox .btn.sm { margin-top: 10px; }

.okLine {
  margin: 12px 0 0; padding: 10px 12px;
  font-size: 12.5px; line-height: 1.7;
  border-radius: var(--radius);
  background: var(--ok-wash); color: var(--ok-ink);
}
.errLine { color: var(--danger); font-size: 13px; line-height: 1.7; margin: 12px 0 0; }
.errLine .btn.sm { margin-left: 8px; }

/* ---- 清單 ---- */
.tabs { display: flex; gap: 8px; margin: 16px 0 8px; flex-wrap: wrap; }
/* 可點目標至少 44px：分頁鈕原本只有 33px 高，拇指點不準 */
.tabs .chip { min-height: 44px; }
.sortNote { font-size: 11.5px; line-height: 1.7; margin: 0 0 10px; overflow-wrap: anywhere; }
.selRow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.selHint { font-size: 11.5px; line-height: 1.6; min-width: 0; }
.empty { padding: 26px 4px; font-size: 13.5px; line-height: 1.9; }

.row {
  display: block;
  background: var(--surface); border-radius: var(--radius-lg);
  padding: 14px; margin-bottom: 10px;
  border: 1px solid transparent;
}
.row.on { border-color: var(--accent); background: var(--accent-wash); }

/* 欄位定義要跟著「有沒有勾選框」換一組。
   不能只靠 auto 讓它自己收掉：grid 是照**位置**配欄的，少一個子元素時
   卡圖會掉進第一欄、文字掉進 52px 那一欄，整列擠成一條。實測過。 */
.rTop { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; gap: 10px; align-items: start; }
.rTop.withPick { grid-template-columns: auto 52px minmax(0, 1fr) auto; cursor: pointer; }
/* 方框大小是視覺，可點範圍是人的手指，兩者不必相等。
   原生 checkbox 撐不到 44px 又不能只靠外框（真正吃到點擊的是 input 本身），
   所以把 input 攤成整個 44×44 並隱形，視覺交給 .pickMark 畫。
   拇指在手機上點不準一個 20px 的方框 —— 而這一頁點錯的代價是漏寄或錯寄。 */
.pickBox { position: relative; display: grid; place-items: center; width: 44px; height: 44px; margin: -10px 0 0 -12px; }
.pick { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.pickMark {
  display: grid; place-items: center;
  width: 20px; height: 20px; border-radius: 6px;
  border: 1.5px solid var(--line); background: var(--surface-2);
  pointer-events: none;   /* 點擊一律落在底下那個 input 上 */
}
.pickMark svg { width: 13px; height: 13px; opacity: 0; color: var(--on-accent); }
.pick:checked + .pickMark { background: var(--accent); border-color: var(--accent); }
.pick:checked + .pickMark svg { opacity: 1; }
.pick:focus-visible + .pickMark { outline: 2px solid var(--accent); outline-offset: 2px; }

.thumb { width: 52px; height: 73px; border-radius: 6px; overflow: hidden; }
.thumb :deep(img) { width: 100%; height: 100%; object-fit: cover; }
/* 52px 寬的縮圖裡塞不下卡名，塞了就是一行被裁掉的字 ——
   而真正的卡名就在它右邊一欄。佔位卡只留色塊與底紋。 */
.thumb :deep(.c-name) { display: none; }
/* 佔位卡的斜掃光比卡框本身寬（73px vs 52px），在這個尺寸下是唯一讓
   縮圖 scrollWidth 超出 clientWidth 的東西。它被 overflow:hidden 切掉
   所以看不出來，但量測會抓到；而 52px 的縮圖本來也看不見那道光。 */
.thumb :deep(.sheen) { display: none; }
.meta { min-width: 0; }
.nm { display: block; font-size: 14.5px; line-height: 1.4; margin: 4px 0 3px; overflow-wrap: anywhere; }
.who { font-size: 12px; margin: 0 0 2px; overflow-wrap: anywhere; }
.mno { font-size: 11px; color: var(--muted); margin-left: 6px; }
.src { font-size: 11.5px; line-height: 1.6; margin: 0; overflow-wrap: anywhere; }
.stTag {
  font-size: 10.5px; font-weight: 700;
  padding: 4px 9px; border-radius: var(--pill);
  background: var(--surface-3); color: var(--muted);
  max-width: 96px; line-height: 1.4;
}
.stTag.act { background: var(--warn-wash); color: var(--warn-ink); }
.stTag.ok { background: var(--ok-wash); color: var(--ok-ink); }
.stTag.bad { background: var(--danger-wash); color: var(--danger-ink); }
.sSub { font-size: 11.5px; line-height: 1.7; margin: 8px 0 0; }

.due { border-radius: var(--radius); padding: 9px 11px; margin-top: 9px; background: var(--surface-2); }
.due.warn { box-shadow: inset 2px 0 0 var(--warn); }
.due.ok { box-shadow: inset 2px 0 0 var(--ok); }
.due.danger { box-shadow: inset 2px 0 0 var(--danger); }
.dueTop { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.dueTop span { font-size: 11.5px; color: var(--muted); min-width: 0; }
.dueTop strong { font-size: 14.5px; white-space: nowrap; }
.due p { font-size: 11px; line-height: 1.65; color: var(--muted); margin: 3px 0 0; }

.ruleLine { font-size: 11px; line-height: 1.7; margin: 8px 0 0; overflow-wrap: anywhere; }

/* ---- 寄件依據 ---- */
.send {
  margin-top: 10px; padding: 10px 11px;
  background: var(--surface-2); border-radius: var(--radius);
}
.sendH {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; margin: 0 0 6px; color: var(--muted);
}
.sendIco { width: 14px; height: 14px; flex: none; }
.gap { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin: 0 0 6px; min-width: 0; }
.gapLb { font-size: 11.5px; color: var(--muted); }
.gapTag {
  font-size: 11px; padding: 2px 8px; border-radius: var(--pill);
  background: var(--warn-wash); color: var(--warn-ink);
}
.sendWhy { font-size: 11px; line-height: 1.75; margin: 8px 0 0; overflow-wrap: anywhere; }

.acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
/* 動作鈕也要 44px：這一頁按錯的代價是包裹寄錯或漏寄 */
.acts .btn.sm, .selRow .btn.sm, .errLine .btn.sm, .alertBox .btn.sm {
  padding: 10px 16px; font-size: 13px; min-height: 44px;
}

/* ---- 底部列 ---- */
.shipBar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
.sbInfo { display: grid; gap: 1px; min-width: 0; }
.sbInfo strong { font-size: 14px; }
.sbSub { font-size: 11.5px; color: var(--muted); }
.shipBar .btn.sm { min-height: 44px; padding: 10px 16px; }

/* ---- 確認面板 ---- */
.sheetWrap {
  position: fixed; inset: 0; z-index: 80;
  display: grid; place-items: end center;
  background: rgba(0, 0, 0, .58);
  padding: 16px;
  /* 手機視窗高度用 dvh：vh 取的是網址列收起時的高度，面板會被切掉一截 */
  max-height: 100dvh;
}
@media (min-width: 720px) { .sheetWrap { place-items: center; } }
.sheet {
  width: 100%; max-width: 480px;
  max-height: 84dvh; overflow-y: auto;
  padding: 16px;
  margin-bottom: max(var(--nav-total, 0px), var(--safe-b, 0px));
}
.sh { font-size: 16px; margin: 0 0 10px; }
.shList { list-style: none; padding: 0; margin: 0 0 14px; display: grid; gap: 6px; }
.shList li { display: flex; gap: 6px; align-items: center; font-size: 12.5px; min-width: 0; flex-wrap: wrap; }
.shNm { overflow-wrap: anywhere; min-width: 0; }

.fLab { display: block; font-size: 12.5px; color: var(--muted); margin-bottom: 10px; }
.fLab select, .fLab input {
  display: block; width: 100%; margin-top: 5px;
  /* 16px 以下 iOS Safari 會在聚焦時放大整頁 */
  padding: 10px 12px; font: inherit; font-size: 16px; min-height: 44px;
  border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--field, var(--surface-2)); color: var(--ink);
}
.warnLine { display: block; margin-top: 5px; font-size: 12.5px; line-height: 1.6; color: var(--warn); }
.fHint { font-size: 11.5px; line-height: 1.7; margin: 0 0 8px; }
.warnHint {
  padding: 8px 10px; border-radius: var(--radius);
  background: var(--warn-wash); color: var(--warn-ink);
}
.fRow { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.fRow .btn.sm { padding: 10px 18px; font-size: 13px; min-height: 44px; }

.fine { font-size: 11.5px; line-height: 1.7; margin-top: 20px; }
</style>
