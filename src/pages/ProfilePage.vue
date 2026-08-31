<script setup lang="ts">
/**
 * 會員基本資料。
 *
 * 分兩塊而不是一長串欄位：
 *   站上顯示 —— 別人看得到的
 *   出貨資料 —— 只有平台跟物流看得到
 * 這個界線要在畫面上講清楚，不然使用者填本名時會猶豫。
 *
 * 全部欄位都不強制。要出貨時才需要補齊，那時再擋比較合理——
 * 註冊當下就要人填地址是流失使用者最快的方法。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { MOCK } from '@/lib/config'
import { http, ApiError } from '@/lib/http'
import { useAuthStore } from '@/stores/auth'
import { useMediaQuery } from '@/composables/useMediaQuery'

interface Profile {
  handle: string; memberNo?: string | null; name: string
  displayName: string | null; realName: string | null; phone: string | null
  addressZip: string | null; addressCity: string | null; addressLine1: string | null
  birthday: string | null
}

const router = useRouter()
const auth = useAuthStore()

const form = ref({
  displayName: '', realName: '', phone: '',
  addressZip: '', addressCity: '', addressLine1: '', birthday: ''
})
const handle = ref('')
const loading = ref(true)
const memberNo = ref('')
const copiedNo = ref(false)
async function copyMemberNo() {
  const v = memberNo.value || handle.value
  if (!v) return
  try {
    await navigator.clipboard.writeText(v)
    copiedNo.value = true
    setTimeout(() => { copiedNo.value = false }, 2000)
  } catch { /* 剪貼簿被拒也沒關係，編號本來就看得到、也可以長按選取 */ }
}

const busy = ref(false)
/**
 * 載入失敗與**送出結果**是兩件事，畫在兩個地方。
 *
 * 原本共用頁面最上方那一格。載入失敗時使用者就在頁首，看得到；
 * 但按「儲存」的時候他已經捲到表單最下面 —— 實測儲存鈕在 top 590、
 * 錯誤訊息在 top **-339**（視窗上方 339px），而且頁面不會自己捲過去。
 * 使用者看到的是「按了沒反應」，於是再按一次、再一次，最後以為資料存好了
 * 就去申請出貨，發現地址還是空的。
 *
 * 這不是 mock 的 404 才有的問題：正式環境的驗證失敗、連線中斷、
 * session 過期，走的是同一條路、畫在同一個看不到的地方。
 */
const loadErr = ref('')
/** 送出的結果。成功與失敗共用同一個位置：使用者按完鈕，眼睛就在那裡 */
const saveMsg = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const saveMsgEl = ref<HTMLElement | null>(null)
/* 捲動用 smooth，除非使用者要求減少動態 —— 瞬移會讓人分不清是捲動還是換頁 */
const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

/**
 * 把結果講出來，並且**確保它在眼前**。
 *
 * 光是把訊息搬到按鈕旁邊還不夠：軟鍵盤收起來、表單長度變動，都可能讓
 * 動作列剛好落在視窗外。所以訊息一出現就主動捲到它 —— 已經在視窗內時
 * scrollIntoView 幾乎不動，不會製造多餘的跳動。
 */
async function say(kind: 'ok' | 'err', text: string) {
  saveMsg.value = { kind, text }
  await nextTick()
  saveMsgEl.value?.scrollIntoView({
    behavior: reduceMotion.value ? 'auto' : 'smooth',
    block: 'center'
  })
}

/** 出貨需要的欄位是否齊全 —— 讓使用者知道還差什麼，而不是等到出貨才被擋 */
const shipReady = computed(() =>
  !!form.value.realName.trim() && !!form.value.phone.trim() &&
  !!form.value.addressCity.trim() && !!form.value.addressLine1.trim()
)

async function load() {
  if (MOCK) { loading.value = false; return }
  try {
    const r = await http<{ profile: Profile }>('/v1/auth/profile')
    const p = r.profile
    handle.value = p.handle
    memberNo.value = p.memberNo ?? ''
    form.value = {
      displayName: p.displayName ?? p.name ?? '',
      realName: p.realName ?? '', phone: p.phone ?? '',
      addressZip: p.addressZip ?? '', addressCity: p.addressCity ?? '',
      addressLine1: p.addressLine1 ?? '', birthday: p.birthday ?? ''
    }
  } catch (e) {
    loadErr.value = e instanceof ApiError ? e.message : '載入失敗'
  } finally {
    loading.value = false
  }
}

async function save() {
  busy.value = true
  saveMsg.value = null
  try {
    await http('/v1/auth/profile', { method: 'PUT', json: form.value })
    await say('ok', '已儲存。出貨資料下次申請出貨時會自動帶入。')
    // 暱稱會影響全站顯示，重新抓一次讓標頭那些地方立刻跟上
    await auth.refresh()
  } catch (e) {
    /* 失敗要講「還沒存進去」，不能只回一句錯誤碼就算了 ——
       使用者接下來會不會重填，取決於他知不知道剛才那次沒生效。 */
    const why = e instanceof ApiError ? e.message : '儲存失敗'
    await say('err', `${why} —— 這次的修改還沒存進去，請再試一次。`)
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="container page prof">
    <header class="head">
      <h1>會員資料</h1>
      <!-- 會員編號放在最上面而且可以一鍵複製：客服、出貨、爭議都靠它認人，
           使用者被問到時要能立刻找得到、念得出來（編號刻意不含 I/L/O/U，
           就是為了念的時候不會跟 1 和 0 搞混）。 -->
      <button type="button" class="memberNo" @click="copyMemberNo">
        <span class="lbl">會員編號</span>
        <strong class="mono no">{{ memberNo || handle || '—' }}</strong>
        <span class="act">{{ copiedNo ? '已複製' : '複製' }}</span>
      </button>
      <p class="sub muted">查詢訂單、出貨、客服都用這組編號，不會變動。</p>
    </header>

    <p v-if="MOCK" class="msg warn">展示模式沒有連後端，這頁的儲存不會生效。</p>
    <!-- 只有「載入失敗」留在頁首。它發生時使用者還在頁首，看得到；
         送出的結果則畫在動作列旁邊（見表單最下方）。 -->
    <p v-if="loadErr" class="msg err" role="alert">{{ loadErr }}</p>
    <p v-if="loading" class="muted">載入中…</p>

    <form v-else @submit.prevent="save">
      <section class="card block">
        <h2>站上顯示</h2>
        <p class="note muted">其他使用者看得到的資訊。</p>
        <label>
          暱稱
          <input v-model="form.displayName" type="text" maxlength="20" placeholder="例如：小明" />
          <span class="hint">留空的話會沿用目前的名稱。</span>
        </label>
      </section>

      <section class="card block">
        <div class="blockHead">
          <h2>出貨資料</h2>
          <span class="pill" :class="shipReady ? 'ok' : 'todo'">
            {{ shipReady ? '已完整' : '尚未填完' }}
          </span>
        </div>
        <p class="note muted">
          只有平台與物流看得到，不會出現在市場或任何公開頁面。
          申請卡片出貨時會自動帶入，不用每次重打。
        </p>

        <label>
          收件人姓名
          <input v-model="form.realName" type="text" maxlength="40" autocomplete="name" placeholder="須與證件相符" />
        </label>
        <label>
          手機
          <input v-model="form.phone" type="tel" maxlength="20" autocomplete="tel" placeholder="09xxxxxxxx" />
        </label>
        <div class="row2">
          <label>
            郵遞區號
            <input v-model="form.addressZip" type="text" maxlength="10" autocomplete="postal-code" inputmode="numeric" placeholder="選填" />
          </label>
          <label class="grow">
            縣市
            <input v-model="form.addressCity" type="text" maxlength="40" autocomplete="address-level1" placeholder="例如：台北市" />
          </label>
        </div>
        <label>
          地址
          <input v-model="form.addressLine1" type="text" maxlength="120" autocomplete="street-address" placeholder="路名、門牌、樓層" />
        </label>
      </section>

      <section class="card block">
        <h2>其他</h2>
        <label>
          生日
          <input v-model="form.birthday" type="date" />
          <span class="hint">未滿 18 歲需監護人同意才能使用本站。</span>
        </label>
      </section>

      <!-- 送出的結果就長在按鈕正上方：使用者按完鈕，視線與拇指都在這裡。
           成功與失敗共用同一格，位置固定，不用去別的地方找答案。 -->
      <p
        v-if="saveMsg" ref="saveMsgEl"
        class="result" :class="saveMsg.kind"
        :role="saveMsg.kind === 'err' ? 'alert' : 'status'"
      >{{ saveMsg.text }}</p>

      <div class="acts">
        <button type="button" class="btn" @click="router.back()">返回</button>
        <button type="submit" class="btn primary" :disabled="busy">
          {{ busy ? '儲存中…' : '儲存' }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
/* 會員編號：這頁最重要的一行，做成可點的複製鈕而不是一段小灰字 */
.memberNo {
  display: flex; align-items: center; gap: 10px; width: 100%;
  margin: 4px 0 8px; padding: 11px 14px;
  border: 1px solid var(--line); border-radius: 12px;
  background: var(--surface-2); color: var(--ink);
  font: inherit; text-align: left; cursor: pointer;
}
.memberNo:hover { background: var(--surface-3); }
.memberNo .lbl { font-size: 12px; color: var(--muted); flex: none; }
.memberNo .no {
  flex: 1; min-width: 0; font-size: 17px; letter-spacing: .06em;
  /* 編號要能長按選取複製 —— touch.css 的逃生門已經涵蓋 .mono，這裡不再壓制 */
}
.memberNo .act { flex: none; font-size: 12px; font-weight: 600; color: var(--accent); }

/* 安全區與底部導覽一起由頁尾讓位（見 App.vue）—— 這裡再加一次 --safe-b
   等於把 Home 指示器的高度算兩遍 */
.prof { padding-bottom: 48px; max-width: 560px; }
.head { margin-bottom: 16px; }
h1 { font-size: 22px; margin: 0 0 6px; }
.sub { font-size: 13px; line-height: 1.7; margin: 0; }
h2 { font-size: 15px; margin: 0 0 4px; }
.note { font-size: 12.5px; line-height: 1.7; margin: 0 0 14px; }
.hint { font-size: 11.5px; color: var(--faint); line-height: 1.6; }

.msg { font-size: 13.5px; margin: 0 0 12px; }
.msg.err { color: var(--danger); }
.msg.warn { color: var(--warn); }

.block { padding: 18px; margin-bottom: 12px; display: grid; gap: 12px; }
.blockHead { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.blockHead h2 { margin: 0; }
.pill { font-size: 11.5px; font-weight: 700; padding: 3px 10px; border-radius: var(--pill); white-space: nowrap; }
.pill.ok { background: var(--ok-wash); color: var(--ok); }
.pill.todo { background: var(--warn-wash); color: var(--warn); }

label { display: grid; gap: 5px; font-size: 12.5px; color: var(--muted); }
input {
  width: 100%; min-height: 46px; padding: 10px 14px; font-size: 15px;
  background: var(--field); border: 1px solid var(--line);
  border-radius: var(--radius); color: var(--ink);
}
input:focus-visible { outline: 2px solid var(--holo-a); outline-offset: 1px; }
.row2 { display: grid; grid-template-columns: 110px 1fr; gap: 10px; }
.row2 .grow { min-width: 0; }

/* 結果訊息：描一圈底色而不是一行純文字色 —— 它在一排白卡片之間出現，
   沒有底色的話跟上面的欄位說明長得一樣，掃過去會看不到它變了。 */
.result {
  margin: 16px 0 0; padding: 12px 14px;
  border-radius: var(--radius);
  font-size: 13.5px; line-height: 1.65;
}
.result.ok { background: var(--ok-wash); color: var(--ok-ink); }
/* 字色用 --*-ink 不是 --ok / --danger：淺色主題的 wash 幾乎是白的，
   直接用狀態色對比只有 2.6，讀不到（見 tokens.css 那行說明）。 */
.result.err { background: var(--danger-wash); color: var(--danger-ink); }

.acts { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
/* 44px 是拇指的最小可靠命中範圍。這兩顆是這頁唯二的動作，
   按不準的代價是使用者以為自己按到了、其實沒有。 */
.acts .btn { min-height: 44px; padding: 12px 24px; }
</style>
