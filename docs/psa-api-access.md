# PSA Public API 403「Access to this API is limited to approved customers」調查

調查日期：2026-08-26。方法：WebSearch / WebFetch + GitHub Search API。未執行任何程式碼變更、未註冊帳號、未嘗試繞過限制。

---

## 結論（先看這裡）

1. **這不是你的 bug，也不是 token 壞掉**：至少五個互不相關的公開專案在 2026-07 到 2026-08 之間回報了逐字相同的 403 訊息，全部發生在帳號層級。
2. **PSA 在 2026 年年中把免費 API 層關掉了**，改成需要付費／核准的方案；官方文件到現在都沒更新說明這件事。
3. **官方唯一的申請窗口是 `collectors-apis@collectors.com`**（出現在 429 回應內文與多個第三方文件中），但**我找不到任何一則「申請後成功拿到權限」的公開紀錄**。
4. **有一個 Collectors Club Premium 會員回報他仍有 API 存取權**，但那是「在關閉前就已開通」的推測，不是已驗證的取得途徑（推論）。
5. **最務實的替代路徑是 Alt 的公開未驗證 GraphQL API**（`Cert(certNumber)` 查詢），它回傳的欄位比 PSA cert lookup 還多；其次是付費代理服務（Parse.bot、TCGAPIs）。

---

## 1. 有沒有其他人遇到同樣的 403？

**有，而且訊息逐字相同。** 這是本次調查最紮實的部分——GitHub Search API 以字串 `"limited to approved customers"` 搜到多筆真實專案紀錄：

| 日期 | 專案 | 內容 |
|---|---|---|
| 2026-07-27 | HobbyIQ/HobbyIQ-V1 PR #877 | cert lookup 全數 403，訊息逐字相同 |
| 2026-07-30 | jboll3/PSA-Card-Track PR #1 | 明確把「403 = token 無效」的判斷改掉，改標記為「PSA 拒絕這個請求／client context」 |
| 2026-08-11 | paiwandkarem/obsidian-card-pricer PR #28、PR #2、`docs/DATA-SOURCES.md` | 最完整的實測矩陣（見下） |
| 2026-08-20 | johnkim9524-collab/kaios_enterprise_repo issue #541 | 單一 cert 探測，記為 `FAIL_CLOSED_APPROVED_CUSTOMER_GATE` |
| 2026-08-22 | drew51115/cardshow PR #36 | 直接把「Verify with PSA」按鈕用 feature flag 關掉，備註「PSA API account approval is pending」 |

obsidian-card-pricer 的實測表格和你自己的觀察完全一致，而且多做了一個關鍵對照：

| 送出的 token | 回應 |
|---|---|
| 真實 token | `403` limited to approved customers |
| 同樣 304 字元長度的隨機字串 | `429` quota exceeded |
| 明顯不是 token 的字串 | `429` quota exceeded |
| 完全不帶 token | `429` quota exceeded |

作者的結論（我同意）：**IP 層級的封鎖會讓這三個回應一模一樣，但它們不一樣**，所以伺服器確實有查到你的 token、認得它是自己發的，然後在「entitlement（權利）」這一關拒絕。認不得的東西則掉進匿名配額桶。該匿名 429 帶 `retry-after: 58173`（約 16 小時），是每日配額。

同一份文件也記載：**重新產生第二顆 token、換遍所有 header 拼法（`bearer` / `Bearer`）、換遍所有端點（`GetByCertNumber`、`GetImagesByCertNumber`、`GetPSASpecPopulation`），全部 403，沒有任何一項改變結果。** 這和你「六個端點全 403」的觀察互相佐證。

來源：
- https://github.com/paiwandkarem/obsidian-card-pricer/pull/28
- https://github.com/paiwandkarem/obsidian-card-pricer/pull/2
- https://github.com/paiwandkarem/obsidian-card-pricer/blob/main/docs/DATA-SOURCES.md
- https://github.com/HobbyIQ/HobbyIQ-V1/pull/877
- https://github.com/jboll3/PSA-Card-Track/pull/1
- https://github.com/drew51115/cardshow/pull/36
- https://github.com/johnkim9524-collab/kaios_enterprise_repo/issues/541

### 一個看起來像解法、但很可能不是的東西

HobbyIQ PR #877（2026-07-27）宣稱：送 `Authorization: Bearer <token>` 得到 403，但**把 `Bearer ` 前綴拿掉、只送裸 token** 就變成 429 quota-exceeded，並描述為「auth passed cleanly」。

**我認為這個解讀是錯的（推論）。** 429 quota-exceeded 正是匿名共用配額的回應——也就是 obsidian-card-pricer 表格裡「格式錯誤所以 token 被忽略」那一列的結果。裸 token 沒有帶 `Bearer` 前綴，PSA 應該是整個 header 解析失敗、把請求當成匿名處理，所以你會拿到配額訊息而不是卡片資料。**它不是繞過核准閘門，只是換一種方式失敗。** 該 PR 自己的 test plan 也把「post-deploy 確認真的拿到卡片資料」留成未勾選狀態。

---

## 2. 核准的條件是什麼？

**找不到任何官方公告的核准條件。** PSA 的 `/publicapi` 與 `/publicapi/documentation` 頁面到 2026-08-26 為止，仍然只寫「sign in or register for access to our API」，**完全沒有提到核准、approved customers、方案或價格**（我實際抓過這兩頁）。錯誤碼章節也只列 200 / 204 / 4xx / 500，**403 這個碼根本沒有記載**，而 500 被描述為「invalid credentials」——這也是為什麼你會判斷 token 有效，那個判斷是對的。

能找到的間接證據：

- **免費層在 2026 年年中被關掉。** Apify 的 `psa-pop-scraper` 說明寫道：「as of mid-2026 PSA reduced their public API to ~1 call/day for BOTH anonymous and free registered tokens」，cert 與 spec ID 查詢「now necessitate a paid PSA API subscription」，並指名聯絡 `collectors-apis@collectors.com`。
  來源：https://apify.com/lulzasaur/psa-pop-scraper/api/openapi
- **同一個信箱在 PSA 自己的 429 回應內文裡出現。** obsidian-card-pricer 的紀錄寫「The 429 body names `collectors-apis@collectors.com`, which is the route.」
- **付費層存在但沒有公開價目。** CardGrader 的 PSA API 指南寫免費層 100 calls/day、「Paid tiers exist but require direct contact with PSA for pricing and higher limits」。
  來源：https://cardgrader.ai/blog/psa-api

**查不到的**：是否必須是 Collectors Club 會員、是否需要商業合約、審核要多久、通過率。沒有任何公開來源講過。

---

## 3. 有沒有人成功拿到權限？

**沒有找到任何一則確認成功的紀錄。** 目前找到的全部是「申請中」或「放棄」：

- obsidian-card-pricer：「The sanctioned route is API approval, and we have asked for it.」——之後的文件沒有回報結果，該專案已改用 Alt + Parse。
- drew51115/cardshow：「while PSA API account approval is pending」——PR 的做法是關掉功能等待，同樣沒有後續。

唯一沾到邊的是 Collectors Universe 官方論壇 2026 年 6 月的討論串：

- **bgr（2026-06-22）**：「PSA has their own API which you can use with a token you create in your account.」
- **80sOPC（2026-06-22）**：「Limit of 100 calls per day but for my purposes thats fine.」
- **80sOPC（2026-06-24）**：「I am getting an error trying to grab the cert image, it says my account can only make one API call per day.」
- **80sOPC（2026-06-25）**：「PSA just told me their killed the free API tier. @bgr you must have got in before the cutoff.」
- **bgr（2026-06-25）**：「I have collectors club premium or whatever their luxury tier is so perhaps that gets me the access...it said it was free for 100 queries.」

來源：https://forums.collectors.com/discussion/1123788/psa-api

注意 bgr 自己用的是「perhaps」——**「Collectors Club Premium 可換到 API 權限」是他的猜測，不是 PSA 的說法**。80sOPC 的解讀（在切斷日之前就已開通的帳號被保留）同樣是猜測。這兩個都是推論，不要當成已驗證的取得途徑。

---

## 4. 這個限制什麼時候開始？

時間線（事實部分）：

- **2024-07**：Wayback 存有 `/publicapi/documentation` 的快照，內容是 SPA 外殼、沒有可讀正文，無法比對文案變化。
  來源：http://web.archive.org/web/20240707053131/https://www.psacard.com/publicapi/documentation
- **一直到 2026 年中的教學文**都描述成「註冊 → 產 token → 直接用，免費 100 calls/day」，例如 brad-newman/fetch-psa-api 這類 Python 工具，以及 CardGrader 的指南。
- **2026-06-24 / 06-25**：論壇上出現第一批症狀——配額從 100/day 掉到 1/day，PSA 客服口頭告知「killed the free API tier」。
- **2026-07-27**：第一則有逐字 403「approved customers」訊息的公開紀錄（HobbyIQ）。
- **2026-08-11 / 08-20 / 08-22**：三個獨立專案重現同一個 403。

**推論**：PSA 大約在 2026 年 6 月先把免費配額降到 1/day，接著在 7 月把帶 token 的請求整個改成 entitlement 檢查、不合格就 403。這解釋了為什麼你「不帶 token 有配額訊息、帶了 token 反而 403」——匿名桶是舊行為的殘留，token 路徑則走了新的閘門。這段因果關係是我的推論，PSA 沒有公開說明。

值得一提的另一個脈絡：PSA 在 2026 年因為送件暴增而全面暫停 Value 分級層（2026-06-02 生效），並延長 Collectors Club 會籍。同一時期收緊 API 大概不是巧合，但**兩件事有沒有關聯，我沒有證據**。
來源：https://www.psacard.com/articles/articleview/15210/service-level-update-may-2026

---

## 5. 替代方案

### 5a. Alt 的公開 GraphQL API（目前最強的免費路徑）

obsidian-card-pricer 的作者用 Playwright 驅動 Alt 的 SPA、錄下 XHR 流量，發現一個**公開、不需驗證**的 GraphQL 端點：

```
POST https://alt-platform-server.production.internal.onlyalt.com/graphql/{OperationName}
```

`Cert(certNumber)` 查詢一次回傳 `assetId, gradingCompany, gradeNumber, name, year, subject, brand, variety, cardNumber, category`——**在「卡片身分」這件事上比 PSA 的 cert lookup 回得更多**，因為它同時給出 Alt 所有價格查詢都要用的 `assetId`。四張測試 cert（含 PSA 7 / 9 / 10、vintage 與 modern）全部以純 HTTP 解析成功，不需瀏覽器、不需驗證。作者也註記 `alt.xyz/robots.txt` 是空的 `Disallow:`。

**注意事項**：這是未公開文件的內部端點，Alt 隨時可以改或關；而且「robots.txt 允許」不等於「服務條款允許」——我沒有查 Alt 的 ToS，你要用的話請自己讀一遍。

來源：https://github.com/paiwandkarem/obsidian-card-pricer/blob/main/docs/DATA-SOURCES.md

### 5b. 付費代理／聚合服務

- **Parse.bot** 有 psacard.com 的 marketplace 條目，讀的是**公開 cert 頁面**而不是被閘住的 API，所以在 token 失效時仍然可用。obsidian-card-pricer 實際採用了它，並記錄：免費層 100 requests/day、一次呼叫一個 credit、`get_cert_full` 可以吃陣列做批次（三張 cert 只花一個 credit）、回應 3.8–5.2 秒。一個實測到的坑：送 `cert_numbers` 時 `data` 是陣列，送 `cert_number` 時是裸物件，沒有任何文件提到。
  來源：https://parse.bot/marketplace/e4bff78d-ff22-4603-b9d3-e3cbb455544e/psacard-com-api
- **TCGAPIs** 提供 PSA Certificate Checker，免登入每日 5 次公開查詢，完整 API 要 Business / Unlimited 方案。
  來源：https://tcgapis.com/psa-checker
- **Apify `lulzasaur/psa-pop-scraper`** 直接爬 PSA 網站的 pop report，繞過 API 配額。
  來源：https://apify.com/lulzasaur/psa-pop-scraper/api/openapi

### 5c. 官方網頁 cert verification

`psacard.com/cert/{cert}` 仍然可用，但 **PSA 已經在前面架了 Cloudflare**：純 HTTP 得到 403 interstitial，真實 headless Chrome 可以通過但每隔幾次請求就重新挑戰。obsidian-card-pricer 明確拒絕自行破解這層保護，理由是「PSA 已經兩次表態不歡迎自動化存取」。**我同意這個判斷，也不建議你走這條路。**

### 5d. 其他鑑定機構

- **BGS / Beckett**：無公開 API，只有網頁 cert lookup（`beckett.com/grading/card-lookup`）。
- **SGC**：無公開 API。
- **CGC**：有公開的 Verify Certification 網頁與 QR 掃描，**但沒有公開開發者 API**。
- 換句話說，**PSA 過去是唯一有公開 API 的鑑定機構**，現在那道門也關了。CardGrader 的指南是這麼寫的，我也沒找到反證。
  來源：https://cardgrader.ai/blog/psa-api、https://www.cgccards.com/、https://www.beckett.com/grading/card-lookup

---

## 6. API End User Agreement 的內容

**核心問題查不到。** PSA 的 API 文件頁面只寫了一句「Review the PSA API End User Agreement」，**沒有把條文放出來**。我試過的所有路徑都失敗：

- `/publicapi/agreement`、`/publicapi/eula`、`/publicapi/enduseragreement`、`/publicapi/terms` → 全部 302 轉到 `/errors/notfound`
- `/termsandconditions` → 403（Cloudflare）
- `/publicapi` 與 `/publicapi/documentation` 頁面上唯一的條款連結指向 `/termsandconditions`，也就是**送件服務條款**，不是 API EUA
- Wayback 只有 SPA 外殼，沒有正文
- Swagger spec (`api.psacard.com/publicapi/swagger/docs/v1`) → 404

**推論**：EUA 很可能放在登入牆後面（產 token 的那個流程裡），這也符合「文件頁面提到它卻不給連結」的現象。

能找到的、與「能不能顯示給第三方看」相關的最接近條文，來自 PSA 的 Submission Services Terms and Conditions（不是 API EUA），關於 Grader Notes：

> Customer may not, whether or not through a third party, directly or indirectly publish, publicly display, recreate, sublicense, or create derivative works from any of the Grader Notes in any manner whatsoever without the prior written consent of PSA.

這條只管 Grader Notes，**不等於管到 cert lookup 回傳的 grade / 卡片描述**。第三方指南（CardGrader）則泛泛地提醒「terms govern how you may store and display the data — read them before caching aggressively」，但沒有引用原文。

**所以：「PSA API 資料能不能顯示給第三方使用者看」這個問題，我沒有找到任何權威答案。** 唯一可靠的取得方式是登入 PSA 帳號、在 API 頁面把 EUA 全文讀出來——這件事我不能替你做（需要你的帳號）。

---

## 7. 明確查不到的東西

以下每一項我都實際找過，找不到，**不做推測**：

1. **PSA API EUA 全文**——被登入牆或 Cloudflare 擋住，Wayback 無正文，也沒有任何人引用過原文。
2. **「approved customer」的核准標準**——沒有任何官方或非官方來源說明條件。
3. **審核時間與通過率**——零筆資料。
4. **是否必須是 Collectors Club 會員**——只有一則會員的「perhaps」猜測，PSA 從未這樣說過。
5. **任何一則確認成功取得核准的公開紀錄**——找到的全是「申請中」或「已放棄」。
6. **付費方案的價格與級距**——只知道要寫信問，沒有公開價目。
7. **PSA 對 API 政策變更的官方公告**——不存在。文件頁面到今天都還在描述舊行為（甚至連 403 這個狀態碼都沒列進錯誤碼表）。
8. **403 是否可能是「新註冊帳號預設關閉、舊帳號沿用」**——這個假說和論壇上的時間點吻合，但沒有證據，我不把它當結論。
9. **Reddit（r/PSAcard、r/sportscards、r/pokemoncardcollectors）上的相關討論**——多次搜尋都沒有命中相關貼文。可能是沒人在那裡討論，也可能是搜尋索引沒涵蓋到；我無法區分這兩者。

---

## 8. 建議的下一步

### 立即做（成本低，值得做）

**寫一封信給 `collectors-apis@collectors.com`。** 這是唯一有證據支持的官方窗口（出現在 PSA 自己的 429 回應內文裡）。信要短、要具體、要讓對方一眼看出該改哪個 flag——附上那張 token 對照表，因為它證明了問題在帳號 entitlement 而不是 IP 或 token 格式：

> 主旨：Public API access request — token issued but returns 403 "limited to approved customers"
>
> 內容要點：
> - PSA 帳號 email / 帳號 ID
> - token 是在 `psacard.com/publicapi` 產生的、已重新產生過一次，行為不變
> - 六個端點（`cert/GetByCertNumber`、`cert/GetImagesByCertNumber`、`cert/GetByCertNumberForFileAppend`、`order/GetProgress`、`order/GetSubmissionProgress`、`pop/GetPSASpecPopulation`）全部回 403，訊息一致 → 是帳號層級不是端點層級
> - 對照表：真 token → 403；同長度隨機字串 → 429；無 token → 429 → 所以不是 IP 封鎖，是 entitlement flag
> - 直接問三件事：(a) 需要什麼條件才能成為 approved customer？(b) 有沒有付費方案與價目？(c) 審核大概多久？
> - 順便索取 API End User Agreement 全文，特別問明：**透過 API 取得的 cert 資料，可否顯示給我的產品的終端使用者看？**

**同時，不要等它。** 沒有任何一則公開紀錄顯示這封信會有回音，兩個實際申請過的專案都沒有回報結果。

### 我認為你該做的決定

**放棄把 PSA 官方 API 當成路徑，改走 Alt 的 GraphQL。** 理由：

1. PSA 這條路的期望值太低——零筆成功紀錄、零筆官方說明、零個公開價目，而且申請中的專案已經卡了兩週以上沒有進展。
2. Alt 的 `Cert(certNumber)` **在卡片身分這件事上回傳的資訊比 PSA cert lookup 還多**（多了 `assetId`，等於連上了價格資料），不需驗證、不需瀏覽器、有第三方實測四張不同年代與分數的 cert 全部成功。
3. 如果之後 PSA 真的核准了，你再把 PSA 接回來當作「權威 grade + slab 照片 + 官方 pop」的補強來源就好——這正是 obsidian-card-pricer 最後採取的架構（Alt 主、PSA 補）。

**不建議做的事**：不要去破 `psacard.com/cert/{cert}` 前面的 Cloudflare。PSA 已經用兩種方式（API 閘門 + Cloudflare）表態不歡迎自動化存取，繞過它在法務上和工程上都是負債。要走非官方路徑，就用 Parse.bot 或 TCGAPIs 這種付費代理，讓合規責任落在服務商身上。

**還有一件必須先釐清的事**：在把任何 PSA 資料顯示給你的使用者之前，**登入 PSA 帳號、把 API End User Agreement 全文讀出來**。第 6 節說明了我為什麼拿不到它，而「能不能顯示給第三方」這個問題如果答案是否定的，會直接改變產品設計——這比 403 本身更重要，而且不解決它，就算 PSA 明天核准了你也還是不能上線。

---

## 9. 已接上的實作（2026-08-26）與「明天啟用的一步」

前面第 1–8 節是調查。這一節寫**程式已經做了什麼**，以及 PSA 核准後要動哪裡。
目標很明確：**API 現在全 403，所以整條路必須能在 API 還不通的情況下優雅降級，
核准後只要環境變數就能啟用，不用改碼。**

### 做了什麼

| 元件 | 位置 |
|---|---|
| 後端查證 + 快取 | `server/src/psa.ts` |
| 查證端點 `POST /v1/psa/verify` | `server/src/routes/psa.ts` |
| 開池時的驗證接入 | `server/src/routes/pools.ts`（`POST /v1/pools`） |
| 快取資料表 `psa_certs` | `server/migrations/020_psa_cert_cache.sql` |
| 前端顯示（已向 PSA 查證 · 連到官網） | `src/components/PsaBadge.vue`、用在 `src/components/PrizeTable.vue` |
| 前端查證方法 / 對不上時的確認 | `src/lib/api.ts` 的 `verifyCert`、`src/pages/SellerNewPoolPage.vue` |

`token` 只在後端（`env.PSA_API_TOKEN`），絕不進前端 bundle。查到的結果快取進
`psa_certs`（一張卡一輩子查一次，配額每天才 100 次）；**只快取成功查到的**，
not_found / api_unavailable 不快取（理由見 migration 020）。

### 五種分支的行為（開池端）

| 查證結果 | 行為 |
|---|---|
| `invalid_format`（編號格式錯，PSA 回 `IsValidRequest:false`） | **擋**，不准進池 |
| `not_found`（格式對但查無此卡＝假編號，`IsValidRequest:true` + `No data found`） | **擋**，不准進池 |
| `api_unavailable`（403／500／429／網路錯） | 預設**不硬擋**，卡標 `pending`（未驗證），記 log、當我方問題 |
| `not_configured`（沒設 token） | 預設**不硬擋**，卡標 `pending` |
| 查到但 PSA 的 `CardNumber` 跟賣家挑的卡對不上 | 回 `CERT_MISMATCH`，要賣家**確認是同一張**（`certConfirmed`）才放行 |

「暫時無法驗證就標 pending 不硬擋」是刻意的：API 現在全 403，硬擋等於**完全
開不了鑑定卡的池**。500 一律當「我方憑證問題」記錄，**不對賣家說 PSA 掛了**。

### 明天 PSA 核准後，要做的（不用改任何一行程式碼）

1. **核准本身**：`env.PSA_API_TOKEN` 已經在 Railway 設好。PSA 一旦把帳號改成
   approved，同一段程式就會開始從 `cert/GetByCertNumber` 拿到真資料、回 `ok`
   —— `api_unavailable` 自動消失，鑑定卡開始標成 `verified`。**這一步只等 PSA，
   我方不動任何東西。**
2. **從「暫不驗證」切成「強制驗證」**：把 Railway 環境變數
   **`PSA_VERIFY_ENFORCE` 設成 `1`**。這會讓 `api_unavailable` / `not_configured`
   從「標 pending 放行」變成「驗不過就開不了鑑定卡的池」（回 `VERIFY_REQUIRED`）。
   預設是 `0`（不強制）。**這是明天要動的唯一一格設定。**
   - 已實測：`PSA_VERIFY_ENFORCE=1` 時，帶查不到的鑑定編號開池回
     `503 VERIFY_REQUIRED`；`=0`（預設）時同一個請求池照開得成、卡標 pending。

### 測試（不打正式環境的 PSA）

`server/src/psa.ts` 有一個 **`PSA_STUB=1`** 的注入：用 cert 編號的前綴選分支
（`STUB-OK-<卡號>` / `STUB-NOTFOUND` / `STUB-INVALID` / `STUB-403` / `STUB-500`
/ `STUB-NOTCONFIG`），smoke 靠它在一台伺服器、不碰網路的情況下把每一條分支都
走一遍。正式環境**不設 `PSA_STUB`** 就走真的 PSA。煙霧測試對應的檢查在
`server/src/smoke.ts` 的「PSA 鑑定編號查證」一節（沒開 stub 時整段自動跳過）。

### 還沒做（刻意的）

- **不下載或轉存 PSA 的照片**：EULA 未確認（見第 6 節）。`verified` 的卡是
  連到 `psacard.com/cert/{certNo}` 讓買家自己去對，不是把 slab 照片搬過來。
- 顯示先只做在池頁的獎項表（`PrizeTable`）。卡冊 / 分享頁要不要一起標，等
  API 真的回得了資料、看得到實際樣子再決定。
