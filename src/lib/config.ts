/**
 * 執行環境設定。
 *
 * MOCK 不再是寫死的常數，由 VITE_API_URL 決定：
 *   沒設 → 全部走 mock（本機開發、設計調校，不需要後端）
 *   有設 → 打真的 API（GitHub Pages 的 build 帶 Railway 的網址）
 *
 * 這樣同一份程式碼兩種模式都能跑，切換是部署設定不是改程式。
 */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
export const MOCK = !API_URL
