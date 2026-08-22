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
const err = ref('')
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
  const t = typeof v === 'number' ? v : Date.parse(v)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const fmtPts = (n: number) => n.toLocaleString('zh-TW')

async function load() {
  loading.value = true
  err.value = ''
  try {
    const r = await offers.list()
    incoming.value = r.incoming
    outgoing.value = r.outgoing
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : '連線失敗'
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

    <p v-if="loading && !list.length" class="blank muted">載入中…</p>
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
/* 純文字鍵：它不該有跟分頁一樣的膠囊外框，不然又變成一個可切換的東西 */
.rf {
  flex: none; padding: 4px 0;
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
  min-width: 0; min-height: 34px; padding: 0 10px;
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
.acts .btn { min-width: 0; padding: 7px 14px; font-size: 13px; min-height: 38px; }

/* 桌機：邀約是清單資料，拉滿 1180px 會變成一排超寬空盒 */
@media (min-width: 721px) {
  .page { max-width: 720px; }
  /* 桌機不需要撐滿的按鈕：手機的滿版是為了拇指，滑鼠不吃這一套 */
  .acts { grid-template-columns: repeat(2, minmax(0, 150px)); justify-content: start; }
}
</style>
