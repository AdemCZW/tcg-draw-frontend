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

/**
 * 失敗的分類。**只在能確定的時候才給確定的分類** ——
 * 分不出來就是 'unknown'，那一格的文案會老實說「可能是這幾種原因」。
 * 編一個聽起來很篤定的診斷，比不診斷更糟：使用者會照著錯的方向白忙。
 */
export type UploadFailKind =
  | 'offline'      // navigator.onLine 是 false。唯一能百分之百確定的一種
  | 'blocked'      // 一個位元組都還沒送出就瞬間失敗 —— 強烈暗示連線根本沒建立（預檢／CORS 被擋）
  | 'interrupted'  // 已經傳出去一部分才斷 —— 那是真的網路中斷
  | 'timeout'
  | 'rejected'     // 對方有回應，只是回了非 2xx（簽章對不上、規則不符）
  | 'auth'
  | 'server'       // 後端明講「這個功能現在不能用」
  | 'file'         // 檔案本身不合格，換檔才有用
  | 'unknown'
  | ''

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
  /** 失敗的分類。畫面靠它決定要不要繼續擺一顆重試 */
  kind: UploadFailKind
  /**
   * 下一步。error 講「發生了什麼」，hint 講「你現在該做什麼」——
   * 只寫「請重試」的訊息在 CORS 被擋的情況下會讓人按一百次然後放棄。
   */
  hint: string
  /**
   * 一行可複製的診斷碼，使用者回報時貼給我們。
   * **裡面不放簽章網址、token、檔名、檔案內容** —— 簽章網址本身就是一把鑰匙，
   * 貼進工單等於把寫入權限公開。只放我們查得動、又對不回個人的欄位。
   */
  diag: string
  /** 這個檔連續失敗過幾次。用來停止無限鼓勵重試 */
  attempts: number
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

/** 同一個檔連續失敗到這個次數，就不要再擺一顆重試當作唯一的出路 */
const MAX_ATTEMPTS = 3

/**
 * 「還沒送出任何位元組就失敗」要多快才算瞬間失敗。
 * 預檢被擋是瀏覽器本地就判定的，通常幾十毫秒內回來；真的連不上（DNS、逾時重送）
 * 至少要幾百毫秒。這個門檻只用來區分 blocked 與 unknown，
 * **踩不到門檻不會被講成「網路沒問題」**，只會退回「原因無法確定」。
 */
const BLOCKED_MS = 1200

/** 失敗當下能拿到的所有訊號。之後的分類與診斷碼都只從這裡長出來，不另外猜 */
interface FailSignals {
  phase: 'presign' | 'transfer'
  status: number
  /** xhr.upload.onprogress 有沒有真的送出過位元組 */
  progressed: boolean
  sentPct: number
  elapsedMs: number
  online: boolean
  code: string
}

/**
 * 直傳階段的失敗。**帶著訊號一起往外丟** ——
 * 原本這裡丟的是一個只有字串的 Error，結果是：使用者看到「請重試」而重試沒有用，
 * 我們手上則完全沒有東西可以查。訊號留在例外裡，start() 才有辦法分類。
 */
class TransferError extends Error {
  constructor(public kind: UploadFailKind, message: string, public signals: FailSignals) {
    super(message)
    this.name = 'TransferError'
  }
}

/**
 * 每一種失敗的兩句話：發生了什麼、你現在該做什麼。
 * 第二句是這整組文案存在的理由 —— 使用者要能自己判斷
 * 「這是我能解決的，還是要找平台的」。
 */
const FAIL_TEXT: Record<Exclude<UploadFailKind, ''>, { message: string; hint: string }> = {
  offline: {
    message: '裝置現在沒有網路，檔案沒有送出去',
    hint: '連上 Wi-Fi 或行動網路後按重試。這一張還留著，不用重新選檔。'
  },
  blocked: {
    /* 這一種是這次正式站事故的主嫌：連線在送出第一個位元組之前就結束了。
       我們**不宣稱**一定是 CORS —— 那要看瀏覽器主控台才確定得了 ——
       但可以確定的是「重試不會變好」，所以文案不能再叫人一直按。 */
    message: '連線還沒建立起來就中斷了，檔案一個位元組都沒送出去',
    hint: '這比較像站台的上傳設定有問題，不是你的網路，一直重試通常不會變好。可以先換一次網路（例如關掉 Wi-Fi 改用行動網路）確認；還是一樣的話請複製下面的診斷碼開一張客服工單，我們才查得到原因。'
  },
  interrupted: {
    message: '傳到一半連線就斷了，檔案沒有傳完',
    hint: '這通常是網路不穩。移到訊號好一點的地方再按重試，這一張會從頭重傳。'
  },
  timeout: {
    message: '上傳等太久，已經放棄這一次',
    hint: '網路太慢或中途停住了。換個網路環境再試一次；或改用檔案小一點的照片。'
  },
  rejected: {
    message: '儲存空間拒絕了這個檔案',
    hint: '重試通常沒有用。請複製下面的診斷碼開一張客服工單，這是站台端要修的。'
  },
  auth: {
    message: '登入已失效，這一次沒有送出去',
    hint: '請重新登入，回到這一頁再上傳一次。'
  },
  server: {
    message: '伺服器目前沒有開啟檔案上傳',
    hint: '這不是你能處理的。稍後再試一次；急的話請複製下面的診斷碼開客服工單。'
  },
  file: {
    message: '這個檔案不符合規則',
    hint: '要換的是檔案不是運氣，請重新選一張。'
  },
  unknown: {
    message: '上傳中斷了，原因無法確定',
    hint: '可能是網路中途斷線，也可能是站台的上傳設定有問題，從這裡分不出來。先重試一次；連續失敗的話請複製下面的診斷碼開客服工單。'
  }
}

/**
 * 一行可複製的診斷碼。
 *
 * **刻意不含**：uploadUrl（那是一把有寫入權限的鑰匙）、token、fileId、
 * 檔名（使用者的檔名常常帶真名或訂單資訊）、任何檔案內容。
 * 只留下我們拿去對後端日誌會用到、而且對不回個人的欄位。
 */
function diagOf(kind: UploadFailKind, s: FailSignals, mime: string, bytes: number, edited: boolean, attempts: number) {
  return [
    'VD-UP',
    `k=${kind || 'na'}`,
    `ph=${s.phase}`,
    `st=${s.status}`,
    s.code ? `c=${s.code}` : '',
    `prog=${s.progressed ? 'y' : 'n'}`,
    `pct=${s.sentPct}`,
    `ms=${s.elapsedMs}`,
    `net=${s.online ? 'on' : 'off'}`,
    `mime=${mime || 'na'}`,
    `kb=${Math.round(bytes / 1024)}`,
    `edit=${edited ? 'y' : 'n'}`,
    `try=${attempts}`,
    `ts=${new Date().toISOString()}`
  ].filter(Boolean).join(' ')
}

/**
 * 把各種失敗翻成「分類 + 兩句話」。
 * 「上傳失敗」這種訊息等於沒說 —— 太大要換張、格式不對要轉檔、
 * 斷網要重試、被擋要回報，四種的行動完全不同。
 */
function describe(e: unknown): { kind: UploadFailKind; message: string; hint: string; signals: FailSignals } {
  const online = navigator.onLine !== false
  const base: FailSignals = { phase: 'presign', status: 0, progressed: false, sentPct: 0, elapsedMs: 0, online, code: '' }

  if (e instanceof TransferError) {
    const t = FAIL_TEXT[e.kind === '' ? 'unknown' : e.kind]
    /* rejected 帶著 status 才有意義（403 是簽章對不上、404 是網址過期），
       所以那一種用 xhr 當下的訊息，不是罐頭句 */
    return { kind: e.kind, message: e.message || t.message, hint: t.hint, signals: e.signals }
  }

  if (e instanceof ApiError) {
    const signals = { ...base, status: e.status, code: e.code }
    if (e.code === 'NOT_CONFIGURED') return { kind: 'server', ...FAIL_TEXT.server, signals }
    if (e.code === 'NETWORK_ERROR') {
      /* presign 走的是 fetch，沒有進度事件可以看 —— 只有離線這一種確定得了，
         其餘一律 unknown，不要拿 transfer 那套推論硬套在這一段上 */
      const kind: UploadFailKind = online ? 'unknown' : 'offline'
      return { kind, ...FAIL_TEXT[kind], signals }
    }
    if (e.status === 401) return { kind: 'auth', ...FAIL_TEXT.auth, signals }
    return { kind: 'rejected', message: e.message, hint: FAIL_TEXT.rejected.hint, signals }
  }

  return {
    kind: 'unknown',
    message: e instanceof Error && e.message ? e.message : FAIL_TEXT.unknown.message,
    hint: FAIL_TEXT.unknown.hint,
    signals: base
  }
}

/**
 * 這一種失敗值不值得再按一次重試。
 * 判準有兩層：分類本身（格式不對按幾次都一樣），以及次數 ——
 * 連續失敗 MAX_ATTEMPTS 次之後，畫面不該再把重試當作唯一的出路。
 */
function retriableFor(kind: UploadFailKind, attempts: number): boolean {
  if (kind === 'file' || kind === 'server' || kind === 'auth' || kind === 'rejected') return false
  /* blocked 幾乎確定重試沒有用，但留一次機會：偶發的預檢失敗（後端冷啟動時
     OPTIONS 逾時）確實存在，第一次就把出路收掉會冤枉那種情況 */
  if (kind === 'blocked') return attempts < 2
  return attempts < MAX_ATTEMPTS
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
    /* ⚠️ 這一段原本寫著「content-type 一定要跟 presign 當時簽的一模一樣，
       少送或送錯會被退 403」。**那是錯的**，實測簽名網址的
       X-Amz-SignedHeaders 只有 `content-length;host` —— presigner 把
       ContentType 整個丟掉了，既沒進簽章也沒進 query。所以 content-type
       送什麼都不影響簽章成不成立。

       那還是要送，但理由不同：R2 會把它記成物件的 Content-Type，
       之後 /raw 導過去時瀏覽器要靠它決定怎麼渲染。送錯不會 403，
       會變成「圖片被當成檔案下載」。

       **content-length 才是真的被簽進去的那一個**（見 server/src/r2.ts 的
       presignPut —— 沒有它，後端宣告的 8MB 上限在儲存層毫無強制力）。
       所以送出去的必須就是 presign 當下那個 file，不能中途換一個或改內容；
       換了就是 403。裁切／壓縮都發生在 presign **之前**（start() 讀的是
       blobs 裡當下那一份），這條路徑是對得上的。 */
    xhr.setRequestHeader('content-type', file.type)

    /* 失敗當下要判斷「連線到底有沒有建立起來」，靠的就是這三個變數。
       xhr.onerror 本身什麼都不帶（規格就是這樣，為了不洩漏跨來源的資訊），
       所以訊號必須在事情還順利的時候先記下來，事後補不回來。 */
    const startedAt = Date.now()
    let progressed = false
    let sentPct = 0

    xhr.upload.onprogress = e => {
      // loaded > 0 才算真的送出去了；有些瀏覽器會先發一個 loaded = 0 的事件
      if (e.loaded > 0) progressed = true
      if (e.lengthComputable) {
        sentPct = Math.min(99, Math.round((e.loaded / e.total) * 100))
        onProgress(sentPct)
      }
    }

    const signals = (): FailSignals => ({
      phase: 'transfer',
      status: xhr.status,
      progressed,
      sentPct,
      elapsedMs: Date.now() - startedAt,
      online: navigator.onLine !== false,
      code: ''
    })

    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new TransferError('rejected', `儲存空間拒絕了這個檔案（HTTP ${xhr.status}）`, signals()))

    /**
     * onerror 涵蓋好幾種完全不同的原因（預檢被擋、離線、DNS 失敗、連線中斷），
     * 而它們該做的事完全相反：斷網要重試，被擋要回報。這裡用三個訊號分開：
     *   1. navigator.onLine —— 唯一能百分之百確定的一種
     *   2. 有沒有送出過位元組 —— 完全沒有就失敗，強烈暗示連線根本沒建立起來
     *   3. 失敗得多快 —— 瞬間失敗比較像本地就被判掉，不像連到一半斷掉
     * 三個訊號湊不出結論就是 unknown，**不要編一個聽起來很篤定的診斷**。
     */
    xhr.onerror = () => {
      const s = signals()
      const kind: UploadFailKind =
        !s.online ? 'offline'
        : s.progressed ? 'interrupted'
        : s.elapsedMs < BLOCKED_MS ? 'blocked'
        : 'unknown'
      reject(new TransferError(kind, FAIL_TEXT[kind].message, s))
    }

    xhr.ontimeout = () => reject(new TransferError('timeout', FAIL_TEXT.timeout.message, signals()))
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
      e.kind = 'file'
      e.hint = FAIL_TEXT.file.hint
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
    e.hint = ''
    e.kind = ''
    /* 次數只加不減：重試成功不代表前面那幾次沒發生過，而「這個檔在這台裝置上
       連續失敗幾次」正是決定要不要繼續給重試的依據 */
    e.attempts++

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
      const d = describe(err)
      cur.status = 'error'
      cur.kind = d.kind
      cur.error = d.message
      cur.retriable = retriableFor(d.kind, cur.attempts)
      /* 連續失敗到上限：出路不再是重試，而是回報。這句話要蓋掉原本那一種的
         hint，否則畫面會一邊說「已經試了三次」一邊繼續叫人重試。 */
      cur.hint = cur.retriable
        ? d.hint
        : `這個檔已經連續失敗 ${cur.attempts} 次，再按重試不太可能有不同結果。請複製下面的診斷碼開一張客服工單，或換一張圖片試試。`
      cur.diag = diagOf(d.kind, d.signals, file.type, file.size, cur.edited, cur.attempts)
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
        edited: false,
        kind: bad ? 'file' : '',
        hint: bad ? FAIL_TEXT.file.hint : '',
        // 選檔就被擋掉的不給診斷碼：訊息本身已經說得夠清楚，多一段碼只是噪音
        diag: '',
        attempts: 0
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
    /* 已經判定不值得重試的（含連續失敗到上限）就真的不要再送。
       畫面上那顆按鈕會先消失，但鍵盤操作與舊畫面還是可能打進來，
       出路的收斂要在這裡成立，不能只靠 v-if。 */
    if (!e.retriable) return
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
