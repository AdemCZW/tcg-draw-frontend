<script setup lang="ts">
/**
 * 託管訂單。
 *
 * 一張訂單卡要回答三件事，順序不能亂：現在卡在哪一步、還剩多久、我可以做什麼。
 * 「還剩多久」放在最上面是刻意的 —— 整套機制的重點就是時限，
 * 使用者最需要知道的是「我再不動作會發生什麼」。
 *
 * ── 出貨模型（使用者拍板）─────────────────────────────────────────
 * 寄送與出貨確認由買賣雙方私下用通訊軟體完成。平台只做兩件事：
 *   1. 把收件資訊給賣家，讓他寄得出去
 *   2. 提供一個雙方按下完成的機制（就是既有的託管）
 * 所以這一頁的重點從「上傳單號與照片存證」整個換成「把地址交到賣家手上、
 * 並且讓他拿得走」：每一項都能一鍵複製，因為真正的動作發生在站外 ——
 * 物流商的網站、LINE 的對話框。訂單編號也要能複製，那是雙方對話時
 * 唯一分得出「在講哪一筆」的共同代號。
 *
 * 出貨照與必填單號整條移除。物流商與單號留著當選填線索，但畫面上要明說
 * 不填也能出貨，否則使用者會以為自己被擋住。
 *
 * ── 買家那半 ─────────────────────────────────────────────────────
 * 上面那次改寫是為了賣家出貨，買家只剩兩句灰字。但**買家才是付了錢在等的那個人**：
 * 他點進來要問的是「我的卡到哪了、我的錢在誰手上」。所以買家那側補齊四件事，
 * 順序就是他心裡的順序：
 *   1. 賣家是誰（名字不夠 —— 等級、出貨天數、爭議率才判斷得出要不要擔心）
 *   2. 走到哪一步（三段進度，現在那一段標出來，並帶剩餘時間）
 *   3. 我現在該做什麼、還是只要等
 *   4. 我的點數鎖了多少、什麼時候會放給賣家或退回來
 * 每一種狀態講的話都不一樣，所以文案按狀態分開寫（buyerViewOf），
 * 不用一套通用句型帶過 —— 通用句型的結果就是每一種狀態都講得不清不楚。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useOrdersStore, shipToOf, isSelf, type ShipTo } from '@/stores/orders'
import { useWalletStore } from '@/stores/wallet'
import {
  actionsFor, deadlineOf, DAY, HOUR, isOpen, validateTracking, CARRIERS,
  remainText, STATUS_TEXT, SHIP_DEADLINE, DELIVER_DEADLINE, INSPECT_WINDOW,
  type Carrier, type Deadline
} from '@/shared/escrow'
import type { Order, Seller, SellerContact } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import CopyLine from '@/components/CopyLine.vue'
import SellerChip from '@/components/SellerChip.vue'
/* 「點數現在在哪裡」與「提出問題」兩塊跟賣家的出貨頁共用同一支元件：
   兩頁講的是同一筆錢與同一條求助管道，各寫一份遲早會分岔，
   而分岔的那一份會對使用者講錯誰拿得到錢。 */
import PointsFlow from '@/components/PointsFlow.vue'
import OrderIssue from '@/components/OrderIssue.vue'
import { api } from '@/lib/api'
import { MOCK } from '@/lib/config'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { useKeyboardInset } from '@/composables/useKeyboardInset'

const store = useOrdersStore()
const wallet = useWalletStore()

const tab = ref<'open' | 'done'>('open')
const shipFor = ref<string | null>(null)
/**
 * 「我已收到」的確認面板要開在哪一筆。
 *
 * 為什麼這一顆非要有守門不可：它是這一頁唯一「按一下就把錢放出去、
 * 而且之後再也不能申訴」的動作，而它旁邊 8px 就是「我要申訴」——
 * 那條路要附完整開箱影片才受理，按錯一次就沒有第二次機會。
 * 原本的守門強度剛好裝反了：風險低得多的「我已寄出」有一整張確認面板，
 * 真正不可還原的這一顆卻是直接呼叫 store.confirm()。
 */
const confirmFor = ref<string | null>(null)
const tracking = ref('')
const disputeFor = ref<string | null>(null)
const reason = ref('')
const hasVideo = ref(false)
/* API 模式：伺服器要影片的 URL 才受理。R2 直傳是下一階段，先讓使用者貼連結 */
const videoUrl = ref('')

/* ---- 「送出申訴」灰掉的理由 ----
   擋住它的是一條 `^https?://` 的正規式，而畫面上完全沒講。
   申訴是買家唯一能把錢要回來的路，而且他多半是在「東西不對」的當下才來按 ——
   一顆按不動又不說話的按鈕在這個時間點特別傷。

   「發生什麼事」刻意不列進來：那一欄沒填會被 doDispute() 補成「未說明」，
   它不是門檻。把不是門檻的欄位列進「還差」是在騙人。

   兩種模式的門檻不同，講的話也要不同 —— 一律講「影片連結」的話，
   mock 的人會去找一個畫面上根本不存在的欄位。 */
const disputeMissing = computed(() => {
  if (MOCK) return hasVideo.value ? '' : '還差：勾選「我有完整未剪輯的開箱影片」。'
  const u = videoUrl.value.trim()
  if (!u) return '還差：開箱影片連結。'
  /* 貼了連結還是灰的最難自己脫困 —— 直接指出缺的是開頭那段通訊協定，
     多數人是從相簿分享出來只複製到路徑，或前面黏了一個空白。 */
  return /^https?:\/\/.+/.test(u) ? '' : '還差：影片連結要是完整網址，開頭要有 http:// 或 https://。'
})
const canDispute = () => !disputeMissing.value
const disputeBlockWhy = computed(() => (busy.value ? '' : disputeMissing.value))

/* 每分鐘重掃一次，讓倒數會動、到期的訂單自己結案。
   真正的推進靠時間戳，這個計時器只是讓畫面跟上，
   所以分頁被凍住也不會算錯 —— 回來時一次補算完。 */
let timer: number | undefined
onMounted(() => {
  store.load()
  timer = window.setInterval(() => store.sweep(), 60_000)
  window.addEventListener('keydown', onEsc)
})

const now = ref(store.now())
/* 這個每秒的計時器一定要跟著元件收掉。
   之前它沒有被清掉，離開這一頁之後仍然每秒寫一次 now，而 now 是模板的
   依賴 —— 等於持續替一個已經卸載的元件排重繪工作。Vue 去 patch 早就被
   移除的節點，就在 renderer 裡炸開（parentNode of null、vnode is null），
   而且是**整個 app 一起壞掉**：之後不管切到哪一頁，網址與標題都會變，
   畫面卻永遠停在訂單頁。實測從 /me/orders 走到任何一頁都重現得到。 */
let tick: number | undefined
onMounted(() => { tick = window.setInterval(() => { now.value = store.now() }, 1000) })
onUnmounted(() => {
  clearInterval(timer); clearInterval(tick); clearTimeout(allT)
  window.removeEventListener('keydown', onEsc)
})

const list = computed(() =>
  store.orders.filter(o => (tab.value === 'open' ? isOpen(o) : !isOpen(o)))
)
/**
 * 我在這一筆訂單裡是誰。
 *
 * 原本是 `o.sellerId === 'me'`。'me' 是 mock 種子寫死的字串，正式環境的
 * sellerId 是真的 user id（u-xxxx），**永遠不等於 'me'** —— 於是每一筆訂單
 * 都被判成「我是買家」，賣家在正式站看自己的訂單會拿到買家視角：
 * 看不到收件資訊、按不到「我已寄出」，最後在出貨期限到期時被判逾期、沒收保證金。
 * 判準改成跟登入者的 id 比對（isSelf，兩種模式共用同一份，見 stores/orders.ts）。
 */
const roleOf = (o: Order) => (isSelf(o.sellerId) ? 'seller' : 'buyer') as 'seller' | 'buyer'

/**
 * 收件資訊的畫面狀態。
 *
 * 三種情況都要有對應的畫面，而不是只處理「有值」：
 *   any=true,  missing=[]      買家填齊了 —— 直接寄
 *   any=true,  missing=[…]     只填了一部分 —— 有的照顯示，缺的講出來、給去要的路
 *   any=false                  完全沒填 —— 整塊換成「跟買家要」，不能留一片空白
 * 郵遞區號不算缺：沒有它照樣寄得出去，把它列進缺漏只會製造假的紅字。
 */
interface ShipView {
  name: string
  phone: string
  addr: string
  /** 缺哪幾項（寄件真的需要的那三項） */
  missing: string[]
  /** 至少有一項有值 */
  any: boolean
}
function shipViewOf(o: Order): ShipView {
  const s: ShipTo | undefined = shipToOf(o)
  const trim = (v?: string) => (v ?? '').trim()
  const name = trim(s?.name)
  const phone = trim(s?.phone)
  const addr = [trim(s?.zip), trim(s?.city), trim(s?.line1)].filter(Boolean).join(' ')
  return {
    name, phone, addr,
    missing: [!name && '收件人', !phone && '電話', !addr && '地址'].filter(Boolean) as string[],
    any: !!(name || phone || addr)
  }
}

/**
 * 一次算好每張卡要用到的衍生值。
 *
 * 樣板裡呼叫 shipViewOf(o) / deadlineOf(o) 的話，每一次重繪（含每秒跳動的
 * 倒數）都會把它們重算一遍，而且同一張卡會算好幾次。這裡集中算一次，
 * 樣板只讀結果。
 */
interface Row {
  o: Order; role: 'seller' | 'buyer'; dl: Deadline | null; sv: ShipView
  /** 買家視角的整包文案。賣家的訂單是 null，樣板就不會渲染那一塊 */
  bv: BuyerView | null
}
const rows = computed<Row[]>(() =>
  list.value.map(o => {
    const role = roleOf(o)
    return {
      o, role, dl: deadlineOf(o), sv: shipViewOf(o),
      bv: role === 'buyer' ? buyerViewOf(o) : null
    }
  })
)

/** 時限規則的數字從常數推，不要在文案裡寫死 —— 規則改了文案要跟著改 */
const SHIP_HOURS = Math.round(SHIP_DEADLINE / HOUR)
const DELIVER_DAYS = Math.round(DELIVER_DEADLINE / DAY)
const INSPECT_DAYS = Math.round(INSPECT_WINDOW / DAY)

/* ==================================================================
   買家那半
   ================================================================== */

/**
 * 賣家檔案。
 *
 * 訂單上只有 sellerId 與 sellerName，而買家真正想知道的是「這個人可不可靠」——
 * 等級、出貨天數、爭議率都掛在賣家檔案上，得另外抓一次。
 *
 * 抓不到不能讓整塊消失：一般使用者從保管庫上架的卡沒有賣家檔案，
 * 舊訂單的賣家也可能已經下架。那時候退回「只有名字」的版本，
 * 因為「這張卡是誰要寄給我」是買家最想確認的一件事，寧可少講幾項也不能空白。
 *
 * seen 是普通的 Set 不是 ref：它只用來擋重複請求，讓它有反應性的話
 * 寫進去會再觸發一次 watch，變成自己餵自己。
 */
const sellerOf = ref<Record<string, Seller>>({})
const seenSellers = new Set<string>()
async function ensureSeller(id: string) {
  if (!id || seenSellers.has(id)) return
  seenSellers.add(id)
  try {
    const s = await api.getSeller(id)
    if (s) sellerOf.value = { ...sellerOf.value, [id]: s }
  } catch { /* 查不到就用退路版，不吵使用者 */ }
}
watch(rows, list => {
  for (const r of list) if (r.role === 'buyer') ensureSeller(r.o.sellerId)
}, { immediate: true })

interface BuyerStep {
  label: string
  /** done 走過了、now 現在卡在這、todo 還沒輪到 */
  state: 'done' | 'now' | 'todo'
}
interface BuyerView {
  steps: BuyerStep[]
  /** 我現在該做什麼、還是只要等 */
  todo: string
  /* 「錢在哪」原本是這裡的第四個欄位（money / held）。它搬進 PointsFlow 了 ——
     同一句話賣家那一頁也要講，而且要講得出金額與保證金。留在這裡的話，
     同一筆錢會有兩份文案，改一份就會跟另一份對不起來。 */
}

/**
 * 買家看到的整包文案，按狀態各寫各的。
 *
 * 不做成一套通用句型：七種狀態裡「我該做什麼」的答案差很多 ——
 * escrowed 是「什麼都不用做」、shipped 是「收到要按一個鈕」、
 * delivered 是「不按也會自動放款，但要申訴就得趁現在」。
 * 用一句話蓋過去的結果是每一種都講得不清不楚，而講不清楚的代價
 * 是使用者錯過驗收期、錢自動放給了賣家。
 *
 * 時限的數字一律從 shared/escrow.ts 的常數推導（SHIP_HOURS / DELIVER_DAYS /
 * INSPECT_DAYS），不寫死 —— 規則改了文案要自己跟上。
 */
function buyerViewOf(o: Order): BuyerView {
  const S = (label: string, state: BuyerStep['state']): BuyerStep => ({ label, state })
  const paid = S('付款・點數鎖住', 'done')

  switch (o.status) {
    case 'escrowed':
      return {
        steps: [paid, S('賣家寄出', 'now'), S('我確認收到', 'todo')],
        todo: '現在不用做什麼，等賣家寄出就好。想問寄送方式或運費，用你們原本的聯絡方式直接找賣家，報上面的訂單編號最快。',
      }
    case 'shipped':
      return {
        steps: [paid, S('賣家已寄出', 'done'), S('我確認收到', 'now')],
        todo: '卡收到後按「我已收到」，款項才會放給賣家。沒收到、或東西跟描述不符，就按「我要申訴」—— 申訴要附完整未剪輯的開箱影片，所以拆封前先開始錄。',
      }
    case 'delivered':
      return {
        steps: [paid, S('賣家已寄出', 'done'), S('驗收中', 'now')],
        todo: `已經算送達了，現在是 ${INSPECT_DAYS} 天驗收期。卡沒問題就按「我已收到」提早結案；有問題一定要在驗收期內按「我要申訴」，期滿就來不及了。`,
      }
    case 'disputed':
      return {
        steps: [paid, S('賣家已寄出', 'done'), S('爭議處理中', 'now')],
        todo: '客服正在看這一筆。在補件期限內把證據補齊（開箱影片、外箱與卡況照片）會比較快；過了期限就依現有的證據裁決。',
      }
    case 'completed':
      return {
        steps: [S('付款', 'done'), S('賣家已寄出', 'done'), S('已完成', 'done')],
        todo: '這筆結束了，沒有要做的事。卡後來才發現有問題請開客服工單 —— 訂單本身已經不能再申訴。',
      }
    case 'refunded':
      return {
        steps: [S('付款', 'done'), S('爭議裁決', 'done'), S('已退款', 'done')],
        todo: '爭議判你，這筆已經退款結案。沒有要做的事。',
      }
    case 'cancelled':
      return {
        steps: [S('付款', 'done'), S('賣家逾期未寄出', 'done'), S('已取消・退款', 'done')],
        todo: `賣家在 ${SHIP_HOURS} 小時內沒有寄出，系統自動取消了這筆。沒有要做的事，他的保證金已經被沒收。`,
      }
  }
}

/**
 * 「複製全部」給的是一整段可以直接貼進 LINE 的文字。
 *
 * 一列一列複製解得了物流網站的欄位，解不了對話框：賣家要跟買家核對時
 * 需要的是「訂單編號 ＋ 這三項」擺在一起。訂單編號放第一行，因為那是
 * 對方唯一能用來確認在講哪一筆的東西。
 */
function bundleOf(r: Row): string {
  return [
    `訂單編號 ${r.o.id}`,
    r.sv.name && `收件人 ${r.sv.name}`,
    r.sv.phone && `電話 ${r.sv.phone}`,
    r.sv.addr && `地址 ${r.sv.addr}`
  ].filter(Boolean).join('\n')
}
const copiedAll = ref<string | null>(null)
const copyErr = ref('')
let allT: number | undefined
async function copyAll(r: Row) {
  copyErr.value = ''
  try {
    await navigator.clipboard.writeText(bundleOf(r))
    copiedAll.value = r.o.id
  } catch {
    copiedAll.value = null
    copyErr.value = '這個瀏覽器不允許自動複製，請長按上面的欄位手動選取。'
  }
  clearTimeout(allT)
  allT = window.setTimeout(() => { copiedAll.value = null }, 2400)
}

/* demo 的種子。收件資料的三種情況各造一張，外加一張超長地址 ——
   長地址不是邊緣狀況，公司地址加樓層加分機在台灣很常見，而它是最會爆版的輸入。 */
const DEMO_CARD = {
  id: 'demo', name: '噴火龍 ex UR', image: '', artId: 'SV4a-349',
  refPrice: 43680, rarity: 'UR', certNo: '82345671', grade: 10
} as never
function seedDemo(kind: 'full' | 'partial' | 'none' | 'long') {
  const ship: Record<string, ShipTo | undefined> = {
    full: { name: '王大明', phone: '0912345678', zip: '106', city: '台北市大安區', line1: '和平東路二段 76 巷 12 號 5 樓' },
    // 只填了姓名，電話與地址是空的 —— 會員資料的每個欄位都不強制
    partial: { name: '陳小美' },
    none: undefined,
    long: {
      name: '歐陽文彥・威廉・馬克西米利安（代收人：管理室）',
      phone: '02-2707-1234 轉 88123',
      zip: '11492',
      city: '台北市內湖區',
      line1: '瑞光路 583 巷 26 號 8 樓之 3 A 棟東翼靠窗第三間辦公室（週一至週五 09:00-18:00 收件，假日請放管理室）'
    }
  }
  store.seedSellerOrder(DEMO_CARD, 41000, ship[kind])
}

/* 買家視角的種子。四種狀態各一顆按鈕，因為每一種狀態畫面上講的話都不同，
   只造得出一種等於其餘三種沒有人看過。
   long 那顆是爆版測試：超長卡名 ＋ 超長賣家名，兩個都是使用者填得出來的
   自由字串，而它們就擺在同一列的左右兩邊。 */
const LONG_CARD = {
  ...(DEMO_CARD as object),
  id: 'demo-long',
  name: '噴火龍 ex 特別藝術稀有・大師球鏡面版（黑標鑑定・2026 世界賽紀念再版）SAR/UR 雙面壓紋'
} as never
function seedBuyer(status: 'escrowed' | 'shipped' | 'delivered' | 'disputed' | 'completed', long = false) {
  store.seedBuyerOrder(
    long ? LONG_CARD : DEMO_CARD, 41000, status,
    /* 超長那筆刻意用一個查不到檔案的賣家 id：它同時測到「賣家名字很長」
       與「賣家檔案查不到」的退路版，那兩件事在正式環境會一起發生
       （一般使用者從保管庫上架，沒有賣家檔案） */
    long
      ? { id: 'u-LONG', name: '關東・橫濱本店 卡片鑑定與批發中心（週年慶特別營業所）' }
      : { id: 's1', name: '保庫堂' }
  )
}

/** demo：已完成卻被退回的買家單。結案規則沒變，所以這一格是真的會出現的 */
function seedBuyerReturned() {
  store.seedBuyerOrder(
    DEMO_CARD, 41000, 'completed', { id: 's1', name: '保庫堂' },
    { returnedAt: store.now() - 2 * HOUR }
  )
}
/** demo：已寄出的賣家單。「包裹被退回了」在出貨後才出現，種子預設造不出來 */
function seedSellerShipped() {
  store.seedSellerOrder(
    DEMO_CARD, 41000,
    { name: '王大明', phone: '0912345678', zip: '106', city: '台北市大安區', line1: '和平東路二段 76 巷 12 號 5 樓' },
    { status: 'shipped', shippedAt: store.now() - 30 * HOUR }
  )
}

const err = ref('')
/* 送出中。這兩個動作都是不可逆的（出貨會啟動買家的驗收時鐘、申訴會把訂單
   推進爭議狀態），手機上連點兩下就會送出兩次 —— 全域的連點守衛是保險絲，
   這裡的旗標才是正解，而且它同時讓按鈕看得出「正在處理」。 */
/* '' = 不指定物流商。物流商現在是選填，預設不能是「中華郵政」——
   那會讓沒選過的人送出一個他從來沒挑過的值，而爭議時客服會照這個值去查。 */
const carrier = ref<Carrier | ''>('')
/* 即時把驗證原因講出來，不要等按下去才說「格式不正確」——
   賣家看不出哪裡錯，只會一直重打同一組。
   空的單號不是錯誤，是「沒有提供」，所以不驗。 */
const trackErr = computed(() => {
  const t = tracking.value.trim()
  if (!t) return ''
  const v = validateTracking(carrier.value || 'other', t)
  return v.ok ? '' : (v.reason ?? '')
})
const trackHint = computed(() =>
  carrier.value ? CARRIERS.find(c => c.id === carrier.value)?.hint ?? '' : '不填也能出貨'
)

const busy = ref(false)

const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

/* ==================================================================
   三張面板：貼底覆蓋層
   ==================================================================
   為什麼不是行內展開。行內展開的版本在手機上按不到送出鍵，而且是量出來的：
   393×852 開面板，再讓軟鍵盤升起（視窗剩 420）的那一刻，三張的送出鍵停在
   508–555 / 595–642 / 682–729，`inView` 全是 false。接著點欄位、瀏覽器把
   輸入框捲進畫面之後仍然只有出貨那張救得回來：確認那張沒有欄位可點，
   永遠停在 595；申訴那張捲到 372–419，看得到，但 elementFromPoint 打到的是
   底部導覽（A.item）—— 看得到、按不到，那是最難自己脫困的一種。
   上一輪加的 revealPanel() 救不了這個：它只在
   「開啟的當下」把面板捲進視野跑一次，鍵盤是之後才升起來的，捲過的位置
   在那一刻就作廢了。所以 revealPanel() 連同它依賴的 .form scroll-margin
   一起拿掉了 —— 覆蓋層是 position: fixed，本來就不必捲；留著一個不再做事
   的捲動函式，下一個人會以為位置是它在管的。

   改成站上已經有四處在用的同一套：貼底覆蓋層（.sheetWrap）＋ 自己捲的面板
   （.sheet）＋ 黏在下緣的動作列（.sheetFoot）。送出鍵的位置從此跟內容多長、
   捲到哪裡、鍵盤有沒有升起來都無關。 */

/* 軟鍵盤讓位（--kb）。這三張面板有下拉、單號、事由、影片連結四個欄位，
   鍵盤必然會彈出來，而 position: fixed 貼的是版面視窗、不是 visualViewport ——
   不讓位的話動作列會躲到鍵盤底下。跟出貨面板、出價面板、登入方式面板同一支。 */
useKeyboardInset()

/* 面板要顯示訂單自己的內容（金額、賣家名），但它已經不在 v-for 裡面了，
   拿不到 r.o。存 id 再回 store 查，不存 Order 物件本身：store.confirm()
   是用 orders.map() 換掉整個物件的，抓在手上的那一份會變成過期的快照。 */
const shipOrder = computed(() => store.orders.find(o => o.id === shipFor.value) ?? null)
const confirmOrder = computed(() => store.orders.find(o => o.id === confirmFor.value) ?? null)
const disputeOrder = computed(() => store.orders.find(o => o.id === disputeFor.value) ?? null)

/**
 * 開面板。三張共用一支，因為它們要做的三件事完全一樣。
 *
 * 三張互斥：它們現在是同一組疊在畫面上的覆蓋層，同時開兩張只會前後蓋住，
 * 而被蓋住那張的送出鍵仍然吃得到 Tab 與 Enter。原本只有「確認收貨」與
 * 「申訴」互斥（那兩顆的結果剛好相反），出貨那張是漏掉的。
 *
 * 焦點進面板本身、不進第一個欄位：覆蓋層是 aria-modal，焦點不進去的話
 * Tab 會走到它背後那些讀不到的東西；但直接聚焦輸入框會在手機上立刻叫出
 * 鍵盤，使用者還沒看清楚這張面板在問什麼，畫面就先少了一半。
 */
let sheetTrigger: HTMLElement | null = null
function openSheet(kind: 'ship' | 'confirm' | 'dispute', id: string) {
  shipFor.value = kind === 'ship' ? id : null
  confirmFor.value = kind === 'confirm' ? id : null
  disputeFor.value = kind === 'dispute' ? id : null
  err.value = ''
  sheetTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  void nextTick(() => document.getElementById(`${kind}Sheet`)?.focus())
}

/** 關法三種都走這裡：點遮罩、取消鍵、Esc。 */
function closeSheet() {
  shipFor.value = null
  confirmFor.value = null
  disputeFor.value = null
  /* 焦點回到剛才按的那顆鈕：訂單卡還在原地，使用者的位置沒有變，焦點也不該變。
     isConnected 一定要驗 —— 放款成功之後那張卡已經換到「已結案」分頁去了，
     節點不在文件裡，focus() 會落回 body，讀屏使用者會被丟回頁首。 */
  if (sheetTrigger?.isConnected) {
    const t = sheetTrigger
    void nextTick(() => t.focus())
  }
  sheetTrigger = null
}

/* Esc。面板是 Teleport 到 body 的，焦點不一定落在裡面（點遮罩之後就在 body 上），
   所以監聽掛在 window 而不是面板節點上。 */
function onEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (shipFor.value || confirmFor.value || disputeFor.value) closeSheet()
}

/** 打開出貨表單。上一次填的一定要清掉 —— 表單是頁面層級的狀態，
    不清的話 A 訂單填的單號會跟著出現在 B 訂單的表單裡，
    而那會把一組單號掛到另一張卡的訂單上（單號在後端是唯一的）。 */
function openShip(o: Order) {
  tracking.value = ''
  carrier.value = ''
  openSheet('ship', o.id)
}
function openConfirm(o: Order) { openSheet('confirm', o.id) }
/* 申訴的三個欄位一樣要清，而且理由比出貨那組更重：
   申訴會凍結點數、送出之後這張訂單就不能再確認收貨 —— 這是這一頁
   最不可逆的動作。不清的話，對 A 單填了事由與開箱影片、按取消，
   再開 B 單時欄位是滿的、送出鍵是亮的，一按就用 A 單的影片
   對 B 單提出申訴。doDispute 只在**成功之後**清，取消那條路沒人清。 */
function openDispute(o: Order) {
  reason.value = ''
  hasVideo.value = false
  videoUrl.value = ''
  openSheet('dispute', o.id)
}

/**
 * 放款成功之後留在畫面上的一句話。
 *
 * 訂單在這一刻剛結案、從「進行中」的清單裡消失，所以這句話不能掛在
 * 訂單卡上 —— 那張卡馬上就不在了。金額與對象在按下的當下就寫進字串，
 * 原因同上：之後再去 o.price 取值，那筆訂單可能已經不在目前這個分頁裡。
 * 不自動消失：使用者要能回頭確認「那 41,000 點是我自己放出去的」。
 */
const released = ref('')
const releasedEl = ref<HTMLElement | null>(null)

async function doConfirm(o: Order) {
  if (busy.value) return
  err.value = ''
  busy.value = true
  try {
    await store.confirm(o.id)
    closeSheet()
    /* 自動切到「已結案」：訂單剛從「進行中」消失，畫面還停在原本那個分頁的話
       使用者看到的是一整片「目前沒有進行中的訂單」加一段教學文 ——
       他會以為訂單被系統吃掉了，而不是自己剛把它結掉。 */
    tab.value = 'done'
    released.value =
      `已確認收貨，${o.price.toLocaleString()} 點已放款給賣家 ${o.sellerName}。` +
      '這筆訂單結案了，就在下面的「已結案」清單裡。'
    /* 訊息長在清單上方，而使用者按下按鈕時人在訂單卡那邊（實測 scrollY 445）——
       不主動捲過去的話這句話會落在視窗上方，等於沒說。 */
    await nextTick()
    releasedEl.value?.scrollIntoView({
      behavior: reduceMotion.value ? 'auto' : 'smooth',
      block: 'center'
    })
  } catch (e) { err.value = e instanceof Error ? e.message : '確認收貨失敗' }
  finally { busy.value = false }
}

async function doShip(o: Order) {
  /* 唯一的門檻是「有填單號就要填對」。沒填、沒選物流商都照樣出得了貨 ——
     平台不經手實體卡，留存證據的設計本來就跟現實對不上。 */
  if (trackErr.value || busy.value) return
  err.value = ''
  busy.value = true
  try {
    await store.ship(o.id, {
      carrier: carrier.value || undefined,
      tracking: tracking.value.trim() || undefined
    })
    closeSheet()
    tracking.value = ''
  } catch (e) { err.value = e instanceof Error ? e.message : '出貨失敗' }
  finally { busy.value = false }
}
/* ==================================================================
   包裹被退回
   ==================================================================
   買家沒去超商取貨、包裹退回賣家手上 —— 系統看到的跟「買家收到了卻裝死」
   一模一樣，都是「買家沒動作」。產品上的決定是**不動結案規則**：
   交付與否由雙方自己談，點數照常釋放（買家沒去領確實是買家的責任）。

   所以這一塊的目的不是改變任何金流，是把「發生了什麼事」講出來：
   買家至少要知道包裹沒送到、而且知道去找誰；賣家則多一筆平台紀錄，
   證明貨是他寄的、是對方沒領。 */

/** 買家那側：種類決定呈現。手機撥得出去，LINE ID 只能複製 */
const CONTACT_LABEL: Record<SellerContact['kind'], string> = {
  phone: '手機', line: 'LINE ID', other: '聯絡方式'
}
/**
 * tel: 只給手機那一種 —— LINE ID 撥不出去，給了只會撥到一個不存在的號碼。
 *
 * 撥號網址裡只留數字與 +（賣家常填成 09xx-xxx-xxx 或帶空白），其餘字元
 * 有些撥號程式會整串當成無效。這個值不會進頁面網址、不會進 console，
 * 它是賣家自願提供給這位買家的資訊，離開這張卡就不該再出現。
 */
const telHref = (c: SellerContact) =>
  c.kind === 'phone' ? `tel:${c.value.replace(/[^\d+]/g, '')}` : ''

/* 回報退件：哪一筆正在送、以及這一筆的結果。用 id 不用布林 ——
   一頁上有好幾張訂單卡，布林會讓每一顆按鈕同時變成「處理中」。 */
const returnBusy = ref<string | null>(null)
const returnErr = ref<Record<string, string>>({})

async function reportReturned(o: Order) {
  if (returnBusy.value) return
  returnBusy.value = o.id
  returnErr.value = { ...returnErr.value, [o.id]: '' }
  try {
    await api.reportReturned(o.id)
    /* 成功不另外報喜：訂單卡上會直接長出「已回報退回」那一塊，
       那比一句會自己消失的提示更持久，也是賣家事後回來要找的東西。 */
  } catch (e) {
    returnErr.value = { ...returnErr.value, [o.id]: e instanceof Error ? e.message : '回報失敗，請稍後再試' }
  } finally {
    returnBusy.value = null
  }
}

/** 回報時間。只講到分鐘 —— 這是給雙方對話用的時間點，不是稽核紀錄 */
const returnedAtText = (t: number) =>
  new Date(t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

async function doDispute(o: Order) {
  if (!canDispute() || busy.value) return
  err.value = ''
  busy.value = true
  try {
    await store.dispute(o.id, reason.value.trim() || '未說明', true, videoUrl.value.trim())
    closeSheet()
    reason.value = ''
    hasVideo.value = false
    videoUrl.value = ''
  } catch (e) { err.value = e instanceof Error ? e.message : '申訴送出失敗' }
  finally { busy.value = false }
}
</script>

<template>
  <div class="container page">
    <header class="head">
      <h1>我的訂單</h1>
      <p class="muted sub">需寄送的交易會走託管。庫內轉移不產生訂單，成交即結束。</p>
    </header>

    <div class="bal">
      <div><span class="bl">可動用</span><strong class="mono">{{ wallet.available.toLocaleString() }}</strong></div>
      <div><span class="bl">託管中</span><strong class="mono lock">{{ wallet.locked.toLocaleString() }}</strong></div>
    </div>

    <div class="tabs" role="tablist">
      <button type="button" role="tab" :aria-selected="tab === 'open'"
        class="chip" :class="{ on: tab === 'open' }" @click="tab = 'open'">
        進行中 {{ store.openCount }}
      </button>
      <button type="button" role="tab" :aria-selected="tab === 'done'"
        class="chip" :class="{ on: tab === 'done' }" @click="tab = 'done'">已結案</button>
    </div>

    <!-- 放款成功。這句話擺在清單上方而不是訂單卡裡，因為那張卡在這一刻
         已經換到「已結案」分頁去了。沒有它的話，使用者按完「我已收到」
         看到的只有「訂單不見了」。 -->
    <p v-if="released" ref="releasedEl" class="okMsg" role="status">{{ released }}</p>

    <!-- 雙方按下完成的機制。規則本來就在跑，但使用者看不到就等於不存在 ——
         逾時的三條尤其重要：它們會在沒有人動作的時候把錢移到某一邊 -->
    <section v-if="tab === 'open'" class="how">
      <h2 class="howH">怎麼完成一筆交易</h2>
      <ol class="howL">
        <li>平台把買家的收件資訊交給賣家，賣家<b>直接寄給買家</b>。寄送方式、時間與運費由雙方自己談 —— 平台不經手實體卡。</li>
        <li>賣家寄出後按「我已寄出」，買家收到後按「我已收到」。<b>兩邊都按，款項才放給賣家。</b></li>
      </ol>
      <ul class="howR">
        <li><span class="howTag warn">{{ SHIP_HOURS }} 小時</span>賣家沒按「我已寄出」→ 自動取消、全額退款、沒收賣家保證金。</li>
        <li><span class="howTag">{{ DELIVER_DAYS }} 天</span>買家一直沒有動作 → 視同送達，再過 {{ INSPECT_DAYS }} 天自動放款給賣家。</li>
      </ul>
    </section>

    <p v-if="err" class="err" role="alert">{{ err }}</p>
    <!-- 讀不到訂單要說「讀不到」。這一層一定要排在空狀態前面：斷網時
         list 是空的，沒有它就直接掉進「目前沒有進行中的訂單」——
         而使用者的託管訂單裡有錢，那句話等於在斷網時說他的錢不見了。
         （同一條判斷在大廳的池清單也是這樣擺的。） -->
    <div v-if="store.loadErr" class="loadFail" role="alert">
      <p class="muted">{{ store.loadErr }}</p>
      <button type="button" class="btn" @click="store.load()">重試</button>
    </div>
    <p v-else-if="!list.length" class="empty muted">
      {{ tab === 'open' ? '目前沒有進行中的訂單。到市場買一張「需寄送」的卡就會建立託管訂單。' : '還沒有結案的訂單。' }}
    </p>

    <article v-for="r in rows" :key="r.o.id" class="ord">
      <div class="top">
        <CardArt class="thumb" :image="r.o.card.image" :alt="r.o.card.name"
                 :art-id="r.o.card.artId" />
        <div class="meta">
          <strong class="nm">{{ r.o.card.name }}</strong>
          <p class="who">
            <span class="role" :class="r.role">{{ r.role === 'seller' ? '我是賣家' : '我是買家' }}</span>
            <!-- 買家那側不在這裡重複賣家名字：下面那塊會完整顯示（頭像、等級、
                 出貨天數、爭議率），同一個名字在 100px 內出現兩次只是噪音 -->
            <template v-if="r.role === 'seller'">{{ r.o.buyerName }}</template>
          </p>
          <p class="amt mono">{{ r.o.price.toLocaleString() }} 點<span v-if="r.o.deposit"> · 保證金 {{ r.o.deposit.toLocaleString() }}</span></p>
        </div>
        <!-- 兩個角標可以同時在：結案規則沒有因為退件改變，所以一筆訂單
             完全可能同時是「已完成」（錢放了）跟「待重寄」（貨還沒到）。
             它們講的是兩件不衝突的事，畫面就要兩個都說得出來 —— 只留一個
             的話，不管留哪個都在騙人。 -->
        <div class="stCol">
          <span class="st" :class="r.o.status">{{ STATUS_TEXT[r.o.status] }}</span>
          <span v-if="r.o.returnedAt" class="st ret">待重寄</span>
        </div>
      </div>

      <!-- 包裹被退回。兩種角色都看得到，但講的話不一樣：
           買家要知道「東西沒到你手上、去找賣家安排重寄、運費多半是你出」，
           賣家要知道「紀錄留下了，買家已經收到通知」。
           擺在最上面：它推翻的是這張卡上其他每一句話的前提（貨在路上／已送達）。 -->
      <section v-if="r.o.returnedAt" class="retBox" role="note">
        <p class="retT">包裹被退回賣家了</p>
        <template v-if="r.role === 'buyer'">
          <p class="retB">
            這件包裹沒有在保管期限內被領取，已經退回賣家手上，<b>卡還沒到你手上</b>。
            平台不經手實體卡，重寄要你直接跟賣家談 —— <b>重寄的運費通常由買家負擔</b>。
          </p>
          <p class="retB">
            賣家在 <b class="mono">{{ returnedAtText(r.o.returnedAt) }}</b> 回報。
            這件事<b>不會改變這筆訂單的時限與結案</b>：該放款的照放、該結案的照結，
            所以就算下面寫著「已完成」，重寄這件事還是要你們自己談定。
          </p>
        </template>
        <template v-else>
          <p class="retB">
            你在 <b class="mono">{{ returnedAtText(r.o.returnedAt) }}</b> 回報了這一筆，買家已經收到通知。
            紀錄留在這張訂單上 —— 買家事後說「沒收到」時，這就是你寄過、而對方沒領的證據。
          </p>
          <p class="retB">
            要不要重寄、運費怎麼算，由你們自己談。你的款項不受影響，時限與結案規則也沒有變。
          </p>
        </template>
      </section>

      <!-- 買家那半。順序照買家心裡的順序：誰要寄給我 → 走到哪 → 我該做什麼 → 我的錢在哪。
           擺在訂單編號之前，因為進度才是他點進來的理由，編號是要聯絡時才用得到的東西 -->
      <section v-if="r.bv" class="mine">
        <!-- 1. 賣家是誰。名字不夠：等級、出貨天數、爭議率才判斷得出要不要擔心 -->
        <!-- 整列是連往賣家頁的連結，不是 SellerChip 自己那顆。
             SellerChip 內建的連結只有 22px 高，手機上按不到，而那個元件是
             市場頁與賣家頁共用的，不能為了這一頁改它的尺寸 ——
             所以這裡把 link 關掉，改由外層這一列提供 44px 的觸控目標。 -->
        <component
          :is="sellerOf[r.o.sellerId] ? 'RouterLink' : 'div'"
          :to="sellerOf[r.o.sellerId] ? `/sellers/${r.o.sellerId}` : undefined"
          class="who2"
        >
          <span class="lb">賣家</span>
          <SellerChip v-if="sellerOf[r.o.sellerId]" :seller="sellerOf[r.o.sellerId]!" size="sm" :link="false" />
          <!-- 查不到賣家檔案的退路版。一般使用者從保管庫上架就沒有檔案，
               那時候至少要有名字，不能整塊消失 -->
          <span v-else class="fb">
            <span class="fbAv" aria-hidden="true">{{ (r.o.sellerName || '?').slice(0, 1) }}</span>
            <span class="fbNm">{{ r.o.sellerName || '未具名賣家' }}</span>
          </span>
          <svg v-if="sellerOf[r.o.sellerId]" class="whoGo" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor"
                  stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </component>
        <ul v-if="sellerOf[r.o.sellerId]" class="stats">
          <li>
            <b class="mono">{{ sellerOf[r.o.sellerId]!.stats.cardsShipped.toLocaleString() }}</b>
            <span>已出貨</span>
          </li>
          <li>
            <b class="mono">{{ sellerOf[r.o.sellerId]!.stats.avgShipDays }} 天</b>
            <span>平均出貨</span>
          </li>
          <li>
            <b class="mono">{{ sellerOf[r.o.sellerId]!.stats.disputeRate }}%</b>
            <span>爭議率</span>
          </li>
        </ul>

        <!-- 2. 走到哪一步。三段，現在那一段標出來並帶剩餘時間 ——
             「等賣家寄出，剩 62 小時」一眼就講完了狀態與急迫性 -->
        <ol class="steps">
          <li v-for="(st, i) in r.bv.steps" :key="i" :class="st.state">
            <span class="dot" aria-hidden="true"></span>
            <span class="sTx">{{ st.label }}</span>
            <span v-if="st.state === 'now' && r.dl" class="sRe mono">{{ remainText(r.dl.at - now) }}</span>
          </li>
        </ol>

        <!-- 3. 我現在能做什麼 / 該等什麼 -->
        <p class="todo">{{ r.bv.todo }}</p>
      </section>

      <!-- 錢的狀態。一顆元件服務兩種角色，位置卻剛好都對：
           買家的 .mine 就在上面，所以它落在「誰要寄給我 → 走到哪 →
           我該做什麼 → 我的錢在哪」的第四順位；賣家沒有 .mine，同一塊就直接
           接在卡片抬頭下面 —— 而賣家點進來的第一個問題正是「我什麼時候拿得到錢」。
           side 跟著 r.role 走：同一個 escrowed，賣家要聽到「你寄出才會放款」，
           買家要聽到「你的點數還在平台保管」。
           不放進 .mine 裡面：那一塊的底色就是 --surface-2，這一塊疊上去會糊成一片。 -->
      <PointsFlow
        src="market" :side="r.role" :status="r.o.status"
        :amount="r.o.price" :deposit="r.o.deposit"
      />

      <!-- 訂單編號：雙方在 LINE 上對話時唯一的共同代號。兩邊都看得到、
           兩邊都複製得走 —— 少了它，「我那張噴火龍」在賣家那邊可能有三筆 -->
      <div class="idBox">
        <CopyLine
          label="訂單編號" :value="r.o.id" mono big
          :testid="`copy-id-${r.o.id}`"
        />
        <p class="idWhy">跟對方聯絡時報這個編號，才知道在講哪一筆。</p>
      </div>

      <!-- 買家：聯絡賣家。
           有值就顯示，**不看訂單狀態** —— 權限判斷在伺服器的 SQL 做完了
           （只有這筆訂單的買家拿得到值），而結案之後才是最需要它的時候：
           包裹被退回、卡況有疑問都發生在「訂單已經結束」之後，那時候
           站上如果沒有一條聯絡管道，買家連開口的地方都沒有（站上沒有私訊）。
           擺在訂單編號下面：那兩樣東西是聯絡時要一起用的。 -->
      <section v-if="r.o.sellerContact" class="ct">
        <h3 class="ctH">聯絡賣家</h3>
        <CopyLine
          :label="CONTACT_LABEL[r.o.sellerContact.kind]"
          :value="r.o.sellerContact.value"
          :mono="r.o.sellerContact.kind === 'phone'"
          :testid="`copy-contact-${r.o.id}`"
        />
        <!-- 手機才給撥號鍵。LINE ID 撥不出去，給一顆按了會失敗的鍵
             比不給更糟 —— 那一種只能複製後自己去搜尋。 -->
        <a v-if="r.o.sellerContact.kind === 'phone'" class="ctCall" :href="telHref(r.o.sellerContact)">
          撥給賣家
        </a>
        <p class="ctWhy">
          這是賣家自己填的對外聯絡方式。平台不代為聯絡，也不經手實體卡 ——
          寄送、重寄與運費請直接跟他談，報上面的訂單編號最快。
        </p>
      </section>

      <!-- 時限：整套機制的重點，放最顯眼 -->
      <div v-if="r.dl" class="dl" :class="r.dl.tone">
        <div class="dlTop">
          <span>{{ r.dl.label }}</span>
          <strong class="mono">{{ remainText(r.dl.at - now) }}</strong>
        </div>
        <p>{{ r.dl.then }}</p>
      </div>

      <!-- 賣家的寄件依據。權限判斷在伺服器的 SQL 做完了：有值就是可以顯示。
           這裡只判斷「我是不是賣家」是為了 mock（mock 沒有伺服器把關），
           以及確保買家那側永遠不會渲染到這一塊 -->
      <section v-if="r.role === 'seller' && isOpen(r.o)" class="send">
        <h3 class="sendH">
          <svg class="sendIco" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 5.4l6-2.9 6 2.9v5.2l-6 2.9-6-2.9z" fill="none"
                  stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
            <path d="M2 5.4l6 2.9 6-2.9M8 8.3v5.2" fill="none"
                  stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          </svg>
          寄給買家
        </h3>

        <template v-if="r.sv.any">
          <CopyLine v-if="r.sv.name" label="收件人" :value="r.sv.name" :testid="`copy-name-${r.o.id}`" />
          <p v-else class="gap"><span class="gapLb">收件人</span><span class="gapTag">買家還沒填</span></p>

          <CopyLine v-if="r.sv.phone" label="電話" :value="r.sv.phone" mono :testid="`copy-phone-${r.o.id}`" />
          <p v-else class="gap"><span class="gapLb">電話</span><span class="gapTag">買家還沒填</span></p>

          <CopyLine v-if="r.sv.addr" label="地址" :value="r.sv.addr" :testid="`copy-addr-${r.o.id}`" />
          <p v-else class="gap"><span class="gapLb">地址</span><span class="gapTag">買家還沒填</span></p>

          <button
            type="button" class="allBtn" :class="{ done: copiedAll === r.o.id }"
            :data-testid="`copy-all-${r.o.id}`" @click="copyAll(r)"
          >{{ copiedAll === r.o.id ? '已複製，可以直接貼上' : '複製全部（含訂單編號）' }}</button>
          <p v-if="copyErr" class="copyErr" role="status">{{ copyErr }}</p>

          <!-- 「照這個地址寄出」只有真的有地址時才成立。地址那一欄是空的時候
               還講這句話，等於叫賣家照著一片空白寄 -->
          <p class="sendWhy">
            <template v-if="r.sv.addr">照這個地址寄出。</template>寄送方式、時間與運費請直接跟買家聯絡
            —— 平台不經手實體卡，也不會替你追蹤包裹。
          </p>

          <!-- 只填了一部分：有的照給，缺的講出來並給一條去要的路。
               連結不寫在句子中間 —— 行內連結的可點高度只有一行字（實測 14px），
               手機上按不到。獨立成一顆按鈕才有 44px。 -->
          <div v-if="r.sv.missing.length" class="ask">
            <p class="askB warnB">
              還缺{{ r.sv.missing.join('、') }}，這樣寄不出去。
              請用你們原本的聯絡方式跟買家要，或開一張客服工單。
            </p>
            <RouterLink class="askBtn" to="/support/new?kind=other">開一張客服工單跟買家要</RouterLink>
          </div>
        </template>

        <!-- 完全沒填。這一格不能是空白 —— 賣家會以為系統壞了，然後什麼都不做，
             直到 72 小時到期被判逾期未出貨 -->
        <div v-else class="ask">
          <p class="askT">買家還沒填收件資料</p>
          <p class="askB">
            平台這邊沒有他的地址，所以沒辦法給你。請跟買家要收件人、電話與地址 ——
            拿到之後直接寄出，再回來按「我已寄出」。
          </p>
          <RouterLink class="askBtn" to="/support/new?kind=other">開一張客服工單跟買家要</RouterLink>
          <p class="askB">也可以用你們原本的聯絡方式問，報上面的訂單編號比較快。</p>
        </div>
      </section>

      <p v-if="r.o.tracking" class="trk mono">單號 {{ r.o.tracking }}</p>
      <p v-if="r.o.disputeReason" class="dr">爭議：{{ r.o.disputeReason }}</p>

      <!-- 可做的動作完全由狀態機決定，UI 不自己判斷 -->
      <div class="acts">
        <template v-for="a in actionsFor(r.o, r.role)" :key="a">
          <button v-if="a === 'ship'" type="button" class="btn primary sm" @click="openShip(r.o)">
            我已寄出
          </button>
          <!-- 這一顆不再直接呼叫 store.confirm()：它是全站唯一「按一下就
               不可還原地把錢放出去」的按鈕，先開確認面板（見下面的 #confirmSheet） -->
          <button v-if="a === 'confirm'" type="button" class="btn primary sm" @click="openConfirm(r.o)">
            我已收到
          </button>
          <button v-if="a === 'dispute'" type="button" class="btn sm" @click="openDispute(r.o)">
            我要申訴
          </button>
        </template>

        <!-- demo：物流回報與平台裁決在正式版不是使用者按的 -->
        <button v-if="MOCK && r.o.status === 'shipped'" type="button" class="btn sm ghost" @click="store.markDelivered(r.o.id)">
          模擬物流簽收
        </button>
        <template v-if="MOCK && r.o.status === 'disputed'">
          <button type="button" class="btn sm ghost" @click="store.resolve(r.o.id, 'buyer')">裁決：判買家</button>
          <button type="button" class="btn sm ghost" @click="store.resolve(r.o.id, 'seller')">裁決：判賣家</button>
        </template>
      </div>

      <!-- 賣家：包裹被退回了。
           出貨之後才給（還沒寄就沒有東西會被退回），已經回報過就換成上面那塊紀錄。

           文案刻意寫成「對你有利」而不是「你應該回報」：他不按也照樣拿得到錢，
           一句義務句換不到任何行為。真正有價值的是那筆紀錄 ——
           買家事後申訴「東西沒收到」時，那是他手上唯一能證明貨寄了、
           是對方沒領的東西；什麼都沒按的賣家在爭議裡是空手的。
           cancelled 排除掉：那是逾期未出貨自動取消的，根本沒有包裹。 -->
      <div
        v-if="r.role === 'seller' && !r.o.returnedAt
          && r.o.status !== 'escrowed' && r.o.status !== 'cancelled'"
        class="retAsk"
      >
        <p class="retAskB">
          買家沒去取貨、包裹退回你手上了嗎？回報一下，平台會<b>留下紀錄並通知買家</b>。
          買家之後說「沒收到」的時候，這筆紀錄就是你寄過、而他沒領的證據。
          <b>你的款項不受影響</b>，訂單的時限與結案規則也不會因為這個動作改變。
        </p>
        <button
          type="button" class="btn sm" :disabled="returnBusy === r.o.id"
          :data-testid="`report-returned-${r.o.id}`"
          @click="reportReturned(r.o)"
        >{{ returnBusy === r.o.id ? '回報中…' : '包裹被退回了' }}</button>
        <p v-if="returnErr[r.o.id]" class="retErr" role="alert">{{ returnErr[r.o.id] }}</p>
      </div>

      <!-- 「我要問一件事」。它跟上面那顆「我要申訴」是兩件事：申訴會凍結點數、
           要開箱影片、之後不能再確認收貨；這一顆不動錢，只開一張客服工單。
           所以它自成一列、長得也不一樣（虛線外框），而且**不分狀態**都給 ——
           已結案的訂單申訴不了，那正是最需要有地方可以問的時候。 -->
      <OrderIssue
        src="market" :ref-id="r.o.id" :card-name="r.o.card.name"
        :side="r.role" :status-text="STATUS_TEXT[r.o.status]"
      />

    </article>

    <!-- 時間旅行：不用真的等 7 天就能看完整條流程。只有 mock 有；伺服器的時間不能撥 -->
    <section v-if="MOCK" class="dev">
      <h2>Demo 時鐘</h2>
      <p class="muted">
        時限是用時間戳算的，不是背景排程 —— 把時鐘往前撥，到期的訂單會立刻自己結案。
        目前偏移 <strong class="mono">{{ Math.round(store.offset / HOUR) }}</strong> 小時。
      </p>
      <div class="devRow">
        <button type="button" class="btn sm" @click="store.travel(HOUR)">+1 小時</button>
        <button type="button" class="btn sm" @click="store.travel(DAY)">+1 天</button>
        <button type="button" class="btn sm" @click="store.travel(3 * DAY)">+3 天</button>
        <button type="button" class="btn sm" @click="store.travel(8 * DAY)">+8 天</button>
        <!-- 收件資料的三種情況各給一顆。第三種（完全沒填）在正式環境是常態，
             而且是最容易被做壞的那個畫面 —— 沒有這顆按鈕，開發時只會看到
             有地址的版本 -->
        <button type="button" class="btn sm ghost" @click="seedDemo('full')">+ 賣家單・地址齊全</button>
        <button type="button" class="btn sm ghost" @click="seedDemo('partial')">+ 賣家單・只填一半</button>
        <button type="button" class="btn sm ghost" @click="seedDemo('none')">+ 賣家單・完全沒填</button>
        <button type="button" class="btn sm ghost" @click="seedDemo('long')">+ 賣家單・超長地址</button>
        <!-- 買家視角的四種狀態各一顆：每一種畫面上講的話都不一樣，
             只造得出一種的話其餘三種永遠沒有人看過 -->
        <button type="button" class="btn sm ghost" @click="seedBuyer('escrowed')">+ 買家單・等寄出</button>
        <button type="button" class="btn sm ghost" @click="seedBuyer('shipped')">+ 買家單・已寄出</button>
        <button type="button" class="btn sm ghost" @click="seedBuyer('completed')">+ 買家單・已完成</button>
        <button type="button" class="btn sm ghost" @click="seedBuyer('disputed')">+ 買家單・爭議中</button>
        <button type="button" class="btn sm ghost" @click="seedBuyer('shipped', true)">+ 買家單・超長名稱</button>
        <!-- 退件的兩張。買家那張刻意造在 completed 上：那正是最難講清楚的一格
             （錢已經放了、貨卻沒到），不造出來就沒有人看過兩個角標同時在的樣子。
             賣家那張要 shipped，回報鍵在出貨後才出現。 -->
        <button type="button" class="btn sm ghost" @click="seedBuyerReturned()">+ 買家單・已完成但退回</button>
        <button type="button" class="btn sm ghost" @click="seedSellerShipped()">+ 賣家單・已寄出</button>
        <button type="button" class="btn sm ghost" @click="store.reset()">全部清除</button>
      </div>
    </section>

    <!-- ── 三張面板：貼底覆蓋層 ────────────────────────────────────
         「我已寄出」「我已收到」「我要申訴」原本是行內展開的 .form，
         三張的送出鍵在鍵盤升起（393×420）的那一刻都掉到視窗外
         （實測 508 / 595 / 682，inView 全是 false）。改成覆蓋層之後三張
         一律停在 311–355，hittable 都是按鈕自己。
         改成站上既有的那一套：貼底、面板自己捲、動作列黏在面板下緣，
         送出鍵的位置從此跟內容多長、捲到哪、鍵盤有沒有升起來都無關。

         Teleport 到 body 不是整潔問題：換頁轉場會在 .page 上加 transform，而
         **祖先只要有 transform，position: fixed 的定位基準就會變成那個祖先
         而不是視窗**（docs/HANDOFF.md 2.2）—— 面板會被推出畫面外並被裁掉。
         .sheetWrap / .sheet.hasFoot / .sheetFoot 跟卡冊的出貨面板、公開卡冊的
         出價面板、登入方式面板是同一套。使用者只要學一次。
         關法三種：點遮罩、取消鍵、Esc。

         三張都掛 .hasFoot（連只有說明文字的收貨確認也是）：確認面板的第一段
         會把賣家名字唸出來，而那是使用者自己填的自由字串（demo 的「超長名稱」
         那顆就是在測它）—— 內容會長大的面板，動作列就得黏底。 -->

    <!-- 出貨。兩欄都是選填，畫面上要明說 —— 舊版看起來像必填，
         賣家會以為沒單號就出不了貨 -->
    <Teleport to="body">
      <div v-if="shipOrder" class="sheetWrap" @click.self="closeSheet()">
        <div
          id="shipSheet" class="sheet card hasFoot"
          role="dialog" aria-modal="true" aria-label="我已寄出" tabindex="-1"
        >
          <h2 class="sheetH">我已寄出</h2>
          <p class="lead">
            按下「我已寄出」代表卡已經寄出去了，買家的收貨時鐘會從那一刻開始跑。
            下面兩欄<b>都是選填，不填也能出貨</b>。
          </p>
          <label>
            物流商（選填）
            <select v-model="carrier">
              <option value="">不指定</option>
              <option v-for="c in CARRIERS" :key="c.id" :value="c.id">{{ c.label }}</option>
            </select>
          </label>
          <label>
            物流單號（選填）
            <input
              v-model="tracking" type="text"
              :placeholder="trackHint"
              :aria-invalid="!!trackErr"
            />
            <!-- 錯在哪要當場講。只說「格式不正確」的話賣家看不出問題，
                 只會一直重打同一組 -->
            <span v-if="trackErr" class="warnLine">{{ trackErr }}</span>
          </label>
          <p class="hint">
            平台沒有串物流，不會去查這組單號，也不會拿它當放款條件。填了只是在
            爭議時多一個客服查得到的線索。真正的送達確認是買家按下「我已收到」。
          </p>

          <!-- 動作列黏在面板下緣（.sheetFoot 是 position: sticky）。
               送出失敗的訊息要在這裡再說一次：頁面層級那一行被遮罩蓋住了，
               而使用者的眼睛在這張面板上。 -->
          <div class="sheetFoot">
            <p v-if="err" class="errLine" role="alert">{{ err }}</p>
            <div class="acts">
              <button
                type="button" class="btn primary sm" data-testid="ship-submit"
                :disabled="!!trackErr || busy" @click="doShip(shipOrder)"
              >{{ busy ? '處理中…' : '我已寄出' }}</button>
              <button type="button" class="btn sm" :disabled="busy" @click="closeSheet()">取消</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 收貨確認。它是全站唯一「按一下就不可還原地把錢放出去」的動作，
         文案要講滿三件事：不可還原、多少錢、給誰。少講任何一件，
         使用者按下去的時候就不知道自己在同意什麼。 -->
    <Teleport to="body">
      <div v-if="confirmOrder" class="sheetWrap" @click.self="closeSheet()">
        <div
          id="confirmSheet" class="sheet card hasFoot"
          role="dialog" aria-modal="true" aria-label="確認收貨" tabindex="-1"
        >
          <h2 class="sheetH">確認收貨</h2>
          <p class="lead">
            確認之後，<b>{{ confirmOrder.price.toLocaleString() }} 點會立刻放款給賣家 {{ confirmOrder.sellerName }}</b>。
            這個動作<b>不能還原</b>，這筆訂單之後也不能再申訴。
          </p>
          <p class="hint">
            卡還沒收到、或東西跟描述不符，就先按「取消」，改按「我要申訴」——
            申訴要附完整未剪輯的開箱影片，所以拆封前先開始錄。
          </p>
          <div class="sheetFoot">
            <p v-if="err" class="errLine" role="alert">{{ err }}</p>
            <div class="acts">
              <button
                type="button" class="btn primary sm" data-testid="confirm-submit"
                :disabled="busy" @click="doConfirm(confirmOrder)"
              >{{ busy ? '處理中…' : '確定收到，放款給賣家' }}</button>
              <button type="button" class="btn sm" :disabled="busy" @click="closeSheet()">取消</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 申訴：沒有開箱影片不受理 -->
    <Teleport to="body">
      <div v-if="disputeOrder" class="sheetWrap" @click.self="closeSheet()">
        <div
          id="disputeSheet" class="sheet card hasFoot"
          role="dialog" aria-modal="true" aria-label="我要申訴" tabindex="-1"
        >
          <h2 class="sheetH">我要申訴</h2>
          <label>
            發生什麼事
            <input v-model="reason" type="text" placeholder="例如：盒內是空的" />
          </label>
          <label v-if="MOCK" class="chk">
            <input v-model="hasVideo" type="checkbox" />
            我有完整未剪輯的開箱影片（從封箱狀態開始、拍到面單與鑑定編號）
          </label>
          <label v-else>
            開箱影片連結（完整未剪輯、從封箱狀態開始、拍到面單與鑑定編號）
            <input v-model="videoUrl" type="url" placeholder="https://…" />
          </label>
          <p class="hint">沒有影片無法受理索賠 —— 買東西不強制錄影，但要申請退款必須附。</p>
          <div class="sheetFoot">
            <p v-if="err" class="errLine" role="alert">{{ err }}</p>
            <!-- 灰按鈕的理由，就在動作列正上方。用 --warn-ink 不用 --danger：
                 使用者沒做錯事，只是還沒填完。role="status" 讓讀屏在貼上連結的
                 當下就聽到門檻過了，不必自己去 Tab 一圈猜。 -->
            <p v-if="disputeBlockWhy" id="disputeWhy" class="blockWhy" role="status">{{ disputeBlockWhy }}</p>
            <div class="acts">
              <button
                type="button" class="btn primary sm" data-testid="dispute-submit"
                :disabled="!canDispute() || busy"
                :aria-describedby="disputeBlockWhy ? 'disputeWhy' : undefined"
                @click="doDispute(disputeOrder)"
              >{{ busy ? '處理中…' : '送出申訴' }}</button>
              <button type="button" class="btn sm" :disabled="busy" @click="closeSheet()">取消</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.warnLine { display: block; margin-top: 5px; font-size: 12.5px; line-height: 1.6; color: var(--warn, #fcd34d); }
select {
  /* 44px 不放在 @media (pointer: coarse) 裡：桌機的下拉一樣是這一頁最主要的
     互動之一，而且 padding 算出來只有 42px —— 差 2px 沒有任何好處 */
  min-height: 44px;
  padding: 10px 11px; font: inherit; font-size: 16px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--field, var(--surface-2)); color: var(--ink);
}

.head { margin-bottom: 14px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { font-size: 13px; margin: 0; }

.bal {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
  background: var(--surface); border-radius: var(--radius-lg);
  padding: 14px 16px; margin-bottom: 14px;
}
.bl { display: block; font-size: 11.5px; color: var(--muted); margin-bottom: 2px; }
.bal strong { font-size: 18px; }
.bal .lock { color: var(--gold); }

.tabs { display: flex; gap: 8px; margin-bottom: 14px; }
/* 全域的 .chip 是「標籤」不是按鈕，高度只有 33px。這兩顆是真的要按的分頁，
   撐到觸控目標下限 —— 標籤與按鈕長得一樣但功能不同時，該讓功能決定尺寸 */
.tabs .chip { min-height: 44px; padding: 0 16px; }
.empty { padding: 28px 4px; font-size: 14px; line-height: 1.8; }

.ord { background: var(--surface); border-radius: var(--radius-lg); padding: 14px; margin-bottom: 12px; }
.top { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; gap: 12px; align-items: start; }
/* grid 子元素的預設 min-width 是 auto —— 沒有這一行，長卡名（或沒有空白的
   長字串）會把中間那欄撐到比容器寬，手機上整頁橫向捲 */
.meta { min-width: 0; }
.thumb { width: 52px; height: 73px; border-radius: 6px; overflow: hidden; }
.thumb :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.nm { display: block; font-size: 14.5px; line-height: 1.4; margin-bottom: 4px; overflow-wrap: anywhere; }
.who { font-size: 12px; color: var(--muted); margin: 0 0 3px; }
.role {
  display: inline-block; font-size: 10px; font-weight: 700;
  padding: 1px 6px; border-radius: var(--pill); margin-right: 5px;
}
.role.buyer { background: var(--accent-wash); color: var(--accent); }
.role.seller { background: var(--ok-wash); color: var(--ok); }
.amt { font-size: 13px; margin: 0; }
.st {
  font-size: 11px; font-weight: 700; white-space: nowrap;
  padding: 4px 9px; border-radius: var(--pill);
  background: var(--surface-3); color: var(--muted);
}
.st.delivered, .st.escrowed, .st.shipped { color: var(--ink); }
.st.disputed { background: var(--danger-wash); color: var(--danger); }
.st.completed { background: var(--ok-wash); color: var(--ok); }
/* 狀態欄可以疊兩個角標（已完成 ＋ 待重寄）。justify-items: end 讓它們
   在右緣對齊，不會因為字數不同而參差 */
.stCol { display: grid; gap: 4px; justify-items: end; }
.st.ret { background: var(--warn-wash); color: var(--warn-ink); }

/* ---- 包裹被退回 ----
   用警示色而不是危險色：沒有人做錯事，但這件事推翻了這張卡上其他每一句話
   的前提（貨在路上／已送達），所以它要比一般說明重。 */
/* 不叫 .ret：那個名字已經被上面那顆「待重寄」角標（.st.ret）用掉了，
   同名的話這一段的 padding 與底色會一起打到那顆角標上 */
.retBox {
  margin-top: 12px; padding: 12px;
  background: var(--warn-wash); border-radius: var(--radius);
  box-shadow: inset 2px 0 0 var(--warn);
}
.retT { margin: 0 0 6px; font-size: 13px; font-weight: 700; color: var(--warn-ink); }
.retB {
  margin: 0 0 6px; font-size: 12px; line-height: 1.8; color: var(--muted);
  /* 時間與長字串要收得住 —— 這一塊在 393px 上跟卡圖同一欄寬 */
  overflow-wrap: anywhere;
}
.retB:last-child { margin-bottom: 0; }
.retB b { color: var(--ink); font-weight: 600; }

/* 賣家那顆回報鍵。虛線外框跟「複製全部」同一種語彙：可選的動作，不是主要流程 */
.retAsk {
  margin-top: 12px; padding: 11px 12px;
  border: 1px dashed var(--line); border-radius: var(--radius);
}
.retAskB { margin: 0 0 10px; font-size: 12px; line-height: 1.8; color: var(--muted); overflow-wrap: anywhere; }
.retAskB b { color: var(--ink); font-weight: 600; }
.retErr { margin: 8px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--danger-ink); overflow-wrap: anywhere; }

/* ---- 買家：聯絡賣家 ----
   跟賣家那塊寄件依據（.send，左緣 accent）分開用 info 色，跟 .mine 同一族 ——
   這一塊是買家的東西 */
.ct {
  margin-top: 12px; padding: 4px 12px 12px;
  background: var(--surface-2); border-radius: var(--radius);
  box-shadow: inset 2px 0 0 var(--info-ink);
}
.ctH { font-size: 13px; margin: 10px 0 0; color: var(--ink); }
.ctCall {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 44px; padding: 11px 18px; margin-top: 6px;
  border-radius: var(--pill); background: var(--accent-wash);
  color: var(--accent); font-size: 13px; font-weight: 600; text-decoration: none;
}
.ctCall:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ctWhy { margin: 10px 0 0; font-size: 11.5px; line-height: 1.7; color: var(--muted); }

.dl { border-radius: var(--radius); padding: 10px 12px; margin-top: 12px; background: var(--surface-2); }
.dl.warn { box-shadow: inset 2px 0 0 var(--warn); }
.dl.ok { box-shadow: inset 2px 0 0 var(--ok); }
.dl.danger { box-shadow: inset 2px 0 0 var(--danger); }
.dlTop { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.dlTop span { font-size: 12px; color: var(--muted); }
.dlTop strong { font-size: 15px; }
.dl p { font-size: 11.5px; line-height: 1.6; color: var(--muted); margin: 3px 0 0; }

.trk { font-size: 12px; color: var(--muted); margin: 10px 0 0; }
.dr { font-size: 12.5px; color: var(--danger); margin: 8px 0 0; }

/* ---- 怎麼完成一筆交易 ---- */
.how {
  background: var(--surface); border-radius: var(--radius-lg);
  padding: 14px 16px; margin-bottom: 14px;
}
.howH { font-size: 13.5px; margin: 0 0 8px; }
.howL { margin: 0 0 10px; padding-left: 1.2em; }
.howL li { font-size: 12.5px; line-height: 1.75; color: var(--muted); margin-bottom: 4px; }
.howL b { color: var(--ink); font-weight: 600; }
.howR { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line-soft); padding-top: 10px; }
.howR li {
  /* minmax(0, 1fr) 不是 1fr：右欄是整句話，1fr 會被最小內容寬撐爆 */
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px;
  font-size: 12px; line-height: 1.7; color: var(--muted); margin-bottom: 5px;
}
.howTag {
  align-self: start;
  font-size: 11px; font-weight: 700; white-space: nowrap;
  padding: 2px 8px; border-radius: var(--pill);
  background: var(--surface-3); color: var(--ink);
}
.howTag.warn { background: var(--warn-wash); color: var(--warn-ink); }

/* ---- 訂單編號：雙方對話的共同代號 ---- */
.idBox {
  margin-top: 12px; padding: 4px 12px 8px;
  background: var(--surface-2); border-radius: var(--radius);
}
.idWhy { font-size: 11px; line-height: 1.6; color: var(--muted); margin: 0; }

/* ---- 賣家：寄件依據 ---- */
.send {
  margin-top: 12px; padding: 12px;
  background: var(--surface-2); border-radius: var(--radius);
  box-shadow: inset 2px 0 0 var(--accent);
}
.sendH {
  display: flex; align-items: center; gap: 7px;
  font-size: 13px; margin: 0 0 4px; color: var(--ink);
}
.sendIco { width: 16px; height: 16px; flex: none; color: var(--accent); }
.sendWhy { font-size: 11.5px; line-height: 1.7; color: var(--muted); margin: 10px 0 0; }

/* 缺的欄位。留白會讓賣家以為系統壞了，一定要有一行字站在那裡 */
.gap {
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px; align-items: center; padding: 7px 0; margin: 0;
}
.gapLb { font-size: 11.5px; color: var(--muted); min-width: 0; }
.gapTag {
  font-size: 11.5px; font-weight: 600; white-space: nowrap;
  padding: 3px 10px; border-radius: var(--pill);
  background: var(--warn-wash); color: var(--warn-ink);
}

.allBtn {
  display: block; width: 100%; min-height: 44px; margin-top: 10px;
  padding: 11px 14px;
  border: 1px dashed var(--line); border-radius: var(--radius);
  background: transparent; color: var(--ink);
  font: inherit; font-size: 12.5px; font-weight: 600;
  cursor: pointer;
  transition: border-color .16s, color .16s, background .16s;
}
.allBtn:active { transform: scale(.98); }
.allBtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (hover: hover) { .allBtn:hover { border-color: var(--accent); color: var(--accent); } }
.allBtn.done { background: var(--ok-wash); color: var(--ok-ink); border-style: solid; border-color: transparent; }
.copyErr { font-size: 11.5px; line-height: 1.6; color: var(--warn-ink); margin: 6px 0 0; }

/* 跟買家要資料。整塊是一條出路，不是一則錯誤訊息 */
.ask { margin-top: 10px; }
.askT { font-size: 13px; font-weight: 600; color: var(--warn-ink); margin: 0 0 5px; }
.askB { font-size: 12px; line-height: 1.8; color: var(--muted); margin: 0 0 10px; }
.askB.warnB { color: var(--warn-ink); }
.askBtn {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 44px; padding: 11px 18px; margin-bottom: 10px;
  border-radius: var(--pill); background: var(--accent-wash);
  color: var(--accent); font-size: 13px; font-weight: 600;
  text-decoration: none;
}
.askBtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* ---- 買家那側：我的卡到哪了、我的錢在誰手上 ----
   顏色刻意跟賣家那塊（.send，左緣是 accent）分開用 info，
   兩種角色的畫面在同一頁交錯出現，色帶是最快分得出「這張是我買的還是我賣的」的線索 */
.mine {
  margin-top: 12px; padding: 12px;
  background: var(--surface-2); border-radius: var(--radius);
  box-shadow: inset 2px 0 0 var(--info-ink);
}

/* 賣家那一列。auto + minmax(0,1fr)：標籤固定寬，名字那欄要縮得下去，
   1fr 會被最小內容寬（長店名）撐爆整張卡 */
.who2 {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 9px; align-items: center;
  /* 44px：這一列是連往賣家頁的觸控目標。SellerChip 自己只有 22px 高 */
  min-height: 44px;
  border-radius: var(--radius);
}
a.who2:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.whoGo { width: 15px; height: 15px; flex: none; color: var(--faint); }
.lb { font-size: 11.5px; color: var(--muted); }
/* 查不到賣家檔案時的退路版，長相跟 SellerChip 對齊，少的只是等級與統計 */
.fb { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.fbAv {
  display: grid; place-items: center;
  width: 22px; height: 22px; flex: none;
  border-radius: 50%; background: var(--surface-3);
  font-size: 11px; font-weight: 600; color: var(--muted);
}
.fbNm {
  min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.45; color: var(--ink);
  /* 折行而不是截斷。名字被切掉等於買家看不到自己在跟誰交易，
     而這一格存在的唯一理由就是回答「是誰」——寧可長高兩行 */
  overflow-wrap: anywhere;
}

.stats {
  list-style: none; margin: 10px 0 0; padding: 0;
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;
}
.stats li { min-width: 0; display: grid; gap: 1px; }
.stats b { font-size: 13px; font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
.stats span { font-size: 10.5px; line-height: 1.4; color: var(--muted); }

/* 三段進度。直排不橫排：橫排在 393px 上放不下「賣家寄出」＋「剩 62 小時」，
   而那兩個東西必須擺在一起才回答得了「我在等什麼、還要等多久」 */
.steps { list-style: none; margin: 12px 0 0; padding: 0; }
.steps li {
  position: relative;
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px; align-items: center;
  padding: 5px 0;
}
/* 連接線：讓三個點看起來是一條路，而不是三顆各自獨立的圓 */
.steps li:not(:last-child)::before {
  content: ''; position: absolute;
  left: 4.5px; top: 22px; bottom: -2px; width: 1px;
  background: var(--line);
}
.dot {
  width: 10px; height: 10px; flex: none; border-radius: 50%;
  background: var(--surface-3); box-shadow: inset 0 0 0 1px var(--line);
}
.steps .done .dot { background: var(--ok); box-shadow: none; }
.steps .now .dot { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-wash); }
.sTx { min-width: 0; font-size: 12.5px; line-height: 1.5; color: var(--faint); overflow-wrap: anywhere; }
.steps .done .sTx { color: var(--muted); }
.steps .now .sTx { color: var(--ink); font-weight: 600; }
.sRe {
  flex: none; white-space: nowrap;
  font-size: 12px; font-weight: 700;
  padding: 3px 9px; border-radius: var(--pill);
  background: var(--accent-wash); color: var(--accent);
}

.todo { font-size: 12.5px; line-height: 1.8; color: var(--ink); margin: 12px 0 0; }

.lead {
  font-size: 12.5px; line-height: 1.8; color: var(--muted); margin: 0; min-width: 0;
}
.lead b { color: var(--ink); font-weight: 600; }

/* 桌機上把這幾塊的量測寬度收住。訂單卡是滿版的，不收的話複製鈕會離它要複製的
   那個值一千多像素遠 —— 兩個東西看起來不像同一組；長行的說明文字也不好讀。 */
@media (min-width: 721px) {
  .idBox, .send, .mine { max-width: 620px; }
  /* .lead 與 .hint 不列進來：它們現在只出現在面板裡，而面板自己就 520px 寬 */
  .howL li, .howR li, .todo { max-width: 720px; }
}

.acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
/* 「我已寄出」「我已收到」是這一頁唯二會移動錢的按鈕，不該比別的地方小。
   全域的 44px 只在 pointer: coarse 生效，這裡不分裝置一律撐開 */
.acts .btn.sm { min-height: 44px; padding: 8px 16px; font-size: 13px; }
.btn.ghost { opacity: .72; font-size: 12px; }

/* ---- 三張面板 ----
   跟 MyCardsPage 的出貨／回收覆蓋層、PublicCardbookPage 的出價覆蓋層、
   LoginMethods 的登入方式覆蓋層同一套視覺與行為。四處要一起改。
   （目前抽成共用元件只是多一層間接 —— 差異在內容，不在容器。） */
.sheetWrap {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: flex-end; justify-content: center;
  background: var(--scrim);
  /* 下緣讓給軟鍵盤（--kb 由 useKeyboardInset() 寫進根節點，預設 0）。
     不用 inset: 0 是因為 bottom 要能被覆蓋。 */
  bottom: var(--kb, 0px);
}
.sheet {
  width: 100%; max-width: min(520px, 100vw);
  /* 保險絲：內容壓不住時讓它自己橫捲，不要把面板撐出視窗外被裁掉 */
  overflow-x: hidden;
  /* 88% 而不是 88dvh：.sheetWrap 的高度已經扣掉鍵盤了，
     dvh 量的是整個視窗，鍵盤彈出時算出來的面板會比放得下的還高 */
  max-height: min(88%, 720px); overflow-y: auto; overscroll-behavior: contain;
  border-radius: 18px 18px 0 0;
  padding: 18px 16px calc(18px + var(--safe-b, 0px));
  display: grid; gap: 10px; align-content: start; min-width: 0;
}
/* 焦點是程式送進來的（tabindex="-1"），不該畫出一圈使用者沒有自己走到的外框 */
.sheet:focus-visible { outline: none; }
.sheetH { font-size: 17px; margin: 0; }

/* 底部內距搬進 .sheetFoot，sticky 的 bottom: 0 才貼得到面板真正的下緣，
   不然會浮在 18px 內距上面、露出一條會捲動的縫 */
.sheet.hasFoot { padding-bottom: 0; }
.sheetFoot {
  position: sticky; bottom: 0; z-index: 1;
  /* 負的左右外距讓它撐滿面板寬度，那條分隔線才切得斷、
     看得出「上面會捲、下面不會」 */
  margin: 2px -16px 0;
  padding: 10px 16px calc(12px + var(--safe-b, 0px));
  border-top: 1px solid var(--line);
  background: var(--surface);
  display: grid; gap: 8px; min-width: 0;
}
/* 面板裡沿用訂單卡那組 .acts，兩處的按鈕尺寸（44px）自動一致，
   這裡只覆蓋外距與方向。主要動作排在前面，跟其他三張面板一致 ——
   手機上這一組是直排的，順序就是視覺順序。 */
.sheetFoot .acts { margin-top: 0; flex-wrap: nowrap; }
.sheetFoot .acts .btn { flex: 1; min-width: 0; }
@media (max-width: 720px) {
  .sheetFoot .acts { flex-direction: column; }
}
.errLine { margin: 0; min-width: 0; font-size: 12.5px; line-height: 1.55; color: var(--danger-ink); overflow-wrap: anywhere; }

.sheet label { display: block; font-size: 12.5px; color: var(--muted); margin: 0; min-width: 0; }
.sheet select { width: 100%; min-width: 0; margin-top: 5px; }
/* 選擇器不能只挑 type="text"：API 模式的開箱影片欄是 type="url"，
   原本整個吃不到這段樣式 —— 那一欄在正式環境是沒有邊框、沒有 44px 高的裸欄位，
   而它正好是唯一擋住「送出申訴」的那一欄。checkbox 排除掉，它不該被撐成 44px 寬。 */
.sheet input:not([type="checkbox"]) {
  display: block; width: 100%; margin-top: 5px; min-width: 0;
  background: var(--field); border: 1px solid var(--line);
  border-radius: var(--radius); color: var(--ink);
  /* 16px 不是排版偏好，是 iOS 的門檻：欄位字級小於 16 就會在聚焦時
     自動放大整頁，而且不會自己縮回去（touch.css 第 4 節）。這一條原本是
     14px，被 scoped 的特異度贏過 touch.css 那條補強 —— 同一頁的 select
     早就寫了 16px，兩個欄位不該一個放大一個不放大。 */
  padding: 10px 12px; font-size: 16px; min-height: 44px;
}
.chk { display: flex; gap: 8px; align-items: flex-start; line-height: 1.6; }
.chk input { margin-top: 3px; width: 18px; height: 18px; flex: none; }
.hint { font-size: 11.5px; line-height: 1.65; color: var(--muted); margin: 0; }
/* 灰按鈕的理由。--warn-ink 而不是 --danger：使用者沒做錯事，只是還沒填完，
   紅字會讀成「出錯了」（同卡冊出貨面板、出價面板、上架列） */
.blockWhy {
  margin: 0; min-width: 0;
  font-size: 12.5px; line-height: 1.55; color: var(--warn-ink);
  overflow-wrap: anywhere;
}

.err { color: var(--danger); font-size: 13.5px; margin: 0 0 12px; }

/* 載入失敗：跟大廳、錢包頁同一套（訊息置中＋一顆重試鈕），不另外發明一種 */
.loadFail {
  min-width: 0;
  display: grid; justify-items: center; gap: 12px;
  padding: 36px 16px; text-align: center;
}
.loadFail p { margin: 0; }

/* 放款成功的訊息。用綠底而不是一行綠字：這是使用者剛剛花掉一筆不可還原的
   錢換來的唯一回執，它得跟旁邊的說明文字分得開。不自動消失 —— 訂單卡在
   同一刻換到「已結案」去了，這句話是他唯一的線索。 */
.okMsg {
  margin: 0 0 12px; padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--ok-wash); color: var(--ok-ink);
  font-size: 13px; line-height: 1.75;
}
.dev { margin-top: 26px; padding: 14px 16px; background: var(--surface-2); border-radius: var(--radius-lg); }
.dev h2 { font-size: 14px; margin: 0 0 6px; }
.dev p { font-size: 12.5px; line-height: 1.7; margin: 0 0 10px; }
.devRow { display: flex; flex-wrap: wrap; gap: 8px; }
.devRow .btn.sm { min-height: 44px; padding: 7px 14px; font-size: 12.5px; }
</style>
