<script setup lang="ts">
// 抽獎面板：選抽數 → 前往選籤牆（親手挑籤位）
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Pool } from '@/types/models'
import { useWalletStore } from '@/stores/wallet'
import { track } from '@/lib/ga'
import BottomActionBar from '@/components/BottomActionBar.vue'

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
 * （它已經不在那棵子樹底下了），所以要另外把斷點交給 BottomActionBar。
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
/* 這裡判的是**籤數**不是狀態，而且刻意如此：這個面板只會掛在 status === 'open'
   的池上（PoolShell 與 PoolOverview 都用 isDrawable 擋在外面），
   所以它要防的不是「這池已經結束了」，是「最後幾籤在我按下去之前被別人買走」。
   那種情況下「已完抽」三個字是對的 —— 籤真的沒了。 */
const soldOut = computed(() => props.pool.remainingTickets <= 0)
const notEnoughTickets = computed(() => (selected.value ?? 0) > props.pool.remainingTickets)

/** 購買列真的浮著的時候才成立；完抽時 sheet 版退回面板內顯示，不浮出來 */
const barUp = computed(() => isSheet.value && !soldOut.value && selected.value !== null)

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
  if (selected.value === null) return
  track(`click_draw_${selected.value}` as Parameters<typeof track>[0])

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
  </div>

  <!-- 浮出的購買列。Teleport／讓位／進出場動畫都在 BottomActionBar 裡，
       這裡只給「什麼時候該有列」與列裡放什麼。
       861 是側欄那份面板出現的斷點：Teleport 出去的節點不受 .mobileCta 的
       display:none 管，桌機不自己關掉就會在側欄面板旁邊多浮出一條列。 -->
  <BottomActionBar :open="barUp" label="購買" :desktop-min-width="861">
    <p v-if="error" class="err barErr" role="alert">{{ error }}</p>
    <div class="barRow">
      <span class="barSum">
        <span class="muted">合計 {{ selected }} 抽</span>
        <strong class="mono">{{ cost.toLocaleString() }} 點</strong>
      </span>
      <button class="btn primary barGo" @click="goPick">去選籤 →</button>
    </div>
  </BottomActionBar>
</template>

<style scoped>
.panel { padding: 18px; border-radius: var(--radius-lg); }
/* minmax(0, 1fr)：1fr 的下限是 auto，也就是內容寬度 —— 「10 抽」比其他三個寬，
   用 1fr 的話那一格會撐開、隔壁三格被擠扁（docs/HANDOFF.md 2.1） */
.counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
/* 讓 scrollIntoView 知道畫面下緣那塊被浮動的列佔走了，不然它會以為
   這排已經「看得到」。算式跟 BottomActionBar 的 bottom 同源：10 的下緣間距
   ＋ 列高約 76 ＋ 8 的呼吸，再加上底部導覽／安全區的讓位 */
.counts.sheet { scroll-margin-bottom: calc(94px + max(var(--nav-total, 0px), var(--safe-b, 0px))); }
.count {
  /* 44px：抽數是整條抽卡動線的第一個決定，原本只有 40px。
     不放進 @media (pointer: coarse) —— 桌機側欄那份面板是同一個元件，
     兩種寬度差 4px 沒有任何好處，多一條斷點反而多一個會漂掉的地方
     （同 OrdersPage 的 select）。padding 維持 9px，靠 min-height 補齊，
     文字仍然垂直置中（grid + place-items）。 */
  min-height: 44px; display: grid; place-items: center;
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

.barRow { display: flex; align-items: center; gap: 12px; }
.barSum { display: grid; gap: 1px; min-width: 0; flex: 1; }
.barSum .muted { font-size: 11.5px; }
.barSum strong { font-size: 19px; color: var(--gold-deep); }
.barGo { flex: none; min-width: 0; padding: 12px 22px; font-size: 15px; }
.barErr { margin: 0 0 8px; }
</style>
