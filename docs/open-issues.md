# VaultDraw 未解問題總表

把散在五份稽核報告、HANDOFF、和這一輪程式碼閱讀裡的東西合成一張表。
**只列還沒解決的**；已修的不重複（那些在各自報告裡標了「已修」）。

最後更新：2026-09-03（I-1／I-2／I-3 三條已修並實測；其餘維持 2026-08-27 的第三次查證）

---

## 進度（2026-08-27）

| | 狀態 |
|---|---|
| **第一節 F-1〜F-7** | **全部修完並驗過。** 迴歸測試在 `server/src/regress-f.ts`，32/32；既有 smoke 295/295；對帳 drift = 0。舊碼上跑同一套會失敗 5 條（F-1 完整重現）。含新增 migration 022 |
| 第二節 U-1〜U-5 | 021 已寫並驗過（回填 8/8）。**剩下的卡在資料庫連不到**（X-4） |
| **P-3 DEV_LOGIN** | **防護已加強（2026-09-02）。**正式環境仍應確認關閉，但即使誤設 `DEV_LOGIN=1`，少了 `DEV_LOGIN_SECRET` 服務會拒絕啟動；所有開發端點也要求私密 header。 |
| **P-5 舊 seed 池** | **正式環境實測完畢。**security-audit C-1 的急迫狀態解除（舊池全 revealed），但換來另一個事實：**正式站陳列的 32 個池 100% 是假池**。見第三節 P-1 與 P-5 |
| **P-4 低熵種子閘** | **已加並驗過。** `assertSeedEntropy()` 在 `pools-service.ts:41`，`commitPool()`（`pools-service.ts:159`）與 `seed.ts:461` 兩條寫入路都過閘。實測 `'b1'.repeat(32)` 被擋、`randomBytes(32)` 五次全過 |
| ~~S-1 mode check~~ | **不用做 —— 016 早就修了，是我的清單寫錯。**見第四節的更正 |
| **W-1〜W-3 前端錯誤態** | **已修並驗過。** 斷網時四頁都出中文「連不上伺服器，請檢查網路後重試」＋重試鈕，不再說「池已下架」 |
| **W-4 桌機出貨入口** | **已做，但還沒 commit**（前端 header 工作線正在跑）。`src/components/AppHeader.vue:102-104` |
| **L-1 / L-2 / L-4** | **修正中，全部還沒 commit。**查證途中那條工作線落了地（新增 `server/src/limits.ts`、`server/src/card-public.ts`）。L-4 已改完；**L-1 與 L-2 只做完卡冊那一半，市場那一半（`routes/public.ts`）還沒碰**。見第五節 |
| **全表查證（本輪）** | 逐條重讀程式碼查過第四〜七、九節。**又抓到三條誤記**（M-1 的理由、L-3 與 L-4 的出處），一條要改寫（W-5），一條要重新評估（V-1）。詳見各節 |

> **這一輪為什麼要全表重查**：S-1 被證實是誤記之後，把同樣的懷疑套到整張表。
> 錯法都一樣 —— **從 8/24〜8/26 的稽核報告抄結論與行號，沒有回頭看之後的 commit 有沒有推翻它**。
> 這次每一條都重讀了現在的程式碼；行號一律換成現在的。

> **遷移編號變動**：022 被「出貨義務」用掉了（F-5 需要 `ship_default_at` 欄位），
> 023 給 S-1 的 mode check。所以卡冊優先原本規劃的 022／023／024 順延成
> **024（cert 唯一索引）／025（上池押記與回庫）／026（接管流程）**。
> [inventory-first-plan.md](inventory-first-plan.md) 第八節的編號要照這個讀。

---

## 怎麼讀這張表

`驗證` 欄的意思：

| 記號 | 意思 |
|---|---|
| **實測** | 有人真的重現過，報告裡附了步驟與輸出 |
| **讀碼** | 直接讀程式碼確認的（附檔案行號） |
| **推論** | 只做了程式碼推理，沒有實跑 |
| **待查** | 需要資料庫或外部系統才能確認，目前連不上 |

行號一律是 **2026-08-27 當下的工作樹**（含未 commit 的改動）。
標了「修正中」的表示那條正在被某條工作線改，還沒 commit —— 別當成已解。

---

## 一、會賠錢的（上線前必修）

這一組是唯一「使用者正常操作就會損失點數」的。全部同一個病根：
**`pool_settlements` 綁的是抽卡當下的買家，而卡的所有權會動。**

| # | 問題 | 嚴重度 | 驗證 | 出處 |
|---|---|---|---|---|
| F-1 | 買了市場二手卡按回收，**點數付給前一個主人**。新主人卡沒了、一毛沒拿到，回應還跟他說「points: 72」 | Critical | 實測 | audit-backend-2 |
| F-2 | 轉手後新主人申請出貨、賣家逾期 → **票金退給前一個主人**（他早就賣掉收過一次錢） | Critical | 實測 | audit-backend-2 |
| F-3 | 賣家走 `/v1/seller/settlements/:id/ship` 出貨後不同步 `prizes` 與 `shipments` → 買家不確認的話**卡永遠卡在 `ship_requested`**，上架/回收/確認全 409，而且錯誤訊息是假的（「賣家還沒出貨」） | High | 實測 | audit-backend-2 |
| F-4 | 逾期退款後出貨單還停在 `requested`，後台一按標 `shipped` 會**把已退款的卡復活** → 買家退款照拿、卡照樣再賣一次 | High | 實測 | audit-backend-2 |
| F-5 | 寄存確認期滿之後才申請出貨 → 出貨單進佇列但**沒有任何時鐘**：賣家標不了出貨、逾期不記違約、不會退款。註解宣稱「不出貨照樣記違約」，機制不存在 | Medium | 實測 | audit-backend-2 |
| F-6 | `sweepSettlements(tx, userId)` 只掃 `buyer_id/seller_id = userId`，卡轉手後新主人**永遠掃不到**那筆結算 | Medium | 實測 | audit-backend-2 |
| F-7 | vault-accept 釋放後卡仍 `stashed`，卡冊照樣顯示買回價，按下去回「結算狀態已改變」——看得到按不到的承諾，訊息也沒說原因 | Low | 實測 | audit-backend-2 |

**已定案的修法**（使用者拍板）：
1. 保障跟著卡走 —— 過戶時 `buyer_id` 改成新主人
2. 出貨中的卡（`awaiting_ship` / `shipped`）不能上架轉手

> 這一輪讀碼補一條：修法不該是「同步兩個欄位」，而是**讓結算透過 `prize_id` 讀 `prizes.user_id` 的當下值**。
> `prizes.user_id` 已經就是擁有權而且已經會跟著移轉（`orders.ts:102`、`social.ts:268`、`orders-service.ts:97`）。
> 多維護一份同步等於讓「誰擁有這張卡」有兩個來源，在算錢的系統裡遲早漂移。

---

## 二、一卡多賣的缺口

| # | 問題 | 驗證 | 說明 |
|---|---|---|---|
| U-1 | **池那邊完全沒有資料庫層的編號唯一性** | 讀碼 | 全站只有 `listings_cert_live`（001_init.sql:46），只管市場掛單。同一個編號可以同時放進三個池 |
| U-2 | 唯一索引**少了 grader** | 讀碼 | `on listings(cert_no)` 沒有 grader。PSA #12345678 和 BGS #12345678 是兩張不同的卡，現在會把第二個人誤擋 |
| U-3 | **裸卡完全沒有唯一性防線** | 讀碼 | 沒有編號，索引蓋不到。只有 inventory-first 的結構保證能蓋 |
| U-4 | `seed.ts` 繞過建池 API 直接寫資料庫 | 讀碼 | API 的 `.refine()`（pools.ts:257）確實擋了 `certNo` + `total > 1`，但 seed 不走那條。`public.ts:292` 註解點名的 flareonPSA 就是一個編號開 15 籤 |
| U-5 | 資料庫沒有 `certNo → total = 1` 的約束 | 讀碼 | 任何 admin SQL 都寫得進去 |
| U-6 | **沒有實體入庫流程** | — | `prizes.status = 'stashed'` 是被宣告的，從來沒驗證過。平台不代管實體卡（使用者的決定），所以系統不知道賣家手上有沒有那張卡 |

U-1〜U-5 是 [inventory-first-plan.md](inventory-first-plan.md) 要解的。
**U-6 解不了**，防線是出貨違約累積。

---

## 三、上線前一定要拆的

| # | 問題 | 驗證 | 狀態 |
|---|---|---|---|
| P-1 | **Railway 啟動指令還有 `npm run seed`** —— 每次部署重塞一批假掛單與假池 | 讀碼＋實測 | `server/railway.json` 的 `startCommand`：`npm run migrate && npm run seed && npm start`。**security-audit 把這條標為最高優先，現在還在**。<br>**2026-08-27 補上後果的實際量體**（見 P-5 的實測）：原本寫的是「塞了一些假資料」，實際上是**正式網址上陳列的商品 100% 是假的** —— 公開 API 撈到的 32 個池，`clientSeedSource` 全部以 `fixture:` 開頭，**沒有一個是真實賣家開的**。這不是資料乾淨度問題，是整間店沒有一件真貨 |
| ~~P-2~~ | ~~LINE 登入送 1,000,000 點~~ | 讀碼＋型別檢查 | **已修（2026-09-02）。**移除 `line-signup-bonus` 的帳本貸記與通知；LINE OAuth 現在只負責建立／登入帳號，不再是點數發行入口。既有歷史分錄仍列為對帳發行來源，避免造成假 drift。 |
| P-3 | **`DEV_LOGIN` 每次部署仍應確認正式環境是關的** | 實測＋型別檢查 | **已緩解（2026-09-02）。**2026-08-27 的唯讀實測顯示正式環境端點回 404。現在即使誤設 `DEV_LOGIN=1`，`env.ts` 會要求至少 32 字元的 `DEV_LOGIN_SECRET`，少設即拒絕啟動；所有 `/v1/auth/dev-login` 與 `/v1/dev/*` 另要求 `x-dev-login-secret`。這不取代部署檢查，但已移除「單一旗標誤設就可接管」的風險。 |
| P-4 | ~~**C-1 的低熵種子閘沒有加**~~ **已加**（見上方進度表） | 讀碼 | `assertSeedEntropy()` 定義在 `server/src/pools-service.ts:41`，兩條寫入路都過閘：`commitPool()`（`pools-service.ts:159`）與 `seedPool()`（`seed.ts:461`）。產生端也對了：`seed.ts:456` 是 `randomBytes(32).toString('hex')` |
| P-5 | **正式環境全部 32 個池都是示範池，10 個還在收錢** | 實測 | 從公開 API `GET /v1/pools?limit=100` 撈的，見下方明細。**兩個結論要分開讀**：籤序可算的急迫狀態解除了，但正式站的商品全是假的 |
| P-6 | `public/og.png`（1200×630）還沒放 | — | |

### P-3 的風險為什麼要留在清單裡

那四條端點**完全沒有 `requireAuth`**（`index.ts:43 / 59 / 76 / 92` 一條都沒掛）。
只要 `DEV_LOGIN=1` 被誤設一次，接管鏈是完整的、而且不需要任何既有憑證：

1. `POST /v1/auth/dev-login` 帶 `handle=platform` →
   `ensureUser()`（`server/src/auth.ts:23-34`）算出 `id = 'u-' + handle.toLowerCase()` = `u-platform`，
   `on conflict (handle) do nothing` 表示**已存在就直接回傳既有那個帳號的 id**
2. `u-platform` 就是 `PLATFORM_ID`，而 `seed.ts:569` 把它設成 `role = 'admin'`
3. 後台唯一的權限判斷是 `users.role = 'admin'`（`server/src/routes/admin.ts:22-27`）
4. `POST /v1/admin/grant`（`admin.ts:42`）發點數

**所以這不是「有風險」，是「整個系統被接管」。**
單次上限 100,000,000 點（`admin.ts:39`）不構成防線 —— 可以一直打。

判斷方法（可重複、不改任何東西）：對那四條路 POST 一個不合法 body，
全 404 而 `/health` 200 就是關的；任何一條回 400／200 就是開的。

### P-5 實測明細（2026-08-27，`GET /v1/pools?limit=100`）

32 個池，`clientSeedSource` **全部**以 `fixture:` 開頭 = 全是 `npm run seed` 建的。
狀態分佈：`open` 10、`revealed` 22、`cancelled` 0。

還在 `open`（還在收錢）的 10 個，全部是 `-g2` 世代：

| 池 | 票價 | 剩餘／總數 | commitVersion |
|---|---|---|---|
| `p-seed-1-g2` | 3250 | 100 / 100 | 4 |
| `p-grade10-1-g2` | 3200 | 11 / 20 | 4 |
| `p-vault-1-g2` | 2500 | 23 / 30 | 4 |
| `p-vault-3-g2` | 1900 | 18 / 24 | 4 |
| `p-official-1-g2` | 1280 | 58 / 100 | 4 |
| `p-shop-4-g2` | 700 | 27 / 60 | 4 |
| `p-shop-5-g2` | 550 | 26 / 45 | 4 |
| `p-shop-1-g2` | 350 | 132 / 250 | 4 |
| `p-promo-1-g2` | 250 | 11 / 36 | 2 |
| `p-official-2-g2` | 200 | 139 / 200 | 4 |

**結論一：security-audit C-1 的急迫狀態解除了。**
C-1 講的是「正式環境有 12 個籤序算得出來的池在收錢」——
那批寫死種子的舊池（沒有 `-g2` 字尾、`commitVersion` 1，例如 C-1 點名的 `p-shop-1`、`p-vault-2`）
**18 個全部已經 `revealed`，不再收錢**（實測逐一確認）。
還在收錢的 10 個是換世代之後建的，那時 `seed.ts:456` 已經改用 `randomBytes(32)`，籤序算不出來。

> 附帶更正一個機制認知：舊池不是被 `retireStalePools()`（`seed.ts:619`）收攤的 ——
> 它把符合條件的 `open` 池改成 `cancelled`，但線上 `cancelled` 是 **0**。
> 那 18 個是自己走到 `revealed` 的。收攤機制沒有被驗證過，別當成它生效了。

**結論二：但正式網址上陳列的商品現在 100% 是假的。**
這是 P-1 的具體後果，跟結論一無關、也不會被結論一抵銷。
32 / 32 都是 fixture，沒有一個真實賣家的池 —— 拿這個網址給任何人看，
他看到的整間店都是種子資料。**P-1 的優先度應該往上調，不是往下。**

---

## 四、玩法（標示 vs 實際）

| # | 問題 | 驗證 | 說明 |
|---|---|---|---|
| ~~S-1~~ | ~~資料庫的 check constraint 仍允許五種 mode~~ **這條是我寫錯的，已經修好很久了** | 實測 | **更正（2026-08-27）**：[016_pool_mode_muteki.sql](../server/migrations/016_pool_mode_muteki.sql)（2026-08-24）早就把約束收成 `check (mode in ('muteki'))`，而且順序正確（先鬆綁 → 搬既有 14 筆 classic → 再收緊）。我原本從 pool-modes-audit 抄了 `002_core.sql:85` 就下結論，沒查後面的遷移有沒有改過它。乾淨庫實測：約束是 `CHECK ((mode = 'muteki'::text))`，`update pools set mode='shitei'` 回 `23514` 被擋 |
| S-2 | classic / shitei / streak / auction **後端零實作** | 實測＋讀碼（2026-08-27 重查，仍成立） | `draw()` 從頭到尾沒讀過一次 `pools.mode`。**這輪重查確認得更死**：整支 `server/src/pools-service.ts` 裡 `mode` 只出現一次，而且是 `:289` 的一行註解 —— 抽卡邏輯連讀都沒讀過這個欄位。<br>目前的處置是把 API 鎖成只收 muteki（`server/src/routes/pools.ts:275`，`mode: z.enum(['muteki'])`），不是實作它們。三道鎖齊了：前端、API（`pools.ts:275`）、資料庫 check（016）|
| K-1 | `LAST` 的數量沒有上限 | 讀碼（2026-08-27 重查，仍成立） | 一個池可以開 10 支最後賞。**重查結果：整條建池路上沒有任何一處數過 `LAST`。**<br>`server/src/routes/pools.ts:219` 定義 `TIERS`，但 `PrizeIn` 上**只有一條 `.refine()`**（`pools.ts:257`，管的是 `certNo` + `total > 1`），`CreatePool`（`pools.ts:274-305`）沒有任何跨項驗證，handler（`pools.ts:311` 起）也只檢查賣家資格與額度，沒碰 tier 分佈。<br>muteki 語意下不算錯，但補 classic 時要一起加限制 |

---

## 五、安全（security-audit）

**全部在 2026-08-27 重查過。其中三條的「理由或出處」原本是錯的**（M-1、L-3、L-4）。

> **這一節的狀態有時效性。**查證進行到一半時，L-1 / L-2 / L-4 那條工作線**當場落了地** ——
> 新增了 `server/src/limits.ts` 與 `server/src/card-public.ts`，並改了 `routes/pools.ts`、`routes/social.ts`。
> 下面的 L-1 / L-2 / L-4 標的是**「修正中」**：程式已經改了，但**全部還沒 commit**，
> 而且 L-1 與 L-2 都只做完一半（`routes/public.ts` 還沒被碰，市場那一側仍然漏）。
> **別把「修正中」讀成「已解」** —— 要等那條工作線 commit 且補完 `public.ts` 才算。

| # | 問題 | 嚴重度 | 驗證 | 現況 |
|---|---|---|---|---|
| M-1 | 註冊端點的速率限制**擋不到要擋的東西** | Medium | 讀碼 | **這條的敘述是誤記，結論不變。**原本寫「實際上沒有速率限制」—— 錯的：`server/src/routes/auth.ts:41-48` 註冊時**確實**有 `checkLimit(['ip:' + clientIp(c)])` 並回 429。<br>真正的破口是**計數只在失敗時累加**：`bumpFail(regKeys)` 只出現在 EMAIL_TAKEN 的 `catch` 裡（`auth.ts:65`），**成功註冊那條路（`auth.ts:68`）完全不計數**。所以「用不同 email 大量灌帳號」永遠觸發不了限制，被擋住的只有「一直拿同一個已註冊 email 去試」—— 剛好是最沒有攻擊價值的那種。<br>兩個附帶弱點：① `clientIp()`（`server/src/rate-limit.ts:28-33`）取 `x-forwarded-for` 的**第一段**，那是呼叫端可以自己填的，換一個值就換一個桶；② 註冊跟登入共用同一個 `ip:` 桶（`MAX_FAILS_IP = 40`，`rate-limit.ts:23`），所以登入打錯幾十次會連帶把註冊鎖住。<br>計數存 Postgres（`rate-limit.ts:41-72`）這點是對的，重新部署不會歸零 |
| ~~M-2~~ | **已加 CSP（2026-08-27）。** meta 版，build 時依環境變數生成（`vite.config.ts` 的 `cspPlugin`）。`script-src 'self'` 沒有 unsafe-inline —— 為此移除了 index.html 的 GA 片段（掛的是佔位 ID `G-XXXXXXX`，每次載入都真的去打 googletagmanager 卻收不到任何資料）與字體的 inline `onload`（搬進 `main.ts`）。**已知缺口：`frame-ancestors` 在 meta CSP 裡會被瀏覽器忽略**，所以防點擊劫持在換到能設 HTTP 標頭的主機之前做不到。`style-src` 仍需 `'unsafe-inline'`（執行期的動態 `:style` 綁定，風險遠低於腳本）。驗證：建置產物實跑 8 條路由，0 CSP 違規、43 張卡圖 0 破圖、0 console 錯誤 |
| L-1 | 金額欄位沒有上界，塞大數字會 500 | Low | 讀碼 | **修正中（做完一半，未 commit）。**原本「金額欄位沒有上界」是以偏概全 —— 大多數欄位早就有界：`refPrice`（`routes/pools.ts:217` `REF_PRICE_MAX`，套用在 `:234`）、買回價（`pools.ts:222-224`，常數在 `shared/pool-settlement.ts:81-82`）、後台發點數（`routes/admin.ts:39`）、交易邀約（`routes/social.ts:140`）。<br>**本輪落地**：新增 `server/src/limits.ts`（`POINTS_INPUT_MAX = 1_000_000_000`，`:41`），票價已補上界（`pools.ts:288-289`）。<br>**還沒補的一個，而且正是 500 的那一個**：市場掛單價 `price`（`routes/public.ts:235` 仍只有 `.int().positive()`，欄位 `bigint`／`001_init.sql:35`）。上架的 `catch`（`public.ts:302-303`）只放行 `23505`，其餘原樣往上丟 → Postgres 的數值溢位變成沒人接的例外，落到 Hono 預設 500。`public.ts` 目前不在 `git diff` 裡 |
| L-2 | **公開 API 回傳 `certNo`** —— 跟第二節直接相關：編號公開等於把「可以拿去別處登記的東西」送出去 | Low | 讀碼 | **修正中（做完一半，未 commit）。**範圍比原本寫的大：不只公開卡冊，市場也漏。<br>**本輪落地**：新增 `server/src/card-public.ts` —— 走**白名單**而不是刪 `certNo`（因為 `card` 是 jsonb 且建池端用 `.passthrough()`，黑名單一定會漏掉未來新增的欄位）。已套用在公開卡冊 `GET /cardbook/:slug`（`routes/social.ts:91`）與 `social.ts:226`。<br>**市場那一側還沒套**：`toListing()`（`routes/public.ts:154-155`）仍然回傳整包 `card`，供 `public.ts:182`、`:207`、`:225-232` 三條公開端點使用；`public.ts:199-201` 還提供一個以 `cert_no is not null` 篩出來的「已鑑定」貨架。`public.ts` 不在 `git diff` 裡 |
| L-3 | 出貨憑證收任意外部 URL | Low | 讀碼 | **仍成立，但原本寫的出處是錯的。**不在 `sellers.ts`／`prizes.ts`：實際位置是 `server/src/routes/orders.ts:180-184` 的 `photoUrls: z.array(z.string().url()).min(1, ...)` —— **任何 scheme、任何 host 都收，沒有白名單、沒有長度上限、沒有陣列數量上限**，原樣寫進 `orders.ship_photos`（`orders.ts:209-210`）。<br>**第一方的路已經蓋好但沒有被強制走**：`server/src/routes/files.ts:29-38` 定義了 `'ship-photo'` 用途（含 MIME 與大小規則、R2 presign），但 `/ship` 從來不要求那裡發出來的 file id。<br>另兩條出貨路是乾淨的：`sellers.ts:144-166` 的 `ShipOne` 根本不收照片（只收 `carrier` / `tracking`，且 `tracking` 有 `validateTracking`），`prizes.ts` 沒有憑證欄位。`009_ship_evidence.sql:11-16` 的 `ship_photos jsonb` 也沒有任何約束 |
| L-4 | 上游錯誤訊息直接透給呼叫端 | Low | 讀碼 | **修正中（已改完，未 commit）。原本寫的出處是錯的。**<br>**出處更正**：不在 `psa.ts`／`r2.ts` —— 那兩支反而一直是乾淨的（`psa.ts` 只 `console.warn/error`，對外只回固定的 `ok/reason`；`r2.ts:20`、`:50-55` 直接吞掉錯誤）。`psa.ts` 與 `routes/psa.ts` 之後已整組刪除，見 X-1。真正外洩的是 `routes/pools.ts` 的三個 `catch`，都是 `message: e instanceof Error ? e.message : '…'`，會把 drand 的上游狀態原文（`pools-service.ts:88`、`:99`）與內部狀態字串（如 `pool is draft, not committed`）轉給呼叫端。<br>**本輪落地**：那三處全部改成「只進 log、對外回固定中文訊息」（`pools.ts:505-509`、`:526-529`、`:625-628`）。全檔已經 grep 不到 `e.message` 外送。<br>順帶查到一件好事：`index.ts` **沒有** `app.onError`，所以未捕捉的例外只會落到 Hono 的通用 500，不會外洩 |
| ~~L-5~~ | ~~LINE 的 JWT 走 URL fragment 回前端~~ | 讀碼＋前後端建置 | **已修（2026-09-02）。**callback 現在只帶一把 256-bit、5 分鐘有效、只能使用一次的 code；資料庫只保存 SHA-256 雜湊，`POST /v1/auth/line/exchange` 以原子 `DELETE ... RETURNING` 交換 JWT。前端先清掉 fragment 才呼叫交換端點。帳號綁定也改為受 Authorization header 保護的 `POST /v1/auth/line/link/start`，不再把既有 JWT 放進 query。 |
| M-3 | `refPrice` 同時是護欄分母與回收分子 | ~~Medium~~ | — | **已解**（migration 018 把回收換成宣告買回價） |

### 2026-09-03 補充核對：身分、公開端點與裸卡庫存

以下是依當前工作樹重新讀碼的結果；這段優先修正「舊稽核結論仍被當成現況」的問題。

| # | 問題 | 嚴重度 | 驗證 | 現況與建議 |
|---|---|---|---|---|
| ~~A-1 第一階段~~ | ~~帳號沒有全裝置登出／JWT 撤銷路徑~~ **已修並有回歸測試（2026-09-03）** | 讀碼＋回歸檔 | 已新增 `users.session_version`（033）；JWT 帶 `sv`，`requireAuth` 每次比對 DB；改密碼會遞增版本並回發當前裝置的新 token，`POST /v1/auth/logout-all` 可撤銷所有 token。`regress-session.ts` 覆蓋改密碼撤銷、保留當前裝置／不保留、舊 token 相容與並發。 |
| A-1b | 忘記密碼尚無安全的交付管道 | 產品決策 | 讀碼（2026-09-03） | `session_version` 已處理 token 撤銷，卻不會讓忘記密碼者取得新憑證。必須先決定 Email 寄信服務或已綁定的 LINE 作為安全交付通道；目前不能只新增 reset endpoint 卻沒有安全送出 token 的方式。測試期可用人工帳號恢復工單，但會員編號不能當身分驗證因子。 |
| ~~A-2~~ | ~~卡冊登記／鑑定編號宣告沒有獨立速率限制~~ **已修並有回歸測試（2026-09-03）** | 讀碼＋回歸檔 | `/cardbook/upload` 已使用獨立的 `card-upload-user:<userId>` 與 `card-upload-ip:<ip>` bucket，成功登記也會計數；不與登入失敗共用，且不把無法防止首次搶註的 per-cert 限流當作防線。`regress-ratelimit.ts` 覆蓋上限、`Retry-After`、NAT／帳號隔離與跨桶不互相封鎖。 |
| A-3 | 公開賣家列表是逐位賣家序列查詢 | Medium | 讀碼（2026-09-03） | `routes/public.ts` 的 `/sellers` 先撈全部賣家，再 `await sellerView()`；每一位會進行多次統計查詢。賣家數增加後會有 N+1 延遲，並長時間占用 Railway 的連線池。<br>**修法**：先加 cursor/limit（預設 20、上限 100）；將賣家資料、池／訂單／抽卡統計改成批次聚合查詢，近期期獎項也批次查；公開統計可快取 30–60 秒。 |
| ~~A-4~~ | ~~裸卡沒有完整的「一張實體卡一列」庫存防線~~ **已修並有回歸測試（2026-09-04）** | 實測 | `prizeId` 現為建池必填：交易內 `for update` 鎖卡冊那一列、只收自己的 `in_book`、轉 `in_pool` 並寫 `pool_prizes.card_id`。**改前重現**：同一張裸卡連開五個池，五次全部 HTTP 200，卡冊裡 `in_pool` 的列數 0（十五個籤位承諾同一張實體卡）；**改後**五次全部 400 `PRIZE_ID_REQUIRED`。卡片身分改以卡冊那一列為準，不採用呼叫端送的 `card` jsonb（否則可押普卡、在 manifest 宣告成噴火龍）。`total > 1` 的語意換位置：一列 `total = 10` 變成十列各押一張實體卡。鎖序照 `d5c8bd3` 先整批鎖完再做事，12 輪 × 4 筆並行建池 `deadlocks` 增量 0。**既有資料刻意不回填**（同 032／034 的尺）：回填等於系統代替賣家宣告「這張實體卡在你手上」（U-6 唯一不能自我宣告的事），且會把已發生的一卡多池洗白 —— 036 之前建的池有沒有一卡多池，事後查不出來。`regress-inventory.ts` 48 條；smoke 413／0（斷言名稱排序後 diff：0 條消失）。**殘留**：`seed.ts` 的示範池仍是舊制（`card_id is null`，解押不回卡冊），該在示範池換成真官方池那天走 API 重建。 |
| ~~A-5~~ | ~~`in_book` 卡掛單下架後必然回到 `shipped`~~ **已修並有回歸測試（2026-09-03）** | 讀碼＋回歸檔 | 032 新增 `listings.previous_status`；上架時記錄原狀態，下架時以白名單精確還原。migration 亦保守回填仍可證明的舊掛單與既有錯轉卡；資訊不足的舊 `ship` 掛單仍採 `shipped` fallback，避免把真實已寄出的卡誤開池。`regress-public.ts` 驗證 `in_book → listing → delist → in_book` 後能再次開池，並驗 stashed 與成交反向路徑。 |
| ~~A-6~~ | ~~公開池展示資料與公平性 manifest 的鑑定編號曝光規則混在一起~~ **已修並有回歸測試（2026-09-03）** | 讀碼＋回歸檔 | pool 列表／詳情展示的卡片已走 `publicCard()` 白名單；revealed manifest 刻意保留完整 `certNo`，因為它是 v2+ commit hash 的序列化輸入。`regress-public.ts` 同時驗證公開展示不含編號、reveal manifest 保留編號且公平性驗算可通過。 |
| ~~A-7~~ | ~~公開 OAuth 起始端點沒有速率限制~~ **已修並有回歸測試（2026-09-03）** | 讀碼＋回歸檔 | LINE login/link start 已使用獨立 `oauth-start-ip:` bucket，並在 start 路徑清理逾期 `oauth_states` 與 login exchange codes。`regress-ratelimit.ts` 驗證上限、`Retry-After`、IP 隔離與過期資料清理。 |
| A-8 | 已有全裝置登出 API，但前端尚未提供操作入口 | Medium | 讀碼（2026-09-03） | `POST /v1/auth/logout-all` 已完成，但前端搜尋不到呼叫；使用者無法從 UI 使用這個帳號自救功能。<br>**修法**：在帳號／登入方式設定加入「登出其他裝置」動作，預設呼叫 `{ keepCurrent: true }` 後以回傳的新 token 更新本機；可另提供「連目前裝置也登出」的確認操作。 |
| A-9 | 032／033 migration 是否已套用到正式資料庫尚未驗證 | 部署驗證 | 待查 | 程式已依賴 `listings.previous_status` 與 `users.session_version`。production 必須先執行 migration 032、033，否則上架／登入驗證會因欄位不存在而失敗。<br>**驗證**：部署日確認 migration log，並以唯讀 schema 查詢確認兩欄存在；不得以本機 build 通過取代此確認。 |
| P-7 | 平台自營池是否可提供買回價 | 產品／法規決策 | 讀碼＋規則文件 | 建池程式會驗買回價範圍與經濟護欄，但沒有依 official seller/origin 禁止買回。若 rules.md 的法律判斷為「平台自營不可提供買回」，這不是文件提醒就能處理。<br>**決策後修法**：明確定義 `u-official` 是否代表平台；若是，後端建立池時拒絕 tierBuyback／個別 buyback，前端同時隱藏欄位，並盤點既有官方池。 |

**本輪確認已修／不應再列為現況的事項：**

- 註冊速率限制已改為成功與失敗嘗試都計數，且使用獨立 `reg-ip:` bucket；`clientIp()` 已改取 Railway 代理附加的最後一段。舊 M-1 文字仍描述改前行號，後續整理時應以本段為準。
- 市場掛價已有 `POINTS_INPUT_MAX`；公開市場 listing 已走 `publicCard()`。舊 L-1／L-2「市場那一半尚未修」為過時紀錄。
- Railway 的 `startCommand` 已不含 `npm run seed`；不能再把「每次部署重灌示範池」當成當前程式行為。正式環境是否仍留有 fixture 資料，需另以部署資料實測。
- **R2 網域未帶入 production build 導致 CSP fail-closed —— 已修（2026-09-04）**。`deploy-pages.yml` 的建置步驟原本只傳 `VITE_API_URL`，`VITE_R2_PUBLIC_URL`／`VITE_R2_UPLOAD_ORIGIN` 兩個現在都跟著傳（同樣走 repo Variable）。另新增建置後檢查 `scripts/check-csp.mjs`（`npm run check:csp`），讀 `dist/` 每一份 HTML 的 CSP meta 並斷言：`script-src` 沒有 `'unsafe-inline'`／`'unsafe-eval'`、API 網域同時在 `img-src` 與 `connect-src`、R2 兩個網域各自到位、六份 seo 產物的 CSP 與 `index.html` 一致；失敗 exit 1 讓 CI 紅，不是印警告。「本機還沒接 R2」與「正式漏設變數」的環境變數長得一樣，靠 workflow 裡寫死的 `CSP_EXPECT_API`／`CSP_EXPECT_R2: 'true'` 分開 —— 預期在版控裡、值在 GitHub 設定裡，忘記填值動不到那兩行，所以漏設必紅；真的還沒有 R2 就得改那一行並 commit。**待辦：使用者要在 repo 的 Settings → Secrets and variables → Actions → Variables 新增 `VITE_R2_PUBLIC_URL`（R2 公開讀取網域）與 `VITE_R2_UPLOAD_ORIGIN`（`<帳號>.r2.cloudflarestorage.com`），沒填的話下一次部署會被這道檢查擋下。**
- `frame-ancestors` 無法由 meta CSP 生效仍成立；需改用能設 HTTP response header 的前端託管才能根治。

---

## 六、前端（audit-frontend-2）

**W-1〜W-4 都已經處理掉了，只剩 W-5。**留著前四條是為了記錄它們曾經是什麼。

| # | 問題 | 說明 |
|---|---|---|
| ~~W-1~~ | ~~**API 掛掉時大廳／挑池／池詳情把「錯誤」畫成「空」**~~ **已修並驗過** | 原本：`/lobby` →「這個分類目前沒有池」、`/play` →「目前沒有進行中的抽選池」、`/pools/:id` →**「找不到這個池，可能已下架」**（會傳出去的假話）。成因是 `stores/pools.ts` 的 `load()` 只有 `finally` 沒有錯誤狀態 |
| ~~W-2~~ | ~~Market 的錯誤訊息是英文原文「Failed to fetch」~~ **已修** | 行為本來就對（有錯誤態能重試），缺的只是中文化 |
| ~~W-3~~ | ~~`/me/cards/sell` 直接進入顯示「沒有可以上架的卡」~~ **已修** | 實際是「沒有帶選取進來」，有卡的人會誤以為卡不能上架 |
| ~~W-4~~ | ~~桌機 header 沒有「出貨與結算」入口~~ **已做，但還沒 commit** | **修正中（前端 header 工作線）**：入口已經在 `src/components/AppHeader.vue:102-104`（桌機 `.actions` 區塊，接在「＋ 我要開池」後面），目標路由 `seller-shipping` 存在（`src/router/index.ts:118-119`）。<br>**驗收前要注意一個條件**：它掛的是 `v-if="sellers.isSeller"`，而 `isSeller` 是新加的 getter（`src/stores/sellers.ts`，`!!t && t !== 'pending'`），要等 `ensureStatus()` 打完 `/v1/seller/me` 才有值。所以**只有審核通過的賣家、且在該請求回來之後**才看得到 —— pending 賣家永遠看不到。如果 W-4 的驗收標準是「桌機 header 看得到」，這個條件要先講清楚 |
| W-5 | `/u/:slug` 對爬蟲回 404 | **結論仍成立，但原本的敘述要改 —— 「沒有 SPA rewrite」已經不精確了。**<br>現在**有** 404.html 後備（`scripts/seo.mjs:82-88` 建置時產生，並額外寫入 `robots: noindex`），而且 `.github/workflows/deploy-pages.yml:31-35` 明確記載舊的 `cp dist/index.html dist/404.html` 是被**刻意移除**的（它會蓋掉 noindex 版本）。另外五條靜態路由（`/`、`/lobby`、`/market`、`/fairness`、`/trade-protection`，清單在 `src/lib/seo-routes.json`）已經各自預先產生實體 `index.html`，那些路徑對爬蟲**回 200**。<br>**沒解決的是動態路由**：GitHub Pages 送 404.html 時帶的是 404 狀態碼，而 `/u/:slug` 的 slug 事前不知道、無法預先產生（`scripts/seo.mjs:16-17` 自己記著這件事）。所以「人打得開、爬蟲拿到 404」對 `/u/:slug` 依然成立，LINE 分享仍然沒有預覽卡。<br>**根治仍然是換主機，而且設定檔都已經寫好了**：`public/_redirects`（Netlify／Cloudflare Pages，`/* /index.html 200`）、`vercel.json:6`、`public/staticwebapp.config.json`。目前實際部署仍是 GitHub Pages（唯一的 workflow 是 `deploy-pages.yml`，base 由 `vite.config.ts:9` 處理），倉庫裡沒有 `CNAME` |
| ~~I-1~~ | ~~目錄外自訂卡的「必須附正面照」只在前端強制~~ **已修並驗過（2026-09-03）** | 實測 | `routes/cardbook.ts` 在 `artId` 為空（含只有空白）時要求 `frontFileId`，缺就回 400 `CARD_IMAGE_REQUIRED`；有 `artId` 的目錄卡不受影響，照樣可以不傳正面照。<br>**改前**（直接打 API、空 `artId` 空 `frontFileId`）：`HTTP 200`，回一張 `image: ""` 的 `in_book` 卡。**改後**：`HTTP 400 {"error":"CARD_IMAGE_REQUIRED","message":"目錄裡沒有這張卡的話，請先上傳一張卡片正面照片再登記 …"}`。<br>迴歸：`regress-upload.ts` 六條（含「artId 只有空白也算沒有」與「目錄卡不受影響」的反向那半條）、`smoke.ts` 一條（不需要 R2）。 |
| ~~I-2~~ | ~~自訂卡只確認 `files` 資料列存在，未確認 R2 物件真的上傳完成~~ **已修並驗過（2026-09-03）** | 實測 | `r2.ts` 的 `objectExists()`（布林、吞掉所有例外）換成三態的 **`objectState()`**：`present` / `missing`（R2 明確回 404）/ `unavailable`（網路、逾時、憑證、5xx、403）。`cardbook.ts` 入庫前查一次：`missing` → 400 `BAD_CARD_IMAGE`（「這張正面照沒有上傳完成…請重新選一次照片」），`unavailable` → **503 `IMAGE_CHECK_UNAVAILABLE` 帶 `Retry-After: 5`**（「這是我們這邊的問題…你的卡片資料還沒有送出」）。兩種分得開是這條的重點：布林版本會把一次網路抖動說成「你的圖沒傳完」，比原本的缺口更糟。<br>**實測**（本機 S3 相容假伺服器）：presign 後不 PUT → 400 `BAD_CARD_IMAGE`；同一個**圖確實已傳好**的 `fileId`，把端點指到連不上的位址（連線被拒／DNS 解析不了兩種都試）→ 503 `IMAGE_CHECK_UNAVAILABLE`。<br>**順帶修掉審查點出的 `ContentLength`**：`presignPut()` 現在把宣告的 `bytes` 簽進通行證（`signableHeaders: content-length`），實測通行證的 `X-Amz-SignedHeaders` 是 `content-length;host` —— 宣告 `bytes: 1` 再 PUT 大檔簽章對不上，8MB 上限這才在儲存層有強制力。前端本來就是拿同一個 `File` 的 `size` 去 presign、再原樣 PUT（`src/lib/uploads.ts`），對得上。<br>`r2.ts` 另加一個 `R2_ENDPOINT` 開關（沒填就是正式行為）—— 「物件不在」與「問不到」這兩種情況沒有可控端點就驗不出來。 |
| ~~I-3~~ | ~~自訂卡與正面照流程沒有自動回歸測試~~ **已補並驗過（2026-09-03）** | 實測 | `regress-upload.ts` 新增兩段（50 passed / 0 failed，接假 R2 跑滿），`smoke.ts` 新增五條（403 passed / 0 failed）。文件要求的五件全部驗到：`card-front` presign、本人圖片成功入庫、他人／錯誤用途的 file ID 回 `BAD_CARD_IMAGE`、目錄外卡漏圖被拒（I-1）、`/v1/files/:id/raw` 取得**位元組一致**的實際圖片。另外多驗了「presign 後沒 PUT → `BAD_CARD_IMAGE`」與「通行證有簽 content-length」。<br>**沒有 R2 的環境**：那四條逐條印 `SKIP` 並附原因（`40 passed, 0 failed, 5 skipped`），斷言一條都沒有放寬 —— 不需要 R2 的 I-1 那一段在任何環境都會跑。 |

---

## 七、政策未定（不是 bug，是還沒決定）

| # | 事情 | 驗證 | 現況 |
|---|---|---|---|
| D-1 | **寄存到期怎麼處理** | — | 目前只通知不動。卡冊變成主要容器之後會從「之後再說」變成每天遇到 |
| D-2 | 過戶時不重設 `stash_expires_at` | 讀碼（2026-08-27 重查，仍成立） | 買家繼承賣家剩下的天數。使用者還沒表態。<br>**重查確認得很乾淨**：全站 `stash_expires_at` **只有一個寫入點** —— 抽中的當下（`server/src/pools-service.ts:283`，`now + STASH_DAYS * DAY`，`STASH_DAYS = 90` 在 `:21`），加上種子的 insert（`seed.ts:649`）。<br>三條過戶路**全部沒碰它**：`orders.ts:102`（庫內成交）、`social.ts:268`（交易邀約成交）、`orders-service.ts:97`（託管訂單完成）—— 三處都特地更新了 `acquired_at` 並寫了註解說明為什麼，卻都沒提到 `stash_expires_at`，**看起來是漏掉而不是決定**。資料庫也補不了：`002_core.sql:191` 是 `bigint not null` 且**沒有 default**。<br>具體後果：一張抽到第 89 天的卡在市場賣掉，新主人只剩 1 天 |
| D-3 | 開池保證金 | — | 沒做，用「新賣家額度上限 + 違約累積」替代 |
| D-4 | 保底／天井 | — | 沒做。建議不做，使用者還沒確認 |
| D-5 | 市場交易手續費 | 讀碼（2026-08-27 重查，仍成立） | **0%，而且機制根本不存在** —— 沒有任何 `MARKET_FEE_RATE` 之類的常數，三條市場成交路都是 100% 過手：庫內 `orders.ts:95-96`、託管 `orders-service.ts:55-56`、P2P `social.ts:262-265`（每條都是買家 `-price` / 賣家 `+price`）。<br>市場路上唯一會進平台帳的是沒收的保證金（`orders-service.ts:61-62`）—— 那是**罰則不是手續費**，不要拿它當「已經有抽成」的證據 |
| D-6 | 平台抽成 | 讀碼（2026-08-27 重查，仍成立） | **0%，但跟 D-5 不同：管線已經整套蓋好了**，改一個常數就會生效。<br>`server/src/shared/pool-settlement.ts:30` `PLATFORM_FEE_RATE = 0`（`:24-29` 的註解明講 0 是商業決定不是 TODO），拆帳在 `:114-117` 的 `splitTicket()`；建池時把當下費率**快照**進 `pools.platform_fee_rate`（`routes/pools.ts:466`），抽卡時讀回（`pools-service.ts:294`），入帳在 `pool-settlement.ts:135` 與 `:152-153`，退款路對稱（`:265`、`:269`）。<br>因為到處都有 `fee > 0` 守衛，**今天一筆平台分錄都沒寫過**。<br>要調費率時記得前端有一份鏡像（`src/shared/pool-settlement.ts`），兩邊要同步 |
| D-7 | 裸卡上架 | — | 使用者說緩 |

---

## 八、外部卡住的

| # | 事情 | 狀態 |
|---|---|---|
| ~~X-1~~ | ~~**PSA API 403**~~ | **已放棄，整組移除（未 commit 的工作樹）。**`server/src/psa.ts`、`routes/psa.ts`、`src/lib/psa.ts`、`PsaBadge.vue` 全部刪除，migration 029 刪掉快取表，`PSA_STUB` / `PSA_VERIFY_ENFORCE` 兩個環境變數已不存在。**現在平台不做任何鑑定編號真偽查證**，也沒有 pending／verified 標記。<br>**代價**：捏造的編號會被收下（實測 `00000001` 現在 200，以前是 400 `CERT_NOT_FOUND`）。條款頁與隱私頁已照實改寫。<br>**沒有跟著消失的是唯一性**：`prizes_cert_alive`（`unique(grader, cert_no)`，由 `server/src/preflight.ts` 在啟動時建）仍然擋住同一個編號登記兩次 —— 那跟查證是兩件事 |
| ~~X-2~~ | ~~**PSA EULA 未確認能不能顯示資料給買家**~~ | **不再適用**：沒有 PSA 資料可顯示（見 X-1） |
| X-3 | 沒有第二個可用的編號驗證來源 | 研究結論見 [cert-verification-alternatives.md](cert-verification-alternatives.md)。爬 PSA 不可行（Collectors.com 條款禁止自動存取、Cloudflare 擋、台灣 Lawsnote 一審判決把違反條款當成刑法 359「無故」） |
| X-4 | **資料庫連不到** | Railway 的 postgres 只有內部主機名，沒開公開 proxy。掃描腳本 `server/scripts/scan-certs.ts` 寫好了但跑不了。要開 Settings → Networking → TCP Proxy |

---

## 九、只做了推理、沒實跑的

| # | 事情 | 驗證 |
|---|---|---|
| ~~V-1~~ | **死鎖**：鎖序相反。**2026-09-03 實測後關掉** —— 原本那個環（prizes ↔ 結算列）在 f851070／42caace 就已經修好，這次是把它實跑證明了；同一次壓測抓到**另一個還活著的環**（prizes ↔ sellers，兩支掃描互撞），已一併修掉 —— 詳見下方 | **實測**（`server/src/regress-deadlock.ts`） |
| V-2 | `SELLER_UNFUNDED`：單張買回價超過保留額、賣家可動用又不足的拒絕路徑，未實測 | 推論 |
| V-3 | 四條收尾路徑兩兩併發（回收 vs 出貨申請、退款 vs 賣家出貨）。推理上安全（狀態守衛 + `returning`），未實跑 | 推論 |

### V-1 收尾（2026-09-03 實測）

**先講結論：V-1 可以劃掉了 —— 但上面那段 2026-08-27 的重新評估，現在整段都是過時的，
連它建議的修法方向都跟實際落地的相反。**

#### 一、2026-08-27 那段的每一句話，現在還成不成立

| 那時寫的 | 現在 |
|---|---|
| 「`for update of st` 這個改動還沒 commit，只在工作樹裡」 | **不成立。**已經在 `f851070`（2026-08-27）裡了 |
| 「回收那條路是 `routes/prizes.ts:166` → `:176`」 | **行號全錯**（現在是 `:433` → `:443`），方向倒是沒變 |
| 「sweep 的鎖序是『結算列 → prizes』」 | **不成立。**`f851070` 同一支 commit 把 `sweepSettlements` 改成兩段式：第一段無鎖撈候選，第二段照 **prizes → 結算列**上鎖。跟回收同向 |
| 「環還在，要把**回收**那條反過來」 | **不成立，而且方向相反。**實際落地的是把**掃描**那條轉成跟回收同向。回收那條一個字都沒動 —— 它本來就是對的（「從一張卡出發」是這個系統的自然順序） |
| 「頻率沒有降低」 | 成立，而且正是這一點讓下面那個新的環會咬人 |

**教訓跟這張表前面幾條一樣**：那段是照著「當時的工作樹」寫的，之後 `f851070`
與 `42caace` 都動過這幾支，沒有人回頭改這一節。**讀這張表之前先讀程式碼。**

#### 二、環是真的 —— A/B 對照

`server/src/regress-deadlock.ts` 用同一份佈景、同一個併發時序，只換鎖序：

| | 鎖序 | 20 輪的結果 |
|---|---|---|
| A 組 | 結算列 → prizes（**舊的**，用裸 SQL 重演） | **20／20 輪撞到 40P01**，`pg_stat_database.deadlocks` +20 |
| B 組 | prizes → 結算列（**現行**） | 0／20，`deadlocks` +0 |

A 組撞得出來，才證明這個佈景**有能力**製造死鎖；B 組是 0，那個 0 才代表
「來自鎖序」而不是「壓不到」。兩邊缺一個，結論都不成立 ——
這也是這支測試跟 `regress-race.ts` 第 7 組最大的差別（那一組只有 B 邊）。

#### 三、順手抓到的：**另一個還活著的環**（prizes ↔ sellers）

拿現行程式碼實跑時，第 3 組還是撞出了一個 40P01。Postgres 的 log 說得很清楚：

```
Process 1769: update sellers set default_count = default_count + 1 where id = $1
Process 1786: select id from prizes where id = $1 for update
```

**這不是 V-1 的環，跟回收完全無關 —— 是兩支掃描自己湊出來的：**

- `refund()` 與 `markShipDefault()` 都會 `update sellers set default_count`，
  而**一個賣家只有一列**，那一列會被握到 COMMIT；
- 而 `sweepSettlements` 原本是在**迴圈裡逐筆**鎖 prizes。

於是「握著共用的 sellers 列、還在往下拿新的 prizes 列」——

```
掃描 A：握著 sellers(u-shop) → 要 prizes(p2)
掃描 B：握著 prizes(p2)      → 要 sellers(u-shop)
```

**鎖序對了還不夠，還要「不再中途拿新鎖」。**

會分岔的關鍵是 `sweepSettlements(tx, userId)` 跟 `sweepSettlementsAll()` 的候選
查詢不一樣（前者多一個 `and (st.seller_id = $1 or pz.user_id = $1)`），
候選集合與順序都不同。四支全域掃描互撞反而撞不太出來 —— 它們的計畫一樣，
第二名在第一列就整個排隊。而使用者範圍那一支正是正式環境最常跑的：
它掛在讀卡冊（`routes/prizes.ts`）與讀賣家結算頁（`routes/sellers.ts`）上。

**修法**（`pool-settlement.ts`，`sweepSettlements`）：把上鎖跟做事拆成兩個階段。
先從無鎖候選裡篩出真的到期的那幾筆，然後**一次**把它們的 `prizes` 與 `sellers`
整批鎖起來（各自 `order by id`），之後的迴圈**不再要求任何新的列鎖**。
全站的鎖序因此是 **prizes → sellers → settlements → shipments**。

實測（同一支測試、`regress-deadlock.ts` 第 3b 組，每輪 6 筆逾期 × 4 支掃描
＝ 2 支全域 + 2 支使用者範圍，共 20 輪）：

| | `deadlocks` 增量 | 掃描拋 40P01 |
|---|---|---|
| 修之前 | **+14**（20 輪裡 14 輪撞到） | 14 次 |
| 修之後 | **0** | 0 次 |

加上第 3 組（掃描 × 回收 × 讀清單）修前 +1、修後 0 ——
**產品碼上的死鎖從 15 次降到 0 次。**

資料在死鎖發生時**沒有壞**（被 abort 的那支整筆回滾，其他支把同一批補完，
`drift` 始終是 0）。壞的是那個請求變成一個沒有理由的 500，或者被
`.catch(() => {})` 吞掉之後靜靜地少掃了一輪。

#### 四、全站同時鎖 `prizes` 與 `pool_settlements` 的路徑（逐條查過）

| 路徑 | 鎖序 |
|---|---|
| `pool-settlement.ts` `sweepSettlements` | prizes（整批，`order by id`）→ sellers（整批）→ 結算列 ✅ |
| `routes/prizes.ts` `POST /:id/recycle` | prizes → 結算列 ✅ |
| `routes/prizes.ts` `POST /:id/confirm` | prizes → 結算列 ✅ |
| `routes/sellers.ts` `POST /settlements/:id/ship` | 無鎖讀 prize_id → prizes → 結算列 ✅ |
| `routes/prizes.ts` `POST /ship` | 只鎖 prizes（`markShipRequested` 之後才動結算列） ✅ |
| `routes/admin.ts` 後台標出貨 | prizes（`order by id`）→ shipments ✅ |

只寫其中一張表的（`index.ts` 的 dev rewind、`monitor.ts` 的體檢、
`routes/sellers.ts` 的清單查詢）不在環上。
`update sellers` 全站只有兩處，都在 `refund()` / `markShipDefault()` 裡 ——
也就是**只有掃描會動 sellers**，所以上面那個新的環只在掃描 × 掃描之間成立。

#### 五、留給下一個人的

- `regress-deadlock.ts` 的 A 組會**故意**製造 20 次死鎖，`pg_stat_database.deadlocks`
  跑完不是 0 —— 那是預期輸出，不是失敗。看的是每一組的**增量**。
- `regress-race.ts` 第 7 組（V-1 專項）與第 7b 組（後台 vs 賣家出貨）仍然有效，
  但它們只有 B 邊。要判斷鎖序有沒有被改壞，跑 `regress-deadlock.ts`。

---

## 建議的處理順序

### 2026-09-03 目前待處理順序

1. **A-9：部署前確認 migration 032／033 已套用** —— 這是已完成程式碼能否安全上 production 的前提。
2. **A-8：前端串接全裝置登出** —— 後端撤銷能力已可用，UI 必須讓使用者能實際操作。
3. **A-3：公開賣家列表分頁與批次統計**。
4. **A-4：裸卡實體庫存模型** —— 範圍較大，但個人開池正式上線前必修。
5. **A-1b：選定忘記密碼的 Email／LINE 交付方案**，再設計單次、短效的恢復流程。
6. ~~V-1：統一回收與逾期退款的鎖序~~ —— **2026-09-03 完成**：原環早已修好（實測證明），順手抓到並修掉 prizes ↔ sellers 那個還活著的環。
7. 其餘未解項目按嚴重度與上線時程處理；已完成的 A-1 第一階段、A-2、A-5、A-6、A-7 不再列入待辦。

**這一輪查證的副產品**：三條的敘述是錯的（M-1 的理由、L-3 與 L-4 的出處），
一條的敘述過時（W-5）。錯法跟 S-1 完全一樣 —— 抄稽核報告的結論與行號，
沒有回頭查後面的 commit。**下次改這張表之前先重讀程式碼，不要相信這張表上的行號。**
