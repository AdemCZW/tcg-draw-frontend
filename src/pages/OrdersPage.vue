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
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useOrdersStore, shipToOf, type ShipTo } from '@/stores/orders'
import { useWalletStore } from '@/stores/wallet'
import {
  actionsFor, deadlineOf, DAY, HOUR, isOpen, validateTracking, CARRIERS,
  remainText, STATUS_TEXT, SHIP_DEADLINE, DELIVER_DEADLINE, INSPECT_WINDOW,
  type Carrier, type Deadline
} from '@/shared/escrow'
import type { Order } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import CopyLine from '@/components/CopyLine.vue'
import { MOCK } from '@/lib/config'

const store = useOrdersStore()
const wallet = useWalletStore()

const tab = ref<'open' | 'done'>('open')
const shipFor = ref<string | null>(null)
const tracking = ref('')
const disputeFor = ref<string | null>(null)
const reason = ref('')
const hasVideo = ref(false)
/* API 模式：伺服器要影片的 URL 才受理。R2 直傳是下一階段，先讓使用者貼連結 */
const videoUrl = ref('')
const canDispute = () => MOCK ? hasVideo.value : /^https?:\/\/.+/.test(videoUrl.value.trim())

/* 每分鐘重掃一次，讓倒數會動、到期的訂單自己結案。
   真正的推進靠時間戳，這個計時器只是讓畫面跟上，
   所以分頁被凍住也不會算錯 —— 回來時一次補算完。 */
let timer: number | undefined
onMounted(() => {
  store.load()
  timer = window.setInterval(() => store.sweep(), 60_000)
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
onUnmounted(() => { clearInterval(timer); clearInterval(tick); clearTimeout(allT) })

const list = computed(() =>
  store.orders.filter(o => (tab.value === 'open' ? isOpen(o) : !isOpen(o)))
)
const roleOf = (o: Order) => (o.sellerId === 'me' ? 'seller' : 'buyer') as 'seller' | 'buyer'

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
interface Row { o: Order; role: 'seller' | 'buyer'; dl: Deadline | null; sv: ShipView }
const rows = computed<Row[]>(() =>
  list.value.map(o => ({ o, role: roleOf(o), dl: deadlineOf(o), sv: shipViewOf(o) }))
)

/** 時限規則的數字從常數推，不要在文案裡寫死 —— 規則改了文案要跟著改 */
const SHIP_HOURS = Math.round(SHIP_DEADLINE / HOUR)
const DELIVER_DAYS = Math.round(DELIVER_DEADLINE / DAY)
const INSPECT_DAYS = Math.round(INSPECT_WINDOW / DAY)

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
function seedDemo(kind: 'full' | 'partial' | 'none' | 'long' | 'buyer') {
  if (kind === 'buyer') return store.seedBuyerOrder(DEMO_CARD, 41000)
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

/** 打開出貨表單。上一次填的一定要清掉 —— 表單是頁面層級的狀態，
    不清的話 A 訂單填的單號會跟著出現在 B 訂單的表單裡，
    而那會把一組單號掛到另一張卡的訂單上（單號在後端是唯一的）。 */
function openShip(o: Order) {
  shipFor.value = o.id
  tracking.value = ''
  carrier.value = ''
  err.value = ''
}
function closeShip() {
  shipFor.value = null
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
    closeShip()
    tracking.value = ''
  } catch (e) { err.value = e instanceof Error ? e.message : '出貨失敗' }
  finally { busy.value = false }
}
async function doDispute(o: Order) {
  if (!canDispute() || busy.value) return
  err.value = ''
  busy.value = true
  try {
    await store.dispute(o.id, reason.value.trim() || '未說明', true, videoUrl.value.trim())
    disputeFor.value = null
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
    <p v-if="!list.length" class="empty muted">
      {{ tab === 'open' ? '目前沒有進行中的訂單。到市場買一張「需寄送」的卡就會建立託管訂單。' : '還沒有結案的訂單。' }}
    </p>

    <article v-for="r in rows" :key="r.o.id" class="ord">
      <div class="top">
        <CardArt class="thumb" :image="r.o.card.image" :alt="r.o.card.name"
                 :cert-no="r.o.card.certNo" :art-id="r.o.card.artId" />
        <div class="meta">
          <strong class="nm">{{ r.o.card.name }}</strong>
          <p class="who">
            <span class="role" :class="r.role">{{ r.role === 'seller' ? '我是賣家' : '我是買家' }}</span>
            {{ r.role === 'seller' ? r.o.buyerName : r.o.sellerName }}
          </p>
          <p class="amt mono">{{ r.o.price.toLocaleString() }} 點<span v-if="r.o.deposit"> · 保證金 {{ r.o.deposit.toLocaleString() }}</span></p>
        </div>
        <span class="st" :class="r.o.status">{{ STATUS_TEXT[r.o.status] }}</span>
      </div>

      <!-- 訂單編號：雙方在 LINE 上對話時唯一的共同代號。兩邊都看得到、
           兩邊都複製得走 —— 少了它，「我那張噴火龍」在賣家那邊可能有三筆 -->
      <div class="idBox">
        <CopyLine
          label="訂單編號" :value="r.o.id" mono big
          :testid="`copy-id-${r.o.id}`"
        />
        <p class="idWhy">跟對方聯絡時報這個編號，才知道在講哪一筆。</p>
      </div>

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

      <!-- 買家那側：要知道卡是賣家直接寄來的，以及自己那一半的按鈕是什麼 -->
      <p v-if="r.role === 'buyer' && r.o.status === 'escrowed'" class="buy">
        賣家會照你在會員資料填的收件資訊<b>直接寄給你</b>。寄送細節請跟賣家用你們原本的
        聯絡方式談，報上面的訂單編號最快。
      </p>
      <p v-if="r.role === 'buyer' && (r.o.status === 'shipped' || r.o.status === 'delivered')" class="buy">
        卡收到之後按<b>「我已收到」</b>，款項才會放給賣家。沒收到、或東西跟描述不符，就按「我要申訴」。
      </p>

      <p v-if="r.o.tracking" class="trk mono">單號 {{ r.o.tracking }}</p>
      <p v-if="r.o.disputeReason" class="dr">爭議：{{ r.o.disputeReason }}</p>

      <!-- 可做的動作完全由狀態機決定，UI 不自己判斷 -->
      <div class="acts">
        <template v-for="a in actionsFor(r.o, r.role)" :key="a">
          <button v-if="a === 'ship'" type="button" class="btn primary sm" @click="openShip(r.o)">
            我已寄出
          </button>
          <button v-if="a === 'confirm'" type="button" class="btn primary sm" @click="store.confirm(r.o.id)">
            我已收到
          </button>
          <button v-if="a === 'dispute'" type="button" class="btn sm" @click="disputeFor = r.o.id">
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

      <!-- 出貨表單。兩欄都是選填，畫面上要明說 —— 舊版看起來像必填，
           賣家會以為沒單號就出不了貨 -->
      <div v-if="shipFor === r.o.id" class="form">
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

        <div class="frow">
          <button type="button" class="btn sm" @click="closeShip()">取消</button>
          <button
            type="button" class="btn primary sm" data-testid="ship-submit"
            :disabled="!!trackErr || busy" @click="doShip(r.o)"
          >{{ busy ? '處理中…' : '我已寄出' }}</button>
        </div>
      </div>

      <!-- 申訴表單：沒有開箱影片不受理 -->
      <div v-if="disputeFor === r.o.id" class="form">
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
        <div class="frow">
          <button type="button" class="btn sm" @click="disputeFor = null">取消</button>
          <button type="button" class="btn primary sm" :disabled="!canDispute() || busy" @click="doDispute(r.o)">{{ busy ? '處理中…' : '送出申訴' }}</button>
        </div>
      </div>
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
        <button type="button" class="btn sm ghost" @click="seedDemo('buyer')">+ 買家視角訂單</button>
        <button type="button" class="btn sm ghost" @click="store.reset()">全部清除</button>
      </div>
    </section>
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
.top { display: grid; grid-template-columns: 52px 1fr auto; gap: 12px; align-items: start; }
.thumb { width: 52px; height: 73px; border-radius: 6px; overflow: hidden; }
.thumb :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.nm { display: block; font-size: 14.5px; line-height: 1.4; margin-bottom: 4px; }
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

/* ---- 買家那側的說明 ---- */
.buy {
  margin-top: 12px; padding: 10px 12px;
  background: var(--surface-2); border-radius: var(--radius);
  font-size: 12px; line-height: 1.8; color: var(--muted);
}
.buy b { color: var(--ink); font-weight: 600; }

.lead {
  font-size: 12.5px; line-height: 1.8; color: var(--muted); margin: 0 0 10px;
}
.lead b { color: var(--ink); font-weight: 600; }

/* 桌機上把這幾塊的量測寬度收住。訂單卡是滿版的，不收的話複製鈕會離它要複製的
   那個值一千多像素遠 —— 兩個東西看起來不像同一組；長行的說明文字也不好讀。 */
@media (min-width: 721px) {
  .idBox, .send { max-width: 620px; }
  .howL li, .howR li, .buy, .lead, .hint { max-width: 720px; }
}

.acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
/* 「我已寄出」「我已收到」是這一頁唯二會移動錢的按鈕，不該比別的地方小。
   全域的 44px 只在 pointer: coarse 生效，這裡不分裝置一律撐開 */
.acts .btn.sm { min-height: 44px; padding: 8px 16px; font-size: 13px; }
.btn.ghost { opacity: .72; font-size: 12px; }

.form { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.form label { display: block; font-size: 12.5px; color: var(--muted); margin-bottom: 8px; }
.form input[type="text"] {
  display: block; width: 100%; margin-top: 5px;
  background: var(--field); border: 1px solid var(--line);
  border-radius: var(--radius); color: var(--ink);
  padding: 10px 12px; font-size: 14px; min-height: 44px;
}
.chk { display: flex; gap: 8px; align-items: flex-start; line-height: 1.6; }
.chk input { margin-top: 3px; width: 18px; height: 18px; flex: none; }
.hint { font-size: 11.5px; line-height: 1.65; color: var(--muted); margin: 0 0 10px; }
.frow { display: flex; gap: 8px; justify-content: flex-end; }

.err { color: var(--danger); font-size: 13.5px; margin: 0 0 12px; }
.dev { margin-top: 26px; padding: 14px 16px; background: var(--surface-2); border-radius: var(--radius-lg); }
.dev h2 { font-size: 14px; margin: 0 0 6px; }
.dev p { font-size: 12.5px; line-height: 1.7; margin: 0 0 10px; }
.devRow { display: flex; flex-wrap: wrap; gap: 8px; }
.devRow .btn.sm { min-height: 44px; padding: 7px 14px; font-size: 12.5px; }
</style>
