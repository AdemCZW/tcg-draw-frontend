<script setup lang="ts">
/**
 * 上傳失敗時，訊息底下的那一小塊「下一步 ＋ 診斷碼」。
 *
 * 為什麼獨立成元件：上傳現在有三個入口（卡片正面照、出貨照、客服工單附件），
 * 三個地方本來都只印一句 e.error 就結束。而「這是不是我能自己解決的」
 * 跟「不能的話去哪裡回報」這兩件事，在三個地方是一模一樣的答案 ——
 * 抄三份的下場是有人改文案時只改到一份。
 *
 * 診斷碼是給我們看的，不是給使用者懂的。它的價值只在使用者願意把它貼進工單，
 * 所以一定要有一顆按得到的複製鍵（44px），而且複製失敗要明講 ——
 * 非 HTTPS 與舊瀏覽器的 navigator.clipboard 會直接爆掉，安靜失敗的話
 * 使用者會貼出上一次剪貼簿裡的東西，我們拿到的是一段完全無關的字。
 *
 * **裡面沒有任何機密**：診斷碼在 src/lib/uploads.ts 的 diagOf() 組出來，
 * 刻意不含簽章網址、token、fileId、檔名與檔案內容。
 */
import { onUnmounted, ref } from 'vue'

const props = defineProps<{
  /** 下一步該做什麼。空字串就不畫這一段 */
  hint: string
  /** 一行診斷碼。空字串代表這種失敗不需要回報（例如格式不對） */
  diag: string
}>()

const state = ref<'idle' | 'ok' | 'fail'>('idle')
let t: number | undefined

async function copy() {
  try {
    // clipboard 在非安全來源上是 undefined，讀 .writeText 會同步丟 TypeError
    await navigator.clipboard.writeText(props.diag)
    state.value = 'ok'
  } catch {
    state.value = 'fail'
  }
  clearTimeout(t)
  t = window.setTimeout(() => { state.value = 'idle' }, 2400)
}
onUnmounted(() => clearTimeout(t))
</script>

<template>
  <div class="ufWrap">
    <p v-if="hint" class="ufHint">{{ hint }}</p>

    <div v-if="diag" class="ufDiag">
      <code class="ufCode mono">{{ diag }}</code>
      <button type="button" class="ufBtn" :class="{ done: state === 'ok' }" @click="copy()">
        {{ state === 'ok' ? '已複製' : '複製診斷碼' }}
      </button>
      <span class="sr-only" role="status">{{ state === 'ok' ? '診斷碼已複製' : '' }}</span>
      <p v-if="state === 'fail'" class="ufFail" role="status">
        這個瀏覽器不允許自動複製，請長按上面那行字手動選取。
      </p>
      <p class="ufWhere">
        這行字只描述失敗本身（階段、檔案大小、格式、時間），不含你的檔案內容與帳號資訊。
        <RouterLink class="ufLink" :to="{ name: 'support-new' }">開一張客服工單</RouterLink>
        並貼上它，我們才查得到這一次到底卡在哪。
      </p>
    </div>
  </div>
</template>

<style scoped>
.ufWrap { display: grid; gap: 6px; }
.ufHint { margin: 0; font-size: 11.5px; line-height: 1.7; color: var(--muted); }

.ufDiag {
  display: grid; gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--line); border-radius: var(--radius);
  /* wash 而不是純色：深淺兩套主題都有這一組，寫死顏色會有一邊看不見 */
  background: var(--danger-wash);
}
.ufCode {
  display: block; min-width: 0;
  font-size: 11px; line-height: 1.6; color: var(--ink);
  /* 診斷碼是一長串沒有空格的字，不 anywhere 的話手機上會整條溢出去 */
  overflow-wrap: anywhere;
  user-select: all;
}
.ufBtn {
  justify-self: start;
  min-height: 44px; min-width: 44px;
  display: inline-flex; align-items: center; padding: 0 14px;
  border: 1px solid var(--line); border-radius: var(--pill);
  background: var(--surface-2); color: var(--ink);
  font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.ufBtn:active { transform: scale(.96); }
.ufBtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ufBtn.done { background: var(--ok-wash); color: var(--ok-ink); border-color: transparent; }
.ufFail { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--warn-ink); }
.ufWhere { margin: 0; font-size: 11px; line-height: 1.7; color: var(--muted); }
.ufLink { color: var(--accent); }
</style>
