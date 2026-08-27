<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useWalletStore } from '@/stores/wallet'
import { useAuthStore } from '@/stores/auth'
import { useSellerStore } from '@/stores/sellers'
import NotifyBell from '@/components/NotifyBell.vue'
import RollingNumber from '@/components/RollingNumber.vue'

const wallet = useWalletStore()
const auth = useAuthStore()
const sellers = useSellerStore()
const route = useRoute()

/**
 * 賣家身分：決定「出貨與結算」這個入口要不要出現。
 *
 * 判斷完全交給 sellers store 的 isSeller（MOCK 讀假資料、API 讀 /v1/seller/me，
 * 跟開池頁同一份規則），這裡不自己再判一次 —— 頁首跟落地頁對身分的認定要是
 * 有一點出入，使用者看到的就是「頁首有入口、點進去說你不是賣家」。
 *
 * 為什麼只有賣家看得到：一般玩家永遠沒有東西要出貨，那一格對他只是雜訊，
 * 而頁首的每一格都在跟真正該點的東西搶注意力。開池不同 —— 那一頁本身就是
 * 「申請成為賣家」的入口，所以維持所有會員都看得到。
 */
watch(() => auth.user?.id, id => {
  /* 帳號換人（含登出再登入）就重問一次。不重置的話，同一個分頁裡
     換一個帳號登入會沿用上一個人的賣家身分。 */
  sellers.resetStatus()
  if (id) sellers.ensureStatus()
}, { immediate: true })

/**
 * 登入／註冊都指向形象頁（那一頁本來就同時擺了兩者，沒有獨立的註冊路由），
 * 但一定要帶 redirect —— 之前頁首的「登入」是裸的 { name: 'landing' }，
 * 使用者在市場逛到一半按下去，登入完會被丟回大廳，剛剛在看的池就找不到了。
 * router 的登入守衛也是用同一個 query 名稱，兩邊行為才會一致。
 */
const authTo = computed(() => ({ name: 'landing', query: { redirect: route.fullPath } }))

/**
 * 頭像只放名字的第一個字。用 Array.from 取而不是 name[0]：
 * 名字可能以 emoji 或其他 surrogate pair 開頭，用索引會切出半個字碼點變成 �。
 */
const initial = computed(() => Array.from(auth.user?.name ?? '')[0] ?? '?')

/**
 * 捲動一點點之後才把頁首「實體化」（提高不透明度、補上分隔線與陰影）。
 *
 * 原本固定 82% 不透明 —— 大廳的池卡一捲上來，卡圖的亮部就會從頁首背後透出來，
 * 導覽文字疊在上面糊成一片。但也不能直接改成不透明：停在頁面最頂端時，
 * 一條實心橫槓會把 hero 切斷，霧面才是對的。所以做成兩段式。
 *
 * listener 掛 passive，才不會讓這一段擋住捲動。裡面刻意「不」用 requestAnimationFrame
 * 節流 —— 分頁被切到背景時 rAF 會整個停掉，那支排隊中的 callback 永遠不會執行，
 * 使用者切回來看到的就是上一次的狀態（在頁面頂端卻掛著陰影，或反過來）。
 * 這裡只是比一個布林值，Vue 對沒變的 ref 本來就不會重畫，不需要再節流。
 */
const scrolled = ref(false)
function onScroll() {
  scrolled.value = window.scrollY > 8
}
onMounted(() => {
  // 先算一次：重新整理時瀏覽器會自動還原捲動位置，那次不見得會補一個 scroll 事件給我們，
  // 少了這行就會在頁面中段看到一個「沒有邊線也沒有陰影」的頁首
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
})
onUnmounted(() => window.removeEventListener('scroll', onScroll))
</script>

<template>
  <header class="hdr" :class="{ solid: scrolled }">
    <!-- 三欄格線：標誌 | 導覽 | 動作區。
         舊版是一條 flex 再靠 .right 的 margin-left:auto 把右側推開，
         那等於「右側有東西」才撐得出版面；欄位化之後，任何一區空掉
         其他兩區都還在原位，未登入／已登入／管理員三種狀態不會互相牽動。 -->
    <div class="container row">
      <RouterLink :to="{ name: 'home' }" class="brand display">Vault<span>Draw</span></RouterLink>

      <!-- 導覽只留「大家都能點的地方」。我的卡冊是 requiresAuth，未登入時放在這裡
           等於一個會被守衛彈回形象頁的死路，所以跟著登入狀態出現。 -->
      <nav class="nav" :class="{ dense: auth.isLoggedIn }" aria-label="主導覽">
        <RouterLink :to="{ name: 'play' }">抽選台</RouterLink>
        <RouterLink :to="{ name: 'market' }">市場</RouterLink>
        <RouterLink :to="{ name: 'fairness' }" class="opt">公平性驗證</RouterLink>
        <RouterLink v-if="auth.isLoggedIn" :to="{ name: 'cards' }">我的卡冊</RouterLink>
      </nav>

      <!-- 動作區。強調色（實心橘紅）整條列上只給一個元素，而且給「這個身分現在
           最該做的那件事」：訪客是註冊，會員是開池。舊版不管誰來都把開池點成紅色，
           結果訪客最需要的登入反而是全列對比最低的一段灰字。 -->
      <div class="actions">
        <template v-if="auth.isLoggedIn">
          <!-- 只有管理員看得到。這是便利性入口，不是權限控制——擋在路由守衛與後端 -->
          <RouterLink v-if="auth.isAdmin" :to="{ name: 'admin' }" class="pill admin">後台</RouterLink>
          <RouterLink :to="{ name: 'seller-new' }" class="pill sell">＋ 我要開池</RouterLink>
          <!-- 出貨與結算：只有賣家看得到，就排在開池右邊（開池是進貨、出貨是履約，
               同一個身分的前後兩步）。名字跟頁面標題一字不差，換個說法會讓人以為是兩頁。
               這是賣家回訪頻率最高的一頁（要看保留額、看哪幾張該寄了），
               之前桌機版只能先進「我的」再點一層，而寄送是有時限的 —— 逾期要退款加違約。 -->
          <RouterLink
            v-if="sellers.isSeller" :to="{ name: 'seller-shipping' }" class="pill ship"
          >出貨與結算</RouterLink>
          <RouterLink :to="{ name: 'topup' }" class="pill wallet mono" aria-label="點數餘額，前往儲值">
            <span class="dot" aria-hidden="true"></span><RollingNumber :value="wallet.shown" /> 點
          </RouterLink>
          <!-- 通知放在餘額旁邊。原本浮在右下角，一直在跟各頁貼底的動作列搶位置 -->
          <NotifyBell />
          <RouterLink :to="{ name: 'me' }" class="pill me">
            <span class="avatar" aria-hidden="true">{{ initial }}</span>
            <span class="who">{{ auth.user?.name }}</span>
          </RouterLink>
        </template>
        <!-- 未登入不顯示餘額膠囊：mock 模式下錢包預設就有一億點，等於對著沒有帳號的
             訪客秀一個假餘額，而且那顆膠囊連到 requiresAuth 的儲值頁，按下去只會被彈走。 -->
        <template v-else>
          <RouterLink :to="authTo" class="pill ghost">登入</RouterLink>
          <RouterLink :to="authTo" class="pill cta">註冊</RouterLink>
        </template>
      </div>
    </div>
  </header>
</template>

<style scoped>
.hdr {
  position: sticky; top: 0; z-index: 50;
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: saturate(180%) blur(14px);
  /* 分隔線在頂端時是透明的而不是不存在 —— 留著這 1px 才不會在捲動時
     整頁往上跳一格。陰影同理，用顏色變化而不是有無來切換。 */
  border-bottom: 1px solid transparent;
  transition: background .2s ease, border-color .2s ease, box-shadow .2s ease;
  /* 瀏海機的狀態列會吃掉這一條，之前完全沒讓位 */
  padding-top: var(--safe-t);
}
.hdr.solid {
  background: color-mix(in srgb, var(--bg) 96%, transparent);
  border-bottom-color: var(--line-soft);
  box-shadow: var(--shadow-sm);
}
@media (prefers-reduced-motion: reduce) { .hdr { transition: none; } }

.row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 24px;
  height: 66px;
}
.brand { font-size: 21px; font-weight: 600; letter-spacing: -0.03em; white-space: nowrap; }
.brand span { color: var(--accent); }

/* 導覽置中在中間那一欄，而不是貼著標誌排。
   舊版排完之後右邊會留下 380px 的空洞（實測 1340px 寬時 nav 右緣 627、
   右側區塊左緣 1009），看起來像元素掉了；置中之後空白平均分到兩側，
   而且動作區在三種登入狀態下寬度差很多，置中比靠左更看不出那個差異。 */
.nav {
  display: flex; justify-content: center; align-items: center;
  gap: 2px;
  font-size: 14.5px; font-weight: 500;
}
.nav > a {
  padding: 8px 14px;
  border-radius: var(--pill);
  color: var(--muted);
  /* 中文導覽項在窄視窗會被 flex 壓到換行（實測 760px 寬時「抽選台」高度變成 62px，
     整個撐破 66px 的列高）。nowrap 是這個跑版的根因修正，寬度不夠改用下面的
     斷點把次要項目收起來，而不是讓它折行。 */
  white-space: nowrap;
  transition: color .15s, background .15s;
}
@media (hover: hover) {
  .nav > a:hover { color: var(--ink); background: var(--surface-2); }
}
.nav > a.router-link-active { color: var(--ink); font-weight: 600; background: var(--surface-2); }

/* 靠右用 justify-content: flex-end（flex 內部），不要用 justify-self: end（grid 層）。
   兩者畫出來一樣，但 justify-self: end 會讓這一格改用 max-content 寬度、只把右緣
   釘在欄位右側 —— 欄位縮小時它不跟著縮，而是往「左邊」溢出去蓋住標誌
   （實測 320px、餘額十五位數時，「VaultDraw」被餘額膠囊蓋掉後面三個字）。
   維持預設的 stretch，這一格才會等於欄寬，裡面的膠囊也才真的會收縮。 */
.actions { display: flex; align-items: center; gap: 8px; justify-content: flex-end; min-width: 0; }

/* ---- 動作區的收縮責任分配 ----
   餘額是這條列上唯一長度不固定的東西（位數隨儲值變動，mock 的測試帳號是
   100,000,000，十一個字元），其餘每一格都是固定寬。所以明確指定「誰該縮」：
   通知鈴、帳號、各種入口一律 flex: none 維持原尺寸，空間不夠時只有餘額會縮，
   縮到底就由數字自己截斷 —— 而不是整個動作區把後面的通知鈴與帳號推出畫面外
   （那正是 320px 溢出 28px 時發生的事：帳號膠囊整顆落在視窗外，點不到）。

   min-width: 0 這幾行是必要的，不是保險：flex / grid 子元素預設 min-width: auto，
   下限就是內容寬度，不補這行的話 overflow 與 text-overflow 都不會生效。
   見 docs/HANDOFF.md 2.1。 */
.actions > * { flex: none; }
/* 寫 .actions > .wallet（0,2,0）而不是 .wallet（0,1,0）：跟上面那條同分的話，
   誰贏就取決於誰排在後面，跟這個檔案底下踩過的那個坑是同一種。 */
.actions > .wallet { flex: 0 1 auto; min-width: 0; overflow: hidden; }
/* RollingNumber 的根元素，用 :deep 才選得到子元件內部的 class */
.wallet :deep(.roll) { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

.pill {
  display: inline-flex; align-items: center; gap: 8px;
  height: 38px; padding: 0 16px;
  border: 1px solid transparent;
  border-radius: var(--pill);
  font-size: 14px; font-weight: 600;
  white-space: nowrap;
  transition: background .15s, border-color .15s, color .15s;
}
.pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* 登入：外框膠囊。跟註冊做成同一個尺寸的一對，讓兩者看起來是「同一組選擇」 */
.ghost { color: var(--ink); border-color: var(--line); }
@media (hover: hover) { .ghost:hover { background: var(--surface-2); } }

/* 註冊：全列唯一的實心強調色。#fff 是照 base.css 的 .btn.primary 走 ——
   強調色底上的字色目前沒有對應的權杖，兩處要一起改才不會分岔 */
.cta { background: var(--accent); color: var(--on-accent); }
@media (hover: hover) { .cta:hover { background: var(--accent-soft); } }

/* 開池：會員才看得到（seller-new 是 requiresAuth）。用「強調色外框」而不是實心，
   它是賣家動線的入口，重要但不該比餘額和帳號還搶眼 */
.sell { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 38%, transparent); }
@media (hover: hover) { .sell:hover { background: var(--accent-wash); } }

/* 出貨與結算：賣家限定。用中性外框而不是跟開池一樣的強調色外框 ——
   一條列上兩個橘紅外框會互相抵銷，而且開池是「招募」（要吸引人點），
   出貨是「例行公事」（知道它在哪就夠了，賣家自己會回來找）。 */
.ship { color: var(--ink); border-color: var(--line); }
@media (hover: hover) { .ship:hover { background: var(--surface-2); } }

/* 後台入口：管理員限定，用中性色不搶主導覽的注意力 */
.admin { background: var(--surface-3); color: var(--muted); font-size: 13px; padding: 0 14px; }
@media (hover: hover) { .admin:hover { color: var(--ink); } }

.wallet { background: var(--surface-2); color: var(--ink); }
@media (hover: hover) { .wallet:hover { background: var(--surface-3); } }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }

/* 帳號：頭像圓片 + 名字。舊版是一段 14px 的灰字，跟旁邊的膠囊比起來
   既看不出可以點、也撐不住版面（名字一長就把整列往左擠） */
.me { color: var(--muted); font-weight: 500; padding: 0 14px 0 5px; gap: 9px; }
@media (hover: hover) { .me:hover { background: var(--surface-2); color: var(--ink); } }
.avatar {
  width: 28px; height: 28px; flex: none;
  display: grid; place-items: center;
  border-radius: 50%;
  background: var(--surface-3); color: var(--ink);
  font-size: 13px; font-weight: 700;
}
.who { max-width: 9em; overflow: hidden; text-overflow: ellipsis; }

/* 餘額膠囊與帳號是「按鈕」不是「內容」，連點時不該被反白。
   餘額特別要寫在這裡：它掛了 .mono，會吃到 touch.css 裡「驗算資料一定要能複製」
   的逃生門而變回可選取 —— 那條是給雜湊、籤號用的，餘額沒人要複製。 */
.wallet, .me {
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}

/* ---- 中間寬度的收斂順序 ----
   桌機到手機之間有一段 720–1100px（分割視窗、小筆電、直立螢幕）以前完全沒顧到。
   收斂的順序照「丟掉最不痛的東西」排：間距 → 名字 → 開池 → 公平性驗證。
   被收起來的兩個入口都還有別的路可走（開池在「我的」頁的賣家專區、
   公平性驗證在頁尾），不是真的消失。 */
@media (max-width: 1100px) {
  .row { gap: 14px; }
  .actions { gap: 6px; }
  .pill { padding: 0 13px; }
  .me { padding: 0 11px 0 5px; }
  .nav > a { padding: 8px 11px; }
}
/* 出貨與結算是這條列上最後加進來的一格，也是第一個被收掉的 ——
   實測（1440→720 每 20px 掃一次）：1000px 還排得下，980px 起導覽的「我的卡冊」
   就會越過動作區的左緣 6px，880px 時是 20px，整條列開始疊字。
   收掉之後這個入口仍在「我的」頁（手機的底部導覽與這裡的帳號膠囊都到得了），
   跟開池在 860px 收掉是同一個道理：桌機才有的便利，位置不夠就還給主導覽。 */
@media (max-width: 1000px) {
  .ship { display: none; }
}
@media (max-width: 960px) {
  .who { display: none; }
  .me { padding: 0 5px; }
}
@media (max-width: 860px) {
  .sell { display: none; }
}
/* 公平性驗證只在「已登入」時才收起來（.dense）。
   訪客的動作區只有登入／註冊兩顆，位置綽綽有餘，而這一頁正好是要說服訪客
   留下來的那一頁 —— 為了遷就會員版的擁擠而把它從訪客的導覽拿掉是本末倒置。 */
@media (max-width: 780px) {
  .nav.dense .opt { display: none; }
}

@media (max-width: 720px) {
  /* 手機導覽改用底部 tab bar（AppBottomNav），頁首只留標誌與餘額／登入 */
  .nav { display: none; }
  /* 第二欄寫 minmax(0, 1fr) 而不是 1fr。1fr 的下限是 auto，也就是
     「動作區的內容寬度」—— 等於這一欄根本不會縮，餘額位數一多就把整條列推爆。
     這是 docs/HANDOFF.md 2.1 那條規則，頁首自己也踩了一次。 */
  .row { grid-template-columns: auto minmax(0, 1fr); height: 56px; gap: 12px; }
  .brand { font-size: 18px; }
  /* 後台在手機上不做事（後台頁本身是桌機介面），別佔掉這條列 */
  .admin { display: none; }

  /* 通用的 .pill 要排在下面那幾條 .pill.xxx 之前，而且那幾條一律連寫兩個 class。
     原因：.pill 與 .wallet／.me 特異性同分（0,1,0），誰在後面誰贏。這條 .pill
     是後來才補進這個區塊尾端的，一補上去就把上面 .wallet 的 font-size／height／
     padding 和 .me 的 padding 全部無聲蓋掉 —— 320px 的溢出從註解裡記的 2px
     惡化到 28px 就是這麼來的，而且 diff 上完全看不出有人改過餘額膠囊。
     連寫 .pill.wallet（0,2,0）之後，順序就不再是正確性的一部分。 */
  .pill { height: 34px; font-size: 13px; padding: 0 12px; }
  /* 餘額九位數在 375px 會折成兩行；不換行 + 收字距 */
  .pill.wallet { font-size: 12.5px; height: 32px; padding: 0 11px; letter-spacing: -.01em; }
  /* 帳號在手機上只剩頭像。左右各留 8px 不是留白而是觸控範圍：
     26px 的頭像加上這 16px 正好讓可點區域到 44px 寬（Apple HIG 的下限）。
     高度受限於整條列只有 56px，仍是 34px —— 那條要整列一起改，記在 docs/open-issues.md。 */
  .pill.me { padding: 0 8px; }
  .avatar { width: 26px; height: 26px; font-size: 12px; }
}

/* ---- 320px（iPhone SE 一代這種）----
   這個區塊的註解原本寫「溢出 2px」。那個數字後來過期了：上面那條 .pill 補進
   @media (max-width: 720px) 尾端之後，餘額與帳號的內距全部被蓋回通用值，
   實測（320px 寬、已登入、mock 餘額 100,000,000）.row 的 scrollWidth 是 348，
   也就是溢出 28px —— 帳號膠囊整顆在視窗外。修法見上面兩個區塊的註解。

   這裡只做「把最後幾 px 擠出來」的事，動的都是不損失資訊的東西：
   裝飾用的圓點、間距、標誌字級。

   擠完之後（320px 實測）餘額有 74px 可用，12.5px 的等寬數字約 7.4px 一個字元，
   也就是 **十個字元以內完整顯示**：99,999,999 剛好貼齊，再長就由 ellipsis 收尾
   （mock 測試帳號種的 100,000,000 是十一個字元，在 320px 會顯示成 100,000,0…，
   360px 以上完整）。這是刻意留的取捨，不是沒調乾淨：要讓十一位數也塞得下，
   就得把帳號膠囊的左右內距從 8px 收回 0，可點寬度會從 44px 掉到 28px。
   餘額看不全還能點進儲值頁看到完整數字；點不到的按鈕沒有第二條路。 */
@media (max-width: 360px) {
  .row { gap: 6px; }
  .actions { gap: 5px; }
  .brand { font-size: 16px; }
  .pill { padding: 0 10px; }
  .pill.wallet { padding: 0 9px; gap: 6px; }
  /* 這顆圓點是純裝飾（aria-hidden），本身 7px 再加 8px 間距要價 15px，
     是這條列上唯一可以整個拿掉而不損失任何資訊的東西。
     餘額的意義由後面的「點」和 aria-label 撐著，不靠這顆點。 */
  .pill.wallet .dot { display: none; }
}
</style>
