<script setup lang="ts">
/**
 * 訓練家卡（規格 SPECtrainercard.md 的 P1–P6）。
 *
 * ── 第二版：P2 從「拍卡」改成「從自己的卡冊挑一張」──────────────────
 * 使用者拍板（2026-09-04）：「暫時只需要有上傳卡片就可以製作，選擇自己要的
 * 生成一張，中途只能重新一次」。
 *
 * 這一改讓**多數人不必再做透視校正**，因為卡冊裡的卡我們已經有圖了：
 *   · 目錄卡（圖來自 TCGdex）本來就是正面方正的掃描 → 直接貼，不跑校正
 *   · 自己登記的卡（card-front 上傳的照片）是手持拍的 → 照樣要拖四個角
 * 這兩者怎麼分辨、為什麼不能看欄位名，全部寫在 features/trainer-card/card-source.ts。
 *
 * 相機那條路降級成 P2 的次要入口（「用一張還沒登記的卡」），**而且不再
 * 一進頁面就要權限** —— 使用者按了才開相機。留著的理由見那一段的註解。
 *
 * ── 這一輪做了什麼、沒做什麼 ─────────────────────────────────────────
 * 六個步驟全部是真的：挑卡（必要時四角透視校正）、自拍、命名、等待、成品分享。
 * **唯一是替身的是「換臉」那一次 AI 呼叫** —— 它包在 face-swap.ts 的
 * adapter 後面，這一輪的實作直接回傳樣板原圖，並刻意保留 20 秒的延遲，
 * 因為「等待畫面撐不撐得住 20 秒」是這一頁真正的設計風險。
 * 樣板本身也是程式產生的佔位圖（見 scripts/trainer-card/）。
 *
 * ── 隱私（規格 §5 C-2 / C-3）────────────────────────────────────────
 * 卡片照、自拍、成品**只存在於這個元件的記憶體**，不進 localStorage、
 * 不進網址、不進任何 log 或分析事件。離開頁面就沒了，P6 會明講這件事。
 *
 * ── 沒有掛進導覽 ─────────────────────────────────────────────────────
 * 比照 /fx 與 /dev/card-picker：知道網址的人才進得來。
 * 入口要放哪還沒決定（建議見交付說明）。
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import BottomActionBar from '@/components/BottomActionBar.vue'
import QuadEditor from '@/features/trainer-card/components/QuadEditor.vue'
import CardbookPicker from '@/features/trainer-card/components/CardbookPicker.vue'
import {
  CardArtError, classifyCardArt, fullFrameCorners, loadCardArt, type CardArtSource
} from '@/features/trainer-card/card-source'
import type { UserPrize } from '@/types/models'
import {
  CARD_ASPECT, composeTrainerCard, rectifyPreview, templateUrl
} from '@/features/trainer-card/compose'
import {
  BudgetExhaustedError, createStubFaceSwap, FaceSwapError, GenerationBudget,
  MAX_USER_GENERATIONS, swapWithRetry,
  type FaceSwapErrorCode, type SwapPhase
} from '@/features/trainer-card/face-swap'
import {
  bitmapFromFile, bitmapToBlob, CameraError, cameraMessage, grabFrame,
  openCamera, stopStream, type CameraFacing
} from '@/features/trainer-card/capture'
import { canvasToBlob, makeFile, saveOrShare } from '@/features/trainer-card/share'
import type { Pt } from '@/features/trainer-card/perspective'

type Step = 'consent' | 'card' | 'selfie' | 'name' | 'generating' | 'result'
const step = ref<Step>('consent')

/* ── 測試面板 ────────────────────────────────────────────────────────
   ?tc-test=1 才出現。不是彩蛋，是驗收工具：規格 §8.1 的四條錯誤路徑
   如果只能靠「等真的壞掉」才跑得到，真 API 接上來時它們等於第一次執行。 */
const testMode = typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('tc-test')
const forceError = ref<FaceSwapErrorCode | ''>('')
const failOnce = ref(false)
const delayMs = ref(testMode ? 1200 : 20_000)

/* ── 相機 ───────────────────────────────────────────────────────────── */
const stream = shallowRef<MediaStream | null>(null)
const video = ref<HTMLVideoElement | null>(null)
const camError = ref('')
const camBusy = ref(false)

async function startCamera(facing: CameraFacing) {
  camError.value = ''
  camBusy.value = true
  try {
    stopStream(stream.value)
    const s = await openCamera(facing)
    stream.value = s
    // srcObject 而不是 URL.createObjectURL(stream)：後者已廢棄，
    // 而且會落進 CSP 的 media-src（這個站沒設，會掉到 default-src 'self'）
    if (video.value) {
      video.value.srcObject = s
      await video.value.play().catch(() => {})
    }
  } catch (e) {
    camError.value = e instanceof CameraError ? e.message : cameraMessage('unknown')
    stream.value = null
  } finally {
    camBusy.value = false
  }
}
function closeCamera() {
  stopStream(stream.value)
  stream.value = null
  if (video.value) video.value.srcObject = null
}

/* ── P2 挑卡（卡冊優先，相機是次要入口）────────────────────────────── */
const cardPhoto = shallowRef<ImageBitmap | null>(null)
const corners = ref<Pt[]>([])
const previewUrl = ref('')

/**
 * 這張卡的圖是哪一種來源。**整個 P2 的分岔就靠它**：
 *   rectify = true   → 走 QuadEditor，使用者拖四個角
 *   rectify = false  → 直接用，不出現 QuadEditor
 * null = 還沒挑。
 *
 * 這個值也會寫進 DOM（`data-card-source` / `data-rectify`），驗收腳本讀的是
 * 它而不是「畫面看起來像不像」—— 走錯分支的症狀（一張本來就方正的圖被
 * 多做一次重取樣、或一張手持照片沒校正就貼上去）用肉眼判斷是不可靠的。
 */
const cardSource = ref<CardArtSource | null>(null)
const needsRectify = computed(() => cardSource.value?.rectify ?? false)
/** 挑到的是卡冊裡的哪一張。目前只拿來顯示卡名；端點上線後也是綁定的鍵 */
const pickedPrize = shallowRef<UserPrize | null>(null)
const cardError = ref('')
const cardBusy = ref(false)

/** 預設四角：置中的 63:88 框，佔畫面七成。使用者從這裡開始拖，通常只要微調。 */
function defaultCorners(w: number, h: number): Pt[] {
  const ch = h * 0.7
  const cw = Math.min(w * 0.86, ch * CARD_ASPECT)
  const x0 = (w - cw) / 2, y0 = (h - ch) / 2
  return [
    { x: x0, y: y0 }, { x: x0 + cw, y: y0 },
    { x: x0 + cw, y: y0 + ch }, { x: x0, y: y0 + ch }
  ]
}

function setCardPhoto(bmp: ImageBitmap, source: CardArtSource) {
  cardPhoto.value?.close()
  cardPhoto.value = bmp
  cardSource.value = source
  /* 不校正的來源，四角就是圖自己的四角 —— 使用者不必拖，也不可能拖歪。
     （為什麼「不校正」不等於「不做任何映射」，見 card-source.ts 的說明。） */
  corners.value = source.rectify
    ? defaultCorners(bmp.width, bmp.height)
    : fullFrameCorners(bmp.width, bmp.height)
  closeCamera()
}

/** 從卡冊挑了一張。圖用 classifyCardArt() 決定的那個網址去取，看到什麼就合成什麼。 */
async function onPickFromCardbook(prize: UserPrize, source: CardArtSource) {
  cardError.value = ''
  cardBusy.value = true
  try {
    const bmp = await loadCardArt(source)
    pickedPrize.value = prize
    setCardPhoto(bmp, source)
  } catch (e) {
    /* 卡名與圖片網址都不進 log（卡片照是個人資料，規格 §5）——
       只讓使用者看到人話訊息，並留下「換別張」這條路。 */
    cardError.value = e instanceof CardArtError ? e.message : '這張卡的圖讀不進來，換一張試試。'
  } finally {
    cardBusy.value = false
  }
}

/** 重新挑一張：把已經挑的那張清掉，回到卡冊列表 */
function repickCard() {
  cardPhoto.value?.close()
  cardPhoto.value = null
  cardSource.value = null
  pickedPrize.value = null
  cardError.value = ''
  closeCamera()
}

/* ── 次要入口：用一張還沒登記的卡 ───────────────────────────────────
   **為什麼不刪掉相機那條路**（三個理由，都不是「捨不得」）：
     1. 卡冊裡沒有的卡就只剩這條路。使用者手上剛拆的卡還沒登記是常態，
        而登記一張卡要填卡名／卡號／鑑定資訊，比拍一張照麻煩得多。
     2. 它是卡冊那條路的**故障退路**。自己登記的卡走的是
        /v1/files/:id/raw → 302 到 R2，那條路要 R2 的 CORS 放行本站來源；
        沒放行時圖讀不進 canvas，而使用者手上明明就有那張實體卡。
     3. 透視校正（第一階段量到 0.0088px 的那一套）只有這條路與「自己登記的
        卡」會走到。整條藏起來的話，那份程式碼會變成沒有任何測試走得到的死碼。
   **但它不再是主路徑**：預設收在 <details> 裡，而且**不會一進頁面就要相機
   權限** —— 多數人現在根本不需要相機，先要權限只會讓人在第一步就跳出去。 */
async function shootCard() {
  if (!video.value) return
  try {
    setCardPhoto(await grabFrame(video.value), UNREGISTERED_SOURCE)
  } catch { camError.value = cameraMessage('unknown') }
}

async function pickCard(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    setCardPhoto(await bitmapFromFile(f), UNREGISTERED_SOURCE)
  } catch { camError.value = '這個檔案讀不成圖片，換一張試試。' }
  ;(e.target as HTMLInputElement).value = ''
}

/** 相機／相簿來的一律是手持拍的照片 —— 必然有梯形變形，一定要校正 */
const UNREGISTERED_SOURCE: CardArtSource = {
  kind: 'photo', url: '', rectify: true, why: '相機或相簿的照片（還沒登記的卡）'
}

/* 校正預覽：跟合成走同一支 warpQuad，所以這裡看到的就是最後貼上去的東西。
   節流到動畫幀，拖曳時不會每一個 pointermove 都重算一次 41 萬像素。 */
let previewJob = 0
watch([cardPhoto, corners], () => {
  const bmp = cardPhoto.value
  /* 不校正的來源不做預覽：那張圖本來就是最後貼上去的樣子，
     再算一次只是白花 8ms 並且多產生一個要回收的 blob URL。 */
  if (!bmp || !needsRectify.value || corners.value.length !== 4) return
  cancelAnimationFrame(previewJob)
  previewJob = requestAnimationFrame(() => {
    try {
      const c = rectifyPreview(bmp, corners.value, 300)
      c.toBlob(b => {
        if (!b) return
        if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
        previewUrl.value = URL.createObjectURL(b)
      }, 'image/png')
    } catch { /* 四角退化時解不出透視，等使用者再拖一下就好，不用報錯 */ }
  })
}, { deep: true })

/* 測試面板開著時，把分類函式掛出來。
   **這不是後門**：它只在 ?tc-test=1 之下存在，而且是一支純函式，讀不到任何
   使用者資料。掛出來的理由是「自己登記的卡要走校正」這條在 mock 模式下
   沒有素材可以端對端跑（mock 的卡全部是目錄卡），而那正是最容易寫錯、
   錯了又看不出來的一條。有了它，驗收可以拿**真實形狀**的資料直接問
   「這筆會走哪一條」，而不是看畫面猜。 */
if (testMode && typeof window !== 'undefined') {
  ;(window as unknown as { __tcClassify?: unknown }).__tcClassify = classifyCardArt
}

/* ── P3 自拍 ────────────────────────────────────────────────────────── */
const selfie = shallowRef<ImageBitmap | null>(null)
const selfieUrl = ref('')

async function setSelfie(bmp: ImageBitmap) {
  selfie.value?.close()
  selfie.value = bmp
  if (selfieUrl.value) URL.revokeObjectURL(selfieUrl.value)
  selfieUrl.value = URL.createObjectURL(await bitmapToBlob(bmp))
  closeCamera()
}
async function shootSelfie() {
  if (!video.value) return
  try { await setSelfie(await grabFrame(video.value)) } catch { camError.value = cameraMessage('unknown') }
}
async function pickSelfie(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  try { await setSelfie(await bitmapFromFile(f)) } catch { camError.value = '這個檔案讀不成圖片，換一張試試。' }
  ;(e.target as HTMLInputElement).value = ''
}
function retakeSelfie() {
  selfie.value?.close()
  selfie.value = null
  if (selfieUrl.value) URL.revokeObjectURL(selfieUrl.value)
  selfieUrl.value = ''
  startCamera('user')
}

/* ── P4 名字 ────────────────────────────────────────────────────────── */
const trainerName = ref('')

/* ── P5 生成 ────────────────────────────────────────────────────────── */
const budget = new GenerationBudget()
const phase = ref<SwapPhase>('uploading')
const phaseNote = ref('')
const startedAt = ref(0)
const now = ref(0)
const genError = ref<{ code: FaceSwapErrorCode | 'BUDGET' | 'LOCAL'; text: string; canRetry: boolean } | null>(null)
let abort: AbortController | null = null
let ticker: number | undefined

const PHASE_TEXT: Record<SwapPhase, string> = {
  uploading: '正在送出你的自拍',
  queued: '排隊中',
  generating: '正在畫出你的角色',
  downloading: '正在取回圖片'
}

/* 進度條。用「趨近但不到 100%」的曲線，而不是線性倒數：
   真實耗時 20–25 秒是個範圍，線性條會先卡在 100% 再繼續轉，
   那比沒有進度條更傷信任。 */
const progress = computed(() => {
  const t = Math.max(0, now.value - startedAt.value)
  return Math.min(0.97, 1 - Math.exp(-t / (delayMs.value * 0.42)))
})
const elapsedText = computed(() => `${Math.floor((now.value - startedAt.value) / 1000)} 秒`)

/* budget 是一般的 class，Vue 追蹤不到它的私有欄位 —— 直接用 computed 讀它
   不會重算：畫面上的「還可以生成 N 次」會永遠停在 3，額度用完按鈕也不會
   變灰（第一版就是這樣，是 e2e 抓到的，肉眼看不出來）。
   所以這裡放一份反應式的鏡像，每次動到額度就同步一次。
   額度的真相仍然在 budget 裡，這只是投影 —— 擋不擋得住由 budget 決定，
   不是由這個數字決定。 */
const remaining = ref(MAX_USER_GENERATIONS)
function syncBudget() {
  remaining.value = budget.canGenerate ? budget.remainingGenerations : 0
}

/* 額度改成「一次生成 + 一次重來」之後，「還可以生成 2 次」這種說法會讓人以為
   自己有兩次機會慢慢挑 —— 實際上第一次是必然要用掉的。所以直接講規則，
   不講剩餘數字。 */
/* 錯誤訊息要跟「還能不能再試」對得起來。
   額度只有「一次生成 + 一次重來」之後，一個會自動重試的錯誤（NO_IMAGE /
   TIMEOUT / NETWORK）會在**同一次生成裡**把兩次上游呼叫都用掉 ——
   這時候如果還照原本的文案寫「再試一次？」，畫面上卻沒有那顆鈕，
   使用者會以為是按鈕壞了。這種錯是我們自己造成的，話要講清楚。 */
const errorText = computed(() => {
  const e = genError.value
  if (!e) return ''
  if (e.canRetry && remaining.value === 0) {
    return '生成失敗了，自動重試也沒有成功。這一輪的次數用完了 —— 重新整理頁面可以再開始一輪。'
  }
  return e.text
})

const budgetText = computed(() =>
  remaining.value > 1 ? '生成一次；不滿意的話，只能重來一次'
    : remaining.value === 1 ? '還可以重來一次，這是最後一次'
      : '這一輪的生成次數用完了。重新整理頁面可以再開始一輪。')

async function generate() {
  genError.value = null
  const sel = selfie.value
  if (!sel) return
  try {
    budget.beginGeneration()
  } catch (e) {
    genError.value = {
      code: 'BUDGET',
      text: e instanceof BudgetExhaustedError && e.reason === 'user-limit'
        ? `這次已經生成 ${MAX_USER_GENERATIONS} 次了。重新整理頁面可以再開始一輪。`
        : '這次的生成次數已經用完了。重新整理頁面可以再開始一輪。',
      canRetry: false
    }
    syncBudget()
    step.value = 'generating'
    return
  }
  syncBudget()

  step.value = 'generating'
  startedAt.value = performance.now()
  now.value = startedAt.value
  clearInterval(ticker)
  ticker = window.setInterval(() => { now.value = performance.now() }, 200)

  abort = new AbortController()
  const adapter = createStubFaceSwap({
    delayMs: delayMs.value,
    forceError: forceError.value || null,
    failOnce: failOnce.value
  })

  try {
    const selfieBlob = await bitmapToBlob(sel)
    const res = await swapWithRetry(adapter, {
      selfie: selfieBlob,
      templateUrl,
      signal: abort.signal,
      onPhase: (p, hint) => { phase.value = p; phaseNote.value = hint ?? '' }
    }, budget)

    const canvas = await composeTrainerCard({
      character: res.image,
      cardPhoto: cardPhoto.value!,
      cardCorners: corners.value,
      trainerName: trainerName.value
    })
    await publish(canvas)
    step.value = 'result'
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return
    genError.value = describe(e)
  } finally {
    clearInterval(ticker)
    abort = null
    syncBudget()      // 自動重試也會吃上游額度，成功或失敗都要重新對一次
  }
}

/** 規格 §8.2：人話 + 下一步，不露技術細節。 */
function describe(e: unknown): { code: FaceSwapErrorCode | 'BUDGET' | 'LOCAL'; text: string; canRetry: boolean } {
  if (e instanceof BudgetExhaustedError) {
    return { code: 'BUDGET', text: '這次的生成次數已經用完了。重新整理頁面可以再開始一輪。', canRetry: false }
  }
  if (e instanceof FaceSwapError) {
    switch (e.code) {
      case 'RATE_LIMITED':
        /* 429 只給「稍後再試」，**沒有重試鈕**。給了鈕就等於邀請使用者
           連點，那正是限流雪崩的來源（規格 §8.1）。 */
        return { code: e.code, text: '現在使用的人比較多，請稍後再試。', canRetry: false }
      case 'REFUSED':
        return { code: e.code, text: '這張自拍沒辦法用，換一張正面、光線清楚的再試試。', canRetry: false }
      case 'NO_IMAGE_RETURNED':
      case 'TIMEOUT':
      case 'NETWORK':
        return { code: e.code, text: '生成失敗了，再試一次？', canRetry: true }
      default:
        return { code: e.code, text: '出了點狀況，再試一次？', canRetry: true }
    }
  }
  return { code: 'LOCAL', text: '合成的時候出了狀況，再試一次？', canRetry: true }
}

function cancelGenerating() {
  abort?.abort()
  clearInterval(ticker)
  step.value = 'name'
}

/* ── P6 成品 ────────────────────────────────────────────────────────── */
const resultUrl = ref('')
const resultFile = shallowRef<File | null>(null)
const saveNote = ref('')

/**
 * 成品一畫完就立刻備好 File。
 * 規格 §10.2：iOS 對 navigator.share 有使用者手勢限制 —— 按鈕的 handler 裡
 * 先 await toBlob 再 share，手勢已經過期，分享會被靜默擋掉。
 */
async function publish(canvas: HTMLCanvasElement) {
  const blob = await canvasToBlob(canvas)
  if (resultUrl.value) URL.revokeObjectURL(resultUrl.value)
  resultUrl.value = URL.createObjectURL(blob)
  resultFile.value = makeFile(blob, 'trainer-card.png')
}

async function save() {
  const f = resultFile.value
  if (!f) return
  saveNote.value = ''
  try {
    const how = await saveOrShare(f, 'trainer-card.png')
    if (how === 'shared') saveNote.value = '已送出到系統分享，選「儲存影像」就會進相簿。'
    else if (how === 'downloaded') saveNote.value = '已下載。手機上請到「檔案」或瀏覽器的下載項目裡找。'
  } catch {
    saveNote.value = '存檔沒有成功，長按圖片也可以儲存。'
  }
}

/* ── 導覽 ───────────────────────────────────────────────────────────── */
const consented = ref(false)

/* P2 不再一進來就開相機：現在的主路徑是「從卡冊挑」，那條路一張照片都不用拍。
   進頁面就要相機權限，會讓多數人在還沒看到自己要挑什麼之前先遇到一個系統對話框。 */
function goCard() { closeCamera(); step.value = 'card' }
function goSelfie() { step.value = 'selfie'; if (!selfie.value) startCamera('user') }
function goName() { closeCamera(); step.value = 'name' }
function backTo(s: Step) {
  closeCamera()
  step.value = s
  if (s === 'selfie' && !selfie.value) startCamera('user')
}

onBeforeUnmount(() => {
  abort?.abort()
  clearInterval(ticker)
  closeCamera()
  cardPhoto.value?.close()
  selfie.value?.close()
  for (const u of [previewUrl.value, selfieUrl.value, resultUrl.value]) if (u) URL.revokeObjectURL(u)
})

/** 同意書要不要提「照片會離開裝置」，由 adapter 自己回報，不寫死在文案裡。 */
const probeAdapter = createStubFaceSwap({ delayMs: 0 })
const sendsOffDevice = probeAdapter.sendsSelfieOffDevice
</script>

<template>
  <div class="page tc">
    <!-- 每一步用 key 換掉整塊 DOM + CSS animation 進場。
         刻意不用 <transition mode="out-in">：頁面未合成時離場動畫依賴的
         rAF 會停，元件會卡在 leave-from（規格 §10.4）。 -->
    <div :key="step" class="slab">

      <!-- ── P1 開場 + 隱私同意 ─────────────────────────────────── -->
      <section v-if="step === 'consent'" class="pane">
        <p class="eyebrow">訓練家卡</p>
        <h1>把你的卡，做成一張訓練家卡</h1>
        <p class="lead">
          拍一張你自己的卡，再拍一張自拍。
          系統會產生一張「角色化的你，手上舉著那張卡」的直式卡片，可以直接存進相簿。
        </p>

        <div class="notice">
          <h2>開始之前</h2>
          <ul>
            <li><strong>卡面是照片原樣貼上的</strong>，不會經過 AI 重畫，圖案與文字都不會被改。</li>
            <li v-if="sendsOffDevice">
              <strong>你的自拍會離開這台裝置</strong>：它會被送到我們合作的 AI 供應商，
              用來畫出角色的臉。我們自己不保存任何照片，但這一次傳送是真的發生的。
            </li>
            <li v-else>
              目前的版本<strong>不會把任何照片送出這台裝置</strong>：
              角色圖是固定的樣板，合成全部在你的瀏覽器裡完成。
            </li>
            <li>
              照片與成品<strong>只存在於瀏覽器記憶體</strong>，我們沒有保存。
              也因為這樣，<strong>離開或重新整理頁面之後就無法復原</strong>。
            </li>
          </ul>
        </div>

        <label class="agree">
          <input v-model="consented" type="checkbox" />
          <span>我了解上面這些，並同意開始。</span>
        </label>

        <button class="btn primary" type="button" :disabled="!consented" @click="goCard">
          開始
        </button>
      </section>

      <!-- ── P2 從卡冊挑一張（必要時才校正）───────────────────── -->
      <section
        v-else-if="step === 'card'" class="pane"
        :data-card-source="cardSource?.kind ?? ''"
        :data-rectify="cardSource ? String(cardSource.rectify) : ''"
      >
        <p class="eyebrow">第 1 步／共 4 步</p>

        <!-- ① 還沒挑：列出卡冊 -->
        <template v-if="!cardPhoto">
          <h1>挑一張你的卡</h1>
          <p class="lead">從你的卡冊挑一張，它會被原樣貼進成品，不會經過 AI 重畫。</p>

          <p v-if="cardError" class="warn" role="alert">{{ cardError }}</p>
          <p v-if="cardBusy" class="hint" role="status">正在讀那張卡的圖…</p>

          <CardbookPicker @pick="onPickFromCardbook" />

          <!-- 次要入口。預設收起來，展開才開相機 —— 理由見 script 裡那一段 -->
          <details class="alt">
            <summary>卡冊裡沒有？用一張還沒登記的卡</summary>
            <p class="hint">
              這條路要自己拍，而且拍完得把四個角對到卡片上 —— 從卡冊挑不用做這件事。
            </p>
            <div v-if="stream" class="viewport">
              <video ref="video" class="cam" playsinline muted autoplay />
              <div class="guide card-guide" aria-hidden="true" />
            </div>
            <p v-if="camError" class="warn" role="alert">{{ camError }}</p>
            <div class="row">
              <button
                v-if="!stream" class="btn ghost" type="button" :disabled="camBusy"
                data-testid="open-camera" @click="startCamera('environment')"
              >開啟相機</button>
              <button
                v-else class="btn primary" type="button" :disabled="camBusy" @click="shootCard"
              >拍照</button>
              <label class="btn ghost file">
                從相簿選一張
                <input type="file" accept="image/*" data-testid="card-file" @change="pickCard" />
              </label>
            </div>
          </details>
        </template>

        <!-- ② 挑到了、而且要校正：四角編輯器 -->
        <template v-else-if="needsRectify">
          <h1>把四個角對到卡片上</h1>
          <p class="lead">
            這是一張拍出來的照片，會有梯形變形。把四個紅點拖到卡片的四個角 ——
            右邊小圖就是最後會貼上去的樣子。
          </p>
          <div class="editor">
            <QuadEditor v-model="corners" :photo="cardPhoto" class="ed" />
            <figure class="rectified">
              <img v-if="previewUrl" :src="previewUrl" alt="校正後的卡片預覽" />
              <figcaption>校正後</figcaption>
            </figure>
          </div>
          <div class="row">
            <button class="btn ghost" type="button" data-testid="repick" @click="repickCard">換一張</button>
            <button class="btn primary" type="button" @click="goSelfie">用這張</button>
          </div>
        </template>

        <!-- ③ 挑到了、不用校正：直接看成果就好 -->
        <template v-else>
          <h1>就用這張？</h1>
          <p class="lead">
            這是目錄裡的官方卡面，本來就是正的 ——
            <strong>不用對四個角</strong>，直接貼進成品。
          </p>
          <figure class="picked">
            <img :src="cardSource!.url" :alt="pickedPrize?.card.name ?? '你挑的卡'" data-testid="picked-card" />
            <figcaption v-if="pickedPrize">{{ pickedPrize.card.name }}</figcaption>
          </figure>
          <div class="row">
            <button class="btn ghost" type="button" data-testid="repick" @click="repickCard">換一張</button>
            <button class="btn primary" type="button" @click="goSelfie">用這張</button>
          </div>
        </template>
      </section>

      <!-- ── P3 自拍 ────────────────────────────────────────────── -->
      <section v-else-if="step === 'selfie'" class="pane">
        <p class="eyebrow">第 2 步／共 4 步</p>
        <h1>拍一張自拍</h1>

        <template v-if="!selfie">
          <p class="lead">把臉對進橢圓框裡，找一個光線平均的地方，正面看鏡頭。</p>
          <div class="viewport">
            <video ref="video" class="cam mirror" playsinline muted autoplay />
            <div class="guide face-guide" aria-hidden="true" />
          </div>
          <p v-if="camError" class="warn" role="alert">{{ camError }}</p>
          <div class="row">
            <button class="btn primary" type="button" :disabled="!stream || camBusy" @click="shootSelfie">
              拍照
            </button>
            <label class="btn ghost file">
              從相簿選一張
              <input type="file" accept="image/*" data-testid="selfie-file" @change="pickSelfie" />
            </label>
          </div>
        </template>

        <template v-else>
          <p class="lead">這張可以嗎？角色的臉會照著它來畫。</p>
          <div class="viewport still">
            <img :src="selfieUrl" alt="你剛拍的自拍" />
            <div class="guide face-guide" aria-hidden="true" />
          </div>
          <div class="row">
            <button class="btn ghost" type="button" @click="retakeSelfie">重拍</button>
            <button class="btn primary" type="button" @click="goName">用這張</button>
          </div>
        </template>

        <button class="link" type="button" @click="backTo('card')">上一步</button>
      </section>

      <!-- ── P4 名字 ────────────────────────────────────────────── -->
      <section v-else-if="step === 'name'" class="pane">
        <p class="eyebrow">第 3 步／共 4 步</p>
        <h1>你的訓練家名字</h1>
        <p class="lead">會印在卡片下方的名牌上。留白的話會寫「無名訓練家」。</p>
        <input
          v-model="trainerName" class="field" type="text" maxlength="12"
          placeholder="最多 12 個字" data-testid="name-input"
          autocomplete="off" enterkeyhint="done"
        />
        <p class="hint" data-testid="budget-text">{{ budgetText }}</p>
        <div class="row">
          <button class="btn ghost" type="button" @click="backTo('selfie')">上一步</button>
          <button class="btn primary" type="button" :disabled="!selfie || !cardPhoto" @click="generate">
            開始生成
          </button>
        </div>

        <details v-if="testMode" class="test">
          <summary>測試面板</summary>
          <label>強制錯誤
            <select v-model="forceError" data-testid="force-error">
              <option value="">（不強制）</option>
              <option value="NO_IMAGE_RETURNED">NO_IMAGE_RETURNED（自動重試 1 次）</option>
              <option value="TIMEOUT">TIMEOUT（自動重試 1 次）</option>
              <option value="NETWORK">NETWORK（自動重試 1 次）</option>
              <option value="RATE_LIMITED">RATE_LIMITED（不重試）</option>
              <option value="REFUSED">REFUSED（不重試）</option>
            </select>
          </label>
          <label><input v-model="failOnce" type="checkbox" data-testid="fail-once" /> 只失敗第一次</label>
          <label>延遲 ms
            <input v-model.number="delayMs" type="number" min="0" step="100" data-testid="delay-ms" />
          </label>
        </details>
      </section>

      <!-- ── P5 生成中 ──────────────────────────────────────────── -->
      <section v-else-if="step === 'generating'" class="pane center">
        <template v-if="!genError">
          <p class="eyebrow">第 4 步／共 4 步</p>
          <h1>正在做你的卡</h1>
          <!-- 20 秒的凝視撐不住一個轉圈。給三樣東西：進度、現在在做什麼、
               已經過了多久 —— 最後那個是「它沒當掉」最直接的證據。 -->
          <div class="bar" role="progressbar" :aria-valuenow="Math.round(progress * 100)"
               aria-valuemin="0" aria-valuemax="100">
            <i :style="{ width: `${progress * 100}%` }" />
          </div>
          <p class="phase" data-testid="phase">
            {{ PHASE_TEXT[phase] }}<span v-if="phaseNote">（{{ phaseNote }}）</span>
          </p>
          <p class="hint">已經過 {{ elapsedText }}，通常要 20 到 25 秒</p>
          <ul class="waitlist">
            <li>你拍的卡是原樣貼上去的，不會被重畫</li>
            <li>做好之後記得存起來，離開頁面就沒了</li>
          </ul>
          <button class="link" type="button" @click="cancelGenerating">取消</button>
        </template>

        <template v-else>
          <h1 data-testid="gen-error">{{ errorText }}</h1>
          <p v-if="genError.canRetry" class="hint" data-testid="budget-text">{{ budgetText }}</p>
          <div class="row">
            <button
              v-if="genError.canRetry && remaining > 0"
              class="btn primary" type="button" data-testid="retry" @click="generate"
            >再試一次</button>
            <button class="btn ghost" type="button" @click="step = 'name'">回上一步</button>
          </div>
        </template>
      </section>

      <!-- ── P6 成品 + 分享 ─────────────────────────────────────── -->
      <section v-else-if="step === 'result'" class="pane center">
        <p class="eyebrow">完成</p>
        <figure class="result">
          <!--
            **長按這張圖要能叫出系統的「加入照片」**，那是使用者指定的存法。
            所以這張 <img> 不可以繼承任何 user-select / -webkit-touch-callout
            的觸控防呆（規格 §10.7 要求整頁加那些，但加在成品圖上就等於把
            長按選單關掉），也不可以被任何裝飾層蓋住。
            兩件事都在樣式那邊明確寫死，並由驗收腳本用
            getComputedStyle + elementFromPoint 檢查。
          -->
          <img v-if="resultUrl" :src="resultUrl" alt="你的訓練家卡" data-testid="result-image" />
        </figure>

        <!-- 規格 §5 C-3：連帶提示義務。這段不是可有可無的裝飾。
             第二句是使用者指定的存法，跟第一句連著讀：先講會不見，再講怎麼存。 -->
        <p class="warn strong" role="status">
          請先存起來。這張圖只在這個頁面裡，<strong>離開或重新整理之後就無法復原</strong>。
          用下面的按鈕存，或是<strong>長按上面那張圖</strong>，選「加入照片」／「儲存影像」。
        </p>
        <p v-if="saveNote" class="hint">{{ saveNote }}</p>
      </section>
    </div>

    <!--
      成品頁的主要動作放進站上既有的 BottomActionBar。

      **為什麼不是把按鈕留在頁面裡再加 padding**：讓位（--nav-total）只保護
      「文件的最末端」，保護不到捲動途中的任何一幀。實測（scripts/bottom-nav/
      occlusion.mjs）375×812 在**使用者剛做完卡落地的 scrollY = 0 那一幀**，
      「儲存到相簿」的中心點 (188,740) 打到的是底部導覽那顆凸起的球
      （rect.pb-top），點下去會跳到 /play —— 而規格 §5 C-3 說成品只在記憶體裡，
      離開頁面圖就永久消失。

      BottomActionBar 的 bottom 是 `gap + max(--nav-total, --safe-b)`、z-index 65
      （導覽列是 60），所以它**在任何捲動位置**都在球的上面、也在球的外面。
      這一條讀過那支元件才決定用它：它 Teleport 到 body（祖先的 transform 不會
      變成定位基準）、讓位補在文件最末端、進出動畫用 keyframes 不欠幀 ——
      三件事都正是這一頁需要的，一個字都不用改它。
    -->
    <BottomActionBar :open="step === 'result'" label="成品操作" :spacer="150" :max-width="560">
      <div class="resultBar">
        <button class="btn primary" type="button" :disabled="!resultFile" data-testid="save" @click="save">
          儲存到相簿
        </button>
        <div class="row">
          <button
            class="btn ghost" type="button" :disabled="remaining === 0"
            data-testid="regenerate" @click="generate"
          >{{ remaining > 0 ? '重來一次' : '不能再重來' }}</button>
          <button class="btn ghost" type="button" data-testid="recard" @click="repickCard(); backTo('card')">
            換一張卡
          </button>
        </div>
      </div>
    </BottomActionBar>
  </div>
</template>

<style scoped>
/* ── 舞台等比縮放（規格 §6.3）────────────────────────────────────────
   規格原文有一個自相矛盾：它說字級與熱區的下限「只在舞台寬 ≥540px 時
   成立」，但 §11 的驗收要求 iPhone SE（375px）文字不擠壓。
   375 / 540 = 0.69 —— 照原式子寫，13px 的說明字在 SE 上會變成 9px，
   必然不過。

   修法：--u 只負責**版面尺寸**（間距、圖框），而且自己帶一個下限；
   **字級一律走 max(絕對值, 相對值)**，縮不到看不懂的程度。
   這樣寬螢幕仍然等比放大，窄螢幕則退回可讀的絕對下限。 */
.tc {
  --stage-w: min(100vw, calc(100dvh * 9 / 16));
  --u-raw: calc(var(--stage-w) / 540);
  --u: max(var(--u-raw), 0.78px);      /* 版面用，有下限 */

  max-width: 560px;
  margin: 0 auto;
  padding: calc(20 * var(--u)) 16px calc(60 * var(--u));
  min-width: 0;
  overscroll-behavior: contain;
}

.slab { animation: rise .22s ease both; }
@keyframes rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .slab { animation: none; }
}

.pane { display: flex; flex-direction: column; gap: calc(14 * var(--u)); min-width: 0; }
.pane.center { align-items: stretch; text-align: center; }

/* .eyebrow 是 base.css 的全域類別（強調色藥丸）。沿用它的樣式是刻意的
   —— 這一頁的步驟指示跟站上其他地方的小標是同一種東西。
   但 .pane 是 flex column、預設 stretch，藥丸會被拉成整條橫幅；
   align-self 收回內容寬度就好，不要在這裡重畫一顆。 */
.eyebrow { margin: 0; align-self: flex-start; }
.pane.center .eyebrow { align-self: center; }
h1 { margin: 0; font-size: max(21px, calc(30 * var(--u))); line-height: 1.25; }
h2 { margin: 0 0 6px; font-size: max(14px, calc(16 * var(--u))); }
.lead { margin: 0; color: var(--muted); line-height: 1.75; font-size: max(13px, calc(14 * var(--u))); }
.hint { margin: 0; color: var(--faint); font-size: max(12px, calc(13 * var(--u))); }

.notice {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); padding: calc(16 * var(--u));
}
.notice ul { margin: 0; padding-left: 1.15em; display: grid; gap: 8px; }
.notice li { color: var(--muted); line-height: 1.7; font-size: max(12.5px, calc(13.5 * var(--u))); }
.notice strong { color: var(--text); }

.agree {
  display: flex; gap: 10px; align-items: flex-start;
  min-height: 44px; padding: 8px 2px;
  font-size: max(13px, calc(14 * var(--u))); line-height: 1.6;
  user-select: none; -webkit-user-select: none; touch-action: manipulation;
}
.agree input { width: 22px; height: 22px; margin-top: 1px; accent-color: var(--accent); flex: none; }

/* 影像舞台。用 flex 而不是 grid + place-items + max-height:100%
   —— 後者的百分比解析不了，容器會溢出（規格 §10.4）。 */
.viewport {
  position: relative; display: flex; justify-content: center;
  width: 100%; aspect-ratio: 3 / 4;
  background: var(--field); border: 1px solid var(--line);
  border-radius: var(--radius); overflow: hidden;
}
.viewport.still { aspect-ratio: auto; }
.cam, .viewport img { width: 100%; height: 100%; object-fit: cover; display: block; }
.viewport.still img { height: auto; object-fit: contain; }
.cam.mirror { transform: scaleX(-1); }

.guide { position: absolute; inset: 0; pointer-events: none; }
.card-guide::after {
  content: ''; position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  height: 78%; aspect-ratio: 63 / 88;
  border: 2px dashed rgba(244, 241, 238, .75); border-radius: 8px;
}
.face-guide::after {
  content: ''; position: absolute; top: 46%; left: 50%;
  transform: translate(-50%, -50%);
  height: 62%; aspect-ratio: 3 / 4;
  border: 2px dashed rgba(244, 241, 238, .75); border-radius: 50%;
}

.editor { display: flex; gap: calc(12 * var(--u)); align-items: flex-start; min-width: 0; }
.ed { flex: 1 1 auto; min-width: 0; }
.rectified { flex: 0 0 auto; width: 30%; max-width: 132px; margin: 0; text-align: center; }
.rectified img {
  width: 100%; height: auto; display: block;
  border-radius: 10px; border: 1px solid var(--line); background: var(--field);
}
.rectified figcaption { margin-top: 6px; color: var(--faint); font-size: max(11px, calc(12 * var(--u))); }

.row { display: flex; gap: 10px; }
.row.wrap { flex-wrap: wrap; }
.row > * { flex: 1 1 0; min-width: 0; }

.btn {
  min-height: 48px; padding: 12px 18px;
  border-radius: var(--pill); border: 1px solid transparent;
  font-size: max(14px, calc(15 * var(--u))); font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
  user-select: none; -webkit-user-select: none;
  -webkit-touch-callout: none; touch-action: manipulation;
}
.btn.primary { background: var(--accent); color: var(--on-accent); }
.btn.primary:disabled { background: var(--surface-3); color: var(--faint); cursor: not-allowed; }
.btn.ghost { background: var(--surface-2); color: var(--text); border-color: var(--line); }
.btn.ghost:disabled { color: var(--faint); cursor: not-allowed; }
.btn.file { position: relative; overflow: hidden; }
.btn.file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }

.link {
  align-self: center; min-height: 44px; padding: 10px 16px;
  background: none; border: 0; color: var(--muted);
  font-size: max(13px, calc(14 * var(--u))); cursor: pointer;
  text-decoration: underline; touch-action: manipulation;
}

.field {
  width: 100%; min-height: 52px; padding: 12px 16px;
  background: var(--field); color: var(--text);
  border: 1px solid var(--line); border-radius: var(--radius);
  font-size: max(16px, calc(17 * var(--u)));   /* 16px 以下 iOS 會自動放大整頁 */
}
.field:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.warn {
  margin: 0; color: var(--warn-ink); line-height: 1.7;
  font-size: max(12.5px, calc(13.5 * var(--u)));
}
.warn.strong {
  background: var(--warn-wash); border: 1px solid var(--line);
  border-radius: var(--radius); padding: calc(14 * var(--u));
  text-align: left;
}
.warn strong { color: var(--text); }

.bar {
  height: 8px; border-radius: var(--pill); overflow: hidden;
  background: var(--surface-3);
}
.bar i { display: block; height: 100%; background: var(--accent); transition: width .25s linear; }
.phase { margin: 0; font-size: max(14px, calc(16 * var(--u))); }
.waitlist {
  margin: calc(8 * var(--u)) 0 0; padding: 0; list-style: none;
  display: grid; gap: 6px; text-align: left;
}
.waitlist li {
  color: var(--faint); line-height: 1.65;
  font-size: max(12px, calc(13 * var(--u)));
  padding-left: 14px; position: relative;
}
.waitlist li::before {
  content: ''; position: absolute; left: 0; top: .62em;
  width: 5px; height: 5px; border-radius: 50%; background: var(--line);
}

/* ── 成品圖：長按存圖必須能用 ───────────────────────────────────────
   使用者指定的存法就是「常壓另存圖片」。要成立有三個條件，這裡逐一保證：

   ① 不可以關掉系統的長按選單。`.btn` 為了防誤觸有
      `user-select: none` + `-webkit-touch-callout: none`，那組屬性**會繼承**，
      而 iOS Safari 只要看到 `-webkit-touch-callout: none` 就不再彈出
      「加入照片／儲存影像」。所以這裡把兩個都明確寫回 auto/default，
      而不是「沒有寫就等於預設」—— 沒有寫的話，哪天有人在 .page 或 .pane
      上加一條全域防呆，這張圖會靜靜地失去長按存圖，而且看不出來。
   ② 圖上不可以蓋東西。<figure> 只負責置中，沒有 ::before/::after、沒有漸層、
      沒有任何絕對定位的裝飾層；主要動作也搬去 BottomActionBar 了。
   ③ 圖的中心點要在畫面上、而且不能落在那條操作列底下。這一條由版面保證，
      並由驗收腳本用 elementFromPoint(圖片中心) 檢查回傳的就是這張 <img>。

   ①②③ 都在 scripts/trainer-card/e2e.mjs 裡有對應的檢查。
   **真機（iOS Safari）對 blob: URL 的長按行為沒有驗到** —— 見交付說明。 */
.result { margin: 0; display: flex; justify-content: center; }
.result img {
  width: auto; max-width: min(100%, 380px); height: auto; display: block;
  /* 高度收在 44dvh：不收的話成品圖會把「離開就沒了 + 可以長按存圖」那一段
     推到操作列底下，而 scrollY = 0 正是使用者落地的那一幀 —— 他最需要看到
     那兩句的時候恰好看不到。圖小一點不影響長按存圖（存下來的是原生
     1696×2528，不是畫面上這一份）。 */
  max-height: 44dvh; object-fit: contain;
  border-radius: var(--radius); box-shadow: var(--shadow);
  user-select: auto; -webkit-user-select: auto;
  -webkit-touch-callout: default;
  touch-action: auto;
  pointer-events: auto;
}

/* 挑到目錄卡之後的確認圖。跟 .result 分開：這張只是預覽，不需要長按存圖 */
.picked { margin: 0; display: grid; gap: 8px; justify-items: center; }
.picked img {
  width: auto; max-width: min(100%, 240px); height: auto; display: block;
  border-radius: 10px; border: 1px solid var(--line); background: var(--field);
}
.picked figcaption { color: var(--muted); font-size: max(12px, calc(13 * var(--u))); }

/* 次要入口（用一張還沒登記的卡）。收起來時只是一行字，不搶主路徑 */
.alt {
  background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 12px; padding: 10px 12px;
  display: grid; gap: 10px;
}
.alt summary {
  cursor: pointer; min-height: 24px; padding: 10px 0;
  color: var(--muted); font-size: max(13px, calc(14 * var(--u)));
  touch-action: manipulation;
}
.alt[open] summary { margin-bottom: 2px; }

/* BottomActionBar 的內容。主要動作獨立一行、佔滿寬度 —— 它是這一頁唯一
   「按錯就永久失去成品」的按鈕，不該跟其他兩顆並排讓拇指去分辨。 */
.resultBar { display: grid; gap: 8px; }

.test {
  margin-top: calc(10 * var(--u)); padding: 12px;
  background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px;
  font-size: 12px; text-align: left;
}
.test summary { cursor: pointer; min-height: 24px; color: var(--muted); }
.test label { display: flex; gap: 8px; align-items: center; margin-top: 10px; color: var(--muted); }
.test select, .test input[type="number"] {
  flex: 1; min-height: 34px; background: var(--field); color: var(--text);
  border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; font-size: 12px;
}
</style>
