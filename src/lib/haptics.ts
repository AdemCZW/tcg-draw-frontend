/**
 * 觸覺回饋。
 *
 * 誠實的限制：navigator.vibrate 在 iOS Safari 完全不支援，Web 沒有任何 API
 * 能碰到 Taptic Engine。所以：
 * - 全部 optional chaining，永遠不會炸
 * - 任何互動的可理解性都不能依賴震動（撕條斷了、球開了，視覺上一定同時有變化）
 * - 使用者可以關（記在 localStorage）
 *
 * 模式命名照「這是什麼事件」不是「震幾毫秒」，接線的地方讀起來才有意義。
 */
type Pattern = 'tap' | 'select' | 'success' | 'warn' | 'burst'

const PATTERNS: Record<Pattern, number | number[]> = {
  tap: 8,                       // 按鈕
  select: 14,                   // 選籤位
  success: [18, 40, 26],        // 開出 A / 最後賞
  warn: [30, 60, 30],           // 爆賞
  burst: [10, 30, 10, 30, 60]   // 球炸開那一拍
}

const KEY = 'vd.haptics'
let enabled: boolean | null = null

export function hapticsEnabled(): boolean {
  if (enabled === null) {
    try { enabled = localStorage.getItem(KEY) !== '0' } catch { enabled = true }
  }
  return enabled
}
export function setHaptics(on: boolean) {
  enabled = on
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* 無痕沒關係 */ }
}
/** 這台裝置到底能不能震（設定頁用來決定要不要顯示開關） */
export const hapticsSupported =
  typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'

export function haptic(p: Pattern) {
  if (!hapticsEnabled()) return
  try { navigator.vibrate?.(PATTERNS[p]) } catch { /* 部分瀏覽器在非手勢情境會丟，吞掉 */ }
}
