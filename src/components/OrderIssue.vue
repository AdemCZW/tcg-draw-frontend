<script setup lang="ts">
/**
 * 「我要問一件事」——每一筆訂單／結算上的低門檻提問。
 *
 * ── 為什麼它不是既有的「我要申訴」 ──────────────────────────────
 * 站上已經有一條爭議路（/v1/orders/:id/dispute）：它會把訂單推進 disputed、
 * 點數維持凍結、要求完整未剪輯的開箱影片，而且訂單之後不能再確認收貨。
 * 那條路的意思是「**我要退款**」。
 *
 * 但使用者最常見的狀況不是要退款，是「東西還沒到，我想問一下」——
 * 而唯一看得到的按鈕是申訴。結果只有兩種：不敢按（問題爛在心裡），
 * 或是按下去（把一個可以三句話解決的問題變成一樁凍結點數的爭議）。
 * 所以這一顆存在的理由就是把那兩件事分開：**這顆不動錢**。
 *
 * 兩件事要在畫面上分得出來，所以這顆刻意做成低權重（虛線外框、不是實心鈕），
 * 而且面板第一段就先講「這裡不會退款」——按錯的人在送出前就會發現。
 *
 * ── 不分狀態都給 ─────────────────────────────────────────────────
 * 已完成的訂單一樣掛得上。卡收到之後才發現有問題是常態，而那時候訂單本身
 * 已經不能申訴了 —— 那正是最需要有個地方可以講的時候。
 *
 * ── 為什麼參照編號寫進內文，而不是靠 prizeId ────────────────────
 * 後端的 POST /v1/tickets 對 card-issue 只認 prizeId，而且會驗
 * 「這張卡在你的卡冊裡」（routes/tickets.ts：prizes where id = ? and user_id = me）。
 * 兩條路都拿不到一個過得了那道驗證的 prizeId：
 *   抽卡池結算  賣家看到的那一列，prize 的擁有者是**買家**，賣家送出去必定
 *               被擋成 BAD_PRIZE
 *   託管訂單    Order 上根本沒有 prizeId 這個欄位（見 shared/domain.ts）
 * 而 orderId 那一欄後端的 zod 直接忽略（CreateBody 沒有這個鍵）。
 * 所以不猜、也不送一個會被打回來的值：把編號、卡名、我是哪一側、目前狀態
 * 附在內文最後面。客服照著那幾行查得到，而且它不會因為後端欄位改名而消失。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useTicketsStore } from '@/stores/tickets'
import { ApiError } from '@/lib/http'

const props = defineProps<{
  /** 這一筆的編號：訂單編號或結算編號。它是客服查得到這筆交易的唯一線索 */
  refId: string
  src: 'pool' | 'market'
  cardName: string
  /** 我在這一筆裡是誰。客服要先知道問的人站在哪一側才讀得懂問題 */
  side: 'buyer' | 'seller'
  /** 目前狀態的中文，原樣附進內文 —— 開單當下的狀態之後查不回來 */
  statusText: string
}>()

const tickets = useTicketsStore()

const open = ref(false)
const subject = ref('')
const body = ref('')
const busy = ref(false)
const err = ref('')
/** 送出成功的單號。留在畫面上不自動消失 —— 那是使用者唯一的回執 */
const sentId = ref('')

const SRC_LABEL = { pool: '抽卡池結算', market: '託管訂單' } as const
const srcLabel = computed(() => SRC_LABEL[props.src])
const sideLabel = computed(() => (props.side === 'seller' ? '賣家' : '買家'))

/* 後端主旨上限 60 字，超過整張單會被打回來。預填就先切好 ——
   讓使用者送出後才看到「主旨最多 60 個字」是最沒有必要的一種失敗。 */
const SUBJECT_MAX = 60
const BODY_MAX = 1200

function fillSubject() {
  const s = `訂單問題：${props.cardName}`
  subject.value = s.length > SUBJECT_MAX ? s.slice(0, SUBJECT_MAX) : s
}

/* 送出前擋一層，理由當場講出來。灰按鈕不說話的話，使用者只會一直重按 */
const missing = computed(() => {
  if (!subject.value.trim()) return '還差：主旨。'
  if (!body.value.trim()) return '還差：說明你遇到的問題。'
  return ''
})

let trigger: HTMLElement | null = null
function openSheet(e: MouseEvent) {
  trigger = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
  err.value = ''
  /* 每次開都重填主旨、清空說明：上一次沒送出的內容留著，
     下一次開的可能是另一筆訂單的表單，而使用者不會發現自己在改舊的字 */
  fillSubject()
  body.value = ''
  open.value = true
  void nextTick(() => document.getElementById(sheetId.value)?.focus())
}

function closeSheet() {
  if (busy.value) return
  open.value = false
  /* 焦點回到剛才按的那顆鈕。訂單卡還在原地，使用者的位置沒變，焦點也不該變 */
  if (trigger?.isConnected) {
    const t = trigger
    void nextTick(() => t.focus())
  }
  trigger = null
}

/* Esc 只在面板開著時才掛。一頁上有幾十筆訂單就有幾十個這種元件，
   每個都長駐一個 window 監聽器是白付的成本。 */
function onEsc(e: KeyboardEvent) { if (e.key === 'Escape') closeSheet() }
watch(open, v => {
  if (v) window.addEventListener('keydown', onEsc)
  else window.removeEventListener('keydown', onEsc)
})

/* id 要能在同一頁上唯一 —— 每一筆訂單都有一個這種面板 */
const sheetId = computed(() => `issue-${props.src}-${props.refId}`)

/** 客服查得到這筆交易的那幾行。放內文最後面，跟使用者自己寫的字用一條線分開 */
function refBlock() {
  return [
    '',
    '——（系統附上，方便客服查詢）',
    `${srcLabel.value}編號：${props.refId}`,
    `卡片：${props.cardName}`,
    `我的身分：${sideLabel.value}`,
    `目前狀態：${props.statusText}`
  ].join('\n')
}

async function submit() {
  if (missing.value || busy.value) return
  busy.value = true
  err.value = ''
  try {
    /* kind 用 card-issue：這是「這筆交易的東西有問題」，不是帳號問題也不是接管。
       prizeId 刻意不帶，理由見檔頭。 */
    const t = await tickets.create({
      kind: 'card-issue',
      subject: subject.value.trim().slice(0, SUBJECT_MAX),
      body: body.value.trim().slice(0, BODY_MAX) + refBlock()
    })
    sentId.value = t.id
    open.value = false
  } catch (e) {
    /* 後端的 message 是寫給人看的，直接顯示，不要換成一句「送出失敗」——
       被擋下來的理由（主旨太長、附件不是你的）只有它講得出來 */
    err.value = e instanceof ApiError ? e.message : e instanceof Error ? e.message : '送出失敗，請稍後再試'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="oi">
    <button
      type="button" class="oiBtn"
      :aria-label="`針對${srcLabel} ${cardName} 提出問題`"
      :data-testid="`issue-${refId}`"
      @click="openSheet"
    >
      <svg class="oiIco" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path d="M6.2 6.2a1.85 1.85 0 1 1 2.5 1.75c-.45.17-.7.5-.7.95v.3"
              fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <circle cx="8" cy="11.6" r=".85" fill="currentColor" />
      </svg>
      提出問題
    </button>

    <!-- 回執。不自動消失：使用者要能回頭確認「我確實問出去了，單號在這裡」 -->
    <p v-if="sentId" class="oiOk" role="status">
      問題已經送出，客服會在工單裡回你。
      <RouterLink class="oiLink" :to="{ name: 'support-ticket', params: { id: sentId } }">
        查看這張工單
      </RouterLink>
    </p>

    <!--
      面板 Teleport 到 body：換頁轉場會在 .page 上加 transform，而祖先只要有
      transform，position: fixed 的定位基準就變成那個祖先而不是視窗
      （docs/HANDOFF.md 2.2）—— 面板會被推出畫面外並被裁掉。
      版型沿用站上既有那一套（貼底覆蓋層 ＋ 面板自己捲 ＋ 動作列黏底），
      使用者只要學一次。軟鍵盤讓位（--kb）由頁面層的 useKeyboardInset() 提供：
      一頁上有幾十個這種元件，讓位是全域的一份，不該每個實例各掛一份監聽器。
    -->
    <Teleport to="body">
      <div v-if="open" class="oiWrap" @click.self="closeSheet()">
        <div
          :id="sheetId" class="oiSheet card"
          role="dialog" aria-modal="true" aria-label="提出問題" tabindex="-1"
        >
          <h2 class="oiH">提出問題</h2>

          <!-- 先講這顆不是什麼。按錯的人要在送出之前就發現 -->
          <p class="oiLead">
            這裡只是<b>向客服提問</b>，不會凍結點數、不會啟動退款，也不會改變這筆交易的狀態。
            要退款請改用訂單上的「我要申訴」—— 那條會凍結點數並要求完整未剪輯的開箱影片。
          </p>

          <p class="oiRef">
            <span class="oiRefK">{{ srcLabel }}</span>
            <span class="oiRefV mono">{{ refId }}</span>
            <span class="oiRefC">{{ cardName }}・我是{{ sideLabel }}・{{ statusText }}</span>
          </p>

          <label>
            主旨
            <input v-model="subject" type="text" :maxlength="SUBJECT_MAX" placeholder="例如：訂單問題：噴火龍 ex" />
          </label>
          <label>
            說明
            <textarea
              v-model="body" rows="5" :maxlength="BODY_MAX"
              placeholder="例如：賣家說三天前寄出了，但我到現在還沒收到，單號查不到紀錄。"
            ></textarea>
          </label>
          <p class="oiHint">
            上面那幾行（編號、卡片、你的身分、目前狀態）會自動附在內文最後面，
            你不用再打一次。
          </p>

          <div class="oiFoot">
            <p v-if="err" class="oiErr" role="alert">{{ err }}</p>
            <!-- 灰按鈕的理由就在動作列正上方。--warn-ink 不用 --danger：
                 使用者沒做錯事，只是還沒填完 -->
            <p v-if="missing && !busy" :id="`${sheetId}-why`" class="oiWhy" role="status">{{ missing }}</p>
            <div class="oiActs">
              <button
                type="button" class="btn primary sm"
                :disabled="!!missing || busy"
                :aria-describedby="missing && !busy ? `${sheetId}-why` : undefined"
                :data-testid="`issue-submit-${refId}`"
                @click="submit"
              >{{ busy ? '送出中…' : '送出問題' }}</button>
              <button type="button" class="btn sm" :disabled="busy" @click="closeSheet()">取消</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 一律留一段上緣間距：它永遠接在動作列或寄件依據後面 */
.oi { min-width: 0; margin-top: 10px; }

/* 刻意低權重：它旁邊常常就是「我已寄出」「我已收到」那種會移動錢的實心鈕，
   兩者長得一樣的話按錯的代價不對稱。虛線外框＝「這顆不會發生什麼事」。
   但尺寸不讓 —— 44px 是觸控下限，不是視覺權重的一部分。 */
.oiBtn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 44px; padding: 10px 16px;
  border: 1px dashed var(--line); border-radius: var(--pill);
  background: transparent; color: var(--muted);
  font: inherit; font-size: 13px; font-weight: 600;
  cursor: pointer;
  transition: border-color .16s, color .16s;
}
.oiBtn:active { transform: scale(.98); }
.oiBtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (hover: hover) { .oiBtn:hover { border-color: var(--accent); color: var(--accent); } }
.oiIco { width: 15px; height: 15px; flex: none; }

.oiOk {
  margin: 8px 0 0; padding: 9px 11px;
  border-radius: var(--radius);
  background: var(--ok-wash); color: var(--ok-ink);
  font-size: 12px; line-height: 1.75; min-width: 0; overflow-wrap: anywhere;
}
.oiLink {
  display: inline-block; margin-left: 4px;
  color: var(--ok-ink); font-weight: 600; text-decoration: underline;
}
.oiLink:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* ---- 面板：跟訂單頁那三張、卡冊出貨面板同一套 ---- */
.oiWrap {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: flex-end; justify-content: center;
  background: var(--scrim);
  /* 下緣讓給軟鍵盤（--kb 由頁面層的 useKeyboardInset() 寫進根節點，預設 0）。
     這張面板一定會叫出鍵盤（兩個欄位都是文字），不讓位的話動作列會躲在鍵盤下。 */
  bottom: var(--kb, 0px);
}
.oiSheet {
  width: 100%; max-width: min(520px, 100vw);
  overflow-x: hidden;
  /* 88% 而不是 88dvh：.oiWrap 的高度已經扣掉鍵盤了，
     dvh 量的是整個視窗，鍵盤彈出時算出來的面板會比放得下的還高 */
  max-height: min(88%, 720px); overflow-y: auto; overscroll-behavior: contain;
  border-radius: 18px 18px 0 0;
  padding: 18px 16px 0;
  display: grid; gap: 10px; align-content: start; min-width: 0;
}
/* 焦點是程式送進來的（tabindex="-1"），不該畫出一圈使用者沒有自己走到的外框 */
.oiSheet:focus-visible { outline: none; }
.oiH { font-size: 17px; margin: 0; }
.oiLead { font-size: 12.5px; line-height: 1.8; color: var(--muted); margin: 0; min-width: 0; }
.oiLead b { color: var(--ink); font-weight: 600; }

.oiRef {
  margin: 0; padding: 9px 11px;
  background: var(--surface-2); border-radius: var(--radius);
  display: grid; gap: 3px; min-width: 0;
}
.oiRefK { font-size: 10.5px; color: var(--muted); }
.oiRefV { font-size: 12.5px; color: var(--ink); overflow-wrap: anywhere; }
.oiRefC { font-size: 11px; line-height: 1.6; color: var(--muted); overflow-wrap: anywhere; }

.oiSheet label { display: block; font-size: 12.5px; color: var(--muted); margin: 0; min-width: 0; }
.oiSheet input, .oiSheet textarea {
  display: block; width: 100%; margin-top: 5px; min-width: 0;
  background: var(--field, var(--surface-2)); border: 1px solid var(--line);
  border-radius: var(--radius); color: var(--ink);
  /* 16px 不是排版偏好，是 iOS 的門檻：欄位字級小於 16 就會在聚焦時
     自動放大整頁，而且不會自己縮回去（touch.css 第 4 節） */
  padding: 10px 12px; font: inherit; font-size: 16px; min-height: 44px;
}
.oiSheet textarea { resize: vertical; line-height: 1.7; }
.oiHint { font-size: 11.5px; line-height: 1.65; color: var(--muted); margin: 0; }

/* 動作列黏在面板下緣：內容多長、捲到哪裡、鍵盤有沒有升起來都不影響送出鍵的位置 */
.oiFoot {
  position: sticky; bottom: 0; z-index: 1;
  /* 負的左右外距讓它撐滿面板寬度，那條分隔線才切得斷 */
  margin: 2px -16px 0;
  padding: 10px 16px calc(12px + var(--safe-b, 0px));
  border-top: 1px solid var(--line);
  background: var(--surface);
  display: grid; gap: 8px; min-width: 0;
}
.oiErr { margin: 0; min-width: 0; font-size: 12.5px; line-height: 1.55; color: var(--danger-ink); overflow-wrap: anywhere; }
.oiWhy { margin: 0; min-width: 0; font-size: 12.5px; line-height: 1.55; color: var(--warn-ink); overflow-wrap: anywhere; }
.oiActs { display: flex; gap: 8px; flex-wrap: nowrap; }
.oiActs .btn { flex: 1; min-width: 0; min-height: 44px; padding: 8px 16px; font-size: 13px; }
@media (max-width: 720px) { .oiActs { flex-direction: column; } }
</style>
