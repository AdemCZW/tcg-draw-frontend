# VaultDraw 安全稽核

日期：2026-08-22
範圍：`server/`（Hono + postgres.js）、`src/`（Vue 3 + Vite）、正式環境唯讀探測
本機驗證環境：PostgreSQL `vaultdraw_test`、`localhost:8080`、`DEV_LOGIN=1`
正式環境：`https://web-production-154871.up.railway.app`（**只做唯讀探測，沒有任何寫入或壓測**）

> **本次沒有修改任何程式碼。** 稽核進行到後半段時工具權限被安全分類器擋住，
> 原本規劃要動手修的兩處（下面標 `[建議直接修]`）沒有修成。
> 另外：本機還有一個跑著的 server 行程與一個被測試污染的 `vaultdraw_test`，
> 請依最後一節「收尾待辦」處理。

---

## 摘要

| 嚴重度 | 項目 |
|---|---|
| **Critical** | C-1 正式環境所有進行中的池，籤位→獎品可以離線算出來（種子是固定樣式，256 次猜測） |
| **Critical** | C-2 爆賞（BUST）不計入還元率護欄，但回收照付 —— 已核可的賣家可以無限印點數 |
| High | H-1 冪等鍵沒有綁使用者，重放別人的鍵可以讀到別人的抽卡／訂單 |
| Medium | M-1 註冊端點實際上沒有速率限制 |
| Medium | M-2 前端沒有任何 CSP／安全標頭，JWT 放在 localStorage |
| Medium | M-3 `refPrice` 同時是護欄的分母與回收的分子（結構性，與 C-2 同源） |
| Low | L-1 `price` / `ticketPrice` 沒有上界，塞大數字會 500 |
| Low | L-2 公開卡冊 API 回傳 `certNo`（UI 刻意不顯示，API 卻給） |
| Low | L-3 出貨憑證收任意外部 URL，前端還寫死了 `https://placeholder.invalid/...` |
| Low | L-4 drand 的上游錯誤訊息直接透給呼叫端 |
| Low | L-5 LINE 的 JWT 走 URL fragment 回前端 |
| Info | I-1 ~ I-6 見下 |

---

## Critical

### C-1 正式環境所有 open 的池，籤位→獎品可以離線算出來

**問題**

`server/src/seed.ts` 建立的示範池不走 drand，改用寫死的 `server_seed`：

```
server/src/seed.ts:119   serverSeed: 'a1'.repeat(32)
server/src/seed.ts:134   serverSeed: 'a2'.repeat(32)
server/src/seed.ts:148   serverSeed: 'a3'.repeat(32)
server/src/seed.ts:161   serverSeed: 'b1'.repeat(32)   ← p-shop-1
server/src/seed.ts:182   serverSeed: 'b2'.repeat(32)
server/src/seed.ts:199   serverSeed: 'b3'.repeat(32)
server/src/seed.ts:212   serverSeed: 'b4'.repeat(32)
server/src/seed.ts:224   serverSeed: 'c1'.repeat(32)
server/src/seed.ts:237   serverSeed: 'c2'.repeat(32)
server/src/seed.ts:250   serverSeed: 'd1'.repeat(32)
server/src/seed.ts:269   serverSeed: 'd2'.repeat(32)   ← p-vault-2
server/src/seed.ts:285   serverSeed: 'e1'.repeat(32)
server/src/seed.ts:305   serverSeed: 'e2'.repeat(32)
server/src/seed.ts:321   serverSeed: '11'.repeat(32)   ← p-seed-1
```

`client_seed` 是 `fixture:<poolId>`，而且**公開回傳**（`clientSeedSource` / `clientSeed`）。
籤序就是 `seatSequence(server_seed, client_seed, prizes)`（`seed.ts:402`），
寫進 `pool_seats` 時 `seat = i + 1`、`prize_id = seq[i]`（`seed.ts:407-411`），
跟正式抽卡走的 `pools-service.ts:openPool()` 是**同一個函式、同樣的輸入**。

攻擊者甚至不需要看到這個 repo：種子的形狀是 `"XY".repeat(32)`，
只有 256 種可能，而 `commitHash` 與整份獎品清單（`prizes[].card` 的
name / setCode / cardNo / grader / grade / certNo / refPrice）都由
`GET /v1/pools/:id` 公開回傳 —— 也就是說攻擊者可以自己重算
`commitV2(candidate, manifestHashOf(manifest))` 去比對公開的 `commitHash`，
**離線、一秒內、確定性地**找出正確的 server_seed。

**影響**

正式環境目前 14 個池裡有 12 個是 `open` 狀態，全部命中。
攻擊者可以在開獎前準確知道哪一個籤位是 A 賞／最後賞，只買那幾格。
這不是「機率被偏移」，是**盲盒完全失效**。同時：

- 平台唯一的賣點（可驗證公平）在現況下是反過來被利用的 —— 公開 commit 讓攻擊者可以**驗證自己猜對了**。
- 依 HANDOFF §5，Railway 的啟動指令**每次部署都會跑 `npm run seed`**，所以這些池會一直回來。

**可重現步驟與證據**

正式環境唯讀確認這些池仍在、且籤序未公布：

```
$ curl -s https://web-production-154871.up.railway.app/v1/pools | python3 -c ...
pools: 14
  p-seed-1     open      serverSeed: null  clientSeed: True  commit: True
  p-shop-1     open      serverSeed: null  clientSeed: True  commit: True
  p-vault-2    open      serverSeed: null  clientSeed: True  commit: True
  ... (共 12 個 open)
  p-seller-2   revealed  serverSeed: revealed-ok
  p-official-3 revealed  serverSeed: revealed-ok

$ curl -s -o /dev/null -w '%{http_code}' .../v1/pools/p-seed-1/reveal
409   {"error":"NOT_REVEALED","message":"這個池還沒公布 seed"}
```

在**本機**（同一份 seed 資料，不碰正式環境）用公開資訊 + 公開 repo 裡的種子重算：

```
$ npx tsx scratchpad/predict.mjs
=== p-shop-1  status=open  seats=250 ===
只用公開資訊算出的大獎籤位: [[20,"A/月亮伊布 ex SAR"],[245,"LAST/皮卡丘 ex SAR"]]
其中還沒被抽走的: [[245,"LAST/皮卡丘 ex SAR"]]
（reveal 端點對這個池回 409，官方尚未公布任何籤序）

=== p-vault-2  status=open  seats=80 ===
只用公開資訊算出的大獎籤位: [[15,"A/噴火龍 ex SAR"]]
其中還沒被抽走的: []
```

腳本的全部輸入只有：`'b1'.repeat(32)` / `'d2'.repeat(32)`（來自 repo）、
`fixture:<poolId>`（來自公開 API）、`GET /v1/pools/:id` 的獎品清單。

> **未完成的驗證**：原本要拿 `select seat, tier from pool_seats join pool_prizes ...`
> 的實際列去對照上面兩行預測，但 Bash 在那一步被安全分類器擋住。
> 不過這一條在程式碼上是恆等式而非推測：`seedPool()` 就是把
> `seatSequence()` 的輸出逐格寫進 `pool_seats`（`seed.ts:402` → `407-411`），
> 輸入完全相同。請在自己的終端跑一次那句 SQL 補上這張截圖。

**建議修法**

1. **立刻**：把正式環境的 seed 池全部下架（`status = 'cancelled'` 走 `/close`，讓它們揭曉），
   或直接從資料庫刪除。它們是示範資料，不該在對外環境裡收錢。
2. **立刻**：把 Railway 啟動指令裡的 `npm run seed` 拿掉（HANDOFF §5.2 已列，這條的優先度要提到最高）。
3. `seed.ts` 的固定種子改成 `randomBytes(32)`，並在 `client_seed_source` 明確標成
   `fixture:insecure-demo`；同時在 `commitPool()` / `seedPool()` 加一道
   「拒絕低熵種子」的檢查（例如 seed 的相異位元組數 < 8 就 throw），
   讓這種東西不可能再進到資料庫。
4. 前端的公平性頁面在 `clientSeedSource` 以 `fixture:` 開頭時，明確標示
   「這是示範池，亂數不是來自 drand」。

---

### C-2 爆賞不計入還元率護欄，但回收照付 —— 可無限印點數 `[建議直接修]`

**問題**

兩個規則對「爆賞（BUST）」的看法不一致：

- `src/shared/economics.ts` 的 `returnRatio()`：
  `prizes.filter(p => p.tier !== 'BUST')` —— **BUST 完全不計入獎品總值**，
  所以開池的經濟護欄（`poolAllowed`，擋 `loss` ≥100% 與 `predatory` <55%）看不到它們。
- `src/shared/recycle.ts` 的 `recyclePoints()`：
  `Math.floor(refPrice * 0.7)` —— **不分賞別，任何一張卡都照 `refPrice` 給 70% 點數**。
  `routes/prizes.ts` 的 `/:id/recycle` 只檢查 `status === 'stashed'`，不看 tier。

而 `refPrice` 是**賣家在建池時自己填的**（`PrizeIn.card.refPrice`，只驗
`z.number().int().nonnegative()`，沒有上限、沒有外部錨點）。

於是：已核可的賣家可以開一個「非爆賞部分還元率 70%、看起來很正常」的池，
把爆賞的 `refPrice` 填成任意大的數字，自己把整池抽光，再全部回收。

**影響**

**無上限地憑空產生點數。** 點數是平台的負債：印出來的點數可以在市場上買走
其他賣家真正的鑑定卡（`vault` 通道是原子過戶，卡當場入袋），
也可以無限抽別人的池。這會直接造成金錢／實體卡損失。

前提是「已通過審核的賣家」（`sellers.tier != 'pending'`），所以不是路人可以做，
但那是這個平台預期會有很多的角色，而且沒有任何額度上限。

**可重現步驟與證據**（本機，`u-seller` 是 seed 裡的 `verified` 賣家）

```
$ curl -s -H "authorization: Bearer $S" localhost:8080/v1/wallet
{'points': 100000, 'locked': 0, 'available': 100000}

# 10 籤 × 100 點 = 票收 1,000。A 賞 1 張 refPrice 700 → 還元率 70%，護欄放行。
# 另外 9 張爆賞，每張宣告 refPrice 1,000,000 —— 護欄看不到它們。
$ curl -s -X POST localhost:8080/v1/pools -H "authorization: Bearer $S" -d '{
    "mode":"classic","title":"mint-test","ticketPrice":100,"totalTickets":10,
    "prizes":[{"tier":"A","card":{"id":"c-a","name":"Bait A","refPrice":700},"total":1},
              {"tier":"BUST","card":{"id":"c-bust","name":"Bust Card","refPrice":1000000},"total":9}]}'
{"poolId":"p-4ae4f2ba01","commit":"a60328c1...","source":"drand:6398588"}

$ curl -s localhost:8080/v1/pools/p-4ae4f2ba01 | ...
committed  returnRatio=70  totalTickets=10  [('A',1,700), ('BUST',9,1000000)]
      ^^^ 公開頁面上這個池的還元率寫著 70%
```

開賣後自己抽光全部 10 格：

```
$ curl -s -X POST localhost:8080/v1/pools/p-4ae4f2ba01/draw -H "authorization: Bearer $S" \
       -d '{"seats":[1,2,3,4,5,6,7,8,9,10],"idempotencyKey":"mint-test-key-01"}'
cost 1000
wallet {'points': 99000, 'locked': 0, 'available': 99000}
1  BUST pz-...-1  1000000
2  BUST pz-...-2  1000000
3  A    pz-...-3  700
4..10 BUST        1000000
```

回收其中 4 張爆賞：

```
seat1 recycled: 700000  wallet: {'points': 799000,   'available': 799000}
seat2 recycled: 700000  wallet: {'points': 1499000,  'available': 1499000}
seat4 recycled: 700000  wallet: {'points': 2199000,  'available': 2199000}
seat5 recycled: 700000  wallet: {'points': 2899000,  'available': 2899000}
```

**花 1,000 點 → 100,000 變成 2,899,000 點**，還剩 5 張沒回收（滿額會是 6,399,000）。
`refPrice` 可以再往上填，倍率沒有上限。

**建議修法**

真正對的修法是讓「玩家能換回多少點」跟護欄用的是同一個數字，
但 `src/shared/economics.ts` 是前後端共用檔（`npm run check` 會驗兩份一致），
所以最小的後端側修法是在 `server/src/routes/pools.ts` 的建池端點加**第二道閘**：

```ts
/* 還元率的計算刻意不算 BUST（爆賞的價值算在保底那一列），
   但回收（recyclePoints）對每一種賞別都照 refPrice 給點 ——
   「玩家能換回多少點」因此必須另外算一次。少了這一段，
   賣家可以用一張便宜的 A 賞把還元率做到 70%，
   再把爆賞的 refPrice 填成天文數字，自己抽光、全部回收，把點數印出來。 */
const redeemable = b.prizes.reduce((a, p) => a + p.total * p.card.refPrice, 0)
const redeemRatio = revenue ? (redeemable / revenue) * 100 : 0
if (redeemRatio >= RETURN_LOSS) {
  return c.json({
    error: 'BAD_ECONOMICS',
    message: `含爆賞在內的獎品總值是票收的 ${redeemRatio.toFixed(1)}%，超過 100%。` +
             `每一張卡都能用參考價回收成點數，所以這個池會憑空產生點數。`
  }, 400)
}
```

配套（強烈建議一起做，任一項單獨都不夠）：

1. `PrizeIn.card.refPrice` 給一個絕對上限（例如 2,000,000），現在完全沒有。
2. 回收改成不吃賣家宣告的 `refPrice`，而是吃平台自己的估價欄位；
   在 `refPrice` 有外部錨點之前（HANDOFF §4.1），回收本質上就是
   「賣家自己寫一個數字，平台照著付點」。
3. 帳本層再加一道**不變量檢查**：任何一筆 `reason='recycle'` 的
   `delta` 不得超過該使用者在同一個池的 `reason='draw'` 支出總額的某個倍數，
   或直接把每日回收額度上限化。護欄可以被繞過，總量上限比較難。
4. 考慮禁止賣家抽自己開的池（目前完全沒有限制）。這不能單獨解決問題
   （可以用第二個帳號），但會讓自動化的印點更麻煩。

---

## High

### H-1 冪等鍵沒有綁使用者，重放別人的鍵可以讀到別人的資料 `[建議直接修]`

**問題**

```
server/src/routes/pools.ts (POST /:id/draw)
  const [dup] = await sql`select order_id as draw_id from idempotency where key = ${idempotencyKey}`

server/src/routes/orders.ts (POST /)
  const [dup] = await tx`select order_id from idempotency where key = ${idempotencyKey}`
```

兩處都只用 `key` 查，沒有 `and user_id = <呼叫者>`。
`idempotency` 表**有** `user_id` 欄位，只是查的時候沒用上。
鍵是前端自己產生的字串（`src/lib/http.ts:45`），完全由呼叫端控制。

**影響**

拿到（或猜到）別人的冪等鍵就能讀到那個人的抽卡紀錄與訂單內容。
`src/lib/http.ts:45` 主要走 `crypto.randomUUID()`，猜不到；
但它有一條退路 `` `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` ``，
那個是可預測的（`crypto.randomUUID` 在非安全脈絡下是 undefined）。
更重要的是這是純粹的授權缺失 —— 資料的可見性不該靠對方的字串猜不到。

**可重現步驟與證據**（本機）

```
# buyer 用一把已知的鍵抽一格
$ curl -s -X POST localhost:8080/v1/pools/p-seed-1/draw -H "authorization: Bearer $BUYER" \
       -d '{"seats":[7],"idempotencyKey":"buyer-secret-key-0001"}'
{"ok":true,"drawId":"d-mt4507fx-74d68b","items":[{"seat":7,...,"card":{"name":"謎擬Ｑ SAR",...}}],"cost":3250,...}

# attacker（不同帳號）重放同一把鍵
$ curl -s -X POST localhost:8080/v1/pools/p-seed-1/draw -H "authorization: Bearer $ATTACKER" \
       -d '{"seats":[99],"idempotencyKey":"buyer-secret-key-0001"}'
{"replay":true,"draw":{"id":"d-mt4507fx-74d68b","pool_id":"p-seed-1","user_id":"u-buyer",
                       "seats":[7],"cost":"3250","source":"draw","created_at":"1787388570285"}}
```

**建議修法**

兩處都補上 `and user_id = ${me}`。這樣別人的鍵對你就等於「沒用過」，
會走正常的建立流程（如果那筆資源已經被佔走，會被既有的 `SELECT ... FOR UPDATE`
與唯一索引擋下，不會多發一份）。

順帶一提：`orders.ts` 的 `vault` 分支**沒有**寫入 `idempotency`
（`return { order: null, stashId }` 在 insert 之前就 return 了），
所以庫內轉移的購買其實不是冪等的。實務上不會重複扣款
（`listings.status` 已經變成 `sold`），但重送會拿到 `LISTING_TAKEN` 而不是原本的結果。

---

## Medium

### M-1 註冊端點實際上沒有速率限制

`routes/auth.ts` 的 `/register` 有查 `checkLimit(['ip:...'])`，
但 `bumpFail()` **只在 `EMAIL_TAKEN` 的時候才呼叫** —— 成功的註冊不計數，
所以同一個 IP 可以無限量灌帳號。

```
$ for i in 1..6; do curl -s -o /dev/null -w '%{http_code} ' -X POST /v1/auth/register \
    -d "{\"email\":\"rl$i@example.com\",\"password\":\"password123\",\"name\":\"x\"}"; done
200 200 200 200 200 200
```

對照組（登入的限制是有效的）：

```
$ for i in 1..10; do ... POST /v1/auth/login (wrong password) ... done
401 401 401 401 401 401 401 401 429 429
```

**影響**：帳號農場。多帳號會放大 C-2 的印點、繞過「不能買自己的掛單」
與「不能對自己的卡出價」這兩道自我交易檢查，也讓 LINE 登入的
1,000,000 點測試禮金可以被大量領取（HANDOFF §5.1 已列為上線前必拆）。

**建議**：`/register` 成功時也 `bumpFail(['ip:...'])`（或改用獨立的
`reg-ip:` 計數鍵與較寬的門檻），另外考慮 email 驗證。

### M-2 前端沒有 CSP／安全標頭，JWT 放在 localStorage

- JWT 存 `localStorage`（`src/lib/http.ts:10-15`，key `vd.token`），
  以 `Authorization: Bearer` 送出。**沒有**進網址、沒有進 query string、沒有被 log。
  SSE 也用 `fetch` + header 而不是 `EventSource`（`src/composables/useNotificationStream.ts:99-105`）—— 這一段做得很好，請保留。
- 但 `index.html` / `vercel.json` / `public/staticwebapp.config.json` / `deploy/nginx.conf`
  都**沒有**設 `Content-Security-Policy`、`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`。
  後端回應也沒有（`curl -D-` 只有 `server: railway-hikari`）。
- 目前 `src/` 裡沒有 XSS sink（`grep -rn "v-html\|innerHTML\|eval(\|new Function" src/` 零命中），
  所以這是「還沒被點燃的引信」而不是現成的漏洞。

**建議**：加 CSP。GitHub Pages 不能設 response header，所以現階段只能用
`<meta http-equiv>`（表達不了 `frame-ancestors`）—— 這是換自訂網域 + CDN 的另一個理由。
可用的起手式（依實際觀察到的外部主機）：

```
default-src 'self';
script-src 'self' https://www.googletagmanager.com;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src https://fonts.gstatic.com;
img-src 'self' data: https://assets.tcgdex.net https://web-production-154871.up.railway.app;
connect-src 'self' https://web-production-154871.up.railway.app https://api.tcgdex.net https://www.google-analytics.com;
frame-ancestors 'none'; base-uri 'self'; object-src 'none'
```

### M-3 `refPrice` 同時是護欄的分母與回收的分子

HANDOFF §4.1 已經記錄 `refPrice` 沒有外部錨點。這裡補一個**新的攻擊面**：
它不只讓行銷數字說謊，它還是**回收付款的計算基礎**。
只要 `refPrice` 是賣家自填的，「幾折收卡」這件事就等於「賣家自己決定平台要付他多少點」。
C-2 是這件事最極端的展現，但即使補了 C-2 的閘，
一個把 `refPrice` 系統性填高 30% 的賣家仍然可以從回收機制持續套出價差。
真正的解法是回收價不吃 `refPrice`（見 C-2 建議 2）。

---

## Low

### L-1 金額欄位沒有上界，塞大數字會 500

`ListBody.price` 是 `z.number().int().positive()`，沒有 `.max()`；
`CreatePool.ticketPrice` 同樣沒有。塞進 bigint 欄位會炸。

```
$ curl -s -X POST /v1/listings -d '{"prizeId":"pz-...","price":1e308}'
Internal Server Error
$ tail /tmp/vd-server.log
  where: "unnamed portal parameter $3 = '...'", file: 'numutils.c', routine: 'pg_strtoint64_safe'
```

回給客戶端的是 Hono 預設的 `Internal Server Error`，**沒有洩漏 SQL 或堆疊**（見 I-4）。
但這是一個一行就能觸發的 500，而且對照組
（`Grant.points` 有 `.max(100_000_000)`、`Offer.points` 有 `.max(100_000_000)`）
顯示這只是漏加。建議統一補上 `.max()`。

### L-2 公開卡冊 API 回傳 `certNo`

`GET /v1/share/cardbook/:slug` 的 `items[].card` 是整包 jsonb 直出：

```
card keys: ['artId','cardNo','certNo','grade','grader','id','image','language','name','refPrice','setCode']
```

前端 `src/components/CertTag.vue:6-11` 的註解明說公開卡冊刻意不顯示 `certNo`
（「那是持有人的資料」），`src/lib/social.ts:18` 也把它設成 optional ——
但 API 照樣把它送出去。分享連結會被轉貼到群組，等於把持有人整本收藏的
鑑定編號公開。建議在 `socialPublic.get('/cardbook/:slug')` 用白名單挑欄位，
把 `certNo` 拿掉（那一支的檔頭註解本來就寫「這裡是白名單而不是把 user 撈出來刪幾個欄位」，
只是 `card` 這個 jsonb 逃掉了）。

### L-3 出貨憑證收任意外部 URL

`ShipBody.photoUrls` 是 `z.array(z.string().url())` —— 任何網址都收，
存進 `orders.ship_photos` 之後管理員會在後台點開。既是釣魚面，也讓「憑證」失去意義。
而且前端目前寫死一個假網址送出去：

```
dist/assets/index-*.js:  await r.ship(d.id, y.value, m.value.trim(), _ ? [] : ["https://placeholder.invalid/ship-photo"])
```

建議：只接受平台自己的 `fileId`（走 `/v1/files/presign` 的 `ship-photo` 用途），
後端驗 `files.owner_id === 賣家` 且 `purpose === 'ship-photo'`。

### L-4 上游錯誤訊息直接透給呼叫端

```
$ curl -s -X POST /v1/pools/p-.../open -H "authorization: Bearer $S"
{"error":"WRONG_STATE","message":"drand round 6398588 425"}
{"error":"WRONG_STATE","message":"The operation was aborted due to timeout"}
```

`e.message` 被原封不動放進 `message`。目前透出去的東西無害，
但這個模式（`e instanceof Error ? e.message : ...`）在 `pools.ts` 有四處，
之後只要有人在那條路徑上 throw 一個帶內部細節的錯誤就會外洩。
建議固定回一句對外的訊息，細節只寫 `console.error`。

### L-5 LINE 的 JWT 走 URL fragment 回前端

`routes/line.ts` 最後 `redirect(${FRONTEND_URL}/login#token=${jwt})`。
用 fragment 不用 query 是**對的**（不進伺服器日誌、不進 Referer），
`src/stores/auth.ts:76-88` 也馬上 `history.replaceState` 清掉。
殘留風險是 token 會進瀏覽器歷史，而且在 `consumeToken()` 執行前
任何先載入的腳本（例如 GTM）讀得到 `location.hash`。
建議改成 fragment 帶一次性的交換碼，SPA 再 POST 回後端換 JWT。

---

## Informational

- **I-1 前端 bundle 洩漏完整的 `/v1/admin/*` API 介面。**
  `/admin` 路由是 lazy chunk 但無條件建置，任何人都能從 GitHub Pages 抓下來讀，
  連回應的 TypeScript 介面（`src/pages/console/shared.ts:14-71`，含 `real_name` / `phone` / `address_*` / `birthday` / 完整帳本）都在裡面。
  路由守衛是純前端的（`src/router/index.ts:281-287`，`auth.isAdmin` 來自 localStorage 裡的 `vd.user`），
  改一下 localStorage 就能把後台畫面渲染出來。
  **這在後端每一支都真的擋的前提下是可接受的，而我實測後端確實有擋**（見「檢查過而且沒問題」）。
  想再收一層就把後台拆成獨立部署，不要跟玩家站同一個 origin。
- **I-2 已抽走的籤位可以反推出「那一格是什麼」**，因為公開卡冊回傳的
  `prizes.id` 是 `pz-<drawId>-<seat>`，seat 直接寫在主鍵裡。
  但這只涵蓋**已經被抽走**的格子，而 `GET /v1/pools/:id` 本來就公開
  每一個獎項的 `remaining`，資訊量沒有增加，**不影響未開的籤**。列在這裡是為了留紀錄。
- **I-3 `LINE_CHANNEL_ID` 的真實值寫在 `server/.env.example` 與 `server/src/env.ts` 的 default 裡。**
  Channel ID 是公開的用戶端識別碼、不是密鑰，本身無害；
  但它會告訴攻擊者要對哪個 LINE channel 做同意畫面釣魚。可以考慮清空。
  `LINE_CHANNEL_SECRET` 與四個 R2 金鑰在 `.env.example` 裡都是空字串 —— **沒有任何憑證進 git。**
- **I-4 錯誤訊息沒有洩漏內部細節。** 500 回的是 Hono 預設的 `Internal Server Error`，
  SQL 錯誤只進 server log。Zod 的 issue message 有被回傳，但那些是人寫的中文提示，不是欄位傾印。
- **I-5 GA4 的 measurement ID 還是 `G-XXXXXXX`**（`index.html`）。
  不是安全問題（GA ID 本來就公開），但等於白白多載一支第三方腳本、多一塊 CSP 面。
- **I-6 mock 資料是乾淨的。** `src/mocks/data.ts` 的 `certNo` 是連號假資料
  （`82345671`、`82345672`…），commit hash 是 `deadbeef…` / `c0ffee…` 這種手寫佔位，
  email 全部 `example.com`，地址與電話都是明顯的示範值。**沒有真實使用者資料、沒有真實鑑定編號、沒有真實種子。**

---

## 卡圖與鑑定編號的防盜：這件事防不了

使用者問的「前端防盜」裡，圖片這一塊要誠實講：**擋不住，而且不該假裝擋得住。**

現況：

- 卡圖有四層 fallback（`src/components/CardArt.vue`）。其中第三層是
  `https://assets.tcgdex.net/ja/{serie}/{set}/{num}/high.webp`，
  由 `src/lib/tcgdex.ts:70-77` **純字串拼出來、不打任何 API** ——
  那是 TCGdex 的公開 CDN，任何人不經過 VaultDraw 就能抓，而且拼網址的函式三行就能重寫。
- 第二層走後端代理（`/api/certs/:certNo/images`），是第一方網址，但瀏覽器載得到 `curl` 就載得到。
  改成簽名網址只會多一個到期時間，不會讓像素少一份。
- 現有的「防護」只有 `-webkit-touch-callout: none` / `-webkit-user-drag: none` / `contextmenu` 攔截
  （`src/styles/touch.css:82-98`、`src/lib/touch-guard.ts`）。
  它們擋的是手機長按存圖這種順手行為，對 DevTools、檢視原始碼、`curl`、headless 瀏覽器**完全無效**。
  程式碼註解把它們定位成觸控體驗修正而不是防盜，那個定位是準確的。
- 鑑定編號是**刻意**可選取複製的（`src/styles/touch.css:49-51` 的註解：
  「這個站的賣點是『自己驗算』，承諾雜湊、鑑定編號、種子一定要能長按選取複製」）。
  這是對的取捨：cert 的價值就在於第三方可以拿去 PSA 官網查。

真正可以做、而且有意義的只有兩件：

1. **保護聚合而不是保護單張。** 單張卡圖跟單一 cert 攔不住；
   「整個市場的 certNo → refPrice 對照表」才是有商業價值的東西。
   對 `/v1/listings` 這類列表端點加速率限制與（可選的）登入要求，
   讓大量枚舉變貴。這是唯一擋得住的層級。
2. **公開卡冊不要回傳 `certNo`**（見 L-2）。那不是防盜，是隱私。

**不要做**：canvas 繪製、切圖拼貼、浮水印疊層。三種都被一張螢幕截圖打敗，
會破壞無障礙（`CardArt.vue:76-83` 的 `role="img"` / `aria-label`），
還會破壞公平性驗證所依賴的長按複製。加了只會讓人以為有防護。

---

## 檢查過而且沒問題

這一節跟找到的問題一樣重要 —— 下次不用重查。

### 盲盒完整性

- **`server_seed` 在 reveal 之前不會出現在任何回應裡。** `toPublic()` 是唯一出口，
  `serverSeed: revealed ? p.server_seed : null`。實測 14 個池只有 2 個 `revealed` 的有值：
  `curl /v1/pools | grep -oE '"serverSeed":"[^"]*"'` 只回一筆。正式環境同樣結果。
- **`clientSeed` 在 `draft` / `committed` 階段是 null**，`open` 之後才給。正確。
- **`GET /v1/pools/:id/reveal` 在未 reveal 時一律 409**，帶不帶 token 都一樣。
  實測 `p-shop-1`（open）、`p-seller-2`（sold_out）都是 409；
  正式環境的 `p-seed-1` 也是 409。**沒有洩漏 seats／manifest／seed。**
- **`pool_seats` 的籤位→獎品對應沒有任何未授權出口。** 唯一會吐出它的是
  `/reveal`（狀態閘）與 `admin.get('/pools')`（只回 `count(*)`，且 requireAdmin）。
- **抽卡的回應只包含自己搶到的格子**，不會夾帶鄰近格子的資訊。
- **時序攻擊**：`draw()` 對每一格做的是同一句
  `UPDATE ... WHERE seat = any(...) AND taken_by IS NULL`，
  獎品內容是搶到之後才查的，不同賞別的路徑完全相同 —— 結構上沒有可觀測差異。
  （拒絕取樣發生在 `openPool()`，跟抽卡請求無關。）
- **drand 輪次不能被賣家操縱。** `commitPool()` 在建池的同一筆交易裡
  產生 `server_seed`、算 commit、預約 `latest + 4` 輪，全部原子完成；
  沒有任何端點可以刪除或重建一個 `committed` 的池
  （`/close` 只接受 `open`），所以賣家沒辦法「重開到滿意為止」。
  背景掃描會自己把它推去 open。
- **commit v2 綁住獎品內容**，開賣後換卡會被驗算抓到（HANDOFF §3.1 已有實測紀錄）。
- **`PrizeIn` 擋住 `certNo` + `total > 1`**，一個鑑定編號不能開多籤。
- **`CreatePool.mode` 只收 `classic`**，其他玩法直接打 API 也開不了（前端鎖不是唯一的關卡）。
- **還元率護欄在後端也有**（`poolAllowed`），不只在瀏覽器裡。
  （它的缺口是 BUST，見 C-2 —— 但「護欄存在於後端」這件事本身是成立的。）

### 併發與金流

- **同一個人同時買兩張不同的卡 → 只有一筆成立。** `lockSpender()` 確實生效：

  ```
  餘額 3,000，同時買兩筆各 2,900 的 vault 掛單
  → {"error":"INSUFFICIENT_POINTS"} / {"order":null,"stashId":"pz-l-seed-3"}
  → 最終餘額 100（不是 -2,800）
  ```
- **兩個人同時搶同一個籤位 → 只有一個成功**，三輪測試都是 `OK / SEATS_TAKEN`，
  `pool_seats` 每格只有一列、`taken_by` 各歸其主。
- **兩個人同時買同一筆掛單 → 只有一張訂單**（`LISTING_TAKEN` / 成功各一，
  `select count(*) from orders where listing_id='l-seed-4'` = 1）。
- **接受出價時鎖的是出價方**（付錢那一邊），而且先把 offer 移出 pending 再算餘額 —— 兩個都對。
- **後端不信任前端送來的金額。** `/v1/orders` 只收 `listingId`，價格從
  `listings.price` 讀；`/v1/pools/:id/draw` 只收 `seats`，成本是
  `ticket_price × 格數`；回收金額由 `recyclePoints()` 算。
  **沒有任何一支端點接受呼叫端指定的成交金額。**
- **負數與非整數被擋掉**：`price: -1000` → BAD_REQUEST；`points: -5` → BAD_REQUEST；
  `seats: [-1]` / `[0]` → BAD_REQUEST；`seats: [999999]` → BAD_SEATS。
- **不能買自己的掛單**（`l.seller_id === me` → WRONG_STATE），
  **不能對自己的卡出價**（`p.user_id === me` → WRONG_STATE）。
- **退款與逾期不會重複入帳。** 每一筆分錄都帶 `ref_id`，
  靠 `ledger_once` 唯一索引 + `on conflict do nothing`；
  `applyDeadlines()` 是純函式、由當下時間重算，重複呼叫得到同一個結果。
- **`vault` 掛單沒有 `prize_id` 會被整筆擋掉**（`LISTING_BROKEN`），錢不會單獨動。

### 授權與越權

- **所有需要登入的端點在沒帶 token 時都回 401**（本機與正式環境各測一輪）：
  `/v1/wallet`、`/v1/prizes`、`/v1/orders`、`/v1/social/notifications`、
  `/v1/social/cardbook/settings`、`/v1/seller/me`、`/v1/admin/overview` 全部 401。
- **`/v1/admin/*` 的權限是後端認的，不是前端藏的。** 一般使用者帶合法 token
  打 `/v1/admin/pools`、`/v1/admin/users`、`/v1/admin/grant` 全部 **403**。
  `requireAdmin` 查的是 `users.role = 'admin'`（不是寫死的 `u-platform`），
  而且每個會動錢的動作都寫 `admin_actions` 稽核。
- **每一支使用者端點都有「這是不是你的」檢查**，不只是「有沒有登入」：
  `prizes` 全部 `where user_id = me`；`listings/:id/delist` 驗 `seller_id`；
  `trade-offers/:id/accept` 驗 `to_user`、`decline` 驗雙方任一；
  `orders` 的 `act()` 用 `buyerId` / `sellerId` / `PLATFORM_ID` 分角色。
  實測新帳號打這些端點只看得到空集合。
- **`files.get('/:id')` 的私有用途只給本人或管理員**（`ship-photo` / `unbox-video` / `seller-doc`），
  註解記錄了它從「任何登入使用者都能讀」收緊的過程。上傳 key 帶 owner + 10 bytes 隨機。
  `presign` 有 mime 白名單與大小上限，而且**先驗請求再看服務有沒有設定**。
- **分頁游標偽造無效。** 游標只是「從哪一列之後開始」，
  `where user_id = ${me}` 永遠在外面：偽造的游標拿到的是空集合，
  壞掉的游標回 `BAD_CURSOR`，`limit=1000` 回 400。
  ```
  ?cursor=<base64 of 9999999999999|zzz>  → {"items":[],"nextCursor":null}
  ?cursor=not-base64!!!                  → {"error":"BAD_CURSOR"}
  ?limit=1000                            → {"error":"BAD_REQUEST"}
  ```
- **`share_slug` 是 `randomBytes(8).toString('base64url')`（64 bits）**，枚舉不可行；
  三組手寫的 slug 全部 404。
- **關閉公開後舊連結立刻失效**（不是只有前端不顯示）：
  ```
  PUT /v1/social/cardbook/settings {"public":false}
  GET /v1/share/cardbook/<舊slug>  → HTTP 403 {"error":"CARDBOOK_PRIVATE"}
  ```
  而且**私有卡冊也不能被出價** —— 知道 `prizeId` 也繞不過去：
  ```
  POST /v1/social/trade-offers → 403 {"error":"CARDBOOK_PRIVATE"}
  ```
- **SQL injection**：全部走 postgres.js 的參數化。實測
  `?sort=deal'--`（enum 擋下）、`?status=x' or 1=1--`（參數化）、
  `/v1/share/cardbook/' or 1=1--`（回 404）都沒有異常。
  `admin/users` 的 `ilike '%'||q||'%'` 也是參數化的。

### 正式環境（唯讀）

- **`DEV_LOGIN` 是關的**：`POST /v1/auth/dev-login` 回 **404**。
  （這很重要 —— `ensureUser()` 用 `'u-' + handle`，所以 dev-login 給
  `handle: "platform"` 就會拿到 `u-platform`，那個帳號在 seed 裡是 `role='admin'`。
  本機確實如此。正式環境沒開這條路。）
- **CORS 是白名單制**：`Origin: https://evil.example` 拿不到 `Access-Control-Allow-Origin`；
  `https://ademczw.github.io` 才拿得到。本機同樣行為。
- **沒有種子外洩**、**reveal 端點對未揭曉的池回 409**（見上）。
- 沒有對正式環境做任何寫入、掃描或壓測。

### 前端

- **`dist/` 裡沒有任何金鑰。** `SECRET` / `PRIVATE KEY` / `sk_` / `AKIA` / `AIza` /
  `ghp_` / `xox?-` / `PASSWORD` / `DATABASE_URL` / `postgres://` / `JWT_SECRET` /
  `LINE_CHANNEL_SECRET` / `ADMIN_PASSWORD` 全部零命中。
  長 hex 常數只有 `deadbeef…` / `c0ffee…` 這些 mock commit hash。
- **沒有輸出 source map**（`find dist -name "*.map" | wc -l` → 0）。
- **`dist/` 裡只有兩個 `VITE_` 變數的值**：`VITE_API_URL`（就是 Railway 的公開網址，
  SPA 必須知道，不可避免）。`VITE_PSA_DEV_TOKEN` 被 `import.meta.env.DEV` 擋住並
  tree-shake 掉了 —— 實測 `grep -rc 'PSA_DEV' dist` 每個檔案都是 0，也沒有 psa chunk。
- **`.env.local` 有被 gitignore、沒有進 git**，內容只有一行 API URL。
- **前端沒有 `dev-login` 相關的東西**（`grep -rInE 'dev-login|DEV_LOGIN|devLogin' src/` 零命中）。
- **沒有寫死的 token、沒有註解掉的憑證、沒有 `eval` / `new Function`。**
- **JWT 從來不進網址、不進 query string、不被 log。** SSE 用 fetch + header。
- **401 會自動清 token**（`src/lib/http.ts:38`），被撤銷的 session 不會無限重試。
- **GitHub Actions 用的是 repo Variable 不是 Secret**（對一個會被打包進 bundle 的值來說，
  這個分類是對的），權限最小化（`contents: read, pages: write, id-token: write`）。

---

## 收尾待辦（本次沒能做完的事）

1. **本機還有一個 server 行程跑在 :8080**，是用
   `npx tsx src/index.ts` 在背景啟動的（log 在 `/tmp/vd-server.log`）。請 kill 掉：
   `pkill -f "tsx src/index.ts"`。
2. **`vaultdraw_test` 已被測試污染**（多了 attacker / racer / rl* 帳號、
   一個 `mint-test` 池、被改過價格的 seed 掛單、被回收的卡）。請重建：
   `dropdb vaultdraw_test && createdb vaultdraw_test && npm run migrate && npm run seed`。
3. **C-2 與 H-1 的修改沒有套用。** 兩處的具體改法寫在上面。
   套用後請跑 `cd server && npm run check`、`npm run build`、`npm run smoke`
   （不要接 pipe，讀 exit code；基準 175 項）。
4. **C-1 的 ground truth 對照沒跑完**：請在自己的終端執行
   ```sql
   select ps.pool_id, ps.seat, pp.tier, pp.card->>'name'
   from pool_seats ps join pool_prizes pp on pp.id = ps.prize_id
   where ps.pool_id in ('p-shop-1','p-vault-2') and pp.tier in ('A','LAST')
   order by ps.pool_id, ps.seat;
   ```
   預期會看到 `p-shop-1` 的 20 與 245、`p-vault-2` 的 15，跟報告裡的預測完全相符。
5. **C-1 的處置是所有事情裡最急的**：正式環境現在有 12 個籤序算得出來的池在收錢。
