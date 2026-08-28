<script setup lang="ts">
/**
 * 客服工單詳情。
 *
 * 版面的順序就是客服的判斷順序：
 *   1. 這是什麼單、誰開的、等多久了
 *   2. **判斷這一張要不要通過所需要的事實**（接管單＝目前登記人；爭議單＝那筆訂單）
 *   3. 雙方講過什麼
 *   4. 我要做什麼（認領／回覆／結案）
 *
 * 第 2 段刻意放在訊息串**上面**而不是側欄。接管單的「目前登記在誰名下」是
 * 唯一能拆穿「我在站外買到的」這句話的資訊 —— 放在要捲動才看得到的地方，
 * 等於預設客服會漏看它。
 *
 * 結案做成獨立的對話框而不是一顆按鈕：訂單爭議的結案會**實際移動點數**，
 * 而後台在手機上很容易誤觸，誤觸沒有還原鍵（比照 ConsoleDisputes 的兩段確認）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  useTicketsStore, TICKET_KIND_LABEL, TICKET_STATUS_LABEL, TICKET_STATUS_TONE,
  fmtWait, isTicketClosed
} from '@/stores/tickets'
import { acceptOf, maxMbOf, useUploads, UPLOAD_RULES, type UploadPurpose } from '@/lib/uploads'
import ImageCropper from '@/components/ImageCropper.vue'
import { fmtTime } from './shared'
import './console.css'

const route = useRoute()
const router = useRouter()
const tickets = useTicketsStore()

const id = computed(() => String(route.params.id ?? ''))
const t = computed(() => tickets.adminDetail)
const closed = computed(() => !!t.value && isTicketClosed(t.value.status))

onMounted(() => tickets.adminLoadDetail(id.value))
// 直接改網址列或從佇列跳到另一張單時要重載，元件本身不會重建
watch(id, v => { if (v) tickets.adminLoadDetail(v) })

/* ---------- 附件 ----------
   'ticket-doc' 的規則已收進 src/lib/uploads.ts 的 UPLOAD_RULES（migration 026
   放行的用途）。這裡曾有一份執行期補登 —— uploads.ts 當時在別條工作線的
   施工範圍內動不得 —— 現已移除，直接用正宮的規則表。 */
const TICKET_PURPOSE = 'ticket-doc' as const

/* 解構出來是為了讓模板能自動解 ref —— 巢狀在物件裡的 ref 模板不會自動解包
   （ShipPhotoUpload 同一個理由） */
const {
  entries: upEntries, add: upAdd, remove: upRemove, retry: upRetry, clear: upClear,
  fileIds: upFileIds, pending: upPending, full: upFull, count: upCount, max: upMax,
  editTarget: upEdit, applyEdit: upApplyEdit, cancelEdit: upCancelEdit
} = useUploads(TICKET_PURPOSE, { max: 5 })
const accept = acceptOf(TICKET_PURPOSE)
const maxMb = maxMbOf(TICKET_PURPOSE)
/** 「連加都沒加進去」的情況（超過張數上限）要當場講，不然看起來像當掉 */
const dropNote = ref('')
/* 原生的檔案輸入框排不進後台的視覺語言，收成 display:none 由按鈕代打 */
const fileInput = ref<HTMLInputElement | null>(null)
function pickFiles(ev: Event) {
  const el = ev.target as HTMLInputElement
  dropNote.value = upAdd(el.files)
  // 不清空的話「選 A、移除 A、再選 A」不會觸發 change，使用者會以為按鈕壞了
  el.value = ''
}

/* ---------- 回覆 ---------- */
const draft = ref('')
const canReply = computed(() =>
  !!t.value && !closed.value && draft.value.trim().length > 0 && !upPending.value && !tickets.adminActing)

async function send() {
  if (!canReply.value || !t.value) return
  const ok = await tickets.adminReply(t.value.id, draft.value.trim(), upFileIds.value)
  if (!ok) return
  draft.value = ''
  upClear()
  dropNote.value = ''
}

/* ---------- 認領 ---------- */
async function claim() {
  if (!t.value) return
  await tickets.adminClaim(t.value.id)
}

/* ---------- 結案 ----------
   對話框的三段：判給誰（只有訂單爭議）→ 通過或駁回 → 理由。
   理由必填，因為當事人一定會問為什麼，而那句話會原樣寄給他。 */
const dlg = ref(false)
const outcome = ref<'resolved' | 'rejected'>('resolved')
const disputeTo = ref<'buyer' | 'seller' | ''>('')
const why = ref('')
const WHY_MAX = 500

/** 只有訂單爭議通過結案時要選判給誰 —— 那一條會走既有的裁決邏輯，點數會真的移動 */
const needsSide = computed(() => t.value?.kind === 'order-dispute' && outcome.value === 'resolved')

const whyOk = computed(() => {
  const n = why.value.trim().length
  return n > 0 && n <= WHY_MAX
})
const canSubmit = computed(() => whyOk.value && (!needsSide.value || !!disputeTo.value) && !tickets.adminActing)

function openDialog() {
  outcome.value = 'resolved'
  disputeTo.value = ''
  why.value = ''
  dlg.value = true
}

async function submit() {
  if (!canSubmit.value || !t.value) return
  const ok = await tickets.adminResolve(t.value.id, {
    outcome: outcome.value,
    resolution: why.value.trim(),
    disputeTo: needsSide.value ? (disputeTo.value as 'buyer' | 'seller') : undefined
  })
  if (!ok) return
  dlg.value = false
  /* 結案之後把佇列與側欄的數字重算。不重算的話返回佇列還看得到這一張，
     客服會以為沒存到而再按一次。 */
  await tickets.adminLoadQueue()
  await tickets.adminRefreshCount()
}

const backToQueue = () => router.push({ name: 'console-tickets' })

/** 這一張單「要看哪一筆既有資料」。依 kind 只給有意義的那幾條，不列一排 null */
const refs = computed(() => {
  const x = t.value
  if (!x) return [] as { k: string; v: string }[]
  const out: { k: string; v: string }[] = []
  if (x.grader || x.certNo) out.push({ k: '鑑定編號', v: `${x.grader ?? ''} #${x.certNo ?? ''}`.trim() })
  if (x.orderId) out.push({ k: '訂單', v: x.orderId })
  if (x.prizeId) out.push({ k: '卡片', v: x.prizeId })
  if (x.sellerId) out.push({ k: '賣家', v: x.sellerId })
  return out
})
</script>

<template>
  <div>
    <div class="c-head">
      <button class="c-btn back" type="button" @click="backToQueue">返回佇列</button>
      <h2 v-if="t">{{ t.subject }}</h2>
      <h2 v-else>工單</h2>
    </div>

    <p v-if="tickets.adminDetailErr" class="c-err">{{ tickets.adminDetailErr }}</p>
    <p v-if="tickets.adminActErr" class="c-err">{{ tickets.adminActErr }}</p>
    <p v-if="tickets.adminDetailLoading && !t" class="c-empty">載入中…</p>
    <p v-else-if="!t && !tickets.adminDetailErr" class="c-empty">找不到這張工單。</p>

    <template v-if="t">
      <!-- 1. 這是什麼單 -->
      <section class="c-card">
        <div class="pills">
          <span class="c-pill kind">{{ TICKET_KIND_LABEL[t.kind] }}</span>
          <span class="c-pill" :class="TICKET_STATUS_TONE[t.status]">{{ TICKET_STATUS_LABEL[t.status] }}</span>
          <span v-if="!closed" class="waited">已等 {{ fmtWait(t.createdAt) }}</span>
        </div>
        <dl class="c-dl">
          <dt>開單人</dt>
          <dd>
            <RouterLink class="lnk" :to="{ name: 'console-user', params: { id: t.userId } }">
              {{ t.userName }}
            </RouterLink>
          </dd>
          <dt>開單時間</dt><dd>{{ fmtTime(t.createdAt) }}</dd>
          <dt>認領人</dt><dd>{{ t.assigneeName || '未認領' }}</dd>
          <template v-for="r in refs" :key="r.k">
            <dt>{{ r.k }}</dt><dd>{{ r.v }}</dd>
          </template>
          <template v-if="t.resolution">
            <dt>結案理由</dt><dd>{{ t.resolution }}</dd>
          </template>
        </dl>
      </section>

      <!-- 2. 判斷依據：接管單的目前登記人。
           整塊上色是刻意的 —— 它是這一頁唯一「不看就會判錯」的東西 -->
      <section v-if="t.kind === 'takeover'" class="holder" :class="{ missing: !t.certHolder }">
        <h3>這個編號目前登記在誰名下</h3>
        <template v-if="t.certHolder">
          <p class="hname">
            <RouterLink class="lnk" :to="{ name: 'console-user', params: { id: t.certHolder.userId } }">
              {{ t.certHolder.userName }}
            </RouterLink>
            <span class="hno">{{ t.certHolder.memberNo }}</span>
          </p>
          <p class="hwhy">
            通過這張單，會把這個編號的擁有權與保管方<b>一起</b>改記到申請人
            {{ t.userName }} 名下，上面這位就不再持有它。
            確認過雙方真的有站外轉手再通過。
          </p>
        </template>
        <p v-else class="hwhy">
          查不到目前的登記人。<b>在查清楚之前不要通過</b> —— 沒有登記人代表申請人
          其實可以直接自己上傳，這張單多半是搞錯了或是有人在試探。
        </p>
      </section>

      <!-- 3. 訊息串 -->
      <section class="thread">
        <article v-for="m in t.messages" :key="m.id" class="msg" :class="{ staff: m.isStaff }">
          <p class="mhead">
            <b>{{ m.authorName }}</b>
            <span v-if="m.isStaff" class="c-pill go tag">客服</span>
            <span class="mtime">{{ fmtTime(m.createdAt) }}</span>
          </p>
          <p class="mbody">{{ m.body }}</p>
          <!-- 附件只列 id，不做成連結：檔案是私有的，取檔要帶授權標頭，
               一個點了會 401 的連結比一行純文字更糟（既有的賣家審核頁也是這樣列） -->
          <p v-if="m.fileIds.length" class="files">
            <span v-for="f in m.fileIds" :key="f" class="file">附件 {{ f }}</span>
          </p>
        </article>
      </section>

      <!-- 4. 我要做什麼 -->
      <section class="c-card act">
        <div class="acts">
          <button
            v-if="!t.assigneeId" class="c-btn pri" type="button"
            :disabled="tickets.adminActing || closed" @click="claim"
          >
            {{ tickets.adminActing ? '處理中…' : '認領這張單' }}
          </button>
          <span v-else class="c-m mine">由 {{ t.assigneeName }} 認領</span>

          <button
            class="c-btn danger" type="button" :disabled="closed || tickets.adminActing"
            @click="openDialog"
          >結案</button>
        </div>

        <p v-if="closed" class="c-m note">這張單已結案，不能再回覆。要再處理請請對方開一張新的單。</p>

        <template v-else>
          <label class="c-lab" for="tk-reply">回覆給 {{ t.userName }}</label>
          <textarea
            id="tk-reply" v-model="draft" class="c-in area"
            rows="4" placeholder="回覆內容。送出後這張單會轉成「等使用者回覆」。"
          ></textarea>

          <div class="upl">
            <button class="c-btn" type="button" :disabled="upFull" @click="fileInput?.click()">加附件</button>
            <input
              ref="fileInput" class="hidden-input" type="file" multiple
              :accept="accept" tabindex="-1" aria-hidden="true" @change="pickFiles"
            >
            <span class="c-m">{{ upCount }} / {{ upMax }} 個，單檔上限 {{ maxMb }}MB</span>
          </div>
          <p v-if="dropNote" class="c-warn">{{ dropNote }}</p>
          <ul v-if="upEntries.length" class="ups">
            <li v-for="e in upEntries" :key="e.uid" class="upi" :class="e.status">
              <span class="uname">{{ e.name }}</span>
              <!-- 裁切中的那一張要說清楚它在等人，不然它會靜靜停著像當掉 -->
              <span v-if="e.status === 'preparing'" class="c-m">讀取中…</span>
              <span v-else-if="e.status === 'editing'" class="c-m">待裁切</span>
              <span v-else-if="e.status === 'uploading'" class="c-m">{{ e.progress }}%</span>
              <span v-else-if="e.status === 'done'" class="c-m ok">已就緒</span>
              <span v-else-if="e.status === 'error'" class="c-m bad">{{ e.error }}</span>
              <button
                v-if="e.status === 'error' && e.retriable" class="c-btn tiny" type="button"
                @click="upRetry(e.uid)"
              >重試</button>
              <button class="c-btn tiny" type="button" @click="upRemove(e.uid)">移除</button>
            </li>
          </ul>

          <div class="send">
            <button class="c-btn pri" type="button" :disabled="!canReply" @click="send">
              {{ tickets.adminActing ? '送出中…' : '送出回覆' }}
            </button>
            <span v-if="upEdit" class="c-warn">請先調整照片範圍，確認後才會開始上傳</span>
            <span v-else-if="upPending" class="c-warn">附件還在上傳，全部完成才能送出</span>
          </div>
        </template>
      </section>

      <!-- 附件的裁切框。影像才會進來，PDF 走不到這裡（見 lib/image-edit.ts 的 planFor）。
           一次一張，:key 讓它換張時整個重建 -->
      <ImageCropper
        v-if="upEdit" :key="upEdit.uid"
        :file="upEdit.file" :policy="upEdit.policy" :max-bytes="upEdit.maxBytes"
        :index="upEdit.index" :total="upEdit.total"
        @done="r => upApplyEdit(upEdit!.uid, r)"
        @cancel="upCancelEdit(upEdit!.uid)"
      />

      <!-- 結案對話框。刻意不是行內展開：訂單爭議這一條會動到錢，
           需要一個把其他東西擋掉、逼人讀完後果的畫面 -->
      <div v-if="dlg" class="veil" @click.self="dlg = false">
        <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="tk-dlg-h">
          <h3 id="tk-dlg-h">結案：{{ t.subject }}</h3>

          <p class="c-lab">結果</p>
          <div class="opts">
            <button
              class="c-btn opt" :class="{ pri: outcome === 'resolved' }"
              type="button" @click="outcome = 'resolved'"
            >通過／已解決</button>
            <button
              class="c-btn opt" :class="{ pri: outcome === 'rejected' }"
              type="button" @click="outcome = 'rejected'"
            >駁回</button>
          </div>

          <!-- 訂單爭議：判給誰。兩個選項各自把後果寫在按鈕下面，
               不是寫在某處的小字裡 —— 誤按這兩顆的代價是真的錢 -->
          <template v-if="needsSide">
            <p class="c-lab">這筆爭議判給誰</p>
            <div class="sides">
              <button
                class="side" :class="{ on: disputeTo === 'buyer' }"
                type="button" @click="disputeTo = 'buyer'"
              >
                <b>判給買家</b>
                <i>代管中的點數<b>全額退回買家</b>，賣家拿不到這筆款。</i>
              </button>
              <button
                class="side" :class="{ on: disputeTo === 'seller' }"
                type="button" @click="disputeTo = 'seller'"
              >
                <b>判給賣家</b>
                <i>代管中的點數<b>放款給賣家</b>，買家不會拿到退款。</i>
              </button>
            </div>
            <p class="danger-note">
              這個選擇會實際移動點數，送出後<b>不可還原</b>。按錯只能靠稽核紀錄查、由資料庫處理。
            </p>
          </template>

          <p v-else-if="t.kind === 'takeover' && outcome === 'resolved'" class="danger-note">
            通過後，這個編號的擁有權與保管方會一起改記到 {{ t.userName }} 名下，
            原登記人{{ t.certHolder ? `（${t.certHolder.userName}）` : '' }}就不再持有它。
          </p>
          <p v-else-if="outcome === 'rejected'" class="c-m note">
            駁回只會把單結掉，不會動到點數、卡片或權限。
          </p>

          <label class="c-lab" for="tk-why">結案理由（必填，會寄給開單人）</label>
          <textarea
            id="tk-why" v-model="why" class="c-in area" rows="3"
            :maxlength="WHY_MAX" placeholder="講清楚為什麼這樣判。當事人一定會問。"
          ></textarea>
          <p class="c-m count">{{ why.trim().length }} / {{ WHY_MAX }}</p>
          <p v-if="!whyOk && why.length" class="c-warn">理由不能是空白。</p>

          <p v-if="tickets.adminActErr" class="c-err">{{ tickets.adminActErr }}</p>

          <div class="dacts">
            <button class="c-btn" type="button" @click="dlg = false">取消</button>
            <button class="c-btn danger" type="button" :disabled="!canSubmit" @click="submit">
              {{ tickets.adminActing ? '處理中…' : '確認結案' }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.c-head h2 { min-width: 0; overflow-wrap: anywhere; }
.back { flex: none; min-height: 44px; }

.pills { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.waited { margin-left: auto; font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--warn-ink); }
.c-pill.kind { background: var(--surface-3); color: var(--ink); }
.lnk {
  color: var(--gold);
  /* 觸控目標：行內連結預設只有一行字高（16px），手機上點不準。
     inline-flex + min-height 撐到 44px，而且對齊靠上（flex-start）——
     置中的話文字會掉到 44px 方框的中間，跟左邊那一欄的 <dt> 標籤錯開一截，
     看起來像排版壞掉。靠上才跟標籤同一條線。 */
  display: inline-flex; align-items: flex-start; min-height: 44px;
}

/* 接管單的判斷依據。整塊上色，而且在訊息串之前 —— 沒有這一段客服判不了 */
.holder {
  background: var(--warn-wash); border: 1px solid var(--warn);
  border-radius: 14px; padding: 14px; margin-bottom: 12px;
}
.holder.missing { background: var(--danger-wash); border-color: var(--danger); }
.holder h3 { margin: 0 0 8px; font-size: 13px; color: var(--warn-ink); }
.holder.missing h3 { color: var(--danger-ink); }
.hname { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 0 0 6px; font-size: 17px; font-weight: 800; }
.hno { font-size: 12.5px; font-weight: 600; color: var(--muted); overflow-wrap: anywhere; }
.hwhy { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--ink); }

.thread { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.msg {
  background: var(--surface); border: 1px solid var(--line-soft);
  border-radius: 12px; padding: 12px 14px; min-width: 0; overflow-wrap: anywhere;
}
/* 客服自己說過的話要一眼分得出來，否則長串裡讀不出誰在講 */
.msg.staff { background: var(--surface-2); border-color: var(--line); }
.mhead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin: 0 0 6px; font-size: 13px; }
.tag { font-size: 10.5px; }
.mtime { margin-left: auto; font-size: 11.5px; color: var(--faint); }
.mbody { margin: 0; font-size: 13.5px; line-height: 1.75; white-space: pre-wrap; }
.files { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
.file {
  font-size: 11.5px; color: var(--muted); padding: 3px 8px;
  border-radius: 7px; background: var(--surface-3); overflow-wrap: anywhere;
}

.act .acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.act .c-btn { min-height: 44px; }
.mine { margin-right: auto; }
.note { line-height: 1.7; }
.area { resize: vertical; line-height: 1.7; }

.upl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.hidden-input { display: none; }

.ups { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.upi {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px; border-radius: 9px; background: var(--surface-2);
  font-size: 12.5px; min-width: 0;
}
.uname { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.upi .ok { color: var(--ok-ink); }
.upi .bad { color: var(--danger-ink); }
.tiny { padding: 6px 12px; font-size: 12px; min-height: 44px; }

.send { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; }

/* ---- 結案對話框 ---- */
.veil {
  position: fixed; inset: 0; z-index: 60; background: #000b;
  display: flex; align-items: flex-end; justify-content: center;
  padding: 0;
}
.dlg {
  width: 100%; max-width: 560px; max-height: 92dvh; overflow-y: auto;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: 18px 18px 0 0;
  padding: 18px 16px calc(18px + var(--safe-b, 0px));
}
.dlg h3 { margin: 0 0 14px; font-size: 16px; overflow-wrap: anywhere; }

.opts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 14px; }
.opt { min-height: 44px; }

.sides { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-bottom: 10px; }
.side {
  display: flex; flex-direction: column; gap: 4px; text-align: left;
  min-height: 44px; padding: 12px 14px; font: inherit;
  border: 1px solid var(--line); border-radius: 12px;
  background: var(--surface-2); color: var(--ink); cursor: pointer;
}
.side:hover { border-color: var(--gold); }
/* 選中的那一顆要非常明顯：這兩顆決定錢往哪走 */
.side.on { border-color: var(--danger); background: var(--danger-wash); }
.side b { font-size: 14px; }
.side i { font-style: normal; font-size: 12.5px; line-height: 1.65; color: var(--muted); }
.side.on i { color: var(--danger-ink); }

.danger-note {
  margin: 0 0 14px; padding: 10px 12px; border-radius: 10px;
  background: var(--danger-wash); color: var(--danger-ink);
  font-size: 12.5px; line-height: 1.7;
}
.count { text-align: right; margin: 4px 0 0; }
.dacts { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
.dacts .c-btn { min-height: 44px; }

@media (min-width: 700px) {
  .veil { align-items: center; padding: 20px; }
  .dlg { border-radius: 18px; }
  .sides { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
