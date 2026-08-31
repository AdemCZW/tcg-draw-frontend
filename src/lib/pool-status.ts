/**
 * 池狀態的對外說法 —— 全站唯一一份。
 *
 * ---- 為什麼要有這個檔 ----
 *
 * `PoolStatus` 有四個值（見 types/models.ts），但畫面上長期只有兩種說法：
 * 「抽選中」與「已完抽」，判斷式一律寫成 `status === 'open' ? … : …`。
 * 四個值塞進兩個格子，結果是**兩個明顯錯誤的畫面**：
 *
 *   1. 剛開好的池（committed）被說成「已完抽」。同一行字自相矛盾：
 *      「剩 100 / 100　已完抽」。而後端的 sweepPools 是五分鐘一輪
 *      （要等 drand 的未來輪次才推得動，見 server/src/pools-service.ts），
 *      所以**每一個新池都有最長五分鐘處在這個狀態，而且買家看得到** ——
 *      吃掉的正是開賣頭幾分鐘的曝光。
 *   2. sold_out 與 revealed 都叫「已完抽」。可是「籤抽完了」與
 *      「種子已公開、你可以自己驗算」在使用者眼裡是兩件事，
 *      而中間隔著賣家不能干預的一段等待。
 *
 * 所以四個狀態各自要有自己的字。字只寫在這裡，判斷也只寫在這裡 ——
 * 十個地方各自寫一次 `!== 'open'` 正是上面那兩個 bug 的來源。
 */
import type { Pool, PoolStatus } from '@/types/models'

/**
 * 一個字組的短標籤。用在池卡的角標、詳情頁的狀態列、挑池台的按鈕。
 *
 * committed 選「即將開賣」而不是沿用既有的兩個字，理由是這兩個字都會說謊：
 *   - 「抽選中」→ 現在按下去抽不了，籤位還沒生成（client_seed 未定）
 *   - 「已完抽」→ 一張都還沒抽走，100 籤全在
 * 它真正的意思是「籤序已經封存、等第三方隨機源（drand）的那一輪到期就開賣」。
 * 短標籤只承載「還不能抽，但快了」，完整的因果放在 POOL_STATUS_NOTE。
 *
 * 不用後台那組字（console/shared.ts 的「待開賣」）：後台是給營運看池在哪一格，
 * 買家要的是「我現在能不能抽」。「待」是狀態機的視角，「即將」是等待者的視角。
 *
 * sold_out 維持「已完抽」—— 那正是這三個字的字面意思（籤抽完了），
 * 這也讓公平性頁那句「完抽後公開種子」仍然成立。
 * revealed 改叫「已開獎」：種子公開、任何人都能重算，這是 sold_out 沒有的事。
 */
export const POOL_STATUS_LABEL: Record<PoolStatus, string> = {
  committed: '即將開賣',
  open: '抽選中',
  sold_out: '已完抽',
  revealed: '已開獎'
}

/**
 * 一句話的因果說明。短標籤回答「能不能抽」，這一句回答「為什麼、還要多久」。
 *
 * committed 那句要給得出時間感，否則買家只知道被擋住、不知道要不要等。
 * 「通常五分鐘內」是有依據的上界：後端鎖的是 drand 約兩分鐘後的輪次
 * （FUTURE_ROUNDS = 4 × 30 秒），推進它的掃描是五分鐘一輪。
 * 說「通常」而不是寫死倒數：drand 真的不通時池會停在這裡，
 * 給一個會走完的倒數再讓它走完卻沒開賣，比不給更傷。
 */
export const POOL_STATUS_NOTE: Record<PoolStatus, string> = {
  committed: '籤序已經洗好封存，正在等第三方隨機源（drand）的指定輪次到期。通常五分鐘內開賣，開賣後才能抽。',
  open: '',
  sold_out: '籤已經全部抽完，正在公開這一池的種子。',
  revealed: '種子已公開，任何人都能重算一次籤序、自己驗算這一池。'
}

/** 現在按下去真的抽得到。全站唯一該用 `status === 'open'` 的地方 */
export const isDrawable = (p: Pool) => p.status === 'open'

/** 還沒開賣：籤序封存了，等外部隨機源。買家看得到，但抽不了 */
export const isUpcoming = (p: Pool) => p.status === 'committed'

/**
 * 抽完了（不論種子公開了沒）。
 * 「不能再抽」的判斷用這個，不要寫 `!== 'open'` —— committed 也不是 open，
 * 但它是「還不能抽」不是「不能再抽」，兩者的畫面該完全不同。
 */
export const isFinished = (p: Pool) => p.status === 'sold_out' || p.status === 'revealed'

/** 種子已公開，驗算頁算得動 */
export const isRevealed = (p: Pool) => p.status === 'revealed'
