<script setup lang="ts">
/**
 * 卡片正面照：選檔 → 裁切壓縮 → 直傳，回一個 fileId 給登記表單。
 *
 * ImageCropper **一定要掛**：card-front 在 EDIT_POLICY 有 policy（不是 null），
 * 而 useUploads 的契約是「policy 不是 null 的用途，呼叫端必須把 ImageCropper
 * 掛出來」。不掛的話檔案會永遠停在 editing 狀態、上傳一輩子不會開始，
 * 而且畫面上看不出來為什麼（見 src/lib/uploads.ts 檔頭）。
 */
import { computed, ref, watch } from 'vue'
import ImageCropper from '@/components/ImageCropper.vue'
import { acceptOf, maxMbOf, useUploads } from '@/lib/uploads'

const emit = defineEmits<{
  'update:fileId': [string | null]
  'update:ready': [boolean]
}>()

const {
  entries, add, remove, retry, fileIds, pending, failed, ready,
  editTarget, applyEdit, cancelEdit
} = useUploads('card-front', { max: 1 })
const dropNote = ref('')
const accept = acceptOf('card-front')
const maxMb = maxMbOf('card-front')
const entry = computed(() => entries.value[0] ?? null)

function pick(event: Event) {
  const input = event.target as HTMLInputElement
  dropNote.value = add(input.files)
  input.value = ''
}

const status = computed(() => {
  // 停在裁切框也算 pending，但「上傳中」對它是假的 —— 球在使用者腳下
  if (editTarget.value) return '請先框出卡片範圍，確認後才會開始上傳'
  if (pending.value) return '圖片上傳中，完成後才能登記'
  if (failed.value.length) return failed.value[0]?.error ?? '圖片上傳失敗，請重試或更換檔案'
  if (ready.value) return '正面圖片已上傳，可以登記'
  return `必須上傳一張正面圖片，單檔上限 ${maxMb}MB`
})

watch([fileIds, ready], ([ids, isReady]) => {
  emit('update:fileId', ids[0] ?? null)
  emit('update:ready', isReady)
}, { immediate: true })
</script>

<template>
  <div class="frontUpload">
    <p class="hint muted">請上傳實體卡正面清晰照片。這張圖片會在卡冊、開池與市場公開顯示。</p>
    <div v-if="entry" class="preview" :class="entry.status">
      <img v-if="!entry.broken" :src="entry.previewUrl" alt="卡片正面預覽" @error="entry.broken = true">
      <span v-else class="noPreview">無法預覽</span>
      <span v-if="entry.status === 'uploading'" class="progress mono">{{ entry.progress }}%</span>
      <button type="button" class="remove" aria-label="移除正面圖片" @click="remove(entry.uid)">移除</button>
      <button v-if="entry.status === 'error' && entry.retriable" type="button" class="retry" @click="retry(entry.uid)">重試</button>
    </div>
    <label v-else class="choose">
      <input type="file" :accept="accept" @change="pick">
      <span>選擇正面圖片</span>
    </label>
    <p class="status" :class="{ bad: failed.length, good: ready }" role="status">{{ status }}</p>
    <p v-if="dropNote" class="status bad" role="alert">{{ dropNote }}</p>

    <!-- 裁切框。:key 讓換張時整個重建，不重建的話 canvas 還留著上一張的狀態 -->
    <ImageCropper
      v-if="editTarget" :key="editTarget.uid"
      :file="editTarget.file" :policy="editTarget.policy" :max-bytes="editTarget.maxBytes"
      :index="editTarget.index" :total="editTarget.total"
      @done="r => applyEdit(editTarget!.uid, r)"
      @cancel="cancelEdit(editTarget!.uid)"
    />
  </div>
</template>

<style scoped>
.frontUpload { display: grid; gap: 9px; }
.hint, .status { margin: 0; font-size: 12px; line-height: 1.6; }
.preview { position: relative; width: min(180px, 100%); aspect-ratio: 5 / 7; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-3); }
.preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
.noPreview, .progress { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, .56); color: white; }
/* 移除／重試量到只有 23px 高。這兩顆疊在預覽圖上，按不準的代價是
   「想換一張卻換不掉」—— 一次只能傳一張，換不掉就是走不下去。
   拉到 44px 並把字級提到 12.5px；圖只有 180px 寬，兩顆各自靠邊放得下。 */
.remove, .retry {
  position: absolute; bottom: 6px;
  min-height: 44px; min-width: 56px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; padding: 0 12px; border-radius: 8px;
  background: rgba(0, 0, 0, .72); color: white; font: inherit; font-size: 12.5px;
}
.remove:focus-visible, .retry:focus-visible, .choose:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.remove { right: 6px; }
.retry { left: 6px; }
/* 40px → 44px：這是沒有預覽圖時畫面上唯一的操作 */
.choose { width: fit-content; min-height: 44px; display: inline-flex; align-items: center; padding: 0 14px; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; font-size: 13px; }
.choose input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.bad { color: var(--danger); }
.good { color: var(--success); }
</style>
