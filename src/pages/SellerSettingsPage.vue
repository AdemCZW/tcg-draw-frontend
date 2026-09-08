<script setup lang="ts">
/**
 * 賣家設定 —— 目前只有一件事：買家聯絡得到你的方式。
 *
 * ── 為什麼要有這一欄 ────────────────────────────────────────────────
 * 買家沒去超商取貨、包裹退回賣家手上時，平台不介入，交付與否由雙方自己談。
 * 但那條路現在只有一半：賣家看得到買家的姓名電話地址（出貨必要），
 * 買家看得到的只有賣家的名字與統計 —— 沒有電話、沒有 LINE，站上也沒有私訊。
 * 「自己去談」在買家那一側根本開不了口。這一欄就是那條路的前提，
 * 所以後端把它擋在**上架之前**（NEED_CONTACT），而不是等出事才要人補。
 *
 * ── 為什麼獨立一頁 ──────────────────────────────────────────────────
 * 它不是開池表單的一格，也不是會員資料的一格：
 *   - 開池（/seller/new）是一次性的申請動作，這一欄是會改的（換號碼、改用 LINE）
 *   - 會員資料裡的電話是**物流用的個資**，從來不對外；這一欄相反，
 *     它會被有訂單關係的買家看到。兩者混在同一頁，使用者會分不出
 *     哪一格是私的、哪一格是公開的，而分錯的方向是把私人號碼公開出去。
 * 後端的 NEED_CONTACT 訊息也是叫人來「賣家設定」，所以這裡要有一個
 * 連得到、講得清楚的落點。
 *
 * 文案的重點只有一個：**這會被買家看到**。寫得含糊的話，賣家會以為它是
 * 平台內部欄位而隨手填一支不想被打的私人號碼。
 */
import { computed, onMounted, ref } from 'vue'
import { api } from '@/lib/api'
import { ApiError } from '@/lib/http'
import type { SellerContact } from '@/types/models'

/** 三種種類各自要講不同的話：提示、輸入模式、以及買家那側能不能直接撥 */
const KINDS: { k: SellerContact['kind']; label: string; hint: string; ph: string }[] = [
  { k: 'phone', label: '手機', hint: '買家可以直接撥給你。', ph: '09xx-xxx-xxx' },
  { k: 'line', label: 'LINE ID', hint: '買家只能複製後自己搜尋加你 —— 記得先把「允許被加入好友」打開。', ph: '你的 LINE ID' },
  { k: 'other', label: '其他', hint: '例如 IG 帳號、電子郵件。買家只能複製，平台不會替你轉接。', ph: 'IG 帳號、email…' }
]

const loading = ref(true)
const loadErr = ref('')
/** null = 還不是賣家（後端的 NOT_SELLER）。這一頁要分得出它跟「讀不到」 */
const isSeller = ref(false)
const saved = ref<SellerContact | null>(null)

const kind = ref<SellerContact['kind']>('phone')
const value = ref('')

const busy = ref(false)
const err = ref('')
const okMsg = ref('')

async function load() {
  loading.value = true
  loadErr.value = ''
  try {
    const r = await api.sellerStatus()
    isSeller.value = !!r.seller
    saved.value = r.seller?.contact ?? null
    if (saved.value) {
      kind.value = saved.value.kind
      value.value = saved.value.value
    }
  } catch (e) {
    /* 「問不到」不是「你不是賣家」。壓成後者的話，一個已核准的賣家會在
       後端冷啟動的那一刻看到「你還不是賣家」—— 他會以為資格被取消了。
       （同 SellerNewPoolPage 的 loadErr 那段判斷。） */
    loadErr.value = e instanceof ApiError ? e.message : '連不上伺服器，請檢查網路後重試'
  } finally {
    loading.value = false
  }
}
onMounted(load)

const trimmed = computed(() => value.value.trim())
/* 灰按鈕要說得出理由。長度上下限跟後端同一組（3～64），不然畫面說可以、
   送出去被退回 400，而使用者看不出哪裡不一樣。
   格式不驗：LINE ID 沒有公開的權威規則，把合法的 ID 擋下來比放進一個
   怪字串更糟 —— 真正會發現填錯的是聯絡不上的買家。 */
const blockWhy = computed(() => {
  if (busy.value) return ''
  if (!trimmed.value) return '還差：填一個買家找得到你的方式。'
  if (trimmed.value.length < 3) return '還差：太短了，至少 3 個字。'
  if (trimmed.value.length > 64) return `太長了，最多 64 個字（目前 ${trimmed.value.length} 個）。`
  return ''
})
const dirty = computed(() =>
  !saved.value || saved.value.kind !== kind.value || saved.value.value !== trimmed.value)
const ready = computed(() => !blockWhy.value && dirty.value)

async function save() {
  if (!ready.value || busy.value) return
  busy.value = true
  err.value = ''
  okMsg.value = ''
  try {
    const r = await api.updateSellerContact({ kind: kind.value, value: trimmed.value })
    saved.value = r.contact
    kind.value = r.contact.kind
    value.value = r.contact.value
    okMsg.value = '已儲存。跟你有訂單關係的買家，從現在起在他的訂單頁看得到這個聯絡方式。'
  } catch (e) {
    /* 後端的 400 / 404 訊息是中文、寫給使用者看的，直接顯示不要改寫 ——
       NOT_SELLER 那一句還會指路（請先送出賣家申請）。 */
    err.value = e instanceof ApiError ? e.message : '儲存失敗，請稍後再試'
    if (e instanceof ApiError && e.code === 'NOT_SELLER') isSeller.value = false
  } finally {
    busy.value = false
  }
}

const curHint = computed(() => KINDS.find(x => x.k === kind.value)?.hint ?? '')
const curPh = computed(() => KINDS.find(x => x.k === kind.value)?.ph ?? '')
</script>

<template>
  <div class="container page">
    <header class="head">
      <RouterLink :to="{ name: 'me' }" class="back">← 我的</RouterLink>
      <h1>賣家設定</h1>
    </header>

    <p v-if="loading" class="muted">載入中…</p>

    <div v-else-if="loadErr" class="loadFail" role="alert">
      <p class="muted">{{ loadErr }}</p>
      <button type="button" class="btn" @click="load">重試</button>
    </div>

    <!-- 還不是賣家：這一頁對他沒有東西可以填，但要給得出下一步 -->
    <section v-else-if="!isSeller" class="note" role="status">
      <p class="noteT">你還不是賣家</p>
      <p class="noteB">
        填聯絡方式之前要先有賣家身分。送出申請之後回來這一頁，
        上架前把這一欄填好就不會被擋。
      </p>
      <RouterLink class="goBtn" :to="{ name: 'seller-new' }">去送出賣家申請</RouterLink>
    </section>

    <template v-else>
      <section class="why">
        <h2 class="whyH">買家聯絡得到你的方式</h2>
        <p class="whyB">
          <b>這一欄會給買家看。</b>跟你有訂單關係的買家，在他的訂單頁上看得到並複製得走，
          <b>不限訂單狀態</b> —— 訂單結案之後也還看得到。
        </p>
        <ul class="whyL">
          <li>
            這是<b>對外</b>的聯絡方式，跟會員資料裡那支寄件用的電話是兩回事 ——
            那一支從來不對外。想填同一支可以，但要你自己打進來。
          </li>
          <li>
            買家沒去取貨、包裹被退回你手上時，平台不介入，重寄與運費由你們自己談。
            買家那一側現在只有這一欄找得到你。
          </li>
          <li><b>上架前必填</b>：沒填的話上架會被擋下來。</li>
        </ul>
      </section>

      <section class="form card">
        <fieldset class="kinds">
          <legend class="lg">種類</legend>
          <label v-for="k in KINDS" :key="k.k" class="kind" :class="{ on: kind === k.k }">
            <input v-model="kind" type="radio" :value="k.k" name="contactKind">
            <span>{{ k.label }}</span>
          </label>
        </fieldset>

        <label class="field">
          <span class="lg">內容</span>
          <input
            v-model="value" type="text" :placeholder="curPh"
            :inputmode="kind === 'phone' ? 'tel' : 'text'"
            autocomplete="off" maxlength="64"
          >
        </label>
        <p class="hint">{{ curHint }}</p>

        <p v-if="blockWhy" id="contactWhy" class="blockWhy" role="status">{{ blockWhy }}</p>
        <div class="acts">
          <button
            type="button" class="btn primary" data-testid="contact-save"
            :disabled="!ready || busy"
            :aria-describedby="blockWhy ? 'contactWhy' : undefined"
            @click="save"
          >{{ busy ? '儲存中…' : saved ? '更新聯絡方式' : '儲存' }}</button>
          <span v-if="saved && !dirty" class="cur">目前設定：{{ KINDS.find(k => k.k === saved!.kind)?.label }}・{{ saved!.value }}</span>
        </div>

        <p v-if="err" class="err" role="alert">{{ err }}</p>
        <p v-if="okMsg" class="ok" role="status">{{ okMsg }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page { padding-top: 20px; padding-bottom: 72px; max-width: 640px; }
.head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
/* 返回鍵撐到 44px 用 inline-flex，不用 padding —— 才不會把標題那一列推下去 */
.back {
  font-size: 13px; color: var(--muted); text-decoration: none;
  display: inline-flex; align-items: center; min-height: 44px;
}
h1 { font-size: 20px; margin: 0; }

.loadFail { display: grid; justify-items: center; gap: 12px; padding: 36px 16px; text-align: center; }
.loadFail p { margin: 0; }

/* 還不是賣家：一塊說明加一條出路，不是錯誤訊息 */
.note {
  margin: 8px 0 0; padding: 12px 14px;
  border-inline-start: 3px solid var(--warn);
  border-radius: 0 10px 10px 0;
  background: var(--surface-2);
}
.noteT { margin: 0 0 6px; font-size: 13.5px; font-weight: 700; color: var(--ink); }
.noteB { margin: 0 0 10px; font-size: 12.5px; line-height: 1.75; color: var(--muted); }
.goBtn {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 44px; padding: 11px 18px;
  border-radius: var(--pill); background: var(--accent-wash);
  color: var(--accent); font-size: 13px; font-weight: 600; text-decoration: none;
}
.goBtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.why { margin-bottom: 14px; }
.whyH { font-size: 15px; margin: 0 0 6px; }
.whyB { margin: 0 0 8px; font-size: 13px; line-height: 1.8; color: var(--muted); }
.whyB b, .whyL b { color: var(--ink); font-weight: 600; }
.whyL {
  margin: 0; padding-inline-start: 18px;
  display: flex; flex-direction: column; gap: 6px;
  font-size: 12.5px; line-height: 1.7; color: var(--muted);
  /* 長字串（LINE ID、email）收得住，手機上不能橫向溢出 */
  overflow-wrap: anywhere;
}

.form { padding: 14px; display: grid; gap: 12px; }
.lg { font-size: 12px; color: var(--muted); }
.kinds { border: 0; margin: 0; padding: 0; display: grid; gap: 8px; }
/* auto-fit + minmax(0, …)：窄螢幕自己換行，三顆都保得住 44px */
.kinds { grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); }
.kinds .lg { grid-column: 1 / -1; }
.kind {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 44px; min-width: 0; padding: 0 10px;
  border: 1px solid var(--line); border-radius: var(--pill);
  background: var(--surface-2); color: var(--muted);
  font-size: 13px; font-weight: 600; cursor: pointer;
  overflow-wrap: anywhere; text-align: center;
}
.kind.on { border-color: var(--accent); background: var(--accent-wash); color: var(--accent); }
/* 原生 radio 藏起來但留在無障礙樹裡（不是 display:none）—— 鍵盤與讀屏
   仍然走它，選中的樣式由 .on 畫 */
.kind input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.kind:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }

.field { display: grid; gap: 5px; min-width: 0; }
.field input {
  min-height: 44px; min-width: 0;
  padding: 10px 12px; font: inherit; font-size: 16px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--field, var(--surface-2)); color: var(--ink);
}
.field input:focus { outline: none; border-color: var(--accent); }
.hint { margin: -6px 0 0; font-size: 11.5px; line-height: 1.7; color: var(--faint); overflow-wrap: anywhere; }

/* 灰按鈕的理由。用 --warn-ink 不用 --danger：使用者沒做錯事，只是還沒填完 */
.blockWhy { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--warn-ink); overflow-wrap: anywhere; }
.acts { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.cur { min-width: 0; font-size: 12px; line-height: 1.6; color: var(--muted); overflow-wrap: anywhere; }

.err { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--danger-ink); overflow-wrap: anywhere; }
.ok { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--ok-ink); overflow-wrap: anywhere; }
</style>
