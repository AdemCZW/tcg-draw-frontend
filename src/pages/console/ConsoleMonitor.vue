<script setup lang="ts">
/**
 * 系統檢測。
 *
 * ── 為什麼要有這一頁 ──────────────────────────────────────────────
 * server/src/monitor.ts 每輪把破掉的不變式變成通知發給管理員，而那則通知
 * 原本連到總覽 —— 總覽上一個字都沒有提到檢測。點進去看不到東西的警報
 * 等於沒發：管理員只會學會忽略它，而會被忽略的正是 negative-balance
 * 那種 critical。這一頁就是那則通知的落點。
 *
 * ── 這一頁刻意回答的五件事 ────────────────────────────────────────
 * 1. 有沒有問題（有 finding 就照嚴重度列出來）
 * 2. 每一筆是什麼 —— message 全文照登，**不裁切**。那些字是 monitor.ts
 *    裡一句一句寫出來的「這代表什麼、會造成什麼、先查哪裡」，
 *    裁掉的永遠是後半段，也就是唯一能拿來動手的那一半。
 * 3. 檢查自己有沒有掛掉 —— 獨立一區、排在最前面而且比 finding 更醒目。
 *    檢測失明期間別的問題不會被發現，這比任何單一 finding 更急。
 * 4. 全綠時證明「有檢查過」而不是「沒檢查」—— 所以 checked 那一串要列出來。
 *    一片空白的畫面沒辦法分辨「系統健康」跟「排程根本沒跑」。
 * 5. 這份報告是什麼時候跑的（at）。少了它，「現在沒問題」跟
 *    「我看到的是半天前的畫面」長得一模一樣。
 *
 * ── 重新檢測為什麼只打唯讀那一支 ──────────────────────────────────
 * 後端還有 POST /v1/monitor/run，跑完會照常發通知。管理員在這頁按一次
 * 「看看現在怎樣」不該讓每一位管理員的鈴鐺再響一輪 —— 那正是 monitor.ts
 * 檔頭說的警報疲勞。所以這裡只有唯讀的一支，前端連函式都沒包那一支。
 */
import { computed, onMounted, ref } from 'vue'
import CopyLine from '@/components/CopyLine.vue'
import { monitorApi, type MonitorFinding, type MonitorReport, type MonitorSeverity } from '@/lib/api'
import { useAsync, fmtTime } from './shared'
import './console.css'

const { loading, err, run } = useAsync()
const report = ref<MonitorReport | null>(null)

async function load() {
  const r = await run(() => monitorApi.report())
  if (r) report.value = r
}
onMounted(load)

/* 中文對照跟後端的 SEV_TEXT 一致 —— 通知標題寫「系統檢測（高）」，
   管理員點進來要看到同一個字，不然對不起來是哪一則。 */
const SEV_LABEL: Record<MonitorSeverity, string> = {
  critical: '嚴重', high: '高', medium: '中', low: '低'
}
/* 顏色只是輔助。每一顆徽章都同時帶文字（「嚴重度：高」），色盲、
   單色列印、以及只掃過一眼的人都要分得出來 —— 不能只靠顏色。 */
const SEV_CLASS: Record<MonitorSeverity, string> = {
  critical: 'crit', high: 'high', medium: 'mid', low: 'low'
}
const SEV_ORDER: Record<MonitorSeverity, number> = {
  critical: 0, high: 1, medium: 2, low: 3
}

/* 嚴重的排前面；同嚴重度時筆數多的先看。原始陣列不動（後端的順序是
   檢查的註冊順序，跟「先看哪個」無關）。 */
const findings = computed<MonitorFinding[]>(() =>
  [...(report.value?.findings ?? [])].sort(
    (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.count - a.count
  )
)
const errors = computed(() => report.value?.errors ?? [])
const checked = computed(() => report.value?.checked ?? [])
/* 「全綠」的定義要嚴格：檢查掛掉不算綠。有 error 卻顯示一片綠，
   正是這一頁要防的那種假安心。 */
const allGreen = computed(() =>
  !!report.value && !findings.value.length && !errors.value.length)
</script>

<template>
  <div>
    <div class="c-head">
      <h2>系統檢測</h2>
      <span class="c-sub">唯讀跑一輪不變式檢查，不會發通知</span>
      <div class="c-right">
        <button class="c-btn" type="button" :disabled="loading" @click="load">
          {{ loading ? '檢測中…' : '重新檢測' }}
        </button>
      </div>
    </div>

    <p v-if="err" class="c-err">{{ err }}</p>
    <p v-if="loading && !report" class="c-empty">檢測中…</p>

    <template v-else-if="report">
      <p class="ranAt">
        這份報告跑於 {{ fmtTime(report.at) }}
        <span v-if="loading">（重新檢測中…）</span>
      </p>

      <!-- 檢查自己掛掉排在最前面：失明期間別的問題根本不會被發現，
           所以它比任何一筆 finding 都急，樣式也刻意比 finding 更重。 -->
      <section v-if="errors.length" class="blind">
        <h3>檢測失明：{{ errors.length }} 支檢查執行失敗</h3>
        <p class="blindWhy">
          這幾支檢查這一輪沒有跑完，它們負責的問題現在<strong>沒有人在看</strong>。
          先修這個，再看下面的發現 —— 下面那份名單本來就是不完整的。
        </p>
        <div class="blindItem" v-for="e in errors" :key="e.check">
          <span class="c-t">{{ e.check }}</span>
          <p class="msg">{{ e.error }}</p>
        </div>
      </section>

      <p v-if="allGreen" class="c-ok">
        沒有發現問題。以下 {{ checked.length }} 支檢查全部跑完且全綠。
      </p>

      <section v-if="findings.length">
        <h3 class="sect">發現 {{ findings.length }} 項問題</h3>
        <div class="c-rows">
          <article v-for="f in findings" :key="f.check" class="c-row" :class="'sev-' + SEV_CLASS[f.severity]">
            <div class="line">
              <span class="c-pill" :class="'sev-' + SEV_CLASS[f.severity]">
                嚴重度：{{ SEV_LABEL[f.severity] }}
              </span>
              <span class="c-t">{{ f.check }}</span>
              <span class="c-m grow">{{ f.count }} 筆</span>
            </div>
            <!-- 全文。monitor.ts 那些說明就是寫給這一格看的，不做 -webkit-line-clamp -->
            <p class="msg">{{ f.message }}</p>
            <div v-if="f.sample.length" class="samples">
              <p class="c-m">樣本編號（最多 20 筆，查起來的起點）</p>
              <CopyLine
                v-for="(s, i) in f.sample" :key="s + i"
                :label="`樣本 ${i + 1}`" :value="s" mono
              />
            </div>
          </article>
        </div>
      </section>

      <!-- checked 一律列出來，包含全綠時。MonitorReport 特地帶這一欄，
           就是為了讓「沒有問題」跟「沒有檢查」在畫面上分得出來。 -->
      <section class="ran">
        <h3 class="sect">這一輪跑過的檢查（{{ checked.length }}）</h3>
        <p v-if="!checked.length" class="c-warn">
          這一輪一支檢查都沒有跑完 —— 看上面的失敗原因。
        </p>
        <ul v-else class="chips">
          <li v-for="c in checked" :key="c">{{ c }}</li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.ranAt { margin: 0 0 14px; font-size: 12.5px; color: var(--muted); }
.sect { font-size: 13px; color: var(--muted); margin: 20px 0 10px; font-weight: 600; }

.line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.line .grow { margin-left: auto; }

/* 說明全文。id 與英文代號沒有空白可斷，窄螢幕上不加 anywhere 會橫向溢出 */
.msg {
  margin: 8px 0 0; font-size: 13.5px; line-height: 1.75;
  color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere;
}

.samples { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line-soft); }
.samples .c-m { margin: 0 0 2px; font-size: 12px; }

/* 嚴重度的色只加在左邊的粗邊，不改底色 —— 一整片染色的卡片會讓
   裡面的說明文字（這一頁的重點）更難讀。文字標籤在徽章上，不靠色。 */
.c-row.sev-crit { border-left: 4px solid var(--danger); }
.c-row.sev-high { border-left: 4px solid var(--warn); }
.c-row.sev-mid  { border-left: 4px solid var(--info-ink); }
.c-row.sev-low  { border-left: 4px solid var(--line); }

.c-pill.sev-crit { background: var(--danger-wash); color: var(--danger-ink); }
.c-pill.sev-high { background: var(--warn-wash); color: var(--warn-ink); }
.c-pill.sev-mid  { background: var(--info-wash); color: var(--info-ink); }
.c-pill.sev-low  { background: var(--surface-3); color: var(--muted); }

/* 檢測失明區。整塊染紅是這一頁唯一用滿版底色的地方 —— 它必須比
   下面任何一筆 finding 都先被看到。 */
.blind {
  margin-bottom: 16px; padding: 14px;
  border: 1px solid var(--danger); border-radius: 14px;
  background: var(--danger-wash);
}
.blind h3 { margin: 0 0 6px; font-size: 15px; color: var(--danger-ink); }
.blindWhy { margin: 0 0 10px; font-size: 13px; line-height: 1.7; color: var(--danger-ink); }
.blindItem {
  padding: 10px 12px; margin-top: 8px;
  border-radius: 10px; background: var(--surface);
  overflow-wrap: anywhere;
}
.blindItem .msg { margin-top: 4px; font-size: 12.5px; color: var(--muted); }

.chips { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; }
.chips li {
  padding: 3px 9px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--line-soft);
  font-size: 12px; color: var(--muted); overflow-wrap: anywhere;
}
</style>
