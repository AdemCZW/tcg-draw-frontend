<script setup lang="ts">
/**
 * 平台後台。
 *
 * 只有 users.role = 'admin' 進得來（路由守衛擋一層，後端每個端點再擋一層——
 * 前端的檢查只是為了不要讓人看到一個按了全是錯誤的畫面，真正的權限在後端）。
 *
 * 分頁而不是一頁到底：這四件事的使用時機完全不同（發點數是日常、審賣家是偶爾、
 * 爭議是急件、稽核是事後追查），擠在同一個捲軸裡每次都要找。
 */
import { computed, onMounted, ref } from 'vue'
import { http, ApiError } from '@/lib/http'

type Tab = 'overview' | 'users' | 'sellers' | 'disputes' | 'audit'
const tab = ref<Tab>('overview')

/* 分頁清單放這裡不放模板：模板的表達式不吃型別註記，
   寫成 `as { k: Tab }[]` 會直接解析失敗 */
const TABS: { k: Tab; label: string }[] = [
  { k: 'overview', label: '總覽' },
  { k: 'users', label: '使用者 · 發點數' },
  { k: 'sellers', label: '賣家' },
  { k: 'disputes', label: '爭議' },
  { k: 'audit', label: '稽核' }
]

const loading = ref(false)
const err = ref('')
const okMsg = ref('')

interface Overview {
  users: number; users_7d: number; sellers_pending: number
  pools_open: number; orders_open: number; orders_disputed: number
  escrowed_points: string; points_outstanding: string
}
const overview = ref<Overview | null>(null)

interface AdminUser { id: string; handle: string; name: string; email: string | null; role: string; created_at: string }
const users = ref<AdminUser[]>([])
const q = ref('')

interface Seller {
  id: string; handle: string; name: string; origin: string; tier: string
  joined_at: string; pools_run: number; faults: number; pending_docs: number
}
const sellers = ref<Seller[]>([])

interface Dispute {
  id: string; card: { name?: string }; price: number; deposit: number
  buyer_name: string; seller_name: string; disputed_at: string
  dispute_reason: string | null; has_unboxing_video: boolean | null; tracking: string | null
}
const disputes = ref<Dispute[]>([])

interface Action { id: number; admin_id: string; action: string; target: string | null; note: string; created_at: string }
const actions = ref<Action[]>([])

/* 發點數。金流還沒接，這是目前唯一能讓真實使用者拿到點數的路徑。 */
const grantTo = ref<AdminUser | null>(null)
const grantPoints = ref<number>(1000)
const grantNote = ref('')
const grantBusy = ref(false)
const canGrant = computed(() =>
  !!grantTo.value && grantPoints.value > 0 && grantNote.value.trim().length >= 2
)

/* 看某個人的錢包與帳本 */
const walletOf = ref<{ user: AdminUser; wallet: { points: number; locked: number; available: number }; ledger: LedgerRow[] } | null>(null)
interface LedgerRow { id: number; delta: number; reason: string; ref_id: string | null; created_at: string }

async function guard<T>(fn: () => Promise<T>): Promise<T | null> {
  loading.value = true
  err.value = ''
  try { return await fn() }
  catch (e) { err.value = e instanceof ApiError ? e.message : '載入失敗'; return null }
  finally { loading.value = false }
}

async function loadOverview() {
  const r = await guard(() => http<{ overview: Overview }>('/v1/admin/overview'))
  if (r) overview.value = r.overview
}
async function loadUsers() {
  const path = q.value.trim() ? `/v1/admin/users?q=${encodeURIComponent(q.value.trim())}` : '/v1/admin/users'
  const r = await guard(() => http<{ users: AdminUser[] }>(path))
  if (r) users.value = r.users
}
async function loadSellers() {
  const r = await guard(() => http<{ sellers: Seller[] }>('/v1/admin/sellers'))
  if (r) sellers.value = r.sellers
}
async function loadDisputes() {
  const r = await guard(() => http<{ disputes: Dispute[] }>('/v1/admin/disputes'))
  if (r) disputes.value = r.disputes
}
async function loadActions() {
  const r = await guard(() => http<{ actions: Action[] }>('/v1/admin/actions'))
  if (r) actions.value = r.actions
}

function go(t: Tab) {
  tab.value = t
  okMsg.value = ''
  if (t === 'overview' && !overview.value) loadOverview()
  if (t === 'users' && !users.value.length) loadUsers()
  if (t === 'sellers' && !sellers.value.length) loadSellers()
  if (t === 'disputes' && !disputes.value.length) loadDisputes()
  if (t === 'audit') loadActions()   // 稽核每次都重載，它是要看最新的
}

async function openWallet(u: AdminUser) {
  const r = await guard(() =>
    http<{ wallet: { points: number; locked: number; available: number }; ledger: LedgerRow[] }>(`/v1/admin/users/${u.id}/wallet`))
  if (r) walletOf.value = { user: u, ...r }
}

async function doGrant() {
  if (!canGrant.value || !grantTo.value) return
  grantBusy.value = true
  err.value = ''
  try {
    await http('/v1/admin/grant', { method: 'POST', json: {
      userId: grantTo.value.id, points: grantPoints.value, note: grantNote.value.trim()
    } })
    okMsg.value = `已發放 ${grantPoints.value.toLocaleString()} 點給 ${grantTo.value.name}`
    grantTo.value = null
    grantNote.value = ''
    overview.value = null   // 數字變了，下次進總覽重抓
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : '發放失敗'
  } finally {
    grantBusy.value = false
  }
}

async function setTier(s: Seller, tier: string) {
  if (!confirm(`把「${s.name}」的等級改成 ${tier}？`)) return
  try {
    await http(`/v1/admin/sellers/${s.id}/tier`, { method: 'POST', json: { tier, note: '後台調整' } })
    s.tier = tier
    okMsg.value = `${s.name} → ${tier}`
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : '調整失敗'
  }
}

async function resolve(d: Dispute, to: 'buyer' | 'seller') {
  const who = to === 'buyer' ? '買家' : '賣家'
  if (!confirm(`裁決給${who}？\n\n${d.card?.name ?? ''} · ${d.price.toLocaleString()} 點\n此動作會立即結算款項，無法復原。`)) return
  try {
    await http(`/v1/orders/${d.id}/resolve`, { method: 'POST', json: { to, note: '後台裁決' } })
    disputes.value = disputes.value.filter(x => x.id !== d.id)
    okMsg.value = `已裁決給${who}`
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : '裁決失敗'
  }
}

const fmtTime = (v: string | number) => {
  const d = new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v)
  return isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16).replace('T', ' ')
}
const TIER_LABEL: Record<string, string> = { pending: '待審核', verified: '已驗證', trusted: '信任' }

onMounted(loadOverview)
</script>

<template>
  <div class="container page admin">
    <header class="head">
      <h1>平台後台</h1>
      <p class="sub muted">所有會改動資料的操作都會留下稽核紀錄</p>
    </header>

    <nav class="tabs" role="tablist">
      <button v-for="t in TABS" :key="t.k"
        type="button" role="tab" :aria-selected="tab === t.k"
        class="chip" :class="{ on: tab === t.k }" @click="go(t.k)">
        {{ t.label }}
        <span v-if="t.k === 'disputes' && overview?.orders_disputed" class="badge">{{ overview.orders_disputed }}</span>
        <span v-if="t.k === 'sellers' && overview?.sellers_pending" class="badge">{{ overview.sellers_pending }}</span>
      </button>
    </nav>

    <p v-if="err" class="msg err" role="alert">{{ err }}</p>
    <p v-if="okMsg" class="msg ok" role="status">{{ okMsg }}</p>
    <p v-if="loading" class="muted small">載入中…</p>

    <!-- 總覽 -->
    <section v-if="tab === 'overview' && overview" class="grid stats">
      <div class="stat"><span class="lbl">使用者</span><strong>{{ overview.users }}</strong><span class="sub2">7 日內新增 {{ overview.users_7d }}</span></div>
      <div class="stat"><span class="lbl">開放中的池</span><strong>{{ overview.pools_open }}</strong></div>
      <div class="stat" :class="{ warn: overview.sellers_pending > 0 }"><span class="lbl">待審賣家</span><strong>{{ overview.sellers_pending }}</strong></div>
      <div class="stat"><span class="lbl">進行中訂單</span><strong>{{ overview.orders_open }}</strong></div>
      <div class="stat" :class="{ danger: overview.orders_disputed > 0 }"><span class="lbl">爭議中</span><strong>{{ overview.orders_disputed }}</strong><span class="sub2">需要人工裁決</span></div>
      <div class="stat"><span class="lbl">託管中點數</span><strong class="mono">{{ Number(overview.escrowed_points).toLocaleString() }}</strong><span class="sub2">尚未結算給賣家</span></div>
      <div class="stat wide"><span class="lbl">流通點數總額</span><strong class="mono">{{ Number(overview.points_outstanding).toLocaleString() }}</strong><span class="sub2">帳本所有異動的總和＝目前所有人手上的點數</span></div>
    </section>

    <!-- 使用者 + 發點數 -->
    <section v-if="tab === 'users'">
      <form class="searchRow" @submit.prevent="loadUsers">
        <input v-model="q" type="search" placeholder="搜尋暱稱／代號／Email" />
        <button type="submit" class="btn sm">搜尋</button>
      </form>

      <div v-if="grantTo" class="card grantBox">
        <h3>發點數給 {{ grantTo.name }} <span class="mono muted">{{ grantTo.handle }}</span></h3>
        <div class="grantRow">
          <label>點數
            <input v-model.number="grantPoints" type="number" min="1" step="100" class="mono" />
          </label>
          <label class="grow">原因（必填，會寫進稽核紀錄）
            <input v-model="grantNote" type="text" placeholder="例如：活動補償、客服補發" />
          </label>
        </div>
        <div class="grantActs">
          <button type="button" class="btn sm" @click="grantTo = null">取消</button>
          <button type="button" class="btn primary sm" :disabled="!canGrant || grantBusy" @click="doGrant">
            {{ grantBusy ? '發放中…' : `確定發放 ${grantPoints.toLocaleString()} 點` }}
          </button>
        </div>
      </div>

      <div class="tw">
        <table>
          <thead><tr><th>代號</th><th>暱稱</th><th>Email</th><th>註冊</th><th></th></tr></thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td class="mono">{{ u.handle }}<span v-if="u.role === 'admin'" class="tag admin">admin</span></td>
              <td>{{ u.name }}</td>
              <td class="muted small">{{ u.email ?? '—' }}</td>
              <td class="muted small mono">{{ fmtTime(u.created_at) }}</td>
              <td class="rowActs">
                <button type="button" class="btn sm ghost" @click="openWallet(u)">帳本</button>
                <button type="button" class="btn sm" @click="grantTo = u">發點數</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!users.length && !loading" class="muted empty">沒有符合的使用者</p>
      </div>
    </section>

    <!-- 賣家 -->
    <section v-if="tab === 'sellers'">
      <p class="muted small note">
        待審核的賣家不能開池。目前還沒有「賣家申請」的前端流程，這裡列的是已經存在於資料庫的賣家。
      </p>
      <div class="tw">
        <table>
          <thead><tr><th>賣家</th><th>類型</th><th>等級</th><th>開池</th><th>違約</th><th></th></tr></thead>
          <tbody>
            <tr v-for="s in sellers" :key="s.id">
              <td>{{ s.name }}<br><span class="mono muted small">{{ s.handle }}</span></td>
              <td class="small">{{ s.origin }}</td>
              <td><span class="tier" :class="s.tier">{{ TIER_LABEL[s.tier] ?? s.tier }}</span></td>
              <td class="mono">{{ s.pools_run }}</td>
              <td class="mono" :class="{ bad: s.faults > 0 }">{{ s.faults }}</td>
              <td class="rowActs">
                <button v-if="s.tier !== 'verified'" type="button" class="btn sm" @click="setTier(s, 'verified')">設為已驗證</button>
                <button v-if="s.tier !== 'trusted'" type="button" class="btn sm ghost" @click="setTier(s, 'trusted')">升為信任</button>
                <button v-if="s.tier !== 'pending'" type="button" class="btn sm ghost" @click="setTier(s, 'pending')">退回待審</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!sellers.length && !loading" class="muted empty">還沒有賣家</p>
      </div>
    </section>

    <!-- 爭議 -->
    <section v-if="tab === 'disputes'">
      <p class="muted small note">
        裁決會<strong>立即結算款項且無法復原</strong>。判給買家＝退款並沒收賣家保證金；判給賣家＝放款。
      </p>
      <article v-for="d in disputes" :key="d.id" class="card dispute">
        <div class="dTop">
          <div>
            <strong>{{ d.card?.name ?? '（無卡名）' }}</strong>
            <p class="muted small mono">{{ d.price.toLocaleString() }} 點 · 保證金 {{ d.deposit.toLocaleString() }}</p>
          </div>
          <span class="muted small mono">{{ fmtTime(d.disputed_at) }}</span>
        </div>
        <p class="dParties muted small">買家 {{ d.buyer_name }} ↔ 賣家 {{ d.seller_name }}<span v-if="d.tracking"> · 單號 {{ d.tracking }}</span></p>
        <p class="dReason">{{ d.dispute_reason ?? '（未說明）' }}</p>
        <p class="small" :class="d.has_unboxing_video ? 'okText' : 'bad'">
          {{ d.has_unboxing_video ? '✓ 買家已附開箱影片' : '✗ 沒有開箱影片' }}
        </p>
        <div class="rowActs">
          <button type="button" class="btn sm" @click="resolve(d, 'buyer')">判給買家（退款）</button>
          <button type="button" class="btn sm" @click="resolve(d, 'seller')">判給賣家（放款）</button>
        </div>
      </article>
      <p v-if="!disputes.length && !loading" class="muted empty">目前沒有爭議</p>
    </section>

    <!-- 稽核 -->
    <section v-if="tab === 'audit'">
      <div class="tw">
        <table>
          <thead><tr><th>時間</th><th>操作</th><th>對象</th><th>說明</th></tr></thead>
          <tbody>
            <tr v-for="a in actions" :key="a.id">
              <td class="mono small">{{ fmtTime(a.created_at) }}</td>
              <td class="mono small">{{ a.action }}</td>
              <td class="mono small">{{ a.target ?? '—' }}</td>
              <td class="small">{{ a.note || '—' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!actions.length && !loading" class="muted empty">還沒有紀錄</p>
      </div>
    </section>

    <!-- 帳本浮層 -->
    <div v-if="walletOf" class="sheet" @click.self="walletOf = null">
      <div class="sheetInner">
        <header class="sheetHead">
          <div>
            <h3>{{ walletOf.user.name }} <span class="mono muted">{{ walletOf.user.handle }}</span></h3>
            <p class="muted small mono">
              可動用 {{ walletOf.wallet.available.toLocaleString() }} ·
              託管 {{ walletOf.wallet.locked.toLocaleString() }} ·
              總額 {{ walletOf.wallet.points.toLocaleString() }}
            </p>
          </div>
          <button type="button" class="btn sm" @click="walletOf = null">關閉</button>
        </header>
        <div class="tw">
          <table>
            <thead><tr><th>時間</th><th>異動</th><th>原因</th></tr></thead>
            <tbody>
              <tr v-for="l in walletOf.ledger" :key="l.id">
                <td class="mono small">{{ fmtTime(l.created_at) }}</td>
                <td class="mono" :class="l.delta >= 0 ? 'okText' : 'bad'">
                  {{ l.delta >= 0 ? '+' : '' }}{{ l.delta.toLocaleString() }}
                </td>
                <td class="small">{{ l.reason }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!walletOf.ledger.length" class="muted empty">沒有帳本紀錄</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.admin { padding-bottom: calc(48px + var(--safe-b)); }
.head { margin-bottom: 14px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { font-size: 13px; margin: 0; }
h3 { font-size: 15px; margin: 0 0 4px; }
.small { font-size: 12.5px; }
.note { line-height: 1.7; margin: 0 0 12px; }
.note strong { color: var(--ink); }

.tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.chip .badge {
  display: inline-block; margin-left: 6px; padding: 0 6px;
  border-radius: var(--pill); background: var(--danger); color: #fff;
  font-size: 11px; font-weight: 700;
}
.msg { font-size: 13.5px; margin: 0 0 12px; }
.msg.err { color: var(--danger); }
.msg.ok { color: var(--ok); }
.empty { padding: 24px 4px; font-size: 14px; }

/* 總覽 */
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.stat {
  background: var(--surface); border-radius: var(--radius-lg); padding: 14px 16px;
  display: grid; gap: 2px; align-content: start;
}
.stat.wide { grid-column: 1 / -1; }
.stat.warn { box-shadow: inset 3px 0 0 var(--warn); }
.stat.danger { box-shadow: inset 3px 0 0 var(--danger); }
.lbl { font-size: 12px; color: var(--muted); }
.stat strong { font-size: 22px; line-height: 1.2; }
.sub2 { font-size: 11.5px; color: var(--faint); line-height: 1.5; }

/* 搜尋 */
.searchRow { display: flex; gap: 8px; margin-bottom: 12px; }
.searchRow input {
  flex: 1; min-height: 44px; padding: 10px 14px; font-size: 15px;
  background: var(--field); border: 1px solid var(--line);
  border-radius: var(--radius); color: var(--ink);
}

/* 發點數 */
.grantBox { padding: 16px; margin-bottom: 14px; box-shadow: inset 3px 0 0 var(--gold); }
.grantRow { display: flex; gap: 10px; flex-wrap: wrap; margin: 10px 0 12px; }
.grantRow label { display: grid; gap: 4px; font-size: 12.5px; color: var(--muted); }
.grantRow .grow { flex: 1; min-width: 200px; }
.grantRow input {
  min-height: 42px; padding: 8px 12px; font-size: 14px;
  background: var(--field); border: 1px solid var(--line);
  border-radius: var(--radius); color: var(--ink);
}
.grantActs { display: flex; gap: 8px; justify-content: flex-end; }

/* 表格 */
.tw { overflow-x: auto; background: var(--surface); border-radius: var(--radius-lg); }
table { border-collapse: collapse; width: 100%; min-width: 520px; font-size: 13.5px; }
th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
th { background: var(--surface-2); font-size: 12px; color: var(--muted); font-weight: 700; white-space: nowrap; }
tr:last-child td { border-bottom: none; }
.rowActs { display: flex; gap: 6px; flex-wrap: wrap; }
.rowActs .btn.sm { padding: 6px 10px; font-size: 12px; }
.btn.ghost { opacity: .72; }
.tag.admin {
  margin-left: 6px; padding: 1px 6px; border-radius: var(--pill);
  background: var(--accent-wash); color: var(--accent); font-size: 10px; font-weight: 700;
}
.tier { padding: 3px 9px; border-radius: var(--pill); font-size: 11.5px; font-weight: 700; white-space: nowrap; }
.tier.pending { background: var(--warn-wash); color: var(--warn); }
.tier.verified { background: var(--ok-wash); color: var(--ok); }
.tier.trusted { background: var(--accent-wash); color: var(--accent); }
.bad { color: var(--danger); }
.okText { color: var(--ok); }

/* 爭議 */
.dispute { padding: 16px; margin-bottom: 12px; box-shadow: inset 3px 0 0 var(--danger); }
.dTop { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.dTop p { margin: 2px 0 0; }
.dParties { margin: 8px 0 0; }
.dReason { margin: 8px 0; font-size: 14px; line-height: 1.7; }
.dispute .rowActs { margin-top: 12px; }

/* 帳本浮層 */
.sheet {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(0, 0, 0, .6); backdrop-filter: blur(3px);
  display: grid; place-items: center; padding: 20px;
}
.sheetInner {
  background: var(--bg); border-radius: var(--radius-lg);
  width: min(680px, 100%); max-height: 82vh; overflow: auto;
  padding: 18px; box-shadow: var(--shadow-lg);
}
.sheetHead { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 12px; }
.sheetHead p { margin: 4px 0 0; }
</style>
