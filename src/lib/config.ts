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

/**
 * 公平性驗證的「前端入口」開關 —— 暫時的展示閘門，不是功能開關。
 *
 * 為什麼要有它：使用者要求「公平性驗證先收起來，之後再展示」。
 * 收的只是**使用者看得到、點得進去的入口**（頁首、頁尾、我的、池詳情、
 * 開卡結果那幾個連結），不是機制本身。
 *
 * 後端從來沒有停過：commit-reveal、drand 取隨機、開賣前封存籤序、
 * `/reveal` 端點，全部照常運作。那是抽卡的公平性保證，拿掉等於毀掉整個產品的
 * 信任基礎，所以這裡刻意只擋 UI，一行 server 的程式碼都沒動。
 * 承諾雜湊與 client seed 來源也照常揭露在池詳情的「驗證」分頁 ——
 * 收起來的是「幫你算」的那一頁，不是「給你材料」這件事。
 *
 * 怎麼打開：把下面的 false 改成 true，一行，其他地方都吃這個常數。
 * （`/fairness` 與 `/fairness/:poolId` 兩條路由刻意留著沒關，
 *   知道網址的人還是進得去，方便自己驗收；只是站內不再有任何地方連過去。）
 */
export const FAIRNESS_UI = false
