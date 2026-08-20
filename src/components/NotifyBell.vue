<script setup lang="ts">
/**
 * 右下角通知鈴。
 *
 * 為什麼是浮動鈴而不是塞進 AppHeader：手機上的重要動作都在畫面下緣（底部導覽、
 * 選籤結算列），把通知放頂端等於要使用者換一次手。而底部導覽的五格已經滿了，
 * 再擠一格會讓「抽選」中央鍵失去重心 —— 所以獨立成一顆浮動鍵。
 *
 * 位置要同時避開兩件事：底部導覽（手機才有，高度是 --nav-total，本身已含安全區）
 * 與 iPhone 的底部安全區（桌機寬度下 --nav-total 是 0，這時才需要自己補 --safe-b）。
 * 用 max() 一式吃掉兩種情況，不用再寫一組斷點 —— 斷點寫多了，改 --nav-h 就會漏改。
 *
 * 面板在手機是貼底的 bottom sheet（幾乎全寬、大目標好按，蓋掉底部導覽是刻意的：
 * 展開時使用者的注意力就在通知上），桌機才收成右下角的卡片。
 * 手機上用小小的下拉選單是桌機思維，拇指按不準。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { notifications, type Notification, type NotifyKind } from '@/lib/social'
import { ApiError } from '@/lib/http'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const open = ref(false)
const loading = ref(false)
const err = ref('')
const rows = ref<Notification[]>([])
/** 伺服器回報的未讀數。標為已讀後直接歸零，不等下一次 list 回來才清紅點 */
const unread = ref(0)
/**
 * 這次打開之前有哪些是未讀的。
 *
 * 打開就全部標已讀（紅點該立刻消失，這是使用者按下去想要的結果），
 * 但畫面上仍用這份快照把「這次新來的」標出來 —— 否則面板一打開所有項目
 * 長得一模一樣，等於看不到自己漏了什麼。快照只活在這次開啟期間。
 */
const wasUnread = ref<Set<number>>(new Set())

/* 圖示一律 inline SVG：emoji 在 Android / iOS / 各家輸入法字面差很多，
   而且偏卡通，跟這套暗色高級感的視覺對不上。 */
const ICONS: Record<NotifyKind, string> = {
  // 四角星芒：抽到卡
  draw: 'M12 3.6l1.9 5.3 5.3 1.9-5.3 1.9-1.9 5.3-1.9-5.3-5.3-1.9 5.3-1.9z',
  // 一來一往兩支箭：有人出價
  'trade-offer': 'M4 8.5h13m-3.2-3.2L17 8.5l-3.2 3.2M20 15.5H7m3.2-3.2L7 15.5l3.2 3.2',
  // 圈內打勾：出價有結果了
  'trade-result': 'M21 12a9 9 0 1 1-4.4-7.7M8.6 12.1l2.7 2.7L20.4 5.7',
  // 價牌：卡賣出
  'listing-sold': 'M3 12.5V5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.4.6l6.5 6.5a2 2 0 0 1 0 2.8l-7.5 7.5a2 2 0 0 1-2.8 0L3.6 13.9a2 2 0 0 1-.6-1.4zM7.5 7.5h.01',
  // 收據：訂單
  order: 'M5 3.5h14v17l-2.6-1.5-2.7 1.5-2.7-1.5-2.7 1.5L5 20.5zM9 8.5h6M9 12.5h4',
  // 貨車：出貨
  shipment: 'M3 6.5h10v9H3zM13 10h3.6l3 3v2.5H13zM7 18.6a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8zM17.4 18.6a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z',
  // 驚嘆圈：系統
  system: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.6v5.2M12 16.3h.01'
}
const ICON_FALLBACK = ICONS.system

/** 相對時間。整點以上就不再報分鐘 —— 通知看的是「新不新」，不是精確秒數 */
const DAY_MS = 86_400_000
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
function relTime(v: string | number): string {
  const t = typeof v === 'number' ? v : Date.parse(v)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return '剛剛'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`
  // 「昨天」要用日曆日算，不是「24 小時前」：早上 9 點看昨晚 11 點的通知，
  // 差 10 小時，講「10 小時前」沒錯但講「昨天」才是人腦裡的答案
  const days = Math.round((startOfDay(Date.now()) - startOfDay(t)) / DAY_MS)
  if (days === 0) return `${Math.floor(diff / 3_600_000)} 小時前`
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

async function load() {
  if (!auth.isLoggedIn || loading.value) return
  loading.value = true
  err.value = ''
  try {
    const r = await notifications.list()
    rows.value = r.notifications
    unread.value = r.unread
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : '連線失敗'
  } finally {
    loading.value = false
  }
}

async function toggle() {
  if (open.value) { open.value = false; return }
  wasUnread.value = new Set(rows.value.filter(n => !n.read_at).map(n => n.id))
  open.value = true
  await load()
  // load() 之後才有完整清單，把這批也算進快照（第一次開啟時 rows 還是空的）
  for (const n of rows.value) if (!n.read_at) wasUnread.value.add(n.id)
  if (!unread.value) return
  // 紅點先清：標已讀失敗也不該讓使用者一直看到紅點，下次 list 會以伺服器為準
  unread.value = 0
  try { await notifications.markRead() } catch { /* 靜默：這不是使用者主動要求的動作 */ }
}

function go(n: Notification) {
  if (!n.link) return
  open.value = false
  router.push(n.link)
}

/* Esc 關閉：桌機上面板是浮層，沒有 Esc 就只能靠滑鼠點空白處 */
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') open.value = false }

/* 通知的價值在於「新」，開著分頁不動也該長出東西來。
   分頁不可見時跳過 —— 背景分頁的輪詢只會白花流量，而且回到前景時
   visibilitychange 會補一次。面板開著時也跳過，免得清單在手指底下重排。 */
let timer: number | undefined
const POLL_MS = 90_000
function tick() {
  if (document.visibilityState !== 'visible' || open.value) return
  load()
}
function onVisible() { if (document.visibilityState === 'visible') load() }

onMounted(() => {
  if (auth.isLoggedIn) load()
  timer = window.setInterval(tick, POLL_MS)
  window.addEventListener('keydown', onKey)
  document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('visibilitychange', onVisible)
})

/* 登出要把資料清乾淨：留著上一個人的通知在記憶體裡，
   換人登入的瞬間會閃出別人的內容 */
watch(() => auth.isLoggedIn, v => {
  if (v) { load(); return }
  open.value = false
  rows.value = []
  unread.value = 0
})

/** 徽章最多顯示 99+，三位數以上會把圓點撐成長條 */
const badge = computed(() => (unread.value > 99 ? '99+' : String(unread.value)))
const hasRows = computed(() => rows.value.length > 0)
</script>

<template>
  <!-- 沒登入不顯示：通知全部是個人的，訪客按下去只會看到空面板 -->
  <div v-if="auth.isLoggedIn" class="bell-root">
    <!-- 遮罩：手機上壓暗背景（面板是主角），桌機只當「點空白處關閉」的接收面 -->
    <Transition name="veil">
      <div v-if="open" class="veil" @click="open = false" />
    </Transition>

    <Transition name="sheet">
      <section v-if="open" class="panel" role="dialog" aria-label="通知">
        <header class="phead">
          <h2>通知</h2>
          <button type="button" class="close" aria-label="關閉" @click="open = false">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <p v-if="err" class="msg err">{{ err }} <button type="button" class="retry" @click="load">重試</button></p>
        <p v-else-if="loading && !hasRows" class="msg">載入中…</p>
        <p v-else-if="!hasRows" class="msg empty">
          還沒有任何通知。<br>
          抽到卡、有人對你的卡出價、卡片賣出或訂單有進度時，都會出現在這裡。
        </p>

        <div v-else class="list">
          <component
            :is="n.link ? 'button' : 'div'"
            v-for="n in rows" :key="n.id"
            class="item"
            :class="{ fresh: wasUnread.has(n.id), tap: !!n.link }"
            :type="n.link ? 'button' : undefined"
            @click="go(n)"
          >
            <span class="ic" :class="n.kind">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path :d="ICONS[n.kind] || ICON_FALLBACK" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <span class="body">
              <span class="t">{{ n.title }}</span>
              <span class="b">{{ n.body }}</span>
              <span class="when">{{ relTime(n.created_at) }}</span>
            </span>
            <!-- 未讀點放在右上：整列都是文字，只有這一點是圓的，掃視時抓得住 -->
            <span v-if="wasUnread.has(n.id)" class="dot" aria-label="未讀" />
          </component>
        </div>
      </section>
    </Transition>

    <button
      type="button" class="bell" :class="{ on: open }"
      :aria-label="unread ? `通知，${unread} 則未讀` : '通知'"
      :aria-expanded="open"
      @click="toggle"
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M6.2 9.4a5.8 5.8 0 0 1 11.6 0c0 3.7 1.4 5.3 1.4 5.3H4.8s1.4-1.6 1.4-5.3zM9.9 18.2a2.1 2.1 0 0 0 4.2 0"
          stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
        />
      </svg>
      <span v-if="unread" class="badge" :class="{ wide: unread > 9 }">{{ badge }}</span>
    </button>
  </div>
</template>

<style scoped>
/* z 層：底部導覽是 60、頁首 sticky 是 50，鈴要在導覽之上；
   開卡結果的沉浸層是 80，但那些頁面 chrome=none，本元件根本不會掛上去 */
.bell-root { position: relative; z-index: 70; }

/* ---- 浮動鈴 ----
   bottom 用 max()：手機的 --nav-total 已經含了 --safe-b（見 tokens.css），
   桌機的 --nav-total 是 0，這時才輪到 --safe-b 自己出面（iPad 橫放也有底部橫條）。
   兩者取大的，一式覆蓋兩種情況，不用再多一組斷點。 */
.bell {
  position: fixed;
  right: calc(14px + var(--safe-r, 0px));
  bottom: calc(14px + max(var(--nav-total, 0px), var(--safe-b, 0px)));
  width: 50px; height: 50px;
  display: grid; place-items: center;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--ink);
  box-shadow: var(--shadow);
  transition: transform .2s cubic-bezier(.2, .7, .3, 1), background .2s, color .2s, opacity .2s;
}
.bell svg { width: 23px; height: 23px; }
.bell:active { transform: scale(.92); transition-duration: 60ms; }
.bell.on { background: var(--accent); border-color: transparent; color: #fff; }
/* 手機上面板貼底，鈴會浮在清單上面擋住其中一則 —— 展開時直接讓它退場，
   關閉有面板自己的 × 與遮罩，不缺這顆。桌機面板在鈴的上方，不會擋到，維持顯示 */
@media (max-width: 720px) {
  .bell.on { opacity: 0; transform: scale(.8); pointer-events: none; }
}
.bell:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

/* 徽章：有數字就顯示數字，一位數維持正圓 */
.badge {
  position: absolute; top: -3px; right: -3px;
  min-width: 19px; height: 19px;
  padding: 0 5px;
  display: grid; place-items: center;
  border-radius: var(--pill);
  background: var(--accent);
  color: #fff;
  font-size: 11px; font-weight: 700; line-height: 1;
  /* 描邊用底色：徽章疊在鈴的邊線上，沒有這圈會糊成一團 */
  box-shadow: 0 0 0 2px var(--bg);
}
.badge.wide { letter-spacing: -0.02em; }

/* ---- 遮罩 ---- */
.veil { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); }

/* ---- 面板：手機貼底、桌機右下 ---- */
.panel {
  position: fixed; left: 0; right: 0; bottom: 0;
  display: flex; flex-direction: column;
  max-height: min(76vh, 560px);
  background: var(--surface);
  border-top: 1px solid var(--line);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  box-shadow: var(--shadow-lg);
  /* 面板蓋掉底部導覽是刻意的：展開時注意力就該全在通知上。
     但仍要讓開安全區，否則最後一則會被 Home 橫條壓住 */
  padding-bottom: var(--safe-b, 0px);
  overflow: hidden;
}
.phead {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--line-soft);
}
.phead h2 { font-size: 15px; margin: 0; flex: 1; }
.close {
  width: 32px; height: 32px; display: grid; place-items: center;
  border-radius: 50%; background: var(--surface-2); color: var(--muted);
}
.close svg { width: 16px; height: 16px; }
.close:active { transform: scale(.92); }

.msg { margin: 0; padding: 26px 18px 30px; font-size: 13.5px; line-height: 1.8; color: var(--muted); }
.msg.empty { text-align: center; }
.msg.err { color: var(--danger); }
.retry { color: var(--accent); font-weight: 600; text-decoration: underline; }

.list {
  overflow-y: auto;
  /* 面板滑到底不要把整頁一起帶動 */
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
.item {
  position: relative;
  width: 100%;
  display: grid; grid-template-columns: 34px 1fr; gap: 11px;
  align-items: start;
  text-align: left;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--ink);
  background: transparent;
  transition: background .15s;
}
.item:last-child { border-bottom: 0; }
.item.tap { cursor: pointer; }
.item.tap:active { background: var(--surface-2); }
@media (hover: hover) { .item.tap:hover { background: var(--surface-2); } }
.item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
/* 未讀底色極淡：整排都亮起來就等於沒有重點 */
.item.fresh { background: color-mix(in srgb, var(--accent) 7%, transparent); }

.ic {
  width: 34px; height: 34px;
  display: grid; place-items: center;
  border-radius: 11px;
  /* 底色從 currentColor 混：每個 kind 只要換 color 一個值 */
  background: color-mix(in srgb, currentColor 16%, transparent);
  color: var(--muted);
}
.ic svg { width: 18px; height: 18px; }
.ic.draw { color: var(--gold); }
.ic.trade-offer { color: var(--accent); }
.ic.trade-result { color: var(--tier-b); }
.ic.listing-sold { color: var(--ok); }
.ic.order { color: var(--tier-c); }
.ic.shipment { color: var(--tier-c); }
.ic.system { color: var(--muted); }

.body { display: grid; gap: 3px; min-width: 0; }
.t { font-size: 13.5px; font-weight: 600; line-height: 1.45; }
.item.fresh .t { font-weight: 700; }
.b {
  font-size: 12.5px; line-height: 1.6; color: var(--muted);
  /* 兩行截斷：通知是索引不是內文，太長反而讓人一則都不想看 */
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow: hidden;
}
.when { font-size: 11px; color: var(--faint); }
.dot {
  position: absolute; top: 15px; right: 14px;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent);
}

/* ---- 桌機：收成右下角的卡片，不再貼底 ---- */
@media (min-width: 721px) {
  .panel {
    left: auto;
    right: calc(14px + var(--safe-r, 0px));
    bottom: calc(74px + var(--safe-b, 0px));
    width: 380px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding-bottom: 0;
  }
  /* 桌機不壓暗背景：面板只佔角落一小塊，壓暗整頁的份量不對，
     這裡只留它「點空白處關閉」的功能 */
  .veil { background: transparent; }
}

/* ---- 轉場 ---- */
@media (prefers-reduced-motion: no-preference) {
  .veil-enter-active, .veil-leave-active { transition: opacity .18s ease; }
  .veil-enter-from, .veil-leave-to { opacity: 0; }
  .sheet-enter-active { transition: transform .26s cubic-bezier(.2, .85, .3, 1), opacity .2s ease; }
  .sheet-leave-active { transition: transform .18s ease-in, opacity .18s ease-in; }
  .sheet-enter-from, .sheet-leave-to { opacity: 0; transform: translateY(100%); }
  @media (min-width: 721px) {
    .sheet-enter-from, .sheet-leave-to { transform: translateY(10px) scale(.98); }
  }
}
</style>
