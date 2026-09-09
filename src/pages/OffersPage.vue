<script setup lang="ts">
/**
 * 交易邀約收發匣。
 *
 * 收到的與送出的放在同一頁的兩個分頁，不拆成兩條路由：一筆邀約的兩端是同一件事，
 * 使用者常常是「回完別人的、順手看自己送出的有沒有下文」。
 *
 * 接受是不可逆的資金動作 —— 點數會實際移轉、卡片會過戶，沒有還原鍵。
 * 所以按鈕做成兩段：先點「接受」只是展開確認條，真正送出的是第二顆。
 * 這個做法跟後台的爭議裁決一致（ConsoleDisputes.vue），理由也一樣：
 * 手機上單顆按鈕太容易被拇指擦到，而這種誤觸賠不起。
 * 婉拒／收回維持一段 —— 它不會動到錢，而且對方還可以再出一次價。
 */
import { computed, onMounted, ref } from 'vue'
import { offers, type OfferStatus, type TradeOffer } from '@/lib/social'
import { ApiError } from '@/lib/http'

/* 分頁定義放 script：模板裡不能寫型別註記（`as { k: Tab }[]` 會解析失敗） */
type Tab = 'incoming' | 'outgoing'
const TABS: { k: Tab; label: string }[] = [
  { k: 'incoming', label: '收到的' },
  { k: 'outgoing', label: '送出的' }
]
const tab = ref<Tab>('incoming')

const STATUS_TEXT: Record<OfferStatus, string> = {
  pending: '等待回覆',
  accepted: '已成立',
  declined: '已婉拒',
  cancelled: '已收回'
}

const incoming = ref<TradeOffer[]>([])
const outgoing = ref<TradeOffer[]>([])
const loading = ref(false)
/** 動作（接受／婉拒／收回）失敗的訊息。它講的是「剛剛那一下沒成功」 */
const err = ref('')
/**
 * 清單本身載入失敗的訊息。跟 err 分開記。
 *
 * 合在一起的時候畫面會同時出現「連線失敗」跟「還沒有人對你的卡出價」——
 * 錯誤態被畫成空狀態，而這兩句對使用者是完全相反的意思：一句是「問不到」，
 * 一句是「問到了，答案是沒有」。剛收到出價通知的人看到後者只會以為出價被撤了。
 * 分開之後空狀態只在真的載入成功且是 0 筆時才畫。
 * 版型沿用錢包頁的載入失敗卡（訊息＋重試鈕），不另外發明一種錯誤態。
 */
const loadErr = ref('')
const okMsg = ref('')
/** 正在送出的那一筆，用來鎖住該列的按鈕（不是全頁鎖：其他筆還是可以看） */
const busy = ref<string | null>(null)
/** 展開了確認條的那一筆。同時只會有一筆，展開別筆就把前一筆收起來 */
const confirming = ref<string | null>(null)

const list = computed(() => (tab.value === 'incoming' ? incoming.value : outgoing.value))
const pendingIn = computed(() => incoming.value.filter(o => o.status === 'pending').length)

/** 對方是誰：收件匣看寄件人、寄件匣看收件人。名字沒帶回來就退回 user id，不要留空白 */
const counterpart = (o: TradeOffer) =>
  tab.value === 'incoming' ? (o.from_name || o.from_user) : (o.to_name || o.to_user)

/** 邀約的時間點是「多久以前發生的」，但它牽涉金額，所以仍給到分鐘的絕對時間 */
function fmtWhen(v: string | number | null): string {
  if (v === null) return ''
  /* created_at 是 bigint，postgres.js 會以**字串**回傳（"1757…"），
     Date.parse 吃不下那種字串會回 NaN，整行時間就無聲消失，只剩一個「送出」。
     純數字字串先當毫秒時間戳；其他字串（mock 的 ISO 日期）才交給 Date.parse。 */
  const t = typeof v === 'number' ? v : /^\d+$/.test(v) ? Number(v) : Date.parse(v)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const fmtPts = (n: number) => n.toLocaleString('zh-TW')

/* ── 寄存剩餘天數（D-2）────────────────────────────────────────────────
   為什麼這一頁非講不可：邀約成交走的是庫內轉移，只換擁有者、不搬實體卡，
   所以 prizes.stash_expires_at **不會重新計算**。出價方換到手的可能是一張
   明天就到期的卡，而到期之後系統會自動替他申請出貨（把實體卡從保管人
   那裡寄到他留的地址）—— 有真實後果，不是一則可以滑掉的提醒。

   ── 為什麼不照抄 MarketListingPage 那一套 ──────────────────────────
   那頁是一張卡的細節頁：資訊塊在頁面流裡、可能被捲過去，所以要在購買
   確認列裡再講一次。這頁不一樣，兩處都不一樣：

   1 它是列表。每一列都是一張卡，一列塞一段四行說明就沒有人讀得完。
     所以「還很久」只給一行淡字，「快到期」才升級成整塊警示 ——
     資訊密度跟它的後果成正比。
   2 它有兩種讀者，而且立場相反。收件匣那張卡是**我的**（我要交出去），
     寄件匣那張卡是**別人的**（我要換進來）。同一個天數對兩邊的意思不同：
     一邊是「對方接手剩下的」，另一邊是「我接手剩下的、而且到期會自動
     寄到我這裡」。所以文案照分頁分岔，不共用一句。
   3 出價方**沒有確認步驟**可以再講一次 —— 按下接受的是持卡人。
     出價方在這一頁能做的只有收回，所以那句話必須留在列身上。
     反過來，接受才是這一頁唯一不可逆的動作，確認條那一句就只給收件匣。 */

/** 跟後端寄存提醒的 STASH_WARN_MS、以及市場頁的門檻同一個值 */
const STASH_WARN_DAYS = 14
const urgent = (o: TradeOffer) => !!o.stash && o.stash.daysLeft <= STASH_WARN_DAYS
/** 過期用負數表示，所以「剩 -3 天」要翻成「已經過了 3 天」 */
const stashLabel = (o: TradeOffer) => {
  const d = o.stash?.daysLeft ?? 0
  return d <= 0 ? `寄存期限已經過了 ${-d} 天` : `寄存期限剩 ${d} 天`
}
/** 快到期時多給的那一句。收件匣講對方接手，寄件匣講自己接手＋自動出貨 */
const stashWhy = (o: TradeOffer) => {
  const total = o.stash?.totalDays ?? 90
  if (tab.value === 'incoming') {
    /* 持卡人看的是自己的卡，卡在誰手上他本來就知道，不必再講一次。
       heldByOther 的定義是「有沒有人在保管」（跟市場端點同一個定義），
       不是「保管人是不是你」—— 拿它在這一側寫「還在保管人手上」，
       遇到保管人就是持卡人自己的情況會講錯話，所以這一側乾脆不用它。 */
    return `寄存期是抽中之日起 ${total} 天，過戶不會重新計算 —— 對方接手的是剩下的天數。`
  }
  /* 出價方看的是別人的卡：有人在保管 ＝ 換到手實體卡不會跟著過來，
     這句話對他才是新資訊 */
  const held = o.stash?.heldByOther ? '實體卡還在保管人手上，' : ''
  return `${held}寄存期是抽中之日起 ${total} 天，換到手不會重新計算 —— 你接手的是剩下的天數。`
    + '期限到了系統會自動替你申請出貨，記得先把「我的資料」的收件資料填齊。'
}

async function load() {
  loading.value = true
  err.value = ''
  loadErr.value = ''
  try {
    const r = await offers.list()
    incoming.value = r.incoming
    outgoing.value = r.outgoing
  } catch (e) {
    loadErr.value = e instanceof ApiError ? e.message : '連線失敗'
  } finally {
    loading.value = false
  }
}
onMounted(load)

/** 成功訊息自己退場：這頁會停留一陣子，訊息留著會被誤讀成「最新狀態」 */
let flashTimer: number | undefined
function flash(m: string) {
  okMsg.value = m
  clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => { okMsg.value = '' }, 4000)
}

async function accept(o: TradeOffer) {
  busy.value = o.id
  err.value = ''
  try {
    await offers.accept(o.id)
    confirming.value = null
    flash(`已接受 ${counterpart(o)} 的邀約，${fmtPts(o.points)} 點與卡片已完成移轉。`)
    await load()
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : '連線失敗'
  } finally {
    busy.value = null
  }
}

/** 同一支 API：收到的人按是婉拒、送出的人按是收回，由後端依身分判斷 */
async function decline(o: TradeOffer, mine: boolean) {
  busy.value = o.id
  err.value = ''
  try {
    await offers.decline(o.id)
    confirming.value = null
    flash(mine ? '已收回這筆邀約。' : '已婉拒這筆邀約。')
    await load()
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : '連線失敗'
  } finally {
    busy.value = null
  }
}

function switchTab(k: Tab) {
  tab.value = k
  // 換分頁把展開中的確認條收掉：切回來時看到一個已經展開的「確認接受」很可怕
  confirming.value = null
}
</script>


<template>
  <div class="container page">
    <header class="head">
      <div class="hrow">
        <h1>交易邀約</h1>
        <!-- 重新整理是動作不是視角，放回標題列才不會被當成第三個分頁 -->
        <button type="button" class="rf" :disabled="loading" @click="load">
          {{ loading ? '更新中…' : '重新整理' }}
        </button>
      </div>
      <p class="muted sub">私下換卡的出價都在這裡。接受之後點數與卡片會立刻移轉，不可還原。</p>
    </header>

    <!-- 兩個分頁做成一條軌道上的雙格：只有「二選一」才長這樣，不會再多出一格 -->
    <div class="seg" role="tablist">
      <button
        v-for="t in TABS" :key="t.k"
        type="button" role="tab" :aria-selected="tab === t.k"
        class="sg" :class="{ on: tab === t.k }"
        @click="switchTab(t.k)"
      >
        {{ t.label }}<span v-if="t.k === 'incoming' && pendingIn" class="n">{{ pendingIn }}</span>
      </button>
    </div>

    <p v-if="okMsg" class="ok" role="status">{{ okMsg }}</p>
    <p v-if="err" class="err" role="alert">{{ err }}</p>
    <!-- 手上還有舊資料時，載入失敗只降級成一行提示：把已經讀得到的邀約
         換成一張錯誤卡，等於因為重新整理失敗就把人看得到的東西收走 -->
    <p v-if="loadErr && list.length" class="err" role="alert">{{ loadErr }}</p>

    <!-- 讀不到就說讀不到，不畫成空清單。順序在空狀態之前，兩者互斥 -->
    <div v-if="loadErr && !list.length" class="loadFail card" role="alert">
      <p class="muted">{{ loadErr }}</p>
      <button type="button" class="btn" :disabled="loading" @click="load">
        {{ loading ? '重試中…' : '重試' }}
      </button>
    </div>
    <p v-else-if="loading && !list.length" class="blank muted">載入中…</p>
    <p v-else-if="!list.length" class="blank muted">
      <template v-if="tab === 'incoming'">
        還沒有人對你的卡出價。把卡冊設成公開分享出去，別人才找得到你的卡。
      </template>
      <template v-else>
        你還沒有送出任何邀約。在別人的公開卡冊裡看到想要的卡，就可以出價換。
      </template>
    </p>

    <article
      v-for="o in list" :key="o.id"
      class="ofr" :class="{ armed: confirming === o.id }"
    >
      <div class="r1">
        <strong class="nm">{{ o.card?.name || o.prize_id }}</strong>
        <span class="st" :class="o.status">{{ STATUS_TEXT[o.status] }}</span>
      </div>

      <!-- 「多少錢／誰出的」擠同一行：這兩件事要一起讀才有意義，拆兩行反而要對照 -->
      <p class="r2">
        <span class="amt mono">{{ fmtPts(o.points) }}</span><span class="unit">點</span>
        <span class="who">{{ tab === 'incoming' ? '出價者' : '持卡人' }} {{ counterpart(o) }}</span>
      </p>

      <!-- 寄存剩餘天數。位置在金額正下方、動作列上方：出價方要換的是這張卡的
           剩餘天數，那是跟金額同一層的決策資訊，不是註腳。
           只畫還在等回覆的那幾筆 —— 已回應的是歷史，那張卡的時鐘由卡冊負責，
           在這裡再倒數一次只會讓人以為還能做什麼。 -->
      <p
        v-if="o.stash && o.status === 'pending'"
        class="stash" :class="urgent(o) ? 'urgent' : 'calm'"
      >
        <span class="sTag">{{ stashLabel(o) }}</span>
        <!-- 還很久的不解釋：一行淡字就夠了。快到期才值得佔掉一列的高度 -->
        <span v-if="urgent(o)" class="sWhy">{{ stashWhy(o) }}</span>
      </p>

      <p v-if="o.message" class="msg">「{{ o.message }}」</p>
      <p class="when">
        {{ fmtWhen(o.created_at) }} 送出<span v-if="o.responded_at"> · {{ fmtWhen(o.responded_at) }} 回覆</span>
      </p>

      <!-- 收到的、還在等回覆：動作列與確認列共用同一個位置。
           確認不另開一塊巢狀卡片 —— 那會讓一筆邀約看起來像兩筆，也把下一筆推很遠。
           改成就地換掉這一列，並讓整張卡描一圈紅來表示「這張正在待確認」。 -->
      <div v-if="tab === 'incoming' && o.status === 'pending'" class="foot">
        <template v-if="confirming === o.id">
          <p class="cfm">
            接受後 <strong class="mono">{{ fmtPts(o.points) }}</strong> 點會入帳，
            「{{ o.card?.name || o.prize_id }}」會過戶給 {{ counterpart(o) }}。這個動作沒有還原鍵。
            <!-- 快到期的話在按下確定的那一刻再講一次。理由同市場頁：上面那一塊
                 可能被捲過去，這一句跟金額在同一段話裡，躲不掉。
                 只有收件匣有這一段 —— 這一頁唯一不可逆的動作就是接受。 -->
            <span v-if="urgent(o)" class="cfmStash">
              這張卡的{{ stashLabel(o) }}，過戶不會重新計算 —— {{ counterpart(o) }} 接手的是剩下的天數。
            </span>
          </p>
          <div class="acts">
            <button type="button" class="btn sm" :disabled="busy === o.id" @click="confirming = null">取消</button>
            <button type="button" class="btn primary sm" :disabled="busy === o.id" @click="accept(o)">
              {{ busy === o.id ? '處理中…' : '確認接受' }}
            </button>
          </div>
        </template>
        <div v-else class="acts">
          <button type="button" class="btn sm" :disabled="busy === o.id" @click="decline(o, false)">婉拒</button>
          <button type="button" class="btn sm" :disabled="busy === o.id" @click="confirming = o.id">接受</button>
        </div>
      </div>

      <!-- 送出的、還在等回覆：可以收回。走的是同一支 decline -->
      <div v-if="tab === 'outgoing' && o.status === 'pending'" class="foot">
        <div class="acts one">
          <button type="button" class="btn sm" :disabled="busy === o.id" @click="decline(o, true)">
            {{ busy === o.id ? '處理中…' : '收回邀約' }}
          </button>
        </div>
      </div>
    </article>
  </div>
</template>

<style scoped>
/* 底部導覽的讓位交給頁尾（見 App.vue），這裡只留自己的排版留白 */
.page { padding-bottom: 32px; }

.head { margin-bottom: 12px; }
.hrow { display: flex; align-items: baseline; gap: 12px; }
h1 { font-size: 22px; margin: 0; flex: 1; min-width: 0; }
/* 純文字鍵：它不該有跟分頁一樣的膠囊外框，不然又變成一個可切換的東西。
   沒有外框不等於可以小 —— 它不是 .btn，吃不到 base.css 那條 44px，
   原本整顆只有 25px 高。用 min-height 撐開命中範圍，底線仍然貼著文字走
   （inline-flex + align-items: center），所以看起來沒變、按起來變準。 */
.rf {
  flex: none; padding: 4px 0;
  display: inline-flex; align-items: center; min-height: 44px;
  font-size: 12.5px; color: var(--muted);
  background: none; border: 0;
  text-decoration: underline; text-underline-offset: 3px;
  text-decoration-color: var(--line);
}
.rf:disabled { opacity: .5; }
.sub { font-size: 12.5px; line-height: 1.6; margin: 4px 0 0; }

/* 分頁：一條軌道切兩格。滑塊靠 .on 的實色底表現，不另外做動畫層 */
.seg {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px; padding: 4px; margin-bottom: 12px;
  background: var(--surface-2); border-radius: var(--pill);
}
.sg {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  /* 44px 是專案硬規定的觸控目標下限。這兩格是真的要按的分頁，
     而 .sg 不是 .btn，吃不到 base.css 那條規則 —— 訂單頁的同款分頁
     （OrdersPage 的 .tabs .chip）也是這樣各自撐開的。 */
  min-width: 0; min-height: 44px; padding: 0 10px;
  border: 0; border-radius: var(--pill);
  background: transparent; color: var(--muted);
  font-size: 13.5px; font-weight: 600;
}
.sg.on { background: var(--accent); color: var(--on-accent); }
/* 待回覆數：只有收件匣有，因為只有那邊是「等你動作」 */
.n {
  min-width: 17px; padding: 0 5px; border-radius: var(--pill);
  background: var(--surface-3); color: var(--ink);
  font-size: 11px; font-weight: 700; line-height: 17px; text-align: center;
}
.sg.on .n { background: rgba(255, 255, 255, .28); color: var(--on-accent); }

.blank {
  margin: 0; padding: 22px 18px;
  background: var(--surface); border-radius: var(--radius);
  font-size: 13px; line-height: 1.8; text-align: center;
}
.ok { color: var(--ok); font-size: 13px; line-height: 1.6; margin: 0 0 10px; }
.err { color: var(--danger); font-size: 13px; line-height: 1.6; margin: 0 0 10px; }

/* 載入失敗：跟錢包頁同一套（訊息置中＋一顆重試鈕）。
   min-width: 0 讓長訊息不撐破容器。 */
.loadFail {
  min-width: 0;
  display: grid; justify-items: center; gap: 12px;
  padding: 32px 16px; text-align: center;
}
.loadFail p { margin: 0; }

.ofr {
  background: var(--surface); border-radius: var(--radius);
  padding: 12px 14px; margin-bottom: 8px;
  /* 描邊常駐但透明：待確認時只換顏色，卡片不會因為多出一圈邊而抖動 */
  border: 1px solid transparent;
}
.ofr.armed { border-color: var(--danger); background: var(--danger-wash); }

.r1 { display: flex; align-items: center; gap: 8px; }
.nm { flex: 1; min-width: 0; font-size: 14.5px; line-height: 1.35; }
.st {
  flex: none; font-size: 10.5px; font-weight: 700; white-space: nowrap;
  padding: 3px 8px; border-radius: var(--pill);
  background: var(--surface-3); color: var(--muted);
}
.st.pending { background: var(--warn-wash); color: var(--warn-ink); }
.st.accepted { background: var(--ok-wash); color: var(--ok-ink); }

/* 金額與出價者同一行、共用基線：金額是主詞，人名退成註腳 */
.r2 { display: flex; align-items: baseline; gap: 4px; margin: 3px 0 0; }
.amt { flex: none; font-size: 20px; font-weight: 600; color: var(--gold); letter-spacing: -.01em; }
.unit { flex: none; font-size: 12px; color: var(--gold-deep); }
.who {
  flex: 1; min-width: 0; margin-left: 4px;
  font-size: 12px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* 寄存剩餘天數。兩種樣式差在**份量**不只是顏色：
   還很久（calm）是一行淡字，不佔背景、不撐高列高，因為它不是新聞；
   快到期（urgent）升成一整塊警示底，因為它會改變出價方的決定。 */
.stash { margin: 5px 0 0; font-size: 12px; line-height: 1.55; }
.stash.calm { color: var(--muted); }
.stash.urgent {
  padding: 7px 9px; border-radius: 10px;
  background: var(--warn-wash); color: var(--warn-ink);
}
.sTag { font-weight: 700; }
/* 說明另起一行：跟天數擠同一行的話，手機上會被折成很難讀的參差兩段 */
.sWhy { display: block; margin-top: 2px; font-weight: 400; line-height: 1.6; }
.stash.urgent .sWhy { color: color-mix(in srgb, var(--warn-ink) 80%, var(--muted)); }
/* 確認條裡的那一句：跟著金額走，不另開一塊 */
.cfmStash { display: block; margin-top: 4px; color: var(--warn-ink); font-weight: 600; }

/* 留言可能很長，但它不是決策依據 —— 收成兩行，要看全文再點進對話 */
.msg {
  margin: 5px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--muted);
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
}
.when { font-size: 11px; color: var(--faint); margin: 3px 0 0; }

/* 動作列與資訊之間一道細線：靠分隔而不是靠空白，省下的是每一筆的高度 */
.foot { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line-soft); }
.cfm { font-size: 12px; line-height: 1.6; color: var(--ink); margin: 0 0 8px; }
/* 兩顆各佔一半、切齊卡片內容的左右邊 —— 靠右浮著會讓視線橫跨整張卡 */
.acts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
/* 只有一顆時不撐滿：收回是低頻動作，不該長得跟主要動作一樣大 */
.acts.one { grid-template-columns: minmax(0, auto); justify-content: start; }
/* 44px 是拇指的最小可靠命中高度；這一列旁邊現在多了警示塊，
   按錯「接受」的代價又是不可逆的過戶，不能再省這 6px */
.acts .btn { min-width: 0; padding: 7px 14px; font-size: 13px; min-height: 44px; }

/* 桌機：邀約是清單資料，拉滿 1180px 會變成一排超寬空盒 */
@media (min-width: 721px) {
  .page { max-width: 720px; }
  /* 桌機不需要撐滿的按鈕：手機的滿版是為了拇指，滑鼠不吃這一套 */
  .acts { grid-template-columns: repeat(2, minmax(0, 150px)); justify-content: start; }
}
</style>
