<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, type PrizeSummary } from '@/lib/api'
import type { Tier, UserPrize } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import Tilt3D from '@/components/Tilt3D.vue'
import TierBadge from '@/components/TierBadge.vue'
import CertTag from '@/components/CertTag.vue'
import ValueCurve from '@/components/ValueCurve.vue'
import ListSentinel from '@/components/ListSentinel.vue'
import BottomActionBar from '@/components/BottomActionBar.vue'
import { useInfiniteList } from '@/composables/useInfiniteList'
import { useWalletStore } from '@/stores/wallet'
import { recycleQuote } from '@/lib/recycle'
import { track } from '@/lib/ga'
import { share, shareUrl } from '@/lib/social'
import { ApiError, http } from '@/lib/http'
import { MOCK } from '@/lib/config'
import { useAuthStore } from '@/stores/auth'
import { refPriceText, refPriceNum } from '@/lib/refprice'
import { mergeByCard, certTailOf, type MergeGroup } from '@/lib/card-merge'

const wallet = useWalletStore()
const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

/* ---- 剛拿到的卡 ----
   抽完與市場成交都會導到這一頁，網址帶著剛入手的卡片 id。
   卡本來就已經在卡冊裡（後端在同一個交易裡就寫進 prizes），問題是「看不出來」——
   一整面長得差不多的卡裡多了一張，沒有任何東西告訴你是哪一張，
   使用者的結論就是「我抽到的那片沒進卡冊」。標出來才算真的送達。

   排序那一半在後端：卡冊照 acquired_at 排（見 server migrations/014），
   剛拿到的一定在最前面，不必捲。 */
const justGot = computed(() => new Set(
  String(route.query.new ?? '').split(',').map(v => v.trim()).filter(Boolean)))

/* ---- 卡片清單 ----
   卡冊是整個站成長最快的列表：每抽一次就多一張，只會變長不會變短。
   所以列表分批載入，捲到接近底部才抓下一批（見 composables/useInfiniteList.ts）。

   跟著要搬的是**狀態過濾**：它以前是前端 filter，分批之後只濾得到已載入的那批，
   使用者會看到「寄存中 0 張」而真正的寄存中卡片躺在第 3 批。現在 tab 直接
   當成 API 參數送出去，由 SQL 過濾。 */
const list = useInfiniteList<UserPrize>((cursor, signal) =>
  api.myPrizes({ cursor, signal, status: tab.value === 'all' ? undefined : tab.value }))
const sentinelRef = list.sentinel
const prizes = list.items

/* ---- 收藏總覽 ----
   卡冊原本是一長串扁平清單，看不出「我收了多少、值多少」。
   對抽卡的人來說那是這一頁最想知道的事，所以拉到最上面。
   已回收的不計入市值 —— 卡已經交還平台了，還算進總值是騙自己。

   排版上只認一件事：這一區有一個主角（收藏總值），其餘都是配角。
   前一版把「持有 / 市值 / 最高價」三個並排成同樣份量的欄，於是三個都不是重點，
   而且「持有 3 張」在 375px 底下被折成「持有 / 3 / 張」三行 ——
   數字與單位被拆開就不再是一個量詞了。現在數字與單位鎖在同一個 inline 行內，
   配角則降級成一行小字，靠層級而不是靠並排來分主次。

   這幾個數字講的是**整本卡冊**，所以由後端一次算好（/v1/prizes/summary），
   不從已載入的那幾張推 —— 那樣算出來的「總值」會隨著捲動一路長大，
   那不是統計，是進度條。 */
const summary = ref<PrizeSummary | null>(null)
async function refreshSummary() {
  try { summary.value = await api.prizeSummary() } catch { /* 總覽拿不到不該擋住卡片清單 */ }
}

const total = computed(() => summary.value?.total ?? 0)
const ownedCount = computed(() => summary.value?.owned ?? 0)
const totalValue = computed(() => summary.value?.totalValue ?? 0)
const bestCard = computed(() => summary.value?.best ?? null)
/* 曲線需要每一張卡的「時間 + 金額」才畫得出來，聚合不掉。
   後端那支只投影三個純量欄位（不含 card 這個 jsonb），整頁只取一次。 */
const curvePrizes = computed(() =>
  (summary.value?.curve ?? []).map(c => ({
    wonAt: new Date(c.wonAt).toISOString(),
    card: { refPrice: c.refPrice, name: c.name }
  })))

/* 賞別分佈。這是既有資料算得出來、又是別處看不到的一項 ——
   狀態的分佈底下的分頁已經標了數字，再放一次只是重複。
   賞別則只散落在每張卡的膠囊上，要自己數才知道「我這冊是靠一張 A 賞撐起來的
   還是整體都不錯」。用一條堆疊條 + 一行圖例，佔不到 40px。 */
const TIER_ORDER: Tier[] = ['A', 'B', 'C', 'D', 'LAST', 'BUST']
const TIER_LABEL: Record<Tier, string> = {
  A: 'A 賞', B: 'B 賞', C: 'C 賞', D: 'D 賞', LAST: '最後賞', BUST: '爆賞'
}
const tierMix = computed(() => {
  const mix = new Map((summary.value?.tierMix ?? []).map(m => [m.tier, m.n]))
  // 後端不保證回傳順序，展示順序由前端這份 TIER_ORDER 決定
  return TIER_ORDER.map(t => ({ tier: t, n: mix.get(t) ?? 0 })).filter(r => r.n > 0)
})
/* 顏色只是「一眼看比例」的輔助，識別靠的是圖例上的文字。
   賞別色是既有品牌權杖（TierBadge 一路用到底），D 賞刻意是灰的，
   在色覺檢測下 C 賞與 D 賞的分離度偏低 —— 所以每一段都必須有文字圖例，
   不能只靠顏色講話。也因此那條堆疊條對讀屏是 aria-hidden：
   它講的事情圖例已經用文字講完，讀兩次只是噪音。 */

/* ---- 狀態分頁 ----
   寄存中要出貨、待出貨要等、已出貨是歷史 —— 三種狀態的下一步動作完全不同，
   混在同一張清單裡每張卡都要重新判斷「這張現在能做什麼」。 */
type Tab = 'all' | UserPrize['status']
const tab = ref<Tab>('all')
const TABS: { k: Tab; label: string }[] = [
  { k: 'all', label: '全部' },
  { k: 'stashed', label: '寄存中' },
  { k: 'listed', label: '市場販售中' },
  { k: 'ship_requested', label: '待出貨' },
  { k: 'shipped', label: '已出貨' },
  { k: 'recycled', label: '已回收' },
  { k: 'refunded', label: '已退還' }
]
/* 張數也來自總覽。從已載入的陣列數的話，「已回收 3」在你捲到第 3 批之前
   會顯示成 0，而使用者會據此以為自己的卡不見了。 */
const countOf = (k: Tab) => k === 'all' ? total.value : (summary.value?.counts[k] ?? 0)
const tabs = computed(() => TABS.filter(t => countOf(t.k) > 0))
/* 過濾已經在後端做完了（tab 是 API 參數），這裡拿到的就是這個分頁的卡。
   再濾一次是有害的：剛回收的那張在本地被改成 recycled，如果這裡還濾
   status === tab，它會在「寄存中」分頁裡當場消失，使用者看不到入帳提示。 */
const shown = prizes

const listRef = ref<HTMLElement | null>(null)
/* 換分頁＝換一組查詢：游標歸零、清空既有卡片、重抓第一批。
   過期回應由 composable 的世代編號擋掉（快速連按不會錯位）。
   同時把清單頂端捲回視野：內容整批換掉了，停在原本的捲動位置會落在
   一個比舊清單短得多的新清單的中間，看起來像「載不出來」。 */
watch(tab, () => {
  openCard.value = null
  confirming.value = null
  list.reset()
  const top = listRef.value?.getBoundingClientRect().top ?? 0
  if (top < 0) listRef.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
})

/* 卡圖上的膠囊放不下「市場販售中」五個字（兩欄格線下整張卡才 145px 寬），
   而那裡本來就只需要回答「這張現在動不動得了」。
   完整名稱留在上面的分頁 TABS，兩邊講的是同一件事 */
const statusShort: Record<UserPrize['status'], string> = {
  stashed: '寄存中',
  listed: '販售中',
  ship_requested: '待出貨',
  shipped: '已出貨',
  recycled: '已回收',
  /* 賣家逾期未出貨、票金已退回。跟「已回收」不同：回收是自己接受報價，
     退還是賣家沒有履約，責任歸屬不一樣，用同一個字會抹掉這個差別 */
  refunded: '已退還'
}

/* ---- 一張卡佔多高 ----
   前一版每張卡是「卡圖 + 賞別 + 狀態 + 卡名 + 鑑定 + 寄存期限 + 三顆通欄按鈕」
   直式疊下來，375px 上單張 490px —— 比半個螢幕還高，六張要捲四個螢幕。
   而且格線的列高由最高的那張決定，只有一張是寄存中時，其餘每張都陪著空 250px。

   壓縮的原則是分兩類：
   「隨時要看到的」＝ 賞別、狀態、卡名、市值 → 疊回卡圖上（卡圖本來就在，不額外佔高度）
   「決定要不要動它時才需要的」＝ 鑑定編號、寄存期限、三個動作 → 收進展開區
   一次只展開一張，收合時把該卡的定價表單與回收確認一起關掉，
   否則下次展開會停在上次的半途，看起來像自己跳出來的。 */
const openCard = ref<string | null>(null)
/* 帶時區的 ISO 字串，直接切前 10 碼會在 UTC+8 的深夜差一天。
   解析不了就原樣回傳 —— 卡冊上少一個好看的日期，比顯示 Invalid Date 好。
   讀的是 acquiredAt 不是 wonAt：買來的卡「取得」的是成交那天，
   不是賣家當初抽到它的那天。 */
function wonDay(iso: string) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function toggleCard(id: string) {
  const next = openCard.value === id ? null : id
  openCard.value = next
  if (next !== id) confirming.value = null
}

/* ---- 申請出貨 ----
   這段原本是假的：只把本地物件的 status 改掉，從來沒有打後端。
   在 API 模式下按了畫面會變、重新整理就打回原形，而後台的出貨清單
   永遠收不到東西 —— 使用者以為自己申請了，平台這邊什麼也沒有。

   做成多選是因為這一頁本來就寫著「寄存中的卡可合併出貨（省運費）」。
   一張一張送會產生多張出貨單，那句話就變成謊話。 */
const shipOpen = ref(false)
const shipPick = ref<string[]>([])
const shipBusy = ref(false)
const shipErr = ref('')
/* 出貨與上架共用同一個提示槽。兩個各自 position: fixed 在同一個位置，
   接連做兩件事就會疊在一起看不清楚 —— 同一時間只該有一則。 */
const toast = ref('')
function flash(msg: string) {
  toast.value = msg
  setTimeout(() => { if (toast.value === msg) toast.value = '' }, 5000)
}

/* 出貨面板裡那份「可以一起寄的卡」也是一份會長大的清單，同樣要分批。
   它跟主清單各有一個 useInfiniteList 實例 —— 共用一個的話，開出貨面板
   會把卡冊的清單洗掉。
   注意這裡的哨兵在面板自己的捲動容器裡：IntersectionObserver 的 root 是視窗，
   哨兵被 .sheet 的 overflow 裁掉時就不算相交，所以判斷仍然正確，
   只是 400px 的提前量沒有作用（要真的捲到面板底部才觸發）。這份清單短，可以接受。 */
const shipList = useInfiniteList<UserPrize>((cursor, signal) =>
  api.myPrizes({ cursor, signal, status: 'stashed' }))
const shipSentinelRef = shipList.sentinel
const stashed = shipList.items
const stashedCount = computed(() => summary.value?.counts.stashed ?? 0)

const addr = ref({ name: '', phone: '', zip: '', city: '', line1: '' })
const addrReady = computed(() =>
  addr.value.name.trim().length >= 2 &&
  addr.value.phone.trim().length >= 8 &&
  addr.value.city.trim().length >= 2 &&
  addr.value.line1.trim().length >= 4)

/* 收件資料從會員資料帶過來，讓人不用每次重打。
   但仍然可以改 —— 「這次要寄到哪」跟「我的預設地址」是兩件事
   （後端 prizes.ts 的註解也是這樣說的）。 */
async function openShip(p: UserPrize) {
  track('click_ship_request')
  shipErr.value = ''
  shipPick.value = [p.id]
  shipOpen.value = true
  // 每次打開都重抓：上一次打開之後可能已經送出過幾張，那些不該再出現在清單裡
  shipList.reset()
  if (MOCK) return
  try {
    const r = await http<{ profile: {
      realName?: string | null; phone?: string | null
      addressZip?: string | null; addressCity?: string | null; addressLine1?: string | null
    } }>('/v1/auth/profile')
    const q = r.profile
    addr.value = {
      name: q.realName ?? '', phone: q.phone ?? '',
      zip: q.addressZip ?? '', city: q.addressCity ?? '', line1: q.addressLine1 ?? ''
    }
  } catch { /* 帶不出來就讓使用者自己填，不要因此擋住出貨 */ }
}

function toggleShipPick(id: string) {
  const i = shipPick.value.indexOf(id)
  if (i === -1) shipPick.value.push(id)
  else shipPick.value.splice(i, 1)
}

async function submitShip() {
  if (!addrReady.value || !shipPick.value.length || shipBusy.value) return
  shipBusy.value = true
  shipErr.value = ''
  try {
    const ids = [...shipPick.value]
    await api.shipPrizes(ids, {
      name: addr.value.name.trim(), phone: addr.value.phone.trim(),
      zip: addr.value.zip.trim() || undefined,
      city: addr.value.city.trim(), line1: addr.value.line1.trim()
    })
    // 以伺服器為準重讀，不要自己猜狀態 —— 這正是先前那個 bug 的成因
    list.reset()
    await refreshSummary()
    flash(`已送出 ${ids.length} 張的出貨申請，平台處理後會通知你。`)
    shipOpen.value = false
    shipPick.value = []
    track('ship_request_success')
  } catch (e) {
    shipErr.value = e instanceof ApiError ? e.message : '申請失敗，請稍後再試'
  } finally {
    shipBusy.value = false
  }
}

/* ---- 上架出售 ----
   api.createListing() 一直都在，但整個前端沒有任何地方呼叫它 ——
   使用者拿到卡之後只有「出貨」跟「回收」兩條路，賣不掉。

   一開始做成卡片裡的行內表單，那是錯的：表單的輸入框有自己的固有寬度，
   而 grid 的 1fr 等同 minmax(auto, 1fr) —— 那一格會被撐開，隔壁格被擠扁。
   實測 393px 上兩欄從各 172px 變成 290px + 62.5px，整個卡冊看起來就壞了。

   改成「選取 → 上架頁」：卡片上只負責勾選，定價在自己的頁面做。
   順便支援多選 —— 一次整理好幾張卡本來就是常見的事。

   入口原本是單張卡「操作」裡的一顆按鈕，那是放錯層級：賣卡的順序是
   先決定「我要賣東西」，再挑「賣哪幾張」。從某一張卡的動作進去，等於
   要求使用者先選中第一張才會發現原來可以多選 —— 多選變成藏起來的功能。
   現在提到卡冊層級：按一次進入選取模式，整本卡冊的卡片變成可勾選，
   底下那條列隨時回答「選了幾張」，最後一鍵送進定價頁。 */
const selecting = ref(false)
/* 記住整張卡而不是只記 id。清單是分批載入的，換分頁時會被清空 ——
   只留 id 的話「已選 3 張／市值合計」會在切換之後查不到卡而歸零，
   但那三張其實還在選取中。 */
const sellPicked = ref<UserPrize[]>([])
const sellPick = computed(() => sellPicked.value.map(p => p.id))

/* 只有還在保管庫的卡能上架。定價頁自己也會再濾一次，
   但擋在選取這一步，才不會讓人挑了半天才發現有幾張不算數。 */
const canSell = (p: UserPrize) => p.status === 'stashed'

/* 進選取模式時把展開中的卡片與回收確認一起關掉 ——
   選取模式下整張卡是勾選熱區，底下同時還開著一組動作鈕會有兩套點法在打架。 */
function startSell() {
  selecting.value = true
  sellPicked.value = []
  openCard.value = null
  confirming.value = null
  /* 選取列跟出貨的提示訊息都貼在畫面底部同一個位置。
     剛送完出貨就進選取模式的話兩則會疊在一起，誰也讀不清楚 */
  toast.value = ''
}

function endSell() {
  selecting.value = false
  sellPicked.value = []
}

function toggleSell(p: UserPrize) {
  if (!canSell(p)) return
  const i = sellPicked.value.findIndex(x => x.id === p.id)
  if (i === -1) sellPicked.value.push(p)
  else sellPicked.value.splice(i, 1)
}

const sellPickValue = computed(() =>
  sellPicked.value.reduce((a, p) => a + refPriceNum(p.card.refPrice), 0))

function goSell() {
  if (!sellPick.value.length) return
  router.push({ name: 'sell-cards', query: { ids: sellPick.value.join(',') } })
}

/* ---- 已選清單 ----
   底下那條列只回答「幾張、值多少」，回答不了「是哪幾張」——
   而使用者唯一能查的方法是回頭在整片卡牆裡找哪幾張有外框。
   挑到十幾張時那件事根本做不到（卡牆本身還是分批載入的，
   先選後捲的那幾張可能已經捲出畫面很遠）。所以列點得開，
   面板裡就是已選的卡本身。

   為什麼不常駐：選卡的當下要看的是**還沒選的卡**。常駐的縮圖格會
   一直橫在卡牆與下緣之間，把卡牆能看的面積再切掉一塊。 */
const chosenOpen = ref(false)
function closeChosen() { chosenOpen.value = false }

/* 合併規則跟建池的挑卡器共用同一份（src/lib/card-merge.ts）。
   這裡選的是使用者自己的**實體卡**，所以合併更要小心：
   有鑑定編號的卡永遠各自一格 —— PSA #82345671 與 #82345672 是兩張
   可以各自查證的卡，併成 ×2 之後「取消的是哪一張」就講不清楚了。 */
type PickGroup = MergeGroup<UserPrize>
const sellGroups = computed<PickGroup[]>(() => mergeByCard(sellPicked.value, p => p.card))

/** 這一格代表幾張卡就顯示 ×N；沒有鑑定編號的同款卡才會併到一起 */
const certTail = (p: UserPrize) => certTailOf(p.card)

/* 移除這一組裡**最後選進來的那一張**。手誤多點一下時，要撤銷的就是剛剛那一下。
   移除走的是 toggleSell（跟卡牆上點卡片同一條路），所以卡牆上那張的
   選取外框會跟著消失 —— 選取狀態只有 sellPicked 一份來源。 */
function removeOne(g: PickGroup) {
  toggleSell(g.members[g.members.length - 1])
}

/* 移到剩零張時面板自己收掉：空的「已選的卡」沒有東西可看，
   而它也不該在離開選取模式之後還留在畫面上 */
watch(() => sellPicked.value.length, n => { if (!n) chosenOpen.value = false })

/* Esc 關面板。面板是 Teleport 到 body 的，焦點不一定落在裡面，
   所以監聽掛在 window 上而不是面板節點上 */
function onChosenKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && chosenOpen.value) closeChosen()
}
onMounted(() => window.addEventListener('keydown', onChosenKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onChosenKey))

const confirming = ref<string | null>(null)
const justRecycled = ref<{ id: string; points: number } | null>(null)

function askRecycle(p: UserPrize) {
  track('click_recycle')
  confirming.value = confirming.value === p.id ? null : p.id
}

/* 報價由那個池的賣家設定，比率隨卡片一起從 API 帶回來 ——
   前端不做任何算術：買回價是賣家在建池時宣告、寫進公平性承諾鎖死的金額，
   跟 card.refPrice 沒有算式關係（見 src/lib/recycle.ts 的說明）。 */
const quoteOf = (p: UserPrize) => recycleQuote(p.buyback)

async function doRecycle(p: UserPrize) {
  const q = quoteOf(p)
  if (!q.eligible) return
  try {
    /* mock 直接入點；API 模式由後端從賣家的保留額付款並回最新錢包。
       這裡有可能失敗而且是正常的：報價不是保證成交 —— 賣家的保留額
       不足、或這張卡剛好同時被申請出貨，後端都會擋下來。
       所以失敗要照實顯示，不要事先把畫面改成已回收。 */
    const r = await api.recyclePrize(p.id, q.points, `回收 ${p.card.name}`)
    p.status = 'recycled'
    confirming.value = null
    justRecycled.value = { id: p.id, points: r.points }
    setTimeout(() => { justRecycled.value = null }, 4000)
    /* 總覽的張數與總值由後端算，回收之後要重新問一次；卡片清單則不重抓 ——
       重抓會讓剛回收的那張當場消失，連「已入帳 +N 點」都來不及看到。
       那一張已經在本地標成 recycled，畫面是對的。 */
    void refreshSummary()
    track('recycle_success')
  } catch (e) {
    alert(e instanceof Error ? e.message : '賣家沒有接受這筆回收，請稍後再試')
  }
}

/* ---- 公開卡冊 / 分享連結 ----
   公開卡冊等於把持有內容攤開給任何拿到連結的人看（連鑑定編號都看得到），
   而連結一旦貼進群組就收不回來。所以這一區的原則是：後果寫在動作旁邊，
   不要藏進說明頁 —— 使用者按下開關前就該知道會被看到什麼。

   收回的手段只有兩個，兩個都會讓舊網址立刻失效：關掉公開、或換一組新連結。
   換連結是「分享錯對象」時唯一還能繼續分享給對的人的補救方式，
   所以做成需要確認的動作，而不是一顆按了就換的按鈕。 */
const shareOn = ref(false)
const shareSlug = ref<string | null>(null)
const shareBusy = ref(false)
const shareErr = ref('')
const copied = ref(false)
const askRotate = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined

const shareLink = computed(() => (shareSlug.value ? shareUrl(shareSlug.value) : ''))

/* 第一批卡片與總覽同時發，兩邊互不等待 —— 總覽慢的話卡片還是先出得來 */
onMounted(() => {
  list.reset()
  void refreshSummary()
  /* 卡是後端在抽選／成交的同一個交易裡就寫進去的，這裡不做任何「收進去」的動作，
     只是把已經發生的事說出來 —— 沒有這句話，使用者得自己數卡片才知道有沒有進來。 */
  const n = justGot.value.size
  if (n > 0) flash(n > 1 ? `${n} 張新卡已經在你的卡冊裡` : '這張卡已經在你的卡冊裡')
})

onMounted(async () => {
  try {
    const s = await share.get()
    shareOn.value = s.public
    shareSlug.value = s.slug
  } catch {
    /* 讀不到分享設定就當作沒公開。這一區壞掉不該蓋掉卡冊本身，
       所以不在這裡顯示錯誤 —— 真的要改設定時 set() 會再報一次 */
  }
})

async function toggleShare() {
  if (shareBusy.value) return
  const next = !shareOn.value
  shareBusy.value = true
  shareErr.value = ''
  askRotate.value = false
  try {
    const s = await share.set(next)
    shareOn.value = s.public
    shareSlug.value = s.slug
    copied.value = false
  } catch (e) {
    shareErr.value = e instanceof ApiError ? e.message : '設定失敗，請稍後再試。'
  } finally {
    shareBusy.value = false
  }
}

async function rotateLink() {
  shareBusy.value = true
  shareErr.value = ''
  try {
    // rotate=true：後端換一組新代號，舊網址當場失效
    const s = await share.set(true, true)
    shareOn.value = s.public
    shareSlug.value = s.slug
    askRotate.value = false
    copied.value = false
  } catch (e) {
    shareErr.value = e instanceof ApiError ? e.message : '換連結失敗，請稍後再試。'
  } finally {
    shareBusy.value = false
  }
}

async function copyLink() {
  if (!shareLink.value) return
  try {
    await navigator.clipboard.writeText(shareLink.value)
    copied.value = true
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copied.value = false }, 2400)
  } catch {
    /* 非 HTTPS 或使用者拒絕權限時 clipboard 會直接 reject。
       與其安靜地失敗，不如叫人自己長按複製 —— 網址本來就完整顯示在上面 */
    shareErr.value = '這個瀏覽器不允許自動複製，請長按上面的網址手動複製。'
  }
}
</script>

<template>
  <div class="container page">
    <h1>我的卡冊</h1>

    <!-- 收藏總覽：這一頁最想被回答的問題就是「我收了多少、值多少」。
         一個主角（總值）+ 三個配角（張數、賞別分佈、最高價）+ 一張成長曲線 -->
    <section v-if="ownedCount || total" class="overview card">
      <template v-if="ownedCount">
      <p class="ovLabel">收藏總值</p>
      <div class="ovHero">
        <!-- 數字與單位鎖在同一個 inline 盒子裡，永遠不會被折成兩行 -->
        <p class="ovVal">
          <strong class="ovNum">{{ totalValue.toLocaleString() }}</strong><span class="ovUnit">點</span>
        </p>
        <p class="ovHold">持有 <b class="mono">{{ ownedCount }}</b> 張</p>
      </div>

      <!-- 賞別分佈。段與段之間留 2px 底色縫，不畫外框 —— 邊框是多餘的墨水。
           只有一種賞別時整條都是同一色，那條長方形不含任何資訊，
           下面那行圖例已經把話講完了，所以直接不畫 -->
      <div v-if="tierMix.length > 1" class="mixBar" aria-hidden="true">
        <span
          v-for="m in tierMix" :key="m.tier"
          class="seg" :class="`t-${m.tier.toLowerCase()}`"
          :style="{ flexGrow: m.n }"
        ></span>
      </div>
      <ul class="mixKey">
        <li v-for="m in tierMix" :key="m.tier">
          <span class="kd" :class="`t-${m.tier.toLowerCase()}`" aria-hidden="true"></span>
          {{ TIER_LABEL[m.tier] }}<b class="mono">{{ m.n }}</b><span class="sr-only">張</span>
        </li>
      </ul>

      <!-- 只有一張卡時「最高價」就是總值本身，再列一次是廢話 -->
      <p class="ovBest" v-if="bestCard && ownedCount > 1">
        <span class="bLabel">最高價</span>
        <span class="kd" :class="`t-${bestCard.tier.toLowerCase()}`" aria-hidden="true"></span>
        <span class="bName">{{ bestCard.name }}</span>
        <span class="bVal mono">{{ bestCard.refPrice.toLocaleString() }}</span>
      </p>

      <!-- 成長曲線。放在總覽裡而不是另開一張卡：它回答的是同一個問題的時間版本 -->
      <ValueCurve class="ovCurve" :prizes="curvePrizes" />
      </template>

      <!-- 公開卡冊併進總覽：分享出去的就是這一區講的東西（總值、張數、賞別分佈），
           兩者是同一件事的兩面，各佔一張卡會讓人以為是兩個不相干的功能。
           網址不顯示了 —— 一長串亂碼佔兩行卻沒人會去讀它，要用的時候按複製就好。
           換新連結是不可逆的，所以確認仍然留在這裡，不收進按鈕的 tooltip。 -->
      <div v-if="total" class="shareRow">
        <template v-if="shareOn && shareLink">
          <button type="button" class="btn sm" @click="copyLink">
            {{ copied ? '已複製' : '複製卡冊連結' }}
          </button>
          <button type="button" class="btn sm ghost" :disabled="shareBusy" @click="askRotate = !askRotate">
            換新連結
          </button>
        </template>
        <span v-else class="shareOffLabel">公開卡冊</span>

        <button
          type="button" role="switch" :aria-checked="shareOn"
          class="sw" :class="{ on: shareOn }"
          :disabled="shareBusy"
          @click="toggleShare"
        >
          <span class="track" aria-hidden="true"><span class="knob"></span></span>
          <span class="sr-only">公開卡冊</span>
        </button>
      </div>

      <!-- 換連結是不可逆的，跟回收一樣用行內確認：後果要跟按鈕在同一個畫面 -->
      <div v-if="askRotate && shareOn" class="confirm">
        <p class="warn">
          換新之後<strong>舊連結立刻失效</strong> —— 已經貼在群組、私訊裡的網址
          任何人再點都只會看到「找不到卡冊」。分享錯對象時這是唯一的補救。
        </p>
        <div class="acts">
          <button type="button" class="btn primary sm" :disabled="shareBusy" @click="rotateLink">
            確認換新
          </button>
          <button type="button" class="btn sm" :disabled="shareBusy" @click="askRotate = false">取消</button>
        </div>
      </div>

      <p v-if="shareErr" class="shareErr" role="alert">{{ shareErr }}</p>
    </section>

    <p class="muted note">寄存中的卡可合併出貨（省運費），寄存期限 90 天。</p>

    <div v-if="list.ready.value && !total" class="empty card">
      <p>卡冊還是空的。</p>
      <RouterLink :to="{ name: 'home' }" class="btn primary">去抽第一張</RouterLink>
    </div>

    <!-- 上架入口與狀態分頁同一列：兩者都是「要看／要動哪一批卡」的控制項，
         各佔一行會在手機上先吃掉兩列才看得到第一張卡。
         上架在前、分頁在後 —— 分頁那條的右緣有漸隱遮罩表示還能往右捲，
         按鈕擺在它後面會看起來像按鈕自己在淡出。
         沒有寄存中的卡就不出現上架鍵：按了也沒有東西可選。 -->
    <div v-if="stashedCount || tabs.length > 1" class="listHead">
      <button
        v-if="stashedCount && !selecting"
        type="button" class="btn primary sellCta" @click="startSell"
      >上架出售</button>

      <!-- 狀態分頁：三種狀態的下一步動作完全不同，分開才不用每張卡重新判斷 -->
      <div v-if="tabs.length > 1" class="tabs" role="tablist">
        <button
          v-for="t in tabs" :key="t.k"
          type="button" role="tab" :aria-selected="tab === t.k"
          class="tab" :class="{ on: tab === t.k }"
          @click="tab = t.k"
        >{{ t.label }}<span class="tabN mono">{{ countOf(t.k) }}</span></button>
      </div>
    </div>

    <!-- 選取模式的說明另起一行：塞進上面那列會把分頁擠到看不見 -->
    <p v-if="selecting" class="sellHint">
      點卡片挑要賣的，可以複選。只有<strong>寄存中</strong>的卡能上架。
    </p>

    <div ref="listRef" class="grid">
      <div
        v-for="p in shown" :key="p.id" class="item card"
        :class="{
          dim: p.status === 'recycled',
          sel: sellPick.includes(p.id),
          off: selecting && !canSell(p),
          fresh: justGot.has(p.id)
        }"
      >
        <!-- 賞別、狀態、卡名、市值全部疊回卡圖上：卡圖本來就佔著這塊面積，
             把字放上去等於不花額外高度。可讀性靠底部的漸層遮罩撐 -->
        <Tilt3D :max="10" radius="12px">
          <CardArt :image="p.card.image" :alt="p.card.name" :tier="p.tier" :cert-no="p.card.certNo" :art-id="p.card.artId" />
          <div class="scrim">
            <div class="sTags">
              <TierBadge :tier="p.tier" />
              <span class="sChip">{{ statusShort[p.status] }}</span>
            </div>
            <div class="sMain">
              <strong class="sName">{{ p.card.name }}</strong>
              <span class="sVal mono">{{ refPriceText(p.card.refPrice) }}</span>
            </div>
          </div>

          <!-- 選取模式的熱區疊在卡面上。.scrim 是 pointer-events: none，
               點擊會落到這顆按鈕，所以不必為了「可選取」再複製一份卡面出來。
               它是 absolute 不是 fixed —— Tilt3D 的 .plane 帶著 transform，
               裡面任何 fixed 的定位基準都會變成那張卡而不是視窗 -->
          <button
            v-if="selecting"
            type="button" class="hit"
            :disabled="!canSell(p)"
            :aria-pressed="sellPick.includes(p.id)"
            :aria-label="`選取 ${p.card.name}`"
            @click="toggleSell(p)"
          >
            <span v-if="canSell(p)" class="tick" aria-hidden="true"></span>
          </button>
        </Tilt3D>

        <p v-if="justGot.has(p.id)" class="fresh-tag" role="status">剛收進卡冊</p>

        <p v-if="justRecycled?.id === p.id" class="got" role="status">
          已入帳 <strong class="mono">+{{ justRecycled.points.toLocaleString() }}</strong> 點
        </p>

        <!-- 寄存中才有動作可做，收成一顆按鈕；其餘狀態只留一行取得日期，
             讓每一列的高度不會被「有按鈕的那張」整列撐高 -->
        <button
          v-if="p.status === 'stashed' && !selecting"
          type="button" class="more" :class="{ on: openCard === p.id }"
          :aria-expanded="openCard === p.id" :aria-label="`${p.card.name} 的操作`"
          @click="toggleCard(p.id)"
        >
          <span>{{ openCard === p.id ? '收起' : '操作' }}</span>
          <span class="chev" aria-hidden="true"></span>
        </button>
        <p v-else class="meta mono">取得 {{ wonDay(p.acquiredAt) }}</p>

        <div v-if="openCard === p.id && p.status === 'stashed' && !selecting" class="body">
          <!-- 鑑定編號與寄存期限：決定要不要出貨／回收時才需要，所以收在這裡 -->
          <CertTag :card="p.card" />
          <span class="mono muted exp">寄存至 {{ p.stashExpiresAt }}</span>

          <div class="acts">
            <button class="btn primary sm" @click="openShip(p)">申請出貨</button>
            <!-- 文案刻意不寫「回收 +N 點」：那句話讀起來像平台保證收購，
                 而實際上這是**賣家掛出來的報價**，錢從賣家那個池的保留額出，
                 接受之後卡片歸還賣家。不是保證成交 —— 賣家的保留額不足時
                 會被擋下來，所以按鈕講的是「提出」不是「換到」。 -->
            <button
              v-if="quoteOf(p).eligible"
              class="btn sm" @click="askRecycle(p)"
            >
              按宣告買回價換回 {{ quoteOf(p).points.toLocaleString() }} 點
            </button>
            <span v-else class="muted no-offer">{{ quoteOf(p).reason }}</span>
          </div>

          <!-- 確認：不可逆，所以把「這是誰的報價、成不成得了」一次講完 -->
          <div v-if="confirming === p.id" class="confirm">
            <dl class="quote">
              <!-- 參考價擺在上面只是對照。標籤要寫死「賣家標示」——
                   不寫的話它讀起來像平台認證過的行情，而它只是賣家自己填的數字。 -->
              <div>
                <dt>賣家標示參考價</dt>
                <dd class="mono">{{ refPriceText(p.card.refPrice) }}<span class="fyi">僅供參考</span></dd>
              </div>
              <div>
                <dt>宣告買回價</dt>
                <dd class="mono">{{ quoteOf(p).points.toLocaleString() }} 點</dd>
              </div>
              <div class="tot">
                <dt>你會拿到</dt>
                <dd class="mono">+{{ quoteOf(p).points.toLocaleString() }} 點</dd>
              </div>
            </dl>
            <p class="warn">
              上面那個參考價是<strong>賣家自己標示的，僅供參考、不構成承諾</strong>，
              跟你拿得到的點數沒有任何關係。
              你拿得到的是<strong>賣家在開賣前宣告、之後改不了的買回價</strong>。
              接受之後卡片歸還賣家、點數由賣家支付，
              <strong>成立與否以賣家當下的可付款額為準</strong>。
              卡片還回去之後<strong>無法取回</strong>。
              點數只能用於站內抽選，<strong>不可提領現金、不可轉讓他人</strong>。
            </p>
            <div class="acts">
              <button class="btn primary sm" @click="doRecycle(p)">提出回收</button>
              <button class="btn sm" @click="confirming = null">取消</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 這個分頁一張卡也沒有。整本卡冊是空的時候由上面那塊空狀態負責，
         這裡講的是「這個分頁沒有」，兩句話不一樣 -->
    <p v-if="list.ready.value && total && !shown.length && !list.error.value" class="empty muted noneTab">
      這個分頁目前沒有卡片。
    </p>

    <!-- 哨兵放在格線外面當兄弟節點：塞進 grid 會佔掉一格，而且 grid 子元素
         預設 min-width: auto，長錯誤訊息會把整欄撐開（手機是兩欄，很敏感） -->
    <ListSentinel
      ref="sentinelRef"
      :loading="list.loading.value"
      :done="list.done.value"
      :error="list.error.value"
      :manual="list.manual.value"
      :empty="!shown.length"
      done-text="已經是全部的卡片了"
      @retry="list.retry()"
      @more="list.load()"
    />

    <!-- 上架選取列。貼在底部而不是頂部：它是「選完之後」要按的東西，
         拇指本來就在那裡，而卡片在上面，兩者不必爭同一塊位置。
         一進選取模式就在（N=0 時上架鍵是 disabled），所以「還要選幾張才動得了」
         這件事不必自己猜。

         列本身改用 BottomActionBar：Teleport（換頁轉場會在 .page 上加
         transform，祖先有 transform 就會變成 position:fixed 的定位基準）、
         進出各一組 keyframes、以及讓位的 spacer，三個坑都已經在那支裡面了。
         這一頁原本自己寫了一份一模一樣的，跟建池挑卡器那條列是同一件事的
         兩份實作 —— 全站的貼底列只留一套。

         spacer 給 124px：實測列高 109px、離視窗底 10px（底部導覽那一份
         讓位是全域頁尾在算的，見 HANDOFF 2.3，不能重複加）。 -->
    <BottomActionBar
      :open="selecting"
      label="上架選取"
      :spacer="124"
      :max-width="560"
    >
      <div class="pickBar">
        <!-- 資訊區整塊就是「查看已選」的按鈕，不另外多一顆 ——
             多一顆就要多一列，這條列的高度是量過的（見下面 .pickBar 的註解）。
             一張都沒選時它沒有東西可展開，所以 disabled，而不是開一個空面板。 -->
        <button
          type="button" class="pickInfo" :disabled="!sellPick.length"
          :aria-label="`查看已選的 ${sellPick.length} 張卡`"
          @click="chosenOpen = true"
        >
          <!-- role="status"：張數會因為在面板裡移除而改變，而那個動作
               發生在別的地方，讀螢幕的人需要被告知這裡的數字動了 -->
          <span class="pickLines" role="status">
            <strong>已選 <span class="mono">{{ sellPick.length }}</span> 張</strong>
            <span class="mono pickSub">市值合計 {{ sellPickValue.toLocaleString() }} 點</span>
          </span>
          <span v-if="sellPick.length" class="pickPeek">查看</span>
        </button>
        <button type="button" class="btn sm" @click="endSell">取消</button>
        <button type="button" class="btn primary sm" :disabled="!sellPick.length" @click="goSell">
          一鍵上架
        </button>
      </div>
    </BottomActionBar>

    <!-- 已選清單面板。跟出貨面板共用同一組 .sheetWrap / .sheet 視覺，
         一樣要 Teleport 到 body（祖先的 transform 會變成 position:fixed 的
         定位基準）。關法三種：點遮罩、右上角關閉鍵、Esc。 -->
    <Teleport to="body">
      <div v-if="chosenOpen" class="sheetWrap" @click.self="closeChosen">
        <div class="sheet card chosenSheet" role="dialog" aria-modal="true" aria-label="已選的卡">
          <button type="button" class="sheetClose" aria-label="關閉" @click="closeChosen">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>

          <h2>已選的卡</h2>
          <p class="muted fine">
            點一張卡＝取消選取那一張。同一款卡合併成 ×N；
            <strong>有鑑定編號的卡各自獨立，不合併</strong> —— 那是兩張可以分別查證的實體卡。
          </p>

          <!-- 縮圖格狀而不是一張一列：這裡選的是自己的卡，用卡圖認得最快，
               而一列一張時十幾張就要捲很久（挑卡器那邊同樣的理由）。 -->
          <ul class="picks">
            <li v-for="g in sellGroups" :key="g.key" class="pickCell">
              <!-- 整格就是取消選取鍵：叉叉只是角標，真正可按的是整格
                   （最窄也有 56×78），遠超過 44px 的觸控下限 -->
              <button
                type="button" class="pickTile"
                :aria-label="g.members.length > 1
                  ? `取消選取一張 ${g.head.card.name}，目前 ${g.members.length} 張`
                  : `取消選取 ${g.head.card.name}`"
                :data-prize="g.members[g.members.length - 1].id"
                @click="removeOne(g)"
              >
                <span class="pickArt">
                  <CardArt
                    :image="g.head.card.image" :alt="g.head.card.name"
                    :cert-no="g.head.card.certNo" :art-id="g.head.card.artId"
                  />
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

          <div class="acts">
            <button type="button" class="btn primary sm" @click="closeChosen">完成</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 出貨申請。做成覆蓋層而不是行內展開，是因為它要一次呈現「寄哪幾張」
         跟「寄到哪」兩件事，塞進單張卡片的位置會看不完整。

         Teleport 到 body 是必要的，不是整潔問題：換頁轉場會在 .page 上加
         transform，而**祖先只要有 transform，position: fixed 的定位基準就會
         變成那個祖先而不是視窗** —— 面板會被推出畫面外並被裁掉。
         實機上就是這樣壞的（左半邊整個看不到）。 -->
    <Teleport to="body">
    <div v-if="shipOpen" class="sheetWrap" @click.self="shipOpen = false">
      <div class="sheet card" role="dialog" aria-label="申請出貨">
        <h2>申請出貨</h2>
        <p class="muted fine">勾選要一起寄出的卡。合併成一張出貨單，只算一次運費。</p>

        <ul class="pickList">
          <li v-for="p in stashed" :key="p.id">
            <label>
              <input type="checkbox" :checked="shipPick.includes(p.id)" @change="toggleShipPick(p.id)">
              <span class="pn">{{ p.card.name }}</span>
              <span class="mono muted">{{ p.tier }}</span>
            </label>
          </li>
        </ul>
        <ListSentinel
          ref="shipSentinelRef"
          :loading="shipList.loading.value"
          :done="shipList.done.value"
          :error="shipList.error.value"
          :manual="shipList.manual.value"
          :empty="!stashed.length"
          @retry="shipList.retry()"
          @more="shipList.load()"
        />

        <div class="fields">
          <label><span>收件人</span><input v-model="addr.name" type="text" placeholder="真實姓名"></label>
          <label><span>電話</span><input v-model="addr.phone" type="tel" inputmode="tel" placeholder="09xxxxxxxx"></label>
          <label><span>郵遞區號</span><input v-model="addr.zip" type="text" inputmode="numeric" placeholder="選填"></label>
          <label><span>縣市</span><input v-model="addr.city" type="text" placeholder="例：台北市"></label>
          <label class="wide"><span>地址</span><input v-model="addr.line1" type="text" placeholder="區、路、號、樓"></label>
        </div>
        <p class="muted fine">預設帶入會員資料裡的收件資訊，這次要寄別的地方可以直接改。</p>

        <p v-if="shipErr" class="warn">{{ shipErr }}</p>
        <div class="acts">
          <button class="btn sm" @click="shipOpen = false">取消</button>
          <button
            class="btn primary sm"
            :disabled="!addrReady || !shipPick.length || shipBusy"
            @click="submitShip"
          >{{ shipBusy ? '送出中…' : `送出（${shipPick.length} 張）` }}</button>
        </div>
      </div>
    </div>
    </Teleport>

    <!-- 送出後的回饋固定在畫面下方，不隨捲動跑掉。同一時間只有一則。
         同樣要 Teleport —— 理由見上面出貨面板的說明 -->
    <Teleport to="body">
      <p v-if="toast" class="toast" role="status">{{ toast }}</p>
    </Teleport>
  </div>
</template>

<style scoped>
/* ---- 上架入口 ----
   卡冊層級的一顆按鈕，選取模式開著時換成一行說明 ——
   兩者不會同時出現，這一列的高度才不會跳動。 */
.listHead { display: flex; align-items: center; gap: 10px; min-width: 0; margin: 4px 0 16px; }
.sellCta { flex: none; min-height: 44px; padding: 9px 18px; font-size: 13.5px; }
/* 這一列的寬度由分頁那條讓出來：它自己會橫向捲，按鈕不該被壓縮 */
.listHead .tabs { flex: 1 1 auto; min-width: 0; margin: 0; }
.sellHint { margin: -8px 0 16px; min-width: 0; font-size: 12px; line-height: 1.6; color: var(--muted); }
.sellHint strong { color: var(--ink); font-weight: 600; }

/* ---- 選取模式 ----
   「這張被選了」要在卡片上看得出來，不能只靠底下那條列的數字 ——
   捲到一半時那條列講的是總數，回答不了眼前這張到底有沒有選中。
   選取態用 outline 不用 border：outline 不佔版面，
   兩欄格線下加一圈 2px 的邊會把卡片內容區再縮 4px。 */
.hit {
  position: absolute; inset: 0; z-index: 2;
  padding: 0; border: 0; background: none; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.hit:disabled { cursor: not-allowed; }
.hit:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; border-radius: 12px; }
.item.sel { outline: 2px solid var(--accent); }
/* 不能上架的卡在選取模式下退到背景，但不整個藏起來 ——
   使用者要知道「它還在，只是這次不能賣」 */
.item.off { opacity: .38; }

/* 勾記：空心圈 → 實心打勾。勾是兩條 border 轉 45 度畫出來的，
   不用任何符號字元，換字型或換系統都長一樣。 */
.tick {
  position: absolute; top: 7px; right: 7px;
  width: 22px; height: 22px; border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, .9);
  /* 卡圖底下可能是皮卡丘那種亮黃色，白圈會整個消失 ——
     所以圈內先鋪一層深色，再加一圈外陰影把它從卡面上撐開 */
  background: rgba(0, 0, 0, .5);
  box-shadow: 0 1px 5px rgba(0, 0, 0, .5);
}
.item.sel .tick { background: var(--accent); border-color: var(--accent); }
.item.sel .tick::after {
  content: ''; position: absolute;
  left: 5px; top: 3px; width: 5px; height: 9px;
  border-right: 2px solid #fff; border-bottom: 2px solid #fff;
  transform: rotate(45deg);
}

/* ---- 上架選取列 ---- */
/* 定位、進出場動畫、讓位都交給 BottomActionBar（見那支的註解：Teleport、
   讓位補在文件最末端、進出各一組 keyframes，三個坑都在裡面）。
   這裡只剩「列裡面長什麼樣」。原本這一頁自己寫了一份 fixed + keyframes，
   跟挑卡器那條列是同一件事的兩份實作 —— 全站的貼底列只留一套。

   量測沿用舊版的基準：離視窗底 10px（BottomActionBar 的 gap 預設值）、
   最大寬 560px、列高在 393px 上維持 109px。 */
.pickBar {
  min-width: 0;
  /* 資訊自己一行、兩顆按鈕平分下一行。
     原本是三個並排，資訊區靠 flex: 1 撐 —— 那要求按鈕會自己收斂，
     但只要有任何規則把按鈕撐寬（這裡就是 .btn.sm 的 width: 100%），
     資訊區就會被壓到 0。分兩行之後不管按鈕多寬都不會吃到資訊。 */
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px;
}
.pickBar .btn { flex: 1 1 0; min-width: 0; white-space: nowrap; min-height: 42px; }
.pickBar .btn:disabled { opacity: .45; cursor: not-allowed; }
/* 資訊區是一顆按鈕（點開已選清單），但看起來不能像按鈕 ——
   它同時是「已選 N 張」這個狀態的唯一顯示位置，畫成第三顆實心鈕會
   跟旁邊那兩個真正的動作搶。所以留裸底、只在右邊掛一個「查看」的字。 */
.pickInfo {
  flex: 1 1 100%; min-width: 0;
  display: flex; align-items: center; gap: 10px;
  padding: 0; border: 0; background: transparent; color: inherit;
  text-align: left; font: inherit;
}
.pickInfo:disabled { cursor: default; }
/* 它不是 .btn，所以吃不到 base.css 那條焦點框 —— 不補的話鍵盤走到這裡
   會出現瀏覽器預設的藍色外框，跟全站的焦點樣式不同掛 */
.pickInfo:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 10px; }
/* 兩行的行高收緊到剛好包住字：這條列的高度是量過的（393px 上 109px，
   讓位的 spacer 就是照這個數字給的）。BottomActionBar 的內距比舊版那條
   自己寫的 fixed 列多 2px，行高不收就會多長出 6px，最後一列卡片的
   讓位跟著不夠。 */
.pickLines { min-width: 0; display: flex; flex-direction: column; }
.pickInfo strong { font-size: 14px; line-height: 1.35; }
.pickSub { font-size: 11.5px; line-height: 1.4; color: var(--muted); }
/* 「查看」永遠靠右，不隨張數變成三位數而左右跳 */
.pickPeek {
  margin-left: auto; flex: none;
  padding: 5px 10px; border-radius: var(--pill);
  background: var(--surface-2); color: var(--ink);
  font-size: 11.5px; font-weight: 600;
}

/* ---- 已選清單面板 ---- */
/* 關閉鍵是絕對定位的，定位基準必須是這張面板本身。少了這一行它會退到
   .sheetWrap（fixed inset:0），跑到整個視窗的右上角去 —— 實測就是這樣。
   只加在這一張上，不動出貨面板（那張沒有關閉鍵，多一個定位脈絡沒有意義）。 */
.chosenSheet { position: relative; }
.sheetClose {
  position: absolute; right: 10px; top: 10px;
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 0; background: var(--surface-2); color: var(--muted); border-radius: 50%;
}
.sheetClose svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
/* 標題要讓出右上角那顆關閉鍵的位置（它是絕對定位的） */
.chosenSheet h2 { padding-right: 42px; }
/* 縮圖格狀。auto-fill + minmax(0, 1fr) 讓一列塞得下幾張就塞幾張。
   欄寬給 minmax(0, …) 是這個 repo 的老規矩（預設 min-width: auto
   會讓內容把格線撐破，見 HANDOFF 2.1） */
.picks {
  min-width: 0; list-style: none; margin: 12px 0; padding: 2px;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(54px, 1fr));
  gap: 8px;
}
/* 這一格不自己設高度上限與捲動：清單住在 .sheet 裡，而 .sheet 本身就是
   max-height + overflow:auto。再套一層內捲會變成兩個巢狀捲動區 ——
   手指落在哪就捲哪一個，實測會讓人以為「捲不動」。 */
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
}
/* CardArt 自己的圓角是給大版位用的 14px，在 54px 的縮圖上會啃掉卡角 */
.pickArt :deep(.art), .pickArt :deep(.art-img) { border-radius: 0; height: 100%; object-fit: cover; }
/* 叉叉只是「按了會取消選取」的提示，不是它自己要被瞄準 —— 可按範圍是整格 */
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

/* ---- 出貨面板 ----
   貼底而不是置中：手機上置中的對話框，鍵盤一彈出來就會把送出鍵推出畫面 */
.sheetWrap {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: flex-end; justify-content: center;
  background: #000a;
  padding: 0;
}
.sheet {
  width: 100%; max-width: min(520px, 100vw);
  /* 保險絲：就算之後有人加了壓不住的內容，也讓它自己橫捲，
     不要把整個面板撐出視窗外被裁掉 */
  overflow-x: hidden;
  max-height: min(88dvh, 720px); overflow-y: auto; overscroll-behavior: contain;
  border-radius: 18px 18px 0 0;
  padding: 18px 16px calc(18px + var(--safe-b, 0px));
}
.sheet h2 { font-size: 17px; margin: 0 0 6px; }

.pickList { list-style: none; margin: 12px 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.pickList label {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 10px; border-radius: 10px; background: var(--surface-2);
  font-size: 13.5px; cursor: pointer;
}
.pickList .pn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 4px; }
/* min-width: 0 不是可有可無的。grid 子元素預設是 min-width: auto ——
   它不會縮到比「內容的固有寬度」更窄，所以 1fr 根本壓不住裡面的 input：
   實測 393px 的螢幕上每欄該是 175px，實際卻是 206px，整個 .fields
   從 359 撐到 420。而 .sheetWrap 是 justify-content: center，
   溢出的部分左右對半切掉 —— 面板的左半邊直接看不到。
   input 本身也要，因為它自己也是 flex 容器的子元素。 */
.fields label { display: flex; flex-direction: column; gap: 5px; min-width: 0; font-size: 12.5px; color: var(--muted); }
.fields label.wide { grid-column: 1 / -1; }
.fields input { min-width: 0; }
.fields input {
  padding: 10px 11px; font: inherit; font-size: 16px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--field, var(--surface-2)); color: var(--ink);
}
.fields input:focus { outline: none; border-color: var(--gold); }

.sellRow { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.sellRow input {
  flex: 1; min-width: 0;  /* flex 子元素預設也是 min-width: auto，見 .fields 的說明 */ padding: 9px 11px; font: inherit; font-size: 16px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--field, var(--surface-2)); color: var(--ink);
}

/* 送出後的回饋。固定在底部導覽上方，捲動時不會跑掉 */
.toast {
  position: fixed; left: 50%; transform: translateX(-50%);
  bottom: calc(14px + max(var(--nav-total, 0px), var(--safe-b, 0px)));
  z-index: 75; max-width: min(92vw, 460px);
  margin: 0; padding: 11px 15px; border-radius: 12px;
  background: var(--surface-3); color: var(--ink);
  font-size: 13px; line-height: 1.6;
  box-shadow: 0 8px 28px #0007;
}

/* ---- 收藏總覽 ----
   底色維持純 var(--surface)，沒有漸層：曲線的端點靠一圈「底色描邊」跟線分離，
   底下只要有漸層，那圈描邊就會在某個高度對不上底色而露出接縫。 */
.overview {
  display: grid; gap: 12px;
  padding: 16px 18px; margin: 14px 0 10px;
}
.ovLabel {
  margin: 0; font-size: 11.5px; color: var(--faint); letter-spacing: .04em;
}
.ovHero { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: nowrap; }
/* 主角數字。單位是行內元素、不換行，「53,380 點」永遠是一個量詞而不是兩段。
   clamp 讓它在 320px 上自己縮到塞得下，不必等到折行才發現放不下 */
.ovVal { margin: 0; white-space: nowrap; min-width: 0; }
.ovNum {
  font-size: clamp(25px, 7.6vw, 34px);
  font-weight: 800; letter-spacing: -.025em; line-height: 1.05;
  color: var(--gold-deep);
  /* 大字用比例數字：tabular 會讓每個數字都佔 0 的寬度，整串看起來鬆散 */
  font-variant-numeric: proportional-nums;
}
.ovUnit { margin-left: 4px; font-size: 12.5px; color: var(--muted); }
.ovHold { margin: 0; flex: none; font-size: 12.5px; color: var(--muted); white-space: nowrap; }
.ovHold b { color: var(--ink); font-weight: 700; font-size: 13.5px; font-variant-numeric: tabular-nums; }

/* 賞別分佈條。2px 的縫是底色本身，不是描邊 —— 描邊會多一圈不是資料的墨水 */
.mixBar {
  display: flex; gap: 2px; height: 8px;
  border-radius: var(--pill); overflow: hidden;
  background: var(--surface);
}
.mixBar .seg { flex-basis: 0; min-width: 4px; }
.seg.t-a { background: var(--tier-a); }
.seg.t-b { background: var(--tier-b); }
.seg.t-c { background: var(--tier-c); }
.seg.t-d { background: var(--tier-d); }
.seg.t-last { background: var(--tier-last); }
.seg.t-bust { background: var(--ink); }

/* 圖例才是識別的主要管道：C 賞的藍與 D 賞的灰在色覺檢測下分離度不足，
   只靠顏色會有人分不出來，所以每一段都配文字 */
.mixKey {
  list-style: none; margin: -2px 0 0; padding: 0;
  display: flex; flex-wrap: wrap; gap: 4px 12px;
  font-size: 11px; color: var(--muted);
}
.mixKey li { display: inline-flex; align-items: center; gap: 5px; }
.mixKey b { font-weight: 600; color: var(--ink); margin-left: 3px; }
.kd { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--tier-d); }
.kd.t-a { background: var(--tier-a); }
.kd.t-b { background: var(--tier-b); }
.kd.t-c { background: var(--tier-c); }
.kd.t-d { background: var(--tier-d); }
.kd.t-last { background: var(--tier-last); }
.kd.t-bust { background: var(--ink); }

.ovBest {
  display: flex; align-items: center; gap: 7px; min-width: 0;
  margin: 0; padding-top: 10px; border-top: 1px solid var(--line-soft);
  font-size: 12.5px;
}
.bLabel { color: var(--faint); font-size: 11.5px; flex: none; }
.bName {
  color: var(--ink); font-weight: 600; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bVal { margin-left: auto; flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }

.ovCurve { padding-top: 10px; border-top: 1px solid var(--line-soft); }

/* ---- 狀態分頁 ---- */
.tabs {
  display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none;
  margin: 4px 0 16px; padding-bottom: 2px;
  -webkit-mask-image: linear-gradient(90deg, #000 0 calc(100% - 24px), transparent);
  mask-image: linear-gradient(90deg, #000 0 calc(100% - 24px), transparent);
}
.tabs::-webkit-scrollbar { display: none; }
.tab {
  flex: none; min-height: 44px;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 8px 15px; border-radius: var(--pill);
  border: 1px solid var(--line-soft); background: transparent;
  color: var(--muted); font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s;
}
.tab.on { background: var(--ink); color: var(--bg); border-color: transparent; font-weight: 600; }
.tabN { font-size: 11px; opacity: .65; }
.tab.on .tabN { opacity: .8; }
@media (hover: hover) { .tab:not(.on):hover { color: var(--ink); border-color: var(--line); } }

@media (max-width: 720px) {
  .overview { padding: 14px; gap: 11px; }
}


/* ---- 公開卡冊 ---- */
/* 這段警語不縮成灰字小號 —— 它是使用者決定要不要按開關的依據，
   跟標題一樣要讀得下去 */

/* 開關本體 30px 高，但按鈕撐到 44px 觸控高度（touch.css 的門檻） */
.sw {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 56px; height: 44px; padding: 0; border: 0; background: none; cursor: pointer;
}
.sw:disabled { opacity: .5; cursor: not-allowed; }
.sw .track {
  width: 52px; height: 30px; border-radius: var(--pill);
  background: var(--surface-3); border: 1px solid var(--line);
  position: relative; transition: background .18s, border-color .18s;
}
.sw .knob {
  position: absolute; top: 3px; left: 3px; width: 22px; height: 22px;
  border-radius: 50%; background: var(--muted);
  transition: transform .18s, background .18s;
}
.sw.on .track { background: var(--accent); border-color: transparent; }
.sw.on .knob { transform: translateX(22px); background: #fff; }
.sw:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--pill); }

/* 分享列併進總覽卡的最後一段，用一條細線跟上面的數字分開 ——
   它是同一張卡裡的另一件事，不是另一張卡 */
.shareRow {
  display: flex; align-items: center; gap: 8px; min-width: 0;
  margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line-soft);
}
.shareRow .btn { min-width: 0; white-space: nowrap; }
.shareOffLabel { min-width: 0; font-size: 13px; font-weight: 600; }
/* 開關永遠靠右：不管左邊是標籤還是兩顆按鈕，它的位置都不該跳動 */
.shareRow .sw { margin-left: auto; flex: none; }
.shareErr { margin: 10px 0 0; font-size: 12px; color: var(--danger); }
.overview .confirm { margin-top: 12px; }



@media (max-width: 720px) {
}

.page { padding-top: 36px; padding-bottom: 72px; }
/* 讓位不在這裡補。選取列改用 BottomActionBar 之後，讓位是它 Teleport 到
   文件最末端的一段 spacer（列高 109px + 離底 10px，給 124px）——
   底部導覽那一份全域頁尾已經算過（見 HANDOFF 2.3，讓位只能有一個來源）。
   補在頁面容器裡對「捲到最底時最後一列被蓋住」其實沒有用：被蓋住的是
   文件的最末端，在中間插一段只是把整頁往下推。 */
h1 { font-size: 22px; margin: 0 0 6px; }
.note { font-size: 13px; margin: 0 0 22px; }
.empty { padding: 40px; text-align: center; display: grid; gap: 12px; justify-items: center; }
/* 「這個分頁沒有卡片」跟整本卡冊是空的不一樣：那是一句提示不是一張卡，
   所以不套 .card 的外框，留白也小一半 */
.noneTab { padding: 28px 12px; font-size: 13px; min-width: 0; }
/* align-items: start —— 沒有這行，整列的高度會被「展開中的那一張」拉高，
   旁邊那些沒展開的卡就跟著長出一大塊空白（改版前每一列都在做這件事） */
.grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  /* 見下方手機版的說明 */
  gap: 16px; align-items: start;
}
/* minmax(0, 1fr)：省略欄定義時隱含的欄是 auto，上界是 max-content，
   展開「操作」後裡面的鑑定編號膠囊（nowrap）就會把整張卡撐寬。
   實測 320px 兩欄格線下 .item clientW 133 / scrollW 136，卡片邊框被
   內容頂出去、壓到隔壁那張。 */
.item { padding: 8px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; align-content: start; }
.item.dim { opacity: .55; }

/* ---- 疊在卡圖上的資訊 ----
   卡圖是滿版彩色的：白字放在皮卡丘那種黃底上會整個消失。
   底部鋪一層由透明轉深的遮罩，文字才有固定的對比可以依靠。
   這幾個黑與白是「蓋在照片上的遮罩」不是介面表面色，兩套主題下卡圖都一樣亮，
   所以刻意不走主題權杖 —— CardArt 自己的 .caption 也是同一個道理。
   pointer-events: none 是必要的：不寫的話遮罩會吃掉 Tilt3D 的 pointermove，
   手指滑過卡片下半部就不會傾斜。 */
.scrim {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 28px 8px 8px;
  /* 明寫 minmax(0, 1fr)：省略時隱含的欄是 auto，上界等於 max-content，
     .sMain 裡整串不換行的卡名就會把軌道撐開，.sName 的 ellipsis 根本
     輪不到出場。實測 320px 上 .scrim clientW 121 / scrollW 124，卡片
     overflow: hidden，右邊的賞別標籤與估價被切掉一角。 */
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 5px;
  background: linear-gradient(180deg, transparent, rgba(0, 0, 0, .55) 38%, rgba(0, 0, 0, .88));
  pointer-events: none;
}
.sTags { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.sTags :deep(.tier) { font-size: 10px; padding: 2px 8px; }
.sChip {
  font-size: 10px; font-weight: 600; line-height: 1.4;
  padding: 2px 8px; border-radius: var(--pill);
  color: #fff; background: rgba(255, 255, 255, .24);
  white-space: nowrap;
}
.sMain { display: flex; align-items: baseline; gap: 6px; }
.sName {
  flex: 1; min-width: 0; font-size: 12.5px; font-weight: 700; line-height: 1.3;
  color: #fff; text-shadow: 0 1px 3px rgba(0, 0, 0, .75);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sVal {
  flex: none; font-size: 11px; color: rgba(255, 255, 255, .85);
  font-variant-numeric: tabular-nums; text-shadow: 0 1px 3px rgba(0, 0, 0, .75);
}

/* ---- 展開鈕 ----
   三顆通欄按鈕收成一顆。44px 是 touch.css 的觸控門檻，
   在兩欄格線下這顆是整張卡唯一要按的東西，寧可給滿。 */
.more {
  width: 100%; min-height: 44px; padding: 0 10px;
  display: flex; align-items: center; justify-content: center; gap: 7px;
  border: 1px solid var(--line); border-radius: var(--pill);
  background: var(--surface-2); color: var(--ink);
  font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s;
}
.more.on { background: var(--ink); color: var(--bg); border-color: transparent; }
.more:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.chev {
  width: 7px; height: 7px; flex: none;
  border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
  transform: translateY(-2px) rotate(45deg);
  transition: transform .18s;
}
.more.on .chev { transform: translateY(2px) rotate(-135deg); }
/* 不能操作的卡沒有按鈕，改放取得日期 —— 剛好也是曲線圖上的橫軸 */
.meta { margin: 0; min-height: 20px; display: flex; align-items: center; font-size: 11px; color: var(--faint); }

.body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 2px 2px 4px; justify-items: start; }  /* 同 .item 的理由 */
strong { font-size: 14px; }
.exp { font-size: 11.5px; }
.acts { display: flex; gap: 8px; margin-top: 4px; }
/* 沒有回收報價時放的那一行說明。min-width: 0 是這個 repo 的通則
   （flex 子元素預設 min-width: auto，長字串會把整列撐爆，見 docs/HANDOFF.md 2.1） */
.no-offer { font-size: 12px; line-height: 1.4; min-width: 0; align-self: center; }
.btn.sm { padding: 6px 12px; font-size: 12.5px; }

/* 剛拿到的那張：外框 + 一行字。只靠外框不夠 ——
   色覺檢測下強調色與底色的分離度不保證，一定要有文字把話講完。 */
.item.fresh { outline: 2px solid var(--accent); outline-offset: -1px; }
.fresh-tag {
  margin: 0; font-size: 12px; font-weight: 700;
  color: var(--accent); letter-spacing: .04em;
  /* 格線子元素：長卡名不該把整欄撐寬 */
  min-width: 0;
}

.got {
  margin: 0; font-size: 12.5px; color: var(--ok);
  font-weight: 600;
}
.got strong { color: var(--ok); }

/* 回收確認 —— 撐滿卡片寬度，讓報價與警語不被擠成兩欄 */
.confirm {
  justify-self: stretch;
  margin-top: 6px; padding: 12px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 12px;
  display: grid; gap: 10px;
}
.quote { margin: 0; display: grid; gap: 5px; font-size: 12.5px; }
.quote div { display: flex; justify-content: space-between; gap: 10px; }
.quote dt { color: var(--muted); }
.quote dd { margin: 0; }
.quote .tot {
  padding-top: 6px; border-top: 1px dashed var(--line);
  font-weight: 600;
}
.quote .tot dd { color: var(--ok); }
.fyi { margin-left: 6px; font-size: 10.5px; color: var(--faint); }
.warn { margin: 0; font-size: 11.5px; line-height: 1.55; color: var(--muted); }
.warn strong { color: var(--danger); font-weight: 600; }
.confirm .acts { margin-top: 0; }
.confirm .acts .btn { flex: 1; }

@media (max-width: 720px) {
  .page { padding-top: 22px; padding-bottom: 40px; }
  .sellBar { margin: -4px 0 14px; }
  .sellHint { font-size: 11.5px; }
  h1 { font-size: 19px; }
  .note { font-size: 12px; margin: 0 0 16px; }
  /* minmax(0, 1fr) 不是可有可無：1fr 等同 minmax(auto, 1fr)，
     只要某一格的內容固有寬度超過軌道，那一格就會被撐開、隔壁被擠扁。
     實測曾經從各 172px 變成 290px + 62.5px。 */
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .item { padding: 6px; gap: 6px; }
  .body { gap: 6px; padding: 2px 0 2px; }
  strong { font-size: 12.5px; line-height: 1.35; }
  /* 半寬卡片只剩約 145px，卡名要再降一階才不會每一張都被截成「桃夕…」 */
  .sName { font-size: 11.5px; }
  .sVal { font-size: 10px; }
  .scrim { padding: 24px 7px 7px; gap: 4px; }
  .exp { font-size: 10.5px; }
  /* 鑑定編號的膠囊是 white-space: nowrap，「PSA 10 #82345675」固有寬度
     129.5px，但 320px 兩欄格線下卡片的內容區只有 121px —— 膠囊會直接
     頂出卡片外緣。字級與左右內距各收一階就塞得下（實測 116px）。 */
  .body :deep(.cert) { font-size: 10.5px; padding-inline: 8px; }
  /* 半寬放不下並排按鈕。grid 的水平拉伸要用 justify-self（align-self 是垂直軸） */
  .acts { flex-direction: column; justify-self: stretch; gap: 6px; }
  /* 只給卡片裡堆疊的那組動作鈕。原本寫成裸的 .btn.sm，於是 width: 100%
     外溢到同一個 scope 下的每一顆小按鈕 —— 包括選取列的兩顆，
     它們各吃掉一個 100%，把旁邊的資訊區壓成 0 寬，文字變成一個字一行。 */
  .acts .btn.sm, .confirm .btn.sm { width: 100%; padding: 9px 6px; font-size: 12px; }

  /* 兩欄格線下每張卡內容區只剩約 115px，報價的標籤與數字並排會被折成四行。
     改成標籤在上、數字在下，數字本身禁止換行。 */
  .confirm { padding: 10px; }
  .quote div { flex-direction: column; align-items: flex-start; gap: 0; }
  .quote dt { font-size: 11px; }
  .quote dd { white-space: nowrap; font-size: 13px; }
  .quote .tot dd { font-size: 15px; }
}
</style>
