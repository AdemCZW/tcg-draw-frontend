<script setup lang="ts">
/**
 * 這個帳號有哪些登入方式，以及怎麼補上另一種。
 *
 * 重點是讓使用者清楚：補綁不會換帳號。用 LINE 註冊的人補了 Email 之後，
 * 兩種方式登入的是同一個帳號、同一批卡、同一筆點數。
 * 這件事不講明白，沒有人敢按。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { MOCK, API_URL } from '@/lib/config'
import { http, token, ApiError } from '@/lib/http'
import { useKeyboardInset } from '@/composables/useKeyboardInset'

interface Methods { email: string | null; hasPassword: boolean; providers: string[] }
const methods = ref<Methods | null>(null)
const loading = ref(false)
const err = ref('')
const okMsg = ref('')

const showForm = ref(false)
const email = ref('')
const password = ref('')
const currentPassword = ref('')
const busy = ref(false)

const hasLine = computed(() => methods.value?.providers.includes('line') ?? false)

/* ---- 送不出去的時候要說得出是哪幾項 ----
   這顆「儲存」原本被三個條件擋著，畫面上一個字都沒講：Email 的格式、
   密碼的長度、以及（已經有密碼時）要先驗證舊密碼。使用者看到的是一顆
   按不動的按鈕，他的結論是「這功能壞了」而不是「我還沒填完」。

   門檻的數字一定要寫出來 ——「填了還是灰的」比「空的」更難自己脫困：
   密碼打了 6 碼還是灰的時候，只說「還差 密碼」等於沒說。目前碼數也一起報，
   因為密碼欄是遮起來的，使用者數不出自己打了幾個字。 */
const authMissing = computed(() => {
  const miss: string[] = []
  if (!/.+@.+\..+/.test(email.value.trim())) miss.push('Email（要有 @ 與網域，例如 you@example.com）')
  if (password.value.length < 8) {
    miss.push(`${methods.value?.hasPassword ? '新密碼' : '密碼'}（至少 8 碼，目前 ${password.value.length} 碼）`)
  }
  /* 舊密碼只有「這個帳號已經設過密碼」時才要 —— 沒設過的人根本沒有舊密碼，
     把它列進清單等於叫人去填一個不存在的東西。 */
  if (methods.value?.hasPassword && !currentPassword.value.length) miss.push('目前的密碼')
  return miss
})
const canSubmit = computed(() => authMissing.value.length === 0)
const blockWhy = computed(() => {
  if (busy.value) return ''
  return authMissing.value.length ? `還差：${authMissing.value.join('、')}。` : ''
})

const route = useRoute()

async function load() {
  if (MOCK) return
  loading.value = true
  try { methods.value = await http<Methods>('/v1/auth/methods') }
  catch (e) { err.value = e instanceof ApiError ? e.message : '載入失敗' }
  finally { loading.value = false }
}

/* 開關拆成兩支函式而不是 showForm = !showForm：開的時候要重置欄位。
   密碼留在記憶體裡跨兩次開啟是沒必要的風險，而且上一次失敗留下的錯誤訊息
   會跟著新的一次一起出現，看起來像才剛按下去就失敗了。 */
function openForm() {
  email.value = methods.value?.email ?? ''
  password.value = ''
  currentPassword.value = ''
  err.value = ''
  showForm.value = true
  /* 覆蓋層是 aria-modal，焦點要進去，不然按 Tab 會走到它背後那些讀不到的東西。
     聚焦面板本身而不是第一個輸入框：手機上直接聚焦輸入框會馬上叫出鍵盤，
     使用者還沒看清楚這張面板在問什麼，畫面就先少了一半。 */
  void nextTick(() => document.getElementById('loginMethodSheet')?.focus())
}
function closeForm() { showForm.value = false }

async function save() {
  if (!canSubmit.value || busy.value) return
  busy.value = true
  err.value = ''
  try {
    await http('/v1/auth/set-password', { method: 'POST', json: {
      email: email.value.trim(), password: password.value,
      ...(methods.value?.hasPassword ? { currentPassword: currentPassword.value } : {})
    } })
    okMsg.value = '已加上 Email 登入。之後兩種方式都會進到這個帳號。'
    showForm.value = false
    password.value = ''
    currentPassword.value = ''
    await load()
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : '設定失敗'
  } finally {
    busy.value = false
  }
}

/* 綁 LINE：先以 Authorization header 向後端取得授權網址，再整頁導向 LINE。
   JWT 不進 URL，才不會被代理或伺服器存取日誌收走。 */
async function linkLine() {
  if (!token.get() || busy.value) return
  busy.value = true
  err.value = ''
  try {
    const { url } = await http<{ url: string }>('/v1/auth/line/link/start', { method: 'POST' })
    window.location.href = url
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : 'LINE 綁定沒有完成，請再試一次'
    busy.value = false
  }
}

function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && showForm.value) closeForm()
}

/* 軟鍵盤讓位（--kb）。這張面板有兩到三個輸入框，鍵盤必然會彈出來，
   而動作列黏在面板下緣 —— 不讓位的話送出鍵會躲到鍵盤底下。
   跟出貨面板、出價面板同一支 composable。 */
useKeyboardInset()

onMounted(() => {
  load()
  window.addEventListener('keydown', onEsc)
  const r = typeof route.query.line === 'string' ? route.query.line : ''
  if (r === 'linked') okMsg.value = '已綁定 LINE。之後用 LINE 登入會進到這個帳號。'
  else if (r === 'taken') err.value = '這個 LINE 帳號已經綁在別的帳號上了'
  else if (r === 'badtoken') err.value = '登入狀態已過期，請重新登入再試一次'
})
onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))
</script>

<template>
  <section v-if="!MOCK" class="lm">
    <h2>登入方式</h2>
    <p class="hint">
      多綁一種方式不會換帳號 —— 你的卡、點數、訂單都還在同一個帳號底下，
      只是多一條進得來的路。
    </p>

    <p v-if="err && !showForm" class="msg err" role="alert">{{ err }}</p>
    <p v-if="okMsg" class="msg ok" role="status">{{ okMsg }}</p>
    <p v-if="loading" class="muted small">載入中…</p>

    <ul v-if="methods" class="list">
      <li class="item">
        <span class="ico line" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.6 2 11c0 3.9 3.5 7.2 8.2 7.9.3.1.8.2.9.5.1.3.1.7 0 1l-.1.9c0 .3-.2 1 .9.6s5.9-3.5 8.1-6c1.5-1.6 2-3.3 2-4.9C22 6.6 17.5 3 12 3z"/></svg>
        </span>
        <div class="txt">
          <strong>LINE</strong>
          <span class="muted small">{{ hasLine ? '已綁定' : '尚未綁定' }}</span>
        </div>
        <button v-if="!hasLine" type="button" class="btn sm" @click="linkLine">綁定</button>
        <!-- 已綁定的狀態左邊那行字已經講過了，這裡只補一個圖形訊號。
             用 inline SVG 不用符號字元：勾號在各家字型裡粗細差很多，
             而站上的圖示一律是 SVG（見 NotifyBell 的同一條理由）。 -->
        <svg v-else class="tick" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </li>

      <li class="item">
        <span class="ico mail" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M3 6h18v12H3z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m3 7 9 6 9-6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
        </span>
        <div class="txt">
          <strong>Email 與密碼</strong>
          <span class="muted small">{{ methods.email ?? '尚未設定' }}</span>
        </div>
        <button type="button" class="btn sm" @click="openForm">
          {{ methods.hasPassword ? '變更' : '設定' }}
        </button>
      </li>
    </ul>

    <!-- 表單改成貼底覆蓋層，不是就地展開。
         就地展開在這裡是錯的，而且是量得出來的錯：這一區排在「我的」頁最下面，
         表單長在它底下等於一路長到視窗外，而頁面不會跟著捲 —— 使用者按了「設定」
         看到的是一格什麼都沒變的畫面。軟鍵盤再吃掉約 300px，沒有補救空間。

         Teleport 到 body 不是整潔問題：換頁轉場會在頁面容器上加 transform，而
         **祖先只要有 transform，position: fixed 的定位基準就會變成那個祖先而不是
         視窗**（docs/HANDOFF.md 2.2），面板會被推出畫面外並被裁掉。
         .sheetWrap / .sheet / .sheetFoot 跟卡冊的出貨面板、公開卡冊的出價面板
         是同一套：貼底、自己捲、動作列黏在面板下緣。使用者只要學一次。
         關法三種：點遮罩、取消鍵、Esc。 -->
    <Teleport to="body">
      <div v-if="showForm" class="sheetWrap" @click.self="closeForm">
        <form
          id="loginMethodSheet" class="sheet card hasFoot"
          role="dialog" aria-modal="true" aria-label="設定 Email 登入" tabindex="-1"
          novalidate
          @submit.prevent="save"
        >
          <h2 class="sheetH">{{ methods?.hasPassword ? '變更 Email 與密碼' : '設定 Email 登入' }}</h2>
          <p class="muted fine">設好之後，Email 與 LINE 兩種方式登入的都是這個帳號。</p>

          <label class="fld">
            <span class="lb">Email</span>
            <input v-model="email" type="email" autocomplete="email" class="in" placeholder="you@example.com" />
          </label>
          <label v-if="methods?.hasPassword" class="fld">
            <span class="lb">目前的密碼</span>
            <input v-model="currentPassword" type="password" autocomplete="current-password" class="in" />
          </label>
          <label class="fld">
            <span class="lb">{{ methods?.hasPassword ? '新密碼' : '密碼' }}（至少 8 碼）</span>
            <input v-model="password" type="password" autocomplete="new-password" class="in" />
          </label>

          <!-- 動作列黏在面板下緣（.sheetFoot 是 position: sticky）。
               三個欄位加說明在 393px 上已經比半個視窗高，鍵盤一升起來更矮 ——
               動作鈕跟著內容捲的話，要按的那一顆會是第一個被推出去的。 -->
          <div class="sheetFoot">
            <p v-if="err" class="errLine" role="alert">{{ err }}</p>
            <!-- 灰按鈕一定要說得出理由。role="status" 讓讀屏在欄位填好的當下
                 就聽到剩下缺什麼，不必自己去 Tab 一圈猜。 -->
            <p v-if="blockWhy" id="loginMethodWhy" class="blockWhy" role="status">{{ blockWhy }}</p>
            <div class="acts">
              <button
                type="submit" class="btn primary sm"
                :disabled="!canSubmit || busy"
                :aria-describedby="blockWhy ? 'loginMethodWhy' : undefined"
              >{{ busy ? '儲存中…' : '儲存' }}</button>
              <button type="button" class="btn sm" :disabled="busy" @click="closeForm">取消</button>
            </div>
          </div>
        </form>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.lm { margin-top: 28px; }
h2 { font-size: 16px; margin: 0 0 6px; }
.hint { font-size: 12.5px; line-height: 1.75; color: var(--muted); margin: 0 0 14px; max-width: 46ch; }
.small { font-size: 12.5px; }
.msg { font-size: 13px; margin: 0 0 10px; }
.msg.err { color: var(--danger-ink); }
.msg.ok { color: var(--ok-ink); }

.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.item {
  display: flex; align-items: center; gap: 12px;
  background: var(--surface); border-radius: var(--radius-lg); padding: 12px 14px;
}
.ico { flex: none; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; }
.ico svg { width: 19px; height: 19px; }
.ico.line { background: #06C755; color: #fff; }
.ico.line svg { fill: currentColor; }
.ico.mail { background: var(--surface-3); color: var(--muted); }
.txt { display: grid; gap: 1px; flex: 1; min-width: 0; }
.txt strong { font-size: 14px; }
.txt span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tick { flex: none; width: 20px; height: 20px; color: var(--ok-ink); }
/* 「設定 / 變更 / 綁定」是這一列唯一的動作，要吃滿觸控門檻 */
.item .btn.sm { flex: none; min-height: 44px; }

/* ---- 貼底面板 ----
   跟 MyCardsPage 的出貨／回收覆蓋層、PublicCardbookPage 的出價覆蓋層
   同一套視覺與行為。三處要一起改。 */
.sheetWrap {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: flex-end; justify-content: center;
  background: var(--scrim);
  /* 下緣讓給軟鍵盤（--kb 由 useKeyboardInset() 寫進根節點，預設 0） */
  bottom: var(--kb, 0px);
}
.sheet {
  width: 100%; max-width: min(520px, 100vw);
  /* 保險絲：內容壓不住時讓它自己橫捲，不要把面板撐出視窗外被裁掉 */
  overflow-x: hidden;
  /* 88% 而不是 88dvh：.sheetWrap 的高度已經扣掉鍵盤了，
     dvh 量的是整個視窗，鍵盤彈出時算出來的面板會比放得下的還高 */
  max-height: min(88%, 720px); overflow-y: auto; overscroll-behavior: contain;
  border-radius: 18px 18px 0 0;
  padding: 18px 16px calc(18px + var(--safe-b, 0px));
  display: grid; gap: 10px; align-content: start; min-width: 0;
}
.sheet:focus-visible { outline: none; }
.sheetH { font-size: 17px; margin: 0; }
.sheet .fine { margin: -4px 0 2px; font-size: 12.5px; line-height: 1.5; }

/* 底部內距搬進 .sheetFoot，sticky 的 bottom: 0 才貼得到面板真正的下緣，
   不然會浮在 18px 內距上面、露出一條會捲動的縫 */
.sheet.hasFoot { padding-bottom: 0; }
.sheetFoot {
  position: sticky; bottom: 0; z-index: 1;
  /* 負的左右外距讓它撐滿面板寬度，那條分隔線才切得斷、
     看得出「上面會捲、下面不會」 */
  margin: 2px -16px 0;
  padding: 10px 16px calc(12px + var(--safe-b, 0px));
  border-top: 1px solid var(--line);
  background: var(--surface);
  display: grid; gap: 8px; min-width: 0;
}
/* 灰按鈕的理由。用 --warn-ink 不用 --danger：使用者沒做錯事，
   只是還沒填完，紅字會讀成「出錯了」 */
.blockWhy {
  margin: 0; min-width: 0;
  font-size: 12.5px; line-height: 1.55; color: var(--warn-ink);
  overflow-wrap: anywhere;
}
.errLine { margin: 0; min-width: 0; font-size: 12.5px; line-height: 1.55; color: var(--danger-ink); }

.fld { display: grid; gap: 5px; min-width: 0; }
.lb { font-size: 11.5px; color: var(--muted); }
.in {
  width: 100%; min-width: 0;
  min-height: 44px; padding: 10px 14px; font-size: 15px;
  background: var(--field); border: 1px solid var(--line);
  border-radius: var(--radius); color: var(--ink);
}
.in:focus { outline: none; border-color: var(--accent); }
/* 主要動作排在前面，跟出貨面板與出價面板一致。手機上這一組是直排的，
   順序就是視覺順序 —— 三張面板各排各的等於同一個模式要學三次 */
.acts { display: flex; gap: 8px; }
.acts .btn.sm { flex: 1; min-width: 0; min-height: 44px; }

@media (max-width: 720px) {
  .acts { flex-direction: column; }
}
</style>
