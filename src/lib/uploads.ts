/**
 * 站內檔案上傳：presign → 直傳物件儲存。
 *
 * 位元組不經過我們的後端 —— 後端只發一張限時通行證（POST /v1/files/presign），
 * 檔案本體是瀏覽器直接 PUT 到那個網址。所以這裡一定要有兩段：
 * 第一段拿 fileId + uploadUrl，第二段把檔案推上去。**只有兩段都成功，
 * fileId 才算數**：presign 成功但 PUT 失敗的話，資料庫有一列 files 卻沒有物件，
 * 那個 id 拿去送出就是一張指向空氣的憑證 —— 比沒有憑證更糟。
 *
 * 為什麼用 XMLHttpRequest 而不是 fetch：fetch 到今天仍然沒有上傳進度事件。
 * 出貨照在手機上用行動網路傳，一張 15MB 可以傳十幾秒，沒有進度條的話
 * 使用者會以為當掉而重按。進度是這個介面的必要條件，不是裝飾。
 *
 * 這支刻意寫成「任何用途都能用」（pool-cover / seller-doc / avatar 之後都走同一套），
 * 目前第一個使用者是出貨照。專案裡在此之前沒有任何上傳實作可以沿用。
 */
import { computed, onUnmounted, ref } from 'vue'
import { MOCK } from './config'
import { ApiError, http } from './http'

const MB = 1024 * 1024

export type UploadPurpose = 'pool-cover' | 'ship-photo' | 'unbox-video' | 'seller-doc' | 'avatar' | 'ticket-doc'

/**
 * 前端這份規則是 server/src/routes/files.ts 的鏡像，唯一的目的是
 * 「選完檔當場就知道不行」——15MB 的檔案傳上去才被退，使用者已經等了十秒。
 * 真正的把關永遠在後端：這裡放行不代表後端會收。
 */
export const UPLOAD_RULES: Record<UploadPurpose, { mimes: string[]; maxBytes: number; kinds: string }> = {
  'pool-cover': { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8 * MB, kinds: 'JPG／PNG／WebP' },
  avatar: { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 4 * MB, kinds: 'JPG／PNG／WebP' },
  'ship-photo': { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 15 * MB, kinds: 'JPG／PNG／WebP' },
  'unbox-video': { mimes: ['video/mp4', 'video/quicktime', 'video/webm'], maxBytes: 300 * MB, kinds: 'MP4／MOV／WebM' },
  'seller-doc': { mimes: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 15 * MB, kinds: 'JPG／PNG／PDF' },
  /* 客服工單的附件（migration 026 放行的用途）。
     這一條曾經被兩支前端各自用「執行期補登」塞進來 —— 使用者端一份、
     後台端一份，規則抄兩處要人工同步。規則表只能有一份、住在這裡。 */
  'ticket-doc': { mimes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], maxBytes: 15 * MB, kinds: 'JPG／PNG／WebP／PDF' }
}

/** <input accept="…">。這只是檔案選擇器的過濾，擋不住拖進來的檔案，所以下面還是要驗 */
export const acceptOf = (p: UploadPurpose) => UPLOAD_RULES[p].mimes.join(',')

export const maxMbOf = (p: UploadPurpose) => Math.floor(UPLOAD_RULES[p].maxBytes / MB)

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error'

export interface UploadEntry {
  uid: string
  name: string
  bytes: number
  /** 本機 object URL。選完檔立刻就有縮圖，不必等傳完 —— 等待中也看得到自己選了什麼 */
  previewUrl: string
  status: UploadStatus
  /** 0–100 */
  progress: number
  /** 只有 status === 'done' 才有值 */
  fileId: string
  /** 只有 status === 'error' 才有值，是給人看的一句話 */
  error: string
  /** 這個失敗值不值得按重試。格式不對／檔案太大按幾次都一樣，要換的是檔案不是運氣 */
  retriable: boolean
  /** 瀏覽器畫不出這個檔（例如選到 PDF）。畫不出來就不要留一個破圖在那裡 */
  broken: boolean
}

interface PresignRes { fileId: string; uploadUrl: string; key: string }

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** 後端的 file id 長相：f- + 12 位 hex（server/src/routes/orders.ts 的 ShipBody 會驗） */
const fakeFileId = () => {
  const b = new Uint8Array(6)
  ;(globalThis.crypto ?? { getRandomValues: (x: Uint8Array) => x.forEach((_, i) => (x[i] = Math.floor(Math.random() * 256))) })
    .getRandomValues(b)
  return 'f-' + Array.from(b, n => n.toString(16).padStart(2, '0')).join('')
}

/**
 * 把各種失敗翻成一句使用者看得懂、而且**講得出下一步**的話。
 * 「上傳失敗」這種訊息等於沒說 —— 太大要換張、格式不對要轉檔、
 * 網路斷掉要重試，三種的行動完全不同。
 */
function reasonOf(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'NOT_CONFIGURED') return '伺服器尚未開啟檔案上傳功能，請稍後再試或聯絡客服'
    if (e.code === 'NETWORK_ERROR') return '連不上伺服器，請檢查網路後重試'
    if (e.status === 401) return '登入已失效，請重新登入後再上傳'
    return e.message
  }
  return e instanceof Error ? e.message : '上傳失敗，請重試'
}

/** 直傳。回報進度，並把 xhr 交出去讓呼叫端能中止（使用者移除那一張時要停掉） */
function putDirect(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
  register: (x: XMLHttpRequest) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    register(xhr)
    xhr.open('PUT', url)
    /* content-type 一定要跟 presign 當時簽的 mime 一模一樣。
       R2 的簽章把 ContentType 算進去了，少送或送錯會被退 403，
       而那個 403 看起來像「沒權限」，其實是標頭對不上。 */
    xhr.setRequestHeader('content-type', file.type)
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)))
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`儲存空間拒絕了這個檔案（${xhr.status}），請重試`))
    xhr.onerror = () => reject(new Error('傳輸中斷，檔案沒有傳完，請重試'))
    xhr.ontimeout = () => reject(new Error('上傳逾時，請確認網路後重試'))
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'))
    xhr.send(file)
  })
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export interface UseUploadsOptions {
  /** 最多幾個檔。ship-photo 是 5（後端 ShipBody 的 .max(5)） */
  max?: number
}

/**
 * 一組「選檔 → 上傳 → 拿到 fileId」的狀態。
 *
 * 呼叫端只要看三個東西：`entries`（畫縮圖）、`pending`（還在傳，先別讓人送出）、
 * `fileIds`（全部傳完才會是完整的一組）。
 */
export function useUploads(purpose: UploadPurpose, options: UseUploadsOptions = {}) {
  const max = options.max ?? 5
  const rule = UPLOAD_RULES[purpose]

  const entries = ref<UploadEntry[]>([])
  /** File 與 XHR 不放進 ref：它們不需要響應，包進 Proxy 只會讓 XHR 出怪事 */
  const blobs = new Map<string, File>()
  const inflight = new Map<string, XMLHttpRequest>()

  const at = (id: string) => entries.value.find(e => e.uid === id)

  const done = computed(() => entries.value.filter(e => e.status === 'done'))
  /** 全部傳完才拿得到完整的一組；還在傳或有失敗的時候，這個陣列是不完整的，不可以拿去送出 */
  const fileIds = computed(() => done.value.map(e => e.fileId))
  const pending = computed(() => entries.value.some(e => e.status === 'queued' || e.status === 'uploading'))
  const failed = computed(() => entries.value.filter(e => e.status === 'error'))
  /** 有選檔、而且每一張都成功 —— 送出鍵的唯一判準 */
  const ready = computed(() => entries.value.length > 0 && entries.value.every(e => e.status === 'done'))
  const full = computed(() => entries.value.length >= max)
  const count = computed(() => entries.value.length)

  /** 選完檔當場擋掉一定不會過的：太大、格式不對。錯誤留在清單裡（不是丟掉）
      —— 使用者要看得出「我選的那五張裡，是哪一張不行」。 */
  function precheck(f: File): string {
    if (!rule.mimes.includes(f.type)) {
      return f.type
        ? `格式不支援（${f.type}），只收 ${rule.kinds}`
        : `認不出這個檔案的格式，只收 ${rule.kinds}`
    }
    if (f.size > rule.maxBytes) {
      return `檔案 ${(f.size / MB).toFixed(1)}MB，超過上限 ${maxMbOf(purpose)}MB`
    }
    return ''
  }

  async function start(id: string) {
    const file = blobs.get(id)
    const e = at(id)
    if (!file || !e) return
    e.status = 'uploading'
    e.progress = 0
    e.error = ''

    try {
      if (MOCK) {
        /* MOCK 模式沒有後端，presign 會 404／503。這裡**模擬**整段上傳而不是跳過：
           跳過的話這個介面在設計調校時永遠停在「已選檔」那一格，進度、失敗、
           重試三種狀態都看不到，等於做完也沒人看過它長什麼樣。
           模擬的假 id 用的是後端真正的格式（f- + 12 hex），所以送出去的形狀
           跟正式環境一致 —— mock 的 store 不會拿它去打 API。 */
        for (const p of [12, 38, 64, 86]) { await sleep(140); if (at(id) !== e) return; e.progress = p }
        await sleep(160)
        if (at(id) !== e) return
        e.fileId = fakeFileId()
        e.progress = 100
        e.status = 'done'
        return
      }

      const pre = await http<PresignRes>('/v1/files/presign', {
        method: 'POST',
        json: { purpose, mime: file.type, bytes: file.size }
      })
      await putDirect(pre.uploadUrl, file, p => { const cur = at(id); if (cur) cur.progress = p }, x => inflight.set(id, x))
      inflight.delete(id)
      /* 先確認這一列還在（使用者可能在傳的途中就移除了），再標記完成。
         不檢查的話會把一個已經被拿掉的檔案的 id 留在 fileIds 裡。 */
      const cur = at(id)
      if (!cur) return
      cur.fileId = pre.fileId
      cur.progress = 100
      cur.status = 'done'
    } catch (err) {
      inflight.delete(id)
      // 使用者自己按移除造成的中止不是錯誤，那一列早就不在了
      if (err instanceof DOMException && err.name === 'AbortError') return
      const cur = at(id)
      if (!cur) return
      cur.status = 'error'
      cur.error = reasonOf(err)
    }
  }

  /**
   * 加檔。回傳被擋在門外、連縮圖都沒建立的訊息（超過張數上限）——
   * 這種要當場講，不然使用者選了八張只看到五張，會以為是當掉。
   */
  function add(list: FileList | File[] | null): string {
    if (!list) return ''
    const incoming = Array.from(list)
    const room = Math.max(0, max - entries.value.length)
    const taken = incoming.slice(0, room)
    const dropped = incoming.length - taken.length

    for (const f of taken) {
      const id = uid()
      const bad = precheck(f)
      blobs.set(id, f)
      entries.value.push({
        uid: id,
        name: f.name || '未命名檔案',
        bytes: f.size,
        // 縮圖用本機 object URL：不必等上傳完成就看得到自己選了什麼
        previewUrl: URL.createObjectURL(f),
        status: bad ? 'error' : 'queued',
        progress: 0,
        fileId: '',
        error: bad,
        retriable: !bad,
        broken: false
      })
      if (!bad) void start(id)
    }
    return dropped > 0 ? `最多 ${max} 張，多出來的 ${dropped} 個檔案沒有加入` : ''
  }

  function remove(id: string) {
    inflight.get(id)?.abort()
    inflight.delete(id)
    const e = at(id)
    // object URL 是有主的資源，不 revoke 就一路佔著記憶體直到整頁被丟掉
    if (e) URL.revokeObjectURL(e.previewUrl)
    blobs.delete(id)
    entries.value = entries.value.filter(x => x.uid !== id)
  }

  /** 重試只重傳這一張。整組重來的話已經傳好的會白傳一次 */
  function retry(id: string) {
    const e = at(id)
    if (!e || e.status === 'uploading') return
    const file = blobs.get(id)
    // 格式／大小不對重試幾次都一樣，那種要換檔不是重試
    if (!file || precheck(file)) return
    void start(id)
  }

  function clear() {
    for (const x of inflight.values()) x.abort()
    inflight.clear()
    for (const e of entries.value) URL.revokeObjectURL(e.previewUrl)
    blobs.clear()
    entries.value = []
  }

  // 元件收掉時一定要把 object URL 還回去，否則離開頁面後那幾張圖還留在記憶體
  onUnmounted(clear)

  return { entries, add, remove, retry, clear, fileIds, pending, failed, ready, full, count, max }
}
