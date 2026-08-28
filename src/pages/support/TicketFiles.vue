<script setup lang="ts">
/**
 * 工單附件。
 *
 * 跟出貨照的差別只有兩個，其餘（presign、直傳、進度、重試、object URL 回收）
 * 一律沿用 src/lib/uploads.ts 的 useUploads —— **沒有重寫任何上傳邏輯**：
 *
 *   1. 附件是**選填**的。出貨照沒有就等於沒寄過，所以那支會擋送出；
 *      工單多數時候一句話就講完了，硬要人附檔只會逼出一張沒有意義的截圖。
 *      所以這裡對外只送 fileIds 與 pending（還在傳），不送 ready。
 *   2. 收 PDF。PDF 瀏覽器畫不出縮圖，所以畫不出來的檔改畫一個檔案圖示 +
 *      副檔名，而不是留一張破圖 —— 使用者要認得出「我加的那份 PDF 在不在」。
 *   3. 影像會先進裁切框（ImageCropper）再上傳，PDF 直接跳過那一段 ——
 *      PDF 根本畫不進 canvas，硬要裁只會得到一張白圖。這個分流在
 *      lib/image-edit.ts 的 planFor() 裡，這邊只負責把框掛出來。
 *
 * 送出鍵的判準因此是 `pending`（還在傳就先別送），不是「有沒有檔案」。
 * 傳到一半送出去的話，fileIds 是不完整的一組，附件會憑空少一個。
 */
import { computed, ref, watch } from 'vue'
import { MOCK } from '@/lib/config'
import { acceptOf, maxMbOf, useUploads, type UploadEntry } from '@/lib/uploads'
import { fmtBytes } from '@/lib/image-edit'
import ImageCropper from '@/components/ImageCropper.vue'
/* 'ticket-doc' 的規則已收進 src/lib/uploads.ts（migration 026 放行的用途），
   原本的執行期補登（./ticket-uploads.ts）已移除。
   上限 5 個附件跟後端 routes/tickets.ts 的驗證一致。 */
const TICKET_DOC = 'ticket-doc' as const
const TICKET_FILE_MAX = 5

const props = withDefaults(defineProps<{
  max?: number
  /** 這一組附件是拿來做什麼的。開單與回覆的說明不一樣，由呼叫端給 */
  hint?: string
}>(), { max: TICKET_FILE_MAX, hint: '' })

const emit = defineEmits<{
  'update:fileIds': [string[]]
  /** 還有檔案在傳。true 的時候呼叫端要壓住送出鍵 */
  'update:pending': [boolean]
}>()

/* 解構是為了讓模板自動解 ref（巢狀在物件裡的 ref 模板不會自動解包） */
const {
  entries, add, remove, retry, fileIds, pending, failed, full, count,
  editTarget, applyEdit, cancelEdit
} = useUploads(TICKET_DOC, { max: props.max })

const accept = acceptOf(TICKET_DOC)
const maxMb = maxMbOf(TICKET_DOC)

/** 連加都沒加進去的（超過數量上限）要當場講，不然使用者以為當掉了 */
const dropNote = ref('')

function pick(ev: Event) {
  const el = ev.target as HTMLInputElement
  dropNote.value = add(el.files)
  /* input 一定要清空。不清的話「選了 A、移除 A、再選一次 A」不會觸發 change
     （value 沒變），使用者會覺得按鈕壞了。 */
  el.value = ''
}

const doneCount = computed(() => entries.value.filter(e => e.status === 'done').length)

/** 副檔名。PDF 畫不出縮圖時，這是唯一能認出「哪一份」的線索之一 */
const extOf = (e: UploadEntry) => {
  const m = /\.([a-z0-9]{1,5})$/i.exec(e.name)
  return m ? m[1]!.toUpperCase() : '檔案'
}

/** 壓縮省了多少。只算真的走過壓縮的那幾個 —— PDF 與本來就夠小的截圖沒省，不要謊報 */
const saved = computed(() => {
  const done = entries.value.filter(e => e.status === 'done' && e.edited)
  if (!done.length) return ''
  const before = done.reduce((n, e) => n + e.originalBytes, 0)
  const after = done.reduce((n, e) => n + e.bytes, 0)
  if (after >= before) return ''
  return `，壓縮後 ${fmtBytes(before)} → ${fmtBytes(after)}`
})

/** 一句話講現在卡在哪。附件是選填的，所以「沒有附件」不是問題，不要說成問題 */
const statusLine = computed(() => {
  // 停在裁切框的那一張要單獨講：它不是「在傳」，是在等使用者按確認
  if (editTarget.value) return '請先調整照片範圍，確認後才會開始上傳'
  if (pending.value) return `處理中… 已完成 ${doneCount.value} / ${count.value}，全部完成才能送出`
  if (failed.value.length) return `有 ${failed.value.length} 個檔案沒有成功，請重試或移除`
  if (!count.value) return `附件可以不加。最多 ${props.max} 個，單檔 ${maxMb}MB。照片會在上傳前讓你先裁切`
  return `${doneCount.value} 個附件已就緒${saved.value}`
})
const statusTone = computed(() =>
  failed.value.length ? 'bad' : pending.value ? 'wait' : count.value ? 'good' : '')

/** 呼叫端要能在送出後把這一組清掉（回覆送出之後附件不該還留在框裡） */
defineExpose({ clearFiles: () => { for (const e of [...entries.value]) remove(e.uid) } })

/* deep 是必要的：進度與完成是改在陣列元素上，不 deep 的話「最後一個傳完」
   那一瞬間外面不會知道，送出鍵就永遠亮不起來。 */
watch(
  [fileIds, pending],
  ([ids, busy]) => { emit('update:fileIds', ids as string[]); emit('update:pending', busy as boolean) },
  { deep: true, immediate: true }
)
</script>

<template>
  <div class="tfWrap">
    <div class="tfHead">
      <span class="tfTitle">附件<span class="tfOpt">（選填）</span></span>
      <span class="tfCount mono">{{ count }} / {{ props.max }}</span>
    </div>
    <p v-if="props.hint" class="tfWhy">{{ props.hint }}</p>

    <div class="tfGrid">
      <div v-for="e in entries" :key="e.uid" class="tfTile" :class="e.status">
        <!-- alt 留空：檔名寫在下面與移除鍵的 aria-label 裡，重複唸一次只是噪音 -->
        <img v-if="!e.broken" class="tfImg" :src="e.previewUrl" alt="" @error="e.broken = true" />
        <!-- 畫不出來的檔（PDF）：給一個檔案圖示與副檔名，不要留破圖 -->
        <span v-else class="tfDoc" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none"
               stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z" />
            <path d="M14 3v4.5H18" />
          </svg>
          <b class="tfExt mono">{{ extOf(e) }}</b>
        </span>

        <!-- 還在判斷要不要裁 / 正在排隊等裁切：不講的話這張磚會靜靜地停在那裡，
             看起來跟當掉一模一樣 -->
        <div v-if="e.status === 'preparing' || e.status === 'editing'" class="tfVeil">
          <span class="tfWait">{{ e.status === 'editing' ? '待裁切' : '讀取中' }}</span>
        </div>
        <div v-else-if="e.status === 'uploading'" class="tfVeil">
          <span class="mono tfPct">{{ e.progress }}%</span>
        </div>
        <div v-if="e.status === 'uploading'" class="tfBar" aria-hidden="true">
          <i :style="{ width: e.progress + '%' }"></i>
        </div>

        <!-- 完成：一個勾。手機介面不放 emoji，圖示一律 inline SVG -->
        <span v-if="e.status === 'done'" class="tfOk" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none"
               stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 8.6 6.3 12 13 4.6" />
          </svg>
        </span>

        <div v-if="e.status === 'error'" class="tfVeil bad">
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none"
               stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M10 3.2 18 17H2z" stroke-linejoin="round" />
            <path d="M10 8.4v3.4" /><path d="M10 14.2h.01" />
          </svg>
        </div>

        <button type="button" class="tfX" :aria-label="`移除 ${e.name}`" @click="remove(e.uid)">
          <span class="tfXDot">
            <svg viewBox="0 0 12 12" width="10" height="10" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M2.5 2.5 9.5 9.5M9.5 2.5l-7 7" />
            </svg>
          </span>
        </button>
      </div>

      <!-- 滿了就不留按鈕：留著只會讓人按了沒反應 -->
      <label v-if="!full" class="tfAdd">
        <input type="file" class="tfInput" :accept="accept" multiple data-testid="ticket-file-input" @change="pick" />
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"
             stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span class="tfAddT">加附件</span>
      </label>
    </div>

    <p v-if="dropNote" class="tfDrop" role="alert">{{ dropNote }}</p>

    <!-- 失敗的細節：哪一個、為什麼、能不能重試。只說「上傳失敗」等於沒說 -->
    <ul v-if="failed.length" class="tfErrs">
      <li v-for="e in failed" :key="e.uid">
        <span class="tfErrN">{{ e.name }}</span>
        <span class="tfErrM">{{ e.error }}</span>
        <span class="tfErrA">
          <button v-if="e.retriable" type="button" class="tfBtn" @click="retry(e.uid)">重試</button>
          <button type="button" class="tfBtn ghost" @click="remove(e.uid)">移除</button>
        </span>
      </li>
    </ul>

    <p class="tfStat" :class="statusTone" role="status" aria-live="polite" data-testid="ticket-file-status">
      {{ statusLine }}
    </p>

    <!-- 裁切框。一次只處理一張（editTarget 是佇列的第一個），
         :key 讓它換張時整個重建 —— 不重建的話 canvas 還留著上一張的狀態 -->
    <ImageCropper
      v-if="editTarget" :key="editTarget.uid"
      :file="editTarget.file" :policy="editTarget.policy" :max-bytes="editTarget.maxBytes"
      :index="editTarget.index" :total="editTarget.total"
      @done="r => applyEdit(editTarget!.uid, r)"
      @cancel="cancelEdit(editTarget!.uid)"
    />

    <p v-if="MOCK" class="tfMock">
      MOCK 模式：沒有後端，這裡只把上傳流程與各種狀態演一遍，檔案不會真的送出去。
    </p>
  </div>
</template>

<style scoped>
.tfWrap { margin: 4px 0 2px; min-width: 0; }

.tfHead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.tfTitle { font-size: 12.5px; color: var(--muted); min-width: 0; }
.tfOpt { color: var(--faint); }
.tfCount { font-size: 12.5px; color: var(--muted); flex: none; }

.tfWhy { font-size: 11.5px; line-height: 1.7; color: var(--muted); margin: 4px 0 9px; }

/* 固定欄數 + minmax(0, 1fr)：內容再寬也不會把格線撐出容器 */
.tfGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
@media (min-width: 560px) { .tfGrid { grid-template-columns: repeat(5, minmax(0, 1fr)); max-width: 520px; } }

.tfTile {
  position: relative; min-width: 0;
  aspect-ratio: 1 / 1; border-radius: var(--radius);
  overflow: hidden; background: var(--surface-3);
  border: 1px solid var(--line);
}
.tfTile.error { border-color: var(--danger); }
.tfTile.done { border-color: var(--ok); }
.tfImg { display: block; width: 100%; height: 100%; object-fit: cover; }
.tfTile.uploading .tfImg, .tfTile.error .tfImg { opacity: .45; }

.tfDoc {
  position: absolute; inset: 0; min-width: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  color: var(--muted);
}
.tfExt { font-size: 10.5px; letter-spacing: .04em; }

.tfVeil {
  position: absolute; inset: 0; display: grid; place-items: center;
  background: rgba(0, 0, 0, .42); color: var(--ink);
}
.tfVeil.bad { background: var(--danger-wash); color: var(--danger); opacity: .92; }
.tfPct { font-size: 13px; font-weight: 700; }
.tfWait { font-size: 11.5px; font-weight: 700; color: var(--ink); text-align: center; padding: 0 4px; }

.tfBar { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: var(--surface-2); }
.tfBar i { display: block; height: 100%; background: var(--accent); transition: width .18s linear; }

.tfOk {
  position: absolute; left: 6px; bottom: 6px;
  width: 20px; height: 20px; border-radius: var(--pill);
  display: grid; place-items: center;
  background: var(--ok); color: var(--bg);
}

/* 觸控目標 44×44，視覺只有 26px 的圓 —— 縮圖本身很小，
   畫一個 44px 的圓會整個蓋掉，但點擊區域不能因此縮水 */
.tfX {
  position: absolute; top: 0; right: 0;
  width: 44px; height: 44px; min-width: 44px; min-height: 44px;
  display: grid; place-items: center;
  padding: 0; border: 0; background: none; cursor: pointer; color: var(--ink);
}
.tfXDot {
  width: 26px; height: 26px; border-radius: var(--pill);
  display: grid; place-items: center;
  background: rgba(0, 0, 0, .62); box-shadow: 0 1px 4px rgba(0, 0, 0, .5);
}

.tfAdd {
  /* overflow: hidden 是為了那個蓋在上面的 <input type="file">：
     檔案輸入框有瀏覽器給的固定內建寬度（實測 222px），比這一格還寬，
     不裁掉的話這一格量起來就是「內容超出容器」 */
  position: relative; min-width: 0; overflow: hidden;
  aspect-ratio: 1 / 1; min-height: 44px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
  border: 1px dashed var(--line); border-radius: var(--radius);
  background: var(--surface-2); color: var(--muted);
  cursor: pointer; text-align: center; padding: 6px;
}
.tfAddT { font-size: 12px; line-height: 1.4; }
/* font-size: 0 是為了那顆瀏覽器內建的「選擇檔案」按鈕：它的寬度是照字級算的，
   預設字級下它比整格還寬（實測 222px vs 110px），量起來就是內容溢出容器。
   按鈕本身是透明的、只當點擊區用，字級歸零不影響任何看得見的東西。 */
.tfInput {
  position: absolute; inset: 0; opacity: 0;
  width: 100%; height: 100%; min-width: 0; font-size: 0;
  cursor: pointer;
}

.tfDrop { font-size: 12px; line-height: 1.7; color: var(--warn); margin: 9px 0 0; }

.tfErrs { list-style: none; margin: 9px 0 0; padding: 0; display: grid; gap: 7px; }
.tfErrs li {
  min-width: 0;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px;
  background: var(--danger-wash); border-radius: var(--radius);
  padding: 9px 11px;
}
/* 檔名不截斷 —— 被切掉的檔名對「是哪一個出問題」這個問題毫無幫助 */
.tfErrN { font-size: 12px; font-weight: 700; color: var(--ink); overflow-wrap: anywhere; }
.tfErrM { font-size: 11.5px; line-height: 1.65; color: var(--danger-ink); overflow-wrap: anywhere; }
.tfErrA { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
.tfBtn {
  min-height: 44px; padding: 0 16px;
  border-radius: var(--pill); border: 1px solid var(--line);
  background: var(--surface-2); color: var(--ink);
  font: inherit; font-size: 12.5px; cursor: pointer;
}
.tfBtn.ghost { background: none; color: var(--muted); }

.tfStat { font-size: 12px; line-height: 1.7; color: var(--muted); margin: 9px 0 0; overflow-wrap: anywhere; }
.tfStat.good { color: var(--ok-ink); }
.tfStat.wait { color: var(--warn-ink); }
.tfStat.bad { color: var(--danger-ink); }

.tfMock { font-size: 11px; line-height: 1.7; color: var(--faint); margin: 6px 0 0; }
</style>
