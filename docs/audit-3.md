# 第三輪隱藏性問題稽核

日期：2026-08-27
範圍：最近大改的區域 —— `pool-settlement.ts`、`pools-service.ts`、`routes/pools.ts`、
`routes/orders.ts`、`shared/escrow.ts`、`preflight.ts`、`rate-limit.ts`、`limits.ts`、
`card-public.ts`、以及這一批新加但還沒 commit 的客服工單／接管／押記／自我檢測。

方法：**唯讀稽核**，沒有改任何程式檔（唯一寫入是本檔）。
能實測的都對著本機 Postgres（新建 `audit3_vaultdraw`，跑過 `migrate` + `seed`）跑過，
`DEV_LOGIN=1 PSA_STUB=1`、PORT 8072。每一條標了 **實測** / **讀碼** / **推論**。

**不重報**已經寫在 `docs/open-issues.md`、`docs/audit-backend-2.md`、`docs/security-audit.md`
的任何一條。下面五條全是那三份文件裡沒有記過的（其中 A-1 把 open-issues 的 V-2
從「推論、未實測」升級成「實測、確認是 bug，而且後果比假設的嚴重」）。

---

## 摘要

| # | 嚴重度 | 驗證 | 問題 |
|---|---|---|---|
| **A-1** | **High** | 實測 | 回收（recycle）遇到 `SELLER_UNFUNDED` 時，**結算列已經被改成 `recycled` 並提交**，但錢沒動、卡還是 `stashed`。賣家的保留額被無償釋放、買家的買回承諾憑空消失、結算列與卡片列永久對不上 |
| **A-2** | **High** | 實測 | 接受交易出價（trade-offer accept）遇到 `INSUFFICIENT_POINTS` 時，**出價已經被改成 `accepted` 並提交**，但沒有過戶、沒有分錄。出價永久卡在 `accepted`，買家被通知「成交」卻什麼都沒拿到 |
| **A-3** | **High** | 實測 | `in_book` 是一個**進得去、出不來**的狀態。接管過戶（`applyTakeover`）與押記卡回庫（`releasePledgedCards`）都會把卡送進 `in_book`，而**沒有任何使用者端點接受這個狀態**：不能上架、不能出貨、不能回收、想重新開池會撞自己那張卡的唯一索引 |
| **A-4** | **Medium** | 實測 | 自我檢測子系統（`monitor.ts` + `routes/monitor.ts`）**整組沒有接線**：路由沒掛、排程沒排。`GET /v1/admin/monitor` 回 404。專門用來抓 A-1 這種「畫面正常、狀態靜默壞掉」的安全網本身沒有在跑 |
| **A-5** | **Low** | 讀碼 | A-1／A-2 的病根是共通的：`sql.begin()` 的 callback **回傳錯誤物件（不是 throw）時交易照樣 COMMIT**。凡是「先改狀態、後檢查、失敗回傳錯誤值」的端點都中招。這是一個 pattern，不是兩個孤立 bug |

A-1、A-2、A-5 是同一件事的三個切面。A-3、A-4 是新功能（押記／接管／自我檢測）落地時互相沒接上。

---

## 逐條

### A-1 回收付不出錢時，結算列被錯誤地關成 `recycled`（High，實測）

**位置**：`server/src/pool-settlement.ts:328-353`（`acceptRecycle`）、
呼叫端 `server/src/routes/prizes.ts:160-225`（recycle 端點）。

**機制**（讀碼）：`acceptRecycle` 的順序是

1. `pool-settlement.ts:331-335`：`update pool_settlements set status = 'recycled' ... returning id` —— **狀態先改了**。
2. `pool-settlement.ts:338-344`：`lockSpender` → `walletOf` → `if (w.available < points) return { ok: false, error: 'SELLER_UNFUNDED' }`。
3. `pool-settlement.ts:346-351`：（只有在上一步沒 return 時才會到）寫兩筆回收分錄、把 `prizes.status` 改成 `recycled`。

當第 2 步的 `available < points` 成立時，函式**回傳一個錯誤物件**。
recycle 端點（`prizes.ts:206-220`）把它當成 tx callback 的正常回傳值往外傳，
於是 `sql.begin` 認定「callback 正常結束」→ **COMMIT**。
第 1 步那個 `update` 就這樣被提交了，而第 3 步的分錄與 `prizes` 更新從來沒發生。

**實測**（腳本 `t1.mjs`）：賣家 `u-poorseller`、票價 50、10 籤全被買家抽走，
保留額 500、可動用 0。LAST 賞買回價 300（> 可動用）。買家按回收：

```
回收前 賣家錢包: {"points":500,"locked":500,"reserved":500,"available":0}
第一次回收: 409 {"error":"SELLER_UNFUNDED",...}
第二次回收: 409 {"error":"WRONG_STATE","message":"這張卡的結算狀態已經改變，不能回收"}
回收後 賣家錢包: {"points":500,"locked":450,"reserved":450,"available":50}
```

資料庫落地（實測）：

```
pool_settlements: st-...-1  status=recycled  closed_by=recycle  amount=50
prizes:           pz-...-1  status=stashed   user_id=u-buyer
points_ledger（reason like 'pool-recycle%'）: 0 筆
```

**後果**：

1. **結算列與卡片列永久不一致**：結算是 `recycled`，卡片是 `stashed`。這正是
   `monitor.ts` 的 `checkSettlementPrizeSync` 要抓的那一類（`recycled` 對不上）——
   但那支沒有在跑（見 A-4）。
2. **賣家的保留額被無償釋放**：`reserved` 從 500 掉到 450（那筆結算離開了保留狀態），
   賣家的 `available` 因此多了 50 —— 一筆本來要等交付／鑑賞期才釋放的票金，
   在「一筆失敗的回收」之後被提早放出來，賣家沒有交付任何東西。
3. **買家的買回承諾消失**：第二次按回收得到 `WRONG_STATE`（結算已 `recycled`），
   卡冊那一列的 buyback 也不再顯示（`prizes.ts:69` 的 `case when st.status in ('held','awaiting_ship')`）。
   買家永遠回收不了這張卡了，即使賣家之後有錢。

**沒有印鈔**（實測）：`GET /v1/admin/reconcile` 的 `drift` 仍是 0 ——
沒有寫任何分錄，所以全站總量不變。傷害是狀態機被關進死角、承諾被吃掉、保留額被錯放，
不是憑空造錢。

**觸發條件不算邊角**：只要「單張買回價 > 賣家當下可動用」。新賣家一個池、
資金全在保留額、買家回收高買回價的 LAST／A 賞 —— 這正是會發生的情況。

**與 open-issues 的關係**：open-issues 第九節 V-2 把這條列為
「`SELLER_UNFUNDED` 的拒絕路徑，未實測 / 推論」，並假設它只是乾淨地拒絕。
本輪實測證明它**不是**乾淨拒絕，而是提交了一半的狀態變更。V-2 應該從「推論」升級成
「實測、確認 bug」，嚴重度往上。

**修法方向**（不在本輪動手）：`acceptRecycle` 在 `SELLER_UNFUNDED` 時要讓交易**回滾**——
最小改動是呼叫端在收到 `SELLER_UNFUNDED` 時 `throw`（比照 `routes/pools.ts:608` 的 `Rollback`
手法），或把狀態 `update` 移到資金檢查**之後**。

---

### A-2 接受出價付不出錢時，出價被錯誤地關成 `accepted`（High，實測）

**位置**：`server/src/routes/social.ts:249-320`（`/trade-offers/:id/accept`）。
關鍵行：`social.ts:277` 先 `update trade_offers set status = 'accepted'`，
`social.ts:280-281` 才 `if (w.available < price) return INSUFFICIENT_POINTS`。

**機制**（讀碼）：跟 A-1 同一個病根（A-5）。註解（`social.ts:270-276`）解釋
「必須先把出價移出 pending 再算餘額」是對的 —— 但當餘額不足而 `return` 錯誤物件時，
`sql.begin` 照樣 COMMIT，出價就停在 `accepted`，而過戶（`social.ts:285` 的 `update prizes`）
與分錄（`:282-284`）都在檢查之後，一行都沒跑。

**實測**（腳本 `t2b.mjs` + `t2c.mjs`）：`u-poorbuyer` 有 1000 點，對 `pz-t2-card` 出價 900（成立），
之後餘額被抽走到 200（模擬出價後花掉），卡主接受：

```
accept: 409 {"error":"INSUFFICIENT_POINTS","message":"對方的可動用點數已經不足，無法成交"}
trade_offers: to-83f49d348839  status=accepted  points=900
prizes:       pz-t2-card       user_id=u-cardowner  status=stashed
points_ledger where ref_id=offer: 0 筆
```

**後果**：

1. **出價永久卡在 `accepted`**：重按接受會被 `o.status !== 'pending'` 擋掉（`social.ts` 接受端點開頭）。
   這筆出價再也不能成交，卻在雙方的列表上顯示為「已接受／成交」。
2. **買家被誤導**：買家的 outgoing 出價列表會顯示 `accepted`。實際上他沒被扣款、也沒拿到卡
   （成交通知 `social.ts` 尾段那句「你的出價成交了」是在檢查之後才發，所以沒發）——
   但列表狀態本身就是一句謊。
3. **卡沒有被鎖死**（唯一的好消息）：同卡其他 pending 出價的作廢（`social.ts` 的 `dropped` update）
   在資金檢查**之後**，所以沒跑到 —— 卡主仍可接受別人的出價。所以這條不會卡住卡，
   但會留一筆死掉的假成交。

**沒有印鈔**（實測，同 A-1）：沒有分錄，`drift` 不變。

**修法方向**：同 A-1 —— 資金不足時要 `throw` 讓交易回滾。

---

### A-3 `in_book` 是進得去、出不來的狀態（High，實測）

**位置**：
- 寫進 `in_book` 的兩個入口：`pools-service.ts:492`（`releasePledgedCards`，池揭曉時把沒被抽走的押記卡回庫）、
  `tickets.ts:362`（`applyTakeover`，客服核准站外轉手接管）。
- 讀 `in_book` 的地方：**沒有**。使用者端每一個「拿卡去做事」的端點都只認 `stashed`（或 `shipped`）：
  - 上架 `routes/public.ts:295`：`pz.status === 'stashed' ? 'vault' : pz.status === 'shipped' ? 'ship' : null` → `in_book` 落到 null → `WRONG_STATE`。
  - 出貨 `routes/prizes.ts:287`：`... and status = 'stashed'`。
  - 回收 `routes/prizes.ts:168`：`if (p.status !== 'stashed')`。
  - 公開卡冊 `routes/social.ts:93`/`:106`：查詢只 `where status in ('stashed','listed')` —— `in_book` 連顯示都沒有。

**實測**（腳本 `t3c.mjs`／`t3d.mjs`，卡 `pz-strand-1`，`in_book`，PSA 編號 `STUB-OK-025`）：

```
上架 in_book:  409 {"error":"WRONG_STATE","message":"這張卡目前不能上架"}
出貨 in_book:  409 {"error":"WRONG_STATE","message":"有卡片不在保管中，無法出貨"}
回收 in_book:  409 {"error":"WRONG_STATE","message":"只有保管中的卡可以回收"}
重新開池(同cert): 409 {"error":"CERT_ALREADY_LISTED",
   "message":"這個鑑定編號已經登記在系統裡了 …… 如果這張卡是你的而且已經不在別處，請聯絡客服。"}
我的卡冊含 in_book? true 狀態= in_book
```

**後果**：任何走到 `in_book` 的卡，對它的擁有者來說是一張**看得到、動不了**的卡：

- **接管的情境最嚴重**：整個接管功能的目的就是「把站外買到的卡收進系統、之後能用」。
  但 `applyTakeover` 交付的是 `in_book` —— 接管人拿到一張既不能上架、不能出貨、
  也不能重新開池的卡。功能把卡交出去了，卻沒有給出口。
- **押記回庫的情境**：賣家開池押了一張鑑定卡、沒被抽走、池揭曉後回到 `in_book`。
  他想重新拿它開池會撞上 `prizes_cert_alive`（因為那張 `in_book` 卡自己還佔著編號），
  得到的訊息是「請聯絡客服」——**針對他自己閒置在卡冊裡的卡**。他也不能上架它。

**設計意圖對不上實作**：`migrations/021_inventory_first.sql:99`
明寫 `in_book` = 「閒置在卡冊：可以上架、可以進池、可以刪」，
`tickets.ts:320` 的註解也說 `in_book` 是「可以上架也可以進池」。
但那些「可以」的端點（inventory-first 規劃的上傳／從卡冊進池，plan 第四節）還沒做 ——
現在只有寫入 `in_book` 的路，沒有讀它的路。

**修法方向**：在 inventory-first 後續端點落地之前，至少讓上架與開池接受 `in_book`
（上架時當成 `vault` 交付；開池時對「押的是自己名下同一張 `in_book` 卡」做過戶而不是新 insert，
比照 `pools-service.ts:309-326` 抽卡對 `in_pool` 卡的過戶手法）。

---

### A-4 自我檢測子系統整組沒有接線（Medium，實測）

**位置**：`server/src/monitor.ts`（`runMonitor` / `monitorSweep` / `alertFindings`）、
`server/src/routes/monitor.ts`（`GET /v1/admin/monitor`、`POST /v1/admin/monitor/run`）。

**機制**（讀碼 + 實測）：

- `server/src/index.ts` 的 import 清單（`index.ts:11-30`）**沒有** import `monitor` 路由，
  掛載區（`index.ts:127-165` 一帶的 `app.route(...)`）也**沒有** `app.route('/v1/admin/monitor', monitor)`。
- 五分鐘的 `setInterval`（`index.ts:169` 起）排了 `sweep` / `sweepStashExpiry` / `sweepPools` /
  `sweepSettlementsAll` / `sweepAttempts`，**沒有** `monitorSweep`。
- `monitor_state` 表（migration 025）唯一的寫入者是 `checkLedgerDrift`，而那支永遠不被呼叫。
- `regress-monitor.ts` 不在 `server/package.json` 的 scripts 裡，也沒有任何地方跑它。

**實測**：`GET /v1/admin/monitor`（帶 admin token）回 `404 Not Found`（server log 實錄）。

**後果**：這個子系統是專門為了抓「畫面正常、狀態靜默壞掉」而寫的
（`monitor.ts` 檔頭點名 F-1／F-3／021 索引蓋不到新卡）。A-1 產生的
`recycled` 對不上 `stashed`，正好落在 `checkSettlementPrizeSync` 的網裡 ——
但網沒有架起來。所以 A-1 + A-4 是**複合**的：偵測器存在，卻沒有在執行。

**判斷這是「還沒接線」而不是「刻意不開」**：`routes/monitor.ts` 自己的檔頭說
「獨立成一個檔案而不是塞進 admin.ts，因為 admin.ts 正在被客服工單那條工作線擴充，
兩邊同時改會互相蓋掉」—— 也就是它預期之後要被掛上去，只是這一批還沒掛。
（推論：不是安全問題，因為端點根本不存在、掃描也沒跑，沒有任何東西被暴露；純粹是功能沒生效。）

**修法方向**：`index.ts` import 並 `app.route('/v1/admin/monitor', monitor)`，
在 `setInterval` 裡加一條 `monitorSweep().catch(...)`（頻率可以比五分鐘低，例如每小時）。

---

### A-5 病根：`sql.begin` 的 callback 回錯誤值時交易照樣 COMMIT（Low，讀碼）

**位置**：`server/src/db.ts`（用的是 `postgres` 套件原生的 `sql.begin`，沒有自訂包裝）。

**機制**（讀碼）：postgres.js 的 `sql.begin(cb)` 只在 callback **throw** 時 ROLLBACK；
callback 正常 resolve（包含 `return { error: ... }`）一律 COMMIT。
這個 repo 大量使用「tx callback 回一個 `{ error, message, status }` 物件、外層判 `'error' in r`」
的模式。**只要在回這個錯誤物件之前已經寫過任何一句 `update`/`insert`，那句就會被提交。**

安全的端點是靠**在任何寫入之前**就回錯誤（例如 `routes/orders.ts` 的 `act()`：
所有 `isParty` / `actionsFor` / `apply` 檢查都在 `save`/`settle` 之前），
或靠 `throw`（`routes/pools.ts:608` 的 `Rollback` class、draw 端點）。

**中招的是「先寫、後檢查、回錯誤值」的端點**。本輪確認兩個（A-1、A-2）。
**建議一併排查**（推論，未逐一實測）其他 `update ... 之後才有條件式 return { error }` 的地方：

- `routes/pools.ts:568-577`（`/open`）、`routes/social.ts` 的 decline —— 讀碼看起來檢查都在寫入前，應無恙，但值得對照這條規則掃一遍。

這條本身嚴重度低（它是一個 API 使用陷阱，不是單獨的 bug），但它是 A-1／A-2 的共同成因，
修 A-1／A-2 的同時應該把「tx callback 內回錯誤值之前不得有寫入」寫成一條紀律（或加一個
會 throw 的 helper），否則下一個照這個模式寫的端點會再踩一次。

---

## 檢查過而且沒問題

下面這些本輪查過、目前是對的，下一輪可以跳過（除非相關程式碼又動過）。

1. **前後端 shared 規則完全同步**（實測 diff）：`escrow.ts`、`pool-settlement.ts`、
   `fairness.ts`、`economics.ts`、`recycle.ts`、`domain.ts`、`contract.ts` 七支，
   `server/src/shared/` 與 `src/shared/` 除了複製本開頭那 4 行警告 banner 之外**逐字相同**
   （`diff <(tail -n +5 …) …` 全部 0 行差異）。escrow 剛改過「沉默視同送達」，兩邊一致，沒有漂移。

2. **escrow「沉默 14 天視同送達 → 7 天鑑賞期 → 完成」的金流**（實測，`t4.mjs`）：
   下單 → 出貨 → 撥快 15 天 → sweep 到 `delivered` → 再撥快 8 天 → sweep 到 `completed`
   （`closed_by=auto-release`）。分錄剛好一組（`order-pay -3000` / `order-receive +3000`，各 1 筆），
   `reconcile.drift` 全程 0。沒有雙付、沒有印鈔。這條是這一批最重要的規則改動，是對的。

3. **全站鎖序（V-1）在會動 prizes 的路徑上一致**（讀碼）：回收（`prizes.ts:166` 先鎖 prize，
   `:173-177` 再 `for update of st`）、確認收貨（`prizes.ts:243-251`）、賣家出貨
   （`sellers.ts` 先鎖 prize 再 `for update of st`）、逾期掃描（`pool-settlement.ts:426-430`
   兩段式，先鎖 prize 再鎖 settlement）—— 全部是 prize → settlement 的同一方向。沒有找到反向的路徑。
   （open-issues V-1 講的死鎖窗口在這幾條上是收斂的；本輪沒有新增反向路徑。）

4. **抽卡的冪等**（讀碼）：`routes/pools.ts:588-625`，dup 檢查綁 `key + user_id`，
   `idempotency` 的 PK 是 `(user_id, key)`（實測 `\d idempotency`），並發重放同一把 key
   會在 insert 撞 PK → throw → 回滾。安全。

5. **金額上界防 500**（讀碼）：票價 `pools.ts:288-289`（`POINTS_INPUT_MAX`）、
   掛單價 `public.ts` 的 `ListBody`（`POINTS_INPUT_MAX`）、通知 id 陣列
   `social.ts` 的 `NOTIFY_ID_MAX`/`NOTIFY_IDS_MAX` 都補上了。
   open-issues L-1 的「market 那一半」（`routes/public.ts` 的掛單 `price`）本輪讀到**已經補上**了
   `.max(POINTS_INPUT_MAX)`（`ListBody`），跟 open-issues 記的「還沒碰」不同 —— 那條工作線又前進了。

6. **公開回應的 certNo 白名單（L-2）**（讀碼）：`card-public.ts` 的 `publicCard()` 白名單
   已經套在市場（`public.ts` 的 `toListing`、highlights、單筆）與公開卡冊（`social.ts:91`、
   交易出價列表 `social.ts` 的 `strip`）。open-issues L-2 記的「市場那一側還沒套」本輪讀到**已經套上**。

7. **F-4 殭屍出貨的守衛**（讀碼）：後台標出貨（`admin.ts` 的 `/shipments/:id/status`）
   與賣家出貨（`pool-settlement.ts:217-220` 的 `markShipped`）都有 `and status = 'ship_requested'`
   守衛，退款／回收過的卡不會被復活。

8. **新端點的權限**（讀碼）：客服工單使用者端 `tickets.use('*', requireAuth)`；
   客服端在 `admin.ts` 走 `requireAdmin`；接管過戶只在 admin 結案端點呼叫；
   `certHolderOf`（別人的身分）只在 admin 端點回。檔案讀取 `files.ts` 的私有用途
   （含新的 `ticket-doc`）一律「本人或管理員」。沒有找到漏掛 `requireAuth` 或越權讀寫。
   （`routes/monitor.ts` 有 requireAuth + requireAdmin，但它根本沒被掛上，見 A-4。）

9. **押記卡抽中時的過戶併發**（讀碼）：`pools-service.ts:309-326`，押記卡是
   `update prizes ... where id = ... and status = 'in_pool'`，用狀態當守衛，兩人搶同一籤只有一個命中；
   `certNo` 強制 `total <= 1`（`pools.ts:258` 的 `.refine`）保證一張押記卡對一個籤位。沒有 race。

---

## 最該先修的三條

1. **A-1 回收付不出錢時的半提交** —— 會把結算列關進與卡片列不一致的死角、
   無償釋放賣家保留額、吃掉買家的買回承諾。觸發條件（單張買回價 > 賣家可動用）
   在高價池上很正常。修法便宜：資金不足時讓交易回滾（`throw`）。

2. **A-3 `in_book` 出不來** —— 接管功能現在交付的是一張沒人能用的卡，
   押記回庫的賣家也拿不回自己的卡。在 inventory-first 後續端點落地前，
   至少讓上架與開池接受 `in_book`。

3. **A-4 把自我檢測接上線** —— 它是專門抓 A-1 這類靜默狀態損壞的網。
   接一行 `app.route` + 一行 `monitorSweep()` 就會生效，成本極低，而且接上之後
   A-1 造成的 `recycled`/`stashed` 不一致會被 `checkSettlementPrizeSync` 主動報出來。

**一起做**：A-1 與 A-2 是同一個病根（A-5）。修的時候把「tx callback 回錯誤值之前不得有寫入」
定成一條紀律或一個會 throw 的 helper，否則下一個照這個 pattern 寫的端點會再犯。
