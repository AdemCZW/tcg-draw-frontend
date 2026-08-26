# 前端流程完整性體檢（第 2 次）

日期：2026-08-26。範圍：mock 模式（`VITE_API_URL` 未設，vite :5179）走完整互動流程，
另起一份 `VITE_API_URL` 指向死 port 的 build（:5180）驗錯誤狀態。
驗證全程 Playwright headless（chromium headless shell），手機 393×852、桌機 1280×900。
量測方法照 HANDOFF 2.4 逐元素掃（`right>innerWidth+0.5 / left<-0.5 / scrollWidth>clientWidth+1`），
排除該節列出的已知正常項。截圖與量測腳本在 scratchpad `audit2/`。

## 結論先講

核心循環**從頭到尾走得通**：登入 → 挑池 → 選籤（1 抽與 10 抽）→ 開卡演出 → 結果三出口 →
卡冊 → 出貨申請（地址驗證、toast 回饋）→ 回收（確認、入帳）→ 上架（選卡 → 定價頁）。
賣家循環也通：/me 有「我要開池」「出貨與結算」兩個入口；開池表單挑卡、買回價、
即時試算、印鈔機護欄（166.7% 被擋並給出可點的問題清單）、範本帶入都正常；
出貨頁標記出貨後「等你寄出」3→2 正確。未登入 gating 正常（`?redirect=` 記得住、
登入後送回原頁；市場購買鍵變「登入後購買」）。跑版逐元素掃描全路由**沒有真陽性**，
UI 無 emoji。

找到 1 個會讓整頁掛掉的 render 崩潰（已順手修）、2 個 API 模式下的錯誤狀態問題（未修）。

---

## 高：訂單頁 demo 按鈕讓整個訂單列表 render 崩潰 —— 已修

- 頁面：`/me/orders`，按「+ 賣家視角訂單」。
- 症狀：`進行中 1` 但列表整個空白；console 連環
  `TypeError: Cannot read properties of undefined (reading 'match')` 與
  `Cannot set properties of null (setting '__vnode')`；之後連 Demo 時鐘都按了沒反應
  （offset 停在 0）。因為 orders store 會 persist，這個壞掉的訂單**會留在 localStorage**，
  重新整理也一樣崩。
- 成因：`OrdersPage.vue` 的 seed 卡片是 `as any` 拼出來的，缺 `image` 欄位；
  `CardArt.vue` 的 `hue` computed 直接 `props.image.match(...)`，undefined 就丟例外，
  炸掉整個 `v-for` 的 render，Vue 接著 unmount 也壞掉（`__vnode` null）。
- 修法（本次已改，`npm run build` exit 0、重跑流程確認訂單卡渲染、時鐘生效、無 pageerror）：
  1. `src/pages/OrdersPage.vue`：seed 補 `image: ''`。
  2. `src/components/CardArt.vue`：`(props.image || '').match(...)` —— 防的不是這一次，
     是下一個 `as any` 塞進來的資料；也讓已經 persist 壞資料的使用者自己好起來。

## 高：網路一時打不通會被當成「登入失效」（API 模式，未修）

- 重現：`VITE_API_URL` 指向不通的位址，localStorage 帶著 `vd.user` + `vd.token`
  進 `/me/cards`（或任何 requiresAuth 頁）→ 直接看到 Landing 登入頁。
- 成因：`main.ts` 啟動就呼叫 `auth.refresh()`；`refresh()` 的 `catch` 把**任何**失敗
  （包含 `Failed to fetch` 這種網路錯誤）都當 token 失效，清掉 `this.user`。
  註解寫「token 失效：http() 已經清掉 token」，但 `http()` 只在 **401** 清 token ——
  網路錯誤時 token 還在，畫面卻已經把人登出了。Railway 冷啟動或手機訊號差
  的瞬間，使用者會莫名其妙「被登出」，重新整理又回來。
- 建議：`refresh()` 的 catch 裡先看 `token.get()` —— token 還在就保留 user
  （畫面照 localStorage 的快取畫），只有 token 已被 `http()` 清掉（401）才清 user。

## 中：API 掛掉時，大廳／挑池／池詳情把「錯誤」畫成「空」（未修）

死 API 模式逐頁實測：

| 頁 | 看到的畫面 | 問題 |
|---|---|---|
| `/lobby` | 「這個分類目前沒有池。」 | 錯誤被畫成空狀態，使用者以為真的沒池 |
| `/play` | 「目前沒有進行中的抽選池。」 | 同上 |
| `/pools/p1` | 「找不到這個池，可能已下架。」 | 網路錯誤被說成池下架 —— 這句是會傳出去的 |
| `/market` | 「Failed to fetch」＋重新載入鈕 | **行為對**（有錯誤態、能重試），但字樣是英文原文 |
| `/fairness` | 正常（純靜態） | — |

- 成因：`stores/pools.ts` 的 `load()` 只有 `finally` 沒有錯誤狀態，例外一路
  unhandled（console 有 `PAGEERROR: Failed to fetch`），頁面拿到空陣列照畫空狀態。
- 建議：pools store 補一個 `error` 欄位，Lobby／Play／PoolShell 比照 Market
  出「載入失敗＋重試」；Market 的訊息換成中文（`http.ts` 把 `TypeError: Failed to fetch`
  轉成「連不上伺服器，請檢查網路」即可三頁共用）。

## 低（記錄，不一定要動）

- **`/me/cards/sell` 直接進入**（沒有從卡冊帶選取）顯示「沒有可以上架的卡。回卡冊」。
  有卡的人看到這句會以為卡不能上架 —— 實際是「沒有帶選取進來」。文案可改成
  「還沒選要上架的卡，回卡冊挑幾張」。
- **`/fairness/:poolId` 在 mock 模式**：顯示「展示模式沒有連後端，無法取得已公布的 seed」，
  「重新驗算」按了畫面完全不變（沒有 spinner、沒有結果）。mock 限定、有說明文字，
  真後端不受影響；只是「按了沒反應」在展示時容易被當 bug 回報。
- **桌機 header 沒有「出貨與結算」入口**，只能從 /me 進。賣家高頻動作，值得考慮
  跟「開池」並列（手機沒這個問題，/me 兩個入口都在）。
- **`/draw/:id` 重新整理**：sessionStorage 有 stash，reload 畫面還在 ✓；
  未知 id 顯示「沒有可顯示的抽選結果。去抽選」並連回列表 ✓（`/pools` redirect 正常）。
- **選籤頁返回攔截**：`window.confirm`（原生對話框），行為正確；headless 自動 dismiss
  時停在原頁也正確。
- **無入口路由**：`/fx`、`/dev/card-picker`、`/design/pack`、`/design/smoke` 刻意不掛導覽
  （路由註解與 HANDOFF 都有載明），不算死路。其餘路由全部有入口；`/topup`、`/pools`
  舊路徑 redirect 正常；`/admin` 非管理員被彈回 `/lobby` 正常；404 頁正常。

## 量測結果（沒有真陽性）

- **393×852 與 1280×900 全部 22 條路由**逐元素掃描，命中三類、逐一確認皆非跑版：
  1. `button.bell` `sw33>cw30`：徽章 `right:-3px` 疊出去，overflow visible、設計如此。
  2. `/lobby` `.glow`、`/play` `.envCss` 超出視窗：裝飾層，被祖先 `overflow:hidden` 裁掉；
     實測三頁 `document.scrollWidth === 393`，頁面不水平捲。
  3. CardPicker `span.meta`：`text-overflow: ellipsis` 的刻意截斷。
- 開卡結果頁（1 抽與 10 抽演出完）、選籤牆（100 籤）、通知抽屜、出貨 sheet、
  挑卡「已選清單」sheet 另外單掃，0 命中。
- **emoji**：runtime 對每頁 body 文字掃 `\p{Extended_Pictographic}`，0 命中。
  原始碼有 3 處命中，全部在註解（`recycle.ts` ×2、`SellerNewPoolPage.vue` 的 `↔`）。
- console：除上述兩個已列的錯誤外，全流程 0 console error、0 pageerror、0 破圖
  （`naturalWidth === 0`）。

## 最該先修的三條

1. **`auth.refresh()` 把網路錯誤當登入失效**（上面「高」第二條）——
   正式站在 Railway 冷啟動時每個回訪使用者都會撞到，而且看起來像「帳號被登出」。
2. **Lobby／Play／Pool 的錯誤狀態**——斷網被畫成「沒有池」「池已下架」，
   使用者不會想到重新整理，等於死路；照 Market 的樣子補錯誤態＋重試即可。
3. **OrdersPage demo 崩潰**已修，但請 review 這兩行 diff（`OrdersPage.vue`、`CardArt.vue`
   各一行）並自行 commit —— 本次稽核沒有 commit 任何東西。
