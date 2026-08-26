<script setup lang="ts">
/**
 * 賣家的出貨與結算。
 *
 * 為什麼這一頁必須存在：抽卡池的結算已經整套做完了（票金貸記給賣家 →
 * 保留額 → 出貨 → 買家確認或鑑賞期滿 → 逐筆釋放），唯獨「賣家按已出貨」
 * 那一步前端一行都沒有。後果不是少一個按鈕，是**那條金流跑不完** ——
 * 賣家看得到保留額卻永遠拿不到，而買家的卡也永遠等不到。
 *
 * 這一頁只回答三個問題，順序就是版面的順序：
 *   1. 我的錢在哪？   —— 可動用 vs 保留中，以及保留中的錢卡在哪個階段
 *   2. 快到期了嗎？   —— 逾期會退款給買家並記違約，所以警告要在**逾期之前**
 *   3. 哪幾張要寄？   —— 待出貨清單，可逐筆也可一次多筆
 *
 * 「錢在哪」擺在最上面而不是清單：賣家回到這一頁的頻率遠高於他真的有東西要寄，
 * 而每次回來要看的都是那個數字。清單為空時這一段仍然有話可說。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api, type SellerSettlement, type SellerWallet } from '@/lib/api'
import { MOCK } from '@/lib/config'
import CardArt from '@/components/CardArt.vue'
import BottomActionBar from '@/components/BottomActionBar.vue'
import {
  settlementDeadline, SELLER_DEFAULT_LIMIT, type SettlementStatus
} from '@/shared/pool-settlement'
import { CARRIERS, remainText, validateTracking, HOUR, type Carrier } from '@/shared/escrow'

/* ---------------- 資料 ---------------- */

const rows = ref<SellerSettlement[]>([])
const wallet = ref<SellerWallet>({ points: 0, locked: 0, reserved: 0, available: 0 })
const loading = ref(true)
const loadErr = ref('')

/**
 * 伺服器與這台電腦的時鐘差。倒數一律以伺服器為準。
 *
 * 沒有這個補正的話，使用者的電腦慢十分鐘，畫面就會說「還有時間」而後端
 * 早就判逾期並退款了 —— 而逾期的代價是一次違約，那不是可以「大概」的事。
 */
const skew = ref(0)
const now = ref(Date.now())

async function load() {
  loadErr.value = ''
  try {
    const r = await api.sellerSettlements()
    rows.value = r.settlements
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

/* ---------------- 白話狀態 ---------------- */

/**
 * 資料庫的英文狀態不能直接吐給使用者看。
 *
 * 而且同一個狀態對買家與賣家的意思不一樣：`held` 對買家是「卡在保管庫」，
 * 對賣家是「先別寄，買家還沒說要」。所以這裡不共用 shared 的 SETTLEMENT_TEXT，
 * 那一份是中性描述，這一份是**站在賣家角度的下一步動作**。
 */
const STATUS_UI: Record<SettlementStatus, { t: string; sub: string; tone: 'wait' | 'act' | 'ok' | 'bad' }> = {
  held: { t: '買家還沒申請', sub: '這張卡還在買家的保管庫，你先不用寄。', tone: 'wait' },
  awaiting_ship: { t: '等你寄出', sub: '買家已經申請出貨，請在期限內寄給他。', tone: 'act' },
  shipped: { t: '你已寄出', sub: '等買家確認收貨；沒確認的話鑑賞期滿也算完成。', tone: 'wait' },
  released: { t: '已入帳', sub: '這筆票金已經變成可動用的點數。', tone: 'ok' },
  refunded: { t: '逾期未寄・已退還買家', sub: '這筆票金退回買家，並記你一次違約。', tone: 'bad' },
  recycled: { t: '買家賣回', sub: '卡回到你手上，這筆票金取消。', tone: 'wait' }
}

/* ---------------- 分組 ---------------- */

const toShip = computed(() => rows.value.filter(r => r.status === 'awaiting_ship'))
const running = computed(() => rows.value.filter(r => r.status === 'held' || r.status === 'shipped'))
const done = computed(() => rows.value.filter(
  r => r.status === 'released' || r.status === 'refunded' || r.status === 'recycled'))

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

/* ---------------- 時限 ---------------- */

/** 這一筆現在在等哪個時限。規則跟後端同一份（shared/pool-settlement） */
function dueOf(r: SellerSettlement) {
  return settlementDeadline({
    id: r.id, status: r.status, createdAt: r.createdAt,
    shipDueAt: r.shipDueAt, shippedAt: r.shippedAt
  })
}
/** 只有「等你寄出」的逾期會有懲罰，所以只有它會變紅；其他時限到了對賣家是好事 */
function toneOf(r: SellerSettlement, at: number): 'ok' | 'warn' | 'danger' {
  if (r.status !== 'awaiting_ship') return 'ok'
  const left = at - now.value
  if (left <= 0) return 'danger'
  return left <= 24 * HOUR ? 'warn' : 'ok'
}

/**
 * 快到期的待出貨。門檻 24 小時。
 *
 * 為什麼要提前警告而不是逾期後才說：逾期的代價是「票金退還買家 + 記一次違約」，
 * 而違約累積 3 次就不能再開新池 —— 那是一個事後補救不了的結果。
 * 事後通知只是通報壞消息，事前通知才有機會避免它。
 */
const urgent = computed(() =>
  toShip.value
    .map(r => ({ r, at: dueOf(r)?.at ?? 0 }))
    .filter(x => x.at - now.value <= 24 * HOUR)
    .sort((a, b) => a.at - b.at))

/* ---------------- 選取與出貨 ---------------- */

/**
 * 已選的 id。用 Set 而不是陣列：一個池賣掉十張是常態，
 * 全選之後每一列都要問「我被選了嗎」，陣列是 O(n) 而 Set 是 O(1)。
 */
const picked = ref(new Set<string>())
const pickedList = computed(() => toShip.value.filter(r => picked.value.has(r.id)))

function toggle(id: string) {
  /* Set 就地改不會觸發 Vue 的反應性追蹤（Vue 3 的 reactive Set 可以，
     但 ref(new Set) 換整個值最保險，也不必去記哪一種容器有攔截器）。 */
  const next = new Set(picked.value)
  next.has(id) ? next.delete(id) : next.add(id)
  picked.value = next
}
const allPicked = computed(() => toShip.value.length > 0 && picked.value.size === toShip.value.length)
function toggleAll() {
  picked.value = allPicked.value ? new Set() : new Set(toShip.value.map(r => r.id))
}

/* 確認面板。scope 是「這次要寄哪幾筆」——
   逐筆與多筆走同一個面板，因為單號與物流商的填法一模一樣，
   分成兩套 UI 只會有兩份會走鐘的文案。 */
const sheet = ref<SellerSettlement[] | null>(null)
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

function openSheet(target: SellerSettlement[]) {
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
 */
async function submitShip() {
  const target = sheet.value
  if (!target || busy.value || trackErr.value) return
  busy.value = true
  shipErr.value = ''
  let okN = 0
  const failed: string[] = []
  for (const r of target) {
    try {
      await api.shipSettlement(r.id, { carrier: carrier.value, tracking: tracking.value.trim() || undefined })
      okN++
    } catch (e) {
      failed.push(`${r.card.name}：${e instanceof Error ? e.message : '失敗'}`)
    }
  }
  busy.value = false
  if (failed.length) shipErr.value = failed.join('；')
  else {
    sheet.value = null
    shipMsg.value = `已標記 ${okN} 筆出貨。買家收到通知了；確認收貨或鑑賞期滿後這幾筆才會入帳。`
  }
  picked.value = new Set()
  await load()          // 重新拉：保留額與階段筆數都要跟著動，本地推算會走鐘
}

/* 底部列只在「待你寄出」這個分頁、而且真的有東西可選時才浮出。
   空列浮在下緣是純粹的遮擋。 */
const barOpen = computed(() => tab.value === 'ship' && toShip.value.length > 0 && !sheet.value)
</script>

<template>
  <div class="container page">
    <header class="head">
      <h1>出貨與結算</h1>
      <p class="muted sub">
        玩家抽到卡，票金先記在你名下但動不了；你寄出、買家確認收貨（或 7 天鑑賞期滿），
        那一筆才變成可動用。逐筆結清，不用等整池抽完。
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
          <span class="ml">保留中</span>
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
    </section>

    <!-- ② 快到期了嗎 -->
    <aside v-if="urgent.length" class="alertBox" role="alert">
      <strong class="at">{{ urgent.length }} 筆快到出貨期限</strong>
      <p class="ap">
        最近的一筆 <b class="mono">{{ remainText(urgent[0]!.at - now) }}</b>。
        逾期系統會把票金退還買家，並記你一次違約；違約滿
        <b class="mono">{{ SELLER_DEFAULT_LIMIT }}</b> 次就不能再開新池。
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

    <div v-if="tab === 'ship' && toShip.length" class="selRow">
      <button type="button" class="btn sm ghost" @click="toggleAll">
        {{ allPicked ? '取消全選' : `全選 ${toShip.length} 筆` }}
      </button>
      <span class="muted selHint">同一個買家的多張卡可以裝一起寄，選起來一次標記。</span>
    </div>

    <p v-if="loading" class="empty muted">載入中…</p>
    <p v-else-if="!list.length" class="empty muted">
      <template v-if="tab === 'ship'">
        <template v-if="!rows.length">
          還沒有人抽到你的池。有人抽走一張卡，這裡就會出現一筆結算。
        </template>
        <template v-else>
          目前沒有要寄的卡。買家申請出貨之後才會出現在這裡 ——
          在那之前卡放在他的保管庫，你不用先寄。
        </template>
      </template>
      <template v-else-if="tab === 'run'">沒有進行中的結算。</template>
      <template v-else>還沒有結束的結算。</template>
    </p>

    <component
      :is="tab === 'ship' ? 'label' : 'article'"
      v-for="r in list" :key="r.id"
      class="row" :class="[STATUS_UI[r.status].tone, { on: picked.has(r.id) }]"
    >
      <div class="rTop" :class="{ withPick: tab === 'ship' }">
        <!-- 待寄的那一疊整塊可點：拇指在手機上點不準一個 20px 的方框 -->
        <input
          v-if="tab === 'ship'" type="checkbox" class="pick"
          :checked="picked.has(r.id)" :aria-label="`選取 ${r.card.name}`"
          @change="toggle(r.id)"
        />
        <CardArt class="thumb" :image="r.card.image" :alt="r.card.name"
                 :cert-no="r.card.certNo" :art-id="r.card.artId" />
        <div class="meta">
          <strong class="nm">{{ r.card.name }}</strong>
          <p class="who">
            寄給 <b>{{ r.buyerName || '買家' }}</b>
            <span v-if="r.buyerMemberNo" class="mono mno">{{ r.buyerMemberNo }}</span>
          </p>
          <p class="src muted">{{ r.poolTitle }} · 票金 <b class="mono">{{ r.amount.toLocaleString() }}</b> 點</p>
        </div>
        <span class="stTag" :class="STATUS_UI[r.status].tone">{{ STATUS_UI[r.status].t }}</span>
      </div>

      <p class="sSub muted">{{ STATUS_UI[r.status].sub }}</p>

      <div v-if="dueOf(r)" class="due" :class="toneOf(r, dueOf(r)!.at)">
        <div class="dueTop">
          <span>{{ dueOf(r)!.label }}</span>
          <strong class="mono">{{ remainText(dueOf(r)!.at - now) }}</strong>
        </div>
        <p>{{ dueOf(r)!.then }}</p>
      </div>

      <!-- 逐筆出貨：選一筆再按底部列也做得到，但「我現在就要處理這一筆」
           是最常見的動作，不該逼人先進選取模式 -->
      <div v-if="r.status === 'awaiting_ship'" class="acts">
        <button type="button" class="btn primary sm" @click.prevent="openSheet([r])">
          只標記這筆已出貨
        </button>
      </div>
    </component>

    <!-- 多筆的操作列。定位、讓位、進出場動畫都在 BottomActionBar 裡
         （Teleport 到 body：祖先有 transform 會變成 fixed 的定位基準）。 -->
    <BottomActionBar :open="barOpen" label="出貨" :spacer="104" :max-width="560">
      <div class="shipBar">
        <span class="sbInfo" role="status">
          <strong>已選 <span class="mono">{{ pickedList.length }}</span> 筆</strong>
          <span class="mono sbSub">票金 {{ pickedList.reduce((a, r) => a + r.amount, 0).toLocaleString() }} 點</span>
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
            <li v-for="r in sheet" :key="r.id">
              <span class="shNm">{{ r.card.name }}</span>
              <span class="muted">→ {{ r.buyerName || '買家' }}</span>
            </li>
          </ul>

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
            按下去之後這幾筆的鑑賞期開始跑，買家會收到通知。
            <b>出貨不等於入帳</b>：要等買家確認收貨或 7 天鑑賞期滿。
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
.ml { display: block; font-size: 11.5px; color: var(--muted); margin-bottom: 2px; }
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

/* ---- 警告 ---- */
.alertBox {
  margin-top: 12px; padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--warn-wash); box-shadow: inset 2px 0 0 var(--warn);
}
.at { display: block; font-size: 14px; color: var(--warn-ink); }
.ap { font-size: 12.5px; line-height: 1.75; margin: 4px 0 0; color: var(--text); }
.alertBox .btn.sm { margin-top: 10px; }

.okLine {
  margin: 12px 0 0; padding: 10px 12px;
  font-size: 12.5px; line-height: 1.7;
  border-radius: var(--radius);
  background: var(--ok-wash); color: var(--ok-ink);
}
.errLine { color: var(--danger); font-size: 13px; line-height: 1.7; margin: 12px 0 0; }
.errLine .btn.sm { margin-left: 8px; padding: 4px 10px; font-size: 12px; }

/* ---- 清單 ---- */
.tabs { display: flex; gap: 8px; margin: 16px 0 10px; flex-wrap: wrap; }
.selRow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.selHint { font-size: 11.5px; line-height: 1.6; min-width: 0; }
.empty { padding: 26px 4px; font-size: 13.5px; line-height: 1.9; }

.row {
  display: block;
  background: var(--surface); border-radius: var(--radius-lg);
  padding: 14px; margin-bottom: 10px;
  border: 1px solid transparent;
}
/* label 版整塊可點，所以要有按下去的回饋 */
label.row { cursor: pointer; }
.row.on { border-color: var(--accent); background: var(--accent-wash); }

/* 欄位定義要跟著「有沒有勾選框」換一組。
   不能只靠 auto 讓它自己收掉：grid 是照**位置**配欄的，少一個子元素時
   卡圖會掉進第一欄、文字掉進 52px 那一欄，整列擠成一條。實測過。 */
.rTop { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; gap: 10px; align-items: start; }
.rTop.withPick { grid-template-columns: auto 52px minmax(0, 1fr) auto; }
.pick { width: 20px; height: 20px; margin: 2px 0 0; flex: none; accent-color: var(--accent); }
.thumb { width: 52px; height: 73px; border-radius: 6px; overflow: hidden; }
.thumb :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.meta { min-width: 0; }
.nm { display: block; font-size: 14.5px; line-height: 1.4; margin-bottom: 3px; overflow-wrap: anywhere; }
.who { font-size: 12px; margin: 0 0 2px; overflow-wrap: anywhere; }
.mno { font-size: 11px; color: var(--muted); margin-left: 6px; }
.src { font-size: 11.5px; line-height: 1.6; margin: 0; overflow-wrap: anywhere; }
.stTag {
  font-size: 10.5px; font-weight: 700; white-space: nowrap;
  padding: 4px 9px; border-radius: var(--pill);
  background: var(--surface-3); color: var(--muted);
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

.acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.acts .btn.sm, .selRow .btn.sm { padding: 8px 14px; font-size: 13px; }

/* ---- 底部列 ---- */
.shipBar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
.sbInfo { display: grid; gap: 1px; min-width: 0; }
.sbInfo strong { font-size: 14px; }
.sbSub { font-size: 11.5px; color: var(--muted); }

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
.shList { list-style: none; padding: 0; margin: 0 0 14px; display: grid; gap: 5px; }
.shList li { display: flex; gap: 6px; font-size: 12.5px; min-width: 0; flex-wrap: wrap; }
.shNm { overflow-wrap: anywhere; }

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
.fRow { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.fRow .btn.sm { padding: 9px 16px; font-size: 13px; }

.fine { font-size: 11.5px; line-height: 1.7; margin-top: 20px; }
</style>
