<script setup lang="ts">
/**
 * 頁首右上角的通知鈴，與從右緣滑出的通知抽屜。
 *
 * 為什麼是右側抽屜而不是貼底面板：鈴已經搬進 AppHeader 的右上角，貼底面板等於
 * 「按右上、東西從左下冒出來」，使用者要多花一秒把兩件事連起來。從鈴的同一側
 * 滑出，動作的起點與終點才對得上。
 *
 * 順便換來的好處是高度：貼底面板為了不蓋住整頁只能給 72dvh，扣掉標題列真正
 * 能放清單的不到六成畫面；抽屜是整條可用高度，同樣的內容不必再壓成兩行截斷。
 *
 * 手機刻意在左邊留一條背景不蓋：那條縫是在說「你還在剛才那一頁上，這只是疊上來的」，
 * 全螢幕蓋掉會被誤讀成換頁，使用者就會去找返回鍵而不是關閉鍵。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { notifications, type Notification, type NotifyKind } from '@/lib/social'
import { ApiError } from '@/lib/http'
import { useNotificationStream } from '@/composables/useNotificationStream'
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

/**
 * 串流是否連上。連上時標籤顯示「即時」，退回輪詢時顯示「定時更新」——
 * 使用者要能知道自己看到的是即時的還是可能慢一拍的。
 */
const streamConnected = ref(false)

/* ---- 通知分類 ----
   舊版每一則都是同一顆驚嘆號，賣出跟系統公告長得一模一樣，掃過去分不出
   哪則跟錢有關、哪則要你回話。這裡把 kind 拆成兩層：

   tone 決定「這件事對我是什麼性質」，只有三種，因為使用者真正要分的就三種 ——
     money 跟錢有關（進帳、成交、訂單）
     act   別人對你採取行動、球在你這邊（要回應）
     info  純告知，看過就好
   label 是兩個字的中文標籤，d 是每個 kind 各自的圖形。

   顏色不能是唯一的區分：色弱與強光下的手機螢幕都會讓色相失效，所以同一件事
   同時用「形狀（圖示）＋文字（標籤）＋顏色（tone）」講三次。act 另外用實心色塊，
   money 與 info 是淡底 —— 填色與否連黑白截圖都分得出來。

   圖示一律 inline SVG：emoji 在 Android / iOS / 各家輸入法字面差很多，
   而且偏卡通，跟這套暗色高級感的視覺對不上。 */
type Tone = 'money' | 'act' | 'info'
const KINDS: Record<NotifyKind, { tone: Tone; label: string; d: string }> = {
  // 四角星芒：抽到卡
  draw: { tone: 'info', label: '抽卡', d: 'M12 3.6l1.9 5.3 5.3 1.9-5.3 1.9-1.9 5.3-1.9-5.3-5.3-1.9 5.3-1.9z' },
  // 一來一往兩支箭：有人出價，等你回應
  'trade-offer': { tone: 'act', label: '出價', d: 'M4 8.5h13m-3.2-3.2L17 8.5l-3.2 3.2M20 15.5H7m3.2-3.2L7 15.5l3.2 3.2' },
  // 圈內打勾：你出的價有結果了
  'trade-result': { tone: 'info', label: '回覆', d: 'M21 12a9 9 0 1 1-4.4-7.7M8.6 12.1l2.7 2.7L20.4 5.7' },
  // 價牌：卡賣出，錢進來了
  'listing-sold': { tone: 'money', label: '成交', d: 'M3 12.5V5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.4.6l6.5 6.5a2 2 0 0 1 0 2.8l-7.5 7.5a2 2 0 0 1-2.8 0L3.6 13.9a2 2 0 0 1-.6-1.4zM7.5 7.5h.01' },
  // 收據：訂單
  order: { tone: 'money', label: '訂單', d: 'M5 3.5h14v17l-2.6-1.5-2.7 1.5-2.7-1.5-2.7 1.5L5 20.5zM9 8.5h6M9 12.5h4' },
  // 貨車：出貨
  shipment: { tone: 'info', label: '出貨', d: 'M3 6.5h10v9H3zM13 10h3.6l3 3v2.5H13zM7 18.6a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8zM17.4 18.6a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z' },
  // 驚嘆圈：系統
  system: { tone: 'info', label: '系統', d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.6v5.2M12 16.3h.01' }
}
/* 後端之後多加一種 kind 時，前端不該整排空白：認不得就當系統通知 */
const meta = (k: NotifyKind) => KINDS[k] ?? KINDS.system

/** 相對時間。整點以上就不再報分鐘 —— 通知看的是「新不新」，不是精確秒數 */
const DAY_MS = 86_400_000
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
function relTime(v: string | number): string {
  const t = typeof v === 'number' ? v : Date.parse(v)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return '剛剛'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分前`
  // 「昨天」要用日曆日算，不是「24 小時前」：早上 9 點看昨晚 11 點的通知，
  // 差 10 小時，講「10 小時前」沒錯但講「昨天」才是人腦裡的答案
  const days = Math.round((startOfDay(Date.now()) - startOfDay(t)) / DAY_MS)
  if (days === 0) return `${Math.floor(diff / 3_600_000)} 小時前`
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * 重抓清單。
 *
 * 對外就這一支：輪詢、切回前景、登入、開面板都走它，之後即時推播的
 * useNotificationStream({ onPush }) 也把 onPush 接到這裡 —— 推播只負責說
 * 「你有新東西」，要抓什麼、怎麼併，還是由這裡一家決定，兩邊才不會各抓一次。
 */
async function refresh() {
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
  await refresh()
  // refresh() 之後才有完整清單，把這批也算進快照（第一次開啟時 rows 還是空的）
  for (const n of rows.value) if (!n.read_at) wasUnread.value.add(n.id)
  if (!unread.value) return
  // 紅點先清：標已讀失敗也不該讓使用者一直看到紅點，下次 list 會以伺服器為準
  unread.value = 0
  try { await notifications.markRead() } catch { /* 靜默：這不是使用者主動要求的動作 */ }
}

function go(n: Notification) {
  if (!n.link) return
  /* 點進去代表真的看過了：把這一則單獨標掉，未讀樣式當場消失。
     打開面板時已經整批標過一次，這裡是補上那次失敗的情況 ——
     回上一頁時看到自己剛點過的還亮著「新」，會以為根本沒點到。 */
  wasUnread.value.delete(n.id)
  if (!n.read_at) {
    n.read_at = new Date().toISOString()
    notifications.markRead([n.id]).catch(() => { /* 靜默：導頁才是使用者要的 */ })
  }
  open.value = false
  router.push(n.link)
}

/* Esc 關閉：桌機上面板是浮層，沒有 Esc 就只能靠滑鼠點空白處 */
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') open.value = false }

/* 「什麼時候該重抓」整包交給 useNotificationStream：伺服器推、斷線退避重連、
   背景分頁不連線、以及串流不可用時的輪詢退路，都在它裡面。
   這裡原本自己有一份 90 秒輪詢與 visibilitychange —— 留著會變成兩邊各打一次。 */
const stream = useNotificationStream({
  onPush: () => {
    /* 面板開著時不當場重抓：清單在手指底下重排，使用者會點到不是他要點的那則。
       但事件不能丟，記下來等面板關掉再補。 */
    if (open.value) { pendingRefresh = true; return }
    refresh()
  },
  enabled: () => auth.isLoggedIn
})
watch(stream.connected, v => { streamConnected.value = v }, { immediate: true })

let pendingRefresh = false
watch(open, v => {
  if (!v && pendingRefresh) { pendingRefresh = false; refresh() }
})

onMounted(() => {
  if (auth.isLoggedIn) refresh()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  stream.stop()
  window.removeEventListener('keydown', onKey)
})

/* 登出要把資料清乾淨：留著上一個人的通知在記憶體裡，
   換人登入的瞬間會閃出別人的內容 */
watch(() => auth.isLoggedIn, v => {
  if (v) { refresh(); return }
  open.value = false
  rows.value = []
  unread.value = 0
})

/** 徽章最多顯示 99+，三位數以上會把圓點撐成長條 */
const badge = computed(() => (unread.value > 99 ? '99+' : String(unread.value)))
const hasRows = computed(() => rows.value.length > 0)
/** 標題列的「N 則新」用快照算：紅點已經歸零了，但這次打開看到的新東西還在 */
const freshCount = computed(() => rows.value.reduce((a, n) => a + (wasUnread.value.has(n.id) ? 1 : 0), 0))
</script>

<template>
  <!-- 沒登入不顯示：通知全部是個人的，訪客按下去只會看到空面板 -->
  <div v-if="auth.isLoggedIn" class="bell-root">
    <!-- 面板與遮罩一定要 Teleport 出去。鈴移進 AppHeader 之後，它的祖先有
         backdrop-filter —— 那跟 transform 一樣會成為 position: fixed 子孫的
         定位基準，不搬出去的話面板會貼在頁首那條上而不是視窗上。
         頁首的 z-index 是 50，面板也會被壓在其他東西下面。 -->
    <Teleport to="body">
    <!-- 遮罩：手機上壓暗背景（面板是主角），桌機只當「點空白處關閉」的接收面 -->
    <Transition name="veil">
      <div v-if="open" class="veil" @click="open = false" />
    </Transition>

    <Transition name="drawer">
      <section v-if="open" class="panel" role="dialog" aria-label="通知">
        <header class="phead">
          <h2>通知</h2>
          <span v-if="freshCount" class="newchip">{{ freshCount }} 則新</span>
          <span class="live" :class="{ on: streamConnected }">
            <span class="lamp" aria-hidden="true" />{{ streamConnected ? '即時' : '定時更新' }}
          </span>
          <button type="button" class="close" aria-label="關閉" @click="open = false">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <p v-if="err" class="msg err">{{ err }} <button type="button" class="retry" @click="refresh">重試</button></p>
        <p v-else-if="loading && !hasRows" class="msg">載入中…</p>

        <!-- 空狀態：一片空白會讓人以為壞了，畫一顆鈴＋講清楚什麼事會出現在這 -->
        <div v-else-if="!hasRows" class="blank">
          <span class="blank-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="M6.2 9.4a5.8 5.8 0 0 1 11.6 0c0 3.7 1.4 5.3 1.4 5.3H4.8s1.4-1.6 1.4-5.3zM9.9 18.2a2.1 2.1 0 0 0 4.2 0"
                stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
              />
            </svg>
          </span>
          <p class="blank-t">目前沒有新消息</p>
          <p class="blank-b">抽到卡、有人對你的卡出價、卡片賣出或訂單有進度時，都會出現在這裡。</p>
        </div>

        <div v-else class="list">
          <component
            :is="n.link ? 'button' : 'div'"
            v-for="n in rows" :key="n.id"
            class="item"
            :class="[`tone-${meta(n.kind).tone}`, { fresh: wasUnread.has(n.id), tap: !!n.link }]"
            :type="n.link ? 'button' : undefined"
            @click="go(n)"
          >
            <span class="ic">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path :d="meta(n.kind).d" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <span class="body">
              <!-- 眉標行：分類與時間都是「這則的座標」，不是內容，先一起講完再讓
                   標題獨佔一行。舊版把分類塞在內文前面、時間塞在標題後面，兩個
                   最不重要的東西各自去切一段最重要的東西 -->
              <span class="kicker">
                <span class="tag">{{ meta(n.kind).label }}</span>
                <span class="when">{{ relTime(n.created_at) }}</span>
              </span>
              <span class="t">{{ n.title }}</span>
              <span v-if="n.body" class="b">{{ n.body }}</span>
            </span>
            <!-- 有 link 才有箭頭：能不能點進去要在按下去之前就看得出來 -->
            <svg v-if="n.link" class="chev" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M9.5 5.5l6.5 6.5-6.5 6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span v-if="wasUnread.has(n.id)" class="sr">未讀</span>
          </component>
        </div>
      </section>
    </Transition>
    </Teleport>

    <button
      type="button" class="bell" :class="{ on: open, hot: unread > 0 }"
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
/* 鈴本身跟著頁首排版走，不需要自己的堆疊脈絡。
   面板與遮罩已經 Teleport 到 body，各自帶自己的 z-index。 */
.bell-root { display: contents; }

/* ---- 鈴 ----
   原本是右下角的浮動鍵，現在是頁首裡的一顆膠囊，跟餘額並排。
   浮在右下角時它一直在跟各頁貼底的動作列搶位置（市場購買鍵、卡冊選取列、
   池的購買列都撞過），搬到頁首之後那個衝突整類消失，也不必再有 hideBell 開關。
   尺寸對齊頁首其他膠囊：桌機 38、手機 32。 */
.bell {
  position: relative;
  width: 38px; height: 38px; flex: none;
  display: grid; place-items: center;
  border-radius: 50%;
  border: 1px solid var(--line);
  /* 沒有未讀時安靜一點，但要比背景亮 —— 原本是 --surface-2，
     深灰疊在深色頁面上等於隱形，使用者兩次回報「看不太到」 */
  background: var(--surface-3);
  color: var(--ink);
  transition: transform .2s cubic-bezier(.2, .7, .3, 1), background .2s, color .2s, opacity .2s;
}

/* 有未讀就整顆變金色。
   用金不用紅：紅色已經是底部導覽那顆寶貝球的，兩個紅色圓形在同一個角落
   會互相稀釋；而金色在這個站上本來就代表點數與價值，「有值得看的事發生了」
   剛好是這顆鈕要講的話。深底上的金是全畫面對比最強的組合。 */
.bell.hot {
  background: var(--gold);
  border-color: transparent;
  color: #1a1410;
  box-shadow: 0 6px 20px color-mix(in srgb, var(--gold) 45%, transparent),
              0 2px 6px rgba(0, 0, 0, .4);
}
/* 出現時輕輕跳一下就停 —— 常駐的無限迴圈動畫會變成干擾，
   這顆鈕在每一頁都在 */
@media (prefers-reduced-motion: no-preference) {
  .bell.hot { animation: bellPop .5s cubic-bezier(.34, 1.56, .64, 1); }
}
@keyframes bellPop {
  0%   { transform: scale(1); }
  45%  { transform: scale(1.14); }
  100% { transform: scale(1); }
}

.bell svg { width: 23px; height: 23px; }
.bell:active { transform: scale(.92); transition-duration: 60ms; }
/* 開著時整顆變主色。抽屜從頁首底下起算，這顆不會被蓋住，所以留著 ——
   它同時是「東西從這裡出來的」的錨點，也是再按一次就收回去的開關
   （貼底面板時代手機上會把它藏掉，是因為那時面板正好壓在鈴上） */
.bell.on { background: var(--accent); border-color: transparent; color: #fff; }
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
.veil { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, .45); }

/* ---- 面板：從右緣滑出的抽屜 ---- */
.panel {
  position: fixed; z-index: 91;
  /* 從頁首底下起算，不蓋住它：頁首上還有餘額與返回，關掉通知之前那些仍該可讀。
     手機頁首是 56、桌機 66（見 AppHeader 的 .row），兩者都要再加瀏海的 --safe-t */
  top: calc(56px + var(--safe-t, 0px));
  right: 0; bottom: 0;
  /* 左邊留一條背景。用 max() 是為了橫置時左側瀏海也吃得掉 */
  left: max(46px, var(--safe-l, 0px));
  display: flex; flex-direction: column;
  /* 抽屜貼著右緣與下緣，兩邊的安全區都要自己讓：底色仍鋪滿到螢幕邊
     （中斷的底色比壓到內容更難看），只把內容推進來 */
  padding-right: var(--safe-r, 0px);
  padding-bottom: var(--safe-b, 0px);
  background: var(--surface);
  border-left: 1px solid var(--line);
  /* 只圓左上角：右側與下緣都貼齊螢幕，那裡的圓角只會露出一小塊底色 */
  border-radius: var(--radius-lg) 0 0 0;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

/* 標題列在抽屜裡要比在貼底面板時重一點：清單長，捲到一半時這條是唯一還留在
   畫面上的「我在哪」，底下補一條線讓捲動的內容不會直接貼上標題 */
.phead {
  flex: none;
  display: flex; align-items: center; gap: 8px;
  padding: 8px 8px 8px 18px;
  border-bottom: 1px solid var(--line-soft);
}
.phead h2 { font-size: 15px; font-weight: 700; margin: 0; flex: none; }
/* 「N 則新」：紅點消失後仍要有東西回答「我剛剛漏了幾則」 */
.newchip {
  flex: none; min-width: 0;
  padding: 2px 8px;
  border-radius: var(--pill);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent-soft);
  font-size: 11px; font-weight: 700; line-height: 1.6;
}
/* 即時推播接上之前先佔位。字很小、顏色很淡：這是狀態不是內容 */
.live {
  margin-left: auto; flex: none; min-width: 0;
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 10.5px; color: var(--faint);
}
.live .lamp { width: 5px; height: 5px; border-radius: 50%; background: var(--faint); }
.live.on { color: var(--ok-ink); }
.live.on .lamp { background: var(--ok); }
/* 44×44 是拇指要的尺寸，但視覺重量不必跟著大：拿掉底色，只留一個灰叉 */
.close {
  flex: none;
  width: 44px; height: 44px; display: grid; place-items: center;
  /* border 要自己歸零：這顆沒有底色，瀏覽器預設的 button 外框會整圈跑出來 */
  border: 0; border-radius: 50%; background: transparent; color: var(--faint);
}
.close svg { width: 17px; height: 17px; }
.close:active { transform: scale(.9); background: var(--surface-2); }
@media (hover: hover) { .close:hover { color: var(--ink); background: var(--surface-2); } }
.close:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

.msg { margin: 0; padding: 22px 18px 28px; font-size: 13.5px; line-height: 1.8; color: var(--muted); }
.msg.err { color: var(--danger); }
.retry { color: var(--accent); font-weight: 600; text-decoration: underline; }

/* ---- 空狀態 ----
   margin auto 讓它在抽屜的空高度裡置中。貼底面板時內容一定塞滿，抽屜卻可能
   只有一句話配一整條畫面，靠在最上面會像是還沒載完 */
.blank { margin: auto 0; padding: 26px 30px 38px; text-align: center; }
.blank-ic {
  width: 54px; height: 54px; margin: 0 auto 12px;
  display: grid; place-items: center;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--faint);
}
.blank-ic svg { width: 26px; height: 26px; }
.blank-t { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: var(--ink); }
.blank-b { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--muted); }

/* ---- 清單 ---- */
.list {
  /* flex: 1 才會把抽屜剩下的高度吃完 —— 沒有它，清單只有內容高，
     捲動會落到整頁上，抽屜自己反而不動 */
  flex: 1; min-height: 0;
  overflow-y: auto;
  /* 抽屜滑到底不要把整頁一起帶動 */
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
/* 一則三行：眉標（分類＋時間）、標題、內文。
   抽屜的高度是貼底面板的兩倍有餘，省下來的那一行不必再拿去換截斷 —— 舊版
   把分類跟內文擠在同一行，內文常常只剩「訂單 #A2481 共 3 張…」看不出結果 */
.item {
  position: relative;
  width: 100%;
  display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 12px;
  align-items: start;
  text-align: left;
  padding: 13px 16px 14px;
  /* 每則有 link 時是 <button>，border 一定要自己歸零 —— 這個專案沒有全域的
     button reset（見上面 .close 的同一個坑）。舊版只覆蓋了 border-bottom，
     另外三邊的瀏覽器預設外框就整圈留著，一排下來像一疊盒子 */
  border: 0;
  color: var(--ink);
  background: transparent;
  transition: background .15s;
}
/* 分隔線縮排到文字欄起點，而且是每則之間才有（不是每則自己一條下邊框）。
   齊頭的滿版線會把每一則框成一格一格，縮排之後圖示那欄是連續的留白，
   一整排看起來是一份清單而不是一疊卡片 */
.item + .item::before {
  content: ''; position: absolute; left: 62px; right: 16px; top: 0;
  height: 1px; background: var(--line-soft);
}
.item.tap { cursor: pointer; padding-right: 34px; }
.item.tap:active { background: var(--surface-2); }
@media (hover: hover) { .item.tap:hover { background: var(--surface-2); } }
.item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

/* 未讀同時給三個訊號：左緣色條（形狀）、極淡底色、標題加粗。
   只靠底色的話，深色模式下那點色差在陽光下的手機上等於沒有 */
.item.fresh { background: color-mix(in srgb, var(--accent) 6%, transparent); }
/* 用 ::after 不用 ::before：::before 已經是那條縮排分隔線了 */
.item.fresh::after {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0;
  width: 3px;
  background: var(--accent);
}
.item.fresh .t { font-weight: 700; color: var(--ink); }

/* tone 決定顏色，圖形與標籤各自另外講一次，色弱也分得出來 */
.ic {
  width: 34px; height: 34px;
  display: grid; place-items: center;
  border-radius: 11px;
  /* 底色從 currentColor 混：每個 tone 只要換 color 一個值 */
  background: color-mix(in srgb, currentColor 15%, transparent);
  color: var(--muted);
}
.ic svg { width: 18px; height: 18px; }
.tone-info .ic { color: var(--tier-c); }
.tone-money .ic { color: var(--gold); }
/* 要你回應的那類用實心色塊 —— 填色與否是連黑白截圖都成立的差異 */
.tone-act .ic {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 40%, transparent);
}

.body { display: grid; gap: 3px; min-width: 0; }

/* 眉標行：整行都是小字淡色，刻意讓它比標題輕兩級。
   它要能被找到（想知道多久以前的時候），但不該在掃視時被讀到 */
.kicker { display: flex; align-items: center; gap: 7px; min-width: 0; }
/* 兩個字的分類標籤。有它才能在不看顏色的情況下知道這是「成交」還是「出貨」 */
.tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 10.5px; font-weight: 700; line-height: 1.6;
  background: color-mix(in srgb, currentColor 14%, transparent);
  color: var(--muted);
}
.tone-info .tag { color: var(--tier-c); }
.tone-money .tag { color: var(--gold); }
.tone-act .tag { color: var(--accent-soft); }
/* 時間跟在標籤後面，不再靠右對齊：靠右時它會跟標題搶同一條視線，
   而且每則的長度不一，右緣參差反而更吵 */
.when {
  flex: 1; min-width: 0;
  font-size: 11px; color: var(--faint);
  font-variant-numeric: tabular-nums;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* 標題自己一行，是這一則裡最重的東西 —— 「發生了什麼事」就寫在這。
   兩行才截斷：一行截斷會把「你的出價被接受了」砍成看不懂的半句 */
.t {
  min-width: 0;
  font-size: 14px; font-weight: 600; line-height: 1.45;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow: hidden;
}
/* 內文給兩行：通知是索引不是內文，但一行連「以 4,200 點成交」都放不下的索引
   等於沒有內容，還要逼使用者點進去才知道要不要在意 */
.b {
  min-width: 0;
  font-size: 12.5px; line-height: 1.65; color: var(--muted);
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow: hidden;
}

/* 箭頭很淡：它只回答「這則點得進去嗎」，不是要人去按它 */
.chev {
  position: absolute; right: 12px; top: 16px;
  width: 14px; height: 14px; color: var(--faint);
}
/* 未讀狀態不再另外畫一顆點：左緣色條已經講過了，
   但讀螢幕的人看不到色條，用隱藏文字補 */
.sr {
  position: absolute; width: 1px; height: 1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}

@media (max-width: 720px) {
  /* 對齊頁首在窄螢幕上收小的膠囊高度（見 AppHeader 的 .wallet） */
  .bell { width: 32px; height: 32px; }
  .bell svg { width: 19px; height: 19px; }
}

@media (min-width: 721px) {
  /* 桌機一樣從右邊來，只是浮成一張離邊的卡片：滿版貼邊的抽屜在 1280 寬的畫面上
     會像是網站的第二欄，而不是一層可以關掉的東西。
     高度用 max-height 不是 bottom：只有兩則通知時撐一條到底的空白很怪，
     但真的有二十則時它會一路長到畫面底 —— 這就是「佔滿可用高度」要的行為 */
  .panel {
    left: auto; bottom: auto;
    top: calc(66px + var(--safe-t, 0px) + 8px);
    right: calc(14px + var(--safe-r, 0px));
    width: 380px;
    max-height: calc(100dvh - 66px - var(--safe-t, 0px) - var(--safe-b, 0px) - 22px);
    padding-right: 0; padding-bottom: 6px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }
  .phead { padding-top: 10px; }
  /* 桌機不壓暗背景：面板只佔角落一塊，壓暗整頁的份量不對，
     這裡只留它「點空白處關閉」的功能 */
  .veil { background: transparent; }
}

/* ---- 轉場 ----
   用 @keyframes 而不是 transition，而且進出場是兩組各自具名的動畫。
   兩個坑都在這一段裡：
   1. 收回不能把進場的那組反著播 —— animation-name 沒變時瀏覽器當成同一個動畫
      不會重啟，animationend 不來，Vue 就永遠不移除節點（這支檔案實測撞過）。
   2. 之所以不用 transition：Vue 要等下一個 rAF 才拿掉 -enter-from，而分頁不在
      前景（或被瀏覽器節流）時 rAF 可能遲遲不來，抽屜會停在畫面外不進來。
      keyframes 從掛上去的那一刻就自己跑完，不欠任何一幀。
   也因此這裡刻意不寫 -enter-from / -leave-to：起訖狀態全由 keyframes 說了算，
   多寫一份殘留的 transform 反而會在動畫結束後把抽屜彈回畫面外。 */
@media (prefers-reduced-motion: no-preference) {
  .veil-enter-active { animation: veilIn .18s ease both; }
  .veil-leave-active { animation: veilOut .16s ease both; }
  @keyframes veilIn { from { opacity: 0; } }
  @keyframes veilOut { to { opacity: 0; } }

  /* 進場帶一點減速曲線（像被推進來停住），收回是直的加速（被抽走），
     兩邊時間也不對稱：關閉是使用者已經決定好的事，不必陪它慢慢演 */
  .drawer-enter-active { animation: drawerIn .28s cubic-bezier(.2, .85, .3, 1) both; }
  .drawer-leave-active { animation: drawerOut .18s cubic-bezier(.4, 0, 1, 1) both; }
  @keyframes drawerIn { from { transform: translateX(100%); opacity: .5; } }
  @keyframes drawerOut { to { transform: translateX(100%); opacity: .5; } }
}
</style>
