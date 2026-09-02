# VaultDraw 未解問題總表

把散在五份稽核報告、HANDOFF、和這一輪程式碼閱讀裡的東西合成一張表。
**只列還沒解決的**；已修的不重複（那些在各自報告裡標了「已修」）。

最後更新：2026-08-27（第三次，補上正式環境實測與全表查證）

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
| I-1 | 目錄外自訂卡的「必須附正面照」只在前端強制 | Medium / 讀碼（2026-09-02） | 已完成的部分：`CardUploadPage.vue` 有「目錄沒有這張卡」模式，要求卡名／系列／卡號與 `card-front` 正面照；`030_card_front_files.sql`、`routes/files.ts` 與 `CardArt.vue` 已把受控上傳、公開讀取、`/raw` 圖片導轉接通。<br>**缺口**：`routes/cardbook.ts` 的 `frontFileId` 是選填，後端不能分辨「從目錄選的卡」和「使用者手填的卡」。直接 POST `/v1/cardbook/upload` 帶空 `artId`、空 `frontFileId` 仍會成功，形成沒有可辨識圖片的自訂卡，且仍可進入開池／交易流程。<br>**修法**：後端把規則寫死：`artId` 為空時，`frontFileId` 必填；有 `artId` 的目錄卡維持可不傳正面照。不要只依賴前端 disabled 按鈕。 |
| I-2 | 自訂卡只確認 `files` 資料列存在，未確認 R2 物件真的上傳完成 | Medium / 讀碼（2026-09-02） | `/v1/files/presign` 先 insert `files`，再由瀏覽器直接 PUT R2。若取得 URL 後取消、逾時或傳輸失敗，直接 POST cardbook API 仍能用該 `frontFileId` 建立卡片；卡片的 `/v1/files/:id/raw` 之後會 404 或 503。正常前端會等上傳完成才送出，因此不是一般操作必現；但後端仍需保護直接 API 呼叫。<br>**修法**：在 R2 helper 區分「物件不存在」與「R2 暫時無法查詢」，前者回 `BAD_CARD_IMAGE`，後者回可重試的 503；入庫前確認 object key 存在。 |
| I-3 | 自訂卡與正面照流程沒有自動回歸測試 | Medium / 讀碼（2026-09-02） | PSA 專屬測試預期已從 smoke／regression 移除，但 `smoke.ts`、`regress-upload.ts` 尚未覆蓋新流程。至少要驗：`card-front` presign、本人圖片成功入庫、他人／錯誤用途 file ID 回 `BAD_CARD_IMAGE`、目錄外卡漏圖被拒、`/v1/files/:id/raw` 可取得實際圖片。 |

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
| V-1 | **死鎖**：鎖序相反。**2026-08-27 重新評估：仍然成立，但成立條件已經大幅收窄** —— 詳見下方 | 讀碼（重新評估）＋仍未實測 |
| V-2 | `SELLER_UNFUNDED`：單張買回價超過保留額、賣家可動用又不足的拒絕路徑，未實測 | 推論 |
| V-3 | 四條收尾路徑兩兩併發（回收 vs 出貨申請、退款 vs 賣家出貨）。推理上安全（狀態守衛 + `returning`），未實跑 | 推論 |

### V-1 重新評估（因為 `sweepSettlements` 剛改成 `for update of st`）

**先講結論：環還在，V-1 不能劃掉；但可能觸發的情境從「非常多」變成「很少」。**
另外要提醒：**`for update of st` 這個改動本身還沒 commit**（在工作樹裡），
所以「已經收窄」這句話只對現在的工作樹成立，對線上不成立。

**改了什麼**：`sweepSettlements` 的兩個 `select` 現在是 `for update of st`
（`server/src/pool-settlement.ts:380`、`:385`、`:397`、`:403`），
而不是裸的 `for update`。有 join 的時候裸的會**連 `prizes` 那一列一起鎖**，
現在只鎖結算列。

**為什麼環還在**：鎖不只來自 `select ... for update`，**`update` 一樣會拿列鎖**。
sweep 走到退款時：

- `refund()` 在 `pool-settlement.ts:271` 執行 `update prizes set status = 'refunded'`
  —— 這時它**已經**握著那筆結算列的鎖了。鎖序仍然是「結算列 → prizes」。
- 回收那條路的鎖序沒變：`routes/prizes.ts:166` 先 `select * from prizes ... for update`，
  再到 `:176` `... for update of st`。也就是「prizes → 結算列」。

兩邊方向依舊相反 → 環仍然存在，Postgres 仍會挑一邊 abort，那個請求仍會 500。

**為什麼實務上變窄很多**：sweep 大部分的結案路徑**根本不碰 `prizes`**。

| sweep 的動作 | 會不會拿 prizes 鎖 |
|---|---|
| `release()`（`pool-settlement.ts:239-246`） | **不會** —— 只 update `pool_settlements` |
| `markShipDefault()`（`:294-312`） | **不會** —— 只動 `pool_settlements` 與 `sellers` |
| `refund()`（`:255-283`） | **會**（`:271`）—— 這是唯一還在環上的 |

所以觸發條件從
「sweep 掃到的**任何一列** × 同時有人回收那張卡」
收窄成
「**同一筆**結算正好是 `awaiting_ship` 且已逾期、sweep 正要退款，而卡的主人同時按下回收」。

**還是不能劃掉的兩個理由**：

1. **頻率沒有降低。**sweep 掛在讀清單的路徑上，每個請求都會觸發 ——
   `routes/prizes.ts:36`（讀卡冊）與 `routes/sellers.ts:115`（讀賣家結算頁）。
   全域排程那支（`sweepSettlementsAll`，`pool-settlement.ts:427`）更是一次撈全部未結案的結算列。
2. **要根治只要把回收那條路的鎖序反過來**（先鎖結算列再鎖 prizes），
   成本很低，比繼續推理划算。

**建議**：實測優先度可以往後放（窗口小了），但**修法優先度不變**，
而且要在 `for update of st` 那個改動 commit 的同一批一起做 —— 否則下一個讀這段的人
會看到 `:371` 那則註解說「這裡只需要結算列的鎖」，誤以為 V-1 已經解決了。

---

## 建議的處理順序

1. ~~**F-1〜F-6**~~ —— 已修並驗過（見進度表）
2. **P-1 拿掉 `npm run seed`** —— **本輪實測後往上調**。原本以為是「塞了一些假資料」，
   實際是正式站陳列的 32 個池 100% 是假池。改一行字串的事
3. **U-1〜U-5**（inventory-first 021〜024）
4. ~~S-1~~ · ~~W-1〜W-3 錯誤態~~ · ~~P-4 低熵種子閘~~ —— 已處理（S-1 是誤記）
5. **L-1 / L-2 補完 `routes/public.ts`** —— 這兩條的工作線已經做完卡冊那一半，
   市場那一半（`toListing()` 的白名單、掛單 `price` 的上界）還沒碰。
   **半套比沒做更危險**：會讓人以為已經解決了
6. **M-1 註冊速率限制** —— 一行的事（成功註冊那條路也要 `bumpFail`），
   而且跟 P-2 的送點是同一條水龍頭的兩截
7. **V-1 把回收的鎖序反過來** —— 跟 `for update of st` 同一批 commit，
   否則那則註解會讓下一個人以為已經解決了
8. 其餘按嚴重度。L-5 建議降為觀察項（緩解已到位，殘餘曝險靠 M-2 解）

**這一輪查證的副產品**：三條的敘述是錯的（M-1 的理由、L-3 與 L-4 的出處），
一條的敘述過時（W-5）。錯法跟 S-1 完全一樣 —— 抄稽核報告的結論與行號，
沒有回頭查後面的 commit。**下次改這張表之前先重讀程式碼，不要相信這張表上的行號。**
