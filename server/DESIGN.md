# VaultDraw 後端 —— 設計規劃

**日期**：2026-08-18
**狀態**：規劃定案，分階段實作中（見第 10 節進度）
**目標讀者**：負責實作或接手後端的工程師 / agent。本文件應可獨立閱讀。

## 1. 這是什麼

VaultDraw 是台灣的鑑定寶可夢卡線上抽選（オリパ）平台。後端負責：帳號、點數帳本、賣家、抽卡池與可驗證的公平抽選、獎品保管與提領、回收換點、市場與託管訂單、檔案儲存、後台管理。

前端是 Vue 3 + Vite，部署在 GitHub Pages。後端是 **Railway + TypeScript (Hono) + Postgres**，檔案放 **Cloudflare R2**。

## 2. 三條不能破的線

這三件事貫穿所有設計，任何新功能都要先對一次：

1. **點數永不可提現。** 這是 `src/lib/recycle.ts` 那整套法律論述（刑法 266 對價關係）的地基。價值一旦能流出平台，前面所有論述同時失效。所以：市場只結算點數、回收只給點數、沒有任何端點會把點數變成錢。
2. **點數只存帳本，不存餘額。** 餘額 = `SUM(delta)`；凍結 = 由進行中的訂單、有效出價推算。存欄位就會有跟帳本對不起來的一天，而且對帳時你不知道該信哪個。前端已經踩過一次。
3. **抽選結果在開賣前就決定好，而且事後可驗證。** 前端到處宣稱 commit-reveal，但 mock 是抽的時候才 `Math.random()`。後端不能重複這個矛盾。

## 3. 決策記錄

| 決策點 | 選擇 | 原因 / 放棄了什麼 |
|---|---|---|
| 語言 | TypeScript | 規則（`src/shared/`）跟前端同一份，不寫兩遍。Python 留給之後的影像處理小服務 |
| 框架 | Hono | 小、快、型別友善、Node 上跑。不用 Express（型別差）不用 Nest（太重） |
| 資料庫 | Postgres，raw SQL | 錢的正確性靠明確的交易邊界與 `FOR UPDATE`，ORM 會把這兩件事藏起來。表不多，抽象層的麻煩大於好處 |
| 檔案 | Cloudflare R2，presigned URL 直傳 | Railway 檔案系統是暫時的；檔案不經過 API server；R2 出站免費 |
| 快取 / 佇列 | 暫不引入 Redis | 現在沒有任何功能需要它。速率限制先用 Postgres；真的需要時再加 |
| 驗證 | LINE Login（主）+ Email 密碼（備援），JWT 30 天 | 台灣使用者主流是 LINE；不申請 email 權限（要審核且非必要），用 LINE userId 識別。Google 之後接同一張 `auth_identities` |
| 公平抽選 | 開池時預洗籤序（commit-reveal + 外部亂數） | 見第 5 節。放棄「每次抽選獨立算」—— 那是轉盤遊戲的模型，オリパ的籤位有實體意義（剩幾張、剩什麼賞） |
| 外部亂數來源 | drand（League of Entropy），開池時鎖定一個未來的 round | 專門為此設計、公開可查、不能被單方影響。放棄 BTC 區塊雜湊（可行但礦工理論上可影響）。來源做成可替換 |
| 籤位併發 | `pool_seats` 每格一列，條件式 UPDATE 搶佔 | 兩人同時選 78 號，只有一個 UPDATE 會影響到列。不需要 Redis 鎖 |
| 多籤抽選 | 全成功或全失敗，回傳衝突的籤位 | 部分成功的語意太複雜（付了 3 張只拿到 2 張？）。前端拿到衝突清單重選 |
| 時限推進 | 「拉」不是「推」：讀取時重算 + 排程掃 | 排程不是唯一真相，掛掉只會晚結案不會算錯。跟託管訂單同一套 |
| 金流 | 暫不接，點數由後台發放（`/admin/grant`，每筆稽核） | 需要商家帳號與合約，等系統測試完再談。`topups` 表已建，屆時只接 webhook |
| 平台角色 | `users.role in ('user','admin')`；賣家是獨立實體 | 一個使用者可以同時是買家和賣家；admin 是平台營運 |
| 賣家統計 | 全部即時計算，不存 | 跟餘額同一個道理。開池數、出貨數、爭議率都是查詢 |

## 4. 資料存放

```
Postgres（Railway）    所有交易性資料。表見第 6 節
Cloudflare R2          檔案：池封面、出貨照、開箱影片、賣家驗證文件、頭像
                       後端只存 object key；瀏覽器用 presigned URL 直傳、直讀
外部（不存）           卡圖來自 tcgdex CDN（有 CORS），前端直接取
Railway logs           應用日誌
```

**檔案保存期限**（先定預設，可調）：

| 用途 | 保存 |
|---|---|
| 出貨照、開箱影片 | 訂單結案後 90 天，之後刪 |
| 賣家驗證文件 | 賣家帳號存續期間；停用後 30 天刪 |
| 池封面、頭像 | 隨實體 |

**Postgres 備份**：Railway 提供每日快照；上線前另外設 `pg_dump` 到 R2 的每日排程（另案）。

## 5. 公平抽選：commit-reveal + 預洗籤序

### 生命週期

```
draft ──► committed ──► open ──► sold_out ──► revealed
 建池      產生 server_seed   取得 client_seed        公布 server_seed
          公布 commit_hash    算出籤序、寫入 pool_seats
          宣告 client_seed_source
```

1. **committed**：伺服器產生 32 bytes 的 `server_seed`（只有伺服器知道），公布 `commit_hash = SHA256(server_seed)`，並宣告 `client_seed_source = drand:<未來的 round>`。這一步之後任何人都無法再換 seed。
2. **open**：那個 drand round 到了，取得公開亂數當 `client_seed`。伺服器算 `sequence = shuffle(prizes, HMAC-SHA256(server_seed, client_seed))`，把每個籤位對應到哪個獎寫進 `pool_seats`。從此籤位→獎品固定。
3. **抽選**：玩家選籤位，拿到那格的獎。伺服器只查表。
4. **revealed**：池完抽（或關閉）後公布 `server_seed`。任何人可以驗：`SHA256(server_seed) == commit_hash`，並用同一個 shuffle 重算出同一份籤序。

### 為什麼需要 client_seed

沒有它，伺服器可以生一堆 seed、算出籤序、挑一個「大獎剛好在自己人會選的籤位」的。有了**開池後才出現**的外部亂數，伺服器在 commit 時不知道最終籤序會長怎樣，也就無從挑選。

### 洗牌演算法（`src/shared/fairness.ts`）

- 獎品清單依 `total` 展開成長度 = 總籤數的陣列
- Fisher-Yates，亂數來自 `HMAC-SHA256(server_seed, client_seed || counter)` 的 counter mode 位元組流
- 取區間內整數用**拒絕取樣**，不用取餘數（取餘數有偏差，會被抓到）
- 用 WebCrypto（`crypto.subtle`），Node 20+ 和瀏覽器都有 → **前端的公平性頁面可以在瀏覽器裡重算驗證**，不用信後端

### 各模式怎麼疊在這個模型上

| 模式 | 差異 |
|---|---|
| classic | 基本款。完抽時最後賞加贈給最後一抽 |
| shitei | 抽中指定賞即結束並送最後賞 |
| muteki | 最後賞也在池裡可抽 |
| streak | 付入場費，連續抽、暫持、收手落袋或爆掉。爆掉時暫持沒收但發保底卡（必得商品） |
| auction | 最後 N 籤轉為競標，出價凍結點數，被超過即解凍，接近結束自動延長 60 秒 |

**所有模式共用同一份 `pool_seats`**，只是誰能抽、抽完發生什麼不同。

## 6. 資料表

```
users               id, email?, password_hash?, name, role, created_at
auth_identities     user_id, provider, provider_uid          (LINE / Google 之後接)
points_ledger       user_id, delta, reason, ref_id           只能追加；ledger_once 唯一索引擋重複
topups              user_id, amount_twd, points, provider, provider_ref, status

sellers             id=user_id, handle, origin, tier, bio, avatar_file_id
seller_verifications seller_id, doc_file_id, status, reviewed_by

pools               seller_id, mode, title, cover_file_id, ticket_price, total_tickets,
                    status, server_seed(secret), commit_hash, client_seed_source, client_seed,
                    shitei_tier?, auction_seats?, revealed_at
pool_prizes         pool_id, tier, card jsonb, total
pool_seats          pool_id, seat, prize_id, taken_by?, taken_at?, draw_id?   ← 併發防線
draws               pool_id, user_id, seats[], cost
streak_runs         pool_id, user_id, entry_cost, status, drawn_seats[], held_value
auction_lots        pool_id, seat, start_bid, ends_at, status, winner_id
bids                lot_id, user_id, amount, is_top

prizes              user_id, pool_id, seat, card jsonb, tier, status, won_at, stash_expires_at
shipments           user_id, prize_ids[], address jsonb, status, tracking

listings            (已建) + cert_no 唯一索引擋一卡多賣
orders              (已建) 託管訂單
idempotency         (已建)

files               owner_id, purpose, key, mime, bytes, expires_at
```

**可動用點數**的完整定義：

```
available = SUM(points_ledger.delta)
          - SUM(orders.price    where buyer_id  = me and status open)
          - SUM(orders.deposit  where seller_id = me and status open)
          - SUM(bids.amount     where user_id   = me and is_top and lot live)
```

## 7. API 面

沿用 `src/shared/contract.ts` 的風格：錯誤用字串碼、每個端點對應一個狀態轉換。

```
auth        POST /v1/auth/register  /login  ;  GET /v1/auth/me
wallet      GET  /v1/wallet  (points / locked / available / ledger)
pools       GET  /v1/pools  /v1/pools/:id  ;  POST /v1/pools (賣家)
draw        POST /v1/pools/:id/draw   { seats[], idempotencyKey }
streak      POST /v1/pools/:id/streak  ;  POST /v1/streaks/:id/draw  /bank
auction     GET  /v1/pools/:id/lots  ;  POST /v1/lots/:id/bid
prizes      GET  /v1/prizes  ;  POST /v1/prizes/:id/recycle  ;  POST /v1/shipments
market      GET  /v1/listings  ;  POST /v1/listings  ;  (orders 已建)
files       POST /v1/files/presign
fairness    GET  /v1/pools/:id/reveal   (revealed 之後才有 server_seed)
admin       POST /v1/admin/pools/:id/open  ;  /sellers/:id/verify  ;  /credit  ;  /orders/:id/resolve
```

## 8. 明確排除的範圍（本階段不做）

- ❌ 金流供應商的實際整合（先建帳本與 webhook 落點）
- ❌ LINE / Google 登入（schema 已預留）
- ❌ Redis、佇列、WebSocket 推播（競標更新先用輪詢）
- ❌ 物流商 API 串接（單號只驗格式，已標記為佔位）
- ❌ 影像處理（盜圖偵測、OCR 讀鑑定編號）—— 那是 Python 小服務的事
- ❌ 後台的網頁介面（先只有 API，用 curl / 前端 admin 頁之後再做）

## 9. 還沒定、需要你決定的

1. ~~登入方式~~ → 已定：LINE 主、Email 備援
2. ~~保管到期~~ → 已定：只通知不處理，管理費之後另外研究
3. ~~金流~~ → 已定：先不接，點數由後台發放
4. ~~battle / niboichi~~ → 已定：不是正式玩法，已從 PoolMode 移除，不用再規劃

## 10. 實作階段與進度

| 階段 | 內容 | 狀態 |
|---|---|---|
| 0 | 託管訂單、帳本、種子、煙霧測試 | ✅ 已完成 |
| 1 | 遷移 002（全部資料表）、公平抽選模組 + 自我測試、抽選端點、獎品/回收/出貨申請、Email 登入、錢包 | ✅ 已完成（待接 DB 跑 smoke） |
| 2 | LINE Login、後台端點（發點數／審賣家／稽核）、出貨申請 | ✅ 已完成 |
| 2b | 檔案（R2 presign／讀取）| ✅ presign+讀取已完成；賣家申請端點待做 |
| 3 | streak、auction 端點 | 待做 |
| 4 | 前端從 mock 切到 API（VITE_API_URL 決定模式；連莊／競標仍走 mock 直到階段 3） | ✅ 已完成 |
| 5 | 金流 webhook、備份排程 | 待規格 |
