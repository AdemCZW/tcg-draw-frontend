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
      <h1>交易邀約</h1>
      <p class="muted sub">私下換卡的出價都在這裡。接受之後點數與卡片會立刻移轉，不可還原。</p>
    </header>

    <div class="tabs" role="tablist">
      <button
        v-for="t in TABS" :key="t.k"
        type="button" role="tab" :aria-selected="tab === t.k"
        class="chip" :class="{ on: tab === t.k }"
        @click="switchTab(t.k)"
      >
        {{ t.label }}<span v-if="t.k === 'incoming' && pendingIn" class="n">{{ pendingIn }}</span>
      </button>
      <button type="button" class="chip refresh" :disabled="loading" @click="load">
        {{ loading ? '更新中…' : '重新整理' }}
      </button>
    </div>

    <p v-if="okMsg" class="ok" role="status">{{ okMsg }}</p>
    <p v-if="err" class="err" role="alert">{{ err }}</p>

    <p v-if="loading && !list.length" class="empty muted">載入中…</p>
    <p v-else-if="!list.length" class="empty muted">
      <template v-if="tab === 'incoming'">
        還沒有人對你的卡出價。把卡冊設成公開分享出去，別人才找得到你的卡。
      </template>
      <template v-else>
        你還沒有送出任何邀約。在別人的公開卡冊裡看到想要的卡，就可以出價換。
      </template>
    </p>

    <article v-for="o in list" :key="o.id" class="ofr">
      <div class="top">
        <div class="meta">
          <strong class="nm">{{ o.card?.name || o.prize_id }}</strong>
          <p class="who">
            <span class="role">{{ tab === 'incoming' ? '出價者' : '持卡人' }}</span>
            {{ counterpart(o) }}
          </p>
        </div>
        <span class="st" :class="o.status">{{ STATUS_TEXT[o.status] }}</span>
      </div>

      <p class="amt mono">{{ fmtPts(o.points) }} 點</p>
      <p v-if="o.message" class="msg">「{{ o.message }}」</p>
      <p class="when">
        {{ fmtWhen(o.created_at) }} 送出<span v-if="o.responded_at"> · {{ fmtWhen(o.responded_at) }} 回覆</span>
      </p>

      <!-- 收到的、還在等回覆：可以接受或婉拒 -->
      <div v-if="tab === 'incoming' && o.status === 'pending'" class="acts">
        <button
          type="button" class="btn sm" :disabled="busy === o.id"
          @click="decline(o, false)"
        >婉拒</button>
        <button
          type="button" class="btn sm" :class="{ armed: confirming === o.id }" :disabled="busy === o.id"
          @click="confirming = confirming === o.id ? null : o.id"
        >接受</button>
      </div>

      <!-- 第二段：點了「接受」才出現。這裡才是真的會動錢的那一顆 -->
      <div v-if="confirming === o.id" class="confirm">
        <p>
          接受後 <strong class="mono">{{ fmtPts(o.points) }}</strong> 點會入帳，
          「{{ o.card?.name || o.prize_id }}」會過戶給 {{ counterpart(o) }}。這個動作沒有還原鍵。
        </p>
        <div class="crow">
          <button type="button" class="btn sm" :disabled="busy === o.id" @click="confirming = null">取消</button>
          <button type="button" class="btn primary sm" :disabled="busy === o.id" @click="accept(o)">
            {{ busy === o.id ? '處理中…' : '確認接受' }}
          </button>
        </div>
      </div>

      <!-- 送出的、還在等回覆：可以收回。走的是同一支 decline -->
      <div v-if="tab === 'outgoing' && o.status === 'pending'" class="acts">
        <button
          type="button" class="btn sm" :disabled="busy === o.id"
          @click="decline(o, true)"
        >{{ busy === o.id ? '處理中…' : '收回邀約' }}</button>
      </div>
    </article>
  </div>
</template>

<style scoped>
/* 底部導覽的讓位交給頁尾（見 App.vue），這裡只留自己的排版留白 */
.page { padding-bottom: 48px; }
.head { margin-bottom: 14px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { font-size: 13px; line-height: 1.7; margin: 0; }

.tabs { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
.chip { min-height: 36px; }
.chip.on { background: var(--accent); color: #fff; font-weight: 600; }
.chip.refresh { margin-left: auto; color: var(--muted); }
.chip:disabled { opacity: .5; }
/* 待回覆數：只有收件匣有，因為只有那邊是「等你動作」 */
.n {
  min-width: 18px; padding: 0 5px; border-radius: var(--pill);
  background: var(--accent); color: #fff;
  font-size: 11px; font-weight: 700; line-height: 18px; text-align: center;
}
.chip.on .n { background: rgba(255, 255, 255, .28); }

.empty { padding: 30px 4px; font-size: 14px; line-height: 1.9; }
.ok { color: var(--ok); font-size: 13.5px; line-height: 1.7; margin: 0 0 12px; }
.err { color: var(--danger); font-size: 13.5px; line-height: 1.7; margin: 0 0 12px; }

.ofr { background: var(--surface); border-radius: var(--radius-lg); padding: 14px 16px; margin-bottom: 12px; }
.top { display: flex; align-items: flex-start; gap: 10px; }
.meta { flex: 1; min-width: 0; }
.nm { display: block; font-size: 15px; line-height: 1.4; margin-bottom: 4px; }
.who { font-size: 12px; color: var(--muted); margin: 0; }
.role {
  display: inline-block; font-size: 10px; font-weight: 700;
  padding: 1px 6px; border-radius: var(--pill); margin-right: 5px;
  background: var(--surface-3); color: var(--muted);
}
.st {
  font-size: 11px; font-weight: 700; white-space: nowrap;
  padding: 4px 9px; border-radius: var(--pill);
  background: var(--surface-3); color: var(--muted);
}
.st.pending { background: var(--warn-wash); color: var(--warn); }
.st.accepted { background: var(--ok-wash); color: var(--ok); }

/* 金額是這張卡最重要的一行，字級拉開才不用讀完全部才知道對方出多少 */
.amt { font-size: 19px; font-weight: 600; margin: 10px 0 0; color: var(--gold); }
.msg { font-size: 13px; line-height: 1.7; color: var(--ink); margin: 8px 0 0; }
.when { font-size: 11.5px; color: var(--faint); margin: 6px 0 0; }

.acts { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.acts .btn.sm, .crow .btn.sm { padding: 9px 18px; font-size: 13.5px; }
/* 已展開確認條時，第一顆維持「按下去了」的樣子，不然看不出來下面那塊是它開的 */
.btn.armed { border-color: var(--accent); color: var(--accent); }

.confirm {
  margin-top: 10px; padding: 12px;
  border-radius: var(--radius);
  background: var(--danger-wash);
  /* 側邊一道紅：這一區跟上面的資訊不同性質，是「你正要做一件不可逆的事」 */
  box-shadow: inset 2px 0 0 var(--danger);
}
.confirm p { font-size: 12.5px; line-height: 1.75; color: var(--ink); margin: 0 0 10px; }
.crow { display: flex; gap: 8px; justify-content: flex-end; }
</style>
