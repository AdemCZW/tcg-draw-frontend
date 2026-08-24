# 五種抽卡池玩法：機制稽核

稽核日期 2026-08-24。範圍是 `server/`（Hono + postgres.js）加上前端讀 `mode` 的路徑。
本機測試庫 `vaultdraw_test`，每輪重建 migrate + seed，伺服器以 `DEV_LOGIN=1` 跑在 `:8080`。
**沒有碰正式環境，沒有修改任何程式碼。**

---

## 先講結論：這一輪最重要的事實

`server/src/pools-service.ts` 的 `draw()` **從頭到尾沒有讀過一次 `pools.mode`**。
`server/src/routes/pools.ts:163` 的建池 schema 是 `mode: z.enum(['classic'])`。

也就是說：

| mode | 後端邏輯 | 能不能建 | 實際跑起來像什麼 |
|---|---|---|---|
| classic 經典賞 | 無（沒有最後賞規則） | 可以 | **muteki** |
| shitei 指定賞 | 無 | 不行（400） | classic |
| muteki 無敵賞 | 無（不需要） | 不行（400） | — |
| streak 連莊爆賞 | 無 | 不行（400） | 前端 mock |
| auction 尾籤競標 | 無 | 不行（400） | 前端 mock |

所以使用者假設裡那些「兩人同時抽中指定賞會怎樣」「爆掉是伺服器狀態還是前端狀態」
的問題，答案幾乎都是同一個：**那段邏輯不存在**，所以不會出錯，但也不會運作。
真正的漏洞集中在兩個地方：(a) classic 自己的規則沒實作卻照文案宣傳，
(b) 抽卡的錢憑空消失。

**本報告的分節性質不同，請不要混讀：**

| 節 | 性質 |
|---|---|
| 1 classic / 2 shitei / 3 muteki / 6 跨玩法 | **已實作，以下為實測證實的漏洞**（每條附重現步驟與輸出） |
| 4 streak / 5 auction | **尚未實作，以下為設計階段的風險清單**（不是漏洞，是實作時會踩到的坑） |

第 4、5 節裡唯一屬於「已證實」的，是前端在 API 模式下仍會落到 mock 這件事
（`SD-0` / `AD-0`），那是現況的程式碼事實，不是對未來實作的推測。
其餘全部是設計建議，**沒有任何一條是可以今天拿去攻擊的漏洞** ——
因為沒有伺服器端的機制可以攻擊。

實測：

```
$ node m1.mjs
classic  200 {"poolId":"p-bebf437e35","commit":"73bc9243..."}
shitei   400 {"error":"BAD_REQUEST","message":"Invalid enum value. Expected 'classic', received 'shitei'"}
muteki   400 {"error":"BAD_REQUEST","message":"Invalid enum value. Expected 'classic', received 'muteki'"}
streak   400 {"error":"BAD_REQUEST","message":"Invalid enum value. Expected 'classic', received 'streak'"}
auction  400 {"error":"BAD_REQUEST","message":"Invalid enum value. Expected 'classic', received 'auction'"}
```

---

## 1. classic 經典賞

### 實際上怎麼運作（照程式碼，不是照文案）

建池時強制 `sum(pool_prizes.total) === pools.total_tickets`（`routes/pools.ts:189`、
`pools-service.ts:commitPool`）。開池時把籤序一次寫滿 `pool_seats`。
抽卡就是 `update pool_seats set taken_by = ... where seat = any(...) and taken_by is null`，
影響列數不等於要求數就整筆回滾；接著 `credit(tx, userId, -cost, 'draw', drawId)`
並在 `prizes` 建等量的列。**發出去的卡永遠等於佔到的籤，一張不多。**

文案（`PoolModeBadge.vue`）說的「抽走最後一籤的人額外獲得最後賞、LAST 不佔籤位」
在後端一行都沒有。

### 發現

#### C-1 — Critical — 最後賞規則完全沒有實作，classic 實際上是 muteki

**影響**：買家看到「經典賞：抽走最後一籤額外得最後賞」的徽章而下單，
但抽走最後一籤只會拿到那一格本來的卡。LAST 賞被迫塞進籤位裡當成一般大獎 ——
那是 muteki 的定義。這是對付費使用者的不實陳述，不是內部瑕疵。

**重現 1：LAST 不可能不佔籤位。** 建一個 4 籤、獎品 4 支 D + 1 支 LAST 的池：

```
LAST 不佔籤位（獎品5 vs 籤4）: 400 {"error":"BAD_REQUEST","message":"獎品總數 5 必須等於籤數 4"}
LAST 佔籤位（獎品3 D + 1 LAST = 4）: 200 {"poolId":"p-9a3dbec07e", ...}
```

**重現 2：抽走最後一籤沒有任何加送。** `p-grade10-1`（20 籤，含 1 支 LAST），
先抽掉 10 格，再抽最後 1 格：

```
grade10-1 剩 11 格；LAST 賞 remaining: [ 1 ]
大量抽 200 10 張
抽走最後一籤 seat 17 → 拿到 1 張: ["LAST"]
池狀態 sold_out
```

籤位 17 剛好就是 LAST 那一格，所以看起來「有拿到」——但那是巧合，
是籤序決定的，不是因為他抽了最後一籤。資料庫端可以看得更清楚：

```
 tier | count        seats_taken
------+-------       -----------
 A    |     1                 20
 D    |     9
 LAST |     1
```

20 個籤位、20 張卡。發卡數恆等於佔籤數，**沒有第 21 張的空間**。

**建議**：兩條路擇一。
(a) 真的實作：讓 LAST 不進 `pool_seats`（建池時的等式改成
`sum(total where tier <> 'LAST') === total_tickets`），並在 `draw()` 裡
偵測「這一抽之後 free = 0」時額外插一列 LAST 的 `prizes`。
併發安全性已經有了 —— `draw()` 開頭的 `select * from pools ... for update`
會把同一個池的抽卡完全序列化，所以「誰是最後一個」是唯一的（見下方檢查清單）。
(b) 短期止血：把徽章文案改成 muteki 的說法，別再宣傳不存在的規則。

---

#### C-2 — Critical — 票金只有借方沒有貸方，賣家一毛都收不到，點數被銷毀

**影響**：抽卡向買家扣點，但沒有任何一筆分錄把這些點數給賣家或平台。
`credit()` 的全部呼叫點只有這幾個：

```
orders-service.ts:55  order-pay        買家 −price
orders-service.ts:56  order-receive    賣家 +price
orders-service.ts:61  deposit-forfeit
orders-service.ts:62  deposit-collect
pools-service.ts:184  draw             買家 −cost      ← 沒有對應的貸方
routes/prizes.ts:127  recycle          本人 +points
routes/admin.ts:50    admin-grant
routes/line.ts:163    line-signup-bonus
```

賣家開池、出貨、承擔獎品成本，收入是 0。同時平台的點數總量每抽一次就少一次 ——
帳本沒有「平台營收」這個科目，抽卡的錢等於被燒掉。這一點在五種玩法都一樣。

**重現**：跑完一輪測試後的帳本：

```
   reason   | count |   sum
------------+-------+---------
 draw       |    12 |  -69340
 test-drain |     1 |  -67500     ← 我為了測雙花手動壓餘額，非產品分錄
 seed       |     3 | 1200000

 票金總額 | 帳本扣款 | 賣家入帳筆數
----------+----------+--------------
    69340 |   -69340 |            0
```

**建議**：在 `draw()` 裡把 `-cost` 拆成「買家 −cost」＋「賣家 +cost×(1−抽成)」
＋「平台 +cost×抽成」，三筆都帶 `drawId` 讓 `ledger_once` 擋重複。
如果現行商業模式就是「賣家用點數換曝光、不領現」，那也要有一筆
`+cost` 進 `u-platform`，否則點數總量會單向蒸發而且對不出來。
先確認是設計還是漏掉，再決定怎麼補。

---

#### C-3 — Medium — 賣家可以抽自己的池

**影響**：`draw()` 沒有檢查 `userId !== pool.seller_id`。
賣家可以自買自唱：把自己的池抽出成交紀錄、把公開的
`prizes[].remaining` 洗成「大獎還在」的樣子誘導跟抽，
或在大獎被別人抽走前先自己吃掉。

今天還無法直接獲利，因為三件事同時擋著：`server_seed` 由 `randomBytes(32)`
在伺服器產生、`commitPool` 只回雜湊，所以賣家算不出籤序（見下方檢查清單）；
票金是銷毀的（C-2），自抽等於純損失；回收只有 70%（`shared/recycle.ts`）。
但這三道防線有任何一道變動（例如修好 C-2 讓賣家收得到票金），
自抽就立刻變成「左手換右手把還元率洗高」的工具。

**重現**：`p-shop-1` 是 `u-shop` 的池，用 `u-shop` 的 token 抽：

```
賣家抽自己的池 (p-shop-1 是 u-shop 的): 200 {"ok":true,"drawId":"d-mt6yq2e5-380db2","items":[...]}
```

**建議**：`draw()` 加一條 `if (p.seller_id === userId) return { ok: false, error: 'SELF_DRAW' }`。
修 C-2 之前就該先加，不然兩個改動的先後順序會開出一個空窗。

---

#### C-4 — Low — BUST 賞可以放進 classic 池，公開的還元率因此失真

**影響**：`PrizeIn` 的 tier enum 收 `BUST`（`routes/pools.ts:142`），
但 classic 沒有爆賞的概念 —— 那張卡會被當成一般獎品發出去。
而 `returnRatio()` 刻意把 BUST 當成 0 值（`shared/economics.ts:39`），
於是公開展示的還元率會**低於**實際值。方向對玩家有利（不會被高估騙進場），
但公開數字仍然是錯的，而且會讓賣家被誤判成 predatory 而開不成池。

**重現**：10 籤、票價 100、1 支 A（refPrice 700）＋ 9 支 BUST（refPrice 20）：

```
classic 含 9 支 BUST: 200 {"poolId":"p-f18f89e257", ...}
  公開 returnRatio = 70    ← 只算 A 賞 700/1000
  實際獎品總值 = 700 + 9×20 = 880 → 真實還元率 88%
```

順帶確認第二道閘（兌現率）是有效的。同一個池把 BUST 的 refPrice 改成 90：

```
classic 池含 BUST: 400 {"error":"BAD_ECONOMICS","message":"含爆賞在內，獎品參考價的總值是票收的 141.0%，超過 100%。..."}
```

**建議**：`mode === 'classic'` 時把 `BUST` 從允許的 tier 拿掉。
BUST 只有在「抽到就收手歸零」的規則下才有意義。

---

#### C-5 — Informational — 中斷的請求照常提交，客戶端拿不到結果

送出抽卡後 3ms 就 abort 連線：

```
中斷請求 seat [ 129 ] → aborted:AbortError
中斷後該籤位是否已被佔: true
```

交易在伺服器端完成了：點數扣了、籤位佔了、卡進了卡冊。這是正確行為
（HTTP 中斷不該回滾一筆已經成立的交易），使用者的卡也真的拿得到。
唯一的缺口是「客戶端看不到自己抽到什麼」—— 只有在重送**同一把冪等鍵**時
才會拿到 `{replay:true, draw:...}`。前端若在重試時換鍵就會重複扣款。
建議前端把冪等鍵在重試之間保持不變（這一輪沒有驗證前端的重試行為）。

### classic：檢查過而且沒問題

- **同一格併發**：兩人同時抽 `p-vault-2` 的 78 號 →
  `200` / `409 SEATS_TAKEN taken:[78]`。`UPDATE ... WHERE taken_by IS NULL` 的防線有效。
- **最後兩格併發 → sold_out 判定**：兩人同時各抽 79、80 → 兩筆都 `200`，
  之後 `status=sold_out`、`remainingTickets=0`。`draw()` 開頭的
  `select * from pools ... for update` 把同一個池的抽卡序列化，
  所以「剩幾格」的 count 不會漏判（原本擔心的 READ COMMITTED 幽靈讀不成立）。
- **同一人跨池雙花**：`u-shop` 餘額壓到 5000，同時對兩個池各抽 10 支
  （3500 + 2000 = 5500 > 5000）→ `200` / `402`，餘額剩 1500。
  `lockSpender()` 鎖 `users` 那一列的做法有效。
- **全有全無**：一次抽多格時只要有一格被搶走就整筆回滾，回 `taken` 清單。
- **冪等綁 user_id**（migration 015）：本人用同一把鑰匙換籤位重放 →
  回 `{replay:true}` 加原本那一筆 `draw`，不會產生第二筆；
  **別人**拿同一把鑰匙 → 照常建立新的一抽（`d-mt6yq1r5-a3e2b7`）。
  這在五種玩法下都是對的行為：冪等的語意是「同一個人的同一個請求只做一次」。
- **`server_seed` 不外流**：`toPublic()` 只在 `status === 'revealed'` 時才吐；
  `/reveal` 端點也擋 `status !== 'revealed'` → 409。建池時的
  `commitPool()` 只回 `commit` 雜湊與 `client_seed_source`。
- **有鑑定編號的卡只能開 1 籤**：`PrizeIn` 的 `.refine()` 擋住。
- **獎品總數必須等於籤數**：400，訊息清楚。
- **對帳**：所有經由 API 抽出的池，`已佔籤 == 已發卡 == draws 的籤數總和`，
  票金總額 == 帳本 `draw` 科目的絕對值。
  （`p-grade10-1` 等池的「已佔籤 > 已發卡」是 seed 直接標記籤位造成的，不是 API 路徑。）
- **收攤權限**：`POST /:id/close` 只有賣家或 admin，且只接受 `status = 'open'`。

---

## 2. shitei 指定賞

### 實際上怎麼運作

**沒有任何後端邏輯。** `pools.shitei_tier` 欄位存在、`toPublic()` 會把它吐給前端、
`PoolModeBadge.vue` 會顯示「抽中指定賞加送最後賞、整池立刻結束」，
但 `draw()` 沒有讀過 `shitei_tier`，也沒有任何地方會把池提前改成 `sold_out`。
建池 API 直接拒收 `mode: 'shitei'`（400）。

### 發現

#### S-1 — High — 規則不存在；DB 層一旦寫進 shitei，徽章就會說謊

**影響**：`migrations/002_core.sql:85` 的 check constraint 允許五種 mode，
只有 API 那一層擋著。任何直接寫 DB 的路徑（seed 腳本、admin SQL、
未來把 enum 加回來的 commit）都能造出一個「徽章寫指定賞、實際照 classic 發獎」的池。
買家會為了「抽中 A 賞就加送最後賞並提前結束」而下注，實際上什麼都不會發生。

**重現**：把一個既有的 open 池的 mode 直接改成 shitei：

```sql
update pools set mode='shitei', shitei_tier='A' where id='p-shop-2';
```

```
p-shop-2 公開 API 回報 mode=shitei shiteiTier=A
  抽 3 支 → 200 拿到 3 張 ["C","C","C"] 扣款 1050
```

公開 API 原樣吐出 `mode=shitei` 與 `shiteiTier=A`；抽卡照常扣款、照常發卡、
池不會結束。前端的 `PoolModeBadge` 會照這個值渲染指定賞的規則說明。

**建議**：在補上邏輯之前，把 002 的 check constraint 收成
`check (mode in ('classic'))`（或加一條 migration），讓資料庫層跟 API 層說同一句話。

#### S-2 — 未驗證／推測 — 實作時必須重測的三件事

以下是稽核委託裡點名的風險，**目前全部不成立，因為沒有結束邏輯**。
留在這裡是為了實作時當檢查表：

- 兩人同時抽中指定賞 → 會不會加送兩份最後賞。
  （`draw()` 開頭的 `for update` 已經把同池抽卡序列化，理論上安全，但要實測。）
- 池結束的瞬間其他人正在進行中的抽卡 → 會不會扣了錢沒拿到卡。
  （同上，序列化應該能擋，但「結束」若寫在另一條路徑上就不一定。）
- 剩下沒發出去的獎品 → `pool_prizes.total` 與實際發出的 `prizes` 會永久對不齊，
  對帳查詢要能容忍這個差額，`revealPool` 也要接受「未售完就結束」的池
  （目前 `revealPool` 只收 `sold_out` 與 `cancelled`）。

### shitei：檢查過而且沒問題

- API 建池閘擋住 `mode: 'shitei'`（400，訊息點名 enum）。
- 前端 `SellerNewPoolPage.vue` 的模式選擇器把 shitei 標成 `enabled: false`，
  所以正常操作也送不出去（但那只是 UI 層，真正擋住的是 API）。

---

## 3. muteki 無敵賞

### 實際上怎麼運作

規則是「最後賞當一般大獎放在籤池內，無額外贈獎」——
**這正是今天 `draw()` 的行為**。所以 muteki 是唯一「規則與實作完全一致」的玩法，
卻也是不能建的（enum 只收 classic）。今天平台上每一個標示 classic 的池，
實際運作方式都是 muteki。

### 發現

#### K-1 — Medium — 設定面：LAST 的數量沒有上限

**影響**：`PrizeIn` 對 `LAST` 沒有任何數量限制，一個池可以開 3 支、10 支最後賞。
在 muteki 的語意下這只是「有很多支大獎」，不算錯；但在 classic 的語意下
（最後賞是唯一的、給最後一個人的）就是矛盾的設定，而兩者現在共用同一套驗證。
`certNo` 那條 `.refine()` 只擋「有鑑定編號的卡開多籤」，
沒有鑑定編號的 LAST 卡可以無限開。

**建議**：實作 C-1 時一併加 `mode === 'classic' → LAST 的 total 必須是 1`。

#### K-2 — Informational — 佔位一致性

`pool_prizes.total` 的總和恆等於 `total_tickets`（API 強制），
籤序由 `seatSequence(server_seed, client_seed, prizes)` 產生，
長度就是 `total_tickets`，一次 500 筆批次寫入 `pool_seats`。
LAST 在 muteki 語意下佔位是正確的，數量與佔位一致，沒有發現不一致。

### muteki：檢查過而且沒問題

- 獎品總數 == 籤數（建池時強制，實測 400）。
- `pool_seats` 的列數 == `total_tickets`（seed 與 API 建的池都核對過）。
- 一個鑑定編號只能對應一張實體卡（`.refine()` 有效）。
- 還元率／兌現率兩道閘在含 LAST 的池上都正確套用。

---

## 4. streak 連莊爆賞 —— 尚未實作，以下為設計建議

> **這一節不是漏洞清單。** 後端沒有連莊的任何實作，所以沒有伺服器端的機制可以攻擊。
> 以下是「如果照現在的資料庫結構與前端 mock 的樣子做下去，會踩到哪些坑」。
> 唯一屬於已證實現況的是 SD-0。

### 現況

`migrations/002_core.sql:142` 有 `streak_runs` 表與 `streak_user_live` 部分索引，
但 `grep -rl "streak_runs" server/src/` **零結果** —— 沒有任何程式讀寫這張表，
後端也沒有任何連莊端點。真正在跑的是前端 mock：`src/mocks/data.ts:730`
一個模組層級的 `Map<string, StreakRun>`，`streakDraw()`（`:747`）從
`prize.remaining` 現場組袋子抽一張，抽到 `tier === 'BUST'` 就清空 `run.items`、
塞一張保底卡、`status = 'busted'`。

---

#### SD-0 — High — **已證實** — 前端在 API 模式下仍會落到 mock

這是現況的程式碼事實，不是設計推測。

`src/lib/api.ts:206-228` 的 `startStreak` / `streakDraw` / `bankStreak`
**沒有 `if (MOCK)` 分支**，一律呼叫 `mock.*`。註解自承「連莊的後端是階段 3，
還沒建；API 模式下先繼續走 mock，不要讓按鈕沒反應」。
`StreakRunPage.vue:74,80` 用的 `wallet.spend()` / `wallet.topup()` 在
`src/stores/wallet.ts` 裡每一支都以 `if (!MOCK) return` 開頭
（`spend :66`、`topup :70`、`setLocked :83`、`charge :88`、`creditRecycle :98`）。

所以萬一有人造出 `mode='streak'` 的池：入場費不會被扣、伺服器完全不知道有人在連莊、
收手拿到的卡也不會進伺服器的 `prizes`。整場遊戲對伺服器不存在。
（`mock.startStreak` 內部是 `pools.find(p => p.id === poolId)!`，對真實池 id
會直接丟 TypeError，所以實際上會壞在更早的地方 —— 但那是運氣，不是防線。）

今天觸發不到，因為三道閘都關著（API enum、seed 已全改 classic、賣家表單
`enabled: false`）。**建議**：在補後端之前，把這五支在 `!MOCK` 時直接
`throw new Error('連莊尚未上線')`，讓失敗大聲一點。

---

### 4.1 `streak_runs` 的欄位夠不夠？——不夠

現有欄位：

```sql
id, pool_id, user_id, entry_cost,
status text check (status in ('live','banked','busted')),
drawn_seats int[], held_value bigint, created_at, closed_at
```

這是一張草圖，不是可以直接蓋上去的結構。針對「爆掉之後不能反悔」與
「中途斷線」兩件事，缺的東西如下。

#### SD-1 — Critical（設計） — 沒有任何欄位能證明 BUST 是事先決定的

`streak_runs` 完全沒有 commit-reveal 的欄位。池層級有
`server_seed` / `commit_hash` / `client_seed` 一整套，連莊卻一個都沒有。
少了它，「你爆了」就只是伺服器單方面的宣告 —— 玩家事後無法驗證那張爆賞
不是在看到他手上累積多少之後才決定的。

這是連莊玩法**最核心**的信任問題：classic 的籤序在開賣前就固定並公開承諾，
連莊如果做不到同一件事，整個平台「可驗證」的賣點在這個玩法上就是空的。

**缺**：`run_commit`、以及揭曉時能重算的輸入（見 4.2 的建議做法）。

#### SD-2 — Critical（設計） — 「爆掉不能反悔」需要的是交易邊界，不是欄位

`status` 三態本身沒問題，但正確性不在欄位而在**寫入時機**：
決定 BUST、把 `status` 改成 `'busted'`、把該回合的結果回傳給前端，
這三件事必須在**同一筆交易**裡完成，而且回應要在交易提交**之後**才送出。
只要「決定」與「落盤」之間有任何一個 await 是可以中斷的，
關掉瀏覽器就真的能讓爆掉不算數 —— 那正是委託裡擔心的那件事，
而它跟 mock 與否無關，是實作結構的問題。

**還缺兩條 DB 層的護欄**（現在完全沒有）：

```sql
-- 終局狀態不可逆：live → banked/busted 是單向的
-- 用觸發器擋 update，或至少加上這條一致性約束
check ((status = 'live') = (closed_at is null))
```

沒有這條的話，一筆 `update streak_runs set status='live'` 就能把爆掉的回合復活，
而那種 SQL 在這個 repo 的歷史上真的出現過（見 S-1 / X-1）。

#### SD-3 — High（設計） — `drawn_seats` 與 `pool_seats` 是兩個真相來源

`drawn_seats int[]` 記在 run 這一列上，但籤位的權威來源是 `pool_seats.taken_by`。
連莊進行中的那些籤位到底算不算被佔走？

- **不佔**：別的玩家可以同時抽到同一格，同一張卡發兩份。
- **佔**：`pool_seats` 上沒有欄位記錄「這是誰的哪一個回合暫持的」，
  爆掉之後要釋放哪些格子只能靠 `drawn_seats` 這個陣列去反推，
  兩邊一旦不同步就沒有第三方可以仲裁。

**缺**：`pool_seats.run_id`（可為 null）。有了它，暫持與正式歸屬是同一張表的同一列，
`drawn_seats` 就可以整個拿掉 —— 少一個真相來源就少一種對不齊的方式。

#### SD-4 — High（設計） — `held_value bigint` 是錯的形狀，應該刪掉

`held_value` 是一個「暫持總值」的快取。兩個問題：

1. 它跟 `drawn_seats` 講同一件事，而且會漂移。
2. 它的值只能從 `refPrice` 算出來，而 `refPrice` 是**賣家自己填的**
   （見 C-4、X-3）。把一個賣家可控的數字固化成點數欄位，等於在連莊裡
   開一條新的印點數路徑。

暫持的東西應該用**身分**表示（哪幾格），不是用**估值**表示。
要顯示「目前累積價值多少」就從 `drawn_seats` / `pool_seats.run_id`
即時 join `pool_prizes` 算，跟 `money.ts` 對 `locked` 的處理同一個哲學 ——
那個檔案的開頭就寫了為什麼不存欄位：「存欄位的版本會有對不起來的一天，
而且對帳時你不知道該信哪個。」連莊沒有理由破例。

#### SD-5 — Critical（設計） — 沒有租約，斷線的回合會永久卡住玩家與整個池

沒有 `expires_at`，`status='live'` 的回合會一直是 live。後果三重：

1. `streak_user_live` 這個部分唯一索引（如果真的拿來擋同人多回合）
   會讓這個玩家**永遠開不了下一個回合**。
2. 那些暫持的籤位永遠不會回到池裡，池永遠到不了 `sold_out`，
   於是永遠不會 `revealed` —— 跟 `close` 端點當初要解決的是同一種死結
   （見 `routes/pools.ts` 收攤那段的註解）。
3. 玩家付了入場費卻拿不回任何東西。

**缺**：`expires_at bigint`，加上 `sweepPools()` 裡的一段清理
（那裡已經是背景推進池生命週期的地方，不用另外建排程）。

**到期要判 bank 還是 bust？必須是 bank。** 判 bust 等於把「網路斷線」
變成平台的收入來源 —— 使用者沒有做出繼續的決定，預設就不該是懲罰。
這是設計決策不是實作細節，要寫進規則文案裡讓玩家事先看得到。

#### SD-6 — High（設計） — 沒有回合序號，重試會讓回合多走一步

`idempotency` 表是 `(key, user_id) → order_id`（migration 015）。
連莊的每一次續抽都是一個獨立的狀態推進，光靠呼叫端自己產的字串當鑰匙不夠 ——
網路重試、使用者連點兩下，都可能讓回合前進兩格而玩家只看到一個結果。

**缺**：`round_no int not null default 0`，並用樂觀鎖推進：

```sql
update streak_runs set round_no = round_no + 1
 where id = $1 and round_no = $2 and status = 'live'
```

影響列數 0 就拒絕。這比冪等鍵更適合連莊，因為它擋的是「狀態被推進兩次」
而不只是「同一個請求送兩次」。

#### SD-7 — Medium（設計） — 入場費的分錄要綁 run id

`entry_cost` 有記在 run 上，但沒有任何東西保證它跟帳本對得起來。
扣款要走 `credit(tx, userId, -entryCost, 'streak-entry', runId)` ——
`ledger_once` 唯一索引會靠 `ref_id` 擋掉重複入帳（`money.ts` 的 `credit` 註解
已經說明這個機制）。同時這也是 C-2 的延伸：**入場費一樣要有貸方**，
不然連莊只是多開一個燒點數的出口。

---

### 4.2 每輪的隨機性要怎麼給？

> 委託的問題：使用者提議「前端一打開遊戲就重新打亂編號」，
> 協調者認為那會破壞 commit-reveal 的可驗證性。**這個判斷是對的**，
> 但理由比「伺服器會先知道你是誰」更精確一點，值得講清楚。

#### 為什麼那個提議不能用

**第一，前端做的洗牌完全不具可驗證性。** `shared/fairness.ts` 的檔頭寫得很直白：
「這裡沒有任何 I/O、沒有 `Date.now()`、沒有 `Math.random()`。
給同樣的輸入永遠得到同樣的輸出，這是『可驗證』的全部意思。」
可驗證性的前提是**任何第三方**都能用公開的輸入重算出同樣的結果。
在玩家自己的瀏覽器裡現場打亂，第三方沒有輸入可以重算，
而且客戶端本來就不是可信的一方 —— 整套設計刻意對它零信任。

**第二，也是關鍵的一點：commit-reveal 的安全性不只要求「承諾在結果之前」，
還要求「承諾在莊家知道任何足以讓他偏好某個結果的資訊之前」。**

協調者說的「伺服器會在知道你是誰、手上有什麼之後才決定順序」正是這個意思。
一打開遊戲才產生的承諾，產生的那一刻伺服器已經知道：你是誰、你的餘額、
你這個回合暫持了多少價值、你已經連過幾輪。莊家只要在產生種子時試幾次，
就能挑一個「剛好在你累積到門檻時爆掉」的種子 ——
而事後的驗算**完全通過**，因為承諾確實早於結果。
驗算能證明的是「種子沒被換」，不是「種子不是挑出來的」。

所以真正的要求是：**每一輪的隨機性，其輸入必須全部在伺服器知道這個回合的
狀態之前就固定下來。**

#### 順帶澄清一個前提：連莊其實不需要「新的」隨機性

池的籤序 `seatSequence(server_seed, client_seed, prizes)` 在開賣前就已經
決定好、承諾好、而且 `client_seed` 來自 drand（伺服器選不了）。
「每輪不同」這件事**已經由『剩下哪些格子』自然滿足了** ——
不需要重新洗牌。唯一還沒定義的是：這一輪要發給你**哪一格**。

#### 建議做法（甲案，推薦）

在回合開始時、玩家看到任何一張卡之前，就把**整個回合會依序消耗的籤位順序**
決定完畢，而且只用已經承諾過的輸入：

```
runSeq[k] = below( total_tickets ) 取自
            Stream( server_seed, client_seed || run_id || k )
```

- `server_seed`、`client_seed`：開賣前就承諾／來自 drand，伺服器事後改不了。
- `run_id`：**在扣入場費的那一刻指派，早於任何一張卡被決定**，
  之後寫死不可變，並在揭曉時一起公布。
- `k`：回合序號，公開遞增。

第 k 輪就取 `runSeq[k]`；那一格若已被別人佔走，就沿 `runSeq` 往下找第一個
還空著的 —— 跳過的規則是決定性的，揭曉時可以完整重算。

這樣同時滿足三件事：**每輪不同**（k 變了）、**可事後驗證**
（所有輸入都會在 `/reveal` 公布，任何人能重算整場）、
**伺服器無法擇優**（它唯一能選的 `run_id` 必須在看到任何結果之前就固定，
而且會被公布出來，事後挑一個好看的 run_id 會讓重算對不上）。

`/reveal` 的回應要跟著擴充：除了現有的 `seats[]`，再加上每一場 run 的
`{ runId, roundCount, seats[] }`，讓「排出履歷」涵蓋連莊。

**兩條實作紀律**（跟隨機性一樣重要）：

1. **回應絕對不能洩漏未來。** 整個 `runSeq` 在回合開始時就算得出來，
   但每一輪只能回傳當輪那一格。不要回傳剩餘袋子、不要回傳長度提示，
   也要注意「爆賞」與「一般賞」兩條分支的處理時間不能有可測量的差異。
   mock 現在的做法（整個袋子就在瀏覽器記憶體裡）是這一條的反面教材。
2. **BUST 必須在伺服器決定並在同一筆交易落盤**（見 SD-2），不能等前端回報。

#### 乙案（每輪拿新的外部亂數）——可行但不建議

如果真的要每輪都有新鮮的外部熵，唯一正確的做法是照
`reserveClientSeedSource()` 對池做的那樣：在第 N 輪結束時，
就先寫死第 N+1 輪要用的**未來** drand round（`FUTURE_ROUNDS = 4`，約兩分鐘後），
那一輪的亂數在承諾之後才會出現。這是可驗證的，也真的每輪新鮮。

代價是**每兩輪之間要等兩分鐘**，而連莊的整個體驗就是「連續免費抽」——
這個代價直接殺掉玩法本身。甲案在安全性上等價（輸入同樣全部先於狀態固定），
沒有理由付這個代價。

---

### streak：檢查過而且沒問題

- `POST /v1/pools` 收不了 `mode: 'streak'`（實測 400）。
- `server/src/smoke.ts:770` 已經有一條測試在守這個閘（「後端不收 classic 以外的玩法」）。
- `seed.ts:189-207` 已把原本的 streak 示範池改回 classic、拿掉 BUST 賞、
  票價 500 → 640，註解說明了理由。這個處理是對的。
- `streak_user_live` 這個部分唯一索引的設計方向正確（同人同時只能有一個 live 回合），
  只是還沒有程式用它。實作時要真的靠它擋，不要在應用層自己數。

---

## 5. auction 尾籤競標 —— 尚未實作，以下為設計建議

> **這一節不是漏洞清單。** 沒有任何競標端點，也沒有任何程式建立 lot 或 bid，
> 所以 shill bidding、結標競態、退款重複這些風險**目前一條都不成立**。
> 以下是實作時的設計建議。唯一屬於已證實現況的是 AD-0。

### 現況

`auction_lots` 與 `bids` 兩張表存在，`bids_one_top`
（`unique index on bids(lot_id) where is_top`）也建好了，
`money.ts:30` 甚至已經把「競標中的最高出價」算進 `locked`。
但沒有任何程式建立 lot 或插入 bid ——
`auction_lots` 在 `server/src/` 裡的唯一引用就是 `money.ts` 那段推導。

（順帶更正一個名稱：表叫 `bids`，不叫 `auction_bids`；
它確實有被 `money.ts` 引用，只是沒有任何寫入方。）

---

#### AD-0 — High — **已證實** — 前端內建一個自動抬價機器人，且不受 MOCK 旗標控制

這是現況的程式碼事實，不是設計推測。

`src/components/AuctionPanel.vue:8` **無條件** `import * as mock from '@/mocks/data'`，
`:44-59` 掛了一個每 11 秒的 `setInterval` 呼叫 `mock.rivalBid()`
（`mocks/data.ts:820`）—— 一個會自動抬價的假買家。
`lib/api.ts` 的 `listLots` / `placeBid` 同樣沒有 MOCK 分支
（`mock.listLots` 過濾寫死的 `poolId: 'p7'`），
點數凍結由 `AuctionPanel.vue:17` 的 `myLocked` 這個元件區域變數維護，
退款靠 `wallet.topup(...)`（`:37`、`:56`、`:95`）—— 在 API 模式全是 no-op。

在 demo 情境下 `rivalBid` 是展示道具，但它沒有被 `MOCK` 關掉。
真的開放競標時，這段程式留在那裡就是字面意義上的
「平台內建的自動抬價機器人」——任何競標系統最不能有的東西。
**建議**：在補後端之前就先移除這個 import 與定時器，不要等到開放前才處理。

---

### 5.1 防賣家對自己的池抬價（shill bidding）

#### AD-1 — Critical（設計） — 資料庫層現在沒有任何東西擋得住，而且不能只靠 API 層

`bids` 只有 `user_id`，沒有任何地方跟 `pools.seller_id` 比對。

**API 層**（必要但不充分）：`placeBid` 裡查出 lot 所屬池的 `seller_id`，
等於出價人就拒絕。

**DB 層**（不能省）：Postgres 的 `CHECK` 不能跨表參照，所以有兩條路：

```sql
-- 甲：把 seller_id 反正規化到 auction_lots，再用 BEFORE INSERT 觸發器擋
alter table auction_lots add column seller_id text not null references users(id);
-- 觸發器：new.user_id = (select seller_id from auction_lots where id = new.lot_id) → raise
```

為什麼 DB 層不能省：這個 repo 的歷史已經證明「只有 API 擋著」是不夠的 ——
S-1 / X-1 那個洞就是 DB 的 check constraint 比 API 寬造成的，
而 seed 腳本真的直接寫過 DB。競標涉及真金白銀的凍結，防線要放在
最後一道寫入路徑上。

#### AD-2 — High（設計） — 分身帳號擋不住，只能提高成本與事後偵測

同一個人用第二個帳號抬價，上面的檢查完全無效。schema 裡沒有任何帳號關聯資訊。
可用的槓桿：

- **綁定真實身分才能出價**：`routes/line.ts` 的 LINE Login 已經是一個現成的
  身分錨點。要求出價者必須有已連結的 LINE 帳號（或已驗證手機），
  能把「再開一個帳號」的成本從零變成有感。
- **記錄出價來源**：在 `bids` 上留 ip / user-agent 的雜湊，供事後稽核。
  這是**偵測**不是**預防**，不要當成防線，但沒有它連事後查都查不了。
- **結構性嚇阻**：規則寫明「賣家（或關聯帳號）得標則交易作廢，
  平台費用照收」。讓抬價在期望值上不划算，比抓人有效。

#### AD-3 — Medium（設計） — 注意修 C-2 的順序：今天抬價沒有報酬，修完就有了

值得單獨點出來：**在 C-2（票金沒有貸方）修好之前，賣家從成交裡拿不到任何點數，
所以 shill bidding 今天沒有報酬。** 一旦 C-2 補上讓賣家收得到錢，
抬價立刻變成有利可圖。這兩件事必須一起規劃 ——
先補收入、後補防線，中間就是一個開著的窗。
（同一個推理也適用 C-3「賣家可以抽自己的池」。）

#### AD-4 — Medium（設計） — `auction_lots` 缺底價、缺反狙擊、缺成交金額

- 沒有保留價／底價欄位，只有 `start_bid`。賣家想保護獎品價值時，
  唯一的手段就變成自己下場抬價 —— **把底價做出來，等於拿掉 shill 的動機**。
  這是防抬價最有效的一招，比任何偵測都實在。
- 沒有反狙擊延長的欄位。`ends_at` 是固定的 bigint，
  結標前一秒出價就贏。mock 有做延長（`data.ts:815`），但那不算數。
- `winner_id` 有，**`winning_amount` 沒有**。結算金額只能回頭從 `bids` 推導，
  而那要靠 `is_top` 這個會被後續出價改動的旗標。結標時必須把成交價
  **釘死在 lot 上**，不然結算依賴的是一個可變的推導。

---

### 5.2 現有的 `locked` 推導在多筆同時競標下正確嗎？

`money.ts` 的那段：

```sql
select b.amount from bids b join auction_lots l on l.id = b.lot_id
 where b.user_id = ${userId} and b.is_top and l.status = 'live'
```

**結論：跨多個 lot 的累加是正確的，但有一個真實的時間窗會漏算。**

#### 正確的部分

- **多筆同時競標會正確累加**：這是 `sum` over 所有 live lot 的 `is_top` 出價，
  同一個人在五個 lot 上各是最高價就會凍結五筆。不會有「同一筆點數
  同時凍結在兩個競標上」的問題 —— 委託裡擔心的這一條，寫法是對的。
- **每個 lot 至多一筆 top**：`bids_one_top` 這個部分唯一索引由 DB 保證。
- **不需要真的退款**：凍結是推導出來的，`is_top` 一變 false 凍結就消失。
  所以「被超越時退款會不會漏、會不會退兩次」在這個模型下**結構上不可能發生**。
  這個設計是對的，實作時**不要**改成真的搬點數。

#### AD-5 — High（設計） — 出價路徑必須呼叫 `lockSpender()`，而現在沒有東西強制這件事

`money.ts` 的 `lockSpender` 註解把規則寫得很清楚：
「**任何『先檢查 available 再花錢』的交易，都要先呼叫這個函式。**」
但那是一個**寫在註解裡的約定**，沒有型別或測試在強制。

`draw()` 遵守了（`pools-service.ts:176`，而且我實測跨池雙花確實被擋下：200 / 402）。
出價路徑還不存在，所以還沒有機會違反 —— 但它是最容易漏的一條，
因為出價「感覺上」不是花錢。少了它，同一個人同時對兩個 lot 出價
會各自讀到同一個 `available`，兩筆都成立，`locked` 超過 `points`。

實作時的鎖序照既有紀律：**先鎖 `auction_lots` 那一列（`for update`）、
再 `lockSpender(tx, userId)`、然後才 `walletOf`**。
先鎖 lot 還有第二個好處，見下。

#### AD-6 — Medium（設計） — 不鎖 lot 會變成唯一鍵違反風暴，而不是乾淨的序列化

出價要做兩件事：把舊的 top 翻成 `is_top = false`、插入自己這筆。
兩個人同時出價時，兩邊都讀到同一筆舊 top、都把它翻掉、都插入 ——
`bids_one_top` 會讓其中一筆插入失敗，那筆交易整個回滾
（連「把舊 top 翻掉」也一起回滾）。**結果是正確的、會自癒的**，
前提是兩個語句在同一筆交易裡，而且輸的一方要重試。

但這是靠唯一索引「事後撞車」來達成正確性，高併發下會變成一連串
unique violation。加一句 `select ... from auction_lots where id = $1 for update`
就能把同一個 lot 的出價乾淨地排成一列 ——
跟 `draw()` 開頭那句 `select * from pools ... for update` 完全同一個手法，
而我實測過那個手法在最後兩格併發時的表現是正確的。

#### AD-7 — High（設計） — 結標的時間窗：凍結解除與扣款之間會出現一段「有錢可花」的空檔

這是從現有推導裡讀出來的、最值得先想清楚的一條。

`locked` 的條件是 `l.status = 'live'`。所以：

- **狀態還沒翻**：lot 已經過了 `ends_at`、但掃描還沒把 `status` 改成 `'ended'`，
  這段期間所有人的點數（含輸家）繼續被凍結。體驗差，但安全。
- **狀態翻了、帳還沒記**：`status` 一變成 `'ended'`，得標者的凍結**立刻消失**，
  而扣款的分錄還沒寫。這中間得標者的 `available` 會**憑空包含他已經欠下的那筆錢**，
  他可以在這個窗口裡把它花掉（去抽卡、去買掛單），
  等結算真的執行時餘額已經不夠了。

**這就是競標版的雙花**，而且成因跟 C-2 那類「借貸不成對」是同一種。

**做法**：把 `status → 'ended'`、釘死 `winning_amount`、
寫得標者的借方分錄、寫賣家的貸方分錄（C-2 修好之後）**放進同一筆交易**，
並且在那筆交易裡 `select ... for update` 鎖住 lot。凍結與扣款不能有時間差 ——
中間不留任何一個瞬間讓那筆錢既不凍結也不入帳。

**另外注意鎖序**：結算會同時碰到得標者與賣家兩個 `users` 列，
這違反了 `lockSpender` 註解裡「每筆交易只鎖一個使用者，所以不會形成死結環」
的前提。結算時必須**依 user id 固定順序**鎖這兩列，
否則會跟並行的出價交易互相死結。這是既有紀律在競標場景下的第一個例外，
要在程式碼裡寫明。

#### AD-8 — Medium（設計） — 轉競標的邊界條件現在沒有任何檢查

`auction_seats` 只有 `z.number().int().positive()`（`routes/pools.ts:169`），
**沒有跟 `totalTickets` 比對**。

- **N > 總籤數**：前端的
  `inAuctionPhase = mode === 'auction' && remainingTickets <= (auctionSeats ?? 0)`
  （`PoolOverview.vue:31`）會從**一開賣就成立**，整個池直接進競標階段，
  `DrawPanel` 完全不顯示 —— 這個池變成純競標，一支籤都抽不到。
- **N = 0**：`positive()` 擋掉了。
- **池在轉競標前就完抽**：沒有任何處理。要定義清楚是「不開競標」
  還是「最後 N 支不賣、保留給競標」——後者需要在開池時就把那 N 格標記起來
  （`pool_seats` 上再一個欄位，或用 `auction_lots` 提前佔位），
  否則「最後 N 支」根本無法保證真的留得下來。

**建議**：建池時加 `auctionSeats < totalTickets` 的驗證，並且明確選擇
「保留」語意（開池時就把尾端 N 格劃給競標），不要靠 `remainingTickets` 的
即時比較來決定 —— 那個比較在併發下沒有意義。

---

### auction：檢查過而且沒問題

- `POST /v1/pools` 收不了 `mode: 'auction'`（實測 400）。
- `bids_one_top` 唯一索引已存在，「同一個 lot 只有一筆最高價」由 DB 保證。
- `walletOf()` 對競標凍結的查詢寫法正確：限定 `is_top` 且 lot 為 `live`，
  跨多個 lot 正確累加，不會重複凍結同一筆點數。
- 「凍結用推導、不真的搬錢」的模型讓「退款漏發／重複退款」結構上不可能發生。
- `seed.ts:262` 已把原本的 auction 示範池（`p-vault-2`）改回 classic。

---

## 6. 跨玩法的共通問題

#### X-1 — High — DB 的 mode 約束比 API 寬，兩層說法不一致

`migrations/002_core.sql:85` 允許五種 mode，`routes/pools.ts:163` 只收一種。
中間的落差就是 S-1 示範的那個洞：DB 層一寫進非 classic 的 mode，
公開 API 原樣吐出、前端照著渲染徽章甚至導去 mock 頁面，而後端照 classic 發獎。
今天靠「沒人會去改 DB」撐著，但 seed 腳本歷史上就這樣做過
（`seed.ts` 的一連串註解就是在收拾這件事）。

**建議**：加一條 migration 把 constraint 收成 `check (mode in ('classic'))`，
等哪個玩法真的做好了再放寬那一個。約束是文件，讓它說實話。

#### X-2 — Medium — 還元率有兩套算法，前後端各一套

伺服器的 `shared/economics.ts` 只有 classic 的平除
（獎品總值 ÷ 票收），而且它自己的檔頭就寫明「這裡只涵蓋 classic」。
前端另外有一份 `src/lib/economics.ts`，裡面是 shitei / streak / auction 的
蒙地卡羅模擬（註解舉例：shitei 平除會算成 161%，真值在 84% 附近；
auction 平除會是 777%）。

存進 `pools.return_ratio`、顯示給買家看的那個數字是**伺服器算的**，
也就是平除的那一版。一旦開放非 classic，公開的還元率會跟前端
`lib/economics.ts` 算出來的數字互相矛盾，而且會矛盾得很誇張。
另外 `verdictOf` 在前端被重新實作了一次（`lib/economics.ts:218`），
訊息文字已經跟 shared 版分岔。

#### X-3 — Medium — `redeemRatio` / `redeemAllowed` 只涵蓋「每籤必得、票價固定」

這道閘本身**是有效的**，實測 141% 被擋下（見 C-4）。
但它的分母是 `seats × price`，這個式子在兩種玩法下會失真
（以下兩點屬於**設計階段的提醒**，不是現存漏洞 —— 那兩種玩法還沒實作）：

- **streak**：付一次入場費可以連續免費抽 N 次。實際票收遠低於
  `seats × price`，兌現率的真值會被嚴重低估 —— 也就是這道閘會**放行**
  一個真的會憑空印點數的池。
- **auction**：成交價由市場決定，建池當下根本不知道分母是多少。

`redeemRatio` / `redeemAllowed` 在前端完全沒有被引用（全站零呼叫點），
所以它是純粹的伺服器端防線 —— 這件事是對的，但也表示賣家在表單上
不會事先看到自己會被這道閘擋下，只會在送出時吃到一個 400。

#### X-4 — 見 C-2 — 票金銷毀在五種玩法都一樣

不管哪種玩法，只要走 `draw()` 扣款，錢就消失。streak 的入場費與
auction 的成交價將來也會走同一條路，所以這個結構性問題要先解決，
不然每補一種玩法就多一個漏財的出口。

### 跨玩法：檢查過而且沒問題

- **冪等綁 `user_id`**（migration 015）在 classic 下驗證正確；
  對其餘四種玩法沒有影響，因為它們沒有寫入路徑。
  本人重放回原本那一筆、他人用同一把鑰匙照常建立新的一抽 ——
  這在每種玩法下都是對的語意。
- **交易外的外部 I/O**：`tryOpenPool()` 先在交易外跟 drand 拿值再開交易，
  `drandFetch` 有 6 秒逾時。沒有在持鎖狀態下做 HTTP 的路徑。
- **背景推進**：`index.ts:84` 有掛 `sweepPools()`，
  `committed → open` 與 `sold_out/cancelled → revealed` 兩段都會自動走。
- **公平性承諾 v2**：`commitPool` 把獎品清單的雜湊一起綁進 commit，
  開賣後偷換獎品內容會在 `/reveal` 的重算中被抓到。
- **對帳三方一致**：`SUM(points_ledger.delta where reason='draw')`
  == `SUM(draws.cost)`；`count(prizes) == count(taken pool_seats) == sum(cardinality(draws.seats))`
  對每一個經由 API 抽過的池都成立（實測，見 C-2 的查詢輸出）。

---

## 7. 我認為最該優先修的三條

### 第一：C-2 票金沒有貸方（Critical）

這是**現在正在發生、每一筆抽卡都在發生**的金錢問題，而且不需要任何攻擊者。
賣家承擔獎品成本卻收入為零，平台的點數總量單向蒸發，
帳本上沒有任何科目對應「抽卡營收」。其他所有發現都是「將來會怎樣」或
「宣傳與實作不符」，只有這一條是每一次 `POST /draw` 都在漏。
先確認是設計取捨還是漏寫 —— 如果是前者，也要有一筆進 `u-platform`，
否則永遠對不出帳。

**注意修的順序**：修好這條之後，C-3（賣家可抽自己的池）會立刻從
「無利可圖」變成「左手換右手」。兩條要一起改，或先改 C-3。

### 第二：C-1 classic 的最後賞規則沒有實作（Critical）

平台今天賣的每一個池都掛著「抽走最後一籤額外獲得最後賞」的徽章，
而後端一行都沒有。這是對付費使用者的不實陳述，
而且是這個平台唯一活著的玩法的核心賣點。
兩條路都可以接受 —— 實作它，或改掉文案改叫無敵賞 ——
但「掛著沒實作的規則收錢」不能繼續。
好消息是實作的併發基礎已經在了：`draw()` 開頭的
`for update` 讓「誰是最後一個」在同一筆交易裡是唯一且可判定的。

### 第三：X-1 + SD-0 + AD-0 把「沒實作」這件事變成大聲的失敗（High）

現在擋住 streak / auction 的是三道互不相關的閘
（API enum、seed 內容、賣家表單的 `enabled: false`），
而閘後面是一套**在 API 模式下也照跑的前端 mock**：
入場費 no-op、假的自動抬價機器人、狀態只存在瀏覽器記憶體裡。
任何一道閘不小心被打開（一個把 enum 加回來的 commit、一筆 admin SQL），
就會有人在一場沒人記帳的遊戲裡花真的錢。

兩個小改動就能把它變成安全的：
(1) 加 migration 把 `pools.mode` 的 check constraint 收成 `('classic')`；
(2) 把 `lib/api.ts` 的 `startStreak` / `streakDraw` / `bankStreak` /
`listLots` / `placeBid` 在 `!MOCK` 時直接 throw，並拿掉
`AuctionPanel.vue` 對 `mocks/data` 的無條件 import 與那個 `rivalBid` 定時器。

---

## 附錄：本輪的修改與環境還原

- **沒有修改任何 `server/` 或 `src/` 的程式碼。** 這一輪只稽核。
- 測試過程中對本機 `vaultdraw_test` 做過破壞性操作
  （壓低 `u-shop` 餘額、把 `p-shop-2` / `p-shop-3` 的 mode 直接改成
  shitei / streak、抽掉多個池的籤位）。稽核結束後資料庫已重建為
  乾淨的 `npm run migrate` + `npm run seed`。
- 稽核期間起的 `tsx src/index.ts` 已經關掉。
- 報告內不含任何金鑰、token 或密碼。
