<script setup lang="ts">
/**
 * 一張單的詳情：訊息串 + 回覆。
 *
 * 版面的順序就是使用者讀它的順序：
 *   1. 這是哪一張單、現在什麼狀態（標題列）
 *   2. **結案的話，理由要在最上面**。已經結案的單，使用者第一個問題是
 *      「所以到底怎麼了」，把理由藏在訊息串最下面等於要他自己捲下去找。
 *   3. 訊息串（客服在左、我的在右）
 *   4. 回覆框；結案的單這裡改成一段說明 + 開新單的出口
 *
 * 左右分邊是刻意的：一串沒有分邊的對話在手機上讀起來像一份會議紀錄，
 * 而使用者要一眼看出的是「最後一句是誰說的」——那決定了球在誰手上。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useTicketsStore } from '@/stores/tickets'
import { ApiError } from '@/lib/http'
import { KIND_TEXT, STATUS_TEXT, fmtStamp, fmtWhen, isClosed } from './labels'
import TicketBadge from './TicketBadge.vue'
import TicketFiles from './TicketFiles.vue'

const route = useRoute()
const store = useTicketsStore()

const id = computed(() => String(route.params.id ?? ''))
const t = computed(() => store.detail)
const closed = computed(() => !!t.value && isClosed(t.value.status))

const BODY_MAX = 2000
const reply = ref('')
const fileIds = ref<string[]>([])
const uploading = ref(false)
const sending = ref(false)
const sendErr = ref('')
/** 附件元件的 handle：送出成功之後要把已經送掉的那幾張清掉 */
const files = ref<InstanceType<typeof TicketFiles> | null>(null)

const thread = ref<HTMLElement | null>(null)

/** 卷到最後一則。新訊息在最下面，不捲的話送出之後畫面看起來完全沒動 */
async function toBottom() {
  await nextTick()
  const el = thread.value
  if (!el) return
  const last = el.lastElementChild
  last?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

onMounted(async () => {
  await store.open(id.value)
  toBottom()
})

/* 直接改網址上的單號（或從別張單的連結過來）也要重載。
   不看 params 的話，元件會被複用而畫面停在上一張單。 */
watch(id, async v => {
  if (!v) return
  reply.value = ''
  sendErr.value = ''
  await store.open(v)
  toBottom()
})

const canSend = computed(() =>
  !!reply.value.trim() && reply.value.length <= BODY_MAX && !uploading.value && !sending.value)

/** 送不出去的時候講原因。一顆灰掉的按鈕沒有辦法解釋自己 */
const blockedWhy = computed(() => {
  if (uploading.value) return '附件還在上傳，傳完才能送出'
  if (reply.value.length > BODY_MAX) return `太長了，最多 ${BODY_MAX} 字`
  return ''
})

async function send() {
  if (!canSend.value || !t.value) return
  sending.value = true
  sendErr.value = ''
  try {
    await store.reply(t.value.id, reply.value.trim(), fileIds.value)
    reply.value = ''
    files.value?.clearFiles()
    fileIds.value = []
    toBottom()
  } catch (e) {
    /* 失敗時**不要**清掉輸入框。使用者剛打的那段字是他的東西，
       清掉等於在他已經送失敗一次的時候，再讓他重打一遍。 */
    sendErr.value = e instanceof ApiError ? e.message : e instanceof Error ? e.message : '送出失敗，請稍後再試'
  } finally {
    sending.value = false
  }
}

/** 這張單牽到哪個東西。有值才顯示 —— 空欄位排在那裡只是噪音 */
const refs = computed(() => {
  const x = t.value
  if (!x) return [] as { k: string; v: string }[]
  const out: { k: string; v: string }[] = []
  if (x.certNo) out.push({ k: '鑑定編號', v: `${x.grader || 'PSA'} #${x.certNo}` })
  if (x.orderId) out.push({ k: '訂單', v: x.orderId })
  if (x.prizeId) out.push({ k: '卡片', v: x.prizeId })
  if (x.assigneeName) out.push({ k: '負責客服', v: x.assigneeName })
  return out
})
</script>

<template>
  <div class="container page">
    <RouterLink :to="{ name: 'support' }" class="stBack">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"
           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 6l-6 6 6 6" />
      </svg>
      我的問題
    </RouterLink>

    <p v-if="store.detailErr" class="stErr" role="alert">
      <span>{{ store.detailErr }}</span>
      <button type="button" class="btn sm" @click="store.open(id)">重試</button>
    </p>

    <p v-else-if="store.detailLoading && !t" class="stState muted">載入中…</p>

    <template v-else-if="t">
      <header class="stHead">
        <div class="stTags">
          <TicketBadge :status="t.status" />
          <span class="chip stKind">{{ KIND_TEXT[t.kind] }}</span>
          <span class="stWhen mono">{{ fmtWhen(t.createdAt) }}開單</span>
        </div>
        <h1 class="stSubj">{{ t.subject }}</h1>
        <dl v-if="refs.length" class="stRefs">
          <div v-for="r in refs" :key="r.k" class="stRef">
            <dt>{{ r.k }}</dt>
            <dd class="mono">{{ r.v }}</dd>
          </div>
        </dl>
      </header>

      <!-- 結案理由擺在訊息串之前。這是已結案的單上最重要的一段字 -->
      <section v-if="closed && t.resolution" class="stResult" :class="t.status" role="note">
        <strong class="stResultT">
          {{ STATUS_TEXT[t.status].t }}
          <span v-if="t.closedAt" class="stResultAt mono">· {{ fmtWhen(t.closedAt) }}</span>
        </strong>
        <p class="stResultP">{{ t.resolution }}</p>
      </section>

      <!-- 訊息串。客服左、我的右 -->
      <ol ref="thread" class="stThread" data-testid="ticket-thread">
        <li v-for="m in t.messages" :key="m.id" class="stMsg" :class="m.isStaff ? 'staff' : 'mine'">
          <div class="stBubble">
            <span class="stWho">{{ m.isStaff ? m.authorName || '客服' : '我' }}</span>
            <p class="stBody">{{ m.body }}</p>
            <!-- 附件目前只講「有幾個」：檔案是私有的，要走 GET /v1/files/:id
                 帶授權才拿得到，而那條在 mock 模式下不存在。與其畫一張永遠破掉的圖，
                 不如誠實說有附件。等取檔接上再換成縮圖。 -->
            <p v-if="m.fileIds.length" class="stFiles">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"
                   stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 11.5 12.4 19a4.5 4.5 0 1 1-6.4-6.4l7.9-7.8a3 3 0 0 1 4.2 4.2l-7.9 7.9a1.5 1.5 0 0 1-2.1-2.1l7.2-7.2" />
              </svg>
              {{ m.fileIds.length }} 個附件
            </p>
            <time class="stTime mono">{{ fmtStamp(m.createdAt) }}</time>
          </div>
        </li>
      </ol>

      <!-- 已結案：回覆框停用，但要給得出下一步 -->
      <section v-if="closed" class="stClosed card">
        <p class="stClosedP">
          這張單已經結案，沒辦法再回覆。如果同一件事還有後續，
          開一張新的單並附上這張的單號
          <b class="mono">{{ t.id }}</b>，客服看得到前面的往來。
        </p>
        <RouterLink :to="{ name: 'support-new' }" class="btn">開一張新的單</RouterLink>
      </section>

      <!-- 未結案：回覆 -->
      <section v-else class="stReply card">
        <label class="stReplyField">
          <span class="stReplyT">回覆</span>
          <textarea
            v-model="reply" class="stArea" rows="4" :maxlength="BODY_MAX"
            placeholder="補充說明，或回答客服的問題"
            data-testid="ticket-reply"
          ></textarea>
        </label>

        <TicketFiles
          ref="files"
          hint="要補照片或文件就加在這裡。"
          v-model:file-ids="fileIds"
          v-model:pending="uploading"
        />

        <p v-if="sendErr" class="stSendErr" role="alert">{{ sendErr }}</p>
        <p v-else-if="blockedWhy" class="stWhy">{{ blockedWhy }}</p>

        <div class="stActions">
          <span class="stCount mono" :class="{ near: reply.length > BODY_MAX - 100 }">
            {{ reply.length }} / {{ BODY_MAX }}
          </span>
          <button
            type="button" class="btn primary stSend"
            :disabled="!canSend" data-testid="ticket-send" @click="send"
          >{{ sending ? '送出中…' : '送出回覆' }}</button>
        </div>
        <p v-if="t.status === 'pending-user'" class="stNudge">
          客服在等你的回覆。你回了之後這張單會回到處理佇列。
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page { padding-top: 18px; padding-bottom: 56px; max-width: 720px; }

.stBack {
  display: inline-flex; align-items: center; gap: 4px;
  min-height: 44px; padding: 0 10px 0 0;
  color: var(--muted); text-decoration: none; font-size: 13px;
}
.stBack:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--pill); }

.stErr {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  margin: 8px 0 0; padding: 12px 14px;
  background: var(--danger-wash); color: var(--danger-ink);
  border-radius: var(--radius); font-size: 13px; line-height: 1.7;
}
.stErr span { min-width: 0; overflow-wrap: anywhere; }
.btn.sm { min-height: 44px; padding: 0 16px; font-size: 13px; flex: none; }

.stState { padding: 40px 4px; text-align: center; font-size: 13.5px; }

.stHead { margin: 2px 0 16px; min-width: 0; }
.stTags { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.stKind { font-size: 11.5px; padding: 5px 10px; flex: none; }
.stWhen { font-size: 11.5px; color: var(--faint); }

/* 主旨絕不截斷 —— 它是這張單的身分 */
.stSubj {
  margin: 10px 0 0; min-width: 0;
  font-size: 20px; font-weight: 700; line-height: 1.45;
  overflow-wrap: anywhere;
}

.stRefs {
  margin: 12px 0 0; padding: 0;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px;
}
@media (min-width: 560px) { .stRefs { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.stRef {
  display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 8px;
  align-items: baseline; min-width: 0;
}
.stRef dt { font-size: 11.5px; color: var(--faint); }
.stRef dd { margin: 0; min-width: 0; font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; }

.stResult { padding: 14px 16px; margin-bottom: 16px; border-radius: var(--radius); min-width: 0; }
.stResult.resolved { background: var(--ok-wash); }
.stResult.rejected { background: var(--danger-wash); }
.stResultT { display: block; font-size: 13.5px; }
.stResult.resolved .stResultT { color: var(--ok-ink); }
.stResult.rejected .stResultT { color: var(--danger-ink); }
.stResultAt { font-weight: 400; color: var(--muted); font-size: 11.5px; }
.stResultP {
  margin: 7px 0 0; font-size: 13px; line-height: 1.9;
  color: var(--ink); overflow-wrap: anywhere;
}

.stThread {
  list-style: none; margin: 0 0 18px; padding: 0;
  display: grid; gap: 12px; min-width: 0;
}
.stMsg { display: flex; min-width: 0; }
.stMsg.staff { justify-content: flex-start; }
.stMsg.mine { justify-content: flex-end; }

.stBubble {
  min-width: 0; max-width: 84%;
  padding: 11px 14px;
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--line-soft);
}
/* 我的訊息用強調色的 wash 而不是實心強調色：一整段長文字疊在
   飽和的橘紅上讀不下去，而工單的訊息本來就常常很長。 */
.stMsg.mine .stBubble { background: var(--accent-wash); border-color: transparent; }

.stWho { display: block; font-size: 11px; font-weight: 700; color: var(--muted); }
.stBody {
  margin: 5px 0 0; min-width: 0;
  font-size: 14px; line-height: 1.9; color: var(--ink);
  /* 換行原樣保留：使用者用換行分點的一段字，擠成一坨就讀不出他的分點 */
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.stFiles {
  display: inline-flex; align-items: center; gap: 5px;
  margin: 8px 0 0; font-size: 11.5px; color: var(--muted);
}
.stTime { display: block; margin-top: 7px; font-size: 10.5px; color: var(--faint); }

.stClosed { padding: 16px; display: grid; gap: 12px; justify-items: start; min-width: 0; }
.stClosedP { margin: 0; font-size: 13px; line-height: 1.9; color: var(--muted); overflow-wrap: anywhere; }

.stReply { padding: 16px; display: grid; gap: 10px; min-width: 0; }
.stReplyField { display: grid; gap: 6px; min-width: 0; }
.stReplyT { font-size: 13px; font-weight: 700; }
.stArea {
  width: 100%; min-width: 0; min-height: 96px;
  padding: 11px 13px; resize: vertical;
  border-radius: var(--radius); border: 1px solid var(--line);
  background: var(--field); color: var(--ink);
  font: inherit; font-size: 14.5px; line-height: 1.8;
}
.stArea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.stSendErr {
  margin: 0; padding: 10px 12px;
  background: var(--danger-wash); color: var(--danger-ink);
  border-radius: var(--radius); font-size: 12.5px; line-height: 1.75;
  overflow-wrap: anywhere;
}
.stWhy { margin: 0; font-size: 12px; line-height: 1.7; color: var(--warn-ink); }

.stActions {
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: center; gap: 12px;
}
.stCount { font-size: 11px; color: var(--faint); min-width: 0; }
.stSend { min-height: 46px; padding: 0 22px; flex: none; }

.stNudge { margin: 0; font-size: 11.5px; line-height: 1.8; color: var(--muted); }
</style>
