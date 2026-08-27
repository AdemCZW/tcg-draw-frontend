<script setup lang="ts">
/**
 * 出貨照上傳。
 *
 * 為什麼獨立成一個元件：出貨照是**憑證**，不是附件。爭議裁決時看的就是它，
 * 所以「有幾張、傳完了沒、哪一張失敗、為什麼失敗」四件事都必須在畫面上，
 * 不能只有一個 <input type="file">。這些狀態塞回 OrdersPage 會把那一頁
 * 的表單邏輯撐爆，而且之後開箱影片、賣家證件要用同一套。
 *
 * 對外只暴露兩個 v-model：
 *   file-ids  全部上傳完成的檔案 id（不完整時呼叫端不該送出）
 *   ready     有至少一張、而且每一張都成功 —— 送出鍵的唯一判準
 *
 * 「至少一張」在這裡就擋住，是因為後端那條規則到今天為止是假的：
 * 它寫著「出貨照至少一張」，前端卻從來沒有上傳介面，送的是寫死的佔位網址。
 * 介面補上之後後端才打得開 .min(1)，兩邊才是同一條規則。
 */
import { computed, ref, watch } from 'vue'
import { MOCK } from '@/lib/config'
import { acceptOf, maxMbOf, useUploads, type UploadEntry } from '@/lib/uploads'

const props = withDefaults(defineProps<{ max?: number }>(), { max: 5 })
const emit = defineEmits<{
  'update:fileIds': [string[]]
  'update:ready': [boolean]
}>()

/* 解構出來是為了讓模板能自動解 ref —— 巢狀在物件裡的 ref 模板不會自動解包，
   不解構的話整份模板都要寫 uploader.entries.value 這種東西 */
const { entries, add, remove, retry, fileIds, pending, failed, ready, full, count } =
  useUploads('ship-photo', { max: props.max })

const accept = acceptOf('ship-photo')
const maxMb = maxMbOf('ship-photo')

/** 「連加都沒加進去」的情況（超過張數上限）要當場講，不然使用者以為當掉了 */
const dropNote = ref('')

function pick(ev: Event) {
  const el = ev.target as HTMLInputElement
  dropNote.value = add(el.files)
  /* 一定要把 input 清空。不清的話「選了 A、移除 A、再選一次 A」不會觸發 change
     （value 沒變），使用者會覺得按鈕壞了。 */
  el.value = ''
}

const doneCount = computed(() => entries.value.filter(e => e.status === 'done').length)

/** 一句話講現在卡在哪，而不是讓使用者盯著一個按不下去的按鈕猜原因 */
const statusLine = computed(() => {
  if (pending.value) return `上傳中… 已完成 ${doneCount.value} / ${count.value} 張，全部完成才能送出`
  if (failed.value.length) return `有 ${failed.value.length} 張沒有成功，請重試或移除後再送出`
  if (!count.value) return `至少要一張出貨照，最多 ${props.max} 張`
  return `${doneCount.value} 張出貨照已就緒，可以送出`
})
const statusTone = computed(() =>
  failed.value.length ? 'bad' : pending.value ? 'wait' : count.value ? 'good' : ''
)

const shortName = (e: UploadEntry) => e.name

/* 把狀態往外送。deep 是必要的：進度與完成是改在陣列元素上，
   不 deep 的話「最後一張傳完」那一瞬間外面不會知道，送出鍵就永遠亮不起來。 */
watch(
  [fileIds, ready],
  ([ids, ok]) => { emit('update:fileIds', ids); emit('update:ready', ok) },
  { deep: true, immediate: true }
)
</script>

<template>
  <div class="spWrap">
    <div class="spHead">
      <span class="spTitle">出貨照</span>
      <span class="spCount mono">{{ count }} / {{ props.max }}</span>
    </div>
    <p class="spWhy">
      拍到卡背的鑑定編號與封裝外觀，寄件前拍。爭議時這是你唯一的證據 ——
      沒有照片的出貨，判定時等於沒寄過。單張上限 {{ maxMb }}MB，接受 JPG／PNG／WebP。
    </p>

    <div class="spGrid">
      <div v-for="e in entries" :key="e.uid" class="spTile" :class="e.status">
        <!-- alt 留空：檔名已經寫在下面的失敗清單與移除鍵的 aria-label 裡，
             重複唸一次只是噪音。畫不出來的檔（例如誤選 PDF）直接把 img 收掉，
             否則破圖的替代文字會從遮罩底下透出來。 -->
        <img v-if="!e.broken" class="spImg" :src="e.previewUrl" alt="" @error="e.broken = true" />

        <!-- 上傳中：蓋一層並把百分比寫出來。沒有數字的話 15MB 傳到一半看起來像當掉 -->
        <div v-if="e.status === 'uploading'" class="spVeil">
          <span class="mono spPct">{{ e.progress }}%</span>
        </div>
        <div v-if="e.status === 'uploading'" class="spBar" aria-hidden="true">
          <i :style="{ width: e.progress + '%' }"></i>
        </div>

        <!-- 完成：一個勾。用 inline SVG，手機介面不放 emoji -->
        <span v-else-if="e.status === 'done'" class="spOk" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none"
               stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 8.6 6.3 12 13 4.6" />
          </svg>
        </span>

        <!-- 失敗：整張標紅，細節寫在下面的清單（縮圖太小放不下一句話） -->
        <div v-else-if="e.status === 'error'" class="spVeil bad">
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none"
               stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M10 3.2 18 17H2z" stroke-linejoin="round" />
            <path d="M10 8.4v3.4" /><path d="M10 14.2h.01" />
          </svg>
        </div>

        <button type="button" class="spX" :aria-label="`移除 ${shortName(e)}`" @click="remove(e.uid)">
          <span class="spXDot">
            <svg viewBox="0 0 12 12" width="10" height="10" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M2.5 2.5 9.5 9.5M9.5 2.5l-7 7" />
            </svg>
          </span>
        </button>
      </div>

      <!-- 還沒滿才給加。滿了還留著按鈕只會讓人按了沒反應 -->
      <label v-if="!full" class="spAdd">
        <input type="file" class="spInput" :accept="accept" multiple data-testid="ship-photo-input" @change="pick" />
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true"
             stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3.5 8.4h3.2l1.5-2.2h7.6l1.5 2.2h3.2v10.2H3.5z" />
          <circle cx="12" cy="13.2" r="3.3" />
        </svg>
        <span class="spAddT">加照片</span>
      </label>
    </div>

    <p v-if="dropNote" class="spDrop" role="alert">{{ dropNote }}</p>

    <!-- 失敗的細節：哪一張、為什麼、能不能重試。只說「上傳失敗」等於沒說 -->
    <ul v-if="failed.length" class="spErrs">
      <li v-for="e in failed" :key="e.uid">
        <span class="spErrN">{{ shortName(e) }}</span>
        <span class="spErrM">{{ e.error }}</span>
        <span class="spErrA">
          <button v-if="e.retriable" type="button" class="spBtn" @click="retry(e.uid)">重試</button>
          <button type="button" class="spBtn ghost" @click="remove(e.uid)">移除</button>
        </span>
      </li>
    </ul>

    <p class="spStat" :class="statusTone" role="status" aria-live="polite" data-testid="ship-photo-status">
      {{ statusLine }}
    </p>

    <p v-if="MOCK" class="spMock">
      MOCK 模式：沒有後端，這裡只把上傳流程與各種狀態演一遍，檔案不會真的送出去。
    </p>
  </div>
</template>

<style scoped>
.spWrap { margin: 4px 0 12px; }

.spHead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.spTitle { font-size: 12.5px; color: var(--muted); }
.spCount { font-size: 12.5px; color: var(--muted); flex: none; }

.spWhy { font-size: 11.5px; line-height: 1.7; color: var(--muted); margin: 4px 0 9px; }

/* 固定欄數 + minmax(0, 1fr)：內容再寬也不會把格線撐出容器 */
.spGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
/* 桌機不要讓五張照片各自長到 200px 寬 —— 縮圖是拿來認「我選了哪張」的，
   不是展示品。把格線本身收在 560px 內，桌機的縮圖大小就跟手機一致。 */
@media (min-width: 560px) { .spGrid { grid-template-columns: repeat(5, minmax(0, 1fr)); max-width: 560px; } }

.spTile {
  position: relative; min-width: 0;
  aspect-ratio: 3 / 4; border-radius: var(--radius);
  overflow: hidden; background: var(--surface-3);
  border: 1px solid var(--line);
}
.spTile.error { border-color: var(--danger); }
.spTile.done { border-color: var(--ok); }
.spImg { display: block; width: 100%; height: 100%; object-fit: cover; }
.spTile.uploading .spImg, .spTile.error .spImg { opacity: .45; }

.spVeil {
  position: absolute; inset: 0; display: grid; place-items: center;
  background: rgba(0, 0, 0, .42); color: var(--ink);
}
.spVeil.bad { background: var(--danger-wash); color: var(--danger); opacity: .92; }
.spPct { font-size: 14px; font-weight: 700; }

.spBar { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: var(--surface-2); }
.spBar i { display: block; height: 100%; background: var(--accent); transition: width .18s linear; }

.spOk {
  position: absolute; left: 6px; bottom: 6px;
  width: 20px; height: 20px; border-radius: var(--pill);
  display: grid; place-items: center;
  background: var(--ok); color: var(--bg);
}

/* 觸控目標 44×44，視覺只有 26px 的圓 —— 縮圖只有 100px 寬，
   畫一個 44px 的圓會把照片蓋掉，但點擊區域不能因此縮水 */
.spX {
  position: absolute; top: 0; right: 0;
  width: 44px; height: 44px; min-width: 44px; min-height: 44px;
  display: grid; place-items: center;
  padding: 0; border: 0; background: none; cursor: pointer; color: var(--ink);
}
.spXDot {
  width: 26px; height: 26px; border-radius: var(--pill);
  display: grid; place-items: center;
  background: rgba(0, 0, 0, .62); box-shadow: 0 1px 4px rgba(0, 0, 0, .5);
}

.spAdd {
  position: relative; min-width: 0;
  aspect-ratio: 3 / 4; min-height: 44px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  border: 1px dashed var(--line); border-radius: var(--radius);
  background: var(--surface-2); color: var(--muted);
  cursor: pointer; text-align: center; padding: 6px;
}
.spAddT { font-size: 12px; line-height: 1.4; }
.spInput { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer; }

.spDrop { font-size: 12px; line-height: 1.7; color: var(--warn); margin: 9px 0 0; }

.spErrs { list-style: none; margin: 9px 0 0; padding: 0; display: grid; gap: 7px; max-width: 560px; }
.spErrs li {
  min-width: 0;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px;
  background: var(--danger-wash); border-radius: var(--radius);
  padding: 9px 11px;
}
/* 檔名不截斷 —— 被切掉的檔名對「是哪一張出問題」這個問題毫無幫助 */
.spErrN { font-size: 12px; font-weight: 700; color: var(--ink); overflow-wrap: anywhere; }
.spErrM { font-size: 11.5px; line-height: 1.65; color: var(--danger); overflow-wrap: anywhere; }
.spErrA { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
.spBtn {
  min-height: 44px; padding: 0 16px;
  border-radius: var(--pill); border: 1px solid var(--line);
  background: var(--surface-2); color: var(--ink);
  font: inherit; font-size: 12.5px; cursor: pointer;
}
.spBtn.ghost { background: none; color: var(--muted); }

.spStat { font-size: 12px; line-height: 1.7; color: var(--muted); margin: 9px 0 0; }
.spStat.good { color: var(--ok); }
.spStat.wait { color: var(--warn); }
.spStat.bad { color: var(--danger); }

.spMock { font-size: 11px; line-height: 1.7; color: var(--faint); margin: 6px 0 0; }
</style>
