# VaultDraw 交接文件

寫給下一個接手這個專案的 AI。這份文件不重複程式碼與 git log 講得清楚的事，
只寫**從程式碼看不出來的判斷、踩過的坑、以及還沒補完的洞**。

最後更新：2026-08-25

---

## 1. 這是什麼

VaultDraw — 台灣市場的鑑定寶可夢卡「線上抽選」（オリパ）平台。

- 前端：Vue 3.5 `<script setup>` + Pinia + Vue Router 4 + Vite 5 + TypeScript 5.6，手寫 CSS（變數在 `src/styles/tokens.css`）。部署在 **GitHub Pages**。
- 後端：Hono + postgres.js + zod，原生 SQL 搭配明確交易與 `SELECT ... FOR UPDATE`。部署在 **Railway**。
- `src/shared/` 是前後端共用的邏輯，用 `server/scripts/sync-shared.mjs` 複製一份到 `server/src/shared/`。**改了來源要跑 `cd server && npm run sync-shared`**，`npm run check` 會驗證兩邊一致。

### 不可違反的約束（使用者反覆強調過）

| 約束 | 原因 |
|---|---|
| 只部署到使用者的私人 GitHub 帳號 `ademczw` / `AdemCZW` | 使用者指定 |
| 用 GitHub Pages，不要改用 Cloudflare | 使用者指定 |
| **點數永遠不可以換回現金** | 法律問題：刑法 266 條的「對價關係」。這不是產品選擇，是紅線 |
| **平台不可以買回自己送出的獎品** | 電子遊戲場業管理條例第 14 條第 2 項第 2 款明文禁止「買回提供給客人之獎品」。我曾經建議過 70% 回購當行銷賣點，查證後發現違法並收回 |
| 手機版 UI **不可以有 emoji** | 使用者指定。圖示一律用 inline SVG 或 CSS 畫 |
| **Secret Access Key / ADMIN_PASSWORD / LINE_CHANNEL_SECRET 不可以貼進對話** | 使用者原話：「這組密碼不要貼給我」。只能寫進 Railway 環境變數 |

---

## 2. 這個 repo 的三大陷阱

這三件事造成的 bug 佔了整個專案除錯時間的一半以上。**動版面之前先讀完這一節。**

### 2.1 `min-width: auto`

grid / flex 的子元素預設 `min-width: auto`，不會縮到比內容小。長字串、卡圖、
`<summary>`、按鈕都會把容器撐爆或反過來被擠成一個字寬。

**規則**：grid / flex 的子元素一律補 `min-width: 0`，欄位定義用 `minmax(0, 1fr)` 不要用 `1fr`。

### 2.2 `transform` 會變成 `position: fixed` 的定位基準

祖先只要有 `transform`（Tilt3D、換頁轉場、任何動畫），底下 `position: fixed`
的元素就不再相對視窗定位。底部固定列、對話框都中過。

**規則**：會被轉場包住的固定元素用 `<Teleport to="body">`。`z-index` 也要給值 —— 有 transform 的元素自成堆疊脈絡，不給值會被蓋住。

### 2.3 底部導覽的讓位只能有一個來源

`--nav-total` 在手機上是 `--nav-h + --safe-b`，桌機是 0。全域頁尾（`App.vue` 的 `.foot`）
已經留了一份。**頁面根容器不要再加一次**，否則每頁下緣會多出一段捲得到卻空無一物的黑。

底部固定元素要避開導覽時用：
```css
bottom: calc(X + max(var(--nav-total, 0px), var(--safe-b, 0px)));
```
取 `max` 的理由：手機的 `--nav-total` 已含安全區，桌機是 0 時才輪到 `--safe-b`。
慣例寫在 `src/components/NotifyBell.vue` 的註解裡。

### 2.4 額外：量測跑版的正確方法

**只檢查 `document.scrollWidth > innerWidth` 是不夠的** —— 這個 repo 的跑版
多半不會觸發那一項（被 `overflow: hidden` 裁掉、或只是內部擠壓）。

正確做法是逐元素：
```js
[...document.querySelectorAll('sel *')].filter(e => {
  const r = e.getBoundingClientRect()
  return r.right > innerWidth + 0.5 || r.left < -0.5 || e.scrollWidth > e.clientWidth + 1
})
```
已知會命中但屬正常的：`.sr-only`（1px 裁切盒）、橫向捲軸（`.tabs`/`.sorts`）的子元素、
`CardArt` 內部被 `overflow: hidden` 裁住的 `.art` / `.sheen`。

### 2.5 其他踩過的坑

- **Postgres：一個語句失敗會讓整個交易作廢**。在交易裡 `try/catch` 再 `return` 沒有用，`COMMIT` 還是會失敗。要用 `ON CONFLICT DO NOTHING ... RETURNING`。
- **grid 的 `place-items: center` 碰上比容器大的子元素 + `overflow: hidden` 會裁得不對稱**，看起來像整個偏右。要置中就用絕對定位 + `translate(-50%, -50%)`。
- **手機視窗高度一律用 `dvh`，不要用 `vh`**。`vh` 取的是網址列收起時的高度。
- **同一個 scoped stylesheet 裡不要有兩個同名 class**。曾經有兩個 `.more`（`<details>` 與卡片展開鈕），同權重、後者勝，把 `<summary>` 擠成一字一行。
- **Vue `Transition` 用 `requestAnimationFrame` 換 class，`:duration` 保護不到**。整頁換頁轉場已經移除（原因寫在 `App.vue` 的註解裡），不要加回來。
- **`<input type="number">` 的 `min` 配 `step` 會憑空造出 stepMismatch，而且是靜默的**。`min="1" step="10"` 的合法值是 1、11、21…，所以**預設值 300 本身就不合法**；`min="10" step="10"` 讓預設買回價 36 不合法。瀏覽器會在 `submit` 事件**之前**擋下送出，`@submit.prevent` 的處理函式根本不會被呼叫 —— 畫面上一句話都沒有。開池表單就是這樣壞的（使用者回報「為什麼還是無法開池」）。點數是整數，`step` 一律寫 `1`；表單另外加 `novalidate`，讓「還差什麼」只有一份來源。
- **禁用的按鈕沒有辦法解釋自己**。開池表單原本有六個送出條件，只有一個會顯示訊息，其餘五個只是把按鈕變灰 —— 而缺的欄位常常捲在畫面外。現在改成一份點得動的問題清單（點一項就捲過去並聚焦），按鈕不禁用，按下去指路。
- **Claude 的 Browser pane 會讓 `document.hidden === true`**，IntersectionObserver 的回呼不會送達，測不了無限捲動。要測捲動請改用 Playwright。

---

## 3. 幾個要理解的機制

### 3.1 公平性：commit-reveal

- v1：`commit = SHA256(server_seed_bytes)`
- v2：`commit = SHA256(server_seed_bytes ‖ manifest_hash_bytes)`，manifest 十欄
- v3：同 v2，但 manifest 尾端多一欄 `buyback`（賣家宣告的買回價）
- **v4（現行）**：再多一欄 `variantId`（卡片變體）

**版本存在池上（`pools.commit_version`），驗算端照池宣告的版本重算，不「依序嘗試」。**
依序嘗試等於接受「任何一版算得過就好」，一個作弊的伺服器可以挑對自己有利的那一版送出。
序列化只在尾端**追加**欄位，所以 v2 的池逐字不變 —— 加欄位沒有讓既有的池集體變成「被竄改」。

manifest 是整池獎品的規格化字串（`src/shared/fairness.ts` 的 `manifestString`）。
**刻意不用 `JSON.stringify`** —— 鍵的順序與跳脫規則是實作決定的，不能拿來當雜湊輸入。

v4 補的是「同一組卡號的不同版本」那條縫：v3 為止 `name` / `setCode` / `cardNo`
三欄相同的兩張卡在承諾裡是同一個東西，而實測 SV2a-025（ピカチュウ）
普卡 cardmarket €0.02、同卡號的マスターボールミラー €369 —— 差約 18,000 倍。
已實測：`UPDATE pool_prizes SET card = jsonb_set(card, '{variantId}', …)`
只換變體、卡名卡號買回價一個字不動，`/reveal` 的驗算從 `{"ok":true,"version":4}`
變成 `{"ok":false,"reason":"commit 對不上…"}`；而同一個偷換用 v3 的規則序列化出來
**逐字相同**（v3 hash 前後都是 `db1f6f94…`），那就是非升版不可的理由。

把獎品內容綁進 commit 之後，「開池前偷換卡」會被驗算抓到。已實測：直接
`UPDATE pool_prizes SET card = jsonb_set(...)` 把最後一個獎換成便宜卡（不動座位順序），
驗證從 `{"ok":true,"version":2}` 變成 `{"ok":false,"reason":"commit 對不上"}`。

客戶端種子用 **drand（League of Entropy）**，開池時先預約一個未來的輪次，
賣家沒辦法反覆重算來挑對自己有利的種子。洗牌是 Fisher-Yates 配 `HMAC-SHA256`
串流，用**拒絕取樣**不是取餘數（取餘數會有偏差）。

種子裡刻意各留一個固定樣本：`p-official-3` 是 v2、`p-official-4` 是 v3、
`p-official-5` 是 v4（同卡號三個變體）。**三個都 revealed**，
「升版沒有讓舊池集體變成被竄改」這條迴歸才有東西可驗。

> ⚠️ **正式環境現存的池仍然是 commit v1／v2、`floor_ratio` 是 null** —— 種子只建新池，不回頭改舊的。
> migration 018 依 `manifest_hash` 是不是 null 把它們回填成 `commit_version` 1 或 2。
> 它們沒有宣告過買回價，所以**抽到的卡不能回收**（見 4.1）。

### 3.2 錢

餘額是**帳本推導**的（`SUM(points_ledger.delta)`），不是一個可以直接改的欄位。
`locked`（凍結）由未結束的訂單、出價、以及 **pending 的交易報價**推導。

- `money.ts` 的 `lockSpender()` 一定要在算餘額前呼叫。少了它，同一個人同時買兩張卡會鎖到兩列不同的 `listings`、互不阻擋，兩邊都判定「錢夠」，於是花掉兩份同一筆錢。
- 接受出價時要**先把該筆 offer 的狀態改掉再算餘額**，否則那筆 offer 自己會把自己凍住。

### 3.3 `won_at` vs `acquired_at`（migration 014）

- `won_at` = 這張卡**被抽出來**的時刻。公開的「最近開出」動態照它排。
- `acquired_at` = 這張卡**進到這個人卡冊**的時刻。卡冊照它排。

過戶（市場買卡、接受出價）只更新 `acquired_at`。**不要為了讓卡排到最前面而去改 `won_at`**
—— 那會讓一張買來的舊卡出現在「剛剛有人抽到」裡面，那是假的。

### 3.4 兩條交付通道

| `delivery` | 行為 |
|---|---|
| `vault`（庫內轉移） | 原子交換：點數直接扣、`prizes` 改 owner。成交即完成，卡立刻進卡冊 |
| `ship`（需寄送） | 建立託管訂單。點數只是**凍結不是扣款**，等確認收貨或驗收期滿才放款給賣家。**卡不會進卡冊** |

介面上這個差別必須在**按下購買之前**講清楚。

`vault` 掛單如果沒有對應的 `prize_id`，交易會被整筆擋掉（`LISTING_BROKEN`）。
這不是防禦性程式碼，是真的發生過：種子只寫 `listings` 不寫 `prizes`，
買家付了錢、賣家入了帳、卡片不存在。

### 3.5 分頁

所有會無限成長的列表都用**游標分頁不用 offset**（offset 在會插入資料的列表上
會漏資料也會重複資料）。`nextCursor` 為 `null` 是唯一的結束訊號，
**不要用「回傳數量少於一批」推斷** —— 剛好整除時會多打一次空請求。

游標是 opaque 的 base64，比較用 row-value（`(a, b) < (?, ?)`）不要展開成 OR
（用不到索引，邊界也容易寫錯）。索引的欄位順序與方向必須跟 `order by` 逐字對應。

公開卡冊的排序是**混合方向**（賞別升冪、時間降冪），row-value 表達不了，
所以把 `won_at` 取負讓三個鍵同向。

### 3.6 即時通知

`notify()` 寫入通知的同時發一則 `pg_notify`（channel `vd_notify`，payload 只有 userId）。
SSE 端點 `GET /v1/social/notifications/stream` 把訊號推給該使用者的連線。

**串流只送「你有新東西」，不送內容** —— 通知的資料形狀只留 `GET /v1/social/notifications`
一個來源，不會兩邊各自定義而走鐘。

- **不要用瀏覽器原生的 `EventSource`**：它不能帶 header，唯一的變通是把 JWT 放進網址，那會讓憑證進到伺服器日誌、瀏覽器歷史與 Referer。現在用 `fetch` + `ReadableStream`。
- **整個行程共用一條 `LISTEN` 連線**，不要每個 SSE 連線各開一條（會耗光連線池）。
- 25 秒心跳，否則中間的代理會切掉閒置連線。
- 輪詢保留當退路但**只在串流沒連上時跑**，而且整包在 `useNotificationStream` 裡 —— 鈴鐺元件不要自己再開一份。

---

## 3.9 當前進度與下一步（2026-08-26，接手先讀這段）

使用者正從手機用 Remote Control 接手，可能會直接下指令。先讀這段再動手。

### 進行中／待決，最優先

- **結算的所有權洞（F-1～F-6）— 最嚴重，尚未修，已定案怎麼修。**
  `pool_settlements.buyer_id` 綁死抽卡當下的買家，但卡的所有權會透過市場交易
  變動（`orders.ts:102` vault 買、`social.ts:268` 接受出價都只改 `prizes.user_id`，
  沒動 settlement）。後果：買了市場二手卡按回收，**錢付給前一手**；逾期退款也退給
  前一手。完整清單見 `docs/audit-backend-2.md`。
  **使用者已拍板兩條規則**：(1) 保障跟著卡走 —— 過戶時 `buyer_id` 改成新主人；
  (2) 出貨中的卡（awaiting_ship / shipped）不能上架轉手。
  另注意 `public.ts` 上架時 `pz.status === 'shipped'` 目前會被當成可上架，要一起收緊。
  **這是上線前必修。** 等 PSA 與前端體檢那批 commit 落地後就可以開修（避免撞
  `routes/pools.ts`）。

### 剛完成（已 push）

- 賣家出貨頁（`SellerShippingPage.vue`）— 結算的最後一哩。
- 示範池換世代（`GEN='-g2'`，見 `seed-gen.ts`）— 正式環境舊池沒有買回價、
  抽到的卡回收不了，用換世代 + retireStalePools 收攤舊的、開帶買回價的新的。
  **不刪**（prizes.pool_id 是 not null 外鍵，刪池會毀掉使用者卡冊裡的卡）。
- PSA 鑑定編號驗證（`server/src/psa.ts`）— 程式做好但 **API 待核准（403）**。
  預設「暫不驗證」，卡標 pending，池照開。明天兩步啟用、都不動碼：
  (1) PSA 把帳號改 approved → 自動開始回 ok；
  (2) Railway 設 `PSA_VERIFY_ENFORCE=1` → 切成「查不到就擋」。
  測試用 `PSA_STUB=1`。**EULA 尚未確認能不能顯示 PSA 資料給買家**，使用者要自己
  登入 PSA 讀 API End User Agreement。
- 假登出修正 — `auth.refresh()` 原本把網路失敗也當登入失效，後端冷啟動會把人
  踢回登入頁。改成只有 token 被 401 清掉才登出。

### 使用者明確的近期意向

- **裸卡上架先不做**（持證照 + 未鑑定標示）—— 使用者說緩。
- **測試階段還沒結束**：LINE 送 100 萬點與 `npm run seed` **暫時都留著**（要測），
  等測完再一起拆（見第 5 節）。
- **測完會想清空正式資料庫重來**：結算上線前的舊帳本分錄「扣了沒貸」，drift
  停在一個非零常數；只有清空能讓 drift 重新有意義。清空要跟「拆測試模式」一起做，
  否則下次部署 seed 又塞回來。

### 抽屜式面板（BottomActionBar）用在哪、不該用在哪

已用：池購買列、市場購買確認、挑卡已選清單、卡冊選取。判準——**「別處做完的事的
複查」（購物車、已選、篩選）適合抽屜；「這一頁的工作本身」（填表、讀資訊、看結果）
要攤開**。選籤頁與市場篩選是候選但不急。

---

## 4. 還沒補完的洞

依嚴重度排序。**這些是已知的、使用者也知情的，不是漏看。**

### 4.1 `refPrice` 沒有外部錨點 —— 已解（2026-08-25）

原本 `refPrice`（參考市值）是賣家自己填的、沒有任何外部依據，而回收價、還元率、
經濟護欄、「今日最殺」的折扣幅度全部從它算出來 —— 賣家填高，所有數字一起說謊。

**解法不是替 `refPrice` 找錨，是讓它退出金額計算。**

- 賣家在建池時**直接宣告買回價**：一個賞別一個絕對金額（A 賞 3000、D 賞 120 這樣），
  某一張在同賞別裡特別貴時可以單獨覆寫。**存進資料庫與 manifest 的是解析後
  「每個獎品的絕對金額」**（`pool_prizes.buyback`），賞別預設只是填表的來源。
  - 為什麼不是比率：比率要有基準，而唯一的基準就是 `refPrice` —— 那是循環論證。
  - 為什麼賞別夠用：同一個賞別裡的卡價值本來就相近，那正是分賞別的意義。
- 那個金額**寫進 manifest 綁進 commit（v3），開賣後改不了**。
  已實測：`UPDATE pool_prizes SET buyback = 10`（籤序與卡片完全沒動）
  讓 `/reveal` 從 `{"ok":true,"version":3}` 變成 `{"ok":false,"reason":"commit 對不上…"}`。
- 回收金額**直接讀那個數字**，不乘任何東西。錢仍然從那個池的保留額出（3.3）。
- 「還元率」改成「**保底回饋率**」＝ `Σ(宣告買回價 × 數量) ÷ 票收`，每一種賞別都算。
  分子換成**賣家有義務付出去的錢**，所以不需要外部錨點就是誠實的 ——
  灌高等於承諾多賠。門檻在 `src/shared/economics.ts`：
  ≥100% 擋（印鈔機）、≥90% 提醒、<25% 擋（保底形同沒有）。
  25% 是從舊制門檻換算的（舊制最苛的合法池 55% × 回收 5 成 ≈ 27.5%），
  不是重新拍腦袋 —— 目的是不要追溯性地把過去合法的賣家判出局。
- `refPrice` 降級成「賣家標示的參考價」：**選填**、只顯示、不構成承諾、
  不參與任何金額計算。沒填就是 `null`，UI 顯示「未標示」——
  **不要退回成 0**，0 讀起來是「這張卡不值錢」。顯示與折價幅度統一走
  `src/lib/refprice.ts`。
- 買回價**在抽卡前就看得到**（池的獎項表每一列都有）。抽完才知道能買回多少就是釣魚。

**既有的池怎麼辦：保持 v2、不能回收、不給預設值。** 買回價是一筆賣家有義務履行的債，
系統替他宣告一個他沒同意過的金額等於平台單方面替他簽約；而且要填只能拿 `refPrice`
去算 —— 那正是要拆掉的地基。理由完整寫在 `server/migrations/018_prize_buyback.sql`。

> 註：使用者曾指出我拿平台間的回收率（70% vs 90–100%）做比較是無效的 ——
> 開 90–100% 的平台把基準價開得比市場低。他是對的，那個比較不成立。
> 真正的變數是那個沒有錨的基準，而現在基準整個不見了。

### 4.2 沒有實體入庫流程

`prizes.status = 'stashed'` 是被**宣告**的，從來沒有被驗證過。
平台手上實際有沒有那張卡，系統不知道。使用者的決定是
「現況我還是希望從賣家自己直接轉交給買家」——**平台不代管實體卡**，
所以不要再提代管方案，那已經被否決過。

延伸問題：使用者問過「萬一上傳的卡片是沒有經過檢驗的卡片，我該怎麼知道他是否真的持有這張」。這個問題還沒有答案。

### 4.3 池的結算 —— 已補（2026-08-25）

原本 `draw()` 從來不會把錢貸記給賣家，票金只有借方沒有貸方。現在有了：

- 規則與參數在 `src/shared/pool-settlement.ts`（前後端共用），
  資料層在 `server/src/pool-settlement.ts`，資料表是 `pool_settlements`（migration 017）。
- **保留額是推導的**（`SUM(amount) where status in ('held','awaiting_ship','shipped')`），
  跟餘額一樣沒有可以直接改的欄位。`walletOf()` 把它算進 `locked` 並另外回一個 `reserved`。
- **逐筆釋放**，一張卡一列 —— 賣家的現金流不綁在池會不會抽完上。
- 回收改成**賣家出價、玩家接受，錢從那個池的保留額出**。舊的「平台照 refPrice 付 70%」
  已經整組移除（那是安全稽核 C-2 的印鈔機）。
- 全站 `SUM(points_ledger.delta)` 恆等於發行量。對帳走 `GET /v1/admin/reconcile`，
  `drift` 不是 0 就代表有一筆分錄只有單邊。
- **既有的 draws 不回填**：那些票金當初真的被銷毀了，補一筆貸方等於現在才印鈔票。
  有舊資料的環境上 `drift` 會停在一個不再增加的常數；要看的是它會不會繼續增加。
- 時限測試靠 `DEV_LOGIN=1` 才開的 `/v1/dev/rewind-settlement` 與 `/v1/dev/expire-pool`
  把時鐘往回撥。**正式環境不設 `DEV_LOGIN` 就沒有這兩條路。**

剩下的順序（使用者還沒選）：
1. 開池保證金

### 4.4 出貨佇列 —— 賣家端已補、後台那條仍在

抽卡池的出貨現在有賣家端：`GET /v1/seller/settlements` 看得到自己的保留額與待出貨，
`POST /v1/seller/settlements/:id/ship` 標記出貨。後台 `POST /v1/admin/shipments/:id/status`
仍然存在，而且會同步更新結算狀態（兩條路指的是同一件事實）。
**前端還沒有賣家出貨的介面**，目前只有 API。

### 4.5 其他

- 市場交易手續費目前是 **0**。
- 過戶時**沒有**重設 `stash_expires_at`，買家繼承賣家剩下的寄存天數。這是政策決定不是 bug，使用者還沒表態。
- 保底 / 天井（第 ⑤ 項）我建議不做，使用者還沒確認。
- `/u/:slug` 在 GitHub Pages 上對爬蟲回 404（沒有 SPA rewrite），所以 LINE 分享沒有預覽卡。要修需要換一個支援 SPA rewrite 的主機。
- `public/og.png`（1200×630）還沒放。

---

## 5. 上線前一定要拆掉的東西

**這三件忘記做會出事：**

1. **LINE 登入送 1,000,000 點** —— 測試用的，上線前務必移除。
2. **Railway 啟動指令裡的 `npm run seed`** —— 每次部署都會重塞一批假掛單與假池。
3. `DEV_LOGIN` 確認在正式環境是關的。

（Railway 的啟動指令**有**跑 `npm run migrate`，日誌裡看得到「migrations done」之後才 listening。所以新增 migration 只要推上去就會套用。）

---

## 6. 開發與驗證慣例

使用者對「說做好了但其實沒驗」非常敏感。**先有證據再下結論。**

### 提交前的守門（2026-08-28 加）

`.githooks/pre-commit` 會在**動到前端原始碼**時，驗證「這個 commit 本身」
建不建得起來。第一次 clone 之後要跑一次讓它生效：

```bash
git config core.hooksPath .githooks
```

**為什麼會有這支**：出過一次事 —— 後端改完要提交時用了 `git add -A`，
而當下有一支背景 agent 正在同一個工作樹寫前端檔案，結果它**還沒完工的
1,038 行**被掃進那個 commit 推上正式環境，commit 訊息也完全沒提到它們。
那次沒炸是運氣（agent 的程式碼碰巧完整可編譯），早三十秒提交推出去的
就是一個寫到一半的檔案。

它用 `git stash --keep-index -u` 把未暫存的部分先藏起來再建 —— 直接建
工作樹驗的是「工作樹能不能建」，而我們要問的是「**這個 commit** 能不能
建」，兩者在有未暫存變更時會分岔。

**但 hook 只是最後一道，不是解法。** 真正的規則是：

> **有 agent 在跑的時候，永遠不要 `git add -A`。逐檔指定。**

`git status` 要問的不是「有沒有敏感檔案」，是「**這些是不是我的改動**」。
分不清楚就先 `git diff` 看過再決定。
另一個更徹底的做法是讓寫程式的 agent 跑在獨立的 git worktree
（Agent 工具的 `isolation: "worktree"`），從結構上就撞不到 —— 代價是那個
worktree 沒有 node_modules，agent 要自己 npm install。

---

### 建置

```bash
npm run build                    # 前端。不要接 pipe，要讀 exit code
cd server && npm run check       # sync-shared --check + tsc --noEmit
cd server && npm run build
```

**不要用 `tsc --noEmit` 代替 `npm run build`**，而且**不要接 pipe** —— 接了 pipe 讀到的是 pipe 的 exit code。

### 煙霧測試（目前 295 項）

> PSA 相關（+17 項，含「PSA 鑑定編號查證」整段與挑鑑定卡開池那條的 verified 檢查）
> 要伺服器設 `PSA_STUB=1` 才會實跑，否則整段自動跳過（不打正式 PSA）。
> 見 docs/psa-api-access.md 第 9 節。

需要本機 PostgreSQL 與一個跑著的 server：

```bash
export DATABASE_URL="postgres://$(whoami)@localhost:5432/vaultdraw_test"
export JWT_SECRET="local-test-only-not-a-real-secret-000000000000"
export DEV_LOGIN=1 PORT=8080
cd server && npm run migrate && npm run seed
npm run dev &        # 另一個終端
npm run smoke
```

`dev-login` 要同時給 `handle` 與 `name`。`GET /v1/auth/me` 回的是 `{ user: {...} }` 不是裸物件。

煙霧測試會消耗種子掛單，所以**每次跑之前要重建資料庫**。跑完請把測試庫還原成乾淨的 migrate + seed。

### 瀏覽器驗證

`.claude/launch.json` 裡有 `tcg-draw-mock`（port 5175，mock 模式，不需要後端）。
一律在 **393×852** 驗證手機版。

### 正式環境

```
API: https://web-production-154871.up.railway.app
Railway: -p 3ef179b4-ad8b-4bb3-a43b-ea6adfbb90da -e production -s web
```

- **Railway CLI 一定要從 repo 根目錄執行**，不是從 `server/`。
- CLI 版本太舊（5.20）會讓 `service source connect` 假報 Unauthorized。`brew upgrade railway` 解決。
- **不要跑 `railway config apply`** —— 它會刪掉環境變數。要改先用 `plan` 看。
- 推上去約 25 秒後自動部署。

---

## 7. 跟使用者合作的方式

- 使用者用**繁體中文**溝通，回覆也用繁體中文。程式碼註解一樣。
- 註解要解釋**為什麼**，不是做了什麼。這個 repo 現有的註解都是這個風格，跟著寫。
- 使用者常說「可以多開幾個 agent」。他確實希望平行處理。但**交辦時要明確劃分檔案範圍**，否則兩支 agent 會改到同一個檔案互相蓋掉（發生過好幾次，靠事後逐檔比對才發現沒被蓋掉）。
- 使用者會直接貼截圖回報跑版。他對手機版版面很敏感，而我在這件事上錯過很多次 —— **不要靠讀 CSS 推論說「應該沒問題」，實際量。**
- 我講錯過幾次並當場更正過：出貨追蹤號的風險（其實 `applyDeadlines` 有處理）、`/pools/:id/open` 缺少驗證（其實是刻意的）、底部黑色空白的成因（不是 `100vh`）、以及 migration 不會自動跑（其實會）。**遇到「我記得是這樣」的時候去查，不要憑印象斷言。**
