<script setup lang="ts">
/**
 * 後台：公開聯絡訊息的佇列。
 *
 * ── 為什麼客服有兩個地方要看 ───────────────────────────────────────
 * 工單（024）的每一列都以 `user_id not null` 為軸心 —— 那一欄決定誰看得到、
 * 而且後台佇列是 `join users` 的**內連接**。沒有登入的人身上沒有那個值，
 * 硬併進去只有兩條路：把 user_id 改成可空（內連接會**靜默地**把匿名列
 * 整批濾掉，客服看不到也不會報錯，那正是這個功能唯一不能出的錯），
 * 或造一個假使用者當人頭。所以聯絡訊息是自己一張表、自己一頁。
 * 代價寫在這裡：**客服要看兩個地方**。所以側欄給它一個獨立的待辦數字，
 * 讓「還有一個地方要看」在畫面上是看得見的，而不是靠記得。
 *
 * ── 這一頁跟工單佇列最大的差別 ─────────────────────────────────────
 * 工單可以在站上回覆，這裡不行 —— 平台沒有寄信服務，回覆是客服自己
 * 用信箱寫一封信。所以這一頁的主角是**那個 email 地址**（要能一眼看到、
 * 能複製），而不是一個「回覆」輸入框。放一個看起來會寄信的按鈕，
 * 是在騙客服自己。
 *
 * 訊息內文一律走 {{ }} 插值（Vue 會做 HTML 逸出）——
 * 這是全站唯一會收到「完全不受信任的匿名輸入」的地方，
 * 任何 v-html 在這一頁都是儲存型 XSS。
 */
import { computed, inject, onMounted, ref } from 'vue'
import { http, useAsync, fmtTime } from './shared'
import './console.css'

interface Row {
  id: string
  topic: string
  name: string
  email: string
  body: string
  userId: string | null
  userName: string | null
  userMemberNo: string | null
  status: 'new' | 'handled'
  createdAt: number
  handledAt: number | null
  handledByName: string | null
  handledNote: string | null
}

const TOPIC_LABEL: Record<string, string> = {
  login: '登入不了', account: '帳號問題', order: '訂單或出貨',
  report: '檢舉或申訴', privacy: '個資與隱私', other: '其他'
}

const refreshBadges = inject<() => Promise<void>>('console:refresh', async () => {})
const { loading, err, okMsg, run, flash } = useAsync()

const rows = ref<Row[]>([])
const pending = ref(0)
const scope = ref<'new' | 'all'>('new')
/** 展開中的那一則。列表上只給前兩行，點開才是全文 */
const openId = ref('')
const note = ref('')

async function load() {
  const r = await run(() => http<{ items: Row[]; nextCursor: string | null; pending: number }>(
    `/v1/admin/contact?scope=${scope.value}&limit=50`))
  if (!r) return
  rows.value = r.items
  pending.value = r.pending
}
onMounted(load)

async function setScope(k: 'new' | 'all') {
  if (scope.value === k) return
  scope.value = k
  openId.value = ''
  await load()
}

function toggle(id: string) {
  openId.value = openId.value === id ? '' : id
  note.value = ''
}

/** 標記處理完成。備註必填 —— 沒有紀錄的處理事後無法覆核。 */
async function handle(id: string) {
  const n = note.value.trim()
  /* 在前端就先擋，而不是送出去等 400：客服打完一整段之後被伺服器退回，
     那一段字很容易在重整時掉掉。後端仍然會擋（前端的檢查不是權威）。 */
  if (n.length < 2) { err.value = '請先寫下你做了什麼（例如「已回信協助重設密碼」）'; return }
  const r = await run(() => http(`/v1/admin/contact/${encodeURIComponent(id)}/handle`,
    { method: 'POST', json: { note: n } }))
  if (!r) return
  note.value = ''
  openId.value = ''
  await load()
  await refreshBadges()
  flash('已標記處理完成')
}

const empty = computed(() => !loading.value && !rows.value.length)
</script>

<template>
  <div>
    <div class="c-head">
      <h2>聯絡訊息</h2>
      <span class="c-sub">公開表單（不需登入）送進來的。舊的排前面。</span>
      <div class="c-right">
        <button class="c-btn" type="button" :disabled="loading" @click="load()">重新整理</button>
      </div>
    </div>

    <!-- 這一段是給客服看的操作說明，不是裝飾：站上沒有寄信功能，
         如果沒有人講，第一個接手的人會在畫面上找一個不存在的「回覆」鍵 -->
    <p class="ctWhy">
      這裡的人多半<b>沒有帳號</b>（忘記密碼、還沒註冊、或是站外來函），所以站內回覆對他們沒有用。
      處理方式是<b>用平台信箱直接回他填的 email</b>，回完之後在這裡標記完成並寫下你做了什麼。
    </p>

    <div class="tabs">
      <button type="button" class="tab" :class="{ on: scope === 'new' }" @click="setScope('new')">
        未處理<b v-if="pending">{{ pending }}</b>
      </button>
      <button type="button" class="tab" :class="{ on: scope === 'all' }" @click="setScope('all')">全部</button>
    </div>

    <p v-if="err" class="c-err">{{ err }}</p>
    <p v-if="okMsg" class="c-ok">{{ okMsg }}</p>

    <p v-if="loading && !rows.length" class="c-empty">載入中…</p>
    <p v-else-if="empty" class="c-empty">
      {{ scope === 'new' ? '目前沒有待處理的聯絡訊息。' : '還沒有任何聯絡訊息。' }}
    </p>

    <div v-else class="c-rows">
      <article v-for="m in rows" :key="m.id" class="c-row crow" :data-testid="`contact-row-${m.id}`">
        <div class="chead">
          <span class="c-pill kind">{{ TOPIC_LABEL[m.topic] ?? m.topic }}</span>
          <span class="c-pill" :class="m.status === 'new' ? 'wait' : 'done'">
            {{ m.status === 'new' ? '未處理' : '已處理' }}
          </span>
          <span class="c-m when">{{ fmtTime(m.createdAt) }}</span>
        </div>

        <div class="cwho">
          <b class="c-t">{{ m.name }}</b>
          <!-- email 是這一頁的主角：回覆只能走它，所以獨立成一行、可選取 -->
          <a class="cmail mono selectable" :href="`mailto:${m.email}`">{{ m.email }}</a>
          <span v-if="m.userId" class="c-m acct">
            站內帳號：{{ m.userName }}<em v-if="m.userMemberNo">{{ m.userMemberNo }}</em>
          </span>
          <span v-else class="c-m anon">沒有站內帳號（或送出時沒登入）</span>
        </div>

        <!-- 內文。{{ }} 插值，絕對不要 v-html —— 這是全站最不受信任的輸入 -->
        <p class="cbody" :class="{ open: openId === m.id }">{{ m.body }}</p>

        <div class="c-actions">
          <button class="c-btn" type="button" @click="toggle(m.id)">
            {{ openId === m.id ? '收合' : '看全文並處理' }}
          </button>
          <!-- 有帳號的那幾則才給這顆：客服最常做的下一件事就是對照那個人的
               訂單與卡冊，而會員檔案已經有一頁做好了，不要在這裡重畫一次 -->
          <RouterLink
            v-if="m.userId" class="c-btn"
            :to="{ name: 'console-user', params: { id: m.userId } }"
          >開會員檔案</RouterLink>
        </div>

        <div v-if="openId === m.id && m.status === 'new'" class="cdo">
          <label class="c-lab" :for="`note-${m.id}`">你做了什麼（會留下紀錄，必填）</label>
          <input
            :id="`note-${m.id}`" v-model="note" class="c-in"
            type="text" maxlength="500" placeholder="例如：已回信協助重設密碼"
            :data-testid="`contact-note-${m.id}`"
          />
          <button
            class="c-btn pri" type="button" :disabled="loading"
            :data-testid="`contact-handle-${m.id}`" @click="handle(m.id)"
          >標記處理完成</button>
        </div>

        <p v-if="m.status === 'handled'" class="cdone">
          {{ fmtTime(m.handledAt) }} 由 {{ m.handledByName ?? '—' }} 處理：{{ m.handledNote }}
        </p>
      </article>
    </div>
  </div>
</template>

<style scoped>
.ctWhy {
  margin: 0 0 14px; padding: 11px 13px;
  background: var(--surface-2); border-radius: 10px;
  font-size: 12.5px; line-height: 1.85; color: var(--muted);
}

.tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
.tab {
  flex: none; min-height: 44px; padding: 7px 16px; font: inherit; font-size: 13px;
  border: 1px solid var(--line); border-radius: 999px;
  background: var(--surface); color: var(--muted); cursor: pointer;
}
.tab.on { background: var(--surface-3); color: var(--ink); border-color: var(--line); font-weight: 700; }
.tab b { margin-left: 5px; color: var(--gold); }
.c-head .c-btn { min-height: 44px; }
.c-actions .c-btn, .cdo .c-btn { min-height: 44px; }
/* RouterLink 套 .c-btn 時要自己補掉底線並置中 —— .c-btn 是給 <button> 設計的 */
.c-actions a.c-btn { display: inline-flex; align-items: center; text-decoration: none; }

.crow { gap: 8px; }
.chead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.c-pill.kind { background: var(--surface-3); color: var(--ink); }
.when { margin-left: auto; font-variant-numeric: tabular-nums; }

.cwho { display: grid; gap: 3px; min-width: 0; }
.cmail {
  font-size: 13px; color: var(--accent); text-decoration: none;
  overflow-wrap: anywhere;
  /* 觸控目標 44px，用負外距抵銷視覺高度（同前台頁尾連結的做法） */
  display: inline-block; padding: 13px 0; margin: -13px 0;
}
.cmail:hover { text-decoration: underline; }
.acct em { font-style: normal; margin-left: 6px; color: var(--faint); }
.anon { color: var(--faint); }

/* 未展開時只給兩行：佇列的價值是「一眼掃過去有幾件事」，
   讓每一則都攤成一段文章的話一頁放不下幾則 */
.cbody {
  margin: 2px 0 0; font-size: 13px; line-height: 1.85; color: var(--ink);
  white-space: pre-wrap; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2;
  overflow: hidden;
}
.cbody.open { display: block; -webkit-line-clamp: none; line-clamp: none; }

.cdo {
  display: grid; gap: 8px; margin-top: 6px; padding-top: 10px;
  border-top: 1px solid var(--line-soft);
}
.cdone {
  margin: 4px 0 0; padding: 8px 10px; border-radius: 8px;
  background: var(--ok-wash); color: var(--ok-ink);
  font-size: 12px; line-height: 1.75; overflow-wrap: anywhere;
}
</style>
