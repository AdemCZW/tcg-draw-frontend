<script setup lang="ts">
/**
 * 一行「標籤 ＋ 值 ＋ 複製」。
 *
 * 為什麼需要它：新的出貨模型裡，平台只負責把收件資訊交給賣家，真正的寄送
 * 發生在站外 —— 賣家會把地址貼進物流商的網站、把訂單編號貼進 LINE。
 * 所以「看得到」不夠，一定要「拿得走」：手抄地址是這條流程最容易出錯的
 * 一步，抄錯一個字包裹就寄丟了，而寄丟的後果會落在託管的時限上。
 *
 * 複製失敗要講出來，不能安靜地什麼都沒發生 —— 非 HTTPS、使用者拒絕權限、
 * 舊瀏覽器都會讓 navigator.clipboard 直接爆掉。那時候要明講「請長按選取」，
 * 否則使用者只會看到按了沒反應，然後貼出上一次剪貼簿裡的東西。
 */
import { onUnmounted, ref } from 'vue'

const props = defineProps<{
  label: string
  value: string
  /** 值用等寬字。編號、電話要（一個字一個字對得起來），地址不要 */
  mono?: boolean
  /** 真正寫進剪貼簿的字。預設就是 value */
  copyText?: string
  /** 值放大成主角。訂單編號是雙方對話的共同代號，要比一般欄位顯眼 */
  big?: boolean
  testid?: string
}>()

const state = ref<'idle' | 'ok' | 'fail'>('idle')
let t: number | undefined

async function copy() {
  try {
    /* navigator.clipboard 在非安全來源上是 undefined，讀 .writeText 會同步
       丟 TypeError —— 寫在 try 裡面才接得到，不能只 await 一個 promise。 */
    await navigator.clipboard.writeText(props.copyText ?? props.value)
    state.value = 'ok'
  } catch {
    state.value = 'fail'
  }
  clearTimeout(t)
  /* 回饋自己消失。留著的話連續複製兩欄時畫面上會同時有兩個「已複製」，
     反而看不出剛剛複製到的是哪一個。 */
  t = window.setTimeout(() => { state.value = 'idle' }, 2400)
}
onUnmounted(() => clearTimeout(t))
</script>

<template>
  <div class="cpRow">
    <div class="cpMain">
      <span class="cpLb">{{ label }}</span>
      <span class="cpVal" :class="{ mono, big }">{{ value }}</span>
    </div>
    <button
      type="button" class="cpBtn" :class="{ done: state === 'ok' }"
      :data-testid="testid" :aria-label="`複製${label}`" @click="copy()"
    >
      <svg v-if="state === 'ok'" class="cpIco" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.2 8.6l3.1 3.1L12.8 5" fill="none" stroke="currentColor"
              stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <svg v-else class="cpIco" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5.5" y="5.5" width="8.2" height="8.2" rx="1.9"
              fill="none" stroke="currentColor" stroke-width="1.5" />
        <path d="M10.6 3.3H4.1A1.8 1.8 0 0 0 2.3 5.1v6.5" fill="none"
              stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
      <span class="cpTxt">{{ state === 'ok' ? '已複製' : '複製' }}</span>
    </button>
    <!-- 按鈕上的字換掉了，但讀屏不一定會念出來 —— 補一個 live region -->
    <span class="sr-only" role="status">{{ state === 'ok' ? `${label}已複製` : '' }}</span>
    <p v-if="state === 'fail'" class="cpFail" role="status">
      這個瀏覽器不允許自動複製，請長按上面的{{ label }}手動選取。
    </p>
  </div>
</template>

<style scoped>
/* minmax(0, …) 不是 1fr：值可能是一長串地址，用 1fr 的話子項的最小內容
   寬度會把整條列撐爆，手機上直接橫向溢出。 */
.cpRow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 7px 0;
}
.cpMain { min-width: 0; }

.cpLb { display: block; font-size: 11.5px; line-height: 1.4; color: var(--muted); margin-bottom: 2px; }
.cpVal {
  display: block;
  font-size: 14px; line-height: 1.5; color: var(--ink);
  /* 長地址、長姓名要斷得下去。break-word 對沒有空格的長串無效，
     anywhere 才會在任何位置斷行 —— 這裡寧可醜也不能溢出。 */
  overflow-wrap: anywhere;
}
.cpVal.big { font-size: 16px; font-weight: 600; letter-spacing: .01em; }

.cpBtn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  /* 44px 是觸控目標下限。地址那一列常常只有一行字高，不撐開的話按鈕會縮到 30px */
  min-height: 44px; min-width: 44px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: var(--pill);
  background: var(--surface-2);
  color: var(--ink);
  font: inherit; font-size: 12.5px; font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background .16s, color .16s, border-color .16s;
}
.cpBtn:active { transform: scale(.96); }
.cpBtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (hover: hover) {
  .cpBtn:hover { border-color: var(--accent); color: var(--accent); }
}
.cpBtn.done { background: var(--ok-wash); color: var(--ok-ink); border-color: transparent; }
.cpIco { width: 15px; height: 15px; flex: none; }
.cpTxt { min-width: 0; }

.cpFail {
  grid-column: 1 / -1;
  margin: 4px 0 0;
  font-size: 11.5px; line-height: 1.6; color: var(--warn-ink);
}
</style>
