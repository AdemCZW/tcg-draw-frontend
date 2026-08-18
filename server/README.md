# vaultdraw-server

Railway + TypeScript + Postgres。託管訂單的後端。

規則不在這裡 —— 在 `../src/shared/escrow.ts`，跟前端同一份。
這個服務只負責把規則的判斷寫進資料庫、結算點數，並擋住併發。

## 跑起來

```bash
cp .env.example .env      # 填 DATABASE_URL 與 JWT_SECRET
npm install
npm run migrate
npm run dev
```

`npm run selftest` 不需要資料庫 —— 它在 Node 裡直接跑共用模組的規則，
用來確認 `src/shared` 沒有偷偷相依前端的東西。

## 部署後一定要跑的驗證

```bash
npm run seed                                     # 塞測試用的使用者、點數、掛單
npm run smoke -- https://你的服務.up.railway.app   # 對真的服務跑端到端
```

`smoke` 是這個專案**最重要的一支測試**。selftest 只驗規則（純函式），
但這個系統真正會出事的地方是資料庫那一層 —— 交易邊界、`SELECT FOR UPDATE`、
帳本一致性 —— 那些沒有真的 Postgres 驗不了。

它會做的事：兩個請求**同時**買同一張卡（驗鎖有沒有真的鎖住）、
確認貨款是凍結不是扣款、走完出貨→簽收→確認→放款、確認只扣一次錢、
庫內轉移不產生訂單直接過戶。**會改資料，不要對正式環境跑。**

種子跟煙霧測試都用 `DATABASE_URL`，所以要先在本機的 `.env` 填上
Railway 那組連線字串（Railway 的 Postgres 頁面 → Connect → Public URL），
或直接用 `railway run npm run seed`。

## 部署到 Railway

1. 新建專案 → **Add Postgres**（會自動注入 `DATABASE_URL`）
2. 從 GitHub 部署，**Root Directory 設成 `server`**
3. 環境變數：
   - `JWT_SECRET`：32 字元以上的隨機字串
   - `CORS_ORIGINS`：`https://ademczw.github.io`
   - `PUBLIC_URL`：Railway 給你的後端網址（組 LINE 的 redirect_uri 用）
   - `FRONTEND_URL`：`https://ademczw.github.io/tcg-draw-frontend`
   - `LINE_CHANNEL_SECRET`：LINE Developers → channel → Basic settings（**只放這裡，不進 git**）
   - `DEV_LOGIN=1`：**只在測試環境**。開啟 `/v1/auth/dev-login`（給 handle 就發 token）讓 smoke 能跑；正式環境不要設
   - `R2_ACCOUNT_ID` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`：Cloudflare R2 → 你的 bucket。
     Access Key / Secret 從 R2 → Manage API Tokens 建立，**只放這裡，不進 git**
   - `R2_PUBLIC_URL`（可選）：bucket 開了公開讀取（r2.dev 開發網域或自訂網域）才填，
     沒填的話所有檔案都走簽名網址讀取——這是安全的預設值，不填也能動
4. `railway.json` 已經設定啟動時先跑遷移

Root Directory 要設對，因為這是 monorepo —— 共用模組在 `../src/shared`，
tsup 打包時會把它一起 inline 進 `dist/index.js`。

## 端點

```
POST /v1/auth/register  /login   GET /v1/auth/me
GET  /v1/auth/line/start  → 302 到 LINE  → /v1/auth/line/callback → 302 回前端 /login#token=…
POST /v1/admin/grant  (發點數，note 必填)   /v1/admin/sellers/:id/tier
GET  /v1/admin/users  /users/:id/wallet  /actions  (稽核)
GET  /v1/wallet
GET  /v1/pools  /v1/pools/:id  /v1/pools/:id/reveal
POST /v1/pools  (賣家)  /v1/pools/:id/open  /:id/draw  /:id/reveal
GET  /v1/prizes   POST /v1/prizes/:id/recycle  /v1/prizes/ship
GET  /v1/listings
GET/POST /v1/orders ...（託管，見 ../src/shared/contract.ts）
POST /v1/files/presign  (拿上傳用的簽名網址)   GET /v1/files/:id  (拿讀取用的網址)
GET  /v1/sellers  /v1/sellers/:id   GET /v1/winners   POST /v1/listings
```

完整設計、決策記錄、資料表：**DESIGN.md**。

## 三個不能省的正確性設計

**1. 交易邊界。** 建立訂單是「檢查掛單 → 檢查餘額 → 改掛單狀態 → 建訂單」，
全部在一個 transaction 裡，而且掛單那筆是 `SELECT ... FOR UPDATE`。
少了這個鎖，兩個人同時買同一張卡會兩邊都通過檢查、兩邊都成立。

**2. 點數只存帳本。** 沒有 balance 欄位，也沒有 locked 欄位：
餘額是 `SUM(delta)`，凍結是「進行中訂單的貨款 + 我押的保證金」。
存欄位就會有跟帳本對不起來的一天，而且對帳時你不知道該信哪個。

**3. 結算可以重試。** 每筆分錄都帶 `ref_id`，靠 `ledger_once` 唯一索引擋重複。
逾期掃描可能同時被多個請求觸發，沒有這層保護就會重複入帳。

**4. 籤序開賣前決定、事後可驗。** 建池時產生 `server_seed` 只公布 `SHA256`，
client_seed 用開池後才出現的 drand round，籤序 = 兩者的 HMAC 洗牌，寫進 `pool_seats`。
抽選只是搶佔一列（`UPDATE ... WHERE taken_by IS NULL`）。池結束後公布 seed，
`GET /pools/:id/reveal` 給的資料可以用 `src/shared/fairness.ts` 在瀏覽器裡重算。

## 時限怎麼推進

「拉」不是「推」：每次讀訂單時用當下時間重算（`sweep()`），
另外掛一支五分鐘的排程掃沒人看的訂單。

排程**不是唯一真相** —— 它掛掉不會讓狀態算錯，只會讓結案晚一點。
這是刻意的：前端跟後端都用同一套時間戳推算，不依賴某個一定要活著的排程器。

## 還沒做（上線前必須補）

- **Google 登入與帳號綁定頁。** LINE 與 Email 已可用；同一個人用不同方式登入會是兩個帳號，
  要靠「綁定其他登入方式」合併（LINE 不申請 email 權限就拿不到 email，不能靠 email 自動合併）。
- **物流單號查驗。** `looksLikeTracking()` 只擋格式，擋不掉「填別人的舊單號」。
  要打物流商 API 確認單號存在、交寄時間晚於訂單成立。
- **簽收改成 webhook。** `POST /orders/:id/delivered` 現在限平台帳號呼叫（給測試用），
  接上真的物流之後要改成驗物流商的簽名，並拿掉平台帳號這條路。
- **ship-photo / unbox-video 的讀取權限只到「要登入」，還沒做到「只有這筆訂單的
  買賣雙方看得到」。** 現況是任何登入使用者只要知道 fileId 就能讀（key 本身不可猜測，
  但沒有跟訂單綁定做真正的存取控制）。要補的話：`files` 表加 `order_id`，
  `GET /v1/files/:id` 檢查呼叫者是不是那筆訂單的買家或賣家。
  seller-doc（身分文件）已經做到只有本人或平台能看，不受這條影響。
- **出貨照與開箱影片的實際儲存。** 目前只驗 URL 格式，沒有上傳流程。
- **平台裁決的後台。** `/resolve` 現在只認 `u-platform` 這個帳號，沒有權限系統。
- **速率限制**與濫用防護。
