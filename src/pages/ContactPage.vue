<script setup lang="ts">
/**
 * 聯絡客服（/contact）。**不需要登入。**
 *
 * ── 為什麼要有這一頁 ───────────────────────────────────────────────
 * 站上已經有完整的工單系統（/support），但它整組要登入。而最需要
 * 聯絡平台的人，往往正是進不來的那些：
 *   · 忘記密碼的人。平台刻意不做忘記密碼流程（產品決定），所以那個人
 *     進不去 → 開不了工單 → 沒有人能幫他把密碼救回來。這是一個封閉迴圈，
 *     這一頁就是把那個迴圈打開的那條線。
 *   · 還沒註冊、想先問清楚的人；檢舉的人；消保單位；律師。
 * 另外，「客服聯絡方式」是法規要求要對外揭露的東西，而條款頁那一欄
 * 目前還是 ⟨待填⟩ —— 在信箱補齊之前，這一頁是唯一真的送得到的路。
 *
 * ── 這一頁最重要的一句話 ───────────────────────────────────────────
 * **「我們會用 email 回覆你。」**
 * 這個平台**沒有任何寄信服務**（後端環境變數裡沒有 SMTP／SES／SendGrid，
 * 程式碼裡也沒有任何寄信路徑）。所以「回覆」不會由系統自動發生，
 * 而是客服自己用平台的信箱寫一封信給你。
 * 那件事必須在**送出之前**就講清楚，而且要講兩次（表單上方一次、
 * email 欄位旁邊一次）—— 讓人以為「站上會跳通知」是最糟的結果：
 * 他多半連帳號都沒有，永遠不會回來看。
 *
 * ── 刻意不做的 ─────────────────────────────────────────────────────
 * · 不收附件。理由在 server/migrations/037_contact.sql 的檔頭：
 *   匿名上傳等於開一個免費、不記名的檔案空間。要附圖的人可以先送這一則，
 *   客服回信時他直接回信附檔。
 * · 不做 CAPTCHA。對真人是負擔，而且擋不住便宜的人力農場。
 *   防濫用靠後端的兩層限流（見 server/src/routes/contact.ts）。
 * · 送出鍵不禁用。跟開池、開工單同一條紀律：禁用的按鈕沒有辦法解釋自己，
 *   而使用者唯一能做的事是猜。按下去會在正下方列出還差什麼。
 */
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { contactApi, type ContactTopic } from '@/lib/api'
import { ApiError } from '@/lib/http'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

const NAME_MAX = 40
const EMAIL_MAX = 160
const BODY_MAX = 4000
const BODY_MIN = 10

/** 主題。login 排第一個不是隨便排的 —— 它是這一頁存在的主要理由。 */
const TOPICS: { k: ContactTopic; t: string; hint: string }[] = [
  {
    k: 'login', t: '登入不了',
    hint: '本站沒有自助的忘記密碼流程，密碼要由客服人工協助處理。'
      + '請寫下你當初註冊用的 Email、或你是用 LINE 登入的，以及你會員編號（如果記得）。'
  },
  {
    k: 'account', t: '帳號問題',
    hint: '改資料、關閉帳號、帳號被別人使用。關閉帳號目前沒有自助功能，要走這裡人工處理。'
  },
  {
    k: 'order', t: '訂單或出貨',
    hint: '如果你登入得進來，訂單的問題走站內的「我的問題」會快很多 —— 那邊看得到你的訂單編號與狀態。'
  },
  {
    k: 'report', t: '檢舉或申訴',
    hint: '檢舉某個帳號、某張卡不是賣家的、或你是某張卡的真正持有人。請盡量寫出可以對照的編號或連結。'
  },
  {
    k: 'privacy', t: '個資與隱私',
    hint: '查詢、更正、刪除你的個人資料，或請我們停止利用。可以先看隱私權政策第六節，那裡寫了哪些你現在就能自己做。'
  },
  { k: 'other', t: '其他', hint: '合作、媒體、主管機關來函，或以上都不是的事。' }
]

const form = reactive({
  topic: 'login' as ContactTopic,
  name: '',
  email: '',
  body: ''
})

const busy = ref(false)
const error = ref('')
const attempted = ref(false)
/* 每按一次送出就 +1，當成「收到了」那一行的 :key ——
   沒有它，第二次按下去畫面完全不動（清單早就長在那裡了），
   使用者得到的結論是「這顆按鈕壞了」。同 SupportNewPage 的做法。 */
const attemptSeq = ref(0)
const todoRef = ref<HTMLElement | null>(null)
/** 送出成功後要顯示的編號。有值就整張表單換成回執。 */
const sentId = ref('')

/**
 * 已登入的人打開這一頁時把身分帶進來。
 *
 * 為什麼要帶：客服拿到一則有帳號的訊息時，處理方式跟匿名的完全不同
 * （可以直接開會員檔案對照訂單、卡冊、點數），少問一輪。
 * **但只帶「稱呼」與「Email」這兩個他自己看得到、也改得掉的欄位** ——
 * 帳號本身是由 http() 帶上的 token 決定的，不是這裡的輸入框，
 * 所以他把 Email 改成別的地址也不會偽裝成別人。
 * 預填不等於替他決定：兩個欄位都留著讓他改（例如公司信箱換成私人信箱）。
 */
onMounted(() => {
  const u = auth.user
  if (!u) return
  if (!form.name) form.name = u.name || u.handle || ''
  if (!form.email && u.email) form.email = u.email
})

const topicHint = computed(() => TOPICS.find(t => t.k === form.topic)?.hint ?? '')

/* Email 只做形狀檢查，跟後端同一個標準（有 @、有網域、沒有空白）。
   **這不代表那個信箱收得到信** —— 沒有人能保證，除非真的寄一封出去，
   而這個平台沒有寄信服務。所以旁邊那行提示是請他自己再看一次，
   而不是給一個綠色勾勾去暗示「已驗證」。 */
const emailOk = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

/**
 * 還差什麼。送出鍵**不禁用**，按下去會在正下方指出問題。
 */
const problems = computed<{ anchor: string; msg: string }[]>(() => {
  const out: { anchor: string; msg: string }[] = []
  const name = form.name.trim()
  const email = form.email.trim()
  const body = form.body.trim()
  if (!name) out.push({ anchor: 'ct-name', msg: '還沒填怎麼稱呼你' })
  else if (name.length > NAME_MAX) out.push({ anchor: 'ct-name', msg: `稱呼最多 ${NAME_MAX} 字` })
  if (!email) out.push({ anchor: 'ct-email', msg: '還沒填 Email —— 沒有它我們沒辦法回覆你' })
  else if (!emailOk(email)) out.push({ anchor: 'ct-email', msg: 'Email 的格式看起來不對，再檢查一次' })
  else if (email.length > EMAIL_MAX) out.push({ anchor: 'ct-email', msg: 'Email 太長了' })
  if (!body) out.push({ anchor: 'ct-body', msg: '還沒寫你遇到的事' })
  else if (body.length < BODY_MIN) out.push({ anchor: 'ct-body', msg: `再多寫幾個字（至少 ${BODY_MIN} 字），太短客服看不出你需要什麼` })
  else if (body.length > BODY_MAX) out.push({ anchor: 'ct-body', msg: `訊息最多 ${BODY_MAX} 字` })
  return out
})
const valid = computed(() => problems.value.length === 0)

/* 按過送出之後，**每一個**缺的欄位都要在自己那一格上說話 ——
   只把畫面捲到第一個問題的話，第二個缺的欄位從頭到尾沒有任何記號。 */
const missText = (anchor: string) =>
  attempted.value ? (problems.value.find(p => p.anchor === anchor)?.msg ?? '') : ''

function goTo(anchor: string) {
  const el = document.getElementById(anchor)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus({ preventScroll: true })
}

/** 把「還差什麼」帶進視野 —— 但**只在它不在視野裡的時候**（同 SupportNewPage）。 */
async function revealTodo() {
  await nextTick()
  const el = todoRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  if (r.top >= 0 && r.bottom <= window.innerHeight) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

async function submit() {
  attempted.value = true
  attemptSeq.value++
  if (!valid.value) { await revealTodo(); return }
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const r = await contactApi.send({
      topic: form.topic,
      name: form.name.trim(),
      email: form.email.trim(),
      body: form.body.trim()
    })
    sentId.value = r.id
    /* 回執取代表單，並把畫面帶回頁首 —— 送出成功的證據不該在
       捲軸下方某處，那會讓人以為什麼都沒發生而再按一次。 */
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch (e) {
    /* 後端的 429（限流）訊息本身就是寫給使用者看的中文，直接顯示。
       其他錯誤退回一句中性的話 —— 「連不上伺服器」在 Railway 冷啟動時
       是常態，不是「系統壞了」。 */
    error.value = e instanceof ApiError ? e.message : '送不出去，請稍後再試一次'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="container page">
    <!-- ── 送出成功的回執 ──────────────────────────────────────────
         整張表單被換掉，不是在下面加一行綠字：留著表單等於邀請他再送一次，
         而重送在客服那一端就是重複的工。 -->
    <section v-if="sentId" class="ctDone" role="status">
      <h1 class="ctTitle">收到了</h1>
      <p class="ctDoneNo">
        訊息編號 <b class="mono">{{ sentId }}</b>
      </p>
      <p class="ctDoneP">
        接下來會發生的事：客服看到之後，會<b>寄一封 email 到你剛才填的地址</b>。
        站上不會有通知，也沒有一個頁面可以回來查進度 —— 因為你不需要有帳號就能用這張表單，
        我們沒有其他方式找得到你。
      </p>
      <p class="ctDoneP">
        如果過幾天都沒有收到，請先看一下垃圾郵件匣，再從這一頁送一次，
        並在內容裡註明上面那個編號。
      </p>
      <RouterLink class="btn ctHome" :to="{ name: 'landing' }">回首頁</RouterLink>
    </section>

    <template v-else>
      <header class="ctHead">
        <p class="eyebrow">聯絡客服</p>
        <h1 class="ctTitle">不用登入也能找到我們</h1>
        <p class="ctLede">
          這張表單是給<b>進不來的人</b>用的 ——
          忘記密碼、還沒註冊、或是要檢舉、申訴、行使個資權利。
          已經登入得進來的人，走站內的「我的問題」會比這裡快。
        </p>
      </header>

      <!-- 已登入的人：**這一塊要排在「怎麼回覆你」之前**。
           對他而言下面那段（只能靠 email、站上沒有進度）講的是一個他不必接受的
           限制 —— 站內的「我的問題」可以附證據、看得到進度、回覆也在站內。
           讓他填完整張表才發現有更好的路，是這一頁最容易犯的錯。

           但**不強制導走**：他可能就是要用這一條（帳號被盜、不想把這件事留在
           自己帳號的紀錄裡、或正在替別人問）。所以是一條建議不是一道閘。 -->
      <aside v-if="auth.isLoggedIn" class="ctLogged" role="note">
        <p class="ctLoggedT">你已經登入了 —— 用「我的問題」會比這裡快</p>
        <p class="ctLoggedP">
          站內的工單可以附上照片與檔案、看得到處理進度，客服的回覆也直接出現在站上，
          不必等 email。你目前以 <b>{{ auth.user?.name || auth.user?.handle }}</b>
          的身分登入。
        </p>
        <RouterLink class="ctLoggedGo" :to="{ name: 'support-new' }">
          去「我的問題」開一張工單
        </RouterLink>
        <p class="ctLoggedAlt">
          還是要用這張表也可以 —— 送出時會一併附上你的帳號，客服照樣對照得到你的訂單與卡冊。
        </p>
      </aside>

      <!-- 這一頁最重要的一句話。放在表單上方，而不是送出鍵旁邊：
           他要在開始打字之前就知道回覆會發生在哪裡。 -->
      <aside class="ctHow" role="note">
        <p class="ctHowT">我們會用 email 回覆你</p>
        <p class="ctHowP">
          本站<b>不會</b>寄自動通知信，也<b>不會</b>在站上跳提醒 ——
          是客服本人讀完之後，用平台的信箱寫一封信給你。
          所以請確認下面填的地址是你收得到信的那一個。
        </p>
      </aside>

      <form class="ctForm" novalidate @submit.prevent="submit">
        <!-- ① 主題 -->
        <section class="ctSec">
          <h2 class="ctLabel">你要問的是什麼？</h2>
          <div class="ctTopics" role="radiogroup" aria-label="主題">
            <button
              v-for="t in TOPICS" :key="t.k"
              type="button" role="radio" :aria-checked="form.topic === t.k"
              class="ctTopic" :class="{ on: form.topic === t.k }"
              :data-testid="`contact-topic-${t.k}`"
              @click="form.topic = t.k"
            >{{ t.t }}</button>
          </div>
          <p class="ctHint">{{ topicHint }}</p>
        </section>

        <!-- ② 稱呼 -->
        <section class="ctSec">
          <label class="ctField">
            <span class="ctLabel">怎麼稱呼你</span>
            <input
              id="ct-name" v-model="form.name" class="ctInput"
              :class="{ bad: !!missText('ct-name') }"
              :aria-invalid="!!missText('ct-name') || undefined"
              type="text" :maxlength="NAME_MAX" autocomplete="name"
              data-testid="contact-name" placeholder="王小明、或你習慣的暱稱"
            />
          </label>
          <p v-if="missText('ct-name')" class="ctMiss">{{ missText('ct-name') }}</p>
          <p class="ctHint">不需要本名。這只是讓客服回信時知道怎麼稱呼你。</p>
        </section>

        <!-- ③ Email。回覆的唯一管道，所以提示要再講一次 -->
        <section class="ctSec">
          <label class="ctField">
            <span class="ctLabel">Email</span>
            <input
              id="ct-email" v-model="form.email" class="ctInput mono"
              :class="{ bad: !!missText('ct-email') }"
              :aria-invalid="!!missText('ct-email') || undefined"
              type="email" :maxlength="EMAIL_MAX" autocomplete="email"
              inputmode="email" data-testid="contact-email" placeholder="you@example.com"
            />
          </label>
          <p v-if="missText('ct-email')" class="ctMiss">{{ missText('ct-email') }}</p>
          <p class="ctHint">
            <b>回覆只會寄到這裡。</b>我們沒辦法驗證這個地址收不收得到信，
            所以請你自己再看一次有沒有打錯。
          </p>
        </section>

        <!-- ④ 內容 -->
        <section class="ctSec">
          <label class="ctField">
            <span class="ctLabel">發生了什麼事</span>
            <textarea
              id="ct-body" v-model="form.body" class="ctInput ctArea"
              :class="{ bad: !!missText('ct-body') }"
              :aria-invalid="!!missText('ct-body') || undefined"
              :maxlength="BODY_MAX" rows="8" data-testid="contact-body"
              placeholder="把事情、你已經試過什麼、以及你希望怎麼處理寫清楚。有訂單編號、會員編號或鑑定編號的話一起寫上，處理會快很多。"
            ></textarea>
          </label>
          <p v-if="missText('ct-body')" class="ctMiss">{{ missText('ct-body') }}</p>
          <p class="ctCount mono" :class="{ near: form.body.length > BODY_MAX - 200 }">
            {{ form.body.length }} / {{ BODY_MAX }}
          </p>
          <p class="ctHint">
            這張表單<b>不能附加檔案</b>。需要給我們看照片或截圖的話，
            先把事情寫在這裡，客服回信之後你直接回那封信附上就好。
          </p>
        </section>

        <p v-if="error" class="ctErr" role="alert" data-testid="contact-error">{{ error }}</p>

        <button
          type="submit" class="btn primary ctGo" :class="{ notyet: !valid }" :disabled="busy"
          data-testid="contact-submit"
        >
          {{ busy ? '送出中…' : valid ? '送出' : '看看還差什麼' }}
        </button>

        <!-- 「還差什麼」放在送出鍵**正下方**：按鈕在哪裡，答案就要在哪裡 -->
        <div v-if="problems.length && attempted" ref="todoRef" class="ctTodo" role="alert">
          <p :key="attemptSeq" class="ctTodoHit" data-testid="contact-hitch" :data-attempt="attemptSeq">
            收到了，但還送不出去。
          </p>
          <p class="ctTodoT">還差 {{ problems.length }} 項</p>
          <ul>
            <li v-for="p in problems" :key="p.anchor + p.msg">
              <button type="button" class="ctTodoItem" @click="goTo(p.anchor)">
                <span>{{ p.msg }}</span>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </li>
          </ul>
        </div>
      </form>

      <!-- ── 個資揭露 ────────────────────────────────────────────────
           逐項寫「收什麼、給誰看、留多久」，體例跟隱私權政策同一套
           （那一頁是逐欄位寫的，不寫「您的個人資料」這種概括說法）。
           放在送出鍵**下方**是刻意的：它是承諾不是門檻，
           擋在表單前面只會讓真的有急事的人跳過不讀。 -->
      <section class="ctPriv">
        <h2 class="ctPrivT">這張表單收了什麼、誰看得到、留多久</h2>
        <dl class="ctPrivDl">
          <dt>收什麼</dt>
          <dd>
            你在上面填的<b>主題、稱呼、Email、訊息內文</b>；
            以及來源網路位址的<b>雜湊值</b>（不是位址本身，無法反查，只用來擋機器人灌訊息）。
            已登入時另外記下<b>你的帳號 id</b>。沒有其他欄位。
          </dd>
          <dt>誰看得到</dt>
          <dd>只有平台的客服與管理員，在後台的「聯絡訊息」裡。不會提供給賣家或任何其他會員。</dd>
          <dt>留多久</dt>
          <dd>
            客服標記處理完成之後 <b>180 天</b>刪除。
            <b>還沒處理的不會自動刪除</b> —— 沒回覆完就刪掉等於把你的問題丟掉。
          </dd>
          <dt>不會拿去做什麼</dt>
          <dd>不寄行銷信、不做側寫、不轉給第三方，內容也不會被轉寄到你之外的任何地址。</dd>
        </dl>
        <p class="ctPrivMore">
          完整版見<RouterLink :to="{ name: 'privacy' }">隱私權政策</RouterLink>，
          你對自己資料的權利寫在該頁第六節。
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* 深淺兩套主題都靠 tokens.css 的權杖，這一頁沒有任何寫死的顏色 */
.page { padding-top: 18px; padding-bottom: 56px; max-width: 640px; }

.ctHead { margin-bottom: 18px; }
.ctTitle { font-size: 24px; margin: 2px 0 10px; }
.ctLede { margin: 0; font-size: 13.5px; line-height: 1.9; color: var(--muted); }

.ctHow {
  padding: 14px 16px; margin-bottom: 14px; min-width: 0;
  background: var(--accent-wash); border-radius: var(--radius);
}
.ctHowT { margin: 0 0 6px; font-size: 14px; font-weight: 700; color: var(--ink); }
.ctHowP { margin: 0; font-size: 12.5px; line-height: 1.85; color: var(--muted); }

.ctLogged {
  padding: 12px 14px; margin-bottom: 18px; min-width: 0;
  background: var(--surface-2); border-radius: var(--radius);
}
.ctLoggedT {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}
.ctLoggedAlt {
  margin: 8px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--muted);
}
.ctLoggedP { margin: 0; font-size: 12.5px; line-height: 1.85; color: var(--muted); overflow-wrap: anywhere; }
/* 連結也要 44px 觸控高。inline-flex + min-height，不是靠字級撐 */
.ctLoggedGo {
  display: inline-flex; align-items: center; min-height: 44px;
  font-size: 12.5px; color: var(--accent); text-decoration: none;
}
.ctLoggedGo:hover { text-decoration: underline; }

.ctForm { display: grid; gap: 20px; min-width: 0; }
.ctSec { min-width: 0; display: grid; gap: 8px; }
.ctLabel { font-size: 13.5px; font-weight: 700; margin: 0; }

.ctTopics { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
.ctTopic {
  min-height: 44px; padding: 0 16px; min-width: 0;
  border-radius: var(--pill); border: 1px solid var(--line);
  background: var(--surface); color: var(--ink);
  font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer;
}
.ctTopic.on { background: var(--accent); border-color: transparent; color: var(--on-accent); }
.ctTopic:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

.ctHint { margin: 0; font-size: 12px; line-height: 1.85; color: var(--muted); }

.ctField { display: grid; gap: 6px; min-width: 0; }
.ctInput {
  width: 100%; min-width: 0; min-height: 44px;
  padding: 10px 13px;
  border-radius: var(--radius); border: 1px solid var(--line);
  background: var(--field); color: var(--ink);
  font: inherit; font-size: 15px;
}
.ctInput:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/* 邊框只負責「哪一格」，「缺什麼」由底下那行用字說 —— 一圈紅框解釋不了自己 */
.ctInput.bad { border-color: var(--danger); }
.ctMiss { margin: 0; font-size: 12px; line-height: 1.6; color: var(--danger-ink); }
.ctArea { resize: vertical; line-height: 1.8; font-size: 14.5px; min-height: 150px; }

.ctCount { justify-self: end; font-size: 11px; color: var(--faint); margin: 0; }
.ctCount.near { color: var(--warn-ink); }

.ctErr {
  margin: 0; padding: 12px 14px;
  background: var(--danger-wash); color: var(--danger-ink);
  border-radius: var(--radius); font-size: 13px; line-height: 1.75;
  overflow-wrap: anywhere;
}

.ctGo { width: 100%; min-height: 50px; }
.ctGo.notyet { background: var(--surface-3); color: var(--muted); border-color: var(--line); }

.ctTodo { padding: 12px 14px; background: var(--warn-wash); border-radius: var(--radius); min-width: 0; }
.ctTodoHit {
  margin: 0 0 6px; font-size: 13px; font-weight: 700; color: var(--warn-ink);
  animation: ctHit .28s ease-out;
}
@keyframes ctHit {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) { .ctTodoHit { animation: none; } }
.ctTodoT { margin: 0 0 6px; font-size: 12.5px; font-weight: 600; color: var(--warn-ink); }
.ctTodo ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.ctTodoItem {
  width: 100%; min-height: 44px; min-width: 0;
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 0 4px; border: 0; background: none; cursor: pointer;
  color: var(--warn-ink); font: inherit; font-size: 12.5px; text-align: left;
}
.ctTodoItem span { min-width: 0; overflow-wrap: anywhere; }
.ctTodoItem svg { flex: none; }

/* 個資揭露。體例跟隱私權政策同一套：逐項、講到欄位，不寫概括說法 */
.ctPriv {
  margin-top: 26px; padding: 16px;
  background: var(--surface); border: 1px solid var(--line-soft); border-radius: var(--radius);
  min-width: 0;
}
.ctPrivT { margin: 0 0 12px; font-size: 13.5px; font-weight: 700; }
.ctPrivDl { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 8px 12px; margin: 0; }
.ctPrivDl dt { font-size: 12px; color: var(--faint); }
.ctPrivDl dd { margin: 0; font-size: 12.5px; line-height: 1.85; color: var(--muted); overflow-wrap: anywhere; }
.ctPrivMore { margin: 12px 0 0; font-size: 12px; line-height: 1.85; color: var(--faint); }
/* 內文裡的連結一樣要有 44px 的可點高度，用負外距抵銷視覺影響
   （同 App.vue 頁尾那幾條連結的做法：長出來的只有可以點的範圍） */
.ctPrivMore a, .ctDoneP a {
  color: var(--accent); display: inline-block; padding: 13px 4px; margin: -13px 0;
}

/* ── 回執 ── */
.ctDone { padding-top: 8px; }
.ctDoneNo {
  margin: 0 0 14px; padding: 12px 14px;
  background: var(--ok-wash); color: var(--ok-ink);
  border-radius: var(--radius); font-size: 13.5px; overflow-wrap: anywhere;
}
.ctDoneP { margin: 0 0 12px; font-size: 13px; line-height: 1.9; color: var(--muted); }
.ctHome {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 48px; padding: 0 22px; margin-top: 8px; text-decoration: none;
}

/* 窄螢幕（393px）上定義清單的固定左欄會把右邊擠成一條，改成上下堆疊 */
@media (max-width: 420px) {
  .ctPrivDl { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .ctPrivDl dd { margin-bottom: 8px; }
}
</style>
