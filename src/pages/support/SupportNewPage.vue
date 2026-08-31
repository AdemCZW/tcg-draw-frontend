<script setup lang="ts">
/**
 * 開一張新單。
 *
 * 兩個入口，兩種心情，同一頁：
 *   1. 使用者自己從「我的問題」按開新問題 —— 他要先選類型。
 *   2. 建池撞到 CERT_ALREADY_LISTED，從錯誤訊息旁邊的「申請接管」跳過來 ——
 *      他被擋住了，正在氣頭上。這時候**不能**再讓他從頭選一次類型、
 *      再把那個八位數編號自己抄一遍。類型、鑑定機構、編號、主旨全部帶著進來，
 *      他要做的只剩「說明你怎麼拿到這張卡」。
 *
 * order-dispute 與 seller-doc 不在可選清單裡（labels.ts 有寫理由），
 * 但頁面上要**講出來**它們去哪了 —— 找不到「訂單爭議」的人會以為平台沒有這個管道。
 */
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTicketsStore } from '@/stores/tickets'
import { ApiError } from '@/lib/http'
import type { TicketKind } from '@/lib/api'
import { AUTO_KINDS, KIND_TEXT, OPENABLE_KINDS } from './labels'
import TicketFiles from './TicketFiles.vue'

type OpenKind = Exclude<TicketKind, 'order-dispute' | 'seller-doc'>

const route = useRoute()
const router = useRouter()
const store = useTicketsStore()

const SUBJECT_MAX = 60
const BODY_MAX = 2000

const form = reactive({
  kind: 'other' as OpenKind,
  subject: '',
  body: '',
  certNo: '',
  grader: 'PSA'
})

const fileIds = ref<string[]>([])
const uploading = ref(false)
const busy = ref(false)
const error = ref('')
const attempted = ref(false)
/* 每按一次送出就 +1，當成「收到了」那一行的 :key。
   沒有它，第二次按下去畫面完全不動（清單早就長在那裡了），
   使用者得到的結論是「這顆按鈕壞了」。開池表單同樣的理由、同樣的做法。 */
const attemptSeq = ref(0)
const todoRef = ref<HTMLElement | null>(null)

/** 從哪裡被帶過來的。true 的時候版面要先講「你為什麼會在這裡」 */
const fromBlocked = ref(false)

const q = (k: string) => {
  const v = route.query[k]
  return typeof v === 'string' ? v : ''
}

onMounted(() => {
  const k = q('kind') as OpenKind
  if (OPENABLE_KINDS.some(o => o.k === k)) form.kind = k
  const cert = q('certNo').trim()
  const grader = q('grader').trim()
  if (cert) form.certNo = cert
  if (grader) form.grader = grader.toUpperCase()
  /* 主旨預填成「接管 PSA #12345678」。使用者可以改 ——
     預填是省他一次抄寫，不是替他決定。 */
  if (cert && form.kind === 'takeover') {
    form.subject = `接管 ${form.grader || 'PSA'} #${cert}`
    fromBlocked.value = q('from') === 'pool'
  }
})

const isTakeover = computed(() => form.kind === 'takeover')

const kindHint = computed(() => OPENABLE_KINDS.find(o => o.k === form.kind)?.hint ?? '')

/* 整句在 script 裡拼好再交給模板。分成幾個 <template> 標籤拼的話，
   標籤之間的換行會被算成空白，畫面上就會出現「賣家審核 不在這裡」那種
   多一格的縫 —— 中文沒有字間空格，那一格看起來像排版壞掉。 */
const autoNote = computed(() =>
  `${AUTO_KINDS.map(k => KIND_TEXT[k]).join('與')}不在這裡：`
  + '那兩種在你送出申訴、送出審核文件之後，系統會自動開單，直接在「我的問題」裡找得到。')

/**
 * 還差什麼。跟開池表單同一個做法：**送出鍵不禁用**，按下去會指出第一個問題。
 * 禁用的按鈕沒有辦法解釋自己，而使用者唯一能做的事是猜。
 */
const problems = computed<{ anchor: string; msg: string }[]>(() => {
  const out: { anchor: string; msg: string }[] = []
  const subject = form.subject.trim()
  const body = form.body.trim()
  if (!subject) out.push({ anchor: 'tk-subject', msg: '主旨還沒填' })
  else if (subject.length > SUBJECT_MAX) out.push({ anchor: 'tk-subject', msg: `主旨最多 ${SUBJECT_MAX} 字` })
  if (!body) out.push({ anchor: 'tk-body', msg: '說明還沒填' })
  else if (body.length > BODY_MAX) out.push({ anchor: 'tk-body', msg: `說明最多 ${BODY_MAX} 字` })
  if (isTakeover.value) {
    /* 接管單一定要有編號與鑑定機構：沒有這兩個，客服端連「這張卡現在登記在誰名下」
       都查不到，那張單一開就是死的。後端也會擋（契約第三節）。 */
    if (!form.certNo.trim()) out.push({ anchor: 'tk-cert', msg: '接管要填鑑定編號' })
    if (!form.grader.trim()) out.push({ anchor: 'tk-grader', msg: '接管要填鑑定機構' })
  }
  if (uploading.value) out.push({ anchor: 'tk-files', msg: '附件還在上傳，傳完才能送出' })
  return out
})
const valid = computed(() => problems.value.length === 0)

/* 哪些欄位還缺。按過送出之後，**每一個**缺的欄位都要在自己那一格上說話 ——
   原本只有被 goTo 聚焦的那一格看起來不一樣（而且那只是聚焦框，不是「這格有問題」），
   第二個缺的「說明」從頭到尾沒有任何記號。 */
const missText = (anchor: string) =>
  attempted.value ? (problems.value.find(p => p.anchor === anchor)?.msg ?? '') : ''

/** 使用者自己點清單上的某一項時才跳。那是他指名要去的地方，捲過去是應該的。 */
function goTo(anchor: string) {
  const el = document.getElementById(anchor)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus({ preventScroll: true })
}

/**
 * 把「還差什麼」那份清單帶進視野 —— 但**只在它不在視野裡的時候**。
 *
 * 按鈕上寫的是「看看還差什麼」，承諾的是一份清單；清單現在就長在按鈕正下方，
 * 而按鈕本來就在使用者眼前（他才剛按到它）。所以絕大多數情況這裡什麼都不做：
 * 目標已經看得到，動畫面只會把人帶離他正在看的東西。
 * 這正是原本那個 bug 的形狀 —— 原本按下去是 goTo(第一個問題的欄位)，
 * 畫面往**上**跳 559px 回到頁首，而那份清單留在視窗下方 225px。
 * （條件式捲動的做法同 MyCardsPage 換分頁時的 listRef。） */
async function revealTodo() {
  await nextTick()
  const el = todoRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  if (r.top >= 0 && r.bottom <= window.innerHeight) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function pickKind(k: OpenKind) {
  form.kind = k
  /* 換類型時如果主旨還是空的，給一個起頭。已經打過字就不要動它 ——
     蓋掉使用者打的字比省他幾個鍵盤敲擊嚴重得多。 */
  if (!form.subject.trim() && k === 'takeover' && form.certNo.trim()) {
    form.subject = `接管 ${form.grader || 'PSA'} #${form.certNo.trim()}`
  }
}

async function submit() {
  attempted.value = true
  attemptSeq.value++
  /* 不把人送去別的地方：回應就在按鈕正下方 */
  if (!valid.value) { await revealTodo(); return }
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const t = await store.create({
      kind: form.kind,
      subject: form.subject.trim(),
      body: form.body.trim(),
      fileIds: fileIds.value,
      certNo: isTakeover.value ? form.certNo.trim() : undefined,
      grader: isTakeover.value ? form.grader.trim().toUpperCase() : undefined
    })
    /* replace 而不是 push：開完單按上一頁應該回到列表，不是回到一張已經送出去的表單。
       送出去的表單再按一次送出會開出第二張一模一樣的單。 */
    router.replace({ name: 'support-ticket', params: { id: t.id } })
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '開單失敗，請稍後再試'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="container page">
    <RouterLink :to="{ name: 'support' }" class="snBack">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"
           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 6l-6 6 6 6" />
      </svg>
      我的問題
    </RouterLink>

    <h1 class="display snTitle">開新問題</h1>

    <!-- 從建池的 409 跳過來的：先講清楚他為什麼會在這裡，並把那個編號亮出來。
         不講的話，畫面會像是「按了申請接管，然後跳到一張空白表單」。 -->
    <aside v-if="fromBlocked" class="snFrom" role="note">
      <strong class="snFromT">你要接管的是 {{ form.grader }} #{{ form.certNo }}</strong>
      <p class="snFromP">
        這個編號目前登記在別人名下，所以你剛才開池被擋下來。
        接管通過之後，這張卡的擁有權會轉到你名下，你就可以拿它開池或上架。
        下面只剩一件事要做：說明你是怎麼拿到這張實體卡的。
      </p>
    </aside>

    <form class="snForm" novalidate @submit.prevent="submit">
      <!-- ① 類型 -->
      <section class="snSec">
        <h2 class="snLabel">這是什麼問題？</h2>
        <div class="snKinds" role="radiogroup" aria-label="問題類型">
          <button
            v-for="o in OPENABLE_KINDS" :key="o.k"
            type="button" role="radio" :aria-checked="form.kind === o.k"
            class="snKind" :class="{ on: form.kind === o.k }"
            @click="pickKind(o.k)"
          >{{ o.t }}</button>
        </div>
        <p class="snHint">{{ kindHint }}</p>
        <p class="snAuto">{{ autoNote }}</p>
      </section>

      <!-- ② 接管專用欄位 -->
      <section v-if="isTakeover" class="snSec">
        <h2 class="snLabel">是哪一張卡？</h2>
        <div class="snCertRow">
          <label class="snField snGrader">
            <span class="snFieldT">鑑定機構</span>
            <select
              id="tk-grader" v-model="form.grader" class="snInput"
              :class="{ bad: !!missText('tk-grader') }"
            >
              <option value="PSA">PSA</option>
              <option value="BGS">BGS</option>
              <option value="CGC">CGC</option>
              <option value="ARS">ARS</option>
            </select>
          </label>
          <label class="snField">
            <span class="snFieldT">鑑定編號</span>
            <input
              id="tk-cert" v-model="form.certNo" class="snInput mono"
              :class="{ bad: !!missText('tk-cert') }"
              :aria-invalid="!!missText('tk-cert') || undefined"
              type="text" inputmode="numeric" autocomplete="off" placeholder="例如 82345671"
            />
          </label>
        </div>
        <p v-if="missText('tk-cert') || missText('tk-grader')" class="snMiss">
          {{ missText('tk-cert') || missText('tk-grader') }}
        </p>
        <p class="snHint">
          編號印在卡殼標籤上。我們會拿它去查目前登記在誰名下 ——
          查不到、或本來就登記在你自己名下的話，你其實可以直接上傳，不需要接管。
        </p>
      </section>

      <!-- ③ 主旨 -->
      <section class="snSec">
        <label class="snField">
          <span class="snLabel">主旨</span>
          <input
            id="tk-subject" v-model="form.subject" class="snInput"
            :class="{ bad: !!missText('tk-subject') }"
            :aria-invalid="!!missText('tk-subject') || undefined"
            type="text" :maxlength="SUBJECT_MAX" placeholder="一句話講重點"
          />
        </label>
        <!-- 缺的欄位要自己說話。清單在頁面下方，捲到這一格的人看不到那份清單 -->
        <p v-if="missText('tk-subject')" class="snMiss">{{ missText('tk-subject') }}</p>
        <p class="snCount mono" :class="{ near: form.subject.length > SUBJECT_MAX - 10 }">
          {{ form.subject.length }} / {{ SUBJECT_MAX }}
        </p>
      </section>

      <!-- ④ 說明 -->
      <section class="snSec">
        <label class="snField">
          <span class="snLabel">說明</span>
          <textarea
            id="tk-body" v-model="form.body" class="snInput snArea"
            :class="{ bad: !!missText('tk-body') }"
            :aria-invalid="!!missText('tk-body') || undefined"
            :maxlength="BODY_MAX" rows="7"
            :placeholder="isTakeover
              ? '你在哪裡買的、跟誰買的、什麼時候拿到的。有交易紀錄的話一起附上，處理會快很多。'
              : '把發生的事、你已經試過什麼、以及你希望怎麼處理寫清楚。'"
          ></textarea>
        </label>
        <p v-if="missText('tk-body')" class="snMiss">{{ missText('tk-body') }}</p>
        <p class="snCount mono" :class="{ near: form.body.length > BODY_MAX - 100 }">
          {{ form.body.length }} / {{ BODY_MAX }}
        </p>
      </section>

      <!-- ⑤ 附件 -->
      <section id="tk-files" class="snSec">
        <TicketFiles
          :hint="isTakeover
            ? '卡背鑑定編號的清晰照片、交易紀錄截圖。照片越具體，來回問話的次數越少。'
            : '截圖或照片能讓客服少問你一輪。'"
          v-model:file-ids="fileIds"
          v-model:pending="uploading"
        />
      </section>

      <p v-if="error" class="snErr" role="alert">{{ error }}</p>

      <!-- 刻意不禁用：按得下去、按下去會在**正下方**列出還差什麼（同開池表單的理由） -->
      <button type="submit" class="btn primary snGo" :class="{ notyet: !valid }" :disabled="busy"
              data-testid="ticket-submit">
        {{ busy ? '送出中…' : valid ? '送出' : '看看還差什麼' }}
      </button>

      <!-- 「還差什麼」清單放在送出鈕**正下方**。
           它原本在按鈕上面、而按下去又會把畫面捲到第一個有問題的欄位（頁首附近），
           實測按鈕與清單會一起離開視窗（scrollY 593 → 34，清單掉到視窗下方 225px）。
           按鈕在哪裡，答案就要在哪裡。 -->
      <div v-if="problems.length && attempted" ref="todoRef" class="snTodo" role="alert">
        <!-- 按下去的「收據」。:key 綁 attemptSeq，所以連按第二下也會重新掛載、
             重播一次動畫 —— 沒有它，第二下一樣是零回饋。 -->
        <p :key="attemptSeq" class="snTodoHit" data-testid="ticket-hitch" :data-attempt="attemptSeq">
          收到了，但還送不出去。
        </p>
        <p class="snTodoT">還差 {{ problems.length }} 項</p>
        <ul>
          <li v-for="p in problems" :key="p.anchor + p.msg">
            <button type="button" class="snTodoItem" @click="goTo(p.anchor)">
              <span>{{ p.msg }}</span>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"
                   stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          </li>
        </ul>
      </div>
      <p class="snNote">
        送出之後可以在這張單上繼續補充。客服回覆時你會在「我的問題」看到未讀標記。
      </p>
    </form>
  </div>
</template>

<style scoped>
.page { padding-top: 18px; padding-bottom: 56px; max-width: 640px; }

.snBack {
  display: inline-flex; align-items: center; gap: 4px;
  min-height: 44px; padding: 0 10px 0 0;
  color: var(--muted); text-decoration: none; font-size: 13px;
}
.snBack:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--pill); }

.snTitle { font-size: 24px; margin: 2px 0 14px; }

.snFrom {
  padding: 14px 16px; margin-bottom: 18px; min-width: 0;
  background: var(--accent-wash); border-radius: var(--radius);
}
.snFromT { display: block; font-size: 14px; color: var(--ink); overflow-wrap: anywhere; }
.snFromP { margin: 6px 0 0; font-size: 12.5px; line-height: 1.85; color: var(--muted); }

.snForm { display: grid; gap: 20px; min-width: 0; }
.snSec { min-width: 0; display: grid; gap: 8px; }

.snLabel { font-size: 13.5px; font-weight: 700; margin: 0; }

.snKinds { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
.snKind {
  min-height: 44px; padding: 0 16px; min-width: 0;
  border-radius: var(--pill); border: 1px solid var(--line);
  background: var(--surface); color: var(--ink);
  font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer;
}
.snKind.on { background: var(--accent); border-color: transparent; color: var(--on-accent); }
.snKind:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

.snHint { margin: 0; font-size: 12px; line-height: 1.8; color: var(--muted); }
.snAuto {
  margin: 2px 0 0; padding: 10px 12px;
  font-size: 11.5px; line-height: 1.85; color: var(--faint);
  background: var(--surface-2); border-radius: var(--radius);
}

/* 鑑定機構固定寬、編號吃剩下的。minmax(0, 1fr) 讓長編號不會撐開格線 */
.snCertRow { display: grid; grid-template-columns: 116px minmax(0, 1fr); gap: 10px; }
.snField { display: grid; gap: 6px; min-width: 0; }
.snFieldT { font-size: 12px; color: var(--muted); }
.snInput {
  width: 100%; min-width: 0; min-height: 44px;
  padding: 10px 13px;
  border-radius: var(--radius); border: 1px solid var(--line);
  background: var(--field); color: var(--ink);
  font: inherit; font-size: 15px;
}
.snInput:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/* 缺的欄位。邊框只負責「哪一格」，「缺什麼」由底下那行 .snMiss 用字說 ——
   一圈紅框自己解釋不了自己 */
.snInput.bad { border-color: var(--danger); }
.snMiss { margin: 0; font-size: 12px; line-height: 1.6; color: var(--danger-ink); }
.snArea { resize: vertical; line-height: 1.8; font-size: 14.5px; min-height: 132px; }

.snCount { justify-self: end; font-size: 11px; color: var(--faint); margin: 0; }
.snCount.near { color: var(--warn-ink); }

.snTodo { padding: 12px 14px; background: var(--warn-wash); border-radius: var(--radius); min-width: 0; }
/* 「收到了」那一行每按一次就重新掛載並淡入 —— 連按第二下也看得出畫面有反應 */
.snTodoHit {
  margin: 0 0 6px; font-size: 13px; font-weight: 700; color: var(--warn-ink);
  animation: snHit .28s ease-out;
}
@keyframes snHit {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) { .snTodoHit { animation: none; } }
.snTodoT { margin: 0 0 6px; font-size: 12.5px; font-weight: 600; color: var(--warn-ink); }
.snTodo ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.snTodoItem {
  width: 100%; min-height: 44px; min-width: 0;
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 0 4px; border: 0; background: none; cursor: pointer;
  color: var(--warn-ink); font: inherit; font-size: 12.5px; text-align: left;
}
.snTodoItem span { min-width: 0; overflow-wrap: anywhere; }
.snTodoItem svg { flex: none; }

.snErr {
  margin: 0; padding: 12px 14px;
  background: var(--danger-wash); color: var(--danger-ink);
  border-radius: var(--radius); font-size: 13px; line-height: 1.75;
  overflow-wrap: anywhere;
}

.snGo { width: 100%; min-height: 50px; }
.snGo.notyet { background: var(--surface-3); color: var(--muted); border-color: var(--line); }
.snNote { margin: 0; font-size: 11.5px; line-height: 1.8; color: var(--faint); text-align: center; }
</style>
