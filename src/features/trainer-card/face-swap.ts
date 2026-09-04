/**
 * 換臉 adapter（規格 §7.4：模型呼叫必須包成獨立檔案，換供應商只改這裡）。
 *
 * ── 這一輪的狀態 ──────────────────────────────────────────────────────
 * **沒有接任何 AI。** 這個檔案定義的是介面與錯誤面；預設實作
 * `createStubFaceSwap()` 直接回傳樣板原圖，並可以強制觸發每一種錯誤。
 * 真 API 到位時要改的東西全部列在檔尾的「接真 API 清單」。
 *
 * ── 隱私邊界（重要，不是註解裝飾）────────────────────────────────────
 * **這是整個功能裡唯一會把使用者的個人資料送出裝置的地方。**
 * 卡片照從頭到尾只在瀏覽器記憶體；但自拍會被送到第三方模型供應商。
 * 規格 §5 C-2 說的「後端不儲存任何圖片」對我們的後端是真的，
 * 但只講那半句就是告知不實 —— P1 的同意書必須據實說出自拍會離開裝置。
 * `FaceSwapAdapter.sendsSelfieOffDevice` 就是給 UI 讀的那個事實，
 * 同意書文案綁在它上面，換 adapter 時文案不會忘了跟著改。
 *
 * 這個檔案裡**不可以**出現 console.log(selfie)、把圖塞進網址、
 * 或送進任何分析事件。
 */

/** 規格 §8.1 列的四種狀況，加上兩個一定會遇到但規格沒列的。 */
export type FaceSwapErrorCode =
  /** 模型沒回圖。實測約 1/10。可自動重試一次。 */
  | 'NO_IMAGE_RETURNED'
  /** 網路逾時。可自動重試。 */
  | 'TIMEOUT'
  /** 網路斷線 / DNS / CORS。可自動重試。 */
  | 'NETWORK'
  /** HTTP 429 限流。**絕對不可自動重試**，否則造成限流雪崩。 */
  | 'RATE_LIMITED'
  /** 模型拒絕（安全政策）。重試沒有意義，同一張自拍會一直被拒。 */
  | 'REFUSED'
  /** 其他。保守起見不自動重試。 */
  | 'UNKNOWN'

export class FaceSwapError extends Error {
  readonly code: FaceSwapErrorCode
  constructor(code: FaceSwapErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'FaceSwapError'
    this.code = code
  }
}

/**
 * 哪些錯誤可以自動重試。
 *
 * **RATE_LIMITED 不在這裡，而且永遠不可以加進來。**（規格 §8.1 的警告：
 * 前專案就是把 429 加進自動重試集合，造成限流雪崩。）
 * REFUSED 也不在：同一張自拍再送一次還是會被同一條政策擋掉，
 * 重試只是多付一次錢。
 */
const AUTO_RETRYABLE: ReadonlySet<FaceSwapErrorCode> =
  new Set<FaceSwapErrorCode>(['NO_IMAGE_RETURNED', 'TIMEOUT', 'NETWORK'])

export function isAutoRetryable(e: unknown): boolean {
  return e instanceof FaceSwapError && AUTO_RETRYABLE.has(e.code)
}

/** 生成過程的階段，給 P5 的等待畫面用。 */
export type SwapPhase = 'uploading' | 'queued' | 'generating' | 'downloading'

export interface FaceSwapRequest {
  /** 使用者自拍。**會離開裝置。** */
  selfie: Blob
  /** 樣板圖的網址（同源資產）。供應商需要它當構圖參考。 */
  templateUrl: string
  signal?: AbortSignal
  onPhase?: (phase: SwapPhase, hint?: string) => void
}

export interface FaceSwapResult {
  /** 角色圖。尺寸必須與樣板一致，否則 coords.json 的四角會對不上。 */
  image: Blob
  /** 哪一個實作產生的。放進成品的 debug 資訊用，不對使用者顯示。 */
  provider: string
}

export interface FaceSwapAdapter {
  readonly id: string
  /**
   * 這個實作會不會把自拍送出使用者的裝置。
   * P1 同意書的文案直接讀這個值決定要不要出現「照片會送到第三方」那一段 ——
   * 之後換成真 API 時只要 adapter 誠實回報，同意書就自動跟著對。
   */
  readonly sendsSelfieOffDevice: boolean
  swap(req: FaceSwapRequest): Promise<FaceSwapResult>
}

/* ────────────────────────────────────────────────────────────────────
   成本護欄（規格 §9 第三層：前端重試上限）
   ──────────────────────────────────────────────────────────────────── */

/** 每個 session 最多幾次**使用者主動**的生成：首次 + 重新生成 2 次。 */
export const MAX_USER_GENERATIONS = 3

/**
 * 每個 session 最多幾次**實際打到上游**的呼叫。
 *
 * 規格 §9 只寫了「每 session 最多 3 次生成」，沒有定義自動重試算不算。
 * 沒定義的話，3 次生成 × (1 次 + 1 次自動重試) = 6 次付費呼叫，
 * 成本是預期的兩倍。這裡的決定是：
 *
 *   1. **自動重試不吃使用者的 3 次額度。** 模型沒回圖是我們這邊的問題，
 *      不該讓使用者少一次機會 —— 那會變成「越常壞、能試的次數越少」。
 *   2. **但整個 session 的上游呼叫另外有一道硬上限 4 次。**
 *      這樣最壞情況是 4 次付費呼叫（約 NT$13），不是 6 次。
 *      4 = 3 次正常生成 + 1 次自動重試的預算；實測 NO_IMAGE_RETURNED
 *      約 1/10，三次生成裡出現兩次以上的機率約 3%，撞到上限的人極少，
 *      而撞到的那個人看到的是「請稍後再試」而不是一張帳單。
 *
 * 這兩條都在 `GenerationBudget` 裡強制執行，UI 不需要自己記。
 */
export const MAX_UPSTREAM_CALLS = 4

export class BudgetExhaustedError extends Error {
  readonly reason: 'user-limit' | 'upstream-limit'
  constructor(reason: 'user-limit' | 'upstream-limit') {
    super(reason)
    this.name = 'BudgetExhaustedError'
    this.reason = reason
  }
}

export class GenerationBudget {
  private userGenerations = 0
  private upstreamCalls = 0

  get usedGenerations() { return this.userGenerations }
  get remainingGenerations() { return Math.max(0, MAX_USER_GENERATIONS - this.userGenerations) }
  get usedUpstreamCalls() { return this.upstreamCalls }
  get canGenerate() {
    return this.userGenerations < MAX_USER_GENERATIONS && this.upstreamCalls < MAX_UPSTREAM_CALLS
  }

  /** 開始一次使用者主動的生成。額度用完就丟，呼叫端不需要自己檢查。 */
  beginGeneration() {
    if (this.userGenerations >= MAX_USER_GENERATIONS) throw new BudgetExhaustedError('user-limit')
    if (this.upstreamCalls >= MAX_UPSTREAM_CALLS) throw new BudgetExhaustedError('upstream-limit')
    this.userGenerations++
  }

  /** 每一次真的要打上游之前呼叫（含自動重試）。 */
  spendUpstreamCall() {
    if (this.upstreamCalls >= MAX_UPSTREAM_CALLS) throw new BudgetExhaustedError('upstream-limit')
    this.upstreamCalls++
  }
}

/**
 * 帶自動重試的呼叫。
 *
 * 只重試 AUTO_RETRYABLE 裡的錯，只重試一次（規格 §8.1）。
 * 每一次嘗試都會先跟 budget 要一張上游額度 —— 所以硬上限是真的硬的，
 * 不是靠呼叫端自律。
 */
export async function swapWithRetry(
  adapter: FaceSwapAdapter,
  req: FaceSwapRequest,
  budget: GenerationBudget
): Promise<FaceSwapResult> {
  budget.spendUpstreamCall()
  try {
    return await adapter.swap(req)
  } catch (e) {
    if (!isAutoRetryable(e)) throw e
    // 這裡不做指數退避：可重試的兩種錯都不是「上游過載」，
    // 而 429（真的過載）根本不會走到這一行。等待只會讓使用者多盯 20 秒。
    req.onPhase?.('queued', '再試一次')
    budget.spendUpstreamCall()
    return await adapter.swap(req)
  }
}

/* ────────────────────────────────────────────────────────────────────
   這一輪的實作：stub
   ──────────────────────────────────────────────────────────────────── */

export interface StubOptions {
  /**
   * 模擬的生成耗時（毫秒）。預設 20000 —— 規格 §3 說真實耗時約 20–25 秒。
   * **刻意保留這個延遲**：等待畫面撐不撐得住 20 秒的凝視，是這一頁真正
   * 的設計風險，把 stub 做成瞬回等於永遠測不到它。
   */
  delayMs?: number
  /** 強制觸發某一種錯誤。開發與驗收用，UI 上有隱藏的測試面板。 */
  forceError?: FaceSwapErrorCode | null
  /**
   * 只讓第一次失敗（之後成功）。用來驗「自動重試一次之後成功」那條路徑。
   */
  failOnce?: boolean
}

export function createStubFaceSwap(opts: StubOptions = {}): FaceSwapAdapter {
  const { delayMs = 20_000, forceError = null, failOnce = false } = opts
  let calls = 0

  return {
    id: 'stub-passthrough',
    /* stub 不送任何東西出去。同意書會據此少一段 —— 這是刻意的：
       上線接真 API 時這個值變成 true，文案自動補回來。 */
    sendsSelfieOffDevice: false,

    async swap(req: FaceSwapRequest): Promise<FaceSwapResult> {
      calls++
      const shouldFail = forceError !== null && (!failOnce || calls === 1)

      /* 分段推進，讓 P5 有真的東西可以顯示。用 setTimeout 而不是一次睡到底，
         是為了 AbortSignal 能在中途生效（使用者按上一步就該立刻停）。 */
      const steps: [SwapPhase, number][] = [
        ['uploading', 0.08], ['queued', 0.18], ['generating', 0.62], ['downloading', 0.12]
      ]
      for (const [phase, frac] of steps) {
        req.onPhase?.(phase)
        await sleep(delayMs * frac, req.signal)
        // 錯誤在「生成」階段丟，跟真 API 的時序一致：
        // 限流與逾時都不會等到下載階段才出現
        if (shouldFail && phase === 'generating') throw new FaceSwapError(forceError!)
      }

      /* 這一輪的「換臉」＝原樣回傳樣板。合成管線收到的東西的形狀
         （同尺寸的一張圖）跟真 API 完全一樣，所以之後換掉這裡，
         compose.ts 一行都不用動。 */
      const res = await fetch(req.templateUrl, { signal: req.signal })
      if (!res.ok) throw new FaceSwapError('NETWORK', `樣板載入失敗 ${res.status}`)
      return { image: await res.blob(), provider: 'stub-passthrough' }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })
}

/* ════════════════════════════════════════════════════════════════════
   接真 API 時要改的東西（只有這個檔案 + 一個環境變數）

   1. 在這個檔案新增 createGeminiFaceSwap()，實作同一個 FaceSwapAdapter：
        - sendsSelfieOffDevice: true          ← 同意書文案會自動補上那一段
        - swap() 內 POST 到我方的 Function（**絕不可以直接打 Google，
          金鑰不能進前端**；規格 §7.2）
        - 把 HTTP 狀態碼翻成 FaceSwapErrorCode：
            429           → 'RATE_LIMITED'    （永遠不自動重試）
            408 / abort   → 'TIMEOUT'
            200 但沒有圖  → 'NO_IMAGE_RETURNED'
            400 安全拒絕  → 'REFUSED'
            其他 5xx      → 'UNKNOWN'
        - 回傳的圖**必須跟 template.jpg 同尺寸**（1696×2528），
          否則 coords.json 的四角會整組偏掉。收到不同尺寸就當 UNKNOWN。

   2. TrainerCardPage.vue 裡 `createAdapter()` 那一處改成依環境變數選實作。
      環境變數（vite 只會注入 VITE_ 前綴的）：
        VITE_TRAINER_CARD_API   我方 Function 的網址，例如
                                https://<pages-project>.pages.dev/api/trainer-card/swap
      **金鑰不放這裡。** 金鑰只放 Cloudflare Pages 的 secret，名稱建議
        GEMINI_API_KEY_TRAINER_CARD   （§7.2：必須是專案專用的新金鑰，
                                       不可共用既有專案的預算）

   3. vite.config.ts 的 cspPlugin：connect-src 要加上那個 Function 的網域。
      **這一輪刻意沒改** —— 目前沒有任何跨網域請求，先加等於先開一個洞。

   4. 後端 Function（本輪不碰）：限流檢查必須放在「參數驗證之後、
      呼叫 AI 之前」（規格 §9 的警告），否則三次驗證失敗就吃光配額。

   5. P1 同意書：不需要改文案，它讀的是 adapter.sendsSelfieOffDevice。
      但**要重讀一次**確認那段話描述的第三方跟實際供應商一致。
   ════════════════════════════════════════════════════════════════════ */
