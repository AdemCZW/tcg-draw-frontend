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
 *
 * ── 選檔與上傳之間插了一段「裁切 + 壓縮」 ──
 * 為什麼：手機拍的照片 3–5MB，行動網路傳得慢又容易斷，超過 15MB 更是直接
 * 被 precheck 擋死 —— 而使用者在手機上沒有辦法自己縮圖。所以現在的順序是
 * 選檔 → （依用途）裁切壓縮 → presign → PUT。
 *
 * 兩件事一定要記住：
 *   1. presign 送的 mime / bytes 一定是**壓縮後**的值。送原檔的值會讓後端
 *      按原檔簽章，PUT 上去的 content-type 對不上就是 403；bytes 也一樣，
 *      規則表是按送出的數字驗的。這條錯了只在正式環境爆，本機 mock 看不出來。
 *   2. policy 不是 null 的用途，呼叫端**必須**把 ImageCropper 掛出來
 *      （看下面回傳的 editTarget）。不掛的話檔案會停在 editing，
 *      永遠不會開始上傳，畫面上還看不出為什麼。
 */
import { computed, onUnmounted, ref } from 'vue'
import { MOCK } from './config'
import { ApiError, http } from './http'
import {
  EDIT_POLICY, fileFrom, isProcessable, planFor,
  type EditPolicy, type EncodeResult
} from './image-edit'

const MB = 1024 * 1024

/**
 * 進得了裁切壓縮的檔案，體積的絕對天花板。
 * 超過這個數字連解碼都不試 —— iOS Safari 在這個量級會直接把分頁殺掉，
 * 而被殺掉的分頁不會回報任何錯誤，使用者只看到 App 突然重來。
 */
const EDIT_HARD_CAP = 64 * MB

export type UploadPurpose = 'pool-cover' | 'ship-photo' | 'unbox-video' | 'seller-doc' | 'avatar' | 'ticket-doc' | 'card-front'

/**
 * 前端這份規則是 server/src/routes/files.ts 的鏡像，唯一的目的是
 * 「選完檔當場就知道不行」——15MB 的檔案傳上去才被退，使用者已經等了十秒。
 * 真正的把關永遠在後端：這裡放行不代表後端會收。
 */
export const UPLOAD_RULES: Record<UploadPurpose, { mimes: string[]; maxBytes: number; kinds: string }> = {
  'pool-cover': { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8 * MB, kinds: 'JPG／PNG／WebP' },
  'card-front': { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8 * MB, kinds: 'JPG／PNG／WebP' },
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

/* preparing＝正在判斷這個檔要不要進裁切（要讀檔頭，是非同步的）；
   editing＝正停在裁切框等使用者。兩種都還沒開始上傳，但都不能讓人送出。 */
export type UploadStatus = 'preparing' | 'editing' | 'queued' | 'uploading' | 'done' | 'error'

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
  /** 原始檔案大小。壓完之後要能告訴使用者「省了多少」，所以原始值不能被蓋掉 */
  originalBytes: number
  /** 這一張走過裁切壓縮。沒走過的（PDF、本來就夠小的截圖）不要謊報 */
  edited: boolean
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
       而那個 403 看起來像「沒權限」，其實是標頭對不上。

       **大小同理**：簽章現在也把 ContentLength 算進去（見 server/src/r2.ts
       的 presignPut —— 沒有它，後端宣告的 8MB 上限在儲存層毫無強制力）。
       所以送出去的必須就是 presign 當下那個 file，不能中途換一個或改內容；
       換了就是 403。裁切／壓縮都發生在 presign **之前**（start() 讀的是
       blobs 裡當下那一份），這條路徑是對得上的。 */
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
  /* 這個用途要不要在上傳前先裁切壓縮。null＝不處理，選完檔就直接傳
     （影片、以及正在退場的出貨照）。不是 null 的話呼叫端一定要掛 ImageCropper，
     見檔頭的契約說明。 */
  const policy: EditPolicy | null = EDIT_POLICY[purpose]

  const entries = ref<UploadEntry[]>([])
  /** 這一批總共有幾張進過裁切框，用來顯示「第 2 / 3 張」。清空時歸零 */
  const editSeen = ref(0)
  /** File 與 XHR 不放進 ref：它們不需要響應，包進 Proxy 只會讓 XHR 出怪事 */
  const blobs = new Map<string, File>()
  const inflight = new Map<string, XMLHttpRequest>()

  const at = (id: string) => entries.value.find(e => e.uid === id)

  const done = computed(() => entries.value.filter(e => e.status === 'done'))
  /** 全部傳完才拿得到完整的一組；還在傳或有失敗的時候，這個陣列是不完整的，不可以拿去送出 */
  const fileIds = computed(() => done.value.map(e => e.fileId))
  /* 「還沒有結果」的都算 pending，包含正停在裁切框那一張 ——
     呼叫端拿它壓住送出鍵，裁到一半就送出的話那張附件會憑空消失 */
  const pending = computed(() => entries.value.some(e => e.status !== 'done' && e.status !== 'error'))
  const failed = computed(() => entries.value.filter(e => e.status === 'error'))
  /** 有選檔、而且每一張都成功 —— 送出鍵的唯一判準 */
  const ready = computed(() => entries.value.length > 0 && entries.value.every(e => e.status === 'done'))
  const full = computed(() => entries.value.length >= max)

  /* ---------- 裁切佇列 ----------
     一次只處理一張：五張照片同時彈五個裁切框沒有人受得了，
     而且排隊處理才有辦法告訴使用者「還有幾張」。 */
  const editQueue = computed(() => entries.value.filter(e => e.status === 'editing'))

  /** 呼叫端把這個接到 ImageCropper 上。null＝現在沒有東西要裁 */
  const editTarget = computed(() => {
    const e = editQueue.value[0]
    if (!e || !policy) return null
    const file = blobs.get(e.uid)
    if (!file) return null
    return {
      uid: e.uid,
      file,
      policy,
      /* 壓縮保證壓進這個數字，所以壓完的檔案一定過得了後端那關。
         用 rule.maxBytes 而不是自己寫一個數字：規則表只能有一份 */
      maxBytes: rule.maxBytes,
      index: Math.max(0, editSeen.value - editQueue.value.length),
      total: editSeen.value
    }
  })

  /** 佇列空了就把計數歸零，下一批才會從「第 1 張」開始數 */
  function afterEdit() {
    if (!editQueue.value.length) editSeen.value = 0
  }

  /**
   * 裁切框給答案了。result 為 null＝原檔已經夠好，不重新編碼。
   *
   * 這裡是整條動線最容易錯的一點：換檔之後 entry.bytes 一定要跟著換成
   * **壓縮後**的大小，因為 start() 會拿 blobs 裡的檔案去 presign，
   * 而 presign 送的 mime/bytes 就是後端拿去簽章與驗規則的那一組。
   * 兩邊對不上的話 PUT 會被 R2 退 403，而那個 403 看起來像沒權限。
   */
  function applyEdit(id: string, result: EncodeResult | null) {
    const e = at(id)
    if (!e || e.status !== 'editing') return
    if (result) {
      const f = fileFrom(result, e.name)
      blobs.set(id, f)
      // 舊的縮圖網址要還回去，不然每裁一張就漏一份原圖的記憶體
      URL.revokeObjectURL(e.previewUrl)
      e.previewUrl = URL.createObjectURL(f)
      e.name = f.name
      e.bytes = f.size
      e.edited = true
      e.broken = false
    }
    const file = blobs.get(id)
    // 壓完再驗一次：這時候的 mime 與 bytes 才是真正要送出去的那一組
    const bad = file ? precheck(file) : '處理後的檔案不見了，請重新選一次'
    if (bad) {
      e.status = 'error'
      e.error = bad
      e.retriable = false
      afterEdit()
      return
    }
    e.status = 'queued'
    afterEdit()
    void start(id)
  }

  /** 使用者在裁切框按取消＝這一張不要了。留著一張卡在 editing 的比刪掉更糟 */
  function cancelEdit(id: string) {
    remove(id)
    afterEdit()
  }
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
      /* 會走壓縮的檔案**不在這裡擋**。手機拍的照片動輒 4MB、拍證據要放大細節時
         更容易破 15MB，而使用者在手機上沒有辦法自己縮圖 —— 擋在這裡等於
         叫他去做一件做不到的事。壓完通常只剩十分之一，那時再驗一次就好
         （applyEdit 會補驗）。
         但還是要有天花板：一張 100MB 的圖光是解碼就會把手機的分頁打爆，
         那種情況要當場講清楚，不要讓他等三十秒才看到白畫面。 */
      if (isProcessable(f, policy)) {
        return f.size <= EDIT_HARD_CAP
          ? ''
          : `檔案 ${(f.size / MB).toFixed(1)}MB，大到瀏覽器處理不動（上限 ${EDIT_HARD_CAP / MB}MB）`
      }
      return `檔案 ${(f.size / MB).toFixed(1)}MB，超過上限 ${maxMbOf(purpose)}MB`
    }
    return ''
  }

  /**
   * 決定這一張要不要進裁切框。要讀檔頭（非同步），所以中間有一段 'preparing'。
   * 讀檔頭失敗不是致命的：當作不用處理、照原檔傳就好 ——
   * 為了縮圖而讓整個上傳失敗是本末倒置。
   */
  async function prepare(id: string) {
    const f = blobs.get(id)
    if (!f || !at(id)) return
    let plan: 'as-is' | 'edit' = 'as-is'
    try {
      plan = await planFor(f, policy)
    } catch {
      plan = 'as-is'
    }
    const cur = at(id)
    // 使用者可能在讀檔頭的空檔就把這一列移除了
    if (!cur || cur.status !== 'preparing') return
    if (plan === 'edit') {
      cur.status = 'editing'
      editSeen.value++
      return
    }
    cur.status = 'queued'
    void start(id)
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
        status: bad ? 'error' : 'preparing',
        progress: 0,
        fileId: '',
        error: bad,
        retriable: !bad,
        broken: false,
        originalBytes: f.size,
        edited: false
      })
      // 先判斷要不要進裁切（要讀檔頭），不是直接開傳
      if (!bad) void prepare(id)
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
    if (!entries.value.some(x => x.status === 'editing')) editSeen.value = 0
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
    editSeen.value = 0
  }

  // 元件收掉時一定要把 object URL 還回去，否則離開頁面後那幾張圖還留在記憶體
  onUnmounted(clear)

  return {
    entries, add, remove, retry, clear,
    fileIds, pending, failed, ready, full, count, max,
    /* 裁切：呼叫端只要把 editTarget 餵給 ImageCropper，
       再把它的兩個事件接到 applyEdit / cancelEdit 就好 */
    editTarget, applyEdit, cancelEdit
  }
}
