# 正式站上傳檢查（2026-09-15）

範圍：前端 https://ademczw.github.io/tcg-draw-frontend/ → 後端 https://web-production-154871.up.railway.app → Cloudflare R2 直傳。
這次**沒有**建帳號、沒有登入、沒有上傳任何檔案、沒有改 R2 或 Railway 設定。所有檢查都是唯讀的（curl、OPTIONS 預檢、headless Chromium 對不存在的物件做未簽名 GET）。
帳號 id 以下一律寫成 `632d***`，bucket 名稱是 `vaultdraw`。

## 總結

| # | 檢查 | 結果 |
|---|------|------|
| 1 | 上傳流程與程式對得上 | 通過 |
| 2 | 前端 CSP 放行 path-style 的 R2 主機 | 通過（真瀏覽器實測） |
| 3 | R2 bucket 的 CORS（正式站來源的 PUT 預檢） | 通過 |
| 4 | presign 端點在正式站活著 | 通過（未登入回 401） |
| 5 | 預檢允許的 header 涵蓋前端實際送的 | 通過 |
| 6 | 帶簽章的 PUT 真的寫得進去 | **無法確認**（要登入才拿得到簽名網址，需使用者親自測） |
| 附 | 本機 5175 埠的 CORS | 不通過（只影響本機開發，見下） |

結論：**從外面能驗的每一段都是通的**。剩下唯一沒驗到的是「簽章本身對不對」，只能靠一次真的登入上傳。

---

## 1. 上傳流程

程式：`src/lib/uploads.ts`、`server/src/routes/files.ts`、`server/src/r2.ts`、`server/src/routes/cardbook.ts`。

1. **要通行證**：前端 `POST {API}/v1/files/presign`，header `authorization: Bearer <token>`、`content-type: application/json`，body `{ purpose, mime, bytes }`（mime/bytes 是裁切壓縮**之後**的值）。
   後端驗 purpose/mime/大小 → 寫一列 `files` → 回 `{ fileId, uploadUrl, key }`。
2. **直傳**：前端用 XMLHttpRequest `PUT uploadUrl`，只手動設 `content-type: <file.type>`；`content-length` 由瀏覽器自動帶（等於 presign 時的 bytes）。
   `uploadUrl` 格式（path-style，`forcePathStyle: true`）：
   `https://632d***.r2.cloudflarestorage.com/vaultdraw/<purpose>/<userId>/<20 hex>.<ext>?X-Amz-...&X-Amz-SignedHeaders=content-length%3Bhost`，10 分鐘有效。
3. **沒有「通知後端完成」這一步**。前端拿 `fileId` 塞進後續表單（例如登記卡片），後端在那時用 `HeadObject`（`objectState()`）確認物件真的在：不在回 400 `BAD_CARD_IMAGE`，問不到 R2 回 503 `IMAGE_CHECK_UNAVAILABLE`。
4. **顯示**：圖片 `<img src="{API}/v1/files/<id>/raw">` → 302 到簽名 GET 網址（正式環境沒設 `R2_PUBLIC_URL`，所以走簽名網址，主機同樣是 `632d***.r2.cloudflarestorage.com`）。

## 2. 前端 CSP

正式站 HTML 的 meta CSP（實抓）：

```
img-src     'self' data: blob: https://web-production-154871.up.railway.app https://assets.tcgdex.net https://632d***.r2.cloudflarestorage.com
connect-src 'self' https://web-production-154871.up.railway.app https://api.tcgdex.net https://632d***.r2.cloudflarestorage.com
```

- CSP 裡的帳號 id 跟 Railway 的 `R2_ACCOUNT_ID` 完全一致。
- API 網域在 img-src 與 connect-src 都有（/raw 與 presign 都需要）。
- **真瀏覽器實測**（headless Chromium 開正式站，在頁面裡 fetch）：
  - path-style `https://632d***.r2.cloudflarestorage.com/vaultdraw/…`：**沒有** CSP 違規事件（請求有送出，只是未簽名被 R2 退）。
  - virtual-hosted `https://vaultdraw.632d***.r2.cloudflarestorage.com/…`：觸發 `connect-src` 違規。
  - 也就是說之前的事故原因判斷正確，`forcePathStyle: true` 這個修法方向對。

結果：**通過**。

## 3. R2 CORS 預檢

```
OPTIONS https://632d***.r2.cloudflarestorage.com/vaultdraw/test.jpg
Origin: https://ademczw.github.io
Access-Control-Request-Method: PUT
Access-Control-Request-Headers: content-type
```

回應：

```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://ademczw.github.io
Access-Control-Allow-Headers: content-type
Access-Control-Allow-Methods: GET, HEAD, PUT
Access-Control-Max-Age: 3600
```

其他來源：
- `http://localhost:5173` → 204，放行。
- `http://localhost:5175` → 403 `CORS not configured for this bucket`（不在允許清單）。
- `https://evil.example` → 403（清單不是萬用字元，好事）。
- GET 預檢（給 /raw 導過去的圖用）→ 204，放行。

結果：**通過**。bucket 已經設好 CORS，不需要改。

### 本機 5175 埠（非必要，選擇性修）

`vite.config.ts` 預設是 5173，只有用 `PORT=5175` 起開發伺服器時會碰到。若要支援，把 R2 bucket 的 CORS 換成下面這份（貼到 Cloudflare 後台 → R2 → vaultdraw → Settings → CORS Policy）：

```json
[
  {
    "AllowedOrigins": [
      "https://ademczw.github.io",
      "http://localhost:5173",
      "http://localhost:5175"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

（若之後又壞掉、預檢回 403，也是貼這一份。）

## 4. presign 端點

```
POST https://web-production-154871.up.railway.app/v1/files/presign   （不帶 token）
→ HTTP 401  {"error":"UNAUTHORIZED","message":"請先登入"}
   access-control-allow-origin: https://ademczw.github.io
   access-control-allow-credentials: true
```

- 對照組：不存在的路徑 `/v1/files/presign-nope` 回 404，所以 401 確實是這條路由在回。
- 瀏覽器對 presign 的預檢（`authorization, content-type`，來源 github.io）→ 204，允許這兩個 header 與 POST。

結果：**通過**。

## 5. header 是否涵蓋

前端 PUT 時手動設的 header 只有 `content-type`（`src/lib/uploads.ts` 的 `putDirect`）。`content-length`、`host` 是瀏覽器自己帶的「禁止由程式設定」的 header，**不會**出現在預檢的 `Access-Control-Request-Headers` 裡，所以不需要被 CORS 允許。

- R2 允許 `content-type` → 涵蓋。
- 簽章簽的是 `content-length;host`，不含 content-type，所以 content-type 送什麼都不影響簽章。
- 附註：用 curl 手動把 `content-length` 放進 Request-Headers 會拿到 403，但真瀏覽器永遠不會這樣送，不是問題。

結果：**通過**。

## 6. 帶簽章的 PUT 能不能寫入 —— 無法確認

要登入才拿得到簽名網址，而這次不能登入、不能上傳。從程式看起來是對得上的（壓縮後才 presign，PUT 的就是同一個 File，大小一致）。

---

## 發現的程式問題（沒有修，只記錄）

**R2 的錯誤回應不帶 CORS header，前端的失敗分類可能會誤判。**

實測：對 R2 的未簽名 GET，R2 回 `400 InvalidArgument`，回應裡**沒有** `Access-Control-Allow-Origin`。在瀏覽器裡這不會變成「HTTP 400」，而是 `Failed to fetch`（XHR 的 `onerror`、status 0）。

推論（未以帶簽章的請求實測）：如果簽名 PUT 被 R2 拒絕（例如 403 簽章不符、網址過期），瀏覽器很可能同樣拿不到狀態碼。那 `src/lib/uploads.ts` 裡 `xhr.onload` → `rejected（HTTP 403）` 那條路永遠走不到，而會落到 `onerror`：
- 還沒送出位元組且很快失敗 → 被分成 `blocked`（文案說「站台上傳設定有問題」）
- 已經送出一部分 → 被分成 `interrupted`（文案說「網路不穩，請重試」）—— 這一種會誤導使用者一直重試。

影響：只影響「失敗時的診斷文字」，不影響上傳成功與否。若要修，方向是 onerror 時不要把 `progressed=y` 直接斷定為網路中斷（例如 `pct` 已到 99 仍失敗，較可能是被拒），或文案承認兩種可能。

---

## 使用者要做的最後確認（需要登入）

1. 用一般瀏覽器（桌機 Chrome 最好，方便看主控台）打開 https://ademczw.github.io/tcg-draw-frontend/ 並登入。
2. 按 F12 打開開發者工具，切到 **Network**（網路）分頁，勾選「Preserve log」。
3. 進「我的卡冊」→「登記卡片」（網址 `/me/cards/upload`），在正面照那一格選一張 JPG/PNG（小一點就好）。
4. 裁切框按確定，看進度條。
5. **成功的樣子**：
   - Network 裡有 `presign`（POST，200），接著一個對 `632d….r2.cloudflarestorage.com/vaultdraw/card-front/...` 的 `OPTIONS`（204）與 `PUT`（200）。
   - 注意 PUT 的網址主機**不能**是 `vaultdraw.632d…`（那代表 path-style 沒生效）。
   - 縮圖顯示完成，登記卡片送出後卡冊裡的圖片看得到（那一步會走 `/v1/files/<id>/raw` → 302 → R2）。
6. **失敗的樣子**：該格下方會出現說明文字，以及一行以 `VD-UP` 開頭的**診斷碼**和「複製診斷碼」按鈕。請把這整行貼回來，重點看：
   - `ph=presign` → 卡在跟後端要通行證。`st=401` 是登入失效；`c=NOT_CONFIGURED` 是後端 R2 沒設好。
   - `ph=transfer st=0 prog=n` 且 `ms` 很小 → 連線沒建立，先看 **Console**（主控台）有沒有紅字：
     - 含 `Content Security Policy` / `connect-src` → CSP 問題（多半是網址變成 virtual-hosted 或 GitHub Variable `VITE_R2_UPLOAD_ORIGIN` 被改掉）。
     - 含 `CORS` / `Access-Control-Allow-Origin` → R2 bucket CORS 被改掉，貼上第 3 段的 JSON。
     - 都沒有 → 看 Network 裡那個 PUT 的狀態碼（403 = 簽章不對，把狀態碼與 R2 回的 XML 錯誤碼截圖回報；**不要**截到網址裡的 `X-Amz-Signature` 參數）。
   - `ph=transfer prog=y` → 傳到一半斷。可能是網路，也可能是 R2 拒收（見上面「發現的程式問題」），同樣看 Network 裡 PUT 的狀態碼。
   - 選完圖、登記送出時才出錯：`BAD_CARD_IMAGE`「沒有上傳完成」代表 PUT 其實沒成功；`IMAGE_CHECK_UNAVAILABLE` 代表後端問不到 R2（稍後再試）。
7. 測完若不想留那張卡，照平常方式從卡冊刪掉即可。
