<script setup lang="ts">
/**
 * 我的問題（工單列表）。
 *
 * 這一頁回答的問題只有一個：「我問過的事情現在怎麼樣了」。
 * 所以每一列上最重要的不是主旨，是**狀態**與**最後一則訊息** ——
 * 使用者回來看的是有沒有人回他，不是自己當初標題怎麼下的。
 *
 * 三種畫面刻意分得很開，不共用同一句話：
 *   載入中   —— 還不知道
 *   讀取失敗 —— 我們這邊出事了，給重試鍵（**不能畫成空狀態**：
 *               斷網時說「你還沒問過任何問題」是在說謊）
 *   真的沒有 —— 空狀態要講得出這一頁是幹嘛的、以及有些單是系統自動開的
 */
import { onMounted } from 'vue'
import { useTicketsStore } from '@/stores/tickets'
import { KIND_TEXT, fmtWhen } from './labels'
import TicketBadge from './TicketBadge.vue'

const store = useTicketsStore()

/* 重進這一頁一律重拉：上一次看完之後客服可能已經回了，
   而這一頁的全部價值就在「有沒有新的動靜」。 */
onMounted(() => store.loadList(true))
</script>

<template>
  <div class="container page">
    <header class="slHead">
      <div class="slTitleRow">
        <h1 class="display slTitle">我的問題</h1>
        <RouterLink :to="{ name: 'support-new' }" class="btn primary slNew">開新問題</RouterLink>
      </div>
      <p class="muted slSub">
        跟客服的對話都在這裡。訂單爭議與賣家審核會由系統自動開單，
        不用另外問一次 —— 直接在那張單上補充就好。
      </p>
    </header>

    <!-- 讀取失敗。這一段一定要在空狀態之前判斷 -->
    <p v-if="store.listErr && !store.items.length" class="slErr" role="alert">
      <span>{{ store.listErr }}</span>
      <button type="button" class="btn sm" @click="store.loadList(true)">重試</button>
    </p>

    <p v-else-if="store.listLoading && !store.items.length" class="slState muted">載入中…</p>

    <!-- 真的一張都沒有。空狀態要有話可說，不是一句「沒有資料」 -->
    <section v-else-if="!store.items.length" class="slEmpty card">
      <span class="slEmptyIcon" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="26" height="26" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 8.5A2.5 2.5 0 0 1 7.5 6h17A2.5 2.5 0 0 1 27 8.5v11a2.5 2.5 0 0 1-2.5 2.5H13l-6 4.5V22H7.5A2.5 2.5 0 0 1 5 19.5z" />
          <path d="M11 11.5h10M11 16h6" />
        </svg>
      </span>
      <h2 class="slEmptyT">你還沒有問過任何問題</h2>
      <p class="slEmptyP">
        卡片、帳號、或是想把站外買到的鑑定編號接管過來 —— 都從這裡開一張單，
        客服的回覆會回到同一張單上，不會跑到別的地方。
      </p>
      <p class="slEmptyP faint">
        另外，訂單爭議與賣家審核送出之後，系統會自動幫你開一張單，
        那兩種也會出現在這一頁。
      </p>
      <RouterLink :to="{ name: 'support-new' }" class="btn primary">開新問題</RouterLink>
    </section>

    <!-- 有資料時的失敗只補一行，不要把已經看得到的清單換掉 -->
    <p v-else-if="store.listErr" class="slErr" role="alert">
      <span>{{ store.listErr }}</span>
      <button type="button" class="btn sm" @click="store.loadList(true)">重試</button>
    </p>

    <ul v-if="store.items.length" class="slList">
      <li v-for="t in store.items" :key="t.id" class="slItem">
        <RouterLink :to="{ name: 'support-ticket', params: { id: t.id } }" class="slRow card">
          <div class="slTop">
            <TicketBadge :status="t.status" />
            <span class="chip slKind">{{ KIND_TEXT[t.kind] }}</span>
            <span class="slWhen mono">{{ fmtWhen(t.updatedAt) }}</span>
          </div>
          <h2 class="slSubj">
            <!-- 未讀的點放在主旨前面而不是角落：那是這一列唯一「你還沒看」的訊號 -->
            <span v-if="t.unread" class="slDot" aria-label="有新訊息"></span>
            {{ t.subject }}
          </h2>
          <p v-if="t.lastMessage" class="slLast">{{ t.lastMessage }}</p>
          <p v-else class="slLast faint">還沒有任何訊息</p>
          <span class="slMeta faint mono">{{ t.messageCount }} 則訊息</span>
        </RouterLink>
      </li>
    </ul>

    <div v-if="store.nextCursor" class="slMore">
      <button type="button" class="btn" :disabled="store.listLoading" @click="store.loadMore()">
        {{ store.listLoading ? '載入中…' : '載入更多' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.page { padding-top: 26px; padding-bottom: 48px; max-width: 720px; }

.slHead { margin-bottom: 18px; }
/* minmax(0, 1fr) 而不是 1fr：標題再長也不會把右邊的按鈕擠出容器 */
.slTitleRow {
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: center; gap: 12px;
}
.slTitle { font-size: 26px; margin: 0; min-width: 0; }
.slNew { flex: none; min-height: 44px; padding: 0 18px; font-size: 14px; }
.slSub { margin: 10px 0 0; font-size: 13px; line-height: 1.8; }

.slErr {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  margin: 0 0 14px; padding: 12px 14px;
  background: var(--danger-wash); color: var(--danger-ink);
  border-radius: var(--radius);
  font-size: 13px; line-height: 1.7;
}
.slErr span { min-width: 0; overflow-wrap: anywhere; }
.btn.sm { min-height: 44px; padding: 0 16px; font-size: 13px; flex: none; }

.slState { padding: 40px 4px; text-align: center; font-size: 13.5px; }

.slEmpty {
  padding: 30px 22px;
  display: grid; justify-items: center; gap: 12px; text-align: center;
}
.slEmptyIcon {
  width: 52px; height: 52px; border-radius: var(--pill);
  display: grid; place-items: center;
  background: var(--accent-wash); color: var(--accent);
}
.slEmptyT { font-size: 17px; margin: 0; }
.slEmptyP { margin: 0; font-size: 13px; line-height: 1.9; color: var(--muted); max-width: 42em; }
.slEmptyP.faint { color: var(--faint); font-size: 12.5px; }
.slEmpty .btn { margin-top: 4px; }

.slList { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.slItem { min-width: 0; }

.slRow {
  display: block; min-width: 0;
  padding: 14px 16px;
  color: inherit; text-decoration: none;
  /* 整列可點，高度遠超過 44px */
  min-height: 44px;
}
@media (hover: hover) {
  .slRow:hover { border-color: var(--line); background: var(--surface-2); }
}
.slRow:active { transform: scale(.995); }
.slRow:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.slTop { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.slKind { font-size: 11.5px; padding: 5px 10px; flex: none; }
/* 時間推到最右邊，但在窄螢幕上折行時不要留一個孤兒 */
.slWhen { margin-left: auto; font-size: 11.5px; color: var(--faint); flex: none; }

.slSubj {
  margin: 9px 0 0; min-width: 0;
  font-size: 15px; font-weight: 700; line-height: 1.5;
  overflow-wrap: anywhere;
}
.slDot {
  display: inline-block; vertical-align: middle;
  width: 7px; height: 7px; border-radius: var(--pill);
  background: var(--accent); margin-right: 6px;
}

/* 最後一則訊息最多兩行。這裡截斷是刻意的 —— 它是進度的提示，不是內容本身，
   而全文一定看得到（點進去就是）。標題與狀態則絕不截斷。 */
.slLast {
  margin: 6px 0 0; min-width: 0;
  font-size: 12.5px; line-height: 1.75; color: var(--muted);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; overflow-wrap: anywhere;
}
.slLast.faint { color: var(--faint); }
.slMeta { display: block; margin-top: 8px; font-size: 11px; color: var(--faint); }

.slMore { display: flex; justify-content: center; margin-top: 16px; }
</style>
