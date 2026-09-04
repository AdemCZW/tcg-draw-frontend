<script setup lang="ts">
/**
 * 後台外殼。
 *
 * 跟舊後台最大的差別是「導覽是側欄不是分頁」。分頁的問題不是難看，是它逼你
 * 一次只能看一件事：處理出貨時想確認這個人的地址，就得離開出貨分頁，
 * 回來之後捲軸位置和篩選條件都沒了。側欄 + 子路由讓每一區有自己的網址，
 * 可以開新分頁、可以加書籤、返回鍵是對的。
 *
 * 待辦數字直接掛在導覽項目上：後台的核心問題是「現在有什麼要我處理」，
 * 這件事不該需要先點進總覽才知道。
 */
import { computed, onMounted, provide, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useTicketsStore } from '@/stores/tickets'
import { http, useAsync, type Overview } from './shared'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const tickets = useTicketsStore()
const { err, run } = useAsync()

const overview = ref<Overview | null>(null)
async function loadOverview() {
  const r = await run(() => http<{ overview: Overview }>('/v1/admin/overview'))
  if (r) overview.value = r.overview
}
onMounted(loadOverview)
/* 工單的待辦數字跟 overview 分開拿：/v1/admin/overview 沒有工單欄位，
   而側欄的重點是「現在有什麼要我處理」—— 少了工單那一項就不完整。
   失敗時 store 自己吞掉（側欄的數字不值得為它跳一句紅字）。 */
onMounted(() => tickets.adminRefreshCount())

/* 聯絡訊息的待辦數字。刻意不開一支專用的計數端點 ——
   /v1/admin/contact 的列表本來就順帶回 pending，兩邊用同一個來源
   才不會出現「側欄說 3、點進去只有 1」。
   失敗就吞掉並維持 0：側欄的一個數字不值得為它在整個後台頂端跳紅字。 */
const contactPending = ref(0)
async function loadContactCount() {
  try {
    const r = await http<{ pending: number }>('/v1/admin/contact?scope=new&limit=1')
    contactPending.value = r.pending ?? 0
  } catch { /* 側欄的數字不值得為它報錯 */ }
}
onMounted(loadContactCount)
/* 子頁處理完事情後要能讓側欄的數字跟著減 —— 出貨標記完成了，
   側欄還掛著「3」會讓人以為沒存到 */
provide('console:refresh', async () => {
  await loadOverview()
  await tickets.adminRefreshCount()
  await loadContactCount()
})
provide('console:overview', overview)

type Nav = { name: string; label: string; icon: string; badge?: () => number }
const NAV: Nav[] = [
  { name: 'console-overview', label: '總覽', icon: 'M3 12h4l3 8 4-16 3 8h4' },
  { name: 'console-shipments', label: '出貨', icon: 'M3 7h11v10H3zM14 10h4l3 3v4h-7M6.5 20a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17.5 20a1.5 1.5 0 100-3 1.5 1.5 0 000 3z', badge: () => overview.value?.ship_requested ?? 0 },
  { name: 'console-users', label: '會員', icon: 'M4 20v-1a6 6 0 0112 0v1M10 11a4 4 0 100-8 4 4 0 000 8z' },
  { name: 'console-pools', label: '池', icon: 'M4 6h16v12H4zM4 10h16M9 6v12' },
  { name: 'console-sellers', label: '賣家審核', icon: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z', badge: () => overview.value?.sellers_pending ?? 0 },
  { name: 'console-disputes', label: '爭議', icon: 'M12 4l9 16H3zM12 10v4M12 17v.5', badge: () => overview.value?.orders_disputed ?? 0 },
  /* 客服工單排在爭議之後、稽核之前：它是「使用者在等我」那一群的最後一項，
     而稽核紀錄是事後查帳，不是待辦。待辦數字不走 overview（那支端點沒有工單欄位），
     直接讀工單 store 自己的計數。 */
  { name: 'console-tickets', label: '客服工單', icon: 'M4 5h16v11H8l-4 3zM8 9h8M8 12.5h5', badge: () => tickets.adminPendingCount },
  /* 公開聯絡表單（/contact）送進來的訊息。**這是第二個佇列，不是工單的一部分** ——
     那張表的每一列都可能沒有 user_id（送出的人多半沒有帳號），併不進 024。
     完整的代價分析寫在 server/migrations/037_contact.sql 的檔頭。
     它有自己的待辦數字，而且那個數字必須在側欄上：這個功能付出的代價
     就是「客服多一個地方要看」，而看不看得到不該靠記得。 */
  { name: 'console-contact', label: '聯絡訊息', icon: 'M3 6h18v12H3zM3 7l9 6 9-6', badge: () => contactPending.value },
  { name: 'console-audit', label: '稽核紀錄', icon: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5' }
]

/* 詳情頁的路由名跟它所屬的區不同名，要對回去側欄才會保持高亮：
   會員詳情是 console-user、工單詳情是 console-ticket（都少一個 s）。 */
const SECTION_OF: Record<string, string> = {
  'console-user': 'console-users',
  'console-ticket': 'console-tickets'
}
const activeName = computed(() => {
  const n = String(route.name ?? '')
  return SECTION_OF[n] ?? n
})

const menuOpen = ref(false)
function goto(name: string) { menuOpen.value = false; router.push({ name }) }

const title = computed(() => NAV.find(n => n.name === activeName.value)?.label ?? '後台')
</script>

<template>
  <div class="console">
    <!-- 手機：頂列 + 抽屜。側欄在窄螢幕會吃掉一半寬度，資料表格就沒得看了 -->
    <header class="top">
      <button class="burger" type="button" aria-label="選單" @click="menuOpen = !menuOpen">
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
      </button>
      <span class="brand">VAULT DRAW<i>後台</i></span>
      <span class="crumb">{{ title }}</span>
      <RouterLink class="exit" :to="{ name: 'home' }">回前台</RouterLink>
    </header>

    <div class="body">
      <nav class="side" :class="{ open: menuOpen }">
        <p class="who">
          <span class="dot" />{{ auth.user?.name || auth.user?.handle || '管理員' }}
        </p>
        <button
          v-for="n in NAV" :key="n.name"
          type="button" class="nav" :class="{ on: activeName === n.name }"
          @click="goto(n.name)"
        >
          <svg viewBox="0 0 24 24" width="18" height="18"><path :d="n.icon" /></svg>
          <span>{{ n.label }}</span>
          <b v-if="n.badge && n.badge() > 0" class="badge">{{ n.badge() }}</b>
        </button>
      </nav>
      <!-- 抽屜開著時點旁邊關掉，比要人準確按到 X 好按 -->
      <div v-if="menuOpen" class="scrim" @click="menuOpen = false" />

      <main class="main">
        <p v-if="err" class="err">{{ err }}</p>
        <RouterView v-slot="{ Component }">
          <component :is="Component" />
        </RouterView>
      </main>
    </div>
  </div>
</template>

<style scoped>
.console { min-height: 100dvh; background: var(--bg); display: flex; flex-direction: column; }
svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

.top {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; padding-top: calc(10px + var(--safe-t, 0px));
  background: var(--surface); border-bottom: 1px solid var(--line);
  position: sticky; top: 0; z-index: 30;
}
.brand { font-size: 13px; font-weight: 700; letter-spacing: .08em; }
.brand i {
  font-style: normal; font-size: 10px; font-weight: 700; letter-spacing: .1em;
  margin-left: 6px; padding: 2px 6px; border-radius: 5px;
  background: var(--gold); color: #1a1410;
}
.crumb { font-size: 13px; color: var(--muted); margin-left: 4px; }
.exit {
  margin-left: auto; font-size: 12.5px; color: var(--muted);
  text-decoration: none; padding: 6px 10px; border-radius: 8px; background: var(--surface-2);
}
.burger {
  display: grid; place-items: center; width: 34px; height: 34px;
  border: 0; border-radius: 9px; background: var(--surface-2); color: var(--ink); cursor: pointer;
}

.body { flex: 1; display: flex; min-height: 0; }

.side {
  position: fixed; inset: calc(52px + var(--safe-t, 0px)) auto 0 0; width: 232px; z-index: 25;
  padding: 12px 10px calc(16px + var(--safe-b, 0px));
  background: var(--surface); border-right: 1px solid var(--line);
  transform: translateX(-100%); transition: transform .2s ease;
  overflow-y: auto;
}
.side.open { transform: none; }
.scrim { position: fixed; inset: 0; z-index: 24; background: #0009; }

.who {
  display: flex; align-items: center; gap: 7px;
  font-size: 12px; color: var(--muted); margin: 0 0 10px; padding: 0 10px;
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }

.nav {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 10px 11px; margin-bottom: 2px;
  border: 0; border-radius: 10px; background: none; cursor: pointer;
  font-size: 14px; color: var(--muted); text-align: left;
}
.nav:hover { background: var(--surface-2); color: var(--ink); }
.nav.on { background: var(--surface-3); color: var(--ink); font-weight: 700; }
.badge {
  margin-left: auto; min-width: 20px; padding: 1px 6px;
  border-radius: 999px; background: var(--gold); color: #1a1410;
  font-size: 11px; font-weight: 700; text-align: center;
}

.main {
  flex: 1; min-width: 0;
  padding: 16px 14px calc(28px + var(--safe-b, 0px));
}
.err {
  margin: 0 0 12px; padding: 10px 12px; border-radius: 10px;
  background: var(--danger-wash); color: var(--danger-ink); font-size: 13px;
}

/* 桌機：側欄常駐，主內容讓開。到這個寬度表格才放得下多欄 */
@media (min-width: 900px) {
  .burger, .scrim { display: none; }
  .side { position: sticky; top: calc(52px + var(--safe-t, 0px)); height: calc(100dvh - 52px); transform: none; inset: auto; }
  .main { padding: 20px 24px 40px; }
}
</style>
