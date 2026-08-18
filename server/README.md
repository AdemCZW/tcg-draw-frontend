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
3. 環境變數只需要補兩個：
   - `JWT_SECRET`：32 字元以上的隨機字串
   - `CORS_ORIGINS`：`https://ademczw.github.io`
4. `railway.json` 已經設定啟動時先跑遷移

Root Directory 要設對，因為這是 monorepo —— 共用模組在 `../src/shared`，
tsup 打包時會把它一起 inline 進 `dist/index.js`。

## 三個不能省的正確性設計

**1. 交易邊界。** 建立訂單是「檢查掛單 → 檢查餘額 → 改掛單狀態 → 建訂單」，
全部在一個 transaction 裡，而且掛單那筆是 `SELECT ... FOR UPDATE`。
少了這個鎖，兩個人同時買同一張卡會兩邊都通過檢查、兩邊都成立。

**2. 點數只存帳本。** 沒有 balance 欄位，也沒有 locked 欄位：
餘額是 `SUM(delta)`，凍結是「進行中訂單的貨款 + 我押的保證金」。
存欄位就會有跟帳本對不起來的一天，而且對帳時你不知道該信哪個。

**3. 結算可以重試。** 每筆分錄都帶 `order_id`，靠 `ledger_once` 唯一索引擋重複。
逾期掃描可能同時被多個請求觸發，沒有這層保護就會重複入帳。

## 時限怎麼推進

「拉」不是「推」：每次讀訂單時用當下時間重算（`sweep()`），
另外掛一支五分鐘的排程掃沒人看的訂單。

排程**不是唯一真相** —— 它掛掉不會讓狀態算錯，只會讓結案晚一點。
這是刻意的：前端跟後端都用同一套時間戳推算，不依賴某個一定要活著的排程器。

## 還沒做（上線前必須補）

- **真正的登入。** 現在 `/v1/auth/login` 給 handle 就發 token，等同前端的 MOCK。
- **物流單號查驗。** `looksLikeTracking()` 只擋格式，擋不掉「填別人的舊單號」。
  要打物流商 API 確認單號存在、交寄時間晚於訂單成立。
- **簽收改成 webhook。** `POST /orders/:id/delivered` 現在限平台帳號呼叫（給測試用），
  接上真的物流之後要改成驗物流商的簽名，並拿掉平台帳號這條路。
- **出貨照與開箱影片的實際儲存。** 目前只驗 URL 格式，沒有上傳流程。
- **平台裁決的後台。** `/resolve` 現在只認 `u-platform` 這個帳號，沒有權限系統。
- **速率限制**與濫用防護。
