# 卡冊優先（inventory-first）改造計畫

狀態：**計畫，尚未實作。** 這份文件只描述要改什麼、為什麼、以及怎麼退回去。

最後更新：2026-08-27

---

## 一、要解決的問題

現在系統裡「一張卡」沒有單一的存在。同一張實體卡可以同時是：

- 三個不同池的 `pool_prizes` 各一列（資料庫**完全不擋**）
- 一筆 `listings` 掛單
- 一列 `prizes`（玩家卡冊）

唯一存在的防線是 [001_init.sql:46](../server/migrations/001_init.sql) 的 `listings_cert_live`，只管市場掛單。

改造目標：**一張實體卡在系統裡只有一列，同一時間只能在一個地方。**

### 這個改造解決什麼、不解決什麼

| | |
|---|---|
| 解決 | 一卡多賣（同一張卡進兩個池／進池又掛單） |
| 解決 | F-1〜F-6：擁有權轉手後，結算付錯人 |
| 解決 | 池到期時未抽走的卡「沒有地方可以回」 |
| **不解決** | 賣家手上到底有沒有那張實體卡 |

第四列要講清楚：入庫仍然是自我宣告。PSA API 目前 403，能驗的只有「這個編號存在」，驗不了「這張卡是你的」。防詐還是靠出貨違約累積那套（rules.md 第五節）。

---

## 二、現況：市場那半邊已經做好了

讀完程式碼之後，缺口比原本預期的小很多。

```
pool_prizes(id, pool_id, tier, card jsonb, total, buyback)
    池的獎品目錄。card 是自由填寫的 jsonb，total 可以 > 1
    ✗ 不指向任何真實的卡

pool_seats(pool_id, seat, prize_id → pool_prizes, taken_by, draw_id)
    籤位。prize_id 指的是 pool_prizes（目錄），不是某一張實體卡

prizes(id, user_id, pool_id NOT NULL, seat, draw_id, card jsonb, tier, status, ...)
    卡冊。**只有抽卡才會產生**（pools-service.ts:247 是唯一入口）

listings(id, ..., prize_id → prizes, cert_no, status)
    市場掛單。✓ 已經指向真實的卡
```

### 已經做對的兩件事

**一、`listings` 已經是卡冊優先。** [002_core.sql:208](../server/migrations/002_core.sql)：

```sql
alter table listings add column if not exists prize_id text references prizes(id);
create unique index listings_prize_live on listings(prize_id)
  where status = 'live' and prize_id is not null;
```

一筆掛單必須指向一列真實的卡，而且一列卡同時只能有一筆有效掛單。**市場那半邊不用改。**

**二、`prizes.user_id` 已經就是擁有權，而且已經會跟著移轉。**

- `routes/orders.ts:102` 市場成交：`update prizes set user_id = ${me}, status = 'stashed'`
- `routes/social.ts:268` 贈送：`update prizes set user_id = ${o.from_user}`
- `orders-service.ts:97` 需寄送的成交：`update prizes p set user_id = ${owner}`

卡在平台內轉手時，那一列的身分是穩定的，只有 `user_id` 換人。

### 所以真正的缺口只有四個

1. **池那邊** —— `pool_prizes` 是自由 jsonb，不指向真實的卡
2. **入口** —— 除了抽卡沒有別的方法產生一列卡（賣家無法「上傳到卡冊」）
3. **custodian** —— 實體卡在誰手上目前是**推導**的（`pool_id → pools.seller_id`，`status='shipped'` 時是 owner）。一旦卡可以上傳、`pool_id` 可以是 null，這個推導就斷了
4. **cert 唯一性** —— 只蓋到市場掛單，池完全沒蓋

### 結構障礙

[002_core.sql:182](../server/migrations/002_core.sql)：

```sql
pool_id text not null references pools(id),
```

`prizes` 的預設語意是「卡是從池裡抽出來的」。一張卡不可能先存在、再進池。這一欄是整個改造的第一個閘門。

---

## 三、目標結構

**不新開 `cards` 表，就地擴充 `prizes`。**

理由：`pool_settlements.prize_id` 和 `shipments.prize_ids[]` 已經指著它，改表名要同時動 FK、程式碼、和既有資料，是大爆炸式的改動。擴充是可以分段上、隨時退的。

代價要誠實講：表名 `prizes` 會變得不準確——使用者自己上傳進卡冊的卡從來沒有被「贏」過。這是命名債，之後可以單獨開一支 rename + 相容 view 處理，不擋現在。

### 3.1 `prizes` 新增的欄位

```sql
custodian_id  text  -- 實體卡在誰手上。只有出貨與站外接管會改
origin        text  -- 'draw' | 'upload' | 'seed'
grader        text  -- 從 card jsonb 拉出來，唯一索引要用
cert_no       text  -- 同上
```

`pool_id` 改成 nullable。

> **不新增 `owner_id`。** 原本的草稿有這一欄，是錯的：`prizes.user_id` **已經就是**擁有權，而且已經會跟著交易移轉（見第二節）。多加一欄等於讓「誰擁有這張卡」有兩個來源，而這是一個算錢的系統——兩個來源遲早會漂移，漂移的那一天沒有任何辦法判斷哪一邊是對的。
>
> F-1〜F-6 的病灶不是 `prizes.user_id` 錯了，是 `pool_settlements.buyer_id` 是它的**過期快照**。修法是讓結算透過 `prize_id` 讀當下值，**不是加欄位**。

`status` 的 check 加入兩個新值：

```
in_book     閒置在卡冊，可以上架、可以進池
in_pool     押在某個池裡，不能上架、不能刪、不能再進另一個池
```

### 3.2 為什麼擁有權和 `custodian_id` 一定要分開

這兩件事在系統裡從頭到尾都是分開的，只是現在沒有明講：

| 玩家做的事 | owner（`user_id`） | custodian |
|---|---|---|
| 抽到卡，留著 | 玩家 | 賣家（實體還在他抽屜） |
| 賣回 | 回賣家 | 沒動過 |
| 上架市場，別人買走 | 新買家 | **還在原賣家**，由他寄給新買家 |
| 申請出貨、簽收 | 玩家 | 玩家 |

第三列是重點：卡可以在平台內轉手好幾次，實體從頭到尾沒離開原賣家。

**F-1〜F-6 的根源就是這個沒分開。** `pool_settlements.buyer_id` 在抽卡當下綁死，之後卡經市場轉手，按回收時錢付給前一個持有人。修法是結算一律透過 `prize_id` 讀 `prizes.user_id` 的**當下值**。

### custodian 目前是推導的，而那個推導快要斷了

現在不需要這一欄，因為它推得出來：

```
status = 'shipped'  → custodian = user_id（已經寄到手上）
其他                 → custodian = pools.seller_id（走 pool_id join）
```

推導成立的前提是 **`pool_id` 是 NOT NULL**。一旦卡可以直接上傳進卡冊（`pool_id` 為 null），這個推導就沒有答案。

`public.ts:276` 那個 `delivery = status==='stashed' ? 'vault' : status==='shipped' ? 'ship' : null` 就是這個推導的具體樣子——它其實一直在問「實體卡在誰手上」，只是用 status 代打。

**能不能上架的判準**也從此明確：只有 `custodian_id` 還是原賣家、且 `status = 'in_book'` 的卡能上架或進池——上架的隱含承諾是「有人會寄出」。已經寄到你手上的卡要再賣，你得自己當出貨方。

### 3.3 `pool_prizes` 要指向真實的卡

新增 `card_id text references prizes(id)`。

**`card jsonb` 一定要留著，不能改成透過 FK 去讀。**

manifest 是從 `pool_prizes.card` 算出來的（[fairness.ts](../src/shared/fairness.ts) 的 `manifestString`）。如果改成即時 join 卡冊那一列，使用者事後編輯卡名，manifest 就會跟著變，而 commit 已經公布過——一批誠實的池會突然全部顯示「被竄改」。

所以：**`card` 是開池當下封存的快照，`card_id` 是新增的指標。** 兩者並存，快照優先。

### 3.4 `pool_seats` 要指到具體那一張

`pool_prizes.total` 可以 > 1（同一張卡 N 份）。inventory-first 的前提是「一張實體卡一列」，所以 N 份 = N 列卡，需要 N 個籤位各自指到不同的那一列。

新增 `pool_seats.card_id text references prizes(id)`。

> ⚠️ **`pool_seats.card_id` 絕對不能從任何公開端點流出**，規則等同 `pools.server_seed`。它等於把「幾號籤中哪張卡」直接寫在資料庫裡；洩漏出去就是盲盒被拆穿。這是這次改造**新增的洩漏面**，寫測試時要專門守。

順帶更正一條我先前寫錯的：**建池 API 已經擋了 `certNo` + `total > 1`**（`routes/pools.ts:257` 的 `.refine()`，訊息「有鑑定編號的卡只能開 1 籤」）。

還沒擋的是另外兩條路：
- **`seed.ts` 繞過 API 直接寫資料庫**（`public.ts:292` 註解點名的 flareonPSA 就是這樣來的，一個編號開 15 籤）
- **資料庫本身沒有這條約束**，任何 admin SQL 都寫得進去

而且 API 那層擋的只是「同一列 `total > 1`」，**擋不了同一個編號分散在不同池的不同列**——那正是 022 的唯一索引要補的。

---

## 四、移轉的封閉清單

「什麼樣的交易讓系統判定卡在誰手上」必須是一份**封閉清單**——任何不在清單上的路徑就是一個洞。

### owner 會變的

| 事件 | owner | custodian | 備註 |
|---|---|---|---|
| 抽卡 | 賣家 → 玩家 | 不變 | **從 insert 改成 update** |
| 市場成交 | 賣方玩家 → 買方玩家 | 不變 | |
| 賣回 | 玩家 → 開池賣家 | 不變 | 卡回到 `in_book` |
| 逾期未出貨退款 | 玩家 → 賣家 | 不變 | 現有 `status='refunded'` |
| 池到期未抽走 | 不變 | 不變 | 只是 `in_pool → in_book` |
| 站外接管 | 舊登記人 → 新持卡人 | **一起變** | 見第六節 |

### custodian 會變的

只有兩個：**出貨簽收**，和**站外接管**。

> **不變式：站內交易一律不碰 `custodian_id`。** 這一條可以寫成測試。

### 抽卡從 insert 改成 update

這是程式面最大的改動。現在 `pools-service.ts:247` 是 `insert into prizes`，之後要變成：

```sql
update prizes set owner_id = $buyer, status = 'stashed', draw_id = ..., seat = ...
 where id = $card_id and status = 'in_pool' and pool_id = $pool
```

必須在同一個 transaction 裡、對那一列 `FOR UPDATE`。理由跟 `pool_seats` 那條併發防線一樣：`update ... where status = 'in_pool'` 只會有一個人成功。

---

## 五、cert 唯一性

### 5.1 必須是資料庫約束

「上傳時去比對整個後台」如果寫成應用層的 `select 有沒有 → 沒有就 insert`，擋不住併發：兩個請求同時查、都查到沒有、都寫進去。

這條教訓已經寫在自己的程式裡了（[001_init.sql:44](../server/migrations/001_init.sql)）：

> 這是資料庫層的約束，不是應用層的檢查 —— 應用層的檢查擋不住併發。

```sql
create unique index prizes_cert_alive
  on prizes(grader, cert_no)
  where cert_no is not null;
```

沒有 `status` 條件——卡永遠留在系統裡（見 5.3），所以編號永遠被同一列佔著。

### 5.2 順手要修的既有 bug：唯一鍵少了 grader

現在的索引是 `on listings(cert_no)`，**沒有 grader**，而 grader 只存在 `card` jsonb 裡。

結果：PSA #12345678 和 BGS #12345678 是**兩張完全不同的卡**，系統會判定衝突，把第二個人擋掉。八位數編號的鑑定公司不只 PSA，撞號是遲早的事。

要一起改成 `(grader, cert_no)`。

### 5.3 出貨完的卡不用從系統消失

原本以為需要一個終結狀態把編號從索引釋放掉。不需要——卡留在買家卡冊裡，只是 `custodian_id` 換人。編號一直被同一列佔著。

**唯一性從頭到尾靠同一條索引，沒有例外要處理。**

### 5.4 裸卡

裸卡沒有編號，索引蓋不到。但 inventory-first 給的是**結構保證**：一列卡只有一個 `status`，物理上不可能同時 `in_pool` 兩次。索引只是第二道防線，負責擋「同一張實體卡被登記成**兩列**」。

---

## 六、站外轉手的接管流程

平台內成交會自動移轉。站外賣掉的卡，新持有人要上傳同一個編號時會被唯一索引擋住——而他是對的那一方。

### 流程

1. 新持有人上傳，系統告知此編號已登記，開啟接管申請
2. 他提交**時間戳照片**：卡背鑑定標籤 + 手寫紙條**同框**，紙條寫今天日期 + 平台名 + 他的會員編號
3. 原登記人有 N 天可以異議
4. 逾期或仲裁通過 → `owner_id` 與 `custodian_id` 一起轉移

### 兩個實作上會決定成敗的地方

**爭議期間那張卡必須是鎖住，不是「暫時可用」。** 如果上傳完就能立刻進池或掛單、等有人異議再處理，攻擊就是「上傳 → 馬上賣掉 → 爭議時人已經跑了」。**預設擋住，審過才解鎖。**

**證明要能防盜圖。** 光要一張卡的照片沒用，eBay 上抓得到。時間戳照片是收藏圈的標準做法：舊照片做不出來，別人的照片也用不了。

### 已知缺口：搶註

**第一次上傳不需要證明。** 有人可以拿 PSA 公開的 pop report 去搶註一堆他根本沒有的編號。

判斷：**不致命，但要知道。**

- 搶註賺不到錢——註冊了不出貨，違約累積照樣把開池權關掉
- 真正的持卡人可以發起接管，而搶註的人**拿不出時間戳照片**，仲裁必輸
- 代價是「真持卡人多跑一趟客服」，不是「卡被偷走」

要進一步壓低的話，可以讓「沒有實際使用過」的登記不佔位——但那會讓索引條件變複雜，併發窗口又回來了。**傾向先接受多跑一趟客服**，等真的有人這樣搞再處理。

---

## 七、回庫

### 兩條路，不是一條

- **沒被抽走** → 池結束時回庫
- **抽走了但被賣回** → 賣回成交當下就回庫

rules.md 第四節已經寫了「卡回到賣家手上」，但現在沒有「手上」這個地方可以回。兩條都要落到同一個卡冊，不然賣回的卡會變成第二種孤兒。

### 回庫不能等整池結算完

池結束 ≠ 池結清。已抽走的卡還有出貨和七天鑑賞期要跑，可能兩三週。

沒被抽走的卡**從來就不屬於任何人**，跟結算無關，可以立刻回。這跟已經定下的逐筆釋放是同一個原則（rules.md 第六節）。

### 賣家提前關池要有代價

池結束有三種：抽完、到期、**賣家提前關池**。第三種加上「立刻回庫、可以馬上再開」就變成：

> 玩家看到 A 賞噴火龍還在池裡，決定花錢抽 → 賣家看到有人開始抽 → 關池 → 卡收回

玩家沒有金錢損失（沒抽到就沒付），但貨架變成隨時可以撤的假貨架。

**建議：提前關池的卡要冷卻 24 小時才能重新上池。** 到期關池和抽完不受影響，只罰主動撤的。

> 順帶確認：提前關池**不會**讓賣家得到籤序上的好處。種子是 drand 未來輪次；舊池種子公開後他知道「A 賞在第 7 號」，但新池是新種子新籤序，那個資訊沒用。這裡只需要防假貨架，不用防作弊。

### 原子性

`in_pool → in_book` 要跟池關閉在同一個 transaction 裡，卡那一列 `FOR UPDATE`。

不然有一個很窄但很難查的 race：池正在關閉的同時有人抽最後一支——卡同時回庫又被抽走。

---

## 八、遷移分段

分四支，每一支都能單獨上線、單獨退回。

| | 內容 | 風險 |
|---|---|---|
| **021** | `prizes` 加欄位、`pool_id` 改 nullable、`status` check 放寬 | 低。純新增 |
| **022** | `grader`/`cert_no` 拉成欄位、唯一索引、修 `listings` 索引 | 中。既有資料可能已經有衝突，要先掃 |
| **023** | `pool_prizes.card_id`、`pool_seats.card_id`、上池押記、回庫 | 高。抽卡從 insert 改 update |
| **024** | 接管流程（`cert_claims` 表 + 後台仲裁） | 低。全新功能，不動既有路徑 |

**022 上線前必須先跑一次掃描**：既有 `pool_prizes` 和 `listings` 裡有沒有已經重複的編號。有的話唯一索引會建不起來，而且那些就是已經發生的一卡多賣，要先人工處理。

---

## 九、既有資料怎麼辦

### 回填是無損的，而且都是事實

```sql
custodian_id = 那個池的 seller_id            -- 從 pool_id join pools
             = user_id  當 status='shipped'  -- 已經寄到手上了
origin       = 'draw'                        -- 現有的 prizes 全部來自抽卡
grader/cert_no = 從 card jsonb 拉出來
```

`custodian_id` 的回填**就是現在那個推導的結果**，不是新事實——只是把一直隱含在 `pool_id` + `status` 裡的東西寫下來。沒有任何一列被賦予它沒有發生過的事實。

### 既有的池不受影響

`pool_prizes.card_id` 留 `null`，代表「舊制，沒有對應的卡冊列」。舊池照舊運作：抽卡仍然 insert 新列。

**新舊兩條路徑要並存到所有舊池結清為止**，不能一次切換。這是 023 風險高的主因——`pools-service.ts` 會有一段時間帶著兩套抽卡邏輯。

判斷依據建議用 `pool_prizes.card_id is null`，不要用日期或 pool id——判斷依據必須是資料本身帶著的，不是外部推論的。

### 舊池不享受回庫

它們本來也沒有。017 的註解已經寫明：「那些籤從來沒有產生過 prizes 列，所以『回到賣家手上』不需要任何搬移動作，只是不再賣」。

---

## 十、退版

021 / 022 / 024 全部是 `add column` / `add index` / `create table`，drop 掉就還原。

023 是唯一有狀態轉移的：一旦有卡以 `origin='upload'` 進過池，退版會讓那些卡失去 `pool_id`（NOT NULL 收不回去）。**所以 023 的退版窗口只到第一張上傳卡進池為止**，這一點要在上線前寫進 runbook。

`status` 的 check 收回去，前提是沒有任何 `in_book` / `in_pool` 的列。

---

## 十一、這份計畫沒有解決的

- **實體卡到底在不在賣家手上** —— 見第一節。這是自我宣告，防線是違約累積
- **寄存到期** —— rules.md 說目前只通知不動。卡冊變成主要容器之後卡會一直累積，這條會從「之後再說」變成每天遇到。不影響本計畫的設計，但要排時間
- **表名 `prizes` 不準確** —— 命名債，之後單獨處理
- **搶註** —— 見 6 節末，決定是接受
