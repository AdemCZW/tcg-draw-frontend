<script setup lang="ts">
// 抽獎面板：選抽數 → 前往選籤牆（親手挑籤位）
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Pool } from '@/types/models'
import { useWalletStore } from '@/stores/wallet'
import { track } from '@/lib/ga'

/**
 * variant 決定「合計與去選籤鍵放哪裡」：
 *   panel（預設，桌機側欄）—— 都在面板裡，一進頁就預選 1 抽。側欄一直看得到，
 *     邊看獎項邊調抽數是桌機該有的效率，沒有理由多一層「先點才出現」。
 *   sheet（總覽頁的手機主 CTA）—— 初始不預選，點了抽數才從畫面下緣滑出購買列。
 *
 * 為什麼用 prop 而不是量視窗寬度：這兩份面板本來就是兩個地方各自掛的
 * （PoolShell 的側欄、PoolOverview 的 .mobileCta），誰該長什麼樣在掛的當下
 * 就已經確定，用 JS 量寬度只是把已知的事再猜一次，還會多一組 resize 監聽。
 * 至於 .mobileCta 在桌機是 display:none —— 那擋不住 Teleport 出去的購買列
 * （它已經不在那棵子樹底下了），所以購買列自己也帶一條 min-width 的媒體查詢。
 */
const props = withDefaults(defineProps<{ pool: Pool; variant?: 'panel' | 'sheet' }>(), {
  variant: 'panel'
})
const router = useRouter()
const wallet = useWalletStore()

const counts = [1, 3, 5, 10] as const
const isSheet = computed(() => props.variant === 'sheet')
/** sheet 版初始是「未選」：沒選過就不該有購買列 */
const selected = ref<number | null>(props.variant === 'sheet' ? null : 1)
const error = ref('')

const cost = computed(() => (selected.value ?? 0) * props.pool.ticketPrice)
const soldOut = computed(() => props.pool.remainingTickets <= 0)
const notEnoughTickets = computed(() => (selected.value ?? 0) > props.pool.remainingTickets)

const isStreak = computed(() => props.pool.mode === 'streak')

/** 購買列真的浮著的時候才成立；完抽時 sheet 版退回面板內顯示，不浮出來 */
const barUp = computed(() => isSheet.value && !isStreak.value && !soldOut.value && selected.value !== null)

const countsEl = ref<HTMLElement | null>(null)

/** 再點同一個抽數就取消選取、購買列收回去 —— 這是最順手的「我不買了」 */
function pick(c: number) {
  error.value = ''
  const turningOn = selected.value !== c
  selected.value = isSheet.value && !turningOn ? null : c
  if (!isSheet.value || !turningOn) return
  /* 抽數這排常常正好落在畫面下緣，購買列一浮出來就把它蓋住 ——
     使用者想改成 5 抽卻找不到剛剛按的那排。捲最小的量把它讓出來
     （讓多少寫在 .counts 的 scroll-margin-bottom，跟列的高度同一處管）。 */
  nextTick(() => countsEl.value?.scrollIntoView({ block: 'nearest' }))
}

function goPick() {
  error.value = ''
  if (!isStreak.value && selected.value === null) return
  track(`click_draw_${selected.value}` as Parameters<typeof track>[0])

  // 連莊爆賞是自己的流程（付一次入場費後連抽），不走選抽數
  if (isStreak.value) {
    if (!wallet.canAfford(props.pool.ticketPrice)) {
      track('draw_failed_insufficient')
      error.value = '點數不足，請先儲值'
      return
    }
    router.push({ name: 'streak', params: { id: props.pool.id } })
    return
  }

  if (soldOut.value || notEnoughTickets.value) {
    track('draw_failed_soldout')
    error.value = soldOut.value ? '本池已完抽' : `剩餘籤數不足 ${selected.value} 抽`
    return
  }
  if (!wallet.canAfford(cost.value)) {
    track('draw_failed_insufficient')
    error.value = '點數不足，請先儲值'
    return
  }
  router.push({ name: 'pool-pick', params: { id: props.pool.id }, query: { count: selected.value } })
}
</script>

<template>
  <div class="panel card">
    <template v-if="isStreak">
      <div class="total">
        <span class="muted">入場費</span>
        <strong class="mono">{{ pool.ticketPrice.toLocaleString() }} 點</strong>
      </div>
      <button class="btn primary go" :disabled="soldOut" @click="goPick">
        {{ soldOut ? '已完抽' : '進場連莊' }}
      </button>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p class="note muted">付一次入場費即可連續抽，隨時可收手落袋。抽到爆賞則該輪全數沒收。</p>
    </template>

    <template v-else>
      <div ref="countsEl" class="counts" :class="{ sheet: isSheet }" role="radiogroup" aria-label="抽數">
        <button
          v-for="c in counts" :key="c"
          class="count" :class="{ on: selected === c }"
          role="radio" :aria-checked="selected === c"
          :disabled="c > pool.remainingTickets"
          @click="pick(c)"
        >{{ c }} 抽</button>
      </div>

      <!-- 面板版（桌機側欄）：合計與按鈕就在原位 -->
      <template v-if="!isSheet || soldOut">
        <div class="total">
          <span class="muted">合計</span>
          <strong class="mono">{{ cost.toLocaleString() }} 點</strong>
        </div>
        <button class="btn primary go" :disabled="soldOut" @click="goPick">
          {{ soldOut ? '已完抽' : '去選籤 →' }}
        </button>
        <p v-if="error" class="err" role="alert">{{ error }}</p>
      </template>

      <!-- 公平性揭露留在面板裡，不跟著進購買列：那條列只有一行的高度，
           塞這段字會擠成三行，把真正要按的鍵推出拇指範圍 -->
      <p class="note muted">下一步由你親手選籤位。籤序已於開賣前封存（見下方 commit hash），結果不可事後變更。</p>
    </template>
  </div>

  <!-- 必須 Teleport 到 body：祖先只要有 transform（Tilt3D、任何動畫）就會變成
       position:fixed 的定位基準，這條列會被釘在卡片上而不是視窗下緣 -->
  <Teleport to="body">
    <!-- 讓位要補在整份文件的最後面，不能補在面板裡：捲到底時被列蓋住的是
         文件的最末端（全域頁尾那排連結），在中間插一段只是把整頁往下推，
         最末端相對視窗的位置一點都沒變。實測過，補在面板裡完全沒有用。
         只在列真的浮著時才存在，而且只有這一份 —— 底部導覽的讓位全域頁尾
         已經算過一次，再加一次會在下緣多出一段捲得到卻空無一物的黑。 -->
    <div v-if="barUp" class="barSpacer" aria-hidden="true" />
    <Transition name="bar">
      <div v-if="barUp" class="buybar" role="region" aria-label="購買">
        <p v-if="error" class="err" role="alert">{{ error }}</p>
        <div class="barRow">
          <span class="barSum">
            <span class="muted">合計 {{ selected }} 抽</span>
            <strong class="mono">{{ cost.toLocaleString() }} 點</strong>
          </span>
          <button class="btn primary barGo" @click="goPick">去選籤 →</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.panel { padding: 18px; border-radius: var(--radius-lg); }
.counts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
/* 讓 scrollIntoView 知道畫面下緣那塊被浮動的列佔走了，不然它會以為
   這排已經「看得到」。算式跟 .buybar 的 bottom 同源：10 的下緣間距
   ＋ 列高約 76 ＋ 8 的呼吸，再加上底部導覽／安全區的讓位 */
.counts.sheet { scroll-margin-bottom: calc(94px + max(var(--nav-total, 0px), var(--safe-b, 0px))); }
.count {
  padding: 9px 0; border-radius: 9px;
  background: var(--surface-2); border: 1px solid var(--line);
  color: var(--muted); font-size: 14px; font-weight: 600;
  min-width: 0;
}
.count.on { color: var(--ink); background: var(--accent-wash); box-shadow: var(--shadow-sm); }
.count:disabled { opacity: .35; cursor: not-allowed; }
.count:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.total { display: flex; justify-content: space-between; align-items: baseline; margin: 14px 2px 10px; }
.total strong { font-size: 20px; color: var(--gold-deep); }
.go { width: 100%; padding: 13px 0; font-size: 15.5px; }
.err { color: var(--danger); font-size: 13px; margin: 10px 0 0; font-weight: 600; }
.note { font-size: 11.5px; margin: 12px 0 0; }

/* 概略等於購買列的高度加上它與畫面下緣的間距。多留一點無妨，
   少留就會蓋住內容，寧可鬆 */
.barSpacer { height: 96px; }

/* ---- 貼底購買列 ----
   bottom 取 max()：手機的 --nav-total 已含安全區，桌機是 0 才輪到 --safe-b
   自己出面（慣例見 NotifyBell.vue）。只加 --safe-b 會被底部導覽蓋掉。 */
.buybar {
  position: fixed; z-index: 65;
  left: calc(10px + var(--safe-l, 0px));
  right: calc(10px + var(--safe-r, 0px));
  bottom: calc(10px + max(var(--nav-total, 0px), var(--safe-b, 0px)));
  padding: 12px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
}
/* Teleport 出去的節點不受 .mobileCta 的 display:none 管，桌機要自己關掉，
   否則側欄那份面板旁邊會多浮出一條列 */
@media (min-width: 861px) { .buybar, .barSpacer { display: none; } }

.barRow { display: flex; align-items: center; gap: 12px; }
.barSum { display: grid; gap: 1px; min-width: 0; flex: 1; }
.barSum .muted { font-size: 11.5px; }
.barSum strong { font-size: 19px; color: var(--gold-deep); }
.barGo { flex: none; min-width: 0; padding: 12px 22px; font-size: 15px; }
.buybar .err { margin: 0 0 8px; }

/* 滑入用 @keyframes 而不是 transition + .bar-enter-from：
   Vue 是在下一個 rAF 才拿掉 enter-from 這個 class，而 rAF 一被節流
   （背景分頁、iOS 省電）就永遠停在畫面外 —— 這個 repo 的換頁轉場已經
   踩過同一個坑（見 App.vue 的說明）。keyframes 從插入那一刻就自己跑，
   不欠任何一幀。關掉動效的人直接出現，不必等滑入。 */
@media (prefers-reduced-motion: no-preference) {
  .bar-enter-active { animation: barUp .24s cubic-bezier(.2, .85, .3, 1); }
  /* 收回刻意用另一組 keyframes 而不是把 barUp 反著播：animation-name 沒變的話
     瀏覽器當成同一個動畫、不會重新開始，animationend 就永遠不來，Vue 也就
     永遠不把這條列從 DOM 拿掉（在 rAF 被節流的分頁實測到過） */
  .bar-leave-active { animation: barDown .16s ease-in; }
}
@keyframes barUp {
  from { opacity: 0; transform: translateY(calc(100% + 16px)); }
  to   { opacity: 1; transform: none; }
}
@keyframes barDown {
  from { opacity: 1; transform: none; }
  to   { opacity: 0; transform: translateY(calc(100% + 16px)); }
}
</style>
