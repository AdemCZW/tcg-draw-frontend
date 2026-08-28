<script setup lang="ts">
/**
 * 客服工單佇列。
 *
 * 這一頁只回答一個問題：「現在有誰在等我，等了多久」。
 * 所以「等多久了」是唯一被加粗、被上色、而且在桌機上獨立成一欄的欄位 ——
 * 開單時間戳（08/24 14:32）要人在腦中減一次才知道急不急，那正是排序的依據，
 * 不該讓客服自己算。時間戳退到 title 裡，要精確時間的人 hover 得到。
 *
 * 預設只顯示待處理的，而且舊的排前面：客服的工作順序本來就是先進先出，
 * 讓最久沒人理的那張自然浮到最上面，比給他一排排序按鈕有用。
 */
import { computed, inject, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  useTicketsStore, TICKET_KIND_LABEL, TICKET_STATUS_LABEL, TICKET_STATUS_TONE,
  fmtWait, isTicketStale, isTicketClosed
} from '@/stores/tickets'
import { fmtTime } from './shared'
import './console.css'

const router = useRouter()
const tickets = useTicketsStore()
/* 側欄的待辦數字要跟這一頁同步 —— 這頁結掉一張、側欄還掛著舊數字，
   會讓人以為沒存到。ConsoleShell 提供這個 provide。 */
const refreshBadges = inject<() => Promise<void>>('console:refresh', async () => {})

const SCOPES = [
  { k: 'pending' as const, label: '待處理' },
  { k: 'all' as const, label: '全部' }
]

onMounted(() => tickets.adminLoadQueue())

async function setScope(k: 'pending' | 'all') {
  await tickets.adminSetScope(k)
  await refreshBadges()
}

const open = (id: string) => router.push({ name: 'console-ticket', params: { id } })

/** 沒人認領的張數。有人認領的單至少「有人知道」了，沒認領的才是真的沒人管 */
const unclaimed = computed(() => tickets.adminUnclaimed)
</script>

<template>
  <div>
    <div class="c-head">
      <h2>客服工單</h2>
      <span class="c-sub">舊的排前面。等最久的那張在最上面。</span>
      <div class="c-right">
        <button class="c-btn" type="button" :disabled="tickets.adminListLoading" @click="tickets.adminLoadQueue()">
          重新整理
        </button>
      </div>
    </div>

    <div class="tabs">
      <button
        v-for="s in SCOPES" :key="s.k" type="button"
        class="tab" :class="{ on: tickets.adminScope === s.k }" @click="setScope(s.k)"
      >
        {{ s.label }}
        <b v-if="s.k === 'pending' && tickets.adminPendingCount">{{ tickets.adminPendingCount }}</b>
      </button>
      <span v-if="tickets.adminScope === 'pending' && unclaimed" class="c-warn nograb">
        其中 {{ unclaimed }} 張還沒有人認領
      </span>
    </div>

    <p v-if="tickets.adminListErr" class="c-err">{{ tickets.adminListErr }}</p>

    <p v-if="tickets.adminListLoading && !tickets.adminRows.length" class="c-empty">載入中…</p>
    <p v-else-if="!tickets.adminRows.length && !tickets.adminListErr" class="c-empty">
      {{ tickets.adminScope === 'pending' ? '目前沒有待處理的工單。' : '還沒有任何工單。' }}
    </p>

    <div v-else class="c-rows">
      <!-- 桌機的欄位抬頭。手機不顯示：那邊每一列自己帶著標籤，
           抬頭只會多佔一行又對不齊 -->
      <div v-if="tickets.adminRows.length" class="thead" aria-hidden="true">
        <span>類型</span><span>狀態</span><span>主旨</span>
        <span>開單人</span><span>等多久了</span><span>認領人</span>
      </div>

      <article
        v-for="t in tickets.adminRows" :key="t.id"
        class="c-row c-click trow" tabindex="0" role="link"
        @click="open(t.id)" @keydown.enter="open(t.id)" @keydown.space.prevent="open(t.id)"
      >
        <span class="c-pill kind">{{ TICKET_KIND_LABEL[t.kind] }}</span>
        <span class="c-pill" :class="TICKET_STATUS_TONE[t.status]">{{ TICKET_STATUS_LABEL[t.status] }}</span>

        <span class="subj">
          <b class="c-t">{{ t.subject }}</b>
          <!-- 最後一則訊息：佇列上就看得出「進度到哪」，不必每張都點進去 -->
          <i v-if="t.lastMessage" class="c-m last">{{ t.lastMessage }}</i>
        </span>

        <span class="cell">
          <i class="lab">開單人</i>
          <span class="c-m who">{{ t.userName }}<em v-if="t.userMemberNo">{{ t.userMemberNo }}</em></span>
        </span>

        <span class="cell">
          <i class="lab">等多久了</i>
          <!-- 已結案的單不再累加等待時間，改顯示「已結案」——
               把一張三個月前結掉的單標成「已等 90 天」是在說謊 -->
          <b v-if="isTicketClosed(t.status)" class="wait done">已結案</b>
          <b v-else class="wait" :class="{ hot: isTicketStale(t) }" :title="`開單於 ${fmtTime(t.createdAt)}`">
            {{ fmtWait(t.createdAt) }}
          </b>
        </span>

        <span class="cell">
          <i class="lab">認領人</i>
          <span v-if="t.assigneeName" class="c-m">{{ t.assigneeName }}</span>
          <span v-else class="c-m none">未認領</span>
        </span>
      </article>
    </div>
  </div>
</template>

<style scoped>
.tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; overflow-x: auto; margin-bottom: 14px; padding-bottom: 2px; }
.tab {
  flex: none; min-height: 44px; padding: 7px 16px; font: inherit; font-size: 13px;
  border: 1px solid var(--line); border-radius: 999px;
  background: var(--surface); color: var(--muted); cursor: pointer;
}
.tab.on { background: var(--surface-3); color: var(--ink); border-color: var(--line); font-weight: 700; }
.tab b { margin-left: 5px; color: var(--gold); }
.nograb { margin-left: 4px; }
/* 這一頁自己的按鈕都吃滿 44px 觸控高（c-btn 的預設是 38.8px） */
.c-head .c-btn { min-height: 44px; }

/* 手機：一列就是一張卡，欄位各自帶標籤堆疊。
   桌機：同一份 DOM 靠 grid 換成表格排法，不做兩套模板。 */
.trow {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px;
  align-items: start;
}
.trow:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
/* 一列至少 44px：整列就是那個可點目標 */
.trow { min-height: 44px; }

.thead { display: none; }

.c-pill.kind { background: var(--surface-3); color: var(--ink); }

.subj { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.subj .c-t { font-weight: 600; }
/* 最後一則訊息只給兩行。它是輔助資訊，讓它把整列撐成一段文章的話，
   一頁就放不下幾張單，而佇列的價值正是「一眼掃過去有幾件事」。 */
.last {
  font-style: normal; display: -webkit-box; -webkit-box-orient: vertical;
  -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
}

.cell { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
/* 標籤只在手機出現：桌機有欄位抬頭，再重複一次是噪音 */
.lab { font-style: normal; font-size: 11.5px; color: var(--faint); flex: none; width: 62px; }

.who { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; min-width: 0; }
.who em { font-style: normal; font-size: 11.5px; color: var(--faint); }

/* 這一欄是整頁的重點，所以它是唯一用 tabular-nums 加粗的數字 */
.wait { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--ink); }
.wait.hot { color: var(--warn-ink); }
.wait.done { color: var(--faint); font-weight: 600; }
.none { color: var(--faint); }

@media (min-width: 960px) {
  .thead {
    display: grid;
    grid-template-columns: 96px 116px minmax(0, 1fr) 150px 112px 116px;
    gap: 12px; padding: 0 14px 2px;
    font-size: 11.5px; color: var(--faint);
  }
  .trow {
    grid-template-columns: 96px 116px minmax(0, 1fr) 150px 112px 116px;
    gap: 12px; align-items: center;
  }
  .lab { display: none; }
  .cell { display: block; }
  .who { display: block; }
  .who em { display: block; }
}
</style>
